/**
 * src/maintenance/index.ts —— 回收快照。配置里早就有 `keepalive.snapshots_max_gb`（默认 5 GB），
 * 但一直没有执行者：2026-11-25 真机上快照目录长到 12 GB，把 C 盘吃到只剩 10 MB，
 * 之后所有写动作全部 ENOSPC。这里补上执行者。
 *
 * 口径（宁少删不多删）：
 *   · 只删 `snapshots/<task_id>/<时间戳>/` 这一层，不动别的目录；
 *   · 正在跑的任务（running / queued）的快照一律保留——回退要用；
 *   · 从最旧的开始删，删到总量回到上限以下就停；
 *   · 只删文件，账本 snapshots 表的历史行保留（取回时会如实说「已被回收」）；
 *   · 上限不再是死的配置值：盘快满时（< 1.5 GB）按「腾到 2.5 GB」倒推（见
 *     `effectiveLimitBytes`），否则会出现「盘要满了、回收器还在等 5 GB 上限」；
 *   · 插件的定时器用**异步版** `sweepSnapshotsAsync`：快照目录真机上到过 18 万个文件，
 *     同步遍历一次把事件循环按住 15～29 秒，网关上的手机轮询跟着卡死。
 */

import { existsSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SweepOptions {
  /** snapshots 根目录（`~/.allbot/dot/snapshots`）。 */
  root: string;
  /** 总量上限，字节。 */
  limitBytes: number;
  /** 这些任务号的快照不删（一般传当前 running / queued 的任务）。 */
  keepTaskIds?: readonly string[];
  /** 只删「最后修改早于这么多毫秒」的（默认 1 小时），防止刚拍的就被清掉。 */
  minAgeMs?: number;
  now?: () => number;
}

/** 一个任务目录的盘点结果。 */
interface Entry {
  path: string;
  task: string;
  bytes: number;
  mtime: number;
}

export interface SweepResult {
  scanned: number;
  removed: string[];
  freedBytes: number;
  keptBytes: number;
  limitBytes: number;
}

const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

function treeSize(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let st;
    try {
      st = statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let kids: string[] = [];
      try {
        kids = readdirSync(cur);
      } catch {
        kids = [];
      }
      for (const k of kids) stack.push(join(cur, k));
    } else {
      total += st.size;
    }
  }
  return total;
}

async function treeSizeAsync(dir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let st;
    try {
      st = await stat(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let kids: string[] = [];
      try {
        kids = await readdir(cur);
      } catch {
        kids = [];
      }
      for (const k of kids) stack.push(join(cur, k));
    } else {
      total += st.size;
    }
  }
  return total;
}

/**
 * 按总量上限回收快照。返回删了什么、腾了多少。
 * 目录不存在时当作空目录（第一次运行时就是这样）。
 * 同步版：只给「人点一下」的修法（bridge/fix.ts）和测试用，别放进定时器。
 */
export function sweepSnapshots(opts: SweepOptions): SweepResult {
  const now = opts.now ?? (() => Date.now());
  const minAge = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const keep = new Set(opts.keepTaskIds ?? []);
  const result: SweepResult = {
    scanned: 0,
    removed: [],
    freedBytes: 0,
    keptBytes: 0,
    limitBytes: opts.limitBytes,
  };

  if (!existsSync(opts.root)) return result;

  let tasks: string[] = [];
  try {
    tasks = readdirSync(opts.root);
  } catch {
    return result;
  }

  const entries: Entry[] = [];
  for (const task of tasks) {
    const dir = join(opts.root, task);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const bytes = treeSize(dir);
    result.scanned += 1;
    result.keptBytes += bytes;
    entries.push({ path: dir, task, bytes, mtime: st.mtimeMs });
  }

  if (result.keptBytes <= opts.limitBytes) return result;

  // 旧的先删；正在跑的任务和新拍的跳过。
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries) {
    if (result.keptBytes <= opts.limitBytes) break;
    if (keep.has(e.task)) continue;
    if (now() - e.mtime < minAge) continue;
    try {
      rmSync(e.path, { recursive: true, force: true });
      result.removed.push(e.path);
      result.freedBytes += e.bytes;
      result.keptBytes -= e.bytes;
    } catch {
      // 删不掉（被占用）就跳过，下一轮再试；不让回收把主流程带崩。
    }
  }
  return result;
}

export interface SweepAutoOptions {
  root: string;
  /** 配置里的上限（字节）。盘紧时会自动压低。 */
  configuredBytes: number;
  keepTaskIds?: readonly string[];
  minAgeMs?: number;
  now?: () => number;
  /** 覆盖余量探测（测试用）。 */
  freeBytes?: number | null;
}

/**
 * 异步版：定时器用。自己按磁盘余量定预算（`effectiveLimitBytes`），
 * 不需要外面先同步量一遍总量。
 */
export async function sweepSnapshotsAsync(opts: SweepAutoOptions): Promise<SweepResult> {
  const now = opts.now ?? (() => Date.now());
  const minAge = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const keep = new Set(opts.keepTaskIds ?? []);
  const result: SweepResult = {
    scanned: 0,
    removed: [],
    freedBytes: 0,
    keptBytes: 0,
    limitBytes: opts.configuredBytes,
  };

  let tasks: string[] = [];
  try {
    tasks = await readdir(opts.root);
  } catch {
    return result;
  }

  const entries: Entry[] = [];
  for (const task of tasks) {
    const dir = join(opts.root, task);
    let st;
    try {
      st = await stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const bytes = await treeSizeAsync(dir);
    result.scanned += 1;
    result.keptBytes += bytes;
    entries.push({ path: dir, task, bytes, mtime: st.mtimeMs });
  }

  const freeBytes = opts.freeBytes !== undefined ? opts.freeBytes : freeBytesAt(opts.root);
  const limit = effectiveLimitBytes({
    configuredBytes: opts.configuredBytes,
    freeBytes,
    snapshotBytes: result.keptBytes,
  });
  result.limitBytes = limit;
  if (result.keptBytes <= limit) return result;

  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries) {
    if (result.keptBytes <= limit) break;
    if (keep.has(e.task)) continue;
    if (now() - e.mtime < minAge) continue;
    try {
      await rm(e.path, { recursive: true, force: true });
      result.removed.push(e.path);
      result.freedBytes += e.bytes;
      result.keptBytes -= e.bytes;
    } catch {
      // 删不掉（被占用）就跳过，下一轮再试。
    }
  }
  return result;
}

/** 把上限 GB 换成字节（配置里就是这个单位）。 */
export function gbToBytes(gb: number): number {
  return Math.max(0, gb) * 1024 * 1024 * 1024;
}

/** 快照目录现在占多少字节。目录不存在算 0。同步版，别在定时器里对大树用。 */
export function snapshotBytesOnDisk(root: string): number {
  if (!existsSync(root)) return 0;
  return treeSize(root);
}

/**
 * 这个路径所在卷还剩多少字节；量不出来返回 null（宁可不动，别按 0 误删）。
 * 2026-11-27：真机上 C 盘只剩 0.5 GB，keeper 因此把 admission 停成 paused_disk——
 * 新任务全被拒。而快照回收只看 `snapshots_max_gb`（默认 5 GB），快照 1.8 GB 没到上限，
 * 于是一个都不删：**盘快满了，回收器还在睡**。这里让回收也看磁盘余量。
 */
export function freeBytesAt(path: string): number | null {
  try {
    const st = statfsSync(path);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** 盘紧的判定线：低于它就开始压低快照预算。 */
export const TIGHT_FREE_BYTES = 1536 * 1024 * 1024;
/** 盘紧时要腾到多少余量。 */
export const TARGET_FREE_BYTES = 2560 * 1024 * 1024;
/** 再紧也至少留这么多快照（最近一小时的本来就不删，这是兜底）。 */
export const MIN_KEEP_BYTES = 256 * 1024 * 1024;

/**
 * 这一次回收该按多少字节当上限。
 * 宽裕时就是配置值；盘紧时按「腾到 TARGET_FREE」倒推，并且不超过配置值。
 */
export function effectiveLimitBytes(input: {
  configuredBytes: number;
  freeBytes: number | null;
  snapshotBytes: number;
}): number {
  const { configuredBytes, freeBytes, snapshotBytes } = input;
  if (freeBytes === null || freeBytes >= TIGHT_FREE_BYTES) return configuredBytes;
  const deficit = TARGET_FREE_BYTES - freeBytes;
  const allowed = snapshotBytes - deficit;
  return Math.max(MIN_KEEP_BYTES, Math.min(configuredBytes, allowed));
}
