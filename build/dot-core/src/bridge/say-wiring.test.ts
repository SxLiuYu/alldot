/**
 * src/bridge/say-wiring.test.ts —— 说人话改写「接进去」的验收（第 3 步 C）。
 *
 * 单元测试在 src/say/say.test.ts；这里只钉接线：
 * - /status 的 card 字段在注入 say 时被改写，不注入时与账本模板卡逐字一致；
 * - 请示卡只改「给人看的部分」，给总管的 brain_answer 指令逐字保留。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTask, migrate, openLedger, readTaskView, renderProgressCard } from "../ledger/index.ts";
import { BRIDGE_ROUTE_BASE, createBridgeRouteHandler, createBridgeService } from "./index.ts";
import { createSayRewriter } from "../say/index.ts";
import { makeFixture, startFakeBrain, startFakeDsBot } from "./test-fixtures.ts";

const TOKEN = "say-wiring-token-0123456789";
const GATEWAY_TOKEN = "say-wiring-gateway-token";

async function startRoutes(say?: (text: string) => Promise<string>): Promise<{
  db: ReturnType<typeof openLedger>;
  dir: string;
  taskId: string;
  url: string;
  close: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "dot-say-routes-"));
  const db = openLedger(join(dir, "dot.db"));
  migrate(db);
  const task = createTask(db, {
    intent: "把桌面截图按月份归档，共 12 张",
    declared: { scope: ["C:/Users/1/Desktop/截图"] },
    source: "dsbot",
  });
  const handler = createBridgeRouteHandler({
    db,
    token: TOKEN,
    keepPath: join(dir, "keep.json"),
    ...(say === undefined ? {} : { say }),
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not_mine" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  return {
    db,
    dir,
    taskId: task.id,
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      try {
        db.close();
      } catch {
        // 已经关了就算了。
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function statusCard(url: string, taskId: string): Promise<Record<string, any>> {
  const res = await fetch(`${url}${BRIDGE_ROUTE_BASE}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ task_id: taskId }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, any>;
}

/**
 * 走真的 rewrite + fidelityIssues，不是绕过防线的桩：
 * 从提示词里取出原文，原样加一个前缀返回——数字/路径/编号都保留，必然通过校验。
 */
function prefixedRewriter(prefix: string): { say: (text: string) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  const say = createSayRewriter({
    enabled: true,
    complete: async (prompt) => {
      calls.push(prompt);
      const m = /原文：\n---\n([\s\S]*?)\n---\n\n改写后：/.exec(prompt);
      assert.ok(m !== null, "提示词里应带原文");
      return `${prefix}${m[1] ?? ""}`;
    },
  });
  return { say, calls };
}

test("/status：注入 say 时 card 被改写，task.card 与 cards 同步", async () => {
  const model = prefixedRewriter("说明：");
  const h = await startRoutes(model.say);
  try {
    const json = await statusCard(h.url, h.taskId);
    const expected = `说明：${renderProgressCard(readTaskView(h.db, h.taskId))}`;
    assert.equal(json.card, expected);
    assert.equal(json.task.card, expected);
    assert.ok(json.cards.includes(expected));
    assert.equal(model.calls.length, 2, "列表一次 + 指定 task_id 一次，各改写一次");
  } finally {
    await h.close();
  }
});

test("/status：不注入 say 时 card 与账本模板卡逐字一致（开关关不改字节）", async () => {
  const h = await startRoutes();
  try {
    const json = await statusCard(h.url, h.taskId);
    const expected = renderProgressCard(readTaskView(h.db, h.taskId));
    assert.equal(json.card, expected);
    assert.equal(json.task.card, expected);
  } finally {
    await h.close();
  }
});

test("请示卡：只改写给人看的部分，brain_answer 指令逐字保留", async () => {
  const fx = makeFixture();
  const brain = await startFakeBrain();
  const dsbot = await startFakeDsBot();
  const model = prefixedRewriter("说明：");
  const service = createBridgeService({
    port: 0,
    pathOptions: { dotDir: fx.dotDir },
    gatewayToken: GATEWAY_TOKEN,
    upstreamBaseUrl: brain.url,
    dsBotBaseUrl: dsbot.url,
    say: model.say,
  });
  try {
    const { url } = await service.start();
    const res = await fetch(`${url}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fx.token as string}` },
      body: JSON.stringify({ approval_id: fx.seeded.approvalId }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, any>;
    assert.ok(json.text.startsWith("说明："), "表头/问题/选项应被改写");
    assert.ok(json.text.includes("同意把 12 张截图移到月份文件夹？"), "问题原文要保留");
    assert.ok(json.text.includes("1) 同意"), "选项原文要保留");
    assert.ok(json.text.includes("brain_answer(approval_id="), "给总管的指令必须逐字保留");
    assert.equal(model.calls.length, 1);
    assert.ok(!model.calls[0]?.includes("brain_answer("), "模型只看得到给人看的部分");
    const call = dsbot.calls[0];
    assert.equal(String((call?.body as Record<string, any>).params.arguments.text), json.text);
  } finally {
    await service.stop();
    await dsbot.close();
    await brain.close();
    fx.cleanup();
  }
});
