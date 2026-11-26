/**
 * src/runtime/live-config.ts —— 少数几个「改了就想马上生效」的配置项，从文件现读。
 *
 * 为什么要单独一层：dot-core 的配置是启动时读一次的快照（loadConfig），
 * 改 config.json 要重启网关（冷启动 4~5 分钟）。可「自动同意到几档」是个用户随时想开关的
 * 东西，为它重启一次太贵。所以这里按文件读取 + 20 秒缓存：
 *   · 用户改完 config.json（或走桥 POST /settings）→ 最多 20 秒后新动作就按新值判；
 *   · 文件读不到/写坏了 → 退回启动时那份配置的值，绝不因为读坏文件放宽权限。
 *
 * 只放**这一件**东西。别的配置项还是重启生效：能现读的项越多，「为什么这个改了没生效」
 * 的迷惑就越多。
 */

import { readFileSync } from "node:fs";

const CACHE_MS = 20_000;

export function clampAutoApproveTier(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  // 上限 4 写死：5 档（身份/钱）与 6 档（危险）永远要人点。
  return Math.max(0, Math.min(4, Math.floor(n)));
}

/**
 * 返回一个读当前「自动同意上限」的函数。
 * @param configPath  dot 自己的 config.json
 * @param fallback    启动时那份配置里的值（文件读不到时用它）
 */
export function createLiveAutoApproveMaxTier(configPath: string, fallback: number): () => number {
  let cached: { value: number; at: number } | null = null;
  return () => {
    const now = Date.now();
    if (cached !== null && now - cached.at < CACHE_MS) return cached.value;
    let value = clampAutoApproveTier(fallback);
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as { approvals?: { auto_approve_max_tier?: unknown } };
      const fromFile = raw?.approvals?.auto_approve_max_tier;
      if (fromFile !== undefined) value = clampAutoApproveTier(fromFile);
    } catch {
      // 文件不在或坏了：用 fallback（启动时的值），不放宽
    }
    cached = { value, at: now };
    return value;
  };
}
