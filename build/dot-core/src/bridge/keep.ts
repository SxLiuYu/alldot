/**
 * src/bridge/keep.ts —— 读 keeper 的巡检状态（B.6、B.7）。
 *
 * 为什么单独一个模块：状态页顶部那行「盘／备份／artifacts／snapshots／探针」必须能显示，
 * 而盘紧时账本恰好写不进。这份状态由 keeper.ps1 独占写，桥只读，不经过账本。
 *
 * keep.json 的字段在方案里还是「拟新增」，方案只钉了语义没钉 JSON 形状，所以这里按
 * 宽松解析写：同时认 snake_case / camelCase，认 state 字符串也认布尔；认不出来就显示
 * 「未知」，绝不编数字。
 */

import { readFileSync } from "node:fs";

export type HealthLevel = "green" | "yellow" | "red" | "grey";

export interface KeepBalanceEntry {
  level: HealthLevel;
  note: string | null;
}

export interface KeepComponent {
  name: string;
  level: HealthLevel;
  note: string | null;
}

export interface KeepView {
  ok: boolean;
  path: string;
  error: string | null;
  updatedAt: string | null;
  /** 盘剩余（MB）；读不到为 null。 */
  diskFreeMb: number | null;
  diskLevel: HealthLevel;
  diskNote: string | null;
  backupsBytes: number | null;
  artifactsBytes: number | null;
  snapshotsBytes: number | null;
  balance: Record<"cheap" | "balanced" | "strong", KeepBalanceEntry>;
  /** 探针最后一轮时间，状态页展示成「10:30」。 */
  probedAt: string | null;
  /** keeper 自己报的组件（ds-bot 脸、Windows-MCP、口闸……）。 */
  components: KeepComponent[];
  /** `paused_disk` 之类；null = 没置位。 */
  admission: string | null;
  /** keeper 自己写好的顶部一行（keep.json 的 `line`）；没有时由 keepHeaderLine 拼。 */
  line: string | null;
  raw: unknown;
}

const UNKNOWN_BALANCE: KeepBalanceEntry = { level: "grey", note: "未见巡检" };

export function emptyKeepView(path: string, error: string | null = null): KeepView {
  return {
    ok: false,
    path,
    error,
    updatedAt: null,
    diskFreeMb: null,
    diskLevel: "grey",
    diskNote: null,
    backupsBytes: null,
    artifactsBytes: null,
    snapshotsBytes: null,
    balance: { cheap: UNKNOWN_BALANCE, balanced: UNKNOWN_BALANCE, strong: UNKNOWN_BALANCE },
    probedAt: null,
    components: [],
    admission: null,
    line: null,
    raw: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

export function normalizeLevel(value: unknown): HealthLevel {
  if (typeof value === "boolean") return value ? "green" : "red";
  // 旧形状的 balance 条目用 HTTP 码当 status（402/429/401）；按语义归色。
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 200 && value < 300) return "green";
    if (value === 429) return "yellow";
    if (value >= 400) return "red";
    return "grey";
  }
  const s = str(value)?.toLowerCase() ?? "";
  if (["green", "ok", "healthy", "up", "pass", "good"].includes(s)) return "green";
  if (["yellow", "warn", "warning", "degraded", "slow"].includes(s)) return "yellow";
  if (["red", "bad", "down", "fail", "failed", "error", "paused"].includes(s)) return "red";
  return "grey";
}

function levelOf(record: Record<string, unknown> | null): HealthLevel {
  if (record === null) return "grey";
  for (const key of ["level", "state", "status", "health"]) {
    if (record[key] !== undefined) return normalizeLevel(record[key]);
  }
  return "grey";
}

function noteOf(record: Record<string, unknown> | null): string | null {
  if (record === null) return null;
  for (const key of ["note", "reason", "message", "detail", "error"]) {
    const s = str(record[key]);
    if (s !== null) return s;
  }
  // 更早的探针形状把响应正文放在 body（可能是长 JSON），截短当说明。
  const body = str(record.body);
  if (body !== null) return body.length > 120 ? `${body.slice(0, 120)}…` : body;
  return null;
}

/** 盘剩余：认 free_mb / freeMb / free_gb / freeGb / free_bytes。 */
function readDiskFreeMb(disk: Record<string, unknown> | null): number | null {
  if (disk === null) return null;
  const mb = num(disk.free_mb) ?? num(disk.freeMb);
  if (mb !== null) return mb;
  const gb = num(disk.free_gb) ?? num(disk.freeGb);
  if (gb !== null) return gb * 1024;
  const bytes = num(disk.free_bytes) ?? num(disk.freeBytes);
  if (bytes !== null) return bytes / 1024 / 1024;
  return null;
}

function readSize(raw: Record<string, unknown>, key: string): number | null {
  const holder = asRecord(raw[key]);
  if (holder !== null) {
    const bytes = num(holder.bytes) ?? num(holder.size_bytes) ?? num(holder.sizeBytes);
    if (bytes !== null) return bytes;
    // keeper 的 PlanFile 形状用 totalMb（backups）/ mb（snapshots），两种都认。
    const mb = num(holder.mb) ?? num(holder.totalMb) ?? num(holder.total_mb);
    if (mb !== null) return mb * 1024 * 1024;
  }
  const direct = num(raw[`${key}_bytes`]) ?? num(raw[`${key}Bytes`]);
  if (direct !== null) return direct;
  const directMb = num(raw[`${key}_mb`]) ?? num(raw[`${key}Mb`]);
  return directMb === null ? null : directMb * 1024 * 1024;
}

function readBalance(raw: Record<string, unknown>): KeepView["balance"] {
  const src = asRecord(raw.balance) ?? asRecord(raw.probes);
  if (src === null) {
    return { cheap: UNKNOWN_BALANCE, balanced: UNKNOWN_BALANCE, strong: UNKNOWN_BALANCE };
  }
  const pick = (key: "cheap" | "balanced" | "strong"): KeepBalanceEntry => {
    const entry = asRecord(src[key]);
    if (entry === null) return UNKNOWN_BALANCE;
    return { level: levelOf(entry), note: noteOf(entry) };
  };
  return { cheap: pick("cheap"), balanced: pick("balanced"), strong: pick("strong") };
}

function readComponents(raw: Record<string, unknown>): KeepComponent[] {
  const out: KeepComponent[] = [];
  const map = asRecord(raw.components) ?? asRecord(raw.checks);
  if (map !== null) {
    for (const [name, value] of Object.entries(map)) {
      const rec = asRecord(value);
      out.push({ name, level: levelOf(rec), note: noteOf(rec) });
    }
  }
  const list = Array.isArray(raw.probes) ? raw.probes : [];
  for (const item of list) {
    const rec = asRecord(item);
    if (rec === null) continue;
    const name = str(rec.name) ?? str(rec.component);
    if (name === null) continue;
    out.push({ name, level: levelOf(rec), note: noteOf(rec) });
  }
  // keeper 的巡检结果还以 rows:[{id,state,detail}] 落一份；components 缺失时用它兜底。
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  if (out.length === 0) {
    for (const item of rows) {
      const rec = asRecord(item);
      if (rec === null) continue;
      const name = str(rec.id) ?? str(rec.name);
      if (name === null) continue;
      out.push({ name, level: levelOf(rec), note: noteOf(rec) });
    }
  }
  return out;
}

export function parseKeepState(value: unknown, path: string): KeepView {
  const raw = asRecord(value);
  if (raw === null) return emptyKeepView(path, "keep.json 不是对象");

  const disk = asRecord(raw.disk);
  const freeMb = readDiskFreeMb(disk);
  const diskLevel = levelOf(disk);
  const admissionRaw = raw.admission;
  let admission: string | null = null;
  if (typeof admissionRaw === "string") admission = admissionRaw;
  else if (admissionRaw !== undefined) {
    const rec = asRecord(admissionRaw);
    admission = rec === null ? null : str(rec.state) ?? str(rec.status);
  }

  return {
    ok: true,
    path,
    error: null,
    updatedAt: str(raw.updated_at) ?? str(raw.updatedAt),
    diskFreeMb: freeMb,
    diskLevel,
    diskNote: noteOf(disk),
    backupsBytes: readSize(raw, "backups"),
    artifactsBytes: readSize(raw, "artifacts"),
    snapshotsBytes: readSize(raw, "snapshots"),
    balance: readBalance(raw),
    probedAt:
      str(raw.probed_at) ??
      str(raw.probedAt) ??
      str(raw.balance_at) ??
      str(raw.updated_at) ??
      str(raw.updatedAt),
    components: readComponents(raw),
    admission,
    line: str(raw.line),
    raw,
  };
}

export function readKeepState(path: string): KeepView {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyKeepView(path, "keep.json 还没生成（keeper 没跑过）");
    return emptyKeepView(path, `keep.json 读不了：${(err as Error).message}`);
  }
  try {
    return parseKeepState(JSON.parse(text) as unknown, path);
  } catch {
    return emptyKeepView(path, "keep.json 不是合法 JSON");
  }
}

export interface AdmissionDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * 停接新任务的判定（B.7，数字来自 config.keepalive.disk.pause_gb=0.8）。
 *
 * 迟滞解除（>1GB 且持续 10 分钟）由 dot-core 维护；桥这里只做前门拦截：
 * 见到 `admission=paused*`，或盘剩余低于阈值，就拒新任务并带上人话原因。
 */
export function diskAdmission(view: KeepView, minFreeMb = 800): AdmissionDecision {
  if (view.admission !== null && /^paused/i.test(view.admission)) {
    return { allowed: false, reason: `盘紧（keeper 已置 admission=${view.admission}），暂停接新任务` };
  }
  if (view.diskFreeMb !== null && view.diskFreeMb < minFreeMb) {
    const gb = (view.diskFreeMb / 1024).toFixed(2);
    return {
      allowed: false,
      reason: `盘紧：账本盘只剩 ${gb} GB（低于 ${(minFreeMb / 1024).toFixed(2)} GB），暂停接新任务；清盘或把账本挪到别的盘再试`,
    };
  }
  return { allowed: true, reason: null };
}

/** 状态页顶部那一行的账户探针部分：省钱绿·均衡红…… */
export function balanceLine(view: KeepView): string {
  const label: Record<HealthLevel, string> = {
    green: "绿",
    yellow: "黄",
    red: "红",
    grey: "未知",
  };
  const at = view.probedAt === null ? "" : `·${formatProbeClock(view.probedAt)}`;
  return `账户探针：省钱${label[view.balance.cheap.level]}·均衡${label[view.balance.balanced.level]}·最强${label[view.balance.strong.level]}${at}`;
}

/** 状态页顶部一行：盘剩／备份／artifacts／snapshots／账户探针。 */
export function keepHeaderLine(view: KeepView): string {
  // 自己按 B.7 的原文拼（中文「绿/黄/红」），数字来自解析后的字段。
  // keep.json 里的 `line` 也用英文 level（green/red），照抄会破坏 B.7 的中文格式；
  // 那个字段留给排查用，不进状态页。
  const disk = view.diskFreeMb === null ? "未知" : `${(view.diskFreeMb / 1024).toFixed(1)} GB`;
  return [
    `盘剩 ${disk}`,
    `备份 ${formatSize(view.backupsBytes)}`,
    `artifacts ${formatSize(view.artifactsBytes)}`,
    `snapshots ${formatSize(view.snapshotsBytes)}`,
    balanceLine(view),
  ].join("／");
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "未知";
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatProbeClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
