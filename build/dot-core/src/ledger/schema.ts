/**
 * src/ledger/schema.ts —— 建表。DDL 逐字来自方案附录 B.8「账本表（DDL 级，摘录）」，
 * 十二张表，一个字不改，只加 `IF NOT EXISTS`（迁移幂等的第二道保险）与注释。
 *
 * 迁移机制照 dotd 的做法（research/_src/dotd/db/migrate.ts 注释里的契约 D1–D3）：
 * PRAGMA user_version 做版本号，不引 ORM、不引迁移框架。但这里只有一个包，
 * 版本号直接是 1。B.8 里的三句 PRAGMA 由 openLedger 执行（synchronous 不能在事务内设）。
 *
 * 方案没有补「历史可查」「磁盘/余额」相关的表，所以这里也不加：磁盘与余额读数
 * 按 B.7 写在 keeper 自己的 `~/.allbot/dot/state/keep.json`，不进账本；
 * 历史查询走 events/steps 两张表本身。
 */

import type { LedgerDb } from "./db.ts";
import { inTransaction } from "./db.ts";

export const SCHEMA_VERSION = 1;

/** 十二张表（B.8）。顺序按方案原文。 */
export const LEDGER_TABLES = [
  "tasks",
  "milestones",
  "plans",
  "steps",
  "approvals",
  "decisions",
  "locks",
  "workers",
  "snapshots",
  "artifacts",
  "events",
  "spend_ledger",
] as const;

export const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES tasks(id),
  intent TEXT NOT NULL, restated TEXT, declared_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','awaiting_approval','paused','done','failed','cancelled')),
  state_reason TEXT, blocked_on_json TEXT, milestone_id TEXT, plan_version INTEGER NOT NULL DEFAULT 1,
  profile TEXT NOT NULL DEFAULT 'balanced', budget_tokens INTEGER, spent_tokens INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, source_ref TEXT, run_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL,
  title TEXT NOT NULL, done_when TEXT NOT NULL, summary TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','active','done','skipped')), created_at TEXT, ended_at TEXT);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
  milestone_id TEXT, content_json TEXT NOT NULL, why TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL,
  milestone_id TEXT, plan_version INTEGER NOT NULL, worker_id TEXT, run_epoch INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('llm','tool','human','notify')), tool TEXT,
  subject_key TEXT NOT NULL, side_effect TEXT NOT NULL CHECK (side_effect IN ('safe','replayable','unknown')),
  tier INTEGER, status TEXT NOT NULL CHECK (status IN ('pending','started','succeeded','failed','interrupted','skipped','rolled_back')),
  args_ref TEXT, result_ref TEXT, result_hash TEXT, error TEXT, session_key TEXT,
  started_at TEXT, ended_at TEXT, UNIQUE (task_id, seq));

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), step_id TEXT REFERENCES steps(id),
  kind TEXT NOT NULL CHECK (kind IN ('tool_call','question','handoff','intent')), tier INTEGER NOT NULL,
  title TEXT NOT NULL, detail_json TEXT NOT NULL, subject_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','executing','executed','failed','revoked')),
  decided_by TEXT CHECK (decided_by IN ('dsbot','feishu','cli','system')), decision_note TEXT,
  pending_until TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, executed_at TEXT);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_approval ON approvals(subject_key)
  WHERE status IN ('pending','approved','executing');

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
  decided_by TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS locks (
  resource TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, session_key TEXT NOT NULL,
  model TEXT, status TEXT NOT NULL, run_epoch INTEGER NOT NULL, last_event_at TEXT);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, milestone_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('git','copy','browser','desktop_list')), ref TEXT NOT NULL,
  restore_json TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS artifacts (
  hash TEXT PRIMARY KEY, content BLOB NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id TEXT PRIMARY KEY, task_id TEXT, worker_id TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL);
`;

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

export function getUserVersion(db: LedgerDb): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const v = row?.user_version;
  return typeof v === "number" ? v : 0;
}

/**
 * 幂等建表。跑两次不报错：第二次 user_version 已是 1 直接返回 applied: []。
 * 若 user_version 被外部弄丢，DDL 全是 IF NOT EXISTS，重跑也不会炸。
 */
export function migrate(db: LedgerDb): MigrationResult {
  const from = getUserVersion(db);
  if (from >= SCHEMA_VERSION) {
    return { from, to: from, applied: [] };
  }

  inTransaction(db, () => {
    db.exec(LEDGER_DDL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });

  return { from, to: SCHEMA_VERSION, applied: ["001_ledger"] };
}

/** 体检：十二张表缺几张。返回缺失的表名。 */
export function missingTables(db: LedgerDb): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name?: string }>;
  const present = new Set(rows.map((r) => String(r.name ?? "")));
  return LEDGER_TABLES.filter((t) => !present.has(t));
}
