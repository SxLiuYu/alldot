/**
 * src/bridge/routes.test.ts —— 18789 接收侧 `/dot/bridge/v1/*` 的验收（真起 http 服务）。
 *
 * 这一侧是大脑：写账本只走 ledger 公开函数。测试逐条核对
 * 建任务、状态卡原文、审批条件更新与幂等、取消、盘紧拦截、桥 token 两层。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createApproval,
  createTask,
  getApproval,
  getTask,
  listMilestones,
  migrate,
  openLedger,
  readTaskView,
  setTaskState,
  renderProgressCard,
  verifyChain,
  type LedgerDb,
} from "../ledger/index.ts";
import { planTask } from "../plan/index.ts";
import {
  BRIDGE_ROUTE_BASE,
  createBridgeRouteHandler,
  createBridgeService,
  mapAnswerToDecision,
  registerBridgeRoutes,
  type BridgeRouteDeps,
} from "./index.ts";

const TOKEN = "route-test-token-0123456789";

interface Harness {
  db: LedgerDb;
  dbPath: string;
  dir: string;
  taskId: string;
  approvalId: string;
  keepPath: string;
  url: string;
  cleanup: () => Promise<void>;
}

async function startHarness(
  opts: {
    token?: string | null;
    diskFreeMb?: number;
    requireToken?: boolean;
    notify?: (payload: { approval_id: string }) => Promise<{ status: number; body: unknown }>;
    /** /settings 读写的那份 config.json；不给就用 ~/.allbot/dot/config.json（测试别碰它）。 */
    configPath?: string;
    /** 审批落定后的回调（自我优化流水线的入口）；测试里拿来核对有没有被叫、叫了几次。 */
    onApprovalDecided?: BridgeRouteDeps["onApprovalDecided"];
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dot-bridge-routes-"));
  const dbPath = join(dir, "dot.db");
  const db = openLedger(dbPath);
  migrate(db);
  const task = createTask(db, {
    intent: "把桌面截图按月份归档",
    declared: { scope: ["C:/Users/1/Desktop/截图"] },
    source: "dsbot",
    state: "awaiting_approval",
  });
  const { approval } = createApproval(db, {
    task_id: task.id,
    tier: 4,
    title: "要动桌面上的文件",
    detail: { question: "同意吗", options: ["同意", "拒绝"] },
    subject_key: "subj-routes-test",
  });
  const keepPath = join(dir, "keep.json");
  if (opts.diskFreeMb !== undefined) {
    writeFileSync(
      join(dir, "keep.json"),
      JSON.stringify({ disk: { free_mb: opts.diskFreeMb, state: "green" } }),
      "utf8",
    );
  }

  const deps: BridgeRouteDeps = {
    db,
    token: opts.token === undefined ? TOKEN : opts.token,
    requireToken: opts.requireToken,
    keepPath,
    minFreeMb: 800,
    notify: opts.notify,
    ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
    ...(opts.onApprovalDecided === undefined ? {} : { onApprovalDecided: opts.onApprovalDecided }),
  };
  const handler = createBridgeRouteHandler(deps);
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not_mine" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");

  return {
    db,
    dbPath,
    dir,
    taskId: task.id,
    approvalId: approval.id,
    keepPath,
    url: `http://127.0.0.1:${addr.port}`,
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      try {
        db.close();
      } catch {
        // 已关就算了。
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function call(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: Record<string, any> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, any>) };
}

test("桥 token：没给 401；deps 里 token 为 null 时 503；非本路由 404", async () => {
  const h = await startHarness();
  try {
    const noToken = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/status`, {}, null);
    assert.equal(noToken.status, 401);

    const wrong = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/status`, {}, "wrong");
    assert.equal(wrong.status, 401);

    const ok = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/status`, {});
    assert.equal(ok.status, 200);

    const elsewhere = await call(h, "GET", "/dot/bridge/v2/status", undefined);
    assert.equal(elsewhere.status, 404);
  } finally {
    await h.cleanup();
  }

  const h2 = await startHarness({ token: null });
  try {
    const locked = await call(h2, "POST", `${BRIDGE_ROUTE_BASE}/status`, {}, "anything");
    assert.equal(locked.status, 503);
    assert.equal(locked.json.error, "bridge_token_missing");
  } finally {
    await h2.cleanup();
  }
});

test("建任务 → 状态卡原文 → 审批条件更新与幂等 → 取消", async () => {
  const h = await startHarness();
  try {
    const created = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks`, {
      intent: "把下载目录里 12 月的发票挑出来",
      declared: { scope: ["C:/Users/1/Downloads"] },
      profile: "balanced",
      budget_tokens: 100000,
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.ok, true);
    const newTaskId = created.json.task_id as string;
    assert.ok(newTaskId.startsWith("task_"));
    assert.equal(created.json.task.intent, "把下载目录里 12 月的发票挑出来");
    assert.equal(created.json.task.state, "queued");
    const row = getTask(h.db, newTaskId);
    assert.ok(row !== null);
    assert.equal(row.source, "dsbot");

    const status = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/status`, { task_id: newTaskId });
    assert.equal(status.status, 200);
    const expectedCard = renderProgressCard(readTaskView(h.db, newTaskId));
    assert.equal(status.json.card, expectedCard, "status 必须回账本模板卡原文");
    assert.equal(status.json.task.id, newTaskId);
    assert.ok(Array.isArray(status.json.cards));
    assert.ok(status.json.cards.includes(expectedCard));

    const listAll = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/status`, {});
    assert.equal(listAll.status, 200);
    assert.ok(Array.isArray(listAll.json.approvals));
    assert.ok(listAll.json.approvals.some((a: { id: string }) => a.id === h.approvalId));

    const missing = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/status`, { task_id: "task_nope" });
    assert.equal(missing.status, 404);

    const decided = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/approvals/${h.approvalId}/decide`, {
      answer: "同意",
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.json.changed, true);
    assert.equal(getApproval(h.db, h.approvalId)?.status, "approved");
    assert.equal(getApproval(h.db, h.approvalId)?.decided_by, "dsbot");

    const again = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/approvals/${h.approvalId}/decide`, {
      answer: "拒绝",
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.changed, false);
    assert.match(again.json.message, /幂等/);
    assert.equal(getApproval(h.db, h.approvalId)?.status, "approved", "已决过的单不许被第二次答复改写");

    const unknownAnswer = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/approvals/${h.approvalId}/decide`, {
      answer: "随便吧",
    });
    assert.equal(unknownAnswer.status, 400);
    assert.equal(unknownAnswer.json.error, "answer_unrecognized");

    const cancel = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${newTaskId}/cancel`, { reason: "用户不要了" });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json.ok, true);
    assert.equal(getTask(h.db, newTaskId)?.state, "cancelled");
    assert.equal(getTask(h.db, newTaskId)?.state_reason, "用户不要了");

    const cancelAgain = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${newTaskId}/cancel`, {});
    assert.equal(cancelAgain.status, 409);
    assert.equal(cancelAgain.json.error, "not_cancellable");

    const notFound = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/task_nope/cancel`, {});
    assert.equal(notFound.status, 404);

    const chain = verifyChain(h.db);
    assert.equal(chain.ok, true, `写完后哈希链必须完好；${JSON.stringify(chain)}`);
  } finally {
    await h.cleanup();
  }
});

test("盘紧：keep.json 剩 300MB → 建任务 409 且一条 tasks 都不多", async () => {
  const h = await startHarness({ diskFreeMb: 300 });
  try {
    const before = (h.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    const res = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks`, { intent: "这单应该被拒" });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "admission_paused");
    assert.match(res.json.message, /盘紧/);
    const after = (h.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
    assert.equal(after, before);
  } finally {
    await h.cleanup();
  }
});

test("健康检查与参数校验", async () => {
  const h = await startHarness();
  try {
    const health = await call(h, "GET", `${BRIDGE_ROUTE_BASE}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.ok(health.json.open_tasks >= 1);

    const noIntent = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks`, { declared: {} });
    assert.equal(noIntent.status, 400);
    assert.equal(noIntent.json.error, "bad_intent");

    const badProfile = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks`, { intent: "x", profile: "turbo" });
    assert.equal(badProfile.status, 400);
    assert.equal(badProfile.json.error, "bad_profile");

    assert.equal(mapAnswerToDecision("同意"), "approved");
    assert.equal(mapAnswerToDecision("1"), "approved");
    assert.equal(mapAnswerToDecision("拒绝"), "rejected");
    assert.equal(mapAnswerToDecision("2"), "rejected");
    assert.equal(mapAnswerToDecision("再想想"), null);
  } finally {
    await h.cleanup();
  }
});

test("registerBridgeRoutes：前缀挂载、auth=gateway、handler 是函数", () => {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    registerHttpRoute: (params: Record<string, unknown>) => {
      calls.push(params);
    },
  };
  const db = { fake: true } as unknown as LedgerDb;
  registerBridgeRoutes(api as never, { db, token: TOKEN });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/dot/bridge/v1");
  assert.equal(calls[0]?.match, "prefix");
  assert.equal(calls[0]?.auth, "gateway");
  assert.equal(typeof calls[0]?.handler, "function");
});

test("建任务走的是账本公开函数：事件链、状态读模型都能对上", async () => {
  const h = await startHarness();
  try {
    const created = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks`, { intent: "验证写入口" });
    assert.equal(created.status, 201);
    const id = created.json.task_id as string;

    const events = h.db
      .prepare("SELECT type, task_id FROM events WHERE task_id = ? ORDER BY seq ASC")
      .all(id) as Array<{ type: string; task_id: string }>;
    assert.deepEqual(
      events.map((e) => e.type),
      ["task_created"],
    );

    const view = readTaskView(h.db, id);
    assert.equal(view.taskId, id);
    assert.equal(view.state, "queued");
    assert.equal(view.stateLabel, "待启动");
  } finally {
    await h.cleanup();
  }
});


test("x-dot-bridge-token 单独也能过（网关 token 占 Authorization）", async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.url}${BRIDGE_ROUTE_BASE}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-dot-bridge-token": TOKEN },
      body: "{}",
    });
    assert.equal(res.status, 200);
  } finally {
    await h.cleanup();
  }
});

test("restated 原样落库（B.8 tasks.restated）", async () => {
  const h = await startHarness();
  try {
    const created = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks`, {
      intent: "整理截图",
      restated: "把桌面上「截图」里的图按月份分到子文件夹",
      source_ref: { bot: "总管", chat: "c1" },
    });
    assert.equal(created.status, 201);
    const row = getTask(h.db, created.json.task_id as string);
    assert.equal(row?.restated, "把桌面上「截图」里的图按月份分到子文件夹");
    assert.deepEqual(JSON.parse(row?.source_ref ?? "null"), { bot: "总管", chat: "c1" });
  } finally {
    await h.cleanup();
  }
});

test("通知入口：POST /dot/bridge/v1/notify 交给桥转发，并回桥的结果", async () => {
  const seen: string[] = [];
  const h = await startHarness({
    notify: async (payload) => {
      seen.push(payload.approval_id);
      return { status: 200, body: { ok: true, sent: true, approval_id: payload.approval_id } };
    },
  });
  try {
    const res = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/notify`, { approval_id: h.approvalId });
    assert.equal(res.status, 200);
    assert.equal(res.json.sent, true);
    assert.deepEqual(seen, [h.approvalId]);

    const missing = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/notify`, { approval_id: "apv_nope" });
    assert.equal(missing.status, 404);

    const bad = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/notify`, {});
    assert.equal(bad.status, 400);
  } finally {
    await h.cleanup();
  }
});


test("replan 入口（你改了主意）：只给 why 只记重排点；给里程碑就换掉没做完的那几条", async () => {
  const h = await startHarness();
  try {
    planTask(h.db, {
      taskId: h.taskId,
      goal: "把桌面截图按月份归档",
      milestones: [
        { title: "列清单", done_when: "拿到所有文件名" },
        { title: "搬文件", done_when: "文件都进了对应目录" },
      ],
      why: "先列再搬（marker=none）",
    });

    const noWhy = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${h.taskId}/replan`, {});
    assert.equal(noWhy.status, 400);
    assert.equal(noWhy.json.error, "bad_why");

    const onlyWhy = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${h.taskId}/replan`, { why: "改成按周归档" });
    assert.equal(onlyWhy.status, 200);
    assert.equal(onlyWhy.json.plan_version, 2);
    assert.deepEqual(onlyWhy.json.milestones, []);
    assert.deepEqual(onlyWhy.json.skipped, []);
    assert.equal(listMilestones(h.db, h.taskId).length, 2, "只给 why 不动里程碑");

    const replaced = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${h.taskId}/replan`, {
      why: "加一步先备份",
      milestones: [
        { title: "先备份", done_when: "备份文件存在" },
        { title: "搬文件", done_when: "文件都进了对应目录" },
      ],
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.json.plan_version, 3);
    assert.equal(replaced.json.milestones.length, 2);
    assert.equal(replaced.json.skipped.length, 2, "原来没做完的两条要标 skipped");
    const current = getTask(h.db, h.taskId);
    assert.equal(current?.milestone_id, replaced.json.milestones[0].id, "指针要指向新清单第一条");

    const badList = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${h.taskId}/replan`, {
      why: "少字段",
      milestones: [{ title: "只有标题" }],
    });
    assert.equal(badList.status, 400);
    assert.equal(badList.json.error, "bad_milestones");
  } finally {
    await h.cleanup();
  }
});

test("端到端：桥 8799 → 18789 接收侧，Authorization 走网关 token、x 头走桥 token", async () => {
  const h = await startHarness();
  const service = createBridgeService({
    port: 0,
    token: TOKEN,
    gatewayToken: "gw-token-for-test",
    pathOptions: { dotDir: join(h.dir, "bridge-dot") },
    upstreamBaseUrl: h.url,
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "brain_task", arguments: { intent: "端到端建任务", restated: "端到端复述" } },
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.equal(json.result.isError, undefined, JSON.stringify(json));
    assert.ok(json.result.content[0].text.includes("已交给大脑"));
    const created = h.db
      .prepare("SELECT id, intent, restated FROM tasks WHERE intent = ?")
      .get("端到端建任务") as { id: string; intent: string; restated: string } | undefined;
    assert.ok(created !== undefined, "任务应该真的落在账本里");
    assert.equal(created?.restated, "端到端复述");
    assert.ok(json.result.content[0].text.includes("【任务 "), "返回值应带账本模板卡");
  } finally {
    await service.stop();
    await h.cleanup();
  }
});

test("用户反馈：good/bad 写一条 user_feedback，不改任务状态；坏输入 400/404", async () => {
  const h = await startHarness({});
  try {
    const created = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks`, { intent: "反馈接口测试" });
    assert.equal(created.status, 201);
    const taskId = String(created.json.task_id);

    const bad = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/feedback`, { task_id: taskId, verdict: "嗯" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "bad_verdict");

    const noTask = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/feedback`, { task_id: "task_nope", verdict: "bad" });
    assert.equal(noTask.status, 404);

    const okRes = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/feedback`, {
      task_id: taskId,
      verdict: "bad",
      note: "它把文件建到练习夹去了，我要的是桌面",
    });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json.ok, true);
    assert.equal(typeof okRes.json.event_seq, "number");

    const row = h.db
      .prepare("SELECT type, task_id, payload_json FROM events WHERE type = 'user_feedback' ORDER BY seq DESC LIMIT 1")
      .get() as { type: string; task_id: string; payload_json: string };
    assert.equal(row.task_id, taskId);
    const payload = JSON.parse(row.payload_json) as { verdict: string; note: string };
    assert.equal(payload.verdict, "bad");
    assert.match(payload.note, /桌面/);

    // 反馈不改任务状态：还是 queued
    assert.equal(getTask(h.db, taskId)?.state, "queued");

    const chain = verifyChain(h.db);
    assert.equal(chain.ok, true, `写反馈后哈希链必须完好；${JSON.stringify(chain)}`);
  } finally {
    await h.cleanup();
  }
});

test("/settings：读出来是 0，写成 3 再读就是 3；写 9 被拒（5/6 档永远要人点）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-settings-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ practice: { root: null } }), "utf8");
  const h = await startHarness({ configPath });
  try {
    const before = await call(h, "GET", "/dot/bridge/v1/settings");
    assert.equal(before.status, 200);
    assert.equal(before.json.auto_approve_max_tier, 0, "没写过就是 0（关）");

    const set3 = await call(h, "POST", "/dot/bridge/v1/settings", { auto_approve_max_tier: 3 });
    assert.equal(set3.status, 200, JSON.stringify(set3.json));
    assert.equal(set3.json.auto_approve_max_tier, 3);

    const after = await call(h, "GET", "/dot/bridge/v1/settings");
    assert.equal(after.json.auto_approve_max_tier, 3);

    const saved = JSON.parse(readFileSync(configPath, "utf8")) as { approvals?: { auto_approve_max_tier?: number } };
    assert.equal(saved.approvals?.auto_approve_max_tier, 3, "要真的写进文件");

    const tooBig = await call(h, "POST", "/dot/bridge/v1/settings", { auto_approve_max_tier: 9 });
    assert.equal(tooBig.status, 400, "9 要拒，别默默夹成 4");

    const bad = await call(h, "POST", "/dot/bridge/v1/settings", { auto_approve_max_tier: "三" });
    assert.equal(bad.status, 400);
  } finally {
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /tasks/<id>/resume：暂停中的任务能重新排队，别的状态说不行", async () => {
  const h = await startHarness();
  try {
    const t = createTask(h.db, { intent: "在桌面建个文件夹", declared: {}, source: "manual", state: "running" });
    setTaskState(h.db, t.id, "paused", { reason: "你正在用电脑，任务先停下等你说继续" });

    const ok = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${t.id}/resume`, { reason: "我不用电脑了" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(getTask(h.db, t.id)?.state, "queued", "说继续之后要回到排队，派发器才会重新领");

    const again = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/tasks/${t.id}/resume`, {});
    assert.equal(again.status, 409);
    assert.equal(again.json.error, "not_paused");
  } finally {
    await h.cleanup();
  }
});

test("审批落定会回调 onApprovalDecided（自我优化靠它接着生成补丁），幂等的第二次不叫", async () => {
  const seen: Array<{ approvalId: string; decision: string }> = [];
  const h = await startHarness({
    onApprovalDecided: (input) => seen.push({ approvalId: input.approvalId, decision: input.decision }),
  });
  try {
    const first = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/approvals/${h.approvalId}/decide`, {
      decision: "approved",
      note: "同意这条建议",
    });
    assert.equal(first.status, 200);
    assert.equal(seen.length, 1, "落定一次就要回调一次");
    assert.equal(seen[0]?.decision, "approved");

    const again = await call(h, "POST", `${BRIDGE_ROUTE_BASE}/approvals/${h.approvalId}/decide`, {
      decision: "approved",
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.changed, false);
    assert.equal(seen.length, 1, "幂等的重复答复不许再触发一遍流水线");
  } finally {
    await h.cleanup();
  }
});
