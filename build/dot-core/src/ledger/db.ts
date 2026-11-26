/**
 * src/ledger/db.ts —— 打开账本库、错误类型、哈希与时间工具。
 *
 * PRAGMA 依据方案 A.5：「账本文件 …（拟新增，SQLite，WAL＋PRAGMA synchronous=FULL）」
 * 以及附录 B.8 首行的三句 PRAGMA。node:sqlite 语义（本机 Node 24.13.0，dotd 的
 * db/migrate.ts 注释里同口径）：
 * - `PRAGMA synchronous` **不能在事务内设置**（报 "Safety level may not be changed
 *   inside a transaction"），所以 openLedger 只在连接刚打开时设一次，migrate 不碰它。
 * - `PRAGMA journal_mode=WAL` 对 `:memory:` 返回 "memory"，不算错。
 * - foreign_keys=ON 是方案的硬要求；打开时就设，不等 migrate。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** 账本库连接。所有 ledger 函数都吃这个，不另造包装层（与 dotd 同口径）。 */
export type LedgerDb = DatabaseSync;

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** 完整性校验失败（SQLite 自检或外键）。A.9 第 1 步：这类失败必须拦下来。 */
export class LedgerIntegrityError extends LedgerError {
  constructor(message: string) {
    super("integrity_failed", message);
    this.name = "LedgerIntegrityError";
  }
}

/** 带旧 run_epoch 的写入。A.9 第 2 条：run_epoch++ 之后旧工人一律拒收。 */
export class StaleWriterError extends LedgerError {
  constructor(taskId: string, given: number, current: number) {
    super(
      "stale_writer",
      `stale writer for task ${taskId}: run_epoch ${given} < current ${current}`,
    );
    this.name = "StaleWriterError";
  }
}

export interface OpenLedgerOptions {
  /** SQLite busy timeout（毫秒）。两连接抢锁靠它排队后按行状态判胜负。默认 5000。 */
  busyTimeoutMs?: number;
  /** 只读打开（桥的只读视图用）。默认 false。 */
  readOnly?: boolean;
  /** 目录不存在时是否建（默认建）。只读模式不会建。 */
  createDir?: boolean;
}

/**
 * 打开账本库。WAL + synchronous=FULL + foreign_keys=ON + busy_timeout。
 * 不建表；建表走 migrate(db)。
 */
export function openLedger(path: string, opts: OpenLedgerOptions = {}): LedgerDb {
  const busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  const inMemory = path === ":memory:" || path.startsWith("file::memory:");

  if (!inMemory && opts.readOnly !== true && opts.createDir !== false) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path, {
    readOnly: opts.readOnly ?? false,
    enableForeignKeyConstraints: true,
    timeout: busyTimeoutMs,
  });

  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  if (!inMemory) {
    // 只读连接也能读 WAL，但改不了 journal_mode；只在非只读时设。
    if (opts.readOnly !== true) db.exec("PRAGMA journal_mode = WAL");
  }
  if (opts.readOnly !== true) {
    db.exec("PRAGMA synchronous = FULL");
  }
  // 显式再设一次：构造参数在个别版本上不生效时兜底。
  if (opts.readOnly !== true) db.exec("PRAGMA foreign_keys = ON");

  return db;
}

/** 取某个连接上的 PRAGMA 当前值（测试与体检脚本用）。 */
export function pragmaValue(db: LedgerDb, name: string): string | number | null {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const first = Object.values(row)[0];
  if (typeof first === "string" || typeof first === "number") return first;
  return null;
}

/** 统一时间格式：ISO-8601 UTC，毫秒精度。全表 TEXT 时间都走它，排序即时间序。 */
export function nowIso(at: Date = new Date()): string {
  return at.toISOString();
}

/** ISO 时间加毫秒，用于 expires_at / pending_until。 */
export function isoPlus(ms: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ms).toISOString();
}

/** 键排序的 JSON，保证同样的对象永远得到同样的字符串（哈希可复算）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 按原始字节算哈希（artifacts 的内容可能是二进制，不能先解码再算）。 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function randomId(prefix: string): string {
  return `${prefix}_${createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * 语句级事务。node:sqlite 默认自动提交，但恢复/迁移要多句原子，
 * 所以统一用 BEGIN IMMEDIATE（立刻拿写锁，避免读升级写时的死锁窗口）。
 *
 * 已经在事务里就直接并入外层（谁开谁提交）——否则恢复/闸门里嵌套调用会报
 * "cannot start a transaction within a transaction"。
 * 注意 beginStep 例外：它必须自己提交，见 steps.ts 里的显式拒绝。
 */
export function inTransaction<T>(db: LedgerDb, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败（连接已坏）时保留原始错误，别把它盖掉。
    }
    throw err;
  }
}

/** JSON 列解析：坏内容不抛，返回 null 并带上原文由调用方决定。 */
export function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
