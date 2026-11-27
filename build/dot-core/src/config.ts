/**
 * src/config.ts —— dot-core 自己的配置（方案 B.4：`~/.allbot/dot/config.json`）。
 *
 * 为什么单独一份、不塞进 allbot.json：
 * - allbot.json 由用户/网关管，dot-core 只读它做两条启动断言（A.7），绝不回写；
 * - 这份配置全是 dot 的字段（审批等待、预算、占盘阈值、练习文件夹），
 *   混进去以后每次升级 allbot 都要重新对齐 schema。
 *
 * 校验口径：缺字段用 B.4 的缺省值补齐；**多出来的键直接报错**（写错字段名要当场
 * 炸，不能静默忽略——静默忽略等于配置没生效还没人知道）；类型/范围不对也报错。
 * 报错信息带 `config.json:键路径`，方便装的时候定位。
 *
 * 本文件不读时钟、不碰文件以外的全局状态，测试直接用临时文件。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AccessMode } from "./bridge/access.ts";

/** 手机接入方式：loopback=只本机，lan=局域网直连，tunnel=内网穿透，relay=自定义中继。 */
export interface MobileAccessConfig {
  mode: AccessMode;
  allowed_cidrs: string[];
}

/** 语音（ASR/TTS）上游配置。密钥不写进配置，走环境变量。 */
export interface VoiceSettings {
  enabled: boolean;
  base_url: string;
  api_key_env: string;
  voice: string;
  max_asr_seconds: number;
  max_tts_chars: number;
}

export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ConfigError";
    this.path = path;
  }
}

export class StartupAssertionError extends Error {
  readonly checks: readonly string[];
  constructor(message: string, checks: readonly string[] = []) {
    super(message);
    this.name = "StartupAssertionError";
    this.checks = checks;
  }
}

export interface DotCoreConfig {
  vision: { enabled: boolean };
  approvals: {
    inline_wait_ms: number;
    ttl_hours: number;
    /**
     * 自动同意的档位上限：0 = 关（默认）；1..4 = 这个档位及以下不用人点，直接执行并留痕。
     * 5（身份/钱）、6（危险）永远不自动 —— 那两档的含义就是「交还人手」。
     */
    auto_approve_max_tier: number;
  };
  desktop: {
    batch_actions: number;
    exclude_processes: string[];
    human_only_apps: string[];
    /** Windows-MCP 的 streamable-HTTP 地址（电脑手唯一入口）。 */
    mcp_url: string;
  };
  wechat: {
    /** 微信用的那只 MCP（streamable-HTTP）。默认指向 wechat-mcp 的 HTTP 入口 8933。 */
    enabled: boolean;
    mcp_url: string;
  };
  browser: {
    /** 验证码/人机验证关键词：snapshot/截图里命中就停手交还人手。 */
    captcha: { keywords: string[] };
    /** 已登录浏览器的 Playwright MCP 地址（用 --user-data-dir 指向用户 profile）。 */
    logged_mcp_url: string;
    /** 干净浏览器的 Playwright MCP 地址（--isolated，不碰用户登录态）。 */
    clean_mcp_url: string;
    /** 干净浏览器的 profile 路径；null = --isolated（不留任何状态）。 */
    clean_profile: string | null;
  };
  budget: { tokens: number };
  keepalive: {
    probe_interval_min: number;
    probe_tiers: string[];
    disk: {
      warn_gb: number;
      red_gb: number;
      pause_gb: number;
      resume_gb: number;
      hysteresis_min: number;
    };
    artifacts_max_gb: number;
    snapshots_max_gb: number;
    backups_max_gb: number;
    guard_log_max_mb: number;
  };
  /** exec 程序白名单的增量（空＝只用 gate 内置的 DEFAULT_EXEC_WHITELIST）。 */
  exec: { whitelist: string[] };
  /**
   * 派发器（取活循环）。`enabled=false` 是一键停用：看门狗那边出事时先停派发，
   * 不再从 queued 里领新任务，已经在跑的会话不受影响（它们会自己走完或超时）。
   */
  dispatch: {
    enabled: boolean;
    /** 扫 queued 的间隔，毫秒。默认 5000。 */
    interval_ms: number;
    /** 单个工人会话的上限，毫秒。超时任务转 paused。默认 600000（10 分钟）。 */
    session_timeout_ms: number;
    /** 一次扫描最多领几个任务。默认 1（严格先来先做）。 */
    max_concurrent: number;
    /** 任务锁租期，毫秒。会话期间按间隔续租，派发器死了就到点自动释放。默认 900000。 */
    lock_ttl_ms: number;
  };
  /**
   * 练习文件夹（B.4 之外的唯一一个新增字段，最小那只手要用）。
   * null = 没配，手直接拒绝执行（fail-closed），不会回落到任何默认目录。
   */
  practice: { root: string | null };
  /**
   * 说人话改写层（第 3 步 C）。默认关：关着时桥的卡片逐字不动。
   * 开着才会把 /status 的 card 与请示卡文案交给模型改写（失败仍退回原文）。
   */
  say: { enabled: boolean };
  /**
   * 推送到手机：把「要你批」和「任务结果」推出去。
   * 两条通道，填哪个用哪个，微信优先：wechat_python（helper 的 python）+ wechat_script；
   * 飞书只需 feishu_webhook。都没填就是关着。
   * 只推这两类，进度不推（推多了人会把通知关掉）。
   */
  notify: {
    enabled: boolean;
    feishu_webhook: string;
    wechat_python: string;
    wechat_script: string;
    wechat_marker: string;
    poll_sec: number;
  };
  /**
   * 自我优化（体检 → 提改动建议）。默认关。
   * 关着时 collectMetrics 仍可单独调用，但 propose / apply 一律不跑。
   * 开着也只到「写 pending 补丁 + 请示卡」，绝不改源码，见 src/selfimprove/。
   */
  self_improve: { enabled: boolean; max_proposals_per_day: number };
  /** 手机接入：默认 loopback（老安装行为不变）。 */
  mobile_access: MobileAccessConfig;
  /** 语音：默认关，开之前要配好环境变量里的上游 key。 */
  voice: VoiceSettings;
}

/** B.4 的缺省值，逐字照抄；config.example.json 必须与本函数的输出一致（有测试）。 */
export function defaultConfig(): DotCoreConfig {
  return {
    vision: { enabled: false },
    approvals: { inline_wait_ms: 90000, ttl_hours: 24, auto_approve_max_tier: 0 },
    desktop: {
      batch_actions: 10,
      exclude_processes: [],
      human_only_apps: ["Weixin", "WeChat"],
      mcp_url: "http://127.0.0.1:8000/mcp",
    },
    // 微信：wechat_mcp.py 原本只跑 stdio，8933 是它的 HTTP 入口
    // （D:/项目/wechat-mcp/wechat_mcp_http.py）。服务没起时这只手调了就是「干不了」。
    wechat: { enabled: true, mcp_url: "http://127.0.0.1:8933/mcp" },
    browser: {
      captcha: { keywords: ["验证码", "captcha", "滑块", "人机验证"] },
      logged_mcp_url: "http://localhost:8931/mcp",
      clean_mcp_url: "http://localhost:8932/mcp",
      clean_profile: null,
    },
    budget: { tokens: 2000000 },
    keepalive: {
      probe_interval_min: 5,
      probe_tiers: ["cheap", "balanced", "strong"],
      disk: {
        warn_gb: 5,
        red_gb: 2,
        pause_gb: 0.8,
        resume_gb: 1,
        hysteresis_min: 10,
      },
      artifacts_max_gb: 2,
      snapshots_max_gb: 5,
      backups_max_gb: 5,
      guard_log_max_mb: 50,
    },
    exec: { whitelist: [] },
    dispatch: {
      enabled: true,
      interval_ms: 5000,
      session_timeout_ms: 600000,
      max_concurrent: 1,
      lock_ttl_ms: 900000,
    },
    practice: { root: null },
    say: { enabled: false },
    notify: {
      enabled: false,
      feishu_webhook: "",
      wechat_python: "",
      wechat_script: "",
      wechat_marker: "alldot",
      poll_sec: 10,
    },
    self_improve: { enabled: true, max_proposals_per_day: 2 },
    mobile_access: { mode: "loopback", allowed_cidrs: [] },
    voice: {
      enabled: false,
      base_url: "https://www.sxliuyu.bond",
      api_key_env: "ALLDOT_VOICE_API_KEY",
      voice: "alloy",
      max_asr_seconds: 58,
      max_tts_chars: 450,
    },
  };
}

/** 默认位置：`~/.allbot/dot/config.json`（dotDir 由 bridge/paths.ts 决定，测试可换）。 */
export function configPathIn(dotDir: string): string {
  return join(dotDir, "config.json");
}

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new ConfigError(path, message);
}

function objectAt(path: string, value: Json, allowed: readonly string[]): Record<string, Json> {
  if (!isPlainObject(value)) fail(path, "应为对象");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, `未知字段（允许：${allowed.join(", ") || "无"}）`);
    }
  }
  return value;
}

function boolAt(path: string, value: Json): boolean {
  if (typeof value !== "boolean") fail(path, "应为 true/false");
  return value;
}

function numberAt(path: string, value: Json, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "应为数字");
  if (value < min || value > max) fail(path, `应在 ${min}..${max} 之间`);
  return value;
}

function stringListAt(path: string, value: Json): string[] {
  if (!Array.isArray(value)) fail(path, "应为字符串数组");
  return value.map((item, i) => {
    if (typeof item !== "string") fail(`${path}[${i}]`, "应为字符串");
    return item;
  });
}

/** 非空字符串；地址类字段用它（空串等于没配，但这里选择当场报错而不是静默回落）。 */
function nonEmptyStringAt(path: string, value: Json): string {
  if (typeof value !== "string") fail(path, "应为字符串");
  const trimmed = value.trim();
  if (trimmed === "") fail(path, "不能是空字符串");
  return trimmed;
}

/**
 * 普通字符串，允许空串（空 = 没配）。推送通道的几个路径用它：
 * 用户可能只配飞书、微信留空，空串必须合法。
 */
function stringAt(path: string, value: Json): string {
  if (typeof value !== "string") fail(path, "应为字符串");
  return value.trim();
}

function recordAt(path: string, value: Json): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, "应为对象");
  return { ...value };
}

/**
 * 把「用户写的那份 JSON」叠到 base（默认是 B.4 的缺省值）上并逐键校验。
 * 只盖显式写了的键；写错键名/类型/范围会抛 ConfigError。
 *
 * base 参数给两处用：
 * - `plugins.entries.dot-core.config`（api.pluginConfig）叠在 dot/config.json 的结果之上；
 * - 测试里构造一个非缺省的底。
 */
export function parseConfig(raw: Json, path = "config.json", base?: DotCoreConfig): DotCoreConfig {
  const out = base === undefined ? defaultConfig() : cloneConfig(base);
  if (raw === undefined) return out;
  const root = objectAt(path, raw, [
    "vision",
    "approvals",
    "desktop",
    "wechat",
    "browser",
    "budget",
    "keepalive",
    "exec",
    "dispatch",
    "practice",
    "say",
    "notify",
    "self_improve",
    "mobile_access",
    "voice",
  ]);

  if (root["vision"] !== undefined) {
    const v = objectAt(`${path}.vision`, root["vision"], ["enabled"]);
    if (v["enabled"] !== undefined) out.vision.enabled = boolAt(`${path}.vision.enabled`, v["enabled"]);
  }

  if (root["approvals"] !== undefined) {
    const a = objectAt(`${path}.approvals`, root["approvals"], [
      "inline_wait_ms",
      "ttl_hours",
      "auto_approve_max_tier",
    ]);
    if (a["inline_wait_ms"] !== undefined) {
      out.approvals.inline_wait_ms = numberAt(
        `${path}.approvals.inline_wait_ms`,
        a["inline_wait_ms"],
        0,
        30 * 60 * 1000,
      );
    }
    if (a["ttl_hours"] !== undefined) {
      out.approvals.ttl_hours = numberAt(`${path}.approvals.ttl_hours`, a["ttl_hours"], 1, 24 * 30);
    }
    if (a["auto_approve_max_tier"] !== undefined) {
      // 上限只到 4：5/6 档（身份钱、危险）永远要人点，配置写多大都不越界。
      out.approvals.auto_approve_max_tier = numberAt(
        `${path}.approvals.auto_approve_max_tier`,
        a["auto_approve_max_tier"],
        0,
        4,
      );
    }
  }

  if (root["desktop"] !== undefined) {
    const d = objectAt(`${path}.desktop`, root["desktop"], [
      "batch_actions",
      "exclude_processes",
      "human_only_apps",
      "mcp_url",
    ]);
    if (d["batch_actions"] !== undefined) {
      out.desktop.batch_actions = numberAt(`${path}.desktop.batch_actions`, d["batch_actions"], 1, 100);
    }
    if (d["exclude_processes"] !== undefined) {
      out.desktop.exclude_processes = stringListAt(`${path}.desktop.exclude_processes`, d["exclude_processes"]);
    }
    if (d["human_only_apps"] !== undefined) {
      out.desktop.human_only_apps = stringListAt(`${path}.desktop.human_only_apps`, d["human_only_apps"]);
    }
    if (d["mcp_url"] !== undefined) {
      out.desktop.mcp_url = nonEmptyStringAt(`${path}.desktop.mcp_url`, d["mcp_url"]);
    }
  }

  if (root["wechat"] !== undefined) {
    const w = objectAt(`${path}.wechat`, root["wechat"], ["enabled", "mcp_url"]);
    if (w["enabled"] !== undefined) out.wechat.enabled = boolAt(`${path}.wechat.enabled`, w["enabled"]);
    if (w["mcp_url"] !== undefined) {
      out.wechat.mcp_url = nonEmptyStringAt(`${path}.wechat.mcp_url`, w["mcp_url"]);
    }
  }

  if (root["browser"] !== undefined) {
    const b = objectAt(`${path}.browser`, root["browser"], [
      "captcha",
      "logged_mcp_url",
      "clean_mcp_url",
      "clean_profile",
    ]);
    if (b["captcha"] !== undefined) {
      const captcha = objectAt(`${path}.browser.captcha`, b["captcha"], ["keywords"]);
      if (captcha["keywords"] !== undefined) {
        out.browser.captcha.keywords = stringListAt(
          `${path}.browser.captcha.keywords`,
          captcha["keywords"],
        );
      }
    }
    if (b["logged_mcp_url"] !== undefined) {
      out.browser.logged_mcp_url = nonEmptyStringAt(`${path}.browser.logged_mcp_url`, b["logged_mcp_url"]);
    }
    if (b["clean_mcp_url"] !== undefined) {
      out.browser.clean_mcp_url = nonEmptyStringAt(`${path}.browser.clean_mcp_url`, b["clean_mcp_url"]);
    }
    if (b["clean_profile"] !== undefined) {
      const value = b["clean_profile"];
      if (value === null) out.browser.clean_profile = null;
      else if (typeof value === "string") out.browser.clean_profile = value.trim() === "" ? null : value;
      else fail(`${path}.browser.clean_profile`, "应为字符串或 null");
    }
  }

  if (root["budget"] !== undefined) {
    const b = objectAt(`${path}.budget`, root["budget"], ["tokens"]);
    if (b["tokens"] !== undefined) out.budget.tokens = numberAt(`${path}.budget.tokens`, b["tokens"], 1);
  }

  if (root["keepalive"] !== undefined) {
    const k = objectAt(`${path}.keepalive`, root["keepalive"], [
      "probe_interval_min",
      "probe_tiers",
      "disk",
      "artifacts_max_gb",
      "snapshots_max_gb",
      "backups_max_gb",
      "guard_log_max_mb",
      // 2026-11-26 加：keeper 的三档余额探针配置（balance_probe.enabled/models）。
      // dot-core 自己不用这个字段，但 keeper 从同一份 config.json 的 keepalive 段读它；
      // 不放行的话 keeper 配了会被 dot-core 的校验拒掉（ConfigError）。
      "balance_probe",
    ]);
    if (k["probe_interval_min"] !== undefined) {
      out.keepalive.probe_interval_min = numberAt(
        `${path}.keepalive.probe_interval_min`,
        k["probe_interval_min"],
        1,
        24 * 60,
      );
    }
    if (k["probe_tiers"] !== undefined) {
      out.keepalive.probe_tiers = stringListAt(`${path}.keepalive.probe_tiers`, k["probe_tiers"]);
    }
    if (k["disk"] !== undefined) {
      const disk = objectAt(`${path}.keepalive.disk`, k["disk"], [
        "warn_gb",
        "red_gb",
        "pause_gb",
        "resume_gb",
        "hysteresis_min",
      ]);
      const diskOut = out.keepalive.disk;
      if (disk["warn_gb"] !== undefined) diskOut.warn_gb = numberAt(`${path}.keepalive.disk.warn_gb`, disk["warn_gb"], 0);
      if (disk["red_gb"] !== undefined) diskOut.red_gb = numberAt(`${path}.keepalive.disk.red_gb`, disk["red_gb"], 0);
      if (disk["pause_gb"] !== undefined) diskOut.pause_gb = numberAt(`${path}.keepalive.disk.pause_gb`, disk["pause_gb"], 0);
      if (disk["resume_gb"] !== undefined) diskOut.resume_gb = numberAt(`${path}.keepalive.disk.resume_gb`, disk["resume_gb"], 0);
      if (disk["hysteresis_min"] !== undefined) {
        diskOut.hysteresis_min = numberAt(`${path}.keepalive.disk.hysteresis_min`, disk["hysteresis_min"], 0, 24 * 60);
      }
      if (diskOut.resume_gb < diskOut.pause_gb) {
        fail(`${path}.keepalive.disk`, "resume_gb 不能小于 pause_gb（否则盘一紧一松会来回抖）");
      }
    }
    for (const key of ["artifacts_max_gb", "snapshots_max_gb", "backups_max_gb"] as const) {
      if (k[key] !== undefined) out.keepalive[key] = numberAt(`${path}.keepalive.${key}`, k[key], 0);
    }
    if (k["guard_log_max_mb"] !== undefined) {
      out.keepalive.guard_log_max_mb = numberAt(`${path}.keepalive.guard_log_max_mb`, k["guard_log_max_mb"], 0);
    }
  }

  if (root["exec"] !== undefined) {
    const e = objectAt(`${path}.exec`, root["exec"], ["whitelist"]);
    if (e["whitelist"] !== undefined) out.exec.whitelist = stringListAt(`${path}.exec.whitelist`, e["whitelist"]);
  }

  if (root["dispatch"] !== undefined) {
    const d = objectAt(`${path}.dispatch`, root["dispatch"], [
      "enabled",
      "interval_ms",
      "session_timeout_ms",
      "max_concurrent",
      "lock_ttl_ms",
    ]);
    if (d["enabled"] !== undefined) out.dispatch.enabled = boolAt(`${path}.dispatch.enabled`, d["enabled"]);
    if (d["interval_ms"] !== undefined) {
      out.dispatch.interval_ms = numberAt(`${path}.dispatch.interval_ms`, d["interval_ms"], 200, 600000);
    }
    if (d["session_timeout_ms"] !== undefined) {
      out.dispatch.session_timeout_ms = numberAt(
        `${path}.dispatch.session_timeout_ms`,
        d["session_timeout_ms"],
        1000,
        24 * 3600 * 1000,
      );
    }
    if (d["max_concurrent"] !== undefined) {
      out.dispatch.max_concurrent = Math.floor(
        numberAt(`${path}.dispatch.max_concurrent`, d["max_concurrent"], 1, 8),
      );
    }
    if (d["lock_ttl_ms"] !== undefined) {
      out.dispatch.lock_ttl_ms = numberAt(`${path}.dispatch.lock_ttl_ms`, d["lock_ttl_ms"], 60000, 24 * 3600 * 1000);
    }
    if (out.dispatch.lock_ttl_ms < out.dispatch.interval_ms) {
      fail(`${path}.dispatch.lock_ttl_ms`, "不能小于 interval_ms（否则锁会比扫描间隔先过期）");
    }
  }

  if (root["practice"] !== undefined) {
    const p = objectAt(`${path}.practice`, root["practice"], ["root"]);
    if (p["root"] !== undefined) {
      const value = p["root"];
      if (value === null) out.practice.root = null;
      else if (typeof value === "string") out.practice.root = value.trim() === "" ? null : value;
      else fail(`${path}.practice.root`, "应为字符串或 null");
    }
  }

  if (root["say"] !== undefined) {
    const s = objectAt(`${path}.say`, root["say"], ["enabled"]);
    if (s["enabled"] !== undefined) out.say.enabled = boolAt(`${path}.say.enabled`, s["enabled"]);
  }

  if (root["notify"] !== undefined) {
    const n = objectAt(`${path}.notify`, root["notify"], [
      "enabled",
      "feishu_webhook",
      "wechat_python",
      "wechat_script",
      "wechat_marker",
      "poll_sec",
    ]);
    if (n["enabled"] !== undefined) out.notify.enabled = boolAt(`${path}.notify.enabled`, n["enabled"]);
    if (n["feishu_webhook"] !== undefined) {
      out.notify.feishu_webhook = stringAt(`${path}.notify.feishu_webhook`, n["feishu_webhook"]);
    }
    if (n["wechat_python"] !== undefined) {
      out.notify.wechat_python = stringAt(`${path}.notify.wechat_python`, n["wechat_python"]);
    }
    if (n["wechat_script"] !== undefined) {
      out.notify.wechat_script = stringAt(`${path}.notify.wechat_script`, n["wechat_script"]);
    }
    if (n["wechat_marker"] !== undefined) {
      out.notify.wechat_marker = stringAt(`${path}.notify.wechat_marker`, n["wechat_marker"]);
    }
    if (n["poll_sec"] !== undefined) {
      out.notify.poll_sec = numberAt(`${path}.notify.poll_sec`, n["poll_sec"], 5, 600);
    }
  }

  if (root["self_improve"] !== undefined) {
    const si = objectAt(`${path}.self_improve`, root["self_improve"], [
      "enabled",
      "max_proposals_per_day",
    ]);
    if (si["enabled"] !== undefined) {
      out.self_improve.enabled = boolAt(`${path}.self_improve.enabled`, si["enabled"]);
    }
    if (si["max_proposals_per_day"] !== undefined) {
      out.self_improve.max_proposals_per_day = Math.floor(
        numberAt(`${path}.self_improve.max_proposals_per_day`, si["max_proposals_per_day"], 0, 20),
      );
    }
  }

  if (root["mobile_access"] !== undefined) {
    const m = objectAt(`${path}.mobile_access`, root["mobile_access"], ["mode", "allowed_cidrs"]);
    if (m["mode"] !== undefined) {
      const v = nonEmptyStringAt(`${path}.mobile_access.mode`, m["mode"]);
      if (v !== "loopback" && v !== "lan" && v !== "tunnel" && v !== "relay") {
        fail(`${path}.mobile_access.mode`, "只能是 loopback / lan / tunnel / relay");
      }
      out.mobile_access.mode = v as AccessMode;
    }
    if (m["allowed_cidrs"] !== undefined) {
      out.mobile_access.allowed_cidrs = stringListAt(
        `${path}.mobile_access.allowed_cidrs`,
        m["allowed_cidrs"],
      );
    }
  }

  if (root["voice"] !== undefined) {
    const v = objectAt(`${path}.voice`, root["voice"], [
      "enabled",
      "base_url",
      "api_key_env",
      "voice",
      "max_asr_seconds",
      "max_tts_chars",
    ]);
    if (v["enabled"] !== undefined) out.voice.enabled = boolAt(`${path}.voice.enabled`, v["enabled"]);
    if (v["base_url"] !== undefined) {
      out.voice.base_url = nonEmptyStringAt(`${path}.voice.base_url`, v["base_url"]);
    }
    if (v["api_key_env"] !== undefined) {
      out.voice.api_key_env = nonEmptyStringAt(`${path}.voice.api_key_env`, v["api_key_env"]);
    }
    if (v["voice"] !== undefined) out.voice.voice = nonEmptyStringAt(`${path}.voice.voice`, v["voice"]);
    if (v["max_asr_seconds"] !== undefined) {
      out.voice.max_asr_seconds = numberAt(`${path}.voice.max_asr_seconds`, v["max_asr_seconds"], 1, 600);
    }
    if (v["max_tts_chars"] !== undefined) {
      out.voice.max_tts_chars = numberAt(`${path}.voice.max_tts_chars`, v["max_tts_chars"], 1, 2000);
    }
  }

  return out;
}

export interface LoadConfigOptions {
  /** 文件不存在时是否当成「全缺省」而不是报错。默认 true（首次安装没有文件是正常的）。 */
  missingOk?: boolean;
}

/** 读一份配置文件。JSON 语法错误也包成 ConfigError，带文件名和行列号。 */
export function loadConfig(path: string, opts: LoadConfigOptions = {}): DotCoreConfig {
  const missingOk = opts.missingOk ?? true;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" && missingOk) return defaultConfig();
    throw new ConfigError(path, `读不到：${(err as Error).message}`);
  }

  let raw: Json;
  try {
    raw = JSON.parse(stripBom(text)) as Json;
  } catch (err) {
    throw new ConfigError(path, `JSON 语法错误：${(err as Error).message}`);
  }
  return parseConfig(raw, path);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 深拷贝一份配置（parseConfig 的 base 用它，避免把调用方的对象改掉）。 */
export function cloneConfig(config: DotCoreConfig): DotCoreConfig {
  return {
    vision: { ...config.vision },
    approvals: { ...config.approvals },
    desktop: {
      ...config.desktop,
      exclude_processes: [...config.desktop.exclude_processes],
      human_only_apps: [...config.desktop.human_only_apps],
    },
    wechat: { ...config.wechat },
    browser: {
      captcha: { keywords: [...config.browser.captcha.keywords] },
      logged_mcp_url: config.browser.logged_mcp_url,
      clean_mcp_url: config.browser.clean_mcp_url,
      clean_profile: config.browser.clean_profile,
    },
    budget: { ...config.budget },
    keepalive: {
      ...config.keepalive,
      probe_tiers: [...config.keepalive.probe_tiers],
      disk: { ...config.keepalive.disk },
    },
    exec: { whitelist: [...config.exec.whitelist] },
    dispatch: { ...config.dispatch },
    practice: { ...config.practice },
    say: { ...config.say },
    notify: { ...config.notify },
    self_improve: { ...config.self_improve },
    mobile_access: { ...config.mobile_access, allowed_cidrs: [...config.mobile_access.allowed_cidrs] },
    voice: { ...config.voice },
  };
}

/**
 * 用 base 打底、把 override 盖上去（逐字段浅合并，disk 单独合）。
 * 只给测试与未来的「分层配置」用；生产路径只有「文件 → pluginConfig」两层。
 */
export function mergeConfig(base: DotCoreConfig, override: DotCoreConfig): DotCoreConfig {
  return {
    vision: { ...base.vision, ...override.vision },
    approvals: { ...base.approvals, ...override.approvals },
    desktop: { ...base.desktop, ...override.desktop },
    wechat: { ...base.wechat, ...override.wechat },
    browser: {
      ...base.browser,
      ...override.browser,
      captcha: { ...base.browser.captcha, ...override.browser.captcha },
    },
    budget: { ...base.budget, ...override.budget },
    keepalive: {
      ...base.keepalive,
      ...override.keepalive,
      disk: { ...base.keepalive.disk, ...override.keepalive.disk },
    },
    exec: { ...base.exec, ...override.exec },
    dispatch: { ...base.dispatch, ...override.dispatch },
    practice: { ...base.practice, ...override.practice },
    say: { ...base.say, ...override.say },
    notify: { ...base.notify, ...override.notify },
    self_improve: { ...base.self_improve, ...override.self_improve },
    mobile_access: { ...base.mobile_access, ...override.mobile_access },
    voice: { ...base.voice, ...override.voice },
  };
}

/** config.example.json 的形状：与 defaultConfig() 完全一致（有测试守着）。 */
export function exampleConfig(): DotCoreConfig {
  return defaultConfig();
}

// ────────────────────────────────────────────────────────────────────────────
// A.7 两条启动断言
//
// 只读 api.config（allbot.json 的解析结果），不回写、不修配置。断言失败就抛：
// 插件 register() 抛异常，allbot 视为插件加载失败（B.3 的 fail-closed 前提）。
// ────────────────────────────────────────────────────────────────────────────

/** 断言要看的最小配置面；从 api.config 里原样取，不做类型体操。 */
export interface AllbotConfigSlice {
  tasks?: { enabled?: boolean };
  agents?: { defaults?: { compaction?: { mode?: string } } };
  compaction?: { mode?: string };
}

export interface StartupCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/**
 * 两条启动断言（A.7 表格「两套任务」「两套压缩」两行）：
 * 1. allbot 自带 tasks 必须关：开着就是两套任务源，跑腿工的步骤归不到账本。
 * 2. 压缩模式必须是 safeguard（未设也算过：defaults.ts:363-379 会补成 safeguard）。
 *    ds-bot 侧用的不是这个压缩器，这里只钉住 allbot 这一半。
 */
export function startupChecks(config: AllbotConfigSlice | undefined): StartupCheck[] {
  if (config === undefined || config === null || typeof config !== "object") {
    throw new StartupAssertionError("api.config 不存在，无法做 A.7 启动断言，拒绝加载 dot-core");
  }

  const tasksEnabled = config.tasks?.enabled === true;
  const mode = config.agents?.defaults?.compaction?.mode ?? config.compaction?.mode ?? "safeguard";

  return [
    {
      id: "tasks_disabled",
      ok: !tasksEnabled,
      detail: tasksEnabled
        ? "allbot tasks.enabled=true：会出现两套任务源（A.7），必须在 allbot.json 里关掉"
        : "allbot tasks.enabled 未开（默认关）",
    },
    {
      id: "compaction_safeguard",
      ok: mode === "safeguard",
      detail:
        mode === "safeguard"
          ? "compaction.mode=safeguard"
          : `compaction.mode=${mode}：工人会话必须用 safeguard（A.7），改回或者在 allbot.json 里删掉该键`,
    },
  ];
}

/** 跑断言；有不通过的一次性抛出，消息里带上全部失败项。 */
export function assertStartup(config: AllbotConfigSlice | undefined): StartupCheck[] {
  const checks = startupChecks(config);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new StartupAssertionError(
      `A.7 启动断言未通过：\n${failed.map((c) => `- ${c.id}：${c.detail}`).join("\n")}`,
      failed.map((c) => c.id),
    );
  }
  return checks;
}
