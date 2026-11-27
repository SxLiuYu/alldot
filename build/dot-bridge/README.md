# dot-bridge（127.0.0.1:8799）

桥 + 只读状态页。方案依据：`dot-合并方案-v2-定稿.md` 的 B.6、A.3、A.6、A.9、B.7。

- `GET /health`：活着、token 是否配置、大脑最后已知状态、网关 token 是否读到。
  **token 没配时回 503**（不是 200+ok:false）——keeper 只认 HTTP 成功，否则会把缺 token 的桥标绿。
- `GET /`：只读状态页，恢复报告在最上面，然后任务进度（账本模板卡原样贴）、待批、组件红绿。
- `GET /artifact/<hash>`：账本 `artifacts` 明细全文；真被回收回 404「已回收·原因」，
  哈希格式不对回 400、账本打不开回 503（不混用「已回收」）。
- `POST /mcp`：MCP streamable-http，五个工具 `brain_task / brain_status / brain_answer / brain_cancel / brain_reply`（brain_reply 只回答、不建任务）。
- `POST /notify`：把一张请示卡转给 ds-bot 8797 的 `send_to_bot`（A.6 的通知转发）。
  `send_to_bot` 的真实契约（`mcp-server.js:44-51/:193/:116-122/:268-276`）要求 `arguments`
  必带 `{bot, text}`；桥默认发总管 Chief 的 id，可用 `--dsbot-bot <id|名字>` 改。
  8797 回非 2xx 或 `result.isError:true`（HTTP 200 也可能）一律判失败：桥回 502，
  把 8797 原话带出来，并在 `<data-dir>/state/notify-errors.jsonl` 落一条 JSON 错误记录。

转发到 `http://127.0.0.1:18789/dot/bridge/v1/{tasks,status,approvals/<id>/decide,tasks/<id>/cancel}`。

## 两层 token（A.3）

| 层 | 谁校 | 头 | 来源 |
|---|---|---|---|
| 网关 | 18789 的 gateway 路由（`server-http.ts:357-388`） | `Authorization: Bearer <网关 token>` | `~/.allbot/allbot.json` 的 `gateway.auth.token`（只读） |
| 桥路由 | dot-core 的 `/dot/bridge/v1` handler | `x-dot-bridge-token: <桥 token>` | `~/.allbot/dot/bridge-token` |

桥（8799）自己对外仍认 `Authorization: Bearer <桥 token>`（直连状态页/MCP），
也认 `x-dot-bridge-token`；两个头同时出现时桥 token 取 `x-dot-bridge-token`。

桥**不写账本**：账本只用 `openLedger(..., {readOnly:true})` 打开（另加 `PRAGMA query_only=ON`）。
大脑连不上时状态页照常出，顶部标「大脑掉线（HH:MM 时起，已 N 分钟）」；
18789 在但 `/dot/bridge/v1` 路由不在时标「大脑插件没加载，手已停用」；token 被拒单独一档。

## 怎么起

```bash
# 1) 建桥 token（只做一次；文件权限尽量只给自己）
mkdir -p ~/.allbot/dot
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" > ~/.allbot/dot/bridge-token

# 2) 起桥（两种等价；keeper 也可能用 start.cmd 拉起）
node build/dot-bridge/index.mjs
#   或：build\dot-bridge\start.cmd

# 3) 验收
curl -s http://127.0.0.1:8799/health     # {"ok":true,...}
curl -s "http://127.0.0.1:8799/?token=$(cat ~/.allbot/dot/bridge-token)" | head
```

参数：`--port`、`--host`、`--data-dir`、`--ledger`、`--token-file`、`--keep`、`--config`、`--upstream`、`--dsbot`、`--dsbot-bot`、`--notify-error-log`、`--min-free-mb`、`--version`。
默认 `--data-dir ~/.allbot/dot`，其下 `bridge-token`、`ledger/dot.db`、`state/keep.json`；
`--config` 默认 `~/.allbot/allbot.json`（只读）。

## 装的时候要做什么（都写成了脚本，没动正式安装）

1. **建 `~/.allbot/dot/bridge-token`**（一行、非空）。没有它 `/health` 回 503，其余 503。
2. **给 ds-bot 的 10 个机器人挂 MCP 能力 `brain`**：
   ```bash
   # 先关 ds-bot（它运行中会写回 state.json）
   node build/dot-bridge/install-brain-capability.mjs          # 预演
   node build/dot-bridge/install-brain-capability.mjs --apply  # 备份 + 写 + 回读校验
   ```
   写的是 `C:/Users/1/.dsh/bot/state.json` 的 `capabilities.items.brain` 和每个 `bots[*].capabilities`；
   **两个头都带**（`Authorization: Bearer <token>` 与 `x-dot-bridge-token: <token>`，
   `install-brain-capability.mjs:124-125`），换传输不用改配置。`--no-auth-header` 则都不带。
3. **dot-core 侧挂 `/dot/bridge/v1` 路由**：在 dot-core 插件入口里调
   `registerBridgeRoutes(api, { db: () => ledger.db })`（`build/dot-core/src/bridge/routes.ts`）。
   路由用 `auth: "gateway"`（第一层），handler 里查 `x-dot-bridge-token`（第二层）。
4. **通知转发**：闸门建完 approvals 行后调
   `new BridgeNotifyClient({ token }).notify(approvalId)`，或调
   `POST http://127.0.0.1:8799/notify {"approval_id": "..."}`。
   桥会读账本 `detail_json` 渲染请示卡，再转 8797 的 `send_to_bot`；
   `arguments` 带 `bot`（默认 Chief 的 id，可 `--dsbot-bot` 改）和 `text`（卡片正文）。
   失败（非 2xx、`result.isError`、超时）桥回 502 并把 8797 原话带出来，同时落一条
   JSON 错误记录到 `<data-dir>/state/notify-errors.jsonl`。8797 的令牌发放仍未验证（S0-8）。
5. **keeper**：`GET http://127.0.0.1:8799/health` 通 → 绿；失败 → `node build/dot-bridge/index.mjs`
   （当前 keeper.ps1:341/374 找的就是 `build\dot-bridge\index.mjs`；`start.cmd` 兼容直接 cmd 启动的版本）。

## 与方案的对应

| 方案条目 | 落点 |
|---|---|
| B.6 `GET /health`、`GET /`、`POST /mcp` | `src/bridge/server.ts` |
| B.6 `/artifact/<hash>` | `view.ts: readArtifact`、`server.ts` |
| B.6 转发四路 + 两层 Bearer | `upstream.ts`、`routes.ts` |
| B.6 只读账本兜底、三种掉线提示 | `view.ts`、`page.ts`、`server.ts: probeBrain` |
| A.6 通知转发（→8797 send_to_bot） | `notify.ts`、`server.ts: /notify`、`routes.ts: /dot/bridge/v1/notify` |
| A.9 恢复报告在顶部 | `page.ts` |
| B.7 盘紧拒新任务 | `tools.ts: runBrainTask`、`keep.ts: diskAdmission` |
| B.7 keep.json 顶部一行 | `keep.ts: keepHeaderLine`（认 `disk.freeMb`、`backups.bytes/totalMb`、`balance.*.level`、`components` 映射与 `rows`） |
| B.9 审批条件更新、幂等 | `routes.ts: handleDecide` → ledger `decideApproval` |
| A.3 只听 127.0.0.1、两层 token | `server.ts`、`token.ts`、`routes.ts` |
| A.8 source_ref={bot,chat} | `tools.ts` 接受 `bot`/`chat_id`，`routes.ts` 原样落库 |
| B.8 tasks.restated | `tools.ts`、`routes.ts` |

## 目录分工（与 B.6 的偏差，已记账）

B.6 估桥本体 700–1100 行都放 `build/dot-bridge/`。实际共享代码在
`build/dot-core/src/bridge/`（server/page/tools/mcp/keep/view/token/upstream），
`build/dot-bridge/` 只有入口、start.cmd、安装脚本与入口测试。原因是后端要用同一份
token/HTTP/MCP 逻辑，复制两份会分叉。桥进程因此会加载 ledger 的写函数，
但只用 `openLedger(readOnly)` + `query_only` 打开账本，行为上不违反 A.2。
