#!/usr/bin/env node
// build/dot-bridge/index.mjs —— 8799 上 dot-bridge 的独立入口（B.6）。
//
//   node build/dot-bridge/index.mjs
//   node build/dot-bridge/index.mjs --port 8799 --data-dir C:/Users/1/.allbot/dot
//
// 参数（都有默认值，日常不用带）：
//   --port <n>            默认 8799；0 = 随机端口（测试用）
//   --host <addr>         覆盖监听地址；不传时按 config.mobile_access.mode：
//                         loopback=127.0.0.1，lan/tunnel/relay=0.0.0.0
//   --data-dir <dir>      默认 ~/.allbot/dot；下面是 token/ledger/state 的相对布局
//   --ledger <path>       默认 <data-dir>/ledger/dot.db
//   --token-file <path>   默认 <data-dir>/bridge-token
//   --keep <path>         默认 <data-dir>/state/keep.json
//   --config <path>       默认 ~/.allbot/allbot.json（只读它拿网关 token，A.3 第一层）
//   --upstream <url>      默认 http://127.0.0.1:18789
//   --dsbot <url>         默认 http://127.0.0.1:8797（通知转发的下一跳）
//   --dsbot-bot <id|name> 默认总管 Chief 的 id（send_to_bot 必填的 bot，见 mcp-server.js:44-51）
//   --notify-error-log <path>  默认 <data-dir>/state/notify-errors.jsonl（通知失败记录）
//   --min-free-mb <n>     默认 800（低于它拒新任务，B.7）
//   --version <s>         状态页/initialize 里报的版本
//
// 行为：token 文件不存在也照常监听（/health 会报 ok:false），但除 /health 外
// 全部请求回 503 —— 「没有 token 就拒」在请求层，而不是拒绝启动：
// keeper 需要能探到 /health 才知道桥起没起。

import { join } from "node:path";
import {
  createBridgeService,
  DEFAULT_PORT,
  DEFAULT_MIN_FREE_MB,
  readBridgeToken,
  resolveDotPaths,
} from "../dot-core/src/bridge/index.ts";
import { defaultConfig, loadConfig } from "../dot-core/src/config.ts";
import { createSayRewriter } from "../dot-core/src/say/index.ts";
import { createPoolModelComplete, readPoolEndpoint } from "../dot-core/src/dispatch/local-worker.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
    const key = a.slice(2);
    if (key === "help") {
      out.help = true;
      continue;
    }
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

function intArg(value, fallback, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`参数 --${name} 要是非负整数，收到 ${value}`);
    process.exit(2);
  }
  return n;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("用法：node build/dot-bridge/index.mjs [--port 8799] [--data-dir <dir>] [--upstream <url>]");
  process.exit(0);
}

const port = intArg(args.port, DEFAULT_PORT, "port");
const minFreeMb = intArg(args["min-free-mb"], DEFAULT_MIN_FREE_MB, "min-free-mb");

// 说人话改写（第 3 步 C）：读 <dotDir>/config.json；开关默认关。
// 关着就不注入 say —— 请示卡逐字不动。开着才把「给人看的部分」交模型改写；
// 模型没配 key / 抛错时 say 层原样返回，不影响通知转发。
const dotPaths = resolveDotPaths({
  dotDir: args["data-dir"],
  ledgerPath: args.ledger,
  tokenPath: args["token-file"],
  keepPath: args.keep,
  configPath: args.config,
});
const dotConfig = (() => {
  try {
    return loadConfig(join(dotPaths.dotDir, "config.json"), { missingOk: true });
  } catch (err) {
    // 改写不是关键路径：dot 配置坏了不该让桥起不来，退回「关」。
    console.error(`[dot-bridge] 读 dot 配置失败（说人话改写按关闭处理）：${err instanceof Error ? err.message : String(err)}`);
    return defaultConfig();
  }
})();
let say;
if (dotConfig.say.enabled) {
  const pool = createPoolModelComplete(undefined, undefined, () => readPoolEndpoint(dotPaths.configPath));
  const complete = async (prompt) => (await pool({ messages: [{ role: "user", content: prompt }], tools: [] })).text;
  say = createSayRewriter({ enabled: true, complete });
}

const service = createBridgeService({
  port,
  // 不传 host 时由 server.ts 按 config.mobile_access.mode 决定：
  // loopback=127.0.0.1，lan/tunnel/relay=0.0.0.0。显式 --host 可覆盖。
  ...(args.host === undefined ? {} : { host: args.host }),
  access: {
    mode: dotConfig.mobile_access.mode,
    host:
      dotConfig.mobile_access.mode === "loopback"
        ? "127.0.0.1"
        : "0.0.0.0",
    allowed_cidrs: dotConfig.mobile_access.allowed_cidrs,
  },
  voice: dotConfig.voice,
  pathOptions: {
    dotDir: dotPaths.dotDir,
    ledgerPath: dotPaths.ledgerPath,
    tokenPath: dotPaths.tokenPath,
    keepPath: dotPaths.keepPath,
    configPath: dotPaths.configPath,
  },
  upstreamBaseUrl: args.upstream,
  dsBotBaseUrl: args.dsbot,
  dsBotBot: args["dsbot-bot"],
  notifyErrorLogPath: args["notify-error-log"],
  minFreeMb,
  version: args.version,
  ...(say === undefined ? {} : { say }),
  logger: (line) => console.error(line),
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`[dot-bridge] 收到 ${signal}，关闭中`);
  try {
    await service.stop();
    process.exit(0);
  } catch (err) {
    console.error(`[dot-bridge] 关闭失败：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  const { url } = await service.start();
  console.log(`dot-bridge listening on ${url}`);
  console.log(`  账本   ${service.paths.ledgerPath}（只读）`);
  console.log(`  token  ${service.paths.tokenPath}`);
  console.log(`  网关token ${service.paths.configPath}（只读）`);
  console.log(`  说人话改写 ${say === undefined ? "关（卡片逐字不动）" : "开"}`);
  const tokenState = readBridgeToken(service.paths.tokenPath);
  if (tokenState.token === null) {
    console.error(`[dot-bridge] 警告：${tokenState.error}（${tokenState.path}）`);
    console.error("[dot-bridge] 在 token 补上之前，除 /health 外的请求一律 503。");
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE/i.test(message)) {
    console.error(`[dot-bridge] 端口 ${port} 已被占用：${message}`);
    console.error("[dot-bridge] 查占用：netstat -ano | findstr :8799；先停旧的桥再起。");
  } else {
    console.error(`[dot-bridge] 起不来：${message}`);
  }
  process.exit(1);
}
