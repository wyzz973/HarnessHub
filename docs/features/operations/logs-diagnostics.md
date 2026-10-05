# 日志与诊断

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 已实现 |
| 验证 | 单元测试（级别解析、摘录、脱敏后仍是合法 JSON、字段上限、轮转代数、失败只报告一次；读取器的尾部、游标、轮转后续读、过滤、再次脱敏与预算）与集成测试（经正式 Gateway、Worker、ACP fixture 与本地上游以 info 和 debug 各运行一次，检查两份日志的必备记录且上游密钥与 Session token 未写入；读取接口的分页、400 与 404），在 macOS arm64 本机通过；真实引擎的日志内容与 Windows 未验证 |
| 对照 Magpie | 对照表没有日志一行；健康检查相关的 Docker image, `magpie healthcheck` 一行为部分（[Packaging and operations](../../magpie-parity.md#packaging-and-operations)） |
| 权威文档 | [运行观测：诊断日志](../../observability.md#诊断日志)、[ADR 0014](../../decisions/0014-diagnostic-logs.md) |

## 用途

部署机器上通常不能挂调试器。守护进程与每个 Session 的 Worker 各写一份 JSON Lines 诊断日志，记录访问、生命周期、引擎进程、ACP 流量与模型调用摘要，出问题时能区分是引擎启动、协议、权限、网关还是上游模型的问题，并且不泄露密钥。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 任务 → 执行详情 → “诊断日志”：切换引擎日志与 Gateway 日志，按级别与关键字筛选，运行时每 2 秒增量刷新，复制或下载当前显示的记录 |
| 命令行 | `HARNESSHUB_LOG_LEVEL=debug hh serve …` 开启 debug；`hh serve` 在 stderr 回显 info 级生命周期行 |
| HTTP | `GET /v1/sessions/{id}/logs?source=engine\|gateway&limit=&after=`；`GET /health/live`、`GET /health/ready` |

## 已实现的能力

- `<dataDir>/logs/gateway.log`（守护进程写）：启动、监听、停止；访问行；Session 创建、状态与后端；Run 接收、状态与结束（含耗时与公开错误）；权限请求、决定与应用；Worker 启动、就绪、退出与失败；每个 `model.call` 摘要；以及出站代理失败、局域网监听失败、同步等模型平面事件。
- `<dataDir>/backends/<sessionId>/diagnostics/engine.log`（该 Session 的 Worker 写）：Run 的开始、准备（实际引擎命令、MCP 服务名、模型网关地址）与结束；引擎进程启动、退出与逐行 stderr（每进程 256 KiB）；ACP 的请求、响应、通知、每轮汇总、工具状态变化与权限决定；每次模型网关调用一行。异常栈在同目录的 `worker-errors.log`。
- 访问行只含方法、路由、去掉 Key 文本的路径、状态、耗时与路由中的 ID，不含请求体、请求头与查询串；修改类请求、失败请求与 `GET /event` 为 info，成功的 GET 与 HEAD（多为轮询）只在 debug 级记录。
- `HARNESSHUB_LOG_LEVEL` 取 `info`（默认）或 `debug`，其他值拒绝启动，并传给每个 Worker；debug 另写 ACP 参数与结果、Run 输入、上游请求与回答的摘录，每项最多 2,048 个字符，含提示词与回答。
- 每个字符串字段最多 8 KiB；每行写入前脱敏（已知密钥值、Gateway Key 文本、`Bearer`、`sk-`、`token=` 一类赋值），脱敏后仍是合法 JSON；文件 0600、目录 0700；超过 16 MiB 轮转为 `.1`～`.3`。
- 写日志失败不影响执行：守护进程向 stderr 报告一次 `log.error`，Worker 在当前 Run 发出一次 `diagnostics.log_failed` 事件。
- 读取接口：`source=engine`（默认）返回该 Session 的引擎日志，`source=gateway` 返回含该 Session 或其 Run ID 的 Gateway 行（不含读取本接口自身的访问行）；默认最新 200 条、最多 2000 条；游标是文件身份加字节偏移，轮转后仍有效；单次最多扫描 32 MiB、返回 2 MiB，超出以 `truncated` 标明；读出时再次脱敏；不联系 Worker；未知 Session 为 404。
- 健康检查：`/health/live` 表示进程存活，`/health/ready` 在就绪时 200、否则 503。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/daemon/src/logging/json-log-file.ts](../../../packages/daemon/src/logging/json-log-file.ts)、[packages/daemon/src/logging/observed-store.ts](../../../packages/daemon/src/logging/observed-store.ts)、[packages/daemon/src/logging/session-log-reader.ts](../../../packages/daemon/src/logging/session-log-reader.ts)、[packages/daemon/src/worker/diagnostics.ts](../../../packages/daemon/src/worker/diagnostics.ts)、[packages/console/components/log-panel.tsx](../../../packages/console/components/log-panel.tsx) |
| 测试 | [packages/daemon/test/diagnostic-log.test.ts](../../../packages/daemon/test/diagnostic-log.test.ts)、[packages/daemon/test/session-log-reader.test.ts](../../../packages/daemon/test/session-log-reader.test.ts)、[tests/integration/diagnostic-logs.test.ts](../../../tests/integration/diagnostic-logs.test.ts)、[tests/integration/session-logs.test.ts](../../../tests/integration/session-logs.test.ts)、[tests/integration/key-text-leaks.test.ts](../../../tests/integration/key-text-leaks.test.ts) |
| 决策 | [ADR 0014 Gateway 与引擎之间的诊断日志](../../decisions/0014-diagnostic-logs.md)（含读取接口的补充） |

## 已知限制与未验证

- 读取接口只按 Session 读；模型平面的事件（代理失败、同步、局域网监听等）只能直接打开 `gateway.log`，控制台的网关页面没有日志视图。
- 日志收集命令已从开源仓库移除，计划中的 `hh debug bundle` 与 `hh doctor` 未实现。
- 日志级别只能用环境变量设置，不在 `config.jsonc` 中；日志在数据目录下，而不是 07 第 1 节规划的平台日志根。
- debug 级会把提示词与回答摘录写进私有日志，只应在排查时开启。
- 读取接口在旧 `/v1` 下，没有凭据要求，只有回环 Host 与同源检查。
- 真实引擎与 Windows 上的日志内容需在对应验收中另行确认。

## 优化候选

- **现状**：没有一键收集诊断信息的命令。**方向**：实现 `hh debug bundle`，收集并再次脱敏日志、构建身份与配置摘要，打成带清单的归档。**依据**：[08 第 8.2 节](../../proposals/oss/08-reliability-observability.md#82-hh-debug-bundle)、[ADR 0014](../../decisions/0014-diagnostic-logs.md)（原收集命令已移除）。
- **现状**：网关与模型平面的问题只能读文件。**方向**：在 `/api/v1` 提供按事件或时间读取 `gateway.log` 的接口，控制台在设置或路由页显示最近的错误事件。**依据**：阅读读取接口与控制台的观察（只有 Session 维度）。
- **现状**：没有自检命令。**方向**：实现 `hh doctor`，检查数据目录、令牌、秘密后端、`env` 引用是否存在与守护进程状态。**依据**：[08 第 8.1 节](../../proposals/oss/08-reliability-observability.md#81-hh-doctor)、[07 第 4.3 节](../../proposals/oss/07-data-security.md#43-引用模型)（变量缺失应在 `hh doctor` 中报告）。
- **现状**：日志级别只在环境变量中。**方向**：由 `config.jsonc` 接管并在 `hh config show` 中显示来源。**依据**：[配置参考：不在配置文件中的设置](../../configuration.md#不在配置文件中的设置)。
