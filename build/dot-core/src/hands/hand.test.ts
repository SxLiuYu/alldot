/**
 * src/hands/hand.test.ts —— A.4 七步顺序的验收（最小那只手）。
 *
 * 逐条钉住：
 *   1) 身份表：没有 toolCallId / 没记过 → identity_missing，且不记账、不动手；
 *   2) 任务：归不到 task_id → no_task；任务已终态 → task_terminal；
 *   3) 闸门：6 档拒、4 档出请示卡并停下；
 *   5) 写前记账：动手前 steps 行已 COMMIT（这里用「做之前快照」的等价做法：
 *      动作失败时步骤也已经是 failed 而不是不存在）；
 *   6) 落地：练习根内的文件真的写出来了；越界什么都没写；
 *   7) 结果：steps 行 succeeded + artifacts 里有完整结果。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideApproval,
  getApproval,
  getArtifact,
  getTask,
  listApprovals,
  listSnapshots,
  listSteps,
  migrate,
  verifyChain,
} from "../ledger/index.ts";
import { makeTempDb, createTask } from "../ledger/test-helpers.ts";
import { defaultConfig } from "../config.ts";
import { IdentityTable } from "./identity.ts";
import { runPracticeHand, type HandDeps } from "./hand.ts";
import { readTextFileForCheck } from "./practice.ts";
import { existsSync as exists, readdirSync, readFileSync } from "node:fs";

interface Fixture {
  deps: HandDeps;
  root: string;
  outside: string;
  cleanup: () => void;
}

function makeFixture(overrides: Partial<HandDeps> = {}): Fixture {
  const tmp = makeTempDb();
  migrate(tmp.db);
  const root = join(tmp.dir, "练习");
  const outside = join(tmp.dir, "外面");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });

  const config = defaultConfig();
  config.practice.root = root;

  const deps: HandDeps = { db: tmp.db, config, ...overrides };
  return {
    deps,
    root,
    outside,
    // makeTempDb 的 cleanup 会先关连接再删目录（Windows 上开着库文件删不掉）
    cleanup: () => tmp.cleanup(),
  };
}

test("归不到任务：拒绝且不记账", async () => {
  const f = makeFixture();
  try {
    const out = await runPracticeHand(f.deps, { action: "list" });
    assert.equal(out.ok, false);
    assert.equal(out.code, "no_task");
    assert.equal(out.stepId, null);
    assert.equal(listSteps(f.deps.db, "any").length, 0);
  } finally {
    f.cleanup();
  }
});

test("有身份表但没 toolCallId / 没记过：identity_missing，且不记账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "练习" });
    f.deps.identity = new IdentityTable();

    const noId = await runPracticeHand(f.deps, { action: "list", taskId });
    assert.equal(noId.code, "identity_missing");

    const unknownId = await runPracticeHand(f.deps, { action: "list", taskId, toolCallId: "call-没用过" });
    assert.equal(unknownId.code, "identity_missing");
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

test("成功路径：身份表给 sessionKey，task 从 task:<id> 解析；写前记账 + 落地 + 结果落账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "在练习夹写笔记" });
    const table = new IdentityTable();
    f.deps.identity = table;
    table.remember("call-1", { sessionKey: `task:${taskId}`, agentId: "agent-1", runId: "run-1" });

    // 有身份表时不给 toolCallId → 取不到身份，拒绝
    const made = await runPracticeHand(f.deps, { action: "mkdir", path: "笔记" });
    assert.equal(made.code, "identity_missing", "没给 toolCallId 不能取身份");

    // 真正的调用：带 toolCallId，身份表里有记录，任务从 sessionKey 的 task:<id> 解析
    const madeOk = await runPracticeHand(f.deps, { action: "mkdir", path: "笔记", toolCallId: "call-1" });
    assert.equal(madeOk.ok, true, madeOk.text);
    assert.equal(madeOk.taskId, taskId);
    assert.equal(madeOk.tier, 2);
    assert.ok(existsSync(join(f.root, "笔记")));

    table.remember("call-4", { sessionKey: `task:${taskId}` });
    const written = await runPracticeHand(f.deps, {
      action: "write",
      path: "笔记/第一天.md",
      content: "# 第一天\n练习文件夹",
      toolCallId: "call-4",
    });
    assert.equal(written.ok, true, written.text);
    assert.equal(readTextFileForCheck(f.root, "笔记/第一天.md"), "# 第一天\n练习文件夹");
    assert.ok(written.resultRef !== null);

    const artifact = getArtifact(f.deps.db, written.resultRef ?? "");
    assert.equal(artifact.found, true);
    assert.match(artifact.content ?? "", /"action":"write"/);

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 2, "一次 mkdir + 一次 write 各记一行；被拒的调用不记");
    assert.ok(steps.every((s) => s.tool === "practice"));
    assert.ok(steps.every((s) => s.side_effect === "replayable"));
    assert.ok(steps.every((s) => s.status === "succeeded"));
    assert.ok(steps.every((s) => s.tier === 2 && s.run_epoch === 0));

    // 身份一次性：同一个 toolCallId 再用一次就取不到
    const replay = await runPracticeHand(f.deps, { action: "list", toolCallId: "call-4" });
    assert.equal(replay.code, "identity_missing");

    // 账本哈希链仍然完好
    assert.equal(verifyChain(f.deps.db).ok, true);
  } finally {
    f.cleanup();
  }
});

test("list 走第 1 档（只读，side_effect=safe），正文能被渲染", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看看练习夹" });
    const out = await runPracticeHand(f.deps, { action: "list", taskId });
    assert.equal(out.ok, true, out.text);
    assert.equal(out.tier, 1);
    assert.equal(out.sideEffect, "safe");
    assert.match(out.text, /练习文件夹根/);

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.tier, 1);
    assert.equal(steps[0]?.side_effect, "safe");
  } finally {
    f.cleanup();
  }
});

test("越界路径：按第 4 档出请示卡并停下，外面一个字节都没写", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "越界试试" });
    const out = await runPracticeHand(f.deps, { action: "write", path: "../外面/坏.txt", content: "x", taskId });
    assert.equal(out.ok, false);
    assert.equal(out.code, "awaiting_approval");
    assert.ok(out.approvalId !== null);
    assert.equal(existsSync(join(f.outside, "坏.txt")), false);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);

    const approvals = listApprovals(f.deps.db);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.status, "pending");
    assert.equal(approvals[0]?.tier, 4);
  } finally {
    f.cleanup();
  }
});

test("6 档直接拒：不记账、不出请示卡、不动手", async () => {
  const f = makeFixture({
    judge: () => ({
      tier: 6,
      reason: "测试注入：删除类动作",
      rule: "dangerous",
      handling: "deny",
      sideEffect: "unknown",
      judgeNeeded: false,
    }),
  });
  try {
    const taskId = createTask(f.deps.db, { intent: "被拒的活" });
    const out = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "x", taskId });
    assert.equal(out.code, "denied");
    assert.equal(out.tier, 6);
    assert.equal(existsSync(join(f.root, "a.txt")), false);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.equal(listApprovals(f.deps.db).length, 0);
  } finally {
    f.cleanup();
  }
});

test("5 档交还人手：任务停下等人，不建审批单", async () => {
  const f = makeFixture({
    judge: () => ({
      tier: 5,
      reason: "测试注入：身份/钱",
      rule: "identity_money",
      handling: "human",
      sideEffect: "unknown",
      judgeNeeded: false,
    }),
  });
  try {
    const taskId = createTask(f.deps.db, { intent: "要本人做的活" });
    const out = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "x", taskId });
    assert.equal(out.code, "human_required");
    assert.equal(listApprovals(f.deps.db).length, 0);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

test("任务已终态：拒绝，不记账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "已经做完的活", state: "done" });
    const out = await runPracticeHand(f.deps, { action: "list", taskId });
    assert.equal(out.code, "task_terminal");
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

test("任务已暂停（会话超时）：手拒绝，不记账、不落地", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "超时停下的活", state: "paused" });
    const out = await runPracticeHand(f.deps, { action: "mkdir", path: "超时后不该建的", taskId });
    assert.equal(out.code, "task_paused");
    assert.equal(out.ok, false);
    assert.equal(existsSync(join(f.root, "超时后不该建的")), false, "paused 之后不许动练习夹");
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.equal(getTask(f.deps.db, taskId)?.state, "paused", "状态不许被手翻回去");
  } finally {
    f.cleanup();
  }
});

test("练习根没配：拒绝，且不动手", async () => {
  const f = makeFixture();
  try {
    f.deps.config.practice.root = null;
    const taskId = createTask(f.deps.db, { intent: "没配练习夹" });
    const out = await runPracticeHand(f.deps, { action: "list", taskId });
    assert.equal(out.code, "practice_root_missing");
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

test("动作失败也落账：steps 行是 failed 且带 error，不是留一个 started", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "写一个已存在的文件" });
    const first = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "第一版", taskId });
    assert.equal(first.ok, true, first.text);

    const second = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "第二版", taskId });
    assert.equal(second.ok, false);
    assert.equal(second.code, "failed");
    assert.match(second.text, /已存在/);
    assert.equal(readTextFileForCheck(f.root, "a.txt"), "第一版");

    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 2);
    assert.equal(steps[1]?.status, "failed");
    assert.match(steps[1]?.error ?? "", /exists/);
    assert.ok(steps[1]?.result_ref !== null);
  } finally {
    f.cleanup();
  }
});

test("坏 action：拒绝，不记账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "乱传动作" });
    const out = await runPracticeHand(f.deps, { action: "delete", taskId });
    assert.equal(out.code, "bad_action");
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

// ── 归因：只认会话（A.4 第 2 步、A.7「归不到就拒绝」）─────────────────────

test("归因只认会话：会话是 task:A、参数写 task_id=B → task_mismatch，不记账", async () => {
  const f = makeFixture();
  try {
    const taskA = createTask(f.deps.db, { intent: "A 的活" });
    const taskB = createTask(f.deps.db, { intent: "B 的活" });
    const table = new IdentityTable();
    table.remember("call-x", { sessionKey: `task:${taskA}` });
    f.deps.identity = table;

    const out = await runPracticeHand(f.deps, { action: "list", taskId: taskB, toolCallId: "call-x" });
    assert.equal(out.code, "task_mismatch");
    assert.equal(listSteps(f.deps.db, taskA).length, 0);
    assert.equal(listSteps(f.deps.db, taskB).length, 0);
  } finally {
    f.cleanup();
  }
});

test("非工人会话 + 参数 task_id：no_task，不许用参数绕过会话", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "正经任务" });
    const table = new IdentityTable();
    table.remember("call-main", { sessionKey: "main" });
    f.deps.identity = table;

    const out = await runPracticeHand(f.deps, { action: "list", taskId, toolCallId: "call-main" });
    assert.equal(out.code, "no_task");
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

// ── 审批状态机：pending 等 / approved 执行 / executed 一次性消耗 ───────────

function askJudge(): HandDeps["judge"] {
  return () => ({
    tier: 4,
    reason: "测试注入：每次问",
    rule: "test_ask",
    handling: "ask",
    sideEffect: "unknown",
    judgeNeeded: true,
  });
}

test("第 4 档：建单 + 通知 + 任务转等待输入；再调一次仍等，不重复通知、不记账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "要批准的写" });
    const sent: string[] = [];
    f.deps.judge = askJudge();
    f.deps.notify = async (id) => {
      sent.push(id);
      return { ok: true, detail: "测试通道" };
    };

    const first = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "x", taskId });
    assert.equal(first.code, "awaiting_approval");
    assert.ok(first.approvalId !== null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], first.approvalId);

    const task = getTask(f.deps.db, taskId);
    assert.equal(task?.state, "awaiting_approval");
    assert.match(task?.blocked_on_json ?? "", /approval_ids/);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.equal(exists(f.root + "/a.txt"), false);

    const second = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "x", taskId });
    assert.equal(second.code, "awaiting_approval");
    assert.equal(second.approvalId, first.approvalId);
    assert.equal(sent.length, 1, "已有单不再重复通知");
    assert.equal(listApprovals(f.deps.db).length, 1);
  } finally {
    f.cleanup();
  }
});

test("批准后重发同一动作：抢占 executing → 执行 → executed，任务回到 running；再要一次得新单", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "批准后要真干" });
    f.deps.judge = askJudge();
    f.deps.notify = async () => ({ ok: true, detail: "测试通道" });

    const first = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "第一版", taskId });
    const approvalId = first.approvalId ?? "";
    assert.ok(approvalId !== "");
    assert.equal(decideApproval(f.deps.db, approvalId, { decision: "approved", decidedBy: "cli" }), true);

    const second = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "第一版", taskId });
    assert.equal(second.ok, true, second.text);
    assert.equal(second.approvalId, approvalId);
    assert.equal(readTextFileForCheck(f.root, "a.txt"), "第一版");
    assert.equal(getApproval(f.deps.db, approvalId)?.status, "executed");
    assert.equal(getTask(f.deps.db, taskId)?.state, "running");
    assert.equal(listSteps(f.deps.db, taskId).length, 1);

    // executed 一次性消耗：同一动作再做一次要新批单
    const third = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "第一版", taskId });
    assert.equal(third.code, "awaiting_approval");
    assert.notEqual(third.approvalId, approvalId);
    assert.equal(listSteps(f.deps.db, taskId).length, 1, "第三次没批准就不执行");
  } finally {
    f.cleanup();
  }
});

test("批准了也过不了路径围栏：越界写在执行时失败，审批单记 failed", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "想越界" });
    const first = await runPracticeHand(f.deps, { action: "write", path: "../外面/x.txt", content: "x", taskId });
    assert.equal(first.code, "awaiting_approval");
    const approvalId = first.approvalId ?? "";
    decideApproval(f.deps.db, approvalId, { decision: "approved", decidedBy: "cli" });

    const second = await runPracticeHand(f.deps, { action: "write", path: "../外面/x.txt", content: "x", taskId });
    assert.equal(second.code, "failed");
    assert.match(second.text, /工作区/);
    assert.equal(exists(f.outside + "/x.txt"), false);
    assert.equal(getApproval(f.deps.db, approvalId)?.status, "failed");
  } finally {
    f.cleanup();
  }
});

// ── 第 2 档：先快照再放行（B.9）──────────────────────────────────────────

test("第 2 档先快照：覆盖前把旧内容复制到 snapshots 根，并落 snapshots 行", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "覆盖前先留底" });
    const snapshotsRoot = join(f.root, "..", "快照");
    f.deps.snapshotsRoot = snapshotsRoot;
    f.deps.judge = () => ({
      tier: 2,
      reason: "测试注入：工作区内写",
      rule: "workspace_write",
      handling: "snapshot",
      sideEffect: "replayable",
      judgeNeeded: false,
    });

    const made = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "旧内容", taskId });
    assert.equal(made.ok, true, made.text);
    assert.ok(made.snapshotRef !== null, "第 2 档必须拍快照");

    const out = await runPracticeHand(f.deps, { action: "write", path: "a.txt", content: "新内容", overwrite: true, taskId });
    assert.equal(out.ok, true, out.text);
    assert.ok(out.snapshotRef !== null);
    assert.equal(readTextFileForCheck(f.root, "a.txt"), "新内容");

    const rows = listSnapshots(f.deps.db, taskId);
    assert.equal(rows.length, 2);
    const latest = rows[0];
    assert.ok(latest !== undefined);
    assert.equal(latest.kind, "copy");
    assert.equal(exists(latest.ref), true);
    assert.equal(readFileSync(latest.ref, "utf8"), "旧内容");

    assert.ok(readdirSync(snapshotsRoot).includes(taskId));
  } finally {
    f.cleanup();
  }
});
