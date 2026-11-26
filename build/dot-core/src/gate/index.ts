/**
 * src/gate/index.ts —— src/gate 的公开面。
 * 只依赖 ../ledger/index.ts（账本唯一写入口），不复制账本代码。
 */

export type {
  GateInput,
  TierVerdict,
  Tier,
  Handling,
  SideEffect,
  ExecVerdict,
} from "./types.ts";

export { judgeTier } from "./judge.ts";
export { classifySideEffect } from "./policy.ts";
export {
  DEFAULT_EXEC_WHITELIST,
  DEFAULT_PROTECTED_APPS,
  isProtectedApp,
  normalizeProgramName,
  isDeniedTool,
} from "./policy.ts";
export {
  execArgVerdict,
  isWhitelistedProgram,
  tokenizeCommand,
  executableArgMarkers,
} from "./exec.ts";
export {
  createApproval,
  decideApproval,
  verifyIdempotent,
  sweepExpired,
  readApproval,
  type GateApprovalRequest,
  type GateApprovalResult,
  type GateDecision,
} from "./approval.ts";
