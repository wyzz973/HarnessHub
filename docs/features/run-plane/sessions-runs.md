# Session 与 Run

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元与集成测试（正式 Gateway、真实 SQLite、编译后的 Worker；引擎为 fake 或本地 ACP 夹具），本机 macOS arm64；真实引擎只有 2026-09-05 比赛期的 macOS 记录；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [运行契约](../../../DESIGN.md#5-run-生命周期与控制契约)、[执行服务与 API](../../runtime-api.md)、[HTTP API 约定](../../api/README.md#幂等流式与生命周期)、[API 参考](../../api/reference.md) |

## 用途

调用方为一个已登记的引擎创建 Session，再向它逐次提交 Run（一段文本任务）。HarnessHub 负责排队、总期限、取消与唯一终态，调用方随时查询或订阅结果；同一 Session 的多轮任务在同一个引擎会话中依次执行，关闭页面或断开连接不会停止执行。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 任务（`/tasks`）→ 新建任务，选择引擎后在输入框提交；停止按钮发出取消；侧栏列出任务历史 |
| 命令行 | 没有提交 Run 的命令；`hh serve --config <文件>` 设置引擎、并发与默认期限，`--engine` 指定新 Session 的默认引擎，`--demo` 启用假引擎 |
| HTTP | `POST /v1/sessions`、`GET /v1/sessions`、`GET /v1/sessions/{id}`、`POST /v1/sessions/{id}/close`、`POST /v1/sessions/{id}/runs`、`GET /v1/runs`、`GET /v1/runs/{id}`、`GET /v1/sessions/{id}/runs`、`POST /v1/runs/{id}/cancel` |

## 已实现的能力

- Session 创建时固定 `engineId`、`profileRevision` 与 `workspaceId`（省略时取默认引擎与默认工作区）；引擎之后被更新、停用或移除，已有 Session 仍用原 revision。
- Run 状态：`queued → starting → running ↔ waiting_permission → finalizing → completed / failed`，停止经 `cancelling` 到 `cancelled / timed_out`，无法证明结果时为 `interrupted`；终态与唯一终止事件在同一 SQLite 事务提交。
- 同一 Session 同时只有一个活动 Run，其余按接收顺序排队；跨 Session 受全局 `maxConcurrency`（默认 4）与每个引擎的 `maxConcurrency`（默认 1）限制。
- 排队上限 `maxQueuedRuns` 是全局的（默认 1000），满时新提交返回 429 `QUEUE_FULL`。
- Run 输入为 `text`（必填，至多 1,048,576 字符）、`timeoutMs`（1–86,400,000）、`outputs`（见 [文件产物](artifacts.md)）、`model`（见 [任务经共享网关](runs-on-gateway.md)）与只限演示引擎的 `fixture`；请求体至多 2 MiB，未知字段被拒绝。
- `Idempotency-Key`（1–200 字符）只在同一 Session 内生效：同 key 同输入返回原 Run 并带 `replayed: true`，同 key 不同输入返回 409 `IDEMPOTENCY_CONFLICT`；队列已满时已有 key 的重放仍返回原 Run。
- 接收成功返回 202、Run 记录与 `Location: /v1/runs/{id}`；202 只表示已持久接收。
- 总期限默认 60 秒（配置文件 `defaultTimeoutMs` 或环境变量 `HARNESSHUB_RUN_TIMEOUT_MS`），从接收起覆盖排队、启动、执行、权限等待与产物采集；到期为 `timed_out`。
- 取消返回 202 与当前记录，重复调用无副作用：排队中的 Run 直接结束；活动 Run 先发协议取消，等待 `cancelGraceMs`（默认 500 ms）后关闭 Worker 并核实进程清理，结果写入 `cleanupStatus`。
- 完成、取消与期限的竞争由 Runtime 串行仲裁，已判定的停止原因不被晚到的后端完成覆盖；Worker 消息按 `runId` 与 `generation` 过滤。
- 关闭 Session 时状态经 `closing` 到 `closed`：取消排队与活动 Run，等终态提交和 Worker 清理后返回，历史仍可查询；之后提交返回 409 `SESSION_CLOSED`。
- ACP 引擎的 Run 被取消、超时或后端失败后，Session 随之关闭（模型失败 `MODEL_UPSTREAM_ERROR`、`ENGINE_NO_OUTPUT` 除外），下一轮要新建 Session；CLI 引擎每轮都回收 Worker。
- SQLite 写入失败后 Runtime 停止接收新执行（503 `UNAVAILABLE`），`/health/ready` 返回 503。
- Run 保存安全的配置快照（配置标识、模型选择、凭证变量名与命令 hash），不保存凭证值或完整 argv。
- 列表接口：`GET /v1/sessions` 与 `GET /v1/runs` 按时间倒序返回 `limit` 条（默认 100，至多 200）；`GET /v1/sessions/{id}/runs` 返回该 Session 最近 200 个 Run。
- `/v1/*` 是旧管理路由：只做回环 Host、同源 Origin 与拒绝跨站的检查，不要求管理令牌或控制台会话（[ADR 0024](../../decisions/0024-embedded-console.md) 决定第 4 条）；控制台的任务页面仍经 `/v1/*` 访问。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [runtime.ts](../../../packages/runtime/src/runtime/runtime.ts)、[service.ts](../../../packages/runtime/src/application/service.ts)、[server.ts](../../../packages/daemon/src/http/server.ts)、[sqlite-store.ts](../../../packages/store/src/storage/sqlite-store.ts)、[schemas.ts](../../../packages/core/src/schemas.ts)、[registry.ts](../../../packages/agents/src/engine/registry.ts)（部署默认值） |
| 测试 | [gateway.test.ts](../../../tests/integration/gateway.test.ts)、[store.test.ts](../../../tests/integration/store.test.ts)、[pressure.test.ts](../../../tests/integration/pressure.test.ts)、[runtime-controls.test.ts](../../../tests/unit/runtime-controls.test.ts)、[http-lifecycle.mjs](../../../examples/http-lifecycle.mjs) |
| 决策 | [ADR 0002 首条执行链路](../../decisions/0002-runtime-mvp.md)、[ADR 0024 控制台内嵌守护进程](../../decisions/0024-embedded-console.md) |

## 已知限制与未验证

- 输入只有文本，没有图像、多模态内容块或上传文件。
- 没有调用方身份：幂等键只按 Session 隔离，`/v1/*` 只适合本机单用户使用。
- 运行中的排队与活动集合只在内存中；重启后未终结的 Run 记 `interrupted`，不会自动重跑。
- 跨引擎续聊不在范围内：换引擎就是新建 Session。
- Windows 上的取消、期限与清理链路未验证；真实引擎的取消与超时只有比赛期记录。

## 优化候选

- **现状**：`/v1/*` 的任务路由只有 Host 与 Origin 检查，控制台的任务页面用另一套客户端（`lib/api.ts`）。**方向**：按同名资源迁到 `/api/v1`，受管理令牌或控制台会话保护，并由 SDK 提供。**依据**：[ADR 0024](../../decisions/0024-embedded-console.md) 决定第 4 条、[06 第 3 节](../../proposals/oss/06-interfaces.md#3-资源与端点清单)末尾的迁移说明。
- **现状**：默认期限 60 秒，普通编码任务很容易超时。**方向**：按设计改为 30 分钟并同步文档。**依据**：[05 第 11 节](../../proposals/oss/05-run-plane.md#11-与现状的差异与迁移)。
- **现状**：没有提交和查看 Run 的 `hh` 命令，只能用 HTTP 或控制台。**方向**：增加 `hh run` 一类的命令，复用同一执行入口。**依据**：[05 第 10 节](../../proposals/oss/05-run-plane.md#10-容量回收与数据保留)提到的 `hh run`；`hh --help` 中没有对应命令。
- **现状**：Worker 退出、IPC 断开等 Host 层失败落到 Run 上时只保留错误码，消息统一为固定文案 “Engine execution failed; inspect the local engine setup”。**方向**：保留脱敏后的具体原因（例如退出码或信号），便于排障。**依据**：阅读代码的观察（`runtime.ts` 中 `execute` 的 catch 分支）。
- **现状**：`GET /v1/sessions` 与 `GET /v1/runs` 先读出全部记录再排序截取。**方向**：在 Store 中按时间分页查询。**依据**：阅读代码的观察（`server.ts`），以及 [运行观测](../../observability.md#api-与统计范围) 中“运行/会话列表仍一次读取全部记录”。
