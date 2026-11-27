/**
 * src/config.test.ts —— 配置加载/校验 + A.7 两条启动断言的验收。
 *
 * 这里钉住四件容易漂的事：
 * 1. config.example.json 必须与 defaultConfig() 逐字一致（B.4 的缺省值）；
 * 2. allbot.plugin.json 的 configSchema 必须与 src/config-schema.ts 描述同一批字段；
 * 3. 写错键名/类型/范围必须当场报错，不能静默忽略；
 * 4. 两条启动断言：tasks.enabled=true 与 compaction≠safeguard 都要抛。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConfigError,
  StartupAssertionError,
  assertStartup,
  configPathIn,
  defaultConfig,
  loadConfig,
  mergeConfig,
  parseConfig,
  startupChecks,
} from "./config.ts";
import { DOT_CORE_CONFIG_SCHEMA } from "./config-schema.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dot-core-config-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConf(dir: string, value: unknown): string {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

test("config.example.json 与 defaultConfig() 一致（B.4 缺省值）", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config.example.json"), "utf8")) as unknown;
  assert.deepEqual(JSON.parse(JSON.stringify(defaultConfig())), example);
});

test("allbot.plugin.json 的 configSchema 与 config-schema.ts 同步", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "allbot.plugin.json"), "utf8")) as {
    id: string;
    configSchema: Record<string, unknown>;
  };
  assert.equal(manifest.id, "dot-core");

  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "description") continue;
      out[k] = strip(v);
    }
    return out;
  };

  assert.deepEqual(strip(manifest.configSchema), strip(DOT_CORE_CONFIG_SCHEMA));
});

test("配置文件不存在时返回缺省值（首次安装的正常情况）", () => {
  withTempDir((dir) => {
    const path = join(dir, "nope.json");
    assert.deepEqual(loadConfig(path), defaultConfig());
    assert.equal(configPathIn(dir), join(dir, "config.json"));
  });
});

test("配置文件覆盖部分字段，其余保持缺省", () => {
  withTempDir((dir) => {
    const path = writeConf(dir, {
      practice: { root: "C:/Users/1/Documents/练习" },
      approvals: { inline_wait_ms: 5000 },
    });
    const cfg = loadConfig(path);
    assert.equal(cfg.practice.root, "C:/Users/1/Documents/练习");
    assert.equal(cfg.approvals.inline_wait_ms, 5000);
    assert.equal(cfg.approvals.ttl_hours, 24);
    assert.equal(cfg.budget.tokens, 2000000);
  });
});

test("未知键名报错（写错字段要当场炸）", () => {
  assert.throws(
    () => parseConfig({ practise: { root: "x" } }),
    (err: unknown) => err instanceof ConfigError && /未知字段/.test((err as Error).message),
  );
  assert.throws(
    () => parseConfig({ approvals: { inline_wait: 1000 } }),
    (err: unknown) => err instanceof ConfigError && (err as ConfigError).path === "config.json.approvals.inline_wait",
  );
});

test("类型/范围不对报错", () => {
  assert.throws(() => parseConfig({ vision: { enabled: "yes" } }), ConfigError);
  assert.throws(() => parseConfig({ budget: { tokens: "很多" } }), ConfigError);
  assert.throws(() => parseConfig({ keepalive: { probe_interval_min: 0 } }), ConfigError);
  assert.throws(() => parseConfig({ desktop: { human_only_apps: ["ok", 3] } }), ConfigError);
  assert.throws(
    () => parseConfig({ keepalive: { disk: { pause_gb: 2, resume_gb: 1 } } }),
    (err: unknown) => err instanceof ConfigError && /resume_gb/.test((err as Error).message),
  );
});

test("practice.root 传空串当没配（null），传数字报错", () => {
  assert.equal(parseConfig({ practice: { root: "   " } }).practice.root, null);
  assert.equal(parseConfig({ practice: { root: null } }).practice.root, null);
  assert.throws(() => parseConfig({ practice: { root: 42 } }), ConfigError);
});

test("say.enabled 默认关，能被 plugins.entries.dot-core.config 覆盖，写错键名报错", () => {
  assert.equal(defaultConfig().say.enabled, false);
  const config = parseConfig({ say: { enabled: true } }, "plugins.entries.dot-core.config");
  assert.equal(config.say.enabled, true);
  assert.throws(() => parseConfig({ say: { enabled: "yes" } }), ConfigError);
  assert.throws(
    () => parseConfig({ say: { enable: true } }),
    (err: unknown) => err instanceof ConfigError && /未知字段/.test((err as Error).message),
  );
});

test("notify 推送通道能被解析：空串合法、poll_sec 有范围、写错键名报错", () => {
  // 空串 = 这条通道没配。之前这里用了不存在的 strAt，整份配置读失败、
  // 所有段悄悄回落缺省（手机接入、语音一起没生效），所以专门钉一条。
  const cfg = parseConfig({
    notify: {
      enabled: true,
      feishu_webhook: "",
      wechat_python: "D:/python.exe",
      wechat_script: " C:/helper.py ",
      wechat_marker: "alldot",
      poll_sec: 15,
    },
  });
  assert.equal(cfg.notify.enabled, true);
  assert.equal(cfg.notify.feishu_webhook, "");
  assert.equal(cfg.notify.wechat_script, "C:/helper.py", "两头空白要 trim 掉");
  assert.equal(cfg.notify.poll_sec, 15);
  assert.equal(defaultConfig().notify.enabled, false);

  assert.throws(() => parseConfig({ notify: { poll_sec: 1 } }), ConfigError);
  assert.throws(() => parseConfig({ notify: { wechat_python: 42 } }), ConfigError);
  assert.throws(
    () => parseConfig({ notify: { webhook: "x" } }),
    (err: unknown) => err instanceof ConfigError && /未知字段/.test((err as Error).message),
  );
});

test("JSON 语法错误包成 ConfigError 且带上文件名", () => {
  withTempDir((dir) => {
    const path = join(dir, "config.json");
    writeFileSync(path, "{ this is not json", "utf8");
    assert.throws(
      () => loadConfig(path),
      (err: unknown) => err instanceof ConfigError && (err as ConfigError).path === path,
    );
  });
});

test("parseConfig 带 base：只盖写了的键，且不改调用方的对象", () => {
  const base = defaultConfig();
  base.approvals.ttl_hours = 7;
  base.practice.root = "D:/原来的";
  const out = parseConfig({ budget: { tokens: 5 } }, "pluginConfig", base);
  assert.equal(out.budget.tokens, 5);
  assert.equal(out.approvals.ttl_hours, 7);
  assert.equal(out.practice.root, "D:/原来的");
  assert.equal(base.budget.tokens, 2_000_000, "base 不能被 parseConfig 改掉");
});

test("mergeConfig 只盖显式字段", () => {
  const base = defaultConfig();
  const override = defaultConfig();
  override.practice.root = "D:/练习";
  const merged = mergeConfig(base, override);
  assert.equal(merged.practice.root, "D:/练习");
  assert.equal(merged.budget.tokens, base.budget.tokens);
});

test("启动断言：默认配置全过（tasks 未开、compaction 未设按 safeguard 算）", () => {
  const checks = assertStartup({});
  assert.deepEqual(checks.map((c) => c.id), ["tasks_disabled", "compaction_safeguard"]);
  assert.ok(checks.every((c) => c.ok));
});

test("启动断言：tasks.enabled=true 必须抛（两套任务源）", () => {
  const checks = startupChecks({ tasks: { enabled: true } });
  assert.equal(checks[0]?.ok, false);
  assert.throws(
    () => assertStartup({ tasks: { enabled: true } }),
    (err: unknown) => err instanceof StartupAssertionError && (err as StartupAssertionError).checks.includes("tasks_disabled"),
  );
});

test("启动断言：compaction.mode 不是 safeguard 必须抛（两套压缩）", () => {
  assert.throws(
    () => assertStartup({ agents: { defaults: { compaction: { mode: "default" } } } }),
    (err: unknown) => err instanceof StartupAssertionError && (err as StartupAssertionError).checks.includes("compaction_safeguard"),
  );
});

test("启动断言：拿不到 api.config 就拒绝加载（fail-closed）", () => {
  assert.throws(() => assertStartup(undefined), StartupAssertionError);
});
