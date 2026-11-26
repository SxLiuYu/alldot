#!/usr/bin/env node
/**
 * blackout-drill.mjs —— 第 1 步验收 4 的自动化部分：断电演练。
 *
 * 做法：派一个任务 → 等它进 running → 硬杀网关（等价断电）→ 重起 → 等它自己接上 →
 * 看账本有没有「同一步被做了两次」。重复 N 次（方案要求 3 次）。
 *
 * 判据（方案第 7 节第 1 步验收 4）：
 *   三次强杀之后任务最终做完，且账本里没有重复动作。
 *   「重复动作」用 steps 表的 (task_id, seq) 唯一约束 + subject_key 计数来看：
 *   同一个 subject_key 出现两条 succeeded，就是重复做了。
 *
 * 用法：
 *   node build/tools/blackout-drill.mjs                 # 跑 3 轮
 *   node build/tools/blackout-drill.mjs --rounds 1      # 跑 1 轮（先试手感）
 *   node build/tools/blackout-drill.mjs --dry-run       # 只检查前置，不动网关
 *
 * 退出码：0 通过 / 1 不通过 / 2 前置缺失
 *
 * 它会真的杀 allbot 网关。跑之前确认没有别的工作流正靠它做事。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const DOT = "C:/Users/1/Documents/研究/dot";
const LEDGER = join(homedir(), ".allbot", "dot", "ledger", "dot.db");
const BRIDGE_TOKEN = join(homedir(), ".allbot", "dot", "bridge-token");
const GATEWAY_PORT = 18789;
const BRIDGE_PORT = 8799;
const EVIDENCE = join(DOT, "build", "记录", "断电演练.md");

function parseArgs(argv) {
  const o = { rounds: 3, dryRun: false, waitMs: 240000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--rounds") o.rounds = Number(argv[++i]);
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--wait-ms") o.waitMs = Number(argv[++i]);
    else if (a === "--help") {
      console.log("用法: node build/tools/blackout-drill.mjs [--rounds 3] [--dry-run] [--wait-ms 240000]");
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(o.rounds) || o.rounds < 1) o.rounds = 3;
  return o;
}

function listeningPid(port) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
    { encoding: "utf8", timeout: 20000 });
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function httpOk(url, headers = {}) {
  try {
    const r = await fetch(url, { headers });
    return r.status;
  } catch {
    return 0;
  }
}

async function waitFor(fn, timeoutMs, stepMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

function startGateway() {
  mkdirSync(join(DOT, "tmp"), { recursive: true });
  const log = join(DOT, "tmp", "gateway-drill.log");
  const out = spawnSync("powershell", ["-NoProfile", "-Command",
    `Start-Process -FilePath 'C:/Program Files/nodejs/node.exe' -ArgumentList 'C:/allbot-public/dist/index.js','gateway','--port','${GATEWAY_PORT}' -RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`],
    { encoding: "utf8", timeout: 30000 });
  const pid = Number((out.stdout ?? "").trim());
  return Number.isFinite(pid) ? pid : null;
}

function killPid(pid) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8", timeout: 20000 });
  return r.status === 0;
}

/**
 * 只读打开账本（拷一份再读，避免和网关抢锁）。
 *
 * 2026-11-25 真机教训：账本是 WAL 模式，只拷 .db 不拷 `-wal` / `-shm`，
 * 最近写进去的东西全看不见——演练里表现成「任务查不到、一步都没有」，
 * 而实际账本里那个任务已经 done、2 步都成功。三个文件一起拷。
 */
function readLedger() {
  const copy = join(DOT, "tmp", `drill-ledger-${process.pid}.db`);
  const script = [
    `Remove-Item -LiteralPath '${copy}' -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath '${copy}-wal' -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath '${copy}-shm' -ErrorAction SilentlyContinue`,
    `Copy-Item -LiteralPath '${LEDGER}' -Destination '${copy}' -Force`,
    `foreach ($s in @('-wal','-shm')) { $src = '${LEDGER}' + $s; if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination ('${copy}' + $s) -Force } }`,
  ].join("; ");
  spawnSync("powershell", ["-NoProfile", "-Command", script], { timeout: 20000 });
  const db = new DatabaseSync(copy, { readOnly: true });
  return db;
}

async function dispatchTask(intent) {
  const tok = readFileSync(BRIDGE_TOKEN, "utf8").trim();
  const url = `http://127.0.0.1:${BRIDGE_PORT}/mcp`;
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-dot-bridge-token": tok };
  const init = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "drill", version: "0" } } }) });
  const sid = init.headers.get("mcp-session-id");
  await init.text();
  const H = { ...h, ...(sid ? { "mcp-session-id": sid } : {}) };
  await fetch(url, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((r) => r.text());
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "brain_task", arguments: { intent, restated: intent, bot: "drill", declared: { done_when: "任务落账到 done 或 failed" } } },
  });
  const r = await fetch(url, { method: "POST", headers: H, body });
  const text = await r.text();
  const chunks = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  const payload = JSON.parse(chunks.length ? chunks.join("") : text);
  return (payload.result?.content ?? []).map((c) => c.text ?? "").join(" ");
}

function taskState(db, taskId) {
  const row = db.prepare("SELECT state, run_epoch, spent_tokens FROM tasks WHERE id = ?").get(taskId);
  return row ?? null;
}

/** 同一 subject_key 出现多条 succeeded = 同一步被做了两次。 */
function duplicateSucceeded(db, taskId) {
  return db.prepare(
    "SELECT subject_key, COUNT(*) AS n FROM steps WHERE task_id = ? AND status = 'succeeded' GROUP BY subject_key HAVING n > 1",
  ).all(taskId);
}

function stepsOf(db, taskId) {
  return db.prepare("SELECT seq, status, tool, subject_key FROM steps WHERE task_id = ? ORDER BY seq").all(taskId);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const problems = [];
  if (!existsSync(LEDGER)) problems.push(`账本不存在：${LEDGER}`);
  if (!existsSync(BRIDGE_TOKEN)) problems.push(`桥 token 不存在：${BRIDGE_TOKEN}`);
  const gwPid = listeningPid(GATEWAY_PORT);
  const brPid = listeningPid(BRIDGE_PORT);
  if (gwPid === null) problems.push(`网关没在 ${GATEWAY_PORT} 上监听`);
  if (brPid === null) problems.push(`桥没在 ${BRIDGE_PORT} 上监听`);
  if (problems.length > 0) {
    console.error("前置不满足：");
    for (const p of problems) console.error(" -", p);
    process.exit(2);
  }

  console.log(`前置检查通过：网关 PID ${gwPid}、桥 PID ${brPid}。`);
  console.log(`轮数 ${o.rounds}${o.dryRun ? "（--dry-run：不会杀网关）" : ""}`);
  if (o.dryRun) {
    console.log("--dry-run：只检查了前置，什么都没动。");
    return;
  }

  const lines = [
    "# 断电演练（自动跑的那一段）",
    "",
    `跑于 ${new Date().toISOString()}，${o.rounds} 轮。`,
    "",
    "| 轮 | 任务 | 杀之前状态 | 重起耗时 | 杀之后状态 | 重复动作 | 结论 |",
    "|---|---|---|---|---|---|---|",
  ];
  let allPass = true;

  for (let round = 1; round <= o.rounds; round += 1) {
    const intent = `断电演练第 ${round} 轮：在练习文件夹里建一个叫 drill-${round}-${Date.now()} 的空文件夹，做完回报路径`;
    const launchedAt = Date.now();
    let taskId = "";
    try {
      const out = await dispatchTask(intent);
      const m = /task_[0-9a-f]{20,}/.exec(out);
      taskId = m ? m[0] : "";
      if (!taskId) throw new Error(`brain_task 没回任务号：${out.slice(0, 200)}`);
      console.log(`第 ${round} 轮：任务 ${taskId} 已派出。`);

      // 等它进 running（或者直接 done —— 太快的话杀不到，也算一次数据点）
      const running = await waitFor(async () => {
        const db = readLedger();
        const st = taskState(db, taskId);
        db.close();
        return st !== null && (st.state === "running" || st.state === "awaiting_approval");
      }, 120000);
      const db0 = readLedger();
      const before = taskState(db0, taskId);
      db0.close();
      console.log(`  杀之前状态：${before?.state ?? "查不到"}（等到 running：${running}）`);

      // 硬杀网关
      const pid = listeningPid(GATEWAY_PORT);
      if (pid === null) throw new Error("杀之前发现网关已经不在了");
      const killed = killPid(pid);
      console.log(`  已强杀网关 PID ${pid}：${killed ? "成功" : "失败"}`);
      await new Promise((r) => setTimeout(r, 3000));

      // 重起
      const restartedAt = Date.now();
      const newPid = startGateway();
      const up = await waitFor(async () => (await httpOk(`http://127.0.0.1:${GATEWAY_PORT}/api/status`)) === 200, 300000);
      const restartMs = Date.now() - restartedAt;
      console.log(`  重起：PID ${newPid ?? "?"}，${up ? `端口 ${Math.round(restartMs / 1000)} 秒回来` : "5 分钟内没回来"}`);
      if (!up) throw new Error("网关起不来");

      // 等任务自己走完（或到 failed / 一直卡着）
      const settled = await waitFor(async () => {
        const db = readLedger();
        const st = taskState(db, taskId);
        db.close();
        return st !== null && ["done", "failed", "cancelled"].includes(st.state);
      }, o.waitMs);

      const db1 = readLedger();
      const after = taskState(db1, taskId);
      const dups = duplicateSucceeded(db1, taskId);
      const steps = stepsOf(db1, taskId);
      db1.close();

      const pass = settled && after.state === "done" && dups.length === 0;
      if (!pass) allPass = false;
      console.log(`  最终状态：${after?.state ?? "查不到"}；重复动作：${dups.length} 条`);
      console.log(`  步骤：${steps.map((s) => `${s.seq}:${s.status}`).join(" ") || "（没有步骤）"}`);

      lines.push(
        `| ${round} | ${taskId} | ${before?.state ?? "-"} | ${Math.round(restartMs / 1000)}s | ${after?.state ?? "-"} | ${dups.length} | ${pass ? "过" : "没过"} |`,
      );
      if (dups.length > 0) {
        lines.push("", `第 ${round} 轮重复的 subject_key：`, ...dups.map((d) => `- \`${d.subject_key}\` 做了 ${d.n} 次`), "");
      }
      void launchedAt;
    } catch (e) {
      allPass = false;
      console.log(`  第 ${round} 轮出错：${e.message}`);
      lines.push(`| ${round} | ${taskId || "-"} | - | - | 出错 | - | ${e.message.slice(0, 60)} |`);
    }
  }

  lines.push("", `最后一轮结束时网关是否在跑：${listeningPid(GATEWAY_PORT) !== null ? "在" : "不在（需要手动起）"}`, "");
  lines.push(`DRILL: ${allPass ? "PASS" : "FAIL"}`);
  writeFileSync(EVIDENCE, lines.join("\n") + "\n", "utf8");
  console.log("");
  console.log(`证据写到 ${EVIDENCE}`);
  console.log(`DRILL: ${allPass ? "PASS" : "FAIL"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("演练脚本自己出错：", e);
  process.exit(1);
});
