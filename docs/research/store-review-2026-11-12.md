# ADR-057 / step2-plan 独立审查

审查对象：`docs/decisions/0057-ordered-turn-items.md`（proposed）、`docs/proposals/protocol/step2-plan.md`
仓库：`~/Desktop/project/HarnessHub/.claude/worktrees/relay-stage2-7cb3e9`，分支 `claude/relay-stage2-7cb3e9`，提交 f3ff0d3。只读，没有启动服务或 Harness，没有跑测试。
做法：先读代码（清单见第三节），再读设计，再回头逐条核对出处。行号都是这个提交上的。

## 结论一览

| 问题 | 结论 |
|---|---|
| 1 会不会丢内容 | **会，按现在的写法。** 迁移依赖的读侧投影是显示投影，截断、去重、丢弃都有（M1）；内容回收在迁移后会删掉没登记的引用，备份救不回（M2）；现有分支的引用历史没有去处（M3）。文字分块只追加本身没问题。 |
| 2 会不会谎报 | 收场表与代码一致，没问题。`phase` 的推断规则会把被打断的半句话标成 `final`（I4）。`legacy_order` 只在行上，协议类型里没有字段带出去（I5）。水位语义在事件变轻后仍成立，但 `ended_seq` 的三级回落与“是命令但效果未知”两处迁移规则没写，写错就是漏发或多发（I1）。 |
| 3 过渡层 | **计划里没想清楚。** 线 A 写的过渡层要“从表装出现在的对话”，这要求条目能无损还原成旧字段，而显示投影做不到；A 与 B 之间没有一个能跑的中间态。建议的落地顺序见 M4。 |
| 4 并发、事务、所有权 | 头行 `version` 比较并交换、提交后发布、`owner_generation` 都仍然成立。**跨行不变量有十来条没有着落**，其中“开着的对话里没有未认领的 unknown 回合”是底线（M6）。 |
| 5 不设上限的后果 | 第一段“常量都去掉、内存仍是整个对话”是一个悬崖：没有拒绝，只有变慢、OOM 和流断开（M5）。ADR 3.7 ③ 里说“不是我们设的”那几项，全部是我们设的（M8）。 |
| 6 搜索 | trigram 对两个汉字不命中是事实；回退扫描按块扫会漏掉跨块的词，且随总文字量线性变慢。有更合适的做法（I8）。 |
| 7 规模与顺序 | 分段大体合理，但有几处把“改已落盘的东西”排在了“格式定稿”之后（M7），线 B 的“不碰”清单做不到（M4）。最容易出问题的三处见第四节。 |

---

## 一、必须先改设计的

### M1 第 1 步的读侧投影不能当迁移的转换；它不满足 ADR 3.6 列的八条要求

**是什么。** ADR 3.6 让迁移“读旧快照 → 读侧投影转成条目”，之后旧字段不再存在。但已合并的投影（`src/contexts/session/domain/protocol/`）是给界面画图用的显示投影，它成立的前提恰恰是“全文还留在旧字段和内容库里”——代码自己这么写：`protocol.ts:46`（“the whole stays in the Run's own `thinking`”）、`project.ts:40`、`tools.ts:107`（“the whole stays in the stored detail”）、`protocol-view.ts:79-83`（“every view makes them all again: there is no copy of a Turn to go stale”）。ADR 第七节承认写的时候投影还没提交。

**证据（逐条对 3.6 的要求）。**

| 丢什么 / 违反哪条 | 出处 | 3.6 的校验能否发现 |
|---|---|---|
| ③ 思考超过 64 Ki（UTF-16 单位）的部分被切掉，只留 `truncated:true` | `project.ts:41,121` | 能 → 该对话被判“无法转换” |
| ③④ 任务清单调用（`todo_write`、`update_plan`、`update_todos`、`todo`）不成行：有 `run.plan` 时全部丢弃；没有时只留最后一个可解析的当 plan。连同它们的 `detail` 引用 | `project.ts:128-135`，`tools.ts:59,284` | 有 detail 的能（引用集合不等）→ OpenCode、dsh 的对话大面积“无法转换”；没 detail 的不能 |
| ③ 工具 `title` 原文：命令被 `unwrapShell` 改写并截到 1000 字符；多文件修改的标题整个不要（`changes: []`）；MCP 调用只留 server 与 tool；有 `name` 的通用工具不留 title | `tools.ts:122,177,196-199,274-277,298,316` | 不能 |
| ③ 工具的 `kind` 与原始 `status` 词，换成推出来的类型与八态；认不出的词记 `unknown`，原词没了 | `tools.ts:266-272`，`status.ts:21-23` | 不能 |
| ③ 活动的 `detail`（subagent、task、compaction 都不带）；与工具同 id 的 subagent/task 活动整条去重 | `project.ts:137-141,174-178` | 不能 |
| ③ `severity:"error"` 的通知在 `run.error` 非空时整条丢弃 | `project.ts:146-151` | 不能 |
| ③ plan 条目的 `priority`；链接产物有 `title` 时的 `name`，以及 `mediaType` | `project.ts:103,171` | 不能 |
| ② 结果不只由输入决定：取决于那一刻内容库读不读得到详情（每个视图最多读 400 个，读不到就是空命令、空路径），以及目录里当前的显示名 | `protocol-view.ts:26,41-58`，`tools.ts:168-179`，`project.ts:57-60` | 不能 |
| ⑤ 顺序与 ADR 写的不一样（代码：…通知、retry/review、**回复、错误、产物、压缩**；ADR：…活动、产物、助手文字）；条目 id 是 `hh:user`、`hh:reasoning`、`hh:reply`、裸的原生工具 id，与 ADR 3.2 的 `text:<n>`、`think:<n>`、`tool:<id>` 不是一套 | `project.ts:116-179`，`tools.ts:276,286` | — |
| ⑧ 不能逐回合产出：要整个 `runs` 数组 | `project.ts:44-48,108-116` | — |
| 用量：`turnUsage` 换算后对 dsh、Hermes 直接没有数字，`cacheWrite`、`reasoning`、`total` 不保留 | `usage.ts:44-54` | 不能（若 `run_json` 存的是换算后的） |

**具体会出什么事。** 要么大量对话校验不过、被判“无法转换”（见 M9）；要么校验过了但标题、活动详情、通知、原始状态词永久丢失。计划线 D 的完成标准“交接单迁移前后逐字相同”也达不到：叙述器直接读 `tool.title`、`tool.kind`、`exitCode` 和原始状态（`narration.ts:242,261,405-406,420-421`）。

同一个问题对**新回合**也成立：条目“就是事实本身”，类型、命令、路径在写入时由归一规则推出并定死；规则是刚合并的，推错了以后无从重算，因为原始的 title、kind、status 词没存（`ItemBase` 只有 `nativeName`，`protocol.ts:29-41`）。

**建议。**
1. `item_json` 对所有条目（新旧一样）保留原生事实：`native{title, kind, name, status}`，活动与通知的全字段，plan 的全字段；任务清单调用照样成行（界面可以不画，但行在）；思考不截。归一出来的字段是可重算的派生值。
2. 为旧回合写一个**存储转换**（不是显示投影）`toItems(oldRun)`，再写它的逆 `fromItems(items) → 旧形状的 Run`。迁移的保真校验就是一条性质：对每个回合，`fromItems(从表读回的条目)` 深相等于旧 Run。这比“比三种文字加引用集合”强得多，也顺带给了 M4 需要的适配器。
3. 如果不想扩 `item_json`：旧回合在 `runs` 行留一列只读的 `legacy_json`（旧 Run 去掉已搬进 `item_text` 的文字）。只有迁移写它，新代码不写，所以不是双写。
4. `run_json` 里的 `usage` 存 `NativeUsage` 原值。顺序与 id 方案在 ADR 里定一套，代码照它改。

### M2 内容回收：迁移后第一次启动就可能不可逆地删内容，备份救不回来

**是什么 / 证据。**
- 回收器每次启动都跑（`session-application.ts:140`），删掉“不在引用集合里、且已丢弃或超过 7 天”的记录与 blob（`content-store.ts:14,228-244`）。
- 引用集合现在有四个来源（`sqlite-store.ts:376-392`）：`tools[].detail`、`outputs[].content`、`run.attachments`、`origin.history[].attachments`。
- ADR-049 的备份只是 `gateway.sqlite` 的 `VACUUM INTO`（`sqlite-store.ts:505-550`）。内容库是另一个库加 `blobs/` 目录，不在备份里。
- 备份只留两份，再有两次带版本号的升级，v13 的那份就被轮换掉（`sqlite-store.ts:129,521-523`）。

**漏口。** (a) 转换失败、留着旧快照的对话，引用不在 `content_refs`；(b) 显示投影丢掉的任务清单调用的 `detail`（M1）；(c) `origin.history` 的附件——`content_refs` 以 `(run_id, item_seq)` 为键，没地方挂，3.6 的校验清单也没提；(d) 迁移中途被杀、部分对话还是 `format=13` 时启动的回收。

**具体会出什么事。** 这些对话的工具输出、diff、附件、产物在下一次启动被删；“回退 = 恢复备份”恢复出来的是悬空引用。这是整个设计里唯一一条备份兜不住的丢内容路径。

**建议。** 回收器的引用集合 = `content_refs` ∪ 所有 `format<14` 行按冻结的旧解析取出的引用（或更简单：库里只要还有 `format<14` 的行就不回收）；`content_refs` 允许会话级引用（`run_id` 可空加 `session_id`）；迁移结束做一次**全库**比对：迁移前用旧代码算好的 `contentReferences()` 等于迁移后回收器将用的集合，不等就不启用回收；升级后头一次启动只报告将回收什么、不删。v13 的那份备份改成不参与轮换，由所有者自己删。

### M3 现有分支对话的引用历史没有去处

**证据。** v13 的分支把源对话的文字**复制**进 `origin.history`（`runtime.ts:554-558,568`），源对话之后可以被硬删（`sqlite-store.ts:436-446`）。ADR 3.1 的 `origin_history` 只写“导入的原生历史；分支不复制”，3.3 把分支改成 `{sessionId, throughOrdinal}` 引用，3.6 的校验没有这一项。

**后果。** 现有分支若在迁移时被改成引用：源已删的，历史全丢；源还在的，读到的东西与原来复制的不一样（多了工具；`runtime.ts:554` 原来只取终态回合）。

**建议。** 写明：迁移时现有分支的 `origin.history` 原样进 `origin_history`（标 `kind='fork'`），附件登记进 `content_refs`；只有 v14 之后新建的分支用引用。校验加一条：`origin.history` 的条数与逐字。

### M4 第一段的过渡层：A 与 B 之间没有能跑的中间态，需要改落地顺序

**是什么。** 计划线 A 把 `sqlite-store.ts` 改成过渡层：“`get()` 从表装出现在的对话并缓存，`transact()` 只写变更的行；沿用 `SessionStore` 端口”，且“不碰 `runtime.ts`”。`SessionStore` 端口交出去的是带旧字段的 `SessionSnapshot`（`session.ts:288-316,329-346`），运行时的归约全在旧字段上做（`runtime.ts:1313-1345` 工具、通知、活动、plan；`:1433-1446` 文字；通知还要和整个对话的通知比对去重，`:1337`）。所以 A 单独合并后要成立，过渡层必须做两件事：
- 表 → 旧字段（`get()`）：要求条目能无损还原成 `tools[]`、`thinking`、一条助手消息……显示投影做不到（M1）。
- 旧字段 → 行（`transact()`）：从前后两份快照的差里反推条目更新；旧字段里没有先后，所以这段时间写出来的新回合也只能是固定顺序。

这是一个要通过现有全部测试、然后在 B 合并时整个扔掉的双向转换器。反过来，B 一旦让运行时不再写旧字段，所有读旧字段的地方必须同时改：`relay-coordinator.ts:294-297`（`needRuns` 读 `state.messages` 的 seq）、`narration.ts:92-100`、`domain/context.ts:68-80`、`relay-tables.ts` 里收整份快照的 `checkRelayRows`、`checkPacketReferences`、`readDeliveries`（`sqlite-store.ts:417,420,449`）、`relay/recover.ts:27`、`server.ts:258-268` 的 `view()`、`session-stream.ts:103-121`、导出、上下文桌、CLI。计划给 B 写的“不碰：存储实现、`src/web/`”做不到，B 与 D、C 实际上被类型系统绑在一起。

**判断。** “双向无损转换的过渡层”可行但不值；“两条线一起切换”是实际情况，但可以把切换点做小。计划没有写的还有一件事：第一段运行时内存里的对话到底是什么形状（带旧字段的 `SessionSnapshot`，还是带条目的新形状）。

**建议的落地顺序。**

*第 0 步：先改设计*（本节 M1–M9），并定下第一段内存里的形状：头 + 全部回合的**轻行**（`run_json` 那些小字段）+ **活动回合的条目**。已结束回合的条目和文字不进内存，要用时按回合读（理由见 M5）。

*第 1 步：纯新增，`CURRENT_VERSION` 仍是 13，可以随时分别合并，互不影响：*
1. v13 冻结夹具（含事件日志）——计划已列为第一件，同意。
2. `schema.ts`（DDL、索引、触发器）、`rows.ts`、`legacy/`（冻结的旧解析，拷贝不是移动）。
3. `toItems` 与 `fromItems`（M1 建议 2）加往返性质测试。
4. `migrate-v14.ts` 作为一个只被测试调用的函数：在临时库上把夹具转成 v14，校验、杀进程续跑。
5. `items-place.ts`（放条目、分段、收场）：对 `ActiveTurn` 的纯归约，单测齐，不接线。
6. 读函数 `readWindow`、`readOlder`、`readItems`、`readText` 和由变更集生成帧的纯函数：对着第 4 项转出来的 v14 临时库测。线 C 的服务端与前端解码可以对着它并行做。
7. relay 契约上界放开到安全整数（M7）：解析器接受的是原来的超集，与 v13 兼容，可以最早合并。
8. 不变量的整份核对器 `verify(conversation)`（M6）。

*第 2 步：切换点（一个集成分支，一次合并；分支内部测试会红）。* 必须同时改的文件：
- `src/contracts/session.ts`（内存里的对话形状、`SessionStore` 的读写签名）
- `src/contexts/session/domain/state.ts`（整份解析换成行级校验加跨行检查）
- `src/contexts/session/application/runtime.ts`（输出、文字窗口、审批、收场、`send`、`fork`、恢复各路径改写条目）
- `src/infrastructure/session/sqlite-store.ts`（`create`/`get`/`transact`/`list`/`listKept`/`nativeOwners`/`contentReferences`/`deleteSession`/`claimAndRecover`，`CURRENT_VERSION=14`，接上迁移）、`snapshot-cache.ts`
- `src/infrastructure/session/relay-tables.ts` 里收整份快照的三个函数、`src/contexts/session/domain/relay/recover.ts`
- `src/cli/session-application.ts`（回收的引用来源）
- 其余读者（`relay-coordinator.ts`、`narration.ts`、`packet.ts`、`table.ts`、导出、`server.ts` 的 `view()`、`protocol-view.ts`）**不在这次改**：它们经 `fromItems` 适配器继续拿到旧形状的 Run，黄金输出不变。这就是把切换点做小的办法，也是 M1 要求条目保留原生事实的第二个理由。

*第 3 步：切换之后并行。* 线 C（窗口、游标、增量帧、前端）；线 D 把读者一个一个改成直接读条目，每改一个对一次黄金；最后删适配器。

*第 4 步：门。* 真机、独立审查、所有者点头，再升 4317。

### M5 第一段“常量都去掉、内存仍是整个对话”是悬崖，不是没有上限

**证据。**
- 每个原生事件都 `load()` 整个对话（`runtime.ts:931-936,1166-1173`）；现在靠版本键的快照缓存顶着，ADR 3.7 说“缓存删除”。
- 启动时 `claimAndRecover` 读遍并解析每个对话，还对每个对话的事件表做一次求和与取最大（`sqlite-store.ts:707-710`）；随后 `contentReferences()` 再读遍一次（`:380-389`）。
- 侧栏 `list(100)` 装 100 个完整对话，总量超过 8 MiB 现在是抛 `READ_LIMIT`（`sqlite-store.ts:178-188`）。
- SSE 单帧超过 8 MiB 直接关连接（`session-stream.ts:66,161`）；ADR 3.4 的窗口“条目带文字、至少放一个回合”，而回复不再有 1 MiB 的顶。
- 计划：第二段 6–8 周，4317 在第一段末升级。

**具体会出什么事。** 第一段结束到第二段结束之间，所有者的真实数据上：一个很长的对话，提交写行是常数，但内存里是全部条目与文字，缓存放不下后每个事件重新从表装一遍（比现在更慢），再大就 OOM；重启后恢复又要装它，可能反复崩。一条 9 MiB 的回复会让窗口帧超过 8 MiB，连接被关，重连拿到同一个快照再被关，这个对话打不开。现在的行为是明确拒绝（`SESSION_LIMIT`、`OUTPUT_LIMIT`），之后是说不清原因的坏掉。

**建议。**
1. 第一段内存里就不放已结束回合的条目与文字（见 M4 第 0 步）。内存与每次提交的遍历只随回合数增长，一万回合约十兆、每次提交几十微秒（估算，未测）。需要历史内容的读者（接力渲染欠的回合、通知去重）按回合读。这等于把第二段里最便宜的一半提前，剩下的（不持有全部轻行）仍归第二段。
2. 启动恢复按“未终结回合”的部分索引、侧栏读 `sessions` 的列——这两项计划已有，但恢复那项排在线 G（第二段），要提到第一段。
3. 窗口里单条长文字也要能省略并按范围取（`textOmitted` 加游标），和去掉回复上限同一段落地；不要等第三段的“范围读取”。
4. 预算测试除了“10 与 5,000 回合提交耗时”，加“打开一个含 20 MiB 单条回复的对话”“一万回合对话的启动耗时与常驻内存”。

### M6 跨行不变量没有着落，其中一条是底线

**是什么。** 现在每次提交把整份快照重新解析一遍并核对前后转移（`state.ts:350-468,523-599`）。ADR 3.3 的替代是：主键外键、两个部分唯一索引、三类触发器，“其余只校验被改的行”。下面这些是跨行的，改一行看不出来：

| 不变量（出处） | ADR 里有没有着落 |
|---|---|
| 开着的对话里，每个 `unknown` 回合都已被一次生效的恢复切换认领（`state.ts:418-420`）；blocked → open 的条件（`:553-556`） | **没有。** 这是“不自动重跑结果未知的执行”的守门 |
| `active_run_id` 与 `runs.status` 一致（`:412-413`）——新设计里头行一份、部分索引一份，两处可以不一致 | 只有“至多一个活动回合” |
| 待定切换至多一个且与 `pending_switch_id` 一致（`:421-422`） | 没有（`switches` 只有主键） |
| 关闭的对话没有活动、排队、待定（`:415`） | 没有 |
| `epoch == 生效切换数 + 1`，当前选择等于最后一次生效切换的目标（`:459-462`） | 没有 |
| 同一 Harness 控制的绑定谱系：epoch 严格增、floor 不降（`:332-339`）；一个对话里同一控制至多一个未归档绑定（`:391-392`） | 没有（ADR 的部分唯一索引是跨对话的原生会话持有） |
| 原生游标属于一个已结束、有收场证据的原生回合（`:393-399`）；保留进程属于交出它的回合（`:381-385`） | 没有 |
| 回合与 send 命令一一对应、命令的结果存在（`:431,463-465`） | 外键可以，但没写 |
| 绑定的变更只能由它的写者回合、原生重置或分支推进；relay 状态单调（`:526-545,509-515`） | 没有 |
| 已派发回合的上下文（relay、来源、`contextReadyAt`）不可改（`:577-579`） | 没有（触发器只列了终态与取消停止） |

**建议。** 在 ADR 里加一张“不变量 → 由谁保证”的表（索引 / 触发器 / 提交时对改动行的检查 / 有意放弃），上表每条给一个去处。`unknown` 的认领建议物化成 `runs` 的一列（迁移时按旧规则算：`sourceRunIds.includes || acknowledgedUnknown.includes`，见 I2），头行 `status` 改成 open 时用一条 `NOT EXISTS` 查询守住。另写一个整份核对器 `verify(conversation)`（旧 `parseSession` 的关系检查搬到行上，用映射代替两层互找），在三处跑：测试里每次提交之后、迁移转完每个对话之后、一条维护命令里。它不进生产的提交路径，所以不影响“提交成本与历史无关”。

### M7 几处“改已落盘的东西”排在了“格式定稿”之后

**证据。**
1. relay 契约的上界：`RELAY_MAX_SEQ=16384`、`RELAY_MAX_RUNS=256`（`relay.ts:24-28`），用在 `mark`、`floor`、`decidedSeq`、`SourceRange`、清单 `runs` 的解析上（`:502,514,528,588-592,605`）。计划第一段末“所有常量上限去掉”（plan:20），放开这些上界却在线 F（第二段，plan:50-52）；计划自己的“发现 1”说要先做。两段之间，对话的事件一过 16384 或回合一过 256，绑定的 relay 状态解析失败，这个对话每次提交都失败。
2. 线 F 写“`relay_index.run_index` 与清单里的回合下标改用回合序号”。`relay_packets` 有不可变触发器（`relay-tables.ts:52`），旧清单改不了；清单的 `runs` 现在被 `slice(0, 256)` 截断（`relay-coordinator.ts:335`），去掉后一个携带上万回合的清单会超过 `manifest_json` 的 64 KiB CHECK（`relay-tables.ts:36`）。
3. ADR 3.7 把 relay 正文配额“超了拒绝”改成“淘汰最旧的已送达正文”（线 F）。`relay_packets` 对 `relay_bodies` 有外键（`relay-tables.ts:37`），淘汰正文要么连清单和送达记录一起删（丢送达证据），要么改表。
4. FTS：迁移在第一段写 `search_fts`（ADR 3.6），维护在第三段（线 H），中间写的回合不在索引里；`rowid = items.rowid`，而 `items` 的主键是 `(run_id, seq)`，没有稳定的整数键（见 I8）。

**建议。** 第 1 项提到第一段最前（M4 第 1 步第 7 项）。`ordinal` 定义为从 0 起、等于旧数组下标，旧清单、`SourceRange`、`relay_index.run_index` 都不用动；清单超长时存区间而不是逐个下标，并在 v14 迁移里一并重建 `relay_packets` 的约束（正文可空、清单上限）。FTS 定为可重建的派生数据：迁移不写它，`items` 在第一段就带一个 `INTEGER PRIMARY KEY`，第三段上线时一次回填。ADR 的说法从“格式只升一次”改成“事实行只转换一次，之后只加索引与可重建的派生表”。

### M8 ADR 3.7 ③ 里“不是我们设的”那几项，全部是我们设的

| 守护（出处） | 超了会怎样 | 判断 |
|---|---|---|
| 执行预算：默认 5 分钟，最多 60 分钟（`session.ts:415`）；等待预算：默认 30 分钟，最多 2 小时（`:416`） | 回合被 Hub 取消（`runtime.ts:1256-1271`），超界的配置直接拒绝（`session.ts:433-443`） | **去掉取消。** 这是对功能最直接的限制：一个跑 6 分钟的任务默认就被停。改成不取消回合的提示（“已运行 N 分钟”），停不停由用户；`NATIVE_TURN_HARD_CAP_MS`（`session.ts:428`）若要留，改成“协议长时间没有任何动静”才触发 |
| 同时待处理的审批 32（`runtime.ts:1290`） | 抛 `PERMISSION_LIMIT`，**当前回合失败**；是全局计数，不分对话 | **去掉。** 内存里的一个 Map，没有理由设顶 |
| 一条连接累计 256 MiB（`json-rpc-process.ts:162,426-428`） | `WIRE_LIMIT`，连接被杀，回合失败 | **去掉，或每回合清零。** 注释自己说原生程序“replay long histories on load”：对加载时回放历史的 Harness，这个数随对话长度增长，等于换了个地方的对话大小上限；保留进程跨回合复用同一连接，也会累计到顶 |
| 单帧 16 MiB（`json-rpc-process.ts:164,360-361`） | `FRAME_LIMIT`，连接被中止 | 留作解析内存的守护可以，但要抬高或改流式解析：计划第三段自己要验“20 MiB 以上的命令输出”，一帧就可能超；20 MiB 的图片 base64 后也超 |
| 并行对话 4（`session.ts:419`，`runtime.ts:1025`） | 第五个排队，不失败 | 改成可配置且不设上界，默认放宽，排队时只提示 |
| 保留进程 4 个（`runtime.ts:774`） | 用户选了保留却不保留（`skipped: "limit"`） | 可以留，但要让用户看见这次没保留 |

ADR 没列、同类的还有：SSE 订阅 8 个，第 9 个 429（`session-stream.ts:66,82`）；对提问的回答 64 KiB（`runtime.ts:263`）。

### M9 “无法转换的对话隔离后照常启动”的后果没有想完

**是什么。** ADR 3.6：单个对话转不了，保留旧快照、记 `last_error`、其余照常，界面列为“无法转换”。新代码没有旧形状的读者（ADR 第四节否决了两套读者）。

**后果。** 这个对话：内容引用不在 `content_refs` → 被回收（M2）；它持有的原生会话不在部分唯一索引里 → 别的对话可以接着同一个原生会话，一个原生会话两个持有者（`sqlite-store.ts:361-374` 原来防的就是这个）；它的保留进程记录（`retained`）不在 `sessions` 的列里 → 上一任所有者留下的进程组没人结束、工作区租约没人放（`runtime.ts:704`）；它若有未终结的回合 → 没人把它收成 `unknown`。

**建议。** 目标定为“对任何合法的 v13 数据，转换必不失败”（M1 的往返性质就是为此）。校验不过说明是程序错：停下来、不开始监听、原样保留、说明是哪一个对话和原因，等修好的构建续跑。若坚持隔离后照常运行，上面四件事每件都要有一个读 `format<14` 行的冻结读者接着。另外把启动顺序写进 ADR：锁 → 备份 → 第一个事务（确认上一任所有者已退出、老阶梯、建表、置 14、认领 generation）→ 逐对话转换 → 用新代码按部分索引做恢复（含接力恢复）→ 回收 → 监听。现在恢复与认领在同一个事务里读遍所有对话（`sqlite-store.ts:563-717`），ADR 没说恢复放在转换前还是后。

---

## 二、实现时要注意的

**I1 接力水位的两条迁移规则。**
- 事实的 seq 是三级回落：`run.ended` 的 seq（或把它收场的那条 `session.recovered`，取第一次出现）→ v12 迁移写的 `relay_index` 行的 `seq` → `state.lastSeq`（会动，注释说“可能重发，绝不漏发”）（`relay-coordinator.ts:125-132,168-169`）。`ended_seq` 为空的回合，新查询必须当成“在水位之上”，不能当 0 也不能跳过，否则漏发。
- 命令回合算不算事实，有三个来源和一个先后：有没有 `run.native_command` 事件、它带的效果、`run.ended` 结算的效果、v12 回合用索引行的 `commandEffect`（`relay-coordinator.ts:130,157,167`）。“是命令、效果读不出”现在的结果是不进交接单；一个可空的 `context_effect` 列会把它和“不是命令”混在一起，这个命令回合就被当成普通回合发出去。需要一个非空的值或单独一列。
- 迁移校验加一条：对每个绑定，旧代码的 `ledger.facts()` 与新查询的结果相同。
- 新回合的 `ended_seq` 等于同一事务里 `run.ended` 拿到的 seq；seq 现在由 Store 在提交时分配（`sqlite-store.ts:791-795`），建议由 Store 写行时回填，别让归约函数另算一次。

**I2 `switches.sourceRunIds` 不一定是前缀。** 它是“终态回合加当前活动回合”（`runtime.ts:475`）。如果排队中的输入能单独取消（命令类型里有带回合 id 的 cancel，`state.ts:464`；取消路径我没逐行读），会出现“活动、排队、已取消”的排列，来源集合跳过了中间那个排队的。v13 之前的恢复切换靠 `sourceRunIds.includes` 认领 unknown（`state.ts:418-419`）。改成 `source_through_ordinal` 后若用“序号 ≤ through”判断认领，一个当时在排队、后来跑成 unknown 的回合会被算成“已认领”。按 M6 的建议在迁移时把认领物化到回合行上，`source_through_ordinal` 只作显示。

**I3 文字分块。**
- 相邻两块可能把一个代理对拆开（`runtime.ts:131-137` 的 `joinedBytes` 就是为此写的）。SQLite 的 TEXT 是 UTF-8，单独的半个代理对存不进去。窗口提交时把末尾的高位代理留到下一块。（按 SQLite 的已知行为推断，没有实测。）
- 按字节范围读要落在码点边界上；每块存起始字节偏移，省得每次求和。拼接在 JS 里做，不用 SQL 的字符串函数。
- 纯空白窗口“并入下一段开头”：回合就此结束或换了种类时怎么办要定（建议照写不丢）。
- `item_text` 的“禁止删除”触发器要给软删后的真正清行留口。

**I4 `phase` 的推断。** “终态后，除 plan 外最后一个条目是助手段者为 `final`”：被取消或失败的回合，最后半句话会被标成“这一轮的答案”；正常完成的回合，回答之后若还有产物、通知、压缩事件，就没有 `final`，界面若把 commentary 收进工作摘要，答案就被折起来。建议：只有 `completed` 才有 `final`；找最后一个助手段时跳过通知、plan、产物、上下文事件；原生一侧自己报了 phase 的，存下来不推。

**I5 `legacy_order` 与条目身份。** `ProtocolTurn`（`protocol.ts:146-157`）没有字段表示“这一轮的顺序是固定排列的”，上下文桌、`hub_read_turn`、导出都拿不到。加一个字段并在这三处说明。“可选增强”（事件回放恢复先后）会改已终结回合的条目，与终态触发器冲突，做的时候要有专门的口。

**I6 触发器与语句顺序。** 收场要先改条目、后把回合改成终态，否则“终态回合不可改”的触发器会拦住收场自己。条目上的同类触发器要查 `runs.status`。给 `runs`、`items`、`commands`、`switches`、`bindings` 加禁止删除的触发器（现在的“历史不可删、不可重排”，`state.ts:559-564`）。

**I7 SSE。** 现在每帧是某个 `lastSeq` 的完整状态，客户端丢掉水位不高于已有的帧（`session-stream.ts:158`），所以跳帧安全。改成增量后：一次提交的多个帧水位相同，按现在的规则第二帧起会被丢——一次提交发一个帧，或换判重规则。`text` 帧的 `from` 不等于客户端已有长度时，客户端要重取快照，不能照接。运行时的 `publish` 现在按事件逐个发布（`runtime.ts:968-973`），要改成按提交。

**I8 搜索（第 6 问）。**
- trigram 至少三个字符，两个汉字的词（接力、迁移、上限）不命中，这是常见查询，不是边角。
- 回退“按块扫描”：一个词跨在两块之间就漏；扫描量是全部文字，不设上限后随总量线性增长。
- 更合适的做法：FTS5 再建一张按字切分的索引——入库前把汉字逐字用空格隔开（拉丁词保持原样），查询同样处理后用短语匹配。用内置的 `unicode61` 就行，不需要扩展（库是以 `allowExtension: false` 打开的，`sqlite-store.ts:286`，装不了自定义分词器）。一两个汉字的查询走它，三个字符以上走 trigram，一两个拉丁字符的查询才回退扫描，且扫的是拼好的整段。（这个做法没有在本机的 SQLite 上试过。）
- `rowid = items.rowid` 不稳：备份用 `VACUUM INTO`，没有整数主键的表在副本里 rowid 可能重排，恢复备份后索引指向错的条目（ADR 第二节自己记了 T3 的这个问题）。`items` 加 `INTEGER PRIMARY KEY`（M7）。

**I9 事件仍是四处读者的事实来源。** ADR 3.5 说事件不再是任何读者的事实来源，3.3 把 `runtime.ts:883,2043,2246` 归到 `ended_seq` 一行，但这三处读的是别的事件：待定切换是不是恢复切换（`:881-886`）、恢复检查扫整个日志找 `switch.failed` 与 `session.blocked`（`:896-905`）、relay 恢复失败指向哪个回合（`:2041-2047`）、上一任所有者接受的输入选了什么（`:2244-2249`）。要么把这些事实搬进行，要么在 ADR 里照实写事件仍被读，这几类事件的 `data` 不能变轻。

**I10 3.3 的读者表漏了一个。** 通知要和整个对话里所有通知比对去重（`runtime.ts:1335-1337`）。第二段没有“读全部历史”的方法后，它需要一个按对话的通知指纹索引。

**I11 软删之后原生会话仍被持有。** 现在硬删会放掉对话持有的原生会话；软删后绑定行还在、状态还是 ready，部分唯一索引继续占着，用户删了对话却不能在别处接着那个原生会话。软删时把绑定归档。

**I12 CLI 的只读读者**（`cli/sessions.ts:40`，`SqliteSessionReader`）会在迁移中途看到版本 14、行里 13 与 14 混着的库，要认得并说明。

**I13 ADR 内部两处不一致。** `backend`、`cleanup` 在 3.1 里放 `run_json`，在 3.5 里是 `backend_json`、`cleanup_json` 两列；若要“单调由行触发器保证”，得是列。3.6 的校验要从表里用生产的读函数读回来比，不是比内存里刚转出来的对象。

---

## 三、没问题的（查过什么）

读过的代码：`contracts/session.ts`、`contracts/protocol.ts`、`domain/state.ts`、`domain/protocol/` 的 `project.ts`、`tools.ts`、`changes.ts`、`usage.ts`、`status.ts` 全文；`web/protocol-view.ts` 的详情缓存；`sqlite-store.ts` 130–805 行；`relay-coordinator.ts` 60–360 行；`relay-tables.ts` 的 DDL 与正文配额；`content-store.ts` 的回收器；`session-stream.ts` 60–197 行；`runtime.ts` 的提交与发布、输出、文字窗口、审批、预算、分支、恢复检查、读事件的几处；`relay/delivery.ts` 的 `owed`；`relay/narration.ts` 读哪些字段；`json-rpc-process.ts` 的两个上限。

- **出处抽查。** `sqlite-store.ts:151,173-174,361-374,376-392,398-427,436-446,508,569,587-701,707-715,725-747`、`state.ts:14-30,294,350-468,423-442,476-487,523-599`、`runtime.ts:263,475,543-580,930-957,1290,1313-1329,1410-1445`、`relay-coordinator.ts:114-137,294-338`、`relay.ts:24-26,39`、`relay-tables.ts:156`、`session-stream.ts:103-121,138-149,159`、`json-rpc-process.ts:162-164`、ADR-047 的 7.8 ms 与 44.8 ms（`0047:7`）都对得上，个别差一两行（`session.ts:412` 实为 `:419`，`runtime.ts:1289` 实为 `:1290`）。唯一对不上的是 I9 那一行。
- **事件变轻不破坏水位语义。** `mark`、`floor`、`decidedSeq` 只要求 seq 单调、`run.ended` 有自己的 seq；文字窗口仍各占一个 seq。`owed()` 只比较 seq 与“在不在这个原生会话上跑的”（`delivery.ts:79-92`）。
- **`MIGRATION_EVENTS` 够用。** 补 `ended_seq`、`context_effect` 需要的 `run.ended`、`session.recovered`、`run.native_command` 都在清单里（`sqlite-store.ts:151`）。
- **文字只追加在崩溃、重启、取消时的完整性与现状等价。** 没提交的窗口（至多 100 ms 或 16 KiB）丢失、回合记 `unknown`，现在也是这样；停止、预算到期、结算之前都先提交窗口（`runtime.ts:785,818,859,1185,1260,1815,1838`）。分块表每个窗口一个事务，不存在半块。
- **收场表与代码一致。** 回合结束时还开着的动作记 `cancelled` 或 `unknown`，不记 `completed`（`tools.ts:266-272`）；认不出的状态词是 `unknown`（`status.ts:21-23`）。
- **审批的决定先提交**（`runtime.ts:275`；之后才转给程序这一半我没读到那一行，按“事实先提交再发布”的约定推断），所以“重启后记 `cancelled`、不写 decision”不会把已经送达的批准说成没发生。
- **头行 `version` 比较并交换**仍然串行化一个对话的所有写入，前提是每个变更集都改头行（ADR 是这么写的）；单所有者加同步的 `node:sqlite`，没有真正的并发写。
- **提交后发布、发布与提交同序**：提交与发布在同一个同步调用里（`runtime.ts:942-973`），新设计不改这一点。
- **`owner_generation`**：只在事件上，迁移不改事件，不受影响。
- **旧构建拒绝 v14 且不改库**：版本大于已知就抛错回滚，且不触发备份（`sqlite-store.ts:508,569,717`）。
- **逐对话事务、可续跑**：每个对话原子，`format<14` 即未转；与“一个事务转全部”相比的取舍我同意。
- **备份本身的做法**（写成 `.partial`、读回核对行数与 `quick_check`、同步后才改名，`sqlite-store.ts:505-550`）是扎实的；问题只在它不含内容库和会被轮换（M2）。
- **分页游标按回合序号**：回合只追加、终态不可改，新回合到来不会错位。
- **拆表的理由**（ADR 第一节）成立：`parseSession` 的两层互找确实是平方的，`transact` 确实整份重写。

---

## 四、第 7 问：分段能否并行，最容易出问题的三处

**并行会踩的地方。** `contracts/session.ts` 被 A、B、E 三条线改；`relay/narration.ts`、`packet.ts` 先被 D（第一段）改成读条目，再被 F（第二段）改成分批取；`state.ts` 被 A 冻结拷贝、被 B 重写（A 必须拷贝不是移动）；`sqlite-store.ts` 先 A 后 E、G。B 的“不碰”清单做不到（M4）。C 依赖的“proto-web 线上形状”和 D 的“交接单逐字”都卡在别的未定项上（后者卡在 M1）。按 M4 的顺序，第 1 步的八项可以真并行，切换点由一个人做，之后 C、D 并行。

**最容易出问题的三处。**
1. 切换点那一次合并，加上转换的保真（M1、M4）：几千行同时变，唯一的安全网是往返性质和整份核对器，两者都要在切换之前就有。
2. 接力：水位的迁移规则、relay 上界跨段、绑定谱系的不变量（I1、M7、M6）。出错的表现是悄悄重发或漏发，测试不专门找就看不见。
3. 迁移前后的启动与回收（M2、M9）：这是唯一会不可逆删东西的地方，而且发生在所有者的真实数据上。

---

## 五、没来得及查的

- `runtime.ts` 只读了约三分之一；结算与收尾（约 1500–2000 行）、导入（`importOwned`）、保留进程、取消排队输入的路径没有逐行读。
- `contracts/relay.ts` 只读了上界与用到它们的解析行；`contracts/control.ts`、`relay/packet.ts`、`relay/redaction.ts`、`relay/migrate.ts`、`relay/recover.ts` 只搜了关键字。任务里列的 `context.ts` 不在 `relay/` 下，在 `src/contexts/session/domain/context.ts`；只核对了 ADR 引的 68–85 行（`buildPublicContext` 也读 `state.messages`，属于 M4 里经适配器过渡的读者）。
- `src/web/server.ts` 只读了上限常量与 `view()`；路由、导出、`readinessViews` 没读。前端代码没读。
- ADR-049 没读原文，只对了实现；ADR-047 只对了数字。
- 排队等并行名额的时间算不算进等待预算，没有核实。
- 没有跑任何测试，也没有在 SQLite 上验证触发器、部分索引、FTS 的行为；I3 的代理对、I8 的按字索引与 rowid 三条是推断，动手前各用十来行脚本确认一下。M5 里的内存与耗时数字是估算。
- 4317 的真实数据没有看（也不该看）：库大小、最长对话、有多少分支与任务清单调用，都会影响 M1、M3 的实际面。
