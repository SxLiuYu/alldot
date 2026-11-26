<#
.SYNOPSIS
  dot-keeper 安装脚本：建计划任务 dot-keeper（登录触发、失败自动重启）。依据方案 B.7 末段。

.DESCRIPTION
  默认只打印「要做什么」，不执行。加 -Execute 才真正注册计划任务。
  这个脚本只碰「计划任务」这一件事，不改 allbot.json、不碰 ds-bot、不装包。

  任务规格（对应 B.7「dot-keeper 用计划任务『失败自动重启』＋体检脚本检查任务还在不在」）：
    - 触发：用户登录时 + 之后每 5 分钟重复（一轮巡检 5 分钟一条，探针防抖靠 keep.json）
    - 动作：powershell.exe -NoProfile -ExecutionPolicy Bypass -File <tools>\keeper.ps1 -Execute
    - 失败重启：最多 3 次，间隔 1 分钟
    - 多实例：IgnoreNew（上一轮没跑完就不再起一轮，避免两个 keeper 同时改 keep.json）
    - 单轮上限：10 分钟
    - 错过的计划：StartWhenAvailable（机器睡眠醒来补跑一轮）
    - 只在用户登录时跑（不需要 SYSTEM、不需要开机前跑；账本和 allbot 都在用户目录）

  注册完会自动回读任务 XML 做形状自检：必须同时有 LogonTrigger、TimeTrigger、
  RestartOnFailure Count=3、StartWhenAvailable=true，缺一样就报红退出 1。
  2026-11-25 的教训：机器上实际注册的那个 dot-keeper 只有一个 TimeTrigger PT5M
  （LogonTrigger 0、RestartOnFailure 0、StartWhenAvailable 0），是当年用下面那条
  「schtasks /SC MINUTE」降级命令建的——它满足不了「开机/登录后自己起来」。现在降级
  路径改成导出台式 XML 再用 schtasks /Create /XML，触发器与重启设置不会丢。

  两条部署注意：
    1) 注册「登录触发」任务通常需要管理员权限；没有管理员就把下面打印的 XML/schtasks 交给有权限的会话执行。
    2) B.3 说一期「统一由 dot-keeper 在登录时起（避免双起）」——如果 allbot 自己的 `AllBot Gateway`
       计划任务已经是登录自启，装完 dot-keeper 后要把那个任务停用，否则两个都会去起网关。
       keeper 侧负责停网关（fail-closed）时也会先 `schtasks /End /TN "AllBot Gateway"`，
       任务若还带着自动重启，会和 keeper 抢，请在安装时一并处理。

.PARAMETER Execute
  真正注册/更新计划任务。缺省 dry-run，只打印。

.PARAMETER TaskName
  计划任务名，默认 dot-keeper（B.7 定稿名）。

.PARAMETER EveryMinutes
  重复间隔，默认 5 分钟（B.7：探针每 5 分钟一轮）。

.PARAMETER KeeperPath
  keeper.ps1 路径，默认与本脚本同目录。

.PARAMETER Remove
  卸载：删除计划任务 dot-keeper。同样默认只打印，加 -Execute 才删。

.PARAMETER Verify
  只做自检：回读已注册任务的 XML，检查 LogonTrigger / TimeTrigger / RestartOnFailure(3) /
  StartWhenAvailable(true)。全都在退出 0，缺任何一样退出 1。不注册、不删除。

.NOTES
  PS 5.1 兼容；文件必须带 UTF-8 BOM。
  退出码：0 = 成功（dry-run 也算成功）；1 = 注册失败。
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$DryRun,
    [string]$TaskName = 'dot-keeper',
    [int]$EveryMinutes = 5,
    [string]$KeeperPath = '',
    [switch]$Remove,
    [switch]$Verify
)

$ErrorActionPreference = 'Continue'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8NoBom } catch { }
try { $OutputEncoding = $utf8NoBom } catch { }

$ToolsDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ToolsDir)) { $ToolsDir = (Get-Location).Path }
if ([string]::IsNullOrEmpty($KeeperPath)) { $KeeperPath = Join-Path $ToolsDir 'keeper.ps1' }

$doIt = ($Execute -and (-not $DryRun))
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $KeeperPath + '" -Execute'
$ScriptSelf = $PSCommandPath
if ([string]::IsNullOrEmpty($ScriptSelf)) { $ScriptSelf = $MyInvocation.MyCommand.Path }
$script:ShapeOk = $false

function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

# 回读任务 XML。schtasks /Query /XML 在任务不存在时退出码非 0，返回 $null。
function Get-TaskXmlText {
    param([string]$Name)
    $raw = & schtasks.exe /Query /TN $Name /XML 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($raw | Out-String)
}

# 形状自检：返回问题清单，空表示四条都在。
# 对应方案第 1 步验收 1「开机后 1 分钟内服务自己起来；强杀后 2 分钟内回来」：
# 登录触发负责「起来」，每 5 分钟轮询负责「回来」，RestartOnFailure 覆盖进程非 0 退出。
function Test-TaskShape {
    param([string]$Name)
    $xml = Get-TaskXmlText -Name $Name
    if ([string]::IsNullOrEmpty($xml)) { return @('查不到任务 XML（任务不存在，或不是当前用户/没权限）') }
    $problems = @()
    if ($xml -notmatch '<LogonTrigger>') { $problems += '没有 LogonTrigger：登录后不会自己起来' }
    if ($xml -notmatch '<TimeTrigger>') { $problems += '没有 TimeTrigger：没有每 N 分钟轮询，强杀后回不来' }
    if ($xml -notmatch '<StartWhenAvailable>\s*true\s*</StartWhenAvailable>') { $problems += 'StartWhenAvailable 不是 true：睡眠/关机错过的轮次不补跑' }
    if ($xml -notmatch '<RestartOnFailure>') {
        $problems += '没有 RestartOnFailure：进程非 0 退出后不会自动重启'
    } elseif ($xml -notmatch '<Count>\s*3\s*</Count>') {
        $problems += 'RestartOnFailure 的 Count 不是 3'
    }
    return $problems
}

# 打印自检报告，结论放 $script:ShapeOk（不 return：return 的值会被调用处的 if() 吃掉，
# 字符串数组在 if 里恒为真，2026-11-26 实测踩过——问题清单一个都没打印却 exit 0）。
function Write-TaskShapeReport {
    param([string]$Name)
    $problems = Test-TaskShape -Name $Name
    if (@($problems).Count -eq 0) {
        Write-Output ('自检通过：' + $Name + ' 有 LogonTrigger + TimeTrigger(每 ' + [string]$EveryMinutes + ' 分钟) + RestartOnFailure(3) + StartWhenAvailable(true)')
        $script:ShapeOk = $true
        return
    }
    $script:ShapeOk = $false
    Write-Output ('自检不通过：' + $Name + ' 缺以下项——')
    foreach ($p in $problems) { Write-Output ('  - ' + $p) }
    Write-Output '处置（重新注册）：'
    Write-Output ('  schtasks /Delete /TN "' + $Name + '" /F')
    Write-Output ('  ' + $psExe + ' -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptSelf + '" -Execute')
    Write-Output ('  再复核：' + $psExe + ' -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptSelf + '" -Verify')
}

function ConvertTo-XmlText {
    param([string]$s)
    $t = [string]$s
    $t = $t -replace '&', '&amp;'
    $t = $t -replace '<', '&lt;'
    $t = $t -replace '>', '&gt;'
    $t = $t -replace '"', '&quot;'
    return $t
}

# 降级路径：schtasks /SC MINUTE 建不出登录触发器，也带不上 RestartOnFailure。
# 这里生成完整任务 XML（登录触发 + 每 N 分钟重复 + 失败重启 3 次 + 错过补跑），
# 用 schtasks /Create /XML 注册，形状与 Register-ScheduledTask 那条一致。
function New-KeeperTaskXml {
    param([string]$Name, [string]$Exe, [string]$ArgLine)
    $start = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    $interval = 'PT' + [string]$EveryMinutes + 'M'
    $lines = @(
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        '  <RegistrationInfo>',
        ('    <Description>' + (ConvertTo-XmlText ('dot 看门狗：巡检 3065/18789/dot-core/8799/8000/8931/口闸/ds-bot、磁盘与账户探针、账本备份（B.7）')) + '</Description>'),
        '  </RegistrationInfo>',
        '  <Triggers>',
        '    <LogonTrigger>',
        '      <Enabled>true</Enabled>',
        '    </LogonTrigger>',
        '    <TimeTrigger>',
        ('      <StartBoundary>' + $start + '</StartBoundary>'),
        '      <Enabled>true</Enabled>',
        '      <Repetition>',
        ('        <Interval>' + $interval + '</Interval>'),
        '        <StopAtDurationEnd>false</StopAtDurationEnd>',
        '      </Repetition>',
        '    </TimeTrigger>',
        '  </Triggers>',
        '  <Principals>',
        '    <Principal id="Author">',
        '      <LogonType>InteractiveToken</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
        '  </Principals>',
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <AllowHardTerminate>true</AllowHardTerminate>',
        '    <StartWhenAvailable>true</StartWhenAvailable>',
        '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
        '    <IdleSettings>',
        '      <StopOnIdleEnd>false</StopOnIdleEnd>',
        '      <RestartOnIdle>false</RestartOnIdle>',
        '    </IdleSettings>',
        '    <AllowStartOnDemand>true</AllowStartOnDemand>',
        '    <Enabled>true</Enabled>',
        '    <Hidden>false</Hidden>',
        '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
        '    <WakeToRun>false</WakeToRun>',
        '    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>',
        '    <Priority>7</Priority>',
        '    <RestartOnFailure>',
        '      <Interval>PT1M</Interval>',
        '      <Count>3</Count>',
        '    </RestartOnFailure>',
        '  </Settings>',
        '  <Actions Context="Author">',
        '    <Exec>',
        ('      <Command>' + (ConvertTo-XmlText $Exe) + '</Command>'),
        ('      <Arguments>' + (ConvertTo-XmlText $ArgLine) + '</Arguments>'),
        '    </Exec>',
        '  </Actions>',
        '</Task>'
    )
    return ($lines -join "`r`n")
}

Write-Output ('dot-keeper 安装  ' + $(if ($doIt) { '[执行模式]' } else { '[dry-run：只打印，不执行]' }))

if ($Verify) {
    Write-Output ('只做自检，不注册：' + $TaskName)
    Write-TaskShapeReport -Name $TaskName
    if ($script:ShapeOk) { exit 0 }
    exit 1
}

if ($Remove) {
    Write-Output ('要做的事：删除计划任务 ' + $TaskName)
    Write-Output ('  schtasks /Delete /TN "' + $TaskName + '" /F')
    if (-not $doIt) {
        Write-Output '未执行（加 -Execute 才删）。'
        exit 0
    }
    & schtasks /Delete /TN $TaskName /F 2>&1 | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -eq 0) { Write-Output '已删除。'; exit 0 }
    Write-Output ('删除失败，退出码 ' + [string]$LASTEXITCODE)
    exit 1
}

if (-not (Test-Path $KeeperPath)) {
    Write-Output ('找不到 keeper.ps1：' + $KeeperPath)
    Write-Output '先把 keeper.ps1 放在 build\tools\ 下，或用 -KeeperPath 指到它。'
    exit 1
}

Write-Output ('计划任务名：' + $TaskName)
Write-Output ('巡检脚本：  ' + $KeeperPath)
Write-Output ('执行命令行：' + $psExe + ' ' + $argLine)
Write-Output ('触发：      用户登录时，并每 ' + [string]$EveryMinutes + ' 分钟重复一次')
Write-Output '设置：      失败最多重启 3 次、间隔 1 分钟；多实例 IgnoreNew；单轮上限 10 分钟；错过补跑'
Write-Output ''

# 不要用「schtasks /Create /SC MINUTE」代替下面这套：它建不出登录触发器，也带不上
# RestartOnFailure 和 StartWhenAvailable。2026-11-25 机器上那个不满足验收的 dot-keeper
# 就是这么来的（XML 里只有 TimeTrigger PT5M）。没有 Register-ScheduledTask 权限时，
# 用下面这条完整 XML 路径，触发器不会丢。
Write-Output '降级写法（没有 ScheduledTasks 模块权限时；仍是登录触发＋每 N 分钟重复，不是 /SC MINUTE）：'
Write-Output ('  schtasks /Create /TN "' + $TaskName + '" /XML "<导出的任务 XML>" /F')
Write-Output '  本脚本 -Execute 时若 Register-ScheduledTask 失败，会自动生成该 XML（带 LogonTrigger /'
Write-Output '  TimeTrigger / RestartOnFailure(3) / StartWhenAvailable=true）并把路径打印出来。'
Write-Output ''

$registerScript = @'
$action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigLogon, $trigRepeat) -Settings $settings -Description 'dot 看门狗：巡检 3065/18789/dot-core/8799/8000/8931/口闸/ds-bot、磁盘与账户探针、账本备份（B.7）' -Force
'@

Write-Output 'PowerShell 注册片段（-Execute 时执行的就是这套）：'
Write-Output '----------------------------------------'
Write-Output $registerScript
Write-Output '----------------------------------------'
Write-Output ''

if (-not (Test-Admin)) {
    Write-Output '当前会话不是管理员。注册「登录触发」任务通常需要管理员权限；'
    Write-Output '请在管理员 PowerShell 里跑本脚本 -Execute，或把上面的片段交给有权限的会话执行。'
    Write-Output ''
}

Write-Output '装完必须一起处理的两件事：'
Write-Output '  1) 若 allbot 的 "AllBot Gateway" 计划任务也是登录自启，先停用，避免和 keeper 双起：'
Write-Output '       schtasks /Change /TN "AllBot Gateway" /DISABLE'
Write-Output '  2) 第一次装完后手动跑一轮看输出（dry-run，不动手）：'
Write-Output ('       ' + $psExe + ' -NoProfile -ExecutionPolicy Bypass -File "' + $KeeperPath + '"')
Write-Output ('  卸载：schtasks /Delete /TN "' + $TaskName + '" /F')
Write-Output ''

if (-not $doIt) {
    Write-Output '未执行（这是 dry-run；加 -Execute 才注册计划任务）。'
    exit 0
}

$registered = $false
try {
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine
    $trigLogon = New-ScheduledTaskTrigger -AtLogOn
    $trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $desc = 'dot 看门狗：巡检 3065/18789/dot-core/8799/8000/8931/口闸/ds-bot、磁盘与账户探针、账本备份（B.7）'
    $task = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigLogon, $trigRepeat) -Settings $settings -Description $desc -Force -ErrorAction Stop
    Write-Output ('已注册：' + $task.TaskName + '（' + [string]$task.State + '）')
    $registered = $true
} catch {
    Write-Output ('Register-ScheduledTask 失败：' + [string]$_.Exception.Message)
    Write-Output '改用完整 XML 路径（登录触发、失败重启、错过补跑都在 XML 里，不会像 /SC MINUTE 那样丢）：'
    $xmlPath = Join-Path $env:TEMP ($TaskName + '.task.xml')
    try {
        $xmlText = New-KeeperTaskXml -Name $TaskName -Exe $psExe -ArgLine $argLine
        [System.IO.File]::WriteAllText($xmlPath, $xmlText, (New-Object System.Text.UnicodeEncoding($false, $true)))
        Write-Output ('  已写出 XML：' + $xmlPath)
        & schtasks.exe /Create /TN $TaskName /XML $xmlPath /F 2>&1 | ForEach-Object { Write-Output ('  ' + $_) }
        if ($LASTEXITCODE -eq 0) {
            $registered = $true
        } else {
            Write-Output ('  schtasks /Create /XML 失败，退出码 ' + [string]$LASTEXITCODE)
            Write-Output ('  手工执行：schtasks /Create /TN "' + $TaskName + '" /XML "' + $xmlPath + '" /F')
        }
    } catch {
        Write-Output ('  写 XML 或按 XML 注册也失败：' + [string]$_.Exception.Message)
    }
    Write-Output '常见原因：不是管理员、同名任务属于别的用户、组策略禁止登录触发任务。'
}

if (-not $registered) { exit 1 }

Write-Output ''
Write-TaskShapeReport -Name $TaskName
if ($script:ShapeOk) { exit 0 }
exit 1
