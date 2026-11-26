#!/usr/bin/env node
// 装载演练 第 3 步：按 gateway.cmd 的方式起网关，但配置指到副本、端口 36721、状态目录也在副本目录里。
// 只读 C:/allbot-public/dist/index.js；不写 ~/.allbot、不写 ~/.dsh。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DIR = path.join(os.tmpdir(), "dot-install-rehearsal");
const CONFIG = path.join(DIR, "allbot.json");
const STATE = path.join(DIR, "state");
const DOT_DIR = path.join(DIR, "dot");
const LOG = path.join(DIR, "gateway.log");

fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(DOT_DIR, { recursive: true });
if (!fs.existsSync(CONFIG)) {
  console.error("[launch] 找不到副本配置：" + CONFIG);
  process.exit(1);
}
fs.writeFileSync(LOG, "", "utf8");

const env = {
  ...process.env,
  HOME: "C:\\Users\\1",
  TMPDIR: os.tmpdir(),
  NO_PROXY: "localhost;127.*;10.*;172.16.*;192.168.*",
  no_proxy: "localhost;127.*;10.*;172.16.*;192.168.*",
  ALLBOT_CONFIG_PATH: CONFIG,
  ALLBOT_STATE_DIR: STATE,
  ALLBOT_GATEWAY_PORT: "36721",
  // dot-core 的状态全部挪进副本目录，避免写 ~/.allbot/dot
  DOT_CORE_DOT_DIR: DOT_DIR,
  DOT_CORE_CONFIG_FILE: path.join(DOT_DIR, "config.json"),
  DOT_CORE_LEDGER: path.join(DOT_DIR, "ledger", "dot.db"),
  DOT_CORE_KEEP_FILE: path.join(DOT_DIR, "state", "dot-core.heartbeat"),
  DOT_CORE_SNAPSHOTS_DIR: path.join(DOT_DIR, "snapshots"),
  // 演练不需要真连模型
  ALLBOT_DISABLE_TELEMETRY: "1",
};

const out = fs.openSync(LOG, "a");
const child = spawn("C:\\Program Files\\nodejs\\node.exe", ["C:\\allbot-public\\dist\\index.js", "gateway", "--port", "36721"], {
  cwd: "C:\\allbot-public",
  env,
  detached: true,
  stdio: ["ignore", out, out],
  windowsHide: true,
});
child.unref();

fs.writeFileSync(
  path.join(DIR, "pid.json"),
  JSON.stringify({ pid: child.pid, log: LOG, startedAt: new Date().toISOString(), config: CONFIG, state: STATE }, null, 2) + "\n",
  "utf8",
);
console.log("[launch] pid=" + child.pid);
console.log("[launch] log=" + LOG);
console.log("[launch] config=" + CONFIG);
