# Windows 应用：启动、核实、关闭、简单操作

所有脚本按 Windows PowerShell 5.1 编写。保存为带 BOM 的 UTF-8 `task.ps1`，用
`powershell -NoProfile -ExecutionPolicy Bypass -File .\task.ps1` 运行。

## 1. 为什么必须经"桌面外壳"启动

当前任务的所有进程在一个"随任务结束而整体关闭"的作业对象里。直接 `Start-Process outlook`、`start winword`、
`notepad.exe` 启动的程序，任务结束时会被一起杀掉。交给桌面外壳（资源管理器）启动的程序不在这个作业里，会一直开着。

首选工具 `cli_app_open`（自动解析安装位置、经外壳启动、等待进程和窗口、返回 JSON）。没有该工具时的等价做法：

```powershell
# 应用（完整路径）、文档（默认程序）、文件夹、.lnk、网址、协议，都可以这样交给外壳
& "$env:SystemRoot\explorer.exe" "C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE"
# explorer.exe 的退出码恒为 1，不是失败。随后轮询进程核实：
$deadline = (Get-Date).AddSeconds(20)
do { Start-Sleep -Milliseconds 500; $p = Get-Process -Name OUTLOOK, olk -ErrorAction SilentlyContinue } while (-not $p -and (Get-Date) -lt $deadline)
if ($p) { "RESULT: OK " + ($p | Select-Object -First 1).ProcessName } else { "RESULT: FAIL 未发现进程" }
```

带参数启动（例如用记事本打开指定文件）：先建临时快捷方式，再让外壳打开它。

```powershell
$lnk = Join-Path $env:TEMP "hh-open.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = "$env:SystemRoot\System32\notepad.exe"
$s.Arguments = '"' + (Join-Path (Get-Location) "notes.txt") + '"'
$s.Save()
& "$env:SystemRoot\explorer.exe" $lnk
```

## 2. 找到应用在哪

```powershell
# a) App Paths 注册表（Office、浏览器等）
$keys = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE'
foreach ($k in $keys) { if (Test-Path $k) { (Get-Item $k).GetValue('') } }
# b) 开始菜单快捷方式
Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter *.lnk | Where-Object { $_.BaseName -like '*Outlook*' }
# c) 所有开始菜单应用（含商店应用），AppID 可用于 shell:AppsFolder
Get-StartApps | Where-Object { $_.Name -like '*Outlook*' }
& "$env:SystemRoot\explorer.exe" ("shell:AppsFolder\" + (Get-StartApps | Where-Object { $_.Name -like 'Outlook*' } | Select-Object -First 1).AppID)
```

常见进程名：经典 Outlook `OUTLOOK`，新版 Outlook `olk`，Word `WINWORD`，Excel `EXCEL`，PowerPoint `POWERPNT`，
记事本 `notepad`，计算器 `CalculatorApp`，画图 `mspaint`，Edge `msedge`，Chrome `chrome`，资源管理器 `explorer`，
设置 `SystemSettings`，WPS `wps`/`et`/`wpp`，微信 `WeChat`/`Weixin`，企业微信 `WXWork`，钉钉 `DingTalk`，飞书 `Feishu`。

常用协议（可直接交给 `cli_app_open` 或 explorer）：`ms-settings:`（设置，如 `ms-settings:display`）、`mailto:a@b.com?subject=主题`、
`calculator:`、`ms-clock:`、`ms-photos:`、`ms-screenclip:`（截图）、`outlookcal:`（日历）、`shell:Downloads`、`shell:Desktop`。

## 3. 核实

```powershell
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object ProcessName, Id, MainWindowTitle
```

文件是否在某应用中打开：看窗口标题是否包含文件名（不含扩展名更稳）。商店应用的窗口可能挂在 `ApplicationFrameHost` 下，
进程存在即可认定已启动。

## 4. 关闭

`cli_app_close ["应用名"]`，或：

```powershell
Get-Process -Name notepad -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
Start-Sleep -Seconds 2
Get-Process -Name notepad -ErrorAction SilentlyContinue | Stop-Process -Force   # 仅在确认可丢弃未保存内容时
```

不要关闭 `explorer`（桌面本身）。

## 5. 简单界面操作（键盘、剪贴板、截图）

```powershell
Add-Type -AssemblyName System.Windows.Forms
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate("记事本")            # 窗口标题片段或进程号
Start-Sleep -Milliseconds 600
Set-Clipboard -Value "要输入的中文内容"        # 中文用剪贴板粘贴，避免输入法干扰
[System.Windows.Forms.SendKeys]::SendWait("^v")
[System.Windows.Forms.SendKeys]::SendWait("^s")   # Ctrl+S；{ENTER} {TAB} {ESC} %{F4}=Alt+F4
```

能用文件或 COM 完成的事不要用键盘模拟：它依赖焦点，容易失败。

```powershell
# 全屏截图
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$out = Join-Path (Get-Location) "screen.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
"RESULT: OK $out"
```
