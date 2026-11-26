/**
 * src/selfimprove/deploy.test.ts —— 部署这条路的验收。
 *
 * 每组测试都在临时仓库里跑：临时根下造出 build/dot-core/src/...、写一个 pending 补丁，
 * 检查器一律注入（不跑真的全量测试，那要 50 秒且与这里的判断无关）。
 *
 * 要钉住的四件事：
 * 1. 成功：真改了源码、补丁从 pending 挪到 applied、写了重启请求；
 * 2. 测试红：源码回滚到原样、补丁留着（下次还能再试）、记 self_deploy_rollback；
 * 3. 黑名单：pending 里就算塞了 gate 的补丁，部署前再查一遍也要拒；
 * 4. 打不上（上下文对不上）：一个字节都不写。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { migrate } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";
import { APPLIED_DIR, deployPendingPatch, PENDING_DIR, splitPatchByFile } from "./index.ts";
import type { SelfImproveConfigSlice } from "./types.ts";

function cfg(enabled = true): SelfImproveConfigSlice {
  return { self_improve: { enabled, max_proposals_per_day: 2 } };
}

interface Repo {
  root: string;
  patchId: string;
  reloadPath: string;
  cleanup: () => void;
}

/** 造一个最小仓库：一个可改的文件 + 一个 pending 补丁。 */
function makeRepo(patchBody: string, target = "build/dot-core/src/dispatch/prompt.ts"): Repo {
  const root = mkdtempSync(join(tmpdir(), "dot-deploy-test-"));
  const file = join(root, ...target.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "第一行\n第二行\n第三行\n", "utf8");
  const patchId = "prop_test1";
  const pending = join(root, PENDING_DIR);
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, `${patchId}.patch`), patchBody, "utf8");
  return {
    root,
    patchId,
    reloadPath: join(root, ".state", "reload-request.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function goodPatch(target = "build/dot-core/src/dispatch/prompt.ts"): string {
  return [
    `--- a/${target}`,
    `+++ b/${target}`,
    "@@ -1,3 +1,3 @@",
    " 第一行",
    "-第二行",
    "+第二行（改过）",
    " 第三行",
    "",
  ].join("\n");
}

test("splitPatchByFile：一个文件的补丁拆成一段，路径归一", () => {
  const sections = splitPatchByFile(goodPatch());
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.path, "build/dot-core/src/dispatch/prompt.ts");
});

test("部署成功：真改了源码、补丁挪到 applied、写了重启请求、记 self_deploy_ok", () => {
  const t = makeTempDb();
  const r = makeRepo(goodPatch());
  try {
    migrate(t.db);
    const out = deployPendingPatch({
      db: t.db,
      root: r.root,
      patchId: r.patchId,
      config: cfg(),
      reloadRequestPath: r.reloadPath,
      runChecks: () => ({ ok: true, detail: "注入：过了" }),
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.files.length, 1);
    assert.equal(out.reloadRequested, true);

    const content = readFileSync(join(r.root, "build/dot-core/src/dispatch/prompt.ts"), "utf8");
    assert.match(content, /第二行（改过）/);

    assert.equal(existsSync(join(r.root, PENDING_DIR, `${r.patchId}.patch`)), false);
    assert.equal(existsSync(join(r.root, APPLIED_DIR, `${r.patchId}.patch`)), true);

    const req = JSON.parse(readFileSync(r.reloadPath, "utf8")) as { patchId: string };
    assert.equal(req.patchId, r.patchId);

    const ev = t.db.prepare("SELECT type FROM events WHERE type = 'self_deploy_ok'").get() as { type: string };
    assert.equal(ev.type, "self_deploy_ok");
  } finally {
    r.cleanup();
    t.cleanup();
  }
});

test("部署后测试红：源码回滚原样、补丁留着、记 self_deploy_rollback", () => {
  const t = makeTempDb();
  const r = makeRepo(goodPatch());
  try {
    migrate(t.db);
    const out = deployPendingPatch({
      db: t.db,
      root: r.root,
      patchId: r.patchId,
      config: cfg(),
      reloadRequestPath: r.reloadPath,
      runChecks: () => ({ ok: false, detail: "注入：测试红" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "checks_failed");

    const content = readFileSync(join(r.root, "build/dot-core/src/dispatch/prompt.ts"), "utf8");
    assert.equal(content, "第一行\n第二行\n第三行\n", "源码必须一个字节都没变");
    assert.equal(existsSync(join(r.root, PENDING_DIR, `${r.patchId}.patch`)), true, "补丁要留着，下次还能再试");
    assert.equal(existsSync(join(r.root, APPLIED_DIR, `${r.patchId}.patch`)), false);
    assert.equal(existsSync(r.reloadPath), false, "没部署成功就不该请求重启");

    const ev = t.db.prepare("SELECT type FROM events WHERE type = 'self_deploy_rollback'").get() as { type: string };
    assert.equal(ev.type, "self_deploy_rollback");
  } finally {
    r.cleanup();
    t.cleanup();
  }
});

test("pending 里塞了黑名单文件的补丁：部署前再查一遍也要拒，源码不动", () => {
  const t = makeTempDb();
  const gateTarget = "build/dot-core/src/gate/policy.ts";
  const r = makeRepo(goodPatch(gateTarget), gateTarget);
  try {
    migrate(t.db);
    const out = deployPendingPatch({
      db: t.db,
      root: r.root,
      patchId: r.patchId,
      config: cfg(),
      reloadRequestPath: r.reloadPath,
      runChecks: () => ({ ok: true, detail: "不该跑到这里" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "gate");
    assert.equal(readFileSync(join(r.root, ...gateTarget.split("/")), "utf8"), "第一行\n第二行\n第三行\n");
  } finally {
    r.cleanup();
    t.cleanup();
  }
});

test("补丁上下文对不上：整单放弃，一个字节都不写", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/dispatch/prompt.ts";
  const mismatch = [
    `--- a/${target}`,
    `+++ b/${target}`,
    "@@ -1,3 +1,3 @@",
    " 完全不一样的第一行",
    "-某行",
    "+某行（改过）",
    " 别的行",
    "",
  ].join("\n");
  const r = makeRepo(mismatch, target);
  try {
    migrate(t.db);
    const out = deployPendingPatch({
      db: t.db,
      root: r.root,
      patchId: r.patchId,
      config: cfg(),
      reloadRequestPath: r.reloadPath,
      runChecks: () => ({ ok: true, detail: "不该跑到这里" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "patch_conflict");
    assert.equal(readFileSync(join(r.root, ...target.split("/")), "utf8"), "第一行\n第二行\n第三行\n");
  } finally {
    r.cleanup();
    t.cleanup();
  }
});

test("开关关着：一律不部署（fail-closed）", () => {
  const t = makeTempDb();
  const r = makeRepo(goodPatch());
  try {
    migrate(t.db);
    const out = deployPendingPatch({
      db: t.db,
      root: r.root,
      patchId: r.patchId,
      config: cfg(false),
      reloadRequestPath: r.reloadPath,
      runChecks: () => ({ ok: true, detail: "不该跑到这里" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "disabled");
    assert.equal(readFileSync(join(r.root, "build/dot-core/src/dispatch/prompt.ts"), "utf8"), "第一行\n第二行\n第三行\n");
  } finally {
    r.cleanup();
    t.cleanup();
  }
});
