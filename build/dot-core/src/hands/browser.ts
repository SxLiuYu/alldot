/**
 * src/hands/browser.ts —— 两只浏览器手（Playwright MCP）。
 *
 * logged_browser：连已登录的那台 Playwright MCP（--user-data-dir 指向用户 profile），
 *   Playwright 自己是单例，所以这只手额外拿 hand:logged_browser 锁。
 * clean_browser：连干净的那台（--isolated / 独立 profile），**不许复用**已登录那台的
 *   地址或 profile；拿 hand:clean_browser 锁。
 *
 * 判档（与 judge.ts 第 7 条对齐）：
 * - navigate / fill / select / snapshot / 普通 click 等可逆动作 → 第 3 档放行记账；
 * - 提交类（args.submit=true，或 click 的目标文字像 submit/提交/发送）→ reversible=false
 *   → 第 4 档每次问；
 * - evaluate / handle_dialog 一律 reversible=false（绝不自动放行脚本执行与弹窗确认）。
 *
 * 验证码交接：snapshot/screenshot 的返回正文里命中 config.browser.captcha.keywords
 * （默认 验证码 / captcha / 滑块 / 人机验证）就立刻停手，返回 code="captcha_handoff"，
 * 把任务挂到「等人」并把当前地址写进说明；不许自己猜着点。
 */

import type { GateInput } from "../gate/types.ts";
import { createApproval } from "../gate/index.ts";
import {
  computeSubjectKey,
  getApproval,
  markApprovalExecuted,
  markApprovalExecuting,
  parseBlockedOn,
  setTaskState,
  type TaskRow,
} from "../ledger/index.ts";
import { McpHttpClient, toolResultText, type McpTransport } from "../mcp/client.ts";
import {
  runHandShell,
  type HandActResult,
  type HandDeps,
  type HandOutcome,
  type HandRequest,
  type HandSpec,
} from "./hand.ts";

export const BROWSER_ACTIONS = [
  "navigate",
  "back",
  "click",
  "type",
  "fill_form",
  "press_key",
  "select_option",
  "tabs",
  "snapshot",
  "screenshot",
  "wait_for",
  "handle_dialog",
  "evaluate",
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

export type BrowserKind = "logged_browser" | "clean_browser";

/** 动作 → Playwright MCP 的工具名。 */
export const BROWSER_TOOL_MAP: Readonly<Record<BrowserAction, string>> = Object.freeze({
  navigate: "browser_navigate",
  back: "browser_navigate_back",
  click: "browser_click",
  type: "browser_type",
  fill_form: "browser_fill_form",
  press_key: "browser_press_key",
  select_option: "browser_select_option",
  tabs: "browser_tabs",
  snapshot: "browser_snapshot",
  screenshot: "browser_take_screenshot",
  wait_for: "browser_wait_for",
  handle_dialog: "browser_handle_dialog",
  evaluate: "browser_evaluate",
});

/** 每个动作允许透传给 Playwright MCP 的参数键。 */
const BROWSER_ARG_KEYS: Readonly<Record<BrowserAction, readonly string[]>> = Object.freeze({
  navigate: ["url"],
  back: [],
  click: ["element", "ref", "selector", "button", "doubleClick", "modifiers"],
  type: ["element", "ref", "selector", "text", "submit", "slowly"],
  fill_form: ["fields", "form", "values"],
  press_key: ["key"],
  select_option: ["element", "ref", "selector", "values", "value"],
  tabs: ["action", "index", "url"],
  snapshot: ["target", "selector"],
  screenshot: ["target", "filename", "fullPage", "element", "ref"],
  wait_for: ["text", "time", "timeout", "element", "ref", "state"],
  handle_dialog: ["accept", "promptText", "prompt_text"],
  evaluate: ["function", "expression", "script"],
});

/** 一律第 4 档的动作：脚本执行与弹窗确认不许自动放行。 */
const ALWAYS_ASK: readonly BrowserAction[] = Object.freeze(["evaluate", "handle_dialog"]);

export const BROWSER_ACTION_HELP =
  "动作不支持：只认 navigate / back / click / type / fill_form / press_key / select_option / tabs / snapshot / screenshot / wait_for / handle_dialog / evaluate（英文动作名）";

const ACTION_ALIASES: Readonly<Record<string, BrowserAction>> = Object.freeze({
  navigate: "navigate",
  goto: "navigate",
  open: "navigate",
  back: "back",
  go_back: "back",
  click: "click",
  type: "type",
  fill: "fill_form",
  fill_form: "fill_form",
  fillform: "fill_form",
  press_key: "press_key",
  press: "press_key",
  key: "press_key",
  select_option: "select_option",
  select: "select_option",
  tabs: "tabs",
  snapshot: "snapshot",
  screenshot: "screenshot",
  wait_for: "wait_for",
  waitfor: "wait_for",
  handle_dialog: "handle_dialog",
  dialog: "handle_dialog",
  evaluate: "evaluate",
  eval: "evaluate",
});

export function normalizeBrowserAction(action: unknown): BrowserAction | null {
  if (typeof action !== "string") return null;
  const key = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ACTION_ALIASES[key] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

export function filterBrowserParams(action: BrowserAction, raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const params = asRecord(raw);
  const out: Record<string, unknown> = {};
  for (const key of BROWSER_ARG_KEYS[action]) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

/**
 * 这次是不是提交类（不可逆）。三处证据：显式 submit=true、reversible=false，
 * 或 click 的目标文字像 submit/提交/发送。
 */
export function looksLikeSubmit(action: BrowserAction, params: Record<string, unknown>): boolean {
  if (params["submit"] === true) return true;
  if (params["reversible"] === false) return true;
  if (ALWAYS_ASK.includes(action)) return true;
  if (action === "click") {
    const label = [params["element"], params["ref"], params["selector"]]
      .filter((x): x is string => typeof x === "string")
      .join(" ");
    if (/submit|提交|发送|确认下单|send/i.test(label)) return true;
  }
  return false;
}

/** 返回第一个命中的验证码关键词；没有就 null。 */
export function hitCaptchaKeyword(text: string, keywords: readonly string[]): string | null {
  if (text === "") return null;
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    const word = keyword.trim().toLowerCase();
    if (word !== "" && lower.includes(word)) return keyword;
  }
  return null;
}

function extractUrl(text: string): string | null {
  const match = /https?:\/\/[^\s"'<>）)]+/i.exec(text);
  return match === null ? null : match[0];
}

class BrowserMcpError extends Error {
  readonly code = "mcp_error";
  constructor(message: string) {
    super(message);
    this.name = "BrowserMcpError";
  }
}

interface BrowserContext {
  client: McpHttpClient;
  /** 说明里用的当前地址（navigate 时记下，正文里能抠到就更新）。 */
  currentUrl: string | null;
  /** 主题键要按任务区分「验证码交接后重问」的轮次。 */
  taskId: string | null;
}

/** 验证码最多自动交还几次；第 3 次改成问「还要不要继续」。 */
export const MAX_CAPTCHA_HANDOFFS = 2;

export interface BrowserHandOptions {
  client?: McpHttpClient;
  transport?: McpTransport;
  /** 覆盖配置里的地址。 */
  mcpUrl?: string;
  /** clean 手的 profile；null=--isolated。logged 手忽略这个字段。 */
  profile?: string | null;
  timeoutMs?: number;
}

export interface BrowserHand {
  run(req: HandRequest): Promise<HandOutcome>;
  readonly kind: BrowserKind;
  readonly mcpUrl: string;
  readonly profile: string | null;
  readonly client: McpHttpClient;
}

/**
 * 造一只浏览器手。kind 决定默认地址与锁；clean 手在构造时就拒绝复用已登录地址。
 */
export function createBrowserHand(
  deps: HandDeps,
  kind: BrowserKind,
  opts: BrowserHandOptions = {},
): BrowserHand {
  const defaultUrl =
    kind === "logged_browser" ? deps.config.browser.logged_mcp_url : deps.config.browser.clean_mcp_url;
  const url = opts.mcpUrl ?? defaultUrl;
  const profile = kind === "clean_browser" ? (opts.profile ?? deps.config.browser.clean_profile) : null;

  if (kind === "clean_browser" && url === deps.config.browser.logged_mcp_url) {
    throw new Error(
      `clean_browser 不许复用已登录浏览器的地址（${url}）：它必须连独立 profile / --isolated 的那台`,
    );
  }

  const client =
    opts.client ??
    new McpHttpClient({ url, transport: opts.transport, timeoutMs: opts.timeoutMs });
  const keywords = deps.config.browser.captcha.keywords;
  const log = deps.logger ?? (() => {});
  const state: { currentUrl: string | null } = { currentUrl: null };
  /** 每个任务已经交还过几次验证码（进程内计数；重启后从 0 起，够挡住同一轮反复撞）。 */
  const captchaCounts = new Map<string, number>();
/** 交接轮次：进了 subject_key，保证交接后同一条提交会重新出单，不复用旧卡。 */
  const handoffEpochs = new Map<string, number>();

  /**
   * 验证码确认单（kind=question）批了之后，任务不能永远停在 awaiting_approval：
   * 下一次调用先把它结算掉——批准/已执行→回 running，拒绝→挂 paused 并交还人手。
   */
  function settleCaptchaQuestion(task: TaskRow): "none" | "continue" | "stop" {
    if (task.state !== "awaiting_approval" || task.blocked_on_json === null) return "none";
    const blocked = parseBlockedOn(task.blocked_on_json);
    const ids = blocked?.approval_ids ?? [];
    if (ids.length === 0) return "none";

    let approved = false;
    for (const id of ids) {
      const row = getApproval(deps.db, id);
      if (row === null || row.kind !== "question") return "none";
      if (row.status === "pending" || row.status === "executing") return "none";
      if (row.status === "rejected" || row.status === "expired" || row.status === "revoked") {
        const reason = "验证码确认单里选了「停下」：手不再自动继续";
        setTaskState(deps.db, task.id, "paused", {
          reason,
          blocked_on: { type: "human", reason },
        });
        return "stop";
      }
      if (row.status === "approved") {
        if (markApprovalExecuting(deps.db, row.id)) markApprovalExecuted(deps.db, row.id, true);
        approved = true;
      } else if (row.status === "executed") {
        approved = true;
      } else {
        return "none";
      }
    }
    if (approved) {
      setTaskState(deps.db, task.id, "running", {
        reason: "验证码确认单已处理，继续",
        blocked_on: null,
      });
      return "continue";
    }
    return "none";
  }

  const spec: HandSpec<BrowserContext> = {
    toolName: kind,
    // clean_browser 在闸门里按 "browser" 判（judge 第 7 条只认 logged_browser / browser）；
    // 账本仍记 clean_browser，两只手的步骤不会混。
    gateTool: kind === "clean_browser" ? "browser" : "logged_browser",
    normalize: (req) => normalizeBrowserAction(req.action),
    badActionText: BROWSER_ACTION_HELP,

    prepare(deps, task, _action, _req) {
      const settled = settleCaptchaQuestion(task);
      if (settled === "stop") {
        return {
          ok: false,
          code: "human_required",
          text: "验证码确认单里你选了「停下」：手不再自动继续。要接着做请重新派任务。",
        };
      }
      return { ok: true, ctx: { client, currentUrl: state.currentUrl, taskId: task.id } };
    },

    gateInput(action, req, ctx) {
      const params = asRecord(req.params);
      const target = firstString(params["url"], params["selector"], params["ref"], params["element"], ctx.currentUrl ?? undefined);
      const reversible = !looksLikeSubmit(action as BrowserAction, params);
      return {
        tool: kind === "clean_browser" ? "browser" : "logged_browser",
        action,
        args: { ...params, reversible },
        target,
        reversible,
      };
    },

    /**
     * 2026-11-27：navigate 之前先看协议。此前模型想读本地文件会调 browser_navigate 打开
     * `file://...` / 盘符路径，MCP 报错又被算成写类失败（致命），一个用错的手把整个任务判死
     * （waihu 任务 task_2197… 实测两次，34 步跑完仍 failed）。
     * 这里直接拒，并且不记账——和 bad_action 同口径，模型能换个手重试。
     */
    validate(action, req) {
      if (action !== "navigate") return null;
      const raw = asRecord(req.params)["url"];
      if (typeof raw !== "string" || raw.trim() === "") return null;
      const url = raw.trim();
      if (/^https?:\/\//i.test(url)) return null;
      return {
        code: "bad_action",
        text:
          `浏览器的 navigate 只开 http(s) 网址，打不开「${url.slice(0, 80)}」。` +
          "本地文件用 files 手的 read（工作区相对路径）或 glob/grep 找，不要用浏览器打开 file:// 或盘符路径。",
      };
    },

    subjectParams(action, req, ctx) {
      // 验证码交接之后，同一条提交要重新出一张卡（「提交前若人工接过手再问一次」）：
      // 把交接轮次放进主题键，旧卡不会自动复用到新的一轮。
      const epoch = ctx.taskId === null ? 0 : (handoffEpochs.get(ctx.taskId) ?? 0);
      return {
        action,
        params: filterBrowserParams(action as BrowserAction, req.params),
        ...(epoch > 0 ? { handoff_epoch: epoch } : {}),
      };
    },

    snapshotTarget() {
      // 页面状态没法「复制回去」：浏览器快照本轮不实现（账本的 kind="browser" 先留着）。
      return null;
    },

    async act(action, req, ctx): Promise<HandActResult> {
      const browserAction = action as BrowserAction;
      const mcpName = BROWSER_TOOL_MAP[browserAction];
      const params = filterBrowserParams(browserAction, req.params);
      const res = await ctx.client.callTool(mcpName, params);
      if (!res.ok) throw new BrowserMcpError(`${mcpName} 调用失败：${res.detail}`);

      const body = toolResultText(res.result).trim();
      if (browserAction === "navigate" && typeof params["url"] === "string") {
        state.currentUrl = params["url"];
      }
      const foundUrl = extractUrl(body);
      if (foundUrl !== null) state.currentUrl = foundUrl;

      const head = `浏览器动作 ${action}（${mcpName}）完成`;
      return {
        data: { action, tool: mcpName, params, result: res.result },
        summary: body === "" ? head : `${head}：${body.slice(0, 2000)}`,
      };
    },

    errorCode(err) {
      return err instanceof BrowserMcpError ? err.code : "unexpected";
    },

    async afterAct(deps, task, action, req, _ctx, result) {
      // 每个动作的返回正文都扫（navigate/fill 的正文也可能带验证码字样），
      // 不只看 snapshot/screenshot。
      const body = toolResultText((result.data as Record<string, unknown> | null)?.["result"]).trim();
      const hit = hitCaptchaKeyword(body, keywords);
      if (hit === null) return null;

      const url = state.currentUrl ?? firstString(asRecord(req.params)["url"]) ?? "（未知地址）";
      const seen = (captchaCounts.get(task.id) ?? 0) + 1;
      captchaCounts.set(task.id, seen);
      handoffEpochs.set(task.id, (handoffEpochs.get(task.id) ?? 0) + 1);
      const reason = `页面出现验证码/人机验证（命中「${hit}」）`;

      if (seen <= MAX_CAPTCHA_HANDOFFS) {
        try {
          setTaskState(deps.db, task.id, "paused", {
            reason,
            blocked_on: { type: "human", reason },
          });
        } catch (err) {
          log("warn", `标记任务暂停失败：${(err as Error).message}`);
        }
        return {
          code: "captcha_handoff",
          text:
            `${reason}，手停下交还人手（第 ${seen}/${MAX_CAPTCHA_HANDOFFS} 次）。当前地址：${url}。` +
            `这一步只做了 ${action}，没有点任何东西；任务已挂到「等人」，请本人处理验证码后再继续。`,
        };
      }

      // 第 3 次起不再默默挂起：先问「还要不要继续」，别再让模型自己猜着点。
      const subjectKey = computeSubjectKey(task.id, kind, { captcha_continue: true });
      const created = createApproval(deps.db, {
        taskId: task.id,
        tool: kind,
        args: { action, reason: "captcha_third", url },
        tier: 4,
        kind: "question",
        title: `验证码已交还 ${MAX_CAPTCHA_HANDOFFS} 次：还要继续吗？`,
        detail: {
          question:
            `「${hit}」已经出现第 ${seen} 次（当前地址 ${url}）。` +
            "继续会自动再试一轮，停下手会挂起等你。",
          options: ["继续", "停下"],
          detail: `任务：${task.intent}\n工具：${kind}/${action}\n地址：${url}`,
        },
        ttlMs: deps.config.approvals.ttl_hours * 3600 * 1000,
        subjectKey,
      });
      const row = created.approval;
      const question = `验证码第 ${seen} 次：等确认是否继续（#${row.id}）`;
      try {
        setTaskState(deps.db, task.id, "awaiting_approval", {
          reason: question,
          blocked_on: { type: "human", reason: question, approval_ids: [row.id] },
        });
      } catch (err) {
        log("warn", `标记任务等待失败：${(err as Error).message}`);
      }
      if (!created.reused && deps.notify !== undefined) {
        try {
          const sent = await deps.notify(row.id);
          log(sent.ok ? "info" : "warn", `验证码确认单 #${row.id} 转发：${sent.detail}`);
        } catch (err) {
          log("warn", `验证码确认单 #${row.id} 转发失败：${(err as Error).message}`);
        }
      }
      return {
        code: "awaiting_approval",
        text:
          `验证码已经交还 ${MAX_CAPTCHA_HANDOFFS} 次，这次先不自动继续：已出确认单 #${row.id}（${row.status}）。` +
          `当前地址：${url}。确认「继续」后再调用同一动作。`,
        approvalId: row.id,
      };
    },

    approvalCard(action, req, _ctx, task, verdict) {
      const params = filterBrowserParams(action as BrowserAction, req.params);
      return {
        args: { action, params },
        title: `浏览器操作需要批准：${action}`,
        detail: {
          question: `允许这一步吗：${verdict.reason}`,
          options: ["同意", "拒绝"],
          detail:
            `${task.intent}\n工具：${kind}/${action}（Playwright MCP ${BROWSER_TOOL_MAP[action as BrowserAction]}）` +
            `\n地址：${url}\n参数：${JSON.stringify(params).slice(0, 800)}`,
        },
      };
    },

    stepArgs(action, req, _ctx, extra) {
      return {
        tool: kind,
        action,
        params: filterBrowserParams(action as BrowserAction, req.params),
        mcp_url: url,
        task_id: extra.taskId,
        approval_id: extra.approvalId,
        snapshot: extra.verdict.handling === "snapshot" ? "planned" : "not_required",
      };
    },

    resultArtifact(action, req, _ctx, extra) {
      return {
        ok: true,
        tool: kind,
        action,
        params: filterBrowserParams(action as BrowserAction, req.params),
        data: extra.data,
        snapshot: extra.snapshotRef !== null ? "created" : "not_required",
        approval_id: extra.approvalId,
      };
    },

    lockResource() {
      return kind === "logged_browser" ? "hand:logged_browser" : "hand:clean_browser";
    },
  };

  return {
    kind,
    mcpUrl: url,
    profile,
    client,
    run: (req: HandRequest) => runHandShell(deps, req, spec),
  };
}
