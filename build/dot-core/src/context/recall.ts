/**
 * src/context/recall.ts —— 按编号取回临时细节（A.10「上下文三类」的第三类）。
 *
 * 锚点只放骨架；真正的长明细（一条命令的全量输出、一份快照说明）不能每轮都进提示词。
 * 明细按内容哈希存在 artifacts 表里（ledger/records.ts 的 putArtifact），步骤行只留
 * `result_ref` 这个哈希；快照行只留路径与 restore 说明。这个文件把「编号 → 正文」
 * 那一步做成一个只读函数，供 recall-tool 暴露给模型。
 *
 * 两条边界（A.10 / B.7）：
 * 1. **只读账本**。这里只调 ledger 的读接口，不读日志文件、不读会话文件。参数长得像
 *    文件路径的直接拒（避免模型把 ref 当成"路径"顺手读盘）。
 * 2. **取不到给可读说明，不抛**。明细被回收是正常状态（B.7 要求返回「已回收·原因」），
 *    工具调用不该因为一个过期编号把整轮对话打断。
 */

import {
  artifactBelongsToTask,
  getArtifact,
  getStep,
  listSnapshots,
  type LedgerDb,
  type SnapshotRow,
} from "../ledger/index.ts";

/** 单次取回的文本上限。超了截短并注明原始字数（避免一条长输出撑爆上下文）。 */
export const RECALL_TEXT_LIMIT = 8000;

/**
 * 取回参数。三者至少给一个；同时给时按 step_id > artifact > ref 的顺序解析
 * （step_id 最具体，artifact 是显式哈希，ref 是"你猜"）。
 */
export interface RecallQuery {
  ref?: string;
  step_id?: string;
  artifact?: string;
}

/** 内容类型：artifact=明细全文；snapshot=快照说明；none=没取到。 */
export type RecallKind = "artifact" | "snapshot" | "none";

/** 参数走的是哪条路，方便测试与日志区分。 */
export type RecallSource = "step" | "artifact" | "ref";

export interface RecallResult {
  ok: boolean;
  kind: RecallKind;
  source: RecallSource;
  /** 实际取内容的编号（artifact 哈希或快照 id）；取不到时为 null。 */
  ref: string | null;
  /** 给模型看的正文；ok=false 时是可读的错误说明。 */
  text: string;
  /** 截短前的字符数（成功时才有意义）。 */
  originalChars: number;
  truncated: boolean;
}

export interface RecallInput extends RecallQuery {
  /** 任务号：只允许在这个任务里查步骤与快照，防止跨任务串读。 */
  taskId: string;
}

const ENDED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
  "rolled_back",
]);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 参数长得像盘符路径或带分隔符 → 拒。只读账本，不读文件。 */
function looksLikePath(value: string): boolean {
  return /[/\\]/.test(value) || /^[a-z]:/i.test(value) || /^~/.test(value);
}

function truncate(text: string): { text: string; originalChars: number; truncated: boolean } {
  const originalChars = text.length;
  if (originalChars <= RECALL_TEXT_LIMIT) {
    return { text, originalChars, truncated: false };
  }
  return {
    text: `${text.slice(0, RECALL_TEXT_LIMIT)}\n…（已截短，共 ${originalChars} 字符）`,
    originalChars,
    truncated: true,
  };
}

function fail(source: RecallSource, ref: string | null, message: string): RecallResult {
  return { ok: false, kind: "none", source, ref, text: message, originalChars: 0, truncated: false };
}

/**
 * 明细哈希 → 正文；取不到返回可读说明（不抛）。
 *
 * 归属先查：artifacts 按内容哈希存、没有 task_id 列，所以「是不是这个任务的」只能
 * 按引用关系反查（steps.args_ref / steps.result_ref / snapshots.restore_json）。
 * 查不到引用就拒——文件头写着「防止跨任务串读」，这一条以前只核了 step 与 snapshot
 * 两路，artifact 那一路漏了（2026-11-25 评审指出）。
 */
function readArtifact(db: LedgerDb, taskId: string, hash: string, source: RecallSource): RecallResult {
  const got = getArtifact(db, hash);
  if (!got.found) {
    return fail(
      source,
      hash,
      `明细 ${hash} 已被回收（B.7）——内容不再保存，无法取回。 ` +
        `步骤行里的错误与状态仍在账本，可看进度卡。`,
    );
  }
  if (!artifactBelongsToTask(db, taskId, hash)) {
    return fail(
      source,
      hash,
      `明细 ${hash} 不属于任务 ${taskId}（该任务的步骤与快照都没引用它），不能在这里取回。`,
    );
  }
  const t = truncate(got.content);
  return {
    ok: true,
    kind: "artifact",
    source,
    ref: hash,
    text: t.text,
    originalChars: t.originalChars,
    truncated: t.truncated,
  };
}

/** 快照只存路径与 restore 说明，正文不在账本里；这里返回说明而不是文件内容。 */
function describeSnapshot(db: LedgerDb, row: SnapshotRow): RecallResult {
  const lines: string[] = [];
  lines.push(`快照 ${row.id}（kind=${row.kind}）`);
  lines.push(`路径：${row.ref}`);
  lines.push(`创建于：${row.created_at}`);
  if (row.milestone_id) lines.push(`所属里程碑：${row.milestone_id}`);
  lines.push(
    row.restore_json
      ? `restore：${row.restore_json}`
      : "restore：（这条快照没记还原信息）",
  );
  lines.push("说明：快照内容的正文不在这份账本里，这里只给路径；要还原按 restore 走回退流程。");
  const t = truncate(lines.join("\n"));
  return {
    ok: true,
    kind: "snapshot",
    source: "ref",
    ref: row.id,
    text: t.text,
    originalChars: t.originalChars,
    truncated: t.truncated,
  };
}

/**
 * 取回入口。顺序：step_id → artifact → ref。
 * 任何一条路取不到都返回 ok=false 的可读说明，绝不抛。
 */
export function recall(db: LedgerDb, input: RecallInput): RecallResult {
  const taskId = nonEmpty(input.taskId);
  if (taskId === null) {
    return fail("ref", null, "recall：缺少任务号（taskId），拒绝跨任务取回。");
  }

  const stepId = nonEmpty(input.step_id);
  const artifactHash = nonEmpty(input.artifact);
  const ref = nonEmpty(input.ref);

  if (stepId === null && artifactHash === null && ref === null) {
    return fail("ref", null, "recall：至少给 step_id / artifact / ref 之一。");
  }

  // 1) step_id：取那一步的 result_ref（明细哈希）。
  if (stepId !== null) {
    const step = getStep(db, stepId);
    if (step === null) {
      return fail("step", stepId, `没有这一步：${stepId}（编号不存在）。`);
    }
    if (step.task_id !== taskId) {
      return fail("step", stepId, `步骤 ${stepId} 属于别的任务，不能在这里取回。`);
    }
    const resultRef = nonEmpty(step.result_ref);
    if (resultRef === null) {
      return fail(
        "step",
        stepId,
        `步骤 ${stepId} 没有结果明细（status=${step.status}` +
          `${ENDED_STATUSES.has(step.status) ? "，已结束但没有 result_ref" : "，还没结束"}）。`,
      );
    }
    return readArtifact(db, taskId, resultRef, "step");
  }

  // 2) artifact：显式哈希，直接读明细。
  if (artifactHash !== null) {
    if (looksLikePath(artifactHash)) {
      return fail("artifact", artifactHash, "artifact 只收哈希；这里不读文件/日志/会话。");
    }
    return readArtifact(db, taskId, artifactHash, "artifact");
  }

  // 3) ref：可能是快照 id，也可能是明细哈希。
  const refValue = ref as string;
  if (looksLikePath(refValue)) {
    return fail("ref", refValue, "ref 只收账本编号（快照 id 或明细哈希）；这里不读文件/日志/会话。");
  }
  const snapshot = listSnapshots(db, taskId).find((s) => s.id === refValue);
  if (snapshot !== undefined) return describeSnapshot(db, snapshot);
  return readArtifact(db, taskId, refValue, "ref");
}
