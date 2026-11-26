/**
 * src/proactive/index.ts —— 主动监控（对标 Muse 的 proactive behavior）。
 *
 * 2026-11-26：Muse 会主动监控并行动，alldot 之前只被动响应。
 * 此模块提供触发器系统：文件变化、定时、网页变化 → 自动派任务。
 *
 * 设计：
 * - Trigger 定义：触发条件 + 触发后执行的任务描述
 * - Monitor 每 N 秒轮询一次所有启用的触发器
 * - 触发时自动创建任务（走 brain_task 同一条路）
 * - 触发有冷却期（cooldown_sec），防重复触发
 *
 * 不做的事：不做事件驱动（fs.watch 在 Windows 上不可靠），只做轮询。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type TriggerType = "file_change" | "schedule" | "web_change";

export interface Trigger {
  id: string;
  /** 触发器名称。 */
  name: string;
  /** 触发类型。 */
  type: TriggerType;
  /** 是否启用。 */
  enabled: boolean;
  /** 触发条件（按 type 不同含义不同）。 */
  condition: {
    /** file_change: 要监控的文件/目录路径。 */
    path?: string;
    /** schedule: cron 表达式（简化：每 N 分钟）。 */
    everyMinutes?: number;
    /** web_change: 要监控的 URL。 */
    url?: string;
  };
  /** 触发后执行的任务描述模板（支持 {{}} 插值）。 */
  taskTemplate: string;
  /** 冷却期（秒）：触发后多久内不重复触发。 */
  cooldownSec: number;
  /** 上次触发时间 ISO。 */
  lastFired?: string;
  /** 创建时间。 */
  created_at: string;
}

export interface MonitorConfig {
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs: number;
  /** 最大并发任务数。 */
  maxConcurrent: number;
}

// ── 监控器 ────────────────────────────────────────────────────────────────────

export class ProactiveMonitor {
  private readonly triggersPath: string;
  private triggers: Trigger[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onTrigger: (trigger: Trigger) => Promise<void>;
  private running = new Set<string>();

  constructor(
    onTrigger: (trigger: Trigger) => Promise<void>,
    triggersPath?: string,
  ) {
    this.triggersPath = triggersPath ?? join(homedir(), ".allbot", "dot", "triggers.json");
    this.onTrigger = onTrigger;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.triggersPath)) return;
    try {
      const raw = readFileSync(this.triggersPath, "utf8");
      this.triggers = JSON.parse(raw) as Trigger[];
    } catch { /* 坏文件，空列表 */ }
  }

  private save(): void {
    mkdirSync(dirname(this.triggersPath), { recursive: true });
    writeFileSync(this.triggersPath, JSON.stringify(this.triggers, null, 2), "utf8");
  }

  // ── 管理 ──

  add(trigger: Omit<Trigger, "id" | "created_at">): Trigger {
    const t: Trigger = {
      ...trigger,
      id: `trg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: new Date().toISOString(),
    };
    this.triggers.push(t);
    this.save();
    return t;
  }

  remove(id: string): boolean {
    const before = this.triggers.length;
    this.triggers = this.triggers.filter((t) => t.id !== id);
    if (this.triggers.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  toggle(id: string): boolean {
    const t = this.triggers.find((x) => x.id === id);
    if (!t) return false;
    t.enabled = !t.enabled;
    this.save();
    return true;
  }

  list(): Trigger[] {
    return [...this.triggers];
  }

  // ── 监控循环 ──

  start(pollIntervalMs = 30_000): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), pollIntervalMs);
    // 立即跑一次
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 跑一轮检查（手动触发也用这个）。 */
  async tick(): Promise<void> {
    for (const trigger of this.triggers) {
      if (!trigger.enabled) continue;
      if (this.running.has(trigger.id)) continue;

      // 冷却期检查
      if (trigger.lastFired) {
        const elapsed = (Date.now() - new Date(trigger.lastFired).getTime()) / 1000;
        if (elapsed < trigger.cooldownSec) continue;
      }

      // 检查触发条件
      let fired = false;
      try {
        fired = await this.checkCondition(trigger);
      } catch { /* 检查失败，跳过 */ }

      if (fired) {
        trigger.lastFired = new Date().toISOString();
        this.save();
        this.running.add(trigger.id);
        try {
          await this.onTrigger(trigger);
        } catch (e) {
          console.error(`主动监控触发器 ${trigger.name} 执行失败:`, e);
        } finally {
          this.running.delete(trigger.id);
        }
      }
    }
  }

  private async checkCondition(trigger: Trigger): Promise<boolean> {
    switch (trigger.type) {
      case "file_change": {
        const path = trigger.condition.path;
        if (!path || !existsSync(path)) return false;
        // 简单检查：文件修改时间是否在上次触发之后
        const stat = statSync(path);
        if (!trigger.lastFired) return true;
        return stat.mtimeMs > new Date(trigger.lastFired).getTime();
      }

      case "schedule": {
        const mins = trigger.condition.everyMinutes;
        if (!mins || mins <= 0) return false;
        if (!trigger.lastFired) return true;
        const elapsed = (Date.now() - new Date(trigger.lastFired).getTime()) / 60000;
        return elapsed >= mins;
      }

      case "web_change": {
        // TODO: fetch URL 并对比 hash（先不实现网络请求，留接口）
        return false;
      }

      default:
        return false;
    }
  }
}
