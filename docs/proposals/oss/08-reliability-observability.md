# 08 可靠性与可观测性

状态：提案（草案），2026-10-02。术语、进程与部署形态以 [02 系统架构](02-architecture.md) 为准，顶层性能与可靠性目标来自 [01 成功指标](01-product.md#7-成功指标)，重试与故障转移规则以 [ADR-P05](adr-drafts.md#adr-p05-路由重试与故障转移) 为准。数据目录、迁移备份与秘密见 [07 数据与安全](07-data-security.md)。文中的命令名、API 路径与配置键表示所需的能力，最终命名以 [06 接口与交互面](06-interfaces.md) 为准。

依据：现有实现（[运行观测与诊断日志](../../observability.md)、[ADR 0014](../../decisions/0014-diagnostic-logs.md)、[ADR 0007](../../decisions/0007-windows-process-supervision.md)、[`json-log-file.ts`](../../../src/logging/json-log-file.ts)、[`diagnostics.ts`](../../../src/worker/diagnostics.ts)、[`sqlite-store.ts`](../../../packages/store/src/storage/sqlite-store.ts)）；`yetone/magpie@d874adb` 的 `internal/redact` 与 README 中的 OTLP 导出说明；2026-10-02 的对比核验（调研材料，未入库，以问题编号引用）；[OpenTelemetry GenAI 语义约定](https://github.com/open-telemetry/semantic-conventions-genai)（Development 状态）。

## 1. SLI 与 SLO

项目不运营托管服务，下面的 SLO 是“软件在参考环境中必须达到”的验收目标，由第 2 节基准与第 10 节故障注入在发布前测量。本机守护进程的 SLI 也可以由用户在本地查看（`hh status --slo` 读取本机指标），这些数据不会外发。

本机守护进程：

| SLI | 定义 | SLO | 测量 |
|---|---|---|---|
| 网关本地成功率 | 格式正确且 Key 有效的模型请求中，没有因 HarnessHub 自身原因失败的比例。自身原因指 `hh.error.origin=local` 的 5xx、证据提交失败、守护进程崩溃 | ≥ 99.95%，按每次夜间负载与故障注入运行计算 | `hh.gateway.requests` |
| 证据完整率 | 客户端收到完整响应的调用中，已提交 `model.call` 的比例 | 100%（01） | 一致性测试与故障注入；`hh.evidence.missing` 恒为 0 |
| 附加延迟 | 非流式 p99；流式首字节 p99 | ≤ 10 ms；≤ 15 ms（01） | 第 2 节 |
| Run 终态 | 已接收的 Run 在 deadline 加清理宽限再加 60 s 内进入终态；守护进程崩溃时，重启恢复后为 `interrupted` | 100% | 故障注入 |
| 事件投递 | 事件提交到推送给在线 SSE 订阅者的时间 | p99 ≤ 50 ms | 集成测试 |
| 崩溃恢复 | `kill -9` 后重新启动到 `/readyz` 返回 200，数据库不超过 1 GiB | ≤ 3 s | 故障注入 |
| 资源 | 冷启动到就绪；空闲常驻内存 | ≤ 1.5 s；≤ 150 MB（01） | 三平台基准 |

团队服务器（1.x，单个活动实例，见 07 第 2.1 节）：

| SLI | 定义 | SLO |
|---|---|---|
| API 可用性 | 管理与执行 API 中非 5xx 且在 5 s 内完成的请求比例 | ≥ 99.5% / 30 天，即每月约 3.6 小时错误预算，升级停机计入 |
| 网关本地成功率 | 同本机定义 | ≥ 99.9% / 30 天 |
| 附加延迟 | 200 RPS 下非流式 p99 | ≤ 25 ms（证据经网络提交到 PostgreSQL） |
| 证据与审计完整率 | 完成的调用都有 `model.call`；成功的管理变更都有审计记录 | 100% |
| 登录成功率 | 排除 IdP 自身故障后 OIDC 回调的成功比例 | ≥ 99.5% |

团队服务器的 SLO 以 Prometheus 规则随发布提供（第 9 节）。恢复点与恢复时间取决于运维的 PostgreSQL 备份策略，文档给出参考做法，不由 HarnessHub 承诺。

## 2. 性能预算与基准

顶层预算来自 01，下表把它拆开，使回归可以定位到具体环节：

| 预算 | 目标 | 说明 |
|---|---|---|
| 非流式附加延迟 p99 | ≤ 10 ms | 01 |
| 流式首字节附加延迟 p99 | ≤ 15 ms | 01 |
| 其中：Key 校验与鉴权 | p99 ≤ 0.2 ms | 摘要比较加内存缓存 |
| 其中：路由决策 | p99 ≤ 0.5 ms | |
| 其中：IR 转换（100 KiB 请求体） | p99 ≤ 2 ms | |
| 其中：证据提交（组提交） | p99 ≤ 3 ms | 位于响应结束前，原因见第 3 节 |
| 流式逐块转发开销 | p99 ≤ 0.5 ms/块 | |
| 插件 IPC 往返（≤ 64 KiB 消息） | p99 ≤ 1 ms | 09 第 8 节 |
| 并发 | 200 条并发流式请求时以上预算仍成立；每条活动流缓冲 ≤ 256 KiB；总常驻内存 ≤ 400 MB | |
| 空闲常驻内存 | ≤ 150 MB | 0 个 Session，已加载 12 个 Adapter 与模型目录，就绪后 60 s 测量 |
| 冷启动到就绪 | ≤ 1.5 s | 数据库含 1 万个 Run 与 10 万条 `model.call` |
| Worker 启动到就绪 | ≤ 1 s | 不含 Agent 自身的启动 |
| 单条 `model.call` 存储 | ≤ 2 KiB | 不采集载荷时 |
| 单可执行文件体积 | 90–110 MB | 超过 150 MB 触发 [ADR-P01](adr-drafts.md#adr-p01-语言与运行时) 重新评估 |

基准方法：

- 假上游是独立进程，行为由脚本固定：流式首字节 50 ms，之后每 10 ms 一块共 20 块；非流式 100 ms。它在响应头中回报自身处理时间。
- 附加延迟 = 客户端经 HarnessHub 观测到的值 − 假上游回报的处理时间 − 客户端直连假上游时同一百分位的基线。
- 负载为开环固定速率 10、50、200 RPS，四种入口协议轮流；每轮预热 10 s、测量 60 s，重复 5 次，取各次 p99 的中位数。
- 回归趋势在 GitHub 托管的三平台 runner 上每晚运行，比 main 基线变差超过 10% 即失败；发布门槛在规格固定的参考机上按绝对预算判定，规格写入结果文件。
- 结果以 JSON 作为发布附件；按 01 的规则，未测量的项不写进发布说明。基准工具的目录与夜间任务见 [10 第 4 节](10-engineering.md#4-ci-与质量门禁)。

## 3. 失败域与降级

每个失败域有确定的影响范围。降级必须显式：返回明确的错误码、反映在健康状态中、留下证据，不静默改用其他模型或跳过记账。

| 失败域 | 检测 | 行为 | 证据与恢复 |
|---|---|---|---|
| 单个 provider 故障 | 连接失败与可重试状态码；按 provider 熔断：30 s 窗口内至少 5 次失败且失败率 ≥ 50% 即打开 | 只在首字节前按 ADR-P05 转移到路由组下一成员；熔断期间跳过该 provider，30 s 后半开放行 1 个请求 | 每次尝试写入 `model.call`；状态变化写 `provider.circuit`；半开请求成功即关闭 |
| 路由组全部不可用 | 全部成员失败或熔断 | 按入口协议的错误格式返回 503，`hh.error.origin=upstream`，不换成路由组外的模型 | `model.call` 含全部尝试 |
| 首字节后上游断流 | 读超时或连接重置 | 不重试，以协议内错误事件结束流 | `model.call` 状态为上游中断 |
| 插件崩溃或无响应 | 进程退出、调用超时、非法消息 | 进行中的调用以 `PLUGIN_UNAVAILABLE` 失败；依赖它的 provider 标为不可用，路由组跳过；按 1、2、4…60 s 退避重启；10 分钟内崩溃 5 次后标为 `failed`，需 `hh plugin restart` | `plugin.crashed`；导出器从已确认的游标续传 |
| Worker 崩溃 | IPC 断开或进程退出 | 活动 Run 判为 `failed`（stopReason 为 `backend_error`，与现有 Runtime 相同；错误码 `WORKER_EXITED`），清理进程树并如实记录 cleanupStatus；下一个 Run 懒启动新 Worker；同一 Session 5 分钟内崩溃 3 次后拒绝新 Run（`SESSION_DEGRADED`），直到 `hh session reset` | Run 终止事件 |
| 存储失败 | `SQLITE_FULL`、`SQLITE_IOERR`、`SQLITE_CORRUPT`、PostgreSQL 不可达；或每 10 s 的水位检查发现可用空间低于 `storage.minFreeBytes`（默认 512 MiB） | 进入 `storage_degraded`：新 Run 与新模型请求返回 503 `STORE_UNAVAILABLE`；活动 Run 请求取消；`/readyz` 返回 503；只读查询继续 | 能写时写 `storage.degraded`，否则写 stderr；连续 3 次探测写入成功后自动退出降级；`SQLITE_CORRUPT` 不自动退出，需要 `hh doctor` 与恢复 |
| 秘密后端不可用 | 引用解析失败（如钥匙串锁定） | 只影响用到该引用的 provider 或插件，返回 `SECRET_UNAVAILABLE` | `model.call` 记为本地失败 |
| OTLP 导出端不可用 | 导出失败 | 有界队列满后丢弃并计数，从不阻塞请求 | `hh.otel.dropped` |
| 日志写失败 | 写入异常 | 首次失败报告一次，之后放弃该文件，Run 与网关不受影响（ADR 0014） | 下次轮转时重试 |
| 接线写入失败 | 原子写入或回读校验失败 | 原文件保持不变，明确报告 | `wiring.failed` |

网关的证据顺序是 [DESIGN.md](../../../DESIGN.md#6-业务存储与事件) “先提交再发布”在模型平面的落实，也是存储失败时必须停止接收模型请求的原因：

- 调用开始时异步写入开始记录，不阻塞转发；它只用于崩溃后识别中断的调用。
- 流式响应的结束事件（如 Chat 的 `data: [DONE]`、Messages 的 `message_stop`）在最终记录提交成功后才发出；非流式响应在提交成功后才写出响应体。提交失败时以协议内错误结束，客户端不会看到“成功但没有证据”的调用。提交耗时计入第 2 节的证据提交预算。

## 4. 单实例、崩溃恢复与升级

### 4.1 单实例锁

- `<数据根>/hh.lock` 是只用于加锁的 SQLite 文件。守护进程用专用连接执行 `PRAGMA locking_mode=EXCLUSIVE` 与 `BEGIN EXCLUSIVE`，保持到进程退出。SQLite 在 POSIX 上使用 fcntl 记录锁，在 Windows 上使用 LockFileEx，进程退出时都由内核释放。
- 现状以 `runtime_metadata` 中的 PID 是否存活判断所有权（[`sqlite-store.ts`](../../../packages/store/src/storage/sqlite-store.ts) 第 108、227–245 行），异常退出后 PID 一旦被复用，启动会一直被拒绝（核验 V13-N2）。核验中在 macOS 上实测 SIGKILL 后 SQLite 独占锁可立即重新取得；Windows 的 TerminateProcess 与关闭控制台窗口两种退出方式需要在 Windows 上单独验证。
- POSIX fcntl 锁的陷阱：同一进程关闭指向该文件的任何描述符都会释放锁。因此 `hh.lock` 只被这一条连接打开，其他代码（包括 `hh doctor`）只读 `owner.json`。
- 启动顺序：解析根目录 → 校验权限（07 第 1 节）→ 取锁 → 写 `owner.json` → 打开日志 → 打开 Store → 迁移 → 恢复 → 监听 → 就绪。取锁之前不写任何文件，这修复了“第二次启动在取得所有权之前改写运行中实例的配置”的问题。
- 取锁失败时以退出码 5（冲突，见 [06 第 5 节](06-interfaces.md#5-cli)）结束，消息包含 `owner.json` 中的 pid、启动时间、版本与地址，不尝试终止对方。`hh` CLI 自动拉起前先用管理令牌访问该地址，对方无响应时报告“实例无响应”并建议运行 `hh doctor`。
- 监听端口被其他程序占用时明确失败，不自动换端口，因为全局接线的 Agent 依赖固定地址。
- POSIX 的 SIGINT、SIGTERM、SIGHUP 与 Windows 的 SIGBREAK、控制台关闭事件都走有序关闭：`/readyz` 改为 503 `draining` → 停止接收新请求 → 等待进行中的模型调用最多 30 s → 请求取消活动 Run，宽限内确认的记为 `cancelled`（stopReason 为 `daemon_shutdown`），未确认的留给下次启动记为 `interrupted` → 关闭 Worker 与插件 → 退出。总时限 45 s，超时后强制退出。

### 4.2 崩溃恢复

取锁并完成迁移之后、开始监听之前依次执行，完成后提交 `runtime.recovered`（各类计数）：

1. SQLite 打开时自动完成 WAL 恢复。`owner.json` 标记上次未正常退出时执行 `PRAGMA quick_check`，失败则不进入就绪状态，并提示从迁移备份或 `hh backup` 恢复。
2. 非终态 Run：按 Worker 租约核实进程归属（Windows 用命名 Job，见 ADR 0007；POSIX 用进程组加 ownerToken 环境标记扫描），只终止确认属于自己的残留进程，Run 记为 `interrupted` 并写入 cleanupStatus，不重放任何工具调用。POSIX 上另建会话的后代会逃出进程组（核验 V11-N1），ownerToken 扫描实现之前 cleanupStatus 只能报 `unconfirmed`。
3. 只有开始记录的 `model.call` 记为 `interrupted`，带已耗时长，计入所属 Run 的用量缺口。
4. 进行中的接线操作：接线日志记录了写前与写后的文件哈希。当前文件等于写后哈希记为已应用；等于写前哈希记为未应用；都不等则提交 `wiring.conflict`，等待用户处理，不自动覆盖。
5. 按 ownerToken 识别并终止残留的插件进程。
6. 清理 `tmp/` 中本数据根此前创建的临时文件。

### 4.3 升级、迁移与回滚

- 更新命令的流程（签名校验、活动 Run 的处理、替换二进制）由 [10 第 5 节](10-engineering.md#5-发布工程) 规定。本节只规定数据侧：Homebrew、apt、winget、npm 安装的副本由包管理器替换文件，守护进程启动时发现版本变化，同样按下述规则迁移与回滚。
- 新版本按 07 第 2.2 节先备份再迁移。迁移失败、启动到就绪超过 60 s 或就绪检查失败时自动回滚：停止新版本，恢复迁移前备份；经 `hh self-update` 安装的换回旧二进制并启动，经包管理器安装的停在未启动状态，提示用包管理器回退版本。此时新版本尚未接收请求，不丢数据。
- 新版本就绪并开始服务之后，只能手动执行 `hh self-update --rollback`：它列出升级以来写入的 Run 与调用数量，确认后恢复迁移前备份，这些数据会丢失。数据库版本高于二进制时拒绝启动（`SCHEMA_TOO_NEW`），不做降级迁移。
- 验证：从每个受支持的旧版本升级的 fixture 测试；在迁移前、迁移中、就绪前三个点注入 `kill -9`，断言重启后数据库要么是旧版本的完整状态，要么是新版本的完整状态。

## 5. 追踪

追踪是证据的导出视图，不是第二个事实来源：span 在对应证据提交之后才结束并进入导出队列，Store 仍是唯一事实来源。OpenTelemetry 的 [GenAI 语义约定](https://github.com/open-telemetry/semantic-conventions-genai) 目前是 Development 状态，定义了推理、`create_agent`、`invoke_agent`、`invoke_workflow`、工具执行与 MCP 的 span，以及 `gen_ai.client.token.usage` 等指标。HarnessHub 的映射如下（设计示意，不可直接运行）：

```text
invoke_workflow compare-fix-foo          并行比较或评测（多个 Run）
└─ invoke_agent codex                    Run
   ├─ chat deepseek/deepseek-chat        model.call（网关处理一次入站请求）
   │  ├─ chat deepseek-chat              attempt #0，上游返回 503
   │  └─ chat deepseek-chat              attempt #1，成功
   ├─ execute_tool shell                 Agent 报告的工具调用
   └─ hh.permission.wait                 权限往返
```

| HarnessHub 对象 | span 名 | `gen_ai.operation.name` | kind | 父 span |
|---|---|---|---|---|
| 并行比较或评测 | `invoke_workflow <名称>` | `invoke_workflow` | INTERNAL | 无，或调用方的 traceparent |
| Run | `invoke_agent <agent>` | `invoke_agent` | INTERNAL | workflow 或调用方 |
| `model.call` | `<操作> <请求模型>` | `chat`；Gemini 入口为 `generate_content` | SERVER | Session 作用域 Key 对应的当前 Run；全局接线时为根 span |
| attempt | `<操作> <wire 模型名>` | 同上 | CLIENT | `model.call` |
| 工具调用 | `execute_tool <工具名>` | `execute_tool` | INTERNAL | Run |
| HarnessHub MCP Server 收到的调用 | 按选定版本的 MCP 约定 | — | SERVER | 调用方 |

`create_agent` 不使用，HarnessHub 不创建 Agent。`model.call` 的父 span 由 Gateway Key 的作用域确定，同一 Session 的 Run 串行执行，因此归属唯一，不依赖 Agent 透传 traceparent。只有带有效 Gateway Key 的请求，其 `traceparent` 才被接受为父 span，否则另起根 span，防止外部注入父子关系。工具调用 span 的时间是 HarnessHub 观察到 Agent 事件的时间，带 `hh.timing.source=observed`。

| 属性 | 位于 | 取值 | 默认导出 |
|---|---|---|---|
| `gen_ai.provider.name` | attempt | provider 预设映射到规范值（如 `openai`、`anthropic`、`gcp.gemini`），自定义 provider 用其 ID | 是 |
| `gen_ai.request.model` | `model.call`、attempt | 前者为 Agent 请求的模型（Model Ref 或别名），后者为发往上游的 wire 名 | 是 |
| `gen_ai.response.model`、`gen_ai.response.id` | `model.call`、attempt | 上游回报的模型与响应 ID | 是 |
| `gen_ai.response.finish_reasons` | `model.call` | 规范化后的结束原因 | 是 |
| `gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens` | `model.call`、attempt | 上游用量；未回报时不设置，不写 0 | 是 |
| `gen_ai.request.max_tokens`、`temperature`、`top_p` | `model.call` | 请求中出现时 | 是 |
| `gen_ai.conversation.id` | Run、`model.call` | Session ID | 是 |
| `gen_ai.agent.name` | Run | Adapter ID | 是 |
| `gen_ai.tool.name`、`gen_ai.tool.call.id` | `execute_tool` | Agent 事件 | 是，参数与结果不导出 |
| `server.address`、`server.port` | attempt | 上游地址，不含路径与查询 | 是 |
| `error.type` | 失败的 span | HarnessHub 错误码或 HTTP 状态 | 是 |
| `gen_ai.input.messages`、`gen_ai.output.messages`、`gen_ai.system_instructions` | `model.call` | 请求与回答正文 | 否 |
| `hh.run.id`、`hh.session.id`、`hh.model_call.id`、`hh.attempt.index` | 各自的 span | | 是 |
| `hh.ingress.protocol`、`hh.stream`、`hh.route.group`、`hh.route.strategy`、`hh.failover.reason` | `model.call`、attempt | | 是 |
| `hh.key.scope`、`hh.key.id` | `model.call` | 作用域种类与可公开的 Key ID | 是 |
| `hh.time_to_first_byte_ms`、`hh.time_to_first_content_ms` | `model.call` | | 是 |
| `hh.usage.cache_read_tokens`、`hh.usage.cache_write_tokens`、`hh.usage.reasoning_tokens` | `model.call` | 选定的约定版本有对应属性时改用规范名 | 是 |
| `hh.cost.amount`、`hh.cost.currency`、`hh.cost.source` | `model.call` | `reported`、`estimated` 或 `unknown` | 是 |
| `hh.run.outcome`、`hh.cleanup.status` | Run | | 是 |

- 约定版本：`observability.otel.genaiSemconv` 取 HarnessHub 内置映射表支持的版本之一，默认是发布时固定的版本；也识别 `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`，此时选用支持的最新版本。每个 span 带对应的 schema URL。约定改名时（例如以 `gen_ai.provider.name` 取代已弃用的 `gen_ai.system`），旧名在一个次版本内与新名同时输出，然后按 [09 第 6 节](09-extensibility.md#6-兼容策略) 的弃用规则移除。
- 内容默认不导出：提示词、回答、系统指令、工具参数与结果都不导出。`observability.otel.captureContent=true` 时才按约定的内容属性导出，内容先经第 7 节脱敏；该开关对每个导出端单独设置。Magpie 同样默认关闭 OTLP 导出，也不导出提示词与回答正文。
- 导出：`observability.otel.enabled` 默认关闭。协议为 OTLP/HTTP（protobuf），1.0 不提供 gRPC 以免引入额外依赖；端点在配置中，请求头的值是秘密引用。Langfuse 等接收 OTLP 的后端可以直接使用（Langfuse 的入口为 `/api/public/otel`）。
- 队列：有界队列 2,048 个 span，每批 512 个，每 5 s 刷新，单次导出超时 10 s；429、502、503、504 与网络错误最多重试 2 次，间隔上限 60 s；队列满时丢弃并计数，从不阻塞网关；端点或凭据变更时丢弃队列；有序关闭时最多等待 3 s。默认采样为 parent-based always-on，团队服务器可设置根采样比例。

## 6. 指标

指标名遵循 OpenTelemetry 约定：GenAI 指标使用语义约定中的名字，其余使用 `hh.*`。导出方式为 OTLP（开启时），以及 Prometheus 文本格式：路径为 `/metrics`（[06 第 1 节](06-interfaces.md#1-端口与路径布局)），本机使用管理令牌，团队服务器使用 owner 或 admin 的 API Key，均不注册在局域网监听器上。Prometheus 名称由导出器转换（点换下划线、加单位后缀）。

| 名称 | 类型 | 单位 | 标签 |
|---|---|---|---|
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model`、`gen_ai.token.type` |
| `gen_ai.client.operation.duration` | Histogram | s | `gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`error.type` |
| `gen_ai.server.request.duration` | Histogram | s | `gen_ai.operation.name`、`hh.ingress.protocol`、`error.type` |
| `gen_ai.server.time_to_first_token` | Histogram | s | `gen_ai.operation.name`、`hh.ingress.protocol` |
| `hh.gateway.requests` | Counter | `{request}` | `hh.ingress.protocol`、`hh.stream`、`status_class`、`hh.error.origin`（`local`、`upstream`、`client`） |
| `hh.gateway.added_latency` | Histogram | s | `hh.ingress.protocol`、`hh.stream`、`phase`（`first_byte`、`total`） |
| `hh.gateway.attempts` | Counter | `{attempt}` | `gen_ai.provider.name`、`outcome`（`success`、`retryable`、`fatal`、`circuit_open`） |
| `hh.gateway.failovers` | Counter | `{failover}` | `hh.route.group`、`reason` |
| `hh.provider.circuit.state` | Gauge | 1 | `gen_ai.provider.name`、`state` |
| `hh.ledger.cost` | Counter | 货币单位 | `gen_ai.provider.name`、`gen_ai.request.model`、`hh.key.scope`、`currency`、`hh.cost.source` |
| `hh.evidence.commit.duration` | Histogram | s | `kind`（`model_call`、`run_event`、`wiring`、`audit`）、`backend` |
| `hh.evidence.missing` | Counter | `{call}` | `kind`；必须恒为 0 |
| `hh.runs`、`hh.run.duration`、`hh.run.queue_time` | Counter、Histogram、Histogram | `{run}`、s、s | `gen_ai.agent.name`、`outcome` |
| `hh.runs.active`、`hh.workers.active` | UpDownCounter | `{run}`、`{worker}` | `gen_ai.agent.name` |
| `hh.worker.crashes` | Counter | `{crash}` | `gen_ai.agent.name`、`reason` |
| `hh.cleanup.unconfirmed` | Counter | `{run}` | `platform` |
| `hh.plugin.calls`、`hh.plugin.call.duration`、`hh.plugin.restarts` | Counter、Histogram、Counter | `{call}`、s、`{restart}` | `plugin`、`method`、`outcome` 或 `reason` |
| `hh.store.operation.duration`、`hh.store.errors` | Histogram、Counter | s、`{error}` | `operation` 或 `class`、`backend` |
| `hh.storage.free` | Gauge | By | `root`（`data`、`logs`） |
| `hh.sse.subscribers`、`hh.sse.lag` | UpDownCounter、Histogram | `{subscriber}`、`{event}` | — |
| `hh.wiring.state` | Gauge | `{agent}` | `gen_ai.agent.name`、`state`（`wired`、`unwired`、`replaced`、`bypassed`） |
| `hh.auth.failures` | Counter | `{request}` | `route_class`、`reason` |
| `hh.log.write_failures`、`hh.log.unserializable` | Counter | `{record}` | `file` |
| `hh.otel.dropped` | Counter | `{item}` | `signal` |
| 进程与运行时 | 按 OTel 运行时约定 | | `process.memory.usage`、`process.cpu.time`、`nodejs.eventloop.delay.p99` |

基数规则：标签中不出现 Run、Session、Key、用户 ID，也不出现路径与错误正文；模型标签只取目录中或已配置的模型，单个指标超过 200 个不同值后其余记为 `other`；团队服务器可选增加 `hh.project` 标签。

## 7. 日志与脱敏

现状有四个缺口（核验 redaction-unify、V9-N1）：两套规则分叉，即 [`createRedactor`](../../../src/worker/diagnostics.ts)（第 18–32 行）与上游错误用的 `sanitize`（`packages/gateway/src/upstream.ts` 第 648 行起）；[`JsonLogFile`](../../../src/logging/json-log-file.ts) 先截断、序列化整行再脱敏（第 75–97 行），赋值规则会吞掉 `\"` 中的反斜杠，实测 7 条带引号凭据的输入中 5 条整条变成 `log.unserializable`；调用方先截断（2 KiB、200 字符、8 KiB、16 KiB）再交给脱敏，已知秘密跨过截断点时留下前缀；名字前的 `\b` 使 `DB_PASSWORD`、`client_secret` 等漏检，25 条正样例中 17 条原样保留。

日志格式沿用 ADR 0014 的 JSON Lines：`{time, level, event, ...}`，级别扩展为 `error`、`warn`、`info`、`debug`，在 span 内的记录带 `trace_id`、`span_id`，并按需带 `run_id`、`session_id`、`plugin`。文件为 `<日志根>/daemon.log`、`<日志根>/sessions/<sessionId>/engine.log`、`<日志根>/plugins/<id>.log`，每个 16 MiB 轮转、保留 3 代。`log.level`（或 `HH_LOG_LEVEL`）默认 `info`；`debug` 包含提示词摘录，只用于排查。开启 OTLP 时日志也可导出，经同一套脱敏。

失败调用快照默认关闭。`log.captureFailedCalls=true` 时，网关把失败调用的请求与响应经下述结构化脱敏后写入 `<日志根>/snapshots/`，单个不超过 256 KiB，保留 7 天（07 第 2.3 节）；快照含提示词，不进入诊断包，除非显式指定 `--include-snapshots`。

统一规则表是 `core` 包中的纯函数模块，是唯一权威来源。日志、公开错误文本、SSE 错误字段、`model.call` 的错误摘录、OTel 属性与日志记录、诊断包、日志读取接口的读出时复查都调用它。

| 编号 | 规则 | 正样例 | 替换 |
|---|---|---|---|
| K1 | 已知值：本进程解析过的全部秘密值（provider 凭据、插件授权秘密、管理令牌、会话、签发时的 Key 原文），长度 ≥ 4，按长度降序替换 | — | `[REDACTED]` |
| S1 | 结构化键名：JSON 键、HTTP 头名、`NAME=` 中的名字含 password、passwd、secret、token、api key、access key、private key、credential、authorization、cookie，允许前后缀 `[A-Za-z0-9_.-]*`，但不以 `tokens`、`token_count` 结尾 | `"client_secret":"…"`、`x-api-key: …`、`DB_PASSWORD=…` | 整个值 |
| S2 | 认证方案 `Bearer`、`Basic`、`Digest`、`token` 后的凭据 | `Authorization: Basic dXNlcjpwYXNz`、`Authorization: token ghp_…` | 保留方案名 |
| S3 | URL userinfo `scheme://user:pass@` | `postgres://admin:pw@db`、`https://oauth2:glpat-…@host` | 口令部分 |
| S4 | PEM 私钥块，含换行被转义为 `\n` 的形式 | `-----BEGIN PRIVATE KEY-----…` | 整块 |
| S5 | JWT（三段 base64url，以 `eyJ` 开头） | `eyJhbGci….eyJzdWIi….sig` | 整体 |
| S6 | 厂商前缀：`sk-`（含 `sk-ant-`、`sk-proj-`）、`AKIA`、`ASIA`、`AIza`、`ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_`、`glpat-`、`xox[abposr]-`、`sk_live_`、`rk_live_`、`hf_`、`gsk_`、`xai-`、`npm_`、`pypi-`，以及 Gateway Key 的 `hhk_` 前缀与 API Key 的前缀 | | `[REDACTED:<种类>]` |
| S7 | 非结构化文本中的 `名字[:=]值`：名字同 S1；值至少 8 位且同时含字母与数字，排除 `${…}`、`%…%`、`<…>`、`process.env…`；引号前允许任意个反斜杠 `(?:\\*["'])?`；值的字符类不含反斜杠与引号 | `--password="Abc12345"`、`echo "token=…"`、`set SECRET="…"` | 值 |
| U1 | 40 位以上连续字母数字的兜底 | | 只用于返回给客户端的上游错误正文，不用于日志，否则会擦掉 sha256 与安装哈希 |

反样例（必须保留原样）：`max_tokens`、`usage.input_tokens`、`{"key":"value"}`、`sort_key`、`monkey`、64 位十六进制 sha256、Run 与 Session ID、`C:\Users\张三\proj`、`${OPENAI_API_KEY}`。已知误擦：`tokenizer=cl100k_base` 的名字含 token 且值同时含字母与数字，会被 S7 替换，测试中作为已知行为列出。规则形状参考了 Magpie 的 `internal/redact`（`redact.go` 的规则表、`scrub.go` 的按键名擦除与逐字符串 JSON 擦除），但 Magpie 的单个可选反斜杠覆盖不了 HarnessHub debug 载荷的双层编码（核验实验 p3）。

处理顺序（对每条记录的每个字符串字段）：

1. 结构化遍历：对象按键名执行 S1，HTTP 头按名执行 S1 与 S2；字符串内容能解析为 JSON 时（包括 debug 载荷中的双层编码）递归遍历后重新编码。
2. 对每个原始字符串依次执行 K1 与 S2–S7。
3. 再截断到字段上限 8 KiB，截断标记为 `…(+N)`。
4. 序列化整条记录，对整行再做一次 K1，作为已知值的第二道防线。
5. 用 `JSON.parse` 校验。按上述顺序脱敏不会再产生非法 JSON，这一步只是兜底：失败时写入保留 `time`、`level`、`event` 与字段名列表的替代记录，并计数 `hh.log.unserializable`，不再整条丢弃。

截断只发生在日志接收端：`LogSink` 接收完整字符串或 JSON 值加可选上限，`core` 包不导出单独的截断函数。必须在交出前限长的调用方（如每个进程 256 KiB 的 stderr 预算）只能使用 `redactExcerpt()`，它先脱敏后截断。

验证：

- 表驱动测试：正样例不少于 30 条，覆盖核验语料的 25 种形状；反样例不少于 15 条；每条在原文、单层 JSON 转义、双层 JSON 转义三种编码下各运行一次。新增规则必须同时提交正、反样例。
- 性质测试：任意合法记录脱敏后仍是合法 JSON，事件名与非敏感字段保留；已知秘密跨过截断点时，不残留 4 个字符以上的前缀。
- 回归：核验中整条丢失的 5 种输入（`curl -H "x-api-key: …"`、`--password="…"`、`echo "token=…"`、`{"error":"invalid api_key=…"}`、`set SECRET="…"`）写入后事件名不变、凭据被替换。
- 集成：放入种子秘密，以 info 与 debug 各运行一次含工具调用、权限与 stderr 的 Run，检查守护进程日志、Session 日志、日志读取接口、诊断包与内存中的 OTel 导出器，均不含种子值。

## 8. 诊断

### 8.1 hh doctor

| 编号 | 检查 | 通过条件 | 失败时 |
|---|---|---|---|
| D01 | 构建身份：版本、commit、构建时间、签名 | 与发布清单一致 | 报告来源不明的构建 |
| D02 | 数据目录：位置、权限与 DACL、文件系统类型、可用空间 | 符合 07 第 1 节；可用空间 ≥ 1 GiB | `--fix` 可修复权限 |
| D03 | 单实例：锁状态与 `owner.json` | 锁空闲，或持锁实例可访问 | 报告无响应实例的 pid 与启动时间 |
| D04 | 存储：schema 版本、待执行迁移、`quick_check`、WAL 大小 | 无待执行迁移，检查结果为 ok | 给出恢复步骤 |
| D05 | 监听：端口、Host 允许名单、局域网 TLS 证书、管理路由只在回环监听器 | 证书剩余超过 14 天 | 指出配置项 |
| D06 | 秘密：后端可用；每个引用可解析（不打印值）；没有 07 第 4.6 节禁止的引用；env 引用的变量存在 | 全部满足 | 列出引用与使用方 |
| D07 | provider（`--probe`）：列模型或最小请求，含 TLS 与代理诊断 | 可达 | TLS 校验类错误码附 CA 处置提示 |
| D08 | 证书与代理：`NODE_EXTRA_CA_CERTS` 可读、系统证书库状态、`NODE_TLS_REJECT_UNAUTHORIZED` | 未关闭 TLS 校验 | 发现关闭即报错（07 T16） |
| D09 | Agent：发现结果与版本、接线状态与漂移、会覆盖 HarnessHub 设置的托管配置层（如 `/Library/Application Support/opencode`、`%ProgramData%\opencode`、工作区内的 `.codex/config.toml`） | 无未处理漂移 | 指出覆盖层位置（核验 managed-config-layers） |
| D10 | 插件：签名、权限、运行状态、10 分钟内崩溃次数、撤销状态 | 无撤销版本在运行 | 给出 `hh plugin` 处置命令 |
| D11 | 时钟（`--probe`）：与 provider 响应 `Date` 头的差值 | ≤ 5 分钟 | 提示会影响 TLS 与 OIDC |
| D12 | 导出：OTLP 端点可达、丢弃计数 | 丢弃率 < 1% | |
| D13 | 平台：Windows 上 Job 与 ACL helper 可执行；POSIX 上 `ulimit -n` ≥ 4096 | 满足 | |
| D14 | 隐私：遥测与更新检查状态、默认联网清单（07 第 8 节） | 仅提示 | |

输出为人读表格或 `--json`（模式名 `hh.doctor/v1`）。退出码沿用 06 第 5 节：0 表示没有失败项（可有警告），20 表示有失败项，1 表示 doctor 自身出错。`--fix` 只执行表中标明的修复，执行前先预览。守护进程未运行时 doctor 只读打开数据库，不取单实例锁，不触发迁移。

### 8.2 hh debug bundle

| 内容 | 默认 | 处理 |
|---|---|---|
| `manifest.json` | 是 | 条目、大小、sha256、脱敏规则集版本、HarnessHub 版本与平台、已知值脱敏是否完整 |
| `doctor --json` 输出、指标快照、系统信息（OS、架构、Node 版本、CPU 数、内存、文件系统类型） | 是 | |
| 配置 | 是 | `config.jsonc` 与生效配置，秘密只保留引用 |
| 守护进程日志与插件日志（含轮转） | 是 | 结构化脱敏 |
| Session 日志、Run 摘要与事件、`model.call` 记录 | 最近 24 小时活动的 Session，或 `--session` 指定 | 消息正文默认只保留长度与 sha256，`--include-content` 才包含；`model.call` 只有元数据 |
| 环境变量 | 只含允许名单中的名字（`HH_*`、代理与 CA 相关） | 代理值去掉 userinfo |
| Agent 配置文件 | 否 | `--include-agent-configs` 时经结构化脱敏；默认只给接线差异摘要与哈希 |
| 秘密后端内容、`admin.token`、`secrets.key`、Cookie、数据库文件、工作区与产物 | 从不 | |

- 诊断包由守护进程生成（`POST /api/v1/system/debug-bundles`），因此已知值集合完整。守护进程未运行时由 CLI 生成，只能解析部分引用，清单中标记 `knownValuePass: "partial"`。现状的 `Collect-Logs` 只按变量名后缀判断已知值（核验 redaction-unify），开源版改由守护进程提供。
- 每个文件按第 7 节结构化脱敏：JSONL 逐行解析后遍历，其他文本逐行处理，二进制文件不收集。
- 生成后自检：对每个输出文件扫描已知值与高置信度形状（S4、S5、S6），有命中就中止并报告文件与行号（不打印值），不产出诊断包。
- 输出 `hh-debug-<UTC 时间>.zip`，权限 0600，默认上限 200 MiB，超过时从最旧的日志开始舍弃并在清单中注明；生成后打印内容清单，提醒用户分享前复核。

## 9. 健康检查与告警

- `GET /healthz`：事件循环 1 s 内响应即返回 200，不检查任何依赖。
- `GET /readyz`：持有单实例锁、迁移与恢复已完成、30 s 内有一次成功的 Store 写入、可用空间高于水位时返回 200；否则返回 503，正文为原因数组（`migrating`、`recovering`、`storage_degraded`、`low_disk`、`draining`）。团队服务器对未认证请求只返回状态码。
- `GET /api/v1/system/health`（需认证）：组件明细，包括 provider 熔断状态、插件状态、Worker 数、秘密后端、导出丢弃数、证书有效期。
- 本机没有告警系统：控制台顶部横幅与 `hh status` 显示下表中处于触发状态的条件；托盘（1.x）可发系统通知。团队服务器随发布附带 Prometheus 告警规则文件（仓库位置由 [10 第 1 节](10-engineering.md#1-仓库结构) 定义）：

| 告警 | 条件 | 持续 | 级别 |
|---|---|---|---|
| HHEvidenceMissing | `hh.evidence.missing` 增加 | 立即 | critical |
| HHAuditWriteFailure | 审计提交失败数增加 | 立即 | critical |
| HHStoreDegraded | ready 原因含 `storage_degraded` | 1 分钟 | critical |
| HHErrorBudgetBurn | API 可用性 30 天错误预算在 1 小时窗口内的燃烧率 > 14.4，且 5 分钟窗口同样超标 | 5 分钟 | critical |
| HHGatewayLocalErrors | `hh.error.origin=local` 的请求占比 > 0.1%（> 1% 为 critical） | 10 分钟 | warning |
| HHAddedLatencyHigh | 附加延迟 p99 > 25 ms | 15 分钟 | warning |
| HHProviderCircuitOpen | 某 provider 熔断打开 | 5 分钟 | warning |
| HHPluginFailed | 插件进入 `failed` | 立即 | warning |
| HHCleanupUnconfirmed | `hh.cleanup.unconfirmed` 增加 | 立即 | warning |
| HHLowDisk | 可用空间 < 2 × `storage.minFreeBytes` | 10 分钟 | warning |
| HHCertExpiring | 证书剩余 < 14 天 | 1 小时 | warning |
| HHOtelDropping | 导出丢弃率 > 1% | 15 分钟 | info |

## 10. 故障注入与混沌测试

故障通过可注入的端口实现：Store、上游传输、时钟、进程宿主、秘密后端、插件传输在测试中替换为会出错的实现。发布二进制中不含任何故障开关，避免增加攻击面。进程被杀、磁盘写满、网络故障从进程外部施加。

| 场景 | 注入方式 | 必须成立的结果 |
|---|---|---|
| 守护进程在流式响应中途被杀 | `kill -9`；Windows 用 TerminateProcess | 重启后 1 s 内重新取得锁；该 `model.call` 为 `interrupted`；所属 Run 为 `interrupted` 且只有一个终止事件 |
| Worker 在 Run 中途崩溃 | 外部信号 | Run 为 `failed`，cleanupStatus 如实；下一个 Run 正常 |
| 插件挂起、崩溃、输出非法 JSON 或超大消息 | 测试插件 | 守护进程保持就绪；相关调用以明确错误失败；退避重启 |
| 磁盘写满 | Linux 上用小容量 tmpfs 或 loop 设备；其他平台用故障 Store | 进入 `storage_degraded` 并拒绝新请求；没有“客户端收到成功但无证据”的调用；空间恢复后自动退出降级 |
| SQLite 返回 IOERR 或 BUSY 超时 | 故障 Store | 同上，错误不被吞掉 |
| 上游：首字节前 503、首字节后断流、只发头不发体、200 返回 HTML、429 带 Retry-After、TLS 证书未知或过期、DNS 失败 | 脚本化假上游 | 符合 ADR-P05；每次尝试都有证据；首字节后不重试 |
| 时钟前后跳变 1 小时 | 假时钟 | 期限与时长使用单调时钟，结果不变 |
| 钥匙串锁定 | 故障秘密后端 | 只影响相关 provider |
| 迁移中途被杀 | 外部信号 | 数据库为旧版本或新版本的完整状态 |
| 两个实例同时启动 | 并发启动两个进程 | 只有一个取得锁；另一个以退出码 5 结束，未写任何文件 |
| Windows 关闭控制台窗口 | Windows CI 发送 CTRL_CLOSE_EVENT | 有序关闭，或下次启动恢复；锁已释放 |

每个场景结束后由同一个检查器核对五条不变式：客户端收到完整响应的调用都有已提交的 `model.call`（对比假上游与客户端日志）；每个 Run 恰有一个终止事件；按 ownerToken 扫描没有残留进程；日志与诊断包不含种子秘密；从任意游标续读 SSE 得到的事件与数据库一致。

执行频率：每个 PR 在三平台上运行确定性的故障测试；每晚运行带随机种子的混沌测试，种子写入结果以便复现，Linux 每个场景至少 200 次，macOS 与 Windows 至少 50 次；发布前三平台全部通过。Windows 的结果只来自 Windows runner，不以 macOS 或 Linux 的结果代替（[DESIGN.md 第 8 节](../../../DESIGN.md#8-windows-能力与验证边界)）。
