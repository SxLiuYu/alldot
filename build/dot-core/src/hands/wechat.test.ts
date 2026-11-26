/**
 * src/hands/wechat.test.ts —— 微信手的验收。
 *
 * 不连真微信：MCP 那一层用注入的 transport 假装（`McpTransport` 是现成的接缝）。
 * 要钉住的是这只手的**治理行为**，不是微信能不能点：
 * 1. 动作归一与参数裁剪：模型给 "sessions" 也认，多余的键不往下递；
 * 2. 缺参数在动手前就拒（send 没 text / read 没名字）；
 * 3. 副作用分类：只读 safe、open replayable、send/commit unknown（→ 一定走请示卡）；
 * 4. 端到端一走：runHandShell 里只读动作落一步 succeeded，正文回到调用方；
 * 5. MCP 挂了要落 failed 步骤，不能假成功；
 * 6. send 第一次只出请示卡，不碰 MCP。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getTask, listApprovals, listSteps, migrate } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import type { HandDeps } from "./hand.ts";
import type { McpHttpResponse, McpTransport } from "../mcp/client.ts";
import {
  createWechatHand,
  filterWechatParams,
  isWechatReadOnly,
  normalizeWechatAction,
  validateWechatRequest,
  WECHAT_TIMEOUT_MS,
} from "./wechat.ts";
import { defaultConfig } from "../config.ts";

function rpc(id: unknown, result: unknown): McpHttpResponse {
  return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, result }) };
}

/** 假 MCP：initialize 直接过，tools/call 记下工具名，回一条固定文本或错误。 */
function fakeTransport(reply: { text?: string; fail?: boolean } = {}): {
  transport: McpTransport;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const transport: McpTransport = {
    async post(body: string): Promise<McpHttpResponse> {
      const msg = JSON.parse(body) as { id?: unknown; method?: unknown; params?: unknown };
      const method = msg.method;
      if (method === "initialize") {
        return {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "sess_fake" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2024-11-05", serverInfo: { name: "wechat", version: "0.3.0" }, capabilities: {} },
          }),
        };
      }
      if (method === "notifications/initialized") return { status: 202, headers: {}, body: "" };
      if (method === "tools/call") {
        const params = msg.params as { name: string; arguments?: Record<string, unknown> };
        calls.push({ name: params.name, args: params.arguments ?? {} });
        if (reply.fail === true) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "微信窗口没找到" } }),
          };
        }
        return rpc(msg.id, { content: [{ type: "text", text: reply.text ?? "微信在：主屏，1280x800，12 个会话" }] });
      }
      return rpc(msg.id, {});
    },
  };
  return { transport, calls };
}

function makeFixture(): { deps: HandDeps; cleanup: () => void } {
  const tmp = makeTempDb();
  migrate(tmp.db);
  return { deps: { db: tmp.db, config: defaultConfig() }, cleanup: () => tmp.cleanup() };
}

test("动作归一：常见叫法都认，不认识的返回 null", () => {
  assert.equal(normalizeWechatAction("sessions"), "list");
  assert.equal(normalizeWechatAction("read_conversation"), "read");
  assert.equal(normalizeWechatAction("SEND"), "send");
  assert.equal(normalizeWechatAction("截屏"), null);
  assert.equal(normalizeWechatAction(""), null);
});

test("参数裁剪：多余键不往下递，limit 有默认", () => {
  assert.deepEqual(filterWechatParams("list", { limit: 5, evil: 1 }), { limit: 5 });
  assert.deepEqual(filterWechatParams("list", {}), { limit: 15 });
  assert.deepEqual(filterWechatParams("read", { name: "文件传输助手", limit: 3 }), { limit: 3, name: "文件传输助手" });
  assert.deepEqual(filterWechatParams("send", { text: "早", to: "小王", dry_run: true }), {
    text: "早",
    to: "小王",
    dry_run: true,
  });
});

test("缺参数在动手前拒：send 没 text、read/open 没名字", () => {
  assert.equal(validateWechatRequest("send", {})?.code, "missing_text");
  assert.equal(validateWechatRequest("read", { limit: 3 })?.code, "missing_name");
  assert.equal(validateWechatRequest("open", {})?.code, "missing_name");
  assert.equal(validateWechatRequest("send", { text: "在" }), null);
});

test("副作用分类：只读 safe，send/open 不算只读", () => {
  assert.equal(isWechatReadOnly("status"), true);
  assert.equal(isWechatReadOnly("screenshot"), true);
  assert.equal(isWechatReadOnly("send"), false);
  assert.equal(isWechatReadOnly("open"), false);
});

test("超时给足：wx_status 实测 150 秒，20 秒的默认值会把所有微信动作打成超时", () => {
  assert.ok(WECHAT_TIMEOUT_MS >= 160_000, `现在是 ${WECHAT_TIMEOUT_MS}ms`);
});

test("端到端：只读动作走完七步壳，落一步 succeeded，正文回到调用方", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看看微信有几个会话" });
    const { transport, calls } = fakeTransport();
    const hand = createWechatHand(f.deps, { transport });

    const out = await hand.run({ taskId, action: "list", params: { limit: 5 } });
    assert.equal(out.ok, true, `${out.code}：${out.text}`);
    assert.match(out.text, /12 个会话/);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "wx_sessions");
    assert.deepEqual(calls[0]?.args, { limit: 5 });

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.tool, "wechat");
    assert.equal(steps[0]?.status, "succeeded");
    assert.equal(listApprovals(f.deps.db).length, 0);
  } finally {
    f.cleanup();
  }
});

test("MCP 挂了：落 failed 步骤，不假成功", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看看微信状态" });
    const { transport } = fakeTransport({ fail: true });
    const hand = createWechatHand(f.deps, { transport });

    const out = await hand.run({ taskId, action: "status", params: {} });
    assert.equal(out.ok, false);
    assert.match(out.text, /微信|mcp_failed/);

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.status, "failed");
  } finally {
    f.cleanup();
  }
});

test("发消息：先出请示卡（实测第 4 档），等批准前不碰 MCP", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "给小王的微信发一句早" });
    const { transport, calls } = fakeTransport();
    const hand = createWechatHand(f.deps, { transport });

    const out = await hand.run({ taskId, action: "send", params: { text: "早", to: "小王" } });
    assert.equal(out.ok, false);
    assert.equal(out.code, "awaiting_approval", out.text);
    assert.notEqual(out.approvalId, null);
    assert.deepEqual(calls, [], "等待批准时不许碰微信");
    assert.equal(listApprovals(f.deps.db).length, 1);
    assert.equal(getTask(f.deps.db, taskId)?.state, "awaiting_approval");
  } finally {
    f.cleanup();
  }
});
