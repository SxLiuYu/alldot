/**
 * src/bridge/bridge-extra.test.ts —— 第二轮审核补的验收（真起 http 服务打请求）。
 *
 * 覆盖审核点：
 * - A.3 两层 token：Authorization 走网关 token，x-dot-bridge-token 走桥 token（见 bridge.test.ts 的转发断言）；
 * - A.6/B.6 通知转发：/notify → 8797 send_to_bot，请示卡文字取自账本；
 * - B.6/B.7 keep.json 真实形状（totalMb / components 映射 / balance level）；
 * - A.9 恢复报告在状态页顶部；
 * - B.3 dot-core 未加载与连不上分开报；
 * - /mcp 超 1MB 回 413；/artifact 分类不混用「已回收」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createBridgeService, DEFAULT_DSBOT_BOT, keepHeaderLine, readKeepState } from "./index.ts";
import { makeFixture, startFakeBrain, startFakeDsBot } from "./test-fixtures.ts";

const GATEWAY_TOKEN = "test-gateway-token";

test("18789 有应答但 /dot/bridge/v1 路由不存在：标「大脑插件没加载，手已停用」", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain({ statusRoute: "404" });
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    probeTimeoutMs: 500,
  });
  try {
    const { url } = await service.start();
    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${fx.token as string}` } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /大脑插件没加载，手已停用（\d{2}:\d{2} 时起/);
    assert.ok(html.includes("把桌面截图按月份归档"), "仍显示账本最后状态");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("token 被拒与连不上分开报：401 标「大脑拒了桥 token」", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain({ statusRoute: "401" });
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    probeTimeoutMs: 500,
  });
  try {
    const { url } = await service.start();
    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${fx.token as string}` } });
    const html = await page.text();
    assert.match(html, /大脑拒了桥 token（\d{2}:\d{2} 时起/);
    assert.ok(html.includes("gateway.auth.token"));
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("/mcp 请求体超过 1MB：回 413，不是 500", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { pad: "x".repeat(1_200_000) },
    });
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fx.token as string}` },
      body,
    });
    assert.equal(res.status, 413);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.error.code, -32600);
    assert.match(json.error.message, /过大/);
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("/artifact 哈希格式不对回 400，不套「已回收」", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/artifact/zz`, {
      headers: { Authorization: `Bearer ${fx.token as string}` },
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /^链接格式不对/);
    assert.ok(!text.includes("已回收"));
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("通知转发：/notify 从账本渲染请示卡，转给 8797 的 send_to_bot", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const dsbot = await startFakeDsBot();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    dsBotBaseUrl: dsbot.url,
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fx.token as string}` },
      body: JSON.stringify({ approval_id: fx.seeded.approvalId }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.sent, true);
    assert.ok(json.text.includes("同意把 12 张截图移到月份文件夹？"), "问题必须取自 detail_json 原文");
    assert.ok(json.text.includes("1) 同意"), "选项必须取自 detail_json 原文");

    assert.equal(dsbot.calls.length, 1);
    const call = dsbot.calls[0];
    assert.equal(call?.path, "/mcp");
    const params = (call?.body as Record<string, any>).params;
    assert.equal(params.name, "send_to_bot");
    // 真实契约 mcp-server.js:44-51/193：send_to_bot 只认 bot + text。
    assert.equal(params.arguments.bot, DEFAULT_DSBOT_BOT, "必须带总管 bot，8797 才不拒");
    assert.ok(String(params.arguments.text).includes(fx.seeded.approvalId));
    assert.ok(String(params.arguments.text).includes("brain_answer(approval_id="));
    assert.ok(String(params.arguments.text).includes("同意把 12 张截图移到月份文件夹？"));
  } finally {
    await service.stop();
    await dsbot.close();
    await brain.close();
    fx.cleanup();
  }
});

test("通知失败（8797 没开）：/notify 回 502 且说清是 8797", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    dsBotBaseUrl: "http://127.0.0.1:9",
    dsBotTimeoutMs: 300,
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fx.token as string}` },
      body: JSON.stringify({ approval_id: fx.seeded.approvalId }),
    });
    assert.equal(res.status, 502);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.error, "dsbot_notify_failed");
    assert.match(json.message, /8797/);
    const logPath = join(fx.dotDir, "state", "notify-errors.jsonl");
    assert.ok(readFileSync(logPath, "utf8").includes("transport"), "失败要落一条错误记录");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("假 8797 回 400：桥报 502，不报成功，并落错误记录", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const dsbot = await startFakeDsBot({ httpStatus: 400, httpBody: { error: "bad request" } });
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    dsBotBaseUrl: dsbot.url,
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fx.token as string}` },
      body: JSON.stringify({ approval_id: fx.seeded.approvalId }),
    });
    assert.equal(res.status, 502, "上游非 2xx 时桥必须报失败");
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, false);
    assert.equal(json.error, "dsbot_notify_failed");
    assert.match(json.message, /HTTP 400/);
    const lines = readFileSync(join(fx.dotDir, "state", "notify-errors.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] as string).kind, "http_400");
  } finally {
    await service.stop();
    await dsbot.close();
    await brain.close();
    fx.cleanup();
  }
});

test("假 8797 回 200 但 result.isError：缺 bot 必须红，带出 No Bot 原话", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const dsbot = await startFakeDsBot();
  // 不配 bot：直接 new DsBotNotifier 传空 bot，复现 mcp-server.js:116-122 的拒绝。
  const { DsBotNotifier } = await import("./notify.ts");
  const notifier = new DsBotNotifier({ baseUrl: dsbot.url, bot: "", errorLogPath: join(fx.dotDir, "state", "notify-errors.jsonl") });
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    notifier,
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fx.token as string}` },
      body: JSON.stringify({ approval_id: fx.seeded.approvalId }),
    });
    assert.equal(res.status, 502, "HTTP 200 + isError 也必须判红");
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, false);
    assert.match(json.message, /No Bot "" for this client\. Call list_bots\./);
    // 2026-11-26：8797 不通不再等于「这张卡丢了」，回包必须说清它已经进了本机发件箱。
    assert.equal(json.delivered, "outbox");
    assert.match(json.message, /本机发件箱/);
    const log = readFileSync(join(fx.dotDir, "state", "notify-errors.jsonl"), "utf8");
    assert.match(log, /tool_isError/);
    assert.match(log, /No Bot/, "错误记录要带出 8797 的原话");
    // 错误日志仍记 8797 自己的原话（不带「已进发件箱」这层包装），回包在它后面补一句说明。
    assert.ok(String(json.message).startsWith(JSON.parse(log.trim()).detail), "回包以日志原话开头");
    const outbox = readFileSync(join(fx.dotDir, "state", "notify-outbox.jsonl"), "utf8");
    const queued = JSON.parse(outbox.trim()) as Record<string, any>;
    assert.equal(queued.delivered, "local", "发件箱要标清这张卡只留在本机");
    assert.equal(queued.approval_id, fx.seeded.approvalId);
  } finally {
    await service.stop();
    await dsbot.close();
    await brain.close();
    fx.cleanup();
  }
});

test("通知目标可配：--dsbot-bot 指定的 bot 原样发给 8797", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const dsbot = await startFakeDsBot();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    dsBotBaseUrl: dsbot.url,
    dsBotBot: "Chief",
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fx.token as string}` },
      body: JSON.stringify({ text: "直接发一条通知" }),
    });
    assert.equal(res.status, 200);
    const args = ((dsbot.calls[0]?.body as Record<string, any>).params as Record<string, any>).arguments;
    assert.equal(args.bot, "Chief");
    assert.equal(args.text, "直接发一条通知");
  } finally {
    await service.stop();
    await dsbot.close();
    await brain.close();
    fx.cleanup();
  }
});

test("keeper 真实形状的 keep.json：备份/快照/账户/组件都读得出来", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  mkdirSync(join(fx.dotDir, "state"), { recursive: true });
  writeFileSync(
    join(fx.dotDir, "state", "keep.json"),
    JSON.stringify({
      schema: 1,
      updatedAt: "2026-11-24T12:00:00.000Z",
      probedAt: "2026-11-24T12:00:00.000Z",
      overall: "red",
      line: "盘剩 4.0 GB／备份 512 MB／artifacts 未知／snapshots 256 MB／账户探针：red·green·unknown·20:00",
      disk: { freeMb: 4096, state: "green", detail: "", pauseAdmission: false },
      admission: null,
      backups: { bytes: 536870912, count: 3, todayPresent: true },
      artifacts: { bytes: null, note: "在账本库里" },
      snapshots: { bytes: 268435456 },
      balance: {
        enabled: true,
        cheap: { level: "red", note: "余额不足" },
        balanced: { level: "green", note: "" },
        strong: { level: "unknown", note: "探针没开" },
      },
      components: {
        modelPool: { level: "green", note: "3065 通" },
        dsbot: { level: "yellow", note: "脸没开，审批没人点" },
        dotCore: { level: "red", note: "未加载" },
      },
      rows: [{ id: "bridge", state: "green", detail: "GET /health 通" }],
    }),
    "utf8",
  );

  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${fx.token as string}` } });
    const html = await page.text();
    assert.ok(
      html.includes("盘剩 4.0 GB／备份 512 MB／artifacts 未知／snapshots 256 MB／账户探针：省钱红·均衡绿·最强未知"),
      "顶部一行要按 B.7 的中文格式、数字来自 keeper 字段",
    );
    assert.ok(html.includes("脸没开，审批没人点"), "components 映射要显示");
    assert.ok(html.includes("未加载"), "dot-core 行要显示");
    assert.ok(html.includes("3065 通"));
    assert.ok(html.includes("4.00 GB"), "盘剩余组件行不能丢");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});

test("恢复报告在状态页顶部（先于组件与任务进度）", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
  });
  try {
    const { url } = await service.start();
    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${fx.token as string}` } });
    const html = await page.text();
    const recoveryAt = html.indexOf('id="recovery"');
    const progressAt = html.indexOf('id="progress"');
    const componentsAt = html.indexOf('id="components"');
    assert.ok(recoveryAt > 0 && progressAt > 0 && componentsAt > 0);
    assert.ok(recoveryAt < componentsAt, "恢复报告应在组件之前");
    assert.ok(recoveryAt < progressAt, "恢复报告应在任务进度之前");
  } finally {
    await service.stop();
    await brain.close();
    fx.cleanup();
  }
});


test("keep.json 的另一种历史形状（backups.totalMb / rows / HTTP 码 balance）也能读", () => {
  const fx = makeFixture();
  try {
    const dir = join(fx.dir, "legacy");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "keep.json");
    writeFileSync(
      path,
      JSON.stringify({
        disk: { free_mb: 4096, state: "green" },
        backups: { totalMb: 512, count: 2 },
        snapshots: { mb: 256 },
        balance: {
          cheap: { status: 402, body: "insufficient_quota" },
          balanced: { status: 429, body: "rate limited" },
          strong: null,
        },
        rows: [{ id: "dsbot", state: "yellow", detail: "脸没开" }],
      }),
      "utf8",
    );
    const view = readKeepState(path);
    assert.equal(view.ok, true);
    assert.equal(view.backupsBytes, 512 * 1024 * 1024);
    assert.equal(view.snapshotsBytes, 256 * 1024 * 1024);
    assert.equal(view.balance.cheap.level, "red");
    assert.equal(view.balance.cheap.note, "insufficient_quota");
    assert.equal(view.balance.balanced.level, "yellow");
    assert.equal(view.balance.strong.level, "grey");
    assert.deepEqual(view.components, [{ name: "dsbot", level: "yellow", note: "脸没开" }]);
    assert.equal(
      keepHeaderLine(view),
      "盘剩 4.0 GB／备份 512 MB／artifacts 未知／snapshots 256 MB／账户探针：省钱红·均衡黄·最强未知",
    );
  } finally {
    fx.cleanup();
  }
});
