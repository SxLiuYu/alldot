/**
 * src/selfimprove/index.test.ts —— 提案规范化的边界。
 *
 * 只钉一条：code 类提案的 target 必须是 build/dot-core/src/ 下的文件路径。
 * 2026-11-25 真机：模型把 target 写成「desktop 步骤提示词：USER_CONTROL 处理环节」这种描述，
 * 卡是出来了、点「同意」也没用——补丁流水线拿不到文件，等于白点一次。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeProposal } from "./index.ts";

test("normalizeProposal：code 类的 target 不是文件路径 → 丢弃", () => {
  const base = {
    kind: "code",
    why: "失败样本里有 3 次",
    evidence: "x",
    proposedChange: "加一条判断",
    risk: "无",
    expectedGain: "少走 2 步",
  };
  assert.equal(normalizeProposal({ ...base, target: "desktop 步骤提示词：USER_CONTROL 处理环节" }), null);
  const good = normalizeProposal({ ...base, target: "build/dot-core/src/hands/desktop.ts" });
  assert.notEqual(good, null);
  assert.equal(good?.target, "build/dot-core/src/hands/desktop.ts");

  // config / prompt 类还是允许写键名或环节名：它们不走补丁流水线。
  assert.notEqual(normalizeProposal({ ...base, kind: "config", target: "keepalive.disk.warn_gb" }), null);
});
