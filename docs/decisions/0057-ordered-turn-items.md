# ADR-057：有序条目落盘，对话存储改成表（v14），去掉所有内容上限

状态：proposed，2026-11-12（重写）。取代同日初稿 dee209e（保留旧字段、每轮 256 条上限、仍是整份快照）。依据：所有者的新决定“全部转向新协议，每个对话不设置上限，学习t3code，包括其他功能都不要设置限制，不要局限功能”；[统一协议设计稿](../proposals/protocol/hub-protocol.html)第 4–6、10、16、17 节；[决定记录 2026-11-12](LOG.md)；[显示层审计](../research/hub-display-audit-2026-11-12.md)；[T3 Code 调研](../research/t3code-protocol-ui-2026-11-12.md)加本次对其存储的补读（`b883156`，只读，出处写作“文件:行”，相对 T3 仓库）。按 AGENTS.md，改持久格式与“会不会丢内容”的逻辑，每段上线末做一轮独立审查（清单在末尾）。实施顺序见 [step2-plan](../proposals/protocol/step2-plan.md)。

## 一、决定了什么

1. 条目是事实本身。旧字段（`thinking`、`tools[]`、`plan`、`notices[]`、`activities[]`、`outputs[]`、每轮一条助手消息、`messages[]`）不再写；界面、交接单叙述、上下文桌、导出、搜索都读条目。
2. 没有总大小硬顶：不丢弃、不拒绝、不截断用户的内容。办法是分页和按需读取，不是封顶（3.7 逐个列出要拆的上限）。
3. 旧对话在升级时一次性转成新格式，先自动备份；回退 = 恢复备份。
4. 格式只升一次（v13 到 v14）。之后的阶段只改代码，不再动数据。

为什么必须拆表，而不是只去掉常量：
- 现在一个对话是一份快照 JSON，每次提交整份序列化、解析、校验、重写（`sqlite-store.ts:411-421`）。ADR-047 的实测是 1 MB 的快照每块 7.8 ms、4.2 MB 要 44.8 ms；我在同一台机器上做的原型（临时库，非生产代码）里，只算序列化加重写，4 MiB 也要 11.5 ms。按下面的表，一个文字窗口的提交是 0.11 ms，与历史多长无关。
- 校验里有两层互相查找（`state.ts:423-442`：每条消息在全部回合里找，每个回合在全部消息里找），回合到万级就是亿次比较。
- 现有上限（256 回合、8 MiB、16384 条事件，`state.ts:14,20,21`）正是为压住这些代价设的。去掉上限，就必须去掉整份快照。

## 二、T3 Code 怎么存（读到的事实）

| 问题 | T3 的做法 | 出处 |
|---|---|---|
| 谁是真相 | 投影表是真相。一次数据库事务写事件、投影行、命令回执、待办效果；提交后才发布，发布与提交同序（`publishLane`） | `docs/internals/overview.md:47-52`；`EventSink.ts:286-310,383-390` |
| 怎么分表 | 事件表（自增序号）；投影 `…_projection_{threads,runs,nodes,turn_items,messages,plans…}`，每张几列索引加整行 `payload_json` | `055_OrchestrationV2.ts:20,225-240` |
| 条目位置 | 首次见到时在 `…_turn_item_positions` 定下，`ordinal = 回合序号×1,000,000 + n`，线程内唯一 | `TurnItemPositionStore.ts:63-65`；`Foundation.ts:123` |
| 事件保留 | 只留约一天（回放与命令重试用），之后删掉投影已覆盖的事件，所以投影不能从日志重建；每个流的最新事件等少数事件保留 | `ProjectionMaintenance.ts:42,255-300`；`overview.md:61-70` |
| 长线程怎么取 | 有界快照：约 1 MiB、10 个用户回合（更早的页 20）、500 行，其余窗口 75 行，至少放一行；游标是 base64url JSON；回放超过 128 个事件或 1 MiB 就改发快照 | `threadHistoryPaging.ts:16-21,60-76,309`；`ThreadStream.ts:18-20,100`；`performance-regressions.md:15,31` |
| 展开时再拉 | 一段里已完成的工作条目超过 150 个，折成带游标的占位（`deferredWork`），展开再取 | `threadHistoryPaging.ts:23,203` |
| 大块内容 | 命令输出整段存在条目行的 `payload_json` 里；线上去掉并打 `outputOmitted`，详情按条目取，**截到 256 KiB**。存储时 diff **截到 32 KiB**，完整 diff 走检查点（隐藏的 git 引用）的 diff 端点；检查点文件线上只给 **200 个**加总数；实时命令输出不进事件库；跨环境导出超过附件上限就被拒 | `WireProjection.ts:26-29,54,155,242`；`performance-regressions.md:35-43,45-51`；`overview.md:88` |
| 搜索 | FTS5 trigram 无内容表，触发器维护，VACUUM 后 rowid 会变，要重建 | `messageSearchIndex.ts`；`069_ThreadMessageSearch.ts` |
| 分支与删除 | 分支继承源的条目，不复制；删除是软删（`deleted_at`） | `ProjectionStore.ts:1337-1500`；`055_OrchestrationV2.ts:66` |
| 旧数据转换 | 按线程加锁、事件 id 确定、每批 50 条、状态表带 `last_error`，可重来；先转外壳，正文首次打开或后台再转 | `LegacyV1ThreadImporter.ts:683-805`；`LegacyV1ImportState.ts` |
| 启动恢复 | 从投影状态挑候选，不为确认“没活要干”去读已完成的历史 | `performance-regressions.md:81` |
| 客户端 | 有界快照加 `historyCursor`；加载更早是显式按钮；虚拟列表靠稳定 id 与前插保位 | `MessagesTimeline.tsx:821-825,1312-1343,1390,1414` |
| 出过的问题 | 回合窗口里的大工具输出让窗口查询要约一秒（改成先选 id 再按 id 取正文）；忙命令的输出刷事件库会堵死所有线程（所以输出走单独通道）；事件剪掉后投影不能重建 | `ProjectionStore.ts:3156`；`performance-regressions.md:45-51` |

照搬：①一个事务写变更与事件，提交后再发布；②条目一行（几列索引加正文），位置首次见到时定下；③窗口加游标分页、大块按需取、实时输出不进事件库；④FTS5 trigram；⑤按对话可重来的转换加状态；⑥启动只看未完成工作的索引；⑦分支引用源、删除软删。
不该照搬：①剪事件日志，之后无从重建、无从审计；②任何截断（diff 32 KiB、详情 256 KiB、检查点 200 个）——我们按范围读取全文；③每回合 999,999 个位置的隐含上限（`TurnItemPositionStore.ts:64-65`）；④7,671 行的动态 SQL 窗口（`ProjectionStore.ts`）：它要从条目反推“用户回合”，我们一回合就是一个 Run，按回合序号翻页即可。

## 三、决定

### 3.1 表（v14，STRICT；`sessions`、`events`、`create_keys`、`owner_metadata`、`relay_*` 沿用原名，外键不动）

| 表 | 一行 | 主键与索引 | 放什么 |
|---|---|---|---|
| `sessions` | 对话头 | PK `id`；`(updated_at)` | `version`、`last_seq`（并发与事件游标，语义不变）、`format`（13/14）、`status`、`epoch`、`active_run_id`、`pending_switch_id`、`title`、`run_count`、`updated_at`、`deleted_at`；列 `snapshot` 改名 `head`，只放配置、当前执行者（`selection`）、保留进程、`relayRecoveryFailed`、分支来源引用等小对象 |
| `bindings` | 一个原生绑定（含已归档） | PK `(session_id, ordinal)`；部分唯一 `(harness_id, control_id, checkpoint)` 限 ready/unconfirmed 且非 opensNew | 接力状态（epoch、mark、floor、pending）、观察到的配置、`binding_json` |
| `runs` | 一个回合 | PK `(session_id, ordinal)`；`run_id` 唯一；部分唯一 `(session_id)` 限 preparing/running/settling；部分 `(session_id, status)` 限未终结；`(session_id, ended_seq)`；`(harness_id, control_id, prepared_at)` | `status`、`user_seq`、`ended_seq`、`dispatched`、`executed_on`（三列：harness、control、epoch）、`context_effect`、`cancel_requested`、`stop_requested`、`legacy_order`；其余在 `run_json`（selection、backend、cleanup、error、timing、usage、relay、relayRequest、retained…） |
| `items` | 回合里一个条目 | PK `(run_id, seq)`；`(run_id, item_id)` 唯一；部分 `(run_id, status)` 限未终结 | `type`、`status`、起止时间、`parent_seq`、`text_bytes`、`item_json`（类型字段，不含正文与大块） |
| `item_text` | 正文的一块 | PK `(run_id, item_seq, chunk)`，WITHOUT ROWID | 用户消息、助手段、思考段的文字；一个提交窗口一块，只追加 |
| `content_refs` | 条目或回合引用的内容库对象 | `(content_id)`；`(run_id, item_seq)` | 内容回收与反查 |
| `commands`、`switches` | 幂等记录、换家 | PK `(session_id, command_id)`、`(session_id, switch_id)` | 现有字段；`switches.sourceRunIds` 数组改成 `source_through_ordinal`（`runtime.ts:475` 本来就是“到当前回合为止的所有回合”） |
| `origin_history` | 导入的原生历史 | PK `(session_id, idx)` | 导入时被引用的原生消息；分支不复制（3.3） |
| `search_fts` | 全文索引 | FTS5 trigram 无内容表，rowid = `items.rowid` | 已结束的用户消息与助手段 |

原型（40 万条目、1 万回合，临时库，非生产代码）：取最近 10 个回合连条目与文字 0.33 ms，加载更早一页 0.006 ms，找“有未完成回合的对话”走部分索引 0.001 ms；`ALTER` 改名、加列、部分唯一索引、终态触发器在 SQLite 3.54 上都按预期工作，检查约束与外键在改名后仍有效。未含 FTS 维护与迁移。

### 3.2 条目、文字、大块

- 条目就是 `protocol.ts` 的 `ProtocolItem`，一行；类型字段在 `item_json`，文字在 `item_text`，不进 `item_json`。文字分块追加：一个提交窗口（ADR-047，100 ms 或 16 KiB）追加一块，不改已有块；触发器禁止对 `item_text` 更新或删除。读全文 = 按块号拼接。段关闭时，同一事务把拼好的全文写进 `search_fts`。
- 大块（命令输出、diff、工具输入输出、附件、产物）继续放内容库，条目只存引用并登记 `content_refs`。内容库不再截断，不再有单项 20 MiB、总量 4 GiB、26 万条的上限（3.7），读取用字节范围。
- 分段：窗口从不跨边界（任何别的事件到达前先提交窗口，`runtime.ts:1282-1284`）。一段在首个含非空白字符的窗口打开，同类连续窗口并段；换种类、放下一个占时间线位置的条目（动作、审批、提问、通知、压缩、产物）、回合进入终态，就关段。plan、用量、诊断、已有条目的更新不切段。纯空白并入下一段开头。`phase` 不存，读侧推出（终态后，除 plan 外最后一个条目是助手段者为 `final`）。
- 身份：`tool:<原生 id>`、`activity:<id>`、`permission:<permissionId>`、`text:<n>`、`think:<n>`、`notice:<n>`、`output:<n>`、`plan`。`(run_id, item_id)` 唯一，同一 id 反复上报是同一行的 upsert，内容没变不提交；类型在回合进行中可以细化。`seq` 从 1 起，首次出现时定下，随行存，不复用。位置在事件到达时预留；异步写内容库的先占位后补引用，写失败标 `failed`。
- 收场（回合终态或重启恢复，同一个纯函数）：开着的段随回合状态；pending 或 running 的动作，回合 cancelled 记 `cancelled`，其余记 `unknown`；waiting 的审批、提问记 `cancelled`。
- 审批与提问：开出时同一提交放 `waiting` 条目；用户决定时同一提交改成 `completed` 或 `declined` 并写 `decision{role, by, at}`（提问写 `answer`）；预算到期记 `cancelled` 加 `by:"timeout"`；Harness 撤回按它说的；重启时 `cancelled`、不写 decision。secret 回答不落盘（条目带 `secret:true`），也不进 `commands.fingerprint`（现为裸 SHA-256，`runtime.ts:263`，`session-application.ts:55,140`）。
- 解析只检查结构，不检查大小。

### 3.3 运行时怎么改

现在的状态机（出处）：每个事件先 `owned()`→`load()` 取整份冻结快照（`runtime.ts:930-936,1165-1173`）；归约在整份上做（`updatedRun`，`:186-192`；`send` 展开 `runs`、`messages`、`commands`，`:437-440`；`flushStream` 对全部消息 `map`，`:1432-1445`）；`commit()` 把整份交给 `store.transact`（`:941-957`），后者整份解析、校验、序列化、重写（`sqlite-store.ts:398-427`，`state.ts:350-468,523-599`）；启动时读遍所有对话（`sqlite-store.ts:707-715`）。

新模型：内存里只有对话头（小，常驻缓存）和正在进行的回合（`ActiveTurn`：回合行、`nextSeq`、未终结的条目与开着的段、当前窗口；已终结的条目不留内存，按 `(run_id, item_id)` 唯一索引查）。历史回合落表后不再进内存。端口：

```ts
interface ConversationTx {   // 只有索引查询，没有“读全部历史”的方法
  head(): Head;  run(id): RunRow | null;  runAt(ordinal): RunRow | null;  active(): RunRow | null;
  queued(limit): RunRow[];  openRuns(): RunRow[];  before(ordinal, limit): RunRow[];  owed(binding, mark, floor): RunRow[];
  items(runId, after, limit): ItemRow[];  text(runId, itemSeq, from, limit): string;
  command(id): CommandRow | null;  switchOf(id): SwitchRow | null;  bindings(): BindingRow[];
}
interface Mutation { head?; runs?; items?; text?; bindings?; commands?; switches?; contentRefs?; events: EventDraft[]; relay?: RelayRows }
transact(id, expectedVersion, mutate: (tx: ConversationTx) => Mutation): Commit  // Commit 带变更集，供发布用
```

`version` 乐观并发不变（头行上比较并交换）。原来由整份校验保证的不变量，改由：唯一性与外键交给主键与外键；“只有一个活动回合”“一个原生会话只被一个对话持有”交给部分唯一索引（后者原来靠 `nativeOwners` 的 JSON 遍历，`sqlite-store.ts:361-374`）；“终态回合不可改”“取消与停止不可撤销”“文字只追加”交给触发器；其余只校验被改的行。`SessionSnapshot` 不再是存储或内存里的对话，只作纯函数（渲染器）的切片输入类型。

读者：

| 读者（现在的位置） | 现在 | 改成 |
|---|---|---|
| 接力 `needRuns`、`rangeOf`、`renderView`、`packetManifest`（`relay-coordinator.ts:294-338`）、`holdsNothing`、`nativeExactAt`、`relayFacts`（`runtime.ts:507,2233`） | 遍历全部回合与消息 | 查 `runs` 的列与索引（`ended_seq`、`dispatched`、`executed_on`）；`needRuns` 是一条带范围的查询 |
| `RelayLedger`（`relay-coordinator.ts:114-137`）、`runtime.ts:883,2043,2246` | 分页扫整个事件日志找 `run.ended` 的 seq 与命令效果 | 这些事实在 `runs` 行（`ended_seq`、`context_effect`）；删扫描 |
| 接力渲染 `relayUnits`、`renderRelay`（`narration.ts:73-102`，`context.ts:68-85`） | 一次拿到全部欠的回合 | 从新到旧分批取，到预算为止；省略数用 SQL 计数 |
| 水位与回合下标（`relay.ts:24-26`：seq ≤ 16384、回合 < 256） | 契约里写死 | 放开到安全整数；`mark`、`floor` 仍是事件 seq |
| 上下文桌 `table.ts:88-92`、`table-routes.ts:123`、`hub-tools` | 整份快照里按 n 找回合 | `runs(ordinal)` 点查加条目分页；目录分页；搜索走 FTS |
| 搜索（`hub_search`、界面查找） | 扫快照里的文字 | FTS5 trigram（≥3 字符；原型确认两个汉字的词不命中）；更短的词退回按块扫描并说明 |
| 导出 `conversation-export.ts` | 拼成一个字符串 | 逐回合流式写出（也避开 V8 字符串上限） |
| 分支 `fork`（`runtime.ts:543-580`）、删除 `deleteSession`（`sqlite-store.ts:436-446`） | 复制历史进 `origin.history`，超 1 MiB 建不出分支（`state.ts:294`）；硬删 | `origin = {sessionId, throughOrdinal}` 只存引用，读时先源后己；删除是软删，被引用的行不清（无引用且用户确认后才真正清行） |
| 换家、恢复（`runtime.ts:474-478,886-919,2084-2135`）；`carriedNativeConfiguration`（`state.ts:476-487`，`view()` 每次都算） | `sourceRunIds` 数组、对全部回合与消息的过滤、`findLast` 遍历 | `source_through_ordinal` 加 `runs` 范围查询；未知回合走未终结的部分索引；“某绑定最后一个已派发的回合”走 `(session_id, harness_id, control_id, ordinal)` 索引 |
| 导入 `importOwned`（`runtime.ts:151,355-407`） | 截到 200 条、512 KiB | 全部写 `origin_history`；Harness 没给的部分如实记数 |
| 侧栏、`/state`（`server.ts:580,225-269`） | `list(100)` 解析 100 份快照，`readinessViews` 扫所有回合 | 读 `sessions` 的列；启动用时取每个入口最近 5 个回合 |
| 排队、取消、关闭（`runtime.ts:424,478,788,841`） | 过滤全部回合 | `runs` 的部分索引 |
| 恢复、回收、`listKept`（`sqlite-store.ts:707-715,376-392,353-356`；`session-application.ts:126-128`） | 启动时读遍所有对话 | 未终结回合的部分索引；`content_refs`；`sessions` 的列 |
| 诊断、CLI（`run-diagnostics.ts:100-118`，`cli/sessions.ts:41`） | `runs.findIndex`、`runs.length` | `ordinal`、`run_count` |

### 3.4 读取与分页

- 会话视图 `GET /api/v1/sessions/:id` 给 `{head, window, olderCursor, permissions, nativeStates, lastSeq}`。`window` 是最近的回合，到 10 个回合或约 1 MiB 为止，至少放一个回合；条目带文字、去掉大块（`bodyOmitted` 加 `detail` 引用）。这些是传输页大小，不是存储上限（数字与 T3 相同）。
- 更早的回合 `GET …/turns?before=<游标>&limit=`。游标是不透明的 base64url（回合序号、取得时的 `lastSeq`），按 `(session_id, ordinal)` 翻页；回合序号不变，所以新回合到来不会错位。
- 一个回合里已完成的工作条目超过 150 个，窗口里把中段折成 `deferredWork{fromSeq, toSeq, count}`；`GET …/runs/:ordinal/items?after=&limit=` 取。
- 大块与长文字：`GET /api/v1/content/:id` 与 `GET …/items/:runId/:seq/text` 都支持 `offset`、`limit`（字节范围），不截断。
- SSE 帧由提交的变更集生成，提交后才发布：`snapshot`（头加窗口）、`head`、`run`、`item`（条目 upsert，去大块）、`text`（`{runId, itemSeq, from, text}` 追加）、`relay`、`attention`。每帧带 `lastSeq`；重连一律先发 `snapshot` 再接增量，不回放事件（比 T3 简单：T3 在 128 个事件内回放，超了才改发快照）。慢连接的 `dirty`→`snapshot` 回退保留（`session-stream.ts:138-149,159`）。取代“整条消息替换”和“整个 Run 替换”（`:103-121`）。
- 前端：条目行用稳定 id `runId/seq` 当 key；前插更早页时保位；虚拟列表只依赖这两点（T3 的 `maintainVisibleContentPosition`）。何时加载更早由界面决定。
- 页大小常量放进一个模块，测试断言窗口字节不超预算（“至少一个回合”除外），对应 T3 的传输预算测试。

### 3.5 事件日志

- 继续保留全部事件，不修剪。事件变轻：文字窗口只记 `{runId, item, chunk, bytes}`，不含文字；工具等仍记摘要。v13 以前的事件原样保留。条数、总量、单条的上限（`state.ts:21-23`）全部取消。
- 事件不再是任何读者的事实来源（见 3.3 的接力两行），只做顺序证据、审计与 SSE 的序号。
- 约定不变：事实先持久提交再发布（`commit()`→`publish()`，`runtime.ts:941-972`），一次提交 = 一个事务写变更集加事件；取消受理、后端停止、资源清理分别记录，仍是 `runs` 的 `cancel_requested`、`stop_requested`、`backend_json`、`cleanup_json`，加 `run.cancel_requested`、`run.stop_requested`、`run.backend_settled`、`run.ended` 事件；单调由行触发器保证。
- 事件数与 `last_seq` 一致，不再每次读时核对（`sqlite-store.ts:173-174` 要扫事件），改成一条维护命令里的核对。

### 3.6 迁移 13 到 14

- 触发：打开 v1 到 v13 的库。先备份（ADR-049，条件改为 1 到 13，`sqlite-store.ts:508`），备份失败则不迁移；需要约两倍库大小的空闲空间，不够就拒绝启动并说明。
- 第一个事务（小）：v1 到 v13 的老阶梯照旧逐级升（`sqlite-store.ts:587-701`），所以 `state.ts` 的整份解析、`relay/migrate.ts` 与 `relay.ts` 里带 16384、256 上界的那部分解析器要原样冻结进 `legacy/`，只供迁移用；然后建新表，`sessions` 加列（`format` 默认 13）、`snapshot` 改名 `head`，设 `user_version=14`。
- 之后每个对话一个事务：读旧快照 → 读侧投影转成条目 → 写 `runs`、`items`、`item_text`、`content_refs`、`commands`、`switches`、`bindings`、`search_fts` → 读该对话的 `MIGRATION_EVENTS`（`sqlite-store.ts:151`，v13 迁移已在用）补 `ended_seq`、`context_effect` → 校验 → 写头行并置 `format=14` → 提交。
- 校验（不过则回滚这个对话）：回合数、命令数、绑定数与 relay 状态相等；每个回合的用户文字、助手文字、思考文字与旧值逐字相同；旧 `tools[].detail`、`outputs`、`attachments` 的内容引用集合等于 `content_refs`。
- 可续跑：`format<14` 的对话就是没转完的；任何时刻被杀，重启继续，已转的不重做；id 与 seq 确定，重做得同样的行。新服务启动时在开始监听之前转完（`node:sqlite` 是同步的），进度写日志。
- 失败：单个对话转不了，保留它的旧快照在原行，记 `last_error`，其余照常转；界面列为“无法转换”，可导出原始 JSON。整体失败（磁盘满等）停在未完成态，重启续跑。回退 = 按 ADR-049 恢复备份；旧构建遇 v14 拒绝启动（`sqlite-store.ts:569`），库不被改动。
- 规模：4317 的库有多大我不知道，所以按对话逐个事务，内存只受单个对话大小所限，与库总大小无关；峰值磁盘约为库加备份加单个对话的新旧两份。耗时未实测。
- 对第 1 步读侧投影（`src/contexts/session/domain/protocol/`）的要求：①全函数，对任何合法 v13 数据不抛；②确定：id、seq、块切分只由输入决定；③不丢内容，逐字；④保留所有内容引用；⑤旧回合没有先后信息，顺序固定为：用户消息、思考、工具（旧数组序）、plan、通知、活动、产物、助手文字，并置 `legacy_order=1`，不当成观察到的先后；⑥回合级事实（selection、backend、cleanup、error、timing、relay…）原样进 `run_json`；⑦纯函数，不读时钟与存储；⑧能逐回合产出，不要求整个对话同时在内存。
- 可选增强（后做）：用事件日志回放恢复真实先后与审批（`run.output` 窗口与工具事件按 seq 保序，`permission.*` 有请求与决定），与旧文字逐字核对，对不上就退回上面的固定顺序。

### 3.7 限制的处置（我们设的）

| 限制（出处） | 处置 |
|---|---|
| 回合 256、命令 1024、排队 8（`state.ts:14-16`） | 去掉；回合与命令只按主键，排队只是 `queued` 行 |
| 用户输入 64 KiB、请求体 128 KiB（`state.ts:17`，`server.ts:45`） | 去掉对内容的限制；请求体改流式接收（第三段） |
| 回复与思考 1 MiB，超了回合以 `OUTPUT_LIMIT` 失败（`state.ts:18`，`runtime.ts:1410-1413,1436,1440`） | 去掉；文字分块 |
| 会话 8 MiB、事件 16384 条、32 MiB、2 MiB（`state.ts:20-23`）；读 8 MiB、响应 8 MiB（`state.ts:24`，`server.ts:46`）；快照缓存 96 MiB（`snapshot-cache.ts:4`） | 去掉（对话不再是一份 JSON）；缓存删除 |
| 工具 128、通知 32、活动 64、plan 64 项、产物 32（`state.ts:27-30`，`content.ts:12`） | 去掉；静默丢弃（`runtime.ts:1313,1327-1328,1488`）一并删 |
| 工具输入 16 KiB、输出 64 KiB、diff 64 KiB（`control.ts:73-75`，`runtime.ts:112-122`）；Codex 与 OpenClaw 自己的截尾（`codex.ts:92`，`openclaw.ts:159`） | 去掉，存全文，按范围读；Driver 把原生给的内容原样交上来 |
| 分支历史 512 条或 1 MiB、导入 200 条或 512 KiB（`state.ts:33,294`，`runtime.ts:151`） | 去掉；分支引用，导入全存 |
| 附件 8 个、单项 20 MiB、每轮 32 MiB，内容库 4 GiB、26 万条（`content.ts:8-11`，`content-store.ts:11-12`） | 去掉常量；真正的限制是磁盘空间与目标 Harness 能不能收（派发前按能力检查，ADR-023），写不下时如实失败 |
| relay 契约里的 seq ≤ 16384、回合 < 256（`relay.ts:24-26`）及各解析器 | 放开到安全整数 |
| relay 每对话 64 MiB 交接单正文（`relay.ts:39`，`relay-tables.ts:156`） | 这是派生数据：超了淘汰最旧的已送达正文，不再拒绝（现在超了就退成只发原话，长对话会悄悄失去交接） |

仍然存在、但不是我们设的限制：①模型上下文窗口与各 Harness 自己的输入限制（relay 的预算由窗口推出，`windows.ts`），超了由 Harness 报错，Hub 如实显示；②SQLite 自身：单个值约 1e9 字节（文字分块，远低于它）、数据库大小、64 位整数；V8 单个字符串约 5e8 字符（导出与全文读取都流式或范围读）；磁盘空间；③对 Harness 子进程的守护：单帧 16 MiB、一条连接累计 256 MiB（`json-rpc-process.ts:162-164`），并行对话 4（`session.ts:412`）、同时待处理的审批 32（`runtime.ts:1289`）、执行与等待预算（ADR-036）、保留进程 4 个——这是资源守护，不是对话大小，超了回合如实失败，不静默截断；④单次传输的页大小（3.4）。

### 3.8 分段上线

格式在第一段定稿，之后只改代码。①第一段：新表、迁移、条目为唯一记录、界面读分页与增量帧；运行时仍把整个对话装进内存归约，经一个过渡层读写这些表（提交只写变更的行，不再整份重写）。这一段结束时上限常量都已去掉、提交成本不再随历史增长，但超大对话的内存与启动时间还要等第二段。②第二段：运行时改成只持有头加活动回合，接力读者改查询，分支引用、启动与回收按索引，过渡层删除。③第三段：长回合的体验与收尾（折叠占位、范围读取、FTS、请求体流式、Driver 截断）。分工与测试见计划。

## 四、否决的方案

- 只去掉常量、仍存整份快照：提交成本随对话增长，校验是平方的，内存随对话增长（第一节）。
- 双写旧字段、保留每轮上限（初稿）：所有者否决。
- 把条目只放在事件日志里（纯事件溯源）：读一个回合要扫事件、按 JSON 路径建索引，事件永远不能修剪，文字重复存两份。
- 照搬 T3 修剪事件：我们的事件已轻，修剪省不了多少，反而丢掉顺序证据；等没有读者依赖事件后再议。
- 文字放 `items` 的一列、追加时重写：长思考每个窗口重写整段，是平方的；分块表追加是常数。
- 文字放内容库（文件）：每个窗口一次文件写加内容库一次提交（实测约 8 ms/条，`docs/contracts/storage-events.md:211`），提交不再是一个事务，崩溃时行与文件会不一致。
- 位置打包成 `回合×1,000,000+n`（T3）：给每回合埋下 999,999 的上限。
- 一个事务迁移全部：库大小未知，长时间持有写锁，WAL 巨大，中途失败不可续跑。
- 像 T3 那样旧对话懒转换：旧快照与新表长期并存，读者要两套；所有者要一次性。

## 五、需要所有者点头

什么时候升级 4317 的真实数据。推荐：第一段（新表、迁移、界面读新表）在新数据根上用真实 Claude Code 与 Codex 跑通、合成的多版本夹具与大对话夹具迁移通过、独立审查通过之后，由你点头再升；升级前自动备份并检查空闲空间不少于库的两倍。理由：格式只升这一次，之后的阶段只改代码；升级单向，旧构建打不开 v14。

## 六、独立审查清单

1. 迁移保真：校验各项（回合、文字逐字、内容引用、relay 状态）是否足够；`ended_seq`、`context_effect`、绑定谱系（epoch 增、floor 不降）是否原样；同一对话迁移前后，交接单与上下文桌的输出是否逐字相同（黄金夹具）。
2. 可续跑与失败：在随机时刻杀进程，重启后结果与不被杀一致；转换失败的对话保持旧快照、不影响其他；备份失败时库不变；空间不足时拒绝启动。
3. 不丢内容：文字块只追加（触发器）；终态回合不可改；内容回收器读 `content_refs`，所有引用都登记了；分支只引用且源被软删后仍可读；全仓库已无截断与拒绝（逐项对 3.7）。
4. 不谎报：收场表（`unknown` 没被当 `completed`）；`legacy_order` 没被当成观察到的先后；搜索短词退回扫描时说明；分页占位标出条数。
5. 重启恢复：未终结回合的部分索引覆盖所有状态；等待中的审批收成 `cancelled`；恢复与接力恢复（`sqlite-store.ts:725-747`）的交互；保留进程记录。
6. 事实顺序：变更集与事件在同一事务；发布在提交后；取消受理、后端停止、资源清理的行与事件仍分别可查且单调。
7. 并发与所有权：头行 `version` 比较并交换；`owner_generation`；SSE 的发布顺序与 `lastSeq`。
8. 旧库兼容：v1 到 v13 每一代夹具都能升到 v14；冻结的旧解析器没被新代码改动；旧构建拒绝 v14。
9. 性能预算：提交成本与历史长度无关（对 10 与 5,000 个回合的对话各测）；窗口字节有界；启动时间与对话数无关（有未完成回合的另算）。
10. 敏感输入：secret 回答不在行、事件、日志、`fingerprint` 里。

## 七、未确认

- 第 1 步读侧投影的函数名、签名与“逐回合产出”的形态（proto-core 未提交）。
- 4317 的库大小、对话数与最长对话；迁移耗时与峰值磁盘都是估算。
- 原型数字只来自合成数据与我的机器（表形状、索引与提交成本），未含 FTS 维护、触发器的开销与迁移。
- 前端哪些逻辑依赖“整个对话在内存”（显示节奏缓冲、详情栏各页，审计 C.7、D.12.2）：归 proto-web 判断，本文没读渲染代码。
- `cli/chat.ts`、管理侧对回合数的读取没有逐行读过，按“读行”处理。
- T3 的客户端虚拟列表只读了 `MessagesTimeline.tsx` 的属性，没有运行。
