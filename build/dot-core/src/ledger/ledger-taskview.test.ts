/**
 * src/ledger/ledger-taskview.test.ts —— 进度卡四问的数据（到哪一步/做过什么/为什么/卡在谁）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireLock,
  beginStep,
  endStep,
  migrate,
  readTaskView,
  renderProgressCard,
} from "./index.ts";
import {
  createApproval,
  createMilestone,
  createPlan,
  createTask,
  makeTempDb,
} from "./test-helpers.ts";

test("readTaskView：四个问题都能从账本直接拼出来", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, {
      id: "T2",
      state: "awaiting_approval",
      intent: "把桌面截图按月份归档",
      restated: "把桌面上「截图」文件夹里的图，按文件名里的月份分到子文件夹",
      budget_tokens: 2_000_000,
      spent_tokens: 12_000,
      blocked_on_json: JSON.stringify({ type: "human", reason: "approval" }),
    });

    const m1 = createMilestone(t.db, taskId, { seq: 1, title: "清点截图", state: "done" });
    const m2 = createMilestone(t.db, taskId, {
      seq: 2,
      title: "按月份分组",
      state: "active",
      doneWhen: "10 月、11 月、12 月三个文件夹里各自的图数对得上",
    });
    createMilestone(t.db, taskId, { seq: 3, title: "写一份清单", state: "pending" });
    t.db.prepare("UPDATE tasks SET milestone_id = ? WHERE id = ?").run(m2, taskId);

    createPlan(t.db, taskId, {
      version: 2,
      why: "你说按文件名里的月份分，不打开看内容",
      milestoneId: m2,
    });

    const s1 = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      tool: "read_dir",
      subject_key: "sha256:s1",
      side_effect: "safe",
      tier: 1,
      milestone_id: m1,
      run_epoch: 0,
    });
    endStep(t.db, s1.id, { status: "succeeded" });

    const s2 = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      tool: "desktop",
      subject_key: "sha256:s2",
      side_effect: "safe",
      tier: 2,
      milestone_id: m2,
      run_epoch: 0,
    });
    endStep(t.db, s2.id, { status: "succeeded" });

    const s3 = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      tool: "desktop",
      subject_key: "sha256:s3",
      side_effect: "unknown",
      tier: 4,
      milestone_id: m2,
      run_epoch: 0,
    });

    createApproval(t.db, {
      taskId,
      stepId: s3.id,
      kind: "question",
      tier: 4,
      title: "要动「10 月」文件夹里的文件",
    });

    const view = readTaskView(t.db, taskId);

    // 到哪一步
    assert.equal(view.where.milestoneSeq, 2);
    assert.equal(view.where.milestoneCount, 3);
    assert.equal(view.where.milestoneTitle, "按月份分组");
    assert.equal(view.where.currentStepSeq, 3);
    assert.equal(view.where.currentStepTool, "desktop");
    assert.equal(view.where.totalSteps, 3);
    assert.equal(view.where.doneSteps, 2);

    // 做过什么
    assert.equal(view.done.length, 2);
    assert.deepEqual(
      view.done.map((s) => s.tool),
      ["read_dir", "desktop"],
    );

    // 为什么
    assert.equal(view.why.planWhy, "你说按文件名里的月份分，不打开看内容");
    assert.equal(view.why.planVersion, 2);
    assert.match(String(view.why.restated), /按文件名里的月份分/);

    // 卡在谁
    assert.equal(view.blockedBy.type, "approval");
    assert.equal(view.blockedBy.waitingFor, "human");
    assert.equal(view.blockedBy.stepId, s3.id);
    assert.ok(view.blockedBy.approvalId !== null);
    assert.equal(view.stateLabel, "等待输入");
    assert.equal(view.awaiting.length, 1);
    assert.equal(view.awaiting[0].title, "要动「10 月」文件夹里的文件");
    // 卡片模板要从 detail_json 渲染，逐字一致（A.6）
    assert.equal(typeof view.awaiting[0].detailJson, "string");
    assert.doesNotThrow(() => JSON.parse(view.awaiting[0].detailJson));

    // 预算与花费
    assert.equal(view.budget.tokens, 2_000_000);
    assert.equal(view.budget.spent, 12_000);
    assert.equal(view.stepCounts.started, 1);
    assert.equal(view.stepCounts.succeeded, 2);

    const card = renderProgressCard(view);
    assert.match(card, /到哪了/);
    assert.match(card, /做过什么/);
    assert.match(card, /卡在谁/);
    assert.match(card, /等你定的事/);
  } finally {
    t.cleanup();
  }
});

test("readTaskView：待批单不擅自改写 running 的外显态（B.8 只认 blocked_on=human）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { id: "T3", state: "running" });
    const approvalId = createApproval(t.db, {
      taskId,
      kind: "tool_call",
      tier: 4,
      title: "要写工作区外的文件",
    });

    const before = readTaskView(t.db, taskId);
    assert.equal(before.blockedBy.type, "approval");
    assert.equal(before.stateLabel, "执行中", "状态列按任务状态走，不按有没有待批单改");

    t.db.prepare("UPDATE approvals SET status = 'approved' WHERE id = ?").run(approvalId);

    const after = readTaskView(t.db, taskId);
    assert.equal(after.blockedBy.type, "none");
    assert.equal(after.blockedBy.waitingFor, "nobody");
    assert.equal(after.stateLabel, "执行中");
    assert.equal(after.awaiting.length, 0);
  } finally {
    t.cleanup();
  }
});

test("readTaskView：queued 且 blocked_on=human → 等待输入（不是「待启动」）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, {
      id: "T3b",
      state: "queued",
      blocked_on_json: JSON.stringify({ type: "human", reason: "unknown_side_effect" }),
    });
    const view = readTaskView(t.db, taskId);
    assert.equal(view.stateLabel, "等待输入");
    assert.equal(view.blockedBy.type, "human");
    assert.equal(view.blockedBy.waitingFor, "human");
  } finally {
    t.cleanup();
  }
});

test("readTaskView：等别人放锁 → 阻塞；自己的旧锁不算卡住", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const holder = createTask(t.db, { id: "T4", state: "running" });
    const waiting = createTask(t.db, { id: "T5", state: "queued" });
    acquireLock(t.db, "desktop", { taskId: holder, workerId: "w1", ttlMs: 60_000 });

    t.db
      .prepare("UPDATE tasks SET blocked_on_json = ? WHERE id = ?")
      .run(JSON.stringify({ type: "lock", resource: "desktop" }), waiting);

    const blocked = readTaskView(t.db, waiting);
    assert.equal(blocked.stateLabel, "阻塞");
    assert.equal(blocked.blockedBy.type, "lock");
    assert.equal(blocked.blockedBy.waitingFor, "worker");
    assert.match(blocked.blockedBy.detail, /等 T4 让出「desktop」/);

    // 反过来：锁在自己名下（上一轮残留）不能显示成「等自己放锁」。
    acquireLock(t.db, "logged_browser", { taskId: waiting, workerId: "w1", ttlMs: 60_000 });
    t.db
      .prepare("UPDATE tasks SET blocked_on_json = ? WHERE id = ?")
      .run(JSON.stringify({ type: "lock", resource: "logged_browser" }), waiting);

    const own = readTaskView(t.db, waiting);
    assert.equal(own.blockedBy.type, "lock");
    assert.equal(own.blockedBy.waitingFor, "nobody");
    assert.match(own.blockedBy.detail, /旧租约/);
    assert.doesNotMatch(own.blockedBy.detail, /等 T5 让出/);
  } finally {
    t.cleanup();
  }
});

test("readTaskView：没有 blocked_on 的 queued 任务不会因为名下有锁就显示阻塞", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { id: "T6", state: "queued" });
    acquireLock(t.db, "desktop", { taskId, workerId: "w1", ttlMs: 60_000 });

    const view = readTaskView(t.db, taskId);
    assert.equal(view.stateLabel, "待启动");
    assert.equal(view.blockedBy.type, "none");
  } finally {
    t.cleanup();
  }
});

test("readTaskView：任务不存在直接抛（fail-closed）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    assert.throws(() => readTaskView(t.db, "nope"), /不存在/);
  } finally {
    t.cleanup();
  }
});
