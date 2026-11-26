/**
 * src/ledger/snapshot.ts —— 行快照与字段比对。
 *
 * 用途：每次写 steps/locks 都在同一个事务里追加一条事件，payload 带该行的**全字段快照**。
 * 这样「全轨迹指纹链」才真的盖住业务表：链管事件的完整性，快照管业务行与链的一致性。
 * verifyStepsChain() 拿链上最后一份快照和 steps 行逐字段比，改一个字段/删一行都能查出来。
 */

import type { StepRow } from "./types.ts";

/** 参与快照与比对的步字段（B.8 steps 的全部列）。 */
export const STEP_FIELDS = [
  "id",
  "task_id",
  "seq",
  "milestone_id",
  "plan_version",
  "worker_id",
  "run_epoch",
  "kind",
  "tool",
  "subject_key",
  "side_effect",
  "tier",
  "status",
  "args_ref",
  "result_ref",
  "result_hash",
  "error",
  "session_key",
  "started_at",
  "ended_at",
] as const;

export type StepSnapshot = Record<(typeof STEP_FIELDS)[number], string | number | null>;

function norm(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  return String(v);
}

export function snapshotStep(row: StepRow): StepSnapshot {
  const out = {} as StepSnapshot;
  for (const f of STEP_FIELDS) out[f] = norm((row as unknown as Record<string, unknown>)[f]);
  return out;
}

/** 返回不一致的字段名列表；空数组 = 完全一致。 */
export function diffStepSnapshot(
  expected: Record<string, unknown>,
  actual: StepSnapshot,
): string[] {
  const diff: string[] = [];
  for (const f of STEP_FIELDS) {
    const a = norm(expected[f]);
    const b = actual[f];
    if (a !== b) diff.push(f);
  }
  return diff;
}

/** 从 chain 的 payload_json 里取步骤快照，取不到返回 null。 */
export function readStepSnapshot(payload: unknown): StepSnapshot | null {
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as { step?: unknown }).step;
  if (raw === null || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out = {} as StepSnapshot;
  for (const f of STEP_FIELDS) out[f] = norm(src[f]);
  if (out.id === null) return null;
  return out;
}
