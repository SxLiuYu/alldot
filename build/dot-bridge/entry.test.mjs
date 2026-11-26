/**
 * entry.test.mjs —— 真的把 `node build/dot-bridge/index.mjs` 起起来，
 * 按 keeper 的方式打 /health 和状态页，验入口参数与退出行为。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function waitForListening(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`入口 15 秒内没报 listening；输出：${output}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      output += String(d);
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`入口提前退出（code=${code}）；输出：${output}`));
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

test("入口：--port 0 --data-dir <temp> 真起服务，/health 与状态页可用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-bridge-entry-"));
  const dotDir = join(dir, "dot");
  mkdirSync(dotDir, { recursive: true });
  const token = "entry-test-token-0123456789";
  writeFileSync(join(dotDir, "bridge-token"), `${token}\n`, "utf8");

  const child = spawn(
    process.execPath,
    ["build/dot-bridge/index.mjs", "--port", "0", "--data-dir", dotDir, "--upstream", "http://127.0.0.1:9"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const url = await waitForListening(child);

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.token.configured, true);
    assert.equal(healthBody.token.path, join(dotDir, "bridge-token"));
    assert.equal(healthBody.ledger.path, join(dotDir, "ledger", "dot.db"));

    const page = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /任务进度/);

    const unauthorized = await fetch(`${url}/`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await stopChild(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
