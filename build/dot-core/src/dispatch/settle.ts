/**
 * src/dispatch/settle.ts —— 会话结束后给任务下结论（方案 A.9 第 3 步的出口）。
 *
 * 三条规则，按优先级：
 * 1. 会话超时 → paused + blocked_on（说明卡在超时），交给恢复协议下次判断；
 * 2. 有任何失败步 → failed + state_reason（写清失败了几步、第一步的错是什么）；
 * 3. 所有步都 succeeded/skipped 且至少一步 → done；
 * 4. 一步都没做 → failed（`no_steps`）。零步骤当成功是错的：工人会话「什么都没干」
 *    却把任务标成完成，会让上游以为事情做完了。宁可标失败让人看。
 *
 * 只从 running 改。任务在会话期间被闸门推到 awaiting_approval、或被人取消，
 * 这里原样返回 left —— 派发器不替审批流程下结论。
 */

import {
  STEP_STATUSES,
  getTask,
  listSteps,
  setTaskState,
  type LedgerDb,
  type StepStatus,
  type TaskState,
} from "../ledger/index.ts";

export type SettleOutcome = "done" | "failed" | "paused" | "left";

/** 「会话超时」的统一措辞：派发器据此认领自己造成的 paused（做有界重排，见 scheduler）。 */
export const TIMEOUT_REASON = "工人会话超时";

export interface SettleOptions {
  /** 会话超时的说明（超时那条路径必传）。给了就按「超时 → paused」处理。 */
  timeoutReason?: string;
  /** 会话报错的说明（错误那条路径必传）。给了就直接 failed。 */
  errorReason?: string;
}

export interface SettleReport {
  taskId: string;
  outcome: SettleOutcome;
  state: TaskState | null;
  /** tasks.state_reason 的最终值（left 时是原来的值）。 */
  reason: string | null;
  counts: Record<StepStatus, number>;
  stepCount: number;
}

function countSteps(db: LedgerDb, taskId: string): Record<StepStatus, number> {
  const counts = Object.fromEntries(STEP_STATUSES.map((s) => [s, 0])) as Record<StepStatus, number>;
  for (const step of listSteps(db, taskId)) {
    counts[step.status] += 1;
  }
  return counts;
}

/** 读任务状态 + 步的统计，不改任何东西（状态页与测试用）。 */
export function inspectTaskRun(
  db: LedgerDb,
  taskId: string,
): { state: TaskState | null; counts: Record<StepStatus, number>; stepCount: number } {
  const task = getTask(db, taskId);
  const counts = countSteps(db, taskId);
  return {
    state: task?.state ?? null,
    counts,
    stepCount: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

export function settleTask(db: LedgerDb, taskId: string, opts: SettleOptions = {}): SettleReport {
  const task = getTask(db, taskId);
  const counts = countSteps(db, taskId);
  const stepCount = Object.values(counts).reduce((a, b) => a + b, 0);

  if (task === null) {
    return { taskId, outcome: "left", state: null, reason: "task_missing", counts, stepCount };
  }
  if (task.state !== "running") {
    // awaiting_approval / paused / 终态都不归派发器改。
    return {
      taskId,
      outcome: "left",
      state: task.state,
      reason: task.state_reason,
      counts,
      stepCount,
    };
  }

  if (opts.timeoutReason !== undefined) {
    const reason = opts.timeoutReason;
    const after = setTaskState(db, taskId, "paused", {
      reason,
      blocked_on: { type: "human", reason },
      expect: ["running"],
    });
    return {
      taskId,
      outcome: after === null ? "left" : "paused",
      state: after?.state ?? task.state,
      reason: after?.state_reason ?? reason,
      counts,
      stepCount,
    };
  }

  if (opts.errorReason !== undefined) {
    const reason = opts.errorReason;
    const after = setTaskState(db, taskId, "failed", {
      reason,
      blocked_on: null,
      expect: ["running"],
    });
    return {
      taskId,
      outcome: after === null ? "left" : "failed",
      state: after?.state ?? task.state,
      reason: after?.state_reason ?? reason,
      counts,
      stepCount,
    };
  }

  const failed = counts.failed + counts.interrupted + counts.rolled_back;
  if (failed > 0) {
    const reason =
      `有 ${failed} 步没成功（failed=${counts.failed}，interrupted=${counts.interrupted}，` +
      `rolled_back=${counts.rolled_back}）`;
    const after = setTaskState(db, taskId, "failed", { reason, blocked_on: null, expect: ["running"] });
    return {
      taskId,
      outcome: after === null ? "left" : "failed",
      state: after?.state ?? task.state,
      reason: after?.state_reason ?? reason,
      counts,
      stepCount,
    };
  }

  if (stepCount === 0) {
    const reason = "会话结束但一步都没做（no_steps）";
    const after = setTaskState(db, taskId, "failed", { reason, blocked_on: null, expect: ["running"] });
    return {
      taskId,
      outcome: after === null ? "left" : "failed",
      state: after?.state ?? task.state,
      reason: after?.state_reason ?? reason,
      counts,
      stepCount,
    };
  }

  if (counts.started > 0 || counts.pending > 0) {
    // 有步停在 started：真实结局不明，不许冒充成功（A.9 第 3 条）。
    const reason = `会话结束时还有 ${counts.started + counts.pending} 步没结束（结局不明，等恢复协议）`;
    const after = setTaskState(db, taskId, "paused", {
      reason,
      blocked_on: { type: "human", reason },
      expect: ["running"],
    });
    return {
      taskId,
      outcome: after === null ? "left" : "paused",
      state: after?.state ?? task.state,
      reason: after?.state_reason ?? reason,
      counts,
      stepCount,
    };
  }

  const reason =
    `所有步骤都成功或跳过（共 ${counts.succeeded + counts.skipped} 步，` +
    `succeeded=${counts.succeeded}，skipped=${counts.skipped}）`;
  const after = setTaskState(db, taskId, "done", { reason, blocked_on: null, expect: ["running"] });
  return {
    taskId,
    outcome: after === null ? "left" : "done",
    state: after?.state ?? task.state,
    reason: after?.state_reason ?? reason,
    counts,
    stepCount,
  };
}
