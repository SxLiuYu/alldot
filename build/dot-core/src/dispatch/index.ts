/**
 * src/dispatch/index.ts —— 派发模块的公开面。
 *
 * 只给 index.ts（插件入口）用：`new Dispatcher({ db, config, runtime })`，
 * gateway_start 里 start()，gateway_stop 与 handle.stop() 里 stop()。
 * 测试直接拿 Dispatcher 调 tickOnce()，不必起网关。
 */

export { Dispatcher, type DispatcherDeps, type DispatchVerifyResult } from "./scheduler.ts";
export { settleTask, inspectTaskRun, TIMEOUT_REASON, type SettleOptions, type SettleReport, type SettleOutcome } from "./settle.ts";
export { resumeAfterDecision, type DecisionResumeAction, type DecisionResumeResult } from "./resume.ts";
export {
  afterSettle,
  consecutiveFailures,
  budgetRatio,
  BUDGET_REPLAN_RATIO,
  CONSECUTIVE_FAILURE_LIMIT,
  type AfterSettleDeps,
  type AfterSettleReport,
  type ReplanNote,
} from "./after-settle.ts";
export { buildWorkerPrompt, type WorkerPrompt } from "./prompt.ts";
export type { DispatchLogger, TickReport, TickStatus, WorkerRunReport } from "./types.ts";
