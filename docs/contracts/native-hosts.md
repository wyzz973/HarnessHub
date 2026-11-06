# 原生宿主与会话租借契约

状态：G078 冻结契约层的类型、解析器与预算解析器（`src/contracts/native-host.ts`）；G085 落地关闭链、关闭宽限与每个宿主类的私有 TMPDIR（2026-11-06 按两轮独立审查修正：回合不再等离组后代，TMPDIR 加命名空间锁、HMAC 命名与有界计数；锁的等待不占事件循环、清扫有上限、后台删除在服务关闭时有期限，回复后的停止不改结果）（`src/infrastructure/control/host-shutdown.ts`、`src/infrastructure/session/host-tmpdir.ts`）。宿主池、登记、Driver 多会话与界面属于 G079–G082，**尚未实现**；本文写到它们的地方只冻结接口。代码完成、合成测试通过，未真机验证，见[验证记录](../verification/native-hosts-g078-g085-2026-11-06.md)。取舍见 [ADR-056](../decisions/0056-native-hosts-and-sessions.md)，设计正文见[原生宿主与会话租借设计](../proposals/native-hosts/design.md)第 4.2–4.4、4.10–4.12 节。

原则：会话是数据（原生会话 ID 加 Hub 的绑定），宿主是承载它的进程或到原生服务的连接；回合租借宿主上的某个会话，不拥有进程。Gateway 不按产品分支，差别只经 Driver 的静态声明进入；契约源码不出现任何 Harness 或厂商的名字（单元测试按目录里全部 Harness 的 id、名称、别名、程序名扫描契约源码）。

## 1. 身份

| 类型 | 写法 | 解析器 |
|---|---|---|
| `HostId` | `host-` 加 1–96 个字母、数字或连字符（与 `SessionId` 同一写法） | `hostId(value)` |
| `SessionLeaseId` | `lease-` 加 1–96 个字母、数字或连字符 | `sessionLeaseId(value)` |
| `HostClassKey` | 64 位小写十六进制：sha256(Harness, 入口, 安装指纹, 启动指纹)（设计第 4.3 节） | `hostClassKey(value)` |

解析器只接受字符串；空串、超长、控制字符、空格、其他前缀或大写十六进制都以 `INVALID_INPUT` 拒绝。

## 2. Driver 的静态声明 `HostCapabilities`

`parseHostCapabilities(value)` 把外部输入（`unknown`）读成声明：缺项取最保守值；类型错误、未知取值、未知字段、重复的 `launchBound`、继承来的原型、互相矛盾的组合一律以 `INVALID_INPUT` 拒绝，不修补。

| 字段 | 取值 | 缺项时 |
|---|---|---|
| `sessions` | `one_per_process` · `switchable` · `concurrent` | `one_per_process` |
| `sessionCwd` | `launch_cwd_only` · `per_session` | `launch_cwd_only` |
| `reopen` | `{ cost: replay · reference · unknown, byLoadOnly }` | `{ cost: unknown, byLoadOnly: true }`（嵌套字段同样逐项取保守值） |
| `sessionMemory` | `light` · `heavy` · `unknown` | `unknown` |
| `sessionRelease` | `in_process` · `process_only` · `unknown` | `unknown` |
| `launchBound` | `model`、`options`、`collaboration_mode`、`provider` 的不重复子集 | 全部四项 |
| `execution` | `process` · `gateway` | `gateway`（宿主退出不当作静止证据） |
| `idleActivity` | `none` · `background_possible` · `unknown` | `unknown` |
| `initializeSideEffects` | `none` · `creates_session` · `writes_state` · `unknown` | `unknown` |
| `concurrentTurns` | 布尔 | `false` |
| `foreignTurns` | `detectable_on_open` · `detectable_by_listing` · `undetectable` | `undetectable` |
| `probed` | 布尔 | `false` |

矛盾：`concurrentTurns: true` 而 `sessions` 不是 `concurrent`；`reopen.byLoadOnly: true` 而 `cost: reference`——`cost` 写 `reference` 却省略 `byLoadOnly` 也属于此类（缺省值是 `true`），声明便宜的重开必须写明 `byLoadOnly: false`。

预算种类 `hostKind(capabilities)` 只看 `sessions`、`sessionMemory`、`sessionRelease`：

| 条件 | 种类 |
|---|---|
| `one_per_process` 或 `switchable` | `single`（每个对话一个进程） |
| `concurrent` 且 `light` | `light` |
| `concurrent` 且 `heavy` 且 `in_process` | `heavy_reclaimable` |
| `concurrent` 且其余（`heavy` 而收不回或未知，或内存未知） | `heavy_process_only` |

设计第 5 节的“原生服务型”与“便宜的多会话型”按这三项是同一种类（`light`），所以共用一组上限。

## 3. 宿主、会话与租借（只冻结接口，实现在 G079–G081）

- `HostState`：starting · idle · leased · pinned · draining · closing · dead；`HostCloseReason` 15 种（设计第 4.2 节），ADR-030 的 10 种保留原因是它的子集；`StaleReason` 13 种与 `FreshnessVerdict`（新鲜时带依据 `just_opened`、`same_owner_no_foreign`、`verified_on_open`、`native_session_unchanged`，不新鲜时带原因）；判不出的按不新鲜处理。
- `HostedSession`、`HostHealth`、`NativeHost`、`SessionLeaseRequest`（带回合已取得的工作区租约，池只核对、不代取）、`SessionLease`（`release("settled" | "pin" | "unknown")`）、`HostPool`（`lease`、`pin`、`unpin`、`drainClass`、`shutdown`、`metrics`）与 `HostPoolMetrics`（不含路径、环境值与会话内容）。
- `NativeHost.close()` 以关闭链关闭并给出 `HostCloseEvidence`（第 6 节）；不能确认进程组结束时拒绝，宿主为 dead，它持有的工作区租约保持隔离。
- `HarnessControl`（`src/contracts/control.ts`）声明了可选的 `openSession`、`closeSession`、`switchSession`，目前没有 Driver 实现；没有它们的 Driver 一进程一会话。

## 4. 宿主事件

与 ADR-030 的 `native.process_*` 并存的对话事件（`HOST_EVENTS`，数据见 `HostEventData`，都不含路径、环境值与会话内容）：

| 事件 | 数据 |
|---|---|
| `native.host_started` | `hostId`、`classKey`、`coldStartMs` |
| `native.session_reused` | `hostId`、`basis` |
| `native.session_reopened` | `hostId`、`reason`，可有 `replayMs`、`replayBytes` |
| `native.session_closed` | `hostId`、`reason` |
| `native.host_closed` | `hostId`、`reason`、`cleanup`（`HostCleanup`，含 `stage` 与 `closeMs`）、`outside` |
| `native.host_evicted` | `hostId`、`lruAgeMs`、`rssBytes`（未采样为 null） |
| `native.host_lost` | `hostId`、`outcome`（terminated · gone · unconfirmed）、`leaseReleased` |
| `native.host_drained` | `classKey`、`reason`、`count` |

这些事件由 G079、G080 写入；本期没有任何代码写它们。

## 5. 预算解析器 `resolveHostBudgets`

`resolveHostBudgets({ physicalMemoryBytes, configured? })`：`physicalMemoryBytes` 由调用方读（契约层不读系统），`configured` 是外部输入。默认值与上下界只在 `HOST_BUDGET_BOUNDS`、`HOST_CLASS_CAP_BOUNDS` 与内存规则一处；值不是整数、越界、字段未知或违反交叉规则时以 `INVALID_INPUT` 拒绝，从不调整。初始值来自 2026-11-03 的实测（一台 64 GiB 的机器），要按目标机器调整。

| 参数 | 默认 | 上下界 |
|---|---|---|
| `hostMemoryBudgetBytes` | 物理内存的 1/8（向下取整） | 256 MiB 至物理内存；物理内存小于 2 GiB 时整体拒绝 |
| `maxHosts` | 8 | 1–64 |
| `maxPinned` | 4（ADR-030） | 1–16，且不超过 `maxHosts` |
| `maxParallel` | 4（`MAX_PARALLEL_CONVERSATIONS`，ADR-036） | 1–16 |
| `pinnedIdleTtlMs` | 30 分钟 | 1 分钟–4 小时，且不超过 `pinnedHardCapMs` |
| `pinnedHardCapMs` | 4 小时 | 30 分钟–24 小时 |
| `classCaps.single.hostIdleMs` | 5 分钟 | 1–60 分钟 |
| `classCaps.light` | 每宿主 8 个会话，空闲 15 分钟 | 会话 1–32；1–60 分钟 |
| `classCaps.heavy_reclaimable` | 同时活着 3 个会话，会话空闲 10 分钟收回，没有会话 2 分钟关进程 | 会话 1–16；1–60 分钟；10 秒–30 分钟 |
| `classCaps.heavy_process_only` | 全局 3 个进程，空闲 5 分钟 | 进程 1–16 且不超过 `maxHosts`；1–60 分钟 |
| `closeGraceMs` | 1.5 秒 | 1.5–30 秒 |
| `closeOutsideWaitMs` | 10 秒（只有宿主的关闭证据等它，回合从不等） | 1–60 秒 |
| `hostTmpdirMaxBytes` | 256 MiB | 16 MiB–16 GiB |
| `hostTmpdirMaxEntries` | 4,096 项 | 256–65,536 |
| `hostTmpdirUnusedMs` | 7 天 | 1–90 天 |
| `hostTmpdirCloseWaitMs` | 5 秒（服务关闭时等后台删除的上限） | 1–60 秒 |

当前使用方：`closeGraceMs` 由组合根（`application()`）解析一次交给 binding factory，用于每回合的进程与只读探测，`run:harness`、`probe` 命令同样取解析器的值；`closeOutsideWaitMs` 只用于 `JsonRpcProcess.closeEvidence()`（第 6 节），调用方没给时取同一默认值；`hostTmpdir*` 交给第 7 节的 TMPDIR 管理。`hostTmpdirMaxEntries` 的 4,096 是估计值，离审查者估计的 OpenClaw 缓存（约 2,400 个文件）不远，要按 G083 的真机数据调整。其余参数等 G079 的宿主池接入；在那之前 Runtime 仍用它自己的 `KEPT_LIMIT` 与 `KEPT_IDLE_MS`，数值与这里的默认相同。

## 6. 关闭链（G085）

关闭分两段（`quiesce` 与 `confirmOutside`），只有第一段在任何回合的路径上：

1. **结束进程组**（`close()` 等的就是这一段）：关 stdin，最多等 `closeGraceMs` 让领头进程退出且进程组清空（`stage: "eof"`）；仍不空才对进程组 SIGTERM（`"sigterm"`），再等一个宽限；仍不空再 SIGKILL（`"sigkill"`），再等一个宽限；仍不空则以 `CLEANUP_FAILED` 拒绝。`close()` 在组清空时就以原来的四个字段 resolve。
2. **核对离组后代**（只有 `closeEvidence()` 做）：由 `closeEvidence()` 开始的关闭，在关 stdin 之前、领头进程还在运行时读一次进程表，按 `outsidersOf` 找出组成员派生、已离开该组的后代（pid、启动时间、命令基名）；组清空后按 pid 加启动时间（±2 秒）复查：已退出的不计，pid 已被其他程序复用时启动时间对不上、不会被认错；仍在运行的每 250 ms 复查一次，最多再等 `closeOutsideWaitMs`，之后记入 `remaining`。调用方传的 `AbortSignal` 可以提前结束等待，这时仍在运行的记为 `remaining: null`。领头进程已先退出，或关闭已由 `close()` 开始（没有读过），记为 `unknown`。
3. 离组后代从不收到信号：只有进程组收到信号（ADR-030 补充条；是否结束本宿主自己的 MCP 服务器留设计 Q10）。

证据：`closeEvidence(signal?)` 给出 `HostCloseEvidence`：`cleanup` 是 `HostCleanup`（`CleanupEvidence` 加 `stage` 与结束进程组所用的 `closeMs`；从未启动过程序时 `stage: null`、`closeMs: 0`），`outside` 沿用 `OutsideEvidence`（`{state: "enumerated", found, remaining, commands}`，`remaining` 无法复查或等待被中止时为 null，`commands` 最多 16 个；或 `{state: "unknown"}`）。回合快照里的 `cleanup` 与 `run.ended` 事件只有原来的四个字段，业务库不升版本。只经 `closeEvidence()` 开始的关闭若以 `CLEANUP_FAILED` 失败，拒绝只交给它的调用方，不留未处理的 rejection；之后的 `close()` 返回同一个拒绝。

使用方：binding 的关闭、只读探测、`run:harness`、`probe` 都只调用 `close()`，所以回合结算、下一回合、切换、另一对话的回合与服务关闭都不等离组后代。保留进程的关闭照 G085 之前那样由 Runtime 在 `close()` 前后各读一次（`outsideBefore`、`outsideAfter`），记入 `native.process_closed{outside}`。完整的等待与 `native.host_closed` 留给 G079 的空闲宿主关闭，它调用 `closeEvidence()` 并在服务关闭时中止。

**回复之后的停止。** 宽限让程序在 EOF 后自然退出（实测 Claude 带会话约 0.8 s、Codex 最长约 1.1 s），这段时间回合处于 settling：回复已到，只剩关闭。这时收到的停止只记录命令与 `run.cancel_requested`，不设 `cancelRequested`，也不提前关闭；关闭照常进行，回合按程序报告的结果结束，原生会话照常推进（[公开会话契约](public-session-mvp.md)）。否则一个已完成的回合会被记成取消，界面再提供“重试回复”，把完成的任务重跑一遍。

## 7. 每个宿主类的私有 TMPDIR（G085）

**位置。** 命名空间的共享范围与工作区租约相同：

- 默认租约目录（`/tmp/harnessgateway-workspaces-<uid>`）时，命名空间是系统临时目录下的 `harnesshub-hosts-<uid>`；
- 显式的 `--workspace-lock-root`（隔离的测试或刻意独立的实例）时，命名空间是该目录下的 `hosts`；
- 直接构造 binding factory 而不给 TMPDIR 管理时，取租约提供者目录（`WorkspaceLeaseProvider.namespace`）下的 `hosts`；租约提供者没有目录时 `prepare()` 以 `HOST_TMPDIR_FAILED` 拒绝。

命名空间解析掉符号链接后才作 TMPDIR 的前缀；第一次用到之前什么都不读、不建，所以命名空间不可达只让需要它的回合失败，不让 Hub 启动失败。

**谁可以清空。** 回合在本工作区租约之下准备与归还它的类目录，而一个类含工作区，所以在共享同一租约目录的 Gateway 之间，此时该类没有别的活宿主。命名空间另有一把锁（`.lock.sqlite`，0600，SQLite 的读写锁）：进程只要在命名空间里有活宿主就持有共享锁（从准备宿主起到归还为止，一个进程一个连接），启动清扫要独占锁，拿不到（别的 Gateway 有活宿主）就这次什么都不清；清扫一次最多改动 256 项（移走一个类目录连同记录算一项），其余留给下次启动，所以持锁的时间有上限。准备宿主遇到正在清扫的 Gateway 时最多等 2 秒：每 20 ms 再试一次，不占住事件循环；到时仍拿不到，回合以 `HOST_TMPDIR_BUSY` 失败，提示文字说明是别的服务在清扫、稍后重试即可，目录不动，对话保持 open。这样清扫既不会在别人“检查与写记录”之间删掉一个目录，也不会删掉一个连用多日的保持进程的目录；持有期间每小时还会重写一次记录，使它的最近使用时间跟着走。

**目录与记录。** 命名空间里有一把随机生成的 32 字节密钥（`.key`，0600，由第一个需要它的 Gateway 写在旁边再链接进来，所以没人读到半把）。每个类一个目录 `<命名空间>/<HMAC 的前 16 位十六进制>/`，0700，属当前用户；HMAC 用这把密钥，作用于类的规范文本：Harness、入口、工作区与除 TMPDIR 外的全部启动环境（本回合私有根目录的路径换成同一个占位符，这样生成的 Provider 配置目录不会让每回合变成一个新类）。安装另算一个 HMAC，作用于入口可执行文件与绝对路径参数的文件身份（设备、inode、大小、mtime）加受管安装的 revision。目前没有 Driver 声明 `launchBound`，模型与选项不进任何一个。启动环境里可能有透传或受管 Provider 的密钥，所以目录名、记录与服务日志里只有 HMAC 或它的前缀，没有原值，也没有未加盐的哈希（INV-29）。目录旁的记录 `<名>.json`（0600，原子写入）存 `version`、`launch`、`installation` 两个 HMAC，它的修改时间就是最近一次使用。

**取用与归还。** binding factory 在本回合取得工作区租约之后、启动程序之前取用：

- 命名空间、它的密钥或锁、或类目录是符号链接、不是该有的类型、属于他人、对他人开放或不可写，或命名空间与数据目录互相包含（按设备与 inode 沿各自的父目录比较）：回合以 `HOST_TMPDIR_FAILED` 失败，程序不启动，回合释放租约，对话保持 open；不跟随链接，也不修复或改动任何东西。
- 没有同类的其他持有者时，记录里的安装或类与本次不同（升级）或没有记录：把目录改名移到一旁（一次 rename）、放一个空目录在原处，再交给程序。
- 回合的进程组确认结束后归还；不能确认时不归还，目录一直算作有活宿主。归还时若没有同类的其他持有者，且目录里的文件按占用的磁盘块超过 `hostTmpdirMaxBytes`、或条目超过 `hostTmpdirMaxEntries`（只按字节，每次启动留下的空目录永远到不了上限），就把它改名移到一旁，下一个宿主拿到一个新的空目录。同时列出的几十个目录共享一个计数，一旦越过任一上限就停，所以归还最多数到 `hostTmpdirMaxEntries + 1` 项：4,000 个空目录约 50–90 ms，24 个目录里的 2,400 个小文件（模拟编译缓存）约 10–20 ms，再多的目录也只读到上限为止。
- 移到一旁的目录（`.<名>.<uuid>.trash`）由 `HostTmpdirs` 的一个后台工作一个接一个地删除（`settle()` 可等待）：不跟随链接，每个目录一次列完、其中的项 16 个一组并行删除，调用之间不占文件描述符，能删的先删完，删不掉的只记诊断（`HarnessGateway: HOST_TMPDIR (<目录名>: …)` 写到服务日志，只有目录名与系统错误码，没有路径），不影响回合；下次启动的清扫会再试。
- 服务关闭时，Runtime 在自己的关闭最后结束 binding factory 的后台工作（`SessionBindingFactory.close()`，即 `HostTmpdirs.close()`）：最多等 `hostTmpdirCloseWaitMs`，之后删除停在下一步，剩下几个记一条诊断，留给下次启动的清扫。

**启动时清理。** `application()` 在接受任何回合之前清扫命名空间：先在后台删除残留的一旁目录，再在独占锁之下把 `hostTmpdirUnusedMs`（7 天）内没有用过的类目录连同记录移到一旁，删除没有目录的记录与没写完的临时文件，一次最多 256 项；不是类目录的项原样保留；命名空间本身不是私有目录时什么都不动，只记诊断。

**不变的东西。** 回合私有根目录（目录快照、为受管 Provider 生成的配置目录）仍每回合新建、关闭时删除，不再作为 TMPDIR；读目录、列会话、读会话等只读探测不持有写租约，仍各用自己的私有临时目录。TMPDIR 不进任何快照与导出。

**边界（如实记录）。** 离组后代在宿主关闭后仍在用 TMPDIR 时，超限移走目录会让它们的临时文件路径失效；进入宿主池（G079）后空闲宿主不持工作区租约，“准备与归还时该类没有别的活宿主”不再由租约保证，需要 G079 为每个类另加跨进程的锁。目录名取 64 位，留给 Unix 套接字的路径余量与每回合目录相近（系统临时目录下约 94 个字符，原来约 87 个）。

## 8. 不在本契约

宿主池与租借的实现、新鲜度判定、登记表与接管、RSS 采样、Driver 的能力声明与多会话、`GET /api/v1/native-hosts` 与界面（G079–G082）；真机探针（G083）。
