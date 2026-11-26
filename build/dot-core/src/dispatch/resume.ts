/**
 * src/dispatch/resume.ts —— 审批有结论之后，把任务放回派发队列（A.6 的「重新派发」）。
 *
 * 为什么必须在这里做：派发出来的工人会话是一次性的（`deliver:false` 单轮），
 * 被闸门拦下的动作会在 `awaiting_approval` 结束会话，会话本身不会再重调那个动作。
 * 如果决定之后没人把任务放回 queued，任务就永远停在 `awaiting_approval`——
 * 批了也一样。审核用探针实测过这条死路（P6）。
 *
 * 两个去向：
 * - 同意 → `requeueTask`：run_epoch+1（旧会话被 fencing）、状态回 queued，派发器下一轮重领。
 *   批准单在 `approved` 状态，新会话重调同一动作时 `findOpenApprovalBySubjectKey` 会直接放行。
 * - 拒绝 → `cancelTask`：任务终止，避免「拒绝→新会话来→再出同一张单」的循环。
 *
 * 还有别的未决审批单时不放行：一次只推进一步，别让同一任务的几张单互相踩。
 */

import {
  cancelTask,
  getApproval,
  getTask,
  listOpenApprovals,
  requeueTask,
  type LedgerDb,
  type TaskRow,
} from "../ledger/index.ts";

export type DecisionResumeAction = "requeued" | "cancelled" | "left";

export interface DecisionResumeResult {
  action: DecisionResumeAction;
  approvalId: string;
  taskId: string | null;
  /** 放回队列后的任务行（action=requeued 时有值）。 */
  task: TaskRow | null;
  detail: string;
}

/**
 * 同一任务还有别的**等人点**的审批单（只算 pending，不算 approved/executing）。
 *
 * 2026-11-25 真机踩到死锁：一张 create 已经 approved 但还没被用掉，另一张浏览器单被拒，
 * 拒绝那条路看到「还有别的未决单」就不重排，而那张 approved 又没人跑 —— 任务永远停着。
 * approved/executing 是「已经有人批了，等下一轮执行」，不该拦住重排。
 */
function hasOtherOpenApprovals(db: LedgerDb, taskId: string, approvalId: string): boolean {
  return listOpenApprovals(db, taskId).some((row) => row.id !== approvalId && row.status === "pending");
}

/**
 * 按审批单的最终状态决定任务去留。幂等：同一张单重复调用，任务已不在
 * awaiting_approval/paused 时返回 left，不会重复改。
 */
export function resumeAfterDecision(db: LedgerDb, approvalId: string): DecisionResumeResult {
  const approval = getApproval(db, approvalId);
  if (approval === null) {
    return { action: "left", approvalId, taskId: null, task: null, detail: `没有批单 ${approvalId}` };
  }
  const taskId = approval.task_id;
  if (taskId === null) {
    return { action: "left", approvalId, taskId: null, task: null, detail: "这张单不挂在任务上，任务状态不动" };
  }
  const task = getTask(db, taskId);
  if (task === null) {
    return { action: "left", approvalId, taskId, task: null, detail: `批单指向的任务 ${taskId} 不存在` };
  }
  if (task.state !== "awaiting_approval" && task.state !== "paused") {
    return {
      action: "left",
      approvalId,
      taskId,
      task,
      detail: `任务 ${taskId} 现在是 ${task.state}，不需要按审批结论重排`,
    };
  }

  if (approval.status === "approved") {
    if (hasOtherOpenApprovals(db, taskId, approvalId)) {
      return {
        action: "left",
        approvalId,
        taskId,
        task,
        detail: `任务 ${taskId} 还有别的审批单没决，等齐了一次重排`,
      };
    }
    const after = requeueTask(db, taskId, {
      reason: `审批 #${approvalId} 已通过，重新排队`,
      expect: ["awaiting_approval", "paused"],
    });
    if (after === null) {
      return { action: "left", approvalId, taskId, task, detail: `任务 ${taskId} 重排没生效（状态已变）` };
    }
    return {
      action: "requeued",
      approvalId,
      taskId,
      task: after,
      detail: `任务 ${taskId} 已放回 queued（run_epoch=${after.run_epoch}），下一轮派发重试`,
    };
  }

  if (approval.status === "rejected" || approval.status === "revoked" || approval.status === "expired") {
    if (hasOtherOpenApprovals(db, taskId, approvalId)) {
      return {
        action: "left",
        approvalId,
        taskId,
        task,
        detail: `任务 ${taskId} 还有别的审批单没决，先不动`,
      };
    }
    const after = cancelTask(db, taskId, `审批 #${approvalId} ${approval.status === "rejected" ? "被拒" : "失效"}，任务终止`);
    return {
      action: after === null ? "left" : "cancelled",
      approvalId,
      taskId,
      task: after,
      detail:
        after === null
          ? `任务 ${taskId} 状态已变，没取消`
          : `任务 ${taskId} 已终止（审批 ${approval.status}）`,
    };
  }

  return {
    action: "left",
    approvalId,
    taskId,
    task,
    detail: `批单还是 ${approval.status}，没有结论可执行`,
  };
}
