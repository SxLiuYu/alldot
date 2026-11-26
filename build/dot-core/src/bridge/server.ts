/**
 * src/bridge/server.ts —— 8799 上的独立小服务（B.6）。
 *
 * 路由（全部只听 127.0.0.1）：
 *   GET  /health             活着 + token/大脑/账本一句话
 *   GET  /                   只读状态页（恢复报告在最上面、任务、待批、组件红绿）
 *   GET  /artifact/<hash>    账本 artifacts 的明细全文（找不到回「已回收·原因」）
 *   POST /mcp                MCP streamable-http：brain_task/status/answer/cancel
 *   POST /notify             把请示卡转给 ds-bot 8797（A.6 的「通知转发」）
 *
 * 这一层**从不写账本**：账本只用 openLedger(readOnly) 打开（view.ts）。
 * 大脑掉线时状态页照常出：连不上标「大脑掉线（X 时起）」，
 * 18789 在但路由不在标「大脑插件没加载，手已停用」，token 被拒单独标。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  HttpError,
  isLoopbackAddress,
  parseRequestUrl,
  readJsonBody,
  sendEmpty,
  sendHtml,
  sendJson,
  sendText,
} from "./http.ts";
import { diskAdmission, readKeepState, type AdmissionDecision, type KeepView } from "./keep.ts";
import {
  handleMcpBody,
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  type McpContext,
} from "./mcp.ts";
import { buildApprovalNotice, DEFAULT_DSBOT_BOT, DEFAULT_NOTIFY_ERROR_PATH, DEFAULT_NOTIFY_OUTBOX_PATH, DsBotNotifier, joinApprovalText, splitApprovalText, type ApprovalNotice, type Notifier } from "./notify.ts";
import { renderStatusPage } from "./page.ts";
import { resolveDotPaths, type DotPathOptions, type DotPaths } from "./paths.ts";
import {
  GatewayTokenCache,
  TokenCache,
  tokenCookie,
  tokenFromRequest,
  tokensEqual,
  type TokenState,
} from "./token.ts";
import { admissionFromKeep, type BridgeToolContext } from "./tools.ts";
import {
  BrainClient,
  BrainHttpError,
  BrainUnavailableError,
  DEFAULT_TIMEOUT_MS,
} from "./upstream.ts";
import { readApproval, readArtifact, readLedgerView } from "./view.ts";
import type { SayRewrite } from "../say/index.ts";

export const BRIDGE_NAME = "dot-bridge";
export const BRIDGE_VERSION = "0.1.0";
export const DEFAULT_PORT = 8799;
export const DEFAULT_MIN_FREE_MB = 800;

export type BrainMode = "online" | "offline" | "route_missing" | "token_rejected" | "unknown";

export interface BridgeRuntimeState {
  startedAt: Date;
  /** null = 还没探过。 */
  brainOnline: boolean | null;
  brainMode: BrainMode;
  lastOkAt: Date | null;
  downSince: Date | null;
  lastError: string | null;
}

export interface BridgeServiceOptions {
  port?: number;
  host?: string;
  /** 路径覆盖（测试用临时目录）。 */
  pathOptions?: DotPathOptions;
  /** 直接给桥 token（测试/内嵌用）；不给就读 token 文件。 */
  token?: string | null;
  /** 直接给网关 token；不给就读 allbot.json 的 gateway.auth.token。 */
  gatewayToken?: string | null;
  upstreamBaseUrl?: string;
  upstreamTimeoutMs?: number;
  probeTimeoutMs?: number;
  minFreeMb?: number;
  version?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  logger?: (line: string) => void;
  /** ds-bot 对外接口（A.6:8797）。 */
  dsBotBaseUrl?: string;
  dsBotToken?: string | null;
  /** send_to_bot 的目标 bot（id 或名字）；默认总管 Chief 的 id。 */
  dsBotBot?: string | null;
  dsBotTimeoutMs?: number;
  /** 通知失败记录路径；默认 <dotDir>/state/notify-errors.jsonl，null 关掉。 */
  notifyErrorLogPath?: string | null;
  /** 发件箱路径；默认 <dotDir>/state/notify-outbox.jsonl，null 关掉。 */
  notifyOutboxPath?: string | null;
  /** 测试可注入假通知器。 */
  notifier?: Notifier;
  /**
   * 说人话改写（第 3 步 C）。**不传 = 请示卡逐字不动**；只有 config.say.enabled=true 时
   * dot-bridge 入口才注入。注入后只改「给人看的部分」，给总管的指令原样保留。
   */
  say?: SayRewrite;
}

export interface BridgeService {
  server: Server;
  state: BridgeRuntimeState;
  paths: DotPaths;
  /** start() 之前是 null。 */
  url: string | null;
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

export function createBridgeService(opts: BridgeServiceOptions = {}): BridgeService {
  const host = opts.host ?? "127.0.0.1";
  const paths = resolveDotPaths(opts.pathOptions ?? {});
  const version = opts.version ?? BRIDGE_VERSION;
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger ?? (() => {});
  const minFreeMb = opts.minFreeMb ?? DEFAULT_MIN_FREE_MB;
  const say = opts.say;
  const tokenCache = opts.token === undefined ? new TokenCache(paths.tokenPath) : null;
  const fixedToken: TokenState | null =
    opts.token === undefined
      ? null
      : {
          token: opts.token === null || opts.token === "" ? null : opts.token,
          path: paths.tokenPath,
          error: opts.token === null || opts.token === "" ? "显式给了空 token" : null,
        };
  const gatewayCache =
    opts.gatewayToken === undefined ? new GatewayTokenCache(paths.configPath) : null;
  const fixedGatewayToken: string | null | undefined = opts.gatewayToken;
  const notifier: Notifier =
    opts.notifier ??
    new DsBotNotifier({
      baseUrl: opts.dsBotBaseUrl,
      token: opts.dsBotToken ?? null,
      bot: opts.dsBotBot === undefined ? DEFAULT_DSBOT_BOT : opts.dsBotBot,
      timeoutMs: opts.dsBotTimeoutMs,
      fetchImpl: opts.fetchImpl,
      errorLogPath:
        opts.notifyErrorLogPath === undefined
          ? join(paths.dotDir, DEFAULT_NOTIFY_ERROR_PATH)
          : opts.notifyErrorLogPath,
    });

  /**
   * 发件箱：每张请示卡在 send 之后都落一行，`delivered` 说清送到了哪。
   * 放在桥这一层而不是通知器里，是因为通知器可以被测试或别的实现替换；
   * 而「这张卡到底有没有留下底账」必须对任何实现都成立（审计 G5：11 条全失败、0 成功、没人知道）。
   */
  const notifyOutboxPath: string | null =
    opts.notifyOutboxPath === undefined ? join(paths.dotDir, DEFAULT_NOTIFY_OUTBOX_PATH) : opts.notifyOutboxPath;

  function recordOutbox(notice: ApprovalNotice, ok: boolean, detail: string): void {
    if (notifyOutboxPath === null) return;
    try {
      mkdirSync(dirname(notifyOutboxPath), { recursive: true });
      appendFileSync(
        notifyOutboxPath,
        `${JSON.stringify({
          time: now().toISOString(),
          approval_id: notice.approvalId,
          task_id: notice.taskId,
          title: notice.title,
          question: notice.question,
          options: notice.options,
          delivered: ok ? "dsbot" : "local",
          detail,
        })}\n`,
        "utf8",
      );
    } catch {
      // 落盘失败不该改结论（和错误日志同一原则）。
    }
  }

  const state: BridgeRuntimeState = {
    startedAt: now(),
    brainOnline: null,
    brainMode: "unknown",
    lastOkAt: null,
    downSince: null,
    lastError: null,
  };

  let listeningPort = opts.port ?? DEFAULT_PORT;
  let actualPort = listeningPort;

  function currentToken(): TokenState {
    return fixedToken ?? (tokenCache as TokenCache).get();
  }

  function currentGatewayToken(): string | null {
    if (fixedGatewayToken !== undefined) return fixedGatewayToken;
    return (gatewayCache as GatewayTokenCache).get().token;
  }

  function clientFor(token: string): BrainClient {
    return new BrainClient({
      baseUrl: opts.upstreamBaseUrl,
      token,
      gatewayToken: currentGatewayToken(),
      timeoutMs: opts.upstreamTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  }

  async function probeBrain(token: string | null): Promise<void> {
    if (token === null) {
      state.brainOnline = false;
      state.brainMode = "offline";
      state.lastError = "桥 token 未配置，连大脑的请求发不出去";
      if (state.downSince === null) state.downSince = now();
      return;
    }
    try {
      await clientFor(token).probe(opts.probeTimeoutMs ?? 1500);
      state.brainOnline = true;
      state.brainMode = "online";
      state.lastOkAt = now();
      state.downSince = null;
      state.lastError = null;
    } catch (err) {
      state.brainOnline = false;
      if (err instanceof BrainHttpError) {
        if (err.status === 404) {
          state.brainMode = "route_missing";
          state.lastError = `dot-core 的 /dot/bridge/v1 路由不存在（18789 有应答）：${err.detail}`;
        } else if (err.status === 401 || err.status === 403) {
          state.brainMode = "token_rejected";
          state.lastError = `HTTP ${err.status}：${err.detail}`;
        } else {
          state.brainMode = "offline";
          state.lastError = `HTTP ${err.status}：${err.detail}`;
        }
      } else {
        state.brainMode = "offline";
        state.lastError = err instanceof BrainUnavailableError ? err.message : errorMessage(err);
      }
      if (state.downSince === null) state.downSince = now();
    }
  }

  function toolContext(token: string): BridgeToolContext {
    const readKeep = (): KeepView => readKeepState(paths.keepPath);
    return {
      client: clientFor(token),
      tokenConfigured: true,
      admission: admissionFromKeep(readKeep, minFreeMb),
      now,
      downSince: () => state.downSince,
    };
  }

  function rejectLockedDown(res: ServerResponse, tokenState: TokenState): void {
    sendJson(res, 503, {
      ok: false,
      error: "bridge_token_missing",
      message: `桥 token 没配置：${tokenState.path}。桥拒绝干活（除 /health 外全部 503）。`,
      path: tokenState.path,
      token: { configured: false, path: tokenState.path, error: tokenState.error },
    });
  }

  function handleHealth(res: ServerResponse, tokenState: TokenState, admission: AdmissionDecision): void {
    const tokenConfigured = tokenState.token !== null;
    // token 没配时回 503：keeper 只认「HTTP 成功」，200 + ok:false 会被它当绿（B.7 巡检表）。
    sendJson(res, tokenConfigured ? 200 : 503, {
      ok: tokenConfigured,
      name: BRIDGE_NAME,
      version,
      time: now().toISOString(),
      uptime_s: Math.max(0, Math.round((now().getTime() - state.startedAt.getTime()) / 1000)),
      token: { configured: tokenConfigured, path: tokenState.path, error: tokenState.error },
      brain: {
        online: state.brainOnline,
        mode: state.brainMode,
        last_ok_at: state.lastOkAt?.toISOString() ?? null,
        down_since: state.downSince?.toISOString() ?? null,
        error: state.lastError,
      },
      gateway: {
        configured: currentGatewayToken() !== null,
        path: paths.configPath,
      },
      ledger: { path: paths.ledgerPath },
      admission,
    });
  }

  async function handleStatusPage(
    res: ServerResponse,
    tokenState: TokenState,
    setCookie: boolean,
  ): Promise<void> {
    await probeBrain(tokenState.token);
    const generatedNow = now();
    const ledger = readLedgerView(paths.ledgerPath, { now: generatedNow });
    const keep = readKeepState(paths.keepPath);
    const html = renderStatusPage({
      now: generatedNow,
      ledger,
      keep,
      brain: {
        online: state.brainOnline === true,
        mode: state.brainOnline === true ? "online" : state.brainMode,
        downSince: state.downSince,
        lastOkAt: state.lastOkAt,
        error: state.lastError,
      },
      tokenConfigured: tokenState.token !== null,
      tokenPath: tokenState.path,
      port: actualPort,
      version,
    });
    if (setCookie && tokenState.token !== null) {
      res.setHeader("Set-Cookie", tokenCookie(tokenState.token));
    }
    sendHtml(res, 200, html);
  }

  function handleArtifact(res: ServerResponse, hash: string): void {
    const hit = readArtifact(paths.ledgerPath, hash);
    if (!hit.found) {
      if (hit.kind === "invalid_hash") {
        sendText(res, 400, hit.reason);
        return;
      }
      if (hit.kind === "ledger_unavailable") {
        sendText(res, 503, hit.reason);
        return;
      }
      const reason = hit.reason.startsWith("已回收") ? hit.reason : `已回收·原因：${hit.reason}`;
      sendText(res, 404, reason);
      return;
    }
    sendText(res, 200, hit.content, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Artifact-Created-At": hit.createdAt,
    });
  }

  /** 用户反馈：POST /feedback {"text": "...", "type": "bug|idea|other"} → 记进 feedback.jsonl。 */
  async function handleFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "请求体不是合法 JSON" });
      return;
    }
    const obj = (body !== null && typeof body === "object" && !Array.isArray(body)) ? body as Record<string, unknown> : {};
    const text = typeof obj["text"] === "string" ? obj["text"].trim() : "";
    const type = typeof obj["type"] === "string" ? obj["type"].trim() : "other";
    if (text === "") {
      sendJson(res, 400, { ok: false, error: "empty_text", message: "反馈内容不能为空" });
      return;
    }
    try {
      const feedbackPath = join(paths.ledgerPath, "..", "..", "feedback.jsonl");
      appendFileSync(feedbackPath, JSON.stringify({ ts: new Date().toISOString(), type, text: text.slice(0, 2000) }) + "\n", "utf8");
      sendJson(res, 200, { ok: true, message: "收到反馈，已记录。谢谢！" });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: "io_error", message: `记反馈失败：${(err as Error).message}` });
    }
  }

  async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = bodyRecord(await readJsonBody(req));
    const approvalId = optionalString(body.approval_id);
    const directText = optionalString(body.text);

    let notice: ApprovalNotice;
    if (approvalId !== undefined) {
      const row = readApproval(paths.ledgerPath, approvalId);
      if (row === null) {
        sendJson(res, 404, {
          ok: false,
          error: "approval_not_found",
          message: `账本里没有批单 ${approvalId}`,
        });
        return;
      }
      if (row.status !== "pending") {
        sendJson(res, 409, {
          ok: false,
          error: "approval_not_pending",
          message: `批单 ${approvalId} 已经是 ${row.status}，不再发请示卡`,
        });
        return;
      }
      notice = buildApprovalNotice(row);
      if (say !== undefined) {
        // 只改给人看的三行；「请用 ask_user … brain_answer(…)」那条指令逐字保留。
        const parts = splitApprovalText(notice.text);
        const rewritten = await say(parts.display).catch(() => parts.display);
        notice = { ...notice, text: joinApprovalText(rewritten, parts.instruction) };
      }
    } else if (directText !== undefined) {
      notice = {
        approvalId: "(notice)",
        taskId: optionalString(body.task_id) ?? null,
        title: optionalString(body.title) ?? "通知",
        question: directText,
        options: [],
        text: directText,
      };
    } else {
      sendJson(res, 400, {
        ok: false,
        error: "bad_notify",
        message: "要么给 approval_id（从账本渲染请示卡），要么给 text（直接一条通知）",
      });
      return;
    }

    const result = await notifier.send(notice);
    recordOutbox(notice, result.ok, result.detail);
    if (!result.ok) {
      // 2026-11-26 改：8797 不通不再等于「这张卡丢了」。DsBotNotifier 已把它写进
      // state/notify-outbox.jsonl（delivered=local），用户的 exe 审批页照样看得到这条待批。
      // 仍回 502，但把「本机留底了」说清楚，调用方不会误以为要重发。
      sendJson(res, 502, {
        ok: false,
        error: "dsbot_notify_failed",
        message: `${result.detail}（这张卡已写进本机发件箱，exe 的审批页能看到）`,
        delivered: "outbox",
        approval_id: approvalId ?? null,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      sent: true,
      approval_id: approvalId ?? null,
      mode: approvalId === undefined ? "text" : "approval",
      detail: result.detail,
      text: notice.text,
    });
  }

  async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    tokenState: TokenState,
  ): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "POST") {
      sendEmpty(res, method === "DELETE" ? 204 : 405, { Allow: "POST, DELETE" });
      return;
    }
    if (tokenState.token === null) {
      rejectLockedDown(res, tokenState);
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof HttpError && err.code === "body_too_large") {
        sendJson(res, 413, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: `请求体过大：${err.message}` },
        });
        return;
      }
      if (err instanceof HttpError && err.code === "bad_json") {
        sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      throw err;
    }

    const ctx: McpContext = { tools: toolContext(tokenState.token), version };
    const payload = await handleMcpBody(body, ctx);
    if (payload.body === null) {
      sendEmpty(res, 202);
      return;
    }
    const headers: Record<string, string> = { "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION };
    if (isInitializeRequest(body)) headers["Mcp-Session-Id"] = randomUUID();
    sendJson(res, payload.status, payload.body, headers);
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
        return;
      }
      logger(`[dot-bridge] 未处理错误：${errorMessage(err)}`);
      sendJson(res, 500, { ok: false, error: "internal_error", message: errorMessage(err) });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
      sendJson(res, 403, { ok: false, error: "loopback_only", message: "dot-bridge 只听 127.0.0.1" });
      return;
    }
    const url = parseRequestUrl(req);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const tokenState = currentToken();

    if (path === "/health") {
      const keep = readKeepState(paths.keepPath);
      handleHealth(res, tokenState, diskAdmission(keep, minFreeMb));
      return;
    }
    if (path === "/favicon.ico") {
      sendEmpty(res, 204);
      return;
    }

    if (tokenState.token === null) {
      rejectLockedDown(res, tokenState);
      return;
    }

    const presented = tokenFromRequest(req, url);
    if (!tokensEqual(presented, tokenState.token)) {
      sendJson(
        res,
        401,
        {
          ok: false,
          error: "unauthorized",
          message: "缺桥 token 或 token 不对（x-dot-bridge-token / Authorization: Bearer / ?token=）",
        },
        { "WWW-Authenticate": 'Bearer realm="dot-bridge"' },
      );
      return;
    }

    if (path === "/mcp") {
      await handleMcp(req, res, tokenState);
      return;
    }

    if (path === "/notify") {
      if (method !== "POST") {
        sendEmpty(res, 405, { Allow: "POST" });
        return;
      }
      await handleNotify(req, res);
      return;
    }

    if (path === "/feedback") {
      if (method !== "POST") {
        sendEmpty(res, 405, { Allow: "POST" });
        return;
      }
      await handleFeedback(req, res);
      return;
    }

    if (path === "/chat") {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { Allow: "GET" });
        return;
      }
      // Web 聊天界面
      const chatPath = new URL("./chat.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
      try {
        const html = readFileSync(chatPath, "utf8");
        sendHtml(res, 200, html);
      } catch {
        sendHtml(res, 404, "<h1>chat.html not found</h1>");
      }
      return;
    }

    if (path === "/") {
      if (method !== "GET" && method !== "HEAD") {
        sendEmpty(res, 405, { Allow: "GET" });
        return;
      }
      const cameFromQuery = url.searchParams.get("token") !== null;
      await handleStatusPage(res, tokenState, cameFromQuery);
      return;
    }

    if (path.startsWith("/artifact/")) {
      if (method !== "GET") {
        sendEmpty(res, 405, { Allow: "GET" });
        return;
      }
      let hash: string;
      try {
        hash = decodeURIComponent(path.slice("/artifact/".length));
      } catch {
        sendText(res, 400, "哈希解码失败");
        return;
      }
      handleArtifact(res, hash);
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found", message: `没有这个路由：${method} ${path}` });
  }

  return {
    server,
    state,
    paths,
    get url() {
      return listeningPort === 0 ? null : `http://${host}:${actualPort}`;
    },
    start(): Promise<{ port: number; url: string }> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.off("error", onError);
          const addr = server.address();
          if (addr !== null && typeof addr === "object") actualPort = addr.port;
          listeningPort = actualPort;
          const url = `http://${host}:${actualPort}`;
          logger(`[dot-bridge] listening on ${url}`);
          resolve({ port: actualPort, url });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(opts.port ?? DEFAULT_PORT, host);
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(err);
          else resolve();
        });
      });
    },
  };
}
