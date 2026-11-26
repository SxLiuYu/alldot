/**
 * src/gate/approval.ts —— 审批状态机的闸门侧封装（A.6、B.8、B.9）。
 *
 * 依赖账本模块导出的同名函数（唯一写入口），这里只做闸门语义封装：
 * subject_key 由 computeSubjectKey 统一算，TTL 与幂等由账本的条件更新 +
 * uniq_open_approval 部分唯一索引兜底。并发两次 decide 只有一次拿到 changes=1。
 */

import {
  computeSubjectKey,
  createApproval as ledgerCreateApproval,
  decideApproval as ledgerDecideApproval,
  expireDueApprovals as ledgerExpireDueApprovals,
  findOpenApprovalBySubjectKey,
  getApproval,
  type ApprovalRow,
  type CreateApprovalInput,
  type DecidedBy,
  type LedgerDb,
} from "../ledger/index.ts";
import type { Tier } from "./types.ts";

export interface GateApprovalRequest {
  taskId?: string | null;
  stepId?: string | null;
  /** 工具名 + 规范化后的参数，用于算 subject_key。 */
  tool: string;
  args?: unknown;
  kind?: CreateApprovalInput["kind"];
  tier: Tier;
  title: string;
  /** 请示卡原文（question/options/detail），逐字渲染，模型不许改。 */
  detail?: unknown;
  /** 毫秒；默认 24 小时（approvals.ttl_hours=24）。 */
  ttlMs?: number;
  now?: Date;
  /** 调用方已有 subject_key 时直接传；否则用 tool+args 算。 */
  subjectKey?: string;
}

export interface GateApprovalResult {
  approval: ApprovalRow;
  reused: boolean;
  subjectKey: string;
}

/** 建单；同一 subject_key 已有活动单就复用，不产生第二条（A.6 幂等）。 */
export function createApproval(db: LedgerDb, req: GateApprovalRequest): GateApprovalResult {
  const subjectKey = req.subjectKey ?? computeSubjectKey(req.taskId ?? "", req.tool, req.args ?? null);
  const { approval, reused } = ledgerCreateApproval(db, {
    task_id: req.taskId ?? null,
    step_id: req.stepId ?? null,
    kind: req.kind ?? "tool_call",
    tier: req.tier,
    title: req.title,
    detail: req.detail ?? {},
    subject_key: subjectKey,
    ttlMs: req.ttlMs,
    now: req.now,
  });
  return { approval, reused, subjectKey };
}

export interface GateDecision {
  decision: "approved" | "rejected";
  decidedBy?: DecidedBy;
  note?: string | null;
}

/**
 * 条件更新 WHERE status='pending'（B.9）。
 * 返回 true=这次调用真的改了；false=已被别人决过/已过期，幂等当成重复处理。
 */
export function decideApproval(
  db: LedgerDb,
  id: string,
  decision: GateDecision | "approved" | "rejected",
): boolean {
  const input: GateDecision =
    typeof decision === "string"
      ? { decision, decidedBy: "dsbot" }
      : { ...decision, decidedBy: decision.decidedBy ?? "dsbot" };
  return ledgerDecideApproval(db, id, {
    decision: input.decision,
    decidedBy: input.decidedBy ?? "dsbot",
    note: input.note ?? null,
  });
}

/**
 * verifyIdempotent：同一个 subject_key 只批一次。
 * 先查活动单再建；返回同一张 id 与 reused=true 表示这是重发。
 */
export function verifyIdempotent(db: LedgerDb, req: GateApprovalRequest): GateApprovalResult {
  const subjectKey = req.subjectKey ?? computeSubjectKey(req.taskId ?? "", req.tool, req.args ?? null);
  const existing = findOpenApprovalBySubjectKey(db, subjectKey);
  if (existing !== null) {
    return { approval: existing, reused: true, subjectKey };
  }
  return createApproval(db, { ...req, subjectKey });
}

/** TTL 到期：pending 且 pending_until < now → expired；返回条数。 */
export function sweepExpired(db: LedgerDb, now: Date = new Date()): number {
  return ledgerExpireDueApprovals(db, now);
}

/** 供桥/状态页取单。 */
export function readApproval(db: LedgerDb, id: string): ApprovalRow | null {
  return getApproval(db, id);
}
