#!/usr/bin/env node
// 装载演练 第 1、2 步：只读源配置，改出临时副本。
// 只写 <TEMP>/dot-install-rehearsal/allbot.json，不碰 C:/Users/1/.allbot/allbot.json。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = "C:/Users/1/.allbot/allbot.json";
const OUT_DIR = path.join(os.tmpdir(), "dot-install-rehearsal");

const SRC_FORBIDDEN = path.resolve(SRC);
if (path.resolve(SRC) === path.resolve(path.join(OUT_DIR, "allbot.json"))) {
  throw new Error("源和目标是同一个文件，停");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, "allbot.json");

const raw = fs.readFileSync(SRC, "utf8");
const cfg = JSON.parse(raw);

// ── 第 1 项：gateway.bind + 端口 ──────────────────────────────────────────
cfg.gateway = cfg.gateway ?? {};
cfg.gateway.bind = "loopback";
cfg.gateway.port = 36721;
// 端口换了，controlUi 的白名单跟着换（否则 UI 开着会被 origin 拦）
if (cfg.gateway.controlUi && Array.isArray(cfg.gateway.controlUi.allowedOrigins)) {
  cfg.gateway.controlUi.allowedOrigins = cfg.gateway.controlUi.allowedOrigins.map((o) =>
    String(o).replace("18789", "36721"),
  );
}

// ── 第 2 项：plugins.allow 放行 dot-core ──────────────────────────────────
cfg.plugins = cfg.plugins ?? {};
const allow = Array.isArray(cfg.plugins.allow) ? cfg.plugins.allow.slice() : [];
if (!allow.includes("dot-core")) allow.push("dot-core");
cfg.plugins.allow = allow;

// ── 第 3 项：plugins.load.paths 指向源码目录 ──────────────────────────────
cfg.plugins.load = { paths: ["C:/Users/1/Documents/研究/dot/build/dot-core"] };

// ── 第 4 项：默认模型从 bond 换到本机 3065 ────────────────────────────────
cfg.models = cfg.models ?? {};
cfg.models.providers = cfg.models.providers ?? {};
cfg.models.providers.local = {
  baseUrl: "http://127.0.0.1:3065/v1",
  apiKey: "local",
  api: "openai-completions",
  models: [
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek v4.1 Flash (本机池)",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
      compat: {},
    },
  ],
};
cfg.agents = cfg.agents ?? {};
cfg.agents.defaults = cfg.agents.defaults ?? {};
cfg.agents.defaults.model = { ...(cfg.agents.defaults.model ?? {}), primary: "local/deepseek-v4.1-flash" };

// ── 额外一项（隔离，不是装配要求）：关掉飞书通道 ──────────────────────────
// 副本里留着正式 appId/appSecret，起来会去抢正式机器人的 websocket 并接真实消息。
// 演练只验插件装载，不需要任何外部通道。
if (cfg.channels?.feishu) cfg.channels.feishu.enabled = false;

fs.writeFileSync(OUT, JSON.stringify(cfg, null, 2) + "\n", "utf8");

// ── 回读校验，任何一项不对就抛 ────────────────────────────────────────────
const back = JSON.parse(fs.readFileSync(OUT, "utf8"));
const errors = [];
if (back.gateway?.bind !== "loopback") errors.push("gateway.bind");
if (back.gateway?.port !== 36721) errors.push("gateway.port");
if (!back.plugins?.allow?.includes("dot-core")) errors.push("plugins.allow");
if (back.plugins?.load?.paths?.[0] !== "C:/Users/1/Documents/研究/dot/build/dot-core") errors.push("plugins.load.paths");
if (back.agents?.defaults?.model?.primary !== "local/deepseek-v4.1-flash") errors.push("model.primary");
if (back.models?.providers?.local?.baseUrl !== "http://127.0.0.1:3065/v1") errors.push("providers.local");
if (back.channels?.feishu?.enabled !== false) errors.push("feishu.enabled");

if (errors.length) {
  console.error("[prepare] 回读校验失败：" + errors.join(", "));
  process.exit(1);
}
console.log("[prepare] 副本：" + OUT);
console.log("[prepare] 源文件未改（只读打开）：" + SRC);
console.log("[prepare] 四项已落盘并通过回读校验");
