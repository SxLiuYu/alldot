/**
 * src/rollback/rollback.test.ts —— 整目录快照与按里程碑回退的验收。
 *
 * 逐条钉住这次的六条要求：
 *   1) 快照后改文件再回退，内容回到当时；那之后新建的文件被删掉并出现在 deleted；
 *   2) 快照源在工作区之外的，拒绝还原（不碰盘）；
 *   3) dryRun 只算不动盘（改前改后 hash 一致）；
 *   4) 找不到该里程碑的快照时返回可读错误，且没动盘；
 *   5) 回退前存的那份 pre-rollback 快照存在，且能再拿来还原（回退可撤）；
 *   6) 符号链接/联接点被跳过并写进清单。
 * 另加：同任务同里程碑重复拍是复用而不是重拍；超体积拒且不留半成品。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  LedgerError,
  beginStep,
  createSnapshot,
  endStep,
  getMilestone,
  getTask,
  listDecisions,
  listSnapshots,
  listSteps,
  migrate,
} from "../ledger/index.ts";
import { countRows, createMilestone, createTask, makeTempDb } from "../ledger/test-helpers.ts";
import {
  readDirSnapshotRecord,
  restoreSnapshot,
  rollbackToMilestone,
  snapshotDir,
} from "./index.ts";

interface Fixture {
  db: ReturnType<typeof makeTempDb>["db"];
  dir: string;
  ws: string;
  snapsRoot: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const tmp = makeTempDb();
  migrate(tmp.db);
  const ws = join(tmp.dir, "工作区");
  const snapsRoot = join(tmp.dir, "快照");
  mkdirSync(ws, { recursive: true });
  mkdirSync(snapsRoot, { recursive: true });
  return { db: tmp.db, dir: tmp.dir, ws, snapsRoot, cleanup: tmp.cleanup };
}

function write(dir: string, rel: string, text: string): void {
  const abs = join(dir, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, ...rel.split("/")), "utf8");
}

function addStep(
  f: Fixture,
  taskId: string,
  milestoneId: string | null,
  status: "succeeded" | "skipped" = "succeeded",
): string {
  const step = beginStep(f.db, {
    task_id: taskId,
    milestone_id: milestoneId,
    kind: "tool",
    tool: "practice",
    subject_key: `subj-${Math.random().toString(16).slice(2)}`,
    side_effect: "safe",
    run_epoch: 0,
  });
  const out = endStep(f.db, step.id, { status });
  assert.equal(out.applied, true, "夹具步骤必须真的结束");
  return step.id;
}

// ── 1) 快照 → 改 → 还原 ───────────────────────────────────────────────────

test("快照后改文件再还原：内容回到当时，那之后新建的文件被删掉并列入 deleted", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    const m1 = createMilestone(f.db, taskId, { seq: 1, title: "整理截图" });

    write(f.ws, "a.txt", "第一版");
    write(f.ws, "子/b.txt", "乙");

    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: m1, sourcePath: f.ws },
    );
    assert.equal(made.reused, false);
    assert.equal(made.snapshot.kind, "copy");
    assert.equal(made.snapshot.milestone_id, m1);
    assert.equal(made.record.entries.length, 2);
    assert.ok(!made.snapshot.ref.includes("\\"), `ref 应为 posix 相对路径，实际 ${made.snapshot.ref}`);
    assert.equal(existsSync(join(f.snapsRoot, ...made.snapshot.ref.split("/"))), true);

    // 改一个、加一个、删一个
    write(f.ws, "a.txt", "第二版");
    write(f.ws, "新建.txt", "那之后建的");
    unlinkSync(join(f.ws, "子", "b.txt"));

    const rep = restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
    assert.equal(read(f.ws, "a.txt"), "第一版");
    assert.equal(read(f.ws, "子/b.txt"), "乙", "快照里有、后来被删的文件要放回去");
    assert.equal(existsSync(join(f.ws, "新建.txt")), false, "那之后新建的文件必须删掉");
    assert.deepEqual(rep.deleted, ["新建.txt"]);
    assert.deepEqual(rep.overwritten, ["a.txt"]);
    assert.ok(rep.added.includes("子/b.txt"), `added 应含 子/b.txt，实际 ${rep.added.join(",")}`);
    assert.equal(rep.dryRun, false);
  } finally {
    f.cleanup();
  }
});

// ── 2) 工作区围栏 ─────────────────────────────────────────────────────────

test("快照源在工作区之外：拒绝还原，磁盘一个字节都不动", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    // 名字故意和工作区同前缀（「工作区」vs「工作区-外面」）：用 startsWith 写围栏的
    // 实现会把这里误判成「在里面」，这条就是钉住那个坑。
    const outside = join(f.dir, "工作区-外面");
    write(outside, "别人的.txt", "原样");

    // 快照本身是合法的（拍的是工作区外的目录），还原时才该被围栏拦下。
    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: null, sourcePath: outside },
    );
    write(outside, "别人的.txt", "被改了");

    let err: unknown = null;
    try {
      restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof LedgerError, `应抛 LedgerError，实际 ${String(err)}`);
    assert.equal((err as LedgerError).code, "outside_workspace");
    assert.equal(read(outside, "别人的.txt"), "被改了", "拒绝之后不许悄悄还原");
  } finally {
    f.cleanup();
  }
});

// ── 1b) 围栏漏面：清单条目、符号链接换根/换子目录、跨盘符、`..foo` ──────

test("清单条目带 `..` / 绝对路径 / 盘符：拒绝还原，且工作区外不落盘", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    write(f.ws, "a.txt", "v1");
    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: null, sourcePath: f.ws },
    );
    const row = f.db.prepare("SELECT restore_json FROM snapshots WHERE id = ?").get(made.snapshot.id) as {
      restore_json: string;
    };
    const base = JSON.parse(row.restore_json) as { entries: Array<{ path: string }> };

    try {
      for (const bad of ["../逃出.txt", "子/../x.txt", "/abs/x.txt", "C:/x.txt", "a\\b.txt", "./x.txt", ""]) {
        const rec = { ...base, entries: [...base.entries, { path: bad, bytes: 1, hash: "deadbeef" }] };
        f.db
          .prepare("UPDATE snapshots SET restore_json = ? WHERE id = ?")
          .run(JSON.stringify(rec), made.snapshot.id);
        let err: unknown = null;
        try {
          restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
        } catch (e) {
          err = e;
        }
        assert.ok(err instanceof LedgerError, `条目 ${JSON.stringify(bad)} 应被拒，实际 ${String(err)}`);
        assert.equal((err as LedgerError).code, "bad_entry_path", `条目 ${JSON.stringify(bad)} 的错误码`);
      }
      assert.equal(existsSync(join(f.dir, "逃出.txt")), false, "工作区外不许出现逃出.txt");
      assert.equal(read(f.ws, "a.txt"), "v1", "被拒时 a.txt 不许被提前改掉");
    } finally {
      f.db
        .prepare("UPDATE snapshots SET restore_json = ? WHERE id = ?")
        .run(JSON.stringify(base), made.snapshot.id);
    }
  } finally {
    f.cleanup();
  }
});

test("名字以 `..` 开头的合法子目录（..foo）不被误判成越界", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    write(f.ws, "..foo/f.txt", "第一版");
    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: null, sourcePath: f.ws },
    );
    write(f.ws, "..foo/f.txt", "第二版");
    const rep = restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
    assert.equal(read(f.ws, "..foo/f.txt"), "第一版");
    assert.deepEqual(rep.overwritten, ["..foo/f.txt"]);
  } finally {
    f.cleanup();
  }
});

test("快照后把工作区根换成联接点：拒绝还原，范围外的文件一个都不动", (t) => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    write(f.ws, "a.txt", "v1");
    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: null, sourcePath: f.ws },
    );

    const outside = join(f.dir, "外面目录");
    write(outside, "victim.txt", "不该被动");
    try {
      renameSync(f.ws, `${f.ws}.old`);
      symlinkSync(outside, f.ws, "junction");
    } catch (e) {
      t.skip(`这台机器建不了联接点（${(e as NodeJS.ErrnoException).code}），跳过`);
      return;
    }

    let err: unknown = null;
    try {
      restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof LedgerError, `应抛 LedgerError，实际 ${String(err)}`);
    assert.ok(
      ["outside_workspace", "snapshot_path_symlink"].includes((err as LedgerError).code),
      `错误码应是围栏类，实际 ${(err as LedgerError).code}`,
    );
    assert.equal(existsSync(join(outside, "victim.txt")), true, "范围外的 victim.txt 不许被删");
    assert.equal(existsSync(join(outside, "a.txt")), false, "不许顺着链接写到范围外");
  } finally {
    f.cleanup();
  }
});

test("快照后把子目录换成联接点：拒绝还原，范围外不被写入", (t) => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    write(f.ws, "sub/x.txt", "v1");
    write(f.ws, "a.txt", "a");
    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: null, sourcePath: f.ws },
    );

    const outside = join(f.dir, "外面子目录");
    mkdirSync(outside, { recursive: true });
    try {
      renameSync(join(f.ws, "sub"), join(f.dir, "sub.old"));
      symlinkSync(outside, join(f.ws, "sub"), "junction");
    } catch (e) {
      t.skip(`这台机器建不了联接点（${(e as NodeJS.ErrnoException).code}），跳过`);
      return;
    }

    let err: unknown = null;
    try {
      restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof LedgerError, `应抛 LedgerError，实际 ${String(err)}`);
    assert.equal((err as LedgerError).code, "snapshot_path_symlink");
    assert.equal(existsSync(join(outside, "x.txt")), false, "不许经联接点写到范围外");
    assert.equal(read(f.ws, "a.txt"), "a", "子目录被钉死不该连累同级的正常文件");
  } finally {
    f.cleanup();
  }
});

test("快照源是别的盘符/UNC：拒绝还原（词法围栏不看盘上有没有这个路径）", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    for (const [tag, source] of [
      ["盘符", "D:\\别处\\x"],
      ["UNC", "\\\\srv\\share\\x"],
    ] as const) {
      const snap = createSnapshot(f.db, {
        task_id: taskId,
        kind: "copy",
        ref: "fake",
        restore: {
          version: 1,
          source,
          sourceKind: "dir",
          dir: f.snapsRoot,
          entries: [],
          dirs: [],
          skipped: [],
          totalBytes: 0,
          label: null,
        },
      });
      let err: unknown = null;
      try {
        restoreSnapshot(f.db, { snapshotId: snap.id, workspace: f.ws, dryRun: true });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof LedgerError, `${tag} 快照应被拒，实际 ${String(err)}`);
      assert.equal((err as LedgerError).code, "outside_workspace", `${tag} 的错误码`);
    }
  } finally {
    f.cleanup();
  }
});

// ── 3) dryRun ─────────────────────────────────────────────────────────────

test("dryRun 只算清单不动盘：改前改后内容与哈希都不变", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    write(f.ws, "a.txt", "第一版");
    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: null, sourcePath: f.ws },
    );

    write(f.ws, "a.txt", "第二版");
    write(f.ws, "新建.txt", "新");
    const before = read(f.ws, "a.txt");

    const dry = restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.overwritten, ["a.txt"]);
    assert.deepEqual(dry.deleted, ["新建.txt"]);
    assert.deepEqual(dry.added, []);
    assert.equal(read(f.ws, "a.txt"), before, "dryRun 之后文件内容必须没变");
    assert.equal(existsSync(join(f.ws, "新建.txt")), true, "dryRun 不能删文件");

    // 同一次调用 dryRun=false 才真的动
    const real = restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
    assert.equal(real.dryRun, false);
    assert.equal(read(f.ws, "a.txt"), "第一版");
    assert.equal(existsSync(join(f.ws, "新建.txt")), false);
  } finally {
    f.cleanup();
  }
});

// ── 4) 符号链接 ───────────────────────────────────────────────────────────

test("符号链接/联接点被跳过并写进清单，还原时不跟随也不删", (t) => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    const outside = join(f.dir, "外面");
    write(outside, "秘密.txt", "外面的东西");

    write(f.ws, "a.txt", "正文");
    // Windows 上文件符号链接要管理员权限；目录联接点（junction）普通用户可建，
    // lstat 同样报 isSymbolicLink()，语义一样：不跟随。
    try {
      symlinkSync(outside, join(f.ws, "链接"), "junction");
    } catch (e) {
      t.skip(`这台机器建不了链接（${(e as NodeJS.ErrnoException).code}），跳过`);
      return;
    }
    assert.equal(lstatSync(join(f.ws, "链接")).isSymbolicLink(), true, "夹具本身要是链接");

    const made = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: null, sourcePath: f.ws },
    );
    assert.deepEqual(
      made.record.skipped.map((s) => s.path),
      ["链接"],
      "链接要记进 skipped",
    );
    assert.equal(made.record.skipped[0]?.reason, "symlink");
    assert.equal(
      made.record.entries.some((e) => e.path.includes("秘密")),
      false,
      "链接指向的内容不许进清单",
    );

    const rep = restoreSnapshot(f.db, { snapshotId: made.snapshot.id, workspace: f.ws });
    assert.equal(rep.skipped.length, 1);
    assert.deepEqual(rep.deleted, [], "链接不在清单里，但也不该被当成「新建的」删掉");
    assert.equal(lstatSync(join(f.ws, "链接")).isSymbolicLink(), true);
    assert.equal(existsSync(join(f.ws, "秘密.txt")), false, "不许把链接指向的内容复制进工作区");
  } finally {
    f.cleanup();
  }
});

// ── 5) 幂等与 force ───────────────────────────────────────────────────────

test("同任务同里程碑重复拍是复用；force 才新拍（pre-rollback 走这条）", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    const m1 = createMilestone(f.db, taskId, { seq: 1, title: "一" });
    write(f.ws, "a.txt", "x");

    const first = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: m1, sourcePath: f.ws },
    );
    const again = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: m1, sourcePath: f.ws },
    );
    assert.equal(again.reused, true);
    assert.equal(again.snapshot.id, first.snapshot.id);
    assert.equal(countRows(f.db, "snapshots"), 1, "复用不该多写一行");

    const forced = snapshotDir(
      { db: f.db, snapshotsRoot: f.snapsRoot },
      { taskId, milestoneId: m1, sourcePath: f.ws, force: true, label: "pre-rollback" },
    );
    assert.equal(forced.reused, false);
    assert.equal(countRows(f.db, "snapshots"), 2);
    assert.ok(forced.snapshot.ref.includes("pre-rollback"), `ref 应带标签，实际 ${forced.snapshot.ref}`);
  } finally {
    f.cleanup();
  }
});

// ── 6) 体积上限 ───────────────────────────────────────────────────────────

test("超体积直接拒，且快照根下不留半成品目录", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    write(f.ws, "大.bin", "0123456789012345678901234567890123456789"); // 40 字节

    let err: unknown = null;
    try {
      snapshotDir(
        { db: f.db, snapshotsRoot: f.snapsRoot, maxFileBytes: 16 },
        { taskId, milestoneId: null, sourcePath: f.ws },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof LedgerError);
    assert.equal((err as LedgerError).code, "snapshot_file_too_large");
    assert.match((err as LedgerError).message, /单文件上限/);
    assert.equal(countRows(f.db, "snapshots"), 0);
    assert.equal(existsSync(join(f.snapsRoot, taskId)), false, "拒的时候不许在快照根下建目录");

    // 总量上限
    write(f.ws, "二.bin", "0123456789");
    let err2: unknown = null;
    try {
      snapshotDir(
        { db: f.db, snapshotsRoot: f.snapsRoot, maxFileBytes: 1024, maxTotalBytes: 30 },
        { taskId, milestoneId: null, sourcePath: f.ws },
      );
    } catch (e) {
      err2 = e;
    }
    assert.ok(err2 instanceof LedgerError);
    assert.equal((err2 as LedgerError).code, "snapshot_too_large");
    assert.equal(countRows(f.db, "snapshots"), 0);
  } finally {
    f.cleanup();
  }
});

// ── 7) 按里程碑回退 ───────────────────────────────────────────────────────

interface Seeded {
  taskId: string;
  m1: string;
  m2: string;
  m3: string;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
  snapId: string;
}

function seedThreeMilestones(f: Fixture): Seeded {
  const taskId = createTask(f.db, { state: "running" });
  const m1 = createMilestone(f.db, taskId, { seq: 1, title: "第一步", state: "done" });
  const m2 = createMilestone(f.db, taskId, { seq: 2, title: "第二步", state: "done" });
  const m3 = createMilestone(f.db, taskId, { seq: 3, title: "第三步", state: "pending" });

  const s1 = addStep(f, taskId, m1);
  const s2 = addStep(f, taskId, m2);

  // 第二步收尾时的样子，拍下来
  write(f.ws, "a.txt", "第二步的版本");
  write(f.ws, "第二步就有的.txt", "当时就有");
  const snap = snapshotDir(
    { db: f.db, snapshotsRoot: f.snapsRoot },
    { taskId, milestoneId: m2, sourcePath: f.ws },
  );

  // 第三步做了两件事：改同一个文件，新建一个文件
  write(f.ws, "a.txt", "第三步的版本");
  write(f.ws, "第三步新建.txt", "新");
  const s3 = addStep(f, taskId, m3);
  const s4 = addStep(f, taskId, null);

  return { taskId, m1, m2, m3, s1, s2, s3, s4, snapId: snap.snapshot.id };
}

test("按里程碑回退：文件回到里程碑当时，之后的步骤标 rolled_back，里程碑与计划版本一起退", () => {
  const f = makeFixture();
  try {
    const s = seedThreeMilestones(f);
    const res = rollbackToMilestone(f.db, {
      taskId: s.taskId,
      milestoneId: s.m2,
      workspace: f.ws,
      snapshotsRoot: f.snapsRoot,
    });

    assert.equal(read(f.ws, "a.txt"), "第二步的版本");
    assert.equal(read(f.ws, "第二步就有的.txt"), "当时就有");
    assert.equal(existsSync(join(f.ws, "第三步新建.txt")), false);
    assert.deepEqual(res.deleted, ["第三步新建.txt"]);
    assert.ok(res.restored.includes("a.txt"));

    assert.deepEqual(
      [...res.stepsRolledBack].sort(),
      [s.s3, s.s4].sort(),
      "只有第二步之后的步标 rolled_back",
    );
    const statusById = new Map(listSteps(f.db, s.taskId).map((x) => [x.id, x.status]));
    assert.equal(statusById.get(s.s3), "rolled_back");
    assert.equal(statusById.get(s.s4), "rolled_back");
    assert.equal(statusById.get(s.s1), "succeeded", "第二步及以前的步不许动");
    assert.equal(statusById.get(s.s2), "succeeded");

    assert.equal(getMilestone(f.db, s.m2)?.state, "active");
    assert.equal(getMilestone(f.db, s.m3)?.state, "pending", "之后的里程碑退回待办，不是删掉");
    assert.equal(getMilestone(f.db, s.m3) !== null, true);
    assert.equal(getMilestone(f.db, s.m1)?.state, "done");

    assert.equal(Number(getTask(f.db, s.taskId)?.plan_version), 2);

    const decisions = listDecisions(f.db, s.taskId);
    assert.equal(decisions.length, 1);
    assert.match(decisions[0]?.answer ?? "", /退回/);
    assert.equal(decisions[0]?.id, res.decisionId);

    assert.ok(res.summary.length <= 1200, `摘要 ${res.summary.length} 字，超过 1200`);
    assert.match(res.summary, /已退回里程碑 2/);

    // 回退前那份存档：存在、带标签、清单可读
    const pre = listSnapshots(f.db, s.taskId).find((r) => r.id === res.preRollbackSnapshotId);
    assert.ok(pre !== undefined, "pre-rollback 快照必须落账");
    assert.equal(pre?.kind, "copy");
    assert.equal(pre?.milestone_id, null, "存档不挂里程碑，免得被当成里程碑快照");
    assert.equal(readDirSnapshotRecord(pre!)?.label, "pre-rollback");
  } finally {
    f.cleanup();
  }
});

test("回退可撤：拿 pre-rollback 那份再还原，回到回退前的样子", () => {
  const f = makeFixture();
  try {
    const s = seedThreeMilestones(f);
    const res = rollbackToMilestone(f.db, {
      taskId: s.taskId,
      milestoneId: s.m2,
      workspace: f.ws,
      snapshotsRoot: f.snapsRoot,
    });
    assert.equal(read(f.ws, "a.txt"), "第二步的版本");

    const undo = restoreSnapshot(f.db, { snapshotId: res.preRollbackSnapshotId, workspace: f.ws });
    assert.equal(read(f.ws, "a.txt"), "第三步的版本");
    assert.equal(read(f.ws, "第三步新建.txt"), "新", "回退前新建的文件也要补回来");
    assert.equal(undo.dryRun, false);
  } finally {
    f.cleanup();
  }
});

test("里程碑没有快照时：返回可读错误，工作区与快照表都没被动过", () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.db, { state: "running" });
    const m1 = createMilestone(f.db, taskId, { seq: 1, title: "第一步", state: "done" });
    write(f.ws, "a.txt", "原样");

    let err: unknown = null;
    try {
      rollbackToMilestone(f.db, {
        taskId,
        milestoneId: m1,
        workspace: f.ws,
        snapshotsRoot: f.snapsRoot,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof LedgerError, `应抛 LedgerError，实际 ${String(err)}`);
    assert.equal((err as LedgerError).code, "milestone_snapshot_missing");
    assert.match((err as LedgerError).message, /没有可用的整目录快照/);
    assert.equal(read(f.ws, "a.txt"), "原样", "报错时不许动工作区");
    assert.equal(countRows(f.db, "snapshots"), 0, "找不到目标就不该留 pre-rollback 垃圾");
  } finally {
    f.cleanup();
  }
});

test("快照根放在工作区里：回退一开始就拒，什么都不改（否则会把存档删光）", () => {
  const f = makeFixture();
  try {
    const s = seedThreeMilestones(f);
    const snapsInWs = join(f.ws, ".snaps");
    mkdirSync(snapsInWs, { recursive: true });
    write(f.ws, "a.txt", "第三步的版本");

    let err: unknown = null;
    try {
      rollbackToMilestone(f.db, {
        taskId: s.taskId,
        milestoneId: s.m2,
        workspace: f.ws,
        snapshotsRoot: snapsInWs,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof LedgerError, `应抛 LedgerError，实际 ${String(err)}`);
    assert.equal((err as LedgerError).code, "snapshots_root_inside_workspace");
    assert.match((err as LedgerError).message, /工作区/);
    assert.equal(read(f.ws, "a.txt"), "第三步的版本", "被拒时文件不许动");
    assert.equal(countRows(f.db, "snapshots"), 1, "只该有 seed 里那份，不许新增 pre-rollback");
    // 原来的里程碑快照仍能还原（存档没被自己的还原删掉）
    const back = restoreSnapshot(f.db, { snapshotId: s.snapId, workspace: f.ws });
    assert.equal(read(f.ws, "a.txt"), "第二步的版本");
    assert.equal(back.dryRun, false);
  } finally {
    f.cleanup();
  }
});

test("撤回只撤文件：账本（步骤、计划版本、里程碑）不跟着退，摘要里写明", () => {
  const f = makeFixture();
  try {
    const s = seedThreeMilestones(f);
    const res = rollbackToMilestone(f.db, {
      taskId: s.taskId,
      milestoneId: s.m2,
      workspace: f.ws,
      snapshotsRoot: f.snapsRoot,
    });
    restoreSnapshot(f.db, { snapshotId: res.preRollbackSnapshotId, workspace: f.ws });

    // 文件回到回退前
    assert.equal(read(f.ws, "a.txt"), "第三步的版本");
    assert.equal(read(f.ws, "第三步新建.txt"), "新");
    // 账本没回退
    const statusById = new Map(listSteps(f.db, s.taskId).map((x) => [x.id, x.status]));
    assert.equal(statusById.get(s.s3), "rolled_back");
    assert.equal(Number(getTask(f.db, s.taskId)?.plan_version), 2);
    assert.equal(getMilestone(f.db, s.m2)?.state, "active");
    assert.equal(listDecisions(f.db, s.taskId).length, 1);
    // 话术与能力一致
    assert.match(res.summary, /账本状态不回退|账本（步骤状态、计划版本、里程碑）不会跟着回退/);
    assert.doesNotMatch(res.summary, /要撤销这次回退，用它还原/);
  } finally {
    f.cleanup();
  }
});
