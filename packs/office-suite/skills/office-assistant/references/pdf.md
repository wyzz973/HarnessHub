# PDF 与浏览器

## 生成 PDF：`cli_pdf_create`

- 文本类：`cli_pdf_create ["--input","报告.md","--output","报告.pdf"]`（.md/.txt/.html，由系统自带 Edge/Chrome 无界面打印；支持中文、表格、本地图片，
  单独一行 `\pagebreak` 分页，`--landscape` 横向）。
- Office 文档：`cli_pdf_create ["--input","周报.docx","--output","周报.pdf"]`（.docx/.xlsx/.pptx）。装有 Office 时由 Word/Excel/PowerPoint 原样导出
  （结果 `fidelity:"exact"`）；没装时只输出文字版（`fidelity:"text-only"`，要在回复里说明）。
- 先生成 Word 再转 PDF 的常见流程：`cli_docx_create` → `cli_pdf_create`。
- 返回 `NO_BROWSER`（没有 Edge/Chrome）且没有 Office：无法离线生成 PDF，交付 .docx 或 .html 并说明原因。

## 读取 PDF

`cli_office_read ["合同.pdf"]` 返回逐页文字；扫描件没有文字层时会注明，离线环境没有 OCR，如实说明。

## 手工等价命令（没有工具时）

```powershell
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$in = Join-Path (Get-Location) "报告.html"; $out = Join-Path (Get-Location) "报告.pdf"
& $edge --headless --disable-gpu --no-pdf-header-footer "--print-to-pdf=$out" ("file:///" + $in.Replace('\','/'))
Start-Sleep -Seconds 3
if ((Test-Path -LiteralPath $out) -and (Get-Item -LiteralPath $out).Length -gt 0) { "RESULT: OK $out" } else { "RESULT: FAIL" }
```

Word 导出：`$doc.SaveAs2($pdf, 17)`；Excel：`$wb.ExportAsFixedFormat(0, $pdf)`；PowerPoint：`$pres.SaveAs($pdf, 32)`（见各自的参考文件）。
合并、拆分、加密 PDF 在离线且无专用软件的机器上做不到；装有 Word 2013+ 时可以用 Word 打开 PDF 转成 .docx 再编辑。

## 浏览器

- 打开网址或本地网页：`cli_app_open ["https://example.com"]`、`cli_app_open ["说明.html"]`（默认浏览器）；指定浏览器：
  `cli_app_open ["edge","--args","https://example.com"]`。机器离线时外网页面打不开，浏览器窗口已打开即可如实说明。
- 网页截图：`& $edge --headless --disable-gpu "--screenshot=$png" --window-size=1280,800 $url`。
- 不要试图下载安装任何东西。
