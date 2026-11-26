/**
 * src/memory/index.ts —— 跨会话记忆（对标 Muse 的 persistent memory）。
 *
 * 2026-11-26：用户要求「实现 muse 那样的产品」。Muse 的核心体验之一是
 * AI 记得你之前说过什么、做过什么、偏好什么。alldot 之前每次会话都重来。
 *
 * 设计：
 * - 记忆存在 ~/.allbot/dot/memory.jsonl（每行一条记忆）
 * - 记忆分三类：user（用户偏好）、task（任务经验）、context（环境信息）
 * - 每条记忆有 scope（影响范围）和 confidence（置信度 0-1）
 * - 检索：按 scope + 任务相似度排序，取 top-K 注入系统提示词
 *
 * 不做的事：不做向量检索（本地 JSONL 够用）、不自动删除（记忆宁多勿漏）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type MemoryKind = "user" | "task" | "context";

export interface MemoryEntry {
  /** 记忆 id（时间戳+随机）。 */
  id: string;
  /** 记忆类别。 */
  kind: MemoryKind;
  /** 记忆内容（一句话到一段话）。 */
  content: string;
  /** 影响范围：哪些关键词匹配时想起这条（空 = 通用）。 */
  scope: string[];
  /** 置信度 0-1（旧记忆/不确定的信息置信度低）。 */
  confidence: number;
  /** 来源（哪个任务/会话产生）。 */
  source: string;
  /** 创建时间 ISO。 */
  created_at: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

// ── 记忆存储 ──────────────────────────────────────────────────────────────────

export class MemoryStore {
  private readonly path: string;
  private entries: MemoryEntry[] = [];

  constructor(path?: string) {
    this.path = path ?? join(homedir(), ".allbot", "dot", "memory.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          this.entries.push(JSON.parse(line) as MemoryEntry);
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 文件不存在或读不了 */ }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const lines = this.entries.map((e) => JSON.stringify(e));
    writeFileSync(this.path, lines.join("\n") + "\n", "utf8");
  }

  /** 添加一条记忆。 */
  add(
    kind: MemoryKind,
    content: string,
    opts: { scope?: string[]; confidence?: number; source?: string } = {},
  ): MemoryEntry {
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      content: content.trim().slice(0, 2000),
      scope: (opts.scope ?? []).map((s) => s.toLowerCase()),
      confidence: Math.max(0, Math.min(1, opts.confidence ?? 0.8)),
      source: opts.source ?? "session",
      created_at: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  /** 检索记忆。query 是当前任务描述/上下文。 */
  search(query: string, topK = 5): MemorySearchResult[] {
    const q = query.toLowerCase();
    const scored = this.entries.map((entry) => ({
      entry,
      score: this.relevanceScore(q, entry),
    }));
    return scored
      .filter((s) => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private relevanceScore(query: string, entry: MemoryEntry): number {
    // scope 匹配加分
    let score = 0;
    for (const scope of entry.scope) {
      if (query.includes(scope)) score += 0.5;
    }
    // content 关键词匹配（简单分词）
    const words = entry.content.toLowerCase().split(/[\s,.;:!?，。；：！？、]+/).filter((w) => w.length >= 2);
    for (const w of words) {
      if (query.includes(w)) score += 0.15;
    }
    // 置信度作为权重
    score *= entry.confidence;
    // user 类记忆加权（偏好更重要）
    if (entry.kind === "user") score *= 1.3;
    return Math.min(score, 1);
  }

  /** 获取所有用户偏好记忆（注入系统提示词用）。 */
  userPreferences(): string[] {
    return this.entries
      .filter((e) => e.kind === "user")
      .map((e) => e.content);
  }

  /** 获取相关经验（任务执行前调用）。 */
  taskExperience(query: string): MemoryEntry[] {
    return this.search(query, 3)
      .filter((s) => s.entry.kind === "task")
      .map((s) => s.entry);
  }

  /** 总数。 */
  count(): number {
    return this.entries.length;
  }

  /** 导出全部（调试用）。 */
  all(): MemoryEntry[] {
    return [...this.entries];
  }
}

// ── 全局单例 ──────────────────────────────────────────────────────────────────

let globalStore: MemoryStore | null = null;

export function getMemoryStore(path?: string): MemoryStore {
  if (globalStore === null) globalStore = new MemoryStore(path);
  return globalStore;
}

/**
 * 生成注入系统提示词的记忆上下文。
 * 调用时机：工人开工前，把用户偏好和相关经验加进 extraSystemPrompt。
 */
export function buildMemoryContext(store: MemoryStore, taskIntent: string): string {
  const parts: string[] = [];

  // 用户偏好
  const prefs = store.userPreferences();
  if (prefs.length > 0) {
    parts.push("## 用户偏好（记住这些）");
    for (const p of prefs.slice(0, 5)) {
      parts.push(`- ${p}`);
    }
  }

  // 相关任务经验
  const experience = store.taskExperience(taskIntent);
  if (experience.length > 0) {
    parts.push("## 相关经验（之前做过类似的事）");
    for (const e of experience) {
      parts.push(`- ${e.content}`);
    }
  }

  return parts.length > 0 ? "\n\n" + parts.join("\n") : "";
}
