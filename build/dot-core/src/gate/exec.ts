/**
 * src/gate/exec.ts —— 命令判定（方案 6.3 / B.9）。
 *
 * 核心口径（B.9 原文）：「程序名在白名单但参数含执行性语法（-c、--eval、
 * -Command、管道、重定向、&&、反引号等）→ 4 问，问不清拒（白名单程序名
 * 不等于安全：python -c 就是任意执行）」。
 * 解析不是安全边界（R10），判不清一律 4 档并带 refuseIfUnclear=true。
 */

import { DEFAULT_EXEC_WHITELIST, normalizeProgramName } from "./policy.ts";
import type { ExecVerdict } from "./types.ts";

/** 由调用方覆盖白名单时的入参。 */
export interface ExecOptions {
  whitelist?: readonly string[];
  /** 默认名单见 policy.DEFAULT_EXEC_WHITELIST。 */
  defaultWhitelist?: readonly string[];
}

/** 单纯用名字查白名单，供 judgeTier 复用。 */
export function isWhitelistedProgram(program: string, options: ExecOptions = {}): boolean {
  const list = options.whitelist ?? options.defaultWhitelist ?? DEFAULT_EXEC_WHITELIST;
  const norm = normalizeProgramName(program);
  return norm !== "" && list.some((item) => normalizeProgramName(item) === norm);
}

/**
 * 极简命令行分词：只用于识别程序名与参数形态，不用于执行。
 * 引号内的空白不拆；shell 元字符（|、&&、;、反引号、重定向）在扫描时记录，
 * 不尝试解释其语义——判不清就 4 档。
 */
export function tokenizeCommand(command: string): { tokens: string[]; markers: string[] } {
  const markers: string[] = [];
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let pendingDollar = false;

  const push = (): void => {
    if (cur !== "") {
      tokens.push(cur);
      cur = "";
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;

    if (pendingDollar) {
      pendingDollar = false;
      if (c === "(" || c === "{") {
        markers.push(c === "(" ? "$()" : "${}");
        // 括号内容一并收进当前 token，避免把里面的程序名当命令名。
        cur += "$" + c;
        continue;
      }
      cur += "$" + c;
      continue;
    }
    if (c === "$") {
      pendingDollar = true;
      continue;
    }

    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else {
        if (c === "`") markers.push("backtick");
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "`") {
      markers.push("backtick");
      cur += c;
      continue;
    }
    if (c === "|") {
      markers.push(command[i + 1] === "|" ? "||" : "|");
      if (command[i + 1] === "|") i += 1;
      push();
      continue;
    }
    if (c === "&") {
      if (command[i + 1] === "&") {
        markers.push("&&");
        i += 1;
      } else {
        markers.push("&");
      }
      push();
      continue;
    }
    if (c === ";") {
      markers.push(";");
      push();
      continue;
    }
    if (c === ">" || c === "<") {
      markers.push(c === ">" ? ">" : "<");
      if (command[i + 1] === c || (c === ">" && command[i + 1] === "|")) i += 1;
      push();
      continue;
    }
    if (c === "\n" || c === "\r") {
      markers.push("newline");
      push();
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return { tokens, markers };
}

/** 只读程序/子命令：B.9「只读 → 1」。 */
const READONLY_PROGRAMS = new Set(["cat", "ls", "rg", "grep", "find", "pwd", "echo", "head", "tail", "wc"]);
const GIT_READONLY_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "ls-files", "branch", "remote", "rev-parse"]);

/** 参数形态判定：-c / --eval / -e / -Command 等等于任意执行。 */
export function executableArgMarkers(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of argv) {
    const v = String(raw ?? "");
    // 去掉引号和前导横线，抓住 python -c、-e、node --eval、pwsh -Command 这些写法。
    const bare = v.replace(/^["']|["']$/g, "").replace(/^[-/]+/, "").toLowerCase();
    if (/^(c|command|eval|e|exec|execute|p|profile)$/.test(bare)) {
      // 保留调用方写法（-c / -Command / --eval），请示卡原文照用。
      const clean = v.replace(/^["']|["']$/g, "");
      out.push(clean.startsWith("--") ? `--${clean.slice(2)}` : clean.startsWith("-") ? clean : `-${clean}`);
      continue;
    }
    if (/^-+(eval|command|exec|execute|inline|script)/.test(v.toLowerCase())) {
      out.push(v);
    }
  }
  return [...new Set(out)];
}

/**
 * execArgVerdict(program, args)：参数可以是 argv 数组，也可以是整条命令行。
 * 调用方传进来的第二个参数可能为数组或字符串；工具用途内部再包一层对象。
 */
export function execArgVerdict(
  programInput: string,
  args: readonly string[] | string | unknown = [],
  options: ExecOptions = {},
): ExecVerdict {
  let command = "";
  let argv: string[] = [];
  let program = String(programInput ?? "").trim();

  if (typeof args === "string") {
    command = args;
  } else if (Array.isArray(args)) {
    argv = args.map((x) => String(x));
  } else if (args !== null && typeof args === "object") {
    const obj = args as Record<string, unknown>;
    if (typeof obj["command"] === "string") command = obj["command"];
    if (Array.isArray(obj["argv"])) argv = (obj["argv"] as unknown[]).map((x) => String(x));
    if (typeof obj["args"] === "string") argv.push(obj["args"]);
  }

  let markers: string[] = [];
  if (command !== "") {
    const parsed = tokenizeCommand(command);
    markers = parsed.markers;
    if (program === "" && parsed.tokens.length > 0) program = parsed.tokens[0] as string;
    argv = [...argv, ...parsed.tokens.slice(program === (parsed.tokens[0] as string) && program !== "" ? 1 : 0)];
  }
  const execMarkers = executableArgMarkers(argv);
  markers = [...markers, ...execMarkers];

  const inWhitelist = isWhitelistedProgram(program, options);
  const executableSyntax = markers.length > 0;
  const norm = normalizeProgramName(program);
  const refuseIfUnclear = executableSyntax || !inWhitelist;

  let tier: 1 | 2 | 4 = 4;
  let decision: ExecVerdict["decision"] = "ask_non_whitelist";
  let reason = "";

  if (executableSyntax) {
    tier = 4;
    decision = "ask_executable_syntax";
    reason = `命令含执行性语法（${markers.join(", ")}），白名单程序名也不等于安全，问不清就拒`;
  } else if (!inWhitelist) {
    tier = 4;
    decision = "ask_non_whitelist";
    reason = `程序 ${norm || "(空)"} 不在命令白名单，每次问`;
  } else if (
    READONLY_PROGRAMS.has(norm) ||
    (norm === "git" && argv.some((a) => GIT_READONLY_SUBCOMMANDS.has(a.toLowerCase()))) ||
    argv.some((a) => a === "-h" || a === "--help" || a === "--version" || a === "-v")
  ) {
    tier = 1;
    decision = "allow_readonly";
    reason = `程序 ${norm} 在白名单且为只读查询（帮助/版本/git status 一类），放行并记账`;
  } else {
    tier = 2;
    decision = "allow_workspace_write";
    reason = `程序 ${norm} 在白名单且参数无执行性语法，按工作区内写放行（先快照）`;
  }

  return {
    program: norm,
    inWhitelist,
    executableSyntax,
    markers: [...new Set(markers)],
    tier,
    decision,
    reason,
    refuseIfUnclear,
    argv,
  };
}
