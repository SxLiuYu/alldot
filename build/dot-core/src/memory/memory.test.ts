/**
 * src/memory/memory.test.ts —— 跨会话记忆的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, buildMemoryContext } from "./index.ts";

function fixture(): { store: MemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mem-test-"));
  const store = new MemoryStore(join(dir, "memory.jsonl"));
  return {
    store,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test("memory：添加和检索记忆", () => {
  const f = fixture();
  try {
    f.store.add("user", "用户喜欢中文回复", { scope: ["回复", "语言"] });
    f.store.add("task", "之前归档过 PDF 文件", { scope: ["pdf", "归档"] });

    assert.equal(f.store.count(), 2);

    const results = f.store.search("帮我归档 PDF 文件");
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.entry.content.includes("PDF")));
  } finally {
    f.cleanup();
  }
});

test("memory：用户偏好加权更高", () => {
  const f = fixture();
  try {
    f.store.add("user", "喜欢用暗色主题", { scope: ["主题"] });
    f.store.add("task", "主题相关任务经验", { scope: ["主题"] });

    const results = f.store.search("换个主题");
    assert.ok(results.length >= 2);
    // user 类记忆排前面（加权 1.3）
    assert.equal(results[0].entry.kind, "user");
  } finally {
    f.cleanup();
  }
});

test("memory：持久化和重新加载", () => {
  const f = fixture();
  try {
    f.store.add("user", "记住这一点", { confidence: 0.9 });
    const path = join(f.store["path"] as string);

    // 新建 store 读同一个文件
    const store2 = new MemoryStore(path);
    assert.equal(store2.count(), 1);
    assert.equal(store2.all()[0].content, "记住这一点");
  } finally {
    f.cleanup();
  }
});

test("memory：buildMemoryContext 生成提示词上下文", () => {
  const f = fixture();
  try {
    f.store.add("user", "用户是开发者，喜欢简洁回复", { scope: ["开发者"] });
    f.store.add("task", "之前用 Node.js 处理过文件", { scope: ["node", "文件"] });

    const ctx = buildMemoryContext(f.store, "帮我处理 Node.js 文件");
    assert.ok(ctx.includes("用户偏好"));
    assert.ok(ctx.includes("相关经验"));
  } finally {
    f.cleanup();
  }
});

test("memory：空查询返回空", () => {
  const f = fixture();
  try {
    f.store.add("user", "test", {});
    const results = f.store.search("");
    // 空查询不该命中 scope 或关键词
    assert.equal(results.length, 0);
  } finally {
    f.cleanup();
  }
});

test("memory：confidence 影响排序", () => {
  const f = fixture();
  try {
    f.store.add("task", "匹配关键词的低置信度记忆", { scope: ["关键词"], confidence: 0.2 });
    f.store.add("task", "匹配关键词的高置信度记忆", { scope: ["关键词"], confidence: 0.9 });

    const results = f.store.search("关键词测试");
    assert.equal(results[0].entry.confidence, 0.9);
  } finally {
    f.cleanup();
  }
});
