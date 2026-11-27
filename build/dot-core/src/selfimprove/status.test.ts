/**
 * src/selfimprove/status.test.ts —— 状态查询的验收（只读，不改账本）。
 *
 * 三条：空账本 total=0；插一条 self_apply_skipped 后数得到它；
 * recent 最多 10 条且按 seq 倒序（不掺别的 type）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { appendEvent, migrate } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";
import { readSelfImproveStatus, RECENT_LIMIT } from "./status.ts";

test("一条 self_ 事件都没有：total=0、byType 空、recent 空", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    // 没有 self_ 前缀的事件不该被数进来。
    appendEvent(t.db, { type: "recovery_report", payload: { ok: true } });
    appendEvent(t.db, { type: "drift_verdict", payload: { verdict: "on_track" } });

    const status = readSelfImproveStatus(t.db);
    assert.equal(status.total, 0);
    assert.deepEqual(status.byType, {});
    assert.deepEqual(status.recent, []);
  } finally {
    t.cleanup();
  }
});

test("插一条 self_apply_skipped：total=1，byType 里有它", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    appendEvent(t.db, {
      type: "self_apply_skipped",
      payload: { proposal_id: "prop_status_test", reason: "开关关着" },
    });

    const status = readSelfImproveStatus(t.db);
    assert.equal(status.total, 1);
    assert.equal(status.byType["self_apply_skipped"], 1);
    assert.equal(status.recent.length, 1);
    const line = status.recent[0];
    assert.equal(line?.type, "self_apply_skipped");
    assert.equal(typeof line?.seq, "number");
    assert.equal(typeof line?.at, "string");
    assert.equal(line?.summary, "开关关着");
  } finally {
    t.cleanup();
  }
});

test("recent 最多 10 条，按 seq 倒序", () => {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const types = ["self_proposal", "self_apply_skipped", "self_apply_passed"];
    const seqs: number[] = [];
    // 15 条 self_ 事件 + 几条别的 type 穿插，确认既不超 10 条也不掺别的。
    for (let i = 0; i < 15; i += 1) {
      const type = types[i % types.length] as string;
      const appended = appendEvent(t.db, { type, payload: { idx: i } });
      seqs.push(appended.seq);
      if (i === 7) appendEvent(t.db, { type: "task_started", payload: { idx: i } });
    }
    appendEvent(t.db, { type: "user_feedback", payload: { verdict: "ok" } });

    const status = readSelfImproveStatus(t.db);
    assert.equal(status.total, 15);
    assert.equal(status.byType["self_proposal"], 5);
    assert.equal(status.byType["self_apply_skipped"], 5);
    assert.equal(status.byType["self_apply_passed"], 5);
    assert.equal(status.byType["task_started"], undefined);

    assert.equal(RECENT_LIMIT, 10);
    assert.equal(status.recent.length, RECENT_LIMIT);

    const gotSeqs = status.recent.map((line) => line.seq);
    const wantSeqs = seqs.slice(-RECENT_LIMIT).reverse();
    assert.deepEqual(gotSeqs, wantSeqs);
    for (let i = 1; i < gotSeqs.length; i += 1) {
      assert.ok(gotSeqs[i - 1]! > gotSeqs[i]!, "recent 必须严格从新到旧");
    }
    for (const line of status.recent) {
      assert.ok(line.type.startsWith("self_"), `recent 里不该有别的 type：${line.type}`);
    }
  } finally {
    t.cleanup();
  }
});
