/**
 * src/gate/policy.ts —— 白名单、受保护程序、side_effect 分类的单一来源。
 * 依据：方案 6.3、5.6、B.8、B.9 与 B.4 配置（desktop.human_only_apps）。
 */

import type { SideEffect } from "./types.ts";
import { UNKNOWN_SEMANTICS, matchesWords } from "./keywords.ts";

/**
 * exec 允许名单。方案 6.3 点名 git、node、python「这类常用的开发工具」；
 * 这里收窄到确定不自带任意代码执行的名字。shell（cmd/powershell/pwsh/bash/sh）
 * 一律不在名单里。可经 options 覆盖，施工时从 config.json 读。
 */
export const DEFAULT_EXEC_WHITELIST: readonly string[] = Object.freeze([
  "git",
  "node",
  "python",
  "python3",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "tsc",
  "eslint",
  "prettier",
  "rg",
  "ls",
  "cat",
]);

/**
 * 受保护程序。方案 B.4 的配置项 desktop.human_only_apps =["Weixin","WeChat"]，
 * 5.6 说「继承 ds-bot 现成的名单再加我们自己的」。ds-bot 名单施工时从
 * 本机配置读入并合并进 extra；这里的内置部分只放方案点名的两个微信进程
 * 及其常见变体，避免凭空 guesses 扩大拒绝面。命中即 6 档直接拒。
 */
export const DEFAULT_PROTECTED_APPS: readonly string[] = Object.freeze([
  "weixin",
  "wechat",
  "wechatex",
  "微信",
]);

/** 去掉路径、引号、Windows 扩展名，统一小写。 */
export function normalizeProgramName(value: string): string {
  let s = String(value ?? "").trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\/g, "/").split("/").at(-1) ?? "";
  s = s.replace(/\.(exe|cmd|bat|ps1|sh|py|com)$/i, "");
  return s.toLowerCase();
}

/** 受保护程序判定。配置里新增的名字走 extra，大小写/路径/扩展名不敏感。 */
export function isProtectedApp(name: string, extra: readonly string[] = []): boolean {
  const norm = normalizeProgramName(name);
  if (norm === "") return false;
  const all = [...DEFAULT_PROTECTED_APPS, ...extra];
  return all.some((item) => normalizeProgramName(item) === norm);
}

/** DENY 工具：名单外的一律拒。方案 B.1 的允许名单与 DENY 由调用方配置传入。 */
export function isDeniedTool(tool: string, denyTools: readonly string[] = []): boolean {
  const norm = normalizeProgramName(tool);
  return denyTools.some((item) => normalizeProgramName(item) === norm);
}

// ── side_effect 分类（B.8 三值，A.9 恢复协议要据此决定问人还是重排） ─────────

/** args 里可选的显式 side_effect；只认三个合法值，其他一律忽略并继续判定。 */
function explicitSideEffect(args: Record<string, unknown>): SideEffect | null {
  const raw = args["side_effect"] ?? args["sideEffect"];
  if (raw === "safe" || raw === "replayable" || raw === "unknown") return raw;
  return null;
}

const READ_TOOLS = new Set([
  "read", "glob", "grep", "list", "list_directory", "search", "find", "view",
  "read_file", "read_browser", "read_image", "read_own_chat", "dot_recall",
  "brain_status", "status", "screenshot",
]);

const WRITE_TOOLS = new Set(["write", "edit", "create", "mkdir", "copy", "move", "write_file"]);

const READ_ACTIONS = new Set(["read", "list", "glob", "grep", "search", "view", "screenshot", "status"]);
const WRITE_ACTIONS = new Set(["write", "edit", "create", "mkdir", "copy", "move", "type", "fill"]);
const UNKNOWN_ACTIONS = new Set([
  "delete", "remove", "rm", "uninstall", "install", "submit", "send", "upload", "pay",
  "login", "password", "captcha", "confirm", "click", "press", "key", "exec", "command",
]);

/**
 * from judgeTier 复用的：这个动作是否带不可逆/身份类语义。
 * 走 keywords.ts 的边界匹配（英文按词边界、中文按子串），不再用 `\b…\b`
 * 包中文——中文两侧不是 \w，旧写法实际上从不命中中文词。
 */
export function hasUnknownSemantics(haystack: string): boolean {
  return matchesWords(haystack, UNKNOWN_SEMANTICS);
}

/**
 * classifySideEffect(tool, args)：不清就 unknown。
 * readonly/查询 → safe；工作区内写与浏览器可逆动作 → replayable；
 * 命令执行、桌面键鼠、提交类、任何不清 → unknown。
 */
export function classifySideEffect(tool: string, args: unknown = {}): SideEffect {
  const obj: Record<string, unknown> =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const explicit = explicitSideEffect(obj);
  if (explicit !== null) return explicit;

  const t = normalizeProgramName(tool);
  const action = String(obj["action"] ?? "").toLowerCase();
  const flags = Array.isArray(obj["flags"])
    ? (obj["flags"] as unknown[]).map((x) => String(x).toLowerCase())
    : [];

  const haystack = [tool, action, ...flags].join(" ").toLowerCase();

  if (t === "exec" || t === "terminal" || action === "exec" || hasUnknownSemantics(haystack)) {
    return "unknown";
  }
  if (UNKNOWN_ACTIONS.has(action)) return "unknown";

  if (READ_TOOLS.has(t) || READ_ACTIONS.has(action)) return "safe";
  if (WRITE_TOOLS.has(t) || WRITE_ACTIONS.has(action)) return "replayable";
  if (t === "desktop" || t === "logged_browser") {
    // 纯读动作已在上面返回；浏览器可逆填表算 replayable，其余键鼠 unknown。
    return obj["reversible"] === true || ["fill", "select", "navigate", "scroll"].includes(action)
      ? "replayable"
      : "unknown";
  }
  if (t === "browser" || t === "logged_browser") return "replayable";
  return "unknown";
}
