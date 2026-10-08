# 工程文档与阅读顺序

当前阶段为研究与设计；以下文档中的方案均为 proposed，除产品需求来源明确标注用户确认外，不等于实现或验收。

1. [第一阶段产品范围](product/phase-1.md) → [需求清单](product/requirements.md)。
2. [调研方法与结论](research/README.md) → [协议](research/protocols.md) → [开源实现](research/repositories.md) → [固定来源](research/source-lock.json)。
3. [统一语言](domain/language.md) → [限界上下文](domain/context-map.md) → [不变量](domain/invariants.md)。
4. [总体架构](architecture/overview.md) → [公共 API](contracts/public-api.md) → [适配接口](contracts/adapter-spi.md) → [运行生命周期](contracts/lifecycle.md)。
5. [路由](contracts/routing.md) → [上下文](contracts/context-transfer.md) → [切换](contracts/switching.md) → [存储与事件](contracts/storage-events.md) → [安全](contracts/security.md)。
6. [开发规则](engineering/development.md) → [AI 协作](engineering/ai-workflow.md) → [测试要求](engineering/testing.md) → [测试矩阵](engineering/test-matrix.md)。
7. [原子任务](../TASKS.md) → [设计就绪门禁](engineering/readiness.md) → [ADR](decisions/README.md)。

需求、任务和测试场景的唯一结构化来源分别是 plan/requirements.json、plan/tasks.json、plan/test-cases.json；人读表由工程检查工具生成并检查新鲜度。协议或 SDK 版本改变时更新来源与受影响契约，不能只改依赖版本。
