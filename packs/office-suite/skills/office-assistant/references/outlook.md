# Outlook：邮件、日历、联系人

顺序：先用 `cli_outlook_mail` / `cli_outlook_event` / `cli_outlook_read`（经典 Outlook 的 COM 自动化）；返回
`OUTLOOK_UNAVAILABLE` 时，用 `cli_eml_create` / `cli_ics_create` 生成文件，再 `cli_app_open` 打开。

- 只有**经典 Outlook**（`OUTLOOK.EXE`）支持 COM；新版 Outlook（`olk.exe`）和"邮件"应用不支持，只能走文件或 `mailto:`。
- Outlook 没有配置邮箱时，`Send()` 会失败或弹出配置向导：改为保存草稿/生成 .eml，并如实说明。
- COM 启动的 Outlook 由系统启动，不受任务结束影响；要让用户看到主窗口需显式显示（见下）。
- 任务只说"写/起草"邮件时不要真的发送：`--mode draft` 或 `--mode display`。

## 只是"打开 Outlook"

`cli_app_open ["outlook"]`，核实 `processes` 中有 `OUTLOOK` 或 `olk`。首次启动停在账户配置向导也算已打开，如实说明。

## COM 配方（写入 task.ps1 运行）

```powershell
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")
$ns.GetDefaultFolder(6).Display()          # 显示主窗口(收件箱)；6=收件箱 5=已发送 16=草稿 9=日历 10=联系人 13=任务

# 发邮件(0=邮件)
$m = $ol.CreateItem(0)
$m.To = "zhangsan@example.com; lisi@example.com"
$m.CC = "wangwu@example.com"
$m.Subject = "第38周周报"
$m.Body = "各位好：`r`n附件是本周周报。"       # 或 $m.HTMLBody = "<p>…</p>"
[void]$m.Attachments.Add((Join-Path (Get-Location) "周报.docx"))   # 必须是完整路径
$m.Send()                                   # 存草稿用 $m.Save()；给用户看用 $m.Display()
"RESULT: OK mail"

# 日程(1=约会)；加参会人即为会议
$a = $ol.CreateItem(1)
$a.Subject = "项目周会"; $a.Location = "3 号会议室"
$a.Start = [datetime]"2026-09-21 14:00"; $a.Duration = 60
$a.ReminderSet = $true; $a.ReminderMinutesBeforeStart = 15
$a.Body = "议程：……"
# 会议： $a.MeetingStatus = 1; [void]$a.Recipients.Add("zhangsan@example.com"); $a.Send()
$a.Save()
"RESULT: OK appointment"

# 联系人(2) 与任务(3)
$c = $ol.CreateItem(2); $c.FullName = "张三"; $c.Email1Address = "zhangsan@example.com"; $c.MobileTelephoneNumber = "13800000000"; $c.Save()
$t = $ol.CreateItem(3); $t.Subject = "提交报销"; $t.DueDate = [datetime]"2026-09-25"; $t.Save()

# 读取最近 5 封邮件
$items = $ns.GetDefaultFolder(6).Items; $items.Sort("[ReceivedTime]", $true)
$n = 0; foreach ($i in $items) { if ($i.Class -eq 43) { "{0} | {1} | {2}" -f $i.ReceivedTime, $i.SenderName, $i.Subject; $n++; if ($n -ge 5) { break } } }

# 回复/转发/保存附件
# $r = $i.Reply(); $r.Body = "收到。" + $r.Body; $r.Send()
# $f = $i.Forward(); [void]$f.Recipients.Add("a@b.com"); $f.Send()
# foreach ($att in $i.Attachments) { $att.SaveAsFile((Join-Path (Get-Location) $att.FileName)) }
```

## 没有可自动化的 Outlook 时

```text
cli_eml_create ["--output","周报邮件.eml","--to","张三 <zhangsan@example.com>","--subject","第38周周报","--body-file","正文.md","--attach","周报.docx"]
cli_app_open   ["周报邮件.eml"]        → 在默认邮件程序中打开为可编辑、可发送的草稿
cli_ics_create ["--output","周会.ics","--title","项目周会","--start","2026-09-21 14:00","--duration","60","--location","3 号会议室","--attendee","张三 <zhangsan@example.com>","--reminder","15"]
cli_app_open   ["周会.ics"]            → 日历程序弹出该日程，用户点保存即可
cli_app_open   ["mailto:zhangsan@example.com?subject=周报&body=请查收"]   → 只需打开写信窗口时
```

回复里说明：邮件/日程已生成为文件并已打开，是否已真正发送取决于本机邮件程序。
