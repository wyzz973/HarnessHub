# 调研方法、证据与范围

阅读日期：2026-10-09。研究使用协议维护方、厂商官方文档、作者原始出版物与固定 commit 的仓库。搜索结果只用于定位，结论来自实际打开的页面与选读源码。

## 1. 已完成的研究

- [协议层次与版本](protocols.md)：ACP、MCP、A2A、AG-UI、原生 API、JSON-RPC、HTTP/SSE、OpenAPI 与 JSON Schema。
- [实现比较](repositories.md)：16 个仓库的 commit/许可元数据；其中关键客户端、聚合网关、原生 Harness 和恢复实现选读源码。加上本机检测专题新增选读文件，固定文件与 SHA-256 共 68 份，见 [来源锁](source-lock.json)。
- [第一链路调研：Multica、多 Harness 统一界面产品与 Hermes / dsh 的 ACP 接入](first-chain-products-2026-10-11.md)（2026-10-11）：Multica 的发现、启动、恢复、审批、事件与错误分类；Zed、JetBrains、Toad、AionUi、Vibe Kanban、Happy 的第一链路做法；Hermes 与 dsh 的官方 ACP 面；按影响排序的 10 条差距。源码链接固定到 commit。
- [检测与适配配方](harness-discovery.md)：Magpie、sandbox-agent、acpx、OpenHands 的安装线索、可执行解析、适配器与后端职责。
- [发现与适配扩展提案](../proposals/harness-discovery-adaptation.md)：本轮核对 CC Switch v4.0.5、Magpie 最新主分支和 42 条 ACP 候选目录；追加固定 82 份材料及选读范围见[本轮来源清单](harness-expansion-sources-2026-10-09.json)，与上面的基线来源锁分别保存。
- [九个 Harness 的扩展能力配置](native-extension-configs-2026-10-18.md)（2026-10-18）：技能、MCP、指令文件、插件、子 Agent、自定义命令与 Hooks 在本机版本中的用户级位置、格式、官方命令、密钥写法与写入风险，以及与旧版 Library 假设的冲突。
- [跨 Agent 统一管理能力的开源做法](capability-managers-2026-10-18.md)（2026-10-18）：技能、MCP、指令、子 Agent、命令、Hooks 与插件的管理器（vercel-labs/skills、cc-switch、magpie、rulesync、skillshare 等）的数据模型、写入与归属、更新检测、密钥处理与事故，以及对 HarnessHub 的启发。
- 公开文档定位、DDD 原则、存储、进程监督、AI 协作与测试实践。

来源锁表示抓取快照与选读范围，不表示全部源码审计。完整外部内容仅在被忽略的 .research-cache 中用于研究，不作为项目代码或依赖发布。曾抓取的 Codex v2.rs 路径已经拆分，404 记录保留并指向实际的 v2/mod.rs、thread.rs、turn.rs，不假称旧路径仍存在。

## 2. 直接影响本项目的结论

1. ACP 是本地编码 Harness 控制面的优先候选；其稳定 wire version 为 1，v2 为显式草案入口。SDK 包版本不等于 wire version，HTTP transport 也不能按成熟稳定能力推断。
2. MCP 提供工具/资源接入；2026-07-28 的无状态模型与 2025-11-25 的有状态生命周期有实质区别。必须按后端实际版本测试，不能混用两套回调、握手和取消逻辑。
3. A2A 适合独立远程 Agent 的发现、任务与协作；AG-UI 适合用户交互事件。它们都不自动解决本地进程监督或跨 Harness 内部状态迁移。
4. Codex、OpenCode、Claude SDK、Pi 的接受、结束、取消与权限语义不同，必须通过防腐层收敛证据，不能用同一“成功响应”规则硬套。
5. 自动恢复并重放最近历史是部分项目的产品选择，不适合作为未知副作用的默认恢复策略；本项目需要显式 continuity 等级和恢复证据。
6. 没有一个所读协议承诺任意 Harness 的内部状态可以无损互换，或能自动识别质量最优执行者。公共 Session、交接与路由证据属于网关核心领域。

## 3. 尚未获得的证据

没有安装/运行这些新快照的 Harness，没有真实 Provider 调用，没有真实 A→B→A 接续，没有原生 Windows、压力或故障注入结果。候选适配与语言/依赖取舍仍需受控验证。调研完成不等于开发门禁全部通过。

## 4. 原始方法参考

- [DDD Bounded Context](https://martinfowler.com/bliki/BoundedContext.html)、[Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html)：业务语言与一致性边界。
- [Microsoft DDD 分层](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/ddd-oriented-microservice)：领域规则与应用编排职责。
- [AGENTS.md](https://agents.md/)、[Agent Skills](https://agentskills.io/specification)、[Spec Kit](https://github.com/github/spec-kit)：工程上下文、能力打包和规格先行工作流参考，不等于通用质量认证。
- [fast-check 的竞态测试](https://fast-check.dev/docs/advanced/race-conditions/)、[测试金字塔](https://martinfowler.com/articles/practical-test-pyramid.html)：状态模型、受控调度与多层验证。

本项目的领域划分、协议选择和状态机是基于这些材料的设计推导，不是来源已经替本项目证明的事实。
