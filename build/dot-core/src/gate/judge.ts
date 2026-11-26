/**
 * src/gate/judge.ts —— 六档判定（方案 5.6 表 + B.9 伪码）。
 *
 * 判定顺序（在 B.9「先中先用」之上做两处必要的细化，理由写在括号里）：
 *   DENY/受保护→6；改 dot 自己的配置/账本→6（只读不拒；必须排在 git 之前，
 *   否则 `git checkout -- <dot 配置>` 能绕过去）；exec 的 git 子命令按子命令定档
 *   （5.6 档 2 的「本地 git 提交」；必须排在不可逆关键词之前，否则 commit 会被
 *   当成不可逆提交）；身份与钱→5；删除/装卸/系统/注册表/凭据→6；
 *   超范围/超钱→4+裁判；不可逆提交/电脑键鼠→4；浏览器可逆→3；exec 按
 *   execArgVerdict；工作区内写→2；只读→1；拿不准→4。
 *
 * 工作区口径（B.9「超声明范围 → 4 问＋记裁判出场」）：
 * - 证明目标在工作区内 → 2 档（写、exec 写、git 本地写）；
 * - 目标比对后在工作区外 → 4 档 out_of_scope_or_budget，judgeNeeded=true；
 * - 根本没有工作区证据（没传 inWorkspace 也没有 workspace + 目标）→ 4 档
 *   workspace_unknown，不算「超范围」，judgeNeeded=false。
 *
 * 关键词口径（见 keywords.ts）：一律按词边界匹配，且只看 labelText（工具名、
 * 动作、flags、intent 一类显式标记、命令程序名与非路径参数）；targetsOf 的路径
 * 与命令里像路径的参数另走 pathText，只给 dot_self 与身份钱用。于是 `skill.ts`、
 * `killer.txt`、`commit.md`、`token.ts`、`border.css` 不会被当成危险/不可逆动作。
 */

import { isAbsolute, resolve } from "node:path";
import { DEFAULT_EXEC_WHITELIST, classifySideEffect, isDeniedTool, isProtectedApp } from "./policy.ts";
import { execArgVerdict } from "./exec.ts";
import {
  DANGER,
  IDENTITY_MONEY,
  IRREVERSIBLE,
  READ,
  SCOPE,
  WRITE_ACTION,
  matchesWords,
} from "./keywords.ts";
import type { ExecVerdict, GateInput, TierVerdict } from "./types.ts";

function asArgsObject(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === "string" && x !== "");
  }
  return [];
}

/** 要碰的路径：显式 target 或 args 里的路径键（不扫命令正文以外的任意文本）。 */
function targetsOf(input: GateInput, args: Record<string, unknown>): string[] {
  const out = stringList(input.target);
  for (const k of ["target", "path", "file", "filePath", "destination", "dest"] as const) {
    out.push(...stringList(args[k]));
  }
  return [...new Set(out)];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function workspaceRoot(input: GateInput, args: Record<string, unknown>): string {
  if (typeof input.workspace === "string" && input.workspace !== "") return input.workspace;
  const fromArgs = args["workspace"];
  return typeof fromArgs === "string" && fromArgs !== "" ? fromArgs : "";
}

type WorkspaceStatus = "inside" | "outside" | "unknown";

/**
 * 工作区核对三分：
 * - inside：inWorkspace=true 直接采信；或 workspace 根 + 目标全在根内（相对路径按根解析）；
 * - outside：目标比对后确有落在根外的，按 B.9「超声明范围」处理；
 * - unknown：没有 inWorkspace 结论，也没有 workspace 根或目标路径，核对不了。
 */
export function workspaceStatus(
  input: GateInput,
  args: Record<string, unknown>,
  extraTargets: readonly string[] = [],
): WorkspaceStatus {
  if (input.inWorkspace === true) return "inside";
  if (input.inWorkspace === false) return "outside";
  const rootText = workspaceRoot(input, args);
  if (rootText === "") return "unknown";
  const targets = [...new Set([...targetsOf(input, args), ...extraTargets])];
  if (targets.length === 0) return "unknown";
  const root = normalizePath(resolve(rootText));
  const inside = targets.every((raw) => {
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(rootText, raw);
    const p = normalizePath(abs);
    return p === root || p.startsWith(root + "/");
  });
  return inside ? "inside" : "outside";
}

/** 兼容旧调用：只有「确定在里面」才返回 true。 */
export function insideWorkspace(input: GateInput, args: Record<string, unknown>): boolean {
  return workspaceStatus(input, args) === "inside";
}

/** 命令参数里像路径/文件名的 token：含分隔符、以 ~ 或盘符开头、或带扩展名。 */
function looksLikePath(token: string): boolean {
  const t = token.replace(/^["']|["']$/g, "");
  if (t === "") return false;
  return /[/\\]/.test(t) || /^~/.test(t) || /^[a-z]:/i.test(t) || /\.[a-z0-9_]{1,8}$/i.test(t);
}

/** 命令参数分成两路：路径/文件名走 pathText，其余（子命令、flag 值）进 labelText。 */
function splitExecArgs(exec: ExecVerdict): { label: string[]; path: string[] } {
  const label: string[] = [];
  const path: string[] = [];
  for (const raw of exec.argv) {
    const token = String(raw ?? "");
    if (token === "") continue;
    if (token.toLowerCase() === exec.program) continue;
    if (looksLikePath(token)) path.push(token);
    else label.push(token);
  }
  return { label, path };
}

/**
 * 语义字段：工具名、动作、flags、intent 一类显式标记、命令程序名与非路径参数。
 * 关键词判定只看这一路，路径不进来。
 */
function labelText(
  input: GateInput,
  args: Record<string, unknown>,
  program: string,
  execLabels: readonly string[],
): string {
  const parts: string[] = [input.tool ?? "", input.action ?? "", program];
  parts.push(...execLabels);
  if (Array.isArray(input.flags)) parts.push(...input.flags.map((x) => String(x)));
  if (Array.isArray(args["flags"])) parts.push(...(args["flags"] as unknown[]).map((x) => String(x)));
  for (const k of ["intent", "kind", "op", "operation", "type"] as const) {
    if (args[k] !== undefined && typeof args[k] !== "object") parts.push(String(args[k]));
  }
  return parts.join(" ").toLowerCase().replace(/\\/g, "/");
}

/** 路径一路：targetsOf 的目标 + 命令里像路径的参数。只给 dot_self 与身份钱用。 */
function pathText(input: GateInput, args: Record<string, unknown>, execPaths: string[]): string {
  return [...targetsOf(input, args), ...execPaths].join(" ").toLowerCase().replace(/\\/g, "/");
}

/**
 * 这次动作是不是只读：exec 看 exec.tier===1（cat/ls/git status 一类），
 * 其他工具看动作词。只读放行是 5.6 档 1，dot 自己的配置与账本也不例外
 * （方案 :668 的「拒读 ~/.dsh/bot/ 与账本 db」原文是「这条本次没加，需要你点头」，
 * 没点头就不拒读）。
 */
function isReadOnlyAction(isExecTool: boolean, exec: ExecVerdict, labels: string): boolean {
  if (isExecTool) return exec.tier === 1;
  return !matchesWords(labels, WRITE_ACTION) && matchesWords(labels, READ);
}

/** 改这套系统自己：dot 的配置、账本、桥/插件/口闸文件，直接 6 档（5.6 档 6、B.9 第 3 条）。 */
const DOT_SELF_PATH_RE = /(?:^|\/)\.allbot\/dot\/|(?:^|\/)\.allbot\/allbot\.json$|(?:^|\/)\.dsh\/(?:plugins\/dot-|bot\/dot-guard\.jsonl$)/i;
/**
 * 只认「配置/账本」这类词，不认 dot-core：5.6 档 6 的范围是「改这套系统自己的配置
 * 和账本」，源码不在这条里（源码改动由快照与合并前复核兜）。英文段带词边界。
 */
const DOT_SELF_TEXT_RE = /(?<![a-z0-9])dot[ _-]?(?:config|ledger|guard|db)(?![a-z0-9])|改 ?dot|改这套系统/i;

/** 本地 git 子命令：5.6 档 2（工作区内写 / 本地 git 提交）＋快照。 */
const GIT_LOCAL_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "tag",
  "checkout",
  "switch",
  "branch",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "restore",
  "reset",
  "clean",
  "init",
  "apply",
  "mv",
]);

/** 走远端的 git 子命令：5.6 没给它定档，落 4 档并在返回里注明。 */
const GIT_REMOTE_SUBCOMMANDS = new Set(["push"]);

/** git 子命令 = 程序名之后第一个不以 - 开头的参数。 */
function gitSubcommand(exec: ExecVerdict): string {
  const arg = exec.argv.find((t) => !t.startsWith("-") && t.toLowerCase() !== exec.program);
  return (arg ?? "").toLowerCase();
}

/**
 * 会丢本地工作、且快照兜不住的 git 子命令：快照能还原文件内容，还原不了 git 引用
 * （被 reset 掉的提交、被删的分支、被 drop 的 stash、被 clean 掉的未跟踪文件）。
 * 这些落 4 档每次问，不跟「本地提交」一起按 2 档自动放行。
 */
function gitDestructive(sub: string, argv: readonly string[]): boolean {
  const tokens = argv.map((t) => t.toLowerCase()).filter((t) => t !== "git");
  if (sub === "reset" || sub === "clean") return true;
  if (sub === "branch" || sub === "tag") return tokens.some((t) => t === "-d" || t === "--delete");
  if (sub === "stash") return tokens.some((t) => t === "drop" || t === "clear");
  return false;
}

function v(
  tier: TierVerdict["tier"],
  rule: string,
  reason: string,
  handling: TierVerdict["handling"],
  sideEffect: TierVerdict["sideEffect"],
  judgeNeeded = false,
  exec?: ExecVerdict,
): TierVerdict {
  return { tier, rule, reason, handling, sideEffect, judgeNeeded, ...(exec ? { exec } : {}) };
}

/**
 * 需要第 2 档放行但工作区不成立时的结论；工作区确实在里面就返回 undefined，
 * 由调用方继续走 2 档。
 */
function scopeOrUnknown(
  input: GateInput,
  args: Record<string, unknown>,
  what: string,
  exec?: ExecVerdict,
  extraTargets: readonly string[] = [],
): TierVerdict | undefined {
  const status = workspaceStatus(input, args, extraTargets);
  if (status === "inside") return undefined;
  if (status === "outside") {
    return v(
      4,
      "out_of_scope_or_budget",
      `${what}的目标落在声明工作区之外，按超范围处理：每次问并记裁判出场`,
      "ask",
      "unknown",
      true,
      exec,
    );
  }
  return v(
    4,
    "workspace_unknown",
    `${what}的第 2 档放行要能确认工作区：请传 inWorkspace=true 或 workspace + 目标路径`,
    "ask",
    "unknown",
    false,
    exec,
  );
}

/**
 * exec 的 git 命令先判（B.9 的 exec 条）。只在程序是白名单里的 git、参数不带
 * 执行性语法时生效；其余情况返回 undefined，交给后面的通用链条
 * （`git commit && rm -rf x` 会落 6 档，`git -c core.pager=x commit` 会落 4 档）。
 * 调用前 dot_self 已经先判过，所以 `git checkout -- <dot 配置>` 到不了这里。
 */
function gitVerdict(
  input: GateInput,
  args: Record<string, unknown>,
  exec: ExecVerdict,
  execPaths: readonly string[],
): TierVerdict | undefined {
  if (exec.program !== "git" || !exec.inWhitelist || exec.executableSyntax) return undefined;
  const sub = gitSubcommand(exec);

  if (GIT_REMOTE_SUBCOMMANDS.has(sub)) {
    const scope = scopeOrUnknown(input, args, `git ${sub}`, exec, execPaths);
    if (scope !== undefined) return scope;
    return v(
      4,
      "git_push",
      `git ${sub} 走远端，方案 5.6 的六档表没给 push 定档；暂按不可逆提交每次问（这一档待拍板）`,
      "ask",
      "unknown",
      false,
      exec,
    );
  }
  if (!GIT_LOCAL_SUBCOMMANDS.has(sub)) return undefined;

  const scope = scopeOrUnknown(input, args, `git ${sub}`, exec, execPaths);
  if (scope !== undefined) return scope;

  if (gitDestructive(sub, exec.argv)) {
    return v(
      4,
      "git_destructive",
      `git ${sub} 会丢本地工作，快照兜不住 git 引用与 stash；每次问，问不清拒`,
      "ask",
      "unknown",
      false,
      exec,
    );
  }
  return v(
    2,
    "git_local",
    `git ${sub} 是本地 git 操作（提交/打 tag/暂存/切分支/合并一类），按 5.6 档 2 放行，先快照`,
    "snapshot",
    "replayable",
    false,
    exec,
  );
}

/**
 * judgeTier(input)：返回档位、理由、规则 id、处置、side_effect。
 * 同一动作不同参数会落到不同档（例如 exec 的 git status=1、git commit=2、
 * node build.js=2、python -c=4、rm -rf=6），这是刻意行为。
 */
export function judgeTier(input: GateInput): TierVerdict {
  const args = asArgsObject(input.args);
  const tool = String(input.tool ?? "").toLowerCase();
  const action = String(input.action ?? "").toLowerCase();
  const isExecTool = tool === "exec" || tool === "terminal" || tool === "shell" || action === "exec";

  // exec 字段先取出来：正文也要过 B.9 前几条（git 本地写→2、身份钱→5、危险→6），
  // 受保护程序也要从 program 认，不能等走到命令判定才看。
  const command = [input.command, args["command"], args["cmd"]].find(
    (x) => typeof x === "string" && x !== "",
  ) as string | undefined;
  const program = [input.program, args["program"], args["executable"]].find(
    (x) => typeof x === "string" && x !== "",
  ) as string | undefined;
  const argvInput = [input.argv, args["argv"]].find((x) => Array.isArray(x)) as readonly string[] | undefined;
  const givenName = program ?? (command !== undefined ? undefined : String(args["program"] ?? ""));
  const exec: ExecVerdict = execArgVerdict(givenName ?? "", command ?? (argvInput ?? []), {
    whitelist: DEFAULT_EXEC_WHITELIST,
  });

  const execArgs = splitExecArgs(exec);
  const labels = labelText(input, args, exec.program, execArgs.label);
  const paths = pathText(input, args, execArgs.path);

  // 0) DENY 名单。配置外新出现的工具默认在拒的范围（B.1 白名单口径）。
  if (isDeniedTool(tool, input.denyTools ?? [])) {
    return v(6, "deny_tool", `工具 ${tool} 在 DENY 名单，直接拒且记账`, "deny", "unknown");
  }

  // 0b) 受保护程序：窗口名或 exec 的 program 命中都 6 档（5.6、B.1 的 human_only_apps）。
  const appNames = [
    input.app,
    args["app"],
    args["process"],
    args["window"],
    args["appName"],
    input.program,
    args["program"],
    args["executable"],
    exec.program,
  ].filter((x): x is string => typeof x === "string" && x !== "");
  const protectedName = appNames.find((name) => isProtectedApp(name, input.protectedApps ?? []));
  if (protectedName !== undefined) {
    return v(6, "protected_app", `受保护程序 ${protectedName} 不许碰，直接拒`, "deny", "unknown");
  }

  const readOnly = isReadOnlyAction(isExecTool, exec, labels);

  // 1) 改 dot 自己的配置/账本/口闸文件：直接拒，连问都不问。只读放行（5.6 档 1）。
  //    这一条必须排在 git 之前：否则 git checkout --/restore/add <dot 配置> 会按
  //    「本地 git 操作」2 档放行，等于绕开对 dot 自己的保护。
  if (!readOnly && (DOT_SELF_PATH_RE.test(paths) || DOT_SELF_TEXT_RE.test(labels))) {
    return v(6, "dot_self", "改这套系统自己的配置、账本或口闸文件，直接拒且记账", "deny", "unknown");
  }

  // 2) exec 的 git 子命令：5.6 档 2，必须排在不可逆关键词之前。
  if (isExecTool) {
    const git = gitVerdict(input, args, exec, execArgs.path);
    if (git !== undefined) return git;
  }

  // 3) 身份与钱：交还人手，不问（6.3「花钱永远在第 5 档交人」）。
  //    这一条也看路径：read_password.py、login.py 这类文件名本身就是身份动作的证据。
  if (matchesWords(labels, IDENTITY_MONEY) || matchesWords(paths, IDENTITY_MONEY)) {
    return v(5, "identity_money", "涉及登录/密码/支付/验证码/生物验证，交还人手，任务停下等人说继续", "human", "unknown");
  }

  // 4) 删除/装卸/系统/注册表/凭据：直接拒（含 exec 正文里的 rm -rf、del /f）。
  if (matchesWords(labels, DANGER)) {
    return v(6, "dangerous", "删除/装卸/系统/注册表/凭据类动作，直接拒且记账", "deny", "unknown");
  }

  // 5) 超声明范围或超钱：问 + 记裁判出场。
  const overBudget =
    typeof input.amount === "number" &&
    typeof input.budgetRemaining === "number" &&
    input.amount > input.budgetRemaining;
  if (input.inWorkspace === false || overBudget || matchesWords(labels, SCOPE)) {
    return v(4, "out_of_scope_or_budget", "超出声明工作区或预算，每次问并记裁判出场", "ask", "unknown", true);
  }

  // 6) 不可逆提交 / 电脑键鼠：每次问。
  if (tool === "desktop" || tool === "computer" || matchesWords(labels, IRREVERSIBLE)) {
    return v(4, "irreversible", "不可逆提交或电脑上点鼠标键盘，按程序+一段操作每次问", "ask", "unknown");
  }

  // 7) 浏览器可逆：放行并记账，已登录浏览器另拿单例锁（由 hands 做）。
  if (tool === "logged_browser" || tool === "browser") {
    if (input.reversible === false) {
      return v(4, "browser_submit", "浏览器动作不可逆（提交类），每次问", "ask", "unknown");
    }
    return v(3, "browser_reversible", "浏览器可逆操作，放行记账；已登录浏览器需单例锁", "allow", "replayable");
  }

  // 8) 命令（exec）：前面的正文判定已经先中先用；这里只看白名单、执行性语法与工作区。
  if (isExecTool) {
    if (exec.tier === 4) {
      return v(4, exec.decision, `${exec.reason}；判不清就拒`, "ask", "unknown", false, exec);
    }
    // 只读命令无需工作区证据；第 2 档（写）才要能确认工作区。
    if (exec.tier === 1) return v(1, "exec_readonly", exec.reason, "allow", "safe", false, exec);
    const scope = scopeOrUnknown(input, args, "命令", exec, execArgs.path);
    if (scope !== undefined) return scope;
    return v(2, "exec_workspace_write", exec.reason, "snapshot", "replayable", false, exec);
  }

  // 9) 其他工作区内写：同样要有工作区证据；证明在外按超范围，核对不了按拿不准。
  if (matchesWords(labels, WRITE_ACTION)) {
    const scope = scopeOrUnknown(input, args, "写动作");
    if (scope !== undefined) return scope;
    return v(2, "workspace_write", "任务声明的工作区内写，先快照再放行", "snapshot", "replayable");
  }

  // 10) 只读。
  if (matchesWords(labels, READ)) {
    return v(1, "read", "只读动作，放行记账", "allow", "safe");
  }

  // 11) 拿不准 → 4（B.9 最后一条）。
  return v(4, "unclear", "判不清动作性质，按第 4 档问；问不清拒", "ask", "unknown", true);
}

export { classifySideEffect };
