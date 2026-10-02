# HarnessHub 开源版设计提案

状态：2026-10-02 由所有者确认关键决定，作为开源版的设计依据；现有仓库的现行架构仍以下面链接的 DESIGN.md 为准，新 `main` 建立后迁入其 DESIGN.md 与 ADR。本目录描述把 HarnessHub 转型为对标 [Magpie](https://github.com/yetone/magpie) 的开源产品时的完整设计；现行架构仍以 [DESIGN.md](../../../DESIGN.md) 为准。比赛、公司网关、统一单模型与特定平台的约束不再适用。

## 一句话

开源的编码 Agent 控制平面：在一个地方决定每个 Agent 用什么模型、带什么工具，并用一套 API 无人值守地运行、比较这些 Agent，每一次模型调用都可以追溯。详见 [01 产品定义](01-product.md)。

## 阅读顺序

| 文档 | 回答的问题 |
|---|---|
| [01 产品定义](01-product.md) | 为什么做、为谁做、与 Magpie 逐项对比、版本范围、成功指标 |
| [02 系统架构](02-architecture.md) | 术语、三个平面、进程模型、部署形态、技术选型、模块依赖、关键时序 |
| [03 模型平面](03-model-plane.md) | 多协议网关、Gateway Key、IR 转换、provider、路由与重试、目录、账本、能力体检 |
| [04 Agent 平面](04-agent-plane.md) | Adapter、发现、全局接线与隔离接线、漂移检测、Profile、Library、一致性测试 |
| [05 执行平面](05-run-plane.md) | Session/Run、工作区、结果判定、权限、沙箱、并行比较、评测、MCP Server |
| [06 接口与交互面](06-interfaces.md) | 端口与路径、REST 规范与端点、SDK、CLI、控制台、托盘、导入链接 |
| [07 数据与安全](07-data-security.md) | 数据目录、存储与迁移、备份、秘密、认证授权、威胁模型、隐私 |
| [08 可靠性与可观测性](08-reliability-observability.md) | SLO、性能预算、降级、崩溃恢复、追踪、指标、日志、诊断 |
| [09 扩展](09-extensibility.md) | 扩展点、插件协议、权限、签名分发、SDK、兼容策略 |
| [10 工程体系](10-engineering.md) | 仓库结构、代码规范、测试与一致性套件、CI 门禁、发布、文档站、供应链 |
| [11 开源治理与社区](11-governance.md) | 许可证、贡献流程、治理、行为准则、安全响应、社区运营 |
| [12 路线图与迁移](12-roadmap-migration.md) | 现有模块去留、里程碑、先行修复、风险、团队、开源前检查 |
| [ADR 草案](adr-drafts.md) | 需要拍板的 12 个关键决定 |

## 已确认的决定（2026-10-02）

1. 权属：现有全部自有代码的权利归所有者 wyzz973（[11 第 1 节](11-governance.md#1-许可证)）。
2. 名称：HarnessHub；正式命令名 `harnesshub`，`hh` 为可选短别名（[11 第 7 节](11-governance.md#7-商标与品牌)）。
3. 许可证：MIT + DCO（ADR-P02）。
4. 仓库：沿用 `wyzz973/HarnessHub`，新的 `main` 从干净快照开始，比赛版历史保留在 `archive/competition` 分支（ADR-P12）。
5. 默认联网行为：遥测、更新检查、模型目录刷新全部默认关闭，首次运行时询问（[07 第 8 节](07-data-security.md#8-隐私与遥测)）。
6. 维护模式：开发与维护全程由 AI 维护者负责，所有者保留否决与最终决定权；不做工时估算，里程碑以验收标准判定完成（[11 第 3 节](11-governance.md#3-治理模型)、[12 第 5 节](12-roadmap-migration.md#5-维护模式与工作方式)）。
7. 其余技术决定按 [ADR](adr-drafts.md) P01、P03–P11 采纳：TypeScript/Node 单可执行文件、共享网关加作用域 Gateway Key、全局与隔离两种接线、有边界的首字节前重试、SQLite 与 PostgreSQL、进程外插件、遥测默认关闭、订阅复用不进核心、内嵌静态控制台、`/api/v1` 兼容承诺。
8. 相对现状有意放宽的三处：协议转换中无法映射的字段改为“丢弃并记录”，只有“不可静默丢弃字段表”中的字段返回 400（[03 第 3 节](03-model-plane.md#3-协议转换)）；Library 可在用户确认后登记来自 MCP Registry 的固定版本 `npx`/`uvx` 服务，离线模式与 CI 中拒绝（[04 第 8 节](04-agent-plane.md#8-library)）；默认 Run 期限从 60 秒改为 30 分钟（[05 执行平面](05-run-plane.md)）。

## 依据

本提案依据三类材料：2026-10-02 对 `yetone/magpie@d874adb` 源码与 1066 个提交的阅读；同日完成的 Magpie 与 HarnessHub 逐模块对比及 86 个问题簇的核验（其中 64 个在本地复现）；HarnessHub 现有代码、[决策记录](../../decisions/README.md) 与验收记录。同类开源产品格局见 [01 产品定义](01-product.md#8-同类产品格局)。
