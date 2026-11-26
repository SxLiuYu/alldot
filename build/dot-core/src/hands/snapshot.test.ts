/**
 * src/hands/snapshot.test.ts —— 第 2 档快照的验收。
 *
 * 最要紧的一条：**目录递归复制不能把进程弄死**。
 * 2026-11-25 真机实测过 `fs.cpSync(dir, dest, {recursive:true})` 在本机 Node v24.13.0 + Windows
 * 上会让进程直接消失（无异常、无栈、退出码 127）；真网关上的表现是「工人一开始做要快照的
 * 那一步，网关就没了，HTTP 再也不回话」。所以这里必须复制**带内容的目录**，
 * 只复制空目录是测不出来的。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate, listSnapshots } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";
import { snapshotPath } from "./snapshot.ts";

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dot-snap-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 快照的行里 ref 可能声明成 string | null；测试里断言它一定有值再当路径用。 */
function refOf(row: { ref: string | null }): string {
  assert.ok(typeof row.ref === "string" && row.ref !== "", "快照行必须有 ref");
  return row.ref;
}

test("快照：带内容的目录整个复制过去（子目录 + 文件 + 中文名都不丢）", () => {
  const ws = workspace();
  const t = makeTempDb();
  try {
    migrate(t.db);
    const src = join(ws.dir, "工作区");
    mkdirSync(join(src, "子目录"), { recursive: true });
    writeFileSync(join(src, "a.txt"), "第一层", "utf8");
    writeFileSync(join(src, "子目录", "b.txt"), "第二层", "utf8");

    const snapshotsRoot = join(ws.dir, "snapshots");
    const row = snapshotPath(
      { db: t.db, snapshotsRoot },
      { taskId: "task_x", sourcePath: src, label: "工作区" },
    );

    const ref = refOf(row);
    assert.equal(existsSync(ref), true, "快照目标目录应该在");
    assert.equal(readFileSync(join(ref, "a.txt"), "utf8"), "第一层");
    assert.equal(readFileSync(join(ref, "子目录", "b.txt"), "utf8"), "第二层");

    const restore = JSON.parse(row.restore_json ?? "{}") as { path?: string; from?: string };
    assert.equal(restore.path, src, "restore 要记「从哪复制回哪去」");
    assert.equal(restore.from, ref);

    const rows = listSnapshots(t.db, "task_x");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, row.id, "账本里要能查回这一行");
  } finally {
    t.cleanup();
    ws.cleanup();
  }
});

test("快照：单个文件复制（不走目录那条路）", () => {
  const ws = workspace();
  const t = makeTempDb();
  try {
    migrate(t.db);
    const src = join(ws.dir, "one.txt");
    writeFileSync(src, "就一行", "utf8");
    const row = snapshotPath(
      { db: t.db, snapshotsRoot: join(ws.dir, "snapshots") },
      { taskId: "task_y", sourcePath: src, label: "one.txt" },
    );
    assert.equal(readFileSync(refOf(row), "utf8"), "就一行");
    const restore = JSON.parse(row.restore_json ?? "{}") as { bytes?: number | null };
    assert.equal(restore.bytes, Buffer.byteLength("就一行"));
  } finally {
    t.cleanup();
    ws.cleanup();
  }
});

test("快照：目标还不存在时只记一条 absent，不复制、不报错", () => {
  const ws = workspace();
  const t = makeTempDb();
  try {
    migrate(t.db);
    const missing = join(ws.dir, "还没有这个目录");
    const row = snapshotPath(
      { db: t.db, snapshotsRoot: join(ws.dir, "snapshots") },
      { taskId: "task_z", sourcePath: missing, label: "还没有这个目录" },
    );
    const restore = JSON.parse(row.restore_json ?? "{}") as { absent?: boolean; path?: string };
    assert.equal(restore.absent, true);
    assert.equal(restore.path, missing);
    assert.equal(existsSync(refOf(row)), true, "标记文件应该写出来了");
  } finally {
    t.cleanup();
    ws.cleanup();
  }
});

test("快照：目录太大（超过上限）→ 直接拒，一个字节都不复制", () => {
  const db = makeTempDb();
  const ws = workspace();
  const snaps = workspace();
  try {
    migrate(db.db);
    const src = join(ws.dir, "很大的目录");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.bin"), Buffer.alloc(2048));
    writeFileSync(join(src, "b.bin"), Buffer.alloc(2048));

    assert.throws(
      () =>
        snapshotPath(
          { db: db.db, snapshotsRoot: snaps.dir, maxBytes: 1024 },
          { taskId: "task_big", sourcePath: src, label: "root" },
        ),
      /快照太大/,
    );
    assert.equal(listSnapshots(db.db, "task_big").length, 0, "拒了就不该留快照行");
  } finally {
    ws.cleanup();
    snaps.cleanup();
    db.cleanup();
  }
});

test("快照：小目录照旧复制（上限不误伤）", () => {
  const db = makeTempDb();
  const ws = workspace();
  const snaps = workspace();
  try {
    migrate(db.db);
    const src = join(ws.dir, "小目录");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.txt"), "hi");
    const row = snapshotPath(
      { db: db.db, snapshotsRoot: snaps.dir, maxBytes: 1024 * 1024 },
      { taskId: "task_small", sourcePath: src, label: "小目录" },
    );
    assert.equal(readFileSync(join(refOf(row), "a.txt"), "utf8"), "hi");
  } finally {
    ws.cleanup();
    snaps.cleanup();
    db.cleanup();
  }
});
