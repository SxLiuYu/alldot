#!/usr/bin/env node
// build/tools/e2e-dispatch.mjs —— 端到端演练：经 8799 dot-bridge 的 /mcp 派一个 brain_task。
// 只负责发 JSON-RPC（initialize → notifications/initialized → tools/call），不做判定。
//
//   node build/tools/e2e-dispatch.mjs [--date 2026-11-25] [--base http://127.0.0.1:8799]
//
// 中文意图在脚本里拼好再 JSON.stringify，不经 shell 拼接。

import { readFileSync } from "node:fs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined) throw new Error(`--${name} 缺值`);
  return v;
}

const BASE = arg("base", "http://127.0.0.1:8799");
const DATE = arg("date", new Date().toISOString().slice(0, 10));
const FOLDER = `e2e-${DATE}`;
const PRACTICE_ROOT = "C:/Users/1/Documents/练习";
const TOKEN_PATH = "C:/Users/1/.allbot/dot/bridge-token";

const token = readFileSync(TOKEN_PATH, "utf8").trim();
if (token === "") throw new Error(`token 文件为空：${TOKEN_PATH}`);

async function rpc(body, sessionId) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id") ?? null,
    json,
    text,
  };
}

const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e-drill", version: "0.0.1" },
  },
});
console.log("== initialize ==");
console.log(JSON.stringify({ status: init.status, sessionId: init.sessionId, body: init.json }, null, 2));
if (init.status !== 200 || init.sessionId === null) {
  console.error("initialize 失败，停止。");
  process.exit(1);
}

const ack = await rpc(
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  init.sessionId,
);
console.log("== notifications/initialized ==");
console.log(JSON.stringify({ status: ack.status, body: ack.json }, null, 2));

const intent =
  `在练习文件夹 ${PRACTICE_ROOT} 下建一个叫 ${FOLDER} 的空文件夹。只做这一件事，建好就收工，不要做别的。`;

const call = await rpc(
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "brain_task",
      arguments: {
        intent,
        restated: `在 ${PRACTICE_ROOT} 下新建空文件夹 ${FOLDER}`,
        bot: "e2e-drill",
        declared: {
          paths: [`${PRACTICE_ROOT}/${FOLDER}`],
          done_when: `${PRACTICE_ROOT}/${FOLDER} 这个文件夹存在`,
        },
        profile: "cheap",
      },
    },
  },
  init.sessionId,
);
console.log("== tools/call brain_task ==");
console.log(JSON.stringify({ status: call.status, body: call.json }, null, 2));

const result = call.json?.result;
if (call.json?.error || result?.isError) {
  console.error("brain_task 被拒或出错。");
  process.exit(2);
}
console.log(`== 目标文件夹 ==\n${PRACTICE_ROOT}/${FOLDER}`);
