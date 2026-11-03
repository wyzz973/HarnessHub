# 原生宿主与会话租借：会话是数据，进程是可以切换会话的宿主

状态：accepted（2026-11-03 用户按推荐项接受 D1–D7），对应 [ADR-056](../../decisions/0056-native-hosts-and-sessions.md)（2026-11-03）。**未实现、未真机验证**：没有改任何代码，没有运行任何 Harness，没有碰 4317 服务与 `data/`。实测已由另一位成员完成：[实测记录](../../../spikes/native-hosts/README.md)与 `spikes/native-hosts/results.json`（2026-11-03，六家；Pi 在官网策略下起不来，未测）——用正式的 application 与 binding factory、官网安装策略、生产的启动命令、环境与会话参数，不调用模型，配置守护前后无变化。第 5 节的归类与数字、第 4.3 节的预算、第 4.7、4.11、4.12 节的新条目与第 10 节的剩余项都按它改写；仍需模型调用才能验证的项在第 10 节单列。

标注：【事实】有代码、契约、验收记录或上游源码出处，代码位置指本工作区（分支 `cc/relay-design`，基点 `e02fa52`）的 `file:line`；【实测】`spikes/native-hosts/` 在本机（Apple M5 Pro，64 GiB，macOS 27.0.1）测得，RSS 是整个进程树之和，Claude 与 Codex 的内存取决于本机用户自己配置的 MCP 服务器；【推断】由事实推出；【建议】本设计的提议。界面文案一律称 Harness。

## 0. 摘要与状态

**用户的问题。** 现在每条消息都要现场启动原程序进程，切换 Harness 时进程又被关掉，资源开销大；有没有类似线程池的方案。用户还要求先把 Session 的所有情况想清楚。

**现状（第 1、2 节）【事实】。** “会话”分五层：公共对话、原生绑定、原生会话、原生进程、回合，另有工作区租约与切换两个横切概念。进程默认每回合一个、回合结束即关（`binding-factory.ts:118`、`runtime.ts:1504–1508`）；只有对话显式开启“保持原生进程”后进程才归对话持有，最多 4 个、空闲 30 分钟（`runtime.ts:66–68`），切换生效时不是新选择就关掉（`runtime.ts:1626`）。三个 Driver 都只允许一条连接打开一个原生会话（`acp.ts:504`、`codex.ts:336`、`pi.ts:169`），而协议并不这样限制：ACP 的会话方法都带 `sessionId`，Codex 的 `turn/start` 带 `threadId`，Pi 的 RPC 有 `switch_session` 与 `new_session`。

**方向【建议】。** 把“原生会话”与“承载它的进程”分开：会话是数据（原生会话 ID 加 Hub 记录的绑定），进程是宿主（NativeHost），一个宿主可以先后或同时承载多个原生会话；回合取得的是对某个宿主上某个会话的**租借**（SessionLease），不再拥有进程。宿主放进按“Harness + 入口 + 安装指纹 + 启动环境”分类的池里，预算以内存为主、按类封顶，空闲的会话与宿主按类的时限收回。复用的硬条件是会话“新鲜”：在原程序里继续过、结果未知、绑定未确认或在分支中、接力待核、原生命令改了上下文、配置或版本变了，都要强制重新打开。写租约只跟着“写”走：空闲宿主不占工作区；有后台任务的宿主固定在对话上并继续持有租约（ADR-030 的方案 C 不变）。

**宿主类型按实测分（第 5 节）。** 原生服务型——Hermes、OpenClaw（会话在用户网关里，连接不随会话增长）；便宜的多会话型——OpenCode、dsh（会话 ≤10 MiB，进程冷启动 1–2 秒）；重的多会话型、会话可收回——Claude（每会话约 1.3 GB，`session/close` 真正释放，适配器常驻、会话按需收回）；重的、进程内收不回——Codex（每线程约 0.9 GB 且退出进程才释放，每对话一个进程、空闲就早关）；Pi 待测。六家都能在一个进程里带两个会话，六家空闲都不写工作区。

**三期（第 8 节）。** 短期：按会话复用的进程池、切换后保留来源宿主（A→B→A 不再重启 A）、按类预算、关闭宽限 ≥1.5 s 与先 EOF 再核对离组后代的关闭链、每类一个稳定私有 TMPDIR、预热不建会话；中期：宿主多会话按收益排序——先 OpenCode、dsh、Hermes，再 Claude 的适配器常驻加会话收回，Codex 不做；长期：公共对话改成记录树，与接力的 v13 存储一起规划。

**不变的东西。** 公共 Session 的唯一权威地位（INV-01、INV-06）、同一工作区单一写入者（INV-03、INV-12）、未知不重跑（INV-11）、先提交再发布、ADR-055 的送达水位与零注入、ADR-030 的“由用户选择结束后台进程”。

**用户拍板的取舍**见 ADR-056（2026-11-03 已按推荐项全部接受）；本文第 4 节写明每项的推荐。

## 1. Session 全景

### 1.1 五层与两个横切概念

| 层 | 定义 | 身份 | 所有者 | 寿命 | 数量关系 | 出处【事实】 |
|---|---|---|---|---|---|---|
| 公共对话（Session） | 用户看到的对话：快照加只追加的事件 | `SessionId`（品牌类型） | 业务库的当前 owner（`ownerGeneration`） | 创建到 closed；closed 不可重开、没有删除 | 一个对话 → 0..n 个原生绑定、0..256 个 Run（`MAX_RUNS`）、1 个工作区 | `session.ts:10`、`:243`；`state.ts:12`；`runtime.ts:664–682` |
| 原生绑定（NativeSessionBinding） | Hub 记录的“这个对话在某个 Harness 入口上的原生会话引用” | `(harnessId, controlId, checkpoint)`，没有独立 ID | 对话（写者是当前选择纪元的 Run） | 从 `binding_prepared` 到归档；归档的绑定永不复用 | 每个 (harnessId, controlId) 同时至多一个非归档绑定；一个原生会话只有一个持有者（ADR-029） | `session.ts:149–160`；`state.ts:414–465` |
| 原生会话 | 各 Harness 自己保存的会话：Claude 的转录 JSONL、Codex 的 rollout、OpenCode 的 SQLite、Hermes 的 `state.db`、OpenClaw 网关会话、Pi 的 JSONL 树 | 各家的会话 ID；Hub 只存它（`checkpoint` ≤8 KiB） | 原程序 | 原程序决定；Hub 不删除、不改标题（ADR-029） | 一个原生会话 ↔ 至多一个就绪或未确认的绑定 | `runtime.ts:1413`；ADR-029 决定 3 |
| 原生进程 | 承载原生会话的进程或到原生服务的连接（ACP 代理、Codex app-server、Pi、Hermes 查看器、OpenClaw 桥） | 进程组号 + 组长启动时间（`KeptProcessIdentity`）；连接本身没有公共 ID | 默认是回合（`PreparedSessionBinding` 为每回合所有者）；开启保持后是对话 | 默认回合结束即关；保持时到空闲 30 分钟或各种触发 | 现状一进程一会话（三个 Driver 都拒绝第二次 `open`） | `session.ts:294–299`、`:198`；`acp.ts:504`、`codex.ts:336`、`pi.ts:169` |
| 回合（Run） | 一条输入到结算的工作单元 | `RunId` | 对话的 worker（每个对话至多一个活动回合） | queued 到终态 | 同一对话串行；全局最多 4 个对话同时执行；每个对话排队 ≤8 | `session.ts:48`；`session.ts:315`；`state.ts:14` |
| 横切：工作区租约 | 同一受管理工作区同一时间只有一个写入者 | 工作区规范路径 + 持有的 (session, run) | 回合（或保持中的对话） | 从 `prepare` 取得到绑定关闭并确认静止；未确认即隔离 | 一个工作区 ↔ 至多一个有效租约 | `binding-factory.ts:147`；`workspace-lease.ts:93–110`、`:150` |
| 横切：切换 | 改变对话的选择（Harness、入口、模型、选项、Provider） | `SwitchId` | 对话 | requested → validated → effective 或 failed | 生效时选择纪元 `epoch` 加 1；同一纪元内选择不可变 | `session.ts:127–136`；`runtime.ts:1665–1668`；`state.ts:430–431` |

ADR-055 接受后，原生绑定上还会有接力状态 `relay`（`nativeEpoch`、`epochFloor`、同步状态 fresh / synced / pending / suspect），本设计把它当作绑定层的一部分读，不改它（第 6 节）。

### 1.2 各层状态及其转换

**公共对话**：`open → blocked`（回合或切换结果未知，`runtime.ts:1543`、`:1658`）；`blocked → open` 只经一次显式的恢复切换（`state.ts:427–429`）；`open | blocked → closed`（用户关闭，`runtime.ts:681`）；`closed` 终态。

**原生绑定**：`unconfirmed`（`binding_prepared` 时写入，`runtime.ts:1419`）→ `ready`（回合结算且清理确认、原生会话确认，`runtime.ts:1546–1549`）；`ready → unconfirmed`（下一回合再次 open 时）；`ready | unconfirmed → archived`（native-reset、因清空归档、fork 被拒）；分支专用：`fork-pending → forking → ready | archived`（`state.ts:422–424`）。`unconfirmed` 与 `forking` 一样阻止原生使用，下一回合以 `NATIVE_STATE_UNCONFIRMED` 失败（`runtime.ts:1360`）。

**原生会话**：Hub 看不到它的状态，只看得到 ID、原程序列出的会话（ADR-029）、回放的历史（`session/load`、`thread/turns/list`）和 ADR-055 定义的送达位置。

**原生进程（现状）**：`无 → 启动（spawn，detached）→ initialize → open（new 或 resume/load）→ 回合中 → 结算 → 关闭（请求停止 → 等待 → SIGTERM → SIGKILL 进程组）`（`json-rpc-process.ts:233–236`、`:390–391`）。开启保持后在“结算”之后多一个 `kept` 状态：`kept → 复用（takeKept）| 关闭（10 种原因：idle、disabled、ended_by_user、selection_changed、conversation_closed、native_reset、branched、exited、gateway_shutdown、harness_upgrade）`（`runtime.ts:64`）。服务异常退出后，下一次启动按进程组身份处理：`terminated | gone | unconfirmed`（`runtime.ts:590–614`）。

**回合**：`queued → preparing → running → settling → completed | failed | cancelled`；派发后无法确认结算的为 `unknown`，同时对话 blocked（`runtime.ts:1529–1543`）。`queued` 可直接 `cancelled`（取消、关闭、所有者结束）。

**工作区租约**：`空闲 → 被回合持有 → 空闲`；回合结束时关闭未确认 → `隔离`（`WORKSPACE_QUARANTINED`），只有确认进程组结束才释放（`releaseAbandoned`，`workspace-lease.ts:172`）；保持中的进程继续持有（ADR-030 决定），另一对话得到 `WORKSPACE_KEPT`（`runtime.ts:1386–1387`）。

**切换**：`requested → validated → effective | failed`；空闲时直接生效，执行中默认等当前回合结束（`wait_current`）；停止未确认时待决切换记 `failed{SWITCH_SOURCE_UNKNOWN}`（`runtime.ts:1556–1558`，ADR-055 RT2-04）。

### 1.3 一个对话的全部情况

每条写：发生什么、每层状态怎样变、进程怎样处理（现状）；目标架构下的差别写在第 9 节走查里。

**创建**

| 情况 | 发生什么 | 各层状态 | 进程（现状） |
|---|---|---|---|
| 新建 | `create` 校验选择（`factory.validate` 只观察文件，不启动程序，`binding-factory.ts:131–145`），写快照 v12、`epoch: 1` | 对话 open；没有绑定；没有 Run | 不启动 |
| 接续本机会话（ADR-029） | 列出原程序在本工作区的会话（一次只读探测启动）、读取一个（再一次启动），新对话 `origin.kind="import"`，绑定直接就绪、`throughRunId` 为空 | 对话 open；绑定 ready；历史复制进 `origin.history`（≤200 条、512 KiB） | 列表与读取各启动一次原程序，读完即关（`binding-factory.ts:238–276`） |
| 分支（ADR-025） | 新对话 `origin.kind="fork"`，复制源对话到分支点的公共消息；原生会话恰好同步到分支点时建原生副本 | 新对话 open；绑定 `fork-pending → forking → ready` 或 archived；源对话不变 | fork 用独立连接启动一次原程序、做完即关（`runtime.ts:1586–1612`）；源对话保持的进程被关闭（`branched`，`runtime.ts:467`） |

**正常使用**

| 情况 | 发生什么 | 各层状态 | 进程（现状） |
|---|---|---|---|
| 发送 | `send` 受理（幂等键、附件）、入队、worker 取出、`prepare`（租约 + 观察 + 启动）、`initialize`、`open`（resume/load 或 new）、派发、流式事件、结算 | Run queued → preparing → running → settling → 终态；绑定 unconfirmed → ready；租约持有 → 释放 | 启动一次，结算后关闭并记 `cleanup`（`runtime.ts:1504–1508`）；复用保持的进程时跳过启动与握手（`:1372–1381`） |
| 排队 | 同一对话第二条输入进队（≤8）；同工作区另一对话的回合 FIFO 等待（等待预算）；全局并行满 4 时等空位 | 新 Run queued；`run.waiting{kind}` | 不启动 |
| 原生命令 | 目录列出的命令原样发给原生（ADR-055 R0d：Driver 复刻原生解析，效果 keep / none / compact / clear / rewind / unknown） | `clear` 经确认进入新纪元、绑定归档并新建；`compact` 只改游标 | 同“发送” |
| 审批与提问（ADR-035/036） | 原程序请求审批或提问，等待预算计时；到期 `WAIT_EXPIRED` | Run running（等待中）；租约持有 | 进程存活等待；到期走停止链 |
| 停止 | 记录意图 → 待决权限返回取消 → `requestStop` → 等待 ≤15 秒 → 关闭绑定 → 必要时 SIGTERM/SIGKILL 进程组 | Run cancelled；停止未确认则 unknown + blocked | 一定关闭 |

**切换**

| 情况 | 发生什么 | 各层状态 | 进程（现状） |
|---|---|---|---|
| 空闲时切换 | 校验目标（只观察文件）→ validated → effective，`epoch+1`；不组包、不启动程序（ADR-055 R0a） | 切换 effective；来源绑定保留 ready，目标尚无绑定 | 保持中的来源进程被关闭（`selection_changed`，`runtime.ts:1626`） |
| 执行中切换 | 默认 `wait_current`：等当前回合结束再生效；期间新输入等待该切换 | requested → validated（等待）→ effective | 当前回合的进程照常结算后关闭 |
| 同 Harness 换模型或选项 | 也是切换：`sameSelection` 比较模型与选项（`runtime.ts:69–72`） | 下一回合在同一原生会话上用新模型 open | 保持中的进程被关闭再启动 |
| A→B→A | 两次切换；回到 A 时按 A 的绑定 resume 并补发 B 期间的欠交（v12 按 `throughRunId`；v13 按送达水位与待核状态） | A、B 的绑定都 ready（A 可能 suspect/pending） | A 的进程在 A→B 时已关闭；回到 A 再启动一次 |
| 切换失败 | 校验失败 → failed，选择不变；恢复切换在 open 之后失败且清理未确认 → blocked | 切换 failed；对话 open 或 blocked | 恢复切换会启动目标并关闭 |

**异常与恢复**

| 情况 | 发生什么 | 各层状态 | 进程（现状） |
|---|---|---|---|
| 结果未知 | 派发后拿不到结算（进程被杀、协议中断、清理未确认） | Run unknown；绑定 unconfirmed；对话 blocked；租约隔离 | 进程组可能残留；租约 `WORKSPACE_QUARANTINED` |
| 恢复（ADR-014，INV-11） | 用户确认“保留未知结果，只开始新任务”并发起恢复切换；不自动重跑 | blocked → open 只经这一次切换（`state.ts:427–429`） | 恢复切换启动目标做一次 open 再关闭 |
| Hub 重启 | `recoverSession` 把未终结 Run 记 unknown、待决切换 failed、对话 blocked（`state.ts:470–483`）；`reapKept` 按进程组身份结束上一所有者保持的进程（`runtime.ts:590–614`） | 见左 | 只处理有身份记录的保持进程；回合中的进程不在记录里，租约保持隔离 |
| 原生重置 | 归档当前绑定，下一回合 `session/new` | 绑定 archived；新绑定 fresh{reset}（v13）；`nativeEpoch+1` | 保持的进程关闭（`native_reset`，`runtime.ts:430`） |
| 升级（ADR-043） | 空闲保持的对话先关闭进程（`harness_upgrade`，`runtime.ts:541`）；正在回复的对话阻止升级 | 下一回合用新版本 | 空闲保持进程关闭；回合中的进程不动 |

**保留进程（ADR-030）**

| 情况 | 发生什么 | 各层状态 | 进程（现状） |
|---|---|---|---|
| 开启保持 | 对话设置开关 `retainNative`；回合完成且确认后进程交给对话（`keepable`：完成、确认、健康、未超 4 个） | Run `retained: true`、`cleanup` 为空；快照 `retained{harnessId, controlId, runId, since, process}` | 进程存活，空闲 30 分钟后关闭；期间事件只计数（“后台活动 N 条”） |
| 复用 | 下一回合选择不变且连接健康 → `native.process_reused`，不启动、不握手、不恢复 | Run `reused: true` | 7 毫秒级启动（真实 Claude，ADR-030 验收） |
| 关闭 | 10 种原因之一；都走停止链并记 `native.process_closed`（含逃出进程组的后台任务枚举） | 快照 `retained` 清除 | 关闭 |

**对话之外**

| 情况 | 发生什么 | 各层状态 | 进程（现状） |
|---|---|---|---|
| 用户在原程序里继续（ADR-039） | 用户用续接命令在终端继续同一原生会话；Hub 看不到这些回合 | 绑定仍 ready，但原生历史已超出 Hub 的认知；v13 以回放核对发现外来回合（`foreignAfterLast` 只计数） | Hub 下一回合 resume 时回放会带上这些内容；保持中的进程不知道（它持有的会话副本已过期） |
| 网关型 Harness（Hermes、OpenClaw） | 原生会话在用户自己的网关里；Hub 启动的只是查看器或桥 | 绑定同上；`execution: gateway`：查看器退出不是静止证据 | 查看器每回合启动与关闭；Hermes 每次 open 都 `session/load` 回放（`hermes.ts:185`） |
| 工作区被占用 | 另一对话持有租约：排队（等待预算）或 `WORKSPACE_KEPT`（被保持进程占用，不排队） | Run queued 等待或 failed | 不启动 |
| 外部改动与配置改动 | 工作区目录身份变了 → `CONFIGURATION_CHANGED`（`binding-factory.ts:46–49`）；目录指纹变了 → 目录缓存失效（ADR-033） | Run failed（准备阶段） | 不启动或启动失败即关闭 |

**关闭**

| 情况 | 发生什么 | 各层状态 | 进程（现状） |
|---|---|---|---|
| 关闭对话 | 取消排队、停止活动回合、取消待决切换、关闭保持进程、等待全部结束，再记 closed（`runtime.ts:664–682`） | 对话 closed（不可重开）；没有删除对话的命令；内容存储只回收未被引用的项（7 天，`content-store.ts:14`） | 关闭 |

## 2. 现状的问题

**资源**

- R1【事实】每回合启动一次原程序：`DirectorySessionBindingFactory.prepare` 为每个回合建私有临时根、观察一次安装、启动进程（`binding-factory.ts:146–177`），`runtime.ts:1402–1408` 每回合 `initialize` 加 `open`。回合结束即关（`:1504–1508`）。
- R2【事实】保持（ADR-030）与并行（ADR-036）是两份预算：保持最多 4 个（`runtime.ts:66`）、并行最多 4 个对话（`session.ts:315`），互不计入，最坏 8 个进程同时存在，而且没有按内存的上限。【实测】开销的大头不是进程而是会话：Claude 每个会话、Codex 每个线程都启动一整套用户配置的 MCP 服务器，本机各约 1.3 GB、0.9 GB；OpenCode 332 MiB 起、每会话约 10 MiB；dsh 260 MiB；Hermes 查看器 190 MiB、OpenClaw 桥 450 MiB（网关另计）。按进程数封顶管不住内存。
- R6【实测】每个回合的绑定都换一个新 TMPDIR（`binding-factory.ts:151`、`:157`），OpenCode、dsh、OpenClaw 每次启动都重写编译缓存或解出原生库（1.4–13 MB）；持久 TMPDIR 让 initialize 从约 590 / 960 / 1250 ms 降到约 160 / 580 / 1100 ms。
- R3【事实】切换即关闭：只换模型也算 `selection_changed`（`runtime.ts:69–72`、`:1626`），A→B→A 要启动 A 两次。
- R4【事实】读目录、列会话、读会话都要各启动一次原程序（`binding-factory.ts:210–276`）；ADR-033 的目录缓存减少了读目录的次数，但列会话与接续仍各一次。
- R5【事实】Driver 一条连接一个会话（`acp.ts:504`、`codex.ts:336`、`pi.ts:169`；契约注释 `control.ts:224`），而 Codex app-server 一个进程本来就承载多个线程（它还会把子 Agent 线程附着到同一连接，`codex.ts:212–213`），ACP 的每个会话方法都带 `sessionId`。

**时延**

- L1【事实】旧实现测得“启动 + 建会话”：Claude 约 2.9 秒、Codex 约 4.3 秒、Cursor 约 7.8 秒、OpenClaw 约 1.3 秒、Pi 约 0.7 秒（[第一链路调研](../../research/first-chain-products-2026-10-11.md)第 548 行引用的验收 L7）；Hermes 启动原程序（建进程、握手、恢复会话、等回放）4.76 秒，占回合总时 9.7 秒的一半（[第一链路打磨](../../verification/first-chain-polish-2026-10-11.md)第 44 行）；复用保持进程时启动 7 毫秒（同上第 233 行，ADR-030）。2026-11-03 实测（第 5 节）：启动到 initialize 中位 Claude 124 ms（只起适配器）、Codex 26、OpenCode 644、dsh 967、Hermes 553、OpenClaw 1259 ms；启动到首个会话 445 / 99 / 2256 / 1269 / 1794 / 2028 ms；同进程第二个会话 289 / 13 / 76 / 18 / 147 / 364 ms。
- L2【事实】`session/load` 回放整份历史：Hermes 每回合都 load（`hermes.ts:185`），通用 ACP 在代理不声明 `session/resume` 时也 load（`acp.ts:511`），回放要等到安静才算 open 完成（`acp.ts:521`、`:492`）；读取一份长会话的上限单独放到 120 秒（`binding-factory.ts:21`）。历史越长，每回合的固定开销越大【推断】。
- L3【事实】派发前至少 6 次整份快照提交，最小回合 11 次，每次约 19 ms/MiB（[R6](../relay/round1/r6-performance-caching.md)第 11、203、240 行）。这与进程无关，ADR-055 已把存储优化列为前置片（G075）；本设计不重复做，但宿主登记不能再往快照里加字段（第 4.8 节）。

**正确性**

- C1【事实】保持进程与切换耦合：切换生效先关来源进程（`runtime.ts:1626`），所以“切到 B 看一眼再回 A”必然丢掉 A 的后台任务。
- C2【事实】保持进程持有工作区租约（ADR-030 决定），另一对话同工作区得到 `WORKSPACE_KEPT`、不排队（`runtime.ts:1386–1387`）；空闲的进程本身并不在写，租约却被它占着【推断：这是为后台任务付的代价，对没有后台任务的空闲进程是浪费】。
- C3【事实】崩溃清理只覆盖保持中的进程（`listKept`、`reapKept`）；回合进行中服务退出时，进程不在任何记录里，只能靠租约隔离等待人工核实（ADR-030 边界）。
- C4【事实】Hub 不判断原生会话是否“新鲜”：用户在原程序里继续过（ADR-039）、原生命令改了上下文（`/clear`、`/undo`）之后，保持中的进程持有的是旧的会话视图；现状靠“每回合重开”掩盖了这个问题，一旦复用进程就必须显式判断（ADR-055 第 7.2 节已经要求 `verify=on_next_open` 的 Driver 在 suspect、pending 时不复用）。
- C5【事实】升级关闭的是“空闲保持的进程”（ADR-043），复用范围扩大后要有通用的“排空”语义：不再接新租借，等现有回合结束再关闭。
- C6【实测】关闭宽限 500 ms（`binding-factory.ts:170`）偏短：六家都在 stdin EOF 后自行退出，但 Claude 带会话时要 766–811 ms、Codex 304–1124 ms，生产会在它们自然退出前就 SIGTERM。
- C7【实测】只靠进程组清理不够：Codex 19 个后代里 18 个（MCP 服务器）、Claude 2 个 MCP 后代、OpenCode 的工作进程与 OpenClaw 的子进程都不在领头进程组里，组信号到不了它们；本次它们在组清空后 0.57–1.14 s 内都自己退出了，但“退出”没有被核对过。

**历史**

- H1【事实】公共历史是线性的：`runs`、`messages`、`switches` 只追加、不可重排（`state.ts:437–440`）；分支与接续都把历史整份复制进 `origin.history`（`session.ts:176–190`），1 MiB 上限（ADR-025）。
- H2【事实】快照每次整份重写（`sqlite-store.ts:343–363`），8 MiB 上限（`state.ts:18`）。
- H3【事实】内容存储中被任何快照引用的永不回收，未被引用的 7 天后回收（`content-store.ts:14`、`:192–199`）。
- H4【事实】原生历史在各家：Hub 只存 ID，接续与分支时只能回放拿到文本；Hub 没有逐 Run 的原生回合身份（ADR-025 背景），所以原生分支只能在精确位置建立。
- H5【推断】要让“切换 Harness”“回到更早的位置继续”“比较两条路线”都成为对话内的操作而不是复制整份历史的新对话，公共历史要从线性记录变成树（第 7 节），这是长期工作。

## 3. 参考

### 3.1 Pi 0.85.1：会话是只追加的树，进程是可切换会话的宿主

来源【事实】：本机源码 `/Users/sd3/Desktop/project/pi`（`packages/coding-agent` 0.85.1，`git log` 顶部 `da840b6`），`docs/sessions.md`、`docs/session-format.md`、`docs/rpc.md`、`src/core/agent-session-runtime.ts`、`src/core/session-manager.ts`。

- **会话文件**：`~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`，按工作区目录分组；版本 3；第一行是头（`id`、`cwd`、可选 `parentSession`），其余每行一个条目，带 `id` 与 `parentId`，形成树；“叶子”是当前位置（`session-format.md` 的 Entry Base 与 Tree Structure 两节）。
- **条目种类**：`message`（user、assistant、toolResult、bashExecution、custom、branchSummary、compactionSummary）、`model_change`、`thinking_level_change`、`compaction`（带 `summary`、`tokensBefore`，新版带 `retainedTail` 作自包含检查点）、`branch_summary`（离开一条分支时对它的摘要，挂在新位置）、`custom` / `custom_message`（扩展状态，后者进入上下文）、`label`、`session_info`。换模型、压缩、分支摘要、标签都是树上的记录，不改历史。
- **投影**：`buildContextEntries()` 从叶子走回根，遇到压缩条目就从它（及其 `retainedTail` 或 `firstKeptEntryId`）起算；`buildSessionContext()` 再把条目变成发给模型的消息，并从整条路径取出当前模型与思考档位（`session-manager.ts:418`、`:461`）。
- **三种分支**：`/tree` 在同一文件里移动叶子（可附分支摘要）；`/fork` 从某条用户消息新建文件；`/clone` 复制当前活动分支到新文件；后两者在新文件头记 `parentSession`（`sessions.md` 的 `/tree`、`/fork`、`/clone` 对照表）。
- **RPC 模式的进程**：一个 `pi --mode rpc` 进程能 `new_session`（可带 `parentSession`）、`switch_session`（给会话文件路径）、`fork`（给条目 ID）、`clone`（`rpc.md:160–185`、`:620–692`）。同一时刻只有一个活动会话：`AgentSessionRuntime.switchSession` 先 `teardownCurrent`（等当前回复结束并落盘、发 `session_shutdown`、`dispose`），再按目标会话文件的 cwd 重建“与 cwd 绑定的服务”（工具、扩展、技能、信任，`agent-session-services.ts:31–35` 的说明）并创建新的 `AgentSession`（`agent-session-runtime.ts:167–224`）。会话文件记录的 cwd 不存在时拒绝切换（`session-cwd.ts`）。
- **执行中插话**：`steer` 在当前助手回合执行完工具后、下一次模型调用前插入；`follow_up` 等代理完全结束后再发（`rpc.md:59–122`）。
- **对本设计的启示【推断】**：(1) 会话内容与进程完全分离，进程只是“当前打开哪个文件”；(2) 切换会话的代价是重建 cwd 绑定的服务，而不是重启进程——所以宿主按 cwd（工作区）分类是自然边界；(3) 分支、换模型、压缩都是记录而不是复制，这正是第 7 节记录树的样子；(4) Pi 已在 ADR-046 冻结，不作目标，只作参考；本机的 Pi 是指向源码检出的 npm 链接，官网策略下没有控制入口，2026-11-03 的实测没有启动它（实测记录第 7 节）。

### 3.2 线程池概念的对应表

| 线程池概念 | 本设计 | 差别 |
|---|---|---|
| 线程 | 宿主（NativeHost）：原生进程或到原生服务的连接 | 宿主有状态（打开着哪些会话、在哪个工作区） |
| 任务 | 回合对某个原生会话的租借（SessionLease） | 只有打开了该会话的宿主才能执行它 |
| 线程本地存储 | 宿主上已打开的原生会话 | 复用价值与“新鲜度”风险都来自它 |
| 核心 / 最大线程数 | 以内存为主、按类封顶的预算（`hostMemoryBudget`、`classCaps`）、固定上限 | 没有“核心”：不预热，保活不建会话 |
| keep-alive | 按类的空闲时限（会话与宿主各一档）、固定宿主一档加硬上限 | 固定宿主还持有工作区租约 |
| 任务队列 | 现有的每对话队列、同工作区 FIFO、全局空位等待（ADR-036） | 池只决定“用哪个宿主”，不决定“谁先跑” |
| 拒绝策略 | 预算满且无可淘汰者时回合等空位（`waitingForSlot`） | 等待不计预算 |
| 亲和 | 分类键：Harness + 入口 + 安装指纹 + 启动环境指纹 | 跨类不复用 |
| 回收 | 崩溃后按进程组身份识别并结束；升级与配置变更时排空 | 回收要有证据（terminated / gone / unconfirmed） |
| 预热 | 不提供建会话式预热；保活只保住没有会话的进程 | 实测：不发提示也留原生记录；原程序会连 MCP、写状态（ADR-033） |

### 3.3 其他参考

来源与局限见各条【事实】：

- **Zed**：每个 agent × 工作区一个常驻 ACP 进程，多会话共用；打开草稿即 `initialize + session/new`；只回收“空闲且可 load”的线程（[第一链路调研](../../research/first-chain-products-2026-10-11.md)第 399、548 行）——分类键含“工作区”的直接依据。
- **AionUi**：打开会话即预热，页面可见时 30 秒续租、租期 90 秒，空闲 10 分钟回收（同上第 342、548 行）——预热条件与空闲时限的参考，但默认不预热。
- **Happy**：同一进程连续处理回合，只有启动期参数（模型、思考、系统提示、工具、计划模式）变化才重启（同上第 548 行）——`launchBound` 声明即“启动参数哈希”。
- **Toad**：每会话一个常驻进程（同上第 309 行）——单会话型宿主的做法。
- **ACP 协议**：会话方法都带 `cwd` 或 `sessionId`（`acp.ts:392–393`、`:500–521`【事实】）；协议允许一条连接多个会话，各代理是否真支持要探针（ADR-053：按程序实际报告的能力判断）。
- **Codex app-server**：`thread/start`、`thread/resume`、`turn/start{threadId}`（`codex.ts:377`、`:543`【事实】），并把子 Agent 线程附着到连接（`:212–213`）；ADR-053 研究提到 `codex app-server daemon`（未核实；本设计不用用户级守护进程）。
- **接力终稿**（ADR-055）：`RelayCapabilities.execution`、`verify: "on_next_open"` 与“suspect / pending 时不复用保留进程”（[终稿](../relay/relay-architecture.md)第 7.2 节），以及 Q23（Hub 崩溃时在途回合的进程组能否由新所有者确认已结束）。新鲜度表直接引用这些判定。

## 4. 目标架构

### 4.1 原则

1. **会话是数据，进程是宿主。** 原生会话由 (harnessId, controlId, checkpoint) 标识并由原程序保存；宿主只是“当前打开着哪些会话”的容器。回合租借会话，不拥有进程。
2. **复用必须有新鲜度判定。** 不新鲜的会话重新打开（或按接力规则先核对）；判定的依据写进事件。像原生：复用不改变原生会话的内容语义。
3. **写租约跟着写走。** 空闲宿主不占工作区；有后台任务（可能在写）的宿主固定到对话并持有租约——这正是 ADR-030 的保持语义，作为池的一个子集保留。
4. **一份预算。** 运行中、空闲、固定的宿主计入同一上限；淘汰只碰空闲且未固定的宿主；拒绝改为等待空位并可见。
5. **Gateway 不按产品分支。** 差别只经 Driver 的静态能力声明（`HostCapabilities`，不出现产品名）进入，与 `RelayCapabilities` 同一做法。
6. **登记先于使用。** 宿主在持久登记（进程组身份）之后才承载回合；新所有者按登记识别并结束遗留的宿主。
7. **不提供建会话式预热。** 实测证明不发提示也会留下原生记录，启动用户的程序还会连接 MCP、写状态；保活只保住没有会话的进程，原生会话只在回合取得工作区租约之后建立（INV-42）。

### 4.2 接口草案（TypeScript）

品牌 ID 与现有 `SessionId`、`RunId` 同一写法（`session.ts:5–14`）。类型放在契约层（`src/contracts/native-host.ts`），实现分别在应用层（宿主池）、基础设施层（登记、进程度量）与 Driver。下面是草案，字段名在契约任务里冻结。

```ts
declare const hostBrand: unique symbol;
declare const leaseBrand: unique symbol;
declare const classBrand: unique symbol;
/** 一个宿主：一个原生进程或一条到原生服务的连接。 */
export type HostId = string & { readonly [hostBrand]: true };
/** 一次会话租借：某个回合（或某个对话的后台保持）对宿主上某个原生会话的独占使用权。 */
export type SessionLeaseId = string & { readonly [leaseBrand]: true };
/** 宿主分类键：sha256(harnessId, controlId, installationFingerprint, launchFingerprint)。 */
export type HostClassKey = string & { readonly [classBrand]: true };

/** Driver 的静态声明；只描述机制，不出现产品名；缺项按最保守值。 */
export interface HostCapabilities {
  /** 一个宿主能承载的原生会话：恰一个（一进程一会话）、多个但同一时刻一个活动（切换式）、多个并发（服务式）。 */
  readonly sessions: "one_per_process" | "switchable" | "concurrent";
  /** 会话的工作区能否与宿主启动时的 cwd 不同；launch_cwd_only 时分类键必须含工作区。 */
  readonly sessionCwd: "launch_cwd_only" | "per_session";
  /** 重新打开一个已有会话要付的代价：回放全部历史、只传引用、未知；byLoadOnly 表示只有回放一种办法。 */
  readonly reopen: { readonly cost: "replay" | "reference" | "unknown"; readonly byLoadOnly: boolean };
  /** 一个会话常驻占用的量级（探针测得）：light 不随会话明显增长；heavy 每个会话自带一套子进程（CLI、MCP 服务器）。 */
  readonly sessionMemory: "light" | "heavy" | "unknown";
  /** 进程内关会话能否收回它的资源：in_process（会话的子进程随之退出）、process_only（只有退出进程才释放）、unknown。 */
  readonly sessionRelease: "in_process" | "process_only" | "unknown";
  /** 哪些选择是宿主的启动参数：变了就不能用这个宿主（Happy 的“启动参数哈希”）。 */
  readonly launchBound: readonly ("model" | "options" | "collaboration_mode" | "provider")[];
  /** 与 RelayCapabilities.execution 同义：gateway 时宿主退出不是原生会话静止的证据。 */
  readonly execution: "process" | "gateway";
  /** 没有回合时程序是否可能仍在写工作区（后台任务）；possible 的宿主只能固定或关闭，不能空闲入池。 */
  readonly idleActivity: "none" | "background_possible" | "unknown";
  /** initialize 是否会建会话或写用户状态；只有 none 允许保住没有会话的进程（保活）；任何值都不允许为预热建会话（INV-42）。 */
  readonly initializeSideEffects: "none" | "creates_session" | "writes_state" | "unknown";
  /** 同一宿主上不同会话能否同时执行回合（只有 concurrent 的服务式宿主可能为 true）。 */
  readonly concurrentTurns: boolean;
  /** 原生会话里是否可能出现 Hub 之外的回合（用户在原程序里继续、网关的其他客户端）；用于新鲜度判定。 */
  readonly foreignTurns: "detectable_on_open" | "detectable_by_listing" | "undetectable";
  /** 该 Driver 的宿主探针（第 10 节 H1–H6）在最新正式版通过后翻转；生产只对 true 开放多会话复用。 */
  readonly probed: boolean;
}

export type HostState = "starting" | "idle" | "leased" | "pinned" | "draining" | "closing" | "dead";
export type HostCloseReason = "idle" | "evicted" | "budget" | "stale_class" | "harness_upgrade" | "config_changed" | "exited"
  | "unhealthy" | "gateway_shutdown" | "ended_by_user" | "conversation_closed" | "native_reset" | "branched" | "disabled" | "selection_changed";

/** 宿主上一个已打开的原生会话。 */
export interface HostedSession {
  readonly native: NativeConversationId;
  readonly binding: { readonly sessionId: SessionId; readonly harnessId: string; readonly controlId: string; readonly checkpoint: string };
  /** 最近一次确认它新鲜的依据与时间；再次租借前按 4.4 节重判。 */
  readonly freshness: FreshnessVerdict;
  readonly lastUsedAt: number;
}

export interface NativeHost {
  readonly id: HostId;
  readonly classKey: HostClassKey;
  readonly state: HostState;
  readonly control: HarnessControl;
  readonly sessions: ReadonlyMap<NativeConversationId, HostedSession>;
  /** 进程组身份与最近一次采样（RSS 等），供登记与预算。 */
  health(): HostHealth;
  /** 不再接受新租借；现有租借结束后关闭（升级、配置变更、分类键失效）。 */
  drain(reason: HostCloseReason): Promise<void>;
  close(reason: HostCloseReason): Promise<CleanupEvidence>;
}

export interface HostHealth {
  readonly identity: KeptProcessIdentity | null;
  readonly healthy: boolean;
  readonly startedAt: number; readonly lastUsedAt: number; readonly idleSinceAt: number | null;
  readonly rssBytes: number | null; readonly sampledAt: number | null;
}

export type FreshnessVerdict =
  | { readonly fresh: true; readonly basis: "just_opened" | "same_owner_no_foreign" | "verified_on_open" | "native_session_unchanged" }
  | { readonly fresh: false; readonly reason: StaleReason };
export type StaleReason = "foreign_turns" | "unknown_outcome" | "binding_unconfirmed" | "binding_forking" | "relay_pending" | "relay_suspect"
  | "context_effect" | "config_changed" | "harness_upgraded" | "launch_bound_changed" | "workspace_identity_changed" | "host_unhealthy" | "undetectable";

export interface SessionLeaseRequest {
  readonly sessionId: SessionId; readonly runId: RunId; readonly epoch: number;
  readonly selection: HarnessSelection; readonly configuration: SessionConfiguration;
  readonly binding: NativeSessionBinding | null;          // 要继续的原生会话；null 表示新建
  readonly workspaceLease: WorkspaceLease;                 // 回合已取得的写租约，由池核对而不是代取
}
export interface SessionLease {
  readonly id: SessionLeaseId; readonly host: HostId; readonly native: NativeConversationId;
  readonly sessionId: SessionId; readonly runId: RunId; readonly epoch: number;
  readonly reused: boolean;                                 // 用的是池里已有的宿主
  readonly reopened: StaleReason | null;                    // 会话被重新打开的原因；null 表示直接续用
  assertHeld(): void;
  /** 归还：结算后放回池（idle）；交给对话固定（pinned，ADR-030）；结果未知则宿主转 dead 并进入清理链。 */
  release(outcome: "settled" | "pin" | "unknown"): Promise<void>;
}

export interface HostPool {
  /** 选宿主：同类空闲且会话新鲜 → 续用；同类空闲但会话不新鲜或未打开 → 在该宿主上重开/新开；无同类空闲 → 预算内新建（必要时淘汰 LRU 空闲宿主）→ 等空位。 */
  lease(request: SessionLeaseRequest): Promise<SessionLease>;
  pin(sessionId: SessionId, lease: SessionLease): void;    // 保持原生进程（ADR-030）
  unpin(sessionId: SessionId, reason: HostCloseReason): Promise<void>;
  drainClass(classKey: HostClassKey, reason: HostCloseReason): Promise<number>;
  shutdown(): Promise<void>;
  metrics(): HostPoolMetrics;
}
```

`HarnessControl` 要加的最小能力（可选方法，没有的 Driver 按 `one_per_process` 处理）：`openSession(cwd, model?, options?, checkpoint?)` 返回会话句柄而不改变连接的“当前会话”、`closeSession(native)`、`switchSession(native)`（切换式宿主）；`startText` 已经带 `NativeConversationId`（`control.ts:288`），不用改。第三方类型仍留在 Driver 内（R25）。

### 4.3 宿主池：分类键、预算、淘汰、空闲保活

**分类键【建议】**：`HostClassKey = sha256(harnessId, controlId, installationFingerprint, launchFingerprint)`。

- `installationFingerprint`：入口可执行文件与其依赖的文件身份（设备、inode、大小、mtime），复用 ADR-033 的 `catalogFingerprint`（`binding-factory.ts:200–213`）；换版本即换类（升级后旧宿主排空）。
- `launchFingerprint`：启动环境——cwd 与 PWD（工作区规范路径）、从工作区与配置引用读出的环境值（`referencedNativeValues`、`nativeDescriptorValues`，`binding-factory.ts:153–157`）、PATH、受管 Provider 的物化配置、以及 Driver 声明为 `launchBound` 的选择（模型、选项、协作模式）。TMPDIR 改为按类稳定的私有目录（4.12），不进指纹。
- 第一、二期分类键一律含工作区（即使 Driver 声明 `sessionCwd: per_session`）：实测四家的 cwd 按会话生效，但环境值按工作区读出，跨工作区共用宿主留到有探针之后。

**预算：以内存为主、按类封顶【建议；初始值来自 2026-11-03 实测，只是起点，要按目标机器的内存调整】**。实测（第 5 节）表明开销的大头不是进程数而是会话：Claude 每个会话、Codex 每个线程都启动一整套用户配置的 MCP 服务器（本机各约 1.3 GB、0.9 GB），而 OpenCode、dsh、Hermes、OpenClaw 的会话几乎不占内存（每个 ≤10 MiB），进程冷启动却要 1–2 秒。所以统一的“最多 N 个宿主”没有意义，预算分三层，全部在一个配置解析器（`resolveHostBudgets`）里解析，无效即拒绝：

| 层 | 参数 | 初始值 | 依据 |
|---|---|---|---|
| 全局内存上限 | `hostMemoryBudgetBytes` | 物理内存的 1/8（64 GiB 机器即 8 GiB），按采样的整个进程树 RSS 之和计；超出即按下面的淘汰顺序收回 | 本机 3 个 Claude 会话加 3 个 Codex 进程约 7 GB |
| 按类封顶 | `classCaps[kind]` | 重且进程内可收回（Claude）：同时活着的会话 ≤3，会话空闲 10 分钟 `session/close`，适配器没有会话 2 分钟后关闭；重且进程内收不回（Codex）：每个对话一个进程、全局 ≤3 个进程，空闲 5 分钟关闭；轻多会话（OpenCode、dsh）与服务型连接（Hermes、OpenClaw）：每进程 ≤8 个会话（只实测到 2 个），进程保活 10–15 分钟；单会话型（Pi，待测）：每对话一个进程，空闲 5 分钟 | 实测记录第 5.2、10.1 节。保活时长按“重建代价 ÷ 占用内存”取：重建便宜（Codex 进程 26 ms、Claude 会话 0.3 s）而占用大的宜短，冷启动贵（1.8–2.3 s）而会话轻的宜长 |
| 不变的上限 | `maxPinned` 4、`maxParallel` 4、`pinnedIdleTtlMs` 30 分钟（“没有回合也没有原生事件”）、`pinnedHardCapMs` 4 小时 | ADR-030、ADR-036 | — |

每个 `kind` 由 Driver 声明的 `sessions`、`sessionMemory`、`sessionRelease` 决定，不写产品名；上表括号里的产品名只是本机实测的对应。

**选宿主的顺序**（`HostPool.lease`）：

1. 同类宿主里该会话仍活着且新鲜（4.4）→ 直接按会话 ID 续用，不发 load/resume（`reused: true, reopened: null`）。
2. 同类宿主活着但该会话不新鲜 → 声明 `sessionRelease: in_process` 的在该宿主上 `session/close` 再重开；收不回的直接关宿主再新建；`reopened` 记原因。
3. 同类宿主活着、未打开该会话、该类按会话计且未到上限 → `openSession`（切换式用 `switchSession`）；每对话一个进程的类不走这一步。
4. 需要新宿主 → 该类未到上限且全局内存预算有余则新建；否则先按淘汰顺序收回；仍不能 → 回合等空位（现有 `waitingForSlot`，可见、不计预算）。
5. 从不收回 `leased`、`pinned`、`draining` 的宿主或它们的活动会话。

**淘汰顺序**：先收回最久未用的空闲会话（声明可收回的类），再关最久未用的空闲宿主；重的类先于轻的类（收回一个 Claude 会话或一个 Codex 进程约还回 1 GB，轻的类关了也省不了多少）；同类内优先关“没有任何新鲜会话”的宿主。每次收回记 `native.session_closed{reason: "evicted"}` 或 `native.host_closed{reason: "evicted"}`。

**空闲保活**：会话与宿主各有空闲计时（`unref` 计时器，现状 `runtime.ts:1522` 的做法）；进入空闲时采样一次整个进程树的 RSS（macOS `ps -axo pid,ppid,pgid,rss,comm`，领头进程、后代与同组成员之和，2 秒上限，失败记 null）。固定宿主沿用 ADR-030 的两档时限。【实测】六家空闲 60 秒都不写工作区，也几乎不发通知（只有 Claude 为活会话发了 1 条 `available_commands_update`），所以空闲保活不会在空闲时改动用户文件。

**回收与关闭**：见 4.11 节的关闭链。宿主关闭不改变任何绑定的状态：绑定是数据，关的只是宿主。

### 4.4 会话“新鲜度”判定表

租借前对“宿主上已打开的会话”逐项判定；任一命中即不新鲜，按表中处理。判定依据与结果写进 `native.session_reused{basis}` 或 `native.session_reopened{reason}`。

| 情形 | 判定依据【事实/建议】 | 结果 | 处理 |
|---|---|---|---|
| 用户在原程序里继续过（ADR-039） | Driver 声明 `foreignTurns`：`detectable_by_listing` 时比较原生列表的 `updatedAt` 或回合数与上次结算记录；`detectable_on_open` 时只能重开回放核对；`undetectable` 时按不新鲜处理 | `foreign_turns` 或 `undetectable` → 不新鲜 | 重开（回放）；v13 的回放核对同时推进送达判断 |
| 结果未知 | 该绑定上最后一个 Run 为 unknown | `unknown_outcome` | 不复用；对话 blocked，按 ADR-014 恢复；process 型按 ADR-055 D6 确认进程组结束后只读 resume |
| 绑定 unconfirmed / forking / fork-pending | 绑定状态 | `binding_unconfirmed` / `binding_forking` | 不复用；按现有规则失败或等待 fork 结果 |
| 接力待核 | `binding.relay.sync ∈ {pending, suspect}`（ADR-055 第 7.2 节；`verify=on_next_open` 的 Driver 不复用保留进程） | `relay_pending` / `relay_suspect` | 关闭会话再重开回放，核对后才派发 |
| 原生命令改了上下文 | 上一回合的 `contextEffect ∈ {clear, rewind, unknown}`（`compact` 不算：压缩发生在会话内，重开反而丢掉已缓存的前缀） | `context_effect` | clear：新纪元，新会话；rewind / unknown：重开核对 |
| 改了配置 | `catalogFingerprint` 变化（ADR-033）或工作区 `.claude/settings*`、`.codex/config.toml` 等被列入指纹的文件身份变化 | `config_changed` | 排空整类宿主（`stale_class`），新建 |
| 升级了 Harness | 安装指纹变化（ADR-043 升级流程也主动调用 `drainClass`） | `harness_upgraded` | 排空整类 |
| 启动参数变了 | 选择里的 `launchBound` 项与宿主不同（Pi 的模型与 provider、Codex 的协作模式） | `launch_bound_changed` | 不能用该宿主；分类键已不同，走新建 |
| 工作区目录身份变了 | `pinnedDirectory` 失败（`binding-factory.ts:46–49`） | `workspace_identity_changed` | 排空整类；回合以 `CONFIGURATION_CHANGED` 失败（现状语义） |
| 宿主不健康 | `healthy()` 为 false、进程已退出 | `host_unhealthy` | 关闭宿主（`exited`），新建 |
| 什么都没变 | 同一对话、同一绑定、上一回合在本宿主上结算且上述项全不命中 | fresh{`same_owner_no_foreign`} | 续用 |

**活会话与恢复不是一回事【实测】**：同一宿主里仍打开着的会话直接按 ID 续用，不发 load/resume——Claude、OpenCode、Hermes 接受对活会话的 load/resume（14 / 4 / 195 ms），dsh 拒绝（-32602 already active），Codex 与 OpenClaw 对没有回合的会话拒绝（no rollout found、网关无记录）。load/resume 只在进程重启后、或新鲜度判定要求重开时使用；宿主维护“进程里有哪些活会话”的表（`HostedSession`）。

“新鲜”只对**同一绑定**成立：另一对话的会话从来不是“同一会话”，宿主可以复用，会话必须各自打开。

### 4.5 工作区租约规则

- 租约仍由回合在 `prepare` 时取得、在结算且清理确认后释放（现状语义，`binding-factory.ts:147`、`:291–300`）；池只核对回合已持有租约（`SessionLeaseRequest.workspaceLease`），从不代取。
- 池内**空闲**宿主不持有租约：它所在工作区可以被同工作区的其他对话（经另一宿主或同一宿主）写入。前提是 Driver 声明 `idleActivity: none`，或 `background_possible` 但本宿主在最近一次结算后 `unattributedUpdates` 为 0 且没有运行中的 activity；否则该宿主不能空闲入池，只能固定（对话开了保持）或关闭。
- **固定**宿主继续持有租约（ADR-030 方案 C 不变）：另一对话同工作区得到 `WORKSPACE_KEPT`，界面让用户选择“结束对话 X 的后台进程并继续”或“稍后再试”。
- 回合结束时清理未确认 → 该宿主 `dead`，租约隔离（`WORKSPACE_QUARANTINED`），不进池。
- 两个对话同一工作区、同一类：串行使用同一个空闲宿主；因为单一写入者，不会出现两个回合同时在同一工作区的宿主上执行（即使 `concurrentTurns: true` 也按工作区串行）。
- 不同工作区、同一 Harness：各自的类，各自的宿主；预算共享。

### 4.6 后台任务的固定

- 开启“保持原生进程”的对话，回合完成后 `release("pin")`：宿主转 `pinned`，归该对话（`kept.conversation` 语义不变），计入 `maxPinned`，持有租约，空闲时限 30 分钟（“没有回合也没有原生事件”），自上一回合起 4 小时硬上限。
- 固定宿主不参与其他对话的租借（它可能在写工作区）；它所属对话的下一回合优先用它（现状 `takeKept`）。
- **切换后保留来源宿主**（短期即做）：对话 A→B 时，A 的宿主不再因 `selection_changed` 关闭：若 A 对话开了保持且 A 宿主有后台活动 → 继续 pinned；否则转池内 idle（不持租约）。回到 A 时，按 4.4 节判定 A 会话是否新鲜（在 B 期间工作区被 B 写过，但这不影响 A 原生会话的新鲜度；接力的欠交由 ADR-055 补发）。
- 关闭对话、原生重置、分支、用户“结束后台进程”、升级：固定宿主按现有触发关闭；只是“分支”不再关闭来源宿主（分支用独立连接，源会话不被继续，`runtime.ts:1586–1612`），改为 `unpin` 后转 idle。

### 4.7 预热与保活：不提供建会话式预热

- 【实测】不发提示也会留下原生记录——Codex 的 rollout 文件、dsh 的会话目录与缓存、Claude 的 `session-env` 与项目 `memory` 目录、OpenCode 的数据库行、Hermes 网关里的会话；只有 OpenClaw 不留（实测记录第 5.3、8 节）。ADR-033 已经为读目录建出的探测会话单独记录并默认隐藏，正是同一个问题。
- **规则【建议，INV-42】**：预热与保活都不得建立原生会话；原生会话只在回合取得工作区租约之后建立。所以不提供“建会话式预热”，4.3 节的保活只保住进程——initialize 之后、没有会话的宿主（例如 Claude 适配器在最后一个会话关掉后再活 2 分钟），会话按需建。
- 不提供用户可见的预热开关；界面只保留“启动约 N 秒”（ADR-033 决定 4）与复用说明。保住进程是否值得由 4.3 节的按类时限决定：Claude 适配器 124 ms、Codex 26 ms 就能起来，保活进程的价值小；OpenCode、dsh、Hermes、OpenClaw 冷启动 1–2 秒，保活值得。

### 4.8 崩溃恢复与登记

- **登记**：宿主启动后、承载任何回合之前，写入安装级表 `native_hosts`（业务库，STRICT）：`host_id`、`class_key`、`harness_id`、`control_id`、`workspace`、`pgid`、`started_at`（`ps -o etime=` 换算，ADR-030 做法）、`state`、`pinned_session_id`、`run_id`、`last_used_at`、`rss_bytes`、`owner_generation`。写入不经快照（像 ADR-055 的 `relayWrite`：单独事务、不升 version），不加重 L3 的整份快照提交。固定宿主同时沿用快照里的 `retained`（它决定该对话的租约是否释放）；空闲宿主只在登记表里。
- **接管**（服务启动、接受工作前）：对 `owner_generation` 不是本代的行逐个按进程组身份 `end`：`terminated | gone | unconfirmed`；固定宿主按 ADR-030 释放或隔离该对话的租约；空闲宿主不持租约，结束即可；`leased` 行（回合进行中服务退出，ADR-055 Q23、现状 C3）结束后仍不释放租约（Run 已是 unknown，按 INV-11、INV-12 走恢复），但把“进程组已结束”写进 `native.host_lost`，为 D6 的“继续原会话”提供确认；`unconfirmed` 的行保留并在 stderr 报告。每行最多约 6 秒。
- **版本**：业务库 v14（v13 是接力的 11 张表），只加一张表、不改快照；ADR-049 的迁移前备份照常（代价：多一次备份与停服）【待拍板 D2】。逃出进程组的后台任务沿用 ADR-030 补充条。

### 4.9 升级时排空

- ADR-043 升级流程的“关闭 HarnessHub 的空闲进程”改为 `drainClass(classKey, "harness_upgrade")`：该安装的全部类（所有工作区）不再接新租借，空闲者立即关闭，固定者按 ADR-043 现状关闭并记原因，`leased` 的回合照常阻止升级（确认框列出）。
- 升级完成（版本核实）后安装指纹变化，旧类自然失效；新回合新建新类宿主。
- 配置变更（`config_changed`）同样排空整类，不阻止用户操作。

### 4.10 可观测指标与事件

**事件**（对话事件，与现有 `native.process_*` 并存；固定宿主沿用 ADR-030 的四个事件名）：`native.host_started{hostId, classKey, coldStartMs}`、`native.session_reused{hostId, basis}`、`native.session_reopened{hostId, reason, replayMs?, replayBytes?}`、`native.host_closed{hostId, reason, cleanup, outside}`、`native.host_evicted{hostId, lruAgeMs, rssBytes}`、`native.host_lost{hostId, outcome, leaseReleased}`（接管）、`native.host_drained{classKey, reason, count}`。安装级（不属任何对话）的淘汰与接管另写到服务日志。

**指标**（`GET /api/v1/native-hosts`，只读；界面在“Harnesses”页与对话执行详情里显示）：按类与状态的宿主数；每个宿主的 Harness、所属对话（不含路径）、状态、会话数、空闲时长、RSS 采样；回合复用率（`reused / dispatched`）；冷启动与重开用时各自的分布；淘汰次数按原因；接管结果计数；等空位的回合数与等待时长。不记录路径、环境变量值与会话内容。

### 4.11 关闭链、关闭宽限与离组后代

- **现状【事实】**：关闭先关 stdin，再等 `closeGraceMs`，不退出就对进程组 SIGTERM、再 SIGKILL（`json-rpc-process.ts:372–392`）；生产的宽限是 500 ms（`binding-factory.ts:170`、`:261`）。
- 【实测】六家都在 stdin EOF 后自行退出，没用到信号；但 Claude 带会话时要 766–811 ms、Codex 304–1124 ms，500 ms 的宽限会在它们自然退出之前就 SIGTERM。Codex 19 个后代里 18 个不在领头进程组（MCP 服务器），Claude 有 2 个 MCP 后代，OpenCode 的工作进程与 OpenClaw 的子进程各自成组；它们在组清空后 0.57–1.14 s 内都自己退出了，但进程组信号到不了它们（实测记录第 5.2、5.4、10.2 节）。
- **规则【建议】**：(1) 宽限 ≥1.5 s（实测最长 1124 ms），由同一配置解析器给出；(2) 关闭顺序：关 stdin → 等领头进程退出且进程组清空 → 按 pid 加启动时间核对此前采样到的离组后代（`process-group.ts:42` 的 `outsidersOf` 读法）→ 仍活着的再等最多 10 s 并记入证据 → 信号只作兜底；(3) 离组后代的处置沿用 ADR-030 补充条：只读、提示一次、不发信号；本宿主自己启动的 MCP 服务器在 10 s 后仍存活时要不要结束它们，留第 10 节 Q10。
- **证据**：`cleanup` 增加 `stage: "eof" | "sigterm" | "sigkill"`，`outside` 沿用；关闭用时进入 4.10 节指标。

### 4.12 每家一个稳定的私有 TMPDIR

- **现状【事实】**：每个回合的绑定都新建一个临时根作 TMPDIR（`binding-factory.ts:151`、`:157`），关闭时删除（`:306`）。
- 【实测】OpenCode、dsh、OpenClaw 每次启动都往 TMPDIR 重写编译缓存或解出原生库（Node 编译缓存 1.4 MB，Bun 的 `.dylib` 约 13 MiB，OpenClaw 约 11 MB）；持久 TMPDIR 让 initialize 从 OpenCode 约 590 → 160 ms、dsh 约 960 → 580 ms、OpenClaw 约 1250 → 1100 ms，OpenClaw 的关闭也从约 350 ms 降到 22–88 ms（实测记录第 6 节；只测了 initialize，不是生产启动）。
- **规则【建议，待拍板 D7】**：Hub 为每个宿主类给一个稳定、私有（0700）、按类独立的 TMPDIR：`os.tmpdir()/harnesshub-hosts-<uid>/<classKey>/`，与数据根互不包含（ADR-055 D5 把附件物化目录也放在 `os.tmpdir()` 下）；安装指纹变化（升级）时清空；Hub 启动时删除 7 天未用的目录；单个目录超过 256 MiB 时在该类没有活宿主时清空。
- **代价与隔离**：同类的两个对话共用一个 TMPDIR——同一 Harness、同一安装、同一工作区的宿主本来就共享用户配置与状态目录，TMPDIR 里多出来的是编译缓存与原生库，不是会话内容；但 Codex 会留空的 `.tmp*` 目录，MCP 服务器也可能写临时文件，所以 TMPDIR 仍按类（含工作区）隔离、不跨工作区共享，并且不进任何快照与导出。清理要有所有者：目录由宿主池拥有，删除只在该类没有活宿主时进行，删除失败只记诊断。

## 5. 宿主类型与七家逐家的归类表（按实测）

2026-11-03 的实测（[实测记录](../../../spikes/native-hosts/README.md)第 5、6、10 节，`results.json`）用正式的 application 与 binding factory、官网安装策略、生产的启动命令、环境与会话参数，每家 3 次只初始化、3 次会话，不调用模型，配置守护前后无变化；RSS 是整个进程树之和（不是 PSS），Claude 与 Codex 的数字取决于本机用户自己配置的 MCP 服务器与插件。版本只作证据（ADR-053）：Claude Code 2.1.316 + claude-agent-acp 0.99.1、Codex 0.166.0、OpenCode 2.2.5、dsh 0.2.1-rc.5、Hermes 0.22.5、OpenClaw 2026.10.9；Pi 在官网策略下没有控制入口，未测。

归类不再按“协议允许什么”，而按三个实测维度：一个进程能否带多个会话（`sessions`）；一个会话常驻占多少内存（`sessionMemory`）；进程内关会话能否收回资源（`sessionRelease`）。

| 类 | 判据 | 本机对应 | 策略 |
|---|---|---|---|
| 原生服务型 | 会话在用户自己的网关里，Hub 的进程只是查看器或桥，内存不随会话增长 | Hermes、OpenClaw | 一个连接带多个会话（≤8），保活 10–15 分钟；网关从不由 Hub 启停 |
| 便宜的多会话型 | 进程内多会话、每会话 ≤10 MiB，但进程冷启动 1–2 秒 | OpenCode、dsh | 一个进程带多个会话（≤8），保活 10–15 分钟；重建会话便宜，重开进程贵 |
| 重的多会话型、会话可收回 | 每个会话自带一套子进程（CLI 与 MCP），但 `session/close` 真正释放 | Claude Code | 适配器常驻（没有会话后 2 分钟关），会话按需建、空闲 10 分钟 `session/close` 收回，同时活着的会话 ≤3 |
| 重的、进程内收不回 | 每个线程自带一套 MCP，进程内关线程不释放，只有退出进程才释放 | Codex | 每个对话一个进程，不做多会话；冷启动约 0.1 秒，所以空闲 5 分钟就关；全局 ≤3 个进程 |
| 单会话型 | 一进程一活会话（文档） | Pi（待测） | 每对话一个进程，空闲 5 分钟 |

| Harness（入口） | 多会话【实测】 | 启动→initialize · 首个会话 · 同进程第二个会话（中位，ms）【实测】 | RSS：initialize / 1 会话 / 2 会话（MiB）【实测】 | 切回会话 1 · 进程内关会话【实测】 | 关闭（stdin EOF 后进程组清空）【实测】 | 新鲜度与风险 | 仍待验证 |
|---|---|---|---|---|---|---|---|
| Claude Code（claude-agent-acp） | 是：两会话共存，cwd 各自生效（各会话只宣告自己工作区的标记命令） | 124（只起适配器）· 297（冷 1378）· 289 | 129 / 1464 / 2386；每会话一组 `claude.exe`（约 310 MiB）+ `npm`×3 + `chrome-devtools-mcp` + `node`×3，17 个进程中 2 个不在领头进程组 | load 14 ms、resume 1 ms（活会话）· `session/close` 真正释放（2414 → 1074 MiB） | 无会话 22 ms；有会话 766–811 ms；1–2 个离组 `node` 约 0.57 s 后自行退出 | `idleActivity: background_possible`（后台 Bash）；`foreignTurns: detectable_by_listing`（未发提示时 `session/list` 为 0 行、没有转录；有转录后按 mtime）；Remote Control 不发（ADR-053 裁决 6） | 发过提示的会话在进程重启后的 load/resume 用时；回合期间的 RSS |
| Codex（`codex app-server --listen stdio://`） | 是：两线程共存，`thread/start`、`thread/read` 报告的 cwd 即所请求 | 26 · 74（一次 3791）· 13 | 98 / 1000 / 1838；每线程一组 MCP（`node_repl`×2、`SkyComputerUseClient`、`chrome-devtools-mcp`、`npm`×2、`node`×3），19 个进程中 18 个不在进程组；空闲后 1890 | `thread/resume` 对没发过提示的线程失败（-32600 no rollout found，rollout 文件已在）· `thread/unsubscribe` 不释放 MCP（1893） | 304–1124 ms（中位 833）；1–4 个离组 `node` 0.57–1.14 s 后自行退出 | `launchBound: [collaboration_mode]`（`codex.ts:190`）；`idleActivity: background_possible`；`foreignTurns: detectable_by_listing`（`thread/turns/list`）；每线程独占 MCP、进程内收不回 → 每对话一个进程 | 发过提示的线程的 `thread/resume`（需要一次模型调用）；回合期间的 RSS |
| OpenCode 2（`opencode acp`） | 是：标记命令各自只在自己的会话；`session/list {cwd}` 各列一行、cwd 相符 | 644（两次 1.9–2.0 s）· 1057 · 76 | 332 / 545 / 796；一个自成进程组的工作进程 | load 4 ms、resume 1 ms（活会话）· close 成功 3 ms，内存不变 | 22–23 ms；无残留 | `foreignTurns: detectable_by_listing`；`-s` 对未知 ID 会新建会话（ADR-039 表）；持久 TMPDIR 把 initialize 从约 590 降到约 160 ms | 进程重启后对发过提示的会话 resume 的用时 |
| DeepSeek Harness（`dsh --profile acp`） | 是：按 cwd 存会话（`~/.dsh/sessions/--<cwd>--/<id>`，会话 2 在 ws-b 的目录下） | 967 · 297 · 18 | 255 / 260 / 260；无子进程；空闲后自行回收到 216 | 不声明 load；活会话的 resume 被拒（-32602 already active，直接按 ID 用）· close 成功，内存不变 | 20–44 ms；无残留 | `foreignTurns` 未核实 → 先按 `undetectable`；headless 只读终端环境或 `.env` 的密钥（ADR-053）；持久 TMPDIR 把 initialize 从约 960 降到约 580 ms | 进程重启后的 resume；外来回合检测 |
| Hermes Agent（`hermes acp` 查看器 → 用户网关） | 是：两会话共存；cwd 是否生效无法从元数据核实（`session/list` 0 行，回执不含 cwd） | 553 · 1241（299–1384）· 147 | 169 / 190 / 200（网关 334 → 338 另计）；无子进程 | load 195 ms、resume 155 ms（对未发提示的会话也可用）· 不声明 close | 110–173 ms；网关 pid 与启动时间前后不变 | `execution: gateway`：查看器退出不是静止证据（INV-12）；`foreignTurns: detectable_on_open`（回放计数）；每次新建查看器前跑 ADR-051 预检（六次都判 A） | cwd 是否生效；网关其他客户端写同一会话的检测 |
| OpenClaw（`openclaw acp` 桥 → 用户 Gateway） | 是：两会话共存；cwd 无法核实（OpenClaw 在它自己的代理工作区执行工具） | 1259 · 748（其中 `agents.list` 590–659 + `session/new` 48–166）· 364 | 449 / 451 / 454（网关 857 → 894 另计）；一个自成进程组的 `openclaw` 子进程；空闲后自行回收到 384 | load、resume 都失败（-32603：未发提示的会话在网关里没有记录）· close 成功 1 ms，内存不变 | 349–391 ms（Node 退出时写编译缓存；持久 TMPDIR 下 22–88 ms）；网关 pid 不变 | `execution: gateway`；`foreignTurns: detectable_by_listing`（`chat.history`）；桥加 cwd 前缀（ADR-055 Q10）；不发提示的会话不落盘 | 发过提示的会话的 load/resume（需要一次模型调用）；cwd 是否生效 |
| WorkBuddy | 未接入（ADR-048 M4） | — | — | — | — | 接入时按声明，最保守值 | — |
| Pi（冻结，只作参考） | 未测：官网策略下没有控制入口（本机 npm 链接指向源码检出，ADR-044 不算官网安装） | — | — | 【文档】一进程一活会话，`new_session`、`switch_session` 换掉当前会话，cwd 属于进程；会话文件在第一条助手消息后才写 | — | `launchBound: [model, provider]` | 全部 |

表外说明：Cursor、Gemini 冻结（ADR-046），不归类。六家空闲 60 秒都不写工作区（只写各自的状态目录与 TMPDIR）；不发提示也会留下原生记录（Codex、dsh、Claude、OpenCode、Hermes；OpenClaw 不留），所以预热不能建会话（4.7 节）。

## 6. 与现有设计的关系

| 既有设计 | 保留 | 取代或扩展 |
|---|---|---|
| [ADR-030](../../decisions/0030-retained-native-processes.md) 保留原生进程 | 方案 C；按对话显式开启、默认关闭；固定宿主持有租约；30 分钟空闲、最多 4 个；10 种关闭原因与证据；进程组身份登记与接管；逃出进程组的后台任务枚举；界面开关 | “切换生效即关闭来源进程”改为转池或继续固定（4.6）；重启清理扩大到全部登记宿主（4.8）；迟到条件里的“空闲 = 没有回合也没有原生事件”与 4 小时硬上限本设计落实；“启动慢时提示可开启保持”保留，预热改为按类的宿主保活、不建会话（4.7）；`retained` 字段语义不变，另加登记表；补充条的离组后代核对扩到所有宿主关闭并先于信号（4.11） |
| [ADR-055](../../decisions/0055-relay-and-context-scheduling.md) 接力 | 送达水位、零注入、同步状态、suspect / pending 时不复用、D6、Q23 | 新鲜度表直接引用 relay 状态（4.4）；登记表为 Q23 提供“进程组已结束”的证据（4.8）；`HostCapabilities` 与 `RelayCapabilities` 并列，`execution` 同义；不改 v13 的表，登记表放 v14；记录树与 v13 按 Run 键的关系见第 7 节 |
| [ADR-033](../../decisions/0033-native-catalog-cache-and-readiness.md) 目录缓存、就绪、探测会话 | 目录缓存与指纹（同一指纹做分类键）；不在后台预热，并加强为不建会话式预热（实测证实不发提示也留原生记录）；探测会话记录 | 第二期列会话、读会话、读目录借用同类空闲宿主（只读、不取写租约）；“通常启动用时”拆成冷启动与重开两个分布 |
| [ADR-039](../../decisions/0039-continue-in-the-original-program.md) 在原程序中继续 | 续接命令照常给出 | 在原程序里继续过的会话判为不新鲜（`foreign_turns`），复用时重开回放并在界面说明 |
| [ADR-043](../../decisions/0043-upgrade-with-running-programs.md) 升级 | 升级前列出使用者；正在回复的对话阻止升级 | “关闭空闲进程”改为排空整类（4.9）；`programUsers` 改读宿主池 |
| [ADR-036](../../decisions/0036-approval-wait-budget.md) 并行与预算 | 4 个对话并行、同工作区 FIFO、等空位不计预算 | 宿主预算是另一份上限；“等空位”复用同一机制与界面 |
| [ADR-029](../../decisions/0029-continue-native-sessions.md)、[ADR-025](../../decisions/0025-conversation-branches.md) | 一个原生会话一个持有者；原生副本只在精确位置建立 | 分支不再关闭来源宿主；记录树长期取代历史复制（第 7 节） |
| [ADR-014](../../decisions/0014-conversation-failure-recovery.md)、INV-11、INV-12 | 未知不重跑；未确认停止前不让新执行者写同一工作区 | 登记表让“进程组已结束”的确认更常可得，恢复路径不变 |
| [ADR-028](../../decisions/0028-native-configuration-sync.md) | 回合后记录原生回报的配置 | 复用宿主时照常读绑定的 `observed`，不读宿主 |
| [ADR-044](../../decisions/0044-macos-official-channels.md)、[ADR-053](../../decisions/0053-latest-version-baseline.md) | 只面向 macOS；版本只作证据 | RSS 与进程组用 macOS 的 `ps`；`probed` 按最新正式版探针翻转 |
| [ADR-023](../../decisions/0023-attachment-input.md) 附件、ADR-055 D5 | 附件物化目录在 `os.tmpdir()` 下按会话建、随会话删除 | 宿主 TMPDIR 同样放在 `os.tmpdir()` 下、与数据根互不包含，但按类建、升级清空（4.12，D7） |
| [运行契约](../../contracts/lifecycle.md)、[适配接口](../../contracts/adapter-spi.md) | 清理链、崩溃恢复、Adapter 不写公共库 | “每个 Run 的资源在它结束时清理并留证”扩展为“每个租借在结束时归还并留证，宿主的关闭另有所有者与证据”；Adapter 增加 `HostCapabilities` 与多会话方法 |

## 7. 历史与会话存储的演进：记录树（长期规划）

只作长期规划；本节写清数据模型草案、迁移思路、与 v13 的关系和代价。不进入前两期。

**动机**：第 2 节 H1–H5。Pi 的做法（3.1）表明“分支、换模型、压缩、切换都是树上的记录”能让会话内容与执行者彻底分离。

**数据模型草案【建议】**：

```ts
/** 一条记录：对话事实的最小单元，只追加，带树形父指针。 */
export interface RecordEntry {
  readonly id: EntryId;                       // 品牌 ID
  readonly sessionId: SessionId;
  readonly parentId: EntryId | null;          // 根为 null；同一父可有多个子 = 分支
  readonly seq: number;                       // 追加顺序（全局单调），与现有事件 seq 对齐
  readonly kind: "user_input" | "assistant_reply" | "tool" | "plan" | "usage" | "notice" | "activity" | "attachment"
    | "command" | "switch" | "model_change" | "compaction_marker" | "branch_summary" | "relay_packet" | "label" | "import_marker";
  readonly runId: RunId | null;               // 属于哪个 Run（命令、切换、标签没有）
  readonly executedOn: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number } | null;
  readonly payload: ContentRef | InlinePayload;   // 大体量进内容存储，小体量内联
}
/** 对话的当前位置与投影。 */
export interface SessionTreeHead { readonly sessionId: SessionId; readonly leafId: EntryId | null; readonly projectionVersion: number }
```

- 快照（`SessionSnapshot`）变成**投影**：由从叶子到根的路径确定性地算出“当前可见的消息列表”“当前选择”“各绑定的位置”，可缓存、可重建（INV-22 的精神）；事件表继续是追加日志。
- **分支** = 把叶子移到更早的记录（同对话内），或新对话只记 `parentSessionId + parentEntryId`（不再复制 `origin.history`）；**接续本机会话** = 一条 `import_marker` 记录指向原生会话与读到的条数，引用历史作为只读子树或内容存储里的一份快照；**切换** = 一条 `switch` 记录（执行者变了，内容不变）；**压缩** = `compaction_marker`（原生压缩的证据与游标）；**接力** = `relay_packet` 记录引用 v13 的 `relay_packets` 行。
- 原生绑定的位置从 `throughRunId` 变成 `throughEntryId`（送达水位同理记 entry seq）；分支的“精确位置”判定变成“原生会话的最后一条 Hub 记录等于分支点”。

**迁移思路**：现有线性会话 → 每个 Run 展开为一串记录（user_input → tool… → assistant_reply），`switches` 插成 `switch` 记录，`origin.history` 变成 `import_marker` 或 `parentSessionId` 指针（源对话仍存在时指过去，不存在时保留复制件作只读子树）；`messages` 表由投影生成；`assertSessionTransition` 的“只追加、不可重排”改写为“记录只追加、叶子只能移到已存在的记录、投影由记录决定”。

**与 v13 的关系**：v13 的 `relay_digests`、`relay_deliveries` 以 `(session_id, run_id)` 为键，`run.ended` 的 seq 作事实 seq；记录树里 Run 仍存在（一条输入到结算），所以这些表不用改键，只需在 `RunDigestIndex` 加 `entryId` 范围；`nativeEpoch`、`epochFloor` 不变。若记录树与 v13 同时实施，可以共用一次迁移与备份；若 v13 先行，记录树是 v15（v14 是宿主登记表）。

**代价（写清）**：改写快照解析、`assertSessionTransition` 的大半规则、SSE 投影与前端 Turn 列表、导出、分支与接续的两条实现、ADR-055 的部分契约文本；全部 Session 层测试要重写；两次相邻的存储大改（v13、树）会让迁移与备份时间翻倍，用户数据根要停服两次。推荐在 G066–G074 稳定后再启动，并先用 1 GiB 合成库测迁移时长（ADR-055 的做法）。

## 8. 分期实施

### 第一期（短期）：按会话复用的进程池，切换后保留来源宿主，关闭链与 TMPDIR

- **范围**：`HostCapabilities` 声明（七家按第 5 节实测填 `sessions`、`sessionMemory`、`sessionRelease`，`probed` 先为 false）；宿主池与租借接口；分类键（含工作区）；以内存为主、按类封顶的预算（4.3）；新鲜度判定表（4.4）；A→B→A 来源宿主转空闲而非关闭；每个对话一个进程的类（Codex、单会话型）按类时限早关；登记表 `native_hosts`（v14）与接管（4.8）；关闭宽限 ≥1.5 s 与“先 EOF、再核对离组后代、信号兜底”的关闭链（4.11）；每类一个稳定私有 TMPDIR（4.12，D7）；预热不建会话（4.7，INV-42）；事件、API、界面指标；ADR-030 的两档时限与硬上限落实。Driver 只增加声明，不改一连接一会话的限制。
- **验收**：集成测试（真实 `SqliteSessionStore`、真实子进程 `tests/fixtures/control-peer.mjs`、真实工作区租约）：连续发消息第 2 回合起复用率 100%（同选择、无不新鲜条件）；A→B→A 不重启 A；两个对话同工作区同类串行共用一个空闲宿主且租约随写走；类上限与内存预算满时只收回空闲未固定者；新鲜度表每条各一个无效样例；接管测试；升级排空；关闭链用真实进程验证宽限与离组后代核对；TMPDIR 隔离与清理；保活不建会话。真实验收（最新正式版，经 4317 正式入口）：Claude、Codex 各一次“连续三回合”与一次 A→B→A，记录冷启动、复用、重开用时与回合期间的 RSS，与 2026-11-03 的实测对照。
- **风险**：`idleActivity: background_possible` 的 Driver（Claude、Codex）结算后若仍有后台活动，宿主不能空闲入池只能关闭，收益依赖 `unattributedUpdates` 为 0 的判定是否可靠（H6 未测）；v14 与 v13 的先后（D2）；按类预算的初始值来自一台 64 GiB 的机器，要按目标机器调整。

### 第二期（中期）：宿主多会话，按收益排序

- **顺序（D5）**：先 OpenCode、dsh、Hermes——会话几乎不占内存而冷启动 1–2 秒，一个进程带多个会话收益最大；再 Claude——适配器常驻、会话按需 `session/close` 收回（同时活着 ≤3），把每回合的适配器启动与 CLI 启动都省掉；Codex 不做多会话（每线程独占 MCP、进程内收不回，每对话一个进程已是最优）。
- **范围**：Driver 多会话方法（`openSession`、`closeSession`、`switchSession`）与活会话表；ACP 代理按探针 H2–H4 逐家翻 `probed`；列会话、读会话、读目录借用同类空闲宿主（只读、不取写租约）。
- **验收**：协议测试（固定对端）：同连接两个会话的 open / prompt / close；真机探针写进 `docs/verification/native-hosts-conformance-<日期>.md`；每家 `probed` 只在探针通过后翻转（ADR-053）。
- **风险**：并发回合在同一进程里可能共享速率限制与审批队列；活会话与恢复的区分（dsh 拒绝对活会话 resume，Codex、OpenClaw 对没有回合的会话拒绝 load/resume）要在 Driver 里按实测处理；OpenCode、dsh 的 `session/close` 不释放内存，上限按进程算。

### 第三期（长期）：记录树

- **范围与代价**：第 7 节。
- **验收**：500 个随机会话“增量投影 = 重建”属性测试；迁移 1 GiB 合成库的时长；分支与接续不再复制历史；接力的 v13 表键不变。
- **风险**：两次存储大改；前端与导出全部重写。

## 9. 场景走查

每个场景写：现状、目标架构下发生什么、各层状态、进程处理、证据。

**S1 连续发消息（同一对话、同一选择）**

- 现状：每回合启动、握手、resume、关闭；Hermes 还要回放全文。
- 目标：第一回合新建宿主并登记；结算后宿主 idle（不持租约，`idleActivity` 允许时）；第二回合租借同类空闲宿主，会话新鲜（`same_owner_no_foreign`），直接 `startText`。Run 记 `reused: true`，事件 `native.session_reused`。
- 层：对话 open；绑定 ready；Run 正常；租约按回合取得与释放；宿主 idle → leased → idle。
- 进程：一个；按类的空闲时限关闭（Codex 5 分钟；OpenCode、dsh、Hermes、OpenClaw 10–15 分钟；Claude 会话 10 分钟收回、适配器再 2 分钟）。
- 证据：复用率、冷启动一次、重开零次。

**S2 A→B→A**

- 现状：A→B 时 A 的保持进程关闭；回到 A 再启动，并补发欠交。
- 目标：A→B 切换生效时 A 宿主转 idle（或 A 开了保持且有后台活动则继续 pinned）；B 新建宿主（另一类）；回到 A 时租借 A 宿主，新鲜度：A 的绑定 `relay.sync` 若为 synced 且无其他不新鲜条件 → 续用并由 ADR-055 补发 B 期间的增量；若 pending / suspect → 重开回放核对后补发。
- 层：切换 effective 两次（`epoch+2`）；A、B 绑定都 ready；租约在每个回合各自取得。
- 进程：两个宿主并存（计入预算 8）；B 空闲到时限关闭。
- 证据：A 的冷启动一次而非两次；接力的送达结论不变。

**S3 两个对话同一工作区都用 Claude**

- 现状：对话 1 的保持进程持有租约，对话 2 得到 `WORKSPACE_KEPT`；不开保持时各自每回合启动。
- 目标：两对话同类；对话 1 回合结束后宿主 idle（不持租约）；对话 2 的回合取得租约后租借同一宿主，为自己的会话 `session/load` 或 `session/new`（Claude 适配器内再起一个 CLI 子进程）；对话 1 下一回合再切回自己的会话。若对话 1 开了保持且有后台活动，宿主 pinned 持租约，对话 2 仍得到 `WORKSPACE_KEPT`（ADR-030 不变）。
- 层：两个对话各自 open、绑定 ready；租约串行。
- 进程：一个适配器宿主，其内两个 CLI 子进程各约 1.3 GB【实测】；同时活着的会话 ≤3，空闲 10 分钟的会话 `session/close` 收回（第二期的适配器常驻）；第一期每回合仍各起各的。
- 证据：`maxIdlePerClass = 1` 生效；租约随写走的集成测试。

**S4 两个工作区都用 Codex**

- 现状：两个进程，各自每回合启动。
- 目标：两个 app-server 宿主，各自复用，空闲 5 分钟关闭；不做多会话——【实测】一个 app-server 虽能带两个 cwd 的线程，但每线程独占一套 MCP（约 0.9 GB）且 `thread/unsubscribe` 不释放，合在一个进程里只会让内存更难收回；进程起 26 ms、线程 74 ms，每对话一个进程已是最优。
- 层：两个对话、两个绑定、两个租约（不同工作区）。
- 进程：两个；全局 ≤3 个 Codex 进程，超出时最久未用的空闲者先关。
- 证据：实测第 5 节；集成测试“同 Harness 不同工作区各一个宿主”。

**S5 开着后台任务切换**

- 现状：切换生效即关闭保持的进程，后台任务被结束（ADR-030 的 `selection_changed`）。
- 目标：A 对话开了保持、A 宿主 pinned 且有后台活动；切到 B：A 宿主继续 pinned（持租约）；B 回合要同工作区的租约 → `WORKSPACE_KEPT`，界面提示“结束 A 的后台进程并继续”或“稍后再试”——与 ADR-030 方案 C 一致，只是现在是同一对话内的两个 Harness。用户选结束 → A 宿主关闭（`ended_by_user`）→ B 回合继续。
- 层：切换 effective；A 绑定 ready；B 回合先 failed{WORKSPACE_KEPT} 或等待用户选择。
- 进程：A 宿主存活到用户决定或 30 分钟空闲（“没有回合也没有原生事件”）。
- 证据：集成测试“同对话切换时固定宿主不被关闭”。

**S6 用户在原程序里继续之后回到 Hub**

- 现状：下一回合 resume 时回放带上原程序里的回合（Hub 不知道），保持中的进程视图过期。
- 目标：租借前新鲜度判定：`foreignTurns: detectable_by_listing` 的 Driver 比较原生列表的 `updatedAt`/回合数与上次结算记录，不同 → `foreign_turns` → 重开回放（v13 同时做送达核对，外来回合只计数 `foreignAfterLast`）；`undetectable` 的 Driver 一律重开。界面说明“检测到原程序里的新回合，已重新读取”。
- 层：绑定 ready（内容已变）；Run 正常。
- 进程：宿主复用，会话重开。
- 证据：集成测试用对端夹具伪造外部回合；真机探针 H4。

**S7 结果未知之后**

- 现状：Run unknown、对话 blocked、绑定 unconfirmed、租约隔离；恢复须显式确认。
- 目标：持有租借的宿主转 dead 进入清理链；清理确认 → 租约释放但对话仍 blocked（INV-11）；未确认 → 租约隔离。该绑定判 `unknown_outcome`，任何宿主都不复用它；恢复切换后，process 型按 ADR-055 D6 在 Hub 确认进程组已结束后只读 resume（登记表给出证据）。
- 进程：dead 宿主不进池。证据：杀进程组的故障注入集成测试。

**S8 Hub 崩溃**

- 现状：`recoverSession` 记未知；`reapKept` 只处理保持中的进程；回合中的进程无记录，租约隔离待人工核实。
- 目标：接管读登记表：`idle` 行 → 结束进程组（不持租约）；`pinned` 行 → ADR-030 的处理；`leased` 行 → 结束进程组并记 `native.host_lost{outcome}`，Run 仍 unknown、租约仍按 INV-12 处理，但“进程组已结束”的证据可供 D6 使用；`unconfirmed` 的行保留并报告。
- 证据：`tests/fixtures/kept-owner.mjs` 的做法推广到登记表。

**S9 升级**

- 现状：关闭空闲保持进程；正在回复的阻止升级。
- 目标：`drainClass` 该安装全部类：空闲立即关闭（`harness_upgrade`），固定者关闭并提示，`leased` 阻止升级（确认框列出）；升级后安装指纹变化，新回合新建。
- 证据：升级集成测试检查登记表里该安装的行全部关闭。

**S10 内存紧张**

- 现状：没有按内存的上限；最坏 8 个进程。
- 目标：以内存为主、按类封顶的预算（4.3）：整个进程树的 RSS 之和超过 `hostMemoryBudget` 即按淘汰顺序收回——先关最久未用的空闲 Claude 会话（每个约 1.3 GB，`session/close` 真正释放）、再关最久未用的空闲 Codex 进程（每个约 0.9 GB），轻的类最后；类上限（Claude 活会话 ≤3、Codex 进程 ≤3）在内存预算之外独立生效；仍不能则等空位（可见）。不读系统内存压力信号（第一期不做，Q7）。
- 证据：性能测试用假宿主报告 RSS；真实数字见第 5 节（64 GiB 机器）。

**S11 Hermes / OpenClaw 网关**

- 现状：每回合启动查看器或桥；Hermes 每次回放全文；查看器退出不是静止证据。
- 目标：查看器/桥作为服务型宿主的连接，空闲入池（工作在网关里，查看器本身 `idleActivity: none`；网关的后台工作 Hub 本来就不控制）；复用省掉启动与回放；网关侧的外来回合按 `detectable_on_open`（Hermes）/`detectable_by_listing`（OpenClaw）判新鲜度；结果未知时查看器关闭不算静止，绑定 unconfirmed 直到网关侧确认（ADR-055）。ADR-051 的预检在每次新建查看器宿主前照做。
- 证据：实测第 5 节（Hermes 查看器 190 MiB、启动到首个会话 1.8 s、活会话 load 195 ms；OpenClaw 桥 450 MiB、2.0 s；两家空闲不写工作区）；查看器被网关断开时按 `exited` 处理；网关侧对发过提示会话的 load/resume 仍待模型调用验证。

**S12 关闭对话**

- 现状：取消排队、停止活动回合、关闭保持进程、记 closed。
- 目标：固定宿主 `unpin` 并关闭（`conversation_closed`）；该对话在池内宿主上打开的会话 `closeSession`（宿主本身若还被别的对话用着则不关）；closed 不可重开、没有删除（现状）。内容存储按引用回收不变。
- 证据：集成测试“关闭对话不关闭他人正在用的宿主”。

## 10. 未决问题与需要实测的点

**已拍板**（2026-11-03 按推荐项接受，推荐见 ADR-056）：D1 是否采纳“空闲宿主不持租约”；D2 登记表放 v14 还是并入 v13；D3 空闲时长按类设置（4.3 节的初始值）还是一刀切；D4 不提供建会话式预热、只做宿主层保活；D5 第二期先做 OpenCode、dsh、Hermes，Claude 用“适配器常驻加会话收回”，Codex 不做多会话；D6 记录树的时机；D7 每类一个稳定私有 TMPDIR 是否采用（隔离与清理的代价见 4.12）。

**实测状态**（[实测记录](../../../spikes/native-hosts/README.md)，2026-11-03，六家；Pi 未测）：

| 编号 | 问题 | 状态 | 结果与剩余 |
|---|---|---|---|
| H1 | 空闲宿主的 RSS 与空闲行为 | 已测 | 第 5 节表；空闲 60 秒六家都不写工作区、几乎不发通知；dsh、OpenClaw 空闲后自行回收部分内存。未测：回合期间的 RSS 与 CPU |
| H2 | 同一连接第二个会话 | 已测 | 六家都接受，用时 13–364 ms；Claude 再起一个 CLI 子进程与一套 MCP（约 0.9–1.3 GB），Codex 再起一套 MCP（约 0.85–0.9 GB），其余 ≤10 MiB |
| H3 | 同宿主并发回合 | 未测 | 没有发提示；留给第二期探针 |
| H4 | 外来回合能否检测 | 部分 | cwd 生效：Claude、Codex、OpenCode、dsh 已证实，Hermes、OpenClaw 无法从元数据核实；未发提示时 Claude、OpenCode、Hermes、OpenClaw 的 `session/list` 都是 0 行，检测方法要在发过提示的会话上再测 |
| H5 | Codex 跨工作区线程 | 部分 | 同一 app-server 可带两个 cwd 的线程且 cwd 生效；但每线程独占 MCP、进程内收不回，所以不采用多会话，“环境值是否按工作区变化”不再需要测 |
| H6 | 结算后后台活动的判定 | 未测 | 没有发提示；留给第二期探针 |
| H7 | 冷启动、续用、重开用时 | 部分 | 冷启动与第二个会话已测（第 5 节）；活会话的 load/resume：Claude 14 / 1 ms、OpenCode 4 / 1 ms、Hermes 195 / 155 ms，dsh 拒绝（already active）；进程重启后对发过提示的会话 resume 未测 |
| H8 | 排空与关闭代价 | 已测 | 六家都在 stdin EOF 后自行退出（22–1124 ms），没用到信号；离组后代 0.57–1.14 s 内自行退出；生产 500 ms 宽限下的 SIGTERM 路径未测 |

**仍需模型调用才能验证**（没有发过提示的会话在这些家里没有可恢复的记录）：Codex 的 `thread/resume`（未发提示的线程报 no rollout found）；OpenClaw 的 `session/load` 与 `session/resume`（网关里没有记录）；Pi 的 `switch_session`（会话文件在第一条助手消息后才写，且本机 Pi 在官网策略下起不来）；Hermes 与 OpenClaw 的 cwd 是否生效；dsh 进程重启后的 resume；Claude 发过提示后的 `session/list` 与转录 mtime 作外来回合检测；回合期间的 RSS。它们都排进 G083 的探针，用最便宜的模型、每家 ≤2 回合。

**设计内部未决**（不阻塞第一期）：Q1 同类“每进程 ≤8 个会话”对“同工作区两个对话轮流发消息”是否足够（轻多会话型在同一宿主上切会话只要 13–147 ms，问题只剩 Claude 的两个会话各 1.3 GB）；Q4 `foreignTurns: undetectable` 的 Driver 一律重开会抵消复用收益，是否允许用户按对话声明“我不会在原程序里继续”（倾向不提供：静默假设违反像原生）；Q5 RSS 采样频率（实测用 5 s 静置后一次、空闲每 15 s 一次）；Q7 是否响应系统内存压力信号（第一期不做）；Q8 记录树与 v13 的先后（第 7 节）；Q9 TMPDIR 的大小上限与清理时机（4.12 的 256 MiB、7 天是起点）；Q10 本宿主自己启动的 MCP 服务器在关闭 10 s 后仍存活时是否结束它们（ADR-030 补充条现在一律不发信号）。已由实测关闭：Q2（Codex 不做多会话、每对话一个进程）、Q3（不提供建会话式预热）、Q6（Claude 用适配器常驻加会话收回）。

