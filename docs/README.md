# 工程文档与阅读顺序

当前以本机MVP切片推进；完整蓝图按各自状态管理。ADR-008/009/010/011/012及对应本机契约已认可，目录、控制和公共Session/静止切换已实现；本机Provider和HTTP/工作台按ADR-011实现；完整未来代理账本/自动路由等仍proposed。

最新本机管理与接入：[ADR-017](decisions/0017-native-installation-management.md)、[原安装/配置保护/原对话验收](verification/native-management-2026-10-11.md)。管理原渠道、保护模型与认证配置、保留未知结果；Homebrew升级限制、开发目录与各Harness真实回复分别说明。统一Provider管理后置。

本机原安装与OpenClaw修复：[ADR-016](decisions/0016-local-installation-and-openclaw.md)、[真实DeepSeek与当前对话验收](verification/local-openclaw-2026-10-11.md)。本机原安装优先，私有副本不得冒充本机升级。

最新原生接入：[ADR-015](decisions/0015-native-harness-models-and-switching.md)、[Multica调研](research/multica-native-models.md)、[真实模型与页面验收](verification/native-models-2026-10-11.md)。所有native入口默认沿用本机配置和登录，模型从原生接口读取，选择后直接切换；明确独立Provider仍属于显式覆盖。

最新故障与可用性审查：[ADR-014](decisions/0014-conversation-failure-recovery.md)、[对话恢复契约](contracts/provider-web-mvp.md#可恢复的对话交互adr-014)、[审查与验收](verification/conversation-recovery-2026-10-10.md)。连接失败不锁死对话，真正未知仍保留证据和资源检查；存储v3升级需保留备份。

最新实时对话：[ADR-013](decisions/0013-live-chat-experience.md)、[事实流与交互契约](contracts/provider-web-mvp.md#实时对话事实流adr-013)、[验收](verification/live-chat-2026-10-10.md)。已提交SSE、重连及聊天组件在本机验证；真实Codex使用本地确定性模型服务，云模型与其他Harness组合分别验收。

最新Harness管理与UI重做：[ADR-012](decisions/0012-harness-management-workbench.md)、[管理调研](research/harness-management.md)、[实际验证](verification/harness-management-2026-10-10.md)。本机私有安装、升级与动态图形操作作为新切片，完整自动择优仍后置。

最新工作台：[Provider与本机页面契约](contracts/provider-web-mvp.md)、[调研](research/provider-web.md)、[ADR-011](decisions/0011-provider-web-mvp.md)与[验证](verification/provider-web-2026-10-09.md)。自动择优按用户要求后置。

最新推进方式：先读 [MVP 顺序](engineering/mvp.md)与 [S01 检测契约](contracts/discovery.md)。用户明确本机核心优先；后续完整设计仍保留，但不以平台、发布或多发行版矩阵阻塞独立切片。[Harness 检测调研](research/harness-discovery.md)记录当前实现依据。

最新：[目录与控制契约](contracts/catalog-control.md)、[验证记录](verification/catalog-control-2026-10-09.md)；[Harness 发现与适配方案](proposals/harness-discovery-adaptation.md)保留来源与后续顺序。默认目录为 43 个产品/47 个控制入口；目录数量、协议握手和真实任务验证分别记录。

持续对话从[公共Session契约](contracts/public-session-mvp.md)与[Session验证](verification/public-session-2026-10-09.md)开始阅读：公共身份、SQLite历史、幂等、排队、切换、生效水位、崩溃unknown与CLI资源预算。

1. [第一阶段产品范围](product/phase-1.md) → [需求清单](product/requirements.md)。
2. [调研方法与结论](research/README.md) → [协议](research/protocols.md) → [开源实现](research/repositories.md) → [固定来源](research/source-lock.json)。
3. [统一语言](domain/language.md) → [限界上下文](domain/context-map.md) → [不变量](domain/invariants.md)。
4. [总体架构](architecture/overview.md) → [公共 API](contracts/public-api.md) → [适配接口](contracts/adapter-spi.md) → [运行生命周期](contracts/lifecycle.md)。
5. [路由](contracts/routing.md) → [上下文](contracts/context-transfer.md) → [切换](contracts/switching.md) → [存储与事件](contracts/storage-events.md) → [安全](contracts/security.md)。
6. [开发规则](engineering/development.md) → [AI 协作](engineering/ai-workflow.md) → [测试要求](engineering/testing.md) → [测试矩阵](engineering/test-matrix.md)。
7. [原子任务](../TASKS.md) → [设计就绪门禁](engineering/readiness.md) → [ADR](decisions/README.md)。

需求、任务和测试场景的唯一结构化来源分别是 plan/requirements.json、plan/tasks.json、plan/test-cases.json；人读表由工程检查工具生成并检查新鲜度。协议或 SDK 版本改变时更新来源与受影响契约，不能只改依赖版本。
