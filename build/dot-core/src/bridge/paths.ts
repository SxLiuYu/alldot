/**
 * src/bridge/paths.ts —— 桥用到的三个固定路径（B.6 / A.3）。
 *
 * 只听 127.0.0.1 的 8799 只是一个壳，真正决定「桥能不能干活」的是这三份文件：
 *   ~/.allbot/dot/bridge-token       桥 token（没有就拒，见 token.ts）
 *   ~/.allbot/dot/ledger/dot.db      账本（只读打开，桥永不写）
 *   ~/.allbot/dot/state/keep.json    keeper 的巡检状态（桥只读，不经过账本）
 *
 * 默认值集中在这里，测试与部署只改这一处。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface DotPaths {
  home: string;
  dotDir: string;
  ledgerPath: string;
  tokenPath: string;
  keepPath: string;
  /** ~/.allbot/allbot.json：只读它拿网关 token（A.3 第一层），绝不改它。 */
  configPath: string;
}

export interface DotPathOptions {
  home?: string;
  /** `~/.allbot/dot` 的替代（测试用临时目录，部署用默认）。 */
  dotDir?: string;
  ledgerPath?: string;
  tokenPath?: string;
  keepPath?: string;
  configPath?: string;
}

export function resolveDotPaths(opts: DotPathOptions = {}): DotPaths {
  const home = opts.home ?? homedir();
  const dotDir = opts.dotDir ?? join(home, ".allbot", "dot");
  return {
    home,
    dotDir,
    ledgerPath: opts.ledgerPath ?? join(dotDir, "ledger", "dot.db"),
    tokenPath: opts.tokenPath ?? join(dotDir, "bridge-token"),
    keepPath: opts.keepPath ?? join(dotDir, "state", "keep.json"),
    configPath: opts.configPath ?? join(home, ".allbot", "allbot.json"),
  };
}
