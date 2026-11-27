/**
 * src/bridge/bridge.test.ts —— 8799 那个独立服务的验收（真起 http 服务打请求）。
 *
 * 覆盖：
 * - token 没有 → 除 /health 外 503；
 * - 状态页带 token 才能看，内容含模板卡/待批/恢复报告/顶部 keep 行；
 * - /mcp 的 initialize、tools/list、五个工具各自的转发路径与原文；
 * - 大脑掉线时状态页仍可用、标「大脑掉线（…时起）」，且账本一条事件都没多；
 * - keep.json 盘紧 → brain_task 直接拒，且不往大脑发请求；
 * - /artifact/<hash> 只读取全文，找不到回「已回收·原因」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createApproval,
  createTask,
  appendEvent,
  migrate,
  openLedger,
  putArtifact,
  readTaskView,
  renderProgressCard,
} from "../ledger/index.ts";
import { createBridgeService } from "./index.ts";

interface Seeded {
  ledgerPath: string;
  taskId: string;
  approvalId: string;
  artifactHash: string;
}

interface Fixture {
  dir: string;
  dotDir: string;
  token: string | null;
  seeded: Seeded;
  cleanup: () => void;
}

function seedLedger(dotDir: string): Seeded {
  mkdirSync(join(dotDir, "ledger"), { recursive: true });
  const ledgerPath = join(dotDir, "ledger", "dot.db");
  const db = openLedger(ledgerPath);
  migrate(db);
  const task = createTask(db, {
    intent: "把桌面截图按月份归档",
    declared: { scope: ["C:/Users/1/Desktop/截图"] },
    source: "dsbot",
    state: "awaiting_approval",
    restated: "把桌面上「截图」文件夹里的图，按文件名里的月份分到子文件夹",
  });
  const { approval } = createApproval(db, {
    task_id: task.id,
    tier: 4,
    title: "要动桌面上的文件",
    detail: { question: "同意把 12 张截图移到月份文件夹？", options: ["同意", "拒绝"] },
    subject_key: "subj-bridge-test",
  });
  const artifact = putArtifact(db, "明细第一行\n明细第二行");
  appendEvent(db, {
    type: "recovery_report",
    payload: {
      headline: "恢复完成：1 个孤儿步转人工",
      startedAt: "2026-11-24T10:00:00.000Z",
      finishedAt: "2026-11-24T10:00:02.000Z",
    },
  });
  db.close();
  return {
    ledgerPath,
    taskId: task.id,
    approvalId: approval.id,
    artifactHash: artifact.hash,
  };
}

function makeFixture(opts: { token?: string | null; diskFreeMb?: number } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "dot-bridge-test-"));
  const dotDir = join(dir, "dot");
  const token = opts.token === undefined ? "test-bridge-token-0123456789" : opts.token;
  if (token !== null) {
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "bridge-token"), `${token}\n`, "utf8");
  }
  const seeded = seedLedger(dotDir);
  if (opts.diskFreeMb !== undefined) {
    mkdirSync(join(dotDir, "state"), { recursive: true });
    writeFileSync(
      join(dotDir, "state", "keep.json"),
      JSON.stringify({
        updated_at: "2026-11-24T10:00:00.000Z",
        disk: { free_mb: opts.diskFreeMb, state: opts.diskFreeMb < 800 ? "red" : "green" },
        backups: { bytes: 1024 * 1024 * 512 },
        artifacts: { bytes: 1024 * 1024 * 128 },
        snapshots: { bytes: 1024 * 1024 * 256 },
        balance: {
          cheap: { state: "green" },
          balanced: { state: "green" },
          strong: { state: "green" },
        },
        components: { "ds-bot 脸": { state: "red", reason: "没开，审批没人点" } },
      }),
      "utf8",
    );
  }
  return {
    dir,
    dotDir,
    token,
    seeded,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface BrainCall {
  method: string;
  path: string;
  auth: string | null;
  bridgeToken: string | null;
  body: Record<string, unknown>;
}

interface FakeBrain {
  url: string;
  calls: BrainCall[];
  close: () => Promise<void>;
}

const FAKE_CARD = "【任务 task_fake】整理截图\n状态：执行中（第 1 个里程碑，共 2 个）\n卡在谁：没人";
const FAKE_REPLY = "这是大脑的回答原文。";
const FAKE_REPLY_ERROR = "回答不了：模型池回了 HTTP 502（炸了）。";

async function startFakeBrain(
  opts: { statusRoute?: "ok" | "404" | "401"; replyRoute?: "ok" | "http502" | "404" } = {},
): Promise<FakeBrain> {
  const calls: BrainCall[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const path = req.url ?? "/";
    calls.push({
      method: req.method ?? "",
      path,
      auth: req.headers.authorization ?? null,
      bridgeToken: (req.headers["x-dot-bridge-token"] as string | undefined) ?? null,
      body,
    });

    const reply = (status: number, value: unknown): void => {
      const payload = JSON.stringify(value);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) });
      res.end(payload);
    };

    if (path === "/dot/bridge/v1/tasks") {
      reply(201, {
        ok: true,
        task: { id: "task_fake", intent: body.intent, state: "queued", stateLabel: "待启动" },
        task_id: "task_fake",
        card: FAKE_CARD,
        message: "接下任务 task_fake（待启动）",
      });
      return;
    }
    if (path === "/dot/bridge/v1/status") {
      if (opts.statusRoute === "404") {
        reply(404, { ok: false, error: "unknown_route", message: "没有这个桥路由：POST /status" });
        return;
      }
      if (opts.statusRoute === "401") {
        reply(401, { ok: false, error: "unauthorized", message: "桥 token 不对" });
        return;
      }
      reply(200, {
        ok: true,
        tasks: [{ id: "task_fake", intent: "整理截图", state: "running", stateLabel: "执行中" }],
        cards: [FAKE_CARD],
        approvals: [],
        recovery: null,
      });
      return;
    }
    if (/^\/dot\/bridge\/v1\/approvals\/[^/]+\/decide$/.test(path)) {
      reply(200, { ok: true, changed: true, approval: { id: "apv_1", status: "approved" }, message: "已记下：同意（批单 apv_1）" });
      return;
    }
    if (/^\/dot\/bridge\/v1\/tasks\/[^/]+\/cancel$/.test(path)) {
      reply(200, { ok: true, task: { id: "task_fake", state: "cancelled" }, message: "已取消任务 task_fake" });
      return;
    }
    if (path === "/dot/bridge/v1/reply") {
      if (opts.replyRoute === "404") {
        reply(404, { ok: false, error: "unknown_route", message: "没有这个桥路由：POST /reply" });
        return;
      }
      if (opts.replyRoute === "http502") {
        reply(502, { ok: false, error: "model_failed", message: FAKE_REPLY_ERROR, status: 502 });
        return;
      }
      reply(200, {
        ok: true,
        reply: FAKE_REPLY,
        model: "deepseek-v4.1-flash",
        usage: { input_tokens: 1, output_tokens: 2 },
        spend_id: "spend_fake",
        event_seq: 1,
        elapsed_ms: 5,
        truncated: false,
      });
      return;
    }
    reply(404, { ok: false, error: "unknown_route", message: path });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function countEvents(ledgerPath: string): number {
  const db = openLedger(ledgerPath, { readOnly: true, createDir: false });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n?: number };
    return Number(row.n ?? 0);
  } finally {
    db.close();
  }
}

async function callMcp(
  base: string,
  token: string | null,
  body: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(res.status, 200, `MCP 请求应当 200，实际 ${res.status}`);
  return (await res.json()) as unknown;
}

function resultOf(response: unknown): Record<string, unknown> {
  const rec = response as Record<string, unknown>;
  assert.ok(rec.result !== undefined && rec.error === undefined, `期望 result，实际 ${JSON.stringify(response).slice(0, 300)}`);
  return rec.result as Record<string, unknown>;
}

test("token 没配置：/health 回 503 + ok:false，其余一律 503", async () => {
  const fx = makeFixture({ token: null });
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    token: null,
    gatewayToken: null,
    pathOptions: { dotDir: fx.dotDir },
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const health = await fetch(`${url}/health`);
    // token 没配时回 503：keeper 只认 HTTP 成功，200+ok:false 会被它当绿（B.7）。
    assert.equal(health.status, 503);
    const healthBody = (await health.json()) as Record<string, any>;
    assert.equal(healthBody.ok, false);
    assert.equal(healthBody.token.configured, false);

    const page = await fetch(`${url}/`);
    assert.equal(page.status, 503);
    const pageBody = (await page.json()) as Record<string, unknown>;
    assert.equal(pageBody.error, "bridge_token_missing");

    const mcp = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 503);
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("状态页：无 token 401，带 token 200，任务/待批/恢复报告/keep 行都在", async () => {
  const fx = makeFixture({ diskFreeMb: 4096 });
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: "test-gateway-token",
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const token = fx.token as string;

    const noToken = await fetch(`${url}/`);
    assert.equal(noToken.status, 401);

    const wrong = await fetch(`${url}/`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);

    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /大脑在线/);
    assert.match(html, /任务进度（账本模板卡原样贴，不经模型）/);
    assert.ok(html.includes("把桌面截图按月份归档"), "状态页应显示任务意图");
    assert.ok(html.includes("【任务 "), "状态页应贴账本模板卡");
    assert.ok(html.includes("卡在谁："), "模板卡四问之一");
    assert.ok(html.includes("要动桌面上的文件"), "状态页应列待批");
    assert.ok(html.includes("恢复完成：1 个孤儿步转人工"), "状态页应显示恢复报告 headline");
    assert.match(html, /盘剩 4\.0 GB／备份 512 MB／artifacts 128 MB／snapshots 256 MB／账户探针：省钱绿·均衡绿·最强绿/);
    assert.ok(html.includes("没开，审批没人点"), "keeper 报的组件要显示");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("POST /mcp：initialize、tools/list、五个工具各自的转发", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: "test-gateway-token",
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const token = fx.token as string;

    const init = await callMcp(url, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsbot", version: "0.3.9" } },
    });
    const initResult = resultOf(init);
    assert.equal(initResult.protocolVersion, "2025-06-18");
    assert.deepEqual(initResult.serverInfo, { name: "dot-bridge", version: "0.1.0" });
    assert.deepEqual(initResult.capabilities, { tools: { listChanged: false } });

    const list = await callMcp(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (resultOf(list).tools ?? []) as Array<{ name: string }>;
    assert.deepEqual(
      tools.map((t) => t.name),
      ["brain_task", "brain_status", "brain_answer", "brain_cancel", "brain_reply"],
    );

    const task = await callMcp(url, token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "brain_task", arguments: { intent: "整理桌面截图", declared: { scope: ["C:/Users/1/Desktop/截图"] } } },
    });
    const taskResult = resultOf(task) as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(taskResult.isError, undefined);
    assert.ok(taskResult.content[0]?.text.includes("已交给大脑"));
    assert.ok(taskResult.content[0]?.text.includes(FAKE_CARD));

    const status = await callMcp(url, token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "brain_status", arguments: {} },
    });
    const statusResult = resultOf(status) as { content: Array<{ text: string }> };
    assert.equal(statusResult.content[0]?.text, FAKE_CARD, "brain_status 必须原样转出账本模板卡");

    const answer = await callMcp(url, token, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "brain_answer", arguments: { approval_id: "apv_1", answer: "同意" } },
    });
    const answerResult = resultOf(answer) as { content: Array<{ text: string }> };
    assert.equal(answerResult.content[0]?.text, "已记下：同意（批单 apv_1）");

    const cancel = await callMcp(url, token, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "brain_cancel", arguments: { task_id: "task_fake", reason: "用户不要了" } },
    });
    const cancelResult = resultOf(cancel) as { content: Array<{ text: string }> };
    assert.equal(cancelResult.content[0]?.text, "已取消任务 task_fake");

    const paths = brain.calls.map((c) => c.path);
    assert.deepEqual(paths, [
      "/dot/bridge/v1/tasks",
      "/dot/bridge/v1/status",
      "/dot/bridge/v1/approvals/apv_1/decide",
      "/dot/bridge/v1/tasks/task_fake/cancel",
    ]);
    for (const call of brain.calls) {
      assert.equal(call.auth, "Bearer test-gateway-token", "Authorization 必须是网关 token（A.3 第一层）");
      assert.equal(call.bridgeToken, token, "x-dot-bridge-token 必须是桥 token（A.3 第二层）");
    }
    assert.equal(brain.calls[0]?.body.intent, "整理桌面截图");
    assert.equal(brain.calls[0]?.body.source, "dsbot");
    assert.equal(brain.calls[2]?.body.answer, "同意");
    assert.equal(brain.calls[2]?.body.decided_by, "dsbot");
    assert.equal(brain.calls[3]?.body.reason, "用户不要了");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("大脑掉线：状态页照常显示最后状态并标「大脑掉线（…时起）」，账本零写入", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const deadUrl = brain.url;
  await brain.close();

  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    upstreamBaseUrl: deadUrl,
    probeTimeoutMs: 300,
    upstreamTimeoutMs: 300,
  });
  try {
    const { url } = await service.start();
    const token = fx.token as string;
    const before = countEvents(fx.seeded.ledgerPath);

    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(page.status, 200, "大脑掉线时状态页必须还能打开");
    const html = await page.text();
    assert.match(html, /大脑掉线（\d{2}:\d{2} 时起，已 \d+ 分钟）/);
    assert.ok(html.includes("下面显示的是账本里最后一次写入的状态（只读）"));
    assert.ok(html.includes("把桌面截图按月份归档"), "掉线时仍显示账本最后状态");

    const call = await callMcp(url, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "brain_task", arguments: { intent: "再试一次" } },
    });
    const result = resultOf(call) as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(result.isError, true);
    assert.ok(result.content[0]?.text.includes("大脑掉线"));
    assert.ok(result.content[0]?.text.includes("没有提交"));

    const after = countEvents(fx.seeded.ledgerPath);
    assert.equal(after, before, "桥在掉线路径上也不能写账本");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("盘紧：keep.json 只剩 300MB 时 brain_task 直接拒，不往大脑发请求", async () => {
  const fx = makeFixture({ diskFreeMb: 300 });
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: "test-gateway-token",
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const token = fx.token as string;
    const call = await callMcp(url, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "brain_task", arguments: { intent: "这单应该被拒" } },
    });
    const result = resultOf(call) as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(result.isError, true);
    assert.ok(result.content[0]?.text.includes("盘紧"));
    assert.equal(brain.calls.length, 0, "盘紧时必须在大脑之前拦下");

    const health = await fetch(`${url}/health`);
    const healthBody = (await health.json()) as { admission: { allowed: boolean; reason: string } };
    assert.equal(healthBody.admission.allowed, false);
    assert.match(healthBody.admission.reason, /盘紧/);
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("/artifact：取全文；没有的 hash 回 404「已回收·原因」；?token= 会种 Cookie", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: "test-gateway-token",
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const token = fx.token as string;

    const hit = await fetch(`${url}/artifact/${fx.seeded.artifactHash}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(hit.status, 200);
    assert.equal(await hit.text(), "明细第一行\n明细第二行");

    const miss = await fetch(`${url}/artifact/deadbeefdeadbeef`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(miss.status, 404);
    assert.match(await miss.text(), /^已回收·原因：/);

    const page = await fetch(`${url}/?token=${encodeURIComponent(token)}`);
    assert.equal(page.status, 200);
    const cookie = page.headers.get("set-cookie") ?? "";
    assert.match(cookie, /dot_bridge_token=/);

    const viaCookie = await fetch(`${url}/artifact/${fx.seeded.artifactHash}`, {
      headers: { Cookie: cookie.split(";")[0] ?? "" },
    });
    assert.equal(viaCookie.status, 200);
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("状态页的模板卡与账本 renderProgressCard 逐字一致", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: "test-gateway-token",
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${fx.token as string}` } });
    const html = await page.text();

    const db = openLedger(fx.seeded.ledgerPath, { readOnly: true, createDir: false });
    const expected = renderProgressCard(readTaskView(db, fx.seeded.taskId));
    db.close();
    assert.ok(html.includes(expected), "状态页里的进度卡必须逐字等于账本模板卡");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("brain_reply 成功：content[0].text 逐字等于回答原文，且只打 /reply 不碰 /tasks", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: "test-gateway-token",
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const res = await callMcp(url, fx.token as string, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "brain_reply", arguments: { intent: "你好" } },
    });
    const result = resultOf(res) as {
      content: Array<{ text: string }>;
      isError?: boolean;
      structuredContent?: { ok: boolean; reply: string };
    };
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]?.text, FAKE_REPLY, "回答原文不能加前缀");
    assert.deepEqual(result.structuredContent, { ok: true, reply: FAKE_REPLY });

    assert.deepEqual(brain.calls.map((c) => c.path), ["/dot/bridge/v1/reply"], "只回答通道不得调 /tasks");
    assert.equal(brain.calls[0]?.body.via, "mcp", "MCP 工具固定传 via=mcp");
    assert.equal(brain.calls[0]?.body.intent, "你好");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("brain_reply 失败：502 逐字用 message；404 提示版本旧；连不上提示连不上大脑；都不调 /tasks", async () => {
  // 502：逐字转出大脑的 message
  {
    const fx = makeFixture();
    const brain = await startFakeBrain({ replyRoute: "http502" });
    const service = createBridgeService({
      port: 0,
      pathOptions: { dotDir: fx.dotDir },
      gatewayToken: "test-gateway-token",
      upstreamBaseUrl: brain.url,
    });
    try {
      const { url } = await service.start();
      const res = await callMcp(url, fx.token as string, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "brain_reply", arguments: { intent: "你好" } },
      });
      const result = resultOf(res) as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: { message: string } };
      assert.equal(result.isError, true);
      assert.equal(result.content[0]?.text, FAKE_REPLY_ERROR, "逐字用大脑回的 message");
      assert.equal(result.structuredContent?.message, FAKE_REPLY_ERROR);
      assert.deepEqual(brain.calls.map((c) => c.path), ["/dot/bridge/v1/reply"]);
    } finally {
      await service.stop();
      await brain.close();
      fx.cleanup();
    }
  }

  // 404：旧版本没有这条通道
  {
    const fx = makeFixture();
    const brain = await startFakeBrain({ replyRoute: "404" });
    const service = createBridgeService({
      port: 0,
      pathOptions: { dotDir: fx.dotDir },
      gatewayToken: "test-gateway-token",
      upstreamBaseUrl: brain.url,
    });
    try {
      const { url } = await service.start();
      const res = await callMcp(url, fx.token as string, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "brain_reply", arguments: { intent: "你好" } },
      });
      const result = resultOf(res) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(result.isError, true);
      assert.ok(result.content[0]?.text.includes("大脑版本不支持这条通道"));
      assert.deepEqual(brain.calls.map((c) => c.path), ["/dot/bridge/v1/reply"]);
    } finally {
      await service.stop();
      await brain.close();
      fx.cleanup();
    }
  }

  // 连不上大脑
  {
    const fx = makeFixture();
    const brain = await startFakeBrain();
    const deadUrl = brain.url;
    await brain.close();
    const service = createBridgeService({
      port: 0,
      pathOptions: { dotDir: fx.dotDir },
      gatewayToken: "test-gateway-token",
      upstreamBaseUrl: deadUrl,
      upstreamTimeoutMs: 300,
    });
    try {
      const { url } = await service.start();
      const res = await callMcp(url, fx.token as string, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "brain_reply", arguments: { intent: "你好" } },
      });
      const result = resultOf(res) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(result.isError, true);
      assert.ok(result.content[0]?.text.includes("连不上大脑"));
      assert.ok(result.content[0]?.text.includes("没提交，也没记账"));
    } finally {
      await service.stop();
      fx.cleanup();
    }
  }
});
