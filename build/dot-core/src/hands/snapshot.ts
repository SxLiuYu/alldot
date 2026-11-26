/**
 * src/hands/snapshot.ts —— 第 2 档「先快照再放行」的最小实现（B.9 第 2 档、A.11）。
 *
 * 口径：把**被改动的那个路径**复制到 `~/.allbot/dot/snapshots/<task>/<时间戳>/` 下，
 * 同时在账本 snapshots 表写一行（kind="copy"），restore 里记「从哪复制回哪去」。
 * 目标还不存在（新建文件/新建目录）时也记一行，restore 记 `{ absent: true }`：
 * 回退的含义是「把新建出来的删掉」，这比不记更清楚。
 *
 * 为什么只快照单一路径、不整仓复制：练习手只改一个路径；整仓复制会把盘吃光
 * （B.7 有 snapshots_max_gb 上限，回收在 src/maintenance，本轮还没写）。
 *
 * 不适用范围（如实写在调用点的注释里）：内置 exec 能改的文件在执行前不可知，
 * 本轮对 exec 的第 2 档只记账、不快照，见 src/hands/builtin.ts。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSnapshot, type LedgerDb, type SnapshotRow } from "../ledger/index.ts";

export interface SnapshotRequest {
  taskId: string;
  milestoneId?: string | null;
  /** 要快照的绝对路径（可以还不存在）。 */
  sourcePath: string;
  /** 账本与目录里用的标签（一般是相对练习根的 posix 路径）。 */
  label: string;
}

export interface SnapshotDeps {
  db: LedgerDb;
  /** snapshots 根目录（默认 ~/.allbot/dot/snapshots，由入口传入）。 */
  snapshotsRoot: string;
  now?: () => Date;
  /** 单次快照的体积上限（默认 512 MB）；测试用得到。 */
  maxBytes?: number;
  /** 单次快照的文件/目录数上限（默认 20000）。 */
  maxEntries?: number;
}

const DEFAULT_MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_ENTRIES = 20_000;

/**
 * 量一下这棵树多大（超过上限就提前停，不把整棵走完）。
 * 为什么要量：2026-11-25 真机把「桌面」当成快照目标，一次复制 3.3 GB 的桌面，
 * 连做三次把 C 盘吃到只剩 10 MB，后续所有写动作全部 ENOSPC。
 */
function measureTree(root: string, maxBytes: number, maxEntries: number): { bytes: number; entries: number; tooBig: boolean } {
  let bytes = 0;
  let entries = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let st;
    try {
      st = statSync(cur);
    } catch {
      continue;
    }
    entries += 1;
    if (st.isDirectory()) {
      if (entries > maxEntries) return { bytes, entries, tooBig: true };
      let children: string[] = [];
      try {
        children = readdirSync(cur);
      } catch {
        children = [];
      }
      for (const c of children) stack.push(join(cur, c));
    } else {
      bytes += st.size;
      if (bytes > maxBytes || entries > maxEntries) return { bytes, entries, tooBig: true };
    }
  }
  return { bytes, entries, tooBig: bytes > maxBytes || entries > maxEntries };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * 把标签变成快照目录里的相对路径。
 *
 * 注意两点（都是 2026-11-25 真机踩出来的）：
 * 1) `/` 在 Windows 上也是分隔符，但它是**相对路径的一部分**，要保留目录层次 →
 *    所以按 `/` 切开、逐段清掉非法字符，再拼回去；
 * 2) `.` / `..` / 空段一律不认（`..` 会让快照写到 snapshots 外面去）。
 */
function safeLabel(label: string): string {
  const parts = label
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .map((part) => part.replace(/[:*?"<>|]/g, "_"));
  return parts.length === 0 ? "root" : parts.join("/");
}

/**
 * 递归复制（自己走目录，不用 `fs.cpSync`）。
 *
 * 2026-11-25 真机实测：本机 Node v24.13.0 + Windows 上 `fs.cpSync(目录, 目标, {recursive:true})`
 * 会让进程**直接死掉**——没有异常、没有调用栈、stdout 连一行都没来得及写，
 * 退出码 127。最小复现（纯 ASCII 路径，两个空目录）：
 *
 *     node -e "const fs=require('node:fs');fs.cpSync('tmp/a','tmp/b',{recursive:true})"
 *
 * 复制单个文件不崩（`cpSync(file, dest)` 正常、`copyFileSync` 正常），只有目录递归那条会崩。
 * 症状在真网关上表现为「工人第 2 档动作（要快照的那一步）一开始，网关就没了」，
 * 连带启动都走不完、HTTP 一直不回话——查了很久才定位到这一行。
 * 所以这里改成 readdir + copyFileSync 自己走一遍：行为等价，不再触发那个崩溃。
 */
function copyTreeSync(src: string, dest: string): void {
  const st = statSync(src);
  if (!st.isDirectory()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const childSrc = join(src, entry.name);
    const childDest = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTreeSync(childSrc, childDest);
    } else if (entry.isSymbolicLink()) {
      // 联接点/符号链接不跟进去（跟进去会走出练习范围，也可能绕回来）：只记名字，不复制内容。
      // 回退时它本来就不该被覆盖，这里跳过是安全的。
      continue;
    } else if (entry.isFile()) {
      copyFileSync(childSrc, childDest);
    }
    // 其它类型（设备/管道）也不复制
  }
}

export function snapshotPath(deps: SnapshotDeps, req: SnapshotRequest): SnapshotRow {
  const now = (deps.now ?? (() => new Date()))();
  const taskDir = join(deps.snapshotsRoot, req.taskId);
  const destDir = join(taskDir, stamp(now));
  mkdirSync(destDir, { recursive: true });

  const sourceAbs = resolve(req.sourcePath);
  if (!existsSync(sourceAbs)) {
    // 目标还不存在：不复制，只记「当时没有」，回退=删掉新建的。
    const marker = join(destDir, `${safeLabel(req.label)}.absent.json`);
    // 标签带子目录（例如 a/b.txt）时，标记文件的父目录还不存在：先建出来，
    // 否则 writeFileSync 直接 ENOENT（真机上就是这一步让第 2 档动作报 snapshot_failed）。
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ absent: true, path: sourceAbs, at: now.toISOString() }), "utf8");
    return createSnapshot(deps.db, {
      task_id: req.taskId,
      milestone_id: req.milestoneId ?? null,
      kind: "copy",
      ref: marker,
      restore: { absent: true, path: sourceAbs },
    });
  }

  const dest = join(destDir, safeLabel(req.label));
  const st = statSync(sourceAbs);
  if (st.isDirectory()) {
    const maxBytes = deps.maxBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    const maxEntries = deps.maxEntries ?? DEFAULT_MAX_SNAPSHOT_ENTRIES;
    const size = measureTree(sourceAbs, maxBytes, maxEntries);
    if (size.tooBig) {
      throw new Error(
        `快照太大，不敢复制：${sourceAbs} 至少 ${Math.round(size.bytes / 1024 / 1024)} MB / ${size.entries} 项` +
          `（上限 ${Math.round(maxBytes / 1024 / 1024)} MB / ${maxEntries} 项）。` +
          "这一步先不做——要么把动作范围缩小到一个具体文件/子目录，要么先说清怎么回退。",
      );
    }
  }
  copyTreeSync(sourceAbs, dest);

  return createSnapshot(deps.db, {
    task_id: req.taskId,
    milestone_id: req.milestoneId ?? null,
    kind: "copy",
    ref: dest,
    restore: { path: sourceAbs, from: dest, bytes: st.isDirectory() ? null : st.size },
  });
}
