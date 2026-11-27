/**
 * src/selfimprove/index.ts —— 从指标与失败样本产改动提案。
 *
 * 这一层只做三件事：
 * 1. 按开关与每日上限决定跑不跑（关着 / 没模型 / 超上限 → 空数组 + 原因进事件）；
 * 2. 把指标和最近几条失败样本原样交给模型，要求回严格 JSON；
 * 3. 把每条通过校验的提案**只落账本**（events 类型 self_proposal，正文进 artifacts），
 *    并建一张 kind=question 的请示卡。
 *
 * 硬边界（有测试守着）：
 * - 不写任何文件、不改任何配置、不碰源码；
 * - 模型报错 / 回的不是 JSON / 字段不合格 → 该条丢掉；全丢就是空数组，绝不编一条凑数；
 * - 每日上限按 UTC 日期算，超过就不问模型（省一次调用）。
 */

import { join } from "node:path";

import type { LedgerDb } from "../ledger/db.ts";
import { appendEvent, createApproval, putArtifact, randomId } from "../ledger/index.ts";
import type {
  Proposal,
  ProposalComplete,
  ProposalKind,
  ProposalSample,
  ProposeOptions,
  ProposeOutcome,
  SelfImproveConfigSlice,
} from "./types.ts";
import { PENDING_DIR } from "./apply.ts";

export type {
  ApplyOptions,
  ApplyResult,
  CheckOutcome,
  Proposal,
  ProposalComplete,
  ProposalKind,
  ProposalSample,
  ProposeOptions,
  ProposeOutcome,
  SelfImproveConfigSlice,
} from "./types.ts";

export const PROPOSAL_KINDS: readonly ProposalKind[] = ["config", "prompt", "code"];

const MAX_SAMPLES = 6;
const MAX_SAMPLE_CHARS = 300;
const FIELD_LIMIT = 4000;
const TARGET_LIMIT = 300;

/** code 类提案的 target 必须像路径：build/dot-core/src/ 下某个文件。 */
const CODE_TARGET_RE = /^build\/dot-core\/src\/[A-Za-z0-9_.\-/]+\.(?:ts|tsx|json|md)$/;

/** 事件类型（审计与每日上限都数它，改名要两边一起改）。 */
export const EVENT_PROPOSAL = "self_proposal";
export const EVENT_PROPOSAL_SKIPPED = "self_proposal_skipped";
export const EVENT_PROPOSAL_CAPPED = "self_proposal_capped";

/** 今天是哪个 UTC 日期（每日上限的桶）。 */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** 今天已经落了几条提案（只数账本，不读别的）。 */
export function proposalsToday(db: LedgerDb, at: Date = new Date()): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = ? AND substr(ts, 1, 10) = ?")
    .get(EVENT_PROPOSAL, utcDay(at)) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function sampleText(sample: ProposalSample | string): string {
  if (typeof sample === "string") return clip(sample);
  const head = clip(sample.reason);
  const detail = typeof sample.detail === "string" ? clip(sample.detail) : "";
  const task = typeof sample.taskId === "string" && sample.taskId !== "" ? `[${sample.taskId}] ` : "";
  return `${task}${head}${detail === "" ? "" : `\n${detail}`}`;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_SAMPLE_CHARS ? `${t.slice(0, MAX_SAMPLE_CHARS)}…` : t;
}

/**
 * 提示词。导出给测试核对三条底线写进去了：只依据证据、不许改红线、证据不足返回空。
 */
export function buildProposePrompt(
  metrics: unknown,
  samples: Array<ProposalSample | string>,
  max: number,
): string {
  const sampleLines = samples
    .slice(0, MAX_SAMPLES)
    .map(sampleText)
    .filter((t) => t !== "")
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
  return [
    "你是 dot 的自我优化提案器。只依据下面这份账本指标和失败样本，提出小、具体、可复核的改动建议。",
    "",
    "规矩：",
    "1) 不许编事实。指标里没有的数字不要写，样本里没有的原因不要推断；证据不足就返回空列表。",
    "2) 不许提议改这些红线：审批与闸门（src/gate、approvals）、人手专属应用（human_only_apps）、",
    "   exec 白名单（whitelist）、自我优化自己的开关与上限（self_improve）、账本写入口（src/ledger）、",
    "   keeper 脚本（build/tools/keeper*.ps1）。",
    "3) code 类的 target 必须是 build/dot-core/src/ 下的相对路径；config 类写配置键路径（如 keepalive.disk.warn_gb）；",
    "   prompt 类写提示词所在文件或环节名。",
    "4) 每条都要能说清：为什么改、证据是哪条指标/样本、改什么、风险、预期收益。",
    `5) 最多 ${max} 条；没有值得改的就返回空列表。`,
    "",
    "只输出严格 JSON，不要解释、不要代码围栏：",
    '{"proposals":[{"kind":"config|prompt|code","target":"...","why":"...","evidence":"...",' +
      '"proposedChange":"...","risk":"...","expectedGain":"..."}]}',
    "",
    "账本指标（topFailureReasons.count 是受影响的任务数，不是失败次数）：",
    // 紧凑 JSON：给模型的输入越小，越不容易被 max_tokens 截成空正文。
    JSON.stringify(metrics),
    "",
    "失败样本（原文，未加工）：",
    sampleLines === "" ? "（没有样本）" : sampleLines,
  ].join("\n");
}

/** 去掉模型偶尔包上的 ``` 围栏。 */
function stripFence(raw: string): string {
  const text = raw.trim();
  const fenced = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n```$/.exec(text);
  return fenced !== null ? (fenced[1] ?? "").trim() : text;
}

/** 从模型正文里抠出 JSON。抠不出来返回 null（调用方当成「没有提案」，不猜）。 */
export function parseProposalJson(raw: string): unknown {
  const text = stripFence(raw);
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 常见：前面加了一句「好的，以下是提案」。取第一个 { 到最后一个 }，或 [ 到 ]。
    const objStart = text.indexOf("{");
    const objEnd = text.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      try {
        return JSON.parse(text.slice(objStart, objEnd + 1)) as unknown;
      } catch {
        // 往下试数组
      }
    }
    const arrStart = text.indexOf("[");
    const arrEnd = text.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        return JSON.parse(text.slice(arrStart, arrEnd + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asText(value: unknown, limit = FIELD_LIMIT): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

/**
 * 校验并归一一条候选提案。任何必填项缺失（kind/target/why/proposedChange）
 * 就返回 null —— 宁缺勿编。`id` 一律本机生成。
 */
export function normalizeProposal(candidate: unknown): Proposal | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const src = candidate as Record<string, unknown>;
  const kind = asText(src["kind"], 20) as ProposalKind;
  if (!PROPOSAL_KINDS.includes(kind)) return null;
  const target = asText(src["target"], TARGET_LIMIT);
  const why = asText(src["why"]);
  const proposedChange = asText(src["proposedChange"]);
  if (target === "" || why === "" || proposedChange === "") return null;
  // code 类的 target 必须是真路径（2026-11-25 真机：模型写成「desktop 步骤提示词：USER_CONTROL 处理环节」
  // 这种描述，卡出来点「同意」以后补丁流水线无从下手，等于白点一次）。
  if (kind === "code" && !CODE_TARGET_RE.test(target.replace(/\\/g, "/"))) return null;
  return {
    id: randomId("prop"),
    kind,
    target,
    why,
    evidence: asText(src["evidence"]),
    proposedChange,
    risk: asText(src["risk"]),
    expectedGain: asText(src["expectedGain"]),
  };
}

/** 从解析后的 JSON 取候选数组；`{proposals:[...]}` 与裸数组都收。 */
function candidateList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    const list = (parsed as Record<string, unknown>)["proposals"];
    if (Array.isArray(list)) return list;
  }
  return [];
}

function skip(db: LedgerDb, reason: string, extra: Record<string, unknown> = {}): ProposeOutcome {
  appendEvent(db, {
    type: EVENT_PROPOSAL_SKIPPED,
    payload: { reason, ...extra },
  });
  return { proposals: [], reason, skipped: true };
}

/**
 * 提案主流程。**只落账本**：artifacts 存正文，events 记一条 self_proposal，
 * approvals 建一张 kind=question 的请示卡。返回落账的提案数组。
 *
 * 开关关着 / 没注入模型 / 今日已满 → 返回空数组，原因写进 self_proposal_skipped 事件。
 * 模型抛错或回的 JSON 不合格 → 也是空数组（模型抛错另记一条同样带原因的 skipped）。
 */
export async function proposeImprovements(opts: ProposeOptions): Promise<Proposal[]> {
  const outcome = await proposeImprovementsWithReason(opts);
  return outcome.proposals;
}

/** 与 proposeImprovements 同一流程，额外把「为什么没提案」返回给调用方（演练脚本用）。 */
export async function proposeImprovementsWithReason(opts: ProposeOptions): Promise<ProposeOutcome> {
  const { db } = opts;
  const config: SelfImproveConfigSlice | undefined = opts.config;
  if (config === undefined || config.self_improve?.enabled !== true) {
    // fail-closed：没给配置也当关着，不默认开。
    return skip(db, "自我优化开关关着（self_improve.enabled 不是 true）");
  }
  const max = Math.max(0, Math.floor(config.self_improve.max_proposals_per_day));
  if (max === 0) return skip(db, "self_improve.max_proposals_per_day = 0，今天不提案");

  const at = opts.now ?? new Date();
  const used = proposalsToday(db, at);
  const remaining = max - used;
  if (remaining <= 0) {
    return skip(db, `今日提案已达上限（已落 ${used} 条，上限 ${max} 条）`, { used, max });
  }

  const complete: ProposalComplete | undefined = opts.complete;
  if (complete === undefined) {
    return skip(db, "没有注入模型调用（可能没配 key），不提案");
  }

  const samples = Array.isArray(opts.samples) ? opts.samples : [];
  let raw: unknown;
  try {
    raw = await complete(buildProposePrompt(opts.metrics, samples, remaining));
  } catch (err) {
    return skip(db, `模型调用失败：${(err as Error).message}`, { stage: "complete" });
  }
  if (typeof raw !== "string") return skip(db, "模型没回文本（不是字符串），不提案", { stage: "complete" });
  if (raw.trim() === "") return skip(db, "模型回了空文本，不提案", { stage: "complete" });

  const parsed = parseProposalJson(raw);
  if (parsed === null) return skip(db, "模型回的不是可解析的 JSON，不提案", { stage: "parse" });

  const candidates = candidateList(parsed);
  const normalized: Proposal[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const candidate of candidates) {
    const proposal = normalizeProposal(candidate);
    if (proposal === null) {
      dropped += 1;
      continue;
    }
    const dedupeKey = `${proposal.kind}|${proposal.target}|${proposal.proposedChange}`;
    if (seen.has(dedupeKey)) {
      dropped += 1;
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(proposal);
  }
  if (normalized.length === 0) {
    return skip(db, `模型回了 ${candidates.length} 条候选，没有一条通过校验`, {
      stage: "validate",
      candidates: candidates.length,
      dropped,
    });
  }

  const accepted = normalized.slice(0, remaining);
  const capped = Math.max(0, normalized.length - accepted.length);
  if (capped > 0) {
    appendEvent(db, {
      type: EVENT_PROPOSAL_CAPPED,
      ts: at.toISOString(),
      payload: { requested: normalized.length, accepted: accepted.length, max, dropped },
    });
  }

  for (const proposal of accepted) persistProposal(db, proposal, at);
  return { proposals: accepted, reason: null, skipped: false };
}

/** 一条提案落账：正文进 artifacts，索引与摘要进 events，请示卡 kind=question。 */
function persistProposal(db: LedgerDb, proposal: Proposal, at: Date): void {
  const artifact = putArtifact(db, JSON.stringify(proposal, null, 2));
  appendEvent(db, {
    type: EVENT_PROPOSAL,
    // 2026-11-26：ts 必须用调用方传进来的 now，否则 proposalsToday(db, at) 按 UTC 日
    // 数事件时数到的是真实日期，跨 UTC 日边界会算错每日上限（测试用固定日期暴露了它）。
    ts: at.toISOString(),
    payload: {
      proposal_id: proposal.id,
      kind: proposal.kind,
      target: proposal.target,
      why: proposal.why.slice(0, 500),
      artifact: artifact.hash,
    },
  });
  createApproval(db, {
    task_id: null,
    kind: "question",
    tier: 3,
    title: `自我优化提案：${proposal.target}`.slice(0, 80),
    detail: {
      proposal_id: proposal.id,
      kind: proposal.kind,
      target: proposal.target,
      why: proposal.why,
      evidence: proposal.evidence,
      proposedChange: proposal.proposedChange,
      risk: proposal.risk,
      expectedGain: proposal.expectedGain,
      artifact: artifact.hash,
    },
    subject_key: `self_proposal:${proposal.id}`,
  });
}

/** 给演练脚本用：pending 目录的约定位置（本模块不创建它）。 */
export function pendingPatchPath(root: string, proposalId: string): string {
  return join(root, PENDING_DIR, `${proposalId}.patch`);
}

export {
  deployPendingPatch,
  hasPendingPatch,
  splitPatchByFile,
  APPLIED_DIR,
  BACKUP_DIR,
  type DeployOptions,
  type DeployResult,
} from "./deploy.ts";
export {
  applyProposal,
  applyUnifiedDiff,
  blacklistHit,
  blacklistMention,
  CHECK_TREE_DIRS,
  checkPatchPaths,
  checkTarget,
  ensurePendingDir,
  GUARDED_CONFIG_FIELDS,
  GUARDED_CONFIG_FILES,
  guardedConfigFieldsTouched,
  HARD_BLACKLIST,
  listPendingPatches,
  MAX_PATCH_BYTES,
  normalizeTarget,
  patchFilePaths,
  PENDING_DIR,
  readPendingPatch,
  runChecksWithPatch,
  runFullChecks,
  WHITELIST_PREFIX,
} from "./apply.ts";
