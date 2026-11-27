/**
 * src/skills/index.ts —— 技能库：把 openai/skills + openai/plugins 里的 SKILL.md 变成工人能用的一条工具。
 *
 * 为什么要有它：从 openai/skills + openai/plugins 里筛出的通用做法说明（白名单少量条目）
 * 加上项目自己的技能，都是「怎么做某件事」的文字，不是代码。机器没开 shell 手，
 * 技能里带脚本的部分**跑不了**；能给的是判断、步骤、坑——这仍然比模型自己瞎猜强。
 *
 * 两条动作：
 *   search  按意图找技能（只看 name/description 的倒排打分，不读正文）
 *   read    按 id 读正文（去掉 frontmatter，默认截 4000 字，防止一口气灌满上下文）
 *
 * 索引由 build/tools/skills-index.mjs 生成：~/.allbot/dot/skills/index.json
 * 索引不存在时 search 会直说「技能库没建」，不假装没有匹配。
 *
 * 这件工具只读本地文件、没有副作用，和 dot_recall 一样落 1 档，也不写步骤。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SKILLBOOK_TOOL_NAME = "skillbook";

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  plugin: string | null;
  bytes: number;
}

export interface SkillIndex {
  built_at: string;
  count: number;
  skills: SkillEntry[];
}

export const SKILLBOOK_TOOL_DEFINITION = {
  name: SKILLBOOK_TOOL_NAME,
  description:
    "技能库（少量通用做法说明 + 项目自己的技能，说明多为英文）。" +
    "action=search 按意图找（给你 id + 一句说明）；action=read 按 id 读正文（步骤、坑、检查清单）。" +
    "**查询用英文关键词命中率最高**（做表格→spreadsheet，日历→calendar，设计稿→figma，报表→report）。" +
    "技能里的命令这台机器跑不了（没有 shell 手），借它的做法和判断用。只读，不改任何东西。",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "read"], description: "search 找，read 读正文" },
      query: { type: "string", description: "search 用：你要干的事，中英文都行" },
      id: { type: "string", description: "read 用：search 回来的 id，例如 plugins/figma/figma-use" },
      limit: { type: "number", description: "search 返回几条，默认 5，最多 20" },
      max_chars: { type: "number", description: "read 截多少字，默认 4000，最多 12000" },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

export function skillIndexPath(dotDir: string): string {
  return join(dotDir, "skills", "index.json");
}

/** 读一次索引；文件不在或坏了就返回 null（调用方给可读说明，不抛）。 */
export function loadSkillIndex(path: string): SkillIndex | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SkillIndex>;
    if (!Array.isArray(raw.skills)) return null;
    const skills = raw.skills.filter(
      (s): s is SkillEntry =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as SkillEntry).id === "string" &&
        typeof (s as SkillEntry).description === "string",
    );
    return { built_at: typeof raw.built_at === "string" ? raw.built_at : "", count: skills.length, skills };
  } catch {
    return null;
  }
}

/**
 * 分词：ASCII 按单词，中文按二元组。
 * 不引分词库是有意的——索引只有几 MB，二元组对这种短描述的召回够用，也不增加依赖。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+.-]*/g)) {
    if (m[0].length >= 2) tokens.push(m[0]);
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

export interface SkillHit {
  id: string;
  name: string;
  description: string;
  source: string;
  plugin: string | null;
  score: number;
}

/**
 * 打分：命中名字 ×3、命中描述 ×1，再按 id 长短微调（越具体的技能越靠前）。
 * 全 0 的不返回——宁可说「没找到」，也不拿不相干的技能糊弄模型。
 */
export function searchSkills(index: SkillIndex, query: string, limit = 5): SkillHit[] {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return [];
  const hits: SkillHit[] = [];
  for (const s of index.skills) {
    const nameTokens = new Set(tokenize(s.name.replace(/[-_/]/g, " ")));
    const descTokens = new Set(tokenize(s.description));
    let score = 0;
    for (const t of qTokens) {
      if (nameTokens.has(t)) score += 3;
      else if (descTokens.has(t)) score += 1;
    }
    if (score > 0) {
      hits.push({ id: s.id, name: s.name, description: s.description, source: s.source, plugin: s.plugin, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, Math.max(1, Math.min(20, limit)));
}

export function findSkill(index: SkillIndex, id: string): SkillEntry | null {
  const key = id.trim();
  if (key === "") return null;
  const exact = index.skills.find((s) => s.id === key);
  if (exact !== undefined) return exact;
  // 也认只给末段名字的写法（「figma-use」→ plugins/figma/figma-use）
  const byTail = index.skills.filter((s) => s.id.endsWith(`/${key}`) || s.name === key);
  return byTail.length === 1 ? (byTail[0] ?? null) : null;
}

/** 去掉 frontmatter，只留正文。 */
export function stripFrontmatter(text: string): { front: string; body: string } {
  if (!text.startsWith("---")) return { front: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { front: "", body: text };
  const fmEnd = text.indexOf("\n", end + 1);
  const front = text.slice(4, end);
  const body = fmEnd < 0 ? "" : text.slice(fmEnd + 1);
  return { front, body };
}

export interface SkillbookResult {
  ok: boolean;
  text: string;
  data?: Record<string, unknown>;
}

export interface SkillbookDeps {
  indexPath: string;
  /** 缓存下来的索引；第一次用到时才读，之后复用（undefined = 还没读）。 */
  cache?: { index?: SkillIndex | null };
}

export function executeSkillbook(
  deps: SkillbookDeps,
  args: { action?: unknown; query?: unknown; id?: unknown; limit?: unknown; max_chars?: unknown },
): SkillbookResult {
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  if (action !== "search" && action !== "read") {
    return { ok: false, text: "skillbook 只认 action=search 或 read" };
  }
  const cache = (deps.cache ??= {});
  if (cache.index === undefined) cache.index = loadSkillIndex(deps.indexPath);
  const index = cache.index;
  if (index === null) {
    return {
      ok: false,
      text: `技能库索引不存在：${deps.indexPath}。先跑 node build/tools/skills-index.mjs 建索引。`,
    };
  }

  if (action === "search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") return { ok: false, text: "search 要 query（你要干的事）" };
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 5;
    const hits = searchSkills(index, query, limit);
    if (hits.length === 0) {
      return {
        ok: false,
        text:
          `技能库里没有和「${query}」对得上的（全库 ${index.count} 条，说明文字都是英文）。` +
          "换成英文关键词再搜一次（做表格→spreadsheet，日历→calendar，设计稿→figma，报表→report）；" +
          "还是没有就按你自己的想法做，别硬套。",
      };
    }
    const lines = hits.map((h, i) => `${i + 1}. ${h.id}\n   ${h.description.slice(0, 220)}`);
    return {
      ok: true,
      text: `找到 ${hits.length} 条（全库 ${index.count} 条）。要用哪条就读它：skillbook read id=<id>\n${lines.join("\n")}`,
      data: { hits: hits.map((h) => ({ id: h.id, name: h.name, score: h.score })) },
    };
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id === "") return { ok: false, text: "read 要 id（search 回来的那个，例如 plugins/figma/figma-use）" };
  const entry = findSkill(index, id);
  if (entry === null) {
    return { ok: false, text: `技能库里没有 ${id}。先用 skillbook search 找准确 id。` };
  }
  let text = "";
  try {
    text = readFileSync(entry.path, "utf8");
  } catch (err) {
    return { ok: false, text: `技能文件读不出来（${entry.path}）：${(err as Error).message}` };
  }
  const { body } = stripFrontmatter(text);
  const cap =
    typeof args.max_chars === "number" && Number.isFinite(args.max_chars)
      ? Math.max(500, Math.min(12000, Math.floor(args.max_chars)))
      : 4000;
  const trimmed = body.trim();
  const shown = trimmed.length > cap ? `${trimmed.slice(0, cap)}\n…（还有 ${trimmed.length - cap} 字没显示，需要就再读一次并调大 max_chars）` : trimmed;
  return {
    ok: true,
    text: `【${entry.id}】${entry.description}\n\n${shown}`,
    data: { id: entry.id, chars: trimmed.length, shown: Math.min(cap, trimmed.length) },
  };
}
