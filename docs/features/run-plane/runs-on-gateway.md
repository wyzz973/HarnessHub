# 任务经共享网关

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元（`ModelSessions`、结果判定）与集成测试（经 `startHub` 的正式守护进程、Worker、ACP 夹具引擎与假上游），本机 macOS arm64；真实引擎经 `session:` Key 的 Run 只有所有者 2026-10-05 在本机控制台的手工核对，没有验收记录；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [Session Run 与共享网关](../../model-gateway.md#session-run-与共享网关)、[ADR 0019 及其 2026-10-05 补充](../../decisions/0019-session-runs-on-the-shared-gateway.md#补充控制台的任务按模型平面选择模型2026-10-05) |

## 用途

让执行平面的任务和本机其他客户端共用同一个模型网关：Run 用模型平面里的 provider 与路由组，享受同样的重试、熔断与粘性，每次调用都进 `model.call` 账本并按 Run 汇总用量与费用。在控制台的任务输入框里可以为这次执行选一个模型。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 任务（`/tasks`）的直接执行输入框：所选引擎的 `modelSelection` 为真且网关有模型时多一个“模型”选择（与 Agent 页相同的选择器）；执行详情列出 `model.call` 记录 |
| 命令行 | 无提交 Run 的命令；目标用 `hh provider`、`hh group` 准备（例如创建 `group/default`） |
| HTTP | `POST /v1/sessions/{id}/runs` 的 `model`；`GET /v1/engines` 的 `modelSelection`；`GET /v1/runs/{id}/observations` |

## 已实现的能力

- 是否走共享网关在 Session 第一个 Run 开始前决定，之后不变：引擎登记应用了统一模型时必须走；引擎的适配器可接入网关、且没有声明自己的 provider 时，存在目标才走，否则继续用引擎自己的登录；声明了自己 provider 的引擎与配置检查仍用 Worker 内的网关。
- 目标是 Run 的 `model`（Model Ref 或 `group/<id>`，必须含 `/`），缺省 `group/default`；指定的目标不存在时在启动 Worker 之前以 409 `MODEL_NOT_CONFIGURED` 失败，Session 保持打开；不走共享网关的 Session 指定 `model` 返回 409 `MODEL_SELECTION_UNSUPPORTED`。
- 每个这样的 Session 在第一个走网关的 Run 时签发一把 `session:` Gateway Key，`modelAllow` 为空，只能用于本 Session 活动 Run 的目标；Key 文本只在守护进程内存与该 Run 的 ExecutionSpec 中，数据库只存哈希。
- Worker 把引擎原生配置指向守护进程端口，凭据为这把 Key，模型名为别名；窗口与输出上限取目标模型的元数据（路由组取各成员的最小值）。
- 网关把调用记到活动 Run 的 `runId` 与 `generation`，Run 之外的调用返回 409 `no_active_run`；Session 关闭且在途调用结束后吊销 Key，守护进程启动时吊销上一个进程留下的全部 `session:` Key。
- 结算屏障：引擎结果返回后，Runtime 结束活动 Run，取消并等待本 Session 的在途调用提交，再按已提交的调用与观察到的输出判定：有上游失败且没有可见输出（或没有一次成功调用）为 `MODEL_UPSTREAM_ERROR`，完成却没有任何调用与输出为 `ENGINE_NO_OUTPUT`；规则在 core 中，与 Worker 网关共用。这两种失败保留 Session，可在同一 Session 重试。
- 每条已提交的调用成为该 Run 的 `model.call` 事件（协议、是否流式、请求模型、Model Ref、上游模型、状态、耗时、结束原因、usage、成本与错误）；Run 观测的 token、成本与实际模型来自这些事件，来源为 `gateway-ledger`。
- 观测的“配置模型”优先取 Run 的 `model`；账本有记录时“实际模型”取上游报告的模型，而不是引擎看到的别名。
- 控制台的选择缺省不带 `model`（`group/default` 存在时就是它，否则是引擎自己的设置）；选择按引擎记在浏览器中；继续一个 Session 时沿用它最后一个 Run 的 `model` 并锁定选择器。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [model-sessions.ts](../../../packages/daemon/src/model-sessions.ts)、[main.ts](../../../packages/daemon/src/main.ts)（`routeSession`）、[model-outcome.ts](../../../packages/core/src/model-outcome.ts)、[runtime.ts](../../../packages/runtime/src/runtime/runtime.ts)（`begin`/`end` 与结算）、[service.ts](../../../packages/runtime/src/application/service.ts)（`modelSelection`）、[model-picker.tsx](../../../packages/console/components/model-picker.tsx) |
| 测试 | [session-shared-gateway.test.ts](../../../tests/integration/session-shared-gateway.test.ts)、[model-sessions.test.ts](../../../packages/daemon/test/model-sessions.test.ts)、[worker-outcome.test.ts](../../../packages/daemon/test/worker-outcome.test.ts)、[shared-gateway-configuration.test.ts](../../../tests/unit/shared-gateway-configuration.test.ts) |
| 决策 | [ADR 0019 Session Run 使用共享网关](../../decisions/0019-session-runs-on-the-shared-gateway.md) |

## 已知限制与未验证

- 没有选模型、也没有 `group/default` 时，Run 用引擎自己的接线；这类调用带的是 Agent 自己的 Key 而不是 `session:` Key，账本记录不带 `runId`，执行详情的用量为“未提供”。
- 一个 Session 不能在共享网关与引擎自己的登录之间切换；是否走网关的决定只保存在守护进程内存中。
- 旧网关默认去除的 `reasoning_effort` 等参数不在 `drop-fields` 闭集中，迁移后会转发给上游，严格上游可能拒绝。
- `/api/v1/model-calls` 的响应 schema 还没有 `generation`。
- Workflow 的规划与步骤 Run 不带 `model`；Benchmark 只能在 dataset 的 `input` 中写 `model`（它复用 Run 输入的 schema），命令行没有对应选项。

## 优化候选

- **现状**：没有选模型的 Run 若走引擎自己的接线，用量无法按 Run 归属（见上）。**方向**：为这类 Run 也提供按 Run 的用量（例如在 Session 级别默认使用模型平面目标，或把接线 Key 的调用与 Run 时间窗关联并标明证据强度）。**依据**：[ADR 0019 补充](../../decisions/0019-session-runs-on-the-shared-gateway.md#补充控制台的任务按模型平面选择模型2026-10-05)的问题描述；阅读代码的观察（`model-sessions.ts` 只按 `session:` Key 归属调用）。
- **现状**：声明了自己 `openai-completions` provider 的引擎、无法迁移的统一模型与配置检查仍用 Worker 内的网关。**方向**：迁入模型平面后删除 Worker 网关，只保留一条模型路径。**依据**：[ADR 0019 后果](../../decisions/0019-session-runs-on-the-shared-gateway.md#后果)、[模型网关的未实现项](../../model-gateway.md#与-03-的差异与未实现项)。
- **现状**：结果判定只有 `MODEL_UPSTREAM_ERROR` 与 `ENGINE_NO_OUTPUT` 两条规则，499 同时表示取消与断开。**方向**：守护进程内的规则表 R1–R14 与三个结算面，新增 `MODEL_GATEWAY_UNUSED`、`AGENT_DISCONNECTED` 等。**依据**：[05 第 4 节](../../proposals/oss/05-run-plane.md#4-run-结果判定)、[05 第 11 节](../../proposals/oss/05-run-plane.md#11-与现状的差异与迁移)。
- **现状**：ADR 0019 已实现并有补充，但状态仍是 `proposed`。**方向**：确认后改为 `accepted`，并同步 [决策索引](../../decisions/README.md) 中的“（proposed）”。**依据**：阅读文档的观察（ADR 0019 第 3 行与索引）。
- **现状**：上游失败与无输出的公开消息是写死的中文（“上游模型返回 HTTP …”“引擎未调用模型也未产生输出”），而控制台已有中英文界面。**方向**：公开错误只给错误码与结构化字段，文字由界面按语言生成。**依据**：阅读代码的观察（`model-outcome.ts`）、[ADR 0034](../../decisions/0034-console-languages.md)。
