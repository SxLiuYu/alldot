/**
 * src/selfimprove/patchgen.test.ts —— 「提案 → 补丁」第一步的验收（只测抠 diff，不测模型）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildPatchPrompt, extractPatch, MAX_GENERATED_PATCH_BYTES } from "./patchgen.ts";
import type { Proposal } from "./types.ts";

const proposal: Proposal = {
  id: "prop_1",
  kind: "code",
  target: "build/dot-core/src/say/index.ts",
  why: "短卡被改写后编造",
  evidence: "11 字原文变 26 字编造句",
  proposedChange: "短文本不送模型",
  risk: "长文本仍可能变形",
  expectedGain: "减少编造",
};

test("extractPatch：从 ```diff 代码块里抠出来", () => {
  const raw = [
    "好的，这是补丁：",
    "```diff",
    "--- a/build/dot-core/src/say/index.ts",
    "+++ b/build/dot-core/src/say/index.ts",
    "@@ -1,3 +1,4 @@",
    " line1",
    "+new line",
    " line2",
    "```",
  ].join("\n");
  const patch = extractPatch(raw);
  assert.notEqual(patch, null);
  assert.match(patch!, /^--- a\/build\/dot-core\/src\/say\/index\.ts/m);
  assert.match(patch!, /\+\+\+ b\//);
  assert.match(patch!, /@@ -1,3 \+1,4 @@/);
});

test("extractPatch：没围栏、整段就是 diff 也认", () => {
  const raw = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  assert.notEqual(extractPatch(raw), null);
});

test("extractPatch：模型说做不到 → null（不当失败）", () => {
  assert.equal(extractPatch("无法生成：这个文件里找不到对应代码"), null);
});

test("extractPatch：不像 diff 的正文一律不收", () => {
  assert.equal(extractPatch("我觉得应该把短文本直接返回原文。"), null);
  assert.equal(extractPatch("--- a/x.ts\n没别的了"), null, "缺 +++/@ 的不收");
  assert.equal(extractPatch(""), null);
});

test("extractPatch：超大补丁直接拒", () => {
  const huge = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", `+${"x".repeat(MAX_GENERATED_PATCH_BYTES + 10)}`].join("\n");
  assert.equal(extractPatch(huge), null);
});

test("提示词：带上目标文件原文与硬性要求", () => {
  const prompt = buildPatchPrompt({ target: proposal.target, fileText: "const a = 1;", proposal });
  assert.match(prompt, /unified diff/);
  assert.match(prompt, /只输出 diff/);
  assert.ok(prompt.includes(proposal.target));
  assert.ok(prompt.includes("const a = 1;"));
  assert.ok(prompt.includes(proposal.proposedChange));
});
