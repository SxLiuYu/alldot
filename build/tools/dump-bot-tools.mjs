#!/usr/bin/env node
/**
 * 从 ds-bot 会话的 request/header 取权威工具名单（B.11 / B.1）。
 *
 * 数据源两条，按优先级：
 *  1) 本机找到的 session.v4.jsonl（解压的或 .zstd；Node 24 自带 zstd）；
 *  2) build/patches/ds-bot/lib/ 没有名单文件，名单基准在方案 B.1 / 本脚本常量。
 *
 * 只从 request/header 的 data.header.tools[].name 取，不从 assistant 文本、
 * 工具调用记录或提示词里猜。同一 session 多条 header 时取并集（按首次出现排序）。
 *
 * 用法：
 *   node build/tools/dump-bot-tools.mjs [--session <dir|file|zstd>] [--json]
 * 默认扫描：
 *   C:/Users/1/.dsh/sessions/ 下所有 session.v4.jsonl.zstd / .jsonl
 *   （只读，找到含 request/header 的即停）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join } from "node:path";

const DEFAULT_SESSION_ROOT = "C:/Users/1/.dsh/sessions";
const TYPE = "request/header";

export function parseArgs(argv) {
  const o = { session: DEFAULT_SESSION_ROOT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--session") o.session = argv[++i];
    else if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--help") {
      console.log("用法: node build/tools/dump-bot-tools.mjs [--session <dir|file|zstd>] [--json]");
      process.exit(0);
    } else {
      console.error(`未知参数：${argv[i]}`);
      process.exit(2);
    }
  }
  return o;
}

/** 从一个 session.v4.jsonl(.zstd) 里取 request/header 的 tools 名字。 */
export function namesFromSessionFile(file) {
  if (!existsSync(file)) return [];
  let buf = readFileSync(file);
  if (file.endsWith(".zstd") || (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd)) {
    buf = zstdDecompressSync(buf);
  }
  const names = [];
  const seen = new Set();
  for (const line of buf.toString("utf8").split(/\r?\n/)) {
    if (!line || !line.includes(TYPE)) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== TYPE) continue;
    const tools = rec.data?.header?.tools;
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      if (typeof t?.name === "string" && !seen.has(t.name)) {
        seen.add(t.name);
        names.push(t.name);
      }
    }
  }
  return names;
}

/** 收集候选文件（只读）；命中第一个就返回。 */
export function findSessionFiles(root) {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [root];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/(^|\/)session.*\.v4\.jsonl(\.zstd)?$/.test(p.replace(/\\/g, "/"))) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function dump(opts) {
  const files = findSessionFiles(opts.session);
  const hits = [];
  for (const f of files) {
    const names = namesFromSessionFile(f);
    if (names.length > 0) hits.push({ file: f, count: names.length, names });
  }
  return { filesScanned: files.length, hits };
}

export function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = dump(opts);
  if (r.hits.length === 0) {
    console.log(`扫了 ${r.filesScanned} 个 session 文件，没找到含 ${TYPE} 的记录`);
    process.exit(2);
  }
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const h of r.hits) {
      console.log(`# ${h.file}  (${h.count} 个工具)`);
      console.log(h.names.join(", "));
    }
  }
  process.exit(0);
}

if (process.argv[1]?.endsWith("dump-bot-tools.mjs")) main();
