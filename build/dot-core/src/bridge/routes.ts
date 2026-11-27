/**
 * src/bridge/routes.ts —— 18789 网关上的接收侧 `/dot/bridge/v1/*`（B.6）。
 *
 * 桥（8799）转发到这里；这一侧才是大脑：**写账本只走 ledger 的公开函数**。
 * 网关本身已有 gateway token，这里按 A.3「dot-core 的桥路由再要一层桥 token」
 * 校验 x-dot-bridge-token（同一份 ~/.allbot/dot/bridge-token）。
 *
 * 挂载方式（allbot 插件 API，源码 allbot-src/src/plugins/types.ts:1964-1978）：
 *   api.registerHttpRoute({ path: "/dot/bridge/v1", match: "prefix", auth: "gateway", handler })
 * handler 返回 true 表示「这条路径归我」，false 让网关继续找别的路由。
 *
 * 路由：
 *   POST /dot/bridge/v1/tasks
 *   GET|POST /dot/bridge/v1/status[?task_id=]
 *   POST /dot/bridge/v1/approvals/<id>/decide
 *   POST /dot/bridge/v1/tasks/<id>/cancel
 *   POST /dot/bridge/v1/tasks/<id>/replan（人改主意：写一次 user_changed_mind 重排）
 *   POST /dot/bridge/v1/notify（转交给桥，再转 8797 send_to_bot）
 *   POST /dot/bridge/v1/reply（只回答：brain_reply 的大脑一侧，不建任务）
 *   GET  /dot/bridge/v1/health
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HttpError,
  parseRequestUrl,
  readJsonBody,
  sendJson,
} from "./http.ts";
import { diskAdmission, readKeepState } from "./keep.ts";
import { BridgeNotifyClient } from "./notify.ts";
import { resolveDotPaths } from "./paths.ts";
import { clampAutoApproveTier } from "../runtime/live-config.ts";
import { TokenCache, tokenFromRequest, tokensEqual, type TokenState } from "./token.ts";
import {
  appendEvent,
  cancelTask,
  requeueTask,
  createTask,
  decideApproval,
  getApproval,
  getTask,
  latestRecoveryReport,
  listOpenApprovals,
  listTasks,
  readTaskView,
  renderProgressCard,
  LedgerError,
  OPEN_TASK_STATES,
  type ApprovalRow,
  type DecidedBy,
  type LedgerDb,
  type TaskRow,
} from "../ledger/index.ts";
import { resumeAfterDecision } from "../dispatch/resume.ts";
import { replan } from "../plan/index.ts";
import {
  replyErrorMessage,
  REPLY_DEFAULT_MAX_CHARS,
  REPLY_MAX_CONTEXT_CHARS,
  REPLY_MAX_INTENT_CHARS,
  REPLY_MAX_MAX_CHARS,
  REPLY_MIN_MAX_CHARS,
  type ReplyFn,
} from "../reply/index.ts";
import type { SayRewrite } from "../say/index.ts";
import { deployPendingPatch } from "../selfimprove/deploy.ts";
import { listPendingPatches } from "../selfimprove/apply.ts";
import type { SelfImproveConfigSlice } from "../selfimprove/types.ts";

export const BRIDGE_ROUTE_BASE = "/dot/bridge/v1";

export interface BridgeRouteDeps {
  /** dot-core 的账本连接；传函数时每次请求现取。 */
  db: LedgerDb | (() => LedgerDb);
  /** 覆盖 token 文件路径（默认 ~/.allbot/dot/bridge-token）。 */
  tokenPath?: string;
  /** 测试/内嵌可直接给 token。 */
  token?: string | null;
  /** false 时跳过桥 token 校验（只给单测用，默认 true）。 */
  requireToken?: boolean;
  /** keep.json 路径；新任务前看盘是否够。 */
  keepPath?: string;
  minFreeMb?: number;
  /** false 时不做盘紧拦截（默认 true）。 */
  admissionCheck?: boolean;
  /** 桥的地址（通知转发的下一跳）：默认 http://127.0.0.1:8799。 */
  bridgeUrl?: string;
  /** 测试可注入：把请示卡交给桥的结果。 */
  notify?: (payload: { approval_id: string }) => Promise<{ status: number; body: unknown }>;
  /**
   * 说人话改写（第 3 步 C）。**不传 = 不改一个字**；只有 config.say.enabled=true 时
   * index.ts 才注入。注入后作用于 /status 的 card 字段。
   */
  say?: SayRewrite;
  /**
   * 仓库根与自我优化配置：部署补丁要用（src/selfimprove/deploy.ts）。
   * repoRoot 默认按本文件位置推（build/dot-core/src/bridge → 仓库根），
   * 测试可以直接给临时根。config 不给 = 部署一律按「开关关着」拒。
   */
  repoRoot?: string;
  selfImproveConfig?: SelfImproveConfigSlice;
  /** 重启请求文件路径；默认 <dot>/state/reload-request.json。 */
  reloadRequestPath?: string;
  /** dot 自己的 config.json 路径；/settings 读写它。默认 <dot>/config.json。 */
  configPath?: string;
  /**
   * 审批有结论之后的通知（自我优化用）：点「同意」一条提案，要接着去生成补丁；
   * 点「同意」一张补丁卡，要接着去打上机。回调是异步的，不阻塞审批响应，抛错也只记日志。
   */
  onApprovalDecided?: (input: {
    approvalId: string;
    decision: "approved" | "rejected";
    approval: ApprovalRow;
  }) => void;
  /**
   * 只回答通道（brain_reply）的大脑一侧。不传 = `POST /reply` 回 503 reply_not_wired。
   * index.ts 注入 createReplyService(...)；桥本身永远不建任务、不记账。
   */
  reply?: ReplyFn;
  now?: () => Date;
}

export type BridgeRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

interface RouteApi {
  registerHttpRoute(params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }): void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function taskSummary(
  db: LedgerDb,
  row: TaskRow,
  say?: SayRewrite,
): Promise<{ id: string; intent: string; state: string; stateLabel: string; updatedAt: string; card: string }> {
  let stateLabel: string = row.state;
  let card: string;
  try {
    const view = readTaskView(db, row.id);
    stateLabel = view.stateLabel;
    const rendered = renderProgressCard(view);
    // say 不传就逐字用模板卡；传了但改写失败也逐字用模板卡（改写层自己会退回原文）。
    card = say === undefined ? rendered : await say(rendered).catch(() => rendered);
  } catch (err) {
    card = `【任务 ${row.id}】${row.intent}\n状态：${row.state}（进度卡读不出来：${errorText(err)}）`;
  }
  return { id: row.id, intent: row.intent, state: row.state, stateLabel, updatedAt: row.updated_at, card };
}

function approvalSummary(row: ApprovalRow): Record<string, unknown> {
  return {
    id: row.id,
    task_id: row.task_id,
    step_id: row.step_id,
    kind: row.kind,
    tier: row.tier,
    title: row.title,
    status: row.status,
    pending_until: row.pending_until,
    created_at: row.created_at,
  };
}

/** A.6 的答复词 → 状态机里的 approved/rejected。认不出来返回 null（叫人重问）。 */
export function mapAnswerToDecision(raw: string): "approved" | "rejected" | null {
  const text = raw.trim().toLowerCase();
  if (text === "") return null;
  const approve = [
    "同意",
    "批准",
    "同意执行",
    "可以",
    "好",
    "好的",
    "行",
    "是",
    "1",
    "yes",
    "y",
    "ok",
    "okay",
    "approve",
    "approved",
  ];
  const reject = ["拒绝", "不同意", "不批准", "驳回", "不行", "否", "不要", "2", "no", "n", "reject", "rejected"];
  if (approve.includes(text)) return "approved";
  if (reject.includes(text)) return "rejected";
  return null;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

function resolveTokenState(deps: BridgeRouteDeps): TokenState {
  if (deps.token !== undefined) {
    return { token: deps.token, path: deps.tokenPath ?? "(inline)", error: null };
  }
  return new TokenCache(deps.tokenPath ?? resolveDotPaths().tokenPath).get();
}

function checkAuth(req: IncomingMessage, url: URL, deps: BridgeRouteDeps): { ok: true } | { ok: false; reason: "missing" | "bad"; path: string } {
  if (deps.requireToken === false) return { ok: true };
  const tokenState = resolveTokenState(deps);
  if (tokenState.token === null) return { ok: false, reason: "missing", path: tokenState.path };
  const presented = tokenFromRequest(req, url);
  if (!tokensEqual(presented, tokenState.token)) {
    return { ok: false, reason: "bad", path: tokenState.path };
  }
  return { ok: true };
}

function admissionNow(deps: BridgeRouteDeps): { allowed: boolean; reason: string | null } {
  if (deps.admissionCheck === false) return { allowed: true, reason: null };
  const keep = readKeepState(deps.keepPath ?? resolveDotPaths().keepPath);
  return diskAdmission(keep, deps.minFreeMb);
}

export function createBridgeRouteHandler(deps: BridgeRouteDeps): BridgeRouteHandler {
  const now = deps.now ?? (() => new Date());
  // build/dot-core/src/bridge/routes.ts → 仓库根
  const repoRoot = deps.repoRoot ?? fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\/]+$/, "");
  const reloadRequestPath = deps.reloadRequestPath ?? join(resolveDotPaths().dotDir, "state", "reload-request.json");
  const settingsConfigPath = deps.configPath ?? join(resolveDotPaths().dotDir, "config.json");
  const say = deps.say;
  const dbOf = (): LedgerDb => (typeof deps.db === "function" ? deps.db() : deps.db);

  async function handleStatus(req: IncomingMessage, res: ServerResponse, url: URL, db: LedgerDb): Promise<void> {
    let body: Record<string, unknown> = {};
    if (req.method === "POST") body = bodyRecord(await readJsonBody(req));
    const taskId = optionalString(url.searchParams.get("task_id")) ?? optionalString(body.task_id);
    if (body.probe === true) {
      sendJson(res, 200, { ok: true, now: now().toISOString(), probe: true });
      return;
    }
    const rows = listTasks(db, { state: [...OPEN_TASK_STATES], limit: 20 });
    const tasks = await Promise.all(rows.map((row) => taskSummary(db, row, say)));
    const approvals = listOpenApprovals(db).map(approvalSummary);
    const recovery = latestRecoveryReport(db);
    const payload: Record<string, unknown> = {
      ok: true,
      now: now().toISOString(),
      tasks,
      cards: tasks.map((t) => t.card),
      approvals,
      recovery,
    };
    if (taskId !== undefined) {
      const task = getTask(db, taskId);
      if (task === null) {
        sendJson(res, 404, { ok: false, error: "task_not_found", message: `没有任务 ${taskId}` });
        return;
      }
      const summary = await taskSummary(db, task, say);
      payload.task = summary;
      payload.task_id = summary.id;
      payload.card = summary.card;
    }
    sendJson(res, 200, payload);
  }

  async function handleCreateTask(req: IncomingMessage, res: ServerResponse, db: LedgerDb): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));
    const admission = admissionNow(deps);
    if (!admission.allowed) {
      sendJson(res, 409, { ok: false, error: "admission_paused", message: admission.reason });
      return;
    }
    const intent = optionalString(body.intent);
    if (intent === undefined) {
      sendJson(res, 400, { ok: false, error: "bad_intent", message: "intent 必填，且要是非空字符串" });
      return;
    }
    // 中文没按 UTF-8 发过来时，服务端只会看到 U+FFFD（�）。这种任务存进账本谁也读不懂，
    // 也治不好（真机账本里留下过两条），所以当场拒掉、让它重发。
    if (intent.includes("�")) {
      sendJson(res, 400, {
        ok: false,
        error: "bad_encoding",
        message: "intent 里有乱码（U+FFFD）：中文不是按 UTF-8 发的。请用 UTF-8 重发一次，别让乱码进账本",
      });
      return;
    }
    const profileRaw = optionalString(body.profile);
    if (profileRaw !== undefined && !["cheap", "balanced", "strong"].includes(profileRaw)) {
      sendJson(res, 400, { ok: false, error: "bad_profile", message: "profile 只能是 cheap / balanced / strong" });
      return;
    }
    const budgetRaw = body.budget_tokens;
    let budgetTokens: number | null = null;
    if (budgetRaw !== undefined && budgetRaw !== null) {
      if (typeof budgetRaw !== "number" || !Number.isFinite(budgetRaw) || budgetRaw < 0) {
        sendJson(res, 400, { ok: false, error: "bad_budget", message: "budget_tokens 要是非负整数" });
        return;
      }
      budgetTokens = Math.floor(budgetRaw);
    }
    const declared = body.declared ?? {};
    const row = createTask(db, {
      intent,
      restated: optionalString(body.restated) ?? null,
      declared,
      source: optionalString(body.source) ?? "dsbot",
      source_ref: body.source_ref ?? { via: "dot-bridge" },
      profile: profileRaw ?? "balanced",
      budget_tokens: budgetTokens,
      parent_id: optionalString(body.parent_id) ?? null,
    });
    const summary = await taskSummary(db, row, say);
    sendJson(res, 201, {
      ok: true,
      task: summary,
      task_id: summary.id,
      card: summary.card,
      message: `接下任务 ${summary.id}（${summary.stateLabel}）`,
    });
  }

  async function handleDecide(
    req: IncomingMessage,
    res: ServerResponse,
    db: LedgerDb,
    approvalId: string,
  ): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));
    const existing = getApproval(db, approvalId);
    if (existing === null) {
      sendJson(res, 404, { ok: false, error: "approval_not_found", message: `没有批单 ${approvalId}` });
      return;
    }
    let decision: "approved" | "rejected" | null = null;
    const explicit = optionalString(body.decision);
    if (explicit !== undefined) {
      if (explicit === "approved" || explicit === "approve" || explicit === "同意") decision = "approved";
      else if (explicit === "rejected" || explicit === "reject" || explicit === "拒绝") decision = "rejected";
      else {
        sendJson(res, 400, {
          ok: false,
          error: "bad_decision",
          message: "decision 只能是 approved / rejected",
        });
        return;
      }
    } else {
      const answer = optionalString(body.answer);
      decision = answer === undefined ? null : mapAnswerToDecision(answer);
    }
    if (decision === null) {
      sendJson(res, 400, {
        ok: false,
        error: "answer_unrecognized",
        message: "答复没认出来：用「同意/拒绝」，或 1/2，或显式 decision=approved|rejected",
      });
      return;
    }
    const decidedByRaw = optionalString(body.decided_by);
    const decidedBy: DecidedBy =
      decidedByRaw !== undefined && ["dsbot", "feishu", "cli", "system"].includes(decidedByRaw)
        ? (decidedByRaw as DecidedBy)
        : "dsbot";
    const note = optionalString(body.note) ?? optionalString(body.answer) ?? null;
    const changed = decideApproval(db, approvalId, { decision, decidedBy, note });
    const after = getApproval(db, approvalId);
    // 审批有结论后必须把任务放回队列：派发出来的工人会话是一次性的，
    // 会话结束后没人会重调那个被拦的动作（审核实测过这条死路）。
    const resume = changed ? resumeAfterDecision(db, approvalId) : null;
    // 自我优化的第二段/第三段入口：审批一落定就交给 index.ts 那边决定要不要生成补丁、要不要上机。
    // 放在这里是因为「点同意」只有这一个真实入口（聊天窗、页面、exe 最后都走这条路由）。
    if (changed && deps.onApprovalDecided !== undefined) {
      try {
        deps.onApprovalDecided({ approvalId, decision, approval: after ?? existing });
      } catch (err) {
        // 回调出错不能影响审批本身的回执：审批已经记下了。
        console.warn(`[dot-core] onApprovalDecided 抛错：${errorText(err)}`);
      }
    }
    sendJson(res, 200, {
      ok: true,
      changed,
      approval: after === null ? approvalSummary(existing) : approvalSummary(after),
      ...(resume === null
        ? {}
        : { resume: { action: resume.action, task_id: resume.taskId, detail: resume.detail } }),
      message: changed
        ? decision === "approved"
          ? `已记下：同意（批单 ${approvalId}）${resume === null ? "" : `；${resume.detail}`}`
          : `已记下：拒绝（批单 ${approvalId}）${resume === null ? "" : `；${resume.detail}`}`
        : `批单 ${approvalId} 已经不是待决状态（${after?.status ?? existing.status}），按幂等处理，没有重复记账`,
    });
  }

  async function handleNotify(
    req: IncomingMessage,
    res: ServerResponse,
    db: LedgerDb,
    deps: BridgeRouteDeps,
  ): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));
    const approvalId = optionalString(body.approval_id);
    if (approvalId === undefined) {
      sendJson(res, 400, { ok: false, error: "bad_notify", message: "approval_id 必填" });
      return;
    }
    const approval = getApproval(db, approvalId);
    if (approval === null) {
      sendJson(res, 404, { ok: false, error: "approval_not_found", message: `没有批单 ${approvalId}` });
      return;
    }
    if (approval.status !== "pending") {
      sendJson(res, 409, {
        ok: false,
        error: "approval_not_pending",
        message: `批单 ${approvalId} 已经是 ${approval.status}，不再发请示卡`,
      });
      return;
    }
    if (deps.notify !== undefined) {
      const out = await deps.notify({ approval_id: approvalId });
      sendJson(res, out.status, out.body);
      return;
    }
    const tokenState = resolveTokenState(deps);
    if (tokenState.token === null) {
      sendJson(res, 503, {
        ok: false,
        error: "bridge_token_missing",
        message: `桥 token 没配置：${tokenState.path}；通知转发没有可用的鉴权`,
      });
      return;
    }
    const client = new BridgeNotifyClient({
      baseUrl: deps.bridgeUrl,
      token: tokenState.token,
    });
    const result = await client.notify(approvalId);
    sendJson(res, result.ok ? 200 : 502, {
      ok: result.ok,
      approval_id: approvalId,
      message: result.detail,
      ...(result.raw === undefined ? {} : { upstream: result.raw }),
    });
  }

  /**
   * 部署一条 pending 补丁（2026-11-25 用户要求「自我改进并部署替换」）。
   * 必须由人点：这里只提供接口，没有任何自动触发。
   * 真正动手在 src/selfimprove/deploy.ts：备份 → 打补丁 → 真实仓库上跑全量测试 →
   * 不过就回滚，过了就写一张重启请求交给看门狗。
   */
  /**
   * GET /settings  → 当前自动同意档位 + 说明
   * POST /settings → { auto_approve_max_tier: 0..4 } 写回 config.json
   *
   * 只暴露这一项：它是用户随时想开关的。写文件不改内存里那份启动快照，
   * 但 dot-core 每 20 秒会重读这一项（src/runtime/live-config.ts），所以不用重启网关。
   */
  async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const readCurrent = (): number => {
      try {
        const raw = readFileSync(settingsConfigPath, "utf8");
        const parsed = JSON.parse(raw) as { approvals?: { auto_approve_max_tier?: unknown } };
        return clampAutoApproveTier(parsed?.approvals?.auto_approve_max_tier);
      } catch {
        return 0;
      }
    };

    if (req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        auto_approve_max_tier: readCurrent(),
        config_path: settingsConfigPath,
        note: "0=关；1..4=这个档位及以下不用人点（5 档身份/钱、6 档危险永远要人点）。改完 20 秒内生效。",
      });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "GET, POST", "Content-Length": "0" });
      res.end();
      return;
    }

    const body = bodyRecord(await readJsonBody(req));
    const raw = body["auto_approve_max_tier"];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      sendJson(res, 400, { ok: false, error: "bad_value", message: "auto_approve_max_tier 要是 0..4 的数字" });
      return;
    }
    const next = clampAutoApproveTier(raw);
    if (next !== Math.floor(raw)) {
      sendJson(res, 400, {
        ok: false,
        error: "out_of_range",
        message: "只接受 0..4：5 档（身份/钱）和 6 档（危险）永远要人点，写多大都不会自动",
      });
      return;
    }

    let doc: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(settingsConfigPath, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
    } catch {
      doc = {};
    }
    const approvals = typeof doc["approvals"] === "object" && doc["approvals"] !== null
      ? (doc["approvals"] as Record<string, unknown>)
      : {};
    approvals["auto_approve_max_tier"] = next;
    doc["approvals"] = approvals;
    try {
      writeFileSync(settingsConfigPath, `${JSON.stringify(doc, null, 2)}
`, "utf8");
    } catch (err) {
      sendJson(res, 500, { ok: false, error: "write_failed", message: `写不进 ${settingsConfigPath}：${(err as Error).message}` });
      return;
    }
    appendEvent(dbOf(), {
      type: "settings_changed",
      task_id: null,
      payload: { key: "approvals.auto_approve_max_tier", value: next, via: "bridge" },
    });
    sendJson(res, 200, {
      ok: true,
      auto_approve_max_tier: next,
      config_path: settingsConfigPath,
      message: next === 0 ? "自动同意已关：所有审批都要人点" : `已开：${next} 档及以下不用人点（20 秒内生效）`,
    });
  }

  async function handleDeploy(
    req: IncomingMessage,
    res: ServerResponse,
    db: LedgerDb,
    deployDeps: { repoRoot: string; config?: SelfImproveConfigSlice; reloadRequestPath: string },
  ): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));
    const patchId = optionalString(body.patch_id) ?? "";
    if (patchId === "") {
      sendJson(res, 400, { ok: false, error: "bad_patch_id", message: "要给 patch_id（pending 里的文件名，不带 .patch）" });
      return;
    }
    const result = deployPendingPatch({
      db,
      root: deployDeps.repoRoot,
      patchId,
      ...(deployDeps.config === undefined ? {} : { config: deployDeps.config }),
      reloadRequestPath: deployDeps.reloadRequestPath,
    });
    sendJson(res, result.ok ? 200 : 409, { ...result });
  }

  /**
   * 用户反馈（2026-11-25 用户要求「自我优化要能根据用户反馈改进」）。
   * 只落一条 `user_feedback` 事件，不改任务状态：反馈是**证据**，不是判决。
   * 自我优化提案时会把最近这些反馈连同失败步骤一起喂给模型。
   */
  async function handleFeedback(
    req: IncomingMessage,
    res: ServerResponse,
    db: LedgerDb,
  ): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));
    const taskId = optionalString(body.task_id) ?? "";
    const raw = (optionalString(body.verdict) ?? "").toLowerCase();
    const note = (optionalString(body.note) ?? "").slice(0, 2000);
    const verdict = raw === "good" || raw === "对" || raw === "好" ? "good" : raw === "bad" || raw === "不对" || raw === "坏" ? "bad" : "";
    if (verdict === "") {
      sendJson(res, 400, {
        ok: false,
        error: "bad_verdict",
        message: "verdict 只能是 good 或 bad",
      });
      return;
    }
    if (taskId === "" || getTask(db, taskId) === null) {
      sendJson(res, 404, { ok: false, error: "task_not_found", message: `没有任务 ${taskId || "(空)"}` });
      return;
    }
    const event = appendEvent(db, {
      type: "user_feedback",
      task_id: taskId,
      payload: { task_id: taskId, verdict, note },
    });
    sendJson(res, 200, {
      ok: true,
      event_seq: event.seq,
      task_id: taskId,
      message: verdict === "good" ? "记下了：这条做对了" : "记下了：这条不对，会进自我优化的证据",
    });
  }

  /**
   * 「接着做」的入口。只接暂停中的任务：人在用电脑、或者会话超时停下的那种。
   * 重排一次（run_epoch+1），派发器会重新领走它；已经做过的步骤不重做。
   */
  async function handleResume(
    req: IncomingMessage,
    res: ServerResponse,
    db: LedgerDb,
    taskId: string,
  ): Promise<void> {
    let why = "user_resume";
    if (req.method === "POST") {
      const body = bodyRecord(await readJsonBody(req));
      why = optionalString(body.reason) ?? why;
    }
    const existing = getTask(db, taskId);
    if (existing === null) {
      sendJson(res, 404, { ok: false, error: "task_not_found", message: `没有任务 ${taskId}` });
      return;
    }
    if (existing.state !== "paused") {
      sendJson(res, 409, {
        ok: false,
        error: "not_paused",
        message: `任务 ${taskId} 是 ${existing.state}，只有暂停中的任务能说「继续」`,
      });
      return;
    }
    const row = requeueTask(db, taskId, { reason: `用户说继续：${why}`, expect: ["paused"] });
    if (row === null) {
      sendJson(res, 409, { ok: false, error: "resume_raced", message: `任务 ${taskId} 刚刚被别人改过，没重排成` });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      task: await taskSummary(db, row, say),
      task_id: row.id,
      message: `已重新排队：${row.id}（run_epoch=${row.run_epoch}）`,
    });
  }

  async function handleCancel(
    req: IncomingMessage,
    res: ServerResponse,
    db: LedgerDb,
    taskId: string,
  ): Promise<void> {
    let reason = "cancelled_by_user";
    if (req.method === "POST") {
      const body = bodyRecord(await readJsonBody(req));
      reason = optionalString(body.reason) ?? reason;
    }
    const existing = getTask(db, taskId);
    if (existing === null) {
      sendJson(res, 404, { ok: false, error: "task_not_found", message: `没有任务 ${taskId}` });
      return;
    }
    const row = cancelTask(db, taskId, reason);
    if (row === null) {
      sendJson(res, 409, {
        ok: false,
        error: "not_cancellable",
        message: `任务 ${taskId} 已经是 ${existing.state}，不再改状态`,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      task: await taskSummary(db, row, say),
      task_id: row.id,
      message: `已取消任务 ${row.id}`,
    });
  }

  /**
   * 「你改了主意」的入口（方案 5.3 四类重排里唯一由人发起的那一类）。
   * 给新里程碑清单就替换掉还没做完的；只给 why 就只记一次重排点。
   */
  async function handleReplan(
    req: IncomingMessage,
    res: ServerResponse,
    db: LedgerDb,
    taskId: string,
  ): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));
    const why = optionalString(body.why);
    if (why === undefined) {
      sendJson(res, 400, { ok: false, error: "bad_why", message: "why 必填：一句话说清为什么改主意" });
      return;
    }
    const existing = getTask(db, taskId);
    if (existing === null) {
      sendJson(res, 404, { ok: false, error: "task_not_found", message: `没有任务 ${taskId}` });
      return;
    }

    let milestones: Array<{ title: string; done_when: string }> | undefined;
    if (body.milestones !== undefined) {
      if (!Array.isArray(body.milestones) || body.milestones.length === 0) {
        sendJson(res, 400, {
          ok: false,
          error: "bad_milestones",
          message: "milestones 要给非空数组（每项 {title, done_when}）；不想换里程碑就别传这个字段",
        });
        return;
      }
      milestones = [];
      for (const raw of body.milestones) {
        const item = bodyRecord(raw);
        const title = optionalString(item.title);
        const doneWhen = optionalString(item.done_when);
        if (title === undefined || doneWhen === undefined) {
          sendJson(res, 400, {
            ok: false,
            error: "bad_milestones",
            message: "每条里程碑都要有非空的 title 与 done_when",
          });
          return;
        }
        milestones.push({ title, done_when: doneWhen });
      }
    }

    const result = replan(db, {
      taskId,
      reason: "user_changed_mind",
      why,
      ...(milestones === undefined ? {} : { milestones }),
    });
    sendJson(res, 200, {
      ok: true,
      task_id: taskId,
      plan_version: result.plan.version,
      milestones: result.milestones.map((m) => ({ id: m.id, seq: m.seq, title: m.title })),
      skipped: result.skipped.map((m) => ({ id: m.id, seq: m.seq, title: m.title })),
      message:
        milestones === undefined
          ? `已记下重排点「你改了主意」（计划 v${result.plan.version}），里程碑没换`
          : `已按「你改了主意」换掉还没做完的里程碑（计划 v${result.plan.version}，作废 ${result.skipped.length} 条，新建 ${result.milestones.length} 条）`,
    });
  }

  /**
   * 只回答通道：POST /dot/bridge/v1/reply。
   * 只转发到 deps.reply（由 index.ts 注入 createReplyService），自己不建任务、不写账本。
   * 参数校验在这里做，文案统一取 replyErrorMessage()（C 表）。
   */
  async function handleReply(req: IncomingMessage, res: ServerResponse, deps: BridgeRouteDeps): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));

    const intentRaw = body.intent;
    const intent = typeof intentRaw === "string" ? intentRaw.trim() : "";
    if (typeof intentRaw !== "string" || intent === "" || intent.length > REPLY_MAX_INTENT_CHARS) {
      sendJson(res, 400, { ok: false, error: "bad_intent", message: replyErrorMessage("bad_intent"), status: 400 });
      return;
    }

    let context: string | undefined;
    if (body.context !== undefined && body.context !== null) {
      if (typeof body.context !== "string" || body.context.length > REPLY_MAX_CONTEXT_CHARS) {
        sendJson(res, 400, { ok: false, error: "bad_context", message: replyErrorMessage("bad_context"), status: 400 });
        return;
      }
      context = body.context.trim() === "" ? undefined : body.context;
    }

    let maxChars = REPLY_DEFAULT_MAX_CHARS;
    if (body.max_chars !== undefined && body.max_chars !== null) {
      const raw = body.max_chars;
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < REPLY_MIN_MAX_CHARS ||
        raw > REPLY_MAX_MAX_CHARS
      ) {
        sendJson(res, 400, { ok: false, error: "bad_max_chars", message: replyErrorMessage("bad_max_chars"), status: 400 });
        return;
      }
      maxChars = raw;
    }

    let via = "dot-bridge";
    if (body.via !== undefined && body.via !== null) {
      if (typeof body.via !== "string" || !/^[a-z0-9_-]{1,32}$/.test(body.via)) {
        sendJson(res, 400, { ok: false, error: "bad_via", message: replyErrorMessage("bad_via"), status: 400 });
        return;
      }
      via = body.via;
    }

    if (deps.reply === undefined) {
      sendJson(res, 503, {
        ok: false,
        error: "reply_not_wired",
        message: replyErrorMessage("reply_not_wired"),
        status: 503,
      });
      return;
    }

    const outcome = await deps.reply({ intent, ...(context === undefined ? {} : { context }), maxChars, via });
    if (outcome.ok) {
      sendJson(res, 200, {
        ok: true,
        reply: outcome.reply,
        model: outcome.model,
        usage: outcome.usage,
        spend_id: outcome.spend_id,
        event_seq: outcome.event_seq,
        elapsed_ms: outcome.elapsed_ms,
        truncated: outcome.truncated,
      });
      return;
    }
    sendJson(res, outcome.status, {
      ok: false,
      error: outcome.error,
      message: outcome.message,
      status: outcome.status,
    });
  }

  return async (req, res) => {
    const url = parseRequestUrl(req);
    const path = url.pathname;
    if (path !== BRIDGE_ROUTE_BASE && !path.startsWith(`${BRIDGE_ROUTE_BASE}/`)) return false;

    const auth = checkAuth(req, url, deps);
    if (!auth.ok) {
      if (auth.reason === "missing") {
        sendJson(res, 503, {
          ok: false,
          error: "bridge_token_missing",
          message: `桥 token 没配置：${auth.path}；dot-core 的桥路由拒绝被调用`,
        });
      } else {
        sendJson(
          res,
          401,
          { ok: false, error: "unauthorized", message: "桥 token 不对（x-dot-bridge-token / Authorization: Bearer / ?token=）" },
          { "WWW-Authenticate": 'Bearer realm="dot-core-bridge"' },
        );
      }
      return true;
    }

    const rest = path.slice(BRIDGE_ROUTE_BASE.length) || "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        Allow: "GET, POST, OPTIONS",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, x-dot-bridge-token",
        "Access-Control-Allow-Origin": "http://127.0.0.1",
      });
      res.end();
      return true;
    }

    try {
      const db = dbOf();
      if (rest === "/health" || rest === "/") {
        const open = listTasks(db, { state: [...OPEN_TASK_STATES], limit: 100 }).length;
        sendJson(res, 200, {
          ok: true,
          name: "dot-core-bridge-routes",
          now: now().toISOString(),
          open_tasks: open,
          open_approvals: listOpenApprovals(db).length,
        });
        return true;
      }
      if (rest === "/status") {
        await handleStatus(req, res, url, db);
        return true;
      }
      if (rest === "/tasks") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        await handleCreateTask(req, res, db);
        return true;
      }
      if (rest === "/reply") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        await handleReply(req, res, deps);
        return true;
      }
      if (rest === "/settings") {
        await handleSettings(req, res);
        return true;
      }
      if (rest === "/patches") {
        sendJson(res, 200, {
          ok: true,
          patches: listPendingPatches(repoRoot),
          repo_root: repoRoot,
          reload_request_path: reloadRequestPath,
        });
        return true;
      }
      if (rest === "/deploy") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        await handleDeploy(req, res, db, {
          repoRoot,
          reloadRequestPath,
          ...(deps.selfImproveConfig === undefined ? {} : { config: deps.selfImproveConfig }),
        });
        return true;
      }
      if (rest === "/feedback") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        await handleFeedback(req, res, db);
        return true;
      }
      if (rest === "/notify") {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        await handleNotify(req, res, db, deps);
        return true;
      }
      const decide = /^\/approvals\/([^/]+)\/decide$/.exec(rest);
      if (decide !== null) {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        let id: string;
        try {
          id = decodeURIComponent(decide[1] ?? "");
        } catch {
          sendJson(res, 400, { ok: false, error: "bad_id", message: "批单号解码失败" });
          return true;
        }
        await handleDecide(req, res, db, id);
        return true;
      }
      const cancel = /^\/tasks\/([^/]+)\/cancel$/.exec(rest);
      if (cancel !== null) {        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        let id: string;
        try {
          id = decodeURIComponent(cancel[1] ?? "");
        } catch {
          sendJson(res, 400, { ok: false, error: "bad_id", message: "任务号解码失败" });
          return true;
        }
        await handleCancel(req, res, db, id);
        return true;
      }
      const resumeMatch = /^\/tasks\/([^/]+)\/resume$/.exec(rest);
      if (resumeMatch !== null) {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        let id: string;
        try {
          id = decodeURIComponent(resumeMatch[1] ?? "");
        } catch {
          sendJson(res, 400, { ok: false, error: "bad_id", message: "任务号解码失败" });
          return true;
        }
        await handleResume(req, res, db, id);
        return true;
      }
      const replanMatch = /^\/tasks\/([^/]+)\/replan$/.exec(rest);
      if (replanMatch !== null) {
        if (method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
          res.end();
          return true;
        }
        let id: string;
        try {
          id = decodeURIComponent(replanMatch[1] ?? "");
        } catch {
          sendJson(res, 400, { ok: false, error: "bad_id", message: "任务号解码失败" });
          return true;
        }
        await handleReplan(req, res, db, id);
        return true;
      }
      sendJson(res, 404, { ok: false, error: "unknown_route", message: `没有这个桥路由：${method} ${rest}` });
      return true;
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
        return true;
      }
      if (err instanceof LedgerError) {
        const status = err.code === "task_not_found" ? 404 : err.code === "stale_writer" ? 409 : 400;
        sendJson(res, status, { ok: false, error: err.code, message: err.message });
        return true;
      }
      sendJson(res, 500, { ok: false, error: "internal_error", message: errorText(err) });
      return true;
    }
  };
}

/**
 * 挂到 allbot 插件 API 上。前缀匹配，鉴权交给网关（gateway token），
 * 处理函数里再校桥 token（A.3 的第二层）。
 */
export function registerBridgeRoutes(
  api: RouteApi,
  deps: BridgeRouteDeps,
  opts: { basePath?: string } = {},
): void {
  const handler = createBridgeRouteHandler(deps);
  api.registerHttpRoute({
    path: opts.basePath ?? BRIDGE_ROUTE_BASE,
    match: "prefix",
    auth: "gateway",
    handler,
  });
}
