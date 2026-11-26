/**
 * src/context/inject.ts —— 每轮注入的拼装（三类上下文在此合流）。
 *
 * 合流顺序（A.10）：
 *   1. 锚点（anchor.ts，一字不改放最前面，永不砍）
 *   2. 阶段小结（milestones.summary，只取**已结束**的里程碑，按 seq 升序，最多 3 条）
 *
 * 字数上限 1800。超了先砍小结（从最老的砍），锚点不砍——锚点是每轮都必须有的骨架，
 * 小结是「锦上添花」，预算紧时它先让位。`parts.budget` 记下砍了哪一类、砍了几条，
 * 测试据此断言「砍的是小结不是锚点」。
 */

import { listMilestones, type LedgerDb, type MilestoneRow } from "../ledger/index.ts";
import { buildAnchor } from "./anchor.ts";

/** 组装后的总字数上限。 */
export const INJECTION_TEXT_LIMIT = 1800;

/** 阶段小结最多放几条。 */
export const SUMMARY_MAX_COUNT = 3;

/** 算「已结束」的里程碑状态。 */
const ENDED_MILESTONE_STATES: ReadonlySet<string> = new Set(["done", "skipped"]);

export interface BuildInjectionInput {
  taskId: string;
  /** 默认 true；false 时只放锚点（例如压缩后只想给骨架）。 */
  includeStageSummaries?: boolean;
}

export interface InjectionBudget {
  limit: number;
  /** 最终 text 的字符数。 */
  totalChars: number;
  /** 锚点字符数（不砍，用来断言它没被截）。 */
  anchorChars: number;
  /** 保留下来的小结行合计字符数。 */
  summaryChars: number;
  /** 保留下来的小结条数。 */
  summaryCount: number;
  /** 因为超上限或超 3 条而被砍掉的小结条数。 */
  droppedSummaries: number;
  /** 有没有砍过任何东西。 */
  truncated: boolean;
}

export interface InjectionParts {
  anchor: string;
  /** 保留下来的小结行（按 seq 升序）。 */
  summaries: string[];
  /** 被砍掉的小结行（从最老的开始），测试可断言砍的是哪几条。 */
  dropped: string[];
  budget: InjectionBudget;
}

export interface InjectionResult {
  text: string;
  parts: InjectionParts;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 一条小结压成一行。 */
function formatSummaryLine(m: MilestoneRow): string {
  return `阶段小结 #${m.seq}「${m.title}」：${oneLine(m.summary ?? "")}`;
}

/** 已结束且有小结的里程碑，按 seq 升序。 */
function endedSummaries(db: LedgerDb, taskId: string): MilestoneRow[] {
  return listMilestones(db, taskId)
    .filter(
      (m) =>
        ENDED_MILESTONE_STATES.has(m.state) &&
        typeof m.summary === "string" &&
        m.summary.trim() !== "",
    )
    .sort((a, b) => a.seq - b.seq);
}

function joinText(anchor: string, lines: string[]): string {
  return lines.length === 0 ? anchor : `${anchor}\n${lines.join("\n")}`;
}

/**
 * 拼这一轮要注入的正文。任务不存在时返回空锚点 + 空正文（调用方决定怎么处理）。
 */
export function buildInjection(db: LedgerDb, input: BuildInjectionInput): InjectionResult {
  const anchor = buildAnchor({ db, taskId: input.taskId });
  if (anchor === null) {
    return {
      text: "",
      parts: {
        anchor: "",
        summaries: [],
        dropped: [],
        budget: {
          limit: INJECTION_TEXT_LIMIT,
          totalChars: 0,
          anchorChars: 0,
          summaryChars: 0,
          summaryCount: 0,
          droppedSummaries: 0,
          truncated: false,
        },
      },
    };
  }

  const dropped: string[] = [];
  let lines: string[] = [];

  if (input.includeStageSummaries !== false) {
    const all = endedSummaries(db, input.taskId);
    const formatted = all.map(formatSummaryLine);

    // 先按「最多 3 条」截：保留最新的 3 条，更老的先算砍掉。
    const keepCount = Math.min(SUMMARY_MAX_COUNT, formatted.length);
    const overCount = formatted.length - keepCount;
    for (let i = 0; i < overCount; i += 1) dropped.push(formatted[i] as string);
    lines = formatted.slice(overCount);

    // 再按总字数截：超了就继续从最老的（lines 头部）砍。
    while (lines.length > 0 && joinText(anchor, lines).length > INJECTION_TEXT_LIMIT) {
      dropped.push(lines.shift() as string);
    }
  }

  const text = joinText(anchor, lines);
  return {
    text,
    parts: {
      anchor,
      summaries: lines,
      dropped,
      budget: {
        limit: INJECTION_TEXT_LIMIT,
        totalChars: text.length,
        anchorChars: anchor.length,
        summaryChars: lines.length === 0 ? 0 : lines.join("\n").length,
        summaryCount: lines.length,
        droppedSummaries: dropped.length,
        truncated: dropped.length > 0,
      },
    },
  };
}
