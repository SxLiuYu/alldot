/**
 * src/hands/builtin.test.ts —— 内置工具钩子治理的验收（A.4 另一半 + A.5）。
 *
 * 钉住六条：
 * 1. 非工人会话（sessionKey 不是 task:*）原样放行，不记账——不越权管主会话；
 * 2. 工人会话里每个工具都过闸门：practice 交回手自己走七步；WORKER_DENIED_TOOLS
 *    （message / process / subagents …）直接拒、不给审批卡；名单外的未知工具按 4 档出单；
 * 3. 6 档直接拦，不记账；
 * 4. 放行的动作写前记账、after 记结果（含 artifacts）；
 * 5. 4 档出请示卡：任务转等待、通知桥、拦下本轮；批准后再调同一动作 → 执行 → executing→executed；
 * 6. paused 的任务一律拒（会话超时之后旧会话不许再动手）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { decideApproval, getApproval, getTask, listApprovals, listSteps, migrate } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { defaultConfig } from "../config.ts";
import { createBuiltinGovernor, type BuiltinHookDeps } from "./builtin.ts";

interface Fixture {
  deps: BuiltinHookDeps;
  cleanup: () => void;
}

function makeFixture(overrides: Partial<BuiltinHookDeps> = {}): Fixture {
  const tmp = makeTempDb();
  migrate(tmp.db);
  mkdirSync(join(tmp.dir, "练习"), { recursive: true });
  const config = defaultConfig();
  config.practice.root = join(tmp.dir, "练习");
  const deps: BuiltinHookDeps = { db: tmp.db, config, ...overrides };
  return { deps, cleanup: () => tmp.cleanup() };
}

const workerCtx = (taskId: string) => ({ sessionKey: `task:${taskId}`, agentId: "agent-1", runId: "run-1" });

test("非工人会话：原样放行、不记账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "工人的活" });
    const gov = createBuiltinGovernor(f.deps);
    const decision = await gov.beforeToolCall(
      { toolName: "read", params: { path: "C:/a.txt" }, toolCallId: "c1" },
      { toolName: "read", sessionKey: "main", toolCallId: "c1" },
    );
    assert.equal(decision, undefined);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
  } finally {
    f.cleanup();
  }
});

test("工人会话：files 交给手自己（不重复拦），dot_recall 落 1 档放行并记账", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "归档截图" });
    const gov = createBuiltinGovernor(f.deps);

    // files 有自己的七步壳（runFilesHand → runHandShell）：钩子必须跳过它。
    // 漏在 DOT_HAND_TOOL_NAMES 之外时，这里会变成 4 档出请示卡（2026-11-25 评审实测）。
    const files = await gov.beforeToolCall(
      { toolName: "files", params: { action: "write", path: "a.txt", content: "x" }, toolCallId: "c-files" },
      { toolName: "files", ...workerCtx(taskId), toolCallId: "c-files" },
    );
    assert.equal(files, undefined, "files 要交给手自己的七步壳");

    // dot_recall 是只读：宿主侧必须落 1 档放行（不是 4 档出卡），并且按 1 档记账。
    const recallDecision = await gov.beforeToolCall(
      { toolName: "dot_recall", params: { ref: "step_abc" }, toolCallId: "c-recall" },
      { toolName: "dot_recall", ...workerCtx(taskId), toolCallId: "c-recall" },
    );
    assert.equal(recallDecision, undefined, "dot_recall 不该被拦");
    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1, "1 档也要记账");
    assert.equal(steps[0]?.tool, "dot_recall");
    assert.equal(steps[0]?.tier, 1);
    assert.equal(listApprovals(f.deps.db).length, 0, "不该出请示卡");
  } finally {
    f.cleanup();
  }
});

test("工人会话：practice 交给手自己；message/process 直接拒；未知工具按 4 档出单", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "随便" });
    const gov = createBuiltinGovernor(f.deps);

    // 我们自己的手在自己的 execute 里走七步，钩子不重复处理。
    const practice = await gov.beforeToolCall(
      { toolName: "practice", params: { action: "list" }, toolCallId: "c-practice" },
      { toolName: "practice", ...workerCtx(taskId), toolCallId: "c-practice" },
    );
    assert.equal(practice, undefined);

    // 工人会话里直接拒：不给审批卡（批了也拿不到那个执行面）。
    for (const tool of ["message", "process", "subagents", "sessions_spawn"]) {
      const d = await gov.beforeToolCall(
        { toolName: tool, params: {}, toolCallId: `c-${tool}` },
        { toolName: tool, ...workerCtx(taskId), toolCallId: `c-${tool}` },
      );
      assert.equal(d?.block, true, tool);
      assert.match(d?.blockReason ?? "", /不许用/, tool);
    }

    // 名单外的未知工具：judgeTier 给 4 档，照样出单拦住——不再「名单外一律放行」。
    const unknown = await gov.beforeToolCall(
      { toolName: "mcp__demo__ping", params: {}, toolCallId: "c-list" },
      { toolName: "mcp__demo__ping", ...workerCtx(taskId), toolCallId: "c-list" },
    );
    assert.equal(unknown?.block, true);
    assert.match(unknown?.blockReason ?? "", /等批准 #/);
    assert.equal(listApprovals(f.deps.db).length, 1, "未知工具要出审批单，不是静默放行");
    assert.equal(listSteps(f.deps.db, taskId).length, 0, "被拦的动作不记账");
  } finally {
    f.cleanup();
  }
});

test("paused 的任务：工人会话一律拒（超时之后旧会话不许再动手）", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "已经超时的任务" });
    f.deps.db
      .prepare("UPDATE tasks SET state = 'paused', state_reason = '工人会话超时' WHERE id = ?")
      .run(taskId);
    const gov = createBuiltinGovernor(f.deps);

    for (const tool of ["read", "exec"]) {
      const d = await gov.beforeToolCall(
        { toolName: tool, params: { command: "git status" }, toolCallId: `c-${tool}` },
        { toolName: tool, ...workerCtx(taskId), toolCallId: `c-${tool}` },
      );
      assert.equal(d?.block, true, tool);
      assert.match(d?.blockReason ?? "", /暂停/, tool);
    }
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.equal(listApprovals(f.deps.db).length, 0);
    assert.equal(getTask(f.deps.db, taskId)?.state, "paused", "不许被一条动作翻回运行态");
  } finally {
    f.cleanup();
  }
});

test("6 档直接拦：block + 原因，不记账、不出单", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "想删东西" });
    const gov = createBuiltinGovernor(f.deps);
    const d = await gov.beforeToolCall(
      { toolName: "exec", params: { command: "del C:/a.txt" }, toolCallId: "c-del" },
      { toolName: "exec", ...workerCtx(taskId), toolCallId: "c-del" },
    );
    assert.equal(d?.block, true);
    assert.match(d?.blockReason ?? "", /拒绝/);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.equal(listApprovals(f.deps.db).length, 0);
  } finally {
    f.cleanup();
  }
});

test("放行的动作：写前记账 → after 记结果（含 result artifact）", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "读一个文件" });
    const gov = createBuiltinGovernor(f.deps);

    const before = await gov.beforeToolCall(
      { toolName: "read", params: { path: "C:/a.txt" }, toolCallId: "c-read" },
      { toolName: "read", ...workerCtx(taskId), toolCallId: "c-read" },
    );
    assert.equal(before, undefined);

    const opened = listSteps(f.deps.db, taskId);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.status, "started");
    assert.equal(opened[0]?.tool, "read");
    assert.equal(opened[0]?.tier, 1);
    assert.equal(opened[0]?.side_effect, "safe");
    assert.equal(gov.pendingCount, 1);

    await gov.afterToolCall(
      { toolName: "read", params: { path: "C:/a.txt" }, toolCallId: "c-read", result: { content: "hello" } },
      { toolName: "read", ...workerCtx(taskId), toolCallId: "c-read" },
    );

    const done = listSteps(f.deps.db, taskId);
    assert.equal(done[0]?.status, "succeeded");
    assert.ok(done[0]?.result_ref !== null);
    assert.equal(gov.pendingCount, 0);
  } finally {
    f.cleanup();
  }
});

test("失败的结果记 failed 并带 error", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "读会失败" });
    const gov = createBuiltinGovernor(f.deps);
    await gov.beforeToolCall(
      { toolName: "read", params: { path: "C:/nope" }, toolCallId: "c2" },
      { toolName: "read", ...workerCtx(taskId), toolCallId: "c2" },
    );
    await gov.afterToolCall(
      { toolName: "read", params: {}, toolCallId: "c2", error: "ENOENT" },
      { toolName: "read", ...workerCtx(taskId), toolCallId: "c2" },
    );
    const [step] = listSteps(f.deps.db, taskId);
    assert.equal(step?.status, "failed");
    assert.match(step?.error ?? "", /ENOENT/);
  } finally {
    f.cleanup();
  }
});

test("4 档（exec 不在白名单）：出单 + 任务转等待 + 通知 + 拦下；批准后同一动作放行并消耗审批", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "跑一条命令" });
    const sent: string[] = [];
    const gov = createBuiltinGovernor({
      ...f.deps,
      notify: async (id) => {
        sent.push(id);
        return { ok: true, detail: "测试通道" };
      },
    });

    const first = await gov.beforeToolCall(
      { toolName: "exec", params: { command: "dir" }, toolCallId: "c-exec" },
      { toolName: "exec", ...workerCtx(taskId), toolCallId: "c-exec" },
    );
    assert.equal(first?.block, true);
    assert.match(first?.blockReason ?? "", /等批准 #/);
    assert.equal(sent.length, 1);
    assert.equal(listSteps(f.deps.db, taskId).length, 0);
    assert.equal(getTask(f.deps.db, taskId)?.state, "awaiting_approval");

    const [approval] = listApprovals(f.deps.db);
    assert.ok(approval !== undefined);
    assert.equal(approval.status, "pending");
    assert.equal(decideApproval(f.deps.db, approval.id, { decision: "approved", decidedBy: "cli" }), true);

    const second = await gov.beforeToolCall(
      { toolName: "exec", params: { command: "dir" }, toolCallId: "c-exec-2" },
      { toolName: "exec", ...workerCtx(taskId), toolCallId: "c-exec-2" },
    );
    assert.equal(second, undefined, "批准后同一动作应放行");

    const [step] = listSteps(f.deps.db, taskId);
    assert.equal(step?.status, "started");
    assert.equal(getApproval(f.deps.db, approval.id)?.status, "executing");
    assert.equal(getTask(f.deps.db, taskId)?.state, "running");

    await gov.afterToolCall(
      { toolName: "exec", params: { command: "dir" }, toolCallId: "c-exec-2", result: { stdout: "..." } },
      { toolName: "exec", ...workerCtx(taskId), toolCallId: "c-exec-2" },
    );
    assert.equal(getApproval(f.deps.db, approval.id)?.status, "executed");
    assert.equal(listSteps(f.deps.db, taskId)[0]?.status, "succeeded");
  } finally {
    f.cleanup();
  }
});
