/**
 * index.test.ts —— 插件入口的装载验收（不连真 allbot，用一个假 api）。
 *
 * 验的是「接线对不对」而不是网关行为：
 * - A.7 两条启动断言在开账本之前拦人（断言不过就不建账本文件、不写心跳）；
 * - 配置：文件打底、plugins.entries.dot-core.config（api.pluginConfig）覆盖；
 * - 心跳文件真的写出来（keeper 的 fail-closed 判据，build/tools/keeper.ps1:24-28）；
 * - 注册了哪些东西：练习工具、四个钩子（内置工具 before/after、锚点、gateway_start）、桥路由；
 * - gateway_start 真的跑完整性校验 + recover（孤儿步改成 interrupted）；
 * - 从身份钩子到工具 execute 的整条链路确实通；
 * - 清单版本与 package.json 一致。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin, { PLUGIN_ID, PLUGIN_VERSION, registerDotCore } from "./index.ts";
import { StartupAssertionError } from "./src/config.ts";
import { BRIDGE_ROUTE_BASE } from "./src/bridge/index.ts";
import { beginStep, createTask, endStep, listSteps, putArtifact, type LedgerDb } from "./src/ledger/index.ts";
import type { AgentToolLike, PluginApiLike, PluginLoggerLike } from "./src/plugin-api.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

interface Harness {
  api: PluginApiLike;
  tools: AgentToolLike[];
  /** 每件工具注册时带的 opts（按 tools 的下标对齐）。optional 的语义见 index.ts 的注释。 */
  toolOpts: Array<{ optional?: boolean }>;
  hooks: Array<{ events: string | string[]; handler: (event: unknown, ctx: unknown) => unknown; opts?: unknown }>;
  routes: Array<{ path: string; match?: string; auth?: string }>;
  logs: string[];
  dir: string;
  dotDir: string;
  stop: (() => void) | null;
  db: LedgerDb | null;
  cleanup: () => void;
}

function makeHarness(allbotConfig: unknown = {}, pluginConfig?: unknown): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dot-core-entry-"));
  const dotDir = join(dir, ".allbot", "dot");
  const tools: AgentToolLike[] = [];
  const toolOpts: Array<{ optional?: boolean }> = [];
  const hooks: Harness["hooks"] = [];
  const routes: Harness["routes"] = [];
  const logs: string[] = [];

  const logger: PluginLoggerLike = {
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    error: (m: string) => logs.push(`error:${m}`),
  };

  const api: PluginApiLike = {
    id: PLUGIN_ID,
    config: allbotConfig,
    pluginConfig: pluginConfig as Record<string, unknown> | undefined,
    logger,
    registerTool: (tool, opts) => {
      tools.push(tool);
      toolOpts.push(opts ?? {});
    },
    registerHook: (events, handler, opts) => hooks.push({ events, handler, opts }),
    registerHttpRoute: (params) => routes.push({ path: params.path, match: params.match, auth: params.auth }),
  };

  const harness: Harness = {
    api,
    tools,
    toolOpts,
    hooks,
    routes,
    logs,
    dir,
    dotDir,
    stop: null,
    db: null,
    cleanup: () => {
      try {
        harness.stop?.();
      } catch {
        // 已经停了就算了
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return harness;
}

function hookFor(h: Harness, name: string) {
  const found = h.hooks.find((x) => (Array.isArray(x.events) ? x.events : [x.events]).includes(name));
  assert.ok(found !== undefined, `没注册 ${name} 钩子`);
  return found as { handler: (event: unknown, ctx: unknown) => unknown };
}

const BASE_ALLBOT = { tasks: { enabled: false }, agents: { defaults: { compaction: { mode: "safeguard" } } } };

function writeDotConfig(h: Harness, value: unknown): void {
  mkdirSync(h.dotDir, { recursive: true });
  writeFileSync(join(h.dotDir, "config.json"), JSON.stringify(value), "utf8");
}

test("装载：断言 → 配置 → 账本迁移 → 心跳 → 注册工具/钩子/路由", () => {
  const h = makeHarness(BASE_ALLBOT);
  try {
    const practiceRoot = join(h.dir, "练习");
    mkdirSync(practiceRoot, { recursive: true });
    writeDotConfig(h, { practice: { root: practiceRoot } });

    const handle = registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 });
    h.db = handle.db;
    h.stop = handle.stop;

    assert.equal(handle.config.practice.root, practiceRoot);
    assert.deepEqual(handle.checks.map((c) => c.id), ["tasks_disabled", "compaction_safeguard"]);
    assert.ok(existsSync(join(h.dotDir, "ledger", "dot.db")));

    // 心跳：keeper 只认这个文件与 600 秒 mtime
    const hbPath = join(h.dotDir, "state", "dot-core.heartbeat");
    assert.ok(existsSync(hbPath), "心跳文件必须写出来");
    const hb = JSON.parse(readFileSync(hbPath, "utf8")) as Record<string, unknown>;
    assert.equal(typeof hb["pid"], "number");
    assert.equal(hb["version"], PLUGIN_VERSION);
    assert.equal(typeof hb["at"], "string");

    // paths.configPath 是 allbot.json，不是 dot 的 config.json（src/bridge/paths.ts 的口径）
    assert.equal(handle.paths.configPath, join(h.dir, ".allbot", "allbot.json"));

    // 抓手的有七个：练习手 + 工作区文件手 + 电脑手 + 已登录/干净两种浏览器手 + 微信手 + 按编号取回。
    // optional 的语义是「没进 tools.allow 就不给模型」（C:/allbot-public/src/plugins/tools.ts:146-154），
    // 所以给宿主 agent 用的 practice / dot_recall 必须 optional:false，其余五只只给本机工人用。
    assert.deepEqual(
      h.tools.map((t) => t.name).sort(),
      ["clean_browser", "desktop", "dot_recall", "files", "logged_browser", "practice", "wechat"],
    );
    const optionalOf = (name: string): boolean | undefined => {
      const idx = h.tools.findIndex((t) => t.name === name);
      assert.ok(idx >= 0, `没注册 ${name}`);
      return h.toolOpts[idx]?.optional;
    };
    assert.equal(optionalOf("practice"), false, "practice 要默认可见（以前就是 optional:false）");
    assert.equal(optionalOf("dot_recall"), false, "dot_recall 也要默认可见，否则模型看不到它");
    for (const name of ["files", "desktop", "logged_browser", "clean_browser", "wechat"]) {
      assert.equal(optionalOf(name), true, `${name} 只给本机工人用，保持 optional`);
    }
    const practiceTool = h.tools.find((t) => t.name === "practice");
    assert.ok(practiceTool, "练习手必须在");
    assert.ok((practiceTool?.parameters as { properties?: Record<string, unknown> }).properties?.["action"] !== undefined);
    for (const name of ["files", "desktop", "logged_browser", "clean_browser", "wechat"]) {
      const tool = h.tools.find((t) => t.name === name);
      assert.ok(tool, `${name} 要注册成工具`);
      assert.ok((tool?.parameters as { properties?: Record<string, unknown> }).properties?.["action"] !== undefined);
    }
    const recallTool = h.tools.find((t) => t.name === "dot_recall");
    assert.ok(recallTool, "dot_recall 要注册成工具");
    const recallProps = (recallTool?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(recallProps["ref"] !== undefined && recallProps["step_id"] !== undefined && recallProps["artifact"] !== undefined);

    const hookNames = h.hooks.flatMap((x) => (Array.isArray(x.events) ? x.events : [x.events]));
    for (const name of ["before_tool_call", "after_tool_call", "before_prompt_build", "gateway_start"]) {
      assert.ok(hookNames.includes(name), `缺 ${name}`);
    }

    assert.equal(h.routes[0]?.path, BRIDGE_ROUTE_BASE);
    assert.equal(h.routes[0]?.match, "prefix");
    assert.equal(h.routes[0]?.auth, "gateway");

    assert.ok(h.logs.some((l) => l.includes("启动断言通过：tasks_disabled")));
    assert.ok(h.logs.some((l) => l.includes("已注册内置工具钩子")));
  } finally {
    h.cleanup();
  }
});

test("配置：plugins.entries.dot-core.config 覆盖文件，未写的键保持文件里的值", () => {
  const h = makeHarness(BASE_ALLBOT, {
    practice: { root: "C:/从-pluginConfig-来" },
    budget: { tokens: 123456 },
  });
  try {
    writeDotConfig(h, { practice: { root: "C:/从文件来" }, approvals: { ttl_hours: 12 } });
    const handle = registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 });
    h.db = handle.db;
    h.stop = handle.stop;

    assert.equal(handle.config.practice.root, "C:/从-pluginConfig-来");
    assert.equal(handle.config.budget.tokens, 123456);
    assert.equal(handle.config.approvals.ttl_hours, 12, "pluginConfig 没写的键不能被缺省值盖掉");
    assert.ok(h.logs.some((l) => l.includes("已叠加 plugins.entries.dot-core.config")));
  } finally {
    h.cleanup();
  }
});

test("整条链路：身份钩子 → 工具 execute → 会计账 → 文件真写出来", async () => {
  const h = makeHarness(BASE_ALLBOT);
  try {
    const practiceRoot = join(h.dir, "练习");
    mkdirSync(practiceRoot, { recursive: true });
    writeDotConfig(h, { practice: { root: practiceRoot } });

    const handle = registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 });
    h.db = handle.db;
    h.stop = handle.stop;
    const taskId = createTask(handle.db, { intent: "从入口跑一遍练习", source: "test", declared: {} }).id;
    const tool = h.tools[0];
    assert.ok(tool !== undefined);

    hookFor(h, "before_tool_call").handler(
      { toolName: "practice", params: { action: "write" }, toolCallId: "call-entry-1" },
      { sessionKey: `task:${taskId}`, agentId: "agent-1", runId: "run-1" },
    );

    const result = await tool.execute("call-entry-1", {
      action: "write",
      path: "入口测试.txt",
      content: "从 index.ts 这条线写进来的",
    });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(existsSync(join(practiceRoot, "入口测试.txt")), true);
    assert.equal(readFileSync(join(practiceRoot, "入口测试.txt"), "utf8"), "从 index.ts 这条线写进来的");

    const steps = listSteps(handle.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.status, "succeeded");

    const injected = hookFor(h, "before_prompt_build").handler(
      { prompt: "下一步做什么", messages: [] },
      { sessionKey: `task:${taskId}` },
    ) as { prependSystemContext?: string } | undefined;
    assert.ok(injected?.prependSystemContext?.includes(taskId));
  } finally {
    h.cleanup();
  }
});

test("dot_recall：身份钩子 → 按明细哈希取回全文；没有身份时给可读说明", async () => {
  const h = makeHarness(BASE_ALLBOT);
  try {
    const practiceRoot = join(h.dir, "练习");
    mkdirSync(practiceRoot, { recursive: true });
    writeDotConfig(h, { practice: { root: practiceRoot } });

    const handle = registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 });
    h.db = handle.db;
    h.stop = handle.stop;
    const taskId = createTask(handle.db, { intent: "取回明细", source: "test", declared: {} }).id;
    // 明细要挂在这个任务的某一步上才算「它的」（src/context/recall.ts 的归属检查）。
    const step = beginStep(handle.db, {
      task_id: taskId,
      run_epoch: 0,
      kind: "tool",
      tool: "practice",
      subject_key: "k-recall-entry",
      side_effect: "safe",
      tier: 1,
    });
    const meta = putArtifact(handle.db, "那一步的完整输出：建了三个文件夹");
    endStep(handle.db, step.id, { status: "succeeded", result_ref: meta.hash });
    const tool = h.tools.find((t) => t.name === "dot_recall");
    assert.ok(tool !== undefined);

    // 没有身份、没传 task_id：拒绝并说明，不猜任务、不跨任务取。
    const noIdentity = await tool.execute("call-recall-x", { artifact: meta.hash });
    assert.equal(noIdentity.isError, true);
    assert.ok((noIdentity.content[0]?.text ?? "").includes("不知道这是哪个任务"));

    hookFor(h, "before_tool_call").handler(
      { toolName: "dot_recall", params: {}, toolCallId: "call-recall-1" },
      { sessionKey: `task:${taskId}`, agentId: "agent-1" },
    );
    const got = await tool.execute("call-recall-1", { artifact: meta.hash });
    assert.equal(got.isError, false, JSON.stringify(got.content));
    assert.ok((got.content[0]?.text ?? "").includes("建了三个文件夹"));
  } finally {
    h.cleanup();
  }
});

test("gateway_start：完整性校验 + recover，孤儿步改成 interrupted", () => {  const h = makeHarness(BASE_ALLBOT);
  try {
    const practiceRoot = join(h.dir, "练习");
    mkdirSync(practiceRoot, { recursive: true });
    writeDotConfig(h, { practice: { root: practiceRoot } });

    const handle = registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 });
    h.db = handle.db;
    h.stop = handle.stop;

    const taskId = createTask(handle.db, { intent: "断电演练", source: "test", declared: {} }).id;
    handle.db.prepare("UPDATE tasks SET state = 'running' WHERE id = ?").run(taskId);
    beginStep(handle.db, {
      task_id: taskId,
      run_epoch: 0,
      kind: "tool",
      tool: "read",
      subject_key: "k1",
      side_effect: "replayable",
      tier: 1,
    });

    hookFor(h, "gateway_start").handler({ port: 18789 }, {});

    const [step] = listSteps(handle.db, taskId);
    assert.equal(step?.status, "interrupted", "started 未结束的步要由恢复协议收掉");
    assert.ok(h.logs.some((l) => l.includes("恢复协议：")));
  } finally {
    h.cleanup();
  }
});

test("某一件工具注册抛错：插件照样加载，钩子与桥路由都在", () => {
  const h = makeHarness(BASE_ALLBOT);
  try {
    const practiceRoot = join(h.dir, "练习");
    mkdirSync(practiceRoot, { recursive: true });
    writeDotConfig(h, { practice: { root: practiceRoot } });

    // 模拟「宿主这次不让注册工具」：六件工具全挂，但插件本身不能跟着掉线。
    h.api.registerTool = () => {
      throw new Error("宿主这次不让注册工具");
    };
    const handle = registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 });
    h.db = handle.db;
    h.stop = handle.stop;

    assert.ok(existsSync(join(h.dotDir, "ledger", "dot.db")), "账本还是要开起来");
    assert.equal(h.tools.length, 0);
    assert.ok(h.logs.some((l) => l.includes("注册失败")), "每件工具各记一条 warn");
    const hookNames = h.hooks.flatMap((x) => (Array.isArray(x.events) ? x.events : [x.events]));
    for (const name of ["before_tool_call", "after_tool_call", "before_prompt_build", "gateway_start"]) {
      assert.ok(hookNames.includes(name), `缺 ${name}`);
    }
    assert.equal(h.routes[0]?.path, BRIDGE_ROUTE_BASE, "桥路由照挂");
  } finally {
    h.cleanup();
  }
});

test("A.7 断言不过：抛错且不创建账本文件、不写心跳", () => {
  const h = makeHarness({ tasks: { enabled: true } });
  try {
    assert.throws(
      () => registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 }),
      (err: unknown) => err instanceof StartupAssertionError,
    );
    assert.equal(existsSync(join(h.dotDir, "ledger", "dot.db")), false);
    assert.equal(existsSync(join(h.dotDir, "state", "dot-core.heartbeat")), false, "断言不过不写心跳");
    assert.equal(h.tools.length, 0);
  } finally {
    h.cleanup();
  }
});

test("A.7 断言不过：compaction 不是 safeguard 也拦", () => {
  const h = makeHarness({ agents: { defaults: { compaction: { mode: "default" } } } });
  try {
    assert.throws(
      () => registerDotCore(h.api, { home: h.dir, dotDir: h.dotDir, heartbeatIntervalMs: 0 }),
      (err: unknown) => err instanceof StartupAssertionError && (err as StartupAssertionError).checks.includes("compaction_safeguard"),
    );
    assert.equal(existsSync(join(h.dotDir, "ledger", "dot.db")), false);
  } finally {
    h.cleanup();
  }
});

test("清单与 package.json 的 id/版本对得上，默认导出可被 allbot 直接调", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as {
    name: string;
    version: string;
    main: string;
    allbot?: { extensions?: string[] };
  };
  assert.equal(pkg.name, "dot-core");
  assert.equal(pkg.main, "./index.ts");
  assert.deepEqual(pkg.allbot?.extensions, ["./index.ts"]);
  assert.equal(pkg.version, PLUGIN_VERSION);
  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(plugin.version, PLUGIN_VERSION);
  assert.equal(typeof plugin.register, "function");
  assert.equal((plugin.configSchema as { type?: string }).type, "object");
});
