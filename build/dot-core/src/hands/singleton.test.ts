/**
 * src/hands/singleton.test.ts —— 三把手锁的验收。
 *
 * 钉住四条：
 * 1. 两个任务同时拿同一把锁，只成功一个，失败方知道「谁占着、什么时候过期」；
 * 2. 同一任务重复拿自己的锁＝续期（renewed），不算冲突；
 * 3. 异常路径也释放（withHandLock 的 finally）；
 * 4. resource 名固定三把。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { migrate } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import {
  HAND_LOCK_RESOURCES,
  acquireHandLock,
  peekHandLock,
  withHandLock,
} from "./singleton.ts";

function makeDb(): { db: ReturnType<typeof makeTempDb>["db"]; cleanup: () => void } {
  const tmp = makeTempDb();
  migrate(tmp.db);
  return { db: tmp.db, cleanup: () => tmp.cleanup() };
}

test("resource 名固定三把", () => {
  assert.deepEqual([...HAND_LOCK_RESOURCES], ["hand:desktop", "hand:logged_browser", "hand:clean_browser"]);
});

test("两个任务抢同一把锁：只成功一个，失败方拿到 busy + 占用信息", () => {
  const { db, cleanup } = makeDb();
  try {
    const t1 = createTask(db, { intent: "先用桌面" });
    const t2 = createTask(db, { intent: "也想用桌面" });

    const a = acquireHandLock({ db, resource: "hand:desktop", taskId: t1 });
    assert.equal(a.ok, true);
    assert.equal(a.ok ? a.mode : "", "acquired");

    const b = acquireHandLock({ db, resource: "hand:desktop", taskId: t2 });
    assert.equal(b.ok, false);
    assert.equal(b.ok ? "" : b.code, "busy");
    assert.equal(b.ok ? null : b.heldBy?.taskId, t1);
    assert.match(b.ok ? "" : b.detail, new RegExp(t1));
    assert.match(b.ok ? "" : b.detail, /过期/);

    if (a.ok) assert.equal(a.release(), true);
    assert.equal(peekHandLock(db, "hand:desktop"), null);

    // 放掉之后别人能拿到
    const c = acquireHandLock({ db, resource: "hand:desktop", taskId: t2 });
    assert.equal(c.ok, true);
    if (c.ok) c.release();
  } finally {
    cleanup();
  }
});

test("同一任务重复拿同一把锁＝续期，且释放要配对（先放一个不删行）", () => {
  const { db, cleanup } = makeDb();
  try {
    const t1 = createTask(db, { intent: "连续动作" });
    const t2 = createTask(db, { intent: "等着用" });

    const first = acquireHandLock({ db, resource: "hand:logged_browser", taskId: t1, ttlMs: 60_000 });
    assert.equal(first.ok, true);
    const second = acquireHandLock({ db, resource: "hand:logged_browser", taskId: t1, ttlMs: 60_000 });
    assert.equal(second.ok, true);
    assert.equal(second.ok ? second.mode : "", "renewed");

    // 先结束的那个调用只减计数，不许把另一个还在跑的调用的锁删掉。
    if (second.ok) assert.equal(second.release(), true);
    assert.ok(peekHandLock(db, "hand:logged_browser") !== null, "还有一份持有，锁行必须留着");
    const intruder = acquireHandLock({ db, resource: "hand:logged_browser", taskId: t2 });
    assert.equal(intruder.ok, false, "同任务还在跑时别的任务拿不到");
    assert.equal(intruder.ok ? "" : intruder.code, "busy");

    if (first.ok) assert.equal(first.release(), true);
    assert.equal(peekHandLock(db, "hand:logged_browser"), null, "最后一个持有者才删行");
    const later = acquireHandLock({ db, resource: "hand:logged_browser", taskId: t2 });
    assert.equal(later.ok, true);
    if (later.ok) later.release();
  } finally {
    cleanup();
  }
});

test("withHandLock：业务抛异常也把锁放掉", async () => {
  const { db, cleanup } = makeDb();
  try {
    const t1 = createTask(db, { intent: "会炸的动作" });
    let sawError = false;
    try {
      await withHandLock({ db, resource: "hand:clean_browser", taskId: t1 }, async () => {
        assert.ok(peekHandLock(db, "hand:clean_browser") !== null, "执行期间锁在");
        throw new Error("boom");
      });
    } catch (err) {
      sawError = true;
      assert.match((err as Error).message, /boom/);
    }
    assert.equal(sawError, true);
    assert.equal(peekHandLock(db, "hand:clean_browser"), null, "异常后锁必须放掉");
  } finally {
    cleanup();
  }
});

test("withHandLock：拿不到锁返回 busy，不执行回调", async () => {
  const { db, cleanup } = makeDb();
  try {
    const t1 = createTask(db, { intent: "占着" });
    const t2 = createTask(db, { intent: "等锁" });
    const held = acquireHandLock({ db, resource: "hand:desktop", taskId: t1 });
    assert.equal(held.ok, true);

    let ran = false;
    const out = await withHandLock({ db, resource: "hand:desktop", taskId: t2 }, () => {
      ran = true;
      return 1;
    });
    assert.equal(out.ok, false);
    assert.equal(out.ok ? "" : out.code, "busy");
    assert.equal(ran, false);

    if (held.ok) held.release();
  } finally {
    cleanup();
  }
});
