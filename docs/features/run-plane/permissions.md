# 权限往返

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元与集成测试（正式 Gateway、真实 SQLite、编译 Worker 与本地 ACP 对端），本机 macOS arm64；真实引擎的权限往返只有比赛期记录（2026-09-05 OpenCode 两次 `once` 决定 applied）；Full Access 只有单元与 `/v1/runtime/info` 的集成断言；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [运行契约](../../../DESIGN.md#5-run-生命周期与控制契约)、[权限与产物](../../runtime-api.md#权限与产物)、[ADR 0010](../../decisions/0010-acpx-client-capabilities.md) |

## 用途

Agent 执行中请求写文件、运行命令等需要确认的操作时，请求经 HarnessHub 交给人或调用方，按实际选项回答一次。决定先落库再送达引擎，事后可以复查谁在什么时候允许或拒绝了哪一次工具调用。无人值守时可以用 Full Access 让引擎的请求自动获准。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 任务（`/tasks`）的对话中显示实际权限请求及其选项；状态条显示“完全访问”（Full Access） |
| 命令行 | `hh benchmark --permissions deny\|allow-once`（见 [Benchmark](benchmark-rollout.md)）；Full Access 由启动守护进程时的环境变量 `HARNESSHUB_FULL_ACCESS=1` 打开 |
| HTTP | `GET /v1/runs/{id}` 的 `permissions`；`POST /v1/permissions/{id}/decision`，body `{"optionId":"…"}`；`GET /v1/runtime/info` 的 `fullAccess` |

## 已实现的能力

- ACP Driver 以 deny-all 为基线，并向引擎声明不提供 ACP 客户端文件与终端能力（`fs:false`、`terminal:false`），引擎使用自己的原生工具；见 [ADR 0010](../../decisions/0010-acpx-client-capabilities.md)。
- 引擎主动上报的权限请求只保留 `allow_once` 与 `reject_once` 两类选项；同一类有多个选项时按原 `optionId` 与顺序全部保留，依赖固定的 [acpx 补丁](../../../patches/acpx@0.13.2.patch)把选中的 ID 原样交给 ACP SDK。
- 没有可用选项或选项 ID 重复时，Driver 发出 `permission.unsupported` 事件并取消该请求，不按 kind 猜测。
- 权限记录含 `permissionId`、`runId`、`generation`、`toolCallId`、实际选项、`createdAt` 与有效期（等于 Run 的总期限）；创建时 Run 进入 `waiting_permission`。
- 决定先持久化（`PERMISSION_DECIDED`），再发给 Worker；Worker 确认应用后记 `PERMISSION_APPLIED`（`acknowledgement=worker`），Run 回到 `running`。`applied` 只说明 Worker 接收并映射了决定，不说明外部工具执行成功。
- 相同的重复决定返回原记录；不同决定返回 409 `PERMISSION_CONFLICT`；不存在的选项返回 400 `INVALID_PERMISSION_OPTION`；Run 已结束、被取消或不是当前 `generation` 时返回 409 `PERMISSION_EXPIRED`。
- Run 结束时仍未决定的请求记为 `expired`；取消信号生效后到达的决定被拒绝；崩溃后不向失去归属的请求重发决定。
- Full Access（`HARNESSHUB_FULL_ACCESS=1`）的设计行为：ACP Driver 改用 acpx 的 `approve-all`，并对每个请求自动选第一个 `allow_once`（引擎日志记 `acp.permission` 的 `auto-allow`）；Codex 的 `INITIAL_AGENT_MODE` 保持 `agent-full-access` 而不是只读；它不改变模型、Provider 或凭据。控制台在 Full Access 下选择自动规划时给出提示。
- Benchmark 的 `deny`（默认）只选实际的 `reject_once`，`allow-once` 只选实际的 `allow_once`，每个请求只提交一次；缺少或有歧义时取消 Run。
- 批准 [Workflow](workflows.md) 计划不会自动批准其中的工具权限。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [driver.ts](../../../packages/drivers/src/acp/driver.ts)（`permission`）、[runtime.ts](../../../packages/runtime/src/runtime/runtime.ts)（`decide`）、[sqlite-store.ts](../../../packages/store/src/storage/sqlite-store.ts)、[full-access.ts](../../../packages/agents/src/engine/full-access.ts)、[prepare.ts](../../../packages/agents/src/configuration/prepare.ts)（Codex 模式）、[acpx 补丁](../../../patches/acpx@0.13.2.patch) |
| 测试 | [gateway.test.ts](../../../tests/integration/gateway.test.ts)（权限往返）、[store.test.ts](../../../tests/integration/store.test.ts)（归属、选项、过期与应用分离）、[worker-host.test.ts](../../../tests/integration/worker-host.test.ts)、[acp-client-capabilities.test.ts](../../../tests/integration/acp-client-capabilities.test.ts)、[pressure.test.ts](../../../tests/integration/pressure.test.ts)（过期后不能批准）、[harness-model.test.ts](../../../tests/integration/harness-model.test.ts)（`fullAccess`）、[model-gateway-configuration.test.ts](../../../tests/unit/model-gateway-configuration.test.ts)（Codex 模式） |
| 决策 | [ADR 0010 ACP 客户端能力与精确权限选择](../../decisions/0010-acpx-client-capabilities.md)、[ADR 0002 首条执行链路](../../decisions/0002-runtime-mvp.md) |

## 已知限制与未验证

- 公共权限通道只覆盖引擎主动上报的请求，不覆盖引擎原生工具的全部路径：Pi 的扩展工具按 Pi 自己的规则执行，Kimi 的 print 模式原生自动批准工具，CLI 引擎没有交互权限。
- 没有“总是允许”、策略、按工具类别的预设或审计记录；Full Access 是整个守护进程的开关，不能按 Run 选择。
- Full Access 可能没有到达 Worker：Worker 的环境按白名单构造（[worker-host.ts](../../../packages/runtime/src/process/worker-host.ts) 的 `workerEnvironment`：系统变量、`credentialEnv`、配置中的秘密引用与日志级别），而 ACP Driver 与 Codex 的配置准备读取的是 Worker 进程的环境。2026-10-05 在本机用 `467e377` 的构建产物直接调用 `workerEnvironment` 核对：父进程设置 `HARNESSHUB_FULL_ACCESS=1` 时，生成的 Worker 环境不含该变量。没有测试经正式 Gateway 与 Worker 验证自动批准；端到端行为未运行验证，推测为只在守护进程上设置该变量时 `/v1/runtime/info` 报告 `fullAccess: true`，引擎的请求仍逐个等待决定。
- Windows 上的权限往返未验证。

## 优化候选

- **现状**：守护进程上的 `HARNESSHUB_FULL_ACCESS` 可能到不了 Worker（见上）。**方向**：先写一条经正式 Gateway/Worker 的集成测试确认；若属实，由组合根把开关显式传给 Worker（例如经 `ProcessWorkerHost` 的 `env` 或 ExecutionSpec），而不是依赖环境继承。**依据**：阅读代码的观察（`worker-host.ts`、`main.ts` 只传 `HARNESSHUB_LOG_LEVEL`、`driver.ts` 的 `fullAccess()`）与上文对 `workerEnvironment` 的直接核对。
- **现状**：只有 `allow_once`、`reject_once` 与全部拒绝的基线。**方向**：四种选项、按工具类别的策略文件、执行路径的覆盖报告与审计。**依据**：[05 第 5 节](../../proposals/oss/05-run-plane.md#5-权限与策略)、[05 第 11 节](../../proposals/oss/05-run-plane.md#11-与现状的差异与迁移)。
- **现状**：Full Access 是进程级环境变量，打开后对所有 Session 生效且没有审计。**方向**：作为显式的 `full-access` 预设按 Run 选择并写入审计。**依据**：[05 第 5 节](../../proposals/oss/05-run-plane.md#5-权限与策略)中“预设、无人值守与审计”一小节。
- **现状**：各引擎有哪些工具绕过公共权限通道只散见于各引擎文档。**方向**：在 `GET /v1/engines` 的能力中报告审批覆盖范围，控制台据此提示。**依据**：[DESIGN 第 3 节](../../../DESIGN.md#3-模块和执行所有权)“能力与审批覆盖范围必须如实报告”。
