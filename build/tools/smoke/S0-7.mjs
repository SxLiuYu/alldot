#!/usr/bin/env node
/**
 * S0-7 冒烟：ZCode 外部启动
 *
 * 方案《dot-合并方案-v2-定稿.md》第 7 节「第 0 步」S0-7 行、附录 C 的验收口径：
 *   1) 用本机现有的两种运行环境（Node、Electron）各起一次，记录哪种 exit 0；
 *   2) --mode guarded 下跑一次普通写文件动作，要求成功（正向验证）；
 *   3) 再跑一个越档动作，要求被钩子拦下（退出码 2）或无人批准时失败
 *      （No permission client 或等价），并把钩子抓到的工具名打出来作证据；
 *   4) 附录 C 另有「测试钩子返回 approve 后同一个调用执行成功」——加 --with-approve 才跑。
 *
 * 参数：
 *   --runtime node|electron|both   默认 both
 *   --mode <plan|build|edit|yolo|guarded>  默认 guarded
 *   --hook-script <path>           用指定脚本替代内置测试钩子（.mjs/.js/.cjs/.exe/.cmd/.bat）
 *   --zcode <path>                 zcode.cjs 路径（也可用环境变量 ZCODE_CJS）
 *   --electron <path>              ZCode.exe 路径（也可用环境变量 ZCODE_EXE）
 *   --node <path>                  Node 可执行文件（也可用环境变量 NODE_EXE）
 *   --timeout <ms>                 单次调用的超时，默认 300000
 *   --out-dir <path>               证据目录，默认 <系统临时目录>/dot-s0-7-<时间戳>
 *   --with-approve                 额外跑一次「钩子返回 allow → 工具执行成功」
 *   --with-build-contrast          额外用 build 模式跑一次写文件作对照（只记录，不判定）
 *   --keep-temp                    保留临时 home（里面有 .zcode/v2 凭据副本，慎用）
 *   --sweep-only                   只清理遗留的临时 home 就退出（不跑任何模型调用）
 *   --help
 *
 * 隔离做法：把 HOME/USERPROFILE 指到一个临时目录，只复制 ~/.zcode/v2 下的
 * provider_config.json / credentials.json / config.json / setting.json / onboarding-record.json，
 * 再用自己写的 ~/.zcode/cli/config.json 装两个 PreToolUse 钩子：记录器（只记工具名）
 * 和策略包装器（原样执行内置测试钩子或 --hook-script，并记下它的判定）。你的正式配置一个字不动。
 *
 * 越档判定只认结构化证据：包装器记的 decision=deny（即目标钩子退出码 2 或返回 deny）
 * 加上这条 Bash 调用的 batch 失败；「No permission client」分支才看模型回复里的原文。
 * 模型自己说「被拦了」不作为通过依据。
 *
 * 临时 home 在正常结束、异常、SIGINT/SIGTERM、进程退出时都会删；启动时还会清理
 * 上次被强杀后留下的 home（靠 home/.lock.json 里的 pid 判断，pid 已死立即删；
 * 没有锁的按 1 小时兜底），只删 home，证据目录保留。
 * 启动探测（--version）失败会自动重试一次：Electron 起法本机出现过偶发 60 秒挂起。
 *
 * 退出码：0 = PASS 或 PASS-partial；1 = FAIL；2 = 参数/前置条件错误。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const DEFAULTS = {
  zcodeCjs:
    process.env.ZCODE_CJS ||
    "C:/Users/1/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs",
  zcodeExe:
    process.env.ZCODE_EXE ||
    "C:/Users/1/AppData/Local/Programs/ZCode/ZCode.exe",
  nodeExe: process.env.NODE_EXE || process.execPath,
  runtime: "both",
  mode: "guarded",
  hookScript: null,
  timeoutMs: 300000,
  outDir: null,
  withApprove: false,
  withBuildContrast: false,
  keepTemp: false,
  sweepOnly: false,
};

// ---------------------------------------------------------------- 工具函数

function log(msg = "") {
  process.stdout.write(`${msg}\n`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, help: false };
  const takesValue = new Map([
    ["--runtime", "runtime"],
    ["--mode", "mode"],
    ["--hook-script", "hookScript"],
    ["--zcode", "zcodeCjs"],
    ["--electron", "zcodeExe"],
    ["--node", "nodeExe"],
    ["--timeout", "timeoutMs"],
    ["--out-dir", "outDir"],
  ]);
  const flags = new Map([
    ["--with-approve", "withApprove"],
    ["--with-build-contrast", "withBuildContrast"],
    ["--keep-temp", "keepTemp"],
    ["--sweep-only", "sweepOnly"],
    ["--help", "help"],
  ]);

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (takesValue.has(a)) {
      const key = takesValue.get(a);
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") throw new Error(`${a} 缺少值`);
      opts[key] = v;
    } else if (flags.has(a)) {
      opts[flags.get(a)] = true;
    } else {
      throw new Error(`不认识的参数：${a}`);
    }
  }
  return opts;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function whichNode() {
  const exe = process.execPath || "";
  if (/node(\.exe)?$/i.test(exe) && fs.existsSync(exe)) return exe;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || exe || "node";
}

function winPath(p) {
  // 提示词里给正斜杠，避免反斜杠被模型当成转义
  return p.replace(/\\/g, "/");
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 尽力而为 */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

// 清理上次被强杀/关机留下的临时 home（凭据副本）。只删 home 子目录，证据保留。
// 判断依据：home/.lock.json 里的 pid 还活着就跳过；pid 已死立即删；没有锁则按 1 小时兜底。
function sweepStaleHomes(currentOutDir, maxAgeMs = 60 * 60 * 1000) {
  const base = os.tmpdir();
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!/^dot-s0-7-/.test(name)) continue;
    const dir = path.join(base, name);
    if (path.resolve(dir) === path.resolve(currentOutDir)) continue;
    try {
      const home = path.join(dir, "home");
      if (!fs.existsSync(home)) continue;
      const lockFile = path.join(home, ".lock.json");
      let ownerPid = null;
      if (fs.existsSync(lockFile)) {
        try {
          ownerPid = JSON.parse(fs.readFileSync(lockFile, "utf8")).pid;
        } catch {
          ownerPid = null;
        }
      }
      const stale = ownerPid ? !pidAlive(ownerPid) : Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs;
      if (stale) {
        rmrf(home);
        removed.push(dir);
      }
    } catch {
      /* 忽略单个目录的读取失败 */
    }
  }
  return removed;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

function runProcess({ cmd, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let out = "";
    let err = "";
    const CAP = 16 * 1024 * 1024;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        spawnError: String(e),
        code: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        stdout: "",
        stderr: "",
      });
      return;
    }
    child.stdout.on("data", (d) => {
      if (out.length < CAP) out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (err.length < CAP) err += d.toString("utf8");
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        spawnError: String(e),
        code: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: out,
        stderr: err,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        spawnError: null,
        code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: out,
        stderr: err,
      });
    });
  });
}

function parseNdjson(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return events;
}

// 只匹配 ZCode 权限层自己的固定文案；不带泛化的 denied/blocked，避免模型措辞误判
const PERMISSION_FAILURE_RE =
  /No permission client|haven't granted it yet|requested permissions to use/i;
// 仅用于报告里的「模型怎么转述」字段，不参与判定
const BLOCK_EVIDENCE_RE =
  /hook error|denied this tool|Blocked by PreToolUse/i;

// ---------------------------------------------------------------- 临时 home

const V2_FILES = [
  "provider_config.json",
  "credentials.json",
  "config.json",
  "setting.json",
  "onboarding-record.json",
];

function buildTempHome({ tempHome, realHome, hooks }) {
  const v2Dst = path.join(tempHome, ".zcode", "v2");
  const cliDst = path.join(tempHome, ".zcode", "cli");
  fs.mkdirSync(v2Dst, { recursive: true });
  fs.mkdirSync(cliDst, { recursive: true });

  const copied = [];
  const missing = [];
  for (const name of V2_FILES) {
    const src = path.join(realHome, ".zcode", "v2", name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(v2Dst, name));
      copied.push(name);
    } else {
      missing.push(name);
    }
  }

  const cfg = {
    // 只放钩子；不复制正式配置里的 plugins/mcp，避免插件副作用
    hooks: {
      enabled: true,
      timeoutMs: 20000,
      maxOutputBytes: 32768,
      events: { PreToolUse: [{ hooks }] },
    },
  };
  fs.writeFileSync(
    path.join(cliDst, "config.json"),
    `${JSON.stringify(cfg, null, 2)}\n`,
    "utf8",
  );
  return { copied, missing };
}

function policyTargetFor(scriptPath, nodeExe) {
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === ".exe") return { cmd: scriptPath, args: [], shell: false };
  if (ext === ".cmd" || ext === ".bat" || ext === ".ps1") {
    return { cmd: `"${scriptPath}"`, args: [], shell: true };
  }
  return { cmd: nodeExe, args: [scriptPath], shell: false };
}

// ---------------------------------------------------------------- 钩子脚本

const LOGGER_SOURCE = `// S0-7 记录器钩子：只记工具名，不做判定，stdout 保持空
import fs from "node:fs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let ev = {};
try { ev = JSON.parse(raw); } catch {}
const file = process.env.ZCODE_S0_7_HOOK_LOG;
if (file) {
  const line = {
    src: "logger",
    ts: new Date().toISOString(),
    event: ev.hook_event_name || null,
    tool: ev.tool_name || null,
    mode: ev.permission_mode || null,
    input: ev.tool_input || null,
  };
  try { fs.appendFileSync(file, JSON.stringify(line) + "\\n"); } catch {}
}
process.exit(0);
`;

const GUARD_SOURCE = `// S0-7 内置测试钩子（策略）：记录判定；Bash 一律拦（exit 2）；
// 设 ZCODE_S0_7_APPROVE=1 时对其余工具返回 permissionDecision=allow。
import fs from "node:fs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let ev = {};
try { ev = JSON.parse(raw); } catch {}
const tool = String(ev.tool_name || "");
const isShell = /^(Bash|Shell|Execute|Terminal)$/i.test(tool);
const decision = isShell ? "deny" : process.env.ZCODE_S0_7_APPROVE === "1" ? "allow" : "pass";
const file = process.env.ZCODE_S0_7_HOOK_LOG;
if (file) {
  const line = {
    src: "guard",
    ts: new Date().toISOString(),
    event: ev.hook_event_name || null,
    tool: tool || null,
    mode: ev.permission_mode || null,
    decision,
    input: ev.tool_input || null,
  };
  try { fs.appendFileSync(file, JSON.stringify(line) + "\\n"); } catch {}
}
if (isShell) {
  process.stderr.write("S0-7 test hook: " + tool + " is outside the allowed tier");
  process.exit(2);
}
if (decision === "allow") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  }));
}
process.exit(0);
`;

// 策略包装器：原样执行目标钩子（内置测试钩子或 --hook-script），把它的判定记成结构化证据，
// 然后转发 stdout/stderr 和退出码。这样「钩子拦下」不再依赖模型怎么转述。
const POLICY_WRAPPER_SOURCE = `// S0-7 策略钩子包装器
import fs from "node:fs";
import { spawnSync } from "node:child_process";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let ev = {};
try { ev = JSON.parse(raw); } catch {}
let spec = {};
try { spec = JSON.parse(process.env.ZCODE_S0_7_POLICY_TARGET || "{}"); } catch {}
let status = 1;
let out = "";
let errText = "";
try {
  const r = spawnSync(spec.cmd, spec.args || [], {
    input: raw,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
    shell: spec.shell === true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) errText = String(r.error);
  status = typeof r.status === "number" ? r.status : 1;
  out = r.stdout || "";
  errText = errText || r.stderr || "";
} catch (e) {
  errText = String(e);
}
let decision = status === 2 ? "deny" : "pass";
try {
  const parsed = out.trim().startsWith("{") ? JSON.parse(out) : null;
  if (parsed) {
    const d =
      parsed.permissionDecision ||
      parsed.decision ||
      (parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision);
    if (d === "deny" || d === "block") decision = "deny";
    else if (d === "allow" || d === "approve") decision = "allow";
    else if (d === "ask") decision = "ask";
    else if (parsed.continue === false) decision = "deny";
  }
} catch {}
const file = process.env.ZCODE_S0_7_HOOK_LOG;
if (file) {
  const line = {
    src: "policy",
    ts: new Date().toISOString(),
    event: ev.hook_event_name || null,
    tool: ev.tool_name || null,
    mode: ev.permission_mode || null,
    decision,
    targetExit: status,
    stderrHead: String(errText || "").slice(0, 200),
  };
  try { fs.appendFileSync(file, JSON.stringify(line) + "\\n"); } catch {}
}
if (out) process.stdout.write(out);
if (errText) process.stderr.write(errText);
process.exit(status);
`;

// ---------------------------------------------------------------- 单次调用

function readHookLog(file, fromOffset = 0) {
  if (!fs.existsSync(file)) return { lines: [], offset: fromOffset, size: fromOffset };
  const buf = fs.readFileSync(file);
  const chunk = buf.subarray(fromOffset).toString("utf8");
  const lines = chunk
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { lines, offset: buf.length, size: buf.length };
}

async function invokePhase({ label, runtime, args, prompt, workDir, baseEnv, timeoutMs, paths, logBase, extraEnv }) {
  const startedAt = Date.now();
  const isElectron = runtime === "electron";
  const env = {
    ...baseEnv,
    ...(extraEnv || {}),
    // ZCode.exe 当 Node 用：不加这个它会去开桌面窗口，命令行参数被忽略
    ...(isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  const cmd = isElectron ? paths.zcodeExe : paths.nodeExe;
  const cmdArgs = isElectron ? [paths.zcodeCjs, ...args] : [paths.zcodeCjs, ...args];
  if (prompt !== undefined && prompt !== null) {
    cmdArgs.push("--prompt", prompt, "--output-format", "stream-json");
  }

  const hookBefore = readHookLog(logBase);
  const result = await runProcess({ cmd, args: cmdArgs, cwd: workDir, env, timeoutMs });
  const hookAfter = readHookLog(logBase, hookBefore.offset);
  const hookLines = hookAfter.lines;

  const stdoutPath = path.join(paths.logsDir, `${label}.ndjson`);
  const stderrPath = path.join(paths.logsDir, `${label}.err`);
  fs.writeFileSync(stdoutPath, result.stdout, "utf8");
  fs.writeFileSync(stderrPath, result.stderr, "utf8");

  const events = parseNdjson(result.stdout);
  const toolNames = [];
  const toolByCall = {};
  const batches = [];
  let resultLine = null;
  let response = "";
  let usage = null;
  for (const ev of events) {
    const p = ev.payload || {};
    if (ev.type === "tool.updated") {
      if (p.kind === "scheduled" && p.toolName) {
        toolNames.push(p.toolName);
        if (p.toolCallId) toolByCall[p.toolCallId] = p.toolName;
      }
      if (p.kind === "batch") {
        batches.push({
          ok: p.successCount,
          err: p.errorCount,
          ids: Array.isArray(p.toolCallIds) ? p.toolCallIds : [],
        });
      }
    }
    if (ev.type === "turn.completed" && p.response) response = String(p.response);
    if (ev.type === "result") {
      resultLine = ev;
      if (ev.response) response = String(ev.response);
      if (ev.usage) usage = ev.usage;
    }
  }

  const phase = {
    label,
    runtime,
    cmd: [cmd, ...cmdArgs].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" "),
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    durationMs: result.durationMs,
    toolNamesFromStream: [...new Set(toolNames)],
    toolByCall,
    batches,
    responseHead: response.slice(0, 800),
    usage: usage
      ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens }
      : null,
    hookLines: hookLines.map((h) => ({
      src: h.src,
      tool: h.tool,
      decision: h.decision,
      mode: h.mode,
      targetExit: h.targetExit,
      stderrHead: h.stderrHead,
    })),
    stdoutPath,
    stderrPath,
    totalMs: Date.now() - startedAt,
  };
  return phase;
}

function hookTools(phase) {
  return [...new Set(phase.hookLines.map((h) => h.tool).filter(Boolean))];
}

// ---------------------------------------------------------------- 参数校验

function validate(opts) {
  if (!["node", "electron", "both"].includes(opts.runtime)) {
    throw new Error(`--runtime 只能是 node/electron/both，收到 ${opts.runtime}`);
  }
  if (!["plan", "build", "edit", "yolo", "guarded"].includes(opts.mode)) {
    throw new Error(`--mode 不认识：${opts.mode}`);
  }
  opts.timeoutMs = Number(opts.timeoutMs);
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 10000) {
    throw new Error("--timeout 至少 10000 毫秒");
  }
  if (!fs.existsSync(opts.zcodeCjs)) {
    throw new Error(`zcode.cjs 不存在：${opts.zcodeCjs}（用 --zcode 指定）`);
  }
  if (!opts.nodeExe || !fs.existsSync(opts.nodeExe)) {
    const resolved = whichNode();
    if (!resolved) throw new Error("找不到 Node 可执行文件（用 --node 指定）");
    opts.nodeExe = resolved;
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      log("用法：node build/tools/smoke/S0-7.mjs [--runtime node|electron|both] [--mode guarded] [--hook-script <path>]");
      log("其他参数见文件头注释；证据目录 --out-dir，默认系统临时目录下。");
      process.exit(EXIT_PASS);
    }
    opts.nodeExe = opts.nodeExe && fs.existsSync(opts.nodeExe) ? opts.nodeExe : whichNode();
    validate(opts);
  } catch (e) {
    log(`参数错误：${e.message}`);
    process.exit(EXIT_USAGE);
  }

  const runtimes =
    opts.runtime === "both" ? ["node", "electron"] : [opts.runtime];
  if (runtimes.includes("electron") && !fs.existsSync(opts.zcodeExe)) {
    log(`注意：Electron 可执行文件不存在：${opts.zcodeExe}（该运行时会记为启动失败）`);
  }

  const outDir = path.resolve(
    opts.outDir || path.join(os.tmpdir(), `dot-s0-7-${stamp()}`),
  );
  if (opts.sweepOnly) {
    const removed = sweepStaleHomes(outDir);
    log(
      removed.length
        ? `已清理 ${removed.length} 个遗留 home：${removed.join(", ")}`
        : "没有需要清理的遗留 home。",
    );
    process.exit(EXIT_PASS);
  }
  const logsDir = path.join(outDir, "logs");
  const tempHome = path.join(outDir, "home");
  const realHome = os.homedir();
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(tempHome, { recursive: true });
  // 存活标记：下次启动靠 pid 判断上次是不是被强杀，被强杀的 home 立即清掉
  fs.writeFileSync(
    path.join(tempHome, ".lock.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );

  const logBase = path.join(logsDir, "hooks.jsonl");
  fs.writeFileSync(logBase, "", "utf8");
  const swept = sweepStaleHomes(outDir);
  if (swept.length) {
    log(`已清理 ${swept.length} 个上次中断留下的临时 home（凭据副本）：${swept.join(", ")}`);
  }

  // 内置钩子脚本
  const loggerPath = path.join(outDir, "hook-logger.mjs");
  const guardPath = path.join(outDir, "hook-guard.mjs");
  fs.writeFileSync(loggerPath, LOGGER_SOURCE, "utf8");
  fs.writeFileSync(guardPath, GUARD_SOURCE, "utf8");

  let policyScript = guardPath;
  if (opts.hookScript) {
    policyScript = path.resolve(opts.hookScript);
    if (!fs.existsSync(policyScript)) {
      log(`参数错误：--hook-script 不存在：${policyScript}`);
      process.exit(EXIT_USAGE);
    }
  }

  const policyTarget = policyTargetFor(policyScript, opts.nodeExe);
  const policyWrapperPath = path.join(outDir, "hook-policy.mjs");
  fs.writeFileSync(policyWrapperPath, POLICY_WRAPPER_SOURCE, "utf8");

  const hookEntries = [
    { type: "process", command: opts.nodeExe, args: [loggerPath], timeoutMs: 15000 },
    {
      type: "process",
      command: opts.nodeExe,
      args: [policyWrapperPath],
      timeoutMs: 20000,
      onError: "deny",
    },
  ];

  log("=== S0-7 ZCode 外部启动冒烟 ===");
  log(`zcode.cjs: ${opts.zcodeCjs}`);
  log(`node:       ${opts.nodeExe}`);
  log(`electron:   ${opts.zcodeExe}`);
  log(`runtime:    ${runtimes.join(" + ")}   mode: ${opts.mode}   timeout: ${opts.timeoutMs}ms`);
  log(`钩子策略:   ${policyScript === guardPath ? "内置测试钩子（拦 Bash）" : policyScript}`);
  log(`证据目录:   ${outDir}`);
  log("");

  const homeInfo = buildTempHome({ tempHome, realHome, hooks: hookEntries });
  if (homeInfo.missing.length) {
    log(
      `注意：正式 home 缺少 ${homeInfo.missing.join(", ")}，模型调用可能失败（这些文件在 ~/.zcode/v2/）。`,
    );
  }

  const baseEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    ZCODE_DATA_BASE_DIR: tempHome,
    ZCODE_STORAGE_DIR: path.join(tempHome, ".zcode"),
    ZCODE_S0_7_HOOK_LOG: logBase,
    ZCODE_S0_7_POLICY_TARGET: JSON.stringify(policyTarget),
  };
  delete baseEnv.ZCODE_S0_7_APPROVE;

  const paths = { zcodeCjs: opts.zcodeCjs, zcodeExe: opts.zcodeExe, nodeExe: opts.nodeExe, logsDir };
  const report = {
    startedAt: new Date().toISOString(),
    args: { ...opts },
    outDir,
    tempHome,
    hookScript: policyScript,
    realHomeMissing: homeInfo.missing,
    runtimes: {},
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned || opts.keepTemp) return;
    cleaned = true;
    rmrf(tempHome);
  };
  // 正常收尾、异常退出、Ctrl+C、被 kill、关终端都走这里，别把凭据副本留在盘上
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }

  for (const runtime of runtimes) {
    const workDir = path.join(outDir, `work-${runtime}`);
    fs.mkdirSync(workDir, { recursive: true });
    const entry = { runtime, phases: {} };
    report.runtimes[runtime] = entry;

    log(`--- ${runtime} ---`);

    // 1) 启动探测：--version，不花模型 token。Electron 起法本机偶发 60 秒挂起，重试一次
    const attempts = [];
    let startPhase = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const p = await invokePhase({
        label: attempt === 1 ? `${runtime}-start` : `${runtime}-start-retry`,
        runtime,
        args: ["--version"],
        prompt: null,
        workDir,
        baseEnv,
        timeoutMs: Math.min(opts.timeoutMs, 60000),
        paths,
        logBase,
      });
      p.attempt = attempt;
      // --version 走纯文本输出，从 stdout 文件取版本号
      let versionOut = "";
      try {
        versionOut = fs.readFileSync(p.stdoutPath, "utf8").trim().split(/\r?\n/)[0] || "";
      } catch {
        /* ignore */
      }
      p.version = versionOut;
      attempts.push(p);
      if (p.exitCode === 0 && !p.spawnError) {
        startPhase = p;
        break;
      }
    }
    if (!startPhase) startPhase = attempts[attempts.length - 1];
    const startOk = !!startPhase && startPhase.exitCode === 0 && !startPhase.spawnError;
    entry.phases.start = startPhase;
    entry.startAttempts = attempts.map((p) => ({
      attempt: p.attempt,
      exitCode: p.exitCode,
      timedOut: p.timedOut,
      durationMs: p.durationMs,
    }));
    entry.startOk = startOk;
    if (attempts.length > 1 && startOk) {
      log(
        `[${runtime}] 提示：第 1 次启动 ${
          attempts[0].timedOut ? "超时" : `exit=${attempts[0].exitCode}`
        }，重试后通过（Electron 起法有偶发挂起，属已知现象）。`,
      );
    }
    log(
      `[${runtime}] 启动 (--version) ... exit=${startPhase.exitCode}` +
        `${startPhase.timedOut ? " timeout" : ""}${startPhase.version ? ` 版本=${startPhase.version}` : ""} → ${startOk ? "PASS" : "FAIL"}`,
    );

    if (!startOk) {
      log(`[${runtime}] 启动失败，跳过后续动作。${startPhase.spawnError || ""}`);
      continue;
    }

    // 2) 普通写文件（正向验证）
    const writeFile = path.join(workDir, `write-${runtime}.txt`);
    const writePrompt =
      `Use the Write tool exactly once to create the file ${winPath(writeFile)} ` +
      `with the text smoke-ok. Do not use Bash or any other tool. Then reply done.`;
    rmrf(writeFile);
    const writePhase = await invokePhase({
      label: `${runtime}-write`,
      runtime,
      args: ["--cwd", workDir, "--mode", opts.mode],
      prompt: writePrompt,
      workDir,
      baseEnv,
      timeoutMs: opts.timeoutMs,
      paths,
      logBase,
    });
    const writeExists = fs.existsSync(writeFile);
    let writeContent = "";
    try {
      writeContent = fs.readFileSync(writeFile, "utf8").trim();
    } catch {
      /* ignore */
    }
    const writePermErr = PERMISSION_FAILURE_RE.test(writePhase.responseHead);
    const writeBatchOk = writePhase.batches.every((b) => (b.err || 0) === 0);
    const writeOk =
      writeExists && writeContent.includes("smoke-ok") && !writePermErr && writeBatchOk;
    writePhase.artifact = { path: writeFile, exists: writeExists, content: writeContent.slice(0, 80) };
    writePhase.permissionError = writePermErr;
    writePhase.pass = writeOk;
    entry.phases.write = writePhase;
    const writeAssert = opts.mode === "guarded" ? "（需判定）" : "（非 guarded 模式，只记录）";
    log(
      `[${runtime}] 普通写文件 (mode=${opts.mode}) ... exit=${writePhase.exitCode} ` +
        `产物=${writeExists ? "有" : "无"} batch=${writePhase.batches.map((b) => `${b.ok}/${b.err}`).join(",") || "-"} ` +
        `→ ${writeOk ? "PASS" : "FAIL"} ${writeAssert}`,
    );
    if (writePermErr) {
      log(`  模型侧报权限失败：${writePhase.responseHead.slice(0, 200)}`);
    }
    if (opts.mode !== "guarded") {
      entry.writeAsserted = false;
    } else {
      entry.writeAsserted = true;
      entry.writeOk = writeOk;
    }

    // 3) 越档动作：让模型调 Bash，期望被钩子 exit 2 拦下，或无人批准失败
    const denyPrompt =
      "Use the Bash tool to run this exact command: curl -s -o NUL https://example.com . " +
      "Do not use any other tool. Report exactly what happened.";
    const denyPhase = await invokePhase({
      label: `${runtime}-deny`,
      runtime,
      args: ["--cwd", workDir, "--mode", opts.mode],
      prompt: denyPrompt,
      workDir,
      baseEnv,
      timeoutMs: opts.timeoutMs,
      paths,
      logBase,
    });
    const denyTools = hookTools(denyPhase);
    const shellToolRe = /^(Bash|Shell|Execute|Terminal)$/i;
    const sawBash =
      denyPhase.hookLines.some((h) => shellToolRe.test(String(h.tool || ""))) ||
      denyPhase.toolNamesFromStream.some((t) => shellToolRe.test(t));
    const policyLine = denyPhase.hookLines.find(
      (h) => h.src === "policy" && shellToolRe.test(String(h.tool || "")),
    );
    const policyDecision = policyLine ? policyLine.decision : null;
    // 只有「失败的那批里确实包含这次 Bash 调用」才算数，避免别的工具失败凑数
    const bashFailed = denyPhase.batches.some(
      (b) =>
        (b.err || 0) > 0 &&
        (b.ids || []).some((id) => shellToolRe.test(String(denyPhase.toolByCall?.[id] || ""))),
    );
    const permitText = PERMISSION_FAILURE_RE.test(denyPhase.responseHead);
    // 主证据：包装器记下目标钩子退出码 2 / 返回 deny，且这次 Bash 的 batch 失败
    const hookBlocked = policyDecision === "deny" && bashFailed;
    // 次证据（只在钩子没拦时用）：无人批准时 ZCode 自己的固定文案
    const approvalBlocked = !hookBlocked && bashFailed && permitText;
    const denyOk = sawBash && (hookBlocked || approvalBlocked);
    denyPhase.pass = denyOk;
    denyPhase.evidence = {
      sawBash,
      policyDecision,
      policyStderr: policyLine ? policyLine.stderrHead : null,
      bashBatchFailed: bashFailed,
      permissionTextInReply: permitText,
      modelMentionsBlock: BLOCK_EVIDENCE_RE.test(denyPhase.responseHead),
      source: hookBlocked ? "hook-exit-2/deny" : approvalBlocked ? "no-permission-client" : "none",
    };
    entry.phases.deny = denyPhase;
    entry.denyOk = denyOk;
    log(
      `[${runtime}] 越档动作 (Bash) ... exit=${denyPhase.exitCode} ` +
        `钩子看到=${denyTools.join(",") || "(无)"} 判定=${policyDecision || "无"} ` +
        `batch=${denyPhase.batches.map((b) => `${b.ok}/${b.err}`).join(",") || "-"} ` +
        `→ ${denyOk ? `PASS(${denyPhase.evidence.source})` : "FAIL"}`,
    );
    if (!denyOk) {
      log(`  response: ${denyPhase.responseHead.slice(0, 300)}`);
    }

    // 4) 可选：钩子返回 allow 后同一动作成功（附录 C）
    if (opts.withApprove) {
      if (policyScript !== guardPath) {
        log(`[${runtime}] --with-approve 只对内置钩子有意义，跳过（当前用自备钩子）。`);
      } else {
        const allowFile = path.join(workDir, `approve-${runtime}.txt`);
        const allowPrompt =
          `Use the Write tool exactly once to create the file ${winPath(allowFile)} ` +
          `with the text smoke-ok. Do not use Bash or any other tool. Then reply done.`;
        rmrf(allowFile);
        const allowPhase = await invokePhase({
          label: `${runtime}-approve`,
          runtime,
          args: ["--cwd", workDir, "--mode", opts.mode],
          prompt: allowPrompt,
          workDir,
          baseEnv,
          timeoutMs: opts.timeoutMs,
          paths,
          logBase,
          extraEnv: { ZCODE_S0_7_APPROVE: "1" },
        });
        const allowExists = fs.existsSync(allowFile);
        let allowContent = "";
        try {
          allowContent = fs.readFileSync(allowFile, "utf8").trim();
        } catch {
          /* ignore */
        }
        const allowPermErr = PERMISSION_FAILURE_RE.test(allowPhase.responseHead);
        const allowOk = allowExists && allowContent.includes("smoke-ok") && !allowPermErr;
        allowPhase.artifact = { path: allowFile, exists: allowExists, content: allowContent.slice(0, 80) };
        allowPhase.pass = allowOk;
        entry.phases.approve = allowPhase;
        entry.approveOk = allowOk;
        log(
          `[${runtime}] 钩子返回 allow ... exit=${allowPhase.exitCode} 产物=${allowExists ? "有" : "无"} ` +
            `→ ${allowOk ? "PASS" : "FAIL"}`,
        );
      }
    }

    // 5) 可选对照：build 模式写文件（只记录）
    if (opts.withBuildContrast) {
      const contrastFile = path.join(workDir, `build-contrast-${runtime}.txt`);
      rmrf(contrastFile);
      const contrastPrompt =
        `Use the Write tool exactly once to create the file ${winPath(contrastFile)} ` +
        `with the text smoke-ok. Do not use Bash or any other tool. Then reply done.`;
      const contrastPhase = await invokePhase({
        label: `${runtime}-build-contrast`,
        runtime,
        args: ["--cwd", workDir, "--mode", "build"],
        prompt: contrastPrompt,
        workDir,
        baseEnv,
        timeoutMs: opts.timeoutMs,
        paths,
        logBase,
      });
      const exists = fs.existsSync(contrastFile);
      contrastPhase.artifact = { path: contrastFile, exists };
      contrastPhase.permissionError = PERMISSION_FAILURE_RE.test(contrastPhase.responseHead);
      entry.phases.buildContrast = contrastPhase;
      log(
        `[${runtime}] 对照 build 模式写文件 ... exit=${contrastPhase.exitCode} 产物=${exists ? "有" : "无"} ` +
          `权限失败=${contrastPhase.permissionError ? "是" : "否"}（只记录）`,
      );
    }

    log("");
  }

  // ------------------------------------------------------------ 判定

  const requestedStarted = runtimes.filter((r) => report.runtimes[r]?.startOk);
  const missingStart = runtimes.filter((r) => !report.runtimes[r]?.startOk);
  const failures = [];
  for (const r of requestedStarted) {
    const e = report.runtimes[r];
    if (e.writeAsserted && !e.writeOk) failures.push(`${r} 普通写文件失败`);
    if (!e.denyOk) failures.push(`${r} 越档动作未被拦下`);
    if (e.approveOk === false) failures.push(`${r} 钩子 allow 后未执行成功`);
  }

  let verdict;
  if (requestedStarted.length === 0) {
    verdict = "FAIL";
    const details = runtimes
      .map((r) => {
        const last = report.runtimes[r]?.phases?.start;
        return `${r}：exit=${last?.exitCode ?? "null"}${last?.timedOut ? "/超时" : ""}${
          last?.spawnError ? "/启动错误" : ""
        }`;
      })
      .join("；");
    failures.push(
      runtimes.length > 1
        ? `两种起法都没 exit 0（${details}）`
        : `${runtimes[0]} 启动失败（--version 未 exit 0：${details}）`,
    );
  } else if (failures.length > 0) {
    verdict = "FAIL";
  } else if (missingStart.length > 0) {
    verdict = "PASS-partial";
  } else {
    verdict = "PASS";
  }

  // 汇总钩子看到的工具名
  const toolsByRuntime = {};
  for (const r of runtimes) {
    const e = report.runtimes[r];
    const names = new Set();
    for (const p of Object.values(e.phases)) {
      for (const t of hookTools(p)) names.add(t);
    }
    toolsByRuntime[r] = [...names];
  }

  report.verdict = verdict;
  report.failures = failures;
  report.toolsSeenByHook = toolsByRuntime;
  report.finishedAt = new Date().toISOString();

  log("=== 汇总 ===");
  for (const r of runtimes) {
    const e = report.runtimes[r];
    const started = e.startOk ? "PASS" : "FAIL";
    const write = e.writeAsserted ? (e.writeOk ? "PASS" : "FAIL") : "记录";
    const deny = e.denyOk ? "PASS" : "FAIL";
    const hookToolsLine = toolsByRuntime[r].join(", ") || "(无)";
    log(
      `${r.padEnd(9)} 启动=${started.padEnd(5)} 写文件=${write.padEnd(5)} 拦截=${deny.padEnd(5)} 钩子看到: ${hookToolsLine}`,
    );
  }
  if (opts.withApprove) {
    for (const r of runtimes) {
      const e = report.runtimes[r];
      if (e.approveOk !== undefined) log(`${r.padEnd(9)} 钩子 allow 后执行=${e.approveOk ? "PASS" : "FAIL"}`);
    }
  }
  log("");
  if (verdict === "PASS") {
    log(`判定：PASS —— 各运行时 exit 0；mode=${opts.mode} 下写文件成功；越档动作被拦下。`);
  } else if (verdict === "PASS-partial") {
    log(
      `判定：PASS-partial —— ${requestedStarted.join("、")} 通过；${missingStart.join("、")} 未起来。` +
        `（附录 C 的口径是「两种起法至少一种 exit 0」，但方案表要求两种都能跑，需人工确认。）`,
    );
  } else {
    log(`判定：FAIL —— ${failures.join("；")}`);
  }
  log(`证据：${logBase}`);
  log(`      ${path.join(logsDir, "*")}（每个阶段一份 ndjson + err）`);

  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`报告：${path.join(outDir, "report.json")}`);

  cleanup();
  log(
    opts.keepTemp
      ? `临时 home 已保留（含 .zcode/v2 凭据副本）：${tempHome}`
      : "临时 home 已删除（凭据副本未留存）。",
  );

  process.exit(verdict === "FAIL" ? EXIT_FAIL : EXIT_PASS);
}

main().catch((e) => {
  log(`运行出错：${e?.stack || e}`);
  process.exit(EXIT_FAIL);
});
