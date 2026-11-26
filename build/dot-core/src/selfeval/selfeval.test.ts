/**
 * src/selfeval/selfeval.test.ts —— 体检的验收。
 *
 * 要钉住的四件事：
 * 1. 空账本返回全 0，不报错（「不许编数」的底线）；
 * 2. 有数据时每个数都对；
 * 3. 失败归因按文本归到五个桶，结算器的汇总行不混进原因；
 * 4. 时间窗与 taskId 过滤口径清楚（0 = 不限时间）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { beginStep, endStep, migrate, setTaskState } from "../ledger/index.ts";
import { createApproval, createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { classifyFailure, collectMetrics } from "./index.ts";

function zeroMetrics() {
  return {
    tasksDone: 0,
    tasksFailed: 0,
    doneRate: 0,
    avgSteps: 0,
    spinStops: 0,
    snapshotFailures: 0,
    approvalsPending: 0,
    modelErrors: 0,
    topFailureReasons: [],
  };
}

test("空账本：全 0，不抛（不许报错、不许编数）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    assert.deepEqual(collectMetrics(t.db, { sinceDays: 7 }), zeroMetrics());
    // 不带任何选项也要能跑（默认 7 天）。
    assert.deepEqual(collectMetrics(t.db), zeroMetrics());
  } finally {
    t.cleanup();
  }
});

test("有数据：done/failed、doneRate、avgSteps、审批挂起量都算得对", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);

    const okTask = createTask(t.db, { intent: "把截图按月份归档" });
    setTaskState(t.db, okTask, "running");
    for (let i = 0; i < 3; i += 1) {
      const step = beginStep(t.db, {
        task_id: okTask,
        run_epoch: 0,
        kind: "tool",
        subject_key: `ok-${i}`,
        side_effect: "safe",
      });
      endStep(t.db, step.id, { status: "succeeded" });
    }
    setTaskState(t.db, okTask, "done", { reason: "所有步骤都成功或跳过（共 3 步）" });

    const badTask = createTask(t.db, { intent: "改一小时前那份表格" });
    setTaskState(t.db, badTask, "running");
    const s1 = beginStep(t.db, {
      task_id: badTask,
      run_epoch: 0,
      kind: "tool",
      subject_key: "bad-1",
      side_effect: "replayable",
    });
    endStep(t.db, s1.id, { status: "failed", error: "snapshot_failed: 目标不存在" });
    const s2 = beginStep(t.db, {
      task_id: badTask,
      run_epoch: 0,
      kind: "llm",
      subject_key: "bad-2",
      side_effect: "safe",
    });
    endStep(t.db, s2.id, { status: "succeeded" });
    setTaskState(t.db, badTask, "failed", { reason: "有 1 步没成功（failed=1，interrupted=0，rolled_back=0）" });

    createApproval(t.db, { taskId: okTask, status: "pending", title: "要不要覆盖原文件" });
    createApproval(t.db, { taskId: okTask, status: "approved", title: "已经批过的" });

    const m = collectMetrics(t.db, { sinceDays: 7 });
    assert.equal(m.tasksDone, 1);
    assert.equal(m.tasksFailed, 1);
    assert.equal(m.doneRate, 0.5);
    assert.equal(m.avgSteps, 2.5, "(3 + 2) / 2");
    assert.equal(m.approvalsPending, 1, "只数 pending，approved 不算挂起");
    assert.equal(m.snapshotFailures, 1);
    assert.equal(m.modelErrors, 0);
    assert.equal(m.spinStops, 0);

    const reasons = new Map(m.topFailureReasons.map((r) => [r.reason, r.count]));
    assert.equal(reasons.get("快照失败"), 1);
    // 结算器写的「有 1 步没成功（…）」是汇总行，不许当成一条失败原因。
    assert.equal(reasons.size, 1, `不该混进汇总行：${JSON.stringify(m.topFailureReasons)}`);
  } finally {
    t.cleanup();
  }
});

test("失败归因：五个桶 + 其他；空文本与汇总行不算原因", () => {
  assert.equal(classifyFailure("工人打转，自述还没做完：还差目录没建"), "原地打转");
  assert.equal(classifyFailure("snapshot_failed: 目标不存在"), "快照失败");
  assert.equal(classifyFailure("快照失败：练习目录不可写"), "快照失败");
  assert.equal(classifyFailure("模型调用失败：模型池回了 502"), "模型调用失败");
  assert.equal(classifyFailure("超出练习范围（越界路径）"), "超范围");
  assert.equal(classifyFailure("denied: human_only_apps"), "超范围");
  assert.equal(classifyFailure("这件事我干不了：没有权限"), "干不了");
  assert.equal(classifyFailure("会话结束但一步都没做（no_steps）"), "干不了");
  assert.equal(classifyFailure("遥控器没电了"), "其他");
  assert.equal(classifyFailure(""), null);
  assert.equal(classifyFailure(null), null);
  assert.equal(classifyFailure("有 3 步没成功（failed=2，interrupted=1，rolled_back=0）"), null);
});

test("打转停下与模型报错按任务/步骤分别计数", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const spin = createTask(t.db, { intent: "反复列目录" });
    setTaskState(t.db, spin, "running");
    const s = beginStep(t.db, {
      task_id: spin,
      run_epoch: 0,
      kind: "llm",
      subject_key: "spin-1",
      side_effect: "safe",
    });
    endStep(t.db, s.id, { status: "failed", error: "模型调用失败：401 unauthorized" });
    // 同一个任务第二条打转失败步：原因按任务去重，count 仍应是 1。
    const s2 = beginStep(t.db, {
      task_id: spin,
      run_epoch: 0,
      kind: "tool",
      subject_key: "spin-1b",
      side_effect: "safe",
    });
    endStep(t.db, s2.id, { status: "failed", error: "工人在原地打转，停下：同一个动作已经重复 3 次，结果没变" });
    // 恢复协议写的 interrupted 说明不是根因，不许进失败原因。
    const rec = beginStep(t.db, {
      task_id: spin,
      run_epoch: 0,
      kind: "tool",
      subject_key: "spin-2",
      side_effect: "replayable",
    });
    endStep(t.db, rec.id, { status: "interrupted", error: "recovered: replayable, requeued" });
    setTaskState(t.db, spin, "failed", { reason: "工人打转，自述还没做完：还差一点" });

    const m = collectMetrics(t.db, { sinceDays: 7 });
    assert.equal(m.tasksDone, 0);
    assert.equal(m.tasksFailed, 1);
    assert.equal(m.spinStops, 1);
    assert.equal(m.modelErrors, 1);
    const byReason = new Map(m.topFailureReasons.map((r) => [r.reason, r.count]));
    assert.equal(byReason.get("原地打转"), 1);
    assert.equal(byReason.get("模型调用失败"), 1);
    assert.equal(byReason.size, 2, `recovered 说明不该算一条原因：${JSON.stringify(m.topFailureReasons)}`);
  } finally {
    t.cleanup();
  }
});

test("时间窗与 taskId：老任务不进窗口，sinceDays=0 不限时间", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const fresh = createTask(t.db, { intent: "今天的事" });
    setTaskState(t.db, fresh, "done", { reason: "做完了" });
    const old = createTask(t.db, { intent: "很久以前的事" });
    setTaskState(t.db, old, "failed", { reason: "模型调用失败：旧账" });
    t.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", old);

    const windowed = collectMetrics(t.db, { sinceDays: 7 });
    assert.equal(windowed.tasksDone, 1);
    assert.equal(windowed.tasksFailed, 0);

    const all = collectMetrics(t.db, { sinceDays: 0 });
    assert.equal(all.tasksDone, 1);
    assert.equal(all.tasksFailed, 1);

    const onlyOld = collectMetrics(t.db, { sinceDays: 0, taskId: old });
    assert.equal(onlyOld.tasksDone, 0);
    assert.equal(onlyOld.tasksFailed, 1);
    assert.deepEqual(onlyOld.topFailureReasons, [{ reason: "模型调用失败", count: 1 }]);
  } finally {
    t.cleanup();
  }
});
