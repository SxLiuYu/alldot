#!/usr/bin/env node
/**
 * 口闸补丁五道验证（dot-合并方案-v2-定稿.md 附录 B.1 / 附录 C：verify-ds-bot.mjs）
 *
 * ① 标记在（三处 // dot: 标记对，guard/tail 各一对 no-hands，delegation-refusal 一对）
 * ② node --check 语法过
 * ③ 从 patched 文件按标记切出 dotBotToolRefusal，喂 102 名单：6 放行 / 96 拒；
 *    另断言 4 个 brain_* 桥工具放行（B.1 允许名单共 10 个）
 * ④ 口闸心跳文件存在且是新的（心跳时间戳 ≥ 补丁文件写盘时间）
 * ⑤ ds-bot 主进程在补丁写盘之后启动（补丁已经加载进运行时），且心跳新于进程启动；
 *    进程早于补丁启动（ESM 旧代码驻留，机器人照样有手）就报
 *    「已打补丁未生效，请重启 ds-bot」，不能报绿
 *
 * 硬约束：本脚本默认只读目标安装目录，绝不写 C:/Users/1/.dsh/ 下任何文件。
 * 测试可用 --target/--heartbeat/--start-time 指向临时目录；只有显式传
 * --write-heartbeat 时才写心跳（供安装脚本调用，默认关）。
 *
 * 用法：
 *   node build/patches/ds-bot/verify.mjs                   # 查正式安装（只读）
 *   node build/patches/ds-bot/verify.mjs --target <file> --heartbeat <file> \
 *        --start-time <ISO|ms> [--json] [--write-heartbeat]
 * 退出码：0 PASS / 1 FAIL / 2 前置缺失
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  TOOLS_102,
  MOUTH_ALLOW,
  BRAIN_ALLOW,
  HEARTBEAT_PATH,
  TARGET_PATH,
  MARKERS,
  sha256,
  extractTailedFunction,
} from "./lib/patch-def.mjs";

export function parseArgs(argv) {
  const o = {
    target: TARGET_PATH,
    heartbeat: HEARTBEAT_PATH,
    startTime: null,
    json: false,
    writeHeartbeat: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--target") o.target = argv[++i];
    else if (a === "--heartbeat") o.heartbeat = argv[++i];
    else if (a === "--start-time") o.startTime = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--write-heartbeat") o.writeHeartbeat = true;
    else if (a === "--help") {
      console.log("用法: node build/patches/ds-bot/verify.mjs [--target f] [--heartbeat f] [--start-time ISO|ms] [--json] [--write-heartbeat]");
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return o;
}

/**
 * 时间戳解析成整数毫秒；认不出返回 null。
 *
 * statSync().mtimeMs 是浮点（本机实测 1795530535640.9275），Date.parse 拿它得
 * NaN，所以不能用整数正则先卡一遍：先 Number() 再看 Number.isFinite()，命中的
 * 一律 Math.trunc 截断成整数毫秒，保证所有比较都在整数域里做。
 */
export function parseTime(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return Number.isFinite(s) ? Math.trunc(s) : null;
  const str = String(s).trim();
  if (str === "") return null;
  const n = Number(str);
  if (Number.isFinite(n)) return Math.trunc(n);
  const t = Date.parse(str);
  return Number.isFinite(t) ? t : null;
}

/** 心跳里的时间键，按优先级取第一个能解析成有限值的（不是第一个存在的）。 */
const HB_TIME_KEYS = ["patchedAt", "writtenAt", "ts"];

/**
 * 从心跳 JSON 里取时间，取不到退回心跳文件自身 mtime。
 * 返回 { t, src }；src 用于把「到底按哪个时间判的」写进 detail。
 */
export function heartbeatTime(data, stat) {
  if (data && typeof data === "object") {
    for (const k of HB_TIME_KEYS) {
      const t = parseTime(data[k]);
      if (t !== null) return { t, src: k };
    }
  }
  // 兜底：空 JSON（{}）或键值都不能解析时按文件 mtime 算新。
  // mtimeMs 是浮点，parseTime 已截断，所以这条是真能走到的分支。
  const t = stat ? parseTime(stat.mtimeMs) : null;
  return { t, src: t === null ? "-" : "fileMtime" };
}

/** 从 Windows 进程表里查 ds-bot 主进程启动时间；查不到返回 null。 */
export function dsBotProcessStart() {
  const ps = [
    "-NoProfile",
    "-Command",
    "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ds-bot' -or ($_.Name -like 'DeepSeek Harness*' -and $_.CommandLine -match 'profiles\\\\desktop') } | Sort-Object CreationDate | Select-Object -First 1; if ($p) { ([DateTime]$p.CreationDate).ToUniversalTime().ToString('o') }",
  ];
  const r = spawnSync("powershell", ps, { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  return parseTime(r.stdout.trim());
}

/** ③ 切函数 → 沙箱执行 → 喂名单。返回 allow/deny 明细。*/
export function runToollistAssertion(source) {
  const fn = extractTailedFunction(source);
  // 沙箱把 fs 相关符号换成会抛错的桩：dotRefreshMouth 的 catch 会保留内置
  // DOT_MOUTH，从而断言只针对 B.1 固定名单，不依赖正式机器上的 policy.json。
  const sandbox = {
    readFileSync: () => { throw new Error("sandbox: no fs"); },
    appendFileSync: () => { throw new Error("sandbox: no fs"); },
    statSync: () => { throw new Error("sandbox: no fs"); },
    Date,
    JSON,
    Set,
    console,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(`${fn}\n;globalThis.__refusal = dotBotToolRefusal;`, ctx, { timeout: 5000 });
  const refusal = sandbox.__refusal;
  if (typeof refusal !== "function") throw new Error("dotBotToolRefusal 不是函数");

  const allowed = new Set([...MOUTH_ALLOW, ...BRAIN_ALLOW]);
  const result = { total: 0, allow: 0, deny: 0, unexpectedAllow: [], unexpectedDeny: [], errors: [] };
  const verdicts = [];
  const ask = (name) => {
    result.total += 1;
    let verdict;
    try {
      verdict = refusal({ name, agent: { id: "test-bot" } });
    } catch (e) {
      result.errors.push(`${name}: ${e.message}`);
      verdicts.push(`${name}:error`);
      return;
    }
    const isAllow = verdict === undefined;
    if (isAllow) result.allow += 1;
    else result.deny += 1;
    if (allowed.has(name) && !isAllow) result.unexpectedDeny.push(name);
    if (!allowed.has(name) && isAllow) result.unexpectedAllow.push(name);
    verdicts.push(`${name}:${isAllow ? "allow" : "deny"}`);
  };
  for (const name of TOOLS_102) ask(name);
  for (const name of BRAIN_ALLOW) ask(name);
  result.verdicts = verdicts;
  return result;
}

/** 验证主入口。返回 {ok, checks:[{id,name,ok,detail}], fatal?} */
export function verify(opts) {
  const o = {
    target: opts.target ?? TARGET_PATH,
    heartbeat: opts.heartbeat ?? HEARTBEAT_PATH,
    startTime: opts.startTime ?? null,
    writeHeartbeat: !!opts.writeHeartbeat,
  };
  const checks = [];
  const add = (id, name, ok, detail) => checks.push({ id, name, ok: !!ok, detail });
  if (!existsSync(o.target)) {
    return { ok: false, checks, fatal: `目标文件不存在：${o.target}` };
  }
  const source = readFileSync(o.target, "utf8");

  // ① 标记：四对全部要齐（guard/tail 共用 no-hands 标记各一对；
  // delegation-refusal 一对；fs-import 一对——丢了它名单定制和审计日志会静默失效）
  const markerDetail = [];
  let marksOk = true;
  for (const m of MARKERS) {
    const b = source.split(m.begin).length - 1;
    const e = source.split(m.end).length - 1;
    const want = m.count ?? (m.name === "delegation-refusal" || m.name === "fs-import" ? 1 : 2);
    const ok = b === want && e === want;
    if (!ok) marksOk = false;
    markerDetail.push(`${m.name}:begin=${b},end=${e}(want ${want})`);
  }
  add(1, "标记在（含 fs-import）", marksOk, markerDetail.join(" "));

  // ② node --check：写到临时 .mjs 再查（ESM；绝不动目标目录）
  let syntaxOk = false;
  let syntaxDetail = "";
  try {
    const tmp = join(mkdtempSync(join(tmpdir(), "dot-check-")), "tools.mjs");
    writeFileSync(tmp, source);
    const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8", timeout: 15000 });
    syntaxOk = r.status === 0;
    syntaxDetail = r.status === 0 ? "node --check 通过" : (r.stderr || r.stdout || "").slice(0, 500);
  } catch (e) {
    syntaxDetail = e.message;
  }
  add(2, "node --check", syntaxOk, syntaxDetail);

  // ③ 名单断言
  let listOk = false;
  let listDetail = "";
  try {
    const r = runToollistAssertion(source);
    listOk =
      r.total === 106 &&
      r.allow === 10 &&
      r.deny === 96 &&
      r.unexpectedAllow.length === 0 &&
      r.unexpectedDeny.length === 0 &&
      r.errors.length === 0;
    listDetail = `total=${r.total} allow=${r.allow} deny=${r.deny} ` +
      `unexpectedAllow=${r.unexpectedAllow.join(",") || "-"} unexpectedDeny=${r.unexpectedDeny.join(",") || "-"} errors=${r.errors.join(";") || "-"}`;
  } catch (e) {
    listDetail = e.message;
  }
  add(3, "102 名单 6 放行 96 拒（+4 桥工具）", listOk, listDetail);

  // ④ 心跳文件是新的：心跳 JSON 的时间戳 ≥ 补丁文件写盘时间
  let patchedAt = 0;
  // mtimeMs 是浮点；截断成整数毫秒，后面所有比较都留在整数域
  try { patchedAt = Math.trunc(statSync(o.target).mtimeMs); } catch { /* 上面已报 */ }
  let hbStat = null;
  let hbData = null;
  let hbSource = o.heartbeat;
  // 证据有两个可能的落点：专门的 heartbeat 文件（安装时写），或口闸拒绝日志
  // dot-guard.jsonl（补丁每次拒绝都会追加一行）。补丁只写后者时，取最后一行的 ts。
  // 只有用默认心跳路径时才去认日志——测试传了 --heartbeat 就必须只认那一个，
  // 否则会读到本机真实日志，测试不再隔离。
  const hbCandidates = [o.heartbeat];
  if (o.heartbeat === HEARTBEAT_PATH) hbCandidates.push("C:/Users/1/.dsh/bot/dot-guard.jsonl");
  for (const p of hbCandidates) {
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (p.endsWith(".jsonl")) {
        const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
        if (lines.length === 0) continue;
        hbData = JSON.parse(lines[lines.length - 1]);
      } else {
        try { hbData = JSON.parse(readFileSync(p, "utf8")); } catch { hbData = null; }
      }
      hbStat = st;
      hbSource = p;
      break;
    } catch { /* 换下一个候选 */ }
  }
  const { t: hbTime, src: hbTimeSrc } = heartbeatTime(hbData, hbStat);
  const fresh = !!hbStat && !!hbData && Number.isFinite(hbTime) && hbTime >= patchedAt;
  add(4, "口闸心跳文件是新的", fresh,
    hbStat
      ? `${hbSource} mtime=${new Date(hbStat.mtimeMs).toISOString()} patchedAt=${new Date(patchedAt).toISOString()} ` +
        `hb=${Number.isFinite(hbTime) ? new Date(hbTime).toISOString() : "-"}(${hbTimeSrc}) json=${hbData ? "ok" : "bad"}`
      : `${o.heartbeat} 不存在，拒闸日志也没有`);

  // ⑤ 补丁新于 ds-bot 主进程启动（方案 B.1 :758、验收 5 :395、B.7 :823）
  // 核心判据：startAt >= patchedAt ⇒ 进程在补丁写盘前就起来了，tools.js 是
  // ESM，旧代码还驻留内存，机器人照样有手。此时无论心跳怎么写都必须报红，
  // 且文案必须是「已打补丁未生效，请重启 ds-bot」。
  // 附加判据：心跳也要新于进程启动（重启后由安装者写新心跳）。
  const RESTART_HINT = "已打补丁未生效，请重启 ds-bot";
  let startAt = parseTime(o.startTime);
  if (startAt === null) startAt = dsBotProcessStart();
  let freshAfterStart = false;
  let fifthDetail = "";
  if (startAt === null) {
    fifthDetail = `查不到 ds-bot 主进程启动时间（进程没开或权限不足）；不报绿。${RESTART_HINT}`;
  } else {
    // 进程在补丁写盘之后启动（startAt >= patchedAt）才是生效状态；
    // 进程早于补丁启动 ⇒ ESM 旧代码驻留，机器人照样有手。
    const patchLoaded = startAt >= patchedAt;
    const hbNewer = Number.isFinite(hbTime) && hbTime > startAt;
    // 判据组合：进程在补丁之后起（ESM 已重新加载），且心跳新于进程启动。
    // 不能拿「心跳文件存在且有时间戳」顶替——那只证明装过补丁，不证明本次
    // 进程加载了它。心跳早于进程启动=补丁写了但没重启，机器人照样有手，
    // 必须报红（方案 B.1 :758、验收 5）。
    freshAfterStart = patchLoaded && hbNewer;
    fifthDetail = `processStart=${new Date(startAt).toISOString()} patchedAt=${new Date(patchedAt).toISOString()} heartbeat=${Number.isFinite(hbTime) ? new Date(hbTime).toISOString() : "-"} patchLoaded=${patchLoaded} hbNewer=${hbNewer}`;
    if (!freshAfterStart) fifthDetail += `；${RESTART_HINT}`;
  }
  add(5, "补丁新于 ds-bot 主进程启动", freshAfterStart, fifthDetail);

  if (o.writeHeartbeat) {
    const now = Date.now();
    writeFileSync(o.heartbeat, JSON.stringify({
      patchedAt: now,
      ts: new Date(now).toISOString(),
      sha256: sha256(source),
    }, null, 2) + "\n");
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    hbTime,
    patchedAt,
    startAt,
    sourceSha256: sha256(source),
    fatal: null,
  };
}

export function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = verify(opts);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const c of r.checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.id}. ${c.name}：${c.detail}`);
    console.log(r.ok ? "PASS 五道全过" : `FAIL ${r.checks.filter((c) => !c.ok).map((c) => c.id).join(",")} 未过${r.fatal ? `；${r.fatal}` : ""}`);
  }
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("verify.mjs")) main();
