/**
 * src/ledger/index.ts —— 账本模块的公开面，也是**唯一写入口**。
 * 后面五个模块（gate/hands/bridge/context/status）只从这里 import，不直接摸内部文件、
 * 不各自拼 SQL：时间格式、ID 前缀、state_reason、blocked_on 的结构都只在这里定义一份。
 *
 * 十二张表都有写入口：
 *   tasks / milestones / plans / approvals / decisions / workers / snapshots /
 *   artifacts / spend_ledger → records.ts
 *   steps → steps.ts   events → events.ts   locks → locks.ts
 */

export {
  openLedger,
  pragmaValue,
  nowIso,
  isoPlus,
  canonicalJson,
  sha256Hex,
  sha256Bytes,
  randomId,
  inTransaction,
  parseJsonOrNull,
  LedgerError,
  LedgerIntegrityError,
  StaleWriterError,
  type LedgerDb,
  type OpenLedgerOptions,
} from "./db.ts";

export {
  migrate,
  getUserVersion,
  missingTables,
  LEDGER_TABLES,
  LEDGER_DDL,
  SCHEMA_VERSION,
  type MigrationResult,
} from "./schema.ts";

export {
  appendEvent,
  verifyChain,
  tailEvents,
  hashEvent,
  GENESIS_HASH,
  type AppendedEvent,
} from "./events.ts";

export {
  beginStep,
  endStep,
  getStep,
  findSucceededStepBySubjectKey,
  openSteps,
  listSteps,
  markStepInterrupted,
  type EndStepOutcome,
} from "./steps.ts";

export {
  STEP_FIELDS,
  snapshotStep,
  diffStepSnapshot,
  readStepSnapshot,
  type StepSnapshot,
} from "./snapshot.ts";

export {
  verifyStepsChain,
  verifyLedger,
  STEP_EVENT_TYPES,
  type StepChainIssue,
  type StepChainStatus,
  type LedgerVerifyResult,
} from "./chain-view.ts";

export {
  acquireLock,
  renewLock,
  releaseLock,
  releaseExpiredLocks,
  releaseLocksOfTask,
  getLock,
  locksOfTask,
  type AcquireLockOptions,
  type AcquireLockResult,
  type LockOwner,
} from "./locks.ts";

export {
  recover,
  latestRecoveryReport,
  type RecoveryReport,
  type RecoverOptions,
  type IntegrityReport,
  type OrphanStepReport,
  type RequeuedTaskReport,
} from "./recover.ts";

export {
  // 两个跨模块约定
  computeSubjectKey,
  makeBlockedOn,
  parseBlockedOn,
  type BlockedOn,
  // tasks
  createTask,
  getTask,
  listTasks,
  setTaskState,
  cancelTask,
  requeueTask,
  requeueAttempts,
  addSpentTokens,
  type CreateTaskInput,
  type ListTasksFilter,
  type SetTaskStateInput,
  type RequeueTaskInput,
  // milestones / plans
  createMilestone,
  getMilestone,
  listMilestones,
  updateMilestone,
  createPlan,
  latestPlan,
  listPlans,
  type MilestoneRow,
  type PlanRow,
  // approvals（B.9）
  createApproval,
  getApproval,
  findOpenApprovalBySubjectKey,
  listApprovals,
  listOpenApprovals,
  decideApproval,
  markApprovalExecuting,
  markApprovalExecuted,
  revokeApproval,
  expireDueApprovals,
  isApprovalStatus,
  type CreateApprovalInput,
  // decisions
  recordDecision,
  listDecisions,
  type DecisionRow,
  // workers
  upsertWorker,
  listWorkers,
  claimTask,
  type WorkerRow,
  type ClaimTaskInput,
  type ClaimTaskResult,
  // snapshots
  createSnapshot,
  listSnapshots,
  type SnapshotRow,
  // artifacts
  putArtifact,
  getArtifact,
  artifactBelongsToTask,
  listArtifacts,
  deleteArtifacts,
  type ArtifactMeta,
  type ArtifactLookup,
  // spend
  recordSpend,
  sumSpend,
  listSpend,
  type SpendRow,
} from "./records.ts";

export { readTaskView, renderProgressCard } from "./task-view.ts";

export * from "./types.ts";
