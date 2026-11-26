/**
 * src/ledger/test-helpers.ts —— 测试夹具。不是 .test 文件，不会被 run-tests 直接执行。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerDb } from "./db.ts";
import { nowIso, openLedger, randomId } from "./db.ts";

export interface TempDb {
  db: LedgerDb;
  dir: string;
  path: string;
  cleanup: () => void;
}

export function makeTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "dot-ledger-test-"));
  const path = join(dir, "dot.db");
  const db = openLedger(path);
  return {
    db,
    dir,
    path,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // 已经关了就算了。
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TaskFixture {
  id?: string;
  state?: string;
  intent?: string;
  restated?: string | null;
  source?: string;
  profile?: string;
  budget_tokens?: number | null;
  spent_tokens?: number;
  milestone_id?: string | null;
  plan_version?: number;
  blocked_on_json?: string | null;
  state_reason?: string | null;
  run_epoch?: number;
}

export function createTask(db: LedgerDb, f: TaskFixture = {}): string {
  const id = f.id ?? randomId("task");
  const ts = nowIso();
  db.prepare(
    `INSERT INTO tasks (
       id, parent_id, intent, restated, declared_json, state, state_reason,
       blocked_on_json, milestone_id, plan_version, profile, budget_tokens,
       spent_tokens, source, source_ref, run_epoch, created_at, updated_at
     ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    f.intent ?? "把桌面截图按月份归档",
    f.restated ?? null,
    JSON.stringify({ scope: ["~/Desktop/screenshots"] }),
    f.state ?? "queued",
    f.state_reason ?? null,
    f.blocked_on_json ?? null,
    f.milestone_id ?? null,
    f.plan_version ?? 1,
    f.profile ?? "balanced",
    f.budget_tokens ?? 2_000_000,
    f.spent_tokens ?? 0,
    f.source ?? "dsbot",
    f.run_epoch ?? 0,
    ts,
    ts,
  );
  return id;
}

export function createMilestone(
  db: LedgerDb,
  taskId: string,
  input: { id?: string; seq: number; title: string; state?: string; doneWhen?: string },
): string {
  const id = input.id ?? randomId("ms");
  db.prepare(
    `INSERT INTO milestones (id, task_id, seq, title, done_when, summary, state, created_at, ended_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
  ).run(
    id,
    taskId,
    input.seq,
    input.title,
    input.doneWhen ?? `${input.title} 做完`,
    input.state ?? "pending",
    nowIso(),
  );
  return id;
}

export function createPlan(
  db: LedgerDb,
  taskId: string,
  input: { version?: number; why?: string | null; milestoneId?: string | null },
): string {
  const id = randomId("plan");
  db.prepare(
    `INSERT INTO plans (id, task_id, version, milestone_id, content_json, why, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    taskId,
    input.version ?? 1,
    input.milestoneId ?? null,
    JSON.stringify({ steps: [] }),
    input.why ?? "你说按文件名里的月份分，不打开看内容",
    nowIso(),
  );
  return id;
}

export function createApproval(
  db: LedgerDb,
  input: {
    id?: string;
    taskId: string;
    stepId?: string | null;
    kind?: string;
    tier?: number;
    title?: string;
    subjectKey?: string;
    status?: string;
    pendingUntil?: string;
  },
): string {
  const id = input.id ?? randomId("apv");
  const ts = nowIso();
  db.prepare(
    `INSERT INTO approvals (
       id, task_id, step_id, kind, tier, title, detail_json, subject_key,
       status, decided_by, decision_note, pending_until, created_at, decided_at, executed_at
     ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(
    id,
    input.taskId,
    input.stepId ?? null,
    input.kind ?? "tool_call",
    input.tier ?? 4,
    input.title ?? "要动桌面上的文件",
    input.subjectKey ?? randomId("subj"),
    input.status ?? "pending",
    input.pendingUntil ?? new Date(Date.now() + 86_400_000).toISOString(),
    ts,
  );
  return id;
}

export function countRows(db: LedgerDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}
