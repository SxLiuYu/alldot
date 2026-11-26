/**
 * build/tools/tools-safety.test.ts —— 运维工具的参数防护测试。
 *
 * 钉住两件事：
 * 1. dot-errors.mjs：--hours 缺值/非数/0/负数安全回退到 2
 * 2. ledger-sweep.mjs：--days 缺值/非数/0/负数安全回退到 30（不会删光数据）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const TOOLS_DIR = join(import.meta.dirname, "..", "tools");

function runTool(script: string, args: string[]): string {
  try {
    return execFileSync("node", [join(TOOLS_DIR, script), ...args], {
      timeout: 30_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
}

test("dot-errors：--hours 缺值安全回退", () => {
  const out = runTool("dot-errors.mjs", ["--hours"]);
  // 不崩溃，输出格式正常
  assert.ok(out.includes("小时"), `输出应含「小时」，实际：${out.slice(0, 200)}`);
});

test("dot-errors：--hours 非数字安全回退", () => {
  const out = runTool("dot-errors.mjs", ["--hours", "abc"]);
  assert.ok(out.includes("小时"));
});

test("dot-errors：--hours 0 安全回退", () => {
  const out = runTool("dot-errors.mjs", ["--hours", "0"]);
  assert.ok(out.includes("小时"));
});

test("dot-errors：正常运行", () => {
  const out = runTool("dot-errors.mjs", ["--hours", "1", "--tail", "3"]);
  assert.ok(out.includes("小时"), `应有时间窗描述，实际：${out.slice(0, 200)}`);
});

test("ledger-sweep：--days 0 安全回退到 30", () => {
  const out = runTool("ledger-sweep.mjs", ["--days", "0", "--dry"]);
  assert.ok(out.includes("不合法"), `应提示不合法，实际：${out.slice(0, 200)}`);
  assert.ok(out.includes("30"), `应回退到 30 天，实际：${out.slice(0, 200)}`);
});

test("ledger-sweep：--days 负数安全回退到 30", () => {
  const out = runTool("ledger-sweep.mjs", ["--days", "-5", "--dry"]);
  assert.ok(out.includes("不合法"));
  assert.ok(out.includes("30"));
});

test("ledger-sweep：--days 非数字安全回退到 30", () => {
  const out = runTool("ledger-sweep.mjs", ["--days", "abc", "--dry"]);
  assert.ok(out.includes("30"));
});

test("ledger-sweep：--days 缺值安全回退到 30", () => {
  const out = runTool("ledger-sweep.mjs", ["--days", "--dry"]);
  assert.ok(out.includes("30"));
});

test("ledger-sweep：--dry 模式正常运行不碰数据", () => {
  const out = runTool("ledger-sweep.mjs", ["--days", "3650", "--dry"]);
  assert.ok(out.includes("只看不动"), `应有 --dry 提示，实际：${out.slice(0, 200)}`);
  assert.ok(out.includes("终态老任务"), `应有清扫范围描述，实际：${out.slice(0, 200)}`);
});
