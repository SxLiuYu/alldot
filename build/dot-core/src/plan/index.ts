/**
 * src/plan/index.ts —— 分层计划的写入口：首拆、重排、推进里程碑、本轮计划、记对齐、答「为什么」。
 *
 * 位置：只依赖 src/ledger（账本唯一写入口），不碰 hands/、dispatch/、context/。
 * 触发点不在这里：方案 5.3 的四个触发（里程碑完成 / 同一里程碑连续失败 2 步 /
 * 预算超八成 / 你改了主意）由派发器与闸门判定，它们调 replan() 并传 REPLAN_REASONS
 * 里的一个 reason；本模块只负责把重排写对。
 *
 * 分层链「目标→里程碑→本轮计划→步骤」：
 *   - 目标、里程碑 = planTask / replan 写；
 *   - 本轮计划 = setRoundPlan / currentRoundPlan 写与读（存当前 plans 行的
 *     content_json.round_plan）；拆哪几步归派发器/跑腿工，本模块不判断；
 *   - 步骤 = steps 表，归 hands/dispatch，不在这里。
 *
 * 写 tasks 的两个指针列时直接 UPDATE：setTaskState 会强行再写一条
 * task_state_changed（from==to），把事件链弄脏；这里只动指针，所以自己改并追加
 * 一条 task_pointer_moved。整个过程都在调用方的同一个事务里。
 */

import {
  LedgerError,
  appendEvent,
  canonicalJson,
  createMilestone,
  createPlan,
  getMilestone,
  getTask,
  inTransaction,
  latestPlan,
  listDecisions,
  listMilestones,
  listPlans,
  nowIso,
  parseJsonOrNull,
  recordDecision,
  updateMilestone,
  type LedgerDb,
  type MilestoneRow,
  type PlanRow,
} from "../ledger/index.ts";
import {
  REPLAN_REASONS,
  type AdvanceResult,
  type AlignmentRecord,
  type MilestoneInput,
  type PlanInput,
  type ReplanInput,
  type ReplanReason,
  type RoundPlan,
  type RoundPlanInput,
} from "./types.ts";

export * from "./types.ts";
export * from "./contract.ts";

/** whyWeDidThis 的答案上限（进锚点/一问一答时都不该长篇）。 */
export const WHY_ANSWER_LIMIT = 500;

/** 「为什么这样做：」前缀固定，whyWeDidThis 按它回查。 */
export const ALIGNMENT_QUESTION_PREFIX = "为什么这样做：";

// ────────────────────────────────────────────────────────────────────────────
// 内部帮手
// ────────────────────────────────────────────────────────────────────────────

function requireTask(db: LedgerDb, taskId: string) {
  const task = getTask(db, taskId);
  if (task === null) {
    throw new LedgerError("task_not_found", `plan: 任务 ${taskId} 不存在`);
  }
  return task;
}

function assertMilestones(milestones: unknown, where: string): asserts milestones is MilestoneInput[] {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new LedgerError("bad_plan", `${where}: 至少要有一个里程碑`);
  }
  for (const [i, m] of milestones.entries()) {
    if (typeof m?.title !== "string" || m.title.trim() === "") {
      throw new LedgerError("bad_plan", `${where}: 第 ${i + 1} 个里程碑缺 title`);
    }
    if (typeof m?.done_when !== "string" || m.done_when.trim() === "") {
      throw new LedgerError("bad_plan", `${where}: 第 ${i + 1} 个里程碑缺 done_when`);
    }
  }
}

function assertReason(reason: string): asserts reason is ReplanReason {
  if (!(REPLAN_REASONS as readonly string[]).includes(reason)) {
    throw new LedgerError(
      "bad_replan_reason",
      `replan: 非法 reason ${String(reason)}，只接受 ${REPLAN_REASONS.join(" / ")}`,
    );
  }
}

/**
 * 只挪 tasks 的两个指针列（milestone_id / plan_version），不改 state。
 * 调用方必须在事务里；每次挪都追加一条 task_pointer_moved 事件，链上可查。
 */
function moveTaskPointers(
  db: LedgerDb,
  taskId: string,
  next: { milestoneId?: string | null; planVersion?: number },
): void {
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | null> = [nowIso()];
  if (next.milestoneId !== undefined) {
    sets.push("milestone_id = ?");
    params.push(next.milestoneId);
  }
  if (next.planVersion !== undefined) {
    sets.push("plan_version = ?");
    params.push(next.planVersion);
  }
  params.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  appendEvent(db, {
    task_id: taskId,
    type: "task_pointer_moved",
    payload: {
      task_id: taskId,
      milestone_id: next.milestoneId ?? undefined,
      plan_version: next.planVersion ?? undefined,
    },
  });
}

/** 从旧计划内容里把 goal 取回来（重排时沿用，取不到就 null）。 */
function carryGoal(plan: PlanRow | null): string | null {
  if (plan === null) return null;
  const content = parseJsonOrNull(plan.content_json);
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const goal = (content as { goal?: unknown }).goal;
    if (typeof goal === "string" && goal.trim() !== "") return goal;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 1) 首拆
// ────────────────────────────────────────────────────────────────────────────

/**
 * 首次拆计划：一个事务里写全部里程碑 + plans(version=1) + 把任务的指针挪过去。
 *
 * - seq 从 1 连续编号；第一个标 active（它就是「当前里程碑」），其余 pending。
 * - plans.content_json 存 { goal, milestones, why }，plans.why 同样写一份。
 * - tasks.milestone_id 指向第一个里程碑，tasks.plan_version = 1。
 *
 * 同一个任务已经有计划时抛 already_planned：首拆只做一次，后面走 replan。
 */
export function planTask(db: LedgerDb, input: PlanInput): {
  milestones: MilestoneRow[];
  plan: PlanRow;
} {
  const task = requireTask(db, input.taskId);
  if (typeof input.why !== "string" || input.why.trim() === "") {
    throw new LedgerError("bad_plan", "planTask: why 不能为空");
  }
  assertMilestones(input.milestones, "planTask");

  return inTransaction(db, () => {
    const existing = listPlans(db, input.taskId);
    if (existing.length > 0) {
      throw new LedgerError(
        "already_planned",
        `planTask: 任务 ${input.taskId} 已有计划（version ${existing[existing.length - 1].version}），改造用 replan`,
      );
    }
    // 先清掉可能残留的里程碑（半途失败重试的兜底）：首拆阶段理论上没有，
    // 但任务被外部造过行时别让 seq 撞车。
    if (listMilestones(db, input.taskId).length > 0) {
      throw new LedgerError(
        "already_planned",
        `planTask: 任务 ${input.taskId} 已有里程碑，改造用 replan`,
      );
    }

    const created: MilestoneRow[] = [];
    input.milestones.forEach((m, idx) => {
      created.push(
        createMilestone(db, {
          task_id: input.taskId,
          seq: idx + 1,
          title: m.title,
          done_when: m.done_when,
          state: idx === 0 ? "active" : "pending",
        }),
      );
    });

    const first = created[0];
    const plan = createPlan(db, {
      task_id: input.taskId,
      version: 1,
      milestone_id: first.id,
      content: {
        goal: input.goal,
        milestones: created.map((m) => ({
          seq: m.seq,
          title: m.title,
          done_when: m.done_when,
        })),
        why: input.why,
      },
      why: input.why,
    });

    moveTaskPointers(db, input.taskId, { milestoneId: first.id, planVersion: plan.version });

    // 任务一定要存在（requireTask 已确认），这里只看一眼指针有没有真的写进去。
    if (getTask(db, input.taskId)?.milestone_id !== first.id) {
      throw new LedgerError("pointer_not_written", "planTask: 里程碑指针没写进去");
    }
    return { milestones: created, plan };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 2) 重排
// ────────────────────────────────────────────────────────────────────────────

/**
 * 重排：version+1 写新 plans 行（旧行不动），任务指针跟着新版本走。
 *
 * - reason 必须是 REPLAN_REASONS 之一，否则抛 bad_replan_reason。
 * - 给了 milestones：把旧的、还没做完的（pending/active）里程碑标 skipped（不是 done），
 *   按新清单重建；新清单第一条标 active，tasks.milestone_id 指向它。
 *   新里程碑的 seq 从「现有最大 seq + 1」接着编，旧的 skipped 行保留原 seq，历史不串。
 * - 没给 milestones：只改理由，里程碑与当前指针都不动。
 *
 * version 在事务里用 max(version)+1 现算；inTransaction 的 BEGIN IMMEDIATE 把并发
 * 写串行化，所以两个并发 replan 不会拿到同一个 version。
 */
export function replan(db: LedgerDb, input: ReplanInput): {
  plan: PlanRow;
  milestones: MilestoneRow[];
  skipped: MilestoneRow[];
} {
  requireTask(db, input.taskId);
  assertReason(input.reason);
  if (typeof input.why !== "string" || input.why.trim() === "") {
    throw new LedgerError("bad_replan", "replan: why 不能为空");
  }
  if (input.milestones !== undefined) {
    assertMilestones(input.milestones, "replan");
  }

  return inTransaction(db, () => {
    const prev = latestPlan(db, input.taskId);
    const version = (prev?.version ?? 0) + 1;
    const goal = carryGoal(prev);
    const task = requireTask(db, input.taskId);

    const skipped: MilestoneRow[] = [];
    const created: MilestoneRow[] = [];
    let currentMilestoneId = task.milestone_id;

    if (input.milestones !== undefined) {
      const allBefore = listMilestones(db, input.taskId);
      let maxSeq = allBefore.reduce((mx, m) => Math.max(mx, m.seq), 0);

      // 还没做完的统统作废；done 的保留（历史小结不能抹）。
      for (const m of allBefore) {
        if (m.state === "pending" || m.state === "active") {
          const updated = updateMilestone(db, m.id, { state: "skipped", ended_at: nowIso() });
          if (updated !== null) skipped.push(updated);
        }
      }

      input.milestones.forEach((m, idx) => {
        maxSeq += 1;
        created.push(
          createMilestone(db, {
            task_id: input.taskId,
            seq: maxSeq,
            title: m.title,
            done_when: m.done_when,
            state: idx === 0 ? "active" : "pending",
          }),
        );
      });
      currentMilestoneId = created[0].id;
    }

    const plan = createPlan(db, {
      task_id: input.taskId,
      version,
      milestone_id: currentMilestoneId,
      content: {
        goal,
        milestones: (input.milestones !== undefined
          ? created.map((m) => ({ seq: m.seq, title: m.title, done_when: m.done_when }))
          : listMilestones(db, input.taskId)
              .filter((m) => m.state === "pending" || m.state === "active")
              .map((m) => ({ seq: m.seq, title: m.title, done_when: m.done_when }))),
        reason: input.reason,
        why: input.why,
      },
      why: input.why,
    });

    moveTaskPointers(db, input.taskId, {
      ...(input.milestones !== undefined ? { milestoneId: currentMilestoneId } : {}),
      planVersion: plan.version,
    });

    return { plan, milestones: created, skipped };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 3) 推进里程碑
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把当前里程碑标 done（写 ended_at），下一个还没做的标 active 并把任务指针挪过去。
 *
 * - 只接受「任务当前指向的那个里程碑」，乱序推进直接抛 not_current_milestone。
 * - 下一个 = seq 更大且 state=pending 的第一条；skipped 的自动越过。
 * - 做完最后一个返回 { finished: true, milestone: null }，**不改任务状态**
 *   （收尾是派发器的事）。
 */
export function advanceMilestone(
  db: LedgerDb,
  input: { taskId: string; milestoneId: string },
): AdvanceResult {
  const task = requireTask(db, input.taskId);
  const current = getMilestone(db, input.milestoneId);
  if (current === null || current.task_id !== input.taskId) {
    throw new LedgerError(
      "milestone_not_found",
      `advanceMilestone: 里程碑 ${input.milestoneId} 不属于任务 ${input.taskId}`,
    );
  }
  if (task.milestone_id !== input.milestoneId) {
    throw new LedgerError(
      "not_current_milestone",
      `advanceMilestone: ${input.milestoneId} 不是任务 ${input.taskId} 的当前里程碑（当前 ${String(task.milestone_id)}）`,
    );
  }
  if (current.state === "done" || current.state === "skipped") {
    throw new LedgerError(
      "milestone_closed",
      `advanceMilestone: 里程碑 ${input.milestoneId} 已经是 ${current.state}`,
    );
  }

  return inTransaction(db, () => {
    updateMilestone(db, input.milestoneId, { state: "done", ended_at: nowIso() });

    const next =
      listMilestones(db, input.taskId)
        .filter((m) => m.seq > current.seq && m.state === "pending")
        .sort((a, b) => a.seq - b.seq)[0] ?? null;

    if (next === null) {
      moveTaskPointers(db, input.taskId, { milestoneId: null });
      return { finished: true, milestone: null };
    }

    updateMilestone(db, next.id, { state: "active" });
    moveTaskPointers(db, input.taskId, { milestoneId: next.id });
    return {
      finished: false,
      milestone: {
        id: next.id,
        seq: next.seq,
        title: next.title,
        done_when: next.done_when,
        state: "active",
      },
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 4) 本轮计划（分层链第三层）
// ────────────────────────────────────────────────────────────────────────────

/** 从一行 plans 里把 round_plan 抠出来；没有或格式不认识返回 null。 */
function readRoundPlan(plan: PlanRow): RoundPlan | null {
  const content = parseJsonOrNull(plan.content_json);
  if (content === null || typeof content !== "object" || Array.isArray(content)) return null;
  const raw = (content as { round_plan?: unknown }).round_plan;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.steps)) return null;
  return {
    version: plan.version,
    milestoneId: typeof o.milestone_id === "string" ? o.milestone_id : null,
    steps: o.steps.filter((s): s is string => typeof s === "string"),
    note: typeof o.note === "string" ? o.note : null,
    updatedAt: typeof o.updated_at === "string" ? o.updated_at : plan.created_at,
  };
}

/**
 * 写「本轮计划」：当前管用的一轮要做的几步，挂在最新 plans 行的
 * content_json.round_plan 上（不改 version，不新建计划行）。
 *
 * 谁调：派发器在每轮开工前拆好步骤后调；本模块只落账。
 * 为什么覆盖同一行：本轮计划每轮都变，而 plans 行只在重排时增加；把它当
 * 「当前计划的附属字段」覆盖写，历史由 events(round_plan_set) 留痕。
 */
export function setRoundPlan(db: LedgerDb, input: RoundPlanInput): RoundPlan {
  const task = requireTask(db, input.taskId);
  if (!Array.isArray(input.steps) || input.steps.some((s) => typeof s !== "string" || s.trim() === "")) {
    throw new LedgerError("bad_round_plan", "setRoundPlan: steps 必须是非空字符串数组");
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    throw new LedgerError("bad_round_plan", "setRoundPlan: note 必须是字符串");
  }

  return inTransaction(db, () => {
    const plan = latestPlan(db, input.taskId);
    if (plan === null) {
      throw new LedgerError(
        "no_plan",
        `setRoundPlan: 任务 ${input.taskId} 还没有计划，先 planTask`,
      );
    }
    const parsed = parseJsonOrNull(plan.content_json);
    const base: Record<string, unknown> =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    const updatedAt = nowIso();
    base.round_plan = {
      milestone_id: task.milestone_id,
      steps: input.steps,
      note: input.note ?? null,
      updated_at: updatedAt,
    };
    db.prepare("UPDATE plans SET content_json = ? WHERE id = ?").run(canonicalJson(base), plan.id);
    appendEvent(db, {
      task_id: input.taskId,
      type: "round_plan_set",
      payload: {
        plan_id: plan.id,
        version: plan.version,
        milestone_id: task.milestone_id,
        step_count: input.steps.length,
      },
    });
    return {
      version: plan.version,
      milestoneId: task.milestone_id,
      steps: [...input.steps],
      note: input.note ?? null,
      updatedAt,
    };
  });
}

/** 读最新计划上的「本轮计划」；没计划或没写过返回 null。 */
export function currentRoundPlan(db: LedgerDb, taskId: string): RoundPlan | null {
  const plan = latestPlan(db, taskId);
  return plan === null ? null : readRoundPlan(plan);
}

// ────────────────────────────────────────────────────────────────────────────
// 5) 对齐记录
// ────────────────────────────────────────────────────────────────────────────

/**
 * 记一条对齐结论（A.12 裁判的落点）。写 decisions 表一行：
 *   question = 「为什么这样做：<里程碑标题>」（固定前缀，whyWeDidThis 按它回查）
 *   answer   = note
 *   decided_by = 'system'
 *
 * 注意：decisions 表没有 aligned 列。aligned 在这里只做类型/取值校验，
 * 「对上了没」请由调用方写进 note（例如「对上了：…」/「跑偏了：…」），
 * 将来若加列，调用签名不用改。
 */
export function recordAlignment(db: LedgerDb, input: AlignmentRecord) {
  requireTask(db, input.taskId);
  if (typeof input.aligned !== "boolean") {
    throw new LedgerError("bad_alignment", "recordAlignment: aligned 必须是 boolean");
  }
  if (typeof input.note !== "string" || input.note.trim() === "") {
    throw new LedgerError("bad_alignment", "recordAlignment: note 不能为空");
  }
  const ms = getMilestone(db, input.milestoneId);
  if (ms === null || ms.task_id !== input.taskId) {
    throw new LedgerError(
      "milestone_not_found",
      `recordAlignment: 里程碑 ${input.milestoneId} 不属于任务 ${input.taskId}`,
    );
  }

  return recordDecision(db, {
    task_id: input.taskId,
    question: `${ALIGNMENT_QUESTION_PREFIX}${ms.title}`,
    answer: input.note,
    decided_by: "system",
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 6) 为什么这样做
// ────────────────────────────────────────────────────────────────────────────

/**
 * 回答「这个里程碑为什么这么做」：从 plans.why 与 decisions 里的对齐记录拼出来。
 *
 * - 优先取 plans 里 milestone_id 等于该里程碑的最新一行；没有就退回任务最新计划。
 * - 对齐记录按 question **精确等于**「为什么这样做：<该里程碑标题>」匹配，取最近 3 条；
 *   不能用子串匹配，否则「搬文件」会把「搬文件到归档」的记录也捎进来。
 * - 最多 WHY_ANSWER_LIMIT(=500) 字，超了截断加「…」。
 * - 什么都没有就明说查不到，不编。
 */
export function whyWeDidThis(
  db: LedgerDb,
  input: { taskId: string; milestoneId: string },
): string {
  const ms = getMilestone(db, input.milestoneId);
  if (ms === null || ms.task_id !== input.taskId) {
    return `查不到：任务 ${input.taskId} 下没有里程碑 ${input.milestoneId}`;
  }

  const plans = listPlans(db, input.taskId);
  const ownPlans = plans.filter((p) => p.milestone_id === input.milestoneId);
  const source =
    ownPlans.length > 0
      ? ownPlans[ownPlans.length - 1]
      : (latestPlan(db, input.taskId) ?? null);
  const planWhy = source?.why ?? null;

  const expectedQuestion = `${ALIGNMENT_QUESTION_PREFIX}${ms.title}`;
  const decisions = listDecisions(db, input.taskId).filter(
    (d) => d.question === expectedQuestion,
  );

  if ((planWhy === null || planWhy.trim() === "") && decisions.length === 0) {
    return `查不到「${ms.title}」的计划理由与对齐记录`;
  }

  const lines: string[] = [`里程碑 ${ms.seq}「${ms.title}」为什么这么做：`];
  if (planWhy !== null && planWhy.trim() !== "") {
    lines.push(`计划理由：${planWhy.trim()}`);
  }
  for (const d of decisions.slice(-3)) {
    lines.push(`对齐记录：${d.answer.trim()}`);
  }

  let out = lines.join("\n");
  if (out.length > WHY_ANSWER_LIMIT) out = `${out.slice(0, WHY_ANSWER_LIMIT - 1)}…`;
  return out;
}
