# 用量账本、会话与导出

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关测试（先提交后发布、提交失败时的 `evidence_unavailable`、会话键与 `agent` 归属），存储测试（组提交、检查点中被杀后重开），经正式守护进程的集成测试（用量、调用、会话与按凭据汇总，CSV 由独立的 RFC 4180 解析器读回，去掉公式防护时失败）；`pnpm bench` 测账本提交延迟；2026-10-05 的 DeepSeek 真实验证中 98 次成功调用入账，有价格与未定价的分开统计；macOS arm64。Windows 未验证 |
| 对照 Magpie | 相同：每次调用一条记录、上游凭据与调用方归属、未定价与 0 分开、各维度汇总、CSV；有意不同：会话只存按 Key 隔离的哈希、价格变化不重算历史；部分：记录的附加字段、成本估算、过滤、图表；未覆盖：请求归档与请求体（[对照表](../../magpie-parity.md#usage-and-observability)） |
| 权威文档 | [账本](../../model-gateway.md#账本)、[模型平面 API 的资源](../../model-plane-api.md#资源)（model-calls、usage、conversations）、[CSV 导出](../../observability.md#csv-导出)、[模型元数据](../../model-plane-api.md#模型元数据) |

## 用途

网关处理的每一次模型调用都留下一条证据：谁调用、经哪个凭据发往哪个模型、用了多少 token、花了多少钱、是否失败以及为什么。用户按模型、provider、凭据、Key、Agent、日期或会话查看汇总，或导出 CSV 与厂商账单对照。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 用量（时间范围、按模型、provider、凭据、Key、Agent 或 UTC 日期汇总，最近调用，下载汇总 CSV 与调用 CSV）；用量 → 会话（按会话汇总、展开逐次调用）；任务的执行详情（`model.call` 记录与用量） |
| 命令行 | `hh usage [--by model\|provider\|day\|key\|adapter\|credential\|conversation\|call] [--since 7d] [--from TIME] [--to TIME] [--provider P] [--model REF] [--key KEY_ID] [--agent A] [--format text\|json\|csv]` |
| HTTP | `GET /api/v1/model-calls`（`format=csv`）、`GET /api/v1/usage?groupBy=…`（`format=csv`）、`GET /api/v1/conversations`、`GET /api/v1/conversations/{key}` |

## 已实现的能力

- 每个进入网关的调用提交一条 `ModelCallEntry`：每次尝试（候选、状态、错误类别、决定与退避）、按协议规范化的五项 usage（没有上报时 `source: missing`、各项为 0）、耗时与首字节、首内容时间、`status`、`errorClass`、脱敏后的 `error`、`patches[]`、直通或转换、`servedModel`、规范化的 `finishReason`、转换中丢弃的字段 `unmapped[]`。
- 本地拒绝也入账（`rejected: true`），同一 Key 与同一原因每分钟至多 20 条明细，其余计数后写成一条汇总。
- 先提交后发布：流的终止事件与非流式响应体在 `appendModelCall` 成功之后才写出，提交失败时 503 `evidence_unavailable` 或流内错误；同时到达的记录合成一个事务提交（组提交），WAL 检查点由工作线程完成。
- 归属：`keyId` 与作用域、`sessionId` 与 `runId`、`conversationKey`（粘性会话键的 SHA-256，按 Key 隔离，不存客户端原始标识）、`agent`（`key` 来自 `agent:` Key，`user-agent` 与 `route` 为推断）；网关自己的调用以 `purpose` 为 `vision` 或 `classify` 单独入账。
- 成本在调用时计算：provider 模型声明了价格、且每个用到的 token 类别都有价格时才算（推理按输出价格），否则为 null；价格按覆盖、provider 手填、上游列表、预设、models.dev 快照的顺序解析；以后改价不重算历史；服务了无价格的调用后，目录最早 6 小时提前刷新；订阅账号的调用 `cost` 为 null。
- 汇总 `groupBy` 为 `day`（UTC）、`provider`、`model`、`key`、`adapter` 或 `credential`；状态码不低于 400 记为失败，成本只累加已知价格，未定价的调用计入 `unpricedCalls`，控制台单独标出、不计为 0。
- 会话视图按 `conversationKey` 汇总调用数、失败数、用量、成本、首末时间、用到的模型、凭据与 Agent，游标分页；`hh usage --by conversation` 列出最后活动的 200 个会话。
- 调用过滤：`from`、`to`、`keyId`、`provider`、`model`、`sessionId`、`agent`；`limit` 1–200，游标分页。
- CSV：调用为 Magpie `CSVHeader` 的 36 列与顺序，汇总每桶一行；UTF-8、无 BOM、LF，另加公式注入防护；调用 CSV 不分页，按每页 200 条流式写出；凭据名称、Key 名称与主机取自导出时的配置。
- 账本中没有提示词或回答的文字，也没有 Gateway Key 文本；请求与回答只经可选的 [OTLP 导出](../../observability.md#otlp-导出)离开本机。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/ledger.ts](../../../packages/gateway/src/ledger.ts)、[gateway/agents.ts](../../../packages/gateway/src/agents.ts)、[store/model-plane-store.ts](../../../packages/store/src/storage/model-plane-store.ts)、[store/wal-checkpoints.ts](../../../packages/store/src/storage/wal-checkpoints.ts)、[daemon/model-plane-routes.ts](../../../packages/daemon/src/http/model-plane-routes.ts)、[daemon/usage-csv.ts](../../../packages/daemon/src/usage-csv.ts)、[console/usage-page.tsx](../../../packages/console/components/usage-page.tsx) |
| 测试 | [shared-gateway](../../../packages/gateway/test/shared-gateway.test.ts)、[shared-gateway-auto-groups](../../../packages/gateway/test/shared-gateway-auto-groups.test.ts)（会话键与 `agent`）、[daemon usage-csv](../../../packages/daemon/test/usage-csv.test.ts)；集成 [api-v1](../../../tests/integration/api-v1.test.ts)、[usage-csv](../../../tests/integration/usage-csv.test.ts)、[model-plane-store](../../../tests/integration/model-plane-store.test.ts)、[hh-cli](../../../tests/integration/hh-cli.test.ts)；性能 [tests/perf](../../../tests/perf/README.md#账本提交) |
| 决策 | [ADR 0025](../../decisions/0025-magpie-routing-parity.md)（`conversationKey`、`agent` 与迁移 5）、[ADR 0019 Session 的 Run 走共享网关](../../decisions/0019-session-runs-on-the-shared-gateway.md) |

## 已知限制与未验证

- `/api/v1/model-calls` 的响应 schema 还没有 `generation`，它只在账本记录与网关内可见。
- 不能按凭据、按失败或按文本过滤调用（只有 `--by credential` 的合计）；用量页只有表格，没有随时间的图表。
- 不记录客户端自己的推理强度、厂商的请求 ID 与转发的电脑，CSV 中对应的列为空；粘性只写在 `patches[]` 中；入站转换器自身丢弃的提示字段尚未记入 `unmapped[]`。
- 没有 `*/<model>` 价格或按模型作者的回退价格；只有美元。
- 汇总的“日”按 UTC，而 Key 预算的日、周、月按守护进程本地时区，两处看到的“今天”在非 UTC 时区不同。
- 2026-10-05 的测量中 200 条同时到达的突发提交 p99 约 5.4–5.6 ms，仍略高于 5 ms 的目标（[账本提交](../../../tests/perf/README.md#账本提交)）；Windows 未验证。

## 优化候选

- **现状**：调用只能按 Key、provider、模型、Agent 与 Session 过滤。**方向**：增加按凭据、按失败（状态或错误类别）与按文本的过滤，API、`hh usage` 与控制台同步。**依据**：对照表 Usage narrowed to one account 行为部分。
- **现状**：`groupBy=day` 只按 UTC。**方向**：增加按本地时区（或指定时区）分日，与 Key 预算的窗口一致。**依据**：阅读 [资源](../../model-plane-api.md#资源)的 usage 行与 [ADR 0031](../../decisions/0031-group-members-and-key-budgets.md) 本地窗口的观察。
- **现状**：调用接口的 schema 缺 `generation`。**方向**：补入 schema 与 SDK 类型。**依据**：[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)。
- **现状**：用量页没有图表。**方向**：按时间的用量与成本图。**依据**：对照表 Charts over time 行为部分。
- **现状**：经中转的模型没有价格时整批调用未定价。**方向**：增加 `*/<model>` 价格与按作者回退的价格，回退来源记在调用上。**依据**：对照表 Cost estimates 行为部分。
