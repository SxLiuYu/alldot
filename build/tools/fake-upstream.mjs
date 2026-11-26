#!/usr/bin/env node
// build/tools/fake-upstream.mjs —— 假模型上游（方案第 1 步验收 7）。
//
//   node build/tools/fake-upstream.mjs --port 9999 --scenario 402
//   node build/tools/fake-upstream.mjs --port 9999 --scenario quota_429
//   node build/tools/fake-upstream.mjs --port 9999 --scenario 401
//   node build/tools/fake-upstream.mjs --port 9999 --scenario rate_429
//   node build/tools/fake-upstream.mjs --port 9999 --scenario ok
//
// 验收要求：probe-health.mjs 对这四种上游分别判成红「没钱」、红「没钱」、红「密钥失效」、黄「限流」。
// 四个场景固定返回：
//   402          → HTTP 402 {error:"payment_required"}
//   quota_429    → HTTP 429 {error:{code:"insufficient_quota"}}（正文带 insufficient_quota）
//   401          → HTTP 401 {error:"invalid_api_key"}
//   rate_429     → HTTP 429 {error:{code:"rate_limit_exceeded"}}（正文没有 insufficient_quota）
//   ok           → HTTP 200 {data:[]}（正常）
//
// 退出码：0 起来了；1 参数不对。

import { createServer } from "node:http";

const SCENARIOS = {
  402: { status: 402, body: { error: "payment_required", message: "账户余额不足" } },
  quota_429: {
    status: 429,
    body: { error: { code: "insufficient_quota", message: "免费额度已用完" } },
  },
  401: { status: 401, body: { error: "invalid_api_key", message: "所选 API Key 已失效" } },
  rate_429: {
    status: 429,
    body: { error: { code: "rate_limit_exceeded", message: "请求太频繁，请稍后再试" } },
  },
  ok: { status: 200, body: { data: [], object: "list" } },
};

let port = 9999;
let scenario = "402";
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === "--port") {
    port = Number(process.argv[++i]);
    if (!Number.isInteger(port) || port < 1) {
      console.error("--port 要是整数");
      process.exit(1);
    }
  } else if (a === "--scenario") {
    scenario = process.argv[++i];
    if (!(scenario in SCENARIOS)) {
      console.error(`--scenario 只能是：${Object.keys(SCENARIOS).join(" / ")}`);
      process.exit(1);
    }
  } else {
    console.error(`不认识的参数 ${a}`);
    process.exit(1);
  }
}

const s = SCENARIOS[scenario];
const server = createServer((_req, res) => {
  res.writeHead(s.status, { "content-type": "application/json" });
  res.end(JSON.stringify(s.body));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`假上游听在 http://127.0.0.1:${port}（场景 ${scenario}，HTTP ${s.status}）`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
