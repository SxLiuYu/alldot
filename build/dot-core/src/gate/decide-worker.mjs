// gate 测试夹具：在独立线程里用另一个连接决同一张单，模拟两个人同时点同意/拒绝。
// 被 run-tests 的测试发现规则忽略（文件名不是 *.test.ts）。

import { parentPort, workerData } from "node:worker_threads";
import { openLedger } from "../ledger/index.ts";
import { decideApproval } from "./index.ts";

try {
  const db = openLedger(workerData.path, { busyTimeoutMs: 5000 });
  try {
    const ok = decideApproval(db, workerData.id, {
      decision: workerData.decision,
      decidedBy: "dsbot",
    });
    parentPort.postMessage({ ok });
  } finally {
    db.close();
  }
} catch (err) {
  parentPort.postMessage({ error: String(err) });
}
