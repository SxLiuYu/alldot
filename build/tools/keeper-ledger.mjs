#!/usr/bin/env node
// keeper-ledger.mjs —— keeper 与账本之间的唯一通道（只读 + 备份 + 队列落链）。
//
// 为什么要单独一个脚本：keeper.ps1 是 PowerShell，账本模块是 TypeScript 的
// build/dot-core/src/ledger（node:sqlite，Node 24 直载 .ts）。keeper 不复制那份代码、
// 也不自己拼 SQL，统一从这里转一手。设计依据：方案 B.7「keeper 不删任何东西、不写 events，
// 账本唯一写入者是 dot-core」、「账本每日备份留 14」、附录 A.9（恢复报告 → 状态页 + 通知脸）。
//
// 三个模式：
//   report --db <path> [--events N]
//       只读打开账本，输出 { ok, eventCount, chain, latestRecoveryReport, tail }。
//       keeper 用它把 A.9 的恢复报告原文带进巡检报告（状态页横幅的数据源）。
//   backup --db <path> --out <path>
//       VACUUM INTO 做一致性备份（WAL 下直接拷文件会漏掉 -wal 里的内容），备份完回读校验。
//   drain  --db <path> [--queue <path>]
//       把 keeper 的事实队列（keeper-report-queue.jsonl）追加成 events.type='keeper_report'。
//       **调用者是 dot-core 的 src/maintenance，不是 keeper**（账本唯一写入口是 dot-core）。
//       keeper 只负责把队列文件写出来。
//
// 约定：stdout 只放一行 JSON；日志/告警走 stderr；退出码 0=成功 1=用法错 2=账本读不了。

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 动态 import 只吃 URL：Windows 绝对路径（C:\…）直接传会报
// "Only URLs with a scheme in: file, data, and node are supported"。
const LEDGER_INDEX = pathToFileURL(resolve(HERE, "../dot-core/src/ledger/index.ts")).href;
const DEFAULT_DB = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".allbot/dot/ledger/dot.db");
const DEFAULT_QUEUE = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".allbot/dot/state/keeper-report-queue.jsonl");

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n`);
  process.stderr.write(
    [
      "用法：",
      "  node build/tools/keeper-ledger.mjs report --db <path> [--events N]",
      "  node build/tools/keeper-ledger.mjs backup --db <path> --out <path>",
      "  node build/tools/keeper-ledger.mjs drain  --db <path> [--queue <path>]",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function parse(argv) {
  const out = { mode: "", db: DEFAULT_DB, out: "", queue: DEFAULT_QUEUE, events: 20 };
  if (argv.length === 0) usage("缺模式");
  out.mode = argv[0];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) usage(`${a} 缺值`);
      i += 1;
      return v;
    };
    if (a === "--db") out.db = next();
    else if (a === "--out") out.out = next();
    else if (a === "--queue") out.queue = next();
    else if (a === "--events") out.events = Math.max(1, Number.parseInt(next(), 10) || 20);
    else usage(`未知参数：${a}`);
  }
  return out;
}

/** 账本模块按需加载：只读/备份都不该因为 import 失败把整个 keeper 带崩。 */
async function loadLedger() {
  return await import(LEDGER_INDEX);
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function openReadOnly(L, path) {
  if (!existsSync(path)) throw new Error(`账本不存在：${path}`);
  return L.openLedger(path, { readOnly: true, createDir: false });
}

async function cmdReport(opts) {
  let L;
  try {
    L = await loadLedger();
  } catch (err) {
    emit({ ok: false, mode: "report", db: opts.db, error: `账本模块加载失败：${err.message}` });
    process.exit(2);
  }
  let db;
  try {
    db = openReadOnly(L, opts.db);
  } catch (err) {
    emit({ ok: false, mode: "report", db: opts.db, error: err.message });
    process.exit(2);
  }
  try {
    const chain = L.verifyChain(db);
    let eventCount = 0;
    try {
      eventCount = Number(db.prepare("SELECT count(*) AS c FROM events").get().c);
    } catch {
      // 表还没建（migrate 没跑）：不算错，报 0。
      eventCount = 0;
    }
    let latestRecoveryReport = null;
    try {
      latestRecoveryReport = L.latestRecoveryReport(db);
    } catch {
      latestRecoveryReport = null;
    }
    let tail = [];
    try {
      tail = L.tailEvents(db, opts.events).map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, taskId: r.task_id }));
    } catch {
      tail = [];
    }
    emit({
      ok: true,
      mode: "report",
      db: opts.db,
      eventCount,
      chain,
      latestRecoveryReport,
      tail,
    });
    process.exit(0);
  } catch (err) {
    emit({ ok: false, mode: "report", db: opts.db, error: err.message });
    process.exit(2);
  } finally {
    try {
      db.close();
    } catch {
      // 关不掉就算了，进程马上退出。
    }
  }
}

async function cmdBackup(opts) {
  if (opts.out === "") usage("backup 缺 --out");
  const L = await loadLedger();
  let db;
  try {
    db = openReadOnly(L, opts.db);
  } catch (err) {
    emit({ ok: false, mode: "backup", db: opts.db, error: err.message });
    process.exit(2);
  }
  let sourceCount = 0;
  try {
    sourceCount = Number(db.prepare("SELECT count(*) AS c FROM events").get().c);
  } catch {
    sourceCount = 0;
  }
  // VACUUM INTO 需要独占一段读；WAL 下它是 SQLite 官方推荐的热备方式。
  db.exec("PRAGMA busy_timeout = 10000");
  mkdirSync(dirname(opts.out), { recursive: true });
  const literal = opts.out.replace(/'/g, "''");
  try {
    db.exec(`VACUUM INTO '${literal}'`);
  } catch (err) {
    emit({ ok: false, mode: "backup", db: opts.db, out: opts.out, error: `VACUUM INTO 失败：${err.message}` });
    process.exit(2);
  } finally {
    try {
      db.close();
    } catch {
      // 同上。
    }
  }
  // 回读校验：备份出来的库能打开、events 行数对得上，才算成功。
  let verify = { ok: false, events: 0, error: "" };
  try {
    const copy = L.openLedger(opts.out, { readOnly: true, createDir: false });
    try {
      let n = 0;
      try {
        n = Number(copy.prepare("SELECT count(*) AS c FROM events").get().c);
      } catch {
        n = 0;
      }
      verify = { ok: n === sourceCount, events: n, error: n === sourceCount ? "" : `events 行数不一致（源 ${sourceCount}／备 ${n}）` };
    } finally {
      copy.close();
    }
  } catch (err) {
    verify = { ok: false, events: 0, error: `备份回读失败：${err.message}` };
  }
  let bytes = 0;
  try {
    bytes = statSync(opts.out).size;
  } catch {
    bytes = 0;
  }
  emit({ ok: verify.ok, mode: "backup", db: opts.db, out: opts.out, bytes, sourceEvents: sourceCount, verify });
  process.exit(verify.ok ? 0 : 2);
}

async function cmdDrain(opts) {
  const L = await loadLedger();
  if (!existsSync(opts.queue)) {
    emit({ ok: true, mode: "drain", queue: opts.queue, appended: 0, skipped: 0, note: "队列文件不存在，没事可做" });
    process.exit(0);
  }
  const raw = readFileSync(opts.queue, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  let db;
  try {
    db = L.openLedger(opts.db);
  } catch (err) {
    emit({ ok: false, mode: "drain", db: opts.db, error: err.message });
    process.exit(2);
  }
  let appended = 0;
  let skipped = 0;
  try {
    for (const line of lines) {
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      L.appendEvent(db, { type: "keeper_report", payload });
      appended += 1;
    }
  } catch (err) {
    emit({ ok: false, mode: "drain", db: opts.db, appended, skipped, error: err.message });
    process.exit(2);
  } finally {
    db.close();
  }
  // 全部落链之后才清队列；中途失败保留原文，下次重试。
  writeFileSync(opts.queue, "", "utf8");
  emit({ ok: true, mode: "drain", queue: opts.queue, appended, skipped });
  process.exit(0);
}

const opts = parse(process.argv.slice(2));
if (opts.mode === "report") await cmdReport(opts);
else if (opts.mode === "backup") await cmdBackup(opts);
else if (opts.mode === "drain") await cmdDrain(opts);
else usage(`未知模式：${opts.mode}`);
