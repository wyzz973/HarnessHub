# Word 文档

## 首选：`cli_docx_create`（不需要安装 Word）

1. 用写文件工具把正文写成 UTF-8 的 Markdown，例如 `周报.md`。
2. `cli_docx_create ["--input","周报.md","--output","周报.docx","--title","工作周报","--page-numbers"]`
3. `cli_office_read ["周报.docx"]` 核对内容。

Markdown 写法：`# 一级标题` `## 二级标题`；空行分段；`**粗体**` `*斜体*`；`- 项目` / `1. 步骤`（缩进两格为子项，`- [ ]`/`- [x]` 为任务）；
`| 列1 | 列2 |` 表格（第二行 `|---|---:|`，冒号控制对齐）；`> 引用`；三个反引号包住的代码块；`![说明](本地图片.png)`；
单独一行 `\pagebreak` 分页。选项：`--title` 大标题、`--author`、`--header 页眉`、`--page-numbers` 页码、`--toc` 目录（Word 打开时更新域）、
`--landscape` 横向、`--font 宋体`、`--font-size 12`、`--plain`（纯文本原样成段）。

读取已有文档：`cli_office_read ["合同.docx"]`（标题、列表、表格转为 Markdown）。旧 `.doc` 需先用 Word 另存为 `.docx`（见下）。

## 需要 Word 本体的功能（COM，需已安装 Word；写入 task.ps1 运行）

```powershell
$path = Join-Path (Get-Location) "通知.docx"
$word = New-Object -ComObject Word.Application
$word.Visible = $false; $word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection
  $sel.Style = $doc.Styles.Item(-2)            # 内置样式：-2 标题1，-3 标题2，-63 标题，-1 正文（与界面语言无关）
  $sel.TypeText("关于国庆放假的通知"); $sel.TypeParagraph()
  $sel.Style = $doc.Styles.Item(-1)
  $sel.TypeText("各部门：根据安排，10 月 1 日至 7 日放假。"); $sel.TypeParagraph()
  $table = $doc.Tables.Add($sel.Range, 3, 2)   # 3 行 2 列
  $table.Borders.Enable = $true
  $table.Cell(1,1).Range.Text = "日期"; $table.Cell(1,2).Range.Text = "安排"
  $table.Rows.Item(1).Range.Font.Bold = $true
  $doc.SaveAs2($path, 16)                      # 16=docx，17=PDF，0=doc
  $doc.Close($false)
  "RESULT: OK $path"
} finally { $word.Quit() }
```

常用操作（在已打开的 `$doc` 上）：

```powershell
$doc = $word.Documents.Open((Join-Path (Get-Location) "合同.docx"))
# 全文替换：FindText,MatchCase,WholeWord,Wildcards,SoundsLike,AllWordForms,Forward,Wrap(1),Format,ReplaceWith,Replace(2=全部)
[void]$doc.Content.Find.Execute("甲方", $false, $false, $false, $false, $false, $true, 1, $false, "某某公司", 2)
$doc.Content.InsertAfter("`r追加的一段文字")              # 追加文字
$doc.Paragraphs.Item(1).Range.Font.Size = 18               # 改第 1 段字号
$doc.Paragraphs.Item(1).Alignment = 1                      # 0 左 1 居中 2 右 3 两端
$doc.PageSetup.Orientation = 1                             # 1 横向 0 纵向
[void]$doc.Comments.Add($doc.Paragraphs.Item(2).Range, "请核对金额")   # 批注
$doc.TrackRevisions = $true                                # 开启修订
$words = $doc.ComputeStatistics(0); $pages = $doc.ComputeStatistics(2)  # 字数、页数
$doc.SaveAs2((Join-Path (Get-Location) "合同.pdf"), 17)    # 导出 PDF
$doc.Save(); $doc.Close($false)
```

- 旧格式转换：`$d = $word.Documents.Open("C:\...\旧.doc"); $d.SaveAs2("C:\...\新.docx", 16); $d.Close($false)`。
- 路径一律用完整路径（COM 的当前目录不是脚本目录）。
- 要"打开给用户看"：保存并 `Quit()` 后用 `cli_app_open ["文件.docx"]`；不要留下 `Visible=$false` 的隐藏 Word 进程。
- 没装 Word 时 `New-Object -ComObject Word.Application` 会报错：改用 `cli_docx_create`，高级功能无法实现时如实说明。
