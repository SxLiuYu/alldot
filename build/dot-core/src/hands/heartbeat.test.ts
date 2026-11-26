/**
 * src/hands/heartbeat.test.ts —— 心跳文件的验收。
 *
 * 契约不是我们自己定的：build/tools/keeper.ps1:24-28 与 Get-DotCoreProbe（:379-410）
 * 认 `<user>\.allbot\dot\state\dot-core.heartbeat`，超过 600 秒算「未加载」→ 停网关。
 * 所以这里只验三件事：文件写得出来、内容是能解析的 JSON、定时器会覆盖写且能停。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HEARTBEAT_STALE_SECONDS, Heartbeat, heartbeatPathIn } from "./heartbeat.ts";

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dot-heartbeat-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("默认路径是 <dotDir>/state/dot-core.heartbeat；过期阈值 600 秒", () => {
  assert.equal(heartbeatPathIn("C:/x/dot"), join("C:/x/dot", "state", "dot-core.heartbeat"));
  assert.equal(HEARTBEAT_STALE_SECONDS, 600);
});

test("touch：建目录、写可解析 JSON、带 pid/at/meta", () => {
  withDir((dir) => {
    const path = join(dir, "state", "dot-core.heartbeat");
    const hb = new Heartbeat({ path, meta: { version: "0.2.0" } });
    hb.touch();

    assert.ok(existsSync(path));
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(body["pid"], process.pid);
    assert.equal(body["version"], "0.2.0");
    assert.match(String(body["at"]), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof hb.lastWrittenAtMs, "number");
  });
});

test("intervalMs=0：只写一次，不起定时器", () => {
  withDir((dir) => {
    const hb = new Heartbeat({ path: join(dir, "dot-core.heartbeat"), intervalMs: 0 });
    hb.start();
    assert.equal(hb.running, false);
    assert.ok(existsSync(hb.path));
    hb.stop();
  });
});

test("定时器覆盖写；stop 之后不再写", async () => {
  withDir(async (dir) => {
    let tick = 0;
    const hb = new Heartbeat({
      path: join(dir, "dot-core.heartbeat"),
      intervalMs: 15,
      now: () => new Date(1_700_000_000_000 + (tick += 1000)),
    });
    hb.start();
    assert.equal(hb.running, true);
    const first = hb.lastWrittenAtMs;
    assert.ok(first !== null);

    await new Promise((r) => setTimeout(r, 60));
    const second = hb.lastWrittenAtMs;
    assert.ok(second !== null && first !== null && second > first, "定时器应覆盖写");

    hb.stop();
    assert.equal(hb.running, false);
    const afterStop = hb.lastWrittenAtMs;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(hb.lastWrittenAtMs, afterStop, "stop 之后不再写");
  });
});
