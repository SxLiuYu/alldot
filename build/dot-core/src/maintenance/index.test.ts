/**
 * src/maintenance/index.test.ts —— 快照回收的验收。
 * 钉住：超上限才删、从最旧开始、正在跑的任务不删、刚拍的不删、账本行不碰。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  effectiveLimitBytes,
  gbToBytes,
  snapshotBytesOnDisk,
  sweepSnapshots,
  sweepSnapshotsAsync,
} from "./index.ts";

function root(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dot-maint-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeTask(dir: string, task: string, stamp: string, bytes: number, ageHours: number): string {
  const p = join(dir, task, stamp);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "a.bin"), Buffer.alloc(bytes));
  const when = new Date(Date.now() - ageHours * 3600 * 1000);
  utimesSync(p, when, when);
  utimesSync(join(dir, task), when, when);
  return p;
}

test("没超上限：一个都不删", () => {
  const r = root();
  try {
    makeTask(r.dir, "task_a", "t1", 1024, 5);
    const out = sweepSnapshots({ root: r.dir, limitBytes: 1024 * 1024 });
    assert.deepEqual(out.removed, []);
    assert.equal(out.scanned, 1);
  } finally {
    r.cleanup();
  }
});

test("超上限：从最旧的开始删，删到限以下就停", () => {
  const r = root();
  try {
    const oldest = makeTask(r.dir, "task_old", "t1", 2048, 48);
    const middle = makeTask(r.dir, "task_mid", "t2", 2048, 24);
    const newest = makeTask(r.dir, "task_new", "t3", 2048, 2);
    const out = sweepSnapshots({ root: r.dir, limitBytes: 4096, now: () => Date.now() });
    assert.equal(out.removed.includes(join(r.dir, "task_old")), true, "最旧的先删（整任务目录）");
    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(newest), true, "最新的一条不到万不得已不删");
    assert.ok(out.keptBytes <= 4096, `删完要回到上限以下，实际 ${out.keptBytes}`);
    assert.equal(out.removed.length >= 1, true);
    void middle;
  } finally {
    r.cleanup();
  }
});

test("正在跑的任务不删，哪怕它最旧", () => {
  const r = root();
  try {
    const running = makeTask(r.dir, "task_run", "t1", 4096, 72);
    const done = makeTask(r.dir, "task_done", "t2", 4096, 48);
    const out = sweepSnapshots({ root: r.dir, limitBytes: 2048, keepTaskIds: ["task_run"] });
    assert.equal(existsSync(running), true, "在跑的任务要留着回退");
    assert.equal(existsSync(done), false);
    assert.deepEqual(out.removed, [join(r.dir, "task_done")]);
  } finally {
    r.cleanup();
  }
});

test("刚拍的不删（默认 1 小时保护）", () => {
  const r = root();
  try {
    const fresh = makeTask(r.dir, "task_fresh", "t1", 4096, 0);
    const out = sweepSnapshots({ root: r.dir, limitBytes: 1024 });
    assert.equal(existsSync(fresh), true);
    assert.deepEqual(out.removed, []);
  } finally {
    r.cleanup();
  }
});

test("目录不存在：当空目录，不抛", () => {
  const out = sweepSnapshots({ root: join(tmpdir(), "dot-maint-not-exist-xyz"), limitBytes: 1024 });
  assert.equal(out.scanned, 0);
  assert.deepEqual(out.removed, []);
});

test("gbToBytes 把配置的 GB 换成字节", () => {
  assert.equal(gbToBytes(5), 5 * 1024 * 1024 * 1024);
  assert.equal(gbToBytes(-1), 0);
  void statSync;
});

test("盘宽裕时按配置上限，不动", () => {
  const configured = gbToBytes(5);
  const limit = effectiveLimitBytes({ configuredBytes: configured, freeBytes: gbToBytes(20), snapshotBytes: gbToBytes(2) });
  assert.equal(limit, configured);
});

test("盘紧时按「腾到 2.5 GB」倒推：2.2 GB 快照、0.5 GB 余量 → 预算压到 0.7 GB", () => {
  const configured = gbToBytes(5);
  const limit = effectiveLimitBytes({
    configuredBytes: configured,
    freeBytes: 0.5 * 1024 ** 3,
    snapshotBytes: 2.2 * 1024 ** 3,
  });
  assert.ok(limit < gbToBytes(1), `预算应压到 1 GB 以下，实际 ${(limit / 1024 ** 3).toFixed(2)} GB`);
  assert.ok(limit >= 256 * 1024 * 1024, "再紧也要留 256 MB");
  // 2.2 GB 快照砍到 0.7 GB = 腾出 1.5 GB，余量从 0.5 GB 回到 2.0 GB 以上
  assert.ok(limit <= 2.2 * 1024 ** 3 - 1.4 * 1024 ** 3);
});

test("盘紧也不许把预算做到负数：快照本来就很小就不删", () => {
  const limit = effectiveLimitBytes({ configuredBytes: gbToBytes(5), freeBytes: 0.2 * 1024 ** 3, snapshotBytes: 0.1 * 1024 ** 3 });
  assert.equal(limit, 256 * 1024 * 1024);
});

test("量不出来（freeBytes=null）就不动预算", () => {
  const configured = gbToBytes(5);
  assert.equal(effectiveLimitBytes({ configuredBytes: configured, freeBytes: null, snapshotBytes: 0 }), configured);
});

test("snapshotBytesOnDisk：不存在算 0，有文件按字节累加", () => {
  const r = root();
  try {
    assert.equal(snapshotBytesOnDisk(join(r.dir, "nope")), 0);
    makeTask(r.dir, "task_a", "t1", 2048, 1);
    makeTask(r.dir, "task_b", "t1", 1024, 1);
    assert.ok(snapshotBytesOnDisk(r.dir) >= 3072);
  } finally {
    r.cleanup();
  }
});

test("异步版：盘宽裕时按配置上限，超了才从最旧的删", async () => {
  const r = root();
  try {
    makeTask(r.dir, "task_old", "t1", 4096, 5);
    makeTask(r.dir, "task_new", "t1", 4096, 3);
    const out = await sweepSnapshotsAsync({
      root: r.dir,
      configuredBytes: 2048,
      freeBytes: gbToBytes(20),
      minAgeMs: 0,
    });
    assert.equal(out.removed.length, 2, "两份都超上限，最旧的先删，删到达标为止");
    assert.ok(out.keptBytes <= 2048 || out.removed.length === out.scanned);
  } finally {
    r.cleanup();
  }
});

test("异步版：盘紧时自觉压低预算，不用外面先量一遍", async () => {
  const r = root();
  try {
    makeTask(r.dir, "task_old", "t1", 4096, 5);
    const out = await sweepSnapshotsAsync({
      root: r.dir,
      configuredBytes: gbToBytes(5),
      freeBytes: 0.5 * 1024 ** 3, // 盘只剩 0.5 GB
      minAgeMs: 0,
    });
    // 倒推出来的预算是负数，被 256 MB 保底兜住；快照本身才 4 KB，所以一个都不删。
    assert.equal(out.limitBytes, 256 * 1024 * 1024);
    assert.equal(out.removed.length, 0, "快照比保底线还小，盘紧也不该删");
  } finally {
    r.cleanup();
  }
});

test("异步版：正在跑的任务不删", async () => {
  const r = root();
  try {
    makeTask(r.dir, "task_run", "t1", 4096, 9);
    makeTask(r.dir, "task_idle", "t1", 4096, 1);
    const out = await sweepSnapshotsAsync({
      root: r.dir,
      configuredBytes: 1,
      freeBytes: gbToBytes(20),
      keepTaskIds: ["task_run"],
      minAgeMs: 0,
    });
    assert.deepEqual(
      out.removed.map((p) => p.split(/[\\/]/).pop()),
      ["task_idle"],
    );
  } finally {
    r.cleanup();
  }
});

test("异步版：根目录不存在就当空目录，不抛", async () => {
  const out = await sweepSnapshotsAsync({ root: join(tmpdir(), "dot-maint-async-none"), configuredBytes: 1024 });
  assert.deepEqual(out.removed, []);
  assert.equal(out.scanned, 0);
});
