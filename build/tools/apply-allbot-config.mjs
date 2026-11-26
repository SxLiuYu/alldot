// 把 allbot.json 改成「大脑」形态：只听本机、模型走本机池、加载 dot-core。
// 用法：node build/tools/apply-allbot-config.mjs [--check] [--api-key <3065 的网关 Key>]
// 幂等：重复跑结果一样。改前请先备份（本脚本不做备份）。
//
// 关于 apiKey（2026-11-25 修）：本脚本早先把 local 供应商的 key 硬写成占位符 "local"，
// 结果 3065（Agent2API）对所有模型调用一律 401 invalid_api_key，「大脑」其实一步都调不动模型。
// 现在改成：命令行给了 --api-key 就用它；没给就保留配置里已有的真 key；
// 只有两者都没有时才写占位符，并在输出里明确警告「现在调不动模型，去 Agent2API 的
// 「网关 Key」页新建一把，再用 --api-key 传进来」。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const CFG = "C:/Users/1/.allbot/allbot.json";
const PLUGIN_DIR = "C:/Users/1/Documents/研究/dot/build/dot-core";
const PRACTICE_ROOT = "C:/Users/1/Documents/练习";
const checkOnly = process.argv.includes("--check");
const apiKeyIdx = process.argv.indexOf("--api-key");
const apiKeyArg = apiKeyIdx >= 0 ? (process.argv[apiKeyIdx + 1] ?? "") : "";
const PLACEHOLDER = "local";

const raw = readFileSync(CFG, "utf8");
const j = JSON.parse(raw);

const before = {
  bind: j.gateway?.bind,
  primary: j.agents?.defaults?.model?.primary,
  allow: (j.plugins?.allow || []).slice(),
  loadPaths: (j.plugins?.load?.paths || []).slice(),
  hasLocal: Boolean(j.models?.providers?.local),
};

j.gateway = j.gateway || {};
j.gateway.bind = "loopback";

j.models = j.models || {};
j.models.mode = j.models.mode || "merge";
j.models.providers = j.models.providers || {};
const existingKey = j.models.providers.local?.apiKey;
const realKey = apiKeyArg.trim() !== "" ? apiKeyArg.trim() : (typeof existingKey === "string" && existingKey !== PLACEHOLDER ? existingKey : PLACEHOLDER);
j.models.providers.local = {
  baseUrl: "http://127.0.0.1:3065/v1",
  apiKey: realKey,
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
    {
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash (本机池)",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
      compat: {},
    },
  ],
};

j.agents = j.agents || {};
j.agents.defaults = j.agents.defaults || {};
j.agents.defaults.model = j.agents.defaults.model || {};
j.agents.defaults.model.primary = "local/deepseek-v4.1-flash";
// 并发上限（方案 B.4：4/4）。2026-11-26 审计发现 subagents.maxConcurrent 仍是 8。
j.agents.defaults.maxConcurrent = 4;
j.agents.defaults.subagents = j.agents.defaults.subagents || {};
j.agents.defaults.subagents.maxConcurrent = 4;

j.plugins = j.plugins || {};
j.plugins.allow = Array.isArray(j.plugins.allow) ? j.plugins.allow : [];
if (!j.plugins.allow.includes("dot-core")) j.plugins.allow.push("dot-core");
j.plugins.load = j.plugins.load || {};
j.plugins.load.paths = Array.isArray(j.plugins.load.paths) ? j.plugins.load.paths : [];
if (!j.plugins.load.paths.includes(PLUGIN_DIR)) j.plugins.load.paths.push(PLUGIN_DIR);

const after = {
  bind: j.gateway.bind,
  primary: j.agents.defaults.model.primary,
  allow: j.plugins.allow.slice(),
  loadPaths: j.plugins.load.paths.slice(),
  hasLocal: Boolean(j.models.providers.local),
};

console.log("改前：", JSON.stringify(before));
console.log("改后：", JSON.stringify(after));

const keyIsPlaceholder = realKey === PLACEHOLDER;
if (keyIsPlaceholder) {
  console.warn("");
  console.warn("!! 警告：local 供应商的 apiKey 还是占位符 \"" + PLACEHOLDER + "\"，3065 会一律回 401 invalid_api_key。");
  console.warn("!! 这时候 allbot 一步都调不动模型（派活能建、但执行端想不了事）。");
  console.warn("!! 修法：打开 Agent2API →「网关 Key」页 → 新建一把并启用 → 复制，然后跑");
  console.warn("!!   node build/tools/apply-allbot-config.mjs --api-key <那把 key>");
  console.warn("");
}

if (checkOnly) {
  console.log("--check：没有写文件");
  process.exit(0);
}

writeFileSync(CFG, JSON.stringify(j, null, 2) + "\n", "utf8");

const back = JSON.parse(readFileSync(CFG, "utf8"));
if (back.gateway.bind !== "loopback" || !back.models.providers.local || back.agents.defaults.model.primary !== "local/deepseek-v4.1-flash") {
  console.error("回读校验失败：写进去的内容没读回来");
  process.exit(1);
}
console.log("回读校验通过");

// dot 自己的配置目录
if (!existsSync(PRACTICE_ROOT)) {
  mkdirSync(PRACTICE_ROOT, { recursive: true });
  console.log("建了练习文件夹：", PRACTICE_ROOT);
}
mkdirSync("C:/Users/1/.allbot/dot", { recursive: true });
const dotCfgPath = "C:/Users/1/.allbot/dot/config.json";
if (!existsSync(dotCfgPath)) {
  const example = JSON.parse(readFileSync("C:/Users/1/Documents/研究/dot/build/dot-core/config.example.json", "utf8"));
  example.practice = example.practice || {};
  example.practice.root = PRACTICE_ROOT;
  writeFileSync(dotCfgPath, JSON.stringify(example, null, 2) + "\n", "utf8");
  console.log("写了 dot 配置：", dotCfgPath);
} else {
  console.log("dot 配置已存在，没动：", dotCfgPath);
}
