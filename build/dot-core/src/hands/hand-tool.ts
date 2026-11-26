/**
 * src/hands/hand-tool.ts —— 把电脑手 / 浏览器手包成 allbot 认识的插件工具。
 *
 * 与 tool.ts（练习手）分开是为了不动已经在用的文件：形状完全一致
 * （name / description / parameters / execute 四件套），参数同样是**扁平 JSON Schema**，
 * 不写顶层 anyOf（docs/plugins/building-plugins.md:123-144：小模型解析顶层 anyOf 不稳）。
 *
 * 参数约定（三只手一致）：
 *   - `action` 必填，枚举取自各自的动作表；
 *   - `task_id` 只在没有会话身份的直接调用里用（工人会话由 sessionKey 决定）；
 *   - 其余动作参数放 `params` 里原样交给 hand.ts，由各自的 filter*Params 白名单裁剪。
 *
 * 这里不判档、不记账、不锁——那是 hand.ts 的七步壳干的。
 */

import type { AgentToolLike, ToolResultLike } from "../plugin-api.ts";
import type { HandOutcome, HandRequest } from "./hand.ts";
import { DESKTOP_ACTIONS } from "./desktop.ts";
import { BROWSER_ACTIONS } from "./browser.ts";

export const WECHAT_TOOL_NAME = "wechat";
export const DESKTOP_TOOL_NAME = "desktop";
export const LOGGED_BROWSER_TOOL_NAME = "logged_browser";
export const CLEAN_BROWSER_TOOL_NAME = "clean_browser";

export const DESKTOP_TOOL_DESCRIPTION = [
  "操作这台电脑的桌面：status 读状态、snapshot 读界面结构、screenshot 截图、app 切换/打开程序、",
  "click 点击、type 输入、key 按键、scroll 滚动、move 移动鼠标、wait 等待、waitfor 等元素出现。",
  "只读动作直接做；点击、输入、切窗口这类会先出请示卡等人点同意。人一动鼠标键盘，手立刻停下交还人手。",
  "微信不要用这只手点（自绘界面点不准）；要发/读微信走 wechat 那只手。",
].join("");

export const LOGGED_BROWSER_TOOL_DESCRIPTION = [
  "操作「已经登录过」的浏览器（带着你的登录态）：navigate 打开网址、click 点击、type 输入、fill_form 填表、",
  "press_key 按键、select_option 选择、tabs 切标签、snapshot 读页面、screenshot 截图、wait_for 等元素、",
  "handle_dialog 处理弹窗、evaluate 取页面数据。碰到验证码会停下来问你。提交前也会先问你。",
].join("");

export const CLEAN_BROWSER_TOOL_DESCRIPTION = [
  "操作一台「干净」的浏览器（没有任何登录态，用独立 profile）：动作同 logged_browser。",
  "需要登录的站点别用这只手。",
].join("");

export const FEISHU_TOOL_NAME = "feishu";

export const FEISHU_TOOL_DESCRIPTION = [
  "飞书日历：calendars 看我有哪几个日历；events 看某个日历某段时间的日程（默认未来 7 天）；",
  "create 建一条日程（要 summary、start、end，可选 calendar_id、description）；cancel 取消一条（要 event_id，从 events 里拿）。",
  "时间写 2026-11-26T15:00:00+08:00 或 2026-11-26 15:00。看日历直接做；建日程会先出请示卡。",
].join("");

export const WECHAT_TOOL_DESCRIPTION = [
  "操作这台电脑上的微信（真实微信窗口，靠界面自动化）：list 列会话（第一步就用它）；",
  "messages 读当前会话正文；read 按名字读某个会话；open 按名字打开会话；",
  "send 发一条文字（要 text，可选 to）；commit 把输入框里现成的草稿发出去；screenshot 截微信窗口；",
  "status 是排错用的（要翻遍每个桌面找微信，实测 150 秒），不要拿它当第一步。",
  "读的动作直接做；发消息会先出请示卡等人点同意。微信没开或窗口切不过来时会如实说干不了。",
].join("");

/** 三只手共用的参数表骨架；动作枚举各自不同。 */
function parametersFor(actions: readonly string[], actionHint: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: [...actions], description: actionHint },
      task_id: {
        type: "string",
        description: "任务号（账本里 tasks.id）；仅直接调用用，工人会话里由 sessionKey 决定，传了必须一致",
      },
      params: {
        type: "object",
        description: "该动作的具体参数（例如 click 的 x/y，type 的 text，navigate 的 url），原样交给这只手",
        additionalProperties: true,
      },
    },
  };
}

export const FILES_TOOL_NAME = "files";

export const FILES_TOOL_DESCRIPTION = [
  "在任务声明的那个真实文件夹里做事（例如「在桌面建个文件夹」就是桌面上做）：",
  "list 列目录、read 读文件内容、mkdir 建文件夹、write 写 utf8 文本文件。",
  "路径优先写相对根的形式（如 dot-验收/说明.txt）；给根内的绝对路径也会自动折算成相对。",
  "越界、绝对路径落在根外、符号链接一律拒绝；write 默认不覆盖，要覆盖传 overwrite=true。",
  "任务没写工作区时，原话点名了桌面 / 文档 / 下载 / 图片或现成路径，这只手就按那里做；都没点名才拒绝。",
].join("");

/** 与练习手同一套扁平参数（action / path / content / overwrite）。 */
export const FILES_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["list", "read", "mkdir", "write"],
      description: "list=列目录，read=读文件内容，mkdir=建文件夹，write=写文本文件",
    },
    task_id: {
      type: "string",
      description: "任务号（账本里 tasks.id）；仅直接调用用，工人会话里由 sessionKey 决定，传了必须一致",
    },
    path: { type: "string", description: "相对工作区根的路径；list 省略表示根目录，read/mkdir/write 必填" },
    content: { type: "string", description: "write 的内容（utf8 文本）" },
    overwrite: { type: "boolean", description: "write 时是否允许覆盖已有文件，默认 false" },
  },
};

export const DESKTOP_TOOL_PARAMETERS = parametersFor(
  DESKTOP_ACTIONS,
  "status/snapshot/screenshot 只读；app/click/type/key/scroll/move/wait/waitfor 是动作",
);
export const WECHAT_TOOL_PARAMETERS = parametersFor(
  ["status", "list", "messages", "read", "open", "send", "commit", "screenshot"],
  "status/list/messages/read/screenshot 只读；open 打开会话；send/commit 会发消息（要人点）",
);
export const FEISHU_TOOL_PARAMETERS = parametersFor(
  ["calendars", "events", "create", "cancel"],
  "calendars/events 只读；create 建日程、cancel 取消日程（都要人点）",
);
export const BROWSER_TOOL_PARAMETERS = parametersFor(
  BROWSER_ACTIONS,
  "navigate/back/click/type/fill_form/press_key/select_option/tabs/snapshot/screenshot/wait_for/handle_dialog/evaluate",
);

/** 一只手的工具化描述（注册成插件工具、或交给本机工人当 tool 都行）。 */
export interface HandToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(req: HandRequest): Promise<HandOutcome>;
}

function asParams(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 把模型给的原始参数翻成 HandRequest（练手/电脑手/浏览器手都认这一套）。 */
export function handRequestFrom(rawParams: Record<string, unknown>, toolCallId?: string): HandRequest {
  const params = asParams(rawParams);
  const rest = asParams(params["params"]);
  return {
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    taskId: typeof params["task_id"] === "string" ? params["task_id"] : undefined,
    action: typeof params["action"] === "string" ? params["action"] : undefined,
    path: typeof params["path"] === "string" ? params["path"] : undefined,
    content: typeof params["content"] === "string" ? params["content"] : undefined,
    overwrite: params["overwrite"] === true,
    params: rest,
  };
}

/** 工具结果：正文给人看，details 给账本/审计看（与练习手同一套字段）。 */
export function toolResultFrom(outcome: HandOutcome): ToolResultLike {
  return {
    content: [{ type: "text", text: outcome.text }],
    isError: !outcome.ok,
    details: {
      code: outcome.code,
      task_id: outcome.taskId,
      step_id: outcome.stepId,
      approval_id: outcome.approvalId,
      tier: outcome.tier,
      rule: outcome.rule,
      side_effect: outcome.sideEffect,
      result_ref: outcome.resultRef,
    },
  };
}

/** 造工具对象。execute 里只做「翻译 + 交给 hand.ts」。 */
export function createHandTool(spec: HandToolSpec): AgentToolLike {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    async execute(toolCallId: string, rawParams: Record<string, unknown>): Promise<ToolResultLike> {
      const outcome = await spec.run(handRequestFrom(asParams(rawParams), toolCallId));
      return toolResultFrom(outcome);
    },
  };
}
