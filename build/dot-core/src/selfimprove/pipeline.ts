/**
 * src/selfimprove/pipeline.ts —— 「提案 → 补丁」和「补丁 → 上机」两段流水线。
 *
 * 2026-11-25 复核发现的缺口：提案能出请示卡，但点「同意」只会把审批状态改掉，
 * `applyProposal` 全仓没有生产调用点——也就是说自我优化到「建议」就断了，落不了地。
 * 这个文件把断的地方接上，分两段，**每段都要人点一次**：
 *
 *   第一段 generatePatchForProposal（人点了「同意」这条建议之后跑）
 *     读目标文件 → 让模型写 unified diff → applyProposal 四道闸 + 副本上打补丁 + 跑全量测试/tsc
 *     → 全绿才把补丁留在 pending，并再出一张卡「要不要真的打上机」。
 *   第二段 deployReadyPatch（人点了第二张卡之后跑）
 *     备份 → 打补丁 → 跑测试 → 不过就回滚 → 过了归档 + 写 reload-request 让看门狗重启。
 *
 * 两段都不碰源码以外的东西；第一段结束时源码一个字节没动。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appendEvent, createApproval, putArtifact, type LedgerDb } from "../ledger/index.ts";
import { applyProposal, checkTarget, PENDING_DIR } from "./apply.ts";
import { deployPendingPatch } from "./deploy.ts";
import { buildPatchPrompt, extractPatch } from "./patchgen.ts";
import type { CheckOutcome, Proposal, ProposalComplete, SelfImproveConfigSlice } from "./types.ts";

export interface PipelineOptions {
  db: LedgerDb;
  /** 仓库根（绝对路径）。checkTarget 的白名单与 pending 目录都相对它。 */
  root: string;
  config?: SelfImproveConfigSlice;
  /** 没注入就不跑（例如没配模型 key）。 */
  complete?: ProposalComplete;
  /** 注入检查器（测试用）；不给就由 applyProposal 自己跑全量测试 + tsc。 */
  runChecks?: (ctx: { root: string; patchPath: string; target: string }) => CheckOutcome;
  /** reload-request 写哪儿（第二段用）；不给就只记事件。 */
  reloadRequestPath?: string;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface GenerateResult {
  ok: boolean;
  reason: string;
  /** pending 里的补丁路径（ok=false 时为 null）。 */
  patchPath: string | null;
  /** 发出的第二张「要不要上机」请示卡。 */
  approvalId: string | null;
}

function readTarget(root: string, target: string): string | null {
  try {
    return readFileSync(join(root, target), "utf8");
  } catch {
    return null;
  }
}

/**
 * 第一段：把一条提案变成 pending 补丁。ok=true 只代表「补丁留下来了、检查全绿」，
 * 源码仍然没动——真正上机是第二张卡的事。
 */
export async function generatePatchForProposal(
  opts: PipelineOptions,
  proposal: Proposal,
): Promise<GenerateResult> {
  const log = opts.logger ?? (() => {});
  const skip = (reason: string): GenerateResult => {
    appendEvent(opts.db, {
      type: "self_patch_skipped",
      payload: { proposal_id: proposal.id, target: proposal.target, reason },
    });
    return { ok: false, reason, patchPath: null, approvalId: null };
  };

  const checked = checkTarget(proposal.target, opts.root);
  if (!checked.ok) return skip(`${checked.rule ?? "invalid_target"}：${checked.reason}`);

  const fileText = readTarget(opts.root, checked.target);
  if (fileText === null) return skip(`目标文件读不到：${checked.target}`);

  if (opts.complete === undefined) return skip("没有可用的模型（complete 没注入）");

  let raw: string;
  try {
    raw = await opts.complete(buildPatchPrompt({ target: checked.target, fileText, proposal }));
  } catch (err) {
    return skip(`模型调用失败：${(err as Error).message}`);
  }
  const patch = extractPatch(raw);
  if (patch === null) return skip("模型没给出可用的 diff");

  const applied = applyProposal({
    db: opts.db,
    config: opts.config,
    proposal,
    patch,
    root: opts.root,
    runChecks: opts.runChecks,
  });
  if (!applied.ok) {
    log("warn", `提案 ${proposal.id} 的补丁没过：${applied.reason}`);
    return { ok: false, reason: applied.reason, patchPath: null, approvalId: null };
  }

  // 补丁与 diff 一起进 artifacts：卡里给人看 diff，账本里留全量。
  const diffArtifact = putArtifact(
    opts.db,
    JSON.stringify({ target: checked.target, checks: applied.checks, patch }, null, 2),
  ).hash;
  const { approval } = createApproval(opts.db, {
    task_id: null,
    kind: "question",
    tier: 3,
    title: `自我优化补丁：${checked.target}`.slice(0, 80),
    detail: {
      patch_id: proposal.id,
      proposal_id: proposal.id,
      target: checked.target,
      checks: applied.checks,
      artifact: diffArtifact,
      diff: patch.length > 6000 ? `${patch.slice(0, 6000)}\n…（已截断，全量见 artifacts）` : patch,
      ask: "打上机吗？打之前会先备份，跑完测试不过会自动回滚。",
    },
    subject_key: `self_patch:${proposal.id}`,
  });

  appendEvent(opts.db, {
    type: "self_patch_ready",
    payload: {
      proposal_id: proposal.id,
      target: checked.target,
      patch_path: applied.patchPath,
      checks: applied.checks,
      approval_id: approval.id,
    },
  });
  log("info", `提案 ${proposal.id} 的补丁已就绪并通过检查：${applied.patchPath}`);
  return { ok: true, reason: applied.reason, patchPath: applied.patchPath, approvalId: approval.id };
}

export interface DeployReadyResult {
  ok: boolean;
  reason: string;
  backupDir: string | null;
  reloadRequested: boolean;
}

/** 第二段：人点了「打上机」之后才走。备份 → 打补丁 → 跑测试 → 不过回滚。 */
export function deployReadyPatch(opts: PipelineOptions, patchId: string): DeployReadyResult {
  const result = deployPendingPatch({
    db: opts.db,
    root: opts.root,
    patchId,
    config: opts.config,
    reloadRequestPath: opts.reloadRequestPath,
    runChecks: opts.runChecks === undefined ? undefined : (root: string) => opts.runChecks!({ root, patchPath: "", target: "" }),
    logger: opts.logger,
  });
  return {
    ok: result.ok,
    reason: result.reason,
    backupDir: result.backupDir,
    reloadRequested: result.reloadRequested,
  };
}

/** 给排障用的：pending 目录里现在有哪些补丁。 */
export function pendingDirOf(root: string): string {
  return join(root, PENDING_DIR);
}
