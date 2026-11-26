/**
 * src/bridge/test-fixtures.ts —— 桥测试的夹具（不是 .test 文件，不会被 run-tests 直接执行）。
 *
 * 第一轮测试写在 bridge.test.ts 里；第二轮的补测（两 token、通知转发、keep 真实形状、
 * 413、artifact 分类、顶部恢复报告）共用这一份，避免两套假大脑各写一遍。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEvent,
  createApproval,
  createTask,
  migrate,
  openLedger,
  putArtifact,
} from "../ledger/index.ts";

export interface Seeded {
  ledgerPath: string;
  taskId: string;
  approvalId: string;
  artifactHash: string;
}

export interface Fixture {
  dir: string;
  dotDir: string;
  token: string | null;
  seeded: Seeded;
  cleanup: () => void;
}

export function seedLedger(dotDir: string): Seeded {
  mkdirSync(join(dotDir, "ledger"), { recursive: true });
  const ledgerPath = join(dotDir, "ledger", "dot.db");
  const db = openLedger(ledgerPath);
  migrate(db);
  const task = createTask(db, {
    intent: "把桌面截图按月份归档",
    declared: { scope: ["C:/Users/1/Desktop/截图"] },
    source: "dsbot",
    state: "awaiting_approval",
    restated: "把桌面上「截图」文件夹里的图，按文件名里的月份分到子文件夹",
  });
  const { approval } = createApproval(db, {
    task_id: task.id,
    tier: 4,
    title: "要动桌面上的文件",
    detail: { question: "同意把 12 张截图移到月份文件夹？", options: ["同意", "拒绝"] },
    subject_key: "subj-bridge-test",
  });
  const artifact = putArtifact(db, "明细第一行\n明细第二行");
  appendEvent(db, {
    type: "recovery_report",
    payload: {
      headline: "恢复完成：1 个孤儿步转人工",
      startedAt: "2026-11-24T10:00:00.000Z",
      finishedAt: "2026-11-24T10:00:02.000Z",
    },
  });
  db.close();
  return {
    ledgerPath,
    taskId: task.id,
    approvalId: approval.id,
    artifactHash: artifact.hash,
  };
}

export function makeFixture(opts: { token?: string | null; diskFreeMb?: number } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "dot-bridge-extra-"));
  const dotDir = join(dir, "dot");
  const token = opts.token === undefined ? "test-bridge-token-0123456789" : opts.token;
  if (token !== null) {
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "bridge-token"), `${token}\n`, "utf8");
  }
  const seeded = seedLedger(dotDir);
  if (opts.diskFreeMb !== undefined) {
    mkdirSync(join(dotDir, "state"), { recursive: true });
    writeFileSync(
      join(dotDir, "state", "keep.json"),
      JSON.stringify({ disk: { free_mb: opts.diskFreeMb, state: "green" } }),
      "utf8",
    );
  }
  return {
    dir,
    dotDir,
    token,
    seeded,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface BrainCall {
  method: string;
  path: string;
  auth: string | null;
  bridgeToken: string | null;
  body: Record<string, unknown>;
}

export interface FakeBrain {
  url: string;
  calls: BrainCall[];
  close: () => Promise<void>;
}

export const FAKE_CARD = "【任务 task_fake】整理截图\n状态：执行中（第 1 个里程碑，共 2 个）\n卡在谁：没人";

export async function startFakeBrain(opts: { statusRoute?: "ok" | "404" | "401" } = {}): Promise<FakeBrain> {
  const calls: BrainCall[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      body = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      body = {};
    }
    const path = req.url ?? "/";
    calls.push({
      method: req.method ?? "",
      path,
      auth: req.headers.authorization ?? null,
      bridgeToken: (req.headers["x-dot-bridge-token"] as string | undefined) ?? null,
      body,
    });
    const reply = (status: number, value: unknown): void => {
      const payload = JSON.stringify(value);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) });
      res.end(payload);
    };
    if (path === "/dot/bridge/v1/status") {
      if (opts.statusRoute === "404") {
        reply(404, { ok: false, error: "unknown_route", message: "没有这个桥路由：POST /status" });
        return;
      }
      if (opts.statusRoute === "401") {
        reply(401, { ok: false, error: "unauthorized", message: "桥 token 不对" });
        return;
      }
      reply(200, { ok: true, tasks: [], cards: [], approvals: [], recovery: null });
      return;
    }
    reply(404, { ok: false, error: "unknown_route", message: path });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr !== "object") throw new Error("fake brain 没拿到端口");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface DsBotCall {
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}

export interface FakeDsBotOptions {
  /**
   * 按 mcp-server.js:44-51 校验 send_to_bot 的 bot 必填，按 :268-276 把
   * 工具异常包成 HTTP 200 + result.isError（默认 true）。
   * 关掉它只为老用例构造「恒成功」的假上游；新用例一律用默认。
   */
  realContract?: boolean;
  /** 让某一次 tools/call 直接回非 2xx，模拟 8797 的 HTTP 400。 */
  httpStatus?: number;
  httpBody?: unknown;
}

/**
 * 假 8797。默认按真实契约：send_to_bot 缺 bot → HTTP 200 的
 * `{result:{isError:true,content:[{type:'text',text:'No Bot "" for this client. Call list_bots.'}]}}`，
 * 带 bot → HTTP 200 的正常 result。`httpStatus` 给定时直接回指定的 HTTP 码。
 */
export async function startFakeDsBot(opts: FakeDsBotOptions = {}): Promise<{ url: string; calls: DsBotCall[]; close: () => Promise<void> }> {
  const calls: DsBotCall[] = [];
  const realContract = opts.realContract !== false;
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      body = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      body = {};
    }
    calls.push({ path: req.url ?? "", auth: req.headers.authorization ?? null, body });
    const reply = (status: number, value: unknown): void => {
      const payload = JSON.stringify(value);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) });
      res.end(payload);
    };
    if (opts.httpStatus !== undefined) {
      reply(opts.httpStatus, opts.httpBody ?? { error: "fake 8797 error" });
      return;
    }
    const params = body.params as Record<string, unknown> | undefined;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    let value: unknown;
    if (realContract && params?.name === "send_to_bot" && !String(args.bot ?? "").trim()) {
      // mcp-server.js:116-122 throw，被 :268-276 包成 HTTP 200 的 result.isError。
      value = {
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: 'No Bot "" for this client. Call list_bots.' }],
        },
      };
    } else {
      value = {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "sent" }], structuredContent: { sent: true } },
      };
    }
    reply(200, value);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr !== "object") throw new Error("fake ds-bot 没拿到端口");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
