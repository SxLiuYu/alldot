/**
 * src/ledger/steps.ts —— 写前记账。方案 A.5：「写入口只有 dot-core 的
 * ledger.beginStep()/endStep()」，两个调用方（手 / 内置工具钩子）都在动手之前调 beginStep。
 *
 * beginStep 的顺序是硬要求：**先把 steps 行写进去并 COMMIT，再返回**。
 * 返回之后调用方才去碰手/执行器；执行器崩了留下 status='started' 的孤儿步，
 * 由恢复协议按 side_effect 分流（A.9 第 3 条）。所以这里的事务不能拖到 endStep。
 *
 * 每一次写（开始/结束/回退/被恢复标断）都在**同一个事务里**追加一条事件，payload 带该步
 * 的全字段快照（snapshot.ts）。因此链不只盖 events 自己，「做过什么」这张表被改字段或删行
 * 也能靠 verifyStepsChain() 查出来（恢复第 1 步会跑它）。
 *
 * epoch（A.9 第 2 条）：run_epoch 是必填参数，且与任务当前值严格相等才放行。
 * 不给默认值的理由——「省略就取当前值」等于让旧 worker 自动通过，fencing 形同虚设。
 */

import type { LedgerDb } from "./db.ts";
import {
  LedgerError,
  StaleWriterError,
  inTransaction,
  nowIso,
  randomId,
} from "./db.ts";
import { appendEvent } from "./events.ts";
import { snapshotStep } from "./snapshot.ts";
import {
  SIDE_EFFECTS,
  STEP_KINDS,
  TERMINAL_TASK_STATES,
  type SideEffect,
  type StepInput,
  type StepKind,
  type StepResult,
  type StepRow,
  type TaskRow,
} from "./types.ts";

const ENDED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
  "rolled_back",
]);

/** 只能从 pending/started 走到的终态（rolled_back 例外，见 endStep）。 */
const FROM_OPEN: ReadonlySet<string> = new Set(["pending", "started"]);

function readTask(db: LedgerDb, taskId: string): TaskRow {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as
    | TaskRow
    | undefined;
  if (row === undefined) {
    throw new LedgerError("task_not_found", `beginStep: task ${taskId} 不存在（fail-closed）`);
  }
  return row;
}

function checkKind(kind: string): asserts kind is StepKind {
  if (!(STEP_KINDS as readonly string[]).includes(kind)) {
    throw new LedgerError("bad_kind", `steps.kind 只能是 ${STEP_KINDS.join("/")}，收到 ${kind}`);
  }
}

function checkSideEffect(value: string): asserts value is SideEffect {
  if (!(SIDE_EFFECTS as readonly string[]).includes(value)) {
    throw new LedgerError(
      "bad_side_effect",
      `steps.side_effect 只能是 ${SIDE_EFFECTS.join("/")}，收到 ${value}（拿不准请写 unknown）`,
    );
  }
}

export function getStep(db: LedgerDb, id: string): StepRow | null {
  const row = db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as unknown as
    | StepRow
    | undefined;
  return row ?? null;
}

/**
 * 写一行 started 的步骤并提交（连同一条 step_started 事件）。
 *
 * - seq 不给就取该任务当前最大值 +1（UNIQUE(task_id, seq) 兜住并发重复）；
 * - run_epoch **必填**：必须等于任务当前 epoch，小的抛 StaleWriterError、大的抛 invalid_epoch；
 * - 终态任务（done/failed/cancelled）直接拒，取消之后旧回合不能再动手；
 * - 读到任务、校验 epoch、插入、写事件全在同一个 BEGIN IMMEDIATE 里，
 *   否则 epoch 刚被别人 bump 的窗口里会漏过一次 fencing。
 */
export function beginStep(db: LedgerDb, step: StepInput): StepRow {
  checkKind(step.kind);
  checkSideEffect(step.side_effect);

  if (typeof step.task_id !== "string" || step.task_id.length === 0) {
    throw new LedgerError("bad_task", "beginStep: task_id 必填");
  }
  if (typeof step.subject_key !== "string" || step.subject_key.length === 0) {
    throw new LedgerError("bad_subject_key", "beginStep: subject_key 必填（幂等键）");
  }

  // 写前记账的硬要求是本函数返回时已经 COMMIT。若调用方把 beginStep 包在
  // 自己的事务里，这个承诺就作废了（提交被推迟到外层），所以直接拒绝。
  if (db.isTransaction) {
    throw new LedgerError(
      "nested_transaction",
      "beginStep 必须在事务外调用：写前记账要求返回前已 COMMIT",
    );
  }

  if (typeof step.run_epoch !== "number" || !Number.isFinite(step.run_epoch)) {
    throw new LedgerError(
      "missing_run_epoch",
      "beginStep: run_epoch 必填（A.9 fencing，省略就等于放弃拦截旧工人）",
    );
  }

  const id = step.id !== undefined && step.id.length > 0 ? step.id : randomId("step");
  const startedAt = nowIso();

  inTransaction(db, () => {
    // 读 epoch 与校验都在事务内：另一个写者改 epoch 必须排在我们后面。
    const task = readTask(db, step.task_id);
    if ((TERMINAL_TASK_STATES as readonly string[]).includes(task.state)) {
      throw new LedgerError(
        "task_terminal",
        `beginStep: 任务 ${step.task_id} 已是 ${task.state}，不许再记账动手`,
      );
    }
    const currentEpoch = Number(task.run_epoch);
    if (step.run_epoch < currentEpoch) {
      throw new StaleWriterError(step.task_id, step.run_epoch, currentEpoch);
    }
    if (step.run_epoch > currentEpoch) {
      throw new LedgerError(
        "invalid_epoch",
        `beginStep: run_epoch ${step.run_epoch} 大于任务当前 ${currentEpoch}，拒绝写入`,
      );
    }

    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM steps WHERE task_id = ?")
      .get(step.task_id) as { max_seq?: number } | undefined;
    const nextSeq = step.seq !== undefined ? step.seq : Number(row?.max_seq ?? 0) + 1;

    db.prepare(
      `INSERT INTO steps (
         id, task_id, seq, milestone_id, plan_version, worker_id, run_epoch,
         kind, tool, subject_key, side_effect, tier, status, args_ref, session_key, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)`,
    ).run(
      id,
      step.task_id,
      nextSeq,
      step.milestone_id ?? null,
      step.plan_version ?? Number(task.plan_version),
      step.worker_id ?? null,
      step.run_epoch,
      step.kind,
      step.tool ?? null,
      step.subject_key,
      step.side_effect,
      step.tier ?? null,
      step.args_ref ?? null,
      step.session_key ?? null,
      startedAt,
    );

    const saved = getStep(db, id);
    if (saved === null) {
      throw new LedgerError("step_missing_after_commit", `beginStep: 刚写入的步 ${id} 读不回来`);
    }
    appendEvent(db, {
      task_id: step.task_id,
      type: "step_started",
      payload: { step_id: id, step: snapshotStep(saved) },
    });
  });

  // COMMIT 已发生。下面这条读的是别的连接也看得见的已提交状态。
  const saved = getStep(db, id);
  if (saved === null) {
    throw new LedgerError("step_missing_after_commit", `beginStep: 刚写入的步 ${id} 读不回来`);
  }
  return saved;
}

export interface EndStepOutcome {
  /** true = 这次调用真的改了行；false = 该步已是终态（重复调用/已被恢复处理）。 */
  applied: boolean;
  step: StepRow | null;
}

/**
 * 记结果。
 * - succeeded/failed/interrupted/skipped：只动 pending/started 的行（条件更新），重复调用幂等；
 * - rolled_back：A.11「回退动作本身记账：后续步骤标 rolled_back」，允许把已经 succeeded 的步
 *   标成 rolled_back（但已经 rolled_back 的不再动，保持幂等）。
 * 恢复协议已把步标成 interrupted 之后，迟到回来的端到端结果不会把它改回 succeeded：
 * 真实结局不明时不许冒充成功。
 */
export function endStep(db: LedgerDb, id: string, result: StepResult = {}): EndStepOutcome {
  const nextStatus: string = result.status ?? "succeeded";
  if (!ENDED_STATUSES.has(nextStatus)) {
    throw new LedgerError("bad_status", `endStep: 非法终态 ${nextStatus}`);
  }
  const isRollback = nextStatus === "rolled_back";
  const endedAt = result.ended_at ?? nowIso();

  const changes = inTransaction(db, () => {
    const before = getStep(db, id);
    if (before === null) return 0;

    const allowed = isRollback
      ? before.status !== "rolled_back"
      : FROM_OPEN.has(before.status);
    if (!allowed) return 0;

    db.prepare(
      `UPDATE steps SET
         status = ?,
         result_ref = COALESCE(?, result_ref),
         result_hash = COALESCE(?, result_hash),
         error = COALESCE(?, error),
         ended_at = ?
       WHERE id = ?`,
    ).run(
      nextStatus,
      result.result_ref ?? null,
      result.result_hash ?? null,
      result.error ?? null,
      endedAt,
      id,
    );

    const after = getStep(db, id);
    if (after === null) return 0;
    appendEvent(db, {
      task_id: after.task_id,
      type: isRollback ? "step_rolled_back" : "step_ended",
      payload: {
        step_id: id,
        previous_status: before.status,
        step: snapshotStep(after),
      },
    });
    return 1;
  });

  return { applied: changes > 0, step: getStep(db, id) };
}

/**
 * 恢复协议用：把孤儿步标 interrupted 并上链。返回是否真的改了。
 * 走这里而不是直接 UPDATE，是为了让链和表在恢复之后仍然对得上。
 */
export function markStepInterrupted(db: LedgerDb, id: string, error: string): boolean {
  return inTransaction(db, () => {
    const before = getStep(db, id);
    if (before === null) return false;
    if (!FROM_OPEN.has(before.status)) return false;

    db.prepare(
      `UPDATE steps SET status = 'interrupted', ended_at = ?, error = COALESCE(error, ?)
       WHERE id = ?`,
    ).run(nowIso(), error, id);

    const after = getStep(db, id);
    if (after === null) return false;
    appendEvent(db, {
      task_id: after.task_id,
      type: "step_interrupted",
      payload: {
        step_id: id,
        previous_status: before.status,
        reason: error,
        step: snapshotStep(after),
      },
    });
    return true;
  });
}

/** 某任务未结束的步（恢复协议第 3 步用）。 */
export function openSteps(db: LedgerDb, taskId: string): StepRow[] {
  return db
    .prepare(
      `SELECT * FROM steps WHERE task_id = ? AND status IN ('pending','started')
       ORDER BY seq ASC`,
    )
    .all(taskId) as unknown as StepRow[];
}

/**
 * 这个任务里，同一个 subject_key 有没有已经成功过的步骤（崩溃恢复用）。
 * subject_key = sha256(taskId|tool|canonicalJson(subjectParams))，同一个动作重发会得到同一个键。
 */
export function findSucceededStepBySubjectKey(
  db: LedgerDb,
  taskId: string,
  subjectKey: string,
): StepRow | null {
  const row = db
    .prepare(
      `SELECT * FROM steps WHERE task_id = ? AND subject_key = ? AND status = 'succeeded'
       ORDER BY seq ASC LIMIT 1`,
    )
    .get(taskId, subjectKey) as unknown as StepRow | undefined;
  return row ?? null;
}

/** 某任务的步骤，按 seq。 */
export function listSteps(db: LedgerDb, taskId: string): StepRow[] {
  return db
    .prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY seq ASC")
    .all(taskId) as unknown as StepRow[];
}
