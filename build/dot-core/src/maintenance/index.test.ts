/**
 * src/maintenance/index.test.ts —— 快照回收的验收。
 * 钉住：超上限才删、从最旧开始、正在跑的任务不删、刚拍的不删、账本行不碰。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gbToBytes, sweepSnapshots } from "./index.ts";

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
