# 网关功能：脱敏、视觉兜底、联网搜索与图像

共享模型网关的可选能力（对标 Magpie 网关的脱敏、视觉兜底、搜索模拟与画图；取舍见 [ADR 0027](decisions/0027-gateway-features.md)）。设置保存在 `<dataDir>/gateway-features.json`（0600，原子替换），由 `/api/v1/gateway/features/*` 与 `hh gateway …` 修改，网关对每个请求读取当前值，修改对下一个请求生效。文件不是有效设置时守护进程拒绝启动（`GATEWAY_FEATURES_INVALID`），不会因为手工改错而悄悄关闭脱敏。

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

## 图像生成

`POST /v1/images/generations` 接受 OpenAI Images 的请求，直通到声明了图像端点的 provider：

```sh
hh provider add openai --chat https://api.openai.com/v1 --image-endpoint https://api.openai.com/v1 --credential-from-env OPENAI_API_KEY
```

- **路由**：`model` 是 Model Ref，或 `group/<id>`（按成员顺序）；只有设置了 `imageEndpoint`（不含操作路径，网关追加 `/images/generations`）的 provider 参与，订阅 provider 不参与。没有这样的 provider 时 404 `images_unavailable`。Gateway Key 的 `modelAllow`、配额与熔断照常适用；上游失败时按模型调用的规则转移到下一个 Credential。
- **请求与答复**：`model` 改为 wire 名，Credential 按 provider 的方式附加，提示词经过出站脱敏，其余字段原样转发。JSON 答复与 `stream: true` 的事件（`image_generation.partial_image`、`image_generation.completed`）原样返回；上游最多等 5 分钟。
- **记录**：每次调用一个账本条目（`inbound.path` 为 `/v1/images/generations`），用量取答复或完成事件中的 `usage`（`gpt-image-*` 按 token 报告），模型有价格时按输入与输出价格计费，没有用量的上游（如 DALL·E）费用为空。
- 不在范围内：`/v1/images/edits`（multipart 上传）、为没有图像端点的模型选择画图模型（Magpie 的自动选择）。
