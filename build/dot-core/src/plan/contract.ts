/**
 * src/plan/contract.ts —— 长程任务契约（DesignAnything 的 task contract + controller）。
 *
 * 论文 arXiv:2610.24771 的核心思想：
 * 1. **任务契约**把约束和决策存在模型外面（alldot 的 tasks.declared_json 里）；
 * 2. **意图-执行图**把每个交付物绑定到产生它的步骤（alldot 的 steps + artifacts 已有）；
 * 3. **确定性控制器**检查输出类型/数量、找未完成交付物、指导下一轮。
 *
 * 本模块只做三件事：
 * - parseContract：从 declared 里解析契约（约束 + 交付物清单）
 * - checkContract：对照已完成的步骤/产物，检查约束满足率和交付完成率
 * - nextDeliverable：下一个该做的交付物（delivery loop 的决策依据）
 *
 * 不做的事：不改任务终态、不记账（那些归 dispatch/settle）。
 */

import { listSteps, getTask, getArtifact, type LedgerDb, type TaskRow } from "../ledger/index.ts";

// ────────────────────────────────────────────────────────────────────────────
// 契约类型
// ────────────────────────────────────────────────────────────────────────────

/** 一条事实性约束（可客观判定，对应论文的 "factual constraints"）。 */
export interface ContractConstraint {
  /** 约束的短名（例如 "角色身高"、"输出格式"）。 */
  id: string;
  /** 人类可读的描述。 */
  description: string;
  /**
   * 判定方式：
   * - "equal"：值必须完全相等（字符串/数字）
   * - "contains"：结果文本里必须包含这个子串
   * - "regex"：结果文本必须匹配这个正则
   * - "range"：数值必须在 [min, max] 区间
   * - "exists"：必须有这个文件/路径
   */
  check: "equal" | "contains" | "regex" | "range" | "exists";
  /** check 的参数。equal/contains/regex 用 value，range 用 min/max，exists 用 path。 */
  value?: string;
  min?: number;
  max?: number;
  path?: string;
  /** 违反时的严重度："hard" = 必须满足，"soft" = 尽量满足。 */
  severity: "hard" | "soft";
}

/** 一个交付物（对应论文的 deliverable）。 */
export interface ContractDeliverable {
  /** 交付物短名。 */
  id: string;
  /** 人类可读描述。 */
  description: string;
  /** 期望的产出类型："file" = 文件、"text" = 文本、"step" = 一次工具调用。 */
  type: "file" | "text" | "step";
  /** type="file" 时的期望路径（相对工作区）。 */
  path?: string;
  /** type="step" 时的期望工具名（例如 "files" / "practice"）。 */
  tool?: string;
  /** 完成判定（与 milestone 的 done_when 同格式）。 */
  done_when: string;
  /** 绑定到哪个里程碑（seq 号）。不填 = 不归任何里程碑。 */
  milestone_seq?: number;
}

/** 完整的任务契约。存在 tasks.declared_json 的 `contract` 字段里。 */
export interface TaskContract {
  /** 契约版本（将来改结构时用）。 */
  version: 1;
  /** 任务目标（一句话）。 */
  goal: string;
  /** 约束清单。 */
  constraints: ContractConstraint[];
  /** 交付物清单。 */
  deliverables: ContractDeliverable[];
}

// ────────────────────────────────────────────────────────────────────────────
// 解析
// ────────────────────────────────────────────────────────────────────────────

/**
 * 从任务的 declared_json 里解析契约。
 * 没有 contract 字段就返回 null（不是所有任务都需要契约）。
 */
export function parseContract(task: TaskRow): TaskContract | null {
  const raw = task.declared_json;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const contract = obj["contract"];
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) return null;

  const c = contract as Record<string, unknown>;
  const constraints = Array.isArray(c["constraints"])
    ? (c["constraints"] as ContractConstraint[]).filter(
        (x) => x !== null && typeof x === "object" && typeof x.id === "string",
      )
    : [];
  const deliverables = Array.isArray(c["deliverables"])
    ? (c["deliverables"] as ContractDeliverable[]).filter(
        (x) => x !== null && typeof x === "object" && typeof x.id === "string",
      )
    : [];

  return {
    version: 1,
    goal: typeof c["goal"] === "string" ? c["goal"] : "",
    constraints,
    deliverables,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 检查
// ────────────────────────────────────────────────────────────────────────────

export interface ConstraintCheckResult {
  constraintId: string;
  satisfied: boolean;
  reason: string;
  severity: "hard" | "soft";
  /** 约束定义本身有问题（如正则语法错），不参与满足率计算。 */
  configError: boolean;
}

export interface DeliverableCheckResult {
  deliverableId: string;
  completed: boolean;
  evidence: string;
  type: "file" | "text" | "step";
}

export interface ContractCheckReport {
  /** 硬约束满足率（0-1）。 */
  hardSatisfaction: number;
  /** 软约束满足率（0-1）。 */
  softSatisfaction: number;
  /** 交付完成率（0-1）。 */
  deliveryCompletion: number;
  constraints: ConstraintCheckResult[];
  deliverables: DeliverableCheckResult[];
  /** 未完成的交付物 id 列表。 */
  outstanding: string[];
}

/**
 * 对照已完成的步骤，检查契约。
 *
 * 检查逻辑（与论文的 deterministic controller 对齐）：
 * - 约束：按 check 类型检查步骤的 result artifact 文本
 * - 交付物：按 type 检查步骤里是否有对应的 file/text/step 产出
 */
export function checkContract(db: LedgerDb, taskId: string): ContractCheckReport | null {
  const task = getTask(db, taskId);
  if (task === null) return null;
  const contract = parseContract(task);
  if (contract === null) return null;

  // 当前里程碑的 seq：用于按 milestone_seq 圈定交付物范围
  let currentMilestoneSeq = Infinity; // 没有里程碑 = 全部在范围内
  if (task.milestone_id != null) {
    try {
      const msRow = db.prepare("SELECT seq FROM milestones WHERE id = ?").get(task.milestone_id) as { seq?: number } | undefined;
      if (msRow?.seq != null) currentMilestoneSeq = msRow.seq;
    } catch { /* 查不到就当全部在范围内 */ }
  }

  const steps = listSteps(db, taskId);
  // 收集文本分两份：
  // - resultText：只含成功步骤的 artifact 内容，用于约束判定（不会被工具名/错误文本误触发）
  // - allText：全量（含工具名+错误），用于交付物的 file 存在性检查
  const resultParts: string[] = [];
  const textParts: string[] = [];
  for (const s of steps) {
    textParts.push(`${s.tool} ${s.error ?? ""}`);
    if (s.result_ref != null) {
      try {
        const art = getArtifact(db, s.result_ref);
        if (art.found && art.content != null) {
          textParts.push(art.content);
          // 只有成功步骤的 artifact 才进约束判定文本池
          if (s.status === "succeeded") resultParts.push(art.content);
        }
      } catch { /* 读不到就跳过 */ }
    }
  }
  const allText = textParts.join("\n");
  const resultText = resultParts.join("\n");

  // ── 约束检查（基于 resultText，避免错误文本/工具名误触发） ──
  const constraintResults: ConstraintCheckResult[] = contract.constraints.map((c) => {
    let satisfied = false;
    let reason = "";
    let configError = false;

    switch (c.check) {
      case "contains":
        satisfied = c.value !== undefined && resultText.includes(c.value);
        reason = satisfied ? `结果文本包含「${c.value}」` : `结果文本里没找到「${c.value}」`;
        break;
      case "regex":
        try {
          const re = new RegExp(c.value ?? "");
          satisfied = re.test(resultText);
          reason = satisfied ? "匹配正则" : `不匹配 /${c.value}/`;
        } catch {
          reason = `正则写错了：/${c.value}/`;
          configError = true;
        }
        break;
      case "equal":
        // 语义是「某个结果值与 value 完全相等」，按行比对而不是全量拼接文本
        satisfied = c.value !== undefined && resultText.split("\n").some((line) => line.trim() === c.value!.trim());
        reason = satisfied ? `结果中有一行等于「${c.value}」` : `结果里没有一行等于「${c.value}」`;
        break;
      case "range": {
        // 只从结果文本提取数字（工具名/错误文本里的数字不算），取最后一个（最接近最终结果）
        const nums = resultText.match(/-?\d+(?:\.\d+)?/g) ?? [];
        const val = nums.length > 0 ? Number(nums[nums.length - 1]) : NaN;
        satisfied = !Number.isNaN(val) && val >= (c.min ?? -Infinity) && val <= (c.max ?? Infinity);
        reason = satisfied ? `值 ${val} 在区间内` : `值 ${val} 不在 [${c.min}, ${c.max}]`;
        break;
      }
      case "exists":
        // 检查结果文本里有没有提到这个路径（不查文件系统，但至少不被错误文本误触发）
        satisfied = c.path !== undefined && resultText.includes(c.path);
        reason = satisfied ? `结果中找到路径 ${c.path}` : `结果里没有路径 ${c.path}`;
        break;
    }

    return { constraintId: c.id, satisfied, reason, severity: c.severity, configError };
  });

  const hardConstraints = constraintResults.filter((r) => r.severity === "hard" && !r.configError);
  const softConstraints = constraintResults.filter((r) => r.severity === "soft" && !r.configError);
  const hardSatisfaction =
    hardConstraints.length === 0 ? 1 : hardConstraints.filter((r) => r.satisfied).length / hardConstraints.length;
  const softSatisfaction =
    softConstraints.length === 0 ? 1 : softConstraints.filter((r) => r.satisfied).length / softConstraints.length;

  // ── 交付物检查（milestone_seq 按当前里程碑圈定范围） ──
  const inScopeDeliverables = contract.deliverables.filter(
    (d) => d.milestone_seq === undefined || d.milestone_seq <= currentMilestoneSeq,
  );
  const deliverableResults: DeliverableCheckResult[] = inScopeDeliverables.map((d) => {
    let completed = false;
    let evidence = "";

    if (d.type === "step") {
      // 只认成功步骤，失败/挂起的不算
      const match = steps.find((s) => s.status === "succeeded" && (d.tool === undefined || s.tool === d.tool));
      completed = match !== undefined;
      evidence = completed ? `成功步骤 ${match!.id}（${match!.tool}）` : `没有 ${d.tool ?? "对应"} 工具的成功步骤`;
    } else if (d.type === "file") {
      // 只看成功步骤的 artifact 是否提到这个路径
      completed = d.path !== undefined && resultText.includes(d.path);
      evidence = completed ? `结果文本提到 ${d.path}` : `没有 ${d.path} 的产出`;
    } else {
      // text：成功步骤有实际文本产出才算（不是任一成功步骤就让所有 text 交付物都完成）
      completed = resultText.trim().length > 0;
      evidence = completed ? "有成功的步骤产出文本" : "没有成功的步骤产出文本";
    }

    return { deliverableId: d.id, completed, evidence, type: d.type };
  });

  const outstanding = deliverableResults.filter((r) => !r.completed).map((r) => r.deliverableId);
  const deliveryCompletion =
    deliverableResults.length === 0
      ? 1
      : deliverableResults.filter((r) => r.completed).length / deliverableResults.length;

  return {
    hardSatisfaction,
    softSatisfaction,
    deliveryCompletion,
    constraints: constraintResults,
    deliverables: deliverableResults,
    outstanding,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Delivery Controller（论文的 deterministic controller）
// ────────────────────────────────────────────────────────────────────────────

export interface DeliveryAction {
  /** 下一步该做什么。 */
  action: "continue" | "fix_constraint" | "produce_deliverable" | "done";
  /** 要做哪个交付物（action="produce_deliverable" 时）。 */
  deliverableId?: string;
  /** 要修哪条约束（action="fix_constraint" 时）。 */
  constraintId?: string;
  /** 给工人的一句话指导。 */
  guidance: string;
}

/**
 * 根据契约检查结果，决定下一步做什么。
 * 这是 delivery loop 的核心：不改任务状态，只出指导。
 */
export function nextDeliverable(db: LedgerDb, taskId: string): DeliveryAction | null {
  const report = checkContract(db, taskId);
  if (report === null) return null;

  // 1. 硬约束没满足 → 先修约束（跳过定义本身有错的约束，避免死循环）
  const violatedHard = report.constraints.filter((r) => r.severity === "hard" && !r.satisfied && !r.configError);
  if (violatedHard.length > 0) {
    const first = violatedHard[0]!;
    return {
      action: "fix_constraint",
      constraintId: first.constraintId,
      guidance: `先修硬约束「${first.constraintId}」：${first.reason}。修完再做后面的。`,
    };
  }

  // 2. 有未完成的交付物 → 做下一个
  if (report.outstanding.length > 0) {
    const nextId = report.outstanding[0];
    return {
      action: "produce_deliverable",
      deliverableId: nextId,
      guidance: `下一个交付物：${nextId}。做完这个再看剩下的。`,
    };
  }

  // 3. 都完成了 → 收
  return {
    action: "done",
    guidance: `所有交付物都完成了（硬约束满足率 ${Math.round(report.hardSatisfaction * 100)}%，交付完成率 ${Math.round(report.deliveryCompletion * 100)}%）。`,
  };
}
