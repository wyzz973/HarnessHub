# 工程文档与阅读顺序

当前以本机 MVP 切片推进；完整蓝图按各自状态管理。ADR-008/009 与对应检测/控制契约已认可，目录与受控原生控制连接已实现；公共 Session/完整执行/切换契约仍 proposed。

最新推进方式：先读 [MVP 顺序](engineering/mvp.md)与 [S01 检测契约](contracts/discovery.md)。用户明确本机核心优先；后续完整设计仍保留，但不以平台、发布或多发行版矩阵阻塞独立切片。[Harness 检测调研](research/harness-discovery.md)记录当前实现依据。

最新：[目录与控制契约](contracts/catalog-control.md)、[验证记录](verification/catalog-control-2026-10-09.md)；[Harness 发现与适配方案](proposals/harness-discovery-adaptation.md)保留来源与后续顺序。默认目录为 43 个产品/47 个控制入口；目录数量、协议握手和真实任务验证分别记录。

1. [第一阶段产品范围](product/phase-1.md) → [需求清单](product/requirements.md)。
2. [调研方法与结论](research/README.md) → [协议](research/protocols.md) → [开源实现](research/repositories.md) → [固定来源](research/source-lock.json)。
3. [统一语言](domain/language.md) → [限界上下文](domain/context-map.md) → [不变量](domain/invariants.md)。
4. [总体架构](architecture/overview.md) → [公共 API](contracts/public-api.md) → [适配接口](contracts/adapter-spi.md) → [运行生命周期](contracts/lifecycle.md)。
5. [路由](contracts/routing.md) → [上下文](contracts/context-transfer.md) → [切换](contracts/switching.md) → [存储与事件](contracts/storage-events.md) → [安全](contracts/security.md)。
6. [开发规则](engineering/development.md) → [AI 协作](engineering/ai-workflow.md) → [测试要求](engineering/testing.md) → [测试矩阵](engineering/test-matrix.md)。
7. [原子任务](../TASKS.md) → [设计就绪门禁](engineering/readiness.md) → [ADR](decisions/README.md)。

需求、任务和测试场景的唯一结构化来源分别是 plan/requirements.json、plan/tasks.json、plan/test-cases.json；人读表由工程检查工具生成并检查新鲜度。协议或 SDK 版本改变时更新来源与受影响契约，不能只改依赖版本。
