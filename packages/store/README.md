# @harnesshub/store

业务存储与 Windows 文件原语。`src/storage/` 是 SQLite Store（事务、幂等、事件序号、公共终态与单实例锁），只有这里可以使用 `node:sqlite`；`src/platform/` 是 Windows 文件 ACL、文件锁与文件会话，供 artifacts 与工具包使用。两者在 OSS-004 第 3 步从 `src/storage`、`src/platform` 原样迁入，模块规则沿用 [开发规范](../../docs/development.md#模块边界) 中 `storage` 与 `platform` 两行；platform 放在这里的理由见 [ADR 0017](../../docs/decisions/0017-package-layout-migration.md)。只依赖 `@harnesshub/core`。

其他代码按文件导入，例如 `@harnesshub/store/storage/sqlite-store`、`@harnesshub/store/platform/windows-acl`。

Windows ACL 辅助程序的源码是 [native/windows-acl.cs](native/windows-acl.cs)，`pnpm build` 在 Windows 上用 .NET Framework C# 编译器经 [native/build-windows-acl.mjs](native/build-windows-acl.mjs) 构建到本包的 `dist/native/harnesshub-acl.exe`，其他平台不构建。运行时路径由 [native-helper.ts](src/platform/native-helper.ts) 的 `aclHelperPath()` 给出，[test/native-helper.test.ts](test/native-helper.test.ts) 检查该路径，在 Windows 上还检查文件存在。

`src/platform` 的 Windows 文件原语经 [process-launcher.ts](src/platform/process-launcher.ts) 中设置的 `ProcessLauncher` 启动 ACL 辅助程序（OSS-010 F08）。它们深藏在 artifacts 与工具包存储的调用链中，没有上下文可以传递，因此每个进程的组合根（`startHub`、工具包命令）在启动时用 `usePlatformLauncher` 设置一次本进程的启动器；未设置时报 `PROCESS_LAUNCHER_NOT_INJECTED`（500），设置另一个启动器会抛出错误。本包不导入 `node:child_process`。
