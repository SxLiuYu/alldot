# build/package/build-dist.ps1 —— build alldot 完整版分发包。
#
# 产出：build/package/alldot-dist/ 目录，可直接压缩发给别人。
# 用法：powershell -ExecutionPolicy Bypass -File build/package/build-dist.ps1
#
# 包含：
#   app/node/          便携 Node.js 运行时（自动下载）
#   app/dot-core/      项目主代码（TypeScript）
#   app/tools/         启动脚本、看门狗
#   app/ui/            C# 界面 exe
#   installer.exe      安装向导（C# WinForms）
#   uninstall.exe      卸载程序

param(
    [string]$NodeVersion = "22.12.0",
    [switch]$SkipDownload,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$DistDir = Join-Path $PSScriptRoot "alldot-dist"
$AppDir = Join-Path $DistDir "app"

Write-Host "=== alldot Distribution Build ===" -ForegroundColor Cyan
Write-Host "Project root：$ProjectRoot"
Write-Host "Output dir：$DistDir"

# 1. 清理旧包
if ($Clean -and (Test-Path $DistDir)) {
    Remove-Item $DistDir -Recurse -Force
    Write-Host "[Clean] Old alldot-dist removed"
}

# 2. 创建目录结构
$dirs = @($AppDir, "$AppDir\node", "$AppDir\dot-core", "$AppDir\tools", "$AppDir\ui")
foreach ($d in $dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Write-Host "[Dirs] Structure created"

# 3. 下载便携 Node.js
$NodeDir = "$AppDir\node"
$NodeExe = "$NodeDir\node.exe"
if (-not (Test-Path $NodeExe) -and -not $SkipDownload) {
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $zipUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$arch.zip"
    $zipPath = Join-Path $env:TEMP "node-$NodeVersion.zip"

    Write-Host "[Download] Node.js v$NodeVersion ($arch)..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
        Write-Host "[Extract] Portable Node.js..."
        Expand-Archive -Path $zipPath -DestinationPath $env:TEMP -Force
        $extracted = Get-ChildItem $env:TEMP -Directory | Where-Object { $_.Name -like "node-v$NodeVersion-win*" } | Select-Object -First 1
        if ($extracted) {
            Copy-Item "$($extracted.FullName)\*" $NodeDir -Recurse -Force
            Remove-Item $extracted.FullName -Recurse -Force
        }
        Remove-Item $zipPath -Force
        Write-Host "[Done] Portable Node.js ready"
    } catch {
        Write-Warning "Download Node.js failed：$_"
        Write-Warning "Please manually download $zipUrl and extract to $NodeDir"
    }
} elseif (Test-Path $NodeExe) {
    Write-Host "[Skip] Portable Node.js exists"
}

# 4. 复制 dot-core 源码
Write-Host "[Copy] dot-core source..."
$excludeDirs = @("node_modules", ".git", ".zcode", "test", "tmp")
$excludeFiles = @("*.log", "*.tmp", "*.bak")

function Copy-ProjectFiles($src, $dst, $exDirs, $exFiles) {
    Get-ChildItem $src -Force | ForEach-Object {
        $name = $_.Name
        if ($_.PSIsContainer) {
            if ($exDirs -notcontains $name) {
                $newDst = Join-Path $dst $name
                New-Item -ItemType Directory -Force -Path $newDst | Out-Null
                Copy-ProjectFiles $_.FullName $newDst $exDirs $exFiles
            }
        } else {
            $skip = $false
            foreach ($pat in $exFiles) { if ($name -like $pat) { $skip = $true; break } }
            if (-not $skip) {
                Copy-Item $_.FullName $dst -Force
            }
        }
    }
}

Copy-ProjectFiles "$ProjectRoot\build\dot-core\src" "$AppDir\dot-core\src" $excludeDirs $excludeFiles
Copy-ProjectFiles "$ProjectRoot\build\dot-core" "$AppDir\dot-core" @("node_modules", ".git", ".zcode", "src") @("*.log", "*.tmp")
Copy-Item "$ProjectRoot\build\dot-core\package.json" "$AppDir\dot-core\" -Force -ErrorAction SilentlyContinue
Copy-Item "$ProjectRoot\build\dot-core\tsconfig.json" "$AppDir\dot-core\" -Force -ErrorAction SilentlyContinue

# 5. 复制工具脚本
Write-Host "[Copy] tool scripts..."
$toolFiles = @("dot-up.ps1", "keeper.ps1", "keeper-install.ps1", "hands-up.ps1", "dot-errors.mjs", "ledger-sweep.mjs")
foreach ($tf in $toolFiles) {
    $src = Join-Path "$ProjectRoot\build\tools" $tf
    if (Test-Path $src) { Copy-Item $src "$AppDir\tools\" -Force }
}

# 6. Copy UI exe
Write-Host "[Copy] UI..."
$uiExe = "$ProjectRoot\build\ui\dist\alldot.exe"
if (Test-Path $uiExe) {
    Copy-Item $uiExe "$AppDir\ui\alldot-ui.exe" -Force
} else {
    Write-Warning "alldot-ui.exe not found, skip（Run first build/ui/compile.ps1 build）"
}

# 7. 生成默认配置模板
Write-Host "[Config] Generate template..."
$configTemplate = @{
    model = @{
        provider = "openai-compatible"
        baseUrl  = "https://api.deepseek.com/v1"
        apiKey   = ""
        model    = "deepseek-chat"
    }
    workspace = ""  # setup wizard fills this
    budget    = @{ tokens = 2000000 }
    approvals = @{ auto_approve_max_tier = 1 }
} | ConvertTo-Json -Depth 5
$configTemplate | Out-File "$AppDir\config-template.json" -Encoding utf8

# 8. 生成安装脚本（嵌入 installer.exe 的核心逻辑）
$setupScript = 'Write-Host "Use app\setup.ps1 for first-run setup"'
$setupScript | Out-File "$AppDir\setup.ps1" -Encoding utf8

# 9. 统计
$fileCount = (Get-ChildItem $DistDir -Recurse -File).Count
$totalSize = [math]::Round((Get-ChildItem $DistDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)

Write-Host ""
Write-Host "=== build完成 ===" -ForegroundColor Green
Write-Host "Files：$fileCount"
Write-Host "Total size：$totalSize MB"
Write-Host "输出：$DistDir"
Write-Host ""
Write-Host "Next steps：" -ForegroundColor Yellow
Write-Host "  1. Zip alldot-dist and send"
Write-Host "  2. Recipient runs app\setup.ps1"
Write-Host "  3. Or use build/installer/compile-installer.ps1 to create single setup.exe"
