/**
 * src/ledger/chain-view.ts —— 业务表与指纹链的一致性核对。
 *
 * 链本身（verifyChain）只能证明 events 没被改。要做到 5.5 说的
 * 「全轨迹指纹链……谁改了历史记录，启动时一查就发现」，还得把业务行和链上的快照对上。
 * 本模块负责 steps；locks 是短租约表，只上链不比对（租约过期即失效，没有「历史」可言）。
 */

import type { LedgerDb } from "./db.ts";
import { parseJsonOrNull } from "./db.ts";
import { verifyChain } from "./events.ts";
import type { ChainStatus } from "./types.ts";
import { diffStepSnapshot, readStepSnapshot, snapshotStep, type StepSnapshot } from "./snapshot.ts";
import type { StepRow } from "./types.ts";

export const STEP_EVENT_TYPES = [
  "step_started",
  "step_ended",
  "step_interrupted",
  "step_rolled_back",
] as const;

export interface StepChainIssue {
  stepId: string;
  kind: "field_mismatch" | "missing_row" | "orphan_row";
  field?: string;
  expected?: string | number | null;
  actual?: string | number | null;
  eventSeq?: number;
}

export interface StepChainStatus {
  ok: boolean;
  /** 链上最后一次记录与 steps 行不一致的明细。 */
  issues: StepChainIssue[];
  /** steps 表现有行数。 */
  rowCount: number;
  /** 链上出现过的不同 step id 数。 */
  trackedCount: number;
}

/**
 * 逐行核对：steps 表每一行都要能在链上找到最后一份快照，且逐字段一致；
 * 链上有快照但表里没行 = 被删了（missing_row，最多报一条，不刷屏）。
 */
export function verifyStepsChain(db: LedgerDb): StepChainStatus {
  const events = db
    .prepare(
      `SELECT seq, type, payload_json FROM events
       WHERE type IN ('step_started','step_ended','step_interrupted','step_rolled_back')
       ORDER BY seq ASC`,
    )
    .all() as Array<{ seq?: number; type?: string; payload_json?: string }>;

  const latest = new Map<string, { snapshot: StepSnapshot; seq: number }>();
  for (const ev of events) {
    const payload = parseJsonOrNull(ev.payload_json ?? null);
    const snapshot = readStepSnapshot(payload);
    if (snapshot === null || typeof snapshot.id !== "string") continue;
    latest.set(snapshot.id, { snapshot, seq: Number(ev.seq ?? 0) });
  }

  const rows = db.prepare("SELECT * FROM steps").all() as unknown as StepRow[];
  const seen = new Set<string>();
  const issues: StepChainIssue[] = [];

  for (const row of rows) {
    const id = String(row.id);
    seen.add(id);
    const tracked = latest.get(id);
    if (tracked === undefined) {
      issues.push({ stepId: id, kind: "orphan_row" });
      continue;
    }
    const actual = snapshotStep(row);
    for (const field of diffStepSnapshot(tracked.snapshot as unknown as Record<string, unknown>, actual)) {
      issues.push({
        stepId: id,
        kind: "field_mismatch",
        field,
        expected: tracked.snapshot[field as keyof StepSnapshot] ?? null,
        actual: actual[field as keyof StepSnapshot] ?? null,
        eventSeq: tracked.seq,
      });
    }
  }

  for (const id of latest.keys()) {
    if (!seen.has(id)) issues.push({ stepId: id, kind: "missing_row" });
  }

  return {
    ok: issues.length === 0,
    issues,
    rowCount: rows.length,
    trackedCount: latest.size,
  };
}

export interface LedgerVerifyResult {
  ok: boolean;
  /** events 链本身的完整性（返回断链位置）。 */
  chain: ChainStatus;
  /** steps 行与链上快照的一致性。 */
  steps: StepChainStatus;
}

/** 把两件事一起做：链没断，且业务行没被改。recover 与 ledger-check 都用这个口径。 */
export function verifyLedger(db: LedgerDb): LedgerVerifyResult {
  const chain = verifyChain(db);
  const steps = verifyStepsChain(db);
  return { ok: chain.ok && steps.ok, chain, steps };
}
