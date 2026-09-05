# 运行观测与覆盖范围

观测由 [ObservationService](../src/application/observability.ts)读取已提交的 Run、Session、事件、权限和产物生成，不维护第二份运行状态。前端刷新和 Gateway 重启后可从 SQLite 重建同一结果。执行完成和任务达标继续分别记录。

## API 与统计范围

- `GET /v1/runs/:id/observations`：单 Run 的模型、版本、阶段耗时、文本与思考字符数、唯一工具调用数、权限和产物数、token、费用及缺失原因。
- `GET /v1/observability?limit=50`：全量运行状态计数、引擎活动/排队负载与最近运行观测。`limit` 为 1～200，默认 50。

概览的状态计数来自所有持久 Run；耗时分位数、token 已知合计和覆盖率仅针对 `scope.sampledRuns` 指定的最近样本。`known*Tokens` 是样本中已报告值的合计，不能当作全量消耗；没有一个已知值时为 `null`。`usageCoverage` 是样本中同时具有本次 Run 输入与输出 token 的比例，空样本为 `null`。p50/p95 使用已结束样本的 nearest-rank 分位数，不含进行中的估算时长。

事件每次分页读取最多 1,000 条，每个 Run 投影最多 10,000 条，概览最多 200 个 Run。超过范围或事件序号有缺口时 `coverage.eventsComplete=false`，字符数和工具数只反映读取部分。当前 Store 的运行/会话列表仍一次读取全部记录；这是本机比赛规模实现，尚未提供大规模全量 SQL 聚合。

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

## 验证

[单元测试](../tests/unit/observability.test.ts)覆盖 ACP 请求归属、累计快照不重复计量、Pi 消息差分、会话不匹配/链接拒绝、字符/工具去重、时间和缺失值。[HTTP 集成测试](../tests/integration/observability.test.ts)通过正式 Gateway、Worker、ACP 本地确定协议端和 SQLite 验证两次运行各自 usage、OpenAPI、范围限制、重启重建一致。

真实模型的最新验收以对应 `docs/verification/` 记录为准；读取历史原生文件能确认格式和已有用量，不等于新 Driver 已完成真实模型调用。Windows 原生采集仍需单独验证。
