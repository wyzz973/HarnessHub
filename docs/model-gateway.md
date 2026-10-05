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
| OpenAI Images | `POST /v1/images/generations`、`POST /v1/images/edits`（JSON 或 multipart） | 直通到声明了 `imageEndpoint` 的 provider，`stream: true` 的事件原样转发；没有图像端点的 provider 经 Chat 画图，图像端点 404/405 时回退到 Chat 一次（[图像生成](gateway-features.md#图像生成)） |

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
- 上下文超长（错误码 `context_length_exceeded`，或消息包含 context length、context window、maximum context、too many tokens、prompt is too long、input token count 等）统一返回 400：Chat/Responses 的 `code` 为 `context_length_exceeded`；Anthropic 为 `invalid_request_error`，消息以 `prompt is too long` 开头，能识别数值时写成 `prompt is too long: <实际> tokens > <上限> maximum`；Google 为 `INVALID_ARGUMENT`，能识别数值时写成 `The input token count (<实际>) exceeds the maximum number of tokens allowed (<上限>).`。数值从 OpenAI（`resulted in N tokens`）、vLLM、Anthropic 与 Gemini 各自的措辞中读取。Codex 0.153.4 只从流内 `response.failed` 识别上下文超限，所以流式 Responses 请求改为返回 200 SSE，内含 `response.failed`，`code` 为 `context_length_exceeded`。
- vLLM 形式的报错中若提示词本身未超长、只是输出上限过大（`(N in the messages, M in the completion)` 且 N 小于上限），不视为上下文超长，避免引擎反复压缩。
- 其他情况：网络失败或拒绝重定向为 502 `upstream_unreachable`；等待上游响应头或两次上游数据事件之间超过 300 秒为 504 `upstream_timeout`（SSE 注释与空行不算数据）；上游响应超过 8 MiB 为 502 `response_too_large`；上游格式错误为 502；入站请求超过 8 MiB 为 413，非 UTF-8 或非 JSON 为 400，带压缩编码为 415；排队已满为 429 `busy`；无法转换的输入为 400。
- 流已开始后的失败在流内报告：Chat 为 `data: {"error":...}` 且不发 `[DONE]`；Responses 为 `response.failed`（上下文 `context_length_exceeded`、429 为 `rate_limit_exceeded`、5xx 为 `server_error`、其他 `invalid_prompt`）；Anthropic 为 `event: error`；Google 的 `alt=sse` 为事件之后的裸 JSON 对象 `{"error":{"code","message","status"}}`（与 Gemini API 相同，`@google/genai` 只把这种形式识别为 `ApiError`；它与前一个事件被一起读到时 SDK 报“Incomplete JSON segment at the end”，同样是失败），流式 JSON 数组中为最后一个元素。
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

Responses 和 Google 按固定客户端（Codex 0.153.4 的请求结构、@google/genai 的请求构造）的完整字段集检查顶层字段，因此未知字段会失败。Claude Code 为闭源且频繁增加 beta 字段，Anthropic 未知顶层字段被忽略，已知无法转换的语义仍明确失败。上游选择了请求中不存在的工具时，工具名原样返回，由引擎报告未知工具。Anthropic 非流式与 Google 输出需要工具参数为 JSON 对象，否则返回 502。Anthropic 流式输出一次只开一个块：前一个调用的参数还不是完整 JSON 时开始的调用（上游可能交错发送它们的参数）先被收住，在前一个块结束后整块发出；共享网关的转换路径同样如此。

## 验证

单元测试从 HTTP 入口运行，使用本地假上游，不访问真实模型：

- [协议转换](../packages/gateway/test/model-gateway.test.ts)：四种入站协议的流式与非流式输出、模型列表、`count_tokens`、四种鉴权方式与拒绝。
- [上游行为](../packages/gateway/test/model-gateway-upstream.test.ts)：宽松解析各变体、结束原因、usage、工具分片、请求规范化与截断、错误状态透传与脱敏、上下文超长映射、502/504/重定向（上游完全不应答时 Gemini 同样为 504，已应答但无数据时按提交期限提交后在流内超时）、大小限制与不支持输入。
- [响应头与保活](../packages/gateway/test/model-gateway-keepalive.test.ts)：Gemini SSE（含只有工具调用的回合）在首个上游块即收到响应头；Gemini 在请求后 `headerCommitMs` 收到响应头，上游扣留响应头或调用在队列中等待时也一样，上游在期限之后应答时随应答提交；四种流式协议在上游活动而无可转发内容时收到各自的保活，Responses 序号保持连续，去掉保活后输出、usage 与调用记录与无保活时相同；只发注释的上游在 `maxNoDataMs` 后不再获得保活并超时（已提交为流内错误，未提交为 504）；提交后完全静默的上游在超时前得不到保活；Gemini 非流式只在期限提交、期限前的失败保留状态码、之后为 200 错误体；socket 已销毁时写入立即失败；写入因引擎不读而阻塞时不发保活；限制的范围校验。
- [推理与 Run](../packages/gateway/test/model-gateway-runs.test.ts)：四种协议的推理回填（假上游在缺少 `reasoning_content` 时按 DeepSeek 实测返回 400）、strip 模式、缓存上限、Run 作用域、取消与断开、并发上限、调用记录与 `runErrors`。
- [兼容入口](../tests/unit/chat-completions.test.ts)：`startModelBridge`、Responses/Google 转换与配置准备。

集成测试 [fake-provider.test.ts](../tests/integration/fake-provider.test.ts) 让网关的 Chat 上游指向黑名单模式、只接受流式的 [假 provider](../tools/fake-provider/README.md)：经四种入站协议各发流式与非流式请求（含带推理回传的工具往返，入站请求带有引擎实际会加的 `stream_options`、`store`、`metadata`、`developer` 角色、`cache_control` 等字段），断言上游零违规且只见到配置的上游 Key；兼容性设置打开 `includeUsage` 与 `max_completion_tokens` 时，假 provider 报告 `stream_options` 与 `max_completion_tokens` 两处违规；另经守护进程、Worker 与 ACP 夹具引擎完成一次 Run。

```sh
pnpm build
node tools/run-tests.mjs unit packages/gateway/dist/test/*.test.js dist/tests/unit/model-gateway*.test.js dist/tests/unit/chat-completions.test.js
node tools/run-tests.mjs integration dist/tests/integration/fake-provider.test.js
```

2026-09-19 在 macOS 上做过一次性冒烟：本机已安装的 Codex 0.144.5、Gemini CLI 0.38.2、Claude Code 2.1.278（均非固定版本）以隔离的配置目录连接网关与本地假上游，各完成一次推理、Shell 工具调用与后续回合，后续请求都带回了推理内容。该冒烟发现并修正了 Claude Code 在 `messages` 中发送 system 角色消息的问题；脚本未入库，不代替固定版本引擎的验收。

未验证：固定版本引擎（Codex 0.153.4、Gemini CLI 0.58.0、Claude Code 2.1.263）与 Chat 类引擎经网关运行；Windows；真实上游模型与真实 DeepSeek（回填行为只用假上游复现了实测错误）。这些须在引擎接入后按 ADR 0013 的集成与 Windows 验收另行记录。

## Session Run 与共享网关

Session 的 Run 经守护进程端口上的共享网关使用模型（03 第 10 节），与本机其他客户端共用 provider、路由组与 `model.call` 账本。实现见 [model-sessions.ts](../packages/daemon/src/model-sessions.ts) 与 [Runtime](../packages/runtime/src/runtime/runtime.ts)。

- **哪些 Session 走共享网关**：在 Session 第一个 Run 开始前决定，之后不变。引擎登记应用了统一模型（见 [统一模型](engine-configuration.md#统一模型)）时必须走，目标不存在则 Run 以 `MODEL_NOT_CONFIGURED` 失败。统一模型的登记策略（覆盖登记中的模型与 Provider、停用无法接入网关的引擎）是遗留行为：只在存在旧的统一模型来源时生效，将被移除；开源版中没有目标的引擎使用自己的账号。引擎可接入网关、没有自己的 provider（声明或由内置配方推断出适配器）时，存在目标才走，否则仍用引擎自己的登录。声明了自己的 openai-completions provider 的引擎，以及配置检查，仍使用 Worker 内的 Session 网关（本页上文）；其他协议的直连 provider 不变。
- **目标**：Run 的 `model`（Model Ref 或 `group/<id>`，`POST /v1/sessions/:id/runs` 可填），缺省为 `group/default`。指定的目标不存在时 Run 在启动 Worker 之前以 409 `MODEL_NOT_CONFIGURED` 失败，Session 保持打开；没走共享网关的 Session 不能指定 `model`（`MODEL_SELECTION_UNSUPPORTED`）。
- **`session:` Key**：Session 第一个走共享网关的 Run 签发一把，`modelAllow` 为空，只能用于该 Session 活动 Run 的目标；Key 文本只在守护进程内存与该 Run 的 ExecutionSpec（Worker IPC）中，从不写入数据库、日志或事件，数据库只存哈希。Worker 把引擎配置指向守护进程端口，凭据为这把 Key，模型名为别名（应用了统一模型的引擎沿用其别名），因此各引擎的原生配置与 Worker 网关时相同，只是地址与令牌不同。Session 关闭且在途调用结束后吊销；启动时吊销上一个进程留下的、关闭时吊销仍打开的 Session 的 Key。
- **Run 范围与结算屏障**：Run 执行期间是该 Session 的活动 Run，网关据此把调用记到 `runId` 与 `generation`；Run 前后的调用返回 409 `no_active_run`。引擎结果返回后，Runtime 结束活动 Run，取消并等待该 Session 的在途调用提交（`awaitSessionIdle`），再按已提交的调用与 Run 中观察到的输出判定 `MODEL_UPSTREAM_ERROR` 与 `ENGINE_NO_OUTPUT`（规则见 [model-outcome.ts](../packages/core/src/model-outcome.ts)，与 Worker 网关相同）。
- **事件与用量**：每条已提交的调用成为该 Run 的 `model.call` 事件（协议、是否流式、请求的模型、Model Ref、served model、状态、耗时、结束原因、五项 usage、成本与错误）；Run 观测（`/v1/runs/:id/observations`）的 token、成本与实际模型来自这些事件，来源为 `gateway-ledger`。

## 共享网关

`createGatewayHandler(deps)`（[server.ts](../packages/gateway/src/server.ts)）返回一个不带监听器的 Node `(request, response)` 处理函数，由守护进程挂载到自己的端口上；`isGatewayPath(pathname)` 判断某条路径是否交给它（`/v1/*`、`/v1beta/*`、`/v1alpha/*`，省略 `/v1` 的 `/chat/completions`、`/responses`、`/responses/compact`、`/messages`、`/messages/count_tokens`、`/models`，以及 Codex 透传的 `/backend-api/codex` 与其下路径）。守护进程在 `startHub` 中用 `SqliteModelPlaneStore`、`SecretStore.resolve`（`env` 引用读取守护进程启动时的环境快照）与 `resolveHandlerLimits(gatewayLimits)` 构造它，经 Fastify 的 `serverFactory` 挂在同一个监听器上、先于 Fastify 处理：交给它的是 `/v1beta/*`、`/v1alpha/*`、`/v1` 下的 `chat/completions`、`responses`、`responses/compact`（答复 400，见[上下文压缩](gateway-features.md#上下文压缩)）、`messages`、`messages/count_tokens`、`models`、`models/…`、`images/generations`、`images/edits` 与 `harnesshub/limit`，以及前几项省略 `/v1` 的形式（[model-gateway-mount.ts](../packages/daemon/src/http/model-gateway-mount.ts) 的 `isModelGatewayPath`），回环监听器另外交给它 `/backend-api/codex` 及其下路径（`isCodexPassthroughPath`，见下文“Codex 透传”），局域网监听器不交。`/v1` 下的其他路径仍是现有管理接口，由 Fastify 处理，直到它们迁到 `/api/v1`；这些请求不经过 Fastify 的 2 MiB 请求体上限、JSON 解析与钩子。分派之前，两个监听器都以 400 `path_not_canonical` 拒绝不规范的路径（`nonCanonicalPath`）：以 `//` 开头、含 `.` 或 `..` 段、反斜杠、编码的点（`%2E`），或 `/api/` 之外编码的斜杠与反斜杠（`%2F`、`%5C`；`/api/v1/models/{ref}` 等操作按约定把 Model Ref 中的斜杠编码）。这样的路径解析后可能落到它字面所指之外的处理者，绕过上面的分派；答复不重复路径。监听器的 `headersTimeout` 取 `requestHeadersTimeoutMs`；关闭时先在 `preClose` 中 `await close()`，再关闭存储。`GET /api/v1/system/info` 的 `gateway` 给出本机客户端使用的基址，见 [快速上手](quickstart.md)。本节描述已实现的行为；目标设计与本节不同之处列在最后。

### 依赖与所有权

| `deps` 字段 | 含义 |
|---|---|
| `store` | `ModelPlaneStore`：读 provider、路由组和 Gateway Key，写 `touchGatewayKey` 与 `appendModelCall` |
| `resolveSecret(ref)` | 每次上游尝试解析一次 Credential 引用，网关不缓存；失败时该 Credential 记为 `credential_unavailable` 并转移 |
| `clock()` | 墙钟毫秒：账本时间、Key 过期、熔断与 `Retry-After` |
| `limits` | `resolveHandlerLimits(input)`（[limits.ts](../packages/gateway/src/limits.ts)）的结果；它是默认值的唯一来源，未知字段或越界值抛出 `RangeError` |
| `log` | 可选的 `LogSink`：账本写入失败、touch 失败、熔断状态变化、`least-used` 初值读取失败与内部错误 |
| `subscriptions` | 订阅账号的令牌管理器（[siwc.ts](../packages/gateway/src/siwc.ts) 的 `SiwcTokens`）：每个账号同一时间至多一次续期；没有它时订阅账号的调用以 `credential_unavailable` 失败 |
| `copilot` | Copilot 账号的客户端（[copilot.ts](../packages/gateway/src/copilot.ts) 的 `CopilotRuntime`，守护进程以每个账号一个宿主进程实现）；处理函数的 `CopilotBridge` 拥有会话并在 `close()` 中关闭它们；没有它时 Copilot 账号的调用以 `subscription_unavailable` 失败 |
| `allowances` | 额度读数的保存位置（守护进程：`<dataDir>/allowance-readings.json`）：启动时读回，变化后一分钟内与 `close()` 时保存，失败只写日志；没有它时读数只在内存中 |
| `features` | 用户的网关功能设置（[网关功能](gateway-features.md)：出站脱敏、视觉模型、搜索后端），每个请求读取；没有它时脱敏开启、没有用户规则，其余关闭 |
| `secrets` | 处理函数自己不解析、但绝不能发往上游的值（守护进程的管理令牌）；脱敏像凭据一样替换它们 |
| `codexBackend` | 只供测试：Codex 透传转发到的基址，测试把它指向回环假服务；守护进程只在 `startHub({codexBackend})`（同样只供测试，不在配置文件中）给出时设置，否则为 `https://chatgpt.com/backend-api/codex`，没有对应的用户配置项。经守护进程访问 `/backend-api/codex` 的测试都指向记录请求的回环替身（`tests/support/codex-stub.ts`），不会访问 chatgpt.com |

监听器的所有者把 `limits.requestHeadersTimeoutMs` 设为 `server.headersTimeout`，并在关闭存储之前 `await handler.close()`。`close()` 幂等：之后的新请求返回 503 `gateway_closing`；在途调用被中止（账本记 499 `client_cancelled`），等待所有请求结束，再提交被节流的拒绝计数。

### 鉴权与拒绝

- Gateway Key 可放在 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key`，Gemini 路径还接受 `?key=`；回环上的 agent Key 还可以放在路径中（见下文“路径中的 Key”）。同一请求中取值不同返回 401。Key 用 `parseGatewayKey` 解析，按 `keyId` 取记录，作用域字母须与记录一致，再用 `gatewayKeyMatches` 常数时间比较；已吊销返回 401 `key_revoked`，已过期返回 401 `key_expired`，其余为 401 `invalid_key`。错误消息从不回显 Key。
- 回环监听器上非回环来源地址返回 403 `source_not_allowed`（局域网来源只能经局域网监听器，见下文“局域网共享”）；带 `Origin` 头（任何源，网关的客户端都不是浏览器）、`Sec-Fetch-Site: cross-site`，或 `Host` 不是回环名称（`localhost`、`*.localhost`、`127.x.x.x`、`[::1]`）也不是 `publicBaseUrl` 的主机时返回 403 `origin_forbidden`；未知路径 404 `route_not_found`，路径无法解码 400 `route_invalid`；请求的模型不在 `modelAllow` 内 403 `model_not_allowed`。
- 所有拒绝都使用该路径所属协议的错误格式并带 `x-hh-error-source: gateway`，同时提交 `rejected: true`、`rejectReason` 的账本记录；Key 有效（含已吊销、已过期）时记录 `keyId`。同一 Key（无 Key 归为一类）与同一原因每分钟最多 20 条明细，其余计数，在该组合下一次被拒绝时或 `close()` 时写成一条汇总记录。
- 鉴权通过后调用 `touchGatewayKey`，同一 Key 每分钟最多一次；失败只写日志。
- **额度**（`GatewayKeyRecord.quota`，[quota.ts](../packages/gateway/src/quota.ts)，Magpie 的 key 预算）在白名单之后、转发之前检查。`budgets[]` 每项是一个日历窗口（守护进程本地时区：日从零点、周从周一零点、月从 1 日零点，跨夏令时也按本地日历）的上限：`tokens`（未命中缓存的输入、输出、推理与缓存写入 token，`cacheReads` 时另计缓存读取）与/或 `costUsd`（账本的估算成本，没有价格的调用不计）；每个 period 至多一项。上限可以是 0，表示该窗口内的每次调用都被拒绝（Key 保留但被封住）。一次调用计入它开始时所在的窗口。用量来自已提交的账本：用 `aggregateUsage` 按 `keyId` 与窗口起点读取，每个 Key 与窗口缓存 10 秒，期间本网关提交的调用直接累加。放行的请求在结束前持有一份预留：请求体字节数 / 4，加上本窗口每次成功调用的平均输出与推理 token；成本上限的预留按本窗口的平均每 token 成本折算，还没有有价格的调用时用所请求模型的输入价格。已用加在途预留达到任一上限即拒绝，所以并发请求最多超出约一次调用。`requestsPerMinute` 是令牌桶（容量与每分钟补充量都是该值），硬限制；只有通过预算检查的请求才取令牌。超额返回 429 `quota_exceeded`，消息给出 Key、已用多少、在途请求数与重置时刻；`retry-after` 指向窗口重置（不截断；请求数到下一个令牌），预算拒绝另带 `x-should-retry: false`（让 OpenAI 与 Anthropic 的 SDK 不自动重试）与 `x-hh-limit-reset`（RFC 3339），Gemini 的错误体另带 `RetryInfo`；拒绝写入账本（`rejected: true`），按 Key 与原因节流。账本读失败时返回 503 `store_unavailable`。`GET /api/v1/gateway-keys/{id}/limit`（SDK `gatewayKeys.limit`，`hh key limit <id>`）给出每个预算本窗口的用量、剩余、在途请求与预留、重置时刻与时区；`PUT /api/v1/gateway-keys/{id}/quota`（`hh key quota <id> --budget PERIOD:tokens=N,cost=USD,cache-reads --rpm N` 或 `--clear`）替换限额，从下一个请求起生效。持有 Key 的客户端可以用这个 Key 自己读取 `GET /v1/harnesshub/limit`（Magpie 的 `/v1/magpie/limit`）：返回同样的内容，另加 `object: "gateway_key.limit"` 与 `limited`（有每分钟上限或预算时为 true），只包含这个 Key 自己的数据。存储迁移 6 把旧的 `tokensPerDay`（UTC 日，计入全部 token）改为计入缓存读取的日预算，`costPerMonthUsd` 改为月预算，窗口随之改为本地时区；值为 0 的上限原样保留，这些 Key 仍拒绝每次调用。旧备份中的这两个字段在恢复时同样转换。图像请求同样受预算约束，计数 token 不受。
- **`session:` Key**：处理函数的 `deps.sessions.activeRun(sessionId)` 给出该 Session 的活动 Run（`runId`、`generation` 与 Run 选定的目标，Model Ref 或 `group/<id>`）。没有活动 Run（或没有注入 `sessions`）时，调用返回 409 `no_active_run` 并写入拒绝记录。有活动 Run 时：请求的模型是别名 `harnesshub-model`、缺省或不是 Model Ref（引擎自己的模型名）都解析为该目标；名为其他 Model Ref 时仍按 `modelAllow` 检查，目标本身总是允许。账本记录带 `sessionId`、`runId` 与 `generation`；每条提交后的记录交给 `deps.sessions.committed`（在客户端收到终止事件之前，异常只写日志）。`/v1/models` 对这类 Key 额外列出别名，元数据取自目标。`handler.awaitSessionIdle(sessionId, {abort})` 是 Run 的结算屏障：等到该 Session 没有在途调用、且已结束调用的记录都已提交；`abort` 时先取消在途调用（账本 499 `client_cancelled`）。

### 模型解析与列表

- 请求的模型取自请求体的 `model`（Gemini 取路径中 `/models/` 之后到最后一个 `:` 之前的部分，图像请求同样取 `model`），是 Model Ref `provider/model`、`group/<id>`，或不带 `provider/` 的**裸名称**；provider 或组不存在为 404 `model_not_found`（不是拒绝记录）。provider 列表中没有的模型照常路由，元数据未知。
- **裸名称**（Magpie 的 `GroupFor` 与 `Resolve`，[bare-names.ts](../packages/gateway/src/bare-names.ts)），供不能写 `provider/model` 的客户端（部分 IDE 插件、写死 `gpt-5` 的脚本）使用，按顺序解析：ID 等于名称小写的路由组（用户组，或该 ID 的自动组），ID 等于名称规范名（`sameModel` 后 `slug`，与自动组相同）的路由组，规范名相同的未隐藏自动组；其后是只有一个 provider 在 `expose` 中提供的该 ID 的模型，再其后是只有一个 provider 列出的该 ID 的模型。解析只看这把 Key 能用的组与模型（`modelAllow` 与 `modelDeny`，组的全部模型都被 `modelDeny` 隐藏时也算不能用）：不能用的跳过，按顺序看下一步，所以名称不会因为指向 Key 不能用的东西而得到另一种答复（安全审查 L6）。几个能用的 provider 模型都有这个 ID 时不挑选（Magpie 取第一个），返回 400 `model_ambiguous`，消息只列出它们；什么都不匹配时 404 `model_not_found`，消息与名称指向 Key 不能用的东西时相同，也不说有几个。账本的 `requestedModel` 保留请求中的名称，`group` 或 `modelRef` 记录解析出的组或模型（被拒绝的调用也是）。`session:` Key 的裸名称仍指向 Run 的目标，Codex 透传中的裸名称仍是 ChatGPT 自己的模型，`count_tokens` 按同样的规则解析。`/v1/models` 不列出裸名称。
- **Agent 的替代模型**（Magpie 的 `StandIn`，[stand-in.ts](../packages/gateway/src/stand-in.ts)）：接线写入的 `agent:` Key 请求的名称解析不到任何东西时（不是路由组，裸名称没有匹配，或 Model Ref 的 provider 不存在），用该 Agent 接线时选的模型代替，只对 Claude Code 与 Codex，与 Magpie 相同。Claude Code 请求它自己的主模型时用主模型；否则名称中含 `opus`、`sonnet`、`haiku` 或 `fable`（依此顺序）时用该档位的模型，没有设置该档位时用主模型（Claude Code 的档位也跟随主模型）；其他名称用主模型。这让 Claude Code 为标题与小任务按内置 ID 请求的 `claude-haiku-…` 等到达所选档位。Codex 不在 ChatGPT 模式时用它接线的模型。解析得到的名称从不替代；`client:`、`session:` Key 与不是当前接线所写的 `agent:` Key 也不替代。被替代的调用在账本中保留请求的 `requestedModel`，`modelRef` 或 `group` 是替代的模型，`patches[]` 含 `stand-in`；Key 的允许列表用于替代的模型。
- wire 名依次取模型自己的 `wire`、provider `wire` 中该模型的条目、`*` 条目（`*` 替换为模型名），否则为模型名。
- 每个启用的 Credential 是一个候选。provider 声明了与入站相同的端点、不是 `translateOnly`、Credential 对该端点有效时直通；否则转换到 provider 的 Chat 端点；没有 Chat 端点时依次转换到它的 Anthropic、Responses 或 Gemini 端点。对 provider 的任何端点都无效的 Credential 被跳过；没有任何候选时返回 400 `unsupported_route`，消息列出被跳过的原因。
- **每个 Credential 自己的模型列表**（Magpie 的 `Model.Keys`）：同一 provider 的不同 Key 可能看到不同的模型（中转按套餐分组发 Key、OpenRouter 的 Key 等）。有两个以上启用的 Credential 能用于某个列表端点时（订阅账号除外），刷新模型列表用每个 Credential 分别请求它适用的第一个列表端点（Chat、Responses、Anthropic、Gemini 的顺序），合并成 provider 的列表：`models.listedFor` 是这次读到了自己列表的 Credential，每个模型的 `credentials` 是列表中有它的 Credential（全部都有时省略）。某个 Credential 这次读不到时保留它上次列出的模型（仍在 `listedFor` 中）；全部读不到时按失败处理，保留原列表并标记 `stale`。只有一个 Credential 时照旧只读一个列表，并清除 `listedFor` 与各模型的 `credentials`。路由时，`listedFor` 中的 Credential 若自己的列表没有所请求的模型（`credentialUnlisted`），就不作为候选，账本 `patches[]` 记 `credential:unlisted:<n>`；所有候选的列表都没有它时照样全部尝试（Magpie 的做法），记 `credential:unlisted:all`。不在 `listedFor` 中的 Credential（之后新增的，或列表从未读到的）与列表中没有的模型都算未知，照常尝试。`GET /api/v1/routing/state` 中每个读到了自己列表的 Credential 带 `unlistedModels`：provider 的模型中它的列表没有的那些。
- **Credential 的协议与模型是否相配**（Magpie 的 `keyFit`）：限定了协议的 Credential 按与请求的相配程度排序，配得最好的在前：没有限定协议的总是相配；Claude 模型（名称最后一段以 `claude` 开头）配可用 Anthropic 协议的，GPT 模型（以 `gpt-` 开头、含 `codex` 或 `o1`–`o9` 开头）配可用 Anthropic 以外协议的，否则为“为别家的模型而设”；其他模型配可用入站协议、且 provider 有该端点的，否则为“需要转换”。排序后，与第一个 Credential 限定的协议不同的 Credential 移到其余之后（在 `least-used`、`smart`、`pace` 组中排在加权的候选之后）。都不限定协议时顺序不变。
- 端点基址是该厂商官方 SDK 使用的基址，这是对 `ProviderConfig.endpoints` 注释中“不含操作路径”的明确约定，存储的基址校验按同一约定执行：Chat 与 Responses 含版本（OpenAI SDK 的 `baseURL`，如 `https://api.openai.com/v1`，拼接 `/chat/completions`、`/responses`）；Anthropic 不含版本（`ANTHROPIC_BASE_URL` 形式，如 `https://api.deepseek.com/anthropic`，拼接 `/v1/messages`）；Gemini 不含版本（`@google/genai` 的 `baseUrl`，拼接客户端所用的 `v1beta`、`v1` 或 `v1alpha`，再接 `/models/{wire}:{method}`，SSE 时带 `alt=sse`）。基址末尾的斜杠不影响结果。
- `GET /v1/models`、`GET /v1/models/{ref}`（`{ref}` 可含 `/`）与 `GET /v1beta/models` 只列出 Key 允许、且在 provider `expose` 中的模型，以及 Key 允许的路由组（含未隐藏的自动组）；全部模型（组中的组展开）都被 Key 的 `modelDeny` 隐藏的组不列出。每项含 `id`、`owned_by`、`context_window`、`max_output_tokens`、`reasoning`、`supported_reasoning_levels`、`input_modalities`（已知时）与 `native_endpoints`（`translateOnly` 时为空，路由组没有该字段）。推理模型的档位为 low、medium、high（元数据只记录模型会推理，不记录档位，与接线写入 Agent 的相同）。路由组按 core 的 `groupCapabilities` 从它的全部模型（组中的组展开）得出：最小的窗口与输出上限（都已知时），模态的交集（都已知时），档位为所有跟随请求的模型共有的档位，固定了 effort 的成员不缩小它；全部成员都固定时为它们固定的档位；有档位即 `reasoning: true`。接线写入 Agent 的模型清单用同一个函数。列表与计数不访问上游，也不写账本。
- **自动路由组**（Magpie 的 found groups，[auto-groups.ts](../packages/core/src/auto-groups.ts)）：两个或更多就绪的 provider（没有 Credential，或至少有一个启用的 Credential）在 `expose` 中提供同一个规范名的模型时，该模型也是路由组 `group/auto-<slug>`。规范名 `sameModel` 取小写、`_` 换成 `-`、只取最后一个 `/` 之后的部分、数字之间的 `.` 或 `p` 换成 `-`、去掉 `-YYYYMMDD`、`@YYYYMMDD` 与火山方舟的 `-YYMMDD` 快照日期；`slug` 只保留小写字母与数字，其余连续字符成为一个 `-`，截短到组 ID 的 63 个字符。成员是每个 provider 中第一个同名模型，按 provider 的创建顺序，策略 `order`、粘性 `auto`。自动组每次从 provider 派生、不存储；同 ID 的用户路由组优先；用户隐藏的 ID 存在 `hidden_auto_groups` 表中，隐藏的组既不列出也不路由（404 `model_not_found`）。Key 要在 `modelAllow` 中列出 `group/auto-<slug>` 才能使用；客户端可以直接用模型的名称请求它（见上文的裸名称）。Key 的 `modelDeny`（Agent 隐藏的模型）对组同样有效（安全审查 M4）：规划之后去掉 Model Ref 或所经的组被隐藏的成员，一个也不剩时 403 `model_not_allowed`（裸名称为 404，同上）。管理接口与 CLI 见下文“账本”。
- **`X-HH-Credential`**（Magpie 的 `X-Magpie-Account`）把一次调用钉在一个 Credential 上：按 ID 精确匹配，或按名称匹配（不区分大小写），路由组中所有成员的匹配都保留，其他 Credential 不会顶替。所有匹配都在休息时返回 429 `credential_resting`（消息给出到何时、因为什么，`retry-after` 截断到 60 秒），不访问上游；这次路由的某个候选的 Credential 匹配、但它的 provider 的模型列表非空而没有所请求的模型时返回 400 `credential_unserved`；没有候选的 Credential 匹配时返回 404 `credential_not_found`，消息列出这次路由可用的 Credential。候选之外的 Credential 即使存在也按不存在答复（同样 404），答复不向 Key 透露它用不到的 Credential。钉选的调用在 `patches[]` 中记 `credential:pinned`。这个请求头和其他客户端请求头一样不发往上游（直通只转发固定的几个头）。
- Anthropic `count_tokens`（[count.ts](../packages/gateway/src/count.ts)）按调用的规则解析模型（`session:` Key 的别名指向 Run 的目标，模型须在 `modelAllow` 内），取第一个直通 Anthropic 端点、熔断未打开的候选（路由组按配置顺序，不推进轮换），把 `model` 改写为 wire 名、换上该 provider 的 Credential 后转发到 `{anthropic 基址}/v1/messages/count_tokens`，占用该 Credential 的一个并发位，整个往返受上游响应头时限约束；返回上游的 JSON，响应头 `x-hh-token-count: upstream`（上游自己是估算时，例如级联的 HarnessHub，保留 `estimated`）。没有这样的候选、模型不允许、Credential 无法解析、连接失败、非 2xx 或答复中没有非负整数 `input_tokens` 时，返回本地估算，响应头 `x-hh-token-count: estimated`，原因以 `gateway.count.fallback` 写日志（不含请求体与 Key）。Gemini `:countTokens` 总是本地估算。计数不写账本。

### 直通与转换

- **直通**只改写请求体顶层的 `model` 字符串（原位替换，其他字节不变，包括键序、空白和未知字段；Gemini 请求体不变，wire 名进入路径），去掉 HarnessHub 的鉴权头，按 `auth.apiKeyHeader` 加上 provider 的 Credential（`query-key` 写入 URL），再加上 provider 的 `headers`。客户端的 `anthropic-version`（缺省补 `2023-06-01`）、`anthropic-beta`、`openai-beta` 与 `user-agent` 被转发。
- 已实现的补丁：Chat 的 `developer-to-system`、`max-tokens-field`（双向：把另一个输出上限字段改名为 `maxTokensField` 指定的 `max_tokens` 或缺省的 `max_completion_tokens`）、`drop-fields`、`include-usage`、`json-schema-to-json-object`；各协议的 `drop-fields`；Chat 与 Responses 的 `merge-system-messages`（system 与 developer 消息合并为第一条，Responses 合并进 `instructions`；翻译时本来就合并）；Anthropic 的 `anthropic-beta-allow`（只转发列出的 beta 值）、`anthropic-strip-beta-fields`（直通时只保留正式 API 的顶层字段 `model`、`messages`、`max_tokens`、`system`、`metadata`、`stop_sequences`、`stream`、`temperature`、`top_k`、`top_p`、`tools`、`tool_choice`、`thinking`，并把 `messages` 中的 `system` 消息移入顶层 `system`；`merge-system-messages` 只做后一项）。各家 Anthropic 兼容 API 的预设声明 `anthropic-strip-beta-fields`，Anthropic 自己的预设不声明，它的直通仍按字节转发。任何补丁生效时请求体改为解析后重新序列化，实际生效的补丁写入 `patches[]`。`thinking-off-unless-asked`、`lift-additional-tools`，以及声明在不适用端点上的补丁，会使该候选以 500 `patch_unsupported` 跳过，不静默忽略。
- 直通响应按完整的 SSE 事件或 Gemini 数组元素转发，字节不变；旁路解析首内容、usage、served model、终止事件与流内错误。第一个数据事件之前的注释与空事件先缓存，因此此前的超时仍以真实状态码返回；Gemini 客户端收不到上游的 SSE 注释。Gemini 上游在事件之间发出的裸 JSON 错误对象按流内错误处理。上游的流内错误不原样转发，而是改写为该协议格式、经过脱敏的错误；上游 HTTP 错误同样按入站协议格式重写，带 `x-hh-error-source: upstream`。
- **转换**以 Chat 形态的请求与流为枢纽：入站转换器把请求转成 Chat 请求并规范化；上游是 Chat 时直接发送，否则由编码器（[encode.ts](../packages/gateway/src/encode.ts)）转成 Anthropic Messages、Responses 或 Gemini `streamGenerateContent`（总是流式，Gemini 用 `alt=sse`）；解码器（[decode.ts](../packages/gateway/src/decode.ts)）把这些协议的流或 JSON 响应变成 Chat 块，经同一个工具调用累积与结束原因规范化，交给入站协议原有的输出（含保活与 Gemini 响应头提交期限）。与 Session 网关的差别：默认不去掉任何参数、不把 `json_schema` 降级（只由补丁触发）、总是请求 Chat 上游的 `stream_options.include_usage`；模型的 `maxOutputTokens` 限制输出上限；模型声明图片输入时图片作为 Chat 的 `image_url` 保留（否则仍是文字占位）；provider 声明 `requiresReasoningReplay` 或上游是 Anthropic 时，按 Gateway Key 缓存并回填推理文本。2xx 却没有任何数据事件为 502 `upstream_invalid_response`。
- 入站转换器另外带出客户端的推理请求（Chat `reasoning_effort`、Responses `reasoning.effort`、Anthropic `thinking`、Gemini `thinkingConfig`）与标记为错误的工具结果（Anthropic `is_error`、只有 `error` 的 Gemini `functionResponse`），编码器按目标协议使用：
  - **Anthropic**：首条 system 消息成为 `system`；工具结果成为用户轮中领先的 `tool_result` 块，带 `is_error`；base64 与 URL 图片；`stop` 成为 `stop_sequences`，`temperature` 截到 1，`parallel_tool_calls: false` 成为 `disable_parallel_tool_use`；`max_tokens` 依次取请求、模型的 `maxOutputTokens`、默认 4096（`anthropicMaxTokens` 是唯一的解析处，非请求来源记为补丁 `max_tokens:model` 或 `max_tokens:default`）；请求头带 `anthropic-version: 2023-06-01`。有推理请求时开启 `thinking`（预算取请求值或按 effort 换算，限制在 1024 与 `max_tokens - 1` 之间），并去掉 `temperature`、`top_p` 与强制工具选择（记为补丁）。历史中的推理只有找到同一 provider 为该文本签发的签名时才作为 `thinking` 块回传，否则丢弃并记入 `unmapped`；正在进行的工具轮缺少已签名的推理时不开启 `thinking`（补丁 `thinking:off:unsigned_history`），因为 Anthropic 会拒绝。
  - **Responses**：无状态请求（`store: false`）；system 成为 `instructions`，工具调用与结果成为 `function_call` 与 `function_call_output` 项；函数工具除非 Chat 工具要求严格模式，否则以 `strict: false` 发送；`response_format` 成为 `text.format`；推理请求成为 `reasoning.effort`，并要求 `summary: auto` 以便流回推理文本。同一 provider 在某个工具调用之前返回的推理项（`id`、摘要与加密内容）按 Gateway Key 缓存，在下一轮原样放回该助手轮之前（排在其文本与 `function_call` 项之前），此时历史推理不记入 `unmapped`；没有该 provider 的推理项时，历史推理、`stop` 与工具错误标记无法携带，记入 `unmapped`。推理未关闭、且请求要求推理、模型元数据声明推理或本轮放回了推理项时，请求 `include: ["reasoning.encrypted_content"]`。
  - **Gemini**：system 成为 `systemInstruction`，工具成为 `functionDeclarations`；JSON Schema 只保留 Gemini 接受的关键字（类型转为大写，含 `null` 的类型联合成为 `nullable`，`const` 成为单值 `enum`，`oneOf` 成为 `anyOf`），去掉的关键字以 `schema.<关键字>` 记入 `unmapped`；工具结果成为以所答调用命名的 `functionResponse`，工具错误为 `{error}`，JSON 对象结果原样作为 `response`；base64 图片成为 `inlineData`，图片 URL 无法发送；推理请求成为 `thinkingConfig`（关闭时 `thinkingBudget: 0`）。同一 provider 在函数调用上签发的 `thoughtSignature` 按调用 id 缓存，下一轮回传。
- 解码器把推理（Anthropic `thinking`、Responses 推理摘要与推理文本、Gemini thought 部分）交给入站协议的推理块；签名、加密推理与 redacted thinking 从不转发给其他协议的客户端，redacted thinking 与服务端工具块记入 `unmapped`。结束原因：`end_turn` 与 `stop_sequence` 为 `stop`，`max_tokens` 为 `length`，`tool_use` 为 `tool_calls`，`refusal` 与 Gemini 的安全类原因为 `content_filter`，Responses 的 `incomplete` 按原因映射，其他值原样保留；Gemini `MALFORMED_FUNCTION_CALL` 为 502 上游错误。usage 换算为同一口径：Anthropic 的缓存读写、OpenAI 的缓存与推理 token、Gemini 的缓存与 thoughts 都进入账本对应的字段。各协议的上游错误（含流内错误事件）按入站协议的错误格式返回，规则同直通。
- 签名缓存按 Gateway Key 分开（每个 Key 512 条，最多 1024 个 Key），只对签发它的 provider 返回。Responses 推理项以工具调用的 id 与“名称加参数”哈希为键存入同一缓存，同样只对签发它的 provider 返回。

### 路由、重试与熔断

- **路由组成员**（[route-groups.ts](../packages/core/src/route-groups.ts)，Magpie 的 `group.go`、`groupeffort.go`、`groupfast.go`）：`provider/model`；`provider/model:<effort>`（`none` 到 `max`）把该成员固定在这个推理强度，无论请求要的是什么，同一模型的不同强度是不同的成员；最后加 `:fast` 时以厂商的快速模式发送（api.openai.com 上 GPT 与 o 系列模型、ChatGPT 账号的 GPT 模型为 `service_tier: "priority"`，api.anthropic.com 上有快速模式的 Claude Opus 为 `speed: "fast"` 并加 `anthropic-beta: fast-mode-2026-02-01`；其他上游照常发送，原因记在候选的 `skipped` 中）；`group/<id>` 是另一个组（用户组或可见的自动组），最多嵌套 8 层，不能包含自身。provider 列出的含冒号的模型 ID（`deepseek-r1:free`、`qwen:7b`）不拆分。写入时校验这些规则并把后缀转为小写；被其他组用作成员的组不能删除，被用作成员的自动组不能隐藏（409 `ROUTE_GROUP_IN_USE`）。固定的 effort 在 Chat 直通时写入 `reasoning_effort`，Responses 直通时写入 `reasoning.effort`，Anthropic 与 Gemini 请求为此改为转换（上游编码器按该强度设置思考预算），账本 `patches[]` 记 `member-effort:<level>`、`fast:service-tier` 或 `fast:speed`；强度原样发送，不按模型可用的档位调整。
- **路由组规则**（[route-rules.ts](../packages/core/src/route-rules.ts) 校验与匹配，[rules.ts](../packages/gateway/src/rules.ts) 在请求时决定，Magpie 的 `grouprule.go`、`ruleparse.go`、`gw/rules.go`，[ADR 0032](decisions/0032-group-rules-and-classifier.md)）：`rules[]` 的每条规则把命中的请求先交给 `use`（组的一个成员），条件全部满足才命中，取第一条命中的规则。条件有：`tokens`（请求文本字符数除以 4，不计 base64 媒体与封存的推理；厂商上次计数的输入更大时取它）；`images`（本轮或之前带图片）；`effort`（Agent 要求的推理至少到这一档，`on` 为任意推理）；`agents`（账本的 Agent ID）；`intent`（分类器判断本轮第一条消息属于这种意图）；`compact`（压缩请求，由 `isCompactionRequest` 识别）；`time`（一轮开始时处于守护进程本地时区的这段时间与这几天，`to` 早于 `from` 时跨午夜，归属开始那天）。
  - 一轮开始时做决定，以工具结果结尾的请求沿用这一轮的决定。网关没见过开头的一轮不改变（`rule:waits`）。唯一例外：请求达到当前成员窗口的 95%（没有规则命中时取最小成员的窗口），且第一条命中的规则指向窗口更大的成员时换过去（`rule:grown:<n>`）。
  - 压缩请求单独按 `compact` 规则路由，跳过窗口小于请求的成员，不改变本轮决定、粘性记录与厂商计数。
  - 新的一轮里，规则的成员排在粘性保留的候选之前（首个候选因此改变时为 `sticky:broken:rule`），之后是后面同样命中的规则的成员，最后是组的其他候选；同一轮内粘性优先。规则的成员没有就绪的候选时记 `rule:unready`。组中的组有规则时，沿排在最前的成员逐层决定，记为 `rule@<组>:<n>`。
  - **分类器**（`classifier`，[classify.ts](../packages/gateway/src/classify.ts)，Magpie 的 `gw/classify.go`）只在新一轮开始、且可能最先命中的规则需要意图（或组为 `effort: "auto"` 且 Agent 要求了推理）时询问：经网关自己的内部 Chat 调用（`temperature: 0`、`max_tokens: 2048`、8 秒超时），账本中是 Agent 为 `harnesshub-classify`、`purpose` 为 `classify` 的单独条目，记在本次请求的 Key 名下，计入它的预算与每分钟请求数，也受它的局域网规则约束（[内部调用](decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下)）。路由组的分类器经组授权，视觉模型经 Key 自己的白名单授权：能使用这个组的 Key 就能询问组的分类器，与组成员一样，因为它的回答只决定组成员的排序、不会交给客户端；只有 Key 的 `modelDeny` 列出分类器模型时被拒绝。用户消息中的 `<`、`>` 在提示词里转义；回答必须只是一个数字（前后可有空白）。同一消息的回答保留 10 分钟（`classifier:cached`）；分类器联系不上（超时、连接失败或 5xx）后 30 秒内不再询问（`classifier:resting`），这期间意图不命中、组按自己的顺序路由；回答不是单独的数字、或被拒绝（4xx，例如 Key 的预算用完）时也不命中，但不冷却。意图规则是路由提示，不是安全边界：用户消息可以影响分类结果，但只能在组成员之间选择。`effort: "auto"` 时分类器从 low 到 xhigh 选一档，发给没有固定档位的候选（`effort:auto:<level>`），整轮沿用。分类器自己的调用不再询问分类器。分类器与成员共用 Credential 时，它的失败也会让该 Credential 休息。
  - **组宣称的能力**（core `ruledCapabilities`，Magpie 的 `ruledEntry`）：`/v1/models` 与接线目录在组模型共有的能力之上加入规则能保证的两项。图片：一条只有 `images` 条件的规则把带图片的请求交给其模型都接受图片的成员，且它之前每条规则的成员也都接受图片。更大的窗口：一条只有 `tokens` 条件的规则把至少这么长的请求交给窗口更大的成员，且其他窗口已知的成员都能接受到该长度的请求；窗口取这个成员的，但不超过它之前每条规则的成员的窗口（之前某条规则的成员窗口未知时不放大）。成员的窗口是其模型中已知的最小窗口。
  - **路由决定**（[trace.ts](../packages/gateway/src/trace.ts)，Magpie 的 route trace 与 `/v1/magpie/route`）：路由组的请求在一轮开始时（或规则在一轮中把它换走、压缩请求单独路由时）发布一条决定，在询问厂商之前；调用结束时再更新一次。决定包含规则（请求的组在前，其后是组中组：命中第几条、条件、后续成员、是否未就绪、分类器的意图与是否来自缓存或冷却）、分类器选的档位、粘性（`hit`、`miss:<原因>`、`broken:rule` 等）、按尝试顺序的候选（最多 20 个），以及结束后的状态与应答的候选。同一轮内的工具结果、内部调用（分类器、图片描述、搜索）与直接请求 Model Ref 不发布。只保存在内存中，保留最近 256 条，不含提示词或回答的文字。`GET /api/v1/routing/decisions?session=&after=&wait=`（管理令牌，SDK `routing.decisions`）返回 `seq` 大于 `after` 的决定（从旧到新，`session` 为会话键或 HarnessHub Session），没有时最多等待 `wait` 秒（不超过 60），客户端断开或守护进程关闭时提前返回；`after` 大于最新的 `seq`（网关重启过）时从头返回。
  - 决定写入 `patches[]`：`rule:<n>`、`rule:none`、`rule:held:<n|none>`、`rule:waits`、`rule:grown:<n>`、`rule:compact:<n|none>`、`rule:unready`、`classifier:asked|cached|failed|resting`、`effort:auto:<level>`。决定只保存在内存中，按组、会话与会话第一条用户消息的哈希区分，与粘性记录一样保留 24 小时。
- 单个 Model Ref 的候选是该 provider 的 Credential；路由组按策略排列（[routing.ts](../packages/gateway/src/routing.ts) 的 `planGroup`）：组中的组按它自己的策略排好，作为一个整体：`order`、`rotate`、`latency` 下按成员顺序放在它的位置上，`least-used`、`smart`、`pace` 下与本组模型的各个 Credential 一起排序，以它第一个未休息的候选代表整体；同一模型、同一强度、同一 Credential 只保留第一次出现的位置。排序规则：`order` 按配置；`rotate` 每次调用从下一个成员开始；`latency` 取首内容时间指数平均最小的成员，样本少于 5 次的成员优先，只统计本处理函数启动以来的调用；`least-used`（Magpie 的 `usage`）把所有成员的 Credential 放在一起排序：先按上游最近一次答复的限流头中已用的比例（取尚未到重置时间的窗口中最满的一个，取整到百分点；OpenAI 的 `x-ratelimit-{limit,remaining,reset}-*` 与 Anthropic 的 `anthropic-ratelimit-*-{limit,remaining,reset}` 都按此读取，没有读数时为 0），再按该 Credential 服务的 token 数（五项之和，成功的调用至少计 1，每小时减半），都相同时保持配置顺序。处理函数启动时从账本读取最近 8 小时、至多 5000 条成功调用作为初值；`least-used` 的组在初值读完之前等待，读取失败写日志 `gateway.usage.seed_failed`，初值为空。`smart` 与 `pace`（Magpie 的同名路由）按 Credential 的额度读数排序，规则与读数来源见 [订阅账号](subscriptions.md#额度读数与-smartpace)；读数（含上述限流头）由 `deps.allowances` 保存与读回。2026-10-05 之前网关只对 `least-used` 组排序，`smart` 与 `pace` 组实际按配置顺序尝试。
- **订阅 provider**（`ProviderConfig.subscription`，[订阅账号](subscriptions.md)）：每个 Credential 是一个账号，只有接受了当前风险告知且已登录的账号成为候选（否则跳过并说明），总是转换到该后端的端点（ChatGPT 套餐：Responses，按 `siwc` 编码，令牌经 `deps.subscriptions` 取得；Copilot：没有端点，Chat 请求交给 `deps.copilot` 的会话，见 [订阅账号](subscriptions.md#github-copilot)）。带 `allowLan` 的 Key 看不到、也用不到订阅 provider 的模型。
- **粘性**（[sticky.ts](../packages/gateway/src/sticky.ts)）让同一会话留在上次应答的 Credential，以保持上游提示缓存与推理签名有效。会话键依次取 `x-hh-conversation` 请求头、客户端自带的标识（Chat 与 Responses 的 `prompt_cache_key`，Anthropic `metadata.user_id` 中的 `session_…` 部分），否则为 system 文本加第一条用户消息的哈希；所有会话键都按 Gateway Key 隔离。请求以工具结果结尾（Chat 的 `tool` 消息、Responses 的 `function_call_output`、Anthropic 的 `tool_result`、Gemini 的 `functionResponse`）时视为同一轮之内。模式取路由组的 `stickiness`，单个 Model Ref 为 `auto`；`session:` Key 在 `auto` 时改为 `session`：
  - `auto`：同一轮内总是留下；跨轮只有上次调用读取了至少 1024 个缓存 token、且距今不到 5 分钟才留下。
  - `session`：总是留下；`turn`：只在同一轮内留下；`off`：不粘。
  - 留下的候选排到最前，其余按策略的顺序跟在后面；它的熔断打开或已不在候选中（白名单、组成员或 Credential 变化）时粘性被打破，按策略路由。
  - 有多个候选时，决定写入 `patches[]`：`sticky:hit`、`sticky:miss:<new|model_changed|cache_cold|new_turn>` 或 `sticky:broken:<breaker|unavailable>`；账本合约还没有专门的粘性字段（后续合约变更）。成功的调用更新记录。记录只在内存中保存最近 512 个会话、24 小时，守护进程重启后重新开始。
- **失败类别**（[routing.ts](../packages/gateway/src/routing.ts) 的 `failureKind`，按 Magpie `failure()` 的顺序，各词表集中在 `FAILURE_WORDS`）由状态码与上游错误体判断，错误体只用于分类，不保存。最先判断安全过滤器的拒绝（Magpie `policyRefusal`，429 以外的任何状态，流内错误映射成的 5xx 也算）：错误的 `code` 或 `type` 是过滤原因（`refusal`、`content_filter`、`content_policy_violation`、`SAFETY`、`PROHIBITED_CONTENT`、`BLOCKLIST`、`SPII`、`IMAGE_SAFETY`）或 `<名称>_policy`（如 OpenAI 的 `bio_policy`），或 `invalid_prompt` 且说明被标记为违反使用政策，为 `policy`。然后：502 且含 `proxyconnect ` 或 `socks connect ` 为 `proxy`；401、403 且为 Google 的 `VALIDATION_REQUIRED` 或要求验证账号的措辞为 `verify`；402、429 以外带余额措辞、或含 `insufficient_quota` 为 `credit`；429 带限流措辞（`rate limit`、`too many requests`、每秒或每分钟、`RPM`、`频率` 等）而不带套餐措辞（`quota`、`usage limit`、每天、每周、每月、`额度`、`套餐` 等）为 `rate`；带用尽措辞（`quota`、`usage limit`、`limit reached`、`额度`、`上限` 等）、或 429 带套餐措辞为 `quota`；其余 429 为 `rate`。之后 401、403 为 `auth`；404 为 `model`。400 与 422 按 Magpie 的 `retryable` 与 `shapeRefused` 判断，但先排除对所有 provider 都是客户端自己错误的请求（`clientFault` 词表：缺少必填字段、`field required`、消息为空或缺失、JSON 解析错误等），它们为 `request`；其余依次为：模型不存在措辞为 `model`；“拒绝这个渠道”的措辞（`unapproved channel`、`illegal api invocation`）为 `refused`；Magpie `quotaWords` 中余额与用尽以外的措辞（`overloaded`、`too many requests`、400 的 `rate limit`、`限流`、`频率` 等）为 `other`；请求形状措辞（`failed to deserialize`、`unknown parameter`、`unknown variant`、`unrecognized … parameter`、`extra inputs are not permitted` 等）为 `shape`；都不是则为 `request`。408 与 5xx 为 `other`；其余（包括上下文超长，它先于分类判断）为 `request`。连接失败与超时属于 `other`；守护进程自己的出站代理连不上、拒绝隧道或不应答时（[出站代理](configuration.md#出站代理)）属于 `proxy`，不在同一候选上重试，也不计入该凭据的熔断。尝试与调用的 `errorClass` 按类别为 `proxy_failed`、`verification_required`、`auth_failed`、`insufficient_balance`、`quota_exhausted`、`rate_limited`、`model_not_found`、`upstream_timeout`（408、504 与超时）或 `upstream_unavailable`、`upstream_unreachable`（连接失败）、`context_length_exceeded` 或 `upstream_rejected`，新增的三类为 `safety_refused`（`policy`）、`client_refused`（`refused`）与 `request_shape_unsupported`（`shape`）。
- **休息**：熔断以 Credential 为单位，失败按类别让它休息：`credit` 与 `verify` 30 分钟；`quota` 到厂商说明的重置时间（错误体中 Claude Code 的 `limit reached|<Unix 秒>`、ChatGPT 的 `resets_at` 或 `resets_in_seconds`、Google 的 `RetryInfo.retryDelay`，其次是响应头的等待），否则 15 分钟，最长 8 天；`rate` 取响应头的等待，否则 1 分钟；`auth` 10 分钟，Credential 引用变化时立即结束；`model` 只标记该 Credential 与模型 10 分钟；`proxy`、`policy` 与 `shape` 不休息（Credential 本身没有问题）；`refused` 与 `other` 一样计入熔断；`other` 连续 3 次计入的失败后打开，60 秒起每次重新打开翻倍，上限 10 分钟。响应头的等待依次取 `retry-after-ms`、`retry-after`（秒或 HTTP 日期）、名称同时含 `ratelimit` 与 `reset` 的头中最晚的重置（RFC 3339、`6m0s` 形式的时长或 Unix 秒），最长 1 小时。休息到期后半开，放行一个探测请求，成功则关闭、计入的失败则再次打开；成功的调用随时结束休息。所有候选都在休息时不访问上游，返回最近一次失败的状态与类别（`All candidates are cooling down; the last failure was <errorClass> (HTTP <status>)`），不引用上游的错误文字，因为它可能是另一把 Key 的请求得到的。
- **休息不受请求左右**（安全审查 H2）：厂商的错误可能回显请求自己的字段名或值（OpenAI 的 `Unrecognized request argument supplied: <name>`），所以决定休息的类别从去掉请求自身词语的错误体判断（[routing.ts](../packages/gateway/src/routing.ts) 的 `echoFree`：请求的字符串值与键中的词，不分大小写，CJK 逐字；`model` 与错误 JSON 的键 `error`、`message`、`code`、`type`、`status` 始终保留，单独不构成任何类别），这次请求自己的转移仍按完整的错误体；账本的 `errorClass` 同样按去掉回显后的类别（安全过滤器的拒绝除外，它只读厂商的结构化 code，回显造不出来）。400 与 422 中的“模型不存在”只读厂商的 `error.message` 或 code `model_not_found`，不读错误体的其余部分：回显整个请求的中转把 `"model"` 键与错误类型 `invalid_request_error` 中的 invalid 放在一起，曾被读成模型不存在（第三轮安全审查 N1）。去掉的词可能比回显多（提示词与厂商的措辞共有的词），只会让休息变短或没有。Claude Code 的 `limit reached|<Unix 秒>` 是自由文本，只在 429 或订阅账号的答复中读取，同样去掉请求的词；`resets_at` 等结构化字段照常读取。一把 Key 的一次失败最多让共享的 Credential 休息 1 分钟（`PROVISIONAL_MS`）：更长的休息先休息 1 分钟，到期后的探测来自另一把 Key 并再次得到这类失败时才给完整时长；同一把 Key 的探测再给 1 分钟。模型标记更进一步：一把 Key 的失败设下的 1 分钟暂定标记只对这把 Key 生效，其他 Key 照常访问，其中一把再次得到模型不存在时才对所有 Key 标记完整的 10 分钟，所以一把 Key 不能每分钟发一次请求就让别人一直用不了这个模型（第三轮安全审查 N1）。只有一把 Key 时，额度用完的 Credential 每分钟被探测一次。
- **转移与重试**：`request` 类失败直接返回客户端。其他失败只要后面还有不在休息中的候选，就立即转移，不等待。`shape` 转移时跳过其余同一 provider、同一上游协议的候选（同一个 API 读不懂的形状再问一次也读不懂），只问别的 API；`policy`（安全过滤器的拒绝）转移时去掉其余同一厂商（端点主机相同，含同一 API 上的其他 provider）的候选，不把被标记的提示再发给这个厂商的其他账号，一次调用至多再问一个别的厂商，第二次拒绝即返回；一把 Key 在 10 分钟内被拒绝超过 5 次（`POLICY_FAILOVERS`）后，它的拒绝不再转移（安全审查 M2，取舍见 [ADR 0025 修订](decisions/0025-magpie-routing-parity.md#修订2026-10-05第二轮安全审查)）。400 的错误体说出回复长度下限时（Magpie `tokenFloor`：`max_tokens must be greater than 2`、`Expected >= 16` 等，最多 1024），若本次请求要求的长度（`max_tokens`、`max_completion_tokens`、`max_output_tokens` 或 Gemini 的 `generationConfig.maxOutputTokens`）低于它，同一候选立即重发一次，此后这次调用的每个请求都至少要求这么长，账本记 `max-tokens:floor:<n>`；没有要求长度或已经够长时这个 400 说的是别的事，照常返回。上游 2xx 应答、但回答是安全过滤器的拒绝且什么都没说（Chat 的 `content_filter`、Anthropic 的 `refusal`、Responses 的 incomplete `content_filter`、Gemini 的 `SAFETY` 等，没有文字、推理或工具调用），而客户端还没收到任何字节时，按 400 的 `policy` 失败处理（Magpie `refusedReply`）：按上面的规则转移；没有候选时客户端得到这个 400，而不是一个它会再发一遍的空回答（Magpie #248）。被丢弃的拒绝回答也用了 token（厂商照常计费）：它的 usage 与成本计入这次调用的账本记录，从而计入 Key 的预算，`patches[]` 记 `refused:usage:<n>`（安全审查 M3）。只有最后一个还能尝试的候选（其后的候选都在休息）才在原处重试（Magpie `passing`）：`rate`、408、500、502、503、504、529 与连接失败可以重试，等待响应头超时最多重试 1 次。第 n 次重试（从 0 起）等待 `baseBackoffMs × 2^n`，默认 1、2、4 秒，或响应头给出的等待；计算出的等待超过 `maxBackoffMs`、响应头的等待超过 `retryAfterWaitCapMs`（默认都是 8 秒），或本次调用的等待合计会超过 30 秒时不再重试，把失败返回客户端（429 的 `retry-after` 截断到 60 秒，Gemini 在错误体中写 `RetryInfo`）。`other` 的第三次连续失败打开熔断后不再重试，所以 5xx 最多重试 2 次、`rate` 最多 3 次（Magpie 的 `lastRetries` 与 `rateRetries`）；`rate` 的重试不受它自己刚开始的休息限制。重试次数上限是组的 `retry.perCandidate`（默认 3），`totalAttempts` 默认 4、不超过 8，单个 Model Ref 使用默认值；没有抖动。客户端断开或 `close()` 立即停止，不再发起尝试。直通与各种转换路由的重试、转移、扣留与休息相同。
- **首字节前扣留**：还有替代路径（其他可尝试的候选，或最后一个候选剩余的重试）时，流式输出在第一个内容事件（文本、推理或工具调用）之前被扣留，最多 `holdMs`（15 秒）或 `holdBytes`（1 MiB）；扣留期间不发保活，期间的流内错误按首字节前失败处理。首字节送达客户端之后的任何失败只在流内报告，不重试、不转移。
- **共享网关的保活**：转换与直通的流都按入站协议保活（形式同上表，[ADR 0029](decisions/0029-protocol-suite.md)）。上游已 2xx 应答、但在首个数据事件之前只发注释时，没有扣留输出的调用在保活到期时先提交响应（转换路径写出入站协议的开头事件，直通路径提交响应头），再写保活；有替代路径时扣留期间仍不发。直通流的保活由网关合成：Chat 为空 delta 块，Responses 为 `response.in_progress`（上游与之前的保活都没有发出 `response.created` 时先补一个，`sequence_number` 可能与上游的重复），Anthropic 为 `ping`，Gemini 为空 candidate（JSON 响应为空白）。上游的注释在首个数据事件之后照常转发（Gemini 除外），此时它们本身就让客户端收到字节。

### 账本

每个进入网关的模型调用提交一条 `ModelCallEntry`：`attempts[]`（候选、开始时间、上游首字节、状态、错误类别、`Retry-After`、决定与退避）、按协议规范化的五项 usage（无上报时 `source: missing` 且各项为 0）、`timing`（`durationMs`；已写出字节时的 `firstByteMs`；首内容时的 `firstContentMs`）、`status`、`errorClass`、`errorSource`、脱敏后的 `error`、`patches[]`、`mode`、`servedModel`、`finishReason`（直通与转换用同一套取值：`stop`、`length`、`tool_calls`、`content_filter` 或上游自己的值；回答中有供客户端执行的工具调用时为 `tool_calls`，即使上游以 Responses 的 `completed`、Gemini 的 `STOP` 或 Chat 中转的 `stop` 结束）、`completion`（`explicit` 或 `inferred`）。`cost` 只在 provider 模型声明了价格、且每个用到的 token 类别都有价格时计算（推理按输出价格），否则为 null。`unmapped[]` 列出转换到其他协议时丢弃的请求字段与内容（如 `reasoning`、`stop`、`schema.additionalProperties`）以及无法转给客户端的响应块（如 `response.redacted_thinking`）；直通与转换到 Chat 上游时为空。

**先提交后发布**：流式响应的终止事件（`[DONE]`、`response.completed` 或 `response.incomplete`、`message_stop`、带结束原因的 Gemini 块及其后的内容、数组的 `]`）与非流式响应体在 `appendModelCall` 成功之后才写出。同时到达的账本记录合成一个事务提交（组提交，见[性能基准](../tests/perf/README.md#账本提交)），每条记录的写入仍在它自己的记录持久之后才算成功。提交失败时，尚未写出响应头则返回 503 `evidence_unavailable`，否则在流内写出该错误且不写终止事件。每个调用至多追加一条记录。

每条记录另有调用归属：`conversationKey` 是粘性会话键（按 Gateway Key 隔离的 SHA-256，不含客户端原始标识），进入路由的调用都有，被拒绝的调用没有；`agent` 是 `{id, source}`，`agent:` Key 的 adapter 记为 `source: key`，否则按 User-Agent 的产品名推断（`claude-cli`、`codex…`、`GeminiCLI`、`QwenCode`、`KimiCLI`、`opencode`、`crush`，见 [agents.ts](../packages/gateway/src/agents.ts)）并记为 `user-agent`，Codex 透传记为 `route`；不认识的 User-Agent 不记录。网关为一次请求自己发出的调用（描述图片、询问分类器）是单独的条目，记在该请求的 Key 名下（`keyId`、`scope` 与 Session），`agent` 为 `harnesshub-vision` 或 `harnesshub-classify`（来源 `route`），`purpose` 为 `vision` 或 `classify`。

账本表 `model_calls` 自迁移 5 起另有 `credential_id`、`conversation_key` 与 `agent` 三列（迁移前的行从记录中补 `credential_id`，从 `agent:` Key 的 adapter 补 `agent`）；记录本身是权威，这些列只服务过滤与汇总。`GET /api/v1/conversations` 按会话汇总调用（`calls`、`failedCalls`、`usage`、`cost`、`unpricedCalls`、`firstAt`、`lastAt`、`models`、`credentials`、`agents`），最后活动的在前、游标分页，过滤同 `/model-calls`（含 `agent`）；`GET /api/v1/conversations/{key}` 返回单个会话的调用；`GET /api/v1/usage?groupBy=credential` 按 `<provider>/<credentialId>` 汇总。CLI 为 `hh usage --by conversation [--agent A]` 与 `hh usage --by credential`。自动路由组由 `GET /api/v1/auto-groups` 列出（含 `hidden`），`POST /api/v1/auto-groups/{id}/hide` 把 ID 写入 `hidden_auto_groups` 表，网关随后不再列出、也不再路由它，`POST /api/v1/auto-groups/{id}/restore` 恢复；CLI 为 `hh group auto`、`hh group hide <id>` 与 `hh group restore <id>`（见 [模型平面接口](model-plane-api.md)）。

### 局域网共享

守护进程默认只在回环地址监听。开启局域网共享后，它另外在声明的地址上开一个局域网监听器（[lan-share.ts](../packages/daemon/src/lan-share.ts)），只把模型协议路径交给网关的 `lan` 入口；其他路径（`/api/v1`、`/v1` 下的旧管理接口、健康检查、`/openapi.json`、控制台）在它上面都不存在，返回 404 `route_not_found`；不规范的路径在这之前就以 400 `path_not_canonical` 拒绝（见上文“共享网关”）。

- **设置**：`{lan: {enabled, host, port, names}, publicBaseUrl}`，由 [sharing.ts](../packages/gateway/src/sharing.ts) 的 `resolveGatewaySharing` 解析（默认关闭；开启时 `host` 必填，必须是本机 IP，`0.0.0.0` 或 `::` 表示全部地址，此时需要 `names` 或 `publicBaseUrl`；`port` 缺省为守护进程端口，0 表示由系统选择；`names` 是对端使用的其他主机名，最多 20 个；`publicBaseUrl` 是反向代理后的对外地址，不含凭据、查询与片段）。设置保存在 `<dataDir>/gateway-sharing.json`（`schemaVersion: 1`，原子替换），由 `GET`、`PUT /api/v1/gateway/share` 与 `hh gateway share status|on|off` 读写；文件无效时守护进程以 `INVALID_CONFIG` 拒绝启动。
- **生效**：`PUT` 先绑定新地址，再写文件，最后关闭旧监听器；绑定失败返回 409 `GATEWAY_SHARE_LISTEN_FAILED`，设置不变。新旧地址重叠时先关闭再开启。关闭后在途请求继续到结束，新请求被拒绝。启动时已开启的设置在守护进程自己的监听器绑定之后才监听；此时绑定失败不阻止启动，原因写入 `gateway.lan.listen_failed` 日志并在状态的 `error` 中显示，仍可以修改或关闭共享。守护进程关闭时先关闭网关（中止在途调用），再关闭局域网监听器。
- **Key**：局域网监听器上的每个请求都必须带 `allowLan: true` 的 `client:` Key（`hh key create --lan`，`POST /api/v1/gateway-keys` 的 `allowLan`），不论对端地址；其他 Key 返回 403 `source_not_allowed`，共享关闭时（监听器正在关闭）所有请求也是如此。`allowLan` 的 Key 必须有过期时间。`allowLan` 只能出现在 `client` 作用域上（`isGatewayKeyRecord` 校验）。
- **Host 与 Origin**：局域网监听器接受的 Host 是 `host:端口`（`host` 不是全部地址时）、每个 `names` 加端口，以及 `publicBaseUrl` 的主机；回环监听器接受回环名称与 `publicBaseUrl` 的主机。两个监听器都拒绝任何带 `Origin` 的请求（包括它们自己的源）与 `Sec-Fetch-Site: cross-site`：网关接线的客户端都不是浏览器，接受浏览器源只会扩大攻击面；真有网页客户端需要时，再以默认关闭的单独开关加入。
- **状态**：`listening`、实际绑定的 `boundPort`，`urls` 是对端使用的基址（每个声明的地址或名称一个，再加 `publicBaseUrl`）。

局域网监听器使用明文 HTTP，Key 以明文传输；只在可信网络中使用，或放在 TLS 反向代理之后。

### 另一台 HarnessHub 作为上游

预设 `harnesshub-remote`（`relay`，Bearer 认证，四种协议的端点都在同一个基址下）把另一台开启了局域网共享的 HarnessHub 当作 provider：基址用对方 `hh gateway share status` 给出的地址（`hh provider add <id> --preset harnesshub-remote --base <URL>`，`--base` 把预设的每个端点路径接到该基址之后，显式给出的端点优先），Credential 是对方签发的 `--lan` Key。

- 四种入站协议都直通到对方的同名端点，只改写 `model`，所以整条链路最多转换一次（在对方，按对方的 provider 决定）。
- 对方的 Model Ref 成为本机的模型名：对方的 `provider/model` 在本机是 `<本 provider id>/provider/model`，对方的路由组是 `<id>/group/<组名>`，wire 名就是对方的 Model Ref。Gemini 路径中的 `/` 原样保留，对方按最后一个 `:` 拆分。
- 模型列表由 `POST /api/v1/providers/{id}/models/refresh` 从对方的 `/v1/models` 读取（只包含对方 Key 允许的模型），同时读取 `context_window`、`max_output_tokens`、`reasoning` 与 `input_modalities`（OpenRouter 的 `context_length` 同样读取）。
- 两端各记一条账本：本机记录 provider 为该 relay、`mode: passthrough`；对方记录它的 Key 与实际路由。用量取对方返回的数值；对方把推理 token 计入 Anthropic 的输出时，本机看到的也是合计。

### Codex 透传

以 ChatGPT 登录的 Codex 把 `openai_base_url` 设为 `<网关>/backend-api/codex` 后，它自己的请求经网关原样到达 ChatGPT 的 Codex 后端（[codex.ts](../packages/gateway/src/codex.ts)，Magpie `gw/codex_backend.go` 中转发的部分）。网关不持有、也不复用这份登录。

- 守护进程的回环监听器把 `/backend-api/codex` 及其下路径交给网关，网关转发到 `https://chatgpt.com/backend-api/codex` 下的同一路径与查询串。方法、请求体（压缩的请求体解压后发送，不带 `content-encoding`；`/responses` 中网关自己做的压缩与编码的推理除外，见下）与客户端的请求头原样转发，`Authorization` 与 `ChatGPT-Account-Id` 逐字节不变；不转发逐跳头、`host`、`content-length`、`accept-encoding` 与所有 `x-hh-*` 头（包括 `X-HH-Credential`）。不使用 Gateway Key，不改写任何客户端身份，不注入提示词。答复的状态码、响应头（逐跳头、`content-length`、`content-encoding` 与 `set-cookie` 除外）与响应体原样返回，上游的错误也是。
- 只服务回环监听器上的回环对端，`Host` 必须是回环名称，带 `Origin` 或 `Sec-Fetch-Site: cross-site` 的请求一律拒绝：403 `source_not_allowed` 或 `origin_forbidden`，写拒绝记录。局域网监听器不提供这条路径（404）。
- 请求体为带 `model` 的 JSON 的 POST（`/responses` 与 `/responses/compact`）是一次模型调用，写一条账本：provider 为虚拟的 `chatgpt-subscription`（不对应任何已配置的 provider），Model Ref `chatgpt-subscription/<model>`，`mode: passthrough`，没有 Key 与作用域，`agent` 为 `{id: codex, source: route}`，会话键取 `prompt_cache_key` 等（按 `chatgpt-subscription` 隔离），用量从 Responses 流的 `response.completed`（或 JSON 答复）解析，`cost` 为 null。流式答复的终止事件与非流式答复的响应体在提交之后才写出；提交失败时返回 503 `evidence_unavailable`，流已开始则写一个 `response.failed` 事件。上游错误按失败类别记 `errorClass`，消息去掉客户端的 Authorization 值并脱敏。`GET /models` 等其他请求只转发，不写账本。
- **ChatGPT 模式的 HarnessHub 模型**（[ADR 0030](decisions/0030-codex-chatgpt-mode-models.md)）：接线把 agent Key 写在基址路径中（`/backend-api/codex/<Key>/…`），网关在一切处理之前去掉这一段，转发的 URL、账本路径与日志都不含它。`/responses` 的 `model` 带 `/` 时用这把 Key 鉴权，按 `/v1/responses` 的正常路径服务（账本 `inbound.path` 为 `/backend-api/codex/responses`，带 Key 与作用域），进入前删掉 `Authorization` 与 `ChatGPT-Account-Id`；没有 Key 时本地 401，不转发。路径中的 Key 无效、未知或已吊销时，任何请求（列表、调用、压缩）都本地 401，答复不含 Key 与路径；局域网监听器不提供这条路径。Key 之后（或没有 Key 时基址之后）的第一段只能是 Codex 调用的 `responses`（含 `responses/compact`）、`models` 或 `realtime`：像 Key 的段（`hhk_` 开头，不分大小写，下划线可编码为 `%5F`）却不是格式有效的 Key 时本地 401 `invalid_key`，拒绝记录的路径不含这一段；其他段本地 404 `route_not_found`，不写账本。两者都不转发给 ChatGPT。`GET /models` 带有效 Key 时，ChatGPT 的列表后面接着该 Key 可用的模型（条目由守护进程注入的 `codexCatalog` 生成，与 API 模式目录相同），优先级排在 ChatGPT 的之后，`ETag` 与转发答复的 `X-Models-Etag` 加上 `+hh-<列表标记>`；ChatGPT 拒绝或答复不是模型列表时原样返回。这份列表不写账本。
- `/responses/compact` 的 `model` 带 `/`（HarnessHub 的模型，ChatGPT 没有这样的模型）时不转发，答复 400 `compact_unsupported`（“/responses/compact is not supported for HarnessHub models; use a compaction_trigger on /responses”）。`/responses` 的输入中网关做的压缩项（`hh1:`）换成摘要的用户消息，网关编码的推理项（`hh-r1.`）删去，ChatGPT 读不了二者；账本记 `compaction:restored:<n>` 与 `reasoning:dropped:<n>`（[上下文压缩](gateway-features.md#上下文压缩)）。
- Authorization 的值从不写入日志或账本；转发失败的日志只有脱敏后的错误消息。
- 等待上游响应头与上游空闲的时限、响应体上限与请求体上限同其他调用（见“资源上限”）；不提供保活。
- 上游基址只能由测试经 `deps.codexBackend` 指向回环假服务。未实现：Codex 的 WebSocket 传输；ChatGPT 的列表取不到时退回 Codex 缓存的列表（Magpie 读 Codex 的目录，本网关不读）。

### 路径中的 Key

不能发送请求头的 Agent（Command Code、fx、Muse Code）把 agent Key 放在基址的路径中：`<网关>/k/<Key>/v1`（[ADR 0033](decisions/0033-gateway-key-in-path.md)，[key-path.ts](../packages/gateway/src/key-path.ts)）。

- 守护进程只在回环监听器上把 `/k/` 下的路径交给网关；局域网监听器答复 404。网关在一切处理之前去掉 `/k/<段>`（与 Codex 透传的 `codexRoute` 同一个切分），账本的 `inbound.path`、日志、OTLP 导出与上游请求都不含它；其余处理与请求头中的 Key 相同。
- 来自局域网监听器或非回环来源时 403 `source_not_allowed`；这一段不是 Key 的格式、Key 未知、已吊销或已过期，或者是 `client:`、`session:` Key 时本地 401（后两者照旧放在请求头中）；请求头中另带一把不同的 Key 时 401；`/k/<Key>` 之后不是模型协议路径（包括 Codex 透传）时 404。错误都不回显路径。
- **路径中其他位置的 Key**：Key 放在网关不读取它的位置时（`/K/<Key>/…`、`/%6b/<Key>/…`、`/v1beta/k/<Key>/…`，或不规范的路径），请求按其他路径处理：不规范的 400，不交给网关的由 Fastify 答复 404，交给网关的按没有 Key 答复 401。这些答复都不回显路径：Fastify 的 404 只保留其格式（`No GET route has this path`），`/api/v1` 问题详情的 `instance` 与访问日志的 `path` 经 `keylessPath`（[key-text.ts](../packages/core/src/key-text.ts)）去掉 Key 文本，账本的 `inbound.path` 同样如此。Key 文本是 `hhk_`（不分大小写，下划线可编码）及其后的 Key 字符，比签发格式宽：差一个字符、改了大小写的 Key 仍然暴露几乎整把 Key；`/k/` 之后的段无论是什么都替换为 `[REDACTED]`。网关日志（及 `hh serve` 在 stderr 上的回显）的脱敏器 `createRedactor` 与上游错误消息的 `sanitize` 也按同一规则去掉 Key 文本。去掉 `hhk_` 的 Key（作用域字母、Key ID 与密钥）同样算 Key 文本。
- **模型名中的 Key**：客户端把 Key 写进 `model` 时，网关构造的错误消息（`failure` 与 `GatewayError`，包括 404 `model_not_found` 与 403 `model_not_allowed`）、账本的 `requestedModel`、`modelRef`、`wireModel`、`servedModel`、`error` 与每次尝试的 `modelRef`、`wireModel`，以及读账本的 CSV 导出与 OTLP 导出都不含 Key 文本：账本在提交时统一经 `redactKeyText`（`keylessEntry`），路由决定在记录 `requestedModel` 时就去掉。只有密钥本身（43 个字符、没有前缀与 Key ID）不被识别：它与较长的部署名无法可靠区分。
- **Muse 的模型列表**：`GET /muse-code/models`（[muse.ts](../packages/gateway/src/muse.ts)，Magpie 的 `gw/muse.go`）。Muse 在基址所在主机上读它，不带基址的路径与凭据，所以列出最新一把有效的 `agent:muse` Key 可用的模型，每项带 `metadata["muse-code"]`（名称、图片输入、是否推理、窗口与输出上限，未知时 128000 与 32000）；没有这样的 Key 时 404。只读，不写账本；只在回环、只接受 GET，带 `Origin`、`Sec-Fetch-Site: cross-site` 或非回环 `Host` 时 403。

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
| 每个 Credential 并发上游请求 | 8 个，排队 64 个，再多返回 429 `busy`（转移到其他候选）；provider 的 `limits` 可以为它的每个 Credential 另设（见下）。空出的并发位给占用最少的 Key 的排队请求（同样少时先到先得），一把 Key 的大量请求不会让别的 Key 排在它们全部之后；排队至多 `slotWaitMs`（60 秒），到时 429 `busy` 并转移（安全审查 L7） |
| 推理回填缓存 | 每个 Gateway Key 256 条、4 MiB；全部 64 MiB |

provider 的 `limits`（Magpie 的 `maxConcurrency`）为它的每个 Credential 另设同时发出的请求数 `concurrentPerCredential`（1–1024）与可以排队的请求数 `queuePerCredential`（0–65536），未设的一项用上表的值；修改对下一个请求生效，调高时排队中的请求随即发出，调低时已发出的照常完成。用 `POST`/`PATCH /api/v1/providers` 的 `limits`（`null` 删除）或 `hh provider limits <id> [--concurrency N] [--queue N] [--clear]` 设置，`hh provider add` 也接受 `--concurrency` 与 `--queue`。

### 验证

[共享网关测试](../packages/gateway/test/shared-gateway.test.ts)、[路由测试](../packages/gateway/test/shared-gateway-routing.test.ts) 与 [协议矩阵测试](../packages/gateway/test/shared-gateway-matrix.test.ts) 与 [粘性与额度测试](../packages/gateway/test/shared-gateway-sticky.test.ts) 把处理函数挂在 `listen(0)` 的回环服务上，使用测试内的内存 `ModelPlaneStore` 与回环假上游，不访问真实模型：每种 Key 拒绝及其账本记录与节流、白名单、模型列表、四种协议的直通（请求体除 `model` 外逐字节相同、鉴权头替换、响应字节相同）、四种入站到 Chat 上游的转换、补丁、压缩请求、503 后转移成功、首字节后不重试、400 不重试、上下文超长不重试、`Retry-After` 超过上限直接返回与上限内等待、扣留期间的流内错误转移、扣留超时释放、熔断打开与半开、认证失败换 Credential、取消后不再尝试、`close()` 中止在途调用、提交前不写终止事件、提交失败时的 `evidence_unavailable`、响应头与空闲超时、转换路径的保活与 Gemini 响应头提交；以及 Chat 入站到仅有 Anthropic 端点的 provider（推理、工具、缓存读写 usage、同一 provider 的签名回传）、Claude Code 到仅有 Responses 或 Gemini 端点的 provider（图片、推理、工具、错误结果、Schema 限制）、Codex 到 Claude、交错的并行工具参数、各协议上游错误的格式映射，以及转换路由上的重试、转移、扣留与熔断。[故障转移测试](../packages/gateway/test/shared-gateway-failover.test.ts) 覆盖失败类别的判定顺序与每张词表的正反样例、每种类别的休息时长（经时钟推进验证休息到期前不访问上游、到期后放行一次探测；`quota` 的错误体重置、响应头重置、15 分钟默认与 8 天上限；`rate` 的 `Retry-After` 与 1 分钟默认；`proxy` 不休息；`other` 三次后打开并翻倍）、默认退避 1、2、4 秒、只在最后一个候选上重试与超过上限不重试、其后候选都在休息时原处重试，以及 `least-used` 的 token 衰减、限流窗口比例与账本初值。[钉选测试](../packages/gateway/test/shared-gateway-pinning.test.ts) 覆盖按 ID 与名称钉选（跨组成员、直通与转换都不把请求头发往上游）、429、400 与 404（候选之外存在的 Credential 与不存在的答复相同）。[Key 文本测试](../tests/integration/key-text-leaks.test.ts) 经正式守护进程（开启日志回显）验证不规范路径在两个监听器上 400、`/K/` 与 `/%6b/` 下的 Key 404、Codex 透传中像 Key 的段 401、未知段 404 且都不转发给 ChatGPT 替身，并在答复、网关日志、stderr、账本与数据目录中都找不到 Key、差一个字符的 Key 与大写的 Key；[core Key 文本测试](../packages/core/test/key-text.test.ts) 覆盖 `redactKeyText` 与 `keylessPath` 的每种形式与不改动的样例。[路由审查测试](../tests/integration/routing-review.test.ts) 经正式守护进程验证第二轮安全审查的路由项：回显请求字段的上游不能让共享 Credential 休息，一把 Key 的失败只休息 1 分钟且别的 Key 看不到它的错误文字，安全拒绝至多再问一个厂商、不问同一厂商的其他账号，被丢弃的拒绝回答计入账本与预算，Agent 隐藏的模型经组与裸名称都用不到，裸名称对 Key 不能用的东西与未知名称答复相同，排队超过 `slotWaitMs` 时 429；[并发位测试](../packages/gateway/test/slots.test.ts) 覆盖按 Key 公平分配与排队期限。[Credential 模型测试](../packages/gateway/test/credential-models.test.ts) 覆盖自己的列表没有该模型的 Credential 被跳过、未知时照常尝试、全部没有时全部尝试，以及 `keyFit` 的顺序与加权组中的 `aside`；[集成测试](../tests/integration/credential-models.test.ts) 经正式守护进程与两把 Key 看到不同模型的严格假 provider 验证刷新记录的 `listedFor` 与 `credentials`、调用不问列表没有该模型的 Key、账本补丁与路由状态、读不到列表时保留上次的结果、只剩一个 Credential 时清除记录，以及按入站协议优先相配的 Credential。[自动组测试](../packages/gateway/test/shared-gateway-auto-groups.test.ts) 覆盖自动组的列出、元数据、按成员顺序转移、隐藏与恢复、同 ID 用户组优先，以及账本的会话键与 `agent`（Key 作用域、User-Agent 推断、按 Key 隔离、不保存客户端原始标识）。[Codex 透传测试](../packages/gateway/test/shared-gateway-codex.test.ts) 以回环假服务代替 chatgpt.com，验证 `Authorization` 与 `ChatGPT-Account-Id` 逐字节转发、`x-hh-*` 不转发、流逐字节返回、用量入账、终止事件等待提交、提交失败时 `evidence_unavailable`、上游错误原样返回、非流式调用与模型列表，以及非回环、浏览器与局域网请求被拒绝；账本与日志中都没有 Authorization 的值。[成员测试](../packages/gateway/test/group-members.test.ts) 覆盖快速模式的判定（api.openai.com 的 GPT 与 o 系列、ChatGPT 账号、有快速模式的 Claude Opus，中转没有）、直通体中的固定强度与快速模式、编码后的 `speed` 与 beta 头、组中的组在规划中保持在一起、成环与超过 8 层被跳过、同一模型同一强度只保留一次、经网关的嵌套组按顺序转移与 `smart` 组以内层组的首个候选整体排序，以及固定强度在 Chat 与 Responses 直通、Anthropic 改为转换后到达上游，`/v1/models` 中组的窗口与档位。[预算测试](../packages/gateway/test/key-budgets.test.ts) 覆盖日、周、月窗口（纽约跨夏令时、上海跨月、周从周一开始）、在途请求的预留使第二个请求被拒绝、拒绝的消息与响应头、结束后预留归还、成本上限按模型输入价格预留，以及只在预算要求时计入缓存读取。[规则测试](../packages/gateway/test/group-rules.test.ts) 覆盖请求视图（长度不计媒体、图片、推理、轮次）、每个规则字段的路由、同一轮沿用与 95% 窗口时换成员、没见过开头的一轮、压缩请求跳过太小的成员且不改变粘性、规则打破粘性、分类器的询问、缓存、10 分钟过期、失败后 30 秒冷却与回答不是数字时不冷却、`effort: "auto"`、组中组的规则、`/v1/harnesshub/limit`、`/v1/models` 中规则能达到的能力，以及路由决定的发布、结束与等待；[决定测试](../packages/gateway/test/route-trace.test.ts) 覆盖环形保留、`after`、会话过滤、副本、等待、中止与关闭。[core 规则测试](../packages/core/test/route-rules.test.ts) 覆盖文本写法（每个词与同义词、报错指出具体的词）、规范化与校验指针、每个字段命中与不命中（含跨午夜与时区）、第一条命中、后续成员、意图范围与存储记录的无效样例。[规则集成测试](../tests/integration/group-rules.test.ts) 经正式守护进程与严格假 provider 验证每个字段命中与不命中、分类器的缓存、账本记录与冷却、写入校验与 `hh group rule` 的报错、自查端点、`/v1/models` 与接线中规则能达到的能力，以及 `GET /api/v1/routing/decisions` 的长轮询、会话过滤与管理令牌。[core 路由组测试](../packages/core/test/route-groups.test.ts) 覆盖成员后缀的拆分（含模型自身的冒号）、嵌套展开、成环与深度、能力的计算与 Key 预算记录的拒绝样例。[core 自动组测试](../packages/core/test/auto-groups.test.ts) 覆盖 `sameModel` 与 `slug` 的规则、就绪与 `expose` 过滤、成员顺序、隐藏与被用户组占用，以及 ID 截短。[编解码测试](../packages/gateway/test/matrix-codec.test.ts) 逐项覆盖编码器、解码器、结束原因映射与 `max_tokens` 解析。[严格上游矩阵测试](../tests/integration/shared-gateway-fake-provider.test.ts) 经正式守护进程把四种入站协议分别接到白名单模式[假 provider](../tools/fake-provider/README.md)的四种上游协议（16 种组合，流式与非流式），每种组合一次文本回答与一次工具往返，要求零违规、只出现配置的上游 Key、工具往返带回推理（Chat 的 `reasoning_content`、Responses 的推理项、Gemini 的 `thoughtSignature`、开启 thinking 时 Anthropic 的签名思考块）。[局域网测试](../packages/gateway/test/shared-gateway-lan.test.ts) 覆盖共享设置的解析与无效样例、局域网入口只接受 `allowLan` 的 `client:` Key（含模拟的非回环对端）、回环入口拒绝非回环对端、Host 规则、两个入口都拒绝浏览器 `Origin`、`publicBaseUrl`，以及 `count_tokens` 的转发与各种回退。[局域网集成测试](../tests/integration/gateway-lan-share.test.ts) 从正式守护进程验证共享的开启、持久化、重启、端口占用与启动时绑定失败、局域网监听器上不存在管理接口，以及两个守护进程的级联：A → B → 白名单模式的[假 provider](../tools/fake-provider/README.md)，四种协议直通、B 转换一次、实时模型列表与 `count_tokens` 转发。粘性与额度测试覆盖四种协议的会话键与轮次判断、每种粘性模式与缓存价值规则、熔断打开时粘性被打破、轮换策略下的 `auto` 粘性，以及三种额度（跨过阈值的调用完成、下一次被拒绝、窗口重置后恢复）。

```sh
pnpm build
node tools/run-tests.mjs unit packages/gateway/dist/test/*.test.js
```

### 与 03 的差异与未实现项

- 协议矩阵以 Chat 为枢纽，而不是 03 第 3 节的 IR；编码器与解码器按 IR 的边来组织，以后可以替换枢纽。经过 Chat 枢纽会丢失 Chat 表达不了的区别，例如 Anthropic 的 `stop_sequence` 与 `end_turn` 都成为 `stop`。
- 未迁移：声明了自己 openai-completions provider 的引擎与配置检查仍使用 Worker 内的 Session 网关；迁入模型平面后可删除 Worker 网关。统一模型的登记策略（遗留，见上文）待移除。
- `/api/v1/model-calls` 的响应 schema 还没有 `generation`，该字段目前只在账本记录与网关内可见。
- 重试只在最后一个还能尝试的候选上进行，没有 Retry-After 的限流 429 也会在那里重试；03 第 5 节原定的“先同候选重试再转移”与 ADR-P05 的相应部分由 [ADR 0025](decisions/0025-magpie-routing-parity.md) 修订。
- 转换到 Responses 上游时，第一次请求既没有推理请求、模型元数据也没有声明推理时，不请求 `reasoning.encrypted_content`，放回的推理项只有 `id` 与摘要；`store: false` 的真实 OpenAI 可能拒绝这样的推理项（假 provider 接受）。
- 尚未对齐 Magpie 的：OpenRouter 免费模型共享池只休息该模型、最后的失败是额度类时返回更早的其他失败；自动组的 `modelSameAs` 手工合并与全局关闭开关。Agent 的替代模型与 Magpie 的差别：Magpie 对 Claude Code 的完整 Claude 模型 ID（`claudeTierStandIn`）即使有 provider 或自动组提供也换成档位的模型，HarnessHub 只在名称解析不到时替代；Magpie 读取 Agent 自己的配置文件，HarnessHub 用接线记录；Magpie 的并发上限之外的请求无限排队、从不转移，HarnessHub 的排队有上限，排满时 429 `busy` 并转移。拒绝类的转移（[ADR 0025 补充](decisions/0025-magpie-routing-parity.md#补充拒绝类-400422-与安全拒绝的转移)）与 Magpie 的差别：推理之后才出现的拒绝在推理已送达客户端时不再转移（Magpie 对只有推理的流扣留更久）；Gemini 的 `RECITATION` 也按安全拒绝处理（HarnessHub 把它与 `SAFETY` 一并记为 `content_filter`）；只有 `promptFeedback.blockReason` 而没有候选的 Gemini 回答不识别为拒绝；被拒绝的尝试若有用量，只计在该尝试的上游，不进入这次调用的账本用量（Magpie 单独记一条）。
- 尚未实现：粘性记录的持久化与账本中的粘性字段（目前写在 `patches[]`）；`route.breaker` 事件（目前只写日志）；provider 声明的请求体上限与 `onUnsupportedMedia`；共享设置目前在数据目录的文件中，以后可能移到存储的设置表；局域网监听器的 TLS（07 第 5.4 节要求 TLS 或反向代理，目前只有明文 HTTP）、`allowLan` Key 的额度要求、按来源 IP 的失败锁定，以及 `hh status` 与控制台中的共享状态；`shape` 等账本扩展字段；入站转换器自身丢弃的提示字段尚未记入 `unmapped[]`；转换到 Gemini 的图片 URL 与 Anthropic 的结构化输出（beta）；拒绝记录的定时汇总（目前在下一次同类拒绝或 `close()` 时写出）。
- 直通流可能含网关合成的保活事件（见“共享网关的保活”），不再是上游字节的严格子序列；直通用例的逐字节黄金语料比较尚未建立。
- 响应体上限按原始字节而不是解码后的内容计算；`latency` 只统计本次启动以来的调用，`least-used` 另从账本取最近 8 小时的初值；认证失败的熔断最长 10 分钟后进入半开，而不是一直保持到 Credential 更新。

## 变更记录

- **2026-10-05：provider 的并发上限与 Agent 的替代模型**。provider 可以用 `limits` 为每个 Credential 另设并发数与排队数（Magpie 的 `maxConcurrency`，排满时仍为 429 `busy` 并转移）；接线的 Claude Code 与 Codex 请求解析不到的名称时，用它接线时选的模型代替（Magpie 的 `StandIn`），账本记 `stand-in`。

- **2026-10-05：裸模型名称**。不带 `provider/` 的模型名称按 Magpie 的顺序解析为路由组、自动路由组或唯一的模型（见“模型解析与列表”），几个 provider 都有时返回 400 `model_ambiguous` 并列出候选；Key 的允许列表用于解析出的 Ref。此前裸名称一律是 400 `model_invalid`，现在解析不到时为 404 `model_not_found`。

- **2026-10-05：Key 文本与路径规范化**（安全审查 B 组：L1、L2、L6）。守护进程与局域网监听器在分派前以 400 拒绝不规范的路径；Fastify 的 404 不再回显 URL，访问日志、`/api/v1` 问题详情与账本的路径去掉 Key 文本，网关日志与上游错误消息的脱敏器识别 Key 文本；Codex 透传中像 Key 的段本地 401、未知段本地 404，都不转发；钉选候选之外的 Credential 由 400 改为与不存在相同的 404。
- **2026-10-05：模型标记与回显**（第三轮安全审查 N1、I4）。“模型不存在”只读厂商的消息与 code；一把 Key 设下的暂定模型标记只对它自己生效；回显请求的 Key 自己的 `errorClass` 也按去掉回显后的类别；`echoFree` 保留错误 JSON 的键。
- **2026-10-05：模型名中的 Key 文本**（第三轮安全审查 N2）。客户端写进 `model` 的 Key 不再出现在错误答复、账本、CSV 与 OTLP 导出中；`redactKeyText` 也识别去掉 `hhk_` 的 Key。
- **2026-10-05：网关自己的调用记在触发它的 Key 名下**（[ADR 0032 补充二](decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下)）。视觉描述与分类器的调用不再用一个不受限的内部 Key：它们是触发请求的 Key 的调用，账本记它的 `keyId` 与 `purpose`，计入它的预算与每分钟请求数，局域网 Key 的调用不使用订阅账号；视觉模型须在 Key 的白名单中，否则图片不描述（`vision:not-allowed`）。每个请求至多描述 16 张未缓存的图片（`maxDescribedImages`）、至多 20 次内部调用（`maxInternalCalls`）；视觉补丁改为计数。联网搜索每轮至多 5 次、每个请求至多 20 次（`maxSearchesPerRound`、`maxSearchesPerRequest`），每次占用 Key 的一个每分钟请求，账本记 `search:queries:<n>`。账本提交失败的调用仍计入 Key 的预算。分类器只在联系不上时冷却，回答须是单独的数字，提示词转义用户文本，路由决定中只记失败原因的类别与长度。

- **2026-10-05：每个 Credential 自己的模型列表与协议相配**（Magpie 的 `Model.Keys` 与 `keyFit`）。有多个 Credential 时刷新模型列表按 Credential 分别读取并合并，记录每个模型由哪些 Credential 列出（`models.listedFor`、模型的 `credentials`，provider 记录是 JSON，无需迁移）；路由不把模型发给自己的列表没有它的 Credential（账本 `credential:unlisted:<n>`，路由状态 `unlistedModels`），没有任何一个列出时照样全部尝试；限定了协议的 Credential 按与模型相配的程度排序。
- **2026-10-05：路由的第二轮安全审查**（F 组：H2、M2、M3、M4、L6、L7、L10；[ADR 0025 修订](decisions/0025-magpie-routing-parity.md#修订2026-10-05第二轮安全审查)）。决定休息的类别从去掉请求自身词语的错误体判断，Claude Code 的自由文本重置只在 429 或订阅账号上读取；一把 Key 的失败最多让共享 Credential 休息 1 分钟，另一把 Key 再次遇到才给完整时长；“所有候选都在休息”不再引用上游的错误文字。安全过滤器的拒绝不再转给同一厂商的其他账号，一次调用至多再问一个厂商，Key 拒绝过多后不再转移；被丢弃的拒绝回答的用量计入账本与预算。Key 隐藏的模型经路由组也用不到，全部被隐藏的组不列出；裸名称只解析为 Key 能用的东西，否则与未知名称相同。凭据并发位按 Key 公平分配，排队有 `slotWaitMs` 期限。联网搜索只由搜索类型的工具与历史中的搜索项触发，不再按请求中任意位置的 `web_search` 字样。
- **2026-10-05：路径中的 Key 与 Muse 的模型列表**（[ADR 0033](decisions/0033-gateway-key-in-path.md)）。回环上的 `/k/<agent Key>/…` 在一切处理之前去掉 Key 段，按其后的模型协议路径服务；`GET /muse-code/models` 列出最新的 `agent:muse` Key 可用的模型。

- **2026-10-05：直通调用的结束原因**。直通调用的账本 `finishReason` 改用转换路径的取值：Anthropic 的 `tool_use`、`end_turn` 与 `max_tokens` 记为 `tool_calls`、`stop` 与 `length`，Gemini 的 `STOP` 等记为小写的对应值，Responses 的 `completed` 与 `incomplete` 按原因记；回答中有工具调用时（Responses 的调用项、Anthropic 的 `tool_use` 块、Gemini 的 `functionCall`、Chat 的 `tool_calls`）记为 `tool_calls`。此前 Responses 直通的工具轮次在账本中看不出来。

- **2026-10-05：ChatGPT 模式的 Codex 使用 HarnessHub 的模型**（[ADR 0030](decisions/0030-codex-chatgpt-mode-models.md)）。ChatGPT 模式接线签发 agent Key，写在 `openai_base_url` 的路径中；Codex 透传在本地服务带 `/` 的模型、合并 `/models` 列表，ChatGPT 的令牌不离开转发路径。压缩：模型没有写出摘要时，账本与客户端一致为 502 `compaction_empty`（[上下文压缩](gateway-features.md#上下文压缩)）。

- **2026-10-04：工具搜索与上下文压缩**（[网关功能](gateway-features.md#工具搜索)）。Codex 的 `tool_search` 发往 Responses 直通上游与转换的上游时是普通函数 `tool_search`，搜索结果说明找到的工具并把它们加入工具列表（去掉 `defer_loading`），模型对它的调用以 `tool_search_call` 交回 Codex；Claude Code 的 `tool_reference` 结果在转换时成为“Tool X is loaded and can be called now.”，不提供 `DeferredToolPlaceholder`。Codex 的 `compaction_trigger` 由网关请模型写摘要，答复为 `encrypted_content` 以 `hh1:` 开头的 `compaction` 项，之后的请求中换回摘要；`/v1/responses/compact` 答复 400 `compact_unsupported`。上游以 `invalid_encrypted_content` 等拒绝别的账号封存的推理或压缩时，去掉推理（再拒绝时去掉压缩）在同一候选上重发，账本记 `sealed:*`；网关自己编码的推理不再直通到 Responses 上游。新增纯函数 `isCompactionRequest`，识别七种 Agent 的压缩请求，供以后的路由规则使用。

- **2026-10-04：协议一致性套件的发现**（[ADR 0029](decisions/0029-protocol-suite.md)、[一致性套件](../conformance/README.md)）。官方 SDK 经网关在 16 个方向上运行后修正了四处：只发注释的上游在没有扣留输出时也得到保活，直通流改写入网关合成的保活，Gemini 客户端收不到 SSE 注释；Gemini 的流内错误改为裸 JSON 对象，Gemini 上游的同样形式被识别为流内错误；Anthropic 客户端收到交错的并行工具参数时不再报错，而是逐个整块发出；上下文超长的数值也从 OpenAI 与 Gemini 的措辞中读取。

- **2026-10-05：路由组成员与 Key 预算**（[ADR 0031](decisions/0031-group-members-and-key-budgets.md)）。路由组成员可以固定推理强度（`:high`）、以快速模式发送（`:fast`）或是另一个组（最多 8 层，写入时拒绝成环）；路由组在 `/v1/models` 与接线中宣称其模型共有的最小窗口与输出、共有档位（新增 `supported_reasoning_levels`），`smart` 与 `pace` 组开始按额度读数排序。Gateway Key 的额度改为本地日历的日、周、月预算，放行的请求持有预留，429 带 `retry-after`、`x-should-retry: false` 与 `x-hh-limit-reset`；新增 `GET /api/v1/gateway-keys/{id}/limit`、`PUT /api/v1/gateway-keys/{id}/quota` 与 `hh key limit|quota`，存储迁移 6 转换旧额度。新增 `POST /v1/images/edits`，没有图像端点的 provider 经 Chat 画图，图像端点 404/405 时回退到 Chat 一次。

- **2026-10-05：路由组规则与分类器**（[ADR 0032](decisions/0032-group-rules-and-classifier.md)）。路由组可以带 `rules[]`：一轮开始时按长度、图片、推理强度、Agent、意图、压缩与时段把一个成员放到最前，整轮沿用，只在会话超过当前模型窗口的 95% 时换到窗口更大的成员；压缩请求单独路由且不改变粘性。`classifier` 判断意图，`effort: "auto"` 由它为每一轮选推理强度；它的调用是账本中 `harnesshub-classify` 的单独条目，回答保留 10 分钟，失败后冷却 30 秒。新增 `hh group rule list|add|remove|move|classifier|effort` 与 Gateway Key 自查端点 `GET /v1/harnesshub/limit`。

- **2026-10-05：规则能达到的能力与路由决定**（[ADR 0032](decisions/0032-group-rules-and-classifier.md#补充规则能达到的能力与路由决定)）。路由组在 `/v1/models` 与接线中宣称其规则能保证的图片输入与更大的窗口（Magpie 的 `ruledEntry`）；新增 `GET /api/v1/routing/decisions`，以长轮询给出每一轮的路由决定（规则、分类器、粘性、候选顺序与结果），只保存在内存中。

- **2026-10-04：出站秘密脱敏**（[网关功能](gateway-features.md#出站脱敏)）。发往上游的请求中已知的秘密（Gateway Key、本进程解析过的凭据与订阅令牌、管理令牌、用户规则）替换为稳定的占位符，答复中只在工具调用参数里还原；缺省开启，账本记 `redact:<个数>`。设置了视觉模型时，发往不能看图的模型的图片由它描述成文字（[视觉兜底](gateway-features.md#视觉兜底)），描述调用是独立的账本条目。登记了搜索后端时，Responses 与 Anthropic 的服务端联网搜索由网关用搜索 API 完成（[联网搜索模拟](gateway-features.md#联网搜索模拟)），至多 6 轮。新增 `POST /v1/images/generations`：直通到声明了 `imageEndpoint` 的 provider，账本记用量与有价格时的费用。

- **2026-10-04：订阅账号**（[ADR 0026](decisions/0026-subscription-accounts.md)）。provider 可以是订阅（`subscription: {backend: "siwc"}`），Credential 是账号（`account`）；ChatGPT 套餐经 Sign in with ChatGPT 登录与调用，请求按预览要求整形，`subscription_sharing_*` 错误按 OpenAI 的说明映射；账号接受当前风险告知前不可用，只服务本机。新增路由策略 `smart` 与 `pace` 及额度读数的保存。GitHub Copilot 账号（`subscription: {backend: "copilot"}`）经 Copilot SDK 驱动用户安装的 Copilot CLI：网关的 `CopilotBridge` 把 Chat 请求交给按对话延续的会话，工具调用交回调用方，额度报告成为读数。

- **2026-10-04：对齐 Magpie 的路由**（[ADR 0025](decisions/0025-magpie-routing-parity.md)）。上游失败按 Magpie 的类别判定，各类别休息不同时长（余额 30 分钟、额度到厂商说明的重置或 15 分钟、最长 8 天、限流按响应头或 1 分钟、其他失败三次后 1 分钟起翻倍）；尝试的 `errorClass` 随类别取值，402 与余额措辞为 `insufficient_balance`，`insufficient_quota` 不再记为 `quota_exhausted`。失败在还有其他可尝试的候选时立即转移，只在最后一个候选上重试，默认等待 1、2、4 秒、超过 8 秒不等，取消了抖动；`DEFAULT_RETRY_POLICY` 改为 `perCandidate: 3`、`baseBackoffMs: 1000`。`least-used` 改为按 Credential 排序：限流窗口已用比例，其次是每小时减半的 token 数，并从账本取初值。新增自动路由组 `group/auto-<slug>`、`X-HH-Credential` 钉选、账本的 `conversationKey` 与 `agent`、会话视图与按 Credential 的用量、Codex 透传 `/backend-api/codex/*`；转换到 Responses 上游时回传工具调用之前的推理项。

- **2026-10-03：局域网共享与级联**（[ADR 0021](decisions/0021-gateway-lan-sharing.md)）。守护进程可以另开局域网监听器，只服务模型协议路径与 `allowLan` 的 `client:` Key；设置在 `<dataDir>/gateway-sharing.json`，经 `/api/v1/gateway/share` 与 `hh gateway share` 管理。`Host` 另外接受 `publicBaseUrl` 的主机；`Origin` 照旧一律拒绝，另外拒绝 `Sec-Fetch-Site: cross-site`。Anthropic `count_tokens` 在有直通 Anthropic 端点时转发上游（响应头 `x-hh-token-count: upstream`），此前总是本地估算。新预设 `harnesshub-remote`；OpenAI 格式的实时模型列表现在读取窗口、输出上限、推理与模态字段。

- **2026-10-03：Session Run 使用共享网关**（[ADR 0019](decisions/0019-session-runs-on-the-shared-gateway.md)）。应用了统一模型的引擎不再在 Worker 内启动网关，调用经守护进程端口的共享网关进入 `model.call` 账本；Run 的 `model.call` 事件与用量来自账本。可接入网关、没有自己 provider 的引擎在存在 `group/default`（或 Run 指定的 `model`）时也走共享网关，此前它们总是使用自己的登录；没有目标时仍使用自己的账号。Run 可以指定 `model`，目标不存在时以 `MODEL_NOT_CONFIGURED` 失败。旧统一模型在启动时写成 provider `migrated` 与（缺失时的）`group/default`；迁移后的 provider 不再去除 `reasoning_effort`、`prediction`、`modalities`、`audio`、`web_search_options`（不在 `drop-fields` 闭集内）。只在存在旧统一模型来源时，统一模型才覆盖引擎登记、停用无法接入的引擎（遗留，将移除）。没有凭据的 provider 现在可以调用（不带鉴权头）。
