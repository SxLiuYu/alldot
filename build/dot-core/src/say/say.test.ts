/**
 * src/say/say.test.ts —— 说人话改写层的验收。
 *
 * 钉住六件事：
 * 1. 空文本 / 开关关 / 没注入模型 / 模型抛错 → 原样返回（字节不变）；
 * 2. 超长才截断，且保留最后一句（结论）；
 * 3. 数字改了 → 退回原文；
 * 4. 路径改了 → 退回原文；
 * 5. 模型编原文没有的数字/结论 → 退回原文；
 * 6. 正常改写确实采用。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSayPrompt,
  createSayRewriter,
  DEFAULT_MAX_CHARS,
  fidelityIssues,
  rewrite,
  truncateKeepConclusion,
} from "./index.ts";

/** 记录被调了几次的假模型。 */
function spyModel(reply: string | (() => string)): { complete: (prompt: string) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  const complete = async (prompt: string): Promise<string> => {
    calls.push(prompt);
    return typeof reply === "function" ? reply() : reply;
  };
  return { complete, calls };
}

test("空文本原样返回，且不调模型", async () => {
  const spy = spyModel("不该被用到");
  assert.equal(await rewrite("", { enabled: true, minRewriteChars: 0, complete: spy.complete }), "");
  assert.equal(await rewrite("   ", { enabled: true, minRewriteChars: 0, complete: spy.complete }), "   ");
  assert.equal(spy.calls.length, 0);
});

test("开关关着原样返回，且不调模型", async () => {
  const original = "【任务 task_01】排队中\n  下一轮 5s 后扫。";
  const spy = spyModel("改写后的内容");
  const out = await rewrite(original, { enabled: false, complete: spy.complete });
  assert.equal(out, original);
  assert.equal(spy.calls.length, 0);
});

test("没注入模型（例如没配 key）原样返回", async () => {
  const original = "状态：queued（等待派发）";
  assert.equal(await rewrite(original, { enabled: true }), original);
});

test("模型抛错原样返回", async () => {
  const original = "状态：failed（模型池没起来），先看一眼 key 和 3065 端口在不在听。";
  let calls = 0;
  const out = await rewrite(original, {
    enabled: true,
    minRewriteChars: 0,
    complete: async () => {
      calls += 1;
      throw new Error("模型池的 key 还是占位符");
    },
  });
  assert.equal(out, original);
  assert.equal(calls, 1);
});

test("超过 maxChars 截断并保留最后一句结论", async () => {
  const original =
    "这一步先清点下载目录，共 12 个文件。" +
    "接着按月份建好文件夹。" +
    "最后结论：12 个文件已经放到 C:/Users/1/Desktop/归档。";
  const faithful =
    "先清点了下载目录，一共 12 个文件。" +
    "然后按月份建好文件夹。" +
    "最后结论：12 个文件已经放到 C:/Users/1/Desktop/归档。";
  const out = await rewrite(original, {
    enabled: true,
    minRewriteChars: 0,
    complete: async () => faithful,
    maxChars: 60,
  });
  assert.ok(out.length <= 60, `截断后长度 ${out.length} 应不超过 60`);
  assert.ok(out.includes("12"), "数字不能被截掉");
  assert.ok(out.includes("C:/Users/1/Desktop/归档"), "路径不能被截掉");
  assert.ok(out.endsWith("最后结论：12 个文件已经放到 C:/Users/1/Desktop/归档。"), "最后一句（结论）必须保留");
});

test("数字被改：退回原文", async () => {
  const original = "清点完成，共 12 个文件，已按月份分好，昨天的也一起放进去了。";
  const spy = spyModel("清点完成，共 13 个文件，已按月份分好，昨天的也一起放进去了。");
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete });
  assert.equal(out, original);
  assert.equal(spy.calls.length, 1);
});

test("路径被改：退回原文", async () => {
  const original = "截图已放到 C:/Users/1/Desktop/截图，按月份分了文件夹。";
  const spy = spyModel("截图已放到 C:/Users/1/Desktop/图片，按月份分了文件夹。");
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete });
  assert.equal(out, original);
});

test("编造的事实（原文没有的数字）被防线拦下：退回原文", async () => {
  const original = "任务还在排队，等派发，队列里前面还有两个任务，稍等。";
  const spy = spyModel("任务还在排队，已经帮你删除了 3 个多余文件，马上就好。");
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete });
  assert.equal(out, original);
  assert.equal(spy.calls.length, 1, "这条要真的走到防线，不能被「太短不送模型」挡掉");
});

test("编造的事实（原文没有的结论）被防线拦下：退回原文", async () => {
  const original = "任务还在排队，等派发，队列里前面还有两个任务，稍等。";
  const spy = spyModel("任务还在排队，不过已经删除完毕，桌面也整理好了。");
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete });
  assert.equal(out, original);
});

test("短卡不送模型：本来就人话，重写只会添戏（2026-11-25 真机编造的就是这种）", async () => {
  const original = "任务还在排队，等派发。";
  const spy = spyModel("已经帮你把桌面截图全部整理好放到月份文件夹了，稍等。");
  const out = await rewrite(original, { enabled: true, complete: spy.complete });
  assert.equal(out, original);
  assert.equal(spy.calls.length, 0, "短到没必要改写时，模型一次都不该被调");
});

test("正常改写：不碰数字与路径，确实采用模型的改写", async () => {
  const original = "把桌面上的截图按月份归档，一共 12 张，一张都没漏掉。";
  const rewritten = "桌面上那些截图按月份分好类了，一共 12 张，一张都没漏掉。";
  const spy = spyModel(rewritten);
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete });
  assert.equal(out, rewritten);
  assert.equal(spy.calls.length, 1);
  assert.ok(spy.calls[0]?.includes(original), "提示词里必须带原文");
});

test("提示词写清四条规矩（不编、不加事实、不改数字与路径、含 apv_ 批单号）", () => {
  const prompt = buildSayPrompt("原文");
  assert.match(prompt, /不编、不加事实/);
  assert.match(prompt, /数字、路径/);
  assert.match(prompt, /原样保留/);
  assert.ok(prompt.includes("apv_"), "批单号真实前缀是 apv_，提示词必须点名");
  assert.ok(!prompt.includes("apr_"), "apr_ 是不存在的旧前缀，别再写回去");
});

test("apv_ 批单号被改：退回原文（踩过的坑，防回归）", async () => {
  const original = "[dot 审批] 批单 apv_9f2c1（第 4 档）：要动桌面文件\n问题：同意吗\n选项：1) 同意  2) 拒绝";
  const spy = spyModel(original.replace("apv_9f2c1", "apv_1f2c9"));
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete });
  assert.equal(out, original);
  assert.ok(fidelityIssues(original, original.replace("apv_9f2c1", "apv_1f2c9")).length > 0);
});

test("裸文件名被改：退回原文", () => {
  assert.ok(fidelityIssues("文件是 notes.md。", "文件是 memo.md。").length > 0);
  assert.ok(fidelityIssues("截图在 说明.txt 里。", "截图在 其它.txt 里。").length > 0);
  assert.deepEqual(fidelityIssues("文件是 notes.md。", "文件就是 notes.md。"), []);
});

test("中文相对路径被改：退回原文", async () => {
  const original = "脚本在 练习/说明.txt 里，按顺序跑。";
  const spy = spyModel("脚本在 练习/其它.txt 里，按顺序跑。");
  assert.equal(await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete }), original);
});

test("带空格的路径被改：退回原文", async () => {
  const original = "文件在 C:\\Users\\1\\My Documents\\a.txt，先别动。";
  const spy = spyModel("文件在 C:\\Users\\1\\My Documents\\b.txt，先别动。");
  assert.equal(await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete }), original);
});

test("截断会把路径切掉时：宁可退回原文，也不给少了路径的卡", async () => {
  const original =
    "第一句说明。" + "第二句说明。" + "文件在 notes.md 这里。" + "第四句说明。" + "最后结论：都处理完了。";
  const spy = spyModel(original);
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete, maxChars: 30 });
  assert.equal(out, original, "路径在会被截掉的句子里，必须退回原文");
  assert.ok(original.length > 30);
});

test("模型原样返回超长文本：仍然按 maxChars 截断", async () => {
  const original = "这是一段说明文字。".repeat(20);
  const spy = spyModel(original);
  const out = await rewrite(original, { enabled: true, minRewriteChars: 0, complete: spy.complete, maxChars: 40 });
  assert.ok(out.length <= 40, `输出 ${out.length} 应不超过 40`);
  assert.notEqual(out, original);
  assert.ok(out.endsWith("这是一段说明文字。"), "最后一句（结论）保留");
});

test("模型回非字符串（undefined/null/对象）：原样返回，不抛异常", async () => {
  const original = "状态：queued（等待派发）";
  for (const bad of [undefined, null, { text: "看起来像正文" }]) {
    const out = await rewrite(original, {
      enabled: true,
      complete: async () => bad as unknown as string,
    });
    assert.equal(out, original);
  }
});

test("fidelityIssues：原样与忠实改写都通过", () => {
  const original = "任务 task_42 在 C:/Users/1/Desktop 下建了 3 个文件夹。";
  assert.deepEqual(fidelityIssues(original, original), []);
  assert.deepEqual(fidelityIssues(original, "任务 task_42 已经在 C:/Users/1/Desktop 下建好 3 个文件夹。"), []);
  assert.ok(fidelityIssues(original, "任务 task_42 在 C:/Users/1/Desktop 下建了 4 个文件夹。").length > 0);
  assert.ok(fidelityIssues(original, "任务 task_42 在 C:/Users/1/Desktop 下建了 3 个文件夹，已经删除旧文件。").length > 0);
});

test("truncateKeepConclusion：短文本不动，超长保留结论，结论本身超长就硬切", () => {
  assert.equal(truncateKeepConclusion("短。", 100), "短。");
  const out = truncateKeepConclusion("第一句。第二句。结论句。", 10);
  assert.ok(out.length <= 10);
  assert.ok(out.endsWith("结论句。"));
  const hard = truncateKeepConclusion("一个非常非常长的单句没有任何句号", 5);
  assert.equal(hard, "一个非常非");
  assert.equal(DEFAULT_MAX_CHARS > 0, true);
});

test("createSayRewriter：开关关着时原样返回", async () => {
  const say = createSayRewriter({ enabled: false, complete: async () => "改了" });
  assert.equal(await say("原始文本 12"), "原始文本 12");
});
