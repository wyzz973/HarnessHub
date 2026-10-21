# 持久事实、事件和恢复

状态：proposed。第一版采用事务存储加 append-only 事实日志与 outbox；不宣称采用完整 Event Sourcing，也不建立两份业务权威。

## 写入与一致性

每个聚合的状态、事件与 outbox 在所属事务提交。消费命令按稳定 commandId 去重；CAS/version 保证根的并发不变量。不同上下文采用明确的 process manager 与 inbox/outbox，不假定分布式原子提交。

单进程 Store owner 为本机唯一逻辑写入者。Worker 与 Harness 只报告证据。跨重启 owner/进程身份使用不透明 token 与可核验的进程身份，不能只凭 PID 杀进程。

### Owner 排他与 fencing

本机建议采用数据根的进程级 OS 排他锁，持有到应用停止接收、停止派发并完成资源收敛以后。TTL/心跳仅用于诊断，不能仅因过期接管仍存活的 owner；暂停的进程仍持有锁。

取得锁后还要核对持久 owner 进程身份。旧 owner 仍活着或无法确认已死时拒绝接管，即使异常释放了锁也不自动启动第二个仲裁者。锁文件被替换、锁辅助进程退出或锁身份失效时，原 owner fail-closed；主进程直接持锁或辅助锁的失效检测/父子退出规则进入平台验证，不能以随机 token 代替排他性。

只有验证前任已停止并持有排他锁后，存储原子递增 ownerGeneration。每个业务提交、grant/租约更新和网关外部派发携带并核对该代次；旧代次不能再写业务状态、交付权限或授予执行权。派发检查和控制发送有所属串行控制权，不能只在很早的 await 之前检查一次。

新 owner 在给任何新写者授权前，先收敛旧代次的 Worker/原生绑定/工作区写权。即使数据库 owner 已更换，原生后端的未知副作用也不因此消失；无法确认时保持 blocked。排他锁/进程身份/代次三者的具体原生实现由平台 probe 冻结。

Session 事件采用独立递增 seq；Attempt 事件有自己的 seq/generation，并通过幂等投影关联公共事件。序号是持久事实的游标，传输 delta 不能冒充已落库事件。规范化公开消息可以分块有界保存；临时流块若不持久，必须显式标记且不推进持久游标。回复文本与思考的流块在 ≤100 ms 或 ≤16 KiB 的窗口内合并后一次提交（[ADR-047](../decisions/0047-stream-output-coalescing.md)），一个窗口一条 `run.output` 事件；未提交的窗口不推进持久游标，也不对外发布，崩溃最多丢失一个窗口。

## 存储对象建议

Session 状态/消息/输入幂等/outbox；Harness revisions 与 capability evidence；routing decisions；Turn 与 Attempt；bindings/leases；switch requests；permissions；context manifests；artifacts；model calls；inbox 去重与 schema migrations。按所属上下文管理访问，不公开通用 SQL Repository。

编号迁移只进不改历史；未知版本明确失败。大正文与二进制在受控对象存储，以 hash 和大小登记；数据库/文件的发布先验证文件再登记，失败孤儿清理有所有者，不能返回半成品。

## SSE 与客户端

只读持久日志，Last-Event-ID 对应公共 Session 的稳定游标；重复交付可去重。游标过期返回 410 与历史读取入口，不从零静默重放或漏事件。高水位、分页、订阅数量、发送缓存与心跳有界。

慢消费者断开后按游标续读；不阻塞执行，也不维持无限内存缓冲。断流不取消运行；SDK 不因重连而再次提交消息。

## 失败与保留

写入失败停止接收新执行，尽可能取消/隔离活资源；没有持久终态时报告存储不可用而非假成功。恢复后核对未知执行。

幂等记录、事件、原生 checkpoint 和 Artifact 保留期分别定义。存在历史 revision、恢复材料或 pin 引用时不直接删对象。删除数据、备份一致快照与导出恢复是独立命令，不通过清库“修复”状态。

SQLite [原子提交](https://www.sqlite.org/atomiccommit.html)与[WAL](https://www.sqlite.org/wal.html)是选型参考；持久性还依赖真实磁盘、fsync、journal 设置和故障测试，不能仅凭 SQLite 名称作保证。

### 业务库迁移前备份（[ADR-049](../decisions/0049-business-store-backup-before-migration.md)）

业务库 `gateway.sqlite` 的编号迁移只进不退，没有降级脚本；每次存储版本提升之前由 Store 自动备份一次，供手动回退旧构建。它只在版本提升时发生，不是上文所说的独立备份命令。

- **时机与范围**：Store owner 取得数据根排他锁之后、迁移与接管事务开始之前，在没有事务的状态下读 `user_version`；只有 1～11（将被迁移到 12）才备份。新库（v0）、当前版本（v12）、未知版本（随后以 `INVALID_DATA` 拒绝）与只读的 `SqliteSessionReader` 都不备份。只覆盖业务库：内容存储、Provider、管理库与能力库不在其中，管理库与能力库在 M2 随 OwnerScopedStore 补上。
- **位置与命名**：`<数据根>/backups/gateway-v<原版本>-<UTC yyyymmddThhmmssZ>-<8 位随机十六进制>.sqlite`，例如 `gateway-v11-20261022T080910Z-3fa9c2d1.sqlite`。目录不存在时以 0700 新建；已存在时必须是当前用户所有、不对组和其他用户开放的真实目录（不是链接）。文件 0600。
- **写出与核对**：`VACUUM INTO` 先写到 `<正式名>.partial`，以只读连接回读：`user_version` 等于原版本，`sessions` 与 `events` 行数等于原库，`quick_check` 为 ok；fsync 后才取得正式名字（不覆盖同名文件），再 fsync 目录。正式名字只属于完整且核对过的副本。
- **保留**：最近 2 份。写新副本之前，按文件名中的时间只留最新的 1 份、删除其余，写完正好 2 份；先前崩溃留下的 `.partial` 文件同时删除。HarnessHub 只删除符合这两种命名的普通文件，`backups` 里的其他文件、目录与链接原样保留。备份归用户所有，HarnessHub 不读取、不自动恢复。
- **失败**：任一步失败（目录不合要求、空间不足、源库损坏、回读不一致）时，Store 构造以 `STORAGE_BACKUP_FAILED` 失败，消息写明失败的步骤和不含路径的原因，原错误保留为 cause。此时只删除本次写出的文件；迁移事务没有开始，owner 没有接管（`owner_metadata` 不变），业务库的行与 `user_version` 不变，排他锁释放。修好原因后重新启动，即重新备份并迁移。备份成功而迁移本身失败（例如 `INVALID_DATA` 整笔回滚）时，这份备份保留。
- **手动恢复**：1. 停止服务，等它退出；2. 用一份备份替换数据根中的 `gateway.sqlite`（复制过去，备份本身留在 `backups`）；3. 删除同目录的 `gateway.sqlite-wal` 与 `gateway.sqlite-shm`，它们属于被替换的库，留着会损坏恢复后的库；4. 用能读文件名中那个版本的旧构建启动。若用当前构建启动，它会再次备份并迁移。
