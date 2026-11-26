/**
 * src/context/recall.test.ts —— 按编号取回（A.10 第三类）的验收。
 *
 * 钉住：step_id / artifact / ref 三条路各能取到；取不到返回可读说明而不是抛；
 * 超长截到 RECALL_TEXT_LIMIT 并带原始字数；ref 不当文件路径读；
 * dot_recall 在闸门上落 1 档。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  beginStep,
  createSnapshot,
  endStep,
  migrate,
  putArtifact,
  type LedgerDb,
} from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { judgeTier } from "../gate/judge.ts";
import { RECALL_TEXT_LIMIT, recall } from "./recall.ts";
import { RECALL_TOOL_NAME, RECALL_TIER, createRecallPluginTool, recallGateInput } from "./recall-tool.ts";
import { IdentityTable } from "../hands/identity.ts";

function addFinishedStep(
  db: LedgerDb,
  input: { taskId: string; tool: string; resultRef?: string | null; status?: "succeeded" | "failed" },
): string {
  const step = beginStep(db, {
    task_id: input.taskId,
    run_epoch: 0,
    kind: "tool",
    tool: input.tool,
    subject_key: `sk-${input.tool}`,
    side_effect: "safe",
    tier: 1,
  });
  endStep(db, step.id, {
    status: input.status ?? "succeeded",
    result_ref: input.resultRef ?? null,
  });
  return step.id;
}

test("step_id：取那一步的 result_ref 明细", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "取明细" });
    const hash = putArtifact(tmp.db, "命令全量输出：3 个文件已归档").hash;
    const stepId = addFinishedStep(tmp.db, { taskId, tool: "write", resultRef: hash });

    const got = recall(tmp.db, { taskId, step_id: stepId });
    assert.equal(got.ok, true);
    assert.equal(got.kind, "artifact");
    assert.equal(got.source, "step");
    assert.equal(got.ref, hash);
    assert.match(got.text, /3 个文件已归档/);
  } finally {
    tmp.cleanup();
  }
});

test("artifact：按哈希直接取全文（哈希被本任务的步骤引用过）", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "按哈希取" });
    const hash = putArtifact(tmp.db, "明细正文-B").hash;
    addFinishedStep(tmp.db, { taskId, tool: "read", resultRef: hash });

    const got = recall(tmp.db, { taskId, artifact: hash });
    assert.equal(got.ok, true);
    assert.equal(got.kind, "artifact");
    assert.equal(got.source, "artifact");
    assert.match(got.text, /明细正文-B/);
  } finally {
    tmp.cleanup();
  }
});

test("artifact：别的任务写的明细取不出来（防跨任务串读）", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const mine = createTask(tmp.db, { intent: "我自己的任务" });
    const other = createTask(tmp.db, { intent: "别人的任务" });
    const hash = putArtifact(tmp.db, "别人任务的明细").hash;
    addFinishedStep(tmp.db, { taskId: other, tool: "read", resultRef: hash });

    const leaked = recall(tmp.db, { taskId: mine, artifact: hash });
    assert.equal(leaked.ok, false);
    assert.match(leaked.text, /不属于任务/);

    // 直接 put 了但没有任何步骤/快照引用：同样按「不是这个任务的」处理。
    const orphan = putArtifact(tmp.db, "谁都没引用").hash;
    const orphaned = recall(tmp.db, { taskId: mine, artifact: orphan });
    assert.equal(orphaned.ok, false);
    assert.match(orphaned.text, /不属于任务/);
  } finally {
    tmp.cleanup();
  }
});

test("ref：既认快照 id，也认明细哈希", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "按编号取" });
    const hash = putArtifact(tmp.db, "明细正文-C").hash;
    addFinishedStep(tmp.db, { taskId, tool: "write", resultRef: hash });
    const snap = createSnapshot(tmp.db, {
      task_id: taskId,
      kind: "copy",
      ref: "C:/backup/old.zip",
      restore: { path: "C:/work/old.zip" },
    });

    const byHash = recall(tmp.db, { taskId, ref: hash });
    assert.equal(byHash.ok, true);
    assert.equal(byHash.kind, "artifact");
    assert.equal(byHash.source, "ref");
    assert.match(byHash.text, /明细正文-C/);

    const bySnap = recall(tmp.db, { taskId, ref: snap.id });
    assert.equal(bySnap.ok, true);
    assert.equal(bySnap.kind, "snapshot");
    assert.match(bySnap.text, /kind=copy/);
    assert.match(bySnap.text, /C:\/backup\/old\.zip/);
    assert.match(bySnap.text, /C:\/work\/old\.zip/);
  } finally {
    tmp.cleanup();
  }
});

test("取不到返回可读错误，不抛", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "取不到" });

    assert.doesNotThrow(() => {
      const missing = recall(tmp.db, { taskId, ref: "不存在的哈希" });
      assert.equal(missing.ok, false);
      assert.equal(missing.kind, "none");
      assert.match(missing.text, /已被回收/);
    });

    const noArgs = recall(tmp.db, { taskId });
    assert.equal(noArgs.ok, false);
    assert.match(noArgs.text, /至少给 step_id/);

    const noStep = recall(tmp.db, { taskId, step_id: "step_没有" });
    assert.equal(noStep.ok, false);
    assert.match(noStep.text, /没有这一步/);

    // 步骤结束但没 result_ref：给可读说明。
    const stepId = addFinishedStep(tmp.db, { taskId, tool: "read" });
    const noResult = recall(tmp.db, { taskId, step_id: stepId });
    assert.equal(noResult.ok, false);
    assert.match(noResult.text, /没有结果明细/);
  } finally {
    tmp.cleanup();
  }
});

test("ref 长得像文件路径：拒，不当文件读", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "别读盘" });
    const got = recall(tmp.db, { taskId, ref: "C:/Users/1/Desktop/日志.log" });
    assert.equal(got.ok, false);
    assert.match(got.text, /不读文件/);
  } finally {
    tmp.cleanup();
  }
});

test("超长截到上限，并注明原始字数", () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskId = createTask(tmp.db, { intent: "长明细" });
    const longText = "字".repeat(RECALL_TEXT_LIMIT + 1000);
    const hash = putArtifact(tmp.db, longText).hash;
    addFinishedStep(tmp.db, { taskId, tool: "read", resultRef: hash });

    const got = recall(tmp.db, { taskId, artifact: hash });
    assert.equal(got.ok, true);
    assert.equal(got.truncated, true);
    assert.equal(got.originalChars, RECALL_TEXT_LIMIT + 1000);
    assert.match(got.text, /已截短/);
    assert.ok(got.text.includes(`共 ${RECALL_TEXT_LIMIT + 1000} 字符`));
    assert.ok(got.text.length < longText.length);
  } finally {
    tmp.cleanup();
  }
});

test("闸门：dot_recall / read 落 1 档放行", () => {
  assert.equal(RECALL_TOOL_NAME, "dot_recall");
  assert.equal(RECALL_TIER, 1);
  const verdict = judgeTier(recallGateInput({ ref: "snap_x" }));
  assert.equal(verdict.tier, 1);
  assert.equal(verdict.handling, "allow");
  assert.equal(verdict.sideEffect, "safe");
  assert.equal(verdict.judgeNeeded, false);
});

// —— 归属：身份表优先，参数不能越权（2026-11-25 探针实测过「A 身份 + B 的 task_id」能读到 B 的明细）——

function textOf(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => c.text ?? "").join("\n");
}

test("身份表命中：参数里写别的 task_id 直接拒，正文一个字都不带出来", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskA = createTask(tmp.db, { intent: "A 的活" });
    const taskB = createTask(tmp.db, { intent: "B 的活" });
    const secret = putArtifact(tmp.db, "B 任务的私密明细：密码 hunter2").hash;
    addFinishedStep(tmp.db, { taskId: taskB, tool: "write", resultRef: secret });

    const table = new IdentityTable();
    table.remember("call-1", { taskId: taskA } as never);
    const tool = createRecallPluginTool(tmp.db, table);

    const res = await tool.execute("call-1", { task_id: taskB, artifact: secret });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /只认当前会话的任务/);
    assert.doesNotMatch(textOf(res), /hunter2/);
    assert.equal(res.details?.code, "identity_conflict");
  } finally {
    tmp.cleanup();
  }
});

test("身份表命中：不给 task_id 也按身份取本任务的明细", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskA = createTask(tmp.db, { intent: "A 的活" });
    const hash = putArtifact(tmp.db, "A 自己的明细").hash;
    const stepId = addFinishedStep(tmp.db, { taskId: taskA, tool: "write", resultRef: hash });

    const table = new IdentityTable();
    table.remember("call-2", { taskId: taskA } as never);
    const tool = createRecallPluginTool(tmp.db, table);

    const res = await tool.execute("call-2", { step_id: stepId });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /A 自己的明细/);
  } finally {
    tmp.cleanup();
  }
});

test("没有身份（脚本直调）：仍认参数里的 task_id", async () => {
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const taskA = createTask(tmp.db, { intent: "直调" });
    const hash = putArtifact(tmp.db, "直调取的明细").hash;
    addFinishedStep(tmp.db, { taskId: taskA, tool: "read", resultRef: hash });

    const tool = createRecallPluginTool(tmp.db, new IdentityTable());
    const res = await tool.execute("call-3", { task_id: taskA, artifact: hash });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /直调取的明细/);
  } finally {
    tmp.cleanup();
  }
});
