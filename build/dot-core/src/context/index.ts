/**
 * src/context/index.ts —— 上下文注入点（A.10 第一类：锚点）。
 *
 * 注入点只有 `before_prompt_build`（types.ts:2425-2437，本轮亲读：可返回
 * prependSystemContext / prependContext / appendSystemContext），**每轮都跑**。
 * 压缩后下一次组提示词自然会再注一遍，所以锚点不需要跟着压缩事件做事。
 *
 * 三条纪律（都写成本条代码里的事实，不是提示词）：
 * 1. 只管工人会话：A.8 约定工人 `sessionKey = task:<task_id>`，其它会话（脸、子助手）
 *    一律不注，避免把任务锚点漏进不相干的对话。
 * 2. 注入永不打断对话：账本读失败、任务号坏掉都只记一条日志然后返回 undefined。
 *    上下文是「锦上添花」，不能因为一个坏任务号让整轮对话起不来。
 * 3. 正文只从账本拼（src/context/anchor.ts），这里不读聊天记录、不读 ds-bot 记忆。
 */

import type { PluginApiLike } from "../plugin-api.ts";
import type { LedgerDb } from "../ledger/index.ts";
import { buildAnchor } from "./anchor.ts";
import { taskIdFromSessionKey } from "../hands/identity.ts";

export interface ContextDeps {
  db: LedgerDb;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  /** 测试注入；默认 buildAnchor。 */
  build?: (taskId: string) => string | null;
}

export interface ContextHookResult {
  prependSystemContext?: string;
}

/**
 * 造钩子本体。返回的函数就是 registerHook("before_prompt_build", fn) 的那个 fn。
 * 单独导出是为了能直接单测，不必造一个假 api。
 */
export function createAnchorHook(deps: ContextDeps): (event: unknown, ctx: unknown) => ContextHookResult | undefined {
  const log = deps.logger ?? (() => {});
  const build = deps.build ?? ((taskId: string) => buildAnchor({ db: deps.db, taskId }));

  return (event: unknown, ctx: unknown): ContextHookResult | undefined => {
    const sessionKey = typeof (ctx as { sessionKey?: unknown } | null)?.sessionKey === "string"
      ? ((ctx as { sessionKey: string }).sessionKey)
      : undefined;
    const taskId = taskIdFromSessionKey(sessionKey);
    if (taskId === null) return undefined;

    try {
      const anchor = build(taskId);
      if (anchor === null || anchor.trim() === "") {
        log("warn", `锚点任务不存在：${taskId}（本轮不注入）`);
        return undefined;
      }
      return { prependSystemContext: anchor };
    } catch (err) {
      log("error", `锚点注入失败（${taskId}）：${(err as Error).message}`);
      return undefined;
    }
  };
}

/**
 * 注册到 allbot。钩子名与 types.ts:3058 对齐。
 *
 * 走 `api.on`（类型化钩子）：`api.registerHook` 登记的内部钩子会在网关启动时被
 * `clearInternalHooks()` 清掉，锚点就永远注不进去（2026-11-25 真机实测）。
 */
export function registerAnchorHook(api: PluginApiLike, deps: ContextDeps): void {
  const hook = createAnchorHook(deps) as (event: unknown, ctx: unknown) => unknown;
  if (typeof api.on === "function") {
    api.on("before_prompt_build", hook);
    return;
  }
  api.registerHook("before_prompt_build", hook, { name: "dot-core.context.anchor" });
}

export { buildAnchor, workspaceFromDeclared, ANCHOR_TEXT_LIMIT, type AnchorInput } from "./anchor.ts";

/*
 * A.10 的另外两类上下文（原来只写了模块、没接出来，于是谁都用不上）：
 *   - 阶段小结：buildInjection 把「锚点 + 已结束里程碑的小结」拼成一轮要注的正文，
 *     工人系统提示词用它（src/dispatch/local-worker.ts），所以小结真会进提示词；
 *     summarizeMilestone 由派发器在里程碑收尾时调（src/dispatch/after-settle.ts）。
 *   - 按编号取回：dot_recall 工具（recall-tool.ts），注册成插件工具并进工人的工具表。
 */
export {
  buildInjection,
  INJECTION_TEXT_LIMIT,
  SUMMARY_MAX_COUNT,
  type BuildInjectionInput,
  type InjectionBudget,
  type InjectionParts,
  type InjectionResult,
} from "./inject.ts";
export {
  summarizeMilestone,
  buildSummaryPrompt,
  STAGE_SUMMARY_LIMIT,
  RESULT_PREVIEW_CHARS,
  type StageSummaryDeps,
  type SummarizeMilestoneInput,
  type StageSummaryResult,
} from "./stage-summary.ts";
export { recall, RECALL_TEXT_LIMIT, type RecallInput, type RecallQuery, type RecallResult, type RecallKind, type RecallSource } from "./recall.ts";
export {
  RECALL_TOOL_NAME,
  RECALL_TOOL_DEFINITION,
  RECALL_TIER,
  recallGateInput,
  executeRecallTool,
  createRecallPluginTool,
} from "./recall-tool.ts";
