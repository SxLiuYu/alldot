/**
 * src/bridge/voice.test.ts —— 语音层的验收：状态判定、base URL 归一、上游调用形状。
 * 不连真 nanoMuse，用注入的假 fetch。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTranscriptionForm,
  createVoiceUpstream,
  DEFAULT_VOICE,
  voiceStatus,
  type VoiceConfig,
} from "./voice.ts";

const enabled = (): VoiceConfig => ({ ...DEFAULT_VOICE, enabled: true });

test("默认语音是关的，且 key 字段名固定", () => {
  assert.equal(DEFAULT_VOICE.enabled, false);
  assert.equal(DEFAULT_VOICE.api_key_env, "ALLDOT_VOICE_API_KEY");
  assert.equal(DEFAULT_VOICE.base_url, "https://www.sxliuyu.bond");
});

test("关着时即使有 key 也报 browser 兜底", () => {
  const st = voiceStatus(DEFAULT_VOICE, { ALLDOT_VOICE_API_KEY: "secret" });
  assert.equal(st.enabled, false);
  assert.equal(st.asr, "browser");
  assert.equal(st.tts, "browser");
  assert.match(st.reason ?? "", /未启用/);
});

test("开着但没 key：浏览器兜底，原因指明环境变量", () => {
  const st = voiceStatus(enabled(), {});
  assert.equal(st.enabled, true);
  assert.equal(st.key_present, false);
  assert.equal(st.asr, "browser");
  assert.match(st.reason ?? "", /ALLDOT_VOICE_API_KEY/);
});

test("开着且有 key：上游接管，无 reason", () => {
  const st = voiceStatus(enabled(), { ALLDOT_VOICE_API_KEY: "nm_test" });
  assert.equal(st.key_present, true);
  assert.equal(st.asr, "upstream");
  assert.equal(st.tts, "upstream");
  assert.equal(st.reason, null);
});

test("transcription form 带 file/model/response_format", () => {
  const form = buildTranscriptionForm(new Uint8Array([1, 2, 3]), "a.webm", "audio/webm");
  assert.equal(form.get("model"), "whisper-1");
  assert.equal(form.get("response_format"), "json");
  const file = form.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(file.type, "audio/webm");
});

test("ASR 调 /v1/audio/transcriptions，key 走 Authorization", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ text: "帮我查一下订单" }), { status: 200 });
  }) as typeof fetch;
  const up = createVoiceUpstream(enabled(), { ALLDOT_VOICE_API_KEY: "nm_test" }, fake);
  const text = await up.transcript(new Uint8Array([1, 2, 3]), "v.webm", "audio/webm");
  assert.equal(text, "帮我查一下订单");
  assert.match(calls[0]?.url ?? "", /\/v1\/audio\/transcriptions$/);
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], "Bearer nm_test");
});

test("TTS 调 /v1/audio/speech，返回 MP3 字节与引擎头", async () => {
  let seenBody = "";
  const fake = (async (_url: string, init: RequestInit) => {
    seenBody = String(init.body);
    return new Response(new Uint8Array([0xff, 0xf3, 0x90, 0x64]), {
      status: 200,
      headers: { "x-voice-engine": "baidu", "content-type": "audio/mpeg" },
    });
  }) as typeof fetch;
  const up = createVoiceUpstream(enabled(), { ALLDOT_VOICE_API_KEY: "nm_test" }, fake);
  const r = await up.speak("你好");
  assert.deepEqual(Array.from(r.bytes), [0xff, 0xf3, 0x90, 0x64]);
  assert.equal(r.engine, "baidu");
  assert.match(seenBody, /"input":"你好"/);
  assert.match(seenBody, /"model":"tts-1"/);
});

test("base 带 /v1 不会拼成 /v1/v1", async () => {
  let seen = "";
  const fake = (async (url: string) => {
    seen = String(url);
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  }) as typeof fetch;
  const up = createVoiceUpstream(
    { ...enabled(), base_url: "https://www.sxliuyu.bond/v1" },
    { ALLDOT_VOICE_API_KEY: "nm_test" },
    fake,
  );
  await up.transcript(new Uint8Array([1]), "v.webm", "audio/webm");
  assert.equal(seen, "https://www.sxliuyu.bond/v1/audio/transcriptions");
});

test("上游非 2xx 抛错，交给调用方回 502", async () => {
  const fake = (async () => new Response("oops", { status: 500 })) as typeof fetch;
  const up = createVoiceUpstream(enabled(), { ALLDOT_VOICE_API_KEY: "nm_test" }, fake);
  await assert.rejects(() => up.transcript(new Uint8Array([1]), "v.webm", "audio/webm"), /HTTP 500/);
});
