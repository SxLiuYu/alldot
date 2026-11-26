/**
 * src/ledger/ledger-recovery.test.ts —— 恢复协议（A.9 五步）。
 * 重点：unknown 的孤儿步绝不被重放，只标 interrupted + 挂问人审批；
 * 完整性校验不通过时拒绝恢复（不替篡改洗白）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireLock,
  beginStep,
  getLock,
  getStep,
  latestRecoveryReport,
  LedgerIntegrityError,
  migrate,
  recover,
  verifyChain,
  verifyStepsChain,
} from "./index.ts";
import { countRows, createTask, makeTempDb } from "./test-helpers.ts";

function seedCrashedRun(db: ReturnType<typeof makeTempDb>["db"]) {
  const taskUnknown = createTask(db, { id: "t-unknown", state: "running" });
  const taskSafe = createTask(db, { id: "t-safe", state: "running" });
  const taskPending = createTask(db, { id: "t-pending", state: "running" });
  const taskEmpty = createTask(db, { id: "t-empty", state: "running" });

  const stepUnknown = beginStep(db, {
    task_id: taskUnknown,
    kind: "tool",
    tool: "desktop",
    subject_key: "sha256:unknown",
    side_effect: "unknown",
    tier: 4,
    run_epoch: 0,
  });

  const stepReplay = beginStep(db, {
    task_id: taskSafe,
    kind: "tool",
    tool: "logged_browser",
    subject_key: "sha256:replay",
    side_effect: "replayable",
    tier: 3,
    run_epoch: 0,
  });

  const stepSafe = beginStep(db, {
    task_id: taskSafe,
    kind: "tool",
    tool: "read_file",
    subject_key: "sha256:safe",
    side_effect: "safe",
    tier: 1,
    run_epoch: 0,
  });

  const stepPending = beginStep(db, {
    task_id: taskPending,
    kind: "llm",
    subject_key: "sha256:llm",
    side_effect: "safe",
    run_epoch: 0,
  });

  // 旧 worker 的租约：恢复时必须一并放开，否则新 worker 会输给自己的幽灵。
  acquireLock(db, "desktop", { taskId: taskUnknown, workerId: "w-old", ttlMs: 3_600_000 });

  return {
    taskUnknown,
    taskSafe,
    taskPending,
    taskEmpty,
    stepUnknown,
    stepReplay,
    stepSafe,
    stepPending,
  };
}

test("recover：整链校验通过，run_epoch 加一，running 任务都有归位", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const f = seedCrashedRun(t.db);

    const report = recover(t.db);

    assert.equal(report.integrity.sqliteOk, true);
    assert.equal(report.integrity.fkOk, true);
    assert.equal(report.integrity.chainOk, true);
    assert.equal(report.integrity.stepsChainOk, true);

    assert.equal(report.runEpochBumped.length, 4);
    for (const b of report.runEpochBumped) assert.equal(b.to, b.from + 1);

    assert.deepEqual(report.tasksAwaitingHuman, [f.taskUnknown]);
    const requeued = report.tasksRequeued.map((r) => r.taskId);
    assert.ok(requeued.includes(f.taskSafe));
    assert.ok(requeued.includes(f.taskPending));
    assert.ok(requeued.includes(f.taskEmpty));
    for (const r of report.tasksRequeued) assert.equal(r.attempt, 1);

    assert.equal(getStep(t.db, f.stepUnknown.id)?.status, "interrupted");
    assert.equal(getStep(t.db, f.stepReplay.id)?.status, "interrupted");
    assert.equal(getStep(t.db, f.stepSafe.id)?.status, "interrupted");
    assert.equal(getStep(t.db, f.stepPending.id)?.status, "interrupted");

    // 旧锁被放开
    assert.equal(getLock(t.db, "desktop"), null);
    assert.deepEqual(
      report.locksReleasedForRecoveredTasks.map((l) => l.resource),
      ["desktop"],
    );

    assert.ok(report.reportEventSeq > 0);
    assert.equal(verifyChain(t.db).ok, true);
    assert.equal(verifyStepsChain(t.db).ok, true, JSON.stringify(verifyStepsChain(t.db).issues));

    const saved = latestRecoveryReport(t.db) as {
      headline?: string;
      tasks_requeued?: Array<{ attempt?: number }>;
    } | null;
    assert.ok(saved !== null);
    assert.match(String(saved.headline), /恢复了 3 个任务/);
    assert.equal(saved.tasks_requeued?.[0]?.attempt, 1);
  } finally {
    t.cleanup();
  }
});

test("recover：unknown 的步不被重放——只标 interrupted 并挂一张问人审批", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const f = seedCrashedRun(t.db);
    const stepsBefore = countRows(t.db, "steps");
    const approvalsBefore = countRows(t.db, "approvals");

    const report = recover(t.db);

    // 没有新增步骤行 = 没有任何一步被「重放」成一个新动作。
    assert.equal(countRows(t.db, "steps"), stepsBefore);
    assert.equal(countRows(t.db, "approvals"), approvalsBefore + 1);
    assert.equal(report.orphans.filter((o) => o.outcome === "needs_approval").length, 1);

    const approval = t.db
      .prepare("SELECT * FROM approvals WHERE step_id = ?")
      .get(f.stepUnknown.id) as
      | {
          kind?: string;
          status?: string;
          subject_key?: string;
          tier?: number;
          pending_until?: string;
          detail_json?: string;
        }
      | undefined;

    assert.ok(approval !== undefined, "unknown 步必须挂审批");
    assert.equal(approval.kind, "question");
    assert.equal(approval.status, "pending");
    assert.equal(approval.subject_key, `unk:${f.stepUnknown.id}`);
    assert.equal(approval.tier, 4);
    assert.ok(String(approval.pending_until) > new Date().toISOString());

    const detail = JSON.parse(String(approval.detail_json)) as {
      reason?: string;
      step_id?: string;
      options?: string[];
    };
    assert.equal(detail.reason, "unknown_side_effect");
    assert.equal(detail.step_id, f.stepUnknown.id);
    assert.ok(Array.isArray(detail.options) && detail.options.length >= 2);

    const taskRow = t.db.prepare("SELECT * FROM tasks WHERE id = ?").get(f.taskUnknown) as {
      state?: string;
      state_reason?: string;
      blocked_on_json?: string | null;
    };
    assert.equal(taskRow.state, "awaiting_approval");
    assert.equal(taskRow.state_reason, "recovered_unknown_side_effect");
    const blocked = JSON.parse(String(taskRow.blocked_on_json)) as {
      type?: string;
      approval_ids?: string[];
      step_ids?: string[];
    };
    assert.equal(blocked.type, "human");
    assert.equal(blocked.approval_ids?.length, 1);
    assert.deepEqual(blocked.step_ids, [f.stepUnknown.id]);

    const safeTask = t.db.prepare("SELECT state FROM tasks WHERE id = ?").get(f.taskSafe) as {
      state?: string;
    };
    assert.equal(safeTask.state, "queued");
    assert.equal(countRows(t.db, "approvals") - approvalsBefore, 1);
  } finally {
    t.cleanup();
  }
});

test("recover：跑两次幂等——不重复建审批、不重复处理孤儿步", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    seedCrashedRun(t.db);

    const first = recover(t.db);
    const approvalsAfterFirst = countRows(t.db, "approvals");
    const stepsAfterFirst = countRows(t.db, "steps");

    const second = recover(t.db);

    assert.equal(first.orphans.length, 4);
    assert.equal(second.orphans.length, 0, "第二次没有孤儿步可处理");
    assert.equal(second.tasksRequeued.length, 0, "已经回 queued 的任务不再重排计数");
    assert.equal(countRows(t.db, "approvals"), approvalsAfterFirst);
    assert.equal(countRows(t.db, "steps"), stepsAfterFirst);
    assert.equal(verifyChain(t.db).ok, true);
    assert.equal(verifyStepsChain(t.db).ok, true);
  } finally {
    t.cleanup();
  }
});

test("recover：attempt 每次重排 +1（B.8 没这一列，记在 task_requeued 事件里）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { id: "t-attempt", state: "running" });
    beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      subject_key: "sha256:a1",
      side_effect: "safe",
      run_epoch: 0,
    });

    const first = recover(t.db);
    assert.equal(first.tasksRequeued[0]?.attempt, 1);

    // 调度器又把任务捡起来跑了一轮，然后再次崩溃。
    t.db.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run(taskId);
    beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      subject_key: "sha256:a2",
      side_effect: "safe",
      run_epoch: 1,
    });

    const second = recover(t.db);
    assert.equal(second.tasksRequeued[0]?.attempt, 2);

    const attempts = (
      t.db
        .prepare("SELECT payload_json FROM events WHERE type = 'task_requeued' ORDER BY seq ASC")
        .all() as Array<{ payload_json?: string }>
    ).map((r) => JSON.parse(String(r.payload_json)).attempt as number);
    assert.deepEqual(attempts, [1, 2]);
  } finally {
    t.cleanup();
  }
});

test("recover：第 4 步释放过期锁，保留未过期的", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { id: "t-lock", state: "awaiting_approval" });
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    t.db
      .prepare(
        `INSERT INTO locks (resource, task_id, worker_id, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("desktop", taskId, "w1", past, past, past);
    t.db
      .prepare(
        `INSERT INTO locks (resource, task_id, worker_id, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("logged_browser", taskId, "w2", past, past, future);

    const report = recover(t.db);

    assert.equal(report.expiredLocksReleased.length, 1);
    assert.equal(report.expiredLocksReleased[0].resource, "desktop");
    const left = t.db.prepare("SELECT resource FROM locks").all() as Array<{ resource?: string }>;
    assert.deepEqual(
      left.map((r) => r.resource),
      ["logged_browser"],
    );

    const task = t.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as {
      state?: string;
    };
    assert.equal(task.state, "awaiting_approval");
    assert.equal(report.awaitingResent.length, 1);
    assert.equal(report.awaitingResent[0].taskId, taskId);
  } finally {
    t.cleanup();
  }
});

test("recover：外键坏了的库拒绝恢复", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    t.db.exec("PRAGMA foreign_keys = OFF");
    t.db
      .prepare(
        "INSERT INTO steps (id, task_id, seq, plan_version, run_epoch, kind, subject_key, side_effect, status) VALUES ('bad', 'ghost', 1, 1, 0, 'tool', 'k', 'safe', 'started')",
      )
      .run();
    t.db.exec("PRAGMA foreign_keys = ON");

    assert.throws(() => recover(t.db), /外键校验失败/);
  } finally {
    t.cleanup();
  }
});

test("recover：steps 被人改过 → 拒绝恢复，且不把篡改值写进链洗白", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const f = seedCrashedRun(t.db);
    // 把 unknown 改成 safe：如果恢复继续跑，interrupted 快照会把篡改后的行当成事实。
    t.db.prepare("UPDATE steps SET side_effect = 'safe' WHERE id = ?").run(f.stepUnknown.id);

    assert.throws(
      () => recover(t.db),
      (err: unknown) => err instanceof LedgerIntegrityError && /steps 与链上快照不一致/.test(err.message),
    );

    // 拒绝之后：行还是被改的样子，链上仍能查出来；没有挂审批、任务没动。
    const check = verifyStepsChain(t.db);
    assert.equal(check.ok, false);
    assert.ok(check.issues.some((i) => i.field === "side_effect"));
    assert.equal(countRows(t.db, "approvals"), 0);
    const task = t.db.prepare("SELECT state FROM tasks WHERE id = ?").get(f.taskUnknown) as {
      state?: string;
    };
    assert.equal(task.state, "running");
    // 拒绝的证据留在链上
    const aborted = t.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'recovery_aborted'")
      .get() as { n?: number };
    assert.equal(Number(aborted.n), 1);
  } finally {
    t.cleanup();
  }
});
