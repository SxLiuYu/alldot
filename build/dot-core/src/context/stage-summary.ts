/**
 * src/context/stage-summary.ts —— 把一段（一个里程碑）的步骤压成小结，写进
 * `milestones.summary`（A.10 阶段小结；锚点不直接带全部步骤，只带每段小结）。
 *
 * 三条纪律：
 * 1. **只压这一段**。只取 `milestone_id` 等于本里程碑、且已结束的步骤；
 *    别的里程碑的步骤一律不进原料，避免小结串段。
 * 2. **模型是注入的**。本文件不直连任何模型或网络：调模型走 `deps.complete`，
 *    测试里给假实现。这样这个文件能单独跑、也能被换成任意后端。
 * 3. **幂等**。同一个里程碑已有小结就直接返回，不再花模型的钱；要重压传 `force: true`。
 *
 * 小结上限 300 字，超了截断并标「已截」。
 */

import {
  getArtifact,
  getMilestone,
  listSteps,
  updateMilestone,
  LedgerError,
  type LedgerDb,
  type MilestoneRow,
  type StepRow,
} from "../ledger/index.ts";

/** 小结字数上限。 */
export const STAGE_SUMMARY_LIMIT = 300;

/** 原料里每条步骤的结果摘要最多取多少字（只取 result_ref 内容的前缀）。 */
export const RESULT_PREVIEW_CHARS = 200;

/** 一"段"算结束的步骤状态（与 task-view / steps 的终态口径一致）。 */
const ENDED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
  "rolled_back",
]);

export interface StageSummaryDeps {
  db: LedgerDb;
  /** 注入的模型调用：给一段提示词，拿回小结原文。本文件不关心它背后是谁。 */
  complete: (prompt: string) => Promise<string>;
}

export interface SummarizeMilestoneInput {
  taskId: string;
  milestoneId: string;
  /** true = 忽略已有小结，重新压一次。 */
  force?: boolean;
}

export interface StageSummaryResult {
  /** 写进（或本来就有）的 milestones.summary。 */
  summary: string;
  /** 这次有没有真的调模型。 */
  calledModel: boolean;
  /** 小结是否被 300 字上限截断。 */
  truncated: boolean;
  /** 参与压缩的已结束步骤数。 */
  stepCount: number;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 取明细前缀给模型看；取不到就给一句可读说明（不让原料里出现空洞）。 */
function resultPreview(db: LedgerDb, resultRef: string | null): string {
  if (resultRef === null || resultRef.trim() === "") return "（无明细）";
  const got = getArtifact(db, resultRef);
  if (!got.found) return "（明细已回收）";
  const text = oneLine(got.content);
  return text.length <= RESULT_PREVIEW_CHARS
    ? text
    : `${text.slice(0, RESULT_PREVIEW_CHARS)}…`;
}

/** 拼给模型看的原料：只放步骤类型、工具、层级、结果摘要、错误。 */
export function buildSummaryPrompt(db: LedgerDb, milestone: MilestoneRow, steps: StepRow[]): string {
  const head = [
    "【阶段小结】把下面这些步骤压成不超过 300 字的中文小结：只写做成了什么、卡过什么、结果是什么。",
    "只按给出的原料写，不要编造步骤或结论。",
    `里程碑：${milestone.seq}. ${milestone.title}（完成条件：${milestone.done_when}）`,
    "步骤：",
  ];
  const body = steps.map((s, i) => {
    const parts = [
      `${i + 1}. 类型=${s.kind}`,
      `工具=${s.tool ?? "无"}`,
      `层级=${s.tier ?? "无"}`,
      `状态=${s.status}`,
      `结果：${resultPreview(db, s.result_ref)}`,
    ];
    if (s.error !== null && s.error.trim() !== "") parts.push(`错误：${oneLine(s.error)}`);
    return parts.join("｜");
  });
  return [...head, ...body].join("\n");
}

function clipSummary(raw: string): { summary: string; truncated: boolean } {
  const text = raw.trim();
  if (text.length <= STAGE_SUMMARY_LIMIT) return { summary: text, truncated: false };
  return { summary: `${text.slice(0, STAGE_SUMMARY_LIMIT)}…（已截）`, truncated: true };
}

/**
 * 压一段。里程碑不存在或不属于该任务时抛 LedgerError（这是调用方的编程错误，
 * 不是模型能自愈的「取不到」，所以与 recall 的「返回可读说明」不同）。
 */
export async function summarizeMilestone(
  deps: StageSummaryDeps,
  input: SummarizeMilestoneInput,
): Promise<StageSummaryResult> {
  const milestone = getMilestone(deps.db, input.milestoneId);
  if (milestone === null || milestone.task_id !== input.taskId) {
    throw new LedgerError(
      "milestone_not_found",
      `summarizeMilestone: 里程碑 ${input.milestoneId} 不存在或不属于任务 ${input.taskId}`,
    );
  }

  const steps = listSteps(deps.db, input.taskId).filter(
    (s) => s.milestone_id === input.milestoneId && ENDED_STATUSES.has(s.status),
  );

  // 已有小结且没要求重压：直接返回，不再调模型。
  const existing = milestone.summary;
  if (input.force !== true && typeof existing === "string" && existing.trim() !== "") {
    return { summary: existing, calledModel: false, truncated: false, stepCount: steps.length };
  }

  // 这一段没有已结束的步骤：没东西可压，不花模型的钱。
  if (steps.length === 0) {
    return { summary: "", calledModel: false, truncated: false, stepCount: 0 };
  }

  const prompt = buildSummaryPrompt(deps.db, milestone, steps);
  const raw = await deps.complete(prompt);
  const { summary, truncated } = clipSummary(typeof raw === "string" ? raw : String(raw ?? ""));

  updateMilestone(deps.db, input.milestoneId, { summary });
  return { summary, calledModel: true, truncated, stepCount: steps.length };
}
