/**
 * src/hands/exec.test.ts —— 命令手的验收。
 *
 * 钉住五件事（都是真机上踩过或会踩的）：
 * 1. 只读命令（git status / node -v 这类）判第 1 档、直接跑、输出进账本；
 * 2. 带 shell 语法（管道、重定向、&&）→ 当场拒，不记账（我们没有 shell）；
 * 3. 白名单外的程序 → 当场拒（`rm`、`curl` 这种不许出现）；
 * 4. cwd 越界（绝对路径、`..`）→ 拒；
 * 5. 命令退出码非零 → 记 failed 步，正文带上输出（模型能照着改）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSteps, migrate } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { defaultConfig, type DotCoreConfig } from "../config.ts";
import { runExecHand, splitCommand } from "./exec.ts";

interface Fixture {
  db: ReturnType<typeof makeTempDb>;
  config: DotCoreConfig;
  workspace: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const t = makeTempDb();
  migrate(t.db);
  const workspace = mkdtempSync(join(tmpdir(), "dot-exec-ws-"));
  return {
    db: t,
    config: defaultConfig(),
    workspace,
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
      t.cleanup();
    },
  };
}

function taskWithWorkspace(f: Fixture, workspace: string | null, intent = "跑测试"): string {
  const id = createTask(f.db.db, { intent, state: "running" });
  if (workspace !== null) {
    f.db.db.prepare("UPDATE tasks SET declared_json = ? WHERE id = ?").run(JSON.stringify({ workspace }), id);
  }
  return id;
}

test("splitCommand：按空白拆，引号里的空格不拆", () => {
  assert.deepEqual(splitCommand("node --test"), ["node", "--test"]);
  assert.deepEqual(splitCommand('git commit -m "a b"'), ["git", "commit", "-m", "a b"]);
  assert.deepEqual(splitCommand("   "), []);
});

test("命令手：只读命令判第 1 档、真跑、输出进账本", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    const out = await runExecHand(
      { db: f.db.db, config: f.config },
      { taskId, action: "run", params: { cmd: "node --version" } },
    );
    assert.equal(out.ok, true, out.text);
    assert.equal(out.tier, 1, "只读命令应该一档放行");
    assert.match(out.text, /v\d+\./);

    const steps = listSteps(f.db.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.tool, "exec");
    assert.equal(steps[0]?.status, "succeeded");
  } finally {
    f.cleanup();
  }
});

test("命令手：会执行代码的命令（node -e / node --test）要人批，不当只读放行", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    for (const cmd of ['node -e "1+1"', "node --test"]) {
      const out = await runExecHand({ db: f.db.db, config: f.config }, { taskId, action: "run", params: { cmd } });
      assert.equal(out.ok, false, cmd);
      assert.equal(out.code, "awaiting_approval", `${cmd} 应该出请示卡`);
    }
  } finally {
    f.cleanup();
  }
});

test("命令手：带 shell 语法当场拒，不记账", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    for (const cmd of ["node -v | findstr v", "node -v && node -v", "node -v > out.txt", "node $(echo -v)"]) {
      const out = await runExecHand({ db: f.db.db, config: f.config }, { taskId, action: "run", params: { cmd } });
      assert.equal(out.ok, false, cmd);
      assert.equal(out.code, "bad_action");
      // 拒的时候要告诉模型怎么改写，不然它只会换个管道再撞一次
      assert.match(out.text, /替代写法/);
      assert.match(out.text, /wc -l/);
    }
    assert.equal(listSteps(f.db.db, taskId).length, 0, "拒了不记账");
  } finally {
    f.cleanup();
  }
});

test("命令手：白名单外的程序当场拒", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    for (const cmd of ["rm -rf .", "curl http://x", "powershell -c dir", "cmd /c dir"]) {
      const out = await runExecHand({ db: f.db.db, config: f.config }, { taskId, action: "run", params: { cmd } });
      assert.equal(out.ok, false, cmd);
      assert.equal(out.code, "bad_action");
      assert.match(out.text, /不在允许的命令名单里/);
    }
  } finally {
    f.cleanup();
  }
});

test("命令手：cwd 越界（绝对路径 / ..）拒", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    for (const cwd of ["C:/Windows", "../.."]) {
      const out = await runExecHand(
        { db: f.db.db, config: f.config },
        { taskId, action: "run", params: { cmd: "node -v", cwd } },
      );
      assert.equal(out.ok, false, `cwd=${cwd}`);
    }
  } finally {
    f.cleanup();
  }
});

test("命令手：没声明工作区 → workspace_missing", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, null, "跑一下测试");
    const out = await runExecHand({ db: f.db.db, config: f.config }, { taskId, action: "run", params: { cmd: "node -v" } });
    assert.equal(out.ok, false);
    assert.equal(out.code, "workspace_missing");
  } finally {
    f.cleanup();
  }
});

test("命令手：退出码非零 → 记 failed 步，正文带输出", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    // 临时目录不是 git 仓库：`git log` 只读、一档放行，但会以非零退出码收场。
    const out = await runExecHand(
      { db: f.db.db, config: f.config },
      { taskId, action: "run", params: { cmd: "git log --oneline -1" } },
    );
    assert.equal(out.ok, false);
    assert.equal(out.errorCode, "command_failed");
    assert.match(out.text, /退出码/);
    const steps = listSteps(f.db.db, taskId);
    assert.equal(steps[0]?.status, "failed");
  } finally {
    f.cleanup();
  }
});

test("命令手：wc 算只读、第 1 档直接跑（真机上被白名单拦过）", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    writeFileSync(join(f.workspace, "a.txt"), "1\n2\n3\n", "utf8");
    const outcome = await runExecHand(
      { db: f.db.db, config: f.config, snapshotsRoot: join(f.workspace, ".snap") },
      { taskId, action: "run", params: { cmd: "wc -l a.txt" } },
    );
    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(outcome.tier, 1, "只读命令不该出请示卡");
    assert.match(outcome.text, /3/);
  } finally {
    f.cleanup();
  }
});
