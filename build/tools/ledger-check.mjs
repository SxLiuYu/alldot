#!/usr/bin/env node
// build/tools/ledger-check.mjs —— 账本完整性检查（方案附录 C 第 1 步）。
//
//   node build/tools/ledger-check.mjs               检查默认账本
//   node build/tools/ledger-check.mjs --db <path>   检查指定账本
//   node build/tools/ledger-check.mjs --events 10   顺带看最近 10 条事件
//
// 输出三块（验收要求）：
//   chain ok / chain BROKEN   哈希链完整性
//   open steps                没收尾的步骤（start 了没 end，或 end 时没标终态）
//   recovery report           最近一次恢复报告原文
//
// 退出码：0 全过 / 1 有断链或有孤儿步骤 / 2 打不开账本。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 动态 import 只吃 URL（Windows 盘符路径直接传会报 scheme 错误）。
const LEDGER_INDEX = new URL("../dot-core/src/ledger/index.ts", import.meta.url).href;
const DEFAULT_DB = join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  ".allbot", "dot", "ledger", "dot.db",
);

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n`);
  process.stderr.write(
    ["用法：node build/tools/ledger-check.mjs [--db <path>] [--events N]", ""].join("\n"),
  );
  process.exit(2);
}

let dbPath = DEFAULT_DB;
let eventCount = 0;
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--db") {
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith("--")) usage("--db 缺值");
    dbPath = v;
    i += 1;
  } else if (a === "--events") {
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith("--")) usage("--events 缺值");
    eventCount = Math.max(0, Math.floor(Number(v)));
    i += 1;
  } else {
    usage(`不认识的参数 ${a}`);
  }
}

const { openLedger, verifyChain, listTasks, tailEvents, latestRecoveryReport } = await import(
  LEDGER_INDEX
);

let db;
try {
  db = openLedger(dbPath, { readOnly: true });
} catch (err) {
  console.error(`账本打不开：${dbPath}（${err.message}）`);
  process.exit(2);
}

try {
  const TERMINAL = new Set(["succeeded", "failed", "interrupted", "skipped", "rolled_back"]);

  // ① 哈希链
  const chain = verifyChain(db);
  if (chain.ok) {
    console.log(`chain ok（${chain.count} 条事件，末链 ${chain.lastHash.slice(0, 12)}…）`);
  } else {
    console.log(
      `chain BROKEN（断在 events.seq=${chain.brokenAt}，原因 ${chain.reason}，共 ${chain.count} 条）`,
    );
  }

  // ② 没收尾的步骤：全表扫（不是按任务扫），带任务号
  const open = db
    .prepare(
      `SELECT task_id, seq, tool, status, started_at FROM steps
       WHERE status NOT IN (${[...TERMINAL].map(() => "?").join(",")}) ORDER BY task_id, seq`,
    )
    .all(...TERMINAL);
  if (open.length === 0) {
    console.log("open steps：0（所有步骤都有终态）");
  } else {
    console.log(`open steps：${open.length} 条`);
    for (const s of open.slice(0, 20)) {
      console.log(`  ${s.task_id} seq=${s.seq} ${s.tool} status=${s.status} started=${s.started_at ?? "-"}`);
    }
    if (open.length > 20) console.log(`  …（还有 ${open.length - 20} 条）`);
  }

  // ③ 最近一次恢复报告原文
  const report = latestRecoveryReport(db);
  if (report === null || report === undefined) {
    console.log("recovery report：还没有恢复记录");
  } else {
    console.log("recovery report：");
    console.log(JSON.stringify(report, null, 2));
  }

  // ④ 顺带看几条最近事件（--events N）
  if (eventCount > 0) {
    const events = tailEvents(db, eventCount);
    console.log(`recent events（${events.length} 条）：`);
    for (const e of events) {
      console.log(`  seq=${e.seq} ${e.ts} ${e.type} task=${e.task_id ?? "-"} ${(e.payload_json ?? "").slice(0, 100)}`);
    }
  }

  process.exit(chain.ok && open.length === 0 ? 0 : 1);
} finally {
  db.close();
}
