# Excel 表格

## 首选：`cli_xlsx_create` / `cli_xlsx_update` / `cli_office_read`（不需要安装 Excel）

1. 把数据写成 UTF-8 的 CSV（首行表头；含逗号的单元格用双引号包住）：

   ```csv
   产品,数量,单价,日期
   笔记本,3,5999.5,2026-09-01
   显示器,10,1299,2026-09-02
   ```

2. `cli_xlsx_create ["--input","销售.csv","--output","销售.xlsx","--formula","金额=数量*单价","--sum","数量,金额","--number-format","金额=#,##0.00"]`
3. `cli_office_read ["销售.xlsx","--format","json"]` 核对数值与公式。

- 自动类型：数字、`2026-09-20` 日期、`85%` 百分比、以 `=` 开头的公式；`007`、长数字串保持文本。
- `--sum auto` 对所有纯数字列求和；`--average "列"`；`--total-label 总计`；多个 `--input` 生成多张工作表，`--sheet 名称` 依次命名。
- `--formula "新列=表头表达式"`（`+ - * / ()`）；需要 Excel 函数时写 `"等级==IF(C{row}>=60,\"及格\",\"不及格\")"`，`{row}` 为行号。
- 复杂布局用 JSON：`{"sheets":[{"name":"汇总","header":["部门","金额"],"rows":[["研发",120],["销售",300]],"sum":["金额"],"cells":{"A6":"制表人：张三"},"merge":["A6:B6"],"widths":{"部门":20}}]}`。
- 修改已有文件：`cli_xlsx_update ["--file","销售.xlsx","--set","B2=5","--set","汇总!C1=备注","--append-row","[\"鼠标\",7,99]","--add-sheet","说明"]`。
  它会丢失原文件里的图表/透视表/宏；这类文件用下面的 COM。
- 数据处理（筛选、分组、排序、去重）可以直接在脚本里对 CSV 做完，再生成 xlsx：

  ```powershell
  $rows = Import-Csv -LiteralPath .\销售.csv -Encoding UTF8
  $rows | Group-Object 产品 | ForEach-Object { [pscustomobject]@{ 产品 = $_.Name; 数量 = ($_.Group | Measure-Object 数量 -Sum).Sum } } |
    Sort-Object 数量 -Descending | Export-Csv -LiteralPath .\汇总.csv -NoTypeInformation -Encoding UTF8
  ```

## 需要 Excel 本体的功能（COM，需已安装 Excel；写入 task.ps1 运行）

```powershell
$path = Join-Path (Get-Location) "销售.xlsx"
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false; $excel.DisplayAlerts = $false
try {
  $wb = $excel.Workbooks.Open($path)                 # 新建用 $excel.Workbooks.Add()
  $ws = $wb.Worksheets.Item(1)
  $ws.Cells.Item(1, 5).Value2 = "备注"               # 行, 列
  $ws.Range("B5").Formula = "=SUM(B2:B4)"
  $ws.Range("A1:E1").Font.Bold = $true
  $ws.Range("A1:E1").Interior.Color = 0xF6EADE      # BGR
  $ws.Range("C2:C100").NumberFormat = "#,##0.00"
  [void]$ws.UsedRange.EntireColumn.AutoFit()

  # 排序：按 B 列降序，含表头
  $ws.Sort.SortFields.Clear()
  [void]$ws.Sort.SortFields.Add($ws.Range("B2:B100"), 0, 2)   # 0=按值，1 升序 / 2 降序
  $ws.Sort.SetRange($ws.UsedRange); $ws.Sort.Header = 1; $ws.Sort.Apply()

  # 柱形图（Excel 2013+）：51 簇状柱形，4 折线，5 饼图
  $chart = $ws.Shapes.AddChart2(201, 51).Chart
  $chart.SetSourceData($ws.Range("A1:B4")); $chart.HasTitle = $true; $chart.ChartTitle.Text = "销量"

  # 数据透视表：1=xlDatabase；字段方向 1 行 / 2 列 / 3 筛选 / 4 值；-4157 求和，-4112 计数
  $cache = $wb.PivotCaches().Create(1, $ws.UsedRange)
  $ps = $wb.Worksheets.Add()
  $pivot = $cache.CreatePivotTable($ps.Range("A3"), "透视表1")
  $pivot.PivotFields("产品").Orientation = 1
  $f = $pivot.PivotFields("数量"); $f.Orientation = 4; $f.Function = -4157

  $wb.SaveAs($path, 51)                              # 51=xlsx，56=xls，6=csv，57=PDF 用 ExportAsFixedFormat(0,$pdf)
  $wb.Close($false)
  "RESULT: OK $path"
} finally { $excel.Quit() }
```

- 旧 `.xls` 转换：`$wb = $excel.Workbooks.Open("C:\...\旧.xls"); $wb.SaveAs("C:\...\新.xlsx", 51)`。
- 条件格式：`$fc = $ws.Range("B2:B100").FormatConditions.Add(1, 5, "=100"); $fc.Interior.Color = 0x9C9CFF`（1=按单元格值，5=大于）。
- 冻结首行：`$excel.ActiveWindow.SplitRow = 1; $excel.ActiveWindow.FreezePanes = $true`（需 `Visible=$true` 或已激活窗口）。
- 路径用完整路径；出错也要 `Quit()`，不要留下隐藏的 EXCEL 进程。打开给用户看用 `cli_app_open ["文件.xlsx"]`。
