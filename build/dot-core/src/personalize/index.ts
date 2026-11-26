/**
 * src/personalize/index.ts —— Agent 个性化（名字/头像/风格自定义）。
 *
 * 2026-11-26：对标 Muse 的 agent personalization。用户可以给 agent 起名字、
 * 设头像、选说话风格，这些配置会注入系统提示词影响回复方式。
 *
 * 设计：
 * - AgentProfile: 名字、头像 emoji、说话风格、语气、语言偏好、额外指令
 * - 存 ~/.allbot/dot/profile.json
 * - buildSystemPrompt() 生成注入用的个性化片段
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type AgentStyle = "friendly" | "professional" | "concise" | "humorous" | "technical";

export interface AgentProfile {
  /** Agent 名字。 */
  name: string;
  /** 头像（emoji 或 URL）。 */
  avatar: string;
  /** 说话风格。 */
  style: AgentStyle;
  /** 语言偏好。 */
  language: "zh-CN" | "en-US" | "auto";
  /** 额外自定义指令（自由文本）。 */
  customInstructions: string;
  /** 语气强度（1=温和，5=直接）。 */
  toneIntensity: number;
  /** 创建时间。 */
  created_at: string;
  /** 更新时间。 */
  updated_at: string;
}

export const DEFAULT_PROFILE: AgentProfile = {
  name: "Dot",
  avatar: "🤖",
  style: "friendly",
  language: "zh-CN",
  customInstructions: "",
  toneIntensity: 3,
  created_at: "",
  updated_at: "",
};

const STYLE_PROMPTS: Record<AgentStyle, string> = {
  friendly: "用友好亲切的语气回复，像朋友聊天一样自然。",
  professional: "用专业严谨的语气回复，注重准确性和条理性。",
  concise: "用简洁精炼的语言回复，直击要点，不废话。",
  humorous: "适当加入幽默元素，让对话轻松有趣，但不牺牲准确性。",
  technical: "用技术风格回复，可以使用专业术语，注重细节和代码。",
};

// ── 个性化管理 ────────────────────────────────────────────────────────────────

export class PersonalizeStore {
  private readonly path: string;
  private profile: AgentProfile;

  constructor(path?: string) {
    this.path = path ?? join(homedir(), ".allbot", "dot", "profile.json");
    this.profile = { ...DEFAULT_PROFILE };
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<AgentProfile>;
      this.profile = { ...DEFAULT_PROFILE, ...parsed };
    } catch { /* 坏文件用默认 */ }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.profile.updated_at = new Date().toISOString();
    writeFileSync(this.path, JSON.stringify(this.profile, null, 2), "utf8");
  }

  /** 获取当前 profile。 */
  get(): AgentProfile {
    return { ...this.profile };
  }

  /** 更新 profile（部分更新）。 */
  update(patch: Partial<AgentProfile>): AgentProfile {
    this.profile = {
      ...this.profile,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    this.save();
    return { ...this.profile };
  }

  /** 重置为默认。 */
  reset(): AgentProfile {
    this.profile = { ...DEFAULT_PROFILE, created_at: new Date().toISOString() };
    this.save();
    return { ...this.profile };
  }
}

// ── 生成系统提示词片段 ────────────────────────────────────────────────────────

export function buildPersonalizePrompt(profile: AgentProfile): string {
  const parts: string[] = [];

  parts.push(`你是 ${profile.name}（${profile.avatar}）。`);
  parts.push(`说话风格：${STYLE_PROMPTS[profile.style]}`);

  if (profile.language === "zh-CN") {
    parts.push("用中文回复。");
  } else if (profile.language === "en-US") {
    parts.push("Reply in English.");
  }

  if (profile.toneIntensity <= 2) {
    parts.push("语气温和，避免过于直接的否定。");
  } else if (profile.toneIntensity >= 4) {
    parts.push("语气直接，有问题直说，不绕弯子。");
  }

  if (profile.customInstructions.trim()) {
    parts.push(`额外要求：${profile.customInstructions.trim()}`);
  }

  return parts.join("\n");
}

// ── 全局单例 ──────────────────────────────────────────────────────────────────

let globalStore: PersonalizeStore | null = null;

export function getPersonalizeStore(path?: string): PersonalizeStore {
  if (globalStore === null) globalStore = new PersonalizeStore(path);
  return globalStore;
}
