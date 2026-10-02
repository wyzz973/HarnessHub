# @harnesshub/drivers

Worker 内的引擎驱动：[driver.ts](src/driver.ts) 定义驱动接口，[ACP 驱动](src/acp/driver.ts) 经 acpx 与 ACP 引擎会话，[CLI 驱动](src/cli/driver.ts) 每个 Run 启动一次命令行引擎，[假驱动](src/fake/driver.ts) 供测试与演示。内容即原 `src/drivers` 的这四部分，在 OSS-004 第 6 步迁入，目录不变；模块规则沿用 [开发规范](../../docs/development.md#模块边界) 中 `worker`/`drivers` 一行。只依赖 `@harnesshub/core`，第三方依赖 `acpx`（含根目录 `patches/` 中的补丁）只能在 `src/acp` 中使用；驱动不导入配置准备与 secrets，所需的 `RuntimeMcpServer` 类型在 `@harnesshub/core/runtime-mcp`。

驱动只在 Worker 进程内加载：守护进程中只有 `worker/` 可以导入本包，由 [边界检查](../../tools/check-boundaries.mjs) 执行。CLI 驱动用 `node:child_process` 启动引擎，是带期限的例外（所有者 OSS-010 F08，随 OSS-013 到期）。
