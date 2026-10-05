# 检测与体检

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 集成测试以 [假 provider](../../../tools/fake-provider/README.md) 的字段清单与怪癖为每项检查构造通过与失败的上游，经守护进程与真实 `hh` 命令验证报告、提议的补丁、应用补丁后复查通过、账本条目，以及 Key 不出现在输出中；真实 provider 只有 DeepSeek（2026-10-05，13 项通过，`context-overflow` 因未加 `--deep` 跳过，`pnpm test:real` 复跑结果相同）；Windows 未验证 |
| 对照 Magpie | 测试与 `magpie provider test` 相同；体检（14 项检查、预计成本与提议的补丁）是 HarnessHub 在其上的增加（[Providers, presets and import](../../magpie-parity.md#providers-presets-and-import) 的 provider test 行） |
| 权威文档 | [Provider 测试与体检](../../provider-doctor.md)、[体检](../../provider-doctor.md#体检)、[修复](../../provider-doctor.md#修复)、[实现与限制](../../provider-doctor.md#实现与限制) |

## 用途

添加或修改一个 provider 之后，用真实请求回答两个问题：每个声明的端点能不能用；这个上游需要哪些设置（Key 的发送方式、输出上限字段、usage、可选字段、推理回传、模型元数据）。体检给出可直接应用的补丁与命令，不必在 Agent 报错后逐个试错。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Provider › 详情 › 检测：“测试端点”，或“体检”（先显示计划与预计成本，可选超长输入与慢响应阈值，点击后才运行），“应用建议的修改”确认后写入；订阅 provider 不提供 |
| 命令行 | `hh provider test <id> [--model M]`；`hh provider doctor <id> [--model M] [--deep] [--slow-ms N] [--fix]`；`--json` 输出与 API 相同的报告 |
| HTTP | `POST /api/v1/providers/{id}/test`（`{"model"?}`）；`POST /api/v1/providers/{id}/doctor`（`{"model"?, "deep"?, "slowMs"?, "dryRun"?}`，`dryRun` 只返回计划） |

## 已实现的能力

- 测试：对每个声明的端点发一个最小的非流式请求（一句提示词，输出上限 16 token），列出状态、耗时、首字节时间、上游自报的模型与请求地址；失败的端点另给脱敏后的错误，没有响应时状态为 0。模型缺省为第一个公开的模型。
- 体检先打印计划：使用的模型与端点（chat，没有时依次为 responses、anthropic、gemini）、预计的模型请求数与失败时最多的请求数、模型列表请求数、预计成本（模型没有价格时为预计 token 数）。`--deep` 另发一个超过上下文窗口的输入，执行前询问。
- 14 项检查：`endpoints`、`auth`（401 或 403 时换另一种 Key 发送方式各重试一次）、`models`、`streaming`、`usage`、`max-tokens`、`tools`（`get_weather` 两轮往返）、`reasoning-replay`、`optional-fields`、`image`（1×1 PNG）、`native-endpoints`、`served-model`、`latency`（3 个流式请求的首字节与首内容中位数）、`context-overflow`（仅 `--deep`）。
- 每项为 `PASS`、`WARN`、`FAIL` 或 `SKIP`，附一行结论与观测；`WARN` 与 `FAIL` 另附脱敏的上游错误、HTTP 状态、请求地址与可执行的建议命令；基础请求失败时依赖它的检查标为 `SKIP` 并说明原因。最后一行汇总各状态数、实际请求数与成本；体检完成即以 0 退出，检查结果不影响退出码。
- `optional-fields` 在对照请求成功的前提下逐个加入 `drop-fields` 闭集中的字段，只有加入后 400 或 422 才归因于该字段；`reasoning-replay` 判定推理内容必须回传、可选或拒绝。
- 修复：报告的 `patch` 是从 provider 现有设置出发、合并了所有建议的 JSON Merge Patch（例如 `auth.apiKeyHeader`、`drop-fields`、`include-usage`、`max-tokens-field`、`requiresReasoningReplay`、删除 404/405 的端点、加入可用的端点）；`--fix` 打印后询问再应用，非交互需要 `--yes`，否则以 4 退出且不修改。模型元数据的建议以 `hh model set` 命令给出。
- 每个请求在发出下一个之前写入 `model.call` 账本（作用域 `client:doctor`，`inbound.path` 为 `/doctor/<检查>`），成本按模型价格计算；测试与体检本身从不修改 provider。
- 请求经 `@harnesshub/gateway/probe`：使用网关的上游地址、请求头、流解析、usage、成本与失败分类，但不经过路由、重试、熔断、额度与 provider 补丁，看到上游对原样请求的反应；走 provider 自己的代理或守护进程的代理，代理失败给出完整原因。
- 请求超时 60 秒，上下文探测 240 秒；客户端断开或守护进程关闭时取消进行中的请求并记 499 `client_cancelled`；账本无法写入时立即停止并返回 503 `EVIDENCE_UNAVAILABLE`；诊断日志为每次体检记一条 `provider.doctor`。
- 订阅 provider 的测试与体检返回 409 `SUBSCRIPTION_PROVIDER`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | 检查与报告 [provider-doctor.ts（daemon）](../../../packages/daemon/src/provider-doctor.ts)、各端点的请求 [doctor-requests.ts](../../../packages/daemon/src/doctor-requests.ts)、路由 [doctor-routes.ts](../../../packages/daemon/src/http/doctor-routes.ts)、单次探测 [probe.ts](../../../packages/gateway/src/probe.ts)、报告契约 [provider-doctor.ts（core）](../../../packages/core/src/provider-doctor.ts)、控制台 [provider-doctor.tsx](../../../packages/console/components/provider-doctor.tsx) |
| 测试 | [provider-doctor.test.ts](../../../tests/integration/provider-doctor.test.ts)、[real-provider-check.test.ts](../../../tests/integration/real-provider-check.test.ts)（`pnpm test:real` 脚本自身，对假上游）、[真实 provider 记录](../../compatibility.md#真实-providerdeepseek2026-10-05) |
| 决策 | 无独立 ADR；设计见 [03 模型平面第 9 节](../../proposals/oss/03-model-plane.md#9-能力体检) |

## 已知限制与未验证

- 每个协议只用第一个启用、且对该协议有效的凭据体检，同一 provider 的其他凭据（可能属于不同套餐、看到不同模型）不检查（阅读 [provider-doctor.ts](../../../packages/daemon/src/provider-doctor.ts) 的观察）。
- 推理回传只在 Chat 端点检查（DeepSeek 风格的 `reasoning_content`）；可选字段只在 Chat 与 Responses 端点检查。
- 体检报告不保存：模型平面没有单独的事件存储，只留下账本条目与诊断日志中的一行。
- `--fix` 只应用 provider 补丁，不应用模型元数据（图片模态、上下文窗口）的建议。
- 订阅 provider 不能体检；`context-overflow` 没有在真实上游上运行过；DeepSeek 以外的真实 provider 未验证；Windows 未验证。

## 优化候选

- **现状**：多凭据的 provider 只体检每个协议的第一个凭据。**方向**：允许指定凭据，或逐个凭据体检并分别报告 `auth` 与 `models`。**依据**：阅读代码的观察；凭据可以限定协议并有各自的模型列表（[模型解析与列表](../../model-gateway.md#模型解析与列表)）。
- **现状**：推理回传与可选字段只覆盖 Chat（及 Responses）。**方向**：为 Anthropic 的签名回传、Gemini 的 `thoughtSignature` 与这两个协议的可选字段加检查。**依据**：[实现与限制](../../provider-doctor.md#实现与限制)。
- **现状**：报告只在这次响应中，无法回看或比较。**方向**：保存最近的体检报告，在 Provider 详情中显示上次结果与时间。**依据**：[API](../../provider-doctor.md#api) 一节（“模型平面目前没有单独的事件存储”）。
- **现状**：模型元数据的建议要用户另行执行 `hh model set`。**方向**：`--fix` 与控制台的应用一并写入模型覆盖（逐项确认）。**依据**：[修复](../../provider-doctor.md#修复)。
- **现状**：`unverified` 的预设没有被体检批量核对过。**方向**：用 `pnpm test:real` 的体检步骤为预设建立核对记录。**依据**：[Provider 预设](../../provider-presets.md#列出与选择) 的 `VERIFIED` 说明、[真实 Agent 兼容性的怎样重复](../../compatibility.md#怎样重复)。
