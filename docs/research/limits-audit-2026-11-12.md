# 上限、预算、配额与拒绝条件清点（只读）

清点日期 2026-11-12。仓库 `~/Desktop/project/HarnessHub/.claude/worktrees/relay-stage2-7cb3e9`，分支 `claude/relay-stage2-7cb3e9`。
清点途中别的会话把协议第 1 步合进了这个分支（HEAD 从 `790761a` 走到 `467dd62`；之后到 `8edc426` 只改了两份文档，源码没变），所以**文中的文件:行号一律以 `467dd62` 为准**，新增的协议代码（`src/contexts/session/domain/protocol/*`、`src/web/protocol-view.ts`、`web/src/lib/protocol/*`）也一并清点了。路径除特别说明外都相对仓库根。

## 0 怎么查的、没查什么、证据标记

- 查了：命名常量（`MAX_`/`_LIMIT`/`_CAP`/`_BYTES`/`_BUDGET`/`_MS`/`TIMEOUT`，约 160 个）与近 600 个数字常量、`.slice(0,`、`length >`、所有 `*_LIMIT`/`QUEUE_FULL` 类错误码、落盘校验（`state.ts`、`content.ts`、`relay.ts`）里的长度与条数检查、HTTP 请求体/响应/上传、流、驱动、内容库、存储、界面写死的条数与长度。**每一处都读了触发之后的代码**，不只列常量名。
- 没做：没运行任何 Harness、没启动服务、没渲染页面；没读用户真实的 Harness 配置，也没读 4317 的真实数据与启动参数，所以“守护进程现在实际用的预算值”**没核对**。
- 证据标记：**【码】**读代码确认；**【测】**有现成测试断言这个行为；**【档】**`docs/verification/` 里的真机记录（我没复核）；**【推】**推断，未验证。凡没有标记的“触顶时”都是【码】。
- “用户看到”一栏：界面对大多数 `*_LIMIT` 码**没有专门文案**（`web/src/api.ts:929-984` 的 `failureMessage` 查不到就直接显示网关的英文原文；`web/src` 里搜 `RUN_LIMIT/COMMAND_LIMIT/EVENT_LIMIT/SESSION_LIMIT/OUTPUT_LIMIT/QUEUE_FULL/READ_LIMIT` 无任何命中），下表写“英文原文”。
- 分类：**A** 我们自己定的数字让内容被丢/截/拒，或功能做不了；**B** 单次传输的页大小或窗口（不限总量）；**C** 不是我们设的（模型窗口、Harness 自己的限制、SQLite/操作系统）；**D** 健壮性护栏。每个表的一行算一“项”（一条规则或一组同源常量）。

## 1 先说结论

1. **最重的三件事（都是读码确认，A 类）**
   - **一个回合默认最多干 5 分钟，到点真的会取消它**（A21）：通知 + 停止链，15 秒内不结算就杀进程、对话封成 `blocked`。最大只能配到 1 小时；还有一道 4 小时的驱动硬顶（A23）。
   - **对话有五道各自独立的总量墙**（A01 回合数 256、A02 命令 1024、A04 快照 8 MiB、A05 事件 16,384 条、A07 单回合正文/思考各 1 MiB），撞到任何一道，轻则该对话不能再发，重则（回合结尾的提交被拒、或分支超界）**走进 `fail()`，整个 Runtime 变 fatal，所有对话不能再发命令，直到重启**（A04、A05、A09、D21）。其中 **A02 把每一次审批决定也算一条命令**：审批多的对话会比 256 回合早很多撞墙，撞了以后**审批答不了，连“停止”和“关闭对话”都被拒**（A02）。
   - **对话列表是“最新 100 个、且不分页”，一次读还要求这 100 个快照合计 ≤ 8 MiB**（A30）：第 101 个及更早的对话在任何列表里都没有；合计超 8 MiB 则 `/api/v1/state` 整个 429，页面读不到对话。
2. **静默丢弃共五处**：工具 128、通知 32、活动 64、产物 32、计划步 64（A11–A15），**没有任何“已略去 N 条”的账**；工具条数还有一个现成的测试**专门断言它被丢**（`tests/integration/session-runtime.test.ts:691-698`）。
3. **“被截掉的部分”取不回来**（A16）：输入留头 16 KiB、输出留尾 64 KiB、diff 留头 64 KiB，在**写入内容库之前**就截了，Hub 没存全文，也没有读回原程序转录的路径。
4. **去掉限制不是改几个常量**：每次提交整份重写快照、整份校验（回合与切换的关系检查是嵌套线性扫描，最坏立方级，见 5.2）、整份读、每个事件先重建整份对话视图再按类型下发（文字事件发整条助手消息、活动回合的工具事件发整个 Run，其余发整份快照）。时间预算和少数几项可以先去，**回合数/命令/大小/事件那几道墙必须等“回合与条目各自成表”**（第 5 节逐项列了）。
5. **去掉时间预算会和别的上限联动**：并行名额只有 4 个、且排队**没有自己的期限**，靠的就是“每个在跑的回合都有预算”（`web/src/components/Turn.tsx:227` 的注释）；预算一去，第 5 个对话会无限排队。事件日志也是：长回合每 100 ms 一个窗口事件，时间预算去掉后会更快撞 16,384 条。
6. **另外两个暗坑**（D21、A37–A38）：落盘校验按 UTF-8 **字节**数限长，而驱动按 UTF-16 **字符**数截断，一个超过 4096 字节的工具标题会让提交抛 `INVALID_DATA`，不属于“预期失败”，同样走 `fail()`；管家与 Provider 的计数类上限**只增不删**，管家任务表满 2048 行后 `/api/v1/state` 每次都失败，Provider 超界则**服务起不来**。
7. **核对了 ADR-057 第 3.7 节**（3.9）：它列出的与代码一致；要改口径的有两处——③把“执行与等待预算、并行 4”归为“资源守护、超了如实失败”，而它们其实会取消正在正常干活的回合、让第 5 个对话无限排队；①把 relay 预算整个算作“对方的限制”，而 8000 tokens、5%、假设 128,000 等是我们定的。没覆盖的主要是：驱动里的 id 表与导入界（A10、A17–A20）、对话列表的“100 个且无游标”（A30）、界面写死的数字（A35）、新协议读侧的 64 KiB 思考截断（A36）、管家/Provider/能力（A37–A39）、HTTP 与驱动的超时和并发（D01–D07、D21–D24）。

## 2 逐项清单

“建议”一栏的词：**去掉** / **改分页或按需读取** / **调到碰不到** / **保留（理由）**。标“依赖存储”的，表示它不能单独去掉，要等“回合与条目各自成表”（第 5 节）。

### 2.1 A 类：我们自己定的数字让内容被丢、被截、被拒，或让功能做不了

#### 2.1.1 一个对话的总量

| 编号 | 名称 = 取值 | 位置 | 管什么 / 触顶时 | 用户看到 | 测试依赖 | 建议 |
|---|---|---|---|---|---|---|
| A01 | `MAX_RUNS` = 256（同源：`messages` ≤512、`nativeBindings` ≤256、`sourceRunIds` ≤256、`RELAY_MAX_RUNS` = 256） | `src/contexts/session/domain/state.ts:14`；用处 `state.ts:201,240,243,358-359`、`runtime.ts:424`、`src/contracts/relay.ts:24-28`；页面的镜像 `web/src/session-stream.ts:208`（runs>256 或 messages>1024 整个快照判无效） | 一个对话的回合总数。第 257 条输入在**受理前**被拒（`RUN_LIMIT`，HTTP 429），不产生回合 | 英文原文 “Session Run budget exhausted” | 无直接测试；`tests/unit/relay-contract.test.ts:55` 断言 `RELAY_MAX_RUNS === MAX_RUNS` | **去掉（依赖存储）**。回合与切换的关系校验是嵌套线性扫描，最坏立方级（5.2），先放开会让每次提交越来越慢；页面和 relay 表里的镜像上限一起改 |
| A02 | `MAX_COMMANDS` = 1024（`switches` 同界） | `state.ts:15,359`；`runtime.ts:922`（`commandBudget`），调用点：`:266` 审批决定、`:418` send、`:471` resume/switch、`:526` resetNative、`:605` setRetention、`:619` endKept、`:782` close、`:853` cancel；`state.ts:245` 列了 9 种命令 | 对话里所有命令回执：create、send、switch、cancel、close、**审批决定**、native-reset、retention、native-close，**各占一条**。满了以后 send、switch、审批决定、**停止（cancel）**、close、清空原生会话、保留开关一律被拒（`COMMAND_LIMIT`）：`decidePermission` 在把决定交给 Harness **之前**就拒，等着答的审批答不了，回合只能等到等待预算到期被取消；**用户连“停止”都点不了，也关不掉这个对话**（Runtime 自己因预算到期发起的停止不经过它，不受影响） | 英文原文 “Session command budget exhausted” | 无 | **去掉（依赖存储）**。命令回执移出快照，成表，按保留期回收（只为幂等回放） |
| A03 | `MAX_QUEUE` = 8 | `state.ts:16,414`；`runtime.ts:425` | 一个对话同时排队的输入。第 9 条被拒（`QUEUE_FULL`，429） | 英文原文 “Session queued input limit reached”（页面一次只排一条，平时碰不到；CLI/接口会碰到） | `tests/integration/session-runtime.test.ts:382-388` | **去掉**，或调到碰不到；队列就是回合表里 queued 的行 |
| A04 | `MAX_SESSION_BYTES` = 8 MiB | `state.ts:20,466`；`sqlite-store.ts:164,182`；响应界见 A31 | 一个对话快照序列化后的总字节。**写**：提交被拒（`SESSION_LIMIT`）。commit 内部把它当“预期失败”不置 fatal（`runtime.ts:163`），但**回合结尾的提交**被拒会落进 `catch (error) { this.fail(error); }`（`runtime.ts:1982`），`fail()` 置 `fatal`，之后 `admit()`（`:873-876`）对**所有对话**的所有命令都抛同一个错，直到重启【码，未复现】。**读**：超界的快照 `readStoredSession` 直接抛 `INVALID_DATA`（`sqlite-store.ts:164`），这个对话读不出来 | 英文原文；fatal 后每条命令都收到同一个错误 | `tests/performance/session-store-commit.test.ts:157-163`（造 8 MiB 快照量耗时，不断言拒绝） | **去掉（依赖存储）**。每次提交整份重写（5.1），单独去掉只会让提交越来越慢 |
| A05 | `MAX_SESSION_EVENTS` = 16,384（一批事件 `drafts()` 也受它限） | `state.ts:21,411`；`sqlite-store.ts:95`；`relay.ts:24` | 每对话事件条数，**事件永不删除**。撞到的失败路径同 A04（`EVENT_LIMIT`）。每个回合约 12 条固定事件 + 每个工具 2–4 条 + 流式每 100 ms 一个窗口事件（`STREAM_WINDOW_MS`=100，`contracts/session.ts:426`）：`docs/proposals/relay/round1/r4-internal-baseline.md:236` 估“工具密集的对话约 150–200 轮触顶”；按 100 ms 窗口估，一个流式十几分钟的长回合就能写上千条【推，未测】 | 英文原文 | `tests/integration/snapshot-cache.test.ts:257-277`、`session-store.test.ts:486-492`、`tests/unit/relay-contract.test.ts:55`、`tests/performance/relay-store.test.ts:108` | **去掉（依赖存储）**。ADR-057 3.5 已定：事件全留不修剪、文字窗口事件不再带正文、条数/总量/单条三个上限全部取消（T3 则只留 ≥1 天，见 4，是备选不是必须）；先让 `EVENT_LIMIT` 不再走 `fail()` |
| A06 | `MAX_EVENT_LOG_BYTES` = 32 MiB；`MAX_EVENT_BYTES` = 2 MiB + 4096（单条） | `state.ts:22-23`；`sqlite-store.ts:101,809,814` | 每对话事件日志总字节、单条事件字节。超了 `EVENT_LIMIT`，后果同 A05 | 英文原文 | `snapshot-cache.test.ts:257-277`、`session-store.test.ts:486-490` | 同 A05 |
| A07 | `MAX_OUTPUT_BYTES` = 1 MiB | `state.ts:18,203,227,291`；`runtime.ts:1411-1414,1437,1441` | 一个回合的助手正文 ≤1 MiB，**思考文本**另算 ≤1 MiB（分别计数）；分支/导入引用的单条消息同界。超了抛 `OUTPUT_LIMIT` 进驱动，驱动断连，回合 `unknown`、对话 `blocked`（需“核实并恢复”），已提交的正文保留 | “这段对话还有执行结果尚未核实，已暂停接收新消息”（`SESSION_BLOCKED`）；回合错误码 `OUTPUT_LIMIT` 无专门文案 | `session-runtime.test.ts:1079-1104`（断言 `unknown` + `SESSION_BLOCKED`） | **去掉（依赖存储）**。正文/思考按段落落成条目文本，读按页 |
| A08 | `MAX_INPUT_BYTES` = 64 KiB | `state.ts:17,198,227,488`；`web/src/components/Composer.tsx:142,145,289` | 用户一条消息的字节。`assertInput` 抛 `INVALID_INPUT`（“message must contain text within 64 KiB”）；界面发送键直接禁用。同类：对 Harness 提问的自由回答 `input` ≤64 KiB，超了 `INVALID_INPUT`（`runtime.ts:263,269`、`server.ts:822`）。请求体另有 128 KiB 上限（D01）：64 KiB 的内容遇上 JSON 转义（引号、换行各占 2 字节）可能先撞 `BODY_LIMIT`【推】 | 有中文提示：“单条消息不能超过 64 KiB，请缩短内容。” | `session-runtime.test.ts:382-388`（空、超长、NUL 都拒） | **去掉硬拒绝**：超长粘贴自动折成文本附件（T3 `foldPastedText`，4）；请求体界与附件通道分开 |
| A09 | `MAX_CONTEXT_BYTES` = 1 MiB + `MAX_ORIGIN_MESSAGES` = 512（分支、导入的“引用历史”） | `state.ts:19,33,285-296`；`runtime.ts:544-578`（`fork`）、`:152`（导入） | **分支**把源对话到分支点的**全部**公开消息复制进 `origin.history`，不做任何截断；超 512 条或 JSON >1 MiB，`store.create` 里的 `parseSession` 抛 `INVALID_DATA`，`fork` 的 `catch (error) { this.fail(error, id); throw error; }`（`runtime.ts:578`）→ **整个 Runtime fatal**【码：路径读通，未复现】 | 分支失败（英文原文）；之后所有命令被拒 | 无 | **去掉复制（依赖存储）**：分支只记“来自哪个对话、到第几回合”，读时按引用取 |
| A10 | 导入原生会话的读取界：Hub 引用 `MAX_IMPORTED_MESSAGES` = 200 / `MAX_IMPORTED_BYTES` = 512 KiB；ACP 回放 `IMPORT_REPLAY_BYTES` = 4 MiB / `IMPORT_REPLAY_MESSAGES` = 2000、`REPLAY_LIMIT` 64 MiB、`IMPORT_LIST_PAGES` = 20；Codex `IMPORT_TURN_PAGES` = 8 × `IMPORT_TURNS_PER_PAGE` = 50、`IMPORT_MESSAGES` = 400；`NATIVE_IMPORT_MS` = 120 s | `runtime.ts:152,382-392`；`acp.ts:53,55,325,356-360,812,835`；`codex.ts:111,479`；`binding-factory.ts:28` | 只引用最近一段，更早的计入 `omitted`（有账，不静默）；ACP 要翻前 20 页会话列表才能确认这个 id 属于工作区，**更靠后的会话报 `NATIVE_SESSION_NOT_FOUND`，导不进来**；64 MiB 回放或 120 s 超时则整个导入失败 | 有中文提示 “这个工作区的本机会话列表里没有它…” | 无单测（`tests/real/native-import.real.ts` 是真机脚本） | **改分页/按需**：打开时按页从原生读；用 `session/load` 按 id 取，不靠翻列表 |

#### 2.1.2 一个回合里的条数与长度

| 编号 | 名称 = 取值 | 位置 | 管什么 / 触顶时 | 用户看到 | 测试依赖 | 建议 |
|---|---|---|---|---|---|---|
| A11 | `MAX_RUN_TOOLS` = 128 | `state.ts:27,204`；`runtime.ts:1314`；页面 `web/src/api.ts:395` | 一个回合记录的工具条数。第 129 条起 **`return` 掉**：不进 `tools`，**不存详情**（`details` 还没写），**不写 `run.output` 事件**【码】；任何地方没有“略去 N 条”的账。相关的“新协议”条目、读回工具、交接单都只能看到前 128 条 | 无任何提示；“运行 N 条命令”偏小；“本回合改了哪些文件”会漏【推】 | `session-runtime.test.ts:691-698`（造 140 条，断言只剩 128 且回合照常完成）；`tests/unit/relay-packet.test.ts:388` 按 128 造数据 | **去掉（依赖存储）**。过渡期至少改成“有账”（ADR-057 初稿已写） |
| A12 | `MAX_RUN_NOTICES` = 32 | `state.ts:28,210`；`runtime.ts:183,1328` | 一个回合的通知条数。第 33 条起静默丢。**Hub 自己发的“执行期限已到/等待期限已到”也走 `withNotice`（`:182`），通知被刷满时同样被丢**，回合会被取消却没有原因 | 无 | 无 | **去掉** |
| A13 | `MAX_RUN_ACTIVITIES` = 64 | `state.ts:29,212`；`runtime.ts:1329` | 活动（子 Agent、压缩、重试、审查）条数。新 id 第 65 个起静默丢，已有 id 仍可更新 | 无 | 无 | **去掉** |
| A14 | `MAX_RUN_OUTPUTS` = 32 | `src/contracts/content.ts:12`；`state.ts:215`；`runtime.ts:1489,1502` | 产物（文件、图片、链接）条数。第 33 个起静默丢；已写进内容库的那份字节成孤儿，7 天后被回收 | 无 | 无 | **去掉** |
| A15 | `MAX_PLAN_ENTRIES` = 64 | `state.ts:30,206`；`runtime.ts:1332`；新协议 `protocol/tools.ts:238`（>64 条的待办清单不当计划，退回成一行工具）；页面解码计划步 ≤128（`web/src/lib/protocol/decode.ts:85`） | 计划步数。`Run.plan` 只留前 64 条，其余静默切掉 | 无 | 无 | **去掉** |
| A16 | 工具详情预览：`TOOL_INPUT_BYTES` = 16 KiB（留头）、`TOOL_OUTPUT_BYTES` = 64 KiB（留尾）、`TOOL_DIFF_BYTES` = 64 KiB（留头）、`locations` ≤16 个 × 1 KiB；驱动先切一刀：Codex 输出留尾 128 KiB（`ITEM_OUTPUT_BYTES`）、OpenClaw 补记同界 | `src/contracts/control.ts:73-75`；`runtime.ts:113-123`；`codex.ts:74,92`；`openclaw.ts:122,159` | 在**写入内容库之前**就截断并标 `truncated: true`；**被截的部分没有任何地方可以取回**（Hub 没存全文，也没有读回原程序转录的路径）【码】 | 展开步骤时有 `truncated` 标记；读回工具返回时带“可能不完整”备注（`src/contexts/session/domain/table.ts:306`） | 无直接测试 | **改成“预览 + 全文分页”**：条目里留头/尾几 KiB 做一行预览，完整输入/输出/diff 作为整块存下，按页读。内容库单项 20 MiB 界见 A29 |
| A17 | `MAX_USAGE_REQUESTS` = 64 | `control.ts:88`；`codex.ts:935`；`src/adapters/control/relay-turn.ts:145` | 每回合逐次请求的用量明细，只留最近 64 条（丢最旧的）；不进公共 Run | 无 | 无 | **去掉**（一条几十字节） |
| A18 | 驱动里的“身份表”界：ACP `MAX_PROMPT_TOOLS` = 4096（`TOOL_LIMIT`）；Codex `TURN_LIMIT` 4096、`ITEM_LIMIT` 4096、`THREAD_LIMIT` 1024（外来线程）；每连接放弃的会话/线程 `MAX_ABANDONED_*` = 256（每次 Hub 接管的清空放弃一个）；JSON-RPC 在途请求 128 | `acp.ts:36,61,886`；`codex.ts:76,721,741,842`；`src/infrastructure/control/json-rpc-process.ts:232` | 一个连接里的工具/回合/消息 id 个数。超了即协议失败，**回合中途终止**。工具超过 4096 的回合在 Hub 的 128 之前就死了（长回合会把子 Agent 的工具平铺进根会话，`acp.ts:35` 的注释） | 回合失败；`TOOL_LIMIT` 等无文案 | 无 | **去掉计数**：只记未完成的项，完成的出表 |
| A19 | 原生命令个数：ACP `MAX_NATIVE_COMMANDS` = 2048；技能/MCP/插件列表 `MAX_NATIVE_EXTENSIONS` = 512；界面斜杠菜单 `slice(0, 50)`、命令面板 `slice(0, 60)` | `acp.ts:37,841`；`control.ts:176`；`codex.ts:308`；`Composer.tsx:325`；`web/src/components/CommandPalette.tsx:55` | ACP 一次宣告超过 2048 条 → `INVALID_PROTOCOL`，连接失败；技能等超过 512 被切掉并标 `truncated`；菜单只列前 50 条且没有“更多” | 菜单里看不到后面的命令（继续输入可过滤） | 无 | **改分页/搜索**：协议层不设界（只标记）；菜单先按输入过滤，再分页 |
| A20 | OpenClaw 回合后补记窗口 `TRANSCRIPT_WINDOW` = 200 | `openclaw.ts:22,502-508` | 回合结束后只读转录最近 200 条来补记思考和工具；一个回合产生的转录超过 200 条，前面的“没被补记”，只写一条诊断（日志，用户看不到） | 无 | 无 | **改分页读到头** |

#### 2.1.3 时间与并行

| 编号 | 名称 = 取值 | 位置 | 管什么 / 触顶时 | 用户看到 | 测试依赖 | 建议 |
|---|---|---|---|---|---|---|
| A21 | `DEFAULT_EXECUTION_BUDGET_MS` = 300,000（5 分钟）；`MIN` 30 s、`MAX_EXECUTION_BUDGET_MS` = 3,600,000（1 小时）；启动参数 `--execution-budget <30..3600 秒>`，唯一的生产入口是 `HarnessGateway web --execution-budget` | `contracts/session.ts:415,433-443`；`runtime.ts:1226-1231`（`armBudget`）、`:1256-1273`（`expire`）、`:1537-1538`（回合一开始就起表）；`src/cli/web.ts:29,48`（解析与启动日志） | 一个回合的**干活时间**（等用户决定的时间不计，`enterWait` 把它暂停）。**到期真的取消正在干活的回合**：写通知 “执行期限已到” 和事件 `run.budget_expired`，走停止链（`requestStop`）。15 s（A24）内结算 → `cancelled` + 错误码 `RUN_TIMEOUT`（原程序报的状态单独记在 `backend`）；过了宽限仍不结算 → 杀进程，回合 `unknown`，对话 `blocked`。原程序已做的文件改动留在磁盘上，Hub 不自动重跑【码，【测】，【档】】 | “执行期限已到…HarnessHub 已停止它”通知；回合标“已停止（执行预算用尽）”；强杀时“结果尚待核实”（`web/src/api.ts:978`） | `tests/integration/parallel-work.test.ts:181-190,206-215,216-225,281-282`；真机：`docs/verification/first-chain-polish-2026-10-11.md:459-461`（`--execution-budget 30`，30.005 s 到期，0.86 s 后 `cancelled`） | **去掉默认到期取消**；到时间改成“已运行 N 分钟”的提示，用户自己选继续等或停止；`--execution-budget` 留作可选的自动停止，默认关。详见 3.1 |
| A22 | `DEFAULT_WAIT_BUDGET_MS` = 1,800,000（30 分钟）；`MIN` 1 分钟、`MAX_WAIT_BUDGET_MS` = 2 小时；`--wait-budget <1..120 分钟>` | `session.ts:416,433-443`；`runtime.ts:1066-1090`（`queueExpired`）、`:1256-1273` | 等用户的审批/提问，**加上**等同一工作区里别的对话让位。到期取消回合（`WAIT_EXPIRED`，原程序没收到决定）；等工作区的回合到期则整条输入失败（`WORKSPACE_BUSY`，“没有发出”） | “等待期限已到”通知；`WORKSPACE_BUSY` 有中文文案（`web/src/api.ts:956`） | `parallel-work.test.ts:159-173,226-237` | **去掉到期取消**：审批/提问一直等到用户回答（对方 Harness 自己设的到期除外，见 C04）；等工作区改成一直排队、可取消、不失败 |
| A23 | `NATIVE_TURN_HARD_CAP_MS` = 4 小时（= 最大执行 1 h + 最大等待 2 h + 1 h），作为每个驱动的 `runTimeoutMs` | `session.ts:428`；`src/infrastructure/session/binding-factory.ts:288`；`acp.ts:732-737`（`session/prompt` 的期限，默认 “abort” = 断连）；`codex.ts:623`；`pi.ts:248` | 驱动自己的单回合期限，注释说“只防协议挂死”。到点 `rpc.abort`，连接断开，回合失败。**Hub 的两个预算都去掉后，它就成了唯一的墙** | 回合失败；`RUN_TIMEOUT` 的文案写“超过了 HarnessHub 的执行期限”，与这条的实际原因不符 | 无 | **去掉**；要防挂死，用“长时间没有任何事件”的提示，不取消 |
| A24 | `STOP_GRACE_MS` = 15,000 | `session.ts:420`；`runtime.ts:1183-1192` | 停止之后原程序多久必须结算，过了就关进程。回合 `unknown`、对话 `blocked`（A21 的强杀路径同此） | “结果尚待核实”；对话顶部“核实后恢复” | `parallel-work.test.ts:216-225` | **保留，改一半**：用户或预算要求停止时需要有限等待；但“到期强杀并封对话”改成“提示，并让用户选继续等或强杀” |
| A25 | `MAX_PARALLEL_CONVERSATIONS` = 4；另有“同一工作区同时只跑一个对话”（`holders`） | `session.ts:419`；`runtime.ts:1016-1033,1093-1100,1112-1131`；`native-host.ts:361`（宿主预算里的 `maxParallel` 1–16 **没有接到运行时**，生产里恒为 4，`src/cli/session-application.ts:129,147-148` 不传） | 同时有回合在跑的对话数。第 5 个起排队（事件 `run.waiting` kind `slot`），**排队没有自己的期限**，靠的是“每个在跑的回合都有预算”（`web/src/components/Turn.tsx:227`）。同工作区的后到者排队，满 30 min 失败（A22） | 排队行写“等 N 个对话”；启动日志写 “up to 4 conversations run at once” | `parallel-work.test.ts`（`maxParallel` 作测试注入）、`tests/unit/native-host-contract.test.ts:81` | **去掉默认上限**（可选设置）。注意与 A21 联动：去掉时间预算而保留 4 个名额，第 5 个对话会无限排队。同工作区互斥另议，A/D 两种理由见 3.2 |
| A26 | 保留原生进程：`KEPT_LIMIT` = 4 个；`KEPT_IDLE_MS` = 30 分钟 | `runtime.ts:96-98,768-774`；宿主池界 `native-host.ts:359-363`（`maxPinned` 等，未接入） | “保留后台进程”功能。第 5 个起这回合的进程照常关闭，**只记事件 `native.retention_skipped`**；空闲 30 分钟关 | **界面没有提示**（`web/src` 里没人用这个事件） | `tests/integration/kept-process.test.ts:53,151` | **调大/去掉个数**（进程占内存，换成按内存预算）；空闲时间保留但可设 |
| A27 | `MAX_CONNECTION_WIRE_BYTES` = 256 MiB：一条驱动连接上进出两个方向**累计**的字节，连接寿命内不清零 | `json-rpc-process.ts:162,426-429` | 长回合、或被保留的进程跨多个回合累计超过它，`WIRE_LIMIT`，连接中止、回合失败。注释：“Native agents legitimately repeat large tool results…” | 回合失败，无文案 | `tests/protocol/process.test.ts:178` | **去掉累计量**（也有 D 的理由：防失控流）；只看单帧大小与内存 |

#### 2.1.4 附件与内容库

| 编号 | 名称 = 取值 | 位置 | 管什么 / 触顶时 | 用户看到 | 测试依赖 | 建议 |
|---|---|---|---|---|---|---|
| A28 | 附件：`MAX_RUN_ATTACHMENTS` = 8；`MAX_CONTENT_BYTES` = 20 MiB（单件）；`MAX_RUN_ATTACHMENT_BYTES` = 32 MiB（一条消息合计）；另受 16 MiB 单帧界（D04）制约 | `contracts/content.ts:8-11`；`src/infrastructure/session/content-store.ts:106,132`；`server.ts:798`；`web/src/components/Attachments.tsx:19-21`、`Composer.tsx:147`、`web/src/App.tsx:737-745` | 超个数：界面不收多余文件；超字节：页面拒，服务端 413/`ATTACHMENT_LIMIT`。**图片在 12–20 MiB 之间**：过得了 Hub 的检查（ACP 的 `maxInlineImageBytes` 返回 20 MiB，`acp.ts:413`），但按 base64 内联后超过 16 MiB 的出帧界，`write()` 抛 `FRAME_LIMIT`，连接中止（`json-rpc-process.ts:341-342`）【推：由这两处读出，未运行】 | 有中文提示：“一条消息最多 8 个附件，多出的文件没有添加”“单个附件不能超过 20 MB”“一条消息的附件合计不能超过 32 MB” | `tests/protocol/acp.test.ts:564`（图片上限）；其余无 | **去掉个数上限，字节上限调到 T3 量级**（单件 50 MiB、图片合计 80 MiB、最多 100 个，4）；大图改走文件路径，不内联 base64 |
| A29 | 内容库：`MAX_STORE_BYTES` = 4 GiB；`MAX_STORE_RECORDS` = 262,144；附件、原生产物、**每个工具详情**各占一条记录；未被引用的内容保留 7 天（`CONTENT_RETENTION_MS`），半截上传 1 小时 | `content-store.ts:11-15,283,286` | 满了新存的失败：工具详情只写一条诊断 “tool detail was not stored”（`runtime.ts:1481`），回合照常；附件上传抛 `CONTENT_LIMIT`（429）。记录数上限会被工具详情吃光：每个已完成的工具一条，全库合计约 2,000 个“满 128 个工具”的回合就满【推：262,144 ÷ 128，按每回合 128 条的上限估】 | 工具详情静默缺失；上传时英文原文 | `tests/integration/content-store.test.ts:71`（`CONTENT_LIMIT`）；保留期另有断言（同文件，行未逐条核） | **去掉记录数上限**；字节上限换成“磁盘剩余提示”。7 天回收的是没被任何对话引用的孤儿，保留（D09） |

#### 2.1.5 读取与传输

| 编号 | 名称 = 取值 | 位置 | 管什么 / 触顶时 | 用户看到 | 测试依赖 | 建议 |
|---|---|---|---|---|---|---|
| A30 | 对话列表：`store.list(100)`；一次读的总字节 `MAX_READ_BYTES` = 8 MiB；`GET /api/v1/sessions?limit` 取值 1–100，**没有游标** | `sqlite-store.ts:178-188,349`；`state.ts:24-25`；`src/web/server.ts:588`（`/api/v1/state`）、`:791`（就绪视图）、`:1013`（对话列表） | 三处都调 `list(100)`：**第 101 个及更早的对话不在任何列表里，无法翻页**；这 100 个快照的存盘字节之和超过 8 MiB，抛 `READ_LIMIT`，**`/api/v1/state` 整个 429 失败，页面读不到对话列表**【码】（`server.ts:282` 把含 “LIMIT” 的码映射成 429）。页面本地还有 `slice(0, 1000)`（`web/src/App.tsx:380`）。对话只能“关闭”不能删除（`deleteSession` 只在存储里，Web 没接，`sqlite-store.ts:436`） | 英文原文；页面可能整页不可用 | `tests/integration/session-store.test.ts:492`（`READ_LIMIT`） | **改分页**：列表走轻量摘要（标题、状态、更新时间各占独立列）+ 游标，不再解析完整快照；去掉 8 MiB 聚合界（依赖存储） |
| A31 | 响应体 `MAX_RESPONSE_BYTES` = 8 MiB；`GET /api/v1/sessions/:id` 与导出**一次返回整个对话**；页面自己另有 16 MiB 响应界 | `server.ts:47,201,1090`；`web/src/api.ts:913` | 对话视图或导出（JSON/Markdown）超 8 MiB → 413 `RESPONSE_LIMIT`，该对话打不开、导不出。导出是同步内存拼接，不带内容库里的字节 | 英文原文 | 无 | **改分页**（回合页）；导出改流式（依赖存储） |
| A32 | SSE 帧 ≤8 MiB；每个事件都先在服务端重建**整份**对话视图（含新协议投影，`session-stream.ts:103-110`），再按类型下发：文字事件发整条助手消息、活动回合的工具事件发整个 Run、其余（审批、回合结束、切换等）发整份快照 | `src/web/session-stream.ts:66,103-123,161`；页面 `web/src/session-stream.ts:4` | 帧超界时 `send()` 直接 `this.close()`，**静默断开**；重连后同一份快照仍超界，客户端会一直重连【推：没读客户端重连逻辑】 | 页面“实时回复状态暂时无法同步” | `tests/integration/web-session-stream.test.ts`、`tests/unit/web-session-stream.test.ts`（用小界走同一路径） | **改增量**（按条目 upsert，5.4）；连接数界见 D02 |
| A33 | 交接单预算中**我们自己定的**：`standardCap` = 8000 tokens；`windowShare` = 5%；`assumedWindow` = 128,000；`userCap` = 2500；`WINDOW_RESERVE` = 4096；`FIXED_PREFIX` = 8000；引用行 `MAX_INLINE` = 4000 字符；失败命令的输出摘录 `OUTPUT_LINES` = 20 / `OUTPUT_CHARS` = 1200；读回详情只取“第一个欠账回合 + 最近 12 个”、每回合 ≤32 个工具、合计 ≤128 个、每个 ≤256 KiB；`RELAY_BODY_BYTES` = 256 KiB/包；`RELAY_SESSION_BODY_BYTES` = 64 MiB/对话 | `src/contexts/session/domain/relay/budget.ts:26-29`；`windows.ts:14-16`；`narration.ts:117-120`；`runtime.ts:2204-2215`；`src/contracts/relay.ts:38-39`；`src/infrastructure/session/relay-tables.ts:156` | 换 Harness 时给新 Harness 的“摘要”有多大。**历史长度不进入预算**，放不下的整条省略并在账里写明（“省略有账”），**从不拒绝输入**：最小的包都放不下时原样发用户的话（`runtime.ts:1707`）。真正的上限（对方的上下文窗口）是 C01。两个存储界在现有 8000 tokens 下碰不到（256 回合 × 约 30 KB ≈ 7.7 MB） | 交接单里有“省略 N 条”的账；界面有交接分隔线 | `tests/unit/relay-packet.test.ts:224-225,293,338`（cap 6400/8000 等数值） | **调大并可配置**（T3 默认 16,000 tokens、环境变量可设、夹在 1,024–64,000，4）；按窗口 5% 是策略不是拒绝，可保留；两个存储界去掉或改成派生值。详见 3.7 |
| A34 | 读回工具 `TABLE_LIMITS`：目录默认 40、最多 100 回合；单页默认 12,000、最多 40,000 字符；搜索默认 20、最多 50 处、词 ≤200 字、每段文字最多数 99 次命中；读详情 ≤1 MiB/个，**一次请求**最多读 300（目录）/ 200（一个回合）/ 400（搜索）个、合计 ≤32 MiB | `src/contracts/table.ts:44-55`；`src/contexts/session/domain/table.ts:339,348`；`src/web/table-routes.ts:87-104,144` | 目录、单页有 `from`/`offset` 可以继续读（算 B）；**搜索没有偏移**：第 51 处以后的命中取不到，只能换更精确的词（提示 “use more specific words”，`src/cli/hub-tools.ts:196`）；读详情超界的计入 `unsearched/unread` 并提示 | 对 Harness 可见的备注 | `tests/unit/table-model.test.ts`、`tests/integration/table-api.test.ts` | 目录、页、详情保留作页大小；**搜索加偏移**、去掉“最多 50 处”；`*Details` 与 `totalBytes` 随条目表消失（直接按索引查，依赖存储） |
| A35 | 页面里的显示窗口：改动页只读最近 40 条编辑；斜杠菜单 50；命令面板 60 条命令/200 个对话；relay 视图解码 `bindings.slice(0, 64)`、`packets.slice(0, 512)`；草稿存本地 ≤256 KiB | `web/src/components/DetailsPanel.tsx:50`；`Composer.tsx:325`；`CommandPalette.tsx:55`；`web/src/App.tsx:1012,542`；`web/src/relay.ts:214-215` | 较早的编辑、命令、对话、交接单在这些界面里看不到，**没有“更多”入口**；草稿超界存不下，提示“浏览器暂时无法保存草稿” | 草稿有提示，其余无 | 无 | **改分页/虚拟列表** |
| A36 | 新协议读侧（第 1 步新增）：思考文本 `REASONING_MAX` = 64 KiB（超出截断并标 `truncated`，全文仍在 `Run.thinking`）；工具头 `HEAD_INPUT` = 4096、`LABEL_MAX` = 1000、文件列表 ≤64、位置 ≤16；**每次生成对话视图最多同步读 400 个工具详情**（`DETAIL_READS_PER_VIEW`），多出的退回“按标题讲”，下次视图再试；头缓存 4096 条；页面解码一个回合 ≤4096 条目、文件改动 ≤1024、计划步 ≤128，超了整回合退回事实绘制 | `src/contexts/session/domain/protocol/project.ts:41,121`；`protocol/tools.ts:106-119`；`src/web/protocol-view.ts:26,60-70`；`web/src/lib/protocol/decode.ts:71,85,135` | 视图层，不改存储。但它是**新增的耗时点**：每次生成视图（含每个 SSE 快照帧）同步读详情文件，`readTextSync` 会阻塞事件循环（`content-store.ts:202-221` 的注释自己写了）。超 64 KiB 的思考在新界面看不全；>400 个工具的对话，较旧的回合降级显示 | 看不到 64 KiB 以后的思考；旧回合工具行退化为标题 | `tests/unit/protocol-*.test.ts` | **去掉截断，思考按页取**；详情头改存进条目行，不再逐个读文件（依赖存储） |

#### 2.1.6 对话之外的功能（管家、Provider、能力）

| 编号 | 名称 = 取值 | 位置 | 管什么 / 触顶时 | 用户看到 | 测试依赖 | 建议 |
|---|---|---|---|---|---|---|
| A37 | 管家（安装/升级/卸载）存储界：`management_jobs` ≤2048 行（排队 ≤8）、`management_logs` ≤65,536 行（每任务日志块 ≤2048）、installations/native_plans/targets/requests ≤2048、updates ≤256，总字节 ≤32 MiB；**没有任何删除这些表的代码**（`grep "DELETE FROM"` 无命中） | `src/infrastructure/management/service.ts:331,845,868-875,1043` | 满了：新任务 `QUEUE_LIMIT`；`listJobs` 直接抛 `STORAGE_LIMIT`——而 `/api/v1/state` 每次都调它（`server.ts:590`）【码】：**终身累计满了以后整页状态读失败** | 英文原文 | `tests/integration/management-service.test.ts`（未逐条核） | **去掉**；完成的任务按保留期回收，列表分页 |
| A38 | Provider 存储界：`MAX_PROVIDERS` = 128、`MAX_MODELS` = 128、`MAX_REVISIONS` = 1024/个、`MAX_TOTAL_REVISIONS` = 4096、`MAX_COMMANDS` = 8192、元数据 ≤32 MiB、`MAX_CREDENTIAL_BYTES` = 8192 | `src/contexts/provider/domain/provider.ts:3-6`；`src/infrastructure/provider/service.ts:10-16,60-76,92` | **启动时**校验到超界直接抛 `STORAGE_LIMIT`，**整个服务起不来**；运行中超界拒绝写 | 启动失败（只打印错误码） | `tests/integration/provider-service.test.ts` | **去掉计数类硬上限**；任何预算都不得让服务启动失败 |
| A39 | 能力管家：`MAX_CAPABILITY_ENTRIES` = 4096（超出切掉并标 `truncated`）；技能夹 `MAX_SKILL_FILES` = 4000 / `MAX_SKILL_BYTES` = 64 MiB / 深度 32（超了**拒绝放置**该技能）；扫描 `MAX_ROOT_ENTRIES` = 2048、`MAX_LISTED_FILES` = 1024、`MAX_SKILL_WALK` = 4096；技能说明 `SKILL_TEXT_BYTES` = 32 KiB、指令文本 16 KiB、子 Agent 提示 32 KiB、dsh 指令 64 KiB、OpenClaw 20,000 字符 | `src/contracts/capabilities.ts:122`；`src/infrastructure/capabilities/scan.ts:16-21`；`skill-tree.ts:63,74-83`；`skill-text.ts:11`；`instruction-blocks.ts:10`；`subagent-definitions.ts:16` | 扫描类：切掉并标 `truncated`（界面写明）；写入类：拒绝（`CAPABILITY_TARGET_REFUSED`，中文说明），用户自己的合法技能可能被拒 | 中文说明 | `tests/integration/capabilities.test.ts` 等（未逐条核） | 写入类限制有 D 的理由（防大文件撞坏用户目录），但 64 MB/4000 个对合法技能偏紧，**调大**；扫描类标 `truncated` 保持 |


### 2.2 B 类：单次传输的页大小或窗口（不限总量，只是一次给多少）

| 编号 | 名称 = 取值 | 位置 | 管什么 / 触顶时 | 测试依赖 | 建议 |
|---|---|---|---|---|---|
| B01 | 会话事件页：默认 50、最大 100 条（`MAX_READ_ITEMS`）；**一页的字节还要 ≤8 MiB（`MAX_READ_BYTES`），超了抛 `READ_LIMIT` 而不是缩页** | `src/web/server.ts:1107-1110`；`state.ts:24-25`；`sqlite-store.ts:116-118,190-207` | 页大小是对的；“字节超限即拒绝”要改成“按字节缩页”。事件单条最大约 2 MiB，100 条的页理论上可超 8 MiB | `tests/integration/session-store.test.ts:492` | **保留页大小**；字节超界改成缩页 |
| B02 | 流式提交窗口：`STREAM_WINDOW_MS` = 100、`STREAM_WINDOW_BYTES` = 16 KiB | `contracts/session.ts:426`；`runtime.ts:1397-1446` | 一个窗口提交一次（一条 `run.output` 事件 + 一次整份快照重写）。不限总量，但**每个窗口都吃一条事件配额**（A05） | `session-runtime.test.ts:1079-1104`、`tests/browser/web.browser.ts` | 保留窗口；窗口事件不该进账本（5.3） |
| B03 | SSE 保活与寿命：心跳 15 s、连接寿命 60 s（也受登录期限制）、写缓冲排空超时 10 s（会话流与 attention 流各一份） | `src/web/session-stream.ts:66-69`；`src/web/attention-stream.ts:37-38` | 每 60 秒重连一次是设计；排空超时只关**慢消费者**的连接 | `tests/integration/web-session-stream.test.ts` | 保留 |
| B04 | 驱动里的合并/静默窗口：Codex 命令输出节流 `STREAM_MS` = 300 ms、Pi 300 ms、Hermes 回合结算后静默 250 ms、ACP 回放静默 150 ms/最长 3 s、尾随更新最长 2 s、命令宣告等 1.5 s | `codex.ts:74`；`pi.ts:61`；`hermes.ts:47`；`acp.ts:42-51` | 窗口，不丢内容 | `tests/protocol/*.test.ts` | 保留 |
| B05 | 读回工具的页：目录默认 40 / 最多 100 回合；单页默认 12,000 / 最多 40,000 字符（带 `offset`）；搜索默认 20 处 | `src/contracts/table.ts:44-55` | 页大小。搜索没有偏移的问题记在 A34 | `tests/unit/table-model.test.ts:73,116` | 保留，搜索补偏移 |
| B06 | 原生会话列表页：Codex `thread/list` limit 50（一页最多收 100）、`MAX_NATIVE_SESSIONS` = 200/页；ACP `session/list` 一页最多收 1000；OpenClaw `sessions.list` 50；Codex `model/list` / `mcpServerStatus/list` 100/页。都走游标，`GET /api/v1/harnesses/:id/native-sessions?cursor=` 已分页 | `codex.ts:324,458-465,522`；`acp.ts:341-346`；`openclaw.ts:432`；`control.ts:199` | 页大小，Hub 已分页 | `tests/protocol/*.test.ts` | 保留 |
| B07 | 管家任务与日志页：任务默认 50（最多 100）、日志 50/页；`/state` 里只带前 50 个任务 | `server.ts:590,942,983-986`；`web/src/api.ts:845,848` | 页大小 | `tests/integration/web-management.test.ts` | 保留 |
| B08 | 命令行 `sessions list/events`：默认 50、1–100 | `src/cli/sessions.ts:11,29` | 页大小 | `tests/integration/session-cli.test.ts` | 保留 |
| B09 | 一个回合的诊断：最多扫 200 页 × 100 = 20,000 条事件，超了标 `eventsComplete: false`（有标记，不静默） | `server.ts:1051-1064` | 扫描窗口，带“不完整”标记 | 无 | 保留；事件日志改成有保留期后这个窗口随之调整 |

### 2.3 C 类：不是我们设的限制

| 编号 | 名称 | 位置 | 说明 | 对我们的含义 |
|---|---|---|---|---|
| C01 | 模型的上下文窗口 | `src/contexts/session/domain/relay/windows.ts:29-37`（读 `usage.context.size`）；界面“上下文 N%” | 来自 Harness 的报告；没报告时我们**假设 128,000**（那是 A33 的我们的数字） | 保留；它是交接单预算的上界来源之一 |
| C02 | 上下文超限、限流、额度的失败码：`NATIVE_CONTEXT_EXCEEDED` / `CONTEXT_WINDOW_EXCEEDED`、`NATIVE_RATE_LIMITED` / `MODEL_RATE_LIMIT`、`NATIVE_QUOTA_EXCEEDED`（Codex 的 `usageLimitExceeded`、`sessionBudgetExceeded`） | `src/infrastructure/control/json-rpc-process.ts:86-98`；`codex.ts:212-222` | 对方的限制，Hub 只负责翻成中文提示 | 保留；T3 对 `usage_limit` 还做了“重置时间到了自动续”（4），可参考 |
| C03 | ACP 停止原因 `max_tokens` / `max_turn_requests` / `refusal` | `acp.ts:748-754` | Harness/模型的限制。Hub 把它们映成 `failed` **且不带 error**，界面只显示“失败”没有原因（显示缺口，不是限制） | 保留限制；补原因 |
| C04 | 对方自己的审批到期：ACP `expiresInMs`（native）；Hermes 0.12 的 60 s（`HERMES_APPROVAL_WAIT_MS`） | `hermes.ts:45,188`；`runtime.ts:1293-1296` | 对方到期就自己拒绝。Hub 取“较早者”。**Hub 对对方宣告的等待超过 24 小时的当作没宣告（`MAX_PERMISSION_WAIT_MS`，`runtime.ts:161,1293-1296`），再叠上等待预算（A22）：这两个是我们的** | 保留对方的；去掉我们的两个 |
| C05 | 对方入口的输入界（由我们的 Driver **声明**）：Codex 1,048,576 字符、OpenClaw 2,097,152 字节、ACP/Claude/OpenCode/Hermes 无 | `codex.ts:34`；`openclaw.ts:214`；超了的拒绝在 `src/adapters/control/relay-turn.ts:100` | 超了 `RELAY_INPUT_LIMIT`（“消息与交接单合起来超过 Harness 能收的大小，没有发出”）。现有预算下碰不到：交接单 ≤8000 tokens，消息 ≤64 KiB | 数值是否真是对方的限制，**我没查它们的文档**【推】 |
| C06 | OpenClaw 网关的内联图片上限 5,000,000 字节（2026.10.5 实际接受到 6,291,456） | `openclaw.ts:366-371` | 对方的限制；我们取了旧网关的保守值 | 保留，或随版本放宽 |
| C07 | 文件名 ≤255 字节（`NAME_MAX`）、路径 ≤4096（`PATH_MAX`）、绝对路径与无 `..` 的校验 | `content.ts:13`；`state.ts:59-63`；`src/cli/web.ts:32`；`sqlite-store.ts:51` | 操作系统界 | 保留 |
| C08 | Node HTTP 头 ≤8192 字节（`maxHeaderSize`） | `server.ts:1148` | Node 的参数，不是业务限制 | 保留 |
| C09 | SQLite 与 V8 的界：SQLite 单个 TEXT 默认最多 1,000,000,000 字节、`octet_length` 需要 3.43+（`sqlite-store.ts:156-159` 的注释）；V8 字符串约 2^29 个字符。我们的 8 MiB 远低于它们 | `src/infrastructure/session/sqlite-store.ts:156-159`（SQLite 3.43+ 的注释） | 去掉 8 MiB 之后，真正的界是它们，但整份快照 `JSON.stringify` 在到这些界之前就已经慢到不可用（5.1）【推；界的数值来自对 SQLite/V8 文档的记忆，本次未核对】 | 存储改造后才有意义 |
| C10 | 图片格式白名单（png、jpeg、gif、webp；SVG 不内联）、附件类型被 Harness/模型拒收（`ATTACHMENT_UNSUPPORTED`） | `content.ts:14,35`；`src/infrastructure/control/attachments.ts:13-18` | 对方模型或安全决定 | 保留 |
| C11 | Hermes 自己的网关就绪等待 60 秒（它的 viewer 等一个正在启动的网关多久，到了报 `Gateway starting: deadline`） | `src/adapters/control/hermes-gateway.ts:27` | 对方的参数，由我们的代码照抄 | 保留；Hub 不代为启动/停止网关（ADR-051），只显示原因 |

### 2.4 D 类：健壮性护栏

“去掉会出什么事”和“有没有办法不限功能地保留”是这一类每一行都要回答的两件事。

| 编号 | 名称 = 取值 | 位置 | 触顶时 | 去掉会出什么事 | 不限功能地保留的办法 / 建议 |
|---|---|---|---|---|---|
| D01 | HTTP 入口：JSON 请求体 `MAX_BODY_BYTES` = 128 KiB、读体超时 10 s、`headersTimeout` 10 s、`requestTimeout` 15 s、`keepAliveTimeout` 5 s、`server.maxConnections` 32、并发请求 `MAX_REQUESTS` = 16（429 `CLIENT_LIMIT`）；静态资源 `MAX_ASSET_BYTES` = 4 MiB（超了直接 404，不是 413，`server.ts:320`；现有最大的打包文件约 735 KiB，`web/dist/assets/index-*.js`，11-12 01:32 的构建，离界还远） | `server.ts:46-49,206-225,1148-1158` | 413 `BODY_LIMIT`、408、429 | 一个坏客户端可拖死本机服务（只监听环回，且同源 + CSRF，风险低）；请求体不设界则一个大 JSON 全进内存 | **保留，调值**：JSON 请求体界 ≥ 最大合法消息的 4 倍（A08 去掉 64 KiB 后），附件走流（已是）；并发数调到几百；`requestTimeout` 改成“无数据 N 秒”的空闲超时 |
| D02 | SSE 订阅数：对话流 8、attention 流 8（429 `STREAM_LIMIT`）；SSE 帧 8 MiB（A32） | `session-stream.ts:66,82`；`attention-stream.ts:37,50` | 第 9 个页签/对话流被拒 | 订阅多了写缓冲堆内存 | **调大到几百**；慢消费者仍按排空超时关闭（B03）。帧界随增量帧消失 |
| D03 | 登录：`LOGIN_MS` = 8 小时（固定，不续期，cookie `Max-Age` 同值）；`BOOTSTRAP_MS` = 10 分钟（一次性启动链接） | `server.ts:51-52,467,575-579` | 8 小时后 401 “Open the Gateway startup link”。整个服务进程**只发过一次登录**（一次性 bootstrap 用掉就没了，只读到 `:578` 一处发登录），过期后只能重启服务拿新链接【码；“没有别的续登路径”是读 `server.ts` 的结论，别处没细查】 | 去掉登录期限：登录态变成永久令牌。服务只监听环回并有同源 + CSRF；令牌（cookie）一旦被本机其他进程读到就等于登录，期限是在压低这种风险 | **保留令牌，去掉固定 8 小时**：改成滑动续期（有活动就续），或在环回上不过期。这是“零操作”和安全的取舍，需要你定 |
| D04 | 驱动连接护栏：单请求期限 10 s（`requestTimeoutMs`，默认 “abort” = 断连）、写一帧 10 s（`WRITE_TIMEOUT`）、在途请求 ≤128、被放弃的请求 ≤64、对端请求 id ≤4096、**单帧 16 MiB**（`NATIVE_FRAME_BYTES`，入出各一）、stderr 诊断 64 KiB（最近 32 KiB） | `json-rpc-process.ts:42,133,164,232,342,347,361,387`；`binding-factory.ts:288-289` | `REQUEST_TIMEOUT`、`FRAME_LIMIT`、`REQUEST_LIMIT` 都是**断连**，回合失败 | 卡死的 Harness 进程可挂起整个回合；一帧无界会吃光内存（这是单帧界的真实理由） | 请求期限改成“提示并可继续等”而不是断连；单帧界调到数百 MiB，或改流式解析（大图/整文件内联进一帧是 16 MiB 界的主因，A28）。**调大前先改入站拼帧**：`read()` 每收一块就 `Buffer.concat([this.input, part])`（`json-rpc-process.ts:363`），每块都复制已累计的全部字节，帧越大越接近平方，要换成块列表 |
| D05 | 启动与握手期限：`SESSION_SETUP_MS` = 60 s、`NATIVE_IMPORT_MS` = 120 s、`CATALOG_READ_MS` = 20 s、`TITLE_DEADLINE_MS` = 2 s、`RELAY_READ_MS` = 2 s、`COMMANDS_WAIT_MS` = 1.5 s、`CLOSE_SESSION_MS` = 2 s；同时进行的模型发现 ≤8（`MODEL_LIMIT`） | `acp.ts:46,57,59`；`binding-factory.ts:28`；`src/web/harness-models.ts:12,29,77`；`relay-turn.ts:112`；`runtime.ts:24` | 超时即失败（`NATIVE_CATALOG_TIMEOUT` 等） | 冷启动慢的 Harness（插件、MCP 多）可能拖很久，不设期限就无限等 | 保留，**“超时就失败”改成“提示还在启动，可继续等”**；模型发现并发调大 |
| D06 | 进程关闭与回收：`closeGraceMs` = 1.5 s（可配 1.5–30 s）、`closeOutsideWaitMs` = 10 s、关闭链 SIGTERM → 等一个 grace → SIGKILL → 再等一个 grace；取证用的 `OUTSIDE_COMMANDS` 16、`OUTSIDE_DEPTH` 32、`OUTSIDE_LIMIT` 256 | `src/contracts/native-host.ts:364-365`；`src/infrastructure/control/host-shutdown.ts:11,65-76`；`process-group.ts:36` | 先关输入，过了 grace 发信号 | 不回收会留僵尸进程 | **保留**；1.5 s 对要在退出时写转录的 Harness 偏短，建议默认调到 5–10 s |
| D07 | 并发创建 / 待决审批：`MAX_PENDING_CREATES` = 16（`CREATE_LIMIT`）；待决审批 ≤32（`PERMISSION_LIMIT`，runtime 与各驱动各一处） | `runtime.ts:138,311,349,1290`；`acp.ts:959,1005`；`codex.ts:1005`；`pi.ts:281` | 超了拒绝；驱动那处是**中止回合** | 无界会堆内存 | **保留，调大**：并行子 Agent 同时问 32 个以上时碰得到，碰到就中止回合，代价太大 |
| D08 | 宿主 TMPDIR：每个宿主类的临时目录 ≤256 MiB / ≤4096 项，超了在该类没有存活宿主时**整个清空**；7 天没用的整类删除；清扫锁等 2 s | `native-host.ts:347,365-367`；`host-tmpdir.ts:55,57`；`src/cli/session-application.ts:129-137` | 清空 | 磁盘被 Harness 的临时文件撑满 | 清的是 Harness 的临时文件（用户内容不在这里），但长任务跨回合依赖的临时文件会被清。改成只提示、按磁盘剩余再清 |
| D09 | 内容库回收：未被引用的内容 7 天（`CONTENT_RETENTION_MS`）、半截上传 1 小时 | `content-store.ts:14-15,226-253` | 回收 | 孤儿堆积 | **保留**：只收没被任何对话引用的，不碰被引用的内容 |
| D10 | 快照缓存 `MAX_SNAPSHOT_CACHE_BYTES` = 96 MiB | `src/infrastructure/session/snapshot-cache.ts:4` | LRU 淘汰 | 内存涨 | **保留**；存储改造后缓存对象变小 |
| D11 | 迁移备份只留最新 2 份（`BACKUPS_KEPT`） | `sqlite-store.ts:129` | 删最旧的 | 磁盘 | 保留；v14 迁移须“先备份、成功后才迁”（ADR-049 的做法） |
| D12 | Hub 读回工具的 HTTP：请求 30 s（`REQUEST_MS`）、回复 ≤8 MiB（`MAX_REPLY_BYTES`）、仅环回 + 令牌、秘密缓存 60 s / 失败 10 s | `src/cli/hub-tools.ts:30`；`table-routes.ts:42` | 超时/超限即该次工具调用失败 | 卡住的请求拖住 Harness 的工具调用 | 保留 |
| D13 | 管家下载与执行：产物 ≤512 MiB、安装脚本 ≤1 MiB、元数据 ≤2 MiB、解包 ≤1 GiB 与 10 万项、进程输出 ≤8 MiB（升级）/ 4 MiB（卸载）/ 64 KiB（版本探测）、单任务超时 10 分钟（Homebrew 15 分钟、npm 序列每跳 1 小时、doctor 30 分钟）、体检并发 ≤4、检查间隔 15 分钟 | `management/download.ts:6`；`official-install.ts:15`；`archive.ts:20`；`service.ts:55-59,130,1375`；`native.ts:83` | `DOWNLOAD_LIMIT`、`ARCHIVE_LIMIT`、`OUTPUT_LIMIT`、超时 | 下载失控、磁盘撑满 | 保留；512 MiB / 10 分钟对个别大安装包偏紧，调大 |
| D14 | 能力管家的读写护栏：配置 ≤32 MiB、文档 ≤1 MiB、技能说明 ≤256 KiB；GitHub 取技能：压缩包 ≤64 MiB、解开 ≤256 MiB、≤20,000 项、深度 40、60 s；每文件备份 10 份 / 32 MiB；目标文件 ≤8 MiB | `capabilities/scan.ts:16-18`；`github.ts:20-21`；`store.ts:8`；`files.ts:7`；`capabilities.ts:283` | 拒绝/标 `truncated` | 撞坏用户目录、下载失控 | 保留（A39 说了其中偏紧的两项） |
| D15 | Provider 探测：5 s 超时、≤1 MiB、并发 ≤16、视图 ≤64 KiB | `provider/service.ts:12-16` | `PROBE_LIMIT` 等 | 探测卡住 | 保留 |
| D16 | 发现：登录 shell 3 s / 64 KiB / 64 个目录；搜索目录 ≤128；包根 ≤64、深度 6、站点条目 ≤8192、manifest 64 KiB | `discovery/login-shell.ts:9`；`search.ts:6`；`packages.ts:8-20`；`catalog/domain/discovery.ts:1-2` | 超了截断或失败 | 扫盘失控 | 保留 |
| D17 | 命令行缓冲：输入累计 ≤2 MiB（超了整个 chat 会话收尾）、输出 ≤16 MiB | `src/cli/bounded-streams.ts:4-5`；`src/cli/chat.ts:45` | `INPUT_LIMIT` / `OUTPUT_LIMIT`，会话结束 | 慢接收者堆内存 | 次要入口；输入累计界去掉，输出改背压 |
| D18 | 诊断收集：每回合 stderr 4096 字节、只留最近 64 个回合；诊断文本 ≤64 KiB | `runtime.ts:159,673`；`src/web/run-diagnostics.ts:5` | 截断 | 仅诊断，不是用户内容 | 保留 |
| D19 | 原生目录缓存：24 小时 TTL、文件 ≤4 MiB、≤32 个目录 / 128 就绪项 / 512 个探测会话 | `src/web/native-catalog-cache.ts:14-18` | 淘汰旧项 | 缓存膨胀 | 保留 |
| D20 | 内存索引：`busyHolders` 256 条、relay 决定缓存 64 个对话 | `runtime.ts:1072`；`src/web/relay-routes.ts:97` | 淘汰最旧 | 内存涨 | 保留（只是索引，不碰用户内容） |
| D21 | **落盘校验里的字段长度界（字节），与上游按字符数截断不一致**：工具标题 4096 字节、工具 id 512、通知标题 1024 / 详情 4096、活动标题 1024、计划步 4096、模型 1024 字符等；而驱动用 `label()` / `line()` 按 **UTF-16 单位** 切到 4096（`acp.ts:63-67`、`codex.ts:90`），Runtime 在把工具标题交给 `commit` 前**不再夹一次**（`runtime.ts:1318`） | `state.ts:136-152,210-214`；`acp.ts:63-67,887`；`codex.ts:90`；`runtime.ts:1318` | 一个超过 4096 **字节**的工具标题（例如含多字节字符的长命令）→ `parseSession` 抛 `INVALID_DATA`；`INVALID_DATA` 不在“预期失败”名单（`runtime.ts:163`），`commit` 的 catch 调 `this.fail`（`runtime.ts:957`）→ **整个 Runtime fatal**【码：路径读通，未复现】 | 校验若不拒绝，坏数据会落盘 | **写入方按字节夹住再提交；外来文本只截断不拒绝**（ADR-057 初稿 `dee209e` 第 6 节写过这个原则；重写后的 ADR 和 step2-plan 里没有，搜“夹住、外来、致命、fatal”无命中）。这是“限制去不掉的那种护栏”：校验器要保留，但不能把外来数据当成可以拒绝的输入 |
| D22 | 页面内存与浏览器存储：详情缓存 400 条（`web/src/lib/turn.ts:342`）、已显示回合记录 500（`:371`）、侧栏项目展开状态 ≤200 项 / 64 KiB（`web/src/components/Sidebar.tsx:98,106`）、草稿 sessionStorage ≤256 KiB（`web/src/App.tsx:82,542`，A35）、页面读响应 ≤16 MiB（`web/src/api.ts:913`） | 同左 | 淘汰最旧；草稿存不下时提示 | 页面内存涨、浏览器存储写失败 | 保留（只是页面本地缓存，不碰服务端内容）；详情缓存 400 随条目表消失 |
| D23 | 接口入参的字段长度：目录 ≤4096 字节、名称 64 / Harness 与控制标识 96 / 命令 id 128、原生会话 id ≤1024、子 Agent 描述 ≤8192 与提示 ≤64 KiB（接口）。**子 Agent 提示在能力层另有 32 KiB 的界（`SUBAGENT_PROMPT_BYTES`）**，两处口径不一致：32–64 KiB 的提示过得了接口、过不了能力层 | `src/web/server.ts:126-131,147,612,647,1008`；`src/infrastructure/capabilities/subagent-definitions.ts:16` | 400 `INVALID_INPUT` / 能力层拒绝 | 校验是入参形状护栏 | 保留；子 Agent 提示两处口径对齐（跟随能力层，调大） |
| D24 | Driver 里的节流与重试：审批提前量 `APPROVAL_DEADLINE_MARGIN_MS` = 2 s（对方宣告的审批期限提前这么多结算）；Codex 中断重试 `INTERRUPT_RETRY_MS` = 250 ms；Hermes 导出 5 s / 8 MiB；Pi 探测 150 ms；一次性原生命令行（`nativeCommand`）单次期限 = 请求期限 10 s、输出 ≤16 MiB（超了 `REQUEST_TIMEOUT` / `OUTPUT_LIMIT`） | `acp.ts:44`；`codex.ts:84`；`hermes.ts:38`；`pi.ts:70`；`src/infrastructure/control/native-command.ts:13-16` | 超时/超限即该次调用失败 | 卡住的子进程 | 保留；一次性命令的 10 s 对慢命令偏短，可按命令设 |


## 3 你点名的几件，逐个给结论

### 3.1 一个回合的时间预算（A21、A22、A23、A24）

**结论：到期真的会取消正在干活的回合；默认 5 分钟，所以一个要跑十几分钟的编码任务会在第 5 分钟被叫停。**

- 预算从回合开始就计时（`runtime.ts:1537-1538`，注释写“starting the program, its model, tools and result”），**等用户决定的时间不计**（`enterWait` 暂停执行预算，`:1234-1243`）。到期走 `expire()`（`:1256-1273`）：先把已流出的文字提交，写“执行期限已到”通知和 `run.budget_expired` 事件，再 `stop()`。
- 之后分两种：原程序在 `STOP_GRACE_MS`（15 s）内结算 → 回合 `cancelled`、错误码 `RUN_TIMEOUT`（原程序报的 `completed`/`cancelled` 单独记在 `backend`，`parallel-work.test.ts:181-190`）；不结算 → 杀进程，回合 `unknown`，对话 `blocked`，要用户“核实并恢复”（`parallel-work.test.ts:216-225`，前端文案 `web/src/api.ts:978`）。两种都**不自动重跑**，原程序已做的文件改动留在磁盘上。
- 真机记录（2026-10-11，Claude Code，`--execution-budget 30`，前台 `ping -c 60`）：30.005 s 到期，0.86 s 后 `cancelled`，ping 进程被带走，下一条消息正常（`docs/verification/first-chain-polish-2026-10-11.md:459-461`）【档】。
- 配置上能到的最大值：执行 **1 小时**、等待 **2 小时**（`resolveTurnBudgets` 超界直接 `INVALID_INPUT`，`session.ts:433-443`）；所以“配大一点”最多到 1 小时，**“干活”累计超过 1 小时（不含等你决定的时间）的回合在任何配置下都跑不了**。外面再套一层 4 小时的驱动期限（A23），它在 Hub 两个预算都去掉之后会成为唯一的墙。
- 等待预算（30 分钟）管得更宽：不只是等审批，**还包括同一工作区里等别的对话让位**（`joinQueue`，`:1052-1090`）。到期后这条输入整个失败（`WORKSPACE_BUSY`，“没有发出”），不是取消。
- 4317 守护进程现在实际用什么值：**没核对**（启动日志会打印，`src/cli/web.ts:48`，我没读真实日志）。
- **建议**：① 到期改成提示（“已运行 N 分钟，仍在工作”+“停止”），不自动停；② `--execution-budget` 留作可选自动停止，默认关，去掉 1 小时上限；③ 去掉 4 小时硬顶（改“长时间没有任何事件”提示）；④ 审批、提问由 Hub 不再过期（对方 Harness 自己的到期保留，C04）；⑤ 等工作区改成一直排队、可取消、不失败；⑥ 与 A25（名额）、A05（事件）联动检查，见 3.2、5.3。

### 3.2 `MAX_PARALLEL_CONVERSATIONS`（A25）

**结论：固定 4，生产里没有入口可改；超出的是排队不是拒绝，但排队没有自己的期限。**

- 值在 `contracts/session.ts:419`；运行时 `this.options.maxParallel ?? MAX_PARALLEL_CONVERSATIONS`（`runtime.ts:1025`）；只有测试往里注入 `maxParallel`；宿主预算里的 `maxParallel`（`native-host.ts:361`，1–16）解析了但**没有传给运行时**（`src/cli/session-application.ts:129,147-148`）。启动日志写 “up to 4 conversations run at once”（`cli/web.ts:48`）。
- 排队的回合进 `waitingForSlot`（`:1093-1100`），事件 `run.waiting` kind `slot`，**不设期限**——注释（`web/src/components/Turn.tsx:227`、`runtime.ts:1089-1092` 的注释）写的理由是“每个在跑的回合都受预算约束”。**这条前提会在去掉 A21 时失效**：4 个一直在干活的对话会让第 5 个无限排队。
- 另有“同一工作区同时只跑一个对话”（`holders`，`:1016-1033`）：后到者进 `waitingForWorkspace`，满等待预算失败（A22）；不同 Gateway 进程之间还有工作区租约（`src/infrastructure/session/workspace-lease.ts`）。
- **A 还是 D**：A 的理由——用户要同时开几个编码任务；4 是拍的数字（注释写“the same as the kept-process limit”），没有测量依据。D 的理由——每个 Harness 是一个重进程，无上限会耗尽内存；宿主池的设计里有“物理内存的 1/8”的内存预算（`native-host.ts:409`），但宿主池没落地。
- **建议**：去掉固定数，默认不限（或默认 ≥16）；真要约束就用内存预算，由用户设。同工作区互斥：A 的理由——想在同一仓库开两个对话（一个读一个写）；D 的理由——两个 Harness 同时写同一棵树会互相踩。按“拦截改提示”，**改成提示**（“另一个对话正在这个目录里工作”，用户选继续或排队），不要排队到失败。

### 3.3 工具超过上限后“新工具被静默丢弃”（A11）

**结论：确认，读码与现成测试都证明。**

- `runtime.ts:1314`：`if (index < 0 && tools.length >= MAX_RUN_TOOLS) return;`——发生在**存详情之前**，所以第 129 个起的工具既不进 `tools`，也不进内存里的 `details`，也不写 `run.output` 事件。Hub 里**没有任何痕迹**，只有原生 Harness 自己的转录里有。
- 同一个回合里，已有 id 的**更新**仍然处理（`index >= 0` 时不返回），所以前 128 个工具的状态正常走完，只是第 129 个起整条消失。
- 后果：界面“运行 N 条命令”偏小；Harness 经读回工具看不到后面的工具；接力交接单看不到；新协议的投影（`projectTurn` 遍历 `run.tools`）看不到；“本回合改了哪些文件”（计划在第 2 步之后做）会漏。
- 现成测试**专门断言它被丢**：`tests/integration/session-runtime.test.ts:691-698` 造 140 个，断言 `run.tools.length === 128` 且回合照常完成；`tests/unit/relay-packet.test.ts:388` 按 128 造数据。所以要去掉，这两处测试要一起改。
- 另外四处同类静默丢弃：通知 32（A12）、活动 64（A13）、产物 32（A14）、计划步 64（A15）。
- 工具之外还有一个更早的墙：ACP 驱动自己记工具 id 的表上限 4096（A18，`TOOL_LIMIT` 会中止回合）。去掉 Hub 的 128 之后，下一个撞到的是它。

### 3.4 工具输入、输出、diff 的预览字节（A16）：被截掉的部分还能取回吗？

**结论：不能。**

- 截断发生在 `mergeDetail()`（`runtime.ts:113-123`）里，**在 `storeDetail()` 把详情写进内容库之前**；内容库里存的就是已截断的 JSON，带 `truncated: true`。Hub 没有存全文，也没有“回头去读原程序转录”的代码。
- 驱动还可能先切一刀：Codex 把命令输出先留尾 128 KiB（`codex.ts:74,92`），OpenClaw 补记路径用 `cap()`（`openclaw.ts:122,159`）。ACP 驱动自己不切，但单帧 16 MiB（D04）是它的上界。
- 读回工具对被截的详情会写“Hub 把这个详情按大小限制截了（输出留最后 64 KiB、输入留最前 16 KiB、diff 留最前 64 KiB），所以可能不完整”（`src/contexts/session/domain/table.ts:306`）——诚实，但取不回。
- **后果**：交接单能“指给新 Harness 去读回”的，也只有这 16/64/64 KiB；一个跑了几百 KB 输出的命令，前面的输出永远丢了。
- **建议**：存储改成“预览 + 全文”两层：条目行里留头/尾各几 KiB 做一行预览，完整输入/输出/diff 作为整块存下，读按页（读回工具的 `offset`/`limit` 已经是这个形状）。全文上限只剩磁盘；内容库“单项 20 MiB”（A29）也要改成分块或去掉。**先要解决的内存问题**：现在 `execution.details`（`Map<string, NativeToolDetail>`）把详情整个放内存直到写盘（`runtime.ts:41` 的注释），去掉截断后必须改成边收边写文件。
- T3 的做法（4）：命令输出的持久化尾巴是 64 KiB（同样会丢前面的，`CommandOutputHub.ts:87-101`）；文件改动的 diff **存储时**就截到 32 KiB（`WireProjection.ts:54`）；输入和其它工具输出是在**传输**时才按“列表 32 KiB / 详情 256 KiB”截（`WireProjection.ts:27,29,242-263`），它们在存储里是否全文我没逐个核【推】。所以“对命令输出和 diff 也存全文”比 T3 更进一步，是 ADR-057 有意的取舍。

### 3.5 事件日志的上限与回收（A05、A06）

**结论：三个上限（每对话 16,384 条、32 MiB、单条 ≈2 MiB），没有任何回收，撞到之后果和快照上限一样重。**

- 事件只追加，唯一的删除是 `deleteSession`（`sqlite-store.ts:436-445`，要求对话已 `closed`），**Web 没接这个入口**，只有测试用（`relay-store.test.ts:474`）。内容库有 7 天回收（孤儿）、迁移备份留 2 份，但事件没有。
- 每个流式窗口（100 ms 或 16 KiB）就是一条 `run.output` 事件，同时一次整份快照重写（B02）。去掉时间预算而不改这个，长回合会更快撞 16,384。
- 撞到之后：每次提交都被拒（`EVENT_LIMIT`）。回合结尾的那次提交被拒会走 `catch → this.fail`（`runtime.ts:1982`）→ **整个 Runtime fatal**（`admit()` 对所有对话拒绝，`:873-876`）。这条路径 `docs/proposals/relay/round1/r4-internal-baseline.md:429`（D17）已经作为“推断”记过，我读通了代码路径，没有复现。
- 事件的**读者**要在回收前清点：v13 迁移只读九种事件（`sqlite-store.ts:151`）；relay 视图和决定账本回放事件（`src/web/relay-routes.ts:122-154`）；诊断路由扫事件（B09）；SSE 重连用游标。
- **建议**：① 文本窗口事件不再带正文（ADR-057 3.5 已定：只记 `{runId, item, chunk, bytes}`）；② 取消三个上限，事件全留不修剪（ADR-057 3.5 已定，理由是顺序证据；T3 只留至少 1 天的重放尾巴、更老的游标用快照重新同步，`ProjectionMaintenance.ts:42,256`，是备选，不是必须）；③ **先做、不依赖存储改造**：让 `EVENT_LIMIT`/`SESSION_LIMIT` 不再进 `fail()`（只让该对话读写受限，不拖垮所有对话）。

### 3.6 会话列表、搜索、导出、读回工具各自的上限

| 功能 | 上限 | 到限会怎样 | 建议 |
|---|---|---|---|
| 会话列表 | 最新 100 个；一次读合计 ≤8 MiB；无游标（A30） | 第 101 个起不在任何列表里；合计超 8 MiB 则 `/api/v1/state` 整个 429 | 改分页 + 轻量摘要（依赖存储） |
| 搜索（页面） | 命令面板只在本地已载入的 `state.sessions` 里按标题/工作区过滤，最多 200 个对话（`web/src/App.tsx:1012`）；**没有跨对话的正文搜索** | 第 201 个以后的对话搜不到 | 与列表一起改分页；正文搜索是新功能，不是现有上限 |
| 搜索（读回工具 `hub_search`） | 词 ≤200 字、最多 50 处、无偏移、一次请求最多读 400 个详情、合计 32 MiB（A34） | 超出的命中取不到，计入 `unsearched` | 加偏移；详情随条目表走索引 |
| 导出 | 整个对话在内存里拼成 JSON/Markdown，≤8 MiB（A31），不含内容库字节 | 413 `RESPONSE_LIMIT` | 流式导出（依赖存储） |
| 读回工具 `hub_turns`/`hub_read_turn` | 目录 40/100 回合、单页 12,000/40,000 字符，有 `from`/`offset`（B05） | 无拒绝，只是页 | 保留 |
| 原生会话列表（导入用） | 已走游标分页（B06） | 无 | 保留；ACP 导入要翻前 20 页才确认 id（A10），改成按 id 取 |

### 3.7 接力交接单的预算：哪些是对方的（C），哪些是我们自己定的（A）

- **对方的（C）**：目标模型的上下文窗口（`usage.context.size`，`windows.ts:29-37`）；入口输入界——Codex 1,048,576 字符、OpenClaw 2,097,152 字节（我们的 Driver 声明的，数值来源我没查，C05）。
- **我们自己定的（A33）**：单包封顶 **8000 tokens**（`budget.ts:26`）；不超过目标窗口的 **5%**（`:27`）；目标没报窗口时**假设 128,000**（`:28`）；用户原话份额 **2500** tokens（`:29`）；窗口预留 4096 与固定前缀 8000（`windows.ts:14-16`）；一条引用行 ≤4000 字符、失败命令输出摘录 20 行/1200 字符（`narration.ts:117-120`）；读回工具详情时只取“第一个欠账回合 + 最近 12 个”、每回合 ≤32 个、合计 ≤128 个、每个 ≤256 KiB（`runtime.ts:2204-2215`）；存储界 256 KiB/包、64 MiB/对话（`relay.ts:38-39`）。
- **行为**：从不拒绝输入。历史多长都不进预算；放不下的整条省略，账里写明省略了什么；最小的包也放不下时，原样发用户的话（`runtime.ts:1707`，并有 `relay.decision` 的原因）。所以交接单**不会让功能做不了**，它的代价是**新 Harness 看到的只是 ≤8000 tokens 的摘要**；其余只能靠读回工具按需取（Claude Code、Codex 已接；OpenCode、DeepSeek Harness 未接，Hermes 要按会话传入，OpenClaw 暂时不能，见 `docs/decisions/LOG.md` 2026-11-11 条），而读回工具能取到的又受 A11/A16 的截断与丢弃限制。
- **建议**：8000 调大并做成可配置（T3 默认 16,000，环境变量可设，夹在 1,024–64,000，`handoffBudget.ts:14-19`）；窗口 5% 与假设 128,000 是策略值，可保留；`RELAY_SESSION_BODY_BYTES`（64 MiB）和 `RELAY_BODY_BYTES`（256 KiB）去掉或改成派生值；`relayDetails` 的“最近 12 个回合”改成按预算取。

### 3.8 附件的个数与大小（A28）

- 现值：8 个、单件 20 MiB、一条消息合计 32 MiB（`content.ts:8-11`），页面与服务端各校验一遍（`Attachments.tsx:19-21`、`content-store.ts:106,132`）。文件交给 Harness 的是**只读副本的路径**（`fileMentions`，`attachments.ts:30-34`），文本小文件（≤256 KiB 且 Harness 声明支持）内联为资源，图片/音频内联 base64（`acp.ts:48,413-433`）。
- 对照 T3（4）：100 个、单张图 10 MiB 且合计 80 MiB、其它文件 50 MiB。**我们的个数上限只有它的 8%，单个文件上限是它的 40%（图片是 2 倍）。**
- 暗坑：图片内联 base64 受 16 MiB 单帧界限制，12–20 MiB 的图片会在发出时断连（A28，【推】）。
- **建议**：个数去掉，字节上限调到 T3 量级；大图改走文件路径；服务端流式上传已经是（`stage` 流式写盘），不需要改。


### 3.9 对 ADR-057 第 3.7 节的核对（`docs/decisions/0057-ordered-turn-items.md`，集成分支 `8edc426`）

我把 3.7 的每一行对到本清单的出处与行为，**覆盖到的都与代码一致**（A01–A09 的 Hub 级部分、A11–A16、A28 的常量、A29、A31 的响应界、relay 的 seq/回合界与 64 MiB；事件三个上限在 3.5）。下面是**没覆盖**和**需要改口径**的部分。

**一、3.7 的分类要改的两处**

| 3.7 里的写法 | 核对结果 | 建议 |
|---|---|---|
| ③ 把“执行与等待预算（ADR-036）、并行对话 4、保留进程 4、审批 32、单帧 16 MiB、累计 256 MiB”都归为“对 Harness 子进程的守护，是资源守护不是对话大小，超了回合如实失败，不静默截断” | 后两项（单帧、累计）和审批 32 确是这种性质；但**时间预算和并行名额不是**：时间预算到点会取消**正在正常干活**的回合（A21–A24，3.1），并行名额让第 5 个对话排队且排队没有期限（A25，3.2）。`docs/decisions/LOG.md` 2026-11-12 条已点名“回合的时间预算、并行对话数、每轮工具条数等”要清点后去掉或改成分页，保留别的护栏要写明理由 | 3.7 的 ③ 拆开：单帧/累计/审批 32 留作 D 类并写理由；时间与并行按 3.1、3.2 处理，不要写成“如实失败” |
| ① “relay 的预算由窗口推出（`windows.ts`）”归入“不是我们设的限制” | 窗口本身是对方的（C01），**但 8000 tokens、5%、假设 128,000、2500、窗口预留 4096、固定前缀 8000、最近 12 个回合/每回合 32 个/合计 128 个/每个 256 KiB 的读回界都是我们定的**（A33） | 把这些列进 3.7，决定调大与可配置（T3 默认 16,000，3.7、4） |

**二、3.7 没有列出的限制（按本清单编号）**

| 编号 | 没覆盖的内容 | 为什么要管 |
|---|---|---|
| A08（同类） | 对 Harness 提问的自由回答 ≤64 KiB（`runtime.ts:263,269`、`server.ts:822`） | 用户的内容，超了 `INVALID_INPUT` |
| A10 | 导入原生会话的**驱动级**界：ACP 回放 4 MiB / 2000 条、`REPLAY_LIMIT` 64 MiB、翻列表 20 页（超过就导不进来）；Codex 8 页 × 50 回合 / 400 条；`NATIVE_IMPORT_MS` 120 s。3.7 的“导入全存”只指 Hub 引用的 200 条 / 512 KiB | Hub 全存也没用，驱动先切了 |
| A17–A20 | 用量明细 64 条；ACP 工具 id 表 4096（`TOOL_LIMIT` 中止回合）、Codex 回合/消息 4096、外来线程 1024；原生命令 2048（协议失败）/ 技能等 512 / 菜单 50、60；OpenClaw 补记窗口 200 | 去掉 Hub 的 128 之后，**下一个撞到的就是驱动里的 4096**（A18） |
| A21–A24 | 执行预算 300 s、等待预算 30 min、4 小时驱动硬顶、15 s 停止宽限 | 见上 |
| A26 | 保留进程空闲 30 分钟、第 5 个静默不保留（界面无提示） | 3.7 只提了“保留进程 4 个” |
| A28 | 图片内联 base64 与保留的 16 MiB 单帧冲突：去掉附件常量后，12–20 MiB 的图片会在发出时断连 | 3.7 同时“去掉附件常量”和“保留 16 MiB 帧”，两条要一起想 |
| A30 | 对话列表 `list(100)`、`limit` 1–100、**无游标**：第 101 个起不可见。3.3 的读者表（`:99`）只写“读 `sessions` 的列”，没写分页 | 要明写：列表带游标，去掉 100 |
| A32 | SSE 会话流同时 ≤8 个（D02）；帧界由 3.4 的增量帧取代，连接数没提 | 页签多了 429 |
| A34 | 读回工具：搜索最多 50 处且无偏移；一次请求读详情 300 / 200 / 400 个、合计 32 MiB | 3.3 说“接力读者改查询”，搜索偏移要明写 |
| A35 | 界面写死的数字：改动页 40、斜杠菜单 50、命令面板 60/200、relay 视图解码 64/512、草稿 256 KiB；页面解码器里镜像的上限（`web/src/api.ts:366-370,395-396`、`web/src/session-stream.ts:208`、`web/src/lib/protocol/decode.ts:71,85,135`） | 3.7 的第七节说“前端归 proto-web 判断”；初稿里“两边上限一起改”这句在重写后没了 |
| A36 | 第 1 步新增的读侧：思考 `REASONING_MAX` = 64 KiB 截断；每次生成视图同步读最多 400 个详情文件；页面解码一个回合 ≤4096 条目 | 与“不截断”冲突；是新增的耗时点（5.7） |
| A37–A39 | 管家（任务表终身 ≤2048 行且不回收）、Provider（超界启动失败）、能力管家（技能 ≤64 MB / 4000 个文件被拒） | 所有者说“包括其他功能” |
| D01、D02–D07、D21–D24 | HTTP 入口的超时与并发、登录 8 小时、驱动连接期限（10 s 断连）、握手期限、关闭宽限、待决创建、字节/字符口径不一致、页面内存界、入参字段界、Driver 节流 | 都是“保留需写理由”的护栏，3.7 没逐项 |
| D08–D20 | 宿主 TMPDIR 清空、内容库回收期、迁移备份留 2 份、管家下载界、能力读写界、Provider 探测、发现、CLI 缓冲、诊断、目录缓存 | 同上 |

**三、一个可以直接补进 3.7 的说明**：A04、A05、A09 的撞墙后果（回合结尾那次提交被拒、或分支超界，会走 `fail()`，整个 Runtime fatal）只有 `docs/proposals/relay/round1/r4-internal-baseline.md:429`（D17）作为“推断”记过；ADR-057 初稿（`dee209e`）只写了“上限类错误只让提交失败”，重写后的 ADR 和 step2-plan 都没提。第一段上线前如果旧库里已有逼近上限的对话，这条路径仍然存在（`runtime.ts:1982`、`:578`），见 6 的止血项。

## 4 对照 T3 Code

T3 克隆在 `<草稿目录>/research/t3code/`（提交 `b883156e`，2026-11-10）；下表出处相对其仓库根。“没找到”指在 `apps/server/src`、`packages/*` 里搜过相应模式没有命中，**不是证明它不存在**。

| 事项 | 我们现在 | T3 Code | T3 出处 | 参考价值 |
|---|---|---|---|---|
| 用户消息长度 | 64 KiB，超了拒（A08） | 120,000 字符；**超长的粘贴自动折成文本附件**，仍放不下才提示“缩短或拆分” | `packages/contracts/src/chatAttachment.ts:13`；`apps/web/src/components/chat/useComposerAttachmentIntake.ts:359-395`；`composerSubmission.ts:12-25` | 高：用附件接住超长内容，而不是拒绝 |
| 附件 | 8 个 / 单件 20 MiB / 每条 32 MiB（A28） | 100 个；图片单张 10 MiB、一条消息的图片合计 80 MiB；其它文件（含视频）50 MiB；HEIC 转 JPEG、超限图片自动缩小 | `chatAttachment.ts:14-17`；`docs/user/composer.md:40-61` | 高 |
| 线程/回合/条目总量 | 256 回合、8 MiB、16,384 事件（A01–A06） | **没找到总量上限**（搜 `MAX_TURNS`、`MAX_ITEMS`、`MAX_MESSAGES`、`MAX_RUNS`、`MAX_EVENTS`、`MAX_THREAD*` 只命中无关项）。历史按窗口分页：一页至多 10 个用户回合、一个用户回合内 500 行、其余窗口 75 行、编码后 ≤1 MiB；更早的页 20 个用户回合；游标不透明；工作条目超过 150 个在窗口里折成占位，展开再取 | `apps/server/src/orchestration-v2/threadHistoryPaging.ts:16-25`；`packages/contracts/src/orchestrationV2.ts:3881,3895` | 高：这是“改分页”的样板；ADR-057 3.4 已按同一组数字 |
| 对话列表 | 最新 100 个、无游标（A30） | 较早的已结算线程按 `settledAt` 游标分页，一页 0–50（`limit: 0` 只读各项目计数） | `orchestrationV2.ts:3810-3830` | 高 |
| 命令输出保留 | 输入头 16 KiB / 输出尾 64 KiB / diff 头 64 KiB，截在写入前（A16） | 命令输出：终端尾巴 **64 KiB 字符**（`TERMINAL_OUTPUT_TAIL_CHARS`）；持久化的也是“最近 256 KiB 原文规范化后的尾巴”加 `truncated` 标记；实时输出不进事件库，同时在播 ≤64 个、结束后留 ≤16 个；**文件改动的 diff 存储时截到 32 KiB**；列表投影每串 32 KiB，按需详情 256 KiB | `packages/shared/src/terminalOutput.ts:39`；`CommandOutputHub.ts:38-41,87-101`；`WireProjection.ts:27,29,54,242-263` | 中：T3 对命令输出也只留尾 64 KiB；“全文”是我们比 T3 更进一步的选择（ADR-057 的决定） |
| 事件保留 | 永不删（A05/A06）；ADR-057 3.5 定为全留 | 只保留**至少 1 天**的重连重放尾巴，更老的游标用快照重新同步；幂等回执不删 | `ProjectionMaintenance.ts:42,254-283` | 中：与 ADR-057 3.5 选择不同，二者都消除了“上限致命” |
| 回合执行时间 | 默认 5 分钟取消（A21） | **没找到每回合执行时间预算**（搜 `turnTimeout`、`RUN_TIMEOUT`、`executionBudget`、`maxDuration`，在 `apps/server/src`、`packages/provider-*`、`packages/contracts` 无命中）。有的时间类：Provider 会话**空闲** 30 分钟关闭；Claude 停止确认 10 秒；后台任务移动 5 秒；`OrchestratorMcpService` 等待工具最长 1 小时 | `ProviderSessionManager.ts:59`；`Adapters/ClaudeAdapterV2.ts:350,352`；`apps/server/src/mcp/OrchestratorMcpService.ts:134` | 高：T3 不给回合设时间墙；它的“停止确认 10 秒”对应我们的 15 秒宽限（A24） |
| 并行线程 | 4（A25） | **没找到线程并发上限**（只有 HTML 渲染浏览器 2、设备会话 1–20 这类与对话无关的） | `apps/server/src/htmlRender/HtmlRender.ts:361`；`packages/contracts/src/device.ts:59` | 高 |
| 工具条数 | 128，静默丢（A11） | **没找到每回合工具条数上限** | — | 高 |
| 交接预算 | 8000 tokens，不超窗口 5%（A33） | 默认 **16,000 tokens**；环境变量 `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` 可设，夹在 1,024–64,000 | `packages/provider-core/src/server/handoffBudget.ts:14-19` | 中：2 倍，且可配置 |
| 导入原生会话 | 引用 200 条 / 512 KiB；ACP 翻前 20 页（A10） | ≤200 条消息、历史 ≤32 MiB、一次最多 100 个转录；扫描有单源上限 | `apps/server/src/project/AgentSessionScanner.ts:59-76` | 低/中：条数同为 200，字节上限高 64 倍 |
| 用量到顶 | 只翻译成提示（C02），不自动续 | `usage_limit` 失败带重置时间时，可在重置后自动续（`autoResume` 设置）；等待最长 24 小时 | `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:15-40` | 低/中：额度类失败的“自动续”可作为以后的功能，读到的只是入口，逻辑没细读【推】 |
| 实时流缓冲 | SSE 帧 ≤8 MiB，超了静默断开（A32） | 每个订阅者的实时缓冲 ≤1,000 项 / 8 MiB，超了该订阅流以 `LiveStreamBufferError` **显式失败**（`ThreadLiveEventCoalescer.ts:220`、`persistence/OrchestrationEventStore.ts:748-752`；客户端怎么恢复我没细读）；提交批 ≤64 个事件 / 1 MiB；实时更新 50 ms 合并、待合并 ≤512 | `LiveStreamBudget.ts:18-19`；`ProviderCommitBatch.ts:12-13`；`ThreadLiveEventCoalescer.ts:18-19` | 中：同样是 8 MiB，但超了是显式报错，不是静默断开 |

T3 里**最值得照抄的五条**：① 超长输入折成附件而不是拒绝；② 历史按“10 个用户回合 / 1 MiB”分页，游标不透明，工作条目超过 150 个折占位；③ 对话列表按游标分页；④ （据我搜到的）不给回合设时间墙、不给线程数设上限，只在会话空闲时回收；⑤ 交接预算默认 16,000 tokens 且可配置。**不要照抄**的一条：T3 对命令输出与 diff 在存储时也截断，而 ADR-057 已决定存全文。

## 5 去掉之后会暴露什么，以及哪些必须等存储改造

下面每一条都是“去掉某个上限后，别的东西立刻成为新的墙”。“依赖存储”指要等 ADR-057 的“回合与条目各自成表”（v14）。

**5.1 每次提交整份重写快照**（`sqlite-store.ts:421`：`UPDATE sessions SET … snapshot=?`）。文档里的实测：ADR-047 的合成测量是 0.31 ms@1.3 KB、7.8 ms@1 MB、44.8 ms@4.2 MB（合并窗口之前）；ADR-055 记 7.5 MiB 时“受理到派发”1.25–1.41 s；ADR-057 的原型里 4 MiB 整份重写 11.5 ms，对比新表一个文字窗口 0.11 ms。**依赖存储**：A01、A04、A07 都不能单独去掉。

**5.2 整份校验**（`parseSession`，`state.ts:350-468`）。回合与消息、消息与回合互相线性查找（`:423-442`，ADR-057 自己说“回合到万级就是亿次比较”）；再加上每个 Run 与每次 switch 的 `sourceRunIds` 都要在 runs 与 messages 里查（`:437-439,448-451`），最坏 O(回合 × 来源 × (回合 + 消息))，而 switch 的 `sourceRunIds` 是“所有已终结回合”（`runtime.ts:476,2099`），会随回合数增长；每次提交还要 `JSON.stringify` 整份只为检查 8 MiB（`:466`）。**依赖存储**（行级校验）。实际耗时未测【推】。

**5.3 事件**。流式每窗口一条事件且现在带正文（`runtime.ts:1397-1446`）；读时核对 `COUNT/MIN/MAX`（`sqlite-store.ts:173`）、写时 `SUM(octet_length)`（缓存未命中时，`:803-815`）。ADR-057 3.5 已让事件变轻、改维护命令核对。**依赖存储**；不依赖的是“EVENT_LIMIT 不再致命”这个止血项。

**5.4 整份读与整份下发**。`readStoredSession` 整行读出再 `JSON.parse`、再整份校验（`sqlite-store.ts:160-176`）；快照缓存 96 MiB 是所有对话共用的，去掉 8 MiB 后单个超过 96 MiB 的对话永远不进缓存（`snapshot-cache.ts` 注释 “one larger than the whole budget is not kept”），每次读都整份重新解析；每个 SSE 事件在服务端先重建整份视图（`session-stream.ts:103-110`），文字事件发整条助手消息（长回复每个窗口发一次整条，二次方成本，ADR-057 3.7 末也承认），其余事件发整个 Run 或整份快照；页面把整个对话解码、渲染（没有虚拟列表）。**依赖存储**（ADR-057 3.4 的窗口 + 增量帧）和 proto-web。

**5.5 启动与列表是 O(全部数据)**。`store.list(100)` 解析 100 份快照（`server.ts:588,791,1013`）；`readinessViews` 扫所有对话的所有回合算启动用时中位数（`server.ts:232-250`）；启动时 `contentReferences()` 读每个对话（`sqlite-store.ts:376-392`）、`nativeOwners()` 对所有快照 `json_each`（`:361`）、恢复循环 `claimAndRecover` 读每个对话并对事件日志求和（`:563,700-715`）。**依赖存储**（计划里的部分索引与 `content_refs`）。

**5.6 工具详情在内存里、一件一文件**。`execution.details` 把每个工具的详情整个放内存直到写盘（`runtime.ts:41`）；`storeDetail` 每个已完成的工具写一个内容库文件 + 一行 + fsync（文档实测约 8.2 ms/条，`docs/contracts/storage-events.md:211`）。去掉 A16 的截断和 A11 的 128 条之后，一个长回合是几千个文件、内存里放着全部全文。**依赖存储**（详情进条目行/文字块表，ADR-057 3.2），驱动要改成边收边写。

**5.7 协议读侧每次视图同步读详情**（A36）。`ProtocolView.attach` 为对话的**所有** Run 生成协议回合，并同步读最多 400 个详情文件（`protocol-view.ts:26,60-70`，`readTextSync` 注释自己写“blocks while the file is read”）；而 SSE 每个事件都先建一次整份视图（5.4）。这一步的设计前提是“对话不太长”。**依赖存储**（详情头存进条目行）。

**5.8 页面里的镜像上限**。页面解码遇到超长数组**整体判无效**（`web/src/api.ts:37-40`）：runs ≤256 / messages ≤1024（`session-stream.ts:208`）、tools ≤128、notices ≤32、activities ≤64、outputs ≤32、attachments ≤8（`api.ts:366-370,395-396`）、计划步 ≤128 / 回合条目 ≤4096 / 文件改动 ≤1024（`decode.ts:71,85,135`）。服务端先放开、页面没改，用户看到的是整个对话“无效”。**与服务端同批改**，依赖 ADR-057 3.4 的窗口读。

**5.9 relay 写死的界**。`RELAY_MAX_SEQ` = 16,384、`RELAY_MAX_RUNS` = 256（`relay.ts:24-28`）和各解析器；交接单清单 `runs: indexes.slice(0, RELAY_MAX_RUNS)`（`relay-coordinator.ts:335,345`）**静默只列前 256 个回合**；`RelayLedger` 把事件日志当事实库扫（计划 #2）。不放开，第 257 个回合起交接会出错或悄悄漏回合。**依赖存储**（计划里的线 F 先做）。

**5.10 进程边界**。单帧 16 MiB 之外，入站拼帧是逐块 `Buffer.concat`，帧越大越接近平方（`json-rpc-process.ts:363`）；累计 256 MiB（A27）；写一帧 10 s。去掉附件上限（A28）而保留 16 MiB 帧，12–20 MiB 的图片会在发出时断连。**不依赖存储**，但要先改拼帧。

**5.11 时间预算与别的上限联动**。去掉 A21–A23 而保留 A25：第 5 个对话无限排队；保留 A05：长回合更快撞 16,384 条事件；保留 A04：长回合产生的正文/工具把快照撑到 8 MiB。**所以时间预算可以先改成提示，但长任务真正跑得动，要等 A04/A05/A11 去掉**。

### 5.12 分类：哪些现在就能去，哪些要先修，哪些必须等存储

| 现在就能去，不依赖存储 | 先修一个前提再去 | 必须等存储（回合与条目成表）之后 |
|---|---|---|
| A03 排队 8（可先调到 1000 级）；A17 用量明细 64；A18 驱动 id 表；A19 原生命令（菜单分页）；A20 OpenClaw 窗口；A21–A24 时间预算（改提示）；A25 并行名额（含同工作区互斥改提示）；A26 保留进程个数；A27 累计 wire；A35 界面窗口；A37 管家表、A38 Provider、A39 能力；D01/D03/D05–D07/D13–D16 的重定值 | A08 64 KiB（要同时放宽 128 KiB 请求体并有附件通道接住）；A28 附件（先解决图片内联 vs 16 MiB 帧，5.10）；A10 驱动级导入界（要先有分页读）；A16 全文（先让驱动边收边写，5.6）；A21–A25 联动（先定 A04/A05 的处置，5.11）；A36 思考截断（视图改按页取） | A01 回合数、A02 命令数、A04 8 MiB、A05/A06 事件、A07 正文/思考 1 MiB、A09 分支/导入引用、A11–A15 条数（过渡期可改成“有账”）、A16 全文存储、A29 内容库记录数、A30 对话列表分页、A31 响应分页与流式导出、A32 增量帧、A34 读回详情与搜索偏移、A36 详情头、relay 写死的界（5.9） |

## 6 建议的做法顺序

1. **先做的止血（小，不改格式，与“去掉上限”同向，只为缩小爆炸半径；若第一段按计划很快上线，它们的价值就小）**：① `commit()`、回合结尾、`fork()` 里的上限类与 `INVALID_DATA` 错误不再走 `fail()`（A04、A05、A09、D21）——只让该对话/该请求失败；② 外来文本（工具标题、id）进 `commit` 前按字节夹住（D21）；③ `/api/v1/state` 不再因对话字节合计超 8 MiB 整个失败（A30）；④ 为 `RUN_LIMIT/COMMAND_LIMIT/EVENT_LIMIT/SESSION_LIMIT/OUTPUT_LIMIT/QUEUE_FULL/READ_LIMIT` 补中文提示；⑤ Provider、管家的预算校验不再让服务起不来或让 `/state` 失败（A37、A38）；⑥ 把五处“静默丢弃”改成有账（A11–A15）。
2. **不依赖存储、可以和 v14 并行做**：时间预算改提示（A21–A24）、并行名额（A25）、保留进程（A26）、附件（A28）、超长输入折成附件（A08）、驱动里的 id 表与窗口（A18–A20）、界面窗口（A35）、管家/Provider/能力（A37–A39）。
3. **随 v14 一起去掉**：A01–A07、A09、A11–A16、A29–A32、A34、A36、relay 写死的界（5.9）、页面镜像上限（5.8）。
4. **需要你定的取舍**：登录期限（D03，“零操作”对安全）；同工作区互斥（A25，提示还是排队）；时间预算要不要留一个可选的自动停止（A21）；事件是否像 T3 那样加保留期（A05，ADR-057 已选全留）。

## 7 没核实的

- **4317 的真实数据与启动参数**没读：不知道守护进程现在用的执行/等待预算、有多少对话、最大的对话有多大、离哪道墙多远。所有“撞到会怎样”都是读码得出，**没有真机复现**；其中走到 `fail()` 的几条（A04、A05、A09、D21）是把路径读通，**未复现**。真机记录只有一条（A21，2026-10-11，我没复核）。
- **没运行任何测试**。“测试依赖”一栏是搜常量和错误码得到的：写了行号的是读过断言；写“未逐条核”的（A37、A39 的测试）只是文件名对得上。
- A28 的“12–20 MiB 图片断连”是由 `acp.ts:413-433` 与 `json-rpc-process.ts:341-342` 读出的，**没运行**；Claude Code / OpenCode 等是否真把图片内联发送，要看各自的 ACP 适配器。
- A32 里“重连后同一快照仍超界”**没读客户端重连逻辑**。D03“没有别的续登路径”只读了 `server.ts`。
- C05（Codex 1,048,576 字符、OpenClaw 2,097,152 字节）与 C09（SQLite、V8 的界）的数值**不是在本仓库核对的**：前者来自我们 Driver 的声明，后者来自对 SQLite/V8 文档的记忆。
- T3 部分用 `grep` 搜过，“没找到”不是证明；T3 的适配器文件很大（`ClaudeAdapterV2.ts` 一万多行），只读了与时间、并发、上限有关的片段。
- 常量个数是估计：名字匹配约 160 个，数字常量约 600 个，其中大部分不是限制。**本清单的“项”是一行一条规则或一组同源常量**，不是常量个数。
- 冻结的适配器（Pi、Cursor、Gemini）只看了与对话路径有关的几个界（D07 的审批 32、A23 的 Pi 期限）；`src/cli/` 里除 web、chat、sessions、hub-tools、control 外的入口没读；页面里的动效与轮询节奏常量（`App.tsx:144-146`、`use-relay.ts:7-9`、`Approval.tsx:91` 等）不是限制，没列。
- 行号以 `467dd62` 为准；到 `8edc426` 为止源码没有再变（只改了两份文档），之后别的会话再合并可能让行号漂移。

