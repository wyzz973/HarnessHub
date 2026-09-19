# 比赛接口（Agent 网关规范 v1.1）

本页说明 `--competition` 模式下的 HTTP 接口如何实现评测方《Agent 网关接口规范 v1.1》。取舍依据见 [ADR 0013 第 3 节](decisions/0013-unified-model-gateway.md)；实现位于 [路由](../src/gateway/competition/routes.ts)、[事件流](../src/gateway/competition/events.ts) 与 [轨迹投影](../src/gateway/competition/transcript.ts)，JSON 解析规则位于 [Gateway](../src/gateway/server.ts)。这些路由只投影 HarnessHub 的 Session/Run/Event，不改变 `/v1` 原生接口与 Driver 接口。

状态：已用 demo `fake` 引擎在 macOS 上经编译后的 Gateway 与 Worker 验证（见 [验证](#验证)）；真实引擎、Windows 与评测方客户端均未验证。

## 启动

先按 [README](../README.md) 安装依赖并执行 `pnpm build`，再从仓库根目录启动：

```sh
node dist/src/main.js --competition --engine opencode --port 6217
```

stdout 输出一行 `{"event":"ready","url":...}` 即为就绪。`--engine`（或环境变量 `AGENT_ENGINE`）必填，比赛模式下每个 `POST /session` 都固定使用该引擎；默认监听 `localhost:6217`，`localhost` 同时可用 `127.0.0.1` 与 `[::1]` 访问。默认只接受本机回环地址的 `Host`；评测客户端在另一台机器或容器中时，用 `--host 0.0.0.0`（或具体网卡地址）启动，此时接受任意 `Host`。注意这种绑定没有鉴权，同一网络中的任何人都能驱动开着 Full Access 的引擎，只应在隔离的评测网络中使用；浏览器跨源请求仍被拒绝。Windows 完整包使用 `gateway.cmd --engine <id>`，见 [Capability Pack](capability-packs.md#competition-full-bundle)。本机试用可加 `--demo --engine fake`，它不调用模型。

## 接口映射

| 规范 | 请求 | 实现 |
|---|---|---|
| 3.1 | `POST /session` | `directory` 必填（相对路径按 Gateway 进程当前目录解析），不存在时递归创建后建立 Session；`title` 可选（空串或 `null` 视为未提供，自动生成）。返回 `id/title/created_at/status:"idle"`，另附实际目录 `directory` |
| 3.2 | `GET /session/{id}` | 同上并附 `message_count`，其值等于 `/message` 返回的条数；`status` 按是否存在未结束 Run 给出 `busy/idle` |
| 3.3 | `DELETE /session/{id}` | 关闭 Session：取消排队与运行中的 Run、回收 Worker，返回 `{"ok":true}`；重复删除仍返回 `{"ok":true}`。历史保留，之后仍可查询，但不能再提交 |
| 3.4 | `GET /session/status` | 所有 Session（含已关闭的）映射为 `{"type":"busy"|"idle"}` |
| 4.1 | `POST /session/{id}/prompt_async` | 校验后提交一个 Run 并阻塞到 Run 结束：`completed`、`cancelled` 返回 204；`failed`、`timed_out`、`interrupted` 返回 502 `BAD_GATEWAY`，`message` 为 Run 的真实错误。等待期间自动批准权限；客户端断开不会取消 Run |
| 4.2 | `GET /session/{id}/message` | 见 [消息轨迹](#消息轨迹) |
| 4.3 | `POST /session/{id}/abort`、`/stop` | 取消该 Session 所有未结束 Run，返回 `{"ok":true}`；阻塞中的 `prompt_async` 随后返回 204 |
| 5.1/5.2 | `GET /question`、`POST /question/{id}/reply` | 引擎不经 HarnessHub 反问，列表恒为 `[]`；回复先校验 `answers`（字符串数组的数组），再返回 404 |
| 5.3/5.4 | `GET /permission`、`POST /permission/{id}/reply` | 列出未结束 Run 的待决权限；`once`、`always` 都按单次允许提交，`reject` 按单次拒绝。未知或已不待决的 id 返回 404 |
| 6 | `GET /event` | 见 [SSE 事件](#sse-事件) |

所有带 `Content-Type: application/json` 但没有请求体的请求（包括 `/v1` 路由）按无请求体处理；非空但不是合法 JSON 的请求体仍被拒绝。

`prompt_async` 提交的每一轮期限为 60 分钟（普通 `/v1` 入口的默认期限仍为 60 秒），与 INSTRUCTION.md 建议的客户端超时一致；超过期限的 Run 以 `RUN_TIMED_OUT` 结束并返回 502。

`prompt_async` 的 `parts` 至少一项且只接受 `type:"text"`，多项文本以换行连接，总长不超过 1,048,576 个字符；`model` 必须是含字符串 `providerID`、`modelID` 的对象（可为空串），`agent` 可选。实际执行一律使用 HarnessHub 统一模型（ADR 0013），这两个字段目前只做校验，尚未写入 Run 记录。

## 错误

比赛路由的所有错误响应体都只有 `code` 与 `message`，状态码与规范第 7 节一致：

| 来源 | 状态 | `code` |
|---|---|---|
| 请求体不是 JSON 对象、字段缺失或类型错误、非法 JSON、不支持的 Content-Type、请求体过大 | 400 | `VALIDATION_ERROR` |
| 目录无法创建（`message` 含路径与原因，如 `ENOTDIR`、`EACCES`） | 400 | `VALIDATION_ERROR` |
| 向已关闭 Session 提交、权限决定冲突等其他 4xx 业务错误 | 400 | `VALIDATION_ERROR` |
| 未知 Session（`Session not found`）、未知问题或权限 | 404 | `NOT_FOUND` |
| Run 失败、超时或中断 | 502 | `BAD_GATEWAY` |
| 队列已满、Runtime 正在停止、启动引擎不可用 | 503 | `SERVICE_UNAVAILABLE` |
| 其他未预期错误（不透出内部细节） | 500 | `INTERNAL_ERROR` |

## 完成判定

一轮在以下任一事件出现时结束：`prompt_async` 返回、SSE `session.status` 为 `idle`、`session.idle` 或 `session.error`。之后 `GET /session/{id}/message` 的最后一条消息总是 `assistant`，且 `parts` 含 `step-finish`，`info.finish` 取值如下：

| Run 终态 | `info.finish` | 其他 |
|---|---|---|
| `completed` | `stop` | — |
| `failed`、`timed_out`、`interrupted` | `error` | `info.error` 为 `{code,message}` |
| `cancelled` | `cancelled` | — |
| 未结束 | `tool-calls`（当前步骤有工具调用）或 `running` | 最后一步不含 `step-finish` |

`completed` 只表示执行正常结束，任务是否达标仍由评测方判断。

## 消息轨迹

每个 Run 依次输出：一条 `user` 消息（`content` 为提交文本）；每个推断出的 LLM 步骤一条 `assistant` 消息，其后紧跟该步骤已有结果的 `tool` 消息。步骤按事件顺序切分：工具调用之后再出现的正文或推理输出开始下一步，因此中间步骤的 `info.finish` 为 `tool-calls`。

- `assistant`：`content` 为该步骤正文，同一步骤内不同消息的正文以空行分隔；推理（thought）不输出。`tool_calls` 为 `[{id,name,arguments}]`，`arguments` 恒为对象（非对象输入包装为 `{"input":...}`）。`parts` 依次为 `text`、`tool`、`step-finish`。
- `tool` part：`tool` 为工具名，`state.status` 为 `running`、`completed` 或 `error`，取自最近一次报告的真实状态；`state.title` 为最近的工具标题。
- `tool` 消息：`tool_call_id`、`tool_name` 与 `content`。`content` 优先取 ACP `content` 中的文本，其次取 `rawOutput`；超过 8000 个 Unicode 字符时截断并追加 `…[truncated N characters]`。
- Run 结束时若最后一步停在工具调用上，追加一条空内容的结束 `assistant` 消息承载终态，保证最后一条消息是 `assistant`。

消息与 part 的 `id` 在 SSE 与 `/message` 之间一致：`<runId>:user`、`<runId>:assistant:<n>`、`<runId>:tool:<toolCallId>`。一个含两个工具的 Run 形如（节选）：

```json
[
  {"id": "R:user", "role": "user", "content": "请自动打开 Outlook 邮件客户端"},
  {"id": "R:assistant:1", "role": "assistant", "content": "我先查看工作目录。",
   "tool_calls": [{"id": "call_1", "name": "bash", "arguments": {"command": "ls"}}],
   "info": {"role": "assistant", "finish": "tool-calls"},
   "parts": [{"type": "text", "content": "我先查看工作目录。"},
             {"type": "tool", "callID": "call_1", "tool": "bash", "state": {"status": "completed", "title": "List workspace files"}},
             {"type": "step-finish"}]},
  {"id": "R:tool:call_1", "role": "tool", "tool_call_id": "call_1", "tool_name": "bash", "content": "README.md\n"},
  {"id": "R:assistant:2", "role": "assistant", "content": "已打开 Outlook。", "tool_calls": [],
   "info": {"role": "assistant", "finish": "stop"},
   "parts": [{"type": "text", "content": "已打开 Outlook。"}, {"type": "step-finish"}]}
]
```

## SSE 事件

`GET /event` 返回 `text/event-stream; charset=utf-8`，每帧为 `data: {"type":...,"properties":{...}}`：

- 连接后先发 `server.connected`，之后每 15 秒发 `server.heartbeat`。
- 事件只由已提交的 Run 事件驱动。每个 Run 先发 `session.status busy`，再发 `message.part.updated`（text 为该 part 的完整当前内容，tool 为当前状态，`step-finish` 在该步骤结束时发送）。Run 结束时，`failed`、`timed_out`、`interrupted` 先发 `session.error`（`error.message` 与 `error.data.code`、`error.data.runId`），随后若该 Run 结束时 Session 没有其他未结束 Run，发 `session.status idle` 与 `session.idle`。是否空闲按 Run 结束的时刻判断，而不是按事件被读取的时刻：即使 Run 在两次轮询之间开始并结束，或客户端在 `prompt_async` 返回后立即提交下一轮，每轮也都按 `busy`→`idle`→`session.idle` 的顺序输出。
- 连接时不回放历史：正在运行的 Run 从当前位置继续，其 Session 先收到一次 `busy`；之后接收的 Run 从第一条事件开始推送。取消不产生 `session.error`。
- 同一 Session 内上一个 Run 结束前已接收（排队）下一个 Run 时，两者之间不发 `idle`，避免在 Session 实际忙碌时发出空闲信号。
- 只轮询未结束或尚未推送完的 Run；经 `prompt_async` 提交的 Run 立即被跟踪，其他入口提交的 Run 最迟约 1 秒后被发现。Gateway 关闭时会结束所有事件流。

## 评测数据映射

评测数据 `{"task_id":"office_002","query":"请自动打开 Outlook 邮件客户端",...}` 按下列方式调用：

1. `POST /session`，`title` 可取 `task_id`，`directory` 取评测方为该任务指定的目录（不存在时自动创建）。
2. 连接 `GET /event`，在后台线程调用 `POST /session/{id}/prompt_async`，`parts` 为 `[{"type":"text","text":<query 原文>}]`，`model` 可填任意 `providerID/modelID`。
3. 按 [完成判定](#完成判定) 等待，读取 `GET /session/{id}/message` 作为轨迹，最后 `DELETE /session/{id}`。

## 示例

以下 curl 请求已在 macOS 上对 `--demo --engine fake`（随机端口、临时目录）实际执行；`SESSION_ID` 替换为创建返回的 `id`。

```sh
curl -s -X POST http://127.0.0.1:6217/session -H "Content-Type: application/json" \
  -d '{"title":"office_002","directory":"/tmp/eval/office_002"}'
# 在另一个终端持续查看事件流
curl -sN http://127.0.0.1:6217/event
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:6217/session/SESSION_ID/prompt_async \
  -H "Content-Type: application/json" \
  -d '{"parts":[{"type":"text","text":"请自动打开 Outlook 邮件客户端"}],"model":{"providerID":"provider_xxx","modelID":"gpt-4"},"agent":"assistant"}'
curl -s http://127.0.0.1:6217/session/SESSION_ID/message
curl -s -X DELETE -H "Content-Type: application/json" http://127.0.0.1:6217/session/SESSION_ID
```

成功判据：创建返回 200 与 `"status":"idle"`；事件流先出现 `server.connected`；`prompt_async` 输出 `204`；消息列表最后一项为 `"finish":"stop"` 的 `assistant`；删除返回 `{"ok":true}`。

PowerShell 示例（Windows PowerShell 5.1 与 PowerShell 7 写法；本页验证时未在 Windows 上执行）。中文请求体按 UTF-8 字节发送，`prompt_async` 用 `Invoke-WebRequest` 读取 204：

```powershell
$base = "http://localhost:6217"
$type = "application/json; charset=utf-8"
$create = @{ title = "office_002"; directory = "D:\eval\office_002" } | ConvertTo-Json
$session = Invoke-RestMethod -Method Post -Uri "$base/session" -ContentType $type -Body ([Text.Encoding]::UTF8.GetBytes($create))
$prompt = @{ parts = @(@{ type = "text"; text = "请自动打开 Outlook 邮件客户端" }); model = @{ providerID = "provider_xxx"; modelID = "gpt-4" }; agent = "assistant" } | ConvertTo-Json -Depth 5
(Invoke-WebRequest -UseBasicParsing -TimeoutSec 3600 -Method Post -Uri "$base/session/$($session.id)/prompt_async" -ContentType $type -Body ([Text.Encoding]::UTF8.GetBytes($prompt))).StatusCode
(Invoke-RestMethod -Uri "$base/session/$($session.id)/message")[-1].info
Invoke-RestMethod -Method Delete -Uri "$base/session/$($session.id)"
curl.exe -N "$base/event"
```

`Invoke-WebRequest` 与 `Invoke-RestMethod` 遇到 400/404/502 会抛出异常，响应体仍是 `{code,message}`。

## 测试夹具

`fake` 引擎在没有 `fixture` 时识别文本开头的 `[fake:<场景>]`，其余文本作为提示词，供只能传文本的比赛接口测试使用：`[fake:fail] 原因` 以该原因失败；`[fake:tools]` 产生三个步骤、成功与失败的工具调用及一个 9000 字符的工具输出；`[fake:tool-only]` 在工具调用后直接结束；`wait`、`permission`、`artifact`、`crash`、`echo` 与 `fixture` 同名场景一致；未知场景以 `FAKE_DIRECTIVE_INVALID` 失败。普通文本仍原样回显。说明见 [fake 引擎](../src/drivers/fake/driver.ts)。

## 已知限制

- `model`、`agent` 只校验不记录；写入 Run 路由记录需要服务层提交接口支持（ADR 0013 第 3 节）。
- 没有反问能力，`question.asked` 与 `permission.asked` 事件不会发出；权限在 `prompt_async` 等待期间自动批准，经其他入口提交的 Run 需通过 `/permission` 决定。
- 工具名来自引擎报告的首个非占位标题（ACP 不单独提供工具名），缺失时依次用 `kind` 与 `tool`；步骤边界按事件顺序推断，引擎未报告最终状态的工具保持 `running`，也不产生 `tool` 消息。
- `DELETE` 是关闭而不是删除数据；ACP 引擎的 Run 失败、取消或超时后 Runtime 也会关闭该 Session，之后提交返回 400，需要新建 Session。
- 默认只接受回环 `Host`；显式 `--host` 为非回环地址时接受任意 `Host`，没有鉴权（见上文）。
- Gateway 关闭过程中新到达的请求由 Fastify 直接返回 503，响应体不是 `{code,message}`。
- SSE 不支持断线续传；重连只接收新事件，已结束 Run 的结果从 `/message` 读取。

## 验证

- [集成测试](../tests/integration/competition-gateway.test.ts) 从编译后的 Gateway 与 Worker 验证：目录自动创建、阻塞 204、stop/abort 取消后 204、失败 502 与 `session.error` 顺序、连续快速 Run 的 busy→idle、工具 part 状态、`tool_calls` 与 `tool` 消息、截断、`message_count`、权限自动批准、客户端断开不取消、未知会话 404、带 JSON 头的空请求体、`/v1` 错误格式不变，以及关闭 Gateway 时事件流结束。
- [单元测试](../tests/unit/competition-transcript.test.ts) 覆盖部分 ACP 更新合并、占位标题、非对象输入、按消息分段、运行中渲染、无流式正文时的输出回退、中断默认错误与 UTF-8 代理对截断。
- 以上均为 fake 引擎证据，不代表真实引擎或 Windows 通过。
