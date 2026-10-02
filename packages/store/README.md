# @harnesshub/store

业务存储与 Windows 文件原语。`src/storage/` 是 SQLite Store（事务、幂等、事件序号、公共终态与单实例锁），只有这里可以使用 `node:sqlite`；`src/platform/` 是 Windows 文件 ACL、文件锁与文件会话，供 artifacts 与工具包使用。两者在 OSS-004 第 3 步从 `src/storage`、`src/platform` 原样迁入，模块规则沿用 [开发规范](../../docs/development.md#模块边界) 中 `storage` 与 `platform` 两行；platform 放在这里的理由见 [ADR 0017](../../docs/decisions/0017-package-layout-migration.md)。只依赖 `@harnesshub/core`。

其他代码按文件导入，例如 `@harnesshub/store/storage/sqlite-store`、`@harnesshub/store/platform/windows-acl`。

Windows ACL 辅助程序的源码是 [native/windows-acl.cs](native/windows-acl.cs)，`pnpm build` 在 Windows 上用 .NET Framework C# 编译器经 [native/build-windows-acl.mjs](native/build-windows-acl.mjs) 构建到本包的 `dist/native/harnesshub-acl.exe`，其他平台不构建。运行时路径由 [native-helper.ts](src/platform/native-helper.ts) 的 `aclHelperPath()` 给出，[test/native-helper.test.ts](test/native-helper.test.ts) 检查该路径，在 Windows 上还检查文件存在。

`src/platform` 中启动辅助程序的 `node:child_process` 调用是带期限的例外：所有者 OSS-010 F08，在 M0 退出（OSS-013 完成）时到期，届时改由 runtime 的 `ProcessLauncher` 启动。例外登记在 [边界检查](../../tools/check-boundaries.mjs) 的 `CHILD_PROCESS_EXCEPTIONS` 中，`TODO.md` 中 OSS-013 勾选后检查即失败。
