#!/usr/bin/env node
/**
 * 口闸补丁按哈希三分支修复（dot-合并方案-v2-定稿.md 附录 B.1）
 *
 * 等于 patched → 无事；等于 pristine → 按标记锚文本重插 → 再 verify；
 * 都不是 → 停，报「需人工重做」（版本变了，不猜）。
 *
 * 硬约束：
 *  - 默认 dry-run，只报会做什么，不写任何文件。
 *  - 真写正式安装目录必须同时给 --apply 与 --i-know-ds-bot-must-be-stopped，
 *    并且版本校验通过（package.json 0.3.9）。脚本本身不启动、不停止任何进程。
 *  - 安装前先备份到 backup/ 下（build/ 目录内，不碰 .dsh）。
 *
 * 用法：
 *   node build/patches/ds-bot/repair.mjs [--target f] [--apply] \
 *        [--i-know-ds-bot-must-be-stopped] [--heartbeat f] [--start-time ISO|ms]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TARGET_PATH,
  PACKAGE_PATH,
  VERSION,
  sha256,
  applyPatches,
} from "./lib/patch-def.mjs";
import { verify } from "./verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "manifest.json");
const BACKUP_DIR = join(HERE, "backup");

export function parseArgs(argv) {
  const o = {
    target: TARGET_PATH,
    package: PACKAGE_PATH,
    apply: false,
    ack: false,
    heartbeat: null,
    startTime: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--target") o.target = argv[++i];
    else if (a === "--package") o.package = argv[++i];
    else if (a === "--apply") o.apply = true;
    else if (a === "--i-know-ds-bot-must-be-stopped") o.ack = true;
    else if (a === "--heartbeat") o.heartbeat = argv[++i];
    else if (a === "--start-time") o.startTime = argv[++i];
    else if (a === "--help") {
      console.log("用法: node build/patches/ds-bot/repair.mjs [--target f] [--apply] [--i-know-ds-bot-must-be-stopped] [--heartbeat f] [--start-time ISO|ms]");
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return o;
}

/** 核心三分支。返回 {branch, hash, changed, detail, verify?} */
export function repair(opts, manifest) {
  const file = manifest.files.find((f) => f.path === "src/host/tools.js");
  if (!file) throw new Error("manifest 缺 src/host/tools.js 条目");
  if (!existsSync(opts.target)) return { branch: "missing", detail: `目标文件不存在：${opts.target}` };

  const source = readFileSync(opts.target, "utf8");
  const hash = sha256(source);

  if (hash === file.patched) {
    return { branch: "patched", hash, changed: false, detail: "哈希等于 patched，无事可做", verify: runVerify(opts) };
  }
  if (hash === file.pristine) {
    const patched = applyPatches(source);
    if (sha256(patched) !== file.patched) {
      return { branch: "pristine", hash, changed: false, detail: "重插结果与 manifest patched 哈希不符，拒绝写入" };
    }
    if (opts.apply) {
      if (!opts.ack) {
        return { branch: "pristine", hash, changed: false, detail: "写正式安装目录必须先停 ds-bot 并显式确认（--i-know-ds-bot-must-be-stopped）" };
      }
      backup(opts.target, hash);
      writeFileSync(opts.target, patched);
    }
    return {
      branch: "pristine",
      hash,
      changed: !!opts.apply,
      detail: opts.apply ? "按标记锚文本重插成功，已写入；需重启 ds-bot 后 verify ⑤ 才过" : "dry-run：确认会重插三处补丁，未写文件",
      verify: opts.apply ? runVerify(opts) : undefined,
    };
  }
  return { branch: "unknown", hash, changed: false, detail: "哈希既不是 pristine 也不是 patched：版本变了，需人工重做" };
}

function backup(target, hash) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `${basename(target)}.${hash.slice(0, 12)}.${Date.now()}`;
  writeFileSync(join(BACKUP_DIR, name), readFileSync(target));
  return join(BACKUP_DIR, name);
}

function runVerify(opts) {
  // 没给 --heartbeat/--start-time 时传 null，verify() 会回退到正式路径/
  // 进程表查询（只读），不会写任何文件。
  return verify({
    target: opts.target,
    heartbeat: opts.heartbeat ?? null,
    startTime: opts.startTime ?? null,
    writeHeartbeat: false,
    json: false,
  });
}

export function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const r = repair(opts, manifest);
  console.log(`branch=${r.branch} hash=${r.hash ?? "-"}`);
  console.log(r.detail);
  if (r.verify) {
    for (const c of r.verify.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.id}. ${c.name}：${c.detail}`);
    console.log(`  verify=${r.verify.ok ? "PASS" : "FAIL"}`);
  }
  if (r.branch === "unknown" || r.branch === "missing") process.exit(1);
  if (r.verify && !r.verify.ok) process.exit(1);
  process.exit(0);
}

if (process.argv[1]?.endsWith("repair.mjs")) main();
