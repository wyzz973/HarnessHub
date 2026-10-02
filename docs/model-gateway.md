# 统一模型网关

统一模型网关让所有引擎只经过同一个 Session 私有入口访问 HarnessHub 配置的唯一模型。引擎按自己的原生协议调用网关；网关把每次调用转换为一次流式 OpenAI Chat Completions 上游请求，再按原协议返回。设计取舍见 [ADR 0013](decisions/0013-unified-model-gateway.md)，它扩展了 ADR 0011（归档于 `archive/competition` 分支的 `0011-chat-completions-bridge.md`） 的 Codex/Gemini 协议桥。

实现位于 [gateway.ts](../packages/gateway/src/gateway.ts)，协议转换分别在同目录的 `chat.ts`、`responses.ts`、`anthropic.ts`、`google.ts`，上游请求与流解析在 `upstream.ts`，推理缓存在 `reasoning.ts`。本页描述当前代码行为；哪些引擎、由谁启动网关由 Worker 配置准备决定，不在本页。守护进程内的多 provider 共享网关（[03 模型平面](proposals/oss/03-model-plane.md) 的 MVP）复用这些转换器与输出，见文末的[共享网关](#共享网关)一节；它尚未接入守护进程，Session 网关的行为不变。

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

- 默认去掉 `store`、`metadata`、`service_tier`、`prediction`、`modalities`、`audio`、`web_search_options`、`user`、`parallel_tool_calls`、`reasoning_effort`，以及引擎的 `stream_options`；最后去掉 `compatibility.dropParameters`（`model`、`messages`、`stream` 不可被去掉）。
- 没有 tools 或 tools 为空时，同时去掉 `tool_choice`。
- `response_format` 为 `json_schema` 时降级为 `{"type":"json_object"}`：很多兼容网关不支持 JSON Schema 输出，JSON 模式仍保证输出可解析，结构由引擎自行校验。
- 以上默认值面向严格的上游网关：2026-09-19 用只接受流式、拒绝 OpenAI 专有字段的模拟网关验证，Codex 在去掉 `parallel_tool_calls` 并降级 `json_schema` 后才全部通过；同日 Windows x64 真实模型验收中 Kimi 发送的 `reasoning_effort` 被严格网关拒绝，因此也默认去掉。引擎在同一回答中收到多个工具调用时仍能正确处理。
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

## 响应头、保活与空闲超时

- **响应头**：流式响应在收到第一个有效上游数据块时提交 200 响应头，并立即 flush 给引擎，不等第一个正文字节。此前上游的 HTTP 错误和首块即出错都以正确状态码返回；提交之后的失败只能在响应体内报告。Gemini 的回答在只有工具调用（参数扣留到最后一块）或推理被隐藏时可能长时间没有正文，flush 之前响应头要等到结束才发出，而 Gemini 客户端 60 秒拿不到响应头就放弃并重发。
- **Gemini 响应头提交期限**：`headerCommitMs`（45 秒）自引擎请求起计，但不早于上游以 2xx 应答；到期时还没有提交的 Gemini 回答即提交 200 头，之后按下面的规则保活。Gemini 客户端的 60 秒响应头超时从它发出请求时开始，所以在 Session 队列中等待空位和等待上游响应头的时间都计入期限；上游在期限之后才应答时，随应答立即提交。上游一直不应答（没有响应头）时不提交，仍按空闲超时返回 504。
- **Gemini 非流式** `generateContent` 不在首个上游块时提交，只在同一期限到期且上游已 2xx 应答时提交 200 与 `application/json` 头，此后以 JSON 允许的前导空白保活，最后写出完整响应。期限之前的失败保留真实状态码：`@google/genai` 只在 HTTP 状态非 OK 时抛错，提前提交会把可重试的 429、5xx 变成空回答。
- **保活**按入站协议决定，从不使用 SSE 注释（openai-node 丢弃注释，`@google/genai` 遇注释会卡住，Codex 只按事件计空闲）：

| 入站协议 | 保活 |
|---|---|
| OpenAI Chat | 同一 completion 的空 delta `chat.completion.chunk`：`choices: [{index: 0, delta: {}, finish_reason: null}]` |
| OpenAI Responses | 重发 `response.in_progress`，`sequence_number` 继续连续递增；尚未发出 `response.created` 时先发它。快照中的 `output` 总是 `[]`：openai-node 与 Codex（实测）忽略 `in_progress`，按它重建快照的客户端会丢掉已收到的输出项 |
| Anthropic | `event: ping`，数据为 `{"type":"ping"}`，与 Anthropic API 自己发送的相同。`@anthropic-ai/sdk` 的流迭代会跳过 `ping`，因此它只重置按字节计的超时；对 Claude Code 看门狗的效果未实测 |
| Gemini SSE | `{"candidates":[{"content":{"role":"model","parts":[]},"index":0}]}` |
| Gemini 流式 JSON 数组与非流式 | 换行符（JSON 允许的空白）。只有 Gemini SSE 的形态实测过（Gemini CLI 0.38.2）；数组形式未实测，按 `,\r\n` 切分元素的简单解析器可能不接受元素之间的空白 |

- **保活条件**：响应头已提交；自引擎上次收到字节以来上游仍有活动，包括被丢弃的推理、上游的空 delta、扣留中的工具参数，以及只有注释或空行的字节；引擎已静默不少于 `keepaliveGapMs`（默认 10 秒）；距上一个上游数据事件（或上游响应头）不超过 `maxNoDataMs`（默认 300 秒）。上游只发注释时，保活在 `maxNoDataMs` 后停止，由空闲超时结束调用；上游完全静默时不发保活。保活不是内容：引擎组装出的回答、usage 与调用记录（含 `firstByteMs`）与没有保活时相同。Chat、Responses 与 Anthropic 的非流式请求在结束前不提交响应头，因此没有保活。
- **空闲超时** `idleTimeoutMs`（300 秒）只被上游响应头与上游数据事件重置：SSE 的 `data` 行，或 JSON 响应中的非空白文本；注释与空行不重置。超时发生在响应头提交之前时返回 504 `upstream_timeout`，之后在响应体内报告。行为变化：负载高时在上游队列中只发 `: keep-alive` 注释的上游（例如 DeepSeek），这类调用现在 300 秒后以 504 结束，不再一直等待。
- 每次调用的空闲、响应头提交与保活计时器都属于该调用，在完成、失败、Run 取消或引擎断开时清除；最后的保活写入结束后才发出调用记录。

## 推理内容与回填

2026-09-19 用 DeepSeek 实测：推理模式下，工具调用后续请求中 assistant 消息若不带回 `reasoning_content`，上游返回 400。网关因此默认在同一网关实例（一个 Session）内缓存每次成功调用的推理文本，并在引擎回传历史时补回：

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
- 其他情况：网络失败或拒绝重定向为 502 `upstream_unreachable`；等待上游响应头或两次上游数据事件之间超过 300 秒为 504 `upstream_timeout`（SSE 注释与空行不算数据）；上游响应超过 8 MiB 为 502 `response_too_large`；上游格式错误为 502；入站请求超过 8 MiB 为 413，非 UTF-8 或非 JSON 为 400，带压缩编码为 415；排队已满为 429 `busy`；无法转换的输入为 400。
- 流已开始后的失败在流内报告：Chat 为 `data: {"error":...}` 且不发 `[DONE]`；Responses 为 `response.failed`（上下文 `context_length_exceeded`、429 为 `rate_limit_exceeded`、5xx 为 `server_error`、其他 `invalid_prompt`）；Anthropic 为 `event: error`；Google 为带 `error` 对象的数据块（流式 JSON 数组中为最后一个元素）。
- Gemini 非流式请求在提交期限到期、200 头已提交之后失败时，状态码已无法更改：响应体是 `{"error":{"code","message","status"}}`（前面可能有保活空白），HTTP 状态仍为 200。调用记录与流内失败相同，记录该失败本应对应的状态与错误码，并计入 `runErrors()`。

## 调用记录

每次进入 Run 的模型调用在引擎响应结束后调用一次 `onCall`，记录 `ModelCallRecord`：协议、是否流式、引擎请求的模型名（最多 256 字符）、上游模型、状态、耗时、规范化的结束原因、usage（输入、输出、总计、推理，只含上游报告的值）、工具调用数和脱敏后的错误。记录不含提示词、输出文本或秘密。`onCall` 抛出的异常被忽略。

`status` 是返回给引擎的 HTTP 状态；响应头提交后才失败时（流式，或已提交的 Gemini 非流式），记录该失败本应对应的状态；上下文超长记为 400。引擎断开或 Run 取消的调用记为 499、错误码 `cancelled`。`runErrors()` 返回当前 Run 中 `ok` 为 false 且不是 `cancelled` 的记录副本，按完成先后排列；`endRun()` 之后仍可读取，下一次 `beginRun()` 清空。

## 资源限制

| 项目 | 值 |
|---|---|
| 入站请求体 | 8 MiB |
| 上游响应体 | 8 MiB |
| 上游空闲超时（等待响应头，或两次上游数据事件之间；注释与空行不算） | 300 秒 |
| 保活间隔 `keepaliveGapMs`（引擎静默多久后发送保活） | 10 秒，可设 1–30 秒 |
| 停止保活 `maxNoDataMs`（距上一个上游数据事件） | 300 秒 |
| Gemini 响应头提交期限 `headerCommitMs`（自引擎请求起计，不早于上游 2xx 应答） | 45 秒，不超过 55 秒（Gemini 客户端 60 秒无响应头即放弃） |
| 每个网关（Session）同时进行的上游请求 | 4 个；其余按到达顺序等待，最多 32 个，再多返回 429 |
| 入站请求头 / 请求体接收时限 | 10 秒 / 60 秒 |
| 推理缓存 | 256 条、4 MiB |

排队中的调用在引擎断开或 Run 取消时离开队列。限制值在 [gateway.ts](../packages/gateway/src/gateway.ts) 的 `DEFAULT_GATEWAY_LIMITS` 中集中定义；`startModelGateway` 总是使用这些默认值，目前没有用户配置入口。`createModelGateway` 接受显式限制，在监听前校验每一项为范围内的整数，否则抛出 `RangeError`；除保活间隔外，时间限制只要求为正数，测试据此缩短它们。

## 媒体内容

上游模型可能不支持图片。会话历史里一旦出现图片（例如 Claude Code 读取截图、Codex `view_image`），如果直接拒绝，同一 Session 之后的每次请求都会失败。因此网关把各协议中的图片、文档、音频、文件统一替换为 `[... omitted: the HarnessHub model gateway forwards text only]` 文字占位，任务可以继续。上游模型支持视觉时，可以设置 `compatibility.images: passthrough`，保留 Chat 请求中的 `image_url`；其他三种入站协议的媒体目前仍替换为占位文字（2026-09-19 决定，见 [ADR 0013](decisions/0013-unified-model-gateway.md)）。

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

- [协议转换](../packages/gateway/test/model-gateway.test.ts)：四种入站协议的流式与非流式输出、模型列表、`count_tokens`、四种鉴权方式与拒绝。
- [上游行为](../packages/gateway/test/model-gateway-upstream.test.ts)：宽松解析各变体、结束原因、usage、工具分片、请求规范化与截断、错误状态透传与脱敏、上下文超长映射、502/504/重定向（上游完全不应答时 Gemini 同样为 504，已应答但无数据时按提交期限提交后在流内超时）、大小限制与不支持输入。
- [响应头与保活](../packages/gateway/test/model-gateway-keepalive.test.ts)：Gemini SSE（含只有工具调用的回合）在首个上游块即收到响应头；Gemini 在请求后 `headerCommitMs` 收到响应头，上游扣留响应头或调用在队列中等待时也一样，上游在期限之后应答时随应答提交；四种流式协议在上游活动而无可转发内容时收到各自的保活，Responses 序号保持连续，去掉保活后输出、usage 与调用记录与无保活时相同；只发注释的上游在 `maxNoDataMs` 后不再获得保活并超时（已提交为流内错误，未提交为 504）；提交后完全静默的上游在超时前得不到保活；Gemini 非流式只在期限提交、期限前的失败保留状态码、之后为 200 错误体；socket 已销毁时写入立即失败；写入因引擎不读而阻塞时不发保活；限制的范围校验。
- [推理与 Run](../packages/gateway/test/model-gateway-runs.test.ts)：四种协议的推理回填（假上游在缺少 `reasoning_content` 时按 DeepSeek 实测返回 400）、strip 模式、缓存上限、Run 作用域、取消与断开、并发上限、调用记录与 `runErrors`。
- [兼容入口](../tests/unit/chat-completions.test.ts)：`startModelBridge`、Responses/Google 转换与配置准备。

```sh
pnpm build
node tools/run-tests.mjs unit packages/gateway/dist/test/*.test.js dist/tests/unit/model-gateway*.test.js dist/tests/unit/chat-completions.test.js
```

2026-09-19 在 macOS 上做过一次性冒烟：本机已安装的 Codex 0.144.5、Gemini CLI 0.38.2、Claude Code 2.1.278（均非固定版本）以隔离的配置目录连接网关与本地假上游，各完成一次推理、Shell 工具调用与后续回合，后续请求都带回了推理内容。该冒烟发现并修正了 Claude Code 在 `messages` 中发送 system 角色消息的问题；脚本未入库，不代替固定版本引擎的验收。

未验证：固定版本引擎（Codex 0.153.4、Gemini CLI 0.58.0、Claude Code 2.1.263）与 Chat 类引擎经网关运行；Windows；真实上游模型与真实 DeepSeek（回填行为只用假上游复现了实测错误）。这些须在引擎接入后按 ADR 0013 的集成与 Windows 验收另行记录。

## Session Run 与共享网关

Session 的 Run 经守护进程端口上的共享网关使用模型（03 第 10 节），与本机其他客户端共用 provider、路由组与 `model.call` 账本。实现见 [model-sessions.ts](../packages/daemon/src/model-sessions.ts) 与 [Runtime](../packages/runtime/src/runtime/runtime.ts)。

- **哪些 Session 走共享网关**：在 Session 第一个 Run 开始前决定，之后不变。引擎登记应用了统一模型（见 [统一模型](engine-configuration.md#统一模型)）时必须走，目标不存在则 Run 以 `MODEL_NOT_CONFIGURED` 失败；引擎可接入网关、没有自己的 provider（声明或由内置配方推断出适配器）时，存在目标才走，否则仍用引擎自己的登录。声明了自己的 openai-completions provider 的引擎，以及配置检查，仍使用 Worker 内的 Session 网关（本页上文）；其他协议的直连 provider 不变。
- **目标**：Run 的 `model`（Model Ref 或 `group/<id>`，`POST /v1/sessions/:id/runs` 可填），缺省为 `group/default`。指定的目标不存在时 Run 在启动 Worker 之前以 409 `MODEL_NOT_CONFIGURED` 失败，Session 保持打开；没走共享网关的 Session 不能指定 `model`（`MODEL_SELECTION_UNSUPPORTED`）。
- **`session:` Key**：Session 第一个走共享网关的 Run 签发一把，`modelAllow` 为空，只能用于该 Session 活动 Run 的目标；Key 文本只在守护进程内存与该 Run 的 ExecutionSpec（Worker IPC）中，从不写入数据库、日志或事件，数据库只存哈希。Worker 把引擎配置指向守护进程端口，凭据为这把 Key，模型名为别名（应用了统一模型的引擎沿用其别名），因此各引擎的原生配置与 Worker 网关时相同，只是地址与令牌不同。Session 关闭且在途调用结束后吊销；启动时吊销上一个进程留下的、关闭时吊销仍打开的 Session 的 Key。
- **Run 范围与结算屏障**：Run 执行期间是该 Session 的活动 Run，网关据此把调用记到 `runId` 与 `generation`；Run 前后的调用返回 409 `no_active_run`。引擎结果返回后，Runtime 结束活动 Run，取消并等待该 Session 的在途调用提交（`awaitSessionIdle`），再按已提交的调用与 Run 中观察到的输出判定 `MODEL_UPSTREAM_ERROR` 与 `ENGINE_NO_OUTPUT`（规则见 [model-outcome.ts](../packages/core/src/model-outcome.ts)，与 Worker 网关相同）。
- **事件与用量**：每条已提交的调用成为该 Run 的 `model.call` 事件（协议、是否流式、请求的模型、Model Ref、served model、状态、耗时、结束原因、五项 usage、成本与错误）；Run 观测（`/v1/runs/:id/observations`）的 token、成本与实际模型来自这些事件，来源为 `gateway-ledger`。

## 共享网关

`createGatewayHandler(deps)`（[server.ts](../packages/gateway/src/server.ts)）返回一个不带监听器的 Node `(request, response)` 处理函数，由守护进程挂载到自己的端口上；`isGatewayPath(pathname)` 判断某条路径是否交给它（`/v1/*`、`/v1beta/*`、`/v1alpha/*`，以及省略 `/v1` 的 `/chat/completions`、`/responses`、`/messages`、`/messages/count_tokens`、`/models`）。守护进程在 `startHub` 中用 `SqliteModelPlaneStore`、`SecretStore.resolve`（`env` 引用读取守护进程启动时的环境快照）与 `resolveHandlerLimits(gatewayLimits)` 构造它，经 Fastify 的 `serverFactory` 挂在同一个监听器上、先于 Fastify 处理：交给它的是 `/v1beta/*`、`/v1alpha/*`、`/v1` 下的 `chat/completions`、`responses`、`messages`、`messages/count_tokens`、`models` 与 `models/…`，以及这些路径省略 `/v1` 的形式（[model-gateway-mount.ts](../packages/daemon/src/http/model-gateway-mount.ts) 的 `isModelGatewayPath`）。`/v1` 下的其他路径仍是现有管理接口，由 Fastify 处理，直到它们迁到 `/api/v1`；这些请求不经过 Fastify 的 2 MiB 请求体上限、JSON 解析与钩子。监听器的 `headersTimeout` 取 `requestHeadersTimeoutMs`；关闭时先在 `preClose` 中 `await close()`，再关闭存储。`GET /api/v1/system/info` 的 `gateway` 给出本机客户端使用的基址，见 [快速上手](quickstart.md)。本节描述已实现的行为；目标设计与本节不同之处列在最后。

### 依赖与所有权

| `deps` 字段 | 含义 |
|---|---|
| `store` | `ModelPlaneStore`：读 provider、路由组和 Gateway Key，写 `touchGatewayKey` 与 `appendModelCall` |
| `resolveSecret(ref)` | 每次上游尝试解析一次 Credential 引用，网关不缓存；失败时该 Credential 记为 `credential_unavailable` 并转移 |
| `clock()` | 墙钟毫秒：账本时间、Key 过期、熔断与 `Retry-After` |
| `limits` | `resolveHandlerLimits(input)`（[limits.ts](../packages/gateway/src/limits.ts)）的结果；它是默认值的唯一来源，未知字段或越界值抛出 `RangeError` |
| `log` | 可选的 `LogSink`：账本写入失败、touch 失败、熔断状态变化与内部错误 |

监听器的所有者把 `limits.requestHeadersTimeoutMs` 设为 `server.headersTimeout`，并在关闭存储之前 `await handler.close()`。`close()` 幂等：之后的新请求返回 503 `gateway_closing`；在途调用被中止（账本记 499 `client_cancelled`），等待所有请求结束，再提交被节流的拒绝计数。

### 鉴权与拒绝

- Gateway Key 可放在 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key`，Gemini 路径还接受 `?key=`。同一请求中取值不同返回 401。Key 用 `parseGatewayKey` 解析，按 `keyId` 取记录，作用域字母须与记录一致，再用 `gatewayKeyMatches` 常数时间比较；已吊销返回 401 `key_revoked`，已过期返回 401 `key_expired`，其余为 401 `invalid_key`。错误消息从不回显 Key。
- 非回环来源地址返回 403 `source_not_allowed`；带 `Origin` 头，或 `Host` 不是回环名称（`localhost`、`*.localhost`、`127.x.x.x`、`[::1]`）返回 403 `origin_forbidden`；未知路径 404 `route_not_found`，路径无法解码 400 `route_invalid`；请求的模型不在 `modelAllow` 内 403 `model_not_allowed`。
- 所有拒绝都使用该路径所属协议的错误格式并带 `x-hh-error-source: gateway`，同时提交 `rejected: true`、`rejectReason` 的账本记录；Key 有效（含已吊销、已过期）时记录 `keyId`。同一 Key（无 Key 归为一类）与同一原因每分钟最多 20 条明细，其余计数，在该组合下一次被拒绝时或 `close()` 时写成一条汇总记录。
- 鉴权通过后调用 `touchGatewayKey`，同一 Key 每分钟最多一次；失败只写日志。
- **额度**（`GatewayKeyRecord.quota`，[quota.ts](../packages/gateway/src/quota.ts)）在白名单之后、转发之前检查。`tokensPerDay`（五项 token 之和，按 UTC 日）与 `costPerMonthUsd`（已知成本之和，按 UTC 自然月）比较已提交的账本：用 `aggregateUsage` 按 `keyId` 读取，每个 Key 缓存 10 秒，期间本网关提交的调用直接累加。达到阈值之前开始的调用照常完成，所以跨过阈值的那一次会完成，之后的调用被拒绝；同一 Key 并发的调用都按同一合计放行。`requestsPerMinute` 是令牌桶（容量与每分钟补充量都是该值），硬限制；只有通过用量检查的调用才取令牌。超额返回 429 `quota_exceeded`，`retry-after` 指向窗口重置的时刻（不截断：日额度到 UTC 零点，月额度到下月 1 日，请求数到下一个令牌），Gemini 的错误体另带 `RetryInfo`；拒绝写入账本（`rejected: true`），按 Key 与原因节流。账本读失败时返回 503 `store_unavailable`。
- **`session:` Key**：处理函数的 `deps.sessions.activeRun(sessionId)` 给出该 Session 的活动 Run（`runId`、`generation` 与 Run 选定的目标，Model Ref 或 `group/<id>`）。没有活动 Run（或没有注入 `sessions`）时，调用返回 409 `no_active_run` 并写入拒绝记录。有活动 Run 时：请求的模型是别名 `harnesshub-model`、缺省或不是 Model Ref（引擎自己的模型名）都解析为该目标；名为其他 Model Ref 时仍按 `modelAllow` 检查，目标本身总是允许。账本记录带 `sessionId`、`runId` 与 `generation`；每条提交后的记录交给 `deps.sessions.committed`（在客户端收到终止事件之前，异常只写日志）。`/v1/models` 对这类 Key 额外列出别名，元数据取自目标。`handler.awaitSessionIdle(sessionId, {abort})` 是 Run 的结算屏障：等到该 Session 没有在途调用、且已结束调用的记录都已提交；`abort` 时先取消在途调用（账本 499 `client_cancelled`）。

### 模型解析与列表

- 请求的模型取自请求体的 `model`（Gemini 取路径中 `/models/` 之后到最后一个 `:` 之前的部分），必须是 Model Ref `provider/model` 或 `group/<id>`，否则 400 `model_invalid`；provider 或组不存在为 404 `model_not_found`（不是拒绝记录）。provider 列表中没有的模型照常路由，元数据未知。
- wire 名依次取模型自己的 `wire`、provider `wire` 中该模型的条目、`*` 条目（`*` 替换为模型名），否则为模型名。
- 每个启用的 Credential 是一个候选。provider 声明了与入站相同的端点、不是 `translateOnly`、Credential 对该端点有效时直通；否则转换到 provider 的 Chat 端点；没有 Chat 端点时依次转换到它的 Anthropic、Responses 或 Gemini 端点。对 provider 的任何端点都无效的 Credential 被跳过；没有任何候选时返回 400 `unsupported_route`，消息列出被跳过的原因。
- 端点基址是该厂商官方 SDK 使用的基址，这是对 `ProviderConfig.endpoints` 注释中“不含操作路径”的明确约定，存储的基址校验按同一约定执行：Chat 与 Responses 含版本（OpenAI SDK 的 `baseURL`，如 `https://api.openai.com/v1`，拼接 `/chat/completions`、`/responses`）；Anthropic 不含版本（`ANTHROPIC_BASE_URL` 形式，如 `https://api.deepseek.com/anthropic`，拼接 `/v1/messages`）；Gemini 不含版本（`@google/genai` 的 `baseUrl`，拼接客户端所用的 `v1beta`、`v1` 或 `v1alpha`，再接 `/models/{wire}:{method}`，SSE 时带 `alt=sse`）。基址末尾的斜杠不影响结果。
- `GET /v1/models`、`GET /v1/models/{ref}`（`{ref}` 可含 `/`）与 `GET /v1beta/models` 只列出 Key 允许、且在 provider `expose` 中的模型，以及 Key 允许的路由组。每项含 `id`、`owned_by`、`context_window`、`max_output_tokens`、`reasoning`、`input_modalities`（已知时）与 `native_endpoints`（`translateOnly` 时为空，路由组没有该字段）；路由组取成员中最小的窗口与输出上限，成员都已知时取推理与模态的交集。列表与计数不访问上游，也不写账本。
- `count_tokens` 与 Gemini `:countTokens` 返回本地估算，响应头带 `x-hh-token-count: estimated`。

### 直通与转换

- **直通**只改写请求体顶层的 `model` 字符串（原位替换，其他字节不变，包括键序、空白和未知字段；Gemini 请求体不变，wire 名进入路径），去掉 HarnessHub 的鉴权头，按 `auth.apiKeyHeader` 加上 provider 的 Credential（`query-key` 写入 URL），再加上 provider 的 `headers`。客户端的 `anthropic-version`（缺省补 `2023-06-01`）、`anthropic-beta`、`openai-beta` 与 `user-agent` 被转发。
- 已实现的补丁：Chat 的 `developer-to-system`、`max-tokens-field`、`drop-fields`、`include-usage`、`json-schema-to-json-object`；各协议的 `drop-fields`；Anthropic 的 `anthropic-beta-allow`（只转发列出的 beta 值）。任何补丁生效时请求体改为解析后重新序列化，实际生效的补丁写入 `patches[]`。`thinking-off-unless-asked`、`lift-additional-tools`，以及声明在不适用端点上的补丁，会使该候选以 500 `patch_unsupported` 跳过，不静默忽略。
- 直通响应按完整的 SSE 事件或 Gemini 数组元素转发，字节不变；旁路解析首内容、usage、served model、终止事件与流内错误。第一个数据事件之前的注释与空事件先缓存，因此此前的超时仍以真实状态码返回。上游的流内错误不原样转发，而是改写为该协议格式、经过脱敏的错误；上游 HTTP 错误同样按入站协议格式重写，带 `x-hh-error-source: upstream`。
- **转换**以 Chat 形态的请求与流为枢纽：入站转换器把请求转成 Chat 请求并规范化；上游是 Chat 时直接发送，否则由编码器（[encode.ts](../packages/gateway/src/encode.ts)）转成 Anthropic Messages、Responses 或 Gemini `streamGenerateContent`（总是流式，Gemini 用 `alt=sse`）；解码器（[decode.ts](../packages/gateway/src/decode.ts)）把这些协议的流或 JSON 响应变成 Chat 块，经同一个工具调用累积与结束原因规范化，交给入站协议原有的输出（含保活与 Gemini 响应头提交期限）。与 Session 网关的差别：默认不去掉任何参数、不把 `json_schema` 降级（只由补丁触发）、总是请求 Chat 上游的 `stream_options.include_usage`；模型的 `maxOutputTokens` 限制输出上限；模型声明图片输入时图片作为 Chat 的 `image_url` 保留（否则仍是文字占位）；provider 声明 `requiresReasoningReplay` 或上游是 Anthropic 时，按 Gateway Key 缓存并回填推理文本。2xx 却没有任何数据事件为 502 `upstream_invalid_response`。
- 入站转换器另外带出客户端的推理请求（Chat `reasoning_effort`、Responses `reasoning.effort`、Anthropic `thinking`、Gemini `thinkingConfig`）与标记为错误的工具结果（Anthropic `is_error`、只有 `error` 的 Gemini `functionResponse`），编码器按目标协议使用：
  - **Anthropic**：首条 system 消息成为 `system`；工具结果成为用户轮中领先的 `tool_result` 块，带 `is_error`；base64 与 URL 图片；`stop` 成为 `stop_sequences`，`temperature` 截到 1，`parallel_tool_calls: false` 成为 `disable_parallel_tool_use`；`max_tokens` 依次取请求、模型的 `maxOutputTokens`、默认 4096（`anthropicMaxTokens` 是唯一的解析处，非请求来源记为补丁 `max_tokens:model` 或 `max_tokens:default`）；请求头带 `anthropic-version: 2023-06-01`。有推理请求时开启 `thinking`（预算取请求值或按 effort 换算，限制在 1024 与 `max_tokens - 1` 之间），并去掉 `temperature`、`top_p` 与强制工具选择（记为补丁）。历史中的推理只有找到同一 provider 为该文本签发的签名时才作为 `thinking` 块回传，否则丢弃并记入 `unmapped`；正在进行的工具轮缺少已签名的推理时不开启 `thinking`（补丁 `thinking:off:unsigned_history`），因为 Anthropic 会拒绝。
  - **Responses**：无状态请求（`store: false`）；system 成为 `instructions`，工具调用与结果成为 `function_call` 与 `function_call_output` 项；函数工具除非 Chat 工具要求严格模式，否则以 `strict: false` 发送；`response_format` 成为 `text.format`；推理请求成为 `reasoning.effort`，并要求 `summary: auto` 以便流回推理文本。历史推理（没有该 provider 的加密内容）、`stop` 与工具错误标记无法携带，记入 `unmapped`。
  - **Gemini**：system 成为 `systemInstruction`，工具成为 `functionDeclarations`；JSON Schema 只保留 Gemini 接受的关键字（类型转为大写，含 `null` 的类型联合成为 `nullable`，`const` 成为单值 `enum`，`oneOf` 成为 `anyOf`），去掉的关键字以 `schema.<关键字>` 记入 `unmapped`；工具结果成为以所答调用命名的 `functionResponse`，工具错误为 `{error}`，JSON 对象结果原样作为 `response`；base64 图片成为 `inlineData`，图片 URL 无法发送；推理请求成为 `thinkingConfig`（关闭时 `thinkingBudget: 0`）。同一 provider 在函数调用上签发的 `thoughtSignature` 按调用 id 缓存，下一轮回传。
- 解码器把推理（Anthropic `thinking`、Responses 推理摘要与推理文本、Gemini thought 部分）交给入站协议的推理块；签名、加密推理与 redacted thinking 从不转发给其他协议的客户端，redacted thinking 与服务端工具块记入 `unmapped`。结束原因：`end_turn` 与 `stop_sequence` 为 `stop`，`max_tokens` 为 `length`，`tool_use` 为 `tool_calls`，`refusal` 与 Gemini 的安全类原因为 `content_filter`，Responses 的 `incomplete` 按原因映射，其他值原样保留；Gemini `MALFORMED_FUNCTION_CALL` 为 502 上游错误。usage 换算为同一口径：Anthropic 的缓存读写、OpenAI 的缓存与推理 token、Gemini 的缓存与 thoughts 都进入账本对应的字段。各协议的上游错误（含流内错误事件）按入站协议的错误格式返回，规则同直通。
- 签名缓存按 Gateway Key 分开（每个 Key 512 条，最多 1024 个 Key），只对签发它的 provider 返回。

### 路由、重试与熔断

- 单个 Model Ref 的候选是该 provider 的 Credential；路由组按策略排列成员：`order` 按配置；`rotate` 每次调用从下一个成员开始；`least-used` 取最近 24 小时 token 最少者；`latency` 取首内容时间指数平均最小者，样本少于 5 次的成员优先。后两者只统计本处理函数启动以来的调用。
- **粘性**（[sticky.ts](../packages/gateway/src/sticky.ts)）让同一会话留在上次应答的 Credential，以保持上游提示缓存与推理签名有效。会话键依次取 `x-hh-conversation` 请求头、客户端自带的标识（Chat 与 Responses 的 `prompt_cache_key`，Anthropic `metadata.user_id` 中的 `session_…` 部分），否则为 system 文本加第一条用户消息的哈希；所有会话键都按 Gateway Key 隔离。请求以工具结果结尾（Chat 的 `tool` 消息、Responses 的 `function_call_output`、Anthropic 的 `tool_result`、Gemini 的 `functionResponse`）时视为同一轮之内。模式取路由组的 `stickiness`，单个 Model Ref 为 `auto`；`session:` Key 在 `auto` 时改为 `session`：
  - `auto`：同一轮内总是留下；跨轮只有上次调用读取了至少 1024 个缓存 token、且距今不到 5 分钟才留下。
  - `session`：总是留下；`turn`：只在同一轮内留下；`off`：不粘。
  - 留下的候选排到最前，其余按策略的顺序跟在后面；它的熔断打开或已不在候选中（白名单、组成员或 Credential 变化）时粘性被打破，按策略路由。
  - 有多个候选时，决定写入 `patches[]`：`sticky:hit`、`sticky:miss:<new|model_changed|cache_cold|new_turn>` 或 `sticky:broken:<breaker|unavailable>`；账本合约还没有专门的粘性字段（后续合约变更）。成功的调用更新记录。记录只在内存中保存最近 512 个会话、24 小时，守护进程重启后重新开始。
- 重试策略取组的 `retry` 覆盖 `DEFAULT_RETRY_POLICY`，`totalAttempts` 不超过 8；单 Model Ref 使用默认值。退避为 `baseBackoffMs × 2^n`，不超过 `maxBackoffMs`，±20% 抖动；等待总计不超过 30 秒。
- 分类按 03 第 5 节：连接失败与 408、500、502、503、504、529 先同候选重试再转移；等待响应头超时最多重试 1 次；429 的 `Retry-After`（或 `retry-after-ms`）不超过上限时有其他候选先转移，否则等待后重试，超过上限或没有时不等待，转移或把 429 返回客户端，`retry-after` 截断到 60 秒（Gemini 在错误体中写 `RetryInfo`）；401、402、403 与配额措辞转移不重试；404 与模型不存在措辞转移，并把该 Credential 与模型标记 10 分钟；其他 4xx 与上下文超长（429 一律不算超长）直接返回。客户端断开或 `close()` 立即停止，不再发起尝试。
- 熔断以 Credential 为单位：连续 3 次计入的失败、一次认证或配额失败使其打开；时长取上游给出的等待，否则 60 秒起每次重新打开翻倍，上限 10 分钟；认证失败打开 10 分钟，Credential 引用变化时立即关闭。到期后半开放行一个探测请求，成功关闭、计入的失败再次打开。所有候选都不可用时不访问上游，返回最近一次失败的状态与原因。一次失败使该 Credential 的熔断打开时，本调用原本要做的同候选重试改为转移；只有按 `Retry-After` 等待后的重试不受熔断影响（等待已计入冷却）。直通与各种转换路由的重试、转移、扣留与熔断行为相同。
- **首字节前扣留**：还有替代路径（其他候选或剩余同候选重试）时，流式输出在第一个内容事件（文本、推理或工具调用）之前被扣留，最多 `holdMs`（15 秒）或 `holdBytes`（1 MiB）；扣留期间不发保活，期间的流内错误按首字节前失败处理。首字节送达客户端之后的任何失败只在流内报告，不重试、不转移。

### 账本

每个进入网关的模型调用提交一条 `ModelCallEntry`：`attempts[]`（候选、开始时间、上游首字节、状态、错误类别、`Retry-After`、决定与退避）、按协议规范化的五项 usage（无上报时 `source: missing` 且各项为 0）、`timing`（`durationMs`；已写出字节时的 `firstByteMs`；首内容时的 `firstContentMs`）、`status`、`errorClass`、`errorSource`、脱敏后的 `error`、`patches[]`、`mode`、`servedModel`、`finishReason`、`completion`（`explicit` 或 `inferred`）。`cost` 只在 provider 模型声明了价格、且每个用到的 token 类别都有价格时计算（推理按输出价格），否则为 null。`unmapped[]` 列出转换到其他协议时丢弃的请求字段与内容（如 `reasoning`、`stop`、`schema.additionalProperties`）以及无法转给客户端的响应块（如 `response.redacted_thinking`）；直通与转换到 Chat 上游时为空。

**先提交后发布**：流式响应的终止事件（`[DONE]`、`response.completed` 或 `response.incomplete`、`message_stop`、带结束原因的 Gemini 块及其后的内容、数组的 `]`）与非流式响应体在 `appendModelCall` 成功之后才写出。提交失败时，尚未写出响应头则返回 503 `evidence_unavailable`，否则在流内写出该错误且不写终止事件。每个调用至多追加一条记录。

### 资源上限

| 项目 | 默认值 |
|---|---|
| 入站请求体（解压 gzip、deflate、br、zstd 之后） | 64 MiB，可设到 256 MiB |
| 规范化后的上游请求体 | 32 MiB（超出时该候选以 413 跳过） |
| 单次尝试的上游响应体（原始字节） | 64 MiB |
| 单个 SSE 事件或 Gemini 数组元素 | 16 MiB |
| 全部在途请求体 | 512 MiB，超出返回 503 `busy` |
| 请求体接收时限 / 请求头时限（由监听器所有者应用） | 120 秒 / 10 秒 |
| 等待上游响应头 / 上游空闲（只被数据事件重置） | 300 秒 / 300 秒 |
| 保活间隔 / 停止保活 / Gemini 响应头提交期限 | 10 秒 / 300 秒 / 45 秒 |
| 首字节前扣留 | 15 秒或 1 MiB |
| 每个 Credential 并发上游请求 | 8 个，排队 64 个，再多返回 429 `busy`（转移到其他候选） |
| 推理回填缓存 | 每个 Gateway Key 256 条、4 MiB；全部 64 MiB |

### 验证

[共享网关测试](../packages/gateway/test/shared-gateway.test.ts)、[路由测试](../packages/gateway/test/shared-gateway-routing.test.ts) 与 [协议矩阵测试](../packages/gateway/test/shared-gateway-matrix.test.ts) 与 [粘性与额度测试](../packages/gateway/test/shared-gateway-sticky.test.ts) 把处理函数挂在 `listen(0)` 的回环服务上，使用测试内的内存 `ModelPlaneStore` 与回环假上游，不访问真实模型：每种 Key 拒绝及其账本记录与节流、白名单、模型列表、四种协议的直通（请求体除 `model` 外逐字节相同、鉴权头替换、响应字节相同）、四种入站到 Chat 上游的转换、补丁、压缩请求、503 后转移成功、首字节后不重试、400 不重试、上下文超长不重试、`Retry-After` 超过上限直接返回与上限内等待、扣留期间的流内错误转移、扣留超时释放、熔断打开与半开、认证失败换 Credential、取消后不再尝试、`close()` 中止在途调用、提交前不写终止事件、提交失败时的 `evidence_unavailable`、响应头与空闲超时、转换路径的保活与 Gemini 响应头提交；以及 Chat 入站到仅有 Anthropic 端点的 provider（推理、工具、缓存读写 usage、同一 provider 的签名回传）、Claude Code 到仅有 Responses 或 Gemini 端点的 provider（图片、推理、工具、错误结果、Schema 限制）、Codex 到 Claude、交错的并行工具参数、各协议上游错误的格式映射，以及转换路由上的重试、转移、扣留与熔断。[编解码测试](../packages/gateway/test/matrix-codec.test.ts) 逐项覆盖编码器、解码器、结束原因映射与 `max_tokens` 解析。粘性与额度测试覆盖四种协议的会话键与轮次判断、每种粘性模式与缓存价值规则、熔断打开时粘性被打破、轮换策略下的 `auto` 粘性，以及三种额度（跨过阈值的调用完成、下一次被拒绝、窗口重置后恢复）。

```sh
pnpm build
node tools/run-tests.mjs unit packages/gateway/dist/test/*.test.js
```

### 与 03 的差异与未实现项

- 协议矩阵以 Chat 为枢纽，而不是 03 第 3 节的 IR；编码器与解码器按 IR 的边来组织，以后可以替换枢纽。经过 Chat 枢纽会丢失 Chat 表达不了的区别，例如 Anthropic 的 `stop_sequence` 与 `end_turn` 都成为 `stop`。
- `/api/v1/model-calls` 的响应 schema 还没有 `generation`，该字段目前只在账本记录与网关内可见。
- 尚未实现：粘性记录的持久化与账本中的粘性字段（目前写在 `patches[]`）；`route.breaker` 事件（目前只写日志）；provider 声明的请求体上限与 `onUnsupportedMedia`；上游 `count_tokens` 转发；局域网共享与 `publicBaseUrl`；`shape`、`conversationKey` 等账本扩展字段；入站转换器自身丢弃的提示字段尚未记入 `unmapped[]`；转换到 Gemini 的图片 URL 与 Anthropic 的结构化输出（beta）；拒绝记录的定时汇总（目前在下一次同类拒绝或 `close()` 时写出）。
- 直通只给 Gemini 入站注入保活（它在响应头提交期限后已提交头部）；其他协议的直通流保持上游的原样字节，不插入保活。
- 响应体上限按原始字节而不是解码后的内容计算；`least-used` 与 `latency` 只统计本次启动以来的调用；认证失败的熔断最长 10 分钟后进入半开，而不是一直保持到 Credential 更新。
