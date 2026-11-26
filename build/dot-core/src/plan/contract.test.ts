/**
 * src/plan/contract.test.ts —— 长程任务契约的验收。
 *
 * 钉住五件事：
 * 1. parseContract：从 declared_json 解析契约，没写 contract 就返回 null
 * 2. checkContract：约束检查（contains / regex / range / exists / equal）
 * 3. checkContract：交付物检查（step / file / text）
 * 4. nextDeliverable：硬约束没满足 → fix_constraint
 * 5. nextDeliverable：都完成 → done
 */

import test from "node:test";
import assert from "node:assert/strict";

import { migrate, createTask, beginStep, endStep, putArtifact } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";
import { parseContract, checkContract, nextDeliverable } from "./contract.ts";

function fixture(): { db: ReturnType<typeof makeTempDb>; cleanup: () => void } {
  const t = makeTempDb();
  migrate(t.db);
  return {
    db: t.db,
    cleanup: t.cleanup ?? (() => { try { t.db.close(); } catch { /* ignore */ } }),
  };
}

test("parseContract：没有 contract 字段返回 null", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, { intent: "test", source: "test", declared: { workspace: "/tmp" } });
    assert.equal(parseContract(task), null);
  } finally {
    f.cleanup();
  }
});

test("parseContract：解析约束和交付物", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      declared: {
        contract: {
          version: 1,
          goal: "做一个文件",
          constraints: [
            { id: "c1", description: "必须包含 hello", check: "contains", value: "hello", severity: "hard" },
          ],
          deliverables: [
            { id: "d1", description: "输出文件", type: "file", path: "out.txt", done_when: "文件存在" },
          ],
        },
      },
    });
    const contract = parseContract(task);
    assert.notEqual(contract, null);
    assert.equal(contract!.goal, "做一个文件");
    assert.equal(contract!.constraints.length, 1);
    assert.equal(contract!.deliverables.length, 1);
  } finally {
    f.cleanup();
  }
});

test("checkContract：contains 约束检查", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1,
          goal: "",
          constraints: [
            { id: "c1", description: "包含 hello", check: "contains", value: "hello", severity: "hard" },
            { id: "c2", description: "包含 missing", check: "contains", value: "missing", severity: "hard" },
          ],
          deliverables: [],
        },
      },
    });
    // 造一步，result 里带 hello
    const step = beginStep(f.db, { task_id: task.id, run_epoch: 0, kind: "tool", tool: "practice", subject_key: "s1", side_effect: "safe", tier: 1 });
    const art = putArtifact(f.db, JSON.stringify({ text: "hello world" }));
    endStep(f.db, step.id, { status: "succeeded", result_ref: art.hash });

    const report = checkContract(f.db, task.id);
    assert.notEqual(report, null);
    assert.equal(report!.hardSatisfaction, 0.5); // c1 满足，c2 不满足
    assert.equal(report!.constraints[0].satisfied, true);
    assert.equal(report!.constraints[1].satisfied, false);
  } finally {
    f.cleanup();
  }
});

test("checkContract：交付物检查（step 类型）", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1,
          goal: "",
          constraints: [],
          deliverables: [
            { id: "d1", description: "用 files 读文件", type: "step", tool: "files", done_when: "有 files 步骤" },
            { id: "d2", description: "用 desktop 操作", type: "step", tool: "desktop", done_when: "有 desktop 步骤" },
          ],
        },
      },
    });
    const step = beginStep(f.db, { task_id: task.id, run_epoch: 0, kind: "tool", tool: "files", subject_key: "s1", side_effect: "safe", tier: 1 });
    endStep(f.db, step.id, { status: "succeeded" });

    const report = checkContract(f.db, task.id);
    assert.notEqual(report, null);
    assert.equal(report!.deliveryCompletion, 0.5); // d1 完成，d2 没有
    assert.deepEqual(report!.outstanding, ["d2"]);
  } finally {
    f.cleanup();
  }
});

test("nextDeliverable：硬约束没满足 → fix_constraint", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1,
          goal: "",
          constraints: [
            { id: "c1", description: "必须包含 foo", check: "contains", value: "foo", severity: "hard" },
          ],
          deliverables: [],
        },
      },
    });
    const next = nextDeliverable(f.db, task.id);
    assert.notEqual(next, null);
    assert.equal(next!.action, "fix_constraint");
    assert.equal(next!.constraintId, "c1");
  } finally {
    f.cleanup();
  }
});

test("nextDeliverable：都完成 → done", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1,
          goal: "",
          constraints: [],
          deliverables: [],
        },
      },
    });
    const next = nextDeliverable(f.db, task.id);
    assert.notEqual(next, null);
    assert.equal(next!.action, "done");
  } finally {
    f.cleanup();
  }
});

// ── 2026-11-26 评审修复的 5 个 bug 的回归测试 ──

test("回归：equal 按行比对而不是全量拼接文本", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1, goal: "",
          constraints: [
            { id: "eq1", description: "结果等于 42", check: "equal", value: "RESULT=42", severity: "hard" },
          ],
          deliverables: [],
        },
      },
    });
    // 多行结果文本，其中一行是 RESULT=42
    const step = beginStep(f.db, { task_id: task.id, run_epoch: 0, kind: "tool", tool: "t", subject_key: "k1", side_effect: "safe", tier: 1 });
    const art = putArtifact(f.db, "out of range: 9999\nRESULT=42\nother stuff");
    endStep(f.db, step.id, { status: "succeeded", result_ref: art.hash });

    const report = checkContract(f.db, task.id);
    // 修复前：allText 全量拼接与 "RESULT=42" 比全等 → 永远 false
    // 修复后：按行比对，有一行等于 "RESULT=42" → true
    assert.equal(report!.constraints[0].satisfied, true);
  } finally {
    f.cleanup();
  }
});

test("回归：range 从结果文本取最后一个数字（支持负数）", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1, goal: "",
          constraints: [
            { id: "r1", description: "温度在 [-50,100]", check: "range", min: -50, max: 100, severity: "hard" },
          ],
          deliverables: [],
        },
      },
    });
    // 文本里有多个数字，最后一个是 -5（负数）
    const step = beginStep(f.db, { task_id: task.id, run_epoch: 0, kind: "tool", tool: "t", subject_key: "k1", side_effect: "safe", tier: 1 });
    const art = putArtifact(f.db, "time 30s\noffset 100\nRESULT=-5");
    endStep(f.db, step.id, { status: "succeeded", result_ref: art.hash });

    const report = checkContract(f.db, task.id);
    // 修复前：取第一个数字（30）且不支持负号
    // 修复后：取最后一个（-5），-5 在 [-50,100] 内
    assert.equal(report!.constraints[0].satisfied, true);
  } finally {
    f.cleanup();
  }
});

test("回归：regex 语法错标 configError 不进满足率", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1, goal: "",
          constraints: [
            { id: "bad", description: "坏正则", check: "regex", value: "[unclosed", severity: "hard" },
            { id: "ok", description: "好正则", check: "regex", value: "hello", severity: "hard" },
          ],
          deliverables: [],
        },
      },
    });
    const step = beginStep(f.db, { task_id: task.id, run_epoch: 0, kind: "tool", tool: "t", subject_key: "k1", side_effect: "safe", tier: 1 });
    const art = putArtifact(f.db, "hello world");
    endStep(f.db, step.id, { status: "succeeded", result_ref: art.hash });

    const report = checkContract(f.db, task.id);
    // 修复前：bad 也进分母 → hardSatisfaction = 0.5
    // 修复后：bad 标 configError 跳过 → 只算 ok → hardSatisfaction = 1
    assert.equal(report!.hardSatisfaction, 1);
    assert.equal(report!.constraints[0].configError, true);
    // nextDeliverable 不会对 configError 的约束返回 fix_constraint（不死循环）
    const next = nextDeliverable(f.db, task.id);
    assert.notEqual(next!.action, "fix_constraint");
  } finally {
    f.cleanup();
  }
});

test("回归：失败步骤的 error 文本不误满足 contains/exists", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1, goal: "",
          constraints: [
            { id: "c1", description: "包含 secret.txt", check: "contains", value: "secret.txt", severity: "hard" },
            { id: "e1", description: "存在 /data/file", check: "exists", path: "/data/file", severity: "hard" },
          ],
          deliverables: [],
        },
      },
    });
    // 失败步骤：error 文本提到 secret.txt 和 /data/file
    const step = beginStep(f.db, { task_id: task.id, run_epoch: 0, kind: "tool", tool: "files", subject_key: "k1", side_effect: "safe", tier: 1 });
    endStep(f.db, step.id, { status: "failed", error: "没找到 secret.txt，也不见 /data/file" });

    const report = checkContract(f.db, task.id);
    // 修复前：error 文本含 secret.txt → contains 判 true；含 /data/file → exists 判 true
    // 修复后：error 文本不进约束判定文本池 → 都判 false
    assert.equal(report!.constraints[0].satisfied, false);
    assert.equal(report!.constraints[1].satisfied, false);
  } finally {
    f.cleanup();
  }
});

test("回归：失败步骤不算完成交付物", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1, goal: "",
          constraints: [],
          deliverables: [
            { id: "d1", description: "写文件", type: "step", tool: "practice", done_when: "有 practice 步骤" },
          ],
        },
      },
    });
    // 失败步骤
    const step = beginStep(f.db, { task_id: task.id, run_epoch: 0, kind: "tool", tool: "practice", subject_key: "k1", side_effect: "safe", tier: 1 });
    endStep(f.db, step.id, { status: "failed", error: "没权限" });

    const report = checkContract(f.db, task.id);
    // 修复前：steps.find 不看 status → 失败也算完成
    // 修复后：只认 status === "succeeded" → 不算完成
    assert.equal(report!.deliveryCompletion, 0);
    assert.deepEqual(report!.outstanding, ["d1"]);
  } finally {
    f.cleanup();
  }
});

test("回归：milestone_seq 按当前里程碑圈定交付物范围", () => {
  const f = fixture();
  try {
    const task = createTask(f.db, {
      intent: "test", source: "test",
      state: "running",
      declared: {
        contract: {
          version: 1, goal: "",
          constraints: [],
          deliverables: [
            { id: "d1", description: "第一段产出", type: "text", done_when: "有文本", milestone_seq: 1 },
            { id: "d2", description: "第二段产出", type: "text", done_when: "有文本", milestone_seq: 2 },
          ],
        },
      },
    });
    // 没有里程碑（milestone_id = null）→ 全部在范围内
    let report = checkContract(f.db, task.id);
    assert.equal(report!.outstanding.length, 2);

    // 建里程碑，把任务推到 seq=1
    f.db.prepare("INSERT INTO milestones (id, task_id, seq, title, done_when, summary, state, created_at, ended_at) VALUES ('ms1', ?, 1, 'm1', 'd', NULL, 'active', datetime('now'), NULL)").run(task.id);
    f.db.prepare("UPDATE tasks SET milestone_id = 'ms1' WHERE id = ?").run(task.id);

    report = checkContract(f.db, task.id);
    // milestone_seq=2 的 d2 超出范围，只剩 d1
    assert.equal(report!.outstanding.length, 1);
    assert.deepEqual(report!.outstanding, ["d1"]);
  } finally {
    f.cleanup();
  }
});
