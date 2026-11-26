/**
 * src/context/inject.test.ts —— 三类上下文合流的验收。
 *
 * 钉住：锚点原样放最前面且永不砍；只放已结束里程碑的小结；最多 3 条；
 * 总字数超 1800 先砍小结（从最老的砍）；parts 能区分锚点/小结/预算。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { migrate, updateMilestone } from "../ledger/index.ts";
import { createMilestone, createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { buildAnchor } from "./anchor.ts";
import { INJECTION_TEXT_LIMIT, SUMMARY_MAX_COUNT, buildInjection } from "./inject.ts";

function seedMilestone(
  db: ReturnType<typeof makeTempDb>["db"],
  taskId: string,
  input: { seq: number; title: string; state: string; summary: string | null },
): string {
  const id = createMilestone(db, taskId, { seq: input.seq, title: input.title, state: input.state });
  if (input.summary !== null) updateMilestone(db, id, { summary: input.summary });
  return id;
}

test("超 1800 字先砍小结（从最老的砍），锚点不砍", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "归档截图" });
    for (let seq = 1; seq <= 3; seq += 1) {
      seedMilestone(tmp.db, taskId, {
        seq,
        title: `第 ${seq} 段`,
        state: "done",
        summary: "细".repeat(700),
      });
    }

    const anchor = buildAnchor({ db: tmp.db, taskId }) ?? "";
    const result = buildInjection(tmp.db, { taskId });

    // 锚点一字不改，且在最前面。
    assert.equal(result.parts.anchor, anchor);
    assert.equal(result.parts.budget.anchorChars, anchor.length);
    assert.ok(result.text.startsWith(anchor));
    assert.match(result.text, /【dot 锚点】/);

    // 砍的是小结：条数变少、有 dropped、总字数压到上限内。
    assert.ok(result.parts.budget.droppedSummaries > 0, "应至少砍掉一条小结");
    assert.ok(result.parts.summaries.length < 3, `小结条数 ${result.parts.summaries.length}`);
    assert.equal(result.parts.budget.truncated, true);
    assert.ok(result.parts.budget.totalChars <= INJECTION_TEXT_LIMIT);
    // 砍的是最老的那条（seq 1）。
    assert.ok(result.parts.dropped.some((line) => line.includes("#1")));
  } finally {
    tmp.cleanup();
  }
});

test("没结束的里程碑不进小结", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "只看结束的" });
    seedMilestone(tmp.db, taskId, { seq: 1, title: "已完成", state: "done", summary: "已完成的段内容" });
    seedMilestone(tmp.db, taskId, { seq: 2, title: "进行中", state: "active", summary: "进行中的段内容" });

    const result = buildInjection(tmp.db, { taskId });
    assert.equal(result.parts.summaries.length, 1);
    assert.match(result.parts.summaries[0] as string, /已完成的段内容/);
    assert.doesNotMatch(result.text, /进行中的段内容/);
    assert.equal(result.parts.budget.droppedSummaries, 0);
  } finally {
    tmp.cleanup();
  }
});

test("parts 能区分锚点、小结与预算", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "分块" });
    seedMilestone(tmp.db, taskId, { seq: 1, title: "第一段", state: "done", summary: "做完了 A" });

    const result = buildInjection(tmp.db, { taskId });
    assert.match(result.parts.anchor, /【dot 锚点】/);
    assert.equal(result.parts.summaries.length, 1);
    assert.match(result.parts.summaries[0] as string, /^阶段小结 #1「第一段」：做完了 A/);
    assert.equal(result.parts.budget.summaryCount, result.parts.summaries.length);
    assert.equal(result.parts.budget.summaryChars, result.parts.summaries.join("\n").length);
    assert.equal(result.parts.budget.limit, INJECTION_TEXT_LIMIT);
    assert.equal(result.parts.budget.truncated, false);
  } finally {
    tmp.cleanup();
  }
});

test("小结最多 3 条：留最新的，更老的算砍掉", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "五段" });
    for (let seq = 1; seq <= 5; seq += 1) {
      seedMilestone(tmp.db, taskId, { seq, title: `第 ${seq} 段`, state: "done", summary: `小结${seq}` });
    }

    const result = buildInjection(tmp.db, { taskId });
    assert.equal(result.parts.summaries.length, SUMMARY_MAX_COUNT);
    assert.equal(result.parts.budget.droppedSummaries, 2);
    assert.match(result.parts.summaries[0] as string, /#3/);
    assert.match(result.parts.summaries[2] as string, /#5/);
  } finally {
    tmp.cleanup();
  }
});

test("includeStageSummaries=false：只放锚点", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "只要骨架" });
    seedMilestone(tmp.db, taskId, { seq: 1, title: "第一段", state: "done", summary: "不该出现" });

    const anchor = buildAnchor({ db: tmp.db, taskId }) ?? "";
    const result = buildInjection(tmp.db, { taskId, includeStageSummaries: false });
    assert.equal(result.text, anchor);
    assert.equal(result.parts.summaries.length, 0);
    assert.doesNotMatch(result.text, /不该出现/);
  } finally {
    tmp.cleanup();
  }
});
