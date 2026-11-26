/**
 * src/selfimprove/apply.test.ts —— 应用这条窄路的验收。
 *
 * 每条测试都在**临时根目录**里跑，绝不碰真实仓库：
 * - 黑名单逐条拒：gate / builtin / hand.ts / ledger / keeper / keeper-install / selfimprove 自身；
 * - 配置字段闸：approvals / desktop.human_only_apps / exec.whitelist / self_improve；
 * - 白名单内：补丁写进 pending，检查全绿才留；
 * - 测试红：补丁删掉、源码一个字节没动、审计事件留下；
 * - 开关关着：连补丁都不写。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { migrate } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";
import {
  applyProposal,
  applyUnifiedDiff,
  blacklistHit,
  checkPatchPaths,
  normalizeTarget,
  guardedConfigFieldsTouched,
  listPendingPatches,
  PENDING_DIR,
} from "./index.ts";
import type { Proposal, SelfImproveConfigSlice } from "./types.ts";

function cfg(enabled = true): SelfImproveConfigSlice {
  return { self_improve: { enabled, max_proposals_per_day: 2 } };
}

function tempRoot(files: string[] = []): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dot-selfimprove-"));
  for (const rel of files) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "// 原样内容\n", "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeProposal(target: string, id = "prop_apply_test"): Proposal {
  return {
    id,
    kind: "code",
    target,
    why: "测试用",
    evidence: "测试用",
    proposedChange: "测试用",
    risk: "无",
    expectedGain: "无",
  };
}

/** 一段提到目标路径的假 diff。 */
function patchFor(target: string): string {
  return [
    `--- a/${target}`,
    `+++ b/${target}`,
    "@@ -1 +1,2 @@",
    " // 原样内容",
    "+// 新加一行",
    "",
  ].join("\n");
}

function eventsOf(db: ReturnType<typeof makeTempDb>["db"], type: string) {
  return db.prepare("SELECT * FROM events WHERE type = ? ORDER BY seq ASC").all(type) as Array<{
    payload_json: string;
  }>;
}

test("开关关着：不写补丁、不跑检查，记一条 skipped", () => {
  const t = makeTempDb();
  const r = tempRoot(["build/dot-core/src/selfeval/index.ts"]);
  try {
    migrate(t.db);
    let checked = 0;
    const out = applyProposal({
      db: t.db,
      config: cfg(false),
      proposal: makeProposal("build/dot-core/src/selfeval/index.ts"),
      patch: patchFor("build/dot-core/src/selfeval/index.ts"),
      root: r.root,
      runChecks: () => {
        checked += 1;
        return { ok: true, detail: "不该被调用" };
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "disabled");
    assert.equal(checked, 0);
    assert.equal(existsSync(join(r.root, PENDING_DIR)), false);
    assert.equal(eventsOf(t.db, "self_apply_skipped").length, 1);
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("硬黑名单逐条拒：gate / builtin / hand.ts / hands 执行边界 / ledger / keeper / keeper-install / selfimprove", () => {
  const t = makeTempDb();
  const targets: Array<[string, string]> = [
    ["build/dot-core/src/gate/policy.ts", "gate"],
    ["build/dot-core/src/hands/builtin.ts", "builtin"],
    ["build/dot-core/src/hands/hand.ts", "hand_tier"],
    ["build/dot-core/src/hands/practice.ts", "hands"],
    ["build/dot-core/src/hands/files.ts", "hands"],
    ["build/dot-core/src/hands/snapshot.ts", "hands"],
    ["build/dot-core/src/ledger/records.ts", "ledger"],
    ["build/tools/keeper.ps1", "keeper"],
    ["build/tools/keeper-install.ps1", "keeper_install"],
    ["build/dot-core/src/selfimprove/apply.ts", "selfimprove"],
  ];
  const r = tempRoot(targets.map(([p]) => p));
  try {
    migrate(t.db);
    for (const [target, rule] of targets) {
      const out = applyProposal({
        db: t.db,
        config: cfg(),
        proposal: makeProposal(target),
        patch: patchFor(target),
        root: r.root,
        runChecks: () => ({ ok: true, detail: "不该被调用" }),
      });
      assert.equal(out.ok, false, `${target} 必须被拒`);
      assert.equal(out.rule, rule, `${target} 的规则 id`);
      assert.equal(out.patchPath, null);
      assert.equal(existsSync(join(r.root, PENDING_DIR)), false, "被拒时不许建 pending 目录");
    }
    const denied = eventsOf(t.db, "self_apply_denied");
    assert.equal(denied.length, targets.length, "每一条拒都要留审计");
    for (const ev of denied) {
      const payload = JSON.parse(ev.payload_json) as { rule: string; reason: string };
      assert.ok(payload.rule !== "" && payload.reason !== "");
    }
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("配置字段闸：approvals / human_only_apps / whitelist / self_improve 逐条拒", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/config-schema.ts";
  const r = tempRoot([target]);
  try {
    migrate(t.db);
    const cases: Array<[string, string]> = [
      ["approvals", '+  "approvals": {},'],
      ["human_only_apps", '+  "human_only_apps": ["Weixin"],'],
      ["whitelist", '+  "whitelist": [],'],
      ["self_improve", '+  "self_improve": { "enabled": true },'],
    ];
    for (const [field, extra] of cases) {
      const patch = `${patchFor(target)}\n${extra}\n`;
      assert.ok(guardedConfigFieldsTouched(target, patch).includes(field));
      const out = applyProposal({
        db: t.db,
        config: cfg(),
        proposal: makeProposal(target),
        patch,
        root: r.root,
        runChecks: () => ({ ok: true, detail: "不该被调用" }),
      });
      assert.equal(out.ok, false, `${field} 必须被拒`);
      assert.equal(out.rule, "schema_field");
      assert.match(out.reason, new RegExp(field));
    }
    assert.equal(eventsOf(t.db, "self_apply_denied").length, cases.length);
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("白名单内允许：补丁写进 pending、检查全绿、源码原样", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/selfeval/index.ts";
  const r = tempRoot([target]);
  try {
    migrate(t.db);
    const before = readFileSync(join(r.root, ...target.split("/")), "utf8");
    const patch = patchFor(target);
    const out = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch,
      root: r.root,
      runChecks: () => ({ ok: true, detail: "全量测试 + 类型检查都过了" }),
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.rule, null);
    assert.ok(out.patchPath !== null && existsSync(out.patchPath));
    assert.equal(readFileSync(out.patchPath, "utf8"), patch);
    assert.deepEqual(listPendingPatches(r.root), ["prop_apply_test.patch"]);
    assert.equal(
      readFileSync(join(r.root, ...target.split("/")), "utf8"),
      before,
      "应用路径不许改源码",
    );
    const passed = eventsOf(t.db, "self_apply_passed");
    assert.equal(passed.length, 1);
    const payload = JSON.parse(passed[0]?.payload_json ?? "{}") as { patch_path: string; note: string };
    assert.match(payload.patch_path, /pending\/prop_apply_test\.patch$/);
    assert.match(payload.note, /等人看过/);
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("测试红：删掉补丁、源码不动、留审计（含检查结论）", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/selfeval/index.ts";
  const r = tempRoot([target]);
  try {
    migrate(t.db);
    const before = readFileSync(join(r.root, ...target.split("/")), "utf8");
    const out = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch: patchFor(target),
      root: r.root,
      runChecks: () => ({ ok: false, detail: "全量测试失败（exit 1）：2 tests failed" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "checks_failed");
    assert.equal(out.patchPath, null);
    assert.equal(existsSync(join(r.root, PENDING_DIR, "prop_apply_test.patch")), false);
    assert.deepEqual(listPendingPatches(r.root), [], "不留半截改动");
    assert.equal(existsSync(join(r.root, "build", "自我优化")), false, "空壳目录也不留");
    assert.equal(readFileSync(join(r.root, ...target.split("/")), "utf8"), before);

    const rejected = eventsOf(t.db, "self_apply_rejected");
    assert.equal(rejected.length, 1);
    const payload = JSON.parse(rejected[0]?.payload_json ?? "{}") as { checks: string; note: string };
    assert.match(payload.checks, /2 tests failed/);
    assert.match(payload.note, /补丁已删除/);
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("检查器自己抛错：也走删除 + 审计，不把异常漏给调用方", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/selfeval/index.ts";
  const r = tempRoot([target]);
  try {
    migrate(t.db);
    const out = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch: patchFor(target),
      root: r.root,
      runChecks: () => {
        throw new Error("tsc 起不来");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "checks_failed");
    assert.equal(out.patchPath, null);
    assert.equal(listPendingPatches(r.root).length, 0);
    assert.match(String(out.checks), /tsc 起不来/);
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("路径闸：绝对路径 / .. / 白名单外 / 目标不存在 都拒", () => {
  const t = makeTempDb();
  const r = tempRoot(["build/dot-core/src/selfeval/index.ts"]);
  try {
    migrate(t.db);
    const cases: Array<[string, string]> = [
      ["C:/Windows/win.ini", "absolute_path"],
      ["/etc/passwd", "absolute_path"],
      ["build/dot-core/src/../../tools/keeper.ps1", "path_traversal"],
      ["build/tools/run-tests.mjs", "not_whitelisted"],
      ["build/dot-core/src/nope.ts", "target_missing"],
    ];
    for (const [target, rule] of cases) {
      const out = applyProposal({
        db: t.db,
        config: cfg(),
        proposal: makeProposal(target),
        patch: `--- a/x\n+++ b/x\n@@ -1 +1 @@\n+ ${target}`,
        root: r.root,
        runChecks: () => ({ ok: true, detail: "不该被调用" }),
      });
      assert.equal(out.ok, false, `${target} 必须被拒`);
      assert.equal(out.rule, rule, `${target} 的规则 id（${out.reason}）`);
    }
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("补丁与目标不一致 / 空补丁：拒，且不写文件", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/selfeval/index.ts";
  const r = tempRoot([target]);
  try {
    migrate(t.db);
    const mismatch = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch: "--- a/别的文件\n+++ b/别的文件\n@@ -1 +1 @@\n+x",
      root: r.root,
      runChecks: () => ({ ok: true, detail: "不该被调用" }),
    });
    assert.equal(mismatch.rule, "patch_target_mismatch");

    const empty = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch: "   ",
      root: r.root,
      runChecks: () => ({ ok: true, detail: "不该被调用" }),
    });
    assert.equal(empty.rule, "empty_patch");

    assert.equal(existsSync(join(r.root, PENDING_DIR)), false);
    assert.equal(eventsOf(t.db, "self_apply_denied").length, 2);
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("补丁正文闸：target 清白但正文夹带黑名单文件 → 拒（评审实测的绕过口）", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/say/index.ts";
  const gate = "build/dot-core/src/gate/policy.ts";
  const r = tempRoot([target, gate]);
  try {
    migrate(t.db);
    const smuggled = [
      `--- a/${target}`,
      `+++ b/${target}`,
      "@@ -1 +1,2 @@",
      " // 原样内容",
      "+// 顺手改点别的",
      `--- a/${gate}`,
      `+++ b/${gate}`,
      "@@ -1 +1,2 @@",
      " // 原样内容",
      "+export const x = 1;",
      "",
    ].join("\n");
    assert.equal(checkPatchPaths(smuggled).rule, "gate");

    const out = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch: smuggled,
      root: r.root,
      runChecks: () => ({ ok: true, detail: "不该被调用" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.rule, "gate");
    assert.equal(existsSync(join(r.root, PENDING_DIR)), false, "被拒时不许写补丁");

    // 没有 diff 文件头、只在正文里提到黑名单路径，也要拒。
    const mention = [
      `--- a/${target}`,
      `+++ b/${target}`,
      "@@ -1 +1,2 @@",
      " // 原样内容",
      "+// 参照 build/dot-core/src/ledger/records.ts 的写法",
      "",
    ].join("\n");
    const out2 = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch: mention,
      root: r.root,
      runChecks: () => ({ ok: true, detail: "不该被调用" }),
    });
    assert.equal(out2.rule, "ledger");

    // 补丁里出现白名单外的文件（test 文件头也要拒）。
    const outside = ["--- a/build/tools/run-tests.mjs", "+++ b/build/tools/run-tests.mjs", "@@ -1 +1 @@", "-x", "+y", ""].join(
      "\n",
    );
    assert.equal(checkPatchPaths(outside).rule, "patch_outside_whitelist");
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("applyUnifiedDiff：能打上就返回结果，上下文对不上返回 null", () => {
  const original = "a\nb\nc\n";
  const ok = ["--- a/x", "+++ b/x", "@@ -1,3 +1,4 @@", " a", " b", "+新行", " c", ""].join("\n");
  assert.equal(applyUnifiedDiff(original, ok), "a\nb\n新行\nc\n");

  const bad = ["--- a/x", "+++ b/x", "@@ -1,3 +1,4 @@", " a", " 不存在", " c", ""].join("\n");
  assert.equal(applyUnifiedDiff(original, bad), null);
  assert.equal(applyUnifiedDiff(original, "没有 hunk"), null);
});

test("配置字段闸（语义）：只改嵌套值、父字段只在上下文行，也要拒", () => {
  const t = makeTempDb();
  const target = "build/dot-core/src/config-schema.ts";
  const jsonTarget = "build/dot-core/config.example.json";
  const r = tempRoot([]);
  try {
    migrate(t.db);
    // TS 配置文件：多行结构，改的只是 self_improve 里的 enabled。
    const tsPath = join(r.root, ...target.split("/"));
    mkdirSync(dirname(tsPath), { recursive: true });
    writeFileSync(
      tsPath,
      [
        "const D = {",
        "  self_improve: {",
        "    enabled: false,",
        "    max_proposals_per_day: 2,",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const tsPatch = [
      `--- a/${target}`,
      `+++ b/${target}`,
      "@@ -1,6 +1,6 @@",
      " const D = {",
      "   self_improve: {",
      "-    enabled: false,",
      "+    enabled: true,",
      "     max_proposals_per_day: 2,",
      "   },",
      " };",
      "",
    ].join("\n");
    assert.ok(guardedConfigFieldsTouched(target, tsPatch, { root: r.root }).includes("self_improve"));

    const schemaReject = applyProposal({
      db: t.db,
      config: cfg(),
      proposal: makeProposal(target),
      patch: tsPatch,
      root: r.root,
      runChecks: () => ({ ok: true, detail: "不该被调用" }),
    });
    assert.equal(schemaReject.rule, "schema_field");

    // JSON 示例文件：只改 approvals 里的 ttl_hours（父字段只在上下文行）。
    const jsonPath = join(r.root, ...jsonTarget.split("/"));
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      ['{', '  "approvals": {', '    "inline_wait_ms": 90000,', '    "ttl_hours": 24', "  },", '  "self_improve": {', '    "enabled": false,', '    "max_proposals_per_day": 2', "  }", "}", ""].join(
        "\n",
      ),
      "utf8",
    );
    const jsonPatch = [
      `--- a/${jsonTarget}`,
      `+++ b/${jsonTarget}`,
      "@@ -1,9 +1,9 @@",
      " {",
      '   "approvals": {',
      '     "inline_wait_ms": 90000,',
      '-    "ttl_hours": 24',
      '+    "ttl_hours": 7200',
      "   },",
      '   "self_improve": {',
      '     "enabled": false,',
      '     "max_proposals_per_day": 2',
      "   }",
      " }",
      "",
    ].join("\n");
    assert.deepEqual(guardedConfigFieldsTouched(jsonTarget, jsonPatch, { root: r.root }), ["approvals"]);

    // 无关字段（顶层加个 budget）不算命中。
    const harmless = [
      `--- a/${jsonTarget}`,
      `+++ b/${jsonTarget}`,
      "@@ -1,2 +1,3 @@",
      " {",
      '+  "budget": { "tokens": 1 },',
      '   "approvals": {',
      "",
    ].join("\n");
    assert.equal(guardedConfigFieldsTouched(jsonTarget, harmless, { root: r.root }).length, 0);
  } finally {
    t.cleanup();
    r.cleanup();
  }
});

test("路径归一绕过：src/./gate、src//gate、反斜杠 都必须被黑名单拦住", () => {
  // 2026-11-25 评审实测：normalizeTarget 原来只去掉开头的 ./，
  // 于是 `build/dot-core/src/./gate/policy.ts` 能绕过黑名单（PASS）。
  // 这条测试就是钉住那个口子。
  const variants = [
    "build/dot-core/src/gate/policy.ts",
    "build/dot-core/src/./gate/policy.ts",
    "build/dot-core/src//gate/policy.ts",
    "./build/dot-core/src/././gate/policy.ts",
    "build/dot-core/src" + String.fromCharCode(92) + "gate" + String.fromCharCode(92) + "policy.ts",
    "build/dot-core/src/hands/./practice.ts",
    "build/dot-core/src//ledger//records.ts",
  ];
  for (const v of variants) {
    const hit = blacklistHit(v);
    assert.notEqual(hit, null, `应当命中黑名单：${v}`);
  }
  // 归一本身：空段与 . 都消失，.. 保留给 path_traversal 去拒
  assert.equal(normalizeTarget("build//dot-core/./src/practice.ts"), "build/dot-core/src/practice.ts");
  assert.equal(normalizeTarget("./a/./b"), "a/b");
  assert.equal(normalizeTarget("a/../b"), "a/../b");
});

test("补丁正文闸：文件头写 src/./gate 也要拒", () => {
  const patch = [
    "--- a/build/dot-core/src/dispatch/prompt.ts",
    "+++ b/build/dot-core/src/dispatch/prompt.ts",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    "--- a/build/dot-core/src/./gate/policy.ts",
    "+++ b/build/dot-core/src/./gate/policy.ts",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");
  const check = checkPatchPaths(patch);
  assert.equal(check.ok, false);
  assert.equal(check.rule, "gate");
});
