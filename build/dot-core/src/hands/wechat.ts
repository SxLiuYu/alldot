/**
 * src/hands/wechat.ts —— 微信手：把 wechat-mcp 的 9 个工具映射成一只手的动作。
 *
 * 为什么是「一只新手」而不是让工人直接调 MCP：工人的工具表只有手（七步壳：身份 →
 * 任务 → 闸门 → 审批 → 执行 → 快照 → 记账）。发消息属于不可逆的人级动作，必须过闸门
 * 出请示卡；直接放开 MCP 等于绕过整套治理。
 *
 * 服务端：D:/项目/wechat-mcp/wechat_mcp_http.py（streamable-HTTP，默认 8933）。
 * 那边的 stdio 入口还留给别的客户端，这里只走 HTTP。
 *
 * 两个要说清的限制（都是 wechat-mcp 自己的性质，不是我们没做）：
 * 1. 它靠 UIA + 切桌面操作真实微信窗口。微信没开、窗口被最小化到别的桌面时，
 *    读得到但可能点不到；失败会如实回「干不了」，不会假装发出去。
 * 2. 发送不是「幂等」的。所以 send/commit 一律 unknown 副作用 → 第 5 档，必须人点。
 */

import type { GateInput, TierVerdict } from "../gate/types.ts";
import { McpHttpClient, toolResultText, type McpTransport } from "../mcp/client.ts";
import type { HandDeps, HandOutcome, HandPrepareResult, HandRequest, HandSpec } from "./hand.ts";
import { runHandShell } from "./hand.ts";

export const WECHAT_TOOL_NAME = "wechat";

export const WECHAT_ACTIONS = [
  "status",
  "list",
  "messages",
  "read",
  "open",
  "send",
  "commit",
  "screenshot",
] as const;

export type WechatAction = (typeof WECHAT_ACTIONS)[number];

/** 只读动作：不碰微信状态、不写入。 */
export const WECHAT_READONLY_ACTIONS: readonly WechatAction[] = Object.freeze([
  "status",
  "list",
  "messages",
  "read",
  "screenshot",
]);

/** 动作 → wechat-mcp 的工具名。 */
export const WECHAT_TOOL_MAP: Readonly<Record<WechatAction, string>> = Object.freeze({
  status: "wx_status",
  list: "wx_sessions",
  messages: "wx_messages",
  read: "wx_read_conversation",
  open: "wx_open",
  send: "wx_send",
  commit: "wx_commit",
  screenshot: "wx_shot",
});

export const WECHAT_ACTION_HELP =
  "微信只认这些动作：list（会话列表，最常用）/ messages（当前会话正文）/ " +
  "read（按名字读某个会话）/ open（按名字打开会话）/ send（发文字，要 text；可选 to）/ " +
  "commit（把输入框里现成的草稿发出去）/ screenshot（截微信窗口）/ " +
  "status（微信在哪、窗口多大，排错才用；实测 150 秒，别当第一步）";

/**
 * 微信这只手的 MCP 超时。
 *
 * 默认值 20 秒不够：实测 wx_status 要 **150 秒**（它会把每个桌面都翻一遍找微信窗口），
 * wx_shot 也要切桌面。列表 / 读正文 / 发消息都在 100 毫秒级，所以按最慢的那个给。
 * 派发器的单会话上限是 600 秒（config.dispatch.session_timeout_ms），这里留足余量。
 */
export const WECHAT_TIMEOUT_MS = 180_000;


export function normalizeWechatAction(action: unknown): WechatAction | null {
  const a = typeof action === "string" ? action.trim().toLowerCase() : "";
  if (a === "") return null;
  const alias: Record<string, WechatAction> = {
    status: "status",
    info: "status",
    list: "list",
    sessions: "list",
    session_list: "list",
    messages: "messages",
    msg: "messages",
    read: "read",
    read_conversation: "read",
    conversation: "read",
    open: "open",
    switch: "open",
    send: "send",
    message: "send",
    commit: "commit",
    flush: "commit",
    screenshot: "screenshot",
    shot: "screenshot",
  };
  return alias[a] ?? null;
}

export function isWechatReadOnly(action: string): boolean {
  return (WECHAT_READONLY_ACTIONS as readonly string[]).includes(action);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function intOf(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 动作参数白名单裁剪：只把 wechat-mcp 认识的键递过去。 */
export function filterWechatParams(
  action: WechatAction,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const p = raw ?? {};
  switch (action) {
    case "list":
    case "messages":
      return { limit: intOf(p["limit"], 15) };
    case "read": {
      const out: Record<string, unknown> = { limit: intOf(p["limit"], 12) };
      const name = textOf(p["name"]) ?? textOf(p["to"]) ?? textOf(p["conversation"]);
      if (name !== undefined) out["name"] = name;
      return out;
    }
    case "open": {
      const name = textOf(p["name"]) ?? textOf(p["to"]) ?? textOf(p["conversation"]);
      return name === undefined ? {} : { name };
    }
    case "send": {
      const out: Record<string, unknown> = {};
      const text = textOf(p["text"]) ?? textOf(p["message"]);
      if (text !== undefined) out["text"] = text;
      const to = textOf(p["to"]) ?? textOf(p["name"]);
      if (to !== undefined) out["to"] = to;
      if (p["dry_run"] === true) out["dry_run"] = true;
      return out;
    }
    default:
      return {};
  }
}

/** 只读动作的取数要东西：send 没 text、read 没名字，都该在动手前就拒。 */
export function validateWechatRequest(
  action: WechatAction,
  params: Record<string, unknown>,
): { code: string; text: string } | null {
  if (action === "send" && typeof params["text"] !== "string") {
    return { code: "missing_text", text: "send 要 text（发什么内容）" };
  }
  if (action === "read" && typeof params["name"] !== "string") {
    return { code: "missing_name", text: "read 要 name（会话名，例如「文件传输助手」）" };
  }
  if (action === "open" && typeof params["name"] !== "string") {
    return { code: "missing_name", text: "open 要 name（会话名）" };
  }
  return null;
}

/** 微信 MCP 这边的错误（壳会把它记成这一步的 error 码）。 */
class WechatMcpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WechatMcpError";
    this.code = code;
  }
}

interface WechatContext {
  client: McpHttpClient;
  action: WechatAction;
  params: Record<string, unknown>;
  taskId: string;
}

export interface WechatHandOptions {
  mcpUrl?: string;
  transport?: McpTransport;
  timeoutMs?: number;
  client?: McpHttpClient;
}

export interface WechatHand {
  run(req: HandRequest): Promise<HandOutcome>;
  readonly mcpUrl: string;
  readonly client: McpHttpClient;
}

export function createWechatHand(deps: HandDeps, opts: WechatHandOptions = {}): WechatHand {
  const url = opts.client !== undefined ? "（注入的客户端）" : (opts.mcpUrl ?? deps.config.wechat.mcp_url);
  const client =
    opts.client ??
    new McpHttpClient({
      url: opts.mcpUrl ?? deps.config.wechat.mcp_url,
      transport: opts.transport,
      timeoutMs: opts.timeoutMs ?? WECHAT_TIMEOUT_MS,
    });

  const spec: HandSpec<WechatContext> = {
    toolName: WECHAT_TOOL_NAME,
    gateTool: WECHAT_TOOL_NAME,
    normalize: (req) => normalizeWechatAction(req.action),
    badActionText: WECHAT_ACTION_HELP,

    prepare(_deps, task, action, req): HandPrepareResult<WechatContext> {
      const typed = action as WechatAction;
      const params = filterWechatParams(typed, asRecord(req.params));
      const bad = validateWechatRequest(typed, params);
      if (bad !== null) return { ok: false, code: "bad_action", text: bad.text };
      return { ok: true, ctx: { client, action: typed, params, taskId: task.id } };
    },

    gateInput(action, _req, ctx): GateInput {
      // side_effect 显式给：只读 safe、open replayable、send/commit unknown（要人点）。
      const typed = action as WechatAction;
      const sideEffect = isWechatReadOnly(typed) ? "safe" : typed === "open" ? "replayable" : "unknown";
      return {
        tool: WECHAT_TOOL_NAME,
        action: typed,
        args: { action: typed, side_effect: sideEffect, ...ctx.params },
      };
    },

    adjustVerdict(verdict: TierVerdict, action): TierVerdict {
      // 只读动作最多 1 档；判高了就压回来（闸门对不认识的工具会保守抬高）。
      if (isWechatReadOnly(action) && verdict.tier > 1) {
        return {
          tier: 1,
          rule: "wechat_readonly",
          reason: `微信只读动作（${action}）`,
          handling: "allow",
          sideEffect: "safe",
          judgeNeeded: false,
        };
      }
      return verdict;
    },

    subjectParams(_action, _req, ctx) {
      return ctx.params;
    },

    snapshotTarget() {
      // 微信的东西不在文件系统里，没有可拍的目标；审计靠步骤参数 + 结果正文。
      return null;
    },

    async act(_action, _req, ctx) {
      const tool = WECHAT_TOOL_MAP[ctx.action];
      const res = await client.callTool(tool, ctx.params);
      if (!res.ok) {
        // 抛出去让壳把这一步标 failed 并记错误码；不要把失败吞成「成功但没正文」。
        throw new WechatMcpError("mcp_failed", `微信 MCP 调不动 ${tool}：${res.detail}`);
      }
      const text = toolResultText(res.result);
      return {
        summary: text === "" ? `${ctx.action} 完成（微信没回正文）` : text,
        data: { action: ctx.action, tool, params: ctx.params, text: text.slice(0, 4000) },
      };
    },

    approvalCard(action, _req, ctx, task, verdict) {
      return {
        args: { action, params: ctx.params },
        title: `微信操作需要批准：${action}`,
        detail: {
          question: `允许这一步吗：${verdict.reason}`,
          options: ["同意", "拒绝"],
          detail:
            `${task.intent}\n工具：wechat/${action}（${WECHAT_TOOL_MAP[ctx.action]}）` +
            `\n参数：${JSON.stringify(ctx.params).slice(0, 800)}`,
        },
      };
    },

    stepArgs(action, _req, ctx, extra) {
      return {
        tool: WECHAT_TOOL_NAME,
        action,
        params: ctx.params,
        task_id: extra.taskId,
        approval_id: extra.approvalId,
      };
    },

    errorCode(err) {
      return err instanceof WechatMcpError ? err.code : "unexpected";
    },

    resultArtifact(action, _req, ctx, extra) {
      return { ok: true, tool: WECHAT_TOOL_NAME, action, params: ctx.params, data: extra.data };
    },

    lockResource() {
      // 微信是单实例的界面：同一时刻只能有一个任务在动它。
      return "hand:wechat";
    },
  };

  return {
    mcpUrl: url,
    client,
    run: (req: HandRequest) => runHandShell(deps, req, spec),
  };
}
