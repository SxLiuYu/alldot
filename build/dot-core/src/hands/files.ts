/**
 * src/hands/files.ts —— 本地文件手：在**任务声明的工作区**里建目录 / 写文本 / 列目录。
 *
 * 为什么单独做一只（2026-11-25 用户指出）：桌面建文件夹这种事，cmd 与 PowerShell 都能做，
 * 电脑手（Windows-MCP）却只会点、打字、按键，没有建文件夹的动作——所以「在桌面建文件夹」
 * 这类最普通的活，工人一直判「干不了」。
 *
 * 但**不给工人开 shell**：一条命令会改哪些文件执行前不可知，第 2 档就拍不了快照、回退不了；
 * 路径里塞 `&`、`;`、`|` 还能拐去跑别的命令。所以这里只给三个动作（list / mkdir / write），
 * 复用练习文件夹那套已经验证过的路径围栏（相对路径、不许绝对路径、不许 `..`、沿途不许符号链接），
 * 闸门判档与记账仍然走 src/hands/hand.ts 的七步壳：写动作照旧「先快照再放行」。
 *
 * 与练习手的唯一区别是**根从哪来**：
 *   practice → config.json 的 practice.root（一个固定的练习文件夹）
 *   files    → 任务声明的 declared（workspace / root / workdir / dir 之一）
 *              没声明时，看任务原话里有没有明确点名（桌面 / 文档 / 下载 / 图片 / 现成的绝对路径）；
 *              点名了就用它，**没点名或点名不止一处就拒绝**，绝不默认到桌面。
 *
 * 2026-11-25 真机补正：原来「没声明就拒」，结果「在桌面建个文件夹」这种最普通的活
 * 一律失败（账本里那条 task_386c… 就是这个），而用户下任务时不会去填 declared 字段。
 * 现在改成只认原话里说得出口的地点——这不是猜路径：说话人自己点了名，且落点仍然过闸门
 * 出请示卡、账本里写明「工作区来自任务原话」。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TaskRow } from "../ledger/index.ts";
import {
  PRACTICE_MAX_LIST_ENTRIES,
  PRACTICE_MAX_WRITE_BYTES,
  PracticeError,
  listDir,
  makeDir,
  resolvePracticePath,
  writeTextFile,
  type ListResult,
  type MkdirResult,
  type WriteResult,
} from "./practice.ts";
import { HAND_TEXT_LIMIT, renderList, runHandShell, type HandDeps, type HandOutcome, type HandRequest, type HandSpec } from "./hand.ts";
import type { GateInput } from "../gate/types.ts";

export const FILES_TOOL_NAME = "files";

export const FILES_ACTIONS = ["list", "mkdir", "write", "read"] as const;
export type FilesAction = (typeof FILES_ACTIONS)[number];

/** 动作别名：模型常写 create_folder / mkdir_recursive 这类，统一归一。 */
const ACTION_ALIASES: Readonly<Record<string, FilesAction>> = Object.freeze({
  list: "list",
  ls: "list",
  dir: "list",
  read_dir: "list",
  mkdir: "mkdir",
  mkdirs: "mkdir",
  make_dir: "mkdir",
  create_dir: "mkdir",
  create_folder: "mkdir",
  new_folder: "mkdir",
  write: "write",
  write_file: "write",
  create_file: "write",
  save: "write",
  read: "read",
  cat: "read",
  view: "read",
  show: "read",
  read_file: "read",
  get_file: "read",
});

export function normalizeFilesAction(action: unknown): FilesAction | null {
  if (typeof action !== "string") return null;
  const key = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ACTION_ALIASES[key] ?? null;
}

export const FILES_ACTION_HELP = "action 只支持 list / mkdir / write / read";

/** 从任务的 declared_json 里读工作区（与 src/context/anchor.ts 认同一批键）。 */
export function declaredWorkspaceOf(task: TaskRow): string | null {
  const raw = task.declared_json;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of ["workspace", "root", "workdir", "dir"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const paths = obj["paths"];
  if (Array.isArray(paths)) {
    const first = paths.find((p) => typeof p === "string" && p.trim() !== "");
    if (typeof first === "string") return first.trim();
  }
  return null;
}

interface FilesContext {
  root: string;
  /** 给人看的根（正文里用原样的绝对路径，不缩写）。 */
  label: string;
  /** 根从哪来：任务声明，还是原话里点名的位置。 */
  source: "declared" | "intent";
}

/** 任务原话里能点名的几个常见文件夹（只认这几个，别的都不猜）。 */
const INTENT_FOLDERS: ReadonlyArray<{ re: RegExp; name: string; label: string }> = Object.freeze([
  { re: /桌面|desktop/i, name: "Desktop", label: "桌面" },
  { re: /文档|documents?/i, name: "Documents", label: "文档" },
  { re: /下载|downloads?/i, name: "Downloads", label: "下载" },
  { re: /图片|pictures?/i, name: "Pictures", label: "图片" },
]);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 根内的绝对路径折算成相对；根外的原样返回，交给路径围栏去拒。
 * 为什么要有这一层：模型经常把「桌面上那个文件夹」写成 `C:\Users\1\Desktop\x`，
 * 而围栏只收相对路径——不折算就会报 bad_path，看起来像手坏了。
 */
function relPath(root: string, raw: string | undefined): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return raw;
  if (!isAbsolute(raw)) return raw;
  const rel = relative(root, resolve(raw));
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return raw;
  return rel.split(sep).join("/");
}

/**
 * 从任务原话里认工作区。认不出、或者同时点了两个地方，一律返回 null（由调用方拒绝）。
 * 写动作仍然要过闸门、出请示卡——这里只是把「往哪儿做」从原话里读出来，不是放宽权限。
 */
export function workspaceFromIntent(intent: string): { root: string; label: string } | null {
  const text = typeof intent === "string" ? intent : "";

  // 1) 原话里有绝对路径：本身是存在的目录就用它，是文件就用它所在目录。
  const abs = text.match(/[A-Za-z]:[\\/][^\s，。；、,;:'"<>|*?\n]*/);
  if (abs !== null) {
    const p = abs[0].replace(/[\\/]+$/, "");
    if (isDir(p)) return { root: p, label: p };
    const parent = dirname(p);
    if (parent !== p && isDir(parent)) return { root: parent, label: parent };
  }

  // 2) 中文/常见叫法：只认唯一命中。
  const hits = INTENT_FOLDERS.filter((f) => f.re.test(text));
  if (hits.length === 1) {
    const dir = join(homedir(), hits[0].name);
    if (isDir(dir)) return { root: dir, label: hits[0].label };
  }
  return null;
}

/**
 * 根目录白名单：files 手只许在这些目录下干活。
 * 防止任务声明 C:\Windows\System32 这种危险路径当工作区。
 * 允许：桌面 / 文档 / 下载 / 图片 / 练习夹 / D 盘项目目录 / tmp。
 */
function checkRootAllowed(root: string): string | null {
  const r = root.toLowerCase().replace(/\//g, "\\");
  const allowed = [
    "c:\\users",
    "c:\\temp",
    "d:\\",
    "e:\\",
  ];
  // 明确禁止的系统目录
  const denied = [
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata",
    "c:\\$recycle.bin",
    "c:\\system volume information",
  ];
  for (const d of denied) {
    if (r.startsWith(d)) {
      return `工作区根目录不允许系统路径：${root}。可选：桌面 / 文档 / 下载 / 图片 / 练习夹 / D 盘项目目录。`;
    }
  }
  for (const a of allowed) {
    if (r.startsWith(a)) return null;
  }
  return `工作区根目录不在白名单内：${root}。可选：桌面 / 文档 / 下载 / 图片 / 练习夹 / D 盘项目目录。`;
}

function gateInputFor(action: FilesAction, req: HandRequest, root: string): GateInput {
  return {
    tool: FILES_TOOL_NAME,
    action,
    args: { path: req.path ?? null, action },
    target: typeof req.path === "string" && req.path !== "" ? req.path : ".",
    workspace: root,
    inWorkspace: true, // 路径围栏已经把范围锁死了，走到这里的都在根内
  };
}

const filesSpec: HandSpec<FilesContext> = {
  toolName: FILES_TOOL_NAME,
  normalize: (req) => normalizeFilesAction(req.action),
  badActionText: FILES_ACTION_HELP,

  prepare(_deps: HandDeps, task: TaskRow) {
    const declared = declaredWorkspaceOf(task);
    if (declared !== null) {
      const root = resolve(declared);
      const check = checkRootAllowed(root);
      if (check !== null) return { ok: false as const, code: "workspace_missing" as const, text: check };
      return { ok: true as const, ctx: { root, label: root, source: "declared" as const } };
    }
    const inferred = workspaceFromIntent(task.intent ?? "");
    if (inferred !== null) {
      const root = resolve(inferred.root);
      // intent 推断的工作区也要过白名单，不能只拦 declared
      const check = checkRootAllowed(root);
      if (check !== null) return { ok: false as const, code: "workspace_missing" as const, text: check };
      return { ok: true as const, ctx: { root, label: root, source: "intent" as const } };
    }
    return {
      ok: false as const,
      code: "workspace_missing" as const,
      text:
        "这个任务没说往哪个文件夹做（任务声明里没有 workspace / root / workdir / dir），" +
        "原话里也没点名桌面 / 文档 / 下载 / 图片或一个现成的路径。" +
        "要让这只手干活，要么把工作区写进任务声明，要么在话里说清往哪儿做；手不猜、也不默认到桌面。",
    };
  },

  gateInput(action, req, ctx) {
    return gateInputFor(action as FilesAction, req, ctx.root);
  },

  subjectParams(action, req) {
    return { action, path: req.path ?? null, overwrite: req.overwrite === true };
  },

  validate(action, req, ctx) {
    if (action === "list") return null;
    const p = relPath(ctx.root, req.path);
    if (typeof p !== "string" || p.trim() === "" || p === ".") {
      return {
        code: "bad_action" as const,
        text: `${action} 要写一个具体路径，不能拿工作区根（${ctx.root}）本身当目标。` +
          "对根拍照等于把整棵树复制一份——2026-11-25 就是这么把 C 盘吃到只剩 10 MB 的。",
      };
    }
    return null;
  },

  snapshotTarget(action, req, ctx) {
    if (action === "list") return null;
    const target = resolvePracticePath(ctx.root, relPath(ctx.root, req.path) ?? ".", { allowRoot: true });
    // 再兜一道：绝不对工作区根整棵拍照。
    if (resolve(target.abs) === resolve(ctx.root)) return null;
    return { abs: target.abs, label: target.rel };
  },

  act(action, req, ctx) {
    const path = relPath(ctx.root, req.path);
    if (action === "list") {
      const listed = listDir(ctx.root, path);
      return { data: listed, summary: renderList(listed) };
    }
    if (action === "mkdir") {
      if (typeof path !== "string" || path.trim() === "") {
        throw new PracticeError(
          "bad_path",
          'mkdir 需要 path（要建的文件夹名）。例：{"action":"mkdir","path":"dot-验收文件夹"}。别重发不带 path 的调用。',
        );
      }
      const made = makeDir(ctx.root, path);
      return {
        data: made,
        summary:
          made.created.length === 0
            ? `文件夹已存在：${made.path}`
            : `建好文件夹：${made.path}（新建 ${made.created.length} 级：${made.created.join(" / ")}）`,
      };
    }
    if (action === "read") {
      if (typeof path !== "string" || path.trim() === "") {
        throw new PracticeError(
          "bad_path",
          'read 需要 path（要读的文件名）。例：{"action":"read","path":"app/config.py"}。',
        );
      }
      const resolved = resolvePracticePath(ctx.root, path, { allowRoot: false });
      let content: string;
      try {
        content = readFileSync(resolved.abs, "utf8");
      } catch {
        throw new PracticeError("not_found", `文件不存在：${resolved.rel}`);
      }
      // 超长文件截断，避免把模型上下文撑爆。
      // 2026-11-27 加 offset：原来截断就完了，没有「接着读」的办法，工人只好改用
      // exec 跑 `tail -n +900` 一段段啃 routes.ts（真机上一条任务因此读了 70 多步）。
      // 顺手修掉一个更隐蔽的：窗口原来写 8000，可 hand 层的正文上限是 HAND_TEXT_LIMIT(4000)，
      // 于是每次都被二次截断、连「截断」那句尾巴都掉，模型以为文件就这么长。
      const MAX_READ = HAND_TEXT_LIMIT - 600; // 给头尾留位置
      const rawOffset = Number((req.params ?? {})["offset"] ?? 0);
      const asked = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
      // offset 越界不报错（模型算错很常见），退到最后一屏。
      const offset = asked >= content.length ? Math.max(0, content.length - MAX_READ) : asked;
      const window = content.slice(offset, offset + MAX_READ);
      const next = offset + window.length;
      const rest = next < content.length;
      const gap = offset === 0 ? "" : `，从第 ${offset} 字符起`;
      return {
        data: { path: resolved.rel, bytes: Buffer.byteLength(content), truncated: rest, offset, next },
        // 「接着读用 offset=…」必须放在第一行：正文超长时 hand 层截的是尾巴。
        summary: rest
          ? `文件：${resolved.rel}（共 ${content.length} 字符${gap}，这次给到第 ${next} 字符；还没完，接着读用 offset=${next}）\n---\n${window}\n---`
          : `文件：${resolved.rel}（共 ${content.length} 字符${gap}）\n---\n${window}\n---${offset > 0 ? "（已到文件末尾）" : ""}`,
      };
    }
    if (typeof path !== "string" || path.trim() === "") {
      throw new PracticeError(
        "bad_path",
        'write 需要 path（写到哪个文件）。例：{"action":"write","path":"说明.txt","content":"..."}。别重发不带 path 的调用。',
      );
    }
    const written = writeTextFile(ctx.root, path, req.content ?? "", { overwrite: req.overwrite === true });
    return {
      data: written,
      summary: `写入完成：${written.path}（${written.bytes} 字节，${written.created ? "新建" : "覆盖"}）`,
    };
  },

  errorCode(err) {
    return err instanceof PracticeError ? err.code : "unexpected";
  },

  approvalCard(action, req, ctx, task, verdict) {
    return {
      args: { action, path: req.path ?? null, workspace: ctx.root },
      title: `工作区文件动作需要批准：${action}${req.path ? ` ${req.path}` : ""}`,
      detail: {
        question: `允许这一步吗：${verdict.reason}`,
        options: ["同意", "拒绝"],
        detail: `${task.intent}\n工作区：${ctx.root}${ctx.source === "intent" ? "（来自任务原话）" : ""}\n工具：${FILES_TOOL_NAME}/${action}\n路径：${req.path ?? "(根目录)"}`,
      },
    };
  },

  stepArgs(action, req, ctx, extra) {
    return {
      action,
      path: relPath(ctx.root, req.path) ?? null,
      overwrite: req.overwrite === true,
      workspace: ctx.root,
      workspace_source: ctx.source,
      task_id: extra.taskId,
      approval_id: extra.approvalId,
      snapshot: extra.verdict.handling === "snapshot" ? "planned" : "not_required",
    };
  },

  resultArtifact(action, _req, ctx, extra) {
    return {
      ok: true,
      action,
      workspace: ctx.root,
      data: extra.data,
      snapshot:
        extra.snapshotRef !== null
          ? "created"
          : extra.verdict.handling === "snapshot"
            ? "unavailable"
            : "not_required",
      approval_id: extra.approvalId,
    };
  },
};

/** 跑一次工作区文件动作。taskId 必须显式给或由会话身份给出（与练习手一致）。 */
export async function runFilesHand(deps: HandDeps, req: HandRequest): Promise<HandOutcome> {
  return runHandShell(deps, req, filesSpec);
}

export type { ListResult, MkdirResult, WriteResult };
export { PRACTICE_MAX_LIST_ENTRIES, PRACTICE_MAX_WRITE_BYTES };
