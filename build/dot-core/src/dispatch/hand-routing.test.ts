/**
 * src/dispatch/hand-routing.test.ts —— 工人拿到的提示词里，每只手管什么写清了吗。
 *
 * 为什么钉这条（2026-11-25 真机暴露）：提示词里只写了 files / practice / desktop，
 * 一个字没提 logged_browser 和 clean_browser。结果是「用浏览器打开 example.com 截图」这种任务，
 * 工人拿 practice 手在练习文件夹里列几个文件就宣布做完了（tier 1、一步成功）。
 *
 * 直接调 systemPrompt()（不绕运行时），把这件事钉成断言：
 * 两只浏览器手都要提到；要明确禁止拿练习手糊弄。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { systemPrompt } from "./local-worker.ts";
import { migrate, type TaskRow } from "../ledger/index.ts";
import { makeTempDb } from "../ledger/test-helpers.ts";

const TOOLS = ["practice", "clean_browser", "logged_browser", "desktop", "files"];

function promptFor(intent: string): string {
  const t = makeTempDb();
  try {
    migrate(t.db);
    const task = {
      id: "task_hand_routing",
      intent,
      declared_json: null,
      state: "running",
      profile: "balanced",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as TaskRow;
    return systemPrompt(t.db, task, TOOLS);
  } finally {
    t.cleanup();
  }
}

test("工人的提示词写清了每只手管什么（含两只浏览器手）", () => {
  const sys = promptFor("用浏览器打开 example.com 截图");
  assert.match(sys, /clean_browser/, "要提到干净浏览器");
  assert.match(sys, /logged_browser/, "要提到已登录浏览器");
  assert.match(sys, /desktop/, "要提到电脑手");
  assert.match(sys, /不许用 practice 假装做完/, "要明确禁止拿练习手糊弄");
  assert.match(sys, /打开网页/, "要说清网页类任务用浏览器手");
});
