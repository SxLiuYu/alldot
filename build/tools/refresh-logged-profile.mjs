#!/usr/bin/env node
/**
 * refresh-logged-profile.mjs —— 把本机 Chrome 里「已经登录好的那些网站」搬进 dot 自己的浏览器 profile。
 *
 * 为什么需要这一步（2026-11-25 实测）：
 *   Playwright MCP 的 `--user-data-dir` 能给一个持久 profile，但**关掉浏览器再开，cookie 不落盘**
 *   （实测：写入 cookie → browser_close → 再开 → cookie 没了，profile 里 Cookies 库 0 行）。
 *   所以「登录一次就一直登着」靠 setTimeout 式的持久化走不通。
 *   能走通的只有一条：把用户 Chrome 里现成的 Cookies / Local Storage 复制过来，
 *   浏览器从磁盘加载，登录态一启动就在。
 *
 * 用法：
 *   node build/tools/refresh-logged-profile.mjs            # 复制必选项
 *   node build/tools/refresh-logged-profile.mjs --full      # 连 IndexedDB / Service Worker 一起搬（大）
 *   node build/tools/refresh-logged-profile.mjs --dry-run   # 只报告要复制什么、多大
 *
 * 退出码：0 成功 / 1 前置不满足（Chrome 在跑、目标 profile 被占）/ 2 参数错
 *
 * 安全：只读用户 Chrome 目录，只写 `~/.allbot/dot/browser/logged`。
 * 不会删用户任何文件，不会改 Chrome 自己的 profile。
 */
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  statSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const DOT_PROFILE = join(homedir(), ".allbot", "dot", "browser", "logged");
const DEFAULT_CHROME = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");

/** 必选项：登录态真正存在这些里面。其余（Cache、GPUCache…）不搬，省时间也省磁盘。 */
const CORE_ROOT_FILES = ["Local State"];
const CORE_DEFAULT_FILES = ["Preferences", "Secure Preferences", "Network/Cookies", "Login Data", "Web Data"];
const CORE_DEFAULT_DIRS = ["Local Storage"];
/** --full 追加：有些站点（飞书、部分后台）的会话在 IndexedDB 里。 */
const FULL_DEFAULT_DIRS = ["IndexedDB", "Service Worker", "Session Storage"];

function parseArgs(argv) {
  const o = { chrome: DEFAULT_CHROME, dest: DOT_PROFILE, full: false, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--chrome") o.chrome = argv[++i];
    else if (a === "--dest") o.dest = argv[++i];
    else if (a === "--full") o.full = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--force") o.force = true;
    else if (a === "--help") {
      console.log("用法: node build/tools/refresh-logged-profile.mjs [--full] [--dry-run] [--force] [--chrome <dir>] [--dest <dir>]");
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return o;
}

/** Chrome 正在跑吗（它的 profile 会被锁，复制的 Cookies 可能写了一半）。 */
function chromeRunning() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: "utf8", timeout: 15000 });
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0;
}

/** 目标 profile 被我们自己起的 Chromium 占着吗。 */
function dotProfileLocked(dest) {
  return existsSync(join(dest, "SingletonLock")) || existsSync(join(dest, "lockfile"));
}

function walkSize(p) {
  try {
    const st = statSync(p);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const name of readdirSync(p)) total += walkSize(join(p, name));
    return total;
  } catch {
    return 0;
  }
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 复制之前先数一遍源 profile 里有多少 cookie，复制完再数目标，用数字说话。 */
function countCookies(profileRoot) {
  const src = join(profileRoot, "Default", "Network", "Cookies");
  if (!existsSync(src)) return null;
  try {
    // node:sqlite 不能直接打开被 Chrome 锁着的文件；源文件此时 Chrome 没在跑，但为了不占锁，
    // 拷到 os.tmpdir 再读。
    const copy = join(process.env.TEMP ?? ".", `dot-cookies-${process.pid}.db`);
    copyFileSync(src, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM cookies").get();
    db.close();
    rmSync(copy, { force: true });
    return row.n;
  } catch (e) {
    return `读不出（${e.message}）`;
  }
}

function main() {
  const o = parseArgs(process.argv.slice(2));

  const srcDefault = join(o.chrome, "Default");
  if (!existsSync(srcDefault)) {
    console.error(`找不到 Chrome 的 Default profile：${srcDefault}`);
    process.exit(1);
  }
  if (chromeRunning() && !o.force) {
    console.error("Chrome 正在运行：它的 profile 被锁着，复制出来的 Cookies 可能是写了一半的。");
    console.error("先把 Chrome 完全关掉（托盘里也要退），再跑一次。确实要硬来就加 --force。");
    process.exit(1);
  }
  if (dotProfileLocked(o.dest) && !o.force) {
    console.error(`目标 profile 被占着：${o.dest}`);
    console.error("先把用它的那个浏览器停掉（8931 那个 Playwright MCP 进程），再跑一次。");
    process.exit(1);
  }

  const rootFiles = CORE_ROOT_FILES.filter((f) => existsSync(join(o.chrome, f)));
  const defaultFiles = CORE_DEFAULT_FILES.filter((f) => existsSync(join(srcDefault, f)));
  const defaultDirs = [
    ...CORE_DEFAULT_DIRS.filter((d) => existsSync(join(srcDefault, d))),
    ...(o.full ? FULL_DEFAULT_DIRS.filter((d) => existsSync(join(srcDefault, d))) : []),
  ];

  const srcCookies = countCookies(o.chrome);
  const plan = [];
  for (const f of rootFiles) plan.push({ from: join(o.chrome, f), to: join(o.dest, f), kind: "file" });
  for (const f of defaultFiles) plan.push({ from: join(srcDefault, f), to: join(o.dest, "Default", f), kind: "file" });
  for (const d of defaultDirs) plan.push({ from: join(srcDefault, d), to: join(o.dest, "Default", d), kind: "dir" });

  console.log(`源：${o.chrome}`);
  console.log(`目标：${o.dest}`);
  console.log(`源 Chrome 里的 cookie 条数：${srcCookies === null ? "无 Cookies 文件" : srcCookies}`);
  console.log(`要复制 ${plan.length} 项：`);
  let totalBytes = 0;
  for (const p of plan) {
    const size = walkSize(p.from);
    totalBytes += size;
    console.log(`  ${p.kind === "dir" ? "[目录]" : "[文件]"} ${p.to.replace(o.dest, "")}  ${mb(size)}`);
  }
  console.log(`合计约 ${mb(totalBytes)}`);

  if (o.dryRun) {
    console.log("--dry-run：什么都没写。");
    return;
  }

  for (const p of plan) {
    mkdirSync(dirname(p.to), { recursive: true });
    if (p.kind === "file") {
      copyFileSync(p.from, p.to);
    } else {
      cpSync(p.from, p.to, { recursive: true, force: true });
    }
  }

  const destCookies = countCookies(o.dest);
  writeFileSync(
    join(o.dest, "dot-profile.json"),
    JSON.stringify(
      {
        copiedAt: new Date().toISOString(),
        source: o.chrome,
        sourceCookies: srcCookies,
        destCookies,
        full: o.full,
        items: plan.map((p) => p.to.replace(o.dest, "")),
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`复制完成。目标 profile 里 cookie 条数：${destCookies}`);
  console.log(`记录写在 ${join(o.dest, "dot-profile.json")}`);
  console.log("下一步：用这个 profile 起浏览器手（--user-data-dir " + o.dest + "），登录态应该在启动时就在。");
}

main();
