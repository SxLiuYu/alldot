/**
 * src/ledger/ledger-core.test.ts —— 建表、PRAGMA、写前记账的顺序、哈希链、steps 上链。
 * 跑法：node build/tools/run-tests.mjs --only ledger
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  beginStep,
  endStep,
  getStep,
  LEDGER_TABLES,
  migrate,
  missingTables,
  openLedger,
  pragmaValue,
  verifyChain,
  verifyStepsChain,
  appendEvent,
  getUserVersion,
  LedgerError,
  type StepInput,
} from "./index.ts";
import { countRows, createTask, makeTempDb } from "./test-helpers.ts";

test("migrate：幂等，跑两次不报错，十二张表齐", () => {
  const t = makeTempDb();
  try {
    assert.equal(getUserVersion(t.db), 0);

    const first = migrate(t.db);
    assert.equal(first.from, 0);
    assert.equal(first.to, 1);
    assert.deepEqual(first.applied, ["001_ledger"]);
    assert.deepEqual(missingTables(t.db), []);
    assert.equal(LEDGER_TABLES.length, 12);

    const second = migrate(t.db);
    assert.equal(second.to, 1);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(missingTables(t.db), []);
  } finally {
    t.cleanup();
  }
});

test("openLedger：WAL + synchronous=FULL + foreign_keys=ON", () => {
  const t = makeTempDb();
  try {
    assert.equal(String(pragmaValue(t.db, "journal_mode")).toLowerCase(), "wal");
    assert.equal(Number(pragmaValue(t.db, "synchronous")), 2);
    assert.equal(Number(pragmaValue(t.db, "foreign_keys")), 1);
  } finally {
    t.cleanup();
  }
});

test("外键真的在拦：给不存在的任务插步骤会报 FOREIGN KEY", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    assert.throws(() => {
      t.db
        .prepare(
          `INSERT INTO steps (id, task_id, seq, plan_version, run_epoch, kind,
             subject_key, side_effect, status)
           VALUES ('s1', 'no-such-task', 1, 1, 0, 'tool', 'k', 'safe', 'started')`,
        )
        .run();
    }, /FOREIGN KEY/i);

    assert.throws(
      () =>
        beginStep(t.db, {
          task_id: "no-such-task",
          kind: "tool",
          subject_key: "k",
          side_effect: "safe",
          run_epoch: 0,
        }),
      (err: unknown) => err instanceof LedgerError && err.code === "task_not_found",
    );
  } finally {
    t.cleanup();
  }
});

test("写前记账：beginStep 返回前已 COMMIT，执行器抛错也留着 started", () => {
  const t = makeTempDb();
  const reader = openLedger(t.path);
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });

    let stepId = "";
    let executorSawStep = "";

    const fakeExecutor = (id: string): never => {
      const row = reader
        .prepare("SELECT status FROM steps WHERE id = ?")
        .get(id) as { status?: string } | undefined;
      executorSawStep = String(row?.status ?? "");
      throw new Error("executor boom");
    };

    assert.throws(() => {
      const step = beginStep(t.db, {
        task_id: taskId,
        kind: "tool",
        tool: "desktop",
        subject_key: "sha256:abc",
        side_effect: "unknown",
        tier: 4,
        run_epoch: 0,
      });
      stepId = step.id;
      // 这里是关键：beginStep 已经返回（= INSERT 已 COMMIT），执行器才被调用。
      fakeExecutor(step.id);
    }, /executor boom/);

    assert.equal(executorSawStep, "started");

    const after = getStep(t.db, stepId);
    assert.ok(after !== null);
    assert.equal(after.status, "started");
    assert.equal(after.ended_at, null);
    assert.equal(after.side_effect, "unknown");
    assert.equal(countRows(t.db, "steps"), 1);
  } finally {
    reader.close();
    t.cleanup();
  }
});

test("endStep：记结果，重复调用幂等且不覆盖终态", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });
    const step = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      tool: "desktop",
      subject_key: "sha256:def",
      side_effect: "safe",
      tier: 1,
      run_epoch: 0,
    });
    assert.equal(step.status, "started");
    assert.equal(step.seq, 1);

    const ok = endStep(t.db, step.id, {
      status: "succeeded",
      result_ref: "artifact:aaa",
      result_hash: "h1",
    });
    assert.equal(ok.applied, true);
    assert.equal(ok.step?.status, "succeeded");
    assert.equal(ok.step?.result_ref, "artifact:aaa");
    assert.ok(ok.step?.ended_at !== null);

    const again = endStep(t.db, step.id, { status: "failed", error: "late failure" });
    assert.equal(again.applied, false);
    assert.equal(again.step?.status, "succeeded");
    assert.equal(again.step?.error, null);

    const step2 = beginStep(t.db, {
      task_id: taskId,
      kind: "llm",
      subject_key: "sha256:ghi",
      side_effect: "safe",
      run_epoch: 0,
    });
    assert.equal(step2.seq, 2);
  } finally {
    t.cleanup();
  }
});

test("endStep：回退能把已成功的步标 rolled_back（A.11），但不重复标", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });
    const step = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      tool: "desktop",
      subject_key: "sha256:roll",
      side_effect: "safe",
      run_epoch: 0,
    });
    endStep(t.db, step.id, { status: "succeeded" });

    const rolled = endStep(t.db, step.id, { status: "rolled_back", error: "用户说退回第 2 步" });
    assert.equal(rolled.applied, true);
    assert.equal(rolled.step?.status, "rolled_back");

    const again = endStep(t.db, step.id, { status: "rolled_back" });
    assert.equal(again.applied, false);
  } finally {
    t.cleanup();
  }
});

test("beginStep：带旧 run_epoch 被 stale_writer 拒收；不给 run_epoch 直接拒", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running", run_epoch: 3 });

    assert.throws(
      () =>
        beginStep(t.db, {
          task_id: taskId,
          kind: "tool",
          subject_key: "k",
          side_effect: "safe",
          run_epoch: 2,
        }),
      (err: unknown) => err instanceof LedgerError && err.code === "stale_writer",
    );

    // 省略 run_epoch：不许默默取当前值（否则 fencing 形同虚设）。
    assert.throws(
      () =>
        beginStep(t.db, {
          task_id: taskId,
          kind: "tool",
          subject_key: "k",
          side_effect: "safe",
        } as unknown as StepInput),
      (err: unknown) => err instanceof LedgerError && err.code === "missing_run_epoch",
    );

    const ok = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      subject_key: "k",
      side_effect: "safe",
      run_epoch: 3,
    });
    assert.equal(ok.run_epoch, 3);
  } finally {
    t.cleanup();
  }
});

test("beginStep：终态任务不许再记账动手", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "cancelled" });
    assert.throws(
      () =>
        beginStep(t.db, {
          task_id: taskId,
          kind: "tool",
          subject_key: "k",
          side_effect: "safe",
          run_epoch: 0,
        }),
      (err: unknown) => err instanceof LedgerError && err.code === "task_terminal",
    );
    assert.equal(countRows(t.db, "steps"), 0);
  } finally {
    t.cleanup();
  }
});

test("beginStep：拒绝在别人的事务里跑（否则「返回即提交」会作废）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });
    t.db.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(
        () =>
          beginStep(t.db, {
            task_id: taskId,
            kind: "tool",
            subject_key: "k",
            side_effect: "safe",
            run_epoch: 0,
          }),
        (err: unknown) => err instanceof LedgerError && err.code === "nested_transaction",
      );
    } finally {
      t.db.exec("COMMIT");
    }
  } finally {
    t.cleanup();
  }
});

test("beginStep：epoch 校验与写入在同一个事务里（别人持写锁时不可能读到旧 epoch）", () => {
  const t = makeTempDb();
  // 持锁方用默认等待；写的一方等待很短：拿不到写锁立刻报错，而不是排到后面读到旧值。
  const holder = openLedger(t.path);
  const writer = openLedger(t.path, { busyTimeoutMs: 50 });
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });

    // 另一个连接先拿写锁并把 epoch 改成 1，但不提交。
    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("UPDATE tasks SET run_epoch = 1 WHERE id = ?").run(taskId);

    // 此时带着旧 epoch=0 来写：必须写不进去（拿不到写锁），而不是读到 0 就放行。
    assert.throws(
      () =>
        beginStep(writer, {
          task_id: taskId,
          kind: "tool",
          subject_key: "k",
          side_effect: "safe",
          run_epoch: 0,
        }),
      /locked|busy/i,
    );

    holder.exec("COMMIT");

    // 对方提交后再来：读到的是新 epoch，旧值被 stale_writer 拦住。
    assert.throws(
      () =>
        beginStep(writer, {
          task_id: taskId,
          kind: "tool",
          subject_key: "k",
          side_effect: "safe",
          run_epoch: 0,
        }),
      (err: unknown) => err instanceof LedgerError && err.code === "stale_writer",
    );
    assert.equal(countRows(t.db, "steps"), 0);
  } finally {
    holder.close();
    writer.close();
    t.cleanup();
  }
});

test("哈希链：正常时 ok；改一个字段能定位到断链那一条", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    appendEvent(t.db, { type: "task_created", payload: { task_id: "t1" } });
    appendEvent(t.db, { type: "step_started", payload: { task_id: "t1", seq: 1 } });
    appendEvent(t.db, { type: "step_ended", payload: { task_id: "t1", seq: 1 } });

    const before = verifyChain(t.db);
    assert.equal(before.ok, true);
    assert.equal(before.brokenAt, null);
    assert.equal(before.count, 3);
    assert.equal(before.lastHash.length, 64);
  } finally {
    t.cleanup();
  }
});

test("哈希链：篡改 payload_json 被查出（hash_mismatch）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    appendEvent(t.db, { type: "a", payload: { n: 1 } });
    appendEvent(t.db, { type: "b", payload: { n: 2 } });
    appendEvent(t.db, { type: "c", payload: { n: 3 } });

    t.db.prepare("UPDATE events SET payload_json = ? WHERE seq = 2").run('{"n":99}');

    const broken = verifyChain(t.db);
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, 2);
    assert.equal(broken.reason, "hash_mismatch");
  } finally {
    t.cleanup();
  }
});

test("哈希链：篡改 prev_hash 被查出（prev_hash_mismatch）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    appendEvent(t.db, { type: "a", payload: null });
    appendEvent(t.db, { type: "b", payload: null });

    t.db.prepare("UPDATE events SET prev_hash = ? WHERE seq = 2").run("f".repeat(64));

    const broken = verifyChain(t.db);
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, 2);
    assert.equal(broken.reason, "prev_hash_mismatch");
  } finally {
    t.cleanup();
  }
});

test("哈希链：删掉中间一条也会被发现", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    appendEvent(t.db, { type: "a", payload: null });
    appendEvent(t.db, { type: "b", payload: null });
    appendEvent(t.db, { type: "c", payload: null });

    t.db.prepare("DELETE FROM events WHERE seq = 2").run();

    const broken = verifyChain(t.db);
    assert.equal(broken.ok, false);
    assert.equal(broken.brokenAt, 3);
    assert.equal(broken.reason, "prev_hash_mismatch");
  } finally {
    t.cleanup();
  }
});

test("steps 上链：begin/end 自动写事件，链和快照都对得上", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });
    const step = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      tool: "desktop",
      subject_key: "sha256:onchain",
      side_effect: "unknown",
      tier: 4,
      run_epoch: 0,
    });
    endStep(t.db, step.id, { status: "succeeded" });

    const types = (
      t.db.prepare("SELECT type FROM events ORDER BY seq ASC").all() as Array<{ type?: string }>
    ).map((r) => String(r.type));
    assert.deepEqual(types, ["step_started", "step_ended"]);
    assert.equal(verifyChain(t.db).ok, true);

    const steps = verifyStepsChain(t.db);
    assert.equal(steps.ok, true, JSON.stringify(steps.issues));
    assert.equal(steps.rowCount, 1);
    assert.equal(steps.trackedCount, 1);
  } finally {
    t.cleanup();
  }
});

test("steps 上链：改行里的一个字段就被 verifyStepsChain 揪出来", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });
    const step = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      tool: "desktop",
      subject_key: "sha256:tamper",
      side_effect: "unknown",
      tier: 4,
      run_epoch: 0,
    });
    endStep(t.db, step.id, { status: "failed", error: "被拦下" });

    // 模拟有人手改：把「结果不明」改成「安全且成功」，还换了工具名。
    t.db
      .prepare("UPDATE steps SET side_effect='safe', status='succeeded', tool='read_file' WHERE id=?")
      .run(step.id);

    const check = verifyStepsChain(t.db);
    assert.equal(check.ok, false);
    const fields = check.issues.filter((i) => i.kind === "field_mismatch").map((i) => i.field);
    assert.ok(fields.includes("side_effect"));
    assert.ok(fields.includes("status"));
    assert.ok(fields.includes("tool"));
  } finally {
    t.cleanup();
  }
});

test("steps 上链：删掉一行也被查出来（missing_row）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { state: "running" });
    const step = beginStep(t.db, {
      task_id: taskId,
      kind: "tool",
      subject_key: "sha256:deleted",
      side_effect: "safe",
      run_epoch: 0,
    });
    t.db.prepare("DELETE FROM steps WHERE id = ?").run(step.id);

    const check = verifyStepsChain(t.db);
    assert.equal(check.ok, false);
    assert.equal(check.issues[0].kind, "missing_row");
    assert.equal(check.issues[0].stepId, step.id);
  } finally {
    t.cleanup();
  }
});
