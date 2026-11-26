#!/usr/bin/env node
/**
 * S0-1 冒烟测试：大脑起得来（dot-合并方案-v2-定稿.md 第 7 节第 0 步表 + 附录 C）
 *
 * 通过标准（方案原文）：用临时副本配置（只听本机＋模型指到本机池）起来，
 * 端口只在 127.0.0.1 上；一次问答成功；飞书发一句有回复。
 * 不过怎么办：模型不通→修模型供应商；飞书不通→降级，不影响主路；
 * 起不来→整个方案改道。本脚本只如实报告，处置由施工者按方案执行。
 *
 * 安全约束：本脚本绝不写任何配置文件。正式配置 C:/Users/1/.allbot/allbot.json
 * 只读都不读；副本路径经 ALLBOT_CONFIG_PATH 传给 allbot 子进程。
 * 副本若与正式配置是同一文件（路径或硬链接/联接）直接拒绝运行（exit 2）。
 *
 * 用法：
 *   node build/tools/smoke/S0-1.mjs --config tmp/allbot-smoke.json [--timeout 360] [--skip-feishu]
 *
 * 副本需事先由施工者准备，并满足：
 *   gateway.bind = "loopback"（或 custom 到 127.0.0.1）
 *   gateway.http.endpoints.chatCompletions.enabled = true（该端点默认关闭，见
 *     allbot-src/src/gateway/server-http.ts:1053-1056 与 schema.base.generated.ts:21677-21686）
 *   agents.defaults.model.primary 指向本机模型池
 *   gateway.auth.token 沿用正式配置的值（脚本从副本读）
 *
 * 飞书项为什么需要「第二个机器人」：allbot 的飞书入口只有 im.message.receive_v1
 * 事件（allbot-src/docs/channels/feishu.md:11「WebSocket event subscription」、
 * extensions/feishu/src/monitor.account.ts:565 的事件注册），而飞书官方文档
 * open.feishu.cn/document/server-docs/im-v1/message/events/receive 在
 * im:message.group_msg.include_bot:read 权限处明确写「接收群聊中所有用户和其他
 * 机器人发送的消息……不包含当前机器人自己发送的消息」。所以主机器人在群里给
 * 自己发消息，它自己收不到、不会回。
 * 要闭环必须让另一个身份发消息：本脚本用「测试机器人 app」在群里发一句带唯一
 * 标记的话，主机器人收到并回复，脚本再用主机器人自己的凭据读回那条回复。
 *
 * 飞书项前置（环境变量）：
 *   S0_FEISHU_CHAT_ID          测试群 chat_id（主机器人在群里）
 *   S0_FEISHU_PEER_APP_ID      测试机器人 appId
 *   S0_FEISHU_PEER_APP_SECRET  测试机器人 appSecret
 * 主机器人还需开通 im:message.group_msg.include_bot:read 权限（收到群里其他
 * 机器人的消息），官方文档：只收用户 @ 机器人时不会收到机器人消息。
 * 缺以上凭据时飞书项记 FAIL（检查项没过，exit 1）；--skip-feishu 则 SKIP。
 *
 * 飞书判据依据（open.feishu.cn 官方文档，本轮 WebFetch 核对原文）：
 *   GET /im/v1/messages：start_time 是秒级时间戳（示例 1608594809），返回的
 *     create_time 是毫秒（示例 1615380573411），sort_type 取 ByCreateTimeAsc。
 *   POST /im/v1/messages 响应示例：机器人发的消息 sender.id_type=app_id、
 *     sender.id=cli_...（即 appId）、sender.sender_type=app。
 * 因此读回时：只看发送时间之后（毫秒转秒）、sender_type=app 且 sender.id 等于
 * 主机器人 appId、且不是测试机器人自己那条（按 message_id 排除）。不要求回复
 * 回显标记，回显不受脚本控制。
 *
 * 退出码：0 全过；1 有检查项没过（含飞书凭据缺失）；2 前置条件缺失（副本不存在、allbot 起不来等）。
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";
import net from "node:net";

const ALLBOT_ENTRY = "C:/allbot-public/dist/index.js";
const OFFICIAL_CONFIG = "C:/Users/1/.allbot/allbot.json";
const PORT = 18789;
// 实测：本机首次启动 allbot 波动很大（160s ~ 280s 才 LISTENING；插件自动启用
// + sherpa-onnx runtime 下载失败等待 + 模型定价 bootstrap 超时）。30 秒会误判
// 「起不来」，默认给 360 秒；施工者可用 --timeout 覆盖。
const DEFAULT_TIMEOUT = 360;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const uid = () => `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const results = [];
function emit(status, name, evidence) {
  results.push({ status, name });
  console.log(`[${status}] ${name}`);
  if (evidence) console.log(`       证据: ${evidence}`);
}
function blocked(name, evidence) {
  emit("BLOCK", name, evidence);
  console.log("\n结果: 前置条件缺失，未执行检查（exit 2）");
  process.exit(2);
}

let opts;
try {
  opts = parseArgs({
    options: {
      config: { type: "string" },
      timeout: { type: "string" },
      "skip-feishu": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  blocked("解析参数", String(err?.message || err));
}
if (opts.help) {
  console.log("用法: node build/tools/smoke/S0-1.mjs --config <副本路径> [--timeout <秒>] [--skip-feishu]");
  console.log("飞书前置: S0_FEISHU_CHAT_ID, S0_FEISHU_PEER_APP_ID, S0_FEISHU_PEER_APP_SECRET");
  console.log("退出码: 0 全过 / 1 有项没过 / 2 前置条件缺失");
  process.exit(0);
}

const timeoutMs = opts.timeout ? Number(opts.timeout) * 1000 : DEFAULT_TIMEOUT * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  blocked("--timeout 参数", `须为 >=1 的秒数，收到: ${opts.timeout}`);
}

// ---- 前置条件 -----------------------------------------------------------
if (!opts.config) blocked("--config 参数", "未提供 --config <副本路径>；正式配置不许直接用");

const configPath = path.resolve(opts.config);
const officialPath = path.resolve(OFFICIAL_CONFIG);
function sameFile(a, b) {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    // 硬链接/目录联接在 Windows 上表现为同一 (dev, ino)
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { return false; }
}
if (sameFile(configPath, officialPath)) {
  blocked("配置隔离", `拒绝以正式配置运行（路径或硬链接/联接指向同一文件）: ${configPath}`);
}
if (!existsSync(configPath)) blocked("临时副本存在", `找不到 ${configPath}`);

// 飞书前置：缺凭据时飞书项记 FAIL（检查项没过），不进入伪测试。
const feishuPre = {
  chatId: process.env.S0_FEISHU_CHAT_ID || "",
  peerAppId: process.env.S0_FEISHU_PEER_APP_ID || "",
  peerAppSecret: process.env.S0_FEISHU_PEER_APP_SECRET || "",
};
const feishuMissing = [];
if (!feishuPre.chatId) feishuMissing.push("S0_FEISHU_CHAT_ID");
if (!feishuPre.peerAppId) feishuMissing.push("S0_FEISHU_PEER_APP_ID");
if (!feishuPre.peerAppSecret) feishuMissing.push("S0_FEISHU_PEER_APP_SECRET");

let cfg;
try {
  const raw = readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  cfg = JSON.parse(raw);
} catch (err) {
  blocked("临时副本可解析", `${configPath}: ${String(err?.message || err)}`);
}
if (!existsSync(ALLBOT_ENTRY)) blocked("allbot 已安装", `找不到 ${ALLBOT_ENTRY}`);

const bind = cfg.gateway?.bind;
if (bind !== "loopback" && !(bind === "custom" && /^(127\.|::1|localhost)/i.test(String(cfg.gateway?.bindHost || "")))) {
  blocked("副本只听本机", `副本 gateway.bind=${JSON.stringify(bind)}，应为 loopback；allbot-src/src/config/types.gateway.ts:3 支持 loopback`);
}
if (cfg.gateway?.http?.endpoints?.chatCompletions?.enabled !== true) {
  blocked("副本问答端点", "副本 gateway.http.endpoints.chatCompletions.enabled 不是 true；该端点默认关闭，问答请求会 404");
}

function listenersOn(port) {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const rows = [];
    for (const raw of out.split(/\r?\n/)) {
      const cols = raw.trim().split(/\s+/);
      if (cols.length < 4 || cols[0] !== "TCP") continue;
      if (!cols[1].endsWith(`:${port}`)) continue;
      rows.push({ local: cols[1], state: cols[3], pid: cols[4] });
    }
    return { rows };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}
const pre = listenersOn(PORT);
if (pre.error) blocked("端口可检查", `netstat 执行失败: ${pre.error}`);
if (pre.rows.length) {
  blocked("18789 空闲", `已有监听: ${pre.rows.map((r) => `${r.local} ${r.state} pid=${r.pid}`).join(" | ")}；先停掉它，免得把别人的进程当成本次结果`);
}
console.log(`S0-1 大脑起得来 | 副本: ${configPath} | 超时: ${timeoutMs / 1000}s | 端口: ${PORT}`);
console.log(`副本关键字段: bind=${bind} chatCompletions=true agentModel=${cfg.agents?.defaults?.model?.primary ?? "<未配置>"} feishu=${cfg.channels?.feishu?.enabled ? "enabled" : "disabled"}`);
console.log(`飞书身份: 主app=${cfg.channels?.feishu?.appId ?? "<无>"} 测试app=${feishuPre.peerAppId || "<未设>"} chat=${feishuPre.chatId || "<未设>"}\n`);

// ---- 启动 allbot（ALLBOT_CONFIG_PATH 指到副本） --------------------------
const startedAt = Date.now();
const child = spawn(process.execPath, [ALLBOT_ENTRY, "gateway", "--port", String(PORT)], {
  env: { ...process.env, ALLBOT_CONFIG_PATH: configPath },
  cwd: path.dirname(ALLBOT_ENTRY),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logTail = "";
const takeLog = (chunk) => {
  logTail = (logTail + chunk.toString()).slice(-12000);
};
child.stdout.on("data", takeLog);
child.stderr.on("data", takeLog);

function cleanup() {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch { /* ignore */ }
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch { /* ignore */ }
}

async function waitReady() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { ok: false, why: `进程提前退出 code=${child.exitCode}`, tail: logTail };
    }
    const now = listenersOn(PORT);
    const listening = (now.rows || []).find((r) => r.state === "LISTENING");
    if (listening) {
      // 只以「18789 真的 LISTENING」为 ready 判据。本机实测 HTTP 路由稳定应答
      // 比 listen 还晚；后续检查项各自带超时，不必在这里等 HTTP。
      const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
      return { ok: true, seconds, local: listening.local };
    }
    await sleep(600);
  }
  return { ok: false, why: `${timeoutMs / 1000}s 内 18789 未 LISTENING`, tail: logTail };
}

function isLoopbackLocal(local) {
  const i = local.lastIndexOf(":");
  const host = local.slice(0, i).replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

// 返回结构化结果，LAN 探测也参与 PASS/FAIL 判定，不只进证据。
async function lanConnectProbe() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (!it.internal && it.family === "IPv4") ips.push(it.address);
    }
  }
  if (!ips.length) return { reachable: null, text: "无本机非 loopback IPv4，跳过主动连接探测" };
  const ip = ips[0];
  return await new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port: PORT });
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(msg);
    };
    sock.setTimeout(1500);
    sock.on("connect", () => finish({ reachable: true, text: `本机网卡 ${ip}:${PORT} 竟然可连（应连不上）` }));
    sock.on("timeout", () => finish({ reachable: false, text: `本机网卡 ${ip}:${PORT} 连接超时（符合只听本机）` }));
    sock.on("error", (e) => finish({ reachable: false, text: `本机网卡 ${ip}:${PORT} 连接被拒 ${e.code || ""}（符合只听本机）` }));
  });
}

async function chatCheck(model, token) {
  // 规格只要求「拿 200」；一次请求，拿到 HTTP 200 就 PASS。
  // 兼容 HTTP 接口只认 allbot 或 allbot/<agentId>（allbot-src/src/gateway/http-utils.ts:236）。
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "请只回复：S0-1 OK" }],
    max_tokens: 32,
    stream: false,
  });
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const requestTimeout = 90000;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(requestTimeout),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    const choices = Array.isArray(parsed?.choices) ? parsed.choices.length : 0;
    const answer = parsed?.choices?.[0]?.message?.content ?? "";
    const evidence = `POST /v1/chat/completions model=${model} → HTTP ${res.status}（一次请求）, choices=${choices}, 回复="${clip(answer, 120)}"; 响应="${clip(text, 160)}"`;
    return { ok: res.status === 200, evidence };
  } catch (err) {
    return { ok: false, evidence: `POST /v1/chat/completions 异常: ${String(err?.message || err)}` };
  }
}

async function tenantToken(appId, appSecret, label, netTimeout) {
  const tr = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(netTimeout),
  });
  const tj = await tr.json().catch(() => ({}));
  if (tj.code !== 0 || !tj.tenant_access_token) {
    throw new Error(`${label}取 tenant_access_token 失败 HTTP ${tr.status} code=${tj.code} msg=${clip(tj.msg)}`);
  }
  return tj.tenant_access_token;
}

async function feishuCheck() {
  const mainAppId = cfg.channels?.feishu?.appId;
  const mainAppSecret = cfg.channels?.feishu?.appSecret;
  if (!mainAppId || !mainAppSecret) {
    return { ok: false, evidence: "副本 channels.feishu 缺 appId/appSecret，无法读主机器人回复" };
  }
  const netTimeout = Math.min(timeoutMs, 10000);
  try {
    const mainToken = await tenantToken(mainAppId, mainAppSecret, "主机器人", netTimeout);
    const peerToken = await tenantToken(feishuPre.peerAppId, feishuPre.peerAppSecret, "测试机器人", netTimeout);
    const mainHeaders = { Authorization: `Bearer ${mainToken}`, "Content-Type": "application/json" };
    const peerHeaders = { Authorization: `Bearer ${peerToken}`, "Content-Type": "application/json" };

    // 用测试机器人身份发一句带唯一标记的话到群；主机器人通过 receive_v1 收到并回复。
    const marker = `S0-1-${uid()}`;
    const sr = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: peerHeaders,
      body: JSON.stringify({
        receive_id: feishuPre.chatId,
        msg_type: "text",
        content: JSON.stringify({ text: `${marker} 请回复这句` }),
      }),
      signal: AbortSignal.timeout(netTimeout),
    });
    const sj = await sr.json().catch(() => ({}));
    if (sj.code !== 0 || !sj.data?.message_id) {
      return { ok: false, evidence: `测试机器人发消息失败 HTTP ${sr.status} code=${sj.code} msg=${clip(sj.msg)}` };
    }
    const sentId = sj.data.message_id;
    // 发送消息返回的 create_time 是毫秒；GET 历史消息的 start_time 要秒级。
    // 往前留 2 秒余量，防止时钟/服务端精度导致漏掉刚发的那条之后的消息。
    const sentAtMs = Number(sj.data.create_time || Date.now());
    const startSec = Math.floor(sentAtMs / 1000) - 2;

    // 主机器人读群消息：只看 startSec 之后、由主机器人（app 身份）发的回复；
    // 测试机器人自己那条按 message_id 排除。不要求回复回显 marker。
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      const url = `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(feishuPre.chatId)}&start_time=${startSec}&page_size=50&sort_type=ByCreateTimeAsc`;
      const rr = await fetch(url, { headers: mainHeaders, signal: AbortSignal.timeout(netTimeout) });
      const rj = await rr.json().catch(() => ({}));
      const items = rj.data?.items || [];
      for (const it of items) {
        if (it.message_id === sentId) continue;
        if (Number(it.create_time || 0) < startSec * 1000) continue;
        const senderType = it.sender?.sender_type || "";
        const senderId = it.sender?.id || "";
        const idType = it.sender?.id_type || "";
        // 机器人回复的 sender.id 是 appId（id_type=app_id），不是 open_id。
        // sender.id 等于测试机器人 appId 的那条就是自己发的，排除掉。
        if (senderType !== "app" || idType !== "app_id" || senderId === feishuPre.peerAppId) continue;
        if (senderId !== mainAppId) continue;
        let text = "";
        try { text = JSON.parse(it.body?.content || "{}").text || ""; } catch { /* 非 JSON */ }
        return {
          ok: true,
          evidence: `测试机器人发出 message_id=${sentId} marker=${marker}；主机器人读到回复 message_id=${it.message_id} sender=${senderId}(id_type=${idType}, type=${senderType}) text="${clip(text, 160)}"`,
        };
      }
      last = `code=${rj.code} msg=${clip(rj.msg)} items=${items.length}`;
      await sleep(1000);
    }
    return {
      ok: false,
      evidence: `测试机器人发出 message_id=${sentId} marker=${marker} 后 ${timeoutMs / 1000}s 内未读到主机器人回复（chat_id=${feishuPre.chatId}；${last}）。检查主机器人是否开通 im:message.group_msg.include_bot:read`,
    };
  } catch (err) {
    return { ok: false, evidence: `飞书检查异常: ${String(err?.message || err)}` };
  }
}

try {
  const ready = await waitReady();
  if (!ready.ok) {
    // 每项都出一行：起不来时另外两项未执行，按 BLOCK 列出。
    emit("FAIL", "allbot 起不来", `${ready.why}；日志尾部: ${clip(ready.tail, 2000)}`);
    emit("BLOCK", "18789 只监听 127.0.0.1", "allbot 未起来，未执行");
    emit("BLOCK", "一次问答请求 200", "allbot 未起来，未执行");
    if (opts["skip-feishu"]) {
      emit("SKIP", "飞书发一句有回复", "--skip-feishu；未执行");
    } else {
      emit("BLOCK", "飞书发一句有回复", "allbot 未起来，未执行");
    }
    console.log("\n按方案：起不来 → 整个方案改道（先查这台 Windows 上当常驻服务的路数）");
    console.log("结果: 前置类失败（exit 2）");
    process.exitCode = 2;
  } else {
    emit("PASS", "allbot 用副本配置起来了", `ALLBOT_CONFIG_PATH=${configPath}; ${ready.local} LISTENING 用时 ${ready.seconds}s`);

    // 异步启动：listen 后 HTTP 路由可能还在初始化，问答检查内部单次请求带 90s 超时。
    await sleep(1000);

    // 检查 1：18789 只监听 127.0.0.1
    const nowListening = listenersOn(PORT);
    const rows = nowListening.rows || [];
    const listening = rows.filter((r) => r.state === "LISTENING");
    const allLoopback = listening.length > 0 && listening.every((r) => isLoopbackLocal(r.local));
    const lan = await lanConnectProbe();
    const listenOk = allLoopback && lan.reachable !== true;
    emit(
      listenOk ? "PASS" : "FAIL",
      "18789 只监听 127.0.0.1",
      `netstat: ${rows.length ? rows.map((r) => `${r.local} ${r.state} pid=${r.pid}`).join(" | ") : "无监听行"}; ${lan.text}`,
    );

    // 检查 2：一次问答请求拿 200
    const model = "allbot";
    const qa = await chatCheck(model, cfg.gateway?.auth?.token);
    emit(qa.ok ? "PASS" : "FAIL", "一次问答请求 200", qa.evidence);
    if (!qa.ok) {
      console.log("       服务端日志尾部（供排查，根因是否在内取决于服务端是否打印）:");
      const tailLines = logTail.split(/\r?\n/).filter(Boolean).slice(-40);
      console.log(tailLines.map((l) => `         ${l.slice(0, 300)}`).join("\n") || "         （无日志）");
      console.log("       按方案：模型不通 → 先修模型供应商；具体原因看上面的服务端日志");
    }

    // 检查 3：飞书发一句有回复（测试机器人发 → 主机器人回 → 脚本用主机器人凭据读回）
    if (opts["skip-feishu"]) {
      emit("SKIP", "飞书发一句有回复", "--skip-feishu；按方案飞书可降级，不计失败");
    } else if (feishuMissing.length || !cfg.channels?.feishu?.appId || !cfg.channels?.feishu?.appSecret) {
      const missing = [...feishuMissing];
      if (!cfg.channels?.feishu?.appId || !cfg.channels?.feishu?.appSecret) missing.push("副本 channels.feishu appId/appSecret");
      emit("FAIL", "飞书发一句有回复", `前置缺失: ${missing.join(", ")}；未执行真实验证（按规格这是检查项没过，exit 1）`);
    } else {
      const fs = await feishuCheck();
      emit(fs.ok ? "PASS" : "FAIL", "飞书发一句有回复", fs.evidence);
      if (!fs.ok) console.log("       按方案：飞书不通 → 降级为「不通也不用」，不影响主路");
    }

    const pass = results.filter((r) => r.status === "PASS").length;
    const fail = results.filter((r) => r.status === "FAIL").length;
    const skip = results.filter((r) => r.status === "SKIP").length;
    const block = results.filter((r) => r.status === "BLOCK").length;
    console.log(`\n结果: ${pass} PASS, ${fail} FAIL, ${skip} SKIP, ${block} BLOCK`);
    process.exitCode = fail ? 1 : block ? 2 : 0;
  }
} finally {
  cleanup();
}
