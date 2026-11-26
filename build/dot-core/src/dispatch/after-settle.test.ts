/**
 * src/dispatch/after-settle.test.ts —— 结算之后那段收尾的测试。
 *
 * 覆盖四件事里能机器验的三件（「你改了主意」是人的动作，走桥路由，见 bridge 的测试）：
 *   1. 里程碑完成：拍快照 → 压小结 → 推进里程碑 → 记 milestone_done；
 *   2. 同一里程碑连续失败 2 步 → 记 milestone_failed_twice（同一里程碑只记一次）；
 *   3. 预算过八成 → 记 budget_over_80；
 *   4. 没有计划的任务不被塞空计划行。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  beginStep,
  endStep,
  getMilestone,
  getTask,
  latestPlan,
  listMilestones,
  listPlans,
  migrate,
  recordSpend,
} from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { planTask } from "../plan/index.ts";
import { afterSettle, budgetRatio, consecutiveFailures } from "./after-settle.ts";

const TWO = [
  { title: "列出文件清单", done_when: "拿到所有文件名" },
  { title: "搬文件", done_when: "文件都进了对应目录" },
];

function setup() {
  const t = makeTempDb();
  migrate(t.db);
  const workspace = join(t.dir, "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "原本就在的文件", "utf8");
  const taskId = createTask(t.db, { intent: "把桌面截图按月份归档", state: "queued" });
  t.db.prepare("UPDATE tasks SET declared_json = ? WHERE id = ?").run(JSON.stringify({ workspace }), taskId);
  planTask(t.db, { taskId, goal: "把桌面截图按月份归档", milestones: TWO, why: "按文件名里的月份分" });
  const milestones = listMilestones(t.db, taskId);
  return { ...t, taskId, workspace, snapshotsRoot: join(t.dir, "snaps"), milestones };
}

/** 在这个里程碑下落一步，按给定状态收尾。 */
function stepIn(
  db: ReturnType<typeof makeTempDb>["db"],
  taskId: string,
  milestoneId: string,
  status: "succeeded" | "failed" | "rolled_back",
  key: string,
): void {
  const step = beginStep(db, {
    task_id: taskId,
    milestone_id: milestoneId,
    run_epoch: 0,
    kind: "tool",
    tool: "files",
    subject_key: key,
    side_effect: "replayable",
    tier: 1,
  });
  endStep(db, step.id, { status });
}

test("里程碑完成：拍快照 → 写小结 → 推进到下一个 → 记 milestone_done 重排点", async () => {
  const t = setup();
  try {
    const current = getMilestone(t.db, t.milestones[0].id);
    assert.ok(current !== null);
    stepIn(t.db, t.taskId, current.id, "succeeded", "k1");
    // 结算已经把任务判 done 了；afterSettle 的推进要把「还有下一段」这件事接住。
    t.db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(t.taskId);

    const report = await afterSettle(
      { db: t.db, snapshotsRoot: t.snapshotsRoot, budgetTokens: 0, complete: async () => "把清单列出来了，共 3 个文件" },
      { taskId: t.taskId, outcome: "done" },
    );

    assert.ok(report.snapshotId !== null, "声明了工作区就该拍到里程碑快照");
    assert.equal(report.summaryMilestoneId, current.id);
    assert.equal(getMilestone(t.db, current.id)?.summary, "把清单列出来了，共 3 个文件");
    assert.equal(getMilestone(t.db, current.id)?.state, "done");
    assert.equal(report.advancedTo, t.milestones[1].id, "指针要挪到下一个里程碑");
    assert.equal(getTask(t.db, t.taskId)?.milestone_id, t.milestones[1].id);
    // 关键：不能停在 done —— done 是终态，派发器只捞 queued，否则第二段永远没人跑。
    assert.equal(report.requeued, true);
    assert.equal(getTask(t.db, t.taskId)?.state, "queued");
    assert.equal(getTask(t.db, t.taskId)?.run_epoch, 1, "下一段是新活，epoch 要换新（幂等键不能复用）");
    assert.equal(getMilestone(t.db, t.milestones[1].id)?.state, "active");
    assert.deepEqual(report.replans.map((r) => r.reason), ["milestone_done"]);
    assert.equal(listPlans(t.db, t.taskId).length, 2, "首拆 v1 + 重排点 v2");
    assert.equal(latestPlan(t.db, t.taskId)?.version, 2);
  } finally {
    t.cleanup();
  }
});

test("最后一个里程碑完成：不动任务状态、不放回队列", async () => {
  const t = makeTempDb();
  migrate(t.db);
  try {
    const workspace = join(t.dir, "ws");
    mkdirSync(workspace, { recursive: true });
    const taskId = createTask(t.db, { intent: "只有一段", state: "queued" });
    t.db.prepare("UPDATE tasks SET declared_json = ? WHERE id = ?").run(JSON.stringify({ workspace }), taskId);
    planTask(t.db, { taskId, goal: "只有一段", milestones: [{ title: "唯一一段", done_when: "做完" }], why: "简单" });
    const [only] = listMilestones(t.db, taskId);
    stepIn(t.db, taskId, only.id, "succeeded", "k1");
    t.db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(taskId);

    const report = await afterSettle(
      { db: t.db, snapshotsRoot: join(t.dir, "snaps"), budgetTokens: 0, complete: async () => "一段做完了" },
      { taskId, outcome: "done" },
    );

    assert.equal(report.advancedTo, null);
    assert.equal(report.requeued, false);
    assert.equal(getTask(t.db, taskId)?.state, "done", "最后一段做完就停在 done");
    assert.equal(getTask(t.db, taskId)?.milestone_id, null);
  } finally {
    t.cleanup();
  }
});

test("同一里程碑连续失败 2 步：记一次 milestone_failed_twice，再跑不重复记", async () => {
  const t = setup();
  try {
    const current = t.milestones[0];
    stepIn(t.db, t.taskId, current.id, "failed", "f1");
    stepIn(t.db, t.taskId, current.id, "failed", "f2");
    assert.equal(consecutiveFailures(t.db, t.taskId, current.id), 2);

    const deps = { db: t.db, snapshotsRoot: t.snapshotsRoot, budgetTokens: 0 };
    const first = await afterSettle(deps, { taskId: t.taskId, outcome: "failed" });
    assert.deepEqual(first.replans.map((r) => r.reason), ["milestone_failed_twice"]);

    const second = await afterSettle(deps, { taskId: t.taskId, outcome: "failed" });
    assert.deepEqual(second.replans, [], "同一个里程碑只记一次重排点");
    assert.equal(listPlans(t.db, t.taskId).length, 2);
  } finally {
    t.cleanup();
  }
});

test("rolled_back 不算连续失败（回退是人让退的，不是这一段做砸了）", () => {
  const t = setup();
  try {
    stepIn(t.db, t.taskId, t.milestones[0].id, "rolled_back", "r1");
    assert.equal(consecutiveFailures(t.db, t.taskId, t.milestones[0].id), 0);
  } finally {
    t.cleanup();
  }
});

test("预算过八成：记 budget_over_80（同一任务只记一次）", async () => {
  const t = setup();
  try {
    recordSpend(t.db, { task_id: t.taskId, input_tokens: 90, output_tokens: 0 });
    assert.ok(budgetRatio(t.db, t.taskId, 100) >= 0.8);

    const deps = { db: t.db, snapshotsRoot: t.snapshotsRoot, budgetTokens: 100 };
    const first = await afterSettle(deps, { taskId: t.taskId, outcome: "failed" });
    assert.deepEqual(first.replans.map((r) => r.reason), ["budget_over_80"]);
    const second = await afterSettle(deps, { taskId: t.taskId, outcome: "failed" });
    assert.deepEqual(second.replans, []);
  } finally {
    t.cleanup();
  }
});

test("没有计划也没有里程碑的任务：不塞空计划行，也不拍快照", async () => {
  const t = makeTempDb();
  migrate(t.db);
  try {
    const taskId = createTask(t.db, { intent: "随手问一句", state: "running" });
    const report = await afterSettle(
      { db: t.db, snapshotsRoot: join(t.dir, "snaps"), budgetTokens: 100 },
      { taskId, outcome: "done" },
    );
    assert.deepEqual(report.replans, []);
    assert.equal(report.snapshotId, null);
    assert.equal(listPlans(t.db, taskId).length, 0);
  } finally {
    t.cleanup();
  }
});
