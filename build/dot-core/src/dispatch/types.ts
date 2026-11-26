/**
 * src/dispatch/types.ts —— 派发器对外的小类型面。
 *
 * 这些类型只描述「派发器和调用方之间的契约」。账本行类型、配置类型都从原处取，
 * 这里不复制一份——复制出来的那份迟早会和账本对不上。
 */

import type { TaskState } from "../ledger/index.ts";
import type { DotCoreConfig } from "../config.ts";

export type DispatchLogger = (level: "info" | "warn" | "error", message: string) => void;

/** 一次 tick 的结局。测试用它断言语义，日志用它给人看。 */
export type TickStatus = "disabled" | "no_runtime" | "refused" | "idle" | "dispatching";

export interface WorkerRunReport {
  taskId: string;
  workerId: string;
  sessionKey: string;
  runId: string | null;
  /** done/failed/paused = 本次派发给出的结论；left = 任务状态不归派发器改（等审批/已取消等）。 */
  outcome: "done" | "failed" | "paused" | "left";
  /** 会话结束后的任务状态（可能被闸门改成 awaiting_approval）。 */
  state: TaskState | null;
  detail: string;
}

export interface TickReport {
  status: TickStatus;
  detail: string;
  /** 本次 tick 认领到的任务 id（按认领顺序）。 */
  claimed: string[];
  /** 每个认领任务的会话结果。 */
  results: WorkerRunReport[];
}

export interface DispatcherConfigSlice {
  dispatch: DotCoreConfig["dispatch"];
}
