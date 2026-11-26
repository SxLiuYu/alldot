/**
 * src/hands/feishu.ts —— 飞书手：日历三个动作（列日历 / 列日程 / 建日程）。
 *
 * 为什么走 OpenAPI 而不是再拉一个 MCP：这台机器上 allbot 已经有飞书应用凭据
 * （~/.allbot/allbot.json 的 channels.feishu，appId/appSecret），换 tenant_access_token 就能读
 * 自己的日历，实测 2026-11-25：拿到 1 个日历（charlie，owner，primary 可读）。多一个 MCP 进程
 * 就多一条会死的服务，不如在插件里直接调。
 *
 * 三档：
 *   calendars / events 只读 → 1 档直接做；
 *   create 建日程 → unknown 副作用 → 出请示卡（日程会出现在别人日历上、会发提醒，删不干净）。
 *
 * 凭据只在内存里换 token 并缓存 100 分钟（飞书给 2 小时），过期自动重取。
 */

import { readFileSync } from "node:fs";

import type { GateInput, TierVerdict } from "../gate/types.ts";
import type { HandDeps, HandOutcome, HandPrepareResult, HandRequest, HandSpec } from "./hand.ts";
import { runHandShell } from "./hand.ts";

export const FEISHU_TOOL_NAME = "feishu";

export const FEISHU_ACTIONS = ["calendars", "events", "create", "cancel"] as const;
export type FeishuAction = (typeof FEISHU_ACTIONS)[number];

/** 只读动作：不往飞书写任何东西。 */
export const FEISHU_READONLY_ACTIONS: readonly FeishuAction[] = Object.freeze(["calendars", "events"]);

export const FEISHU_ACTION_HELP =
  "飞书日历只认这些动作：calendars（我有哪几个日历）/ events（某个日历某段时间的日程）/ " +
  "create（建一条日程：要 summary 和 start/end，可选 calendar_id、description）/ " +
  "cancel（取消一条日程：要 event_id，可选 calendar_id）。" +
  "注意：动作名字叫 cancel 不叫 delete —— 闸门对 delete/remove 这类词一律第 6 档直接拒" +
  "（那条规则是防本机 rm/卸载的），飞书自己的接口也叫「取消日程」。取消同样要人点同意。";

export interface FeishuCreds {
  appId: string;
  appSecret: string;
  /** feishu → open.feishu.cn；lark → open.larksuite.com */
  domain: string;
}

export interface FeishuConfigLike {
  channels?: { feishu?: { appId?: unknown; appSecret?: unknown; domain?: unknown } };
}

/** 从 allbot.json 的形状里取飞书凭据；缺一个就返回 null（这只手就不该挂上）。 */
export function readFeishuCreds(allbotConfig: unknown): FeishuCreds | null {
  const cfg = allbotConfig as FeishuConfigLike | null;
  const f = cfg?.channels?.feishu;
  if (f === undefined || f === null) return null;
  const appId = typeof f.appId === "string" ? f.appId.trim() : "";
  const appSecret = typeof f.appSecret === "string" ? f.appSecret.trim() : "";
  if (appId === "" || appSecret === "") return null;
  const domain = typeof f.domain === "string" && f.domain.trim() !== "" ? f.domain.trim() : "feishu";
  return { appId, appSecret, domain };
}

export function readFeishuCredsFromFile(configPath: string): FeishuCreds | null {
  try {
    return readFeishuCreds(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return null;
  }
}

function baseUrl(creds: FeishuCreds): string {
  return creds.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export function normalizeFeishuAction(action: unknown): FeishuAction | null {
  const a = typeof action === "string" ? action.trim().toLowerCase() : "";
  const alias: Record<string, FeishuAction> = {
    calendars: "calendars",
    calendar: "calendars",
    list_calendars: "calendars",
    日历: "calendars",
    events: "events",
    event: "events",
    list_events: "events",
    agenda: "events",
    create: "create",
    create_event: "create",
    add: "create",
    new: "create",
    cancel: "cancel",
    delete: "cancel",
    remove: "cancel",
    cancel_event: "cancel",
    delete_event: "cancel",
    取消: "cancel",
    删除: "cancel",
  };
  return alias[a] ?? null;
}

export function isFeishuReadOnly(action: string): boolean {
  return (FEISHU_READONLY_ACTIONS as readonly string[]).includes(action);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 时间：认 ISO 带时区（2026-11-26T15:00:00+08:00）、也认「2026-11-26 15:00」。
 * 返回 unix 秒；认不出来返回 null（调用方在动手前就拒，不要瞎猜一个时间）。
 */
export function parseWhen(value: unknown): number | null {
  const raw = textOf(value);
  if (raw === undefined) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(" ", "T") : raw;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export interface FeishuParams {
  calendar_id?: string;
  event_id?: string;
  summary?: string;
  description?: string;
  start?: number;
  end?: number;
  time_min?: number;
  time_max?: number;
  limit?: number;
}

/** 参数白名单裁剪 + 默认时间窗（列日程默认看未来 7 天）。 */
export function filterFeishuParams(
  action: FeishuAction,
  raw: Record<string, unknown> | undefined,
  nowSec: number,
): FeishuParams {
  const p = raw ?? {};
  if (action === "calendars") return {};
  const calendarId = textOf(p["calendar_id"]) ?? textOf(p["calendar"]) ?? undefined;
  if (action === "events") {
    const out: FeishuParams = {
      time_min: parseWhen(p["time_min"]) ?? nowSec,
      time_max: parseWhen(p["time_max"]) ?? nowSec + 7 * 24 * 3600,
      limit: 50,
    };
    if (calendarId !== undefined) out.calendar_id = calendarId;
    return out;
  }
  if (action === "cancel") {
    const out: FeishuParams = {};
    const eventId = textOf(p["event_id"]) ?? textOf(p["id"]);
    if (eventId !== undefined) out.event_id = eventId;
    if (calendarId !== undefined) out.calendar_id = calendarId;
    return out;
  }
  const out: FeishuParams = {};
  const summary = textOf(p["summary"]) ?? textOf(p["title"]);
  if (summary !== undefined) out.summary = summary;
  const description = textOf(p["description"]) ?? textOf(p["note"]);
  if (description !== undefined) out.description = description;
  const start = parseWhen(p["start"]);
  const end = parseWhen(p["end"]);
  if (start !== null) out.start = start;
  if (end !== null) out.end = end;
  if (calendarId !== undefined) out.calendar_id = calendarId;
  return out;
}

/** 建日程要三样：标题、开始、结束（且结束晚于开始）。都在动手前拒。 */
export function validateFeishuRequest(
  action: FeishuAction,
  params: FeishuParams,
): { code: string; text: string } | null {
  if (action === "cancel") {
    return params.event_id === undefined
      ? { code: "missing_event_id", text: "cancel 要 event_id（先 events 查出来，事件 id 长这样 fs_xxx）" }
      : null;
  }
  if (action !== "create") return null;
  if (params.summary === undefined) return { code: "missing_summary", text: "create 要 summary（日程标题）" };
  if (params.start === undefined) {
    return { code: "missing_start", text: "create 要 start（开始时间，例如 2026-11-26T15:00:00+08:00）" };
  }
  if (params.end === undefined) return { code: "missing_end", text: "create 要 end（结束时间，同上格式）" };
  if (params.end <= params.start) return { code: "bad_range", text: "end 必须晚于 start" };
  return null;
}

class FeishuApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
  }
}

interface FeishuContext {
  action: FeishuAction;
  params: FeishuParams;
  taskId: string;
}

export interface FeishuHandOptions {
  creds?: FeishuCreds;
  /** 测试用：替掉 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试用：固定「现在」。 */
  now?: () => number;
  timeoutMs?: number;
}

export interface FeishuHand {
  run(req: HandRequest): Promise<HandOutcome>;
  readonly creds: FeishuCreds | null;
}

export function createFeishuHand(deps: HandDeps, opts: FeishuHandOptions = {}): FeishuHand {
  const creds = opts.creds ?? null;
  const doFetch = opts.fetchImpl ?? fetch;
  const nowSec = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  /** token 缓存：飞书给 2 小时，这里按 100 分钟换一次。 */
  let token: { value: string; at: number } | null = null;

  async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    if (creds === null) throw new FeishuApiError("no_creds", "allbot.json 里没有飞书 appId/appSecret");
    if (token === null || Date.now() - token.at > 100 * 60 * 1000) {
      const res = await doFetch(`${baseUrl(creds)}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
      if (typeof j.tenant_access_token !== "string" || j.tenant_access_token === "") {
        throw new FeishuApiError("auth_failed", `换飞书 token 失败：${j.code ?? "?"} ${j.msg ?? ""}`.trim());
      }
      token = { value: j.tenant_access_token, at: Date.now() };
    }
    const res = await doFetch(`${baseUrl(creds)}/open-apis${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token.value}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json()) as { code?: number; msg?: string; data?: unknown };
    if (j.code !== 0) {
      // 99991672 = 应用没开通这个接口要的权限。这不是「重试一下就好」的错误，
      // 必须把该开哪个权限、去哪儿开说清楚，否则工人会一直重试、人也不知道卡在哪
      // （2026-11-25 实测：读日历通、建日程被拒，就是这个）。
      if (j.code === 99991672 || /scope/i.test(j.msg ?? "")) {
        throw new FeishuApiError(
          "scope_missing",
          `飞书应用没开通这个操作要的权限：${j.msg ?? ""}。` +
            "请到飞书开放平台这个应用的「权限管理」里开通 calendar 的读写权限并发布版本，" +
            "否则读可以、写（建/取消日程）一律被拒。这一步只能人做。",
        );
      }
      throw new FeishuApiError("api_error", `飞书接口 ${path} 回 ${j.code ?? "?"}：${j.msg ?? ""}`.trim());
    }
    return j.data as T;
  }

  async function primaryCalendarId(): Promise<string> {
    const data = await api<{ calendar_id?: string }>("/calendar/v4/calendars/primary");
    const id = typeof data?.calendar_id === "string" ? data.calendar_id : "";
    if (id === "") throw new FeishuApiError("no_primary", "飞书没返回主日历");
    return id;
  }

  async function runAction(ctx: FeishuContext): Promise<{ summary: string; data: Record<string, unknown> }> {
    if (ctx.action === "calendars") {
      const data = await api<{ calendar_list?: Array<{ calendar_id: string; summary: string; role: string; type: string }> }>(
        "/calendar/v4/calendars",
      );
      const list = data?.calendar_list ?? [];
      const lines = list.map((c) => `· ${c.summary}（${c.type === "primary" ? "主日历" : c.type}，${c.role}）${c.calendar_id}`);
      return {
        summary: list.length === 0 ? "飞书上一个日历都没有" : `有 ${list.length} 个日历：\n${lines.join("\n")}`,
        data: { calendars: list },
      };
    }

    const calendarId = ctx.params.calendar_id ?? (await primaryCalendarId());

    if (ctx.action === "events") {
      const qs = new URLSearchParams({
        start_time: String(ctx.params.time_min ?? nowSec()),
        end_time: String(ctx.params.time_max ?? nowSec() + 7 * 24 * 3600),
      });
      const data = await api<{ items?: Array<Record<string, unknown>> }>(
        `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
      );
      const items = data?.items ?? [];
      const fmt = (v: unknown): string => {
        if (typeof v !== "object" || v === null) return "?";
        const t = (v as { timestamp?: unknown; date?: unknown }).timestamp ?? (v as { date?: unknown }).date;
        if (typeof t === "string" && /^\d+$/.test(t)) {
          return new Date(Number(t) * 1000).toLocaleString("zh-CN", { hour12: false });
        }
        return typeof t === "string" ? t : "?";
      };
      const lines = items
        .slice(0, 20)
        .map(
          (e) =>
            `· ${String(e["summary"] ?? "(无标题)")}：${fmt(e["start_time"])} → ${fmt(e["end_time"])}` +
            `（event_id ${String(e["event_id"] ?? "?")}）`,
        );
      const show = (sec: number | undefined): string =>
        sec === undefined ? "?" : new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
      const window = `${show(ctx.params.time_min)} → ${show(ctx.params.time_max)}`;
      return {
        summary:
          items.length === 0
            ? `这段时间（${window}）日历上是空的。换一个时间再查同一件事没有意义，直接照这个结果回答。`
            : `这段时间（${window}）有 ${items.length} 个日程：\n${lines.join("\n")}`,
        data: { calendar_id: calendarId, count: items.length, items: items.slice(0, 20) },
      };
    }

    if (ctx.action === "cancel") {
      // 建错了要能撤。删的也是别人日历上看得见的东西，所以同样走请示卡（第 4 档）。
      await api<Record<string, unknown>>(
        `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(String(ctx.params.event_id))}`,
        { method: "DELETE" },
      );
      return {
        summary: `已取消日程 ${String(ctx.params.event_id)}（日历 ${calendarId}）`,
        data: { calendar_id: calendarId, event_id: ctx.params.event_id, deleted: true },
      };
    }

    const created = await api<{ event?: Record<string, unknown> }>(
      `/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        body: {
          summary: ctx.params.summary,
          ...(ctx.params.description === undefined ? {} : { description: ctx.params.description }),
          start_time: { timestamp: String(ctx.params.start), timezone: "Asia/Shanghai" },
          end_time: { timestamp: String(ctx.params.end), timezone: "Asia/Shanghai" },
        },
      },
    );
    const ev = created?.event ?? {};
    const fmt = (v: unknown): string => {
      const t = typeof v === "object" && v !== null ? (v as { timestamp?: unknown }).timestamp : undefined;
      return typeof t === "string" && /^\d+$/.test(t)
        ? new Date(Number(t) * 1000).toLocaleString("zh-CN", { hour12: false })
        : "?";
    };
    return {
      summary: `已建日程：${String(ev["summary"] ?? ctx.params.summary)}（${fmt(ev["start_time"])} → ${fmt(ev["end_time"])}）`,
      data: { calendar_id: calendarId, event: ev },
    };
  }

  const spec: HandSpec<FeishuContext> = {
    toolName: FEISHU_TOOL_NAME,
    gateTool: FEISHU_TOOL_NAME,
    normalize: (req) => normalizeFeishuAction(req.action),
    badActionText: FEISHU_ACTION_HELP,

    prepare(_deps, task, action, req): HandPrepareResult<FeishuContext> {
      const typed = action as FeishuAction;
      const params = filterFeishuParams(typed, asRecord(req.params), nowSec());
      const bad = validateFeishuRequest(typed, params);
      if (bad !== null) return { ok: false, code: "bad_action", text: bad.text };
      return { ok: true, ctx: { action: typed, params, taskId: task.id } };
    },

    gateInput(action, _req, ctx): GateInput {
      const typed = action as FeishuAction;
      const sideEffect = isFeishuReadOnly(typed) ? "safe" : "unknown";
      return {
        tool: FEISHU_TOOL_NAME,
        action: typed,
        args: { action: typed, side_effect: sideEffect, ...ctx.params },
      };
    },

    adjustVerdict(verdict: TierVerdict, action): TierVerdict {
      if (isFeishuReadOnly(action) && verdict.tier > 1) {
        return {
          tier: 1,
          rule: "feishu_readonly",
          reason: `飞书只读动作（${action}）`,
          handling: "allow",
          sideEffect: "safe",
          judgeNeeded: false,
        };
      }
      return verdict;
    },

    subjectParams(_action, _req, ctx) {
      // 主题键必须稳定到「同一件事」，否则批过的那张用不上：
      // 恢复后模型会重新解析「明天上午 11 点」，时间戳差几秒就成了另一张单
      // （2026-11-25 真机：批了建日程，重排后同一个动作又去开新单）。
      // create 只看标题 + 开始时间（取到分钟）；cancel 只看 event_id。
      if (ctx.action === "create") {
        const start = ctx.params.start === undefined ? null : Math.floor(ctx.params.start / 60) * 60;
        return { summary: ctx.params.summary ?? null, start };
      }
      if (ctx.action === "cancel") return { event_id: ctx.params.event_id ?? null };
      return ctx.params;
    },

    snapshotTarget() {
      return null;
    },

    async act(_action, _req, ctx) {
      try {
        return await runAction(ctx);
      } catch (err) {
        if (err instanceof FeishuApiError) throw err;
        throw new FeishuApiError("network", `飞书接口调不动：${(err as Error).message}`);
      }
    },

    approvalCard(action, _req, ctx, task, verdict) {
      return {
        args: { action, params: ctx.params },
        title: `飞书日历需要批准：${action}`,
        detail: {
          question: `允许这一步吗：${verdict.reason}`,
          options: ["同意", "拒绝"],
          detail:
            `${task.intent}\n动作：feishu/${action}` +
            `\n参数：${JSON.stringify(ctx.params).slice(0, 800)}`,
        },
      };
    },

    stepArgs(action, _req, ctx, extra) {
      return { tool: FEISHU_TOOL_NAME, action, params: ctx.params, task_id: extra.taskId, approval_id: extra.approvalId };
    },

    errorCode(err) {
      return err instanceof FeishuApiError ? err.code : "unexpected";
    },

    resultArtifact(action, _req, ctx, extra) {
      return { ok: true, tool: FEISHU_TOOL_NAME, action, params: ctx.params, data: extra.data };
    },

    lockResource() {
      // 飞书是远端服务，不需要单例锁；按日程主体串行由闸门的 subject_key 保证。
      return null;
    },
  };

  return {
    creds,
    run: (req: HandRequest) => runHandShell(deps, req, spec),
  };
}
