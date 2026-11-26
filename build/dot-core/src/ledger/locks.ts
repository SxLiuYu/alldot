/**
 * src/ledger/locks.ts —— 单例锁表。方案 B.8 的 locks 表：resource 主键，
 * 一行代表一把锁，expires_at 到期即可被别人接管（A.9 第 4 步释放过期锁）。
 *
 * 抢锁必须在 BEGIN IMMEDIATE 事务里读+写，否则两个连接会同时读到「没有行」
 * 再同时插入（主键冲突只是一个报错，不是「只有一个成功」的语义）。
 * 有了 busy_timeout，第二个写者会排队；等到写锁后重读，看到的是第一个已提交的行，
 * 于是返回 acquired=false 而不是抛错。
 *
 * 每次取得/续租/释放都在同一个事务里追加一条事件（payload 带 resource 与属主），
 * 这样「谁在什么时候拿了哪把锁」也在指纹链上。
 */

import type { LedgerDb } from "./db.ts";
import { LedgerError, inTransaction, isoPlus, nowIso } from "./db.ts";
import { appendEvent } from "./events.ts";
import type { LockRow } from "./types.ts";

export interface LockOwner {
  taskId: string;
  workerId: string;
}

export interface AcquireLockOptions extends LockOwner {
  /** 租期，毫秒。到点未续期即视为失效。默认 60 秒。 */
  ttlMs?: number;
  /** 允许接管「已过期」的行（默认允许，A.9 第 4 步的口径）。 */
  takeoverExpired?: boolean;
}

export interface AcquireLockResult {
  acquired: boolean;
  /** 'acquired' 新拿 / 'renewed' 同属主续期 / 'held' 被别人拿着。 */
  reason: "acquired" | "renewed" | "held";
  lock: LockRow | null;
  /** 被谁拿着（acquired=false 时有值，给「卡在谁」用）。 */
  heldBy: { taskId: string; workerId: string; expiresAt: string } | null;
}

function readLock(db: LedgerDb, resource: string): LockRow | null {
  const row = db.prepare("SELECT * FROM locks WHERE resource = ?").get(resource) as unknown as
    | LockRow
    | undefined;
  return row ?? null;
}

export function getLock(db: LedgerDb, resource: string): LockRow | null {
  return readLock(db, resource);
}

function auditLock(
  db: LedgerDb,
  type: string,
  resource: string,
  row: LockRow | null,
  extra: Record<string, unknown> = {},
): void {
  appendEvent(db, {
    task_id: row?.task_id === undefined || row === null ? null : String(row.task_id),
    type,
    payload: {
      resource,
      task_id: row?.task_id ?? extra.task_id ?? null,
      worker_id: row?.worker_id ?? extra.worker_id ?? null,
      expires_at: row?.expires_at ?? null,
      ...extra,
    },
  });
}

/**
 * 拿锁。同一属主多次调用同一把锁 → reason='renewed'（幂等）。
 * 过期行可以被任何属主接管。
 */
export function acquireLock(
  db: LedgerDb,
  resource: string,
  opts: AcquireLockOptions,
): AcquireLockResult {
  if (typeof resource !== "string" || resource.length === 0) {
    throw new LedgerError("bad_resource", "acquireLock: resource 不能为空");
  }
  if (typeof opts.taskId !== "string" || opts.taskId.length === 0) {
    throw new LedgerError("bad_task", "acquireLock: taskId 不能为空");
  }
  if (typeof opts.workerId !== "string" || opts.workerId.length === 0) {
    throw new LedgerError("bad_worker", "acquireLock: workerId 不能为空");
  }

  const ttlMs = Math.max(1, Math.floor(opts.ttlMs ?? 60_000));
  const allowTakeover = opts.takeoverExpired !== false;

  return inTransaction(db, () => {
    const now = new Date();
    const nowText = nowIso(now);
    const expiresAt = isoPlus(ttlMs, now);
    const row = readLock(db, resource);

    if (row === null) {
      db.prepare(
        `INSERT INTO locks (resource, task_id, worker_id, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(resource, opts.taskId, opts.workerId, nowText, nowText, expiresAt);
      const saved = readLock(db, resource);
      auditLock(db, "lock_acquired", resource, saved);
      return { acquired: true, reason: "acquired", lock: saved, heldBy: null };
    }

    const expired = String(row.expires_at) < nowText;
    const sameOwner = row.task_id === opts.taskId && row.worker_id === opts.workerId;

    if (!expired && !sameOwner) {
      return {
        acquired: false,
        reason: "held",
        lock: null,
        heldBy: {
          taskId: String(row.task_id),
          workerId: String(row.worker_id),
          expiresAt: String(row.expires_at),
        },
      };
    }

    if (expired && !sameOwner && !allowTakeover) {
      return {
        acquired: false,
        reason: "held",
        lock: null,
        heldBy: {
          taskId: String(row.task_id),
          workerId: String(row.worker_id),
          expiresAt: String(row.expires_at),
        },
      };
    }

    // 同属主续期，或接管过期行。
    db.prepare(
      `UPDATE locks SET task_id = ?, worker_id = ?, heartbeat_at = ?, expires_at = ?
       WHERE resource = ?`,
    ).run(opts.taskId, opts.workerId, nowText, expiresAt, resource);

    const after = readLock(db, resource);
    auditLock(db, sameOwner ? "lock_renewed" : "lock_took_over", resource, after, {
      previous_owner: sameOwner ? null : row.worker_id,
    });
    return {
      acquired: true,
      reason: sameOwner ? "renewed" : "acquired",
      lock: after,
      heldBy: null,
    };
  });
}

/**
 * 续租。只有属主能续，且行还没过期（过期就该重新走抢锁，让别人有机会赢）。
 * 返回 false = 没续上，调用方应当收手。
 */
export function renewLock(
  db: LedgerDb,
  resource: string,
  owner: LockOwner,
  ttlMs = 60_000,
): boolean {
  return inTransaction(db, () => {
    const now = new Date();
    const nowText = nowIso(now);
    const expiresAt = isoPlus(Math.max(1, Math.floor(ttlMs)), now);

    const info = db
      .prepare(
        `UPDATE locks SET heartbeat_at = ?, expires_at = ?
         WHERE resource = ? AND task_id = ? AND worker_id = ? AND expires_at >= ?`,
      )
      .run(nowText, expiresAt, resource, owner.taskId, owner.workerId, nowText);
    if (Number(info.changes) === 0) return false;
    auditLock(db, "lock_renewed", resource, readLock(db, resource));
    return true;
  });
}

/**
 * 放锁。给了 owner 就只放自己的（防止误删别人的锁）；
 * 不给 owner 就是强制清（恢复报告/一键停用，调用方自负）。
 */
export function releaseLock(db: LedgerDb, resource: string, owner?: LockOwner): boolean {
  return inTransaction(db, () => {
    const before = readLock(db, resource);
    if (before === null) return false;
    if (
      owner !== undefined &&
      (before.task_id !== owner.taskId || before.worker_id !== owner.workerId)
    ) {
      return false;
    }
    db.prepare("DELETE FROM locks WHERE resource = ?").run(resource);
    auditLock(db, "lock_released", resource, before);
    return true;
  });
}

/** A.9 第 4 步：释放所有已过期的锁，返回被释放的行。 */
export function releaseExpiredLocks(db: LedgerDb, at: Date = new Date()): LockRow[] {
  const nowText = nowIso(at);
  return inTransaction(db, () => {
    const rows = db
      .prepare("SELECT * FROM locks WHERE expires_at < ? ORDER BY expires_at ASC")
      .all(nowText) as unknown as LockRow[];
    if (rows.length > 0) {
      db.prepare("DELETE FROM locks WHERE expires_at < ?").run(nowText);
      for (const row of rows) {
        auditLock(db, "lock_released", String(row.resource), row, { reason: "expired" });
      }
    }
    return rows;
  });
}

/**
 * 恢复协议用：任务要被重排/等审批时，它旧 worker 名下的锁必须一起放开。
 * 理由：run_epoch 已经 +1，旧 worker 被 fencing 掉，它的租约不再代表任何活着的执行者；
 * 留着的话新 worker 抢同一把锁会输给自己的「幽灵」，状态页还会显示「等自己放锁」。
 */
export function releaseLocksOfTask(db: LedgerDb, taskId: string, reason = "fenced"): LockRow[] {
  return inTransaction(db, () => {
    const rows = db
      .prepare("SELECT * FROM locks WHERE task_id = ? ORDER BY resource ASC")
      .all(taskId) as unknown as LockRow[];
    if (rows.length > 0) {
      db.prepare("DELETE FROM locks WHERE task_id = ?").run(taskId);
      for (const row of rows) {
        auditLock(db, "lock_released", String(row.resource), row, { reason });
      }
    }
    return rows;
  });
}

/** 某任务当前占着的锁（「卡在谁」用）。 */
export function locksOfTask(db: LedgerDb, taskId: string): LockRow[] {
  return db
    .prepare("SELECT * FROM locks WHERE task_id = ? ORDER BY resource ASC")
    .all(taskId) as unknown as LockRow[];
}
