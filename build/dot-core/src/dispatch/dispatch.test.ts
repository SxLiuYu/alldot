/**
 * src/dispatch/dispatch.test.ts —— 派发器的验收。
 *
 * 钉住这些容易漂的事：
 * 1. 认领的原子性：同一任务两个连接抢，只有一个拿到；锁被占就不领；
 * 2. 认领同时写 workers 行、抢 task 锁、run_epoch 对齐任务当前值；
 * 3. 派发参数：sessionKey=task:<id>、idempotencyKey=task:<id>:<run_epoch>、系统提示写清「只能用 practice 手」；
 * 4. 会话抛错/报错 → failed，不留 running；超时 → paused + blocked_on；全成功才 done；
 * 5. 先来先做（created_at 升序）；
 * 6. 开关：dispatch.enabled=false 一个都不领、一次都不调 runtime；
 * 7. 闸门：工人会话里的动作真被拦下（建审批、任务转 awaiting_approval），派发器不自己批、也不把任务标 done；
 * 8. 超时之后有人接管（有界重排一次）、审批有结论后任务回队列、拒绝终止；
 * 9. 完整性校验每轮都跑（不缓存）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerDotCore } from "../../index.ts";
import {
  beginStep,
  claimTask,
  decideApproval,
  endStep,
  getLock,
  getTask,
  listApprovals,
  listWorkers,
  migrate,
  openLedger,
  requeueAttempts,
  requeueTask,
  setTaskState,
  acquireLock,
  type LedgerDb,
} from "../ledger/index.ts";
import { createApproval as createApprovalRow, createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { defaultConfig, type DotCoreConfig } from "../config.ts";
import { Dispatcher } from "./scheduler.ts";
import { settleTask, type SettleOutcome } from "./settle.ts";
import { resumeAfterDecision } from "./resume.ts";
import { taskIdFromSessionKey } from "../hands/identity.ts";
import { createBuiltinGovernor } from "../hands/builtin.ts";
import type { PluginRuntimeLike, SubagentRunParamsLike } from "../plugin-api.ts";

interface FakeRuntime {
  runtime: PluginRuntimeLike;
  calls: SubagentRunParamsLike[];
  waits: Array<{ runId: string; timeoutMs?: number }>;
}

function fakeRuntime(opts: {
  onRun?: (params: SubagentRunParamsLike) => Promise<{ runId: string }>;
  wait?: () => Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
} = {}): FakeRuntime {
  const calls: SubagentRunParamsLike[] = [];
  const waits: Array<{ runId: string; timeoutMs?: number }> = [];
  return {
    calls,
    waits,
    runtime: {
      subagent: {
        async run(params) {
          calls.push(params);
          if (opts.onRun !== undefined) return opts.onRun(params);
          return { runId: `run_${calls.length}` };
        },
        async waitForRun(params) {
          waits.push(params);
          if (opts.wait !== undefined) return opts.wait();
          return { status: "ok" };
        },
      },
    },
  };
}

function testConfig(patch: Partial<DotCoreConfig["dispatch"]> = {}): DotCoreConfig {
  const config = defaultConfig();
  config.dispatch = { ...config.dispatch, ...patch };
  return config;
}

function makeDispatcher(
  db: LedgerDb,
  config: DotCoreConfig,
  fake: FakeRuntime | undefined,
  extra: {
    verify?: () => { ok: boolean; detail: string };
    afterSettle?: (input: { taskId: string; outcome: SettleOutcome }) => Promise<unknown>;
  } = {},
): Dispatcher {
  return new Dispatcher({
    db,
    config,
    runtime: fake?.runtime,
    sleep: async () => {},
    waitSliceMs: 10,
    verify: extra.verify ?? (() => ({ ok: true, detail: "测试里跳过完整性校验" })),
    ...(extra.afterSettle === undefined ? {} : { afterSettle: extra.afterSettle }),
  });
}

function succeededStep(db: LedgerDb, taskId: string, epoch: number, seq?: number): void {
  const step = beginStep(db, {
    task_id: taskId,
    run_epoch: epoch,
    kind: "tool",
    tool: "practice",
    subject_key: `k_${taskId}_${seq ?? "x"}`,
    side_effect: "replayable",
    tier: 2,
    session_key: `task:${taskId}`,
  });
  endStep(db, step.id, { status: "succeeded" });
}

// ── 1. 认领的原子性 ────────────────────────────────────────────────────────

test("认领：同一任务两个连接抢，只有一次成功；workers 行、锁、epoch 都对齐", () => {
  const t = makeTempDb();
  const other = openLedger(t.path);
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "把截图按月归档" });

    const first = claimTask(t.db, taskId, { workerId: "worker_a", sessionKey: `task:${taskId}` });
    assert.equal(first.claimed, true);
    assert.equal(first.reason, "claimed");
    assert.equal(first.task?.state, "running");
    assert.equal(first.worker?.run_epoch, first.task?.run_epoch);
    assert.equal(first.worker?.session_key, `task:${taskId}`);

    // 另一个连接：行已经 running，条件更新 0 行，不抢锁、不改状态。
    const second = claimTask(other, taskId, { workerId: "worker_b", sessionKey: `task:${taskId}` });
    assert.equal(second.claimed, false);
    assert.equal(second.reason, "not_queued");

    const lock = getLock(t.db, `task:${taskId}`);
    assert.equal(lock?.worker_id, "worker_a");
    assert.equal(getTask(t.db, taskId)?.state, "running");
    assert.equal(listWorkers(t.db, taskId).length, 1);
  } finally {
    try {
      other.close();
    } catch {
      // 已经关了
    }
    t.cleanup();
  }
});

test("认领：任务锁被别的工人拿着时不领，状态保持 queued", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "锁冲突" });
    acquireLock(t.db, `task:${taskId}`, { taskId, workerId: "worker_other" });

    const result = claimTask(t.db, taskId, { workerId: "worker_new", sessionKey: `task:${taskId}` });
    assert.equal(result.claimed, false);
    assert.equal(result.reason, "lock_held");
    assert.equal(result.heldBy?.workerId, "worker_other");
    assert.equal(getTask(t.db, taskId)?.state, "queued");
    assert.equal(listWorkers(t.db, taskId).length, 0);
  } finally {
    t.cleanup();
  }
});

// ── 2. 一次完整的派发 ──────────────────────────────────────────────────────

test("派发：参数正确、全成功才 done、放锁、worker 行收尾", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "在练习夹里建一个说明文件", source: "test" });
    succeededStep(t.db, taskId, 0, 1);
    succeededStep(t.db, taskId, 0, 2);

    const fake = fakeRuntime();
    const dispatcher = makeDispatcher(t.db, testConfig(), fake);
    const report = await dispatcher.tickOnce();

    assert.equal(report.status, "dispatching");
    assert.deepEqual(report.claimed, [taskId]);
    assert.equal(report.results[0]?.outcome, "done");
    assert.equal(fake.calls.length, 1);

    const call = fake.calls[0];
    assert.equal(call?.sessionKey, `task:${taskId}`);
    assert.equal(call?.idempotencyKey, `task:${taskId}:0`);
    assert.equal(call?.deliver, false);
    assert.ok(call?.message.includes(taskId));
    assert.ok(call?.message.includes("在练习夹里建一个说明文件"));
    // prompt.ts 已按「按任务挑对手」重写（2026-11-25 真机事故）：
    // 追加段只对这一个任务、且明确禁止拿 practice 糊弄，不再写死「只能用 practice 手」。
    assert.ok(call?.extraSystemPrompt?.includes(`只负责任务 ${taskId} 这一件事`));
    assert.ok(call?.extraSystemPrompt?.includes("不许用 practice 假装做完"));
    assert.ok(call?.extraSystemPrompt?.includes("practice"));

    const task = getTask(t.db, taskId);
    assert.equal(task?.state, "done");
    assert.equal(getLock(t.db, `task:${taskId}`), null, "会话结束要放锁");
    assert.equal(listWorkers(t.db, taskId)[0]?.status, "done");
  } finally {
    t.cleanup();
  }
});

test("重排计数按理由分开：里程碑推进不算「派发失败」次数", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "分两段做的活" });
    // 前一段做完、任务被放回队列（after-settle 干的就是这件事）。
    requeueTask(t.db, taskId, { reason: "里程碑 m1 完成，接着做 2. 第二步", expect: ["queued"] });
    assert.equal(requeueAttempts(t.db, taskId), 1);
    assert.equal(requeueAttempts(t.db, taskId, "派发通道没就绪"), 0, "按前缀数只数派发失败那类");

    const fake = fakeRuntime({
      onRun: async () => {
        throw new Error("subagent 起不来");
      },
    });
    const report = await makeDispatcher(t.db, testConfig(), fake).tickOnce();
    assert.equal(report.results[0]?.outcome, "left", "第 1 次派发失败只回队列，不该被上一次里程碑重排凑成 failed");
    assert.equal(getTask(t.db, taskId)?.state, "queued");
  } finally {
    t.cleanup();
  }
});

test("派发：结算之后跑收尾钩子，拿到的是结算后的结论", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "做完就跑收尾", source: "test" });
    succeededStep(t.db, taskId, 0, 1);

    const seen: Array<{ taskId: string; outcome: SettleOutcome }> = [];
    const dispatcher = makeDispatcher(t.db, testConfig(), fakeRuntime(), {
      afterSettle: async (input) => {
        // 钩子跑的时候状态必须已经定完、锁已经放开（否则就是「收尾拖住任务」）。
        seen.push(input);
        assert.equal(getTask(t.db, taskId)?.state, "done");
        assert.equal(getLock(t.db, `task:${taskId}`), null);
      },
    });
    await dispatcher.tickOnce();

    assert.deepEqual(seen, [{ taskId, outcome: "done" }]);
  } finally {
    t.cleanup();
  }
});

test("派发：收尾钩子抛错不影响结算结论", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "收尾炸了也要 done", source: "test" });
    succeededStep(t.db, taskId, 0, 1);

    const dispatcher = makeDispatcher(t.db, testConfig(), fakeRuntime(), {
      afterSettle: async () => {
        throw new Error("小结模型挂了");
      },
    });
    const report = await dispatcher.tickOnce();

    assert.equal(report.results[0]?.outcome, "done");
    assert.equal(getTask(t.db, taskId)?.state, "done");
  } finally {
    t.cleanup();
  }
});

test("派发：起会话抛错先放回队列重试，连续 3 次才 failed（不留 running）", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "会抛错的任务" });
    const fake = fakeRuntime({
      onRun: async () => {
        throw new Error("subagent 起不来");
      },
    });
    const dispatcher = makeDispatcher(t.db, testConfig(), fake);

    // 第 1 次：起会话本身失败（可能是派发通道没就绪），任务回 queued，不许留 running、也不许判死。
    const first = await dispatcher.tickOnce();
    assert.equal(first.results[0]?.outcome, "left");
    let task = getTask(t.db, taskId);
    assert.equal(task?.state, "queued");
    assert.equal(task?.run_epoch, 0, "没起会话就不 bump epoch（幂等键不能白换）");
    assert.equal(getLock(t.db, `task:${taskId}`), null, "重排要放锁");

    // 第 2 次：还是起不来，仍然回队列。
    const second = await dispatcher.tickOnce();
    assert.equal(second.results[0]?.outcome, "left");
    assert.equal(getTask(t.db, taskId)?.state, "queued");

    // 第 3 次：到上限，判 failed 并写清原因。
    const third = await dispatcher.tickOnce();
    assert.equal(third.results[0]?.outcome, "failed");
    task = getTask(t.db, taskId);
    assert.equal(task?.state, "failed");
    assert.ok((task?.state_reason ?? "").includes("subagent 起不来"));
    assert.equal(fake.calls.length, 3);
  } finally {
    t.cleanup();
  }
});

test("派发：会话返回 error → failed", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "会话报错" });
    const fake = fakeRuntime({ wait: async () => ({ status: "error", error: "模型 500" }) });
    await makeDispatcher(t.db, testConfig(), fake).tickOnce();

    const task = getTask(t.db, taskId);
    assert.equal(task?.state, "failed");
    assert.ok((task?.state_reason ?? "").includes("模型 500"));
  } finally {
    t.cleanup();
  }
});

test("派发：会话超时 → paused + blocked_on 说明卡在哪", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "永远不结束" });
    succeededStep(t.db, taskId, 0, 1);
    const fake = fakeRuntime({ wait: async () => ({ status: "timeout" }) });
    const report = await makeDispatcher(t.db, testConfig({ session_timeout_ms: 60 }), fake).tickOnce();

    assert.equal(report.results[0]?.outcome, "paused");
    const task = getTask(t.db, taskId);
    assert.equal(task?.state, "paused");
    assert.ok((task?.blocked_on_json ?? "").includes("超时"), "blocked_on 要写清卡在超时");
    assert.equal(getLock(t.db, `task:${taskId}`), null);
  } finally {
    t.cleanup();
  }
});

// ── 3. 先来先做 ────────────────────────────────────────────────────────────

test("派发：按 created_at 先来先做", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const early = createTask(t.db, { intent: "先来的" });
    const late = createTask(t.db, { intent: "后到的" });
    t.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-11-25T00:00:00.000Z", early);
    t.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-11-25T00:00:01.000Z", late);

    const fake = fakeRuntime();
    const dispatcher = makeDispatcher(t.db, testConfig({ max_concurrent: 1 }), fake);
    const first = await dispatcher.tickOnce();
    assert.deepEqual(first.claimed, [early]);

    const second = await dispatcher.tickOnce();
    assert.deepEqual(second.claimed, [late]);
    assert.equal(fake.calls[0]?.message.includes("先来的"), true);
    assert.equal(fake.calls[1]?.message.includes("后到的"), true);
  } finally {
    t.cleanup();
  }
});

// ── 4. 开关与拒绝 ──────────────────────────────────────────────────────────

test("开关：dispatch.enabled=false 一个都不领、一次都不调 runtime", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "停用期间不许动" });
    const fake = fakeRuntime();
    const dispatcher = makeDispatcher(t.db, testConfig({ enabled: false }), fake);
    dispatcher.start(); // 停用时不启动

    const report = await dispatcher.tickOnce();
    assert.equal(report.status, "disabled");
    assert.deepEqual(report.claimed, []);
    assert.equal(fake.calls.length, 0);
    assert.equal(getTask(t.db, taskId)?.state, "queued");
  } finally {
    t.cleanup();
  }
});

test("完整性校验不过：不派发，任务留在 queued", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "断链时不派发" });
    const fake = fakeRuntime();
    const dispatcher = makeDispatcher(t.db, testConfig(), fake, {
      verify: () => ({ ok: false, detail: "指纹链在第 3 条断了" }),
    });
    const report = await dispatcher.tickOnce();
    assert.equal(report.status, "refused");
    assert.equal(fake.calls.length, 0);
    assert.equal(getTask(t.db, taskId)?.state, "queued");
  } finally {
    t.cleanup();
  }
});

test("没有 api.runtime.subagent：只报错不派发", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "没有运行时" });
    const dispatcher = makeDispatcher(t.db, testConfig(), undefined);
    const report = await dispatcher.tickOnce();
    assert.equal(report.status, "no_runtime");
    assert.equal(getTask(t.db, taskId)?.state, "queued");
  } finally {
    t.cleanup();
  }
});

// ── 5. settle 的判定 ───────────────────────────────────────────────────────

test("settle：有失败步 → failed 并写 state_reason", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "一步失败" });
    setTaskState(t.db, taskId, "running", { expect: ["queued"] });
    succeededStep(t.db, taskId, 0, 1);
    const bad = beginStep(t.db, {
      task_id: taskId,
      run_epoch: 0,
      kind: "tool",
      tool: "practice",
      subject_key: "k_bad",
      side_effect: "replayable",
    });
    endStep(t.db, bad.id, { status: "failed", error: "写失败" });

    const report = settleTask(t.db, taskId);
    assert.equal(report.outcome, "failed");
    assert.equal(getTask(t.db, taskId)?.state, "failed");
    assert.ok((getTask(t.db, taskId)?.state_reason ?? "").includes("failed=1"));
  } finally {
    t.cleanup();
  }
});

test("settle：一步都没做 → failed（零步骤不算成功）", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "工人什么都没干" });
    setTaskState(t.db, taskId, "running", { expect: ["queued"] });

    const report = settleTask(t.db, taskId);
    assert.equal(report.outcome, "failed");
    assert.ok((getTask(t.db, taskId)?.state_reason ?? "").includes("no_steps"));
  } finally {
    t.cleanup();
  }
});

test("settle：等审批中的任务不被改成 done/failed", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "等人批" });
    setTaskState(t.db, taskId, "awaiting_approval", { reason: "等审批 #1", expect: ["queued"] });

    const report = settleTask(t.db, taskId);
    assert.equal(report.outcome, "left");
    assert.equal(getTask(t.db, taskId)?.state, "awaiting_approval");
  } finally {
    t.cleanup();
  }
});

// ── 6. 闸门真的拦得住 ──────────────────────────────────────────────────────

test("闸门：工人会话里的 exec 被拦下 → 建审批、任务转 awaiting_approval，派发器不自己批", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const config = testConfig();
    const taskId = createTask(t.db, { intent: "推一下远端", source: "test" });
    const governor = createBuiltinGovernor({ db: t.db, config });

    // 模拟工人会话里模型调 exec：真实 judgeTier 判 4 档 → ask。
    let blocked: { block?: boolean; blockReason?: string } | undefined;
    const fake = fakeRuntime({
      onRun: async (params) => {
        blocked = await governor.beforeToolCall(
          { toolName: "exec", params: { command: "git push origin main" }, toolCallId: "call-1" },
          { toolName: "exec", sessionKey: params.sessionKey },
        );
        return { runId: "run_gate" };
      },
    });

    const report = await makeDispatcher(t.db, config, fake).tickOnce();
    assert.equal(blocked?.block, true, "闸门必须拦下");
    assert.ok((blocked?.blockReason ?? "").includes("批准"));

    const task = getTask(t.db, taskId);
    assert.equal(task?.state, "awaiting_approval");
    assert.notEqual(report.results[0]?.outcome, "done", "派发器不许把等审批的任务标完成");

    const approvals = listApprovals(t.db, { task_id: taskId });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.status, "pending", "派发器不许自己批");
  } finally {
    t.cleanup();
  }
});

// ── 7. sessionKey 改写兼容 ─────────────────────────────────────────────────

test("sessionKey：裸键与网关改写后的 agent:<id>:task:<id> 都认", () => {
  assert.equal(taskIdFromSessionKey("task:task_ab12cd"), "task_ab12cd");
  assert.equal(taskIdFromSessionKey("agent:main:task:task_ab12cd"), "task_ab12cd");
  assert.equal(taskIdFromSessionKey("AGENT:Main:Task:task_ab12cd"), "task_ab12cd");
  assert.equal(taskIdFromSessionKey("main"), null);
  assert.equal(taskIdFromSessionKey("agent:main:chat:1"), null);
  assert.equal(taskIdFromSessionKey(undefined), null);
});

// ── 8. 入口接线：派发器挂在 gateway_start / gateway_stop 上 ────────────────

test("入口：gateway_start 起派发器、gateway_stop 停，handle.stop 也停", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-core-dispatch-entry-"));
  const dotDir = join(dir, ".allbot", "dot");
  const hooks: Array<{
    events: string | string[];
    handler: (event: unknown, ctx: unknown) => unknown;
    opts?: { name?: string };
  }> = [];
  const fake = fakeRuntime();
  const api = {
    id: "dot-core",
    config: { tasks: { enabled: false }, agents: { defaults: { compaction: { mode: "safeguard" } } } },
    runtime: fake.runtime,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerTool: () => {},
    registerHook: (
      events: string | string[],
      handler: (event: unknown, ctx: unknown) => unknown,
      opts?: { name?: string },
    ) => {
      hooks.push({ events, handler, opts });
    },
    registerHttpRoute: () => {},
  };

  let handle: ReturnType<typeof registerDotCore> | null = null;
  try {
    handle = registerDotCore(api as never, {
      home: dir,
      dotDir,
      heartbeatIntervalMs: 0,
      config: testConfig(),
    });
    // 同一个事件名挂了两个钩子（恢复协议 + 派发器），按 opts.name 取，别按顺序猜。
    const hookFor = (name: string) => {
      const found = hooks.find((h) => h.opts?.name === name);
      assert.ok(found !== undefined, `没注册 ${name} 钩子`);
      return found as { handler: (event: unknown, ctx: unknown) => unknown };
    };
    hookFor("dot-core.gateway.recover").handler({ port: 18789 }, {});
    hookFor("dot-core.dispatch.start").handler({ port: 18789 }, {});

    assert.equal(handle.dispatch.isStarted, true);
    hookFor("dot-core.dispatch.stop").handler({ port: 18789 }, {});
    assert.equal(handle.dispatch.isStarted, false);

    hookFor("dot-core.dispatch.start").handler({ port: 18789 }, {});
    handle.stop();
    assert.equal(handle.dispatch.isStarted, false, "handle.stop 也要停派发器");
  } finally {
    try {
      handle?.stop();
    } catch {
      // 已经停了
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ── 9. 超时之后有人接管（有界重排）────────────────────────────────────────

test("超时 → paused → 自动重排一次；第二次超时不再重排", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "每次都超时的活" });
    const fake = fakeRuntime({ wait: async () => ({ status: "timeout" }) });
    const dispatcher = makeDispatcher(t.db, testConfig({ session_timeout_ms: 40 }), fake);

    const first = await dispatcher.tickOnce();
    assert.equal(first.results[0]?.outcome, "paused");
    assert.equal(getTask(t.db, taskId)?.state, "paused");
    assert.equal(getTask(t.db, taskId)?.run_epoch, 0);

    const second = await dispatcher.tickOnce();
    assert.equal(fake.calls.length, 2, "超时任务要有人接管：第二轮重新派发");
    assert.equal(getTask(t.db, taskId)?.run_epoch, 1, "重排要 bump epoch（旧会话被 fencing）");
    assert.equal(second.results[0]?.outcome, "paused");

    const third = await dispatcher.tickOnce();
    assert.equal(fake.calls.length, 2, "补救次数用完不再自动重排");
    assert.equal(third.status, "idle");
    assert.equal(getTask(t.db, taskId)?.state, "paused", "留在 paused 等真人");
  } finally {
    t.cleanup();
  }
});

// ── 10. 审批有结论 → 任务回队列（原来停在 awaiting_approval 就死路）──────

test("审批通过：任务回 queued、epoch+1，下一轮 tick 能领到", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "被拦下等批的活" });
    const config = testConfig();
    const governor = createBuiltinGovernor({ db: t.db, config });
    // 走真实闸门：exec → 4 档 → 出单 → 任务转 awaiting_approval。
    await governor.beforeToolCall(
      { toolName: "exec", params: { command: "git push origin main" }, toolCallId: "c1" },
      { toolName: "exec", sessionKey: `task:${taskId}` },
    );
    const [approval] = listApprovals(t.db, { task_id: taskId });
    assert.ok(approval !== undefined);
    assert.equal(getTask(t.db, taskId)?.state, "awaiting_approval");

    assert.equal(decideApproval(t.db, approval.id, { decision: "approved", decidedBy: "cli" }), true);
    const resume = resumeAfterDecision(t.db, approval.id);
    assert.equal(resume.action, "requeued");
    const queuedTask = getTask(t.db, taskId);
    assert.equal(queuedTask?.state, "queued");
    assert.equal(queuedTask?.run_epoch, 1, "重排要 bump epoch");

    const fake = fakeRuntime();
    const report = await makeDispatcher(t.db, config, fake).tickOnce();
    assert.deepEqual(report.claimed, [taskId], "重排之后下一轮派发要能领到");
    assert.equal(fake.calls[0]?.idempotencyKey, `task:${taskId}:1`);
  } finally {
    t.cleanup();
  }
});

test("审批被拒：任务终止，不会再来一轮出同一张单", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "被拒的活" });
    const approvalId = createApprovalRow(t.db, { taskId });
    setTaskState(t.db, taskId, "awaiting_approval", { expect: ["queued"] });
    assert.equal(decideApproval(t.db, approvalId, { decision: "rejected", decidedBy: "cli" }), true);

    const resume = resumeAfterDecision(t.db, approvalId);
    assert.equal(resume.action, "cancelled");
    assert.equal(getTask(t.db, taskId)?.state, "cancelled");
  } finally {
    t.cleanup();
  }
});

test("还有别的未决单：先不重排", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "两张单的活" });
    const first = createApprovalRow(t.db, { taskId });
    createApprovalRow(t.db, { taskId });
    setTaskState(t.db, taskId, "awaiting_approval", { expect: ["queued"] });
    decideApproval(t.db, first, { decision: "approved", decidedBy: "cli" });

    const resume = resumeAfterDecision(t.db, first);
    assert.equal(resume.action, "left");
    assert.equal(getTask(t.db, taskId)?.state, "awaiting_approval");
  } finally {
    t.cleanup();
  }
});

// ── 11. 完整性校验不缓存 ───────────────────────────────────────────────────

test("完整性校验每轮都跑：启动后中途断链就停手", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const first = createTask(t.db, { intent: "先来" });
    const second = createTask(t.db, { intent: "后到" });
    t.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-11-25T00:00:00.000Z", first);
    t.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-11-25T00:00:01.000Z", second);

    let calls = 0;
    const fake = fakeRuntime();
    const dispatcher = makeDispatcher(t.db, testConfig({ max_concurrent: 1 }), fake, {
      verify: () => {
        calls += 1;
        return calls === 1
          ? { ok: true, detail: "第一次校验通过" }
          : { ok: false, detail: "指纹链在第 9 条断了" };
      },
    });

    const one = await dispatcher.tickOnce();
    assert.equal(one.status, "dispatching");
    assert.deepEqual(one.claimed, [first]);

    const two = await dispatcher.tickOnce();
    assert.equal(two.status, "refused", "第二次要重新校验并停手，不能吃第一次的缓存");
    assert.equal(fake.calls.length, 1);
    assert.equal(getTask(t.db, second)?.state, "queued");
    assert.equal(calls, 2);
  } finally {
    t.cleanup();
  }
});

test("派发：工人报 [user_control]（人在用电脑）→ paused 等人，不判失败", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const taskId = createTask(t.db, { intent: "点一下桌面上的按钮" });
    const fake = fakeRuntime({
      wait: async () => ({
        status: "error",
        error: "[user_control] Screenshot 调用被 Windows-MCP 挡下：你现在在用电脑（USER_CONTROL）。我先停手，你说「继续」我再接着做。",
      }),
    });
    const report = await makeDispatcher(t.db, testConfig(), fake).tickOnce();

    assert.equal(report.results[0]?.outcome, "paused");
    const task = getTask(t.db, taskId);
    assert.equal(task?.state, "paused", "人在用电脑不是任务的错，不该判 failed");
    assert.match(task?.state_reason ?? "", /在用电脑/);
    assert.doesNotMatch(task?.state_reason ?? "", /\[user_control\]/, "前缀是内部标记，别给用户看");
  } finally {
    t.cleanup();
  }
});
