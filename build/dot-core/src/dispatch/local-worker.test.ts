/**
 * src/dispatch/local-worker.test.ts —— 本机工人的验收。
 *
 * 钉住这些容易漂的事：
 * 1. 工人真的会「调模型 → 解析工具调用 → 用我们自己的手执行 → 把结果喂回去」；
 * 2. 沙箱路径：写文件真落在练习文件夹里，账本里留下 succeeded 步骤；
 * 3. 模型要了没有的工具，只回一句「没有这个工具」，不崩、不算失败；
 * 4. 到步数上限就收手，不无限转；
 * 5. 会话归不到任务时立刻回 error，不假装跑过；
 * 6. sessionKey 的两种写法（`task:<id>` 与网关改写后的 `agent:<x>:task:<id>`）都认。
 *
 * 这里全部注入假模型，**不连**本机模型池。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate } from "../ledger/index.ts";
import { beginStep, endStep, listMilestones, listSteps, putArtifact, updateMilestone } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import { defaultConfig, type DotCoreConfig } from "../config.ts";
import { planTask } from "../plan/index.ts";
import { createLocalWorkerRuntime, createPoolModelComplete, DEFAULT_MODEL, type ModelTurn, type ModelComplete } from "./local-worker.ts";

function fixture(): { db: ReturnType<typeof makeTempDb>; config: DotCoreConfig; practiceRoot: string; cleanup: () => void } {
  const t = makeTempDb();
  migrate(t.db);
  const practiceRoot = mkdtempSync(join(tmpdir(), "dot-local-worker-"));
  const config = defaultConfig();
  config.practice.root = practiceRoot;
  return {
    db: t,
    config,
    practiceRoot,
    cleanup: () => {
      rmSync(practiceRoot, { recursive: true, force: true });
      t.cleanup();
    },
  };
}

/** 按脚本吐回合的假模型；脚本用完就回「不再要工具」。 */
function scripted(turns: ModelTurn[]): { complete: ModelComplete; seen: Array<{ tools: unknown[]; messages: number }> } {
  const seen: Array<{ tools: unknown[]; messages: number }> = [];
  let i = 0;
  return {
    seen,
    complete: async ({ messages, tools }) => {
      seen.push({ tools, messages: messages.length });
      const turn = turns[i];
      i += 1;
      return turn ?? { text: "做完了", toolCalls: [] };
    },
  };
}

const ALLOW_JUDGE = () => ({
  tier: 1 as const,
  reason: "测试：练习文件夹内的动作直接放行",
  rule: "test.allow",
  handling: "allow" as const,
  sideEffect: "replayable" as const,
  judgeNeeded: false,
});

test("本机工人：模型要 write → 文件真写进练习文件夹，账本留下 succeeded 步骤，回 ok", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "在练习文件夹里写一个说明文件", state: "running" });
    const { complete, seen } = scripted([
      {
        text: "我先写文件。",
        toolCalls: [
          { id: "c1", name: "practice", arguments: JSON.stringify({ action: "write", path: "说明.txt", content: "你好" }) },
        ],
      },
      { text: "写好了：说明.txt", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      maxSteps: 5,
    });

    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "写一个说明文件" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "ok");
    const written = join(f.practiceRoot, "说明.txt");
    assert.equal(existsSync(written), true, "文件应该真写出来");
    assert.equal(readFileSync(written, "utf8"), "你好");

    const steps = listSteps(f.db.db, taskId);
    assert.equal(steps.length, 1, "一步 practice 应该落一行步骤");
    assert.equal(steps[0]?.status, "succeeded");
    assert.equal(steps[0]?.tool, "practice");

    // 第一次调用带了工具声明，第二次是「拿到工具结果之后」的续问。
    assert.equal(seen.length, 2);
    assert.equal(Array.isArray(seen[0]?.tools), true);
    // practice + delegate（delegate 是父工人才能用的：把一块活交给子工人）
    assert.equal((seen[0]?.tools as unknown[]).length, 2);
    assert.ok((seen[1]?.messages ?? 0) > (seen[0]?.messages ?? 0), "工具结果要喂回模型");
  } finally {
    f.cleanup();
  }
});

test("本机工人：模型要了没有的工具 → 只回一句「没有这个工具」，任务仍能正常收工", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "试着用 exec 跑命令", state: "running" });
    const { complete } = scripted([
      { text: "", toolCalls: [{ id: "c1", name: "exec", arguments: "{}" }] },
      { text: "那我干不了", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      maxSteps: 5,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "跑个命令" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "ok", "拒掉一个不存在的工具不等于任务失败");
    // 2026-11-26 审计：补记一条 skipped 步骤，让账本看得见「这一步要了不存在的工具」
    assert.equal(listSteps(f.db.db, taskId).length, 1, "不存在的工具要留一条 skipped 步骤");
    assert.equal(listSteps(f.db.db, taskId)[0]?.status, "skipped");
  } finally {
    f.cleanup();
  }
});

test("本机工人：到步数上限就收手，返回 error 并说清原因（不无限转）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "一直要工具", state: "running" });
    const loop: ModelTurn[] = [];
    for (let i = 0; i < 10; i += 1) {
      // 每步参数都不同：这条测的是「步数上限」，不是「原地打转」（那条有单独的用例）
      loop.push({
        text: "",
        toolCalls: [{ id: `c${i}`, name: "practice", arguments: JSON.stringify({ action: "list", path: `.` }) }],
      });
    }
    const varied: ModelTurn[] = loop.map((t, i) => ({
      text: t.text,
      toolCalls: t.toolCalls.map((c) => ({ ...c, arguments: JSON.stringify({ action: "list", path: `d${i}` }) })),
    }));
    const { complete, seen } = scripted(varied);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      maxSteps: 3,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "别停" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /3 步/);
    assert.equal(seen.length, 3, "上限 3 步就只该调 3 次模型");
  } finally {
    f.cleanup();
  }
});

test("本机工人：会话归不到任务 → 立刻回 error，不假装跑过", async () => {
  const f = fixture();
  try {
    let called = 0;
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete: async () => {
        called += 1;
        return { text: "不该被调到", toolCalls: [] };
      },
      handDeps: { judge: ALLOW_JUDGE },
    });
    const { runId } = await rt.run({ sessionKey: "随便一个会话", message: "没有任务号" });
    const result = await rt.waitForRun({ runId, timeoutMs: 2000 });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /归不到任务/);
    assert.equal(called, 0, "归不到任务就不该去调模型");
  } finally {
    f.cleanup();
  }
});

test("本机工人：网关改写后的 sessionKey（agent:<x>:task:<id>）也认", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "在练习文件夹里建一层目录", state: "running" });
    mkdirSync(f.practiceRoot, { recursive: true });
    const { complete } = scripted([
      {
        text: "",
        toolCalls: [{ id: "c1", name: "practice", arguments: JSON.stringify({ action: "mkdir", path: "资料" }) }],
      },
      { text: "建好了", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      maxSteps: 5,
    });
    const { runId } = await rt.run({ sessionKey: `agent:main:task:${taskId}`, message: "建目录" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "ok");
    assert.equal(existsSync(join(f.practiceRoot, "资料")), true);
    assert.equal(listSteps(f.db.db, taskId).length, 1);
  } finally {
    f.cleanup();
  }
});

test("本机工人：额外的手（desktop 等）会被列进工具表，并按名字分派", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "读一下桌面状态", state: "running" });
    const seenCalls: Array<{ action: string | undefined; taskId: string | undefined; params: Record<string, unknown> }> = [];
    const fakeHand = {
      name: "desktop",
      description: "假电脑手",
      parameters: { type: "object", required: ["action"], properties: { action: { type: "string" } } },
      async run(req: { action?: string; taskId?: string; params?: Record<string, unknown> }) {
        seenCalls.push({ action: req.action, taskId: req.taskId, params: req.params ?? {} });
        return {
          ok: true,
          code: "ok" as const,
          text: "桌面状态：ready",
          taskId: taskId,
          stepId: "step_x",
          approvalId: null,
          tier: 1,
          rule: "test.desktop",
          sideEffect: "replayable",
          resultRef: null,
        } as never;
      },
    };
    const { complete, seen } = scripted([
      { text: "", toolCalls: [{ id: "c1", name: "desktop", arguments: JSON.stringify({ action: "status", params: { x: 1 } }) }] },
      { text: "读完了", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      extraHands: [fakeHand as never],
      maxSteps: 3,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "读桌面状态" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "ok");
    const tools = seen[0]?.tools as Array<{ function: { name: string } }>;
    assert.deepEqual(
      tools.map((t) => t.function.name),
      ["practice", "desktop", "delegate"],
      "工具表要有练习手 + 额外的手 + delegate（父工人才能派子任务）",
    );
    assert.equal(seenCalls.length, 1);
    assert.equal(seenCalls[0]?.action, "status");
    assert.equal(seenCalls[0]?.taskId, taskId, "taskId 由工人显式给，不靠模型传");
    assert.deepEqual(seenCalls[0]?.params, { x: 1 }, "params 原样交给那只手");
  } finally {
    f.cleanup();
  }
});

test("本机工人：顶层参数也交给手（模型不给 params 嵌套时不能丢）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "跑测试", state: "running" });
    let seenParams: Record<string, unknown> | null = null;
    const fakeHand = {
      name: "exec",
      description: "命令手",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
      async run(req: never) {
        const r = req as unknown as { params: Record<string, unknown> };
        seenParams = r.params;
        return {
          ok: true,
          code: "ok",
          text: "跑完了",
          taskId,
          stepId: null,
          approvalId: null,
          tier: 1,
          rule: "test.exec",
          sideEffect: "safe",
          resultRef: null,
        } as never;
      },
    };
    const { complete } = scripted([
      { text: "", toolCalls: [{ id: "c1", name: "exec", arguments: JSON.stringify({ cmd: "node --test" }) }] },
      { text: "跑完了", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      extraHands: [fakeHand as never],
      maxSteps: 3,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "跑测试" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });
    assert.equal(result.status, "ok");
    assert.deepEqual(seenParams, { cmd: "node --test" }, "顶层 cmd 必须原样到手上，不能变成空对象");
  } finally {
    f.cleanup();
  }
});

test("本机工人：同一个动作反复要（原地打转）→ 第 3 次就停手，不把步数烧光", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "反复要同一件事", state: "running" });
    const same = { id: "c1", name: "practice", arguments: JSON.stringify({ action: "list", path: "." }) };
    const { complete, seen } = scripted([
      { text: "先看一眼", toolCalls: [same] },
      { text: "再看一眼", toolCalls: [{ ...same, id: "c2" }] },
      { text: "还要看", toolCalls: [{ ...same, id: "c3" }] },
      { text: "第四次", toolCalls: [{ ...same, id: "c4" }] },
      { text: "还差一个文件没写", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      maxSteps: 10,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "看一眼" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /还没做完/);
    assert.equal(seen.length, 5, "四次重复后停下来问一次收尾，之后不再问模型");
    assert.equal(listSteps(f.db.db, taskId).length, 1, "只有第一次真执行了，后面的重复不再动手");
  } finally {
    f.cleanup();
  }
});

test("本机工人：打转后收尾说「做完了」→ 按成功算（重复的一步不算失败）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "建个目录然后发呆", state: "running" });
    const mk = { id: "c1", name: "practice", arguments: JSON.stringify({ action: "mkdir", path: "子目录" }) };
    const { complete } = scripted([
      { text: "先建目录", toolCalls: [mk] },
      { text: "再看看", toolCalls: [{ ...mk, id: "c2" }] },
      { text: "还要建", toolCalls: [{ ...mk, id: "c3" }] },
      { text: "再建一次", toolCalls: [{ ...mk, id: "c4" }] },
      { text: "做完了", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      maxSteps: 10,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "建目录" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "ok");
    assert.equal(existsSync(join(f.practiceRoot, "子目录")), true);
    assert.equal(listSteps(f.db.db, taskId).length, 1);
  } finally {
    f.cleanup();
  }
});

test("本机工人：dot_recall 在工具表里、能按明细哈希取回；系统提示词带上已结束里程碑的小结", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "先归档一批截图", state: "running" });
    planTask(f.db.db, {
      taskId,
      goal: "把桌面截图按月份归档",
      milestones: [
        { title: "列清单", done_when: "拿到所有文件名" },
        { title: "搬文件", done_when: "文件都进了对应目录" },
      ],
      why: "按文件名里的月份分",
    });
    const [first] = listMilestones(f.db.db, taskId);
    updateMilestone(f.db.db, first.id, { state: "done", summary: "第一段做完了：文件都列出来了" });
    const meta = putArtifact(f.db.db, "那一步的完整输出：三个文件夹都建好了");
    // 明细要挂在这个任务的某一步上才取得到（src/context/recall.ts 的归属检查）。
    const anchorStep = beginStep(f.db.db, {
      task_id: taskId,
      run_epoch: 0,
      kind: "tool",
      tool: "practice",
      subject_key: "k-artifact-owner",
      side_effect: "safe",
      tier: 1,
    });
    endStep(f.db.db, anchorStep.id, { status: "succeeded", result_ref: meta.hash });

    const systemSeen: string[] = [];
    const toolBodies: string[] = [];
    let calls = 0;
    const complete: ModelComplete = async ({ messages, tools }) => {
      systemSeen.push(messages[0]?.content ?? "");
      toolBodies.push(
        ...messages.filter((m) => m.role === "tool").map((m) => m.content),
      );
      calls += 1;
      if (calls === 1) {
        assert.ok(
          (tools as Array<{ function: { name: string } }>).some((t) => t.function.name === "dot_recall"),
          "开了 enableRecall，工具表里就要有 dot_recall",
        );
        return {
          text: "",
          toolCalls: [{ id: "r1", name: "dot_recall", arguments: JSON.stringify({ artifact: meta.hash }) }],
        };
      }
      return { text: "取到了", toolCalls: [] };
    };

    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      enableRecall: true,
      maxSteps: 4,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "把刚才那一步的明细拿来看看" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "ok");
    assert.ok(systemSeen[0]?.includes("第一段做完了"), "阶段小结要进系统提示词（buildInjection）");
    assert.ok(systemSeen[0]?.includes("dot_recall"), "提示词里要说清 dot_recall 怎么用");
    assert.ok(
      toolBodies.some((body) => body.includes("三个文件夹都建好了")),
      "dot_recall 的结果要喂回模型",
    );
    // 只读不落步骤：工人这条路径直接 executeRecallTool，没有 beginStep/endStep。
    const steps = listSteps(f.db.db, taskId);
    assert.equal(steps.filter((s) => s.tool === "dot_recall").length, 0, "dot_recall 不该在账本里留下步骤");
    assert.equal(steps.length, 1, "账本里只该有为挂明细建的那一步");
  } finally {
    f.cleanup();
  }
});

test("本机工人：每轮 usage 经 onUsage 交出去（预算八成的分子就是它）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "随便干点", state: "running" });
    const usages: Array<{ taskId: string; model: string; input: number; output: number }> = [];
    const { complete } = scripted([
      {
        text: "",
        toolCalls: [{ id: "c1", name: "practice", arguments: JSON.stringify({ action: "list", path: "" }) }],
        usage: { input_tokens: 120, output_tokens: 30 },
      },
      { text: "看完了", toolCalls: [], usage: { input_tokens: 80, output_tokens: 10 } },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      onUsage: (input) =>
        usages.push({
          taskId: input.taskId,
          model: input.model,
          input: input.usage.input_tokens,
          output: input.usage.output_tokens,
        }),
      maxSteps: 4,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "列一下" });
    assert.equal((await rt.waitForRun({ runId, timeoutMs: 5000 })).status, "ok");
    assert.deepEqual(usages, [
      { taskId, model: DEFAULT_MODEL, input: 120, output: 30 },
      { taskId, model: DEFAULT_MODEL, input: 80, output: 10 },
    ]);
  } finally {
    f.cleanup();
  }
});

test("本机工人：模型池回 usage 时解析成 ModelTurn.usage（prompt/completion 与 input/output 都认）", async () => {
  const realFetch = globalThis.fetch;
  try {
    const replies = [
      { choices: [{ message: { content: "好" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      { choices: [{ message: { content: "好" } }], usage: { input_tokens: 11, output_tokens: 5 } },
      { choices: [{ message: { content: "好" } }] },
    ];
    let i = 0;
    globalThis.fetch = (async () => {
      const body = replies[i];
      i += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const complete = createPoolModelComplete(undefined, "test-model", () => ({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "test-key",
    }));
    assert.deepEqual((await complete({ messages: [], tools: [] })).usage, { input_tokens: 7, output_tokens: 3 });
    assert.deepEqual((await complete({ messages: [], tools: [] })).usage, { input_tokens: 11, output_tokens: 5 });
    assert.equal((await complete({ messages: [], tools: [] })).usage, undefined, "没给 usage 就不编");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("本机工人：waitForRun 查一个不存在的 runId → error，不抛", async () => {
  const f = fixture();
  try {
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete: async () => ({ text: "", toolCalls: [] }),
      handDeps: { judge: ALLOW_JUDGE },
    });
    const result = await rt.waitForRun({ runId: "local-999-nope", timeoutMs: 100 });
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /没有这个本地 run/);
  } finally {
    f.cleanup();
  }
});

test("系统提示词：有专用的手就别绕路（别为建飞书日程先开浏览器）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "在飞书日历上建一条日程" });
    const { getTask } = await import("../ledger/index.ts");
    const task = getTask(f.db.db, taskId);
    assert.ok(task);
    const { systemPrompt } = await import("./local-worker.ts");
    const text = systemPrompt(f.db.db, task, ["practice", "feishu", "clean_browser", "desktop"]);
    assert.match(text, /不要绕路/, "要写清「有专用的手就直接用」");
    assert.match(text, /不要换一只不相干的手绕过去/, "被拒要照实说，不换手绕过");
  } finally {
    f.cleanup();
  }
});

test("硬失败（没权限）：立刻收尾，不再换别的工具硬试", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "在飞书日历上建一条日程" });
    const fakeHand = {
      name: "feishu",
      description: "飞书日历",
      parameters: { type: "object", required: ["action"], properties: { action: { type: "string" } } },
      async run() {
        return {
          ok: false,
          code: "failed" as const,
          errorCode: "scope_missing",
          text: "动作没有完成：飞书应用没开通这个操作要的权限",
          taskId,
          stepId: null,
          approvalId: null,
          tier: 4,
          rule: null,
          sideEffect: "unknown",
          resultRef: null,
        } as never;
      },
    };
    const { complete, seen } = scripted([
      { text: "", toolCalls: [{ id: "c1", name: "feishu", arguments: JSON.stringify({ action: "create" }) }] },
      // 如果工人还想再调一次别的工具，这条就会被记下来（不该发生）
      { text: "", toolCalls: [{ id: "c2", name: "feishu", arguments: JSON.stringify({ action: "events" }) }] },
      { text: "没权限，没建成", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      extraHands: [fakeHand as never],
      maxSteps: 6,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "建一条日程" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });
    assert.equal(result.status, "error", "没权限就是没做成，任务要判失败");
    assert.match(String(result.error), /scope_missing|没开通/);
    assert.equal(seen.length, 1, `硬失败后不该再问模型，实际调了 ${seen.length} 次`);
  } finally {
    f.cleanup();
  }
});

test("系统提示词带当前时间（省掉模型开浏览器问日期）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "建一条明天的日程" });
    const { getTask } = await import("../ledger/index.ts");
    const task = getTask(f.db.db, taskId);
    assert.ok(task);
    const { systemPrompt } = await import("./local-worker.ts");
    const text = systemPrompt(f.db.db, task, ["practice", "feishu"]);
    assert.match(text, /现在是 \d{4}/, "要有当前时间");
    assert.match(text, /别为了问日期去开浏览器/, "要说清不用去查");
  } finally {
    f.cleanup();
  }
});

test("本机工人：额外的手必须收到 path / content / overwrite（真机上被丢在这里，files 一直 bad_path）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "在桌面建个文件夹", state: "running" });
    const seen: Array<{ action?: string; path?: string; content?: string; overwrite?: boolean }> = [];
    const fakeHand = {
      name: "files",
      description: "假文件手",
      parameters: {
        type: "object",
        required: ["action"],
        properties: { action: { type: "string" }, path: { type: "string" } },
      },
      async run(req: { action?: string; path?: string; content?: string; overwrite?: boolean }) {
        seen.push({ action: req.action, path: req.path, content: req.content, overwrite: req.overwrite });
        return {
          ok: true,
          code: "ok" as const,
          text: "建好文件夹：dot-验收文件夹",
          taskId,
          stepId: "step_x",
          approvalId: null,
          tier: 2,
          rule: "test.files",
          sideEffect: "reversible",
          resultRef: null,
        } as never;
      },
    };
    const { complete } = scripted([
      {
        text: "",
        toolCalls: [
          {
            id: "c1",
            name: "files",
            arguments: JSON.stringify({ action: "mkdir", path: "dot-验收文件夹", content: "", overwrite: true }),
          },
        ],
      },
      { text: "建好了", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      extraHands: [fakeHand as never],
      maxSteps: 3,
    });
    const { runId } = await rt.run({ sessionKey: `task:${taskId}`, message: "在桌面建个文件夹" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });

    assert.equal(result.status, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.action, "mkdir");
    assert.equal(seen[0]?.path, "dot-验收文件夹", "path 必须转交给手，不能在半路丢掉");
    assert.equal(seen[0]?.overwrite, true);
  } finally {
    f.cleanup();
  }
});

test("系统提示词带上前几轮做过的事（批卡/崩过之后别重头再查一遍）", async () => {
  const f = fixture();
  try {
    const taskId = createTask(f.db.db, { intent: "查一下桥的路由文件" });
    const { getTask, beginStep, endStep, putArtifact } = await import("../ledger/index.ts");
    // 造两步已经跑过的执行：一步成功（带 cmd 和输出），一步被闸门拒了。
    const ok = beginStep(f.db.db, { task_id: taskId, run_epoch: 0, kind: "tool", tool: "exec", subject_key: "k1", side_effect: "safe", tier: 1 });
    const okRes = putArtifact(f.db.db, JSON.stringify({ ok: true, action: "run", data: { cmd: "ls build/dot-core/src/bridge", cwd: ".", exit_code: 0, stdout: "routes.ts access.ts" } }));
    endStep(f.db.db, ok.id, { status: "succeeded", result_ref: okRes.hash });
    const bad = beginStep(f.db.db, { task_id: taskId, run_epoch: 0, kind: "tool", tool: "exec", subject_key: "k2", side_effect: "safe", tier: 1 });
    endStep(f.db.db, bad.id, { status: "skipped", error: "bad_action: 「wc」不在允许的命令名单里" });

    const task = getTask(f.db.db, taskId);
    assert.ok(task);
    const { systemPrompt } = await import("./local-worker.ts");
    const text = systemPrompt(f.db.db, task, ["practice", "exec"]);
    assert.match(text, /前面已经做了 2 步/, "要说清前面做过几步");
    assert.match(text, /ls build\/dot-core\/src\/bridge/, "成功的命令要带回来，省得再查一遍");
    assert.match(text, /routes\.ts access\.ts/, "输出开头也要带上");
    assert.match(text, /wc/, "被拒过的那条也要带上，别原样重试");
  } finally {
    f.cleanup();
  }
});

test("delegate：父工人派子任务，子任务独立跑完并把结论带回来", async () => {
  const f = fixture();
  try {
    // 父任务：有意图、没有工作区（子任务沿用即可）
    const parentId = createTask(f.db.db, { intent: "把结论写进练习夹，再汇报" });
    const handCalls: Array<{ action: string; path?: string }> = [];
    const fakeFiles = {
      name: "files",
      description: "工作区文件",
      parameters: { type: "object", required: ["action"], properties: { action: { type: "string" }, path: { type: "string" } } },
      async run(req: { action?: string; path?: string }) {
        handCalls.push({ action: String(req.action ?? ""), path: req.path });
        return {
          ok: true, code: "ok" as const, text: `写入完成：${req.path ?? ""}`, taskId: parentId,
          stepId: null, approvalId: null, tier: 2, rule: "test.allow", sideEffect: "replayable" as const,
          resultRef: null, snapshotRef: null,
        } as never;
      },
    };
    const { complete, seen } = scripted([
      // 1) 父工人：派子任务
      { text: "", toolCalls: [{ id: "p1", name: "delegate", arguments: JSON.stringify({ brief: "把结论写进 out.txt，写完说一声" }) }] },
      // 2) 子工人：调一次手
      { text: "", toolCalls: [{ id: "c1", name: "files", arguments: JSON.stringify({ action: "write", path: "out.txt" }) }] },
      // 3) 子工人：收工并给结论
      { text: "写好了：out.txt，内容是结论", toolCalls: [] },
      // 4) 父工人：拿到结论后收工
      { text: "子任务写完了，我也收工", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      extraHands: [fakeFiles as never],
      maxSteps: 6,
    });

    const { runId } = await rt.run({ sessionKey: `task:${parentId}`, message: "派活" });
    const result = await rt.waitForRun({ runId, timeoutMs: 5000 });
    assert.equal(result.status, "ok", String(result.error ?? ""));

    // 子任务真的建出来了：父子关系落在账本里，状态是 done
    const children = f.db.db.prepare("SELECT id, state, intent, parent_id FROM tasks WHERE parent_id = ?").all(parentId) as Array<{
      id: string; state: string; intent: string; parent_id: string;
    }>;
    assert.equal(children.length, 1, "应该正好派了一个子任务");
    assert.equal(children[0]?.state, "done");
    assert.match(String(children[0]?.intent), /out\.txt/);
    assert.equal(children[0]?.parent_id, parentId);

    // 子任务的步骤记在它自己名下，不混进父任务
    assert.equal(listSteps(f.db.db, children[0]!.id).length, 1, "子工人那一步记在子任务上");
    assert.equal(handCalls.length, 1, "子工人真的调了手");
    assert.equal(handCalls[0]?.path, "out.txt");

    // 父任务那边有一条 delegate 步骤（审计能看见派了谁）
    const parentSteps = listSteps(f.db.db, parentId);
    assert.equal(parentSteps.length, 1);
    assert.equal(parentSteps[0]?.tool, "delegate");

    // 父工人拿到了子任务的结论（喂回模型的正文里有）
    assert.ok(seen.length >= 4, `父+子一共至少要问 4 次模型，实际 ${seen.length}`);
  } finally {
    f.cleanup();
  }
});

test("delegate：子工人手里没有 delegate（只到一层）", async () => {
  const f = fixture();
  try {
    const parentId = createTask(f.db.db, { intent: "派活" });
    const { complete, seen } = scripted([
      { text: "", toolCalls: [{ id: "p1", name: "delegate", arguments: JSON.stringify({ brief: "再派一个" }) }] },
      // 子工人想再派：工具表里没有 delegate，只能收工
      { text: "我不能再派子任务，收工", toolCalls: [] },
      { text: "好", toolCalls: [] },
    ]);
    const rt = createLocalWorkerRuntime({
      db: f.db.db,
      config: f.config,
      complete,
      handDeps: { judge: ALLOW_JUDGE },
      extraHands: [],
      maxSteps: 4,
    });
    const { runId } = await rt.run({ sessionKey: `task:${parentId}`, message: "派活" });
    await rt.waitForRun({ runId, timeoutMs: 5000 });
    const childNames = (seen[1]?.tools as Array<{ function: { name: string } }> | undefined)?.map((t) => t.function.name) ?? [];
    assert.deepEqual(childNames, ["practice"], "子工人的工具表里不该有 delegate");
  } finally {
    f.cleanup();
  }
});
