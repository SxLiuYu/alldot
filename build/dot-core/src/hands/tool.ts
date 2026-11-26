/**
 * src/hands/tool.ts —— 把最小那只手包成 allbot 认识的插件工具。
 *
 * 形状照 docs/plugins/building-plugins.md:228-252（name / description / parameters /
 * execute 四件套）。参数用**扁平的 JSON Schema**，动作枚举不用 anyOf（同文档
 * 123-144：小模型解析顶层 anyOf 不稳）。这里没 import typebox：build/dot-core 没有
 * node_modules（B.4 直载 TypeScript），交纯 JSON Schema，运行时 allbot 只把它当对象用。
 *
 * 为什么是插件工具而不是 `mcp.servers`（A.4 主路）：插件工具走同一条包装线，
 * 钩子能拿到 agentId/sessionKey/runId，且模型只看得见这一个工具，看不见底层全集。
 */

import type { AgentToolLike, ToolResultLike } from "../plugin-api.ts";
import { PRACTICE_TOOL_NAME, runPracticeHand, type HandDeps } from "./hand.ts";

export const PRACTICE_TOOL_DESCRIPTION = [
  "在练习文件夹里做四件事：list 列目录、read 读文件内容、mkdir 建文件夹、write 写 utf8 文本文件。",
  "只在练习文件夹内，越界、绝对路径、符号链接一律拒绝；write 默认不覆盖，要覆盖传 overwrite=true。",
  "任务归属只认会话（工人会话 sessionKey=task:<任务号>）；task_id 参数只在没有会话身份的直接调用里使用，传了必须与会话一致，不一致直接拒绝。",
].join("");

/** 扁平参数表：action 必填，其余按动作取用，字段全可选（不给顶层 anyOf）。 */
export const PRACTICE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["list", "read", "mkdir", "write"],
      description: "list=列目录，read=读文件内容，mkdir=建文件夹，write=写文本文件",
    },
    task_id: { type: "string", description: "任务号（账本里 tasks.id）；仅直接调用用，工人会话里由 sessionKey 决定，传了必须一致" },
    path: {
      type: "string",
      description: "相对练习文件夹的路径；list 省略表示根目录，read/mkdir/write 必填",
    },
    content: { type: "string", description: "write 的内容（utf8 文本，≤256 KiB）" },
    overwrite: { type: "boolean", description: "write 时是否允许覆盖已有文件，默认 false" },
  },
} as const;

export interface PracticeToolDeps extends HandDeps {
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

function asParams(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 造工具对象。execute 里只做「翻译 + 交给 hand.ts」，不自己判档、不自己记账。 */
export function createPracticeTool(deps: PracticeToolDeps): AgentToolLike {
  return {
    name: PRACTICE_TOOL_NAME,
    description: PRACTICE_TOOL_DESCRIPTION,
    parameters: PRACTICE_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    async execute(toolCallId: string, rawParams: Record<string, unknown>): Promise<ToolResultLike> {
      const params = asParams(rawParams);
      const outcome = await runPracticeHand(deps, {
        toolCallId,
        taskId: typeof params["task_id"] === "string" ? params["task_id"] : undefined,
        action: typeof params["action"] === "string" ? params["action"] : undefined,
        path: typeof params["path"] === "string" ? params["path"] : undefined,
        content: typeof params["content"] === "string" ? params["content"] : undefined,
        overwrite: params["overwrite"] === true,
      });

      return {
        content: [{ type: "text", text: outcome.text }],
        isError: !outcome.ok,
        details: {
          code: outcome.code,
          task_id: outcome.taskId,
          step_id: outcome.stepId,
          approval_id: outcome.approvalId,
          tier: outcome.tier,
          rule: outcome.rule,
          side_effect: outcome.sideEffect,
          result_ref: outcome.resultRef,
        },
      };
    },
  };
}
