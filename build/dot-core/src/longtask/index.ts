/**
 * src/longtask/index.ts —— 长程任务管理（超时控制 + 断点续跑）。
 *
 * 2026-11-26：alldot 之前只靠 waitForRun 的 10 分钟默认超时，超时就 fail。
 * Muse 的长程任务会自动断点续跑。此模块提供：
 *
 * - TaskCheckpoint: 任务执行到哪一步、中间产物是什么
 * - LongTaskManager: 管理超时阈值、保存检查点、恢复执行
 * - 恢复策略：超时后从最后一个 checkpoint 重新派任务，跳过已完成步骤
 *
 * 存储：~/.allbot/dot/checkpoints/<task_id>.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface TaskCheckpoint {
  /** 任务 ID。 */
  taskId: string;
  /** 当前阶段描述（人类可读）。 */
  stage: string;
  /** 已完成步骤的索引列表。 */
  completedSteps: number[];
  /** 中间产物（步骤索引 → 输出摘要）。 */
  artifacts: Record<string, string>;
  /** 当前里程碑 ID（如果有）。 */
  milestoneId?: string;
  /** 已消耗 token 数。 */
  spentTokens: number;
  /** 开始时间 ISO。 */
  startedAt: string;
  /** 最后检查点时间 ISO。 */
  checkpointAt: string;
  /** 超时阈值（毫秒）。 */
  timeoutMs: number;
  /** 当前状态。 */
  status: "running" | "paused" | "timeout" | "done" | "failed";
  /** 恢复次数（防无限重试）。 */
  resumeCount: number;
  /** 最后错误信息。 */
  lastError?: string;
}

export interface LongTaskConfig {
  /** 默认超时（毫秒）。2 小时。 */
  defaultTimeoutMs: number;
  /** 最大恢复次数。 */
  maxResumes: number;
  /** 检查点保存间隔（毫秒）。5 分钟。 */
  checkpointIntervalMs: number;
}

export const DEFAULT_LONGTASK_CONFIG: LongTaskConfig = {
  defaultTimeoutMs: 2 * 60 * 60 * 1000, // 2 小时
  maxResumes: 3,
  checkpointIntervalMs: 5 * 60 * 1000, // 5 分钟
};

// ── 管理器 ────────────────────────────────────────────────────────────────────

export class LongTaskManager {
  private readonly baseDir: string;
  private readonly config: LongTaskConfig;
  private readonly checkpoints = new Map<string, TaskCheckpoint>();

  constructor(baseDir?: string, config?: Partial<LongTaskConfig>) {
    this.baseDir = baseDir ?? join(homedir(), ".allbot", "dot", "checkpoints");
    this.config = { ...DEFAULT_LONGTASK_CONFIG, ...config };
    this.loadAll();
  }

  private taskPath(taskId: string): string {
    return join(this.baseDir, `${taskId}.json`);
  }

  private loadAll(): void {
    if (!existsSync(this.baseDir)) return;
    try {
      for (const file of readdirSync(this.baseDir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = readFileSync(join(this.baseDir, file), "utf8");
          const cp = JSON.parse(raw) as TaskCheckpoint;
          this.checkpoints.set(cp.taskId, cp);
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录读不了 */ }
  }

  private save(cp: TaskCheckpoint): void {
    mkdirSync(this.baseDir, { recursive: true });
    writeFileSync(this.taskPath(cp.taskId), JSON.stringify(cp, null, 2), "utf8");
    this.checkpoints.set(cp.taskId, cp);
  }

  // ── 检查点管理 ──

  /** 创建或更新检查点。 */
  checkpoint(taskId: string, patch: Partial<Omit<TaskCheckpoint, "taskId" | "startedAt">>): TaskCheckpoint {
    const existing = this.checkpoints.get(taskId);
    const cp: TaskCheckpoint = {
      taskId,
      stage: patch.stage ?? existing?.stage ?? "初始化",
      completedSteps: patch.completedSteps ?? existing?.completedSteps ?? [],
      artifacts: patch.artifacts ?? existing?.artifacts ?? {},
      milestoneId: patch.milestoneId ?? existing?.milestoneId,
      spentTokens: patch.spentTokens ?? existing?.spentTokens ?? 0,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      checkpointAt: new Date().toISOString(),
      timeoutMs: patch.timeoutMs ?? existing?.timeoutMs ?? this.config.defaultTimeoutMs,
      status: patch.status ?? existing?.status ?? "running",
      resumeCount: patch.resumeCount ?? existing?.resumeCount ?? 0,
      lastError: patch.lastError ?? existing?.lastError,
    };
    this.save(cp);
    return cp;
  }

  /** 获取检查点。 */
  get(taskId: string): TaskCheckpoint | undefined {
    return this.checkpoints.get(taskId);
  }

  /** 列出所有检查点。 */
  list(): TaskCheckpoint[] {
    return [...this.checkpoints.values()];
  }

  /** 列出需要恢复的（超时/暂停）。 */
  listResumable(): TaskCheckpoint[] {
    return this.list().filter(
      (cp) => cp.status === "timeout" || cp.status === "paused",
    );
  }

  /** 标记完成并删除检查点。 */
  complete(taskId: string): boolean {
    if (this.checkpoints.has(taskId)) {
      try { rmSync(this.taskPath(taskId), { force: true }); } catch { /* 尽力删 */ }
      this.checkpoints.delete(taskId);
      return true;
    }
    return false;
  }

  // ── 超时管理 ──

  /** 判断是否超时。 */
  isTimedOut(taskId: string): boolean {
    const cp = this.checkpoints.get(taskId);
    if (!cp) return false;
    if (cp.status !== "running") return false;
    const elapsed = Date.now() - new Date(cp.startedAt).getTime();
    return elapsed > cp.timeoutMs;
  }

  /** 检查超时并标记。返回是否刚被标为超时。 */
  checkTimeout(taskId: string): boolean {
    if (this.isTimedOut(taskId)) {
      this.checkpoint(taskId, {
        status: "timeout",
        lastError: `任务超时（${Math.round((Date.now() - new Date(this.checkpoints.get(taskId)!.startedAt).getTime()) / 60000)} 分钟）`,
      });
      return true;
    }
    return false;
  }

  // ── 断点续跑 ──

  /** 判断能否恢复（未超过最大恢复次数）。 */
  canResume(taskId: string): boolean {
    const cp = this.checkpoints.get(taskId);
    if (!cp) return false;
    return cp.status === "timeout" || cp.status === "paused"
      ? cp.resumeCount < this.config.maxResumes
      : false;
  }

  /** 标记恢复（重置状态为 running，递增 resumeCount）。 */
  resume(taskId: string): TaskCheckpoint | null {
    const cp = this.checkpoints.get(taskId);
    if (!cp || !this.canResume(taskId)) return null;
    const updated = this.checkpoint(taskId, {
      status: "running",
      resumeCount: cp.resumeCount + 1,
      startedAt: undefined as never, // 重置开始时间——patch 里不改 startedAt
    });
    // 手动重置开始时间（checkpoint 方法保留原值）
    updated.startedAt = new Date().toISOString();
    this.save(updated);
    return updated;
  }

  /** 获取恢复提示词（告诉模型从哪里继续）。 */
  buildResumePrompt(taskId: string): string | null {
    const cp = this.checkpoints.get(taskId);
    if (!cp) return null;
    const parts: string[] = [];
    parts.push(`这是一个断点续跑的任务（第 ${cp.resumeCount + 1} 次执行）。`);
    parts.push(`上次进度：${cp.stage}`);
    if (cp.completedSteps.length > 0) {
      parts.push(`已完成步骤：${cp.completedSteps.join(", ")}`);
    }
    const artifacts = Object.entries(cp.artifacts);
    if (artifacts.length > 0) {
      parts.push("中间产物：");
      for (const [step, summary] of artifacts) {
        parts.push(`  步骤 ${step}: ${summary}`);
      }
    }
    if (cp.lastError) {
      parts.push(`上次失败原因：${cp.lastError}`);
    }
    parts.push("请从上次中断的地方继续，不要重复已完成的步骤。");
    return parts.join("\n");
  }
}

// ── 全局单例 ──────────────────────────────────────────────────────────────────

let globalManager: LongTaskManager | null = null;

export function getLongTaskManager(baseDir?: string, config?: Partial<LongTaskConfig>): LongTaskManager {
  if (globalManager === null) globalManager = new LongTaskManager(baseDir, config);
  return globalManager;
}
