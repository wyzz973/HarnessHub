# ADR-057：有序条目落盘，会话存储升到 v14

状态：proposed，2026-11-12。依据：[统一协议设计稿](../proposals/protocol/hub-protocol.html)第 4、5、6、10、16、17 节（已定稿）、[决定记录 2026-11-12](LOG.md)（用户：一轮按时间交错显示、存储 13 升 14、旧对话只在打开时现算、审批与提问留痕）、[显示层审计](../research/hub-display-audit-2026-11-12.md)的 A 与 D.12.3、[T3 Code 调研](../research/t3code-protocol-ui-2026-11-12.md)的 A2。协议类型在 `src/contracts/protocol.ts`。按 AGENTS.md，这是改持久格式，实现后做一轮独立审查（清单在末尾）。

本文只定分步落地的第 2 步（有序条目落盘，运行时按到达顺序产出）和第 3 步里与存储有关的部分（审批、提问留痕）。第 1 步（共用归一模块、读侧投影、界面按协议渲染）不动存储，并行进行。实施拆分见 [step2-plan](../proposals/protocol/step2-plan.md)。

## 背景

- 一轮现在是“一条助手消息加若干并列字段”。助手消息只在 `flushStream` 里建、只追加（`runtime.ts:1442`），每个 Run 只声明一个 `assistantMessageId`（`state.ts:406-407,425`）。`thinking`、`tools[]`、`plan`、`notices[]`、`activities[]`、`outputs[]` 各自独立（`session.ts:114-120`）。公开快照里没有跨类型的先后。
- 先后只在事件日志里：任何别的事件到达前，先提交已合并的文字或思考窗口（ADR-047；`runtime.ts:1282-1284`）。日志有条数上限（`state.ts:21`），靠回放它不是长久之计。
- 审批与提问只在 Runtime 内存的 Map 里（`runtime.ts:247`）：决定后删（`:278`），回合结束时删（`:1840-1842`），重启后没有（`session.ts:508-511`）。持久的只有几条事件和一条 `commands` 记录。
- 工具超过 128 条后，新的被静默丢弃（`state.ts:27`，`runtime.ts:1313`）；通知 32、活动 64、产物 32 同样（`runtime.ts:1327-1328,1488`）。
- 给前端的帧：文字窗口发整条消息，活动中的 Run 发整个 Run，其余发整份快照（`session-stream.ts:103-121`）。
- 真实对话里先后确实有信息：试用夹具（`tests/fixtures/protocol/trial-2026-11-11.json`）里 Codex 有两轮是“说一句、连跑十来个工具、再说一句”，dsh 一轮是 6 段思考夹在 13 次工具调用之间。
- 先例：v7 到 v13 每次加字段都升版本、整库一个事务迁移、旧版本不得带新字段（`sqlite-store.ts:634-701`，`state.ts:325-330,371,389-390`），升版本前自动备份（ADR-049）。

## 决定

### 1. 落盘的形状：条目加偏移，旧字段保留并继续写

- `PublicRun.items?: readonly PublicItem[]`，只在 schemaVersion ≥14 的快照里允许，数组顺序就是 `seq` 顺序。另有 `PublicRun.omitted?`（第 6 节）。
- `PublicItem` 就是 `protocol.ts` 的 `ProtocolItem`，只有一处不同：`assistant_message` 与 `reasoning` 不带文字（助手段也不带 `messageId`，它就是本 Run 的 `assistantMessageId`），带 `start`、`end?`（UTF-16 偏移，没有 `end` 表示还开着）。文字仍然只有一份，在助手消息（`PublicMessage` 不改）和 `run.thinking` 里；读侧按偏移切出来，填成 `ProtocolItem`。
- 条目有界地落盘，大块内容只留引用：

| 条目 | 落在快照里 | 放内容库（`detail`，与 `tools[].detail` 是同一个引用） |
|---|---|---|
| 每个条目 | `id`≤530、`seq`、`type`、`status`、`startedAt?`、`endedAt?`、`parentId?`、`nativeName?`≤256、`detail?` | |
| assistant_message、reasoning | `start`、`end?`；助手段另有保留的 `phase?`（第 2 节第 5 条） | 无（文字在消息或 `run.thinking`） |
| command | `command`≤4 KiB、`raw?`≤4 KiB、`cwd?`≤1 KiB、`exitCode?`、`background?` | 输入全文、输出尾部 64 KiB |
| file_read、search、web | 路径与范围、`scope`、`query`≤1 KiB、`matches?`、`url?`、`title?` | 结果文本 |
| file_change | `changes`≤64 项（`path`、`op`、`oldPath?`、`added?`、`removed?`） | diff≤64 KiB |
| mcp_tool、tool、subagent | `server`、`tool`、`hub?`；`name`；`title`≤1 KiB | 输入输出 JSON |
| plan | `steps`≤64 项（各≤4 KiB）、`explanation?` | 无 |
| approval、question | `subject`、`title`≤1 KiB（提问≤4 KiB）、`options`≤32、`decision?`、`answer?`≤4 KiB、`secret?` | 不存 `detail` |
| notice、context_event、artifact | `severity`、`code?`、`text`≤1 KiB、`more?`≤4 KiB；`kind`；`kind`、`name`、`uri` | 产物字节（与 `outputs[]` 同一个引用） |

- 落盘的类型：assistant_message、reasoning、七种动作加 subagent、plan、approval、question、notice、context_event、artifact。读时派生、不落盘：user_message（来自消息）、switch（来自 `run.relay` 与前后选择）、interrupt（来自 `cancelRequested`）、error（来自 `run.error`）。以后才写：plan_proposal、recap、delegation。v14 的校验一次放进 23 种的形状，让它们以后开始落盘不必再升版本。
- `context_event` 必须落盘：Hub 清空与原生命令的上下文效果现在只写进 `run.ended` 事件，快照不存（`control.ts:139-145`，`runtime.ts:1896-1900`）。回合结束时按它们写一条。
- 与现有字段的关系（推荐 v14 双写：旧字段一个不减、语义不变，一次提交里与条目一起写）：

| 现有 | v14 | 与条目的关系 |
|---|---|---|
| 助手消息（每 Run 一条） | 保留，仍是文字唯一的存放处，只追加 | 助手段按偏移指向它；各段加段间空白就是全文 |
| `thinking` | 保留，同上 | 思考段按偏移指向它 |
| `tools[]` | 保留，仍≤128，仍供交接单叙述、上下文桌、`contentReferences`、旧 Run | 动作条目是它的归一视图，`detail` 同一个引用 |
| `plan`、`notices[]`、`activities[]`、`outputs[]` | 保留 | plan、notice、subagent 与 context_event、artifact 条目 |
| `usage`、`error`、`backend`、`timing`、`relay` | 不变，不进条目 | 用量、结局、换家、停止由读侧派生 |

- 双写的退出条件：交接单叙述、上下文桌、导出、界面都改读条目，并且不再承诺降级到 v13。之后新 Run 可以不写 `tools[]` 等，不必升版本（它们本来就是可选字段）。旧 Run 永远只有旧字段。
- 一个例子：回复全文是“我先改 cart.js。改好了。”（16 个码元），一轮是说一句、改一个文件（要批准）、再说一句（读侧推出 `text:1` 是 commentary，`text:2` 是 final）：

```json
"items": [
  {"id":"text:1","seq":1,"type":"assistant_message","status":"completed","start":0,"end":12,"startedAt":1000,"endedAt":1040},
  {"id":"tool:call_7","seq":2,"type":"file_change","status":"completed","changes":[{"path":"src/cart.js","op":"modify","added":2,"removed":2}],"startedAt":1100,"endedAt":1900,"detail":{"id":"content-…"}},
  {"id":"permission:permission-a1","seq":3,"type":"approval","status":"completed","subject":"file_change","title":"修改 src/cart.js","options":[{"id":"accept","role":"allow_once","label":"允许一次"},{"id":"decline","role":"deny","label":"拒绝"}],"decision":{"role":"allow_once","by":"user","at":1800},"startedAt":1110,"endedAt":1800},
  {"id":"text:2","seq":4,"type":"assistant_message","status":"completed","start":12,"end":16,"startedAt":1950,"endedAt":1990}
]
```

### 2. 助手文字怎么分段

1. 文字照旧按窗口追加进同一条助手消息。分段只记偏移，不拆消息。窗口从不跨过边界：任何别的事件到达前，先提交已合并的窗口（ADR-047）。
2. 一段在第一个含非空白字符的窗口里打开，`start` 是该窗口里第一个非空白字符的偏移。更早的空白留在消息里，不属于任何一段；校验要求段与段之间只有空白。打开的段状态为 `running`。
3. 同一种类（文字或思考）的连续窗口并进同一段。下面任一发生时这一段关闭，`end` 取此刻缓冲长度，状态为 `completed`（回合进入终态时按第 4 节的收场表）：另一种类的窗口到达；一个占时间线位置的新条目被放下（任何动作、审批、提问、通知、压缩、产物）；回合进入终态。
4. 不切段：已有条目的状态与详情更新（同一个工具反复上报）、plan 的出现与更新、用量、诊断。plan 有自己的 `seq`，但界面不把它画在时间线里，不该拆开一段话。
5. `phase` 不落盘，读侧推出：回合进入终态后，除 plan 外最后一个条目若是助手段，它是 `final`，别的段是 `commentary`（取消、失败、未知的回合同样）；回合进行中没有 `final`。条目里保留一个可选的 `phase?`，v14 不写；以后 Driver 能报原生的阶段（Codex 的 `commentary` 与 `final_answer`，T3 调研 B6）时才用，读侧以它为准，不必再升版本。
6. 段打开期间，`endedAt` 随每个窗口推进（窗口最后一块到达的时刻），用 `status` 判断是否结束。
7. 相邻的两条原生消息在 v14 合成一段，因为 Driver 把消息身份丢了（Codex 的 `itemId` 在 `codex.ts:838-845` 被丢，ACP 在 `acp.ts:877`）。可选的下一步：`ControlEvent.text` 加可选的 `messageId`，Driver 给了就按它切（计划 B 线的可选项）。
8. 各读者取文字：流式帧、交接单叙述（`narration.ts:91,99`）、上下文桌（`table.ts:88-92`）、导出里的整条回复（`conversation-export.ts:39`）、搜索、`public_context_rehydrate` 都仍读整条助手消息，不受分段影响。只有按先后画的界面和新的导出读段。

### 3. 思考怎么分段

- 规则同第 2 节，缓冲是 `run.thinking`（≤1 MiB，`state.ts:18,203`）。试用夹具（`tests/fixtures/protocol/trial-2026-11-11.json`）里 dsh 一轮有 6 段思考夹在工具之间，所以按段落盘，不按“一轮一块”。
- 用时由读侧算：`endedAt` 减 `startedAt`。整块一次到达的 Harness（dsh，审计 B.4.2）这个差是 0，读侧当作未知，不写“0 秒”。

### 4. 条目的身份与先后

- `id` 在本回合内唯一；读侧要全局唯一时拼上 Run 的 id。派生：工具 `tool:<原生 id>`（每个 Driver 都给，`control.ts:96` 必填，`acp.ts:882`）；活动 `activity:<id>`；审批与提问 `permission:<permissionId>`；文字 `text:<n>`、思考 `think:<n>`（n 是本回合第几段）；通知 `notice:<n>`；产物 `output:<n>`；任务清单 `plan`（一轮一份）。Codex 把同一个子任务双发成工具和活动（`codex.ts:881-888`），合成哪个 id 由第 1 步的归一模块返回，Runtime 不自己猜。
- `seq` 从 1 起，条目第一次出现时定下，不变、不复用，数组严格按 `seq` 增序。它是回合内的位置，不是会话事件的序号。
- 同一 id 反复上报覆盖同一条，内容没变就不提交（沿用 `runtime.ts:1320` 对 `tools[]` 的做法；设计稿与 T3 同此）。条目的类型在回合进行中可以被细化（后到的上报能改 `kind` 与标题，`runtime.ts:112-121`），回合终结后不再变；界面按 id 认条目，不按类型。
- 没有原生 id 的 Driver 由适配器造一个本回合内确定的（`<回合>-<序号>`）；空 id 校验拒绝。`parentId` 必须指向本回合更早的 `subagent` 条目，否则丢掉这个字段，不让提交失败。
- 位置在事件到达时预留，不在异步写内容库完成时：产物字节要先写内容库再提交（`runtime.ts:1496-1503`），条目却在事件到达时就占位，写好后补引用；写失败时标 `failed`，不再只留一条诊断（`:1499`）。工具详情同理（`storeDetail`，`:1473-1485`），写好的那次提交同时补 `tools[]` 与条目的 `detail`。
- 回合进入终态时（`ended`，`runtime.ts:1903-1971`）和重启恢复时（第 5 节）还没终结的条目，由同一个纯函数收场：

| 回合终态 | 还开着的文字、思考段 | pending 或 running 的动作 | waiting 的审批、提问 |
|---|---|---|---|
| completed | 关闭，`completed` | `unknown`，不当已完成（Claude 前台命令一直报 pending，审计 B.4.3；OpenClaw 补记没结果也写 completed，`openclaw.ts:162`，归一时要改） | `cancelled` |
| cancelled（用户停止、预算到期） | `cancelled` | `cancelled` | `cancelled` |
| failed、unknown（含重启恢复） | 同回合状态 | `unknown` | `cancelled` |

### 5. 审批与提问的持久化

1. 请求开出时（`runtime.ts:1288-1298`），在写 `permission.requested` 的同一次提交里放一条条目：`id` 为 `permission:<permissionId>`，类型 `approval`（`kind` 缺省）或 `question`，状态 `waiting`，`startedAt` 是请求时刻。`approval` 带 `subject`、`title`、`options[{id, role, label}]`；角色由第 1 步的归一模块定，归不了的是 `other`，保留原词（T3 的教训：未映射的类别不能落空，#7825）。
2. 用户决定时（`decidePermission`，`runtime.ts:259-281`），在写 `permission.decided` 的同一次提交里改条目：允许类角色为 `completed`，`deny` 为 `declined`，写 `decision{role, by:"user", at}`；提问的选项回答写所选项的文字，自由文本写 `answer`（≤4 KiB，截断加省略号），选取消类选项为 `cancelled`。记的是用户的选择；Harness 收没收到，由后面动作条目的状态反映（`permission.submitted` 现在恒为 `backendAcknowledged:false`，`runtime.ts:279`）。
3. 其他收场，都在写对应事件的同一次提交里：等待预算到期（`runtime.ts:1255-1270`）`cancelled` 加 `decision{role:"deny", by:"timeout"}`；Harness 撤回或自动拒绝（`:1299-1308`）按它说的 `cancelled` 或 `declined`，`by:"harness"`；用户停止或回合结束时还在等（`:1840-1842`）`cancelled`，不写 decision。
4. Hub 重启：`claimAndRecover` 对每个会话调 `recoverSession`（`sqlite-store.ts:707-715`，`state.ts:601-614`），未终结的回合变 `unknown`（`OWNER_ENDED`）。内存 Map 没了、原进程已不在，没人能答，所以 `waiting` 的请求收成 `cancelled`、不写 decision；动作与段按第 4 节的表收场。不重发、不重问。
5. 敏感输入：`input.kind === "secret"`（Codex 的 `isSecret`，`codex.ts:998,1014`）的回答只经 `decidePermission` 交给 Driver，不进快照、事件、日志，`answer` 不写。条目要有一个 `secret: true` 标记，界面才能写“已回答（内容未保存）”（协议 `QuestionItem` 加可选字段，见计划缺口 4）。现状还有一处会泄：permission 命令记录的 `fingerprint` 是 `{permission, option, input}` 的裸 SHA-256（`runtime.ts:263`，`session-application.ts:55,140`），编号又在事件里，弱口令可离线撞出来。v14 起 secret 回答不进 fingerprint。
6. 实时的 `SessionView.permissions` 与“等你处理”（ADR-035）仍来自内存，用来回答；条目只管留痕与时间线。两边用 `permission:<permissionId>` 对上。

### 6. 上限与体量

- 每 Run 最多 `MAX_RUN_ITEMS = 256` 条（文字段、思考段也算），`items` 序列化后≤128 KiB（估算每条 300 到 500 B，未实测，上限时约 100 到 130 KiB）。审批与提问不计入这两个上限，另有最多 64 条的余量，再多的计入 `omitted.items`。
- 超限时：不再放新条目，已有条目照常更新（放不下的新条目仍然关掉开着的段），文字与思考照常追加进缓冲，没有段覆盖的尾部由读侧当作最后一段显示。每个没放下的新条目计入 `omitted.items`（按不同 id 数，Turn 内存里记≤4096 个，更多时数字是下限，`atLeast: true`，界面写“至少”）。读侧在回合末尾派生一条 Hub 说的通知：“还有 N 个动作没有逐条记录”。`omitted` 是 `{items?, tools?, notices?, activities?, outputs?, atLeast?}`，没有省略时整个字段不写。
- 写入方先夹住再写：长度、条数、偏移都由写入方按上限夹住，控制字符清掉（原生文字只当数据），超出的按本节计省略，解析只当断言。因为条目解析失败会让提交失败，而 Runtime 对提交失败是致命的（`runtime.ts:956`，`expectedFailure` 只放过上限类错误，`:162-164`），外来数据（超长路径、重复的 id）不能让它失败。
- 旧字段的静默丢弃一并改成有账：`tools[]`（128）、`notices[]`（32）、`activities[]`（64）、`outputs[]`（32）超出时计入 `omitted.tools`、`notices`、`activities`、`outputs`，不再直接 `return`（`runtime.ts:1313,1327-1328,1488`）。通知、活动、产物的条目与旧字段同口径：旧字段放不下，条目也不放；只有工具的条目上限（256）高于旧字段（128）。
- 会话 8 MiB（`state.ts:20,466`）、每会话 16384 条事件（`:21,411`）、单 Run 输出 1 MiB（`:18`）不变。条目不加事件，只让快照变大，所以会更早撞到 8 MiB；撞到的行为照旧（`SESSION_LIMIT`，该回合失败，已落盘的保留）。若实测显示常见会话明显逼近，调小 `MAX_RUN_ITEMS`，不放宽 8 MiB。
- 读路径还有一处同类上限：`store.list(100)` 把 100 个会话的快照字节加起来不能超过 8 MiB（`state.ts:24`，`sqlite-store.ts:178-188`），`/api/v1/state` 与就绪视图都读它（`server.ts:580,783`）。快照变大会更早让整页状态读失败。第 2 步要实测，并把这个读上限和快照上限分开调（计划 A 线）。
- 页面的解码器遇到超长数组整体判无效（`web/src/api.ts:35-38`），所以两边的上限一起改。

### 7. 事件与帧

- 不新增事件类型，也不新增提交。条目的每次变化都在引起它的现有事件的同一次提交里：`run.output`、`run.tool_detail`、`permission.requested`、`permission.decided`、`permission.closed`、`run.budget_expired`、`run.ended`、`session.recovered`。
- 事件载荷只加字段（事件类型开放，旧事件照读）：文字与思考的 `run.output` 加 `item`（所属段）；`permission.*` 加 `item`；`permission.decided` 加 `role`。v13 迁移读的九种事件不受影响（`sqlite-store.ts:151`）。
- 帧：第 2 步保持“整条消息替换”和“整个活动 Run 替换”，条目随 Run 走（`WebRun` 是 `PublicRun` 去掉两个接力字段，`web.ts:300`，所以 `items` 自动在帧里；若第 1 步改为服务端附上投影好的 `ProtocolTurn`，原始 `items` 就不再上线，免得每个 Run 出现两份）。界面规则：助手消息里没被任何已关闭的段覆盖的尾部，就是正在流的最后一段，排在已知的所有条目之后。这样文字窗口仍只发 message 帧，开新段不需要额外帧；思考窗口发的是 `run` 帧，条目随它到，不需要这条规则。
- 对流畅度：文字热路径不变；动作、审批、思考窗口发的 `run` 帧多带 `items`（估算至多约 100 KiB，未实测），频率远低于文字窗口。长回复每个窗口发整条消息的二次方成本原样存在。
- 推荐第 2 步不改成“条目 upsert 加文字增量”：它要改界面 reducer、帧缺口处理、重连，收益只在很长的回复上。触发条件（起始值，真机量后可调）：≥256 KiB 的回复期间帧流量超过 5 MB/s，或页面长任务超过 50 ms。到时形状为 `{runId, upserts, text:{from, append}}`，漏帧回退到整份快照（`session-stream.ts:138-149,159` 已有这个机制）。设计稿第 6 节的命令输出增量通道也不在第 2 步：输出现在只在工具终态写进内容库（`runtime.ts:1324`）。

### 8. 迁移 13 到 14

- `CURRENT_VERSION` 改 14（`sqlite-store.ts:19`）；新库直接建成 14（`:570-582`），`create()` 要求 14（`:319`），新会话三处写 `schemaVersion: 14`（`runtime.ts:329,389,565`）。
- 迁移块接在 v13 块后：`version ≤ 13` 时，逐会话读出、确认是 v13、`parseSession({...state, schemaVersion: 14})` 写回，最后 `user_version=14`，整库一个事务（同 v7 到 v12，`:634-688`）。不改旧 Run 的内容，不补 items，不读事件日志。旧 Run 没有 items，读侧走第 1 步的投影。旧 Run 的先后其实还在事件日志里，需要时读侧可以回放，不动存储，v14 不做。
- 校验（`parseSession` 与 `assertSessionTransition`）：`items`、`omitted` 只在 ≥14 的快照里；排队的 Run 没有 items；`id` 唯一、`seq` 严格增序、条数与字节不超限；各类型字段白名单与长度，未知键拒绝；`startedAt ≤ endedAt`（写入方夹住时钟回拨，不让提交失败）；段的偏移在缓冲长度内、按 `seq` 递增、互不重叠、段间只有空白；至多一个没有 `end` 的段，且只在非终态的 Run 里；终态 Run 没有 pending、running、waiting 的条目；审批的 `decision` 与状态对应；已终结条目的状态不退回，终结后只许补 `detail`。
- 备份沿用 ADR-049，条件从 1 到 12 改为 1 到 13（`sqlite-store.ts:508`），回读核对不变（`:146-149`），失败则迁移不发生。需要约两倍库大小的空闲空间；v14 只改快照版本，应不慢于 v13 的迁移（ADR-049 补充的实测），未实测。
- 旧程序（v13 构建）遇到 v14 库：备份步骤因 `from ≥ CURRENT_VERSION` 直接返回，随后 `claimAndRecover` 一开始就以 `INVALID_DATA`“unknown business database schema version”回滚并拒绝启动（`:508,569,717`），只读 reader 同样（`:871,889`），库不被改动。`web` 启动失败只打印错误码（ADR-049 影响一节）。
- 回退的路：① 备份：停服务、换回 `backups/gateway-v13-….sqlite`、删 `-wal` 与 `-shm`、用 v13 构建启动（`docs/contracts/storage-events.md` 手动恢复一节），升级之后的全部变化丢失。② 降级脚本（`tools/session-v14-to-v13.sql`，先例 `tools/management-v6-to-v5.sql`；本 ADR 要求在计划 A 线做并测，应用不自己运行）：停服务后，每个会话的每个 Run 去掉 `items`、`omitted`，`schemaVersion` 与 `user_version` 改回 13。v14 保留并继续写全部旧字段，所以不丢对话、消息、工具、计划、通知与 `commands` 里的审批决定，只丢先后与审批条目。条目里的内容引用在旧字段里都有，降级后 7 天回收器不会收走它们；唯一的例外是同一 Run 第 129 个以后的工具，旧字段本来就不记，它们的详情会被收走。降级前同样先备份。
- 风险：4317 有真实数据，升级单向；降级脚本只在合成数据上测过；备份和库在同一块盘。按 AGENTS.md，升级 4317、动真实数据先问用户；测试用临时数据根，不复制真实数据。迁移测试用冻结的 v13 夹具（先例 `tests/fixtures/relay/v12/`），夹具要在升版本之前，用现在这个 v13 构建生成。

### 9. 谁读 items

| 读者 | 切换顺序 | 读什么 | 旧 Run |
|---|---|---|---|
| 界面 | 第一个（计划 C 线） | `run.items` 经读侧函数填成 `ProtocolTurn` | 走投影 |
| 导出（`conversation-export.ts`） | 第二个 | 按条目次序写回复、动作、审批 | 走旧写法 |
| 上下文桌（`table.ts`、`hub-tools`） | 第三个 | 目录里可显示先后；搜索仍搜整条消息；`#k` 工具编号仍按 `tools[]` | 照旧 |
| 交接单叙述（`narration.ts`） | 最后，单独一轮审查 | 仍取整条回复与 `tools[]`；改按条目叙述等于改交接单内容 | 照旧 |
| `public_context_rehydrate`（`context.ts`） | 不切 | 整条消息 | 照旧 |

第 1 步的读侧投影在第 2 步之后仍是旧 Run 的唯一读法（它们永远没有 items），也是新旧两条路的对照：同一批夹具走落盘路径和投影路径，结果应当一致，只差先后与审批。读侧函数在有 `items` 时走落盘路径，没有时走投影。

## 否决的方案

- 每段一条助手消息：要改 `assistantMessageId` 的唯一性与消息状态镜像（`state.ts:406-407,425,432`），消息数上限 `MAX_RUNS*2`（`:358`），接力叙述、上下文桌、导出、前端都按“一轮一条回复”取文字，一次改全部读者，交接单内容跟着变。
- 条目自带全文、消息当镜像：文字存两份（每轮最多 1 MiB 乘 2，都算进 8 MiB），还要多一条“消息等于各段拼接”的校验。偏移法没有重复。
- 只做读侧投影（审计 D.12.3 的另一条路）：先后与审批结果只在事件日志里，投影不到；设计稿第 16 节已排除，用户已决定落盘。
- 条目放单独的表（像 v13 的接力表）：快照不增长、可按条目增量写；但要改 `SessionStore` 端口、快照缓存、备份回读、删除会话、SSE 读路径，段偏移的校验要跨表，而最大的成本（每次提交整份重写快照，文字还在快照里）并不消失。所有读写都经 `run.items`，将来需要时可以原样搬进表。
- 一次切断旧字段（不双写）：体量小，但所有读者要同时改，交接单内容跟着变，降级只能丢掉新对话。
- 不升版本，在 v13 里加可选 `items`：旧构建读到未知字段，整个会话以 INVALID_DATA 读不出（`state.ts:192` 的白名单），而不是干净地拒绝启动。
- 第 2 步就把帧改成增量：第 7 节。

## 需要所有者拍板

1. **v14 是否保留旧字段（双写）。** 推荐：保留。理由：这样才做得出不丢对话的降级脚本，交接单等读者也不必同时改；代价是快照比只存条目大（第 2 步实测后报数）。
2. **什么时候升 4317 的真实库。** 推荐：第 2 步在新数据根上用真实 Claude Code 与 Codex 跑通、降级脚本在合成数据上往返通过之后，经你点头再升，备份在升级时自动做。理由：升级单向，旧构建打不开 v14。
3. **每轮条目上限 256 与会话容量的取舍。** 推荐：256，超出明确标“还有 N 个”。理由：条目撑大快照，上限高了，一个会话装得下的轮数变少（8 MiB 是硬顶）；要完整记录极长的回合，得把条目移出快照，那是另一个项目。

## 独立审查清单

1. 不丢用户内容：消息文字的追加与终态不可变没被削弱（`state.ts:581-587`）；`contentReferences()` 读了条目里的引用，否则 7 天回收器会收走（`sqlite-store.ts:376-392`，`session-application.ts:126-128`）；偏移之外的字节只有空白；超限后文字仍进缓冲。
2. 不谎报状态：第 4 节的收场表；回合终态前不推出 `final`；重启恢复不把 `waiting` 说成已处理；`omitted` 进了界面；`unknown` 没被当 `completed`；Harness 没收到决定的情形。
3. 迁移与备份：整库一个事务；1 到 13 都备份；失败时库仍是 v13；旧程序被干净拒绝；降级脚本往返（v13 夹具到 v14 再回 13，除 `items`、`omitted` 外逐字相同）；没有复制真实数据。
4. 上限行为：外来数据（超长字段、重复 id、乱序）不会让提交失败；256 条与 128 KiB 的两种超限；审批不被上限挤掉；旧字段超限有账；`SESSION_LIMIT` 与 `store.list` 的读上限（第 6 节）；解析每次提交的代价。
5. 重启恢复：`recoverSession` 与 `recoverWithRelay` 的交互（`sqlite-store.ts:725-747`）；在恢复事务里收场的条目通过 `assertSessionTransition`；排队的 Run；`settling` 的 Run。
6. 旧库兼容：旧 Run 没有 items 且读得出；`items` 不得出现在 ≤13 的快照；`SqliteSessionReader` 读 v14；页面解码器对新字段与旧服务的容忍。
7. 敏感输入：secret 回答不在快照、事件、日志、`fingerprint` 里；非 secret 的自由文本只存截断后的（≤4 KiB）。
8. 双写一致：条目与旧字段同一次提交写；同一批夹具两路读结果一致；交接单黄金夹具（`tests/fixtures/relay/golden`）不变。

## 未确认

- 第 1 步归一模块对外的函数名与签名（proto-core 还没提交）。本文假设它给出“事件加已有条目得到条目更新（含 id）”和“审批选项得到角色”两个纯函数。
- ACP 是否在 `agent_message_chunk` 里带消息 id（本仓库的 Driver 没读，`acp.ts:877`）；各家相邻消息之间是否带换行（审计附录 1）。
- 条目的真实字节数与帧体量：本文数字都是估算，第 2 步按试用夹具实测后回填。
- 前端解码器之外，界面里其他按“一轮一块正文”写的逻辑（显示节奏缓冲等，审计 D.12.2）改多少：归 proto-web 判断，本文没读前端渲染代码。
