/**
 * src/bridge/voice.ts —— alldot 的语音层（ASR / TTS）。
 *
 * 上游复用 nanoMuse 已实测的免费语音接口（百度主引擎 + Edge/Whisper 兜底）：
 *   POST /v1/audio/transcriptions  multipart，文件字段 file，返回 {text: "..."}
 *   POST /v1/audio/speech          JSON {model, input, voice}，返回 MP3 字节
 *
 * 这一层只做转发和兜底，不在本机跑模型：
 * - 上游 base URL 从配置读（默认 https://www.sxliuyu.bond），密钥从环境变量
 *   ALLDOT_VOICE_API_KEY 读。都不硬编码进仓库。
 * - 没配 key 或上游不可用时，TTS 回落到浏览器 Web Speech，ASR 回落到浏览器
 *   Web Speech Recognition（由 chat.html 负责），桥只回 503 + reason，
 *   让前端自己切，不假装成功。
 * - 桥的所有写操作仍要桥 token，语音路由不绕过鉴权。
 */

export interface VoiceConfig {
  /** 是否启用语音。关着时路由回 503，前端自动走浏览器兜底。 */
  enabled: boolean;
  /** 上游 base URL，不带 /v1（会和接口路径拼）。 */
  base_url: string;
  /** 上游 API key 的环境变量名（不存密钥本身）。 */
  api_key_env: string;
  /** TTS 音色：百度基础音色 alloy=度小美/echo=度小宇/nova=度逍遥 等，由上游映射。 */
  voice: string;
  /** 单次 ASR 最长秒数（百度 58 秒留余量）。 */
  max_asr_seconds: number;
  /** 单次 TTS 最长字符数（百度 450）。 */
  max_tts_chars: number;
}

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: false,
  base_url: "https://www.sxliuyu.bond",
  api_key_env: "ALLDOT_VOICE_API_KEY",
  voice: "alloy",
  max_asr_seconds: 58,
  max_tts_chars: 450,
};

export interface VoiceStatus {
  enabled: boolean;
  base_url: string;
  key_present: boolean;
  key_env: string;
  tts: string;
  asr: string;
  reason: string | null;
}

export function voiceStatus(config: VoiceConfig, env: NodeJS.ProcessEnv = process.env): VoiceStatus {
  const key = config.api_key_env.trim();
  const present = key !== "" && typeof env[key] === "string" && (env[key] ?? "").trim() !== "";
  if (!config.enabled) {
    return {
      enabled: false,
      base_url: config.base_url,
      key_present: present,
      key_env: config.api_key_env,
      tts: "browser",
      asr: "browser",
      reason: "语音未启用（config.voice.enabled=false）",
    };
  }
  if (!present) {
    return {
      enabled: true,
      base_url: config.base_url,
      key_present: false,
      key_env: config.api_key_env,
      tts: "browser",
      asr: "browser",
      reason: `环境变量 ${config.api_key_env} 没配`,
    };
  }
  return {
    enabled: true,
    base_url: config.base_url,
    key_present: true,
    key_env: config.api_key_env,
    tts: "upstream",
    asr: "upstream",
    reason: null,
  };
}

function baseUrl(config: VoiceConfig): string {
  let b = config.base_url.trim().replace(/\/+$/, "");
  // 上游接口路径自带 /v1/audio/*；base 带 /v1 会拼成 /v1/v1/audio/*。
  if (b.endsWith("/v1")) b = b.slice(0, -3);
  return b;
}

/** 把浏览器录的音频 Blob 转成上游要的 multipart。 */
export function buildTranscriptionForm(
  audio: Uint8Array,
  filename: string,
  contentType: string,
): FormData {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(audio)], { type: contentType || "audio/webm" }), filename || "voice.webm");
  form.append("model", "whisper-1");
  form.append("response_format", "json");
  return form;
}

export interface VoiceUpstream {
  transcript(audio: Uint8Array, filename: string, contentType: string): Promise<string>;
  speak(text: string, voice?: string): Promise<{ bytes: Uint8Array; engine: string | null }>;
}

/** 真上游。构造时不发请求，调用时才 fetch。 */
export function createVoiceUpstream(
  config: VoiceConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): VoiceUpstream {
  const key = (env[config.api_key_env] ?? "").trim();
  const root = baseUrl(config);

  async function transcribe(audio: Uint8Array, filename: string, contentType: string): Promise<string> {
    const res = await fetchImpl(`${root}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: buildTranscriptionForm(audio, filename, contentType),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`ASR 上游 HTTP ${res.status}`);
    const data = (await res.json()) as { text?: string };
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (text === "") throw new Error("ASR 上游返回空文本");
    return text;
  }

  async function speak(text: string, voice?: string): Promise<{ bytes: Uint8Array; engine: string | null }> {
    const res = await fetchImpl(`${root}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: "tts-1", input: text, voice: voice ?? config.voice }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`TTS 上游 HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error("TTS 上游返回空音频");
    return { bytes: buf, engine: res.headers.get("x-voice-engine") };
  }

  return { transcript: transcribe, speak };
}
