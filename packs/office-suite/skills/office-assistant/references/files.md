# 文件整理与文本编码

脚本保存为带 BOM 的 UTF-8 `task.ps1`，用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\task.ps1` 运行。
路径一律加引号并用 `-LiteralPath`（文件名里的 `[ ]` 会被 `-Path` 当成通配符）。

## 常用位置

```powershell
$desktop   = [Environment]::GetFolderPath('Desktop')
$documents = [Environment]::GetFolderPath('MyDocuments')
$downloads = Join-Path $env:USERPROFILE 'Downloads'
```

## 查找、统计

```powershell
Get-ChildItem -LiteralPath . -Recurse -File -Filter *.docx | Select-Object FullName, Length, LastWriteTime
Get-ChildItem -LiteralPath . -Recurse -File | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) }     # 最近 7 天
Get-ChildItem -LiteralPath . -Recurse -File | Select-String -Pattern '合同编号' -List | Select-Object Path        # 按内容找(文本文件)
Get-ChildItem -LiteralPath . -Recurse -File | Group-Object Extension | Sort-Object Count -Descending | Select-Object Name, Count
(Get-ChildItem -LiteralPath . -Recurse -File | Measure-Object Length -Sum).Sum / 1MB                              # 总大小 MB
Get-FileHash -LiteralPath .\a.zip -Algorithm SHA256
```

Office/PDF 文件的内容用 `cli_office_read` 读取后再判断。

## 新建、复制、移动、重命名、删除

```powershell
New-Item -ItemType Directory -Force -Path .\归档\2026 | Out-Null
Copy-Item -LiteralPath .\a.docx -Destination .\归档\2026\ -Force
Move-Item -LiteralPath .\b.xlsx -Destination .\归档\2026\
Rename-Item -LiteralPath .\c.txt -NewName '会议纪要.txt'
Remove-Item -LiteralPath .\tmp -Recurse -Force          # 只删任务明确要求删除的东西

# 批量重命名：加日期前缀 / 顺序编号
$i = 1
Get-ChildItem -LiteralPath .\照片 -File | Sort-Object Name | ForEach-Object {
  $new = '{0:D3}_{1}' -f $i, $_.Name; Rename-Item -LiteralPath $_.FullName -NewName $new; $i++
}

# 按扩展名归类到子文件夹
Get-ChildItem -LiteralPath . -File | ForEach-Object {
  $dir = Join-Path $_.DirectoryName ($_.Extension.TrimStart('.').ToUpper() + '文件')
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -LiteralPath $_.FullName -Destination $dir
}
Get-ChildItem -LiteralPath . -Recurse | Select-Object FullName          # 最后列出结果核实
```

## 压缩与解压

```powershell
Compress-Archive -Path .\报告\* -DestinationPath .\报告.zip -Force
Expand-Archive -LiteralPath .\报告.zip -DestinationPath .\解压 -Force
# 中文文件名要在其他系统上也正常显示时：
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory((Resolve-Path .\报告), (Join-Path (Get-Location) '报告.zip'), 'Optimal', $false, [Text.Encoding]::UTF8)
```

## 文本编码（Windows PowerShell 5.1 的坑）

- `>`、`Out-File` 默认写 UTF-16；`Set-Content` 默认写系统 ANSI（中文系统是 GBK）。**总是显式写 `-Encoding UTF8`**（5.1 会带 BOM）。
- 需要无 BOM 的 UTF-8：`[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`。
- 读取：`Get-Content -LiteralPath $p -Encoding UTF8`；GBK 文件用 `-Encoding Default`。乱码时换一种再读。
- `.ps1` 脚本含中文必须是带 BOM 的 UTF-8，否则 5.1 按 ANSI 解析，中文变乱码甚至语法错误。
- CSV：`Import-Csv/Export-Csv` 都加 `-Encoding UTF8`；给 Excel 直接双击打开的 CSV 需要 BOM（`Export-Csv -Encoding UTF8` 已带）。
- 本技能的 `cli_*` 工具读取文本时自动识别 UTF-8/UTF-16/GBK，写出一律 UTF-8。

## 其他

```powershell
Get-Content -LiteralPath .\a.txt, .\b.txt -Encoding UTF8 | Set-Content -LiteralPath .\合并.txt -Encoding UTF8   # 合并文本
(Get-Content -LiteralPath .\a.txt -Raw -Encoding UTF8).Replace('旧', '新') | Set-Content -LiteralPath .\a.txt -Encoding UTF8
Get-Date -Format 'yyyy-MM-dd HH:mm'
```
