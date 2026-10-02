# @harnesshub/store

业务存储与 Windows 文件原语。`src/storage/` 是 SQLite Store（事务、幂等、事件序号、公共终态与单实例锁），只有这里可以使用 `node:sqlite`；`src/platform/` 是 Windows 文件 ACL、文件锁与文件会话，供 artifacts 与工具包使用。两者在 OSS-004 第 3 步从 `src/storage`、`src/platform` 原样迁入，模块规则沿用 [开发规范](../../docs/development.md#模块边界) 中 `storage` 与 `platform` 两行；platform 放在这里的理由见 [ADR 0017](../../docs/decisions/0017-package-layout-migration.md)。只依赖 `@harnesshub/core`。

其他代码按文件导入，例如 `@harnesshub/store/storage/sqlite-store`、`@harnesshub/store/platform/windows-acl`。

## 迁移与模型平面

数据库结构由 [migrations.ts](src/storage/migrations.ts) 中编号的只进迁移定义（[ADR 0018](../../docs/decisions/0018-schema-migrations-and-managed-secrets.md)）。`SqliteStore` 打开数据库时先校验、再逐条应用待执行的迁移：每条迁移与它在 `schema_migrations(version, name, checksum_sha256, applied_at, hh_version, note)` 中的记录、`user_version` 在同一个 `BEGIN IMMEDIATE` 事务中提交，事务内重新读取状态，所以同时打开的连接只会应用一次。已应用迁移的 SHA-256 每次打开都比对，不一致报 `MIGRATION_TAMPERED`；版本高于本构建报 `SCHEMA_TOO_NEW`；两种情况都不修改数据库。已进入用户数据库的迁移不得修改，只能追加新编号。

| 版本 | 名称 | 内容 |
|---|---|---|
| 1 | `runtime_core` | `sessions`、`runs`、`events`、`permissions`、`artifacts`。迁移框架之前的 `user_version = 1` 数据库直接登记为版本 1（`note` 为 `adopted from user_version 1`），表与数据原样保留 |
| 2 | `model_plane` | `providers`、`route_groups`、`gateway_keys`（只存秘密部分的 SHA-256）、`model_calls`（账本，带时间、Key、provider、模型、Session 索引）、`wirings`（`key_id` 引用 `gateway_keys`） |
| 3 | `model_metadata` | `model_overrides`（用户覆盖，键为 `provider/model` 或 `provider/*`）与 `model_provenance`（推导出的模型元数据的来源），都按 `provider` 引用 `providers` 并随其级联删除（[ADR 0020](../../docs/decisions/0020-model-metadata-enrichment.md)） |

`runtime_metadata`、Workflow 与 Benchmark 的表仍由各自的 store 按原有方式创建和管理版本，尚未并入编号迁移。

[model-plane-store.ts](src/storage/model-plane-store.ts) 的 `SqliteModelPlaneStore` 实现 `@harnesshub/core/model-plane` 的 `ModelPlaneStore` 与 `@harnesshub/core/model-metadata` 的 `ModelMetadataStore`（`putProviderMetadata` 在一个事务内写 provider、替换其全部来源记录并修改一个覆盖）。它与 `SqliteStore` 使用同一个数据库文件（守护进程为 `<dataDir>/harnesshub.sqlite`），像 Workflow 与 Benchmark store 一样另开连接，要求数据库已迁移到最新版本、并由本进程取得 Gateway 所有权；关闭顺序在释放所有权之前。记录在写入前与读出后都按 [`@harnesshub/core/model-plane-records`](../core/src/model-plane-records.ts) 校验（`/api/v1` 路由使用同一组校验）；provider 的端点是厂商官方 SDK 使用的基址（chat 与 responses 含 `/v1`，anthropic 与 gemini 不含版本段，由网关追加），`endpointProblem` 拒绝以操作路径（`/chat/completions`、`/responses`、`/messages`、`:generateContent`）或网关会追加的版本段结尾的基址，以及内嵌凭据、查询串、片段和非 HTTPS 地址（回环与 RFC 1918 私网地址可用 HTTP）。03 第 4 节的 `--allow-insecure-http` 尚无对应字段。账本规则：`appendModelCall` 在提交后才 resolve，写失败以 `MODEL_CALL_WRITE_FAILED`（503）拒绝且不留下记录；`listModelCalls` 按 `occurredAt` 新到旧、游标分页（每页至多 1,000 条）；`aggregateUsage` 中状态码不低于 400 记为失败，`costUsd` 只累加已知成本，`cost: null` 计入 `unpricedCalls`，`usage.source` 为 `missing` 的调用按 0 计用量，日期桶为 UTC 日期，缺少分组属性的调用归入键为空字符串的桶。验证见 [model-plane-store.test.ts](../../tests/integration/model-plane-store.test.ts) 与 [store-migrations.test.ts](../../tests/integration/store-migrations.test.ts)。

Windows ACL 辅助程序的源码是 [native/windows-acl.cs](native/windows-acl.cs)，`pnpm build` 在 Windows 上用 .NET Framework C# 编译器经 [native/build-windows-acl.mjs](native/build-windows-acl.mjs) 构建到本包的 `dist/native/harnesshub-acl.exe`，其他平台不构建。运行时路径由 [native-helper.ts](src/platform/native-helper.ts) 的 `aclHelperPath()` 给出，[test/native-helper.test.ts](test/native-helper.test.ts) 检查该路径，在 Windows 上还检查文件存在。

`src/platform` 的 Windows 文件原语经 [process-launcher.ts](src/platform/process-launcher.ts) 中设置的 `ProcessLauncher` 启动 ACL 辅助程序（OSS-010 F08）。它们深藏在 artifacts 与工具包存储的调用链中，没有上下文可以传递，因此每个进程的组合根（`startHub`、工具包命令）在启动时用 `usePlatformLauncher` 设置一次本进程的启动器；未设置时报 `PROCESS_LAUNCHER_NOT_INJECTED`（500），设置另一个启动器会抛出错误。本包不导入 `node:child_process`。
