/**
 * src/hands/heartbeat.ts —— dot-core 的存活心跳（keeper 的判据之一）。
 *
 * 契约在 build/tools/keeper.ps1:24-28 与 Get-DotCoreProbe（同文件 :385-410）里写死：
 *   <user>\.allbot\dot\state\dot-core.heartbeat，超过 600 秒算过期；
 *   过期 = 有「未加载」的证据 → keeper 停 18789（fail-closed）。
 * 没有心跳文件、状态接口也没有 loaded 标记时 keeper 报黄不停网关——所以**心跳必须写**，
 * 否则 fail-closed 这条防线永远是黄的，鉴定不出「插件没加载」。
 *
 * 实现刻意朴素：注册时立刻写一次，之后每 intervalMs（默认 60s）覆盖写一次。
 * 定时器 unref，不拖住进程退出；stop() 给测试和优雅关闭用。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HEARTBEAT_STALE_SECONDS = 600;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface HeartbeatOptions {
  /** `<dotDir>/state/dot-core.heartbeat`。 */
  path: string;
  intervalMs?: number;
  now?: () => Date;
  /** 心跳里带什么（版本号等）；不参与判定，只给排障看。 */
  meta?: Record<string, unknown>;
}

export class Heartbeat {
  readonly path: string;
  readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly meta: Record<string, unknown>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWrittenAt: number | null = null;

  constructor(opts: HeartbeatOptions) {
    this.path = opts.path;
    this.intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.meta = opts.meta ?? {};
  }

  /** 立即写一次；intervalMs > 0 时开始定时覆盖。 */
  start(): void {
    this.touch();
    if (this.timer !== null) return;
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.touch();
      } catch {
        // 心跳写失败不改业务结论：keeper 会按期过期报警，那是它该做的事。
      }
    }, this.intervalMs);
    // 不拖住进程：网关退出时不靠这个定时器活着。
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  touch(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const at = this.now();
    writeFileSync(
      this.path,
      JSON.stringify({ pid: process.pid, at: at.toISOString(), ...this.meta }),
      "utf8",
    );
    this.lastWrittenAt = at.getTime();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get lastWrittenAtMs(): number | null {
    return this.lastWrittenAt;
  }
}

/** 默认位置：`<dotDir>/state/dot-core.heartbeat`。 */
export function heartbeatPathIn(dotDir: string): string {
  return join(dotDir, "state", "dot-core.heartbeat");
}
