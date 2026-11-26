/**
 * src/plan/types.ts —— 分层计划模块的入参类型与固定枚举。
 *
 * 这一层只描述「怎么把一份计划写进账本」，不描述「什么时候重排」：
 * 方案 5.3（dot-合并方案-v2-定稿.md:282）的四个触发——里程碑完成、同一里程碑
 * 连续失败 2 步、预算超八成、你改了主意——由派发器与闸门判定，它们只把 reason
 * 传进来（见 REPLAN_REASONS），写账的事全在本模块。
 *
 * 分层链「目标→里程碑→本轮计划→步骤」里，本模块负责前 3 层的写入：
 *   goal       —— plans.content_json.goal（planTask 写，replan 原样带着走）；
 *   milestones —— milestones 表，含 done_when；
 *   round_plan —— 本轮计划，存 plans.content_json.round_plan（setRoundPlan 写）。
 * 「本轮计划」拆成哪几步由派发器/跑腿工决定，本模块只落账与取回；步骤在 steps 表，
 * 归 hands/dispatch 写，不在这里。
 *
 * 账本里的落点（src/ledger/schema.ts）：
 *   milestones —— 每一步的目标与完成条件，state 取 pending/active/done/skipped；
 *   plans      —— 每次重排一行，version 递增，旧行不覆盖；
 *   decisions  —— 对齐记录（question 固定前缀「为什么这样做：」，decided_by='system'）；
 *   tasks      —— milestone_id 指向当前里程碑，plan_version 跟着最新 plans.version。
 */

/** 一条里程碑的最小输入。seq 由 planTask 从 1 开始自动编号，不由调用方给。 */
export interface MilestoneInput {
  /** 这一步要达成什么，一句话。 */
  title: string;
  /** 怎样算做完（可验收的条件，A.10 的 done_when）。 */
  done_when: string;
}

/** 首次拆计划：目标 + 有序里程碑 + 计划理由。 */
export interface PlanInput {
  taskId: string;
  /** 任务目标，写进 plans.content_json，重排时原样带过去。 */
  goal: string;
  /** 至少一条；顺序即 seq 顺序。 */
  milestones: MilestoneInput[];
  /** 为什么这么拆（写进 plans.why，锚点与进度卡会读）。 */
  why: string;
}

/**
 * 重排的四个触发，名字与方案 5.3（dot-合并方案-v2-定稿.md:282）一一对应：
 *   milestone_done          ← 里程碑完成
 *   milestone_failed_twice  ← 同一里程碑连续失败 2 步
 *   budget_over_80          ← 预算超八成
 *   user_changed_mind       ← 你改了主意
 * 名字不允许改：派发器与闸门按字符串判断，也便于事后按 reason 统计。
 */
export const REPLAN_REASONS = [
  "milestone_done",
  "milestone_failed_twice",
  "budget_over_80",
  "user_changed_mind",
] as const;

export type ReplanReason = (typeof REPLAN_REASONS)[number];

/** replan 的入参。milestones 省略表示只改理由、不换里程碑。 */
export interface ReplanInput {
  taskId: string;
  reason: ReplanReason | string;
  /** 这次为什么重排（写进新 plans.why）。 */
  why: string;
  /**
   * 可选：替换「还没做完」的里程碑。给了就按新清单重建，
   * 旧的 pending/active 里程碑标 skipped（不是 done），新清单第一条标 active。
   */
  milestones?: MilestoneInput[];
}

/**
 * 本轮计划（分层链第三层）的入参：这轮跑腿工要做的几步。
 *
 * 归谁：把当前里程碑拆成「这轮几步」是派发器/跑腿工的判断，本模块只负责把它
 * 落到当前计划行（plans.content_json.round_plan）并读回来，不判断该不该重排。
 */
export interface RoundPlanInput {
  taskId: string;
  /** 这轮要做的几步，按顺序；允许空数组（这轮光想不动手）。 */
  steps: string[];
  /** 可选备注，比如这轮为什么只做这几步。 */
  note?: string;
}

/** 读回的「本轮计划」。version 是它挂在哪个 plans 版本上。 */
export interface RoundPlan {
  version: number;
  /** 写这条时任务指向的里程碑；换段后是旧值，调用方自己比对。 */
  milestoneId: string | null;
  steps: string[];
  note: string | null;
  updatedAt: string;
}

/**
 * 对齐记录（A.12 裁判结论）。目前 decisions 表没有 aligned 列，
 * 是否对齐由调用方写进 note（见 recordAlignment 注释）；这里保留字段是为了
 * 让派发器/闸门的调用签名稳定，将来加列时不用改调用方。
 */
export interface AlignmentRecord {
  taskId: string;
  milestoneId: string;
  aligned: boolean;
  note: string;
}

/** advanceMilestone 的返回：finished 为 true 表示没有下一个里程碑了。 */
export interface AdvanceResult {
  finished: boolean;
  /** 推进后处于 active 的里程碑；finished 时为 null。 */
  milestone: null | {
    id: string;
    seq: number;
    title: string;
    done_when: string;
    state: string;
  };
}
