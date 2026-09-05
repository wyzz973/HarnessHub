# 文档索引

第一次使用从 [项目README](../README.md)和[使用指南](getting-started.md)开始；理解实现先读[架构导览](architecture.md)。架构约束以 [DESIGN.md](../DESIGN.md)为准，任务进度由 [TODO.md](../TODO.md)维护。

## 使用与实现

| 文档 | 内容 |
|---|---|
| [使用指南](getting-started.md) | 新克隆、demo、端口、数据目录、真实引擎与排障 |
| [架构与实现导览](architecture.md) | 模块地图、Run处理链、配置与秘密、持久化与恢复 |
| [API入口](api/README.md) | 共同约定、对象、幂等、流式与维护方法 |
| [逐接口实现参考](api/reference.md) | 40个HTTP操作的输入/输出、调用链、副作用、错误与测试 |
| [OpenAPI](api/openapi.json) | 从正式路由生成的可机读API契约 |
| [控制台](../web/README.md) | 启动、页面状态、组件来源 |
| [运行契约](runtime-api.md) | Gateway配置、Run/Session与执行边界 |
| [工作流](workflows.md) | 模型规划、人工确认、选路、依赖执行与失败恢复 |
| [观测](observability.md) | 实际模型、Token、费用来源、时间与证据覆盖 |
| [文件产物](file-artifacts.md) | outputs采集、不可变快照、下载及安全边界 |
| [恢复](session-recovery.md) | checkpoint、backend身份、suspend和重启 |
| [Benchmark](benchmark.md) | attempt、评判器、文件fixture与离线报告 |

## 引擎

| 文档 | 内容 |
|---|---|
| [动态管理](engine-management.md) | 登记、文件+overlay、默认项与历史revision |
| [发现](engine-discovery.md) | 16个已知Harness、标准模板、manifest与安装证据 |
| [独立配置](engine-configuration.md) | Provider/模型/URL、秘密引用、Skills、MCP、配置检查 |
| [CLI Driver](cli-driver.md) | stdin/argv、文本输出、退出、取消与进程清理 |
| [安装快照](engine-installation.md) | 文件hash与版本元数据的只读采集 |
| [Pi](pi-engine.md) | 固定Adapter、已验证本机配置与限制 |
| [OpenCode独立配置](opencode-engine.md) | 指定DeepSeek配置与文件任务证据 |
| [OpenClaw Bridge](openclaw-engine.md) | 独立原生会话命名、连接与限制 |
| [macOS本机引擎](macos-engines.md) | 开发机的历史接入方式，不是新克隆配置文件 |
| [Windows/VMware](vmware-validation.md) | 尚待原生验证的项目与操作清单 |

## 开发与发布

- [AGENTS.md](../AGENTS.md)：人与Agent共同遵循的短规则。
- [开发规范](development.md)：类型、模块边界、错误、资源、兼容和Git。
- [测试要求](testing.md)：变更矩阵、实际入口与完成定义。
- [文档规范](documentation.md)：归属、示例、链接与生成文档检查。
- [贡献指南](../CONTRIBUTING.md)：新开发者工作流与发布检查。
- [第三方来源与许可](../THIRD_PARTY_NOTICES.md)：组件、依赖与许可证状态。
- [决策记录](decisions/README.md)：架构选择及其理由。

## 验收与历史资料

以下记录只证明其注明的版本、机器和场景。`.tmp/.tools/data`路径是开发机的忽略目录，通常不随克隆提供；不要据此认为本机证据可在其他平台自动重现。

| 记录 | 范围 |
|---|---|
| [开发规则](verification/2026-09-05-development-rules.md) | 文档/规则检查的初始建立 |
| [执行服务](verification/2026-09-05-runtime-mvp.md) | 持久执行、取消、权限、事件和导出 |
| [Mac引擎](verification/2026-09-05-macos-engines.md) | 指定安装与短文本模型任务 |
| [动态引擎](verification/2026-09-05-dynamic-engines.md) | 发现、运行中登记、CLI与Benchmark |
| [文件与恢复](verification/2026-09-05-file-tasks-and-recovery.md) | 文件任务、DSH恢复与OpenClaw marker |
| [控制台](verification/2026-09-05-console.md) | 原生工作台、规划与观测 |
| [主流发现](verification/2026-09-05-mainstream-discovery.md) | Multica/AgentSpace参考、发现与启动配方 |
| [引擎配置](verification/2026-09-05-engine-configuration.md) | Keychain、独立配置、Skills/MCP与浏览器 |
| [GitHub 文档交付](verification/2026-09-05-github-documentation.md) | 使用与架构、40项API、独立目录检查、无Key示例与首次浏览器体验 |

研究输入：[原始架构提案](<../HarnessHub 多 Agent 引擎可替换架构设计.md>)、[固定源码阅读记录](<../HarnessHub 源码阅读与技术选型讨论稿.md>)。它们保留历史推演，若与现行DESIGN或API实现冲突，以当前规范与实现为准。
