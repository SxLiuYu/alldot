/**
 * src/longtask/longtask.test.ts —— 长程任务管理的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LongTaskManager } from "./index.ts";

function fixture(config?: Parameters<typeof LongTaskManager>[1]): { mgr: LongTaskManager; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "longtask-test-"));
  const mgr = new LongTaskManager(dir, config);
  return {
    mgr,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test("longtask：创建和获取检查点", () => {
  const f = fixture();
  try {
    const cp = f.mgr.checkpoint("task-1", { stage: "第一步", completedSteps: [0] });
    assert.equal(cp.taskId, "task-1");
    assert.equal(cp.stage, "第一步");
    assert.deepEqual(cp.completedSteps, [0]);

    const loaded = f.mgr.get("task-1");
    assert.ok(loaded);
    assert.equal(loaded.stage, "第一步");
  } finally {
    f.cleanup();
  }
});

test("longtask：更新检查点（合并已有数据）", () => {
  const f = fixture();
  try {
    f.mgr.checkpoint("task-2", { stage: "开始", completedSteps: [0], spentTokens: 100 });
    const cp = f.mgr.checkpoint("task-2", { stage: "进行中", completedSteps: [0, 1] });

    assert.equal(cp.stage, "进行中");
    assert.deepEqual(cp.completedSteps, [0, 1]);
    assert.equal(cp.spentTokens, 100); // 保留
  } finally {
    f.cleanup();
  }
});

test("longtask：超时判断", () => {
  const f = fixture({ defaultTimeoutMs: 1 }); // 1ms 超时
  try {
    f.mgr.checkpoint("task-3", { stage: "运行" });
    // 等一会儿就超时了
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(f.mgr.isTimedOut("task-3"), true);
        assert.equal(f.mgr.checkTimeout("task-3"), true);
        const cp = f.mgr.get("task-3");
        assert.equal(cp?.status, "timeout");
        resolve();
      }, 10);
    });
  } finally {
    f.cleanup();
  }
});

test("longtask：未超时", () => {
  const f = fixture({ defaultTimeoutMs: 60000 });
  try {
    f.mgr.checkpoint("task-4", { stage: "运行" });
    assert.equal(f.mgr.isTimedOut("task-4"), false);
  } finally {
    f.cleanup();
  }
});

test("longtask：断点续跑", () => {
  const f = fixture({ maxResumes: 3 });
  try {
    f.mgr.checkpoint("task-5", { status: "timeout", stage: "做到一半", completedSteps: [0, 1, 2] });

    assert.equal(f.mgr.canResume("task-5"), true);
    const resumed = f.mgr.resume("task-5");
    assert.ok(resumed);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.resumeCount, 1);
  } finally {
    f.cleanup();
  }
});

test("longtask：超过最大恢复次数不能再恢复", () => {
  const f = fixture({ maxResumes: 1 });
  try {
    f.mgr.checkpoint("task-6", { status: "timeout", resumeCount: 1 });
    assert.equal(f.mgr.canResume("task-6"), false);
    assert.equal(f.mgr.resume("task-6"), null);
  } finally {
    f.cleanup();
  }
});

test("longtask：恢复提示词", () => {
  const f = fixture();
  try {
    f.mgr.checkpoint("task-7", {
      stage: "处理数据",
      completedSteps: [0, 1],
      artifacts: { "0": "读取了文件", "1": "分析完成" },
      lastError: "连接超时",
    });

    const prompt = f.mgr.buildResumePrompt("task-7");
    assert.ok(prompt);
    assert.ok(prompt.includes("处理数据"));
    assert.ok(prompt.includes("0, 1"));
    assert.ok(prompt.includes("连接超时"));
    assert.ok(prompt.includes("不要重复"));
  } finally {
    f.cleanup();
  }
});

test("longtask：complete 删除检查点", () => {
  const f = fixture();
  try {
    f.mgr.checkpoint("task-8", { stage: "运行" });
    assert.equal(f.mgr.complete("task-8"), true);
    assert.equal(f.mgr.get("task-8"), undefined);
    assert.equal(f.mgr.complete("task-8"), false);
  } finally {
    f.cleanup();
  }
});

test("longtask：listResumable 只列超时和暂停", () => {
  const f = fixture();
  try {
    f.mgr.checkpoint("a", { status: "timeout" });
    f.mgr.checkpoint("b", { status: "paused" });
    f.mgr.checkpoint("c", { status: "running" });
    f.mgr.checkpoint("d", { status: "done" });

    const resumable = f.mgr.listResumable();
    assert.equal(resumable.length, 2);
    assert.ok(resumable.some((c) => c.taskId === "a"));
    assert.ok(resumable.some((c) => c.taskId === "b"));
  } finally {
    f.cleanup();
  }
});

test("longtask：持久化——新实例能读到", () => {
  const f = fixture();
  try {
    f.mgr.checkpoint("persist-1", { stage: "持久化测试", completedSteps: [0] });

    const dir = (f.mgr as any).baseDir as string;
    const m2 = new LongTaskManager(dir);
    const cp = m2.get("persist-1");
    assert.ok(cp);
    assert.equal(cp.stage, "持久化测试");
  } finally {
    f.cleanup();
  }
});
