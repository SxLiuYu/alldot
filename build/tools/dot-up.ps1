# build/tools/dot-up.ps1 —— 一个入口，把 alldot 要的服务全拉起来（幂等）
#
# 为什么要有它：以前是「看门狗管六个服务、每个服务一条拉起命令、hands-up.ps1 里又抄一份
# Playwright 的参数」。三处各写一遍，改端口就得改三处，忘了就出现「服务在跑、探针说没起」。
# 现在起法只有一个：命令都从 ~/.allbot/dot/keeper-start.json 读，缺哪条用内置默认，
# 谁红就起谁，已经在跑的一个都不动。
#
# 六个服务（顺序即启动顺序，互不依赖，但网关最慢，先起它）：
#   18789  网关（allbot gateway，dot-core 插件、桥路由 /dot/bridge/v1 都在里面）
#    8799  dot-bridge（独立入口，ds-bot / exe 走这条）
#    8000  电脑手（Windows-MCP）
#    8931  已登录浏览器（Playwright MCP，带登录态）
#    8932  干净浏览器（Playwright MCP，--isolated）
#    8933  微信手（wechat-mcp 的 streamable-HTTP 入口）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File dot-up.ps1            # 缺哪个起哪个
#   powershell -ExecutionPolicy Bypass -File dot-up.ps1 -Check     # 只体检，一个都不起（有机器的服务能红/绿）
#   powershell -ExecutionPolicy Bypass -File dot-up.ps1 -Only 8933 # 只处理一个（排错用）
#
# 退出码：0 全在跑；1 有缺的（或 -Check 时有红的）。
# 注意：网关冷启动实测 4 分半到 5 分钟，别用 60 秒超时去判它死了。

param(
    [switch]$Check,
    # 网关不归这个脚本管：keeper 那条路有退避和 fail-closed 停网关的逻辑，
    # 混进来会让「该停的时候停不掉」。keeper 调用时带这个开关。
    [switch]$SkipGateway,
    [string]$Only = ''
)

$ErrorActionPreference = 'Continue'
$logDir = 'C:/Users/1/.allbot/dot/logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # build/tools → <repo>
$bridgeEntry = Join-Path $repoRoot 'build\dot-bridge\index.mjs'
$gatewayCmdDefault = Join-Path $env:USERPROFILE '.allbot\gateway.cmd'

# ── 启动命令的唯一来源：keeper-start.json（keeper 也读这一份） ──────────────
$startCfgPath = Join-Path $env:USERPROFILE '.allbot\dot\keeper-start.json'
$startCfg = $null
if (Test-Path $startCfgPath) {
    try { $startCfg = Get-Content -Raw -Encoding UTF8 $startCfgPath | ConvertFrom-Json } catch { $startCfg = $null }
}
function Get-StartCmd([string]$name, [string]$default = '') {
    if ($null -ne $startCfg) {
        $v = $startCfg.$name
        if ($null -ne $v -and ([string]$v).Trim() -ne '') { return [string]$v }
    }
    return $default
}

# 注意：Playwright MCP 只监听 ::1（IPv6 的 localhost），TcpClient 默认却是 IPv4，
# 所以按地址族各 造一个 socket，两个地址都试。变量名别叫 $host（PowerShell 只读自动变量）。
function Test-Port([int]$port, [int]$timeoutMs = 700) {
    foreach ($addr in @('127.0.0.1', '::1')) {
        $family = if ($addr -like '*:*') {
            [System.Net.Sockets.AddressFamily]::InterNetworkV6
        } else {
            [System.Net.Sockets.AddressFamily]::InterNetwork
        }
        $client = New-Object System.Net.Sockets.TcpClient -ArgumentList $family
        try {
            $task = $client.ConnectAsync($addr, $port)
            if ($task.Wait($timeoutMs) -and $client.Connected) { return $true }
        } catch { } finally { $client.Close() }
    }
    return $false
}

function Test-Http([string]$uri, [int]$timeoutSec = 8) {
    try {
        $null = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec $timeoutSec -ErrorAction Stop
        return $true
    } catch {
        # 有应答但状态码不好也算「进程在」——只看连不上
        if ($null -ne $_.Exception.Response) { return $true }
        return $false
    }
}

# 服务表：port / 名称 / 探法 / 启动命令 / 日志名 / 起来要等多久
$services = @(
    @{ port = 18789; name = '网关（dot-core + 桥路由）'; kind = 'tcp'; log = 'gateway.log'
       cmd = (Get-StartCmd 'gateway_cmd' $gatewayCmdDefault); waitSec = 330 },
    @{ port = 8799;  name = 'dot-bridge（ds-bot / exe 走这条）'; kind = 'tcp'; log = 'dot-bridge-8799.log'
       cmd = ('node "' + $bridgeEntry + '"'); waitSec = 60 },
    @{ port = 8000;  name = '电脑手（Windows-MCP）'; kind = 'tcp'; log = 'windows-mcp.log'
       cmd = (Get-StartCmd 'windows_mcp_cmd' ''); waitSec = 60 },
    @{ port = 8931;  name = '已登录浏览器（logged_browser）'; kind = 'tcp'; log = 'pw-8931.log'
       cmd = (Get-StartCmd 'playwright_mcp_cmd' ''); waitSec = 60 },
    @{ port = 8932;  name = '干净浏览器（clean_browser）'; kind = 'tcp'; log = 'pw-8932.log'
       cmd = (Get-StartCmd 'clean_browser_cmd' ''); waitSec = 60 },
    @{ port = 8933;  name = '微信手（wechat-mcp）'; kind = 'tcp'; log = 'wechat-mcp.log'
       cmd = (Get-StartCmd 'wechat_cmd' ''); waitSec = 90 }
)

if ($SkipGateway) {
    $services = @($services | Where-Object { [int]$_.port -ne 18789 })
}

if ($Only -ne '') {
    $services = @($services | Where-Object { [string]$_.port -eq $Only })
    if ($services.Count -eq 0) { Write-Host ("没有端口 {0} 这一项" -f $Only) -ForegroundColor Red; exit 1 }
}

function Start-One($svc) {
    $stamp = Get-Date -Format 'HHmmss'
    $out = Join-Path $logDir ($svc.log -replace '\.log$', "-$stamp.log")
    $cmd = [string]$svc.cmd
    if ($cmd.Trim() -eq '') {
        Write-Host ("  [跳过] {0,-28} :{1}  没有启动命令（keeper-start.json 里配一条）" -f $svc.name, $svc.port) -ForegroundColor Yellow
        return $false
    }
    try {
        # 重定向交给内层 cmd 做（>> 日志 2>&1），不要用 Start-Process 的 -RedirectStandardOutput：
        # 那样被拉起的服务会继承调用者的输出句柄，父进程（keeper / 管道）永远等不到句柄关闭，
        # 表现就是「服务明明起来了，脚本和看门狗卡死不走」（2026-11-25 实测两次）。
        # 不能再给整条命令套一层引号：命令本身可能就带引号（cd /d "D:/某项目" && "python.exe" ...），
        # 套上去 cmd 会认成「一个带引号的程序名」直接失败，日志文件都不会建（2026-11-25 实测）。
        $line = $cmd + ' >> "' + $out + '" 2>&1'
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $line) -WindowStyle Hidden | Out-Null
    } catch {
        Write-Host ("  [起不来] {0,-28} {1}" -f $svc.name, $_.Exception.Message) -ForegroundColor Red
        return $false
    }
    $waited = 0
    while ($waited -lt [int]$svc.waitSec) {
        Start-Sleep -Seconds 5
        $waited += 5
        if (Test-Port ([int]$svc.port)) {
            Write-Host ("  [已拉起] {0,-28} :{1}（等了 {2}s，日志 {3}）" -f $svc.name, $svc.port, $waited, $out) -ForegroundColor Green
            return $true
        }
        # 进程可能起来了但端口还没听 —— 只要命令本身挂了就别白等
        if ($waited -eq 30 -and -not (Test-Port ([int]$svc.port))) {
            $errFile = $out + '.err'
            if ((Test-Path $errFile) -and ((Get-Item $errFile).Length -gt 0)) {
                # 继续等：MCP 服务常在 stderr 打一堆 warning 之后才监听
            }
        }
    }
    Write-Host ("  [超时] {0,-28} :{1} {2} 秒没通，看 {3}" -f $svc.name, $svc.port, $svc.waitSec, $out) -ForegroundColor Red
    if (Test-Path $out) {
        $tail = @(Get-Content -Tail 5 -Encoding UTF8 $out 2>$null)
        if ($tail.Count -gt 0) { Write-Host ('    日志尾部：' + (($tail | Out-String).Trim())) -ForegroundColor DarkYellow }
    } else {
        Write-Host '    日志文件都没生成：说明启动命令本身没跑起来（引号/路径问题）' -ForegroundColor DarkYellow
    }
    return $false
}

Write-Host ('alldot 服务盘点（{0}）：' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$okCount = 0
foreach ($svc in $services) {
    $alive = Test-Port ([int]$svc.port)
    if ($alive) {
        Write-Host ("  [在跑]   {0,-28} :{1}" -f $svc.name, $svc.port) -ForegroundColor Green
        $okCount++
        continue
    }
    if ($Check) {
        Write-Host ("  [没起]   {0,-28} :{1}" -f $svc.name, $svc.port) -ForegroundColor Red
        continue
    }
    Write-Host ("  [要拉起] {0,-28} :{1}" -f $svc.name, $svc.port) -ForegroundColor Yellow
    if (Start-One $svc) { $okCount++ }
}

Write-Host ''
Write-Host ("结果：{0}/{1} 个服务在跑" -f $okCount, $services.Count)
if ($okCount -lt $services.Count) {
    Write-Host '缺的服务等于对应的那只手/那条路调了就是「干不了」。日志在 C:\Users\1\.allbot\dot\logs' -ForegroundColor Yellow
}
if ($okCount -eq $services.Count) { exit 0 } else { exit 1 }
