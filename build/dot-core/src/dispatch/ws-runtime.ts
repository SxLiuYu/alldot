/**
 * src/dispatch/ws-runtime.ts —— 自己实现的「起工人会话」通道（替代 api.runtime.subagent）。
 *
 * 为什么需要它（2026-11-25 真机实测）：
 *   这套 allbot 安装解析不到插件运行时模块（allbot-src/src/plugins/loader.ts:1152
 *   「Unable to resolve plugin runtime module」，官方 feishu 通道报同一个错），
 *   所以 `api.runtime.subagent` 拿不到，派发器起不了工人会话。
 *   `api.runtime.subagent.run` 内部本来就是「进程内合成 operator 客户端 → 调网关 WS 的 agent 方法」
 *   （allbot-src/src/gateway/server-plugins.ts:308-367），这里把这层自己做一个。
 *
 * 协议（亲读 allbot-src/src/gateway/client.ts）：
 *   1. 连 ws://127.0.0.1:18789（agents/tools/gateway.ts:16 的 DEFAULT_GATEWAY_URL）
 *   2. 服务端推 event `connect.challenge`，payload.nonce
 *   3. 客户端发 `{type:"req", id, method:"connect", params:{…, auth:{token}, role, scopes}}`
 *   4. 之后发 `{type:"req", id, method:"agent", params:{…}}` → `{type:"res", id, ok, payload}`
 *   5. `agent.wait` 回 {status:"ok"|"error"|"timeout"}
 *
 * 只依赖 Node 24 自带的全局 WebSocket，不引第三方包。
 *
 * 容错约定（派发器据此决定「放回队列」还是「判失败」）：
 *   - 连不上/握手被拒/令牌不对 → 抛 WsRuntimeUnavailableError（调用方应把任务放回 queued）；
 *   - 单次请求超时 → 关掉这条连接，下次重连，抛 WsRuntimeTimeoutError；
 *   - 服务端明确回 error（例如会话参数不对）→ 抛 WsRuntimeRejectedError（这是任务本身的问题）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WS_URL = "ws://127.0.0.1:18789";
export const DEFAULT_CONFIG_PATH = join(homedir(), ".allbot", "allbot.json");
/** 协议版本（allbot-src/src/gateway/protocol/schema/protocol-schemas.ts:370）。 */
const PROTOCOL_VERSION = 3;
const ROLE = "operator";
const SCOPES = ["operator.write"];

export class WsRuntimeUnavailableError extends Error {
  detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.name = "WsRuntimeUnavailableError";
    this.detail = detail;
  }
}

export class WsRuntimeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WsRuntimeTimeoutError";
  }
}

export class WsRuntimeRejectedError extends Error {
  code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "WsRuntimeRejectedError";
    this.code = code;
  }
}

export interface WsRuntimeOptions {
  /** 网关 WS 地址；默认 ws://127.0.0.1:18789。 */
  url?: string;
  /** allbot 配置路径（令牌从这里读）；默认 ~/.allbot/allbot.json。 */
  configPath?: string;
  /** 单次请求默认超时。 */
  timeoutMs?: number;
  /** 测试注入：不真的开 WebSocket，用这个假连接。 */
  transport?: WsTransport;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface SubagentRunParams {
  sessionKey?: string;
  message: string;
  extraSystemPrompt?: string;
  idempotencyKey?: string;
  deliver?: boolean;
}

export interface SubagentWaitResult {
  status: "ok" | "error" | "timeout";
  error?: string;
}

/** 传输层最小面。真实现用全局 WebSocket，测试用假的。 */
export interface WsTransport {
  /** 开连接；成功时返回收发句柄。 */
  open(): Promise<WsConnection>;
}

export interface WsConnection {
  /** 发一帧（已序列化的 JSON 字符串）。 */
  send(text: string): void;
  /** 收帧回调（收到就调，调用方自己解析）。 */
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  close(): void;
}

/** 从 allbot 配置里读网关令牌。读不到就抛可读错误——不猜、不回退到环境变量。 */
export function readGatewayToken(configPath: string = DEFAULT_CONFIG_PATH): string {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new WsRuntimeUnavailableError(`读不到 allbot 配置：${configPath}`, (err as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WsRuntimeUnavailableError(`allbot 配置不是合法 JSON：${configPath}`, (err as Error).message);
  }
  const gateway = (parsed as { gateway?: { auth?: { mode?: string; token?: unknown } } }).gateway;
  const auth = gateway?.auth;
  if (auth === undefined || auth === null) {
    throw new WsRuntimeUnavailableError(`配置里没有 gateway.auth：${configPath}`);
  }
  if (typeof auth.mode === "string" && auth.mode !== "token") {
    throw new WsRuntimeUnavailableError(
      `网关鉴权模式是 ${auth.mode}，这个通道只会用 token 模式（改 gateway.auth.mode 或换别的凭据）`,
    );
  }
  if (typeof auth.token !== "string" || auth.token.trim() === "") {
    throw new WsRuntimeUnavailableError(`gateway.auth.token 是空的：${configPath}`);
  }
  return auth.token.trim();
}

/** 真传输：Node 24 的全局 WebSocket。 */
export function createNodeWsTransport(url: string, timeoutMs: number): WsTransport {
  return {
    async open(): Promise<WsConnection> {
      const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      if (typeof WS !== "function") {
        throw new WsRuntimeUnavailableError("这个 Node 没有全局 WebSocket（需要 Node 22+）");
      }
      return await new Promise<WsConnection>((resolve, reject) => {
        const ws = new WS(url);
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* 关不掉就算了 */
          }
          reject(new WsRuntimeUnavailableError(`连网关 WS 超时：${url}`));
        }, timeoutMs);
        const waiters: { onMessage?: (t: string) => void; onClose?: (c: number, r: string) => void } = {};
        ws.onopen = () => {
          clearTimeout(timer);
          resolve({
            send(text) {
              ws.send(text);
            },
            onMessage(handler) {
              waiters.onMessage = handler;
            },
            onClose(handler) {
              waiters.onClose = handler;
            },
            close() {
              try {
                ws.close();
              } catch {
                /* 已经关了 */
              }
            },
          });
        };
        ws.onmessage = (ev: MessageEvent) => waiters.onMessage?.(String(ev.data));
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new WsRuntimeUnavailableError(`连网关 WS 出错：${url}`));
        };
        ws.onclose = (ev: CloseEvent) => waiters.onClose?.(ev.code ?? 0, String(ev.reason ?? ""));
      });
    },
  };
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 一条长连接 + 请求 id 路由。多条并发请求共用它；连接坏了就整条丢掉，下次重连。
 */
class WsGatewayLink {
  private conn: WsConnection | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private helloOk = false;

  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly transport: WsTransport;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;

  constructor(
    url: string,
    token: string,
    timeoutMs: number,
    transport: WsTransport,
    log: (level: "info" | "warn" | "error", message: string) => void,
  ) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.log = log;
  }

  private ensure(): Promise<void> {
    if (this.conn !== null && this.helloOk) return Promise.resolve();
    if (this.connecting !== null) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.helloOk = false;
    const conn = await this.transport.open();
    this.conn = conn;
    let nonce: string | null = null;
    const handshake = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new WsRuntimeUnavailableError(`等 connect.challenge 超时：${this.url}`));
      }, this.timeoutMs);
      conn.onMessage((text) => {
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch {
          return; // 坏帧忽略
        }
        const f = frame as { type?: string; event?: string; payload?: unknown; id?: string; ok?: boolean; error?: { message?: string; code?: string } };
        if (f.type === "event") {
          if (f.event === "connect.challenge") {
            const n = (f.payload as { nonce?: unknown } | undefined)?.nonce;
            if (typeof n !== "string" || n.trim() === "") {
              clearTimeout(timer);
              reject(new WsRuntimeUnavailableError("网关没给 nonce"));
              return;
            }
            nonce = n.trim();
            conn.send(
              JSON.stringify({
                type: "req",
                id: this.mintId(),
                method: "connect",
                params: {
                  minProtocol: PROTOCOL_VERSION,
                  maxProtocol: PROTOCOL_VERSION,
                  client: {
                    // 必须是 allbot 认的常量（gateway/protocol/client-info.ts:2-19）；
                    // 自造 id 会被 schema 拒：invalid connect params: at /client/id: must be equal to constant
                    id: "gateway-client",
                    displayName: "dot-core dispatch",
                    version: "0.2.0",
                    platform: process.platform,
                    mode: "backend",
                  },
                  caps: [],
                  auth: { token: this.token },
                  role: ROLE,
                  scopes: SCOPES,
                },
              }),
            );
          }
          return;
        }
        if (f.type === "res") {
          // connect 的响应：ok 就是握手成功（其它请求的响应走 pending 表）
          if (f.id !== undefined && this.pending.has(f.id)) {
            const p = this.pending.get(f.id);
            if (p === undefined) return;
            this.pending.delete(f.id);
            clearTimeout(p.timer);
            if (f.ok === true) p.resolve(f.payload);
            else p.reject(new WsRuntimeRejectedError(f.error?.message ?? "网关拒绝了请求", f.error?.code ?? null));
            return;
          }
          if (f.ok === true) {
            clearTimeout(timer);
            this.helloOk = true;
            resolve();
          } else {
            clearTimeout(timer);
            reject(new WsRuntimeUnavailableError(`握手被拒：${f.error?.message ?? "未知原因"}`, f.error?.code ?? ""));
          }
        }
      });
      conn.onClose((code, reason) => {
        this.conn = null;
        this.helloOk = false;
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new WsRuntimeUnavailableError(`网关连接被关：${code} ${reason}`.trim()));
        }
      });
      void nonce;
    });
    await handshake;
    this.log("info", `WS 通道已连上 ${this.url}`);
  }

  private mintId(): string {
    this.nextId += 1;
    return `dot-${this.nextId}`;
  }

  async request<T>(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<T> {
    await this.ensure();
    const conn = this.conn;
    if (conn === null) throw new WsRuntimeUnavailableError("WS 通道没有连接");
    const id = this.mintId();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时就把整条连接丢掉，避免半死连接被复用
        try {
          conn.close();
        } catch {
          /* 忽略 */
        }
        this.conn = null;
        this.helloOk = false;
        reject(new WsRuntimeTimeoutError(`网关 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject, timer });
      conn.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  close(): void {
    try {
      this.conn?.close();
    } catch {
      /* 忽略 */
    }
    this.conn = null;
    this.helloOk = false;
  }
}

/**
 * 造一个和 `PluginRuntimeLike["subagent"]` 同形的通道。
 * 派发器只用到 run 与 waitForRun 两个方法。
 */
export function createWsSubagentRuntime(opts: WsRuntimeOptions = {}): {
  run(params: SubagentRunParams): Promise<{ runId: string }>;
  waitForRun(params: { runId: string; timeoutMs?: number }): Promise<SubagentWaitResult>;
} {
  const url = opts.url ?? DEFAULT_WS_URL;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const log = opts.logger ?? (() => {});
  const token = opts.transport === undefined ? readGatewayToken(opts.configPath) : "test-token";
  const link = new WsGatewayLink(url, token, timeoutMs, opts.transport ?? createNodeWsTransport(url, timeoutMs), log);

  return {
    async run(params) {
      const payload = await link.request<{ runId?: unknown }>(
        "agent",
        {
          message: params.message,
          deliver: params.deliver ?? false,
          ...(params.sessionKey !== undefined && { sessionKey: params.sessionKey }),
          ...(params.extraSystemPrompt !== undefined && { extraSystemPrompt: params.extraSystemPrompt }),
          ...(params.idempotencyKey !== undefined && { idempotencyKey: params.idempotencyKey }),
        },
        Math.max(timeoutMs, 60000),
      );
      const runId = payload?.runId;
      if (typeof runId !== "string" || runId === "") {
        throw new WsRuntimeRejectedError("网关 agent 方法没有回 runId");
      }
      return { runId };
    },
    async waitForRun(params) {
      const waitMs = params.timeoutMs ?? 600000;
      const payload = await link.request<{ status?: unknown; error?: unknown }>(
        "agent.wait",
        { runId: params.runId, timeoutMs: waitMs },
        waitMs + 5000,
      );
      const status = payload?.status;
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new WsRuntimeRejectedError(`agent.wait 回了意外的状态：${String(status)}`);
      }
      return {
        status,
        ...(typeof payload?.error === "string" && payload.error !== "" ? { error: payload.error } : {}),
      };
    },
  };
}
