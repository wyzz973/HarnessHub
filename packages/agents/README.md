# @harnesshub/agents

Agent 平面：引擎目录与动态管理（[engine/](src/engine/manager.ts)）、按引擎准备进程级原生配置（[configuration/](src/configuration/prepare.ts)）、本地工具包的导入、绑定与一键应用（[tool-packages/](src/tool-packages/index.ts)）、受管 CLI 工具的 command MCP 服务器（[tool-command/](src/tool-command/command-mcp.ts)），以及统一模型与引擎配置服务（[application/](src/application/harness-model.ts)）。内容在 OSS-004 第 7 步从 `src/engine`、`src/tool-packages`、`src/drivers/tool-command`、`src/drivers/configuration` 的五个文件与 `src/application` 的两个文件迁入；各目录保留原模块的规则（`configuration/` 与 `tool-command/` 按原 `drivers` 模块检查）。依赖 `@harnesshub/core`、`@harnesshub/store`（工具包使用其 Windows 文件原语）与 `@harnesshub/secrets`，第三方依赖为 `ajv` 与 `yaml`。

配置准备不导入模型网关（V1），由调用方经 `PreparationHooks.startModelGateway` 注入。`tool-command/entry.ts` 导出 `COMMAND_MCP_ENTRY`（V9），组合根把它交给工具包管理；同一文件的 `LEGACY_COMMAND_MCP_ENTRY` 是迁移前绑定保存在 SQLite 中的旧位置，准备时映射到当前入口，M1 删除。

仍留在仓库 `scripts/` 的运行时资源（引擎启动器、Pi 扩展）只经 [repository.ts](src/repository.ts) 的 `repositoryScript(name)` 定位（V8），这是本包唯一越出包的 URL，作为带期限的例外登记在 [边界检查](../../tools/check-boundaries.mjs) 中（所有者 OSS-004，随 OSS-013 到期）。command MCP 服务器用 `node:child_process` 执行允许的 CLI 工具，是 `child_process` 例外（所有者 OSS-010 F08，随 OSS-013 到期）。取舍见 [ADR 0017](../../docs/decisions/0017-package-layout-migration.md)。
