/**
 * src/drift/index.ts —— 跑偏裁判（方案第 3 步 B）。
 *
 * 一句话：每段收尾时问一次模型「这一段还在朝任务意图走吗」，给出
 * on_track / off_track / unclear，offs軌 时把结论落到账本上。
 *
 * 三条纪律：
 * 1. **模型是注入的**。本文件不直连任何模型或网络：调模型走 `deps.complete`，
 *    测试里给假实现，生产由入口（index.ts）接到模型池。
 * 2. **拿不准就是 unclear，绝不假装 on_track**。没有模型、模型抛错、模型回的话
 *    解析不出三档之一，一律退回 unclear 并把原因写进 why ——「没判」不能长得像
 *    「没跑偏」，那等于裁判自己失职还报喜。
 * 3. **判定不改终态**。off_track 只写 tasks.state_reason 并追加一条 `drift_verdict`
 *    事件；任务还是 done 就是 done。是否要失败/重排由人或其他触发点决定。
 *
 * 原料（任务意图 / 当前里程碑标题与完成条件 / 已结束步骤摘要）由
 * collectDriftInput 从账本取；步骤太多就先截断（保留最近的），截断的事实会写进
 * 提示词和返回值，不静默丢。
 */

import {
  appendEvent,
  getArtifact,
  getMilestone,
  getTask,
  inTransaction,
  listMilestones,
  listSteps,
  nowIso,
  type LedgerDb,
} from "../ledger/index.ts";

/** 三档结论。名字即契约：派发器与测试按字符串判断。 */
export const DRIFT_VERDICTS = ["on_track", "off_track", "unclear"] as const;
export type DriftVerdict = (typeof DRIFT_VERDICTS)[number];

/** 喂给模型的步骤最多几条（保留最近的）。 */
export const DRIFT_MAX_STEPS = 12;
/** 单条步骤摘要最多多少字（截断后总长度天然有界：12 条 × 161 字）。 */
export const DRIFT_STEP_CHARS = 160;
/** why / suggest 的字数上限（落库、进状态页都不该长篇）。 */
export const DRIFT_TEXT_LIMIT = 200;

/** 「已结束」的步骤状态（与 task-view / stage-summary 的终态口径一致）。 */
const ENDED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "skipped",
  "rolled_back",
]);

/** 单条步骤的原料。summary 是结果明细的前缀，取不到时是可读说明。 */
export interface DriftStepSummary {
  seq: number | null;
  status: string;
  tool: string | null;
  summary: string;
}

/** 裁判的输入：任务意图 + 里程碑标题/完成条件 + 已结束步骤摘要。 */
export interface DriftInput {
  intent: string;
  milestoneTitle: string;
  doneWhen: string;
  stepSummaries: DriftStepSummary[];
  /** 本段小结（如果阶段小结已经写了）。没有就省略。 */
  milestoneSummary?: string | null;
  /**
   * 步骤原料从哪来（collectDriftInput 填，手工构造可省略）：
   * - milestone：步骤上带本里程碑 id（最准）；
   * - recent：生产中步骤没标里程碑（src/ledger/steps.ts:151 落 null），退回看任务最近步骤；
   * - none：一条已结束步骤都没有。
   */
  stepsSource?: "milestone" | "recent" | "none";
}

export interface DriftJudgeDeps {
  /** 注入的模型调用：给提示词，拿回原文。不给 = 没有模型，判 unclear。 */
  complete?: (prompt: string) => Promise<string>;
}

export interface DriftResult {
  verdict: DriftVerdict;
  why: string;
  suggest: string;
  /** 这次模型调用有没有成功返回（读不懂也算调过）。false 时 verdict 一定是 unclear。 */
  calledModel: boolean;
  /** 步骤原料有没有被截断（条数或字数）。 */
  truncated: boolean;
  /** 因为截断而没进提示词的步骤数。 */
  droppedSteps: number;
}

export interface DriftCheckResult extends DriftResult {
  taskId: string;
  milestoneId: string;
  /** off_track 时有没有把结论写进 tasks.state_reason。 */
  reasonRecorded: boolean;
  /** 这次落的事件号；写事件失败时是 null 并带 recordError。 */
  eventSeq: number | null;
}

export interface DriftCheckDeps {
  db: LedgerDb;
  complete?: (prompt: string) => Promise<string>;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : `${t.slice(0, limit)}…`;
}

/** 取一条步骤结果明细的前缀；取不到给可读说明，别在原料里留空洞。 */
function resultPreview(db: LedgerDb, resultRef: string | null): string {
  if (resultRef === null || resultRef.trim() === "") return "（无明细）";
  const got = getArtifact(db, resultRef);
  if (!got.found) return "（明细已回收）";
  return clip(oneLine(got.content), DRIFT_STEP_CHARS);
}

export interface PreparedSteps {
  steps: DriftStepSummary[];
  truncated: boolean;
  /** 没进提示词的步骤条数（条数超限）。 */
  droppedSteps: number;
}

/**
 * 把步骤原料压到能喂模型的规模：保留最近 DRIFT_MAX_STEPS 条，每条摘要截到
 * DRIFT_STEP_CHARS 字。两种削减都把 truncated 标成 true，调用方据此在提示词和
 * 返回值里说明「有省略」，不静默丢。
 */
export function prepareStepSummaries(input: DriftStepSummary[]): PreparedSteps {
  const total = input.length;
  let kept = total > DRIFT_MAX_STEPS ? input.slice(total - DRIFT_MAX_STEPS) : input.slice();
  const dropped = total - kept.length;
  let truncated = dropped > 0;

  kept = kept.map((s) => {
    if (s.summary.length <= DRIFT_STEP_CHARS) return s;
    truncated = true;
    return { ...s, summary: `${s.summary.slice(0, DRIFT_STEP_CHARS)}…` };
  });

  return { steps: kept, truncated, droppedSteps: dropped };
}

/** 拼给模型看的提示词。导出来是为了测试能直接断言截断结果。 */
export function buildDriftPrompt(input: DriftInput, prepared?: PreparedSteps): string {
  const prep = prepared ?? prepareStepSummaries(input.stepSummaries);
  const head = [
    "【跑偏裁判】判断这一段的工作是否还在朝任务意图走。只依据下面给出的原料，不要编造。",
    `任务意图：${oneLine(input.intent)}`,
    `当前里程碑：${oneLine(input.milestoneTitle)}（完成条件：${oneLine(input.doneWhen)}）`,
  ];
  if (typeof input.milestoneSummary === "string" && input.milestoneSummary.trim() !== "") {
    head.push(`本段小结：${clip(oneLine(input.milestoneSummary), DRIFT_TEXT_LIMIT)}`);
  }
  if (input.stepsSource === "recent") {
    head.push(
      `已结束步骤（任务最近 ${prep.steps.length} 步；这些步骤没标里程碑，按任务层面看` +
        `${prep.droppedSteps > 0 ? `，早先 ${prep.droppedSteps} 步已省略` : ""}）：`,
    );
  } else if (prep.droppedSteps > 0) {
    head.push(
      `已结束步骤（共 ${input.stepSummaries.length} 步，只列最近 ${prep.steps.length} 步，早先 ${prep.droppedSteps} 步已省略）：`,
    );
  } else {
    head.push(`已结束步骤（共 ${prep.steps.length} 步）：`);
  }
  const body = prep.steps.map(
    (s, i) => `${i + 1}. 状态=${s.status}｜工具=${s.tool ?? "无"}｜结果：${oneLine(s.summary)}`,
  );
  const tail = [
    "只输出一行 JSON，不要任何别的文字：",
    '{"verdict":"on_track|off_track|unclear","why":"不超过 80 字，指出依据","suggest":"不超过 80 字；on_track 时给空字符串"}',
    "标准：on_track=步骤确实在推进这个里程碑且没跑偏；off_track=方向明显偏离任务意图或完成条件；unclear=原料不够或看不出来。拿不准给 unclear，不要猜 on_track。",
  ];
  return [...head, ...body, ...tail].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从模型原文里抠 JSON 对象：容忍 ```json 围栏和前后废话。 */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把模型原文解析成三档之一。解析不出返回 null（调用方据此退回 unclear）。
 * 先按 JSON 读，读不出来再按关键字兜底；关键字也认不出就是 null，不猜。
 */
export function parseDriftVerdict(raw: unknown): { verdict: DriftVerdict; why: string; suggest: string } | null {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const obj = tryParseJsonObject(text);
  if (obj !== null) {
    const rawVerdict = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
    if ((DRIFT_VERDICTS as readonly string[]).includes(rawVerdict)) {
      return {
        verdict: rawVerdict as DriftVerdict,
        why: clip(typeof obj.why === "string" ? obj.why : "", DRIFT_TEXT_LIMIT),
        suggest: clip(typeof obj.suggest === "string" ? obj.suggest : "", DRIFT_TEXT_LIMIT),
      };
    }
  }

  const low = text.toLowerCase();
  const verdict: DriftVerdict | null = low.includes("off_track")
    ? "off_track"
    : low.includes("unclear")
      ? "unclear"
      : low.includes("on_track")
        ? "on_track"
        : null;
  if (verdict === null) return null;
  return { verdict, why: clip(oneLine(text), DRIFT_TEXT_LIMIT), suggest: "" };
}

/**
 * 判一次。永不抛：没有模型、没有原料、模型抛错、返回读不懂都退成 unclear 并写清原因。
 * 只有模型真的返回了（哪怕读不懂）calledModel 才是 true；三档里只有解析成功
 * 才会出现 on_track / off_track，绝不把「没判」说成「没跑偏」。
 */
export async function judgeDrift(deps: DriftJudgeDeps, input: DriftInput): Promise<DriftResult> {
  const prepared = prepareStepSummaries(input.stepSummaries);
  const base = {
    calledModel: false,
    truncated: prepared.truncated,
    droppedSteps: prepared.droppedSteps,
  };

  if (deps.complete === undefined) {
    return { ...base, verdict: "unclear", why: "没有可用的模型调用，判不了跑偏", suggest: "" };
  }

  // 零原料闸：一条已结束步骤都没有时不喂模型，直接 unclear。否则模型面对空表还能
  // 一本正经地回 on_track，等于「没判」冒充「没跑偏」（评审 2026-11-25 指出）。
  if (prepared.steps.length === 0) {
    return {
      ...base,
      verdict: "unclear",
      why: "没有已结束的步骤原料，判不了跑偏（不猜 on_track）",
      suggest: "",
    };
  }

  const prompt = buildDriftPrompt(input, prepared);
  let raw: string;
  try {
    raw = await deps.complete(prompt);
  } catch (err) {
    return { ...base, verdict: "unclear", why: `模型调用失败：${(err as Error).message}`, suggest: "" };
  }

  const parsed = parseDriftVerdict(raw);
  if (parsed === null) {
    const preview = clip(oneLine(typeof raw === "string" ? raw : String(raw ?? "")), 80) || "（空）";
    return { ...base, calledModel: true, verdict: "unclear", why: `模型返回读不懂：${preview}`, suggest: "" };
  }

  return { ...base, calledModel: true, ...parsed };
}

/**
 * 从账本取裁判原料。任务或里程碑不存在（或里程碑不属于该任务）返回 null ——
 * 这是调用方的编程错误，不是模型能自愈的事。
 *
 * 两个来源，按优先级：
 * 1. 步骤上带本里程碑 id（steps.milestone_id = 本段）—— 最准；
 * 2. 生产里没人给 beginStep 传 milestone_id（src/hands/hand.ts:596-606、
 *    src/hands/builtin.ts:331-341 都不传，src/ledger/steps.ts:151 落 null），
 *    按里程碑过滤必然是 0 步。这时退回「任务最近已结束步骤」（stepsSource=recent），
 *    并在提示词里写明「没标里程碑，按任务层面看」——不静默按 0 步判。
 *    里程碑刚收尾，最近这些步骤就是这一段刚做完的，方向对不对仍可判。
 * 都没有就是 none，judgeDrift 的零原料闸会退 unclear。
 */
/**
 * 本段之前最近一次「已结束」的里程碑时刻（ISO 字符串）。
 * 用来给「退回任务最近步骤」那条路卡下界，避免拿上一段的步骤判这一段。
 */
function latestMilestoneEndBefore(db: LedgerDb, taskId: string, seq: number): string | null {
  const ended = listMilestones(db, taskId)
    .filter((m) => m.seq < seq && typeof m.ended_at === "string" && m.ended_at !== "")
    .map((m) => m.ended_at as string)
    .sort();
  return ended.length === 0 ? null : (ended[ended.length - 1] as string);
}

export function collectDriftInput(db: LedgerDb, taskId: string, milestoneId: string): DriftInput | null {
  const task = getTask(db, taskId);
  const milestone = getMilestone(db, milestoneId);
  if (task === null || milestone === null || milestone.task_id !== taskId) return null;

  const ended = listSteps(db, taskId).filter((s) => ENDED_STATUSES.has(s.status));
  const attributed = ended.filter((s) => s.milestone_id === milestoneId);

  // 退回「任务最近步骤」时的下界：上一段结束的时刻。
  // 2026-11-25 探针实测：判第 2 段时喂了 12 条，其中 10 条来自第 1 段——等于拿上一段的证据
  // 判这一段的走向。按 milestones.ended_at 卡下界之后，只剩本段开始之后的步骤。
  const prevEndedAt = latestMilestoneEndBefore(db, taskId, milestone.seq);
  const recentPool =
    prevEndedAt === null
      ? ended
      : ended.filter((s) => typeof s.started_at === "string" && s.started_at !== "" && s.started_at >= prevEndedAt);

  const stepsSource: "milestone" | "recent" | "none" =
    attributed.length > 0 ? "milestone" : recentPool.length > 0 ? "recent" : "none";
  const picked = attributed.length > 0 ? attributed : recentPool;

  const intent = typeof task.restated === "string" && task.restated.trim() !== "" ? task.restated : task.intent;
  return {
    intent,
    milestoneTitle: milestone.title,
    doneWhen: milestone.done_when,
    milestoneSummary: milestone.summary,
    stepsSource,
    stepSummaries: picked.map((s) => ({
      seq: s.seq,
      status: s.status,
      tool: s.tool,
      summary: resultPreview(db, s.result_ref),
    })),
  };
}

export interface RecordDriftInput {
  taskId: string;
  milestoneId: string;
  result: DriftResult;
}

/**
 * 把判定落到账本：**只改 state_reason、不动 state**，再追加一条 `drift_verdict` 事件。
 *
 * 为什么不走 setTaskState：它会再写一条 task_state_changed（from==to），把事件链
 * 弄脏（src/plan/index.ts:16 同一个理由）。所以这里像 plan 的 moveTaskPointers 一样
 * 直接 UPDATE 原因列，并在同一个事务里追加专用事件。
 *
 * 为什么只在 off_track 时改 state_reason：on_track / unclear 不该盖掉任务本来
 * 的原因（比如「推进到下一段」），否则人看一眼状态页会看不出任务到底怎么了。
 */
export function recordDriftVerdict(db: LedgerDb, input: RecordDriftInput): DriftCheckResult {
  const { taskId, milestoneId, result } = input;
  return inTransaction(db, () => {
    const task = getTask(db, taskId);
    let reasonRecorded = false;
    if (task !== null && result.verdict === "off_track") {
      db.prepare("UPDATE tasks SET state_reason = ?, updated_at = ? WHERE id = ?").run(
        `跑偏（drift=off_track）：${result.why}`,
        nowIso(),
        taskId,
      );
      reasonRecorded = true;
    }
    const event = appendEvent(db, {
      task_id: taskId,
      type: "drift_verdict",
      payload: {
        task_id: taskId,
        milestone_id: milestoneId,
        verdict: result.verdict,
        why: result.why,
        suggest: result.suggest,
        called_model: result.calledModel,
        truncated: result.truncated,
        dropped_steps: result.droppedSteps,
        reason_recorded: reasonRecorded,
      },
    });
    return {
      ...result,
      taskId,
      milestoneId,
      reasonRecorded,
      eventSeq: event.seq,
    };
  });
}

/**
 * 生产入口用的一步式：取原料 → 判 → 落账。任务/里程碑不存在时返回 null
 * （after-settle 据此写 skipped，不编结论）。
 */
export async function runDriftCheck(
  deps: DriftCheckDeps,
  input: { taskId: string; milestoneId: string },
): Promise<DriftCheckResult | null> {
  const data = collectDriftInput(deps.db, input.taskId, input.milestoneId);
  if (data === null) return null;
  const result = await judgeDrift({ complete: deps.complete }, data);
  const recorded = recordDriftVerdict(deps.db, {
    taskId: input.taskId,
    milestoneId: input.milestoneId,
    result,
  });
  const log = deps.logger ?? (() => {});
  log(
    result.verdict === "off_track" ? "warn" : "info",
    `任务 ${input.taskId} 里程碑 ${input.milestoneId} 跑偏判定=${result.verdict}：${result.why}`,
  );
  return recorded;
}
