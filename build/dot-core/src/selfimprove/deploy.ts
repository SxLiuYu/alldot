/**
 * src/selfimprove/deploy.ts —— 部署替换：把 pending 补丁真正打进源码，并可以回退。
 *
 * 与 apply.ts 的分工：
 * - `apply.ts`：提案 → 写 `build/自我优化/pending/<id>.patch` → **在仓库副本上**跑全量测试。
 *   仓库一个字节都不动。
 * - 本文件：人点头之后，才把那个 pending 补丁打进真实源码。顺序是
 *   备份 → 打补丁 → 在真实仓库上跑全量测试 → 不通过就回滚，通过就写一张「请重启」请求。
 *
 * 为什么要把重启做成**写文件**而不是自己重启网关：
 * 部署动作是跑在网关进程里的，自己把自己杀掉，后面的「记录结果」就写不完了；
 * 而且重启期间会拒掉新任务。所以只写 `<dot>/state/reload-request.json`，
 * 由外面的看门狗（build/tools/keeper.ps1）在合适的时候重启。
 *
 * 红线照旧：黑名单（gate / hands / ledger / keeper / selfimprove 自身）在打补丁前**再查一遍**，
 * 不信任上游已经查过——部署是不可逆动作，宁可重复查。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LedgerDb } from "../ledger/db.ts";
import { appendEvent } from "../ledger/index.ts";
import {
  applyUnifiedDiff,
  checkPatchPaths,
  normalizeTarget,
  PENDING_DIR,
  readPendingPatch,
  runFullChecks,
  WHITELIST_PREFIX,
  blacklistHit,
} from "./apply.ts";
import type { CheckOutcome, SelfImproveConfigSlice } from "./types.ts";

/** 部署前的备份放这里（相对仓库根）。 */
export const BACKUP_DIR = "build/自我优化/backup";
/** 部署成功的补丁挪到这儿归档（相对仓库根），免得同一份被反复部署。 */
export const APPLIED_DIR = "build/自我优化/applied";

export interface DeployOptions {
  db: LedgerDb;
  /** 仓库根（绝对路径）。 */
  root: string;
  /** pending 里的补丁名（不带 .patch）。 */
  patchId: string;
  /** dot 配置；不给 = 当关着（fail-closed，与提案/应用同一套口径）。 */
  config?: SelfImproveConfigSlice;
  /** 重启请求写哪儿；不给就只记事件、不请求重启。 */
  reloadRequestPath?: string;
  /** 注入检查器（测试用）；默认在真实仓库上跑全量测试 + 类型检查。 */
  runChecks?: (root: string) => CheckOutcome;
  /** 覆盖「现在」，测试用。 */
  now?: Date;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface DeployResult {
  ok: boolean;
  /** 一句话原因（成功时是「打了几处、跑过了测试」）。 */
  reason: string;
  rule: string | null;
  patchId: string;
  /** 备份目录（绝对路径）；没到备份那一步时为 null。 */
  backupDir: string | null;
  /** 真正被改的文件（相对路径）。 */
  files: string[];
  /** 检查结论（没跑到为 null）。 */
  checks: CheckOutcome | null;
  /** 有没有写重启请求。 */
  reloadRequested: boolean;
}

/** 把一段 unified diff 拆成「一个文件一段」。没有 diff 头的宽松写法也能吃。 */
export function splitPatchByFile(patch: string): Array<{ path: string; text: string }> {
  const lines = patch.split(/\r?\n/);
  const out: Array<{ path: string; text: string[] }> = [];
  let current: { path: string; text: string[] } | null = null;
  for (const line of lines) {
    const git = /^diff --git\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (git !== null) {
      const raw = (git[2] ?? git[1] ?? "").replace(/^[ab]\//, "");
      current = { path: normalizeTarget(raw), text: [line] };
      out.push(current);
      continue;
    }
    const plus = /^\+\+\+\s+(.+)$/.exec(line);
    if (plus !== null) {
      const raw = (plus[1] ?? "").split(/\t/)[0] ?? "";
      const path = normalizeTarget(raw.replace(/^[ab]\//, ""));
      // 没有 diff --git 头的补丁：以 +++ 行开始新的一段
      if (current === null || current.path !== path) {
        current = { path, text: [] };
        out.push(current);
      }
      current.text.push(line);
      continue;
    }
    if (current !== null) current.text.push(line);
  }
  return out
    .filter((s) => s.path !== "" && s.path !== "/dev/null")
    .map((s) => ({ path: s.path, text: s.text.join("\n") }));
}

function stamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

function event(db: LedgerDb, type: string, payload: Record<string, unknown>): void {
  try {
    appendEvent(db, { type, payload });
  } catch {
    // 账本写不进去（比如库被锁）不能把部署结果吞掉：调用方拿得到 DeployResult。
  }
}

/**
 * 真正部署一个 pending 补丁。
 * 顺序不可交换：备份必须先于写盘；测试必须先于「算成功」。
 */
export function deployPendingPatch(opts: DeployOptions): DeployResult {
  const log = opts.logger ?? (() => {});
  const at = opts.now ?? new Date();
  const fail = (rule: string, reason: string, extra: Partial<DeployResult> = {}): DeployResult => ({
    ok: false,
    reason,
    rule,
    patchId: opts.patchId,
    backupDir: null,
    files: [],
    checks: null,
    reloadRequested: false,
    ...extra,
  });

  if (opts.config === undefined || opts.config.self_improve?.enabled !== true) {
    return fail("disabled", "自我优化开关关着（self_improve.enabled 不是 true）");
  }

  let patch: string;
  try {
    patch = readPendingPatch(opts.root, opts.patchId);
  } catch (err) {
    return fail("patch_missing", `读不到补丁 ${opts.patchId}：${(err as Error).message}`);
  }

  // 再查一遍：不信任上游。万一 pending 目录被谁塞了东西，这里挡住。
  const patchCheck = checkPatchPaths(patch);
  if (!patchCheck.ok) {
    event(opts.db, "self_deploy_rejected", { patch_id: opts.patchId, rule: patchCheck.rule, reason: patchCheck.reason });
    return fail(patchCheck.rule ?? "bad_patch", patchCheck.reason);
  }

  const sections = splitPatchByFile(patch);
  if (sections.length === 0) return fail("empty_patch", "补丁里没有可部署的文件段");

  for (const section of sections) {
    const hit = blacklistHit(section.path);
    if (hit !== null) {
      const reason = `补丁要改黑名单文件（${hit.id}：${hit.note}）：${section.path}`;
      event(opts.db, "self_deploy_rejected", { patch_id: opts.patchId, rule: hit.id, reason });
      return fail(hit.id, reason);
    }
    if (!section.path.toLowerCase().startsWith(WHITELIST_PREFIX.toLowerCase())) {
      const reason = `补丁里出现了白名单外的文件：${section.path}`;
      event(opts.db, "self_deploy_rejected", { patch_id: opts.patchId, rule: "not_whitelisted", reason });
      return fail("not_whitelisted", reason);
    }
    const abs = join(opts.root, ...section.path.split("/"));
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      const reason = `目标文件不存在或不是文件：${section.path}`;
      event(opts.db, "self_deploy_rejected", { patch_id: opts.patchId, rule: "target_missing", reason });
      return fail("target_missing", reason);
    }
  }

  const backupDir = join(opts.root, BACKUP_DIR, `${stamp(at)}-${opts.patchId}`);
  const originals = new Map<string, string>();
  const next = new Map<string, string>();

  // ── 1) 先算出新内容（打不上就整单放弃，一个字节都不写）──
  for (const section of sections) {
    const abs = join(opts.root, ...section.path.split("/"));
    const original = readFileSync(abs, "utf8");
    const patched = applyUnifiedDiff(original, section.text);
    if (patched === null) {
      const reason = `补丁打不上（上下文对不上）：${section.path}`;
      event(opts.db, "self_deploy_rejected", { patch_id: opts.patchId, rule: "patch_conflict", reason });
      return fail("patch_conflict", reason, { backupDir });
    }
    originals.set(section.path, original);
    next.set(section.path, patched);
  }

  // ── 2) 备份原文件（保留相对路径，方便人手动对比/回灌）──
  try {
    for (const [rel, content] of originals) {
      const dest = join(backupDir, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, "utf8");
    }
  } catch (err) {
    const reason = `备份失败，放弃部署：${(err as Error).message}`;
    event(opts.db, "self_deploy_rejected", { patch_id: opts.patchId, rule: "backup_failed", reason });
    return fail("backup_failed", reason);
  }

  // ── 3) 写盘 ──
  const files = [...next.keys()];
  try {
    for (const [rel, content] of next) {
      writeFileSync(join(opts.root, ...rel.split("/")), content, "utf8");
    }
  } catch (err) {
    const reason = `写盘失败，已回滚：${(err as Error).message}`;
    restore(originals, opts.root);
    event(opts.db, "self_deploy_rollback", { patch_id: opts.patchId, rule: "write_failed", reason, files });
    return fail("write_failed", reason, { backupDir, files });
  }

  // ── 4) 在真实仓库上跑全量测试（不过就回滚）──
  let checks: CheckOutcome;
  try {
    const runner = opts.runChecks ?? ((root: string) => runFullChecks(root));
    checks = runner(opts.root);
  } catch (err) {
    checks = { ok: false, detail: `检查器抛了：${(err as Error).message}` };
  }
  if (!checks.ok) {
    restore(originals, opts.root);
    const reason = `部署后测试没过，已回滚源码：${checks.detail}`;
    event(opts.db, "self_deploy_rollback", { patch_id: opts.patchId, rule: "checks_failed", reason, files, backup_dir: backupDir });
    log("warn", reason);
    return fail("checks_failed", reason, { backupDir, files, checks });
  }

  // ── 5) 成功：归档补丁 + 记事件 + 请求重启 ──
  try {
    const appliedDir = join(opts.root, APPLIED_DIR);
    mkdirSync(appliedDir, { recursive: true });
    renameSync(
      join(opts.root, PENDING_DIR, `${opts.patchId}.patch`),
      join(appliedDir, `${opts.patchId}.patch`),
    );
  } catch {
    // 归档失败不影响「已经部署成功」这个事实
  }

  let reloadRequested = false;
  if (opts.reloadRequestPath !== undefined) {
    try {
      mkdirSync(dirname(opts.reloadRequestPath), { recursive: true });
      writeFileSync(
        opts.reloadRequestPath,
        JSON.stringify(
          {
            requestedAt: at.toISOString(),
            patchId: opts.patchId,
            files,
            note: "部署后需要重启网关才生效；由 build/tools/keeper.ps1 在空闲时执行",
          },
          null,
          2,
        ),
        "utf8",
      );
      reloadRequested = true;
    } catch (err) {
      log("warn", `重启请求没写成：${(err as Error).message}`);
    }
  }

  const reason = `部署成功：改了 ${files.length} 个文件，全量测试与类型检查都过了${reloadRequested ? "；已请求重启网关" : ""}`;
  event(opts.db, "self_deploy_ok", { patch_id: opts.patchId, files, backup_dir: backupDir, reload_requested: reloadRequested });
  log("info", reason);
  return { ok: true, reason, rule: null, patchId: opts.patchId, backupDir, files, checks, reloadRequested };
}

/** 把备份原样写回去。回滚失败就把错误抛给调用方——那属于人必须知道的事故。 */
function restore(originals: Map<string, string>, root: string): void {
  for (const [rel, content] of originals) {
    writeFileSync(join(root, ...rel.split("/")), content, "utf8");
  }
}

/** 有没有待部署的补丁（给界面用）：只列文件名，不读正文。 */
export function hasPendingPatch(root: string, patchId: string): boolean {
  return existsSync(join(root, PENDING_DIR, `${patchId}.patch`));
}
