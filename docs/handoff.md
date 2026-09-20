# 交接说明

面向接手运行、排障和继续开发 HarnessHub 的人。当前状态与证据见 [Windows x64 验收记录](verification/2026-09-20-windows-x64.md)，本次发布的全部变化见 [变更记录](../CHANGELOG.md)。给公司内部开发 Agent 的上手材料是 [交接 Skill](../skills/harnesshub-company-gateway/SKILL.md)。

## 现在是什么状态

- 一个本地网关，用同一套 HTTP API 驱动 10 个 Agent 引擎；换引擎只改 `AGENT_ENGINE`。
- **所有引擎只使用统一模型**。引擎的原生协议在 Worker 内被转换为上游只接受流式的 OpenAI Chat Completions，引擎自己的 API Key、登录与订阅不会被使用；无法经统一模型驱动的适配器直接停用。
- 比赛接口按规范 v1.1 实现；`prompt_async` 阻塞到本轮结束。
- Skill / MCP / CLI 工具包可一键装到全部引擎；办公工具包随发行包预装。
- 引擎与网关之间的交互全程写入诊断日志。

Windows x64 上十个引擎在模拟模型下全部通过，真实模型（替身）下八个通过。**公司自有模型网关没有验证过**，现场必须先用 `POST /v1/harness/model/test` 或控制台“模型”页的测试按钮确认链路。

## 拿到与运行

| 场景 | 做法 |
|---|---|
| 直接使用（Windows x64，离线） | 下载 Release `competition-latest` 的 `harnesshub-competition-full-windows-x64.zip`，**用 7-Zip 或 `tar.exe -xf` 解压到短路径**（如 `D:\hh`），双击 `Start.cmd`，浏览器打开 `http://127.0.0.1:3330` 配置模型 |
| 比赛评测 | 设置 `HARNESSHUB_MODEL*` 与 `AGENT_ENGINE` 后运行 `Start-Competition.cmd`，见 [INSTRUCTION.md](../distribution/INSTRUCTION.md) |
| 改代码 | 下载 Release `offline-dev-latest`（源码 + 离线依赖 + 固定引擎），断网执行 `Setup-Competition-Offline.cmd`；或按 [README](../README.md#从源码开发) 从 GitHub 克隆 |
| 升级 | 换新包重新解压到新目录；`state\` 目录保存运行数据与设置，需要干净状态就用全新解压目录 |

解压路径长度是硬约束：包内最长相对路径 196 字符，资源管理器默认解压位置会超过 Windows 260 字符上限并静默丢文件。

## 配置（环境变量）

在**启动服务的同一个窗口**设置；`state\` 只保存密钥的环境变量名或系统密钥库引用，不保存密钥本身。

| 变量 | 必填 | 说明 |
|---|---|---|
| `HARNESSHUB_MODEL` | 是 | 上游真实模型 ID，例如 `GLM-V5_1-DX` |
| `HARNESSHUB_MODEL_BASE_URL` | 是 | 接口基地址，通常以 `/v1` 结尾，不含 `/chat/completions` |
| `HARNESSHUB_MODEL_API_KEY` | 视上游 | 密钥本身，只存在于进程环境 |
| `HARNESSHUB_MODEL_PROTOCOL` | 否 | 默认 `openai-completions` |
| `HARNESSHUB_MODEL_CONTEXT_WINDOW` | 否 | 上下文窗口，正整数；Hermes 要求至少 64000 |
| `HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS` | 否 | 单次输出上限，正整数 |
| `HARNESSHUB_MODEL_DROP_PARAMETERS` | 否 | 逗号分隔的额外去除参数；上游报“不支持某参数”时用 |
| `HARNESSHUB_MODEL_REASONING` | 否 | `passthrough`（默认）或 `strip`；上游拒绝回传推理内容时设为 `strip` |
| `HARNESSHUB_MODEL_IMAGES` | 否 | `placeholder`（默认）或 `passthrough` |
| `AGENT_ENGINE` | 比赛模式必填 | `opencode`、`codex`、`qwen`、`hermes`、`pi`、`gemini`、`mimo`、`dsh`、`openclaw`、`kimi` |
| `HARNESSHUB_RUN_TIMEOUT_MS` | 否 | 每轮任务期限，1～86400000，比赛模式默认 3600000 |
| `HARNESSHUB_LOG_LEVEL` | 否 | `info`（默认）或 `debug`；debug 增加提示词与回答摘录 |
| `HARNESSHUB_FULL_ACCESS` | 否 | 比赛入口自动设为 `1`：自动批准工具与权限请求 |
| `HARNESSHUB_PREINSTALL_TOOL_PACKS` | 否 | `0` 关闭发行包内工具包的首次自动安装 |
| `HARNESSHUB_GATEWAY_URL` | 开发 | 控制台连接的 Gateway 地址 |

## 日志在哪里、怎么看

以比赛布局为例，根为 `<解压目录>\state\competition-data\`：

| 内容 | 位置 |
|---|---|
| 接口访问、Session/Run/Worker 生命周期、权限、每次模型调用摘要 | `logs\gateway.log` |
| 单个会话的引擎进程与 stderr、逐条 ACP 请求/响应、工具调用状态、模型调用明细 | `backends\<sessionId>\diagnostics\engine.log`（路径在 `gateway.log` 的 `session.create` 行的 `engineLog` 字段） |
| 页面查看 | 控制台“执行详情 → 诊断日志”，或 `GET /v1/sessions/{id}/logs?source=engine\|gateway` |
| 一键打包（已脱敏） | `Collect-Logs.cmd` → `logs-<时间>.zip` |

每行一个 JSON 对象，密钥已脱敏，单文件超过 16 MiB 轮转。排障顺序：`gateway.log` 里找该 Run 的 `run.finish` 与 `worker.exit` → 打开对应 `engine.log` → `engine.stderr` 是引擎自己的报错，`acp.response` 带 `ok:false` 是协议错误，`model.call` 的 `status`/`error` 是模型网关与上游的结果（`reasoning.missing` 大于 0 表示推理内容未回填）。

## 排障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `prompt_async` 返回 502，消息含上游 HTTP 4xx 且提到某个参数 | 公司网关拒绝该参数 | 把参数名加进 `HARNESSHUB_MODEL_DROP_PARAMETERS` |
| 502 且消息提到 `reasoning_content` | 上游不接受回传推理内容 | 设 `HARNESSHUB_MODEL_REASONING=strip` |
| 一轮任务恰好在 1 小时被判 `RUN_TIMED_OUT` | 达到默认期限 | 调大 `HARNESSHUB_RUN_TIMEOUT_MS` |
| 某引擎第一轮很慢（1～3 分钟）后失败 | OpenClaw 每个会话先起私有 Gateway，Windows 冷启动慢 | 新建会话重试；杀毒实时扫描会进一步拖慢 |
| 引擎能回复但执行命令很慢或超时 | 缺 `PSModulePath` 会让每条 PowerShell 命令慢约 22 秒（已修复） | 确认用的是本次发布的包 |
| Kimi 任务做完了却报引擎非零退出 | 冻结的 Python 程序按 ANSI 代码页写 stdout，中文/emoji 触发 `charmap` 错误（已修复） | 确认用的是本次发布的包 |
| DSH 报 `Access is denied` 打不开外部程序 | DSH 默认受限令牌沙箱（已修复：完全访问模式下关闭） | 确认用的是本次发布的包 |
| Gemini 回复“命令被拦截 / command substitution” | Gemini CLI 即使在完全访问模式也拦截含 `$()`、反引号、`@()` 或括号表达式的 PowerShell 单行命令 | 让模型把脚本写成 `.ps1` 文件，再 `powershell -NoProfile -ExecutionPolicy Bypass -File`（办公 Skill 已写入该规则） |
| 打开的应用在任务结束后消失 | Windows 上每个会话的引擎与其全部子进程在同一个 kill-on-close Job 中，会话清理时一并关闭 | 用办公工具包的 `cli_app_open`（经资源管理器代启动，脱离该 Job）；不要用 `Start-Process` 直接启动 |
| 解压后启动报缺文件 | 路径超过 260 字符导致静默丢文件 | 用 7-Zip 或 `tar.exe` 重新解压到短路径 |
| 控制台保存模型密钥失败 | DPAPI 助手首次冷启动慢（上限已提高到 20 秒） | 重试；仍失败改用 `HARNESSHUB_MODEL_API_KEY` 环境变量 |
| 端口 6217 或 3330 被占用 | 其他进程占用 | 比赛入口用 `--port` / `--console-port`；控制台端口被占用会自动换 |

其余现象按 [INSTRUCTION.md 第 11 节](../distribution/INSTRUCTION.md)。

## 已知限制

- Kimi 由非交互 CLI 驱动，每轮任务是一个独立进程，轮与轮之间没有 shell 状态。
- Pi 与 OpenClaw 使用各自的原生扩展机制而非会话级 MCP，不兼容的绑定会明确失败而不是静默丢工具。
- 完全访问模式不是操作系统沙箱：引擎以当前 Windows 用户的权限运行。
- 公司模型网关未验证；真实 Office/Outlook COM 操作未验证；桌面会话下的“应用保持打开”未实测。

## CI 与发布

| 工作流 | 触发与产出 |
|---|---|
| `Quality checks` | 每次推送；Ubuntu 与 Windows 各跑一次 `pnpm check` |
| `Competition full bundle x64` | 推送到交付分支；构建 → 自检 → 发布到 Release `competition-latest` → 10 引擎模拟模型验收 |
| `publish-offline-dev-release.yml` | 同上；构建离线开发包 → 断网安装验证 → 发布到 Release `offline-dev-latest`（7z 分卷） |
| `Competition real-model acceptance x64` | 手动分支触发；从 Release 下载包，经开发机的临时模型端点做真实模型验收与办公任务测试 |

发布一版：把改动推到交付分支 → 等 x64 与离线包两条流水线通过（失败不发布）→ 用 [验收记录](verification/2026-09-20-windows-x64.md)的方式补证据。旧 Release 资产在覆盖前先备份为带日期的 tag。

## 待办

- 公司内网用真实 `GLM-V5_1-DX` 跑一遍比赛接口与办公任务，按需调整三个兼容开关。
- 在装有 Office 的真实桌面 Windows 上验证办公 Skill 的 COM 配方与“应用保持打开”。
- 办公任务集在 Windows 上的通过率与逐题调优。
- Windows 10 与 ARM64 的对应验收。

未完成任务与证据见 [TODO.md](../TODO.md)。
