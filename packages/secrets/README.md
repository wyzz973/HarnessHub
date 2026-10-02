# @harnesshub/secrets

秘密引用的创建、解析与删除：`env` 读取调用方给出的环境快照，`file` 读取私有文件，`keychain` 经系统密钥库保存（macOS 登录钥匙串、Windows DPAPI）。内容即原 `src/drivers/configuration/secrets.ts`，在 OSS-004 第 4 步迁入 [src/secrets.ts](src/secrets.ts)，行为不变；Windows 存储的设计见 [ADR 0008](../../docs/decisions/0008-windows-secret-storage.md)。只依赖 `@harnesshub/core`，按依赖图只有 gateway、agents 与 daemon 可以导入它；迁移期间 `src/` 中按原 `drivers` 模块的规则导入（`@harnesshub/secrets/secrets`）。

系统密钥库由本包的原生辅助程序访问：[native/keychain.swift](native/keychain.swift)（macOS）与 [native/windows-secrets.cs](native/windows-secrets.cs)（Windows）。`pnpm build` 经 [native/build-keychain.mjs](native/build-keychain.mjs) 只构建当前平台的那一个，输出到本包的 `dist/native/harnesshub-keychain` 或 `dist/native/harnesshub-secrets.exe`；其他平台不构建，`keychain` 引用返回 `KEYCHAIN_UNSUPPORTED`。运行时路径由 [native-helper.ts](src/native-helper.ts) 的 `secretHelperPath()` 给出，[test/native-helper.test.ts](test/native-helper.test.ts) 在所有平台检查两个路径，并在对应平台检查文件存在。

辅助程序经调用方传入的 `ProcessLauncher` 启动（OSS-010 F08）：`createSecret(value, launcher)`、`deleteSecret(ref, launcher)` 与 `resolveSecret(ref, environment, launcher?)`。只有 Keychain 引用和 Windows 上的文件引用需要启动器，缺少时报 `PROCESS_LAUNCHER_NOT_INJECTED`（500）；环境变量引用与其他平台上的文件引用不启动进程。守护进程与 Worker 传入本进程的启动器。本包不导入 `node:child_process`。
