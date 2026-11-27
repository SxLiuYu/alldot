/**
 * src/reply/reply.test.ts —— 只回答通道（brain_reply 的大脑一侧）的验收。
 *
 * 覆盖：
 * - 成功：返回原文；spend_ledger 一行（task_id NULL、worker_id='bridge-reply'）；
 *   events 有 spend_recorded(task_id NULL) 与 reply_answered，且没有第二个事件名；
 * - 五类 ModelPoolError 的码/状态/文案逐字；
 * - 空正文与「只有 tool_calls」→ model_empty，且不记账；
 * - 超 max_chars → truncated 且不超上限；调模型时 tools=[]；提示词含两句规矩；
 * - model_timeout 文案里的秒数由 REPLY_TIMEOUT_MS 派生（55 秒）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createReplyService,
  replyErrorMessage,
  REPLY_TIMEOUT_MS,
  REPLY_SYSTEM_PROMPT,
} from "./index.ts";
import { ModelPoolError, type ModelComplete, type ModelTurn } from "../dispatch/local-worker.ts";
import { migrate, openLedger, type LedgerDb } from "../ledger/index.ts";

function makeDb(): LedgerDb {
  const db = openLedger(":memory:");
  migrate(db);
  return db;
}

function count(db: LedgerDb, table: "spend_ledger" | "events"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
  return Number(row.n ?? 0);
}

interface Capture {
  calls: Array<{ messages: Array<{ role: string; content: string }>; tools: unknown[] }>;
  complete: ModelComplete;
}

function fakeComplete(impl: () => Promise<ModelTurn>): Capture {
  const calls: Capture["calls"] = [];
  const complete: ModelComplete = async (input) => {
    calls.push(input as unknown as Capture["calls"][number]);
    return impl();
  };
  return { calls, complete };
}

test("成功：回原文、只会话一次、tools 为空；spend_ledger 一行 task_id NULL；events 两条", async () => {
  const db = makeDb();
  const cap = fakeComplete(async () => ({
    text: " 这是回答正文。 ",
    toolCalls: [],
    usage: { input_tokens: 12, output_tokens: 34 },
  }));
  const reply = createReplyService({ db, complete: cap.complete });
  const out = await reply({ intent: "今天几号", maxChars: 500, via: "mcp" });
  assert.equal(out.ok, true);
  if (!out.ok) throw new Error("unreachable");
  assert.equal(out.reply, "这是回答正文。");
  assert.equal(out.model, "deepseek-v4.1-flash");
  assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 34 });
  assert.equal(out.truncated, false);
  assert.equal(typeof out.spend_id, "string");
  assert.equal(typeof out.event_seq, "number");
  assert.equal(cap.calls.length, 1);
  assert.deepEqual(cap.calls[0]?.tools, [], "只回答通道调模型时 tools 必须是空数组");

  const spend = db.prepare("SELECT * FROM spend_ledger").all() as Array<Record<string, unknown>>;
  assert.equal(spend.length, 1);
  assert.equal(spend[0]?.task_id, null, "只回答通道的 spend 不挂任务");
  assert.equal(spend[0]?.worker_id, "bridge-reply");
  assert.equal(spend[0]?.model, "deepseek-v4.1-flash");
  assert.equal(spend[0]?.input_tokens, 12);
  assert.equal(spend[0]?.output_tokens, 34);

  const events = db.prepare("SELECT type, task_id, payload_json FROM events ORDER BY seq ASC").all() as Array<{
    type: string;
    task_id: string | null;
    payload_json: string;
  }>;
  assert.deepEqual(
    events.map((e) => e.type),
    ["spend_recorded", "reply_answered"],
    "只应有这两个事件名，不多写",
  );
  for (const e of events) assert.equal(e.task_id, null);
  const answered = JSON.parse(events[1]!.payload_json) as Record<string, unknown>;
  assert.equal(answered.via, "mcp");
  assert.equal(answered.chars, "这是回答正文。".length);
  assert.equal(answered.truncated, false);
  assert.equal(typeof answered.intent_sha256, "string");
  assert.equal((answered.intent_sha256 as string).length, 64, "只存 intent 的 sha256，不落原话");
  assert.equal(answered.usage_missing, false);
});

test("五类 ModelPoolError 的码/状态/文案逐字（失败不记账）", async () => {
  const cases: Array<{
    kind: "config" | "unreachable" | "http" | "invalid" | "timeout";
    err: ModelPoolError;
    code: string;
    status: number;
    message: string;
  }> = [
    {
      kind: "config",
      err: new ModelPoolError("config", "配置坏了"),
      code: "model_unavailable",
      status: 503,
      message: "回答不了：模型池现在连不上（配置坏了）。这次没记账，等它起来再问。",
    },
    {
      kind: "unreachable",
      err: new ModelPoolError("unreachable", "connection refused"),
      code: "model_unavailable",
      status: 503,
      message: "回答不了：模型池现在连不上（connection refused）。这次没记账，等它起来再问。",
    },
    {
      kind: "http",
      err: new ModelPoolError("http", "模型池回了 429：rate limited", 429),
      code: "model_failed",
      status: 502,
      message: "回答不了：模型池回了 HTTP 429（rate limited）。",
    },
    {
      kind: "invalid",
      err: new ModelPoolError("invalid", "Unexpected token"),
      code: "model_invalid",
      status: 502,
      message: "回答不了：模型池回的内容读不懂，再试一次。",
    },
    {
      kind: "timeout",
      err: new ModelPoolError("timeout", "aborted"),
      code: "model_timeout",
      status: 504,
      message: `回答不了：模型 ${Math.round(REPLY_TIMEOUT_MS / 1000)} 秒没答完。`,
    },
  ];

  for (const c of cases) {
    const db = makeDb();
    const cap = fakeComplete(async () => {
      throw c.err;
    });
    const reply = createReplyService({ db, complete: cap.complete });
    const out = await reply({ intent: "随便问问", maxChars: 500, via: "dot-bridge" });
    assert.equal(out.ok, false, `${c.kind} 应当是失败`);
    if (out.ok) throw new Error("unreachable");
    assert.equal(out.error, c.code, `${c.kind} 的码`);
    assert.equal(out.status, c.status, `${c.kind} 的状态`);
    assert.equal(out.message, c.message, `${c.kind} 的文案要逐字`);
    assert.equal(count(db, "spend_ledger"), 0, `${c.kind} 失败不写 spend`);
    assert.equal(count(db, "events"), 0, `${c.kind} 失败不写事件`);
  }
});

test("空正文与「只有 tool_calls」→ model_empty，且不记账", async () => {
  const empties: ModelTurn[] = [
    { text: "", toolCalls: [], usage: { input_tokens: 5, output_tokens: 0 } },
    {
      text: "   ",
      toolCalls: [{ id: "call_1", name: "whatever", arguments: "{}" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  ];
  for (const turn of empties) {
    const db = makeDb();
    const cap = fakeComplete(async () => turn);
    const reply = createReplyService({ db, complete: cap.complete });
    const out = await reply({ intent: "问一句", maxChars: 500, via: "mcp" });
    assert.equal(out.ok, false);
    if (out.ok) throw new Error("unreachable");
    assert.equal(out.error, "model_empty");
    assert.equal(out.status, 502);
    assert.equal(out.message, "回答不了：模型只思考没出正文，换个问法或稍后再试。");
    assert.equal(count(db, "spend_ledger"), 0);
    assert.equal(count(db, "events"), 0);
  }
});

test("超 max_chars → truncated=true 且不超上限；提示词含两句规矩", async () => {
  const db = makeDb();
  const long = "字".repeat(100);
  const cap = fakeComplete(async () => ({ text: long, toolCalls: [], usage: { input_tokens: 1, output_tokens: 100 } }));
  const reply = createReplyService({ db, complete: cap.complete });
  const out = await reply({ intent: "讲长点", maxChars: 40, via: "mcp" });
  assert.equal(out.ok, true);
  if (!out.ok) throw new Error("unreachable");
  assert.equal(out.truncated, true);
  assert.equal(out.reply.length, 40, "截断后不得超过上限");
  assert.equal(out.reply, "字".repeat(40));

  const system = cap.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
  assert.ok(system.includes("不要建任务"));
  assert.ok(system.includes("不知道就说不知道"));
  assert.ok(REPLY_SYSTEM_PROMPT.includes("不要建任务"));

  const events = db.prepare("SELECT payload_json FROM events WHERE type = 'reply_answered'").all() as Array<{
    payload_json: string;
  }>;
  assert.equal((JSON.parse(events[0]!.payload_json) as { truncated: boolean }).truncated, true);
});

test("replyErrorMessage 的 route 校验码逐字（C 表）", () => {
  assert.equal(replyErrorMessage("bad_intent"), "回答不了：intent 必填，且要是 ≤2000 字的非空字符串。");
  assert.equal(replyErrorMessage("bad_context"), "回答不了：context 要是 ≤4000 字的字符串。");
  assert.equal(replyErrorMessage("bad_max_chars"), "回答不了：max_chars 要是 40..2000 的整数。");
  assert.equal(replyErrorMessage("bad_via"), "回答不了：via 只能是 1..32 位小写字母/数字/下划线/连字符。");
  assert.equal(replyErrorMessage("reply_not_wired"), "回答不了：dot-core 没接模型，这条通道用不了。");
});
