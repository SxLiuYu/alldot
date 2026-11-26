/**
 * src/dispatch/prompt-routing.test.ts —— 派发器追加给工人的那段说明，不能跟路由表打架。
 *
 * 真机事故（2026-11-25）：「用干净浏览器打开 example.com 截图」这单，工人三次调用都没动工具，
 * 直接回「没有成功」。查下来，systemPrompt 里的路由表是对的，但派发器在它后面又追加了一段，
 * 第 1 条写死「动手只能用 practice 手」——模型听后面那段，于是什么都不肯调。
 * 这条测试钉住：追加段必须列出手的用法，并且不能再出现「只能用 practice」这种死话。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerPrompt } from "./prompt.ts";
import type { TaskRow } from "../ledger/index.ts";

const task = {
  id: "task_prompt_routing",
  intent: "用干净浏览器打开 https://example.com 截图",
  declared_json: null,
  restated: null,
  state: "running",
} as unknown as TaskRow;

test("派发器追加给工人的说明：不再写死只能用 practice", () => {
  const { extraSystemPrompt } = buildWorkerPrompt(task);
  assert.doesNotMatch(extraSystemPrompt, /只能用 practice/, "不许再写「只能用 practice 手」");
  assert.match(extraSystemPrompt, /clean_browser/, "要提到免登录浏览器");
  assert.match(extraSystemPrompt, /logged_browser/, "要提到已登录浏览器");
  assert.match(extraSystemPrompt, /desktop/, "要提到电脑手");
  assert.match(extraSystemPrompt, /files/, "要提到文件手");
  assert.match(extraSystemPrompt, /不许用 practice 假装做完/, "要明确禁止糊弄");
});

test("批准后重排：提示词点名「这几步已经批了，原样再调一次」", () => {
  const { message } = buildWorkerPrompt(task, ["飞书日历需要批准：create（批单 apv_1）"]);
  assert.match(message, /已经有人批过了/);
  assert.match(message, /原样再调一次/);
  assert.match(message, /apv_1/);
  // 没批准单时不能凭空冒出这段
  assert.doesNotMatch(buildWorkerPrompt(task).message, /已经有人批过了/);
});
