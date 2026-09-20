# 比赛任务测试

`scripts/competition-tasks.mjs` 扮演评委：对每道题创建一个空目录、写入题目给定的输入文件、为该目录建一个 Session、把题目的 `query` **原样**通过 [比赛接口](competition-api.md)发出，然后按**最终的文件与机器状态**判分，而不是看模型说了什么。它只依赖 Node 与 `scripts/` 目录，可以直接用发行包内的 `runtime\node.exe` 在离线机器上运行。

## 运行

```powershell
.\competition\runtime\node.exe scripts\competition-tasks.mjs ^
  --base http://127.0.0.1:6217 --out results --engine opencode
```

前提是已按 [INSTRUCTION.md](../distribution/INSTRUCTION.md) 启动比赛服务（`AGENT_ENGINE` 固定引擎、统一模型已配置）。可选参数：`--tasks FILE`（默认 `examples/competition-tasks/office-tasks.json`）、`--work-root DIR`、`--only id,id`、`--task-timeout-ms`（默认 900000）、`--summary FILE`（追加 Markdown 表格，可指向 CI 的 job summary）、`--require-survival`。

输出 `<out>/tasks-<label>.json` 与同名 `.md`。退出码：0 没有题目失败，1 至少一道失败，2 用法或环境错误。

## 题目格式

沿用评委数据的字段（`task_id`、`title`、`description`、`query`、`category`、`secondary_category`、`difficulty`、`difficulty_label`），另加本工具使用的字段：

| 字段 | 含义 |
|---|---|
| `platform` | 适用平台数组，例如 `["win32"]`；不匹配当前机器则 SKIP |
| `setup` | 判题前写入工作目录的输入文件（文本、CSV、JSON 等） |
| `requires` | 本题需要机器具备的条件，例如某个应用已安装 |
| `env_reply` | 机器不具备条件时，认可的“如实说明”措辞 |
| `verify` | 判分检查，可嵌套 `any_of` / `all_of` / `not` |
| `cleanup` | 判完后的清理动作，例如关闭被打开的应用 |
| `verify_wait_ms` | 判分前的等待时间（应用启动需要时间） |

随包的 `examples/competition-tasks/office-tasks.json` 有 20 道中文办公题，覆盖软件交互、文档处理、表格与数据、演示文稿、沟通与日程、文件管理、系统信息，其中 `office_002`“请自动打开 Outlook 邮件客户端”与评委给出的样例完全一致。

## 判分结果

| 结果 | 含义 |
|---|---|
| PASS | `prompt_async` 返回 204 且 `verify` 全部通过 |
| FAIL | 其他属于引擎或网关责任的情况 |
| ENV | 机器确实不具备 `requires` 的条件，**且**模型如实说明了（`env_reply`）。在这种机器上谎称完成算 FAIL |
| SKIP | 平台不匹配 |

## 检查种类

`file_exists`、`file_absent`、`file_text_contains`、`file_text_equals`、`file_text_matches`、`office_text_contains`（读 docx/xlsx/pptx 内部文本并校验压缩包结构）、`xlsx_cell`、`xlsx_find`、`csv_rows`、`json_valid`、`ics_valid`、`eml_headers`、`zip_contains`、`not_modified`、`process_running`、`window_title`、`shell_window`、`reply_contains`、`reply_matches`，以及组合用的 `any_of`、`all_of`、`not`。全部不依赖第三方库。

## 应用是否活过会话删除

用到 `process_running`、`window_title`、`shell_window` 的题目会判两次：`prompt_async` 返回后立刻判一次（决定 PASS/FAIL），`DELETE /session` 之后约 3 秒再判一次，记为 `survivesSessionClose`。

原因是 Windows 上一个会话的引擎与其全部子进程处在同一个 kill-on-close Job 中，引擎自己直接启动的应用会随会话一起被关掉，而评委可能在删除会话之后才检查桌面。`--require-survival` 会把第二次判定为假的题目算作失败；默认不开，因为 CI 的服务会话没有桌面外壳，[办公工具包](office-suite.md)所用的"经资源管理器代启动"在那种环境下无法脱离该 Job。
