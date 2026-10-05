# 网关与协议转换

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（回环假上游）、经正式守护进程的集成测试与协议一致性套件（`openai`、`@anthropic-ai/sdk`、`@google/genai` 三个官方 SDK 经 `hh serve` 访问白名单模式的假上游，16 个方向共 508 例），在 macOS arm64 本机通过；真实 provider 只有 DeepSeek（2026-10-05：四种入站协议 × 流式与非流式 × 直通与转换共 16 种组合，另有 5 个真实 Agent）；Windows 未验证 |
| 对照 Magpie | 部分：统一入口、`count_tokens`、上下文超长改写为相同；直通与转换、`/v1/models`、Codex 的 ChatGPT 透传与首内容前扣留为部分；按协议保活为有意不同；视频生成未覆盖（[Gateway and protocols](../../magpie-parity.md#gateway-and-protocols)、[Routing](../../magpie-parity.md#routing-route-groups-and-rules) 的扣留一行） |
| 权威文档 | [共享网关](../../model-gateway.md#共享网关)、[直通与转换](../../model-gateway.md#直通与转换)、[响应头、保活与空闲超时](../../model-gateway.md#响应头保活与空闲超时)、[错误映射](../../model-gateway.md#错误映射)、[Codex 透传](../../model-gateway.md#codex-透传)、[资源上限](../../model-gateway.md#资源上限) |

## 用途

说 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Gemini 协议的客户端（Claude Code、Codex、Gemini CLI、官方 SDK、脚本）都指向守护进程的同一个端口，用 `provider/model`、路由组或裸模型名请求模型。网关按 provider 声明的端点决定原样直通还是转换协议，再按客户端自己的协议返回流、错误与用量，用户不必为每个客户端找一个说同样协议的上游。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 › 通用：网关基址（只读）；用量：最近调用的结束原因与错误类别 |
| 命令行 | `hh status` 打印网关基址；`hh key create --name N --allow REF` 为脚本签发 Gateway Key；`hh wire <agent>` 为 Agent 写入地址与 Key |
| HTTP | `POST /v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1beta/models/{m}:generateContent`、`:streamGenerateContent`；`GET /v1/models`、`/v1beta/models`；回环上的 `/backend-api/codex/…`；`GET /api/v1/system/info` 的 `gateway` |

## 已实现的能力

- 网关挂在守护进程的监听器上（默认 `127.0.0.1:3180`），先于管理接口分派；OpenAI 与 Anthropic 路径的 `/v1` 可省略，Gemini 路径另接受 `/v1` 与 `/v1alpha`；不规范的路径在分派前以 400 `path_not_canonical` 拒绝。
- 每次调用都要 Gateway Key（`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`，Gemini 另可 `?key=`）；带 `Origin` 头、或 `Host` 既不是回环名称也不是 `publicBaseUrl` 主机的请求 403。Key 的作用域、白名单与额度见 [鉴权与拒绝](../../model-gateway.md#鉴权与拒绝)。
- 直通：provider 声明了与入站相同的端点、不是 `translateOnly`、凭据对该端点有效时，只原位改写请求体顶层的 `model`，换上 provider 的凭据与 header，转发 `anthropic-version`、`anthropic-beta`、`openai-beta` 与 `user-agent`；响应按完整的 SSE 事件或 Gemini 数组元素原样转发，旁路解析 usage、实际模型与结束原因。
- 转换：以 Chat 形态为枢纽，四种入站协议都能转到 provider 的 Chat、Anthropic、Responses 或 Gemini 端点（有 Chat 端点时优先），上游总是流式请求；工具调用、工具错误、图片、推理请求与 JSON 输出按目标协议编码，无法携带的字段与响应块记入账本的 `unmapped[]`。
- 非流式的入站请求同样以流式访问上游，读完后按入站协议返回一个完整响应。
- 响应头在第一个有效上游数据块时提交；Gemini 回答自请求起 45 秒（`headerCommitMs`）仍未提交且上游已 2xx 应答时先提交 200 头，避免 Gemini 客户端 60 秒拿不到响应头就重发。
- 保活按入站协议发送该协议合法的空事件，不用 SSE 注释：Chat 为空 delta，Responses 为 `response.in_progress`，Anthropic 为 `ping`，Gemini 为空 candidate；客户端静默 10 秒后发出，直通流的保活由网关合成。
- 空闲超时：等待上游响应头或两次上游数据事件之间超过 300 秒（注释与空行不算数据）时，响应头未提交返回 504 `upstream_timeout`，已提交则在流内报告。
- 首字节前故障转移：还有其他候选或剩余重试时，流式输出在第一个内容事件之前最多扣留 15 秒或 1 MiB，期间的失败（含流内错误）转移到下一个候选；首字节送达后的失败只在流内报告，不重试、不转移。失败类别、休息与重试见 [路由、重试与熔断](../../model-gateway.md#路由重试与熔断)。
- 推理回填：provider 声明 `requiresReasoningReplay`（DeepSeek 一类）或上游是 Anthropic 时，按 Gateway Key 缓存推理文本与签名并在下一轮补回；Responses 的推理项与 Gemini 的 `thoughtSignature` 同样缓存，只回给签发它的 provider。
- 媒体：转换路径上模型元数据声明了图片输入时图片作为 Chat `image_url` 保留，否则替换为文字占位或交给 [视觉兜底](../../gateway-features.md#视觉兜底)；`/v1/images/*` 见 [图像生成](../../gateway-features.md#图像生成)。
- 错误：上游 HTTP 错误保留状态码，按入站协议的错误格式重写并脱敏，带 `x-hh-error-source: upstream`；网关自己的拒绝带 `x-hh-error-source: gateway`。上下文超长改写为各客户端能识别的形式（Anthropic 的 `prompt is too long`、Codex 流内的 `response.failed`），让 Agent 自行压缩。
- `GET /v1/models`、`/v1/models/{ref}` 与 `/v1beta/models` 只列出该 Key 允许、且在 provider `expose` 中的模型与路由组，带 `context_window`、`max_output_tokens`、推理档位、输入模态与 `native_endpoints`；不访问上游，不写账本。
- `count_tokens`：有直通 Anthropic 端点的候选时转发给上游，否则本地估算，响应头 `x-hh-token-count` 标明 `upstream` 或 `estimated`；Gemini `countTokens` 总是估算。
- Codex 透传：以 ChatGPT 登录的 Codex 把基址设为 `<网关>/backend-api/codex` 后，请求原样转发到 `chatgpt.com/backend-api/codex`（只在回环），模型调用记账本（provider 为虚拟的 `chatgpt-subscription`）；基址路径中带 agent Key 时，名称带 `/` 的模型由 HarnessHub 服务，模型列表合并（[ADR 0030](../../decisions/0030-codex-chatgpt-mode-models.md)）。
- 先提交后发布：流的终止事件与非流式响应体在 `model.call` 账本记录提交之后才写出，提交失败为 503 `evidence_unavailable`（[账本](../../model-gateway.md#账本)）。
- 请求体、响应体、超时、保活与每个凭据的并发等上限集中在 `limits.ts`，可经 `config.jsonc` 的 `gateway.limits` 覆盖，越界值拒绝启动。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [server.ts](../../../packages/gateway/src/server.ts)（处理函数与分派）、[call.ts](../../../packages/gateway/src/call.ts)（候选尝试、首内容前扣留与账本提交）、[passthrough.ts](../../../packages/gateway/src/passthrough.ts)、[encode.ts](../../../packages/gateway/src/encode.ts)、[decode.ts](../../../packages/gateway/src/decode.ts)、入站转换 [chat.ts](../../../packages/gateway/src/chat.ts)、[responses.ts](../../../packages/gateway/src/responses.ts)、[anthropic.ts](../../../packages/gateway/src/anthropic.ts)、[google.ts](../../../packages/gateway/src/google.ts)、[keepalive.ts](../../../packages/gateway/src/keepalive.ts)、[reasoning.ts](../../../packages/gateway/src/reasoning.ts)、[count.ts](../../../packages/gateway/src/count.ts)、[codex.ts](../../../packages/gateway/src/codex.ts)、[limits.ts](../../../packages/gateway/src/limits.ts)；挂载 [model-gateway-mount.ts](../../../packages/daemon/src/http/model-gateway-mount.ts) |
| 测试 | [shared-gateway.test.ts](../../../packages/gateway/test/shared-gateway.test.ts)、[shared-gateway-matrix.test.ts](../../../packages/gateway/test/shared-gateway-matrix.test.ts)、[model-gateway-keepalive.test.ts](../../../packages/gateway/test/model-gateway-keepalive.test.ts)、[shared-gateway-codex.test.ts](../../../packages/gateway/test/shared-gateway-codex.test.ts)、[协议套件](../../../conformance/README.md#协议套件)、[shared-gateway-fake-provider.test.ts](../../../tests/integration/shared-gateway-fake-provider.test.ts)、[codex-chatgpt-key.test.ts](../../../tests/integration/codex-chatgpt-key.test.ts)、[真实 provider 记录](../../compatibility.md#真实-providerdeepseek2026-10-05) |
| 决策 | [ADR 0013 统一模型网关](../../decisions/0013-unified-model-gateway.md)、[ADR 0019 Session Run 使用共享网关](../../decisions/0019-session-runs-on-the-shared-gateway.md)、[ADR 0025 对齐 Magpie 的路由与 Codex 透传](../../decisions/0025-magpie-routing-parity.md)、[ADR 0029 协议一致性套件](../../decisions/0029-protocol-suite.md) |

## 已知限制与未验证

- 转换经过 Chat 枢纽，会丢失 Chat 表达不了的区别，例如 Anthropic 的 `stop_sequence` 与 `end_turn` 都成为 `stop`。
- 首内容前只扣留 15 秒或 1 MiB，没有 Magpie 对 ChatGPT `safety_buffering` 与只有推理的流的 4 分钟扣留；推理已送达客户端后出现的拒绝不再转移。
- 声明了自己 openai-completions provider 的引擎与配置检查仍走 Worker 内的 Session 网关：它默认去掉一批 OpenAI 专有参数、把 `json_schema` 降级，与共享网关的规则不同，也不经出站代理。
- 未实现：provider 声明的请求体上限与 `onUnsupportedMedia`、转换到 Gemini 时的图片 URL、Anthropic 的结构化输出（beta）、Codex 透传的 WebSocket 传输；入站转换器自身丢弃的提示字段尚未记入 `unmapped[]`。
- 推理与签名缓存是进程内的 Map（[call.ts](../../../packages/gateway/src/call.ts) 的 `ReasoningCaches`），守护进程重启后清空；对 Anthropic 上游，进行中的工具轮因此可能找不到签名而不开启 `thinking`（阅读代码的观察）。
- 未实测：Anthropic `ping` 对 Claude Code 看门狗的效果、Gemini 流式 JSON 数组的保活形式；以 ChatGPT 登录的 Codex；DeepSeek 以外的真实 provider；Windows。

## 优化候选

- **现状**：Worker 内的 Session 网关与共享网关并存，规范化规则不同且不经出站代理。**方向**：把剩下的两类调用迁到共享网关后删除 Worker 网关。**依据**：[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)、[ADR 0035](../../decisions/0035-outbound-proxy.md) 的重新评估条件。
- **现状**：协议一致性套件只在 macOS arm64 本机记录过结果，没有 Vercel AI SDK、Python SDK、真实 provider 抽样与直通的逐字节语料。**方向**：补齐这些客户端与语料，分平台记录。**依据**：[TODO.md](../../../TODO.md) 未勾选的“M1 网关验收：协议一致性套件与性能基准”。
- **现状**：`/v1/models` 没有 `max_input_tokens`、`?format=text` 与图像、视频条目。**方向**：按 Magpie 的列表补齐字段与格式。**依据**：[对照表](../../magpie-parity.md#gateway-and-protocols) 的 `/v1/models` 行（partial）。
- **现状**：转换到 Responses 上游时，第一次请求没有推理信号就不请求 `reasoning.encrypted_content`，放回的推理项只有 `id` 与摘要，`store: false` 的真实 OpenAI 可能拒绝。**方向**：用真实 OpenAI 验证，需要时总是请求加密推理。**依据**：[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)。
- **现状**：Codex 透传不处理 WebSocket，ChatGPT 的列表取不到时不回落到 Codex 缓存的列表。**方向**：补 WebSocket 转发与列表回落。**依据**：[Codex 透传](../../model-gateway.md#codex-透传) 的“未实现”、对照表的 Codex 一行（partial）。
- **现状**：推理与签名缓存、粘性记录都只在内存中，重启后丢失。**方向**：与粘性记录的持久化一起设计可恢复的缓存。**依据**：阅读代码的观察；[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项) 中“粘性记录的持久化”。
