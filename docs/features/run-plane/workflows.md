# 先做计划（Workflows）

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 集成测试（正式 Gateway、真实 SQLite 与构建后的 ACP Worker，本地确定协议对端代替模型），本机 macOS arm64；真实 DSH 与浏览器证据只有比赛期记录（归档于 `archive/competition`）；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [计划、自动选路与步骤执行](../../workflows.md)、[ADR 0005](../../decisions/0005-console-workflows-observability.md) |

## 用途

把一个较大的目标先交给模型拆成几步计划，人审核每一步的说明、依赖、产物与选用的引擎，确认后再按依赖顺序执行。计划、选择理由、每一步的 Session 与 Run 都持久保存，便于复查；失败或取消时不会悄悄重试或换引擎。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 任务（`/tasks`）输入框下方把“执行模式”切到“自动规划”；从历史或 `?workflow=` 链接打开计划；默认仍是“直接执行” |
| 命令行 | 无 |
| HTTP | `POST /v1/workflows`（可带 `Idempotency-Key`）、`GET /v1/workflows`、`GET /v1/workflows/{id}`、`POST /v1/workflows/{id}/approve`、`POST /v1/workflows/{id}/cancel`；`POST /v1/sessions/auto` 按同一规则自动选引擎并建 Session |

## 已实现的能力

- 提交 `goal`（至多 16,000 字符）与可选的 `workspaceId`、`engineId`（可为 `auto`）、`plannerEngineId`、规划 `timeoutMs`（1 秒至 1 小时，默认 90 秒），返回 202 与 `planning` 记录；同一幂等键的重复请求返回原计划，不再调用模型。
- 规划器是一次真实 Run（Session 内幂等键 `<workflowId>:planning`），只接受单个 JSON 对象或单个 JSON 代码围栏；至多 8 步，拒绝多余字段、重复 ID、自引用、未知依赖、环、越界路径与没有依赖却覆盖同一产物的步骤。
- 规划提示禁止工具调用；规划 Run 出现工具事件或权限请求时取消该 Run 并拒绝计划（`WORKFLOW_PLANNER_USED_TOOLS`）；没有 JSON 或规划失败时保留错误与规划 Run，不退回固定模板、不自动重新规划。
- 自动选引擎只考虑已登记且启用的 ACP 引擎（排除 fake 与缺少所需能力的引擎）：基础 10 分，默认引擎加 30，同一 revision 最近至多 20 个终态 Run 中正常结束每次加 3、失败超时中断每次减 8，每个活动或排队 Run 减 20，并列按 ID 排序；全部候选、排除理由、分数与选中的 revision 都保存。
- 审批前不提交任何步骤 Run；审批时核对所选 revision，引擎被替换、停用或移除时返回 409 `WORKFLOW_ENGINE_CHANGED`；审批成功先为全部步骤创建并持久化 Session，重复审批不重复执行。
- 步骤按依赖拓扑顺序串行执行，每步独立 Session（幂等键 `<workflowId>:<stepId>`），共享同一个 Workspace；后续步骤收到前置的完整文本、产物 ID、hash 与路径，合计超过 500,000 字符时失败（`WORKFLOW_CONTEXT_TOO_LARGE`）。
- 声明的产物必须被 Runtime 采集，否则该步失败；第一步失败后停止，剩余步骤记 `blocked`。
- 状态 `planning → draft → running → completed`，另有 `failed`、`cancelling → cancelled` 与重启后的 `interrupted`；Workflow 的 `completed` 只表示各步正常结束且产物已采集，不代表内容正确。
- 取消先持久化取消请求再取消当前 Run，未发出的步骤不再启动；关闭守护进程时先停止接收计划并等计划拥有的 Session 清理。
- 重启后按持久的 Session 与幂等键核对：已完成的 Run 补齐步骤结果，仍有未知或未完成步骤的计划记 `interrupted`，不重新请求模型。
- 计划存于同一 SQLite 的 `workflows` 表（`workflow_metadata.schema_version=1`），只有拥有数据库的 Gateway 进程能写。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [workflows.ts（服务）](../../../packages/runtime/src/application/workflows.ts)、[workflows.ts（类型与计划校验）](../../../packages/core/src/workflows.ts)、[workflow-store.ts](../../../packages/store/src/storage/workflow-store.ts)、[workflow-routes.ts](../../../packages/daemon/src/http/workflow-routes.ts)、[server.ts](../../../packages/daemon/src/http/server.ts)（`/v1/sessions/auto`） |
| 测试 | [workflows.test.ts](../../../tests/integration/workflows.test.ts) |
| 决策 | [ADR 0005 控制台、自动规划和完整观测](../../decisions/0005-console-workflows-observability.md) |

## 已知限制与未验证

- 不能在审批前编辑计划；没有失败自动重试、备用模型或质量驱动的搜索；步骤即使互不依赖也串行执行。
- 规划阶段的“禁止工具”在引擎上报事件后才检测，不是文件沙箱；Full Access 下规划 Run 更容易出现工具事件而被拒绝，控制台会提示。
- 自动选引擎只看稳定性与负载，不代表质量最优或价格最低；能力匹配用的是配置声明。
- 规划与步骤 Run 不带 `model`，用 `group/default` 或引擎自己的设置（见 [任务经共享网关](runs-on-gateway.md)）。
- 不支持跨机器编排或把已有会话迁移到别的引擎；Windows 进程与文件语义未验证。

## 优化候选

- **现状**：Workflow 是否保留尚未决定。**方向**：按设计移入 experimental 命名空间、不进入 1.0 API，由 M3 的使用数据决定去留；在此之前不再扩大接口。**依据**：[05 第 11 节](../../proposals/oss/05-run-plane.md#11-与现状的差异与迁移)、[06 第 3 节](../../proposals/oss/06-interfaces.md#3-资源与端点清单)末尾的迁移说明。
- **现状**：计划只能整体通过或重新生成。**方向**：审批前允许修改步骤、产物路径与引擎，修改后重新校验。**依据**：[验证范围](../../workflows.md#验证范围)列出的“计划编辑”未包含。
- **现状**：无依赖的步骤也串行。**方向**：在工作区不冲突（例如各自的 worktree）时并行执行。**依据**：[ADR 0005](../../decisions/0005-console-workflows-observability.md)“DAG 先串行执行”、[05 第 7 节](../../proposals/oss/05-run-plane.md#7-并行运行与比较)。
- **现状**：规划与步骤 Run 无法选择模型，没有 `group/default` 时用量也无法按 Run 归属。**方向**：允许为规划与每一步指定 `model`，并在计划中显示。**依据**：阅读代码的观察（`workflows.ts` 提交 Run 时只有 `text`、`timeoutMs` 与 `outputs`）。
