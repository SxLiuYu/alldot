# build/ui/build-ui.ps1 —— 一条命令重建 alldot.exe（编译 → 签名 → 去下载标记）
#
# 为什么要有这个脚本：编译参数很长（四个内嵌资源、两个 SDK 引用、清单），手敲一次就错一次；
# 而且签名必须在编译之后，漏了这一步 Windows 就会显示「未知发布者」。
#
# 参数：
#   -NoInstall   只编译，不复制到 %USERPROFILE%\alldot、也不动桌面快捷方式
#
# 用法（在任意目录）：
#   powershell -ExecutionPolicy Bypass -File C:\Users\1\Documents\研究\dot\build\ui\build-ui.ps1
#
# 依赖（脚本会自动补齐）：系统自带 csc.exe（.NET 4.8）、WebView2 SDK 的两个托管 DLL 与 x64 加载器。

param([switch]$NoInstall)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$out = Join-Path $here 'dist\alldot.exe'
$lib = Join-Path $here 'lib'

if (-not (Test-Path $csc)) { throw "找不到编译器：$csc（这台机器缺 .NET Framework 4.x）" }

# 1) WebView2 SDK：缺了就现取（nuget 的扁平容器地址，不依赖包管理器）
$need = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
$missing = @($need | Where-Object { -not (Test-Path (Join-Path $lib $_)) })
if ($missing.Count -gt 0) {
    Write-Host "缺少 $($missing -join ', ')；从 nuget 取 WebView2 SDK…"
    New-Item -ItemType Directory -Force -Path $lib | Out-Null
    $ver = '1.0.2903.40'
    $zip = Join-Path $here 'deps\webview2.zip'
    New-Item -ItemType Directory -Force -Path (Join-Path $here 'deps') | Out-Null
    if (-not (Test-Path $zip)) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$ver/microsoft.web.webview2.$ver.nupkg" -OutFile $zip
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $map = @{
            'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
            'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
            'build/native/x64/WebView2Loader.dll' = 'WebView2Loader.dll'
        }
        foreach ($k in $map.Keys) {
            $entry = $z.Entries | Where-Object { $_.FullName -eq $k } | Select-Object -First 1
            if (-not $entry) { throw "压缩包里没有 $k" }
            $dest = Join-Path $lib $map[$k]
            if (Test-Path $dest) { Remove-Item $dest -Force }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
        }
    } finally { $z.Dispose() }
}

# 2) 编译（页面、两个 SDK 程序集、加载器都作为资源编进去；带 asInvoker 清单）
New-Item -ItemType Directory -Force -Path (Join-Path $here 'dist') | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }
& $csc -nologo -target:winexe -platform:x64 -optimize+ `
    "-win32manifest:$here\alldot.manifest" `
    "-out:$out" `
    "-resource:$here\page.html,page.html" `
    "-resource:$lib\WebView2Loader.dll,WebView2Loader.dll" `
    "-resource:$lib\Microsoft.Web.WebView2.Core.dll,Microsoft.Web.WebView2.Core.dll" `
    "-resource:$lib\Microsoft.Web.WebView2.WinForms.dll,Microsoft.Web.WebView2.WinForms.dll" `
    "-r:$lib\Microsoft.Web.WebView2.Core.dll" `
    "-r:$lib\Microsoft.Web.WebView2.WinForms.dll" `
    -r:System.Web.Extensions.dll `
    -r:System.Net.Http.dll `
    (Join-Path $here 'AlldotUi.cs') `
    (Join-Path $here 'AlldotJudge.cs')
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

# 3) 签名：证书没有就建一个自签的，并把证书装进「受信任的根」与「受信任的发布者」，
#    否则每次双击都会弹「未知发布者 / 是否允许」。
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq 'CN=alldot local' } | Select-Object -First 1
if (-not $cert) {
    Write-Host '建一张本机代码签名证书（CN=alldot local）…'
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=alldot local' `
        -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
    $cer = Join-Path $here 'alldot-local.cer'
    Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
}
Unblock-File $out
Set-AuthenticodeSignature -FilePath $out -Certificate $cert | Out-Null
$sig = (Get-AuthenticodeSignature $out).Status
$kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "编好了：$out（$kb KB，签名 $sig）"
if ($sig -ne 'Valid') { Write-Warning "签名状态不是 Valid（$sig）：双击仍可能弹窗" }

# 4) 装到用户目录并刷新桌面快捷方式（正在运行时跳过，避免覆盖被占用的 exe）
if ($NoInstall) {
    Write-Host '按 -NoInstall 跳过安装。'
    exit 0
}
if (Get-Process alldot -ErrorAction SilentlyContinue) {
    Write-Warning 'alldot 正在运行，跳过安装与快捷方式：先关掉窗口再重跑本脚本'
    exit 0
}
$target = Join-Path $env:USERPROFILE 'alldot'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item $out (Join-Path $target 'alldot.exe') -Force
$desk = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desk 'alldot.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $target 'alldot.exe'
$lnk.WorkingDirectory = $target
$lnk.Description = 'alldot 本地助手'
$lnk.Save()
Write-Host "已装到 $target，桌面快捷方式已刷新：$lnkPath"
