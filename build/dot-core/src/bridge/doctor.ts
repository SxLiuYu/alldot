/**
 * src/bridge/doctor.ts —— 体检结果的人话版本（P1，docs/内部-P1P3-接口契约.md 第 1 节）。
 *
 * 数据源只有一处：keeper 写的 keep.json（rows + components），加上桥运行期记住的配置错误。
 * 这里不做任何探针：探针是 keeper 的事，桥只把已经算好的结论翻译成网页要的形状。
 *
 * 「挡不挡派单」是一张写死的表，不猜：
 *   只有网关不通、账本不可写、桥本身没起这三类挡派单，其余一律算警告。
 *   账本那行不给一键修（写不进去不是点一下就能好的），所以 fix 为 null。
 */

import type { HealthLevel, KeepView } from "./keep.ts";
import { normalizeLevel } from "./keep.ts";

export type DoctorState = "green" | "yellow" | "red";

export interface DoctorItem {
  id: string;
  title: string;
  state: DoctorState;
  blocks: boolean;
  detail: string;
  fix: string | null;
  fixLabel: string | null;
}

export interface DoctorConfigError {
  path: string;
  message: string;
}

export interface DoctorPayload {
  ok: true;
  overall: DoctorState;
  updatedAt: string | null;
  blocked: boolean;
  items: DoctorItem[];
  configError: DoctorConfigError | null;
}

interface RowRule {
  /** 这一行挡不挡派单。 */
  blocks: boolean;
  /** 一键修的动作 id；null = 不能一键修。 */
  fix: string | null;
  fixLabel: string | null;
}

/**
 * 行 id → 是否挡派单 + 可执行动作。
 * 挡派单的只有三项（任务书原文）：网关不通、账本不可写、桥本身没起。
 */
export const DOCTOR_ROW_RULES: Record<string, RowRule> = {
  gateway: { blocks: true, fix: "start_gateway", fixLabel: "起网关" },
  ledger: { blocks: true, fix: null, fixLabel: null },
  bridge: { blocks: true, fix: "start_bridge", fixLabel: "起桥" },
  // 下面都是警告，能一键拉的给按钮。
  windowsMcp: { blocks: false, fix: "start_windows_mcp", fixLabel: "拉起 Windows-MCP" },
  playwright: { blocks: false, fix: "start_playwright", fixLabel: "拉起 Playwright" },
  cleanBrowser: { blocks: false, fix: "start_clean_browser", fixLabel: "拉起干净浏览器" },
  wechat: { blocks: false, fix: "start_wechat", fixLabel: "拉起微信手" },
  disk: { blocks: false, fix: "prune_artifacts", fixLabel: "回收旧文件" },
  // 明确不给动作的：模型池/账户探针 keeper 从不代拉，脸由人自己开，备份删不删由人定。
  modelPool: { blocks: false, fix: null, fixLabel: null },
  dotCore: { blocks: false, fix: null, fixLabel: null },
  gateVerify: { blocks: false, fix: null, fixLabel: null },
  dsbot: { blocks: false, fix: null, fixLabel: null },
  backups: { blocks: false, fix: null, fixLabel: null },
  balance: { blocks: false, fix: null, fixLabel: null },
  reloadRequest: { blocks: false, fix: null, fixLabel: null },
  keeperTask: { blocks: false, fix: null, fixLabel: null },
};

function doctorState(level: HealthLevel): DoctorState {
  if (level === "green") return "green";
  if (level === "red") return "red";
  // grey（没信号/没跑过）按警告处理：没有证据不能挡人干活。
  return "yellow";
}

interface RawRow {
  id: string;
  title: string;
  state: DoctorState;
  detail: string;
}

function rawRows(view: KeepView): RawRow[] {
  const out: RawRow[] = [];
  const seen = new Set<string>();
  const raw = view.raw;
  const rows =
    raw !== null && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).rows)
      ? ((raw as Record<string, unknown>).rows as unknown[])
      : [];
  for (const item of rows) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id.trim() !== "" ? rec.id.trim() : null;
    if (id === null) continue;
    seen.add(id);
    out.push({
      id,
      title: typeof rec.title === "string" && rec.title.trim() !== "" ? rec.title.trim() : id,
      state: doctorState(normalizeLevel(rec.state)),
      detail: typeof rec.detail === "string" ? rec.detail : "",
    });
  }
  // rows 缺项时用 components 兜底（两者是同一批探针的两种落法）。
  for (const component of view.components) {
    if (seen.has(component.name)) continue;
    seen.add(component.name);
    out.push({
      id: component.name,
      title: component.name,
      state: doctorState(component.level),
      detail: component.note ?? "",
    });
  }
  return out;
}

/** keep.json 读不到时也要给一张能看的体检单：一行红，说清为什么读不到。 */
function keeperRow(view: KeepView): DoctorItem {
  return {
    id: "keeper",
    title: "巡检状态",
    state: "red",
    blocks: false,
    detail: view.error ?? "keep.json 读不到",
    fix: null,
    fixLabel: null,
  };
}

export function buildDoctor(
  view: KeepView,
  configError: DoctorConfigError | null = null,
  rawOverall?: unknown,
): DoctorPayload {
  const items: DoctorItem[] = [];
  if (!view.ok) {
    items.push(keeperRow(view));
  } else {
    for (const row of rawRows(view)) {
      const rule = DOCTOR_ROW_RULES[row.id] ?? { blocks: false, fix: null, fixLabel: null };
      items.push({
        id: row.id,
        title: row.title,
        state: row.state,
        blocks: rule.blocks,
        detail: row.detail,
        fix: rule.fix,
        fixLabel: rule.fixLabel,
      });
    }
    if (items.length === 0) items.push(keeperRow(view));
  }

  const blocked = items.some((item) => item.blocks && item.state !== "green");
  const overall = overallOf(items, rawOverall);
  return {
    ok: true,
    overall,
    updatedAt: view.updatedAt,
    blocked,
    items,
    configError,
  };
}

function overallOf(items: DoctorItem[], rawOverall: unknown): DoctorState {
  if (rawOverall !== undefined && rawOverall !== null) {
    const level = normalizeLevel(rawOverall);
    if (level === "green" || level === "red") return level;
    if (level === "yellow") return "yellow";
  }
  if (items.some((item) => item.state === "red")) return "red";
  if (items.some((item) => item.state === "yellow")) return "yellow";
  return "green";
}
