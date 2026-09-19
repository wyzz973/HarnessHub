# 统一模型网关

统一模型网关让所有引擎只经过同一个 Session 私有入口访问 HarnessHub 配置的唯一模型。引擎按自己的原生协议调用网关；网关把每次调用转换为一次流式 OpenAI Chat Completions 上游请求，再按原协议返回。设计取舍见 [ADR 0013](decisions/0013-unified-model-gateway.md)，它扩展了 [ADR 0011](decisions/0011-chat-completions-bridge.md) 的 Codex/Gemini 协议桥。

实现位于 [gateway.ts](../src/drivers/chat-completions/gateway.ts)，协议转换分别在同目录的 `chat.ts`、`responses.ts`、`anthropic.ts`、`google.ts`，上游请求与流解析在 `upstream.ts`，推理缓存在 `reasoning.ts`。本页描述当前代码行为；哪些引擎、由谁启动网关由 Worker 配置准备决定，不在本页。

## 生命周期与所有权

- `startModelGateway(options)` 在 `127.0.0.1` 随机端口监听，并生成 64 位十六进制随机令牌。返回的 `baseUrl` 形如 `http://127.0.0.1:<port>`，不含 `/v1`。
- 调用方拥有网关，必须 `await close()`，探测失败时也一样。`close()` 幂等：停止监听、结束当前 Run、关闭连接。
- `beginRun(signal)` 开启唯一的 Run 作用域并清空 `runErrors()`；已有活动 Run 或网关已关闭时抛错。`signal` 中止时，本 Run 的上游请求全部取消，引擎连接被断开。
- `endRun()` 取消本 Run 尚未结束的调用，并等待它们全部结束、调用记录全部发出后才返回；可重复调用。
- 没有活动 Run、Run 已取消或网关正在关闭时，模型调用返回 409，不访问上游，也不产生调用记录。`GET /v1/models` 与 `count_tokens` 不需要 Run，也不访问上游。

`startModelBridge` 仍作为兼容入口保留：它以配置模型作为 alias 启动同一个网关，并按旧调用方的约定返回带 `/v1`（Responses）或不带路径（Google）的地址。

## 入站端点与鉴权

| 协议 | 方法与路径 | 流式形式 |
|---|---|---|
| OpenAI Chat | `POST /v1/chat/completions` | `chat.completion.chunk` SSE，以 `data: [DONE]` 结束 |
| OpenAI Responses | `POST /v1/responses` | 命名事件 SSE，带递增 `sequence_number` |
| Anthropic Messages | `POST /v1/messages`；`POST /v1/messages/count_tokens` | 命名事件 SSE；计数接口返回本地估算的 `{input_tokens}` |
| Google | `POST /v1beta/models/{m}:generateContent`、`:streamGenerateContent` | `?alt=sse` 时为 SSE，否则为流式 JSON 数组 |
| 模型列表 | `GET /v1/models`、`GET /v1/models/{id}` | 返回 alias，配置时附 `context_window`、`context_length`、`max_model_len`、`max_output_tokens` |

OpenAI 与 Anthropic 路径的 `/v1` 前缀可省略；Google 路径也接受 `/v1` 与 `/v1alpha`。查询字符串除 `key` 与 `alt` 外被忽略（例如 Claude Code 的 `?beta=true`）。

鉴权接受 `Authorization: Bearer <token>`、`x-api-key`、`x-goog-api-key` 或查询参数 `key`，按常数时间比较。令牌错误返回 401，带 `Origin` 头的浏览器请求返回 403，未知路径返回 404；这些错误都使用该路径所属协议的错误格式。

## 上游请求

每次模型调用只发一个上游请求：`POST ${upstream.baseUrl}/chat/completions`（合并重复斜杠），`stream: true`，`model` 固定为 `options.model`，引擎请求的模型名只写入调用记录。请求带 `content-type: application/json`、`accept: text/event-stream`，有 `apiKey` 时带 `Authorization: Bearer <apiKey>`，最后应用 `upstream.headers`（同名头由它覆盖）。上游重定向一律拒绝。

请求体规范化规则：

- 默认去掉 `store`、`metadata`、`service_tier`、`prediction`、`modalities`、`audio`、`web_search_options`、`user`，以及引擎的 `stream_options`；最后去掉 `compatibility.dropParameters`（`model`、`messages`、`stream` 不可被去掉）。
- 没有 tools 或 tools 为空时，同时去掉 `tool_choice` 和 `parallel_tool_calls`。
- `developer` 转为 `system`；所有 system 消息按原顺序以空行连接，合并为开头的一条。全是文本分片的 content 以换行连接为字符串；含非文本分片的 Chat content 原样转发，由上游决定是否接受。
- 输出上限取 `max_completion_tokens`，否则取 `max_tokens`，只写入 `compatibility.maxTokensField` 指定的字段并删除另一个；配置了 `maxOutputTokens` 时取两者较小值。引擎没有给上限时不添加。
- 只有 `compatibility.includeUsage` 为 true 时才发送 `stream_options: {include_usage: true}`。

| `compatibility` 字段 | 默认值 | 作用 |
|---|---|---|
| `includeUsage` | `false` | 是否请求上游在流末尾返回 usage |
| `dropParameters` | 空 | 追加去掉的顶层参数 |
| `maxTokensField` | `max_tokens` | 输出上限写入的字段，另一值为 `max_completion_tokens` |
| `reasoning` | `passthrough` | `strip` 时推理内容既不转发给引擎，也不回填给上游 |
| `images` | `placeholder` | Chat 消息中的 `image_url` 替换为文字占位；`passthrough` 时原样转发给支持视觉的上游 |

`contextWindow` 目前只用于模型列表元数据，网关不会据此截断请求。

## 宽松解析与完成判定

- `choices`、`delta`、`index`、`id`、工具名为 null 或缺失时视为缺省；只处理 index 为 0（或缺失）的 choice。
- SSE 接受 `\r\n`、`\r`、`\n` 换行与注释行；流末尾缺少空行时仍处理最后一个事件；`[DONE]` 之后的数据被忽略。上游返回 `application/json` 时按一个完整 completion 解析。
- 缺少 `[DONE]` 或 `finish_reason` 时，只要 HTTP 响应体正常结束就视为完成；连接在响应体完成前断开（例如 chunked 编码未结束）按上游失败处理。
- 同一 index 的工具名或 id 重复发送完整值时不拼接；名称分片只在未开始输出时累加。缺少 index 时，新 id 或新工具名开始下一次调用，否则延续当前调用。缺少 id 时生成 `call_<实例随机前缀><序号>`，在一个网关实例内唯一。无参工具的空参数串变为 `{}`。
- usage 字段缺失或类型错误时只省略该字段；缺少 `total_tokens` 时用输入加输出补齐。支持 `prompt_tokens`/`completion_tokens`、`input_tokens`/`output_tokens`、`reasoning_tokens` 与缓存命中字段。
- 重复的 `finish_reason` 以最后一次为准。规范化：有工具调用时为 `tool_calls`；但 `length` 截断且有工具参数不是完整 JSON 对象时保持 `length`，避免把残缺调用交给引擎执行；无工具且没有原因时为 `stop`；`length` 与其他原因保持不变。
- 上游在流中返回 `{"error": ...}` 视为上游错误；数值 `code` 或 `status` 在 400–599 时作为状态码，否则为 502。

## 各协议输出

| 协议 | 推理内容 | 文本与工具 | 结束 |
|---|---|---|---|
| Chat | 与上游相同的字段名（`reasoning_content` 或 `reasoning`） | 首块含 role；工具调用首块带 index、id、name 与空参数，其后为参数增量 | 带 `finish_reason` 的空 delta，有 usage 时同块携带（与 DeepSeek 相同）；引擎请求 `include_usage` 时再发 `choices: []` 的 usage 块 |
| Responses | reasoning 项：`summary_text` 为推理文本，`encrypted_content` 为 `hh-r1.` 加 base64url 编码的原文 | message 项与 `output_text.delta`；`function_call` 项与参数增量；custom 工具在结束时整体发出 `input` | `response.completed` 带 usage；`length` 时为 `response.incomplete`，reason 为 `max_output_tokens` |
| Anthropic | `thinking` 块，结束前发 `signature_delta`（`hh-sig.` 加文本哈希） | `text` 块；`tool_use` 块加 `input_json_delta`，同一时刻只开一个块 | `message_delta` 带 `stop_reason`（`end_turn`、`tool_use`、`max_tokens`、`refusal`）和 usage，然后 `message_stop` |
| Google | `thought: true` 的 text part；第一个 functionCall 的 `thoughtSignature` 携带 `hh-r1.` 编码的推理 | text part；functionCall 在最后一块中完整发出 | `finishReason`（`STOP`、`MAX_TOKENS`、`SAFETY`、`OTHER`）与 `usageMetadata` |

非流式入站请求同样以流式访问上游，读完后按该协议返回一个完整响应。Anthropic 的 `message_start` 需要输入 token 数，此时使用本地估算；`message_delta` 在上游报告 usage 时改用实际值，并把缓存命中换算为 `cache_read_input_tokens`。Google 请求显式设置 `thinkingConfig.includeThoughts: false` 时不发送 thought part。

流式响应在收到第一个有效上游数据块时才发送 HTTP 头，因此上游的 HTTP 错误和首块即出错都能以正确状态码返回；此后的失败只能在流内报告。

## 推理内容与回填

2026-09-19 用 DeepSeek 替身实测：推理模式下，工具调用后续请求中 assistant 消息若不带回 `reasoning_content`，上游返回 400。网关因此默认在同一网关实例（一个 Session）内缓存每次成功调用的推理文本，并在引擎回传历史时补回：

- 缓存键为工具调用 id、工具名加规范化参数的哈希、助手文本的哈希。查找依次按 id、调用签名、文本进行；缓存为 LRU，上限 256 条、4 MiB，单条超过上限不缓存。
- 引擎自己回传的推理优先：Chat 消息的 `reasoning_content`/`reasoning`、Responses 的 reasoning 项（解码 `encrypted_content`，否则取 summary 或 content 文本）、Anthropic `thinking` 块、Google thought part 与网关编码的 `thoughtSignature`。其他来源的加密推理、签名和 `redacted_thinking` 无法转换，被忽略而不是报错。
- Gemini CLI 会把 functionCall id 改写为 `<工具名>__<id>`，网关转换历史时去掉这个前缀，恢复上游原 id。
- 回填写入上游最近一次使用的字段名，默认 `reasoning_content`；同一消息里的另一个字段会被移除。
- `compatibility.reasoning: strip` 时，推理内容不转发给引擎、不写入缓存，并从引擎回传的历史中删除。对 DeepSeek 这类要求回传的上游，这会导致工具调用后续请求失败，只应用于拒绝接收推理字段的上游。

`hh-r1.` 是编码而不是加密，只携带引擎已经收到的推理文本，以便无状态的引擎在新 Session 中也能带回。

## 错误映射

- 上游 HTTP 状态 ≥ 400 时保持原状态码，读取至多 64 KiB 错误体，提取 `error.message`、`message`、`detail` 等文本，按入站协议格式返回：Chat/Responses 为 `{error:{message,type,param,code}}`，Anthropic 为 `{type:"error",error:{type,message}}`，Google 为 `{error:{code,message,status}}`。
- 所有公开消息都经过脱敏与截断：删除 apiKey、网关令牌和 `upstream.headers` 的值，`Bearer`/`Basic` 凭据、`sk-` 前缀串、`api_key=…`/`token: …` 类键值，以及 40 个字符以上的不透明串；折叠空白后截断到 500 个字符。
- 上下文超长（错误码 `context_length_exceeded`，或消息包含 context length、context window、maximum context、too many tokens、prompt is too long、input token count 等）统一返回 400：Chat/Responses 的 `code` 为 `context_length_exceeded`；Anthropic 为 `invalid_request_error`，消息以 `prompt is too long` 开头，能识别数值时写成 `prompt is too long: <实际> tokens > <上限> maximum`；Google 为 `INVALID_ARGUMENT`。Codex 0.153.4 只从流内 `response.failed` 识别上下文超限，所以流式 Responses 请求改为返回 200 SSE，内含 `response.failed`，`code` 为 `context_length_exceeded`。
- vLLM 形式的报错中若提示词本身未超长、只是输出上限过大（`(N in the messages, M in the completion)` 且 N 小于上限），不视为上下文超长，避免引擎反复压缩。
- 其他情况：网络失败或拒绝重定向为 502 `upstream_unreachable`；等待上游响应头或两次数据之间超过 300 秒为 504 `upstream_timeout`；上游响应超过 8 MiB 为 502 `response_too_large`；上游格式错误为 502；入站请求超过 8 MiB 为 413，非 UTF-8 或非 JSON 为 400，带压缩编码为 415；排队已满为 429 `busy`；无法转换的输入为 400。
- 流已开始后的失败在流内报告：Chat 为 `data: {"error":...}` 且不发 `[DONE]`；Responses 为 `response.failed`（上下文 `context_length_exceeded`、429 为 `rate_limit_exceeded`、5xx 为 `server_error`、其他 `invalid_prompt`）；Anthropic 为 `event: error`；Google 为带 `error` 对象的数据块。

## 调用记录

每次进入 Run 的模型调用在引擎响应结束后调用一次 `onCall`，记录 `ModelCallRecord`：协议、是否流式、引擎请求的模型名（最多 256 字符）、上游模型、状态、耗时、规范化的结束原因、usage（输入、输出、总计、推理，只含上游报告的值）、工具调用数和脱敏后的错误。记录不含提示词、输出文本或秘密。`onCall` 抛出的异常被忽略。

`status` 是返回给引擎的 HTTP 状态；流开始后才失败时，记录该失败本应对应的状态；上下文超长记为 400。引擎断开或 Run 取消的调用记为 499、错误码 `cancelled`。`runErrors()` 返回当前 Run 中 `ok` 为 false 且不是 `cancelled` 的记录副本，按完成先后排列；`endRun()` 之后仍可读取，下一次 `beginRun()` 清空。

## 资源限制

| 项目 | 值 |
|---|---|
| 入站请求体 | 8 MiB |
| 上游响应体 | 8 MiB |
| 上游空闲超时（等待响应头或两次数据之间） | 300 秒 |
| 每个网关（Session）同时进行的上游请求 | 4 个；其余按到达顺序等待，最多 32 个，再多返回 429 |
| 入站请求头 / 请求体接收时限 | 10 秒 / 60 秒 |
| 推理缓存 | 256 条、4 MiB |

排队中的调用在引擎断开或 Run 取消时离开队列。限制值在 [gateway.ts](../src/drivers/chat-completions/gateway.ts) 的 `DEFAULT_GATEWAY_LIMITS` 中集中定义。

## 媒体内容

公司模型可能不支持图片。会话历史里一旦出现图片（例如 Claude Code 读取截图、Codex `view_image`），如果直接拒绝，同一 Session 之后的每次请求都会失败。因此网关把各协议中的图片、文档、音频、文件统一替换为 `[... omitted: the HarnessHub model gateway forwards text only]` 文字占位，任务可以继续。上游模型支持视觉时，可以设置 `compatibility.images: passthrough`，保留 Chat 请求中的 `image_url`；其他三种入站协议的媒体目前仍替换为占位文字（2026-09-19 决定，见 [ADR 0013](decisions/0013-unified-model-gateway.md)）。

## 转换范围与明确限制

| 协议 | 转换 | 忽略 | 明确拒绝（400） |
|---|---|---|---|
| Chat | 原样转发，经上面的规范化；`image_url` 按 `images` 选项处理，音频、文件等其他媒体分片替换为文字占位 | 引擎的 `stream_options` | `n` 大于 1 |
| Responses | instructions、字符串或数组 input、message、function/custom/namespace 工具及其调用与输出、`additional_tools` 项、reasoning 项、`tool_choice`、`parallel_tool_calls`、temperature、top_p、`max_output_tokens`、`text.format` 的 JSON 输出 | `reasoning`、`include`、`store`、`stream_options`、`service_tier`、`prompt_cache_key`、`client_metadata`、`metadata`、`user`、`truncation`、`top_logprobs`、`max_tool_calls` 等提示字段 | 未知顶层字段、`previous_response_id`、`conversation`、存储的 `prompt`、`background`、托管工具（含 web_search、tool_search）、其他 input 项类型；图片/文件/音频输入替换为文字占位，不再拒绝 |
| Anthropic | 字符串或文本块 system、`messages` 中的 system 角色文本消息（Claude Code 2.1.2xx 以此发送环境信息）、text/tool_use/tool_result/thinking 块、客户端工具（`input_schema`→`parameters`）、`tool_choice`（auto/any/tool/none，`disable_parallel_tool_use`）、`max_tokens`、`stop_sequences`、temperature、top_p、`output_format` 的 JSON Schema | `thinking` 参数、`metadata`、`top_k`、`service_tier`、`cache_control`、`redacted_thinking`，以及 `context_management` 等其他顶层字段 | 其他块类型，服务端工具，`container`、`mcp_servers`；image、document 块（含工具结果中的）替换为文字占位，不再拒绝 |
| Google | systemInstruction、text、thought、functionCall、functionResponse（只含 `output` 字符串时直接作为工具结果）、functionDeclarations（`parameters` 类型转小写或 `parametersJsonSchema`）、toolConfig 与 `allowedFunctionNames`、temperature、topP、maxOutputTokens、stopSequences、presence/frequency penalty、seed、JSON 输出 | `safetySettings`、`labels`、`topK`、`thinkingConfig`（`includeThoughts: false` 除外）、其他生成提示 | 未知顶层字段、`cachedContent`、托管工具、非 TEXT 输出模态、`candidateCount` 大于 1；inlineData/fileData 与 functionResponse 的 parts 替换为文字占位，不再拒绝 |

Responses 和 Google 按固定客户端（Codex 0.153.4 的请求结构、@google/genai 的请求构造）的完整字段集检查顶层字段，因此未知字段会失败。Claude Code 为闭源且频繁增加 beta 字段，Anthropic 未知顶层字段被忽略，已知无法转换的语义仍明确失败。上游选择了请求中不存在的工具时，工具名原样返回，由引擎报告未知工具。Anthropic 非流式与 Google 输出需要工具参数为 JSON 对象，否则返回 502。Anthropic 流式输出要求上游顺序发送各工具参数，交错发送时在流内报错。

## 验证

单元测试从 HTTP 入口运行，使用本地假上游，不访问真实模型：

- [协议转换](../tests/unit/model-gateway.test.ts)：四种入站协议的流式与非流式输出、模型列表、`count_tokens`、四种鉴权方式与拒绝。
- [上游行为](../tests/unit/model-gateway-upstream.test.ts)：宽松解析各变体、结束原因、usage、工具分片、请求规范化与截断、错误状态透传与脱敏、上下文超长映射、502/504/重定向、大小限制与不支持输入。
- [推理与 Run](../tests/unit/model-gateway-runs.test.ts)：四种协议的推理回填（假上游在缺少 `reasoning_content` 时按 DeepSeek 实测返回 400）、strip 模式、缓存上限、Run 作用域、取消与断开、并发上限、调用记录与 `runErrors`。
- [兼容入口](../tests/unit/chat-completions.test.ts)：`startModelBridge`、Responses/Google 转换与配置准备。

```sh
pnpm build
node --test dist/tests/unit/model-gateway.test.js dist/tests/unit/model-gateway-upstream.test.js dist/tests/unit/model-gateway-runs.test.js dist/tests/unit/chat-completions.test.js
```

2026-09-19 在 macOS 上做过一次性冒烟：本机已安装的 Codex 0.144.5、Gemini CLI 0.38.2、Claude Code 2.1.278（均非固定版本）以隔离的配置目录连接网关与本地假上游，各完成一次推理、Shell 工具调用与后续回合，后续请求都带回了推理内容。该冒烟发现并修正了 Claude Code 在 `messages` 中发送 system 角色消息的问题；脚本未入库，不代替固定版本引擎的验收。

未验证：固定版本引擎（Codex 0.153.4、Gemini CLI 0.58.0、Claude Code 2.1.263）与 Chat 类引擎经网关运行；Windows；真实公司模型与真实 DeepSeek（回填行为只用假上游复现了实测错误）。这些须在引擎接入后按 ADR 0013 的集成与 Windows 验收另行记录。
