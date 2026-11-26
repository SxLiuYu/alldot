/**
 * src/context/anchor.ts —— 锚点正文的骨架（A.10「上下文三类」的第一类）。
 *
 * 锚点每轮注入，内容**只从账本拼**（A.7「两套记忆」：恢复和状态都从账本拼，
 * 代码里没有读聊天记忆的入口）。所以这里只碰 src/ledger 的读接口。
 *
 * 已成立的部分：任务号/状态/计划版本、目标与复述、工作区声明、里程碑进度、
 * 步骤计数与最近三步、预算、**你定过的每一条决定**（5.2 要求「每一条决定」进锚点；
 * decisions 表最多带 6 条，多的压成一句计数，避免每轮都付长文本的钱）。
 * 还没做的：milestones.summary 的阶段小结（要等第 3 步的小模型压缩）、跑偏裁判结论。
 *
 * 字数上限 1200：锚点每轮都进提示词，长一点就是每一轮都付钱。
 */

import {
  getTask,
  listDecisions,
  listSteps,
  parseJsonOrNull,
  readTaskView,
  type LedgerDb,
  type TaskRow,
} from "../ledger/index.ts";

export const ANCHOR_TEXT_LIMIT = 1200;

export interface AnchorInput {
  db: LedgerDb;
  taskId: string;
}

/** 从 declared_json 里找工作区声明（不同任务写法不一，认几个常见键）。 */
export function workspaceFromDeclared(task: TaskRow): string | null {
  const declared = parseJsonOrNull(task.declared_json);
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return null;
  const obj = declared as Record<string, unknown>;
  for (const key of ["workspace", "root", "workdir", "dir"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const paths = obj["paths"];
  if (Array.isArray(paths)) {
    const first = paths.find((p) => typeof p === "string" && p.trim() !== "");
    if (typeof first === "string") return first.trim();
  }
  return null;
}

/**
 * 拼锚点。任务不存在时返回 null（调用方决定要不要报错）：
 * 上下文注入不该因为一个坏任务号打断整轮对话。
 */
export function buildAnchor(input: AnchorInput): string | null {
  const task = getTask(input.db, input.taskId);
  if (task === null) return null;

  const view = readTaskView(input.db, input.taskId);
  const steps = listSteps(input.db, input.taskId);

  const lines: string[] = [];
  lines.push(`【dot 锚点】任务 ${task.id}｜状态 ${view.stateLabel}｜计划 v${view.planVersion}`);
  lines.push(`目标：${task.intent}`);

  const restated = view.why.restated ?? task.restated;
  if (typeof restated === "string" && restated.trim() !== "" && restated.trim() !== task.intent.trim()) {
    lines.push(`复述：${restated.trim()}`);
  }

  const workspace = workspaceFromDeclared(task) ?? "(未声明工作区：写动作会按「拿不准」提问)";
  lines.push(`工作区：${workspace}`);

  const where = view.where;
  if (where.milestoneCount > 0) {
    const seq = where.milestoneSeq ?? 0;
    lines.push(
      `里程碑：${seq}/${where.milestoneCount}「${where.milestoneTitle ?? "未命名"}」` +
        (where.doneWhen ? `｜完成条件：${where.doneWhen}` : ""),
    );
  } else {
    lines.push("里程碑：还没拆（计划 v" + view.planVersion + "）");
  }

  lines.push(
    `步骤：共 ${where.totalSteps}，成功 ${where.doneSteps}` +
      (where.currentStepSeq !== null ? `，进行中第 ${where.currentStepSeq} 步` : ""),
  );

  const recent = steps.slice(-3);
  if (recent.length > 0) {
    lines.push(
      `最近：${recent
        .map((s) => `#${s.seq} ${s.tool ?? s.kind}/${s.status}`)
        .join("；")}`,
    );
  }

  const budget = task.budget_tokens;
  lines.push(
    budget === null || budget === undefined
      ? `预算：已用 ${task.spent_tokens} token（未设上限）`
      : `预算：已用 ${task.spent_tokens} / ${budget} token`,
  );

  const decisions = listDecisions(input.db, task.id);
  if (decisions.length > 0) {
    const shown = decisions.slice(-6);
    lines.push(
      `你定过（${decisions.length} 条${decisions.length > shown.length ? "，列最近 6 条" : ""}）：` +
        shown.map((d) => `「${d.question}」→「${d.answer}」`).join("；"),
    );
  }

  if (view.blockedBy.type !== "none") {
    lines.push(`卡在：${view.blockedBy.type}（${view.blockedBy.detail}）`);
  }

  lines.push(
    "规则：事实以账本为准；只做声明范围内的事；每一步都会记账；拿不准就问，不要自己扩大范围。",
  );

  const text = lines.join("\n");
  return text.length <= ANCHOR_TEXT_LIMIT ? text : `${text.slice(0, ANCHOR_TEXT_LIMIT)}\n…（锚点已截短）`;
}
