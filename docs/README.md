# 文档索引

本目录记录 HarnessHub 的开发约定、验证要求和决策依据。项目架构以 [DESIGN.md](../DESIGN.md) 为准，任务入口规则在 [AGENTS.md](../AGENTS.md)。

当前开发计划与任务进度由 [TODO.md](../TODO.md)维护。

| 文档 | 查阅内容 |
|---|---|
| [开发规范](development.md) | 类型、模块依赖、并发、迁移、依赖和 Git 协作 |
| [测试与完成要求](testing.md) | 验证矩阵、检查计划、真实链路与平台证据 |
| [文档规范](documentation.md) | 文档归属、JSDoc、示例、链接和状态 |
| [决策记录](decisions/README.md) | 重要决定、替代方案和代价 |
| [验收记录模板](templates/verification.md) | 记录实际命令、产物、版本与未验证项 |
| [运行/API 说明](runtime-api.md) | 已实现服务的启动、接口、配置与能力限制 |
| [macOS引擎接入](macos-engines.md) | 现有CLI和认证引用、已通过的真实文本任务 |

当前有效决策：

- [开发与文档治理](decisions/0001-development-governance.md)：参考 DSH 后采用的规则及裁剪理由。

验收记录：[开发规范与文档检查](verification/2026-09-05-development-rules.md)。记录只证明所列版本和范围，不代表产品整体完成。

执行服务：[首条执行链路验收](verification/2026-09-05-runtime-mvp.md)。

真实引擎：[macOS已安装引擎连接验收](verification/2026-09-05-macos-engines.md)。

新增教程、API 参考、子系统说明和运行手册时，从这里链接实际存在的文档。计划中的文件使用代码文本描述，不创建指向不存在文件的链接。
