# build/installer/compile-installer.ps1 —— 编译 alldot 安装器。
#
# 产出：build/installer/setup.exe（单文件，约 150 KB）
# 用法：powershell -ExecutionPolicy Bypass -File build/installer/compile-installer.ps1
#
# 依赖：.NET Framework 的 csc.exe（Windows 自带，通常在
#   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe）

param(
    [string]$Output = "setup.exe"
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$SrcFile = Join-Path $ScriptDir "Setup.cs"
$OutFile = Join-Path $ScriptDir $Output

# 找 csc.exe
$cscPaths = @(
    "${env:WINDIR}\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "${env:WINDIR}\Microsoft.NET\Framework\v4.0.30319\csc.exe",
    "${env:WINDIR}\Microsoft.NET\Framework64\v3.5\csc.exe"
)

$csc = $cscPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
    Write-Error "csc.exe not found (.NET Framework compiler). Install .NET Framework 4.x."
    exit 1
}

Write-Host "=== 编译 alldot 安装器 ===" -ForegroundColor Cyan
Write-Host "编译器：$csc"
Write-Host "源文件：$SrcFile"
Write-Host "输出：$OutFile"

# 编译
# Use native PowerShell to avoid Git Bash path mangling
& $csc /nologo /target:winexe /out:$OutFile `
    /reference:System.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.IO.Compression.dll `
    /reference:System.IO.Compression.FileSystem.dll `
    /reference:System.Net.Http.dll `
    $SrcFile

if ($LASTEXITCODE -eq 0) {
    $size = [math]::Round((Get-Item $OutFile).Length / 1KB, 1)
    Write-Host ""
    Write-Host "=== Build OK ===" -ForegroundColor Green
    Write-Host "输出：$OutFile（$size KB）"
    Write-Host ""
    Write-Host "用法：" -ForegroundColor Yellow
    Write-Host "  双击 setup.exe 运行安装向导"
    Write-Host "  setup.exe --uninstall 运行卸载"
} else {
    Write-Error "编译失败，退出码 $LASTEXITCODE"
}
