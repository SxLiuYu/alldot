/**
 * src/hands/builtin.ts —— 内置工具（exec / read / write / browser …）的钩子治理。
 *
 * 依据 A.4（主路之外的另一半）与 A.5：内置工具没有我们自己的 execute 可插，
 * 只能在钩子里做——
 *   before_tool_call：归因 → 闸门判档 → 需要就出请示卡 → 写前记账 → 放行/拦截；
 *   after_tool_call：把同一步的结果落账（fire-and-forget：崩在中间就留 started，
 *   交给 A.9 的恢复协议）。
 *
 * 四条边界（写死在代码里）：
 * 1. 只管工人会话：ctx.sessionKey 解不出任务就原样放行。主会话/脸会话归 allbot
 *    自己的审批体系管，这里不越权、也不冒充记账。
 * 2. **工人会话里每个工具都过闸门**（2026-11-25 修）：不再按名单收窄。
 *    allbot 的完整工具面（process / subagents / sessions_spawn / message / cron …）
 *    远远大于我们列的名单，按名单管等于「名单外一律放行」，那是漏管不是治理。
 *    名单里只有 `WORKER_DENIED_TOOLS`——这些工具在工人会话里连审批卡都不给，
 *    直接拒（一次性会话批了也没人重调，见 src/dispatch/resume.ts 的重排）。
 * 3. 放行就记账：第 1 档读也写 steps（A.7「第 1 档只记账」），这样事后能追。
 * 4. paused 的任务一律拒（2026-11-25 修）：会话超时后旧工人可能还活着，
 *    只认终态会让它接着动手；paused 是「先停下等人/恢复协议」的意思。
 *
 * 已知限制（如实写在这里，别在文档里装作没有）：
 * - 第 2 档（工作区内写）对 exec 拍不了快照：一条命令会改哪些文件，执行前不可知。
 *   本轮只记账并把 `snapshot: "unavailable"` 写进步骤参数，练习手（practice）则真拍快照。
 * - 待批的 exec 被拦下后，要等桥的审批决定把任务重排回 queued，下一轮派发才会重试
 *   （src/dispatch/resume.ts）；本轮不做「同一会话内自动重放」。
 * - 主会话自己派生的子会话（`agent:<id>:subagent:<uuid>`）归不到任务，这里不管；
 *   工人会话里已经把 subagents / sessions_spawn 直接拒掉，所以工人开不出这种口子。
 */

import {
  beginStep,
  computeSubjectKey,
  endStep,
  getTask,
  markApprovalExecuted,
  markApprovalExecuting,
  parseBlockedOn,
  putArtifact,
  setTaskState,
  findOpenApprovalBySubjectKey,
  getApproval,
  type LedgerDb,
  type TaskRow,
} from "../ledger/index.ts";
import { createApproval, judgeTier } from "../gate/index.ts";
import type { GateInput, TierVerdict } from "../gate/types.ts";
import type { DotCoreConfig } from "../config.ts";
import { workspaceFromDeclared } from "../context/anchor.ts";
import { RECALL_TOOL_NAME, recallGateInput } from "../context/recall-tool.ts";
import { DOT_HAND_TOOL_NAMES } from "./hand.ts";
import { taskIdFromSessionKey } from "./identity.ts";

/**
 * 工人会话里**直接拒**的工具。理由是「给了这个工具就等于绕开闸门拿到别的执行面」：
 * process 能往 shell 送命令、subagents/sessions_spawn 能开一个不归账的子会话、
 * message/cron 能对外发东西。审批卡在这里没用（会话是一次性的，批了也不会重调）。
 */
export const WORKER_DENIED_TOOLS: readonly string[] = Object.freeze([
  "process",
  "subagents",
  "sessions_spawn",
  "sessions_send",
  "message",
  "cron",
  "mcp_config",
  "canvas",
  "image_generate",
  "gateway",
  "nodes",
  "ask_user",
  "skill_workover",
  "create_goal",
  "get_goal",
  "update_goal",
]);

/** 已知的内置工具名单：只用于日志/文档，判定不再按它收窄（工人会话里全判）。 */
export const BUILTIN_KNOWN_TOOLS: readonly string[] = Object.freeze([
  "exec",
  "terminal",
  "shell",
  "bash",
  "read",
  "write",
  "edit",
  "apply_patch",
  "browser",
  "web_fetch",
  "web_search",
  "glob",
  "grep",
]);

const TERMINAL_TASK_STATES = new Set(["done", "failed", "cancelled"]);
const MAX_RESULT_ARTIFACT_BYTES = 64 * 1024;

export interface BuiltinHookDeps {
  db: LedgerDb;
  config: DotCoreConfig;
  /** 注入时钟，测试用。 */
  now?: () => Date;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  /** 请示卡交给桥（与 practice 手同一个通道）。 */
  notify?: (approvalId: string) => Promise<{ ok: boolean; detail: string }>;
  /** 默认 judgeTier；测试注入用。 */
  judge?: (input: GateInput) => TierVerdict;
}

export interface BeforeToolCallDecision {
  block?: boolean;
  blockReason?: string;
}

interface PendingStep {
  stepId: string;
  taskId: string;
  approvalId: string | null;
  tool: string;
}

export interface BuiltinGovernor {
  beforeToolCall(event: unknown, ctx: unknown): Promise<BeforeToolCallDecision | undefined>;
  afterToolCall(event: unknown, ctx: unknown): Promise<void>;
  /** 当前挂起的步骤数（测试/排障用）。 */
  readonly pendingCount: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function gateInputFor(tool: string, params: Record<string, unknown>, task: TaskRow): GateInput {
  // dot_recall 只读账本：显式给 action=read，闸门才落「只读 → 1 档」那条。
  // 不给 action 的话 labelText 只有工具名 "dot_recall"，READ 词表里没有 recall，
  // 会一路掉到「判不清 → 4 档」，每次取回都出一张请示卡（2026-11-25 评审实测）。
  if (tool === RECALL_TOOL_NAME) return recallGateInput(params);

  const workspace = workspaceFromDeclared(task) ?? undefined;
  const command = typeof params["command"] === "string" ? params["command"] : undefined;
  const program = typeof params["program"] === "string" ? params["program"] : undefined;
  const argv = Array.isArray(params["argv"]) ? (params["argv"] as unknown[]).map(String) : undefined;
  const target = ["path", "file", "filePath", "target", "destination", "url"]
    .map((k) => params[k])
    .find((v): v is string => typeof v === "string" && v !== "");
  return {
    tool,
    args: params,
    command,
    program,
    argv,
    target,
    workspace,
    // 不显式给 inWorkspace：让 judge 自己按 workspace + 目标路径核对；
    // 核对不了就落「拿不准 → 4」，由人决定。
  };
}

/**
 * 造治理器。返回的 before/after 就是 registerHook 的回调本体，单独导出便于单测。
 */
export function createBuiltinGovernor(deps: BuiltinHookDeps): BuiltinGovernor {
  const judge = deps.judge ?? judgeTier;
  const log = deps.logger ?? (() => {});
  const pending = new Map<string, PendingStep>();

  const keyOf = (event: { toolCallId?: unknown; runId?: unknown }, ctx: { toolName?: string; sessionKey?: string }) => {
    if (typeof event.toolCallId === "string" && event.toolCallId !== "") return `call:${event.toolCallId}`;
    const runId = typeof event.runId === "string" ? event.runId : "";
    return `run:${ctx.sessionKey ?? ""}|${runId}|${ctx.toolName ?? ""}`;
  };

  function markAwaiting(taskId: string, approvalId: string): void {
    const current = getTask(deps.db, taskId);
    if (current === null || TERMINAL_TASK_STATES.has(current.state)) return;
    const blocked = current.blocked_on_json === null ? null : parseBlockedOn(current.blocked_on_json);
    if (current.state === "awaiting_approval" && blocked !== null && (blocked.approval_ids ?? []).includes(approvalId)) {
      return;
    }
    setTaskState(deps.db, taskId, "awaiting_approval", {
      reason: `等审批 #${approvalId}`,
      blocked_on: { type: "human", reason: `等审批 #${approvalId}`, approval_ids: [approvalId] },
    });
  }

  function resumeIfWaiting(taskId: string, approvalId: string): void {
    const current = getTask(deps.db, taskId);
    if (current === null || current.state !== "awaiting_approval") return;
    const blocked = current.blocked_on_json === null ? null : parseBlockedOn(current.blocked_on_json);
    if (blocked !== null && (blocked.approval_ids ?? []).length > 0 && !(blocked.approval_ids ?? []).includes(approvalId)) {
      return;
    }
    setTaskState(deps.db, taskId, "running", { blocked_on: null, reason: "审批通过，继续执行" });
  }

  return {
    get pendingCount(): number {
      return pending.size;
    },

    async beforeToolCall(event: unknown, ctx: unknown): Promise<BeforeToolCallDecision | undefined> {
      const e = asRecord(event);
      const c = asRecord(ctx);
      const toolName =
        typeof c["toolName"] === "string" && c["toolName"] !== ""
          ? c["toolName"]
          : String(e["toolName"] ?? "");

      const sessionKey = typeof c["sessionKey"] === "string" ? c["sessionKey"] : undefined;
      const taskId = taskIdFromSessionKey(sessionKey);
      if (taskId === null) return undefined; // 不是工人会话：不归这里管

      // 我们自己的手在自己的 execute 里走七步（身份→任务→闸门→审批→记账→动手→记结果）。
      // 钩子再拦一次会变成双份审批单/双行 steps；而且钩子路径不拿单例锁、没有接管即停与
      // 验证码交接。所以三只手（practice / desktop / 两只浏览器）整体跳过。
      if (DOT_HAND_TOOL_NAMES.includes(toolName.trim().toLowerCase())) return undefined;

      if (toolName === "") {
        return { block: true, blockReason: "拿不到工具名：工人会话里拒绝执行（A.7 归不到就拒绝）" };
      }

      const task = getTask(deps.db, taskId);
      if (task === null) {
        return { block: true, blockReason: `归不到任务 ${taskId}：拒绝执行（A.7）` };
      }
      if (TERMINAL_TASK_STATES.has(task.state)) {
        return { block: true, blockReason: `任务 ${taskId} 已是 ${task.state}：拒绝执行` };
      }
      if (task.state === "paused") {
        return {
          block: true,
          blockReason:
            `任务 ${taskId} 已暂停（${task.state_reason ?? "等恢复协议"}）：工人会话不再动手。` +
            "这一轮结束，等人或恢复协议处理。",
        };
      }

      const normalized = toolName.trim().toLowerCase();
      if (WORKER_DENIED_TOOLS.includes(normalized)) {
        log("warn", `工人会话里拒绝 ${toolName}：不在可用的工具面里（A.7 隔离）`);
        return {
          block: true,
          blockReason:
            `工人会话只能用 practice 手，${toolName} 不许用（这一条不给审批卡）。` +
            "要用就让人在新的审批流程里安排。",
        };
      }

      const params = asRecord(e["params"]);
      // 名单外的工具也照样判：judgeTier 对拿不准的工具给第 4 档（宁可多问，不漏放）。
      const verdict = judge(gateInputFor(toolName, params, task));
      const where = `${toolName}（tier ${verdict.tier}，${verdict.rule}）`;

      if (verdict.tier === 6 || verdict.handling === "deny") {
        log("warn", `内置工具 ${where} 被拒：${verdict.reason}`);
        return { block: true, blockReason: `被闸门拒绝：${verdict.reason}（${verdict.rule}）` };
      }
      if (verdict.tier === 5 || verdict.handling === "human") {
        log("warn", `内置工具 ${where} 按第 5 档交还人手`);
        return { block: true, blockReason: `这类动作要你本人做（${verdict.reason}），任务停下等你` };
      }

      const subjectKey = computeSubjectKey(task.id, toolName, params);
      let approvalId: string | null = null;

      if (verdict.handling === "ask") {
        const existing = findOpenApprovalBySubjectKey(deps.db, subjectKey);
        if (existing !== null && existing.status === "approved" && markApprovalExecuting(deps.db, existing.id)) {
          approvalId = existing.id;
          resumeIfWaiting(task.id, approvalId);
        } else if (existing !== null) {
          markAwaiting(task.id, existing.id);
          return {
            block: true,
            blockReason: `等批准 #${existing.id}（${existing.status}），请结束本轮；批准后重新调用同一动作。`,
          };
        } else {
          const created = createApproval(deps.db, {
            taskId: task.id,
            tool: toolName,
            args: params,
            tier: verdict.tier,
            title: `内置工具需要批准：${toolName}`,
            detail: {
              question: `允许这一步吗：${verdict.reason}`,
              options: ["同意", "拒绝"],
              detail: `${task.intent}\n工具：${toolName}\n参数：${JSON.stringify(params).slice(0, 800)}`,
            },
            ttlMs: deps.config.approvals.ttl_hours * 3600 * 1000,
            subjectKey,
          });
          const row = getApproval(deps.db, created.approval.id) ?? created.approval;
          if (row.status === "approved" && markApprovalExecuting(deps.db, row.id)) {
            approvalId = row.id;
            resumeIfWaiting(task.id, approvalId);
          } else {
            markAwaiting(task.id, row.id);
            if (created && deps.notify !== undefined) {
              try {
                const sent = await deps.notify(row.id);
                log(sent.ok ? "info" : "warn", `请示卡 #${row.id} 转发：${sent.detail}`);
              } catch (err) {
                log("warn", `请示卡 #${row.id} 转发失败：${(err as Error).message}`);
              }
            } else if (created) {
              log("warn", `没有配通知通道：请示卡 #${row.id} 只在账本里`);
            }
            return { block: true, blockReason: `等批准 #${row.id}，请结束本轮；批准后重新调用同一动作。` };
          }
        }
      }

      // 5) 写前记账
      const snapshotNote =
        verdict.handling === "snapshot" ? (toolName === "exec" || toolName === "terminal" || toolName === "shell" ? "unavailable_exec" : "planned") : "not_required";
      let argsHash: string;
      try {
        argsHash = putArtifact(
          deps.db,
          JSON.stringify({ tool: toolName, params, approval_id: approvalId, snapshot: snapshotNote }),
        ).hash;
      } catch (err) {
        log("error", `内置工具 ${toolName} 参数落 artifacts 失败：${(err as Error).message}`);
        return { block: true, blockReason: "记账失败，动作没有执行" };
      }

      let stepId: string;
      try {
        const step = beginStep(deps.db, {
          task_id: task.id,
          milestone_id: task.milestone_id,
          run_epoch: task.run_epoch,
          kind: "tool",
          tool: toolName,
          subject_key: subjectKey,
          side_effect: verdict.sideEffect,
          tier: verdict.tier,
          args_ref: argsHash,
          session_key: sessionKey ?? null,
        });
        stepId = step.id;
      } catch (err) {
        log("error", `内置工具 ${toolName} 记账失败：${(err as Error).message}`);
        if (approvalId !== null) markApprovalExecuted(deps.db, approvalId, false);
        return { block: true, blockReason: `记账失败，动作没有执行：${(err as Error).message}` };
      }

      pending.set(keyOf(e, c), { stepId, taskId: task.id, approvalId, tool: toolName });
      return undefined;
    },

    async afterToolCall(event: unknown, ctx: unknown): Promise<void> {
      const e = asRecord(event);
      const c = asRecord(ctx);
      const key = keyOf(e, c);
      const item = pending.get(key);
      if (item === undefined) return;
      pending.delete(key);

      const errorText = typeof e["error"] === "string" && e["error"] !== "" ? e["error"] : null;
      const result = e["result"];
      let resultRef: string | null = null;
      try {
        const serialized = JSON.stringify(result ?? null);
        if (serialized !== undefined && serialized.length <= MAX_RESULT_ARTIFACT_BYTES) {
          resultRef = putArtifact(deps.db, serialized).hash;
        }
      } catch {
        resultRef = null; // 结果序列化不了就不存，不编一个 hash
      }

      try {
        endStep(deps.db, item.stepId, {
          status: errorText === null ? "succeeded" : "failed",
          error: errorText === null ? null : errorText.slice(0, 500),
          result_ref: resultRef,
        });
      } catch (err) {
        log("error", `内置工具 ${item.tool} 结果落账失败（步骤留 started，交给恢复）：${(err as Error).message}`);
        return;
      }
      if (item.approvalId !== null) markApprovalExecuted(deps.db, item.approvalId, errorText === null);
    },
  };
}

/** 注册到 allbot 的两个钩子。 */
export function registerBuiltinHooks(api: {
  registerHook: (
    events: string | string[],
    handler: (event: unknown, ctx: unknown) => unknown,
    opts?: Record<string, unknown>,
  ) => void;
  /** 类型化钩子通道；有就走它（真网关上只有这条会到，详见 src/plugin-api.ts 的注释）。 */
  on?: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}, deps: BuiltinHookDeps): BuiltinGovernor {
  const governor = createBuiltinGovernor(deps);
  const before = (event: unknown, ctx: unknown) => governor.beforeToolCall(event, ctx);
  const after = (event: unknown, ctx: unknown) => governor.afterToolCall(event, ctx);
  // 走类型化通道：registerHook 登记的内部钩子会在网关启动时被 clearInternalHooks() 清掉，
  // 那等于口闸从来没有生效过（2026-11-25 真机实测）。
  if (typeof api.on === "function") {
    api.on("before_tool_call", before);
    api.on("after_tool_call", after);
  } else {
    api.registerHook("before_tool_call", before, { name: "dot-core.builtin.before" });
    api.registerHook("after_tool_call", after, { name: "dot-core.builtin.after" });
  }
  return governor;
}
