# ds-bot 口闸补丁：安装步骤（写在这里，等用户点头才执行）

这份文件只说明**装的时候要做什么**。交付阶段没有对 `C:/Users/1/.dsh/` 下任何文件做过写入；正式安装的 `tools.js` 至今仍是 pristine（sha256 `24387293ca4d25c1f6ce91be7e717f5cc033fe31becc80e076e8124c43c197c9`）。

## 硬前提

1. 用户明确同意安装，且**先把 ds-bot 停掉**。ds-bot 的 ESM 模块 `tools.js` 改文件不重启不生效（方案 B.1、附录 D D63）。
2. 版本必须是 0.3.9。核对：
   ```bash
   grep '"version"' "C:/Users/1/.dsh/profiles/desktop/node_modules/ds-bot/package.json"
   ```

## 安装顺序（每步都要人工确认后再做）

1. **停 ds-bot**（DeepSeek Harness 客户端里退出 desktop profile；不要由脚本代停）。确认进程表没有带 `profiles/desktop` 的 `DeepSeek Harness.exe`。
2. **备份**：把 `C:/Users/1/.dsh/profiles/desktop/node_modules/ds-bot/src/host/tools.js` 复制一份到 build 下的 `backup/`（repair.mjs 真写时会自动备份，也可手动先备）。
3. **写入补丁**：从 `build/patches/ds-bot/patched/src/host/tools.js` 复制到目标路径；或用
   ```bash
   node build/patches/ds-bot/repair.mjs --apply --i-know-ds-bot-must-be-stopped
   # 方案 B.11 的等价路径（转发脚本）：
   node build/tools/repair-ds-bot.mjs --apply --i-know-ds-bot-must-be-stopped
   ```
   repair 会按哈希三分支：patched 无事 / pristine 重插并备份 / 版本变了停下报「需人工重做」。
4. **配置数据文件（另一次确认）**：按方案 B.1 数据侧，建 `C:/Users/1/.dsh/plugins/dot-bot-policy/policy.json`（6 个说话工具名单），加 MCP 能力 `brain` 到 `state.json`。**state.json 只能在 ds-bot 停着的时候改**（运行中会被 `rt.save()` 覆盖）。
5. **启动 ds-bot**。启动后写口闸心跳文件 `C:/Users/1/.dsh/bot/dot-guard-heartbeat.json`，内容形如：
   ```json
   { "patchedAt": <启动后的毫秒时间戳>, "ts": "<ISO>", "sha256": "<patched tools.js 的 sha256>" }
   ```
   施工时可由打补丁脚本/看门狗写；`verify.mjs --write-heartbeat` 也提供显式写入开关，默认关。
6. **验收**：
   ```bash
   node build/patches/ds-bot/verify.mjs
   # 方案 B.11/附录 C 的等价路径（转发脚本）：
   node build/tools/verify-ds-bot.mjs
   ```
   预期五道全 PASS。第 ⑤ 道判据是「ds-bot 进程在补丁写盘之后启动，且心跳新于进程启动」；进程早于补丁启动（ESM 旧代码驻留）时无论心跳多新都报「已打补丁未生效，请重启 ds-bot」，不能报绿。

## 回滚

停 ds-bot → 从 `backup/` 里把 pristine 版本复制回目标路径 → 启动 ds-bot。repair 的 pristine 哈希是 `24387293ca4d25c1f6ce91be7e717f5cc033fe31becc80e076e8124c43c197c9`。
