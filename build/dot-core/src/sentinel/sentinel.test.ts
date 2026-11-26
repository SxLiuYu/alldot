/**
 * src/sentinel/sentinel.test.ts —— Sentinel 权限系统的测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sentinel, DEFAULT_SENTINEL_POLICY } from "./index.ts";

function fixture(): { sentinel: Sentinel; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-test-"));
  const sentinel = new Sentinel(join(dir, "sentinel.json"));
  return {
    sentinel,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test("sentinel：默认策略允许 files 读写", () => {
  const f = fixture();
  try {
    assert.equal(f.sentinel.check("files", "read").allowed, true);
    assert.equal(f.sentinel.check("files", "write").allowed, true);
    assert.equal(f.sentinel.check("files", "exec").allowed, false);
  } finally {
    f.cleanup();
  }
});

test("sentinel：desktop 默认允许读写但禁 exec", () => {
  const f = fixture();
  try {
    assert.equal(f.sentinel.check("desktop", "read").allowed, true);
    assert.equal(f.sentinel.check("desktop", "click").allowed, true);
    assert.equal(f.sentinel.check("desktop", "exec").allowed, false);
  } finally {
    f.cleanup();
  }
});

test("sentinel：exec 只允许 exec 类", () => {
  const f = fixture();
  try {
    assert.equal(f.sentinel.check("exec", "exec").allowed, true);
    assert.equal(f.sentinel.check("exec", "read").allowed, false);
    assert.equal(f.sentinel.check("exec", "write").allowed, false);
  } finally {
    f.cleanup();
  }
});

test("sentinel：未知服务默认拒绝", () => {
  const f = fixture();
  try {
    const v = f.sentinel.check("unknown_service", "read");
    assert.equal(v.allowed, false);
    assert.ok(v.reason?.includes("未知服务"));
  } finally {
    f.cleanup();
  }
});

test("sentinel：setPermission 修改权限", () => {
  const f = fixture();
  try {
    // 默认 wechat 允许写
    assert.equal(f.sentinel.check("wechat", "send").allowed, true);

    // 关掉写权限
    f.sentinel.setPermission("wechat", { read: true, write: false, exec: false });
    assert.equal(f.sentinel.check("wechat", "send").allowed, false);
  } finally {
    f.cleanup();
  }
});

test("sentinel：持久化", () => {
  const f = fixture();
  try {
    f.sentinel.setPermission("files", { read: true, write: false, exec: false });
    const raw = readFileSync(join(f.sentinel["policyPath"] as string), "utf8");
    const saved = JSON.parse(raw);
    assert.equal(saved.files.write, false);
  } finally {
    f.cleanup();
  }
});

test("sentinel：动作分类", () => {
  const f = fixture();
  try {
    // read 类动作
    assert.equal(f.sentinel.check("browser", "read").category, "read");
    assert.equal(f.sentinel.check("browser", "screenshot").category, "read");

    // write 类动作
    assert.equal(f.sentinel.check("browser", "click").category, "write");
    assert.equal(f.sentinel.check("files", "edit").category, "write");

    // exec 类
    assert.equal(f.sentinel.check("exec", "exec").category, "exec");
  } finally {
    f.cleanup();
  }
});

test("sentinel：reset 恢复默认", () => {
  const f = fixture();
  try {
    f.sentinel.setPermission("files", { read: true, write: false, exec: true });
    f.sentinel.reset();
    assert.equal(f.sentinel.check("files", "write").allowed, true);
    assert.equal(f.sentinel.check("files", "exec").allowed, false);
  } finally {
    f.cleanup();
  }
});
