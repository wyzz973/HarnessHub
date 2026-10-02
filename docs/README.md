# 文档索引

第一次使用从 [项目 README](../README.md) 开始；从源码开发看 [使用指南](getting-started.md)，理解实现先读 [架构导览](architecture.md)。开源版的产品与架构设计见 [开源版设计](proposals/oss/README.md)；现行代码的架构约束以 [DESIGN.md](../DESIGN.md) 为准，开发任务与进度由 [TODO.md](../TODO.md) 维护。

## 开源版设计

| 文档 | 内容 |
|---|---|
| [开源版设计](proposals/oss/README.md) | 对标 Magpie 的产品定义、系统架构、模型/Agent/执行三个平面、接口、数据与安全、可靠性、扩展、工程体系、治理、路线图与 ADR |
| [路线图](../ROADMAP.md) | 里程碑 M0–M5 的主题与验收入口 |
| [多包迁移计划](proposals/oss/13-package-migration.md) | OSS-004：现状依赖、包映射、违例修复、构建方式、迁移步骤与用例清单对账 |
| [SEA 可行性验证](proposals/oss/sea-spike.md) | OSS-008：单可执行文件的做法、实测体积与冷启动、端到端检查、阻塞点与对 ADR-P01 的建议 |

## 使用与实现

| 文档 | 内容 |
|---|---|
| [使用指南](getting-started.md) | 新克隆、端口、数据目录、真实引擎与排障 |
| [架构与实现导览](architecture.md) | 模块地图、Run 处理链、配置与秘密、持久化与恢复 |
| [API 入口](api/README.md) | 共同约定、对象、幂等、流式与维护方法 |
| [逐接口实现参考](api/reference.md) | 全部 HTTP 操作的输入/输出、调用链、副作用、错误与测试 |
| [OpenAPI](api/openapi.json) | 从正式路由生成的可机读 API 契约 |
| [控制台](../web/README.md) | 启动、页面状态、组件来源 |
| [运行契约](runtime-api.md) | Gateway 配置、Run/Session 与执行边界 |
| [工作流](workflows.md) | 模型规划、人工确认、选路、依赖执行与失败恢复 |
| [观测](observability.md) | 实际模型、Token、费用来源、时间与证据覆盖 |
| [文件产物](file-artifacts.md) | outputs 采集、不可变快照、下载及安全边界 |
| [恢复](session-recovery.md) | checkpoint、backend 身份、suspend 和重启 |
| [Benchmark](benchmark.md) | attempt、评判器、文件 fixture 与报告 |

## 引擎与模型

| 文档 | 内容 |
|---|---|
| [动态管理](engine-management.md) | 登记、文件 + overlay、默认项与历史 revision |
| [发现](engine-discovery.md) | 已知 Harness、标准模板、manifest 与安装证据 |
| [独立配置](engine-configuration.md) | 统一模型、Provider/模型/URL、秘密引用、Skills、MCP、配置检查 |
| [统一模型网关](model-gateway.md) | Chat/Responses/Anthropic/Google 协议转换、上游规范化、推理回填、媒体与错误 |
| [统一模型下的引擎接线](model-gateway-engines.md) | 各引擎的私有配置、缺省值与已知限制 |
| [CLI Driver](cli-driver.md) | stdin/argv、文本输出、退出、取消与进程清理 |
| [安装快照](engine-installation.md) | 文件 hash 与版本元数据的只读采集 |
| [Pi](pi-engine.md) | 固定 Adapter、配置与限制 |
| [OpenCode 独立配置](opencode-engine.md) | 指定配置与文件任务证据 |
| [OpenClaw Bridge](openclaw-engine.md) | 独立原生会话命名、连接与限制 |
| [本地工具包](tool-packages.md) | 安装、简易格式导入、SHA-256、Skill/MCP/CLI 绑定与注销 |
| [Capability Pack](capability-packs.md) | 应用层一键安装并应用 Skill、MCP、CLI 与新 Engine revision |
| [原生 MCP](native-mcp.md) | Pi 扩展、OpenClaw 原生配置、Kimi CLI 和秘密限制 |
| [Windows 使用](windows.md) | 原生安装、运行、密钥与能力边界 |

## 开发与治理

- [AGENTS.md](../AGENTS.md)：人与 AI 编码助手共同遵循的短规则。
- [开发规范](development.md)：类型、模块边界、错误、资源、兼容和 Git。
- [测试要求](testing.md)：变更矩阵、实际入口与完成定义。
- [文档规范](documentation.md)：归属、示例、链接与生成文档检查。
- [贡献指南](../CONTRIBUTING.md)、[治理](../GOVERNANCE.md)、[安全策略](../SECURITY.md)、[行为准则](../CODE_OF_CONDUCT.md)。
- [第三方来源与许可](../THIRD_PARTY_NOTICES.md)：并入仓库的第三方代码与许可。
- [决策记录](decisions/README.md)：架构选择及其理由。

## 历史资料

早期单模型版本的验收记录、比赛与离线交付文档、Windows 便携包与预装工具包的设计都保留在 `archive/competition` 分支，不再随开源版维护。ADR 中引用的验收结论以该分支的记录为准。
