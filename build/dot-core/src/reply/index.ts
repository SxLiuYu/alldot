/**
 * src/reply/index.ts —— 「只回答、不派活」的只回答通道（brain_reply 的大脑一侧）。
 *
 * 和工人（src/dispatch/local-worker.ts）共用同一个模型池，但语义完全不同：
 *   - 只调一次模型，tools 恒为空数组，不建任务、不写 tasks / steps / approvals / milestones；
 *   - 成功时只写两处账：spend_ledger 一行（task_id=NULL、worker_id='bridge-reply'）
 *     与 events 里的 spend_recorded（recordSpend 内写）+ reply_answered（这里写）；
 *   - 失败/超时不记账（拿不到 usage），只在 dot-core 日志留一行 warn；
 *   - 永不抛（返回 ReplyOutcome），调用方（bridge/routes.ts）只管按 status 回 HTTP。
 *
 * 文案唯一生成器：replyErrorMessage()。routes 的校验错误与模型错误都从这里取字，
 * 别在别处另抄一份。
 */

import { createHash } from "node:crypto";

import { appendEvent, recordSpend, type LedgerDb } from "../ledger/index.ts";
import {
  DEFAULT_MODEL,
  ModelPoolError,
  type ModelComplete,
  type ModelTurn,
  type WorkerMessage,
} from "../dispatch/local-worker.ts";

/** 模型 fetch 中止点，也是文案里的秒数（两者必须一致）。 */
export const REPLY_TIMEOUT_MS = 55_000;
/** 回答长度上限：默认 500，允许 40..2000。 */
export const REPLY_DEFAULT_MAX_CHARS = 500;
export const REPLY_MIN_MAX_CHARS = 40;
export const REPLY_MAX_MAX_CHARS = 2000;
/** 上文上限。 */
export const REPLY_MAX_CONTEXT_CHARS = 4000;
/** intent 上限。 */
export const REPLY_MAX_INTENT_CHARS = 2000;

export interface ReplyInput {
  intent: string;
  context?: string;
  maxChars: number;
  via: string;
}

export type ReplyErrorCode =
  | "model_unavailable"
  | "model_failed"
  | "model_invalid"
  | "model_empty"
  | "model_timeout";

/** routes 自己的校验错误码，文案同样出自 replyErrorMessage()。 */
export type ReplyRouteErrorCode = "bad_intent" | "bad_context" | "bad_max_chars" | "bad_via" | "reply_not_wired";

export type ReplyAnyErrorCode = ReplyErrorCode | ReplyRouteErrorCode;

export type ReplyOutcome =
  | {
      ok: true;
      reply: string;
      model: string | null;
      usage: { input_tokens: number; output_tokens: number };
      spend_id: string;
      event_seq: number | null;
      elapsed_ms: number;
      truncated: boolean;
    }
  | { ok: false; error: ReplyErrorCode; message: string; status: number; elapsed_ms: number };

/** 永不抛。 */
export type ReplyFn = (input: ReplyInput) => Promise<ReplyOutcome>;

/**
 * 文案唯一生成器（C 表逐字）。status 是**模型池实际回的 HTTP**（不是本通道返回的 502）。
 * model_failed 文案里要写模型池的状态码，所以单独用 status 参数传。
 */
export function replyErrorMessage(code: ReplyAnyErrorCode, detail?: string, status?: number): string {
  const withDetail = (prefix: string): string =>
    `${prefix}${detail !== undefined && detail !== "" ? `（${detail}）` : ""}。`;
  switch (code) {
    case "bad_intent":
      return "回答不了：intent 必填，且要是 ≤2000 字的非空字符串。";
    case "bad_context":
      return "回答不了：context 要是 ≤4000 字的字符串。";
    case "bad_max_chars":
      return "回答不了：max_chars 要是 40..2000 的整数。";
    case "bad_via":
      return "回答不了：via 只能是 1..32 位小写字母/数字/下划线/连字符。";
    case "reply_not_wired":
      return "回答不了：dot-core 没接模型，这条通道用不了。";
    case "model_unavailable":
      return withDetail("回答不了：模型池现在连不上") + "这次没记账，等它起来再问。";
    case "model_failed":
      return withDetail(`回答不了：模型池回了 HTTP ${status ?? "?"}`);
    case "model_invalid":
      return "回答不了：模型池回的内容读不懂，再试一次。";
    case "model_empty":
      return "回答不了：模型只思考没出正文，换个问法或稍后再试。";
    case "model_timeout":
      return `回答不了：模型 ${Math.round(REPLY_TIMEOUT_MS / 1000)} 秒没答完。`;
  }
}

/**
 * 只回答用的系统提示词。三件事：不建任务、不知道就说不知道、短。
 * 测试会逐字查「不要建任务」「不知道就说不知道」两句。
 */
export const REPLY_SYSTEM_PROMPT = [
  "你是 dot 的大脑，只回答用户问的这一句，直接给用户看。",
  "规矩：",
  "1) 不要建任务：不派活、不写任务、不调任何执行工具，只回答。",
  "2) 不知道就说不知道，不要编。",
  "3) 用人话短答，一两句能说清就别长篇。",
].join("\n");

function buildMessages(intent: string, context?: string): WorkerMessage[] {
  const user =
    context !== undefined && context.trim() !== ""
      ? `用户问：${intent}\n\n上文：\n${context}`
      : `用户问：${intent}`;
  return [
    { role: "system", content: REPLY_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

function cleanReply(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const text = raw.trim();
  if (text.length === 0) return { text: "", truncated: false };
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated: false };
}

interface Classified {
  code: ReplyErrorCode;
  /** 本通道返回的 HTTP 状态。 */
  status: number;
  /** model_failed 文案里的模型池状态码。 */
  messageStatus?: number;
  detail: string;
}

function classify(err: unknown): Classified {
  if (err instanceof ModelPoolError) {
    switch (err.kind) {
      case "config":
      case "unreachable":
        return { code: "model_unavailable", status: 503, detail: err.message };
      case "http": {
        const prefix = `模型池回了 ${err.status}：`;
        const detail = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
        return {
          code: "model_failed",
          status: 502,
          detail,
          ...(err.status === null ? {} : { messageStatus: err.status }),
        };
      }
      case "invalid":
        return { code: "model_invalid", status: 502, detail: err.message };
      case "timeout":
        return { code: "model_timeout", status: 504, detail: err.message };
    }
  }
  // 不是模型池的错，也按「模型调用失败」归，不编新码。
  return { code: "model_failed", status: 502, detail: err instanceof Error ? err.message : String(err) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ReplyServiceDeps {
  db: LedgerDb;
  complete: ModelComplete;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  now?: () => Date;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * 造一个只回答通道。永不抛：所有失败都折成 ReplyOutcome。
 * 记账只用 ledger 公开函数 recordSpend + appendEvent（不先 createTask 再 settle：
 * settle 会把零步骤判 failed(no_steps)）。
 */
export function createReplyService(deps: ReplyServiceDeps): ReplyFn {
  const model = deps.model ?? DEFAULT_MODEL;
  const log = deps.logger ?? (() => {});

  return async (input: ReplyInput): Promise<ReplyOutcome> => {
    const startedAt = Date.now();
    let turn: ModelTurn;
    try {
      turn = await deps.complete({ messages: buildMessages(input.intent, input.context), tools: [] });
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      const c = classify(err);
      const message = replyErrorMessage(c.code, c.detail, c.messageStatus);
      log("warn", `只回答通道失败（${c.code}，${elapsed}ms）：${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: c.code, message, status: c.status, elapsed_ms: elapsed };
    }

    const elapsed = Date.now() - startedAt;
    const cleaned = cleanReply(turn.text, input.maxChars);
    if (cleaned.text === "") {
      const message = replyErrorMessage("model_empty", turn.toolCalls.length > 0 ? "只有 tool_calls，没有正文" : undefined);
      log("warn", `只回答通道：模型没出正文（tool_calls=${turn.toolCalls.length}，${elapsed}ms）`);
      return { ok: false, error: "model_empty", message, status: 502, elapsed_ms: elapsed };
    }

    const usage = turn.usage ?? { input_tokens: 0, output_tokens: 0 };
    const usageMissing = turn.usage === undefined;

    // 只写 spend_ledger + events；task_id 恒为 NULL（recordSpend 对 null 不碰 tasks）。
    const spend = recordSpend(deps.db, {
      task_id: null,
      worker_id: "bridge-reply",
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
    });
    const event = appendEvent(deps.db, {
      type: "reply_answered",
      task_id: null,
      payload: {
        reply_id: spend.id,
        model,
        chars: cleaned.text.length,
        elapsed_ms: elapsed,
        truncated: cleaned.truncated,
        via: input.via,
        intent_sha256: sha256(input.intent),
        usage_missing: usageMissing,
      },
    });

    return {
      ok: true,
      reply: cleaned.text,
      model,
      usage,
      spend_id: spend.id,
      event_seq: event.seq,
      elapsed_ms: elapsed,
      truncated: cleaned.truncated,
    };
  };
}
