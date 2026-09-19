# ADR 0013：统一模型网关与比赛交付升级

Status: accepted

日期：2026-09-19
关联决定：扩展 [ADR 0011](0011-chat-completions-bridge.md)（协议桥从 Codex/Gemini 推广到全部引擎）；沿用 [ADR 0006](0006-engine-configuration.md) 的秘密引用与 revision 规则。

## 问题

- 比赛机为离线 Windows x64。公司模型是推理模型，只提供**流式** OpenAI Chat Completions，支持工具调用。
- 用户要求所有 Agent 只能使用 HarnessHub 配置的同一个模型，不能回落到引擎自带的 Provider、账号或其他模型。
- 公司机实测：Codex（原生 Responses）、Qwen、Hermes 失败，公开错误只有 `Engine execution failed; inspect the local engine configuration`。
- 本机复现与源码调研得到的根因：
  - 各引擎直接连公司网关，附带的非通用参数不同（`stream_options`、`store`、`max_completion_tokens`、多条 system 消息等）。
  - 输出上限各自为政（OpenCode 32000、Hermes 65536），上下文窗口无法配置。
  - 引擎按模型名或 URL 做路由和参数推断：Hermes 会把 `glm-5.1` 这类名称改路由到 OpenRouter；Gemini 的子代理固定使用 `gemini-3`。
  - 现有 Codex/Gemini 桥对上游流的格式要求过严：缺 `index`、`finish_reason` 重复、usage 缺字段都会失败。它还把 4xx 统一改成 502 并丢弃错误体，导致 Gemini 重试到超时。
  - 模型报错时，引擎常以空回复正常结束本轮，Runtime 记为 `completed`。
- 比赛接口规范 v1.1 要求 `prompt_async` 阻塞到本轮完成；错误统一为 `{code,message}`；`directory` 必须支持。

## 决定

### 1. 单一统一模型

- **定义**：`HarnessModel`（[src/domain/harness-model.ts](../../src/domain/harness-model.ts)）是唯一的模型定义。`provider.protocol` 表示上游协议，当前交付为 `openai-completions`。
- **来源与优先级**：
  1. 环境变量 `HARNESSHUB_MODEL*`，便于评测系统无人值守注入；
  2. `harnessModelFile`，由 API、控制台或 `hub.cmd model` 写入；
  3. 发行包 `settings.json` 的顶层 `model`，或源码配置文件的顶层 `model`。

  环境变量只在本次进程生效，不写回文件。
- **强制使用**：Gateway 在每个引擎登记或替换前，都用统一模型覆盖该引擎的 `configuration.provider` 和 `model`，包括文件配置、API、SQLite overlay 和工具包应用，每次都生成新 revision。无法经网关接入的适配器（cursor、antigravity、kiro、qoder、generic）一律禁用，并给出原因，不允许回落到原生账号。未配置统一模型时保持旧行为，以兼容普通开发环境。
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
- 默认去掉 `store`、`metadata`、`service_tier`、`prediction`、`modalities`、`audio`、`web_search_options`、`user`；`compatibility.dropParameters` 可追加。
- 没有 tools 时，同时去掉 `tool_choice` 和 `parallel_tool_calls`。
- `developer` 角色转为 `system`；多条 system 消息合并为开头的一条；全是文本分片的 content 合并成字符串。
- 输出上限统一写入 `compatibility.maxTokensField`（默认 `max_tokens`），并按 `maxOutputTokens` 截断。
- `stream_options.include_usage` 仅在 `compatibility.includeUsage` 为 true 时发送。

**解析上游流**：

- 按宽松规则解析：缺失或为 null 的 `index`、`delta`、`id` 视为缺省；重复的 `finish_reason` 以最后一次为准；缺少 `[DONE]` 时，以连接正常结束为准；usage 宽松解析；无参工具的空参数串视为 `{}`。
- `finish_reason` 规范化：只要有工具调用就返回 `tool_calls`，流正常结束但没有给出原因时返回 `stop`。

**推理内容**：上游的 `reasoning_content` 或 `reasoning` 会原样转给支持的入站协议：

- Chat：原字段；
- Responses：reasoning item；
- Anthropic：thinking block；
- Google：thought part。

网关在本 Session 内按 tool_call id 和助手消息缓存推理内容。引擎回传历史时，网关把推理内容重新附到对应的助手消息上。`compatibility.reasoning: strip` 时不转发推理内容。

**错误**：

- 上游 4xx/5xx 保持原状态码，按入站协议的错误格式返回脱敏、截断后的错误信息。
- 上下文超长时映射为各协议的上下文超限错误。
- 每次调用产生一条 `model.call` 事件（见下方约定），其中不含提示词和秘密。

**Run 结果**：

- Run 结束时，如果本 Run 出现过上游错误且引擎没有产出正文、也没有工具调用，Worker 将结果改为失败，错误码 `MODEL_UPSTREAM_ERROR`，消息为脱敏后的上游原因。
- 其他意外错误公开为脱敏后的真实原因（最多 500 字符），不再使用固定文案；完整堆栈只写入该 Session 私有目录下的诊断日志。

### 3. 比赛接口（规范 v1.1）

- `prompt_async` 保持阻塞，这是规范 4.1 的要求。`model` 字段校验后写入 Run 路由记录，实际执行使用统一模型。
- 失败时推送 `session.error`。
- 所有错误都用 `{code,message}`：接受空 JSON 请求体，Fastify 的解析错误也映射到规范错误码。
- `directory` 不存在时自动创建。`/session` 固定使用启动引擎（`competitionEngine`）。
- 消息轨迹中补充 `tool_calls` 和 `tool` 角色消息。工具状态反映真实结果（running、completed、error）。

### 4. 工具包、控制台与交付

- **工具包**：`POST /v1/tool-packs/apply` 接受 `engineIds: "all" | string[]`，并逐个引擎返回结果。新增 `POST /v1/tool-packs/import`，可以直接导入 Skill 目录、标准 `mcpServers` JSON 或 CLI 清单，由服务端生成清单和 sha256。包内入口统一使用 `state/tool-packages`。
- **控制台**：比赛入口同时启动控制台，Gateway 根路径 `/` 跳转过去。控制台新增统一模型页和工具包页，默认进入直接对话模式。
- **交付**：
  - 源码变更会触发 x64 完整包和离线开发包的 CI 构建；
  - CI 在 GitHub `windows-latest`（x64）上用真实固定引擎和 DeepSeek 替身模型做验收；
  - 离线开发包提供一键离线准备入口，并附带 `INSTRUCTION.md`。

## 接口约定

以下约定供并行实现使用，实现与本节不一致时以本节为准并先修改本节。

### 模型网关模块

```ts
// src/drivers/chat-completions/gateway.ts
export type InboundProtocol = "openai-completions" | "openai-responses" | "anthropic" | "google";
export interface ModelGatewayOptions {
  upstream: {
    protocol: "openai-completions";
    baseUrl: string; // 公司地址，包含可选 /v1 或路径前缀，网关追加 /chat/completions
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

Worker 把 `ModelCallRecord` 原样作为 `type: "model.call"` 的事件 `data` 上报。控制台和观测页据此展示每次模型调用；比赛轨迹不直接暴露该事件。

### 统一模型的配置与接口

- `settings.json` 和源码配置文件都用顶层 `model: HarnessModel`。发行包中各引擎的 `modelProfile` 仍可读取，但会被统一模型覆盖。
- `harnessModelFile` 的内容是一个 `HarnessModel` JSON 对象（文件权限 0600）。
- HTTP 接口：
  - `GET /v1/harness/model` 返回 `HarnessModelView`。
  - `PUT /v1/harness/model`：body 为 `HarnessModel`，其中 apiKey 只接受秘密引用。写入文件，并为全部引擎重新登记新 revision，返回 `HarnessModelView`。
  - `POST /v1/harness/model/test`：用一条极短的流式请求检查连通性和鉴权，会实际调用模型。返回 `{ ok, status, durationMs, error? }`。
- `hub.cmd model set --model <id> --base-url <url> --api-key-env <NAME> [--context-window N] [--max-output-tokens N]` 写入统一模型文件；`hub.cmd model show` 查看当前配置。

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
- **要求公司网关增加 Responses、Anthropic、Google 协议**：不符合公司现有接口约束。

## 后果

- **收益**：
  - 引擎只拿到本地令牌，不直接持有公司秘密；
  - 所有模型调用都可观测，并能证明只用了统一模型；
  - 兼容处理只写一处。
- **代价**：
  - 网关会重写请求，引擎的模型专用优化（按模型名开启的特性）会失效；
  - 缓存推理内容会占用 Session 内存，上限跟随现有的 8 MiB 请求限制；
  - 转换覆盖不了各厂商的托管工具和多模态，这类请求会明确失败。
- **重新评估**：公司网关提供原生 Responses 或 Anthropic 协议时，可以允许对应引擎直连，但仍需经过同一个观测点。

## 验证要求

- **单元测试**：
  - 覆盖四种入站协议在流式和非流式下的转换；
  - 覆盖宽松解析的各种变体（缺 `index`、重复 `finish_reason`、"stop + 工具调用"、缺 `[DONE]`、usage 缺字段、空参数）；
  - 覆盖推理内容的回填、错误状态码透传、`max_tokens` 截断和参数清理。
- **集成测试**：用正式 Gateway 和 Worker 验证：
  - 统一模型强制生效，旧的 per-engine provider 被覆盖；
  - 模型报错时 Run 失败，并带真实原因；
  - `model.call` 事件被提交；
  - 比赛接口的错误格式、`session.error`、目录自动创建。
- **Windows x64 真实引擎验收**：CI 以流式、推理型的 DeepSeek 作为公司模型替身。验收内容为各引擎的文件任务、Shell 任务和比赛 API 全流程。本机结果与 CI 结果都不能替代公司真实模型的验收。
