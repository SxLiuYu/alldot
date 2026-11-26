/**
 * src/plan/plan.test.ts —— 分层计划写入口的测试。
 * 只覆盖 plan 模块自己的行为；账本函数的细节由 src/ledger 下的测试负责。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LedgerError,
  getMilestone,
  getTask,
  latestPlan,
  listDecisions,
  listMilestones,
  listPlans,
  migrate,
} from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import {
  REPLAN_REASONS,
  advanceMilestone,
  currentRoundPlan,
  planTask,
  recordAlignment,
  replan,
  setRoundPlan,
  whyWeDidThis,
} from "./index.ts";

function setup() {
  const t = makeTempDb();
  migrate(t.db);
  const taskId = createTask(t.db, { intent: "把桌面截图按月份归档" });
  return { ...t, taskId };
}

function throwsCode(code: string) {
  return (err: unknown) => err instanceof LedgerError && err.code === code;
}

const THREE: Array<{ title: string; done_when: string }> = [
  { title: "列出文件清单", done_when: "拿到所有截图文件名" },
  { title: "按月份分组", done_when: "每个月对应一个目录" },
  { title: "搬文件", done_when: "文件都进了对应月份目录" },
];

test("planTask：seq 从 1 连续，第一个 active，plan_version=1，latestPlan 拿得到", () => {
  const t = setup();
  try {
    const why = "你说按文件名里的月份分，不打开看内容";
    planTask(t.db, { taskId: t.taskId, goal: "把桌面截图按月份归档", milestones: THREE, why });

    const ms = listMilestones(t.db, t.taskId);
    assert.deepEqual(ms.map((m) => m.seq), [1, 2, 3]);
    assert.equal(ms[0].state, "active");
    assert.equal(ms[1].state, "pending");
    assert.equal(ms[2].state, "pending");

    const task = getTask(t.db, t.taskId);
    assert.ok(task);
    assert.equal(task.plan_version, 1);
    assert.equal(task.milestone_id, ms[0].id);

    const plan = latestPlan(t.db, t.taskId);
    assert.ok(plan);
    assert.equal(plan.version, 1);
    assert.equal(plan.why, why);
    assert.equal(plan.milestone_id, ms[0].id);
    const content = JSON.parse(plan.content_json) as {
      goal?: string;
      milestones?: unknown[];
    };
    assert.equal(content.goal, "把桌面截图按月份归档");
    assert.equal(content.milestones?.length, 3);
  } finally {
    t.cleanup();
  }
});

test("planTask：空里程碑与重复首拆都抛错", () => {
  const t = setup();
  try {
    assert.throws(
      () => planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: [], why: "空" }),
      throwsCode("bad_plan"),
    );
    planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: THREE, why: "先拆一次" });
    assert.throws(
      () => planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: THREE, why: "再拆一次" }),
      throwsCode("already_planned"),
    );
  } finally {
    t.cleanup();
  }
});

test("replan：version=2 且旧行还在；换掉的里程碑标 skipped；非法 reason 抛错", () => {
  const t = setup();
  try {
    planTask(t.db, {
      taskId: t.taskId,
      goal: "把桌面截图按月份归档",
      milestones: THREE,
      why: "按月份分",
    });
    const before = listMilestones(t.db, t.taskId);
    const oldActive = before[0];

    const out = replan(t.db, {
      taskId: t.taskId,
      reason: "user_changed_mind",
      why: "改成按季度分",
      milestones: [{ title: "按季度分", done_when: "每个季度一个目录" }],
    });
    assert.equal(out.plan.version, 2);
    assert.ok(out.skipped.some((m) => m.id === oldActive.id));

    const plans = listPlans(t.db, t.taskId);
    assert.deepEqual(plans.map((p) => p.version), [1, 2]);
    assert.equal(plans[0].why, "按月份分");

    const task = getTask(t.db, t.taskId);
    assert.ok(task);
    assert.equal(task.plan_version, 2);

    const after = listMilestones(t.db, t.taskId);
    const oldRow = after.find((m) => m.id === oldActive.id);
    assert.ok(oldRow);
    assert.equal(oldRow.state, "skipped");

    const active = after.filter((m) => m.state === "active");
    assert.equal(active.length, 1);
    assert.equal(task.milestone_id, active[0].id);
    // 旧的最大 seq 是 3，新的接着编 4。
    assert.equal(active[0].seq, 4);
    assert.equal(latestPlan(t.db, t.taskId)?.version, 2);

    assert.throws(
      () => replan(t.db, { taskId: t.taskId, reason: "因为我想", why: "随便" }),
      throwsCode("bad_replan_reason"),
    );
  } finally {
    t.cleanup();
  }
});

test("replan：不带 milestones 只改版本与理由，里程碑不动", () => {
  const t = setup();
  try {
    planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: THREE, why: "初版" });
    const before = listMilestones(t.db, t.taskId);
    const taskBefore = getTask(t.db, t.taskId);

    const out = replan(t.db, { taskId: t.taskId, reason: "budget_over_80", why: "预算紧，先只做前两步" });
    assert.equal(out.plan.version, 2);
    assert.equal(out.skipped.length, 0);

    const after = listMilestones(t.db, t.taskId);
    assert.deepEqual(
      after.map((m) => [m.id, m.state]),
      before.map((m) => [m.id, m.state]),
    );
    const task = getTask(t.db, t.taskId);
    assert.ok(task && taskBefore);
    assert.equal(task.plan_version, 2);
    assert.equal(task.milestone_id, taskBefore.milestone_id);
  } finally {
    t.cleanup();
  }
});

test("advanceMilestone：依次推进，最后一个返回 finished 且不改任务状态", () => {
  const t = setup();
  try {
    planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: THREE, why: "三步" });
    const [m1, m2, m3] = listMilestones(t.db, t.taskId);

    const a1 = advanceMilestone(t.db, { taskId: t.taskId, milestoneId: m1.id });
    assert.equal(a1.finished, false);
    assert.equal(a1.milestone?.id, m2.id);
    assert.equal(a1.milestone?.state, "active");
    assert.equal(getMilestone(t.db, m1.id)?.state, "done");
    assert.notEqual(getMilestone(t.db, m1.id)?.ended_at, null);
    assert.equal(getTask(t.db, t.taskId)?.milestone_id, m2.id);

    const a2 = advanceMilestone(t.db, { taskId: t.taskId, milestoneId: m2.id });
    assert.equal(a2.finished, false);
    assert.equal(a2.milestone?.id, m3.id);

    const a3 = advanceMilestone(t.db, { taskId: t.taskId, milestoneId: m3.id });
    assert.equal(a3.finished, true);
    assert.equal(a3.milestone, null);
    assert.equal(getTask(t.db, t.taskId)?.milestone_id, null);

    // 收尾不是 plan 的事：任务状态保持原样。
    assert.equal(getTask(t.db, t.taskId)?.state, "queued");

    // 乱序 / 已结束的都不能再推。
    assert.throws(
      () => advanceMilestone(t.db, { taskId: t.taskId, milestoneId: m1.id }),
      throwsCode("not_current_milestone"),
    );
  } finally {
    t.cleanup();
  }
});

test("recordAlignment 写进 decisions，whyWeDidThis 读得回来并含那句话", () => {
  const t = setup();
  try {
    const why = "按文件名里的月份分，不打开看内容";
    planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: THREE, why });
    const m1 = listMilestones(t.db, t.taskId)[0];
    const note = "对上了：按月份分，没打开任何文件";

    const row = recordAlignment(t.db, {
      taskId: t.taskId,
      milestoneId: m1.id,
      aligned: true,
      note,
    });
    assert.equal(row.question, `为什么这样做：${m1.title}`);
    assert.equal(row.answer, note);
    assert.equal(row.decided_by, "system");

    const decisions = listDecisions(t.db, t.taskId);
    assert.equal(decisions.length, 1);

    const answer = whyWeDidThis(t.db, { taskId: t.taskId, milestoneId: m1.id });
    assert.ok(answer.includes(note));
    assert.ok(answer.includes(why));
    assert.ok(answer.length <= 500);

    const missing = whyWeDidThis(t.db, { taskId: t.taskId, milestoneId: "ms_nope" });
    assert.match(missing, /查不到/);
  } finally {
    t.cleanup();
  }
});

test("重复 replan 不产生两条同 version：版本严格递增，plan_version 跟到最后一条", () => {
  const t = setup();
  try {
    // 枚举与方案 5.3 的四个触发对齐（dot-合并方案-v2-定稿.md:282）。
    assert.deepEqual(
      [...REPLAN_REASONS],
      ["milestone_done", "milestone_failed_twice", "budget_over_80", "user_changed_mind"],
    );

    planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: THREE, why: "初版" });
    replan(t.db, { taskId: t.taskId, reason: "milestone_done", why: "第一段做完了，往后看" });
    replan(t.db, { taskId: t.taskId, reason: "milestone_failed_twice", why: "连败两步，换法子" });
    replan(t.db, { taskId: t.taskId, reason: "user_changed_mind", why: "改成按季度" });

    const plans = listPlans(t.db, t.taskId);
    assert.deepEqual(plans.map((p) => p.version), [1, 2, 3, 4]);

    const dup = t.db
      .prepare("SELECT version, COUNT(*) AS n FROM plans WHERE task_id = ? GROUP BY version HAVING n > 1")
      .all(t.taskId) as Array<{ version?: number; n?: number }>;
    assert.equal(dup.length, 0);

    assert.equal(getTask(t.db, t.taskId)?.plan_version, 4);
    assert.equal(latestPlan(t.db, t.taskId)?.version, 4);

    // 四个固定原因都认。
    for (const reason of REPLAN_REASONS) {
      const out = replan(t.db, { taskId: t.taskId, reason, why: `试 ${reason}` });
      assert.ok(out.plan.version >= 5);
    }
  } finally {
    t.cleanup();
  }
});

test("setRoundPlan / currentRoundPlan：挂在最新 plans 行，重排后归新版本", () => {
  const t = setup();
  try {
    planTask(t.db, { taskId: t.taskId, goal: "归档", milestones: THREE, why: "三步" });
    assert.equal(currentRoundPlan(t.db, t.taskId), null);

    const written = setRoundPlan(t.db, {
      taskId: t.taskId,
      steps: ["读文件名", "按月份建目录"],
      note: "先不动文件",
    });
    assert.equal(written.version, 1);
    assert.deepEqual(written.steps, ["读文件名", "按月份建目录"]);

    const read = currentRoundPlan(t.db, t.taskId);
    assert.ok(read);
    assert.equal(read.version, 1);
    assert.equal(read.milestoneId, getTask(t.db, t.taskId)?.milestone_id);
    assert.equal(read.note, "先不动文件");
    assert.deepEqual(read.steps, ["读文件名", "按月份建目录"]);

    // 同一版本再写：覆盖本轮计划，不动 goal。
    setRoundPlan(t.db, { taskId: t.taskId, steps: ["读文件名"] });
    assert.deepEqual(currentRoundPlan(t.db, t.taskId)?.steps, ["读文件名"]);
    const content = JSON.parse(latestPlan(t.db, t.taskId)?.content_json ?? "{}") as {
      goal?: string;
      round_plan?: { steps?: string[] };
    };
    assert.equal(content.goal, "归档");
    assert.deepEqual(content.round_plan?.steps, ["读文件名"]);

    // 重排出新版本后，本轮计划归新版本；没写过就是 null。
    replan(t.db, { taskId: t.taskId, reason: "user_changed_mind", why: "换个法子" });
    assert.equal(currentRoundPlan(t.db, t.taskId), null);
    assert.equal(setRoundPlan(t.db, { taskId: t.taskId, steps: ["重来"] }).version, 2);

    // 没有计划的任务不能写本轮计划。
    const bare = createTask(t.db, { intent: "还没拆的任务" });
    assert.throws(
      () => setRoundPlan(t.db, { taskId: bare, steps: ["随便"] }),
      throwsCode("no_plan"),
    );
  } finally {
    t.cleanup();
  }
});

test("对齐记录按标题精确匹配：标题是另一个的子串时不串记录", () => {
  const t = setup();
  try {
    planTask(t.db, {
      taskId: t.taskId,
      goal: "归档",
      milestones: [
        { title: "搬文件", done_when: "文件移动了" },
        { title: "搬文件到归档", done_when: "都进了归档目录" },
      ],
      why: "先搬再归",
    });
    const [short, long] = listMilestones(t.db, t.taskId);

    recordAlignment(t.db, {
      taskId: t.taskId,
      milestoneId: long.id,
      aligned: true,
      note: "只属于长标题的那句",
    });

    const shortAnswer = whyWeDidThis(t.db, { taskId: t.taskId, milestoneId: short.id });
    assert.ok(!shortAnswer.includes("只属于长标题的那句"));
    assert.ok(shortAnswer.includes("先搬再归"));

    const longAnswer = whyWeDidThis(t.db, { taskId: t.taskId, milestoneId: long.id });
    assert.ok(longAnswer.includes("只属于长标题的那句"));
  } finally {
    t.cleanup();
  }
});
