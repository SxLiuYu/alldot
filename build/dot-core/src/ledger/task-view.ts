/**
 * src/ledger/task-view.ts —— 进度卡的数据源。方案 5.5 要求「到哪、做过什么、为什么、
 * 卡在谁」全由账本直拼，不经模型；src/status 的模板渲染吃这个返回值。
 *
 * 四个问题对应四个字段：
 *   到哪一步 → where
 *   做过什么 → done
 *   为什么   → why
 *   卡在谁   → blockedBy（外加 awaiting / locks 两份明细）
 *
 * 外显六态严格照 B.8 末尾那张表（不自行发挥）：
 *   queued→待启动（blocked_on=lock 时→阻塞）、running→执行中、
 *   awaiting_approval 或 blocked_on=human→等待输入、paused→阻塞、
 *   done→完成、failed/cancelled→终止。
 * 「running 但有一张待批单」不在此表里：闸门要停的时候应该把任务置 awaiting_approval，
 * 而不是指望状态页替它改写状态。
 */

import type { LedgerDb } from "./db.ts";
import { LedgerError } from "./db.ts";
import { getLock, locksOfTask } from "./locks.ts";
import { parseBlockedOn } from "./records.ts";
import { listSteps } from "./steps.ts";
import type {
  ApprovalRow,
  LockRow,
  StepStatus,
  StepRow,
  TaskRow,
  TaskState,
  TaskView,
  TaskViewStep,
} from "./types.ts";
import { STEP_STATUSES } from "./types.ts";

interface MilestoneRow {
  id: string;
  task_id: string;
  seq: number;
  title: string;
  done_when: string;
  summary: string | null;
  state: string;
  created_at: string | null;
  ended_at: string | null;
}

interface PlanRow {
  id: string;
  task_id: string;
  version: number;
  milestone_id: string | null;
  content_json: string;
  why: string | null;
  created_at: string;
}

function stateLabelOf(task: TaskRow, blockedType: "human" | "lock" | null): string {
  const state = String(task.state) as TaskState;
  // 终态先判：残留的 blocked_on 不该把已完成的任务显示成「等待输入」。
  if (state === "done") return "完成";
  if (state === "failed" || state === "cancelled") return "终止";
  if (state === "awaiting_approval" || blockedType === "human") return "等待输入";
  if (state === "paused") return "阻塞";
  if (state === "queued") return blockedType === "lock" ? "阻塞" : "待启动";
  if (state === "running") return "执行中";
  return "未知";
}

function toViewStep(step: StepRow): TaskViewStep {
  return {
    seq: Number(step.seq),
    id: String(step.id),
    kind: step.kind,
    tool: step.tool === null ? null : String(step.tool),
    status: step.status,
    sideEffect: step.side_effect,
    error: step.error === null ? null : String(step.error),
    startedAt: step.started_at === null ? null : String(step.started_at),
    endedAt: step.ended_at === null ? null : String(step.ended_at),
  };
}

function emptyStepCounts(): Record<StepStatus, number> {
  const out = {} as Record<StepStatus, number>;
  for (const s of STEP_STATUSES) out[s] = 0;
  return out;
}

/**
 * 读一个任务的进度视图。任务不存在抛 task_not_found（调用方 fail-closed）。
 * 只读，不写任何行，不追加事件。
 */
export function readTaskView(db: LedgerDb, taskId: string): TaskView {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as
    | TaskRow
    | undefined;
  if (task === undefined) {
    throw new LedgerError("task_not_found", `readTaskView: 任务 ${taskId} 不存在`);
  }

  const milestones = db
    .prepare("SELECT * FROM milestones WHERE task_id = ? ORDER BY seq ASC")
    .all(taskId) as unknown as MilestoneRow[];

  const plan = db
    .prepare("SELECT * FROM plans WHERE task_id = ? ORDER BY version DESC, created_at DESC LIMIT 1")
    .get(taskId) as unknown as PlanRow | undefined;

  const steps = listSteps(db, taskId);
  const stepCounts = emptyStepCounts();
  for (const s of steps) {
    if (stepCounts[s.status] !== undefined) stepCounts[s.status] += 1;
  }

  const finishedSteps = steps.filter((s) =>
    ["succeeded", "failed", "interrupted", "skipped", "rolled_back"].includes(s.status),
  );
  const current = [...steps].reverse().find((s) => s.status === "started") ?? null;

  const activeMilestone =
    milestones.find((m) => m.id === task.milestone_id) ??
    milestones.find((m) => m.state === "active") ??
    null;

  // 「等你定的事」只算 pending：approved/executing 是「已经批了，正在做」，
  // 不该再出现在答题区，也不该让状态卡在「等待输入」。
  const approvals = db
    .prepare(
      `SELECT * FROM approvals
       WHERE task_id = ? AND status = 'pending'
       ORDER BY created_at ASC`,
    )
    .all(taskId) as unknown as ApprovalRow[];

  const ownLocks = locksOfTask(db, taskId);
  const blockedOn = parseBlockedOn(task.blocked_on_json);

  const pending = approvals[0] ?? null;

  // 「卡在谁」的判定顺序：等人的审批 > 人的阻塞标记 > 别人占着的锁 > 没卡。
  let blockedBy: TaskView["blockedBy"] = {
    type: "none",
    detail: "没卡住",
    waitingFor: "nobody",
    approvalId: null,
    stepId: null,
  };

  if (pending !== null) {
    blockedBy = {
      type: "approval",
      detail: `等你点：${String(pending.title)}`,
      waitingFor: "human",
      approvalId: String(pending.id),
      stepId: pending.step_id === null ? null : String(pending.step_id),
    };
  } else if (blockedOn?.type === "human") {
    blockedBy = {
      type: "human",
      detail: `等你回话（${String(blockedOn.reason ?? "需要你决定")}）`,
      waitingFor: "human",
      approvalId:
        Array.isArray(blockedOn.approval_ids) && blockedOn.approval_ids.length > 0
          ? String(blockedOn.approval_ids[0])
          : null,
      stepId:
        Array.isArray(blockedOn.step_ids) && blockedOn.step_ids.length > 0
          ? String(blockedOn.step_ids[0])
          : null,
    };
  } else if (blockedOn?.type === "lock") {
    // 「等锁」必须指向**别人**占着的锁。自己的旧进程留下的锁不算卡（恢复协议会放开），
    // 否则会显示成「等自己放锁」这种自相矛盾的卡。
    const resource = blockedOn.resource;
    const holder =
      resource === undefined ? null : (getLock(db, resource) as unknown as LockRow | null);
    if (holder !== null && String(holder.task_id) !== taskId) {
      blockedBy = {
        type: "lock",
        detail: `等 ${String(holder.task_id)} 让出「${String(holder.resource)}」`,
        waitingFor: "worker",
        approvalId: null,
        stepId: null,
      };
    } else if (holder !== null) {
      // 锁还在自己名下：说明是上一轮残留，TTL 到点自然消失，不算卡住。
      blockedBy = {
        type: "lock",
        detail: `「${String(holder.resource)}」还在本任务的旧租约里，等 TTL 过期即可`,
        waitingFor: "nobody",
        approvalId: null,
        stepId: null,
      };
    } else {
      blockedBy = {
        type: "lock",
        detail: `等「${String(resource ?? "资源")}」放锁（当前没人占着，可能是上一轮的残留标记）`,
        waitingFor: "worker",
        approvalId: null,
        stepId: null,
      };
    }
  } else if (task.state === "paused") {
    blockedBy = {
      type: "unknown",
      detail: "暂停中，原因见任务备注",
      waitingFor: "human",
      approvalId: null,
      stepId: null,
    };
  }

  // 外显标签只认 B.8 的两类依据：任务状态 + blocked_on。
  const labelBlockedType: "human" | "lock" | null =
    blockedOn?.type === "human" ? "human" : blockedOn?.type === "lock" ? "lock" : null;

  const budgetTokens = task.budget_tokens === null ? null : Number(task.budget_tokens);
  const spent = Number(task.spent_tokens ?? 0);

  return {
    taskId: String(task.id),
    intent: String(task.intent),
    state: task.state,
    stateLabel: stateLabelOf(task, labelBlockedType),
    stateReason: task.state_reason === null ? null : String(task.state_reason),
    planVersion: Number(task.plan_version ?? 1),
    profile: String(task.profile ?? "balanced"),
    where: {
      milestoneId: activeMilestone === null ? null : String(activeMilestone.id),
      milestoneSeq: activeMilestone === null ? null : Number(activeMilestone.seq),
      milestoneCount: milestones.length,
      milestoneTitle: activeMilestone === null ? null : String(activeMilestone.title),
      doneWhen: activeMilestone === null ? null : String(activeMilestone.done_when),
      currentStepSeq: current === null ? null : Number(current.seq),
      currentStepTool: current === null ? null : current.tool,
      totalSteps: steps.length,
      doneSteps: finishedSteps.length,
    },
    done: finishedSteps.map(toViewStep),
    why: {
      restated: task.restated === null ? null : String(task.restated),
      planWhy: plan === undefined || plan.why === null ? null : String(plan.why),
      planVersion: plan === undefined ? null : Number(plan.version),
      milestoneTitle: activeMilestone === null ? null : String(activeMilestone.title),
    },
    blockedBy,
    awaiting: approvals.map((a) => ({
      approvalId: String(a.id),
      kind: a.kind,
      tier: Number(a.tier),
      title: String(a.title),
      detailJson: String(a.detail_json),
      createdAt: String(a.created_at),
      pendingUntil: String(a.pending_until),
    })),
    locks: ownLocks.map((l) => ({
      resource: String(l.resource),
      workerId: String(l.worker_id),
      expiresAt: String(l.expires_at),
    })),
    budget: {
      tokens: budgetTokens,
      spent,
      ratio:
        budgetTokens === null || budgetTokens <= 0
          ? null
          : Math.round((spent / budgetTokens) * 10000) / 10000,
    },
    spend: (
      db
        .prepare(
          `SELECT model, COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens
           FROM spend_ledger WHERE task_id = ? GROUP BY model ORDER BY model ASC`,
        )
        .all(taskId) as Array<{
        model?: string | null;
        input_tokens?: number;
        output_tokens?: number;
      }>
    ).map((r) => ({
      model: r.model === undefined || r.model === null ? null : String(r.model),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
    })),
    stepCounts,
    startedAt: String(task.created_at),
    updatedAt: String(task.updated_at),
  };
}

/**
 * 进度卡纯文本（场景 E 那张的样子）。src/status 的模板层会换成它自己的排版，
 * 这里留一份是给测试和 ledger-check 一个「不依赖模型」的绝对参照。
 */
export function renderProgressCard(view: TaskView): string {
  const lines: string[] = [];
  const milestone =
    view.where.milestoneSeq === null
      ? "未开始里程碑"
      : `第 ${view.where.milestoneSeq} 个里程碑，共 ${view.where.milestoneCount} 个`;
  lines.push(`【任务 ${view.taskId}】${view.intent}`);
  lines.push(`状态：${view.stateLabel}（${milestone}）`);
  lines.push(
    view.where.currentStepTool === null
      ? `到哪了：${view.where.doneSteps}/${view.where.totalSteps} 步已结束`
      : `到哪了：正在第 ${view.where.currentStepSeq} 步（${view.where.currentStepTool}）`,
  );
  lines.push(
    `做过什么：${
      view.done.length === 0
        ? "还没动手"
        : view.done
            .slice(-5)
            .map((s) => `${s.tool ?? s.kind}(${s.status})`)
            .join("；")
    }`,
  );
  lines.push(`为什么：${view.why.planWhy ?? view.why.restated ?? "任务说明里没写"}`);
  lines.push(`卡在谁：${view.blockedBy.detail}`);
  lines.push(
    `等你定的事：${view.awaiting.length === 0 ? "没有" : view.awaiting.map((a) => a.title).join("；")}`,
  );
  return lines.join("\n");
}
