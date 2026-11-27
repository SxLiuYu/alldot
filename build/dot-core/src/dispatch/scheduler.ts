/**
 * src/dispatch/scheduler.ts —— 取活循环（派发器）。方案 A.9 的入口：把 queued 任务
 * 变成一次工人会话，会话结束后给任务下结论。
 *
 * 一轮 tick 做四件事：
 *   1. 开关 / 运行时 / 完整性校验三道门；任何一道不过就一个都不领。
 *   2. `listTasks({ state: "queued", newestFirst: false })` 按 created_at 先来先做。
 *   3. `claimTask`（账本里的单事务认领：条件 UPDATE + workers 行 + task 锁 + epoch 对齐）。
 *   4. 逐个起工人会话：`runtime.subagent.run`，等 `waitForRun`，再 `settleTask`。
 *
 * 三个边界，写死在代码里：
 * - 派发器**不判档、不批审批**。闸门在钩子里（src/hands/builtin.ts、src/hands/hand.ts），
 *   这里只负责别绕过它：不把任务改成 done，也不替人做决定。
 *   **唯一例外**（2026-11-27 加）：到期的审批单由这里收口（`sweepExpiredApprovals`）。
 *   不点就永远挂着的路是死锁——真机上账本里 4 个任务因此停了一整天（审批过期了，
 *   任务还停在 awaiting_approval）。到期按 A.6 的口径算「不同意」，任务随之终止。
 * - 会话超时按「等满 session_timeout_ms」算，不是按 `waitForRun` 一次的返回算。
 *   一次 waitForRun 超时只说明「这个窗口内没结束」，运行可能还在跑，所以继续等。
 * - 完整性校验**每轮要派任务前都跑一次、不缓存**（审核指出过缓存到 stop/start 的问题：
 *   启动之后账本中途断链，缓存的「通过」会让派发继续）。空转不扫全链，只在有活要派时查。
 *
 * 已知限制（如实写）：
 * - 一次 tick 领到 max_concurrent 个任务后就等它们全部结束才进下一轮；长会话期间
 *   后面的任务排队。这是「先来先做」的直接代价，不是 bug。
 * - 会话被中止时 `waitForRun` 也返回 timeout（allbot-src/src/gateway/server-methods/
 *   agent-job.ts:89-92），本轮没有第二个查询接口，只能按超时处理（→ paused，人可见）。
 * - 派发不传 provider/model：合成客户端没有 admin 权限，传了会被拒
 *   （allbot-src/src/gateway/server-plugins.ts:310-328）。
 */

import {
  claimTask,
  expireDueApprovals,
  getTask,
  listTasks,
  parseBlockedOn,
  randomId,
  releaseLock,
  renewLock,
  listApprovals,
  requeueAttempts,
  requeueTask,
  setTaskState,
  upsertWorker,
  verifyLedger,
  type LedgerDb,
  type TaskRow,
  type TaskState,
} from "../ledger/index.ts";
import { resumeAfterDecision } from "./resume.ts";
import type { DotCoreConfig } from "../config.ts";
import type { PluginRuntimeLike, SubagentRuntimeLike, SubagentWaitResultLike } from "../plugin-api.ts";
import { buildWorkerPrompt } from "./prompt.ts";
import { TIMEOUT_REASON, settleTask, type SettleOutcome } from "./settle.ts";

/** 工人在「人在用电脑」时给错误打的标记；调度器见到它把任务判成暂停，而不是失败。 */
export const USER_CONTROL_PREFIX = "[user_control]";
import type { DispatchLogger, TickReport, WorkerRunReport } from "./types.ts";

/** 一次 waitForRun 最多等多久；到点没结果就续锁再等，总时长由 session_timeout_ms 卡。 */
const DEFAULT_WAIT_SLICE_MS = 30_000;
/** 每轮 tick 最多看多少个 queued 任务（够填满 max_concurrent 就行，别一把抓全表）。 */
const QUEUE_SCAN_LIMIT = 50;
/** 超时任务最多自动重排几次（用完留在 paused 等真人）。 */
const MAX_TIMEOUT_REQUEUES = 1;
/** 派发通道没就绪时最多重排几次（第 3 次还起不来就判 failed，别无限重试）。 */
const MAX_DISPATCH_ATTEMPTS = 3;
/** 派发通道失败的重排理由前缀：requeueAttempts 按它只数这一类，别把里程碑推进算进来。 */
const DISPATCH_FAILURE_PREFIX = "派发通道没就绪";
/** 超时补救的重排理由前缀；同样只数这一类。 */
const TIMEOUT_REQUEUE_PREFIX = "超时后重新排队";

export interface DispatchVerifyResult {
  ok: boolean;
  detail: string;
}

export interface DispatcherDeps {
  db: LedgerDb;
  config: DotCoreConfig;
  /** 插件 api 上的运行时；没有 subagent 就只记日志、不派发。 */
  runtime?: PluginRuntimeLike;
  logger?: DispatchLogger;
  /** 注入时钟，测试用。 */
  now?: () => number;
  /** 注入等待，测试用（默认 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 覆盖完整性校验（测试用）。默认 verifyLedger。 */
  verify?: () => DispatchVerifyResult;
  /** 覆盖单次 waitForRun 的窗口，测试用。 */
  waitSliceMs?: number;
  /**
   * 结算之后的收尾（里程碑快照、阶段小结、推进里程碑、记重排点）。
   * 由 index.ts 注入 src/dispatch/after-settle.ts 的 afterSettle；不给就什么都不做。
   * 抛错只记日志，不影响本轮结算结论。
   */
  afterSettle?: (input: { taskId: string; outcome: SettleOutcome }) => Promise<unknown>;
  /**
   * 进程级独占键（index.ts 传账本路径）。同一个进程里只有拿到这个键的实例真的起循环。
   *
   * 为什么需要：网关会**把插件加载两次**（2026-11-26 日志 gateway-concurrency-1126-060316.log
   * 第 36 行 [gateway] 与第 71 行 [plugins] 各跑了一遍装载，两次都起了派发器）。两次装载是
   * 两个 jiti 模块副本，`this.started` 这种实例字段、模块级变量都跨不过去，所以单个实例的
   * 幂等挡不住。只有挂在 globalThis 上的登记表是两份副本共享的。
   *
   * 不给就不做进程级互斥（单元测试直接构造 Dispatcher 时用）。
   */
  lockKey?: string;
}

/**
 * 进程级「谁在跑派发器」登记表。挂在 globalThis 上、用 Symbol.for 取键：
 * 同一个进程里两份模块副本读到的是同一张表（模块级变量做不到这件事）。
 */
interface DispatchOwnerRegistry {
  owners: Map<string, object>;
}

const OWNER_REGISTRY_KEY = Symbol.for("dot-core.dispatch.owner");

function ownerRegistry(): DispatchOwnerRegistry {
  const slot = globalThis as unknown as Record<symbol, DispatchOwnerRegistry | undefined>;
  const existing = slot[OWNER_REGISTRY_KEY];
  if (existing !== undefined) return existing;
  const created: DispatchOwnerRegistry = { owners: new Map() };
  slot[OWNER_REGISTRY_KEY] = created;
  return created;
}

function defaultVerify(db: LedgerDb): DispatchVerifyResult {
  try {
    const result = verifyLedger(db);
    if (result.ok) return { ok: true, detail: `链 ${result.chain.count} 条、步 ${result.steps.rowCount} 行都对得上` };
    return {
      ok: false,
      detail:
        `完整性校验失败（chain.ok=${result.chain.ok}，brokenAt=${String(result.chain.brokenAt)}，` +
        `steps.ok=${result.steps.ok}，问题 ${result.steps.issues.length} 处）：不派发，先修账本`,
    };
  } catch (err) {
    return { ok: false, detail: `完整性校验抛错：${(err as Error).message}（不派发）` };
  }
}

export class Dispatcher {
  private readonly db: LedgerDb;
  private readonly config: DotCoreConfig;
  private readonly runtime: PluginRuntimeLike | undefined;
  private readonly log: DispatchLogger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verify: () => DispatchVerifyResult;
  private readonly waitSliceMs: number;
  private readonly afterSettle: ((input: { taskId: string; outcome: SettleOutcome }) => Promise<unknown>) | null;
  private readonly lockKey: string | null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ticking = false;
  private lastCheckOk: boolean | null = null;
  private refusalLogged = false;
  private runtimeErrorLogged = false;

  constructor(deps: DispatcherDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.runtime = deps.runtime;
    this.log = deps.logger ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.verify = deps.verify ?? (() => defaultVerify(this.db));
    this.waitSliceMs = Math.max(1, deps.waitSliceMs ?? DEFAULT_WAIT_SLICE_MS);
    this.afterSettle = deps.afterSettle ?? null;
    this.lockKey = deps.lockKey ?? null;
  }

  get enabled(): boolean {
    return this.config.dispatch.enabled;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** 运行时是否真的能派发（`api.runtime` 可能是惰性 Proxy，读属性会抛）。 */
  get ready(): boolean {
    return this.subagentOrNull() !== null;
  }

  /**
   * 取 subagent，读不到就返回 null。
   * `api.runtime` 在解析不到插件运行时模块的构建里会在**读属性时**抛
   * （allbot-src/src/plugins/loader.ts:1152），所以每次访问都包一层：
   * 抛错不能让插件加载失败，也不能让 tick 崩。
   */
  private subagentOrNull(): SubagentRuntimeLike | null {
    try {
      return this.runtime?.subagent ?? null;
    } catch (err) {
      if (!this.runtimeErrorLogged) {
        this.runtimeErrorLogged = true;
        this.log(
          "warn",
          `api.runtime 不可用（这套构建没有插件运行时模块）：派发器待命，不派发。原因：${(err as Error).message}`,
        );
      }
      return null;
    }
  }

  /** 只跑一轮，返回这一轮的结论。测试直接用；生产由 start() 的定时器调用。 */
  async tickOnce(): Promise<TickReport> {
    const cfg = this.config.dispatch;
    if (!cfg.enabled) {
      return { status: "disabled", detail: "dispatch.enabled=false：不认领", claimed: [], results: [] };
    }
    const subagent = this.subagentOrNull();
    if (subagent === null) {
      return {
        status: "no_runtime",
        detail: "api.runtime.subagent 不可用（这套构建没有插件运行时模块，或还没到 gateway_start）",
        claimed: [],
        results: [],
      };
    }
    if (this.ticking) {
      return { status: "idle", detail: "上一轮还没跑完，这一轮跳过", claimed: [], results: [] };
    }

    this.ticking = true;
    try {
      // 先把账本里「该有人管」的任务捞出来：到期的审批单、已批准但没重排的、超时后停在 paused、还没补救过的。
      this.sweepExpiredApprovals();
      this.sweepResolvedApprovals();
      const revived = this.reviveTimeoutPaused();
      const queued = listTasks(this.db, { state: "queued", newestFirst: false, limit: QUEUE_SCAN_LIMIT });
      if (queued.length === 0) {
        return {
          status: "idle",
          detail: revived.length === 0 ? "没有 queued 任务" : `重排了 ${revived.length} 个超时任务，等下一轮`,
          claimed: revived,
          results: [],
        };
      }

      // 完整性校验放在「确实有活要派」之后：空转时不每 5 秒扫一遍全链，
      // 但只要这一轮要领任务，就先校验，不缓存在实例上（启动后中途断链照样停手）。
      const check = this.preflight();
      if (!check.ok) {
        return { status: "refused", detail: check.detail, claimed: [], results: [] };
      }

      const claimed: string[] = [];
      const jobs: Array<Promise<WorkerRunReport>> = [];
      for (const candidate of queued) {
        if (claimed.length >= cfg.max_concurrent) break;
        const workerId = randomId("worker");
        const sessionKey = `task:${candidate.id}`;
        const claim = claimTask(this.db, candidate.id, {
          workerId,
          sessionKey,
          lockTtlMs: cfg.lock_ttl_ms,
        });
        if (!claim.claimed || claim.task === null) {
          this.log(
            "info",
            `任务 ${candidate.id} 没领到（${claim.reason}${claim.heldBy === null ? "" : `，锁在 ${claim.heldBy.workerId} 手里`}）`,
          );
          continue;
        }
        claimed.push(candidate.id);
        // .catch() 兜底：runWorker 同步抛错时（如 buildWorkerPrompt 炸了），
        // Promise.all 不该因此 reject——那会让 finally 立刻清掉 ticking，
        // 下一轮 tick 在本轮工人还没跑完时就进来，绕过 max_concurrent
        // （2026-11-26 真机：6 个任务在同一秒被 claim，max_concurrent=3）。
        jobs.push(
          this.runWorker(claim.task, workerId, subagent).catch((err: unknown) => ({
            taskId: claim.task!.id,
            workerId,
            sessionKey: `task:${claim.task!.id}`,
            runId: null,
            outcome: "failed" as const,
            state: null,
            detail: `runWorker 抛错：${(err as Error).message}`,
          })),
        );
      }

      if (jobs.length === 0) {
        return { status: "idle", detail: "queued 里的任务都没领到（锁被占或已被别人领走）", claimed, results: [] };
      }

      const results = await Promise.all(jobs);
      return {
        status: "dispatching",
        detail: `派发 ${results.length} 个任务：${results.map((r) => `${r.taskId}=${r.outcome}`).join("，")}`,
        claimed,
        results,
      };
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 起循环。由 gateway_start 钩子调用。
   * 幂等：重复调用只记一条日志。`enabled=false` 时什么都不做（也不再计时）。
   */
  start(): void {
    if (!this.config.dispatch.enabled) {
      this.log("warn", "dispatch.enabled=false：派发器不启动（看门狗停用中）");
      return;
    }
    if (this.subagentOrNull() === null) {
      this.log(
        "warn",
        "api.runtime.subagent 不可用：派发器不启动（这套构建没有插件运行时模块，或不在 gateway_start 之后）",
      );
      return;
    }
    if (this.started) {
      this.log("info", "派发器已在运行，重复 start 忽略");
      return;
    }
    // 进程级独占：网关把插件加载两次时，每份副本各有一个 Dispatcher。实例级 started
    // 拦不住第二份（它是另一个模块副本），所以这里查 globalThis 上的登记表。
    if (this.lockKey !== null) {
      const registry = ownerRegistry();
      const owner = registry.owners.get(this.lockKey);
      if (owner !== undefined && owner !== this) {
        this.log(
          "warn",
          `派发器没启动：这个进程里已有另一份实例在扫同一个账本（${this.lockKey}）；` +
            `并发上限是全局的，第二份不起循环`,
        );
        return;
      }
      registry.owners.set(this.lockKey, this);
    }
    this.started = true;
    this.lastCheckOk = null; // 每次启动重新校验一次账本
    this.refusalLogged = false;
    this.log(
      "info",
      `派发器启动：每 ${this.config.dispatch.interval_ms}ms 扫一次 queued，` +
        `单会话上限 ${this.config.dispatch.session_timeout_ms}ms，一次最多 ${this.config.dispatch.max_concurrent} 个`,
    );
    this.schedule(0);
  }

  /** 停循环。由 gateway_stop 钩子与 DotCoreHandle.stop 调用。已经在跑的会话不打断。 */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 只有持有者才放锁：另一份实例 stop 时不该把别人的锁放掉。
    if (this.lockKey !== null) {
      const registry = ownerRegistry();
      if (registry.owners.get(this.lockKey) === this) registry.owners.delete(this.lockKey);
    }
    if (this.started) this.log("info", "派发器已停（不再从 queued 领新任务）");
    this.started = false;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduled();
    }, Math.max(0, delayMs));
    // 不拦住进程退出：网关关掉时不应该因为派发器定时器还在等就退不出去。
    const handle = this.timer as unknown as { unref?: () => void };
    if (typeof handle.unref === "function") handle.unref();
  }

  private async runScheduled(): Promise<void> {
    try {
      const report = await this.tickOnce();
      if (report.status === "dispatching") {
        this.log("info", `派发：${report.detail}`);
      } else if (report.status === "refused") {
        // preflight 已经把原因记成 error 了；这里只补一次，别每 5 秒刷同一句。
        if (!this.refusalLogged) {
          this.refusalLogged = true;
          this.log("warn", `派发暂停：${report.detail}`);
        }
      } else if (report.status === "no_runtime" && !this.refusalLogged) {
        this.refusalLogged = true;
        this.log("warn", `派发暂停：${report.detail}`);
      }
    } catch (err) {
      // 定时器里抛出去就是未处理的 rejection；这里收住，下一轮照常。
      this.log("error", `派发 tick 抛错（下一轮继续）：${(err as Error).message}`);
    } finally {
      if (this.started) this.schedule(this.config.dispatch.interval_ms);
    }
  }

  private preflight(): DispatchVerifyResult {
    // 不缓存结论：启动后账本中途断链也要立刻停手（审核指出过缓存到 stop/start 的问题）。
    // 只在「本轮真要派任务」时调用，空转不扫全链。
    const result = this.verify();
    if (!result.ok) {
      if (this.lastCheckOk !== false) this.log("error", `派发前完整性校验：${result.detail}`);
      this.lastCheckOk = false;
      this.refusalLogged = true;
      return result;
    }
    if (this.lastCheckOk !== true) this.log("info", `派发前完整性校验：${result.detail}`);
    this.lastCheckOk = true;
    this.refusalLogged = false;
    return result;
  }

  /**
   * 到期的审批单在派发这一轮收口（2026-11-27 加）。
   *
   * 为什么必须有人扫：审批只在「有人点」的时候才发现过期（bridge/approvals.ts）。
   * 没人点，pending 就一直挂着，任务永远停在 awaiting_approval——真机账本里
   * 有 4 个任务因此停了一整天（11-26 22:00 建的单，第二天还是 awaiting_approval）。
   *
   * 到期按 A.6 的口径算「不同意」：expired → resumeAfterDecision 把任务终止。
   * 这不是替人做决定，是不让「没人管」变成「永远管不了」。
   */
  /**
   * 「已经批了、但任务还挂在等人」的单，要有人把它接上。
   *
   * 2026-11-27 真机：手机上点「同意」走的是桥的 `/api/approvals/answer`，它只往
   * approvals / decisions 两张表写结论（桥从设计上只碰这两张），重排逻辑在网关的
   * routes.ts 里。结果从桥上批准的卡两张都接不上——审批 approved，任务原地停在
   * awaiting_approval，epoch 不动。手机上点同意等于没点。
   *
   * 这里每轮扫一遍：状态 approved、任务还在 awaiting_approval / paused 的，交给
   * resumeAfterDecision（它自己会判「还有别的未决单就先不重排」）。已经重排过的
   * 任务状态不是 awaiting_approval，下一轮自然扫不到，不会重复 bump epoch。
   */
  private sweepResolvedApprovals(): string[] {
    let rows: Array<{ id?: string }> = [];
    try {
      rows = this.db
        .prepare(
          `SELECT a.id AS id FROM approvals a JOIN tasks t ON t.id = a.task_id
             WHERE a.status = 'approved' AND t.state IN ('awaiting_approval', 'paused')
             LIMIT 20`,
        )
        .all() as Array<{ id?: string }>;
    } catch {
      return [];
    }
    const resumed: string[] = [];
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (id === "") continue;
      try {
        const result = resumeAfterDecision(this.db, id);
        if (result.action !== "left") {
          resumed.push(`${id}→${result.action}`);
          this.log("info", `审批 ${id} 已批准但任务没重排：补上（${result.detail}）`);
        }
      } catch (err) {
        this.log("warn", `审批 ${id} 补重排失败（下一轮再试）：${(err as Error).message}`);
      }
    }
    return resumed;
  }

  private sweepExpiredApprovals(): string[] {
    const now = new Date();
    let due: Array<{ id?: string }> = [];
    try {
      due = this.db
        .prepare("SELECT id FROM approvals WHERE status = 'pending' AND pending_until < ?")
        .all(now.toISOString()) as Array<{ id?: string }>;
    } catch {
      // 账本这一刻读不了就别把派发带崩，下一轮再来。
      return [];
    }
    if (due.length === 0) return [];
    expireDueApprovals(this.db, now);
    const closed: string[] = [];
    for (const row of due) {
      const id = String(row.id ?? "");
      if (id === "") continue;
      try {
        const result = resumeAfterDecision(this.db, id);
        closed.push(`${id}→${result.action}`);
        this.log("info", `审批 ${id} 已过期：${result.detail}`);
      } catch (err) {
        this.log("warn", `审批 ${id} 过期后收口失败（下一轮再试）：${(err as Error).message}`);
      }
    }
    return closed;
  }

  /**
   * 超时停在 paused 的任务要有一次「重新排队」的机会，否则一次超时就永久没人管。
   * 有界：每个任务最多补救 `MAX_TIMEOUT_REQUEUES` 次（按 task_requeued 事件计数），
   * 用完就留在 paused 等真人；只认「会话超时」这一个原因，别的 paused 不碰。
   */
  private reviveTimeoutPaused(): string[] {
    const paused = listTasks(this.db, { state: "paused", newestFirst: false, limit: QUEUE_SCAN_LIMIT });
    const revived: string[] = [];
    for (const task of paused) {
      const blocked = parseBlockedOn(task.blocked_on_json);
      const reason = `${task.state_reason ?? ""} ${blocked?.reason ?? ""}`;
      if (!reason.includes(TIMEOUT_REASON)) continue;
      // 同样按理由前缀数：只数「超时后重新排队」，别把里程碑推进或派发失败算进来。
      const attempts = requeueAttempts(this.db, task.id, TIMEOUT_REQUEUE_PREFIX);
      if (attempts >= MAX_TIMEOUT_REQUEUES) continue;
      const after = requeueTask(this.db, task.id, {
        reason: `${TIMEOUT_REQUEUE_PREFIX}（第 ${attempts + 1} 次）`,
        expect: ["paused"],
      });
      if (after !== null) {
        revived.push(task.id);
        this.log("info", `任务 ${task.id} 超时后重新排队（run_epoch=${after.run_epoch}）`);
      }
    }
    return revived;
  }

  private renew(taskId: string, workerId: string): void {
    const ok = renewLock(
      this.db,
      `task:${taskId}`,
      { taskId, workerId },
      this.config.dispatch.lock_ttl_ms,
    );
    if (!ok) {
      // 锁没续上（被别人接管/已过期）：照旧把这一轮走完，但留痕；恢复协议会按 epoch 兜底。
      this.log("warn", `任务 ${taskId} 的锁续租失败（锁可能已被接管）`);
    }
  }

  private async runWorker(task: TaskRow, workerId: string, subagent: SubagentRuntimeLike): Promise<WorkerRunReport> {
    const cfg = this.config.dispatch;
    const sessionKey = `task:${task.id}`;
    const idempotencyKey = `task:${task.id}:${task.run_epoch}`;
    // 已批未用的批单：提示词里点名，让工人原样重放那一步（见 prompt.ts 的注释）。
    const approvedNow: string[] = [];
    try {
      for (const a of listApprovals(this.db, { task_id: task.id })) {
        if (a.status === "approved" || a.status === "executing") {
          approvedNow.push(`${a.title}（批单 ${a.id}）`);
        }
      }
    } catch {
      // 查不到就不点名，不影响派发
    }
    const prompt = buildWorkerPrompt(task, approvedNow);

    let runId: string | null = null;
    try {
      const started = await subagent.run({
        sessionKey,
        message: prompt.message,
        extraSystemPrompt: prompt.extraSystemPrompt,
        idempotencyKey,
        deliver: false,
      });
      runId = started.runId;
      this.log("info", `任务 ${task.id} 已派发（runId=${runId}，sessionKey=${sessionKey}）`);
    } catch (err) {
      // 起会话这一步失败，通常不是任务本身的问题，而是派发通道还没就绪
      // （插件加载早于网关装好兜底请求上下文时，subagent.run 会抛「没有请求作用域」）。
      // 把任务烧成 failed 是错的：重排回 queued，下一轮再来；连续失败到上限才判 failed。
      const message = (err as Error).message;
      // 只数「派发通道没就绪」这一类重排：里程碑推进、超时补救也走 requeueTask，
      // 混在一起数会把这条上限提前凑满（src/ledger/records.ts 的 requeueAttempts 注释）。
      const attempts = requeueAttempts(this.db, task.id, DISPATCH_FAILURE_PREFIX);
      if (attempts >= MAX_DISPATCH_ATTEMPTS - 1) {
        return this.finish(
          task.id,
          workerId,
          sessionKey,
          null,
          "failed",
          `派发连续失败 ${attempts + 1} 次：${message}`,
        );
      }
      return this.returnToQueue(task.id, workerId, sessionKey, attempts + 1, message);
    }

    let last: SubagentWaitResultLike = { status: "timeout" };
    const deadline = this.now() + cfg.session_timeout_ms;
    try {
      for (;;) {
        const remaining = deadline - this.now();
        if (remaining <= 0) break;
        this.renew(task.id, workerId);
        last = await subagent.waitForRun({
          runId,
          timeoutMs: Math.max(1, Math.min(this.waitSliceMs, remaining)),
        });
        if (last.status !== "timeout") break;
        const left = deadline - this.now();
        if (left <= 0) break;
        // waitForRun 可能因为「运行被中止」立刻返回 timeout；短睡一拍避免热循环。
        await this.sleep(Math.min(1000, left));
      }
    } catch (err) {
      return this.finish(
        task.id,
        workerId,
        sessionKey,
        runId,
        "failed",
        `等工人会话结果时抛错：${(err as Error).message}`,
      );
    }

    if (last.status === "error") {
      const reason = last.error ?? "未给原因";
      // 人在用电脑（Windows-MCP 的 USER_CONTROL）不是任务的错：转「暂停等人」，
      // 不判失败、不消耗失败次数。用户说继续时走桥的 /tasks/<id>/resume 重排。
      if (reason.startsWith(USER_CONTROL_PREFIX)) {
        return this.finish(
          task.id,
          workerId,
          sessionKey,
          runId,
          "paused",
          reason.slice(USER_CONTROL_PREFIX.length).trim() || "你正在用电脑，任务先停下等你说继续",
        );
      }
      return this.finish(
        task.id,
        workerId,
        sessionKey,
        runId,
        "failed",
        `工人会话报错：${reason}`,
      );
    }
    if (last.status !== "ok") {
      return this.finish(
        task.id,
        workerId,
        sessionKey,
        runId,
        "paused",
        `${TIMEOUT_REASON}（>${cfg.session_timeout_ms}ms），停下等恢复协议`,
      );
    }

    return this.finish(task.id, workerId, sessionKey, runId, null, "");
  }

  /**
   * 派发通道没就绪：把任务原样放回 queued（不动 run_epoch），放锁、更新 worker 行。
   * 用 bumpEpoch=false：这一轮根本没起会话，没有旧工人需要 fencing；
   * 每 bump 一次 epoch 都会让 idempotencyKey 换一个，白白绕过网关的幂等去重。
   */
  private returnToQueue(
    taskId: string,
    workerId: string,
    sessionKey: string,
    attempt: number,
    message: string,
  ): WorkerRunReport {
    const back = requeueTask(this.db, taskId, {
      reason: `派发通道没就绪（第 ${attempt} 次）：${message}`,
      bumpEpoch: false,
      expect: ["running"],
    });
    try {
      releaseLock(this.db, `task:${taskId}`, { taskId, workerId });
    } catch {
      // 放锁失败下一轮会过期
    }
    try {
      upsertWorker(this.db, {
        id: workerId,
        task_id: taskId,
        role: "worker",
        session_key: sessionKey,
        status: back?.state ?? "unknown",
        run_epoch: Number(back?.run_epoch ?? 0),
      });
    } catch {
      // worker 行写不了不影响任务回队
    }
    this.log("warn", `任务 ${taskId} 派发失败，已放回队列（第 ${attempt} 次）：${message}`);
    return {
      taskId,
      workerId,
      sessionKey,
      runId: null,
      outcome: "left",
      state: back?.state ?? null,
      detail: `派发通道没就绪：${message}`,
    };
  }

  /**
   * 收尾：按强制结论或步的统计给任务定状态，放锁，更新 worker 行，再跑「结算之后」的收尾。
   * 任何一步失败都不许把任务留在 running —— 留在 running 就是「永远卡住」。
   *
   * 为什么是 async：里程碑快照、阶段小结要落盘/调模型（src/dispatch/after-settle.ts）。
   * 收尾钩子永远在状态已经定完、锁已经放开之后才跑，所以它慢不拖累任务状态。
   */
  private async finish(
    taskId: string,
    workerId: string,
    sessionKey: string,
    runId: string | null,
    forced: "failed" | "paused" | null,
    detail: string,
  ): Promise<WorkerRunReport> {
    let outcome: "done" | "failed" | "paused" | "left" = "left";
    let state: TaskState | null = null;
    let reason: string | null = detail;

    // 网关关掉/账本被关之后 tick 可能还在等会话：这时什么都写不了，
    // 一句写清就收手，别拿四五个「database is not open」糊日志。恢复协议下次会接住。
    if (!this.isDbOpen()) {
      this.log("warn", `任务 ${taskId} 收尾时账本已关闭：状态留在原值，交给下次启动的恢复协议`);
      return { taskId, workerId, sessionKey, runId, outcome, state, detail: "账本已关闭，未收尾" };
    }

    try {
      const report =
        forced === "failed"
          ? settleTask(this.db, taskId, { errorReason: detail })
          : forced === "paused"
            ? settleTask(this.db, taskId, { timeoutReason: detail })
            : settleTask(this.db, taskId);
      outcome = report.outcome;
      state = report.state;
      reason = report.reason;
      this.log(
        outcome === "done" ? "info" : "warn",
        `任务 ${taskId} 会话结束：${outcome}（${reason ?? "无原因"}）`,
      );
    } catch (err) {
      // 定状态自己抛错时，至少把 running 收掉：failed 是能让人看见的那一端。
      this.log("error", `任务 ${taskId} 定状态失败：${(err as Error).message}`);
      try {
        const after = setTaskState(this.db, taskId, "failed", {
          reason: `定状态失败：${(err as Error).message}`,
          blocked_on: null,
          expect: ["running"],
        });
        if (after !== null) {
          state = after.state;
          outcome = "failed";
          reason = after.state_reason;
        }
      } catch (inner) {
        this.log("error", `任务 ${taskId} 兜底改 failed 也失败：${(inner as Error).message}`);
      }
    }

    try {
      releaseLock(this.db, `task:${taskId}`, { taskId, workerId });
    } catch (err) {
      this.log("warn", `任务 ${taskId} 放锁失败：${(err as Error).message}`);
    }

    try {
      upsertWorker(this.db, {
        id: workerId,
        task_id: taskId,
        role: "worker",
        session_key: sessionKey,
        status: state ?? "unknown",
        run_epoch: Number(getTask(this.db, taskId)?.run_epoch ?? 0),
      });
    } catch (err) {
      this.log("warn", `任务 ${taskId} 更新 worker 行失败：${(err as Error).message}`);
    }

    // 结算之后：里程碑快照 → 阶段小结 → 推进里程碑 → 记重排点（src/dispatch/after-settle.ts）。
    // 状态已经定完、锁已经放开才开始跑，所以这里再慢也不会把任务卡在 running。
    if (this.afterSettle !== null && outcome !== "left" && this.isDbOpen()) {
      try {
        await this.afterSettle({ taskId, outcome });
      } catch (err) {
        this.log("warn", `任务 ${taskId} 结算之后收尾失败：${(err as Error).message}`);
      }
    }

    return { taskId, workerId, sessionKey, runId, outcome, state, detail: reason ?? "" };
  }

  /** node:sqlite 的 DatabaseSync 有 isOpen；老版本没有就当开着试，写失败自有 catch。 */
  private isDbOpen(): boolean {
    const db = this.db as unknown as { isOpen?: boolean };
    return typeof db.isOpen === "boolean" ? db.isOpen : true;
  }
}
