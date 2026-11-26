/**
 * src/dispatch/prompt.ts —— 工人会话的两段文字：一条用户消息 + 一段额外系统提示。
 *
 * 为什么要重写这一段：锚点钩子（src/context/index.ts）也会注入任务上下文，
 * 但那是「账本里的事实」；这一段是**本次派发的约束**——工人模型看不到派发器的代码，
 * 只能从这两段文字知道该干什么、不该干什么。
 * 2026-11-25 真机事故：旧版这里写死「动手只能用 practice 手」，模型照着做，
 * 浏览器任务一步都不动就回「没成功」。现在按任务列清 clean_browser / logged_browser /
 * desktop / files / practice 各自管什么，并明确「不许用 practice 假装做完」。
 *
 * 提示词里不写数字阈值（闸门档位、超时毫秒），那些由闸门代码判定并原样回话；
 * 提示词写死数值，改配置后就会对不上。
 */

import type { TaskRow } from "../ledger/index.ts";

/** 任务书太长会挤掉正文，截断长度按「够看明白」定，不按模型上限定。 */
const DECLARED_LIMIT = 2000;

export interface WorkerPrompt {
  message: string;
  extraSystemPrompt: string;
}

/**
 * `approved`：这个任务上已经批过、还没用掉的动作（形如 "feishu/create {参数摘要}"）。
 * 2026-11-25 真机事故：建日程批了之后重排，工人换成了再查一遍 events，然后就收工了，
 * 批准的那一步永远没执行。原因就是提示词里没人告诉它「这一步已经批了，原样再调一次」。
 */
export function buildWorkerPrompt(task: TaskRow, approved: readonly string[] = []): WorkerPrompt {
  const declared = (task.declared_json ?? "").trim();
  const declaredText =
    declared.length > DECLARED_LIMIT ? `${declared.slice(0, DECLARED_LIMIT)}…（已截断）` : declared;

  const lines = [`任务 ${task.id}`, `意图：${task.intent}`];
  if (typeof task.restated === "string" && task.restated.trim() !== "") {
    lines.push(`复述：${task.restated.trim()}`);
  }
  if (declaredText !== "" && declaredText !== "null") {
    lines.push(`任务声明：${declaredText}`);
  }
  if (approved.length > 0) {
    lines.push("这些动作已经有人批过了，直接**原样再调一次**（不要换成别的动作、也不要先再查一遍）：");
    for (const item of approved) lines.push(`  · ${item}`);
    lines.push("调完就把结果回报出来。");
  }
  lines.push("现在开始做。做完在本轮末尾回报结果。");

  const extraSystemPrompt = [
    `你是 dot 的工人会话，只负责任务 ${task.id} 这一件事。`,
    "1. 动手用手，按任务挑：",
    "   打开网页、搜索、点网页上的按钮、填表、截图 → clean_browser（免登录）或 logged_browser（要登录）；",
    "   点桌面上别的程序、往别的程序里打字、看窗口 → desktop；",
    "   读微信、找会话、发微信 → wechat（发消息要人点同意）；",
    "   看飞书日历、看日程、建日程 → feishu（建日程要人点同意）；",
    "   在任务声明的工作区里建目录、写文件 → files；",
    "   只往练习文件夹里放东西才用 practice；任务跟练习无关时，不许用 practice 假装做完。",
    "   没有合适的手，就在末尾一句话里说清缺哪只手。",
    "2. 工人会话里每个工具都会过闸门：只读类（read/glob/grep）判档后记账放行；",
    "   exec、写盘、浏览器等按档位处理，第 4 档会出请示卡等人批；",
    "   process / subagents / sessions_spawn / message / cron 这类直接拒（不给审批卡）。",
    "3. 被拦下就结束这一轮，不要自己批准、也不要换个说法绕开闸门。",
    "   人批了之后任务会被重新排队，新的会话接着做同一件事。",
    "4. 每做一步先想清楚它能不能重来；拿不准就停下来问，不要猜。",
    "5. 只碰这个任务范围内的东西；任务结束就停手，不要继续动作。",
    "6. 本轮末尾用一段话回报：做了什么、结果怎样、有没有卡住（卡在什么上）。",
  ].join("\n");

  return { message: lines.join("\n"), extraSystemPrompt };
}
