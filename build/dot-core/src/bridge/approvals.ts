/**
 * src/bridge/approvals.ts —— 网页审批（P1P3 契约第 4、5 节）。
 *
 * 这是桥第一次写账本。范围只限 approvals / decisions 两张表的「一张卡下结论」，
 * 不建任务、不重排、不派单；过期按拒绝落账，理由写「超时」。
 *
 * 有效期直接用表里的 pending_until（approvals 表建表时就有这一列），
 * 不再按 created_at 自己算 30 分钟——两者冲突时以库里的为准。
 * decided_by 只能是 dsbot/feishu/cli/system（CHECK 约束），TTL 过期记 system，
 * 「超时」写在 decision_note 里。
 */

import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import {
  appendEvent,
  decideApproval,
  getApproval,
  listOpenApprovals,
  openLedger,
  recordDecision,
  type ApprovalRow,
  type LedgerDb,
} from "../ledger/index.ts";

export interface ApprovalItem {
  id: string;
  taskId: string | null;
  tier: number;
  summary: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export type AnswerResult =
  | { ok: true; decision: "agree" | "reject" | "expired" }
  | {
      ok: false;
      status: number;
      /** ledger_unavailable 只在账本打不开时出现（契约三种之外的异常值）。 */
      error: "not_found" | "expired" | "already_decided" | "ledger_unavailable";
      message: string;
    };

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withLedger<T>(ledgerPath: string, readOnly: boolean, fn: (db: LedgerDb) => T): T {
  if (!readOnly) mkdirSync(dirname(ledgerPath), { recursive: true });
  const db = openLedger(ledgerPath, { readOnly, createDir: !readOnly, busyTimeoutMs: 3000 });
  try {
    if (readOnly) db.exec("PRAGMA query_only = ON");
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // 关不上就算了，进程退出也会释放。
    }
  }
}

/** 卡片的有效期：优先用表里的 pending_until，缺了才按 created_at + 30 分钟推。 */
export function approvalExpiresAt(row: ApprovalRow, ttlMs = DEFAULT_TTL_MS): string {
  if (typeof row.pending_until === "string" && row.pending_until.trim() !== "") return row.pending_until;
  const created = Date.parse(row.created_at);
  if (Number.isNaN(created)) return row.created_at;
  return new Date(created + ttlMs).toISOString();
}

function isExpired(row: ApprovalRow, now: Date, ttlMs: number): boolean {
  const at = Date.parse(approvalExpiresAt(row, ttlMs));
  return !Number.isNaN(at) && at <= now.getTime();
}

/** detail_json 里的 question 才是给人看的一句话；没有再退回 title。 */
export function approvalSummaryText(row: ApprovalRow): string {
  try {
    const parsed = JSON.parse(row.detail_json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const q = (parsed as Record<string, unknown>).question;
      if (typeof q === "string" && q.trim() !== "") return q.trim();
    }
  } catch {
    // detail 不是 JSON 就当没有。
  }
  return row.title;
}

export function toApprovalItem(row: ApprovalRow, now: Date, ttlMs = DEFAULT_TTL_MS): ApprovalItem {
  return {
    id: row.id,
    taskId: row.task_id,
    tier: row.tier,
    summary: approvalSummaryText(row),
    createdAt: row.created_at,
    expiresAt: approvalExpiresAt(row, ttlMs),
    expired: isExpired(row, now, ttlMs),
  };
}

export interface ListApprovalsResult {
  ok: boolean;
  items: ApprovalItem[];
  error: string | null;
}

/** 待批列表。只列 pending：已决的留在账本里查，不进「等你点」这一栏。 */
export function listApprovals(
  ledgerPath: string,
  now: Date,
  ttlMs = DEFAULT_TTL_MS,
): ListApprovalsResult {
  try {
    const rows = withLedger(ledgerPath, true, (db) => listOpenApprovals(db));
    return {
      ok: true,
      items: rows.filter((row) => row.status === "pending").map((row) => toApprovalItem(row, now, ttlMs)),
      error: null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const hint = code === "ENOENT" ? "（账本还没建）" : "";
    return { ok: false, items: [], error: `账本打不开：${errorText(err)}${hint}` };
  }
}

/**
 * 给一张卡下结论。agree/reject 落账；过期按拒绝写，理由「超时」。
 * 重复点不重复记账：已决的返回 already_decided（状态是 expired 的返回 expired）。
 */
export function answerApproval(
  ledgerPath: string,
  id: string,
  answer: "agree" | "reject",
  now: Date,
  ttlMs = DEFAULT_TTL_MS,
): AnswerResult {
  try {
    return withLedger(ledgerPath, false, (db) => {
      const row = getApproval(db, id);
      if (row === null) {
        return { ok: false, status: 404, error: "not_found", message: `账本里没有批单 ${id}` } as const;
      }

      if (row.status !== "pending") {
        if (row.status === "expired") {
          return { ok: false, status: 409, error: "expired", message: `批单 ${id} 已经过期，不会再改` } as const;
        }
        return {
          ok: false,
          status: 409,
          error: "already_decided",
          message: `批单 ${id} 已经是 ${row.status}，不重复记账`,
        } as const;
      }

      if (isExpired(row, now, ttlMs)) {
        // 过期即拒绝：status 记 rejected（和真拒绝同一条流水），理由单独写「超时」。
        const changed = decideApproval(db, id, { decision: "rejected", decidedBy: "system", note: "超时" });
        if (!changed) {
          return { ok: true, decision: "expired" } as const;
        }
        recordDecisionFor(db, row, "reject", "system", "超时");
        appendEvent(db, {
          task_id: row.task_id,
          type: "approval_expired",
          payload: { approval_id: id, reason: "超时", ttl_source: "pending_until" },
        });
        return { ok: true, decision: "expired" } as const;
      }

      const decision = answer === "agree" ? "approved" : "rejected";
      const changed = decideApproval(db, id, { decision, decidedBy: "dsbot" });
      if (!changed) {
        return {
          ok: false,
          status: 409,
          error: "already_decided",
          message: `批单 ${id} 刚刚被别人点过，不重复记账`,
        } as const;
      }
      recordDecisionFor(db, row, answer, "dsbot", null);
      return { ok: true, decision: answer } as const;
    });
  } catch (err) {
    return { ok: false, status: 503, error: "ledger_unavailable", message: `写账本失败：${errorText(err)}` };
  }
}

function recordDecisionFor(
  db: LedgerDb,
  row: ApprovalRow,
  answer: "agree" | "reject",
  decidedBy: "dsbot" | "system",
  note: string | null,
): void {
  try {
    recordDecision(db, {
      // approvals.task_id 可以是 NULL（自我优化提案那条）；decisions.task_id 是 NOT NULL，用空串占位。
      task_id: row.task_id ?? "",
      question: note === null ? approvalSummaryText(row) : `${approvalSummaryText(row)}（${note}）`,
      answer,
      decided_by: decidedBy,
    });
  } catch {
    // 追溯行写不进去不影响审批本身（审批已经落库）。
  }
}
