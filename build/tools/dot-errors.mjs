#!/usr/bin/env node
// build/tools/dot-errors.mjs —— 一条命令看所有报错（网关日志 + 账本 + 通知失败）。
//
// 用法：
//   node build/tools/dot-errors.mjs              # 最近 2 小时的所有报错
//   node build/tools/dot-errors.mjs --hours 24   # 最近 24 小时
//   node build/tools/dot-errors.mjs --tail 50    # 最多显示 50 条
//
// 输出格式：时间 | 来源 | 错误摘要。人类能直接读。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const hoursIdx = args.indexOf("--hours");
const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 2;
const tailIdx = args.indexOf("--tail");
const maxShow = tailIdx >= 0 ? Number(args[tailIdx + 1]) : 30;
const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 2;
const safeMaxShow = Number.isFinite(maxShow) && maxShow > 0 ? maxShow : 30;
const cutoff = Date.now() - safeHours * 3600_000;

const DOT = join(homedir(), ".allbot", "dot");
const LOGS = join(DOT, "logs");
const errors = [];

// ── 1) 网关日志里的 error / warn ──────────────────────────────────────────
try {
  const files = readdirSync(LOGS).filter((f) => f.endsWith(".log")).sort().reverse();
  for (const file of files) {
    const path = join(LOGS, file);
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      // 匹配 ISO 时间戳
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(line);
      if (m === null) continue;
      const ts = new Date(m[1]).getTime();
      if (ts < cutoff) continue;
      // 只取 error / warn / 异常
      if (/\[error\]|\[warn\]|Error|Exception|失败|抛错|超时|ENOENT|ECONNREFUSED/i.test(line)) {
        errors.push({
          ts: m[1],
          source: file.replace(/\.log$/, ""),
          text: line.replace(/^\S+\s+\[[^\]]+\]\s*/, "").slice(0, 120),
        });
      }
    }
    // 只看最近 3 个日志文件，别把历史全扫一遍
    if (errors.length >= safeMaxShow * 3) break;
  }
} catch { /* 日志目录可能不存在 */ }

// ── 2) notify-errors.jsonl ───────────────────────────────────────────────
try {
    const path = join(DOT, "state", "notify-errors.jsonl");
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const evt = JSON.parse(line);
        const ts = new Date(evt.ts ?? evt.time ?? 0).getTime();
        if (ts < cutoff) continue;
        errors.push({ ts: new Date(ts).toISOString(), source: "notify", text: (evt.error ?? evt.message ?? JSON.stringify(evt)).slice(0, 120) });
      } catch { /* 忽略坏行 */ }
    }
  }
} catch { /* 文件可能不存在 */ }

// ── 3) 账本 events 里的 error 类事件 ─────────────────────────────────────
try {
  const dbPath = join(DOT, "ledger", "dot.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      `SELECT ts, task_id, type, payload_json FROM events
       WHERE ts >= ? AND (type LIKE '%error%' OR type LIKE '%fail%')
       ORDER BY ts DESC LIMIT 50`
    ).all(new Date(cutoff).toISOString());
    for (const r of rows) {
      errors.push({ ts: r.ts, source: `ledger/${r.type}`, text: (r.payload_json ?? "").slice(0, 120) });
    }
    db.close();
  }
} catch { /* 账本可能没建 */ }

// ── 按时间排序、去重、输出 ──────────────────────────────────────────────
errors.sort((a, b) => b.ts.localeCompare(a.ts));
const seen = new Set();
const unique = [];
for (const e of errors) {
  const key = e.text.slice(0, 60);
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(e);
}

const show = unique.slice(0, safeMaxShow);
if (show.length === 0) {
  console.log(`最近 ${safeHours} 小时没有报错。`);
} else {
  console.log(`最近 ${safeHours} 小时报错 ${unique.length} 条（显示前 ${show.length} 条）：\n`);
  for (const e of show) {
    console.log(`[${e.ts}] [${e.source}] ${e.text}`);
  }
}
