# 执行观测

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元测试（用量归属、差分、缺失值、日志读取与脱敏）与集成测试（正式 Gateway/Worker、ACP 夹具、本地上游与 SQLite，含重启后重建），本机 macOS arm64；读取 Pi、OpenCode、DSH 原生文件只用历史文件核对过格式；Windows 原生采集未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [运行观测与覆盖范围](../../observability.md)、[诊断日志](../../observability.md#诊断日志)、[ADR 0005](../../decisions/0005-console-workflows-observability.md)、[ADR 0014](../../decisions/0014-diagnostic-logs.md) |

## 用途

回答“这次执行用了哪个模型、花了多少 token 和钱、时间耗在哪里、数据是否完整”，并在出问题时看到 Gateway 与引擎两侧的诊断日志。所有数字都从已提交的事件重建，未知就是未知，不用零或配置值冒充。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 观测（`/observability`）：状态计数、引擎负载、p50/p95、已知 token 与样本覆盖；任务的执行详情：模型、阶段耗时、token、费用来源、安装版本、覆盖缺口、`model.call` 记录与“诊断日志”面板 |
| 命令行 | 启动前设置 `HARNESSHUB_LOG_LEVEL=info\|debug`；日志文件在 `<dataDir>/logs/gateway.log` 与 `<dataDir>/backends/<sessionId>/diagnostics/engine.log` |
| HTTP | `GET /v1/runs/{id}/observations`、`GET /v1/observability?limit=`（1–200，默认 50）、`GET /v1/sessions/{id}/logs?source=engine\|gateway&limit=&after=` |

## 已实现的能力

- 单个 Run 的观测：配置模型与实际模型分开，阶段耗时（`queueMs`、`startupMs`、`timeToFirstOutputMs`、`executionMs`、`durationMs`、`cleanupMs`），文本与思考字符数，去重后的工具调用数，权限与产物数，token 与费用及缺失原因。
- 概览的状态计数来自全部持久 Run；分位数、已知 token 合计与 `usageCoverage` 只针对 `scope.sampledRuns` 指定的最近样本。
- token 来源与 Run 归属：ACP 按精确请求 ID 或新增的 `perRequest` 消息 ID；Pi、OpenCode 读取 Worker 私有目录中与后端会话 ID 和 cwd 都匹配的原生消息并差分；DSH 读取其会话投影；经共享网关的 Run 汇总本 Run 的 `model.call` 事件（来源 `gateway-ledger`）。无法归属到 Run 的累计值只进 `sessionUsage`。
- 费用分 `reported`（ACP 报告的累计成本按前后差分）、`estimated`（Pi、OpenCode 的原生价格表，或网关账本的价格）与 `unknown`；网关账本中有任一调用未定价时整次为 `unknown`，原因 `run-cost-partially-unpriced`。
- 实际模型：账本有记录时取上游报告的模型；否则原生消息中的模型优先于 ACP 会话状态；没有观测时不回填配置别名。
- 覆盖：每页读事件至多 1,000 条、每个 Run 至多 10,000 条、概览至多 200 个 Run；超出或序号有缺口时 `coverage.eventsComplete=false`。
- 私有读取器只读 `stateDir/home` 下与会话精确关联的文件，每个文件至多 16 MiB、一次至多 32 MiB 与 2,048 条记录，拒绝链接与读取中变化；读取失败只形成观测缺口。
- 诊断日志两层：`gateway.log`（访问、Session/Run/Worker/权限生命周期、模型调用摘要）与每个 Session 的 `engine.log`（引擎进程与 stderr、逐条 ACP 请求与响应、工具状态、模型调用明细）；JSON Lines、写前脱敏、字符串至多 8 KiB、超过 16 MiB 轮转为 `.1`～`.3`、文件 0600；写失败只报告一次，不影响 Run。
- `debug` 级另写提示词、ACP 参数、上游请求与回答等摘录（每项至多 2,048 字符）。
- 日志接口按游标增量读取（默认 200 行、至多 2000 行、单次扫描至多 32 MiB、返回至多 2 MiB），读出时再次脱敏；控制台面板可切换两种日志、按级别与关键字筛选、运行中每 2 秒刷新、复制或下载。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [observability.ts](../../../packages/runtime/src/application/observability.ts)、[observations.ts](../../../packages/drivers/src/acp/observations.ts)、[observation-routes.ts](../../../packages/daemon/src/http/observation-routes.ts)、[json-log-file.ts](../../../packages/daemon/src/logging/json-log-file.ts)、[session-log-reader.ts](../../../packages/daemon/src/logging/session-log-reader.ts)、[observed-store.ts](../../../packages/daemon/src/logging/observed-store.ts)、[diagnostics.ts](../../../packages/daemon/src/worker/diagnostics.ts) |
| 测试 | [observability.test.ts（单元）](../../../tests/unit/observability.test.ts)、[observability.test.ts（集成）](../../../tests/integration/observability.test.ts)、[session-logs.test.ts](../../../tests/integration/session-logs.test.ts)、[diagnostic-logs.test.ts](../../../tests/integration/diagnostic-logs.test.ts)、[session-log-reader.test.ts](../../../packages/daemon/test/session-log-reader.test.ts)、[diagnostic-log.test.ts](../../../packages/daemon/test/diagnostic-log.test.ts) |
| 决策 | [ADR 0005 控制台、自动规划和完整观测](../../decisions/0005-console-workflows-observability.md)、[ADR 0014 诊断日志](../../decisions/0014-diagnostic-logs.md) |

## 已知限制与未验证

- 费用不是账单对账结果；DSH 没有价格时费用未知；不读取账户账单或订阅额度。
- 没有走共享网关、后端也不报告用量的 Run 没有 token 数据（例如比赛期 Pi 运行中 `usage` 为 null）；见 [任务经共享网关](runs-on-gateway.md) 中按 Run 归属的限制。
- Run 与 Session 列表一次读取全部记录，没有面向大量数据的 SQL 聚合。
- `debug` 级日志含任务提示词与模型回答，只应在排查时开启。
- Windows 上的原生用量采集与日志文件权限未验证。

## 优化候选

- **现状**：概览先读出全部 Run 记录，再在进程中计算状态计数与样本。**方向**：在 Store 中做 SQL 聚合与分页，支持大量历史数据。**依据**：[API 与统计范围](../../observability.md#api-与统计范围)。
- **现状**：OTLP 导出的 span 都是根 span，没有 Run 与 attempt 的 span。**方向**：为每个 Run 生成父 span，把该 Run 的 `model.call` 与工具阶段挂在其下。**依据**：[OTLP 导出](../../observability.md#otlp-导出)中与 08 第 5 节的差异。
- **现状**：日志级别只能用环境变量 `HARNESSHUB_LOG_LEVEL` 设置，需要重启。**方向**：纳入 `config.jsonc`，必要时允许按 Session 临时开启 `debug`。**依据**：[不在配置文件中的设置](../../configuration.md#不在配置文件中的设置)。
- **现状**：执行平面的观测接口与模型平面的用量接口（`/api/v1/usage`、`/api/v1/model-calls`）各算一套。**方向**：按设计由 usage、model-calls 与 Run 详情取代 `/v1/observability` 与 `/v1/runs/{id}/observations`。**依据**：[06 第 3 节](../../proposals/oss/06-interfaces.md#3-资源与端点清单)末尾的迁移说明。
