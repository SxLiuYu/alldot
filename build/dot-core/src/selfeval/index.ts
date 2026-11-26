/**
 * src/selfeval/index.ts —— 给自己做体检：只读账本算指标。
 *
 * 边界（有测试守着）：
 * - 只有纯 SQL + 纯函数：不连网络、不写文件、不改账本任何一行、不读环境变量；
 * - 空账本返回全 0，不报错、不编数；
 * - 失败原因只从 tasks.state_reason 与 steps.error 里归类，归不进去的算「其他」，
 *   不拿模型猜、不补默认理由。
 *
 * 「原地打转」「快照失败」「模型调用失败」这些信号在账本里没有独立的事件类型，
 * 目前写在任务的 state_reason 或失败步的 error 文本里（见 src/dispatch/local-worker.ts
 * 的 wrapUp、src/hands/hand.ts 的 snapshot_failed）。所以这里按文本归类，口径集中在
 * FAILURE_PATTERNS 一处；以后加了专门的事件类型，只改这张表。
 */

import type { LedgerDb } from "../ledger/db.ts";

export interface FailureReason {
  reason: string;
  count: number;
}

export interface SelfMetrics {
  tasksDone: number;
  tasksFailed: number;
  /** done / (done + failed)；分母为 0 时是 0。四位小数。 */
  doneRate: number;
  /** 参与统计的任务（done + failed）平均做了多少步。两位小数。 */
  avgSteps: number;
  /** state_reason 里带「打转」的任务数（打转停下，不一定判失败）。 */
  spinStops: number;
  /** 失败步的 error 里带 snapshot_failed / 快照失败的步数。 */
  snapshotFailures: number;
  /** 当前还挂着的审批单（pending）。这是「此刻」的量，不按时间窗裁剪。 */
  approvalsPending: number;
  /** 失败步的 error 里带模型调用失败的步数。 */
  modelErrors: number;
  /**
   * 前 5 个失败原因，按**受影响的任务数**降序（同一任务同一原因只算一次）；
   * 次数相同按原因名升序。不要拿它当「失败步数」用。
   */
  topFailureReasons: FailureReason[];
}

export interface CollectMetricsOptions {
  /**
   * 看最近几天（按 tasks.created_at 算）。0 或负数 = 不限时间。
   * 不给时默认 7 天。
   */
  sinceDays?: number;
  /** 只看这一个任务（体检单任务时用）。 */
  taskId?: string;
  /** 覆盖「现在」，只给测试用；不传就是真实时间。 */
  now?: Date;
}

/** 归类的五个已知桶 + 兜底。顺序就是匹配优先级。 */
export const FAILURE_KINDS = ["原地打转", "快照失败", "模型调用失败", "超范围", "干不了", "其他"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * 文本 → 桶。按优先级从上往下匹配，命中即停。
 * 「打转」优先于「还差/做不到」：打转收尾自述里常带「还差」，那不是根因。
 */
const FAILURE_PATTERNS: ReadonlyArray<readonly [FailureKind, RegExp]> = [
  ["原地打转", /打转/],
  ["快照失败", /snapshot[_ ]?failed|快照失败/i],
  ["模型调用失败", /模型调用失败|模型报错|model[_ ]?error|LLM/i],
  [
    "超范围",
    /越界|超出|范围|不允许|无权|denied|forbidden|not[_ ]?allowed|outside|out[_ ]of[_ ]scope/i,
  ],
  ["干不了", /干不了|做不到|做不了|无法|不能|不支持|一步都没做|no_steps|unsupported|human_required/i],
];

/**
 * 结算器写的汇总行（"有 3 步没成功（failed=2…）"）不是失败原因本身，
 * 计入会把真实原因淹掉，直接跳过。见 src/dispatch/settle.ts。
 * 恢复协议写的 "recovered: replayable, requeued" 同理：说明的是「已重排」，不是根因。
 */
const AGGREGATE_REASON_RE = /^有 \d+ 步没成功|^recovered:/i;

const TOP_LIMIT = 5;

/** 文本归类。空文本 / 汇总行返回 null（不是一条失败原因）。 */
export function classifyFailure(text: string | null | undefined): FailureKind | null {
  if (text === null || text === undefined) return null;
  const t = String(text).trim();
  if (t === "") return null;
  if (AGGREGATE_REASON_RE.test(t)) return null;
  for (const [kind, re] of FAILURE_PATTERNS) {
    if (re.test(t)) return kind;
  }
  return "其他";
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

interface WhereParts {
  sql: string;
  params: Array<string | number>;
}

/** tasks 的筛选条件；`prefix` 是列前缀（"t." 或 ""）。 */
function taskWhere(prefix: string, cutoff: string | null, taskId: string | undefined): WhereParts {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (cutoff !== null) {
    clauses.push(`${prefix}created_at >= ?`);
    params.push(cutoff);
  }
  if (taskId !== undefined && taskId !== "") {
    clauses.push(`${prefix}id = ?`);
    params.push(taskId);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** steps JOIN tasks 的公共 FROM；窗口按任务的 created_at 算，和任务口径一致。 */
const STEP_JOIN = "FROM steps s JOIN tasks t ON t.id = s.task_id";

function count(db: LedgerDb, sql: string, params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 从账本算指标。只读；空账本返回全 0。
 *
 * 窗口口径：任务按 created_at 落在 [now - sinceDays, now]；步骤跟着它的任务走
 * （一个任务的所有步都算在这个任务名下）。approvalsPending 是当前挂起量，与窗口无关。
 */
export function collectMetrics(db: LedgerDb, opts: CollectMetricsOptions = {}): SelfMetrics {
  const sinceDays = typeof opts.sinceDays === "number" && Number.isFinite(opts.sinceDays) ? opts.sinceDays : 7;
  const nowMs = (opts.now ?? new Date()).getTime();
  // 0 / 负数 = 不限时间（体检全部历史时用）。
  const cutoff = sinceDays > 0 ? new Date(nowMs - sinceDays * 86_400_000).toISOString() : null;
  const taskId = opts.taskId;

  const tw = taskWhere("", cutoff, taskId);
  const twT = taskWhere("t.", cutoff, taskId);

  const stateRows = db
    .prepare(`SELECT state, COUNT(*) AS n FROM tasks ${tw.sql} GROUP BY state`)
    .all(...tw.params) as Array<{ state?: string; n?: number }>;
  const byState = new Map<string, number>();
  for (const row of stateRows) byState.set(String(row.state ?? ""), Number(row.n ?? 0));
  const tasksDone = byState.get("done") ?? 0;
  const tasksFailed = byState.get("failed") ?? 0;
  const counted = tasksDone + tasksFailed;

  const stepCount = count(
    db,
    `SELECT COUNT(*) AS n ${STEP_JOIN} ${appendCond(twT.sql, "t.state IN ('done','failed')")}`,
    twT.params,
  );
  const avgSteps = counted > 0 ? round(stepCount / counted, 2) : 0;
  const doneRate = counted > 0 ? round(tasksDone / counted, 4) : 0;

  const spinStops = count(
    db,
    `SELECT COUNT(*) AS n FROM tasks ${appendCond(tw.sql, "state_reason LIKE '%打转%'")}`,
    tw.params,
  );

  const snapshotFailures = count(
    db,
    `SELECT COUNT(*) AS n ${STEP_JOIN} ${appendCond(twT.sql, "(s.error LIKE '%snapshot_failed%' OR s.error LIKE '%快照失败%')")}`,
    twT.params,
  );

  const modelErrors = count(
    db,
    `SELECT COUNT(*) AS n ${STEP_JOIN} ${appendCond(
      twT.sql,
      "(s.error LIKE '%模型调用失败%' OR s.error LIKE '%模型报错%' OR s.error LIKE '%model_error%')",
    )}`,
    twT.params,
  );

  const apvClauses: string[] = ["status = 'pending'"];
  const apvParams: Array<string | number> = [];
  if (taskId !== undefined && taskId !== "") {
    apvClauses.push("task_id = ?");
    apvParams.push(taskId);
  }
  const approvalsPending = count(
    db,
    `SELECT COUNT(*) AS n FROM approvals WHERE ${apvClauses.join(" AND ")}`,
    apvParams,
  );

  // 失败原因：失败任务的 state_reason + 失败步的 error。
  // interrupted 不收：它多半是恢复协议写的 "recovered: replayable, requeued"，
  // 是「结局不明、已重排」的说明，不是根因；收进来会把真实原因淹掉。
  const reasonTexts: Array<{ taskId: string; text: string }> = [];
  const taskReasons = db
    .prepare(
      `SELECT id AS taskId, state_reason AS text FROM tasks ${appendCond(
        tw.sql,
        "state = 'failed' AND state_reason IS NOT NULL AND state_reason <> ''",
      )}`,
    )
    .all(...tw.params) as Array<{ taskId?: string | null; text?: string | null }>;
  for (const row of taskReasons) {
    if (typeof row.text === "string" && row.text !== "") {
      reasonTexts.push({ taskId: String(row.taskId ?? ""), text: row.text });
    }
  }

  const stepErrors = db
    .prepare(
      `SELECT s.task_id AS taskId, s.error AS text ${STEP_JOIN} ${appendCond(
        twT.sql,
        "s.status IN ('failed','rolled_back') AND s.error IS NOT NULL AND s.error <> ''",
      )}`,
    )
    .all(...twT.params) as Array<{ taskId?: string | null; text?: string | null }>;
  for (const row of stepErrors) {
    if (typeof row.text === "string" && row.text !== "") {
      reasonTexts.push({ taskId: String(row.taskId ?? ""), text: row.text });
    }
  }

  // 按「任务」去重：同一个任务里两条失败步都写打转，只算 1 个任务受影响。
  // 否则 count 会超过 tasksFailed，提示词里会被当成「失败次数」误读（评审指出）。
  const tally = new Map<string, Set<string>>();
  for (const { taskId: id, text } of reasonTexts) {
    const kind = classifyFailure(text);
    if (kind === null) continue;
    const bucket = tally.get(kind) ?? new Set<string>();
    bucket.add(id);
    tally.set(kind, bucket);
  }
  const topFailureReasons = [...tally.entries()]
    .map(([reason, tasks]) => ({ reason, count: tasks.size }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason, "zh-CN"))
    .slice(0, TOP_LIMIT);

  return {
    tasksDone,
    tasksFailed,
    doneRate,
    avgSteps,
    spinStops,
    snapshotFailures,
    approvalsPending,
    modelErrors,
    topFailureReasons,
  };
}

/** 往已有的 WHERE 上再 AND 一条；没有 WHERE 就起一个。 */
function appendCond(whereSql: string, cond: string): string {
  return whereSql === "" ? `WHERE ${cond}` : `${whereSql} AND ${cond}`;
}
