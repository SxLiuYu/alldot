/**
 * src/selfimprove/apply.ts —— 应用提案的唯一一条窄路（默认关着）。
 *
 * 能做的只有一件事：把补丁写到 `build/自我优化/pending/<提案id>.patch`，
 * 然后**在仓库的副本上**打上这个补丁、跑全量测试 + 类型检查；过不了就删掉补丁、
 * 记事件、原样收手。**永远不改真实源码、不改配置、不改 keeper**。人看过补丁再决定要不要打。
 *
 * 四道闸，任何一道不过就拒（并追加一条事件，审计可查）：
 * 1. 开关：config.self_improve.enabled 必须是 true（不给配置 = 关）；
 * 2. 目标：必须落在 build/dot-core/src/ 下、存在、不是绝对路径/`..`；
 * 3. 补丁正文：**整段补丁**里点到的文件路径（--- / +++ / diff --git）以及任何提到黑名单
 *    路径的地方，都要过黑名单与白名单——只校验 target 等于给自己留后门（评审实测过）；
 * 4. 配置字段：对 config-schema.ts / config.ts / config.example.json 把补丁应用一遍、
 *    按字段语义比对，approvals、desktop.human_only_apps、exec.whitelist、self_improve
 *    任何一个变了就拒。只扫「改动行里有没有父字段名」会漏掉嵌套改法（评审实测过）。
 *
 * 黑名单覆盖手的所有执行边界：gate（判档）、hands 整目录（练习根围栏、落盘、桌面/浏览器、
 * 快照、单例锁）、ledger（账本写入口）、keeper 脚本、selfimprove 自身（改窄路 = 自己松绑）。
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { LedgerDb } from "../ledger/db.ts";
import { appendEvent } from "../ledger/index.ts";
import type { ApplyOptions, ApplyResult, CheckOutcome, SelfImproveConfigSlice } from "./types.ts";

export type { ApplyOptions, ApplyResult, CheckOutcome } from "./types.ts";

/** 白名单根：补丁只能落在这里面。 */
export const WHITELIST_PREFIX = "build/dot-core/src/";

/** pending 目录（相对项目根）。 */
export const PENDING_DIR = "build/自我优化/pending";

/**
 * 跑检查时要复制进副本的目录。
 * - 前四个是 run-tests.mjs 的 SCAN_DIRS；
 * - build/patches 是 build/tools/dsbot.test.mjs 真正读的补丁素材（不在 SCAN_DIRS 里）；
 * - _dsh_session_facaf347 是 dsbot.test.mjs 从 process.cwd() 读的会话夹具。
 * 少任何一个，全量测试都会红。以后测试再加根目录夹具，这里要跟着补——
 * 忘了补的后果是「好补丁也被拒」，方向是安全的那一边。
 */
export const CHECK_TREE_DIRS: readonly string[] = [
  "build/dot-core",
  "build/dot-bridge",
  "build/tools",
  "build/_canary",
  "build/patches",
  "_dsh_session_facaf347",
];

export interface BlacklistRule {
  id: string;
  /** file = 单个文件；prefix = 整个目录。 */
  kind: "file" | "prefix";
  path: string;
  note: string;
}

/**
 * 硬黑名单。命中的补丁不写、不测、直接拒。
 * hands 整目录都算红线：判档在 gate/hand.ts，但真正决定「写不写、写到哪」的是
 * practice.ts（练习根围栏）、files.ts、desktop.ts、browser.ts、snapshot.ts、singleton.ts。
 * 只拉黑 hand.ts 等于只挡住判档层，手落盘那道边界还开着（评审实测过）。
 */
export const HARD_BLACKLIST: readonly BlacklistRule[] = [
  { id: "gate", kind: "prefix", path: "build/dot-core/src/gate/", note: "闸门与判档是红线" },
  { id: "builtin", kind: "file", path: "build/dot-core/src/hands/builtin.ts", note: "内置工具的治理钩子" },
  { id: "hand_tier", kind: "file", path: "build/dot-core/src/hands/hand.ts", note: "手的判档逻辑" },
  {
    id: "hands",
    kind: "prefix",
    path: "build/dot-core/src/hands/",
    note: "手的执行边界（练习根围栏、落盘、桌面/浏览器、快照、单例锁）",
  },
  { id: "ledger", kind: "prefix", path: "build/dot-core/src/ledger/", note: "账本是唯一写入口" },
  { id: "selfimprove", kind: "prefix", path: "build/dot-core/src/selfimprove/", note: "改自我优化的边界等于自己松绑" },
  { id: "keeper", kind: "file", path: "build/tools/keeper.ps1", note: "看门狗脚本" },
  { id: "keeper_install", kind: "file", path: "build/tools/keeper-install.ps1", note: "看门狗安装脚本" },
];

/** 配置文件：本身可改（在白名单里），但补丁不许碰这几个字段。 */
export const GUARDED_CONFIG_FILES: readonly string[] = [
  "build/dot-core/src/config-schema.ts",
  "build/dot-core/src/config.ts",
  "build/dot-core/config.example.json",
];

/**
 * 不许出现在配置补丁里的字段。
 * `nested` 里的键名用来兜住「只改嵌套值、父字段只出现在上下文行」的改法。
 */
export const GUARDED_CONFIG_FIELDS: readonly string[] = ["approvals", "human_only_apps", "whitelist", "self_improve"];
export const GUARDED_CONFIG_NESTED_KEYS: readonly string[] = [
  "inline_wait_ms",
  "ttl_hours",
  "max_proposals_per_day",
];

/** 补丁上限：超过这个大小直接拒（省得拿整个仓库当补丁）。 */
export const MAX_PATCH_BYTES = 256 * 1024;

export interface TargetCheck {
  ok: boolean;
  rule: string | null;
  reason: string;
  /** 归一后的相对路径（正斜杠）。 */
  target: string;
}

/**
 * 路径归一：反斜杠转正斜杠、去掉空段与 `.`。
 *
 * 2026-11-25 评审实测的绕过：原来只去掉开头的 `./`，于是
 * `build/dot-core/src/gate/policy.ts` 被拦、`build/dot-core/src/./gate/policy.ts` 却 PASS，
 * `src//gate/` 同理。黑名单、白名单、补丁文件头都靠这个函数，归不干净等于红灯不亮。
 *
 * 刻意**不**处理 `..`：留给 checkTarget 的 path_traversal 明确拒绝（静默解析反而看不出意图）。
 */
export function normalizeTarget(target: string): string {
  const raw = target.trim().replace(/\\/g, "/");
  // 开头那一刀要记住：/etc/passwd 归一之后还得是绝对路径，
  // 否则 checkTarget 的 absolute_path 就判不出来了（原来是 not_whitelisted，测试当场红）。
  const posixAbsolute = raw.startsWith("/");
  const driveAbsolute = /^[A-Za-z]:\//.test(raw);
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    parts.push(seg);
  }
  const joined = parts.join("/");
  if (driveAbsolute) return joined;
  if (posixAbsolute) return `/${joined}`;
  return joined;
}

function isSamePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function underPrefix(target: string, prefix: string): boolean {
  return target.toLowerCase().startsWith(prefix.toLowerCase());
}

/** 黑名单检查（不看文件是否存在）。命中的规则原样返回。 */
export function blacklistHit(target: string): BlacklistRule | null {
  const t = normalizeTarget(target);
  for (const rule of HARD_BLACKLIST) {
    if (rule.kind === "file" ? isSamePath(t, rule.path) : underPrefix(t, rule.path)) return rule;
  }
  return null;
}

/**
 * 看一个 target 能不能碰：绝对路径、`..`、不在白名单、命中黑名单、
 * 文件不存在/不是文件，都拒；拒的时候给出具体规则 id 和一句人话。
 */
export function checkTarget(target: string, root: string): TargetCheck {
  const t = normalizeTarget(typeof target === "string" ? target : "");
  if (t === "") return { ok: false, rule: "bad_target", reason: "target 是空的", target: t };
  if (isAbsolute(t) || /^[A-Za-z]:\//.test(t)) {
    return { ok: false, rule: "absolute_path", reason: `不接受绝对路径：${t}`, target: t };
  }
  if (t.split("/").includes("..")) {
    return { ok: false, rule: "path_traversal", reason: `不接受 .. 路径：${t}`, target: t };
  }

  const hit = blacklistHit(t);
  if (hit !== null) {
    return { ok: false, rule: hit.id, reason: `命中硬黑名单（${hit.id}：${hit.note}）`, target: t };
  }

  if (!underPrefix(t, WHITELIST_PREFIX)) {
    return {
      ok: false,
      rule: "not_whitelisted",
      reason: `只允许改 ${WHITELIST_PREFIX} 下的文件（黑名单除外）：${t}`,
      target: t,
    };
  }

  const abs = join(root, ...t.split("/"));
  if (!existsSync(abs)) {
    return { ok: false, rule: "target_missing", reason: `目标文件不存在：${t}`, target: t };
  }
  if (!statSync(abs).isFile()) {
    return { ok: false, rule: "not_a_file", reason: `目标不是文件：${t}`, target: t };
  }

  // 再确认解析之后仍落在根内（防 "src/../../" 这类归一技巧）。
  const resolvedRoot = resolve(root);
  if (!resolve(abs).toLowerCase().startsWith(resolvedRoot.toLowerCase())) {
    return { ok: false, rule: "outside_root", reason: `解析后跑出了项目根：${t}`, target: t };
  }

  return { ok: true, rule: null, reason: "ok", target: t };
}

// ────────────────────────────────────────────────────────────────────────────
// 补丁正文扫描：黑名单不能只看 target
// ────────────────────────────────────────────────────────────────────────────

/** unified diff 的文件头（--- / +++ / diff --git）里点到的路径。 */
export function patchFilePaths(patch: string): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if (value === "" || value === "/dev/null") return;
    out.add(normalizeTarget(value.replace(/^[ab]\//, "")));
  };
  for (const line of patch.split(/\r?\n/)) {
    const header = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (header !== null) {
      add((header[1] ?? "").split(/\t/)[0] ?? "");
      continue;
    }
    const git = /^diff --git\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (git !== null) {
      add(git[1] ?? "");
      add(git[2] ?? "");
    }
  }
  return [...out];
}

/**
 * 补丁正文里点到黑名单路径的地方（不要求是 diff 文件头：整段文本里提到也算）。
 * 归一反斜杠、忽略大小写，宁可错拒。
 */
export function blacklistMention(patch: string): BlacklistRule | null {
  // 先按整段文本归一再比：`src/./gate/policy.ts`、`src//gate/policy.ts` 这种写法
  // 子串匹配是匹不上的（评审实测的第二个绕过口）。归一只做「反斜杠、/./、//」，
  // 不做大小写之外的解释，宁可错拒。
  const text = patch
    .replace(/\\/g, "/")
    .replace(/\/\.\//g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  for (const rule of HARD_BLACKLIST) {
    if (text.includes(rule.path.toLowerCase())) return rule;
  }
  return null;
}

export interface PatchCheck {
  ok: boolean;
  rule: string | null;
  reason: string;
}

/**
 * 补丁正文闸：文件头里的每个路径都要在白名单内且不在黑名单；
 * 括号里提到的黑名单路径也算命中（防「补丁主体打 A，顺手在 B 里插一行」）。
 */
export function checkPatchPaths(patch: string): PatchCheck {
  const paths = patchFilePaths(patch);
  for (const p of paths) {
    const hit = blacklistHit(p);
    if (hit !== null) {
      return { ok: false, rule: hit.id, reason: `补丁要改黑名单文件（${hit.id}：${hit.note}）：${p}` };
    }
    if (!underPrefix(p, WHITELIST_PREFIX)) {
      return { ok: false, rule: "patch_outside_whitelist", reason: `补丁里出现了白名单外的文件：${p}` };
    }
  }
  const mention = blacklistMention(patch);
  if (mention !== null) {
    return {
      ok: false,
      rule: mention.id,
      reason: `补丁正文提到了黑名单路径（${mention.id}：${mention.note}）：${mention.path}`,
    };
  }
  return { ok: true, rule: null, reason: "ok" };
}

// ────────────────────────────────────────────────────────────────────────────
// 最小 unified diff 应用器（配置字段闸与默认检查器都要用）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把一段 unified diff 打到原文上。打不上（上下文对不上/格式坏了）返回 null，
 * 调用方一律按「检查不过」处理，不猜。
 */
export function applyUnifiedDiff(original: string, patch: string): string | null {
  const src = original.split(/\r?\n/);
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  let cursor = 0;
  let i = 0;
  let hunks = 0;

  while (i < lines.length && !(lines[i] ?? "").startsWith("@@")) i += 1;
  if (i >= lines.length) return null;

  while (i < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i] ?? "");
    if (header === null) return null;
    hunks += 1;
    const oldStart = Number(header[1]);
    let pos = oldStart - 1;
    if (pos < cursor || pos > src.length) return null;
    out.push(...src.slice(cursor, pos));
    cursor = pos;
    i += 1;

    while (i < lines.length && !(lines[i] ?? "").startsWith("@@")) {
      const line = lines[i] ?? "";
      const tag = line.slice(0, 1);
      const text = line.slice(1);
      if (tag === "\\") {
        // "\ No newline at end of file"：忽略
        i += 1;
        continue;
      }
      if (line === "") {
        i += 1;
        continue;
      }
      if (tag === " ") {
        if (src[cursor] !== text) return null;
        out.push(src[cursor] as string);
        cursor += 1;
      } else if (tag === "-") {
        if (src[cursor] !== text) return null;
        cursor += 1;
      } else if (tag === "+") {
        out.push(text);
      } else {
        return null;
      }
      i += 1;
    }
  }

  if (hunks === 0) return null;
  out.push(...src.slice(cursor));
  return out.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// 配置字段闸
// ────────────────────────────────────────────────────────────────────────────

/** 只对配置文件的改动行做字段名扫描（兜底；有 root 时走语义比对）。 */
function scanChangedLines(target: string, patch: string): string[] {
  if (!GUARDED_CONFIG_FILES.some((f) => isSamePath(f, target))) return [];
  const looksLikeDiff = /^(\+\+\+ |--- |@@ )/m.test(patch);
  const text = looksLikeDiff
    ? patch
        .split(/\r?\n/)
        .filter(
          (line) =>
            (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")),
        )
        .join("\n")
    : patch;
  const hits: string[] = [];
  for (const field of [...GUARDED_CONFIG_FIELDS, ...GUARDED_CONFIG_NESTED_KEYS]) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${field}([^A-Za-z0-9_]|$)`, "m");
    if (re.test(text)) hits.push(field);
  }
  return hits;
}

function valueAt(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const GUARDED_JSON_PATHS: ReadonlyArray<readonly [string, string[]]> = [
  ["approvals", ["approvals"]],
  ["self_improve", ["self_improve"]],
  ["human_only_apps", ["desktop", "human_only_apps"]],
  ["whitelist", ["exec", "whitelist"]],
];

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function indentOf(line: string): number {
  return (line.match(/^ */) ?? [""])[0].length;
}

function guardedFieldRegex(field: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])${field}([^A-Za-z0-9_]|$)`);
}

/**
 * 改动行落在哪个红线字段的块里（靠缩进找最近的父对象）。
 * 用来兜住「只改嵌套值、父字段名只在上下文行」的改法：只比字段名出现次数查不出来。
 */
function guardedRegionHits(applied: string, patch: string): string[] {
  const lines = applied.split(/\r?\n/);
  const added = patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .filter((line) => line.trim() !== "");
  const hits = new Set<string>();

  for (const text of added) {
    const idx = lines.findIndex((line) => line === text);
    if (idx < 0) continue;
    for (const field of GUARDED_CONFIG_FIELDS) {
      if (guardedFieldRegex(field).test(text)) hits.add(field);
    }
    const indent = indentOf(text);
    for (let j = idx - 1; j >= 0; j -= 1) {
      const line = lines[j] ?? "";
      if (line.trim() === "") continue;
      if (indentOf(line) >= indent) continue;
      const parent = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{/.exec(line);
      if (parent !== null && GUARDED_CONFIG_FIELDS.includes(parent[1] ?? "")) hits.add(parent[1] as string);
      break;
    }
  }
  return [...hits];
}

/**
 * JSON 配置按语义比对：把补丁应用一遍，逐个 guarded 字段比前后值。
 * 这样「父字段只在上下文行、只改嵌套值」也躲不过。
 */
function jsonFieldViolations(target: string, patch: string, root: string): { hits: string[]; note: string | null } {
  const abs = join(root, ...normalizeTarget(target).split("/"));
  if (!existsSync(abs)) return { hits: [], note: null };
  const original = readFileSync(abs, "utf8");
  const applied = applyUnifiedDiff(original, patch);
  if (applied === null) {
    return { hits: ["<无法应用补丁>"], note: "补丁在本机应用不上，无法做字段校验，按拒处理" };
  }
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(original) as unknown;
    after = JSON.parse(applied) as unknown;
  } catch {
    return { hits: ["<改后不是合法 JSON>"], note: "补丁打完后 JSON 解析失败，按拒处理" };
  }
  const hits: string[] = [];
  for (const [name, path] of GUARDED_JSON_PATHS) {
    if (!sameJson(valueAt(before, [...path]), valueAt(after, [...path]))) hits.push(name);
  }
  return { hits, note: null };
}

/**
 * 配置字段闸：返回命中的字段名；空数组 = 没碰红线字段。
 *
 * - 给了 root 且目标是 .json：应用补丁后按字段语义比对（最强）；
 * - 给了 root 且目标是 .ts：应用补丁后比「红线字段名出现次数」，再叠加改动行扫描；
 * - 没给 root：只做改动行扫描（测试直接调时用）。
 */
export function guardedConfigFieldsTouched(
  target: string,
  patch: string,
  opts: { root?: string } = {},
): string[] {
  const t = normalizeTarget(target);
  if (!GUARDED_CONFIG_FILES.some((f) => isSamePath(f, t))) return [];

  const root = opts.root;
  if (root !== undefined) {
    const abs = join(root, ...t.split("/"));
    if (existsSync(abs)) {
      const original = readFileSync(abs, "utf8");
      const applied = applyUnifiedDiff(original, patch);
      if (applied === null) return ["<无法应用补丁>"];

      if (t.toLowerCase().endsWith(".json")) {
        const json = jsonFieldViolations(t, patch, root);
        const region = guardedRegionHits(applied, patch);
        return [...new Set([...json.hits, ...region])];
      }

      // TS：红线字段名出现次数变了（增删/改名）+ 改动行落在红线块里（嵌套值被改）。
      const hits = new Set<string>();
      for (const token of [...GUARDED_CONFIG_FIELDS, ...GUARDED_CONFIG_NESTED_KEYS]) {
        const count = (text: string): number => text.split(token).length - 1;
        if (count(applied) !== count(original)) hits.add(token);
      }
      for (const hit of guardedRegionHits(applied, patch)) hits.add(hit);
      if (hits.size > 0) return [...hits];
    }
  }

  return scanChangedLines(t, patch);
}

// ────────────────────────────────────────────────────────────────────────────
// 检查
// ────────────────────────────────────────────────────────────────────────────

function tail(text: string, limit = 1500): string {
  const t = text.trim();
  return t.length > limit ? t.slice(-limit) : t;
}

/** 在给定根目录里跑全量测试 + 类型检查（不碰补丁；演练/测试可直接用）。 */
export function runFullChecks(root: string): CheckOutcome {
  const run = (args: string[], label: string): CheckOutcome => {
    const r = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error !== undefined && r.error !== null) {
      return { ok: false, detail: `${label}启动失败：${r.error.message}` };
    }
    if (r.status !== 0) {
      return { ok: false, detail: `${label}失败（exit ${r.status}）：${tail(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)}` };
    }
    return { ok: true, detail: `${label} ok` };
  };

  const tests = run(["build/tools/run-tests.mjs"], "全量测试");
  if (!tests.ok) return tests;
  const tsc = run(["build/tools/run-tests.mjs", "--tsc"], "类型检查");
  if (!tsc.ok) return tsc;
  return { ok: true, detail: "全量测试 + 类型检查都过了" };
}

/** 目录树复制：readdir + mkdir + copyFileSync（本机 cpSync 会让进程消失）。 */
function copyTree(src: string, dest: string): void {
  const st = statSync(src);
  if (!st.isDirectory()) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src));
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from));
    // 符号链接/其它类型不跟进去
  }
}

/** 删目录树：unlinkSync + rmdirSync（本机 rmSync 会静默不删）。 */
function removeTree(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) removeTree(p);
    else {
      try {
        unlinkSync(p);
      } catch {
        // 删不掉就留着：副本在临时目录，不影响结论。
      }
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // 非空/被占用：同上。
  }
}

/**
 * 默认检查器：把 build 的四个被测目录复制到临时目录，**在副本上打上补丁**，
 * 再跑全量测试 + 类型检查。仓库本身一个字节都不动。
 *
 * 补丁打不上（上下文对不上）直接算不过——以前只在没打的仓库上跑，
 * 「检查全绿」等于什么都没验证（评审实测过）。
 */
export function runChecksWithPatch(repoRoot: string, target: string, patch: string): CheckOutcome {
  const work = mkdtempSync(join(tmpdir(), "dot-selfimprove-check-"));
  try {
    for (const rel of CHECK_TREE_DIRS) {
      const src = join(repoRoot, ...rel.split("/"));
      if (existsSync(src)) copyTree(src, join(work, ...rel.split("/")));
    }
    const t = normalizeTarget(target);
    const originalAbs = join(repoRoot, ...t.split("/"));
    const targetAbs = join(work, ...t.split("/"));
    if (!existsSync(originalAbs)) {
      return { ok: false, detail: `目标文件不存在，无法在副本上检查：${t}` };
    }
    const applied = applyUnifiedDiff(readFileSync(originalAbs, "utf8"), patch);
    if (applied === null) {
      return { ok: false, detail: `补丁在副本上应用失败（上下文对不上）：${t}` };
    }
    mkdirSync(dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, applied, "utf8");
    return runFullChecks(work);
  } finally {
    removeTree(work);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 应用
// ────────────────────────────────────────────────────────────────────────────

function eventDenied(db: LedgerDb, proposalId: string, target: string, rule: string, reason: string): void {
  appendEvent(db, {
    type: "self_apply_denied",
    payload: { proposal_id: proposalId, target, rule, reason },
  });
}

function eventSkipped(db: LedgerDb, proposalId: string, reason: string): void {
  appendEvent(db, { type: "self_apply_skipped", payload: { proposal_id: proposalId, reason } });
}

/**
 * 删一个补丁文件。
 * 本机 Node v24.13.0 + Windows 实测：`rmSync(file, { force: true })` 会静默不删
 * （不抛错、文件还在），`unlinkSync` 正常。所以这里固定用 unlinkSync。
 */
function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 文件本来就不在：等同于删成功。
  }
}

/** pending 目录空了就顺手删掉；再上一层（build/自我优化）空了也删，不留空壳。 */
function tidyPendingDir(pendingDir: string): void {
  try {
    if (readdirSync(pendingDir).length === 0) rmdirSync(pendingDir);
  } catch {
    // 目录不在 / 非空 / 被占用：都不是错。
  }
  try {
    const parent = dirname(pendingDir);
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {
    // 同上。
  }
}

function deny(
  db: LedgerDb,
  proposalId: string,
  target: string,
  rule: string,
  reason: string,
): ApplyResult {
  eventDenied(db, proposalId, target, rule, reason);
  return { ok: false, reason, rule, patchPath: null, checks: null };
}

/**
 * 跑一次应用：四道闸 → 写 pending 补丁 → 在副本上打补丁并检查 → 过则留补丁，不过则删补丁。
 * 返回值里 `ok` 只代表「补丁已留且打上补丁后检查全绿」；真实源码在任何分支都没被动过。
 */
export function applyProposal(opts: ApplyOptions): ApplyResult {
  const { db, proposal } = opts;
  const config: SelfImproveConfigSlice | undefined = opts.config;

  if (config === undefined || config.self_improve?.enabled !== true) {
    const reason = "自我优化开关关着（self_improve.enabled 不是 true）";
    eventSkipped(db, proposal.id, reason);
    return { ok: false, reason, rule: "disabled", patchPath: null, checks: null };
  }

  const root = opts.root ?? process.cwd();
  const target = normalizeTarget(proposal.target);

  const checked = checkTarget(target, root);
  if (!checked.ok) return deny(db, proposal.id, target, checked.rule ?? "invalid_target", checked.reason);

  const patch = typeof opts.patch === "string" ? opts.patch : "";
  if (patch.trim() === "") return deny(db, proposal.id, target, "empty_patch", "补丁是空的，拒绝落盘");
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    return deny(db, proposal.id, target, "patch_too_large", `补丁超过 ${MAX_PATCH_BYTES} 字节上限，拒绝落盘`);
  }
  if (!patch.includes(target)) {
    return deny(db, proposal.id, target, "patch_target_mismatch", `补丁里没有出现目标路径 ${target}，疑似拿错补丁`);
  }

  // 补丁正文里的每一个文件都要清白（只校验 target 等于留后门）。
  const patchCheck = checkPatchPaths(patch);
  if (!patchCheck.ok) return deny(db, proposal.id, target, patchCheck.rule ?? "bad_patch", patchCheck.reason);

  const guarded = guardedConfigFieldsTouched(target, patch, { root });
  if (guarded.length > 0) {
    return deny(db, proposal.id, target, "schema_field", `补丁要动红线配置字段：${guarded.join(" / ")}`);
  }

  const pendingDir = join(root, PENDING_DIR);
  const patchPath = join(pendingDir, `${proposal.id}.patch`);
  let wrote = false;
  try {
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(patchPath, patch, "utf8");
    wrote = true;

    const checker = opts.runChecks ?? ((ctx: { root: string; target: string }) => runChecksWithPatch(ctx.root, ctx.target, patch));
    let outcome: CheckOutcome;
    try {
      outcome = checker({ root, patchPath, target });
    } catch (err) {
      outcome = { ok: false, detail: `检查器自己抛了：${(err as Error).message}` };
    }

    if (!outcome.ok) {
      removeFile(patchPath);
      tidyPendingDir(pendingDir);
      appendEvent(db, {
        type: "self_apply_rejected",
        payload: {
          proposal_id: proposal.id,
          target,
          patch_path: `${PENDING_DIR}/${proposal.id}.patch`,
          checks: outcome.detail.slice(0, 1500),
          note: "检查没过，补丁已删除，源码未改",
        },
      });
      return { ok: false, reason: "检查没过，补丁已删除", rule: "checks_failed", patchPath: null, checks: outcome.detail };
    }

    appendEvent(db, {
      type: "self_apply_passed",
      payload: {
        proposal_id: proposal.id,
        target,
        patch_path: `${PENDING_DIR}/${proposal.id}.patch`,
        checks: outcome.detail.slice(0, 500),
        note: "补丁已留在 pending，且已在仓库副本上打上补丁跑过检查；等人看过再决定要不要打，源码未改",
      },
    });
    return {
      ok: true,
      reason: "补丁已写入 pending，打上补丁后的检查全绿；源码未改动",
      rule: null,
      patchPath,
      checks: outcome.detail,
    };
  } catch (err) {
    if (wrote) {
      try {
        removeFile(patchPath);
        tidyPendingDir(pendingDir);
      } catch {
        // 删不掉就留着，下面的错误信息已经写明。
      }
    }
    appendEvent(db, {
      type: "self_apply_rejected",
      payload: {
        proposal_id: proposal.id,
        target,
        checks: `写补丁/检查过程出错：${(err as Error).message}`,
        note: "补丁已删除，源码未改",
      },
    });
    return {
      ok: false,
      reason: `写补丁/检查过程出错：${(err as Error).message}`,
      rule: "apply_error",
      patchPath: null,
      checks: null,
    };
  }
}

/** 只读：pending 目录里现在有哪些补丁（体检/演练用）。 */
export function listPendingPatches(root: string): string[] {
  const dir = join(root, PENDING_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".patch")).sort();
}

/** 读一个补丁的正文（人复核时用）。 */
export function readPendingPatch(root: string, proposalId: string): string {
  return readFileSync(join(root, PENDING_DIR, `${proposalId}.patch`), "utf8");
}

/** 确保 pending 目录存在（只在应用路径里用，提案路径不调它）。 */
export function ensurePendingDir(root: string): string {
  const dir = join(root, PENDING_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}
