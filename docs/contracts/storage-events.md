# 持久事实、事件和恢复

状态：proposed。第一版采用事务存储加 append-only 事实日志与 outbox；不宣称采用完整 Event Sourcing，也不建立两份业务权威。

**接力存储（已接受（ADR-055））**：凡标注“已接受（ADR-055）”的段落，以及“接力存储与事件”一章，来自[接力系统终稿](../proposals/relay/relay-architecture.md)（[ADR-055](../decisions/0055-relay-and-context-scheduling.md) 的设计正文，下称“终稿”）。它们已于 2026-11-03 验收（ADR-055 accepted），**G066（2026-11-09）实现了其中的存储部分**：业务库升到 v13，新库直接建成 v13；v1–v12 在同一个迁移事务里升级（v12→v13 建 11 张表与 4 个触发器、为每个绑定推断 `relay`、为每个已终结的已派发 Run 写 behind 索引行）；快照的 v13 字段、解析器与转换规则，`transact` 的 relay 行写入，`relayWrite`、`deleteSession`、安装级同意日志、窗口与偏好的写入接口，以及 `claimAndRecover` 里按会话 SAVEPOINT 的 `recoverRelay` 接入点都已实现，合成测试通过（[验证记录](../verification/relay-g066-2026-11-09.md)）。送达判定与状态机（G068）、渲染与摘要（G070）、协调器（G072）还没有实现，现有运行时仍按 v12 的规则推进、不写任何 relay 行；实现时的取舍与偏离见 ADR-055“实施补记”的 G066 一节。未标注的段落是 ADR-055 之前的契约原文，其中“业务库迁移前备份”一节已按 ADR-049 实现。切换、送达证据、水位与同步状态的语义见[切换契约](switching.md)的“接力”一章（下称“切换契约”）。标注约定与终稿相同：【事实】有代码或文档出处（代码位置都指基点 `07a0825` 的实际代码，本工作树的 `src/` 与之相同）；【实测】是原型或评审在本机测得的；【推断】由事实推出；【建议】是 ADR-055 的决定；【推算】是未经实测的数字。

## 写入与一致性

每个聚合的状态、事件与 outbox 在所属事务提交。消费命令按稳定 commandId 去重；CAS/version 保证根的并发不变量。不同上下文采用明确的 process manager 与 inbox/outbox，不假定分布式原子提交。

单进程 Store owner 为本机唯一逻辑写入者。Worker 与 Harness 只报告证据。跨重启 owner/进程身份使用不透明 token 与可核验的进程身份，不能只凭 PID 杀进程。

**已接受（ADR-055）**：接力行与快照、事件在同一个 `transact` 事务里写入（`SessionMutation.relay`），派生行在 SAVEPOINT 内；另有三条不经快照的写入路径：`SessionStore.relayWrite`（单独事务、不升 version、只写派生行）与安装级的 `RelayLogPort.append`、`RelayLogPort.upsertWindow / setPref`（R1）。

### Owner 排他与 fencing

本机建议采用数据根的进程级 OS 排他锁，持有到应用停止接收、停止派发并完成资源收敛以后。TTL/心跳仅用于诊断，不能仅因过期接管仍存活的 owner；暂停的进程仍持有锁。

取得锁后还要核对持久 owner 进程身份。旧 owner 仍活着或无法确认已死时拒绝接管，即使异常释放了锁也不自动启动第二个仲裁者。锁文件被替换、锁辅助进程退出或锁身份失效时，原 owner fail-closed；主进程直接持锁或辅助锁的失效检测/父子退出规则进入平台验证，不能以随机 token 代替排他性。

只有验证前任已停止并持有排他锁后，存储原子递增 ownerGeneration。每个业务提交、grant/租约更新和网关外部派发携带并核对该代次；旧代次不能再写业务状态、交付权限或授予执行权。派发检查和控制发送有所属串行控制权，不能只在很早的 await 之前检查一次。

新 owner 在给任何新写者授权前，先收敛旧代次的 Worker/原生绑定/工作区写权。即使数据库 owner 已更换，原生后端的未知副作用也不因此消失；无法确认时保持 blocked。排他锁/进程身份/代次三者的具体原生实现由平台 probe 冻结。

Session 事件采用独立递增 seq；Attempt 事件有自己的 seq/generation，并通过幂等投影关联公共事件。序号是持久事实的游标，传输 delta 不能冒充已落库事件。规范化公开消息可以分块有界保存；临时流块若不持久，必须显式标记且不推进持久游标。回复文本与思考的流块在 ≤100 ms 或 ≤16 KiB 的窗口内合并后一次提交（[ADR-047](../decisions/0047-stream-output-coalescing.md)），一个窗口一条 `run.output` 事件；未提交的窗口不推进持久游标，也不对外发布，崩溃最多丢失一个窗口。

**已接受（ADR-055）**：E1（`relay.input_recorded`）提交前先冲刷打开的文字窗口，保持 ADR-047 的到达顺序；ADR-047 第 5 条补一条修订（RT2-21，R3）。

## 存储对象建议

Session 状态/消息/输入幂等/outbox；Harness revisions 与 capability evidence；routing decisions；Turn 与 Attempt；bindings/leases；switch requests；permissions；context manifests；artifacts；model calls；inbox 去重与 schema migrations。按所属上下文管理访问，不公开通用 SQL Repository。

编号迁移只进不改历史；未知版本明确失败。大正文与二进制在受控对象存储，以 hash 和大小登记；数据库/文件的发布先验证文件再登记，失败孤儿清理有所有者，不能返回半成品。

**已接受（ADR-055）**：业务库 v13 增加 11 张接力表，与 `sessions`、`events` 同库——会话级的 `relay_bodies`、`relay_packets`、`relay_deliveries`、`relay_digests`、`relay_workspace`、`relay_pins`、`relay_exclusions`，安装级的 `relay_windows`、`relay_log`、`relay_log_archive`、`relay_prefs`（R2）。上文的 context manifests 由 `relay_packets` 的清单承担。交接单正文（上限 256 KiB/条）放业务库而不放内容存储，理由见 R2；Store 只增加有界的只读查询，不公开通用 SQL。

## SSE 与客户端

只读持久日志，Last-Event-ID 对应公共 Session 的稳定游标；重复交付可去重。游标过期返回 410 与历史读取入口，不从零静默重放或漏事件。高水位、分页、订阅数量、发送缓存与心跳有界。

慢消费者断开后按游标续读；不阻塞执行，也不维持无限内存缓冲。断流不取消运行；SDK 不因重连而再次提交消息。

**已接受（ADR-055）**：SSE 增推 `run.context_prepared`、`relay.input_recorded`、`relay.verified`、`relay.vendor_changed`、`run.ended`。`Run.relay.delivery` 在 Run 结束后仍会变（Hermes 的 E2 下一回合才到），以 `relay.verified` 与 ETag 通知；交接单正文经 `GET …/relay/:packetId` 读取，`ETag` 为 sha256，读取其他会话的 packetId 返回 404。SSE 不含交接单正文、秘密原值与原值的哈希（RT4 AP-01–AP-03）。

## 失败与保留

写入失败停止接收新执行，尽可能取消/隔离活资源；没有持久终态时报告存储不可用而非假成功。恢复后核对未知执行。

幂等记录、事件、原生 checkpoint 和 Artifact 保留期分别定义。存在历史 revision、恢复材料或 pin 引用时不直接删对象。删除数据、备份一致快照与导出恢复是独立命令，不通过清库“修复”状态。

**已接受（ADR-055）**：预期内的接力失败（校验、渲染、脱敏、配额、分类、同意）只让本 Run 失败，不让 Store 进入 failed、不让 Runtime fatal、不波及其他会话；SQLite 约束错误仍是 bug，由应用层校验与无效样例保证不出现（INV-35，R1）。派生行写失败只把 RunDigest 标为 behind，异步补建。接力对象各自的保留期与回收入口见 R7；删除会话在 v13 才有入口（`deleteSession`）。

SQLite [原子提交](https://www.sqlite.org/atomiccommit.html)与[WAL](https://www.sqlite.org/wal.html)是选型参考；持久性还依赖真实磁盘、fsync、journal 设置和故障测试，不能仅凭 SQLite 名称作保证。

### 业务库迁移前备份（[ADR-049](../decisions/0049-business-store-backup-before-migration.md)）

业务库 `gateway.sqlite` 的编号迁移只进不退，没有降级脚本；每次存储版本提升之前由 Store 自动备份一次，供手动回退旧构建。它只在版本提升时发生，不是上文所说的独立备份命令。

- **时机与范围**：Store owner 取得数据根排他锁之后、迁移与接管事务开始之前，在没有事务的状态下读 `user_version`；只有 1～12（将被迁移到 13）才备份。新库（v0）、当前版本（v13）、未知版本（随后以 `INVALID_DATA` 拒绝）与只读的 `SqliteSessionReader` 都不备份。只覆盖业务库：内容存储、Provider、管理库与能力库不在其中，管理库与能力库在 M2 随 OwnerScopedStore 补上。
- **位置与命名**：`<数据根>/backups/gateway-v<原版本>-<UTC yyyymmddThhmmssZ>-<8 位随机十六进制>.sqlite`，例如 `gateway-v11-20261022T080910Z-3fa9c2d1.sqlite`。目录不存在时以 0700 新建；已存在时必须是当前用户所有、不对组和其他用户开放的真实目录（不是链接）。文件 0600。
- **写出与核对**：`VACUUM INTO` 先写到 `<正式名>.partial`，以只读连接回读：`user_version` 等于原版本，`sessions` 与 `events` 行数等于原库（来源 ≥13 时 11 张接力表的行数也要相等），`quick_check` 为 ok；fsync 后才取得正式名字（不覆盖同名文件），再 fsync 目录。正式名字只属于完整且核对过的副本。
- **保留**：最近 2 份。写新副本之前，按文件名中的时间只留最新的 1 份、删除其余，写完正好 2 份；先前崩溃留下的 `.partial` 文件同时删除。HarnessHub 只删除符合这两种命名的普通文件，`backups` 里的其他文件、目录与链接原样保留。备份归用户所有，HarnessHub 不读取、不自动恢复。
- **失败**：任一步失败（目录不合要求、空间不足、源库损坏、回读不一致）时，Store 构造以 `STORAGE_BACKUP_FAILED` 失败，消息写明失败的步骤和不含路径的原因，原错误保留为 cause。此时只删除本次写出的文件；迁移事务没有开始，owner 没有接管（`owner_metadata` 不变），业务库的行与 `user_version` 不变，排他锁释放。修好原因后重新启动，即重新备份并迁移。备份成功而迁移本身失败（例如 `INVALID_DATA` 整笔回滚）时，这份备份保留。
- **手动恢复**：1. 停止服务，等它退出；2. 用一份备份替换数据根中的 `gateway.sqlite`（复制过去，备份本身留在 `backups`）；3. 删除同目录的 `gateway.sqlite-wal` 与 `gateway.sqlite-shm`，它们属于被替换的库，留着会损坏恢复后的库；4. 用能读文件名中那个版本的旧构建启动。若用当前构建启动，它会再次备份并迁移。

**已接受（ADR-055）**：v13 落地时这一节只改三处：备份条件从 1～11 改为 1～12（将被迁移到 13），owner 认的当前版本改为 13（现在的两处是 `sqlite-store.ts:396` 与 `:265`【事实】），回读核对的行数从 `sessions`、`events` 扩到 11 张接力表（`sqlite-store.ts:136–139`）。v12 的源库还没有接力表，扩展的行数核对只对 v13 及以后的源库有意义【推断】。位置、命名、写出、保留、失败与手动恢复都不变；HMAC 密钥 `relay-key` 在数据根之外，不进备份。降级与恢复备份的后果见 R5。

**实现状态（G066，2026-11-09）**：上面三处已改（备份条件 1～12、owner 认 13、来源 ≥13 时回读接力表）。v12→v13 迁移需要约两倍库大小的空闲空间（库加备份；迁移本身只写快照与索引行，WAL 很小），1.16 GB 合成库实测打开共 2.4 s，其中备份约 1.2 s，见 [ADR-049](../decisions/0049-business-store-backup-before-migration.md) 的补充与[验证记录](../verification/relay-g066-2026-11-09.md)。

## 接力存储与事件（已接受（ADR-055），业务库 v13）

本章是 ADR-055 的设计（【建议】）。实现状态：R2 的表与触发器、R4 的迁移、R5 的备份条件与 R6 的断言由 G066 实现（2026-11-09，合成测试）；R1 的写入路径只有存储一侧（`transact` 的 relay 行、`relayWrite`、同意日志与偏好），还没有调用方；R3 的事件仍未实现。读法与切换契约相同：

- 小节用 R 编号。直接取自终稿的段落、表格与 DDL（下称“引文”）保留终稿原文，其中的“第 n 节”“n.m”“§n”都指**终稿**的节号；引文里个别改过的地方，都在原处写明。
- 代码位置的简写：`sqlite-store.ts` 指 `src/infrastructure/session/sqlite-store.ts`，`content-store.ts` 指 `src/infrastructure/session/content-store.ts`，`state.ts` 指 `src/contexts/session/domain/state.ts`，`runtime.ts` 指 `src/contexts/session/application/runtime.ts`。
- 送达、水位、同步状态与恢复的语义在切换契约；本章只写它们怎么存、怎么提交、怎么迁移与回收。

### R0 现状基线（已实现，【事实】）

- 业务库 `gateway.sqlite` 是 v12：新库直接建成 v12（`sqlite-store.ts:457–467`），owner 只认 v12（`:265`），新会话的快照必须是 v12（`:276`），只读的 Reader 认 1～12（`:656`、`:674`）。
- `transact` 在一个事务里读快照、做 `assertSessionTransition`、写事件、以 CAS 整份重写快照（`sqlite-store.ts:343–363`）；读取时快照版本须等于库版本、事件条数须等于 `lastSeq`（`:153–157`）。G075（2026-11-09）起，读取先查快照缓存：只有命中项的 (version, lastSeq) 与行完全一致才使用；未命中，或别的连接提交过（`PRAGMA data_version` 变化，缓存随即清空）时，才做完整读取与这两项核对。
- 事件类型是开放的：类型名只按 `^[a-z][a-z0-9._:-]{0,127}$` 校验，data 是有界 JSON（`sqlite-store.ts:85–106`）；单条 ≤2 MiB + 4,096 B、每会话 ≤16,384 条、日志 ≤32 MiB（`state.ts:18–20`，文档常量）。
- 事务里的 SQLite 错误让 Store 进入 failed（`sqlite-store.ts:625–628`）；Runtime 的 `commit` 遇到意外错误一律 `fail()`（`runtime.ts:796`）。
- **G075 的存储约定（2026-11-09，已实现，不升库）**：
  - 已校验的快照按 (version, lastSeq) 缓存，LRU，上限 96 MiB（按持久化字节计），只在 COMMIT 成功后放入；存储失败或所有者丢失时清空，迁移与恢复绕过缓存。
  - Store 返回的快照深冻结，同一版本由所有读者共享。调用方不得原地修改，要改就先复制；原地修改会抛 TypeError。
  - 同一冻结对象、由 `publicRun` 生成的已终结 Run，不再逐字段重复解析；跨 Run、消息、切换、命令的关系校验仍然全量执行。
  - 事件日志字节在内存里随提交累计，缓存未命中时用一次 `SUM(octet_length)` 重算；持久的计数列原定“若需 DDL 并入 G066 的 v13”，G066 没有加（v13 只加终稿第 14.1 节的 11 张表），仍按内存计数加 `SUM` 回退。
  - Runtime 记住最后读到的 version 做 CAS；遇到 VERSION_CONFLICT 时先读再提交一次，mutate 最多执行一次。

- 恢复：`claimAndRecover` 在一个 `BEGIN IMMEDIATE` 里迁移并恢复全部会话（`sqlite-store.ts:452`、`:577–590`）。
- 迁移前备份只对 1～11 做（`sqlite-store.ts:396`），回读核对 `sessions` 与 `events` 的行数（`:136–139`）。G066 起是 1～12，来源 ≥13 时回读还核对 11 张接力表的行数（见“业务库迁移前备份”）。
- 内容回收：启动时 owner 独占且静止，`content.collect(store.contentReferences())`（`src/cli/session-application.ts:69–71`）；`contentReferences()` 收集工具详情、产物、附件与分支来源里的附件（`sqlite-store.ts:326–342`）；未被引用且超过 7 天的内容删除（`content-store.ts:14`、`:197`）。
- 附件物化为数据根下 `content/files/<id>/<name>` 的稳定只读副本，注释写明是为了让原生会话在以后的回合再读（`content-store.ts:147–172`）。
- 没有删除会话的路径（`src/` 中没有 `DELETE FROM sessions`）；`ContentPort` 没有读接口（`src/contracts/content.ts:97–101`）。

### R1 写入路径与提交点

引文（终稿第 3.2 节）：

**与存储的接口**：`SessionMutation.relay?: RelayRows`，`transact` 在同一事务写快照、事件与 relay 行（`sqlite-store.ts:343–363` 的事务内【事实】），其中派生行（摘要、索引、观测）在 SAVEPOINT 内写入，失败回滚到保存点并把该 Run 标为 behind；权威行（交接单、送达、同意引用）写失败让该 Run 以 `RELAY_PREPARE_FAILED{reason:"storage"}` 失败而不是让事务失败——方法是在 `mutate` 之前完成全部序列化、字节校验与转换校验，使事务内只剩 `INSERT … ON CONFLICT DO NOTHING` 与已校验的 UPDATE（RT2-11、RT3 P04；F08）。另有三条不经快照的写入路径（F07）：`SessionStore.relayWrite(id, rows)`——单独事务、不升 `version`、只写派生行（摘要与索引的懒重建、`relay_deliveries.realized` 的惰性结算），失败只记诊断并留待下次；`RelayLogPort.append(record)`——安装级事务，失败让该同意命令失败（界面 500，不改任何会话）；`RelayLogPort.upsertWindow / setPref`——安装级、最后写入者胜。`SessionStore` 增加只读查询 `relayIndex(id)`（全部索引列）、`relayDigests(id, runIds)`、`relayPacket(id, packetId)`、`relayDeliveries(id)`；`RelayLogPort.consents() / prefs()`；`ContentPort` 增加有界只读 `readText(ref, maxBytes)`（懒重建旧 Run 的摘要用，`contracts/content.ts:97–101` 目前没有读接口【事实】）。

每次交接的提交（据终稿第 6.1 节与第 14.2 节整理）：

| 提交 | 内容 | 失败时 |
|---|---|---|
| 准备事务 | `run.context_prepared{contextReadyAt}` + `run.authorized{readyAt}` + 交接单行（`relay_bodies`、`relay_packets`）+ 送达行（in_flight、位置、`consentLogSeq`、`inputHmac`、`compactionAtDelivery`）+ 绑定 pending + 观测行（SAVEPOINT）；`relay.title_set` 并入，finalize 里做过核对时 `relay.verified` 也并入 | 进入事务之前完成全部序列化、字节与转换校验，事务内只剩 `INSERT … ON CONFLICT DO NOTHING` 与已校验的 UPDATE；权威行写失败只让本 Run 以 `RELAY_PREPARE_FAILED{reason:"storage"}` 失败；观测行写失败回滚到保存点 |
| 派发 | `run.dispatched`，事务内再读同意 | 已撤回 → 不派发，Run 失败 `RELAY_CONSENT_REQUIRED` |
| E1 | `relay.input_recorded` + 送达行 recorded(E1) + 绑定 synced；先冲刷打开的文字窗口，再并入 `run.first_output` 或本回合下一次既有提交，没有输出时并入 `run.ended` | 不单独提交 |
| 结算 | `run.ended` + 送达结论 + 绑定 sync + RunDigest 与索引（SAVEPOINT）；unsafe 时含待决切换 failed 与等待它的排队 Run 的结束 | 派生行失败只标 behind，`run.ended` 照常提交 |
| 恢复 | `session.recovered` + `recoverRelay` 的 relay 变更，在 `claimAndRecover` 的同一事务里按会话各自一个 SAVEPOINT 写入 | 一个会话写失败只把该会话标为 `relay_recovery_failed`，并在打开时拒绝接力 |
| 回合外 | `relayWrite`（懒重建、`realized` 惰性结算）；`RelayLogPort.append`（同意与撤回）；`upsertWindow`、`setPref` | `relayWrite` 失败只记诊断、留待下次；`append` 失败让该同意命令失败（界面 500，不改任何会话）；后两者最后写入者胜 |

派发路径比现状少一次整份快照提交：现状在典型路径上依次提交 preparing、`run.context_prepared`、`run.protocol`、`binding_prepared`、`run.authorized`、`run.dispatched`（`runtime.ts:1332`、`:1341`、`:1369`、`:1384`、`:1389`、`:1415`【事实】），v13 把 `run.context_prepared` 与 `run.authorized` 合为一次（RT3 P15）。每次交接新增事件 ≤3 条加同意镜像 1 条（R3）。

引文（终稿第 6.4 节，派生行的写入与冷路径）：

- **后台维护**：RunDigest 与索引由 `run.ended` 事务里已提交的事实算出：消息取快照，工具详情只取已落库的（earlyClose 跳过 `flushNative`、`storeDetail` 失败只记诊断，`runtime.ts:1452`、`:1263–1266`【事实】），缺的标 `detailsMissing`（RT1-M4、RT2-22）；最后一步 `bound()` 按全局次序截短到 ≤48 KiB（原型 F8：逐字段上限之和 181,512 B【推算】，收紧后病态剖面 29,790 B、p95 1.51 ms【实测】）；序列化字节在 `mutate` 之前校验；写入在 SAVEPOINT 内，失败只把该 Run 标为 `behind` 并异步补建，绝不让 `run.ended` 失败（J2 M3、RT2-11）。`run.ended` 内只对要存储的字段脱敏，扫描总量 ≤0.2 MiB（5.2 N19），另计 ≤3 ms（VF2-03）；摘要用的已知秘密集合是**安装级**的（全部已配置 Harness 的引用值 + Hub 自身环境中的凭据 + 受管 Provider 秘密，10.2），目标新带来的值只在出境前的最终复扫里补上，所以集合变化不再让摘要整体 behind（F06）；摘要记录命中区间 `(ref, offset, length)` 不记值，重建时先套历史区间再扫当前集合，集合变小也不会让曾脱敏的位置复现（VF3-05）；尺寸用脱敏后的文本算并为标签留余量。不调用任何模型。工作区观测不进 `run.ended` 关键路径。懒重建与 `realized` 结算经 `relayWrite`（不升 version，3.2），`realized` 在下次需要 R̂ 时惰性结算（F07）。

- **冷路径**：v13 迁移后或 `behind` 的 Run，在打开选择器或空闲时按 ≤20 ms 的片懒重建，分两级：G3 与区间行只用快照里的 `PublicRun.tools`（不读详情；这一级算不出 verbatim 尺寸，索引把 `size.verbatim` 标为未知，整份直送判定把未知当作放不下，VF2-15）；尾部与锚点才读工具详情（`ContentPort.readText` 有界读取，约 0.1 ms/条，R4 实测；典型 12 条 × 128 个详情约 0.15 s【推算】）；派发最多等 1 s（计入 11.1 的派发增量目标），之后以显式省略账目（`detailsMissing`、`uncounted`）发出，不报错（J2 M7；RT3 P05）。

引文（终稿第 9 节与存储有关的行）：

| 情形 | 语义（所有者 · 上限 · 失败结果 · 用户所见） |
|---|---|
| 派生写入失败 | SAVEPOINT 回滚，RunDigest 标 behind，异步补建；`run.ended` 照常提交（J2 M3）；故障注入：超长钉住、2 万个文件、字段打满的中文摘要、向扫描器注入异常，都不得让 Store 进入 failed（`sqlite-store.ts:626` 的 `this.failed` 只能由真正的存储故障触发，RT1-B6） |
| 正文存储触顶 | 结构上界 64 MiB/会话（256 包 × 256 KiB）；达到时 `RELAY_PREPARE_FAILED{reason:"storage_quota"}`，提供“只发这条消息”；永不因总量让其他会话受影响（ADR-014） |
| 同意日志触顶 | `relay_log` 达到 65,536 行时同一事务轮转：每个 (vendor, scope, session_id) 只保留最新一行，其余移入 `relay_log_archive`；轮转后仍满 → `409 RELAY_UNAVAILABLE{reason:"consent_log_full"}`（F21） |

### R2 v13 的表与列

引文（终稿第 14.1 节的 DDL：与 sessions、events 同库，由 `transact` 在同一事务写入；均为 STRICT；CHECK 只作 bug 断言，上限在应用层按序列化字节先校验、先截断）：

```sql
CREATE TABLE relay_bodies(session_id TEXT NOT NULL REFERENCES sessions(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144), body TEXT NOT NULL,
  PRIMARY KEY(session_id, sha256)) STRICT;                                             -- 按会话计量与回收（RT3 P14、RT1-m2）
CREATE TABLE relay_packets(session_id TEXT NOT NULL REFERENCES sessions(id), packet_id TEXT NOT NULL CHECK(packet_id GLOB 'relay-*'),
  kind TEXT NOT NULL CHECK(kind IN('packet','delta','anchor','resend')), tier TEXT NOT NULL CHECK(tier IN('goal','brief','standard','fidelity','full')),
  complete INTEGER NOT NULL CHECK(complete IN(0,1)), reanchor INTEGER NOT NULL CHECK(reanchor IN(0,1)),
  target_harness TEXT NOT NULL, target_control TEXT NOT NULL, target_model TEXT, target_vendor TEXT NOT NULL, native_epoch INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=from_seq), base_packet_id TEXT, supersedes_packet_id TEXT,
  policy_version TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN('zh','en')), facts_fingerprint TEXT NOT NULL, observation_seq INTEGER,
  body_sha256 TEXT NOT NULL, est_tokens INTEGER NOT NULL, untrusted_tokens INTEGER NOT NULL, user_tokens INTEGER NOT NULL, estimator TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=65536),      -- 只含由正文决定的字段；逐 Run 的在 relay_deliveries（F08）
  PRIMARY KEY(session_id, packet_id), FOREIGN KEY(session_id, body_sha256) REFERENCES relay_bodies(session_id, sha256)) STRICT;
CREATE TABLE relay_deliveries(session_id TEXT NOT NULL, run_id TEXT NOT NULL, packet_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('text_block','single_text')), position_json TEXT NOT NULL CHECK(json_valid(position_json) AND length(CAST(position_json AS BLOB))<=4096),
  consent_log_seq INTEGER, input_hmac TEXT NOT NULL, attach_override INTEGER NOT NULL CHECK(attach_override IN(0,1)), resend_of TEXT,
  redaction_rules_version TEXT NOT NULL, redaction_key_id TEXT NOT NULL, redaction_set_hmac TEXT NOT NULL,            -- 本次渲染的脱敏上下文：逐 Run，不进按正文去重的清单
  compaction_count INTEGER, compaction_digest TEXT,                                                                     -- 送达时的压缩游标（VF1-08）
  outcome TEXT NOT NULL CHECK(outcome IN('in_flight','recorded','not_recorded','unknown')),
  evidence TEXT CHECK(evidence IN('E1','E2','E3','legacy','origin','native')), reason TEXT, decided_seq INTEGER, decided_at INTEGER, verify_ms INTEGER, verified_in_run TEXT,
  realized_requests INTEGER, realized_cache_hits INTEGER, realized_closed_by TEXT CHECK(realized_closed_by IN('compaction','clear','epoch','idle')),
  PRIMARY KEY(session_id, run_id), FOREIGN KEY(session_id, packet_id) REFERENCES relay_packets(session_id, packet_id),
  CHECK((outcome='in_flight') = (evidence IS NULL AND reason IS NULL AND decided_seq IS NULL)),
  CHECK(outcome<>'recorded' OR evidence IS NOT NULL), CHECK(outcome NOT IN('not_recorded','unknown') OR reason IS NOT NULL)) STRICT;
CREATE TABLE relay_digests(session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, run_index INTEGER NOT NULL, policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('current','behind')), secret_set_hmac TEXT NOT NULL,                            -- 失败只标 behind，没有 failed 状态
  index_json TEXT NOT NULL CHECK(json_valid(index_json) AND length(CAST(index_json AS BLOB))<=2048),      -- 窄列在前：定档只读它（RT3 P05）
  digest_json TEXT NOT NULL CHECK(json_valid(digest_json) AND length(CAST(digest_json AS BLOB))<=65536), sha256 TEXT NOT NULL,
  PRIMARY KEY(session_id, run_id, policy_version), UNIQUE(session_id, run_index, policy_version)) STRICT;   -- 升 relay/2 不覆盖旧摘要（RT1-m5）
CREATE TABLE relay_workspace(session_id TEXT NOT NULL REFERENCES sessions(id), observed_seq INTEGER NOT NULL, run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('git','tree','unavailable')), status TEXT NOT NULL, branch TEXT, head TEXT, fingerprint TEXT, duration_ms INTEGER NOT NULL,
  counted_total INTEGER NOT NULL, counted_listed INTEGER NOT NULL,
  files_json TEXT NOT NULL CHECK(json_valid(files_json) AND length(CAST(files_json AS BLOB))<=131072), PRIMARY KEY(session_id, observed_seq)) STRICT;   -- ≤1,000 项（RT3 P04）
CREATE TABLE relay_pins(session_id TEXT NOT NULL REFERENCES sessions(id), pin_id TEXT NOT NULL, message_id TEXT NOT NULL, author TEXT NOT NULL CHECK(author IN('user','assistant')),
  start_offset INTEGER NOT NULL CHECK(start_offset>=0), length INTEGER NOT NULL CHECK(length BETWEEN 1 AND 2048), quote_hmac TEXT NOT NULL,   -- 按位置存，不存原文（F09）；渲染时取原消息子串
  pinned_seq INTEGER NOT NULL, withdrawn_seq INTEGER, PRIMARY KEY(session_id, pin_id)) STRICT;                                                -- 界面写“≤680 字”（RT1-B6）
CREATE TABLE relay_exclusions(session_id TEXT NOT NULL REFERENCES sessions(id), exclusion_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('run','section')), ref TEXT NOT NULL,
  added_seq INTEGER NOT NULL, withdrawn_seq INTEGER, PRIMARY KEY(session_id, exclusion_id)) STRICT;                                           -- RT4 M12
CREATE TABLE relay_windows(harness_id TEXT NOT NULL, control_id TEXT NOT NULL, model_key TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL CHECK(size>0),
  first_turn_used INTEGER, observed_at INTEGER NOT NULL, PRIMARY KEY(harness_id, control_id, model_key)) STRICT;                                 -- model_key 经 normalizeModel；'' 为模型未知（VF2-04）
CREATE TABLE relay_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN('consent','revoke')),
  vendor TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN('global','session')), session_id TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL CHECK(decision IN('acknowledged','goal_only','revoked')), categories_json TEXT NOT NULL CHECK(json_valid(categories_json)),
  policy_version TEXT NOT NULL, auth_kind TEXT, decided_at INTEGER NOT NULL) STRICT;                                                          -- 安装级、只追加（RT1-M9）
CREATE TABLE relay_log_archive(seq INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, vendor TEXT NOT NULL, scope TEXT NOT NULL, session_id TEXT NOT NULL,
  decision TEXT NOT NULL, categories_json TEXT NOT NULL, policy_version TEXT NOT NULL, auth_kind TEXT, decided_at INTEGER NOT NULL, archived_at INTEGER NOT NULL) STRICT;   -- 触顶轮转（F21）
CREATE TABLE relay_prefs(key TEXT PRIMARY KEY CHECK(key IN('relay.crossVendor','relay.returnPreference','relay.allowUnprobed','relay.localModelsOffline')),
  value TEXT NOT NULL CHECK(length(value)<=64), updated_at INTEGER NOT NULL) STRICT;                                                          -- 安装级偏好（F07）
CREATE TRIGGER relay_bodies_immutable BEFORE UPDATE ON relay_bodies BEGIN SELECT RAISE(ABORT,'relay body is immutable'); END;
CREATE TRIGGER relay_packets_immutable BEFORE UPDATE ON relay_packets BEGIN SELECT RAISE(ABORT,'relay packet is immutable'); END;
CREATE TRIGGER relay_log_immutable BEFORE UPDATE ON relay_log BEGIN SELECT RAISE(ABORT,'relay log is append-only'); END;
CREATE TRIGGER relay_deliveries_transition BEFORE UPDATE OF outcome ON relay_deliveries
  WHEN NOT ((OLD.outcome='in_flight') OR (OLD.outcome='unknown' AND NEW.outcome IN('unknown','recorded','not_recorded'))
            OR (OLD.outcome='not_recorded' AND NEW.outcome='recorded') OR (OLD.outcome='recorded' AND NEW.outcome='recorded'))
  BEGIN SELECT RAISE(ABORT,'illegal delivery transition'); END;                                                                               -- 同值写放行：reason 细化与 realized 结算（VF1-12）
PRAGMA user_version=13;
```

各表一览（据终稿第 3、4、9、14 节整理）：

| 表 | 级别 | 一行是什么 | 写入者与提交点 | 上限（应用层先校验） |
|---|---|---|---|---|
| `relay_bodies` | 会话 | 一份交接单正文，按 (session_id, sha256) 去重；不可变 | 准备事务 | ≤256 KiB/条（CHECK 262,144）；结构上界 64 MiB/会话（256 包 × 256 KiB） |
| `relay_packets` | 会话 | 一份交接单的清单，只含由正文决定的字段；ID 由正文派生；不可变 | 准备事务，`INSERT … ON CONFLICT(session_id, packet_id) DO NOTHING` | 清单 ≤64 KiB |
| `relay_deliveries` | 会话 | 一个 Run 的送达：位置、逐 Run 的清单字段（同意 seq、输入 HMAC、送达时的压缩游标、重发关系、`attach_override`）、结论与 `realized` 计数 | 准备事务插入 in_flight；E1、结算、核对、恢复按允许表更新；`realized` 经 `relayWrite` 惰性结算 | 位置 ≤4 KiB；每 Run 至多一行 |
| `relay_digests` | 会话 | 一个已终结 Run 的 RunDigest 与约 200 B 的索引，按 `policy_version` 分行 | `run.ended` 事务的 SAVEPOINT；懒重建经 `relayWrite` | 摘要收紧后 ≤48 KiB（CHECK 65,536 只作断言）；索引 CHECK 2,048 B，字段各有字节预算与收紧次序 |
| `relay_workspace` | 会话 | 一次交接边界的工作区观测 | 准备事务的 SAVEPOINT | ≤1,000 项（`files_json` ≤131,072 B） |
| `relay_pins` | 会话 | 一个钉住：按 (message_id, offset, length) 存位置，不存原文 | 用户命令 | ≤24 个、每个 ≤2,048 字节、合计 ≤12,288 字节（界面写“≤680 字”） |
| `relay_exclusions` | 会话 | 一个排除（轮次或节） | 用户命令 | 终稿未写 |
| `relay_windows` | 安装 | 一个 (harness, control, model_key) 的窗口与首回合用量；`model_key` 经 `normalizeModel`，`''` 为模型未知 | `upsertWindow`（含回合外的 `usage_update`），最后写入者胜 | 每个键一行 |
| `relay_log` | 安装 | 一条同意或撤回，自带 seq，`command_id` 唯一；只追加 | `RelayLogPort.append` | ≤65,536 行，触顶在同一事务轮转 |
| `relay_log_archive` | 安装 | 轮转出去的旧同意记录 | 轮转事务 | 终稿未写 |
| `relay_prefs` | 安装 | 一项安装级偏好 | `setPref`，最后写入者胜 | CHECK 限 4 个键，值 ≤64 |

引文（终稿第 14.1 节）：

正文放业务库而不是内容存储：与登记同事务、免去第二个库的 fsync（内容存储写约 8.2 ms/条，R4 实测），也避开 7 天回收器（`CONTENT_RETENTION_MS`，`content-store.ts:14`【事实】）。`relay_bodies` 按 (session_id, sha256) 去重，重发与预取在同一会话内复用正文；删除会话（v13 新增 `deleteSession`，同一事务回收全部 relay 行）与 `relay_bodies` 的会话主键一致。交接单以 `INSERT … ON CONFLICT(session_id, packet_id) DO NOTHING` 入库（`INSERT OR IGNORE` 会连 CHECK 违例一起吞掉，随后外键错误让 Store failed，VF4【实测】）：ID 由正文派生，所以同 ID 必然同正文；逐 Run 的字段（同意 seq、输入 HMAC、送达位置、压缩游标、重发关系）在 `relay_deliveries`，两个 Run 发同一份正文时各有自己的清单行（F08）；清单头（全部渲染输入）相同而字节不同的情形在进入事务之前检出，只让该 Run 以 `RELAY_PREPARE_FAILED{reason:"render_mismatch"}` 失败（RT1-M6、RT2-11），确定性交给 CI 的“渲染 100 次只得 1 个 sha”。写 `relay_packets` 时校验 fold（替代 K7 对 `sourceRunIds` 的校验，RT1-M1、F12）：每个 fold 单元指向的 Run 已终结，其用户消息的 seq 早于当前输入；不满足即 `RELAY_PREPARE_FAILED{reason:"render"}`。送达行的转换先在应用层按 §4 的允许表校验，触发器只作断言；`UPDATE` 只在 outcome 变化时才把它写进 SET，细化 reason 与结算 realized 不带 outcome（VF1-12）。钉住在写入时检查上限：≤24 个、每个 ≤2,048 字节、合计 ≤12,288 字节。`relay_log` 达到 65,536 行时同一事务轮转到 `relay_log_archive`（第 9 节）。

`relay_prefs` 的 CHECK 允许 4 个键（`relay.crossVendor`、`relay.returnPreference`、`relay.allowUnprobed`、`relay.localModelsOffline`），四个都是这张表的行、都可经 `PUT /api/v1/relay/prefs` 写入（终稿第 3.1、12.4 节）：`relay.returnPreference ∈ {continue, new_when_cold, ask}`（默认 `continue`）；`relay.localModelsOffline` 对应第 10.4 节设置页上的“本机模型不出网”，是 INV-33 登记过的唯一免同意例外；`relay.allowUnprobed` 是开发用的，不在设置页露出、只经 API 或 CLI 设置，默认 false（D11）。

**快照的增补（v13）**（引文，终稿第 4 节）：

`session.ts` 增补（v13）：`NativeSessionBinding.relay: BindingRelayState`（`throughRunId` 保留，语义收紧为“原生位置”；archived 绑定的 `relay` 冻结，RT1-B2）；`PublicRun.relay?: { packetId: RelayPacketId | null; kind: RelayPacket["kind"] | null; continuity: ContinuityLevel; executedOn: RunDigestIndex["executedOn"] }`、`PublicRun.relayRequest?: { tier?; attach?; native?; resend?; fingerprint: Fingerprint }`（附言、放行与排除的正文在 relay 表，VF2-14），新 Run 的 `sourceRunIds` 写空数组（旧数据照读；`state.ts:359–361` 对 `sourceRunIds` 的校验由 `relay_packets` 写入时的 fold 校验替代：每个 fold 单元的 Run 已终结、其用户消息早于当前输入，F12）；`BackendResult.native?` 为瞬时字段，v13 把它的结论写进 `run.ended.data.native`，不进快照；`ContinuityLevel` 从字符串改为对象，解析器同时接受 v12 事件里的旧字符串（`runtime.ts:275`【事实】，F20）；`PublicSwitch` 增加 `mode: "wait_current" | "cancel_current"`、`timing`、`acknowledgedUnknown: readonly RunId[]`（解析器同时接受旧切换的 `sourceRunIds`，`state.ts:340–342` 两者都认【事实】；每个 ID 须是 status=unknown、`cleanup.closed=true`、用户消息早于 `requestedSeq` 的 Run，且只能出现在恢复切换上，RT1-m10）；`RunTiming` 增加 `contextReadyAt`，单调链为 `preparingAt → contextReadyAt → readyAt → dispatchedAt → firstOutputAt → endedAt`（`state.ts:148` 的 `TIMING_PHASES`【事实】），`recordedAt`（E1 时刻）只约束 `dispatchedAt ≤ recordedAt ≤ endedAt`、不入单调链，也不设置 `firstOutputAt`（RT2-21）；`CommandRecord.kind` 增加 `relay-pin`、`relay-unpin`、`relay-exclude`、`relay-include`、`relay-consent`、`relay-consent-revoke`、`relay-redaction-override`、`relay-title`。

快照增量的上限是每绑定 ≤1,024 B、每 Run ≤320 B，用最长合法值断言（`gateway:<253 字符>`、最长 ID、pending 加 suspect prior）；`relayRequest` 的附言、放行与排除只留指纹在快照，正文进 relay 表（VF2-14）。新字段只放引用，8 MiB 的快照上限不变（`state.ts:17`【事实】，文档常量）。

**送达行的转换**：允许 in_flight→{recorded, not_recorded, unknown}、unknown→{recorded, not_recorded}、not_recorded→recorded（只由后续正面证据触发），以及 unknown→unknown、recorded→recorded 的同值写（reason 细化、realized 结算）。应用层先按此表校验，`UPDATE` 只在 outcome 变化时才把它写进 SET，触发器 `relay_deliveries_transition` 只作断言（VF1-12）；同值写不算转换（INV-31）。结论的取值与语义见切换契约 R2.3。

### R3 新增与扩展的事件及其幂等键

**新增事件**（数据形状与幂等键见第 14.2 节）：`relay.input_recorded`、`relay.verified`、`relay.pin_added`、`relay.pin_withdrawn`、`relay.exclusion_added`、`relay.exclusion_withdrawn`、`relay.consent_recorded`、`relay.consent_revoked`（会话镜像；权威在安装级 `relay_log`）、`relay.redaction_overridden`、`relay.vendor_changed`、`relay.title_set`；扩展 `run.context_prepared`、`run.ended`、`run.native_command`、`message.accepted`（带 `relayRequest`）、`switch.*`、`session.recovered`。

引文（终稿第 14.2 节；`run.ended` 一格按第 9 节改过，见表后说明）：

| 事件 | 数据 | 幂等键 · 提交点 |
|---|---|---|
| `run.context_prepared`（扩展） | `throughSeq`、`range`、`continuity`、`relay{packetId, kind, tier, complete, reanchor, channel, estTokens, untrustedTokens, userTokens, omissions 汇总, redactions, unscanned, verified?, returnChoice?, source}`、`workspace{kind, status, dirty, unattributed, fingerprint, neutralized}`、`timing.buildMs/observeMs/verifyMs`；不再带全量 `sourceRunIds` | runId · 与 `run.authorized`、交接单行、送达行(in_flight, position)、绑定 pending、观测行同一事务（RT3 P15） |
| `relay.input_recorded`（新） | `runId`、`packetId`、`recordedAt` | (runId, packetId)，Driver 只发首个 · 先冲刷打开的文字窗口，再并入 `run.first_output`（本就是独立事务，`runtime.ts:1175`【事实】）或本回合下一次既有提交；没有输出时并入 `run.ended`；同一事务把送达行改为 recorded(E1)、绑定改为 synced（写者就是本 Run，J1 M3 允许；RT1-M2）；不设置 `firstOutputAt`；ADR-047 第 5 条补一条修订（RT2-21） |
| `relay.verified`（新） | `verifiedRunId`、`markers: [{packetId, result: present ｜ absent ｜ outside_window ｜ compacted ｜ unavailable}]`、`historyEmpty`、`compaction{count, digest}`、`result: … ｜ nothing_owed`、`inRunId`、`foreignAfterLast`、`verifyMs` | (verifiedRunId, inRunId) · 与发起核对的 Run 的 `run.context_prepared` 或 `run.ended` 同事务 |
| `run.ended`（扩展） | `delivery{packetId, outcome, evidence, reason}`、`input`、`commandEffect?`、`native{cleared, replaced}?`、`relayResendOf?`、`binding{sync 前后, nativeEpoch, epochFloor, packetsInEpoch}`、`digest{status}` | runId · 与绑定状态、送达结论、RunDigest 与索引（SAVEPOINT）同事务；unsafe 时同一事务含 `switch.failed{SWITCH_SOURCE_UNKNOWN}` 与等待它的排队 Run 以 `SWITCH_NOT_EFFECTIVE` 结束（终稿 §14.2 此处写“排队 Run 的 cancelled”，按 §9、§0 改，见 R3 说明） |
| `run.native_command`（扩展） | 增加 `contextEffect`、`argsClass`、`executed: true ｜ false ｜ unknown`（效果只在 executed 时生效，VF1-05） | runId · 现有（提交点前移到 authorized 之前） |
| `message.accepted`（扩展） | 增加 `relayRequest{tier, attach, native, resend, fingerprint}`（RT2-19，F12；`fingerprint` 是 HMAC 会话子密钥对全部选项的 `HmacDigest`，不是未加盐 sha256，INV-29） | runId · 现有 |
| `switch.requested/validated/effective/failed`（扩展） | `mode`、`timing`、`acknowledgedUnknown`、失败原因 `SWITCH_SOURCE_UNKNOWN` | switchId · 现有 |
| `session.recovered`（扩展） | 增加 `relay{deliveries: [{runId, outcome}], bindings: [{harnessId, controlId, sync}]}`；被它终结的 Run 以本事件的 seq 作事实 seq（VF1-15） | 恢复 · `claimAndRecover` 的同一事务，按会话 SAVEPOINT（RT2-06、VF1-12） |
| `relay.pin_added` / `relay.pin_withdrawn` | `pinId`、`messageId`、`author`、`offset`、`length`、`quoteHmac`（不含原文，F09） | commandId · 用户命令 |
| `relay.exclusion_added` / `relay.exclusion_withdrawn` | `exclusionId`、`kind`、`ref`；撤回只影响之后渲染的包，水位已越过被排除 Run 的绑定不再补交，界面写明（VF1-14、F21） | commandId · 用户命令（RT4 M12） |
| `relay.consent_recorded` / `relay.consent_revoked`（会话镜像） | `logSeq`、`vendor`、`scope`、`decision`、`categories`、`policyVersion`、`authKind` | commandId · 权威在 `relay_log`，镜像与它同事务或更晚 |
| `relay.redaction_overridden` | `runId`、`ref`、`offset`、`length`、`tag`（HMAC 前 8 位） | commandId · 用户命令；不含值与值的哈希 |
| `relay.vendor_changed` | `harnessId`、`controlId`、`from`、`to`、`observedInRun` | runId · 发现时的提交 |
| `relay.title_set` | `harnessId`、`controlId`、`result: set ｜ refused ｜ unavailable` | runId · 与 `run.context_prepared` 同事务（标题在首个提示之前回写，VF3-12） |

每次交接新增事件 ≤3 条（`input_recorded`、`verified`、`title_set`；扩展字段不算新事件）+ 请求带 `relay.consent` 时的同意镜像 1 条（VF2-08）；普通回合 0 条。v12 的事件类型是开放的（`sqlite-store.ts:85–106`【事实】），P0 新增 `contextEffect`、`input` 字段与 `relay.input_recorded` 不必升库。

说明：

- `run.ended` 一格：终稿第 14.2 节写“unsafe 时同一事务含 `switch.failed{SWITCH_SOURCE_UNKNOWN}` 与排队 Run 的 cancelled”，第 9 节与第 0 节写等待它的排队 Run“记为 `SWITCH_NOT_EFFECTIVE`”（RT2-04 的修正）。本契约按第 9 节，与切换契约 R1.1 一致；该错误码现有的用法是 status 为 failed（`runtime.ts:1308–1310`【事实】）。
- 终稿第 4 节的“新增事件”一段没有列 `message.accepted` 的扩展，第 14.2 节的表列了；以表为准。
- 事件类型开放（R0），所以 P0（v12）在 `run.ended` 里新增 `input`、`contextEffect` 与 `relayResendOf`（切换契约 R3.6）都不必升库；`BackendResult.input` 在 v12 持久化前剥离（`state.ts:95` 的白名单不变【事实】），只留在事件数据里，供 v13 迁移作直接证据（RT1-B1）。
- `relay.consent_*` 是会话镜像，权威在安装级 `relay_log`；镜像与它同事务或更晚提交，交接单记录依据的 `consentLogSeq`，同意行与它支撑的 `run.context_prepared` 同事务或更早提交（终稿第 10.4 节）。
- 用户命令类事件以 `commandId` 去重，`CommandRecord.kind` 新增 `relay-pin`、`relay-unpin`、`relay-exclude`、`relay-include`、`relay-consent`、`relay-consent-revoke`、`relay-redaction-override`、`relay-title`（终稿第 4 节）。
- 接力事件与 SSE 不含交接单正文、秘密原值与原值的未加盐哈希；relay 字段里凡可能对应秘密的值一律用 HMAC 子密钥（INV-29，R8）。

### R4 迁移（v12 → v13）

引文（终稿第 14.1 节）：

**v13 需要改动的代码点**（RT1-m1）：`sqlite-store.ts:396`（备份条件 1–12）、`:265`（owner 版本 13）、`:276`（create）、`:456`（白名单）、`:457–467`（v0 直接建 v12 并以 `version >= 1` 守卫后续迁移块，必须改为直接建 v13 含 relay 表，否则新库永远没有 relay 表、`assertOwner` 随即 OWNER_LOST）、`:656`/`:674`（Reader）、`:136–139`（备份回读扩到 11 张 relay 表）、`:577–590`（`claimAndRecover` 调用 `recoverRelay` 并按会话 SAVEPOINT）；`state.ts:279` 与 `:95`、`:151`、`:165`、`:197`、`:228` 的 keys 白名单；`state.ts:418–424` 放行带 `native.cleared` 的归档；`runtime.ts:271`、`:331`、`:440` 的 `schemaVersion: 12`。

引文（终稿第 14.4 节；建表数按第 14.1 节改过，见下）：

- 迁移事务：建第 14.1 节 DDL 的 11 张表与 4 个触发器（终稿 §14.4 在写入阶段已从“9 张表”改正）；快照升到 13（解析器显式接纳 `backend.input`；`binding.relay`、`run.relay`、`run.relayRequest`、`switch.*` 均有解析器，v12 快照照常可读）；为每个绑定按来源推断 `relay`（RT1-B1、RT1-B2、RT5-08）：
  - **导入绑定与分支绑定**（ready、fork-pending、forking；它们没有 `binding_prepared{resumed:false}`，`runtime.ts:331–335`、`:440–442`【事实】）：`originIncluded=true`、`synced{throughSeq: 0, basis: origin, lastPacketId: null}`、`nativeEpoch=1`。
  - **纪元谱系**（F02、VF3-14；第二版只给导入、分支与清空过的绑定定了纪元）：对每个 (harnessId, controlId) 按事件顺序重放——每个 `binding_prepared{resumed:false}`、每个 `native.branch_requested`（native-reset）、每个归档各开一段，段内每个已执行的清空类命令（`run.native_command` 的 `contextEffect=clear`，按 R0d 记录；更早的 v12 事件按 Driver 目录的命令名回推）再加 1；纪元从 1 起跨段单调递增，archived 绑定得到它那一段的纪元；每个已派发 Run 的 `executedOn.nativeEpoch` 取其派发时所在的段与段内计数，写进 `relay_digests.index_json`（不回填摘要正文）。这样 v12 下“10 轮 → native-reset → 新绑定首条 `/compact`”迁移后旧 10 轮在纪元 1、新绑定在纪元 2，旧回合是外来事实而不会被当成亲历；单 Harness 对话里 `/clear` 之后的回合在新纪元里，不会在升级后作为增量发回同一个原生会话。
  - **其余绑定**：从该绑定最后一次 `binding_prepared{resumed:false}` 起扫描其 Run；“携带回合”须同时满足：`context_prepared.sourceRunIds` 非空或 `context_prepared.carriedOrigin` 为真（G067 起记录；此前只携带来源历史的回合没有这个标志，按未携带处理，偏保守）、该 Run 没有 `run.native_command`、有 `run.dispatched`、`backend.reason` 不是 `request_rejected` 或 `model_not_applied`、状态不是 unknown 或 cancelled、不晚于 `throughRunId`；水位取这些携带回合所含来源 Run 的 `run.ended` seq 最大值；本绑定自己派发且结论非 not_recorded 的内容回合按 native 推进。最后一个携带回合之后出现过清空类命令 → `fresh{user_cleared}`、`epochFloor=该命令 Run 的 run.ended seq`、纪元按谱系；计算迁移后的 need：need=∅ → `synced{basis: legacy, chain: sha256("")}`（RT1-m6 的 legacy chain，F12；legacy 水位——及其纪元内由它派生的回退水位——在 `/undo` 之后不可核验，因为 v12 信封没有可查的标记：这是迁移的固有局限，写进发布说明，出路是新开原生会话，N1）；need≠∅ 且之后出现过原生命令、`request_rejected`、`model_not_applied` → `suspect{cause: legacy}`，否则 `synced{basis: legacy}`（欠交在下一内容回合补交，带去重行）。`compactionSeen` 初值 {0, null}；`vendorObserved` 取最后一次 `binding_prepared` 的 observed（端点为 null，首次受理按 `unknown:<harnessId>` 或目录缓存）。
  - archived 绑定：`relay` 取与最近状态一致的冻结值，纪元按谱系。
  - 性质（属性测试，对随机生成的 v12 日志）：迁移后的 `mark.throughSeq` 不超过真实送达或亲历；只降不升；纪元跨绑定单调；单一 (harness, control) 的 v12 会话迁移后 20 轮 `dispatched === input`（VF3-14）；每种绑定来源各配一个 v12 夹具（含 D1 形态、派发前失败、插入前拒绝、导入、分支、清空、“reset + D1”）。
- 历史 RunDigest 不回填，`status=behind`，按 6.4 懒重建；结果为 unknown 的回合因 earlyClose 没有工具详情（R4 D15），重建标 `detailsMissing`，不当成“没有工具”。
- 新 Run 不再写全量 `sourceRunIds`；新切换只写 `acknowledgedUnknown`，解析器同时认旧切换的 `sourceRunIds`（K19，`state.ts:340–342`【事实】）；`acknowledgedUnknown` 的每个 ID 按 RT1-m10 校验；基准分新旧会话报告 200 次切换的解析时长（J1 M9）。
- 迁移时长：按 seq 直接扫描 events 表（不用分页读事件时整份解析快照的路径，`sqlite-store.ts:171–172`【事实】）；整库一个事务，WAL 加备份约需两倍库大小的空间，写进 ADR-049 的补充；在合成 ≥1 GiB 事件库上实测后决定是否按会话分批（仍在开始服务之前完成）；“首次打开时惰性推算”不采纳（与 `:154` 快照版本须等于库版本、`:424` 写者规则冲突，RT1-m7）。

说明：第 14.1 节的 DDL 是 11 张表与 4 个触发器（`relay_log_archive`、`relay_prefs` 是第三版按 F21、F07 新增的），第 3.1、14.4 节与 G066 的范围现在都写 11 张；备份回读扩到 11 张 relay 表只对 v13 及之后的来源库有意义，v12→v13 迁移前的备份没有这些表。迁移推断绑定状态所用的同步状态、纪元与清空下限，语义见切换契约 R3 与 R4（事件 m）。

### R5 备份与降级（ADR-049）

引文（终稿第 14.4 节）：

- 备份条件从 `1–11` 改为 `1–12`（`sqlite-store.ts:396`【事实】）；owner 版本检查改为 13（`:265`【事实】）。
- **降级**：无原地脚本；v12 构建遇 v13 以未知版本拒绝；按 ADR-049 手动恢复备份（停服、替换 `gateway.sqlite`、删 `-wal`/`-shm`、旧构建启动）。恢复备份即回到升级那一刻：升级之后的全部对话、Run、消息都会丢失，它们引用的附件与详情在内容存储里 7 天后被回收（`content-store.ts:13–14`、`:197`【事实】）；本稿不提供不丢数据的降级导出（第 19 节）。迁移失败整笔回滚、备份保留。

- 迁移前备份的其余规则（位置、命名、写出与核对、保留 2 份、失败、手动恢复）不变，见上文“业务库迁移前备份”。
- HMAC 密钥 `relay-key` 放在数据根与业务库之外、不导出、不进备份（D5），所以恢复备份不会改动它【推断】；它的异常语义（长度不对、权限不对、属主不对时修复或轮换）见 R7 的清理所有者表与终稿第 10.2 节。
- 迁移所需空间：整库一个事务，WAL 加备份约需两倍库大小的空间，写进 ADR-049 的补充（R4）。

### R6 contentReferences()

引文（终稿第 14.4 节）：

- `contentReferences()`（`sqlite-store.ts:326–342`【事实】）：relay 表按设计不存 `ContentRef`，回收集合不变；测试断言 relay 行中没有 `ContentRef` 形状的对象（不用 `content-` 字面匹配，正文里会正常出现 `content-store.ts`，RT1-m9）。

- 现状【事实】：`contentReferences()` 遍历全部会话，收集 `run.tools[].detail`、content 类的 `run.outputs[]`、`run.attachments[]` 与 `origin.history[].attachments[]` 的内容 ID（`sqlite-store.ts:326–342`）；回收在启动时执行（R0）。
- v13 不改这个集合：交接单正文在 `relay_bodies`（业务库），不进内容存储，所以也不受 7 天回收器影响；懒重建读旧 Run 的工具详情（`ContentPort.readText`）时，这些详情仍被它们所属的 Run 引用，不会先被回收【推断】。

### R7 保留期限

| 对象 | 位置 | 保留与回收 | 上限 |
|---|---|---|---|
| 会话级接力表（`relay_bodies`、`relay_packets`、`relay_deliveries`、`relay_digests`、`relay_workspace`、`relay_pins`、`relay_exclusions`） | 业务库 | 随会话删除：v13 新增 `deleteSession`，同一事务按 session_id 回收全部 relay 行；现状没有删除会话的路径（R0），在此之前一直保留 | 见 R2 |
| `relay_bodies` | 业务库 | 同上；不进内容存储，不受 7 天回收器影响；重发与预取在同一会话内复用正文 | 结构上界 64 MiB/会话，触顶 `RELAY_PREPARE_FAILED{reason:"storage_quota"}` |
| `relay_digests` 的旧策略版本 | 业务库 | 升 `relay/2` 不覆盖旧摘要（主键含 `policy_version`）；旧版本摘要何时回收，终稿没有写 | — |
| `relay_pins`、`relay_exclusions` 的撤回 | 业务库 | 撤回只写 `withdrawn_seq`，行不删 | 见 R2 |
| `relay_windows` | 业务库（安装级） | 最后写入者胜；预算只读 30 天内的值；终稿没有写删除 | 每个键一行 |
| `relay_log` | 业务库（安装级） | 只追加、不删除，撤回追加一行；达到 65,536 行时同一事务轮转到 `relay_log_archive`，每个 (vendor, scope, session_id) 只保留最新一行；轮转后仍满 → `409 RELAY_UNAVAILABLE{reason:"consent_log_full"}` | 65,536 行 |
| `relay_log_archive` | 业务库（安装级） | 终稿没有写回收 | — |
| `relay_prefs` | 业务库（安装级） | 最后写入者胜 | 4 个键 |
| 内容存储（附件、工具详情、产物） | 数据根 `content` | 不变：未被引用且超过 7 天的回收（`content-store.ts:14`、`:197`【事实】）；接力表不增加引用 | 不变 |
| 附件物化目录 | 现状是数据根 `content/files/<id>/<name>` 的稳定只读副本（`content-store.ts:147–172`【事实】）；D5 改为 `os.tmpdir()` 下每个会话一个 0700、名字 ≥128 bit 随机的目录，目录内仍是 ADR-023 的稳定只读副本（内容寻址、每次授权前复核、缺失即重新物化，后续回合按同一路径仍可读） | 随会话删除路径一并删除；启动时清理没有对应会话的残留 | — |
| HMAC 密钥 `relay-key` | 数据根与业务库之外（macOS：`~/Library/Application Support/HarnessHub/relay-key`，D5） | 不导出、不进备份；异常时修复或轮换 | 1 个文件，32 字节，0600 |
| 业务库备份 | `<数据根>/backups` | 不变：最近 2 份（ADR-049） | — |
| 预取 LRU | 内存，RelayCoordinator 所有 | `close()` 清空；事实指纹变化、同意撤回或会话关闭即失效 | 全局 ≤32 项、≤8 MiB，单会话 ≤8 项 |

引文（终稿第 9 节清理所有者表的相关行）：

| 资源 | 所有者 | 上限 | 关闭入口 |
|---|---|---|---|
| 预取 LRU | RelayCoordinator | 全局 ≤32 项、≤8 MiB，单会话 ≤8 项 | `close()` 清空；Runtime `close()` 等待 |
| 懒重建队列 | RelayCoordinator | 每片 ≤20 ms，队列 ≤256 Run | `close()` 可等待 |
| 交接单行、送达行、摘要行、观测行 | Store | 正文结构上界 64 MiB/会话、摘要 ≤48 KiB/Run、观测 ≤1,000 项/行 | 随会话删除路径（v13 新增 `deleteSession`，同一事务按 session_id 回收正文；现状 src 无 DELETE FROM sessions【事实】） |
| 同意记录 | RelayLog（安装级） | 只追加，≤65,536 行，触顶轮转到归档表 | 不删除；撤回追加一行 |
| HMAC 密钥 | RelayKeys（安装级） | 1 个文件，0600，数据根与业务库之外（D5） | 属主是本用户而权限不对 → 改回 0600 并告警；否则轮换、写新 `keyId`、提示放行须重新确认（VF3-17） |
| 附件物化目录 | ContentStore | 数据根之外、每个会话一个 0700、名字 ≥128 bit 随机的目录（`os.tmpdir()` 之下，D5）；保留 ADR-023 的稳定只读副本语义 | 随会话删除路径一并删除；启动时清理没有对应会话的残留 |
| 文件视图目录（v1.1） | RelayFiles | 按 relay_packets 回收 | 撤回同意或删除对话时停止供给并留墓碑 |

附件物化目录按会话建立之后仍是稳定副本：原生会话在以后的回合里按同一路径再读同一附件仍读得到（缺失即重新物化，每次授权前复核摘要），与现状注释写明的用途一致（`content-store.ts:147–150`【事实】）；只是位置从数据根的 `content/files/` 改到数据根之外的会话目录，随会话删除（D5，写入阶段修订）。

### R8 不变量与验证

引文（终稿第 14.3 节中与存储有关的行）：

| ID | 内容 | 验证 | 计划用例 |
|---|---|---|---|
| INV-13（改） | 交接单不可变、ID 由正文派生；清单逐项记录全部渲染输入（来源区间、策略与渲染器版本、事实指纹、观测指纹、语言、摘要状态、脱敏上下文、用户编辑与放行），逐 Run 的同意 seq 与当前输入指纹在送达行；满足恒等式的省略账目、脱敏计数；每条可交接的有效事实要么被渲染，要么被计数，要么记入“未统计”；写入时校验 fold 单元已终结且其用户消息早于当前输入 | 属性测试（J1 M11）；重渲染 100 次 1 个 sha | G070-P01（property）、G070-C01（unit）、G066-C03（integration，fold 校验） |
| INV-22（改） | 同一 `policyVersion` 与同一脱敏上下文下，RunDigest 与交接单可由公共事实（快照、事件、已落库的内容）加已落库的工作区观测逐字节重建；摘要只由已提交的事实生成；摘要记录命中区间，重建先套区间；`harness_note` 只保证可追溯 | 500 个随机会话增量 = 重建；故障注入（earlyClose、storeDetail 失败）下重建值与在线值相同 | G070-P02（property）、G070-C06（integration） |
| INV-29（改） | 跨 Harness 发出的内容先经已知秘密精确匹配（按名定集合、10 种形式、骨架视图、ANSI 先删）与形状规则脱敏，当前输入（第二段）除外；扫描器出错即不发；出境字节、`relay_*` 表、`relay_log`、接力事件、日志与诊断、错误信息不含秘密原值及其未加盐哈希；钉住按位置存不存原文 | grep 原值、sha256/sha1/md5(原值) = 0；变异测试；RD-01–RD-10 | G070-S01…S10（security，RD-01–RD-10）、G073-S01（security，AP-01–AP-03） |
| INV-31（新） | 一个 Run 至多携带一份交接单（增量可含要点小节）；送达结论只由逐回合证据决定，与终态无关；送达结论不写进已终结的 Run；正面证据可纠正 unknown 与 not_recorded；同值写不算转换 | 独立表转换测试（J1 M3）；触发器无效样例 | G066-C04（integration） |
| INV-35（新） | 任何 relay 行的上限在进入事务前按序列化字节校验；转换在应用层先校验；派生行在 SAVEPOINT 内；**预期内的接力失败**（校验、渲染、脱敏、配额、分类、同意）只让本 Run 失败，不让 Store 进入 failed、不让 Runtime fatal、不波及其他会话；SQLite 约束错误仍是 bug，由应用层校验与无效样例保证不出现（F08） | 故障注入：超长钉住、2 万文件、字段打满的中文摘要、ID 冲突、扫描器异常、unknown 同值写，Store 均不 failed | G066-C05（integration） |
| INV-36（新） | 数据根、HMAC 密钥与工作区按 `(st_dev, st_ino)` 互不包含是跨厂商交接的前提；包含时受理即失败并提示；附件物化目录与密钥不在数据根内 | WS-05、WS-06 | G071-S01（security，WS-01–WS-06）、G072-S01（security，admit 的数据根检查） |

**INV-29 的范围**（RT1-M12、RT4 M2）：覆盖出境字节、`relay_*` 表、`relay_log`、接力事件的新增字段、日志与诊断、错误信息；不覆盖按设计逐字保存的公共事实（快照里的原话与回复、`run.output`）。relay 字段里凡可能对应秘密的值（原话指纹、发出字节指纹）一律用 HMAC 子密钥，不用未加盐 sha256。测试：在 relay 表、relay 事件、正文、日志中 grep 原值、sha256(原值)、sha1、md5，均为 0（原型 5d：0【实测】）。现有命令指纹 `sha256(JSON)`（`runtime.ts:783`、`session-application.ts:30`【事实】）含审批答复的 `secret` 输入与发送原文，属于接力范围之外的既有机制，登记为已知违例并建议独立 ADR 迁移为 HMAC（第 20 节 Q19）。

**RunTiming 新阶段**：`contextReadyAt` 进入单调链；E2、E3 的时刻记在 `relay_deliveries.decided_at`（事件共用提交时间戳，`sqlite-store.ts:594–598`【事实】，测不出 E2 的 2 s，RT1-m6）；诊断视图（ADR-037）按 Run 展示准备耗时、证据级别与时延、注入 token 估算与实际、缓存写入量。

计划用例（终稿第 17 节；登记进 `plan/test-cases.json` 后由设计检查核对）：G066-C01 迁移夹具 × 7 种来源；G066-C02 随机 v12 日志迁移后 `mark.throughSeq ≤ 真实送达或亲历`，且单一 (harness, control) 会话 20 轮 `dispatched === input`；G066-C03 `relay_packets` 写入的 fold 校验；G066-C04 送达行转换与触发器的无效样例；G066-C05 故障注入下 Store 不 failed；G066-C06 `assertSessionTransition` 新规则的无效样例；G066-C07 `relayWrite` 不升 version、与并发 `transact` 不互相覆盖；G066-C08 快照增量上限；G066-C09 `relay_log` 轮转与 `relay_prefs` 读写；G066-C10 `src/contracts/relay.ts` 与 C006 的 Schema 等价检查；G068-C08 恢复按会话 SAVEPOINT；G070-P02、G070-C06 重建与命中区间；G075-C01–C03 存储优化前置片（受理→派发、缓存一致性、终态 Run 校验跳过）。

### R9 待拍板与未决

- **D5**（推荐 (a)）：`relay-key` 放在数据根之外（macOS：`~/Library/Application Support/HarnessHub/relay-key`），附件物化目录按会话建在 `os.tmpdir()` 下（0700、名字不可猜测），保留 ADR-023 第 3 条的稳定只读副本语义，随会话删除，不再每个 Run 一个目录；(b) 都留在数据根，会把数据根路径随附件指针交给目标，同用户的目标顺着路径能读 `gateway.sqlite`。
- **D8**（推荐 (a)）：本版只做数据根与工作区互不包含的检查、失败与提示，默认数据根移出工作区另立 ADR（改默认值牵动现有部署的数据位置）。
- **Q6**：v13 迁移时长（按 seq 扫描事件；每会话 ≤16,384 条、32 MiB）与 WAL 空间，决定整库一个事务还是按会话分批（都在开始服务前完成）；在合成 ≥1 GiB 事件库上实测。
- **Q7**：新字段让快照变大，8 MiB 上限不变，守住“新增字段只放引用”。上限每绑定 1,024 B、每 Run 320 B，用最长合法值断言（终稿第 20 节 Q7 在写入阶段已从第二版的 512 B 改正）。
- **Q19**：既有命令指纹 `sha256(JSON)` 含审批 `secret` 答复与发送原文，是 INV-29 范围之外的既有违例，是否迁移为 HMAC 另立 ADR。
- **写入阶段提出、终稿已修订处置的存储细节**（处置见[第四轮处置表](../proposals/relay/round4/v3-dispositions.md)末节）：`relay_prefs` 四个键都可经 API 写、`relay.allowUnprobed` 是偏好行（R2）；`relay_digests.status` 只有 current 与 behind，没有 `failed`；回收：每个 Run 只保留当前 `policyVersion` 的摘要行（懒重建写新行时同一事务删旧行），`relay_windows` 超过 30 天的行在启动时删除，`relay_log_archive` 只增不删、上限 1,048,576 行（终稿第 14.1 节“回收”）；`relay_recovery_failed` 存快照字段 `SessionSnapshot.relayRecoveryFailed`（切换契约 R10）；附件物化目录按会话建、保留稳定只读副本语义，以后的回合按同一路径仍可读、缺失即重新物化（R7）。

## 接力第三阶段的补充（2026-11-11）

- `relay_prefs`：CHECK 限 `RELAY_PREF_KEYS` 的键，现为 6 个（加 `relay.whenUnsure`、`relay.dataRootInWorkspace`）；打开时较旧的库（只列 4 个键）在事务里重建并保留数据；表仍不收的偏好是 `INVALID_INPUT`，不停用 Store。
- `relay.title_set`：`runId` · 在携带交接单的 `run.context_prepared` 提交之后、`run.dispatched` 之前单独提交；转为单发的 Turn 不设标题。
- `relay.withheld`：`runId`、`packetId`、`relay.decision`（`{kind: "alone", by: "policy", cause: "consent_revoked"}`）· 在 `run.authorized` 之后、`run.dispatched` 之前同意被撤回：交接单没有发出，原话照发；这个 Run 失去它准备好的交接单，送达行结算为 `not_recorded{never_dispatched}`。
- `run.context_prepared.data.relay.decision`：`{kind: "carry" | "alone" | "plain", by: "need" | "policy" | "user", cause?, reason?, resend?: "auto" | "grown" | "user"}`；普通且不欠任何东西的 Turn 不记。
- `relay_log` 里命令号以 `default-allow:` 开头的行是默认允许的留痕（`acknowledged`、全局），先于使用它的 `run.context_prepared` 提交。
