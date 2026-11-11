# 第 2 步实施计划：有序条目落盘（存储 v14）

对应 [ADR-057](../../decisions/0057-ordered-turn-items.md)（proposed）。拆成四条线，各用各的 worktree 与分支，合并前对齐。AGENTS.md 的底线都适用：提交前 `pnpm check`、`pnpm test`，动了界面再 `pnpm test:web`；汇报分“代码完成、合成测试通过、真机通过”。升级 4317 与动真实数据先问用户；测试一律用临时数据根，不复制真实数据。

## 顺序与对齐

- A 先做、先合：它定类型、校验、迁移。B 在 A 合并后开工。C 在 A 之后、第 1 步合并后可以先用夹具做，B 好了联调。D 在 A、B 之后。
- A 与 B 合进集成分支后做一轮独立审查（清单在 ADR-057 末尾）。D3（交接单叙述）会改交接单内容，再单独一轮。
- 开工前和 proto-core、proto-web 先对齐三件事：①归一模块对外的两个纯函数（“事件加已有条目得到条目更新（含 id）”“审批选项得到角色”）；②缺口 4 的协议可选字段；③第 1 步合并后的线上形状（缺口 9）。这三件我都没法从代码里确认。

## 线 A：契约、校验、迁移、降级

改：
- `src/contracts/session.ts`：`PublicItem`、`PublicRun.items`、`omitted`，schemaVersion 加 14（`:282`）。
- `src/contexts/session/domain/state.ts`：限额；`parsePublicRun` 白名单（`:192`）；v14 门槛，写法照 `:325-330`；`assertSessionTransition` 的条目规则；顺手删没人用的 `CURRENT_SCHEMA = 9`（`:31`）。
- 新文件 `src/contexts/session/domain/items.ts`：条目的解析与界限，纯函数。
- `src/infrastructure/session/sqlite-store.ts`：`CURRENT_VERSION`（`:19`）、迁移块、备份条件（`:508`）、`create`（`:319`）、`contentReferences`（`:376-392`）、读上限（缺口 1）。
- `src/contracts/protocol.ts`：只加缺口 4 的可选字段，要 proto-core 点头。
- `runtime.ts` 只改三处 `schemaVersion: 13`（`:329,389,565`），其余留给 B。
- `docs/contracts/storage-events.md`；`tools/session-v14-to-v13.sql`（先例 `tools/management-v6-to-v5.sql`，测试里照 `tests/integration/native-management.test.ts:319` 读文件执行）。

不碰：`runtime.ts` 其他行、`web/`、`session-stream.ts`、接力叙述、上下文桌、导出。

类型草稿（`src/contracts/session.ts`）：

```ts
type Text = { readonly start: number; readonly end?: number };
export type PublicItem =
  | (Omit<AssistantMessageItem, "messageId" | "phase"> & Text & { readonly phase?: "commentary" | "final" })
  | (Omit<ReasoningItem, "text" | "durationMs"> & Text)
  | Exclude<ProtocolItem, AssistantMessageItem | ReasoningItem>;
export interface PublicOmitted { items?: number; tools?: number; notices?: number; activities?: number; outputs?: number; atLeast?: true }
// PublicRun 加：readonly items?: readonly PublicItem[]; readonly omitted?: PublicOmitted;
```

先做的一步：在改版本号之前，用现在的 v13 构建生成 `tests/fixtures/storage/v13/`（照 `tests/fixtures/relay/v12/` 的生成器与读法），提交后再升版本。降级 SQL 的思路我在一份合成快照上试过（SQLite 3.54，`json_set` 加 `json_group_array(json(json_remove(value,'$.items','$.omitted')))`，数组、键序、非 ASCII 都保持），正式版要在夹具上测。

完成：v13 夹具迁到 v14，除版本外各行逐字相同；备份 `gateway-v13-*` 在；降级 SQL 往返后与原夹具逐字相同；`pnpm check`、`pnpm test` 通过。

测试：
- 迁移：行数；备份；整库回滚（坏一个会话，`user_version` 仍为 13）。
- 解析的正反例：v13 快照带 `items` 被拒；`id` 重复；`seq` 不增；偏移越界、重叠、段间有非空白；两个开着的段；终态 Run 里有 running 或 waiting；超 256 条或 128 KiB；未知键。
- 转换：终态条目不退回，关闭的段不变。
- 旧程序：用 `user_version=15` 模拟，Store 与 Reader 都拒绝，库不变。
- `contentReferences` 含只在条目里出现的引用。
- `store.list(100)` 在 100 个大会话上读得出；按试用夹具打印条目前后的快照字节（`t.diagnostic`，照 ADR-047）。

## 线 B：运行时按到达顺序产出条目

改 `src/contexts/session/application/runtime.ts`：
- `output()` 的 tool、notice、activity、plan 各分支（`:1310-1346`）；`permission_requested` 与撤回（`:1288-1308`）。
- `flushStream`（`:1425-1446`）：开段、关段、推进 `endedAt`。
- `storeDetail`、`nativeOutput`（`:1473-1504`）：占位，写好后补引用，写失败标 `failed`。
- `decidePermission`（`:259-281`）、`expire`（`:1255-1270`）、回合结束的 finally（`:1840-1842`）。
- `ended`（`:1903-1971`）：收场、`context_event`。
- `withNotice`（`:181-185`）：预算通知也要放条目。
- 三处旧字段的静默丢弃改成计入 `omitted`（`:1313,1327-1328,1488`）。

另：
- 新文件 `src/contexts/session/domain/items-place.ts`：放条目、关段、收场、计省略，纯函数，runtime 与 `recoverSession` 共用。
- `state.ts` 只在 `recoverSession`（`:601-614`）里加一次调用，等 A 合并后做。
- 可选，放最后：`ControlEvent.text` 加可选 `messageId`（`control.ts:94`），Codex 填 `itemId`（`codex.ts:838-845`），ACP 有就填（`acp.ts:877`）。这会碰 Driver，要和 proto-core 错开。

不碰：解析与迁移（A）、帧与界面（C）、读者（D）。

完成：ADR-057 第 2、4、5、6 节的行为都有测试；旧字段的写入与升级前逐字相同（交接单黄金夹具 `tests/fixtures/relay/golden` 不变）；真机通过（见下）。

测试，扩 `tests/integration/session-runtime.test.ts` 里 ADR-047 那套“测试自己演的程序”：
- 分段：文字、工具、文字、思考、文字的脚本，偏移切出的文字等于消息；空白窗口不开段；同类并段；换种类与新条目关段；plan 与工具更新不切段。
- 身份：同一工具反复上报 `seq` 不变，内容不变不提交。
- 审批：开出 `waiting`；允许、拒绝、预算到期、Harness 撤回、用户停止各自收场；secret 回答不出现在快照、事件、`commands[].fingerprint` 里（对序列化后的字节搜原文和它的 SHA-256）。
- 收场与重启：pending 的工具在 completed 回合里变 `unknown`，cancelled 回合里变 `cancelled`；用真实 Store 关掉再开，`waiting` 变 `cancelled` 且没有 decision，Run 为 `unknown`。
- 上限：300 个不同工具得 256 条加 `omitted.items`；审批不被挤掉；超限后文字仍进消息。
- 产物：先占位后补引用；写失败为 `failed`。
- `context_event`：借 `tests/integration/relay-clear.test.ts` 的清空场景。
- 对照：同一脚本，旧字段投影与条目投影一致，只差先后与审批。

## 线 C：读侧函数的落盘路径、帧与前端接线

改：
- 新文件 `src/contexts/session/domain/protocol/stored.ts`（第 1 步的目录里只加这一个文件，入口函数里加一次调用）：把 `run.items` 与消息、`run.thinking` 按偏移切出文字；推出 `phase`（回合终态后除 plan 外最后一个助手段是 `final`）；派生 switch、interrupt、error、user_message；有 `omitted` 时派生“还有 N 个”的通知。
- `web/src/api.ts`：`decodeRun` 读 `items`、`omitted`，上限 320（超限整体判无效，`:35-38`）。
- `web/src/session-stream.ts`：归并时，没被任何段覆盖的消息尾部就是最后一段。
- `src/contracts/web.ts` 只补注释；`docs/contracts/public-api.md`。
- 界面的数据入口：有 `items` 走落盘路径，没有走投影。渲染是 proto-web 第 1 步的，不重做。

不碰：Store、Runtime、领域层、读者。`src/web/session-stream.ts` 预计不用改，只加测试证明文字窗口仍发 message 帧。

完成：浏览器里“文字、工具、文字”按先后画，流式时最后一段跟着长，刷新与重连后相同；`pnpm test:web` 通过。

测试：
- 读侧：偏移切出的文字；`final` 的推导（进行中没有，终态后有，plan 在最后时不挡）；同一批夹具走落盘与投影两条路，结果一致，只差先后与审批；没被段覆盖的尾部排在最后。
- 解码：有效、超限无效、旧服务没有 `items` 照常。
- 帧：文字窗口只发 message 帧；动作发 run 帧并带 `items`。
- 归并：先收 run 帧再收 message 帧，尾部显示正确。
- 浏览器：照 `tests/browser/web.browser.ts` 与 `tests/fixtures/web-harness-peer.mjs`。

## 线 D：读者切换

- D1 导出 `src/web/conversation-export.ts`：有 `items` 时按次序写回复、动作、审批，没有则旧写法。
- D2 上下文桌 `src/contexts/session/domain/table.ts`：目录行可显示先后；`#k` 工具编号仍按 `tools[]`；搜索仍搜整条消息。
- D3 交接单叙述 `src/contexts/session/domain/relay/narration.ts`：最后做，单独审查；不改就不动。

不碰：Store、Runtime、帧。完成：没有 `items` 的 Run 输出与改前逐字相同；有 `items` 的次序对；交接单黄金夹具在 D3 之前不变。测试：导出旧新各一份黄金输出；上下文桌编号不变；`narration` 黄金夹具。

## 真机要验证的

合成测试代替不了。用临时数据根和临时工作区，写一个新的 `tests/real/native-items.real.ts`（照 `tests/real/native-activity.real.ts` 与 `guard.ts`，`HH_REAL_HARNESSES=claude,codex`；Claude 用 haiku，不考模型的字符级能力），起的不是 4317。

1. 边说边做：提示“先用一句话说你要做什么，再用 ls 看目录、读 package.json，最后一句话总结”。读 `runs[].items`：说明、命令、读文件、总结的先后对，偏移切出的文字等于回复，`tools[]` 仍在，命令都有终态而不是 `unknown`。
2. 审批：Codex 选 `approval_policy` 为 untrusted，Claude 用默认模式，让它改一个文件。批准前看到 `waiting`，允许后 `completed` 带 decision；另跑一次拒绝，得 `declined`。
3. 重启：回合结束后关掉整个应用再开，条目逐字相同。在审批等待中杀掉应用再开：Run 为 `unknown`，审批为 `cancelled` 且无 decision，已有文字还在。
4. 停止：工具运行中点停止，进行中的条目为 `cancelled`。
5. 旧库：用线 A 的合成 v13 夹具建根，新构建打开，迁移成功，旧 Run 靠投影读得出。
6. 帧体量：记一次长回复和一次多工具回合里的 SSE 帧字节，回填 ADR-057 第 7 节的触发条件。

先写明验证不了的：secret 提问（要 Codex 触发 `isSecret`，只在合成测试里验）、超过 256 条的真实回合、4317 的升级（要你点头）。

## 设计稿没有覆盖的问题（读代码时发现）

1. **列表读上限。** `store.list(100)` 把 100 个会话的快照字节加起来不能超过 8 MiB（`state.ts:24`，`sqlite-store.ts:178-188`），`/api/v1/state` 与就绪视图都读它（`server.ts:580,783`）。快照一变大，整页状态就读失败。建议：线 A 先测；读上限调到 32 MiB 并与快照上限分开；根治是列表只取摘要，不解析整份快照。
2. **内容回收。** 启动时 7 天回收器按 `contentReferences()` 保留引用（`sqlite-store.ts:376-392`，`session-application.ts:126-128`）。只在条目里出现的引用不读就会被收走。建议：线 A 加上并测。
3. **secret 回答的指纹。** `decidePermission` 把回答原文放进裸 SHA-256 的 fingerprint 并持久化（`runtime.ts:263`，`session-application.ts:55,140`），编号又在事件里。建议：secret 不进指纹；非 secret 的自由文本是否改用带密钥的摘要，线 B 判断。
4. **协议类型缺字段**（都是可选的新增，先问 proto-core）：`AssistantMessageItem.text`（分段后只靠 `messageId` 定位不了文字，建议读侧填好）；`QuestionItem.secret?`（界面才能写“已回答，内容未保存”）；`ApprovalItem.forItem?`，同时 `permission_requested` 事件带 `toolId`（Codex 有 `itemId`，`codex.ts:973,979`；ACP 有 `toolCallId`，`acp.ts:994`；没有它，“已允许：运行 npm test”对不上那条命令）；`FileChangeItem.more?`（超过 64 个文件时的余数）。
5. **Driver 丢了消息身份。** Codex 的 `itemId` 与阶段、ACP 的消息边界都没转给 Runtime（`codex.ts:838-845`，`acp.ts:877`），相邻两条原生消息会合成一段，中间也未必有换行。建议：`text` 事件加可选 `messageId`，Codex 先做。
6. **有的上下文事件快照里没有。** Hub 清空与原生命令的上下文效果只在 `run.ended` 事件里（`control.ts:139-145`，`runtime.ts:1896-1900`），读侧取不到，而时间线要显示“新会话”分隔。建议：线 B 在回合结束时写 `context_event` 条目。
7. **回合结束时还开着的动作。** Claude 前台命令一直报 pending（审计 B.4.3），OpenClaw 补记没结果的工具也写 completed（`openclaw.ts:162`）。建议：Runtime 按 ADR-057 的收场表写 `unknown`，OpenClaw 的归一在第 1 步改成未知。
8. **静默丢弃。** `tools[]`、通知、活动、产物超限直接 `return`（`runtime.ts:1313,1327-1328,1488`），交接单的“省略有账”也算不进去。建议：计入 `omitted`，D3 时让叙述引用它。
9. **读侧函数在哪儿跑、线上传几份。** 若第 1 步让服务端在 `view()`（`server.ts:257-269`）里附上投影好的 `ProtocolTurn`，就不要再让原始 `items` 同时上线，否则每个 Run 在每个帧里出现两份。建议：只在一处投影，与 proto-web 对齐后定。
10. **产物与详情是异步写的。** 产物字节先写内容库再提交（`runtime.ts:1496-1503`），写失败现在只留一条诊断（`:1499`）。建议：条目到达时占位，写失败标 `failed`，用户看得见。
11. **思考用时。** dsh 的思考整块到达（审计 B.4.2），Hub 钟差是 0。建议：读侧把 0 当未知，不写“思考了 0 秒”。
12. **旧 Run 的先后其实还在事件日志里**（`run.output` 按到达顺序，`runtime.ts:1282-1284`）。建议：v14 不做；以后要还原，只加读侧回放，不动存储。

## 合并时的文档动作

本分支只新增了 ADR-057 和这份计划，没有改任何已有文件。合并时：`docs/decisions/README.md` 加 ADR-057 一行；`docs/decisions/LOG.md` 记一两句（决定：落盘形状、双写、降级脚本）；`docs/contracts/storage-events.md` 随线 A、`docs/contracts/public-api.md` 随线 C 更新；验证记录（真机结果和没验证的部分）写进 `docs/verification/`。ADR-057 的状态在审查通过、线 A、B 合并后改为 accepted。
