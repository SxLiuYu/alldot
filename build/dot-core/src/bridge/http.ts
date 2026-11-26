/**
 * src/bridge/http.ts —— 桥与 dot-core 接收侧共用的一层薄 HTTP 工具。
 *
 * 不引框架：方案 B.6 只要 4 个路由 + MCP 一个 POST，node:http 足够；
 * 引框架会把「装的时候要做什么」变复杂。
 *
 * 安全口径（A.3：全部只听 127.0.0.1）：
 * - 状态页与 /artifact 带 CSP、nosniff、no-referrer；
 * - 请求体上限 1MB（MCP 一次工具调用远小于它，超了直接 413）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const MAX_BODY_BYTES = 1_048_576;

export async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new HttpError(413, "body_too_large", `请求体超过 ${maxBytes} 字节`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** 空体按 `{}` 处理：MCP 的 notifications/initialized 常见空体或 `{}`。 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const body = await readBody(req, maxBytes);
  const text = body.toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "bad_json", "请求体不是合法 JSON");
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** 状态页没有外链资源，CSP 收死；样式内联，所以放 style-src。 */
export const HTML_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cache-Control": "no-store",
};

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(html)),
    ...HTML_SECURITY_HEADERS,
  });
  res.end(html);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Length": "0", ...headers });
  res.end();
}

/** 相对 URL 解析成本机绝对 URL（只要 pathname/searchParams）。 */
export function parseRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

/** A.3「只听 127.0.0.1」的第二道：连接来自非回环就拒（防绑定配置被改）。 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (addr === undefined) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

/** HTML 转义：状态页上所有动态文本都过它。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 人类可读字节数（keep.json 里的占用）：GB 两位小数，MB 整数。 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "未知";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}
