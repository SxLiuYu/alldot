/**
 * index.ts —— dot-core 插件的入口（方案 B.4：jiti 直载 TypeScript，不打包）。
 *
 * 这一层只做接线，不做业务：
 *   1. 跑 A.7 两条启动断言（只读 api.config，失败就抛，让 allbot 判定加载失败）
 *   2. 读配置：`<dotDir>/config.json` 打底，`plugins.entries.dot-core.config`（api.pluginConfig）
 *      覆盖其上——这样两个位置写都算数，不会「写进 allbot.json 却被静默忽略」
 *   3. 打开账本并迁移；写心跳（keeper 的 fail-closed 判据，见 src/hands/heartbeat.ts）
 *   4. 接上：练习手 + 身份钩子、内置工具治理钩子、锚点钩子、gateway_start 恢复、桥路由
 *   5. gateway_start 起派发器（取活循环），gateway_stop 停（src/dispatch/）
 *
 * 顺序有讲究：断言在开账本之前（断言不过不留下建了一半的 dot.db）；心跳在账本就绪之后
 * （账本没好就不该让 keeper 以为一切正常）。
 *
 * 本文件不写 allbot.json、不碰 ~/.dsh、不起服务；装载与配置改动写在
 * build/dot-core/安装说明.md 里，由安装的人执行。
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrate,
  openLedger,
  recordSpend,
  recover,
  appendEvent,
  listTasks,
  SCHEMA_VERSION,
  verifyLedger,
  type LedgerDb,
} from "./src/ledger/index.ts";
import { gbToBytes, sweepSnapshots } from "./src/maintenance/index.ts";
import {
  BridgeNotifyClient,
  readBridgeToken,
  registerBridgeRoutes,
  resolveDotPaths,
  type DotPaths,
} from "./src/bridge/index.ts";
import {
  assertStartup,
  configPathIn,
  loadConfig,
  parseConfig,
  type DotCoreConfig,
  type StartupCheck,
} from "./src/config.ts";
import { DOT_CORE_CONFIG_SCHEMA } from "./src/config-schema.ts";
import {
  Heartbeat,
  heartbeatPathIn,
  IdentityTable,
  PRACTICE_TOOL_NAME,
  createBrowserHand,
  createDesktopHand,
  createPracticeTool,
  createFeishuHand,
  readFeishuCredsFromFile,
  createWechatHand,
  runFilesHand,
  registerIdentityHook,
  registerBuiltinHooks,
  type BuiltinGovernor,
  type HandDeps,
} from "./src/hands/index.ts";
import {
  BROWSER_TOOL_PARAMETERS,
  CLEAN_BROWSER_TOOL_DESCRIPTION,
  CLEAN_BROWSER_TOOL_NAME,
  DESKTOP_TOOL_DESCRIPTION,
  DESKTOP_TOOL_NAME,
  DESKTOP_TOOL_PARAMETERS,
  FILES_TOOL_DESCRIPTION,
  FILES_TOOL_NAME,
  FILES_TOOL_PARAMETERS,
  LOGGED_BROWSER_TOOL_DESCRIPTION,
  LOGGED_BROWSER_TOOL_NAME,
  WECHAT_TOOL_DESCRIPTION,
  WECHAT_TOOL_NAME,
  FEISHU_TOOL_DESCRIPTION,
  FEISHU_TOOL_NAME,
  FEISHU_TOOL_PARAMETERS,
  WECHAT_TOOL_PARAMETERS,
  createHandTool,
  type HandToolSpec,
} from "./src/hands/hand-tool.ts";
import { createRecallPluginTool, RECALL_TOOL_NAME, registerAnchorHook } from "./src/context/index.ts";
import { afterSettle, Dispatcher } from "./src/dispatch/index.ts";
import { createLocalWorkerRuntime, createPoolModelComplete } from "./src/dispatch/local-worker.ts";
import { runDriftCheck } from "./src/drift/index.ts";
import { createSayRewriter } from "./src/say/index.ts";
import { collectMetrics } from "./src/selfeval/index.ts";
import { skillIndexPath } from "./src/skills/index.ts";
import { createLiveAutoApproveMaxTier } from "./src/runtime/live-config.ts";
import { proposeImprovementsWithReason, proposalsToday } from "./src/selfimprove/index.ts";
import { deployReadyPatch, generatePatchForProposal } from "./src/selfimprove/pipeline.ts";
import {
  registerHookCompat,
  type PluginApiLike,
  type PluginDefinitionLike,
  type SubagentRuntimeLike,
} from "./src/plugin-api.ts";

/** 与 package.json 的 version 一致（有测试比对）。 */
export const PLUGIN_VERSION = "0.2.0";
export const PLUGIN_ID = "dot-core";

export interface DotCoreOptions {
  /** 覆盖 home（默认 os.homedir()）。 */
  home?: string;
  /** 覆盖 `~/.allbot/dot`。 */
  dotDir?: string;
  ledgerPath?: string;
  tokenPath?: string;
  keepPath?: string;
  /** 覆盖 dot 配置文件路径（默认 <dotDir>/config.json）。 */
  configPath?: string;
  /** snapshots 根（默认 <dotDir>/snapshots）。 */
  snapshotsRoot?: string;
  /** 心跳间隔毫秒；默认 60000，0 = 只写一次不设定时器（测试用）。 */
  heartbeatIntervalMs?: number;
  /** 直接给配置对象（测试用；给了就不读文件，也不叠 pluginConfig）。 */
  config?: DotCoreConfig;
}

export interface DotCoreHandle {
  db: LedgerDb;
  config: DotCoreConfig;
  paths: DotPaths;
  checks: StartupCheck[];
  identity: IdentityTable;
  heartbeat: Heartbeat;
  governor: BuiltinGovernor;
  /** 取活循环。测试可以直接调 tickOnce()，不必起网关。 */
  dispatch: Dispatcher;
  /** 停心跳、停派发、关账本。网关关闭时调用；测试也必须调，否则 Windows 删不掉临时目录。 */
  stop: () => void;
}

function envOptions(): DotCoreOptions {
  const env = process.env;
  const opts: DotCoreOptions = {};
  if (env["DOT_CORE_HOME"]) opts.home = env["DOT_CORE_HOME"];
  if (env["DOT_CORE_DOT_DIR"]) opts.dotDir = env["DOT_CORE_DOT_DIR"];
  if (env["DOT_CORE_LEDGER"]) opts.ledgerPath = env["DOT_CORE_LEDGER"];
  if (env["DOT_CORE_BRIDGE_TOKEN"]) opts.tokenPath = env["DOT_CORE_BRIDGE_TOKEN"];
  if (env["DOT_CORE_KEEP_FILE"]) opts.keepPath = env["DOT_CORE_KEEP_FILE"];
  if (env["DOT_CORE_CONFIG_FILE"]) opts.configPath = env["DOT_CORE_CONFIG_FILE"];
  if (env["DOT_CORE_SNAPSHOTS_DIR"]) opts.snapshotsRoot = env["DOT_CORE_SNAPSHOTS_DIR"];
  return opts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 真正干活的部分。单独导出是为了能在测试里用一个假 api 跑完整个装载流程，
 * 不必起 allbot 网关。
 */
export function registerDotCore(api: PluginApiLike, opts: DotCoreOptions = {}): DotCoreHandle {
  const log = (level: "info" | "warn" | "error", message: string): void => {
    const logger = api.logger;
    if (logger === undefined) return;
    const fn = logger[level];
    if (typeof fn === "function") fn(`[dot-core] ${message}`);
  };

  // ── 0) A.7 两条启动断言：先断言，后开账本 ─────────────────────────────────
  const checks = assertStartup(api.config as Parameters<typeof assertStartup>[0]);
  for (const check of checks) log("info", `启动断言通过：${check.id}（${check.detail}）`);

  // ── 1) 配置：文件打底，pluginConfig 覆盖 ────────────────────────────────
  // 注意：resolveDotPaths 的 configPath 指的是 ~/.allbot/allbot.json（桥只读它拿 token），
  // dot 自己的配置是另一个文件，别塞进那个字段。
  const paths = resolveDotPaths({
    home: opts.home,
    dotDir: opts.dotDir,
    ledgerPath: opts.ledgerPath,
    tokenPath: opts.tokenPath,
    keepPath: opts.keepPath,
  });
  const configFile = opts.configPath ?? configPathIn(paths.dotDir);
  let config = opts.config ?? loadConfig(configFile, { missingOk: true });
  if (opts.config === undefined && isPlainObject(api.pluginConfig) && Object.keys(api.pluginConfig).length > 0) {
    try {
      config = parseConfig(api.pluginConfig, "plugins.entries.dot-core.config", config);
      log("info", "配置：已叠加 plugins.entries.dot-core.config");
    } catch (err) {
      throw new Error(`plugins.entries.dot-core.config 不合法：${(err as Error).message}`);
    }
  }
  log(
    "info",
    `配置：${opts.config === undefined ? configFile : "(注入对象)"}；练习根 ${config.practice.root ?? "(未配)"}`,
  );

  // ── 2) 账本：打开 + 迁移 ────────────────────────────────────────────────
  let db: LedgerDb;
  try {
    db = openLedger(paths.ledgerPath);
    const migrated = migrate(db);
    log("info", `账本 ${paths.ledgerPath} 就绪（schema ${SCHEMA_VERSION}，应用迁移 ${migrated.applied.length} 条）`);
  } catch (err) {
    // 账本打不开＝没有唯一写入口＝不许跑（A.5）。静默降级会让手裸奔。
    throw new Error(`dot-core 账本打不开（${paths.ledgerPath}）：${(err as Error).message}`);
  }

  // ── 3) 心跳（keeper 的 fail-closed 判据）────────────────────────────────
  const heartbeat = new Heartbeat({
    path: heartbeatPathIn(paths.dotDir),
    intervalMs: opts.heartbeatIntervalMs ?? undefined,
    meta: { version: PLUGIN_VERSION, plugin: PLUGIN_ID },
  });
  heartbeat.start();
  log("info", `心跳：${heartbeat.path}（间隔 ${heartbeat.intervalMs}ms）`);

  // ── 4) 通知通道：请示卡交给桥 ───────────────────────────────────────────
  const notify = async (approvalId: string): Promise<{ ok: boolean; detail: string }> => {
    const token = readBridgeToken(paths.tokenPath);
    if (token.token === null) {
      const detail = `桥 token 读不到（${token.error ?? "未知"}）：请示卡 #${approvalId} 没有转发`;
      log("warn", detail);
      return { ok: false, detail };
    }
    const client = new BridgeNotifyClient({ token: token.token });
    const result = await client.notify(approvalId);
    log(result.ok ? "info" : "warn", `请示卡 #${approvalId} 转给桥：${result.detail}`);
    return { ok: result.ok, detail: result.detail };
  };

  // ── 5) 手：身份表 + 练习工具 + 内置工具治理 ──────────────────────────────
  const identity = new IdentityTable();
  const snapshotsRoot = opts.snapshotsRoot ?? join(paths.dotDir, "snapshots");

  // 注册方式（2026-11-25 按评审复核 allbot 源码，别按直觉猜）：
  //
  // 1) `optional: true` **不是**「注册失败不影响加载」，而是「没进显式白名单就不给模型」：
  //    C:/allbot-public/src/plugins/tools.ts:146-154 会对 optional 工具做
  //    isOptionalToolAllowed 过滤，:38-55 在 allowlist 为空时直接返回 false；allowlist
  //    只来自显式 tools.allow（src/agents/pi-tools.ts:561-571、src/gateway/tool-resolution.ts:82-92），
  //    而 tools.profile=full 在 src/agents/tool-catalog.ts:345 是空策略。
  //    所以给宿主 agent 用的两件（practice / dot_recall）用 optional: false，
  //    只给本机工人用的四件（files / desktop / logged_browser / clean_browser）保持
  //    optional: true —— 工人的工具表由 src/dispatch/local-worker.ts 自己拼，不经过这层过滤。
  //
  // 2) `api.registerTool` 本身不抛错（allbot-src/src/plugins/registry.ts:171-196），
  //    真正会炸的是**构造工具**那一步（MCP 客户端起不来、配置读不到）。所以 try/catch
  //    包住 make()：哪一件造不出来只少这一件，插件照样加载（插件掉线＝大脑、账本、闸门全没）。
  const safeRegister = (
    name: string,
    make: () => Parameters<PluginApiLike["registerTool"]>[0],
    opts: { optional?: boolean },
    detail: string,
  ): void => {
    let tool: Parameters<PluginApiLike["registerTool"]>[0];
    try {
      tool = make();
    } catch (err) {
      log("warn", `${name} 造不出来（这件工具不可用，插件照常加载）：${(err as Error).message}`);
      return;
    }
    try {
      api.registerTool(tool, opts);
      log("info", `已注册工具 ${name}（${detail}）`);
    } catch (err) {
      log("warn", `${name} 注册失败（不影响别的工具）：${(err as Error).message}`);
    }
  };

  safeRegister(
    PRACTICE_TOOL_NAME,
    () => createPracticeTool({ db, config, identity, notify, snapshotsRoot, logger: log }),
    { optional: false },
    "练习文件夹三件事，走闸门 + 写前记账 + 快照",
  );
  registerIdentityHook(api, identity);
  // dot_recall：A.10 第三类上下文（按编号取回）。只读账本，宿主侧过闸门落 1 档
  // （src/hands/builtin.ts 的 gateInputFor → recallGateInput）；本机工人的工具表另有一份。
  safeRegister(
    RECALL_TOOL_NAME,
    () => createRecallPluginTool(db, identity),
    { optional: false },
    "按编号取回步骤明细 / 快照说明（只读，1 档）",
  );

  // 另外四只手（文件 / 电脑 / 浏览器）注册成 optional 插件工具（只给本机工人用），
  // 同时进工人的工具表；哪一只建不起来只少那一只。
  // 自动同意档位要能改完马上生效（改 config.json 后最多 20 秒），不用为它重启网关。
  const liveAutoApprove = createLiveAutoApproveMaxTier(configFile, config.approvals.auto_approve_max_tier);
  const handDeps: HandDeps = {
    db,
    config,
    identity,
    notify,
    snapshotsRoot,
    logger: log,
    liveSettings: { autoApproveMaxTier: liveAutoApprove },
  };
  const handTools: HandToolSpec[] = [];
  const addHand = (name: string, make: () => HandToolSpec): void => {
    let spec: HandToolSpec;
    try {
      spec = make();
    } catch (err) {
      log("warn", `${name} 建不起来（这只手不可用，不影响别的工具）：${(err as Error).message}`);
      return;
    }
    try {
      api.registerTool(createHandTool(spec), { optional: true });
      log("info", `已接上 ${name}（工人工具表 + optional 插件工具；走闸门 + 记账 + 单例锁）`);
    } catch (err) {
      log("warn", `${name} 插件工具没能注册（工人的工具表里仍有它）：${(err as Error).message}`);
    }
    handTools.push(spec);
  };
  addHand(FILES_TOOL_NAME, () => ({
    name: FILES_TOOL_NAME,
    description: FILES_TOOL_DESCRIPTION,
    parameters: FILES_TOOL_PARAMETERS,
    run: (req) => runFilesHand(handDeps, req),
  }));
  addHand(DESKTOP_TOOL_NAME, () => {
    const hand = createDesktopHand(handDeps);
    return {
      name: DESKTOP_TOOL_NAME,
      description: DESKTOP_TOOL_DESCRIPTION,
      parameters: DESKTOP_TOOL_PARAMETERS,
      run: (req) => hand.run(req),
    };
  });
  for (const [kind, name, description] of [
    ["logged_browser", LOGGED_BROWSER_TOOL_NAME, LOGGED_BROWSER_TOOL_DESCRIPTION],
    ["clean_browser", CLEAN_BROWSER_TOOL_NAME, CLEAN_BROWSER_TOOL_DESCRIPTION],
  ] as const) {
    addHand(name, () => {
      const hand = createBrowserHand(handDeps, kind);
      return {
        name,
        description,
        parameters: BROWSER_TOOL_PARAMETERS,
        run: (req) => hand.run(req),
      };
    });
  }

  // 微信：只在配置开着时接（默认开）。服务没起不影响别的工具，调了就是「干不了」。
  if (config.wechat.enabled) {
    addHand(WECHAT_TOOL_NAME, () => {
      const hand = createWechatHand(handDeps);
      return {
        name: WECHAT_TOOL_NAME,
        description: WECHAT_TOOL_DESCRIPTION,
        parameters: WECHAT_TOOL_PARAMETERS,
        run: (req) => hand.run(req),
      };
    });
  }

  // 飞书日历：凭据直接读 allbot.json（跟桥读网关 token 同一个文件，不另存一份）。
  // 没凭据就不挂这只手 —— 挂了也只会每次都回「没凭据」，白占工人工具表一格。
  const feishuCreds = readFeishuCredsFromFile(paths.configPath);
  if (feishuCreds !== null) {
    addHand(FEISHU_TOOL_NAME, () => {
      const hand = createFeishuHand(handDeps, { creds: feishuCreds });
      return {
        name: FEISHU_TOOL_NAME,
        description: FEISHU_TOOL_DESCRIPTION,
        parameters: FEISHU_TOOL_PARAMETERS,
        run: (req) => hand.run(req),
      };
    });
  } else {
    log("warn", "飞书手没挂上：allbot.json 里没有 channels.feishu 的 appId/appSecret");
  }

  const governor = registerBuiltinHooks(api, { db, config, notify, logger: log });
  log("info", "已注册内置工具钩子（工人会话里每个工具都过闸门并记账；process/subagents 等直接拒）");

  // ── 6) 上下文：锚点 ─────────────────────────────────────────────────────
  registerAnchorHook(api, { db, logger: log });
  log("info", "已注册 before_prompt_build 锚点钩子（只管 task:* 工人会话）");

  // ── 7) A.9 恢复协议：加载时校验 + 恢复，gateway_start 再兜一次 ──────────
  //
  // 两条事实（都在源码里，2026-11-25 复核）：
  // 1) 注册通道必须是 `api.on`（类型化钩子），不是 `api.registerHook`：
  //    global runner 的 `hasHooks` 查的是 `registry.typedHooks`
  //    （allbot-src/src/plugins/hooks.ts:1094-1096），而 `api.registerHook` 写的是
  //    `registry.hooks`（plugins/registry.ts:197-260）。写错通道 = 钩子永不执行。
  //    统一走 registerHookCompat（src/plugin-api.ts），没有 `on` 的老构建退回 registerHook。
  // 2) 时机：这套安装里 dot-core 是**延迟加载**的（server.impl.ts:3074
  //    reloadDeferredGatewayPlugins，隔离演练网关日志：dot-core 08:08:56 才注册，
  //    而 gateway_start 在 08:08:49 已触发），所以只在钩子里做恢复 = 一次都不做。
  //    改法：加载时先跑一遍恢复，钩子留着兜住「插件先加载、钩子后触发」的构建；
  //    recover() 自身幂等（src/ledger/recover.ts 注释），跑两次不会重复建单。
  const runRecovery = (): void => {
    const integrity = verifyLedger(db);
    if (!integrity.ok) {
      const detail = `账本完整性校验失败（chain=${integrity.chain.ok}，steps=${integrity.steps.ok}）：拒绝继续，先修账本`;
      log("error", detail);
      throw new Error(detail);
    }
    const report = recover(db, { approvalTtlHours: config.approvals.ttl_hours });
    log(
      "info",
      `恢复协议：${report.headline}（epoch+${report.runEpochBumped.length}，孤儿 ${report.orphans.length}，` +
        `回队 ${report.tasksRequeued.length}，转等人 ${report.tasksAwaitingHuman.length}）`,
    );
  };
  runRecovery();
  const recoverChannel = registerHookCompat(api, "gateway_start", runRecovery, "dot-core.gateway.recover");
  log("info", `恢复协议已在加载时执行；gateway_start 钩子（${recoverChannel}）再兜一次`);

  // ── 8) 桥：18789 上的 /dot/bridge/v1 ────────────────────────────────────
  // 说人话改写（第 3 步 C）：开关默认关；关着就**不注入** say，桥的卡片逐字不动。
  // 改写失败在 say 层退回原文，不影响 /status。complete 与结算小结/跑偏裁判共用。
  const poolComplete = createPoolModelComplete(config);
  const complete = async (prompt: string): Promise<string> =>
    (await poolComplete({ messages: [{ role: "user", content: prompt }], tools: [] })).text;
  // 要「一整段 JSON」的调用（自我优化提案）单独一份，预算给到 2500：
  // 1200 会被思考吃掉，正文回空串（2026-11-25 真机连续两次 self_proposal_skipped：
  // 「模型回了空文本，不提案」）。
  const poolJson = createPoolModelComplete(config, undefined, undefined, { maxTokens: 2500 });
  const completeJson = async (prompt: string): Promise<string> =>
    (await poolJson({ messages: [{ role: "user", content: prompt }], tools: [] })).text;
  const say = config.say.enabled ? createSayRewriter({ enabled: true, complete }) : undefined;
  // 自我优化要落地的目录：仓库根（本文件在 build/dot-core/ 下，往上一级就是仓库根）
  const selfImproveRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\/]+$/, "");
  registerBridgeRoutes(
    api as unknown as Parameters<typeof registerBridgeRoutes>[0],
    {
      db,
      tokenPath: paths.tokenPath,
      keepPath: paths.keepPath,
      // 部署补丁要查开关（deploy.ts 里 fail-closed：不给配置就当关着）
      selfImproveConfig: config,
      // /settings 读写的就是 dot 自己的 config.json（用实际加载的那个路径，不是默认路径）
      configPath: configFile,
      /**
       * 自我优化的最后一段：审批一落定就接着往下走，不用人再手动调函数
       * （2026-11-25 复核：applyProposal 全仓没有生产调用点，点「同意」什么也不会发生）。
       *   第一张卡（提案，detail 里只有 proposal_id）→ 生成补丁 + 跑测试，并再出一张「要不要上机」的卡
       *   第二张卡（补丁，detail 里有 patch_id）      → 备份、打补丁、跑测试，不过回滚
       * 拒绝一律什么都不做。
       */
      onApprovalDecided: ({ decision, approval }) => {
        if (decision !== "approved") return;
        let detail: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(approval.detail_json ?? "{}");
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            detail = parsed as Record<string, unknown>;
          }
        } catch {
          return;
        }
        const proposalId = typeof detail["proposal_id"] === "string" ? detail["proposal_id"] : "";
        if (proposalId === "") return;
        const patchId = typeof detail["patch_id"] === "string" ? detail["patch_id"] : "";
        const pipeline = {
          db,
          root: selfImproveRoot,
          config,
          complete: completeJson,
          reloadRequestPath: join(paths.dotDir, "state", "reload-request.json"),
          logger: log,
        };
        if (patchId !== "") {
          const res = deployReadyPatch(pipeline, patchId);
          appendEvent(db, {
            type: res.ok ? "self_deploy_done" : "self_deploy_failed",
            payload: { patch_id: patchId, reason: res.reason, backup: res.backupDir, reload: res.reloadRequested },
          });
          log(res.ok ? "info" : "warn", `自我优化补丁 ${patchId} 上机${res.ok ? "成功" : "失败"}：${res.reason}`);
          return;
        }
        const kindRaw = typeof detail["kind"] === "string" ? detail["kind"] : "code";
        const kind: "config" | "prompt" | "code" = kindRaw === "config" || kindRaw === "prompt" ? kindRaw : "code";
        const proposal = {
          id: proposalId,
          kind,
          target: typeof detail["target"] === "string" ? detail["target"] : "",
          why: typeof detail["why"] === "string" ? detail["why"] : "",
          evidence: typeof detail["evidence"] === "string" ? detail["evidence"] : "",
          proposedChange:
            typeof detail["proposedChange"] === "string"
              ? detail["proposedChange"]
              : typeof detail["proposed_change"] === "string"
                ? detail["proposed_change"]
                : "",
          risk: typeof detail["risk"] === "string" ? detail["risk"] : "",
          expectedGain: typeof detail["expectedGain"] === "string" ? detail["expectedGain"] : "",
        };
        if (proposal.target === "" || proposal.proposedChange === "") return;
        void generatePatchForProposal(pipeline, proposal)
          .then((r) => log(r.ok ? "info" : "warn", `提案 ${proposalId} 生成补丁${r.ok ? "成功" : "没成"}：${r.reason}`))
          .catch((err: unknown) => log("warn", `提案 ${proposalId} 生成补丁抛错：${(err as Error).message}`));
      },
      ...(say === undefined ? {} : { say }),
    },
  );
  log(
    "info",
    `已挂桥路由（token ${paths.tokenPath}，keep ${paths.keepPath}，说人话改写 ${say === undefined ? "关" : "开"}）`,
  );

  // ── 9) 派发：加载时起取活循环，gateway_start / gateway_stop 兜底 ────────
  // 理由同上（延迟加载 → 钩子已经过去了）。start() 幂等，两条路径都跑只会多一行日志。
  // 万一加载真的发生在网关装好兜底请求上下文之前，第一轮 tick 里 subagent.run 会抛，
  // 派发器把任务原样放回 queued 重试（src/dispatch/scheduler.ts 的 returnToQueue），
  // 不会把任务烧成 failed。
  //
  // `api.runtime` 是**惰性 getter**：这套安装的构建里解析不到插件运行时模块
  // （allbot-src/src/plugins/loader.ts:1152「Unable to resolve plugin runtime module」），
  // 直接读会让 register 抛错、整个插件（工具/钩子/桥路由）一起掉线。
  //
  // 拿不到宿主运行时就用**本机工人**（src/dispatch/local-worker.ts）：派发器自己带模型循环，
  // 工具走我们自己的手。2026-11-25 实测：连网关 WS 那条退路也不行——共享令牌连上来是
  // 没有权限的（allbot 自己的测试：「shared token => connected with cleared scopes」，
  // 调 agent 回 missing scope: operator.write），所以只能自己带工人。
  let subagent: SubagentRuntimeLike | undefined;
  let runtimeSource = "宿主";
  try {
    subagent = api.runtime?.subagent;
    if (subagent === undefined) throw new Error("api.runtime.subagent 不可用");
  } catch (err) {
    runtimeSource = "本机工人";
    log("warn", `宿主运行时不可用，改用本机工人（不依赖网关 WS 权限）：${(err as Error).message}`);
    try {
      subagent = createLocalWorkerRuntime({
        db,
        config,
        logger: log,
        // identity 必须给：四只手的第一步都是「取身份」（src/hands/hand.ts:resolveIdentity），
        // 身份表在、而这次 toolCallId 没登记过 → 一律 refusal("identity_missing")。
        // 工人不是宿主会话、不触发 before_tool_call 钩子，所以由工人在每次调用前
        // 自己补登记（local-worker.ts runLoop 里的 identityTable.remember）。
        handDeps: { notify, snapshotsRoot, identity, liveSettings: { autoApproveMaxTier: liveAutoApprove } },
        extraHands: handTools,
        // dot_recall 进工人的工具表（读账本，不落步骤）；系统提示词里会给一句用法。
        enableRecall: true,
        // skillbook 也进工人工具表（读技能库里的做法说明，不落步骤）。
        // 索引由 build/tools/skills-index.mjs 生成；没有索引时这条工具会说「先建索引」。
        skillIndexPath: skillIndexPath(paths.dotDir),
        // 每轮用量写 spend_ledger：这是「预算过八成」重排点的分子
        // （config.budget.tokens 是分母，见下面的 afterSettle）。
        onUsage: (input) => {
          try {
            recordSpend(db, {
              task_id: input.taskId,
              model: input.model,
              input_tokens: input.usage.input_tokens,
              output_tokens: input.usage.output_tokens,
            });
          } catch (err) {
            log("warn", `任务 ${input.taskId} 用量记账失败：${(err as Error).message}`);
          }
        },
      });
    } catch (workerErr) {
      subagent = undefined;
      log("error", `本机工人也建不起来，派发器待命：${(workerErr as Error).message}`);
    }
  }
  // 结算之后的收尾：里程碑快照 → 阶段小结 → 推进里程碑 → 记重排点 → 跑偏裁判
  // （src/dispatch/after-settle.ts）。小结与裁判都走模型池（与工人同一个地址）；
  // 拿不到模型时各自退成 skipped / unclear，不影响结算（也不假装 on_track）。
  // complete 已在上面的桥接线段定义（说人话改写与这里共用同一份）。
  // ── 自我优化：结算之后看一次账本，提改动建议（只写账本 + 请示卡，绝不改源码）──
  // 2026-11-25 用户要求「这个默认开」：能力默认开，开关仍在 config.self_improve.enabled，
  // 但**出闸是硬的**：apply.ts 的黑名单（闸门/拒绝名单/账本/看门狗/selfimprove 自己）
  // 一律拒绝，改配置也只能走请示卡等人点。提案上限 max_proposals_per_day（默认 2）。
  let lastProposeAt = 0;
  const proposeAfterSettle = async (taskId: string): Promise<void> => {
    if (config.self_improve.enabled !== true) return;
    // 到当天上限就不再调模型：不然每个任务结算都白花一次调用。
    try {
      if (proposalsToday(db) >= config.self_improve.max_proposals_per_day) return;
    } catch {
      return;
    }
    // 两次提案至少隔 10 分钟：连着结算三单就提三次会很吵。
    if (Date.now() - lastProposeAt < 10 * 60 * 1000) return;
    lastProposeAt = Date.now();
    try {
      // 证据三路（2026-11-25 用户要求「根据历史会话的问题和用户反馈改进」）：
      //   1) 失败/中断的步骤（工具的原文报错）；
      //   2) 没做成的任务（意图 + 账本给的终态原因）——很多失败根本没落步骤，只看步骤会漏光；
      //   3) 用户反馈（对话里点「不对」写进来的 user_feedback）——用户说的比账本更准。
      const samples: string[] = [];
      for (const row of db
        .prepare(
          "select tool, status, substr(coalesce(error,''),1,160) e from steps where status in ('failed','interrupted') order by rowid desc limit 8",
        )
        .all() as Array<{ tool: string; status: string; e: string }>) {
        samples.push(`步骤 ${row.tool} ${row.status}${row.e === "" ? "" : `：${row.e}`}`);
      }
      for (const row of db
        .prepare(
          "select substr(intent,1,80) i, substr(coalesce(state_reason,''),1,160) r from tasks where state = 'failed' order by created_at desc limit 6",
        )
        .all() as Array<{ i: string; r: string }>) {
        samples.push(`任务「${row.i}」没做成：${row.r || "账本没写原因"}`);
      }
      for (const row of db
        .prepare("select payload_json p from events where type = 'user_feedback' order by seq desc limit 8")
        .all() as Array<{ p: string }>) {
        try {
          const payload = JSON.parse(row.p) as { verdict?: string; note?: string; task_id?: string };
          const verdict = payload.verdict === "good" ? "说这条做对了" : "说这条不对";
          samples.push(`用户${verdict}${payload.note ? `：${String(payload.note).slice(0, 200)}` : "（没写原因）"}`);
        } catch {
          // 坏 JSON 当没这条
        }
      }
      const outcome = await proposeImprovementsWithReason({
        db,
        metrics: collectMetrics(db),
        samples,
        complete: completeJson,
        config,
      });
      if (outcome.proposals.length > 0) {
        log("info", `自我优化：任务 ${taskId} 结算后提了 ${outcome.proposals.length} 条改动建议（等你在审批里点）`);
      } else {
        log("warn", `自我优化：这一轮没提（${outcome.reason}）`);
      }
    } catch (err) {
      log("warn", `自我优化提案失败：${(err as Error).message}`);
    }
  };

  const dispatch = new Dispatcher({
    db,
    config,
    // 进程级独占：网关会把这个插件加载两次（2026-11-26 日志 06:04:38 [gateway] 与
    // 06:06:27 [plugins] 各起一个派发器，max_concurrent=3 实际跑成 6）。两次装载是两个
    // jiti 模块副本，靠 Dispatcher 自己的 started 挡不住；锁名取账本路径，同一进程里
    // 第二份实例 start() 会直接放弃起循环（src/dispatch/scheduler.ts 的 ownerRegistry）。
    lockKey: paths.ledgerPath,
    runtime: subagent === undefined ? undefined : { subagent },
    logger: log,
    afterSettle: async (input) => {
      const report = await afterSettle(
        {
          db,
          snapshotsRoot,
          budgetTokens: config.budget.tokens,
          complete,
          // 跑偏裁判：off_track 由裁判自己写 state_reason + drift_verdict 事件，
          // 任务终态一律不改（done 不会因此变 failed）。
          judgeDrift: (drift) => runDriftCheck({ db, complete, logger: log }, drift),
          logger: log,
        },
        input,
      );
      await proposeAfterSettle(input.taskId);
      return report;
    },
  });
  dispatch.start();
  registerHookCompat(api, "gateway_start", () => dispatch.start(), "dot-core.dispatch.start");

  // ── 快照回收：配置里 keepalive.snapshots_max_gb 早就写了，但一直没人执行 ──
  // 2026-11-25 真机上快照目录长到 12 GB，C 盘只剩 10 MB，之后所有写动作全 ENOSPC。
  // 口径：只删旧任务的快照目录，正在跑/排队的留着；账本里的历史行不动。
  const sweepNow = (): void => {
    try {
      const live = listTasks(db, { state: ["running", "queued"] }).map((t) => t.id);
      const out = sweepSnapshots({
        root: snapshotsRoot,
        limitBytes: gbToBytes(config.keepalive.snapshots_max_gb),
        keepTaskIds: live,
      });
      if (out.removed.length > 0) {
        const freedMb = Math.round(out.freedBytes / 1024 / 1024);
        appendEvent(db, {
          type: "snapshots_reclaimed",
          payload: { removed: out.removed.length, freed_mb: freedMb, kept_mb: Math.round(out.keptBytes / 1024 / 1024) },
        });
        log("info", `快照回收：删了 ${out.removed.length} 个任务目录，腾出 ${freedMb} MB`);
      }
    } catch (err) {
      log("warn", `快照回收失败（不影响主流程）：${(err as Error).message}`);
    }
  };
  const sweepTimer = setInterval(sweepNow, 30 * 60 * 1000);
  (sweepTimer as { unref?: () => void }).unref?.();
  // 启动后再跑一次：真机上出事的时候，等半小时太久了。
  const sweepBoot = setTimeout(sweepNow, 15_000);
  (sweepBoot as { unref?: () => void }).unref?.();
  const stopChannel = registerHookCompat(
    api,
    "gateway_stop",
    () => dispatch.stop(),
    "dot-core.dispatch.stop",
  );
  log(
    "info",
    `派发器已就位（dispatch.enabled=${config.dispatch.enabled}，间隔 ${config.dispatch.interval_ms}ms，` +
      `单会话 ${config.dispatch.session_timeout_ms}ms，执行通道 ${runtimeSource}` +
      `${subagent === undefined ? "（不可用，只排队不派发）" : ""}，停止钩子 ${stopChannel}）`,
  );

  return {
    db,
    config,
    paths,
    checks,
    identity,
    heartbeat,
    governor,
    dispatch,
    stop: () => {
      dispatch.stop();
      heartbeat.stop();
      clearInterval(sweepTimer);
      clearTimeout(sweepBoot);
      try {
        db.close();
      } catch {
        // 已经关了就算了
      }
    },
  };
}

/** 插件清单里的模块定义。allbot 走 jiti 直载本文件，默认导出即可。 */
const plugin: PluginDefinitionLike = {
  id: PLUGIN_ID,
  name: "dot-core",
  version: PLUGIN_VERSION,
  description: "dot 合并方案的大脑：账本唯一写入口、闸门、手、上下文锚点、桥路由",
  configSchema: DOT_CORE_CONFIG_SCHEMA as unknown as Record<string, unknown>,
  register(api: PluginApiLike): void {
    registerDotCore(api, envOptions());
  },
};

export default plugin;
