# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，最新的在最前面。每条只写已合入的行为变化；证据与未验证项见各条链接的验收记录。

## 2026-09-20 比赛决赛版

自 2026-09-08 进入决赛的版本（`bf96ef9`）起共 122 个提交。核心变化：所有引擎被强制收敛到同一个模型，比赛接口按规范 v1.1 实现，工具包可一键装到全部引擎，引擎与网关之间的交互全程留痕，并逐个修掉了 Windows x64 上导致引擎不可用的真实缺陷。

### 新增

- **统一模型网关**：Worker 内实现，把 Codex 的 Responses、Claude Code 的 Anthropic Messages、Gemini 的 Google 协议与其余引擎的 Chat Completions 统一转换为上游**只接受流式**的 OpenAI Chat Completions。强制使用统一模型（引擎只看到别名 `harnesshub-model`，上游收到真实模型名），回填推理模型的 `reasoning_content`，按严格企业网关清理参数，上游错误原样透出。引擎自带的 API Key、登录与订阅不再被使用。见 [统一模型网关](docs/model-gateway.md)、[ADR 0013](docs/decisions/0013-unified-model-gateway.md)。
- **统一模型配置**：环境变量 `HARNESSHUB_MODEL*` > `state/harness-model.json` > 配置文件顶层 `model`；`GET/PUT /v1/harness/model`、`POST /v1/harness/model/test` 与控制台“模型”页使用同一套来源。无法经统一模型驱动的适配器明确停用。
- **比赛接口（规范 v1.1）**：`POST /session`（必填 `directory`，不存在时创建）、阻塞到本轮结束的 `POST /session/{id}/prompt_async`（204 / 502 `{code,message}`）、`GET /session/{id}/message`、`GET /event` SSE、`abort`/`stop`、`/question`、`/permission`，引擎由 `AGENT_ENGINE` 或 `--engine` 固定。见 [比赛接口](docs/competition-api.md)。
- **一键工具包（Capability Pack）**：导入 Skill 目录、`mcp.json`、`cli.json` 或完整包目录，一次应用到全部引擎并为每个引擎发布新 revision；CLI 工具经受控 Command MCP 暴露为 `cli_<name>`，在每个 Session 自己的目录中运行。新增直接粘贴 `{"mcpServers":{…}}` 文档导入（请求体 `mcp` 与 `source` 二选一）。见 [Capability Pack](docs/capability-packs.md)。
- **预装办公工具包**：发行包内 `tool-packs/office-suite`，含 1 个常驻 Skill（Windows 办公执行规则）与 14 个离线 CLI 工具：`docx_create`、`xlsx_create`、`xlsx_update`、`pptx_create`、`office_read`、`pdf_create`、`ics_create`、`eml_create`、`app_open`、`app_close`、`app_list`、`outlook_mail`、`outlook_event`、`outlook_read`。首次启动按内容摘要自动应用到全部引擎，用户之后解除的绑定不会被装回；`HARNESSHUB_PREINSTALL_TOOL_PACKS=0` 关闭。见 [办公工具包](docs/office-suite.md)、[ADR 0015](docs/decisions/0015-preinstalled-tool-packs.md)。
- **诊断日志**：`<dataDir>/logs/gateway.log` 记录接口访问、Session/Run/Worker/权限生命周期与每次模型调用摘要；每个会话的 `backends/<sessionId>/diagnostics/engine.log` 记录引擎进程与 stderr、逐条 ACP 请求/响应与耗时、工具调用状态、模型调用明细（首字节时间、结束原因、用量、被去除的参数）。`HARNESSHUB_LOG_LEVEL=debug` 增加 2 KiB 内容摘录；密钥脱敏、16 MiB 轮转；`Collect-Logs.cmd` 打包全部日志。见 [观测](docs/observability.md)、[ADR 0014](docs/decisions/0014-diagnostic-logs.md)。
- **诊断日志接口与控制台面板**：`GET /v1/sessions/{id}/logs?source=engine|gateway`，按游标增量读取、跨轮转有效、再次脱敏；控制台“执行详情 → 诊断日志”可切换来源、按级别与关键字筛选、复制或下载当前记录。
- **比赛任务测试**：`scripts/competition-tasks.mjs` 扮演评委，按评委数据格式把 `query` 原样发给比赛接口，并按**最终文件与机器状态**判分（22 种检查，PASS/FAIL/ENV/SKIP）。随包 20 道中文办公任务，含原样保留的 `office_002`“请自动打开 Outlook 邮件客户端”。见 [比赛任务测试](docs/competition-tasks.md)。
- **离线交付管线**：x64 完整运行包与离线开发包由 CI 构建、自检后发布；离线开发包在断网条件下完成依赖恢复、编译与比赛布局生成（`Setup-Competition-Offline.cmd`），并附 `INSTRUCTION.md`。
- **控制台**：统一模型页、工具与插件页、引擎配置、执行详情（含每次模型调用证据）与观测页；比赛入口启动时一并打开，`http://localhost:6217/` 跳转到控制台。
- **兼容性逃生开关**：`HARNESSHUB_MODEL_DROP_PARAMETERS`、`HARNESSHUB_MODEL_REASONING`、`HARNESSHUB_MODEL_IMAGES`、`HARNESSHUB_RUN_TIMEOUT_MS`、`HARNESSHUB_LOG_LEVEL`，用于在内网现场适配未知的网关行为，不需要改代码重打包。

### 修复

按出现顺序列出在 Windows x64 真实模型验收中定位的根因，每条都改在产品侧：

- **每轮任务 60 秒就被判超时**：比赛模式沿用了通用网关的 60 秒 Run 期限，任何超过一分钟的真实任务都以 `RUN_TIMED_OUT` 结束并关闭会话。比赛模式默认改为 1 小时，可用 `HARNESSHUB_RUN_TIMEOUT_MS`（1～86400000）覆盖，非法值拒绝启动。
- **Kimi 遇到中文回复即崩溃**：`kimi.exe` 是 PyInstaller 冻结程序，忽略 `PYTHONUTF8`/`PYTHONIOENCODING`，stdout 管道按 Windows ANSI 代码页编码，中文（cp1252）或 emoji（cp936）触发 `'charmap' codec can't encode` 并以非零码退出——任务其实已经做完。打包时向其内嵌归档追加 PyInstaller 运行时选项 `X utf8=1`，按修改前后 SHA-256 校验且幂等。
- **Hermes 的终端工具永久挂起**：Hermes 0.19.0 在执行命令前探测 Git Bash 时没有给子进程独立 stdin，继承了 ACP 的 JSON-RPC 管道，MSYS 运行时检查该句柄会阻塞到下一条消息。打包时给两处探测加 `stdin=subprocess.DEVNULL`，实测从挂起 90 秒以上变为 4 秒完成。
- **所有引擎在 Windows 上每条 PowerShell 命令慢约 22 秒**：Worker 传给引擎的系统环境变量白名单缺少 `PSModulePath`，Windows PowerShell 5.1 每次自动加载模块都要重建模块路径。补齐后同一条命令从 33 秒降到 0.5 秒，Gemini 单轮从 61 秒降到 14 秒。
- **DSH 无法启动任何外部程序**：DSH 0.1.2-rc.1 默认以 `workspace-write` 模式运行，其 Windows 实现是受限令牌，外部程序一律 `Access is denied`。完全访问模式下改用 DSH 自身的部署开关 `DSH_PERMISSION_MODE=danger-full-access`。
- **MiMo 启动即退出**：完全访问模式给 `mimo acp` 附加了它不接受的 `--yolo`，打印帮助后退出。改为与 OpenCode 一样依赖 ACP 层的自动批准。
- **OpenClaw 冷启动超时**：其私有 Gateway 在冷启动的 Windows 上需要 33 秒以上才输出首行日志。启动器等待放宽到 150 秒，ACP 初始化上限提高到 180 秒（协议上限 300 秒）。
- **Kimi 的请求被严格网关拒绝**：统一网关默认去除 `reasoning_effort`（模拟模型同步拒绝该参数，使问题能在 CI 暴露）。
- **离线安装在没有 pnpm 的机器上失败**：`Setup-Competition-Offline.cmd` 的 `build:console` 会嵌套调用 `pnpm`。安装脚本改为生成 `tools/shims/pnpm.cmd` 并置于子进程 PATH 首位。
- **模型密钥在全新机器上保存失败**：DPAPI 密钥助手首次启动（.NET 冷启动叠加杀毒扫描）超过原本 5 秒上限，上限提高到 20 秒。
- **无模型自检被半配置环境影响**：`Setup-Competition-Offline.cmd` 末尾的自检不调用模型，但只导出 `HARNESSHUB_MODEL` 而未导出 base URL 时网关拒绝启动。自检启动环境现在清除全部 `HARNESSHUB_MODEL*`。
- **诊断日志游标在 Linux 上错认文件**：轮转后新文件复用被删文件的 inode，游标按 inode 匹配到了另一个文件。文件身份改为 inode 加首 64 字节的 CRC-32。
- **控制台轮询淹没访问日志**：info 级只记录写操作、失败请求与 `GET /event`，成功的 GET/HEAD 降到 debug 级。
- **上游模型失败会连带关闭会话**：`MODEL_UPSTREAM_ERROR` 与 `ENGINE_NO_OUTPUT` 保留会话，可在同一会话重试。
- **其他**：ACP 探针在子进程已退出的进程组上收到 `EPERM` 不再当作错误；Gateway 绑定非回环地址时接受远端评委的 Host；`gateway-host` 集成测试在 Windows 上先关网关再删数据目录。

### 变更

- 发行包与文档不再提供 `--demo` / `fake` 引擎的演示路径；`fake` 只作为自动测试替身保留。
- `prompt_async` 的每轮期限、访问日志级别、密钥助手超时等默认值调整见上。
- `POST /v1/tool-packs/import` 请求体接受 `mcp` 内联文档（与 `source` 二选一，最大 256 KiB）；内联文档旁边没有文件，因此只有远程 URL 型服务能通过，本地命令仍按离线规则拒绝。
- `GET /v1/tool-packs` 为预装包增加 `preinstalled: true`。

### 验证

- Windows x64 CI：模拟模型 10/10 引擎通过；真实模型（DeepSeek `deepseek-flash` 经只接受流式的严格网关，对外呈现为 `GLM-V5_1-DX`）8/10 通过，Kimi 与 DSH 的根因修复后分别复测通过；一键工具包 9/10 引擎在真实模型下完成 MCP 与 CLI 调用。
- 离线开发包：断网执行 `Setup-Competition-Offline.cmd` 后用 `Start-Competition.cmd` 启动，opencode、codex、hermes 通过真实模型验收。
- 干净离线 Windows Server Core 容器（无任何预装运行时、无网络）：完整性校验、无模型自检与 10 引擎模拟模型验收全部通过。
- macOS：7 个真实引擎经严格流式网关跑通比赛接口。
- **未验证**：公司自有 GLM 网关、真实 Office/Outlook COM 操作、桌面（非服务）会话、Windows 10、ARM64、办公任务集在 Windows 上的结果。

证据与运行编号见 [Windows x64 验收记录](docs/verification/2026-09-20-windows-x64.md)、[统一模型网关验收](docs/verification/2026-09-19-unified-model-gateway.md)。

## 2026-09-08 决赛版本

进入公司比赛决赛的版本（`bf96ef9`）：Windows 免安装完整包（固定 Node、10 个开源引擎、Python/VC 组件、PortableGit 与控制台）、引擎发现与独立配置、执行控制与可追溯结果、本地工具包安装。历史范围见 [便携引擎验收](docs/verification/2026-09-06-portable-engines.md)与 [公司离线引擎验收](docs/verification/2026-09-07-offline-company.md)。
