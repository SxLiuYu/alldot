#!/usr/bin/env node
// build/tools/ledger-sweep.mjs —— 账本维护清扫（S1-件8）。
//
// 用法：
//   node build/tools/ledger-sweep.mjs --dry     # 只看会清多少，不动数据
//   node build/tools/ledger-sweep.mjs            # 真清
//   node build/tools/ledger-sweep.mjs --days 7   # 只清 7 天前的（默认 30）
//
// 清什么：
//   1. 终态任务（done/failed/cancelled）且超过 --days 天的：删任务行 + steps + artifacts + workers
//   2. events 表超过 --days 天的：归档到 events-archive.jsonl 再删（保链头）
//   3. spend_ledger 超过 --days 天的：直接删
//
// 不清什么：
//   - running/queued/paused 的任务（还在跑）
//   - approvals 表（审计要求 append-only）
//   - snapshots 表的行（快照文件本身要单独删）

import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".allbot", "dot", "ledger", "dot.db");
const ARCHIVE_PATH = join(homedir(), ".allbot", "dot", "ledger", "events-archive.jsonl");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const daysIdx = args.indexOf("--days");
const rawDays = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;
// --days 最少 1 天：0 或负数会把 cutoff 设成现在/未来，等于删光全部终态数据
const days = Number.isFinite(rawDays) && rawDays >= 1 ? Math.floor(rawDays) : 30;
if (rawDays !== days) console.log(`--days ${rawDays} 不合法，用 ${days} 天（最少 1 天）`);
const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

console.log(`清扫范围：${days} 天前（${cutoff}）的终态任务和事件`);
if (dry) console.log("（--dry 模式：只看不动）");

const db = new DatabaseSync(DB_PATH);

// 1. 找要清的终态任务
const oldTasks = db.prepare(
  `SELECT id, state, updated_at FROM tasks
   WHERE state IN ('done','failed','cancelled','expired') AND updated_at < ?`
).all(cutoff);
console.log(`终态老任务：${oldTasks.length} 个`);

if (oldTasks.length > 0) {
  const ids = oldTasks.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  for (const [table, col] of [["steps","task_id"],["workers","task_id"],["artifacts","task_id"]]) {
    try {
      const n = db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${col} IN (${placeholders})`).get(...ids).n;
      console.log(`  ${table} 里关联 ${n} 行`);
    } catch { /* 表可能没有 task_id 列 */ }
  }
}

// 2. 找要归档的事件
const oldEvents = db.prepare(
  `SELECT COUNT(*) as n FROM events WHERE ts < ?`
).get(cutoff).n;
console.log(`老事件：${oldEvents} 条（会归档到 ${ARCHIVE_PATH}）`);

// 3. 找要清的 spend
const oldSpend = db.prepare(
  `SELECT COUNT(*) as n FROM spend_ledger WHERE created_at < ?`
).get(cutoff).n;
console.log(`老用量记录：${oldSpend} 条`);

if (dry) {
  console.log("\n--dry：没动数据。去掉 --dry 真清。");
  db.close();
  process.exit(0);
}

// ── 真清 ──────────────────────────────────────────────────────────────────
db.exec("BEGIN");

try {
  // 归档事件（保链头：只归档不是第一条的）
  const first = db.prepare("SELECT seq FROM events ORDER BY seq LIMIT 1").get();
  const firstSeq = first?.seq ?? 0;
  const toArchive = db.prepare(
    `SELECT * FROM events WHERE ts < ? AND seq > ? ORDER BY seq`
  ).all(cutoff, firstSeq);
  if (toArchive.length > 0) {
    mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
    for (const evt of toArchive) {
      appendFileSync(ARCHIVE_PATH, JSON.stringify(evt) + "\n", "utf8");
    }
    db.prepare(`DELETE FROM events WHERE ts < ? AND seq > ?`).run(cutoff, firstSeq);
    console.log(`归档了 ${toArchive.length} 条事件`);
  }

  // 删老任务的关联数据
  if (oldTasks.length > 0) {
    const ids = oldTasks.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    for (const [table, col] of [["steps","task_id"],["workers","task_id"]]) {
      try {
        const r = db.prepare(`DELETE FROM ${table} WHERE ${col} IN (${placeholders})`).run(...ids);
        console.log(`删了 ${table} ${r.changes} 行`);
      } catch { /* 表可能没有 task_id 列 */ }
    }
    // artifacts 通过 args_ref/result_ref 关联，不在 tasks 上。跳过。
    const r = db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);
    console.log(`删了 tasks ${r.changes} 行`);
  }

  // 删老 spend
  const r = db.prepare(`DELETE FROM spend_ledger WHERE created_at < ?`).run(cutoff);
  console.log(`删了 spend_ledger ${r.changes} 行`);

  db.exec("COMMIT");
  console.log("\n清扫完成。");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("清扫失败，已回滚：", err.message);
  process.exit(1);
}

// 打印清完后的规模
for (const t of ["tasks","steps","events","artifacts","workers","spend_ledger"]) {
  try {
    const r = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get();
    console.log(`  ${t}: ${r.n}`);
  } catch { /* 忽略 */ }
}
db.close();
