/**
 * src/maintenance/index.ts —— 回收快照。配置里早就有 `keepalive.snapshots_max_gb`（默认 5 GB），
 * 但一直没有执行者：2026-11-25 真机上快照目录长到 12 GB，把 C 盘吃到只剩 10 MB，
 * 之后所有写动作全部 ENOSPC。这里补上执行者。
 *
 * 口径（宁少删不多删）：
 *   · 只删 `snapshots/<task_id>/<时间戳>/` 这一层，不动别的目录；
 *   · 正在跑的任务（running / queued）的快照一律保留——回退要用；
 *   · 从最旧的开始删，删到总量回到上限以下就停；
 *   · 只删文件，账本 snapshots 表的历史行保留（取回时会如实说「已被回收」）。
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
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

/**
 * 按总量上限回收快照。返回删了什么、腾了多少。
 * 目录不存在时当作空目录（第一次运行时就是这样）。
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

  interface Entry {
    path: string;
    task: string;
    bytes: number;
    mtime: number;
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

/** 把上限 GB 换成字节（配置里就是这个单位）。 */
export function gbToBytes(gb: number): number {
  return Math.max(0, gb) * 1024 * 1024 * 1024;
}
