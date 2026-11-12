# 第 2 步实施计划（第三版）：对话改存表，条目为唯一记录

对应 [ADR-057](../../decisions/0057-ordered-turn-items.md)（第三稿，proposed）；依据[独立审查](../../research/store-review-2026-11-12.md)与[上限清点](../../research/limits-audit-2026-11-12.md)。各线用各的 worktree 与分支，合并前对齐。AGENTS.md 的底线都适用：提交前 `pnpm check`、`pnpm test`，动了界面再 `pnpm test:web`；汇报分“代码完成、合成测试通过、真机通过”；升级 4317 与动真实数据先问用户；测试用临时数据根，不复制真实数据。接缝已写好：类型 `src/contracts/conversation.ts`、`web.ts` 的 v14 类型、SQL `src/infrastructure/session/schema-v14.ts` 与 `tests/integration/schema-v14.test.ts`；除 `protocol.ts` 的几个可选字段外不改任何现有行为。

## 一、规模与风险

- 不是加一个字段，是换对话的存法与读法。对话相关源码约 1.28 万行（`runtime.ts` 2,258、`sqlite-store.ts` 902、`state.ts` 614、接力约 3,060、`server.ts` 1,197）；估计实质改动 5,000–6,000 行、新写约 3,000 行；直接构造或解析快照的测试文件 24 个、读旧字段的约 80 个（多为顺带提到），估计 25–35 个要真改；前端约 12 个文件。人力（估算，未验证）：第 1 步八项并行 3–4 周，切换点 1–2 周（一个人），C 与 D 并行 3–4 周，第二段 6–8 周。
- 原型证明表形状可行；真库上的断言已有 19 条（`schema-v14.test.ts`）：部分唯一索引、触发器、两张全文索引（含一两个汉字）、接力表重建都按设计工作。数字是合成数据，不替代预算测试。
- **最大三处风险**（审查第四节）：①切换点那一次合并（几千行同时变）加上转换的保真——安全网是往返性质（T3）和整份核对器（T8），两者必须在切换之前就有；②接力：水位的迁移规则（`ended_seq` 三级回落、命令回合与普通回合分开）、relay 上界跨段、绑定谱系，出错表现是悄悄重发或漏发；③迁移前后的启动与内容回收：唯一会不可逆删东西的地方，发生在所有者的真实数据上。

## 二、落地顺序（回答“运行时归约旧字段、表里存条目”这个矛盾）

**为什么不能“先换存储、后换运行时”**：运行时归约带旧字段的快照（`runtime.ts:1313-1345` 工具、通知、活动、plan；`:1433-1446` 文字），表里存条目。存储单独合并就要一个“表 ↔ 旧字段”的双向无损转换：旧字段装不下条目（交错的段、审批、先后），而写入方一改成条目它就整个扔掉，又与“旧字段不再写”矛盾。所以：**转换只发生一次、方向单一**（迁移，旧 → 条目，由往返性质证明无损）；运行时的内存形状在切换点换成条目；还没改的读者经 `fromItems` 适配器拿到旧形状（只读，条目 → 旧形状）。存储（A）与运行时写条目（B）因此在切换点合成一次合并；在它之前，两边都是不接线的纯新增。

1. **第 1 步 纯新增**（`CURRENT_VERSION` 仍是 13，运行时一行不改，只被测试调用；随时分别合并，八项真并行）：T1–T8，见第三节。
2. **第 2 步 切换点**（分支 `cc/s1-cut`，一个主刀，一次合并，分支内部测试会红）：见第三节 X。
3. **第 3 步 并行**：C（窗口、游标、增量帧、前端；开发在 T6 合并后即可开始，对着 T4 转出的库，合并在切换之后）；D（读者一个一个改读条目）。
4. **第 4 步 门**：真机、独立审查、所有者点头，再升 4317。

**测试什么时候允许不过**：集成分支任何时候全绿（含 `pnpm check`、`pnpm test`，动了界面再 `pnpm test:web`），第 1 步每项自带测试且不改现有行为。切换分支内部会红，由主刀负责在合并前让它们全绿，并每天并入集成分支的新提交。切换要改的测试（估算）：直接构造或解析快照的约 18 个 `.test.ts`（`session-store`、`snapshot-cache`（删）、`session-state`（旧解析移进 `legacy/`，另写新状态的）、`session-redaction`、`session-context`、`relay-store`、`relay-api`、`relay-flow`、`g063`、`web-session-stream`、`performance/*`…）和 `session-runtime.test.ts` 里断言上限的几处（工具 128，`:691-698`，改成无上限；`OUTPUT_LIMIT`，`:1079-1104`，留到 C 翻转）；读者的测试与黄金不改（经适配器）；协议与驱动测试不改。**去掉上限的顺序：消费者先于生产者**——relay 上界（T7）最先；页面解码与帧界随 C；服务端常量在切换点；回复与思考的 1 MiB 与帧界一起在 C 翻转时去掉。

## 三、任务说明

### 第 1 步的八项（每项一份，可单独派发；彼此只通过 `conversation.ts` 与 `schema-v14.ts` 的名字相接）

- **T1 冻结夹具**（先做）。造：`tests/fixtures/storage/v13/`，用现在的构建生成含事件日志的 v13 库，照 `tests/fixtures/relay/v12/` 的生成器；覆盖多 Harness 与换家、清空、分支（含附件）、导入、unknown 与恢复切换、保留进程、任务清单调用（有无 detail）、超长思考、含代理对/NUL/多字节超 4096 字节标题的外来文本、v1–v12 各代样本。不碰：一切 `src/`，不改版本号。依赖：无。完成：夹具提交后其他项才用；生成器可重跑。测试：夹具能被现在的 `SqliteSessionStore` 打开。
- **T2 表与行**。已有 `schema-v14.ts` 及测试。造：`src/infrastructure/session/rows.ts`（`ItemRow`、`RunRow`、`HeadRow`… ↔ 行）、`apply.ts`（`applyMutation(db, Mutation)`：按 `Mutation` 注释里的顺序写，`createdByEvent`、`userSeqByEvent`、`endedByEvent` 回填 seq）、`diff.ts`（`diffConversation(前, 后: Conversation) → Mutation`，按对象身份，只比未终结回合的条目与文字块）、`legacy/`（冻结拷贝：`state.ts` 的整份解析、`relay/migrate.ts`、`relay.ts` 里带旧上界的解析器；必须拷贝不是移动）。不碰：`sqlite-store.ts`、`runtime.ts`、`state.ts` 本体。依赖：`Mutation`、`Conversation`、`schemaV14Statements`。完成/测试：对临时库 `diff → apply → 读回` 相等；`legacy/` 与现行解析器在同一夹具上结果相同；提交成本与历史长度无关（10 与 5,000 回合差不超 2 倍）；`verify`（T8）每次 `apply` 后为空。
- **T3 存储转换**（保真的核心）。造：`src/contexts/session/domain/store-conversion.ts` 的 `toItems`/`fromItems`（`StorageConversion`、`ConvertedRun`）。`toItems(旧 Run + 它的消息, at)`：用户文字与助手文字进 `HeldItem.text`，工具/活动/通知/plan/产物各成条目并存全部原生事实（`NativeFacts`）、任务清单调用成行、思考不截、`RunFacts` 存其余（`usage` 原值）、固定顺序加 `legacyOrder`、`ContentRefRow` 登记所有引用（含显示投影会丢的）；助手消息的 `createdSeq` = 消息的 seq。不碰：`protocol/` 里的显示投影。依赖：T1、`ItemFields`、`NativeFacts`。测试（`tests/property/store-conversion.test.ts`）：全函数；确定；`fromItems(toItems(x))` 深相等于 `x`（夹具加随机生成，含 NUL、代理对、空标题）；`toItems` 不读时钟与存储；所有内容引用都出现在 `ContentRefRow`。
- **T4 迁移引擎**。造：`src/infrastructure/session/migrate-v14.ts`：第一个事务（老阶梯、`RELAY_V14_REBUILD` 按 `foreign_keys=OFF` 的做法、`SESSIONS_V13_TO_V14`、建表、置 14）与逐对话转换（读旧快照与 `MIGRATION_EVENTS` → `toItems` → `applyMutation` → `ended_seq` 三级回落、`isCommand` 与效果、`acknowledgedBy` 物化、`origin_history`（现有分支原样，`kind='fork'`）、`content_refs`）；校验 = 从表用 T6 的读函数读回、`fromItems` 深相等、每绑定旧 `ledger.facts()` 与新查询相同、`verify`、引用集合相等。只被测试调用。不碰：`sqlite-store.ts`。依赖：T1–T3、T6、T8。完成/测试：夹具全转；`kill -9` 随机时刻续跑结果与不被杀一致（照 `tests/fixtures/session-store-peer.mjs`）；改坏一行则停下并说明（`last_error`）；备份失败库不变；空间不足拒绝；全文索引不写。
- **T5 放条目**。造：`src/contexts/session/domain/items-place.ts`：对 `ActiveTurn`（回合行、`nextSeq`、未终结条目与开着的段、当前窗口）的纯归约 `place(turn, 原生事件) → { turn, changes: Mutation 的一部分 }`；分段与身份（ADR 3.2 的 `ItemId`）、收场、审批与提问（secret 不落盘）、外来数据规整（NUL、孤立代理、空标签、越界数字，记 `native.clipped`）、窗口在码点处分块。不碰：`runtime.ts`、存储。依赖：`HeldItem`、`ItemFields`、`ControlEvent`。测试：回放 `tests/fixtures/protocol/trial-2026-11-11.json` 五家真实事件，条目多重集合与 `projectTurn` 一致（次序按真实先后）；5,000 个工具、2 MiB 回复、200 条通知、含 NUL 与多字节超 4096 字节的标题都不丢不拒不抛；收场表每格一例。
- **T6 读函数与帧**。造：`src/infrastructure/session/read.ts`（`ConversationReader`：`head`/`window`/`older`/`turnAt`/`items`/`text`/`search`，加 `list`、`startupSamples`、`unfinished`、`nativeOwners`、`contentReferences`）与 `src/web/commit-frame.ts`（`commitFrame(ConversationCommit.changes, head) → SessionCommitFrame` 的纯函数；超 `PAGE.itemInlineBytes` 的文字与别的长主体打 `bodyOmitted`、`textBytes`）。不碰：`server.ts`。依赖：T2 的行、`TurnWindow`、`SessionCommitFrame`。测试（对 T4 转出的库）：窗口字节有界（至少一个回合除外）、游标在新回合到来后仍对、2,000 回合、20 MiB 单条文字省略并可按字节范围取（码点边界）、`deferredWork`、搜索（三类词，含一两个汉字）、`text` 帧偏移、列表游标。
- **T7 relay 上界**（最先合并）。改：`contracts/relay.ts`（`RELAY_MAX_SEQ`、`RELAY_MAX_RUNS` 与各解析器放开到安全整数；清单 `runs` 超长存区间）、`relay-coordinator.ts:335,345` 的 `slice(0, RELAY_MAX_RUNS)`（现静默只列前 256 个）、`relay-tables.ts` 的相应检查。不碰：表结构。依赖：无。完成/测试：解析器接受原来的超集（v13 数据不变）；`tests/unit/relay-contract.test.ts:55` 的断言改写；`tests/property/relay-*.test.ts` 用 300 回合、20,000 条事件的对话重跑。
- **T8 整份核对器**。造：`src/contexts/session/domain/conversation-verify.ts` 的 `verify: VerifyConversation`（ADR 3.3 不变量表里写着 `verify` 的各行，旧 `parseSession` 的关系检查搬到行上，用映射代替两层互找；返回 `Violation[]`）。不碰：生产的提交路径。依赖：`Conversation`、`ConversationReader`。完成/测试：对夹具转出的对话为空；对故意改坏的每条各报对应 `rule`；维护命令入口可后做。

### X 切换点（一个分支 `cc/s1-cut`，一个主刀）

- **改（必须同时）**：`contracts/session.ts`（内存形状 `Conversation`、`SessionStore` → `ConversationStore`）、`state.ts`（整份解析换成行级校验 + 对改动行的提交时检查，旧的移进 `legacy/`）、`runtime.ts`（输出、文字窗口、审批、收场、`send`、`fork`、恢复各路径改用 T5 写条目；`commit()` 的 `catch` 只对存储、所有权、版本失败调 `fail()`，`INVALID_DATA`、`INVALID_TRANSITION`、`*_LIMIT` 只结束那个回合或请求；去掉静默丢弃与除回复/思考 1 MiB 外的常量）、`sqlite-store.ts`（含删 `snapshot-cache.ts`：启动顺序、`get`、`transact` = `diffConversation` + `applyMutation`、`list`、`listKept`、`nativeOwners`、`contentReferences`、`deleteSession` = 软删并归档绑定、`CURRENT_VERSION=14`、接上 T4/T6）、`relay-tables.ts` 里收整份快照的三个函数（`checkRelayRows`、`checkPacketReferences`、`readDeliveries`）、`relay/recover.ts`、`cli/session-application.ts`（回收入口：有未转换行不回收、全库比对、头一次启动只报告）、`relay-coordinator.ts` 的 `RelayLedger`（改读 `runs` 列）。`server.ts` 的 `view()` 与 `protocol-view.ts` 最小改：线上形状不变，回合由存下的条目装出（`DetailHeads` 与每视图 400 次详情读取随之删）；其余读者（接力叙述与协调、上下文桌、导出）经 `ConversationStore.snapshot()`（`fromItems` 适配器）拿旧形状，黄金输出不变。
- 不碰：`web/`、其余读者、驱动。依赖：T1–T8 全部合并。完成：`pnpm check`、`pnpm test`、`pnpm test:web` 全绿；转换后的夹具上，交接单、上下文桌、导出与切换前逐字相同；启动恢复走部分索引、列表读列（提到这一步）；一个含 NUL、多字节、超 4096 字节标题的工具调用被规整并记账、运行时不停；真机见第五节。测试：预算——提交耗时对 10 与 5,000 回合差不超 2 倍，一万回合对话的启动耗时与常驻内存有记录；`session-runtime.test.ts` 经 fake 驱动跑全程。

### C 窗口、游标、增量帧、前端（切换之后合并）

- 改：`src/web/server.ts`（整个文件归 C：`view()` 改 `SessionViewV14`、新路由 `GET …/turns`（`TurnPageView`）、`…/runs/:ordinal/items`（`RunItemsPageView`）、`…/items/:seq`（`ItemView`）、`…/items/:seq/text`（`ItemTextView`）、内容字节范围、对话列表游标（`SessionListView`），去掉 100 与 8 MiB 聚合；请求体流式不在此）、`src/web/session-stream.ts`（一次提交一个 `SessionCommitFrame`，运行时 `publish` 改按提交）、`web/src/api.ts` 与 `session-stream.ts`（解码 v14；**去掉镜像的上界**：`api.ts:366-370,395-396`、`session-stream.ts:208`、`decode.ts:71,85,135` 的 4096/1024/128/16/8、对话列表 `slice(0, 1000)`）、`ChatPage.tsx`（按窗口里的回合画，不再循环 `messages`；`message(id)` 用条目里的 `text` 建）、`DetailsPanel.tsx`、`Turn.tsx` 旧路径、`lib/turn.ts`、`notify.ts`、`decode.ts`（新字段 `text`、`bodyOmitted`、`textBytes`、`secret`、`forItem`、`priority`、`legacyOrder`）。**同一段落地：去掉回复与思考的 1 MiB 与帧界**。不碰：存储、运行时、领域层；渲染器 `ProtocolTurn.tsx` 不重写，与页面一线（proto-web）对齐。依赖：T6、切换点。
- 完成：打开 2,000 回合与含 20 MiB 单条回复的对话只取窗口；上滑取更早页并保位；流式只收 `commit` 帧；`text` 帧偏移对不上就重取快照；重连先 `snapshot`。测试：`tests/browser/web.browser.ts` 加 2,000 回合夹具（首屏、上滑、发消息、重连）；服务端路由与帧的集成测试。

### D 读者一个一个改读条目（切换之后并行）

- 改：`relay/narration.ts`、`relay/packet.ts`、`context.ts`、`relay-coordinator.ts` 的叙述与渲染（从新到旧分批取到预算为止）、`table.ts`、`web/table-routes.ts`、`cli/hub-tools.ts`（搜索带偏移与两张全文索引）、`web/conversation-export.ts`（逐回合流式写出）、`web/run-diagnostics.ts`、`cli/sessions.ts`（只读读者认得迁移中途版本 14 里 13 与 14 混着的库）、`cli/chat.ts`。上下文桌、`hub_read_turn`、导出要说明 `legacyOrder`。不碰：存储实现、`server.ts` 本体。依赖：切换点、`ConversationReader`。
- 完成/测试：每改一个读者一次提交，对一次黄金（`tests/fixtures/relay/golden` 与各自的），逐字相同或带评审过的差异；最后删适配器与 `ConversationStore.snapshot()`。

### 第二、三段（门之后；细节届时再写）

- **E** 端口换成 `ConversationTx`、内存只留头与活动回合、删适配器与轻行数组（一个人）；**F** 接力读者改查询（欠的回合、清单区间）；**G** 分支引用、导入全存、启动按索引；**H** 折叠占位、全文索引回填（`derived`）、请求体流式、驱动截断（`codex.ts:92`、`openclaw.ts:159`）、驱动边收边写（每个已完成的工具现在一个内容库文件，约 8.2 ms，`docs/contracts/storage-events.md:211`）、传输预算测试进 `pnpm test`。

## 四、迁移对读侧投影的八条要求：对照 `project.ts` 的实际代码

| 要求（ADR 初稿 3.6） | 结论 | 出处 |
|---|---|---|
| ① 全函数 | 基本是：只有越界下标抛 `RangeError`；“合法 v13 数据不抛”没有性质测试 | `project.ts:110` |
| ② 确定 | **否**：结果取决于那一刻读不读得到详情文件（每视图最多 400 个，读不到的“按标题讲”，命令与路径因此空）和目录里的显示名 | `protocol-view.ts:26,41-58`；`project.ts:57-60` |
| ③ 不丢内容 | **否**：思考截到 64 KiB；标签截到 1000 字符；输入只读头 4096、文件列表 ≤64、位置 ≤16；任务清单调用不成行；同 id 的 subagent/task 活动去重；有 `run.error` 时 error 通知整条丢；subagent、task、compaction 的活动 `detail` 丢；链接产物的 `name`、`mediaType` 丢；>64 步的任务清单退回成工具行；条目只有 `messageId`，消息文字、附件无处安放；`turnUsage` 对 dsh、Hermes 没有数字 | `project.ts:41,121,128-135,137-141,146-151,139,176,171,117,163`；`tools.ts:106-108,117-118,122,238`；`changes.ts:58`；`usage.ts:44-54` |
| ④ 保留所有内容引用 | **否**：任务清单调用的 `detail` 随行丢；`origin.history` 的附件不在 | 同上 |
| ⑤ 顺序固定 | 代码的次序与 ADR 初稿写的不同（…通知、retry/review、回复、错误、产物、压缩），id 是 `hh:user`、`hh:reply`、裸工具 id，不是 ADR 3.2 的一套 | `project.ts:116-179` |
| ⑥ 回合级事实进 `run_json` | 投影不产出；迁移直接从 `PublicRun` 写 | |
| ⑦ 纯 | 给定 `env` 是；`env.detail` 同步读存储（“blocks while the file is read”） | `protocol-view.ts:79-83` |
| ⑧ 逐回合产出 | **否**：`projectTurn(input, index)` 要整个 `runs`；对每个回合在 `messages` 里线性找，整体平方 | `project.ts:44-48,108-116,120,162` |

**结论：迁移不直接用它，也不另做一个“不设上限的变体”**（要改的点遍及 `project.ts`、`tools.ts`、`changes.ts`，改完仍是显示投影）。另写存储转换 `toItems`/`fromItems`（T3），保真校验是往返相等。投影自己的 64 KiB、400 次详情读取、页面解码 4096 随 C 与切换点一并删。

## 五、测试与真机

- 属性与夹具：T3 往返；T4 夹具全转、杀进程续跑、改坏一行则停；T5 回放五家真实事件；T8 核对器。预算（照 T3 Code 的传输预算测试）：提交耗时对 10 与 5,000 回合、窗口字节、20 MiB 单条回复、一万回合启动。读者黄金（`tests/fixtures/relay/golden`）切换前后逐字相同。
- 真机（临时数据根与临时工作区，起的不是 4317；新写 `tests/real/native-items.real.ts`，照 `native-activity.real.ts` 与 `guard.ts`，`HH_REAL_HARNESSES=claude,codex`，Claude 用 haiku）：①边说边做的真实回合（先说一句、跑命令、读文件、再总结），条目先后对、文字完整、命令有终态；②批准与拒绝各一次，决定留痕，等待中杀掉应用再开，审批 `cancelled`、Run `unknown`、已有文字还在；③合成多版本根升到 v14，迁移中 `kill -9` 续跑，旧回合读得出，头一次启动回收只报告；④2,000 回合在浏览器里打开、上滑、边流式边上滑；⑤含 20 MiB 单条回复与命令输出的对话；⑥一万回合对话的启动耗时与常驻内存；⑦约 200 回合的真实长对话换家，交接单与黄金一致；⑧30 分钟会话内存不随历史增长（第二段后）。
- 验证不了的先写明：secret 提问（要 Codex 触发 `isSecret`，只在合成测试里验）；4317 的升级（要所有者点头，也不复制其数据做试验）。

## 六、读者对账：上限清点第 5 节 × ADR 3.3 的读者表

5.1 整份重写、5.2 整份校验、5.3 事件、5.5 启动与列表 O(全部)、5.7 每视图读详情：已覆盖。**对账补进 ADR 的**：对话列表的游标与 8 MiB 聚合（A30，5.5）、读回工具搜索偏移与一次请求读详情的界（A34）、接力清单 `slice(0, 256)` 静默只列前 256 个（5.9）、通知去重要整个对话的指纹（I10）、事件的四处读者（I9）、SSE 每事件重建整份视图（5.4，现在一次提交一个帧）。**另归别处**：5.8 页面镜像上限归 C；5.6 工具详情一件一文件归 H；5.10 单帧与入站拼帧、5.11 时间预算与并行归另一条先做的线（不依赖存储）。

## 七、读代码时发现的几处

- 协议类型缺的字段已作为可选字段加进 `protocol.ts`（`UserMessageItem.text`、`AssistantMessageItem.text`、`ItemBase.bodyOmitted`、`ItemBase.textBytes`、`QuestionItem.secret`、`ApprovalItem.forItem`、`PlanStep.priority`、`ProtocolTurn.legacyOrder`）；Codex 的审批带 `toolId`（`codex.ts:973,979`）、ACP 带 `toolCallId`（`acp.ts:994`），归一时填 `forItem`。
- Driver 丢了消息身份（`codex.ts:838-845`，`acp.ts:877`）：相邻两条原生消息合成一段。建议 `text` 事件加可选 `messageId`，Codex 先做。
- 回合结束时还开着的动作：Claude 前台命令一直报 pending，OpenClaw 补记没结果也写 completed（`openclaw.ts:162`）。收场表写 `unknown`，OpenClaw 在第 1 步改成未知。
- 清空与原生命令的上下文效果只在事件里（`control.ts:139-145`，`runtime.ts:1896-1900`）：写进 `runs` 的效果列与条目。

## 八、未确认

- 4317 的库大小、对话数、最长对话、现有分支与任务清单调用的数量；迁移耗时与峰值磁盘。
- 第 1 步合并后页面一线（proto-web）在做的改动是否与 C 重叠（`Turn.tsx` 旧路径、`ChatPage.tsx` 的 `messages` 循环）。
- 审查的内存与耗时估算（“一万回合约十兆、每次提交几十微秒”）、人力与周数都是估算；`runtime.ts` 的结算、取消排队输入、导入路径审查与我都没逐行读完。
