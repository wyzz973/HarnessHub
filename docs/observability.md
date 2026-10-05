# 运行观测与覆盖范围

观测由 [ObservationService](../packages/runtime/src/application/observability.ts)读取已提交的 Run、Session、事件、权限和产物生成，不维护第二份运行状态。前端刷新和 Gateway 重启后可从 SQLite 重建同一结果。执行完成和任务达标继续分别记录。

## API 与统计范围

- `GET /v1/runs/:id/observations`：单 Run 的模型、版本、阶段耗时、文本与思考字符数、唯一工具调用数、权限和产物数、token、费用及缺失原因。
- `GET /v1/observability?limit=50`：全量运行状态计数、引擎活动/排队负载与最近运行观测。`limit` 为 1～200，默认 50。

概览的状态计数来自所有持久 Run；耗时分位数、token 已知合计和覆盖率仅针对 `scope.sampledRuns` 指定的最近样本。`known*Tokens` 是样本中已报告值的合计，不能当作全量消耗；没有一个已知值时为 `null`。`usageCoverage` 是样本中同时具有本次 Run 输入与输出 token 的比例，空样本为 `null`。p50/p95 使用已结束样本的 nearest-rank 分位数，不含进行中的估算时长。

事件每次分页读取最多 1,000 条，每个 Run 投影最多 10,000 条，概览最多 200 个 Run。超过范围或事件序号有缺口时 `coverage.eventsComplete=false`，字符数和工具数只反映读取部分。当前 Store 的运行/会话列表仍一次读取全部记录；这是面向本机小规模数据的实现，尚未提供大规模全量 SQL 聚合。

## Token 来源与归属

`engine.usage.data.observation` 是版本 1 的规范化 Driver 证据，必须包含 backendSessionId 和 `${runId}:${generation}`。应用层只接受与当前运行身份一致的观测。

| 来源 | Run 归属依据 | 覆盖 |
|---|---|---|
| ACP | 精确请求 ID，或调用前后新增的 `perRequest` 用户消息 ID | 仅后端实际报告的字段 |
| Pi | Worker 私有 `session-map.json` 的 backend ID / cwd 映射，JSONL header 的同一 ID / cwd，再差分新增 assistant message ID | 输入、输出、cache、reasoning、total；原生估价 |
| OpenCode | Worker 私有 `storage/message/<backendID>` 下的消息，逐条验证 sessionID 与 cwd，再差分新增 message ID | 输入、输出、cache、reasoning、总量；原生估价 |
| DSH | Worker 私有 zstd 会话首 frame 的 ID / cwd，version 4 的 session projection、tokenUsage version 2 的单调 totals 与投影版本 | 输入、输出、cache、总量；缺失 reasoning / 费用保持未知 |

ACP 0.13.2 的 reducer 会把最新 breakdown 直接赋给名称为 `cumulative_token_usage` 的字段，因此不能仅凭该字段名推断可相减或可累加。无请求归属的旧快照只进入 `sessionUsage`，不计入 Run token 合计。DSH 的投影没有推进、原生格式不支持、基线缺失、会话不匹配等情况分别给出缺失原因，不静默计算零消耗。

私有读取器只读取 `stateDir/home` 下确定位置与精确会话关联的文件，不扫描用户原始 HOME、不读取认证文件、不使用 mtime 猜测对应任务。每个文件最多 16 MiB，一次采样最多 32 MiB 和 2,048 条记录；拒绝越界、符号链接、读取时变更、不支持格式。读取失败只产生观测缺口，不改变已获得的执行结果；失败内容不输出原始文件或凭证。

`tokens.input` 包含缓存读写部分；`cacheRead/cacheWrite` 是其中的细分。`tokens.reasoning` 是输出 token 的细分，不再次加到 total。字符数只统计文本字符，不换算或伪装成 token。输入/输出缺失均为 `null`，后端明确报告的零保留 `0`。

## 费用语义

- `reported`：ACP 后端报告的累计成本按会话前后差分归属当前 Run。不是服务商账单对账结果。
- `estimated`：Pi / OpenCode 依据其原生模型价格表算出的金额。保留来源为 `pi-native-price-table` / `opencode-native-price-table`，不当作实付。
- `unknown`：没有金额、币种、可靠差分或价格依据。金额和币种为 `null`，并提供 `missingReason`。

本轮不硬编码模型单价，不用字符数猜 token，也不读取账户账单。DSH 未提供价格时费用未知；实际发票、订阅额度折算及全部引擎的账单消耗不属于已经取得的数据。

## 模型、版本与时序

配置模型 `model.configured` 与后端报告模型 `model.actual` 分开。原生 assistant 消息的模型优先于 ACP 会话状态；没有实际模型时不回填配置别名冒充观测值。Driver/profile revision 来自 Run 固定配置，安装快照来自已登记的 `engine.installation`，含启动文件 hash、大小及可读取的所属包版本；不表示所有间接依赖均已识别。

`queueMs` 从接收到进入 starting，`startupMs` 从 starting 到 Worker running，`timeToFirstOutputMs` 从接收到首个非思考输出，`durationMs` 从接收到终态，`executionMs` 从 Worker running 到终态。时序均按 Gateway 的持久时间计算，不混合未校准后端时钟。未结束运行的总耗时为 `null`。

`cleanupMs` 只读取 Runtime 明确记录的 `runtime.cleanup`，不把最后输出到终态的间隔误当成进程清理耗时。正常保留 ACP Worker 的路径是 `performed:false,durationMs:0`；旧数据没有该事件时为 `null`。取消的等待与 grace 不计成纯 Host 清理耗时。

## 诊断日志

运行观测来自已提交的数据库记录；排查启动、协议和模型问题另有两类诊断日志，取舍见 [ADR 0014](decisions/0014-diagnostic-logs.md)。每行一个 JSON 对象：`time`（UTC）、`level`（`info`/`debug`）、`event`，其余为该事件的字段。

| 文件 | 写入者 | 内容 |
|---|---|---|
| `<dataDir>/logs/gateway.log` | Gateway 进程 | `gateway.start/listen/stop/start_failed`、`model.configured`（统一模型 ID、地址与兼容设置，无密钥）；`http` 访问行（修改类请求、失败请求与 `GET /event`；成功的 GET/HEAD 多为控制台和调用方轮询，只在 debug 级记录）；`session.create`（含 `engineLog` 路径）/`status`/`backend`；`run.accept/status/finish`（结束行含状态、公开错误、`ms` 与排队 `queuedMs`）；`permission.request/decide/applied`；`worker.spawn/ready/exit/fail`（pid、退出码与信号、是否预期）；每个 `model.call` 摘要以及 `engine.error`、`engine.installation`、`runtime.cleanup` |
| `<dataDir>/backends/<sessionId>/diagnostics/engine.log` | 该 Session 的 Worker | `worker.start/stop/stopped/fatal`；`run.start/prepared/finish/error`（`prepared` 为实际引擎命令、MCP 服务名与模型网关地址）；`engine.spawn/exit/stderr`；ACP `acp.request`/`acp.response`（`dir` 为 `to-engine`/`from-engine`，响应含 `ms`、`ok`、错误；initialize 含引擎名称版本与能力，session/new 含当前模型）、`acp.notification`、`acp.turn`（每轮 `session/update` 各类数量与文本/思考字节）、`acp.tool`（工具调用状态变化）、`acp.permission`（`auto-allow`、所选 kind 或 `cancelled`）、`acp.session`；`model.call`（入站路径与协议、请求别名与上游模型、状态、`ms`、`firstByteMs`、结束原因、用量、工具调用数、`reasoning.restored/missing`、`adjusted` 增删参数、脱敏错误） |

`worker-errors.log` 仍在同一 `diagnostics` 目录保存异常栈，`run.error` 行指向它。CLI Driver 的引擎（如 Kimi）同样写 `engine.spawn/exit/stderr`，参数中的提示词以长度代替。

`HARNESSHUB_LOG_LEVEL` 取 `info`（默认）或 `debug`，大小写不敏感，其他值拒绝启动；Gateway 解析后把同一值传给每个 Worker。`debug` 另写 `run.input`、`acp.request.params`、`acp.response.result`、`acp.notification.params`、`acp.update`、`model.payload`（上游请求体与回答）和 CLI 的 `engine.input`/`engine.stdout`，每项最多 2,048 个字符并标注截断长度。这些摘录包含任务提示词和模型回答，只在排查时开启。

所有字符串字段最多 8 KiB；每行写入前按已知密钥值（Session 解析出的密钥、模型网关 token、环境中的统一模型密钥）和 Bearer、`sk-`、`token=`/`api_key:` 等形式脱敏。文件权限 0600，超过 16 MiB 轮转为 `.1`～`.3`。日志写失败不影响执行：Gateway 向 stderr 输出一次 `log.error`，Worker 在当前 Run 发出一次 `diagnostics.log_failed` 事件。`node packages/daemon/dist/src/main.js` 把 info 级生命周期行同时写到 stderr（即启动窗口），stdout 仍只输出 ready 事件；访问和模型调用行只进文件。

运行中不必打开文件：`GET /v1/sessions/{id}/logs` 按页读取一个 Session 的诊断记录。`source=engine`（默认）返回该 Session 的引擎日志；`source=gateway` 返回 Gateway 日志中含该 Session id 或其 Run id 的行，不含读取本接口自身的访问行。不带 `after` 时返回最新 `limit` 条（默认 200，最多 2000，按写入顺序）；带上一页的 `cursor`（文件身份与字节偏移，轮转后仍有效）时只返回之后写入的完整行。单次最多扫描 32 MiB（含 `.1`～`.3`）、返回 2 MiB；`truncated=true` 表示有记录因数量、大小、扫描预算或游标所在文件已轮转出去而被跳过。每行读出时再次脱敏，无法解析的行计入 `skipped`。接口只读文件、不联系 Worker，未知 Session 返回 404。控制台“执行详情”中的“诊断日志”使用该接口，可切换引擎/Gateway 日志、按级别和关键字筛选，任务运行时每 2 秒增量刷新，并能复制或下载当前显示的记录（JSON Lines）。

## CSV 导出

模型网关的账本可以导出为 CSV，供表格或脚本与厂商账单对照（对应 Magpie 的 `magpie usage --csv`）：

| 入口 | 内容 |
|---|---|
| `hh usage --by call --format csv` | 所有匹配调用，每次一行，新到旧；过滤同 `hh usage`（`--since`、`--from`、`--to`、`--provider`、`--model`、`--key`、`--agent`） |
| `hh usage --by model\|provider\|day\|key\|adapter\|credential --format csv` | 汇总表，每桶一行 |
| `GET /api/v1/model-calls?format=csv` | 同第一行；不分页，`limit` 不起作用，带 `cursor` 时 400 |
| `GET /api/v1/usage?format=csv&groupBy=…` | 同第二行 |

不带 `format` 时，`Accept` 把 `text/csv` 排在 `application/json`（或通配）之前也返回 CSV；`format=json` 总是 JSON。响应为 `text/csv; charset=utf-8`，带 `Content-Disposition: attachment; filename="harnesshub-calls-<日期>.csv"`（汇总为 `harnesshub-usage-by-<groupBy>-<日期>.csv`），SDK 为 `client.modelCalls.csv()` 与 `client.usage.csv()`（返回响应体的流）。调用 CSV 按每页 200 条流式写出，第一页在响应头之前读取，过滤无效时仍是 400 的 problem+json。控制台的用量页有“下载调用 CSV”与“下载汇总 CSV”（按所选的时间范围与分组），经 SDK 发出带会话令牌的请求后把响应体存为文件，因为只带 Cookie 的 GET 会得到 401。

写法与 Magpie 的 Go `encoding/csv` 相同：UTF-8，没有 BOM（Magpie 也没有），LF 换行；字段含逗号、引号、CR、LF 或以空白开头时加引号，引号写两次。Magpie 没有、HarnessHub 另加的是公式注入防护：以 `=`、`+`、`-`、`@`、制表符或回车开头的字段前加 `'`，先有空白（包括不换行空格、全角空格等 Unicode 空白）再是这些字符时同样如此，因为电子表格导入时可能去掉开头的空白；纯数字（如 `-5`）除外。

调用 CSV 的列与顺序同 Magpie 的 `CSVHeader`（[usage-csv.ts](../packages/daemon/src/usage-csv.ts)）：

| 列 | 取值 |
|---|---|
| `time` | `occurredAt`，守护进程本地时区的 RFC 3339，精确到秒 |
| `agent`、`requested_model`、`provider`、`served_model` | `agent.id`、`requestedModel`、`provider`、`servedModel` |
| `host` | 该 provider 当前上游端点的主机 |
| `model` | 发往上游的模型名（`wireModel`，否则 Model Ref 的模型部分） |
| `swapped` | 回答的模型不是所发的模型：去掉厂商前缀、日期或版本后缀与上下文标记后仍不同（Magpie 的规则；`auto` 不算） |
| `effort` | 路由组为该调用选定的推理强度（`member-effort:`、`effort:auto:` 补丁）；客户端自己的设置不进账本，为空 |
| `input_tokens`、`output_tokens`、`cache_write_tokens`、`cache_read_tokens`、`reasoning_tokens` | 账本用量；`input` 不含缓存，`output` 不含推理；未回报为 0 |
| `cost_usd` | 六位小数；价格未知时为空 |
| `duration_ms`、`ttft_ms` | 耗时与首内容时间（没有时为空） |
| `status`、`error` | 状态码；状态码不低于 400 或有错误文本时为 `true` |
| `session` | `conversationKey`（按 Key 隔离的会话哈希，不是客户端原始会话 ID） |
| `kind` | 网关为自身发起的调用的用途（`vision`、`classify`） |
| `provider_key_id`、`provider_key_name`、`provider_account` | 凭据 ID、凭据当前名称、订阅账号的邮箱（Copilot 为登录名） |
| `endpoint` | 入站路径；转换协议时加 ` → ` 与上游路径 |
| `error_message`、`error_type` | 账本中已脱敏的错误文本与错误类别 |
| `rejected` | 本地拒绝、未联系上游 |
| `caller_key_id`、`caller_key_name` | Gateway Key ID 与当前名称 |
| `route_id`、`request_id`、`source`、`session_provider`、`session_account` | 空：账本不记录（`source` 在 Magpie 中标记读自 Agent 会话文件的调用，HarnessHub 没有这类调用） |
| `session_official_login` | `false` |

账本只存 ID，所以 `host`、凭据名称与账号、Key 名称取自导出时的配置；之后改过名或删除的，显示当前名称或为空。汇总 CSV 的列为分组键（列名即 `groupBy`）、`calls`、`failed_calls`、五个 token 列（顺序同上）、`cost_usd`（已知成本之和，六位小数）与 `unpriced_calls`。

凭据额度窗口的用量提醒（Magpie 的 `magpie quota alert`）见 [网关功能](gateway-features.md#用量提醒)。

## OTLP 导出

守护进程可以把每次模型调用导出为一个 OpenTelemetry span（[08 第 5 节](proposals/oss/08-reliability-observability.md#5-追踪)），可选另导出 GenAI 指标与每次调用的请求和回答，默认关闭：没有 `otlp` 配置时不创建导出器，也不发出任何网络请求，环境中的 `OTEL_EXPORTER_OTLP_ENDPOINT` 等标准变量同样不会打开导出。实现见 [otlp-export.ts](../packages/daemon/src/otlp-export.ts)。

开启方式是在配置文件 `config.jsonc` 中写 `otlp` 配置块（[配置](configuration.md#设置)），或把它写成 JSON 文件，以 `hh serve --otlp-config <文件>`（或 `node packages/daemon/dist/src/main.js --otlp-config <文件>`）启动，文件整体代替配置文件中的值；配置无效时拒绝启动。

| 字段 | 说明 |
|---|---|
| `endpoint` | 收集端基础地址（http 或 https，不含凭据、查询与片段）；span 发往 `<endpoint>/v1/traces`，指标发往 `<endpoint>/v1/metrics`。写成以 `/v1/traces` 或 `/v1/metrics` 结尾的地址时去掉这一段作为基础地址（同 Magpie） |
| `protocol` | 只支持 `http/json`（默认）。`http/protobuf` 需要 protobuf 编码依赖，目前明确拒绝；常见收集端都接受 JSON |
| `headers` | 可选，请求头；值为字符串或秘密引用 `{"kind": "env"\|"file"\|"keychain"\|"store", "value": ...}`，启动时解析一次，只用于请求头 |
| `resource` | 可选，资源属性（字符串、数字或布尔），覆盖默认的 `service.name`（`harnesshub`）与 `service.version` |
| `metrics` | 可选，`true` 时另把 GenAI 指标发往 `<endpoint>/v1/metrics`；默认 `false`（同 Magpie） |
| `bodies` | 可选，`true` 时把每次调用的请求与回答放进 span（Langfuse 的 `langfuse.observation.input`/`output`）；默认 `false`（同 Magpie）。**打开后提示词、代码与回答会离开本机**，见下文 |

span 在 `model.call` 账本记录提交之后才进入导出队列，账本仍是唯一事实来源；账本写失败的调用不导出。每个调用一个 SERVER span，名称为 `chat <请求模型>`（Gemini 入口为 `generate_content`），时间取账本的开始时间与耗时，失败时状态为 ERROR、消息为错误类别。属性按 GenAI 语义约定：`gen_ai.operation.name`、`gen_ai.provider.name`（预设映射到约定值，如 `openai`、`anthropic`、`gcp.gemini`、`mistral_ai`、`x_ai`；其他预设用预设 ID，自定义 provider 用其 ID）、`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.conversation.id`（Session ID）、`gen_ai.response.finish_reasons`、`gen_ai.usage.input_tokens`（含缓存读写）与 `gen_ai.usage.output_tokens`（含推理），以及 `http.response.status_code`、`error.type`。HarnessHub 自有字段用 `hh.` 前缀：调用、Model Ref、provider、路由组、入站与上游协议、是否流式、`hh.mode`（passthrough 或 translated）、Key ID 与作用域种类（agent 作用域另有 Adapter ID）、Session、Run 与 generation、缓存读写与推理 token、用量来源、费用（美元金额与价格来源，未知时 `hh.cost.source=unknown`）、首字节与首内容时间、尝试次数、错误来源、拒绝原因。上游未回报用量时不写 token 属性，不写 0。

不开 `bodies` 时从不导出：提示词、回答、推理内容、工具参数与结果、账本中的错误文本、凭据与请求头的值、Gateway Key 文本与 Key 名称（名称可能含邮箱），以及 provider 凭据 ID。账本中的错误文本、凭据、请求头的值、Key 名称与凭据 ID 在任何设置下都不导出。

**指标（`metrics`）**：与 Magpie 导出的相同，两个 GenAI 客户端直方图，聚合方式为 delta（`aggregationTemporality` 1），每个请求覆盖上一个指标请求之后的时间：

| 指标 | 单位 | 值与桶边界 |
|---|---|---|
| `gen_ai.client.operation.duration` | `s` | 每次调用的耗时（含被拒绝的调用）；边界 0.01、0.02、0.04 … 81.92（逐级翻倍） |
| `gen_ai.client.token.usage` | `{token}` | 每次调用两个点，`gen_ai.token.type` 为 `input`（含缓存读写）与 `output`（含推理）；上游未回报用量时不记，不记 0；边界 1、4、16 … 1,048,576（逐级乘 4） |

数据点的属性只有 Magpie 的白名单对应项：`gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`（有时）、`hh.agent`（Agent ID，有时；Magpie 为 `magpie.agent`）与 `error.type`（失败时，同 span），不含调用、Key、会话或 Run 的 ID，序列数量有限。指标与 span 走同一队列、同一批次与刷新、同一重试：每批先发 span，再把这一批的调用汇总成一个指标请求。

**请求与回答（`bodies`）**：打开后，每个 span 多两个属性：`langfuse.observation.input` 为客户端发来的请求（JSON 重新序列化），`langfuse.observation.output` 为回答，流式回答取各事件中的文字拼成一段（Chat 的 `delta.content`、Responses 的 `response.output_text.delta`、Anthropic 的 `content_block_delta`、Gemini 的 `parts[].text`，不含思考；只有工具调用时按原样），非流式回答按原样。两者在网关中先经出站脱敏的同一套规则遮蔽（已知的 provider 凭据与订阅令牌、Gateway Key、管理令牌和用户自己的规则，换成 `{{HH_…}}` 占位符），**即使出站脱敏被关闭也会遮蔽**，再各截到 256 KiB 并以 `… (cut here by HarnessHub)` 标记（同 Magpie）。回答在响应结束后才交给导出器，因此是完整的。图像端点、本地拒绝（没有读到可路由的请求）的调用不带内容。导出器的队列最多保存 128 MiB 的内容，超过时该 span 不带内容导出并计入 `bodiesDropped`；一个请求中的内容最多 16 MiB，超过时拆成多个请求（同 Magpie）。

> **警告**：`bodies` 会把提示词、源代码、文件内容与模型回答发给收集端，离开本机。遮蔽只覆盖 HarnessHub 知道的秘密与你的规则，不能识别其他敏感内容；只把它指向你信任、能控制保留期限的后端（如自己部署的 Langfuse）。默认关闭。

导出不阻塞也不影响模型调用：队列上限 2,048 个 span，每批 512 个，每 5 秒刷新；单次请求 10 秒超时；429、502、503、504、超时与网络错误按 `Retry-After`（或 1 s、2 s）重试至多 2 次，间隔上限 60 s；其他状态不重试。队列满或已停止时丢弃并计数（丢弃的调用也不进入指标），`gateway.log` 中有 `otlp.dropped`、`otlp.export_failed`（带 `signal` 为 `traces` 或 `metrics`）记录，停止时 `otlp.stop` 给出导出、丢弃、失败、重试、指标导出与失败、未带内容的累计数。守护进程停止时，在模型网关等完最后一批账本记录（以及等待响应结束的内容）之后导出剩余队列，最多等 3 秒，到期后中止并把剩余部分计为丢弃。

与 [08 第 5 节](proposals/oss/08-reliability-observability.md#5-追踪) 的设计相比，目前的差异是：配置块名为 `otlp`，写在配置文件中或经 `--otlp-config` 文件传入（设计中是配置文件的 `observability.otel.*`）；编码为 JSON 而不是 protobuf，以免为 protobuf 引入依赖；span 都是根 span（还没有 Run 与 attempt 的 span 可作父子）；内容导出开关按 Magpie 叫 `bodies`、属性是 Langfuse 的（设计中为 `captureContent` 与 GenAI 的消息属性）；尚无约定版本选择与采样。与 Magpie 相比：没有 `MAGPIE_OTEL_*` 这类环境变量覆盖；没有 `bodiesWhole`（不截断的内容）；`metrics` 在 Magpie 中按刷新周期汇总，这里按批次汇总（同一周期内批次不满 512 时相同）。

示例（JSON 文件内容，未在真实后端上验证）：

```json
{ "endpoint": "http://127.0.0.1:4318" }
```

本机 Jaeger 或 Grafana Alloy、OpenTelemetry Collector 在 4318 端口接收 OTLP/HTTP 时使用上面的配置。Honeycomb：

```json
{
  "endpoint": "https://api.honeycomb.io",
  "headers": { "x-honeycomb-team": { "kind": "env", "value": "HONEYCOMB_API_KEY" } },
  "resource": { "deployment.environment": "laptop" }
}
```

Grafana Cloud 的 OTLP 入口（`<region>` 与凭据见 Grafana Cloud 的 OTLP 连接页面；`GRAFANA_OTLP_AUTH` 的值为 `Basic <base64(实例 ID:令牌)>`），同时导出指标：

```json
{
  "endpoint": "https://otlp-gateway-prod-<region>.grafana.net/otlp",
  "headers": { "Authorization": { "kind": "env", "value": "GRAFANA_OTLP_AUTH" } },
  "metrics": true
}
```

自己部署的 Langfuse（OTLP 入口为 `/api/public/otel`；`LANGFUSE_OTLP_AUTH` 的值为 `Basic <base64(公钥:私钥)>`），带请求与回答。Langfuse 只接收 trace，不要同时打开 `metrics`：

```json
{
  "endpoint": "https://langfuse.example.internal/api/public/otel",
  "headers": { "Authorization": { "kind": "env", "value": "LANGFUSE_OTLP_AUTH" } },
  "bodies": true
}
```

## 验证

[单元测试](../tests/unit/observability.test.ts)覆盖 ACP 请求归属、累计快照不重复计量、Pi 消息差分、会话不匹配/链接拒绝、字符/工具去重、时间和缺失值。[HTTP 集成测试](../tests/integration/observability.test.ts)通过正式 Gateway、Worker、ACP 本地确定协议端和 SQLite 验证两次运行各自 usage、OpenAPI、范围限制、重启重建一致。

读取接口由 [读取器单元测试](../packages/daemon/test/session-log-reader.test.ts)（尾部、游标、未写完的行、轮转后续读、游标失效、Gateway 过滤、再次脱敏、限额与预算）和 [接口集成测试](../tests/integration/session-logs.test.ts)（两个 Session 经正式 Gateway/Worker 与 ACP fixture 运行后分页读取、非法参数 400、未知 Session 404、不含上游密钥与 Session token）验证；控制台契约见 [控制台契约测试](../tools/check-console-contracts.test.mjs)。

诊断日志由 [日志单元测试](../packages/daemon/test/diagnostic-log.test.ts)与 [集成测试](../tests/integration/diagnostic-logs.test.ts) 验证：后者经正式 Gateway/Worker、ACP fixture 和本地上游，以 info 与 debug 各运行一次含工具调用、权限和 stderr 的任务，检查两份日志的必备记录、推理回填计数与 debug 摘录，并确认上游模型密钥与 Session token 都未写入。

OTLP 导出由 [导出器单元测试](../packages/daemon/test/otlp-export.test.ts)（配置校验与拒绝样例、属性逐项相等、未回报用量不写 0、队列满时丢弃而 `record` 不等待、收集端不应答时停止仍守期限、重试与不重试的状态、停止时导出队列；指标的名称、单位、边界、落在边界上的值、按属性分点与排序、没有用量时无 token 点、默认关闭、指标请求的重试与失败计数、相邻请求的时间窗首尾相接；内容只在配置打开时附上、队列内容上限与单个请求的拆分）、[网关测试](../packages/gateway/test/shared-gateway-bodies.test.ts)（不要内容时提交后立即交出；要内容时在响应结束后交出，请求与回答都经遮蔽，出站脱敏关闭时也遮蔽，跨两个事件的秘密也被遮蔽，非流式回答原样，256 KiB 截断与标记，账本写失败时不交出；四种协议的流式文字拼接）和 [集成测试](../tests/integration/otlp-export.test.ts)（经正式守护进程、共享网关与假 provider 完成普通、流式工具与被拒绝三次调用，停止守护进程后回环收集端收到三个 span，属性与账本记录逐项一致，载荷中没有提示词、工具参数、推理文本、上游 Key、Gateway Key 文本与名称和请求头秘密；打开 `metrics` 与 `bodies` 后收集端另收到指标，耗时计数与 token 合计同账本，span 带请求与回答而 Gateway Key 被换成占位符；没有 `otlp` 配置时即使设置了 `OTEL_EXPORTER_OTLP_ENDPOINT` 也没有任何导出请求；`http/protobuf` 配置拒绝启动）验证。未验证：真实的 Jaeger、Grafana、Honeycomb 与 Langfuse 后端。

CSV 导出由 [写法单元测试](../packages/daemon/test/usage-csv.test.ts)（加引号的规则、公式前缀与纯数字、时间格式、换了模型的判断）与 [集成测试](../tests/integration/usage-csv.test.ts)（经正式守护进程写入 208 条调用后，以独立的 RFC 4180 解析器读回 API、SDK 与 `hh` 的输出：表头与 Magpie 逐列相同、无 BOM、新到旧跨页、每列取值、公式前缀、引号与换行、`Accept` 协商、带 `cursor` 与无效过滤时 400、汇总 CSV 与 JSON 一致、`hh` 的用法错误）验证；去掉公式防护时集成测试失败。

真实模型的最新验收以对应 `docs/verification/` 记录为准；读取历史原生文件能确认格式和已有用量，不等于新 Driver 已完成真实模型调用。Windows 原生采集仍需单独验证。
