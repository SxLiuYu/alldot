/**
 * src/plan/auto-plan.ts —— 从任务描述自动拆里程碑（planTask 的前置）。
 *
 * 2026-11-26 用户要求：「planTask 自动拆里程碑，要从任务描述自动生成」。
 *
 * 思路：任务创建后，如果 declared 里没写 milestones，就用模型从 intent 里
 * 拆出 3-5 个里程碑。模型回 JSON，解析后调 planTask 建里程碑。
 *
 * 模型调用走注入的 complete（生产由 dispatch/index.ts 注入本机池），
 * 本文件不读环境变量、不读 key、不发请求。
 */

import { getTask, listPlans, type LedgerDb, type TaskRow } from "../ledger/index.ts";
import { planTask, type MilestoneInput } from "./index.ts";

/** 模型调用：给提示词，回正文。 */
export type PlanComplete = (prompt: string) => Promise<string>;

export interface AutoPlanResult {
  ok: boolean;
  milestones: MilestoneInput[];
  reason: string;
}

const PLAN_PROMPT = `你是一个任务拆解器。把下面的任务拆成 3-5 个可验收的里程碑。

要求：
1. 每个里程碑有 title（一句话）和 done_when（验收条件，写清楚怎么算做完）。
2. 里程碑按先后顺序排列，前面的做完才能做后面的。
3. 不要拆太细（超过 5 个就合并），也不要太粗（少于 3 个就再拆）。
4. 只输出 JSON 数组，不要其他文字。

格式：
[{"title": "...", "done_when": "..."}, ...]

任务：`;

/**
 * 从任务描述自动拆里程碑。
 * 已有计划的任务直接跳过（planTask 只做首拆）。
 */
export async function autoPlan(
  db: LedgerDb,
  taskId: string,
  complete: PlanComplete,
): Promise<AutoPlanResult> {
  const task = getTask(db, taskId);
  if (task === null) return { ok: false, milestones: [], reason: "任务不存在" };

  // 已有计划就跳过
  const existing = listPlans(db, taskId);
  if (existing.length > 0) return { ok: false, milestones: [], reason: "已有计划，跳过" };

  const intent = task.intent;
  if (typeof intent !== "string" || intent.trim() === "") {
    return { ok: false, milestones: [], reason: "任务没有描述，拆不了" };
  }

  // 调模型拆里程碑
  let raw: string;
  try {
    raw = await complete(PLAN_PROMPT + intent);
  } catch (err) {
    return { ok: false, milestones: [], reason: `模型调用失败：${(err as Error).message}` };
  }

  // 解析 JSON（容忍模型包 ``` 围栏）
  let jsonText = raw.trim();
  const fenced = /```[A-Za-z]*\n([\s\S]*?)\n```/.exec(jsonText);
  if (fenced !== null) jsonText = fenced[1]?.trim() ?? "";
  // 找第一个 [ 到最后一个 ]
  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, milestones: [], reason: `模型回的不是合法 JSON：${raw.slice(0, 200)}` };
  }

  if (!Array.isArray(parsed) || parsed.length < 2) {
    return { ok: false, milestones: [], reason: `模型回的里程碑数量不对（${Array.isArray(parsed) ? parsed.length : "不是数组"}）` };
  }

  const milestones: MilestoneInput[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj["title"] === "string" ? obj["title"].trim() : "";
    const doneWhen = typeof obj["done_when"] === "string" ? obj["done_when"].trim() : "";
    if (title !== "" && doneWhen !== "") {
      milestones.push({ title, done_when: doneWhen });
    }
  }

  if (milestones.length < 2) {
    return { ok: false, milestones, reason: `解析出来的里程碑太少（${milestones.length}）` };
  }

  // 调 planTask 建里程碑
  try {
    planTask(db, {
      taskId,
      goal: intent.slice(0, 200),
      why: "自动拆解（auto-plan）",
      milestones,
    });
    return { ok: true, milestones, reason: `自动拆了 ${milestones.length} 个里程碑` };
  } catch (err) {
    return { ok: false, milestones, reason: `planTask 失败：${(err as Error).message}` };
  }
}
