/**
 * src/bridge/mobile-routes.test.ts —— 手机端新路由的端到端验收（真起服务打请求）。
 * 覆盖：/api/token 修掉前端一直调却不存在的问题、语音路由、手机接入来源判定。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBridgeService } from "./index.ts";
import { DEFAULT_VOICE, type VoiceUpstream } from "./voice.ts";
import { hostForAccess, type AccessConfig } from "./access.ts";
import { migrate, openLedger } from "../ledger/index.ts";

function setup(opts: {
  access?: AccessConfig;
  voiceUpstream?: VoiceUpstream;
  voiceEnabled?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dot-mobile-test-"));
  const dotDir = join(dir, "dot");
  mkdirSync(join(dotDir, "ledger"), { recursive: true });
  mkdirSync(dotDir, { recursive: true });
  writeFileSync(join(dotDir, "bridge-token"), "mobile-test-token\n", "utf8");
  const db = openLedger(join(dotDir, "ledger", "dot.db"));
  migrate(db);
  db.close();
  const mode = opts.access?.mode ?? "loopback";
  const service = createBridgeService({
    port: 0,
    host: hostForAccess(mode),
    access: opts.access ?? { mode, host: hostForAccess(mode), allowed_cidrs: [] },
    voice: { ...DEFAULT_VOICE, enabled: opts.voiceEnabled ?? false },
    ...(opts.voiceUpstream === undefined ? {} : { voiceUpstream: opts.voiceUpstream }),
    pathOptions: {
      dotDir,
      tokenPath: join(dotDir, "bridge-token"),
      ledgerPath: join(dotDir, "ledger", "dot.db"),
      keepPath: join(dotDir, "state", "keep.json"),
      configPath: join(dotDir, "allbot.json"),
    },
    notifier: { send: async () => ({ ok: true, detail: "test" }) },
    logger: () => {},
  });
  return { service, dir, f: (p: string) => join(dotDir, p) };
}

test("GET /api/token 返回 token（前端不再手填）", async () => {
  const { service, dir } = setup();
  const { url } = await service.start();
  try {
    const res = await fetch(`${url}/api/token`, {
      headers: { "x-dot-bridge-token": "mobile-test-token" },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { token: string; access: string; voice: boolean };
    assert.equal(data.token, "mobile-test-token");
    assert.equal(data.access, "loopback");
    assert.equal(data.voice, false);
    // 没 token 仍 401，鉴权没被绕过
    const noAuth = await fetch(`${url}/api/token`);
    assert.equal(noAuth.status, 401);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/voice/status 报上游不可用（没 key），前端可兜底", async () => {
  const { service, dir } = setup({ voiceEnabled: true });
  const { url } = await service.start();
  try {
    const res = await fetch(`${url}/api/voice/status`, {
      headers: { "x-dot-bridge-token": "mobile-test-token" },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { key_present: boolean; asr: string; reason: string | null };
    assert.equal(data.key_present, false);
    assert.equal(data.asr, "browser");
    assert.match(data.reason ?? "", /ALLDOT_VOICE_API_KEY/);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/voice/transcript 上游可用时回文字，空音频回 400", async () => {
  const upstream: VoiceUpstream = {
    transcript: async () => "把这段音频转成任务",
    speak: async () => ({ bytes: new Uint8Array([0xff, 0xf3]), engine: "baidu" }),
  };
  const { service, dir } = setup({ voiceEnabled: true, voiceUpstream: upstream });
  const { url } = await service.start();
  try {
    const ok = await fetch(`${url}/api/voice/transcript`, {
      method: "POST",
      headers: {
        "x-dot-bridge-token": "mobile-test-token",
        "content-type": "audio/webm",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { text: string }).text, "把这段音频转成任务");

    const empty = await fetch(`${url}/api/voice/transcript`, {
      method: "POST",
      headers: { "x-dot-bridge-token": "mobile-test-token", "content-type": "audio/webm" },
      body: new Uint8Array([]),
    });
    assert.equal(empty.status, 400);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/voice/speech 回 MP3 与引擎头，超长文本回 413", async () => {
  const upstream: VoiceUpstream = {
    transcript: async () => "",
    speak: async () => ({ bytes: new Uint8Array([0xff, 0xf3, 0x90]), engine: "baidu" }),
  };
  const { service, dir } = setup({ voiceEnabled: true, voiceUpstream: upstream });
  const { url } = await service.start();
  try {
    const ok = await fetch(`${url}/api/voice/speech`, {
      method: "POST",
      headers: { "x-dot-bridge-token": "mobile-test-token", "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /audio\/mpeg/);
    assert.equal(ok.headers.get("x-voice-engine"), "baidu");
    assert.equal((new Uint8Array(await ok.arrayBuffer())).byteLength, 3);

    const long = await fetch(`${url}/api/voice/speech`, {
      method: "POST",
      headers: { "x-dot-bridge-token": "mobile-test-token", "content-type": "application/json" },
      body: JSON.stringify({ text: "字".repeat(451) }),
    });
    assert.equal(long.status, 413);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PWA 资源：manifest / sw / 图标可取，且要鉴权", async () => {
  const { service, dir } = setup();
  const { url } = await service.start();
  try {
    const auth = { "x-dot-bridge-token": "mobile-test-token" };
    const manifest = await fetch(`${url}/manifest.webmanifest`, { headers: auth });
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type") ?? "", /manifest/);
    const m = (await manifest.json()) as { name: string; display: string; start_url: string };
    assert.equal(m.display, "standalone");
    assert.equal(m.start_url, "./chat");

    const sw = await fetch(`${url}/sw.js`, { headers: auth });
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get("content-type") ?? "", /javascript/);
    assert.match(await sw.text(), /alldot-shell/);

    for (const icon of ["/icon-192.png", "/icon-512.png"]) {
      const r = await fetch(`${url}${icon}`, { headers: auth });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /image\/png/);
      assert.ok((new Uint8Array(await r.arrayBuffer())).byteLength > 100);
    }

    // 鉴权没被绕过：不带 token 全部 401
    for (const p of ["/manifest.webmanifest", "/sw.js", "/icon-192.png"]) {
      assert.equal((await fetch(`${url}${p}`)).status, 401);
    }
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /health 报接入与语音状态", async () => {
  const access: AccessConfig = { mode: "lan", host: "0.0.0.0", allowed_cidrs: [] };
  const { service, dir } = setup({ access });
  const { url } = await service.start();
  try {
    const res = await fetch(`${url}/health`);
    const data = (await res.json()) as { access: { mode: string }; voice: { enabled: boolean } };
    assert.equal(data.access.mode, "lan");
    assert.equal(data.voice.enabled, false);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /chat：带 token 200，不带 token 401", async () => {
  const { service, dir } = setup();
  const { url } = await service.start();
  try {
    const ok = await fetch(`${url}/chat`, { headers: { "x-dot-bridge-token": "mobile-test-token" } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
    const html = await ok.text();
    assert.ok(html.includes("dot:chat-state (begin)"), "页面要有可测的标记块");
    assert.ok(html.includes("dot:chat-state (end)"));
    assert.ok(html.includes("brain_reply"), "页面默认走只回答通道");

    const noAuth = await fetch(`${url}/chat`);
    assert.equal(noAuth.status, 401);
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
