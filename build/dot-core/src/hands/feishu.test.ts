/**
 * src/hands/feishu.test.ts —— 飞书手的验收。
 *
 * 不连真飞书：fetch 用注入的假实现（token、日历列表、日程列表、建日程各回一份固定 JSON）。
 * 钉住的是治理与参数：
 * 1. 凭据读法：allbot.json 的 channels.feishu，缺一个就 null；
 * 2. 时间解析：ISO 带时区、带空格的本地写法都认，认不出来是 null（不瞎猜）；
 * 3. 建日程缺 title/start/end 或 end ≤ start 在动手前拒；
 * 4. 只读动作 1 档直接做，正文带真实日历名；
 * 5. create 一定先出请示卡，且不碰网络。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decideApproval, getTask, listApprovals, listSteps, migrate, setTaskState } from "../ledger/index.ts";
import { createTask, makeTempDb } from "../ledger/test-helpers.ts";
import type { HandDeps } from "./hand.ts";
import {
  createFeishuHand,
  filterFeishuParams,
  isFeishuReadOnly,
  normalizeFeishuAction,
  parseWhen,
  readFeishuCreds,
  validateFeishuRequest,
  type FeishuCreds,
} from "./feishu.ts";
import { defaultConfig } from "../config.ts";

const CREDS: FeishuCreds = { appId: "cli_x", appSecret: "sec", domain: "feishu" };

type Reply = { code: number; msg?: string; data?: unknown; tenant_access_token?: string };

function fakeFetch(route: (url: string, init: { method?: string; body?: unknown }) => Reply): {
  impl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url.replace("https://open.feishu.cn", "")}`);
    const reply = route(url, init ?? {});
    return { json: async () => reply } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeFixture(): { deps: HandDeps; cleanup: () => void } {
  const tmp = makeTempDb();
  migrate(tmp.db);
  return { deps: { db: tmp.db, config: defaultConfig() }, cleanup: () => tmp.cleanup() };
}

const OK_TOKEN: Reply = { code: 0, tenant_access_token: "tok_1" };

test("凭据：allbot.json 的形状，缺 appId/appSecret 返回 null", () => {
  assert.deepEqual(readFeishuCreds({ channels: { feishu: { appId: "a", appSecret: "b" } } }), {
    appId: "a",
    appSecret: "b",
    domain: "feishu",
  });
  assert.equal(readFeishuCreds({ channels: { feishu: { appId: "a" } } }), null);
  assert.equal(readFeishuCreds({ channels: {} }), null);
  assert.equal(readFeishuCreds(null), null);
  assert.equal(readFeishuCreds({ channels: { feishu: { appId: "a", appSecret: "b", domain: "lark" } } })?.domain, "lark");
});

test("动作归一与只读分类", () => {
  assert.equal(normalizeFeishuAction("日历"), "calendars");
  assert.equal(normalizeFeishuAction("create_event"), "create");
  assert.equal(normalizeFeishuAction("remove"), "cancel");
  assert.equal(normalizeFeishuAction("delete"), "cancel", "语义叫取消，名字不能带 delete（闸门第 6 档直接拒）");
  assert.equal(normalizeFeishuAction("收件箱"), null);
  assert.equal(isFeishuReadOnly("events"), true);
  assert.equal(isFeishuReadOnly("create"), false);
});

test("时间解析：ISO 带时区、带空格都认；垃圾输入是 null", () => {
  const a = parseWhen("2026-11-26T15:00:00+08:00");
  const b = parseWhen("2026-11-26 15:00");
  assert.equal(typeof a, "number");
  assert.equal(typeof b, "number");
  assert.ok((a as number) > 1_700_000_000);
  assert.equal(parseWhen("明天下午"), null);
  assert.equal(parseWhen(undefined), null);
});

test("参数裁剪：列日程默认看未来 7 天；建日程只留认识的键", () => {
  const now = 1_800_000_000;
  const ev = filterFeishuParams("events", { evil: 1 }, now);
  assert.equal(ev.time_min, now);
  assert.equal(ev.time_max, now + 7 * 24 * 3600);
  const cr = filterFeishuParams("create", { summary: "开会", start: "2026-11-26 15:00", end: "2026-11-26 16:00", evil: 1 }, now);
  assert.equal(cr.summary, "开会");
  assert.equal(typeof cr.start, "number");
  assert.deepEqual(Object.keys(cr).sort(), ["end", "start", "summary"], "多余的键不许往下递");
});

test("建日程的前置校验：缺三样和区间倒挂都在动手前拒", () => {
  assert.equal(validateFeishuRequest("create", {})?.code, "missing_summary");
  assert.equal(validateFeishuRequest("create", { summary: "x" })?.code, "missing_start");
  assert.equal(validateFeishuRequest("create", { summary: "x", start: 100 })?.code, "missing_end");
  assert.equal(validateFeishuRequest("create", { summary: "x", start: 100, end: 100 })?.code, "bad_range");
  assert.equal(validateFeishuRequest("create", { summary: "x", start: 100, end: 200 }), null);
  assert.equal(validateFeishuRequest("cancel", {})?.code, "missing_event_id");
  assert.equal(validateFeishuRequest("cancel", { event_id: "fs_1" }), null);
});

test("只读：列日历走完七步壳，落一步 succeeded，正文带日历名", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看看我有几个飞书日历" });
    const { impl, calls } = fakeFetch((url) =>
      url.includes("tenant_access_token")
        ? OK_TOKEN
        : {
            code: 0,
            data: { calendar_list: [{ calendar_id: "cal_1", summary: "charlie", role: "owner", type: "primary" }] },
          },
    );
    const hand = createFeishuHand(f.deps, { creds: CREDS, fetchImpl: impl });

    const out = await hand.run({ taskId, action: "calendars", params: {} });
    assert.equal(out.ok, true, `${out.code}：${out.text}`);
    assert.match(out.text, /charlie/);
    assert.equal(calls.length, 2, `换 token + 列日历，实际 ${calls.join(" | ")}`);
    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.tool, "feishu");
    assert.equal(steps[0]?.status, "succeeded");
    assert.equal(steps[0]?.tier, 1);
  } finally {
    f.cleanup();
  }
});

test("只读：列日程把时间戳翻成可读时间", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看下周日程" });
    const { impl } = fakeFetch((url) =>
      url.includes("tenant_access_token")
        ? OK_TOKEN
        : url.includes("/events?")
          ? {
              code: 0,
              data: {
                items: [
                  {
                    summary: "和查理开会",
                    start_time: { timestamp: "1800000000" },
                    end_time: { timestamp: "1800003600" },
                  },
                ],
              },
            }
          : { code: 0, data: { calendar_id: "cal_primary" } },
    );
    const hand = createFeishuHand(f.deps, { creds: CREDS, fetchImpl: impl });
    const out = await hand.run({ taskId, action: "events", params: {} });
    assert.equal(out.ok, true, out.text);
    assert.match(out.text, /和查理开会/);
  } finally {
    f.cleanup();
  }
});

test("建日程：先出请示卡（第 4 档），一个网络请求都不发", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "明天下午三点和查理开会" });
    const { impl, calls } = fakeFetch(() => OK_TOKEN);
    const hand = createFeishuHand(f.deps, { creds: CREDS, fetchImpl: impl });

    const out = await hand.run({
      taskId,
      action: "create",
      params: { summary: "和查理开会", start: "2026-11-26 15:00", end: "2026-11-26 16:00" },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "awaiting_approval", out.text);
    assert.notEqual(out.approvalId, null);
    assert.deepEqual(calls, [], "等批准时不许碰飞书");
    assert.equal(listApprovals(f.deps.db).length, 1);
    assert.equal(getTask(f.deps.db, taskId)?.state, "awaiting_approval");
    assert.equal(out.tier, 4);
  } finally {
    f.cleanup();
  }
});

test("取消日程：同样先出请示卡（第 4 档），不碰网络", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "把那条测试日程删掉" });
    const { impl, calls } = fakeFetch(() => OK_TOKEN);
    const hand = createFeishuHand(f.deps, { creds: CREDS, fetchImpl: impl });
    const out = await hand.run({ taskId, action: "cancel", params: { event_id: "fs_1" } });
    assert.equal(out.code, "awaiting_approval", out.text);
    assert.equal(out.tier, 4);
    assert.deepEqual(calls, [], "等批准时不许碰飞书");
  } finally {
    f.cleanup();
  }
});

test("批过之后再调同一个建日程：直接执行，不再开新单", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "明天下午三点和查理开会" });
    const { impl } = fakeFetch((url) => {
      if (url.includes("tenant_access_token")) return OK_TOKEN;
      if (url.includes("/events") && url.includes("POST")) {
        return {
          code: 0,
          data: {
            event: {
              event_id: "fs_new",
              summary: "和查理开会",
              start_time: { timestamp: "1800000000" },
              end_time: { timestamp: "1800003600" },
            },
          },
        };
      }
      return { code: 0, data: { calendar_id: "cal_primary" } };
    });
    const hand = createFeishuHand(f.deps, { creds: CREDS, fetchImpl: impl });
    const args = {
      taskId,
      action: "create",
      params: { summary: "和查理开会", start: "2026-11-26 15:00", end: "2026-11-26 16:00" },
    };

    const first = await hand.run(args);
    assert.equal(first.code, "awaiting_approval");
    decideApproval(f.deps.db, String(first.approvalId), { decision: "approved", decidedBy: "cli", note: "自检" });
    setTaskState(f.deps.db, taskId, "running", { blocked_on: null, reason: "自检：放回执行" });

    const second = await hand.run(args);
    assert.equal(second.ok, true, `${second.code}：${second.text}`);
    assert.match(second.text, /已建日程/);
    assert.equal(listApprovals(f.deps.db).length, 1, "不该开出第二张单");
  } finally {
    f.cleanup();
  }
});

test("自动同意上限 4：建日程不用人点，批单记成 system 批准并留事件", async () => {
  const tmp = makeTempDb();
  migrate(tmp.db);
  try {
    const config = defaultConfig();
    config.approvals.auto_approve_max_tier = 4;
    const deps: HandDeps = { db: tmp.db, config };
    const taskId = createTask(tmp.db, { intent: "明天下午三点和查理开会" });
    const { impl } = fakeFetch((url) => {
      if (url.includes("tenant_access_token")) return OK_TOKEN;
      if (url.includes("/events") && url.includes("POST")) {
        return {
          code: 0,
          data: {
            event: {
              event_id: "fs_new",
              summary: "和查理开会",
              start_time: { timestamp: "1800000000" },
              end_time: { timestamp: "1800003600" },
            },
          },
        };
      }
      return { code: 0, data: { calendar_id: "cal_primary" } };
    });
    const hand = createFeishuHand(deps, { creds: CREDS, fetchImpl: impl });

    const out = await hand.run({
      taskId,
      action: "create",
      params: { summary: "和查理开会", start: "2026-11-26 15:00", end: "2026-11-26 16:00" },
    });
    assert.equal(out.ok, true, `${out.code}：${out.text}`);
    assert.match(out.text, /已建日程/);

    const apv = listApprovals(tmp.db)[0];
    // 自动同意之后立刻执行完，所以状态会是 executed（不是停在 approved）
    assert.ok(["approved", "executed"].includes(String(apv?.status)), `实际 ${apv?.status}`);
    assert.equal(apv?.decided_by, "system");

    // 事件链里要能看到「自动同意过」这件事
    const events = tmp.db.prepare("SELECT type FROM events WHERE type = 'approval_auto_approved'").all() as unknown as Array<{ type: string }>;
    assert.equal(events.length, 1, "自动同意必须留痕");
  } finally {
    tmp.cleanup();
  }
});

test("缺权限（99991672）：错误正文要告诉人去开通哪个权限，而不是只说失败", async () => {
  const tmp = makeTempDb();
  migrate(tmp.db);
  try {
    const config = defaultConfig();
    config.approvals.auto_approve_max_tier = 4; // 让它自己过闸，直奔接口
    const deps: HandDeps = { db: tmp.db, config };
    const taskId = createTask(tmp.db, { intent: "建一条日程" });
    const { impl } = fakeFetch((url) =>
      url.includes("tenant_access_token")
        ? OK_TOKEN
        : {
            code: 99991672,
            msg: "Access denied. One of the following scopes is required: [calendar:calendar]",
          },
    );
    const hand = createFeishuHand(deps, { creds: CREDS, fetchImpl: impl });
    const out = await hand.run({
      taskId,
      action: "create",
      params: { summary: "x", start: "2026-11-26 15:00", end: "2026-11-26 16:00" },
    });
    assert.equal(out.ok, false);
    assert.match(out.text, /权限/);
    assert.match(out.text, /开放平台/);
    assert.match(out.text, /只能人做/);
  } finally {
    tmp.cleanup();
  }
});

test("飞书接口报错：落 failed 步骤，错误码来自飞书原话", async () => {
  const f = makeFixture();
  try {
    const taskId = createTask(f.deps.db, { intent: "看看有几个日历" });
    const { impl } = fakeFetch((url) =>
      url.includes("tenant_access_token") ? OK_TOKEN : { code: 99991663, msg: "Invalid access token" },
    );
    const hand = createFeishuHand(f.deps, { creds: CREDS, fetchImpl: impl });
    const out = await hand.run({ taskId, action: "calendars", params: {} });
    assert.equal(out.ok, false);
    assert.match(out.text, /99991663|Invalid access token/);
    const steps = listSteps(f.deps.db, taskId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.status, "failed");
  } finally {
    f.cleanup();
  }
});
