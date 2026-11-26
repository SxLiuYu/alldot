/**
 * src/memory/auto-extract.test.ts —— 自动提炼偏好的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./index.ts";
import { autoExtract, extractFromHistory } from "./auto-extract.ts";

function fixture(): { store: MemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "auto-extract-test-"));
  const store = new MemoryStore(join(dir, "memory.jsonl"));
  return {
    store,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test("auto-extract：提取「以后/总是」偏好", () => {
  const f = fixture();
  try {
    const count = autoExtract(f.store, {
      userMessages: ["以后都用中文回复我", "总是先检查文件是否存在"],
      taskIntent: "随便",
      success: true,
    });
    assert.ok(count >= 2);
    const entries = f.store.all();
    assert.ok(entries.some((e) => e.content.includes("中文")));
    assert.ok(entries.some((e) => e.content.includes("检查文件")));
  } finally {
    f.cleanup();
  }
});

test("auto-extract：提取「不要」偏好", () => {
  const f = fixture();
  try {
    autoExtract(f.store, {
      userMessages: ["不要用 Python 写脚本"],
      taskIntent: "写个脚本",
      success: true,
    });
    const entries = f.store.all();
    assert.ok(entries.some((e) => e.content.includes("Python") && e.kind === "user"));
  } finally {
    f.cleanup();
  }
});

test("auto-extract：成功任务记经验", () => {
  const f = fixture();
  try {
    autoExtract(f.store, {
      userMessages: [],
      taskIntent: "用 Node.js 处理 CSV 文件",
      resultSummary: "成功处理了 100 行数据",
      success: true,
      taskId: "t-1",
    });
    const entries = f.store.all();
    const taskEntry = entries.find((e) => e.kind === "task");
    assert.ok(taskEntry);
    assert.ok(taskEntry.content.includes("CSV"));
  } finally {
    f.cleanup();
  }
});

test("auto-extract：失败任务记教训", () => {
  const f = fixture();
  try {
    autoExtract(f.store, {
      userMessages: [],
      taskIntent: "部署到服务器",
      success: false,
      error: "SSH 连接超时",
      taskId: "t-2",
    });
    const entries = f.store.all();
    const taskEntry = entries.find((e) => e.kind === "task");
    assert.ok(taskEntry);
    assert.ok(taskEntry.content.includes("SSH"));
    assert.ok(taskEntry.content.includes("失败"));
  } finally {
    f.cleanup();
  }
});

test("auto-extract：正常消息不误提取偏好", () => {
  const f = fixture();
  try {
    const count = autoExtract(f.store, {
      userMessages: ["帮我查一下天气", "好的"],
      taskIntent: "查天气",
      success: true,
    });
    // 没有偏好模式命中，没有 resultSummary 也不记经验 → 0 条
    assert.equal(count, 0);
  } finally {
    f.cleanup();
  }
});

test("extractFromHistory：批量提取", () => {
  const f = fixture();
  try {
    const count = extractFromHistory(f.store, [
      { id: "a", intent: "整理文件", result: "整理了 50 个文件", success: true },
      { id: "b", intent: "备份数据库", error: "磁盘空间不足", success: false },
    ]);
    assert.equal(count, 2);
    assert.equal(f.store.count(), 2);
  } finally {
    f.cleanup();
  }
});

test("auto-extract：scope 包含关键词", () => {
  const f = fixture();
  try {
    autoExtract(f.store, {
      userMessages: [],
      taskIntent: "用 Python 处理 PDF 文件",
      resultSummary: "转换完成",
      success: true,
    });
    const entry = f.store.all().find((e) => e.kind === "task");
    assert.ok(entry);
    // scope 应该包含技术关键词
    assert.ok(entry.scope.length > 0);
  } finally {
    f.cleanup();
  }
});
