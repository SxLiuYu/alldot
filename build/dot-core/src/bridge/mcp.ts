/**
 * src/bridge/mcp.ts —— POST /mcp 的 MCP（streamable-http）消息处理（B.6）。
 *
 * 只实现 ds-bot 挂能力时真正会用到的那几条：
 *   initialize → notifications/initialized → tools/list → tools/call（+ ping）。
 * 不实现 SSE 下行：桥没有服务端主动推送的消息；GET /mcp 由服务端回 405。
 *
 * 传输层（HTTP 状态码、session 头）在 server.ts；这里只管 JSON-RPC 语义，
 * 方便单测与以后换传输。
 */

import { BRAIN_TOOLS, callBrainTool, knownTool, type BridgeToolContext } from "./tools.ts";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpContext {
  tools: BridgeToolContext;
  version: string;
  serverName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function okResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function pickProtocolVersion(params: Record<string, unknown> | null): string {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : null;
  if (requested !== null && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export async function handleMcpMessage(message: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  const msg = asRecord(message);
  if (msg === null) {
    return errorResponse(null, -32600, "Invalid Request：消息必须是 JSON 对象");
  }
  const id = normalizeId(msg.id);
  const isNotification = !("id" in msg);
  if (msg.jsonrpc !== "2.0") {
    if (isNotification) return null;
    return errorResponse(id, -32600, "Invalid Request：jsonrpc 必须是 \"2.0\"");
  }
  const method = msg.method;
  if (typeof method !== "string" || method === "") {
    if (isNotification) return null;
    return errorResponse(id, -32600, "Invalid Request：缺 method");
  }
  const params = asRecord(msg.params);

  // 通知一律不回应（MCP 的 notifications/* 都是单向的）。
  if (isNotification) {
    return null;
  }

  switch (method) {
    case "initialize":
      return okResponse(id, {
        protocolVersion: pickProtocolVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: ctx.serverName ?? "dot-bridge", version: ctx.version },
        instructions:
          "dot 的大脑接口。机器人只有这五个工具：brain_reply 只回答（直接回一段给用户看的话，不建任务、不派活）、brain_task 派活、brain_status 问进度、brain_answer 回传审批、brain_cancel 取消。想动手才用 brain_task；只想聊一句就用 brain_reply。机器人自己不动手。",
      });

    case "ping":
      return okResponse(id, {});

    case "tools/list":
      return okResponse(id, {
        tools: BRAIN_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });

    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string" || name === "") {
        return errorResponse(id, -32602, "Invalid params：tools/call 需要 name");
      }
      const tool = knownTool(name);
      if (tool === null) {
        return errorResponse(id, -32602, `Unknown tool：${name}`);
      }
      const result = await callBrainTool(name, params?.arguments ?? {}, ctx.tools);
      return okResponse(id, result);
    }

    // 客户端常见但桥不提供的能力：明确回空，不算错误。
    case "resources/list":
      return okResponse(id, { resources: [] });
    case "resources/templates/list":
      return okResponse(id, { resourceTemplates: [] });
    case "prompts/list":
      return okResponse(id, { prompts: [] });

    default:
      return errorResponse(id, -32601, `Method not found：${method}`);
  }
}

export interface McpHttpPayload {
  status: number;
  body: unknown | null;
}

/** 批量请求与单条的入口；返回 HTTP 状态与要写回的 JSON（null = 只回 202 空体）。 */
export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<McpHttpPayload> {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { status: 400, body: errorResponse(null, -32600, "Invalid Request：批量请求不能是空数组") };
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      const res = await handleMcpMessage(item, ctx);
      if (res !== null) responses.push(res);
    }
    return { status: responses.length === 0 ? 202 : 200, body: responses.length === 0 ? null : responses };
  }
  const res = await handleMcpMessage(body, ctx);
  return { status: res === null ? 202 : 200, body: res };
}

export function isInitializeRequest(body: unknown): boolean {
  const single = Array.isArray(body) ? body[0] : body;
  const rec = asRecord(single);
  return rec !== null && rec.method === "initialize" && "id" in rec;
}
