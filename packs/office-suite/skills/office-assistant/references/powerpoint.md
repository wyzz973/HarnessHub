# PowerPoint 演示文稿

## 首选：`cli_pptx_create`（不需要安装 PowerPoint）

1. 写 UTF-8 的大纲 Markdown，例如 `汇报.md`：

   ````markdown
   # 季度经营汇报
   平台研发部 · 2026 年第三季度

   ## 业务概览
   - 收入同比增长 **18%**
   - 新增客户 42 家
     - 华东 20 家
   > 这里是演讲者备注

   ## 销售数据
   | 区域 | Q2 | Q3 |
   |---|---:|---:|
   | 华东 | 120 | 150 |

   ## 趋势
   ```chart
   type: column
   title: 季度销售额
   labels: Q1,Q2,Q3
   series 华东: 100,120,150
   series 华南: 80,90,130
   ```

   # 下一步
   ## 计划
   1. 扩大试点
   ````

2. `cli_pptx_create ["--input","汇报.md","--output","汇报.pptx","--theme","blue","--footer","平台研发部"]`
3. `cli_office_read ["汇报.pptx"]` 核对每页标题和要点。

规则：第一个 `#` 是封面（其后的段落为副标题），之后的 `#` 是章节页；每个 `##` 一页；要点过多会自动续页；一页只放一张图/表/图表时与文字左右排布；
`![说明](本地图片.png)` 插图；图表类型 `column|bar|line|pie|doughnut|area`。主题 `blue|light|dark|green`，比例 `--ratio 16:9|4:3`。
"做 N 页 PPT"时就写 N 个页面（封面算 1 页）。

## 需要 PowerPoint 本体的功能（COM，需已安装；写入 task.ps1 运行）

```powershell
$path = Join-Path (Get-Location) "汇报.pptx"
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Add(0)                  # 0=不显示窗口；打开已有：$ppt.Presentations.Open($path, 0, 0, 0)
  $s1 = $pres.Slides.Add(1, 1)                       # 版式：1 标题页，2 标题+正文，11 仅标题，12 空白
  $s1.Shapes.Item(1).TextFrame.TextRange.Text = "季度经营汇报"
  $s1.Shapes.Item(2).TextFrame.TextRange.Text = "平台研发部"
  $s2 = $pres.Slides.Add(2, 2)
  $s2.Shapes.Item(1).TextFrame.TextRange.Text = "业务概览"
  $s2.Shapes.Item(2).TextFrame.TextRange.Text = "收入同比增长 18%`r新增客户 42 家"     # `r 分隔要点
  [void]$s2.Shapes.AddPicture((Join-Path (Get-Location) "图.png"), 0, -1, 400, 150)   # 链接否, 随文档保存, 左, 上
  $s2.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = "备注"
  $pres.SaveAs($path, 24)                            # 24=pptx，32=PDF，1=ppt
  $pres.Close()
  "RESULT: OK $path"
} finally { if ($ppt.Presentations.Count -eq 0) { $ppt.Quit() } }
```

- 改已有文稿的文字：遍历 `$pres.Slides` → `$slide.Shapes` → `if ($shape.HasTextFrame) { $shape.TextFrame.TextRange.Replace("旧","新") }`。
- 删除/移动/复制页：`$pres.Slides.Item(3).Delete()`、`.MoveTo(1)`、`.Duplicate()`。
- 导出图片：`$pres.Slides.Item(1).Export((Join-Path (Get-Location) "p1.png"), "PNG")`。
- PowerPoint 是单实例程序：用户已开着别的文稿时不要 `Quit()`（上面的写法已处理）。
- 打开给用户看：保存后 `cli_app_open ["汇报.pptx"]`，并用返回的窗口标题核实。
