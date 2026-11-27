/**
 * src/dispatch/settle.ts —— 会话结束后给任务下结论（方案 A.9 第 3 步的出口）。
 *
 * 三条规则，按优先级：
 * 1. 会话超时 → paused + blocked_on（说明卡在超时），交给恢复协议下次判断；
 * 2. 有致命失败步 → failed + state_reason（写清失败了几步、第一步的错是什么）；
 *    致命 = 写类失败（side_effect != safe）或 interrupted/rolled_back。
 *    只读探测失败（side_effect=safe，如 files/list 列了工作区外的目录）不算致命，
 *    但写进 state_reason 留痕（2026-11-26：产物写出来了却因探测失败被判 failed）。
 * 3. 所有写类步骤都 succeeded/skipped 且至少一步 → done；
 * 4. 一步都没做 → failed（`no_steps`）。零步骤当成功是错的：工人会话「什么都没干」
 *    却把任务标成完成，会让上游以为事情做完了。宁可标失败让人看。
 * 5. 有任务契约时，交付物没交齐或硬约束没满足 → paused（2026-11-27 加）。
 *    前四条只看步骤，不看「答应的东西有没有交」；真机实测读到 20 步就收工、文件一个字没写，
 *    照样判 done。判定交给 src/plan/contract.ts 的 checkContract，这里只负责拦下。
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
import { checkContract } from "../plan/contract.ts";

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

/**
 * 「崩溃恢复跳过重做」的步数。这些步是 skipped，但活**确实干过**（上一轮干成的），
 * 算「什么都没做」会把恢复中的任务误判成失败。
 */
function countReplaySkips(db: LedgerDb, taskId: string): number {
  return listSteps(db, taskId).filter(
    (s) => s.status === "skipped" && (s.error ?? "").startsWith("崩溃恢复"),
  ).length;
}

/**
 * 只读探测失败（side_effect=safe，典型是 files/list 列了工作区父目录被路径围栏拒）
 * 不算致命：它没有改任何东西，也不影响后面真正的写步骤。
 * 2026-11-26：实测任务 task_c40c… 的 ok.txt 已经写出来，却因为工人顺手 list 了
 * 工作区外的 D:/tmp 被拒一步，整个任务判 failed——产物和状态对不上。
 * 口径：safe 失败不算数，但写类失败（replayable/unknown）仍一票否决；
 * 一个 succeeded 都没有时照样 failed（no_steps）。
 *
 * 2026-11-27 再补一类：**事前拒绝**。写类动作在真正落盘之前就被手拦下的，
 * 账上记的是写类失败（手按动作类型定 side_effect），可磁盘一个字节都没变。
 * 现场：手机派的那条任务，第 3 步已经把 recheck.txt 写出来了，第 5 步又写一次
 * 被「已存在、要覆盖请传 overwrite」拒掉——一次无用重试把整条任务判成 failed。
 * 这些错误码都是「还没动手就回来了」，按良性算。
 *
 * 2026-11-27 再收一次：`denied` / `human_required` 不算良性。
 * 它们不是「前置条件不满足」，是**有人或策略把这一步否了**——磁盘没变，但活也没干。
 * 原来按良性算，一条只会写一个文件的任务，那一步被拒之后仍会判 done（「写类步骤都成功或跳过」），
 * 产物根本不存在。现在：被拒的一步仍然留痕、不直接判死，但下面要求「至少一步成功」，
 * 一步都没成功就判 failed，原因写清。
 */
const NO_EFFECT_CODES = new Set([
  "exists",
  "not_found",
  "bad_path",
  "bad_action",
  "bad_content",
  "parent_missing",
  "parent_not_a_directory",
  "not_a_directory",
  "target_is_directory",
  "outside_root",
  "symlink_denied",
  "content_too_large",
]);

/** 失败步的错误文本形如 `code: 说明`（hand.ts 落账时拼的）。 */
function failedCodeOf(error: string | null): string | null {
  if (error === null) return null;
  const hit = /^([a-z_]+):/.exec(error.trim());
  return hit === null ? null : hit[1] ?? null;
}

function countFatalFailures(db: LedgerDb, taskId: string): { fatal: number; benign: number } {
  let fatal = 0;
  let benign = 0;
  for (const step of listSteps(db, taskId)) {
    if (step.status === "failed") {
      const code = failedCodeOf(step.error ?? null);
      if (step.side_effect === "safe" || (code !== null && NO_EFFECT_CODES.has(code))) {
        benign += 1; // 没改东西 / 还没动手就拒了：留痕但不否决
        continue;
      }
      fatal += 1;
      continue;
    }
    if (step.status === "interrupted" || step.status === "rolled_back") {
      fatal += 1; // 会话中断、回滚都致命
    }
  }
  return { fatal, benign };
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

  const fatal = countFatalFailures(db, taskId);
  if (fatal.fatal > 0) {
    const counts = countSteps(db, taskId);
    const reason =
      `有 ${fatal.fatal} 步致命失败` +
      `（failed=${counts.failed}，interrupted=${counts.interrupted}，rolled_back=${counts.rolled_back}；` +
      `另有 ${fatal.benign} 步只读探测失败不算致命）`;
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

  // 一步都没成功就别判完成（2026-11-27 加）。被闸门拒、需要人点、参数被手驳回——
  // 这些都记在 skipped / failed 上，凑不出一个 succeeded。原来这种任务会走到最后的 done，
  // 理由是「写类步骤都成功或跳过」，可它什么也没做出来。
  // 「崩溃恢复跳过重做」那类 skipped 不算：活上一轮已经干成了，只是这一轮没重做。
  if (counts.succeeded === 0 && countReplaySkips(db, taskId) === 0) {
    const reason =
      `一步都没成功（succeeded=0，skipped=${counts.skipped}，failed=${counts.failed}` +
      `${counts.interrupted > 0 ? `，interrupted=${counts.interrupted}` : ""}）：没有产物，不算完成`;
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

  // 有契约就按契约收口（2026-11-27 加）。
  // 为什么：原来只看「写类步骤都成功」，工人把活读了一遍就收工，任务照样判完成。
  // 真机实测：一个「把结论写进 docs/session-state-machine.md」的任务读了 20 个文件、
  // 一个字没写，判 done，文件根本不存在。交付物和硬约束必须在这里过一遍。
  const contract = checkContract(db, taskId);
  if (contract !== null) {
    const missing = contract.outstanding;
    const hardBroken = contract.constraints.filter(
      (c) => c.severity === "hard" && !c.satisfied && !c.configError,
    );
    if (missing.length > 0 || hardBroken.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`还有 ${missing.length} 个交付物没交（${missing.join("、")}）`);
      if (hardBroken.length > 0) {
        parts.push(`${hardBroken.length} 条硬约束没满足（${hardBroken.map((c) => c.id).join("、")}）`);
      }
      const reason = `契约没完成：${parts.join("；")}`;
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
  }

  const benignNote = fatal.benign > 0 ? `；另有 ${fatal.benign} 步只读探测失败（不改东西，不影响产物）` : "";
  const reason =
    `写类步骤都成功或跳过（共 ${counts.succeeded + counts.skipped} 步，` +
    `succeeded=${counts.succeeded}，skipped=${counts.skipped}）${benignNote}`;
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
