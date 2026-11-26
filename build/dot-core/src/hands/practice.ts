/**
 * src/hands/practice.ts —— 最小那只手的**落地动作**：只在练习文件夹里
 * 列目录、建文件夹、写文本文件（本轮范围，见 A.4 的「手」与 B.4 的 src/hands）。
 *
 * 三条硬约束，全部在代码里，不靠提示词：
 * 1. 路径必须落在练习根目录内。绝对路径、盘符、UNC、`..`、NUL 一律拒；
 *    沿途任何一级是符号链接也拒（防止练习夹里放个链接指到别处）。
 * 2. 只做三件事：list / mkdir / write(utf8)。不删、不改名、不执行、不读二进制。
 * 3. write 默认不覆盖（已存在就报错，要覆盖得显式 overwrite=true），
 *    大小上限 256 KiB —— 这只手是给「练习」用的，不是搬运大文件。
 *
 * 这里只有文件系统动作，**不记账、不判档**：那两步在 src/hands/hand.ts 里，
 * 顺序照 A.4 的七步（先记账后动手）。本文件被 hand.ts 调用，也可以单独测。
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PRACTICE_MAX_WRITE_BYTES = 256 * 1024;
export const PRACTICE_MAX_LIST_ENTRIES = 200;

export class PracticeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PracticeError";
    this.code = code;
  }
}

export type PracticeAction = "list" | "mkdir" | "write" | "read";

export interface ResolvedPath {
  /** 练习根目录的绝对路径（未做 realpath，保持调用方给的那份）。 */
  root: string;
  /** 相对根目录的 posix 风格路径（根目录本身是 "."）。 */
  rel: string;
  /** 绝对路径。 */
  abs: string;
}

const DRIVE_OR_UNC = /^(?:[a-zA-Z]:|[\\/]{2})/;

/** 练习根：没配就抛，绝不回落到默认目录（fail-closed，A.7「归不到就拒绝」同款口径）。 */
export function practiceRootOf(root: string | null | undefined): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw new PracticeError(
      "practice_root_missing",
      "config.json 的 practice.root 没配：手拒绝执行（不会猜一个默认文件夹）",
    );
  }
  return resolve(root.trim());
}

function toPosix(rel: string): string {
  return rel.split(sep).join("/");
}

/**
 * 把「模型给的相对路径」解析成绝对路径，并验证它没跑出练习根。
 * 只做词法核对（resolve）+ 符号链接核对（沿途 lstat），不要求目标已存在。
 */
export function resolvePracticePath(
  root: string,
  relPath?: string | null,
  opts: { allowRoot?: boolean } = {},
): ResolvedPath {
  const rootAbs = resolve(root);
  const raw = typeof relPath === "string" ? relPath.trim() : "";
  const cleaned = raw === "" ? "." : raw;

  if (cleaned.includes("\0")) throw new PracticeError("bad_path", "路径里有 NUL 字符");
  if (isAbsolute(cleaned) || DRIVE_OR_UNC.test(cleaned) || cleaned.startsWith("/")) {
    throw new PracticeError("bad_path", `只接受工作区内的相对路径（根：${rootAbs}），收到绝对路径：${cleaned}`);
  }

  const abs = resolve(rootAbs, cleaned);
  const relToRoot = relative(rootAbs, abs);

  if (relToRoot !== "" && (relToRoot.startsWith("..") || isAbsolute(relToRoot))) {
    throw new PracticeError("outside_root", `路径跑出了工作区（根：${rootAbs}）：${cleaned}`);
  }
  if (relToRoot === "" && opts.allowRoot !== true) {
    throw new PracticeError("bad_path", "这里需要一个文件/文件夹路径，不能是练习根目录本身");
  }

  assertNoSymlinkOnTheWay(rootAbs, abs);

  return { root: rootAbs, rel: relToRoot === "" ? "." : toPosix(relToRoot), abs };
}

/**
 * 沿途任何一级（含目标本身，若已存在）是符号链接就拒。
 * 只 stat 已存在的部分：write 新文件时目标还不存在，能查到的是它的父级。
 */
function assertNoSymlinkOnTheWay(rootAbs: string, abs: string): void {
  const chain: string[] = [];
  let cursor = abs;
  for (let i = 0; i < 64; i += 1) {
    chain.push(cursor);
    if (cursor === rootAbs) break;
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }

  for (const p of chain) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue; // 不存在：写成时会由父目录存在性检查兜住
    }
    if (st.isSymbolicLink()) {
      throw new PracticeError("symlink_denied", `练习文件夹里不许走符号链接：${p}`);
    }
  }
}

export interface PracticeEntry {
  name: string;
  /** "dir" | "file" | "other"；符号链接列成 other，不跟进去。 */
  type: "dir" | "file" | "other";
  bytes: number | null;
}

export interface ListResult {
  path: string;
  entries: PracticeEntry[];
  /** 超过 PRACTICE_MAX_LIST_ENTRIES 时只给前 N 条并在正文里注明。 */
  truncated: boolean;
  total: number;
}

/** 列目录。不递归；文件夹在前、再按名字排（大小写不敏感）。 */
export function listDir(root: string, relPath?: string | null): ListResult {
  const target = resolvePracticePath(root, relPath, { allowRoot: true });
  let stat;
  try {
    stat = statSync(target.abs);
  } catch {
    throw new PracticeError("not_found", `文件夹不存在：${target.rel}`);
  }
  if (!stat.isDirectory()) throw new PracticeError("not_a_directory", `不是文件夹：${target.rel}`);

  const all = readdirSync(target.abs, { withFileTypes: true }).map((d): PracticeEntry => {
    const isDir = d.isDirectory();
    const isFile = d.isFile();
    let bytes: number | null = null;
    if (isFile) {
      try {
        bytes = statSync(resolve(target.abs, d.name)).size;
      } catch {
        bytes = null;
      }
    }
    return { name: d.name, type: isDir ? "dir" : isFile ? "file" : "other", bytes };
  });

  all.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "dir") return -1;
      if (b.type === "dir") return 1;
    }
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const entries = all.slice(0, PRACTICE_MAX_LIST_ENTRIES);
  return {
    path: target.rel,
    entries,
    truncated: all.length > entries.length,
    total: all.length,
  };
}

export interface MkdirResult {
  path: string;
  created: string[];
}

/** 建文件夹（可嵌套）。已存在同名目录算成功（created 为空），同名文件则报错。 */
export function makeDir(root: string, relPath: string): MkdirResult {
  const target = resolvePracticePath(root, relPath);
  const created: string[] = [];

  // 从根往下逐级建，好把「这一轮真建了哪几级」如实列出来。
  const parts = target.rel.split("/");
  let cursor = target.root;
  let cursorRel = "";
  for (const part of parts) {
    cursor = resolve(cursor, part);
    cursorRel = cursorRel === "" ? part : `${cursorRel}/${part}`;
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      st = undefined;
    }
    if (st !== undefined) {
      if (!st.isDirectory()) {
        throw new PracticeError("not_a_directory", `路径上已有一个同名文件：${cursorRel}`);
      }
      continue;
    }
    try {
      mkdirSync(cursor);
      created.push(cursorRel);
    } catch (err) {
      throw new PracticeError("mkdir_failed", `建文件夹失败（${cursorRel}）：${(err as Error).message}`);
    }
  }

  return { path: target.rel, created };
}

export interface WriteResult {
  path: string;
  bytes: number;
  /** false = 覆盖了已有文件；true = 新建。 */
  created: boolean;
}

/** 写 utf8 文本。默认不覆盖；父目录必须已存在（先 mkdir 再 write，步骤才可审计）。 */
export function writeTextFile(
  root: string,
  relPath: string,
  content: string,
  opts: { overwrite?: boolean } = {},
): WriteResult {
  if (typeof content !== "string") throw new PracticeError("bad_content", "content 必须是字符串");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PRACTICE_MAX_WRITE_BYTES) {
    throw new PracticeError(
      "content_too_large",
      `内容 ${bytes} 字节，超过上限 ${PRACTICE_MAX_WRITE_BYTES} 字节（练习用，别写大文件）`,
    );
  }

  const target = resolvePracticePath(root, relPath);
  const parent = resolve(target.abs, "..");
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch {
    throw new PracticeError(
      "parent_missing",
      `父文件夹不存在：${toPosix(relative(target.root, parent))}（先用 mkdir 建出来）`,
    );
  }
  if (!parentStat.isDirectory()) throw new PracticeError("parent_not_a_directory", "父路径不是文件夹");

  let exists = false;
  let existingBytes: number | null = null;
  try {
    const st = statSync(target.abs);
    if (st.isDirectory()) throw new PracticeError("target_is_directory", `目标是文件夹：${target.rel}`);
    exists = true;
    existingBytes = st.size;
  } catch (err) {
    if (err instanceof PracticeError) throw err;
    exists = false;
  }

  if (exists && opts.overwrite !== true) {
    throw new PracticeError(
      "exists",
      `文件已存在（${target.rel}，${existingBytes ?? "?"} 字节）：要覆盖请显式传 overwrite=true`,
    );
  }

  try {
    writeFileSync(target.abs, content, { encoding: "utf8", flag: exists ? "w" : "wx" });
  } catch (err) {
    throw new PracticeError("write_failed", `写文件失败（${target.rel}）：${(err as Error).message}`);
  }

  return { path: target.rel, bytes, created: !exists };
}

/** 读回来核对用（只给测试与验证脚本，不暴露给模型）。 */
export function readTextFileForCheck(root: string, relPath: string): string {
  const target = resolvePracticePath(root, relPath);
  return readFileSync(target.abs, "utf8");
}
