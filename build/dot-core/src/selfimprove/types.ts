/**
 * src/selfimprove/types.ts —— 自我优化这层的形状。
 *
 * 单独一份是为了让「提案」（index.ts）和「应用」（apply.ts）不互相 import：
 * 提案层只经账本，应用层只写 pending 补丁，两边共享的只有这里。
 */

import type { LedgerDb } from "../ledger/db.ts";

export type ProposalKind = "config" | "prompt" | "code";

/** 一条改动建议。`id` 由本机生成，不采信模型给的（防撞号/防编造编号）。 */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** 改哪里：配置键路径、提示词文件名、或 build/dot-core/src/ 下的相对路径。 */
  target: string;
  why: string;
  evidence: string;
  proposedChange: string;
  risk: string;
  expectedGain: string;
}

/** 交给模型的失败样本。只放账本里已有的原文，不加工、不补全。 */
export interface ProposalSample {
  taskId?: string | null;
  reason: string;
  detail?: string | null;
}

/** 模型调用：给一段提示词，回模型正文（与 src/say 同一形状）。 */
export type ProposalComplete = (prompt: string) => Promise<string>;

export interface ProposeOptions {
  db: LedgerDb;
  /** collectMetrics 的结果；原样进提示词，不在这一层重算。 */
  metrics: unknown;
  samples: Array<ProposalSample | string>;
  /** 没注入（例如没配 key）就不跑，返回空数组并记原因。 */
  complete?: ProposalComplete;
  /**
   * dot 配置。**不给 = 当关着**（fail-closed）：propose 一律不跑。
   * 开关与每日上限都从这里取（self_improve.enabled / max_proposals_per_day）。
   */
  config?: SelfImproveConfigSlice;
  /** 覆盖「现在」（每日上限按 UTC 日期算），只给测试用。 */
  now?: Date;
}

export interface SelfImproveConfigSlice {
  self_improve: { enabled: boolean; max_proposals_per_day: number };
}

export interface ProposeOutcome {
  proposals: Proposal[];
  /** 没跑或没跑成的原因；成功时是 null。 */
  reason: string | null;
  /** 是否因为开关/上限/缺模型而压根没问模型。 */
  skipped: boolean;
}

export interface CheckOutcome {
  ok: boolean;
  detail: string;
}

export interface ApplyOptions {
  db: LedgerDb;
  config?: SelfImproveConfigSlice;
  proposal: Proposal;
  /** 补丁原文（unified diff 或等价的文本改动）。 */
  patch: string;
  /** 项目根（默认 process.cwd()）。补丁只能落在它下面的白名单路径里。 */
  root?: string;
  /** 注入检查器（默认跑全量测试 + 类型检查）。测试用它伪造红/绿。 */
  runChecks?: (ctx: { root: string; patchPath: string; target: string }) => CheckOutcome;
}

export interface ApplyResult {
  /** true = 补丁已写到 pending 且检查全绿；源码一个字节都没动。 */
  ok: boolean;
  reason: string;
  /** 命中黑名单时的规则 id（gate / builtin / ledger / keeper / schema_field / …）。 */
  rule: string | null;
  patchPath: string | null;
  /** 检查结论（成功时是 "tests+tsc ok" 这类摘要，失败时带尾巴）。 */
  checks: string | null;
}
