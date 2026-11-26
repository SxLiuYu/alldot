/**
 * src/context/context.test.ts —— 锚点骨架与 before_prompt_build 注入点的验收（A.10）。
 *
 * 钉住：只注工人会话（A.8 `task:<task_id>`）、正文只从账本拼、注入失败不打断对话、
 * 长锚点截到上限、工作区声明认几个常见键。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { migrate, recordDecision, type TaskRow } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { ANCHOR_TEXT_LIMIT, buildAnchor, workspaceFromDeclared } from "./anchor.ts";
import { createAnchorHook } from "./index.ts";

test("锚点从账本拼出来：任务号、目标、工作区、规则都在", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, {
      intent: "把桌面截图按月份归档",
      restated: "把 2026 年的截图按月份归档到 归档/2026-MM",
      budget_tokens: 100000,
      spent_tokens: 1200,
    });
    tmp.db.prepare(`UPDATE tasks SET declared_json = ? WHERE id = ?`).run(
      JSON.stringify({ workspace: "C:/Users/1/Desktop/截图" }),
      taskId,
    );

    const anchor = buildAnchor({ db: tmp.db, taskId });
    assert.ok(anchor !== null);
    const text = anchor ?? "";
    assert.match(text, new RegExp(`任务 ${taskId}`));
    assert.match(text, /把桌面截图按月份归档/);
    assert.match(text, /复述：把 2026 年的截图按月份归档到/);
    assert.match(text, /工作区：C:\/Users\/1\/Desktop\/截图/);
    assert.match(text, /预算：已用 1200 \/ 100000 token/);
    assert.match(text, /规则：事实以账本为准/);
    assert.match(text, /里程碑：还没拆/);
  } finally {
    tmp.cleanup();
  }
});

test("锚点带你定过的每一条决定（5.2「每一条决定」）", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "改名这件事" });
    recordDecision(tmp.db, { task_id: taskId, question: "文件要不要改名", answer: "改名，保留旧名备份", decided_by: "owner" });
    recordDecision(tmp.db, { task_id: taskId, question: "放哪个目录", answer: "放 归档/2026-11", decided_by: "owner" });

    const anchor = buildAnchor({ db: tmp.db, taskId }) ?? "";
    assert.match(anchor, /你定过（2 条）：/);
    assert.match(anchor, /「文件要不要改名」→「改名，保留旧名备份」/);
    assert.match(anchor, /「放哪个目录」→「放 归档\/2026-11」/);
  } finally {
    tmp.cleanup();
  }
});

test("任务不存在返回 null（注入方决定怎么处理）", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    assert.equal(buildAnchor({ db: tmp.db, taskId: "task_不存在" }), null);
  } finally {
    tmp.cleanup();
  }
});

test("工作区声明认 workspace/root/workdir/dir/paths[0]，其余返回 null", () => {
  const base = { declared_json: "{}" } as unknown as TaskRow;
  const make = (declared: unknown): TaskRow =>
    ({ ...base, declared_json: JSON.stringify(declared) }) as TaskRow;

  assert.equal(workspaceFromDeclared(make({ workspace: "C:/a" })), "C:/a");
  assert.equal(workspaceFromDeclared(make({ root: "D:/b" })), "D:/b");
  assert.equal(workspaceFromDeclared(make({ workdir: "E:/c" })), "E:/c");
  assert.equal(workspaceFromDeclared(make({ dir: "F:/d" })), "F:/d");
  assert.equal(workspaceFromDeclared(make({ paths: ["G:/e", "H:/f"] })), "G:/e");
  assert.equal(workspaceFromDeclared(make({ scope: ["I:/g"] })), null);
  assert.equal(workspaceFromDeclared(make(["nope"])), null);
});

test("锚点超长截断到上限", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "长".repeat(2000) });
    const anchor = buildAnchor({ db: tmp.db, taskId }) ?? "";
    assert.ok(anchor.length <= ANCHOR_TEXT_LIMIT + 20, `实际 ${anchor.length}`);
    assert.match(anchor, /锚点已截短/);
  } finally {
    tmp.cleanup();
  }
});

test("钩子只注工人会话：task:<id> 注入，其它会话不注", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "工人的活" });
    const hook = createAnchorHook({ db: tmp.db });

    const worker = hook({ prompt: "hi", messages: [] }, { sessionKey: `task:${taskId}`, runId: "r1" });
    assert.ok(worker?.prependSystemContext?.includes(taskId));

    assert.equal(hook({ prompt: "hi", messages: [] }, { sessionKey: "dsbot:chief" }), undefined);
    assert.equal(hook({ prompt: "hi", messages: [] }, {}), undefined);
    assert.equal(hook({ prompt: "hi", messages: [] }, null), undefined);
  } finally {
    tmp.cleanup();
  }
});

test("任务号坏掉或账本抛错：钩子吞掉错误，不打断这一轮", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const logs: string[] = [];
    const hook = createAnchorHook({ db: tmp.db, logger: (level, msg) => logs.push(`${level}:${msg}`) });
    assert.equal(hook({ prompt: "x", messages: [] }, { sessionKey: "task:task_没有这个" }), undefined);
    assert.ok(logs.some((l) => l.includes("锚点任务不存在")));

    const throwing = createAnchorHook({
      db: tmp.db,
      logger: (level, msg) => logs.push(`${level}:${msg}`),
      build: () => {
        throw new Error("账本读挂了");
      },
    });
    assert.equal(throwing({ prompt: "x", messages: [] }, { sessionKey: "task:task_任意" }), undefined);
    assert.ok(logs.some((l) => l.includes("账本读挂了")));
  } finally {
    tmp.cleanup();
  }
});
