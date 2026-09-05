# 计划、自动选路与步骤执行

Workflow 把用户目标变成可审核的步骤，再调用已有 Session/Run 入口执行。它保存规划 Run、依赖关系、引擎选择理由、步骤 Run 与产物关联，不建立第二套执行状态机。设计决定见 [设计基线](../DESIGN.md)，Run、权限和产物接口见 [运行 API](runtime-api.md)。

## 使用流程

1. `POST /v1/workflows` 提交目标；返回 `202` 和 `planning` 记录。可传 `Idempotency-Key`，同 key 的重复请求返回原计划，不再调用模型。
2. 规划器作为一个真实 Run 运行，完成后只接受 JSON 计划。前端可以通过 `planningRunId` 观察现有 SSE，轮询计划详情直到 `draft`。
3. 用户审核目标、步骤、依赖、产物路径、时限及选择的引擎，再调用 `POST /v1/workflows/:id/approve`。审批前不会提交步骤 Run。
4. 每一步使用独立 Session，按依赖拓扑顺序串行执行。前置结果和已登记 Artifact 元数据作为结构化上下文传给后续步骤，文件位于同一已登记 Workspace。
5. 权限请求仍由既有 `/v1/permissions/:id/decision` 处理。批准计划不会自动批准工具权限。

例如：

```sh
curl -s http://127.0.0.1:3180/v1/workflows \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: report-demo-1' \
  -d '{"goal":"分析当前工作目录里的示例数据，写出 summary.json 和说明文档","engineId":"auto","timeoutMs":90000}'
```

上例仅调用已登记的默认规划引擎。实际 Workspace 由启动配置的 `defaultWorkspace` 决定，也可显式传 `workspaceId`。没有可用引擎时明确拒绝，不安装引擎、不临时切模型。

## API 与记录

| 路径 | 行为 |
|---|---|
| `POST /v1/workflows` | 接收 `goal`、可选 `workspaceId`、`engineId`、`plannerEngineId` 和规划 `timeoutMs` |
| `GET /v1/workflows` | 返回 `{ workflows: [...] }`，按创建顺序倒序 |
| `GET /v1/workflows/:id` | 返回持久计划、状态、步骤和选路记录 |
| `POST /v1/workflows/:id/approve` | 仅审批 draft；同一已批准计划重复审批不重复执行 |
| `POST /v1/workflows/:id/cancel` | 先持久化取消请求，再取消当前 Run；未发步骤不再启动 |

公开状态为 `planning → draft → running → completed`；错误为 `failed`，取消经过 `cancelling → cancelled`，重启未知结果为 `interrupted`。步骤另有 `pending/running/completed/failed/cancelled/blocked/interrupted`。Workflow 的 `completed` 表示所有步骤正常结束且声明文件已被采集，不代表内容通过比赛评分。

请求/schema、领域类型与 JSON 规划校验在 [workflows.ts](../src/domain/workflows.ts)。OpenAPI 从同一 schema 生成。规划 Run 使用 `<workflowId>:planning` 作为 Session 范围幂等键，步骤 Run 使用 `<workflowId>:<stepId>`；身份写入后不能更换。

Workflow 记录存入现有 Gateway 数据库的 `workflows` 表。`workflow_metadata.schema_version=1` 独立管理新增表版本，未知版本拒绝启动，不删除旧业务数据。写入要求当前进程已拥有 Gateway owner；Worker 无权修改计划表。存储实现见 [workflow-store.ts](../src/storage/workflow-store.ts)。

## 自动拆任务

默认调用当前默认引擎做规划，可显式指定 `plannerEngineId`；规划超时默认 90 秒，请求可在 1 秒至 1 小时范围指定。规划目标最多 16,000 字符。

规划输出必须是单个 JSON 对象，或单个完整的 JSON Markdown 代码围栏。根对象为 `{ title, steps }`；每一步包含 `id/title/instructions/dependsOn/outputs`，可选 `requiredCapabilities/timeoutMs`。拒绝多余字段、超过 8 步、重复 ID、自引用、未知依赖、环、越界文件路径、没有依赖却覆盖相同产物路径的步骤。模型输出最多 160,000 字符，每一步指令最多 16,000 字符。默认步骤超时 180 秒，上限 1 小时。

规划提示明确要求只生成计划，禁止工具调用和执行目标。检测到规划工具事件或权限请求时，取消规划 Run 并拒绝该计划。这个检测发生在引擎上报事件后，**不是操作系统文件沙箱**；ACP 后端自身的工具限制和权限覆盖依旧由对应引擎负责。未返回 JSON、工具使用或规划失败均会保留错误和规划 Run，不退回固定步骤模板，不自动重新规划。

## 自动选引擎

`engineId: "auto"` 根据确定规则选择步骤引擎，并保存全部候选、排除理由、分数和选中 revision：

- 排除已禁用引擎、fake 测试引擎，以及缺少所需配置能力的引擎。
- 自动选择限定已登记 ACP 引擎。通用 CLI 没有可验证的 Agent 协议声明，需显式指定；显式 CLI 同样复用正式 Driver。
- 基础分 10；当前默认引擎加 30。
- 同一 revision 最近最多 20 个终态 Run：每次正常结束加 3；失败、超时或中断减 8；取消不计失败。
- 同一引擎的每个活动或排队 Run 减 20；并列时按引擎 ID 排序。

这是可审查的调度规则，正常结束只是运行稳定性信号，**不代表任务质量最优或价格最低**。成本未知时不凭空估价。能力匹配使用配置声明，不把它当成逐项真实验收结果。

规划完成时确定每一步的候选与选择。审批时再次核对所有选择的配置 revision；发生替换、禁用或移除则返回 `409 WORKFLOW_ENGINE_CHANGED`，要求重新生成并审核计划。审批成功先为全部步骤创建并持久化 Session，从此绑定已批准 revision。之后的热更新不会改变未执行步骤的引擎，也不会在失败后偷偷换引擎或重跑。

## 失败、取消和恢复

每个计划内部串行执行，即使某些步骤没有依赖也不并发写同一目录。第一步失败后停止整个计划，剩余步骤标记 `blocked`；不存在无依据重试、备用模型或质量失败的自动纠错。多个计划和普通 Run 仍受统一 Runtime 的队列、并发与 deadline 约束。

后续步骤收到完整前置文本、Artifact 标识、hash 和声明路径。依赖上下文总计超过 500,000 字符则明确失败，要求计划用简明输出或文件交接，不静默截断。每个声明产物都必须已被 Runtime 采集，否则步骤失败；具体内容质量由独立评判器负责。

关闭 Gateway 时先停止计划接收，取消其当前 Run，等待计划拥有的 Session 清理，再关闭 Runtime 和 SQLite。重启会按持久 Session 和 Run 幂等键核对已接收执行；已完成 Run 可以补齐步骤结果。仍有未知或未完成步骤的活动计划标记 `interrupted`，不会重新发起模型请求或继续未发步骤。历史已完成计划和待审批 draft 保留。

## 验证范围

[集成测试](../tests/integration/workflows.test.ts)从正式 Gateway、真实 SQLite 和构建后的 ACP Worker 出发，用本地确定协议对端替代外部模型，覆盖规划/审批/依赖上下文、重复审批、非法计划、工具规划拒绝、配置替换、失败、取消以及重启对齐。该测试不消费真实模型额度；真实 DSH 与浏览器证据见 [控制台验收](verification/2026-09-05-console.md)。

当前不包含跨机器编排、跨引擎迁移已有会话、计划编辑、失败自动重试和质量驱动搜索。Windows 原生进程与文件语义仍需 VMware 独立验收。
