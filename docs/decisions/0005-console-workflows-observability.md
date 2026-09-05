# 0005：控制台、自动规划和完整观测

状态：accepted。日期：2026-09-05。

## 范围变化

用户明确要求继续建设可视化控制台、自动拆任务、自动选引擎与观测信息，取代原 MVP 暂不建设这些能力的范围限制。采用 Next.js / React 前端、shadcn/ui、assistant-ui、AI Elements、Streamdown 和 Lucide；原 Gateway/SQLite/Worker 继续拥有执行与持久状态。

## 决定

前端在 pnpm workspace 的独立 web 包中，使用 assistant-ui ExternalStoreRuntime 适配真实后端消息。Next Route Handler 只做同源 loopback 代理，透传 SSE 和下载；浏览器不保存模型密钥，也不直接启动引擎。首版为浅色中文工作台，CSS 过渡和流式渲染遵循 reduced-motion。

WorkflowService 调用已有引擎生成有界 JSON DAG，校验步骤、循环、路径和输出覆盖；不使用固定模板冒充模型规划。规划阶段拒绝观测到的工具调用，不能据此宣称操作系统沙箱。确认前没有步骤 Run，确认后预先绑定各步骤 Session/revision，再串行执行依赖，以避免共享工作区并发冲突。

自动选路使用声明能力、同版本近期正常结束/失败、当前负载和默认偏好。候选得分与选择原因持久保存，不把正常结束当成任务评分，也不声称质量最优；运行失败不会偷偷换引擎重跑。直接自动会话也将选择依据写入安全配置快照。

Workflow 元数据有独立 version 1 表，与现有公共表共享 Gateway 数据库和写入所有者。重启按已提交 Run 对齐，未知执行记 interrupted，不自动重新提交。关闭时先收敛 Workflow，再清理 Runtime，即使一个阶段报错也继续下一阶段释放。

观测投影由持久事件重建。ACP 只在请求 ID 可关联时认作 Run 用量；额外读取 Worker 私有 Pi/OpenCode/DSH 状态并核对后端会话 ID，捕获原生 token、cache、模型和估算费用。累计值、单次值、估算和缺失分开，费用不冒充服务商实际账单。

## 验证与边界

通过正式 Gateway/Worker/SQLite 验证计划、重复审批、失败、取消、版本变化、重启和观测归属，再从真实浏览器提交模型任务，确认计划、产物、刷新和观测一致。具体见 [本轮验收](../verification/2026-09-05-console.md)。

当前仅本机部署，不提供远端多用户权限体系。DAG 先串行执行；全面并行编排、失败自动重试与无损跨引擎上下文迁移仍是独立需求。使用和 API 分别见 [控制台](../../web/README.md)、[Workflow](../workflows.md)与 [观测](../observability.md)。
