#!/usr/bin/env node
// 装载演练 第 4 步：最多 6 分钟轮询 /api/status，把每次结果记进 poll.log。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.tmpdir(), "dot-install-rehearsal");
const LOG = path.join(DIR, "poll.log");
const URL = "http://127.0.0.1:36721/api/status";
const deadline = Date.now() + 6 * 60 * 1000;

const write = (s) => fs.appendFileSync(LOG, s + "\n", "utf8");
fs.writeFileSync(LOG, "", "utf8");

let attempt = 0;
let ok = false;
while (Date.now() < deadline) {
  attempt += 1;
  const t0 = Date.now();
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    const ms = Date.now() - t0;
    write(`#${attempt} ${new Date().toISOString()} HTTP ${res.status} ${ms}ms`);
    if (res.ok) {
      fs.writeFileSync(path.join(DIR, "status.json"), text, "utf8");
      write("BODY " + text.slice(0, 2000));
      ok = true;
      break;
    }
  } catch (err) {
    write(`#${attempt} ${new Date().toISOString()} ERR ${(err && err.message) || err}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
write(ok ? "RESULT: status 200" : "RESULT: 6 分钟内没拿到 200");
process.exit(ok ? 0 : 1);
