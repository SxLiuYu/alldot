# alldot

个人 AI 助手：让 LLM 自己动手处理文件、浏览器、桌面操作等日常任务。

## 功能

- **自动拆解任务** — 一句话描述任务，自动拆成可验收的里程碑逐步执行
- **文件操作** — 读写文件、建目录、整理文件夹
- **浏览器操作** — 打开网页、填表、截图（支持已登录/干净两种模式）
- **桌面操作** — 鼠标键盘自动化（带安全护栏：危险操作需人工审批）
- **任务契约** — 每个任务可以定义约束条件和交付物，系统自动检查是否达标
- **完整审计** — 每步操作记录在账本里，可追溯、可回放
- **看门狗** — 自动检测服务状态，挂了自动重启

## 快速开始

### 1. 安装

下载发布包，解压后运行 `setup.exe`，按向导配置模型 API。

### 2. 配置模型

alldot 支持任何 OpenAI 兼容接口：

| 服务商 | API 地址 | 模型名 |
|--------|---------|--------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

配置写在 `~/.allbot/allbot.json`：

```json
{
  "models": {
    "providers": {
      "local": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "sk-your-key-here",
        "model": "deepseek-chat"
      }
    }
  }
}
```

### 3. 使用

安装后桌面会有快捷方式。双击打开界面，输入任务描述即可。

也可以通过桥 API（MCP 协议）派发任务，适合接入机器人/IM。

## 架构

```
alldot
├── dot-core/          核心引擎（TypeScript）
│   ├── dispatch/      任务派发 + 工人循环
│   ├── plan/          任务契约 + 自动拆解
│   ├── hands/         文件/浏览器/桌面手
│   ├── ledger/        审计账本（SQLite）
│   └── bridge/        桥接层（HTTP + MCP）
├── tools/             运维工具（启动/看门狗/清扫）
└── ui/                桌面界面（C# WinForms）
```

**任务契约**（来自 [DesignAnything](https://arxiv.org/abs/2610.24771) 论文）：每个任务可以声明约束（contains/equal/regex/range/exists）和交付物清单，系统自动检查达成率、指导下一步。

## 开发

```bash
# 跑测试
cd build/dot-core
node --test --experimental-strip-types src/**/*.test.ts

# 启动服务
powershell -File build/tools/dot-up.ps1

# 构建分发包
powershell -File build/package/build-dist.ps1

# 编译安装器
powershell -File build/installer/compile-installer.ps1
```

## 系统要求

- Windows 10/11（64 位）
- Node.js 22+（分发包自带便携版）
- .NET Framework 4.x（Windows 自带）
- 一个 OpenAI 兼容的 LLM API

## License

[MIT](LICENSE)
