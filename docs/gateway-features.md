# 网关功能：脱敏、视觉兜底、联网搜索、用量提醒、图像、工具搜索与压缩

共享模型网关的可选能力（对标 Magpie 网关的脱敏、视觉兜底、搜索模拟、用量提醒与画图；取舍见 [ADR 0027](decisions/0027-gateway-features.md)），以及总是生效、没有设置的[工具搜索](#工具搜索)与[上下文压缩](#上下文压缩)。设置保存在 `<dataDir>/gateway-features.json`（0600，原子替换），由 `/api/v1/gateway/features/*` 与 `hh gateway …` 修改，网关对每个请求读取当前值，修改对下一个请求生效。文件不是有效设置时守护进程拒绝启动（`GATEWAY_FEATURES_INVALID`），不会因为手工改错而悄悄关闭脱敏。每次修改记录时间 `updatedAt`（接口不返回），供同步在两边都改时比较；这些设置与搜索 Key 随[备份与同步](backup-sync.md)一起带走。

这些是运行时管理的设置：经管理接口、控制台或命令修改，立即生效，保存在数据目录中，与局域网共享的设置文件一样。启动时读取、改后需重启的设置（例如监听地址）属于统一的启动配置文件 `<configDir>/config.jsonc`（由 `hh config` 编辑，随该文件一起落地）；两者不重叠。

控制台的“设置 → 网关功能”页（`/settings/features`）提供同样的设置：脱敏开关与规则、视觉模型、搜索后端，以及设置了图像端点的 provider（图像端点在 Provider 的编辑中填写）。

```sh
hh gateway features                                  # 当前设置
hh gateway redaction off                             # 关闭出站脱敏（缺省开启）
hh gateway redaction rule add codename 'falcon-[0-9]+' [--ignore-case]
hh gateway redaction rule remove codename
hh gateway alert 80                                  # 额度窗口用到 80% 时提醒；off 关闭
hh gateway alert                                     # 当前阈值与最近 40 天的提醒
```

## 出站脱敏

请求发往上游之前，其中已知的秘密值被替换为占位符，厂商因此看不到 HarnessHub 自己的凭据，即使提示词或工具结果引用了它们。缺省开启，`hh gateway redaction off` 关闭。

- **已知的秘密**：Gateway Key（按签发格式 `hhk_<范围>_<12 位 ID>_<43 位>` 识别）；本进程解析过的每个 provider 凭据与订阅令牌（解析之后的请求才能识别，至少 8 个字符的精确值）；守护进程的管理令牌；用户登记的规则（JavaScript 正则表达式，有分组时第 1 组是值，种类为规则名）。不做通用的“像密钥”的模式识别。
- **占位符**：`{{HH_<种类>_<8 位 base32>}}`，是值在本进程随机密钥下的 HMAC：同一个值在每个请求中得到同一个占位符，所以对话历史逐轮一致（上游的提示缓存不受影响），占位符本身不透露值。值只在内存中按占位符保存，重启后由下一个请求重新带来。
- **范围**：出站请求体中的每个字符串（消息、system、工具结果、历史中的工具调用参数），翻译后的与直通的都一样，也包括 `count_tokens` 与 Codex 透传；标识、模型名、类型、签名、加密内容、`data:` URL 与 base64 数据保持原样。直通请求只在确有替换时重新序列化。
- **还原**：只在答复中模型把占位符写进**工具调用参数**的地方还原为原值，工具因此仍能使用真实的秘密；写给人看的文本保留占位符。按客户端的协议处理：Chat 的 `tool_calls[].function.arguments`，Responses 的函数与自定义工具调用（`*_arguments.*`、`custom_tool_call_input.*` 与输出项），Anthropic 的 `tool_use.input` 与 `input_json_delta`，Gemini 的 `functionCall.args`。流式参数中被切开的占位符会暂扣到同一调用的下一个片段，调用结束前写出；JSON 参数文本中的值按 JSON 字符串转义。
- **规则的限制**（2026-10-05，第二轮安全审查 M6）：用户规则在守护进程的事件循环上对每个请求的每个字符串运行，一条会灾难性回溯的规则（如 `(\w+\s?)+$`，45 个字符就超过 40 秒）能让守护进程停住。因此在每个入口（接口、`hh gateway redaction rule add`、恢复备份、同步与读取设置文件）拒绝：反向引用；重复多于一次、里面还有重复、可选部分或分支的分组（`(a+)+`、`(a|ab)*`、`(ab?)+`，改用字符类）；两个无上限的重复之间只有可选部分且字符可能重叠（`\w+\w+`、`[a-z]+-?[a-z0-9]+`，跨分组也算）。检查见 [regex-safety.ts](../packages/core/src/regex-safety.ts)，偏保守。另外一个请求的脱敏总时长有上限（`gateway.limits.redactionBudgetMs`，默认 1000 ms），超过时这个请求以 503 `redaction_timeout` 失败、不发往上游，守护进程继续服务；预算在字符串与规则之间检查，单次匹配不会被打断，这一点靠上面的规则限制。更早版本写下的设置文件中不符合的规则在启动时不生效并记日志 `gateway.features_dropped`，文件在下次修改时更新。
- **记录**：账本的 `patches[]` 记 `redact:<个数>`，只有个数，从不记值。
- **OTLP 内容导出**：`otlp.bodies` 打开时，导出的请求与回答用同一个脱敏器与同一组规则遮蔽，关闭出站脱敏不影响这一步（[OTLP 导出](observability.md#otlp-导出)）。

## 视觉兜底

请求带图片、而目标模型的元数据表明它不接受图片输入时，由设置的视觉模型把每张图片描述成文字，图片替换为 `[image: <描述>]`。

```sh
hh gateway vision group/vision      # 或一个 Model Ref，如 openai/gpt-4.1
hh gateway vision off
```

- **何时生效**：翻译的请求在模型元数据没有声明图片输入时（与原来换成占位文字的条件相同）；直通的请求只在元数据明确不含图片输入时，这时请求改为翻译（账本照常记录模式）。没有设置视觉模型时行为不变：翻译的请求中图片是占位文字，直通的请求原样发送。
- **描述调用**：每张图片一次 Chat 调用，提示词要求完整描述并逐字转写图中文字。调用经网关自己的完整路径（路由组、熔断、失败转移、凭据、脱敏），在一个只监听 127.0.0.1、只接受本进程随机令牌的内部监听器上发出。它以发出请求的 Gateway Key 进行：是这把 Key 的独立账本条目（`keyId` 与 `scope` 同原调用，`agent` 为 `harnesshub-vision`、来源 `route`，`purpose` 为 `vision`），按视觉模型的价格计入它的预算，每次占用它的一个每分钟请求；允许局域网使用的 Key 的描述不使用订阅账号。内部调用不再做视觉兜底。同时至多描述 4 张。
- **Key 的白名单**：视觉模型（Model Ref 或组）必须在 Key 自己的白名单中，因为描述就是视觉模型的输出，会进入客户端模型的输入。否则不描述，行为与没有设置视觉模型时相同，账本记 `vision:not-allowed`。路由组的分类器则不同：它经组授权，能使用这个组的 Key 就能询问它，因为它的回答只决定组成员的排序、不会交给客户端（[ADR 0032 补充二](decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下)）。
- **上限**：每个请求至多描述 `gateway.limits.maxDescribedImages`（默认 16）张没有缓存的图片，从最新的开始（本轮的，然后从近到远的历史），已缓存的不计；每个请求的内部调用（描述与分类器）合计至多 `maxInternalCalls`（默认 20）次。其余图片按没有描述处理（翻译时为占位文字），账本记 `vision:skipped:<n>`。
- **缓存**：按图片内容（URL 或 data URL 的 SHA-256）缓存最近 256 条描述。
- **失败**：本轮新图片（最后一条 assistant 消息之后的）描述失败时，该候选以 502 `vision_failed` 跳过（能看图的其他候选仍可服务）；描述因 Key 的预算或每分钟请求数被拒时为 429 `quota_exceeded`。历史中的图片描述失败时保留占位文字。
- **记录**：原调用的 `patches[]` 只记计数：`vision:described:<n>`、`vision:cached:<n>`、`vision:failed:<n>` 与 `vision:skipped:<n>`；描述调用本身按 `purpose: vision` 与 `keyId` 在账本中查找。

## 联网搜索模拟

客户端可以给模型提供它所针对的厂商在服务端执行的联网搜索（Responses 的 `web_search`、Anthropic 的 `web_search_*`）。别家的上游执行不了这种工具；登记了搜索后端时，网关自己完成搜索。

```sh
hh gateway search add tavily --key-from-env TAVILY_API_KEY   # 或 --key（隐藏输入）、--key-from-stdin、--key-from-file
hh gateway search add searxng --base-url http://127.0.0.1:8888
hh gateway search remove search-1
```

- **后端**：Tavily、Brave、Exa、Firecrawl 与 SearXNG，按登记顺序使用，前一个失败或没有结果时用下一个。密钥只在秘密存储中，设置文件记引用；HarnessHub 从不隐式读取环境变量，`--key-from-env` 只读取命令中指名的那一个。`--base-url` 用于 SearXNG（必填）或替换厂商的 API 地址，不能带 `user:password@`（它会出现在设置视图与备份中；Key 用 `--key`）。每个后端至多 30 秒、取 6 个结果，每个结果至多 1500 个字符。查询发出之前同样经过出站脱敏。没有后端时功能关闭：翻译时这类工具仍被拒绝（`Hosted Responses tool web_search is unsupported`），直通时原样发送。
- **何时生效**：请求带这类工具（`tools` 中类型以 `web_search` 开头的项），或历史中有这类搜索（Responses 的 `web_search_call` 项、Anthropic 名为 `web_search` 的 `server_tool_use` 与 `web_search_tool_result` 块），且候选的上游不会自己执行它时；消息或函数工具中出现 `web_search` 字样不算（安全审查 L10）。直通到 `api.anthropic.com`（Anthropic）或 `api.openai.com`、`api.x.ai`、`api.deepseek.com`（Responses）的请求保留厂商自己的搜索；其他直通请求改为翻译。历史中有网关自己的搜索（下文的标记）时，请求总是由网关处理，不会把厂商不认识的块发给厂商。
- **过程**：网关把客户端的搜索工具换成函数工具 `web_search(query)`（客户端已有同名工具时为 `hh_web_search`），模型调用它时并行执行查询，把结果作为工具结果再问模型一轮；至多 6 轮，第 7 次要搜索时回答“No more searches”，模型据此作答。每轮至多执行 `gateway.limits.maxSearchesPerRound`（默认 5）次、每个请求至多 `maxSearchesPerRequest`（默认 20）次查询，每次查询占用发出请求的 Key 的一个每分钟请求；超出或 Key 的每分钟请求已用完时这次查询不执行，工具结果告诉模型原因（“Not run: …”）。只调用搜索的回合对客户端不可见；模型同时调用客户端自己的工具时，这些调用交给客户端，搜索调用被丢弃。各轮的文本连成一个答复，用量合计。
- **客户端看到的**：Anthropic 为 `server_tool_use`（id 为 `srvtoolu_hh_…`）与 `web_search_tool_result`（标题与 URL，`encrypted_content` 为空）块；Responses 为 `web_search_call` 项（id 为 `ws_hh_…`，`action` 带 `query` 与 `sources`）。这两种标记的块在之后的请求中转成给模型看的文字。Chat 的 `web_search_options` 与 Gemini 的 `googleSearch` 不在范围内。
- **记录**：`patches[]` 记 `search:emulated`、`search:rounds:<n>`、`search:queries:<n>`（执行的查询数），以及有查询未执行时的 `search:refused:<n>`；搜索 API 的调用本身不是单独的账本条目，其费用不计入 Key 的预算（HarnessHub 不知道各搜索 API 的价格）。
- **接线的 Codex**：没有搜索后端时，全局接线为不原生接收 Responses 的模型写入 `web_search = "disabled"`；登记第一个后端或删除最后一个后，目录同步随之改写已接线 Codex 的文件（[全局接线](global-wiring.md#codex-的两种模式)）。

## 用量提醒

对应 Magpie 的 `usageAlert`（`magpie quota alert 80`）：设置 `alerts.usagePercent`（1–100 的整数，`hh gateway alert <百分比>|off`、`PUT|DELETE /api/v1/gateway/features/alerts`）后，守护进程在启动 1 分钟后、之后每 5 分钟（与 Magpie 相同）查看网关持有的每个凭据的额度读数，即 `GET /api/v1/routing/state` 中的 `readings`：来自上游答复的限流响应头（`x-ratelimit-*`、`anthropic-ratelimit-*`）与 Copilot 的额度。阈值设置或改变时立即查看一次。

- **何时提醒**：某个窗口的已用百分比不低于阈值时提醒一次；同一轮窗口（重置时间与提醒时记下的相差不到 10 分钟，或两次都没有重置时间）不再提醒，窗口重置后再次到线时再提醒；用量回落到阈值以下后记下的标记删除。读数描述的窗口已经重置（重置时间已过，或没有重置时间而读数时间加窗口长度已过）时既不提醒也不清除标记。
- **怎样提醒**：`gateway.log` 中每次检查一行 `usage.alert`（阈值、到期提醒的个数 `count`，以及其中最多 16 个提醒的 provider、凭据 ID、窗口、已用百分比、重置时间，不含凭据值），以及 `GET /api/v1/usage/alerts`（阈值与最近 40 天的提醒，新到旧，最多 100 条，凭据仍在时带当前名称）；`hh gateway alert` 不带参数时显示两者。控制台的用量页显示还没有关闭的提醒（每分钟读取一次，页面可见时），导航中的“用量”带标记；“知道了”只在这个浏览器中隐藏已显示的提醒，之后的新提醒仍会显示。阈值在控制台的设置 › 网关功能 › 用量提醒中设置。Magpie 的系统通知由它的菜单栏应用发出，HarnessHub 没有菜单栏应用。
- **记在哪里**：已提醒的窗口与提醒列表保存在 `<dataDir>/usage-alerts.json`（0600，原子替换），重启后不重复提醒；文件读不出或不是有效内容时记 `usage.alerts_invalid` 并按空文件处理，从不阻止启动（此后可能再提醒一次）。不再出现的窗口（例如凭据被删除）的标记与提醒在 40 天后删除；标记最多 2048 条，超过时删掉最早的（这些窗口可能再提醒一次），网关每个 Credential 最多保留 16 个窗口的读数。阈值随网关功能进入[备份与同步](backup-sync.md)，已提醒的记录不随同。
- **与 Magpie 的差别**：没有余额提醒（HarnessHub 不读取中转站的余额）；HarnessHub 不主动查询厂商的用量接口，只用调用中得到的读数，因此没有调用过的凭据没有读数，ChatGPT 账号也没有；Magpie 跳过的“不影响使用”的窗口在 HarnessHub 中没有对应。
- **验证**：[单元测试](../packages/daemon/test/usage-alerts.test.ts) 覆盖到线、同一轮不重复、窗口重置后再提醒、回落后清除、已过期的读数、40 天删除标记、关闭时不读不写、0600 文件与重启后不重复、四种损坏或无效的文件按空处理且重新写好、设置的校验；[集成测试](../tests/integration/usage-alerts.test.ts) 经正式守护进程与带限流响应头的本地上游：50% 时不提醒，95% 时 `gateway.log` 一行、列表一条（带凭据名称），同一轮再次调用不重复，`hh gateway alert` 的显示、设置、关闭与 150 的用法错误，备份恢复带回阈值，重启后不重复，损坏的文件记录日志后按空处理、再次提醒并写好文件。未验证：真实厂商的限流响应头与 Copilot 额度、Windows。

## 图像生成

`POST /v1/images/generations` 与 `POST /v1/images/edits` 接受 OpenAI Images 的请求：JSON，或（编辑多用的）`multipart/form-data` 表单（`image`、`image[]` 与 `mask` 文件）。实现见 [images.ts](../packages/gateway/src/images.ts)。

```sh
hh provider add openai --chat https://api.openai.com/v1 --image-endpoint https://api.openai.com/v1 --credential-from-env OPENAI_API_KEY
```

- **路由**：`model` 是 Model Ref，或 `group/<id>`（按成员顺序，组中的组展开在其位置上）。设置了 `imageEndpoint`（不含操作路径，网关追加 `/images/generations` 或 `/images/edits`）的 provider 先经图像端点请求；没有图像端点但有 Chat 端点的 provider 经 chat completions 请求（Magpie 对非 Images API 模型的做法）。订阅 provider 不参与。两种方式都没有时 404 `images_unavailable`。Gateway Key 的 `modelAllow`、配额与熔断照常适用；上游失败时按模型调用的规则转移到下一个 Credential。
- **图像端点**：JSON 请求只把 `model` 改为 wire 名，提示词经过出站脱敏，其余字段原样转发；multipart 编辑重新组成表单发出（字段与文件原样，`model` 为 wire 名，`prompt` 经脱敏）。JSON 答复与 `stream: true` 的事件（`image_generation.partial_image`、`image_generation.completed` 等）原样返回；上游最多等 5 分钟。
- **经 Chat 画图**：请求为 `modalities: ["image", "text"]`、非流式的 chat completions，用户消息是提示词（`size` 换算成“Aspect ratio: 3:2.”一类的说明，`background: "transparent"` 加上“Transparent background.”）与要编辑的图片（`image_url`，data URL 或 http(s) URL），并带 `image_config.aspect_ratio`。每张图一次调用，`n` 至多 4（更多时不走这种方式）。答复中的图片取自 `message.images[].image_url`、内容中的 `image_url` 部分、AIHubMix 的 `multi_mod_content` 或文本中 markdown 形式的 data URL，以 Images 的形式返回（`data[]` 的 `b64_json` 与 `mime_type`，或 `url`；`usage` 为各次的 `prompt_tokens`、`completion_tokens` 之和；模型说的话放在 `text`）；请求了 `stream: true` 时，每张图一个 `image_generation.completed`（编辑为 `image_edit.completed`）事件。没有画出图片时 502，转移到下一个 Credential。
- **回退**：图像端点答复 404 或 405 时，在同一个 Credential 上改经 Chat 再请求一次（provider 有 Chat 端点时）；这次成功则采用它的结果，否则返回图像端点的错误。账本的 `patches[]` 记 `images:chat-after-images`，经 Chat 画出的另记 `images:via-chat`，两次尝试都在 `attempts[]` 中（第一次的 `decision` 为 `retry`）。
- **记录**：每次调用一个账本条目（`inbound.path` 为 `/v1/images/generations` 或 `/v1/images/edits`），用量取答复或完成事件中的 `usage`（`gpt-image-*` 按 token 报告），模型有价格时按输入与输出价格计费，没有用量的上游（如 DALL·E）费用为空。
- 不在范围内：为没有指定模型的请求自动选择画图模型（Magpie 的 `imageGen` 设置与自动选择）、Gemini 原生 `generateContent` 画图、视频、图像 MCP；`multipart` 表单中的图片只取上传的文件，不下载 URL。

## 工具搜索

Agent 可以先不把全部工具发给模型，让模型按需搜索（对标 Magpie `gw/toolsearch.go`，实现在 [toolsearch.ts](../packages/gateway/src/toolsearch.ts)）。只有厂商自己的后端认识这类工具，网关为其他上游改写。

- **Codex**：`tool_search` 工具（`execution: "client"`，由 Codex 自己执行搜索）发往上游时是普通函数 `tool_search`，描述与参数不变；历史中的 `tool_search_call` 是对它的 `function_call`（不带项 ID），`tool_search_output` 是 `function_call_output`，内容为 “These tools are now available to call: a, b”（没有结果时为 “No tools matched the search.”），找到的工具去掉 `defer_loading` 后加入工具列表，每个只加一次，同一命名空间再次找到时只补上缺少的工具。模型调用 `tool_search` 函数（不带命名空间）时，答复中的该项改回 Codex 执行的 `tool_search_call`（`execution: "client"`，`arguments` 为对象），流式事件与 JSON 答复都改。直通到 Responses 上游时改写请求体，账本记 `tool-search:function`；转换的请求（Chat 等上游）在转换中完成，命名空间中的工具按转换时提供给模型的名称列出，`tool_search_call` 的 ID 以 `tsc_` 开头。`execution` 不是 `client` 的托管搜索仍按托管工具拒绝。订阅账号的请求总是转换，不直通。
- **Claude Code**：ToolSearch 的工具结果中的 `tool_reference` 块在转换时成为 “Tool X is loaded and can be called now.”（每个一行，接在结果文字之后），`DeferredToolPlaceholder` 工具不提供给模型；工具定义上的 `defer_loading` 在转换中不发送。直通到 Anthropic 端点时原样发送。
- **验证**：[工具搜索测试](../packages/gateway/test/gateway-tool-search.test.ts) 覆盖请求改写、命名空间合并、空结果、长名称、流式（任意切分）与 JSON 答复的改回、带命名空间的同名调用不改，以及两种转换；[集成测试](../tests/integration/shared-gateway-tool-search-compaction.test.ts) 经正式守护进程连接白名单模式的[假 provider](../tools/fake-provider/README.md)（`execution`、`tools`、`defer_loading` 在那里都是违规字段），对 Responses 直通与 Chat 转换、流式与非流式各做一次搜索往返与调用找到的工具，以及 Anthropic 到 Chat 的 `tool_reference`。尚未用真实 Codex 与 Claude Code 对真实上游验证。

## 上下文压缩

Agent 在上下文将满时请模型把对话写成摘要（对标 Magpie `gw/compacting.go` 与 `gw/codex_backend.go` 的压缩部分，实现在 [compacting.ts](../packages/gateway/src/compacting.ts)）。

- **识别**：`isCompactionRequest(protocol, body)` 是纯函数，按各 Agent 发布版本中的压缩提示词识别压缩请求：system 是（或以之开头）Claude Code 2.1、OpenCode、Pi、Gemini CLI 或 Qwen Code 的压缩提示词，或最后一条用户消息含有 Claude Code `/compact`、Codex 或 Kimi Code 的压缩要求，或 Responses 输入中有 `compaction_trigger`。目前只提供函数，供以后路由组的压缩规则使用；账本没有对应字段，不记录识别结果。
- **Codex 的 `compaction_trigger`**：发到 `/v1/responses` 的请求（模型都是 HarnessHub 的）中，这一项换成 Codex 自己的压缩提示词（openai/codex，Apache-2.0）的用户消息，请求去掉 `tools`、`tool_choice` 与 `parallel_tool_calls`，按普通调用路由（直通或转换都可以）。答复改写为 ChatGPT 的 Codex 后端的形式：模型的消息文字是摘要，成为一个 `compaction` 项，`id` 为 `cmp_<响应 ID>`，`encrypted_content` 为 `hh1:` 加摘要的 base64；流式时 `response.created`、`response.in_progress`、失败事件与注释立即转发，模型自己的项扣下，最后写出该项的 `response.output_item.added`、`response.output_item.done` 与带模型用量的 `response.completed`；非流式时该项成为 `output` 的唯一一项。错误答复原样返回。模型没有写出摘要（没有消息文字，例如只有推理）时，网关在记账之前就判定失败：账本记 502 `compaction_empty`（来源 `gateway`，上游的用量照常计入），客户端在还没有发出任何字节时得到 502 错误（“compaction: the model wrote no summary”），流已开始时得到同样消息的 `response.failed`。账本记 `compaction:summary`。
- **之后的请求**：输入中 `encrypted_content` 以 `hh1:` 开头的 `compaction` 或 `compaction_summary` 项换成用户消息：Codex 的摘要前言（“Another language model started to solve this problem…”）、换行与摘要，账本记 `compaction:restored:<n>`；其他压缩项（OpenAI 封存的）不变。Codex 透传（`/backend-api/codex/responses`）同样换回，但其中的 `compaction_trigger` 属于 ChatGPT 自己的模型，原样转发。
- **`/responses/compact`**：`/v1/responses/compact` 答复 400 `compact_unsupported`：“/responses/compact is not supported for HarnessHub models; use a compaction_trigger on /responses”，写拒绝记录；Codex 透传中模型带 `/` 的同一路径也如此，不转发给 ChatGPT。
- **封存的推理与压缩**：一个账号或厂商封存的 `encrypted_content` 另一个读不了。网关自己编码的推理（转换答复中的推理项，`hh-r1.`）不直通到 Responses 上游，也不经 Codex 透传发给 ChatGPT，账本记 `reasoning:dropped:<n>`。路由粘性让会话留在答复它的 Credential 上；会话仍被换到别处、上游以 `invalid_encrypted_content` 或“encrypted content … could not be verified/decrypted”拒绝时，网关去掉请求中的推理项在同一候选上重发，再被拒绝（或没有推理项）时去掉封存的压缩项再重发，每次调用至多两次，账本的尝试记为 `retry`、`patches[]` 记 `sealed:reasoning` 或 `sealed:compaction`，不计入熔断。只用于 Responses 入站。Magpie 另外按会话记住被拒绝的封存项、之后的请求预先去掉，本网关每轮重新被拒绝一次。
- **验证**：[压缩测试](../packages/gateway/test/gateway-compaction.test.ts) 覆盖七种 Agent 的压缩请求与不应识别的样例、请求改写、流式（任意切分）与 JSON 的摘要改写、失败与错误答复、没有摘要、封存项的去除顺序与网关自己的推理；[Codex 透传测试](../packages/gateway/test/shared-gateway-codex.test.ts) 覆盖 `/responses/compact` 的 400 与摘要、推理的换回；[集成测试](../tests/integration/shared-gateway-tool-search-compaction.test.ts) 经正式守护进程对 Responses 直通与 Chat 转换、流式与非流式各做一次压缩与恢复（工具若随压缩请求发出，假 provider 的脚本会答出别的内容），并以假 provider 的 `foreignSeals` 怪癖验证推理与压缩被拒绝后的重发、网关推理的预先删除与 `/v1/responses/compact` 的 400。尚未用真实 Codex 对真实上游验证 `compaction_trigger`。
