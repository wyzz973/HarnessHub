# ADR 0013：统一模型网关

Status: accepted

开源版计划在 M1 以共享网关与作用域 Gateway Key 取代本决定，见 [ADR 草案](../proposals/oss/adr-drafts.md#adr-p03-共享网关与作用域-gateway-key)。

日期：2026-09-19
关联决定：扩展 ADR 0011（归档于 `archive/competition` 分支的 `0011-chat-completions-bridge.md`）（协议桥从 Codex/Gemini 推广到全部引擎）；沿用 [ADR 0006](0006-engine-configuration.md) 的秘密引用与 revision 规则。

## 问题

- 目标上游模型是推理模型，只提供**流式** OpenAI Chat Completions，支持工具调用。
- 用户要求所有 Agent 只能使用 HarnessHub 配置的同一个模型，不能回落到引擎自带的 Provider、账号或其他模型。
- 目标环境实测：Codex（原生 Responses）、Qwen、Hermes 失败，公开错误只有 `Engine execution failed; inspect the local engine configuration`。
- 本机复现与源码调研得到的根因：
  - 各引擎直接连上游网关，附带的非通用参数不同（`stream_options`、`store`、`max_completion_tokens`、多条 system 消息等）。
  - 输出上限各自为政（OpenCode 32000、Hermes 65536），上下文窗口无法配置。
  - 引擎按模型名或 URL 做路由和参数推断：Hermes 会按模型名把部分请求改路由到 OpenRouter；Gemini 的子代理固定使用 `gemini-3`。
  - 现有 Codex/Gemini 桥对上游流的格式要求过严：缺 `index`、`finish_reason` 重复、usage 缺字段都会失败。它还把 4xx 统一改成 502 并丢弃错误体，导致 Gemini 重试到超时。
  - 模型报错时，引擎常以空回复正常结束本轮，Runtime 记为 `completed`。

## 决定

### 1. 单一统一模型

- **定义**：`HarnessModel`（[src/domain/harness-model.ts](../../src/domain/harness-model.ts)）是唯一的模型定义。`provider.protocol` 表示上游协议，当前交付为 `openai-completions`。
- **来源与优先级**：
  1. 环境变量 `HARNESSHUB_MODEL*`，便于无人值守部署时注入；
  2. `harnessModelFile`，由 API 或控制台写入；
  3. 配置文件的顶层 `model`。

  环境变量只在本次进程生效，不写回文件。
- **强制使用**：Gateway 在每个引擎登记或替换前，都用统一模型覆盖该引擎的 `configuration.provider` 和 `model`，包括文件配置、API、SQLite overlay 和工具包应用，每次都生成新 revision。
  - 覆盖时同时移除 `credentialEnv` 和引擎级 `configuration.secretEnv`，厂商凭据不再传给引擎；MCP 服务自己的秘密引用保留。
  - 配置文件和 overlay 保存原始登记，引擎目录与新 Session 使用覆盖后的生效登记，两种 revision 都持久化。
  - 配置文件顶层 `model` 变化需要重启；`PUT` 立即生效。无法经网关接入的适配器（cursor、antigravity、kiro、qoder、generic）一律禁用，并给出原因，不允许回落到原生账号。未配置统一模型时保持旧行为，以兼容普通开发环境。
- **模型名**：引擎看到的模型 id 是 `alias`，默认 `harnesshub-model`，上游一律使用真实 `model`。这样避开了引擎按名称做的路由和上限推断。

### 2. Worker 内的统一模型网关

每个 Session 的 Worker 在准备配置时启动一个 loopback 监听，绑定 `127.0.0.1` 随机端口并生成随机令牌。它取代 Codex/Gemini 专用的桥，供全部引擎使用。

**面向引擎的入口**：

| 协议 | 路径 | 使用者 |
|---|---|---|
| OpenAI Chat | `POST /v1/chat/completions` | OpenCode、Pi、Qwen、Hermes、OpenClaw、MiMo、DSH、Kimi、Copilot |
| OpenAI Responses | `POST /v1/responses` | Codex |
| Anthropic Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` | Claude Code |
| Google | `POST /v1beta/models/{m}:generateContent`、`:streamGenerateContent` | Gemini |
| 模型列表 | `GET /v1/models`、`GET /v1/models/{id}` | 探测模型的引擎 |

鉴权接受 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 或查询参数 `key`。

**上游请求**：

- 总是流式 Chat Completions，`model` 固定为统一模型。
- 非流式入站请求，由网关聚合流式结果后返回完整响应。
- 默认去掉 `store`、`metadata`、`service_tier`、`prediction`、`modalities`、`audio`、`web_search_options`、`user`、`parallel_tool_calls`、`reasoning_effort`；`compatibility.dropParameters` 可追加。`reasoning_effort` 是 OpenAI 推理模型的参数（Kimi 会发送），目标上游的推理模型网关拒绝它，推理强度由上游模型自身配置决定。
- 没有 tools 时，同时去掉 `tool_choice`；`response_format: json_schema` 降级为 `json_object`。选择保守默认值的理由：上游网关的严格程度未知，保留这些参数一旦被拒绝，Codex 每次主调用都会失败；而去掉后即使上游网关本来支持，损失也很小。
- `developer` 角色转为 `system`；多条 system 消息合并为开头的一条；全是文本分片的 content 合并成字符串。
- 输出上限统一写入 `compatibility.maxTokensField`（默认 `max_tokens`），并按 `maxOutputTokens` 截断。
- `stream_options.include_usage` 仅在 `compatibility.includeUsage` 为 true 时发送。

**解析上游流**：

- 按宽松规则解析：缺失或为 null 的 `index`、`delta`、`id` 视为缺省；重复的 `finish_reason` 以最后一次为准；缺少 `[DONE]` 时，以连接正常结束为准；usage 宽松解析；无参工具的空参数串视为 `{}`。
- `finish_reason` 规范化：只要有工具调用就返回 `tool_calls`，流正常结束但没有给出原因时返回 `stop`。

**推理内容**：2026-09-19 实测，DeepSeek 推理模式下，工具调用的后续请求如果没带回 `reasoning_content`，会返回 400（"must be passed back"）。因此默认必须回填推理内容。上游的 `reasoning_content` 或 `reasoning` 会原样转给支持的入站协议：

- Chat：原字段；
- Responses：reasoning item；
- Anthropic：thinking block；
- Google：thought part。

网关在本 Session 内按 tool_call id 和助手消息缓存推理内容。引擎回传历史时，网关把推理内容重新附到对应的助手消息上。`compatibility.reasoning: strip` 时不转发推理内容。

**媒体**：图片、文档、音频等媒体不再使整个 Session 失败，统一替换为文字占位。`compatibility.images: passthrough` 时保留 Chat 请求中的 `image_url`，供支持视觉的上游使用（2026-09-19 决定：当时上游模型是否支持视觉尚未确认，默认按纯文本处理）。

**错误**：

- 上游 4xx/5xx 保持原状态码，按入站协议的错误格式返回脱敏、截断后的错误信息。
- 上下文超长时映射为各协议的上下文超限错误。
- 每次调用产生一条 `model.call` 事件（见下方约定），其中不含提示词和秘密。

**Run 结果**：

- Run 结束时，如果本 Run 出现过上游错误且引擎没有产出正文、也没有工具调用，Worker 将结果改为失败，错误码 `MODEL_UPSTREAM_ERROR`，消息为脱敏后的上游原因。
- 其他意外错误公开为脱敏后的真实原因（最多 500 字符），不再使用固定文案；完整堆栈只写入该 Session 私有目录下的诊断日志。
- 以上两类模型失败（`MODEL_UPSTREAM_ERROR`、`ENGINE_NO_OUTPUT`）不关闭 ACP 会话，也不回收 Worker：引擎进程本身正常，同一 Session 可以继续下一轮，例如调用方遇到偶发上游错误后重试。其他失败仍按原规则关闭会话。
- ACP 引擎报告的失败原因（对话失败、`engine.error` 事件）也随结果和事件公开，最多 500 字符；引擎只拿到网关的本地令牌，接触不到上游密钥。

### 3. Gateway 远程绑定

- 显式 `--host` 为非回环地址（如 `0.0.0.0`）时接受任意 `Host`，供另一台机器或容器中的客户端调用；这种绑定没有鉴权，只应在隔离网络中使用。默认的 localhost 绑定仍只接受回环 `Host`，浏览器跨源请求在任何绑定下都被拒绝。

### 4. 工具包与控制台

- **工具包**：`POST /v1/tool-packs/apply` 接受 `engineIds: "all" | string[]`，并逐个引擎返回结果。新增 `POST /v1/tool-packs/import`，可以直接导入 Skill 目录、标准 `mcpServers` JSON 或 CLI 清单，由服务端生成清单和 sha256。
- **控制台**：Gateway 配置了控制台地址（`--console-url`）时，根路径 `/` 跳转过去。控制台新增统一模型页和工具包页，默认进入直接对话模式。

### 5. 响应头、保活与空闲超时（2026-10-02 补充）

上游长时间推理而引擎收不到字节时，引擎按自己的超时断开并带完整上下文重试。2026-10-02 的核验在本机复现了两类失败：Gemini 的 SSE 回答在首个正文之前不发响应头，Gemini 客户端 60 秒拿不到响应头即重发；Codex 在上游只发注释时空闲超时。决定如下，行为细节见 [统一模型网关](../model-gateway.md#响应头保活与空闲超时)：

- 流式响应在首个有效上游块时提交并 flush 响应头。没有重试或转移，因此不扣留：在此之前上游错误仍以真实状态码返回。
- 保活按入站协议决定、不按引擎分支，且从不使用 SSE 注释：Chat 为空 delta 块，Responses 重发 `response.in_progress`，Anthropic 为 `ping`，Gemini SSE 为空 parts 的 candidate，Gemini JSON 为空白。只在上游仍有活动、引擎已静默 `keepaliveGapMs`、距上一个上游数据事件不超过 `maxNoDataMs` 时发送；保活不计入任何证据。
- 空闲超时只被上游响应头与数据事件重置。此前任意字节都会重置，只发注释的上游可以让网关无限等待。
- Gemini 响应头提交期限 45 秒的解释：从上游以 2xx 应答（收到响应头）开始计时，到期仍没有首个数据块就提交 200。上游一直不应答时不提交，仍以 504 结束，保留“上游完全静默时返回 504”的反例。
- Gemini 非流式在首个有效上游块时提交 200 并以空白保活。提交后的失败写成 `{"error":{...}}` 响应体，HTTP 状态保持 200；调用记录与流内失败相同，记录失败本应对应的状态并计入 `runErrors()`，Run 结果判定因此不受影响。考虑过的替代方案是提交后失败时直接断开连接：客户端会看到网络错误而重试，但失败原因丢失，且与流式协议在流内报告错误的做法不一致，因此不采用。

## 接口约定

以下约定供并行实现使用，实现与本节不一致时以本节为准并先修改本节。

### 模型网关模块

```ts
// src/drivers/chat-completions/gateway.ts
export type InboundProtocol = "openai-completions" | "openai-responses" | "anthropic" | "google";
export interface ModelGatewayOptions {
  upstream: {
    protocol: "openai-completions";
    baseUrl: string; // 上游地址，包含可选 /v1 或路径前缀，网关追加 /chat/completions
    apiKey?: string; // 已解析的秘密，不得记录
    headers?: Record<string, string>; // 已解析的请求头，可能含秘密
  };
  model: string; // 上游唯一模型
  alias: string; // 引擎看到的模型 id
  contextWindow?: number;
  maxOutputTokens?: number;
  compatibility?: ModelCompatibility; // src/domain/engine-configuration.ts
  onCall?: (call: ModelCallRecord) => void;
}
export interface ModelCallRecord {
  id: string;
  inbound: InboundProtocol;
  stream: boolean;
  requestedModel?: string;
  upstreamModel: string;
  status: number;
  ok: boolean;
  durationMs: number;
  finishReason?: string;
  usage?: { input?: number; output?: number; total?: number; reasoning?: number };
  toolCalls: number;
  error?: { code: string; message: string }; // 脱敏、≤500 字符
}
export interface ModelGateway {
  readonly baseUrl: string; // http://127.0.0.1:<port>，不带 /v1
  readonly token: string;
  beginRun(signal: AbortSignal): void;
  endRun(): Promise<void>;
  /** 当前 Run 内失败的上游调用，按时间先后排列。 */
  runErrors(): ModelCallRecord[];
  close(): Promise<void>;
}
export function startModelGateway(options: ModelGatewayOptions): Promise<ModelGateway>;
```

### `model.call` 事件

Worker 把 `ModelCallRecord` 原样作为 `type: "model.call"` 的事件 `data` 上报。控制台和观测页据此展示每次模型调用。

### 统一模型的配置与接口

- 配置文件用顶层 `model: HarnessModel`。
- `harnessModelFile` 的内容是一个 `HarnessModel` JSON 对象（POSIX 下文件权限 0600），缺省为 `<数据目录>/harness-model.json`，可用 `--harness-model-file` 指定。
- HTTP 接口：
  - `GET /v1/harness/model` 返回 `HarnessModelView`。
  - `PUT /v1/harness/model`：body 为 `HarnessModel`，其中 apiKey 只接受秘密引用。写入文件，并为全部引擎重新登记新 revision，返回 `HarnessModelView`。
  - `POST /v1/harness/model/test`：在默认或指定引擎上创建正式 Session，提交“只回复 OK”，最多等待 90 秒，会实际调用模型。秘密仍只在 Worker 中解析。返回 `{ ok, status, durationMs, runId, error? }`。

### 引擎登记字段

- 统一模型写入每个引擎登记：`model` 为上游真实模型；`configuration.provider` 为统一模型的 provider；`provider.modelAlias` 为引擎看到的模型名（缺省 `harnesshub-model`）。
- Worker 按适配器选择入站协议，引擎只拿到网关地址和本地令牌。

### 运行信息

`GET /v1/runtime/info` 返回 `{ fullAccess: boolean, consoleUrl?: string }`，供控制台显示当前运行模式。（2026-10-02 起另含必需字段 `build`，即构建身份，见 [快速开始](../getting-started.md) 的 `--version`。）

### 会话工作目录占位符

工具包绑定时，工作目录相关的参数、环境变量和 CLI 工作目录都写成 `${HARNESSHUB_SESSION_WORKSPACE}`，不再写死绝对路径。Worker 准备 MCP 时，把它替换为当前 Session 的实际目录。

### 工具包接口

- `POST /v1/tool-packs/apply`
  - body：`{ engineIds?: "all" | string[]; engineId?: string; package?: {id,version}; source?: string; workspace?: string; secretBindings?: {...} }`
  - 响应：`{ ok, package: {id,version}, results: [{ engineId, status: "applied"|"skipped"|"failed", revision?, reason?, capabilities?: {skills,mcp,cli} }] }`
  - 旧的单引擎字段仍在顶层保留。
- `POST /v1/tool-packs/import`
  - body：`{ source: string; kind?: "auto"|"skills"|"mcp"|"cli"; id?: string; version?: string; applyTo?: "all" | string[] }`
  - 响应：`{ ok, package: {id,version}, counts: {skills,mcp,cli}, apply?: <apply 响应> }`

## 考虑过的替代方案

- **逐个引擎修原生配置**：比如关闭各引擎的 `stream_options`、改输出上限。每个引擎的参数和版本都要单独维护，也无法保证"只用一个模型"，模型和上游错误依然不可观测。
- **把网关放在 Gateway 父进程**：可以少启动监听，但秘密将在父进程解析，违反"秘密只在所属 Worker 解析"的既定约束（ADR 0006/0011）。另外 Run 所有权、取消和清理都要另建跨进程机制。
- **要求上游网关增加 Responses、Anthropic、Google 协议**：不符合上游现有接口约束。
- **以 SSE 注释作为统一保活**（第 5 节）：实现最简单，但 openai-node 丢弃注释、`@google/genai` 1.30.0 遇注释会卡住、Codex 只按事件计空闲，对这三类客户端无效或有害，因此按协议发送原生事件。

## 后果

- **收益**：
  - 引擎只拿到本地令牌，不直接持有上游秘密；
  - 所有模型调用都可观测，并能证明只用了统一模型；
  - 兼容处理只写一处。
- **代价**：
  - 默认模式下图片内容不会到达模型，需要视觉的任务要改为 passthrough 并确认上游支持；
  - 网关会重写请求，引擎的模型专用优化（按模型名开启的特性）会失效；
  - 缓存推理内容会占用 Session 内存，上限跟随现有的 8 MiB 请求限制；
  - 转换覆盖不了各厂商的托管工具和多模态，这类请求会明确失败。
- **重新评估**：上游网关提供原生 Responses 或 Anthropic 协议时，可以允许对应引擎直连，但仍需经过同一个观测点。

## 验证要求

- **单元测试**：
  - 覆盖四种入站协议在流式和非流式下的转换；
  - 覆盖宽松解析的各种变体（缺 `index`、重复 `finish_reason`、"stop + 工具调用"、缺 `[DONE]`、usage 缺字段、空参数）；
  - 覆盖推理内容的回填、错误状态码透传、`max_tokens` 截断和参数清理；
  - 覆盖第 5 节：响应头时机、四种流式协议的保活形态与不变的输出和证据、只发注释的上游超时、上游完全静默时的 504，以及 Gemini 非流式的空白保活与提交后失败。每项须在修复前的代码上失败。
- **集成测试**：用正式 Gateway 和 Worker 验证：
  - 统一模型强制生效，旧的 per-engine provider 被覆盖；
  - 模型报错时 Run 失败，并带真实原因；
  - `model.call` 事件被提交；
- **Windows x64 真实引擎验收**：当时在 GitHub `windows-latest`（x64）CI 上以真实固定引擎和本地模拟模型（流式、推理型，要求回传推理内容；不在 GitHub 保存任何模型密钥）验证各引擎的启动与协议转换，本机以 DeepSeek 模型经严格代理验证文件任务和 Shell 任务。本机结果与 CI 结果都不能替代目标上游模型的验收。该 CI 作业未进入开源仓库，验收记录保留在 `archive/competition` 分支。
