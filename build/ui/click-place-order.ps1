# build/ui/click-place-order.ps1 —— 真机点一次「派活」（我自己验，不靠人手）
# 用法：powershell -ExecutionPolicy Bypass -File click-place-order.ps1 -Intent "..." -Workspace "C:/..."
param(
  [string]$Intent = '在练习文件夹里建一个叫 界面验收 的文件夹',
  [string]$Workspace = 'C:/Users/1/Documents/练习',
  [string]$Shot = 'C:\Users\1\Documents\研究\dot\build\ui\shot-place.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
public struct RECT { public int L,T,R,B; }
'@

$p = Get-Process alldot -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { throw 'alldot 没在跑' }
$h = $p.MainWindowHandle
[W.U]::SetWindowPos($h, [IntPtr]-1, 0,0,0,0, 0x0001 -bor 0x0002) | Out-Null
[W.U]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object W.U+RECT
[W.U]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host ("窗口 左={0} 上={1} 宽={2} 高={3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))

function ClickAbs([int]$x, [int]$y) {
  [W.U]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [W.U]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # 左键按下
  Start-Sleep -Milliseconds 60
  [W.U]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # 左键抬起
  Start-Sleep -Milliseconds 300
}

function PasteInto([int]$x, [int]$y, [string]$text) {
  ClickAbs $x $y
  Set-Clipboard -Value $text
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 400
}

# 页面坐标（窗口内）：意图框 ≈ (740,290)，工作区输入 ≈ (500,375)，派活按钮 ≈ (1174,375)
PasteInto ($r.L + 740) ($r.T + 290) $Intent
PasteInto ($r.L + 500) ($r.T + 375) $Workspace
Write-Host '两个框已填，准备点「派活」'
Start-Sleep -Milliseconds 400

ClickAbs ($r.L + 1174) ($r.T + 375)
Start-Sleep -Seconds 3

# 截窗口，留证据
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
$bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[W.U]::SetWindowPos($h, [IntPtr]-2, 0,0,0,0, 0x0001 -bor 0x0002) | Out-Null
Write-Host "点完了，截图：$Shot"
