/**
 * src/plan/auto-plan.test.ts —— 自动拆里程碑的测试。
 *
 * 覆盖：已有计划跳过、模型回 JSON 的解析容错（围栏/杂文本/数量校验）、
 * 正常拆解落库、模型调用失败的异常处理。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, listMilestones, listPlans } from "../ledger/index.ts";
import { autoPlan } from "./auto-plan.ts";
import { makeTempDb, createTask } from "../ledger/test-helpers.ts";

function fixture() {
  const t = makeTempDb();
  migrate(t.db);
  return { db: t.db, cleanup: t.cleanup };
}

test("autoPlan：已有计划就跳过", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    // 先建一个计划
    f.db.prepare("INSERT INTO plans (id, task_id, version, milestone_id, content_json, why, created_at) VALUES ('p1', ?, 1, NULL, '{}', 'test', datetime('now'))").run(taskId);
    const result = await autoPlan(f.db, taskId, async () => '[{"title":"a","done_when":"b"}]');
    assert.equal(result.ok, false);
    assert.match(result.reason, /已有计划/);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：任务不存在", async () => {
  const f = fixture();
  try {
    const result = await autoPlan(f.db, "no-such-task", async () => "[]");
    assert.equal(result.ok, false);
    assert.match(result.reason, /不存在/);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：任务没有描述", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "" });
    const result = await autoPlan(f.db, taskId, async () => "[]");
    assert.equal(result.ok, false);
    assert.match(result.reason, /没有描述/);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：正常 JSON 解析并建里程碑", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "在桌面建一个文件夹" });
    const model = async () =>
      JSON.stringify([
        { title: "确认桌面路径", done_when: "桌面路径存在" },
        { title: "建文件夹", done_when: "文件夹已创建" },
        { title: "验证", done_when: "文件夹可写" },
      ]);
    const result = await autoPlan(f.db, taskId, model);
    assert.equal(result.ok, true);
    assert.equal(result.milestones.length, 3);

    const ms = listMilestones(f.db, taskId);
    assert.equal(ms.length, 3);
    assert.equal(ms[0]?.state, "active");
    assert.equal(ms[1]?.state, "pending");

    // 应该有 plan 行
    const plans = listPlans(f.db, taskId);
    assert.equal(plans.length, 1);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：容忍 ``` 围栏", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    const model = async () =>
      "```json\n" +
      JSON.stringify([
        { title: "a", done_when: "done a" },
        { title: "b", done_when: "done b" },
      ]) +
      "\n```";
    const result = await autoPlan(f.db, taskId, model);
    assert.equal(result.ok, true);
    assert.equal(result.milestones.length, 2);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：容忍 JSON 前后的杂文本", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    const model = async () =>
      '好的，我来拆解：\n[{"title":"x","done_when":"y"},{"title":"z","done_when":"w"}]\n希望有帮助！';
    const result = await autoPlan(f.db, taskId, model);
    assert.equal(result.ok, true);
    assert.equal(result.milestones.length, 2);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：模型回太少里程碑（<2）拒绝", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    const model = async () => JSON.stringify([{ title: "only one", done_when: "done" }]);
    const result = await autoPlan(f.db, taskId, model);
    assert.equal(result.ok, false);
    assert.match(result.reason, /太少|不对/);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：模型回非法 JSON", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    const model = async () => "这根本不是 JSON";
    const result = await autoPlan(f.db, taskId, model);
    assert.equal(result.ok, false);
    assert.match(result.reason, /不是合法 JSON/);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：模型调用失败", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    const model = async (): Promise<string> => {
      throw new Error("网络断了");
    };
    const result = await autoPlan(f.db, taskId, model);
    assert.equal(result.ok, false);
    assert.match(result.reason, /模型调用失败/);
  } finally {
    f.cleanup();
  }
});

test("autoPlan：缺 done_when 的条目被过滤", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    const model = async () =>
      JSON.stringify([
        { title: "a", done_when: "done a" },
        { title: "b" }, // 缺 done_when
        { title: "c", done_when: "done c" },
      ]);
    const result = await autoPlan(f.db, taskId, model);
    assert.equal(result.ok, true);
    assert.equal(result.milestones.length, 2); // b 被过滤掉
  } finally {
    f.cleanup();
  }
});

test("autoPlan：里程碑数量上限（超过 5 个也全收，提示词约束不强制）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db, { intent: "做个东西" });
    const model = async () =>
      JSON.stringify(
        Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, done_when: `d${i}` })),
      );
    const result = await autoPlan(f.db, taskId, model);
    // 当前实现接受 >=2 的数量（上限未强制），这里钉住行为
    assert.equal(result.ok, true);
    assert.equal(result.milestones.length, 7);
  } finally {
    f.cleanup();
  }
});
