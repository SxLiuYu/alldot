/**
 * src/runtime/live-config.test.ts —— 「改完马上生效」这一层的验收。
 *
 * 钉住三条：
 * 1. 文件里写了就用文件的值（哪怕启动时配置是 0）；
 * 2. 文件不在/写坏了 → 退回启动时那份，绝不放宽；
 * 3. 上限 4 写死：文件里写 9、写 -1、写 "abc" 都不会让 5/6 档自动通过。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { clampAutoApproveTier, createLiveAutoApproveMaxTier } from "./live-config.ts";

function tempDir(tag: string): string {
  const dir = join(tmpdir(), `dot-livecfg-${tag}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("clamp：只认 0..4，别的写法都夹回来", () => {
  assert.equal(clampAutoApproveTier(0), 0);
  assert.equal(clampAutoApproveTier(4), 4);
  assert.equal(clampAutoApproveTier(9), 4, "写再大也只到 4");
  assert.equal(clampAutoApproveTier(-3), 0);
  assert.equal(clampAutoApproveTier(2.7), 2);
  assert.equal(clampAutoApproveTier("3"), 3);
  assert.equal(clampAutoApproveTier("abc"), 0);
  assert.equal(clampAutoApproveTier(undefined), 0);
});

test("文件里写了就用文件的值", () => {
  const dir = tempDir("file");
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ approvals: { auto_approve_max_tier: 3 } }), "utf8");
  try {
    const read = createLiveAutoApproveMaxTier(p, 0);
    assert.equal(read(), 3, "启动时是 0，文件写了 3 就该按 3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件不在或写坏了：退回启动时的值，不放宽", () => {
  const dir = tempDir("broken");
  const missing = join(dir, "nope.json");
  assert.equal(createLiveAutoApproveMaxTier(missing, 2)(), 2);

  const broken = join(dir, "config.json");
  writeFileSync(broken, "{ 这不是 json", "utf8");
  assert.equal(createLiveAutoApproveMaxTier(broken, 1)(), 1);
  rmSync(dir, { recursive: true, force: true });
});
