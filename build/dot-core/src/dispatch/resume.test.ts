/**
 * src/dispatch/resume.test.ts —— 审批决定之后任务回队列的接线验收。
 *
 * 为什么单独一个文件：`resumeAfterDecision` 的规则在 dispatch.test.ts 里测过，
 * 但真正调用它的是桥的决定路由（src/bridge/routes.ts 的 handleDecide）。
 * 只测函数不测接线，等于没证明「人点了同意，任务真会被重新派发」。
 *
 * 这里起一个真的 http 服务（桥接收侧），走 POST /dot/bridge/v1/approvals/<id>/decide。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTask, migrate, openLedger, type LedgerDb } from "../ledger/index.ts";
import { createApproval, createTask } from "../ledger/test-helpers.ts";
import { BRIDGE_ROUTE_BASE, createBridgeRouteHandler } from "../bridge/index.ts";

interface Harness {
  db: LedgerDb;
  taskId: string;
  approvalId: string;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dot-dispatch-resume-"));
  const db = openLedger(join(dir, "dot.db"));
  migrate(db);
  const taskId = createTask(db, { intent: "推一下远端", state: "awaiting_approval" });
  const approvalId = createApproval(db, { taskId });

  const handler = createBridgeRouteHandler({
    db,
    requireToken: false,
    admissionCheck: false,
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    db,
    taskId,
    approvalId,
    baseUrl: `http://127.0.0.1:${port}${BRIDGE_ROUTE_BASE}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        db.close();
      } catch {
        // 已经关了
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function decide(baseUrl: string, approvalId: string, answer: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/approvals/${approvalId}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  return (await res.json()) as Record<string, unknown>;
}

test("桥：人点「同意」→ 任务回 queued、epoch+1（下一轮派发会重试）", async () => {
  const h = await startHarness();
  try {
    const body = await decide(h.baseUrl, h.approvalId, "同意");
    assert.equal(body["ok"], true);
    assert.equal(body["changed"], true);
    const resume = body["resume"] as { action?: string; task_id?: string } | undefined;
    assert.equal(resume?.action, "requeued", JSON.stringify(body));

    const task = getTask(h.db, h.taskId);
    assert.equal(task?.state, "queued");
    assert.equal(task?.run_epoch, 1);
  } finally {
    await h.close();
  }
});

test("桥：人点「拒绝」→ 任务终止（不会再来一轮出同一张单）", async () => {
  const h = await startHarness();
  try {
    const body = await decide(h.baseUrl, h.approvalId, "拒绝");
    assert.equal(body["changed"], true);
    const resume = body["resume"] as { action?: string } | undefined;
    assert.equal(resume?.action, "cancelled", JSON.stringify(body));
    assert.equal(getTask(h.db, h.taskId)?.state, "cancelled");
  } finally {
    await h.close();
  }
});

test("桥：批单已经不是待决状态时按幂等处理，不重复重排", async () => {
  const h = await startHarness();
  try {
    await decide(h.baseUrl, h.approvalId, "同意");
    const again = await decide(h.baseUrl, h.approvalId, "同意");
    assert.equal(again["changed"], false);
    assert.equal((again["resume"] as unknown) ?? null, null, "幂等路径不该再带 resume");
    assert.equal(getTask(h.db, h.taskId)?.run_epoch, 1, "只 bump 一次");
  } finally {
    await h.close();
  }
});

test("还有一张已批未用的单：不挡重排（以前会死锁）", async () => {
  const h = await startHarness();
  try {
    // 同一任务上再挂一张「已批准」的单（模拟：create 批了还没执行，另一张被拒）
    const approvedId = createApproval(h.db, { taskId: h.taskId, status: "approved", subjectKey: "subj-approved-sibling" });
    const res = await fetch(`${h.baseUrl}/approvals/${h.approvalId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected", decided_by: "cli", note: "自检" }),
    });
    const json = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200);
    assert.equal(json.resume?.action, "cancelled", `实际 ${JSON.stringify(json.resume)}`);
    assert.equal(getTask(h.db, h.taskId)?.state, "cancelled");
    assert.notEqual(approvedId, "");
  } finally {
    await h.close();
  }
});
