# 决策记录

ADR 记录重要且未来可能重新讨论的决定。适用范围见 [文档同步要求](../documentation.md#与代码同步)；原有模块已有决策所有者时优先更新，避免重复。

文件使用 `NNNN-short-topic.md`，采用 [ADR 模板](../templates/adr.md)。状态为 `proposed / accepted / superseded / rejected`。`accepted` 不表示功能已经实现或验证；重要验证另存 [验收记录](../templates/verification.md)。

每份记录至少有问题、决定、真正考虑过的替代方案、后果和验证要求。没有考虑过的方案不编造。改为相反决定时新建 ADR 并双向链接；原决定标 superseded，仍保留有价值的理由。

当前记录：

- [0001：开发与文档治理](0001-development-governance.md)
- [0002：执行链路协议与运行限制](0002-runtime-mvp.md)
- [0003：动态引擎目录与通用 CLI 接入](0003-dynamic-engines.md)
- [0004：文件任务、严格恢复与本机接入修复](0004-file-tasks-and-resume.md)
- [0005：控制台、自动规划和完整观测](0005-console-workflows-observability.md)
- [0006：引擎独立配置、密钥引用与便携 Skills](0006-engine-configuration.md)
- [0007：Windows Job Object 进程监督](0007-windows-process-supervision.md)
- [0008：Windows 系统密钥存储](0008-windows-secret-storage.md)
- [0010：ACP 客户端能力与精确权限选择](0010-acpx-client-capabilities.md)
- [0013：统一模型网关](0013-unified-model-gateway.md)（开源版计划在 M1 由共享网关与作用域 Gateway Key 取代）
- [0014：Gateway 与引擎之间的诊断日志](0014-diagnostic-logs.md)
- [0016：POSIX 上脱离 Worker 进程组的后代](0016-posix-escaped-descendants.md)
- [0017：多包布局迁移中的归属与接缝](0017-package-layout-migration.md)（OSS-004）
- [0018：编号迁移、模型平面存储与托管秘密](0018-schema-migrations-and-managed-secrets.md)（proposed）
- [0019：Session Run 使用共享网关](0019-session-runs-on-the-shared-gateway.md)（proposed）
- [0020：模型元数据在写入时补齐并记录来源](0020-model-metadata-enrichment.md)（proposed）
- [0021：局域网共享与级联](0021-gateway-lan-sharing.md)（proposed）
- [0022：Agent 的模型列表、无 Key 接线与接线 Profile](0022-agent-wiring-semantics.md)（proposed）
- [0023：预设的地域与套餐，以及 provider 的导入](0023-provider-presets-and-imports.md)（proposed）
- [0024：控制台内嵌守护进程与控制台会话](0024-embedded-console.md)（proposed）
- [0025：对齐 Magpie 的路由、失败休息与 Codex 透传](0025-magpie-routing-parity.md)（proposed）

编号 0009、0011、0012、0015 是早期版本的 Windows 便携发行、上游网关适配、离线交付与预装工具包决定，随对应功能一起移除，原文保留在 `archive/competition` 分支；编号不再复用。

开源版的关键决定（语言与运行时、许可证、共享网关与作用域 Gateway Key、两种接线模式、路由与重试、存储、插件协议、遥测、订阅复用、控制台、API 版本、仓库与历史）以 [开源版 ADR](../proposals/oss/adr-drafts.md) 的形式记录，已于 2026-10-02 由所有者采纳；实现对应功能时按模板拆成本目录下的独立记录。

Worker、SQLite 和首批引擎三项已采纳决定及依据直接由 [DESIGN.md](../../DESIGN.md#1-已确认的三个决定)拥有，暂不重复创建同内容 ADR。
