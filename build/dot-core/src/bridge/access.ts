/**
 * src/bridge/access.ts —— 手机接入方式（局域网直连 / 内网穿透 / 自定义中继）。
 *
 * alldot 本体默认只听 127.0.0.1（B.6 的原口径，安全）。手机要连进来时，用户从配置里
 * 显式选择一种接入方式，桥才按对应方式监听。三种方式都要求桥 token，不因为换了
 * 传输就放松鉴权。
 *
 * 设计要点：
 * - 默认 loopback：什么都不配时行为与以前一模一样，老安装不受影响（零回归）。
 * - lan：监听 0.0.0.0，手机和电脑同一 WiFi 用 http://<电脑内网IP>:8799/chat?token=... 访问。
 * - tunnel：监听 0.0.0.0，前面挂 cloudflared/frp 等隧道；桥不知道公网域名，只管监听。
 * - relay：监听 0.0.0.0，用户自己起的中继把请求转发进来；桥不主动连中继。
 *   这三种里 0.0.0.0 是必要的：loopback 上隧道和中继都连不进来。
 * - allowed_cidrs：额外放行的来源 CIDR/IP。私网（手机 WiFi/热点）和回环本来就收；
 *   这一项用来放行公网中继源。留空=只收私网+回环，公网来源拒。
 * - 连接来源是 RFC1918 私网段（手机在 WiFi 里）或回环才收；其它来源按 403 拒。
 *   公网隧道场景由前置代理终止 TLS 并做鉴权，请求到桥时是本机地址，所以不冲突。
 */

export type AccessMode = "loopback" | "lan" | "tunnel" | "relay";

export interface AccessConfig {
  mode: AccessMode;
  /** 非 loopback 模式监听的地址。lan/tunnel/relay 一律 0.0.0.0。 */
  host: string;
  /** 额外放行的来源 CIDR/IP（留空=按 mode 默认规则）。 */
  allowed_cidrs: string[];
}

export const DEFAULT_ACCESS: AccessConfig = {
  mode: "loopback",
  host: "127.0.0.1",
  allowed_cidrs: [],
};

/** 把模式换成监听地址。写错模式不会静默变成 0.0.0.0。 */
export function hostForAccess(mode: AccessMode): string {
  if (mode === "loopback") return "127.0.0.1";
  if (mode === "lan" || mode === "tunnel" || mode === "relay") return "0.0.0.0";
  throw new Error(`未知的接入方式：${String(mode)}`);
}

/** 严格 IPv4 点分十进制（不做 DNS 解析，避免把域名当 IP 放行）。 */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 回环；::ffff:127.0.0.1 这种映射地址也认。 */
function isIpv6Loopback(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a === "::1" || a === "::ffff:127.0.0.1" || a === "0:0:0:0:0:0:0:1";
}

function ipToInt(ip: number[]): number {
  return (((ip[0] ?? 0) << 24) | ((ip[1] ?? 0) << 16) | ((ip[2] ?? 0) << 8) | (ip[3] ?? 0)) >>> 0;
}

function cidrMatches(addr: number[], cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const baseText = slash < 0 ? cidr : cidr.slice(0, slash);
  const prefix = slash < 0 ? 32 : Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const base = parseIpv4(baseText.trim());
  if (base === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToInt(addr) & mask) === (ipToInt(base) & mask);
}

/** RFC1918 私网 + 回环。手机在 WiFi 里就是 192.168.x.x 或 10.x.x.x。 */
export function isLanAddress(addr: string | undefined): boolean {
  if (addr === undefined || addr === "") return false;
  const a = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  if (a === "127.0.0.1" || a === "localhost" || isIpv6Loopback(a)) return true;
  const ip = parseIpv4(a);
  if (ip === null) return false;
  const [x, y] = ip as [number, number, number, number];
  if (x === 10) return true;
  if (x === 192 && y === 168) return true;
  if (x === 172 && y >= 16 && y <= 31) return true;
  // 手机热点可能发 169.254 链路本地地址，同一热点下要能连。
  if (x === 169 && y === 254) return true;
  return false;
}

/** 判断一个连接来源是否被当前接入配置允许。 */
export function isAddressAllowed(addr: string | undefined, access: AccessConfig): boolean {
  if (access.mode === "loopback") {
    const a = addr ?? "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1" || a === "localhost";
  }
  for (const cidr of access.allowed_cidrs) {
    const a = addr ?? "";
    const withoutMap = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
    const ip = parseIpv4(withoutMap);
    if (ip !== null && cidrMatches(ip, cidr)) return true;
    if (cidr.trim() === withoutMap) return true;
  }
  // 隧道/中继模式的请求通常来自本机前置代理（回环）；LAN 模式来自手机。
  // 两种都收，公网来源被前置代理挡在桥外面。
  return isLanAddress(addr);
}

/** 给用户看的接入说明，写进 /health 和文档。 */
export function accessDescription(access: AccessConfig): string {
  if (access.mode === "loopback") return "仅本机 127.0.0.1（手机连不上）";
  if (access.mode === "lan") return `局域网直连，监听 ${access.host}:8799，手机同 WiFi 访问`;
  if (access.mode === "tunnel") return `内网穿透模式，监听 ${access.host}:8799，前面需配 cloudflared/frp`;
  return `自定义中继模式，监听 ${access.host}:8799，前面需配你自己的中继`;
}
