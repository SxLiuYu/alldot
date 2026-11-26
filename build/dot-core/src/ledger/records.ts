/**
 * src/ledger/records.ts —— 其余九张表的写入口（tasks / milestones / plans / approvals /
 * decisions / workers / snapshots / artifacts / spend_ledger），外加两个跨模块共用的约定：
 * A.6 的 subject_key 规范化、tasks.blocked_on_json 的结构。
 *
 * 为什么放在账本里：A.5 说写入口只有 dot-core 的账本，B.4 把「账本唯一写入者」划给 dot-core。
 * 后面 gate/bridge/context/status 只从这里取函数，不各自拼 SQL——否则时间格式、ID 前缀、
 * state_reason、blocked_on 的结构就会各写一套，进度卡和恢复报告对不上。
 *
 * 每个写函数都在一个事务里「改行 + 追加事件」，事件 payload 记住关键字段。
 * （steps 另有逐字段快照比对，见 chain-view.ts；这几张表只上链、不做行比对。）
 */

import type { LedgerDb } from "./db.ts";
import {
  LedgerError,
  canonicalJson,
  inTransaction,
  isoPlus,
  nowIso,
  parseJsonOrNull,
  randomId,
  sha256Bytes,
  sha256Hex,
} from "./db.ts";
import { appendEvent } from "./events.ts";
import { acquireLock, releaseLock } from "./locks.ts";
import type {
  ApprovalKind,
  ApprovalRow,
  ApprovalStatus,
  DecidedBy,
  LockRow,
  TaskRow,
  TaskState,
} from "./types.ts";
import { APPROVAL_STATUSES, TASK_STATES } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// 两个约定：subject_key 与 blocked_on
// ────────────────────────────────────────────────────────────────────────────

/**
 * A.6：`subject_key = sha256(task_id|tool|规范化参数)`。
 * 同一个动作只批一次（B.9 用 uniq_open_approval 兜），所以参数必须先规范化
 * （键排序、去空白由调用方负责），否则同一动作换个键序就成了两张单。
 */
export function computeSubjectKey(taskId: string, tool: string, params: unknown): string {
  return sha256Hex(`${taskId}|${tool}|${canonicalJson(params ?? null)}`);
}

/** tasks.blocked_on_json 的结构（只有 recover.ts 和 task-view.ts 认识它，所以统一在这里定义）。 */
export interface BlockedOn {
  type: "human" | "lock";
  reason?: string;
  approval_ids?: string[];
  step_ids?: string[];
  resource?: string;
}

export function makeBlockedOn(input: BlockedOn): string {
  return canonicalJson(input);
}

export function parseBlockedOn(text: string | null): BlockedOn | null {
  const value = parseJsonOrNull(text);
  if (value === null || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  if (type !== "human" && type !== "lock") return null;
  return value as BlockedOn;
}

// ────────────────────────────────────────────────────────────────────────────
// tasks
// ────────────────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  id?: string;
  parent_id?: string | null;
  intent: string;
  restated?: string | null;
  declared: unknown;
  source: string;
  source_ref?: unknown;
  state?: TaskState;
  state_reason?: string | null;
  blocked_on?: BlockedOn | null;
  milestone_id?: string | null;
  plan_version?: number;
  profile?: string;
  budget_tokens?: number | null;
}

export function createTask(db: LedgerDb, input: CreateTaskInput): TaskRow {
  if (typeof input.intent !== "string" || input.intent.trim().length === 0) {
    throw new LedgerError("bad_intent", "createTask: intent 不能为空");
  }
  if (typeof input.source !== "string" || input.source.length === 0) {
    throw new LedgerError("bad_source", "createTask: source 不能为空");
  }
  const state = input.state ?? "queued";
  if (!(TASK_STATES as readonly string[]).includes(state)) {
    throw new LedgerError("bad_state", `createTask: 非法状态 ${state}`);
  }

  const id = input.id ?? randomId("task");
  const ts = nowIso();

  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (
         id, parent_id, intent, restated, declared_json, state, state_reason,
         blocked_on_json, milestone_id, plan_version, profile, budget_tokens,
         spent_tokens, source, source_ref, run_epoch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?)`,
    ).run(
      id,
      input.parent_id ?? null,
      input.intent,
      input.restated ?? null,
      typeof input.declared === "string" ? input.declared : canonicalJson(input.declared ?? null),
      state,
      input.state_reason ?? null,
      input.blocked_on === undefined || input.blocked_on === null
        ? null
        : makeBlockedOn(input.blocked_on),
      input.milestone_id ?? null,
      input.plan_version ?? 1,
      input.profile ?? "balanced",
      input.budget_tokens ?? null,
      input.source,
      input.source_ref === undefined ? null : canonicalJson(input.source_ref),
      ts,
      ts,
    );
    appendEvent(db, {
      task_id: id,
      type: "task_created",
      payload: { task_id: id, state, source: input.source },
    });
  });

  return getTask(db, id) as TaskRow;
}

export function getTask(db: LedgerDb, id: string): TaskRow | null {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as
    | TaskRow
    | undefined;
  return row ?? null;
}

export interface ListTasksFilter {
  state?: TaskState | TaskState[];
  source?: string;
  parent_id?: string | null;
  limit?: number;
  newestFirst?: boolean;
}

export function listTasks(db: LedgerDb, filter: ListTasksFilter = {}): TaskRow[] {
  const where: string[] = [];
  const params: Array<string | number | null> = [];
  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state];
    where.push(`state IN (${states.map(() => "?").join(",")})`);
    params.push(...states);
  }
  if (filter.source !== undefined) {
    where.push("source = ?");
    params.push(filter.source);
  }
  if (filter.parent_id !== undefined) {
    where.push("parent_id IS ?");
    params.push(filter.parent_id as string);
  }
  const limit = Math.max(1, Math.floor(filter.limit ?? 200));
  const order = filter.newestFirst === false ? "ASC" : "DESC";
  const sql = `SELECT * FROM tasks ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at ${order} LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as unknown as TaskRow[];
}

export interface SetTaskStateInput {
  reason?: string | null;
  blocked_on?: BlockedOn | null;
  milestone_id?: string | null;
  plan_version?: number;
  /** 只在这些状态之一时才生效（条件更新，防并发抢改）。 */
  expect?: TaskState[];
}

/** 改任务状态。返回改后的行；条件不满足返回 null（不抛，调用方看得见）。 */
export function setTaskState(
  db: LedgerDb,
  id: string,
  next: TaskState,
  input: SetTaskStateInput = {},
): TaskRow | null {
  if (!(TASK_STATES as readonly string[]).includes(next)) {
    throw new LedgerError("bad_state", `setTaskState: 非法状态 ${next}`);
  }
  const changed = inTransaction(db, () => {
    const before = getTask(db, id);
    if (before === null) return false;
    if (input.expect !== undefined && !input.expect.includes(before.state)) return false;

    const sets: string[] = ["state = ?", "updated_at = ?"];
    const params: Array<string | null | number> = [next, nowIso()];
    if (input.reason !== undefined) {
      sets.push("state_reason = ?");
      params.push(input.reason);
    }
    if (input.blocked_on !== undefined) {
      sets.push("blocked_on_json = ?");
      params.push(input.blocked_on === null ? null : makeBlockedOn(input.blocked_on));
    }
    if (input.milestone_id !== undefined) {
      sets.push("milestone_id = ?");
      params.push(input.milestone_id);
    }
    if (input.plan_version !== undefined) {
      sets.push("plan_version = ?");
      params.push(input.plan_version);
    }
    params.push(id);

    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    appendEvent(db, {
      task_id: id,
      type: "task_state_changed",
      payload: { task_id: id, from: before.state, to: next, reason: input.reason ?? null },
    });
    return true;
  });
  return changed ? getTask(db, id) : null;
}

/** 取消任务（bridge 的 brain_cancel 用）。从任何非终态都能取消。 */
export function cancelTask(db: LedgerDb, id: string, reason = "cancelled_by_user"): TaskRow | null {
  return setTaskState(db, id, "cancelled", {
    reason,
    blocked_on: null,
    expect: ["queued", "running", "awaiting_approval", "paused"],
  });
}

/**
 * 这个任务被重排过几次（`task_requeued` 事件计数，B.8 没有 attempt 列）。
 *
 * 给了 `reasonPrefix` 就只数**理由以它开头**的那几次。派发器要用这个口径：
 * 里程碑推进、超时补救也走 requeueTask，混在一起数的话「派发通道连续失败 3 次」
 * 会被不相干的重排提前凑满（2026-11-25 评审指出）。
 */
export function requeueAttempts(db: LedgerDb, taskId: string, reasonPrefix?: string): number {
  const row = (
    reasonPrefix === undefined
      ? db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task_requeued' AND task_id = ?")
          .get(taskId)
      : db
          .prepare(
            `SELECT COUNT(*) AS n FROM events
             WHERE type = 'task_requeued' AND task_id = ?
               AND json_extract(payload_json, '$.reason') LIKE ?`,
          )
          .get(taskId, `${reasonPrefix}%`)
  ) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export interface RequeueTaskInput {
  reason: string;
  /**
   * 默认 true：run_epoch +1，旧工人被 fencing（A.9 第 2 条）。
   * 重排之后旧会话的 beginStep 会吃到 stale_writer，这是「会话超时后旧工人还能动手」的正解。
   */
  bumpEpoch?: boolean;
  /** 只在这些状态之一时才生效，默认 awaiting_approval / paused / running。 */
  expect?: TaskState[];
}

/**
 * 把任务放回 queued，让派发器重新领。用来接住两种「没人管」的停滞：
 * - 会话超时 → paused（派发器有次数上限地重排一次，见 src/dispatch/scheduler.ts）；
 * - 等审批 → 人批了（src/dispatch/resume.ts，桥的决定路由调它）。
 *
 * 条件更新（`WHERE id=? AND state=?`）+ 同事务追加事件，和 rest 状态机同口径。
 */
export function requeueTask(db: LedgerDb, id: string, input: RequeueTaskInput): TaskRow | null {
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new LedgerError("bad_reason", "requeueTask: reason 不能为空");
  }
  const expect = input.expect ?? ["awaiting_approval", "paused", "running"];
  const bump = input.bumpEpoch !== false;

  const changed = inTransaction(db, () => {
    const before = getTask(db, id);
    if (before === null) return false;
    if (!expect.includes(before.state)) return false;

    const nextEpoch = Number(before.run_epoch) + (bump ? 1 : 0);
    const ts = nowIso();
    const info = db
      .prepare(
        `UPDATE tasks SET state = 'queued', state_reason = ?, blocked_on_json = NULL,
           run_epoch = ?, updated_at = ?
         WHERE id = ? AND state = ?`,
      )
      .run(input.reason, nextEpoch, ts, id, before.state);
    if (Number(info.changes) === 0) return false;

    appendEvent(db, {
      task_id: id,
      type: "task_requeued",
      payload: {
        task_id: id,
        attempt: requeueAttempts(db, id) + 1,
        reason: input.reason,
        from: before.state,
        to: "queued",
        run_epoch: nextEpoch,
      },
    });
    appendEvent(db, {
      task_id: id,
      type: "task_state_changed",
      payload: { task_id: id, from: before.state, to: "queued", reason: input.reason },
    });
    return true;
  });

  return changed ? getTask(db, id) : null;
}

/** 给任务加/减已花 token（spend_ledger 记账时同步进度卡的预算行）。 */
export function addSpentTokens(db: LedgerDb, taskId: string, delta: number): void {
  if (!Number.isFinite(delta)) return;
  db.prepare("UPDATE tasks SET spent_tokens = spent_tokens + ?, updated_at = ? WHERE id = ?").run(
    Math.max(0, Math.floor(delta)),
    nowIso(),
    taskId,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// milestones / plans
// ────────────────────────────────────────────────────────────────────────────

export interface MilestoneRow {
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

export function createMilestone(
  db: LedgerDb,
  input: {
    id?: string;
    task_id: string;
    seq: number;
    title: string;
    done_when: string;
    state?: "pending" | "active" | "done" | "skipped";
  },
): MilestoneRow {
  const id = input.id ?? randomId("ms");
  const state = input.state ?? "pending";
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO milestones (id, task_id, seq, title, done_when, summary, state, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    ).run(id, input.task_id, input.seq, input.title, input.done_when, state, nowIso());
    appendEvent(db, {
      task_id: input.task_id,
      type: "milestone_created",
      payload: { milestone_id: id, seq: input.seq, title: input.title, state },
    });
  });
  return getMilestone(db, id) as MilestoneRow;
}

export function getMilestone(db: LedgerDb, id: string): MilestoneRow | null {
  const row = db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as unknown as
    | MilestoneRow
    | undefined;
  return row ?? null;
}

export function listMilestones(db: LedgerDb, taskId: string): MilestoneRow[] {
  return db
    .prepare("SELECT * FROM milestones WHERE task_id = ? ORDER BY seq ASC")
    .all(taskId) as unknown as MilestoneRow[];
}

/** 里程碑收尾：state/summary/ended_at 一起更新（A.10 的阶段小结写在这里）。 */
export function updateMilestone(
  db: LedgerDb,
  id: string,
  input: {
    state?: "pending" | "active" | "done" | "skipped";
    summary?: string | null;
    ended_at?: string | null;
  },
): MilestoneRow | null {
  const changed = inTransaction(db, () => {
    const before = getMilestone(db, id);
    if (before === null) return false;
    db.prepare(
      `UPDATE milestones SET
         state = COALESCE(?, state),
         summary = COALESCE(?, summary),
         ended_at = COALESCE(?, ended_at)
       WHERE id = ?`,
    ).run(input.state ?? null, input.summary ?? null, input.ended_at ?? null, id);
    appendEvent(db, {
      task_id: String(before.task_id),
      type: "milestone_updated",
      payload: {
        milestone_id: id,
        from: before.state,
        to: input.state ?? before.state,
        summary_written: input.summary !== undefined && input.summary !== null,
      },
    });
    return true;
  });
  return changed ? getMilestone(db, id) : null;
}

export interface PlanRow {
  id: string;
  task_id: string;
  version: number;
  milestone_id: string | null;
  content_json: string;
  why: string | null;
  created_at: string;
}

export function createPlan(
  db: LedgerDb,
  input: {
    id?: string;
    task_id: string;
    version: number;
    milestone_id?: string | null;
    content: unknown;
    why?: string | null;
  },
): PlanRow {
  const id = input.id ?? randomId("plan");
  const content =
    typeof input.content === "string" ? input.content : canonicalJson(input.content ?? null);
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO plans (id, task_id, version, milestone_id, content_json, why, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.task_id,
      input.version,
      input.milestone_id ?? null,
      content,
      input.why ?? null,
      nowIso(),
    );
    appendEvent(db, {
      task_id: input.task_id,
      type: "plan_created",
      payload: { plan_id: id, version: input.version, why: input.why ?? null },
    });
  });
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as unknown as PlanRow;
}

export function latestPlan(db: LedgerDb, taskId: string): PlanRow | null {
  const row = db
    .prepare("SELECT * FROM plans WHERE task_id = ? ORDER BY version DESC, created_at DESC LIMIT 1")
    .get(taskId) as unknown as PlanRow | undefined;
  return row ?? null;
}

export function listPlans(db: LedgerDb, taskId: string): PlanRow[] {
  return db
    .prepare("SELECT * FROM plans WHERE task_id = ? ORDER BY version ASC")
    .all(taskId) as unknown as PlanRow[];
}

// ────────────────────────────────────────────────────────────────────────────
// approvals（B.9 状态机）
// ────────────────────────────────────────────────────────────────────────────

export interface CreateApprovalInput {
  id?: string;
  task_id?: string | null;
  step_id?: string | null;
  kind?: ApprovalKind;
  tier: number;
  title: string;
  detail: unknown;
  subject_key: string;
  ttlMs?: number;
  now?: Date;
}

/**
 * 建审批单。A.6 的幂等口径：同一个 subject_key 已有活动单（pending/approved/executing）
 * 就复用那张，不新建——重发同一动作永远只批一次。返回 { approval, reused }。
 */
export function createApproval(
  db: LedgerDb,
  input: CreateApprovalInput,
): { approval: ApprovalRow; reused: boolean } {
  const at = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 24 * 3_600_000;

  return inTransaction(db, () => {
    const open = db
      .prepare(
        `SELECT * FROM approvals
         WHERE subject_key = ? AND status IN ('pending','approved','executing')
         LIMIT 1`,
      )
      .get(input.subject_key) as unknown as ApprovalRow | undefined;
    if (open !== undefined) return { approval: open, reused: true };

    const id = input.id ?? randomId("apv");
    db.prepare(
      `INSERT INTO approvals (
         id, task_id, step_id, kind, tier, title, detail_json, subject_key,
         status, decided_by, decision_note, pending_until, created_at, decided_at, executed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL)`,
    ).run(
      id,
      input.task_id ?? null,
      input.step_id ?? null,
      input.kind ?? "tool_call",
      input.tier,
      input.title,
      typeof input.detail === "string" ? input.detail : canonicalJson(input.detail ?? null),
      input.subject_key,
      isoPlus(ttlMs, at),
      nowIso(at),
    );
    appendEvent(db, {
      task_id: input.task_id ?? null,
      type: "approval_created",
      payload: {
        approval_id: id,
        task_id: input.task_id ?? null,
        step_id: input.step_id ?? null,
        kind: input.kind ?? "tool_call",
        tier: input.tier,
        subject_key: input.subject_key,
        pending_until: isoPlus(ttlMs, at),
      },
    });
    return { approval: getApproval(db, id) as ApprovalRow, reused: false };
  });
}

export function getApproval(db: LedgerDb, id: string): ApprovalRow | null {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as unknown as
    | ApprovalRow
    | undefined;
  return row ?? null;
}

export function findOpenApprovalBySubjectKey(db: LedgerDb, subjectKey: string): ApprovalRow | null {
  const row = db
    .prepare(
      `SELECT * FROM approvals
       WHERE subject_key = ? AND status IN ('pending','approved','executing')
       LIMIT 1`,
    )
    .get(subjectKey) as unknown as ApprovalRow | undefined;
  return row ?? null;
}

export function listApprovals(
  db: LedgerDb,
  filter: { task_id?: string; status?: ApprovalStatus | ApprovalStatus[]; limit?: number } = {},
): ApprovalRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.task_id !== undefined) {
    where.push("task_id = ?");
    params.push(filter.task_id);
  }
  if (filter.status !== undefined) {
    const list = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`status IN (${list.map(() => "?").join(",")})`);
    params.push(...list);
  }
  params.push(Math.max(1, Math.floor(filter.limit ?? 200)));
  return db
    .prepare(
      `SELECT * FROM approvals ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as unknown as ApprovalRow[];
}

export function listOpenApprovals(db: LedgerDb, taskId?: string): ApprovalRow[] {
  const rows =
    taskId === undefined
      ? (db
          .prepare(
            `SELECT * FROM approvals WHERE status IN ('pending','approved','executing')
             ORDER BY created_at ASC`,
          )
          .all() as unknown as ApprovalRow[])
      : (db
          .prepare(
            `SELECT * FROM approvals WHERE task_id = ? AND status IN ('pending','approved','executing')
             ORDER BY created_at ASC`,
          )
          .all(taskId) as unknown as ApprovalRow[]);
  return rows;
}

/**
 * 条件更新落账（B.9）：`UPDATE ... WHERE id=? AND status='pending'`。
 * 返回是否真的改了：false = 已被别人决过/已过期，调用方按幂等重复处理，不报错。
 */
export function decideApproval(
  db: LedgerDb,
  id: string,
  input: { decision: "approved" | "rejected"; decidedBy: DecidedBy; note?: string | null },
): boolean {
  const next: ApprovalStatus = input.decision;
  return inTransaction(db, () => {
    const info = db
      .prepare(
        `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(next, input.decidedBy, nowIso(), input.note ?? null, id);
    if (Number(info.changes) === 0) return false;
    const row = getApproval(db, id);
    appendEvent(db, {
      task_id: row?.task_id === undefined || row === null ? null : String(row.task_id),
      type: "approval_decided",
      payload: {
        approval_id: id,
        to: next,
        decided_by: input.decidedBy,
        note: input.note ?? null,
      },
    });
    return true;
  });
}

/** approved → executing（闸门放行前调用）。 */
export function markApprovalExecuting(db: LedgerDb, id: string): boolean {
  return inTransaction(db, () => {
    const info = db
      .prepare("UPDATE approvals SET status = 'executing' WHERE id = ? AND status = 'approved'")
      .run(id);
    if (Number(info.changes) === 0) return false;
    const row = getApproval(db, id);
    appendEvent(db, {
      task_id: row === null ? null : String(row.task_id),
      type: "approval_executing",
      payload: { approval_id: id },
    });
    return true;
  });
}

/** executing → executed / failed（一次性消耗；之后再做同一动作要新批单）。 */
export function markApprovalExecuted(db: LedgerDb, id: string, ok: boolean): boolean {
  const next: ApprovalStatus = ok ? "executed" : "failed";
  return inTransaction(db, () => {
    const info = db
      .prepare("UPDATE approvals SET status = ?, executed_at = ? WHERE id = ? AND status = 'executing'")
      .run(next, nowIso(), id);
    if (Number(info.changes) === 0) return false;
    const row = getApproval(db, id);
    appendEvent(db, {
      task_id: row === null ? null : String(row.task_id),
      type: "approval_executed",
      payload: { approval_id: id, to: next },
    });
    return true;
  });
}

/** 撤销（任何态都能撤，B.9「任何态 --撤销--> revoked」）。 */
export function revokeApproval(db: LedgerDb, id: string, note?: string | null): boolean {
  return inTransaction(db, () => {
    const info = db
      .prepare(
        "UPDATE approvals SET status = 'revoked', decision_note = COALESCE(?, decision_note) WHERE id = ? AND status != 'revoked'",
      )
      .run(note ?? null, id);
    if (Number(info.changes) === 0) return false;
    const row = getApproval(db, id);
    appendEvent(db, {
      task_id: row === null ? null : String(row.task_id),
      type: "approval_revoked",
      payload: { approval_id: id },
    });
    return true;
  });
}

/** TTL 到期：pending 且 pending_until < now → expired。返回过期条数。 */
export function expireDueApprovals(db: LedgerDb, at: Date = new Date()): number {
  const nowText = nowIso(at);
  return inTransaction(db, () => {
    const rows = db
      .prepare("SELECT id, task_id FROM approvals WHERE status = 'pending' AND pending_until < ?")
      .all(nowText) as Array<{ id?: string; task_id?: string | null }>;
    if (rows.length === 0) return 0;
    db.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND pending_until < ?").run(
      nowText,
    );
    for (const r of rows) {
      appendEvent(db, {
        task_id: r.task_id === undefined ? null : r.task_id,
        type: "approval_expired",
        payload: { approval_id: String(r.id), at: nowText },
      });
    }
    return rows.length;
  });
}

/** 校验状态枚举是否合法（桥/闸门解析外部输入时用）。 */
export function isApprovalStatus(value: string): value is ApprovalStatus {
  return (APPROVAL_STATUSES as readonly string[]).includes(value);
}

// ────────────────────────────────────────────────────────────────────────────
// decisions
// ────────────────────────────────────────────────────────────────────────────

export interface DecisionRow {
  id: string;
  task_id: string;
  question: string;
  answer: string;
  decided_by: string;
  created_at: string;
}

export function recordDecision(
  db: LedgerDb,
  input: { id?: string; task_id: string; question: string; answer: string; decided_by: string },
): DecisionRow {
  const id = input.id ?? randomId("dec");
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO decisions (id, task_id, question, answer, decided_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.task_id, input.question, input.answer, input.decided_by, nowIso());
    appendEvent(db, {
      task_id: input.task_id,
      type: "decision_recorded",
      payload: { decision_id: id, decided_by: input.decided_by, question: input.question },
    });
  });
  return db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as unknown as DecisionRow;
}

export function listDecisions(db: LedgerDb, taskId: string): DecisionRow[] {
  return db
    .prepare("SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId) as unknown as DecisionRow[];
}

// ────────────────────────────────────────────────────────────────────────────
// workers
// ────────────────────────────────────────────────────────────────────────────

export interface WorkerRow {
  id: string;
  task_id: string;
  role: string;
  session_key: string;
  model: string | null;
  status: string;
  run_epoch: number;
  last_event_at: string | null;
}

export function upsertWorker(
  db: LedgerDb,
  input: {
    id: string;
    task_id: string;
    role: string;
    session_key: string;
    model?: string | null;
    status: string;
    run_epoch: number;
  },
): WorkerRow {
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO workers (id, task_id, role, session_key, model, status, run_epoch, last_event_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_id = excluded.task_id, role = excluded.role, session_key = excluded.session_key,
         model = excluded.model, status = excluded.status, run_epoch = excluded.run_epoch,
         last_event_at = excluded.last_event_at`,
    ).run(
      input.id,
      input.task_id,
      input.role,
      input.session_key,
      input.model ?? null,
      input.status,
      input.run_epoch,
      nowIso(),
    );
    appendEvent(db, {
      task_id: input.task_id,
      type: "worker_upserted",
      payload: { worker_id: input.id, role: input.role, status: input.status, run_epoch: input.run_epoch },
    });
  });
  return db.prepare("SELECT * FROM workers WHERE id = ?").get(input.id) as unknown as WorkerRow;
}

export function listWorkers(db: LedgerDb, taskId: string): WorkerRow[] {
  return db
    .prepare("SELECT * FROM workers WHERE task_id = ? ORDER BY id ASC")
    .all(taskId) as unknown as WorkerRow[];
}

// ────────────────────────────────────────────────────────────────────────────
// claimTask —— 派发器认领任务（方案 A.9 第 3 步的入口）
//
// 认领必须是**一个事务**：条件更新把 queued→running，同时写 workers 行、抢 task 锁、
// 把 worker.run_epoch 对齐任务当前值。拆成几个事务就会出现「状态已 running 但没有
// worker 行」或「worker 拿旧 epoch 干活」的中间态，恢复协议也会读到一个说不清的任务。
//
// 防重复领的判据是 `UPDATE ... WHERE state='queued'` 的 affected 行数，不是先读后写：
// 两个连接同时认领时，第二个会等 busy_timeout 拿到写锁，再执行到同一条 UPDATE，
// 那时行已经是 running，changes=0，直接放弃。
// ────────────────────────────────────────────────────────────────────────────

export interface ClaimTaskInput {
  /** 工人 id（写进 workers.id 与 locks.worker_id）。 */
  workerId: string;
  /** workers.role，默认 "worker"。 */
  role?: string;
  /** A.8：工人会话键 `task:<task_id>`。 */
  sessionKey: string;
  model?: string | null;
  /** 锁资源名，默认 `task:<task_id>`。 */
  lockResource?: string;
  /** 租期毫秒，默认 60 秒（与 acquireLock 一致）。会话期间要定时 renewLock。 */
  lockTtlMs?: number;
}

export interface ClaimTaskResult {
  claimed: boolean;
  reason: "claimed" | "task_not_found" | "not_queued" | "lock_held";
  task: TaskRow | null;
  worker: WorkerRow | null;
  lock: LockRow | null;
  /** reason='lock_held' 时是谁拿着。 */
  heldBy: { taskId: string; workerId: string; expiresAt: string } | null;
}

export function claimTask(db: LedgerDb, id: string, input: ClaimTaskInput): ClaimTaskResult {
  if (typeof id !== "string" || id.length === 0) {
    throw new LedgerError("bad_task", "claimTask: task id 不能为空");
  }
  if (typeof input.workerId !== "string" || input.workerId.length === 0) {
    throw new LedgerError("bad_worker", "claimTask: workerId 不能为空");
  }
  if (typeof input.sessionKey !== "string" || input.sessionKey.length === 0) {
    throw new LedgerError("bad_session", "claimTask: sessionKey 不能为空");
  }

  const resource = input.lockResource ?? `task:${id}`;

  return inTransaction(db, () => {
    const before = getTask(db, id);
    if (before === null) {
      return {
        claimed: false,
        reason: "task_not_found" as const,
        task: null,
        worker: null,
        lock: null,
        heldBy: null,
      };
    }
    if (before.state !== "queued") {
      return {
        claimed: false,
        reason: "not_queued" as const,
        task: before,
        worker: null,
        lock: null,
        heldBy: null,
      };
    }

    // 先抢锁：抢不到就原样返回，任务状态一点都不动（不用回滚）。
    const lock = acquireLock(db, resource, {
      taskId: id,
      workerId: input.workerId,
      ttlMs: input.lockTtlMs,
    });
    if (!lock.acquired) {
      return {
        claimed: false,
        reason: "lock_held" as const,
        task: before,
        worker: null,
        lock: null,
        heldBy: lock.heldBy,
      };
    }

    const info = db
      .prepare(
        `UPDATE tasks SET state = 'running', state_reason = NULL, blocked_on_json = NULL,
           updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(nowIso(), id);

    if (Number(info.changes) === 0) {
      // 同事务里走到这里说明不是并发（写锁已经在手上），只可能是行被删了；
      // 兜底把刚拿的锁还回去，别留一把没有主人的锁。
      releaseLock(db, resource, { taskId: id, workerId: input.workerId });
      return {
        claimed: false,
        reason: "not_queued" as const,
        task: getTask(db, id),
        worker: null,
        lock: null,
        heldBy: null,
      };
    }

    appendEvent(db, {
      task_id: id,
      type: "task_state_changed",
      payload: { task_id: id, from: "queued", to: "running", reason: "claimed", worker_id: input.workerId },
    });

    const claimed = getTask(db, id) as TaskRow;
    const worker = upsertWorker(db, {
      id: input.workerId,
      task_id: id,
      role: input.role ?? "worker",
      session_key: input.sessionKey,
      model: input.model ?? null,
      status: "running",
      run_epoch: Number(claimed.run_epoch),
    });

    return { claimed: true, reason: "claimed" as const, task: claimed, worker, lock: lock.lock, heldBy: null };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// snapshots
// ────────────────────────────────────────────────────────────────────────────

export interface SnapshotRow {
  id: string;
  task_id: string;
  milestone_id: string | null;
  kind: string;
  ref: string;
  restore_json: string | null;
  created_at: string;
}

export function createSnapshot(
  db: LedgerDb,
  input: {
    id?: string;
    task_id: string;
    milestone_id?: string | null;
    kind: "git" | "copy" | "browser" | "desktop_list";
    ref: string;
    restore?: unknown;
  },
): SnapshotRow {
  const id = input.id ?? randomId("snap");
  const ts = nowIso();
  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO snapshots (id, task_id, milestone_id, kind, ref, restore_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.task_id,
      input.milestone_id ?? null,
      input.kind,
      input.ref,
      input.restore === undefined ? null : canonicalJson(input.restore),
      ts,
    );
    appendEvent(db, {
      task_id: input.task_id,
      type: "snapshot_created",
      payload: { snapshot_id: id, kind: input.kind, ref: input.ref },
    });
  });
  return db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as unknown as SnapshotRow;
}

export function listSnapshots(db: LedgerDb, taskId: string): SnapshotRow[] {
  return db
    .prepare("SELECT * FROM snapshots WHERE task_id = ? ORDER BY created_at DESC")
    .all(taskId) as unknown as SnapshotRow[];
}

// ────────────────────────────────────────────────────────────────────────────
// artifacts（按内容哈希存，B.8 主键就是 hash）
// ────────────────────────────────────────────────────────────────────────────

export interface ArtifactMeta {
  hash: string;
  created_at: string;
  bytes: number;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

/**
 * 存明细全文。哈希由内容算出来、不带时间戳：同一份明细永远同一个链接（A.10）。
 * 已存在就直接返回（内容相同，创建时间保留最早那次）。
 */
export function putArtifact(db: LedgerDb, content: string | Uint8Array): ArtifactMeta {
  const bytes = typeof content === "string" ? utf8.encode(content) : content;
  const hash = sha256Bytes(bytes);

  return inTransaction(db, () => {
    const existing = db
      .prepare("SELECT hash, created_at, length(content) AS bytes FROM artifacts WHERE hash = ?")
      .get(hash) as { hash?: string; created_at?: string; bytes?: number } | undefined;
    if (existing !== undefined) {
      return {
        hash: String(existing.hash),
        created_at: String(existing.created_at),
        bytes: Number(existing.bytes ?? bytes.byteLength),
      };
    }
    const createdAt = nowIso();
    db.prepare("INSERT INTO artifacts (hash, content, created_at) VALUES (?, ?, ?)").run(
      hash,
      bytes,
      createdAt,
    );
    appendEvent(db, {
      type: "artifact_put",
      payload: { hash, bytes: bytes.byteLength },
    });
    return { hash, created_at: createdAt, bytes: bytes.byteLength };
  });
}

export type ArtifactLookup =
  | { found: true; hash: string; content: string; createdAt: string }
  | { found: false; hash: string; collected: true };

/**
 * 取全文。找不到就是「已被回收」——B.7 明确要求返回「已回收·原因」，不返回空。
 * 具体返回文案由桥拼，这里只给 collected 标记。
 */
export function getArtifact(db: LedgerDb, hash: string): ArtifactLookup {
  const row = db
    .prepare("SELECT hash, content, created_at FROM artifacts WHERE hash = ?")
    .get(hash) as { hash?: string; content?: Uint8Array; created_at?: string } | undefined;
  if (row === undefined || row.content === undefined) {
    return { found: false, hash, collected: true };
  }
  return {
    found: true,
    hash: String(row.hash),
    content: utf8Decoder.decode(row.content),
    createdAt: String(row.created_at),
  };
}

/**
 * 这个明细哈希是不是**这个任务**的东西：要么被该任务的某一步引用（args_ref / result_ref），
 * 要么出现在该任务某条快照的 restore 清单里（整目录快照的 entries[].hash）。
 *
 * artifacts 是按内容哈希存的、没有 task_id 列，所以「归属」只能按引用关系反查。
 * dot_recall 用它挡跨任务串读（src/context/recall.ts）。查不到引用就按「不是这个任务的」处理。
 */
export function artifactBelongsToTask(db: LedgerDb, taskId: string, hash: string): boolean {
  const step = db
    .prepare("SELECT 1 AS hit FROM steps WHERE task_id = ? AND (args_ref = ? OR result_ref = ?) LIMIT 1")
    .get(taskId, hash, hash) as { hit?: number } | undefined;
  if (step !== undefined) return true;
  const snap = db
    .prepare("SELECT 1 AS hit FROM snapshots WHERE task_id = ? AND restore_json LIKE ? LIMIT 1")
    .get(taskId, `%${hash}%`) as { hit?: number } | undefined;
  return snap !== undefined;
}

export function listArtifacts(db: LedgerDb, limit = 200): ArtifactMeta[] {  return db
    .prepare(
      `SELECT hash, created_at, length(content) AS bytes FROM artifacts
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.floor(limit))) as unknown as ArtifactMeta[];
}

/** 维护用：删一批 artifact（回收逻辑由 src/maintenance 决定删谁）。 */
export function deleteArtifacts(db: LedgerDb, hashes: string[]): number {
  if (hashes.length === 0) return 0;
  return inTransaction(db, () => {
    let removed = 0;
    const stmt = db.prepare("DELETE FROM artifacts WHERE hash = ?");
    for (const h of hashes) {
      const info = stmt.run(h);
      const n = Number(info.changes);
      if (n > 0) {
        removed += n;
        appendEvent(db, { type: "artifact_deleted", payload: { hash: h } });
      }
    }
    return removed;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// spend_ledger
// ────────────────────────────────────────────────────────────────────────────

export interface SpendRow {
  id: string;
  task_id: string | null;
  worker_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

/** A.13：花费从 llm_output 钩子的 usage 记进来；同时累加 tasks.spent_tokens。 */
export function recordSpend(
  db: LedgerDb,
  input: {
    id?: string;
    task_id?: string | null;
    worker_id?: string | null;
    model?: string | null;
    input_tokens?: number;
    output_tokens?: number;
  },
): SpendRow {
  const id = input.id ?? randomId("spend");
  const inTok = Math.max(0, Math.floor(input.input_tokens ?? 0));
  const outTok = Math.max(0, Math.floor(input.output_tokens ?? 0));

  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO spend_ledger (id, task_id, worker_id, model, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.task_id ?? null, input.worker_id ?? null, input.model ?? null, inTok, outTok, nowIso());
    appendEvent(db, {
      task_id: input.task_id ?? null,
      type: "spend_recorded",
      payload: { spend_id: id, model: input.model ?? null, input_tokens: inTok, output_tokens: outTok },
    });
    if (input.task_id !== undefined && input.task_id !== null) {
      db.prepare("UPDATE tasks SET spent_tokens = spent_tokens + ?, updated_at = ? WHERE id = ?").run(
        inTok + outTok,
        nowIso(),
        input.task_id,
      );
    }
  });

  return db.prepare("SELECT * FROM spend_ledger WHERE id = ?").get(id) as unknown as SpendRow;
}

export function sumSpend(db: LedgerDb, taskId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)), 0) AS n
       FROM spend_ledger WHERE task_id = ?`,
    )
    .get(taskId) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export function listSpend(db: LedgerDb, taskId: string): SpendRow[] {
  return db
    .prepare("SELECT * FROM spend_ledger WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId) as unknown as SpendRow[];
}
