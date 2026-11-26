/**
 * src/drift/drift.test.ts —— 跑偏裁判的测试。
 *
 * 覆盖：三档结论（on_track / off_track / unclear）、模型抛错、模型返回读不懂、
 * 摘要超长截断、结论落账本（state_reason + drift_verdict 事件）、
 * 以及「判定不会把 done 改成 failed」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  beginStep,
  endStep,
  getTask,
  listMilestones,
  migrate,
  putArtifact,
  tailEvents,
  updateMilestone,
} from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { planTask } from "../plan/index.ts";
import { afterSettle } from "../dispatch/after-settle.ts";
import {
  DRIFT_MAX_STEPS,
  DRIFT_STEP_CHARS,
  buildDriftPrompt,
  collectDriftInput,
  judgeDrift,
  parseDriftVerdict,
  prepareStepSummaries,
  recordDriftVerdict,
  runDriftCheck,
  type DriftInput,
  type DriftStepSummary,
} from "./index.ts";

function baseInput(over: Partial<DriftInput> = {}): DriftInput {
  return {
    intent: "把桌面截图按月份归档，别删原始文件",
    milestoneTitle: "列出文件清单",
    doneWhen: "拿到所有文件名",
    stepSummaries: [
      { seq: 1, status: "succeeded", tool: "files", summary: "列了 42 个文件，没有改动任何一个" },
    ],
    ...over,
  };
}

function stepSummaries(n: number, summary = "一步的明细"): DriftStepSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    status: "succeeded",
    tool: "files",
    summary,
  }));
}

/**
 * 一个只有一段里程碑、任务已经 done 的账本；里程碑下挂一条带明细的已结束步骤。
 *
 * 关键：beginStep **不传 milestone_id**，与生产同形（src/hands/hand.ts:596-606、
 * src/hands/builtin.ts:331-341 都不传，src/ledger/steps.ts:151 落 null）。
 * 这样测试才能真正覆盖「裁判在生产里拿得到步骤」这条路径。
 */
function setupDoneTask() {
  const t = makeTempDb();
  migrate(t.db);
  const taskId = createTask(t.db, { intent: "把桌面截图按月份归档，别删原始文件", state: "queued" });
  planTask(t.db, {
    taskId,
    goal: "把桌面截图按月份归档，别删原始文件",
    milestones: [{ title: "列出文件清单", done_when: "拿到所有文件名" }],
    why: "先看清有什么再动",
  });
  const [milestone] = listMilestones(t.db, taskId);
  const artifact = putArtifact(t.db, "列了 42 个文件，没有改动任何一个");
  const step = beginStep(t.db, {
    task_id: taskId,
    run_epoch: 0,
    kind: "tool",
    tool: "files",
    subject_key: "list",
    side_effect: "safe",
    tier: 1,
  });
  endStep(t.db, step.id, { status: "succeeded", result_ref: artifact.hash });
  t.db.prepare("UPDATE tasks SET state = 'done' WHERE id = ?").run(taskId);
  return { ...t, taskId, milestone };
}

test("on_track：模型给 JSON，结论原样带回", async () => {
  const res = await judgeDrift(
    { complete: async () => '{"verdict":"on_track","why":"在列清单，没动文件","suggest":""}' },
    baseInput(),
  );
  assert.equal(res.verdict, "on_track");
  assert.equal(res.calledModel, true);
  assert.equal(res.why, "在列清单，没动文件");
  assert.equal(res.suggest, "");
});

test("off_track：围栏 JSON 也认得，suggest 一起带回", async () => {
  const res = await judgeDrift(
    {
      complete: async () =>
        '```json\n{"verdict":"off_track","why":"在删原始文件","suggest":"停下来先问人"}\n```',
    },
    baseInput(),
  );
  assert.equal(res.verdict, "off_track");
  assert.equal(res.why, "在删原始文件");
  assert.equal(res.suggest, "停下来先问人");
});

test("unclear：模型回话读不懂就退 unclear，不假装 on_track", async () => {
  const res = await judgeDrift({ complete: async () => "我觉得还行吧" }, baseInput());
  assert.equal(res.verdict, "unclear");
  assert.match(res.why, /读不懂/);
  assert.equal(res.calledModel, true, "读过模型，只是没读懂");
  assert.equal(parseDriftVerdict("我觉得还行吧"), null);
});

test("unclear：没有注入模型时明确说「没有可用的模型调用」", async () => {
  const res = await judgeDrift({}, baseInput());
  assert.equal(res.verdict, "unclear");
  assert.match(res.why, /没有可用的模型调用/);
  assert.equal(res.calledModel, false);
});

test("unclear：模型抛错时带上错误原文，不当成 on_track", async () => {
  const res = await judgeDrift(
    {
      complete: async () => {
        throw new Error("连接超时");
      },
    },
    baseInput(),
  );
  assert.equal(res.verdict, "unclear");
  assert.match(res.why, /模型调用失败：连接超时/);
  assert.equal(res.calledModel, false);
});

test("零原料闸：一条已结束步骤都没有时，模型就算回 on_track 也只给 unclear", async () => {
  let called = false;
  const res = await judgeDrift(
    {
      complete: async () => {
        called = true;
        return '{"verdict":"on_track","why":"看起来不错","suggest":""}';
      },
    },
    baseInput({ stepSummaries: [] }),
  );
  assert.equal(res.verdict, "unclear", "没原料不许判 on_track");
  assert.match(res.why, /没有已结束的步骤原料/);
  assert.equal(res.calledModel, false);
  assert.equal(called, false, "零原料压根不该调模型");
});

test("生产形状：步骤没标 milestone_id 也拿得到（退回任务最近步骤），提示词里写明", async () => {
  const t = setupDoneTask();
  try {
    let prompt = "";
    const res = await runDriftCheck(
      {
        db: t.db,
        complete: async (p) => {
          prompt = p;
          return '{"verdict":"on_track","why":"在列清单","suggest":""}';
        },
      },
      { taskId: t.taskId, milestoneId: t.milestone.id },
    );
    assert.equal(res?.verdict, "on_track");
    assert.ok(prompt.includes("列了 42 个文件"), `提示词里要有步骤明细：\n${prompt}`);
    assert.ok(!prompt.includes("共 0 步"), "不许对着空表判");
    assert.match(prompt, /任务最近 1 步/);
    assert.match(prompt, /没标里程碑/);

    // collectDriftInput 把来源标成 recent，不冒充 milestone。
    const input = collectDriftInput(t.db, t.taskId, t.milestone.id);
    assert.equal(input?.stepsSource, "recent");
    assert.equal(input?.stepSummaries.length, 1);
  } finally {
    t.cleanup();
  }
});

test("collectDriftInput：步骤标了本里程碑时优先按里程碑归集", () => {
  const t = makeTempDb();
  migrate(t.db);
  try {
    const taskId = createTask(t.db, { intent: "归档截图", state: "queued" });
    planTask(t.db, {
      taskId,
      goal: "归档截图",
      milestones: [
        { title: "第一段", done_when: "第一段做完" },
        { title: "第二段", done_when: "第二段做完" },
      ],
      why: "分两段",
    });
    const [ms1, ms2] = listMilestones(t.db, taskId);
    const tagged = beginStep(t.db, {
      task_id: taskId,
      milestone_id: ms1.id,
      run_epoch: 0,
      kind: "tool",
      tool: "files",
      subject_key: "k1",
      side_effect: "safe",
      tier: 1,
    });
    endStep(t.db, tagged.id, { status: "succeeded" });
    const untagged = beginStep(t.db, {
      task_id: taskId,
      run_epoch: 0,
      kind: "tool",
      tool: "files",
      subject_key: "k2",
      side_effect: "safe",
      tier: 1,
    });
    endStep(t.db, untagged.id, { status: "succeeded" });

    const input = collectDriftInput(t.db, taskId, ms1.id);
    assert.equal(input?.stepsSource, "milestone");
    assert.equal(input?.stepSummaries.length, 1, "只算标了本里程碑的那一步");
    assert.equal(collectDriftInput(t.db, taskId, ms2.id)?.stepsSource, "recent", "没有标记就退回最近步骤");
  } finally {
    t.cleanup();
  }
});

test("摘要超长截断：只留最近若干步，每条截断，提示词里写清省略了多少", async () => {
  const many = stepSummaries(DRIFT_MAX_STEPS + 5, "长".repeat(400));
  const prep = prepareStepSummaries(many);
  assert.equal(prep.steps.length, DRIFT_MAX_STEPS);
  assert.equal(prep.droppedSteps, 5);
  assert.equal(prep.truncated, true);
  assert.equal(prep.steps[0]?.seq, 6, "保留的是最近的步骤");
  assert.ok(prep.steps.every((s) => s.summary.length <= DRIFT_STEP_CHARS + 1));

  const prompt = buildDriftPrompt(baseInput({ stepSummaries: many }));
  assert.match(prompt, /早先 5 步已省略/);
  assert.ok(prompt.length < 6000, `提示词不能因为步骤多而膨胀（实际 ${prompt.length} 字）`);

  // 判一次也报 truncated，调用方能看见「原料被截过」。
  const res = await judgeDrift(
    { complete: async () => '{"verdict":"unclear","why":"原料太多","suggest":""}' },
    baseInput({ stepSummaries: many }),
  );
  assert.equal(res.truncated, true);
  assert.equal(res.droppedSteps, 5);
});

test("off_track 落账本：写 state_reason + drift_verdict 事件，状态原样不动", async () => {
  const t = setupDoneTask();
  try {
    const res = await runDriftCheck(
      { db: t.db, complete: async () => '{"verdict":"off_track","why":"在删原始文件","suggest":"停下问人"}' },
      { taskId: t.taskId, milestoneId: t.milestone.id },
    );
    assert.ok(res !== null);
    assert.equal(res.verdict, "off_track");
    assert.equal(res.reasonRecorded, true);
    assert.equal(typeof res.eventSeq, "number");

    const task = getTask(t.db, t.taskId);
    assert.equal(task?.state, "done", "判定不改终态");
    assert.match(task?.state_reason ?? "", /跑偏（drift=off_track）：在删原始文件/);

    const event = tailEvents(t.db, 5).find((e) => e.type === "drift_verdict");
    assert.ok(event !== undefined, "必须落一条 drift_verdict 事件");
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.equal(payload.verdict, "off_track");
    assert.equal(payload.milestone_id, t.milestone.id);
    assert.equal(payload.reason_recorded, true);
  } finally {
    t.cleanup();
  }
});

test("on_track / unclear 不盖任务原来的 state_reason", async () => {
  const t = setupDoneTask();
  try {
    t.db.prepare("UPDATE tasks SET state_reason = ? WHERE id = ?").run("原来的原因", t.taskId);

    const unclear = await runDriftCheck({ db: t.db }, { taskId: t.taskId, milestoneId: t.milestone.id });
    assert.equal(unclear?.verdict, "unclear");
    assert.equal(unclear?.reasonRecorded, false);
    assert.equal(getTask(t.db, t.taskId)?.state_reason, "原来的原因");

    const onTrack = await runDriftCheck(
      { db: t.db, complete: async () => '{"verdict":"on_track","why":"在正路上","suggest":""}' },
      { taskId: t.taskId, milestoneId: t.milestone.id },
    );
    assert.equal(onTrack?.verdict, "on_track");
    assert.equal(getTask(t.db, t.taskId)?.state_reason, "原来的原因");
    // 两档都各落一条事件，便于事后查判过几次。
    const verdicts = tailEvents(t.db, 10)
      .filter((e) => e.type === "drift_verdict")
      .map((e) => (JSON.parse(e.payload_json) as { verdict: string }).verdict);
    assert.deepEqual(verdicts, ["unclear", "on_track"]);
  } finally {
    t.cleanup();
  }
});

test("接入派发器：里程碑收尾判一次，off_track 也不会把 done 改成 failed", async () => {
  const t = setupDoneTask();
  try {
    const complete = async (prompt: string): Promise<string> =>
      prompt.includes("【跑偏裁判】")
        ? '{"verdict":"off_track","why":"在删原始文件","suggest":"停下问人"}'
        : "列了清单";

    const report = await afterSettle(
      {
        db: t.db,
        snapshotsRoot: join(t.dir, "snaps"),
        budgetTokens: 0,
        complete,
        judgeDrift: (input) => runDriftCheck({ db: t.db, complete }, input),
      },
      { taskId: t.taskId, outcome: "done" },
    );

    assert.equal(report.drift?.verdict, "off_track");
    const task = getTask(t.db, t.taskId);
    assert.equal(task?.state, "done", "跑偏判定不许把 done 改成 failed");
    assert.match(task?.state_reason ?? "", /跑偏（drift=off_track）/);
    assert.ok(tailEvents(t.db, 10).some((e) => e.type === "drift_verdict"));
  } finally {
    t.cleanup();
  }
});

test("接入派发器：会话 failed 时不跑跑偏裁判（里程碑没完成，判也没意义）", async () => {
  const t = setupDoneTask();
  try {
    let called = false;
    const report = await afterSettle(
      {
        db: t.db,
        snapshotsRoot: join(t.dir, "snaps"),
        budgetTokens: 0,
        judgeDrift: async () => {
          called = true;
          return null;
        },
      },
      { taskId: t.taskId, outcome: "failed" },
    );
    assert.equal(called, false);
    assert.equal(report.drift, null);
    // 精确断言：failed 分支只该有「连续失败重排」的说明，不该出现「跑偏裁判」。
    assert.ok(
      report.skipped.some((s) => s.startsWith("连续失败重排")),
      `skipped=${JSON.stringify(report.skipped)}`,
    );
    assert.ok(!report.skipped.some((s) => s.includes("跑偏裁判")), "failed 收尾不该跑裁判");
  } finally {
    t.cleanup();
  }
});

test("recordDriftVerdict：任务不存在也能落事件，但不写原因", () => {
  const t = makeTempDb();
  migrate(t.db);
  try {
    const out = recordDriftVerdict(t.db, {
      taskId: "task_not_there",
      milestoneId: "ms_not_there",
      result: {
        verdict: "off_track",
        why: "x",
        suggest: "",
        calledModel: true,
        truncated: false,
        droppedSteps: 0,
      },
    });
    assert.equal(out.reasonRecorded, false);
    assert.equal(typeof out.eventSeq, "number");
  } finally {
    t.cleanup();
  }
});

test("collectDriftInput：判第 2 段时不许把第 1 段的步骤当证据（下界=上一段结束时刻）", () => {
  const t = makeTempDb();
  migrate(t.db);
  try {
    const taskId = createTask(t.db, { intent: "归档截图", state: "queued" });
    planTask(t.db, {
      taskId,
      goal: "归档截图",
      milestones: [
        { title: "第一段", done_when: "第一段做完" },
        { title: "第二段", done_when: "第二段做完" },
      ],
      why: "分两段",
    });
    const [ms1, ms2] = listMilestones(t.db, taskId);

    // 第一段留下的 3 步（没标里程碑，生产里就是这样），时间戳压到很早。
    const old: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const step = beginStep(t.db, {
        task_id: taskId,
        run_epoch: 0,
        kind: "tool",
        tool: "files",
        subject_key: `old-${i}`,
        side_effect: "safe",
        tier: 1,
      });
      endStep(t.db, step.id, { status: "succeeded" });
      old.push(step.id);
    }
    t.db
      .prepare("UPDATE steps SET started_at = ? WHERE task_id = ?")
      .run("2026-11-25T00:00:00.000Z", taskId);
    updateMilestone(t.db, ms1.id, { state: "done", ended_at: "2026-11-25T01:00:00.000Z" });

    // 第二段的 2 步，时间是现在（在上一段结束之后）。
    for (let i = 0; i < 2; i += 1) {
      const step = beginStep(t.db, {
        task_id: taskId,
        run_epoch: 0,
        kind: "tool",
        tool: "files",
        subject_key: `new-${i}`,
        side_effect: "safe",
        tier: 1,
      });
      endStep(t.db, step.id, { status: "succeeded" });
    }

    const input = collectDriftInput(t.db, taskId, ms2.id);
    assert.equal(input?.stepsSource, "recent");
    assert.equal(input?.stepSummaries.length, 2, "只喂第二段之后的步骤，第 1 段那 3 步不能进来");
    assert.deepEqual(
      input?.stepSummaries.map((s) => s.seq),
      [4, 5],
    );
  } finally {
    t.cleanup();
  }
});
