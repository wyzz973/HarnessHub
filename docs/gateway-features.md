# 网关功能：脱敏、视觉兜底、联网搜索、图像、工具搜索与压缩

共享模型网关的可选能力（对标 Magpie 网关的脱敏、视觉兜底、搜索模拟与画图；取舍见 [ADR 0027](decisions/0027-gateway-features.md)），以及总是生效、没有设置的[工具搜索](#工具搜索)与[上下文压缩](#上下文压缩)。设置保存在 `<dataDir>/gateway-features.json`（0600，原子替换），由 `/api/v1/gateway/features/*` 与 `hh gateway …` 修改，网关对每个请求读取当前值，修改对下一个请求生效。文件不是有效设置时守护进程拒绝启动（`GATEWAY_FEATURES_INVALID`），不会因为手工改错而悄悄关闭脱敏。

这些是运行时管理的设置：经管理接口、控制台或命令修改，立即生效，保存在数据目录中，与局域网共享的设置文件一样。启动时读取、改后需重启的设置（例如监听地址）属于统一的启动配置文件 `<configDir>/config.jsonc`（由 `hh config` 编辑，随该文件一起落地）；两者不重叠。

```sh
hh gateway features                                  # 当前设置
hh gateway redaction off                             # 关闭出站脱敏（缺省开启）
hh gateway redaction rule add codename 'falcon-[0-9]+' [--ignore-case]
hh gateway redaction rule remove codename
```

## 出站脱敏

请求发往上游之前，其中已知的秘密值被替换为占位符，厂商因此看不到 HarnessHub 自己的凭据，即使提示词或工具结果引用了它们。缺省开启，`hh gateway redaction off` 关闭。

- **已知的秘密**：Gateway Key（按签发格式 `hhk_<范围>_<12 位 ID>_<43 位>` 识别）；本进程解析过的每个 provider 凭据与订阅令牌（解析之后的请求才能识别，至少 8 个字符的精确值）；守护进程的管理令牌；用户登记的规则（JavaScript 正则表达式，有分组时第 1 组是值，种类为规则名）。不做通用的“像密钥”的模式识别。
- **占位符**：`{{HH_<种类>_<8 位 base32>}}`，是值在本进程随机密钥下的 HMAC：同一个值在每个请求中得到同一个占位符，所以对话历史逐轮一致（上游的提示缓存不受影响），占位符本身不透露值。值只在内存中按占位符保存，重启后由下一个请求重新带来。
- **范围**：出站请求体中的每个字符串（消息、system、工具结果、历史中的工具调用参数），翻译后的与直通的都一样，也包括 `count_tokens` 与 Codex 透传；标识、模型名、类型、签名、加密内容、`data:` URL 与 base64 数据保持原样。直通请求只在确有替换时重新序列化。
- **还原**：只在答复中模型把占位符写进**工具调用参数**的地方还原为原值，工具因此仍能使用真实的秘密；写给人看的文本保留占位符。按客户端的协议处理：Chat 的 `tool_calls[].function.arguments`，Responses 的函数与自定义工具调用（`*_arguments.*`、`custom_tool_call_input.*` 与输出项），Anthropic 的 `tool_use.input` 与 `input_json_delta`，Gemini 的 `functionCall.args`。流式参数中被切开的占位符会暂扣到同一调用的下一个片段，调用结束前写出；JSON 参数文本中的值按 JSON 字符串转义。
- **记录**：账本的 `patches[]` 记 `redact:<个数>`，只有个数，从不记值。

## 视觉兜底

请求带图片、而目标模型的元数据表明它不接受图片输入时，由设置的视觉模型把每张图片描述成文字，图片替换为 `[image: <描述>]`。

```sh
hh gateway vision group/vision      # 或一个 Model Ref，如 openai/gpt-4.1
hh gateway vision off
```

- **何时生效**：翻译的请求在模型元数据没有声明图片输入时（与原来换成占位文字的条件相同）；直通的请求只在元数据明确不含图片输入时，这时请求改为翻译（账本照常记录模式）。没有设置视觉模型时行为不变：翻译的请求中图片是占位文字，直通的请求原样发送。
- **描述调用**：每张图片一次 Chat 调用，提示词要求完整描述并逐字转写图中文字。调用经网关自己的完整路径（路由组、熔断、失败转移、凭据、脱敏），在一个只监听 127.0.0.1、只接受本进程随机令牌的内部监听器上发出；它是独立的账本条目，没有 Gateway Key，`agent` 为 `harnesshub-vision`（来源 `route`），按视觉模型的价格计费。内部调用不再做视觉兜底。同时至多描述 4 张。
- **缓存**：按图片内容（URL 或 data URL 的 SHA-256）缓存最近 256 条描述。
- **失败**：本轮新图片（最后一条 assistant 消息之后的）描述失败时，该候选以 502 `vision_failed` 跳过（能看图的其他候选仍可服务）；历史中的图片描述失败时保留占位文字。
- **记录**：原调用的 `patches[]` 记每个描述调用的 `vision:<callId>`，以及 `vision:cached:<n>`、`vision:failed:<n>`。

## 联网搜索模拟

客户端可以给模型提供它所针对的厂商在服务端执行的联网搜索（Responses 的 `web_search`、Anthropic 的 `web_search_*`）。别家的上游执行不了这种工具；登记了搜索后端时，网关自己完成搜索。

```sh
hh gateway search add tavily --key-from-env TAVILY_API_KEY   # 或 --key（隐藏输入）、--key-from-stdin、--key-from-file
hh gateway search add searxng --base-url http://127.0.0.1:8888
hh gateway search remove search-1
```

- **后端**：Tavily、Brave、Exa、Firecrawl 与 SearXNG，按登记顺序使用，前一个失败或没有结果时用下一个。密钥只在秘密存储中，设置文件记引用；HarnessHub 从不隐式读取环境变量，`--key-from-env` 只读取命令中指名的那一个。`--base-url` 用于 SearXNG（必填）或替换厂商的 API 地址。每个后端至多 30 秒、取 6 个结果，每个结果至多 1500 个字符。查询发出之前同样经过出站脱敏。没有后端时功能关闭：翻译时这类工具仍被拒绝（`Hosted Responses tool web_search is unsupported`），直通时原样发送。
- **何时生效**：请求带这类工具、且候选的上游不会自己执行它时。直通到 `api.anthropic.com`（Anthropic）或 `api.openai.com`、`api.x.ai`、`api.deepseek.com`（Responses）的请求保留厂商自己的搜索；其他直通请求改为翻译。历史中有网关自己的搜索（下文的标记）时，请求总是由网关处理，不会把厂商不认识的块发给厂商。
- **过程**：网关把客户端的搜索工具换成函数工具 `web_search(query)`（客户端已有同名工具时为 `hh_web_search`），模型调用它时并行执行查询，把结果作为工具结果再问模型一轮；至多 6 轮，第 7 次要搜索时回答“No more searches”，模型据此作答。只调用搜索的回合对客户端不可见；模型同时调用客户端自己的工具时，这些调用交给客户端，搜索调用被丢弃。各轮的文本连成一个答复，用量合计。
- **客户端看到的**：Anthropic 为 `server_tool_use`（id 为 `srvtoolu_hh_…`）与 `web_search_tool_result`（标题与 URL，`encrypted_content` 为空）块；Responses 为 `web_search_call` 项（id 为 `ws_hh_…`，`action` 带 `query` 与 `sources`）。这两种标记的块在之后的请求中转成给模型看的文字。Chat 的 `web_search_options` 与 Gemini 的 `googleSearch` 不在范围内。
- **记录**：`patches[]` 记 `search:emulated` 与 `search:rounds:<n>`；搜索 API 的调用不进账本。
- **接线的 Codex**：没有搜索后端时，全局接线为不原生接收 Responses 的模型写入 `web_search = "disabled"`；登记第一个后端或删除最后一个后，目录同步随之改写已接线 Codex 的文件（[全局接线](global-wiring.md#codex-的两种模式)）。

## 图像生成

`POST /v1/images/generations` 接受 OpenAI Images 的请求，直通到声明了图像端点的 provider：

```sh
hh provider add openai --chat https://api.openai.com/v1 --image-endpoint https://api.openai.com/v1 --credential-from-env OPENAI_API_KEY
```

- **路由**：`model` 是 Model Ref，或 `group/<id>`（按成员顺序）；只有设置了 `imageEndpoint`（不含操作路径，网关追加 `/images/generations`）的 provider 参与，订阅 provider 不参与。没有这样的 provider 时 404 `images_unavailable`。Gateway Key 的 `modelAllow`、配额与熔断照常适用；上游失败时按模型调用的规则转移到下一个 Credential。
- **请求与答复**：`model` 改为 wire 名，Credential 按 provider 的方式附加，提示词经过出站脱敏，其余字段原样转发。JSON 答复与 `stream: true` 的事件（`image_generation.partial_image`、`image_generation.completed`）原样返回；上游最多等 5 分钟。
- **记录**：每次调用一个账本条目（`inbound.path` 为 `/v1/images/generations`），用量取答复或完成事件中的 `usage`（`gpt-image-*` 按 token 报告），模型有价格时按输入与输出价格计费，没有用量的上游（如 DALL·E）费用为空。
- 不在范围内：`/v1/images/edits`（multipart 上传）、为没有图像端点的模型选择画图模型（Magpie 的自动选择）。

## 工具搜索

Agent 可以先不把全部工具发给模型，让模型按需搜索（对标 Magpie `gw/toolsearch.go`，实现在 [toolsearch.ts](../packages/gateway/src/toolsearch.ts)）。只有厂商自己的后端认识这类工具，网关为其他上游改写。

- **Codex**：`tool_search` 工具（`execution: "client"`，由 Codex 自己执行搜索）发往上游时是普通函数 `tool_search`，描述与参数不变；历史中的 `tool_search_call` 是对它的 `function_call`（不带项 ID），`tool_search_output` 是 `function_call_output`，内容为 “These tools are now available to call: a, b”（没有结果时为 “No tools matched the search.”），找到的工具去掉 `defer_loading` 后加入工具列表，每个只加一次，同一命名空间再次找到时只补上缺少的工具。模型调用 `tool_search` 函数（不带命名空间）时，答复中的该项改回 Codex 执行的 `tool_search_call`（`execution: "client"`，`arguments` 为对象），流式事件与 JSON 答复都改。直通到 Responses 上游时改写请求体，账本记 `tool-search:function`；转换的请求（Chat 等上游）在转换中完成，命名空间中的工具按转换时提供给模型的名称列出，`tool_search_call` 的 ID 以 `tsc_` 开头。`execution` 不是 `client` 的托管搜索仍按托管工具拒绝。订阅账号的请求总是转换，不直通。
- **Claude Code**：ToolSearch 的工具结果中的 `tool_reference` 块在转换时成为 “Tool X is loaded and can be called now.”（每个一行，接在结果文字之后），`DeferredToolPlaceholder` 工具不提供给模型；工具定义上的 `defer_loading` 在转换中不发送。直通到 Anthropic 端点时原样发送。
- **验证**：[工具搜索测试](../packages/gateway/test/gateway-tool-search.test.ts) 覆盖请求改写、命名空间合并、空结果、长名称、流式（任意切分）与 JSON 答复的改回、带命名空间的同名调用不改，以及两种转换；[集成测试](../tests/integration/shared-gateway-tool-search-compaction.test.ts) 经正式守护进程连接白名单模式的[假 provider](../tools/fake-provider/README.md)（`execution`、`tools`、`defer_loading` 在那里都是违规字段），对 Responses 直通与 Chat 转换、流式与非流式各做一次搜索往返与调用找到的工具，以及 Anthropic 到 Chat 的 `tool_reference`。尚未用真实 Codex 与 Claude Code 对真实上游验证。

## 上下文压缩

Agent 在上下文将满时请模型把对话写成摘要（对标 Magpie `gw/compacting.go` 与 `gw/codex_backend.go` 的压缩部分，实现在 [compacting.ts](../packages/gateway/src/compacting.ts)）。

- **识别**：`isCompactionRequest(protocol, body)` 是纯函数，按各 Agent 发布版本中的压缩提示词识别压缩请求：system 是（或以之开头）Claude Code 2.1、OpenCode、Pi、Gemini CLI 或 Qwen Code 的压缩提示词，或最后一条用户消息含有 Claude Code `/compact`、Codex 或 Kimi Code 的压缩要求，或 Responses 输入中有 `compaction_trigger`。目前只提供函数，供以后路由组的压缩规则使用；账本没有对应字段，不记录识别结果。
- **Codex 的 `compaction_trigger`**：发到 `/v1/responses` 的请求（模型都是 HarnessHub 的）中，这一项换成 Codex 自己的压缩提示词（openai/codex，Apache-2.0）的用户消息，请求去掉 `tools`、`tool_choice` 与 `parallel_tool_calls`，按普通调用路由（直通或转换都可以）。答复改写为 ChatGPT 的 Codex 后端的形式：模型的消息文字是摘要，成为一个 `compaction` 项，`id` 为 `cmp_<响应 ID>`，`encrypted_content` 为 `hh1:` 加摘要的 base64；流式时 `response.created`、`response.in_progress`、失败事件与注释立即转发，模型自己的项扣下，最后写出该项的 `response.output_item.added`、`response.output_item.done` 与带模型用量的 `response.completed`；非流式时该项成为 `output` 的唯一一项。错误答复原样返回；模型没有写出摘要时以 `response.failed`（“compaction: the model wrote no summary”）结束，这时账本仍记该次调用成功，因为模型调用本身已完成。账本记 `compaction:summary`。
- **之后的请求**：输入中 `encrypted_content` 以 `hh1:` 开头的 `compaction` 或 `compaction_summary` 项换成用户消息：Codex 的摘要前言（“Another language model started to solve this problem…”）、换行与摘要，账本记 `compaction:restored:<n>`；其他压缩项（OpenAI 封存的）不变。Codex 透传（`/backend-api/codex/responses`）同样换回，但其中的 `compaction_trigger` 属于 ChatGPT 自己的模型，原样转发。
- **`/responses/compact`**：`/v1/responses/compact` 答复 400 `compact_unsupported`：“/responses/compact is not supported for HarnessHub models; use a compaction_trigger on /responses”，写拒绝记录；Codex 透传中模型带 `/` 的同一路径也如此，不转发给 ChatGPT。
- **封存的推理与压缩**：一个账号或厂商封存的 `encrypted_content` 另一个读不了。网关自己编码的推理（转换答复中的推理项，`hh-r1.`）不直通到 Responses 上游，也不经 Codex 透传发给 ChatGPT，账本记 `reasoning:dropped:<n>`。路由粘性让会话留在答复它的 Credential 上；会话仍被换到别处、上游以 `invalid_encrypted_content` 或“encrypted content … could not be verified/decrypted”拒绝时，网关去掉请求中的推理项在同一候选上重发，再被拒绝（或没有推理项）时去掉封存的压缩项再重发，每次调用至多两次，账本的尝试记为 `retry`、`patches[]` 记 `sealed:reasoning` 或 `sealed:compaction`，不计入熔断。只用于 Responses 入站。Magpie 另外按会话记住被拒绝的封存项、之后的请求预先去掉，本网关每轮重新被拒绝一次。
- **验证**：[压缩测试](../packages/gateway/test/gateway-compaction.test.ts) 覆盖七种 Agent 的压缩请求与不应识别的样例、请求改写、流式（任意切分）与 JSON 的摘要改写、失败与错误答复、没有摘要、封存项的去除顺序与网关自己的推理；[Codex 透传测试](../packages/gateway/test/shared-gateway-codex.test.ts) 覆盖 `/responses/compact` 的 400 与摘要、推理的换回；[集成测试](../tests/integration/shared-gateway-tool-search-compaction.test.ts) 经正式守护进程对 Responses 直通与 Chat 转换、流式与非流式各做一次压缩与恢复（工具若随压缩请求发出，假 provider 的脚本会答出别的内容），并以假 provider 的 `foreignSeals` 怪癖验证推理与压缩被拒绝后的重发、网关推理的预先删除与 `/v1/responses/compact` 的 400。尚未用真实 Codex 对真实上游验证 `compaction_trigger`。
