/**
 * src/context/stage-summary.test.ts —— 一段（里程碑）压成小结的验收。
 *
 * 钉住：第一次调模型、第二次不调（幂等）；只压本里程碑的步骤；小结超 300 字被截；
 * 明细前缀最多取 200 字；小结写回 milestones.summary。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  beginStep,
  endStep,
  getMilestone,
  migrate,
  putArtifact,
  type LedgerDb,
} from "../ledger/index.ts";
import { createMilestone, createTask, makeTempDb } from "../ledger/test-helpers.ts";
import {
  RESULT_PREVIEW_CHARS,
  STAGE_SUMMARY_LIMIT,
  summarizeMilestone,
  type StageSummaryDeps,
} from "./stage-summary.ts";

function addFinishedStep(
  db: LedgerDb,
  input: { taskId: string; milestoneId: string; tool: string; resultRef?: string | null; error?: string },
): void {
  const step = beginStep(db, {
    task_id: input.taskId,
    milestone_id: input.milestoneId,
    run_epoch: 0,
    kind: "tool",
    tool: input.tool,
    subject_key: `sk-${input.tool}`,
    side_effect: "safe",
    tier: 1,
  });
  endStep(db, step.id, { status: "succeeded", result_ref: input.resultRef ?? null, error: input.error ?? null });
}

test("第一次调模型，第二次直接返回已有小结（幂等，计数桩）", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "压小结" });
    const milestoneId = createMilestone(tmp.db, taskId, { seq: 1, title: "第一段", state: "active" });
    addFinishedStep(tmp.db, { taskId, milestoneId, tool: "write" });

    let calls = 0;
    const deps: StageSummaryDeps = {
      db: tmp.db,
      complete: async () => {
        calls += 1;
        return "把 3 张截图归档了";
      },
    };

    const first = await summarizeMilestone(deps, { taskId, milestoneId });
    assert.equal(first.calledModel, true);
    assert.equal(first.stepCount, 1);
    assert.equal(first.summary, "把 3 张截图归档了");
    assert.equal(calls, 1);

    const second = await summarizeMilestone(deps, { taskId, milestoneId });
    assert.equal(second.calledModel, false);
    assert.equal(second.summary, "把 3 张截图归档了");
    assert.equal(calls, 1, "第二次不该再调模型");

    assert.equal(getMilestone(tmp.db, milestoneId)?.summary, "把 3 张截图归档了");
  } finally {
    tmp.cleanup();
  }
});

test("只压本里程碑的步骤，别的里程碑不许混进来", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "分段" });
    const m1 = createMilestone(tmp.db, taskId, { seq: 1, title: "第一段", state: "active" });
    const m2 = createMilestone(tmp.db, taskId, { seq: 2, title: "第二段", state: "active" });
    addFinishedStep(tmp.db, { taskId, milestoneId: m1, tool: "toolAlpha" });
    addFinishedStep(tmp.db, { taskId, milestoneId: m2, tool: "toolBeta" });

    let prompt = "";
    const deps: StageSummaryDeps = {
      db: tmp.db,
      complete: async (p) => {
        prompt = p;
        return "第一段小结";
      },
    };

    const result = await summarizeMilestone(deps, { taskId, milestoneId: m1 });
    assert.equal(result.stepCount, 1);
    assert.match(prompt, /toolAlpha/);
    assert.doesNotMatch(prompt, /toolBeta/);
    assert.match(prompt, /第一段/);
  } finally {
    tmp.cleanup();
  }
});

test("小结超 300 字被截断并标记", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "长小结" });
    const milestoneId = createMilestone(tmp.db, taskId, { seq: 1, title: "长段" });
    addFinishedStep(tmp.db, { taskId, milestoneId, tool: "write" });

    const deps: StageSummaryDeps = {
      db: tmp.db,
      complete: async () => "长".repeat(STAGE_SUMMARY_LIMIT + 200),
    };

    const result = await summarizeMilestone(deps, { taskId, milestoneId });
    assert.equal(result.truncated, true);
    assert.ok(result.summary.length <= STAGE_SUMMARY_LIMIT + 10, `实际 ${result.summary.length}`);
    assert.match(result.summary, /已截/);

    const stored = getMilestone(tmp.db, milestoneId)?.summary ?? "";
    assert.equal(stored, result.summary);
  } finally {
    tmp.cleanup();
  }
});

test("原料里的明细只取前 200 字", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "明细前缀" });
    const milestoneId = createMilestone(tmp.db, taskId, { seq: 1, title: "有明细" });
    const content = "A".repeat(RESULT_PREVIEW_CHARS) + "ZZZTAIL";
    const hash = putArtifact(tmp.db, content).hash;
    addFinishedStep(tmp.db, { taskId, milestoneId, tool: "exec", resultRef: hash });

    let prompt = "";
    const deps: StageSummaryDeps = {
      db: tmp.db,
      complete: async (p) => {
        prompt = p;
        return "小结";
      },
    };
    await summarizeMilestone(deps, { taskId, milestoneId });
    assert.ok(prompt.includes("A".repeat(RESULT_PREVIEW_CHARS)));
    assert.doesNotMatch(prompt, /ZZZTAIL/);
  } finally {
    tmp.cleanup();
  }
});

test("这一段没有已结束步骤：不调模型，返回空小结", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "空段" });
    const milestoneId = createMilestone(tmp.db, taskId, { seq: 1, title: "空段" });

    let calls = 0;
    const deps: StageSummaryDeps = {
      db: tmp.db,
      complete: async () => {
        calls += 1;
        return "不该被调用";
      },
    };
    const result = await summarizeMilestone(deps, { taskId, milestoneId });
    assert.equal(result.calledModel, false);
    assert.equal(result.summary, "");
    assert.equal(calls, 0);
  } finally {
    tmp.cleanup();
  }
});
