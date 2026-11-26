/**
 * src/hands/singleton.ts —— 三只手的单例锁（B.9 第 7 条「已登录浏览器需单例锁」）。
 *
 * 为什么需要：桌面键鼠和已登录浏览器都是**整机/整 profile 只有一份**的资源。
 * 两个工人会话同时点鼠标，步骤会互相覆盖，账本却各记各的成功；浏览器更糟——
 * 同一个 --user-data-dir 被两个 Playwright 抢，轻则标签乱跑，重则 profile 写坏。
 *
 * 口径：
 * - resource 名固定三把：hand:desktop / hand:logged_browser / hand:clean_browser；
 * - 拿不到锁返回 code="busy"，带「谁占着、什么时候过期」，不排队硬等；
 * - 同一任务重复拿自己的锁＝续期（reason="renewed"），不算冲突；
 * - 释放必须放在 finally：成功、失败、抛异常都要放。
 *
 * 同任务重入的配对（2026-11-25 审核修）：账本的锁行一个 resource 只有一行，
 * 若两次 acquire 都直接续期、两次 release 都整行 DELETE，先结束的那次会把行删掉，
 * 另一个还在跑的调用就「裸奔」了。这里在进程内按 (db, resource) 记重入计数：
 * 只有最后一个持有者释放时才 DELETE 账本行；前面的 release 只把计数减 1。
 * 跨进程的同任务重入仍只能靠账本那一行（本进程看不到别的进程的计数），
 * 但手都跑在同一个插件进程里，这一层足够挡住实际交错。
 */

import {
  acquireLock,
  getLock,
  releaseLock,
  renewLock,
  type LedgerDb,
  type LockRow,
} from "../ledger/index.ts";

export const HAND_LOCK_RESOURCES = ["hand:desktop", "hand:logged_browser", "hand:clean_browser"] as const;
export type HandLockResource = (typeof HAND_LOCK_RESOURCES)[number];

/** 默认租期：一个动作通常几秒，10 分钟足够覆盖一次慢点击/慢填表。 */
export const DEFAULT_HAND_LOCK_TTL_MS = 10 * 60 * 1000;

export interface HandLockOptions {
  db: LedgerDb;
  resource: HandLockResource | string;
  taskId: string;
  /** 默认按 resource 固定（同一任务重复拿＝续期，不同任务＝冲突）。 */
  workerId?: string;
  ttlMs?: number;
  /** 允许接管过期锁，默认允许（A.9 第 4 步）。 */
  takeoverExpired?: boolean;
}

export interface HandLockHeldBy {
  taskId: string;
  workerId: string;
  expiresAt: string;
}

export type HandLockResult =
  | { ok: true; resource: string; mode: "acquired" | "renewed"; release: () => boolean }
  | { ok: false; code: "busy"; resource: string; detail: string; heldBy: HandLockHeldBy | null };

function ownerOf(opts: HandLockOptions): { taskId: string; workerId: string } {
  return {
    taskId: opts.taskId,
    workerId: opts.workerId ?? `hand:${opts.resource}`,
  };
}

interface LocalHold {
  taskId: string;
  workerId: string;
  /** 本进程里同一任务同 resource 的重入次数；最后一个释放才删账本行。 */
  count: number;
}

/** 进程内重入计数，按 db 实例隔离（测试各自临时库，互不污染）。 */
const localHolds = new WeakMap<LedgerDb, Map<string, LocalHold>>();

function holdsOf(db: LedgerDb): Map<string, LocalHold> {
  let map = localHolds.get(db);
  if (map === undefined) {
    map = new Map<string, LocalHold>();
    localHolds.set(db, map);
  }
  return map;
}

function busyResult(resource: string, row: LockRow | null, fallback?: LocalHold): HandLockResult {
  const heldBy: HandLockHeldBy | null =
    row === null
      ? fallback === undefined
        ? null
        : { taskId: fallback.taskId, workerId: fallback.workerId, expiresAt: "" }
      : {
          taskId: String(row.task_id),
          workerId: String(row.worker_id),
          expiresAt: String(row.expires_at),
        };
  const detail =
    heldBy === null
      ? `「${resource}」正被别的任务占着，拿不到锁`
      : `「${resource}」正被任务 ${heldBy.taskId}（worker ${heldBy.workerId}）占着` +
        (heldBy.expiresAt === "" ? "" : `，约 ${heldBy.expiresAt} 过期`);
  return { ok: false, code: "busy", resource, detail, heldBy };
}

/**
 * 拿一只手锁。返回的 release 只放自己的锁（把 owner 一起传回去），重复调用返回 false。
 * 失败不抛异常：busy 是正常结果，交回给模型看「卡在谁」。
 */
export function acquireHandLock(opts: HandLockOptions): HandLockResult {
  const owner = ownerOf(opts);
  const ttlMs = opts.ttlMs ?? DEFAULT_HAND_LOCK_TTL_MS;
  const holds = holdsOf(opts.db);
  const local = holds.get(opts.resource);

  // 本地记着别的任务：先信账本；账本已经是别人的说明本地记录过期了，丢掉。
  if (local !== undefined && (local.taskId !== owner.taskId || local.workerId !== owner.workerId)) {
    const row = getLock(opts.db, opts.resource);
    if (row !== null && (row.task_id !== owner.taskId || row.worker_id !== owner.workerId)) {
      holds.delete(opts.resource);
    }
    return busyResult(opts.resource, row, local);
  }

  let mode: "acquired" | "renewed";
  if (local !== undefined) {
    // 同属主重入：本地计数 +1，账本续期；行被外部清掉/接管就重新抢一次。
    const renewed = renewLock(opts.db, opts.resource, owner, ttlMs);
    if (!renewed) {
      const again = acquireLock(opts.db, opts.resource, {
        taskId: owner.taskId,
        workerId: owner.workerId,
        ttlMs,
        takeoverExpired: opts.takeoverExpired,
      });
      if (!again.acquired) {
        holds.delete(opts.resource);
        return busyResult(opts.resource, getLock(opts.db, opts.resource), local);
      }
    }
    local.count += 1;
    mode = "renewed";
  } else {
    const res = acquireLock(opts.db, opts.resource, {
      taskId: owner.taskId,
      workerId: owner.workerId,
      ttlMs,
      takeoverExpired: opts.takeoverExpired,
    });
    if (!res.acquired) {
      return busyResult(opts.resource, res.lock ?? getLock(opts.db, opts.resource));
    }
    holds.set(opts.resource, { ...owner, count: 1 });
    mode = res.reason === "renewed" ? "renewed" : "acquired";
  }

  let released = false;
  return {
    ok: true,
    resource: opts.resource,
    mode,
    release: (): boolean => {
      if (released) return false;
      released = true;
      const current = holds.get(opts.resource);
      if (current !== undefined && current.taskId === owner.taskId && current.workerId === owner.workerId) {
        current.count -= 1;
        // 同任务还有别的调用握着：锁行先留着，别把人家脚下的地抽了。
        if (current.count > 0) return true;
        holds.delete(opts.resource);
      }
      return releaseLock(opts.db, opts.resource, owner);
    },
  };
}

/** 当前这把锁的持有行（排障/状态页用）。 */
export function peekHandLock(db: LedgerDb, resource: string): LockRow | null {
  return getLock(db, resource);
}

export type WithHandLockResult<T> =
  | { ok: true; value: T; mode: "acquired" | "renewed" }
  | { ok: false; code: "busy"; detail: string; heldBy: HandLockHeldBy | null };

/**
 * 拿锁 → 执行 → finally 放锁。异常也会放（这就是 finally 的意义）。
 * 手壳里是显式 try/finally（因为要跨快照/记账/动作三段），这个包装给脚本与测试用。
 */
export async function withHandLock<T>(
  opts: HandLockOptions,
  fn: () => Promise<T> | T,
): Promise<WithHandLockResult<T>> {
  const lock = acquireHandLock(opts);
  if (!lock.ok) {
    return { ok: false, code: "busy", detail: lock.detail, heldBy: lock.heldBy };
  }
  try {
    const value = await fn();
    return { ok: true, value, mode: lock.mode };
  } finally {
    lock.release();
  }
}
