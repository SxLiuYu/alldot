/**
 * src/bridge/token.ts —— 桥 token 的读取与比较（A.3、B.6）。
 *
 * 口径：
 * - token 只存在 `~/.allbot/dot/bridge-token` 一个文件里，一行，首尾空白去掉；
 * - 文件不存在 / 空文件 → 「没配置」，桥拒掉除 /health 之外的全部请求（503）；
 * - 比较用 sha256 摘要再 timingSafeEqual，长度不同也不提前返回。
 *
 * 文件可能由人后补，所以读侧带 mtime 缓存：文件没变不重读，变了立刻生效。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";

export interface TokenState {
  token: string | null;
  path: string;
  error: string | null;
}

/** 直接读一次，不缓存。 */
export function readBridgeToken(path: string): TokenState {
  try {
    const raw = readFileSync(path, "utf8");
    const token = raw.trim();
    if (token.length === 0) {
      return { token: null, path, error: "token 文件是空的" };
    }
    return { token, path, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { token: null, path, error: "token 文件不存在" };
    return { token: null, path, error: `token 文件读不了：${(err as Error).message}` };
  }
}

/** 按 mtime 缓存。mtime 读不到（文件还没建）就一直返回「没配置」。 */
export class TokenCache {
  readonly path: string;
  private cache: TokenState | null = null;
  private cacheKey = "";

  constructor(path: string) {
    this.path = path;
  }

  get(): TokenState {
    let key = "missing";
    try {
      const st = statSync(this.path);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = "missing";
    }
    if (this.cache !== null && this.cacheKey === key) return this.cache;
    this.cache = readBridgeToken(this.path);
    this.cacheKey = key;
    return this.cache;
  }
}

/** 定时比较：先各自 sha256，再 timingSafeEqual。null 一律不相等（除了两个都 null → 由调用方判）。 */
export function tokensEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 从请求里取候选 token，按优先级：
 * 1) `x-dot-bridge-token: <token>`（dot-core 的桥路由专用头；转发时 Authorization
 *    必须留给网关 token，所以桥 token 走这个头，见 A.3 的两层鉴权）；
 * 2) `Authorization: Bearer <token>`（ds-bot 的能力 headers 走这条，直连 8799 时）；
 * 3) `?token=`（浏览器第一次打开状态页，随后由 Cookie 接住）；
 * 4) `Cookie: dot_bridge_token=<token>`。
 */
export function tokenFromRequest(req: IncomingMessage, url: URL): string | null {
  const header = req.headers["x-dot-bridge-token"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m !== null && m[1] !== undefined) return m[1].trim();
  }
  const query = url.searchParams.get("token");
  if (query !== null && query.trim() !== "") return query.trim();
  const cookies = req.headers.cookie;
  if (typeof cookies === "string") {
    for (const part of cookies.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === "dot_bridge_token") {
        const value = part.slice(eq + 1).trim();
        if (value !== "") return value;
      }
    }
  }
  return null;
}

/** 状态页用 ?token= 进来时种 Cookie，后续 /artifact 链接不用再带 token。 */
export function tokenCookie(token: string): string {
  return `dot_bridge_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
}

// ────────────────────────────────────────────────────────────────────────────
// 网关 token（18789 的 auth.mode=token）
// ────────────────────────────────────────────────────────────────────────────

/**
 * A.3 的两层鉴权：18789 先认网关 token（Authorization: Bearer），
 * dot-core 的桥路由再认桥 token（x-dot-bridge-token）。
 * 网关 token 在 ~/.allbot/allbot.json 的 `gateway.auth.token`（本机 mode=token）。
 */
export interface GatewayTokenState {
  token: string | null;
  path: string;
  error: string | null;
}

export function readGatewayToken(configPath: string): GatewayTokenState {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { token: null, path: configPath, error: "allbot.json 不存在" };
    return { token: null, path: configPath, error: `allbot.json 读不了：${(err as Error).message}` };
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw) as unknown;
  } catch {
    return { token: null, path: configPath, error: "allbot.json 不是合法 JSON" };
  }
  const gateway =
    cfg !== null && typeof cfg === "object" ? (cfg as Record<string, unknown>).gateway : undefined;
  const auth =
    gateway !== null && typeof gateway === "object"
      ? (gateway as Record<string, unknown>).auth
      : undefined;
  const token =
    auth !== null && typeof auth === "object"
      ? (auth as Record<string, unknown>).token
      : undefined;
  if (typeof token !== "string" || token.trim() === "") {
    return { token: null, path: configPath, error: "gateway.auth.token 没配（网关若是 token 模式，转发会被 401）" };
  }
  return { token: token.trim(), path: configPath, error: null };
}

/** 和桥 token 一样按 mtime 缓存：配置改了不用重启桥。 */
export class GatewayTokenCache {
  readonly path: string;
  private cache: GatewayTokenState | null = null;
  private cacheKey = "";

  constructor(path: string) {
    this.path = path;
  }

  get(): GatewayTokenState {
    let key = "missing";
    try {
      const st = statSync(this.path);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = "missing";
    }
    if (this.cache !== null && this.cacheKey === key) return this.cache;
    this.cache = readGatewayToken(this.path);
    this.cacheKey = key;
    return this.cache;
  }
}
