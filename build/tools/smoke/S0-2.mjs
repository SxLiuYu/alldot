#!/usr/bin/env node
/**
 * S0-2 身份探针（第 0 步冒烟，方案 v2 定稿第 7 节 / A.4 / 附录 C）
 *
 * 验什么：
 *  1. 在临时配置副本上挂两个测试工具，各调一次，抓 before_tool_call 钩子载荷：
 *       - 插件自带工具（api.registerTool）→ 期望带齐 {agentId, sessionKey, runId}
 *       - 外挂 MCP 工具（config.mcp.servers）→ 按评审推断不带身份（无 agentId/sessionKey/runId）
 *  2. node:sqlite 在大脑进程里能开库（:memory: 建表、插入、查询）
 *
 * 输出：每项打印实际键名清单（ctx / event / 记录字段）与 PASS/FAIL。
 * 退出码：0 通过；1 有断言不过；2 环境/用法错误（含拒绝以正式配置运行）。
 *
 * 安全约束（硬要求）：
 *  - 正式配置 C:/Users/1/.allbot/allbot.json 一个字节都不写：只读哈希，前后比对。
 *  - --config 只接受「临时副本」：与正式配置是同一文件（路径/硬链接/联接）或内容逐字节相同
 *    的，直接拒绝；副本 gateway.bind 必须是 loopback（或 custom 到 127.0.0.1）。
 *  - 副本由 --prepare 生成（tmp/allbot-smoke.json）：从正式配置复制，只改三处：
 *      gateway.bind -> loopback、gateway.port -> 36719（被占则换空闲口）、
 *      默认模型 -> http://127.0.0.1:3065（本机模型池，保留原模型 id）。
 *  - 脚本运行时再把副本复制到系统临时目录做「实例配置」（端口再随机、模型指本机假上游），
 *    起网关时用 ALLBOT_CONFIG_PATH 指向它。副本与正式配置全程只读。
 *
 * 做法：
 *  - 生成的测试插件注册 probe 工具，并在 before_tool_call 钩子里把 event/ctx 原样追加到 JSONL；
 *    同一进程里试 node:sqlite。脚本读 JSONL 做断言（只读日志，不改配置）。
 *  - 假 OpenAI 兼容上游按请求里的 tools 名单依次要求调用插件工具、MCP 工具，然后收尾。
 *
 * 用法：
 *   node build/tools/smoke/S0-2.mjs --prepare                 # 生成 tmp/allbot-smoke.json（已存在则拒绝，--force 覆盖）
 *   node build/tools/smoke/S0-2.mjs --config tmp/allbot-smoke.json [--keep] [--json]
 *
 * 参数：
 *   --config <路径>        临时副本（默认 <项目根>/tmp/allbot-smoke.json；只接受副本，只读）
 *   --prepare              生成临时副本后退出（不跑探针）
 *   --force                配合 --prepare，覆盖已存在的副本
 *   --official <路径>      正式配置路径（默认 C:/Users/1/.allbot/allbot.json，只读校验）
 *   --allbot-root <路径>   allbot 安装目录（默认 env ALLBOT_ROOT 或 C:/allbot-public）
 *   --timeout <秒>         等网关就绪（默认 420；这台机器冷启动实测 161–332s）
 *   --agent-timeout <秒>   等一轮 agent 跑完（默认 240）
 *   --settle <秒>          网关 ready 后静默等待（默认 10；插件 reload 期间太早发请求会撞忙）
 *   --keep                 保留临时目录（排查用）
 *   --json                 只打印一行 JSON 结果
 */

import { spawnSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OFFICIAL_CONFIG = "C:/Users/1/.allbot/allbot.json";
const COPY_PORT = 36719;
const LOCAL_POOL = "http://127.0.0.1:3065/v1";

const DEFAULTS = {
  config: path.join(PROJECT_ROOT, "tmp", "allbot-smoke.json"),
  official: process.env.S0_2_OFFICIAL_CONFIG || OFFICIAL_CONFIG,
  allbotRoot: process.env.ALLBOT_ROOT || "C:/allbot-public",
  gatewayTimeoutSec: 420,
  agentTimeoutSec: 240,
  settleSec: 10,
};

const PLUGIN_ID = "s0-2-probe";
const PLUGIN_TOOL = "probe_plugin_tool";
const MCP_SERVER = "probe";
const MCP_TOOL_RAW = "probe_mcp_tool";

function parseArgs(argv) {
  const opts = { ...DEFAULTS, keep: false, json: false, prepare: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} 缺少值`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--config":
        opts.config = next();
        break;
      case "--official":
        opts.official = next();
        break;
      case "--allbot-root":
        opts.allbotRoot = next();
        break;
      case "--timeout":
        opts.gatewayTimeoutSec = Number(next());
        break;
      case "--agent-timeout":
        opts.agentTimeoutSec = Number(next());
        break;
      case "--settle":
        opts.settleSec = Number(next());
        break;
      case "--prepare":
        opts.prepare = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--keep":
        opts.keep = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, intervalMs = 500, label = "condition") {
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）: ${label}`);
    }
    await sleep(intervalMs);
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(800);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileIdentity(file) {
  const st = fs.statSync(file, { bigint: true });
  return `${st.dev}:${st.ino}`;
}

/** 路径/硬链接/目录联接指向同一文件（Windows 上表现为同一 dev:ino）。 */
function sameFile(a, b) {
  try {
    return fileIdentity(a) === fileIdentity(b);
  } catch {
    return false;
  }
}

function isUnder(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeTail(file, bytes = 4000) {
  try {
    const buf = fs.readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
  } catch {
    return "";
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/**
 * --config 的准入校验：只放行「改动过的、只听本机的临时副本」。
 * 任何一条不满足都退 2，连网关都不会起。
 */
function assertTempCopy(configPath, officialPath) {
  const problems = [];
  if (!fs.existsSync(officialPath)) problems.push(`找不到正式配置（用来比对）: ${officialPath}`);
  if (!fs.existsSync(configPath)) {
    return [...problems, `找不到副本: ${configPath}（先跑 node build/tools/smoke/S0-2.mjs --prepare）`];
  }
  if (sameFile(configPath, officialPath)) {
    problems.push(`拒绝以正式配置运行：${configPath} 与 ${officialPath} 是同一文件（路径/硬链接/联接）`);
  } else if (sha256File(configPath) === sha256File(officialPath)) {
    problems.push(`拒绝：${configPath} 与正式配置逐字节相同，不是改动过的副本`);
  }
  if (!isUnder(path.join(PROJECT_ROOT, "tmp"), configPath) && !isUnder(os.tmpdir(), configPath) &&
      !/(smoke|probe|copy|副本)/i.test(path.basename(configPath))) {
    problems.push(`拒绝：${configPath} 既不在项目 tmp/ 也不在系统临时目录，看着不像临时副本`);
  }
  let cfg = null;
  try {
    cfg = readJsonFile(configPath);
  } catch (err) {
    problems.push(`副本不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (cfg) {
    const bind = cfg.gateway?.bind;
    const loopback =
      bind === "loopback" ||
      (bind === "custom" && /^(127\.|::1|localhost)/i.test(String(cfg.gateway?.bindHost || "")));
    if (!loopback) {
      problems.push(`拒绝：副本 gateway.bind=${JSON.stringify(bind)}，临时副本应只听本机（loopback）`);
    }
  }
  return problems;
}

/** 生成 tmp/allbot-smoke.json：从正式配置复制，只改 bind/port/默认模型三处。 */
async function prepareCopy(opts) {
  const officialPath = path.resolve(opts.official);
  const target = path.resolve(opts.config);
  if (!fs.existsSync(officialPath)) {
    process.stderr.write(`S0-2: 找不到正式配置: ${officialPath}\n`);
    return 2;
  }
  if (fs.existsSync(target) && !opts.force) {
    process.stderr.write(`S0-2: 副本已存在: ${target}\n  要重造就加 --force（会覆盖它；正式配置不受影响）。\n`);
    return 2;
  }

  const hashBefore = sha256File(officialPath);
  const cfg = readJsonFile(officialPath);
  const changes = [];
  const setKey = (label, obj, key, value) => {
    const old = JSON.stringify(obj[key]);
    obj[key] = value;
    changes.push(`${label}: ${old} -> ${JSON.stringify(value)}`);
  };

  // 1) 只听本机
  cfg.gateway = cfg.gateway || {};
  setKey("gateway.bind", cfg.gateway, "bind", "loopback");

  // 2) 换一个空端口（默认 36719；被占就另找）
  let port = COPY_PORT;
  if (await isPortOpen(port)) {
    port = await freePort();
    changes.push(`gateway.port: 36719 已被占用 -> ${port}`);
  }
  setKey("gateway.port", cfg.gateway, "port", port);

  // 3) OpenAI 兼容口（S0-1/S0-2 都靠它跑问答；allbot 默认关）
  cfg.gateway.http = cfg.gateway.http || {};
  cfg.gateway.http.endpoints = cfg.gateway.http.endpoints || {};
  cfg.gateway.http.endpoints.chatCompletions = {
    ...(cfg.gateway.http.endpoints.chatCompletions || {}),
    enabled: true,
  };
  changes.push("gateway.http.endpoints.chatCompletions.enabled: -> true");

  // 4) 默认模型指到本机 3065 池，模型 id 尽量沿用原来的
  const primaryOld = String(cfg.agents?.defaults?.model?.primary || "");
  const modelId = primaryOld.includes("/") ? primaryOld.split("/").slice(1).join("/") : "deepseek-v4.1-flash";
  let poolIds = [];
  try {
    const res = await fetch(`${LOCAL_POOL}/models`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    poolIds = (body.data || []).map((m) => m?.id).filter(Boolean);
  } catch {
    poolIds = [];
  }
  const chosen = poolIds.includes(modelId) ? modelId : poolIds[0] || modelId;
  if (poolIds.length === 0) changes.push("提示: 3065 池 /v1/models 没答上来，模型 id 按原值填");
  else if (!poolIds.includes(modelId)) changes.push(`提示: 3065 池没有 ${modelId}，改用 ${chosen}`);

  cfg.models = cfg.models || {};
  cfg.models.mode = "merge";
  cfg.models.providers = cfg.models.providers || {};
  cfg.models.providers.local3065 = {
    baseUrl: LOCAL_POOL,
    apiKey: "local",
    api: "openai-completions",
    models: [
      {
        id: chosen,
        name: chosen,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
        compat: {},
      },
    ],
  };
  cfg.agents = cfg.agents || {};
  cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.model = { ...(cfg.agents.defaults.model || {}), primary: `local3065/${chosen}` };
  changes.push(`agents.defaults.model.primary: ${JSON.stringify(primaryOld)} -> ${JSON.stringify(`local3065/${chosen}`)}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2), "utf8");

  const hashAfter = sha256File(officialPath);
  const officialUntouched = hashAfter === hashBefore;
  process.stdout.write(`S0-2 --prepare\n`);
  process.stdout.write(`  正式配置（只读）: ${officialPath}\n`);
  process.stdout.write(`    sha256 前: ${hashBefore}\n`);
  process.stdout.write(`    sha256 后: ${hashAfter}${officialUntouched ? "（未改动）" : "（变了！）"}\n`);
  process.stdout.write(`  生成副本        : ${target}\n`);
  for (const c of changes) process.stdout.write(`  - ${c}\n`);
  process.stdout.write(`  下一句: node build/tools/smoke/S0-2.mjs --config ${path.relative(PROJECT_ROOT, target) || target}\n`);
  if (!officialUntouched) {
    process.stderr.write("S0-2: 正式配置哈希发生变化，立即停止并排查。\n");
    return 1;
  }
  return 0;
}

/** 生成的测试插件：注册工具 + 抓 before_tool_call 载荷 + 在插件进程里试 node:sqlite。 */
function pluginSource(logPath) {
  const logLiteral = JSON.stringify(logPath);
  return `import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const LOG = ${logLiteral};

function append(rec) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ ...rec, pid: process.pid, ts: Date.now() }) + "\\n", "utf8");
  } catch {
    /* 探针日志写不进去不应阻断工具执行 */
  }
}

export default {
  id: "${PLUGIN_ID}",
  name: "S0-2 Identity Probe",
  description: "Registers a probe tool and records before_tool_call payloads (smoke only)",
  configSchema: { type: "object", additionalProperties: false },
  register(api) {
    append({ kind: "register", node: process.versions.node });

    let sqlite;
    try {
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)");
      db.prepare("INSERT INTO probe (v) VALUES (?)").run("ok");
      const row = db.prepare("SELECT v FROM probe").get();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      db.close();
      sqlite = { ok: row?.v === "ok", row, tables: tables.map((t) => t.name) };
    } catch (err) {
      sqlite = { ok: false, error: String(err) };
    }
    append({ kind: "sqlite", ...sqlite });

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        append({
          kind: "before_tool_call",
          toolName: event?.toolName,
          eventKeys: Object.keys(event || {}).sort(),
          ctxKeys: Object.keys(ctx || {}).sort(),
          ctx: ctx || {},
          // 原样留 event，便于核对身份字段与参数（echo 里带本轮 nonce，用来认这一轮）
          event: event || {},
        });
        return undefined;
      },
      { priority: 100 },
    );

    api.registerTool({
      name: "${PLUGIN_TOOL}",
      description: "S0-2 probe tool registered by a plugin (identity must be complete)",
      parameters: {
        type: "object",
        properties: { echo: { type: "string" } },
        additionalProperties: false,
      },
      async execute(_id, params) {
        append({ kind: "plugin_tool_execute", params });
        return { content: [{ type: "text", text: "plugin-tool-ok:" + String(params?.echo ?? "") }] };
      },
    });
  },
};
`;
}

/** 生成的 MCP 回声服务（stdio，换行分隔 JSON-RPC）。 */
function mcpServerSource() {
  return `let buf = "";
const TOOLS = [{
  name: "${MCP_TOOL_RAW}",
  description: "S0-2 probe tool exposed through config.mcp.servers (expected: no identity)",
  inputSchema: { type: "object", properties: { echo: { type: "string" } }, additionalProperties: false },
}];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "s0-2-probe-mcp", version: "0.0.1" },
    }});
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }
  if (method === "tools/call") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "mcp-tool-ok:" + String(params?.arguments?.echo ?? "") }] } });
    return;
  }
  if (method === "ping") { send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
}
`;
}

/**
 * 生成的假 OpenAI 兼容上游。
 * 第 1 次请求要求调插件工具，第 2 次要求调 MCP 工具，第 3 次给最终文本。
 * 工具名从请求体 tools[] 里挑，避免依赖命名规则。
 */
function fakeUpstreamSource(port, requestLogPath) {
  return `import fs from "node:fs";
import http from "node:http";

const PORT = ${Number(port)};
const LOG = ${JSON.stringify(requestLogPath)};
let requests = 0;

function log(rec) {
  try { fs.appendFileSync(LOG, JSON.stringify(rec) + "\\n", "utf8"); } catch {}
}

function sse(res, obj) {
  res.write("data: " + JSON.stringify(obj) + "\\n\\n");
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.replace(/\\?.*$/, "").endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "probe-model", object: "model" }] }));
    return;
  }
  if (!req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(body || "{}"); } catch {}
    const names = (payload.tools || []).map((t) => t?.function?.name).filter(Boolean);
    const toolMsgs = (payload.messages || []).filter((m) => m.role === "tool").length;
    const pluginName = names.find((n) => n.includes(${JSON.stringify(PLUGIN_TOOL)}));
    const mcpName = names.find((n) => n.includes(${JSON.stringify(MCP_TOOL_RAW)}));
    // 本轮标记：脚本把 nonce=... 写进用户消息，这里原样塞进工具参数，
    // 这样即使钩子完全拿不到 sessionKey，也能认出哪些记录属于本轮。
    const userText = (payload.messages || [])
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")))
      .join("\\n");
    const nonceMatch = userText.match(/nonce=([A-Za-z0-9_-]+)/);
    const nonce = nonceMatch ? nonceMatch[1] : "";
    requests += 1;
    log({ kind: "request", n: requests, toolMsgs, nonce, hasPluginTool: Boolean(pluginName), hasMcpTool: Boolean(mcpName) });

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const base = { id: "s0-2", object: "chat.completion.chunk", created: 0, model: payload.model || "probe-model" };
    let target = null;
    if (toolMsgs === 0 && pluginName) target = pluginName;
    else if (toolMsgs === 1 && mcpName) target = mcpName;

    if (target) {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_" + requests, type: "function", function: { name: target, arguments: JSON.stringify({ echo: nonce || "hi" }) } }] }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "probe done" }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\\n\\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write("LISTEN " + PORT + "\\n");
});
`;
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const IDENTITY_FIELDS = ["agentId", "sessionKey", "runId"];

function identityFieldsOf(obj) {
  const out = {};
  for (const k of IDENTITY_FIELDS) {
    if (typeof obj?.[k] === "string" && obj[k].trim()) out[k] = obj[k];
  }
  return out;
}

function identityOf(record) {
  return identityFieldsOf(record?.ctx);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "用法:\n" +
        "  node build/tools/smoke/S0-2.mjs --prepare [--force]        # 生成 tmp/allbot-smoke.json（只改 bind/port/默认模型）\n" +
        "  node build/tools/smoke/S0-2.mjs --config <副本路径> [--allbot-root <路径>] [--timeout 秒] [--agent-timeout 秒] [--settle 秒] [--keep] [--json]\n",
    );
    return 0;
  }

  if (opts.prepare) return await prepareCopy(opts);

  const allbotRoot = path.resolve(opts.allbotRoot);
  const allbotMjs = path.join(allbotRoot, "allbot.mjs");
  const configSrc = path.resolve(opts.config);
  const officialSrc = path.resolve(opts.official);

  const preflight = [];
  if (!fs.existsSync(allbotMjs)) preflight.push(`找不到 allbot.mjs: ${allbotMjs}`);
  preflight.push(...assertTempCopy(configSrc, officialSrc));
  if (preflight.length > 0) {
    for (const msg of preflight) process.stderr.write(`S0-2: ${msg}\n`);
    return 2;
  }

  const baseConfig = readJsonFile(configSrc);
  const configHashBefore = sha256File(configSrc);
  const officialHashBefore = sha256File(officialSrc);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const tempRoot = path.join(os.tmpdir(), `allbot-s0-2-${stamp}-${process.pid}`);
  const pluginDir = path.join(tempRoot, "plugin");
  const stateDir = path.join(tempRoot, "state");
  const workspaceDir = path.join(tempRoot, "workspace");
  const probeLog = path.join(tempRoot, "hook-payloads.jsonl");
  const requestLog = path.join(tempRoot, "upstream-requests.jsonl");
  const gatewayLog = path.join(tempRoot, "gateway.log");
  const agentLog = path.join(tempRoot, "agent.log");
  const configCopy = path.join(tempRoot, "allbot.json");

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const children = [];
  const startedAt = Date.now();

  const report = {
    ok: false,
    config: configSrc,
    official: { path: officialSrc, sha256: officialHashBefore },
    configCopy,
    allbotRoot,
    tempRoot,
    gatewayUrl: null,
    checks: {
      pluginTool: {
        name: PLUGIN_TOOL,
        pass: false,
        recorded: false,
        ctxKeys: [],
        eventKeys: [],
        identity: {},
        eventIdentity: {},
        missing: [],
      },
      mcpTool: {
        name: null,
        pass: false,
        recorded: false,
        ctxKeys: [],
        eventKeys: [],
        identity: {},
        eventIdentity: {},
        unexpectedIdentity: false,
      },
      sqlite: { pass: false, recorded: false, keys: [], detail: null },
      run: { pass: false, requests: 0, sessionKeyMatched: false },
    },
    timings: {},
    notes: [],
  };

  try {
    const gatewayPort = await freePort();
    const upstreamPort = await freePort();
    const token = `s0-2-${crypto.randomBytes(8).toString("hex")}`;
    report.gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

    // ---- 实例配置（副本再复制一份到临时目录，只改这次） ----
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.meta = { ...(cfg.meta || {}), lastTouchedVersion: "s0-2-probe", lastTouchedAt: new Date().toISOString() };
    // 不连任何真实渠道 / 不带真实账户，避免副作用与自动启用其它插件
    cfg.channels = {};
    cfg.auth = { profiles: {} };
    cfg.browser = { ...(cfg.browser || {}), enabled: false };
    cfg.skills = { ...(cfg.skills || {}), entries: {} };
    cfg.hooks = { internal: { enabled: true, entries: {} } };
    cfg.models = {
      mode: "merge",
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "s0-2-probe-key",
          api: "openai-completions",
          models: [
            {
              id: "probe-model",
              name: "probe-model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 131072,
              maxTokens: 4096,
              compat: {},
            },
          ],
        },
      },
    };
    cfg.agents = {
      ...(cfg.agents || {}),
      defaults: {
        ...((cfg.agents && cfg.agents.defaults) || {}),
        model: { primary: "probe/probe-model" },
        models: {},
        workspace: workspaceDir,
        timeoutSeconds: Math.max(60, opts.agentTimeoutSec),
        compaction: { mode: "safeguard" },
      },
    };
    cfg.gateway = {
      ...(cfg.gateway || {}),
      mode: "local",
      port: gatewayPort,
      bind: "loopback",
      auth: { mode: "token", token },
      // 用网关自带的 OpenAI 兼容口跑一轮 agent（避开 CLI 的 WS 握手问题）
      http: {
        ...((cfg.gateway && cfg.gateway.http) || {}),
        endpoints: {
          ...((cfg.gateway && cfg.gateway.http && cfg.gateway.http.endpoints) || {}),
          chatCompletions: { enabled: true },
        },
      },
    };
    // 只放行测试插件。不要写 plugins.deny：deny 里出现未安装的 id 会被配置校验判为 invalid。
    cfg.plugins = {
      enabled: true,
      allow: [PLUGIN_ID],
      load: { paths: [pluginDir] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    };
    cfg.mcp = {
      servers: {
        [MCP_SERVER]: {
          command: process.execPath,
          args: [path.join(tempRoot, "mcp-echo.mjs")],
          env: { S0_2_PROBE: "1" },
        },
      },
    };
    fs.writeFileSync(configCopy, JSON.stringify(cfg, null, 2), "utf8");

    // ---- 生成的三个测试件 ----
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "s0-2-probe-plugin",
          version: "0.0.1",
          private: true,
          type: "module",
          allbot: { extensions: ["./index.mjs"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "allbot.plugin.json"),
      JSON.stringify(
        {
          id: PLUGIN_ID,
          name: "S0-2 Identity Probe",
          description: "S0-2 smoke probe (tool + before_tool_call recorder)",
          configSchema: { type: "object", additionalProperties: false },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.mjs"), pluginSource(probeLog), "utf8");
    fs.writeFileSync(path.join(tempRoot, "mcp-echo.mjs"), mcpServerSource(), "utf8");
    fs.writeFileSync(path.join(tempRoot, "fake-upstream.mjs"), fakeUpstreamSource(upstreamPort, requestLog), "utf8");

    const childEnv = {
      ...process.env,
      ALLBOT_CONFIG_PATH: configCopy,
      ALLBOT_STATE_DIR: stateDir,
      SHERPA_ONNX_AUTO_DOWNLOAD: "0",
      S0_2_PROBE_LOG: probeLog,
    };

    // ---- 假上游 ----
    const upstreamOut = fs.openSync(path.join(tempRoot, "upstream.out"), "a");
    const upstream = spawn(process.execPath, [path.join(tempRoot, "fake-upstream.mjs")], {
      cwd: tempRoot,
      env: childEnv,
      stdio: ["ignore", upstreamOut, upstreamOut],
      windowsHide: true,
    });
    children.push(upstream);
    await waitFor(() => isPortOpen(upstreamPort), 15_000, 200, "假上游监听");

    // ---- 网关（大脑） ----
    const gwOut = fs.openSync(gatewayLog, "a");
    const gateway = spawn(process.execPath, [allbotMjs, "gateway"], {
      cwd: allbotRoot,
      env: childEnv,
      stdio: ["ignore", gwOut, gwOut],
      windowsHide: true,
    });
    children.push(gateway);
    const gwStart = Date.now();
    await waitFor(
      async () => {
        const log = safeTail(gatewayLog, 200_000);
        const ready = /ready \(\d+ plugins?, [\d.]+s\)/.test(log);
        return ready && (await isPortOpen(gatewayPort));
      },
      opts.gatewayTimeoutSec * 1000,
      1000,
      `网关就绪（${report.gatewayUrl}）`,
    );
    report.timings.gatewayReadySec = Math.round((Date.now() - gwStart) / 100) / 10;

    // 网关报 ready 后还会做一轮插件 reload / 模型目录刷新。给它一小段静默期。
    if (opts.settleSec > 0) await sleep(opts.settleSec * 1000);

    // ---- 一轮 agent（两个工具各调一次）----
    // 走网关自带的 OpenAI 兼容口 /v1/chat/completions（Bearer 用网关 token）：
    // 它在网关进程内直接跑一轮 agent，不需要 CLI 的 WS 握手（实测 CLI 在 ready 后
    // 会撞上 "handshake timeout / 4000 tick timeout"）。user 字段进 sessionKey。
    //
    // 本轮标记 nonce 写进用户消息，假上游把它原样放进工具参数 echo。
    // 这样即使钩子完全拿不到 sessionKey，也能把记录认到本轮——插件工具“身份全缺”
    // 这种裁决情形才测得出来，而不是误判为“没抓到记录”。
    const nonce = `n-${crypto.randomBytes(6).toString("hex")}`;
    const sessionId = `probe-s0-2-${stamp}`;
    const agentStart = Date.now();
    const probeArgs = (r) => r.event?.params ?? r.params ?? {};
    const isOurs = (r) =>
      r.kind === "before_tool_call" && probeArgs(r).echo === nonce;
    const sawBothFor = () => {
      const records = readJsonl(probeLog);
      const plugin = records.some((r) => isOurs(r) && r.toolName === PLUGIN_TOOL);
      const mcp = records.some((r) => isOurs(r) && /probe_mcp_tool/.test(r.toolName || ""));
      return plugin && mcp;
    };

    let httpStatus = null;
    const callAgent = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.agentTimeoutSec * 1000);
      try {
        const res = await fetch(`${report.gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            model: "allbot",
            user: sessionId,
            stream: false,
            messages: [{ role: "user", content: `run the probe tools nonce=${nonce}` }],
          }),
          signal: controller.signal,
        });
        const text = await res.text();
        httpStatus = res.status;
        fs.appendFileSync(agentLog, `[http ${res.status}] ${text.slice(0, 2000)}\n`, "utf8");
        return { status: res.status, text };
      } finally {
        clearTimeout(timer);
      }
    };

    const attempts = 2;
    let lastAgentError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await callAgent();
        if (result.status === 200) {
          // 工具调用记录可能比 HTTP 响应晚几秒落盘
          await waitFor(() => sawBothFor(), 20_000, 500, "本轮钩子记录").catch(() => {});
          break;
        }
        lastAgentError = `HTTP ${result.status}: ${result.text.slice(0, 300)}`;
      } catch (err) {
        lastAgentError = err instanceof Error ? err.message : String(err);
      }
      if (attempt === attempts) break;
      await sleep(3000);
    }
    report.timings.agentSec = Math.round((Date.now() - agentStart) / 100) / 10;
    report.timings.totalSec = Math.round((Date.now() - startedAt) / 100) / 10;

    // 没拿到一轮成功的 agent 响应 = 没拿到测量结果（环境问题），按 2 退出。
    if (httpStatus !== 200) {
      throw new Error(`agent 调用未成功：${lastAgentError || "未知原因"}`);
    }

    const records = readJsonl(probeLog);
    // 只认带本轮 nonce 的记录，不拿心跳等旁路会话充数；不要求 sessionKey 存在。
    const pluginRecord =
      records.filter((r) => isOurs(r) && r.toolName === PLUGIN_TOOL).pop() || null;
    const mcpRecord =
      records.filter((r) => isOurs(r) && /probe_mcp_tool/.test(r.toolName || "")).pop() || null;

    // ---- 断言 1：插件工具身份齐全 ----
    const p = report.checks.pluginTool;
    p.recorded = Boolean(pluginRecord);
    p.ctxKeys = pluginRecord?.ctxKeys || [];
    p.eventKeys = pluginRecord?.eventKeys || [];
    p.identity = identityOf(pluginRecord);
    p.eventIdentity = identityFieldsOf(pluginRecord?.event);
    p.missing = IDENTITY_FIELDS.filter((k) => !p.identity[k]);
    p.pass = Boolean(pluginRecord) && p.missing.length === 0;

    // ---- 断言 2：外挂 MCP 工具不带身份 ----
    // 规格里的「只有 toolName」按方案 A.4 的原意理解为「不带 agentId/sessionKey/runId」；
    // 框架自带的 toolCallId 不算身份。键集原样打印，不把 toolCallId 说成“只有工具名”。
    const m = report.checks.mcpTool;
    m.name = mcpRecord?.toolName || null;
    m.recorded = Boolean(mcpRecord);
    m.ctxKeys = mcpRecord?.ctxKeys || [];
    m.eventKeys = mcpRecord?.eventKeys || [];
    m.identity = identityOf(mcpRecord);
    m.eventIdentity = identityFieldsOf(mcpRecord?.event);
    m.unexpectedIdentity =
      Object.keys(m.identity).length > 0 || Object.keys(m.eventIdentity).length > 0;
    m.pass = Boolean(mcpRecord) && !m.unexpectedIdentity;

    // ---- 断言 3：node:sqlite 在大脑进程里可用 ----
    const sqliteRecord = [...records].reverse().find((r) => r.kind === "sqlite");
    report.checks.sqlite.recorded = Boolean(sqliteRecord);
    report.checks.sqlite.keys = sqliteRecord ? Object.keys(sqliteRecord).sort() : [];
    report.checks.sqlite.pass = Boolean(sqliteRecord && sqliteRecord.ok === true);
    report.checks.sqlite.detail = sqliteRecord
      ? { ok: sqliteRecord.ok, row: sqliteRecord.row, tables: sqliteRecord.tables, error: sqliteRecord.error }
      : { ok: false, error: "没有收到插件里的 node:sqlite 记录" };

    const requests = readJsonl(requestLog);
    report.checks.run.requests = requests.length;
    report.checks.run.sessionKeyMatched = Boolean(
      pluginRecord?.ctx?.sessionKey && pluginRecord.ctx.sessionKey.includes(sessionId),
    );
    report.checks.run.pass = httpStatus === 200 && requests.length >= 2;

    if (m.unexpectedIdentity) {
      report.notes.push(
        `外挂 MCP 工具带了身份（ctx=${JSON.stringify(m.identity)} event=${JSON.stringify(m.eventIdentity)}），与评审推断不符`,
      );
    }
    if (!m.recorded) {
      report.notes.push("没有抓到外挂 MCP 工具的 before_tool_call 记录");
    }
    if (!pluginRecord) {
      report.notes.push("没有抓到插件工具的 before_tool_call 记录：检查网关日志与 agent.log");
    }

    // 门禁：三项都算。插件身份不过 = 主路不成立；MCP 带身份 = 与推断不符；sqlite 不过 = 账本落不了地。
    report.ok =
      report.checks.pluginTool.pass && report.checks.mcpTool.pass && report.checks.sqlite.pass && report.checks.run.pass;

    const copyHashAfter = sha256File(configSrc);
    if (copyHashAfter !== configHashBefore) {
      report.notes.push(`注意：--config 指向的副本被改动了（sha256 变化）。本脚本不写它，请查是谁改的。`);
      report.ok = false;
    }
    const officialHashAfter = sha256File(officialSrc);
    report.official.sha256After = officialHashAfter;
    report.official.unchanged = officialHashAfter === officialHashBefore;
    if (!report.official.unchanged) {
      report.notes.push(`正式配置 ${officialSrc} 的 sha256 发生变化（前后不一致）！本脚本从不写它，立即排查。`);
      report.ok = false;
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    if (!report.ok) {
      report.notes.push(`gateway.log 末尾:\n${safeTail(gatewayLog, 1200)}`);
      report.notes.push(`agent.log 末尾:\n${safeTail(agentLog, 1200)}`);
    }
    report.ok = false;
  } finally {
    for (const child of children.reverse()) killTree(child.pid);
    if (!opts.keep) {
      // 等子进程退出再删，避免 Windows 上文件占用
      await sleep(500);
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    printHuman(report, opts);
  }
  return report.ok ? 0 : report.error ? 2 : 1;
}

function printHuman(report, opts) {
  const line = (s = "") => process.stdout.write(`${s}\n`);
  line(`S0-2 身份探针`);
  line(`  正式配置（只读）: ${report.official.path}  sha256 ${report.official.sha256.slice(0, 12)}… ${report.official.unchanged === false ? "（变了！）" : "（未改动）"}`);
  line(`  副本（--config）: ${report.config}`);
  line(`  实例配置        : ${opts.keep ? report.configCopy : "(已删除)"}`);
  line(`  大脑            : ${report.allbotRoot}`);
  if (report.gatewayUrl) line(`  网关            : ${report.gatewayUrl}`);
  if (report.timings.gatewayReadySec) {
    line(`  耗时            : 网关就绪 ${report.timings.gatewayReadySec}s / agent ${report.timings.agentSec}s / 合计 ${report.timings.totalSec}s`);
  }
  line();

  const p = report.checks.pluginTool;
  line(`[1] 插件自带工具 \`${p.name}\``);
  line(`    ctx 键名  : ${p.ctxKeys.length ? p.ctxKeys.join(", ") : "(没抓到记录)"}`);
  line(`    event 键名: ${p.eventKeys.length ? p.eventKeys.join(", ") : "(没抓到记录)"}`);
  line(
    `    身份      : ctx ${IDENTITY_FIELDS.map((k) => `${k}=${p.identity[k] ?? "缺失"}`).join("  ")}`,
  );
  if (p.eventIdentity && Object.keys(p.eventIdentity).length > 0) {
    line(
      `                event ${IDENTITY_FIELDS.map((k) => `${k}=${p.eventIdentity[k] ?? "缺失"}`).join("  ")}`,
    );
  }
  line(`    => ${p.pass ? "PASS" : "FAIL"}${p.pass ? "" : `（缺 ${p.missing.join(", ") || "记录"}）`}`);
  line();

  const m = report.checks.mcpTool;
  line(`[2] 外挂 MCP 工具 \`${m.name ?? "(没抓到记录)"}\``);
  line(`    ctx 键名  : ${m.ctxKeys.length ? m.ctxKeys.join(", ") : "(没抓到记录)"}`);
  line(`    event 键名: ${m.eventKeys.length ? m.eventKeys.join(", ") : "(没抓到记录)"}`);
  line(
    `    身份      : ctx ${IDENTITY_FIELDS.map((k) => `${k}=${m.identity[k] ?? "缺失"}`).join("  ")}`,
  );
  if (m.eventIdentity && Object.keys(m.eventIdentity).length > 0) {
    line(
      `                event ${IDENTITY_FIELDS.map((k) => `${k}=${m.eventIdentity[k] ?? "缺失"}`).join("  ")}`,
    );
  }
  line(`    断言      : 不带 agentId/sessionKey/runId（方案 A.4「只带名字」的原意）`);
  line(`    => ${m.pass ? "PASS" : "FAIL"}`);
  if (m.pass && m.ctxKeys.includes("toolCallId")) {
    line(`    备注      : 键集比「只有 toolName」多一个框架自带的 toolCallId，不算身份。`);
  }
  line();

  const s = report.checks.sqlite;
  line(`[3] node:sqlite（大脑进程内）`);
  line(`    记录键名  : ${s.keys.length ? s.keys.join(", ") : "(没抓到记录)"}`);
  line(
    `    :memory: 建表/插入/查询 => ${s.pass ? "PASS" : "FAIL"}${s.detail?.error ? `（${s.detail.error}）` : ""}`,
  );
  line();

  line(`RESULT: ${report.ok ? "PASS" : "FAIL"}`);
  if (!p.pass && !p.recorded) {
    line(`说明: 插件工具连钩子记录都没有 → 主路不成立；按方案 S0-2 改道“桥进程当闸”。`);
  } else if (!p.pass) {
    line(`说明: 插件工具缺身份 → 主路不成立；按方案 S0-2 改道“桥进程当闸”。`);
  }
  if (!m.pass) {
    line(`说明: 外挂 MCP 工具的载荷与 S0-2 预期不符（缺记录或带了身份），见上面键名与身份行。`);
  }
  if (!s.pass) {
    line(`说明: node:sqlite 在大脑进程里不可用 → 账本（SQLite）无法按方案落盘。`);
  }
  if (!report.ok && report.error) line(`错误: ${report.error}`);
  for (const note of report.notes || []) {
    line(`提示: ${note}`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`S0-2 异常: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exitCode = 2;
  });
