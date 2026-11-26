/**
 * src/mcp/client.ts —— 极简 streamable-HTTP MCP 客户端（B.6 的下行方向）。
 *
 * 只实现手会用到的那几条：initialize → notifications/initialized → tools/list →
 * tools/call（+ ping 不收）。不引第三方包：HTTP 用全局 fetch，SSE 自己解。
 *
 * 三条口径：
 * 1. 任何失败都变成 `{ ok:false, code, detail }`，**不抛到调用方**：
 *    手的第 6 步要能把「MCP 挂了」落成 failed 步骤，而不是让工具调用炸掉。
 * 2. 响应两种都要认：application/json 和 text/event-stream（`event: message` +
 *    `data: {...}`）。服务端可以混着用，按 Content-Type 判断，判不出来就看正文。
 * 3. initialize 只发一次：成功后所有请求复用 mcp-session-id；失败也记住原因，
 *    不反复重试（用户不在旁边，重试只会刷屏）。
 *
 * 可测性：构造参数能注入 transport（`{ post(body, headers) }`），测试不连真服务器。
 */

export type McpName = "desktop" | "logged_browser" | "clean_browser";

export interface McpHttpResponse {
  status: number;
  /** 键统一小写（实现方负责）。 */
  headers: Record<string, string>;
  body: string;
}

export interface McpTransport {
  post(body: string, headers: Record<string, string>): Promise<McpHttpResponse>;
}

export type McpOk<T> = { ok: true; result: T; sessionId: string | null };
export type McpFail = { ok: false; code: string; detail: string };
export type McpResult<T> = McpOk<T> | McpFail;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpHttpClientOptions {
  url: string;
  headers?: Record<string, string>;
  /** 默认 20 秒；只在用内置 fetch transport 时生效。 */
  timeoutMs?: number;
  /** 注入的传输层；不传就用 fetch。 */
  transport?: McpTransport;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PROTOCOL = "2025-06-18";

export function createFetchTransport(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): McpTransport {
  return {
    async post(body: string, headers: Record<string, string>): Promise<McpHttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
        const text = await res.text();
        const flat: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          flat[key.toLowerCase()] = value;
        });
        return { status: res.status, headers: flat, body: text };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === key && v !== "") return v;
  }
  return null;
}

/** HTTP 状态码 → 可读失败。2xx 返回 null。 */
function httpFailure(status: number): McpFail | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return { ok: false, code: "unauthorized", detail: "MCP 服务器返回 401：需要认证或 session 已失效" };
  if (status === 403) return { ok: false, code: "forbidden", detail: "MCP 服务器返回 403：没有权限" };
  if (status === 404) return { ok: false, code: "not_found", detail: "MCP 服务器返回 404：地址不对或服务器没起" };
  return { ok: false, code: `http_${status}`, detail: `MCP 服务器返回 HTTP ${status}` };
}

function failureFromError(err: unknown): McpFail {
  const name = (err as { name?: string } | null)?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || name === "TimeoutError" || /timed?\s*out|timeout/i.test(message)) {
    return { ok: false, code: "timeout", detail: `MCP 请求超时：${message || "没有在限定时间内返回"}` };
  }
  return { ok: false, code: "transport_error", detail: `MCP 请求失败：${message}` };
}

/**
 * 解 SSE 正文：按空行分事件，取 `data:` 行拼起来当 JSON。
 * 不是 SSE 的正文（普通 JSON）由调用方另走分支。
 */
export function parseSsePayload(text: string): unknown[] {
  const out: unknown[] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length === 0) return;
    const raw = data.join("\n");
    data = [];
    try {
      out.push(JSON.parse(raw) as unknown);
    } catch {
      // 单个坏事件不拖垮整条响应：后面还有正常事件就继续。
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  flush();
  return out;
}

function isSse(headers: Record<string, string>, body: string): boolean {
  const contentType = headerValue(headers, "content-type") ?? "";
  if (contentType.includes("text/event-stream")) return true;
  const head = body.trimStart();
  return head.startsWith("event:") || head.startsWith("data:");
}

/** 把一次响应正文解成 JSON-RPC 消息数组。解不出来抛错（由调用方转 bad_response）。 */
export function decodeMcpMessages(headers: Record<string, string>, body: string): JsonRpcMessage[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  const values = isSse(headers, body) ? parseSsePayload(body) : [JSON.parse(trimmed) as unknown];
  const messages: JsonRpcMessage[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item === "object") messages.push(item as JsonRpcMessage);
    } else if (value !== null && typeof value === "object") {
      messages.push(value as JsonRpcMessage);
    }
  }
  return messages;
}

function pickResponse(messages: JsonRpcMessage[], id: number | null): JsonRpcMessage | null {
  if (id !== null) {
    const matched = messages.find((m) => m.id === id);
    if (matched !== undefined) return matched;
  }
  // 没有匹配 id 时，退而取最后一条带 result/error 的（兼容不回 id 的实现）。
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && (m.result !== undefined || m.error !== undefined)) return m;
  }
  return null;
}

export class McpHttpClient {
  readonly url: string;
  private readonly transport: McpTransport;
  private readonly baseHeaders: Record<string, string>;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly protocolVersion: string;
  private sessionId: string | null = null;
  /** initialize 协商出的协议版本；后续请求按 MCP 规范带 mcp-protocol-version 头。 */
  private negotiatedVersion: string | null = null;
  private nextId = 1;
  private init: Promise<McpResult<unknown>> | null = null;

  constructor(opts: McpHttpClientOptions) {
    this.url = opts.url;
    this.transport = opts.transport ?? createFetchTransport(opts.url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.baseHeaders = { ...(opts.headers ?? {}) };
    this.clientName = opts.clientName ?? "dot-core";
    this.clientVersion = opts.clientVersion ?? "0.2.0";
    this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL;
  }

  /** 当前 mcp-session-id（没有就是 null）。排障/测试用。 */
  get session(): string | null {
    return this.sessionId;
  }

  private headersForRequest(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.baseHeaders,
    };
    if (this.sessionId !== null) headers["mcp-session-id"] = this.sessionId;
    if (this.negotiatedVersion !== null) headers["mcp-protocol-version"] = this.negotiatedVersion;
    return headers;
  }

  /** 发一条消息并等对应 id 的响应；通知（id=null）只发不等。 */
  private async postMessage(
    payload: Record<string, unknown>,
    id: number | null,
    opts: { readBody?: boolean } = {},
  ): Promise<McpResult<unknown>> {
    let res: McpHttpResponse;
    try {
      res = await this.transport.post(JSON.stringify(payload), this.headersForRequest());
    } catch (err) {
      return failureFromError(err);
    }

    const sid = headerValue(res.headers, "mcp-session-id");
    if (sid !== null) this.sessionId = sid;

    const http = httpFailure(res.status);
    if (http !== null) return http;
    if (id === null || opts.readBody === false) return { ok: true, result: null, sessionId: this.sessionId };

    let messages: JsonRpcMessage[];
    try {
      messages = decodeMcpMessages(res.headers, res.body);
    } catch (err) {
      return { ok: false, code: "bad_response", detail: `MCP 响应不是 JSON/SSE：${(err as Error).message}` };
    }
    const msg = pickResponse(messages, id);
    if (msg === null) {
      return { ok: false, code: "bad_response", detail: `MCP 响应里没有 id=${id} 的结果（正文 ${res.body.length} 字节）` };
    }
    if (msg.error !== undefined) {
      const code = msg.error.code ?? "?";
      const text = msg.error.message ?? "未知错误";
      return { ok: false, code: "rpc_error", detail: `JSON-RPC 错误 ${code}：${text}` };
    }
    return { ok: true, result: msg.result, sessionId: this.sessionId };
  }

  /** initialize 只跑一次；失败也缓存，不反复重试。 */
  ensureInitialized(): Promise<McpResult<unknown>> {
    if (this.init === null) this.init = this.doInitialize();
    return this.init;
  }

  private async doInitialize(): Promise<McpResult<unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const res = await this.postMessage(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: { name: this.clientName, version: this.clientVersion },
        },
      },
      id,
    );
    if (!res.ok) return res;
    const negotiated = (res.result as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof negotiated === "string" && negotiated !== "") this.negotiatedVersion = negotiated;

    // notifications/initialized 是单向通知；服务端就算回 405/202 也不影响后续调用。
    try {
      await this.transport.post(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        this.headersForRequest(),
      );
    } catch {
      // 忽略：有的实现把它当普通 POST 收下，失败不该阻断 handshake 的可用性判断。
    }
    return res;
  }

  async listTools(): Promise<McpResult<McpToolInfo[]>> {
    const ready = await this.ensureInitialized();
    if (!ready.ok) return ready;

    const id = this.nextId;
    this.nextId += 1;
    const res = await this.postMessage({ jsonrpc: "2.0", id, method: "tools/list", params: {} }, id);
    if (!res.ok) return res;
    const result = res.result as { tools?: unknown } | null;
    const tools = Array.isArray(result?.tools) ? (result?.tools as McpToolInfo[]) : [];
    return { ok: true, result: tools, sessionId: res.sessionId };
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpResult<unknown>> {
    const ready = await this.ensureInitialized();
    if (!ready.ok) return ready;

    const id = this.nextId;
    this.nextId += 1;
    const res = await this.postMessage(
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      id,
    );
    if (!res.ok) return res;

    // MCP 的 tools/call 允许把「工具执行失败」放在 result.isError 里（JSON-RPC 本身是成功）。
    const result = res.result as { isError?: unknown } | null;
    if (result !== null && typeof result === "object" && result.isError === true) {
      return { ok: false, code: "tool_error", detail: toolResultText(result) || `${name} 执行失败（isError=true）` };
    }
    return res;
  }
}

/** 从 tools/call 的 result 里抠出可读正文（content[].text 优先）。 */
export function toolResultText(result: unknown): string {
  if (result === null || typeof result !== "object") return typeof result === "string" ? result : "";
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (item !== null && typeof item === "object" && (item as { type?: unknown }).type === "text") {
          const text = (item as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter((t) => t !== "");
    if (parts.length > 0) return parts.join("\n");
  }
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) {
    try {
      return JSON.stringify(structured);
    } catch {
      return "";
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

// ── 按名字持有三只客户端的注册表 ────────────────────────────────────────────

export interface McpRegistryOptions {
  /** 每只手的地址；缺哪个就表示「没配」，get 返回 not_configured。 */
  urls?: Partial<Record<McpName, string>>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 直接注入客户端（测试用）；给了就不再按 url 建。 */
  clients?: Partial<Record<McpName, McpHttpClient>>;
  /** 给某只手注入 transport（测试用）。 */
  transportFor?: (name: McpName) => McpTransport | undefined;
}

type RegistryEntry = {
  client: McpHttpClient;
  state: "idle" | "ready" | "failed";
  failure: McpFail | null;
  pending: Promise<McpResult<McpHttpClient>> | null;
};

/**
 * 懒连接：第一次 get(name) 才 initialize；连不上记住原因，之后 get 直接返回同一失败，
 * 不反复重试。三只手各自一条，互不影响。
 */
export class McpRegistry {
  private readonly entries = new Map<McpName, RegistryEntry>();

  constructor(opts: McpRegistryOptions = {}) {
    const names: McpName[] = ["desktop", "logged_browser", "clean_browser"];
    for (const name of names) {
      const injected = opts.clients?.[name];
      const url = opts.urls?.[name];
      const client =
        injected ??
        (typeof url === "string" && url !== ""
          ? new McpHttpClient({
              url,
              headers: opts.headers,
              timeoutMs: opts.timeoutMs,
              transport: opts.transportFor?.(name),
            })
          : null);
      if (client !== null) {
        this.entries.set(name, { client, state: "idle", failure: null, pending: null });
      }
    }
  }

  /** 该名字有没有配置（注入或 url）。 */
  has(name: McpName): boolean {
    return this.entries.has(name);
  }

  get(name: McpName): Promise<McpResult<McpHttpClient>> {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      return Promise.resolve({
        ok: false,
        code: "not_configured",
        detail: `MCP 客户端「${name}」没配置地址`,
      });
    }
    if (entry.state === "failed" && entry.failure !== null) return Promise.resolve(entry.failure);
    if (entry.state === "ready") return Promise.resolve({ ok: true, result: entry.client, sessionId: entry.client.session });

    if (entry.pending === null) {
      entry.pending = entry.client.ensureInitialized().then((res) => {
        if (res.ok) {
          entry.state = "ready";
          return { ok: true as const, result: entry.client, sessionId: res.sessionId };
        }
        entry.state = "failed";
        entry.failure = res;
        return res;
      });
    }
    return entry.pending;
  }
}
