/**
 * src/dispatch/local-worker.ts —— 本机工人：不靠宿主运行时，自己带着模型循环干活。
 *
 * 为什么不让宿主起工人会话（2026-11-25 真机实测，两条都堵死）：
 *   1) `api.runtime` 取 `.subagent` 抛「Unable to resolve plugin runtime module」——
 *      这套安装的插件运行时模块解析不到（官方 feishu 通道报同一个错）；
 *   2) 退一步自己连网关 WS 也不成：共享令牌连上来是**没有权限**的
 *      （allbot 自己的测试名就叫「operator + valid shared token => connected with cleared scopes」，
 *      带 `agent` 方法会回 `missing scope: operator.write`）。
 *
 * 所以工人由派发器自己带：一个循环 = 调模型（OpenAI 兼容）→ 解析 tool_calls →
 * 用我们自己的手执行（练习手/电脑手/浏览器手）→ 把结果喂回模型 → 直到模型不再要工具。
 * 这样不依赖宿主的运行时、钩子、WS 权限，闸门与记账仍然走 src/gate hands 那套。
 *
 * 对外形状刻意与 `PluginRuntimeLike["subagent"]` 一致（run + waitForRun），
 * 于是 scheduler 一行都不用改：把 subagent 换成这个就行。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTask, getTask, listOpenApprovals, revokeApproval, setTaskState, type LedgerDb, type StepRow, type TaskRow } from "../ledger/index.ts";
import { beginStep, computeSubjectKey, endStep, putArtifact, getArtifact, listSteps } from "../ledger/index.ts";
import { parseContract, nextDeliverable } from "../plan/contract.ts";
import { autoPlan } from "../plan/auto-plan.ts";
import type { DotCoreConfig } from "../config.ts";
import { buildInjection, executeRecallTool, RECALL_TIER, RECALL_TOOL_DEFINITION, RECALL_TOOL_NAME } from "../context/index.ts";
import { executeSkillbook, SKILLBOOK_TOOL_DEFINITION, SKILLBOOK_TOOL_NAME } from "../skills/index.ts";
import { runPracticeHand, type HandDeps, type HandOutcome } from "../hands/hand.ts";
import type { HandToolSpec } from "../hands/hand-tool.ts";

/**
 * delegate：把一块独立的活交给另一个工人（子任务）。
 *
 * 为什么要有：合并方案里写的是「子助手（写代码）：allbot subagent，父会话是工人」
 * （dot-合并方案-v2-定稿.md 第 675 行）。这套安装里 allbot 的 subagent 运行时解析不到
 * （见文件头第 1 条），所以这一层得自己给：子任务就是账本里一条 parent_id 指向父任务的
 * 任务，跑在独立的上下文里，父工人拿到它的结论再往下走。
 *
 * 边界（刻意收窄，先跑通一层）：
 * - 只到一层，子任务里没有 delegate（防止一个任务无限繁殖）；
 * - 子任务步数上限比父任务小（DELEGATE_MAX_STEPS），花超了照样收；
 * - 子任务的步骤记在它自己的任务号下，账本里父子关系一眼能查。
 */
export const DELEGATE_TOOL_NAME = "delegate";
/** 子任务最多几步。它只该做一小块边界清楚的活。 */
export const DELEGATE_MAX_STEPS = 15;
export const DELEGATE_TOOL_DECL = {
  type: "function",
  function: {
    name: DELEGATE_TOOL_NAME,
    description:
      "把一块边界清楚的活交给另一个工人（独立上下文、独立账本步骤），等它做完再给你一句话结论。" +
      "适合「改一个文件并跑一次测试」「查清某个接口在哪定义」这种能独立验收的小块。" +
      "brief 要写清：做什么、做完怎么算成、在哪做。子任务里不能再派子任务。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["brief"],
      properties: {
        brief: { type: "string", description: "交给子任务的话：做什么、做完怎么算成（要给判据）" },
        workspace: { type: "string", description: "子任务的工作区（相对路径或绝对路径），不填就沿用父任务的" },
      },
    },
  },
} as const;

export const DEFAULT_MODEL_ENDPOINT = "http://127.0.0.1:3065/v1";
export const DEFAULT_MODEL = "deepseek-v4.1-flash";
/**
 * 一个任务最多几步工具调用。到顶就收，不无限转。
 * 2026-11-27 从 12 提到 40：真机账本里 4 个任务全是「到 12 步还没收工」判失败，
 * 而它们要做的（读几个文件、改多处代码、跑一次测试）12 步必然不够。
 * 真正防打转的是 REPEAT_LIMIT 和会话超时，不是这个粗上限。
 */
/**
 * 任务档位 → 模型（2026-11-27 加）。
 *
 * 账本里每个任务都记着 cheap/balanced/strong，但此前代码从来不看——工人永远用
 * DEFAULT_MODEL（deepseek-v4.1-flash），读代码、改多处这类活 30 多步全在试错。
 *
 * 原计划：strong 用阿里云的 qwen3-coder-plus。2026-11-27 实测该 key 返回
 * 401 invalid_api_key（token 失效），所以暂时回落到本地池里唯一另一个模型。
 * 阿里云 key 换新之后，把 strong 那一行改成 qwen3-coder-plus 即可。
 */
export const PROFILE_MODELS: Record<string, string> = {
  cheap: DEFAULT_MODEL,
  balanced: DEFAULT_MODEL,
  strong: "glm-5.3-flash",
};
export const DEFAULT_MAX_STEPS = 40;
/** 同一个调用重复到第几次就判定「原地打转」并停下。 */
export const REPEAT_LIMIT = 4;

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

/** OpenAI 兼容的会话消息。assistant 那条必须把 tool_calls 原样带回去，否则模型不知道自己调过工具。 */
export interface WorkerMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface ModelTurn {
  /** 模型说的话（可能为空）。 */
  text: string;
  /** 模型要调的工具。空数组 = 它认为做完了。 */
  toolCalls: ToolCallRequest[];
  /** 这一轮的 token 用量（模型池给了才有）；用来记 spend，预算触发据此判八成。 */
  usage?: ModelUsage;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * 模型池调用失败的分类。调用方按 kind 判别，不猜字符串（D 节）。
 * 工人侧只读 message，行为不变；只回答通道（src/reply/index.ts）按 kind 映射错误码。
 */
export type ModelPoolErrorKind = "config" | "unreachable" | "http" | "timeout" | "invalid";

export class ModelPoolError extends Error {
  readonly kind: ModelPoolErrorKind;
  readonly status: number | null;

  constructor(kind: ModelPoolErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ModelPoolError";
    this.kind = kind;
    this.status = status;
  }
}

/** 模型调用：注入用（测试给假的），真实现在本文件底部。 */
export type ModelComplete = (input: {
  messages: WorkerMessage[];
  tools: unknown[];
}) => Promise<ModelTurn>;

export interface LocalWorkerDeps {
  db: LedgerDb;
  config: DotCoreConfig;
  /** 工人用的模型。 */
  model?: string;
  /** 注入的模型调用；不给就用本机模型池。 */
  complete?: ModelComplete;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  /**
   * 手上能用的工具；默认只有练习手。
   * `identity` 要给：四只手都走「先取身份、再判任务」那七步（src/hands/hand.ts:resolveIdentity），
   * 身份表在、而这次 toolCallId 没登记过 = 一律 refusal("identity_missing")。
   * 2026-11-25 真机就是这么失败的：工人在 step 1 调 clean_browser，回 identity_missing，
   * 模型换了个说法再试一次，第三次干脆说「需要你确认一下」，账本上只有 no_steps。
   * 工人在执行每一次调用前把身份补登记进去（见 runLoop 里的 remember），
   * 语义与宿主会话一致：一次调用只能用一次，参数里的 task_id 也改不了归属。
   */
  handDeps?: Pick<HandDeps, "judge" | "notify" | "snapshotsRoot" | "now" | "identity" | "liveSettings">;
  /** 除练习手之外的手（desktop / logged_browser / clean_browser），按名字分派。 */
  extraHands?: HandToolSpec[];
  /** true = 把 dot_recall（按编号取回）挂进工具表。默认不挂，测试与老调用方不受影响。 */
  enableRecall?: boolean;
  /** 技能库索引路径（~/.allbot/dot/skills/index.json）。给了就把 skillbook 这条工具挂上。 */
  skillIndexPath?: string;
  /**
   * 每轮模型调用的 token 用量（模型池给了 usage 才有）。
   * 接线在 index.ts：写 spend_ledger，预算八成的触发点据此有分子。
   */
  onUsage?: (input: { taskId: string; model: string; usage: ModelUsage }) => void;
  maxSteps?: number;
}

interface LocalRun {
  promise: Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
}

/** 练习手的工具声明，喂给模型。 */
export const PRACTICE_TOOL_DECL = {
  type: "function",
  function: {
    name: "practice",
    description:
      "在练习文件夹里做事：列目录(list)、读文件(read)、建文件夹(mkdir)、写文本文件(write)。路径必须相对练习文件夹根。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "mkdir", "write"], description: "要做的事" },
        path: { type: "string", description: "相对练习文件夹根的路径" },
        content: { type: "string", description: "write 时的文本内容" },
        overwrite: { type: "boolean", description: "write 时是否覆盖已有文件" },
      },
      required: ["action"],
    },
  },
} as const;

/** dot_recall 的工具声明：与插件工具同一个 schema（src/context/recall-tool.ts）。 */
export const RECALL_TOOL_DECL = {
  type: "function",
  function: {
    name: RECALL_TOOL_DEFINITION.name,
    description: RECALL_TOOL_DEFINITION.description,
    parameters: RECALL_TOOL_DEFINITION.parameters,
  },
} as const;

/** 每一步写进提示词时最多留多少字。12 步 × 90 字，约 1 千字，够模型认路又不撑爆。 */
const STEP_BRIEF_CHARS = 90;
/** 只带最后这么多步。更早的看里程碑小结。 */
const RECENT_STEPS_IN_PROMPT = 12;

function readJsonArtifact(db: LedgerDb, ref: string | null): Record<string, unknown> | null {
  if (ref === null) return null;
  try {
    const art = getArtifact(db, ref);
    if (!art.found || art.content == null) return null;
    const parsed = JSON.parse(String(art.content)) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(from: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (from == null) return "";
  for (const key of keys) {
    const value = from[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().replace(/\s+/g, " ");
  }
  return "";
}

/** 一步干了什么：命令 / 路径 / 动作，失败再带上错误开头。 */
function stepBrief(db: LedgerDb, step: StepRow): string {
  const args = readJsonArtifact(db, step.args_ref);
  const res = readJsonArtifact(db, step.result_ref);
  const data = res === null ? null : (res["data"] as Record<string, unknown> | undefined) ?? null;
  const nested = args === null ? null : (args["params"] ?? args["args"]) as Record<string, unknown> | undefined;
  const action = firstString(args, ["action"]);
  const subject =
    firstString(data, ["cmd", "command"]) ||
    firstString(nested ?? null, ["cmd", "command", "path", "query", "url", "name"]) ||
    firstString(args, ["cmd", "command", "path"]);
  const out = firstString(data, ["stdout"]).slice(0, STEP_BRIEF_CHARS);
  const bits: string[] = [];
  if (action !== "" && subject !== "") bits.push(`${action} ${subject}`);
  else if (subject !== "") bits.push(subject);
  else if (action !== "") bits.push(action);
  if (out !== "") bits.push(`→ ${out}`);
  if (step.status !== "succeeded" && step.error !== null) bits.push(`✗ ${String(step.error).slice(0, 60)}`);
  return bits.join(" ").slice(0, STEP_BRIEF_CHARS * 2);
}

/**
 * 前面几轮做过的事。
 *
 * 为什么要有：批一张请示卡、或者进程崩过一次，任务都会**新开一轮**——模型手里的对话是空的，
 * 上一轮读过的文件、跑过的命令全忘了。2026-11-27 真机上就是这么白烧的：一个查代码的任务
 * 54 步全在读文件，批一次测试请示卡之后从第 1 步重新摸一遍。
 * 把最后几步的摘要喂回去，agent 才能接上，而不是重头再来。
 */
export function recentWorkText(db: LedgerDb, taskId: string): string {
  let steps: StepRow[] = [];
  try {
    steps = listSteps(db, taskId);
  } catch {
    return "";
  }
  if (steps.length === 0) return "";
  const tail = steps.slice(-RECENT_STEPS_IN_PROMPT);
  const lines = [
    `这个任务前面已经做了 ${steps.length} 步，最近 ${tail.length} 步是（已经成功过的别重做，接着往下做）：`,
  ];
  for (const s of tail) {
    const brief = stepBrief(db, s);
    lines.push(`  ${s.seq}. ${s.tool ?? s.kind} ${s.status}${brief === "" ? "" : `：${brief}`}`);
  }
  return lines.join("\n");
}

export function systemPrompt(db: LedgerDb, task: TaskRow, toolNames: string[]): string {
  let context = "";
  try {
    // 锚点 + 已结束里程碑的小结（src/context/inject.ts）。以前只放锚点，
    // 小结写进账本也没人读——这是「阶段小结」真正的消费点。
    context = buildInjection(db, { taskId: task.id }).text;
  } catch {
    context = ""; // 上下文拼不出来不耽误干活，但会少一句上下文
  }
  const recallHint =
    toolNames.includes(RECALL_TOOL_NAME)
      ? "7) 看到步骤号（step_…）、明细哈希、或快照 id（snap_…）想看全文，用 dot_recall 按编号取；别自己猜内容。"
      : "";
  // 技能库：584 条做法说明。只在真需要「怎么做」时提示，别让模型每步都先去查。
  const skillHint = toolNames.includes(SKILLBOOK_TOOL_NAME)
    ? "8) 这活像是别人已经总结过的做法（写文档、做图、发邮件、部署、数据分析之类）时，" +
      "先用 skillbook search 用**英文关键词**查一条，再 skillbook read 读正文照着做；" +
      "技能里的命令这台机器跑不了，只借做法。"
    : "";
  // 子工人（delegate）：只给父工人这一条。子工人自己的工具表里没有它，所以提示词里也不会出现。
  const delegateHint = toolNames.includes(DELEGATE_TOOL_NAME)
    ? "9) 有一块活边界清楚、能独立验收（例如「把某个文件改好并跑一遍它的测试」）时，用 delegate 交给子工人；" +
      "brief 写清做什么、做完怎么算成。子工人看不到你和用户的对话，别让它猜上下文。" +
      "子任务的结论会以一句话回到你这里，你再决定下一步。"
    : "";
  // 当前时间直接写进提示词：不然模型会为了「今天是几号」去开浏览器跑 new Date()（真机见过）。
  const nowText = new Date().toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  // 任务契约（DesignAnything 的 task contract）：约束和交付物清单。
  let contractText = "";
  try {
    const contract = parseContract(task);
    if (contract !== null) {
      const lines: string[] = ["任务契约（约束和交付物）："];
      if (contract.goal !== "") lines.push(`目标：${contract.goal}`);
      for (const c of contract.constraints) {
        lines.push(`  约束[${c.severity}] ${c.id}：${c.description}（检查方式：${c.check}）`);
      }
      for (const d of contract.deliverables) {
        const extra =
          d.type === "check"
            ? `，必须用 exec 跑${d.cmd !== undefined && d.cmd !== "" ? `「${d.cmd}」` : "命令"}并且退出码 0${
                d.match !== undefined && d.match !== "" ? `，输出要匹配 /${d.match}/` : ""
              }`
            : "";
        lines.push(`  交付物 ${d.id}：${d.description}（类型：${d.type}，完成条件：${d.done_when}${extra}）`);
      }
      const next = nextDeliverable(db, task.id);
      if (next !== null) lines.push(`下一步：${next.guidance}`);
      contractText = lines.join("\n");
    }
  } catch {
    contractText = ""; // 契约解析失败不耽误干活
  }

  return [
    "你是 dot 的工人，只做当前这一个任务。规矩：",
    `0) 现在是 ${nowText}（北京时间）。要算日期时间就按这个算，别为了问日期去开浏览器或桌面。`,
    `1) 只能用给你的工具（${toolNames.join(" / ")}）；没有工具能干的事，就在最后一句话里说清为什么干不了。`,
    "2) 每要调一次工具就只调一个，等结果回来再决定下一步。",
    "3) 觉得做完了就不要再调工具，直接用一句话说结果（做成了什么、放在哪里）。",
    "4) 不许编造结果：没做过的不要说做过。",
    "5) 按任务挑对手，不要一律用 practice：",
    "   · 打开网页、搜索、看页面内容、点网页上的按钮、填表单、截图 → clean_browser（不需要登录）或 logged_browser（要你已经登录的网站）",
    "   · 点桌面上别的程序、往别的程序里打字、看窗口 → desktop",
    "   · 读微信消息、按名字找会话、发微信 → wechat（发消息会出请示卡）",
    "   · 看飞书日历/日程、建日程、取消日程 → feishu（建和取消都会出请示卡）",
    "   · 在真实位置（桌面 / 文档 / 下载 / 图片 / 任务里点名的路径）建目录、写文件、读文件 → files，path 写名字就行",
    "   · 只往练习文件夹里放东西 → practice",
    "   · 任务是真实位置（桌面/文档/下载/图片）的活时，不许用 practice 假装做完：往练习夹里建等于没做，",
    "     2026-11-25 真机上就是这么「建好了」但桌面上什么都没有的。",
    "   · 读代码、写代码、改配置、看项目文件 → 一律用 files 的 read / write / list。",
    "     不要用浏览器打开本地文件（file: 协议被拦），不要用桌面截图看代码——2026-11-26 真机上工人",
    "     读完目录后去开浏览器和桌面想「看一眼代码」，browser 报 file: 被拦、desktop 超时，白花 6 步。",
    "6) 点击、输入、提交这类动作会出请示卡等人点同意；回的是 awaiting_approval，不是失败，别重复猛试。",
    "6.1) 有专用的手就直接用它，不要绕路：任务说飞书就调 feishu，说微信就调 wechat，说文件就调 files。",
    "     不要为了「先看一眼」去开浏览器或桌面——2026-11-25 真机上，建一条飞书日程之前先开了干净浏览器和桌面，" +
      "多走 3 步、耗了两分钟，什么也没查到。",
    "6.2) 某只手回了「没权限/干不了/被拒」，就照实说并把原话带回来，不要换一只不相干的手绕过去。",
    "6.3) 用 files / practice 的 mkdir、write 时 path 必须给（相对工作区的名字，例如 \"dot-验收文件夹\"）。" +
      "只发 {\"action\":\"mkdir\"} 会被拒；被拒一次就补上 path 再调，别原样重发。",
    recallHint,
    skillHint,
    delegateHint,
    "",
    context === "" ? "" : `当前任务上下文：\n${context}`,
    recentWorkText(db, task.id),
    contractText,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * 造一个本机工人通道。形状与 `PluginRuntimeLike["subagent"]` 一致。
 */
export function createLocalWorkerRuntime(deps: LocalWorkerDeps): {
  run(params: { sessionKey?: string; message: string; extraSystemPrompt?: string; idempotencyKey?: string }): Promise<{ runId: string }>;
  waitForRun(params: { runId: string; timeoutMs?: number }): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
} {
  const log = deps.logger ?? (() => {});
  const complete = deps.complete ?? createPoolModelComplete(deps.config, deps.model ?? DEFAULT_MODEL);
  // 按档位挑模型：同一个模型只建一次客户端；测试注入 complete 时一律用注入的。
  const completesByModel = new Map<string, ModelComplete>();
  const modelFor = (profile: string | null | undefined): string => {
    const fallback = deps.model ?? DEFAULT_MODEL;
    if (deps.complete !== undefined) return fallback;
    return PROFILE_MODELS[profile ?? "balanced"] ?? fallback;
  };
  const completeFor = (profile: string | null | undefined): ModelComplete => {
    if (deps.complete !== undefined) return deps.complete;
    const fallback = deps.model ?? DEFAULT_MODEL;
    const model = modelFor(profile);
    if (model === fallback) return complete;
    let picked = completesByModel.get(model);
    if (picked === undefined) {
      picked = createPoolModelComplete(deps.config, model);
      completesByModel.set(model, picked);
    }
    return picked;
  };
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const runs = new Map<string, LocalRun>();
  let seq = 0;

  // 三只手 + 练习手：模型看见的工具表由这里决定。
  const extraHands = deps.extraHands ?? [];
  const handByName = new Map<string, HandToolSpec>();
  for (const hand of extraHands) handByName.set(hand.name, hand);
  // dot_recall 是读账本的工具（不是一只手：不判档、不落步骤），单独一列放。
  const enableRecall = deps.enableRecall === true;
  // skillbook 和 dot_recall 一样是只读工具，不是手（不判档、不落步骤）。
  const enableSkills = typeof deps.skillIndexPath === "string" && deps.skillIndexPath !== "";
  const skillCache: { index?: import("../skills/index.ts").SkillIndex | null } = {};
  const toolDecls: unknown[] = [
    PRACTICE_TOOL_DECL,
    ...(enableRecall ? [RECALL_TOOL_DECL] : []),
    ...(enableSkills
      ? [
          {
            type: "function",
            function: {
              name: SKILLBOOK_TOOL_DEFINITION.name,
              description: SKILLBOOK_TOOL_DEFINITION.description,
              parameters: SKILLBOOK_TOOL_DEFINITION.parameters,
            },
          },
        ]
      : []),
    ...extraHands.map((hand) => ({
      type: "function",
      function: { name: hand.name, description: hand.description, parameters: hand.parameters },
    })),
  ];
  const toolNames = [
    "practice",
    ...(enableRecall ? [RECALL_TOOL_NAME] : []),
    ...(enableSkills ? [SKILLBOOK_TOOL_NAME] : []),
    ...extraHands.map((hand) => hand.name),
  ];
  /** 父工人能用的工具表（比子任务多的只有 delegate）。 */
  const parentDecls: unknown[] = [...toolDecls, DELEGATE_TOOL_DECL];
  const parentNames: string[] = [...toolNames, DELEGATE_TOOL_NAME];
  /**
   * 「换只手也没用」的硬失败：权限不够、被拒、要人接管、任务已经不在。
   * 遇到这些就别再试别的工具了 —— 2026-11-25 真机：飞书报没权限之后，
   * 工人又去开桌面和浏览器折腾了 6 步，最后还是失败，白花两分钟。
   */
  const HARD_FAIL_CODES = new Set([
    "scope_missing",
    "denied",
    "human_required",
    "captcha_handoff",
    "identity_missing",
    "practice_root_missing",
    "workspace_missing",
    "auth_failed",
    // 人在用电脑 / 拿不到控制权：换只手也没用，而且不是任务的错。
    "user_control",
    "control_unavailable",
  ]);

  // 「原地打转」的两张表（seenCalls / lastResults）在 runLoop 里按**每一次 run** 建。
  // 绝不能提到这里：这里是整个运行时实例一份，网关是长驻进程，表会跨任务累积。
  // 2026-11-26 真机（gateway-concurrency-1126-060316）就是这个漏法：六个任务同时要
  // practice({"action":"list"})，先跑的那个把 digest 记成 1，后面的任务第 1 步就被判
  // 「重复，没再执行」——不执行、不落步骤、还把前一个任务的结果回给它。
  // 结果是 task_8cc94de9 / task_585a5ed9 账本 0 步（no_steps 判失败），
  // 模型拿不到真结果，就自己编了一套目录内容。

  /** 把模型给的工具参数解析成对象；解析不了就当空参数（让手自己报「动作不支持」）。 */
  function argsOf(call: ToolCallRequest): Record<string, unknown> {
    try {
      const parsed = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 落到下面
    }
    return {};
  }

  async function executePractice(taskId: string, call: ToolCallRequest): Promise<HandOutcome> {
    const args = argsOf(call);
    return await runPracticeHand(
      {
        db: deps.db,
        config: deps.config,
        ...deps.handDeps,
        logger: log,
      },
      {
        // toolCallId 必须传：身份表是「一次调用登记一次、取用即删」，
        // 不传就等于没登记过 → 一律 identity_missing（2026-11-25 真机：加了 identity 之后
        // 练习手全挂，就是因为这里原来没带调用号）。
        toolCallId: call.id,
        // 没有身份表 = 脚本直接调用这条路径，必须显式给 taskId（src/hands/hand.ts:169）
        taskId,
        action: typeof args["action"] === "string" ? args["action"] : undefined,
        path: typeof args["path"] === "string" ? args["path"] : undefined,
        content: typeof args["content"] === "string" ? args["content"] : undefined,
        overwrite: args["overwrite"] === true,
      },
    );
  }

  /** 非练习手：把原始参数原样交给那只手（它自己白名单裁剪），taskId 显式给。 */
  async function executeHand(hand: HandToolSpec, taskId: string, call: ToolCallRequest): Promise<HandOutcome> {
    const args = argsOf(call);
    const nested = args["params"];
    // 参数有两种写法，两种都认（2026-11-27 实测踩到）：
    //   desktop/browser 的手参数 schema 里就是 `params: {...}`，模型照抄；
    //   但模型给 exec 这种新手时会直接写顶层 `{"cmd":"node --test"}`，
    //   而这里原来只转交 `args["params"]`，于是 req.params 是空的，
    //   手报「exec 需要 cmd」，工人连试 8 次都一样。
    // 口径：顶层键先铺平，嵌套 params 覆盖同名键（嵌套更具体）。
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      // action / path / content / overwrite 已经单独转交了，别再塞进 params（会重复、也会让手看见两份）。
      if (key === "params" || key === "action" || key === "path" || key === "content" || key === "overwrite") continue;
      flat[key] = value;
    }
    return await hand.run({
      toolCallId: call.id,
      taskId,
      action: typeof args["action"] === "string" ? args["action"] : undefined,
      // path / content / overwrite 必须转交：2026-11-25 真机上它们全被丢在这里，
      // files 手拿到的是「mkdir 但没有 path」，于是任务反复 bad_path 最后判失败。
      path: typeof args["path"] === "string" ? args["path"] : undefined,
      content: typeof args["content"] === "string" ? args["content"] : undefined,
      overwrite: args["overwrite"] === true,
      params:
        nested !== null && typeof nested === "object" && !Array.isArray(nested)
          ? { ...flat, ...(nested as Record<string, unknown>) }
          : flat,
    });
  }

  /** dot_recall：只读账本，不落步骤（它不是一只「手」，没有副作用，所以不走七步壳）。 */
  function executeRecall(taskId: string, call: ToolCallRequest): HandOutcome {
    const result = executeRecallTool(deps.db, { taskId, args: argsOf(call) });
    return {
      ok: result.ok,
      code: result.ok ? "ok" : "failed",
      text: result.text,
      taskId,
      stepId: null,
      approvalId: null,
      tier: RECALL_TIER,
      rule: "read_only",
      sideEffect: "safe",
      resultRef: result.ref,
      snapshotRef: null,
    };
  }

  /** skillbook：只读技能库，不落步骤（和 dot_recall 一个待遇）。 */
  function executeSkillbookCall(taskId: string, call: ToolCallRequest): HandOutcome {
    const result = executeSkillbook({ indexPath: deps.skillIndexPath ?? "", cache: skillCache }, argsOf(call));
    return {
      ok: result.ok,
      code: result.ok ? "ok" : "failed",
      text: result.text,
      taskId,
      stepId: null,
      approvalId: null,
      tier: 1,
      rule: "read_only",
      sideEffect: "safe",
      resultRef: null,
      snapshotRef: null,
    };
  }

  /**
   * 手在**动手之前**就拒了（身份 / 任务 / 动作归一化 / 闸门 / 审批 / 单例锁）时，
   * 账本里一行都没有（src/hands/hand.ts 的壳只在第 5 步之后记账）。
   * 工人在自己这一侧补一条（成功记 succeeded、没执行记 skipped），回给模型的正文原样进 artifacts。
   *
   * 为什么必须补（2026-11-26 真机）：files 因为工作区没声明被拒，账本 0 步，
   * 任务结论写成「一步都没做（no_steps）」，把「工作区没声明」这个真原因盖掉了；
   * 18 步 practice / 0 步 files 的任务也一样——不是没调过 files，是调了没落账。
   *
   * 只补「手没记过账」的那些（outcome.stepId === null），手自己记过的绝不重复记。
   * 补账失败只记日志，绝不让它打断工人循环。
   */
  function recordCallStep(task: TaskRow, call: ToolCallRequest, outcome: HandOutcome, step: number): string | null {
    const sideEffect =
      outcome.sideEffect === "safe" || outcome.sideEffect === "replayable" || outcome.sideEffect === "unknown"
        ? outcome.sideEffect
        : "unknown";
    try {
      const argsArtifact = putArtifact(
        deps.db,
        JSON.stringify({
          worker: "local",
          tool: call.name,
          tool_call_id: call.id,
          step_no: step,
          args: argsOf(call),
          refused_before: outcome.code,
        }),
      );
      const row = beginStep(deps.db, {
        task_id: task.id,
        milestone_id: task.milestone_id,
        run_epoch: task.run_epoch,
        kind: "tool",
        tool: call.name,
        // 主题键带上调用号：手那条步骤不存在，这条不能被崩溃恢复误当成「同一步已成功」。
        subject_key: computeSubjectKey(task.id, `${call.name}@${call.id}`, { step_no: step }),
        side_effect: sideEffect,
        tier: outcome.tier ?? 1,
        args_ref: argsArtifact.hash,
        session_key: `task:${task.id}`,
      });
      const resultArtifact = putArtifact(
        deps.db,
        JSON.stringify({
          ok: outcome.ok,
          code: outcome.code,
          error_code: outcome.errorCode ?? null,
          tier: outcome.tier,
          rule: outcome.rule,
          text: outcome.text,
        }),
      );
      endStep(deps.db, row.id, {
        // 记 skipped 而不是 failed：这一步**没有动过手**，而且「被拒一次补上 path 再调」
        // 是正常的（提示词就是这么教模型的）。记 failed 会让 settleTask 把
        // 「重试后做成了」的任务判成失败（src/dispatch/settle.ts:123 按全任务步数统计）。
        // 原因照样写进 error 列 + 结果 artifact，所以账本里看得见为什么没做。
        status: outcome.ok ? "succeeded" : "skipped",
        ...(outcome.ok ? {} : { error: `${outcome.code}: ${outcome.text}`.slice(0, 500) }),
        result_ref: resultArtifact.hash,
      });
      return row.id;
    } catch (err) {
      log("warn", `工人（${task.id}）第 ${step} 步补记账本失败：${(err as Error).message}`);
      return null;
    }
  }

  /** 记一轮用量（预算八成的分子）；记不了只记日志，不影响干活。 */
  function noteUsage(taskId: string, turn: ModelTurn, model: string): void {
    if (turn.usage === undefined || deps.onUsage === undefined) return;
    try {
      // 记的是这一轮实际用的模型（按档位选过），不是缺省那一个——不然账本上的用量对不上账。
      deps.onUsage({ taskId, model, usage: turn.usage });
    } catch (err) {
      log("warn", `用量记账失败（${taskId}）：${(err as Error).message}`);
    }
  }

  /**
   * 打转时的收尾：掐掉工具，只让模型用一句话交代「做成了什么、还差什么」，按它自己的话判成败。
   * 之所以不直接判失败：真机上「mkdir 成功 → list 成功 → 又要 mkdir」很常见，
   * 那一步重复只是模型没话说，活其实已经干完了。
   */
  async function wrapUp(
    task: TaskRow,
    messages: WorkerMessage[],
    detail: string,
    // 收尾这一问也要用这一轮档位的模型，不然「打转后自述」用的和干活不是同一个。
    complete: ModelComplete,
    activeModel: string,
  ): Promise<{ status: "ok" | "error"; error?: string }> {
    const ask = {
      role: "user" as const,
      content:
        "停：你在重复同一步。现在不要再用工具，只用一句话说清楚——已经做成了什么、还差什么。" +
        "如果任务已经完成，就只回答「做完了」。",
    };
    let turn: ModelTurn;
    try {
      turn = await complete({ messages: [...messages, ask], tools: [] });
    } catch (err) {
      return { status: "error", error: `打转后收尾没问成（${detail}）：${(err as Error).message}` };
    }
    noteUsage(task.id, turn, activeModel);
    const text = turn.text.trim();
    log("info", `工人（${task.id}）收尾自述：${text.slice(0, 160) === "" ? "（空）" : text.slice(0, 160)}`);
    if (text === "") return { status: "error", error: `工人在原地打转，收尾也没回话：${detail}` };
    // 「还差 / 没做 / 做不到 / 失败 / 不能」这类话 = 它自己承认没做成，那就老实判失败
    if (/还差|没做|没有做|做不到|完不成|失败|不能|无法/.test(text)) {
      return { status: "error", error: `工人打转，自述还没做完：${text.slice(0, 200)}` };
    }
    return { status: "ok" };
  }

  /**
   * 派一个子任务，等它做完，把结论交给父工人。
   *
   * 子任务是账本里一条 `parent_id` 指向父任务的任务：自己的上下文、自己的步骤，
   * 跑在同一个进程里（阻塞等待）。合并方案（定稿第 675 行）原来打算用 allbot 的 subagent，
   * 这套安装里解析不到，所以自己给一层。
   */
  async function runDelegate(task: TaskRow, call: ToolCallRequest, step: number): Promise<string> {
    const args = argsOf(call);
    const brief = typeof args["brief"] === "string" ? args["brief"].trim() : "";
    const refuse = (text: string): string => {
      recordCallStep(
        task,
        call,
        { ok: false, code: "bad_action", text, taskId: task.id, stepId: null, approvalId: null, tier: 1, rule: "delegate", sideEffect: "safe", resultRef: null, snapshotRef: null },
        step,
      );
      return text;
    };
    if (brief === "") return refuse("delegate 需要 brief：写清要做什么、做完怎么算成。");
    if (brief.length > 2000) return refuse("brief 太长了（超过 2000 字），只写这一小块要做什么、怎么算成。");

    // 子任务沿用父任务的声明（工作区等），但不继承契约：契约是父任务自己的验收口径。
    let declared: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(task.declared_json) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        declared = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      declared = {};
    }
    delete declared["contract"];
    const ws = typeof args["workspace"] === "string" ? args["workspace"].trim() : "";
    if (ws !== "") declared["workspace"] = ws;

    const child = createTask(deps.db, { parent_id: task.id, intent: brief, declared, source: "delegate" });
    log("info", `工人（${task.id}）第 ${step} 步派了子任务 ${child.id}：${brief.slice(0, 80)}`);
    const started = Date.now();
    const outcome = await runLoop(
      child,
      "你是被父任务派来做一块独立活的子工人。做完用一句话给结论：做成了什么、放在哪里、怎么验的。" +
        "子任务里没有人守着，不能要求人批：遇到需要批准的动作就停下来说明，别硬试。",
      { isSub: true, maxSteps: DELEGATE_MAX_STEPS },
    );
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    // 子任务没人守着：它在这期间要出来的请示卡（第 4 档命令之类）一律撤回，
    // 否则这些卡会留在审批列表里等人点，点了也没人接着执行（子任务已经收尾了）。
    try {
      for (const apv of listOpenApprovals(deps.db, child.id)) {
        if (revokeApproval(deps.db, apv.id, "子任务没人守着，卡已撤回")) {
          log("info", `子任务 ${child.id} 的请示卡 ${apv.id} 已撤回（子任务没人守着）`);
        }
      }
    } catch (err) {
      log("warn", `清理子任务 ${child.id} 的请示卡失败：${(err as Error).message}`);
    }
    const done = outcome.status === "ok";
    try {
      setTaskState(deps.db, child.id, done ? "done" : "failed", {
        reason: done ? `子任务做完（父任务 ${task.id} 派的）` : `子任务失败：${outcome.error ?? "没有结论"}`,
        blocked_on: null,
        // 子任务可能停在 awaiting_approval（第 4 档命令出过卡）：卡片上面已经撤回，
        // 这里要能把它收掉，否则它会一直挂在「等人批」。
        expect: ["queued", "running", "awaiting_approval", "paused"],
      });
    } catch (err) {
      log("warn", `子任务 ${child.id} 收尾失败：${(err as Error).message}`);
    }
    const text = done
      ? `子任务 ${child.id} 做完了（${minutes} 分钟）。它的结论：\n${outcome.text !== undefined && outcome.text !== "" ? outcome.text : "（它没写结论）"}`
      : `子任务 ${child.id} 没做成（${minutes} 分钟）：${outcome.error ?? "没有结论"}`;
    recordCallStep(
      task,
      call,
      { ok: done, code: done ? "ok" : "failed", text, taskId: task.id, stepId: null, approvalId: null, tier: 1, rule: "delegate", sideEffect: "safe", resultRef: null, snapshotRef: null },
      step,
    );
    return text;
  }

  /**
   * 跑一条任务的工人循环。
   * `sub` 表示这次是「被父任务派出来的子工人」：工具表里没有 delegate（只到一层）、
   * 步数上限更小、结论要回给父任务。
   */
  async function runLoop(
    task: TaskRow,
    extraSystemPrompt: string,
    sub: { isSub: boolean; maxSteps?: number } = { isSub: false },
  ): Promise<{ status: "ok" | "error"; error?: string; text?: string }> {
    // 这一轮用的模型跟着任务档位走（外层 complete 只是缺省）。
    const complete = completeFor(task.profile);
    const activeModel = modelFor(task.profile);
    // 同一个调用（工具名+参数）在**本次 run 里**出现几次；用来识破模型原地打转。
    // 按 run 建，不跨任务：见上面「两张表不能提到实例上」的注释。
    const seenCalls = new Map<string, number>();
    /** 每个调用上一次的正文；重复时原样再喂一遍（同一任务自己的上一次）。 */
    const lastResults = new Map<string, string>();
    const decls = sub.isSub ? toolDecls : parentDecls;
    const names = sub.isSub ? toolNames : parentNames;
    const budget = sub.maxSteps ?? maxSteps;
    const messages: WorkerMessage[] = [
      {
        role: "system",
        content: `${systemPrompt(deps.db, task, names)}${extraSystemPrompt === "" ? "" : `\n\n${extraSystemPrompt}`}`,
      },
      { role: "user", content: task.intent },
    ];
    for (let step = 1; step <= budget; step += 1) {
      // 长程任务检查点：每步保存进度，超时后可断点续跑
      try {
        const { getLongTaskManager } = await import("../longtask/index.ts");
        getLongTaskManager().checkpoint(task.id, {
          stage: `执行第 ${step}/${budget} 步`,
          completedSteps: Array.from({ length: step - 1 }, (_, i) => i + 1),
          spentTokens: 0,
          status: "running",
        });
      } catch { /* 检查点模块不可用不影响 */ }
      let turn: ModelTurn;
      try {
        turn = await complete({ messages, tools: decls });
      } catch (err) {
        return { status: "error", error: `模型调用失败：${(err as Error).message}` };
      }
      noteUsage(task.id, turn, activeModel);
      if (turn.toolCalls.length > 0) {
        // 每轮把「要了哪些工具」原样打出来。2026-11-25 两次复测里，账本上是 no_steps、
        // 日志里只有一句「第 N 步没有要工具」，中间四轮要了什么完全看不到——
        // 有这一行，模型瞎编工具名 / 反复调 dot_recall 都不用再猜。
        log(
          "info",
          `工人（${task.id}）第 ${step} 步要了 ${turn.toolCalls.length} 个工具：` +
            turn.toolCalls.map((call) => `${call.name}(${call.arguments.slice(0, 80)})`).join(" | "),
        );
        // 关键：assistant 这一条要带上 tool_calls。少了它，模型看不到「我刚调过这个工具」，
        // 真机表现就是一遍遍重发同一个调用、还坚称「我一次工具都没调用过」。
        messages.push({
          role: "assistant",
          content: turn.text,
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });
      } else if (turn.text !== "") {
        messages.push({ role: "assistant", content: turn.text });
      }
      if (turn.toolCalls.length === 0) {
        log("info", `工人（${task.id}）第 ${step} 步没有要工具，收工：${turn.text.slice(0, 120)}`);
        return { status: "ok", text: turn.text };
      }
      // 同一个调用重复出现 = 模型在原地打转（真机见过：连着十几次 list 同一个目录，
      // 每次都说「接下来建目录」，然后又说同样的话）。
      // 处理分两档：第二次起**不再真执行**（只把上次结果再说一遍并明确要求别再重复，
      // 免得白白多写一步、多拍一次快照）；到 REPEAT_LIMIT 次判定打转、停下。
      for (const call of turn.toolCalls) {
        const hand = handByName.get(call.name);
        const isRecall = enableRecall && call.name === RECALL_TOOL_NAME;
        const isSkillbook = enableSkills && call.name === SKILLBOOK_TOOL_NAME;
        // delegate：父工人把一块活交给子工人（子任务、独立上下文）。子工人没有这个工具。
        if (call.name === DELEGATE_TOOL_NAME && !sub.isSub) {
          const text = await runDelegate(task, call, step);
          lastResults.set(`${call.name}|${call.arguments}`, text);
          messages.push({ role: "tool", tool_call_id: call.id, content: text });
          continue;
        }
        if (call.name !== "practice" && !isRecall && !isSkillbook && hand === undefined) {
          // 这一支必须留一行日志：它既不落步骤也不报错，2026-11-25 真机上「6 步全要了不存在的工具」
          // 在账本里长得和「一步都没做」一模一样，查了两轮才定位。
          log("warn", `工人（${task.id}）第 ${step} 步要了不存在的工具 ${call.name}：${call.arguments.slice(0, 120)}`);
          // 补记一条 skipped 步骤：让账本里看得见「这一步要了不存在的工具」
          recordCallStep(task, call, {
            ok: false,
            code: "bad_action",
            text: `没有这个工具：${call.name}`,
            taskId: task.id,
            stepId: null,
            approvalId: null,
            tier: 1,
            rule: "read_only",
            sideEffect: "safe",
            resultRef: null,
            snapshotRef: null,
          }, step);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              `没有这个工具：${call.name}。可用的只有 ${names.join(" / ")}。` +
              // 真机上模型会照着 MCP 的叫法瞎猜（browser_navigate 之类），连错几步就放弃。
              // 这里直接把它拽回正确名字，比让它自己猜有用。
              "别猜别的名字：打网页用 clean_browser 或 logged_browser，点桌面程序用 desktop，写文件用 files，" +
              "发/读微信用 wechat，查做法用 skillbook，练习夹用 practice。",
          });
          continue;
        }
        // 重复检测的键要抹掉「每轮都会变的数字」：模型会把 now 重新算一遍塞进参数，
        // 于是同一个查询每次都差几秒，按原样比较永远看不出它在原地打转
        // （2026-11-25 真机：飞书 events 连查 5 次，时间戳每次只差 3~5 秒）。
        // 做法：≥10 位的整数（epoch 秒/毫秒）按小时归桶。
        const digest = `${call.name}|${call.arguments.replace(/\b(\d{10,13})\b/g, (m) =>
          String(Math.floor(Number(m) / 3600) * 3600),
        )}`;
        const repeat = (seenCalls.get(digest) ?? 0) + 1;
        seenCalls.set(digest, repeat);        if (repeat >= REPEAT_LIMIT) {
          const detail = `同一个动作已经重复 ${repeat} 次（${call.name} ${call.arguments.slice(0, 120)}），结果没变`;
          log("warn", `工人（${task.id}）打转，问一次收尾：${detail}`);
          // 打转不等于没做成：真机上常见「mkdir 成功 → list 成功 → 又要 mkdir」。
          // 所以掐断工具，只让模型用一句话交代「做成了什么、还差什么」，按它自己的话判成败。
          return await wrapUp(task, messages, detail, complete, activeModel);
        }
        if (repeat >= 2) {
          const before = lastResults.get(digest) ?? "（上一步没有正文）";
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              `（这一步没有重复执行：同样的调用已经做过 ${repeat - 1} 次，结果没变）\n${before}\n` +
              `如果目标已经达到，就不要再调工具，直接用一句话说结果；否则换个做法。`,
          });
          log("warn", `工人（${task.id}）第 ${step} 步 ${call.name} 重复，没再执行`);
          continue;
        }
        // Sentinel 权限检查：按服务粒度拦截不允许的操作（在闸门六档之前）
        try {
          const { getSentinel } = await import("../sentinel/index.ts");
          const sentinel = getSentinel();
          const verdict = sentinel.check(call.name);
          if (!verdict.allowed) {
            log("warn", `工人（${task.id}）第 ${step} 步被 Sentinel 拒绝：${call.name}（${verdict.reason}）`);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Sentinel 权限拒绝：${verdict.reason}。请联系用户调整权限策略。`,
            });
            continue;
          }
        } catch { /* Sentinel 不可用时放行 */ }
        // 工人不是宿主会话，不会触发 before_tool_call 钩子，身份表里没有这次调用。
        // 手的第一步就是「取身份」，取不到一律 identity_missing（2026-11-25 真机就栽在这）。
        // 这里按宿主钩子的同一份形状补登记：只登记本次 toolCallId → 只能被取一次；
        // 归属写死成本任务，参数里的 task_id 改不了它（resolveTask 会拒不一致）。
        const identityTable = deps.handDeps?.identity;
        if (identityTable !== undefined) {
          try {
            identityTable.remember(call.id, { sessionKey: `task:${task.id}`, taskId: task.id });
          } catch (err) {
            log("warn", `工人（${task.id}）第 ${step} 步身份登记失败：${(err as Error).message}`);
          }
        }
        const outcome =
          call.name === "practice"
            ? await executePractice(task.id, call)
            : isRecall
              ? executeRecall(task.id, call)
              : isSkillbook
                ? executeSkillbookCall(task.id, call)
                : await executeHand(hand as HandToolSpec, task.id, call);
        // 手自己记过账（stepId 非空）就用它那条；只读工具（dot_recall / skillbook）按设计不落步骤；
        // 其余（动手前就被拒）由工人补一条，保证「每一次工具调用都有一条带结果的账本步骤」。
        const stepId =
          outcome.stepId !== null || isRecall || isSkillbook
            ? outcome.stepId
            : recordCallStep(task, call, outcome, step);
        const body = outcome.ok ? outcome.text : `失败（${outcome.code}）：${outcome.text}`;
        lastResults.set(digest, body);
        messages.push({ role: "tool", tool_call_id: call.id, content: body });
        log(
          outcome.ok ? "info" : "warn",
          `工人（${task.id}）第 ${step} 步 ${call.name}：${outcome.code}` +
            (outcome.errorCode === undefined ? "" : `/${outcome.errorCode}`) +
            (stepId === null ? "" : `，步骤 ${stepId}`),
        );
        // 硬失败：不再让模型换手硬试，也不再多花一轮让它总结 ——
        // 原话已经在 outcome.text 里，直接如实收尾（任务判失败，原因写清）。
        const hardCode = outcome.errorCode;
        if (!outcome.ok && hardCode !== undefined && HARD_FAIL_CODES.has(hardCode)) {
          log("warn", `工人（${task.id}）遇到硬失败 ${hardCode}，不再试别的工具，直接收尾`);
          // 人在用电脑不是失败：打上 [user_control] 前缀，调度器会把它判成「暂停等人」。
          if (hardCode === "user_control") {
            return { status: "error", error: `[user_control] ${outcome.text}`.slice(0, 500) };
          }
          return { status: "error", error: `这一步做不了（${hardCode}）：${outcome.text}`.slice(0, 500) };
        }
      }
    }
    return { status: "error", error: `到 ${maxSteps} 步还没收工` };
  }

  return {
    async run(params) {
      seq += 1;
      const runId = `local-${seq}-${taskIdOf(params.sessionKey, params.message)}`;
      const taskId = taskIdOf(params.sessionKey, "");
      const task = taskId === "" ? null : getTask(deps.db, taskId);
      if (task === null) {
        // 归不到任务就别假装跑：直接回一个立刻失败的 run
        runs.set(runId, { promise: Promise.resolve({ status: "error", error: `会话 ${params.sessionKey ?? "(无)"} 归不到任务` }) });
        return { runId };
      }
      log("info", `工人开工：${task.id}（模型 ${deps.model ?? "本机池默认"}）`);
      // 自动拆里程碑（DesignAnything 的 planTask 自动化）：
      // 任务没里程碑时，用模型从 intent 里拆出 3-5 个。
      // 只在真实模型池下自动拆；测试注入的 mock complete 会打乱脚本化回复顺序。
      if (deps.complete === undefined) {
        try {
          const { listMilestones } = await import("../ledger/index.ts");
          const existing = listMilestones(deps.db, task.id);
          if (existing.length === 0) {
            // ModelComplete 签名 ({messages, tools}) => ModelTurn，
            // PlanComplete 签名 (prompt) => string，用适配器桥接。
            const planComplete = (prompt: string): Promise<string> =>
              complete({ messages: [{ role: "user", content: prompt }], tools: [] }).then((t) => t.text);
            const planResult = await autoPlan(deps.db, task.id, planComplete);
            log(planResult.ok ? "info" : "warn", `任务 ${task.id} 自动拆里程碑：${planResult.reason}`);
          }
        } catch (err) {
          log("warn", `任务 ${task.id} 自动拆里程碑失败：${(err as Error).message}`);
        }
      }
      // 跨会话记忆：注入用户偏好和相关经验（对标 Muse persistent memory）
      let memoryContext = "";
      try {
        const { getMemoryStore, buildMemoryContext } = await import("../memory/index.ts");
        const store = getMemoryStore();
        memoryContext = buildMemoryContext(store, task.intent ?? "");
        if (memoryContext !== "") {
          log("info", `任务 ${task.id} 注入记忆上下文（${store.count()} 条记忆）`);
        }
      } catch { /* 记忆模块不可用不影响任务执行 */ }

      // 断点续跑：有可恢复的检查点时注入恢复提示词
      let resumePrompt = "";
      try {
        const { getLongTaskManager } = await import("../longtask/index.ts");
        const ltMgr = getLongTaskManager();
        if (ltMgr.canResume(task.id)) {
          const prompt = ltMgr.buildResumePrompt(task.id);
          if (prompt) {
            resumePrompt = `\n\n${prompt}`;
            ltMgr.resume(task.id);
            log("info", `任务 ${task.id} 断点续跑（第 ${ltMgr.get(task.id)?.resumeCount ?? 1} 次）`);
          }
        }
      } catch { /* 不影响 */ }

      // 个性化：名字/风格/语气注入系统提示词
      let personalizeContext = "";
      try {
        const { getPersonalizeStore, buildPersonalizePrompt } = await import("../personalize/index.ts");
        const pStore = getPersonalizeStore();
        personalizeContext = "\n\n" + buildPersonalizePrompt(pStore.get());
      } catch { /* 个性化模块不可用不影响任务执行 */ }

      const fullExtra = (params.extraSystemPrompt ?? "") + memoryContext + personalizeContext + resumePrompt;
      runs.set(runId, {
        promise: runLoop(task, fullExtra).then(async (result) => {
          // 任务完成后：清理检查点 + 自动提炼偏好记忆
          try {
            const { getLongTaskManager } = await import("../longtask/index.ts");
            getLongTaskManager().complete(task.id);
          } catch { /* 不影响 */ }
          try {
            const { getMemoryStore } = await import("../memory/index.ts");
            const { autoExtract } = await import("../memory/auto-extract.ts");
            const mStore = getMemoryStore();
            autoExtract(mStore, {
              userMessages: [task.intent],
              taskIntent: task.intent ?? "",
              resultSummary: result.status === "ok" ? "任务成功完成" : undefined,
              success: result.status === "ok",
              error: result.error,
              taskId: task.id,
            });
          } catch { /* 不影响 */ }
          return result;
        }),
      });
      return { runId };
    },
    async waitForRun(params) {
      const entry = runs.get(params.runId);
      if (entry === undefined) return { status: "error", error: `没有这个本地 run：${params.runId}` };
      const timeoutMs = params.timeoutMs ?? 600000;
      const result = await Promise.race([
        entry.promise,
        new Promise<{ status: "timeout" }>((resolve) => setTimeout(() => resolve({ status: "timeout" }), timeoutMs)),
      ]);
      // 跑完就丢掉这条 run，别让表随派发次数一直涨（网关是长驻进程）。
      // 超时的那条要留着：工人循环可能还在跑，下次 waitForRun 还要能查。
      if (result.status !== "timeout") runs.delete(params.runId);
      return result;
    },
  };
}

/** 从 sessionKey（task:<id>）里取任务号；取不到返回空串。 */
function taskIdOf(sessionKey: string | undefined, message: string): string {
  const key = typeof sessionKey === "string" ? sessionKey : "";
  const byKey = /(?:^|[:\s])task:([A-Za-z0-9_]+)/.exec(key);
  if (byKey !== null) return byKey[1] ?? "";
  const byMsg = /(?:^|[:\s])task:([A-Za-z0-9_]+)/.exec(message ?? "");
  return byMsg !== null ? byMsg[1] ?? "" : "";
}

/** 读本机模型池的地址与 key（与 allbot 的 local 供应商同一份配置）。 */
export function readPoolEndpoint(configPath: string = join(homedir(), ".allbot", "allbot.json")): { baseUrl: string; apiKey: string } {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    models?: { providers?: { local?: { baseUrl?: string; apiKey?: string } } };
  };
  const local = raw.models?.providers?.local;
  const baseUrl = (local?.baseUrl ?? DEFAULT_MODEL_ENDPOINT).replace(/\/$/, "");
  const apiKey = local?.apiKey ?? "";
  if (apiKey === "" || apiKey === "local") {
    throw new Error("模型池的 key 还是占位符：跑 node build/tools/apply-allbot-config.mjs --api-key <key>");
  }
  return { baseUrl, apiKey };
}

/**
 * 真实现：OpenAI 兼容的 chat/completions。
 * 第三个参数是地址/key 的取法，只为测试能注入（默认读 ~/.allbot/allbot.json 的 local 供应商）。
 */
export function createPoolModelComplete(
  config?: DotCoreConfig,
  model = DEFAULT_MODEL,
  endpoint: () => { baseUrl: string; apiKey: string } = readPoolEndpoint,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): ModelComplete {
  void config;
  // 1200 是工人干活时的默认（工具调用短）。**要长正文的调用**（自我优化提案那种
  // 「必须吐一段完整 JSON」）得把这个抬高：模型先花 token 想，再输出正文，
  // 预算全花在思考上时 content 就是空串（2026-11-25 真机：提案连续两次「模型回了空文本」）。
  const maxTokens = opts.maxTokens ?? 1200;
  // 默认 120000 不变（工人并发挂起那条真机结论）。只回答通道自己传 55000。
  const timeoutMs = opts.timeoutMs ?? 120000;
  return async ({ messages, tools }) => {
    let baseUrl: string;
    let apiKey: string;
    try {
      ({ baseUrl, apiKey } = endpoint());
    } catch (err) {
      throw new ModelPoolError("config", (err as Error).message);
    }
    const body = {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls !== undefined && m.tool_calls.length > 0 ? { tool_calls: m.tool_calls } : {}),
      })),
      tools,
      tool_choice: "auto",
      max_tokens: maxTokens,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // 超时必须覆盖到读完正文为止：以前 clearTimeout 放在 fetch 后面的 finally 里，
    // fetch 一收到响应头就清了定时器，resp.json() 读正文没有超时保护。
    // 2026-11-26 真机：6 个工人并发时模型池回了头但正文不来，3 个工人永远挂在
    // resp.json() 上，600 秒会话超时也救不了（它只管 waitForRun 那层）。
    try {
      let resp: Response;
      try {
        resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: ac.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const e = err as Error;
        const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
        throw new ModelPoolError(timedOut ? "timeout" : "unreachable", e.message);
      }
      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 200);
        throw new ModelPoolError("http", `模型池回了 ${resp.status}：${detail}`, resp.status);
      }
      let json: {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        };
      };
      try {
        json = (await resp.json()) as typeof json;
      } catch (err) {
        const e = err as Error;
        const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
        throw new ModelPoolError(timedOut ? "timeout" : "invalid", e.message);
      }
      const msg = json.choices?.[0]?.message;
      const calls: ToolCallRequest[] = [];
      for (const [idx, call] of (msg?.tool_calls ?? []).entries()) {
        const name = call.function?.name;
        if (typeof name !== "string" || name === "") continue;
        calls.push({
          id: typeof call.id === "string" && call.id !== "" ? call.id : `call-${idx}`,
          name,
          arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
        });
      }
      return {
        text: typeof msg?.content === "string" ? msg.content : "",
        toolCalls: calls,
        ...(json.usage === undefined
          ? {}
          : {
              usage: {
                input_tokens: Number(json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0),
                output_tokens: Number(json.usage.completion_tokens ?? json.usage.output_tokens ?? 0),
              },
            }),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
