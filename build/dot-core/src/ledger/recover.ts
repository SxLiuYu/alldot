/**
 * src/ledger/recover.ts —— 恢复协议。顺序严格按方案 A.9：
 *
 *   1. 完整性校验（哈希链、steps 行与链上快照的一致性、外键、SQLite 自检）；
 *   2. run_epoch++（旧工人 fencing，带旧 epoch 的写入一律 stale_writer 拒收）；
 *   3. 逐任务：running 的任务找「started 未结束」的步骤：
 *        side_effect=unknown → 标 interrupted ＋生成问人审批；
 *        replayable/safe    → 标 interrupted，任务回 queued（attempt+1 记事件）；
 *        awaiting_approval/paused 原样保留并重发一次通知；
 *   4. 过期锁释放（locks.expires_at < now）；
 *   5. 写恢复报告 → 状态页横幅 + 桥通知脸。
 *
 * 「绝不重放 unknown」是这一层的底线（dotd src/control-plane/journal.ts:284-300 的同一条
 * 教训：执行面的 aborted/interrupted 不等于「保证没落地」，只有 safe/replayable 才敢重排）。
 *
 * 完整性校验不通过就拒绝恢复（先 append 一条 recovery_aborted 留证，再抛）：
 * 在被人改过的记录上继续对账，会把篡改过的值当成事实写进链，等于替它洗白。
 */

import type { LedgerDb } from "./db.ts";
import {
  LedgerError,
  LedgerIntegrityError,
  inTransaction,
  nowIso,
} from "./db.ts";
import { appendEvent, verifyChain } from "./events.ts";
import { verifyStepsChain, type StepChainIssue } from "./chain-view.ts";
import { releaseExpiredLocks, releaseLocksOfTask } from "./locks.ts";
import { createApproval, makeBlockedOn } from "./records.ts";
import { missingTables } from "./schema.ts";
import { markStepInterrupted, openSteps } from "./steps.ts";
import type { SideEffect, StepRow, TaskRow } from "./types.ts";

/** A.5 配置里的 approvals.ttl_hours 默认值。 */
const DEFAULT_APPROVAL_TTL_HOURS = 24;

export interface IntegrityReport {
  sqliteOk: boolean;
  sqliteDetail: string;
  fkOk: boolean;
  fkViolations: Array<Record<string, unknown>>;
  chainOk: boolean;
  chainBrokenAt: number | null;
  chainReason: string | null;
  eventCount: number;
  /** steps 行与链上最后一份快照是否逐个字段对得上。 */
  stepsChainOk: boolean;
  stepIssues: StepChainIssue[];
  stepCount: number;
}

export interface OrphanStepReport {
  taskId: string;
  stepId: string;
  seq: number;
  sideEffect: SideEffect;
  /** needs_approval = unknown；requeued = safe/replayable/pending。 */
  outcome: "needs_approval" | "requeued";
  approvalId: string | null;
}

export interface RequeuedTaskReport {
  taskId: string;
  /** 第几次重排（从 1 起）。A.9 的 attempt+1，B.8 没有该列，所以记在事件里。 */
  attempt: number;
  reason: "recovered_after_restart" | "recovered_no_open_step";
}

export interface RecoveryReport {
  startedAt: string;
  finishedAt: string;
  integrity: IntegrityReport;
  /** 第 2 步：epoch 加过一的任务。 */
  runEpochBumped: Array<{ taskId: string; from: number; to: number }>;
  /** 第 3 步：处理过的孤儿步。 */
  orphans: OrphanStepReport[];
  /** 第 3 步：因 unknown 孤儿步转「等待输入」的任务。 */
  tasksAwaitingHuman: string[];
  /** 第 3 步：回 queued 的任务（带 attempt）。 */
  tasksRequeued: RequeuedTaskReport[];
  /** 第 3 步：原样保留、需要重发通知的任务（awaiting_approval / paused）。 */
  awaitingResent: Array<{ taskId: string; state: string; approvalId: string | null }>;
  /** 第 3 步：重排/转等待时一并放掉的死 worker 锁。 */
  locksReleasedForRecoveredTasks: Array<{ resource: string; taskId: string }>;
  /** 第 4 步：释放的过期锁。 */
  expiredLocksReleased: Array<{ resource: string; taskId: string; expiresAt: string }>;
  /** 第 5 步：恢复报告事件的 seq。 */
  reportEventSeq: number;
  /** 一句话摘要，状态页横幅直接用。 */
  headline: string;
}

export interface RecoverOptions {
  /** 审批 TTL（小时），默认 24（A.5 的 approvals.ttl_hours）。 */
  approvalTtlHours?: number;
  reportAt?: Date;
}

function integrityCheck(db: LedgerDb): IntegrityReport {
  const checkRows = db.prepare("PRAGMA integrity_check").all() as unknown as Array<
    Record<string, unknown>
  >;
  const first = checkRows[0];
  const detail =
    first === undefined ? "no rows" : String(Object.values(first)[0] ?? "unknown");
  const sqliteOk = checkRows.length === 1 && detail.toLowerCase() === "ok";

  const fkViolations = db.prepare("PRAGMA foreign_key_check").all() as unknown as Array<
    Record<string, unknown>
  >;
  const chain = verifyChain(db);
  const steps = verifyStepsChain(db);

  return {
    sqliteOk,
    sqliteDetail: detail,
    fkOk: fkViolations.length === 0,
    fkViolations,
    chainOk: chain.ok,
    chainBrokenAt: chain.brokenAt,
    chainReason: chain.reason,
    eventCount: chain.count,
    stepsChainOk: steps.ok,
    stepIssues: steps.issues,
    stepCount: steps.rowCount,
  };
}

function nextAttempt(db: LedgerDb, taskId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task_requeued' AND task_id = ?")
    .get(taskId) as { n?: number } | undefined;
  return Number(row?.n ?? 0) + 1;
}

function ensureUnknownApproval(
  db: LedgerDb,
  task: TaskRow,
  step: StepRow,
  ttlHours: number,
  at: Date,
): string {
  const { approval } = createApproval(db, {
    task_id: task.id,
    step_id: step.id,
    kind: "question",
    tier: step.tier ?? 4,
    title: `执行结果不明：${step.tool ?? step.kind}（第 ${step.seq} 步）`,
    detail: {
      reason: "unknown_side_effect",
      task_id: task.id,
      step_id: step.id,
      step_seq: step.seq,
      tool: step.tool,
      kind: step.kind,
      tier: step.tier,
      args_ref: step.args_ref,
      error: step.error,
      question: "重启前这一步可能已经做了，也可能没做。要我现在重做这一步吗？",
      options: ["重做这一步", "别重做，跳过", "先停下，我自己看"],
    },
    subject_key: `unk:${step.id}`,
    ttlMs: ttlHours * 3_600_000,
    now: at,
  });
  return String(approval.id);
}

/**
 * 只给**正在跑**的任务 bump epoch。
 *
 * 2026-11-27 实测：原来对 queued / running / awaiting_approval / paused 一律 +1。
 * 恢复协议在插件加载时跑一次、gateway_start 钩子再跑一次，两次都把队列里的活任务 +1；
 * 一条任务从创建到收尾 epoch 能到 3，账本上出现一串「崩溃恢复：同一步之前已经成功过」。
 * 产物没错，但白烧 token。epoch 的语义是「这一轮谁在动手」——只有 running 的旧会话断了
 * 才需要作废它；排队中的还没开工，等人批的和暂停的本来就没有活跃会话。
 */
function bumpEpoch(db: LedgerDb, at: Date): Array<{ taskId: string; from: number; to: number }> {
  const rows = db
    .prepare(
      `SELECT id, run_epoch FROM tasks
       WHERE state = 'running'
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{ id?: string; run_epoch?: number }>;

  const bumped: Array<{ taskId: string; from: number; to: number }> = [];
  const stmt = db.prepare("UPDATE tasks SET run_epoch = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const id = String(row.id ?? "");
    if (id.length === 0) continue;
    const from = Number(row.run_epoch ?? 0);
    stmt.run(from + 1, nowIso(at), id);
    bumped.push({ taskId: id, from, to: from + 1 });
  }
  return bumped;
}

/**
 * 跑一遍恢复协议。幂等：同一份库连跑两次不会重复建审批、不会重复处理已归位的孤儿步。
 */
export function recover(db: LedgerDb, opts: RecoverOptions = {}): RecoveryReport {
  const missing = missingTables(db);
  if (missing.length > 0) {
    throw new LedgerError(
      "schema_missing",
      `recover: 账本缺表 ${missing.join(",")}，先跑 migrate(db)`,
    );
  }

  const at = opts.reportAt ?? new Date();
  const startedAt = nowIso(at);
  const ttlHours = opts.approvalTtlHours ?? DEFAULT_APPROVAL_TTL_HOURS;

  // ── 第 1 步：完整性校验 ────────────────────────────────────────────
  const integrity = integrityCheck(db);
  if (!integrity.sqliteOk) {
    throw new LedgerIntegrityError(
      `recover: PRAGMA integrity_check 失败（${integrity.sqliteDetail}），拒绝继续恢复`,
    );
  }
  if (!integrity.fkOk) {
    throw new LedgerIntegrityError(
      `recover: 外键校验失败（${integrity.fkViolations.length} 处），拒绝继续恢复`,
    );
  }
  if (!integrity.chainOk || !integrity.stepsChainOk) {
    // 先留一条证，再拒。写入不会掩盖问题：链上断裂的位置还在，steps 行也没被碰。
    appendEvent(db, {
      type: "recovery_aborted",
      payload: {
        reason: !integrity.chainOk ? "chain_broken" : "step_chain_mismatch",
        integrity,
      },
    });
    if (!integrity.chainOk) {
      throw new LedgerIntegrityError(
        `recover: 指纹链在 #${integrity.chainBrokenAt} 断了（${integrity.chainReason}），拒绝恢复`,
      );
    }
    throw new LedgerIntegrityError(
      `recover: steps 与链上快照不一致（${integrity.stepIssues.length} 处），拒绝恢复`,
    );
  }

  // ── 第 2 步：run_epoch++ ──────────────────────────────────────────
  const runEpochBumped = inTransaction(db, () => bumpEpoch(db, at));

  const orphans: OrphanStepReport[] = [];
  const tasksAwaitingHuman: string[] = [];
  const tasksRequeued: RequeuedTaskReport[] = [];
  const awaitingResent: Array<{ taskId: string; state: string; approvalId: string | null }> = [];
  const locksReleasedForRecoveredTasks: Array<{ resource: string; taskId: string }> = [];

  // ── 第 3 步：逐任务 ──────────────────────────────────────────────
  inTransaction(db, () => {
    const running = db
      .prepare("SELECT * FROM tasks WHERE state = 'running' ORDER BY created_at ASC, id ASC")
      .all() as unknown as TaskRow[];

    for (const task of running) {
      const opens = openSteps(db, task.id);

      if (opens.length === 0) {
        // running 但没有未结束步：上一轮 worker 已经没了，留在 running 只会永远卡住。
        db.prepare(
          `UPDATE tasks SET state = 'queued', state_reason = 'recovered_no_open_step',
             blocked_on_json = NULL, updated_at = ?
           WHERE id = ? AND state = 'running'`,
        ).run(nowIso(at), task.id);
        const attempt = nextAttempt(db, task.id);
        appendEvent(db, {
          task_id: task.id,
          type: "task_requeued",
          payload: { task_id: task.id, attempt, reason: "recovered_no_open_step" },
        });
        tasksRequeued.push({ taskId: task.id, attempt, reason: "recovered_no_open_step" });
        for (const lock of releaseLocksOfTask(db, task.id, "fenced_no_open_step")) {
          locksReleasedForRecoveredTasks.push({ resource: String(lock.resource), taskId: task.id });
        }
        continue;
      }

      const approvalIds: string[] = [];
      const unknownStepIds: string[] = [];
      let needsHuman = false;

      for (const step of opens) {
        if (step.status === "pending") {
          // 只落了行还没动手（我们的 beginStep 直接写 started，pending 一般是计划出来的）。
          markStepInterrupted(db, step.id, "recovered: never started");
          orphans.push({
            taskId: task.id,
            stepId: step.id,
            seq: Number(step.seq),
            sideEffect: step.side_effect,
            outcome: "requeued",
            approvalId: null,
          });
          continue;
        }

        if (step.side_effect === "unknown") {
          markStepInterrupted(db, step.id, "recovered: side effect unknown, waiting for human");
          const approvalId = ensureUnknownApproval(db, task, step, ttlHours, at);
          approvalIds.push(approvalId);
          unknownStepIds.push(String(step.id));
          needsHuman = true;
          orphans.push({
            taskId: task.id,
            stepId: step.id,
            seq: Number(step.seq),
            sideEffect: step.side_effect,
            outcome: "needs_approval",
            approvalId,
          });
        } else {
          // safe / replayable：标断后重排，由 worker 从 queued 重新决策（不直接重放执行）。
          markStepInterrupted(db, step.id, `recovered: ${step.side_effect}, requeued`);
          orphans.push({
            taskId: task.id,
            stepId: step.id,
            seq: Number(step.seq),
            sideEffect: step.side_effect,
            outcome: "requeued",
            approvalId: null,
          });
        }
      }

      if (needsHuman) {
        const blocked = makeBlockedOn({
          type: "human",
          reason: "unknown_side_effect",
          approval_ids: approvalIds,
          step_ids: unknownStepIds,
        });
        db.prepare(
          `UPDATE tasks SET state = 'awaiting_approval', state_reason = 'recovered_unknown_side_effect',
             blocked_on_json = ?, updated_at = ?
           WHERE id = ? AND state = 'running'`,
        ).run(blocked, nowIso(at), task.id);
        tasksAwaitingHuman.push(task.id);
      } else {
        db.prepare(
          `UPDATE tasks SET state = 'queued', state_reason = 'recovered_after_restart',
             blocked_on_json = NULL, updated_at = ?
           WHERE id = ? AND state = 'running'`,
        ).run(nowIso(at), task.id);
        const attempt = nextAttempt(db, task.id);
        appendEvent(db, {
          task_id: task.id,
          type: "task_requeued",
          payload: { task_id: task.id, attempt, reason: "recovered_after_restart" },
        });
        tasksRequeued.push({ taskId: task.id, attempt, reason: "recovered_after_restart" });
      }

      // 旧 worker 已被 epoch 隔离，它的租约不再代表活着的执行者，一并放开。
      for (const lock of releaseLocksOfTask(
        db,
        task.id,
        needsHuman ? "fenced_waiting_human" : "fenced_requeued",
      )) {
        locksReleasedForRecoveredTasks.push({ resource: String(lock.resource), taskId: task.id });
      }
    }

    // awaiting_approval / paused：原样保留，只登记「要重发一次通知」。
    const keep = db
      .prepare(
        `SELECT id, state FROM tasks
         WHERE state IN ('awaiting_approval','paused')
         ORDER BY updated_at ASC, id ASC`,
      )
      .all() as Array<{ id?: string; state?: string }>;

    for (const row of keep) {
      const taskId = String(row.id ?? "");
      if (taskId.length === 0) continue;
      const open = db
        .prepare(
          `SELECT id FROM approvals
           WHERE task_id = ? AND status IN ('pending','approved','executing')
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(taskId) as { id?: string } | undefined;
      awaitingResent.push({
        taskId,
        state: String(row.state ?? ""),
        approvalId: open?.id !== undefined ? String(open.id) : null,
      });
    }
  });

  // ── 第 4 步：过期锁释放 ──────────────────────────────────────────
  const released = releaseExpiredLocks(db, at);

  // ── 第 5 步：写恢复报告 ──────────────────────────────────────────
  const headline = buildHeadline({
    orphans,
    tasksAwaitingHuman,
    tasksRequeued,
    awaitingResent,
    expiredLocks: released.length,
  });

  const event = appendEvent(db, {
    type: "recovery_report",
    ts: startedAt,
    payload: {
      started_at: startedAt,
      finished_at: nowIso(),
      integrity,
      run_epoch_bumped: runEpochBumped,
      orphans,
      tasks_awaiting_human: tasksAwaitingHuman,
      tasks_requeued: tasksRequeued,
      awaiting_resent: awaitingResent,
      locks_released_for_recovered_tasks: locksReleasedForRecoveredTasks,
      expired_locks_released: released.map((l) => ({
        resource: l.resource,
        task_id: l.task_id,
        expires_at: l.expires_at,
      })),
      headline,
    },
  });

  // 桥来收「重发通知」这一批（A.9 第 3 步末尾）。
  if (awaitingResent.length > 0) {
    appendEvent(db, {
      type: "recovery_notify",
      payload: { tasks: awaitingResent },
    });
  }

  return {
    startedAt,
    finishedAt: nowIso(),
    integrity,
    runEpochBumped,
    orphans,
    tasksAwaitingHuman,
    tasksRequeued,
    awaitingResent,
    locksReleasedForRecoveredTasks,
    expiredLocksReleased: released.map((l) => ({
      resource: String(l.resource),
      taskId: String(l.task_id),
      expiresAt: String(l.expires_at),
    })),
    reportEventSeq: event.seq,
    headline,
  };
}

function buildHeadline(x: {
  orphans: OrphanStepReport[];
  tasksAwaitingHuman: string[];
  tasksRequeued: RequeuedTaskReport[];
  awaitingResent: Array<unknown>;
  expiredLocks: number;
}): string {
  const bits: string[] = [];
  bits.push(`恢复了 ${x.tasksRequeued.length} 个任务`);
  if (x.tasksAwaitingHuman.length > 0) {
    bits.push(`${x.tasksAwaitingHuman.length} 个停下来等你确认（执行结果不明，没有重做）`);
  }
  if (x.awaitingResent.length > 0) {
    bits.push(`${x.awaitingResent.length} 个在等你之前的决定`);
  }
  if (x.expiredLocks > 0) bits.push(`释放了 ${x.expiredLocks} 把过期锁`);
  void x.orphans;
  return bits.join("；");
}

/** 最近一份恢复报告的原文（状态页横幅/ledger-check 用）。 */
export function latestRecoveryReport(db: LedgerDb): unknown {
  const row = db
    .prepare(
      `SELECT payload_json FROM events WHERE type = 'recovery_report'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get() as { payload_json?: string } | undefined;
  if (row?.payload_json === undefined) return null;
  try {
    return JSON.parse(row.payload_json) as unknown;
  } catch {
    return null;
  }
}
