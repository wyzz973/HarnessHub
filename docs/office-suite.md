# 办公工具包（预装）

发行包内置一个名为 `office-suite` 的 [Capability Pack](capability-packs.md)，首次启动按内容摘要自动应用到全部引擎，因此**下载解压后不需要任何安装步骤**就能让引擎生成办公文档、操作 Windows 应用。源码在仓库的 `packs/office-suite/`，发行包内在 `tool-packs/office-suite/`。

关闭预装：启动前设置 `HARNESSHUB_PREINSTALL_TOOL_PACKS=0`。手动解除某个引擎的绑定后不会被自动装回，机制见 [ADR 0015](decisions/0015-preinstalled-tool-packs.md)。

## 包含什么

- **1 个常驻 Skill** `office-assistant`：Windows 办公任务的执行规则。它被完整拼进每一轮提示词，因此只写决策规则与最常用的调用方式；细节放在同目录 `references/` 的 7 篇参考（`windows-apps.md`、`outlook.md`、`word.md`、`excel.md`、`powerpoint.md`、`pdf.md`、`files.md`），由模型按需读取。
- **14 个离线 CLI 工具**：经受控 Command MCP 暴露给引擎，工具名为 `cli_<name>`，在每个 Session 自己的工作目录中运行，参数是有界的字符串数组，返回一行 JSON（`ok:true` 为成功）。

| 工具 | 用途 |
|---|---|
| `cli_docx_create` | Markdown → Word 文档，支持标题、列表、表格、引用、代码块、图片、分页、页眉与目录 |
| `cli_xlsx_create` | CSV/TSV/JSON/Markdown 表格 → Excel 工作簿，支持合计行、公式列、数字格式、多工作表 |
| `cli_xlsx_update` | 修改已有 Excel：设置单元格与公式、追加行、增删改工作表 |
| `cli_pptx_create` | Markdown 大纲 → PowerPoint，支持封面、要点、表格、图表与演讲者备注 |
| `cli_office_read` | 读取 docx / xlsx / pptx / pdf 与文本文件为文本或 CSV（自动识别 UTF-8/UTF-16/GBK） |
| `cli_pdf_create` | Markdown/HTML 经系统自带 Edge 无界面打印为 PDF；Office 文件在装有 Office 时由其导出 |
| `cli_ics_create` | 生成可被 Outlook 与手机日历导入的 `.ics` 日程，支持参会人、提醒与重复规则 |
| `cli_eml_create` | 生成 `.eml` 邮件草稿，支持抄送、附件与 Markdown 正文 |
| `cli_app_open` | **打开应用/文件/网址的唯一正确方式**：经桌面外壳代启动并核实进程与窗口 |
| `cli_app_close` | 关闭应用（可强制） |
| `cli_app_list` | 列出已安装的办公应用、按关键字搜索开始菜单、列出当前所有窗口 |
| `cli_outlook_mail` | 经典 Outlook COM：发送、存草稿或打开撰写窗口 |
| `cli_outlook_event` | 经典 Outlook COM：创建日程或会议邀请 |
| `cli_outlook_read` | 经典 Outlook COM：读取收件箱、日历、联系人等 |

任一工具加 `--help` 输出完整选项。

## Skill 写进去的三条硬规则

这三条来自 Windows x64 上的实测，见 [验收记录](verification/2026-09-20-windows-x64.md)：

1. **打开应用只用 `cli_app_open`**。Windows 上每个会话的引擎与其全部子进程在同一个 kill-on-close Job 中，用 `Start-Process` 直接启动的程序会在会话清理时被一起关掉，而评委可能在删除会话之后才检查桌面状态。`cli_app_open` 经资源管理器代启动，进程不属于该 Job。
2. **稍复杂的命令先写成 `.ps1` 再执行**。各引擎的默认 shell 不同（PowerShell、cmd、Git Bash），含 `$()`、反引号或括号表达式的单行命令会被改坏；Gemini CLI 即使在完全访问模式也会把这类命令判为命令注入并拦截。脚本文件不受影响。
3. **做完必须核实**：应用看返回的进程与窗口标题，文件用 `cli_office_read` 读回。没核实不报告完成。

## 验证（2026-09-20，macOS 真实引擎 + 真实模型）

模型为 DeepSeek `deepseek-flash`，经只接受流式请求的严格代理对外呈现为 `GLM-V5_1-DX`（公司真实模型未验证）。每个引擎在全新数据目录启动源码比赛 Gateway，导入本工具包后用 [比赛任务测试](competition-tasks.md)跑评委格式的办公题，按最终文件状态判定：

| 引擎 | 题目 | 结果 | 引擎实际调用的本包工具 |
|---|---|---|---|
| OpenCode 1.1.21 | 13 道跨平台题（文档、表格、演示、日程、邮件、文件整理） | 13 通过 | `cli_docx_create`、`cli_xlsx_create`、`cli_pptx_create`、`cli_ics_create`、`cli_eml_create`、`cli_office_read` |
| Codex 0.144.5 | 6 道 Office 格式题 | 6 通过 | 同上（含 `cli_xlsx_update`） |

**工具包解决的是离线可用性，不是通过率。** 同一台机器、同样 13 道题，不装本工具包时 OpenCode 也全部通过，但它是靠 Python 生态完成的：引擎日志中出现 10 次 `python-docx`/`python-pptx`/`openpyxl`，其中 `office_d03` 的回复明确写着"环境无 pandoc 与 python-docx，故在本地建了 `.venv` 并安装 python-docx 完成转换"——这条路在**离线的比赛机上走不通**。装上本工具包后，两个引擎的日志中这些库名出现 **0 次**，全部改用包内工具。

生成物用独立方式复核：ZIP 完整性与必需部件（`[Content_Types].xml`、`word/document.xml` 等）全部通过；`weekly-report.docx` 用 macOS `textutil` 打开可读出标题与表格；`sales.xlsx` 的单元格中是真实公式 `SUM(C2:C6)` 而非固化数值。

**未验证**：Windows 上的真实 Office/Outlook COM 配方（需要装有 Office 的机器）、`cli_app_open` 经资源管理器代启动后应用在会话结束后仍保持打开（CI 无桌面会话）、本工具包在 Windows x64 上的办公题通过率。

## 扩展或重新生成

工具的源码在 `scripts/office-suite/src/`，由 `scripts/build-office-suite.mjs` 用 esbuild 打成单文件 `packs/office-suite/bin/office.cjs`（含 104 个固定版本的 MIT 类库，许可证原文在 `packs/office-suite/THIRD_PARTY_LICENSES.txt`）。生成产物**已提交**，所以源码下载、离线开发包与发行包都不需要 npm 访问。

在有 npm 的开发机上重新生成：

```sh
npm ci --prefix scripts/office-suite
node scripts/build-office-suite.mjs
```

`bin/BUILD.json` 记录了产物的 SHA-256 与全部被打包的库版本，重新生成后应核对该文件的变化。改 Skill 文字只需编辑 `packs/office-suite/skills/office-assistant/`，内容摘要变化后下次启动会自动重新应用到各引擎。

要装自己的工具包（而不是改这个），见 [Capability Pack](capability-packs.md)。
