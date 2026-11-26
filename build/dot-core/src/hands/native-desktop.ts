/**
 * src/hands/native-desktop.ts —— 电脑手的原生实现（不走 MCP）。
 *
 * 为什么要这个（2026-11-26 真机）：Windows-MCP（:8000）的 Snapshot / Screenshot /
 * Wait 三个操作经常超时（20 秒 abort），工人等不到结果就判失败。这三件事用
 * PowerShell 直接做，1-2 秒就回，不依赖外部进程。
 *
 * 只覆盖三个高频操作：
 * - screenshot：截全屏 PNG
 * - wait：等 N 毫秒（纯计时，根本不需要 MCP）
 * - status：拿前台窗口信息（进程名 + 窗口标题）
 *
 * 其余操作（click / type / key / scroll / move / app / snapshot）仍然走 MCP——
 * 那些需要 UI Automation 或 SendInput，内联成本太高。
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** PowerShell 超时：截图 10 秒、查窗口 5 秒。超了就回 null 让调用方走 MCP 兜底。 */
const PS_TIMEOUT_MS = 10_000;

export interface NativeResult {
  ok: boolean;
  result: unknown;
  detail?: string;
}

/** 截全屏 PNG，返回 base64。 */
export async function nativeScreenshot(): Promise<NativeResult> {
  const dir = mkdtempSync(join(tmpdir(), "dot-shot-"));
  const path = join(dir, "screen.png");
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    `$bmp.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose(); $bmp.Dispose()",
  ].join("\n");
  try {
    await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      timeout: PS_TIMEOUT_MS,
      windowsHide: true,
    });
    const buf = readFileSync(path);
    return {
      ok: true,
      result: {
        content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }],
      },
    };
  } catch (err) {
    return { ok: false, result: null, detail: `原生截图失败：${(err as Error).message}` };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }
}

/** 等 N 毫秒。纯计时，不需要 MCP。 */
export async function nativeWait(ms: number): Promise<NativeResult> {
  const clamped = Math.max(0, Math.min(ms, 60_000));
  await new Promise((r) => setTimeout(r, clamped));
  return { ok: true, result: { content: [{ type: "text", text: `等待 ${clamped}ms 完成` }] } };
}

/** 拿前台窗口的进程名和标题。 */
export async function nativeStatus(): Promise<NativeResult> {
  const ps = [
    "Add-Type @'",
    "using System;using System.Runtime.InteropServices;using System.Text;",
    "public class W {",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);",
    "  public static string Info() {",
    "    var h = GetForegroundWindow(); if (h == IntPtr.Zero) return \"\";",
    "    var sb = new StringBuilder(512); GetWindowText(h, sb, 512);",
    "    GetWindowThreadProcessId(h, out uint pid);",
    "    return pid + \"|\" + sb.ToString();",
    "  }",
    "}",
    "'@",
    "[W]::Info()",
  ].join("\n");
  try {
    const { stdout } = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      timeout: PS_TIMEOUT_MS,
      windowsHide: true,
    });
    const line = stdout.trim();
    // 只切第一个 |，标题里含 | 不截断
    const sepIdx = line.indexOf("|");
    const pidStr = sepIdx >= 0 ? line.slice(0, sepIdx) : "";
    const title = sepIdx >= 0 ? line.slice(sepIdx + 1) : line;
    return {
      ok: true,
      result: {
        // structuredContent 是 readDesktopStatus 的主解析面。
        // app/window_id 用 pid 填（非空且稳定），这样 signature 不会是 null，
        // 「接管即停」的基线比对在原生 status 路径也能生效。
        structuredContent: {
          pid: pidStr,
          window: title,
          app: pidStr,
          window_id: pidStr,
          signature: `${pidStr}|${title}`,
        },
        content: [{
          type: "text",
          text: JSON.stringify({ pid: pidStr, window: title, app: pidStr }),
        }],
      },
    };
  } catch (err) {
    return { ok: false, result: null, detail: `原生 status 失败：${(err as Error).message}` };
  }
}

/** 能内联的 MCP 工具名 → 原生实现。 */
export const NATIVE_HANDLERS: Record<string, (params: Record<string, unknown>) => Promise<NativeResult>> = {
  Screenshot: () => nativeScreenshot(),
  Wait: (params) => {
    const ms = typeof params["timeout"] === "number" ? params["timeout"]
      : typeof params["seconds"] === "number" ? params["seconds"] * 1000
      : 1000;
    return nativeWait(ms);
  },
  ControlStatus: () => nativeStatus(),
};
