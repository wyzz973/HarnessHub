# 07 数据与安全

状态：提案（草案），2026-10-02。术语、包名、进程与部署形态以 [02 系统架构](02-architecture.md) 为准；网关入口 `127.0.0.1:3180` 与 Gateway Key 作用域以 [ADR-P03](adr-drafts.md#adr-p03-共享网关与作用域-gateway-key) 为准；存储决定见 [ADR-P06](adr-drafts.md#adr-p06-存储)。日志脱敏的实现、诊断包与崩溃恢复见 [08 可靠性与可观测性](08-reliability-observability.md)，插件协议与权限的执行方式见 [09 扩展](09-extensibility.md)。文中的命令名、API 路径与配置键表示所需的能力，最终命名以 [06 接口与交互面](06-interfaces.md) 为准。

依据：现有实现（[秘密引用](../../../src/drivers/configuration/secrets.ts)、[Host/Origin 校验](../../../src/gateway/server.ts)、[SQLite Store](../../../src/storage/sqlite-store.ts)、[ADR 0008](../../decisions/0008-windows-secret-storage.md)、[ADR 0014](../../decisions/0014-diagnostic-logs.md)）；`yetone/magpie@d874adb` 的 `internal/access`、`internal/backup`、`internal/gateway/lan.go`、`internal/plugin`、`internal/stats`；2026-10-02 的 Magpie 与 HarnessHub 对比核验（调研材料，未入库，下文用其问题编号引用，如 V9-N2）。

## 1. 数据目录与文件布局

HarnessHub 把本机文件分成配置、数据、日志、缓存四类根目录，按平台约定定位。守护进程的实例单位是“数据根”：一个数据根同时只允许一个 `hh serve`（见 [02 进程模型](02-architecture.md#5-进程模型)）。设置 `HH_HOME` 或 `hh --home <dir>` 时，四类根目录统一放在该目录下的 `config`、`data`、`logs`、`cache` 子目录；CI、测试隔离和便携使用都走这条路径。

| 类别 | 内容 | Linux | macOS | Windows |
|---|---|---|---|---|
| 配置 | `config.jsonc`（启动参数）、`secrets.key`（仅 file 后端） | `$XDG_CONFIG_HOME/harnesshub`，默认 `~/.config/harnesshub` | `~/Library/Application Support/HarnessHub/config` | `%LOCALAPPDATA%\HarnessHub\config` |
| 数据 | 数据库、锁、Library 与插件对象、产物、Session 私有目录、备份 | `$XDG_DATA_HOME/harnesshub`，默认 `~/.local/share/harnesshub` | `~/Library/Application Support/HarnessHub/data` | `%LOCALAPPDATA%\HarnessHub\data` |
| 日志 | 守护进程、Session、插件诊断日志 | `$XDG_STATE_HOME/harnesshub/logs`，默认 `~/.local/state/harnesshub/logs` | `~/Library/Logs/HarnessHub` | `%LOCALAPPDATA%\HarnessHub\logs` |
| 缓存 | 模型目录更新、插件下载、兼容层运行时，可随时删除 | `$XDG_CACHE_HOME/harnesshub`，默认 `~/.cache/harnesshub` | `~/Library/Caches/HarnessHub` | `%LOCALAPPDATA%\HarnessHub\cache` |
| 容器镜像 | 全部 | `HH_HOME=/var/lib/harnesshub`（挂载卷） | — | — |

平台规则：

- XDG 变量为空或不是绝对路径时，按 XDG Base Directory 规范忽略并使用默认值。macOS 默认不读 XDG 变量，需要 `~/.config` 布局的用户设置 `HH_HOME`。Magpie 在所有平台都使用 `~/.config/magpie`（`internal/settings/settings.go` 的 `Path`），这不符合 macOS 与 Windows 的约定。
- Windows 不使用 `%APPDATA%`（Roaming）。漫游配置在注销时会被另一台机器上的副本覆盖；配置中的 `store` 秘密引用指向本机 LocalAppData 下的 DPAPI 条目（[ADR 0008](../../decisions/0008-windows-secret-storage.md)），换机后也无法解析。
- 配置根与数据根分开：只复制数据根（例如误把它放进同步盘或备份）时，不会同时带走 file 后端的主密钥。

数据根的内容（设计示意，不可直接运行）：

```text
<数据根>/
  hh.lock                     单实例锁，独占打开的 SQLite 文件，进程退出即由内核释放（08 第 4 节）
  owner.json                  提示信息：pid、启动时间、版本、监听地址；不作为所有权依据
  hh.sqlite                   本机 Store（WAL 模式，另有 -wal、-shm）
  admin.token                 本机管理令牌（第 5 节）
  secrets/v1/                 加密文件后端，只在选用 file 后端时存在
  library/objects/<sha256>/   Library 内容寻址对象
  plugins/objects/<sha256>/   已校验的插件包；plugins/<id>/state/ 为插件私有目录
  artifacts/<runId>/          已登记的 Run 产物
  sessions/<sessionId>/       Session 私有 HOME 与隔离接线生成的配置
  workspaces/                 HarnessHub 创建的临时目录与 git worktree 元数据
  backups/migrations/         迁移前数据库备份
  backups/wiring/<adapterId>/ 全局接线的写前备份（04 第 4 节）
  tmp/                        与目标同卷的临时文件，用于原子改名
```

权限要求在守护进程取得单实例锁之前检查，失败即拒绝启动（错误码 `DATA_DIR_INSECURE`），并提示 `hh doctor --fix`：

- POSIX：四个根目录为 0700、文件为 0600，所有者是当前用户；组或其他用户有任何权限都视为不安全。日志根同样适用，因为 debug 日志含提示词摘录。
- Windows：根目录新建时设置受保护的 DACL，只授予当前用户、SYSTEM 与 Administrators 完全控制，复用 [`src/platform/windows-acl.ts`](../../../src/platform/windows-acl.ts) 的 helper。现状只给产物与工具包目录设置 ACL，数据目录完全继承父目录（核验 windows-dacl-datadir），ADR 0014 中“文件 0600”的描述在 Windows 上不成立。已存在的根目录只校验不改写：Everyone、Authenticated Users、Users 或其他非管理员主体有读写权限即判为不安全。`hh doctor --fix` 只对根目录设置可继承 DACL，单次上限 60 s，超时报告失败，不声称部分成功。
- FAT32、exFAT 等不支持 ACL 的卷拒绝作为数据根。Linux 上通过 `statfs` 的文件系统类型识别 NFS 与 CIFS 并拒绝，因为 SQLite 与锁文件依赖的文件锁在网络文件系统上不可靠；macOS 与 Windows 上无法可靠识别，只在 `hh doctor` 中告警。路径含空格与非 ASCII 字符（如中文用户名）的情形在三平台 CI 中各有用例。

## 2. 存储模型与迁移

### 2.1 Store 接口

`store` 包提供一个 `Store` 接口和两个实现：`SqliteStore`（`node:sqlite`，0.1 起）与 `PostgresStore`（1.x）。接口以业务操作为单位（例如接收 Run、提交一批事件、提交一次 `model.call`），每个方法内部是一个事务；SQL 和连接对象不越过 `store` 包，也不引入 ORM（理由见 ADR-P06）。同一套 Store 契约测试在两个后端上运行。

- 事务：SQLite 沿用现有设置，即 WAL、`synchronous=FULL`、`busy_timeout=5000`、写事务使用 `BEGIN IMMEDIATE`（[`sqlite-store.ts`](../../../src/storage/sqlite-store.ts) 第 168–204 行）。PostgreSQL 使用 `READ COMMITTED`，靠唯一约束与显式行锁保证同样的结果。
- 序号：事件以 `(run_id, seq)` 唯一约束保证 Run 内单调，Worker 的 generation 与原始序号用于去重，与 [DESIGN.md 第 6 节](../../../DESIGN.md#6-业务存储与事件) 相同。
- 单写者：两种后端都只有一个守护进程写入。团队服务器 1.x 只支持单个活动实例：启动时取得 PostgreSQL 会话级 advisory lock（键由数据库名和固定命名空间派生），取不到就拒绝启动；第二个实例只能等待接管，不并发写入。多活写入不在 1.x 范围内。
- 业务对象的位置：provider、路由组、Gateway Key、Profile、Library 索引、接线记录都是 Store 中带版本的记录；`config.jsonc` 只保存启动参数（监听、存储后端、秘密后端、日志级别、导出器、遥测同意）。需要以文件形式声明配置时，使用第 3 节的导入导出。

### 2.2 只进不退的版本化迁移

- 迁移文件放在 `packages/store/migrations/sqlite/` 与 `packages/store/migrations/postgres/`，文件名为 `NNNN_<name>.sql`，需要改写数据的迁移使用同编号的 `.ts`。两个目录的编号集合必须一致，由检查脚本强制，并附带编号缺失的无效样例。
- `schema_migrations(version, name, checksum_sha256, applied_at, hh_version)` 记录已应用的迁移。启动时逐条比对：已应用迁移的校验和改变时拒绝启动（`MIGRATION_TAMPERED`）；数据库版本高于本二进制已知的最高版本时拒绝启动（`SCHEMA_TOO_NEW`），提示升级或从备份恢复。
- 每个迁移在一个事务中执行，并在同一事务中写入 `schema_migrations`。PostgreSQL 中不能放进事务的语句（如 `CREATE INDEX CONCURRENTLY`）单独编号、标记为非事务，并且必须可以重复执行。改写大量数据的迁移拆成按游标推进的批次，每批 1,000 行一个事务，崩溃后从游标继续。
- 迁移前备份（SQLite）：有待执行的迁移时，守护进程在持锁状态下先检查可用空间不少于“数据库大小 × 2 + 256 MiB”，再用 `VACUUM INTO` 写出 `backups/migrations/hh-v<旧版本>-<UTC 时间>.sqlite`，`fsync` 后对备份执行 `PRAGMA integrity_check`，结果为 `ok` 才开始迁移。空间不足或备份失败时拒绝迁移，守护进程不进入就绪状态。保留最近 3 份迁移备份。
- PostgreSQL：HarnessHub 不替运维执行 `pg_dump`。存在待执行迁移时守护进程拒绝启动（`MIGRATION_PENDING`），运维先做备份，再执行 `hh migrate up --confirm-backup=<备份标识>`；备份标识写入 `schema_migrations` 的备注列。
- 回滚：不提供 down 迁移。回滚的含义是停止服务、换回旧二进制、用迁移前备份恢复（`hh restore --migration-backup <file>`）。恢复会丢失迁移之后写入的数据，命令在执行前列出受影响的 Run 数量与时间范围，并要求确认。升级失败时的自动回滚条件见 [08 第 4 节](08-reliability-observability.md#4-单实例崩溃恢复与升级)。
- 升级测试：每个已发布版本保留一份真实数据库 fixture（覆盖各类事件、接线记录与 Key），CI 从每个受支持的版本迁移到最新版本，再运行 Store 契约测试，沿用 [开发规范](../../development.md#依赖配置与数据迁移) 的规则。

### 2.3 数据保留

| 数据 | 本机默认 | 团队服务器默认 | 说明 |
|---|---|---|---|
| Session、Run、事件、权限、产物 | 不自动删除 | 365 天，可设 30–3650 天 | `hh gc --runs-older-than <天数>` 手动清理 |
| `model.call` 明细与每次尝试 | 180 天 | 400 天 | 删除前先汇总进按日、provider、模型、Key 作用域的用量表；汇总永久保留，成本历史不随清理丢失 |
| 显式开启的失败调用快照（08 第 7 节） | 7 天 | 7 天 | 默认不采集 |
| 诊断日志 | 按大小轮转 | 按大小轮转 | 见 08 第 7 节 |
| HarnessHub 创建的临时工作区与 worktree | Session 关闭后 24 小时 | 同左 | 用户指定的现有目录从不删除 |
| 全局接线写前备份 | 每个文件的首个原始版本永久保留，其余保留最近 20 份 | 不适用 | 规则由 [04 第 4 节](04-agent-plane.md#4-全局接线) 规定，还原依赖这些备份 |
| 审计日志 | 不适用 | 至少 365 天 | 只能按检查点清理，见 5.5 节 |

清理由守护进程内的保留任务每天执行一次，或由 `hh gc` 触发。每批不超过 1,000 行一个事务，先删派生数据再删源数据，完成后提交 `retention.pruned` 事件（类别、条数、时间范围）。未进入终态的 Run 及其证据不参与清理。清理不能用来“修复”结果未知的数据：这类 Run 按运行契约记为 `interrupted`，不被删除。

## 3. 导出、导入与备份

| 命令 | 用途 | 内容 | 默认含秘密 | 格式 |
|---|---|---|---|---|
| `hh export config` | 把配置带到另一台机器，或分享团队模板 | provider（不含凭据）、路由组、Profile、Adapter 覆盖项、Library 条目与对象、Gateway Key 的名称与作用域（不含 Key）、设置 | 否 | `.hhx`（ZIP） |
| `hh export runs` | 交付或分析运行证据 | 指定 Session/Run 的事件 JSONL、`model.call` 记录、产物清单，可选附带产物文件 | 否，证据中本来就没有秘密 | `.hhx`（ZIP） |
| `hh backup` | 同版本或更新版本上的灾难恢复 | 数据库一致快照、Library 与插件对象、产物、配置；不含系统密钥库中的值 | 否 | `.hhb`（ZIP） |

归档的第一个条目是 `manifest.json`（设计示意，不可直接运行）：

```json
{ "format": "harnesshub-export", "formatVersion": 1, "kind": "config",
  "createdAt": "2026-10-02T08:00:00Z", "producer": { "version": "1.0.0", "commit": "abc1234" },
  "schemaVersion": 42, "includesSecrets": false,
  "needsCredentials": [{ "provider": "deepseek", "slot": "apiKey" }],
  "entries": [{ "path": "config/providers.json", "size": 1234, "sha256": "…" }] }
```

导入规则：

- 先预览后写入。`hh import <file>` 列出将新建、变更、冲突的对象，用户以 `[y/N]` 确认后在一个事务中写入；非交互场景用 `--yes`，与 [06 第 5 节](06-interfaces.md#5-cli) 的确认约定一致。按对象 ID 冲突时默认跳过并报告，`--replace` 才覆盖。
- 逐条目校验 `size` 与 `sha256`；拒绝绝对路径、`..`、符号链接、重复条目和清单外的条目；单条目上限 512 MiB，总量上限 8 GiB，条目数上限 100,000，压缩比上限 100:1。
- 旧版本导出的记录经与数据库迁移同源的记录升级函数转换；`formatVersion` 或 `schemaVersion` 高于本程序时拒绝导入。
- 导入后报告 `needsCredentials`，用户用 `hh provider set-key` 补齐，与 Magpie 恢复时逐项报告 applied/skipped 的做法一致（`internal/backup/backup.go` 的 `Restore`）。
- 导入从不自动执行全局接线，因为那会改写用户的 Agent 配置；需要时用 `hh use` 走预览流程。Gateway Key 不导出，导入后重新签发。
- 比赛版的 `src/logging/zip.ts`（已随 Collect-Logs 移除）在内存中构建 ZIP 且不支持 ZIP64，不能直接复用；导出需要流式写入与 ZIP64。

`hh backup` 用 `VACUUM INTO` 取得运行中数据库的一致快照。`hh restore` 要求守护进程已停止并由它自己取得单实例锁；目标数据根非空时，先把现有内容移到 `backups/pre-restore-<时间>/` 再恢复；恢复后按第 2.2 节执行迁移（含迁移前备份）。团队服务器使用 PostgreSQL 时 `hh backup` 只导出对象与配置（`--objects-only`），数据库由运维用 PostgreSQL 工具备份。

### 3.1 秘密与口令加密

- 默认不含秘密。`--include-secrets` 必须与 `--encrypt` 同时使用，否则拒绝执行。加密作用于整个归档，清单也在密文内，不泄露对象名称。
- 加密格式采用 [age v1](https://age-encryption.org/v1) 的口令（scrypt）接收者，参数遵循该规范：每个文件随机生成 128 位文件密钥；口令经 scrypt 派生包装密钥，工作因子 log2(N)=18、r=8、p=1，盐 16 字节；载荷密钥由 HKDF-SHA-256 派生；载荷以 64 KiB 分块，用 ChaCha20-Poly1305 按 STREAM 结构加密，末块带结束标记；文件头由 HMAC-SHA-256 认证。解密时拒绝 log2(N) 大于 22 的文件，限制恶意文件造成的内存与时间消耗。
- 选择理由与替代方案：age 是公开规范，有多种独立实现，用户不依赖 HarnessHub 也能用 `age -d` 解开自己的备份，分块认证允许流式解密大文件。Magpie 用 PBKDF2-SHA256（60 万次迭代）派生密钥、整文件一次 AES-256-GCM（`internal/backup/backup.go` 第 179–241 行），格式私有，整文件 GCM 需要完整缓冲才能认证；Node 的 Argon2 接口仍是实验性 API，不用于持久格式。实现计划使用 typage（npm 包 `age-encryption`），引入时按第 9 节核对许可证，并测量 N=2^18 在三平台上的解密耗时（目标不超过 5 s）。
- 口令至少 12 个字符；`--passphrase-generate` 用 EFF 长词表生成 6 个词（约 77 位熵）。口令只从终端交互输入或 `--passphrase-file`（权限要求同 file 引用）读取，不接受命令行参数，避免出现在进程列表与 shell 历史中。
- 导入含秘密的归档时，值写入目标机器的秘密后端并生成新引用 ID，归档中的引用随之改写。

## 4. 秘密管理

### 4.1 后端

| 平台 | 默认后端 | 实现 | 现状 |
|---|---|---|---|
| macOS | 登录钥匙串（generic password，service 固定、account 为引用 ID） | 现有 `harnesshub-keychain` helper | 已实现 |
| Windows | DPAPI CurrentUser 加密文件，位于 `%LOCALAPPDATA%\HarnessHub\secrets-v1` | 现有 `harnesshub-secrets.exe`（[ADR 0008](../../decisions/0008-windows-secret-storage.md)）；不用 Credential Manager，因其单条上限 2,560 字节 | 已实现 |
| Linux 桌面 | Secret Service D-Bus API（GNOME Keyring、KWallet、KeePassXC），属性为 `application=harnesshub`、`id=<引用 ID>` | 纯 JavaScript D-Bus 客户端，不引入原生模块，以便单可执行文件分发 | 未实现；现状在 Linux 上直接报 `KEYCHAIN_UNSUPPORTED` |
| 无桌面会话的 Linux、容器、CI、团队服务器 | 加密文件（4.2 节） | 新增 | 未实现 |

`secrets.backend` 取 `auto`、`keychain`、`dpapi`、`secret-service`、`file` 之一。`auto` 选择平台默认后端；默认后端不可用时以 `SECRET_BACKEND_UNAVAILABLE` 明确失败，并提示显式选择 `file`，不静默回退到加密文件。

### 4.2 加密文件后端

- 主密钥为 32 字节随机数，来源按优先级：`secrets.keyFile` 指向的文件（systemd `LoadCredential`、容器或 Kubernetes 挂载的 secret）；环境变量 `HH_SECRETS_KEY`（base64，主要供 CI 使用，读取后立即从进程环境删除，不被子进程继承）；首次使用时生成到 `<配置根>/secrets.key`（0600 或私有 DACL）。
- 每个秘密一个文件 `secrets/v1/<id>.json`，内容为 `{v, alg:"A256GCM", kid, nonce, ct, createdAt}`。数据密钥由 HKDF-SHA-256（主密钥，salt=kid，info=`harnesshub secrets v1`）派生；nonce 为 96 位随机数；附加认证数据为 `harnesshub/secret/v1/<id>/<version>`，防止密文在条目之间被调换。文件独占创建，更新时原子替换。
- `hh secrets rekey` 生成新主密钥，把全部条目重新加密到新文件，全部成功后才切换 `kid` 并删除旧文件；中途失败时旧密钥继续有效。
- 团队服务器把秘密值以同一信封结构存在 PostgreSQL 中，主密钥来自 `secrets.keyFile`。外部 KMS（Vault、云厂商 KMS）不在 1.x 范围；[09 扩展](09-extensibility.md) 的扩展点也不包含秘密后端，出现需求后单独决定。
- 保护范围如实说明：同一账户的进程能读到主密钥文件，file 后端对同账户的恶意进程没有保护，它防的是只复制了数据根、数据库备份或导出文件而没有配置根的情况。系统密钥库对同账户进程的保护同样有限：DPAPI 对同一用户的任何进程都可解密（ADR 0008），Secret Service 解锁后对同一会话开放，macOS 钥匙串按应用 ACL 弹出确认。

### 4.3 引用模型

- 配置与数据库只保存引用，共三种：`{"kind":"store","id":"<uuid>"}`（HarnessHub 管理、与后端无关）、`{"kind":"env","name":"OPENAI_API_KEY"}`、`{"kind":"file","path":"/run/secrets/openai"}`。现有的 `keychain` 引用在迁移时改为 `store`，迁移方法见 [12 路线图与迁移](12-roadmap-migration.md#2-里程碑)。
- 值只在使用点短暂存在于内存：网关向上游发请求时，Worker 为所属 MCP 进程解析工具秘密时（[04 第 8 节](04-agent-plane.md#8-library)），或插件宿主按授权下发给插件时（09 第 3 节）。解析出的值立即加入脱敏器的已知值集合（08 第 7 节），调用方不得记录它。
- `env` 引用只读守护进程启动时的环境快照。Windows 上变量名大小写不敏感，多个大小写变体取值不同时拒绝（沿用 [`secrets.ts`](../../../src/drivers/configuration/secrets.ts) 第 139–152 行）。变量不存在时在启动和 `hh doctor` 中报告，不在第一次上游 401 时才暴露（核验 env-key-spread：环境来源下 Key 缺失会静默变成“不带 Key”）。
- `file` 引用要求普通文件、非符号链接、不超过 8 KiB；POSIX 上组和其他用户无权限，Windows 上 DACL 不宽于当前用户（沿用现有校验）。
- 值必须非空、单行、不超过 8 KiB（沿用 `createSecret`）。provider 插件保存的 OAuth 凭据包（访问令牌、刷新令牌、过期时间）作为一个 JSON 秘密存放，上限 16 KiB。
- 秘密索引表记录 `id、backend、label、purpose、owner、createdAt、rotatedAt、lastUsedAt、hint`。`purpose` 取 `provider:<id>`、`plugin:<id>`、`tool:<libraryItem>`、`system:<name>`；`hint` 只在值长度不少于 20 时保存末 4 位，用于界面上区分多把 Key。
- API 与控制台从不返回秘密值；写入接口只接收值、返回引用。读出值的唯一出口是带 `--include-secrets --encrypt` 的导出。

### 4.4 轮换

| 对象 | 操作 | 过渡 | 证据 |
|---|---|---|---|
| provider 凭据 | `hh credential rotate`：同一引用 ID 下写入新版本 | 新请求立即使用新值；进行中的请求继续使用旧值，旧版本 10 分钟后删除 | `secret.rotated`（引用 ID、版本、操作者，不含值） |
| Gateway Key | `agent:` 作用域随重新接线轮换：写入并回读成功后吊销旧 Key（03 第 2 节）；`client:` 作用域用 `hh key rotate` 签发作用域、白名单、额度相同的新 Key | `client:` 旧 Key 在重叠期（默认 24 小时，可设 0–30 天）结束后吊销 | `key.rotated`、`key.revoked` |
| 本机管理令牌 | `hh admin-token rotate` | 旧令牌立即失效，全部控制台会话一并吊销 | `admin_token.rotated` |
| file 后端主密钥 | `hh secrets rekey` | 见 4.2 节 | `secrets.rekeyed` |
| 团队 API Key | 同 Gateway Key | 必须设置过期时间，最长 365 天 | 审计日志 |

`hh credential rm` 在引用仍被使用时拒绝执行并列出使用方。清理无人引用的条目（建议形式 `hh credential rm --unreferenced`）只处理本数据根索引表中登记、且已无人引用的条目，从不枚举或删除系统密钥库里不属于本索引的条目，避免多个安装共享同一系统存储时误删（核验 secret-refs-cleanup）。

### 4.5 Gateway Key 与其他令牌只存哈希

- Gateway Key 的格式由 [03 第 2 节](03-model-plane.md#2-gateway-key-与作用域) 定义为 `hhk_<作用域字母>_<keyId>_<secret>`，满足本文的三项要求：固定前缀，便于脱敏规则与秘密扫描识别；可公开的 `keyId` 用于查找；秘密部分为 256 位随机数。
- 存储内容为 Key ID、秘密部分的 SHA-256、作用域、模型白名单、额度、过期时间、吊销时间、签发者与最近使用时间。随机值熵足够高，不需要慢哈希。校验时按 Key ID 查找，再用 `crypto.timingSafeEqual` 比较摘要。完整 Key 只在签发时显示一次。对照：Magpie 把调用方 Key 明文存在 `caller-keys.json`，仅在比较时使用常数时间（`internal/access/access.go` 第 211–234 行）。
- 本机管理令牌、控制台会话、一次性登录码、MCP 委派令牌（05 第 9 节）、团队 API Key 采用同样的做法：数据库或内存中只有摘要。
- 全局接线会把 Agent 作用域的 Key 写进 Agent 配置或环境（ADR-P03），这份副本不在 HarnessHub 的保护之内。缓解措施是作用域限定为 `agent:<id>`、仅限回环来源、模型白名单，以及 `hh unwire` 时吊销。

### 4.6 禁止把 HarnessHub 自身凭据作为工具秘密

现有实现中，MCP 的 `secretHeaders` 可以引用统一模型 Key 的环境变量，登记返回 201；粘贴含 `${env:...}` 的 mcpServers 配置只得到一条警告；两种情况下引擎都在 MCP 请求头里拿到了这把 Key（核验 V9-N2，回环模式即可复现）。开源版有多个 provider，问题更普遍：任何 provider 凭据都可能经工具配置发往任意 URL，绕过网关、路由与账本。

规则：工具秘密（Library 中 MCP 的 env 与 headers、隔离接线中的工具配置、插件的秘密授权）不得解析为以下任何一项：

1. 任一 provider 的 Credential，按同一 `store` ID、同一 `env` 名、规范化后同一 `file` 路径判断；
2. Gateway Key、本机管理令牌、控制台会话、MCP 委派令牌、团队 API Key、OIDC client secret、file 后端主密钥；
3. 名称以 `HH_` 或 `HARNESSHUB_` 开头的环境变量。

检查分两层，命中时明确失败，不降级为警告，也不静默剥离：

- 写入时：Library 条目登记、`hh import` 与控制台粘贴导入、绑定到 Agent 或 Session，三处按引用比对，命中返回 400 `SECRET_REF_FORBIDDEN`。
- 使用时：Worker 准备阶段与插件授权时，把解析出的值与当前全部 provider 凭据的值做常数时间摘要比较（比较在守护进程内完成，Worker 只上报解析值的 SHA-256 摘要，不回传值），命中则该 Run 准备失败或插件授权失败，并提交不含值的 `secret.forbidden_use` 事件。这一层能发现同一把 Key 以两个不同引用登记的情况。

工具确实需要调用模型时，签发一个 `client:<tool>` 作用域的 Gateway Key，让工具经网关调用，调用也因此进入账本。验证：三条写入路径与两条使用路径各有无效样例（分别引用 provider 的 env 名与 store ID），正例是引用 `MY_MCP_TOKEN` 的配置仍可使用。

## 5. 认证与授权

### 5.1 请求分类

| 类别 | 路径（以 [06 第 1 节](06-interfaces.md#1-端口与路径布局) 为准） | 本机 | 局域网监听器 | 团队服务器 |
|---|---|---|---|---|
| 模型协议 | `/v1/*`、`/v1beta/*` 与省略 `/v1` 的兼容路径 | Gateway Key，回环来源也必须携带 | 显式允许局域网来源的 `client:` Key | `user:` Key |
| 执行与查询 API | `/api/v1/sessions`、Run、事件 SSE、`/api/v1/mcp` | 管理令牌或控制台会话；`/api/v1/mcp` 另接受委派令牌 | 不提供 | OIDC 会话或 API Key，按 RBAC |
| 管理 API | provider、Key、秘密、接线、Library、插件、设置 | 管理令牌或控制台会话 | 不提供 | OIDC 会话或 API Key，按 RBAC |
| 控制台静态资源 | `/` | 无需认证，不含数据 | 不提供 | 无需认证 |
| 健康检查与指标 | `/healthz`、`/readyz`；`/metrics` | 健康检查无需认证；`/metrics` 需管理令牌 | 只有 `/healthz` | 健康检查无需认证，`/readyz` 不含细节 |

局域网形态在 1.0 只开放模型协议。执行 API 的远程访问需要用户身份与所有权校验，放在团队服务器（1.x）中提供，这也是 [DESIGN.md 第 7 节](../../../DESIGN.md#7-通用-api-基线) “公开网络访问时增加认证及所有权校验”的落实方式。

### 5.2 本机管理令牌与控制台会话

- 首次启动生成 256 位随机令牌，写入 `<数据根>/admin.token`（0600 或私有 DACL），守护进程只在内存中保存其 SHA-256。`hh` CLI 读取该文件，以 `Authorization: Bearer` 调用 `/api/v1`。令牌不经命令行参数或环境变量传递，也不传给 Worker 与插件。
- 控制台登录：`hh console` 用管理令牌调用 `POST /api/v1/auth/console-links`，得到 128 位一次性登录码（有效期 60 s，只能使用一次），然后打开 `http://127.0.0.1:3180/#login=<code>`。登录码放在 URL 片段中，不会发到服务器，也不会进入访问日志；单页读取后立即用 `history.replaceState` 清除，再调用 `POST /api/v1/auth/console-sessions` 换取 Cookie：`hh_console=<256 位随机值>; HttpOnly; SameSite=Strict; Path=/`，经 TLS 访问时另加 `Secure`。会话空闲 12 小时或自创建起 7 天失效；登出与 `hh admin-token rotate` 立即吊销。
- 改变状态的请求还必须是 `Content-Type: application/json`。跨源页面无法在不触发 CORS 预检的情况下发送这种请求，而守护进程不响应预检，这是 SameSite 与 Origin 校验之外的第三道 CSRF 防线。Magpie 的控制台同样用常数时间比较令牌后换成 HttpOnly Cookie，但使用 `SameSite=Lax`（`internal/gui/web.go`）；本机控制台不需要跨站导航携带 Cookie，因此用 Strict。
- 没有会话时直接打开控制台，页面只提示运行 `hh console`，不提供口令表单。

### 5.3 Host、Origin 与 Sec-Fetch 校验

现有实现在回环模式下校验 Host 为回环名、Origin 等于 `http://<host>`、拒绝 `Sec-Fetch-Site: cross-site`（[`server.ts`](../../../src/gateway/server.ts) 第 174–195 行）；但 `--host 0.0.0.0` 时 Host 校验整体关闭，Host 与 Origin 同为攻击者域名的 DNS rebinding 请求可以通过，全部配置接口对网络开放（核验 remote-binding-exposure，已复现）。开源版在每个监听器上、路由之前执行以下规则：

1. Host 必须属于该监听器的允许名单。回环监听器为 `localhost`、`127.0.0.1`、`[::1]` 加端口；局域网监听器为配置项 `server.lan.names` 显式列出的主机名或 IP，不支持通配。不在名单内返回 403 `HOST_NOT_ALLOWED`。DNS rebinding 请求的 Host 是攻击者的域名，因此被拒绝。
2. 请求带 Origin 时，它必须等于该监听器某个允许名的 `scheme://host:port`。模型协议路径上的跨源请求一律拒绝，网页不能直接消耗本机网关额度。
3. `Sec-Fetch-Site: cross-site` 一律拒绝；管理与执行 API 只接受 `same-origin` 或不带该头的非浏览器客户端；`none`（地址栏直接打开）只允许 GET 静态资源。
4. 不响应 CORS 预检（OPTIONS 返回 403），不发送任何 `Access-Control-Allow-*` 头。
5. 控制台响应带 `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`、`X-Content-Type-Options: nosniff` 与 `Cross-Origin-Resource-Policy: same-origin`。

### 5.4 局域网共享（1.0）

- 开启：`server.lan.enabled=true`，并指定 `server.lan.listen`（具体网卡地址与端口；监听全部地址时必须写明 `0.0.0.0`）与 `server.lan.names`。还必须满足以下二者之一，否则以 `LAN_TLS_REQUIRED` 拒绝启动：（a）`server.lan.tls` 引用证书与私钥，最低 TLS 1.2；也可用 `hh tls init` 生成自签名证书，启动时打印 SHA-256 指纹供客户端固定；（b）`server.lan.behindProxy=true`，此时 `server.lan.listen` 必须是回环地址，`server.lan.trustedProxies` 列出代理地址，只有来自这些地址的 `X-Forwarded-For` 才写入审计字段。
- 两个监听器：回环监听器（3180）照常提供全部路由；局域网监听器只注册模型协议路由与 `/healthz`。管理面的路由在局域网监听器上不存在，返回 404。这样即使反向代理部署在同一台机器上、转发来的请求在 socket 层表现为回环，也到达不了管理面。
- 纵深防御：管理与执行路由另外检查 `request.socket.remoteAddress` 是回环地址（`::ffff:127.0.0.1` 先规范化），不依赖 Host 头；带 `Forwarded` 或 `X-Forwarded-For` 的请求不能访问管理路由。
- 局域网上的每个请求都必须带显式允许局域网来源的 `client:<name>` Key（03 第 2 节），并且必须设置过期时间与额度，否则返回 401 或 403 并计入认证失败指标。同一来源 IP 一分钟内失败 20 次后，拒绝其请求 10 分钟。
- 启动输出、`hh status` 与控制台显示局域网监听地址、TLS 指纹与已签发的局域网 Key。对照：Magpie 的 `lanGuard` 按 socket 地址判断本机（`internal/gateway/lan.go` 第 148–168、239–246 行），但显式设置 `MAGPIE_ADDR` 而未开启局域网共享时保持无鉴权的开放网关；HarnessHub 不提供这种模式。

### 5.5 团队服务器（1.x）

- 租户模型：一个部署对应一个组织。互不信任的组织各自部署、各用一个数据库，不在同一实例内做多组织隔离。组织内用项目划分数据可见性与额度；角色绑定在组织或项目两级。
- OIDC 登录：Authorization Code 加 PKCE（S256），机密客户端；只接受配置的 issuer，校验 `iss`、`aud`、`exp`、`nonce`。首次登录按配置的组声明映射表分配角色，未命中映射的用户不能登录。会话 Cookie 为 `__Host-hh_session; Secure; HttpOnly; SameSite=Lax`（OIDC 回调需要 Lax），空闲 8 小时或绝对 24 小时失效；每小时用刷新令牌重新校验一次，IdP 侧停用的账号最迟 1 小时后失效。
- RBAC 角色表：

| 操作 | owner | admin | member | viewer | auditor |
|---|---|---|---|---|---|
| 管理用户与角色绑定 | ✓ | ✓（不能授予 owner） | — | — | — |
| 配置 provider、凭据、路由组、模型白名单与额度 | ✓ | ✓ | — | — | — |
| 安装与启用插件、管理 Library | ✓ | ✓ | — | — | — |
| 签发自己的 Gateway Key 与 API Key | ✓ | ✓ | ✓（权限不超过本人） | — | — |
| 吊销 Key | 任意 | 任意 | 仅本人 | — | — |
| 创建 Session、提交 Run、答复权限请求 | ✓ | ✓ | 所属项目内 | — | — |
| 查看 Run、事件、用量 | 全部 | 全部 | 所属项目内 | 所属项目内 | 全部（只读） |
| 读取审计日志 | ✓ | — | — | — | ✓ |
| 修改保留策略、全量导出 | ✓ | — | — | — | — |

- 执行方式：每次 Store 查询都带上访问上下文（主体、角色、项目），项目过滤在 Store 内完成，不依赖界面隐藏。端点 × 角色的授权测试由上表生成，上表是唯一来源。
- API Key 用于脚本与 CI：属于某个用户或服务账号，权限是所有者权限的子集，可限定项目，必须设置过期时间（最长 365 天），只存哈希。成员的 Gateway Key 为 `user:<id>` 作用域，额度与超额处理按 [03 第 2 节](03-model-plane.md#2-gateway-key-与作用域)，项目级额度在同一检查点执行。成员本机的 `hh` 可以把团队服务器当作上游 provider（[01 用户旅程](01-product.md#3-目标用户与场景) 第 4 条）。
- 审计日志覆盖：登录、登出与登录失败；角色绑定变化；provider、凭据、路由组、额度变化；Key 签发与吊销；插件安装与启用；Library 变化；设置与保留策略变化；导出、备份与恢复。每条记录包含 `id、at、actor{type,id,ip,userAgent}、action、target{type,id}、result(success|denied|failed)、reason、requestId、changes`，其中 `changes` 是脱敏后的字段级差异，秘密字段只记“已变更”。
- 审计记录与被审计的变更在同一事务中提交，审计写入失败则变更失败。记录带 `prevHash` 与 `hash = SHA-256(prevHash ‖ 规范化 JSON)` 构成哈希链，`hh audit verify` 可重算整条链。API 只提供只读查询，没有修改或删除接口。保留任务只按时间整段删除早于保留期的记录，并写入一条检查点记录保存最后删除的哈希，删除后剩余的链仍可验证。审计日志可经导出器插件发往 SIEM（09 第 1 节）。

### 5.6 CI 形态

`hh ci start` 在 runner 临时目录创建数据根（`HH_HOME`），只监听回环地址，生成的管理令牌经 GitHub Actions 的 `::add-mask::` 屏蔽后作为步骤输出。秘密使用 `env` 引用流水线的 secret，不写入任何持久后端。结束时 `hh ci stop` 执行 `hh export runs` 并删除临时数据根。

## 6. 威胁模型

资产：A1 provider 凭据；A2 Gateway Key、管理令牌与会话；A3 用户代码与工作区；A4 提示词、模型输出与 Run 证据；A5 用户的 Agent 配置文件；A6 HarnessHub 配置与数据库的完整性；A7 主机与内网；A8 额度与费用；A9 发布物、插件与工具包。

信任边界：浏览器与守护进程；同机其他进程与守护进程；局域网客户端与局域网监听器；守护进程与上游 provider；守护进程与插件进程；Worker 及 Agent 与网关；Agent 与 MCP 服务；团队用户与团队服务器；发布流水线与用户机器。

不在模型内的前提：与用户同账户、已取得完整权限的恶意进程（可以在密钥库解锁后读取、可以调试其他进程）；管理员或 root 被攻破；物理接触；上游 provider 自身被攻破。

| 编号 | 场景 | 资产 | STRIDE | 威胁 | 缓解 | 残余风险 |
|---|---|---|---|---|---|---|
| T1 | Agent 执行不可信代码（仓库内容、提示注入） | A1 A2 A3 A6 A7 | T I E | Agent 读取 `admin.token` 或数据库、改写 HarnessHub 配置、读取其他项目、向外发送数据 | Worker 使用 Session 私有 HOME 与隔离配置；Agent 只拿到 Session 作用域 Gateway Key（只在有活动 Run 时可用，有额度与模型白名单，Session 关闭后吊销）；不向 Worker 传递 `HH_HOME`、管理令牌与 provider 凭据；权限、工作区与沙箱等级见 [05 第 5–6 节](05-run-plane.md#6-沙箱与隔离等级) | Agent 以用户身份运行，能读用户可读的任何文件，包括 `admin.token` 与 Agent 自己的原生凭据；未启用 OS 沙箱时这不是隔离边界 |
| T2 | 恶意或被攻破的 MCP 服务 | A1 A3 A4 | I E | 经工具结果做提示注入、诱导 Agent 外传；MCP 进程窃取环境中的秘密 | MCP 只拿到被授权的工具秘密，HarnessHub 自身凭据被 4.6 节禁止；安装时逐项展示命令、URL 与秘密槽；按摘要固定版本，变更需重新确认（第 7 节） | MCP 由 Agent 启动、以用户身份运行，HarnessHub 不能限制其文件与网络访问 |
| T3 | 恶意插件 | A1 A2 A4 A7 | S T I E | 冒充 provider 收集请求内容、读取其他秘密、在宿主执行代码 | 进程外运行；只能经宿主 API 取得授权的秘密；`host/fetch` 按清单校验目标主机；签名身份核对与分级信任（第 7 节、09 第 3–4 节） | 插件进程直接发起的系统调用不受限制；本地未签名插件需显式允许 |
| T4 | 凭据经工具配置外带 | A1 A8 | I | MCP 的 header 或 env 引用 provider 凭据，发往任意地址，绕过网关与账本（V9-N2 已复现） | 4.6 节的写入时与使用时两层拒绝 | 用户在 Agent 原生配置中手写同一把 Key，HarnessHub 看不到 |
| T5 | 配置篡改 | A5 A6 | T R | 同机其他账户或进程改写 provider 基址或 Agent 配置，把 Key 发往攻击者 | 数据根 0700 或私有 DACL 并在启动时校验（第 1 节）；配置变更写证据事件；全局接线的漂移检测结合网关证据（[04 第 5 节](04-agent-plane.md#5-漂移检测)）；provider 基址变更在控制台与 CLI 中要求确认 | 同账户进程仍可改写，只能事后由漂移检测发现 |
| T6 | DNS rebinding 与浏览器跨站请求 | A1 A2 A6 A8 | S E | 恶意网页把自己的域名解析到 127.0.0.1，调用管理 API 或消耗网关额度 | Host 允许名单、Origin 与 Sec-Fetch 校验、不响应 CORS、`SameSite=Strict` Cookie、模型路由也必须带 Key（5.3 节、ADR-P03） | 浏览器扩展等同机特权组件不在模型内 |
| T7 | 局域网窃听与重放 | A2 A4 A8 | S I | 明文 HTTP 下被嗅探 Key 与提示词 | 局域网必须 TLS 或回环反向代理；Key 命名、有额度与过期时间；失败限速 | 自签名证书依赖客户端固定指纹，客户端不校验时仍可被中间人攻击 |
| T8 | 管理面暴露 | A1 A6 | E | 绑定 `0.0.0.0` 时全部配置接口对网络开放（核验已复现） | 管理路由只注册在回环监听器上，另有 socket 来源检查；不提供无鉴权的开放模式 | 用户自行部署的转发工具把外部流量转到回环监听器时会重新暴露，`hh doctor` 只能识别已知配置 |
| T9 | 团队服务器 provider 基址 SSRF | A7 | I E | admin 把基址设为 `http://169.254.169.254/` 或内网管理面，借服务器读取内网 | 团队形态出站策略：只允许 https，http 必须命中内网白名单；DNS 解析后检查地址，拒绝回环、链路本地、云元数据地址、私网与 CGNAT 段，除非命中 `network.egress.allow` 的 CIDR；连接使用已校验的地址，避免解析与连接之间被换绑；不跟随重定向；上游错误正文截断并脱敏后才返回 | admin 自身被信任配置白名单，白名单内的内网服务仍可访问 |
| T10 | 日志与诊断包泄露 | A1 A4 | I | 命令行、stderr、debug 载荷中的凭据落盘；两套规则分叉、先截断后脱敏留下前缀；脱敏破坏 JSON 导致整条记录丢失（核验 redaction-unify、V9-N1） | 统一规则表、先脱敏后截断、结构化擦除与已知值替换（08 第 7 节）；诊断包生成后自检（08 第 8 节）；debug 默认关闭 | 形状规则无法识别所有私有格式的秘密，分享前仍需人工复核 |
| T11 | 导出文件泄露 | A1 A4 | I | 导出包被上传或误分享 | 默认不含秘密；含秘密时必须 age 加密；口令不经命令行参数（第 3 节） | 口令强度取决于用户；Run 导出本身含提示词与代码 |
| T12 | 供应链：依赖与发布物 | A7 A9 | T | npm 依赖投毒、发布物被替换、更新通道被劫持 | 锁文件与冻结安装、新增依赖审查、SBOM、Sigstore 签名与构建溯源、`hh self-update` 校验签名身份（[10 第 7 节](10-engineering.md#7-依赖与供应链治理)） | 维护者账户与签名身份同时被攻破 |
| T13 | 供应链：插件、工具包、Adapter 与预设数据 | A1 A9 | T | 注册表索引或上游包被替换 | 索引签名、发布者身份绑定、撤销列表、安装不执行包内脚本（09 第 4 节） | 社区级包只经过自动检查 |
| T14 | 额度耗尽与资源耗尽 | A8 | D | 失控的 Agent 或泄露的 Key 大量调用；日志与产物写满磁盘 | Key 额度与速率、路由组上限；存储水位线触发时停止接收新 Run（08 第 3 节）；日志轮转 | 成本额度最多超出一次调用（03 第 2 节） |
| T15 | 否认 | A6 | R | 团队成员否认自己的变更或调用 | 审计日志哈希链；`model.call` 归因到 Key 与用户 | 本机形态没有多用户身份，证据只能说明“这个数据根”做了什么 |
| T16 | 企业 TLS 拦截与私有 CA | A1 A4 | S I | 为了连通而关闭 TLS 校验；或 Worker 丢弃 CA 设置导致全部调用 502（核验 corporate-ca-proxy） | 守护进程信任 Node 内置根证书、系统证书库与 `network.tls.extraCaFile`；向 Worker 透传 `NODE_EXTRA_CA_CERTS`、`NODE_USE_SYSTEM_CA`、`SSL_CERT_FILE`、`SSL_CERT_DIR`；从不透传 `NODE_TLS_REJECT_UNAUTHORIZED`，检测到其值为 0 时 `hh doctor` 报错；TLS 校验类错误码附处置提示 | 经企业 CA 拦截的流量对企业可见，这是部署环境的选择 |
| T17 | 同机其他账户 | A1 A4 A6 | I T | 读取日志与数据库、改写配置 | 目录权限与 DACL（第 1 节） | 管理员账户仍可读取一切 |
| T18 | 第二个实例抢先写入 | A6 | T | 第二次启动在取得所有权前改写运行中实例的配置（核验 second-start） | 写任何状态前取得内核释放的锁（08 第 4 节） | 网络文件系统上锁不可靠，已在第 1 节拒绝或告警 |

1.0 发布前按本表完成一次安全审查（[01 版本范围](01-product.md#5-版本范围) 要求“安全审查完成”，流程见 [11 第 5 节](11-governance.md#5-安全响应)），残余风险写入 `SECURITY.md` 的已知限制。

## 7. 插件与工具包的信任模型

插件与工具包是进入 HarnessHub 的第三方代码和数据。HarnessHub 能做到的是：来源可验证、声明的权限对用户可见、经宿主 API 取得的资源受控、崩溃不影响守护进程。它不承诺对插件进程、MCP 服务或 Agent 做操作系统级隔离。

| 等级 | 来源 | 校验 | 安装体验 | 可用范围 |
|---|---|---|---|---|
| 内置 | 随 HarnessHub 发布 | 发布签名覆盖 | 默认可用 | 全部形态 |
| 已审核 | 注册表索引，经 AI 维护者代码审核并由所有者确认 | Sigstore 签名身份与索引登记一致，版本摘要匹配 | 显示权限，确认一次 | 全部形态；团队服务器默认只允许此级 |
| 社区 | 注册表索引，只经自动检查 | 同上 | 显示权限与“未经人工审核”提示 | 本机与局域网；团队服务器需 owner 加入白名单 |
| 本地 | 本地路径或未登记的 npm、OCI、git 来源 | 只校验内容摘要 | 需 `--allow-unsigned`，显示红色警告 | 仅本机 |

另有与等级正交的风险标签：订阅复用类插件（ADR-P09）必须带 `subscription-reuse` 标签，永远不能进入已审核级，启用时显示厂商条款与封号风险并要求输入确认。

共同规则：

- 安装不执行包内任何脚本，相当于 npm 的 `--ignore-scripts`（Magpie 同样如此，见 `internal/plugin/store.go` 的 `install`）；插件包必须自带依赖，安装只是下载、校验、解包。
- 安装后的包按 SHA-256 存放在 `plugins/objects/<sha256>`，启动前校验摘要，沿用 Library 与现有工具包的内容寻址做法（[`src/tool-packages/store.ts`](../../../src/tool-packages/store.ts)）。
- 更新时权限扩大必须重新确认。权限不变的更新：本机对已审核级自动应用，对社区级询问；团队服务器一律需要 admin 确认。
- 注册表撤销某个版本后，客户端在下次刷新索引（默认每天）时拒绝再启动该版本，并显示安全公告。
- 工具包（Library）：Skills 与指令是纯文本，但会被 Agent 当作指令执行，安装与更新时展示全文差异；MCP 定义包含可执行命令与 URL，安装时逐项展示命令、参数、URL 与所需秘密槽，秘密槽只能绑定用户自己的秘密（4.6 节）。Library 包与插件使用同一套分级、签名与撤销机制。
- 对照：Magpie 把全部插件放在同一个 Bun 进程中运行，不做签名校验，插件登录凭据以明文存在 `plugin-auth.json`（`internal/plugin/store.go`、`internal/plugin/host.go`）。HarnessHub 每个插件一个进程，凭据进入秘密后端。

## 8. 隐私与遥测

默认不发送遥测（[ADR-P08](adr-drafts.md#adr-p08-遥测默认关闭)）。只有交互式 `hh init` 在首次运行时询问，默认答案为“否”；非交互运行、CI、容器与团队服务器从不询问，也不发送。`DO_NOT_TRACK=1` 或 `HH_TELEMETRY=0` 无论已保存的选择如何都强制关闭。

同意后发送的内容以下表为准，表外的字段一律不发送：

| 字段 | 示例 | 说明 |
|---|---|---|
| `installId` | 随机 128 位 | 本地生成，`hh telemetry reset-id` 重置，不与任何账号关联 |
| `version`、`channel` | `1.0.3`、`stable` | |
| `os`、`arch` | `linux`、`arm64` | 不含发行版与内核版本 |
| `form` | `local`、`lan`、`ci` | 团队服务器不发送 |
| `features` | `{"globalWiring":true,"runs":true,"lan":false,"otel":false,"plugins":true}` | 布尔开关 |
| `counts` | `{"agentsWired":"2-3","providers":"1","runs7d":"10-99","modelCalls7d":"1k-10k"}` | 分桶：0、1、2–3、4–9、10–99、100–999、1k–10k、>10k |
| `adapters` | `["codex","claude-code"]` | 只含核心仓库中的 Adapter ID，其他记为 `other` |
| `providerPresets` | `["openai","deepseek"]` | 只含预设 ID，自定义 provider 记为 `custom`，从不发送基址 |

从不发送：提示词、模型输出、代码、文件名与路径、主机名、Key、模型名、错误正文。发送频率最多每 7 天一次，在守护进程启动且到期时发送，目标是项目自建的收集端点（地址写在发布说明与 `hh telemetry show` 的输出中）；收集端不保存来源 IP，聚合结果每季度公开。`hh telemetry show` 打印下一次将发送的完整 JSON；载荷有 JSON Schema（`additionalProperties: false`），测试断言载荷通过校验。Magpie 默认每天发送一次匿名计数，可用 `DO_NOT_TRACK` 关闭（`internal/stats/stats.go`）；HarnessHub 改为默认关闭。

默认联网行为的完整清单如下。ADR-P08 要求“未同意时没有任何外发请求”，因此除用户配置的 provider 外，每项要么默认关闭，要么只由用户的显式操作触发。网络捕获测试在全新数据根上启动守护进程并执行 `hh init`（全部回答“否”）与一次假上游调用，断言除假上游外没有任何连接。

| 连接 | 默认 | 发送内容 | 开关 |
|---|---|---|---|
| provider 上游 | 用户配置后 | 用户的模型请求 | — |
| 更新检查 | 首次运行时单独询问，默认否 | GET 发布清单，不带标识 | `updates.check` |
| 模型目录刷新 | 关闭，使用内置快照；首次运行时与更新检查一并询问 | GET models.dev 数据 | `catalog.autoRefresh`；`hh catalog refresh` 手动执行 |
| 插件索引刷新 | 安装过注册表插件后每天一次 | GET 签名索引 | `plugins.indexRefresh`；关闭后 `hh doctor` 提示撤销公告不再更新 |
| OTLP 导出 | 关闭 | 见 08 第 5 节 | `observability.otel.enabled` |
| 遥测 | 关闭 | 上表 | `telemetry.enabled` |

`network.offline=true`（或 `hh serve --offline`）关闭 provider 调用以外的全部连接。团队服务器上，OIDC 用户的主体 ID、邮箱与姓名存在用户表中，审计日志只引用不透明的用户 ID；`hh users remove --erase` 删除用户表中的个人信息，审计哈希链不受影响。

## 9. 许可证合规与第三方声明

项目许可证为 MIT，贡献使用 DCO（[ADR-P02](adr-drafts.md#adr-p02-许可证)）。每个源文件带 `SPDX-License-Identifier: MIT`；从 Apache-2.0 组件并入的代码按原许可证保留其 LICENSE 与 NOTICE（[11 第 1 节](11-governance.md#1-许可证)）。现有仓库只有手写的 [第三方声明](../../../THIRD_PARTY_NOTICES.md)，其中明确写着“不把本文件作为完整的传递依赖许可证清单”；开源版改为由 SBOM 生成。

依赖许可证策略（CI 中的许可证扫描对全部依赖执行，未知或禁止的许可证使检查失败）：

| 类别 | 许可证 | 处理 |
|---|---|---|
| 允许 | MIT、ISC、BSD-2-Clause、BSD-3-Clause、Apache-2.0、0BSD、Zlib、BlueOak-1.0.0、CC0-1.0、Python-2.0 | 直接使用 |
| 需审查 | MPL-2.0（文件级 copyleft，只允许不修改地使用）、CC-BY-4.0（只用于数据与文档）、Unlicense | 维护者审查后登记在例外清单，注明理由 |
| 禁止 | GPL、LGPL、AGPL 各版本（打进单可执行文件即构成合并分发）、SSPL、BUSL、Elastic License、带 Commons Clause 的许可证、无许可证或无法识别 | 检查失败 |

覆盖范围：

- 全部 workspace 包的运行时依赖，以及控制台打包进单页的前端依赖。
- 单可执行文件内嵌的 Node.js 运行时：Node 的 LICENSE 文件已列出其捆绑组件（OpenSSL、ICU、libuv、V8 等），原样纳入声明。
- 平台 helper（macOS 钥匙串、Windows DPAPI 与 Job Object）为项目自有代码，随源码以 MIT 发布。
- 容器镜像的基础层另生成镜像 SBOM，与二进制 SBOM 分开。
- OpenCode 兼容层需要的 Bun 运行时不随 HarnessHub 分发，首次使用时从官方发布地址下载，并按 HarnessHub 发布清单中固定的 SHA-256 校验（09 第 7 节）。
- 数据与素材：models.dev 目录快照在导入时核对并记录其许可证；provider 预设是项目自有数据；provider 与 Agent 的标志属于各自商标，只在权利人公开的使用条款允许时随包分发，否则界面使用文字名称；文档与界面注明“与相关厂商无关联”。
- Agent CLI 不随核心发布。现有离线包携带并修改了 Hermes Agent 与 Kimi CLI 的二进制，这部分随比赛交付一起移出核心（[02 第 10 节](02-architecture.md#10-与现状的关系)）。

每次发布生成并附带：CycloneDX JSON 格式的 SBOM；由 SBOM 与许可证原文生成的 `THIRD_PARTY_NOTICES`，生成器与新鲜度检查一起维护；`hh licenses` 命令与控制台“关于”页显示同一内容。检查规则附带无效样例：一个声明 `GPL-3.0-only` 的假依赖和一个缺少许可证字段的假依赖，必须使扫描失败；缺少 SPDX 头的源文件必须使头部检查失败。

插件与工具包的清单必须声明 SPDX 许可证。已审核级只接受 OSI 批准的许可证；社区级接受任何可识别的许可证并在安装时显示。插件自身的第三方声明由插件作者负责，HarnessHub 不对插件重新授权。
