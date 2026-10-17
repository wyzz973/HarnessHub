# 总体架构建议

状态：proposed，未建立应用源码。范围是本机模块化单体加隔离的后端进程，不预建分布式调度或微服务。

## 1. 正式调用链

界面/CLI/SDK → 认证与校验 → Interaction 应用入口 → Session 意图/outbox → Selection 与 Continuity → Execution → Harness Adapter → 后端进程。

后端模型请求 → Model Access → Provider；后端事件/权限/结果 → Adapter 归一化 → Execution 持久事实 → Interaction 公共事件与查询 → 客户端。工具编排仍由 Harness 负责，只有明确通过 Client/MCP 边界的工具才由对应端口提供。

## 2. 分层

每个上下文包含 domain、application 和 ports，infrastructure 实现端口。组合根注入具体 Store、Clock、ProcessHost、Adapter、ModelTransport 与策略。领域层不依赖 HTTP、SQLite、Node 进程 API 或第三方 SDK。

候选目录：src/contexts/{interaction,catalog,selection,execution,continuity,model-access,access-policy}，src/adapters/{acp,codex,opencode}，src/infrastructure/{storage,process,http}，src/bootstrap。它们是后续任务所有权位置，不表示当前已有包或可运行命令。

优先保持单仓库、单运行服务与少量发布单元。边界由依赖规则和测试执行，不能仅靠“每个目录一层”的形式感。

## 3. 技术栈比较

| 候选 | 优势 | 当前代价 | 建议 |
|---|---|---|---|
| TypeScript/Node LTS | 官方 ACP、Codex/Claude 生态、schema 和客户端类型联动 | 进程树与平台能力需原生辅助；需测量 SQLite 阻塞和流内存 | 首选候选，strict/ESM；具体 Node patch、HTTP/SQLite 库经验证后锁定 |
| Go | 单二进制、网络和并发工具成熟 | SDK 类型/生态适配成本，另写协议层较多 | 备选，不能仅因打包方便替代领域设计 |
| Rust | 强类型、资源管理、native/网关参考多 | 首版维护与跨平台构建复杂度 | 保留 native helper/后续性能选择，不提前引入第二业务服务 |
| Python | 调研/评测与部分 SDK 生态方便 | 分发、静态契约与跨客户端联动需更多约束 | 研究/检查工具可用，不默认作为业务服务 |

本阶段没有安装或锁定应用依赖。源码快照不等于发行版已验证；运行任务不能临时下载 latest。

## 4. 数据与进程

首选 SQLite 作为本机权威存储候选，编号迁移、事务/outbox、owner lease。Actor/Worker 不写公共业务库。JSONL 和遥测由事实导出，不能形成第二个事实源。

ProcessHost 负责 argv、显式环境、私有目录、归属 token、进程树、升级终止与关闭等待。不同 Harness 的原生绑定可以保留多个，但同一公共 Session 只有一个执行权。保留空闲绑定须有资源限额和已验证恢复策略。

当前只面向 macOS（[ADR-044](../decisions/0044-macos-official-channels.md)）：POSIX 进程组和脱离组的后代在 macOS 上设计验证；已有的 Windows 分支代码保留但不扩展、不再验证。外部服务启动的进程、失去归属标记的后代和同用户旁路属于显式能力边界。

## 5. 模型路径

首版支持显式 Provider/模型引用、可兼容协议转发、执行身份和账本。完整多协议网关可作为独立能力扩展；领域不依赖它的一切高级路由功能。

受管理模型模式下只交付所属执行的 scoped endpoint/token。配置与账本提供路径证据，不自动证明 OS 层无旁路；需要强制网络约束的任务必须选有验证能力的环境，否则拒绝。
