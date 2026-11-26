# src/gate 接线说明（施工时用，本次没有动正式安装）

本目录只实现判定与审批状态机，不碰 `~/.dsh/`、`~/.allbot/allbot.json`、`C:/allbot-public/`，也不起服务。装的时候按下面接线：

1. 白名单：从 `~/.allbot/dot/config.json` 读 `exec.whitelist`（若方案施工时加该项），传给 `execArgVerdict(program, args, { whitelist })`；没配就用 `DEFAULT_EXEC_WHITELIST`。名单外程序一律 4 档问。judgeTier 内部默认同一份名单。
2. 受保护程序：把 `config.desktop.human_only_apps` 传给 `judgeTier({ ..., protectedApps })` 和 `isProtectedApp(name, extra)`。内置部分已有 `Weixin/WeChat`；ds-bot 现成名单施工时读出来并进 `extra`，不要写死在本目录。受保护程序既看桌面窗口字段，也看 exec 的 program/program 路径，命中即 6 档直接拒。
3. DENY 工具：从 B.1 的口闸名单反推出的拒绝项经 `input.denyTools` 传入；工具名不在允许名单时由口闸先拒，gate 再兜一层。
4. 审批：`createApproval/db` 与 `decideApproval/db` 吃账本连接（由 dot-core 入口 `openLedger` 得到），本目录直接 `import ../ledger/index.ts`，不复制账本代码。`decideApproval` 返回 false 表示这次调用没抢到 `WHERE status='pending'`，调用方按幂等重复处理，不要报错。
5. `execArgVerdict` 命中执行性语法时 `refuseIfUnclear=true`：`judgeTier` 已把它落到第 4 档；闸门在问不清时按拒处理，不放行执行。
6. 工作区证据（`workspaceStatus` 三分）：第 2 档（写、exec 写、git 本地写）必须传 `inWorkspace=true`，或传 `workspace` 加 `target`/`args.path` 等目标路径（exec 还会把命令行里像路径的参数一并对）。三分结果：`inside` → 2 档；`outside`（比对后确有目标在根外，或调用方显式 `inWorkspace=false`）→ 4 档 `out_of_scope_or_budget` 且 `judgeNeeded=true`（B.9「超声明范围 → 4 问＋记裁判出场」）；`unknown`（没有任何目标可比）→ 4 档 `workspace_unknown`，不算超范围，不记裁判。只读命令（git status/log 等）不需要工作区证据。
7. git：`git commit`、`git tag`、`git add/checkout/switch/branch/merge/rebase/stash/restore/apply/mv/init` 这类本地操作按 5.6 档 2 放行（`rule=git_local`，先快照），并且这条判定排在不可逆关键词之前——否则 `commit` 会被当成「不可逆提交」落到 4 档。`git push` 走远端，5.6 的六档表没有给它定档，暂按 4 档每次问（`rule=git_push`，理由里注明待拍板）；定档后改 `judge.ts` 的 `GIT_REMOTE_SUBCOMMANDS` 一处即可。会丢本地工作、快照又兜不住 git 引用的子命令（`reset`、`clean`、`branch -d/-D`、`tag -d`、`stash drop/clear`）落 4 档 `git_destructive` 每次问（`gitDestructive` 一处改）。带执行性语法的 git 命令（`&&`、管道、`-c`、`-C` 等）不走这两条，仍按 exec 判 4 档，`git commit && rm -rf x` 不会因此放行。工作区在外的 git 命令按第 6 条落 4 档超范围并记裁判（含 `git checkout`，不会掉到身份钱的 5 档）。
8. 改 dot 自己：`target`/`args.path` 落在 `~/.allbot/dot/`、`~/.allbot/allbot.json`、`~/.dsh/plugins/dot-*`、`~/.dsh/bot/dot-guard.jsonl`，或语义字段出现 dot config/ledger 等词，直接 6 档拒——**只拒写**（写、以及 git 的 checkout/restore/add/commit 这类写类子命令）；只读（`read`、`cat`、`ls`、git status 一类）按 5.6 档 1 放行记账，因为方案 :668 对「拒读 ~/.dsh/bot/ 与账本 db」原文是「这条本次没加，需要你点头」，没点头就不拒读。这条排在 git 之前，否则 `git checkout -- <dot 配置>` 会按「本地 git 操作」2 档放行。**源码路径（含 `dot-core`）不在其列**：5.6 档 6 的范围是「改这套系统自己的配置和账本」，源码改动靠快照与合并前复核。hands 侧仍应按方案做快照与工作区核对；这里的字符串判定不是安全边界。
9. 关键词匹配（`keywords.ts`）：英文/数字词两侧不能紧邻 `[a-z0-9]`（`.` `/` `_` `-` 都算分隔符），中文按子串。判定只吃 `labelText`（工具名、动作、flags、intent、命令程序名与非路径参数）；`targetsOf` 的目标和命令里像路径的参数走 `pathText`，只给 dot_self 与身份钱用。这样 `skill.ts`、`killer.txt`、`commit.md`、`token.ts`、`border.css` 这些文件名不会被当成危险或不可逆动作，而 `python read_password.py` 仍按身份钱落 5 档。新增关键词请加到 `keywords.ts` 的词表，不要再写裸正则。

