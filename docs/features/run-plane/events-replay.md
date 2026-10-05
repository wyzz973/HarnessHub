# 事件、SSE 回放与轨迹导出

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 集成测试（正式 Gateway、真实 SQLite 与编译 Worker，fake 引擎）与 smoke（编译后的导出命令），本机 macOS arm64；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [业务存储与事件](../../../DESIGN.md#6-业务存储与事件)、[执行服务与 API](../../runtime-api.md#创建并执行任务)、[HTTP API 约定](../../api/README.md#幂等流式与生命周期) |

## 用途

一次 Run 的过程（状态变化、回复文本、工具调用、权限、模型调用、产物）都以事件保存。客户端可以边执行边订阅，断线后从上次的位置续读，结束后把完整轨迹导出成 JSON Lines 文件，用于复查、评测或离线分析。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 任务（`/tasks`）的对话区按 SSE 实时显示；执行详情 → 轨迹导出 |
| 命令行 | `hh rollout --url http://127.0.0.1:3180 --run RUN_ID --output FILE`，见 [Benchmark 与 rollout 导出](benchmark-rollout.md) |
| HTTP | `GET /v1/runs/{id}/events`（SSE）、`GET /v1/runs/{id}/event-log?afterSeq=&limit=`（JSON 分页）、`GET /v1/runs/{id}/rollout`（NDJSON） |

## 已实现的能力

- 先提交后发布：Worker 的事件经 Runtime 校验归属（`runId`、`generation`）后写入 SQLite，SSE、事件页与导出都只读已提交的记录。
- 事件信封含 `schemaVersion`、`eventId`、`sessionId`、`runId`、`seq`、`occurredAt`、`observedAt`、`type` 与 `data`；`seq` 由 Gateway 按 Run 递增，Worker 的原始序号用于去重。
- 保留给 Store 的公共事件为 `RUN_QUEUED`、`RUN_STATUS`、唯一的终止事件（`RUN_COMPLETED`、`RUN_FAILED`、`RUN_CANCELLED`、`RUN_TIMED_OUT`、`RUN_INTERRUPTED`）、`PERMISSION_REQUESTED`、`PERMISSION_DECIDED`、`PERMISSION_APPLIED`、`PERMISSION_EXPIRED` 与 `ARTIFACT_CREATED`；以这些类型追加事件会被 `RESERVED_EVENT_TYPE` 拒绝。
- 其他事件包括 ACP 映射出的 `message.delta`（`stream` 区分输出与思考）、`tool.update`、`engine.status`、`engine.error`，Driver 的 `engine.session`、`engine.capabilities`、`engine.usage`、`permission.unsupported`，Runtime 写入的 `engine.installation`、`runtime.cleanup` 与 `ARTIFACT_MISSING`，以及 `model.call`（共享网关的由守护进程按账本写入，Worker 网关的由 Worker 上报）；Run 终结后到达的事件被丢弃。
- SSE 的 `id` 是 `seq`，`event` 是事件类型，`data` 是完整信封；续读游标取 `afterSeq`，没有时取 `Last-Event-ID`；游标超出已提交范围返回 400 `INVALID_CURSOR`。
- SSE 每批读 100 条，写缓冲满时等待 `drain`，没有新事件时每 25 ms 再查一次；Run 进入终态且已追平时服务器关闭流。客户端断开不取消 Run，重连可能重复投递，按 `runId` 与 `seq` 去重。
- 事件页 `event-log` 每次至多 1000 条，适合有界的 JSON 读取。
- 轨迹导出 `rollout` 按 `seq` 每批 100 条从 SQLite 流式输出 NDJSON（`application/x-ndjson`），可随时从数据库重建，不与数据库双写；对运行中的 Run 只包含当时已提交的事件。
- Gateway 重启后，已完成 Run 的事件仍可重放和导出。
- 控制台的 SSE 以 40 ms 合并刷新显示；断线时按事件游标与持久查询追赶。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [server.ts](../../../packages/daemon/src/http/server.ts)（SSE、事件页与导出路由）、[service.ts](../../../packages/runtime/src/application/service.ts)（`events`、`rollout`）、[sqlite-store.ts](../../../packages/store/src/storage/sqlite-store.ts)（事件序号、保留类型、分页）、[types.ts](../../../packages/core/src/types.ts)（事件信封） |
| 测试 | [gateway.test.ts](../../../tests/integration/gateway.test.ts)、[store.test.ts](../../../tests/integration/store.test.ts)（分页有界与写入代价）、[pressure.test.ts](../../../tests/integration/pressure.test.ts)（暂停读取的 SSE 不阻塞执行）、[rollout.test.ts](../../../tests/smoke/rollout.test.ts) |
| 决策 | [ADR 0002 首条执行链路](../../decisions/0002-runtime-mvp.md) |

## 已知限制与未验证

- SSE 不发保活注释，也没有 `retry` 提示；长时间无事件（例如等待权限）时，中间代理可能断开连接，客户端需重连续读。
- 每个 SSE 连接独立轮询 SQLite，没有每个 Run 或全局的订阅者上限。
- 没有跨 Run 的全局事件流，控制台靠定时轮询发现新的会话与 Run。
- 导出只有事件本身，Run 记录、权限与产物元数据要另外读取对应接口。
- Windows 上的 SSE 与导出未单独验证。

## 优化候选

- **现状**：SSE 不发保活。**方向**：每 15 秒发送 `: ping` 注释，首条消息带 `retry: 3000`。**依据**：[06 第 2.6 节](../../proposals/oss/06-interfaces.md#26-sse-与断点续传)；阅读代码的观察（`server.ts` 的 SSE 循环只写事件）。
- **现状**：控制台每 3 秒轮询会话与历史。**方向**：提供 `GET /api/v1/events?topics=runs,permissions,…` 全局流（全库递增的 `gseq`，同样可续传）。**依据**：[06 第 2.6 节](../../proposals/oss/06-interfaces.md#26-sse-与断点续传)、[控制台说明](../../../packages/console/README.md#页面与状态)。
- **现状**：没有订阅者数量上限。**方向**：每个 Run 64 个、全局 256 个，超出返回 429。**依据**：[05 第 10 节](../../proposals/oss/05-run-plane.md#10-容量回收与数据保留)。
- **现状**：每个 SSE 连接空闲时每 25 ms 查一次数据库。**方向**：事件提交后在进程内通知等待中的订阅者，只在通知或超时后查询。**依据**：阅读代码的观察（`server.ts`）。
- **现状**：生命周期事件名为 `RUN_QUEUED`、`RUN_STATUS` 与五个终止事件。**方向**：统一为 `run.accepted`、`run.status` 与携带状态的 `run.finished`，导出保留旧事件的 `schemaVersion`。**依据**：[05 第 11 节](../../proposals/oss/05-run-plane.md#11-与现状的差异与迁移)。
