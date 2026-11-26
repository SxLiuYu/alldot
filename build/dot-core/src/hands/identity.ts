/**
 * src/hands/identity.ts —— toolCallId → 会话身份表（A.4 主路的第 1 步）。
 *
 * 为什么要这张表：`execute(toolCallId, params)` 只拿得到 toolCallId 和参数，
 * agentId / sessionKey / runId 只有钩子有。所以 dot-core 的 before_tool_call 钩子
 * 把身份按 toolCallId 存进来，execute 时取。取不到就 fail-closed（拒绝执行），
 * 因为「不知道是谁在动」= 账本归因不了 = A.7「归不到就拒绝」。
 *
 * 两类清理，都是必须的：
 * - TTL（默认 10 分钟，A.4 原文）：钩子跑了但工具没执行（被其他钩子拦掉）会留下孤儿。
 * - 取用即删：同一个 toolCallId 只对应一次执行，第二次读到就是重放，拒。
 */

export interface ToolCallIdentity {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  /** 钩子若能从 sessionKey 解析出任务就顺手存上；没有就留空，execute 再解析。 */
  taskId?: string | null;
}

export interface StoredIdentity extends ToolCallIdentity {
  readonly storedAt: number;
}

export class IdentityMissingError extends Error {
  readonly toolCallId: string;
  constructor(toolCallId: string) {
    super(`toolCallId ${toolCallId || "(空)"} 不在身份表里：拒绝执行（fail-closed，A.4 第 1 步）`);
    this.name = "IdentityMissingError";
    this.toolCallId = toolCallId;
  }
}

export interface IdentityTableOptions {
  /** 默认 10 分钟。 */
  ttlMs?: number;
  /** 注入时钟，测试用。 */
  now?: () => number;
  /** 上限，防泄漏撑爆内存；超了丢最老的。 */
  maxEntries?: number;
}

export class IdentityTable {
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, StoredIdentity>();

  constructor(opts: IdentityTableOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 5000;
    this.now = opts.now ?? (() => Date.now());
  }

  remember(toolCallId: string, identity: ToolCallIdentity): void {
    if (typeof toolCallId !== "string" || toolCallId === "") {
      throw new Error("IdentityTable.remember: toolCallId 不能为空");
    }
    this.sweep();
    this.entries.set(toolCallId, { ...identity, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** 取用即删。过期当没有。 */
  take(toolCallId: string): ToolCallIdentity | null {
    const stored = this.entries.get(toolCallId);
    if (stored === undefined) return null;
    this.entries.delete(toolCallId);
    if (this.isExpired(stored)) return null;
    return stripTimestamp(stored);
  }

  /** 只读，不移除（排障/测试用）。 */
  peek(toolCallId: string): ToolCallIdentity | null {
    const stored = this.entries.get(toolCallId);
    if (stored === undefined || this.isExpired(stored)) return null;
    return stripTimestamp(stored);
  }

  get size(): number {
    return this.entries.size;
  }

  sweep(): number {
    let removed = 0;
    for (const [id, stored] of this.entries) {
      if (this.isExpired(stored)) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  private isExpired(stored: StoredIdentity): boolean {
    return this.now() - stored.storedAt > this.ttlMs;
  }
}

function stripTimestamp(stored: StoredIdentity): ToolCallIdentity {
  const { agentId, sessionKey, sessionId, runId, taskId } = stored;
  return { agentId, sessionKey, sessionId, runId, taskId };
}

/**
 * 从 sessionKey 解任务号：A.8 约定工人会话 `sessionKey = task:<task_id>`。
 *
 * 认两种写法，原因见下面那条实测：
 * - `task:<task_id>`：我们派发时传进去的原样键；
 * - `agent:<agentId>:task:<task_id>`：网关在 `agent` 方法里会用 resolveSessionStoreKey
 *   把裸键改写成带 agent 前缀的存储键（allbot-src/src/gateway/session-utils.ts:712-759，
 *   调用点 agent.ts:539），钩子拿到的是改写后的键。不认这种写法，工人会话里锚点不注、
 *   内置工具治理跳过、practice 手回 no_task——会话看着在跑，其实什么都没接上。
 *   任务号是小写十六进制（ledger/db.ts 的 randomId），网关整体小写化不会改坏它。
 */
export function taskIdFromSessionKey(sessionKey: string | undefined): string | null {
  if (typeof sessionKey !== "string") return null;
  const m = /^(?:agent:[^:]+:)?task:(.+)$/i.exec(sessionKey.trim());
  return m === null ? null : m[1];
}
