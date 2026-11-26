/**
 * src/context/recall-tool.ts —— 把 recall.ts 包成模型可调用的 `dot_recall` 工具，
 * 并给出它的闸门入参（这件工具只读账本，落 1 档直接放行）。
 *
 * 这里只描述「工具长什么样、参数怎么收、闸门怎么判」，真正的取回逻辑在 recall.ts。
 *
 * 两条调用路径，行为别混：
 *   1. 插件工具（createRecallPluginTool）：宿主 agent 调它时，before_tool_call 的内置治理钩子
 *      会用 gateInputFor → recallGateInput 判档（action=read → judge 第 10 条 → tier 1 放行），
 *      并按 1 档记账（写 steps）。
 *   2. 本机工人（src/dispatch/local-worker.ts）：工人自己带模型循环，不经过宿主钩子，
 *      直接 executeRecallTool。理由是它只读账本、没有副作用；这条路径不落步骤。
 */

import type { LedgerDb } from "../ledger/index.ts";
import { recall, type RecallResult } from "./recall.ts";
import type { AgentToolLike, ToolResultLike } from "../plugin-api.ts";
import { taskIdFromSessionKey, type IdentityTable } from "../hands/identity.ts";

export const RECALL_TOOL_NAME = "dot_recall";

/**
 * 这件工具在闸门里的档位：只读账本、没有副作用，1 档放行。
 * 判档靠 recallGateInput 给出的 action=read（gate/judge.ts 第 10 条），
 * 不是靠 gate/policy.ts 的 READ_TOOLS 名单——那张表只被 classifySideEffect 用。
 */
export const RECALL_TIER = 1;

/** 工具的静态描述（给模型看的名字、说明、参数 schema）。 */
export const RECALL_TOOL_DEFINITION = {
  name: RECALL_TOOL_NAME,
  description:
    "按编号取回账本里存的临时细节：某一步的结果明细（artifacts 哈希），或一条快照的说明。只读账本，不改任何东西。",
  parameters: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        description: "编号：快照 id（snap_…）或明细哈希。适合锚点/步骤里直接看到的编号。",
      },
      step_id: {
        type: "string",
        description: "步骤 id（step_…）：取那一步的结果明细。",
      },
      artifact: {
        type: "string",
        description: "明细哈希：直接按内容哈希取全文。",
      },
      task_id: {
        type: "string",
        description: "任务号；仅没有会话身份的直接调用用，工人会话里由 sessionKey 决定",
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * 闸门入参。`tool=dot_recall / action=read` 让 judge 落「只读 → 1 档」
 * （gate/judge.ts 第 10 条：labelText 把 action 一起拼进去，READ 词表命中 "read"），
 * 于是 tier=1、side_effect=safe、handling=allow。
 *
 * 必须带 action：只给工具名的话 labels 里只有 "dot_recall"，READ 词表
 * （src/gate/keywords.ts:79）没有 recall，会掉到「判不清 → 4 档」出请示卡。
 * 生产调用点是 src/hands/builtin.ts 的 gateInputFor（tool === RECALL_TOOL_NAME 时走这里）。
 */
export function recallGateInput(args: unknown = {}): { tool: string; action: string; args: unknown } {
  return { tool: RECALL_TOOL_NAME, action: "read", args };
}

function asArgsObject(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function pick(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 执行工具调用。taskId 来自当前工人会话（`task:<id>`），
 * 参数只认 ref / step_id / artifact，多给的键忽略。
 */
export function executeRecallTool(db: LedgerDb, input: { taskId: string; args: unknown }): RecallResult {
  const args = asArgsObject(input.args);
  return recall(db, {
    taskId: input.taskId,
    ref: pick(args, "ref"),
    step_id: pick(args, "step_id"),
    artifact: pick(args, "artifact"),
  });
}

export { recall, RECALL_TEXT_LIMIT, type RecallResult } from "./recall.ts";

/**
 * 注册成插件工具（与 practice / files / desktop / logged_browser / clean_browser 并列）。
 *
 * 任务归属的取法与练习手一致：先看会话身份表（before_tool_call 钩子按 toolCallId
 * 记的 taskId），没有身份表才认参数里的 task_id。两样都没有就回一句可读的话，
 * 不猜任务、不跨任务取。
 */
export function createRecallPluginTool(db: LedgerDb, identity?: IdentityTable): AgentToolLike {
  return {
    name: RECALL_TOOL_NAME,
    description: RECALL_TOOL_DEFINITION.description,
    parameters: RECALL_TOOL_DEFINITION.parameters as unknown as Record<string, unknown>,
    async execute(toolCallId: string, rawParams: Record<string, unknown>): Promise<ToolResultLike> {
      const args = asArgsObject(rawParams);
      const asked = pick(args, "task_id");

      // 先认身份表（钩子按 toolCallId 记的），再认参数。反过来就是越权口子：
      // 2026-11-25 探针实测，A 任务的身份 + 参数里写 B 的 task_id，能读出 B 的私密明细。
      const found = identity?.take(toolCallId) ?? null;
      const fromIdentity = found?.taskId ?? taskIdFromSessionKey(found?.sessionKey) ?? undefined;

      if (fromIdentity !== undefined && fromIdentity !== "" && asked !== undefined && asked !== "" && asked !== fromIdentity) {
        return {
          content: [
            {
              type: "text",
              text: `dot_recall 只认当前会话的任务（${fromIdentity}），参数里的 ${asked} 不取。要读别的任务，请在那个任务的会话里读。`,
            },
          ],
          isError: true,
          details: { code: "identity_conflict", tier: RECALL_TIER, task_id: fromIdentity, asked_task_id: asked },
        };
      }

      const taskId = fromIdentity !== undefined && fromIdentity !== "" ? fromIdentity : asked;
      if (taskId === undefined || taskId === "") {
        return {
          content: [
            {
              type: "text",
              text:
                "dot_recall 不知道这是哪个任务：工人会话里由 sessionKey 决定；直接调用请带上 task_id。",
            },
          ],
          isError: true,
          details: { code: "identity_missing", tier: RECALL_TIER },
        };
      }
      const result = executeRecallTool(db, { taskId, args });
      return {
        content: [{ type: "text", text: result.text }],
        isError: !result.ok,
        details: {
          code: result.ok ? "ok" : "recall_miss",
          task_id: taskId,
          kind: result.kind,
          source: result.source,
          ref: result.ref,
          original_chars: result.originalChars,
          truncated: result.truncated,
          tier: RECALL_TIER,
        },
      };
    },
  };
}
