/**
 * src/dispatch/after-settle.ts —— 会话结算之后的收尾（方案第 3 步 A 的那几件事里，
 * 「结算之后」这一段）。
 *
 * settleTask 只给任务定状态（done/failed/paused）。这里接在它后面，做四件事：
 *   1. 里程碑完成：拍整目录快照 → 压阶段小结 → 推进里程碑；
 *   2. 同一里程碑连续失败 2 步 → 记一次重排（milestone_failed_twice）；
 *   3. 预算过 80% → 记一次重排（budget_over_80）；
 *   4. 用户改主意（user_changed_mind）不在这里判：那是人的动作，入口在桥路由
 *      POST /dot/bridge/v1/tasks/<id>/replan（src/bridge/routes.ts）。
 *   5. 跑偏裁判（方案第 3 步 B）：里程碑收尾时调 deps.judgeDrift 判一次
 *      on_track / off_track / unclear（src/drift/）。**判定不改任务终态**，
 *      off_track 只写 state_reason + 一条 drift_verdict 事件，由裁判模块落账。
 *
 * 「记一次重排」的准确含义：调 src/plan 的 replan(reason, why)，**不带新里程碑**。
 * 现在没有「重排时重新拆计划」的模型（方案里那一层还没写），所以这里只把触发点
 * 与理由落进账本（plans 新版本 + 事件），不凭空编新清单。要重拆，调用方传 milestones。
 *
 * 为什么放在这里而不是闸门里：闸门（hands/*）每次工具调用都跑，拍快照、调模型太重；
 * 结算一轮只跑一次，是「这一段结束了」的真正时点。
 */

import {
  getTask,
  latestPlan,
  listMilestones,
  listPlans,
  listSteps,
  requeueTask,
  sumSpend,
  type LedgerDb,
  type TaskRow,
} from "../ledger/index.ts";
import { advanceMilestone, replan } from "../plan/index.ts";
import { summarizeMilestone } from "../context/index.ts";
import { snapshotDir } from "../rollback/index.ts";
import { declaredWorkspaceOf } from "../hands/index.ts";
import { checkContract, nextDeliverable } from "../plan/contract.ts";
import type { DriftCheckResult } from "../drift/index.ts";
import type { SettleOutcome } from "./settle.ts";

/** 预算触发线：花到上限的八成就算「该重排了」。 */
export const BUDGET_REPLAN_RATIO = 0.8;
/** 同一里程碑连续失败几步算「该重排了」。 */
export const CONSECUTIVE_FAILURE_LIMIT = 2;

export interface AfterSettleDeps {
  db: LedgerDb;
  /** 里程碑快照的根（默认 <dotDir>/snapshots，由入口传入）。 */
  snapshotsRoot: string;
  /** 任务的 token 预算（config.budget.tokens）；<=0 表示不算。 */
  budgetTokens: number;
  /** 压阶段小结用的模型调用。不给就跳过小结（写进 skipped，不假装做过）。 */
  complete?: (prompt: string) => Promise<string>;
  /**
   * 跑偏裁判（方案第 3 步 B）。每个 done 任务都判一次；不给就跳过判定（写进 skipped，
   * 不假装判过）。生产由入口注入 src/drift 的 runDriftCheck：它内部取原料、调模型、
   * off_track 时写 state_reason 并落 drift_verdict 事件（不改任务终态）。
   */
  judgeDrift?: (input: { taskId: string; milestoneId: string }) => Promise<DriftCheckResult | null>;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface ReplanNote {
  reason: string;
  why: string;
  planVersion: number;
}

export interface AfterSettleReport {
  taskId: string;
  outcome: SettleOutcome;
  /** 拍到的里程碑快照 id。 */
  snapshotId: string | null;
  /** 写了小结的里程碑 id。 */
  summaryMilestoneId: string | null;
  /** 推进到的下一个里程碑 id（做完最后一个时为 null）。 */
  advancedTo: string | null;
  /** 推进到下一段之后，任务有没有被放回 queued（改回 false 就是「下一段没人跑」）。 */
  requeued: boolean;
  /** 这一轮记下的重排点。 */
  replans: ReplanNote[];
  /** 跑偏裁判决（没接裁判或判不了时为 null）。 */
  drift: DriftCheckResult | null;
  /** 没做的事与原因（人看得懂的一句话）。 */
  skipped: string[];
}

const FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "interrupted"]);

function emptyReport(taskId: string, outcome: SettleOutcome): AfterSettleReport {
  return {
    taskId,
    outcome,
    snapshotId: null,
    summaryMilestoneId: null,
    advancedTo: null,
    requeued: false,
    replans: [],
    drift: null,
    skipped: [],
  };
}

/** 账本里已经记过这个标记就不再记第二遍（plans.why 里带标记）。 */
function alreadyRecorded(db: LedgerDb, taskId: string, marker: string): boolean {
  return listPlans(db, taskId).some((p) => typeof p.why === "string" && p.why.includes(marker));
}

/**
 * 当前里程碑里「末尾连着几步没成功」。只数 failed / interrupted：
 * rolled_back 是「人让它退回去」，不是「这一段做砸了」，不该触发重排
 * （settle.ts:123 把 rolled_back 一并算成失败，那条口径在那边，这里不跟）。
 */
export function consecutiveFailures(db: LedgerDb, taskId: string, milestoneId: string | null): number {
  const steps = listSteps(db, taskId)
    .filter((s) => (milestoneId === null ? true : s.milestone_id === milestoneId))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  let run = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const status = steps[i]?.status ?? "";
    if (!FAILED_STATUSES.has(status)) break;
    run += 1;
  }
  return run;
}

/** 预算用了多少（0..∞）。没记过 spend 就是 0。 */
export function budgetRatio(db: LedgerDb, taskId: string, budgetTokens: number): number {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return sumSpend(db, taskId) / budgetTokens;
}

function hasPlanOrMilestones(db: LedgerDb, taskId: string): boolean {
  // 没有计划也没有里程碑的任务（大部分工具型任务）不该被塞一条空计划行。
  return latestPlan(db, taskId) !== null || listMilestones(db, taskId).length > 0;
}

/**
 * 结算之后跑一遍。永不抛：所有失败都只记日志 —— 收尾做不完不该把已经结算好的任务
 * 再弄乱一次。
 */
export async function afterSettle(
  deps: AfterSettleDeps,
  input: { taskId: string; outcome: SettleOutcome },
): Promise<AfterSettleReport> {
  const log = deps.logger ?? (() => {});
  const report = emptyReport(input.taskId, input.outcome);

  let task: TaskRow | null;
  try {
    task = getTask(deps.db, input.taskId);
  } catch (err) {
    report.skipped.push(`读任务失败：${(err as Error).message}`);
    return report;
  }
  if (task === null) {
    report.skipped.push("任务不存在");
    return report;
  }

  // ── 1) 里程碑完成：快照 → 小结 → 推进 ───────────────────────────────────
  if (input.outcome === "done" && task.milestone_id !== null && task.milestone_id !== undefined) {
    const milestoneId = task.milestone_id;

    // a. 快照：只拍任务声明过的工作区；拍不了不影响推进（快照是底，不是前提）。
    const workspace = declaredWorkspaceOf(task);
    if (workspace === null) {
      report.skipped.push("里程碑快照：任务没声明工作区");
    } else {
      try {
        const shot = snapshotDir(
          { db: deps.db, snapshotsRoot: deps.snapshotsRoot },
          { taskId: input.taskId, milestoneId, sourcePath: workspace, label: "milestone_done" },
        );
        report.snapshotId = shot.snapshot.id;
        log("info", `任务 ${input.taskId} 里程碑 ${milestoneId} 拍快照：${shot.snapshot.id}（复用=${shot.reused}）`);
      } catch (err) {
        report.skipped.push(`里程碑快照没拍成：${(err as Error).message}`);
        log("warn", `任务 ${input.taskId} 里程碑快照失败：${(err as Error).message}`);
      }
    }

    // b. 阶段小结：写了才进下一轮的注入（src/context/inject.ts 读 milestones.summary）。
    if (deps.complete === undefined) {
      report.skipped.push("阶段小结：没有可用的模型调用");
    } else {
      try {
        const result = await summarizeMilestone(
          { db: deps.db, complete: deps.complete },
          { taskId: input.taskId, milestoneId },
        );
        if (result.summary !== "") {
          report.summaryMilestoneId = milestoneId;
          log(
            "info",
            `任务 ${input.taskId} 里程碑 ${milestoneId} 小结：${result.summary.slice(0, 40)}` +
              `（${result.stepCount} 步，调模型=${result.calledModel}）`,
          );
        } else {
          report.skipped.push("阶段小结：这一段没有已结束的步骤");
        }
      } catch (err) {
        report.skipped.push(`阶段小结没写成：${(err as Error).message}`);
        log("warn", `任务 ${input.taskId} 阶段小结失败：${(err as Error).message}`);
      }
    }

    // c. 推进：把里程碑标 done、指针挪到下一个（最后一个就挪成 null）。
    try {
      const advanced = advanceMilestone(deps.db, { taskId: input.taskId, milestoneId });
      report.advancedTo = advanced.milestone?.id ?? null;
      log(
        "info",
        advanced.finished
          ? `任务 ${input.taskId} 最后一个里程碑完成（任务状态由结算决定）`
          : `任务 ${input.taskId} 推进到里程碑 ${advanced.milestone?.seq}. ${advanced.milestone?.title}`,
      );

      // d. 还有下一段就必须把任务放回 queued：done 是终态，派发器只捞 queued，
      //    否则「任务 done、当前里程碑 active」这种状态永远没人接着跑（只做了第一段）。
      //    bumpEpoch：下一段是新一段活，幂等键要换新，不能复用上一轮 run 的结果。
      if (advanced.milestone !== null) {
        const back = requeueTask(deps.db, input.taskId, {
          reason: `里程碑 ${milestoneId} 完成，接着做 ${advanced.milestone.seq}. ${advanced.milestone.title}`,
          bumpEpoch: true,
          expect: ["done"],
        });
        report.requeued = back !== null;
        if (back === null) {
          report.skipped.push("推进到下一段但任务没放回队列（状态不是 done？）");
          log("warn", `任务 ${input.taskId} 推进到下一段，但没能放回 queued（状态 ${task?.state ?? "?"}）`);
        } else {
          log("info", `任务 ${input.taskId} 已放回 queued 做下一段（run_epoch=${back.run_epoch}）`);
        }
      }
    } catch (err) {
      report.skipped.push(`里程碑没推进：${(err as Error).message}`);
      log("warn", `任务 ${input.taskId} 推进里程碑失败：${(err as Error).message}`);
    }

    // d. 重排点：里程碑完成。只记触发与理由，不编新清单（没有计划模型）。
    report.replans.push(
      ...recordReplan(deps, input.taskId, {
        reason: "milestone_done",
        why: `里程碑 ${milestoneId} 完成（marker=[重排:milestone_done:${milestoneId}]）：没有新的里程碑清单可换，只记这次重排点`,
        dedupeKey: `[重排:milestone_done:${milestoneId}]`,
      }),
    );

    // e. 跑偏裁判：挪到里程碑块外（每个 done 任务都判，不只里程碑任务）。
    //    见下面 ── 1.5) 跑偏裁判 ──
  }

  // ── 1.5) 跑偏裁判（每个 done 任务都判，不只里程碑任务） ──────────────────
  // 2026-11-26 审计 S3-验收6：原来包在 milestone_id != null 里，生产没里程碑永远跑不到。
  if (input.outcome === "done") {
    const milestoneId = task.milestone_id ?? "";
    if (deps.judgeDrift === undefined) {
      report.skipped.push("跑偏裁判：没有接裁判");
    } else {
      try {
        const verdict = await deps.judgeDrift({ taskId: input.taskId, milestoneId });
        if (verdict === null) {
          report.skipped.push("跑偏裁判：任务取不到原料，没判");
        } else {
          report.drift = verdict;
          log(
            verdict.verdict === "off_track" ? "warn" : "info",
            `任务 ${input.taskId} 跑偏判定=${verdict.verdict}` +
              `（事件 #${verdict.eventSeq ?? "?"}，写原因=${verdict.reasonRecorded}）`,
          );
          if (verdict.verdict === "off_track" && !verdict.reasonRecorded) {
            report.skipped.push("跑偏裁判：判了 off_track 但没写进 state_reason");
          }
        }
      } catch (err) {
        report.skipped.push(`跑偏裁判没判成：${(err as Error).message}`);
        log("warn", `任务 ${input.taskId} 跑偏裁判失败：${(err as Error).message}`);
      }
    }
  }

  // ── 1.6) 契约检查（DesignAnything 的 deterministic controller） ─────────
  // 每个 done/failed 任务都检查：约束满足率、交付完成率、下一个交付物。
  // 不改终态，只写进 report 供上层参考。
  try {
    const contractReport = checkContract(deps.db, input.taskId);
    if (contractReport !== null) {
      const next = nextDeliverable(deps.db, input.taskId);
      log(
        "info",
        `任务 ${input.taskId} 契约检查：硬约束 ${Math.round(contractReport.hardSatisfaction * 100)}%` +
          `，交付 ${Math.round(contractReport.deliveryCompletion * 100)}%` +
          (next !== null ? `，下一步：${next.guidance}` : ""),
      );
      if (contractReport.hardSatisfaction < 1) {
        report.skipped.push(
          `契约：硬约束满足率 ${Math.round(contractReport.hardSatisfaction * 100)}%（未达标）`,
        );
      }
    }
  } catch (err) {
    report.skipped.push(`契约检查失败：${(err as Error).message}`);
    log("warn", `任务 ${input.taskId} 契约检查失败：${(err as Error).message}`);
  }

  // ── 2) 同一里程碑连续失败 2 步 ──────────────────────────────────────────
  if (input.outcome === "failed") {
    const milestoneId = task.milestone_id ?? null;
    const run = consecutiveFailures(deps.db, input.taskId, milestoneId);
    if (run >= CONSECUTIVE_FAILURE_LIMIT) {
      report.replans.push(
        ...recordReplan(deps, input.taskId, {
          reason: "milestone_failed_twice",
          why:
            `里程碑 ${milestoneId ?? "(未分)"} 末尾连着 ${run} 步没成功` +
            `（marker=[重排:milestone_failed_twice:${milestoneId ?? "none"}]）：没有新的里程碑清单可换，只记这次重排点`,
          dedupeKey: `[重排:milestone_failed_twice:${milestoneId ?? "none"}]`,
        }),
      );
    } else {
      report.skipped.push(`连续失败重排：当前里程碑末尾只有 ${run} 步没成功（要 ${CONSECUTIVE_FAILURE_LIMIT} 步）`);
    }
  }

  // ── 3) 预算过八成 ───────────────────────────────────────────────────────
  const ratio = budgetRatio(deps.db, input.taskId, deps.budgetTokens);
  if (ratio >= BUDGET_REPLAN_RATIO) {
    report.replans.push(
      ...recordReplan(deps, input.taskId, {
        reason: "budget_over_80",
        why: `预算已用 ${Math.round(ratio * 100)}%（marker=[重排:budget_over_80]）：没有新的里程碑清单可换，只记这次重排点`,
        dedupeKey: "[重排:budget_over_80]",
      }),
    );
  }

  return report;
}

/** 记一次重排；已经记过（marker 在 plans.why 里）就跳过。失败只记 skipped。 */
function recordReplan(
  deps: AfterSettleDeps,
  taskId: string,
  input: { reason: string; why: string; dedupeKey: string },
): ReplanNote[] {
  const log = deps.logger ?? (() => {});
  if (!hasPlanOrMilestones(deps.db, taskId)) {
    return [];
  }
  try {
    if (alreadyRecorded(deps.db, taskId, input.dedupeKey)) return [];
    const result = replan(deps.db, { taskId, reason: input.reason, why: input.why });
    log("info", `任务 ${taskId} 记重排点 ${input.reason}（plan v${result.plan.version}）`);
    return [{ reason: input.reason, why: input.why, planVersion: result.plan.version }];
  } catch (err) {
    log("warn", `任务 ${taskId} 重排点 ${input.reason} 没记成：${(err as Error).message}`);
    return [];
  }
}
