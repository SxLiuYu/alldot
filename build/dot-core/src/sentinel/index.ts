/**
 * src/sentinel/index.ts —— Sentinel 权限系统（对标 Muse 的 Sentinel permissions）。
 *
 * 2026-11-26：Muse 的 Sentinel 按服务粒度控制读/写/无 三级权限。
 * alldot 已有的 gate/policy.ts 管的是「动作安不安全」（六档），
 * Sentinel 管的是「这个服务能不能做这类事」——更粗粒度、先于 gate 生效。
 *
 * 设计：
 * - SentinelPolicy: 服务名 → { read, write, exec } 三个布尔值
 * - checkSentinel(tool, action) 在工具调用前检查，不允许直接拒绝
 * - 策略存 ~/.allbot/dot/sentinel.json，可运行时修改
 * - 默认策略：files=全部，browser=读+写，desktop=读，exec=仅白名单
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type ServicePermission = {
  /** 允许读操作。 */
  read: boolean;
  /** 允许写/修改操作。 */
  write: boolean;
  /** 允许执行命令/脚本。 */
  exec: boolean;
};

export type SentinelPolicy = Record<string, ServicePermission>;

export interface SentinelVerdict {
  /** 是否放行。 */
  allowed: boolean;
  /** 拒绝理由（allowed=false 时有值）。 */
  reason?: string;
  /** 命中的规则（服务名）。 */
  service: string;
  /** 请求的权限类别。 */
  category: "read" | "write" | "exec";
}

// ── 默认策略 ──────────────────────────────────────────────────────────────────

export const DEFAULT_SENTINEL_POLICY: SentinelPolicy = {
  files: { read: true, write: true, exec: false },
  browser: { read: true, write: true, exec: false },
  clean_browser: { read: true, write: true, exec: false },
  logged_browser: { read: true, write: true, exec: false },
  desktop: { read: true, write: true, exec: false },
  native_desktop: { read: true, write: true, exec: false },
  wechat: { read: true, write: true, exec: false },
  feishu: { read: true, write: true, exec: false },
  exec: { read: false, write: false, exec: true },
  terminal: { read: false, write: false, exec: true },
  brain: { read: true, write: true, exec: false },
  snapshot: { read: true, write: false, exec: false },
  practice: { read: true, write: true, exec: false },
  dot_recall: { read: true, write: false, exec: false },
  skillbook: { read: true, write: false, exec: false },
};

// ── 动作分类映射 ──────────────────────────────────────────────────────────────

const READ_ACTIONS = new Set([
  "read", "list", "glob", "grep", "search", "view", "screenshot", "status",
  "get", "fetch", "download", "check", "query", "find", "inspect", "snapshot",
  "dot_recall", "skillbook",
]);

const EXEC_TOOLS = new Set(["exec", "terminal", "shell", "command", "bash"]);

const WRITE_ACTIONS = new Set([
  "write", "edit", "create", "mkdir", "copy", "move", "delete", "remove",
  "rename", "upload", "submit", "send", "post", "put", "patch", "fill",
  "type", "click", "press", "key", "input", "install", "uninstall",
]);

function classifyAction(tool: string, action?: string): "read" | "write" | "exec" {
  const t = tool.toLowerCase();
  const a = (action ?? "").toLowerCase();

  // 先按 action 分类（action 比工具名更准确）
  if (a === "exec") return "exec";
  if (READ_ACTIONS.has(a)) return "read";
  if (WRITE_ACTIONS.has(a)) return "write";

  // action 没给或不认识，再按工具名
  if (EXEC_TOOLS.has(t)) return "exec";
  if (READ_ACTIONS.has(t)) return "read";
  return "write"; // 不清楚的一律当写操作管（宁严勿松）
}

// ── Sentinel 核心 ─────────────────────────────────────────────────────────────

export class Sentinel {
  private readonly policyPath: string;
  private policy: SentinelPolicy;

  constructor(policyPath?: string) {
    this.policyPath = policyPath ?? join(homedir(), ".allbot", "dot", "sentinel.json");
    this.policy = { ...DEFAULT_SENTINEL_POLICY };
    this.load();
  }

  private load(): void {
    if (!existsSync(this.policyPath)) return;
    try {
      const raw = readFileSync(this.policyPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SentinelPolicy>;
      // 合并：用户配置覆盖默认
      this.policy = { ...DEFAULT_SENTINEL_POLICY, ...parsed };
    } catch { /* 坏文件用默认 */ }
  }

  save(): void {
    mkdirSync(dirname(this.policyPath), { recursive: true });
    writeFileSync(this.policyPath, JSON.stringify(this.policy, null, 2), "utf8");
  }

  /** 检查工具调用是否被 Sentinel 允许。 */
  check(tool: string, action?: string): SentinelVerdict {
    const service = normalizeServiceName(tool);
    const category = classifyAction(tool, action);

    const perm = this.policy[service];
    if (!perm) {
      // 未知服务：默认全拒（宁严勿松）
      return {
        allowed: false,
        reason: `未知服务 "${service}" 未在 Sentinel 策略中注册`,
        service,
        category,
      };
    }

    const allowed = category === "read" ? perm.read : category === "write" ? perm.write : perm.exec;

    return {
      allowed,
      reason: allowed ? undefined : `服务 "${service}" 的 ${category} 权限已被 Sentinel 禁止`,
      service,
      category,
    };
  }

  /** 修改某服务的权限。 */
  setPermission(service: string, perm: Partial<ServicePermission>): void {
    const key = normalizeServiceName(service);
    this.policy[key] = {
      read: perm.read ?? this.policy[key]?.read ?? false,
      write: perm.write ?? this.policy[key]?.write ?? false,
      exec: perm.exec ?? this.policy[key]?.exec ?? false,
    };
    this.save();
  }

  /** 获取某服务的权限。 */
  getPermission(service: string): ServicePermission | undefined {
    return this.policy[normalizeServiceName(service)];
  }

  /** 列出所有策略。 */
  listPolicy(): SentinelPolicy {
    return { ...this.policy };
  }

  /** 重置为默认策略。 */
  reset(): void {
    this.policy = { ...DEFAULT_SENTINEL_POLICY };
    this.save();
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function normalizeServiceName(tool: string): string {
  return tool.toLowerCase().trim().replace(/[-_\s]+/g, "_");
}

// ── 全局单例 ──────────────────────────────────────────────────────────────────

let globalSentinel: Sentinel | null = null;

export function getSentinel(policyPath?: string): Sentinel {
  if (globalSentinel === null) globalSentinel = new Sentinel(policyPath);
  return globalSentinel;
}
