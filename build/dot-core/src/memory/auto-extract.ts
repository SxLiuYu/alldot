/**
 * src/memory/auto-extract.ts —— 从任务/对话中自动提炼用户偏好。
 *
 * 2026-11-26：之前记忆需要手动 add。Muse 能自动从交互中提取偏好。
 * 此模块在任务完成后自动分析，把用户偏好、任务经验存入 MemoryStore。
 *
 * 策略（不用 LLM，用规则提取，避免额外 API 调用）：
 * - 用户消息中含「以后」「记得」「总是」「不要」→ user 偏好
 * - 任务成功完成 → task 经验
 * - 任务失败后成功 → task 经验（含错误教训）
 * - 提取关键词作为 scope
 */

import type { MemoryStore, MemoryKind } from "./index.ts";

// ── 偏好模式 ──────────────────────────────────────────────────────────────────

const PREFERENCE_PATTERNS = [
  { regex: /(?:以后|之后|今后|今后|总是|一直|每次|都要)\s*(.{4,60})/, kind: "user" as MemoryKind, label: "习惯" },
  { regex: /(?:记得|记住|别忘了?)\s*(.{4,60})/, kind: "user" as MemoryKind, label: "提醒" },
  { regex: /(?:不要|别|禁止|不允许|不许)\s*(.{4,60})/, kind: "user" as MemoryKind, label: "禁止" },
  { regex: /(?:喜欢|偏好|习惯|希望)\s*(.{4,60})/, kind: "user" as MemoryKind, label: "偏好" },
  { regex: /(?:下次|以后|今后)\s*(?:请|要|帮?)\s*(.{4,60})/, kind: "user" as MemoryKind, label: "请求" },
];

const TASK_KEYWORDS = /\b(?:python|node|js|ts|git|docker|npm|pip|api|sql|csv|json|pdf|excel|word|ppt|文件|数据库|部署|安装|配置|测试|脚本|爬虫|自动化|整理|归档|备份|监控|报警|推送|机器人)\b/gi;

// ── 提取器 ────────────────────────────────────────────────────────────────────

export interface ExtractContext {
  /** 用户消息列表。 */
  userMessages: string[];
  /** 任务意图。 */
  taskIntent: string;
  /** 任务结果摘要（成功时）。 */
  resultSummary?: string;
  /** 是否成功。 */
  success: boolean;
  /** 错误信息（失败时）。 */
  error?: string;
  /** 任务 ID（来源标记）。 */
  taskId?: string;
}

/**
 * 从一次交互中提取记忆并存入 MemoryStore。
 * 返回提取到的记忆条数。
 */
export function autoExtract(store: MemoryStore, ctx: ExtractContext): number {
  let count = 0;

  // 1. 从用户消息提取偏好
  for (const msg of ctx.userMessages) {
    for (const pattern of PREFERENCE_PATTERNS) {
      const match = msg.match(pattern.regex);
      if (match && match[1]) {
        const content = match[1].trim();
        if (content.length >= 4) {
          const scope = extractKeywords(msg);
          store.add(pattern.kind, `[${pattern.label}] ${content}`, {
            scope,
            confidence: 0.7,
            source: ctx.taskId ? `task:${ctx.taskId}` : "auto-extract",
          });
          count++;
        }
      }
    }
  }

  // 2. 任务经验
  if (ctx.success && ctx.resultSummary) {
    const scope = extractKeywords(ctx.taskIntent + " " + ctx.resultSummary);
    store.add("task", `成功完成：${ctx.taskIntent.slice(0, 100)}。结果：${ctx.resultSummary.slice(0, 200)}`, {
      scope,
      confidence: 0.8,
      source: ctx.taskId ? `task:${ctx.taskId}` : "auto-extract",
    });
    count++;
  }

  // 3. 失败教训
  if (!ctx.success && ctx.error) {
    const scope = extractKeywords(ctx.taskIntent + " " + ctx.error);
    store.add("task", `失败教训：${ctx.taskIntent.slice(0, 80)} 失败，原因：${ctx.error.slice(0, 150)}`, {
      scope,
      confidence: 0.6,
      source: ctx.taskId ? `task:${ctx.taskId}` : "auto-extract",
    });
    count++;
  }

  return count;
}

// ── 关键词提取 ────────────────────────────────────────────────────────────────

function extractKeywords(text: string): string[] {
  const words = new Set<string>();
  const lower = text.toLowerCase();

  // 技术关键词
  const techMatches = lower.match(TASK_KEYWORDS);
  if (techMatches) {
    for (const w of techMatches) words.add(w.toLowerCase());
  }

  // 中文 2-4 字词组（简单切分）
  const cnMatches = text.match(/[一-鿿]{2,4}/g);
  if (cnMatches) {
    for (const w of cnMatches.slice(0, 8)) words.add(w);
  }

  return [...words].slice(0, 10);
}

// ── 批量提取（从账本读历史） ──────────────────────────────────────────────────

/**
 * 扫描最近 N 条已完成任务，提取经验存入记忆。
 * 调用时机：手动触发或定期维护。
 */
export function extractFromHistory(
  store: MemoryStore,
  tasks: Array<{
    id: string;
    intent: string;
    result?: string;
    success: boolean;
    error?: string;
  }>,
): number {
  let count = 0;
  for (const t of tasks) {
    count += autoExtract(store, {
      userMessages: [],
      taskIntent: t.intent,
      resultSummary: t.result,
      success: t.success,
      error: t.error,
      taskId: t.id,
    });
  }
  return count;
}
