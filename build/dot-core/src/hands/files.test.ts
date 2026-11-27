/**
 * src/hands/files.test.ts —— 工作区文件手的验收。
 *
 * 为什么有这只手：用户 2026-11-25 指出「文件夹不是可以用 cmd 或 PowerShell 做吗」。
 * 确实能做，但工人手上原来只有练习手（固定练习根）和电脑手（Windows-MCP 只会点/打字），
 * 所以「在桌面建个文件夹」这类最普通的活一直被判干不了。
 *
 * 这里钉住四件事：
 * 1. 任务声明了工作区 → 真在工作区里建目录/写文件，账本留 succeeded 步骤，第 2 档拍了快照；
 * 2. 没声明工作区 → 明确拒绝（workspace_missing），不猜、不默认到桌面；
 * 3. 路径越界（`..`、绝对路径）→ 拒绝，且什么都没建出来；
 * 4. 写进子目录时快照不报错（回归：标签带 `/` 时标记文件父目录不存在 → ENOENT）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSteps, migrate } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { defaultConfig, type DotCoreConfig } from "../config.ts";
import { runFilesHand, workspaceFromIntent } from "./files.ts";

interface Fixture {
  db: ReturnType<typeof makeTempDb>;
  config: DotCoreConfig;
  workspace: string;
  snapshotsRoot: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const t = makeTempDb();
  migrate(t.db);
  const workspace = mkdtempSync(join(tmpdir(), "dot-files-ws-"));
  const snapshotsRoot = mkdtempSync(join(tmpdir(), "dot-files-snap-"));
  const config = defaultConfig();
  return {
    db: t,
    config,
    workspace,
    snapshotsRoot,
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(snapshotsRoot, { recursive: true, force: true });
      t.cleanup();
    },
  };
}

/** 建一个任务并把工作区写进 declared_json（真实任务走桥的 declared 字段，效果一样）。 */
function taskWithWorkspace(f: Fixture, workspace: string | null, intent = "在工作区里建文件夹"): string {
  const id = createTask(f.db.db, { intent, state: "running" });
  if (workspace !== null) {
    f.db.db
      .prepare("UPDATE tasks SET declared_json = ? WHERE id = ?")
      .run(JSON.stringify({ workspace }), id);
  }
  return id;
}

test("工作区文件手：任务声明了工作区 → 真建出文件夹，账本留 succeeded 步骤，第 2 档拍了快照", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "mkdir", path: "新文件夹" },
    );

    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(outcome.tier, 2, "工作区内写应该判第 2 档（先快照再放行）");
    assert.equal(existsSync(join(f.workspace, "新文件夹")), true, "文件夹要真建在工作区里");

    const steps = listSteps(f.db.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.status, "succeeded");
    assert.equal(steps[0]?.tool, "files");
    assert.equal(steps[0]?.tier, 2);
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：写进子目录（快照标签带 /）也不报错", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    mkdirSync(join(f.workspace, "资料"), { recursive: true });
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "write", path: "资料/说明.txt", content: "你好" },
    );

    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(readFileSync(join(f.workspace, "资料", "说明.txt"), "utf8"), "你好");
    assert.equal(listSteps(f.db.db, taskId)[0]?.status, "succeeded");
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：没声明工作区 → 明确拒绝，不猜、不默认到桌面", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, null, "把资料整理一下");
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "mkdir", path: "新文件夹" },
    );

    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "workspace_missing");
    assert.match(outcome.text, /workspace/);
    assert.equal(listSteps(f.db.db, taskId).length, 0, "被拒的动作不该在账本里留步骤");
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：原话点名桌面 → 工作区就用桌面（不用填 declared）", async () => {
  const f = fixture();
  try {
    // 用「桌面」这个词，但把家目录换掉没法做，所以这里只钉住识别规则本身：
    // 真机的 Desktop 存在与否不影响识别结果，认识别要返回 Desktop 目录。
    const got = workspaceFromIntent("在桌面建一个叫 dot-验收 的文件夹");
    assert.notEqual(got, null);
    assert.match(got!.root.replace(/\\/g, "/"), /\/Desktop$/i);
    assert.equal(got!.label, "桌面");
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：原话里同时点了两个地方 / 什么都没点 → 都认不出，不猜", () => {
  assert.equal(workspaceFromIntent("把下载里的东西整理到桌面"), null, "两个地点，不猜哪个是工作区");
  assert.equal(workspaceFromIntent("帮我看看这个任务怎么样"), null);
  assert.equal(workspaceFromIntent(""), null);
});

test("工作区文件手：原话里有现成的绝对路径 → 用它所在目录", () => {
  const base = mkdtempSync(join(tmpdir(), "dot-files-abs-"));
  try {
    const file = join(base, "说明.txt");
    writeFileSync(file, "x");
    const byFile = workspaceFromIntent(`把 ${file} 改成新的内容`);
    assert.equal(byFile?.root, base, "给的是文件，工作区取它所在目录");
    const byDir = workspaceFromIntent(`在 ${base} 里建个文件夹`);
    assert.equal(byDir?.root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("工作区文件手：拒得早也要带错误码（工人靠它认硬失败）", async () => {  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, null, "整理一下");
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "mkdir", path: "新文件夹" },
    );
    assert.equal(outcome.errorCode, "workspace_missing");
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：路径越界（.. 与绝对路径）→ 拒绝，且什么都没建出来", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    for (const bad of ["../外面", "C:/Windows/Temp/不该建", "a/../../逃出去"]) {
      const outcome = await runFilesHand(
        { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
        { taskId, action: "mkdir", path: bad },
      );
      assert.equal(outcome.ok, false, `${bad} 应该被拒`);
      // 围栏可能先在「拍快照」那一步抛（快照目标解析不过），所以只看正文里说清了原因
      assert.match(outcome.text, /跑出|绝对路径|路径/, `${bad} 的拒绝理由要写清：${outcome.text}`);
    }
    assert.equal(existsSync(join(f.workspace, "..", "外面")), false);
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：list 走第 1 档、不拍快照", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    mkdirSync(join(f.workspace, "已有的"), { recursive: true });
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "list", path: "." },
    );
    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(outcome.tier, 1);
    assert.match(outcome.text, /已有的/);
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：read 读文件内容", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    writeFileSync(join(f.workspace, "测试.txt"), "你好世界 42");
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "read", path: "测试.txt" },
    );
    assert.equal(outcome.ok, true, outcome.text);
    assert.match(outcome.text, /你好世界 42/);
    assert.match(outcome.text, /测试\.txt/);
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：read 文件不存在报 not_found", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "read", path: "不存在.txt" },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, "not_found");
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：根内的绝对路径自动折算成相对（模型爱写全路径）", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    const abs = join(f.workspace, "全路径建的");
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "mkdir", path: abs },
    );
    assert.equal(outcome.ok, true, outcome.text);
    assert.equal(existsSync(abs), true);
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：根外的绝对路径照旧拒（折算不放宽围栏）", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    const outcome = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "mkdir", path: join(tmpdir(), "根外的") },
    );
    assert.equal(outcome.ok, false);
    assert.equal(existsSync(join(tmpdir(), "根外的")), false);
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：拿工作区根本身当目标 → 拒，而且一张快照都不许拍", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    for (const target of [".", f.workspace]) {
      const outcome = await runFilesHand(
        { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
        { taskId, action: "mkdir", path: target },
      );
      assert.equal(outcome.ok, false, `目标 ${target} 不该放行`);
      assert.equal(outcome.code, "bad_action");
      assert.match(outcome.text, /工作区根/);
    }
    const snaps = f.db.db.prepare("select count(*) c from snapshots where task_id = ?").get(taskId) as { c: number };
    assert.equal(snaps.c, 0, "根目标不许产生快照（否则整个桌面被复制一遍）");
  } finally {
    f.cleanup();
  }
});

test("崩溃恢复（run_epoch>0）：同一个动作不重做，记一条 skipped", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    // 模拟「崩溃后重新排队」：epoch 变成 1
    f.db.db.prepare("UPDATE tasks SET run_epoch = 1 WHERE id = ?").run(taskId);

    const first = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "mkdir", path: "恢复演练夹" },
    );
    assert.equal(first.ok, true, first.text);

    const again = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "mkdir", path: "恢复演练夹" },
    );
    assert.equal(again.ok, true);
    assert.match(again.text, /已经成功过|没有重做/);

    const steps = listSteps(f.db.db, taskId);
    assert.equal(steps.filter((s) => s.status === "succeeded").length, 1, "同一个动作只能成功一次");
    assert.equal(steps.filter((s) => s.status === "skipped").length, 1, "重复的那次记 skipped");
  } finally {
    f.cleanup();
  }
});

test("正常一轮（run_epoch=0）：同样的调用照旧执行，不拦", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    for (let i = 0; i < 2; i += 1) {
      const out = await runFilesHand(
        { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
        { taskId, action: "mkdir", path: "反复建同一个" },
      );
      assert.equal(out.ok, true, out.text);
    }
    assert.equal(listSteps(f.db.db, taskId).length, 2, "正常一轮里不该被「恢复」逻辑拦掉");
  } finally {
    f.cleanup();
  }
});

test("工作区文件手：长文件按 offset 接着读（别再逼工人用 tail 啃）", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    const body = "A".repeat(5000) + "中间标记" + "B".repeat(5000);
    writeFileSync(join(f.workspace, "长文件.txt"), body, "utf8");

    const first = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "read", path: "长文件.txt" },
    );
    assert.equal(first.ok, true, first.text);
    assert.match(first.text, /共 10004 字符/, "要说清全文多长");
    assert.match(first.text, /接着读用 offset=3400/, "截断时要告诉下次从哪读");
    assert.doesNotMatch(first.text, /中间标记/, "第一屏读不到中间那段");

    const second = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "read", path: "长文件.txt", params: { offset: 3400 } },
    );
    assert.equal(second.ok, true, second.text);
    assert.match(second.text, /中间标记/, "第二屏要读到中间那段");

    const third = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "read", path: "长文件.txt", params: { offset: 6800 } },
    );
    assert.equal(third.ok, true, third.text);
    assert.match(third.text, /已到文件末尾/, "读到尾要说清已经到底了");
  } finally {
    f.cleanup();
  }
});

test("崩溃恢复跳过重做时，把上次读到的正文带回去（否则模型只会换个写法再问一遍）", async () => {
  const f = fixture();
  try {
    const taskId = taskWithWorkspace(f, f.workspace);
    writeFileSync(join(f.workspace, "内容.txt"), "第一行内容\n第二行内容", "utf8");

    const first = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "read", path: "内容.txt" },
    );
    assert.equal(first.ok, true, first.text);
    assert.match(first.text, /第一行内容/);

    // 崩溃后重新排队：epoch 变 1，同一个动作会被拦成「没有重做」
    f.db.db.prepare("UPDATE tasks SET run_epoch = 1 WHERE id = ?").run(taskId);
    const again = await runFilesHand(
      { db: f.db.db, config: f.config, snapshotsRoot: f.snapshotsRoot },
      { taskId, action: "read", path: "内容.txt" },
    );
    assert.equal(again.ok, true);
    assert.match(again.text, /没有重做/);
    assert.match(again.text, /第一行内容/, "上次的正文要带回来，不能只说「结果同上一次」");
  } finally {
    f.cleanup();
  }
});
