/**
 * ds-bot 补丁的共享定义：三处补丁的锚文本、标记对、102 名单、6 放行名单。
 * 依据：dot-合并方案-v2-定稿.md 附录 B.1（ds-bot 侧就地补丁 3 处＋数据）。
 *
 * 这个文件只读数据，不碰任何安装目录。所有路径常量都给安装脚本用，
 * 本目录里的脚本默认只在 build/patches/ds-bot/ 内读写。
 */
import { createHash } from "node:crypto";

export const VERSION = "0.3.9";

// 目标文件（安装时才会用到，本目录脚本默认只读快照/不碰安装）
export const TARGET_ROOT = "C:/Users/1/.dsh/profiles/desktop/node_modules/ds-bot";
export const TARGET_FILE = "src/host/tools.js";
export const TARGET_PATH = `${TARGET_ROOT}/${TARGET_FILE}`;
export const PACKAGE_PATH = `${TARGET_ROOT}/package.json`;

// 协议路径（B.1 数据侧）
export const MOUTH_POLICY_PATH = "C:/Users/1/.dsh/plugins/dot-bot-policy/policy.json";
export const GUARD_LOG_PATH = "C:/Users/1/.dsh/bot/dot-guard.jsonl";
// 口闸心跳： verify 第 4/5 道只看这个文件（施工时由打补丁脚本/看门狗写）
export const HEARTBEAT_PATH = "C:/Users/1/.dsh/bot/dot-guard-heartbeat.json";

// 标记对：三处业务标记对＋一处 fs-import 标记对，全部纳入 manifest 和 verify ①。
// fs-import 块被抹掉时 policy.json 定制和 dot-guard.jsonl 日志会静默失效
// （dotRefreshMouth/dotGuardLog 的 catch 吞掉 ReferenceError），必须巡检到。
export const MARKERS = [
  { name: "guard", begin: "// dot:no-hands (begin)", end: "// dot:no-hands (end)", count: 2 },
  { name: "tail", begin: "// dot:no-hands (begin)", end: "// dot:no-hands (end)", count: 2 },
  { name: "delegation-refusal", begin: "// dot:delegation-refusal (begin)", end: "// dot:delegation-refusal (end)", count: 1 },
  { name: "fs-import", begin: "// dot:fs-import (begin)", end: "// dot:fs-import (end)", count: 1 },
];

// B.11/附录 C 的验收命令写的是 build/tools/verify-ds-bot.mjs 与
// repair-ds-bot.mjs；B.1 :758 写的是 build/patches/ds-bot/ 下。两边都给。
export const VERIFY_ENTRY = "build/tools/verify-ds-bot.mjs";
export const REPAIR_ENTRY = "build/tools/repair-ds-bot.mjs";

// 补丁 A-1：guard 里的三行。锚文本逐字抄自 tools.js:1352 之后那一行
// （install() 内 ctx.tools.guard 回调第一行）。
export const GUARD_ANCHOR = "    if (!rt.isBotSession(exec.agent?.id)) return undefined";
export const GUARD_INSERT = [
  "// dot:no-hands (begin)",
  "    const dotRefusal = dotBotToolRefusal(exec)",
  "    if (dotRefusal !== undefined) return dotRefusal",
  "// dot:no-hands (end)",
].join("\n");

// 补丁 B：DELEGATION_REFUSAL 那句（tools.js:46）。原文和改后逐字按 B.1。
export const REFUSAL_OLD =
  "const DELEGATION_REFUSAL = 'Bots do not start subagents, teammates or workflows. Do the work yourself, or hand it to another Bot with message_bot.'";
export const REFUSAL_NEW = [
  "// dot:delegation-refusal (begin)",
  "const DELEGATION_REFUSAL = 'Bots do not start subagents, teammates or workflows. Hand the work to the brain with mcp__brain__brain_task, or pass a conclusion to another Bot with message_bot.'",
  "// dot:delegation-refusal (end)",
].join("\n");

// 补丁 A-2：文件尾函数。按 B.1 原样落地，fs 的 ESM import 加在文件顶部
// （单独一对 // dot:fs-import 标记，不属于三处 // dot: 业务标记对）。
// 名单文件只覆盖 6 个说话工具；4 个桥工具写死在 DOT_BRAIN；读不到名单文件时
// fail-closed 到内置 DOT_MOUTH。每次拒绝追加一行到 GUARD_LOG_PATH。
export const FS_IMPORT_ANCHOR = "import { randomUUID } from 'node:crypto'";
export const FS_IMPORT_INSERT = `${FS_IMPORT_ANCHOR}\n// dot:fs-import (begin)\nimport { readFileSync, appendFileSync, statSync, renameSync, truncateSync } from 'node:fs'\n// dot:fs-import (end)`;
export const TAIL_INSERT = `// dot:no-hands (begin)
// 机器人只留嘴：允许名单外的工具一律拒绝。名单文件 ~/.dsh/plugins/dot-bot-policy/policy.json 只覆盖下面 6 个说话工具；4 个桥工具写死在 DOT_BRAIN，不走名单文件，漏写或写坏也耽误不了找大脑。
const DOT_MOUTH = new Set(['ask_user', 'show_view', 'list_bots', 'message_bot', 'group_goal', 'read_own_chat'])
const DOT_BRAIN = new Set(['mcp__brain__brain_task', 'mcp__brain__brain_status', 'mcp__brain__brain_answer', 'mcp__brain__brain_cancel'])
const DOT_MOUTH_FILE = 'C:/Users/1/.dsh/plugins/dot-bot-policy/policy.json'
const DOT_GUARD_LOG = 'C:/Users/1/.dsh/bot/dot-guard.jsonl'
const DOT_NO_HANDS = 'This Bot has no hands. Only chat, ask_user, show_view and mcp__brain__brain_task, mcp__brain__brain_status, mcp__brain__brain_answer, mcp__brain__brain_cancel are available. Reply to the user, then call mcp__brain__brain_task to hand the work to the brain.'
let dotMouth = DOT_MOUTH, dotMouthAt = 0
function dotRefreshMouth() {
  const now = Date.now()
  if (now - dotMouthAt < 5000) return
  dotMouthAt = now
  try {
    const stat = statSync(DOT_MOUTH_FILE)
    if (!stat.isFile() || stat.size > 64 * 1024) return
    const raw = JSON.parse(readFileSync(DOT_MOUTH_FILE, 'utf8'))
    const names = Array.isArray(raw) ? raw : raw?.tools ?? raw?.allow
    if (!Array.isArray(names) || names.length === 0 || !names.every(n => typeof n === 'string')) return
    const next = new Set(names)
    for (const name of DOT_BRAIN) next.delete(name)  // 桥工具不接受名单文件覆盖
    dotMouth = next
  } catch { /* 读不到或写坏：保留内置默认，fail-closed 到 DOT_MOUTH */ }
}
function dotGuardLog(exec, name) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), bot: exec?.agent?.id ?? null, name }) + '\\n'
    appendFileSync(DOT_GUARD_LOG, line)
    // 50MB 轮转留 2 份（B.7 口径）。
    try {
      if (statSync(DOT_GUARD_LOG).size > 50 * 1024 * 1024) {
        try { renameSync(DOT_GUARD_LOG + '.1', DOT_GUARD_LOG + '.2') } catch {}
        renameSync(DOT_GUARD_LOG, DOT_GUARD_LOG + '.1')
        truncateSync(DOT_GUARD_LOG, 0)
      }
    } catch { /* 轮转失败不影响拒绝本身 */ }
  } catch { /* 日志失败不影响拒绝本身 */ }
}
function dotBotToolRefusal(exec) {
  try {
    const name = exec?.name
    if (typeof name !== 'string') return undefined
    dotRefreshMouth()
    if (dotMouth.has(name) || DOT_BRAIN.has(name)) return undefined
    dotGuardLog(exec, name)
    return DOT_NO_HANDS
  } catch { return DOT_NO_HANDS }
}
// dot:no-hands (end)`;

// B.1 的 102 个工具名（顺序照原文），作为 ③ 断言的基准。
export const TOOLS_102 = `ask_user, ask_user_question, attach_capability, bot_forget, bot_recall, bot_remember, cordis_inspect, create_bot, create_goal, create_group, delete_capability, delete_group, detach_capability, edit, enter_worktree, exit_worktree, get_goal, glob, grep, group_goal, group_relay, group_task, group_todo, job_kill, job_list, job_output, list_agents, list_bot_models, list_bots, list_capabilities, list_connectors, list_mcp_resource_templates, list_mcp_resources, list_secrets, list_subagent_models, load_workspace_dependencies, mail_draft, mail_read, mail_search, mail_send, mail_update, mcp__argo__argo_fetch, mcp__argo__argo_research, mcp__argo__argo_screenshot, mcp__argo__argo_search, message_bot, plugin_manager, post_to_group, prepare_ds_bot_issue, present, pwsh, ralph, read, read_browser, read_group_chat, read_image, read_mcp_resource, read_own_chat, request_connector, request_secret, save_capability, schedule_create, schedule_edit, schedule_list, schedule_view, send_message, session_event_read, session_event_search, session_event_trace, session_search, session_trace, show_view, skill, stop_bot, subagent, subagent_fork, task_list, task_read, task_send, task_start, task_stop, taskboard_add, taskboard_list, taskboard_merge_worktree, taskboard_update, terminal_close, terminal_list, terminal_open, terminal_read, terminal_send, terminal_signal, todo_write, update_bot, update_goal, update_group, user_terminal_list, user_terminal_read, wait_agent, web_fetch, web_search, workflow, write`
  .split(",")
  .map((s) => s.trim());

// B.1 允许名单：102 内的 6 个说话工具。4 个 brain_* 不在 102 内（加能力后出现），
// ③ 断言 6 放行 / 96 拒，另单独断言 4 个桥工具也放行。
export const MOUTH_ALLOW = [
  "ask_user",
  "show_view",
  "list_bots",
  "message_bot",
  "group_goal",
  "read_own_chat",
];
export const BRAIN_ALLOW = [
  "mcp__brain__brain_task",
  "mcp__brain__brain_status",
  "mcp__brain__brain_answer",
  "mcp__brain__brain_cancel",
];

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 从 patched 源文本里按标记切出尾部函数（③ 用）。找不到抛错。 */
export function extractTailedFunction(source) {
  const blocks = extractMarkedBlocks(source, "no-hands");
  const tail = blocks.find((b) => b.includes("function dotBotToolRefusal"));
  if (!tail) throw new Error("找不到 dotBotToolRefusal 函数块");
  return tail;
}

/** 取所有 // dot:<tag> (begin) ... (end) 块（含标记行）。 */
export function extractMarkedBlocks(source, tag) {
  const out = [];
  const begin = `// dot:${tag} (begin)`;
  const end = `// dot:${tag} (end)`;
  let from = 0;
  while (true) {
    const i = source.indexOf(begin, from);
    if (i < 0) break;
    const j = source.indexOf(end, i + begin.length);
    if (j < 0) break;
    out.push(source.slice(i, j + end.length));
    from = j + end.length;
  }
  return out;
}

/** 干净文本 → 打补丁后的文本。三处补丁顺序无关，重复调用幂等。 */
export function applyPatches(source) {
  let out = source;
  // ESM 的 import 只能出现在文件顶部：插在 tools.js 第一行 import 之后。
  if (!out.includes("// dot:fs-import (begin)")) {
    if (!out.includes(FS_IMPORT_ANCHOR)) throw new Error("fs import 锚文本不在，版本不符");
    out = out.replace(FS_IMPORT_ANCHOR, FS_IMPORT_INSERT);
  }
  // B：DELEGATION_REFUSAL 换句并加标记；已是新文本则跳过。
  if (out.includes(REFUSAL_OLD)) {
    out = out.replace(REFUSAL_OLD, REFUSAL_NEW);
  } else if (!out.includes(REFUSAL_NEW)) {
    throw new Error("DELEGATION_REFUSAL 原文和补丁后文本都不在，版本不符");
  }
  // A-1：guard 里插三行；已插入则跳过。
  if (!out.includes("const dotRefusal = dotBotToolRefusal(exec)")) {
    const anchor = `${GUARD_ANCHOR}\n`;
    if (!out.includes(anchor)) throw new Error("guard 锚文本不在，版本不符");
    out = out.replace(anchor, `${anchor}${GUARD_INSERT}\n`);
  }
  // A-2：文件尾追加函数；已追加则跳过。
  if (!out.includes("function dotBotToolRefusal")) {
    out = `${out.trimEnd()}\n\n${TAIL_INSERT}\n`;
  }
  return out;
}
