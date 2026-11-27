/**
 * src/gate/keywords.ts —— 关键词判定的唯一入口（judge.ts 与 policy.ts 共用）。
 *
 * 两套规则，中英文各一套：
 * - 英文/数字词：两侧不能紧邻 [a-z0-9]。`.` `/` `_` `-` 空格引号都算分隔符，
 *   所以 `skill` 里的 `kill`、`killer` 里的 `kill` 不命中（原来子串匹配会命中），
 *   而 `read_password.py` 里的 `password` 命中（`_` 与 `.` 是分隔符）。
 * - 中文词：直接子串。中文不用空格分词，没有可依赖的词边界，
 *   `删除文件` 要能命中 `删除`，所以中文不做边界约束，只保证字面命中。
 *
 * 关键词只在「语义字段 + 命令程序名/非路径参数」上匹配（judge.ts 的 labelText）；
 * 路径与文件名另走 pathText，只给 dot_self 与身份钱用。否则 `skill.ts`、
 * `token.ts`、`commit.md` 这种文件名会被当成动作，把工作区内写错判成 6 档或 4 档。
 */

export interface KeywordSet {
  readonly latin: readonly string[];
  readonly cjk: readonly string[];
  readonly latinRe: RegExp | null;
  readonly cjkRe: RegExp | null;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 长词优先：uninstall 不被 install 抢先，rmdir 不被 rm 抢先。 */
function byLengthDesc(words: readonly string[]): string[] {
  return [...words].sort((a, b) => b.length - a.length);
}

/** 编译一组关键词。空组得到 null，matchesWords 直接跳过。 */
export function wordSet(latin: readonly string[] = [], cjk: readonly string[] = []): KeywordSet {
  const latinRe =
    latin.length === 0
      ? null
      : new RegExp(`(?<![a-z0-9])(?:${byLengthDesc(latin).map(escapeRe).join("|")})(?![a-z0-9])`, "i");
  const cjkRe = cjk.length === 0 ? null : new RegExp(byLengthDesc(cjk).map(escapeRe).join("|"));
  return { latin, cjk, latinRe, cjkRe };
}

/** 是否命中该组任一关键词（英文按词边界、中文按子串）。 */
export function matchesWords(haystack: string, set: KeywordSet): boolean {
  if (haystack === "") return false;
  const text = haystack.toLowerCase();
  if (set.latinRe !== null && set.latinRe.test(text)) return true;
  return set.cjkRe !== null && set.cjkRe.test(text);
}

// ── 各判定用的词表（5.6 六档表 + B.9 伪码的顺序由 judge.ts 负责） ────────────

/** 5 档身份与钱：登录、密码、支付、验证码、生物验证。 */
export const IDENTITY_MONEY = wordSet(
  [
    "login", "logout", "password", "passwd", "captcha", "otp", "2fa", "face", "fingerprint",
    "sms", "biometric", "pay", "payment", "checkout", "buy",
  ],
  ["支付", "付款", "登录", "密码", "验证码", "人脸", "短信", "指纹", "结算", "购买", "买单"],
);

/** 6 档危险：删除、装卸、系统设置、注册表、凭据、杀进程。 */
export const DANGER = wordSet(
  [
    "delete", "remove", "rm", "rmdir", "del", "erase", "uninstall", "install", "winget", "format",
    "registry", "regedit", "reg", "credential", "credentials", "secret", "secrets", "token",
    "keychain", "kill", "taskkill", "shutdown", "reboot", "diskpart", "bcdedit", "icacls",
    "takeown", "chmod", "chown", "sudo", "admin",
  ],
  ["删除", "卸载", "重装", "格式化", "注册表", "凭据", "密钥", "系统设置", "关安全软件", "装软件"],
);

/** 4 档不可逆提交：提交、上传、发消息发帖、下单预约。 */
export const IRREVERSIBLE = wordSet(
  ["submit", "send", "upload", "post", "publish", "order", "checkout", "book", "pay", "commit", "push", "delete"],
  ["提交", "发送", "上传", "发帖", "下单", "预约", "支付", "删除"],
);

/** 1 档只读。 */
export const READ = wordSet([
  "read", "list", "glob", "grep", "search", "view", "find", "status", "screenshot", "stat", "inspect",
]);

/** 2 档工作区内写的动作词。 */
export const WRITE_ACTION = wordSet(["write", "edit", "create", "mkdir", "copy", "move", "type", "fill"]);

/** 超声明范围（配合 input.inWorkspace===false / 超预算使用）。 */
export const SCOPE = wordSet(["scope"], ["范围"]);

/** classifySideEffect 用的「不清就 unknown」词表（与 judge 的危险/不可逆语义同源）。 */
export const UNKNOWN_SEMANTICS = wordSet(
  [
    "delete", "remove", "rm", "uninstall", "install", "submit", "send", "upload", "pay", "login",
    "password", "passwd", "captcha", "otp", "face", "sms",
  ],
  ["删除", "卸载", "安装", "支付", "提交", "登录", "密码", "验证码", "人脸", "短信", "发送", "上传"],
);
