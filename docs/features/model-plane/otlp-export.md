# OTLP 导出

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 导出器单元测试（配置校验与拒绝样例、属性、队列与重试、指标的边界与分点、内容的开关与拆分）、网关测试（内容的遮蔽、截断与交出时机，账本写失败时不交出）与经正式守护进程、共享网关、假 provider 与回环收集端的集成测试（span 属性与账本逐项一致，载荷中没有提示词、Key 与请求头秘密）；只对本机回环收集端验证，真实的 Jaeger、Grafana、Honeycomb 与 Langfuse 未验证；Windows 未验证 |
| 对照 Magpie | 相同（[Usage and observability](../../magpie-parity.md#usage-and-observability) 的 OTLP trace export 行与 metrics and bodies 行）；没有 `bodiesWhole` 与 `MAGPIE_OTEL_*` 式的环境变量覆盖 |
| 权威文档 | [OTLP 导出](../../observability.md#otlp-导出)、[配置参考的设置表](../../configuration.md#设置) |

## 用途

把每次模型调用作为一个 OpenTelemetry span 发给自己的收集端（本机 Jaeger、OpenTelemetry Collector、Grafana Cloud、Honeycomb、自己部署的 Langfuse），在已有的观测系统里看调用耗时、token、费用与错误；可选另发 GenAI 指标，以及经遮蔽的请求与回答。默认关闭。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 无 |
| 命令行 | `config.jsonc` 的 `otlp` 块（`hh config set otlp.endpoint <URL>` 等，下次 `hh serve` 生效）；`hh serve --otlp-config FILE`（JSON 文件整体代替配置文件中的值） |
| HTTP | 无管理接口；导出是守护进程发往 `<endpoint>/v1/traces` 与 `<endpoint>/v1/metrics` 的出站请求 |

## 已实现的能力

- 默认关闭：没有 `otlp` 配置时不创建导出器、不发任何请求，环境中的 `OTEL_EXPORTER_OTLP_ENDPOINT` 等标准变量也不会打开导出；配置无效时拒绝启动。
- 配置字段：`endpoint`（http 或 https，不含凭据、查询与片段；以 `/v1/traces` 或 `/v1/metrics` 结尾时去掉这一段）、`protocol`（只支持 `http/json`）、`headers`（字符串或秘密引用，启动时解析一次）、`resource`（覆盖 `service.name` 与 `service.version`）、`metrics`、`bodies`。
- 每次进入网关的模型调用一个 SERVER span，名称为 `chat <请求模型>`（Gemini 入口为 `generate_content`），时间取账本的开始时间与耗时，失败时状态为 ERROR；span 在 `model.call` 账本记录提交之后才进入队列，账本写失败的调用不导出。
- 属性按 GenAI 语义约定（`gen_ai.operation.name`、`gen_ai.provider.name`、请求与响应模型、`gen_ai.conversation.id`、结束原因、输入与输出 token），另有 `hh.` 前缀的字段：Model Ref、provider、路由组、入站与上游协议、是否流式、直通或转换、Key ID 与作用域种类、Session、Run 与 generation、缓存与推理 token、费用与价格来源、首字节与首内容时间、尝试次数、错误来源、拒绝原因。上游未回报用量时不写 token 属性，不写 0。
- 不开 `bodies` 时不导出提示词、回答、推理内容与工具参数；任何设置下都不导出账本中的错误文本、凭据与请求头的值、Gateway Key 文本与名称、provider 凭据 ID。
- `metrics: true`：另发与 Magpie 相同的两个 delta 直方图 `gen_ai.client.operation.duration`（秒）与 `gen_ai.client.token.usage`（输入与输出各一个点），数据点只带白名单属性，`gen_ai.request.model` 用网关解析出的 Model Ref 或路由组（没有解析出时为 `unknown`），序列数量有限；与 span 同队列、同批次、同重试。
- `bodies: true`：每个 span 多 `langfuse.observation.input` 与 `langfuse.observation.output`，流式回答拼接各事件中的文字；两者先经出站脱敏的同一套规则遮蔽（已知凭据、订阅令牌、Gateway Key、管理令牌与用户规则），出站脱敏关闭时也遮蔽，各截到 256 KiB；队列中的内容至多 128 MiB，超出时该 span 不带内容并计入 `bodiesDropped`，单个请求的内容超过 16 MiB 时拆分。
- 不影响模型调用：队列至多 2,048 个 span，每批 512 个、每 5 秒刷新，单次请求 10 秒超时；429、502、503、504、超时与网络错误按 `Retry-After`（或 1 s、2 s）重试至多 2 次；队列满或已停止时丢弃并计数。
- 停止：守护进程在网关提交完最后一批账本记录之后导出剩余队列，最多等 3 秒；`gateway.log` 记 `otlp.dropped`、`otlp.export_failed` 与 `otlp.stop`（导出、丢弃、失败、重试与未带内容的累计数）。
- 导出请求经守护进程的出站代理发送（[出站代理与网络](outbound-network.md)）。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | 导出器 [otlp-export.ts](../../../packages/daemon/src/otlp-export.ts)、请求与回答的采集与遮蔽 [bodies.ts](../../../packages/gateway/src/bodies.ts)、配置解析 [config-file.ts](../../../packages/daemon/src/config-file.ts) |
| 测试 | [otlp-export.test.ts（单元）](../../../packages/daemon/test/otlp-export.test.ts)、[shared-gateway-bodies.test.ts](../../../packages/gateway/test/shared-gateway-bodies.test.ts)、[otlp-export.test.ts（集成）](../../../tests/integration/otlp-export.test.ts)、经代理导出 [outbound-proxy.test.ts](../../../tests/integration/outbound-proxy.test.ts) |
| 决策 | 无独立 ADR；设计见 [08 可靠性与可观测性第 5 节](../../proposals/oss/08-reliability-observability.md#5-追踪)，与设计的差异记在 [OTLP 导出](../../observability.md#otlp-导出) |

## 已知限制与未验证

- 只支持 `http/json`；`http/protobuf` 需要 protobuf 编码依赖，目前明确拒绝。
- span 都是根 span，还没有 Run 与 attempt 的 span 作父子；只导出模型调用；没有语义约定版本选择与采样。
- 没有 `MAGPIE_OTEL_*` 式的环境变量覆盖，没有不截断内容的 `bodiesWhole`；指标按导出批次汇总，Magpie 按刷新周期。
- 配置只在启动时读取；控制台与管理接口看不到导出状态，导出、丢弃与失败的计数只在 `gateway.log` 中，累计数在停止时才写出（阅读 [otlp-export.ts](../../../packages/daemon/src/otlp-export.ts) 与观测文档的观察）。
- `bodies` 的遮蔽只覆盖 HarnessHub 知道的秘密与用户规则，不能识别其他敏感内容。
- 只对回环收集端验证；文档中的 Honeycomb、Grafana Cloud 与 Langfuse 示例未在真实后端上验证；Windows 未验证。

## 优化候选

- **现状**：每次调用都是根 span。**方向**：加入 Run 与 attempt 的 span，让一次 Run 的调用与重试成为一棵树。**依据**：[OTLP 导出](../../observability.md#otlp-导出) 中与 08 第 5 节的差异。
- **现状**：导出是否正常只能翻 `gateway.log`。**方向**：在 `GET /api/v1/system/info` 或控制台设置页显示导出器状态与计数（导出、丢弃、失败、未带内容）。**依据**：阅读代码的观察；控制台与管理接口中没有 OTLP 相关的入口。
- **现状**：只有 `http/json`，没有采样。**方向**：按需加入 `http/protobuf` 与采样率设置。**依据**：[OTLP 导出](../../observability.md#otlp-导出) 的协议说明与“尚无约定版本选择与采样”。
- **现状**：只对回环收集端验证。**方向**：用真实的 Langfuse、Grafana 或 Honeycomb 跑一次带 `metrics` 与 `bodies` 的导出并记录。**依据**：[观测文档的验证](../../observability.md#验证)（“未验证：真实的 Jaeger、Grafana、Honeycomb 与 Langfuse 后端”）、[对照表](../../magpie-parity.md) 开头的 Not verified 说明。
