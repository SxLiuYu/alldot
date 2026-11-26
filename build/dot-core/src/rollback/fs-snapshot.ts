/**
 * src/rollback/fs-snapshot.ts —— 整目录快照（A.11「按里程碑留底、回退」的前半截）。
 *
 * 与 src/hands/snapshot.ts 的分工：
 *   - hands/snapshot.ts 是**动作前**对「这次要改的那一个路径」拍一张，粒度是单路径；
 *   - 这里是**里程碑级**的整目录快照，粒度是「声明过的写入范围」，还原时要能
 *     「把那一刻的文件内容放回去，并且删掉那之后新建的文件」，所以清单必须带哈希。
 *
 * 落盘布局（ref 存相对 snapshotsRoot 的 posix 路径）：
 *   <snapshotsRoot>/<taskId>/<snapshotId>[-标签]/
 *       data/            完整副本（目录树原样）
 *       manifest.json    与账本 restore_json 同一份清单，方便人肉排查
 *
 * restore_json 里记的是**清单**，不只是来源路径：
 *   { version, source, sourceKind, dir, entries[{path,bytes,hash}], dirs[], skipped[], totalBytes, label }
 * entries 的 path 是相对「快照根」的 posix 路径：目录快照的根是被快照的目录，
 * 文件快照的根是它的父目录、path 就是文件名（还原时写回同一个绝对路径）。
 *
 * 三条硬约束：
 * 1. 符号链接/联接点一律不跟随，记进 skipped，还原时也不碰它；
 * 2. 单文件 ≤ 50MB、总量 ≤ 2GB，超了直接拒（LedgerError），不留半成品目录；
 *    —— 上限在扫描阶段就判，所以拒的时候磁盘上什么都没建；
 * 3. 同一 taskId + milestoneId（且源路径相同）已有可用 copy 快照就复用，不重复复制。
 *    force=true 时一定新拍（回退前那份 pre-rollback 存档走这条路，否则第二次回退
 *    会把「上一次回退前」的那份覆盖掉，撤销链就断在第一跳）。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  LedgerError,
  canonicalJson,
  createSnapshot,
  listSnapshots,
  parseJsonOrNull,
  randomId,
  sha256Bytes,
  type LedgerDb,
  type SnapshotRow,
} from "../ledger/index.ts";

/** 单文件上限（含二进制）。 */
export const SNAPSHOT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 一次快照的总量上限。 */
export const SNAPSHOT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export interface SnapshotFileEntry {
  /** 相对快照根的 posix 路径（目录快照：目录内路径；文件快照：文件名）。 */
  path: string;
  bytes: number;
  hash: string;
}

export interface SnapshotSkip {
  path: string;
  reason: "symlink" | "not_regular_file";
}

/** snapshots.restore_json 的结构。还原只认这一份（version=1）。 */
export interface DirSnapshotRecord {
  version: 1;
  /** 被快照的绝对路径。 */
  source: string;
  sourceKind: "dir" | "file";
  /** 副本所在绝对目录（<dest>/data）。ref 存的是相对路径，绝对路径记在这里，
   *  因为 restoreSnapshot 的入参里没有 snapshotsRoot。 */
  dir: string;
  entries: SnapshotFileEntry[];
  /** 目录清单（含空目录），还原时补建。 */
  dirs: string[];
  skipped: SnapshotSkip[];
  totalBytes: number;
  label: string | null;
}

export interface SnapshotDirDeps {
  db: LedgerDb;
  snapshotsRoot: string;
  /** 测试用：把上限调低。默认取模块常量。 */
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface SnapshotDirRequest {
  taskId: string;
  milestoneId?: string | null;
  sourcePath: string;
  /** 目录名里的标记（例如 "pre-rollback"），会出现在 ref 路径里。 */
  label?: string | null;
  /** true = 不复用已有快照，一定新拍。 */
  force?: boolean;
}

export interface SnapshotDirResult {
  snapshot: SnapshotRow;
  record: DirSnapshotRecord;
  /** true = 复用了之前那份，磁盘上没有新复制。 */
  reused: boolean;
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * 一个 relative() 结果是否表示「在根里面（含根本身）」。
 * 注意不能写成 `!rel.startsWith("..")`：那样会把名字以 `..` 开头的合法子目录
 * （如 `..foo`）误判成越界。只认 `..` 整段或 `..<sep>` 前缀；不同盘符时
 * relative() 会返回绝对路径，由 isAbsolute 兜住。
 */
export function isRelInside(rel: string): boolean {
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function safeLabel(label: string): string {
  return label.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
}

export interface ScannedTree {
  files: Array<{ abs: string; rel: string; bytes: number }>;
  dirs: string[];
  skipped: SnapshotSkip[];
  totalBytes: number;
}

/**
 * 只看不写地扫一棵树（还原时算 diff 也用它）。
 * 符号链接不跟随：lstat 判出来后记 skip、不进也不出。
 */
export function scanTree(
  rootAbs: string,
  maxFileBytes = SNAPSHOT_MAX_FILE_BYTES,
  maxTotalBytes = SNAPSHOT_MAX_TOTAL_BYTES,
): ScannedTree {
  const files: Array<{ abs: string; rel: string; bytes: number }> = [];
  const dirs: string[] = [];
  const skipped: SnapshotSkip[] = [];
  let totalBytes = 0;

  const walk = (abs: string, relBase: string): void => {
    const names = readdirSync(abs, { withFileTypes: true })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const childAbs = join(abs, name);
      const childRel = relBase === "" ? name : `${relBase}/${name}`;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        skipped.push({ path: childRel, reason: "symlink" });
        continue;
      }
      if (st.isDirectory()) {
        dirs.push(childRel);
        walk(childAbs, childRel);
        continue;
      }
      if (!st.isFile()) {
        skipped.push({ path: childRel, reason: "not_regular_file" });
        continue;
      }
      if (st.size > maxFileBytes) {
        throw new LedgerError(
          "snapshot_file_too_large",
          `文件 ${childRel} 有 ${st.size} 字节，超过单文件上限 ${maxFileBytes} 字节，不拍这张快照（快照不截断：截断的快照还原出来是坏数据）`,
        );
      }
      totalBytes += st.size;
      if (totalBytes > maxTotalBytes) {
        throw new LedgerError(
          "snapshot_too_large",
          `扫到 ${childRel} 时总量已超过 ${maxTotalBytes} 字节，不拍这张快照（换更小的范围，或先把大文件排除在写入范围外）`,
        );
      }
      files.push({ abs: childAbs, rel: childRel, bytes: st.size });
    }
  };

  walk(rootAbs, "");
  return { files, dirs, skipped, totalBytes };
}

/** 解析 snapshots 行里的清单；不是本模块写的（旧格式/单路径快照）返回 null。 */
export function readDirSnapshotRecord(row: SnapshotRow): DirSnapshotRecord | null {
  const value = parseJsonOrNull(row.restore_json);
  if (value === null || typeof value !== "object") return null;
  const rec = value as Partial<DirSnapshotRecord>;
  if (rec.version !== 1) return null;
  if (typeof rec.source !== "string" || rec.source === "") return null;
  if (typeof rec.dir !== "string" || rec.dir === "") return null;
  if (rec.sourceKind !== "dir" && rec.sourceKind !== "file") return null;
  if (!Array.isArray(rec.entries)) return null;
  for (const e of rec.entries) {
    if (e === null || typeof e !== "object") return null;
    if (typeof e.path !== "string" || typeof e.hash !== "string") return null;
  }
  return {
    version: 1,
    source: rec.source,
    sourceKind: rec.sourceKind,
    dir: rec.dir,
    entries: rec.entries,
    dirs: Array.isArray(rec.dirs) ? rec.dirs : [],
    skipped: Array.isArray(rec.skipped) ? rec.skipped : [],
    totalBytes: typeof rec.totalBytes === "number" ? rec.totalBytes : 0,
    label: typeof rec.label === "string" ? rec.label : null,
  };
}

function findReusable(
  db: LedgerDb,
  taskId: string,
  milestoneId: string | null,
  sourceAbs: string,
): { snapshot: SnapshotRow; record: DirSnapshotRecord } | null {
  // listSnapshots 按 created_at DESC，第一条就是最近的。
  for (const row of listSnapshots(db, taskId)) {
    if (row.kind !== "copy") continue;
    if ((row.milestone_id ?? null) !== milestoneId) continue;
    const record = readDirSnapshotRecord(row);
    if (record === null) continue;
    // 源路径必须一致：同一里程碑但换了源，复用它等于还原到别处。
    if (record.source !== sourceAbs) continue;
    // 副本被清理掉了就重拍（容量回收不在本轮，但别复用一条残骸）。
    if (!existsSync(record.dir)) continue;
    return { snapshot: row, record };
  }
  return null;
}

/**
 * 整目录快照。返回账本行 + 清单；同一任务同一里程碑重复调用默认复用。
 */
export function snapshotDir(deps: SnapshotDirDeps, req: SnapshotDirRequest): SnapshotDirResult {
  const maxFile = deps.maxFileBytes ?? SNAPSHOT_MAX_FILE_BYTES;
  const maxTotal = deps.maxTotalBytes ?? SNAPSHOT_MAX_TOTAL_BYTES;
  const milestoneId = req.milestoneId ?? null;
  const sourceAbs = resolve(req.sourcePath);

  if (!existsSync(sourceAbs)) {
    throw new LedgerError(
      "snapshot_source_missing",
      `要快照的路径还不存在：${sourceAbs}。整目录快照要求路径先存在（「要新建的东西」请走 src/hands/snapshot.ts 的 absent 标记）`,
    );
  }
  if (lstatSync(sourceAbs).isSymbolicLink()) {
    throw new LedgerError(
      "snapshot_source_symlink",
      `要快照的路径本身是符号链接/联接点，拒绝跟随：${sourceAbs}（快照根必须是真实目录）`,
    );
  }

  // 快照根不能在被快照的目录里：否则副本会被拍进自己要拍的东西里（越拍越深），
  // 而且还原时「清单外的新文件要删」会把副本自己删光，撤回也跟着作废。
  const snapsAbs = resolve(deps.snapshotsRoot);
  if (isRelInside(relative(sourceAbs, snapsAbs))) {
    throw new LedgerError(
      "snapshots_root_inside_source",
      `快照根 ${snapsAbs} 在被快照的路径 ${sourceAbs} 之内：副本会落进待拍目录自己里面。把快照根挪到外面（产品默认是 <dotDir>/snapshots）`,
    );
  }

  if (req.force !== true) {
    const hit = findReusable(deps.db, req.taskId, milestoneId, sourceAbs);
    if (hit !== null) return { snapshot: hit.snapshot, record: hit.record, reused: true };
  }

  // 先扫后建：体积超限或遇到坏文件时磁盘上不留半成品。
  const rootStat = lstatSync(sourceAbs);
  const scan = rootStat.isDirectory()
    ? scanTree(sourceAbs, maxFile, maxTotal)
    : { files: [], dirs: [], skipped: [] as SnapshotSkip[], totalBytes: 0 };
  let fileBytes = 0;
  if (!rootStat.isDirectory()) {
    fileBytes = rootStat.size;
    if (fileBytes > maxFile) {
      throw new LedgerError(
        "snapshot_file_too_large",
        `文件 ${sourceAbs} 有 ${fileBytes} 字节，超过单文件上限 ${maxFile} 字节，不拍这张快照`,
      );
    }
    if (fileBytes > maxTotal) {
      throw new LedgerError("snapshot_too_large", `文件 ${sourceAbs} 超过总量上限 ${maxTotal} 字节，不拍这张快照`);
    }
  }

  const id = randomId("snap");
  // 目录就用快照 id（<taskId>/<snapshotId>/data），带标签时才在后面补一段，
  // 这样「账本里的 id」与「磁盘上的目录」一一对得上，人肉排查不用查表对时间戳。
  const dirName = req.label ? `${id}-${safeLabel(req.label)}` : id;
  const destDir = join(deps.snapshotsRoot, req.taskId, dirName);
  const dataDir = join(destDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const entries: SnapshotFileEntry[] = [];
  if (rootStat.isDirectory()) {
    for (const d of scan.dirs) mkdirSync(join(dataDir, ...d.split("/")), { recursive: true });
    for (const f of scan.files) {
      // 一次读、一次写、一次算哈希：不为了哈希再读一遍。
      const buf = readFileSync(f.abs);
      const destFile = join(dataDir, ...f.rel.split("/"));
      mkdirSync(dirname(destFile), { recursive: true });
      writeFileSync(destFile, buf);
      entries.push({ path: f.rel, bytes: buf.byteLength, hash: sha256Bytes(buf) });
    }
  } else {
    const name = basename(sourceAbs);
    const buf = readFileSync(sourceAbs);
    writeFileSync(join(dataDir, name), buf);
    entries.push({ path: name, bytes: buf.byteLength, hash: sha256Bytes(buf) });
  }

  const record: DirSnapshotRecord = {
    version: 1,
    source: sourceAbs,
    sourceKind: rootStat.isDirectory() ? "dir" : "file",
    dir: resolve(dataDir),
    entries,
    dirs: scan.dirs,
    skipped: scan.skipped,
    totalBytes: rootStat.isDirectory() ? scan.totalBytes : fileBytes,
    label: req.label ?? null,
  };

  writeFileSync(join(destDir, "manifest.json"), `${canonicalJson(record)}\n`, "utf8");

  const snapshot = createSnapshot(deps.db, {
    id,
    task_id: req.taskId,
    milestone_id: milestoneId,
    kind: "copy",
    // ref 相对 snapshotsRoot，便于整个快照根搬家。
    ref: toPosix(relative(resolve(deps.snapshotsRoot), dataDir)),
    restore: record,
  });

  return { snapshot, record, reused: false };
}

