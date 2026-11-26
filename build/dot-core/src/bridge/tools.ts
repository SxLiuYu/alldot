/**
 * src/bridge/tools.ts —— POST /mcp 暴露的四个工具（B.6、B.1 允许名单）。
 *
 * 名字必须与 B.1 的 DOT_BRAIN 完全一致，否则 ds-bot 的口闸会把它们当「手」拒掉：
 *   brain_task / brain_status / brain_answer / brain_cancel
 *
 * 每个工具都只是转发到大脑，桥自己不判六档、不写账本。
 * 唯一在桥这边拦的是「盘紧停接新任务」（B.7：POST /mcp 进来的新任务直接拒、回复带原因）。
 */

import type { BrainClient } from "./upstream.ts";
import { BrainHttpError, BrainUnavailableError } from "./upstream.ts";
import type { AdmissionDecision, KeepView } from "./keep.ts";
import { diskAdmission } from "./keep.ts";

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeToolContext {
  client: BrainClient;
  tokenConfigured: boolean;
  /** 每次调用时现读 keep.json（盘紧要在下一次调用就生效，不缓存 5 分钟）。 */
  admission: () => AdmissionDecision;
  now: () => Date;
  /** 大脑从什么时候开始掉线的（没有就是 null）。 */
  downSince: () => Date | null;
}

export const BRAIN_TOOL_NAMES = [
  "brain_task",
  "brain_status",
  "brain_answer",
  "brain_cancel",
] as const;

export type BrainToolName = (typeof BRAIN_TOOL_NAMES)[number];

export const BRAIN_TOOLS: ToolDefinition[] = [
  {
    name: "brain_task",
    description:
      "把一件要动手的事交给大脑（dot-core）。这是机器人唯一能把活派出去的入口；" +
      "机器人自己不动手、不调用任何执行工具。参数 intent 用一句人话写清要做什么；" +
      "declared 里写范围/验收标准等机器能读的声明。返回任务号和第一张进度卡。",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "要做什么（一句人话）" },
        restated: { type: "string", description: "你复述的版本（B.8 tasks.restated；让人一眼看出理解对不对）" },
        bot: { type: "string", description: "发起任务的机器人名/号（A.8 的 source_ref.bot）" },
        chat_id: { type: "string", description: "来源聊天号（A.8 的 source_ref.chat）" },
        declared: {
          type: "object",
          description: "声明：范围 paths、验收 done_when、预算等，机器可读",
          additionalProperties: true,
        },
        profile: { type: "string", enum: ["cheap", "balanced", "strong"], description: "模型档" },
        budget_tokens: { type: "integer", minimum: 0, description: "token 预算" },
        parent_task_id: { type: "string", description: "父任务号（子任务时给）" },
        source_ref: { type: "object", description: "来源引用（会话/消息号等）", additionalProperties: true },
      },
      required: ["intent"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_status",
    description:
      "问大脑现在怎么样了。不传 task_id 返回进行中的任务与待批清单；" +
      "传 task_id 返回那个任务的进度卡原文。卡片文字由账本模板渲染，回答时照原样转述，别自己编数字。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务号；不传就看全部进行中的任务" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "brain_answer",
    description:
      "把用户对一张审批卡的答复回传给大脑。approval_id 取自进度卡/请示卡；" +
      "answer 用用户的原话（同意/拒绝/1/2 都认）。同一个批单重复回传不会重复记账。",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: { type: "string", description: "批单号（apv_…）" },
        answer: { type: "string", description: "用户的原话，如「同意」「拒绝」「1」" },
      },
      required: ["approval_id", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_cancel",
    description: "取消一个任务。已经在终态（完成/失败/已取消）的任务不会被改动。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务号" },
        reason: { type: "string", description: "取消原因（会写进账本）" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
];

export function isBrainToolName(name: string): name is BrainToolName {
  return (BRAIN_TOOL_NAMES as readonly string[]).includes(name);
}

class ToolInputError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textResult(text: string, structuredContent?: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`参数 ${key} 必填，且要是非空字符串`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`参数 ${key} 要是字符串`);
  return value.trim() === "" ? undefined : value.trim();
}

function clockOf(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function cardOf(value: unknown): string | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  if (typeof rec.card === "string" && rec.card.trim() !== "") return rec.card;
  if (Array.isArray(rec.cards)) {
    const cards = rec.cards.filter((c): c is string => typeof c === "string" && c.trim() !== "");
    if (cards.length > 0) return cards.join("\n\n");
  }
  return null;
}

function taskIdOf(value: unknown): string | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const task = asRecord(rec.task);
  if (task !== null && typeof task.id === "string") return task.id;
  if (typeof rec.task_id === "string") return rec.task_id;
  if (typeof rec.taskId === "string") return rec.taskId;
  return null;
}

function messageOf(value: unknown): string | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  return typeof rec.message === "string" && rec.message.trim() !== "" ? rec.message : null;
}

function formatFailure(err: unknown, ctx: BridgeToolContext): string {
  if (err instanceof ToolInputError) return `参数不对：${err.message}`;
  if (err instanceof BrainUnavailableError) {
    const since = ctx.downSince();
    const prefix = since === null ? "连不上大脑" : `大脑掉线（${clockOf(since)} 时起）`;
    return `${prefix}：${err.message}。这次没有提交、也没有记账；等大脑起来再试，或让用户看状态页 http://127.0.0.1:8799/`;
  }
  if (err instanceof BrainHttpError) {
    if (err.status === 401 || err.status === 403) {
      return `大脑拒了桥 token（HTTP ${err.status}）：${err.detail}。检查 ~/.allbot/dot/bridge-token 与 dot-core 读的是不是同一份`;
    }
    if (err.status === 409) return `没接：${err.detail}`;
    if (err.status === 404) return `没找到：${err.detail}`;
    return `大脑回了 HTTP ${err.status}：${err.detail}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `桥内部出错：${message}`;
}

async function runBrainTask(args: Record<string, unknown>, ctx: BridgeToolContext): Promise<ToolResult> {
  if (!ctx.tokenConfigured) {
    return textResult("桥 token 未配置（~/.allbot/dot/bridge-token），拒绝提交任务。", undefined, true);
  }
  const intent = requireString(args, "intent");
  const admission = ctx.admission();
  if (!admission.allowed) {
    return textResult(admission.reason ?? "盘紧，暂停接新任务", undefined, true);
  }
  if (args.declared !== undefined && args.declared !== null && asRecord(args.declared) === null) {
    throw new ToolInputError("参数 declared 要是对象");
  }
  if (args.source_ref !== undefined && args.source_ref !== null && asRecord(args.source_ref) === null) {
    throw new ToolInputError("参数 source_ref 要是对象");
  }
  const declared = asRecord(args.declared) ?? undefined;
  const restated = optionalString(args, "restated");
  const profile = optionalString(args, "profile");
  if (profile !== undefined && !["cheap", "balanced", "strong"].includes(profile)) {
    throw new ToolInputError("参数 profile 只能是 cheap / balanced / strong");
  }
  const budgetRaw = args.budget_tokens;
  let budgetTokens: number | undefined;
  if (budgetRaw !== undefined && budgetRaw !== null) {
    if (typeof budgetRaw !== "number" || !Number.isFinite(budgetRaw) || budgetRaw < 0) {
      throw new ToolInputError("参数 budget_tokens 要是非负整数");
    }
    budgetTokens = Math.floor(budgetRaw);
  }
  const parentTaskId = optionalString(args, "parent_task_id");

  // A.8：source_ref = {bot, chat}。桥拿不到会话身份时（MCP 头里没有），
  // 允许调用方自己传 bot/chat_id；再没有就只留 via，不编。
  const givenRef = asRecord(args.source_ref);
  const bot = optionalString(args, "bot");
  const chatId = optionalString(args, "chat_id");
  const sourceRef: Record<string, unknown> = {
    ...(givenRef ?? {}),
    ...(bot === undefined ? {} : { bot }),
    ...(chatId === undefined ? {} : { chat: chatId }),
  };
  if (Object.keys(sourceRef).length === 0) sourceRef.via = "dot-bridge/mcp";

  const { value } = await ctx.client.createTask({
    intent,
    declared: declared ?? {},
    source: "dsbot",
    source_ref: sourceRef,
    ...(restated === undefined ? {} : { restated }),
    ...(profile === undefined ? {} : { profile }),
    ...(budgetTokens === undefined ? {} : { budget_tokens: budgetTokens }),
    ...(parentTaskId === undefined ? {} : { parent_id: parentTaskId }),
  });

  const card = cardOf(value);
  const taskId = taskIdOf(value);
  if (card !== null) return textResult(`已交给大脑。\n${card}`, value);
  return textResult(`已交给大脑${taskId === null ? "" : `：任务 ${taskId}`}。`, value);
}

async function runBrainStatus(args: Record<string, unknown>, ctx: BridgeToolContext): Promise<ToolResult> {
  if (!ctx.tokenConfigured) {
    return textResult("桥 token 未配置（~/.allbot/dot/bridge-token），问不了状态。", undefined, true);
  }
  const taskId = optionalString(args, "task_id");
  const { value } = await ctx.client.status(taskId ?? null);
  const card = cardOf(value);
  if (card !== null) return textResult(card, value);
  return textResult(JSON.stringify(value, null, 2), value);
}

async function runBrainAnswer(args: Record<string, unknown>, ctx: BridgeToolContext): Promise<ToolResult> {
  if (!ctx.tokenConfigured) {
    return textResult("桥 token 未配置（~/.allbot/dot/bridge-token），回传不了。", undefined, true);
  }
  const approvalId = requireString(args, "approval_id");
  const answer = requireString(args, "answer");
  const { value } = await ctx.client.decide(approvalId, { answer, decided_by: "dsbot" });
  const message = messageOf(value) ?? `已回传批单 ${approvalId}`;
  return textResult(message, value);
}

async function runBrainCancel(args: Record<string, unknown>, ctx: BridgeToolContext): Promise<ToolResult> {
  if (!ctx.tokenConfigured) {
    return textResult("桥 token 未配置（~/.allbot/dot/bridge-token），取消不了。", undefined, true);
  }
  const taskId = requireString(args, "task_id");
  const reason = optionalString(args, "reason") ?? "cancelled_by_user";
  const { value } = await ctx.client.cancel(taskId, { reason, cancelled_by: "dsbot" });
  const message = messageOf(value) ?? `已请求取消任务 ${taskId}`;
  return textResult(message, value);
}

export async function callBrainTool(
  name: string,
  rawArgs: unknown,
  ctx: BridgeToolContext,
): Promise<ToolResult> {
  const args = asRecord(rawArgs) ?? {};
  try {
    switch (name) {
      case "brain_task":
        return await runBrainTask(args, ctx);
      case "brain_status":
        return await runBrainStatus(args, ctx);
      case "brain_answer":
        return await runBrainAnswer(args, ctx);
      case "brain_cancel":
        return await runBrainCancel(args, ctx);
      default:
        return textResult(`没有这个工具：${name}`, undefined, true);
    }
  } catch (err) {
    return textResult(formatFailure(err, ctx), undefined, true);
  }
}

/** 工具名检查（MCP 的 tools/call 在取工具前先看一眼，未知工具走 JSON-RPC -32602）。 */
export function knownTool(name: string): ToolDefinition | null {
  return BRAIN_TOOLS.find((t) => t.name === name) ?? null;
}

/** 给状态页/health 用：把 keep 视图的读取包成「每次现判」的闭包。 */
export function admissionFromKeep(read: () => KeepView, minFreeMb: number): () => AdmissionDecision {
  return () => diskAdmission(read(), minFreeMb);
}
