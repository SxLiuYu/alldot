/**
 * src/selfimprove/selfimprove.test.ts —— 提案层的验收。
 *
 * 要钉住的五件事：
 * 1. 开关关着 / 没给配置 / 没模型 / 模型抛错 → 空数组 + 原因进事件，绝不编提案；
 * 2. 模型回的不是 JSON 或字段不合格 → 丢弃，不硬凑；
 * 3. 通过的提案只进账本：artifacts 有正文、events 有索引、approvals 有 kind=question 的请示卡；
 * 4. 提案层不写任何文件（pending 目录不出现）；
 * 5. 每日上限按 UTC 日期生效，超了连模型都不问。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { getArtifact, listApprovals, migrate } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";
import {
  buildProposePrompt,
  parseProposalJson,
  pendingPatchPath,
  proposeImprovements,
  proposeImprovementsWithReason,
  proposalsToday,
  utcDay,
} from "./index.ts";
import type { Proposal, SelfImproveConfigSlice } from "./types.ts";

function cfg(over: { enabled?: boolean; max?: number } = {}): SelfImproveConfigSlice {
  return { self_improve: { enabled: over.enabled ?? true, max_proposals_per_day: over.max ?? 2 } };
}

const METRICS = {
  tasksDone: 3,
  tasksFailed: 2,
  doneRate: 0.6,
  avgSteps: 4.5,
  spinStops: 1,
  snapshotFailures: 1,
  approvalsPending: 0,
  modelErrors: 0,
  topFailureReasons: [{ reason: "快照失败", count: 1 }],
};

const SAMPLES = [{ taskId: "task_a", reason: "snapshot_failed: 目标不存在", detail: "第 2 档动作" }];

function okModel(proposals: unknown[]): (prompt: string) => Promise<string> {
  return async () => JSON.stringify({ proposals });
}

const GOOD = {
  kind: "code",
  target: "build/dot-core/src/selfeval/index.ts",
  why: "快照失败集中在不存在的目标上",
  evidence: "snapshotFailures=1",
  proposedChange: "在快照前先判存在，缺文件时直接记 absent",
  risk: "低：只改判定顺序",
  expectedGain: "少一次失败步",
};

function eventsOf(db: ReturnType<typeof makeTempDb>["db"], type: string) {
  return db.prepare("SELECT * FROM events WHERE type = ? ORDER BY seq ASC").all(type) as Array<{
    payload_json: string;
  }>;
}

test("开关关着：不调模型、返回空数组、原因进事件", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    let called = 0;
    const proposals = await proposeImprovements({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      config: cfg({ enabled: false }),
      complete: async () => {
        called += 1;
        return JSON.stringify({ proposals: [GOOD] });
      },
    });
    assert.deepEqual(proposals, []);
    assert.equal(called, 0, "关着时一次模型都不许调");
    const skipped = eventsOf(t.db, "self_proposal_skipped");
    assert.equal(skipped.length, 1);
    assert.match(String(JSON.parse(skipped[0]?.payload_json ?? "{}").reason), /开关/);
    assert.equal(eventsOf(t.db, "self_proposal").length, 0);
    assert.equal(listApprovals(t.db).length, 0, "不该出请示卡");
  } finally {
    t.cleanup();
  }
});

test("没给配置也当关着（fail-closed）", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const out = await proposeImprovementsWithReason({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      complete: async () => JSON.stringify({ proposals: [GOOD] }),
    });
    assert.deepEqual(out.proposals, []);
    assert.equal(out.skipped, true);
    assert.match(String(out.reason), /开关/);
    assert.equal(eventsOf(t.db, "self_proposal").length, 0);
  } finally {
    t.cleanup();
  }
});

test("没注入模型（没配 key）：空数组 + 原因；模型抛错：空数组 + 原因", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const noModel = await proposeImprovementsWithReason({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      config: cfg(),
    });
    assert.deepEqual(noModel.proposals, []);
    assert.match(String(noModel.reason), /没有注入模型/);

    const boom = await proposeImprovementsWithReason({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      config: cfg(),
      complete: async () => {
        throw new Error("模型池回了 502");
      },
    });
    assert.deepEqual(boom.proposals, []);
    assert.match(String(boom.reason), /模型调用失败.*502/);

    const skipped = eventsOf(t.db, "self_proposal_skipped").map(
      (e) => JSON.parse(e.payload_json) as { reason: string },
    );
    assert.equal(skipped.length, 2);
    assert.ok(skipped.every((s) => typeof s.reason === "string" && s.reason !== ""));
    assert.equal(eventsOf(t.db, "self_proposal").length, 0);
  } finally {
    t.cleanup();
  }
});

test("模型回非 JSON / 空文本：空数组，不编提案", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    for (const text of ["抱歉，我做不了这个判断", "   "]) {
      const out = await proposeImprovementsWithReason({
        db: t.db,
        metrics: METRICS,
        samples: SAMPLES,
        config: cfg(),
        complete: async () => text,
      });
      assert.deepEqual(out.proposals, []);
      assert.equal(out.skipped, true);
      assert.match(String(out.reason), /空文本|不是可解析的 JSON/);
    }
    assert.equal(eventsOf(t.db, "self_proposal").length, 0);
  } finally {
    t.cleanup();
  }
});

test("模型带围栏的 JSON 能解析；不合格的候选被丢掉", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const bad = { kind: "code", target: "x.ts", proposedChange: "改点什么" }; // 缺 why
    const raw = "```json\n" + JSON.stringify({ proposals: [GOOD, bad] }) + "\n```";
    assert.notEqual(parseProposalJson(raw), null);

    const proposals = await proposeImprovements({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      config: cfg(),
      complete: async () => raw,
    });
    assert.equal(proposals.length, 1, "缺 why 的那条不许凑数");
    assert.equal(proposals[0]?.target, GOOD.target);
  } finally {
    t.cleanup();
  }
});

test("提案只进账本：artifacts 有正文、events 有索引、请示卡 kind=question、不写文件", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const proposals = await proposeImprovements({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      config: cfg({ max: 3 }),
      complete: okModel([GOOD, { ...GOOD, kind: "config", target: "keepalive.disk.warn_gb" }]),
    });
    assert.equal(proposals.length, 2);

    const evs = eventsOf(t.db, "self_proposal");
    assert.equal(evs.length, 2);
    for (const ev of evs) {
      const payload = JSON.parse(ev.payload_json) as { proposal_id: string; artifact: string; kind: string };
      assert.ok(payload.proposal_id.startsWith("prop_"));
      const artifact = getArtifact(t.db, payload.artifact);
      assert.equal(artifact.found, true, "正文必须能在 artifacts 里查回");
      if (artifact.found) {
        const body = JSON.parse(artifact.content) as Proposal;
        assert.equal(body.id, payload.proposal_id);
        assert.ok(body.why !== "" && body.proposedChange !== "");
      }
    }

    const cards = listApprovals(t.db).filter((a) => a.kind === "question");
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.equal(card.kind, "question");
      assert.equal(card.status, "pending");
      assert.match(card.title, /^自我优化提案：/);
    }

    for (const proposal of proposals) {
      assert.equal(existsSync(pendingPatchPath(process.cwd(), proposal.id)), false, "提案层不许写补丁文件");
    }
  } finally {
    t.cleanup();
  }
});

test("每日上限：最多落 max 条；同日再跑直接跳过", async () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const at = new Date("2026-11-25T08:00:00.000Z");
    const proposals = await proposeImprovements({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      config: cfg({ max: 1 }),
      now: at,
      complete: okModel([GOOD, { ...GOOD, target: "build/dot-core/src/selfeval/top.ts", proposedChange: "另一处改动" }]),
    });
    assert.equal(proposals.length, 1, "上限 1 只许落 1 条");
    assert.equal(proposalsToday(t.db, at), 1);
    assert.equal(eventsOf(t.db, "self_proposal_capped").length, 1);

    const second = await proposeImprovementsWithReason({
      db: t.db,
      metrics: METRICS,
      samples: SAMPLES,
      config: cfg({ max: 1 }),
      now: at,
      complete: async () => {
        throw new Error("不该被调用：已经到上限了");
      },
    });
    assert.deepEqual(second.proposals, []);
    assert.match(String(second.reason), /上限/);
    assert.equal(proposalsToday(t.db, at), 1);
    assert.equal(utcDay(at), "2026-11-25");
  } finally {
    t.cleanup();
  }
});

test("提示词把三条底线写进去：只依据证据 / 不许碰红线 / 证据不足返回空", () => {
  const prompt = buildProposePrompt(METRICS, SAMPLES, 2);
  assert.match(prompt, /不许编事实/);
  assert.match(prompt, /红线/);
  assert.match(prompt, /空列表/);
  assert.match(prompt, /最多 2 条/);
  assert.match(prompt, /snapshot_failed: 目标不存在/);
});
