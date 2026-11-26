/**
 * src/bridge/upstream.ts —— 桥到大脑（18789 上的 dot-core）的转发客户端（B.6）。
 *
 * 只做四件事，路径与 A.6 的链路一一对应：
 *   POST /dot/bridge/v1/tasks                     新任务
 *   POST /dot/bridge/v1/status                    状态（带 task_id 时回模板卡）
 *   POST /dot/bridge/v1/approvals/<id>/decide     审批回执
 *   POST /dot/bridge/v1/tasks/<id>/cancel         取消
 *
 * 两类错误要分开，模型看到的提示不同：
 * - BrainUnavailableError：连不上/超时 → 「大脑掉线」，任务没提交；
 * - BrainHttpError：大脑应答了但拒绝（409 盘紧、404 无此单、401 token 不对）→ 原样说原因。
 */

export const DEFAULT_UPSTREAM_BASE_URL = "http://127.0.0.1:18789";
export const DEFAULT_TIMEOUT_MS = 8000;

export class BrainUnavailableError extends Error {
  readonly causeText: string;

  constructor(message: string, causeText = "") {
    super(message);
    this.name = "BrainUnavailableError";
    this.causeText = causeText;
  }
}

export class BrainHttpError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly errorCode: string | null;

  constructor(status: number, detail: string, errorCode: string | null = null) {
    super(detail);
    this.name = "BrainHttpError";
    this.status = status;
    this.detail = detail;
    this.errorCode = errorCode;
  }
}

export interface BrainClientOptions {
  baseUrl?: string;
  /** 桥 token（A.3 第二层）：放 `x-dot-bridge-token`，由 dot-core 的桥路由校验。 */
  token: string;
  /**
   * 网关 token（A.3 第一层）：放 `Authorization: Bearer`。
   * 18789 的 gateway 路由在 handler 之前就会校它（server-http.ts:357-388），
   * 不给就只发桥 token（只适合直连/测试，真网关会 401）。
   */
  gatewayToken?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface HttpResult {
  status: number;
  value: unknown;
}

function extractDetail(value: unknown, fallback: string): { detail: string; code: string | null } {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    const code = typeof rec.error === "string" ? rec.error : null;
    for (const key of ["message", "detail", "error_description"]) {
      if (typeof rec[key] === "string" && (rec[key] as string).trim() !== "") {
        return { detail: rec[key] as string, code };
      }
    }
    if (code !== null) return { detail: code, code };
  }
  return { detail: fallback, code: null };
}

export class BrainClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly token: string;
  private readonly gatewayToken: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BrainClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.gatewayToken = opts.gatewayToken ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown, timeoutMs?: number): Promise<HttpResult> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // 第一层：网关 token；第二层：桥 token。两个头各管一层（A.3）。
          Authorization: `Bearer ${this.gatewayToken ?? this.token}`,
          "x-dot-bridge-token": this.token,
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      throw new BrainUnavailableError(
        timedOut ? `连大脑超时（${timeoutMs ?? this.timeoutMs}ms）` : `连不上大脑：${e.message}`,
        e.message,
      );
    }

    const text = await res.text();
    let value: unknown = null;
    if (text.trim() !== "") {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = null;
      }
    }
    if (!res.ok) {
      const { detail, code } = extractDetail(value, text.slice(0, 500) || `HTTP ${res.status}`);
      throw new BrainHttpError(res.status, detail, code);
    }
    return { status: res.status, value };
  }

  createTask(body: Record<string, unknown>): Promise<HttpResult> {
    return this.post("/dot/bridge/v1/tasks", body);
  }

  status(taskId?: string | null): Promise<HttpResult> {
    return this.post("/dot/bridge/v1/status", { task_id: taskId ?? null });
  }

  /** 状态页探活：比工具调用短，掉线时不让页面等 8 秒。 */
  probe(timeoutMs = 1500): Promise<HttpResult> {
    return this.post("/dot/bridge/v1/status", { task_id: null, probe: true }, timeoutMs);
  }

  decide(approvalId: string, body: Record<string, unknown>): Promise<HttpResult> {
    return this.post(`/dot/bridge/v1/approvals/${encodeURIComponent(approvalId)}/decide`, body);
  }

  cancel(taskId: string, body: Record<string, unknown>): Promise<HttpResult> {
    return this.post(`/dot/bridge/v1/tasks/${encodeURIComponent(taskId)}/cancel`, body);
  }
}
