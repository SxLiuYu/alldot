/**
 * src/hands/hand.ts —— 手的外壳：A.4 的七步，串行语句，不靠钩子时序。
 *
 *   1) 按 toolCallId 从身份表取会话（取不到 → fail-closed）
 *   2) 解析 task：**只认会话身份**（sessionKey 的 `task:<id>` 或身份表里的 taskId）；
 *      参数里的 task_id 只在「没有会话身份」的直接调用里用，且与会话冲突时拒绝
 *   2.5) 动作归一化（由 spec 提供；只认这只手自己的动作表）
 *   3) 闸门判定（src/gate 的 judgeTier；6 档直接拒，5 档交人，4 档出请示卡）
 *   3.5) 主题键（computeSubjectKey；参数由 spec 给）
 *   4) 审批：pending 等、approved 执行（markApprovalExecuting → 执行 → markApprovalExecuted），
 *      建单时任务转 awaiting_approval 并写 blocked_on、同时把请示卡交给桥
 *   4.5) 单例锁（desktop / 浏览器；闸门放行后、写前记账前拿，finally 释放）
 *   5) steps 行 INSERT + COMMIT（写前记账；beginStep 返回时已提交）
 *   6) 第 2 档先快照再动手（src/hands/snapshot.ts），然后用 spec 的落地动作动手
 *   7) UPDATE 结果（endStep）；批准过的动作再把审批单推到 executed/failed
 *
 * 为什么 5 必须在 6 前面：崩在 6 和 7 之间时账本里留的是「started 未结束」，
 * 恢复协议（A.9）据此问人或重排；先动手后记账，崩在中间就留下没人知道的写。
 *
 * 两个「拒绝」不写 steps 行：身份缺失和任务归不到（含会话与参数冲突）。
 * 那时还不知道该记到哪个任务上，写进去等于伪造归因。
 *
 * 2026-11-25 起的结构：本文件是**通用壳**（身份/任务/六档/审批/记账/快照/结果），
 * 每只手的差异收进 `HandSpec`：动作归一化、闸门输入、主题键参数、快照目标、
 * 落地动作、审批卡文案、步骤与结果 artifact 形状、单例锁资源。
 * 最小手（practice）是这个接口的第一个实例，`runPracticeHand` 保持原签名。
 */

import {
  beginStep,
  computeSubjectKey,
  appendEvent,
  endStep,
  findOpenApprovalBySubjectKey,
  findSucceededStepBySubjectKey,
  getApproval,
  getArtifact,
  getTask,
  markApprovalExecuted,
  markApprovalExecuting,
  parseBlockedOn,
  putArtifact,
  setTaskState,
  type ApprovalRow,
  type LedgerDb,
  type TaskRow,
} from "../ledger/index.ts";
import { createApproval, decideApproval, judgeTier } from "../gate/index.ts";
import type { GateInput, Handling, TierVerdict } from "../gate/types.ts";
import type { DotCoreConfig } from "../config.ts";
import {
  PracticeError,
  listDir,
  makeDir,
  practiceRootOf,
  resolvePracticePath,
  writeTextFile,
  type ListResult,
  type MkdirResult,
  type WriteResult,
} from "./practice.ts";
import { IdentityMissingError, taskIdFromSessionKey, type IdentityTable, type ToolCallIdentity } from "./identity.ts";
import { snapshotPath } from "./snapshot.ts";
import { acquireHandLock } from "./singleton.ts";

export const PRACTICE_TOOL_NAME = "practice";
/**
 * 我们自己的手（工具名）。内置工具治理（src/hands/builtin.ts）要跳过这些工具：
 * 它们在 execute 里已经走完七步，钩子再判一次会变成双份审批/双行 steps。
 *
 * **"files" 必须在这张表里**（2026-11-25 评审实测）：漏了它，工人在会话里调 files
 * 会被通用钩子当成名单外工具，判 4 档出请示卡，runFilesHand → runHandShell 那条
 * 写前记账/快照/单例锁的路径一次都跑不到。工具名与 src/hands/hand-tool.ts:64 的
 * FILES_TOOL_NAME 一致。
 */
export const DOT_HAND_TOOL_NAMES: readonly string[] = Object.freeze([
  PRACTICE_TOOL_NAME,
  "files",
  "desktop",
  "logged_browser",
  "clean_browser",
  "wechat",
  "feishu",
]);
/** 返回给模型的正文上限（A.10：手的输出由我们的代码截短）。 */
export const HAND_TEXT_LIMIT = 4000;

/** 崩溃恢复跳过重做时，回带给模型的上一次结果正文上限。 */
const PRIOR_TEXT_CHARS = 1500;

/**
 * 上一步的结果正文（给「同一步之前已经成功过」那条提示用）。
 * 结果 artifact 是 JSON（{ok, action, data:{path/cmd/stdout…}}），这里挑对模型有用的几个字段；
 * 不是 JSON 就当纯文本截一段。
 */
function priorResultText(db: LedgerDb, ref: string | null): string {
  if (ref === null) return "";
  try {
    const art = getArtifact(db, ref);
    if (!art.found || art.content == null) return "";
    const raw = String(art.content);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 优先用 summary：那是模型当时看到的正文（结果 artifact 里现在会存一份）。
      const summary = parsed["summary"];
      if (typeof summary === "string" && summary.trim() !== "") return summary.slice(0, PRIOR_TEXT_CHARS);
      const data = parsed["data"];
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        const d = data as Record<string, unknown>;
        const bits: string[] = [];
        for (const key of ["path", "cmd", "action"]) {
          const v = d[key];
          if (typeof v === "string" && v.trim() !== "") bits.push(`${key}: ${v}`);
        }
        for (const key of ["stdout", "text"]) {
          const v = d[key];
          if (typeof v === "string" && v.trim() !== "") bits.push(v);
        }
        if (bits.length > 0) return bits.join("\n").slice(0, PRIOR_TEXT_CHARS);
      }
    } catch {
      // 不是 JSON：下面按原文给
    }
    return raw.slice(0, PRIOR_TEXT_CHARS);
  } catch {
    return "";
  }
}

const TERMINAL_TASK_STATES = new Set(["done", "failed", "cancelled"]);

export interface HandDeps {
  db: LedgerDb;
  config: DotCoreConfig;
  /** 有身份表＝插件运行时；没有＝直接调用（测试/脚本），此时必须显式给 task_id。 */
  identity?: IdentityTable;
  /** 默认 judgeTier；测试注入用。 */
  judge?: (input: GateInput) => TierVerdict;
  /** 把请示卡交给桥（A.6 链路第一跳）。没有就只记日志，不假装通知过。 */
  notify?: (approvalId: string) => Promise<{ ok: boolean; detail: string }>;
  /** snapshots 根目录；没给＝不拍快照，步骤结果里如实标 unavailable。 */
  snapshotsRoot?: string;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  now?: () => Date;
  /**
   * 少数「改了要马上生效」的配置项（目前只有自动同意档位）。
   * 没给就用 config 里那份启动快照（src/runtime/live-config.ts）。
   */
  liveSettings?: { autoApproveMaxTier: () => number };
}

export interface HandRequest {
  toolCallId?: string;
  taskId?: string;
  action?: string;
  path?: string;
  content?: string;
  overwrite?: boolean;
  /** 非 practice 手（desktop / 浏览器）的原始参数；practice 不读它。 */
  params?: Record<string, unknown>;
}

export type HandCode =
  | "ok"
  | "identity_missing"
  | "no_task"
  | "task_mismatch"
  | "task_not_found"
  | "task_terminal"
  | "task_paused"
  | "practice_root_missing"
  | "workspace_missing"
  | "denied"
  | "human_required"
  | "awaiting_approval"
  | "bad_action"
  | "busy"
  | "human_took_over"
  | "captcha_handoff"
  | "failed";

export type HandData = ListResult | MkdirResult | WriteResult | Record<string, unknown> | null;

export interface HandOutcome {
  ok: boolean;
  code: HandCode;
  /** 给模型看的正文（已截短）。 */
  text: string;
  /** 归因与审计用；不参与提示词。 */
  taskId: string | null;
  stepId: string | null;
  approvalId: string | null;
  tier: number | null;
  rule: string | null;
  sideEffect: string | null;
  /**
   * 失败时的具体错误码（手自己给的，例如 scope_missing / mcp_failed）。
   * `code` 只到 HandCode 这一层（failed 是统称），工人靠这个判断「换个手也没用」。
   */
  errorCode?: string;
  /** 这一步的完整结果存在 artifacts 里，这里的 hash 可被 dot_recall 取回。 */
  resultRef: string | null;
  /** 第 2 档拍过的快照行号；没拍或拍不了为 null。 */
  snapshotRef: string | null;
  data?: HandData;
}

// ── 壳与具体手的接口 ────────────────────────────────────────────────────────

export interface HandActResult {
  data: HandData;
  /** 给模型看的正文（不含截短，由壳统一 clamp）。 */
  summary: string;
}

export interface HandApprovalCard {
  args: unknown;
  title: string;
  detail: unknown;
}

/** 手壳在动作成功后停手（验证码交接等）；approvalId 用于「第 3 次先问」这类新单。 */
export interface HandStop {
  code: HandCode;
  text: string;
  approvalId?: string | null;
}

export interface HandStepExtra {
  taskId: string;
  approvalId: string | null;
  verdict: TierVerdict;
}

export interface HandResultExtra {
  data: HandData;
  snapshotRef: string | null;
  approvalId: string | null;
  verdict: TierVerdict;
}

export type HandPrepareResult<C> =
  | { ok: true; ctx: C }
  | { ok: false; code: HandCode; text: string };

/**
 * 一只手的差异面。壳保证身份、任务、六档、审批、写前记账、endStep 的顺序不因手而异。
 */
export interface HandSpec<C = unknown> {
  /** 账本里的工具名（steps.tool / 审批单 tool / 主题键）。 */
  toolName: string;
  /** 闸门看的工具名；默认同 toolName。clean_browser 用 "browser" 才能落第 3 档。 */
  gateTool?: string;
  /** 动作归一化；null = 不认识，按 bad_action 拒。 */
  normalize(req: HandRequest): string | null;
  /** bad_action 的中文提示（每只手的动作枚举不同）。 */
  badActionText: string;
  /** 动作上下文（练习根、MCP 客户端、当前窗口等）。执行前的停手检查也在这里。 */
  prepare(
    deps: HandDeps,
    task: TaskRow,
    action: string,
    req: HandRequest,
  ): HandPrepareResult<C> | Promise<HandPrepareResult<C>>;
  /** 构造 GateInput（给闸门看的事实，不是断言）。 */
  gateInput(action: string, req: HandRequest, ctx: C): GateInput;
  /** 闸门判完后的最后修正；只用于补判档缺口（例如只读电脑动作）。 */
  adjustVerdict?(verdict: TierVerdict, action: string, req: HandRequest, ctx: C): TierVerdict;
  /** 主题键参数（同一动作重发必须得到同一个 key）。 */
  subjectParams(action: string, req: HandRequest, ctx: C): unknown;
  /** 快照目标；null = 不拍（例如只读）。抛错按 snapshot_failed 处理。 */
  snapshotTarget(action: string, req: HandRequest, ctx: C): { abs: string; label: string } | null;
  /** 动作前置校验；返回非 null 就拒，不记账（批量上限等）。 */
  validate?(action: string, req: HandRequest, ctx: C): { code: HandCode; text: string } | null;
  /** 落地动作。抛出的异常由壳标 failed 步骤。 */
  act(action: string, req: HandRequest, ctx: C): HandActResult | Promise<HandActResult>;
  /** 动作失败时进 artifact/error 的业务 code；默认 "unexpected"。 */
  errorCode?(err: unknown): string;
  /** 第 4 档请示卡的参数与文案。 */
  approvalCard?(action: string, req: HandRequest, ctx: C, task: TaskRow, verdict: TierVerdict): HandApprovalCard;
  /** 步骤 args artifact 内容。 */
  stepArgs?(action: string, req: HandRequest, ctx: C, extra: HandStepExtra): unknown;
  /** 结果 artifact 内容。 */
  resultArtifact?(action: string, req: HandRequest, ctx: C, extra: HandResultExtra): unknown;
  /** 动作成功后、记结果之前的停手检查（验证码交接等）。approvalId 用于「第 3 次先问」这类新单。 */
  afterAct?(
    deps: HandDeps,
    task: TaskRow,
    action: string,
    req: HandRequest,
    ctx: C,
    result: HandActResult,
  ): HandStop | null | Promise<HandStop | null>;
  /** 一次性资源锁；null = 这把锁不适用。 */
  lockResource?(action: string, req: HandRequest, ctx: C): string | null;
}

function clamp(text: string): string {
  if (text.length <= HAND_TEXT_LIMIT) return text;
  return `${text.slice(0, HAND_TEXT_LIMIT)}\n…（已截短，完整内容见 artifacts）`;
}

function refusal(code: HandCode, text: string, extra: Partial<HandOutcome> = {}): HandOutcome {
  return {
    ok: false,
    code,
    // 拒得早（准备阶段、参数校验、动作名不认识）也要带错误码：工人靠它认硬失败。
    // 2026-11-25 真机：files 报 workspace_missing 时没带码，工人白试了一步才收工，
    // 任务结论写成「一步都没做（no_steps）」，把真正的原因盖掉了。
    errorCode: extra.errorCode ?? code,
    text: clamp(text),
    taskId: extra.taskId ?? null,
    stepId: extra.stepId ?? null,
    approvalId: extra.approvalId ?? null,
    tier: extra.tier ?? null,
    rule: extra.rule ?? null,
    sideEffect: extra.sideEffect ?? null,
    resultRef: extra.resultRef ?? null,
    snapshotRef: extra.snapshotRef ?? null,
    data: extra.data ?? null,
  };
}

function normalizeAction(action: unknown): "list" | "mkdir" | "write" | "read" | null {
  const a = typeof action === "string" ? action.trim().toLowerCase() : "";
  if (a === "list" || a === "ls" || a === "dir") return "list";
  if (a === "mkdir" || a === "create_dir" || a === "createdir") return "mkdir";
  if (a === "write" || a === "write_text" || a === "writefile") return "write";
  if (a === "read" || a === "cat" || a === "view" || a === "show" || a === "read_file") return "read";
  return null;
}

/** 第 1 步：身份。有身份表就必须取到；取到后只能用一次（重放拒）。 */
function resolveIdentity(deps: HandDeps, req: HandRequest): ToolCallIdentity | null {
  if (deps.identity === undefined) return null;
  const toolCallId = typeof req.toolCallId === "string" ? req.toolCallId : "";
  if (toolCallId === "") throw new IdentityMissingError("");
  const found = deps.identity.take(toolCallId);
  if (found === null) throw new IdentityMissingError(toolCallId);
  return found;
}

type TaskResolution =
  | { ok: true; task: TaskRow }
  | { ok: false; code: HandCode; text: string };

/**
 * 第 2 步：任务。**归因只认会话身份**（A.4 第 2 步、A.7「归不到就拒绝」、A.8）。
 * 参数里的 task_id 不能改写归属：会话是 task:A、参数写 B，就拒绝，不记到 B 名下。
 * 没有身份表（脚本/测试直接调用）时没有会话可认，才允许用显式 task_id。
 */
function resolveTask(deps: HandDeps, req: HandRequest, identity: ToolCallIdentity | null): TaskResolution {
  const fromParams = typeof req.taskId === "string" ? req.taskId.trim() : "";

  if (deps.identity === undefined) {
    if (fromParams === "") {
      return { ok: false, code: "no_task", text: "没有会话身份，也没有 task_id：拒绝执行、不记账。" };
    }
    const task = getTask(deps.db, fromParams);
    if (task === null) return { ok: false, code: "task_not_found", text: `账本里没有任务 ${fromParams}` };
    return { ok: true, task };
  }

  const sessionTask = identity?.taskId ?? taskIdFromSessionKey(identity?.sessionKey) ?? "";
  if (sessionTask === "") {
    return {
      ok: false,
      code: "no_task",
      text: "这个会话不是工人会话（sessionKey 不是 task:<task_id>）：手只给工人会话用，拒绝执行、不记账。",
    };
  }
  if (fromParams !== "" && fromParams !== sessionTask) {
    return {
      ok: false,
      code: "task_mismatch",
      text: `参数 task_id=${fromParams} 与会话任务 ${sessionTask} 不一致：拒绝（归因只认会话）。`,
    };
  }
  const task = getTask(deps.db, sessionTask);
  if (task === null) return { ok: false, code: "task_not_found", text: `账本里没有任务 ${sessionTask}` };
  return { ok: true, task };
}

/**
 * 目标是不是真的在练习根里（给闸门看的事实，不是断言）。
 * 解析不了（绝对路径 / `..` / 盘符 / 符号链接）一律算「不在」，于是闸门按
 * B.9「超声明范围」给第 4 档提问——而不是让手先假装 inWorkspace=true 再在落地时炸。
 */
function pathInsideRoot(root: string, relPath: string | undefined): boolean {
  try {
    resolvePracticePath(root, relPath, { allowRoot: true });
    return true;
  } catch (err) {
    if (err instanceof PracticeError) return false;
    throw err;
  }
}

function gateInputFor(action: "list" | "mkdir" | "write", req: HandRequest, root: string): GateInput {
  return {
    tool: PRACTICE_TOOL_NAME,
    action,
    args: { path: req.path ?? null, action },
    target: typeof req.path === "string" && req.path !== "" ? req.path : ".",
    workspace: root,
    inWorkspace: pathInsideRoot(root, req.path),
  };
}

function isAllow(handling: Handling): boolean {
  return handling === "allow" || handling === "snapshot";
}

// ── 审批与任务状态（A.6、B.9）──────────────────────────────────────────────

/** 把任务写到「等待输入」，并把 blocked_on 指向这张审批单（可重复调用）。 */
function markTaskAwaiting(db: LedgerDb, taskId: string, approvalId: string, reason: string): void {
  const current = getTask(db, taskId);
  if (current === null || TERMINAL_TASK_STATES.has(current.state)) return;
  const blocked = current.blocked_on_json === null ? null : parseBlockedOn(current.blocked_on_json);
  if (current.state === "awaiting_approval" && blocked !== null && (blocked.approval_ids ?? []).includes(approvalId)) {
    return;
  }
  setTaskState(db, taskId, "awaiting_approval", {
    reason,
    blocked_on: { type: "human", reason, approval_ids: [approvalId] },
  });
}

/** 审批通过并执行完后，把任务从「等待输入」放回 running（只放我们自己挂上去的那个）。 */
function resumeTaskIfWaiting(db: LedgerDb, taskId: string, approvalId: string): void {
  const current = getTask(db, taskId);
  if (current === null || current.state !== "awaiting_approval") return;
  const blocked = current.blocked_on_json === null ? null : parseBlockedOn(current.blocked_on_json);
  if (blocked !== null && (blocked.approval_ids ?? []).length > 0 && !(blocked.approval_ids ?? []).includes(approvalId)) {
    return;
  }
  setTaskState(db, taskId, "running", { blocked_on: null, reason: "审批通过，继续执行" });
}

interface ApprovalAcquisition {
  mode: "execute" | "wait";
  approvalId: string;
  /** true = 这一轮新建的单（要转发给桥）。 */
  created: boolean;
  row: ApprovalRow;
}

/**
 * 第 4 步的完整状态机：pending → 等；approved → 抢占成 executing 后放行；
 * 没有活动单 → 建单。同一 subject_key 的幂等由账本的部分唯一索引兜底。
 */
function acquireApproval<C>(
  deps: HandDeps,
  task: TaskRow,
  verdict: TierVerdict,
  subjectKey: string,
  action: string,
  req: HandRequest,
  spec: HandSpec<C>,
  ctx: C,
): ApprovalAcquisition {
  const existing = findOpenApprovalBySubjectKey(deps.db, subjectKey);

  if (existing !== null && existing.status === "approved") {
    if (markApprovalExecuting(deps.db, existing.id)) {
      return { mode: "execute", approvalId: existing.id, created: false, row: existing };
    }
    const after = getApproval(deps.db, existing.id);
    return { mode: "wait", approvalId: existing.id, created: false, row: after ?? existing };
  }
  if (existing !== null) {
    return { mode: "wait", approvalId: existing.id, created: false, row: existing };
  }

  const card: HandApprovalCard = spec.approvalCard?.(action, req, ctx, task, verdict) ?? {
    args: { action },
    title: `${spec.toolName} 动作需要批准：${action}`,
    detail: {
      question: `允许这一步吗：${verdict.reason}`,
      options: ["同意", "拒绝"],
      detail: `${task.intent}\n工具：${spec.toolName}/${action}`,
    },
  };

  const created = createApproval(deps.db, {
    taskId: task.id,
    tool: spec.toolName,
    args: card.args,
    tier: verdict.tier,
    title: card.title,
    detail: card.detail,
    ttlMs: deps.config.approvals.ttl_hours * 3600 * 1000,
    subjectKey,
  });

  const row = getApproval(deps.db, created.approval.id) ?? created.approval;

  // 自动同意（config.approvals.auto_approve_max_tier）：0 = 关。
  // 这是一件**安全开关**，所以边界写死在代码里：
  //   · 上限最多到 4 档（配置里写 9 也只当 4）；
  //   · 5 档（身份/钱）与 6 档（危险/直接拒）永远不自动 —— 那两档本来就是「交还人手」；
  //   · 每一次自动同意都落一条 approval_auto_approved 事件，账本里查得到是谁放的。
  const autoMax = Math.min(
    4,
    Math.max(0, deps.liveSettings?.autoApproveMaxTier() ?? deps.config.approvals.auto_approve_max_tier),
  );
  if (autoMax > 0 && row.status === "pending" && verdict.tier <= autoMax) {
    try {
      decideApproval(deps.db, row.id, {
        decision: "approved",
        decidedBy: "system",
        note: `自动同意（${verdict.tier} 档 ≤ 上限 ${autoMax}）`,
      });
      appendEvent(deps.db, {
        type: "approval_auto_approved",
        task_id: task.id,
        payload: { approval_id: row.id, tier: verdict.tier, tool: spec.toolName, action, max_tier: autoMax },
      });
      deps.logger?.("info", `自动同意 ${spec.toolName}/${action}（${verdict.tier} 档 ≤ 上限 ${autoMax}）`);
      const afterAuto = getApproval(deps.db, row.id) ?? row;
      if (afterAuto.status === "approved" && markApprovalExecuting(deps.db, afterAuto.id)) {
        return { mode: "execute", approvalId: afterAuto.id, created: true, row: afterAuto };
      }
    } catch (err) {
      // 自动同意失败不是致命错误：退回「等人点」，别把这一步直接判死。
      deps.logger?.("warn", `自动同意失败，改回等人点：${(err as Error).message}`);
    }
  }

  if (row.status === "approved" && markApprovalExecuting(deps.db, row.id)) {
    return { mode: "execute", approvalId: row.id, created: true, row };
  }
  return { mode: "wait", approvalId: row.id, created: true, row };
}

/**
 * 跑一次手：A.4 的七步（差异面由 spec 提供）。
 * 任何异常都转成 `failed` 结果；动手之后的异常一定先把步骤标 failed 再返回：
 * 留一个 started 的步骤等恢复协议，比谎报成功好，但比当场标失败差。
 */
export async function runHandShell<C>(deps: HandDeps, req: HandRequest, spec: HandSpec<C>): Promise<HandOutcome> {
  const judge = deps.judge ?? judgeTier;
  const log = deps.logger ?? (() => {});

  // ── 1) 身份 ──────────────────────────────────────────────────────────────
  let identity: ToolCallIdentity | null;
  try {
    identity = resolveIdentity(deps, req);
  } catch (err) {
    if (err instanceof IdentityMissingError) return refusal("identity_missing", err.message);
    throw err;
  }

  // ── 2) 任务 ──────────────────────────────────────────────────────────────
  const resolution = resolveTask(deps, req, identity);
  if (!resolution.ok) return refusal(resolution.code, resolution.text);
  const task = resolution.task;
  if (TERMINAL_TASK_STATES.has(task.state)) {
    return refusal("task_terminal", `任务 ${task.id} 已是 ${task.state}，不再执行`, { taskId: task.id });
  }
  // paused = 「会话超时/恢复协议让人看一眼」。旧工人会话可能还活着，这里必须拦住：
  // 只认终态的话，超时之后旧会话还能继续动手（2026-11-25 审核实测过）。
  if (task.state === "paused") {
    return refusal(
      "task_paused",
      `任务 ${task.id} 已暂停（${task.state_reason ?? "等恢复协议"}）：现在不执行动作，等人或恢复协议处理。`,
      { taskId: task.id },
    );
  }

  // ── 2.5) 动作归一化 ─────────────────────────────────────────────────────
  const action = spec.normalize(req);
  if (action === null) {
    return refusal("bad_action", spec.badActionText, { taskId: task.id });
  }

  // ── 2.6) 动作上下文（练习根 / MCP 客户端 / 当前窗口）────────────────────
  let prepared: HandPrepareResult<C>;
  try {
    prepared = await spec.prepare(deps, task, action, req);
  } catch (err) {
    if (err instanceof PracticeError) {
      return refusal(err.code === "practice_root_missing" ? "practice_root_missing" : "failed", err.message, {
        taskId: task.id,
      });
    }
    throw err;
  }
  if (!prepared.ok) return refusal(prepared.code, prepared.text, { taskId: task.id });
  const ctx = prepared.ctx;

  // 可选：动作前置校验（批量上限等）。拒了不记账，和 bad_action 同口径。
  const invalid = spec.validate?.(action, req, ctx) ?? null;
  if (invalid !== null) return refusal(invalid.code, invalid.text, { taskId: task.id });

  // ── 3) 闸门 ──────────────────────────────────────────────────────────────
  const gateInput = spec.gateInput(action, req, ctx);
  if (spec.gateTool !== undefined && gateInput.tool !== spec.gateTool) {
    // 允许「账本工具名」与「闸门工具名」不同：clean_browser 记账用自己名字，
    // 判档要按 judge 认识的 browser 走，否则会掉到「拿不准 → 4」。
    gateInput.tool = spec.gateTool;
  }
  let verdict = judge(gateInput);
  if (spec.adjustVerdict !== undefined) {
    verdict = spec.adjustVerdict(verdict, action, req, ctx);
  }
  const base = { taskId: task.id, tier: verdict.tier, rule: verdict.rule, sideEffect: verdict.sideEffect };

  if (verdict.tier === 6 || verdict.handling === "deny") {
    log("warn", `${spec.toolName} ${action} 被闸门拒绝：${verdict.rule}`);
    return refusal("denied", `拒绝执行：${verdict.reason}（规则 ${verdict.rule}）`, base);
  }
  if (verdict.tier === 5 || verdict.handling === "human") {
    log("warn", `${spec.toolName} ${action} 按第 5 档交还人手：${verdict.rule}`);
    return refusal(
      "human_required",
      `这类动作要交给你本人做，任务停下等指令：${verdict.reason}（规则 ${verdict.rule}）`,
      base,
    );
  }

  // ── 3.5) 主题键 ─────────────────────────────────────────────────────────
  const subjectKey = computeSubjectKey(task.id, spec.toolName, spec.subjectParams(action, req, ctx));

  // ── 3.6) 崩溃恢复：同一步不重做 ─────────────────────────────────────────
  // 2026-11-25 断电演练真机：第 1 步在崩溃前已经 succeeded，重启后 epoch+1，
  // 工人从头又做了一遍，账本里同一个 subject_key 出现两条 succeeded。
  // 方案第 1 步验收 4 要的是「不会悄悄从头再做一遍」，所以这里按账本拦住：
  // 只在本轮是恢复（run_epoch > 0）时生效，正常一轮里连点同一个按钮不受影响。
  if (task.run_epoch > 0) {
    const prior = findSucceededStepBySubjectKey(deps.db, task.id, subjectKey);
    if (prior !== null) {
      const note = `崩溃恢复：同一步之前已经成功过（seq ${prior.seq}），没有重做`;
      // 只回一句「结果同上一次」模型是接不上的：它要的是内容，拿不到就换个写法再问一遍
      // （2026-11-27 真机上同一条任务在 epoch 3 里连着重试 cat / ls / rg --files 十几步）。
      // 所以把上次的结果正文带上。
      const priorText = priorResultText(deps.db, prior.result_ref);
      let stepId: string | null = null;
      try {
        const step = beginStep(deps.db, {
          task_id: task.id,
          milestone_id: task.milestone_id,
          run_epoch: task.run_epoch,
          kind: "tool",
          tool: spec.toolName,
          subject_key: subjectKey,
          side_effect: verdict.sideEffect,
          tier: verdict.tier,
          args_ref: null,
          session_key: identity?.sessionKey ?? null,
        });
        endStep(deps.db, step.id, { status: "skipped", error: note });
        stepId = step.id;
      } catch (err) {
        // 记不上账也不影响「不重做」这个结论：宁可少一条记录，也不要重做一遍。
        log("warn", `${spec.toolName}/${action} 跳过记账失败：${(err as Error).message}`);
      }
      log("info", `${spec.toolName}/${action} ${note}`);
      return {
        ok: true,
        code: "ok",
        text:
          `${note}。` +
          (priorText === ""
            ? "结果同上一次，不用再查。"
            : `上次的结果（不用再查）：\n${priorText}`),
        taskId: task.id,
        stepId,
        approvalId: null,
        tier: verdict.tier,
        rule: verdict.rule,
        sideEffect: verdict.sideEffect,
        resultRef: prior.result_ref,
        snapshotRef: null,
        data: null,
      };
    }
  }

  // ── 4) 审批（第 4 档）────────────────────────────────────────────────────
  let approvalId: string | null = null;
  if (verdict.handling === "ask") {
    const acquired = acquireApproval(deps, task, verdict, subjectKey, action, req, spec, ctx);

    if (acquired.mode === "wait") {
      markTaskAwaiting(deps.db, task.id, acquired.approvalId, `等审批 #${acquired.approvalId}`);
      if (acquired.created && deps.notify !== undefined) {
        try {
          const sent = await deps.notify(acquired.approvalId);
          log(sent.ok ? "info" : "warn", `请示卡 #${acquired.approvalId} 转发：${sent.detail}`);
        } catch (err) {
          log("warn", `请示卡 #${acquired.approvalId} 转发失败：${(err as Error).message}`);
        }
      } else if (acquired.created) {
        log("warn", `没有配通知通道：请示卡 #${acquired.approvalId} 只在账本里，聊天窗看不到`);
      }
      return refusal(
        "awaiting_approval",
        `已出请示卡 #${acquired.approvalId}（${acquired.created ? "新建" : "已有"}，${acquired.row.status}），` +
          `批准后重新调用同一动作即可执行。`,
        { ...base, approvalId: acquired.approvalId },
      );
    }

    approvalId = acquired.approvalId;
    resumeTaskIfWaiting(deps.db, task.id, approvalId);
    log("info", `${spec.toolName} ${action} 的审批 #${approvalId} 已通过，开始执行`);
  }

  if (verdict.handling !== "ask" && !isAllow(verdict.handling)) {
    return refusal("denied", `闸门处置 ${verdict.handling} 不在手的可执行范围内：${verdict.reason}`, base);
  }

  // ── 4.5) 单例锁 + 5~7 步（锁也放进 try：拿锁之后的任何 logger/记账异常都要放锁）──
  let handLock: { release: () => boolean } | null = null;
  try {
    const lockResource = spec.lockResource?.(action, req, ctx) ?? null;
    if (lockResource !== null) {
      const got = acquireHandLock({
        db: deps.db,
        resource: lockResource,
        taskId: task.id,
        ttlMs: deps.config.dispatch.lock_ttl_ms,
      });
      if (!got.ok) {
        if (approvalId !== null) markApprovalExecuted(deps.db, approvalId, false);
        log("warn", `${spec.toolName} ${action} 拿不到单例锁：${got.detail}`);
        return refusal("busy", `这一步先不做：${got.detail}。等对面放锁后再试。`, { ...base, approvalId });
      }
      handLock = got;
      if (got.mode === "renewed") log("info", `${spec.toolName} 续租单例锁 ${got.resource}`);
    }

    // ── 5) 写前记账 ────────────────────────────────────────────────────────
    const stepArgs =
      spec.stepArgs?.(action, req, ctx, { taskId: task.id, approvalId, verdict }) ?? {
        action,
        task_id: task.id,
        approval_id: approvalId,
        snapshot: verdict.handling === "snapshot" ? "planned" : "not_required",
      };
    const argsArtifact = putArtifact(deps.db, JSON.stringify(stepArgs));
    let stepId: string;
    try {
      const step = beginStep(deps.db, {
        task_id: task.id,
        milestone_id: task.milestone_id,
        run_epoch: task.run_epoch,
        kind: "tool",
        tool: spec.toolName,
        subject_key: subjectKey,
        side_effect: verdict.sideEffect,
        tier: verdict.tier,
        args_ref: argsArtifact.hash,
        session_key: identity?.sessionKey ?? null,
      });
      stepId = step.id;
    } catch (err) {
      const message = (err as Error).message;
      log("error", `beginStep 失败：${message}`);
      if (approvalId !== null) markApprovalExecuted(deps.db, approvalId, false);
      return refusal("failed", `记账失败，动作没有执行：${message}`, { ...base, approvalId });
    }

    // ── 6a) 第 2 档：先快照再放行（B.9）────────────────────────────────────
    let snapshotRef: string | null = null;
    if (verdict.handling === "snapshot") {
      try {
        const target = spec.snapshotTarget(action, req, ctx);
        if (target !== null) {
          if (deps.snapshotsRoot === undefined) {
            log("warn", `第 2 档动作没有配 snapshotsRoot：${spec.toolName}/${action} 不拍快照`);
          } else {
            const row = snapshotPath(
              { db: deps.db, snapshotsRoot: deps.snapshotsRoot, now: deps.now },
              { taskId: task.id, milestoneId: task.milestone_id, sourcePath: target.abs, label: target.label },
            );
            snapshotRef = row.id;
            log("info", `已快照 ${target.label}（snapshot ${row.id}）`);
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        const failedArtifact = putArtifact(deps.db, JSON.stringify({ ok: false, code: "snapshot_failed", message }));
        try {
          endStep(deps.db, stepId, {
            status: "failed",
            error: `snapshot_failed: ${message}`.slice(0, 500),
            result_ref: failedArtifact.hash,
          });
        } catch (endErr) {
          log("error", `endStep(failed) 也失败了：${(endErr as Error).message}`);
        }
        if (approvalId !== null) markApprovalExecuted(deps.db, approvalId, false);
        return refusal("failed", `快照失败，动作没有执行：${message}`, {
          ...base,
          stepId,
          approvalId,
          resultRef: failedArtifact.hash,
        });
      }
    }

    // ── 6b) 动手 ───────────────────────────────────────────────────────────
    let actResult: HandActResult;
    try {
      actResult = await spec.act(action, req, ctx);
    } catch (err) {
      const code = spec.errorCode?.(err) ?? "unexpected";
      const message = (err as Error).message;
      // ── 7a) 失败也要落账 ────────────────────────────────────────────────
      const failedArtifact = putArtifact(deps.db, JSON.stringify({ ok: false, code, message }));
      try {
        endStep(deps.db, stepId, {
          status: "failed",
          error: `${code}: ${message}`.slice(0, 500),
          result_ref: failedArtifact.hash,
        });
      } catch (endErr) {
        log("error", `endStep(failed) 也失败了：${(endErr as Error).message}`);
      }
      if (approvalId !== null) markApprovalExecuted(deps.db, approvalId, false);
      log("warn", `${spec.toolName} ${action} 失败：${code} ${message}`);
      return {
        ...refusal("failed", `动作没有完成：${message}`, {
          ...base,
          stepId,
          approvalId,
          resultRef: failedArtifact.hash,
          snapshotRef,
        }),
        errorCode: code,
      };
    }

    // ── 6c) 动作成功但必须立刻停手的情形（验证码交接等）──────────────────────
    const stop = (await spec.afterAct?.(deps, task, action, req, ctx, actResult)) ?? null;

    // ── 7b) 记结果 ─────────────────────────────────────────────────────────
    // `summary` 是给模型看的正文，也一起存进 artifact：崩溃恢复跳过重做时要把它带回去，
    // 而手各自的 resultArtifact 只挑结构化字段（files 的正文就不在里面）。
    const shaped =
      spec.resultArtifact?.(action, req, ctx, {
        data: actResult.data,
        snapshotRef,
        approvalId,
        verdict,
      }) ?? {
        ok: true,
        action,
        data: actResult.data,
        snapshot: snapshotRef !== null ? "created" : verdict.handling === "snapshot" ? "unavailable" : "not_required",
        approval_id: approvalId,
      };
    const resultShape =
      shaped !== null && typeof shaped === "object" && !Array.isArray(shaped)
        ? { ...(shaped as Record<string, unknown>), summary: actResult.summary }
        : shaped;
    const resultArtifact = putArtifact(deps.db, JSON.stringify(resultShape));
    try {
      endStep(deps.db, stepId, { status: "succeeded", result_ref: resultArtifact.hash });
    } catch (err) {
      log("error", `endStep 失败（步骤会留在 started，交给恢复协议）：${(err as Error).message}`);
      if (approvalId !== null) markApprovalExecuted(deps.db, approvalId, true);
      return {
        ok: true,
        code: "ok",
        text: clamp(`${actResult.summary}\n（注意：结果记账失败，这一步仍显示为进行中，恢复时会问你）`),
        taskId: task.id,
        stepId,
        approvalId,
        tier: verdict.tier,
        rule: verdict.rule,
        sideEffect: verdict.sideEffect,
        resultRef: resultArtifact.hash,
        snapshotRef,
        data: actResult.data,
      };
    }

    if (approvalId !== null) markApprovalExecuted(deps.db, approvalId, true);

    if (stop !== null) {
      return refusal(stop.code, stop.text, {
        ...base,
        stepId,
        approvalId: stop.approvalId ?? approvalId,
        resultRef: resultArtifact.hash,
        snapshotRef,
        data: actResult.data,
      });
    }

    return {
      ok: true,
      code: "ok",
      text: clamp(actResult.summary),
      taskId: task.id,
      stepId,
      approvalId,
      tier: verdict.tier,
      rule: verdict.rule,
      sideEffect: verdict.sideEffect,
      resultRef: resultArtifact.hash,
      snapshotRef,
      data: actResult.data,
    };
  } finally {
    if (handLock !== null) handLock.release();
  }
}

// ── practice 手：壳的第一个实例 ─────────────────────────────────────────────

interface PracticeContext {
  root: string;
}

const practiceSpec: HandSpec<PracticeContext> = {
  toolName: PRACTICE_TOOL_NAME,
  normalize: (req) => normalizeAction(req.action),
  badActionText: "action 只支持 list / mkdir / write",
  prepare(deps) {
    try {
      return { ok: true, ctx: { root: practiceRootOf(deps.config.practice.root) } };
    } catch (err) {
      if (err instanceof PracticeError) {
        return { ok: false, code: "practice_root_missing", text: err.message };
      }
      throw err;
    }
  },
  gateInput(action, req, ctx) {
    return gateInputFor(action as "list" | "mkdir" | "write", req, ctx.root);
  },
  subjectParams(action, req) {
    return { action, path: req.path ?? null, overwrite: req.overwrite === true };
  },
  snapshotTarget(action, req, ctx) {
    if (action === "list") return null;
    const target = resolvePracticePath(ctx.root, req.path ?? ".", { allowRoot: true });
    return { abs: target.abs, label: target.rel };
  },
  act(action, req, ctx) {
    if (action === "list") {
      const listed = listDir(ctx.root, req.path);
      return { data: listed, summary: renderList(listed) };
    }
    if (action === "read") {
      if (typeof req.path !== "string" || req.path.trim() === "") {
        throw new PracticeError("bad_path", "read 需要 path");
      }
      const target = resolvePracticePath(ctx.root, req.path, { allowRoot: false });
      let content: string;
      try {
        content = readFileSync(target.abs, "utf8");
      } catch {
        throw new PracticeError(
          "not_found",
          `练习文件夹里没有：${target.rel}。读项目文件请用 files 手的 read（工作区相对路径）；` +
            "practice 只管练习文件夹，两边不是一回事。",
        );
      }
      const MAX_READ = 8000;
      const truncated = content.length > MAX_READ;
      return {
        data: { path: target.rel, bytes: Buffer.byteLength(content), truncated },
        summary: truncated
          ? `文件：${target.rel}（${content.length} 字符，太长只给前 ${MAX_READ} 字符）\n---\n${content.slice(0, MAX_READ)}\n---（截断）`
          : `文件：${target.rel}（${content.length} 字符）\n---\n${content}\n---`,
      };
    }
    if (action === "mkdir") {
      if (typeof req.path !== "string" || req.path.trim() === "") {
        throw new PracticeError("bad_path", "mkdir 需要 path");
      }
      const made = makeDir(ctx.root, req.path);
      return {
        data: made,
        summary:
          made.created.length === 0
            ? `文件夹已存在：${made.path}`
            : `建好文件夹：${made.path}（新建 ${made.created.length} 级：${made.created.join(" / ")}）`,
      };
    }
    if (typeof req.path !== "string" || req.path.trim() === "") {
      throw new PracticeError("bad_path", "write 需要 path");
    }
    const written = writeTextFile(ctx.root, req.path, req.content ?? "", { overwrite: req.overwrite === true });
    return {
      data: written,
      summary: `写入完成：${written.path}（${written.bytes} 字节，${written.created ? "新建" : "覆盖"}）`,
    };
  },
  errorCode(err) {
    return err instanceof PracticeError ? err.code : "unexpected";
  },
  approvalCard(action, req, _ctx, task, verdict) {
    return {
      args: { action, path: req.path ?? null },
      title: `练习文件夹动作需要批准：${action}${req.path ? ` ${req.path}` : ""}`,
      detail: {
        question: `允许这一步吗：${verdict.reason}`,
        options: ["同意", "拒绝"],
        detail: `${task.intent}\n工具：${PRACTICE_TOOL_NAME}/${action}\n路径：${req.path ?? "(根目录)"}`,
      },
    };
  },
  stepArgs(action, req, _ctx, extra) {
    return {
      action,
      path: req.path ?? null,
      overwrite: req.overwrite === true,
      task_id: extra.taskId,
      approval_id: extra.approvalId,
      snapshot: extra.verdict.handling === "snapshot" ? "planned" : "not_required",
    };
  },
  resultArtifact(action, _req, _ctx, extra) {
    return {
      ok: true,
      action,
      data: extra.data,
      snapshot:
        extra.snapshotRef !== null
          ? "created"
          : extra.verdict.handling === "snapshot"
            ? "unavailable"
            : "not_required",
      approval_id: extra.approvalId,
    };
  },
};

/** 跑一次练习文件夹动作（保持原签名：外部调用方与测试不用改）。 */
export async function runPracticeHand(deps: HandDeps, req: HandRequest): Promise<HandOutcome> {
  return runHandShell(deps, req, practiceSpec);
}

export function renderList(listed: ListResult): string {
  const where = listed.path === "." ? "（练习文件夹根）" : listed.path;
  if (listed.total === 0) return `${where} 是空的`;
  const lines = listed.entries.map((e) => {
    if (e.type === "dir") return `[目录] ${e.name}/`;
    if (e.type === "file") return `[文件] ${e.name}（${e.bytes ?? "?"} 字节）`;
    return `[其他] ${e.name}`;
  });
  const tail = listed.truncated
    ? `\n…（共 ${listed.total} 项，只列前 ${listed.entries.length} 项）`
    : "";
  return `${where} 共 ${listed.total} 项：\n${lines.join("\n")}${tail}`;
}
