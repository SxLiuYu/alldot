/**
 * src/gate/types.ts —— 闸门公开类型（B.9 六档判定、B.8 side_effect 三分）。
 *
 * 输入刻意做成「通用字段 + exec/桌面专用字段」：调用方（hands 的两个工具、
 * before_tool_call 钩子）把能拿到的上下文填进来。工作区写与 exec 第 2 档
 * 必须给出 inWorkspace=true 或 workspace + 目标路径，否则落「拿不准 → 4」。
 */

/** 六档。1 读、2 工作区内写、3 浏览器可逆、4 每次问、5 交人手、6 直接拒。 */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6;

/** B.8 steps.side_effect 的三值。 */
export type SideEffect = "safe" | "replayable" | "unknown";

/** 闸门处置。snapshot = 先快照再放行；ask = 提问卡；human = 交还人手；deny = 直接拒。 */
export type Handling = "allow" | "snapshot" | "ask" | "human" | "deny";

export interface GateInput {
  /** 工具名，例如 exec / read / write / desktop / logged_browser。 */
  tool: string;
  /** 动作枚举，例如 click / fill / delete / submit。 */
  action?: string;
  /** 原始参数。只取认识的键（command/program/argv/target/path/flag…），不扫正文内容。 */
  args?: unknown;
  /** exec：整条命令行，或 args.command。 */
  command?: string;
  /** exec：程序名（可带路径/扩展名），或 args.program。 */
  program?: string;
  /** exec：参数数组，或 args.argv。 */
  argv?: readonly string[];
  /** 桌面手/受保护程序判定：窗口进程名或应用名，或 args.app。 */
  app?: string;
  /** 要碰的路径或 URL，或 args.target / args.path。 */
  target?: string;
  /** 任务声明的工作区根；没有就用 inWorkspace 显式指定。 */
  workspace?: string;
  /** 已由调用方解析好的「目标在工作区内」结论，优先于路径比较。 */
  inWorkspace?: boolean;
  /** 金额与剩余预算：amount > budgetRemaining → 4 档 + 裁判出场。 */
  amount?: number;
  budgetRemaining?: number;
  /** 显式语义标记：login / password / captcha / payment / submit / delete / scope 等。 */
  flags?: readonly string[];
  /** 额外 DENY 工具名（名单外的调用方自带拒绝项）。 */
  denyTools?: readonly string[];
  /** 额外受保护程序（来自 config.desktop.human_only_apps）。 */
  protectedApps?: readonly string[];
  /** 浏览器动作是否可逆；false 视为提交类 4 档。 */
  reversible?: boolean;
}

export interface TierVerdict {
  tier: Tier;
  /** 给人看的理由，原样带进请示卡。 */
  reason: string;
  /** 稳定规则 id，供日志与测试断言。 */
  rule: string;
  handling: Handling;
  sideEffect: SideEffect;
  /** 超声明范围/超钱时记裁判出场（A.10 四出场点之一）。 */
  judgeNeeded: boolean;
  /** exec 时附带命令判定细节。 */
  exec?: ExecVerdict;
}

/** execArgVerdict 的结论。判不清时 refuseIfUnclear=true：4 档问不清就拒。 */
export interface ExecVerdict {
  program: string;
  inWhitelist: boolean;
  executableSyntax: boolean;
  /** 命中的执行性语法标记（-c / --eval / 管道 / 重定向 / && / 反引号等）。 */
  markers: string[];
  tier: 1 | 2 | 4;
  decision:
    | "allow_readonly"
    | "allow_workspace_write"
    | "ask_non_whitelist"
    | "ask_executable_syntax";
  reason: string;
  refuseIfUnclear: boolean;
  argv: string[];
}
