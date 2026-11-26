/**
 * src/ledger/events.ts —— 哈希链。每条 events 记录带上一条的指纹；
 * 改任何一个字段，从那条起后面全对不上（方案 5.5「全轨迹指纹链」）。
 *
 * 链的算法（本模块定死的口径，ledger-check 与恢复协议都按它复算）：
 *   hash = sha256(JSON.stringify([seq, ts, task_id, type, payload_json, prev_hash]))
 * - seq 显式取「当前最大 +1」，不靠 rowid 自增，这样哈希在插入前就能算出来；
 * - prev_hash 空表时为 64 个 '0'（GENESIS_HASH）；
 * - payload_json 落库的原字符串参与哈希，复算时直接拿库里的原文，不重新序列化。
 */

import type { LedgerDb } from "./db.ts";
import {
  canonicalJson,
  inTransaction,
  nowIso,
  sha256Hex,
} from "./db.ts";
import type { AppendEventInput, ChainStatus, EventRow } from "./types.ts";

export const GENESIS_HASH = "0".repeat(64);

interface HashParts {
  seq: number;
  ts: string;
  task_id: string | null;
  type: string;
  payload_json: string;
  prev_hash: string;
}

/** 单条记录的指纹。写与校验都调这一个函数，保证口径只有一份。 */
export function hashEvent(parts: HashParts): string {
  return sha256Hex(
    JSON.stringify([
      parts.seq,
      parts.ts,
      parts.task_id,
      parts.type,
      parts.payload_json,
      parts.prev_hash,
    ]),
  );
}

export interface AppendedEvent {
  seq: number;
  ts: string;
  hash: string;
  prev_hash: string;
}

/**
 * 追加一条事件，串起哈希链。写操作在 BEGIN IMMEDIATE 里做：
 * 并发的第二个写者会等 busy_timeout，等到后拿到的 max(seq) 已经是新的，不会撞车。
 */
export function appendEvent(db: LedgerDb, input: AppendEventInput): AppendedEvent {
  if (typeof input.type !== "string" || input.type.length === 0) {
    throw new Error("appendEvent: type 不能为空");
  }

  const payloadJson =
    input.payload_json !== undefined
      ? input.payload_json
      : canonicalJson(input.payload ?? null);

  return inTransaction(db, () => {
    const last = db
      .prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1")
      .get() as { seq?: number; hash?: string } | undefined;

    const seq = typeof last?.seq === "number" ? last.seq + 1 : 1;
    const prevHash = typeof last?.hash === "string" ? last.hash : GENESIS_HASH;
    const ts = input.ts ?? nowIso();

    const hash = hashEvent({
      seq,
      ts,
      task_id: input.task_id ?? null,
      type: input.type,
      payload_json: payloadJson,
      prev_hash: prevHash,
    });

    db.prepare(
      `INSERT INTO events (seq, ts, task_id, type, payload_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(seq, ts, input.task_id ?? null, input.type, payloadJson, prevHash, hash);

    return { seq, ts, hash, prev_hash: prevHash };
  });
}

/**
 * 从头复算整条链。返回断链位置（events.seq）。
 * 只查不改，只读连接也能跑。
 *
 * 注意口径：**本函数只校验 events 表自己**。steps 表被改过时链不会断
 * （改的是业务行，不是事件行），那种情况要用 verifyStepsChain()/verifyLedger()
 * —— 每次写步都会在同一个事务里追加一条带全字段快照的事件，两者一比就知道。
 * recover 的第 1 步两件都查。
 */
export function verifyChain(db: LedgerDb): ChainStatus {
  const rows = db
    .prepare(
      `SELECT seq, ts, task_id, type, payload_json, prev_hash, hash
       FROM events ORDER BY seq ASC`,
    )
    .all() as unknown as EventRow[];

  let prev = GENESIS_HASH;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        brokenAt: seq,
        reason: "prev_hash_mismatch",
        count: rows.length,
        lastHash: prev,
      };
    }
    const expected = hashEvent({
      seq,
      ts: String(row.ts),
      task_id: row.task_id === null ? null : String(row.task_id),
      type: String(row.type),
      payload_json: String(row.payload_json),
      prev_hash: String(row.prev_hash),
    });
    if (expected !== row.hash) {
      return {
        ok: false,
        brokenAt: seq,
        reason: "hash_mismatch",
        count: rows.length,
        lastHash: prev,
      };
    }
    prev = expected;
  }

  return { ok: true, brokenAt: null, reason: null, count: rows.length, lastHash: prev };
}

/** 最近 n 条事件（状态页/恢复报告取原文用）。 */
export function tailEvents(db: LedgerDb, n = 20): EventRow[] {
  const rows = db
    .prepare(
      `SELECT seq, ts, task_id, type, payload_json, prev_hash, hash
       FROM events ORDER BY seq DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.floor(n))) as unknown as EventRow[];
  return rows.reverse();
}
