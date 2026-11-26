/**
 * src/ledger/ledger-records.test.ts —— 其余九张表的写入口（后面五个模块全靠这一层）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelTask,
  computeSubjectKey,
  createApproval,
  createMilestone,
  createPlan,
  createSnapshot,
  createTask,
  decideApproval,
  deleteArtifacts,
  expireDueApprovals,
  getArtifact,
  getTask,
  isApprovalStatus,
  latestPlan,
  listApprovals,
  listArtifacts,
  listDecisions,
  listMilestones,
  listOpenApprovals,
  listSnapshots,
  listSpend,
  listTasks,
  listWorkers,
  makeBlockedOn,
  markApprovalExecuted,
  markApprovalExecuting,
  migrate,
  parseBlockedOn,
  putArtifact,
  recordDecision,
  recordSpend,
  revokeApproval,
  setTaskState,
  sumSpend,
  updateMilestone,
  upsertWorker,
  verifyChain,
  verifyStepsChain,
} from "./index.ts";
import { countRows, makeTempDb } from "./test-helpers.ts";

test("subject_key：参数键序不影响结果，换任务就换键", () => {
  const a = computeSubjectKey("T1", "desktop", { z: 1, a: 2 });
  const b = computeSubjectKey("T1", "desktop", { a: 2, z: 1 });
  const c = computeSubjectKey("T2", "desktop", { a: 2, z: 1 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("blocked_on：写进去能原样解析回来，坏内容返回 null", () => {
  const text = makeBlockedOn({
    type: "human",
    reason: "unknown_side_effect",
    approval_ids: ["apv_1"],
    step_ids: ["step_1"],
  });
  const parsed = parseBlockedOn(text);
  assert.equal(parsed?.type, "human");
  assert.deepEqual(parsed?.approval_ids, ["apv_1"]);
  assert.equal(parseBlockedOn("not json"), null);
  assert.equal(parseBlockedOn(JSON.stringify({ type: "weird" })), null);
});

test("tasks：建、查、列、改状态、取消都走账本入口并上链", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const task = createTask(t.db, {
      intent: "整理桌面截图",
      declared: { scope: ["C:/Users/1/Desktop/截图"] },
      source: "dsbot",
      source_ref: { bot: "chief", chat: "c1" },
      budget_tokens: 2_000_000,
    });
    assert.equal(task.state, "queued");
    assert.equal(task.run_epoch, 0);

    assert.equal(getTask(t.db, task.id)?.intent, "整理桌面截图");
    assert.equal(listTasks(t.db, { state: "queued" }).length, 1);
    assert.equal(listTasks(t.db, { state: ["running", "done"] }).length, 0);

    const running = setTaskState(t.db, task.id, "running", {
      reason: "started",
      expect: ["queued"],
    });
    assert.equal(running?.state, "running");

    // 条件不满足时不改也不抛
    assert.equal(setTaskState(t.db, task.id, "done", { expect: ["queued"] }), null);
    assert.equal(getTask(t.db, task.id)?.state, "running");

    const cancelled = cancelTask(t.db, task.id);
    assert.equal(cancelled?.state, "cancelled");

    assert.equal(verifyChain(t.db).ok, true);
    const types = (
      t.db.prepare("SELECT type FROM events ORDER BY seq ASC").all() as Array<{ type?: string }>
    ).map((r) => String(r.type));
    assert.deepEqual(types, ["task_created", "task_state_changed", "task_state_changed"]);
  } finally {
    t.cleanup();
  }
});

test("approvals：同 subject_key 复用活动单；条件更新只成功一次；一次性消耗", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "建文件夹", declared: {}, source: "dsbot" }).id;
    const subject = computeSubjectKey(taskId, "desktop", { action: "mkdir", name: "test" });

    const first = createApproval(t.db, {
      task_id: taskId,
      kind: "tool_call",
      tier: 4,
      title: "在桌面建文件夹 test",
      detail: { action: "mkdir", name: "test" },
      subject_key: subject,
    });
    assert.equal(first.reused, false);

    // 重发同一动作：复用，不新建（A.6 幂等）
    const again = createApproval(t.db, {
      task_id: taskId,
      kind: "tool_call",
      tier: 4,
      title: "在桌面建文件夹 test",
      detail: { action: "mkdir", name: "test" },
      subject_key: subject,
    });
    assert.equal(again.reused, true);
    assert.equal(again.approval.id, first.approval.id);
    assert.equal(countRows(t.db, "approvals"), 1);

    assert.equal(listOpenApprovals(t.db, taskId).length, 1);

    // 第一次决定成功，第二次是幂等的失败（已被别人决过）
    assert.equal(decideApproval(t.db, first.approval.id, { decision: "approved", decidedBy: "dsbot" }), true);
    assert.equal(decideApproval(t.db, first.approval.id, { decision: "rejected", decidedBy: "cli" }), false);

    assert.equal(markApprovalExecuting(t.db, first.approval.id), true);
    assert.equal(markApprovalExecuting(t.db, first.approval.id), false);
    assert.equal(markApprovalExecuted(t.db, first.approval.id, true), true);
    assert.equal(markApprovalExecuted(t.db, first.approval.id, true), false);

    const row = t.db.prepare("SELECT * FROM approvals WHERE id = ?").get(first.approval.id) as {
      status?: string;
      decided_by?: string;
      executed_at?: string | null;
    };
    assert.equal(row.status, "executed");
    assert.equal(row.decided_by, "dsbot");
    assert.ok(row.executed_at !== null);

    assert.equal(listOpenApprovals(t.db, taskId).length, 0);
    assert.equal(listApprovals(t.db, { status: "executed" }).length, 1);
    assert.equal(isApprovalStatus("executed"), true);
    assert.equal(isApprovalStatus("nonsense"), false);
    assert.equal(verifyChain(t.db).ok, true);
  } finally {
    t.cleanup();
  }
});

test("approvals：TTL 到期转 expired；撤销从任何态生效", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "问一句", declared: {}, source: "dsbot" }).id;

    const expiredOne = createApproval(t.db, {
      task_id: taskId,
      kind: "question",
      tier: 4,
      title: "过期这张",
      detail: {},
      subject_key: "q:1",
      ttlMs: 1000,
      now: new Date(Date.now() - 10_000),
    });

    assert.equal(expireDueApprovals(t.db), 1);
    const row = t.db.prepare("SELECT status FROM approvals WHERE id = ?").get(expiredOne.approval.id) as {
      status?: string;
    };
    assert.equal(row.status, "expired");

    const fresh = createApproval(t.db, {
      task_id: taskId,
      kind: "question",
      tier: 4,
      title: "撤这张",
      detail: {},
      subject_key: "q:2",
    });
    assert.equal(revokeApproval(t.db, fresh.approval.id, "用户改主意"), true);
    assert.equal(revokeApproval(t.db, fresh.approval.id), false);
    const revoked = t.db.prepare("SELECT status FROM approvals WHERE id = ?").get(fresh.approval.id) as {
      status?: string;
    };
    assert.equal(revoked.status, "revoked");
  } finally {
    t.cleanup();
  }
});

test("milestones / plans：建、更新小结、取最新版本", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "做记账网站", declared: {}, source: "dsbot" }).id;

    const ms = createMilestone(t.db, {
      task_id: taskId,
      seq: 1,
      title: "搭骨架",
      done_when: "能跑起来",
      state: "active",
    });
    assert.deepEqual(
      listMilestones(t.db, taskId).map((m) => m.seq),
      [1],
    );

    const updated = updateMilestone(t.db, ms.id, {
      state: "done",
      summary: "骨架搭好，能跑 hello。",
      ended_at: new Date().toISOString(),
    });
    assert.equal(updated?.state, "done");
    assert.equal(updated?.summary, "骨架搭好，能跑 hello。");

    createPlan(t.db, { task_id: taskId, version: 1, content: { steps: [1] }, why: "先骨架" });
    createPlan(t.db, { task_id: taskId, version: 2, content: { steps: [2] }, why: "你要求先登录页" });
    const latest = latestPlan(t.db, taskId);
    assert.equal(latest?.version, 2);
    assert.equal(latest?.why, "你要求先登录页");
    assert.equal(verifyChain(t.db).ok, true);
  } finally {
    t.cleanup();
  }
});

test("decisions / workers / snapshots：写进去读得出来", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "整理", declared: {}, source: "dsbot" }).id;

    recordDecision(t.db, {
      task_id: taskId,
      question: "要不要连子文件夹一起分？",
      answer: "连子文件夹一起",
      decided_by: "dsbot",
    });
    assert.equal(listDecisions(t.db, taskId).length, 1);

    upsertWorker(t.db, {
      id: "w1",
      task_id: taskId,
      role: "worker",
      session_key: `task:${taskId}`,
      status: "running",
      run_epoch: 0,
    });
    upsertWorker(t.db, {
      id: "w1",
      task_id: taskId,
      role: "worker",
      session_key: `task:${taskId}`,
      status: "idle",
      run_epoch: 1,
    });
    const workers = listWorkers(t.db, taskId);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].status, "idle");
    assert.equal(workers[0].run_epoch, 1);

    const snap = createSnapshot(t.db, {
      task_id: taskId,
      milestone_id: "m1",
      kind: "copy",
      ref: "C:/dot/snapshots/T1/m1",
      restore: { from: "C:/Users/1/Desktop/截图" },
    });
    assert.equal(snap.kind, "copy");
    assert.equal(listSnapshots(t.db, taskId).length, 1);
    assert.equal(verifyChain(t.db).ok, true);
  } finally {
    t.cleanup();
  }
});

test("artifacts：同一份内容同一个 hash；取不到就是「已回收」", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const text = "第 1 行\n第 2 行\n" + "x".repeat(100);
    const a = putArtifact(t.db, text);
    const b = putArtifact(t.db, text);
    assert.equal(a.hash, b.hash);
    assert.equal(countRows(t.db, "artifacts"), 1);

    const got = getArtifact(t.db, a.hash);
    assert.equal(got.found, true);
    if (got.found) assert.equal(got.content, text);

    assert.equal(listArtifacts(t.db).length, 1);

    assert.equal(deleteArtifacts(t.db, [a.hash]), 1);
    const gone = getArtifact(t.db, a.hash);
    assert.equal(gone.found, false);
    if (!gone.found) assert.equal(gone.collected, true);

    // 二进制内容也能存
    const bin = putArtifact(t.db, new Uint8Array([0x00, 0x01, 0xff]));
    assert.match(bin.hash, /^[0-9a-f]{64}$/);
  } finally {
    t.cleanup();
  }
});

test("spend_ledger：记账同时累加 tasks.spent_tokens", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, {
      intent: "写点代码",
      declared: {},
      source: "dsbot",
      budget_tokens: 1000,
    }).id;

    recordSpend(t.db, { task_id: taskId, model: "deepseek-v4.1-flash", input_tokens: 100, output_tokens: 20 });
    recordSpend(t.db, { task_id: taskId, model: "glm-5.3", input_tokens: 50, output_tokens: 10 });

    assert.equal(sumSpend(t.db, taskId), 180);
    assert.equal(listSpend(t.db, taskId).length, 2);
    assert.equal(getTask(t.db, taskId)?.spent_tokens, 180);
    assert.equal(verifyChain(t.db).ok, true);
    // 没有 steps 时 steps 链检查也应通过（空表对空链）
    assert.equal(verifyStepsChain(t.db).ok, true);
  } finally {
    t.cleanup();
  }
});

test("records 不写 steps：账本只有入口能写，SQL 直写会被链路核对抓到", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "x", declared: {}, source: "dsbot" }).id;
    // 绕过入口直接塞一行 step（模拟别的模块偷写 SQL）
    t.db
      .prepare(
        `INSERT INTO steps (id, task_id, seq, plan_version, run_epoch, kind, subject_key, side_effect, status)
         VALUES ('sneaky', ?, 1, 1, 0, 'tool', 'k', 'safe', 'started')`,
      )
      .run(taskId);

    const check = verifyStepsChain(t.db);
    assert.equal(check.ok, false);
    assert.equal(check.issues[0].kind, "orphan_row");
  } finally {
    t.cleanup();
  }
});
