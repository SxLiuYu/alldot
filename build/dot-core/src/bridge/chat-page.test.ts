/**
 * src/bridge/chat-page.test.ts —— 聊天页纯逻辑的验收（按 dot:chat-state 标记切块求值）。
 *
 * 覆盖三件事：
 *   1. 状态文案只认账本卡里的「状态：」行，绝不拿整张卡做关键词嗅探；
 *   2. 错误分层：网络 / 403 / 503 / 401 / 工具失败 / JSON-RPC 错各一句人话；
 *   3. 发送默认走 brain_reply，只有用户点「让它去做」才走 brain_task。
 *
 * 不引 jsdom：标记块里禁止碰 DOM，new Function 直接求值即可（同 verify.mjs 的做法）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface ChatState {
  escHtml(s: unknown): string;
  bubbleHtml(role: string, text: string, opts?: { speak?: boolean }): string;
  progressHtml(state: string, text: string): string;
  parseCard(text: string): {
    taskId: string | null;
    intent: string | null;
    stateLabel: string | null;
    state: string;
    milestone: string | null;
    blockedBy: string | null;
    why: string | null;
  };
  serviceStateOf(input: Record<string, unknown>): {
    level: string;
    label: string;
    title: string;
    sendAllowed: boolean;
  };
  failureOf(input: Record<string, unknown>): {
    level: string;
    text: string;
    action?: { kind: string; label: string };
  };
  submitTool(intent: string, context?: string): { name: string; arguments: Record<string, unknown> };
  promoteTool(intent: string): { name: string; arguments: Record<string, unknown> };
  buildContext(history: Array<{ role?: string; text?: string }>, maxChars?: number): string;
  blockedItemsOf(doctor: Record<string, unknown>): Array<Record<string, unknown>>;
  doctorBadgeOf(doctor: Record<string, unknown>): {
    level: string;
    tone: string;
    label: string;
    blocked: boolean;
    blockedCount: number;
    sendAllowed: boolean;
    note: string;
    title: string;
  };
  doctorPanelHtml(doctor: Record<string, unknown>, opts?: Record<string, unknown>): string;
  fixErrorText(input: Record<string, unknown>): string;
  remainingText(expiresAt: string, nowMs?: number): string;
  approvalCardHtml(item: Record<string, unknown>, opts?: Record<string, unknown>): string;
  approvalErrorText(input: Record<string, unknown>): string;
  feedbackHtml(taskId: string | null, vote?: string | null): string;
  feedbackErrorText(input: Record<string, unknown>): string;
  taskIdOf(text: string): string;
  parseTaskDetail(text: string): {
    taskId: string | null;
    intent: string | null;
    stateLabel: string | null;
    state: string;
    live: boolean;
    progress: string | null;
    steps: string | null;
    waitingOn: string | null;
  };
  ledgerStateText(label: string | null): string;
  taskDetailHtml(detail: Record<string, unknown>, opts?: Record<string, unknown>): string;
}

const BEGIN = "/* dot:chat-state (begin) */";
const END = "/* dot:chat-state (end) */";

const html = readFileSync(fileURLToPath(new URL("./chat.html", import.meta.url)), "utf8");
const start = html.indexOf(BEGIN);
const end = html.indexOf(END);
assert.ok(start >= 0 && end > start, "chat.html 里要有 dot:chat-state 标记块");

const block = html.slice(start + BEGIN.length, end);
const CS = (new Function(block + "\nreturn dotChatState();") as unknown as () => ChatState)();

test("标记块能独立求值，且页面不再按整张卡嗅探 done/完成/已结束", () => {
  assert.equal(typeof CS.parseCard, "function");
  assert.equal(typeof CS.failureOf, "function");
  assert.ok(!html.includes("(done|完成|已结束)"), "旧的整卡正则必须已删掉");
});

test("parseCard：零步骤失败任务读成 failed，不会被「已结束」骗成 done", () => {
  const card = [
    "【任务 task_abc123】只回两个字：收到",
    "状态：终止（未开始里程碑）",
    "到哪了：0/0 步已结束",
    "做过什么：还没动手",
    "为什么：任务说明里没写",
    "卡在谁：会话结束但一步都没做（no_steps）",
    "等你定的事：没有",
  ].join("\n");
  const p = CS.parseCard(card);
  assert.equal(p.taskId, "task_abc123");
  assert.equal(p.stateLabel, "终止");
  assert.equal(p.state, "failed");
  assert.match(p.blockedBy ?? "", /no_steps/);
});

test("parseCard：intent 或「到哪了」里出现“完成”不影响执行中", () => {
  const card = [
    "【任务 task_run001】把任务完成报告整理好",
    "状态：执行中（第 1 个里程碑，共 2 个）",
    "到哪了：1/3 步已结束",
  ].join("\n");
  const p = CS.parseCard(card);
  assert.equal(p.state, "running");
  assert.equal(p.stateLabel, "执行中");
});

test("parseCard：七种账本状态各自的归类", () => {
  const labelOf = (label: string) => CS.parseCard("【任务 task_x】活\n状态：" + label + "（第 1 个里程碑）").state;
  assert.equal(labelOf("待启动"), "running");
  assert.equal(labelOf("执行中"), "running");
  assert.equal(labelOf("等待输入"), "waiting");
  assert.equal(labelOf("阻塞"), "waiting");
  assert.equal(labelOf("完成"), "done");
  assert.equal(labelOf("终止"), "failed");
  assert.equal(labelOf("未知"), "unknown");
});

test("parseCard：读不到状态行就是 unknown，绝不落 done", () => {
  const p = CS.parseCard("【任务 task_z】随便一段话 完成 已结束");
  assert.equal(p.state, "unknown");
  assert.equal(p.stateLabel, null);
});

test("bubbleHtml：错误气泡不挂朗读，助手回复才有 🔊 且全部转义", () => {
  assert.ok(CS.bubbleHtml("assistant", "你好").includes("speak-btn"));
  assert.ok(!CS.bubbleHtml("error", "坏了").includes("speak-btn"));
  assert.ok(!CS.bubbleHtml("assistant", "你好", { speak: false }).includes("speak-btn"));
  assert.ok(CS.bubbleHtml("error", "<b>x</b>").includes("&lt;b&gt;"));
  assert.ok(!CS.bubbleHtml("error", "<b>x</b>").includes("<b>x</b>"));
});

test("progressHtml：转义文本并按状态给色调，不吐出未转义的标签", () => {
  const failed = CS.progressHtml("failed", "<b>坏了</b>");
  assert.ok(failed.includes("&lt;b&gt;"));
  assert.ok(!failed.includes("<b>坏了</b>"));
  assert.ok(failed.includes('class="failed"'));
  assert.ok(CS.progressHtml("done", "好了").includes('class="done"'));
  assert.ok(CS.progressHtml("paused", "等你").includes("等你决定"));
  assert.ok(CS.progressHtml("active", "跑着").includes("正在处理"));
});

test("serviceStateOf：网络 / 403 / 503 / 401 / 就绪 / 插件没加载 / 大脑掉线 / 启动中", () => {
  assert.equal(CS.serviceStateOf({ networkError: new Error("offline") }).label, "连不上电脑");
  assert.equal(
    CS.serviceStateOf({ httpStatus: 403, body: { error: "access_denied" } }).label,
    "这台设备进不来",
  );
  const locked = CS.serviceStateOf({
    httpStatus: 503,
    body: { error: "bridge_token_missing", token: { configured: false } },
  });
  assert.equal(locked.level, "locked");
  assert.equal(locked.sendAllowed, false);
  const expired = CS.serviceStateOf({ httpStatus: 401, body: { error: "unauthorized" } });
  assert.equal(expired.level, "expired");
  assert.equal(expired.sendAllowed, false);
  assert.equal(CS.serviceStateOf({ httpStatus: 200, body: { brain: { online: true } } }).level, "ready");
  assert.equal(
    CS.serviceStateOf({ httpStatus: 200, body: { brain: { online: false, mode: "route_missing" } } }).label,
    "大脑插件没加载",
  );
  assert.equal(
    CS.serviceStateOf({ httpStatus: 200, body: { brain: { online: false, mode: "offline" } } }).label,
    "连不上大脑",
  );
  assert.equal(
    CS.serviceStateOf({ httpStatus: 200, body: { brain: { online: null, mode: "unknown" } } }).label,
    "服务启动中",
  );
});

test("failureOf：HTTP 四层里的人话", () => {
  const denied = CS.failureOf({ stage: "http", status: 403, body: { error: "access_denied" } });
  assert.match(denied.text, /这台设备进不来/);
  assert.equal(denied.action?.kind, "reconnect");

  const expired = CS.failureOf({ stage: "http", status: 401, body: { error: "unauthorized" } });
  assert.match(expired.text, /登录过期了/);
  assert.match(expired.text, /页面自己修不好/);
  assert.equal(expired.action?.kind, "reauth");

  const locked = CS.failureOf({
    stage: "http",
    status: 503,
    body: { error: "bridge_token_missing", token: { configured: false } },
  });
  assert.match(locked.text, /还没配好钥匙/);
  assert.match(locked.text, /不是你操作错了/);

  const offline = CS.failureOf({ stage: "http", networkError: true });
  assert.match(offline.text, /没连上电脑/);
  assert.match(offline.text, /电脑那边什么都没做/);
  assert.equal(offline.action?.kind, "retry");
});

test("failureOf：工具失败先声明没执行，再照抄服务端那句", () => {
  const f = CS.failureOf({
    stage: "tool",
    status: 200,
    body: { ok: false, error: "paused_disk", message: "磁盘满了，先清理" },
    message: "磁盘满了，先清理",
  });
  assert.match(f.text, /这次没成功/);
  assert.match(f.text, /任务没有执行/);
  assert.match(f.text, /磁盘满了，先清理/);
  assert.equal(f.action?.kind, "retry");
});

test("failureOf：对话通道六个码各一句人话，只有 reply_not_wired 给「让它去做」", () => {
  const cases: Array<[string, RegExp]> = [
    ["reply_not_wired", /还不支持直接回答/],
    ["model_unavailable", /模型现在用不了/],
    ["model_empty", /没说话/],
    ["model_failed", /模型回了错/],
    ["model_timeout", /时限内/],
    ["brain_unavailable", /连不上电脑上的大脑/],
  ];
  for (const [code, re] of cases) {
    const f = CS.failureOf({ stage: "tool", status: 200, body: { ok: false, error: code } });
    assert.match(f.text, re, code);
  }

  const promote = CS.failureOf({ stage: "tool", body: { error: "reply_not_wired" } });
  assert.equal(promote.action?.kind, "promote");
  assert.equal(promote.action?.label, "让它去做");

  const unavailable = CS.failureOf({ stage: "tool", body: { error: "model_unavailable" } });
  assert.notEqual(unavailable.action?.kind, "promote");

  const timedOut = CS.failureOf({
    stage: "tool",
    body: { error: "model_timeout", timeout_ms: 55000 },
  });
  assert.match(timedOut.text, /55 秒/);
});

test("failureOf：404 unknown_route 与工具内 token 缺失各有说法", () => {
  const route = CS.failureOf({
    stage: "tool",
    body: { error: "unknown_route", status: 404, message: "回答不了：大脑版本不支持这条通道（HTTP 404）" },
  });
  assert.match(route.text, /还不支持直接回答/);
  assert.equal(route.action?.kind, "promote");

  const noToken = CS.failureOf({
    stage: "tool",
    body: { error: "bridge_token_missing", status: 503, message: "桥 token 未配置" },
  });
  assert.match(noToken.text, /还没配好钥匙/);
  assert.equal(noToken.action?.kind, "reconnect");
});

test("failureOf：桥把「连不上大脑」包成 model_unavailable 时按掉线说", () => {
  const f = CS.failureOf({
    stage: "tool",
    body: { error: "model_unavailable", status: 503, message: "回答不了：连不上大脑（ECONNREFUSED）。没提交，也没记账。" },
  });
  assert.match(f.text, /连不上电脑上的大脑/);
  assert.equal(f.action?.kind, "reconnect");
});

test("failureOf：JSON-RPC 错给出「服务没看懂」，未知工具归到版本旧", () => {
  const rpc = CS.failureOf({ stage: "rpc", rpcCode: -32600, rpcMessage: "bad" });
  assert.match(rpc.text, /服务没看懂/);
  assert.match(rpc.text, /重发一般还是同样的结果/);

  const unknownTool = CS.failureOf({
    stage: "rpc",
    rpcCode: -32602,
    rpcMessage: "Unknown tool：brain_reply",
  });
  assert.match(unknownTool.text, /还不支持直接回答/);
  assert.equal(unknownTool.action?.kind, "promote");
});

test("发送默认只回答，不自动派活", () => {
  assert.deepEqual(CS.submitTool("在 D:/tmp 建 a.txt"), {
    name: "brain_reply",
    arguments: { intent: "在 D:/tmp 建 a.txt" },
  });
  assert.equal(CS.promoteTool("在 D:/tmp 建 a.txt").name, "brain_task");

  const sendStart = html.indexOf("async function sendText");
  const promoteStart = html.indexOf("async function promoteToTask");
  assert.ok(sendStart > 0 && promoteStart > sendStart, "sendText 与 promoteToTask 都要在");
  const sendBody = html.slice(sendStart, promoteStart);
  assert.ok(sendBody.includes("CS.submitTool"), "发送路径用 submitTool（brain_reply）");
  assert.ok(sendBody.includes("mcpCall(tool.name"), "发送路径只调 MCP");
  assert.ok(!sendBody.includes("brain_task"), "发送路径不自动建任务");
  assert.ok(html.includes("CS.promoteTool"), "建任务只从用户按钮的 promoteToTask 进入");
});

test("buildContext：只带最近几轮，超长从前面截断", () => {
  const ctx = CS.buildContext([
    { role: "user", text: "一" },
    { role: "assistant", text: "二" },
  ], 4000);
  assert.match(ctx, /用户：一/);
  assert.match(ctx, /助手：二/);

  const long = CS.buildContext([{ role: "user", text: "a".repeat(100) }], 10);
  assert.equal(long.length, 11);
  assert.ok(long.startsWith("…"));
});

/* ── P1：体检徽章与面板 ─────────────────────────────────────── */

const DOCTOR_GREEN = {
  ok: true,
  overall: "green",
  blocked: false,
  items: [
    { id: "bridge", title: "8799 桥", state: "green", blocks: false, detail: "GET /health 通", fix: null },
  ],
  configError: null,
};

const DOCTOR_BLOCKED = {
  ok: true,
  overall: "red",
  blocked: true,
  items: [
    { id: "bridge", title: "8799 桥", state: "green", blocks: false, detail: "GET /health 通", fix: null },
    {
      id: "gateway",
      title: "派单网关",
      state: "red",
      blocks: true,
      detail: "进程没起",
      fix: "start_gateway",
      fixLabel: "起网关",
    },
    {
      id: "playwright",
      title: "浏览器",
      state: "yellow",
      blocks: true,
      detail: "没装",
      fix: "start_playwright",
      fixLabel: "起浏览器",
    },
  ],
  configError: null,
};

test("doctorBadgeOf：三态徽章只认 overall 与 blocked", () => {
  const green = CS.doctorBadgeOf(DOCTOR_GREEN);
  assert.equal(green.level, "green");
  assert.equal(green.tone, "ok");
  assert.equal(green.blocked, false);
  assert.equal(green.sendAllowed, true);
  assert.equal(green.note, "");

  const red = CS.doctorBadgeOf(DOCTOR_BLOCKED);
  assert.equal(red.level, "red");
  assert.equal(red.tone, "bad");
  assert.equal(red.blocked, true);
  assert.equal(red.blockedCount, 2);
  assert.equal(red.sendAllowed, false);
  assert.equal(red.note, "有 2 项挡着，先修");
  assert.match(red.label, /先修/);

  // 只要 blocked:true 就挡发送，哪怕 items 里没标出来。
  const forced = CS.doctorBadgeOf({ overall: "yellow", blocked: true, items: [] });
  assert.equal(forced.sendAllowed, false);
  assert.match(forced.note, /先修/);
});

test("doctorBadgeOf：拿不到体检结果时染红但不拦发送", () => {
  const b = CS.doctorBadgeOf({ fetchFailed: true, status: 502 });
  assert.equal(b.level, "red");
  assert.equal(b.label, "体检没回话");
  assert.equal(b.sendAllowed, true);
  assert.equal(b.blockedCount, 0);
  assert.match(b.title, /502/);
});

test("doctorPanelHtml：逐条列 items，configError 置顶并写字段路径", () => {
  const html = CS.doctorPanelHtml(
    Object.assign({}, DOCTOR_BLOCKED, {
      configError: { path: "keepalive.tunnelPort", message: "应该是数字，你写的是字符串" },
    }),
    {},
  );
  assert.ok(html.indexOf("配置写错了") < html.indexOf("派单网关"), "配置错要排在 items 前面");
  assert.match(html, /keepalive\.tunnelPort/);
  assert.match(html, /应该是数字/);
  assert.match(html, /派单网关/);
  assert.match(html, /进程没起/);
  assert.match(html, /data-fix="start_gateway"/);
  assert.match(html, /起网关/);
  assert.match(html, /挡着派单/);
  assert.match(html, /doctor-red/);
});

test("doctorPanelHtml：修失败的原因挂在那一项下面，不静默", () => {
  const reason = CS.fixErrorText({
    status: 200,
    body: { ok: false, error: "fix_failed", message: "端口被占" },
  });
  assert.match(reason, /修了但没成/);
  assert.match(reason, /端口被占/);

  const html = CS.doctorPanelHtml(DOCTOR_BLOCKED, { error: { action: "start_gateway", text: reason } });
  assert.match(html, /doctor-fix-error/);
  assert.match(html, /端口被占/);

  assert.match(CS.fixErrorText({ networkError: true }), /没连上电脑/);
  assert.match(CS.fixErrorText({ status: 200, body: { ok: false, error: "unknown_action" } }), /不认识/);
  assert.match(CS.fixErrorText({ status: 404 }), /一键修/);
  assert.match(CS.fixErrorText({ status: 200, body: { error: "fix_failed" } }), /没给原因/);

  const failedFetch = CS.doctorPanelHtml({ fetchFailed: true, status: 0 }, {});
  assert.match(failedFetch, /拿不到体检结果/);
});

/* ── P1：待批卡 ─────────────────────────────────────────────── */

const APV_NOW = Date.parse("2026-11-27T05:00:00.000Z");
const APV_ITEM = {
  id: "apv_1",
  taskId: "task_abc",
  tier: 4,
  summary: "在 D:/work 里删 3 个文件",
  createdAt: "2026-11-27T05:00:00.000Z",
  expiresAt: "2026-11-27T05:30:00.000Z",
  expired: false,
};

test("approvalCardHtml：带任务号、档位、摘要与剩余时间", () => {
  const html = CS.approvalCardHtml(APV_ITEM, { now: APV_NOW });
  assert.match(html, /task_abc/);
  assert.match(html, /第 4 档/);
  assert.match(html, /在 D:\/work 里删 3 个文件/);
  assert.match(html, /还剩 30 分钟/);
  assert.match(html, /data-answer="agree"/);
  assert.match(html, /data-answer="reject"/);
  assert.match(html, /data-approval="apv_1"/);
  assert.ok(!html.includes("approval-dead"), "还没过期就不该标灰");
});

test("approvalCardHtml：expired / already_decided 标灰并写「这条已过期」", () => {
  const expired = CS.approvalCardHtml(Object.assign({}, APV_ITEM, { expired: true }), { now: APV_NOW });
  assert.match(expired, /approval-dead/);
  assert.match(expired, /这条已过期/);
  assert.match(expired, /disabled/);

  const decided = CS.approvalCardHtml(APV_ITEM, { now: APV_NOW, result: "already_decided" });
  assert.match(decided, /approval-dead/);
  assert.match(decided, /这条已过期/);
  assert.ok(decided.includes("disabled"), "答过的按钮要禁掉，不能重复记账");
});

test("approvalErrorText：批失败分层说人话，不把 JSON 倒出来", () => {
  const raw = '{"ok":false,"error":"expired","message":"超时"}';
  const expired = CS.approvalErrorText({ status: 400, body: { error: "expired", message: raw } });
  assert.match(expired, /这条已过期/);
  assert.ok(!expired.includes('{"ok"'), "不能把服务端 JSON 塞进文案");

  assert.match(CS.approvalErrorText({ status: 200, body: { error: "already_decided" } }), /已经处理过/);
  assert.match(CS.approvalErrorText({ status: 200, body: { error: "not_found" } }), /不在了/);
  assert.match(CS.approvalErrorText({ networkError: true }), /没连上电脑/);
  assert.match(CS.approvalErrorText({ status: 401 }), /登录过期/);
  assert.match(CS.approvalErrorText({ status: 500 }), /HTTP 500/);
});

test("remainingText：按 expiresAt 算，过了就是「已过期」", () => {
  assert.equal(CS.remainingText("2026-11-27T05:20:00.000Z", APV_NOW), "还剩 20 分钟");
  assert.equal(CS.remainingText("2026-11-27T05:00:30.000Z", APV_NOW), "还剩不到 1 分钟");
  assert.equal(CS.remainingText("2026-11-27T04:59:00.000Z", APV_NOW), "已过期");
  assert.equal(CS.remainingText("", APV_NOW), "没说多久过期");
});

/* ── P1：反馈按钮 ───────────────────────────────────────────── */

test("feedbackHtml：没有 taskId 不出现；点过之后置灰", () => {
  assert.equal(CS.feedbackHtml("", ""), "");
  assert.equal(CS.feedbackHtml(null, null), "");

  const fresh = CS.feedbackHtml("task_abc", "");
  assert.match(fresh, /对了/);
  assert.match(fresh, /不对/);
  assert.ok(!fresh.includes("disabled"), "没点过不该置灰");

  const voted = CS.feedbackHtml("task_abc", "up");
  assert.match(voted, /disabled/);
  assert.match(voted, /picked/);
});

test("feedbackErrorText：没记上要说人话", () => {
  assert.match(CS.feedbackErrorText({ networkError: true }), /没记上/);
  assert.match(CS.feedbackErrorText({ status: 401 }), /登录过期/);
  assert.match(CS.feedbackErrorText({ status: 500 }), /HTTP 500/);
});

/* ── P1：任务详情 ───────────────────────────────────────────── */

test("parseTaskDetail：状态、进度、步骤都读出来，还在跑就标 live", () => {
  const card = [
    "【任务 task_run001】把报告整理好",
    "状态：执行中（第 2 个里程碑，共 3 个）",
    "到哪了：2/5 步已结束",
    "做过什么：扫了一遍下载文件夹",
    "为什么：还有三份没归档",
    "卡在谁：没卡",
    "等你定的事：没有",
  ].join("\n");
  const d = CS.parseTaskDetail(card);
  assert.equal(d.taskId, "task_run001");
  assert.equal(d.stateLabel, "执行中");
  assert.equal(d.live, true);
  assert.equal(d.progress, "2/5 步已结束");
  assert.equal(d.steps, "扫了一遍下载文件夹");
  assert.equal(d.waitingOn, "没有");

  // 做完了就不再自动刷新。
  assert.equal(CS.parseTaskDetail("【任务 task_d】x\n状态：完成（第 3 个里程碑）").live, false);
  assert.equal(CS.taskIdOf("没有任务号的一句话"), "");
});

test("taskDetailHtml：账本状态翻成人话，关闭按钮与失败原因都在", () => {
  assert.match(CS.ledgerStateText("执行中"), /正在做/);
  assert.match(CS.ledgerStateText("阻塞"), /卡住/);
  assert.match(CS.ledgerStateText("完成"), /做完/);
  assert.match(CS.ledgerStateText(null), /状态不明/);

  const html = CS.taskDetailHtml({
    taskId: "task_run001",
    intent: "整理报告",
    stateLabel: "执行中",
    state: "running",
    live: true,
    progress: "2/5 步已结束",
    steps: "扫了一遍",
    waitingOn: "没有",
  }, {});
  assert.match(html, /data-detail="close"/);
  assert.match(html, /正在做/);
  assert.match(html, /2\/5 步已结束/);
  assert.match(html, /还在跑/);

  const failed = CS.taskDetailHtml({ taskId: "task_x", state: "unknown", live: false }, { error: "连不上电脑" });
  assert.match(failed, /detail-error/);
  assert.match(failed, /连不上电脑/);
});

/* ── P1：接线与 CSP 硬约束 ──────────────────────────────────── */

test("页面按契约接上新接口，且不引外链资源", () => {
  for (const route of ["'/api/doctor'", "'/api/fix'", "'/api/approvals'", "'/api/approvals/answer'", "'/feedback'"]) {
    assert.ok(html.includes(route), `要调 ${route}`);
  }
  assert.match(html, /setInterval\(refreshDoctor, 30000\)/, "体检 30 秒一轮");
  assert.match(html, /setInterval\(refreshApprovals, 15000\)/, "待批 15 秒一轮");
  assert.match(html, /brain_status/, "任务详情沿用 brain_status");
  assert.ok(!html.includes("<script src"), "不许引外链脚本");
  assert.ok(!/<link[^>]+rel="stylesheet"/.test(html), "不许引外部样式表");
  assert.ok(html.includes('id="doctorPanel"') && html.includes('id="approvalStack"') && html.includes('id="detailPane"'));
});
