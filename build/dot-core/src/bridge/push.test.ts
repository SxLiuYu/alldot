/**
 * push.ts 的测试：只测两件真会出错的事——飞书返回什么算成功、账本打不开时不许崩。
 * 轮询循环的时序（启动只登记、失败重试）由 startPushLoop 的实现保证，不在这里重测。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createFeishuWebhookSender, pickPushEvents } from "./push.ts";

test("飞书 webhook：code=0 算成功", async () => {
  const calls: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push(`${url}|${String(init.body)}`);
    return new Response('{"code":0,"msg":"success"}', { status: 200 });
  }) as unknown as typeof fetch;
  const send = createFeishuWebhookSender("https://example.com/hook", fake);
  const r = await send("要你批一下");
  assert.equal(r.ok, true);
  assert.match(calls[0] ?? "", /msg_type/);
});

test("飞书 webhook：非 0 code 与网络错都算失败，并把原因带出来", async () => {
  const bad = (async () =>
    new Response('{"code":19021,"msg":"sign match fail"}', { status: 200 })) as unknown as typeof fetch;
  const r1 = await createFeishuWebhookSender("https://example.com/hook", bad)("x");
  assert.equal(r1.ok, false);
  assert.match(r1.detail, /19021/);

  const boom = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r2 = await createFeishuWebhookSender("https://example.com/hook", boom)("x");
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /ECONNREFUSED/);
});

test("pickPushEvents：账本不存在时返回空数组，不抛", () => {
  const out = pickPushEvents("C:/tmp/definitely-not-here/ledger.db", new Date());
  assert.deepEqual(out, []);
});
