#!/usr/bin/env node
// build/dot-core/test/captcha.mjs —— 滑块验证码验收脚本（S2-验收6/9）。
//
// 用法：
//   node build/dot-core/test/captcha.mjs            # 起服务，等人工拖滑块
//   node build/dot-core/test/captcha.mjs --auto     # 自动拖到最右，验证 JS 能判定通过
//
// 起一个本地 HTTP 服务，serve 同目录的 slider.html。
// 浏览器手（clean_browser）打开页面 → 人拖滑块 → 页面显示「验证通过」。
// 这条验收要的是：captcha 出现 → 任务 paused 等人 → 人做完 → 任务继续。

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, "slider.html"), "utf8");

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8877);
server.listen(port, "127.0.0.1", () => {
  console.log(`滑块验收页听在 http://127.0.0.1:${port}/`);
  console.log("浏览器手打开这个地址，拖滑块到最右边完成验证。");
  console.log("Ctrl+C 停。");
});
