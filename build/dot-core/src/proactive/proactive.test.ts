/**
 * src/proactive/proactive.test.ts —— 主动监控的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProactiveMonitor } from "./index.ts";

function fixture(): { monitor: ProactiveMonitor; fired: string[]; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "proactive-test-"));
  const fired: string[] = [];
  const monitor = new ProactiveMonitor(
    async (trigger) => { fired.push(trigger.name); },
    join(dir, "triggers.json"),
  );
  return {
    monitor,
    fired,
    dir,
    cleanup: () => {
      monitor.stop();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

test("proactive：添加和列出触发器", () => {
  const f = fixture();
  try {
    const t = f.monitor.add({
      name: "文件监控",
      type: "file_change",
      enabled: true,
      condition: { path: "/tmp/test.txt" },
      taskTemplate: "检查文件变化",
      cooldownSec: 60,
    });
    assert.ok(t.id.startsWith("trg_"));

    const list = f.monitor.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "文件监控");
  } finally {
    f.cleanup();
  }
});

test("proactive：toggle 启停", () => {
  const f = fixture();
  try {
    const t = f.monitor.add({
      name: "test", type: "schedule", enabled: true,
      condition: { everyMinutes: 5 }, taskTemplate: "task", cooldownSec: 60,
    });

    f.monitor.toggle(t.id);
    assert.equal(f.monitor.list()[0].enabled, false);

    f.monitor.toggle(t.id);
    assert.equal(f.monitor.list()[0].enabled, true);
  } finally {
    f.cleanup();
  }
});

test("proactive：remove 删除", () => {
  const f = fixture();
  try {
    const t = f.monitor.add({
      name: "test", type: "schedule", enabled: true,
      condition: { everyMinutes: 5 }, taskTemplate: "task", cooldownSec: 60,
    });

    assert.equal(f.monitor.remove(t.id), true);
    assert.equal(f.monitor.list().length, 0);
  } finally {
    f.cleanup();
  }
});

test("proactive：文件变化触发", async () => {
  const f = fixture();
  try {
    const testFile = join(f.dir, "watch.txt");
    writeFileSync(testFile, "initial");
    // mtime 固定到 1 分钟前：否则「写文件」和「第一次 tick」常落在同一毫秒，
    // 第二次 tick 的 mtime > lastFired 就可能成立，全量跑时偶发红（2026-11-27 见两次）。
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    utimesSync(testFile, oneMinuteAgo, oneMinuteAgo);

    f.monitor.add({
      name: "watch-file",
      type: "file_change",
      enabled: true,
      condition: { path: testFile },
      taskTemplate: "文件变了",
      cooldownSec: 0, // 无冷却
    });

    // 首次 tick 应该触发（没有 lastFired）
    await f.monitor.tick();
    assert.equal(f.fired.length, 1);

    // 文件没变，不该再触发（有 lastFired 且 mtime 没更新）
    await f.monitor.tick();
    assert.equal(f.fired.length, 1);

    // 更新文件 mtime，应该触发。
    // 必须比 lastFired 明确更晚：实现是 mtimeMs > lastFired，而 new Date() 与
    // 上一次 tick 常落在同一毫秒，mtimeMs 相等就不触发（全量跑时偶发红）。
    const later = new Date(Date.now() + 2000);
    utimesSync(testFile, later, later);
    await f.monitor.tick();
    assert.equal(f.fired.length, 2);
  } finally {
    f.cleanup();
  }
});

test("proactive：冷却期不重复触发", async () => {
  const f = fixture();
  try {
    const testFile = join(f.dir, "cd.txt");
    writeFileSync(testFile, "x");

    f.monitor.add({
      name: "cooldown-test",
      type: "file_change",
      enabled: true,
      condition: { path: testFile },
      taskTemplate: "task",
      cooldownSec: 3600, // 1 小时冷却
    });

    await f.monitor.tick();
    assert.equal(f.fired.length, 1);

    // 文件变了但还在冷却期
    utimesSync(testFile, new Date(), new Date());
    await f.monitor.tick();
    assert.equal(f.fired.length, 1); // 没有第二次
  } finally {
    f.cleanup();
  }
});

test("proactive：schedule 类型按时间触发", async () => {
  const f = fixture();
  try {
    f.monitor.add({
      name: "every-min",
      type: "schedule",
      enabled: true,
      condition: { everyMinutes: 1 },
      taskTemplate: "定时任务",
      cooldownSec: 0,
    });

    await f.monitor.tick();
    assert.equal(f.fired.length, 1); // 首次

    // 还没到 1 分钟，不触发
    await f.monitor.tick();
    assert.equal(f.fired.length, 1);
  } finally {
    f.cleanup();
  }
});

test("proactive：disabled 不触发", async () => {
  const f = fixture();
  try {
    const testFile = join(f.dir, "dis.txt");
    writeFileSync(testFile, "x");

    f.monitor.add({
      name: "disabled-test",
      type: "file_change",
      enabled: false,
      condition: { path: testFile },
      taskTemplate: "task",
      cooldownSec: 0,
    });

    await f.monitor.tick();
    assert.equal(f.fired.length, 0);
  } finally {
    f.cleanup();
  }
});

test("proactive：持久化触发器", () => {
  const f = fixture();
  try {
    f.monitor.add({
      name: "persist", type: "schedule", enabled: true,
      condition: { everyMinutes: 5 }, taskTemplate: "task", cooldownSec: 60,
    });

    // 新 monitor 读同一个文件
    const m2 = new ProactiveMonitor(async () => {}, join(f.dir, "triggers.json"));
    assert.equal(m2.list().length, 1);
    assert.equal(m2.list()[0].name, "persist");
  } finally {
    f.cleanup();
  }
});
