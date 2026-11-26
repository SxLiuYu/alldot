/**
 * src/hands/browser.test.ts —— 两只浏览器手的验收（Playwright MCP 用假 transport）。
 *
 * 钉住五条：
 * 1. navigate 落第 3 档（可逆）放行并记账；
 * 2. 提交类（args.submit / reversible=false / click 目标像 submit）落第 4 档出单，不碰 MCP；
 * 3. snapshot 正文命中验证码关键词 → captcha_handoff，任务挂「等人」，之后不再调 click；
 * 4. logged 与 clean 用不同地址；clean 不许复用 logged 的地址；
 * 5. evaluate / handle_dialog 一律第 4 档。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { decideApproval, getTask, listApprovals, listSteps, migrate, setTaskState } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { defaultConfig } from "../config.ts";
import { toolResultText, type McpHttpResponse, type McpTransport } from "../mcp/client.ts";
import { createBrowserHand } from "./browser.ts";
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

type BrowserReply = unknown | { __raw: McpHttpResponse };

function makeBrowserTransport(
  handler: (name: string, args: Record<string, unknown>) => BrowserReply | Promise<BrowserReply>,
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

function textResult(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

test("navigate：第 3 档放行、记账；MCP 工具名与参数正确", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "打开一个页面" });
    const { transport, calls } = makeBrowserTransport(() => textResult("Navigated to https://example.com/a"));
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });

    const out = await hand.run({ action: "navigate", params: { url: "https://example.com/a" }, taskId });
    assert.equal(out.ok, true, out.text);
    assert.equal(out.tier, 3);
    assert.equal(out.rule, "browser_reversible");
    assert.equal(out.sideEffect, "replayable");
    assert.equal(listApprovals(f.deps.db).length, 0);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "browser_navigate");
    assert.deepEqual(calls[0]?.args, { url: "https://example.com/a" });

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.tool, "logged_browser");
    assert.equal(steps[0]?.tier, 3);
    assert.equal(peekHandLock(f.deps.db, "hand:logged_browser"), null, "动作结束必须放锁");
  } finally {
    f.cleanup();
  }
});

test("提交类 click：reversible=false → 第 4 档出单，不碰 MCP", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "提交表单" });
    const { transport, calls } = makeBrowserTransport(() => textResult("clicked"));
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });

    const out = await hand.run({ action: "click", params: { ref: "submit-form" }, taskId });
    assert.equal(out.ok, false);
    assert.equal(out.code, "awaiting_approval");
    assert.equal(out.tier, 4);
    assert.equal(out.rule, "browser_submit");
    assert.equal(listApprovals(f.deps.db).length, 1);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.deepEqual(calls, []);
  } finally {
    f.cleanup();
  }
});

test("evaluate / handle_dialog 一律第 4 档", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "跑脚本" });
    const { transport, calls } = makeBrowserTransport(() => textResult("{}"));
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });

    const evalOut = await hand.run({ action: "evaluate", params: { function: "() => 1" }, taskId });
    assert.equal(evalOut.code, "awaiting_approval");
    assert.equal(evalOut.tier, 4);

    const dialogOut = await hand.run({ action: "handle_dialog", params: { accept: true }, taskId });
    assert.equal(dialogOut.code, "awaiting_approval");
    assert.equal(dialogOut.tier, 4);

    assert.equal(listApprovals(f.deps.db).length, 2);
    assert.deepEqual(calls, []);
  } finally {
    f.cleanup();
  }
});

test("验证码：snapshot 正文命中关键词 → captcha_handoff，不再调 click", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看清楚页面" });
    let body = "页面标题：搜索";
    const { transport, calls } = makeBrowserTransport((name) => {
      if (name === "browser_navigate") return textResult("Navigated to https://example.com/search");
      if (name === "browser_snapshot") return textResult(body);
      if (name === "browser_click") return textResult("clicked");
      return textResult("");
    });
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });

    const nav = await hand.run({ action: "navigate", params: { url: "https://example.com/search" }, taskId });
    assert.equal(nav.ok, true, nav.text);

    body = "请完成滑块验证码后人机验证";
    const snap = await hand.run({ action: "snapshot", taskId });
    assert.equal(snap.ok, false);
    assert.equal(snap.code, "captcha_handoff");
    assert.match(snap.text, /验证码/);
    assert.match(snap.text, /https:\/\/example\.com\/search/);
    assert.equal(getTask(f.deps.db, taskId)?.state, "paused");

    const after = await hand.run({ action: "click", params: { ref: "submit" }, taskId });
    assert.equal(after.code, "task_paused");
    assert.equal(calls.some((c) => c.name === "browser_click"), false, "验证码出现后不许再点");
    assert.equal(calls.at(-1)?.name, "browser_snapshot");
    assert.equal(toolResultText({ content: [{ type: "text", text: body }] }), body);
  } finally {
    f.cleanup();
  }
});

test("clean 与 logged 用不同地址；clean 不许复用已登录地址", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "干净浏览器里开个页面" });
    const { transport, calls } = makeBrowserTransport(() => textResult("ok"));

    const logged = createBrowserHand(f.deps, "logged_browser", { transport });
    const clean = createBrowserHand(f.deps, "clean_browser", { transport });

    assert.equal(logged.mcpUrl, f.deps.config.browser.logged_mcp_url);
    assert.equal(clean.mcpUrl, f.deps.config.browser.clean_mcp_url);
    assert.notEqual(logged.mcpUrl, clean.mcpUrl);
    assert.equal(clean.profile, null, "默认 --isolated：不留任何状态");

    assert.throws(
      () =>
        createBrowserHand(f.deps, "clean_browser", {
          transport,
          mcpUrl: f.deps.config.browser.logged_mcp_url,
        }),
      /不许复用/,
    );

    const out = await clean.run({ action: "navigate", params: { url: "https://example.org" }, taskId });
    assert.equal(out.ok, true, out.text);
    assert.equal(out.tier, 3);
    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps[0]?.tool, "clean_browser");
    assert.equal(peekHandLock(f.deps.db, "hand:clean_browser"), null);
    assert.equal(calls[0]?.name, "browser_navigate");
  } finally {
    f.cleanup();
  }
});

test("验证码不只扫 snapshot：navigate 正文里出现也会停手", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "打开一个要验证的页面" });
    const { transport } = makeBrowserTransport((name) =>
      name === "browser_navigate" ? textResult("https://x.test → 请先完成人机验证") : textResult(""),
    );
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });

    const out = await hand.run({ action: "navigate", params: { url: "https://x.test" }, taskId });
    assert.equal(out.code, "captcha_handoff");
    assert.equal(getTask(f.deps.db, taskId)?.state, "paused");
  } finally {
    f.cleanup();
  }
});

test("验证码第 3 次不再默默挂起：出确认单问「还要不要继续」", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "反复被验证码挡" });
    const { transport } = makeBrowserTransport(() => textResult("验证码"));
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });

    for (let i = 1; i <= 2; i += 1) {
      const out = await hand.run({ action: "snapshot", taskId });
      assert.equal(out.code, "captcha_handoff", `第 ${i} 次应交接`);
      assert.match(out.text, new RegExp(`第 ${i}/2 次`));
      setTaskState(f.deps.db, taskId, "running", { reason: "人处理完验证码，继续" });
    }

    const third = await hand.run({ action: "snapshot", taskId });
    assert.equal(third.code, "awaiting_approval");
    assert.ok(third.approvalId !== null);
    assert.equal(getTask(f.deps.db, taskId)?.state, "awaiting_approval");
    assert.equal(listApprovals(f.deps.db).length, 1);
    assert.match(third.text, /交还 2 次/);
  } finally {
    f.cleanup();
  }
});

test("交接之后同一条提交要重新出单（不复活旧卡）", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "提交两次" });
    const { transport } = makeBrowserTransport((name) =>
      name === "browser_snapshot" ? textResult("滑块验证码") : textResult("clicked"),
    );
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });
    const params = { ref: "submit-order" };

    const first = await hand.run({ action: "click", params, taskId });
    assert.equal(first.code, "awaiting_approval");
    const firstId = first.approvalId ?? "";

    const captcha = await hand.run({ action: "snapshot", taskId });
    assert.equal(captcha.code, "captcha_handoff");
    setTaskState(f.deps.db, taskId, "running", { reason: "人处理完验证码，继续" });

    const second = await hand.run({ action: "click", params, taskId });
    assert.equal(second.code, "awaiting_approval");
    assert.notEqual(second.approvalId, firstId, "交接后要出新的卡，不能复用旧卡");
    assert.equal(listApprovals(f.deps.db).length, 2);
  } finally {
    f.cleanup();
  }
});

/** 走到「第 3 次验证码 → 确认单」的公共步骤。 */
async function reachThirdCaptcha(
  f: Fixture,
  hand: ReturnType<typeof createBrowserHand>,
  taskId: string,
): Promise<{ code: string; approvalId: string | null }> {
  for (let i = 1; i <= 2; i += 1) {
    const out = await hand.run({ action: "snapshot", taskId });
    assert.equal(out.code, "captcha_handoff");
    setTaskState(f.deps.db, taskId, "running", { reason: "人处理完验证码，继续" });
  }
  const third = await hand.run({ action: "snapshot", taskId });
  return { code: third.code, approvalId: third.approvalId };
}

test("验证码确认单批准后回到 running；拒绝则交还人手", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "第三次验证码" });
    let body = "验证码";
    const { transport } = makeBrowserTransport(() => textResult(body));
    const hand = createBrowserHand(f.deps, "logged_browser", { transport });

    const third = await reachThirdCaptcha(f, hand, taskId);
    assert.equal(third.code, "awaiting_approval");
    const card = third.approvalId ?? "";
    assert.equal(decideApproval(f.deps.db, card, { decision: "approved", decidedBy: "cli" }), true);

    body = "页面正常";
    const resumed = await hand.run({ action: "snapshot", taskId });
    assert.equal(resumed.ok, true, resumed.text);
    assert.equal(getTask(f.deps.db, taskId)?.state, "running", "确认单批准后不能永远挂在 awaiting");
  } finally {
    f.cleanup();
  }

  const g = makeFixture();
  try {
    const taskId = createTask(g.deps.db, { intent: "第三次验证码选停下" });
    let body = "验证码";
    const { transport } = makeBrowserTransport(() => textResult(body));
    const hand = createBrowserHand(g.deps, "logged_browser", { transport });

    const third = await reachThirdCaptcha(g, hand, taskId);
    assert.equal(third.code, "awaiting_approval");
    assert.equal(decideApproval(g.deps.db, third.approvalId ?? "", { decision: "rejected", decidedBy: "cli" }), true);

    body = "页面正常";
    const stopped = await hand.run({ action: "snapshot", taskId });
    assert.equal(stopped.code, "human_required");
    assert.equal(getTask(g.deps.db, taskId)?.state, "paused");
  } finally {
    g.cleanup();
  }
});
