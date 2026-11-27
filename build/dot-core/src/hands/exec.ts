/**
 * src/hands/exec.ts —— 命令手：在工作区里跑一条命令（跑测试、跑构建、看 git 状态）。
 *
 * 为什么要这只手（2026-11-27 实测）：工人能改代码却**没法验证代码**——工具表里只有
 * files / desktop / browser / wechat / feishu，没有跑命令的手。派一个「写完跑 node --test」
 * 的任务，模型只能去点桌面开终端，出请示卡，16 步全耗在 desktop 上，最后卡住。
 * 「alldot 能优化所有项目」的最后一公里就是这只手。
 *
 * 三条约束（都很硬，别放宽）：
 * 1. **不带 shell**。命令按空白/引号拆成 argv，直接 spawn 可执行文件；`&`、`|`、`>`、`$(...)`
 *    这些在 cmd/bash 里才有效的东西，这里只是普通参数，没有注入面。
 * 2. **工作区里跑**。cwd 必须是任务声明工作区内的相对路径，解析后还要再核对前缀一次，
 *    防止 `..` 跳出去。
 * 3. **程序要走闸门**。judge 对 tool="exec" 已经有一整套：git status 一档、node build.js 二档、
 *    python -c 四档、rm -rf 六档。这里只负责把事实填进 GateInput，不自己判档。
 *    另外 act 里再兜一次白名单：批过之后也不许跑名单外的程序。
 *
 * 不拍快照：一条命令会改哪些文件执行前不可知（同 src/hands/builtin.ts 对内置 exec 的口径），
 * 二档的 exec 直接跑，账本里照常记 step 与结果。
 */

import { execFile } from "node:child_process";
import { isAbsolute, resolve, sep } from "node:path";
import type { TaskRow } from "../ledger/index.ts";
import { DEFAULT_EXEC_WHITELIST, normalizeProgramName } from "../gate/policy.ts";
import {
  type HandActResult,
  type HandDeps,
  type HandOutcome,
  type HandRequest,
  type HandSpec,
  runHandShell,
} from "./hand.ts";
import { PracticeError } from "./practice.ts";
import { declaredWorkspaceOf } from "./files.ts";

export const EXEC_TOOL_NAME = "exec";

export const EXEC_TOOL_DESCRIPTION =
  "在工作区里跑一条命令（跑测试、跑构建、看 git 状态）。不带 shell：不要用管道、重定向、&&；" +
  "可执行程序必须在白名单里（git/node/npm/npx/pnpm/yarn/tsc/eslint/prettier/rg/ls/cat/head/tail/pwd/echo/grep/python）。" +
  "cwd 写工作区内的相对路径。只读命令（git status/diff/log、ls、cat、grep）直接跑；会改东西的命令要人批。";

export const EXEC_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["run"], description: "固定 run，可以省略。" },
    cmd: {
      type: "string",
      description: "要跑的命令，例如 `node --test` 或 `git status --short`。不要带管道/重定向。",
    },
    cwd: { type: "string", description: "工作区内的相对路径，默认 `.`。" },
    timeout_ms: { type: "number", description: "超时毫秒，默认 120000，最多 300000。" },
  },
  required: ["cmd"],
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 6000;

interface ExecContext {
  /** 工作区绝对路径。 */
  root: string;
  /** 实际 cwd（绝对）。 */
  cwd: string;
  cwdRel: string;
}

/** 把命令拆成 argv：支持双引号与单引号包住的参数，其余按空白切。 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of cmd.trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 命令里出现这些字符就当「想用 shell 语法」，直接拒——我们没有 shell。 */
const SHELL_SYNTAX = /[|&;<>`$]|\$\(/;

/** 命令从哪个参数来：`cmd` 为主，`command` 与 `argv` 数组也认（模型各写各的）。 */
export function commandOf(req: HandRequest): string {
  const p = (req.params ?? {}) as Record<string, unknown>;
  const raw = p["cmd"] ?? p["command"];
  if (typeof raw === "string") return raw.trim();
  const argv = p["argv"];
  if (Array.isArray(argv)) return argv.map((x) => String(x)).join(" ").trim();
  return "";
}

function normalizeAction(action: unknown): string | null {
  // 只有一个动作，模型不写 action 也认（省一次来回）。
  if (action === undefined || action === null || action === "" || action === "run") return "run";
  return null;
}

function contextOf(deps: HandDeps, task: TaskRow, req: HandRequest): ExecContext {
  const root = declaredWorkspaceOf(task);
  if (root === null) {
    throw new PracticeError("workspace_missing", "任务没声明工作区（declared.workspace）：命令不知道该在哪儿跑");
  }
  const rawCwd = typeof req.params?.["cwd"] === "string" ? (req.params["cwd"] as string) : ".";
  const cwdRel = rawCwd.trim() === "" ? "." : rawCwd.trim();
  if (isAbsolute(cwdRel) || /^[A-Za-z]:/.test(cwdRel)) {
    throw new PracticeError("bad_path", `cwd 只收工作区内的相对路径，收到绝对路径：${cwdRel}`);
  }
  const rootAbs = resolve(root);
  const cwdAbs = resolve(rootAbs, cwdRel);
  if (cwdAbs !== rootAbs && !cwdAbs.startsWith(rootAbs + sep)) {
    throw new PracticeError("outside_root", `cwd 跑出工作区了：${cwdRel}`);
  }
  return { root: rootAbs, cwd: cwdAbs, cwdRel };
}

const execSpec: HandSpec<ExecContext> = {
  toolName: EXEC_TOOL_NAME,
  normalize: (req) => normalizeAction(req.action),
  badActionText: "exec 只支持 action=run",

  prepare(_deps, task, _action, req) {
    try {
      return { ok: true, ctx: contextOf(_deps, task, req) };
    } catch (err) {
      if (err instanceof PracticeError) return { ok: false, code: err.code === "workspace_missing" ? "workspace_missing" : "failed", text: err.message };
      throw err;
    }
  },

  validate(_action, req) {
    const cmd = commandOf(req);
    if (cmd === "") return { code: "bad_action", text: "exec 需要 cmd（要跑的命令），例如 {\"cmd\":\"node --test\"}" };
    if (SHELL_SYNTAX.test(cmd)) {
      // 光说「不行」模型会换个写法再撞一次。真机上它想的是 `cat x | head`、`rg y | wc -l`。
      // 所以直接给替代写法：一次只跑一条，要看头尾/数行就单独跑。
      return {
        code: "bad_action",
        text:
          `这条命令里带了 shell 语法（| & ; < > \` $）：这里不经过 shell，管道/重定向/&& 都不生效，一次只跑一条命令。` +
          `替代写法：看开头用 \`head -n 50 文件\`，看结尾用 \`tail -n 50 文件\`，数行用 \`wc -l 文件\`，` +
          `筛行用 \`rg 模式 文件\` 或 \`grep 模式 文件\`——把管道拆成几条分开跑。`,
      };
    }
    const argv = splitCommand(cmd);
    const program = normalizeProgramName(argv[0] ?? "");
    if (!DEFAULT_EXEC_WHITELIST.includes(program)) {
      return {
        code: "bad_action",
        text: `「${program || cmd}」不在允许的命令名单里。能用的是：${DEFAULT_EXEC_WHITELIST.join(" / ")}。`,
      };
    }
    return null;
  },

  gateInput(action, req, ctx) {
    const cmd = commandOf(req);
    return {
      tool: EXEC_TOOL_NAME,
      action,
      args: { command: cmd, cwd: ctx.cwdRel },
      target: ctx.cwdRel,
      reversible: false, // 由 judge 按命令本身再细分档
    };
  },

  subjectParams(_action, req, ctx) {
    return { cmd: commandOf(req), cwd: ctx.cwdRel };
  },

  snapshotTarget() {
    // 一条命令会改哪些文件执行前不可知：不拍快照（同内置 exec 的口径）。
    return null;
  },

  act(_action, req, ctx): Promise<HandActResult> {
    const cmd = commandOf(req);
    const argv = splitCommand(cmd);
    const program = argv[0] as string;
    const args = argv.slice(1);
    const rawTimeout = Number(req.params?.["timeout_ms"]);
    const timeout = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1_000, Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS),
    );

    return new Promise<HandActResult>((resolvePromise, rejectPromise) => {
      execFile(
        program,
        args,
        {
          cwd: ctx.cwd,
          timeout,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          // 环境里带上 UTF-8，免得中文输出在 Windows 上乱码
          env: { ...process.env, PYTHONIOENCODING: "utf-8", LANG: "en_US.UTF-8" },
        },
        (err, stdout, stderr) => {
          const out = String(stdout ?? "");
          const errText = String(stderr ?? "");
          const rawCode = (err as { code?: unknown } | null)?.code;
          const exitCode = typeof rawCode === "number" ? rawCode : null;
          const timedOut = err !== null && (err as { killed?: boolean }).killed === true;
          const merged = [out, errText].filter((s) => s !== "").join("\n").trim();
          const clipped =
            merged.length > MAX_OUTPUT_CHARS
              ? `${merged.slice(0, MAX_OUTPUT_CHARS)}\n…（输出太长，只留前 ${MAX_OUTPUT_CHARS} 字符）`
              : merged;

          if (err !== null) {
            // 命令跑起来了但退出码非零（测试不通过就是这种）：记账为失败步，
            // 正文把输出带上，模型下一轮能照着改。
            rejectPromise(
              new PracticeError(
                timedOut ? "timeout" : "command_failed",
                timedOut
                  ? `命令超过 ${timeout} 毫秒没结束，已中止：${cmd}`
                  : `命令退出码 ${exitCode ?? String(rawCode ?? "非零")}：${cmd}\n${clipped || "(没有输出)"}`,
              ),
            );
            return;
          }
          resolvePromise({
            data: { cmd, cwd: ctx.cwdRel, exit_code: 0, stdout: clipped },
            summary: `$ ${cmd}（在 ${ctx.cwdRel}）\n${clipped || "(没有输出)"}`,
          });
        },
      );
    });
  },

  errorCode(err) {
    return err instanceof PracticeError ? err.code : "unexpected";
  },

  approvalCard(action, req, _ctx, task) {
    const cmd = commandOf(req);
    return {
      args: { action, cmd },
      title: `跑命令：${cmd.slice(0, 60)}`,
      detail: `任务：${task.intent}\n命令：${cmd}\n这条命令可能会改文件，执行前没法逐条快照。`,
    };
  },
};

export async function runExecHand(deps: HandDeps, req: HandRequest): Promise<HandOutcome> {
  return runHandShell(deps, req, execSpec);
}
