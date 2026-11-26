/**
 * src/bridge/notify.ts —— 通知转发（A.6、A.1、A.9）。
 *
 * 链路（A.6:650）：
 *   dot-core（闸门建 approvals）→ 桥 8799 的 POST /notify
 *   → ds-bot 对外接口 8797 的 MCP 工具 `send_to_bot`
 *   → 总管收到指令消息 → 用 ask_user 原样向你提问。
 *
 * 两个方向都在这个文件里：
 * - `BridgeNotifyClient`：dot-core 侧调 8799（带桥 token）；
 * - `DsBotNotifier`：桥侧调 8797。
 *
 * 真实契约（本轮亲读 `C:/Users/1/.dsh/profiles/desktop/node_modules/ds-bot/src/host/mcp-server.js`）：
 * `send_to_bot` 的 `arguments` 必填 `{bot, text}`（:44-51），派发走 `send(findBot(args.bot).id, ...)`
 * （:193），找不到 bot 就 throw `No Bot "<key>" for this client. Call list_bots.`（:116-122），
 * 工具层的 throw 被包成 HTTP 200 的 `{result:{isError:true, content:[...]}}`（:268-276）。
 * 因此这里必须显式带 `bot`，并把 `result.isError` 当失败；只看 HTTP 码和 `rec.error` 会把
 * 8797 的拒绝当成成功。失败除回 502 外，还落一条错误记录到 dot 目录下的
 * `state/notify-errors.jsonl`（只写 build 运行时目录，不动 ~/.dsh/）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ApprovalRow } from "../ledger/index.ts";

/** 8797 的 send_to_bot 目标；默认传总管（Chief）的 id，可由 --dsbot-bot 覆盖。 */
export const DEFAULT_DSBOT_BOT = "session-ba4b0b67-d23e-4bf8-b7a6-d1b054e55ef5";

/** 通知失败记录落这里（dot 目录下，桥运行时自己写，不进账本）。 */
export const DEFAULT_NOTIFY_ERROR_PATH = join("state", "notify-errors.jsonl");

/**
 * 发件箱（2026-11-26 加）：每张请示卡无论 8797 通不通都落一行，`delivered` 说明送到哪：
 * - "dsbot"：真的转给了 ds-bot；
 * - "local"：只在发件箱里（ds-bot 没开），用户在自己的 exe 里能看到这条待批。
 * 审计结论「11 条全失败、0 成功、没人知道」就是没有这份底账造成的。
 */
export const DEFAULT_NOTIFY_OUTBOX_PATH = join("state", "notify-outbox.jsonl");

export interface ApprovalNotice {
  approvalId: string;
  taskId: string | null;
  title: string;
  question: string;
  options: string[];
  /** 发给总管的指令消息（含审批 id 与逐字问题/选项）。 */
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseDetail(detailJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(detailJson) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

/** 从 approvals 行渲染给总管的指令消息。question/options 保持账本原文。 */
export function buildApprovalNotice(row: Pick<ApprovalRow, "id" | "task_id" | "title" | "detail_json" | "tier">): ApprovalNotice {
  const detail = parseDetail(row.detail_json);
  const question =
    typeof detail.question === "string" && detail.question.trim() !== ""
      ? detail.question
      : row.title;
  const rawOptions = Array.isArray(detail.options)
    ? detail.options.filter((o): o is string => typeof o === "string" && o.trim() !== "")
    : [];
  const options = rawOptions.length > 0 ? rawOptions : ["同意", "拒绝"];
  const numbered = options.map((o, i) => `${i + 1}) ${o}`).join("  ");
  const text = [
    `[dot 审批] 批单 ${row.id}（第 ${row.tier} 档）：${row.title}`,
    `问题：${question}`,
    `选项：${numbered}`,
    `请用 ask_user 原样提问，选项文字不要改。用户答复后调 brain_answer(approval_id="${row.id}", answer=<用户原话>)。`,
  ].join("\n");
  return { approvalId: row.id, taskId: row.task_id, title: row.title, question, options, text };
}

/** 请示卡里给人看的正文（表头 + 问题 + 选项）与机器指令的分界。 */
export const APPROVAL_INSTRUCTION_PREFIX = "请用 ask_user";

/**
 * 把请示卡正文拆成「给人看的部分」与「给总管看的指令」。
 * 说人话改写只碰前者，后者（含 brain_answer 调用格式）逐字不动。
 */
export function splitApprovalText(text: string): { display: string; instruction: string | null } {
  const marker = `\n${APPROVAL_INSTRUCTION_PREFIX}`;
  const at = text.indexOf(marker);
  if (at < 0) return { display: text, instruction: null };
  return { display: text.slice(0, at), instruction: text.slice(at + 1) };
}

/** splitApprovalText 的逆操作；instruction 为 null 时原样返回 display。 */
export function joinApprovalText(display: string, instruction: string | null): string {
  return instruction === null ? display : `${display}\n${instruction}`;
}

export interface NotifyResult {
  ok: boolean;
  detail: string;
  raw?: unknown;
}

export interface Notifier {
  send(notice: ApprovalNotice): Promise<NotifyResult>;
}

export interface DsBotNotifierOptions {
  /** 默认 http://127.0.0.1:8797（ds-bot 自带对外接口，A.6 原文）。 */
  baseUrl?: string;
  /** 令牌发放方式未验证（S0-8）；给了就放 Authorization: Bearer。 */
  token?: string | null;
  /**
   * send_to_bot 必填的 bot（mcp-server.js:44-51）：id 或名字。
   * 默认总管 Chief 的 id；可通过 --dsbot-bot 配置。空串会被 8797 拒，桥必须报失败。
   */
  bot?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * 失败记录路径。不传（undefined）= 不落盘；传 null 同样不落盘。
   * 桥服务在 server.ts 里注入 `<dotDir>/state/notify-errors.jsonl`；
   * 单独 new DsBotNotifier 的调用方要落盘必须自己显式传路径。
   */
  errorLogPath?: string | null;
}

/** 从 MCP 的 result/content 里取出 8797 的原话；兼容 text 是 JSON 或纯文本。 */
function contentText(content: unknown): string {
  const items = Array.isArray(content) ? content : [];
  const parts = items.flatMap((item) => {
    const rec = asRecord(item);
    return typeof rec?.text === "string" && rec.text.trim() !== "" ? [rec.text] : [];
  });
  return parts.join(" ").slice(0, 1000);
}

export class DsBotNotifier implements Notifier {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly bot: string;
  readonly errorLogPath: string | null;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DsBotNotifierOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8797").replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.bot = opts.bot ?? DEFAULT_DSBOT_BOT;
    this.errorLogPath = opts.errorLogPath === undefined ? null : opts.errorLogPath;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 失败落一条 JSON 行；写盘失败不覆盖原始 HTTP/协议错误。 */
  private logFailure(notice: ApprovalNotice, kind: string, detail: string, raw: unknown): void {
    if (this.errorLogPath === null) return;
    try {
      mkdirSync(dirname(this.errorLogPath), { recursive: true });
      appendFileSync(
        this.errorLogPath,
        `${JSON.stringify({
          time: new Date().toISOString(),
          ok: false,
          kind,
          approval_id: notice.approvalId,
          bot: this.bot,
          detail,
          raw: raw ?? null,
        })}\n`,
        "utf8",
      );
    } catch {
      // 落盘失败不该改结论：调用方仍拿到原先的失败原因。
    }
  }

  async send(notice: ApprovalNotice): Promise<NotifyResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.token !== null) headers.Authorization = `Bearer ${this.token}`;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_to_bot",
        // 真实契约：bot/text 都必填（mcp-server.js:44-51, :193）。
        // approval_id/question/options 只是卡片正文的一部分，不是 send_to_bot 的入参。
        arguments: { bot: this.bot, text: notice.text },
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      const detail = `ds-bot 对外接口 8797 ${timedOut ? "超时" : "连不上"}：${e.message}`;
      this.logFailure(notice, "transport", detail, null);
      return { ok: false, detail, raw: null };
    }

    const text = await res.text();
    let value: unknown = null;
    try {
      value = text.trim() === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      value = null;
    }
    const rec = asRecord(value);
    const result = asRecord(rec?.result);
    if (!res.ok) {
      const message = typeof rec?.error === "string" ? rec.error : text.slice(0, 300) || `HTTP ${res.status}`;
      const detail = `8797 回了 HTTP ${res.status}：${message}`;
      this.logFailure(notice, `http_${res.status}`, detail, value);
      return { ok: false, detail, raw: value };
    }
    if (rec !== null && rec.error !== undefined) {
      const errObj = asRecord(rec.error);
      const message = typeof errObj?.message === "string" ? errObj.message : JSON.stringify(rec.error);
      const detail = `8797 的 JSON-RPC 错误：${message}`;
      this.logFailure(notice, "jsonrpc_error", detail, value);
      return { ok: false, detail, raw: value };
    }
    // 关键：mcp-server.js:268-276 把工具异常包成 HTTP 200 的 result.isError。
    // 只看 HTTP 码与顶层 error 会把「No Bot ... Call list_bots.」当成成功。
    if (result !== null && result.isError === true) {
      const message = contentText(result.content);
      const detail = `8797 的 send_to_bot 失败：${message || "工具报告 isError，没给原话"}`;
      this.logFailure(notice, "tool_isError", detail, value);
      return { ok: false, detail, raw: value };
    }
    return {
      ok: true,
      detail: `已转给 ds-bot（send_to_bot → ${this.bot}）`,
      raw: value,
    };
  }
}

export interface BridgeNotifyClientOptions {
  baseUrl?: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** dot-core 侧：把一张请示卡交给桥。桥再转 8797。 */
export class BridgeNotifyClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BridgeNotifyClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 6000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async notify(approvalId: string): Promise<NotifyResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "x-dot-bridge-token": this.token,
        },
        body: JSON.stringify({ approval_id: approvalId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { ok: false, detail: `桥 8799 连不上：${(err as Error).message}` };
    }
    const text = await res.text();
    let value: unknown = null;
    try {
      value = text.trim() === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      value = null;
    }
    const rec = asRecord(value);
    if (!res.ok) {
      const message = typeof rec?.message === "string" ? rec.message : text.slice(0, 300) || `HTTP ${res.status}`;
      return { ok: false, detail: `桥回了 HTTP ${res.status}：${message}`, raw: value };
    }
    return { ok: true, detail: typeof rec?.detail === "string" ? rec.detail : "已交给桥转发", raw: value };
  }
}
