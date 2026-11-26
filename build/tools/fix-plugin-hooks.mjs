#!/usr/bin/env node
/**
 * fix-plugin-hooks.mjs —— 把 dot-core 的钩子从「永远收不到事件」的旧通道挪到 `api.on`。
 *
 * 为什么需要它（2026-11-25 真机实测）：
 *   allbot 网关启动时先 `clearInternalHooks()`（allbot-src/src/gateway/server-startup.ts:143）
 *   清掉插件在注册期登记的内部钩子，再只装载它自己配置里的那几条。于是
 *   `api.registerHook("gateway_start" | "before_tool_call" | "before_prompt_build", …)`
 *   注册的处理器一次都不会被调用——实测日志里没有「恢复协议」「派发器启动」，
 *   账本里 3 个 queued 任务两分钟没人领。
 *   插件正式的类型化通道是 `api.on(hookName, handler)`（types.ts:2277、api-builder.ts:173，
 *   写进 registry.typedHooks，全局 hook runner 从那儿取），它不受那次清理影响。
 *
 * 幂等：已经是新写法的文件不动。可以反复跑——工作流重写 index.ts 之后重跑一次即可。
 *
 * 用法：
 *   node build/tools/fix-plugin-hooks.mjs            # 打补丁
 *   node build/tools/fix-plugin-hooks.mjs --check    # 只报告，不写文件
 *
 * 退出码：0 已就位或已修好 / 1 有一段找不到该改的原文（需要人看）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:/Users/1/Documents/研究/dot/build/dot-core";
const checkOnly = process.argv.includes("--check");
const changes = [];
const problems = [];

function read(p) {
  if (!existsSync(p)) {
    problems.push(`文件不存在：${p}`);
    return null;
  }
  return readFileSync(p, "utf8");
}

function write(p, text, what) {
  changes.push(`${what} → ${p.replace(ROOT, "")}`);
  if (!checkOnly) writeFileSync(p, text, "utf8");
}

/** 有 api.on 就用它，否则退回 registerHook。三个文件共用这一小段判断。 */
function patchApiOnPreferred(p, { siteName, anchor }) {
  const src = read(p);
  if (src === null) return;
  if (src.includes("typeof api.on")) return; // 已经是新写法
  if (!src.includes(anchor)) {
    problems.push(`${siteName}：找不到要替换的原文（${p.replace(ROOT, "")}）。人看一眼。`);
    return;
  }
  problems.push(`${siteName}：还是旧写法，但结构和我预期的不同，需要手工改（${p.replace(ROOT, "")}）`);
}

/** index.ts：恢复 + 派发器直接跑，不再等 gateway_start。 */
function patchIndexTs() {
  const p = join(ROOT, "index.ts");
  const src = read(p);
  if (src === null) return;
  let out = src;

  // 1) 恢复：把挂在 gateway_start 的注册换成加载时直接执行
  const oldRecoverStart = out.indexOf('api.registerHook(\n    "gateway_start"');
  if (oldRecoverStart >= 0 && !out.includes("恢复协议（加载时执行）")) {
    // 从那条 registerHook 起，到它的 opts 收尾为止，整段换成直接调用
    const endMarker = '{ name: "dot-core.gateway.recover" },\n  );';
    const endIdx = out.indexOf(endMarker, oldRecoverStart);
    if (endIdx < 0) {
      problems.push("index.ts：恢复钩子那段找不到结尾，手工改");
    } else {
      const before = out.slice(0, oldRecoverStart);
      const after = out.slice(endIdx + endMarker.length);
      const replacement = [
        "// 2026-11-25 真机实测：gateway_start 处理器在真网关上一次都没跑（插件注册期登记的",
        "// 内部钩子会被 clearInternalHooks() 清掉）。改成加载时就校验 + 恢复。",
        "{",
        "    const integrity = verifyLedger(db);",
        "    if (!integrity.ok) {",
        "      const detail = `账本完整性校验失败（chain=${integrity.chain.ok}，steps=${integrity.steps.ok}）：拒绝继续，先修账本`;",
        '      log("error", detail);',
        "      throw new Error(detail);",
        "    }",
        "    const report = recover(db, { approvalTtlHours: config.approvals.ttl_hours });",
        "    log(",
        '      "info",',
        "      `恢复协议（加载时执行）：${report.headline}（epoch+${report.runEpochBumped.length}，孤儿 ${report.orphans.length}，` +",
        "        `回队 ${report.tasksRequeued.length}，转等人 ${report.tasksAwaitingHuman.length}）`,",
        "    );",
        "  }",
      ].join("\n");
      out = before + replacement + after;
    }
  }

  // 2) 派发器：把挂在 gateway_start 的 start 换成直接 start（start 本身幂等）
  const dispatchHook = out.indexOf('api.registerHook(\n    "gateway_start",\n    () => {\n      dispatch.start();');
  if (dispatchHook >= 0 && !out.includes("派发器已就位")) {
    const endMarker = '{ name: "dot-core.dispatch.start" },\n  );';
    const endIdx = out.indexOf(endMarker, dispatchHook);
    if (endIdx < 0) {
      problems.push("index.ts：派发器 start 那段找不到结尾，手工改");
    } else {
      const before = out.slice(0, dispatchHook);
      const after = out.slice(endIdx + endMarker.length);
      out = before + "// 同上：不挂在 gateway_start 上，加载时直接起（start 幂等）。\n  try {\n    dispatch.start();\n  } catch (err) {\n    log(\"error\", `派发器启动失败（每轮会重试）：${(err as Error).message}`);\n  }" + after;
    }
  }

  // 3) gateway_stop：走 api.on
  const stopHook = out.indexOf('api.registerHook(\n    "gateway_stop",');
  if (stopHook >= 0 && !out.includes('api.on("gateway_stop"')) {
    const endMarker = '{ name: "dot-core.dispatch.stop" },\n  );';
    const endIdx = out.indexOf(endMarker, stopHook);
    if (endIdx < 0) {
      problems.push("index.ts：gateway_stop 那段找不到结尾，手工改");
    } else {
      const before = out.slice(0, stopHook);
      const after = out.slice(endIdx + endMarker.length);
      out =
        before +
        'const stopDispatch = () => {\n    dispatch.stop();\n  };\n  if (typeof api.on === "function") {\n    api.on("gateway_stop", stopDispatch);\n  } else {\n    api.registerHook("gateway_stop", stopDispatch, { name: "dot-core.dispatch.stop" });\n  }' +
        after;
    }
  }

  if (out !== src) write(p, out, "恢复/派发器改为加载时执行，gateway_stop 走 api.on");
}

/** 检查三个钩子文件的写法，报告有没有走 api.on。 */
function reportHookSites() {
  const sites = [
    ["src/hands/builtin.ts", "before_tool_call / after_tool_call（口闸）"],
    ["src/context/index.ts", "before_prompt_build（锚点）"],
    ["src/hands/index.ts", "before_tool_call（身份表）"],
  ];
  for (const [rel, what] of sites) {
    const p = join(ROOT, rel);
    const src = read(p);
    if (src === null) continue;
    const usesOn = src.includes("api.on(") || src.includes("typeof api.on");
    console.log(`${usesOn ? "新写法（api.on）" : "旧写法（registerHook，真网关上收不到）"}  ${rel}  ${what}`);
    if (!usesOn) problems.push(`${rel} 还在用 registerHook：${what} 在真网关上不会生效`);
  }
}

patchIndexTs();
reportHookSites();

if (changes.length > 0) {
  console.log("");
  for (const c of changes) console.log(checkOnly ? `[待改] ${c}` : `已改：${c}`);
}
if (problems.length > 0) {
  console.log("");
  for (const p of problems) console.log(`问题：${p}`);
}
console.log("");
console.log(checkOnly ? "--check：没有写文件" : "补丁跑完。改过代码就要重启网关才生效。");
process.exit(problems.length === 0 ? 0 : 1);
