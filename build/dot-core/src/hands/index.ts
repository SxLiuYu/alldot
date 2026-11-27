/**
 * src/hands/index.ts —— 手模块的公开面。
 *
 * 三只手共用 src/hands/hand.ts 的七步壳（runHandShell）：practice（练习文件夹）、
 * desktop（Windows-MCP）、logged_browser / clean_browser（Playwright MCP）。
 * 每只手的差异在各自的 HandSpec 里（动作枚举、闸门输入、落地动作、锁资源）。
 */

export {
  PRACTICE_TOOL_DESCRIPTION,
  PRACTICE_TOOL_PARAMETERS,
  createPracticeTool,
  type PracticeToolDeps,
} from "./tool.ts";

export {
  PRACTICE_TOOL_NAME,
  DOT_HAND_TOOL_NAMES,
  runPracticeHand,
  runHandShell,
  renderList,
  HAND_TEXT_LIMIT,
  type HandDeps,
  type HandRequest,
  type HandOutcome,
  type HandCode,
  type HandData,
  type HandActResult,
  type HandApprovalCard,
  type HandPrepareResult,
  type HandResultExtra,
  type HandSpec,
  type HandStepExtra,
  type HandStop,
} from "./hand.ts";

export {
  PRACTICE_MAX_WRITE_BYTES,
  PRACTICE_MAX_LIST_ENTRIES,
  PracticeError,
  practiceRootOf,
  resolvePracticePath,
  listDir,
  makeDir,
  writeTextFile,
  readTextFileForCheck,
  type PracticeAction,
  type PracticeEntry,
  type ListResult,
  type MkdirResult,
  type WriteResult,
  type ResolvedPath,
} from "./practice.ts";

export {
  snapshotPath,
  type SnapshotRequest,
  type SnapshotDeps,
} from "./snapshot.ts";

export {
  Heartbeat,
  heartbeatPathIn,
  HEARTBEAT_STALE_SECONDS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type HeartbeatOptions,
} from "./heartbeat.ts";

export {
  createWechatHand,
  filterWechatParams,
  isWechatReadOnly,
  normalizeWechatAction,
  validateWechatRequest,
  WECHAT_ACTION_HELP,
  WECHAT_ACTIONS,
  WECHAT_READONLY_ACTIONS,
  WECHAT_TOOL_MAP,
  WECHAT_TOOL_NAME,
  type WechatAction,
  type WechatHand,
  type WechatHandOptions,
} from "./wechat.ts";

export {
  createFeishuHand,
  readFeishuCreds,
  readFeishuCredsFromFile,
  FEISHU_ACTION_HELP,
  FEISHU_ACTIONS,
  FEISHU_READONLY_ACTIONS,
  FEISHU_TOOL_NAME,
  type FeishuAction,
  type FeishuCreds,
  type FeishuHand,
  type FeishuHandOptions,
} from "./feishu.ts";

export {
  WORKER_DENIED_TOOLS,
  BUILTIN_KNOWN_TOOLS,
  createBuiltinGovernor,
  registerBuiltinHooks,
  type BuiltinGovernor,
  type BuiltinHookDeps,
  type BeforeToolCallDecision,
} from "./builtin.ts";

export {
  IdentityTable,
  IdentityMissingError,
  taskIdFromSessionKey,
  type ToolCallIdentity,
  type StoredIdentity,
  type IdentityTableOptions,
} from "./identity.ts";

export {
  FILES_TOOL_NAME,
  FILES_ACTIONS,
  FILES_ACTION_HELP,
  normalizeFilesAction,
  declaredWorkspaceOf,
  runFilesHand,
  type FilesAction,
} from "./files.ts";

// 2026-11-27：命令手。工人的工具表里原来没有它，"跑测试"只能去点桌面开终端。
export {
  EXEC_TOOL_NAME,
  EXEC_TOOL_DESCRIPTION,
  EXEC_TOOL_PARAMETERS,
  runExecHand,
  splitCommand,
} from "./exec.ts";

export {
  createDesktopHand,
  normalizeDesktopAction,
  isDesktopReadOnly,
  readDesktopStatus,
  desktopBatchCount,
  filterDesktopParams,
  expandDesktopSteps,
  DESKTOP_ACTIONS,
  DESKTOP_READONLY_ACTIONS,
  DESKTOP_TOOL_MAP,
  DESKTOP_ACTION_HELP,
  type DesktopAction,
  type DesktopHand,
  type DesktopHandOptions,
  type DesktopStatusSnapshot,
  type DesktopStep,
} from "./desktop.ts";

export {
  createBrowserHand,
  normalizeBrowserAction,
  filterBrowserParams,
  looksLikeSubmit,
  hitCaptchaKeyword,
  MAX_CAPTCHA_HANDOFFS,
  BROWSER_ACTIONS,
  BROWSER_TOOL_MAP,
  BROWSER_ACTION_HELP,
  type BrowserAction,
  type BrowserHand,
  type BrowserHandOptions,
  type BrowserKind,
} from "./browser.ts";

export {
  HAND_LOCK_RESOURCES,
  DEFAULT_HAND_LOCK_TTL_MS,
  acquireHandLock,
  withHandLock,
  peekHandLock,
  type HandLockResource,
  type HandLockOptions,
  type HandLockResult,
  type HandLockHeldBy,
  type WithHandLockResult,
} from "./singleton.ts";

/**
 * 注册身份钩子（A.4 第 1 步的来源）。before_tool_call 里 storeIdentity 之外
 * **不做任何判定**：判定与记账在 execute 内串行做，钩子只负责把身份递进去。
 * 只记我们自己的工具，别把内置工具也塞进来（那会白占表，还容易误配）。
 */
import type { BeforeToolCallEventLike, PluginApiLike } from "../plugin-api.ts";
import { IdentityTable, taskIdFromSessionKey } from "./identity.ts";
import { PRACTICE_TOOL_NAME } from "./hand.ts";

/**
 * 我们自己的工具名。身份钩子只管这些——内置工具由内置治理钩子管，别混。
 * 这张表和实际注册的工具（build/dot-core/index.ts 的 registerOptional / addHand）
 * 必须一一对上：漏一个，那只手就永远拿不到 taskId、一律 identity_missing。
 * 2026-11-25 评审补上 "files"（原先漏了，files 手在真会话里拿不到身份）。
 */
const IDENTITY_TRACKED_TOOLS = new Set<string>([
  PRACTICE_TOOL_NAME,
  "files",
  "exec",
  "desktop",
  "logged_browser",
  "clean_browser",
  "wechat",
  "feishu",
  "dot_recall",
]);

export function registerIdentityHook(api: PluginApiLike, table: IdentityTable): void {
  const handler = (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as BeforeToolCallEventLike;
    if (!IDENTITY_TRACKED_TOOLS.has(e.toolName)) return undefined;
    if (typeof e.toolCallId !== "string" || e.toolCallId === "") return undefined;

    const c = (ctx ?? {}) as {
      agentId?: string;
      sessionKey?: string;
      sessionId?: string;
      runId?: string;
    };
    table.remember(e.toolCallId, {
      agentId: c.agentId,
      sessionKey: c.sessionKey,
      sessionId: c.sessionId,
      runId: c.runId ?? e.runId,
      taskId: taskIdFromSessionKey(c.sessionKey),
    });
    return undefined;
  };
  // 走 api.on：registerHook 写的 registry.hooks 不在 typedHooks 里，
  // 全局 runner 的 hasHooks 恒为 false → 身份钩子永不触发（2026-11-25 实测）。
  if (typeof api.on === "function") {
    api.on("before_tool_call", handler);
  } else {
    api.registerHook("before_tool_call", handler, { name: "dot-core.hands.identity" });
  }
}
