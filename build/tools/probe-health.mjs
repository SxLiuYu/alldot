#!/usr/bin/env node
// probe-health.mjs —— keeper 的健康探针。依据方案 B.11：
//   「probe-health.mjs（三档说话探针＋磁盘探针；**无状态**，只打印 JSON；
//     开关：--once（单次即判，供验收用，跳过防抖）、--base-url <url>（指向假上游）、
//     --disk-free-mb N（伪造盘剩余，只影响判定、不实际占盘）；日常由 keeper.ps1 每 5 分钟调，
//     防抖状态写 keeper 自己的 state/keep.json）」
//
// 为什么单独成文件：判定只能有一份。keeper.ps1 只负责调度、退避、写状态文件，
// 不再自己拼一套 HTTP 判定（两套必然分叉，B.7 的 30 秒重测就是在分叉里丢的）。
//
// 输出（stdout 一行 JSON，日志走 stderr）：
//   {
//     "ok": true,
//     "probedAt": "2026-11-24T22:00:00.000Z",
//     "baseUrl": "http://127.0.0.1:3065",
//     "once": false,
//     "disk": { "freeMb": 13925.1, "paths": [{ "path": "…", "freeMb": 13925.1 }], "error": null },
//     "balance": {
//       "enabled": true,
//       "retested": ["balanced"],
//       "cheap":    { "level": "green", "note": "HTTP 200", "status": 200, "attempts": 1 },
//       "balanced": { "level": "red",   "note": "两次都失败：insufficient_quota", "status": 429, "attempts": 2 },
//       "strong":   { "level": "unknown", "note": "没配模型名", "status": 0, "attempts": 0 }
//     }
//   }
//
// 判定顺序（B.7 写死，先看正文再看码）：
//   ① 正文含 余额不足／insufficient_quota／quota exceeded → red「这一档账户没钱」
//   ② 401/403 → red「这一档密钥失效」
//   ③ 其余 429 → yellow「被限流」
//   ④ 连不上 → red（同 3065 那条）
//   402（要钱）→ red
//
// 防抖（B.7）：单次失败先记黄，30 秒后立刻重测，两次都失败才转红。
// 这是**本轮内**的重测；跨轮的状态（keep.json 里的累计）由 keeper 管。
// `--once` 跳过重测，单次即判（验收用）。

import { statfsSync } from "node:fs";

export const TIERS = ["cheap", "balanced", "strong"];
export const DEFAULT_BASE_URL = "http://127.0.0.1:3065";
export const DEFAULT_RETEST_MS = 30_000;

/** B.7 的判定顺序，先看正文再看码。返回 {level, note}。 */
export function classifyBalanceRaw(raw) {
  const status = Number(raw?.status ?? 0);
  const body = String(raw?.body ?? "");
  const error = String(raw?.error ?? "");
  if (!Number.isFinite(status)) return { level: "unknown", note: "响应状态读不出" };
  if (status === 0 && error !== "") return { level: "red", note: `连不上：${error}` };
  const lower = body.toLowerCase();
  if (
    lower.includes("insufficient_quota") ||
    lower.includes("quota exceeded") ||
    lower.includes("quota_exceeded") ||
    lower.includes("insufficient balance")
  ) {
    return { level: "red", note: "这一档账户没钱（正文 insufficient_quota/quota exceeded）" };
  }
  if (/余额不足|余额已用尽|账户余额/.test(body)) {
    return { level: "red", note: "这一档账户没钱（正文提到余额）" };
  }
  if (status === 401 || status === 403) return { level: "red", note: `这一档密钥失效（HTTP ${status}）` };
  if (status === 402) return { level: "red", note: "这一档账户要充值（HTTP 402）" };
  if (status === 429) return { level: "yellow", note: "被限流（HTTP 429）" };
  if (status >= 200 && status < 300) return { level: "green", note: `HTTP ${status}` };
  if (status === 0) return { level: "unknown", note: "没有响应" };
  return { level: "yellow", note: `HTTP ${status}` };
}

/** 盘剩余（MB，1 位小数）。读不到返回 null，不编数。 */
export function diskFreeMb(path) {
  try {
    const st = statfsSync(path);
    const bytes = Number(st.bavail) * Number(st.bsize);
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

async function probeTier(baseUrl, model, timeoutMs) {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 2000), error: "", ms: Date.now() - started };
  } catch (err) {
    return { status: 0, body: "", error: (err && err.message) || String(err), ms: Date.now() - started };
  }
}

export function parseModels(text) {
  const out = {};
  for (const piece of String(text ?? "").split(",")) {
    const [tier, ...rest] = piece.split("=");
    const name = rest.join("=").trim();
    if (TIERS.includes(tier.trim()) && name !== "") out[tier.trim()] = name;
  }
  return out;
}

export function parseArgs(argv) {
  const opts = {
    once: false,
    baseUrl: DEFAULT_BASE_URL,
    diskFreeMb: null,
    diskPaths: [],
    models: {},
    skipBalance: false,
    retestMs: DEFAULT_RETEST_MS,
    timeoutMs: 10_000,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 缺值`);
      i += 1;
      return v;
    };
    if (a === "--once") opts.once = true;
    else if (a === "--base-url") opts.baseUrl = next();
    else if (a === "--disk-free-mb") opts.diskFreeMb = Number(next());
    else if (a === "--disk-path") opts.diskPaths.push(next());
    else if (a === "--models") opts.models = parseModels(next());
    else if (a === "--skip-balance") opts.skipBalance = true;
    else if (a === "--retest-ms") opts.retestMs = Math.max(0, Number(next()));
    else if (a === "--timeout-ms") opts.timeoutMs = Math.max(100, Number(next()));
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

export const HELP = `probe-health.mjs —— keeper 的磁盘与模型账户探针（无状态）

用法：
  node build/tools/probe-health.mjs [选项]

选项：
  --once                  单次即判，跳过 30 秒重测（验收用）
  --base-url <url>        模型池地址，默认 http://127.0.0.1:3065
  --disk-free-mb <N>      伪造盘剩余，只影响输出、不实际占盘
  --disk-path <path>      要查的盘路径，可重复；缺省查当前盘
  --models cheap=<模型>,balanced=<模型>,strong=<模型>
                          三档模型名；没给就是 unknown（不编数）
  --skip-balance          只做磁盘探针
  --retest-ms <N>         重测间隔，默认 30000（B.7）
  --timeout-ms <N>        单次请求超时，默认 10000
`;

export async function run(opts) {
  const probedAt = new Date().toISOString();

  // 磁盘：只读盘面，不动盘上任何东西
  const paths = opts.diskPaths.length > 0 ? opts.diskPaths : [process.cwd()];
  const diskPaths = paths.map((p) => ({ path: p, freeMb: diskFreeMb(p) }));
  let freeMb = null;
  if (opts.diskFreeMb !== null && Number.isFinite(opts.diskFreeMb)) {
    freeMb = opts.diskFreeMb;
  } else {
    for (const p of diskPaths) {
      if (p.freeMb !== null && (freeMb === null || p.freeMb < freeMb)) freeMb = p.freeMb;
    }
  }

  // 账户：三档各发一次 max_tokens=1。3065 的十个模型可能路由到不同上游账户，只探一档会漏。
  const balance = { enabled: !opts.skipBalance, retested: [], cheap: null, balanced: null, strong: null };
  for (const tier of TIERS) {
    if (opts.skipBalance) {
      balance[tier] = { level: "unknown", note: "没开账户探针", status: 0, attempts: 0 };
      continue;
    }
    const model = opts.models[tier];
    if (!model) {
      balance[tier] = { level: "unknown", note: "没配模型名", status: 0, attempts: 0 };
      continue;
    }
    const first = await probeTier(opts.baseUrl, model, opts.timeoutMs);
    const firstVerdict = classifyBalanceRaw(first);
    let finalRaw = first;
    let finalVerdict = firstVerdict;
    let attempts = 1;
    if (firstVerdict.level !== "green" && firstVerdict.level !== "unknown" && !opts.once) {
      // B.7：单次失败先记黄，30 秒后立刻重测，两次都失败即转红
      await new Promise((resolve) => setTimeout(resolve, opts.retestMs));
      finalRaw = await probeTier(opts.baseUrl, model, opts.timeoutMs);
      finalVerdict = classifyBalanceRaw(finalRaw);
      attempts = 2;
      balance.retested.push(tier);
    }
    let note = finalVerdict.note;
    if (attempts === 2) {
      note = finalVerdict.level === "green" ? "重测通过" : `两次都失败：${finalVerdict.note}`;
    }
    balance[tier] = {
      level: finalVerdict.level,
      note,
      status: finalRaw.status,
      attempts,
      firstLevel: firstVerdict.level,
    };
  }

  return {
    ok: true,
    probedAt,
    baseUrl: opts.baseUrl,
    once: opts.once,
    disk: {
      freeMb,
      paths: diskPaths,
      forged: opts.diskFreeMb !== null,
      error: freeMb === null ? "读不到剩余空间" : null,
    },
    balance,
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${HELP}`);
    process.exit(1);
  }
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  try {
    const out = await run(opts);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: (err && err.message) || String(err), probedAt: new Date().toISOString() })}\n`,
    );
    process.exit(2);
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("probe-health.mjs");
if (invokedDirectly) await main();
