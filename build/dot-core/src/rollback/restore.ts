/**
 * src/rollback/restore.ts —— 把整目录快照放回去（A.11 回退的落地动作）。
 *
 * 三件事，顺序不能换：
 *   1. 围栏：快照的源路径必须在调用方给的 workspace 之内。`..`、盘符、UNC 全部先用
 *      resolve() 规范化再比，不同盘符在 win32 上会得到绝对路径的相对值，一并挡住；
 *   2. 算 diff：以清单里的 hash 为准，分新增 / 覆盖 / 原样；
 *      清单里没有、但目录里现在有的文件算「那之后新建的」，要删。
 *   3. 落地（dryRun 时不做）：先补建目录、逐个写回，再删多余的。
 *
 * 为什么先写后删：写失败时旧文件还在，信息损失最小；先删再写一旦写失败就是
 * 「两边都没有」。写完再删也保证「覆盖 + 删除」是同一个原子意图的结果。
 *
 * 删符号链接：扫描时就不跟随、不列进 diff，所以不会删；这不是遗漏，是刻意——
 * 链接指向的内容不归这次快照管。
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { LedgerError, sha256Bytes, type LedgerDb, type SnapshotRow } from "../ledger/index.ts";
import {
  isRelInside,
  readDirSnapshotRecord,
  scanTree,
  type DirSnapshotRecord,
} from "./fs-snapshot.ts";

export interface RestoreOptions {
  snapshotId: string;
  /** 声明过的工作区根；快照源必须落在它里面。 */
  workspace: string;
  /** true = 只算不动盘。 */
  dryRun?: boolean;
}

export interface RestoreReport {
  snapshotId: string;
  /** 这份快照当时的源绝对路径。 */
  source: string;
  dryRun: boolean;
  /** 清单里有、当前没有的文件（相对快照根）。 */
  added: string[];
  /** 两边都有但内容不同。 */
  overwritten: string[];
  /** 当前有、清单里没有（那之后新建的），真还原时删掉。 */
  deleted: string[];
  /** 删不掉的路径（被占用等），不静默当作删成功。 */
  couldNotDelete: string[];
  /** 内容已经一致、这回没动的文件数。 */
  unchanged: number;
  /** 清单里的文件总数。 */
  totalEntries: number;
  /** 快照记录里跳过的条目（符号链接等），还原不会碰它们。 */
  skipped: Array<{ path: string; reason: string }>;
}

/** 读一行快照。records.ts 没有单行读，listSnapshots 又要先有 taskId，所以这里只读地查一次。 */
function readSnapshotRow(db: LedgerDb, id: string): SnapshotRow | null {
  const row = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as unknown as
    | SnapshotRow
    | undefined;
  return row ?? null;
}

/** 规范化后判断 target 是否落在 workspace 之内（含 workspace 本身）。 */
function assertInside(workspaceAbs: string, targetAbs: string, what: string): string {
  const ws = resolve(workspaceAbs);
  const t = resolve(targetAbs);
  const rel = relative(ws, t);
  if (!isRelInside(rel)) {
    throw new LedgerError(
      "outside_workspace",
      `${what} ${t} 不在工作区 ${ws} 之内，拒绝还原（工作区外的东西不归这张快照管）`,
    );
  }
  return t;
}

/** 取真实路径；路径还不存在就往上找到第一个存在的祖先。 */
function realpathOfExisting(abs: string): string {
  let probe = abs;
  for (let i = 0; i < 256; i += 1) {
    if (existsSync(probe)) return realpathSync(probe);
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  throw new LedgerError("path_unresolvable", `解析真实路径失败：${abs}`);
}

/**
 * 真实路径围栏：词法上在里面不代表实际在里面——工作区里的某一级可能是
 * 联接点/符号链接，指到外面去。写盘/删盘之前一律按 realpath 再比一次。
 */
function assertRealInside(workspaceAbs: string, targetAbs: string, what: string): void {
  const wsReal = realpathOfExisting(resolve(workspaceAbs));
  const tReal = realpathOfExisting(resolve(targetAbs));
  const rel = relative(wsReal, tReal);
  if (!isRelInside(rel)) {
    throw new LedgerError(
      "outside_workspace",
      `${what} 的真实路径 ${tReal} 不在工作区真实路径 ${wsReal} 之内（中间有符号链接/联接点指到外面），拒绝还原`,
    );
  }
}

/** 清单条目只能是「根下面的相对路径」：绝对路径、盘符、反斜杠、`.`、`..`、空段一律拒。 */
function assertSafeRelPath(rel: unknown, what: string): void {
  if (typeof rel !== "string" || rel === "") {
    throw new LedgerError("bad_entry_path", `${what} 里有空路径或非字符串，拒绝还原（清单被改坏了）`);
  }
  if (rel.includes("\\") || rel.includes("\u0000")) {
    throw new LedgerError("bad_entry_path", `${what} 里的 ${rel} 含反斜杠/NUL，拒绝还原（条目只许用 posix 相对路径）`);
  }
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new LedgerError("bad_entry_path", `${what} 里的 ${rel} 是绝对路径/盘符，拒绝还原（条目只能是相对路径）`);
  }
  for (const part of rel.split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw new LedgerError(
        "bad_entry_path",
        `${what} 里的 ${rel} 含非法路径段「${part}」，拒绝还原（.. 不许出现，路径必须落在快照根之内）`,
      );
    }
  }
}

/**
 * 逐级检查路径组件：中间任何一级是符号链接/联接点就拒。
 * 快照之后有人把子目录换成联接点，这一步挡住「经链接写到范围外」。
 */
function assertNoSymlinkComponent(rootAbs: string, rel: string, what: string): void {
  let cur = rootAbs;
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    cur = join(cur, parts[i] as string);
    if (!existsSync(cur)) return; // 后面还不存在，由 mkdir 自己建，不可能是链接
    if (lstatSync(cur).isSymbolicLink()) {
      throw new LedgerError(
        "snapshot_path_symlink",
        `${what} ${rel} 的第 ${i + 1} 级（${cur}）是符号链接/联接点，拒绝顺着它写盘或删盘（那会落到工作区外）`,
      );
    }
  }
}

function hashFile(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return sha256Bytes(readFileSync(abs));
  } catch {
    return null;
  }
}

/** 当前根下每个文件（posix 相对路径）→ hash。符号链接不列。 */
function currentHashes(rootAbs: string, kind: "dir" | "file"): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(rootAbs)) return out;
  if (kind === "file") {
    const hash = hashFile(rootAbs);
    if (hash !== null) out.set(basename(rootAbs), hash);
    return out;
  }
  for (const f of scanTree(rootAbs, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY).files) {
    const hash = hashFile(f.abs);
    if (hash !== null) out.set(f.rel, hash);
  }
  return out;
}

/**
 * 还原一张整目录快照。
 * dryRun=true 时返回同一份报告但不碰磁盘（仍会读盘算大小与哈希）。
 */
export function restoreSnapshot(db: LedgerDb, opts: RestoreOptions): RestoreReport {
  const row = readSnapshotRow(db, opts.snapshotId);
  if (row === null) {
    throw new LedgerError("snapshot_not_found", `没找到快照 ${opts.snapshotId}`);
  }
  const record = readDirSnapshotRecord(row);
  if (record === null) {
    throw new LedgerError(
      "snapshot_not_restorable",
      `快照 ${opts.snapshotId} 没有整目录清单（可能是动作前的单路径快照或旧格式），还原不了；只有 src/rollback 拍的快照能整目录还原`,
    );
  }

  // 围栏第一层：清单根与源都在工作区之内。文件快照的根是父目录，和源一起校验。
  const sourceAbs = assertInside(opts.workspace, record.source, "快照源路径");
  const rootAbs =
    record.sourceKind === "file" ? dirname(sourceAbs) : sourceAbs;
  assertInside(opts.workspace, rootAbs, "快照根目录");

  // 围栏第二层：真实路径。快照之后有人把工作区根（或某一级）换成联接点，
  // 词法比对看不出来，realpath 一比就露；先拦在这里，后面写盘/删盘才敢动。
  if (existsSync(sourceAbs) && lstatSync(sourceAbs).isSymbolicLink()) {
    throw new LedgerError(
      "snapshot_path_symlink",
      `快照源 ${sourceAbs} 现在是符号链接/联接点（快照之后被换掉的？），拒绝顺着它还原`,
    );
  }
  assertRealInside(opts.workspace, rootAbs, "快照根目录");

  // 围栏第三层：清单条目。条目只许是根下面的 posix 相对路径——写盘前一次性全查完，
  // 不给「写到一半才发现一条 path 是 ../x」的机会。
  for (const e of record.entries) assertSafeRelPath(e.path, `快照 ${opts.snapshotId}`);
  for (const d of record.dirs) assertSafeRelPath(d, `快照 ${opts.snapshotId} 的目录清单`);

  const current = currentHashes(sourceAbs, record.sourceKind);

  const added: string[] = [];
  const overwritten: string[] = [];
  let unchanged = 0;
  for (const e of record.entries) {
    const cur = current.get(e.path);
    if (cur === undefined) added.push(e.path);
    else if (cur !== e.hash) overwritten.push(e.path);
    else unchanged += 1;
  }
  const listed = new Set(record.entries.map((e) => e.path));
  const deleted =
    record.sourceKind === "dir"
      ? [...current.keys()].filter((p) => !listed.has(p)).sort((a, b) => a.localeCompare(b))
      : [];

  const dryRun = opts.dryRun === true;
  const couldNotDelete: string[] = [];

  // 逐级不是符号链接（子目录被换成联接点时，写下去/删下去都落到范围外）。
  // 试算也查：否则 dryRun 报的清单会漏掉这条，和真跑的结果对不上。
  for (const e of record.entries) assertNoSymlinkComponent(rootAbs, e.path, "要写回的文件");
  for (const p of deleted) assertNoSymlinkComponent(rootAbs, p, "要删除的文件");

  if (!dryRun) {
    // 副本里文件齐全（别写到一半发现少一个）。
    for (const e of record.entries) {
      const from = join(record.dir, ...e.path.split("/"));
      if (!existsSync(from)) {
        throw new LedgerError(
          "snapshot_payload_missing",
          `快照目录里缺 ${e.path}（${from}），还原中止；账本清单与磁盘副本不一致，请重拍这张快照`,
        );
      }
    }

    for (const d of record.dirs) mkdirSync(join(rootAbs, ...d.split("/")), { recursive: true });
    for (const e of record.entries) {
      const from = join(record.dir, ...e.path.split("/"));
      const to = join(rootAbs, ...e.path.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      // 目标位置上如果被人放了链接（快照之后新建的），先摘掉链接再写文件本体：
      // copyFileSync 会顺着链接写出去。
      if (existsSync(to) && lstatSync(to).isSymbolicLink()) unlinkSync(to);
      copyFileSync(from, to);
    }
    for (const p of deleted) {
      const abs = join(rootAbs, ...p.split("/"));
      // 用 unlinkSync 而不是 rmSync：本机（Node 24.13.0 / win32）实测 rmSync 对
      // 「中文目录里的文件」是静默 no-op，unlinkSync 正常。删不掉就记进报告，不当成功。
      try {
        unlinkSync(abs);
      } catch {
        // 下面统一按 exists 复核
      }
      if (existsSync(abs)) couldNotDelete.push(p);
    }
  }

  return {
    snapshotId: opts.snapshotId,
    source: sourceAbs,
    dryRun,
    added,
    overwritten,
    deleted: couldNotDelete.length === 0 ? deleted : deleted.filter((p) => !couldNotDelete.includes(p)),
    couldNotDelete,
    unchanged,
    totalEntries: record.entries.length,
    skipped: record.skipped.map((s) => ({ path: s.path, reason: s.reason })),
  };
}

/** 报告里「恢复了几个文件」的口径：新增 + 覆盖。 */
export function restoredPaths(report: RestoreReport): string[] {
  return [...report.added, ...report.overwritten];
}

export type { DirSnapshotRecord };

export function describeRestore(report: RestoreReport): string {
  const head = report.dryRun ? "试算（没动盘）" : "已还原";
  const bits = [
    `覆盖 ${report.overwritten.length}`,
    `新增 ${report.added.length}`,
    `删除 ${report.deleted.length}`,
  ];
  const tail = report.unchanged > 0 ? `，${report.unchanged} 个文件本来就一致` : "";
  return `${head}：${bits.join("，")}${tail}`;
}
