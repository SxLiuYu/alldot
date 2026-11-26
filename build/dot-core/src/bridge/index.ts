/**
 * src/bridge/index.ts —— 桥模块的公开面。
 *
 * 两个使用者：
 * - build/dot-bridge/index.mjs（8799 独立服务）→ createBridgeService
 * - dot-core 的插件入口 → registerBridgeRoutes（18789 上的 /dot/bridge/v1）
 */

export { resolveDotPaths, type DotPathOptions, type DotPaths } from "./paths.ts";

export {
  readBridgeToken,
  readGatewayToken,
  tokensEqual,
  tokenFromRequest,
  tokenCookie,
  TokenCache,
  GatewayTokenCache,
  type TokenState,
  type GatewayTokenState,
} from "./token.ts";

export {
  HttpError,
  MAX_BODY_BYTES,
  readBody,
  readJsonBody,
  sendJson,
  sendText,
  sendHtml,
  sendEmpty,
  parseRequestUrl,
  isLoopbackAddress,
  escapeHtml,
  formatBytes,
  HTML_SECURITY_HEADERS,
} from "./http.ts";

export {
  readKeepState,
  parseKeepState,
  diskAdmission,
  keepHeaderLine,
  balanceLine,
  normalizeLevel,
  emptyKeepView,
  type HealthLevel,
  type KeepView,
  type KeepBalanceEntry,
  type KeepComponent,
  type AdmissionDecision,
} from "./keep.ts";

export {
  BrainClient,
  BrainUnavailableError,
  BrainHttpError,
  DEFAULT_UPSTREAM_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  type BrainClientOptions,
} from "./upstream.ts";

export {
  readLedgerView,
  readArtifact,
  readApproval,
  type LedgerView,
  type TaskCardView,
  type ApprovalView,
  type RecoveryView,
  type ArtifactRead,
  type ReadLedgerOptions,
} from "./view.ts";

export {
  buildApprovalNotice,
  DsBotNotifier,
  BridgeNotifyClient,
  DEFAULT_DSBOT_BOT,
  DEFAULT_NOTIFY_ERROR_PATH,
  type ApprovalNotice,
  type Notifier,
  type NotifyResult,
} from "./notify.ts";

export {
  renderStatusPage,
  type StatusPageModel,
  type BrainProbeView,
} from "./page.ts";

export {
  BRAIN_TOOLS,
  BRAIN_TOOL_NAMES,
  isBrainToolName,
  knownTool,
  callBrainTool,
  admissionFromKeep,
  type BrainToolName,
  type BridgeToolContext,
  type ToolDefinition,
  type ToolResult,
  type ToolTextContent,
} from "./tools.ts";

export {
  handleMcpMessage,
  handleMcpBody,
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  type McpContext,
  type McpHttpPayload,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./mcp.ts";

export {
  createBridgeService,
  BRIDGE_NAME,
  BRIDGE_VERSION,
  DEFAULT_PORT,
  DEFAULT_MIN_FREE_MB,
  type BridgeService,
  type BridgeServiceOptions,
  type BridgeRuntimeState,
} from "./server.ts";

export {
  createBridgeRouteHandler,
  registerBridgeRoutes,
  mapAnswerToDecision,
  BRIDGE_ROUTE_BASE,
  type BridgeRouteDeps,
  type BridgeRouteHandler,
} from "./routes.ts";
