/**
 * src/say/index.ts —— 第 3 步 C：说人话改写层。
 *
 * 只做一件事：把内部账本/闸门生成给机器看的文本，改写成用户读得懂的中文。
 * 它**不是**第二个大脑：不判档、不记账、不编结论。改写失败永远退回原文。
 *
 * 三条硬约束（有测试守着）：
 * 1. 开关关着 / 没注入模型 / 模型抛错 / 空文本 → **原样返回**，一个字节都不改；
 * 2. 数字、路径、编号必须原样保留；改写里出现原文没有的数字/路径/结论 → 退回原文；
 * 3. 超过 maxChars 才截断，截断时保留最后一句（结论）。
 *
 * 模型调用走注入的 `complete`（生产由 index.ts / dot-bridge 注入模型池），
 * 本文件不读环境变量、不读 key、不发请求，测试直接给假函数。
 */

/** 注入的模型调用：给提示词，回模型正文。 */
export type SayComplete = (prompt: string) => Promise<string>;

/** 改写函数（桥里注入这个形状，不直接依赖本模块的选项）。 */
export type SayRewrite = (text: string) => Promise<string>;

export interface SayRewriteOptions {
  /** 总开关。false = 原样返回，也不调模型。 */
  enabled: boolean;
  /** 模型调用；没配（例如没 key）时返回原文。 */
  complete?: SayComplete;
  /** 改写结果上限（字符数）；默认 800。只有成功改写后才截断。 */
  maxChars?: number;
  /** 改写门槛（字符数）；默认 SAY_MIN_REWRITE_CHARS（80）。测试可调低。 */
  minRewriteChars?: number;
}

/** 卡片类文本的默认上限：够放下进度卡/请示卡，又不会把手机屏幕撑爆。 */
export const DEFAULT_MAX_CHARS = 800;

const PROMPT_RULES = [
  "你是 dot 的「说人话」改写器。把下面这段内部记录改写成用户一眼能看懂的中文。",
  "规矩：",
  "1) 只改说法，不编、不加事实；原文没说的结论不要添，原文没做的动作不要说做了。",
  "2) 数字、路径、文件名、命令、编号（task_/step_/apv_/snap_ 等前缀，含 apv_ 批单号）一律原样保留：不许改值、不许省略、不许四舍五入。",
  "3) 不要开场白、不要总结、不要评价，只输出改写后的正文。",
  "4) 保留原文的分行结构；原文很短就别硬扩写。",
  "",
  "原文：",
  "---",
];

const PROMPT_TAIL = ["---", "", "改写后："];

/** 拼提示词（导出给测试核对「不编、不加事实、不改数字与路径」四条规则确实写进去了）。 */
export function buildSayPrompt(text: string): string {
  return [...PROMPT_RULES, text, ...PROMPT_TAIL].join("\n");
}

/** 去掉模型偶尔包上的 ``` 围栏和首尾空白。 */
function cleanModelText(raw: string): string {
  let text = raw.trim();
  const fenced = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced !== null) text = (fenced[1] ?? "").trim();
  return text;
}

// ────────────────────────────────────────────────────────────────────────────
// 保真校验：数字、路径、编号不许变，也不许冒出原文没有的。
// ────────────────────────────────────────────────────────────────────────────

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

const PATH_RES: ReadonlyArray<RegExp> = [
  // Windows 盘符路径（不含空格的第一段）：C:\... / D:/...
  /[A-Za-z]:[\\/][^\s，。；、：！？'"()（）【】<>|?*]+/g,
  // UNC 路径：\\server\share...
  /\\\\[^\s，。；、：！？'"()（）【】<>|?*]+/g,
  // 任意空白分隔、含斜杠或反斜杠的片段。覆盖：带空格路径（C:\My Documents\a.txt 会被
  // 拆成两个 token，任一段变了都能比出来）、中文相对路径（练习/说明.txt）。
  /[^\s，。；、：！？'"()（）【】<>|?*]*[\\/][^\s，。；、：！？'"()（）【】<>|?*]*/g,
  // 裸文件名：notes.md / 说明.txt / a.png（扩展名限字母，避免把 1.5、127.0.0.1 当路径）。
  /[^\s/\\，。；、：！？'"()（）【】<>|?*]+\.(?:[A-Za-z]{1,6})\b/g,
];

// 真实 id 前缀（src/ledger：randomId("task"/"step"/"apv"/"snap"/"plan"/"ms"/"dec"/"subj"/"spend"/"worker")）。
// 以前漏了 apv_，改写后的请示卡会带错批单号——这是评审实测出来的，别再删。
const ID_RE = /\b(?:task|step|apv|snap|plan|ms|dec|subj|spend|worker|run|evt)_[A-Za-z0-9]+\b/g;

/** 这些是「做了某件有事」的断言；原文没有就不许改写里冒出来。 */
const RISK_PHRASES: ReadonlyArray<string> = [
  "已删除",
  "已经删除",
  "已清空",
  "已发送",
  "发送成功",
  "已付款",
  "已批准",
  "已拒绝",
  "已完成",
  "已经完成",
  "已成功",
  "删除成功",
  // 2026-11-25 真机/探针补的：模型会自作主张替系统宣布进度或结果
  "已处理",
  "处理好了",
  "已开始",
  "已经开始",
  "马上就好",
  "搞定了",
  "弄好了",
  "整理好",
];

function numbersIn(text: string): Set<string> {
  return new Set(text.match(NUMBER_RE) ?? []);
}

function pathsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of PATH_RES) {
    for (const match of text.matchAll(re)) {
      const token = (match[0] ?? "").replace(/[.,;:!?，。；：！？）)\]】]+$/, "");
      // 纯分隔符（例如中文句子里单独一个「/」）不算路径。
      if (token === "" || token.replace(/[\\/]/g, "") === "") continue;
      out.add(token);
    }
  }
  return out;
}

function idsIn(text: string): Set<string> {
  return new Set(text.match(ID_RE) ?? []);
}

function setDiff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((item) => !b.has(item));
}

/**
 * 改写结果相对原文的保真问题。空数组 = 通过。
 * 导出给测试直接核对防线，不用绕模型。
 */
export function fidelityIssues(original: string, rewritten: string): string[] {
  const issues: string[] = [];

  const missingNumbers = setDiff(numbersIn(original), numbersIn(rewritten));
  if (missingNumbers.length > 0) issues.push(`数字被改或丢了：${missingNumbers.slice(0, 5).join("、")}`);
  const addedNumbers = setDiff(numbersIn(rewritten), numbersIn(original));
  if (addedNumbers.length > 0) issues.push(`多了原文没有的数字：${addedNumbers.slice(0, 5).join("、")}`);

  const missingPaths = setDiff(pathsIn(original), pathsIn(rewritten));
  if (missingPaths.length > 0) issues.push(`路径被改或丢了：${missingPaths.slice(0, 3).join("、")}`);
  const addedPaths = setDiff(pathsIn(rewritten), pathsIn(original));
  if (addedPaths.length > 0) issues.push(`多了原文没有的路径：${addedPaths.slice(0, 3).join("、")}`);

  const missingIds = setDiff(idsIn(original), idsIn(rewritten));
  if (missingIds.length > 0) issues.push(`编号被改或丢了：${missingIds.slice(0, 3).join("、")}`);

  for (const phrase of RISK_PHRASES) {
    if (rewritten.includes(phrase) && !original.includes(phrase)) {
      issues.push(`多了原文没有的结论：${phrase}`);
    }
  }

  // 改写应该是在原文长度附近换个说法；明显变长多半是模型自己编了一段。
  // 2026-11-25 收口：原来是 ×1.6+60，短卡放得太松（11 字原文能扩到 77 字）。
  if (rewritten.length > original.length * 1.4 + 25) {
    issues.push("改写后明显变长，疑似添了原文没有的内容");
  }

  return issues;
}

// ────────────────────────────────────────────────────────────────────────────
// 截断：保留最后一句（结论）
// ────────────────────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .filter((part) => part.trim() !== "");
}

/**
 * 超过 maxChars 就截断，但保留最后一句（结论）。
 * 结论自己就超长时只能硬切——这时返回的前缀不以「…」结尾。
 */
export function truncateKeepConclusion(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  const sentences = splitSentences(text);
  const conclusion = (sentences[sentences.length - 1] ?? "").trim();
  if (conclusion === "") return text.slice(0, maxChars);

  const ellipsis = "…";
  if (conclusion.length + ellipsis.length > maxChars) return text.slice(0, maxChars);

  const budget = maxChars - conclusion.length - ellipsis.length;
  let head = "";
  for (const sentence of sentences.slice(0, -1)) {
    if ((head + sentence).length > budget) break;
    head += sentence;
  }
  head = head.trim();
  if (head === "") return conclusion;
  return `${head}${ellipsis}${conclusion}`;
}

// ────────────────────────────────────────────────────────────────────────────
// 对外
// ────────────────────────────────────────────────────────────────────────────

/**
 * 短文本不送模型。理由：改动风险全在改写上，收益却在长文里。
 * 2026-11-25 探针实测，11 字原文「任务还在排队，等派发。」被改成 26 字编造句
 * 「已经帮你把桌面截图全部整理好放到月份文件夹了，稍等。」而校验放行。
 * 短句本来就人话，重写只会给它添戏。
 * 2026-11-26 对齐方案 4.4「只对超过 80 字的自由发挥文字用」：门槛从 20 提到 80。
 */
export const SAY_MIN_REWRITE_CHARS = 80;

/**
 * 改写一段内部文本。
 * 空文本、开关关着、没注入模型、太短、模型抛错、结果没通过保真校验 → 原样返回。
 */
export async function rewrite(text: string, opts: SayRewriteOptions): Promise<string> {
  if (text === "" || text.trim() === "") return text;
  if (!opts.enabled) return text;
  const minChars = opts.minRewriteChars ?? SAY_MIN_REWRITE_CHARS;
  if (text.trim().length < minChars) return text;
  const complete = opts.complete;
  if (complete === undefined) return text;

  let raw: unknown;
  try {
    raw = await complete(buildSayPrompt(text));
  } catch {
    // 模型报错 / 没配 key / 超时：改写不是关键路径，退回原文。
    return text;
  }
  // 模型偶尔回 null / 对象（兼容层抖动）；不是字符串就当真失败，别让 .trim 抛出去。
  if (typeof raw !== "string") return text;

  let out: string;
  try {
    out = cleanModelText(raw);
  } catch {
    return text;
  }
  if (out === "") return text;

  // 第一关：先对完整改写做保真校验，防止模型在被截掉的段落里编东西。
  if (fidelityIssues(text, out).length > 0) return text;

  // 第二关：截断之后再校验一次——截断不能把原文的数字/路径/编号切丢。
  // 例如路径在第 20 句、maxChars 只够前 5 句：宁可退回原文，也不给用户一张
  // 少了关键路径的卡。这一关也顺手覆盖「模型原样返回超长文本」的情况。
  const truncated = truncateKeepConclusion(out, opts.maxChars ?? DEFAULT_MAX_CHARS);
  if (fidelityIssues(text, truncated).length > 0) return text;
  return truncated;
}

/**
 * 绑一份选项，返回桥/路由直接可用的 `(text) => Promise<string>`。
 * 注意：开关关着时调用方应**根本不传**这个函数，才谈得上「不改任何字节」；
 * 这里即使被调用也只会原样返回。
 */
export function createSayRewriter(opts: SayRewriteOptions): SayRewrite {
  return (text: string) => rewrite(text, opts);
}
