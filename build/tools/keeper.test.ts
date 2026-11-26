/**
 * build/tools/keeper.test.ts —— keeper.ps1 / keeper-install.ps1 / keeper-ledger.mjs /
 * probe-health.mjs 的验收。
 *
 * 跑法：node build/tools/run-tests.mjs --only keeper
 *
 * 测试原则：
 * - keeper 的判定用 -PlanFile 驱动（等价于 B.11 的 --disk-free-mb：只换输入，不碰盘面）。
 * - probe-health.mjs 单独测：纯判定函数直接 import，CLI 用 --disk-free-mb / 连不上的假地址。
 * - keep.json 用桥自己的解析器（build/dot-core/src/bridge/keep.ts）读回来验形状。
 * - 真实副作用只在 mkdtemp 目录里发生；keeper 不删任何文件，测试也据此断言。
 * - 不启动/停止任何服务，不注册计划任务（install 只验 dry-run 输出）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendEvent,
  migrate,
  nowIso,
  openLedger,
  verifyChain,
} from "../dot-core/src/ledger/index.ts";
import { parseKeepState } from "../dot-core/src/bridge/keep.ts";
import { classifyBalanceRaw, parseModels, run as runProbe } from "./probe-health.mjs";

const ROOT = resolve(process.cwd());
const TOOLS = join(ROOT, "build", "tools");
const KEEPER = join(TOOLS, "keeper.ps1");
const INSTALL = join(TOOLS, "keeper-install.ps1");
const HELPER = join(TOOLS, "keeper-ledger.mjs");
const PROBE = join(TOOLS, "probe-health.mjs");
const PS = "powershell.exe";

function basePlan(overrides: Record<string, any> = {}): any {
  const plan: any = {
    now: "2026-11-24T22:00:00Z",
    probes: {
      modelPool: { ok: true, status: 200, error: "" },
      gateway: { ok: true, status: 200, error: "" },
      dotCore: { loaded: true, known: true, source: "heartbeat", detail: "心跳 12s 前" },
      bridge: { ok: true, status: 200, error: "" },
      windowsMcp: { ok: true, detail: "initialize HTTP 200" },
      playwright: { ok: true, detail: "TCP 8931 通" },
      gateVerify: { ok: true, ran: true, detail: "exit=0 五道全过" },
      dsbot: { running: true, detail: "8797 在听" },
      balance: {
        enabled: true,
        cheap: { level: "green", note: "HTTP 200" },
        balanced: { level: "green", note: "HTTP 200" },
        strong: { level: "green", note: "HTTP 200" },
      },
    },
    disk: { freeMb: 9000 },
    backups: {
      count: 3,
      totalMb: 300,
      todayPresent: true,
      names: ["dot-20261124.db", "dot-20261123.db", "dot-20261122.db"],
    },
    startables: {
      gatewayCmd: true,
      gatewayPath: "C:/Users/1/.allbot/gateway.cmd",
      bridgeCmd: true,
      bridgePath: 'node "C:/x/build/dot-bridge/index.mjs"',
      windowsMcpCmd: "windows-mcp",
      playwrightCmd: "playwright-mcp --port 8931",
      verifyScript: true,
      verifyPath: "C:/x/build/patches/ds-bot/verify.mjs",
    },
    keeperTask: { exists: true, enabled: true },
    gatewayStarts: [],
    gatewayStops: [],
    gateVerifyLastRunAt: "2026-11-24T21:30:00Z",
    gateVerifyLastOk: true,
    gateVerifyLastDetail: "exit=0 五道全过",
  };
  return merge(plan, overrides);
}

function merge(base: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof out[key] === "object" && out[key] !== null) {
      out[key] = merge(out[key], v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

interface RunOpts {
  plan?: any;
  args?: string[];
  ledger?: string;
  noState?: boolean;
  prep?: (dir: string) => void;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: any;
  dir: string;
  statePath: string;
  backupDir: string;
  outPath: string;
}

function runKeeper(opts: RunOpts = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-test-"));
  const backupDir = join(dir, "backups");
  const statePath = join(dir, "keep.json");
  const outPath = join(dir, "out.json");
  if (opts.prep) opts.prep(dir);

  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", KEEPER];
  if (opts.plan !== undefined) {
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(opts.plan, null, 2), "utf8");
    args.push("-PlanFile", planPath);
  }
  args.push("-StateFile", statePath, "-BackupDir", backupDir, "-JsonOut", outPath);
  if (opts.ledger) args.push("-LedgerDbPath", opts.ledger);
  else args.push("-NoLedger");
  if (opts.noState) args.push("-NoState");
  if (opts.args) args.push(...opts.args);

  const r = spawnSync(PS, args, { encoding: "utf8", timeout: 120000 });
  assert.equal(r.error, undefined, `启动 powershell 失败：${r.error?.message ?? ""}`);
  assert.equal(r.status, 0, `keeper 退出码非 0；stdout=${r.stdout}\nstderr=${r.stderr}`);
  const json = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;
  assert.ok(json, "keeper 没写出 -JsonOut 文件");
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    json,
    dir,
    statePath,
    backupDir,
    outPath,
  };
}

function row(json: any, id: string): any {
  const found = json.rows.find((r: any) => r.id === id);
  assert.ok(found, `没有 ${id} 这一行；实际有 ${json.rows.map((r: any) => r.id).join(",")}`);
  return found;
}

function actionIds(json: any): string[] {
  return json.actions.map((a: any) => a.id);
}

function makeLedger(dir: string, withReport = true): string {
  const path = join(dir, "ledger", "dot.db");
  const db = openLedger(path);
  migrate(db);
  if (withReport) {
    appendEvent(db, { type: "recovery_report", payload: { startedAt: nowIso(), orphans: [], tasksAwaitingHuman: [] } });
  }
  db.close();
  return path;
}

function countEvents(path: string): number {
  const db = openLedger(path, { readOnly: true });
  try {
    return Number((db.prepare("SELECT count(*) AS c FROM events").get() as any).c);
  } finally {
    db.close();
  }
}

const BACKUP_NAMES = Array.from({ length: 20 }, (_, i) => `dot-202611${String(1 + i).padStart(2, "0")}.db`);

function seedBackups(dir: string, names: string[] = BACKUP_NAMES): void {
  const d = join(dir, "backups");
  mkdirSync(d, { recursive: true });
  for (const n of names) writeFileSync(join(d, n), "x", "utf8");
}

// ---------------------------------------------------------------------------
// 判定：全绿
// ---------------------------------------------------------------------------

test("全绿：健康场景没有任何动作，账本通道读到恢复报告", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-ledger-"));
  const ledger = makeLedger(dir);
  const r = runKeeper({ plan: basePlan(), ledger });
  assert.equal(r.json.overall, "green");
  assert.deepEqual(actionIds(r.json), []);
  assert.equal(row(r.json, "ledger").state, "green");
  assert.ok(r.json.ledger.recoveryReport, "账本里的恢复报告应被读出来");
  assert.equal(r.json.dryRun, true, "默认必须是 dry-run");
});

test("plan 缺字段不崩：只输出能判断的行，退出码 0", () => {
  const r = runKeeper({ plan: { now: "2026-11-24T22:00:00Z" }, noState: true });
  assert.ok(r.json.rows.length >= 5);
  assert.equal(r.json.overall, "red", "缺 dot-core 状态时应报红而不是假绿");
});

test("plan 文件坏掉：退出码 2（计划任务的「失败自动重启」看它）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-test-"));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, "{ 这不是 JSON", "utf8");
  const r = spawnSync(
    PS,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      KEEPER,
      "-PlanFile",
      planPath,
      "-StateFile",
      join(dir, "keep.json"),
      "-NoState",
      "-NoLedger",
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(r.status, 2, `坏 plan 应退 2；stdout=${r.stdout}\nstderr=${r.stderr}`);
});

// ---------------------------------------------------------------------------
// 3065：只报红不代拉
// ---------------------------------------------------------------------------

test("3065 挂了：报红 + 给人一句话动作，绝不出现代拉动作", () => {
  const plan = basePlan({ probes: { modelPool: { ok: false, status: 0, error: "connection refused" } } });
  const r = runKeeper({ plan });
  assert.equal(row(r.json, "modelPool").state, "red");
  assert.match(row(r.json, "modelPool").action, /Agent2API 程序/);
  assert.equal(r.json.overall, "red");
  assert.ok(!actionIds(r.json).some((id: string) => /model|pool|3065|agent2api/i.test(id)));
});

// ---------------------------------------------------------------------------
// 18789 + dot-core：fail-closed 与起停退避
// ---------------------------------------------------------------------------

test("dot-core 未加载（有心跳过期证据）且网关在：停网关", () => {
  const plan = basePlan({
    probes: { dotCore: { loaded: false, known: true, source: "heartbeat-stale", detail: "心跳文件 900s 前，超过 600s" } },
  });
  const r = runKeeper({ plan });
  assert.equal(row(r.json, "dotCore").state, "red");
  assert.match(row(r.json, "dotCore").detail, /裸奔/);
  const stop = r.json.actions.find((a: any) => a.id === "stop_gateway");
  assert.ok(stop, "dot-core 未加载时必须出现 stop_gateway");
  assert.equal(stop.allowed, true);
  assert.match(stop.cmd, /AllBot Gateway/);
});

test("dot-core 没有任何信号（没心跳、状态接口没标记）：黄，不瞎停网关", () => {
  const plan = basePlan({
    probes: { dotCore: { loaded: false, known: false, source: "no-signal", detail: "没有心跳文件，状态接口也没有标记" } },
  });
  const r = runKeeper({ plan });
  assert.equal(row(r.json, "dotCore").state, "yellow");
  assert.ok(!actionIds(r.json).includes("stop_gateway"));
});

test("一小时内已停 3 次：停网关动作退避", () => {
  const plan = basePlan({
    probes: { dotCore: { loaded: false, known: true, detail: "心跳过期" } },
    gatewayStops: ["2026-11-24T21:05:00Z", "2026-11-24T21:25:00Z", "2026-11-24T21:45:00Z"],
  });
  const r = runKeeper({ plan });
  const stop = r.json.actions.find((a: any) => a.id === "stop_gateway");
  assert.equal(stop.allowed, false);
  assert.match(stop.suppressedReason, /最多 3 次/);
});

test("网关没起：起 gateway.cmd；一小时内已起 4 次还可起", () => {
  const plan = basePlan({
    probes: { gateway: { ok: false, status: 0, error: "connection refused" } },
    gatewayStarts: ["2026-11-24T21:10:00Z", "2026-11-24T21:20:00Z", "2026-11-24T21:30:00Z", "2026-11-24T21:40:00Z"],
  });
  const r = runKeeper({ plan });
  assert.equal(row(r.json, "gateway").state, "red");
  const start = r.json.actions.find((a: any) => a.id === "start_gateway");
  assert.ok(start);
  assert.equal(start.allowed, true);
  assert.match(start.cmd, /gateway\.cmd/);
});

test("网关没起且一小时内已起 5 次：退避并说明原因", () => {
  const plan = basePlan({
    probes: { gateway: { ok: false, status: 0, error: "connection refused" } },
    gatewayStarts: [
      "2026-11-24T21:10:00Z",
      "2026-11-24T21:20:00Z",
      "2026-11-24T21:30:00Z",
      "2026-11-24T21:40:00Z",
      "2026-11-24T21:50:00Z",
    ],
  });
  const r = runKeeper({ plan });
  const start = r.json.actions.find((a: any) => a.id === "start_gateway");
  assert.ok(start, "退避时也要把动作列出来给人看");
  assert.equal(start.allowed, false);
  assert.match(start.suppressedReason, /每小时最多 5 次/);
});

test("刚因 dot-core 停过网关（5 分钟前）：这轮不许起回来", () => {
  const plan = basePlan({
    probes: {
      gateway: { ok: false, status: 0, error: "refused" },
      dotCore: { loaded: false, known: true, detail: "心跳过期" },
    },
    gatewayStops: ["2026-11-24T21:55:00Z"],
  });
  const r = runKeeper({ plan });
  const start = r.json.actions.find((a: any) => a.id === "start_gateway");
  assert.ok(start);
  assert.equal(start.allowed, false);
  assert.match(start.suppressedReason, /起停循环/);
});

test("已有网关进程在跑但 /api/status 没通（冷启动中）：不再起第二个", () => {
  const plan = basePlan({
    probes: { gateway: { ok: false, status: 0, error: "refused" }, gatewayProcess: { count: 1 } },
  });
  const r = runKeeper({ plan });
  const start = r.json.actions.find((a: any) => a.id === "start_gateway");
  assert.ok(start, "退避时也要把动作列出来给人看");
  assert.equal(start.allowed, false);
  assert.match(start.suppressedReason, /已有 1 个网关进程/);
  assert.match(start.suppressedReason, /冷启动/);
});

test("进程数查不到（-1）：不抑制，还是按退避起一个", () => {
  const plan = basePlan({
    probes: { gateway: { ok: false, status: 0, error: "refused" }, gatewayProcess: { count: -1 } },
  });
  const r = runKeeper({ plan });
  assert.equal(r.json.actions.find((a: any) => a.id === "start_gateway").allowed, true);
});

test("网关通了：进程数不影响，报绿、不起", () => {
  const plan = basePlan({ probes: { gateway: { ok: true, status: 200, error: "" }, gatewayProcess: { count: 2 } } });
  const r = runKeeper({ plan, noState: true });
  assert.equal(row(r.json, "gateway").state, "green");
  assert.ok(!actionIds(r.json).includes("start_gateway"));
});

test("超过一小时的旧启动记录不算进退避", () => {
  const plan = basePlan({
    probes: { gateway: { ok: false, status: 0, error: "refused" } },
    gatewayStarts: [
      "2026-11-24T18:00:00Z",
      "2026-11-24T18:10:00Z",
      "2026-11-24T18:20:00Z",
      "2026-11-24T18:30:00Z",
      "2026-11-24T18:40:00Z",
    ],
  });
  const r = runKeeper({ plan });
  assert.equal(r.json.actions.find((a: any) => a.id === "start_gateway").allowed, true);
});

// ---------------------------------------------------------------------------
// 8799：用真实入口起桥
// ---------------------------------------------------------------------------

test("桥没起：只有一个 start_stack 动作，跑 dot-up.ps1（不再各服务一条命令）", () => {
  const r = runKeeper({ plan: basePlan({ probes: { bridge: { ok: false, error: "refused" } } }) });
  const stacks = r.json.actions.filter((a: any) => a.id === "start_stack");
  assert.equal(stacks.length, 1, "一条动作，不是每只服务各一条");
  assert.match(stacks[0].cmd, /dot-up\.ps1/);
  assert.match(stacks[0].cmd, /-SkipGateway/, "网关有退避和 fail-closed，不归 dot-up 管");
  // 老的四条起服动作不该再出现（2026-11-25 收口成一个入口）
  for (const gone of ["start_bridge", "start_windows_mcp", "start_playwright", "start_clean_browser", "start_wechat"]) {
    assert.ok(!actionIds(r.json).includes(gone), `${gone} 应该已经并进 start_stack`);
  }
});

test("桥上没装（入口文件不在）：黄，不给启动动作", () => {
  const r = runKeeper({
    plan: basePlan({ probes: { bridge: { ok: false, error: "refused" } }, startables: { bridgeCmd: false } }),
  });
  assert.equal(row(r.json, "bridge").state, "yellow");
  assert.ok(!actionIds(r.json).includes("start_bridge"));
});

// ---------------------------------------------------------------------------
// 磁盘四档
// ---------------------------------------------------------------------------

test("磁盘四档：>5GB 绿、<5GB 黄、<2GB 红、<800MB 红并请求停接新任务", () => {
  const cases: Array<[number, string, boolean]> = [
    [6000, "green", false],
    [3000, "yellow", false],
    [1500, "red", false],
    [700, "red", true],
  ];
  for (const [mb, state, pause] of cases) {
    const r = runKeeper({ plan: basePlan({ disk: { freeMb: mb } }), noState: true });
    const d = row(r.json, "disk");
    assert.equal(d.state, state, `剩余 ${mb}MB 应为 ${state}，实际 ${d.state}：${d.detail}`);
    assert.equal(r.json.disk.pauseAdmission, pause, `剩余 ${mb}MB 的 pauseAdmission 应为 ${pause}`);
    if (pause) assert.match(d.detail, /admission=paused_disk/);
  }
});

test("磁盘取账本盘与 ~/.allbot 盘里更小的那个", () => {
  const r = runKeeper({
    plan: basePlan({ disk: { freeMb: null, ledgerFreeMb: 9000, allbotFreeMb: 1000 } }),
    noState: true,
  });
  assert.equal(row(r.json, "disk").state, "red");
  assert.equal(r.json.disk.freeMb, 1000);
});

test("读不到磁盘就报未知（黄），不编数", () => {
  const r = runKeeper({ plan: basePlan({ disk: { freeMb: null, detail: "probe-health 跑失败" } }), noState: true });
  assert.equal(row(r.json, "disk").state, "yellow");
  assert.match(row(r.json, "disk").detail, /读不到剩余空间/);
  assert.equal(r.json.disk.freeMb, null);
});

// ---------------------------------------------------------------------------
// 账户探针（level 由 probe-health 判，keeper 只汇总）
// ---------------------------------------------------------------------------

test("账户有一档红：整行红，动作指向换密钥/重开 Agent2API", () => {
  const plan = basePlan({
    probes: {
      balance: {
        enabled: true,
        cheap: { level: "green", note: "HTTP 200" },
        balanced: { level: "red", note: "这一档账户没钱" },
        strong: { level: "green", note: "HTTP 200" },
      },
    },
  });
  const r = runKeeper({ plan, noState: true });
  assert.equal(r.json.balance.balanced.level, "red");
  assert.equal(row(r.json, "balance").state, "red");
  assert.match(row(r.json, "balance").action, /Agent2API/);
});

test("探针没开：三档一律 unknown，不编数", () => {
  const r = runKeeper({ plan: basePlan({ probes: { balance: { enabled: false } } }), noState: true });
  assert.deepEqual(
    [r.json.balance.cheap.level, r.json.balance.balanced.level, r.json.balance.strong.level],
    ["unknown", "unknown", "unknown"],
  );
  assert.match(row(r.json, "balance").detail, /unknown/);
});

// ---------------------------------------------------------------------------
// 备份：只建议，不删
// ---------------------------------------------------------------------------

test("备份 20 份 300MB：建议保留 14、减 6，动作里没有删文件", () => {
  const r = runKeeper({
    plan: basePlan({ backups: { count: 20, totalMb: 300, todayPresent: true, names: BACKUP_NAMES } }),
    noState: true,
  });
  assert.equal(r.json.backups.keep, 14);
  assert.equal(r.json.backups.willDelete, 6);
  assert.equal(r.json.recommendations.backupPrune.keep, 14);
  assert.equal(r.json.recommendations.backupPrune.executor, "dot-core/src/maintenance");
  assert.ok(!actionIds(r.json).includes("prune_backups"), "keeper 不该有删备份的动作");
  assert.equal(row(r.json, "backups").state, "green");
});

test("备份总占用超 5GB：建议减到 7 份", () => {
  const r = runKeeper({
    plan: basePlan({ backups: { count: 20, totalMb: 6000, todayPresent: true, names: BACKUP_NAMES } }),
    noState: true,
  });
  assert.equal(r.json.backups.keep, 7);
  assert.match(row(r.json, "backups").detail, /减到 7/);
});

test("减到 3 份仍超 5GB：标红并让人手动清", () => {
  const r = runKeeper({
    plan: basePlan({ backups: { count: 20, totalMb: 40000, todayPresent: true, names: BACKUP_NAMES } }),
    noState: true,
  });
  assert.equal(r.json.backups.keep, 3);
  assert.equal(r.json.backups.manual, true);
  assert.equal(row(r.json, "backups").state, "red");
  assert.match(row(r.json, "backups").action, /手动清/);
});

test("今天没备份：给出 backup_now 动作", () => {
  const r = runKeeper({ plan: basePlan({ backups: { count: 3, totalMb: 300, todayPresent: false } }), noState: true });
  const b = r.json.actions.find((a: any) => a.id === "backup_now");
  assert.ok(b);
  assert.match(b.cmd, /keeper-ledger\.mjs backup/);
});

test("-Execute 也不删备份文件（删是 dot-core maintenance 的事）", () => {
  const r = runKeeper({
    plan: basePlan({ backups: { count: 20, totalMb: 300, todayPresent: true, names: BACKUP_NAMES } }),
    args: ["-Execute"],
    prep: (dir) => seedBackups(dir),
  });
  assert.equal(readdirSync(r.backupDir).length, 20, "keeper 不许删任何备份文件");
  assert.ok(!actionIds(r.json).includes("prune_backups"));
  assert.equal(r.json.recommendations.backupPrune.willDelete, 6);
});

test("-Execute 与 -DryRun 同时给：仍按 dry-run", () => {
  const r = runKeeper({
    plan: basePlan({ backups: { count: 20, totalMb: 300, todayPresent: true, names: BACKUP_NAMES } }),
    args: ["-Execute", "-DryRun"],
    prep: (dir) => seedBackups(dir),
  });
  assert.equal(r.json.dryRun, true);
  assert.equal(r.json.execute, false);
  assert.equal(readdirSync(r.backupDir).length, 20);
});

// ---------------------------------------------------------------------------
// 脸、口闸、看门狗自己
// ---------------------------------------------------------------------------

test("ds-bot 没跑：黄，文案是「脸没开，审批没人点」，不产生代拉动作", () => {
  const r = runKeeper({
    plan: basePlan({ probes: { dsbot: { running: false, detail: "8797 不通、进程也没找到" } } }),
    noState: true,
  });
  const d = row(r.json, "dsbot");
  assert.equal(d.state, "yellow");
  assert.match(d.detail, /脸没开，审批没人点/);
  assert.ok(!actionIds(r.json).some((id: string) => /dsbot|ds-bot/i.test(id)));
});

test("口闸 verify 本轮失败：红，并提醒先别让机器人干活", () => {
  const r = runKeeper({
    plan: basePlan({ probes: { gateVerify: { ok: false, ran: true, detail: "exit=1 FAIL 1. 标记在" } } }),
    noState: true,
  });
  assert.equal(row(r.json, "gateVerify").state, "red");
  assert.match(row(r.json, "gateVerify").action, /先别让它干活/);
});

test("口闸上一轮失败、这一轮没到点：仍然红（红不会 5 分钟消失）", () => {
  const r = runKeeper({
    plan: basePlan({
      probes: { gateVerify: { ok: false, ran: false, detail: "这一轮没跑（每小时一次，未到点）" } },
      gateVerifyLastRunAt: "2026-11-24T21:50:00Z",
      gateVerifyLastOk: false,
      gateVerifyLastDetail: "exit=1 FAIL 3. 102 名单",
    }),
    noState: true,
  });
  const d = row(r.json, "gateVerify");
  assert.equal(d.state, "red");
  assert.match(d.detail, /上一轮/);
  assert.match(d.detail, /102 名单/);
});

test("口闸从没跑过：黄，不报红", () => {
  const r = runKeeper({
    plan: basePlan({
      probes: { gateVerify: { ok: false, ran: false, detail: "这一轮没跑" } },
      gateVerifyLastRunAt: null,
      gateVerifyLastOk: null,
    }),
    noState: true,
  });
  assert.equal(row(r.json, "gateVerify").state, "yellow");
});

test("计划任务 dot-keeper 不在：红（看门狗自己没了）", () => {
  const r = runKeeper({ plan: basePlan({ keeperTask: { exists: false, enabled: false } }), noState: true });
  assert.equal(row(r.json, "keeperTask").state, "red");
});

// ---------------------------------------------------------------------------
// keep.json：形状要能被桥直接读
// ---------------------------------------------------------------------------

test("keep.json 用桥的解析器读得出来：盘、备份、三档账户、组件", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-ledger-"));
  const ledger = makeLedger(dir);
  const before = countEvents(ledger);
  const r = runKeeper({
    plan: basePlan({
      disk: { freeMb: 9000 },
      backups: { count: 3, totalMb: 300, todayPresent: true, names: ["dot-20261124.db"] },
    }),
    ledger,
  });
  const keep = JSON.parse(readFileSync(r.statePath, "utf8"));
  const view = parseKeepState(keep, r.statePath);
  assert.equal(view.ok, true);
  assert.equal(view.diskFreeMb, 9000);
  assert.equal(view.diskLevel, "green");
  assert.equal(view.backupsBytes, 300 * 1024 * 1024);
  assert.equal(view.balance.cheap.level, "green");
  assert.equal(view.balance.strong.level, "green");
  assert.equal(view.admission, null, "keeper 不许置 admission（那是 dot-core 的事）");
  assert.ok(view.components.some((c) => c.name === "dsbot"));
  assert.ok(view.components.some((c) => c.name === "gateVerify"));
  assert.ok(view.probedAt, "probedAt 要被桥读出来");

  assert.ok(existsSync(join(r.dir, "keeper-report.json")));
  const queue = readFileSync(join(r.dir, "keeper-report-queue.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "");
  assert.equal(queue.length, 1);
  assert.equal(JSON.parse(queue[0]).kind, "keeper_patrol");
  assert.equal(countEvents(ledger), before, "keeper 不得直接写账本 events");
});

test("-NoState：不写 keep.json / 报告 / 队列", () => {
  const r = runKeeper({ plan: basePlan(), noState: true });
  assert.equal(existsSync(r.statePath), false);
  assert.equal(existsSync(join(r.dir, "keeper-report.json")), false);
});

// ---------------------------------------------------------------------------
// keeper-ledger.mjs：只读、备份、队列落链
// ---------------------------------------------------------------------------

function runHelper(args: string[]): any {
  const r = spawnSync(process.execPath, ["--no-warnings", HELPER, ...args], { encoding: "utf8", timeout: 60000 });
  const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  assert.ok(line.startsWith("{"), `helper 输出不是 JSON：${r.stdout}\n${r.stderr}`);
  return JSON.parse(line);
}

test("helper report：读到 events 数、哈希链与恢复报告", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-ledger-"));
  const ledger = makeLedger(dir);
  const out = runHelper(["report", "--db", ledger]);
  assert.equal(out.ok, true);
  assert.equal(out.eventCount, 1);
  assert.equal(out.chain.ok, true);
  assert.ok(out.latestRecoveryReport);
});

test("helper report：账本不存在时如实报错，不编数", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-ledger-"));
  const out = runHelper(["report", "--db", join(dir, "nope.db")]);
  assert.equal(out.ok, false);
  assert.match(out.error, /账本不存在/);
});

test("helper backup：VACUUM INTO 出的备份能打开、events 数一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-ledger-"));
  const ledger = makeLedger(dir);
  const outPath = join(dir, "backups", "dot-20261124.db");
  const out = runHelper(["backup", "--db", ledger, "--out", outPath]);
  assert.equal(out.ok, true);
  assert.ok(existsSync(outPath));
  assert.equal(out.verify.events, out.sourceEvents);
  const db = openLedger(outPath, { readOnly: true });
  try {
    assert.equal(verifyChain(db).ok, true);
  } finally {
    db.close();
  }
});

test("helper drain：队列进 events，坏行跳过，队列清空", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-keeper-ledger-"));
  const ledger = makeLedger(dir);
  const queue = join(dir, "queue.jsonl");
  const line1 = JSON.stringify({ kind: "keeper_patrol", generatedAt: nowIso(), overall: "red" });
  const line2 = JSON.stringify({ kind: "keeper_patrol", generatedAt: nowIso(), overall: "green" });
  writeFileSync(queue, `${line1}\n这行不是 JSON\n${line2}\n`, "utf8");
  const before = countEvents(ledger);
  const out = runHelper(["drain", "--db", ledger, "--queue", queue]);
  assert.equal(out.ok, true);
  assert.equal(out.appended, 2);
  assert.equal(out.skipped, 1);
  assert.equal(countEvents(ledger), before + 2);
  assert.equal(readFileSync(queue, "utf8"), "");
  const db = openLedger(ledger, { readOnly: true });
  try {
    const row = db.prepare("SELECT type FROM events ORDER BY seq DESC LIMIT 1").get() as any;
    assert.equal(row.type, "keeper_report");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// probe-health.mjs：B.7 的判定顺序 + 防抖
// ---------------------------------------------------------------------------

test("probe-health 判定顺序：正文优先于状态码", () => {
  assert.equal(classifyBalanceRaw({ status: 429, body: '{"error":{"code":"insufficient_quota"}}' }).level, "red");
  assert.equal(classifyBalanceRaw({ status: 429, body: "余额不足" }).level, "red");
  assert.equal(classifyBalanceRaw({ status: 429, body: "rate limited" }).level, "yellow");
  assert.equal(classifyBalanceRaw({ status: 401, body: "" }).level, "red");
  assert.equal(classifyBalanceRaw({ status: 403, body: "" }).level, "red");
  assert.equal(classifyBalanceRaw({ status: 402, body: "" }).level, "red");
  assert.equal(classifyBalanceRaw({ status: 200, body: "{}" }).level, "green");
  assert.equal(classifyBalanceRaw({ status: 0, error: "ECONNREFUSED" }).level, "red");
});

test("probe-health：没配模型名 → unknown，不是红", async () => {
  assert.deepEqual(parseModels("cheap=a,strong=c"), { cheap: "a", strong: "c" });
  assert.deepEqual(parseModels(""), {});
  const out = await runProbe({
    once: true,
    baseUrl: "http://127.0.0.1:1",
    diskPaths: [],
    models: {},
    skipBalance: false,
    retestMs: 0,
    timeoutMs: 500,
  });
  for (const tier of ["cheap", "balanced", "strong"]) {
    assert.equal(out.balance[tier].level, "unknown", `${tier} 没配模型名时不该判红`);
    assert.equal(out.balance[tier].attempts, 0, "没配模型名不该发请求");
    assert.match(out.balance[tier].note, /没配模型名/);
  }
});

test("probe-health CLI：--disk-free-mb 只换判定输入，输出 unknown 三档", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", PROBE, "--disk-free-mb", "1234", "--skip-balance"], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse((r.stdout ?? "").trim());
  assert.equal(out.ok, true);
  assert.equal(out.disk.freeMb, 1234);
  assert.equal(out.disk.forged, true);
  for (const tier of ["cheap", "balanced", "strong"]) {
    assert.equal(out.balance[tier].level, "unknown");
  }
});

test("probe-health：给模型名但连不上 → 重测一次才判红；--once 只打一次", async () => {
  const base = {
    baseUrl: "http://127.0.0.1:1",
    diskPaths: [],
    models: { cheap: "m1" },
    skipBalance: false,
    retestMs: 0,
    timeoutMs: 1500,
  };
  const twoShot = await runProbe({ ...base, once: false });
  assert.equal(twoShot.balance.cheap.attempts, 2);
  assert.equal(twoShot.balance.cheap.level, "red");
  assert.match(twoShot.balance.cheap.note, /两次都失败/);

  const oneShot = await runProbe({ ...base, once: true });
  assert.equal(oneShot.balance.cheap.attempts, 1);
  assert.equal(oneShot.balance.cheap.level, "red");
});

test("probe-health：真实 CLI 输出合法 JSON（不带模型名时不影响退出码）", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", PROBE, "--once", "--retest-ms", "0"], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse((r.stdout ?? "").trim());
  assert.equal(out.ok, true);
  assert.ok(out.probedAt);
  assert.ok(out.disk && "freeMb" in out.disk);
});

// ---------------------------------------------------------------------------
// 安装脚本：默认只打印
// ---------------------------------------------------------------------------

test("keeper-install.ps1 默认 dry-run：打印 dot-keeper 规格，未执行，只给一个任务名", () => {
  const r = spawnSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALL], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dot-keeper/);
  assert.match(r.stdout, /每 5 分钟/);
  assert.match(r.stdout, /失败最多重启 3 次/);
  assert.match(r.stdout, /未执行/);
  assert.match(r.stdout, /AllBot Gateway/, "要提醒停用原来的网关自启任务");
  assert.ok(!/dot-keeper-every/.test(r.stdout), "不许给「建两个任务」的写法");
});

test("keeper-install.ps1 -Remove 默认也只打印", () => {
  const r = spawnSync(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", INSTALL, "-Remove"], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /schtasks \/Delete \/TN "dot-keeper" \/F/);
  assert.match(r.stdout, /未执行/);
});
