# @harnesshub/secrets

秘密引用的创建、解析与删除：`env` 读取调用方给出的环境快照，`file` 读取私有文件，`keychain` 经系统密钥库保存（macOS 登录钥匙串、Windows DPAPI）。内容即原 `src/drivers/configuration/secrets.ts`，在 OSS-004 第 4 步迁入 [src/secrets.ts](src/secrets.ts)，行为不变；Windows 存储的设计见 [ADR 0008](../../docs/decisions/0008-windows-secret-storage.md)。只依赖 `@harnesshub/core`，按依赖图只有 gateway、agents 与 daemon 可以导入它；迁移期间 `src/` 中按原 `drivers` 模块的规则导入（`@harnesshub/secrets/secrets`）。

系统密钥库由本包的原生辅助程序访问：[native/keychain.swift](native/keychain.swift)（macOS）与 [native/windows-secrets.cs](native/windows-secrets.cs)（Windows）。`pnpm build` 经 [native/build-keychain.mjs](native/build-keychain.mjs) 只构建当前平台的那一个，输出到本包的 `dist/native/harnesshub-keychain` 或 `dist/native/harnesshub-secrets.exe`；其他平台不构建，`keychain` 引用返回 `KEYCHAIN_UNSUPPORTED`。运行时路径由 [native-helper.ts](src/native-helper.ts) 的 `secretHelperPath()` 给出，[test/native-helper.test.ts](test/native-helper.test.ts) 在所有平台检查两个路径，并在对应平台检查文件存在。

辅助程序经调用方传入的 `ProcessLauncher` 启动（OSS-010 F08）：`createSecret(value, launcher)`、`deleteSecret(ref, launcher)` 与 `resolveSecret(ref, environment, launcher?)`。只有 Keychain 引用和 Windows 上的文件引用需要启动器，缺少时报 `PROCESS_LAUNCHER_NOT_INJECTED`（500）；环境变量引用与其他平台上的文件引用不启动进程。守护进程与 Worker 传入本进程的启动器。本包不导入 `node:child_process`。

## 托管秘密（`store` 引用）

[secret-store.ts](src/secret-store.ts) 的 `SecretStore` 管理 `{kind: "store", value: <UUID>}` 引用（[07 第 4 节](../../docs/proposals/oss/07-data-security.md#4-秘密管理)，[ADR 0018](../../docs/decisions/0018-schema-migrations-and-managed-secrets.md)）：`create(value)` 返回新引用，`rotate(ref, value)` 在同一引用下替换值，`delete(ref)` 删除，`resolve(ref, environment)` 解析任意种类的引用（非 `store` 引用交给 `resolveSecret`）。`SecretStore.open({dataDir, configDir, backend, launcher})` 选择后端并检查目录。

- 每个秘密有一个条目文件 `<dataDir>/secrets/v1/<id>.json`，写入时先写临时文件、fsync，再改名替换，读者只会看到旧值或新值。条目记录后端：
  - `file`：值以 AES-256-GCM 加密，数据密钥由 `<configDir>/secrets.key`（32 字节随机数的 base64，0600，首次使用时生成）经 HKDF-SHA-256 派生；附加认证数据绑定秘密 ID 与版本，挪到其他条目、改版本号或篡改密文都无法解密；
  - `keychain`（macOS）或 `dpapi`（Windows）：条目指向原生辅助程序中的不可变条目。轮换先新建条目、切换条目文件，再删除旧条目；删除失败时记入 `retired`，下次写入或删除时重试。
- `backend` 默认 `auto`：macOS 用 Keychain，Windows 用 DPAPI，其他平台用加密文件（Linux Secret Service 尚未实现）。指定当前平台不支持的后端、或缺少辅助程序与启动器时报 `SECRET_BACKEND_UNAVAILABLE`，不静默改用加密文件。
- POSIX 上条目目录必须是本用户的 0700 目录（否则 `SECRET_STORE_INSECURE`），条目与主密钥文件必须是本用户的 0600 普通文件且不经符号链接打开，否则按 `SECRET_UNAVAILABLE` 拒绝。Windows 上尚未校验加密文件后端的 DACL，那里的默认后端是 DPAPI。
- 错误只带 `cause.stage`（与文件系统错误码），不带值或路径；同一进程内对同一秘密的写入串行执行。只有守护进程写入数据根。

现有 `keychain` 引用继续由 `resolveSecret` 解析，`createSecret` 与引擎配置路由仍返回 `keychain` 引用；引擎配置的 schema 暂不接受 `store`，因为 Worker 中的解析尚不支持托管秘密。`resolveSecret` 遇到 `store` 引用报 `SECRET_STORE_REQUIRED`（500，组合缺陷），不再把它当作文件路径。把现有 `keychain` 引用迁为 `store` 的方法是为同一个辅助程序条目写一个 `keychain` 后端的条目文件，不需要读出值；该迁移随引擎配置改用 `store` 引用时实现（[12 路线图](../../docs/proposals/oss/12-roadmap-migration.md)）。测试见 [test/secret-store.test.ts](test/secret-store.test.ts)：加密文件后端直接在临时目录中验证，原生后端用内存中的辅助程序替身，不访问真实钥匙串。
