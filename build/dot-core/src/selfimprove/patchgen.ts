/**
 * src/selfimprove/patchgen.ts —— 把「一条提案」变成「一份能用的补丁」。
 *
 * 为什么需要这一层：提案只写「建议改什么」（proposedChange 是自然语言），
 * 而 applyProposal 只收 unified diff 原文。中间这一步以前没有，于是「点同意」什么也不会发生
 * （2026-11-25 复核：applyProposal 全仓只有定义和测试调用，没有生产调用点）。
 *
 * 安全边界不在这一层：模型写出来的补丁要过 applyProposal 的四道闸
 * （规范化路径、硬黑名单、白名单前缀、补丁必须点名目标），再在副本上打一遍并跑全量测试 + tsc。
 * 这里只做两件小事：拼提示词、从模型回答里把 diff 抠出来。
 */

import type { Proposal } from "./types.ts";

/** 单次补丁上限，与 apply.ts 的 MAX_PATCH_BYTES 同量级；这里先拦一道，别把大块垃圾送去检查。 */
export const MAX_GENERATED_PATCH_BYTES = 64 * 1024;

/** 目标文件原文最多给模型多少字符（超了截断，并明确写出来）。 */
export const MAX_SOURCE_CHARS = 24_000;

export function buildPatchPrompt(input: { target: string; fileText: string; proposal: Proposal }): string {
  const { target, fileText, proposal } = input;
  const body =
    fileText.length > MAX_SOURCE_CHARS
      ? `${fileText.slice(0, MAX_SOURCE_CHARS)}\n…（原文过长，已截断到 ${MAX_SOURCE_CHARS} 字符）`
      : fileText;
  return [
    "你是一个只输出补丁的助手。按下面的建议，给目标文件写一份 unified diff。",
    "",
    "硬性要求：",
    "1. 只输出 diff 本身，放在 ```diff 代码块里；不要解释、不要加前言后记。",
    "2. diff 必须能用 `git apply` 的格式：每处改动带 --- / +++ 与 @@ 行号，上下文行原样抄。",
    "3. 只改这一个文件，不许新建或删除别的文件；不许改依赖、配置键名、测试断言。",
    "4. 如果这份建议在这个文件里做不到（找不到对应代码、需要改别的文件），就回一句 `无法生成：原因`。",
    "",
    `目标文件：${target}`,
    `建议类别：${proposal.kind}`,
    `建议：${proposal.proposedChange}`,
    proposal.why === "" ? "" : `为什么要改：${proposal.why}`,
    proposal.risk === "" ? "" : `风险：${proposal.risk}`,
    "",
    "目标文件原文：",
    "```",
    body,
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 从模型回答里抠出 diff。抠不出来返回 null（调用方按「这次没生成」处理，不当失败）。 */
export function extractPatch(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "" || text.startsWith("无法生成")) return null;

  const fenced = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  if (candidate === "") return null;
  // 必须像 diff：有 ---/+++ 或 @@，否则别送去检查白跑一遍测试。
  if (!/^---\s/m.test(candidate) || !/^\+\+\+\s/m.test(candidate)) return null;
  if (!/^@@/m.test(candidate)) return null;
  if (Buffer.byteLength(candidate, "utf8") > MAX_GENERATED_PATCH_BYTES) return null;
  return `${candidate}\n`;
}
