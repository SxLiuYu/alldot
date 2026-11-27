/**
 * src/bridge/diagnostics.ts —— 一键诊断（P1P3 契约第 3 节）。
 *
 * 输出是**纯文本**，一定要能直接贴到聊天里：所以在生成之后统一过一遍脱敏，
 * token、IPv4、端口、邮箱、`C:\Users\<名>` 全部换成占位符。
 * 数据只读：账本只读打开，keep.json 只读，错误日志只读尾部。
 */

import { readFileSync } from "node:fs";

import { listSteps, listTasks, openLedger } from "../ledger/index.ts";
import type { DoctorPayload } from "./doctor.ts";

export interface DiagnosticsInput {
  version: string;
  now: Date;
  doctor: DoctorPayload;
  ledgerPath: string;
  /** 桥自己记的最近一次大脑错误。 */
  bridgeError: string | null;
  /** 通知错误日志（state/notify-errors.jsonl）。 */
  notifyErrorPath: string;
  /** 现场已知的秘密值（桥 token / 网关 token），按原值替换。 */
  secrets?: readonly string[];
}

const KNOWN_PORTS = ["18789", "18799", "8799", "8797", "8931", "8932", "8933", "8000", "3065"];

/**
 * 脱敏。顺序有讲究：先按已知秘密值整串替换，再处理邮箱/IP/端口，
 * 最后收拾 len 够长的十六进制串（账本哈希、token 片段）。
 */
export function redactDiagnostics(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.trim().length >= 6) {
      out = out.split(secret).join("<已脱敏>");
    }
  }
  // ISO 时间戳里的冒号不是端口：先摘出来，最后原样放回。
  const stamps: string[] = [];
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (match) => {
    stamps.push(match);
    return `\u0000STAMP${stamps.length - 1}\u0000`;
  });
  out = out
    .replace(/C:\\+Users\\+[^\\\s"'：，。；）】]+/gi, "C:\\Users\\<用户>")
    .replace(/\/c\/Users\/[^/\s"']+/gi, "/c/Users/<用户>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<邮箱>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<IP>")
    .replace(/\bBearer\s+\S+/g, "Bearer <已脱敏>")
    .replace(/\b(token|Token|TOKEN)\s*[=:]\s*\S+/g, "$1=<已脱敏>")
    .replace(new RegExp(`\\b(?:${KNOWN_PORTS.join("|")})\\b`, "g"), "<端口>")
    .replace(/:(?:\d{2,5})\b/g, ":<端口>")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<哈希>");
  return out.replace(/\u0000STAMP(\d+)\u0000/g, (_, index: string) => stamps[Number(index)] ?? "");
}

interface TaskLine {
  id: string;
  state: string;
  intent: string;
  steps: number;
}

function recentTasks(ledgerPath: string): { tasks: TaskLine[]; error: string | null } {
  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(ledgerPath, { readOnly: true, createDir: false, busyTimeoutMs: 2000 });
    const rows = listTasks(db, { limit: 5 });
    const tasks = rows.map((row) => {
      let steps = 0;
      try {
        steps = listSteps(db as NonNullable<typeof db>, row.id).length;
      } catch {
        steps = 0;
      }
      return { id: row.id, state: row.state, intent: row.intent, steps };
    });
    return { tasks, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      tasks: [],
      error: code === "ENOENT" ? "账本还没建" : `账本打不开：${(err as Error).message}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // 关不上就算了。
    }
  }
}

function tailLines(path: string, count: number): string[] {
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter((line) => line.trim() !== "");
    return lines.slice(-count);
  } catch {
    return [];
  }
}

/** 通知错误日志是 JSONL；只取 detail/kind 两个字段，别把整行原样倒出来。 */
function notifyErrorLines(path: string): string[] {
  return tailLines(path, 3).map((line) => {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      const kind = typeof rec.kind === "string" ? rec.kind : "error";
      const detail = typeof rec.detail === "string" ? rec.detail : "";
      return `${kind}：${detail}`;
    } catch {
      return line;
    }
  });
}

const STATE_LABEL: Record<string, string> = {
  queued: "排队",
  running: "在做",
  awaiting_approval: "等人点",
  paused: "暂停",
  done: "成了",
  failed: "失败",
  cancelled: "取消",
};

export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = [];
  lines.push("alldot 诊断");
  lines.push(`版本：${input.version}`);
  lines.push(`生成：${input.now.toISOString()}`);
  lines.push(
    `总体：${input.doctor.overall}${input.doctor.blocked ? "（会挡派单）" : "（不挡派单）"}${
      input.doctor.updatedAt === null ? "" : `；巡检时间 ${input.doctor.updatedAt}`
    }`,
  );
  if (input.doctor.configError !== null) {
    lines.push(`配置错误：${input.doctor.configError.path} —— ${input.doctor.configError.message}`);
  }

  lines.push("");
  lines.push("体检：");
  for (const item of input.doctor.items) {
    const flag = item.state === "green" ? "绿" : item.state === "yellow" ? "黄" : "红";
    lines.push(`- [${flag}] ${item.title}：${item.detail}${item.blocks ? "（挡派单）" : ""}`);
  }

  lines.push("");
  lines.push("最近任务：");
  const ledger = recentTasks(input.ledgerPath);
  if (ledger.error !== null) {
    lines.push(`- ${ledger.error}`);
  } else if (ledger.tasks.length === 0) {
    lines.push("- 账本里还没有任务");
  } else {
    for (const task of ledger.tasks) {
      lines.push(
        `- ${task.id} ${STATE_LABEL[task.state] ?? task.state} 步数 ${task.steps}｜${task.intent.slice(0, 60)}`,
      );
    }
  }

  const errors: string[] = [];
  if (input.bridgeError !== null) errors.push(`大脑：${input.bridgeError}`);
  errors.push(...notifyErrorLines(input.notifyErrorPath));
  for (const item of input.doctor.items) {
    if (item.state === "red") errors.push(`${item.title}：${item.detail}`);
  }
  lines.push("");
  lines.push("最近错误：");
  if (errors.length === 0) {
    lines.push("- 没有记到错误");
  } else {
    for (const err of errors.slice(-5)) lines.push(`- ${err}`);
  }

  return redactDiagnostics(lines.join("\n"), input.secrets);
}
