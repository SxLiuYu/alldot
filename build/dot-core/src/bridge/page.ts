/**
 * src/bridge/page.ts —— GET / 的只读状态页（B.6）。
 *
 * 页面结构对齐方案：任务、待批、组件红绿、恢复报告，外加一块「任务进度」——
 * 那一块直接用账本的模板卡（renderProgressCard）原样贴，不经模型。
 *
 * 大脑掉线时这一页必须照样能看：任务与审批来自只读账本，顶部多一条
 * 「大脑掉线（X 时起）」；「盘／备份／artifacts／snapshots／探针」那一行来自
 * keeper 的 keep.json，不走账本（盘紧时账本恰好写不进）。
 */

import { escapeHtml } from "./http.ts";
import type { KeepView, HealthLevel } from "./keep.ts";
import { keepHeaderLine } from "./keep.ts";
import type { LedgerView } from "./view.ts";

export interface BrainProbeView {
  online: boolean;
  /**
   * route_missing = 18789 在，但 dot-core 的 /dot/bridge/v1 路由不存在（B.3 fail-closed 场景）；
   * token_rejected = 网关或 dot-core 拒了 token；offline = 连不上/超时。
   */
  mode: "online" | "offline" | "route_missing" | "token_rejected" | "unknown";
  downSince: Date | null;
  lastOkAt: Date | null;
  error: string | null;
}

export interface StatusPageModel {
  now: Date;
  ledger: LedgerView;
  keep: KeepView;
  brain: BrainProbeView;
  tokenConfigured: boolean;
  tokenPath: string;
  port: number;
  version: string;
}

const LEVEL_LABEL: Record<HealthLevel, string> = {
  green: "绿",
  yellow: "黄",
  red: "红",
  grey: "灰",
};

function clock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function dateTime(value: string | Date | null): string {
  if (value === null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "—";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${clock(d)}`;
}

function levelBadge(level: HealthLevel): string {
  return `<span class="badge ${level}">${LEVEL_LABEL[level]}</span>`;
}

function componentRow(name: string, level: HealthLevel, note: string | null): string {
  const text = note === null ? "" : `<span class="note">${escapeHtml(note)}</span>`;
  return `<tr><td>${escapeHtml(name)}</td><td>${levelBadge(level)}</td><td>${text}</td></tr>`;
}

function brainBanner(brain: BrainProbeView, now: Date): string {
  if (brain.online) {
    const at = brain.lastOkAt === null ? "刚刚" : dateTime(brain.lastOkAt);
    return `<div id="brain-status" class="banner up">大脑在线（最后一次应答 ${escapeHtml(at)}）</div>`;
  }
  if (brain.downSince !== null) {
    const minutes = Math.max(0, Math.round((now.getTime() - brain.downSince.getTime()) / 60000));
    const since = clock(brain.downSince);
    const why = brain.error === null ? "" : `：${brain.error}`;
    if (brain.mode === "route_missing") {
      return (
        `<div id="brain-status" class="banner down">大脑插件没加载，手已停用（${escapeHtml(since)} 时起，已 ${minutes} 分钟）` +
        `${escapeHtml(why)}。18789 有应答，但 dot-core 的 /dot/bridge/v1 路由不在——` +
        `按 B.3 应停网关；插件修好后自动回主路。下面显示账本最后状态（只读）。</div>`
      );
    }
    if (brain.mode === "token_rejected") {
      return (
        `<div id="brain-status" class="banner down">大脑拒了桥 token（${escapeHtml(since)} 时起，已 ${minutes} 分钟）` +
        `${escapeHtml(why)}。核对 ~/.allbot/dot/bridge-token（x-dot-bridge-token）与 ` +
        `~/.allbot/allbot.json 的 gateway.auth.token（Authorization）。下面显示账本最后状态（只读）。</div>`
      );
    }
    return (
      `<div id="brain-status" class="banner down">大脑掉线（${escapeHtml(since)} 时起，已 ${minutes} 分钟）` +
      `${escapeHtml(why)}。下面显示的是账本里最后一次写入的状态（只读），不是实时进度。</div>`
    );
  }
  return `<div id="brain-status" class="banner unknown">大脑状态未知（还没探到过）：下面显示账本里最后的状态（只读）。</div>`;
}

export function renderStatusPage(model: StatusPageModel): string {
  const { ledger, keep, brain, now } = model;

  const components: string[] = [];
  components.push(
    componentRow(
      `大脑（127.0.0.1:18789）`,
      brain.online ? "green" : brain.mode === "unknown" ? "grey" : "red",
      brain.online ? null : brain.error,
    ),
  );
  components.push(componentRow("dot-bridge（本页）", "green", `127.0.0.1:${model.port}`));
  components.push(
    componentRow(
      "桥 token",
      model.tokenConfigured ? "green" : "red",
      model.tokenConfigured ? model.tokenPath : `未配置：${model.tokenPath}（除 /health 外全部请求会被拒）`,
    ),
  );
  components.push(
    componentRow(
      "账本（只读）",
      ledger.ok ? "green" : "red",
      ledger.ok ? ledger.path : ledger.error,
    ),
  );
  components.push(
    componentRow(
      "keeper 状态文件",
      keep.ok ? "green" : "grey",
      keep.ok ? keep.path : keep.error,
    ),
  );
  if (keep.diskFreeMb !== null) {
    const level: HealthLevel =
      keep.diskFreeMb < 800 ? "red" : keep.diskFreeMb < 2048 ? "red" : keep.diskFreeMb < 5120 ? "yellow" : "green";
    components.push(
      componentRow("账本盘剩余", level, `${(keep.diskFreeMb / 1024).toFixed(2)} GB${keep.diskNote === null ? "" : `（${keep.diskNote}）`}`),
    );
  }
  for (const c of keep.components) {
    components.push(componentRow(c.name, c.level, c.note));
  }

  const progress =
    ledger.ok && ledger.tasks.length > 0
      ? ledger.tasks
          .map(
            (t) =>
              `<article class="task" data-task-id="${escapeHtml(t.id)}">` +
              `<div class="task-head">${escapeHtml(t.stateLabel)} · ${escapeHtml(t.profile)} · 更新 ${escapeHtml(
                dateTime(t.updatedAt),
              )}</div>` +
              `<pre class="card">${escapeHtml(t.card)}</pre></article>`,
          )
          .join("\n")
      : ledger.ok
        ? `<p class="empty">没有进行中的任务。</p>`
        : `<p class="empty bad">账本读不出来：${escapeHtml(ledger.error ?? "未知原因")}</p>`;

  const approvals =
    ledger.ok && ledger.approvals.length > 0
      ? `<table class="grid"><thead><tr><th>批单</th><th>任务</th><th>档</th><th>要你定的事</th><th>到期</th></tr></thead><tbody>` +
        ledger.approvals
          .map(
            (a) =>
              `<tr><td class="mono">${escapeHtml(a.id)}</td><td class="mono">${escapeHtml(a.taskId ?? "—")}</td>` +
              `<td>${a.tier}</td><td>${escapeHtml(a.title)}</td><td>${escapeHtml(dateTime(a.pendingUntil))}</td></tr>`,
          )
          .join("") +
        `</tbody></table><p class="hint">审批入口只有 ds-bot 聊天窗里的提问卡（A.6）；没开 ds-bot 就没人能点。</p>`
      : ledger.ok
        ? `<p class="empty">没有待批的事。</p>`
        : `<p class="empty bad">账本读不出来，待批列表为空不代表没有待批。</p>`;

  const recovery =
    ledger.ok && ledger.recovery !== null
      ? `<p class="recovery">${escapeHtml(ledger.recovery.headline ?? "恢复报告没有 headline")}</p>` +
        `<p class="hint">结束于 ${escapeHtml(dateTime(ledger.recovery.finishedAt))}；原文在账本 events 表（type=recovery_report）。</p>`
      : `<p class="empty">账本里还没有恢复报告（网关启动后由 dot-core 写）。</p>`;

  const terminal =
    ledger.ok && ledger.terminalTasks.length > 0
      ? `<table class="grid"><thead><tr><th>任务</th><th>状态</th><th>意图</th><th>更新</th></tr></thead><tbody>` +
        ledger.terminalTasks
          .map(
            (t) =>
              `<tr><td class="mono">${escapeHtml(t.id)}</td><td>${escapeHtml(t.stateLabel)}</td>` +
              `<td>${escapeHtml(t.intent)}</td><td>${escapeHtml(dateTime(t.updatedAt))}</td></tr>`,
          )
          .join("") +
        `</tbody></table>`
      : `<p class="empty">还没有结束的任务。</p>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dot 状态页</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 "Microsoft YaHei", system-ui, sans-serif; margin: 0 auto; max-width: 1080px; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  .meta { color: #777; font-size: 12px; }
  .line { margin: 10px 0; padding: 8px 10px; background: #8881; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .banner { padding: 8px 10px; border-radius: 4px; margin: 10px 0; }
  .banner.up { background: #2e7d3222; border-left: 4px solid #2e7d32; }
  .banner.down { background: #c6282822; border-left: 4px solid #c62828; }
  .banner.unknown { background: #8881; border-left: 4px solid #888; }
  table.grid { border-collapse: collapse; width: 100%; }
  table.grid th, table.grid td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8883; vertical-align: top; }
  .badge { display: inline-block; min-width: 1.6em; text-align: center; border-radius: 3px; color: #fff; padding: 0 4px; font-size: 12px; }
  .badge.green { background: #2e7d32; }
  .badge.yellow { background: #f9a825; color: #222; }
  .badge.red { background: #c62828; }
  .badge.grey { background: #777; }
  .note { color: #777; font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  pre.card { white-space: pre-wrap; background: #8881; padding: 10px; border-radius: 4px; margin: 6px 0 0; font-family: ui-monospace, monospace; font-size: 13px; }
  .task { margin: 12px 0; }
  .task-head { color: #777; font-size: 12px; }
  .empty { color: #777; }
  .empty.bad { color: #c62828; }
  .hint { color: #777; font-size: 12px; margin: 6px 0 0; }
  footer { margin-top: 28px; color: #777; font-size: 12px; border-top: 1px solid #8884; padding-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>dot 状态页</h1>
  <div class="meta">dot-bridge ${escapeHtml(model.version)} · 生成于 ${escapeHtml(dateTime(now))} · 只读，不写账本</div>
</header>

<div class="line" id="keep-line">${escapeHtml(keepHeaderLine(keep))}</div>
${brainBanner(brain, now)}

<section id="recovery">
  <h2>恢复报告</h2>
  ${recovery}
</section>

<section id="components">
  <h2>组件</h2>
  <table class="grid"><thead><tr><th>组件</th><th>状态</th><th>说明</th></tr></thead>
  <tbody>${components.join("")}</tbody></table>
</section>

<section id="progress">
  <h2>任务进度（账本模板卡原样贴，不经模型）</h2>
  ${progress}
</section>

<section id="approvals">
  <h2>待批</h2>
  ${approvals}
</section>

<section id="tasks">
  <h2>最近结束的任务</h2>
  ${terminal}
</section>

<footer>
  数据来源：账本 ${escapeHtml(ledger.path)}（node:sqlite 只读）与 keeper 的 keep.json；
  本页永不写账本。大脑掉线时这里是最后写入的状态。
</footer>
</body>
</html>`;
}
