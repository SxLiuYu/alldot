/**
 * src/selfimprove/pipeline.test.ts —— 「提案例 → 补丁卡 → 上机」两段的验收。
 *
 * 钉住：
 * 1. 模型给出可用 diff 且检查全绿 → pending 里真有补丁，并再出一张「要不要上机」的卡（tier 3）；
 * 2. 模型没给出 diff / 目标在红线里 / 开关关着 → 一张卡都不出，源码不动；
 * 3. 第二段（上机）只有补丁在、检查绿时才动源码，并写 reload-request；
 * 4. 所有路径都在临时目录里折腾，不碰真仓库。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { listApprovals, migrate, tailEvents } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";
import { generatePatchForProposal, deployReadyPatch, pendingDirOf } from "./pipeline.ts";
import type { Proposal } from "./types.ts";

const TARGET = "build/dot-core/src/demo/thing.ts";
const SOURCE = "export function hello(): string {\n  return \"hi\";\n}\n";

function repo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dot-selfimprove-pipe-"));
  const file = join(root, TARGET);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, SOURCE, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function proposal(target = TARGET): Proposal {
  return {
    id: "prop_pipe_1",
    kind: "code",
    target,
    why: "测试",
    evidence: "测试",
    proposedChange: "把返回值改成 hello",
    risk: "无",
    expectedGain: "无",
  };
}

const GOOD_DIFF = [
  `--- a/${TARGET}`,
  `+++ b/${TARGET}`,
  "@@ -1,3 +1,3 @@",
  " export function hello(): string {",
  '-  return "hi";',
  '+  return "hello";',
  " }",
  "",
].join("\n");

const config = { self_improve: { enabled: true, max_proposals_per_day: 2 } };

test("第一段：模型给出可用 diff、检查全绿 → 留下 pending 补丁 + 出一张上机卡", async () => {
  const r = repo();
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const out = await generatePatchForProposal(
      {
        db: tmp.db,
        root: r.root,
        config,
        complete: async () => `这是补丁：\n\`\`\`diff\n${GOOD_DIFF}\`\`\``,
        runChecks: () => ({ ok: true, detail: "测试：假检查通过" }),
      },
      proposal(),
    );

    assert.equal(out.ok, true, out.reason);
    assert.equal(existsSync(out.patchPath ?? ""), true, "pending 里要有补丁文件");
    assert.equal(existsSync(pendingDirOf(r.root)), true);
    assert.equal(readFileSync(join(r.root, TARGET), "utf8"), SOURCE, "第一段不许动源码");

    const cards = listApprovals(tmp.db);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.tier, 3);
    const detail = JSON.parse(cards[0]?.detail_json ?? "{}") as Record<string, unknown>;
    assert.equal(detail["patch_id"], "prop_pipe_1");
    assert.match(String(detail["diff"]), /return "hello"/);
    assert.match(cards[0]?.title ?? "", /自我优化补丁/);

    const types = tailEvents(tmp.db, 50).map((e) => e.type);
    assert.ok(types.includes("self_patch_ready"), "要落一条 self_patch_ready 事件");
  } finally {
    tmp.cleanup();
    r.cleanup();
  }
});

test("第一段：模型没给出 diff → 一张卡都不出，什么都不留", async () => {
  const r = repo();
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const out = await generatePatchForProposal(
      {
        db: tmp.db,
        root: r.root,
        config,
        complete: async () => "无法生成：这个文件里找不到对应代码",
        runChecks: () => ({ ok: true, detail: "不该被调用" }),
      },
      proposal(),
    );
    assert.equal(out.ok, false);
    assert.match(out.reason, /diff/);
    assert.equal(listApprovals(tmp.db).length, 0);
    assert.equal(existsSync(pendingDirOf(r.root)), false);
  } finally {
    tmp.cleanup();
    r.cleanup();
  }
});

test("第一段：目标命中红线（闸门目录）→ 拒，不出卡", async () => {
  const r = repo();
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const blocked = "build/dot-core/src/gate/policy.ts";
    mkdirSync(dirname(join(r.root, blocked)), { recursive: true });
    writeFileSync(join(r.root, blocked), "// gate\n", "utf8");

    const out = await generatePatchForProposal(
      { db: tmp.db, root: r.root, config, complete: async () => GOOD_DIFF, runChecks: () => ({ ok: true, detail: "" }) },
      proposal(blocked),
    );
    assert.equal(out.ok, false);
    assert.match(out.reason, /gate/);
    assert.equal(listApprovals(tmp.db).length, 0);
  } finally {
    tmp.cleanup();
    r.cleanup();
  }
});

test("第一段：开关关着 → 什么都不做", async () => {
  const r = repo();
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const out = await generatePatchForProposal(
      {
        db: tmp.db,
        root: r.root,
        config: { self_improve: { enabled: false, max_proposals_per_day: 2 } },
        complete: async () => GOOD_DIFF,
        runChecks: () => ({ ok: true, detail: "" }),
      },
      proposal(),
    );
    assert.equal(out.ok, false);
    assert.equal(listApprovals(tmp.db).length, 0);
  } finally {
    tmp.cleanup();
    r.cleanup();
  }
});

test("第二段：补丁在、检查绿 → 源码真改了，并写 reload-request", async () => {
  const r = repo();
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const first = await generatePatchForProposal(
      {
        db: tmp.db,
        root: r.root,
        config,
        complete: async () => GOOD_DIFF,
        runChecks: () => ({ ok: true, detail: "假检查通过" }),
      },
      proposal(),
    );
    assert.equal(first.ok, true, first.reason);

    const reload = join(r.root, "state", "reload-request.json");
    const out = deployReadyPatch(
      {
        db: tmp.db,
        root: r.root,
        config,
        reloadRequestPath: reload,
        runChecks: () => ({ ok: true, detail: "上机后检查通过" }),
      },
      "prop_pipe_1",
    );

    assert.equal(out.ok, true, out.reason);
    assert.match(readFileSync(join(r.root, TARGET), "utf8"), /return "hello"/);
    assert.equal(out.reloadRequested, true);
    assert.equal(existsSync(reload), true, "要请求看门狗重启，补丁才真的生效");
    assert.equal(
      existsSync(join(pendingDirOf(r.root), "prop_pipe_1.patch")),
      false,
      "上机后补丁要从 pending 归档走",
    );
  } finally {
    tmp.cleanup();
    r.cleanup();
  }
});

test("第二段：补丁不在 → 拒，源码不动", () => {
  const r = repo();
  const tmp = makeTempDb();
  try {
    migrate(tmp.db);
    const out = deployReadyPatch({ db: tmp.db, root: r.root, config, runChecks: () => ({ ok: true, detail: "" }) }, "prop_missing");
    assert.equal(out.ok, false);
    assert.equal(readFileSync(join(r.root, TARGET), "utf8"), SOURCE);
  } finally {
    tmp.cleanup();
    r.cleanup();
  }
});
