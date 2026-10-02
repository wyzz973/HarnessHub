# ADR 0018：编号迁移、模型平面存储与托管秘密

Status: proposed

日期：2026-10-02
关联决定：[开源版 ADR-P06 存储](../proposals/oss/adr-drafts.md#adr-p06-存储)、[0008 Windows 系统密钥存储](0008-windows-secret-storage.md)；设计依据 [07 数据与安全](../proposals/oss/07-data-security.md) 第 2、4 节与 [03 模型平面](../proposals/oss/03-model-plane.md) 第 2、4、8 节

## 问题

模型平面（provider、路由组、Gateway Key、`model.call` 账本、全局接线）需要持久化，provider 凭据需要可轮换的托管秘密。现有 SQLite Store 只认 `user_version` 0 与 1，新表没有升级路径；秘密只有不可变的 `keychain` 引用，Linux 上没有任何托管后端。已有用户数据库必须无损升级，较新的数据库不能被旧程序改动。

## 决定

- 迁移在 `packages/store/src/storage/migrations.ts` 中按编号定义为代码，不放 `.sql` 文件：迁移随编译产物与单可执行文件分发，打开数据库时不需要读文件。校验和是 SQL 文本的 SHA-256，测试固定每条迁移的校验和，改动已发布的迁移会让测试失败。
- `SqliteStore` 打开数据库时应用迁移：每条迁移与 `schema_migrations` 记录、`user_version` 在同一个 `BEGIN IMMEDIATE` 事务中提交，并在事务内重新读取状态。数据库版本高于本构建报 `SCHEMA_TOO_NEW`，已应用迁移的名称或校验和不符报 `MIGRATION_TAMPERED`，两者都在修改前拒绝。`user_version` 保持等于最高版本，使迁移框架之前的旧程序同样拒绝新数据库。
- 迁移框架之前创建的 `user_version = 1` 数据库直接登记为版本 1（核对五张表存在），不重建表，随后按普通迁移升级。
- 模型平面的表与运行时表放在同一个数据库文件中，由 `SqliteModelPlaneStore` 另开连接访问，要求本进程拥有 Gateway。这样只有一个迁移序列、一个所有权锁和一个备份单位，账本也能与 Session、Run 关联；代价是账本与事件共享 SQLite 的单写者。
- 托管秘密使用 `{kind: "store", value: <UUID>}` 引用，沿用 `SecretReference` 的 `{kind, value}` 形状（07 第 4.3 节写作 `{kind, id}`，改形状会影响全部现有调用方）。每个秘密在 `<dataDir>/secrets/v1/<id>.json` 有一个原子替换的条目文件，记录所用后端：加密文件后端的条目内含密文；macOS 钥匙串与 Windows DPAPI 后端的条目指向辅助程序中的不可变条目，轮换时新建条目再切换，因此原生辅助程序无需新增“更新”操作，引用 ID 也保持不变。
- `auto` 后端在 macOS 选钥匙串、在 Windows 选 DPAPI、在其他平台选加密文件。指定的原生后端不可用时明确失败，不静默改用加密文件（07 第 4.1 节）。

## 考虑过的替代方案

- 07 第 2.2 节的 `packages/store/migrations/sqlite/NNNN_<name>.sql` 文件：需要额外的文件定位与打包步骤，目前也没有 PostgreSQL 实现需要共享编号；引入 PostgreSQL 时再决定是否改为文件并保留相同的版本与校验和。
- 模型平面使用单独的 SQLite 文件：可以隔离账本写入，但需要第二套迁移、所有权与备份，账本也无法在一个快照中与 Run 对齐。
- 原生后端直接以引用 ID 作为辅助程序条目 ID，轮换时先删后建：删除与新建之间失败会丢失秘密；给辅助程序增加“更新”操作则需要在 Windows 上另行验证。
- 原生后端不可用时自动改用加密文件：会在用户不知情时把秘密从系统密钥库移到文件，违反 07 第 4.1 节。

## 后果

- 迁移前备份（`VACUUM INTO`）、迁移备份保留与空间检查尚未实现；当前的迁移只新建表，不改写已有数据（迁移 3 见 [0020](0020-model-metadata-enrichment.md)）。
- `runtime_metadata`、Workflow 与 Benchmark 的表仍由各自 store 按原方式管理版本，并入编号迁移需要后续迁移。
- 同时首次打开一个全新的数据库文件时，切换到 WAL 模式的 `PRAGMA journal_mode` 可能直接返回 SQLITE_BUSY（SQLite 不为这一步调用忙等待）；这与迁移框架之前的行为相同。已是 WAL 模式的数据库（旧版本创建的都是）同时打开时迁移只应用一次。
- 加密文件后端的主密钥文件只在 POSIX 上校验所有者与权限，Windows 上尚未校验 DACL；`HH_SECRETS_KEY`、`secrets.keyFile` 与 `hh secrets rekey` 尚未实现。
- `SecretReference` 与 `secretReferenceSchema` 已接受 `store`，但 agents 的引擎配置与工具包绑定校验、控制台与 Worker 中的解析尚未支持：在它们改为接受 `store`（守护进程 `/api/v1` 步骤）之前，引擎配置中的 `store` 引用能通过 HTTP schema，却在执行时以 `SECRET_STORE_REQUIRED` 失败。`createSecret` 仍返回 `keychain` 引用。

## 验证要求

- 由迁移框架之前的构建写出的数据库升级后，原有表的定义与每一行都不变，Store 能读出并继续写入；较新版本、被改动或缺失的迁移记录被拒绝且数据库不被修改；并发打开只应用一次迁移。
- 模型平面各类记录的增删改查、Key 吊销与使用时间、账本提交与持久性、分页、聚合（含未定价与 `missing` 用量）以及写失败路径都有真实 SQLite 测试。
- 加密文件后端的往返、轮换、错误主密钥、篡改或调换密文、文件权限都有测试；原生后端的逻辑用辅助程序替身测试，真实钥匙串与 DPAPI 的轮换尚未在真实系统存储上验证。
