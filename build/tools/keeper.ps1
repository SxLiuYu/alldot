<#
.SYNOPSIS
  dot-keeper：巡检调度、探针状态文件、账本每日备份。依据 dot-合并方案-v2-定稿.md 附录 B.7、B.11。

.DESCRIPTION
  职责（B.7 原文口径）：
    1) 巡检表：3065（GET /v1/models，只报红，永不代拉）、18789（GET /api/status → 起 gateway.cmd，
       退避每小时最多 5 次）、dot-core 加载状态（有「未加载」证据 → 停网关 + 标红，fail-closed）、
       8799（GET /health → 起 dot-bridge）、8000（MCP initialize → 按已配参数拉起）、
       8931（TCP → 拉起已装好的 Playwright MCP）、口闸 verify（每小时一次）、
       ds-bot 是否在跑（不主动拉，只标「脸没开，审批没人点」）。
    2) 磁盘与模型账户探针：**判定不在本脚本里**，由 probe-health.mjs（B.11）做，
       keeper 每轮调它、读它的 JSON。一份判定，不分叉。
    3) 账本每日一份备份（用 keeper-ledger.mjs 的 VACUUM INTO），保留 14 份；
       备份总占用超上限时只**给出减份建议**写进 keep.json，删文件的是 dot-core 的
       src/maintenance（B.7：「回收由 dot-core 的 src/maintenance 做，keeper 不删任何东西」）。
    4) 写自己的状态文件 <user>\.allbot\dot\state\keep.json（keeper 独占写，不进账本），
       字段形状对齐 dot-core/src/bridge/keep.ts 的读法，桥直接可读。
    5) 恢复报告联动（A.9 第 5 步）：巡检报告落 state\keeper-report.json 供状态页横幅读取；
       同时追加到 state\keeper-report-queue.jsonl，由 dot-core 的 maintenance 调
       keeper-ledger.mjs drain 写进账本 events（type='keeper_report'）。
       **keeper 自己不写 events**：账本唯一写入口是 dot-core。

  dot-core 加载状态的两个信号源（契约）：
    - 心跳文件 <user>\.allbot\dot\state\dot-core.heartbeat：dot-core 定期 touch，超过 600s 算过期。
      过期 = 有「未加载」证据 → 停网关（fail-closed）。
    - 网关 GET /api/status 里的 `"dot-core": {"loaded": true}` 标记（现在的状态接口还没有这项，
      B.4 的 dot-core 交付时要加）。
    两个都没有（且没有心跳文件）= 无法判断，报黄，**不**停网关：没有证据就停网关会变成起停循环。

  默认是 dry-run：只报不动作，也不跑口闸 verify（verify 会起子进程）。要真动作必须加 -Execute。
  dry-run 下探针照跑（会给 3065 发 max_tokens=1 的探测请求，与执行模式同一个判定），
  差别只在：不起停进程、不建备份、不跑 verify。

.PARAMETER PlanFile
  用预置巡检输入代替真实探针（测试与演练用）。JSON 字段：
    { "now": ISO,
      "probes": { "modelPool": {ok,status,error}, "gateway": {...},
                  "dotCore": {loaded,known,source,detail},
                  "bridge": {...}, "windowsMcp": {ok,detail}, "playwright": {ok,detail},
                  "gateVerify": {ok,ran,detail}, "dsbot": {running,detail},
                  "balance": { "enabled": bool, "cheap": {level,note}, "balanced": {...}, "strong": {...} } },
      "disk": { "freeMb": N|null, "ledgerFreeMb": N|null, "allbotFreeMb": N|null },
      "backups": { "count": N, "totalMb": N, "todayPresent": bool, "names": [...] },
      "startables": { "gatewayCmd": bool, "gatewayPath": str, "bridgeCmd": bool, "bridgePath": str,
                      "windowsMcpCmd": str, "playwrightCmd": str, "verifyScript": bool, "verifyPath": str },
      "keeperTask": { "exists": bool, "enabled": bool },
      "gatewayStarts": [ISO...], "gatewayStops": [ISO...],
      "gateVerifyLastRunAt": ISO|null, "gateVerifyLastOk": bool|null, "gateVerifyLastDetail": str }

.PARAMETER Json
  只往 stdout 打一行 JSON（供测试与桥消费）。

.PARAMETER JsonOut
  额外把同一份 JSON 写到这个路径（UTF-8 无 BOM）。

.PARAMETER StateFile
  keep.json 路径，默认 <user>\.allbot\dot\state\keep.json。

.PARAMETER BackupDir
  账本备份目录，默认 <user>\.allbot\dot\backups。

.PARAMETER LedgerDbPath
  账本库，默认 <user>\.allbot\dot\ledger\dot.db。

.PARAMETER NoLedger
  不调 keeper-ledger.mjs（不读账本、不备份）。

.PARAMETER NoState
  不写 keep.json / 巡检报告 / 队列（纯观察，测试用）。

.NOTES
  PS 5.1 兼容（本机只有 Windows PowerShell 5.1.19041）。文件必须带 UTF-8 BOM，否则 5.1 按 GBK 读中文。
  退出码：0 = 巡检完成（红也是正常结果）；2 = 脚本自身出错（计划任务的「失败自动重启」靠它）。
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$DryRun,
    [switch]$Json,
    [string]$JsonOut = "",
    [string]$PlanFile = "",
    [string]$StateFile = "",
    [string]$BackupDir = "",
    [string]$LedgerDbPath = "",
    [string]$DotRoot = "",
    [int]$BackupKeep = 14,
    [double]$DiskFreeMbOverride = -1,
    [switch]$NoLedger,
    [switch]$NoState
)

$ErrorActionPreference = 'Continue'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8NoBom } catch { }
try { $OutputEncoding = $utf8NoBom } catch { }

# ---------------------------------------------------------------------------
# 小工具（必须定义在使用之前：PowerShell 按执行顺序解析函数名）
# ---------------------------------------------------------------------------
function Get-Prop {
    param($Obj, [string]$Name, $Default = $null)
    if ($null -eq $Obj) { return $Default }
    if ($Obj -is [System.Collections.IDictionary]) {
        if ($Obj.Contains($Name)) { return $Obj[$Name] }
        return $Default
    }
    $p = $Obj.PSObject.Properties[$Name]
    if ($null -eq $p) { return $Default }
    return $p.Value
}

function To-Bool {
    param($Value, [bool]$Default = $false)
    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { return $Value }
    $s = ([string]$Value).ToLowerInvariant()
    return ($s -eq 'true' -or $s -eq '1' -or $s -eq 'yes')
}

function Get-NowUtc {
    return [datetime]::UtcNow
}

function Format-Iso {
    param([datetime]$At)
    return $At.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Parse-IsoSafe {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    try {
        return [datetime]::Parse($Text, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    } catch {
        return $null
    }
}

function Write-JsonFile {
    param([string]$Path, $Value)
    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Invoke-HttpProbe {
    param(
        [string]$Uri,
        [int]$TimeoutSec = 5,
        [string]$Method = 'GET',
        [string]$Body = '',
        [hashtable]$Headers = @{}
    )
    $res = @{ ok = $false; status = 0; body = ''; error = '' }
    try {
        $p = @{ Uri = $Uri; Method = $Method; UseBasicParsing = $true; TimeoutSec = $TimeoutSec; ErrorAction = 'Stop' }
        if ($Headers.Count -gt 0) { $p['Headers'] = $Headers }
        if ($Body -ne '') { $p['Body'] = $Body; $p['ContentType'] = 'application/json' }
        $r = Invoke-WebRequest @p
        $res.ok = $true
        $res.status = [int]$r.StatusCode
        $res.body = [string]$r.Content
    } catch {
        $resp = $null
        try { $resp = $_.Exception.Response } catch { }
        if ($null -ne $resp) {
            try { $res.status = [int]$resp.StatusCode } catch { $res.status = 0 }
            try {
                $stream = $resp.GetResponseStream()
                if ($null -ne $stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $res.body = $reader.ReadToEnd()
                    $reader.Close()
                }
            } catch { }
            $res.error = "HTTP $($res.status)"
        } else {
            $res.error = [string]$_.Exception.Message
        }
    }
    return $res
}

function Test-TcpPort {
    param([int]$Port, [string]$Target = '', [int]$TimeoutMs = 1200)
    # 2026-11-25 真机教训：Playwright MCP 只监听 ::1，而这里原来固定用 127.0.0.1，
    # 服务明明 LISTENING 也一律判「连不上」→ 每轮都去再拉一个 → npx 报 EADDRINUSE 死循环。
    # 现在：不指定 Target 就两个地址族都试；指定了按地址族造 socket
    # （TcpClient 默认 IPv4，拿它连 ::1 永远失败）。
    $targets = @($Target)
    if ([string]::IsNullOrEmpty($Target)) { $targets = @('::1', '127.0.0.1') }
    foreach ($addr in $targets) {
        $family = [System.Net.Sockets.AddressFamily]::InterNetwork
        if ($addr -like '*:*') { $family = [System.Net.Sockets.AddressFamily]::InterNetworkV6 }
        $client = New-Object System.Net.Sockets.TcpClient -ArgumentList $family
        try {
            $iar = $client.BeginConnect($addr, $Port, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
                try { $client.EndConnect($iar); return $true } catch { }
            }
        } catch {
        } finally {
            try { $client.Close() } catch { }
        }
    }
    return $false
}

function Get-DirSizeMb {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        $files = @(Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue)
        $sum = ($files | Measure-Object -Property Length -Sum).Sum
        if ($null -eq $sum) { return 0.0 }
        return [math]::Round(([double]$sum) / 1MB, 1)
    } catch {
        return $null
    }
}

function Get-BackupStats {
    param([string]$Dir, [datetime]$At)
    $stats = @{ exists = (Test-Path $Dir); count = 0; totalMb = 0.0; totalBytes = 0; todayPresent = $false; newest = ''; names = @() }
    if (-not $stats.exists) { return $stats }
    $files = @(Get-ChildItem -Path $Dir -Filter 'dot-*.db' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    $stats.names = @($files | ForEach-Object { $_.Name })
    $stats.count = @($files).Count
    $sum = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { $sum = 0 }
    $stats.totalBytes = [int64]$sum
    $stats.totalMb = [math]::Round(([double]$sum) / 1MB, 1)
    if ($stats.count -gt 0) { $stats.newest = $stats.names[0] }
    $today = $At.ToString('yyyyMMdd')
    $stats.todayPresent = (@($stats.names) -contains ("dot-$today.db"))
    return $stats
}

# 减份建议（B.7：备份总占用超上限按 14→7→3 减份；删由 dot-core maintenance 做）
function Get-BackupRetentionPlan {
    param([int]$Count, [double]$TotalMb, [int]$BaseKeep = 14, [double]$CapMb = 5120)
    $keep = $BaseKeep
    $note = ''
    $avg = 0.0
    if ($Count -gt 0) { $avg = $TotalMb / $Count }
    if ($TotalMb -gt $CapMb) {
        $keep = [math]::Min($BaseKeep, 7)
        $note = '备份总占用超上限，建议份数从 14 减到 7'
    }
    if ($Count -gt 0 -and ($avg * $keep) -gt $CapMb -and $keep -gt 3) {
        $keep = 3
        $note = '减到 7 份仍超上限，建议减到 3 份'
    }
    $manual = $false
    if ($Count -gt 0 -and ($avg * $keep) -gt $CapMb) {
        $manual = $true
        $note = '减到 3 份仍超上限：标红，建议手动清（不硬删）'
    }
    $deleteCount = [math]::Max(0, $Count - $keep)
    return @{
        keep        = $keep
        deleteCount = $deleteCount
        manual      = $manual
        note        = $note
        avgMb       = [math]::Round($avg, 1)
    }
}

function New-Row {
    param([string]$Id, [string]$Title, [string]$State, [string]$Detail, [string]$Action = '')
    return [ordered]@{
        id     = $Id
        title  = $Title
        state  = $State
        detail = [string]$Detail
        action = [string]$Action
    }
}

function New-Action {
    param([string]$Id, [string]$Kind, [string]$Cmd, [string]$Reason, [bool]$Allowed = $true, [string]$SuppressedReason = '')
    return [ordered]@{
        id               = $Id
        kind             = $Kind
        cmd              = $Cmd
        reason           = $Reason
        allowed          = $Allowed
        suppressed       = (-not $Allowed)
        suppressedReason = $SuppressedReason
    }
}

# 所有「手」的服务只留一个动作：跑 dot-up.ps1，它自己盘谁红起谁。
# 这样 keeper 的 rows 还是每行一项（看得见谁红），但动手只有一条命令。
function Add-StackAction {
    param($ActionList, [string]$Reason)
    foreach ($existing in $ActionList) {
        if ($existing.id -eq 'start_stack') { return }
    }
    $cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $StackUpScript + '" -SkipGateway'
    [void]$ActionList.Add((New-Action 'start_stack' 'run_script' $cmd $Reason))
}

function Read-KeeperState {
    param([string]$Path)
    $state = @{
        updatedAt            = $null
        gatewayStarts        = @()
        gatewayStops         = @()
        gateVerifyLastRunAt  = $null
        gateVerifyLastOk     = $null
        gateVerifyLastDetail = ''
    }
    if (-not (Test-Path $Path)) { return $state }
    try {
        $j = Get-Content -Raw -Encoding UTF8 $Path | ConvertFrom-Json
        $gs = Get-Prop -Obj $j -Name 'gatewayStarts'
        if ($null -ne $gs) { $state.gatewayStarts = @($gs) }
        $gstop = Get-Prop -Obj $j -Name 'gatewayStops'
        if ($null -ne $gstop) { $state.gatewayStops = @($gstop) }
        $state.gateVerifyLastRunAt = Get-Prop -Obj $j -Name 'gateVerifyLastRunAt'
        $state.gateVerifyLastOk = Get-Prop -Obj $j -Name 'gateVerifyLastOk'
        $state.gateVerifyLastDetail = [string](Get-Prop -Obj $j -Name 'gateVerifyLastDetail' '')
        $state.updatedAt = Get-Prop -Obj $j -Name 'updatedAt'
    } catch {
        # 坏文件当没有：keeper 的状态文件不是事实来源，丢了下一轮重建。
    }
    return $state
}

# ---------------------------------------------------------------------------
# 路径与默认值
# ---------------------------------------------------------------------------
$ToolsDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ToolsDir)) { $ToolsDir = (Get-Location).Path }
if ([string]::IsNullOrEmpty($DotRoot)) {
    $buildDir = Split-Path -Parent $ToolsDir
    $DotRoot = Split-Path -Parent $buildDir
}
$DotRoot = $DotRoot.TrimEnd('\', '/')
$HelperPath = Join-Path $ToolsDir 'keeper-ledger.mjs'
$ProbePath = Join-Path $ToolsDir 'probe-health.mjs'

if ([string]::IsNullOrEmpty($StateFile)) {
    $StateFile = Join-Path $env:USERPROFILE '.allbot\dot\state\keep.json'
}
if ([string]::IsNullOrEmpty($BackupDir)) {
    $BackupDir = Join-Path $env:USERPROFILE '.allbot\dot\backups'
}
if ([string]::IsNullOrEmpty($LedgerDbPath)) {
    $LedgerDbPath = Join-Path $env:USERPROFILE '.allbot\dot\ledger\dot.db'
}
$StateDir = Split-Path -Parent $StateFile
$QueuePath = Join-Path $StateDir 'keeper-report-queue.jsonl'
$ReportPath = Join-Path $StateDir 'keeper-report.json'
$DotCoreHeartbeat = Join-Path $env:USERPROFILE '.allbot\dot\state\dot-core.heartbeat'
$GateVerifyScript = Join-Path $DotRoot 'build\patches\ds-bot\verify.mjs'
$BridgeEntry = Join-Path $DotRoot 'build\dot-bridge\index.mjs'
# 一个入口拉起所有「手」用的外部服务（8000 / 8931 / 8932 / 8933 / 8799）。
# 命令只从 keeper-start.json 读一份，这里不再各写一条（2026-11-25 收口）。
$StackUpScript = Join-Path $DotRoot 'build\tools\dot-up.ps1'
$SnapshotsDir = Join-Path $env:USERPROFILE '.allbot\dot\snapshots'
# 部署请求：dot-core 打完自我优化的补丁会写这个文件，要求重启网关才生效。
# 我们**不在网关进程里自己重启自己**（后面的事件就写不完了），交给这里做。
$ReloadRequestPath = Join-Path $StateDir 'reload-request.json'

$doIt = ($Execute -and (-not $DryRun))

# B.7 的阈值（可由 config.json 的 keepalive.disk 覆盖）
$DiskWarnMb = 5120
$DiskRedMb = 2048
$DiskPauseMb = 800
$BackupCapMb = 5120

$configPath = Join-Path $env:USERPROFILE '.allbot\dot\config.json'
$config = $null
if (Test-Path $configPath) {
    try { $config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json } catch { $config = $null }
}
$keepCfg = Get-Prop -Obj $config -Name 'keepalive'
$diskCfg = Get-Prop -Obj $keepCfg -Name 'disk'
$cfgWarn = Get-Prop -Obj $diskCfg -Name 'warn_gb'
$cfgRed = Get-Prop -Obj $diskCfg -Name 'red_gb'
$cfgPause = Get-Prop -Obj $diskCfg -Name 'pause_gb'
if ($null -ne $cfgWarn) { $DiskWarnMb = [double]$cfgWarn * 1024 }
if ($null -ne $cfgRed) { $DiskRedMb = [double]$cfgRed * 1024 }
if ($null -ne $cfgPause) { $DiskPauseMb = [double]$cfgPause * 1024 }
$cfgBackupCap = Get-Prop -Obj $keepCfg -Name 'backups_max_gb'
if ($null -ne $cfgBackupCap) { $BackupCapMb = [double]$cfgBackupCap * 1024 }
# 启动命令放哪：**不能放 config.json 的 keepalive 里**。
# 2026-11-25 实测：dot-core 的配置校验拒绝未知字段（keepalive.windows_mcp_cmd → ConfigError），
# 加了它插件就拒绝加载、整只 dot-core 掉线。而 keeper 又确实需要这三条命令，
# 所以单独一个文件：<user>\.allbot\dot\keeper-start.json。keepalive.* 保留为兜底（老配置兼容）。
$startCfgPath = Join-Path $env:USERPROFILE '.allbot\dot\keeper-start.json'
$startCfg = $null
if (Test-Path $startCfgPath) {
    try { $startCfg = Get-Content -Raw -Encoding UTF8 $startCfgPath | ConvertFrom-Json } catch { $startCfg = $null }
}
function Get-StartCmd {
    param([string]$Name, [string]$Default = '')
    $v = [string](Get-Prop -Obj $startCfg -Name $Name '')
    if ($v -ne '') { return $v }
    return [string](Get-Prop -Obj $keepCfg -Name $Name $Default)
}
$gwCmd = Get-StartCmd 'gateway_cmd' (Join-Path $env:USERPROFILE '.allbot\gateway.cmd')
$windowsMcpCmd = Get-StartCmd 'windows_mcp_cmd' ''
$playwrightCmd = Get-StartCmd 'playwright_mcp_cmd' ''
# 第二只浏览器：干净浏览器（--isolated，不带你登录态），端口 8932。
$cleanBrowserCmd = Get-StartCmd 'clean_browser_cmd' ''
# 微信手：wechat-mcp 的 streamable-HTTP 入口，端口 8933（D:/项目/wechat-mcp/wechat_mcp_http.py）。
$wechatCmd = Get-StartCmd 'wechat_cmd' ''
$balanceProbeCfg = Get-Prop -Obj $keepCfg -Name 'balance_probe'
$balanceProbeEnabled = To-Bool (Get-Prop -Obj $balanceProbeCfg -Name 'enabled' $false)
$balanceModels = Get-Prop -Obj $balanceProbeCfg -Name 'models'
$modelPoolBase = [string](Get-Prop -Obj $keepCfg -Name 'model_pool_url' 'http://127.0.0.1:3065')
$bridgeStartCmd = 'node "' + $BridgeEntry + '"'

# ---------------------------------------------------------------------------
# 真实探针 → plan（与 -PlanFile 同结构，判定逻辑只看 plan）
# ---------------------------------------------------------------------------
function Get-DotCoreProbe {
    param($GatewayProbe)

    $hbDetail = '没有心跳文件'
    if (Test-Path $DotCoreHeartbeat) {
        $age = ((Get-Date) - (Get-Item $DotCoreHeartbeat).LastWriteTime).TotalSeconds
        if ($age -le 600) {
            return @{ loaded = $true; known = $true; source = 'heartbeat'; detail = ('心跳 {0:N0}s 前' -f $age) }
        }
        # 心跳过期 = 有「未加载」的证据（fail-closed 只对证据成立，不对「没信号」成立）
        return @{ loaded = $false; known = $true; source = 'heartbeat-stale'; detail = ('心跳文件 {0:N0}s 前，超过 600s' -f $age) }
    }
    if ($GatewayProbe.ok) {
        $body = [string]$GatewayProbe.body
        if ($body -match '"dot-core"\s*:\s*\{[^}]*"loaded"\s*:\s*true') {
            return @{ loaded = $true; known = $true; source = 'status'; detail = '状态接口标记已加载' }
        }
        return @{
            loaded  = $false
            known   = $false
            source  = 'no-signal'
            detail  = '没有心跳文件，状态接口也没有 dot-core 的 loaded 标记（B.4 的 dot-core 交付时要写心跳）'
        }
    }
    return @{ loaded = $false; known = $false; source = 'no-signal'; detail = '网关没起、也没有心跳文件，加载状态读不到' }
}

function Get-ProbeHealth {

    $out = $null
    $errText = ''
    if (-not (Test-Path $ProbePath)) {
        return @{ ok = $false; error = ('probe-health.mjs 不在：' + $ProbePath); disk = $null; balance = $null }
    }
    $args = @('--disk-path', $LedgerDbPath, '--disk-path', (Join-Path $env:USERPROFILE '.allbot'), '--base-url', $modelPoolBase)
    # 不用 --once：B.7 的「30 秒后立刻重测、两次都失败才转红」要在巡检里生效，
    # dry-run 与执行模式的判定必须一致（--once 只留给人工验收）。
    if (-not $balanceProbeEnabled) {
        $args += '--skip-balance'
    } else {
        $pairs = @()
        foreach ($t in @('cheap', 'balanced', 'strong')) {
            $name = [string](Get-Prop -Obj $balanceModels -Name $t '')
            if (-not [string]::IsNullOrEmpty($name)) { $pairs += ($t + '=' + $name) }
        }
        if ($pairs.Count -gt 0) { $args += @('--models', ($pairs -join ',')) }
    }
    try {
        $raw = & node --no-warnings $ProbePath @args 2>&1
        $line = (($raw | Out-String).Trim())
        $parsed = $null
        try { $parsed = $line | ConvertFrom-Json } catch { $parsed = $null }
        if ($null -eq $parsed) {
            return @{ ok = $false; error = ('probe-health 输出不是 JSON：' + $line); disk = $null; balance = $null }
        }
        return @{ ok = (To-Bool (Get-Prop -Obj $parsed -Name 'ok' $false)); error = [string](Get-Prop -Obj $parsed -Name 'error' ''); disk = (Get-Prop -Obj $parsed -Name 'disk' $null); balance = (Get-Prop -Obj $parsed -Name 'balance' $null) }
    } catch {
        $errText = [string]$_.Exception.Message
        return @{ ok = $false; error = ('调 probe-health 失败：' + $errText); disk = $null; balance = $null }
    }
}

function Get-RealPlan {
    param($PriorState)

    $pool = Invoke-HttpProbe -Uri ($modelPoolBase + '/v1/models') -TimeoutSec 5
    # 20 秒不是随手加：2026-11-25 实测网关活着但有负载时 /api/status 要 6.8 秒才回，
    # 原来 5 秒超时会把「活着但慢」判成「没起」，然后去看门狗的第二条命（再拉一个）。
    $gw = Invoke-HttpProbe -Uri 'http://127.0.0.1:18789/api/status' -TimeoutSec 20
    # 已经在跑的网关进程数。2026-11-25 真机教训：这台机器上网关冷启动要 140-170 秒
    # （lark / 语音 / 浏览器 / 向量挨个初始化），这期间 /api/status 一直连不上；
    # 看门狗 5 分钟一轮，看到「没通」就又拉一个，两个网关抢同一个 SQLite、双双卡死
    # （事件循环被占满：端口收得住连接但永不回话）。所以起之前先看有没有进程在跑。
    $gwProcCount = 0
    try {
        $gwProcCount = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -ne $null -and $_.CommandLine -match 'index\.js"?\s+gateway' }).Count
    } catch {
        $gwProcCount = -1 # 查不到记 -1：判定层看不懂就不抑制，宁可起一个也别因为查不到永远不起
    }
    $bridge = Invoke-HttpProbe -Uri 'http://127.0.0.1:8799/health' -TimeoutSec 3
    $dotCore = Get-DotCoreProbe -GatewayProbe $gw
    $probe = Get-ProbeHealth

    # 8000：MCP initialize（先 TCP，连不上就别白等超时）
    $win = @{ ok = $false; detail = 'TCP 8000 连不上' }
    if (Test-TcpPort -Port 8000) {
        $initBody = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dot-keeper","version":"0.1"}}}'
        $r = Invoke-HttpProbe -Uri 'http://127.0.0.1:8000/mcp' -Method 'POST' -Body $initBody -TimeoutSec 4 -Headers @{ Accept = 'application/json, text/event-stream' }
        if ($r.status -ge 200 -and $r.status -lt 300) { $win = @{ ok = $true; detail = ('initialize HTTP ' + [string]$r.status) } }
        else { $win = @{ ok = $false; detail = ('端口在但 initialize 失败：' + [string]$r.error) } }
    }

    # 8931：只测 TCP（Playwright MCP 无鉴权、靠只听本机）
    $pw = @{ ok = (Test-TcpPort -Port 8931); detail = '' }
    if ($pw.ok) { $pw.detail = 'TCP 8931 通' } else { $pw.detail = 'TCP 8931 连不上' }
    # 8932：干净浏览器，同一个探法
    $pwClean = @{ ok = (Test-TcpPort -Port 8932); detail = '' }
    if ($pwClean.ok) { $pwClean.detail = 'TCP 8932 通' } else { $pwClean.detail = 'TCP 8932 连不上' }
    # 8933：微信手（wechat-mcp HTTP）。也只看 TCP：GET /mcp 本来就回 400，不能当活着的判据
    $wx = @{ ok = (Test-TcpPort -Port 8933); detail = '' }
    if ($wx.ok) { $wx.detail = 'TCP 8933 通' } else { $wx.detail = 'TCP 8933 连不上' }

    # ds-bot：只看进程/端口，不主动拉（脸由人自己开）
    $dsbotRunning = $false
    $dsbotDetail = '8797 不通、进程也没找到'
    if (Test-TcpPort -Port 8797) {
        $dsbotRunning = $true
        $dsbotDetail = '8797 在听（对外接口在）'
    } else {
        $names = @('ds-bot', 'dsbot', 'DS Bot', 'dsh', 'DeepSeek Harness')
        $hit = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
        if (@($hit).Count -gt 0) {
            $dsbotRunning = $true
            $procNames = @($hit | ForEach-Object { $_.ProcessName } | Select-Object -Unique)
            $dsbotDetail = '进程在：' + ($procNames -join ',')
        }
    }

    # 口闸 verify：每小时最多一次（B.7）。dry-run 不跑（会起子进程），只报「到点没跑」。
    $gate = @{ ok = $false; ran = $false; detail = '' }
    $lastRun = Parse-IsoSafe ([string](Get-Prop -Obj $PriorState -Name 'gateVerifyLastRunAt' ''))
    $due = ($null -eq $lastRun) -or (((Get-NowUtc) - $lastRun).TotalMinutes -ge 60)
    if (-not (Test-Path $GateVerifyScript)) {
        $gate = @{ ok = $false; ran = $false; detail = '校验脚本没装：build/patches/ds-bot/verify.mjs' }
    } elseif (-not $doIt) {
        $gate = @{ ok = $false; ran = $false; detail = 'dry-run 不跑口闸 verify（会起子进程；-Execute 才跑）' }
    } elseif ($due) {
        $out = & node --no-warnings $GateVerifyScript 2>&1
        $code = $LASTEXITCODE
        $gate = @{ ok = ($code -eq 0); ran = $true; detail = ('exit=' + [string]$code + ' ' + (($out | Out-String).Trim())) }
        $PriorState['gateVerifyLastRunAt'] = (Format-Iso (Get-NowUtc))
        $PriorState['gateVerifyLastOk'] = ($code -eq 0)
        $PriorState['gateVerifyLastDetail'] = ([string]$gate.detail).Substring(0, [math]::Min(300, ([string]$gate.detail).Length))
    } else {
        $gate = @{ ok = $false; ran = $false; detail = '这一轮没跑（每小时一次，未到点）' }
    }

    # 磁盘/账户：来自 probe-health.mjs；它挂了就 unknown，不编数
    $diskFree = $null
    $probeDiskDetail = ''
    if ($null -ne $probe.disk) {
        $diskFree = Get-Prop -Obj $probe.disk -Name 'freeMb' $null
    } elseif ($probe.error -ne '') {
        $probeDiskDetail = [string]$probe.error
    }
    if ($DiskFreeMbOverride -ge 0) { $diskFree = $DiskFreeMbOverride }

    $balance = [ordered]@{ enabled = $balanceProbeEnabled }
    foreach ($t in @('cheap', 'balanced', 'strong')) {
        $entry = $null
        if ($null -ne $probe.balance) { $entry = Get-Prop -Obj $probe.balance -Name $t $null }
        if ($null -eq $entry) {
            $note = 'probe-health 没给结果'
            if ($probe.error -ne '') { $note = [string]$probe.error }
            $balance[$t] = @{ level = 'unknown'; note = $note }
        } else {
            $balance[$t] = @{
                level = [string](Get-Prop -Obj $entry -Name 'level' 'unknown')
                note  = [string](Get-Prop -Obj $entry -Name 'note' '')
            }
        }
    }

    $backups = Get-BackupStats -Dir $BackupDir -At (Get-Date)
    $snapMb = Get-DirSizeMb -Path $SnapshotsDir

    # 部署后的重启请求：存在、且不是刚刚写的（给它 60 秒，避免和部署动作抢）
    $reloadInfo = @{ present = $false; patchId = ''; requestedAt = ''; ageSeconds = -1 }
    if (Test-Path $ReloadRequestPath) {
        try {
            $rr = Get-Content -Raw -Encoding UTF8 $ReloadRequestPath | ConvertFrom-Json
            $at = Parse-IsoSafe ([string](Get-Prop -Obj $rr -Name 'requestedAt' ''))
            $age = -1
            if ($null -ne $at) { $age = ((Get-NowUtc) - $at).TotalSeconds }
            $reloadInfo = @{
                present     = $true
                patchId     = [string](Get-Prop -Obj $rr -Name 'patchId' '')
                requestedAt = [string](Get-Prop -Obj $rr -Name 'requestedAt' '')
                ageSeconds  = [math]::Round($age, 0)
            }
        } catch {
            $reloadInfo = @{ present = $false; patchId = ''; requestedAt = ''; ageSeconds = -1 }
        }
    }

    $taskExists = $false
    $taskEnabled = $false
    try {
        $task = Get-ScheduledTask -TaskName 'dot-keeper' -ErrorAction Stop
        $taskExists = $true
        $taskEnabled = ([string]$task.State -ne 'Disabled')
    } catch {
        $taskExists = $false
    }

    $pwCmdResolved = $playwrightCmd
    if ([string]::IsNullOrEmpty($pwCmdResolved)) {
        $exe = Get-Command 'playwright-mcp' -ErrorAction SilentlyContinue
        if ($null -ne $exe) { $pwCmdResolved = 'playwright-mcp --port 8931' }
    }

    return [ordered]@{
        now        = (Format-Iso (Get-NowUtc))
        probes     = [ordered]@{
            modelPool  = @{ ok = $pool.ok; status = $pool.status; error = $pool.error }
            gateway    = @{ ok = $gw.ok; status = $gw.status; error = $gw.error }
            # 进程数：>=1 = 已经有网关在跑（可能还在冷启动）。-1 = 没查成。
            gatewayProcess = @{ count = $gwProcCount }
            dotCore    = @{
                loaded = (To-Bool (Get-Prop -Obj $dotCore -Name 'loaded' $false))
                known  = (To-Bool (Get-Prop -Obj $dotCore -Name 'known' $false))
                source = [string](Get-Prop -Obj $dotCore -Name 'source' 'none')
                detail = [string](Get-Prop -Obj $dotCore -Name 'detail' '')
            }
            bridge     = @{ ok = $bridge.ok; status = $bridge.status; error = $bridge.error }
            windowsMcp = $win
            playwright = $pw
            cleanBrowser = $pwClean
            wechat     = $wx
            gateVerify = $gate
            dsbot      = @{ running = $dsbotRunning; detail = $dsbotDetail }
            balance    = $balance
        }
        disk       = @{ freeMb = $diskFree; detail = $probeDiskDetail }
        backups    = @{ count = $backups.count; totalMb = $backups.totalMb; todayPresent = $backups.todayPresent; names = $backups.names }
        snapshots  = @{ mb = $snapMb }
        startables = @{
            gatewayCmd    = (Test-Path $gwCmd)
            gatewayPath   = $gwCmd
            bridgeCmd     = (Test-Path $BridgeEntry)
            bridgePath    = $bridgeStartCmd
            windowsMcpCmd = $windowsMcpCmd
            playwrightCmd = $pwCmdResolved
            cleanBrowserCmd = $cleanBrowserCmd
            wechatCmd     = $wechatCmd
            verifyScript  = (Test-Path $GateVerifyScript)
            verifyPath    = $GateVerifyScript
        }
        keeperTask = @{ exists = $taskExists; enabled = $taskEnabled }
        reloadRequest = $reloadInfo
    }
}

# ---------------------------------------------------------------------------
# 判定：输入 plan，输出 rows / actions / 建议
# ---------------------------------------------------------------------------
function Get-KeeperVerdict {
    param($Plan, $PriorState, [datetime]$NowUtc)

    $rows = New-Object System.Collections.ArrayList
    $actions = New-Object System.Collections.ArrayList

    $probes = Get-Prop -Obj $Plan -Name 'probes'
    $pool = Get-Prop -Obj $probes -Name 'modelPool'
    $gw = Get-Prop -Obj $probes -Name 'gateway'
    $dotCore = Get-Prop -Obj $probes -Name 'dotCore'
    $bridge = Get-Prop -Obj $probes -Name 'bridge'
    $win = Get-Prop -Obj $probes -Name 'windowsMcp'
    $pw = Get-Prop -Obj $probes -Name 'playwright'
    # 干净浏览器是后加的：老 plan（测试/演练文件）里没有这个键。没有就整行不出，
    # 免得把「这份 plan 没这个字段」误报成「服务没起」。
    $pwClean = Get-Prop -Obj $probes -Name 'cleanBrowser' $null
    $gate = Get-Prop -Obj $probes -Name 'gateVerify'
    $dsbot = Get-Prop -Obj $probes -Name 'dsbot'
    $startables = Get-Prop -Obj $Plan -Name 'startables'

    # 网关的起/停历史（退避依据，全部来自 keep.json 或 plan）
    $parsedStarts = @()
    foreach ($s in @(Get-Prop -Obj $PriorState -Name 'gatewayStarts' @())) {
        $t = Parse-IsoSafe ([string]$s)
        if ($null -ne $t) { $parsedStarts += $t }
    }
    $parsedStops = @()
    foreach ($s in @(Get-Prop -Obj $PriorState -Name 'gatewayStops' @())) {
        $t = Parse-IsoSafe ([string]$s)
        if ($null -ne $t) { $parsedStops += $t }
    }
    $hourAgo = $NowUtc.AddHours(-1)
    $recentStarts = @($parsedStarts | Where-Object { $_ -gt $hourAgo })
    $recentStops = @($parsedStops | Where-Object { $_ -gt $hourAgo })
    $lastStop = $null
    if ($parsedStops.Count -gt 0) { $lastStop = ($parsedStops | Sort-Object | Select-Object -Last 1) }
    $justStopped = $false
    if ($null -ne $lastStop -and ($NowUtc - $lastStop).TotalMinutes -lt 10) { $justStopped = $true }
    # 已经有网关进程在跑？在跑就别再起第二个（冷启动 140-170 秒，probe 一定是红的）。
    $gwProcCount = [int](Get-Prop -Obj (Get-Prop -Obj $probes -Name 'gatewayProcess') -Name 'count' -1)
    $gwAlreadyRunning = ($gwProcCount -ge 1)

    # 1) 3065 模型池：只报红，永不代拉
    if (To-Bool (Get-Prop -Obj $pool -Name 'ok' $false)) {
        [void]$rows.Add((New-Row 'modelPool' '3065 模型池' 'green' ('GET /v1/models HTTP ' + [string](Get-Prop -Obj $pool -Name 'status' 200)) ''))
    } else {
        [void]$rows.Add((New-Row 'modelPool' '3065 模型池' 'red' ('GET /v1/models 失败：' + [string](Get-Prop -Obj $pool -Name 'error' '未知')) '重开桌面上的 Agent2API 程序，或重启电脑'))
    }

    # 2) 18789 网关：down → 起 gateway.cmd，每小时最多 5 次；刚因 dot-core 停过就先别起
    $gwOk = To-Bool (Get-Prop -Obj $gw -Name 'ok' $false)
    $gwStartAllowed = ($recentStarts.Count -lt 5)
    $startSuppressed = ''
    if (-not $gwStartAllowed) { $startSuppressed = ('一小时内已起 {0} 次，每小时最多 5 次' -f $recentStarts.Count) }
    elseif ($justStopped) { $startSuppressed = ('{0} 分钟前刚因 dot-core 未加载停过网关，先别起（避免起停循环）' -f [math]::Round(($NowUtc - $lastStop).TotalMinutes, 0)) }
    elseif ($gwAlreadyRunning) { $startSuppressed = ('已有 {0} 个网关进程在跑但 /api/status 还没通（冷启动要 140-170 秒）：不再起第二个，避免两个网关抢账本卡死；超过 10 分钟还不通就人工看日志' -f $gwProcCount) }
    $gwStartCmd = [string](Get-Prop -Obj $startables -Name 'gatewayPath' '')
    $gwCmdExists = To-Bool (Get-Prop -Obj $startables -Name 'gatewayCmd' $false)

    if ($gwOk) {
        [void]$rows.Add((New-Row 'gateway' '18789 网关' 'green' ('GET /api/status HTTP ' + [string](Get-Prop -Obj $gw -Name 'status' 200)) ''))
    } else {
        $detail = 'GET /api/status 失败：' + [string](Get-Prop -Obj $gw -Name 'error' '未知')
        if (-not $gwCmdExists) {
            [void]$rows.Add((New-Row 'gateway' '18789 网关' 'red' ($detail + '；找不到 gateway.cmd：' + $gwStartCmd) '装 allbot 网关或修 keepalive.gateway_cmd'))
        } elseif ($startSuppressed -ne '') {
            [void]$rows.Add((New-Row 'gateway' '18789 网关' 'red' ($detail + '；' + $startSuppressed) '人工看一眼网关日志'))
            [void]$actions.Add((New-Action 'start_gateway' 'process_start' $gwStartCmd '网关没起' $false $startSuppressed))
        } else {
            [void]$rows.Add((New-Row 'gateway' '18789 网关' 'red' $detail '起 gateway.cmd'))
            [void]$actions.Add((New-Action 'start_gateway' 'process_start' $gwStartCmd '网关没起，按退避拉起'))
        }
    }

    # 3) dot-core 加载状态（fail-closed 只对有证据的「未加载」生效）
    $coreLoaded = To-Bool (Get-Prop -Obj $dotCore -Name 'loaded' $false)
    $coreKnown = To-Bool (Get-Prop -Obj $dotCore -Name 'known' $false)
    $coreDetail = [string](Get-Prop -Obj $dotCore -Name 'detail' '')
    if (-not $coreKnown) {
        [void]$rows.Add((New-Row 'dotCore' 'dot-core 加载状态' 'yellow' ('没法判断：' + $coreDetail) 'dot-core 交付心跳后这一行才能变成红/绿'))
    } elseif ($coreLoaded) {
        [void]$rows.Add((New-Row 'dotCore' 'dot-core 加载状态' 'green' $coreDetail ''))
    } else {
        [void]$rows.Add((New-Row 'dotCore' 'dot-core 加载状态' 'red' ('未加载：' + $coreDetail + '。钩子不在，exec 就是裸奔') '停 18789 网关（fail-closed）'))
        if ($gwOk) {
            $stopAllowed = ($recentStops.Count -lt 3)
            $suppress = ''
            if (-not $stopAllowed) { $suppress = ('一小时内已停 {0} 次，最多 3 次' -f $recentStops.Count) }
            [void]$actions.Add((New-Action 'stop_gateway' 'process_stop' 'schtasks /End /TN "AllBot Gateway"；并按 18789 监听 PID 兜底 Stop-Process' 'dot-core 未加载，fail-closed 停网关' $stopAllowed $suppress))
        }
    }

    # 4) 8799 桥
    $bridgeOk = To-Bool (Get-Prop -Obj $bridge -Name 'ok' $false)
    $bridgeCmdExists = To-Bool (Get-Prop -Obj $startables -Name 'bridgeCmd' $false)
    $bridgeCmd = [string](Get-Prop -Obj $startables -Name 'bridgePath' '')
    if ($bridgeOk) {
        [void]$rows.Add((New-Row 'bridge' '8799 dot-bridge' 'green' 'GET /health 通' ''))
    } elseif ($bridgeCmdExists) {
        [void]$rows.Add((New-Row 'bridge' '8799 dot-bridge' 'red' ('GET /health 失败：' + [string](Get-Prop -Obj $bridge -Name 'error' '未知')) '起 dot-bridge（node build/dot-bridge/index.mjs）'))
        Add-StackAction $actions 'dot-bridge 没起'
    } else {
        [void]$rows.Add((New-Row 'bridge' '8799 dot-bridge' 'yellow' ('没装：找不到 ' + $bridgeCmd) '先做 dot-bridge（B.6）'))
    }

    # 5) 8000 Windows-MCP
    $winOk = To-Bool (Get-Prop -Obj $win -Name 'ok' $false)
    $winCmd = [string](Get-Prop -Obj $startables -Name 'windowsMcpCmd' '')
    $winDetail = [string](Get-Prop -Obj $win -Name 'detail' '连不上')
    if ($winOk) {
        [void]$rows.Add((New-Row 'windowsMcp' '8000 Windows-MCP' 'green' $winDetail ''))
    } elseif ([string]::IsNullOrEmpty($winCmd)) {
        [void]$rows.Add((New-Row 'windowsMcp' '8000 Windows-MCP' 'red' ($winDetail + '；没配 keepalive.windows_mcp_cmd') '配好启动命令（改 config.toml 前先备份）'))
    } else {
        [void]$rows.Add((New-Row 'windowsMcp' '8000 Windows-MCP' 'red' $winDetail '按已配参数拉起 Windows-MCP'))
        Add-StackAction $actions 'Windows-MCP 没起'
    }

    # 6) 8931 Playwright MCP：只拉起已装好的
    $pwOk = To-Bool (Get-Prop -Obj $pw -Name 'ok' $false)
    $pwCmd = [string](Get-Prop -Obj $startables -Name 'playwrightCmd' '')
    $pwDetail = [string](Get-Prop -Obj $pw -Name 'detail' '')
    if ($pwOk -and $pwDetail -eq '') { $pwDetail = 'TCP 8931 通' }
    if (-not $pwOk -and $pwDetail -eq '') { $pwDetail = 'TCP 8931 连不上' }
    if ($pwOk) {
        [void]$rows.Add((New-Row 'playwright' '8931 Playwright MCP' 'green' $pwDetail ''))
    } elseif ([string]::IsNullOrEmpty($pwCmd)) {
        [void]$rows.Add((New-Row 'playwright' '8931 Playwright MCP' 'yellow' '没装（第 0 步没装 @playwright/mcp）；keeper 不代装' '第 0 步 npm install -g @playwright/mcp'))
    } else {
        [void]$rows.Add((New-Row 'playwright' '8931 Playwright MCP' 'red' $pwDetail '拉起已装好的 Playwright MCP'))
        Add-StackAction $actions 'Playwright MCP 没起'
    }

    # 6c) 8933 微信手（wechat-mcp HTTP）：挂了就按 keeper-start.json 的 wechat_cmd 拉起
    $wx = Get-Prop -Obj $probes -Name 'wechat' $null
    if ($null -ne $wx) {
        $wxOk = To-Bool (Get-Prop -Obj $wx -Name 'ok' $false)
        $wxCmd = [string](Get-Prop -Obj $startables -Name 'wechatCmd' '')
        $wxDetail = [string](Get-Prop -Obj $wx -Name 'detail' '')
        if ($wxOk -and $wxDetail -eq '') { $wxDetail = 'TCP 8933 通' }
        if (-not $wxOk -and $wxDetail -eq '') { $wxDetail = 'TCP 8933 连不上' }
        if ($wxOk) {
            [void]$rows.Add((New-Row 'wechat' '8933 微信手' 'green' $wxDetail ''))
        } elseif ([string]::IsNullOrEmpty($wxCmd)) {
            [void]$rows.Add((New-Row 'wechat' '8933 微信手' 'yellow' '没配 wechat_cmd（微信任务会直接说干不了）' '在 keeper-start.json 里配 wechat_cmd'))
        } else {
            [void]$rows.Add((New-Row 'wechat' '8933 微信手' 'red' $wxDetail '拉起 wechat-mcp（HTTP 8933）'))
            Add-StackAction $actions '微信手没起'
        }
    }

    # 6b) 8932 干净浏览器（clean_browser 手）：探法与 8931 一样
    if ($null -ne $pwClean) {
        $pwcOk = To-Bool (Get-Prop -Obj $pwClean -Name 'ok' $false)
        $pwcCmd = [string](Get-Prop -Obj $startables -Name 'cleanBrowserCmd' '')
        $pwcDetail = [string](Get-Prop -Obj $pwClean -Name 'detail' '')
        if ($pwcOk -and $pwcDetail -eq '') { $pwcDetail = 'TCP 8932 通' }
        if (-not $pwcOk -and $pwcDetail -eq '') { $pwcDetail = 'TCP 8932 连不上' }
        if ($pwcOk) {
            [void]$rows.Add((New-Row 'cleanBrowser' '8932 干净浏览器' 'green' $pwcDetail ''))
        } elseif ([string]::IsNullOrEmpty($pwcCmd)) {
            [void]$rows.Add((New-Row 'cleanBrowser' '8932 干净浏览器' 'yellow' '没配 keepalive.clean_browser_cmd（网页任务会退到 8931）' '配一条启动命令，或直接跑 build/tools/hands-up.ps1'))
        } else {
            [void]$rows.Add((New-Row 'cleanBrowser' '8932 干净浏览器' 'red' $pwcDetail '拉起干净浏览器（--isolated）'))
            Add-StackAction $actions '干净浏览器没起'
        }
    }

    # 7) 口闸 verify：本轮结果优先；没跑就用上一轮的结果（红不会 5 分钟就消失）
    $gateOk = To-Bool (Get-Prop -Obj $gate -Name 'ok' $false)
    $gateRan = To-Bool (Get-Prop -Obj $gate -Name 'ran' $false)
    $gateDetail = [string](Get-Prop -Obj $gate -Name 'detail' '')
    $lastOkRaw = Get-Prop -Obj $PriorState -Name 'gateVerifyLastOk' $null
    $lastOk = $null
    if ($null -ne $lastOkRaw) { $lastOk = To-Bool $lastOkRaw $false }
    $lastRun = Parse-IsoSafe ([string](Get-Prop -Obj $PriorState -Name 'gateVerifyLastRunAt' ''))
    $lastDetail = [string](Get-Prop -Obj $PriorState -Name 'gateVerifyLastDetail' '')
    $verifyDue = ($null -eq $lastRun) -or (($NowUtc - $lastRun).TotalMinutes -ge 60)
    $verifyExists = To-Bool (Get-Prop -Obj $startables -Name 'verifyScript' $false)
    $clock = ''
    if ($null -ne $lastRun) { $clock = $lastRun.ToLocalTime().ToString('HH:mm') }
    if ($gateRan) {
        if ($gateOk) {
            [void]$rows.Add((New-Row 'gateVerify' '口闸 verify' 'green' $gateDetail ''))
        } else {
            [void]$rows.Add((New-Row 'gateVerify' '口闸 verify' 'red' $gateDetail '机器人现在有手，先别让它干活'))
        }
    } elseif (-not $verifyExists) {
        [void]$rows.Add((New-Row 'gateVerify' '口闸 verify' 'yellow' $gateDetail 'B.1 的 verify.mjs 还没做'))
    } elseif ($lastOk -eq $false) {
        [void]$rows.Add((New-Row 'gateVerify' '口闸 verify' 'red' ('上一轮（' + $clock + '）没过：' + $lastDetail) '机器人现在有手，先别让它干活'))
    } elseif ($lastOk -eq $true) {
        [void]$rows.Add((New-Row 'gateVerify' '口闸 verify' 'green' ('上一轮（' + $clock + '）通过；' + $gateDetail) ''))
    } else {
        [void]$rows.Add((New-Row 'gateVerify' '口闸 verify' 'yellow' ('还没跑过；' + $gateDetail) ''))
        if ($verifyDue) {
            [void]$actions.Add((New-Action 'run_gate_verify' 'run_script' ([string](Get-Prop -Obj $startables -Name 'verifyPath' '')) '口闸 verify 到点'))
        }
    }

    # 8) ds-bot：不主动拉，只把「没人点审批」说出来
    if (To-Bool (Get-Prop -Obj $dsbot -Name 'running' $false)) {
        [void]$rows.Add((New-Row 'dsbot' 'ds-bot（脸）' 'green' ([string](Get-Prop -Obj $dsbot -Name 'detail' '在跑')) ''))
    } else {
        [void]$rows.Add((New-Row 'dsbot' 'ds-bot（脸）' 'yellow' ('没在跑；' + [string](Get-Prop -Obj $dsbot -Name 'detail' '') + '。脸没开，审批没人点') '你自己打开 ds-bot（keeper 不代拉）'))
    }

    # 9) 磁盘：>5GB 绿 / <5GB 黄 / <2GB 红 / <800MB 红＋请求停接新任务
    $disk = Get-Prop -Obj $Plan -Name 'disk'
    $freeMin = Get-Prop -Obj $disk -Name 'freeMb' $null
    $freeLedger = Get-Prop -Obj $disk -Name 'ledgerFreeMb' $null
    $freeAllbot = Get-Prop -Obj $disk -Name 'allbotFreeMb' $null
    if ($null -eq $freeMin) {
        foreach ($cand in @($freeLedger, $freeAllbot)) {
            if ($null -ne $cand -and ($null -eq $freeMin -or [double]$cand -lt [double]$freeMin)) { $freeMin = [double]$cand }
        }
    }
    $diskState = 'yellow'
    $pauseAdmission = $false
    $diskAction = ''
    $diskDetail = ''
    if ($null -eq $freeMin) {
        $diskDetail = '读不到剩余空间'
        $probeNote = [string](Get-Prop -Obj $disk -Name 'detail' '')
        if ($probeNote -ne '') { $diskDetail = $diskDetail + '：' + $probeNote }
        $diskAction = '人工看一眼磁盘'
    } else {
        $diskDetail = ('剩 ' + [string][math]::Round([double]$freeMin, 1) + ' MB')
        if ($null -ne $freeLedger -and $null -ne $freeAllbot) {
            $diskDetail = $diskDetail + ('（账本盘 ' + [string]$freeLedger + ' MB／~/.allbot 盘 ' + [string]$freeAllbot + ' MB）')
        }
        if ($freeMin -lt $DiskPauseMb) {
            $diskState = 'red'
            $pauseAdmission = $true
            $diskDetail = $diskDetail + ('；低于 ' + [string]$DiskPauseMb + ' MB：请求 dot-core 停接新任务（admission=paused_disk）')
            $diskAction = '清盘，或把账本挪到别的盘'
        } elseif ($freeMin -lt $DiskRedMb) {
            $diskState = 'red'
            $diskDetail = $diskDetail + ('；低于 ' + [string]$DiskRedMb + ' MB')
            $diskAction = '清盘，或把账本挪到别的盘'
        } elseif ($freeMin -lt $DiskWarnMb) {
            $diskState = 'yellow'
            $diskDetail = $diskDetail + ('；低于 ' + [string]$DiskWarnMb + ' MB')
            $diskAction = '留意磁盘'
        } else {
            $diskState = 'green'
        }
    }
    [void]$rows.Add((New-Row 'disk' '磁盘剩余' $diskState $diskDetail $diskAction))

    # 10) 备份：每日一份留 14；超上限只给建议（删由 dot-core maintenance 做）
    $backups = Get-Prop -Obj $Plan -Name 'backups'
    $bCount = [int](Get-Prop -Obj $backups -Name 'count' 0)
    $bTotal = [double](Get-Prop -Obj $backups -Name 'totalMb' 0)
    $bToday = To-Bool (Get-Prop -Obj $backups -Name 'todayPresent' $false)
    $ret = Get-BackupRetentionPlan -Count $bCount -TotalMb $bTotal -BaseKeep $BackupKeep -CapMb $BackupCapMb
    $bDetail = ('{0} 份 / {1} MB；保留 {2} 份' -f $bCount, [string]$bTotal, [string]$ret.keep)
    if ($bToday) { $bDetail = $bDetail + '；今天已备份' } else { $bDetail = $bDetail + '；今天还没备份' }
    if ($ret.note -ne '') { $bDetail = $bDetail + '；' + $ret.note }
    $bState = 'green'
    if (-not $bToday) { $bState = 'yellow' }
    if ($ret.manual) { $bState = 'red' }
    $bAction = ''
    if ($ret.manual) { $bAction = '手动清备份目录（keeper 不删）' }
    [void]$rows.Add((New-Row 'backups' '账本备份' $bState $bDetail $bAction))
    if (-not $bToday) {
        $todayName = 'dot-' + $NowUtc.ToLocalTime().ToString('yyyyMMdd') + '.db'
        [void]$actions.Add((New-Action 'backup_now' 'ledger_backup' ('node keeper-ledger.mjs backup --db ' + $LedgerDbPath + ' --out ' + (Join-Path $BackupDir $todayName)) '今天还没备份'))
    }

    # 11) 模型账户：level 由 probe-health.mjs 判，这里只汇总
    $balanceCfg = Get-Prop -Obj $probes -Name 'balance'
    $balanceEnabled = To-Bool (Get-Prop -Obj $balanceCfg -Name 'enabled' $false)
    $balanceOut = [ordered]@{}
    $levels = @()
    $balanceNotes = @()
    foreach ($t in @('cheap', 'balanced', 'strong')) {
        $entry = Get-Prop -Obj $balanceCfg -Name $t $null
        $level = 'unknown'
        $note = '没拿到结果'
        if ($null -ne $entry) {
            $level = [string](Get-Prop -Obj $entry -Name 'level' 'unknown')
            $note = [string](Get-Prop -Obj $entry -Name 'note' '')
        }
        if (-not $balanceEnabled) { $level = 'unknown'; $note = '探针没开' }
        $balanceOut[$t] = [ordered]@{ level = $level; note = $note }
        $levels += $level
        $balanceNotes += ($t + '=' + $level)
    }
    $balanceState = 'green'
    if ($levels -contains 'red') { $balanceState = 'red' }
    elseif ($levels -contains 'yellow') { $balanceState = 'yellow' }
    elseif (@($levels | Where-Object { $_ -eq 'unknown' }).Count -eq 3) { $balanceState = 'yellow' }
    $balanceDetail = ('三档：' + ($balanceNotes -join '、'))
    if (-not $balanceEnabled) { $balanceDetail = $balanceDetail + '（探针没开，一律 unknown，不编数）' }
    $balanceAction = ''
    if ($balanceState -eq 'red') { $balanceAction = '重开 Agent2API 或换这一档的密钥（详见 keep.json 的 note）' }
    [void]$rows.Add((New-Row 'balance' '模型账户探针' $balanceState $balanceDetail $balanceAction))

    # 11b) 部署后的重启请求（dot-core 打完补丁写过来的）
    $reload = Get-Prop -Obj $Plan -Name 'reloadRequest' $null
    $reloadPresent = To-Bool (Get-Prop -Obj $reload -Name 'present' $false)
    $reloadAge = [double](Get-Prop -Obj $reload -Name 'ageSeconds' -1)
    $reloadPatch = [string](Get-Prop -Obj $reload -Name 'patchId' '')
    if (-not $reloadPresent) {
        [void]$rows.Add((New-Row 'reloadRequest' '部署后重启' 'green' '没有待重启的部署' ''))
    } elseif ($reloadAge -lt 60) {
        [void]$rows.Add((New-Row 'reloadRequest' '部署后重启' 'yellow' ('刚写好 ' + [string][math]::Round($reloadAge, 0) + ' 秒，等一分钟再重启（别和部署动作抢）') ''))
    } else {
        [void]$rows.Add((New-Row 'reloadRequest' '部署后重启' 'yellow' ('部署 ' + $reloadPatch + ' 已完成，等重启网关生效') '重启网关（冷启动约 150 秒）'))
        [void]$actions.Add((New-Action 'apply_reload_request' 'process_restart' $gwStartCmd '部署需要重启网关才生效'))
    }

    # 12) 看门狗自己：计划任务 dot-keeper 还在不在
    $keeperTask = Get-Prop -Obj $Plan -Name 'keeperTask'
    $ktExists = To-Bool (Get-Prop -Obj $keeperTask -Name 'exists' $false)
    $ktEnabled = To-Bool (Get-Prop -Obj $keeperTask -Name 'enabled' $false)
    if ($ktExists -and $ktEnabled) {
        [void]$rows.Add((New-Row 'keeperTask' 'dot-keeper 计划任务' 'green' '任务在、没被禁' ''))
    } elseif ($ktExists -and (-not $ktEnabled)) {
        [void]$rows.Add((New-Row 'keeperTask' 'dot-keeper 计划任务' 'red' '任务被禁用了：看门狗自己不会跑' '重新启用：schtasks /Change /TN "dot-keeper" /ENABLE'))
    } else {
        [void]$rows.Add((New-Row 'keeperTask' 'dot-keeper 计划任务' 'red' '任务不在了：看门狗自己被删了' '重装：keeper-install.ps1 -Execute'))
    }

    $overall = 'green'
    foreach ($r in $rows) {
        if ($r.state -eq 'red') { $overall = 'red'; break }
        if ($r.state -eq 'yellow') { $overall = 'yellow' }
    }

    return @{
        rows           = $rows
        actions        = $actions
        overall        = $overall
        disk           = @{
            freeMb         = $freeMin
            ledgerFreeMb   = $freeLedger
            allbotFreeMb   = $freeAllbot
            state          = $diskState
            detail         = $diskDetail
            pauseAdmission = $pauseAdmission
        }
        backups        = @{
            count        = $bCount
            totalMb      = $bTotal
            keep         = $ret.keep
            willDelete   = $ret.deleteCount
            todayPresent = $bToday
            manual       = $ret.manual
            note         = $ret.note
        }
        balance        = $balanceOut
        gatewayStarts  = @($recentStarts | ForEach-Object { Format-Iso $_ })
        gatewayStops   = @($recentStops | ForEach-Object { Format-Iso $_ })
        gateVerifyDue  = $verifyDue
    }
}

# ---------------------------------------------------------------------------
# 执行动作（只有 -Execute 且未加 -DryRun 才真动手；不删任何文件）
# ---------------------------------------------------------------------------
function Invoke-KeeperActions {
    param($Actions, $Plan, [bool]$DoIt)

    $executed = New-Object System.Collections.ArrayList
    $startables = Get-Prop -Obj $Plan -Name 'startables'

    foreach ($a in $Actions) {
        $rec = [ordered]@{ id = $a.id; kind = $a.kind; cmd = $a.cmd; attempted = $false; ok = $false; detail = '' }
        if (-not $a.allowed) {
            $rec.detail = '退避/不允许：' + $a.suppressedReason
            [void]$executed.Add($rec)
            continue
        }
        if (-not $DoIt) {
            $rec.detail = 'dry-run：只打印不执行'
            [void]$executed.Add($rec)
            continue
        }
        $rec.attempted = $true
        try {
            switch ($a.id) {
                'start_gateway' {
                    $cmdPath = [string](Get-Prop -Obj $startables -Name 'gatewayPath' '')
                    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $cmdPath + '"')) -WindowStyle Hidden
                    $rec.ok = $true
                    $rec.detail = '已起 gateway.cmd'
                }
                'stop_gateway' {
                    $endOut = & schtasks /End /TN 'AllBot Gateway' 2>&1
                    $ended = ($LASTEXITCODE -eq 0)
                    $stopped = 0
                    $conns = @(Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue)
                    foreach ($c in $conns) {
                        $procId = [int]$c.OwningProcess
                        try { Stop-Process -Id $procId -Force -ErrorAction Stop; $stopped += 1 } catch { }
                    }
                    $rec.ok = ($ended -or $stopped -gt 0)
                    $endText = '失败'
                    if ($ended) { $endText = '成功' }
                    $rec.detail = ('schtasks /End：' + $endText + '；按端口停进程 ' + [string]$stopped + ' 个；' + (($endOut | Out-String).Trim()))
                }
                'apply_reload_request' {
                    # 顺序：先软停（计划任务 /End）→ 再按端口兜底杀 → 等两秒 → 用 gateway.cmd 起回
                    $endOut = & schtasks /End /TN 'AllBot Gateway' 2>&1
                    $stopped = 0
                    $conns = @(Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue)
                    foreach ($c in $conns) {
                        try { Stop-Process -Id ([int]$c.OwningProcess) -Force -ErrorAction Stop; $stopped += 1 } catch { }
                    }
                    Start-Sleep -Seconds 2
                    $cmdPath = [string](Get-Prop -Obj $startables -Name 'gatewayPath' '')
                    if ([string]::IsNullOrEmpty($cmdPath) -or -not (Test-Path $cmdPath)) {
                        $rec.ok = $false
                        $rec.detail = '重启失败：找不到 gateway.cmd（' + $cmdPath + '），部署请求保留'
                    } else {
                        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $cmdPath + '"')) -WindowStyle Hidden
                        try { Remove-Item -LiteralPath $ReloadRequestPath -Force -ErrorAction SilentlyContinue } catch { }
                        $rec.ok = $true
                        $rec.detail = ('已按部署请求重启网关（按端口停 ' + [string]$stopped + ' 个；冷启动约 150 秒）')
                    }
                }
                'start_stack' {
                    # 一条命令把「手」用的服务都叫起来：dot-up.ps1 自己盘谁红起谁。
                    # 网关不归它管（那是 start_gateway / apply_reload_request 的退避逻辑）。
                    $upLogDir = Join-Path $env:USERPROFILE '.allbot\dot\logs'
                    if (-not (Test-Path $upLogDir)) { New-Item -ItemType Directory -Force -Path $upLogDir | Out-Null }
                    $upLog = Join-Path $upLogDir ('dot-up-' + [datetime]::Now.ToString('HHmmss') + '.log')
                    # 用 WaitForExit 设上限：dot-up 可能要等 90 秒才有端口，但绝不能把 keeper 拖死。
                    $upProc = Start-Process -FilePath 'powershell.exe' `
                        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $StackUpScript, '-SkipGateway') `
                        -WindowStyle Hidden -PassThru `
                        -RedirectStandardOutput $upLog -RedirectStandardError ($upLog + '.err')
                    $null = $upProc.WaitForExit(300000)
                    # 不认 ExitCode（Start-Process -PassThru 拿到的对象退出后 ExitCode 可能是空，
                    # 2026-11-25 实测过），直接按端口复查：五个「手」服务几个在跑才是事实。
                    $aliveNow = 0
                    foreach ($upPort in @(8799, 8000, 8931, 8932, 8933)) {
                        if (Test-TcpPort -Port $upPort) { $aliveNow += 1 }
                    }
                    $outText = ''
                    try {
                        if (Test-Path $upLog) {
                            # powershell.exe 写重定向文件用的是系统 ANSI 编码（这台机是 GBK），
                            # 按 UTF8 读会全是乱码。
                            $outText = [System.IO.File]::ReadAllText($upLog, [System.Text.Encoding]::Default)
                        }
                    } catch { }
                    $rec.ok = ($aliveNow -eq 5)
                    $rec.detail = ('服务 ' + [string]$aliveNow + '/5 在跑；dot-up 原话：' + $outText.Trim() + '（日志 ' + $upLog + '）')
                }
                'start_bridge' {
                    # 桥的入口是 node build/dot-bridge/index.mjs（build/dot-bridge/README.md）
                    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $a.cmd + '"')) -WindowStyle Hidden
                    $rec.ok = $true
                    $rec.detail = '已起 dot-bridge（' + $a.cmd + '）'
                }
                'start_windows_mcp' {
                    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $a.cmd + '"')) -WindowStyle Hidden
                    $rec.ok = $true
                    $rec.detail = '已按配置拉起 Windows-MCP（未改 config.toml）'
                }
                'start_playwright' {
                    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $a.cmd + '"')) -WindowStyle Hidden
                    $rec.ok = $true
                    $rec.detail = '已拉起 Playwright MCP'
                }
                'start_clean_browser' {
                    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $a.cmd + '"')) -WindowStyle Hidden
                    $rec.ok = $true
                    $rec.detail = '已拉起干净浏览器（8932）'
                }
                'start_wechat' {
                    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $a.cmd + '"')) -WindowStyle Hidden
                    $rec.ok = $true
                    $rec.detail = '已拉起微信手（wechat-mcp HTTP 8933）'
                }
                'run_gate_verify' {
                    $out = & node --no-warnings $a.cmd 2>&1
                    $rec.ok = ($LASTEXITCODE -eq 0)
                    $rec.detail = ('exit=' + [string]$LASTEXITCODE + ' ' + (($out | Out-String).Trim()))
                }
                'backup_now' {
                    $todayName = 'dot-' + [datetime]::UtcNow.ToLocalTime().ToString('yyyyMMdd') + '.db'
                    $target = Join-Path $BackupDir $todayName
                    $out = & node --no-warnings $HelperPath backup --db $LedgerDbPath --out $target 2>&1
                    $rec.ok = ($LASTEXITCODE -eq 0)
                    $rec.detail = (($out | Out-String).Trim())
                }
                default {
                    $rec.detail = '未知动作，不执行'
                }
            }
        } catch {
            $rec.ok = $false
            $rec.detail = '执行失败：' + [string]$_.Exception.Message
        }
        [void]$executed.Add($rec)
    }
    return $executed
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
function Invoke-Keeper {
    $nowUtc = Get-NowUtc
    $prior = Read-KeeperState -Path $StateFile

    $plan = $null
    if (-not [string]::IsNullOrEmpty($PlanFile)) {
        $plan = Get-Content -Raw -Encoding UTF8 $PlanFile | ConvertFrom-Json
    } else {
        $plan = Get-RealPlan -PriorState $prior
    }
    $planNow = Parse-IsoSafe ([string](Get-Prop -Obj $plan -Name 'now' ''))
    if ($null -ne $planNow) { $nowUtc = $planNow }

    # plan 里能给的就覆盖状态（测试/演练时用来注入历史）
    foreach ($key in @('gatewayStarts', 'gatewayStops')) {
        $v = Get-Prop -Obj $plan -Name $key $null
        if ($null -ne $v) { $prior[$key] = @($v) }
    }
    foreach ($key in @('gateVerifyLastRunAt', 'gateVerifyLastOk', 'gateVerifyLastDetail')) {
        $v = Get-Prop -Obj $plan -Name $key $null
        if ($null -ne $v) { $prior[$key] = $v }
    }

    $verdict = Get-KeeperVerdict -Plan $plan -PriorState $prior -NowUtc $nowUtc
    $executed = Invoke-KeeperActions -Actions $verdict.actions -Plan $plan -DoIt $doIt

    # 真起了网关 / 真停了网关，就记进退避历史（下一轮的上限与「别立刻起回来」靠它）
    $gatewayStarts = @($verdict.gatewayStarts)
    $gatewayStops = @($verdict.gatewayStops)
    if (@($executed | Where-Object { $_.id -eq 'start_gateway' -and $_.ok }).Count -gt 0) {
        $gatewayStarts = @((@($gatewayStarts) + @((Format-Iso $nowUtc))) | Select-Object -Last 20)
    }
    if (@($executed | Where-Object { $_.id -eq 'stop_gateway' -and $_.ok }).Count -gt 0) {
        $gatewayStops = @((@($gatewayStops) + @((Format-Iso $nowUtc))) | Select-Object -Last 20)
    }
    $gateVerifyLastOk = Get-Prop -Obj $prior -Name 'gateVerifyLastOk' $null
    $gateVerifyLastDetail = [string](Get-Prop -Obj $prior -Name 'gateVerifyLastDetail' '')
    $gateVerifyLastRunAt = Get-Prop -Obj $prior -Name 'gateVerifyLastRunAt' $null
    $verifyRec = @($executed | Where-Object { $_.id -eq 'run_gate_verify' -and $_.attempted })
    if (@($verifyRec).Count -gt 0) {
        $gateVerifyLastRunAt = Format-Iso $nowUtc
        $gateVerifyLastOk = [bool]$verifyRec[0].ok
        $detail = [string]$verifyRec[0].detail
        if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) }
        $gateVerifyLastDetail = $detail
    }

    # 恢复报告联动（A.9 第 5 步）：读账本里最近一份恢复报告；读不到就如实说读不到。
    $ledgerInfo = [ordered]@{ read = $false; recoveryReport = $null; eventCount = 0; chainOk = $null; error = '' }
    if (-not $NoLedger) {
        if ((Test-Path $HelperPath) -and (Test-Path $LedgerDbPath)) {
            try {
                $raw = & node --no-warnings $HelperPath report --db $LedgerDbPath 2>&1
                $line = (($raw | Out-String).Trim())
                $parsed = $null
                try { $parsed = $line | ConvertFrom-Json } catch { $parsed = $null }
                if ($null -ne $parsed) {
                    $ledgerInfo.read = To-Bool (Get-Prop -Obj $parsed -Name 'ok' $false)
                    $ledgerInfo.recoveryReport = Get-Prop -Obj $parsed -Name 'latestRecoveryReport' $null
                    $ledgerInfo.eventCount = [int](Get-Prop -Obj $parsed -Name 'eventCount' 0)
                    $chain = Get-Prop -Obj $parsed -Name 'chain'
                    $ledgerInfo.chainOk = Get-Prop -Obj $chain -Name 'ok' $null
                    $ledgerInfo.error = [string](Get-Prop -Obj $parsed -Name 'error' '')
                } else {
                    $ledgerInfo.error = '账本助手输出不是 JSON：' + $line
                }
            } catch {
                $ledgerInfo.error = '调账本助手失败：' + [string]$_.Exception.Message
            }
        } else {
            $ledgerInfo.error = '账本或助手不在：' + $LedgerDbPath
        }
    }

    if ($NoLedger) {
        $ledgerRowState = 'yellow'
        $ledgerRowDetail = '本轮跳过账本检查（-NoLedger）'
    } elseif (-not $ledgerInfo.read) {
        $ledgerRowState = 'yellow'
        $ledgerRowDetail = ('账本读不了：' + $ledgerInfo.error)
    } elseif ($ledgerInfo.chainOk -eq $false) {
        $ledgerRowState = 'red'
        $ledgerRowDetail = 'events 哈希链断了（账本被改过或写坏）'
    } else {
        $ledgerRowState = 'green'
        $recovText = '还没有'
        if ($null -ne $ledgerInfo.recoveryReport) { $recovText = '有' }
        $ledgerRowDetail = ('events ' + [string]$ledgerInfo.eventCount + ' 条，哈希链对得上；恢复报告：' + $recovText)
    }
    [void]$verdict.rows.Add((New-Row 'ledger' '账本通道' $ledgerRowState $ledgerRowDetail ''))

    $overall = 'green'
    foreach ($r in $verdict.rows) {
        if ($r.state -eq 'red') { $overall = 'red'; break }
        if ($r.state -eq 'yellow') { $overall = 'yellow' }
    }

    $result = [ordered]@{
        schema      = 1
        generatedAt = (Format-Iso $nowUtc)
        dryRun      = (-not $doIt)
        execute     = $doIt
        planFile    = $PlanFile
        overall     = $overall
        rows        = @($verdict.rows)
        actions     = @($verdict.actions)
        executed    = @($executed)
        disk        = $verdict.disk
        backups     = $verdict.backups
        balance     = $verdict.balance
        recommendations = [ordered]@{
            # B.7：备份减份由 dot-core 的 src/maintenance 执行；keeper 只把建议交出去
            backupPrune = [ordered]@{
                keep       = $verdict.backups.keep
                willDelete = $verdict.backups.willDelete
                manual     = $verdict.backups.manual
                note       = $verdict.backups.note
                executor   = 'dot-core/src/maintenance'
            }
        }
        ledger      = [ordered]@{
            read           = $ledgerInfo.read
            recoveryReport = $ledgerInfo.recoveryReport
            eventCount     = $ledgerInfo.eventCount
            chainOk        = $ledgerInfo.chainOk
            error          = $ledgerInfo.error
        }
        paths       = [ordered]@{
            stateFile  = $StateFile
            backupDir  = $BackupDir
            ledgerDb   = $LedgerDbPath
            reportPath = $ReportPath
            queuePath  = $QueuePath
        }
    }

    # keep.json：桥与 dot-core 只读。形状对齐 dot-core/src/bridge/keep.ts（disk.freeMb、
    # backups.bytes、balance.<tier>.level/note、components 映射）。dry-run 也写（-NoState 可关）。
    if (-not $NoState) {
        $probedAt = [string](Get-Prop -Obj $plan -Name 'now' '')
        if ($probedAt -eq '') { $probedAt = Format-Iso $nowUtc }
        $backupBytes = [int64]([double]$verdict.backups.totalMb * 1MB)
        $planSnap = Get-Prop -Obj $plan -Name 'snapshots'
        $snapMb = Get-Prop -Obj $planSnap -Name 'mb' $null
        $components = [ordered]@{}
        foreach ($r in $verdict.rows) {
            $components[$r.id] = [ordered]@{ level = $r.state; note = $r.detail }
        }
        $balanceKeep = [ordered]@{}
        foreach ($t in @('cheap', 'balanced', 'strong')) {
            $balanceKeep[$t] = [ordered]@{
                level = $verdict.balance[$t].level
                note  = $verdict.balance[$t].note
            }
        }
        $freeText = '未知'
        if ($null -ne $verdict.disk.freeMb) { $freeText = ('{0:N1} GB' -f ([double]$verdict.disk.freeMb / 1024)) }
        $line = ('盘剩 ' + $freeText +
            '／备份 ' + ('{0:N0} MB' -f [double]$verdict.backups.totalMb) +
            '／artifacts 未知' +
            '／snapshots ' + $(if ($null -eq $snapMb) { '未知' } else { [string]$snapMb + ' MB' }) +
            '／账户探针：' + $verdict.balance.cheap.level + '·' + $verdict.balance.balanced.level + '·' + $verdict.balance.strong.level +
            '·' + $nowUtc.ToLocalTime().ToString('HH:mm'))
        $keepOut = [ordered]@{
            schema              = 1
            updatedAt           = (Format-Iso $nowUtc)
            probedAt            = $probedAt
            dryRun              = (-not $doIt)
            overall             = $overall
            line                = $line
            disk                = [ordered]@{
                freeMb         = $verdict.disk.freeMb
                state          = $verdict.disk.state
                detail         = $verdict.disk.detail
                ledgerFreeMb   = $verdict.disk.ledgerFreeMb
                allbotFreeMb   = $verdict.disk.allbotFreeMb
                pauseAdmission = $verdict.disk.pauseAdmission
            }
            # keeper 不置 admission：置位的是 dot-core（B.7）。这里只把数字与请求写出来。
            admission           = $null
            backups             = [ordered]@{
                bytes        = $backupBytes
                count        = $verdict.backups.count
                keep         = $verdict.backups.keep
                willDelete   = $verdict.backups.willDelete
                todayPresent = $verdict.backups.todayPresent
                manual       = $verdict.backups.manual
                note         = $verdict.backups.note
            }
            artifacts           = [ordered]@{ bytes = $null; note = '在账本库里，由 dot-core maintenance 量' }
            snapshots           = [ordered]@{
                bytes = $(if ($null -eq $snapMb) { $null } else { [int64]([double]$snapMb * 1MB) })
                note  = $(if ($null -eq $snapMb) { '目录不在或没量到' } else { '' })
            }
            balance             = $balanceKeep
            components          = $components
            gatewayStarts       = @($gatewayStarts)
            gatewayStops        = @($gatewayStops)
            gateVerifyLastRunAt = $gateVerifyLastRunAt
            gateVerifyLastOk    = $gateVerifyLastOk
            gateVerifyLastDetail = $gateVerifyLastDetail
            recommendations     = $result.recommendations
            rows                = @($verdict.rows | ForEach-Object { [ordered]@{ id = $_.id; state = $_.state; detail = $_.detail } })
            reportPath          = $ReportPath
            queuePath           = $QueuePath
        }
        try {
            Write-JsonFile -Path $StateFile -Value $keepOut
        } catch {
            $result['stateWriteError'] = [string]$_.Exception.Message
        }

        # 巡检报告：状态页横幅读这个（A.9 第 5 步的「写恢复报告 → 状态页」）
        $report = [ordered]@{
            schema      = 1
            kind        = 'keeper_patrol'
            generatedAt = (Format-Iso $nowUtc)
            dryRun      = (-not $doIt)
            overall     = $overall
            rows        = @($result.rows)
            executed    = @($result.executed)
            recovery    = [ordered]@{
                latestInLedger = $ledgerInfo.recoveryReport
                ledgerRead     = $ledgerInfo.read
                ledgerError    = $ledgerInfo.error
            }
        }
        try {
            Write-JsonFile -Path $ReportPath -Value $report
        } catch { }
        # 队列：dot-core 的 maintenance 用 keeper-ledger.mjs drain 落 events（keeper 不写账本）
        try {
            if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
            $queueLine = ($report | ConvertTo-Json -Depth 10 -Compress)
            [System.IO.File]::AppendAllText($QueuePath, ($queueLine + "`n"), $utf8NoBom)
        } catch { }
    }

    if (-not [string]::IsNullOrEmpty($JsonOut)) {
        try { Write-JsonFile -Path $JsonOut -Value $result } catch { }
    }

    if ($Json) {
        Write-Output ($result | ConvertTo-Json -Depth 10 -Compress)
    } else {
        $modeText = '  [dry-run：只报不动作]'
        if ($doIt) { $modeText = '  [执行模式]' }
        Write-Output ('dot-keeper 巡检  ' + (Format-Iso $nowUtc) + $modeText)
        Write-Output ('总体：' + $overall)
        foreach ($r in $result.rows) {
            $mark = '[?]'
            if ($r.state -eq 'green') { $mark = '[绿]' }
            elseif ($r.state -eq 'yellow') { $mark = '[黄]' }
            elseif ($r.state -eq 'red') { $mark = '[红]' }
            $text = $mark + ' ' + $r.title + ' — ' + $r.detail
            if ($r.action -ne '') { $text = $text + ' → ' + $r.action }
            Write-Output $text
        }
        if (@($result.actions).Count -eq 0) {
            Write-Output '计划动作：无'
        } else {
            Write-Output '计划动作：'
            foreach ($a in $result.actions) {
                $flag = ''
                if (-not $a.allowed) { $flag = '（退避，不执行）' }
                elseif (-not $doIt) { $flag = '（dry-run 只打印）' }
                Write-Output ('  - ' + $a.id + '：' + $a.cmd + $flag)
            }
        }
        if ($result.recommendations.backupPrune.willDelete -gt 0) {
            Write-Output ('减份建议（由 dot-core maintenance 执行，keeper 不删）：保留 ' + [string]$result.recommendations.backupPrune.keep + ' 份')
        }
        Write-Output ('状态文件：' + $StateFile)
        Write-Output ('巡检报告：' + $ReportPath)
    }
}

try {
    Invoke-Keeper
    exit 0
} catch {
    [Console]::Error.WriteLine('keeper 自身出错：' + [string]$_.Exception.Message)
    [Console]::Error.WriteLine([string]$_.ScriptStackTrace)
    exit 2
}
