/**
 * build/ui/server.mjs —— alldot 的界面服务（单文件，页面内联，可整体编进 exe）。
 *
 * 为什么是这个形状（2026-11-25 用户要求）：「做成 windows exe，用 html 做好页面，嵌入到 exe 里」。
 * 所以这一份文件必须满足三条硬约束：
 *   1. 只用 node 自带模块（http / sqlite / fs），不引任何第三方包 —— 才能用 Node SEA 打成单文件 exe；
 *   2. 页面（HTML/CSS/JS）是文件里的一个字符串，不从磁盘读 —— exe 里没有「旁边那堆 html」；
 *   3. 只读账本、写操作走网关已有的桥接口 —— 不去改正在被别的工作流修改的 build/dot-core。
 *
 * 数据来源分两路：
 *   读  → C:/Users/1/.allbot/dot/ledger/dot.db（只读打开；WAL 下可与网关并发读）
 *   写  → POST http://127.0.0.1:18789/dot/bridge/v1/...（下单 / 审批 / 取消）
 * 令牌都在本机用户目录里，前端永远拿不到（浏览器只跟本进程说话）。
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const VERSION = "0.1.0";
const HOME = process.env.USERPROFILE ?? "C:/Users/1";
const DOT_DIR = process.env.ALLDOT_DIR ?? `${HOME}/.allbot/dot`;
const LEDGER_PATH = process.env.ALLDOT_LEDGER ?? `${DOT_DIR}/ledger/dot.db`;
const ALLBOT_JSON = process.env.ALLDOT_ALLBOT ?? `${HOME}/.allbot/allbot.json`;
const GATEWAY = process.env.ALLDOT_GATEWAY ?? "http://127.0.0.1:18789";
const PORT = Number(process.env.ALLDOT_UI_PORT ?? 18790);

const STARTED_AT = Date.now();

/* ------------------------------------------------------------------ 账本（只读） */

let dbHandle = null;
let dbError = "";

function db() {
  if (dbHandle !== null) return dbHandle;
  dbHandle = new DatabaseSync(LEDGER_PATH, { readOnly: true });
  return dbHandle;
}

/** 读一次账本，失败时返回兜底值；WAL 下偶发 SQLITE_BUSY 就重试一次。 */
function query(sql, params = [], fallback = []) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return db().prepare(sql).all(...params);
    } catch (err) {
      dbError = String(err?.message ?? err);
      if (attempt === 1) return fallback;
    }
  }
  return fallback;
}

function one(sql, params = [], fallback = null) {
  const rows = query(sql, params, []);
  return rows.length > 0 ? rows[0] : fallback;
}

/* ------------------------------------------------------------------ 网关（写） */

function tokens() {
  const allbot = JSON.parse(readFileSync(ALLBOT_JSON, "utf8"));
  const gatewayToken = allbot?.gateway?.auth?.token ?? "";
  let bridgeToken = "";
  try {
    bridgeToken = readFileSync(`${DOT_DIR}/bridge-token`, "utf8").trim();
  } catch {
    bridgeToken = "";
  }
  return { gatewayToken, bridgeToken };
}

async function bridge(method, path, body) {
  let auth;
  try {
    auth = tokens();
  } catch (err) {
    return { status: 500, json: { ok: false, error: "no_credentials", message: `读不到本机令牌：${err?.message ?? err}` } };
  }
  try {
    const res = await fetch(`${GATEWAY}/dot/bridge/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.gatewayToken}`,
        "x-dot-bridge-token": auth.bridgeToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, error: "bad_gateway_body", message: text.slice(0, 400) };
    }
    return { status: res.status, json };
  } catch (err) {
    return {
      status: 502,
      json: {
        ok: false,
        error: "gateway_unreachable",
        message: `连不上网关 ${GATEWAY}（${err?.name ?? "error"}）。网关没起来时下单和审批都做不了；只读页面不受影响。`,
      },
    };
  }
}

/* ------------------------------------------------------------------ 组装数据 */

const STATE_LABEL = {
  queued: "排队中",
  running: "在跑",
  awaiting_approval: "等批准",
  paused: "暂停",
  done: "做完",
  failed: "失败",
  cancelled: "已取消",
};

function taskRow(row) {
  const steps = one("select count(*) c from steps where task_id = ?", [row.id], { c: 0 });
  const bad = one("select count(*) c from steps where task_id = ? and status in ('failed','interrupted')", [row.id], { c: 0 });
  return {
    id: row.id,
    intent: row.intent,
    state: row.state,
    stateLabel: STATE_LABEL[row.state] ?? row.state,
    stateReason: row.state_reason,
    profile: row.profile,
    spentTokens: row.spent_tokens,
    budgetTokens: row.budget_tokens,
    steps: steps.c,
    badSteps: bad.c,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function overview() {
  const counts = query("select state, count(*) c from tasks group by state", []).map((r) => ({
    state: r.state,
    label: STATE_LABEL[r.state] ?? r.state,
    count: r.c,
  }));
  const pendingApprovals = one("select count(*) c from approvals where status = 'pending'", [], { c: 0 });
  const today = new Date().toISOString().slice(0, 10);
  const spendToday = one(
    "select coalesce(sum(input_tokens + output_tokens), 0) t from spend_ledger where created_at >= ?",
    [today],
    { t: 0 },
  );
  const lastEvent = one("select ts, type from events order by seq desc limit 1", [], { ts: null, type: null });
  const recent = query(
    "select id, intent, state, state_reason, profile, spent_tokens, budget_tokens, created_at, updated_at from tasks order by created_at desc limit 6",
  ).map(taskRow);
  return {
    ok: true,
    version: VERSION,
    now: new Date().toISOString(),
    ledgerPath: LEDGER_PATH,
    ledgerError: dbError,
    counts,
    pendingApprovals: pendingApprovals.c,
    spendToday: today ? spendToday.t : 0,
    lastEvent,
    recent,
  };
}

function taskList(limit = 100) {
  return query(
    "select id, intent, state, state_reason, profile, spent_tokens, budget_tokens, created_at, updated_at from tasks order by created_at desc limit ?",
    [Math.min(Math.max(limit, 1), 300)],
  ).map(taskRow);
}

function taskDetail(id) {
  const task = one("select * from tasks where id = ?", [id]);
  if (task === null) return null;
  const steps = query(
    "select seq, tool, kind, tier, status, error, started_at, ended_at, run_epoch from steps where task_id = ? order by seq asc",
    [id],
  );
  const events = query(
    "select seq, ts, type, payload_json from events where task_id = ? order by seq desc limit 60",
    [id],
  );
  const approvals = query(
    "select id, kind, tier, title, status, detail_json, created_at, decided_at from approvals where task_id = ? order by created_at desc",
    [id],
  );
  const snapshots = query(
    "select id, kind, ref, created_at from snapshots where task_id = ? order by created_at desc limit 20",
    [id],
  );
  const milestones = query(
    "select seq, title, done_when, state, summary from milestones where task_id = ? order by seq asc",
    [id],
  );
  return {
    ok: true,
    task: taskRow(task),
    declared: task.declared_json,
    restated: task.restated,
    source: task.source,
    steps,
    events: events.map((e) => ({ ...e, payload: safeJson(e.payload_json) })),
    approvals: approvals.map((a) => ({ ...a, detail: safeJson(a.detail_json) })),
    snapshots,
    milestones,
  };
}

function safeJson(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 600) };
  }
}

function approvals() {
  const pending = query(
    "select id, task_id, kind, tier, title, detail_json, created_at from approvals where status = 'pending' order by created_at asc limit 50",
  ).map((a) => ({ ...a, detail: safeJson(a.detail_json) }));
  const recent = query(
    "select id, task_id, kind, title, status, decided_by, decided_at, decision_note from approvals where status != 'pending' order by coalesce(decided_at, created_at) desc limit 20",
  );
  return { ok: true, pending, recent };
}

/** 体检：失败分布、最常错的工具、token 花在哪个模型上、自我优化提案。 */
function health() {
  const stepStates = query("select status, count(*) c from steps group by status order by c desc");
  const taskStates = query("select state, count(*) c from tasks group by state order by c desc");
  const toolFails = query(
    "select tool, count(*) c from steps where status = 'failed' group by tool order by c desc limit 10",
  );
  const errors = query(
    "select tool, substr(coalesce(error,'(无详情)'), 1, 160) e, count(*) c from steps where status = 'failed' group by tool, e order by c desc limit 10",
  );
  const spend = query(
    "select model, count(*) runs, coalesce(sum(input_tokens),0) i, coalesce(sum(output_tokens),0) o from spend_ledger group by model order by (i+o) desc limit 10",
  );
  const proposals = query(
    "select seq, ts, payload_json from events where type in ('self_proposal','self_proposal_applied','self_proposal_rejected') order by seq desc limit 30",
  ).map((p) => ({ seq: p.seq, ts: p.ts, payload: safeJson(p.payload_json) }));
  const workers = query(
    "select status, count(*) c from workers group by status order by c desc",
  );
  return { ok: true, stepStates, taskStates, toolFails, errors, spend, proposals, workers };
}

/* ------------------------------------------------------------------ HTTP */

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求体太大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是 JSON");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  try {
    // 页面（从内存发，exe 里没有独立 html 文件）
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const body = Buffer.from(PAGE, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    if (req.method === "GET" && path === "/api/ping") {
      sendJson(res, 200, { ok: true, version: VERSION, uptimeMs: Date.now() - STARTED_AT, port: PORT });
      return;
    }

    if (req.method === "GET" && path === "/api/overview") {
      sendJson(res, 200, overview());
      return;
    }

    if (req.method === "GET" && path === "/api/tasks") {
      sendJson(res, 200, { ok: true, tasks: taskList(Number(url.searchParams.get("limit") ?? 100)) });
      return;
    }

    if (req.method === "GET" && path.startsWith("/api/tasks/")) {
      const id = decodeURIComponent(path.slice("/api/tasks/".length));
      const detail = taskDetail(id);
      if (detail === null) sendJson(res, 404, { ok: false, error: "task_not_found", message: `账本里没有 ${id}` });
      else sendJson(res, 200, detail);
      return;
    }

    if (req.method === "GET" && path === "/api/approvals") {
      sendJson(res, 200, approvals());
      return;
    }

    if (req.method === "GET" && path === "/api/health") {
      sendJson(res, 200, health());
      return;
    }

    // 这两个在 exe 里是宿主实现的；浏览器里开发时给个占位，免得页面报错
    if (req.method === "GET" && path === "/api/settings") {
      sendJson(res, 200, {
        ok: true,
        autoApprove: false,
        rule: "第 4 档以内自动同意（这个开关只在 exe 里生效，浏览器开发模式不写盘）",
      });
      return;
    }

    if (req.method === "POST" && path === "/api/settings") {
      await readBody(req);
      sendJson(res, 200, { ok: true, autoApprove: false, rule: "浏览器开发模式不保存这个开关" });
      return;
    }

    // 自动同意档位：真身是 dot-core 的 /settings（0=关，1..4），走桥
    if (req.method === "GET" && path === "/api/autoapprove") {
      const r = await bridge("GET", "/settings");
      sendJson(res, r.status, r.json);
      return;
    }

    if (req.method === "POST" && path === "/api/autoapprove") {
      const body = await readBody(req);
      const r = await bridge("POST", "/settings", body ?? {});
      sendJson(res, r.status, r.json);
      return;
    }

    if (req.method === "GET" && path === "/api/autolog") {
      sendJson(res, 200, { ok: true, autoApprove: false, lines: [] });
      return;
    }

    if (req.method === "GET" && path === "/api/self") {
      const rows = query(
        "select seq, ts, type, payload_json from events where type like 'self_%' order by seq desc limit 60",
      ).map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, payload: safeJson(r.payload_json) }));
      sendJson(res, 200, { ok: true, items: rows });
      return;
    }

    // 下单：原样转发给桥（拿的是本机令牌，前端看不到）
    if (req.method === "POST" && path === "/api/tasks") {
      const body = await readBody(req);
      const workspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
      const payload = {
        intent: String(body.intent ?? "").trim(),
        profile: body.profile ?? "balanced",
        ...(workspace === "" ? {} : { declared: { workspace } }),
      };
      if (payload.intent === "") {
        sendJson(res, 400, { ok: false, error: "bad_intent", message: "要做什么？先写一句话。" });
        return;
      }
      const out = await bridge("POST", "/tasks", payload);
      sendJson(res, out.status, out.json);
      return;
    }

    // 待部署补丁 + 部署（预览模式也走桥，逻辑只有一份）
    if (req.method === "GET" && path === "/api/patches") {
      const out = await bridge("GET", "/patches", null);
      sendJson(res, out.status, out.json);
      return;
    }
    if (req.method === "POST" && path === "/api/deploy") {
      const body = await readBody(req);
      const out = await bridge("POST", "/deploy", { patch_id: String(body.patch_id ?? "") });
      sendJson(res, out.status, out.json);
      return;
    }

    // 反馈：写一条 user_feedback 进账本（自我优化把它当证据）
    if (req.method === "POST" && path === "/api/feedback") {
      const body = await readBody(req);
      const taskId = typeof body.task_id === "string" ? body.task_id : "";
      const verdict = body.verdict === "good" ? "good" : body.verdict === "bad" ? "bad" : "";
      if (taskId === "" || verdict === "") {
        sendJson(res, 400, { ok: false, error: "bad_feedback", message: "反馈要带 task_id 和 verdict" });
        return;
      }
      const out = await bridge("POST", "/feedback", { task_id: taskId, verdict, note: String(body.note ?? "") });
      sendJson(res, out.status, out.json);
      return;
    }

    // 审批：同意 / 拒绝
    const decide = /^\/api\/approvals\/([^/]+)\/decide$/.exec(path);
    if (req.method === "POST" && decide !== null) {
      const id = decodeURIComponent(decide[1]);
      const body = await readBody(req);
      const decision = body.decision === "rejected" ? "rejected" : "approved";
      const out = await bridge("POST", `/approvals/${encodeURIComponent(id)}/decide`, { decision });
      sendJson(res, out.status, out.json);
      return;
    }

    const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (req.method === "POST" && cancel !== null) {
      const id = decodeURIComponent(cancel[1]);
      const out = await bridge("POST", `/tasks/${encodeURIComponent(id)}/cancel`, { reason: "cancelled_from_ui" });
      sendJson(res, out.status, out.json);
      return;
    }

    if (req.method === "POST" && path === "/api/shutdown") {
      sendJson(res, 200, { ok: true, message: "界面服务要关了" });
      setTimeout(() => process.exit(0), 120);
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found", message: `没有这个地址：${path}` });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: "ui_error", message: String(err?.message ?? err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // 打印一行给启动器看（也方便命令行排查）
  console.log(`[alldot] 界面已就绪 http://127.0.0.1:${PORT}/  账本：${LEDGER_PATH}`);
  try {
    db();
  } catch (err) {
    console.log(`[alldot] 账本打不开（${LEDGER_PATH}）：${err?.message ?? err}`);
  }
});

/* ------------------------------------------------------------------ 页面 */

const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");
