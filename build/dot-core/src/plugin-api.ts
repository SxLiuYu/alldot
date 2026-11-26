/**
 * src/plugin-api.ts —— 本插件用到的 allbot 插件 API 的**结构类型切片**。
 *
 * 为什么不 `import type { AllBotPluginApi } from "allbot/plugin-sdk"`：
 * build/dot-core 没有 node_modules（交付形态是 jiti 直载 + `tsc --noEmit`，见 B.4），
 * 这个目录里能解析的只有 node: 内置模块和相对路径。写一份结构声明，好处是
 * - `tsc --noEmit` 能在这份目录里独立跑通，不需要构建管线；
 * - 运行时由 allbot 传入真实对象，结构对得上就能用（鸭子类型）。
 *
 * 字段来源（本轮亲读）：
 *   allbot-src/src/plugins/types.ts:2141-2210  —— AllBotPluginApi 的 registerTool/registerHook/registerHttpRoute
 *   allbot-src/src/plugins/types.ts:2425-2437  —— before_prompt_build 的返回值
 *   allbot-src/src/plugins/types.ts:2720-2727  —— before_tool_call 的事件字段
 *   allbot-src/src/agents/tools/common.ts:12-22 —— 工具对象 = { name, description, parameters, execute }
 *   allbot-src/docs/plugins/building-plugins.md:228-252 —— 注册工具的最小写法
 *
 * 这里只声明「我们真的会用」的部分。多声明就等于给自己加了一个不准的契约。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface PluginLoggerLike {
  info?: (message: string, ...rest: unknown[]) => void;
  warn?: (message: string, ...rest: unknown[]) => void;
  error?: (message: string, ...rest: unknown[]) => void;
  debug?: (message: string, ...rest: unknown[]) => void;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResultLike {
  content: ToolTextContent[];
  /** 结构化的附加信息；allbot 会透传给模型日志，不参与提示词。 */
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** AgentTool 的最小面：docs/plugins/building-plugins.md:231-238 里的形状。 */
export interface AgentToolLike {
  name: string;
  description: string;
  /** typebox/JSON Schema 对象。我们交纯 JSON Schema（见 src/hands/tool.ts 的说明）。 */
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResultLike>;
}

export interface AgentContextLike {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  modelId?: string;
  modelProviderId?: string;
  trigger?: string;
}

export interface BeforePromptBuildEventLike {
  prompt: string;
  messages: unknown[];
}

export interface BeforePromptBuildResultLike {
  prependSystemContext?: string;
  prependContext?: string;
}

export interface BeforeToolCallEventLike {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface ToolContextLike extends AgentContextLike {}

export type HookHandler = (
  event: never,
  ctx: never,
) => unknown;

export interface HttpRouteParamsLike {
  path: string;
  match?: "exact" | "prefix";
  auth?: "gateway" | "plugin";
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean | void;
}

/** registerBridgeRoutes 需要的那个 RouteApi（src/bridge/routes.ts:77-85）结构一致。 */
export interface RouteApiLike {
  registerHttpRoute(params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }): void;
}

/**
 * `api.runtime.subagent` 的最小面（派发器用）。
 *
 * 来源（亲读）：allbot-src/src/plugins/runtime/types.ts:8-21、:55-57（参数与返回），
 * allbot-src/src/gateway/server-plugins.ts:308-367（run / waitForRun 实现）。
 * 它等价于 WS `agent` 方法：进程内合成一个 operator 客户端再走同一个处理器，
 * 所以插件不需要自己连 WS 或 HTTP。只在 gateway_start 之后可用（兜底上下文
 * 在 server.impl.ts:3073 装好，早于 :3165 触发钩子）。
 *
 * 只声明我们会传的 5 个字段：schema 的 additionalProperties=false
 * （allbot-src/src/gateway/protocol/schema/agent.ts:116），多传会被拒。
 */
export interface SubagentRunParamsLike {
  sessionKey?: string;
  message: string;
  extraSystemPrompt?: string;
  idempotencyKey?: string;
  deliver?: boolean;
}

export interface SubagentRunResultLike {
  runId: string;
}

export interface SubagentWaitResultLike {
  /** timeout 有两种含义：等超时 / 运行被中止，调用方要自己再查一次（agent-job.ts:89-92）。 */
  status: "ok" | "error" | "timeout";
  error?: string;
}

export interface SubagentRuntimeLike {
  run(params: SubagentRunParamsLike): Promise<SubagentRunResultLike>;
  waitForRun(params: { runId: string; timeoutMs?: number }): Promise<SubagentWaitResultLike>;
}

export interface PluginRuntimeLike {
  subagent?: SubagentRuntimeLike;
}

export interface PluginApiLike {
  id: string;
  config?: unknown;
  pluginConfig?: Record<string, unknown>;
  rootDir?: string;
  logger?: PluginLoggerLike;
  /**
   * 进程内运行时。`register()` 阶段就在对象上，但派发要等 gateway_start
   * （早调会吃到 server-plugins.ts:261-263 那条「没有请求作用域」的报错）。
   */
  runtime?: PluginRuntimeLike;
  registerTool: (tool: AgentToolLike, opts?: { optional?: boolean; name?: string }) => void;
  /**
   * 旧钩子系统。**2026-11-25 真机实测：这条在真网关上收不到事件。**
   *
   * 原因：allbot 启动时会先 `clearInternalHooks()`（allbot-src/src/gateway/server-startup.ts:143）
   * 把插件在注册期登记的内部钩子全清掉，再只装载它自己配置里的那几条。插件在
   * `register()` 里登记的 gateway_start / before_tool_call / before_prompt_build
   * 一律被清空——日志里那两条 handler 的话一次都没出现，账本里 queued 任务两分钟没被领走。
   *
   * 所以这里保留它只为了兼容老版本；新代码一律用下面的 `on`。
   */
  registerHook: (
    events: string | string[],
    handler: (event: unknown, ctx: AgentContextLike) => unknown,
    opts?: Record<string, unknown>,
  ) => void;
  /**
   * 正式的类型化钩子通道：写进 `registry.typedHooks`（allbot-src/src/plugins/registry.ts:956），
   * 全局 hook runner 直接从那儿取（src/plugins/hooks.ts:190、:1096），不经过被清空的内部钩子系统。
   * 来源：allbot-src/src/plugins/types.ts:2277、api-builder.ts:173。
   *
   * 事件名与旧系统同名（gateway_start / gateway_stop / before_tool_call / after_tool_call /
   * before_prompt_build / before_compaction / after_compaction …）。
   */
  on?: (
    hookName: string,
    handler: (event: unknown, ctx: AgentContextLike) => unknown,
    opts?: { priority?: number },
  ) => void;
  registerHttpRoute: (params: HttpRouteParamsLike) => void;
}

/**
 * 注册一个钩子：优先走 `api.on`（类型化钩子，真网关上真的会到），
 * 没有 `on` 的老版本才退回 `api.registerHook`。
 *
 * 全仓库的钩子都必须经过这里——直接调 `api.registerHook` 等于写一段永远不会执行的代码。
 * 返回实际用了哪条通道，调用方把它写进日志，出问题时一眼能看出来。
 */
export function registerHookCompat(
  api: PluginApiLike,
  hookName: string,
  handler: (event: unknown, ctx: AgentContextLike) => unknown,
  name: string,
): "typed" | "legacy" {
  if (typeof api.on === "function") {
    api.on(hookName, handler);
    return "typed";
  }
  api.registerHook(hookName, handler, { name });
  return "legacy";
}

/** 插件入口的默认导出形状（AllBotPluginModule 的对象形式）。 */
export interface PluginDefinitionLike {
  id: string;
  name: string;
  version?: string;
  description?: string;
  configSchema?: Record<string, unknown>;
  register: (api: PluginApiLike) => void | Promise<void>;
}
