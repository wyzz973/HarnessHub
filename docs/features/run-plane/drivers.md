# ACP 与 CLI 驱动

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元与集成测试（编译后的 Worker、本地 ACP 对端、真实子进程的 CLI 命令），本机 macOS arm64；真实引擎只有 2026-09-05 比赛期的 macOS 记录（DSH、Pi、OpenCode、OpenClaw 文本或文件任务）；可脚本化的假 Agent（OSS-009 第二部分）未开始；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [执行服务与 API](../../runtime-api.md#本地配置)、[通用 CLI 引擎](../../cli-driver.md)、[ACP 会话恢复](../../session-recovery.md)、[原生 MCP](../../native-mcp.md) |

## 用途

把不同的 Agent 程序接成同一种执行方式：支持 ACP 的 Agent 经 ACP 驱动建立长会话、上报结构化事件与权限请求；只接受文本输入、向标准输出写文本的命令经 CLI 驱动逐轮运行。Gateway 不按引擎写分支，新增引擎只需一份登记配置。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 引擎（`/engines`）：登记发现的候选（已带 `driver`），或在登记 JSON 中写 `driver`；列表显示每个引擎的 Driver |
| 命令行 | `hh serve --config <文件>` 中引擎的 `driver: acp\|cli`；`hh serve --demo` 启用假驱动 |
| HTTP | 登记接口的 `driver`、`command`、`acp`、`cli` 字段（见 [引擎发现、登记与热加载](engine-management.md)） |

## 已实现的能力

- 驱动接口（`Driver`）由 HarnessHub 定义，Worker 按 Profile 选择 ACP、CLI 或假驱动；第三方 ACP 类型只留在 `packages/drivers/src/acp`。
- ACP 驱动基于固定的 `acpx@0.13.2`（`acpx/runtime`）与本仓库的 pnpm 补丁：关闭 turn timeout 由 Runtime 管总期限；不声明客户端文件与终端能力；权限按实际 `optionId` 选择；另加只读的 ACP 消息与 Agent 进程回调供诊断日志使用（[ADR 0010](../../decisions/0010-acpx-client-capabilities.md)、[ADR 0014](../../decisions/0014-diagnostic-logs.md)）。
- ACP 会话以 `persistent` 模式按 Session 建立并在多个 Run 之间复用；首次 `session/new` 后发 `engine.session`（后端 ID），提交并确认后才发 prompt；显式 `acp.sessionMode: resume` 的引擎可跨 Worker 严格恢复，见 [Worker 隔离、进程清理与恢复](worker-isolation.md)。
- 每轮的 `startTurn` 结果独立于事件流：订阅者断开或事件投递失败时先取消该轮再报错；ACP 文本映射为 `message.delta`（输出与思考分流）、工具更新为 `tool.update`，另发 `engine.capabilities`（模型状态、控件、是否声明恢复）与 `engine.usage`（见 [执行观测](observability.md)）。
- 登记了 `model` 而引擎没有声明该模型或模型选择能力时返回 `ACP_MODEL_UNSUPPORTED`；引擎报告失败为 `ACP_TURN_FAILED`（消息取引擎原文的前 500 字符）；Worker 内的其他异常为 `DRIVER_ERROR`，原因脱敏后公开，堆栈写入私有的 `worker-errors.log`。
- CLI 驱动每个 Run 启动一个新进程，工作目录为 Session 的 Workspace：`inputMode: stdin` 把 `text` 原样写入 stdin 后发 EOF，命令提前关闭 stdin 只停止写入；`inputMode: argv` 以完整文本替换独立的 `{prompt}` 参数，不经 shell。
- CLI 的 stdout 按 UTF-8 转为 `message.delta`，`maxOutputBytes` 默认且至多 4 MiB，超出为 `CLI_OUTPUT_LIMIT`；stderr 不公开；退出码 0 为 `completed / process_exit`，其他为 `CLI_EXIT_NONZERO`、`CLI_SPAWN_ERROR`、`CLI_INPUT_ERROR`、`CLI_PROCESS_SIGNAL`；取消先 SIGTERM，250 ms 后 SIGKILL；每轮结束都由 Host 回收整个进程组后再发布结果。
- 假驱动只在 `--demo` 下可用，`fixture.scenario` 为 `echo`、`wait`、`permission`、`fail`、`crash`、`artifact`，用于不调用模型的演示与测试。
- 各引擎的接入要点：Pi 经 `pi-acp@0.0.33` 与 Pi 0.85.1（[Pi 引擎](../../pi-engine.md)）；OpenCode 的 DeepSeek 专用 Profile 经私有 HOME 的启动脚本（[OpenCode](../../opencode-engine.md)）；OpenClaw 经 Bridge launcher 为每个 Bridge 使用独立会话名（[OpenClaw](../../openclaw-engine.md)）；Kimi 的 ACP 需要 Kimi OAuth，统一 API 用 CLI 模板 `--quiet --prompt {prompt}`；Pi、OpenClaw、Kimi 的 MCP 走原生入口（[原生 MCP](../../native-mcp.md)），Copilot 的 stdio MCP 写入私有 `copilot-mcp.json`，Qwen 有 MCP 时设 `QWEN_CODE_LEGACY_MCP_BLOCKING=1`，MiMo 托管 MCP 时要求 `--log-level ERROR`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [driver.ts（接口）](../../../packages/drivers/src/driver.ts)、[ACP driver.ts](../../../packages/drivers/src/acp/driver.ts)、[session-store.ts](../../../packages/drivers/src/acp/session-store.ts)、[traffic-log.ts](../../../packages/drivers/src/acp/traffic-log.ts)、[CLI driver.ts](../../../packages/drivers/src/cli/driver.ts)、[fake driver.ts](../../../packages/drivers/src/fake/driver.ts)、[Worker main.ts](../../../packages/daemon/src/worker/main.ts)、[acpx 补丁](../../../patches/acpx@0.13.2.patch) |
| 测试 | [worker-acp.test.ts](../../../tests/integration/worker-acp.test.ts)、[acp-client-capabilities.test.ts](../../../tests/integration/acp-client-capabilities.test.ts)、[backend-session-store.test.ts](../../../tests/integration/backend-session-store.test.ts)、[native-model.test.ts](../../../tests/integration/native-model.test.ts)、[worker-cli.test.ts](../../../tests/integration/worker-cli.test.ts)、[cli-driver.test.ts](../../../tests/unit/cli-driver.test.ts)、[native-mcp.test.ts](../../../packages/agents/test/native-mcp.test.ts)、[mimo-mcp-logging.test.ts](../../../packages/agents/test/mimo-mcp-logging.test.ts) |
| 决策 | [ADR 0002 首条执行链路](../../decisions/0002-runtime-mvp.md)、[ADR 0003 动态引擎目录与通用 CLI 接入](../../decisions/0003-dynamic-engines.md)、[ADR 0010 ACP 客户端能力与精确权限选择](../../decisions/0010-acpx-client-capabilities.md) |

## 已知限制与未验证

- 没有直接加载原生 SDK 的 NativeDriver；SDK 只能经可执行的包装程序以 CLI 方式接入。
- CLI 驱动每轮无上下文，不支持交互权限、图片、结构化工具事件或会话恢复；命令必须向管道输出 UTF-8。
- 升级 acpx 必须重新核对补丁与恢复语义，补丁不是上游 API。
- Pi 的历史运行中 `engine.usage` 的 `usage` 为 null；OpenClaw 只验证过文本任务；多数引擎的取消、强制退出与恢复没有真实引擎证据。
- Windows 上 CLI 进程树清理与原生命令行为未验证。

## 优化候选

- **现状**：测试中的 ACP 对端是各测试自带的夹具，没有统一的可脚本化假 Agent。**方向**：完成 `tools/fake-agent`（可脚本化 ACP 对端），让驱动、恢复与权限用例共用。**依据**：[TODO.md](../../../TODO.md) 的 OSS-009（第二部分未开始）。
- **现状**：真实引擎经驱动的验收停在比赛期。**方向**：在 M1 的 Adapter 一致性套件中经正式 Gateway 与 Worker 重建固定版本引擎的文本、工具、取消与 MCP 验收。**依据**：[原生 MCP 验证](../../native-mcp.md#验证)、[10 第 3.3 节](../../proposals/oss/10-engineering.md#33-三类一致性套件)。
- **现状**：prompt 失败时，引擎报告的原文（至多 500 个字符）直接成为 `ACP_TURN_FAILED` 的消息。**方向**：确认这段原文进入 Run 记录与事件前经过与诊断日志相同的脱敏，并补一条含合成秘密的测试。**依据**：阅读 [driver.ts](../../../packages/drivers/src/acp/driver.ts) 的 `engineMessage` 的观察。
- **现状**：DESIGN 第 1 节的首批引擎包含 DSH，但它只有比赛期 Mac 上的恢复实测。**方向**：为显式恢复的引擎补一条开源版的真实恢复验收，并评估 Pi（已声明 `session/load`）开启 `resume`。**依据**：[Pi 引擎的待验证项](../../pi-engine.md#仍需验证的能力)、[ACP 会话恢复](../../session-recovery.md#mac-验证范围)。
