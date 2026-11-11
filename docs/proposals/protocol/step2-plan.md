# 第 2 步实施计划（重排）：对话改存表，条目为唯一记录

对应 [ADR-057](../../decisions/0057-ordered-turn-items.md)（重写，proposed）。各线用各的 worktree 与分支，合并前对齐。AGENTS.md 的底线都适用：提交前 `pnpm check`、`pnpm test`，动了界面再 `pnpm test:web`；汇报分“代码完成、合成测试通过、真机通过”；升级 4317 与动真实数据先问用户；测试一律用临时数据根，不复制真实数据。

## 规模评估（老实说）

- 这不是加一个字段，是换对话的存法与读法。对话相关源码约 1.28 万行（存储、状态机、运行时、接力、网页服务、导出、上下文桌、CLI；`wc -l` 计），其中 `runtime.ts` 2,258、`sqlite-store.ts` 902、`state.ts` 614、接力约 3,060、`server.ts` 1,197。估计要实质改动 5,000–6,000 行，新写约 3,000 行（表与迁移、行编解码、分页读、变更集、过渡层）。
- 94 个测试文件命中会话、回合、快照相关的关键字（含少量无关命中），估计约一半要改写；前端约 10 个文件（`web/src/api.ts` 982 行、`session-stream.ts`、`Turn.tsx`、`ChatPage.tsx`…）。
- 人力（估算，未验证）：第一段 4–6 周（两到三人并行）；第二段 6–8 周（运行时重构是窄路，基本一个人）；第三段 2–3 周。第一段结束才第一次能给所有者真机试；第二段结束才算真正没有上限。
- 原型已证明表形状可行（40 万条目：取最近 10 回合 0.33 ms，一个文字窗口提交 0.11 ms，旧做法 4 MiB 整份重写 11.5 ms），但那是合成数据、没有触发器与 FTS 的开销，不替代第一段的预算测试。

## 最大三处风险

1. **不可逆迁移与保真。** 4317 是真实数据，十三代格式叠出来的库；漏掉或改写内容、接力水位（`ended_seq`、`context_effect`、绑定谱系）转错（之后交接会重发或漏发）、旧回合的先后是推测的。缓解：先冻结 v1–v13 夹具（含事件日志）再动手；逐对话校验（文字逐字、内容引用集合）；杀进程续跑的性质测试；迁移前后交接单与上下文桌输出逐字相同；失败的对话隔离；自动备份；独立审查；所有者点头才升 4317。
2. **状态机与接力对“整份历史”的隐含依赖。** `parseSession` 的两层互找（`state.ts:423-442`）、`RelayLedger` 扫全日志（`relay-coordinator.ts:114-137`）、relay 契约写死的 16384 与 256（`relay.ts:24-26`）、`fork` 复制历史（`runtime.ts:543-580`）、`switch.sourceRunIds`、启动读遍所有对话（`sqlite-store.ts:707-715`）、回收读遍所有快照（`:376-392`）。漏掉一处，就在某个长度悄悄出错或变慢，而且都属于“会不会丢内容、谎不谎报”的逻辑。缓解：ADR 3.3 的读者表逐项对账；`tests/property/relay-*.test.ts` 在行读取上重跑；“提交成本与历史长度无关”的预算测试；第二段运行时只由一个人改；独立审查。
3. **界面与 API 的断层，分页的正确性与性能。** 界面从整份替换改成窗口加游标加增量帧；前插保位、游标、重连、超长回合都是新东西；最大的坑是和 proto-web 第 1 步的线上形状对不上。缓解：先把新 `SessionView` 写进契约文档并和 proto-web 对齐再动手；2,000 回合合成对话的浏览器测试；传输预算测试。

## 分段上线顺序

1. **第一段（格式定稿，4317 只升这一次）**：A 表与迁移 → B 运行时写条目 → C 分页读与帧、D 读者切换并行 → 门：真机、独立审查、所有者点头。结束时：条目是唯一记录，所有常量上限去掉，提交只写变更的行，界面读窗口与增量；运行时仍把整个对话装进内存，经过渡层读写表。
2. **第二段（运行时只持有头加活动回合）**：E 端口与运行时 → F 接力读者改查询、G 分支导入删除启动回收 → 门：独立审查。结束时：内存与启动时间与对话数、对话长度无关，过渡层删除，格式不变。
3. **第三段（收尾）**：H 长回合体验与剩余上限（折叠占位、范围读取、FTS、请求体流式、Driver 截断）。

## 工作流

### 线 A 表与迁移（第一段，最先）
- 改：`src/infrastructure/session/` 新增 `schema.ts`（DDL、部分索引、触发器）、`rows.ts`（行与对象互转）、`migrate-v14.ts`（逐对话转换，续跑）、`legacy/`（冻结 `state.ts` 的整份解析、`relay/migrate.ts` 与 `relay.ts` 里带旧上界的解析器，供 v1–v13 阶梯与转换使用）；`sqlite-store.ts` 改成过渡层（`get()` 从表装出现在的对话并缓存，`transact()` 只写变更的行；沿用 `SessionStore` 端口）；`src/contracts/session.ts`（`RunRow`、`ItemRow`、页类型）；`docs/contracts/storage-events.md`。
- 不碰：`runtime.ts`、`src/web/`、`web/`。
- 先做的一步：在改版本号之前，用现在的构建生成冻结夹具，含每个对话的事件日志（照 `tests/fixtures/relay/v12/` 的生成器与读法），放 `tests/fixtures/storage/v13/`，提交后再升版本。
- 完成：v1–v13 夹具都升到 v14 且校验全过；随机杀进程续跑；旧构建拒绝；备份失败则不迁移；`pnpm check`、`pnpm test` 通过。

### 线 B 运行时写条目（第一段，A 的行类型合并后）
- 改：`runtime.ts` 的输出、审批、收场路径改写条目（新文件 `src/contexts/session/domain/items-place.ts`：放条目、关段、收场）；`state.ts` 的整份解析换成行级校验，删两层互找；`runtime.ts:112-122` 去掉详情截断，`:1410-1440` 去掉 `OUTPUT_LIMIT`，`:1313,1327-1328,1488` 去掉静默丢弃，`:263` 的指纹不含 secret；`recoverSession` 只处理未终结回合。
- 不碰：存储实现、`src/web/`。依赖：A 的行类型与过渡层；第 1 步的归一模块（事件加已有条目得到条目更新，含 id；审批选项得到角色）。
- 完成：ADR 3.2 的规则都有测试；旧字段不再写；对话里放 5,000 个工具、2 MiB 回复、200 条通知都不丢不拒。

### 线 C 分页读、帧、前端（第一段，A 的读函数合并后）
- 改：`src/web/server.ts`（`view()`、`/state`、新路由，整个文件归 C）、`src/web/session-stream.ts`、`src/contracts/web.ts`、`web/src/api.ts`、`web/src/session-stream.ts`、界面数据入口（proto-web 的渲染不重做）、`docs/contracts/public-api.md`。
- 不碰：存储、运行时、领域层。依赖：A 的 `readWindow`、`readOlder`、`readItems`、`readText`；proto-web 的线上形状。
- 完成：打开 2,000 回合的对话只取窗口；上滑取更早页并保位；流式只收增量帧；重连先收 `snapshot`。

### 线 D 读者切换（第一段）
- 改：`src/web/conversation-export.ts`、`src/contexts/session/domain/table.ts`、`src/web/table-routes.ts`、`src/cli/hub-tools.ts`、`src/web/run-diagnostics.ts`、`src/cli/sessions.ts`、`src/cli/chat.ts`、`relay/narration.ts`、`relay/packet.ts`、`context.ts`（读条目，不再读旧字段）；`summary`、`readinessViews` 由 D 给纯函数，C 调用。
- 不碰：`server.ts` 本体、存储、运行时。完成：同一对话迁移前后，导出、上下文桌、交接单的黄金输出相同（交接单逐字）。

### 线 E 端口与运行时（第二段，一个人）
- 改：`src/contracts/session.ts`（`SessionStore` 换成 `ConversationStore`：`transact(id, expectedVersion, mutate: (tx) => Mutation)`，ADR 3.3）、`sqlite-store.ts`（变更集写入，删过渡层与 `snapshot-cache.ts`）、`runtime.ts` 全部 `load()` 与 `state.runs…` 的位置（约 54 处 `.runs`、数十处 `.messages`、`.commands`、`.switches`）、`state.ts`、`session-application.ts`。
- 完成：提交成本与历史长度无关；内存不随历史增长；`pnpm test` 全过。

### 线 F 接力读者改查询（第二段，E 的端口合并后）
- 改：`relay-coordinator.ts`（`needRuns`、`rangeOf`、`facts`、`renderView`、`packetManifest`；删 `RelayLedger` 扫描）、`relay/*.ts`（渲染从新到旧分批取）、`relay-tables.ts`（索引；正文配额改淘汰）、`contracts/relay.ts`（放开 16384 与 256；`relay_index.run_index` 与清单里的回合下标改用回合序号）；调用点由 E 接线。
- 完成：`tests/property/relay-*.test.ts`、`tests/integration/relay-*.test.ts` 在行读取上全过；黄金交接单不变。

### 线 G 分支、导入、删除、启动、回收（第二段）
- 改：`runtime.fork`、`importOwned`、`closeSession`、`deleteSession`（软删）、`origin` 与 `origin_history`、`content_refs` 驱动的回收（`content-store.ts` 的 `collect`）、启动恢复按部分索引、`nativeOwners`、`listKept`。
- 完成：分支超长对话成功；源被软删后分支仍可读；启动时间与对话数无关。

### 线 H 收尾（第三段）
- 改：`deferredWork` 折叠、范围读取路由、FTS5 触发与回退、请求体流式（`server.ts:45`）、内容库去上限（`content-store.ts:11-12`）、Driver 截断（`codex.ts:92`、`openclaw.ts:159`）、传输预算测试进 `pnpm test`。

## 测试（够用即可）

- 迁移：每代夹具一份；校验失败注入（改坏一行，该对话被隔离、其余转完）；随机杀进程续跑与不被杀结果一致；备份失败库不变；`user_version=15` 模拟旧程序被拒；表结构文本与预期一致。
- 表的性质：两个活动回合被拒；一个原生会话被两个对话持有被拒；终态回合与文字块不可改；`(run_id, item_id)` 唯一。
- 运行时（用现有的“测试自己演的程序”，`tests/integration/session-runtime.test.ts`）：分段、身份、收场、审批、secret 不落盘（对行、事件、指纹搜原文与其 SHA-256）、无上限（5,000 工具、2 MiB 回复、200 条通知）、重启恢复。
- 读：窗口字节有界（至少一个回合除外）、游标在新回合到来后仍对、超长单回合分页、`deferredWork`；SSE 增量无缺口、先 `snapshot`；解码；2,000 回合合成对话的浏览器测试（`tests/browser/web.browser.ts`：首屏、上滑、发消息、重连）。
- 读者：导出、上下文桌、搜索（含短词回退）、交接单黄金夹具（`tests/fixtures/relay/golden`）迁移前后相同。
- 预算（照 T3 的传输预算测试）：对 10 与 5,000 回合的对话各测提交耗时，差不超过 2 倍；启动用时与对话数无关。

## 真机要验证的

用临时数据根与临时工作区，起的不是 4317；新写 `tests/real/native-items.real.ts`（照 `tests/real/native-activity.real.ts` 与 `guard.ts`，`HH_REAL_HARNESSES=claude,codex`，Claude 用 haiku）。

第一段：
1. 边说边做：真实 Claude Code 与 Codex 各一个回合（先说一句、跑命令、读文件、再总结），条目先后对、文字完整、命令有终态。
2. 审批与提问：批准、拒绝各一次，决定留痕；等待中杀掉应用再开，审批 `cancelled`、Run `unknown`、已有文字还在。
3. 迁移：合成多版本根（含大对话夹具）升到 v14；迁移中 `kill -9`，重启续跑；旧回合在界面上读得出。
4. 分页：合成 2,000 回合的对话在浏览器里打开、上滑、边流式边上滑。

第二段：5. 约 200 回合的真实长对话，Claude Code→Codex→Claude Code 换家，交接单与重构前黄金一致；6. 30 分钟会话里记内存与 CPU，不随历史增长；7. 从第 N 回合分支、软删源、重启。
第三段：8. 20 MiB 以上的命令输出、10 MiB 的单条回复、5,000 工具的回合，全文存下并能按范围读。
验证不了的先写明：secret 提问（要 Codex 触发 `isSecret`，只在合成测试里验）；4317 的升级（要所有者点头，也不复制其数据做试验）。

## 读代码时发现、ADR 与设计稿之外的问题

1. **relay 契约写死了上限**：seq ≤ 16384、回合下标 < 256（`relay.ts:24-26,502-528,588-592`）。不放开，去掉会话上限后交接会在第 257 回合出错。建议：线 F 先做，所有解析器改成安全整数。
2. **`RelayLedger` 把事件日志当事实库**（`relay-coordinator.ts:114-137`，`runtime.ts:883,2043,2246`）。建议：`ended_seq`、`context_effect` 写进 `runs` 行，事件只做证据。
3. **启动是 O(全部数据)**：恢复循环读每个对话并对事件日志求和（`sqlite-store.ts:707-715`），回收读每个对话的全部回合（`:376-392`，`session-application.ts:126-128`）。建议：部分索引与 `content_refs`。
4. **现有的拒绝**：回复超 1 MiB 回合失败（`runtime.ts:1410-1413`）、用户输入 64 KiB 与请求体 128 KiB 被拒（`state.ts:17`，`server.ts:45`）、分支历史超 1 MiB 建不出分支（`state.ts:294`）。这些都与“不拒绝”相冲，逐项在 ADR 3.7。
5. **`readinessViews` 扫所有回合**（`server.ts:225-250`）算启动用时中位数。建议：`runs` 上 `(harness_id, control_id, prepared_at)` 索引，每个入口取最近 5 个。
6. **secret 回答的指纹**：回答原文进裸 SHA-256 并持久化（`runtime.ts:263`，`session-application.ts:55,140`）。建议：secret 不进指纹。
7. **协议类型缺字段**（可选新增，先问 proto-core）：`AssistantMessageItem.text`（读侧填好）、`QuestionItem.secret?`、`ApprovalItem.forItem?` 加 `permission_requested` 带 `toolId`（Codex `itemId`，`codex.ts:973,979`；ACP `toolCallId`，`acp.ts:994`）、`FileChangeItem` 的余数字段不再需要（不设上限）。
8. **Driver 丢了消息身份**（`codex.ts:838-845`，`acp.ts:877`）：相邻两条原生消息合成一段。建议：`text` 事件加可选 `messageId`，Codex 先做。
9. **清空与原生命令的上下文效果只在事件里**（`control.ts:139-145`，`runtime.ts:1896-1900`）：写进 `runs.context_effect` 与条目。
10. **回合结束时还开着的动作**：Claude 前台命令一直报 pending（审计 B.4.3），OpenClaw 补记没结果也写 completed（`openclaw.ts:162`）。建议：收场表写 `unknown`，OpenClaw 在第 1 步改成未知。
11. **读侧函数在哪儿跑、线上传几份**：若服务端在 `view()`（`server.ts:257-269`）附投影好的 `ProtocolTurn`，就不要同时发原始条目。建议：只在一处投影，与 proto-web 对齐后定。
12. **`deleteSession` 是硬删**（`sqlite-store.ts:436-446`），与分支引用冲突。建议：软删。

## 未确认

- 第 1 步读侧投影与归一模块的函数名、签名；投影能否逐回合产出（迁移要求，ADR 3.6）。
- 4317 的库大小、对话数、最长对话；迁移耗时与峰值磁盘。
- 第 1 步合并后的线上形状（`SessionView` 新形状要先写进契约再做线 C）。
- 人力与周数都是估算。
