/**
 * src/config-schema.ts —— dot 配置的 JSON Schema（给 allbot 的插件清单用）。
 *
 * 为什么要单独一份：`allbot.plugin.json` 的 configSchema 是**清单**，allbot 读它做
 * 装载期校验；`src/config.ts` 的解析器是**运行时**校验（连范围、键名都查）。
 * 两者必须描述同一份字段，所以字段名/缺省值只在这里写一次，manifest 与文档照抄，
 * 有测试比对（src/config.test.ts）。
 */

import { defaultConfig } from "./config.ts";

const D = defaultConfig();

export const DOT_CORE_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    vision: {
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean", default: D.vision.enabled } },
    },
    approvals: {
      type: "object",
      additionalProperties: false,
      properties: {
        inline_wait_ms: { type: "number", default: D.approvals.inline_wait_ms },
        ttl_hours: { type: "number", default: D.approvals.ttl_hours },
        auto_approve_max_tier: { type: "number", default: D.approvals.auto_approve_max_tier },
      },
    },
    desktop: {
      type: "object",
      additionalProperties: false,
      properties: {
        batch_actions: { type: "number", default: D.desktop.batch_actions },
        exclude_processes: { type: "array", items: { type: "string" }, default: D.desktop.exclude_processes },
        human_only_apps: { type: "array", items: { type: "string" }, default: D.desktop.human_only_apps },
        mcp_url: {
          type: "string",
          default: D.desktop.mcp_url,
          description: "Windows-MCP 的 streamable-HTTP 地址",
        },
      },
    },
    wechat: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: D.wechat.enabled,
          description: "微信那只手（wechat-mcp 的 HTTP 入口）默认开；服务没起时调了就是干不了",
        },
        mcp_url: {
          type: "string",
          default: D.wechat.mcp_url,
          description: "wechat-mcp 的 streamable-HTTP 地址（默认 http://127.0.0.1:8933/mcp）",
        },
      },
    },
    browser: {
      type: "object",
      additionalProperties: false,
      properties: {
        captcha: {
          type: "object",
          additionalProperties: false,
          properties: {
            keywords: {
              type: "array",
              items: { type: "string" },
              default: D.browser.captcha.keywords,
              description: "snapshot/截图里命中就停手交还人手的验证码关键词",
            },
          },
        },
        logged_mcp_url: { type: "string", default: D.browser.logged_mcp_url },
        clean_mcp_url: { type: "string", default: D.browser.clean_mcp_url },
        clean_profile: {
          type: ["string", "null"],
          default: D.browser.clean_profile,
          description: "干净浏览器 profile；null=--isolated，不留任何状态",
        },
      },
    },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: { tokens: { type: "number", default: D.budget.tokens } },
    },
    keepalive: {
      type: "object",
      additionalProperties: false,
      properties: {
        probe_interval_min: { type: "number", default: D.keepalive.probe_interval_min },
        probe_tiers: { type: "array", items: { type: "string" }, default: D.keepalive.probe_tiers },
        disk: {
          type: "object",
          additionalProperties: false,
          properties: {
            warn_gb: { type: "number", default: D.keepalive.disk.warn_gb },
            red_gb: { type: "number", default: D.keepalive.disk.red_gb },
            pause_gb: { type: "number", default: D.keepalive.disk.pause_gb },
            resume_gb: { type: "number", default: D.keepalive.disk.resume_gb },
            hysteresis_min: { type: "number", default: D.keepalive.disk.hysteresis_min },
          },
        },
        artifacts_max_gb: { type: "number", default: D.keepalive.artifacts_max_gb },
        snapshots_max_gb: { type: "number", default: D.keepalive.snapshots_max_gb },
        backups_max_gb: { type: "number", default: D.keepalive.backups_max_gb },
        guard_log_max_mb: { type: "number", default: D.keepalive.guard_log_max_mb },
      },
    },
    exec: {
      type: "object",
      additionalProperties: false,
      properties: { whitelist: { type: "array", items: { type: "string" }, default: D.exec.whitelist } },
    },
    dispatch: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: D.dispatch.enabled },
        interval_ms: { type: "number", default: D.dispatch.interval_ms },
        session_timeout_ms: { type: "number", default: D.dispatch.session_timeout_ms },
        max_concurrent: { type: "number", default: D.dispatch.max_concurrent },
        lock_ttl_ms: { type: "number", default: D.dispatch.lock_ttl_ms },
      },
    },
    practice: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: {
          type: ["string", "null"],
          default: D.practice.root,
          description: "练习文件夹绝对路径；null=没配，最小那只手拒绝执行",
        },
      },
    },
    say: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: D.say.enabled,
          description: "说人话改写层开关；默认关，关着时桥的卡片逐字不动",
        },
      },
    },
    notify: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: D.notify.enabled,
          description: "把「要你批」和「任务结果」推到手机开关；默认关，配好 webhook 再开",
        },
        feishu_webhook: {
          type: "string",
          default: D.notify.feishu_webhook,
          description: "飞书自定义机器人 webhook 地址；不填则走微信通道",
        },
        wechat_python: {
          type: "string",
          default: D.notify.wechat_python,
          description: "微信 helper 用的 python.exe；填了才启用微信通道",
        },
        wechat_script: {
          type: "string",
          default: D.notify.wechat_script,
          description: "微信 helper 脚本路径（build/tools/wechat-notify.py）",
        },
        wechat_marker: {
          type: "string",
          default: D.notify.wechat_marker,
          description: "发送前用来确认当前会话对不对的标记文字（默认 alldot）",
        },
        poll_sec: {
          type: "number",
          default: D.notify.poll_sec,
          description: "轮询账本的间隔秒数；只推审批与任务结果，不推进度",
        },
      },
    },
    self_improve: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: D.self_improve.enabled,
          description: "自我优化开关；默认开（2026-11-25 按用户要求改为默认开），关着时只允许体检，不许出提案、不许写补丁。开着也只写账本提案与请示卡，绝不改源码",
        },
        max_proposals_per_day: {
          type: "number",
          default: D.self_improve.max_proposals_per_day,
          description: "每天最多落几条提案（按 UTC 日期算）",
        },
      },
    },
    mobile_access: {
      type: "object",
      additionalProperties: false,
      description: "手机接入方式；默认 loopback（只本机，手机连不上）",
      properties: {
        mode: {
          type: "string",
          enum: ["loopback", "lan", "tunnel", "relay"],
          default: D.mobile_access.mode,
          description: "loopback=只本机；lan=局域网直连；tunnel=内网穿透；relay=自定义中继",
        },
        allowed_cidrs: {
          type: "array",
          items: { type: "string" },
          default: D.mobile_access.allowed_cidrs,
          description: "额外放行的来源 IP/CIDR（留空=按接入模式默认规则）",
        },
      },
    },
    voice: {
      type: "object",
      additionalProperties: false,
      description: "语音 ASR/TTS 上游；复用 nanoMuse 的 /v1/audio/* 接口，密钥走环境变量，不写进配置",
      properties: {
        enabled: { type: "boolean", default: D.voice.enabled, description: "语音开关；默认关" },
        base_url: {
          type: "string",
          default: D.voice.base_url,
          description: "上游 base URL，不带 /v1",
        },
        api_key_env: {
          type: "string",
          default: D.voice.api_key_env,
          description: "上游 API key 的环境变量名（默认 ALLDOT_VOICE_API_KEY）",
        },
        voice: { type: "string", default: D.voice.voice, description: "TTS 音色" },
        max_asr_seconds: { type: "number", default: D.voice.max_asr_seconds },
        max_tts_chars: { type: "number", default: D.voice.max_tts_chars },
      },
    },
  },
} as const;
