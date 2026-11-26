/**
 * src/hands/desktop.ts —— 电脑手（Windows-MCP）。
 *
 * 走 A.4 的同一套七步（runHandShell）：身份 → 任务 → 闸门 → 审批 → 单例锁 →
 * 写前记账 → ControlStatus/动作 → 记结果。这里只提供差异面：
 *
 * - 动作枚举（中文报错、英文动作名）：
 *   status / snapshot / screenshot / app / click / type / key / scroll / move / wait / waitfor
 * - 映射到 Windows-MCP 工具：
 *   ControlStatus / Snapshot / Screenshot / App / Click / Type / Shortcut / Scroll / Move / Wait / WaitFor
 * - 只读动作（status / snapshot / screenshot / wait / waitfor）落第 1 档直接执行并记账；
 *   app / click / type / key / scroll / move 由 judge.ts 的 desktop 规则落第 4 档每次问，
 *   手不许自己放行。
 * - 受保护程序（config.desktop.human_only_apps，默认 Weixin/WeChat）命中交给闸门的
 *   0b 条直接 6 档；判断同时看进程名、app 参数和**窗口标题**。
 * - 接管即停：每次动手前（有上一次观测时）先 ControlStatus；坐标或前台窗口变了，
 *   说明人接手了，停下并返回 code="human_took_over"。
 *
 * 为什么只读动作要在 adjustVerdict 里补：judge.ts 的桌面规则是「tool==="desktop"
 * → 4 档」，它不区分动作。本轮不允许改 gate 模块（别的 workflow 在动），所以由
 * desktop 手在判完后只把「规则仍是 irreversible 的只读动作」抬到 1 档；
 * 6 档（受保护/危险）、5 档（身份钱）在它前面，不会被这层修正绕过。
 */

import type { GateInput, TierVerdict } from "../gate/types.ts";
import { setTaskState } from "../ledger/index.ts";
import { McpHttpClient, toolResultText, type McpTransport } from "../mcp/client.ts";
import { NATIVE_HANDLERS } from "./native-desktop.ts";
import {
  runHandShell,
  type HandActResult,
  type HandDeps,
  type HandOutcome,
  type HandRequest,
  type HandSpec,
} from "./hand.ts";

export const DESKTOP_ACTIONS = [
  "status",
  "snapshot",
  "screenshot",
  "app",
  "click",
  "type",
  "key",
  "scroll",
  "move",
  "wait",
  "waitfor",
] as const;
export type DesktopAction = (typeof DESKTOP_ACTIONS)[number];

/** 只读动作：第 1 档，直接执行并记账。 */
export const DESKTOP_READONLY_ACTIONS: readonly DesktopAction[] = Object.freeze([
  "status",
  "snapshot",
  "screenshot",
  "wait",
  "waitfor",
]);

/** 动作 → Windows-MCP 工具名。 */
export const DESKTOP_TOOL_MAP: Readonly<Record<DesktopAction, string>> = Object.freeze({
  status: "ControlStatus",
  snapshot: "Snapshot",
  screenshot: "Screenshot",
  app: "App",
  click: "Click",
  type: "Type",
  key: "Shortcut",
  scroll: "Scroll",
  move: "Move",
  wait: "Wait",
  waitfor: "WaitFor",
});

/** 每个动作允许透传给 Windows-MCP 的参数键（白名单；其余丢掉）。 */
const DESKTOP_ARG_KEYS: Readonly<Record<DesktopAction, readonly string[]>> = Object.freeze({
  status: [],
  snapshot: [],
  screenshot: [],
  app: ["mode", "name", "app", "path", "process", "window"],
  click: ["x", "y", "button", "clicks", "element", "ref", "target"],
  type: ["text", "content", "x", "y"],
  key: ["shortcut", "keys", "key"],
  scroll: ["direction", "amount", "clicks", "x", "y"],
  move: ["x", "y"],
  wait: ["seconds", "ms", "duration"],
  waitfor: ["text", "element", "condition", "timeout", "seconds"],
});

export const DESKTOP_ACTION_HELP =
  "动作不支持：只认 status / snapshot / screenshot / app / click / type / key / scroll / move / wait / waitfor（英文动作名）";

const ACTION_ALIASES: Readonly<Record<string, DesktopAction>> = Object.freeze({
  status: "status",
  state: "status",
  snapshot: "snapshot",
  screenshot: "screenshot",
  screen: "screenshot",
  app: "app",
  launch: "app",
  click: "click",
  type: "type",
  type_text: "type",
  text: "type",
  key: "key",
  keys: "key",
  shortcut: "key",
  press: "key",
  scroll: "scroll",
  move: "move",
  mouse_move: "move",
  wait: "wait",
  sleep: "wait",
  waitfor: "waitfor",
  wait_for: "waitfor",
});

export function normalizeDesktopAction(action: unknown): DesktopAction | null {
  if (typeof action !== "string") return null;
  const key = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ACTION_ALIASES[key] ?? null;
}

export function isDesktopReadOnly(action: string): boolean {
  return (DESKTOP_READONLY_ACTIONS as readonly string[]).includes(action);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 从 Windows-MCP 的 ControlStatus 结果里抠出「人接手」比对的量。 */
export interface DesktopStatusSnapshot {
  /** null = 什么都读不到，不能拿来比对（避免误报人接手）。 */
  signature: string | null;
  cursorX: number | null;
  cursorY: number | null;
  app: string | null;
  window: string | null;
}

export function readDesktopStatus(result: unknown): DesktopStatusSnapshot {
  const outer = asRecord(result);
  const inner = asRecord(outer["structuredContent"] ?? outer["data"] ?? outer);
  const cursor = asRecord(inner["cursor"] ?? inner["mouse"] ?? inner["pointer"]);

  const cursorX = asNumber(cursor["x"] ?? inner["cursor_x"] ?? inner["cursorX"] ?? inner["x"]);
  const cursorY = asNumber(cursor["y"] ?? inner["cursor_y"] ?? inner["cursorY"] ?? inner["y"]);
  const app = firstString(
    inner["active_app"],
    inner["activeApp"],
    inner["process"],
    inner["process_name"],
    inner["app"],
  ) ?? null;
  const window = firstString(
    inner["active_window"],
    inner["activeWindow"],
    inner["window"],
    inner["window_title"],
    inner["title"],
    inner["foreground_window"],
  ) ?? null;
  // 窗口标题会随页面/计时变化（浏览器标题、时钟），拿它做签名会把正常的下一步误判成
  // 「人接手了」。签名只用鼠标坐标 + 进程名 + 窗口句柄（有就用），标题只用于说明/保护判定。
  const windowId = firstString(
    inner["window_id"],
    inner["windowId"],
    inner["hwnd"],
    inner["active_window_id"],
    inner["activeWindowId"],
  ) ?? null;

  const signature =
    cursorX === null && cursorY === null && app === null && windowId === null
      ? null
      : JSON.stringify([cursorX, cursorY, app, windowId]);
  return { signature, cursorX, cursorY, app, window };
}

/** 一次调用里要连点几下：actions/batch/steps 数组长度，或 count 数字。 */
export function desktopBatchCount(params: Record<string, unknown>): number {
  for (const key of ["actions", "batch", "steps", "sequence"]) {
    const value = params[key];
    if (Array.isArray(value)) return value.length;
  }
  const count = params["count"];
  if (typeof count === "number" && Number.isFinite(count)) return Math.max(0, Math.floor(count));
  return 0;
}

export function filterDesktopParams(action: DesktopAction, raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const allowed = DESKTOP_ARG_KEYS[action];
  const params = asRecord(raw);
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

export interface DesktopStep {
  action: DesktopAction;
  params: Record<string, unknown>;
}

/**
 * 把一次调用展开成要真正执行的步骤序列。
 *
 * - 没有 actions/batch/steps/sequence 数组：就一步（外层 action + 白名单参数）；
 * - 有数组：逐项执行，每项可以自带 `action`（不带就沿用外层），参数按**该项的动作**
 *   重新过白名单。这样 `{action:"click", actions:[{x:1,y:2},{x:3,y:4}]}` 是两次点击，
 *   `{action:"click", actions:[{action:"type",text:"hi"}]}` 是改成输入——不是把
 *   `actions` 丢掉后发一个空 Click。
 */
export function expandDesktopSteps(defaultAction: DesktopAction, raw: Record<string, unknown> | undefined): DesktopStep[] {
  const params = asRecord(raw);
  let list: unknown[] | null = null;
  for (const key of ["actions", "batch", "steps", "sequence"]) {
    const value = params[key];
    if (Array.isArray(value)) {
      list = value as unknown[];
      break;
    }
  }
  if (list === null) {
    return [{ action: defaultAction, params: filterDesktopParams(defaultAction, params) }];
  }
  return list.map((item) => {
    const obj = asRecord(item);
    const action = normalizeDesktopAction(obj["action"] ?? defaultAction) ?? defaultAction;
    return { action, params: filterDesktopParams(action, { ...params, ...obj }) };
  });
}

class DesktopMcpError extends Error {
  readonly code = "mcp_error";
  constructor(message: string) {
    super(message);
    this.name = "DesktopMcpError";
  }
}

/**
 * 「人在用电脑」——Windows-MCP 的接管保护。这不是故障，是它在守规矩：
 * 鼠标键盘被真人在用，它就拒绝发动作。2026-11-25 账本里 desktop 的 7 次失败有 6 次是它。
 * 所以不按「工具坏了」处理，而是让任务停下来等人说继续（调度器认 [user_control] 前缀转 paused）。
 */
class DesktopUserControlError extends Error {
  readonly code = "user_control";
  constructor(message: string) {
    super(message);
    this.name = "DesktopUserControlError";
  }
}

/** 拿不到控制权（CONTROL_UNAVAILABLE）：多半是上一次接管没释放，属于环境问题，不是人在用。 */
class DesktopControlUnavailableError extends Error {
  readonly code = "control_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "DesktopControlUnavailableError";
  }
}

/** 把 Windows-MCP 的错误正文翻成我们自己的错误类型：USER_CONTROL 要停下来等人，不是失败。 */
function desktopErrorFrom(mcpName: string, detail: unknown): Error {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
  if (text.includes("USER_CONTROL")) {
    return new DesktopUserControlError(
      `${mcpName} 调用被 Windows-MCP 挡下：你现在在用电脑（USER_CONTROL）。我先停手，你说「继续」我再接着做。`,
    );
  }
  if (text.includes("CONTROL_UNAVAILABLE")) {
    return new DesktopControlUnavailableError(
      `${mcpName} 调用失败：桌面手拿不到控制权（CONTROL_UNAVAILABLE）。` +
        "多半是上一次接管没释放——把 8000 那个电脑手服务重启一次再试。",
    );
  }
  return new DesktopMcpError(`${mcpName} 调用失败：${text}`);
}

interface DesktopContext {
  client: McpHttpClient;
  /** 闸门用的当前窗口进程名（能拿到就给）。 */
  currentApp?: string;
  currentWindow?: string;
  /** 主题键按任务区分「接管后重问」的轮次。 */
  taskId: string | null;
}

export interface DesktopHandOptions {
  /** 直接注入客户端（测试/上层注册表用）。 */
  client?: McpHttpClient;
  /** 注入 transport（测试用，不连真服务器）。 */
  transport?: McpTransport;
  /** 覆盖 config.desktop.mcp_url。 */
  mcpUrl?: string;
  timeoutMs?: number;
}

export interface DesktopHand {
  run(req: HandRequest): Promise<HandOutcome>;
  /** 这只手连的地址（测试断言配置是否生效用）。 */
  readonly mcpUrl: string;
  readonly client: McpHttpClient;
}

interface DesktopState {
  /** 上一次「我们动完」之后观测到的鼠标/前台签名。 */
  baseline: string | null;
  currentApp?: string;
  currentWindow?: string;
  lastSummary?: string;
}

/**
 * 造一只电脑手。状态（上一次观测）按实例保存：同一实例连续跑才有「接管即停」，
 * 不同实例互不影响（测试里每条用例新建一只）。
 */
export function createDesktopHand(deps: HandDeps, opts: DesktopHandOptions = {}): DesktopHand {
  const url = opts.mcpUrl ?? deps.config.desktop.mcp_url;
  const client =
    opts.client ??
    new McpHttpClient({ url, transport: opts.transport, timeoutMs: opts.timeoutMs });
  // 只有真连 MCP（没注入 client）时才走原生拦截；测试注入 client 时走 mock。
  const useNative = opts.client === undefined && opts.transport === undefined;
  const state: DesktopState = { baseline: null };
  /** 人接管过几次（按任务）；进了主题键，接管前批的单不会在接管后被自动复用。 */
  const takeoverEpochs = new Map<string, number>();
  const log = deps.logger ?? (() => {});

  async function probeStatus(): Promise<
    { ok: true; snapshot: DesktopStatusSnapshot } | { ok: false; detail: string }
  > {
    const res = await client.callTool("ControlStatus", {});
    if (!res.ok) return { ok: false, detail: res.detail };
    const snapshot = readDesktopStatus(res.result);
    if (snapshot.app !== null) state.currentApp = snapshot.app;
    if (snapshot.window !== null) state.currentWindow = snapshot.window;
    return { ok: true, snapshot };
  }

  const spec: HandSpec<DesktopContext> = {
    toolName: "desktop",
    normalize: (req) => normalizeDesktopAction(req.action),
    badActionText: DESKTOP_ACTION_HELP,

    async prepare(_deps, task, action, req) {
      // 第一次动作没有「上一次是我们动的」可比，不去多调一次 MCP：
      // 这样 click 出请示卡之前不会碰任何键鼠，也不会因为状态读失败而少一张审批单。
      if (state.baseline === null) {
        return { ok: true, ctx: { client, currentApp: state.currentApp, currentWindow: state.currentWindow, taskId: task.id } };
      }

      const probe = await probeStatus();
      if (!probe.ok) {
        return {
          ok: false,
          code: "failed",
          text: `读不到桌面状态，先不动手：${probe.detail}`,
        };
      }
      const snap = probe.snapshot;
      if (snap.signature !== null && snap.signature !== state.baseline) {
        const reason = "检测到人接管了桌面（鼠标或前台窗口变了）：手停下，交还人手";
        takeoverEpochs.set(task.id, (takeoverEpochs.get(task.id) ?? 0) + 1);
        // 把「人动手后」的状态记成新基线：人把桌面交回来、任务恢复之后，
        // 下一步不会因为同一个旧差异再被拦一次。
        state.baseline = snap.signature;
        state.lastSummary = snap.signature;
        try {
          setTaskPaused(deps, task.id, reason);
        } catch (err) {
          log("warn", `标记任务暂停失败：${(err as Error).message}`);
        }
        const where = [snap.window, snap.app].filter((x): x is string => typeof x === "string").join(" / ");
        return {
          ok: false,
          code: "human_took_over",
          text:
            `${reason}。` +
            `上次观测：${state.lastSummary ?? "（无）"}；现在：${snap.signature}` +
            (where === "" ? "" : `（${where}）`) +
            `。这一步（${action}）没有执行。`,
        };
      }
      return { ok: true, ctx: { client, currentApp: snap.app ?? state.currentApp, currentWindow: snap.window ?? state.currentWindow, taskId: task.id } };
    },

    gateInput(action, req, ctx) {
      const params = asRecord(req.params);
      const windowTitle = firstString(params["window"], params["title"], params["window_title"], ctx.currentWindow);
      const app = firstString(params["app"], params["process"], params["appName"], ctx.currentApp);
      const target = firstString(
        params["target"],
        params["element"],
        params["ref"],
        params["window"],
        params["x"] !== undefined && params["y"] !== undefined ? `${String(params["x"])},${String(params["y"])}` : undefined,
      );
      const args: Record<string, unknown> = { ...params };
      // 窗口标题也进 args：judge 的受保护程序判定会看 args.window（不只进程名）。
      if (windowTitle !== undefined) args["window"] = windowTitle;
      return {
        tool: "desktop",
        action,
        args,
        app,
        target,
        protectedApps: deps.config.desktop.human_only_apps,
      };
    },

    adjustVerdict(verdict, action) {
      if (isDesktopReadOnly(action) && verdict.tier === 4 && verdict.rule === "irreversible") {
        return {
          tier: 1,
          rule: "desktop_readonly",
          reason: "电脑上的只读动作（状态/快照/截图/等待），放行记账",
          handling: "allow",
          sideEffect: "safe",
          judgeNeeded: false,
        };
      }
      return verdict;
    },

    subjectParams(action, req, ctx) {
      const steps = expandDesktopSteps(action as DesktopAction, req.params).map((step) => ({
        action: step.action,
        params: step.params,
      }));
      const epoch = ctx.taskId === null ? 0 : (takeoverEpochs.get(ctx.taskId) ?? 0);
      return {
        action,
        steps,
        // 人接管过之后再提交，旧批单不复用（「接管后再问一次」）。
        ...(epoch > 0 ? { takeover_epoch: epoch } : {}),
      };
    },

    snapshotTarget() {
      // 桌面没有可 restore 的文件目标：屏幕状态无法还原。
      // 第 2 档的桌面动作本轮不存在（只读=1、键鼠=4），真需要取证时走 Snapshot 动作本身。
      return null;
    },

    validate(action, req) {
      const limit = deps.config.desktop.batch_actions;
      const count = desktopBatchCount(asRecord(req.params));
      if (count > limit) {
        return {
          code: "denied",
          text: `一次最多连做 ${limit} 下（config.desktop.batch_actions），这次要 ${count} 下：拒绝。请拆成多次调用，每次做完看一眼再继续。`,
        };
      }
      // 动作名本身已经在 normalize 里校验过，这里只挡批量。
      void action;
      return null;
    },

    async act(action, req, ctx): Promise<HandActResult> {
      const steps = expandDesktopSteps(action as DesktopAction, req.params);
      const done: Array<{ action: DesktopAction; tool: string; params: Record<string, unknown>; result: unknown }> = [];

      for (const step of steps) {
        const mcpName = DESKTOP_TOOL_MAP[step.action];
        // 先试原生实现（screenshot / wait / status）：不依赖 Windows-MCP 进程，
        // 1-2 秒就回，不会超时。只在真连 MCP 时启用（测试注入 client 时走 mock）。
        const nativeHandler = useNative ? NATIVE_HANDLERS[mcpName] : undefined;
        if (nativeHandler !== undefined) {
          const nat = await nativeHandler(step.params);
          if (nat.ok) {
            done.push({ action: step.action, tool: `${mcpName}(native)`, params: step.params, result: nat.result });
            if (step.action === "status") {
              const snap = readDesktopStatus(nat.result);
              if (snap.signature !== null) {
                state.baseline = snap.signature;
                state.lastSummary = snap.signature;
              }
              if (snap.app !== null) state.currentApp = snap.app;
              if (snap.window !== null) state.currentWindow = snap.window;
            }
            continue;
          }
          // 原生失败：记日志但不抛，走 MCP 兜底
          done.push({ action: step.action, tool: `${mcpName}(native-fallback)`, params: step.params, result: nat.detail ?? "" });
        }
        const res = await ctx.client.callTool(mcpName, step.params);
        if (!res.ok) throw desktopErrorFrom(mcpName, res.detail);
        done.push({ action: step.action, tool: mcpName, params: step.params, result: res.result });

        if (step.action === "status") {
          const snap = readDesktopStatus(res.result);
          if (snap.signature !== null) {
            state.baseline = snap.signature;
            state.lastSummary = snap.signature;
          }
          if (snap.app !== null) state.currentApp = snap.app;
          if (snap.window !== null) state.currentWindow = snap.window;
        }
      }

      // 非纯 status 的动作做完再观测一次，作为下一次「人有没有接手」的基线。
      // 失败不致命：这一下的结果已经拿到了，别把成功改成失败。
      const onlyStatus = steps.length === 1 && steps[0]?.action === "status";
      if (!onlyStatus) {
        const probe = await probeStatus();
        if (probe.ok && probe.snapshot.signature !== null) {
          state.baseline = probe.snapshot.signature;
          state.lastSummary = probe.snapshot.signature;
        }
      }

      const lines = done.map((item) => {
        const body = toolResultText(item.result).trim();
        return `- ${item.action}（${item.tool}）${body === "" ? "完成" : `：${body.slice(0, 500)}`}`;
      });
      return {
        data: { action, steps: done },
        summary: `桌面动作 ${action} 完成 ${done.length} 步：\n${lines.join("\n")}`,
      };
    },

    errorCode(err) {
      if (err instanceof DesktopUserControlError) return "user_control";
      if (err instanceof DesktopControlUnavailableError) return "control_unavailable";
      return err instanceof DesktopMcpError ? err.code : "unexpected";
    },

    approvalCard(action, req, _ctx, task, verdict) {
      const steps = expandDesktopSteps(action as DesktopAction, req.params);
      return {
        args: { action, steps },
        title: `电脑操作需要批准：${action}${steps.length > 1 ? `（${steps.length} 步）` : ""}`,
        detail: {
          question: `允许这一步吗：${verdict.reason}`,
          options: ["同意", "拒绝"],
          detail:
            `${task.intent}\n工具：desktop/${action}` +
            `\n步骤：${steps.map((s) => `${s.action}(${DESKTOP_TOOL_MAP[s.action]})`).join(" → ")}` +
            `\n参数：${JSON.stringify(steps.map((s) => s.params)).slice(0, 800)}`,
        },
      };
    },

    stepArgs(action, req, _ctx, extra) {
      const steps = expandDesktopSteps(action as DesktopAction, req.params);
      return {
        tool: "desktop",
        action,
        steps,
        task_id: extra.taskId,
        approval_id: extra.approvalId,
        snapshot: extra.verdict.handling === "snapshot" ? "planned" : "not_required",
      };
    },

    resultArtifact(action, req, _ctx, extra) {
      const steps = expandDesktopSteps(action as DesktopAction, req.params);
      return {
        ok: true,
        tool: "desktop",
        action,
        steps,
        data: extra.data,
        snapshot: extra.snapshotRef !== null ? "created" : "not_required",
        approval_id: extra.approvalId,
      };
    },

    lockResource() {
      return "hand:desktop";
    },
  };

  return {
    mcpUrl: url,
    client,
    run: (req: HandRequest) => runHandShell(deps, req, spec),
  };
}

/** 交还人手时把任务挂到「等人」：paused + blocked_on.type=human。 */
function setTaskPaused(deps: HandDeps, taskId: string, reason: string): void {
  setTaskState(deps.db, taskId, "paused", {
    reason,
    blocked_on: { type: "human", reason },
  });
}
