# 假 provider

`tools/fake-provider` 是测试与本机开发使用的严格模拟上游（[10 第 3.4 节](../../docs/proposals/oss/10-engineering.md#34-报文黄金语料与严格模拟上游)）。它以四种协议回答模型请求，按字段清单检查每个请求，把违规字段连同路径以该协议自己的错误格式返回 400，并记录每个请求的鉴权结果与违规，但不记录提示词、回答或 Key 的值。它不调用任何真实模型，只在回环地址监听，没有依赖，不需要构建。

## 启动

程序接口：

```js
import { startFakeProvider } from "./tools/fake-provider/index.mjs";

const provider = await startFakeProvider({
  models: ["upstream-sim"],
  keys: { upstream: "合成的金丝雀值" },
});
// OpenAI 类客户端使用 `${provider.url}/v1`；Anthropic 与 Gemini 客户端使用 provider.url。
await provider.idle();
console.log(provider.records(), provider.violations());
await provider.close();
```

`startFakeProvider` 的全部选项、返回值与关闭语义写在 [index.mjs](index.mjs) 的 JSDoc 中。`close()` 停止监听，中止仍在进行的响应并取消它们的计时器，销毁连接，等所有处理结束后返回；可以重复调用。

命令行（在仓库根目录执行）：

```sh
HH_FAKE_KEY=合成的金丝雀值 node tools/fake-provider/index.mjs --port 0 --ready-file ready.json --key-env HH_FAKE_KEY
```

就绪后向标准输出与 `--ready-file` 写一行 JSON（`{"event":"fake-provider.ready","url",...}`）；就绪文件先写完再改名，轮询它的进程不会读到半个文件。收到 SIGINT 或 SIGTERM 时关闭并以 0 退出。参数错误、Key 变量为空或主机不是回环地址时打印原因并以 2 退出。

| 参数 | 默认 | 作用 |
|---|---|---|
| `--host` | `127.0.0.1` | 只接受回环地址（127.0.0.0/8、`::1`、`localhost`），其他地址在监听之前被拒绝 |
| `--port` | `0` | 监听端口，0 表示任选空闲端口 |
| `--ready-file FILE` | — | 就绪后写入的文件 |
| `--mode` | `blacklist` | 字段检查模式，`blacklist` 或 `whitelist` |
| `--model ID` | `upstream-sim` | 提供的模型，可重复；请求其他模型得到该协议的 404 |
| `--key-env NAME` | — | 从环境变量 NAME 读取一个接受的 Key，Key 标识即 NAME，可重复；Key 的值从不出现在参数中 |
| `--script FILE` | — | 脚本化回答（JSON） |
| `--fields FILE` | — | 字段清单（JSON），追加到内置清单 |
| `--quirk NAME[=VALUE]` | — | 打开一个怪癖，可重复；VALUE 能按 JSON 解析时按 JSON，否则为字符串 |
| `--log FILE` | — | 另把每条请求记录追加为 JSON 行 |
| `--chunk-delay-ms` | `15` | 流式帧之间的间隔 |
| `--slow-ms` | `120000` | `HH_MOCK_SLOW` 回答的时长 |
| `--stream-only` | 关 | 拒绝非流式请求 |
| `--no-reasoning-replay` | 关 | 不要求工具结果回传推理内容 |

程序接口另有 `keyModels`（键为 `keys` 中的 Key ID，值为 `models` 的非空子集）：这把 Key 的模型列表只有这些模型，调用其他模型按该协议返回 404 并记 `model` 违规，用于模拟每把 Key 看到不同模型的厂商（按套餐分组的中转、OpenRouter 的 Key）；没有列出的 Key 看到全部 `models`。程序接口另有 `forbiddenHeaders`（小写请求头名的列表）：带有其中任何一个请求头的请求是 `header:<名称>` 处的 `forbidden` 违规，按该协议返回 400，用于证明客户端自己的登录（如 Codex 的 `Authorization` 与 `ChatGPT-Account-Id`）没有被转发给这个上游。

## 协议

| 协议 | 端点 | 鉴权 | 错误信封 |
|---|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | `Authorization: Bearer` | `{"error":{"message","type","param","code"}}`，`param` 为第一个违规的路径 |
| OpenAI Responses | `POST /v1/responses` | `Authorization: Bearer` | 同上 |
| Anthropic Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` | `x-api-key`，并要求 `anthropic-version` | `{"type":"error","error":{"type","message"},"request_id"}`，消息以路径开头 |
| Gemini | `POST /v1beta/models/{model}:generateContent`、`:streamGenerateContent`（`/v1/models/...` 同样可用） | `x-goog-api-key` 或 `?key=` | `{"error":{"code","message","status","details"}}`，`details` 的 `fieldViolations` 列出全部违规 |
| 模型列表 | `GET /v1/models` | 同 OpenAI；带 `anthropic-version` 时按 Anthropic | — |

报文形态按各厂商公开文档实现，非显然之处在各协议模块中注明出处：[chat.mjs](chat.mjs) 的推理内容为 DeepSeek 的 `reasoning_content`，流式的 usage 随结束块发送；[responses.mjs](responses.mjs) 使用命名事件并以 `response.completed` 或 `response.incomplete` 结束，没有 `[DONE]`；[messages.mjs](messages.mjs) 只在请求开启 `thinking` 时返回思考块；[gemini.mjs](gemini.mjs) 的 `alt=sse` 以 CRLF 分隔事件，没有 `alt=sse` 时以流式 JSON 数组返回，思考片段只在 `includeThoughts` 时返回，推理存在时第一个函数调用带 `thoughtSignature`。

鉴权失败按各协议原样返回：OpenAI 与 Anthropic 为 401；Gemini 缺少 Key 为 403 `PERMISSION_DENIED`，Key 无效为 400 `INVALID_ARGUMENT`（`API_KEY_INVALID`）。没有配置任何 Key 时接受所有请求。

## 字段检查

字段清单是 [fields.mjs](fields.mjs) 中的数据，每个协议分作用域（顶层、消息、内容片段、工具定义，以及 Chat 的 `function`、Gemini 的函数声明与 `generationConfig`、消息角色）列出两份名单：

- 黑名单模式（默认）拒绝已知的厂商私有字段与其他协议的字段，例如 Chat 中的 `store`、`stream_options`、`max_completion_tokens`、`developer` 角色与 Anthropic 的 `cache_control`。名单之外的未知字段放行。
- 白名单模式只接受该协议公开文档中、无状态上游为单个请求实现的可移植字段；托管状态、账户与路由控制等需要由字段清单显式加入。

另外两种模式都检查各协议的必需字段与结构（例如 Messages 的 `max_tokens`、Chat 只能有一条且位于开头的 system 消息、Chat 的 `tool_choice` 必须与 `tools` 同时出现）。字段清单的 `declared` 与 `forbidden` 只能追加；`allowed` 把字段从黑名单中移除并声明它，用于接受严格上游所拒绝字段的上游（如只接受 `max_completion_tokens` 的端点：`allowed` 中列出它，`forbidden` 中列出 `max_tokens`）。格式如下，`--fields` 或 `fields` 选项读入，未知协议、作用域或非字符串名称在启动前报错：

```json
{
  "chat": { "declared": { "topLevel": ["user"] } },
  "messages": { "forbidden": { "topLevel": { "metadata": "this upstream rejects metadata" } } }
}
```

## 回答

请求依次匹配脚本、内置指令，最后回答 `OK`。

内置指令在当前回合的用户文本中查找：`HH_MOCK_TOOL` 在请求提供 shell 类工具时返回一次写 `mock-ok.txt` 的工具调用，带回工具结果后回答 `DONE`，没有 shell 类工具时回答 `NO_SHELL_TOOL`，同一会话重复同一回合超过三次时回答 `DONE`；`HH_MOCK_SLOW` 慢速流式回答；`HH_MOCK_UNICODE` 回答固定的非 ASCII 文本。细节见 [script.mjs](script.mjs)。

推理回传：带工具结果的请求必须在该协议的原生位置带回这个 provider 发出该调用时的推理（Chat 的 `reasoning_content`、Responses 的 `reasoning` 项、开启 `thinking` 时 Messages 的思考块、Gemini 的 `thoughtSignature`），否则按该协议返回 400，与 DeepSeek 等推理模型的实测行为一致。`reasoningReplay: false` 或 `--no-reasoning-replay` 关闭这一要求；记录的 `reasoningEcho` 为 `true`、`false` 或 `"mismatch"`。

脚本是 `{"turns": [...]}`。每个请求取第一个尚未用过且 `when` 匹配的回合（`"repeat": true` 的回合可以反复使用）：

```json
{
  "turns": [
    { "when": { "contains": "deploy" }, "reasoning": "Plan first.", "text": ["Deploying", " now."], "chunkDelayMs": 50 },
    { "toolCalls": [{ "name": "bash", "arguments": { "command": "ls" } }] },
    { "when": { "toolResult": true }, "repeat": true, "text": "Done.", "usage": { "input": 10, "output": 2 } },
    { "when": { "offersTool": "read" }, "toolCalls": [{ "name": "read", "arguments": { "path": "token.txt" } }] },
    { "when": { "toolResultContains": "TOKEN-1" }, "text": "TOKEN-1" },
    { "status": 503, "error": "maintenance", "firstByteDelayMs": 200 },
    { "quirks": { "retryAfter": { "status": 429, "seconds": 2 } } }
  ]
}
```

`when` 的条件都满足才匹配：`contains`（本轮用户文字包含）、`toolResult`（请求是否以工具结果结尾）、`toolResultContains`（以包含该文字的工具结果结尾）、`offersTool`（请求提供了该名称的工具）。回合字段：`reasoning`、`text`（字符串或分块数组）、`toolCalls`、`finish`（`stop`、`length`、`tool_calls`、`content_filter` 按协议映射，其他值原样发送）、`usage`（或 `false`）、`status` 与 `error`（错误响应）、`firstByteDelayMs`（流式先发响应头，非流式连同响应头一起延迟）、`chunkDelayMs`、`quirks`。脚本在启动前校验，错误信息给出第一个无效设置的路径。

`usage` 的 `cached` 是 `input` 中命中提示缓存的部分，按各协议自己的字段报告：Chat 的 `prompt_tokens_details.cached_tokens`、Responses 的 `input_tokens_details.cached_tokens`、Messages 的 `cache_read_input_tokens`（`input_tokens` 不含它）、Gemini 的 `cachedContentTokenCount`。工具调用写 `"input": "原文"` 而不是 `arguments` 时是 custom（自由格式）工具调用，只有 Responses 有：以 `custom_tool_call` 项与 `response.custom_tool_call_input.*` 事件发送，带回的 `custom_tool_call` 与 `custom_tool_call_output` 被读取；其他协议回答这样的回合时返回 500 并指出脚本回合。

请求记录另含 `images`：本次请求用户消息中的图片片段数。

## 怪癖

怪癖可以对所有请求打开（`quirks` 选项或 `--quirk`），也可以写在某个脚本回合中，回合中的值覆盖全局值（`false` 关闭）。取值与效果见 [quirks.mjs](quirks.mjs) 的表格：

| 怪癖 | 效果 |
|---|---|
| `noUsage` | 不返回 usage |
| `duplicateFinish` | 流式重复结束事件 |
| `missingToolIndex` | 流式工具参数增量缺少序号 |
| `commentKeepalive` | 首个数据之前只发保活：流式为 SSE 注释，其他为 JSON 空白 |
| `htmlBody` | HTTP 200 返回 HTML 页面 |
| `abnormalFinish` | 以非标准结束原因结束（默认 `network_error`） |
| `slowHeaders` | 延迟发送响应头 |
| `interleavedToolArgs` | 并行工具调用先全部开始，参数增量再在各调用之间交替（Chat 按 `index`，Responses 按 `output_index`）；Messages 的块按协议顺序发送，Gemini 整体发送调用，两者不受影响 |
| `midStreamError` | 流式在若干帧后以该协议的流内错误结束（Gemini 的 `alt=sse` 为事件之后的裸 JSON 错误对象，与 Gemini API 相同，也是 `@google/genai` 识别的形式）；非流式发送一半响应体后断开连接 |
| `disconnect` | 若干帧（默认 1）后直接断开连接，不发错误也不发结束事件；非流式发送一半响应体后断开 |
| `retryAfter` | 429 或 503，带 `Retry-After` 头与该协议的错误体 |
| `servedModel` | 回答中的模型名换成给定值（模拟替换模型的中转） |
| `foreignSeals` | 只用于 Responses、只能全局打开：输入项带有不是本 provider 签发的 `encrypted_content` 时，在安排回合之前按 OpenAI 的方式返回 400 `invalid_encrypted_content`（模拟拒绝别的账号封存的推理或压缩） |
| `refuse` | 每个请求都以该协议的错误体拒绝，措辞取自对应的真实厂商：`policy`（400，OpenAI 的安全拒绝 `content_policy_violation`，作为错误的 `code`，Messages 作为 `type`；Gemini 的错误体没有这两个字段，用 `safetyRefusal`）、`shape`（422，xAI 的 “Failed to deserialize the JSON body …: unknown item type”）、`channel`（400，WorkBuddy 的 “Illegal API invocation from an unapproved channel”）、`busy`（400，“The engine is currently overloaded”）、`unserved`（400，“The model … does not exist”）、`client`（422，axum 的 “… missing field `messages`”，属于客户端自己的错误） |
| `tokenFloor` | 请求的回复长度（`max_tokens`、`max_completion_tokens`、`max_output_tokens`、Gemini 的 `generationConfig.maxOutputTokens`）小于给定值（1–1024）时返回 400 “<字段> must be at least N”；没有要求长度或足够时正常回答 |
| `safetyRefusal` | 回答不含文字、推理或工具调用，以该协议的安全拒绝结束：Chat 的 `content_filter`、Responses 的 incomplete `content_filter`、Messages 的 `refusal`、Gemini 的 `SAFETY` |

## 观测

每个请求在响应关闭后留下一条记录：方法、路径、协议、状态码、`auth`（`ok`、`missing`、`invalid` 或 `not-required`）、`keyId`（匹配的 Key 标识）、`keyFingerprint`（所出示凭据 SHA-256 的前 16 位十六进制，`credentialFingerprint()` 可算出同一值）、模型、是否流式、回合类型、`violations`（路径、规则与说明）、推理回传结果、所开怪癖、是否被客户端中断与耗时。记录不含提示词、回答文本或任何 Key 的值。

`records(after)`、`violations()`、`activity()`（进行中的响应、等待中的计时器与打开的连接数）与 `idle()` 供进程内测试使用；`GET /__fake/requests?after=<seq>` 与 `GET /__fake/health` 供其他进程使用。

## 验证

- [协议矩阵](protocols.test.mjs)：每个协议的流式与非流式各有接受样例、黑名单拒绝、带路径的白名单拒绝、鉴权失败与错误信封；另有模型列表、count_tokens、移植的 Chat 规则、字段清单与选项校验。
- [怪癖](quirks.test.mjs)与[脚本](script.test.mjs)：每个怪癖与每项脚本功能一个可观察的用例，内置指令与四个协议的推理回传。
- [服务](server.test.mjs)：拒绝非回环地址；客户端中途断开后不留响应、计时器与连接（去掉计时器的取消时该用例失败）；记录与日志中没有提示词与 Key；命令行的就绪文件、信号退出与错误退出。
- [Provider 体检](../../tests/integration/provider-doctor.test.ts)：以字段清单与怪癖为体检的每项检查构造通过与失败的上游。
- [真实网关集成](../../tests/integration/fake-provider.test.ts)：真实的会话模型网关以 Chat 上游连接黑名单模式的假 provider，经四种入站协议各发流式与非流式请求（含工具往返），断言零违规、只出现配置的上游 Key；兼容性设置让网关发送 `stream_options` 与 `max_completion_tokens` 时，假 provider 报告这两处违规；另从守护进程、Worker 与 ACP 夹具引擎完成一次 Run。

```sh
node tools/run-tests.mjs tooling tools/fake-provider/*.test.mjs
pnpm build && node tools/run-tests.mjs integration dist/tests/integration/fake-provider.test.js
```

尚未实现：语料录制（`tools/capture-corpus`，M1）；以 `hh provider add` 登记与开发模式的 `dev/fake` 预设（M1 或之后）；以官方 SDK 作为客户端解析各协议输出（M1 协议一致性套件）。本目录的解码器 [decode.mjs](decode.mjs) 按文档独立编写，不是官方 SDK。
