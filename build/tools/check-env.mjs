#!/usr/bin/env node
/**
 * 六组件红绿（dot-合并方案-v2-定稿.md B.11 / 附录 C：check-env.mjs）
 *
 * 3065 模型池 / 18789 allbot 网关 / dot-core 加载状态 / 8799 dot-bridge /
 * 8000 Windows-MCP / 8931 Playwright MCP。全部只读探测，不起、不停任何服务。
 *
 * dot-core 加载状态按 B.7 的两种口径查：
 *   - 网关健康接口里的插件标记（GET /api/status 或 /health 含 dot-core 字样）；
 *   - dot-core 心跳文件（DOT_CORE_HEARTBEAT 环境变量或默认
 *     C:/Users/1/.allbot/dot/state/dot-core-heartbeat.json，5 分钟内算新鲜）。
 * 网关没开时 dot-core 也判红（网关不开，插件也加载不了）。
 *
 * 用法：
 *   node build/tools/check-env.mjs [--json] [--timeout-ms 5000]
 * 退出码：0 六项全绿 / 1 有红 / 2 前置缺失（HTTP 模块异常等）
 */
import net from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";

const DEFAULTS = {
  3065: "http://127.0.0.1:3065/v1/models",
  18789: "http://127.0.0.1:18789/api/status",
  8799: "http://127.0.0.1:8799/health",
  8000: "127.0.0.1:8000",
  // Playwright MCP 只监听 IPv6 loopback（netstat 实测 TCP [::1]:8931 LISTENING，
  // 没有 127.0.0.1:8931），但别的环境可能两个都有。两个都试，任一通即绿。
  8931: ["127.0.0.1:8931", "[::1]:8931"],
};
const DOT_CORE_HEARTBEAT = process.env.DOT_CORE_HEARTBEAT || "C:/Users/1/.allbot/dot/state/dot-core-heartbeat.json";

export function parseArgs(argv) {
  const o = { json: false, timeoutMs: 5000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") o.json = true;
    else if (argv[i] === "--timeout-ms") o.timeoutMs = Number(argv[++i]);
    else if (argv[i] === "--help") {
      console.log("用法: node build/tools/check-env.mjs [--json] [--timeout-ms 5000]");
      process.exit(0);
    } else {
      console.error(`未知参数：${argv[i]}`);
      process.exit(2);
    }
  }
  return o;
}

async function httpGet(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, text: text.slice(0, 2000) };
  } finally {
    clearTimeout(timer);
  }
}

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function dotCoreStatus(gatewayGreen, statusText, timeoutMs) {
  const now = Date.now();
  let hb = null;
  // dot-core 实际写的是 dot-core.heartbeat；早期方案文字里写的是 dot-core-heartbeat.json。
  // 两个名字都认，先查后者再查前者，免得到处对不上。
  const hbCandidates = [DOT_CORE_HEARTBEAT, "C:/Users/1/.allbot/dot/state/dot-core.heartbeat"];
  for (const p of hbCandidates) {
    try {
      if (!existsSync(p)) continue;
      const s = statSync(p);
      let ts = s.mtimeMs;
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        ts = Date.parse(j.ts ?? j.updatedAt ?? j.at ?? "") || ts;
      } catch { /* 用 mtime */ }
      hb = ts;
      break;
    } catch { /* 文件读不到就当没有 */ }
  }
  const hbFresh = hb !== null && now - hb < 5 * 60 * 1000;
  const marker = /dot-core|dot_core|dotCore/i.test(statusText || "");
  const green = gatewayGreen && (marker || hbFresh);
  const evidence = `gateway=${gatewayGreen ? "绿" : "红"} marker=${marker} heartbeat=${hb ? new Date(hb).toISOString() : "无"}`;
  return { green, evidence };
}

// "127.0.0.1:8000" / "[::1]:8931" -> ["127.0.0.1", 8000] / ["::1", 8931]
// 用最后一个冒号切，IPv6 里的冒号不受影响；方括号去掉，net.connect 要裸地址。
function splitHostPort(s) {
  const i = s.lastIndexOf(":");
  const host = s.slice(0, i).replace(/^\[|\]$/g, "");
  return [host, Number(s.slice(i + 1))];
}

export async function checkEnv(opts) {
  const results = [];
  const push = (name, green, evidence) => results.push({ name, green, evidence });

  let gatewayGreen = false;
  let statusText = "";
  try {
    const r = await httpGet(DEFAULTS[18789], opts.timeoutMs);
    gatewayGreen = r.status >= 200 && r.status < 500; // 401 也算网关活着（token 鉴权）
    statusText = r.text;
    push("18789 allbot 网关", gatewayGreen, `HTTP ${r.status}`);
  } catch (e) {
    push("18789 allbot 网关", false, e.message);
  }

  try {
    const r = await httpGet(DEFAULTS[3065], opts.timeoutMs);
    push("3065 模型池", r.status >= 200 && r.status < 300, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  } catch (e) {
    push("3065 模型池", false, e.message);
  }

  const dc = dotCoreStatus(gatewayGreen, statusText, opts.timeoutMs);
  push("dot-core 加载状态", dc.green, dc.evidence);

  try {
    const r = await httpGet(DEFAULTS[8799], opts.timeoutMs);
    push("8799 dot-bridge", r.status >= 200 && r.status < 300, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  } catch (e) {
    push("8799 dot-bridge", false, e.message);
  }

  const [h8000, host8000] = splitHostPort(DEFAULTS[8000]);
  push("8000 Windows-MCP", await tcpOpen(h8000, host8000, opts.timeoutMs), `TCP ${DEFAULTS[8000]}`);

  // 8931 是多地址候选：全部试完，任一通即绿，证据里列出每个地址的结果。
  const pwTried = [];
  let pwGreen = false;
  for (const cand of DEFAULTS[8931]) {
    const [host, port] = splitHostPort(cand);
    const open = await tcpOpen(host, port, opts.timeoutMs);
    pwTried.push(`${cand}=${open ? "通" : "不通"}`);
    if (open) pwGreen = true;
  }
  push("8931 Playwright MCP", pwGreen, `TCP ${pwTried.join(" / ")}`);

  return { ok: results.every((r) => r.green), results };
}

export async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = await checkEnv(opts);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const x of r.results) console.log(`${x.green ? "GREEN" : "RED  "} ${x.name}：${x.evidence}`);
    console.log(r.ok ? "六组件全绿" : "六组件有红项");
  }
  // 不要用 process.exit()：探测 socket/fetch 关句柄还在 libuv 队列里时会触发
  // win/async.c 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），
  // 退出码变成 127，全绿也报红。设 exitCode 让事件循环自己收尾。
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("check-env.mjs")) main();
