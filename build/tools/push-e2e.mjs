// 推送通道端到端自检：往账本插一条「要你批」，等桥的轮询把它推到手机，再撤回。
//
// 用法（在仓库根跑，桥要开着）：
//   node build/tools/push-e2e.mjs
// 退出码 0 = 推送记录里出现了这条；1 = 15 秒内没推（去看桥日志里的「推送失败」原因）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../dot-core/src/ledger/db.ts";
import { createApproval, revokeApproval } from "../dot-core/src/ledger/records.ts";

const DOT_DIR = join(homedir(), ".allbot", "dot");
const LEDGER = join(DOT_DIR, "ledger", "dot.db");
const SEEN = join(DOT_DIR, "state", "push-seen.jsonl");

const db = openLedger(LEDGER);
const subject = `push-e2e-${Date.now()}`;
const { approval } = createApproval(db, {
  tier: 3,
  title: "推送通道自检：收到这条说明推送通了（这条会自动撤回）",
  detail: { note: "由 build/tools/push-e2e.mjs 插入，验证完立刻撤回" },
  subject_key: subject,
  ttlMs: 6 * 60_000,
});
console.log("建了审批", approval.id, "等 35 秒看推送…");

await new Promise((r) => setTimeout(r, 35_000));

const seen = existsSync(SEEN) ? readFileSync(SEEN, "utf8") : "";
const hit = seen.split(/\r?\n/).some((l) => l.includes(`approval:${approval.id}`));
console.log(hit ? "PUSHED 推送记录里有它" : "MISS 推送记录里没有它");

revokeApproval(db, approval.id, "自检完成，撤回");
db.close();
console.log("已撤回", approval.id);
process.exit(hit ? 0 : 1);
