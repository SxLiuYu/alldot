/**
 * src/bridge/push.ts —— 把「要你批」和「任务结果」推到手机上。
 *
 * 为什么是桥里轮询，而不是在 dispatch 里加钩子：dispatch 每加一个钩子都要动核心语义，
 * 而桥本来就在读账本。10 秒一轮、按 id 去重，够用，也不碰别人的代码。
 *
 * 两个纪律：
 * - 启动那一刻只「登记」不发，否则一上线就把历史待批和旧任务全推一遍。
 * - 发送失败不记已推，下一轮重试；发送成功才落 push-seen.jsonl。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { listApprovals } from "./approvals.ts";
import { openLedger } from "../ledger/db.ts";
import { listTasks } from "../ledger/index.ts";

/** 一条要推给用户的事。key 是去重键，形如 approval:apv_x / result:task_x。 */
export interface PushEvent {
  key: string;
  kind: "approval" | "result";
  text: string;
}

/** 发送一条；实现自己吞异常，失败返回 ok=false 与原因。 */
export type PushSend = (text: string) => Promise<{ ok: boolean; detail: string }>;

/** 从账本挑出此刻值得推的事件。纯读，不发。 */
export function pickPushEvents(ledgerPath: string, now: Date, windowMs = 15 * 60_000): PushEvent[] {
  const out: PushEvent[] = [];
  const ap = listApprovals(ledgerPath, now);
  for (const it of ap.items) {
    if (it.expired) continue;
    out.push({
      key: `approval:${it.id}`,
      kind: "approval",
      text: `要你批一下（第 ${it.tier} 档）：${it.summary}\n手机上打开 alldot 页面就能点同意/拒绝。`,
    });
  }
  const since = now.getTime() - windowMs;
  let tasks: Array<{ id: string; state: string; intent: string; updated_at: string }> = [];
  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(ledgerPath, { readOnly: true, createDir: false });
    tasks = listTasks(db, { state: ["done", "failed", "cancelled"], newestFirst: true, limit: 20 }) as unknown as typeof tasks;
  } catch {
    tasks = [];
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不上不影响结果 */
    }
  }
  for (const t of tasks) {
    const at = Date.parse(t.updated_at);
    if (!Number.isFinite(at) || at < since) continue;
    const label = t.state === "done" ? "做完了" : t.state === "cancelled" ? "已取消" : "没做成";
    out.push({ key: `result:${t.id}`, kind: "result", text: `任务${label}：${t.intent.slice(0, 80)}` });
  }
  return out;
}

/** 飞书自定义机器人（webhook）发送。不需要 token、不需要权限，最省事。 */
export function createFeishuWebhookSender(webhook: string, fetchImpl: typeof fetch = fetch): PushSend {
  return async (text) => {
    try {
      const res = await fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text } }),
      });
      const body = await res.text().catch(() => "");
      // 飞书成功返回 {"code":0,...} 或老版 {"StatusCode":0,...}
      const ok = res.ok && /"(?:code|StatusCode)"\s*:\s*0\b/.test(body);
      return { ok, detail: ok ? "已发" : `HTTP ${res.status}：${body.slice(0, 160)}` };
    } catch (err) {
      return { ok: false, detail: `发不出去：${(err as Error).message}` };
    }
  };
}

/**
 * 微信发送：起一个 helper 进程，把文字交给它。
 *
 * 为什么不用 wx_send：那条路要切虚拟桌面、抢焦点，10 秒一轮会把屏幕闪瞎。
 * helper 走 UIA 写输入框 + PostMessage 回车，不需要窗口可见（实测微信在别的
 * 虚拟桌面也能发）。helper 自己会校验当前会话，对不上就拒发，避免发错人。
 */
export function createWechatSender(pythonExe: string, scriptPath: string, marker = "alldot"): PushSend {
  return (text) =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(pythonExe, ["-I", scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        resolve({ ok: false, detail: `起不来：${(err as Error).message}` });
        return;
      }
      let out = "";
      let err = "";
      let settled = false;
      const done = (r: { ok: boolean; detail: string }): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      child.stdout?.on("data", (d) => {
        out += String(d);
      });
      child.stderr?.on("data", (d) => {
        err += String(d);
      });
      child.on("error", (e) => done({ ok: false, detail: `起不来：${e.message}` }));
      child.on("close", (code) => {
        const line = out
          .trim()
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.trim().startsWith("{"));
        if (line !== undefined) {
          try {
            const j = JSON.parse(line) as { ok?: unknown; detail?: unknown };
            done({ ok: j.ok === true, detail: String(j.detail ?? "") });
            return;
          } catch {
            /* 落到下面按退出码报 */
          }
        }
        done({ ok: false, detail: `helper 退出 ${code}：${(out + err).slice(-200)}` });
      });
      child.stdin?.end(JSON.stringify({ text, marker }));
    });
}

function readSeen(path: string): string[] {  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((l) => {
        try {
          return String((JSON.parse(l) as { key?: unknown }).key ?? "");
        } catch {
          return "";
        }
      })
      .filter((k) => k !== "");
  } catch {
    return [];
  }
}

function appendSeen(path: string, key: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ key, at: new Date().toISOString() }) + "\n", "utf8");
  } catch {
    /* 记不下最多重推一次，不值得让巡环挂掉 */
  }
}

export interface PushLoopOptions {
  ledgerPath: string;
  sender: PushSend;
  /** 已推记录，按行存 {key, at}。 */
  seenPath: string;
  pollSec: number;
  log?: (line: string) => void;
  now?: () => Date;
}

/** 起一轮轮询；返回 stop()。启动时只登记不发。 */
export function startPushLoop(o: PushLoopOptions): () => void {
  const now = o.now ?? (() => new Date());
  const seen = new Set<string>(readSeen(o.seenPath));
  let stopped = false;

  const tick = async (announce: boolean): Promise<void> => {
    let events: PushEvent[] = [];
    try {
      events = pickPushEvents(o.ledgerPath, now());
    } catch (err) {
      o.log?.(`挑选失败：${(err as Error).message}`);
      return;
    }
    for (const e of events) {
      if (stopped) return;
      if (seen.has(e.key)) continue;
      if (!announce) {
        seen.add(e.key);
        continue;
      }
      const r = await o.sender(e.text);
      if (r.ok) {
        seen.add(e.key);
        appendSeen(o.seenPath, e.key);
        o.log?.(`推送成功 ${e.key}`);
      } else {
        o.log?.(`推送失败 ${e.key}：${r.detail}`);
      }
    }
  };

  void tick(false);
  const timer = setInterval(() => {
    if (!stopped) void tick(true);
  }, Math.max(5, Math.floor(o.pollSec)) * 1000);
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
