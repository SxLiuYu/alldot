#!/usr/bin/env node
// build/dot-bridge/install-brain-capability.mjs —— 给 ds-bot 的 state.json 加
// MCP 能力 `brain`（方案 B.1「数据侧」、B.6）。
//
// 这是一个**安装脚本**：默认只读 + 打印计划，带 --apply 才写盘；写盘前先备份。
// 不要在本脚本里起停 ds-bot —— 关 ds-bot 由人来做（它运行中会把内存状态写回
// state.json，运行时改必被覆盖，B.1 原文）。
//
//   node build/dot-bridge/install-brain-capability.mjs                 # 只看计划
//   node build/dot-bridge/install-brain-capability.mjs --apply         # 真的写
//   node ... --state C:/Users/1/.dsh/bot/state.json --url http://127.0.0.1:8799/mcp
//
// 装之前要做的（脚本无法代做）：
//   1. 关掉 ds-bot；
//   2. 确认 ~/.allbot/dot/bridge-token 已存在（桥没 token 会 503）；
//   3. 跑本脚本 --apply；
//   4. 启动桥：node build/dot-bridge/index.mjs；
//   5. 再启动 ds-bot，看 10 个机器人是否都挂上了 brain 能力。
//
// 认不出的 state.json 结构（比如升级后改了字段名）一律停手，不猜。

import { copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
  state: "C:/Users/1/.dsh/bot/state.json",
  tokenFile: join(homedir(), ".allbot", "dot", "bridge-token"),
  url: "http://127.0.0.1:8799/mcp",
  name: "brain",
};

function parseArgs(argv) {
  const out = { apply: false, authHeader: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") {
      out.apply = true;
      continue;
    }
    if (a === "--no-auth-header") {
      out.authHeader = false;
      continue;
    }
    if (a === "--help") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`参数 --${key} 需要一个值`);
      process.exit(2);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function die(message) {
  console.error(`[install-brain] ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "用法：node build/dot-bridge/install-brain-capability.mjs [--apply] [--state <path>] [--url <mcp-url>] [--token-file <path>] [--no-auth-header]",
  );
  process.exit(0);
}

const statePath = args.state ?? DEFAULTS.state;
const url = args.url ?? DEFAULTS.url;
const name = args.name ?? DEFAULTS.name;
const tokenFile = args["token-file"] ?? DEFAULTS.tokenFile;

if (!/^https?:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) {
  die(`url 必须是本机 127.0.0.1 上的 /mcp（A.3 只听本机），收到 ${url}`);
}

let raw;
try {
  raw = readFileSync(statePath, "utf8");
} catch (err) {
  die(`读不到 state.json：${statePath}（${err instanceof Error ? err.message : String(err)}）`);
}
let state;
try {
  state = JSON.parse(raw);
} catch (err) {
  die(`state.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
}
if (state === null || typeof state !== "object" || Array.isArray(state)) {
  die("state.json 顶层不是对象，停手");
}
const capabilities = state.capabilities;
if (
  capabilities === null ||
  typeof capabilities !== "object" ||
  typeof capabilities.items !== "object" ||
  capabilities.items === null
) {
  die("state.json 里没有 capabilities.items（版本可能变了），停手，别猜");
}
if (state.bots === null || typeof state.bots !== "object") {
  die("state.json 里没有 bots，停手");
}

let headers;
if (args.authHeader) {
  let token;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    die(`要带鉴权头但 token 文件不存在：${tokenFile}。先建 token，或加 --no-auth-header`);
  }
  if (token === "") die(`token 文件是空的：${tokenFile}`);
  // 8799 的桥同时认 Authorization 与 x-dot-bridge-token；两个都写，换传输不改配置。
  headers = { Authorization: `Bearer ${token}`, "x-dot-bridge-token": token };
} else {
  headers = {};
}

const previous = capabilities.items[name];
if (previous !== undefined && previous !== null) {
  if (previous.kind !== "mcp") {
    die(`capabilities.items.${name} 已存在且 kind=${String(previous.kind)}，不是 mcp；换 --name 或先手工处理`);
  }
}

const nowMs = Date.now();
const item = {
  name,
  kind: "mcp",
  description: "dot 大脑（dot-bridge）：brain_task / brain_status / brain_answer / brain_cancel",
  createdBy: previous?.createdBy ?? null,
  createdAt: previous?.createdAt ?? nowMs,
  updatedAt: nowMs,
  transport: "streamable-http",
  url,
  headers,
  approved: true,
};

const bots = state.bots;
const botIds = Object.keys(bots);
const toAttach = [];
const already = [];
for (const id of botIds) {
  const bot = bots[id];
  if (bot === null || typeof bot !== "object") continue;
  const list = Array.isArray(bot.capabilities) ? bot.capabilities : null;
  if (list === null) {
    die(`bots.${id}.capabilities 不是数组，停手（版本可能变了）`);
  }
  if (list.includes(name)) already.push(id);
  else toAttach.push(id);
}

const itemChanged =
  previous === undefined ||
  previous.url !== item.url ||
  previous.transport !== item.transport ||
  previous.approved !== true ||
  JSON.stringify(previous.headers ?? {}) !== JSON.stringify(headers);

console.log(`[install-brain] state.json  ${statePath}（${(statSync(statePath).size / 1024 / 1024).toFixed(1)} MB）`);
console.log(`[install-brain] 能力 ${name}：${previous === undefined ? "新增" : itemChanged ? "更新" : "已是最新"}`);
console.log(`[install-brain] 机器人 ${botIds.length} 个：已挂 ${already.length} 个，要挂 ${toAttach.length} 个`);
console.log(`[install-brain] url ${url}`);
console.log(`[install-brain] 鉴权头 ${args.authHeader ? "Authorization: Bearer <token 文件内容>" : "不带（--no-auth-header）"}`);

if (!args.apply) {
  console.log("[install-brain] 这是预演。确认无误后加 --apply；先关 ds-bot 再写。");
  process.exit(0);
}

if (itemChanged) capabilities.items[name] = item;
for (const id of toAttach) {
  bots[id].capabilities.push(name);
}

const backupPath = `${statePath}.bak-brain-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(statePath, backupPath);
console.log(`[install-brain] 备份 ${backupPath}`);

const tmpPath = `${statePath}.tmp-brain-${process.pid}`;
const serialized = JSON.stringify(state);
writeFileSync(tmpPath, serialized, "utf8");
// 写回前再解析一遍，防止序列化出坏东西。
try {
  JSON.parse(readFileSync(tmpPath, "utf8"));
} catch (err) {
  die(`写出的临时文件不是合法 JSON，没替换原文件：${err instanceof Error ? err.message : String(err)}`);
}
renameSync(tmpPath, statePath);

// 回读校验：三件事都要成立才算装好。
const check = JSON.parse(readFileSync(statePath, "utf8"));
const okItem = check.capabilities?.items?.[name]?.kind === "mcp" && check.capabilities.items[name].approved === true;
const missing = Object.keys(check.bots ?? {}).filter((id) => !(check.bots[id].capabilities ?? []).includes(name));
if (!okItem || missing.length > 0) {
  die(`回读校验失败（能力项=${okItem}，没挂上的机器人=${missing.join(",") || "无"}）。备份在 ${backupPath}，可以手工回滚`);
}
console.log(`[install-brain] 写完并回读通过：${botIds.length} 个机器人都挂上了 ${name}`);
console.log("[install-brain] 下一步：起桥 → 再起 ds-bot → 检查 10 个机器人的工具列表里出现 mcp__brain__brain_task。");
