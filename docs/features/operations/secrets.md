# 秘密存储

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 已实现 |
| 验证 | 单元测试（加密文件后端的往返、轮换、错误主密钥、篡改与调换密文、文件权限；原生后端用辅助程序替身；辅助程序路径；启动器失败）、macOS 上对真实登录钥匙串的创建与解析单元测试、集成测试（凭据值不出现在任何响应、日志与数据目录文件中；HarnessHub 自身凭据不能作为工具秘密或备份引用；Key 文本不外泄），在 macOS arm64 本机通过；Windows DPAPI 的测试只在 Windows 上运行，未在 Windows 上验证；真实钥匙串与 DPAPI 上的轮换未验证 |
| 对照 Magpie | 有意不同：Key text kept and shown again later（只存哈希）、Library MCP secrets in plain text（只存引用）、Sync secrets in `sync.json`（存密钥库引用）三行；见 [LAN sharing and Gateway Keys](../../magpie-parity.md#lan-sharing-and-gateway-keys) 与 [Backup and sync](../../magpie-parity.md#backup-and-sync) |
| 权威文档 | [secrets 包](../../../packages/secrets/README.md)、[07 第 4 节](../../proposals/oss/07-data-security.md#4-秘密管理)、[ADR 0018](../../decisions/0018-schema-migrations-and-managed-secrets.md)、[ADR 0008](../../decisions/0008-windows-secret-storage.md) |

## 用途

provider 凭据、搜索后端的 Key、同步口令等秘密保存在系统密钥库或加密文件中，配置与数据库只保存引用；Gateway Key 与令牌只保存哈希。API、控制台与日志从不返回或写出秘密值，复制数据目录或备份也拿不到可用的 Key。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 通用显示所用的秘密存储；provider 详情的凭据表添加、轮换与删除凭据（只显示引用与状态） |
| 命令行 | `hh serve --secrets-backend auto\|keychain\|dpapi\|file`；`hh credential add\|rotate\|remove`，值来自隐藏输入、`--from-stdin`、`--from-env` 或 `--from-file` |
| HTTP | `POST /api/v1/providers/{id}/credentials`、`PUT …/{credentialId}/secret`；写入只接收值、返回引用 |

## 已实现的能力

- 后端：`secrets.backend` 为 `auto`、`keychain`、`dpapi` 或 `file`；`auto` 在 macOS 用登录钥匙串、在 Windows 用 DPAPI、在其他平台用加密文件；指定的后端不可用时以 `SECRET_BACKEND_UNAVAILABLE` 失败，不静默改用加密文件。
- 托管秘密是 `{kind: "store", value: <UUID>}` 引用，每个秘密一个条目文件 `<dataDir>/secrets/v1/<id>.json`，先写临时文件、fsync 再改名；轮换在同一引用下替换值，原生后端先建新条目再切换，删除失败的旧条目下次重试。
- 加密文件后端：AES-256-GCM，数据密钥由 `<configDir>/secrets.key`（32 字节随机数，0600，首次使用时生成）经 HKDF-SHA-256 派生；附加认证数据绑定秘密 ID 与版本，挪动、改版本或篡改都无法解密。主密钥在配置根、条目在数据根，只复制数据根拿不到主密钥。
- POSIX 上条目目录须为本用户 0700，条目与主密钥须为本用户 0600 普通文件且不经符号链接打开。
- 其他引用种类：`env`（读守护进程启动时的环境快照）、`file`（私有文件）与旧的 `keychain`（不可变的系统密钥库条目）；macOS 与 Windows 的原生辅助程序由 `pnpm build` 只为当前平台构建。
- 配置文件拒绝秘密值（`CONFIG_SECRET`），需要秘密的设置（如 `otlp.headers`、`network.proxyPassword`）写引用。
- Gateway Key 完整文本只在签发时显示一次，存储中只有秘密部分的 SHA-256，校验时按 Key ID 查找再用常数时间比较；管理令牌、控制台登录码与会话同样只在内存中保存 SHA-256。
- 日志脱敏：诊断日志每行写入前替换已知秘密值、`hhk_` Key 文本、`Bearer` 令牌、`sk-` Key 与 `token=`、`password:` 一类赋值，读出时再脱敏一次；账本、错误消息、CSV 与 OTLP 导出去掉 Key 文本。
- HarnessHub 自身的凭据（provider 凭据、`HH_`/`HARNESSHUB_` 环境变量、数据目录与配置目录中的文件，含管理令牌与 `secrets.key`）不能作为 Library 工具秘密（400 `SECRET_REF_FORBIDDEN`），备份中指向它们的引用也永不恢复。
- 秘密模块的错误只带阶段与文件系统错误码，不带值或路径。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/secrets/src/secret-store.ts](../../../packages/secrets/src/secret-store.ts)、[packages/secrets/src/secrets.ts](../../../packages/secrets/src/secrets.ts)、[packages/secrets/native/keychain.swift](../../../packages/secrets/native/keychain.swift)、[packages/secrets/native/windows-secrets.cs](../../../packages/secrets/native/windows-secrets.cs)、[packages/daemon/src/secret-refs.ts](../../../packages/daemon/src/secret-refs.ts)、[packages/daemon/src/worker/diagnostics.ts](../../../packages/daemon/src/worker/diagnostics.ts)（`createRedactor`）、[packages/core/src/key-text.ts](../../../packages/core/src/key-text.ts) |
| 测试 | [packages/secrets/test/secret-store.test.ts](../../../packages/secrets/test/secret-store.test.ts)、[packages/secrets/test/native-helper.test.ts](../../../packages/secrets/test/native-helper.test.ts)、[packages/secrets/test/launcher-failures.test.ts](../../../packages/secrets/test/launcher-failures.test.ts)、[tests/unit/engine-configuration.test.ts](../../../tests/unit/engine-configuration.test.ts)（真实钥匙串）、[tests/unit/windows-secrets.test.ts](../../../tests/unit/windows-secrets.test.ts)、[tests/integration/secret-refs.test.ts](../../../tests/integration/secret-refs.test.ts)、[tests/integration/key-text-leaks.test.ts](../../../tests/integration/key-text-leaks.test.ts)、[tests/integration/api-v1.test.ts](../../../tests/integration/api-v1.test.ts) |
| 决策 | [ADR 0018 编号迁移、模型平面存储与托管秘密](../../decisions/0018-schema-migrations-and-managed-secrets.md)、[ADR 0008 Windows 系统密钥存储](../../decisions/0008-windows-secret-storage.md) |

## 已知限制与未验证

- Linux 没有 Secret Service 后端，`auto` 在 Linux 上用加密文件；`HH_SECRETS_KEY`、`secrets.keyFile` 与 `hh secrets rekey` 未实现。
- 加密文件后端对同一账户的进程没有保护（它们能读主密钥），系统密钥库对同账户进程的保护同样有限（07 第 4.2 节）。
- Windows 上不校验加密文件后端的 DACL（那里默认用 DPAPI）。
- 引擎配置与工具包绑定仍使用 `keychain` 引用：`store` 引用能通过它们的 HTTP schema，却在 Worker 执行时以 `SECRET_STORE_REQUIRED` 失败；现有 `keychain` 引用尚未迁为 `store`。
- 没有清理无人引用条目的命令（07 第 4.4 节的 `hh credential rm --unreferenced`）。
- 真实钥匙串与 DPAPI 上的轮换、以及 Windows 上的全部行为未验证。

## 优化候选

- **现状**：Linux 桌面上秘密只能放在加密文件中。**方向**：实现 Secret Service 后端（纯 JavaScript D-Bus 客户端，不引入原生模块）。**依据**：[07 第 4.1 节](../../proposals/oss/07-data-security.md#41-后端)。
- **现状**：主密钥只能由首次使用时生成的文件提供，不能更换。**方向**：支持 `secrets.keyFile` 与 `HH_SECRETS_KEY`（容器与 CI）以及 `hh secrets rekey`。**依据**：[07 第 4.2 节](../../proposals/oss/07-data-security.md#42-加密文件后端)、ADR 0018“后果”。
- **现状**：执行平面的引擎配置不接受 `store` 引用，两套引用并存。**方向**：引擎配置、工具包与 Worker 改为接受 `store`，并把 `keychain` 引用迁为指向同一辅助程序条目的 `store` 条目。**依据**：[secrets 包](../../../packages/secrets/README.md)末段、ADR 0018“后果”。
- **现状**：没有列出或清理无人引用的托管秘密条目的命令。**方向**：只针对本数据根中登记、已无人引用的条目提供清理命令，从不枚举系统密钥库中不属于本数据根的条目。**依据**：[07 第 4.4 节](../../proposals/oss/07-data-security.md#44-轮换)。
