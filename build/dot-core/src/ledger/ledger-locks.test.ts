/**
 * src/ledger/ledger-locks.test.ts —— locks 表。单例约束靠「BEGIN IMMEDIATE 里读+写」，
 * 两个连接抢同一把锁只能有一个拿到。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireLock,
  getLock,
  migrate,
  openLedger,
  releaseExpiredLocks,
  releaseLock,
  renewLock,
  verifyChain,
} from "./index.ts";
import { createTask, makeTempDb } from "./test-helpers.ts";

test("两个连接抢同一把锁，只有先到的成功", () => {
  const t = makeTempDb();
  const second = openLedger(t.path);
  try {
    migrate(t.db);
    createTask(t.db, { id: "t1" });
    createTask(t.db, { id: "t2" });

    const first = acquireLock(t.db, "desktop", {
      taskId: "t1",
      workerId: "w1",
      ttlMs: 60_000,
    });
    assert.equal(first.acquired, true);
    assert.equal(first.reason, "acquired");
    assert.ok(first.lock !== null);

    // 第二个连接、另一个属主：等 busy_timeout 后读到已提交的行，判负而不抛错。
    const rival = acquireLock(second, "desktop", {
      taskId: "t2",
      workerId: "w2",
      ttlMs: 60_000,
    });
    assert.equal(rival.acquired, false);
    assert.equal(rival.reason, "held");
    assert.equal(rival.lock, null);
    assert.equal(rival.heldBy?.taskId, "t1");
    assert.equal(rival.heldBy?.workerId, "w1");

    // 库里仍只有一行、属主还是 t1。
    const rows = t.db.prepare("SELECT * FROM locks").all() as Array<{
      resource?: string;
      task_id?: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_id, "t1");
  } finally {
    second.close();
    t.cleanup();
  }
});

test("锁的取得与释放也上链", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    createTask(t.db, { id: "t1" });

    acquireLock(t.db, "desktop", { taskId: "t1", workerId: "w1", ttlMs: 60_000 });
    renewLock(t.db, "desktop", { taskId: "t1", workerId: "w1" }, 60_000);
    releaseLock(t.db, "desktop", { taskId: "t1", workerId: "w1" });

    const types = (
      t.db.prepare("SELECT type FROM events ORDER BY seq ASC").all() as Array<{ type?: string }>
    ).map((r) => String(r.type));
    assert.deepEqual(types, ["lock_acquired", "lock_renewed", "lock_released"]);
    assert.equal(verifyChain(t.db).ok, true);
  } finally {
    t.cleanup();
  }
});

test("同属主重复拿锁 = 续租，不报错", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    createTask(t.db, { id: "t1" });

    const a = acquireLock(t.db, "desktop", { taskId: "t1", workerId: "w1", ttlMs: 30_000 });
    assert.equal(a.reason, "acquired");

    const b = acquireLock(t.db, "desktop", { taskId: "t1", workerId: "w1", ttlMs: 30_000 });
    assert.equal(b.acquired, true);
    assert.equal(b.reason, "renewed");
  } finally {
    t.cleanup();
  }
});

test("renewLock 只有属主能续，releaseLock 只有属主能放", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    createTask(t.db, { id: "t1" });
    createTask(t.db, { id: "t2" });

    acquireLock(t.db, "desktop", { taskId: "t1", workerId: "w1", ttlMs: 60_000 });

    assert.equal(renewLock(t.db, "desktop", { taskId: "t2", workerId: "w2" }), false);
    assert.equal(renewLock(t.db, "desktop", { taskId: "t1", workerId: "w1" }, 120_000), true);
    const renewed = getLock(t.db, "desktop");
    assert.ok(renewed !== null);

    assert.equal(releaseLock(t.db, "desktop", { taskId: "t2", workerId: "w2" }), false);
    assert.equal(releaseLock(t.db, "desktop", { taskId: "t1", workerId: "w1" }), true);
    assert.equal(getLock(t.db, "desktop"), null);
  } finally {
    t.cleanup();
  }
});

test("过期的锁可以被别的属主接管；releaseExpiredLocks 清掉过期行", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    createTask(t.db, { id: "t1" });
    createTask(t.db, { id: "t2" });
    const past = new Date(Date.now() - 60_000).toISOString();

    t.db
      .prepare(
        `INSERT INTO locks (resource, task_id, worker_id, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("desktop", "t1", "w1", past, past, past);

    const takeover = acquireLock(t.db, "desktop", {
      taskId: "t2",
      workerId: "w2",
      ttlMs: 60_000,
    });
    assert.equal(takeover.acquired, true);
    assert.equal(getLock(t.db, "desktop")?.task_id, "t2");

    // 再造一条过期的，批量释放。
    t.db
      .prepare(
        `INSERT INTO locks (resource, task_id, worker_id, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("logged_browser", "t1", "w1", past, past, past);

    const released = releaseExpiredLocks(t.db);
    assert.deepEqual(
      released.map((r) => r.resource),
      ["logged_browser"],
    );
    assert.ok(getLock(t.db, "desktop") !== null, "没过期的锁不许被带走");
  } finally {
    t.cleanup();
  }
});
