# alldot 公网入口隧道守护（每分钟由计划任务调用）
#
# 作用：维持 SSH 反向隧道 123.57.107.21:18799 -> 本机 127.0.0.1:8799，
#       让手机经 https://relay.sxliuyu.bond/dot/ 访问电脑上的 alldot 桥。
# 判活：在 123 上 curl 127.0.0.1:18799/health，通就什么都不做；
#       不通就杀掉本机残留 ssh 隧道进程、重连一条。
# 幂等：多次运行不会叠加多条隧道（每次先清同端口的 ssh -R）。
$ErrorActionPreference = 'SilentlyContinue'

$sshKey = Join-Path $env:USERPROFILE '.ssh\sxliuyu_123'
$remote = 'root@123.57.107.21'
$sshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
$log = Join-Path $env:USERPROFILE '.allbot\dot\state\tunnel-keepalive.log'

function Write-Log($msg) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Add-Content -Path $log -Value $line -Encoding UTF8
    # 日志只留最近 200 行
    $all = Get-Content $log -Encoding UTF8
    if ($all.Count -gt 200) { $all[-200..-1] | Set-Content $log -Encoding UTF8 }
}

# 1) 在 123 上探隧道落点是否活着
$probe = & $sshExe -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new `
    -i $sshKey $remote "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18799/health" 2>$null
if (("$probe").Trim() -eq '200') { exit 0 }

Write-Log "隧道不通（probe=$probe），准备重建"

# 2) 清掉本机残留的 18799 隧道进程
$stale = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
    Where-Object { $_.CommandLine -match '18799:127\.0\.0\.1:8799' }
foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

# 3) 重连（-f 后台，ExitOnForwardFailure 让端口冲突时立刻退出而不是假活）
& $sshExe -N -f -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 `
    -o ServerAliveCountMax=3 -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new `
    -i $sshKey -R 127.0.0.1:18799:127.0.0.1:8799 $remote 2>$null

Start-Sleep -Seconds 2
$verify = & $sshExe -o BatchMode=yes -o ConnectTimeout=8 -i $sshKey $remote `
    "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18799/health" 2>$null
if (("$verify").Trim() -eq '200') { Write-Log '重建成功，隧道通' }
else { Write-Log "重建后仍不通（verify=$verify），等下一轮" }
