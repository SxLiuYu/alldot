/**
 * src/selfimprove/status.ts —— 自我优化这条路的**只读状态查询**。
 *
 * 一句话：账本 events 表里 type 以 `self_` 开头的记录，就是自我优化留下的全部痕迹
 * （self_proposal / self_proposal_skipped / self_proposal_capped /
 * self_apply_skipped / self_apply_denied / self_apply_passed / self_apply_rejected）。
 * 这里只数它们、只列最近几条：**不写、不改、不建表**，给状态页和诊断用。
 *
 * 口径：
 * - total 与 byType 都只数 type 前缀，不看 task_id、不看开关，账本里有什么就是什么；
 * - recent 最多 RECENT_LIMIT 条，按 seq **倒序**（最新的在前）；
 * - summary 只从 payload 里取一句可读的话（reason → why → target → summary 的先后），
 *   取不到就是空串，不编；payload 不是 JSON 也不报错，summary 留空。
 */

import type { LedgerDb } from "../ledger/db.ts";

/** recent 最多几条。状态页一屏放得下，也够看出最近干了什么。 */
export const RECENT_LIMIT = 10;

/** 事件类型前缀：自我优化自己落的事件全走它。 */
export const SELF_EVENT_PREFIX = "self_";

/** summary 的截断长度（payload 里的 why 可能很长）。 */
const SUMMARY_LIMIT = 200;

export interface SelfImproveEventLine {
  seq: number;
  type: string;
  at: string;
  summary: string;
}

export interface SelfImproveStatus {
  total: number;
  byType: Record<string, number>;
  recent: SelfImproveEventLine[];
}

interface CountRow {
  type?: string;
  n?: number;
}

interface EventRowLike {
  seq?: number;
  ts?: string;
  type?: string;
  payload_json?: string;
}

/** 从 payload 里挑一句可读的话；取不到就空串，绝不编。 */
function summaryOf(payloadJson: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson) as unknown;
  } catch {
    return "";
  }
  if (payload === null || typeof payload !== "object") return "";
  const rec = payload as Record<string, unknown>;
  for (const key of ["reason", "why", "target", "summary"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim() !== "") {
      const text = value.replace(/\s+/g, " ").trim();
      return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)}…`;
    }
  }
  return "";
}

/**
 * 读自我优化的状态。空账本（一条 self_ 事件都没有）返回
 * `{ total: 0, byType: {}, recent: [] }`，不抛错。
 */
export function readSelfImproveStatus(db: LedgerDb): SelfImproveStatus {
  const byType: Record<string, number> = {};
  const countRows = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM events
       WHERE substr(type, 1, ?) = ?
       GROUP BY type`,
    )
    .all(SELF_EVENT_PREFIX.length, SELF_EVENT_PREFIX) as CountRow[];

  let total = 0;
  for (const row of countRows) {
    const type = String(row.type ?? "");
    const n = Number(row.n ?? 0);
    if (type === "" || !Number.isFinite(n)) continue;
    byType[type] = n;
    total += n;
  }

  const recentRows = db
    .prepare(
      `SELECT seq, ts, type, payload_json FROM events
       WHERE substr(type, 1, ?) = ?
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(SELF_EVENT_PREFIX.length, SELF_EVENT_PREFIX, RECENT_LIMIT) as EventRowLike[];

  const recent: SelfImproveEventLine[] = recentRows.map((row) => ({
    seq: Number(row.seq ?? 0),
    type: String(row.type ?? ""),
    at: String(row.ts ?? ""),
    summary: summaryOf(String(row.payload_json ?? "null")),
  }));

  return { total, byType, recent };
}
