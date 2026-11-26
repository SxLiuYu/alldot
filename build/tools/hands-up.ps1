# build/tools/hands-up.ps1 —— 【兼容壳】一个入口把服务拉起来，本体在 dot-up.ps1
#
# 以前这个文件自己抄了一份 Playwright 参数和 Windows-MCP 路径，跟 keeper-start.json、
# keeper.ps1 各写一遍，改端口就会漏改。2026-11-25 起全部收到 dot-up.ps1：
# 命令只从 ~/.allbot/dot/keeper-start.json 读一份，谁红起谁。
#
# 用法没变（老脚本、老文档、快捷方式照旧能跑）：
#   powershell -ExecutionPolicy Bypass -File hands-up.ps1            # 缺哪个起哪个
#   powershell -ExecutionPolicy Bypass -File hands-up.ps1 -Check     # 只体检

param([switch]$Check)

$up = Join-Path $PSScriptRoot 'dot-up.ps1'
if (-not (Test-Path $up)) {
    Write-Host ("找不到 $up —— dot-up.ps1 才是本体") -ForegroundColor Red
    exit 1
}
if ($Check) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $up -Check
} else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $up
}
exit $LASTEXITCODE
