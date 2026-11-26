#!/usr/bin/env node
// build/tools/e2e-poll.mjs —— 端到端演练的观察端：只读账本 + 查文件系统，最多等 KEY 秒。
//   node build/tools/e2e-poll.mjs --task task_xxx --folder C:/Users/1/Documents/练习/e2e-2026-11-25 [--seconds 300]

import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined) throw new Error(`--${name} 缺值`);
  return v;
}

const taskId = arg("task", null);
const folder = arg("folder", null);
const seconds = Number(arg("seconds", "300"));
if (!taskId || !folder) throw new Error("--task 与 --folder 必填");

const DB = "C:/Users/1/.allbot/dot/ledger/dot.db";
const db = new DatabaseSync(DB, { readOnly: true });

function snapshot() {
  const task = db
    .prepare("select id,state,state_reason,updated_at,intent from tasks where id = ?")
    .get(taskId);
  const steps = db
    .prepare(
      "select seq,kind,tool,status,started_at,ended_at,error,subject_key from steps where task_id = ? order by seq",
    )
    .all(taskId);
  const exists = existsSync(folder);
  let isDir = false;
  if (exists) {
    try {
      isDir = statSync(folder).isDirectory();
    } catch {}
  }
  return { task, steps, exists, isDir };
}

const startedAt = Date.now();
let last = "";
let final = null;
while (true) {
  const snap = snapshot();
  const key = JSON.stringify([snap.task?.state ?? null, snap.steps.length, snap.exists, snap.isDir]);
  if (key !== last) {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        elapsed_s: Math.round((Date.now() - startedAt) / 1000),
        state: snap.task?.state ?? null,
        state_reason: snap.task?.state_reason ?? null,
        steps: snap.steps.length,
        folder_exists: snap.exists,
        is_dir: snap.isDir,
      }),
    );
    last = key;
  }
  final = snap;
  if (snap.task && ["done", "failed", "cancelled"].includes(snap.task.state)) break;
  if (Date.now() - startedAt >= seconds * 1000) break;
  await new Promise((r) => setTimeout(r, 5000));
}

console.log("== FINAL ==");
console.log(JSON.stringify(final, null, 2));
db.close();
