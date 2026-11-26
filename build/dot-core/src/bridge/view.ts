/**
 * src/bridge/view.ts —— 桥的只读账本视图（B.6 最后一条）。
 *
 * 硬约束：**桥不许写账本**。这里只用 openLedger(readOnly) 打开，再补一句
 * `PRAGMA query_only=ON` 当安全带；写语句在只读连接上会被 SQLite 直接拒。
 *
 * 打开一次读一次就关：状态页每次刷新都重新读，避免拿着旧连接看不到别人的提交；
 * 读失败（库还没建、被独占）只返回错误，不让状态页 500。
 */

import type { ApprovalRow, TaskRow } from "../ledger/index.ts";
import {
  getApproval,
  getArtifact,
  latestRecoveryReport,
  listOpenApprovals,
  listTasks,
  missingTables,
  openLedger,
  readTaskView,
  renderProgressCard,
  OPEN_TASK_STATES,
} from "../ledger/index.ts";

export interface TaskCardView {
  id: string;
  intent: string;
  state: string;
  stateLabel: string;
  profile: string;
  updatedAt: string;
  /** 账本模板卡原文（renderProgressCard）。状态页与 brain_status 都照这份贴。 */
  card: string;
}

export interface ApprovalView {
  id: string;
  taskId: string | null;
  kind: string;
  tier: number;
  title: string;
  status: string;
  pendingUntil: string;
  createdAt: string;
}

export interface RecoveryView {
  headline: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  raw: unknown;
}

export interface LedgerView {
  ok: boolean;
  path: string;
  error: string | null;
  /** 非终态任务，最新在前。 */
  tasks: TaskCardView[];
  /** 终态任务，最新在前，只给状态页列一行。 */
  terminalTasks: TaskCardView[];
  approvals: ApprovalView[];
  recovery: RecoveryView | null;
  generatedAt: string;
}

export interface ReadLedgerOptions {
  /** 非终态任务取几条，默认 20。 */
  limitOpen?: number;
  /** 终态任务取几条，默认 10。 */
  limitTerminal?: number;
  now?: Date;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toTaskCard(db: ReturnType<typeof openLedger>, row: TaskRow): TaskCardView {
  let stateLabel: string = row.state;
  let card: string;
  try {
    const view = readTaskView(db, row.id);
    stateLabel = view.stateLabel;
    card = renderProgressCard(view);
  } catch (err) {
    card = `【任务 ${row.id}】${row.intent}\n状态：${row.state}（进度卡读不出来：${errorText(err)}）`;
  }
  return {
    id: row.id,
    intent: row.intent,
    state: row.state,
    stateLabel,
    profile: row.profile,
    updatedAt: row.updated_at,
    card,
  };
}

function toApprovalView(row: ApprovalRow): ApprovalView {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    tier: row.tier,
    title: row.title,
    status: row.status,
    pendingUntil: row.pending_until,
    createdAt: row.created_at,
  };
}

function toRecoveryView(value: unknown): RecoveryView | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof rec[key] === "string" && (rec[key] as string).trim() !== "" ? (rec[key] as string) : null;
  return {
    headline: pick("headline"),
    startedAt: pick("startedAt"),
    finishedAt: pick("finishedAt"),
    raw: value,
  };
}

export function readLedgerView(ledgerPath: string, opts: ReadLedgerOptions = {}): LedgerView {
  const now = opts.now ?? new Date();
  const base: LedgerView = {
    ok: false,
    path: ledgerPath,
    error: null,
    tasks: [],
    terminalTasks: [],
    approvals: [],
    recovery: null,
    generatedAt: now.toISOString(),
  };

  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(ledgerPath, { readOnly: true, createDir: false, busyTimeoutMs: 2000 });
    db.exec("PRAGMA query_only = ON");
    const missing = missingTables(db);
    if (missing.length > 0) {
      return { ...base, error: `账本缺表：${missing.join(",")}（迁移还没跑）` };
    }

    const openRows = listTasks(db, { state: [...OPEN_TASK_STATES], limit: opts.limitOpen ?? 20 });
    const terminalRows = listTasks(db, { state: ["done", "failed", "cancelled"], limit: opts.limitTerminal ?? 10 });
    return {
      ...base,
      ok: true,
      tasks: openRows.map((row) => toTaskCard(db as NonNullable<typeof db>, row)),
      terminalTasks: terminalRows.map((row) => toTaskCard(db as NonNullable<typeof db>, row)),
      approvals: listOpenApprovals(db).map(toApprovalView),
      recovery: toRecoveryView(latestRecoveryReport(db)),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const hint =
      code === "ENOENT" || /unable to open/i.test(errorText(err))
        ? "（账本还没建，或盘紧写不进）"
        : "";
    return { ...base, error: `账本打不开：${errorText(err)}${hint}` };
  } finally {
    try {
      db?.close();
    } catch {
      // 关不上就算了，进程退出也会释放。
    }
  }
}

export type ArtifactRead =
  | { found: true; hash: string; content: string; createdAt: string }
  | {
      found: false;
      /** collected=真被维护回收；invalid_hash=链接本身不对；ledger_unavailable=账本打不开。 */
      kind: "collected" | "invalid_hash" | "ledger_unavailable";
      reason: string;
    };

/**
 * /artifact/<hash>：只读取明细全文。找不到按 B.7 的口径回「已回收·原因」，不回空。
 * 但「链接格式不对」「账本打不开」不是回收，别给它们套「已回收」的帽子。
 */
export function readArtifact(ledgerPath: string, hash: string): ArtifactRead {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(hash)) {
    return {
      found: false,
      kind: "invalid_hash",
      reason: "链接格式不对：哈希只允许字母、数字、下划线、连字符（8–128 位）",
    };
  }
  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(ledgerPath, { readOnly: true, createDir: false, busyTimeoutMs: 2000 });
    db.exec("PRAGMA query_only = ON");
    const hit = getArtifact(db, hash);
    if (!hit.found) {
      return {
        found: false,
        kind: "collected",
        reason: "账本里没有这个明细（维护任务已回收，或链接本来就错）",
      };
    }
    return { found: true, hash: hit.hash, content: hit.content, createdAt: hit.createdAt };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { found: false, kind: "ledger_unavailable", reason: "账本还没建" };
    }
    return { found: false, kind: "ledger_unavailable", reason: `账本打不开：${errorText(err)}` };
  } finally {
    try {
      db?.close();
    } catch {
      // 同上。
    }
  }
}

/**
 * 只读取一张审批单（/notify 渲染请示卡用）。找不到返回 null。
 */
export function readApproval(ledgerPath: string, approvalId: string): ApprovalRow | null {
  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(ledgerPath, { readOnly: true, createDir: false, busyTimeoutMs: 2000 });
    db.exec("PRAGMA query_only = ON");
    return getApproval(db, approvalId);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 同上。
    }
  }
}
