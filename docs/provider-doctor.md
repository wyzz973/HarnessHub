# Provider 测试与体检

`hh provider test` 与 `hh provider doctor` 向 provider 的上游发送真实请求，回答两个问题：每个声明的端点能不能用；这个上游需要哪些设置（Key 的发送方式、输出上限字段、usage、可选字段、推理回传、模型元数据）。设计见 [03 第 9 节](proposals/oss/03-model-plane.md#9-能力体检)；API 与其他 provider 操作见 [模型平面 API 与 CLI](model-plane-api.md)。

两者都会消耗上游额度：每个请求在发出下一个之前写入 `model.call` 账本，作用域为 `client:doctor`（`GET /api/v1/model-calls` 中可见，`inbound.path` 为 `/doctor/<检查>`），成本按模型价格计算。它们从不修改 provider。

## 测试

```sh
hh provider test deepseek [--model deepseek-chat] [--json]
```

对每个声明的端点发一个最小的非流式请求（一句提示词，输出上限 16 token），列出状态、耗时、首字节时间、上游自报的模型与请求地址；失败的端点另起一行给出脱敏后的错误。没有响应时状态为 0。模型缺省为 provider 第一个公开的模型。

## 体检

```sh
hh provider doctor deepseek [--model M] [--deep] [--slow-ms 10000] [--fix] [--json]
```

前置条件：守护进程在运行，provider 有可用的凭据（本机服务可以没有）与至少一个模型（或给出 `--model`）。

命令先打印计划：使用的模型与端点（chat，没有时依次为 responses、anthropic、gemini）、预计的模型请求数（以及失败时最多的请求数）、模型列表请求数与预计成本（模型没有价格时显示预计 token 数）。`--deep` 会另发一个超过模型上下文窗口的输入，执行前询问；非交互时需要 `--yes`，否则以 4 退出且不发送任何请求。

报告逐项给出 `PASS`、`WARN`、`FAIL` 或 `SKIP`、一行结论、观测细节；`WARN` 与 `FAIL` 另附脱敏后的上游错误、HTTP 状态、请求地址与可执行的建议命令。最后一行汇总各状态数、实际请求数与成本。`--json` 输出与 API 相同的报告。体检完成即以 0 退出，检查结果不影响退出码。

| 检查 | 方法 | 结果 |
|---|---|---|
| `endpoints` | 每个声明的端点一个最小请求 | 2xx 为通过；404、405、无响应、5xx 或无法解析的 2xx 为失败，并给出实际请求地址；其他端点可用时提议删除 404/405 的端点。指明模型不存在的 404 不算路径错误（见 `models`） |
| `auth` | 401 或 403 时，用另一种发送方式（Bearer 与 `x-api-key` 互换；Gemini 的 `x-goog-api-key` 与 `query-key`）各重试一次 | 另一种方式可用时失败，并提议 `auth.apiKeyHeader`；之后的检查使用可用的方式继续 |
| `models` | 模型列表（与刷新相同的接口） | wire 名在列表中为通过；不在时失败，列出相近的模型；没有列表接口时，`live` 来源为警告，其他来源为通过 |
| `streaming` | 一个流式请求 | 可解析且有终止事件为通过 |
| `usage` | 不带与带 `stream_options.include_usage` 的流式请求各一次（Chat） | 不带时有 usage 为通过；只在带时有，提议 `include-usage` 补丁；都没有为警告 |
| `max-tokens` | `max_tokens` 与 `max_completion_tokens` 各一次（Chat） | 被接受的字段与 `max-tokens-field` 补丁一致为通过，否则失败并提议加上或去掉补丁；基础请求因字段被拒时，之后的检查改用被接受的字段 |
| `tools` | 一个 `get_weather` 工具的两轮往返 | 第二轮返回文本为通过；模型不调用工具为警告 |
| `reasoning-replay` | 第二轮不带 `reasoning_content` 再发一次（Chat，模型有推理时） | 判定必须回传、可选或拒绝，与 `capabilities.requiresReasoningReplay` 不一致时失败并提议修改 |
| `optional-fields` | 在基础请求上逐个加入 `drop-fields` 闭集中的字段（`stream_options` 加在流式请求上，`parallel_tool_calls` 加在工具请求上） | 只有对照请求成功而加入该字段后 400/422 才归因于它；未被 `drop-fields` 覆盖的字段为失败，并提议补丁 |
| `image` | 1×1 PNG | 与模型元数据的输入模态一致为通过；否则给出 `hh model set <provider>/<model> modalities=…` |
| `native-endpoints` | 只声明 chat 或 responses 之一时，在同一基址试另一个 | 声明的端点都可用为通过；未声明的可用时警告并提议加入 |
| `served-model` | 成功响应中的 `model` | 与 wire 名一致（忽略大小写、`models/` 前缀与日期后缀）为通过，否则警告 |
| `latency` | 3 个流式请求 | 首字节与首内容时间的中位数；首内容超过 `--slow-ms`（默认 10000）为警告 |
| `context-overflow` | 仅 `--deep`：超过模型上下文窗口的输入 | 网关的分类器识别为超长为通过；被接受为失败（窗口比声明的大）；被拒绝但无法识别为警告 |

基础请求失败时，依赖它的检查标为 `SKIP` 并说明原因。

### 修复

报告的 `patch` 是合并了所有建议的 JSON Merge Patch（`PATCH /api/v1/providers/{id}`），从 provider 的现有设置出发计算，例如在现有补丁上加入 `drop-fields` 与被拒字段。`--fix` 打印这份补丁并询问是否应用；非交互时需要 `--yes`，否则以 4 退出且不修改。模型元数据（如图片模态、上下文窗口）不属于 provider 设置，以 `hh model set` 命令给出。

## API

- `POST /api/v1/providers/{id}/test`：请求体 `{"model"?}`。
- `POST /api/v1/providers/{id}/doctor`：请求体 `{"model"?, "deep"?, "slowMs"?, "dryRun"?}`；`dryRun` 只返回 `plan`，不发请求。

客户端断开或守护进程关闭时，进行中的请求被取消，仍记入账本（状态 499，`client_cancelled`），之后不再发送；守护进程关闭前等待这些写入完成。账本无法写入时立即停止并返回 503 `EVIDENCE_UNAVAILABLE`。诊断日志为每次体检记录一条 `provider.doctor`（各状态计数、请求数、成本与失败的检查）；模型平面目前没有单独的事件存储，所以没有对应的事件。

## 实现与限制

- 请求经 [`@harnesshub/gateway/probe`](../packages/gateway/src/probe.ts) 发送：使用网关的上游地址、请求头、流解析、usage、成本与失败分类，但不经过路由、重试、熔断、额度与 provider 补丁——体检要看到上游对原样请求的反应。账本条目没有 Gateway Key（`keyId`），只记录作用域。
- 推理回传只在 Chat 端点检查（DeepSeek 风格的 `reasoning_content`）；可选字段只在 Chat 与 Responses 端点检查。
- 请求超时 60 秒，上下文探测 240 秒。
- 订阅 provider（[订阅账号](subscriptions.md)）不经体检：其凭据是登录令牌而不是 API Key，测试与体检返回 409 `SUBSCRIPTION_PROVIDER`；账号状态见 `hh subscription list`。

测试：[provider-doctor.test.ts](../tests/integration/provider-doctor.test.ts) 以[假 provider](../tools/fake-provider/README.md) 的字段清单与怪癖（`noUsage`、`servedModel`、`slowHeaders`、`midStreamError`、`allowed`/`forbidden` 字段、关闭推理回传）为每项检查构造通过与失败的上游，经守护进程与真实 `hh` 命令验证报告、提议的补丁、应用补丁后复查通过、账本条目与 Key 不出现在输出中。
