/**
 * src/bridge/p1p3-routes.test.ts —— P1–P3 新路由的验收（真起桥、真打请求）。
 *
 * 覆盖 docs/内部-P1P3-接口契约.md：
 * - GET /api/doctor：keep.json 的 rows → 挡派单/按钮 的人话版本；
 * - POST /api/fix：动作执行完必须回读（队列行数真的变 0），不认识的动作报 unknown_action；
 * - GET /api/diagnostics：纯文本且 token/IP/端口/邮箱/用户目录都脱敏；
 * - GET /api/approvals + POST /api/approvals/answer：pending 列表、同意落账、重复点幂等、
 *   过期按「拒绝/超时」落账；
 * - ConfigError 被记住后 /health 与 /api/doctor 都带 config_error。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createApproval, getApproval, openLedger } from "../ledger/index.ts";
import { createBridgeService, type BridgeServiceOptions } from "./index.ts";
import { makeFixture, type Fixture } from "./test-fixtures.ts";

const GATEWAY_TOKEN = "test-gateway-token";

function startService(fx: Fixture, extra: Partial<BridgeServiceOptions> = {}) {
  return createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: "http://127.0.0.1:9",
    probeTimeoutMs: 300,
    ...extra,
  });
}

function auth(fx: Fixture): Record<string, string> {
  return { Authorization: `Bearer ${fx.token as string}` };
}

function writeKeep(fx: Fixture, value: unknown): void {
  mkdirSync(join(fx.dotDir, "state"), { recursive: true });
  writeFileSync(join(fx.dotDir, "state", "keep.json"), JSON.stringify(value), "utf8");
}

test("GET /api/doctor：行 id 映射成「挡不挡派单」与一键修按钮", async () => {
  const fx = makeFixture();
  writeKeep(fx, {
    overall: "red",
    updatedAt: "2026-11-27T05:00:00.000Z",
    rows: [
      { id: "gateway", title: "18789 网关", state: "red", detail: "GET /api/status 失败", action: "起 gateway.cmd" },
      { id: "bridge", title: "8799 桥", state: "green", detail: "GET /health 通", action: "" },
      { id: "ledger", title: "账本通道", state: "yellow", detail: "账本读不了", action: "" },
      { id: "playwright", title: "8931 Playwright MCP", state: "red", detail: "TCP 连不上", action: "拉起" },
      { id: "dsbot", title: "ds-bot（脸）", state: "yellow", detail: "脸没开", action: "你自己打开" },
    ],
    components: { gateway: { level: "red", note: "GET /api/status 失败" } },
  });
  const service = startService(fx);
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/doctor`, { headers: auth(fx) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, true);
    assert.equal(json.overall, "red");
    assert.equal(json.blocked, true, "网关红 + 账本黄（都挡派单）");
    assert.equal(json.updatedAt, "2026-11-27T05:00:00.000Z");
    assert.equal(json.configError, null);

    const byId = new Map<string, any>(json.items.map((item: any) => [item.id, item]));
    assert.deepEqual(byId.get("gateway"), {
      id: "gateway",
      title: "18789 网关",
      state: "red",
      blocks: true,
      detail: "GET /api/status 失败",
      fix: "start_gateway",
      fixLabel: "起网关",
    });
    assert.equal(byId.get("bridge").blocks, true, "桥本身没起也挡派单（绿色这一行仍有映射）");
    assert.equal(byId.get("bridge").fix, "start_bridge");
    assert.equal(byId.get("ledger").blocks, true);
    assert.equal(byId.get("ledger").fix, null, "账本写不进不是点一下能好");
    assert.equal(byId.get("playwright").blocks, false, "其余算警告");
    assert.equal(byId.get("playwright").fix, "start_playwright");
    assert.equal(byId.get("dsbot").fix, null);
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("GET /api/doctor：keep.json 不在也不 500，给一行红说明原因", async () => {
  const fx = makeFixture();
  const service = startService(fx);
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/doctor`, { headers: auth(fx) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, true);
    assert.equal(json.overall, "red");
    assert.equal(json.items[0].id, "keeper");
    assert.match(json.items[0].detail, /keep\.json/);
    assert.equal(json.blocked, false, "读不到巡检状态不阻断派单（没有证据）");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("POST /api/fix：clear_report_queue 执行后回读队列行数（2 → 0）", async () => {
  const fx = makeFixture();
  const queuePath = join(fx.dotDir, "state", "keeper-report-queue.jsonl");
  mkdirSync(join(fx.dotDir, "state"), { recursive: true });
  writeFileSync(queuePath, '{"a":1}\n{"b":2}\n', "utf8");

  const service = startService(fx, {
    fixEnv: {
      // 假的 drain：真的清队列 + 报「落链 2 条」，用来验证我们确实回读了文件。
      runCapture: async () => {
        writeFileSync(queuePath, "", "utf8");
        return { code: 0, output: '{"ok":true,"appended":2,"skipped":0}' };
      },
    },
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ action: "clear_report_queue" }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, true);
    assert.match(json.detail, /2 → 0 行/);
    assert.match(json.detail, /落链 2 条/);
    assert.equal(readFileSync(queuePath, "utf8"), "", "队列文件必须真的被清掉");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("POST /api/fix：不认识的动作回 400 + unknown_action", async () => {
  const fx = makeFixture();
  const service = startService(fx);
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ action: "rm_rf" }),
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, false);
    assert.equal(json.error, "unknown_action");
    assert.match(json.message, /start_gateway/, "失败消息要列出可用动作");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("POST /api/fix：prune_artifacts 回收快照后回读腾出多少", async () => {
  const fx = makeFixture();
  // 造两棵旧快照（minAge 1 小时，需要改 mtime；这里直接把上限设成 0 就必然全删）。
  const taskDir = join(fx.dotDir, "snapshots", "task_old");
  const snapDir = join(taskDir, "20260101T000000");
  mkdirSync(snapDir, { recursive: true });
  const snapFile = join(snapDir, "snap.txt");
  writeFileSync(snapFile, "x".repeat(1024), "utf8");
  // sweepSnapshots 只看 task 目录的 mtime，且默认只删「超过 1 小时」的。
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(taskDir, old, old);

  const service = startService(fx, { fixEnv: { snapshotsMaxGb: 0 } });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/fix`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ action: "prune_artifacts" }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, true);
    assert.match(json.detail, /快照回收：删 1 个目录/);
    assert.match(json.detail, /腾出/);
    assert.throws(() => readFileSync(join(snapDir, "snap.txt"), "utf8"), "旧快照文件应已删除");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("GET /api/diagnostics：纯文本且 token/IP/端口/邮箱/用户目录全部脱敏", async () => {
  const fx = makeFixture();
  writeKeep(fx, {
    overall: "yellow",
    updatedAt: "2026-11-27T05:00:00.000Z",
    rows: [
      {
        id: "bridge",
        title: "8799 dot-bridge",
        state: "yellow",
        detail: "GET /health 失败：token=abcdef1234567 192.168.1.9 a@b.com C:\\Users\\1\\Desktop 端口 8799",
      },
    ],
  });
  const service = startService(fx, { version: "9.9.9" });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/diagnostics`, { headers: auth(fx) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, true);
    const text = String(json.text);
    assert.match(text, /alldot 诊断/);
    assert.match(text, /版本：9\.9\.9/);
    assert.match(text, /最近任务：/);
    assert.ok(text.includes(fx.seeded.taskId), "最近任务要带出账本里的任务");
    assert.ok(text.includes("步数"), "任务要带步数");
    assert.ok(!text.includes("192.168.1.9"), "IPv4 必须脱敏");
    assert.ok(text.includes("<IP>"));
    assert.ok(!text.includes("a@b.com"), "邮箱必须脱敏");
    assert.ok(text.includes("<邮箱>"));
    assert.ok(!text.includes("C:\\Users\\1\\"), "用户目录必须脱敏");
    assert.ok(text.includes("C:\\Users\\<用户>"));
    assert.ok(!text.includes("8799"), "端口必须脱敏");
    assert.ok(text.includes("<端口>"));
    assert.ok(text.includes("2026-11-27T05:00:00.000Z"), "时间戳里的冒号不能被当成端口");
    assert.ok(!text.includes("abcdef1234567"), "token 值必须脱敏");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("GET /api/diagnostics：账本不在也能出报告（写明打不开）", async () => {
  const fx = makeFixture();
  const service = startService(fx, { pathOptions: { dotDir: fx.dotDir, ledgerPath: join(fx.dir, "nope", "dot.db") } });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/diagnostics`, { headers: auth(fx) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, true);
    assert.match(String(json.text), /账本还没建|账本打不开/);
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("GET /api/approvals：pending 卡带 summary / expiresAt / expired", async () => {
  const fx = makeFixture();
  const service = startService(fx);
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/approvals`, { headers: auth(fx) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, true);
    assert.equal(json.items.length, 1);
    const item = json.items[0];
    assert.equal(item.id, fx.seeded.approvalId);
    assert.equal(item.taskId, fx.seeded.taskId);
    assert.equal(item.tier, 4);
    assert.equal(item.summary, "同意把 12 张截图移到月份文件夹？");
    assert.equal(item.expired, false);
    assert.ok(Date.parse(item.expiresAt) > Date.now(), "expiresAt 来自 pending_until");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("GET /api/approvals：账本打不开回 503", async () => {
  const fx = makeFixture();
  const service = startService(fx, { pathOptions: { dotDir: fx.dotDir, ledgerPath: join(fx.dir, "nope", "dot.db") } });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/approvals`, { headers: auth(fx) });
    assert.equal(res.status, 503);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, false);
    assert.equal(json.error, "ledger_unavailable");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("POST /api/approvals/answer：同意落账；重复点回 already_decided 不重复记账", async () => {
  const fx = makeFixture();
  const service = startService(fx);
  try {
    const { url } = await service.start();
    const first = await fetch(`${url}/api/approvals/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ id: fx.seeded.approvalId, answer: "agree" }),
    });
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as Record<string, any>;
    assert.deepEqual(firstJson, { ok: true, decision: "agree" });

    const db = openLedger(fx.seeded.ledgerPath);
    try {
      const row = getApproval(db, fx.seeded.approvalId);
      assert.equal(row?.status, "approved");
      assert.equal(row?.decided_by, "dsbot");
      const decisions = db.prepare("SELECT * FROM decisions WHERE task_id = ?").all(fx.seeded.taskId) as unknown[];
      assert.equal(decisions.length, 1, "decisions 留一行便于追溯");
    } finally {
      db.close();
    }

    const again = await fetch(`${url}/api/approvals/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ id: fx.seeded.approvalId, answer: "reject" }),
    });
    assert.equal(again.status, 409);
    const againJson = (await again.json()) as Record<string, any>;
    assert.equal(againJson.ok, false);
    assert.equal(againJson.error, "already_decided");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("POST /api/approvals/answer：过期按拒绝落账（理由「超时」），再点回 already_decided", async () => {
  const fx = makeFixture();
  const db = openLedger(fx.seeded.ledgerPath);
  let expiredId: string;
  try {
    const { approval } = createApproval(db, {
      task_id: fx.seeded.taskId,
      tier: 2,
      title: "过期卡",
      detail: { question: "这张已经过期了" },
      subject_key: "subj-expired-test",
      ttlMs: -60_000,
    });
    expiredId = approval.id;
  } finally {
    db.close();
  }

  const service = startService(fx);
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/approvals/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ id: expiredId, answer: "agree" }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.deepEqual(json, { ok: true, decision: "expired" });

    const check = openLedger(fx.seeded.ledgerPath);
    try {
      const row = getApproval(check, expiredId);
      assert.equal(row?.status, "rejected", "过期按拒绝写");
      assert.equal(row?.decided_by, "system");
      assert.equal(row?.decision_note, "超时");
    } finally {
      check.close();
    }

    const again = await fetch(`${url}/api/approvals/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ id: expiredId, answer: "agree" }),
    });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as Record<string, any>).error, "already_decided");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("POST /api/approvals/answer：没有这张卡回 404 not_found", async () => {
  const fx = makeFixture();
  const service = startService(fx);
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/api/approvals/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(fx) },
      body: JSON.stringify({ id: "apv_missing", answer: "agree" }),
    });
    assert.equal(res.status, 404);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.ok, false);
    assert.equal(json.error, "not_found");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("新路由都过桥 token：不带 token 一律 401", async () => {
  const fx = makeFixture();
  const service = startService(fx);
  try {
    const { url } = await service.start();
    for (const [method, path] of [
      ["GET", "/api/doctor"],
      ["POST", "/api/fix"],
      ["GET", "/api/diagnostics"],
      ["GET", "/api/approvals"],
      ["POST", "/api/approvals/answer"],
    ] as const) {
      const res = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 401, `${method} ${path} 必须鉴权`);
    }
  } finally {
    await service.stop();
    fx.cleanup();
  }
});

test("配置校验失败：ConfigError 被记住，/health 与 /api/doctor 都带出来", async () => {
  const fx = makeFixture();
  writeFileSync(join(fx.dotDir, "config.json"), JSON.stringify({ keepalive: { tunnelPort: "abc" } }), "utf8");
  const service = startService(fx);
  try {
    const { url } = await service.start();
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const healthJson = (await health.json()) as Record<string, any>;
    assert.equal(healthJson.config_error.path, "keepalive.tunnelPort");
    assert.match(healthJson.config_error.message, /未知字段/);
    assert.equal(healthJson.ok, true, "配置错不改变 /health 的存活判定");

    const doctor = await fetch(`${url}/api/doctor`, { headers: auth(fx) });
    const doctorJson = (await doctor.json()) as Record<string, any>;
    assert.deepEqual(doctorJson.configError, healthJson.config_error);
    assert.equal(service.state.configError?.path, "keepalive.tunnelPort");
  } finally {
    await service.stop();
    fx.cleanup();
  }
});
