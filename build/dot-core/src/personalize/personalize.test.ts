/**
 * src/personalize/personalize.test.ts —— Agent 个性化的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalizeStore, buildPersonalizePrompt, DEFAULT_PROFILE } from "./index.ts";

function fixture(): { store: PersonalizeStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "personalize-test-"));
  const store = new PersonalizeStore(join(dir, "profile.json"));
  return {
    store,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test("personalize：默认 profile", () => {
  const f = fixture();
  try {
    const p = f.store.get();
    assert.equal(p.name, "Dot");
    assert.equal(p.style, "friendly");
    assert.equal(p.language, "zh-CN");
  } finally {
    f.cleanup();
  }
});

test("personalize：更新 name 和 avatar", () => {
  const f = fixture();
  try {
    const p = f.store.update({ name: "小助手", avatar: "🦊" });
    assert.equal(p.name, "小助手");
    assert.equal(p.avatar, "🦊");
  } finally {
    f.cleanup();
  }
});

test("personalize：更新风格", () => {
  const f = fixture();
  try {
    f.store.update({ style: "technical" });
    assert.equal(f.store.get().style, "technical");
  } finally {
    f.cleanup();
  }
});

test("personalize：持久化", () => {
  const f = fixture();
  try {
    f.store.update({ name: "持久化名字" });
    const path = (f.store as any).path as string;
    const s2 = new PersonalizeStore(path);
    assert.equal(s2.get().name, "持久化名字");
  } finally {
    f.cleanup();
  }
});

test("personalize：reset 恢复默认", () => {
  const f = fixture();
  try {
    f.store.update({ name: "改了", style: "humorous" });
    const p = f.store.reset();
    assert.equal(p.name, DEFAULT_PROFILE.name);
    assert.equal(p.style, DEFAULT_PROFILE.style);
  } finally {
    f.cleanup();
  }
});

test("personalize：buildPersonalizePrompt 包含名字", () => {
  const f = fixture();
  try {
    const p = f.store.update({ name: "小明" });
    const prompt = buildPersonalizePrompt(p);
    assert.ok(prompt.includes("小明"));
    assert.ok(prompt.includes("🤖"));
    assert.ok(prompt.includes("中文"));
  } finally {
    f.cleanup();
  }
});

test("personalize：自定义指令注入 prompt", () => {
  const f = fixture();
  try {
    const p = f.store.update({ customInstructions: "不要用表情符号" });
    const prompt = buildPersonalizePrompt(p);
    assert.ok(prompt.includes("不要用表情符号"));
  } finally {
    f.cleanup();
  }
});

test("personalize：语气强度影响 prompt", () => {
  const f = fixture();
  try {
    const gentle = buildPersonalizePrompt(f.store.update({ toneIntensity: 1 }));
    assert.ok(gentle.includes("温和"));

    const direct = buildPersonalizePrompt(f.store.update({ toneIntensity: 5 }));
    assert.ok(direct.includes("直接"));
  } finally {
    f.cleanup();
  }
});
