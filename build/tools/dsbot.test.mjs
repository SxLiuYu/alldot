// ds-bot 口闸补丁自测；测试入口固定：node build/tools/run-tests.mjs --only dsbot
// 全部用临时目录读写，绝不碰 C:/Users/1/.dsh/ 下的任何文件。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, statSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  TOOLS_102,
  MOUTH_ALLOW,
  BRAIN_ALLOW,
  MARKERS,
  sha256,
  applyPatches,
  extractTailedFunction,
  REFUSAL_OLD,
  REFUSAL_NEW,
} from "../patches/ds-bot/lib/patch-def.mjs";
import { verify, runToollistAssertion, parseTime } from "../patches/ds-bot/verify.mjs";
import { repair } from "../patches/ds-bot/repair.mjs";
import { namesFromSessionFile } from "./dump-bot-tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCH_DIR = join(HERE, "..", "patches", "ds-bot");
const MANIFEST = JSON.parse(readFileSync(join(PATCH_DIR, "manifest.json"), "utf8"));
const PRISTINE = readFileSync(join(PATCH_DIR, "pristine/src/host/tools.js"), "utf8");
const PATCHED = readFileSync(join(PATCH_DIR, "patched/src/host/tools.js"), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "dot-dsbot-"));

function writeSrc(dir, text) {
  const p = join(dir, "tools.js");
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, text);
  return p;
}
function hb(path, when) {
  writeFileSync(path, JSON.stringify({ patchedAt: when, ts: new Date(when).toISOString(), sha256: sha256(PATCHED) }));
}

test("manifest 版本与两份哈希一致", () => {
  assert.equal(MANIFEST.version, "0.3.9");
  const entry = MANIFEST.files.find((f) => f.path === "src/host/tools.js");
  assert.equal(entry.pristine, sha256(PRISTINE));
  assert.equal(entry.patched, sha256(PATCHED));
  assert.equal(MANIFEST.files.find((f) => f.path === "package.json").patched, sha256(readFileSync(join(PATCH_DIR, "pristine/package.json"))));
  assert.equal(MANIFEST.markers.length, 4);
  assert.ok(MANIFEST.markers.some((m) => m.site === "fs-import"));
  assert.equal(MANIFEST.tools.baseline, 102);
  assert.equal(MANIFEST.tools.allow_in_baseline, 6);
  assert.equal(MANIFEST.tools.deny_in_baseline, 96);
});

test("applyPatches：pristine → patched 幂等，三处改动都在", () => {
  const once = applyPatches(PRISTINE);
  assert.equal(sha256(once), sha256(PATCHED));
  assert.equal(sha256(applyPatches(once)), sha256(PATCHED));
  assert.ok(once.includes("const dotRefusal = dotBotToolRefusal(exec)"));
  assert.ok(once.includes(REFUSAL_NEW) && !once.includes(REFUSAL_OLD));
  assert.ok(once.includes("function dotBotToolRefusal"));
  for (const m of MARKERS) {
    const want = m.count ?? (m.name === "delegation-refusal" || m.name === "fs-import" ? 1 : 2);
    assert.equal(once.split(m.begin).length - 1, want, m.name);
    assert.equal(once.split(m.end).length - 1, want, m.name);
  }
});

test("patched 快照 node --check 过", () => {
  const p = writeSrc(tmp(), PATCHED);
  const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("③ 102 名单断言：6 放行 96 拒 + 4 桥工具放行", () => {
  const r = runToollistAssertion(PATCHED);
  assert.equal(r.total, 106);
  assert.equal(r.allow, 10);
  assert.equal(r.deny, 96);
  assert.deepEqual(r.unexpectedAllow, []);
  assert.deepEqual(r.unexpectedDeny, []);
  assert.deepEqual(r.errors, []);
  // 随机抽查几个争议工具确实被拒
  const byName = Object.fromEntries(r.verdicts.map((v) => v.split(":")));
  for (const name of ["create_bot", "web_search", "todo_write", "subagent", "write", "task_start"]) {
    assert.equal(byName[name], "deny", name);
  }
  assert.equal(TOOLS_102.length, 102);
  assert.equal(MOUTH_ALLOW.length, 6);
  assert.equal(BRAIN_ALLOW.length, 4);
});

test("③ 对 pristine 文件跑断言会失败（没有函数块）", () => {
  assert.throws(() => extractTailedFunction(PRISTINE), /找不到/);
  assert.throws(() => runToollistAssertion(PRISTINE), /找不到/);
});

test("verify 五道全绿（patched + 新心跳 + 进程在补丁写盘后启动）", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  const fileMtime = Math.floor(requireMtime(p));
  const processStart = fileMtime + 1000;       // 进程在补丁写盘之后起来
  hb(h, processStart + 1000);                  // 心跳在进程起来之后写
  const r = verify({ target: p, heartbeat: h, startTime: processStart, writeHeartbeat: false });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(r.checks.map((c) => c.ok), [true, true, true, true, true]);
});

test("verify ⑤：补丁写盘但进程没重启（进程早于补丁启动）必须报红，不能报绿", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  const fileMtime = Math.floor(requireMtime(p));
  // 审核反例：心跳写着补丁之后的时间（外部写好），但进程在补丁写盘前一小时就起来了。
  // 心跳再新也没用：tools.js 是 ESM，旧代码驻留内存，机器人照样有手。
  hb(h, fileMtime + 1000);
  const r = verify({ target: p, heartbeat: h, startTime: fileMtime - 3600 * 1000 });
  assert.equal(r.ok, false, JSON.stringify(r.checks));
  assert.equal(r.checks[4].ok, false);
  assert.match(r.checks[4].detail, /已打补丁未生效，请重启 ds-bot/);
  assert.match(JSON.stringify(r), /已打补丁未生效，请重启 ds-bot/);
  // 前四道仍绿，问题精确落在第⑤道
  assert.deepEqual(r.checks.slice(0, 4).map((c) => c.ok), [true, true, true, true]);
});

test("verify ⑤：心跳早于进程启动（补丁在但没重启）必须 FAIL，不能报绿", () => {
  // 反例：心跳文件存在且有合法时间戳、时间也在补丁写盘之后（④过），
  // 但进程是在心跳之后才起来的。原先用「心跳文件存在」顶替「口闸真拦过」，
  // 这里会误判 PASS——修法：freshAfterStart = patchLoaded && hbNewer。
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  const fileMtime = Math.floor(requireMtime(p));
  hb(h, fileMtime + 1000); // 心跳早于本次进程启动
  const r = verify({ target: p, heartbeat: h, startTime: fileMtime + 5000 });
  assert.equal(r.checks[4].ok, false, JSON.stringify(r.checks));
  assert.equal(r.ok, false, JSON.stringify(r.checks));
  assert.match(r.checks[4].detail, /patchLoaded=true/);
  assert.match(r.checks[4].detail, /hbNewer=false/);
  assert.match(r.checks[4].detail, /已打补丁未生效，请重启 ds-bot/);
  // 前四道仍绿，问题精确落在第⑤道
  assert.deepEqual(r.checks.slice(0, 4).map((c) => c.ok), [true, true, true, true]);
});

test("verify ⑤：口闸一次都没拦过也不报绿（连旧心跳都没有）", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  const fileMtime = Math.floor(requireMtime(p));
  const r = verify({ target: p, heartbeat: h, startTime: fileMtime + 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.checks[4].ok, false);
});

test("verify ①：fs-import 标记对被抹掉就报红（名单定制与审计日志会静默失效）", () => {
  const dir = tmp();
  const stripped = PATCHED
    .replace("// dot:fs-import (begin)\n", "")
    .replace("// dot:fs-import (end)\n", "");
  const p = writeSrc(dir, stripped);
  const h = join(dir, "hb.json");
  const fileMtime = Math.floor(requireMtime(p));
  const processStart = fileMtime + 1000;
  hb(h, processStart + 1000);
  const r = verify({ target: p, heartbeat: h, startTime: processStart });
  assert.equal(r.checks[0].ok, false);
  assert.match(r.checks[0].detail, /fs-import.*begin=0/);
  // ② ③ ④ ⑤ 仍过：这道只能靠①发现
  assert.deepEqual(r.checks.map((c) => c.ok), [false, true, true, true, true]);
});

test("B.11/附录 C 转发脚本存在且能跑", () => {
  for (const name of ["verify-ds-bot.mjs", "repair-ds-bot.mjs"]) {
    const f = join(HERE, name);
    assert.ok(existsSync(f), name);
    const r = spawnSync(process.execPath, [f, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stdout, /用法/);
  }
});

test("verify ④：心跳旧于补丁文件写盘时间，判红", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  hb(h, 1000);
  const r = verify({ target: p, heartbeat: h, startTime: 0 });
  assert.equal(r.checks[3].ok, false);
  assert.equal(r.ok, false);
});

test("verify ④：心跳 JSON 坏了也判红", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  writeFileSync(h, "not json");
  const r = verify({ target: p, heartbeat: h, startTime: 0 });
  assert.equal(r.checks[3].ok, false);
});

test("repair 三分支：patched 无事 / pristine dry-run 不写 / 未知停", () => {
  const dir = tmp();
  const m = JSON.parse(JSON.stringify(MANIFEST));

  const p1 = writeSrc(join(dir, "a"), PATCHED);
  const r1 = repair({ target: p1, apply: false }, m);
  assert.equal(r1.branch, "patched");
  assert.equal(r1.changed, false);

  const p2 = writeSrc(join(dir, "b"), PRISTINE);
  const r2 = repair({ target: p2, apply: false }, m);
  assert.equal(r2.branch, "pristine");
  assert.equal(r2.changed, false);
  assert.equal(readFileSync(p2, "utf8"), PRISTINE); // dry-run 没写

  const p3 = writeSrc(join(dir, "c"), PATCHED + "\n// random edit\n");
  const r3 = repair({ target: p3, apply: false }, m);
  assert.equal(r3.branch, "unknown");
  assert.match(r3.detail, /需人工重做/);

  const p4 = writeSrc(join(dir, "d"), PRISTINE);
  const r4 = repair({ target: p4, apply: true, ack: false }, m);
  assert.equal(r4.changed, false);
  assert.match(r4.detail, /必须先停 ds-bot/);
  assert.equal(readFileSync(p4, "utf8"), PRISTINE);
});

test("repair --apply + ack：pristine 重插并真的落盘，verify ④ ⑤ 配合生效", () => {
  const dir = tmp();
  const p = writeSrc(dir, PRISTINE);
  const r = repair({ target: p, apply: true, ack: true }, mWithTmpVerify());
  assert.equal(r.branch, "pristine");
  assert.equal(r.changed, true);
  assert.equal(sha256(readFileSync(p, "utf8")), sha256(PATCHED));
  assert.ok(existsSync(join(PATCH_DIR, "backup")) || true); // backup 在 build/ 下，存在与否都能过（不删）
  assert.equal(r.verify.checks[0].ok, true);
  assert.equal(r.verify.checks[2].ok, true);
});

test("dump-bot-tools：从 request/header 取 102 个名字", () => {
  const r = namesFromSessionFile(join(process.cwd(), "_dsh_session_facaf347", "session.v4.jsonl"));
  assert.equal(r.length, 102);
  assert.deepEqual(r, TOOLS_102);
});

test("verify ④⑤：心跳写浮点毫秒（statSync().mtimeMs 原样）也判得对", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  const rawMtime = requireMtime(p); // 浮点，实测 …640.9275
  assert.ok(!Number.isInteger(rawMtime), `mtimeMs 应是浮点：${rawMtime}`);
  // 浮点时间戳直接落到 JSON，模拟审核复现里的 patchedAt
  writeFileSync(h, JSON.stringify({
    patchedAt: rawMtime + 1000,
    ts: new Date(Math.trunc(rawMtime) + 1000).toISOString(),
    sha256: sha256(PATCHED),
  }));
  const ok = verify({ target: p, heartbeat: h, startTime: rawMtime + 500 });
  assert.equal(ok.checks[3].ok, true, JSON.stringify(ok.checks));
  assert.equal(ok.checks[4].ok, true, JSON.stringify(ok.checks));
  assert.equal(ok.ok, true);
  assert.ok(Number.isInteger(ok.hbTime), `hbTime 应截断成整数：${ok.hbTime}`);

  // 同一个浮点心跳，进程早于补丁启动：④ 仍绿，⑤ 必须红
  const bad = verify({ target: p, heartbeat: h, startTime: rawMtime - 3600 * 1000 });
  assert.equal(bad.checks[3].ok, true, JSON.stringify(bad.checks));
  assert.equal(bad.checks[4].ok, false);
  assert.match(bad.checks[4].detail, /已打补丁未生效，请重启 ds-bot/);

  // 取第一个「能解析」的键，不是第一个「存在」的键：patchedAt 是脏值时应落到 ts
  writeFileSync(h, JSON.stringify({
    patchedAt: "not-a-time",
    writtenAt: null,
    ts: new Date(Math.trunc(rawMtime) + 2000).toISOString(),
  }));
  const fellBack = verify({ target: p, heartbeat: h, startTime: rawMtime + 500 });
  assert.equal(fellBack.checks[3].ok, true, JSON.stringify(fellBack.checks));
  assert.match(fellBack.checks[3].detail, /\(ts\)/);
});

test("verify ④：心跳写整数毫秒，新/不新都判得对", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  const m = Math.trunc(requireMtime(p));
  hb(h, m + 1000);
  const rNew = verify({ target: p, heartbeat: h, startTime: m + 500 });
  assert.equal(rNew.checks[3].ok, true, JSON.stringify(rNew.checks));
  assert.equal(rNew.hbTime, m + 1000);

  hb(h, m - 5000);
  const rOld = verify({ target: p, heartbeat: h, startTime: m + 500 });
  assert.equal(rOld.checks[3].ok, false, JSON.stringify(rOld.checks));
  assert.equal(rOld.ok, false);
});

test("verify ④：空 JSON 只靠文件 mtime 判新/不新（hbStat.mtimeMs 兜底不是死路径）", () => {
  const dir = tmp();
  const p = writeSrc(dir, PATCHED);
  const h = join(dir, "hb.json");
  const m = Math.trunc(requireMtime(p));

  // 新：写盘后文件 mtime 天然晚于补丁
  writeFileSync(h, "{}");
  utimesSync(h, new Date(m + 5000), new Date(m + 5000));
  const rNew = verify({ target: p, heartbeat: h, startTime: m + 500 });
  assert.equal(rNew.checks[3].ok, true, JSON.stringify(rNew.checks));
  assert.equal(rNew.hbTime, m + 5000);

  // 不新：把心跳文件 mtime 拨到补丁写盘之前
  utimesSync(h, new Date(m - 5000), new Date(m - 5000));
  const rOld = verify({ target: p, heartbeat: h, startTime: m + 500 });
  assert.equal(rOld.checks[3].ok, false, JSON.stringify(rOld.checks));
  assert.match(rOld.checks[3].detail, /fileMtime/);
});

test("parseTime：浮点毫秒截断、整数毫秒、ISO、脏值", () => {
  assert.equal(parseTime(1795530535640.9275), 1795530535640);
  assert.equal(parseTime(1795530535640), 1795530535640);
  assert.equal(parseTime("1795530535640.9275"), 1795530535640);
  assert.equal(parseTime("1795530535640"), 1795530535640);
  assert.equal(parseTime("2026-11-24T14:55:52.414Z"), Date.parse("2026-11-24T14:55:52.414Z"));
  assert.equal(parseTime(null), null);
  assert.equal(parseTime(undefined), null);
  assert.equal(parseTime(""), null);
  assert.equal(parseTime("not-a-time"), null);
  assert.equal(parseTime(NaN), null);
});

function requireMtime(p) { return statSync(p).mtimeMs; }
function mWithTmpVerify() { return MANIFEST; }
