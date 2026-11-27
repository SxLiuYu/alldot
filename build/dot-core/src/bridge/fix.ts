/**
 * src/bridge/fix.ts —— 一键修（P1P3 契约第 2 节）。
 *
 * 动作不在这里重新发明：启动命令一律照 keeper 的口径读
 * `~/.allbot/dot/keeper-start.json`（缺了回落到 config.json 的 keepalive），
 * 「手」用 dot-up.ps1 -Only <端口>（keeper 用的同一个入口），隧道用 tunnel-keepalive.ps1，
 * 报告队列用 keeper-ledger.mjs drain，快照回收用 dot-core 的 maintenance.sweepSnapshots。
 *
 * 硬要求：执行完必须**回读事实**（端口/HTTP/账本行数/日志最后一行），detail 写回读结果，
 * 不许只回「已执行」。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sweepSnapshots } from "../maintenance/index.ts";
import { listTasks, openLedger, OPEN_TASK_STATES } from "../ledger/index.ts";

export type FixError = "unknown_action" | "fix_failed";

export type FixOutcome =
  | { ok: true; detail: string }
  | { ok: false; error: FixError; message: string };

export interface RunCaptureResult {
  code: number | null;
  output: string;
}

export interface FixEnvironment {
  dotDir: string;
  home: string;
  repoRoot: string;
  ledgerPath: string;
  now: () => Date;
  /** 后台起进程（不等退出）。 */
  runProcess: (cmd: string) => Promise<{ ok: boolean; output: string }>;
  /** 等命令跑完并收 stdout/stderr。 */
  runCapture: (cmd: string, timeoutMs?: number) => Promise<RunCaptureResult>;
  tcpProbe: (port: number) => Promise<boolean>;
  httpProbe: (url: string) => Promise<boolean>;
  /** 回读轮询总预算。 */
  waitMs: number;
  /** 快照回收上限（GB）；默认 5。 */
  snapshotsMaxGb: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultRepoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\/\\]+$/, "");
}

export function defaultTcpProbe(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function defaultHttpProbe(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

function defaultRunProcess(cmd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, { shell: true, windowsHide: true, stdio: "ignore", detached: true });
      child.once("error", (err) => resolve({ ok: false, output: errorText(err) }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true, output: "" });
      });
    } catch (err) {
      resolve({ ok: false, output: errorText(err) });
    }
  });
}

function defaultRunCapture(cmd: string, timeoutMs = 30000): Promise<RunCaptureResult> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, output: output.trim() });
    };
    try {
      const child = spawn(cmd, { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 杀不掉就算了，按超时回。
        }
        finish(null);
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.once("error", (err) => {
        output += errorText(err);
        finish(null);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        finish(code);
      });
    } catch (err) {
      output = errorText(err);
      finish(null);
    }
  });
}

export function createFixEnvironment(
  partial: Partial<FixEnvironment> & { dotDir: string; ledgerPath: string },
): FixEnvironment {
  const fallbackHome = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return {
    dotDir: partial.dotDir,
    ledgerPath: partial.ledgerPath,
    home: partial.home ?? fallbackHome,
    repoRoot: partial.repoRoot ?? defaultRepoRoot(),
    now: partial.now ?? (() => new Date()),
    runProcess: partial.runProcess ?? defaultRunProcess,
    runCapture: partial.runCapture ?? defaultRunCapture,
    tcpProbe: partial.tcpProbe ?? ((port: number) => defaultTcpProbe(port)),
    httpProbe: partial.httpProbe ?? ((url: string) => defaultHttpProbe(url)),
    waitMs: partial.waitMs ?? 12000,
    snapshotsMaxGb: partial.snapshotsMaxGb ?? 5,
  };
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 没文件/坏 JSON 都当没配。
  }
  return null;
}

function stringField(source: Record<string, unknown> | null, key: string): string {
  if (source === null) return "";
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/** keeper 的两处命令来源：keeper-start.json 优先，config.json 的 keepalive 兜底。 */
function startCommands(dotDir: string): {
  startCfg: Record<string, unknown> | null;
  keepalive: Record<string, unknown> | null;
} {
  const startCfg = readJsonFile(join(dotDir, "keeper-start.json"));
  const config = readJsonFile(join(dotDir, "config.json"));
  const keepaliveRaw = config?.["keepalive"];
  const keepalive =
    keepaliveRaw !== null && typeof keepaliveRaw === "object" && !Array.isArray(keepaliveRaw)
      ? (keepaliveRaw as Record<string, unknown>)
      : null;
  return { startCfg, keepalive };
}

function commandFor(env: FixEnvironment, name: string, fallback = ""): string {
  const { startCfg, keepalive } = startCommands(env.dotDir);
  return stringField(startCfg, name) || stringField(keepalive, name) || fallback;
}

async function pollUntil(check: () => Promise<boolean>, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  } while (Date.now() < deadline);
  return false;
}

function quote(path: string): string {
  return `"${path.replace(/"/g, '""')}"`;
}

function powershellFile(script: string, extra = ""): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File ${quote(script)}${extra}`;
}

/** 起一个后台进程，然后回读指定端口。 */
async function startAndProbePort(
  env: FixEnvironment,
  cmd: string,
  port: number,
  label: string,
  cmdHint: string,
): Promise<FixOutcome> {
  if (cmd === "") {
    return { ok: false, error: "fix_failed", message: `没配${label}的启动命令（${cmdHint} 里加一条）` };
  }
  const started = await env.runProcess(cmd);
  if (!started.ok) {
    return { ok: false, error: "fix_failed", message: `起${label}失败：${started.output}` };
  }
  const up = await pollUntil(() => env.tcpProbe(port), env.waitMs);
  return up
    ? { ok: true, detail: `${label}已起：回读 TCP ${port} 通` }
    : {
        ok: true,
        detail: `已发出${label}启动命令；回读 TCP ${port} 仍不通（等了约 ${Math.round(env.waitMs / 1000)} 秒），稍后再看`,
      };
}

const ACTION_HANDLERS = [
  "start_gateway",
  "start_bridge",
  "restart_tunnel",
  "start_playwright",
  "start_clean_browser",
  "start_windows_mcp",
  "start_wechat",
  "prune_artifacts",
  "clear_report_queue",
] as const;

export type FixAction = (typeof ACTION_HANDLERS)[number];

export function isFixAction(action: string): action is FixAction {
  return (ACTION_HANDLERS as readonly string[]).includes(action);
}

export async function runFixAction(action: string, env: FixEnvironment): Promise<FixOutcome> {
  if (!isFixAction(action)) {
    return {
      ok: false,
      error: "unknown_action",
      message: `不认识的动作 ${action}；可用：${ACTION_HANDLERS.join(", ")}`,
    };
  }

  switch (action) {
    case "start_gateway": {
      const { startCfg } = startCommands(env.dotDir);
      // keeper 的 start_gateway 用的是 startables.gatewayPath，来源同上：gateway_cmd。
      const cmd =
        stringField(startCfg, "gateway_cmd") ||
        commandFor(env, "gateway_cmd") ||
        join(env.home, ".allbot", "gateway.cmd");
      if (!existsSync(cmd)) {
        return { ok: false, error: "fix_failed", message: `找不到 gateway.cmd：${cmd}` };
      }
      const started = await env.runProcess(`cmd /c ${quote(cmd)}`);
      if (!started.ok) {
        return { ok: false, error: "fix_failed", message: `起网关失败：${started.output}` };
      }
      const up = await pollUntil(() => env.httpProbe("http://127.0.0.1:18789/api/status"), env.waitMs);
      return up
        ? { ok: true, detail: "已起网关：回读 GET /api/status 通" }
        : {
            ok: true,
            detail: `已发出网关启动命令；回读 GET /api/status 还不通（等了约 ${Math.round(env.waitMs / 1000)} 秒，冷启动约 150 秒，稍后再看）`,
          };
    }
    case "start_bridge": {
      const entry = join(env.repoRoot, "build", "dot-bridge", "index.mjs");
      if (!existsSync(entry)) {
        return { ok: false, error: "fix_failed", message: `找不到桥入口：${entry}` };
      }
      const started = await env.runProcess(`node ${quote(entry)}`);
      if (!started.ok) {
        return { ok: false, error: "fix_failed", message: `起桥失败：${started.output}` };
      }
      const up = await pollUntil(() => env.httpProbe("http://127.0.0.1:8799/health"), env.waitMs);
      return up
        ? { ok: true, detail: "已起桥：回读 GET /health 通" }
        : { ok: true, detail: `已发出桥启动命令；回读 GET /health 仍不通，稍后再看` };
    }
    case "restart_tunnel": {
      const script = join(env.repoRoot, "build", "tools", "tunnel-keepalive.ps1");
      if (!existsSync(script)) {
        return { ok: false, error: "fix_failed", message: `找不到隧道守护脚本：${script}` };
      }
      const ran = await env.runCapture(powershellFile(script), 90000);
      const logPath = join(env.dotDir, "state", "tunnel-keepalive.log");
      let lastLine = "";
      if (existsSync(logPath)) {
        try {
          const lines = readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter((line) => line.trim() !== "");
          lastLine = lines[lines.length - 1] ?? "";
        } catch {
          lastLine = "";
        }
      }
      const tail = lastLine === "" ? "日志里没有新行" : lastLine;
      if (ran.code !== 0 && lastLine === "") {
        return { ok: false, error: "fix_failed", message: `隧道脚本退出码 ${ran.code ?? "(超时)"}：${ran.output || tail}` };
      }
      return { ok: true, detail: `隧道脚本已跑（exit=${ran.code ?? "超时"}）；回读日志最后一行：${tail}` };
    }
    case "start_playwright":
      return startAndProbePort(
        env,
        powershellFile(join(env.repoRoot, "build", "tools", "dot-up.ps1"), " -Only 8931"),
        8931,
        "Playwright MCP",
        "keeper-start.json",
      );
    case "start_clean_browser":
      return startAndProbePort(
        env,
        powershellFile(join(env.repoRoot, "build", "tools", "dot-up.ps1"), " -Only 8932"),
        8932,
        "干净浏览器",
        "keeper-start.json",
      );
    case "start_windows_mcp":
      return startAndProbePort(
        env,
        powershellFile(join(env.repoRoot, "build", "tools", "dot-up.ps1"), " -Only 8000"),
        8000,
        "Windows-MCP",
        "keeper-start.json",
      );
    case "start_wechat":
      return startAndProbePort(
        env,
        powershellFile(join(env.repoRoot, "build", "tools", "dot-up.ps1"), " -Only 8933"),
        8933,
        "微信手",
        "keeper-start.json",
      );
    case "prune_artifacts": {
      const root = join(env.dotDir, "snapshots");
      let keepTaskIds: string[] = [];
      try {
        const db = openLedger(env.ledgerPath, { readOnly: true, createDir: false, busyTimeoutMs: 2000 });
        try {
          keepTaskIds = listTasks(db, { state: [...OPEN_TASK_STATES], limit: 200 }).map((row) => row.id);
        } finally {
          db.close();
        }
      } catch {
        keepTaskIds = [];
      }
      try {
        const result = sweepSnapshots({
          root,
          limitBytes: Math.max(0, env.snapshotsMaxGb) * 1024 * 1024 * 1024,
          keepTaskIds,
        });
        return {
          ok: true,
          detail: `快照回收：删 ${result.removed.length} 个目录，腾出 ${(result.freedBytes / 1024 / 1024).toFixed(0)} MB；回读占用 ${(result.keptBytes / 1024 / 1024).toFixed(0)} MB（上限 ${env.snapshotsMaxGb} GB）`,
        };
      } catch (err) {
        return { ok: false, error: "fix_failed", message: `回收失败：${errorText(err)}` };
      }
    }
    case "clear_report_queue": {
      const queuePath = join(env.dotDir, "state", "keeper-report-queue.jsonl");
      if (!existsSync(queuePath)) {
        return { ok: true, detail: "回读队列：文件不存在，本来就是 0 行" };
      }
      let before = 0;
      try {
        before = readFileSync(queuePath, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "").length;
      } catch (err) {
        return { ok: false, error: "fix_failed", message: `队列读不了：${errorText(err)}` };
      }
      const helper = join(env.repoRoot, "build", "tools", "keeper-ledger.mjs");
      if (!existsSync(helper)) {
        return { ok: false, error: "fix_failed", message: `找不到 keeper-ledger.mjs：${helper}` };
      }
      const ran = await env.runCapture(
        `node --no-warnings ${quote(helper)} drain --db ${quote(env.ledgerPath)} --queue ${quote(queuePath)}`,
        30000,
      );
      let after = 0;
      try {
        after = readFileSync(queuePath, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "").length;
      } catch {
        after = -1;
      }
      if (ran.code !== 0) {
        return {
          ok: false,
          error: "fix_failed",
          message: `drain 退出码 ${ran.code ?? "(超时)"}：${ran.output || "没有输出"}；回读队列 ${before} → ${after === -1 ? "读不了" : after} 行`,
        };
      }
      let appended: number | null = null;
      try {
        const parsed = JSON.parse(ran.output) as Record<string, unknown>;
        if (typeof parsed.appended === "number") appended = parsed.appended;
      } catch {
        appended = null;
      }
      return {
        ok: true,
        detail: `队列已清：回读 ${before} → ${after} 行${appended === null ? "" : `，落链 ${appended} 条`}`,
      };
    }
    default:
      return { ok: false, error: "unknown_action", message: `不认识的动作 ${action}` };
  }
}
