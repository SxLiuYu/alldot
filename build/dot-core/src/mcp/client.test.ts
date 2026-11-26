/**
 * src/mcp/client.test.ts —— 极简 MCP 客户端的验收（不连真服务器）。
 *
 * 钉住五条：
 * 1. application/json 与 text/event-stream 两种响应都解得出；
 * 2. 401 / 超时 / JSON-RPC error 都变成 { ok:false, code }，不抛到调用方；
 * 3. initialize 只发一次，后面复用 mcp-session-id；
 * 4. tools/call 的 result.isError 也当成失败（工具自己报的错）；
 * 5. McpRegistry 懒连接、失败原因缓存、不反复重试。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  McpHttpClient,
  McpRegistry,
  decodeMcpMessages,
  parseSsePayload,
  type McpHttpResponse,
  type McpTransport,
} from "./client.ts";

type Posted = { body: string; headers: Record<string, string>; message: Record<string, unknown> };

function jsonRpc(id: unknown, result: unknown, headers: Record<string, string> = {}): McpHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

function sseRpc(id: unknown, result: unknown, headers: Record<string, string> = {}): McpHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
    body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`,
  };
}

/** 一个记账式假传输：记录每条 POST，按 method 交给 handler。 */
function makeTransport(
  handler: (message: Record<string, unknown>, posted: Posted) => McpHttpResponse | Promise<McpHttpResponse>,
): { transport: McpTransport; posted: Posted[] } {
  const posted: Posted[] = [];
  const transport: McpTransport = {
    async post(body: string, headers: Record<string, string>): Promise<McpHttpResponse> {
      const message = JSON.parse(body) as Record<string, unknown>;
      const entry: Posted = { body, headers, message };
      posted.push(entry);
      return handler(message, entry);
    },
  };
  return { transport, posted };
}

const INIT: McpHttpResponse = {
  status: 200,
  headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } },
  }),
};

test("JSON 响应：initialize → tools/list → tools/call 全通，session 头带上", async () => {
  const { transport, posted } = makeTransport((message) => {
    if (message["method"] === "initialize") return INIT;
    if (message["method"] === "notifications/initialized") return { status: 202, headers: {}, body: "" };
    if (message["method"] === "tools/list") {
      return jsonRpc(message["id"], { tools: [{ name: "Click", description: "点一下" }] });
    }
    if (message["method"] === "tools/call") {
      return jsonRpc(message["id"], { content: [{ type: "text", text: "clicked" }] });
    }
    return { status: 404, headers: {}, body: "" };
  });

  const client = new McpHttpClient({ url: "http://fake/mcp", transport });
  const tools = await client.listTools();
  assert.equal(tools.ok, true);
  assert.deepEqual(tools.ok ? tools.result.map((t) => t.name) : [], ["Click"]);

  const call = await client.callTool("Click", { x: 1, y: 2 });
  assert.equal(call.ok, true);

  const initPosts = posted.filter((p) => p.message["method"] === "initialize");
  assert.equal(initPosts.length, 1, "initialize 只发一次");
  const callPost = posted.find((p) => p.message["method"] === "tools/call");
  assert.ok(callPost !== undefined);
  assert.equal(callPost?.headers["mcp-session-id"], "sess-1");
  assert.deepEqual((callPost?.message["params"] as { arguments: unknown }).arguments, { x: 1, y: 2 });
  assert.equal(client.session, "sess-1");
});

test("SSE 响应：event: message + data: {json} 也能解", async () => {
  const { transport } = makeTransport((message) => {
    if (message["method"] === "initialize") return sseRpc(message["id"], { protocolVersion: "2025-06-18" });
    if (message["method"] === "notifications/initialized") return { status: 202, headers: {}, body: "" };
    if (message["method"] === "tools/call") {
      return sseRpc(message["id"], { content: [{ type: "text", text: "导航完成" }] });
    }
    return { status: 404, headers: {}, body: "" };
  });

  const client = new McpHttpClient({ url: "http://fake/mcp", transport });
  const call = await client.callTool("browser_navigate", { url: "https://example.com" });
  assert.equal(call.ok, true);
  assert.equal(call.ok ? JSON.stringify(call.result) : "", '{"content":[{"type":"text","text":"导航完成"}]}');
});

test("401：变成 ok:false / unauthorized，不抛异常", async () => {
  const { transport } = makeTransport(() => ({ status: 401, headers: {}, body: "no" }));
  const client = new McpHttpClient({ url: "http://fake/mcp", transport });
  const out = await client.listTools();
  assert.equal(out.ok, false);
  assert.equal(out.ok ? "" : out.code, "unauthorized");
});

test("超时：transport 抛 AbortError → ok:false / timeout", async () => {
  const transport: McpTransport = {
    async post(): Promise<McpHttpResponse> {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  };
  const client = new McpHttpClient({ url: "http://fake/mcp", transport });
  const out = await client.ensureInitialized();
  assert.equal(out.ok, false);
  assert.equal(out.ok ? "" : out.code, "timeout");
});

test("JSON-RPC error：变成 ok:false / rpc_error，带上服务端消息", async () => {
  const { transport } = makeTransport((message) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: message["id"], error: { code: -32601, message: "Method not found" } }),
  }));
  const client = new McpHttpClient({ url: "http://fake/mcp", transport });
  const out = await client.ensureInitialized();
  assert.equal(out.ok, false);
  assert.equal(out.ok ? "" : out.code, "rpc_error");
  assert.match(out.ok ? "" : out.detail, /Method not found/);
});

test("tools/call 的 result.isError=true 也当失败", async () => {
  const { transport } = makeTransport((message) => {
    if (message["method"] === "initialize") return INIT;
    if (message["method"] === "notifications/initialized") return { status: 202, headers: {}, body: "" };
    return jsonRpc(message["id"], { isError: true, content: [{ type: "text", text: "没有找到元素" }] });
  });
  const client = new McpHttpClient({ url: "http://fake/mcp", transport });
  const out = await client.callTool("browser_click", { ref: "nope" });
  assert.equal(out.ok, false);
  assert.equal(out.ok ? "" : out.code, "tool_error");
  assert.match(out.ok ? "" : out.detail, /没有找到元素/);
});

test("McpRegistry：懒连接、失败缓存、不反复重试", async () => {
  let posts = 0;
  const { transport } = makeTransport(() => {
    posts += 1;
    return { status: 500, headers: {}, body: "boom" };
  });
  const registry = new McpRegistry({
    urls: { desktop: "http://fake/desktop" },
    transportFor: () => transport,
  });

  assert.equal(posts, 0, "构造时不连接");
  const first = await registry.get("desktop");
  assert.equal(first.ok, false);
  const attempts = posts;
  const second = await registry.get("desktop");
  assert.equal(second.ok, false);
  assert.equal(posts, attempts, "失败后不反复重试");
  assert.equal(first.ok ? "" : first.code, "http_500");

  const missing = await registry.get("clean_browser");
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? "" : missing.code, "not_configured");
});

test("SSE 解析：多事件 + 注释行 + 坏事件被跳过", () => {
  const text = [
    ": keep-alive",
    'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}',
    "",
    "event: message",
    "data: {坏 JSON",
    "",
    'data: {"jsonrpc":"2.0","id":2,"result":{"b":2}}',
    "",
  ].join("\n");
  const parsed = parseSsePayload(text);
  assert.deepEqual(parsed, [
    { jsonrpc: "2.0", id: 1, result: { a: 1 } },
    { jsonrpc: "2.0", id: 2, result: { b: 2 } },
  ]);
  const decoded = decodeMcpMessages({ "content-type": "text/event-stream" }, text);
  assert.equal(decoded.length, 2);
});
