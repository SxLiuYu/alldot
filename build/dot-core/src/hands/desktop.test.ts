/**
 * src/hands/desktop.test.ts —— 电脑手的验收（Windows-MCP 用假 transport，不碰真鼠标键盘）。
 *
 * 钉住六条：
 * 1. 只读动作（status）落第 1 档，直接执行并记账；
 * 2. click 落第 4 档出请示卡，且请示卡阶段一个 MCP 动作都不发；
 * 3. 受保护程序（进程名或窗口名）落第 6 档直接拒；
 * 4. 一次调用超过 batch_actions 直接拒；
 * 5. 人动过鼠标/前台窗口变了 → human_took_over，任务挂回「等人」；
 * 6. MCP 调用失败 → 步骤标 failed（不是 succeeded），锁也照样放掉。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { decideApproval, getTask, listApprovals, listSteps, migrate, setTaskState } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { defaultConfig } from "../config.ts";
import type { McpHttpResponse, McpTransport } from "../mcp/client.ts";
import { createDesktopHand, DESKTOP_TOOL_MAP } from "./desktop.ts";
import { createBuiltinGovernor } from "./builtin.ts";
import type { HandDeps } from "./hand.ts";
import { peekHandLock } from "./singleton.ts";

interface Fixture {
  deps: HandDeps;
  cleanup: () => void;
}

function makeFixture(overrides: Partial<HandDeps> = {}): Fixture {
  const tmp = makeTempDb();
  migrate(tmp.db);
  mkdirSync(join(tmp.dir, "练习"), { recursive: true });
  const config = defaultConfig();
  config.practice.root = join(tmp.dir, "练习");
  const deps: HandDeps = { db: tmp.db, config, ...overrides };
  return { deps, cleanup: () => tmp.cleanup() };
}

function rpc(id: unknown, result: unknown): McpHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

type DesktopReply = unknown | { __raw: McpHttpResponse };

function makeDesktopTransport(
  handler: (name: string, args: Record<string, unknown>) => DesktopReply | Promise<DesktopReply>,
): { transport: McpTransport; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const transport: McpTransport = {
    async post(body: string): Promise<McpHttpResponse> {
      const message = JSON.parse(body) as Record<string, unknown>;
      const method = message["method"];
      if (method === "initialize") return rpc(message["id"], { protocolVersion: "2025-06-18" });
      if (method === "notifications/initialized") return { status: 202, headers: {}, body: "" };
      if (method === "tools/call") {
        const params = message["params"] as { name: string; arguments?: Record<string, unknown> };
        const args = params.arguments ?? {};
        calls.push({ name: params.name, args });
        const reply = await handler(params.name, args);
        if (reply !== null && typeof reply === "object" && "__raw" in (reply as Record<string, unknown>)) {
          return (reply as { __raw: McpHttpResponse }).__raw;
        }
        return rpc(message["id"], reply);
      }
      return { status: 404, headers: {}, body: "" };
    },
  };
  return { transport, calls };
}

function statusResult(fields: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: "status" }], structuredContent: fields };
}

test("只读 status：落第 1 档，不提问、直接执行并记账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看看桌面" });
    const { transport, calls } = makeDesktopTransport(() =>
      statusResult({ cursor_x: 10, cursor_y: 20, active_window: "记事本" }),
    );
    const hand = createDesktopHand(f.deps, { transport });

    const out = await hand.run({ action: "status", taskId });
    assert.equal(out.ok, true, out.text);
    assert.equal(out.tier, 1);
    assert.equal(out.rule, "desktop_readonly");
    assert.equal(out.sideEffect, "safe");
    assert.equal(listApprovals(f.deps.db).length, 0, "只读不提问");
    assert.deepEqual(calls.map((c) => c.name), ["ControlStatus"]);

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.status, "succeeded");
    assert.equal(steps[0]?.tool, "desktop");
    assert.equal(steps[0]?.tier, 1);
  } finally {
    f.cleanup();
  }
});

test("click：落第 4 档出请示卡，且不真的调 MCP", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "点一下按钮" });
    const { transport, calls } = makeDesktopTransport(() => ({ content: [{ type: "text", text: "clicked" }] }));
    const hand = createDesktopHand(f.deps, { transport });

    const out = await hand.run({ action: "Click", params: { x: 30, y: 40 }, taskId });
    assert.equal(out.ok, false);
    assert.equal(out.code, "awaiting_approval");
    assert.equal(out.tier, 4);
    assert.ok(out.approvalId !== null);
    assert.equal(listApprovals(f.deps.db).length, 1);
    assert.equal(listSteps(f.deps.db, taskId).length, 0, "没批准不记账");
    assert.deepEqual(calls, [], "请示卡阶段不许碰 MCP");
  } finally {
    f.cleanup();
  }
});

test("受保护程序：进程名或窗口名命中 → 第 6 档直接拒，不动手不出单", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "点点微信" });
    const { transport, calls } = makeDesktopTransport(() => ({ content: [{ type: "text", text: "ok" }] }));
    const hand = createDesktopHand(f.deps, { transport });

    const byApp = await hand.run({ action: "click", params: { x: 1, y: 2, app: "C:/Program Files/Tencent/Weixin/Weixin.exe" }, taskId });
    assert.equal(byApp.code, "denied");
    assert.equal(byApp.tier, 6);
    assert.match(byApp.text, /受保护程序/);

    const byWindow = await hand.run({ action: "click", params: { x: 1, y: 2, window: "微信" }, taskId });
    assert.equal(byWindow.code, "denied");
    assert.equal(byWindow.tier, 6);

    assert.equal(listApprovals(f.deps.db).length, 0);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.deepEqual(calls, []);
  } finally {
    f.cleanup();
  }
});

test("一次调用超过 batch_actions：直接拒，中文原因，不动手", async () => {
  const f = makeFixture();
  try {
    f.deps.config.desktop.batch_actions = 3;
    const taskId = createTask(f.deps.db, { intent: "连点一串" });
    const { transport, calls } = makeDesktopTransport(() => ({ content: [{ type: "text", text: "clicked" }] }));
    const hand = createDesktopHand(f.deps, { transport });

    const out = await hand.run({ action: "click", params: { actions: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }] }, taskId });
    assert.equal(out.ok, false);
    assert.equal(out.code, "denied");
    assert.match(out.text, /最多连做 3 下/);
    assert.equal(listApprovals(f.deps.db).length, 0);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.deepEqual(calls, []);
  } finally {
    f.cleanup();
  }
});

test("接管即停：人动过鼠标后，下一次动作返回 human_took_over 并挂起任务", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看两次桌面" });
    let cursorX = 10;
    const { transport } = makeDesktopTransport(() =>
      statusResult({ cursor_x: cursorX, cursor_y: 20, active_window: "记事本" }),
    );
    const hand = createDesktopHand(f.deps, { transport });

    const first = await hand.run({ action: "status", taskId });
    assert.equal(first.ok, true, first.text);
    assert.equal(first.tier, 1);

    cursorX = 500; // 人把鼠标挪走了
    const second = await hand.run({ action: "status", taskId });
    assert.equal(second.ok, false);
    assert.equal(second.code, "human_took_over");
    assert.match(second.text, /人接管|鼠标/);
    assert.equal(getTask(f.deps.db, taskId)?.state, "paused");
    assert.equal(listSteps(f.deps.db, taskId).length, 1, "停手这一步不记账");
  } finally {
    f.cleanup();
  }
});

test("MCP 调用失败：步骤标 failed（不是 succeeded），单例锁也放掉", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "截个图" });
    const { transport } = makeDesktopTransport(() => ({
      __raw: {
        status: 500,
        headers: { "content-type": "application/json" },
        body: "server exploded",
      },
    }));
    const hand = createDesktopHand(f.deps, { transport });

    const out = await hand.run({ action: "screenshot", taskId });
    assert.equal(out.ok, false);
    assert.equal(out.code, "failed");
    assert.match(out.text, /调用失败|HTTP 500/);

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.status, "failed");
    assert.match(steps[0]?.error ?? "", /mcp_error/);
    assert.equal(peekHandLock(f.deps.db, "hand:desktop"), null, "失败后必须放锁");
  } finally {
    f.cleanup();
  }
});

test("动作映射：key 走 Shortcut，参数只留白名单键", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "按一下快捷键" });
    const { transport, calls } = makeDesktopTransport(() => ({ content: [{ type: "text", text: "ok" }] }));
    const hand = createDesktopHand(f.deps, { transport });

    // 4 档：先把审批走完
    const asked = await hand.run({ action: "key", params: { shortcut: "ctrl+c", junk: "不该透传" }, taskId });
    assert.equal(asked.code, "awaiting_approval");
    const approvalId = asked.approvalId ?? "";
    assert.equal(decideApproval(f.deps.db, approvalId, { decision: "approved", decidedBy: "cli" }), true);

    const out = await hand.run({ action: "key", params: { shortcut: "ctrl+c", junk: "不该透传" }, taskId });
    assert.equal(out.ok, true, out.text);
    const shortcut = calls.find((c) => c.name === DESKTOP_TOOL_MAP.key);
    assert.ok(shortcut !== undefined);
    assert.deepEqual(shortcut?.args, { shortcut: "ctrl+c" });
  } finally {
    f.cleanup();
  }
});

test("batch：不超过上限的 actions 数组逐步真执行，不是发一个空 Click", async () => {
  const f = makeFixture();
  try {
    f.deps.config.desktop.batch_actions = 3;
    const taskId = createTask(f.deps.db, { intent: "连点两下" });
    const { transport, calls } = makeDesktopTransport(() => ({ content: [{ type: "text", text: "clicked" }] }));
    const hand = createDesktopHand(f.deps, { transport });
    const params = { actions: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };

    const asked = await hand.run({ action: "click", params, taskId });
    assert.equal(asked.code, "awaiting_approval");
    assert.equal(decideApproval(f.deps.db, asked.approvalId ?? "", { decision: "approved", decidedBy: "cli" }), true);

    const out = await hand.run({ action: "click", params, taskId });
    assert.equal(out.ok, true, out.text);
    const clicks = calls.filter((c) => c.name === "Click");
    assert.equal(clicks.length, 2, "两步都要真发出去");
    assert.deepEqual(clicks.map((c) => c.args), [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    assert.match(out.text, /完成 2 步/);
    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1, "一次调用只记一行步骤（整段操作）");
    assert.equal(steps[0]?.status, "succeeded");
  } finally {
    f.cleanup();
  }
});

test("内置治理钩子跳过三只手：不会双份判档 / 双份审批 / 双行 steps", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "工人的活" });
    const gov = createBuiltinGovernor(f.deps);
    for (const tool of ["practice", "desktop", "logged_browser", "clean_browser"]) {
      const decision = await gov.beforeToolCall(
        { toolName: tool, params: { x: 1 }, toolCallId: `c-${tool}` },
        { toolName: tool, sessionKey: `task:${taskId}`, toolCallId: `c-${tool}` },
      );
      assert.equal(decision, undefined, `${tool} 应交给手自己的七步`);
    }
    assert.equal(listApprovals(f.deps.db).length, 0);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("同任务并发跑两次：先结束的那次只减计数，不许把另一份的锁删掉", async () => {  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "同一个任务两次截图" });
    const pending: Array<{ name: string; release: () => void }> = [];
    const transport: McpTransport = {
      async post(body: string): Promise<McpHttpResponse> {
        const message = JSON.parse(body) as Record<string, unknown>;
        const method = message["method"];
        if (method === "initialize") return rpc(message["id"], { protocolVersion: "2025-06-18" });
        if (method === "notifications/initialized") return { status: 202, headers: {}, body: "" };
        const params = message["params"] as { name?: string };
        const name = params.name ?? "?";
        return new Promise<McpHttpResponse>((resolve) => {
          pending.push({ name, release: () => resolve(rpc(message["id"], { content: [{ type: "text", text: name }] })) });
        });
      },
    };
    const hand = createDesktopHand(f.deps, { transport });

    const releaseFirst = (name: string): void => {
      const index = pending.findIndex((p) => p.name === name);
      assert.notEqual(index, -1, `没有待放行的 ${name}`);
      const [item] = pending.splice(index, 1);
      item?.release();
    };

    const a = hand.run({ action: "screenshot", taskId });
    await waitFor(() => pending.filter((p) => p.name === "Screenshot").length === 1);

    const b = hand.run({ action: "screenshot", taskId });
    await waitFor(() => pending.filter((p) => p.name === "Screenshot").length === 2);

    // 放行 A 的 Screenshot → A 接着做一次 ControlStatus 刷新基线
    releaseFirst("Screenshot");
    await waitFor(() => pending.some((p) => p.name === "ControlStatus"));
    releaseFirst("ControlStatus");

    const aOut = await a;
    assert.equal(aOut.ok, true, aOut.text);
    assert.ok(peekHandLock(f.deps.db, "hand:desktop") !== null, "A 结束不能把 B 的锁删掉");

    releaseFirst("Screenshot");
    await waitFor(() => pending.some((p) => p.name === "ControlStatus"));
    releaseFirst("ControlStatus");
    const bOut = await b;
    assert.equal(bOut.ok, true, bOut.text);
    assert.equal(peekHandLock(f.deps.db, "hand:desktop"), null, "最后一个持有者才删行");
  } finally {
    f.cleanup();
  }
});

test("人接管之后同一条点击要重新出单（不复活接管前的卡）", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "点两下同一个按钮" });
    let cursorX = 10;
    const { transport } = makeDesktopTransport(() =>
      statusResult({ cursor_x: cursorX, cursor_y: 20, active_window: "记事本" }),
    );
    const hand = createDesktopHand(f.deps, { transport });

    const first = await hand.run({ action: "click", params: { x: 1, y: 2 }, taskId });
    assert.equal(first.code, "awaiting_approval");
    const firstId = first.approvalId ?? "";

    const seen = await hand.run({ action: "status", taskId });
    assert.equal(seen.ok, true, seen.text);

    cursorX = 900; // 人动了鼠标
    const took = await hand.run({ action: "status", taskId });
    assert.equal(took.code, "human_took_over");
    setTaskState(f.deps.db, taskId, "running", { reason: "人把桌面交回来，继续" });

    const second = await hand.run({ action: "click", params: { x: 1, y: 2 }, taskId });
    assert.equal(second.code, "awaiting_approval");
    assert.notEqual(second.approvalId, firstId, "接管后要重新问，不能复用旧卡");
    assert.equal(listApprovals(f.deps.db).length, 2);
  } finally {
    f.cleanup();
  }
});

test("人在用电脑（USER_CONTROL）：不按故障处理，带 user_control 码等人", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "截个图" });
    const { transport } = makeDesktopTransport(() => ({
      content: [{ type: "text", text: JSON.stringify({ code: "USER_CONTROL", status: { state: "user" } }) }],
      isError: true,
    }));
    const hand = createDesktopHand(f.deps, { transport });

    const out = await hand.run({ action: "screenshot", taskId });
    assert.equal(out.ok, false);
    assert.equal(out.errorCode, "user_control", "账单里要能看出这是「人接手」而不是工具坏了");
    assert.match(out.text, /在用电脑/);
    assert.match(out.text, /说「继续」/);
    assert.equal(peekHandLock(f.deps.db, "hand:desktop"), null, "停下也要放锁");
  } finally {
    f.cleanup();
  }
});

test("拿不到控制权（CONTROL_UNAVAILABLE）：错误码 control_unavailable，话里指路重启 8000", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "截个图" });
    const { transport } = makeDesktopTransport(() => ({
      content: [{ type: "text", text: JSON.stringify({ code: "CONTROL_UNAVAILABLE", status: { state: "unavailable" } }) }],
      isError: true,
    }));
    const hand = createDesktopHand(f.deps, { transport });

    const out = await hand.run({ action: "screenshot", taskId });
    assert.equal(out.ok, false);
    assert.equal(out.errorCode, "control_unavailable");
    assert.match(out.text, /控制权/);
    assert.match(out.text, /8000/);
  } finally {
    f.cleanup();
  }
});
