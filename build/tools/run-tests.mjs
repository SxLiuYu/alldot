#!/usr/bin/env node
// 固定测试入口。所有模块的测试都走这一条命令，别各自造轮子。
//
//   node build/tools/run-tests.mjs              跑全部测试
//   node build/tools/run-tests.mjs --only ledger 只跑路径里带 ledger 的测试
//   node build/tools/run-tests.mjs --tsc        只跑类型检查
//   node build/tools/run-tests.mjs --list       只列出会被跑的测试文件
//
// 退出码透传：0 全过 / 1 有失败 / 2 前置条件缺失。
// 实测依据（2026-11-24 本机 Node 24.13.0）：
//   - node 能直接跑 .ts（类型擦除默认开），但 `node --test <目录>` 不认目录：
//     目录参数被当成模块路径，报 MODULE_NOT_FOUND。加
//     --experimental-strip-types / --experimental-transform-types /
//     --experimental-test-module-mocks 都不改变这一点。
//   - `node --test` 无参数时才自动发现当前目录树下的 .test.ts；从项目根跑会把
//     allbot-src 的测试也扫进来（缺 vitest 等依赖，退出码 7），所以这里自己扫
//     指定目录再把文件逐个列出来。
//   - tsc 用 C:/allbot-public/node_modules/typescript/bin/tsc（Version 6.0.2）。
//   - 没有 "type":"module" 的目录里跑 ESM 会出 MODULE_TYPELESS_PACKAGE_JSON 警告；
//     测试/插件目录自带 package.json 写 {"type":"module"} 即可消除。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const GLOBAL_TSC = "C:/allbot-public/node_modules/typescript/bin/tsc";
const SCAN_DIRS = ["build/dot-core", "build/dot-bridge", "build/tools", "build/_canary"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out"]);

function parseArgv(argv) {
  const out = { only: "", tsc: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--only") {
      out.only = String(argv[i + 1] ?? "");
      i += 1;
    } else if (a.startsWith("--only=")) {
      out.only = a.slice("--only=".length);
    } else if (a === "--tsc") {
      out.tsc = true;
    } else if (a === "--list") {
      out.list = true;
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return out;
}

function walk(dir, acc) {
  if (!existsSync(dir)) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, acc);
    } else if (/\.(test|spec)\.(ts|mts|mjs|js)$/.test(e.name)) {
      acc.push(relative(ROOT, p));
    }
  }
  return acc;
}

function findTsconfigs() {
  const found = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "tsconfig.json")) found.push(join(dir, "tsconfig.json"));
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && e.name !== "test") visit(join(dir, e.name));
    }
  };
  for (const d of SCAN_DIRS) visit(d);
  return found;
}

function main() {
  const args = parseArgv(process.argv.slice(2));

  if (args.tsc) {
    const configs = findTsconfigs();
    if (configs.length === 0) {
      console.log("没有找到 tsconfig.json，跳过类型检查");
      process.exit(0);
    }
    if (!existsSync(GLOBAL_TSC)) {
      console.error(`找不到 tsc：${GLOBAL_TSC}`);
      process.exit(2);
    }
    let code = 0;
    for (const cfg of configs) {
      console.log(`\n[tsc] ${cfg}`);
      const r = spawnSync(process.execPath, [GLOBAL_TSC, "--noEmit", "-p", cfg], { stdio: "inherit", cwd: ROOT });
      if (r.status !== 0) code = r.status ?? 1;
    }
    process.exit(code);
  }

  const all = SCAN_DIRS.flatMap((d) => walk(d, [])).sort();
  const files = args.only ? all.filter((f) => f.split("/").includes(args.only) || f.includes(args.only)) : all;

  if (args.list) {
    console.log(files.join("\n") || "（没有测试文件）");
    process.exit(0);
  }

  if (files.length === 0) {
    console.log(args.only ? `没有匹配 --only ${args.only} 的测试文件` : "还没有测试文件");
    process.exit(0);
  }

  console.log(`跑 ${files.length} 个测试文件${args.only ? `（--only ${args.only}）` : ""}`);
  const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: ROOT });
  if (r.error) {
    console.error(`启动 node --test 失败：${r.error.message}`);
    process.exit(2);
  }
  process.exit(r.status ?? 1);
}

main();
