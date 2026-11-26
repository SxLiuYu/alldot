/**
 * src/ledger/types.ts —— 账本模块的类型。表结构以方案附录 B.8 的 DDL 为准，
 * 这里的联合类型与 DDL 里的 CHECK 列表逐字对应，改一处必须同时改另一边。
 */

/** tasks.state（B.8）。外显六态的映射在 task-view.ts 里做。 */
export const TASK_STATES = [
  "queued",
  "running",
  "awaiting_approval",
  "paused",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** steps.kind（B.8）。 */
export const STEP_KINDS = ["llm", "tool", "human", "notify"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * steps.side_effect（B.8）。三值的语义来自 A.9：
 * - safe       ：重复执行无副作用（读文件、读页面）；
 * - replayable ：重复执行等价（幂等写、可覆盖的写）；
 * - unknown    ：无法判定有没有落地，恢复时一律问人，绝不重放（A.9 第 3 条）。
 */
export const SIDE_EFFECTS = ["safe", "replayable", "unknown"] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

/** steps.status（B.8）。 */
export const STEP_STATUSES = [
  "pending",
  "started",
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
  "rolled_back",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** approvals.status（B.8 / B.9 状态机）。 */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "executing",
  "executed",
  "failed",
  "revoked",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** approvals.kind（B.8）。 */
export const APPROVAL_KINDS = ["tool_call", "question", "handoff", "intent"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** approvals.decided_by（B.8）。 */
export const DECIDED_BY = ["dsbot", "feishu", "cli", "system"] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];

/** milestones.state（B.8）。 */
export const MILESTONE_STATES = ["pending", "active", "done", "skipped"] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

/** 终态：恢复协议不碰这三种任务（A.9 只处理 running / 保留 awaiting_approval、paused）。 */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["done", "failed", "cancelled"];
export const OPEN_TASK_STATES: readonly TaskState[] = [
  "queued",
  "running",
  "awaiting_approval",
  "paused",
];

export interface StepRow {
  id: string;
  task_id: string;
  seq: number;
  milestone_id: string | null;
  plan_version: number;
  worker_id: string | null;
  run_epoch: number;
  kind: StepKind;
  tool: string | null;
  subject_key: string;
  side_effect: SideEffect;
  tier: number | null;
  status: StepStatus;
  args_ref: string | null;
  result_ref: string | null;
  result_hash: string | null;
  error: string | null;
  session_key: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface TaskRow {
  id: string;
  parent_id: string | null;
  intent: string;
  restated: string | null;
  declared_json: string;
  state: TaskState;
  state_reason: string | null;
  blocked_on_json: string | null;
  milestone_id: string | null;
  plan_version: number;
  profile: string;
  budget_tokens: number | null;
  spent_tokens: number;
  source: string;
  source_ref: string | null;
  run_epoch: number;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  task_id: string | null;
  step_id: string | null;
  kind: ApprovalKind;
  tier: number;
  title: string;
  detail_json: string;
  subject_key: string;
  status: ApprovalStatus;
  decided_by: DecidedBy | null;
  decision_note: string | null;
  pending_until: string;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
}

export interface LockRow {
  resource: string;
  task_id: string;
  worker_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export interface EventRow {
  seq: number;
  ts: string;
  task_id: string | null;
  type: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
}

/** beginStep 的入参。除必填项外都可省略，省略时从 tasks 行里取默认值。 */
export interface StepInput {
  id?: string;
  task_id: string;
  seq?: number;
  milestone_id?: string | null;
  plan_version?: number;
  worker_id?: string | null;
  /**
   * **必填**。必须等于任务当前 run_epoch：小的抛 StaleWriterError（A.9 fencing），
   * 大的抛 invalid_epoch。故意不给默认值——省略就通过等于 fencing 不存在。
   */
  run_epoch: number;
  kind: StepKind;
  tool?: string | null;
  subject_key: string;
  side_effect: SideEffect;
  tier?: number | null;
  args_ref?: string | null;
  session_key?: string | null;
}

/** endStep 的入参。 */
export interface StepResult {
  status?: Exclude<StepStatus, "pending" | "started">;
  result_ref?: string | null;
  result_hash?: string | null;
  error?: string | null;
  ended_at?: string;
}

export interface AppendEventInput {
  task_id?: string | null;
  type: string;
  /** 传对象则规范化成 JSON；传字符串则原样落库（调用方自己保证是 JSON）。 */
  payload?: unknown;
  payload_json?: string;
  ts?: string;
}

export interface ChainStatus {
  ok: boolean;
  /** 断链的最新位置（events.seq）；没断为 null。 */
  brokenAt: number | null;
  reason: "hash_mismatch" | "prev_hash_mismatch" | null;
  count: number;
  lastHash: string;
}

export interface TaskViewStep {
  seq: number;
  id: string;
  kind: StepKind;
  tool: string | null;
  status: StepStatus;
  sideEffect: SideEffect;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface TaskView {
  taskId: string;
  intent: string;
  state: TaskState;
  /** 外显六态（B.8 那张映射表）：待启动/执行中/等待输入/阻塞/完成/终止。 */
  stateLabel: string;
  stateReason: string | null;
  planVersion: number;
  profile: string;
  /** 问「到哪一步」 */
  where: {
    milestoneId: string | null;
    milestoneSeq: number | null;
    milestoneCount: number;
    milestoneTitle: string | null;
    doneWhen: string | null;
    currentStepSeq: number | null;
    currentStepTool: string | null;
    totalSteps: number;
    doneSteps: number;
  };
  /** 问「做过什么」 */
  done: TaskViewStep[];
  /** 问「为什么」 */
  why: {
    restated: string | null;
    planWhy: string | null;
    planVersion: number | null;
    milestoneTitle: string | null;
  };
  /** 问「卡在谁」 */
  blockedBy: {
    type: "none" | "human" | "approval" | "lock" | "unknown";
    detail: string;
    waitingFor: "nobody" | "human" | "dsbot" | "worker";
    approvalId: string | null;
    stepId: string | null;
  };
  awaiting: Array<{
    approvalId: string;
    kind: ApprovalKind;
    tier: number;
    title: string;
    /** 卡片模板从这串 JSON 渲染（A.6：聊天窗文字必须与它逐字一致）。 */
    detailJson: string;
    createdAt: string;
    pendingUntil: string;
  }>;
  locks: Array<{ resource: string; workerId: string; expiresAt: string }>;
  budget: { tokens: number | null; spent: number; ratio: number | null };
  spend: Array<{ model: string | null; inputTokens: number; outputTokens: number }>;
  stepCounts: Record<StepStatus, number>;
  startedAt: string;
  updatedAt: string;
}
