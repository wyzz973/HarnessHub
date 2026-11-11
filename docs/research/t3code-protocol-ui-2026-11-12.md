# T3 Code 的“统一协议 + 统一渲染”做法：只读调研报告

- 对象：`pingdotgg/t3code`，commit `b883156e`（2026-11-10），浅克隆在 `.../scratchpad/research/t3code/`。
- 方法：只读源码、文档与公开 issue；没有运行任何仓库脚本，没有装依赖，没有看到真实界面（所以“长什么样”都是从组件代码和用户文档还原的文字描述）。
- 证据标注：
  - 【源码】= 我读到了对应代码；行号为该 commit 下的行号。
  - 【文档】= 仓库自己的文档这样陈述（未必与代码逐条核对）。
  - 【issue】= 公开 GitHub issue（标注编号与状态）。
  - 【推断】= 我根据上下文推出的结论，没有直接证据。
- 路径缩写（本文所有 `path:line` 都用）：
  - `C/` = `packages/contracts/src/`
  - `PC/` = `packages/provider-core/src/server/`
  - `AD/` = `apps/server/src/orchestration-v2/Adapters/`
  - `OV/` = `apps/server/src/orchestration-v2/`
  - `ACP` = `packages/provider-acp/src/server/adapter.ts`
  - `OC/` = `packages/provider-opencode/src/server/`
  - `SH/` = `packages/shared/src/`
  - `CR/` = `packages/client-runtime/src/`
  - `WEB/` = `apps/web/src/`
  - `WC/` = `apps/web/src/components/chat/`
  - `DOC/` = `docs/`

---

## 0. 先看结论（一页版）

1. **三层**：适配器（把各家原生协议翻成统一“领域事件”）→ 编排器与投影（事件落库，生成规范实体，其中 `TurnItem` 就是“可直接渲染的时间线条目”）→ 客户端展示层（按 `TurnItem.type` 渲染，外加一套与 provider 无关的“工作日志”归类/摘要/标题函数）。【源码】`DOC/orchestration-v2/README.md:44-60`，`PC/ProviderAdapter.ts:83-199`。
2. **条目词汇表小而固定**：`TurnItem` 共 **25 种**；其中“工具类”只有 5 种（命令、文件变更、文件搜索、网页搜索、通用工具），其余 20 种是文本/思考/计划/提问/审批/错误/生命周期。没有 `mcp_tool_call`、`image`、`skill`、`hook` 这类单独类型。【源码】`C/orchestrationV2.ts:1622-1846`。
3. **兜底只有一种**：`dynamic_tool`（工具名 + 任意 JSON 入参/出参）。原生项如果在适配器里没有映射，**直接被丢弃**，不会带着原始载荷进协议；原始帧只进有界滚动的诊断日志。【源码】Codex 适配器 `item/completed` 末尾 `return`（`AD/CodexAdapterV2.ts:5360-5362`）、OpenCode `default: return`（`OC/adapter.ts:2491-2493`）；【文档】`DOC/orchestration-v2/core-graph-and-data-model.md:567-596`。
4. **归一发生在两层，而且深度不一致**：
   - 适配器内：各家各写各的“工具名/ACP kind → 条目类型”规则（Claude 一张查表、OpenCode 子串规则、ACP 一个 kind switch、Codex 按原生项类型）。没有跨适配器共用的“归类函数”。
   - 客户端共用函数（`classifyToolActivity` 等）：把 `dynamic_tool` 再按语义分成 read / search / command / edit，用于一行标签、图标和“工具组摘要”。
5. **界面基本不看 provider**：时间线行组件只看 `type/status/title` 与结构化字段；`driver` 只用来选图标。但并非“完全不看”——找到 6 处 Claude/Codex 特例（见 C11、D16）。
6. **一致性靠这几样**：固定词汇表、整实体 upsert + 确定性 id、生命周期条目由编排器统一产出、应用自有的检查点（diff 不依赖 provider）、统一的折叠/可见性策略、能力旗标与回放夹具。**不是**靠每家产出一模一样的条目序列：同一个“网页搜索”场景，Codex 产出 `web_search`，Claude 额外多一条 `dynamic_tool(ToolSearch)`。【源码】`OV/testkit/fixtures/web_search/{codex,claude}_output.ts`。
7. T3 自己的 `AGENTS.md` 把原则写成一句话：复杂度放在适配器边界，编排保持纯净，UI 保持“笨”。【源码】`AGENTS.md:194`。

---

## 1. 数据流与分层

```
原生协议 (Codex app-server JSON-RPC / Claude Agent SDK 消息 / ACP session/update / OpenCode 事件 …)
  └─ 适配器 ProviderAdapterV2：每家一个，产出 16 种 ProviderAdapterV2Event
       └─ 编排器 Orchestrator（无 I/O，决定事件）→ 事件存储（带全局 sequence）
            └─ 投影：ThreadProjection { runs, attempts, nodes, subagents, messages, plans, turnItems, visibleTurnItems, checkpoints … }
                 └─ 线上瘦身 WireProjection（去掉大输出/大 diff，打 *Omitted 标记）
                      └─ 客户端：snapshot + 增量事件 → TimelineEntry → MessagesTimelineRow → 行组件
```

- 事件存储里的 `sequence` 是游标：快照读到 N，之后只推 `sequence > N` 的事件。【文档】`DOC/orchestration-v2/core-graph-and-data-model.md:31-38`。
- “规范存储”其实是一张**图**（Run / RunAttempt / ExecutionNode / ProviderThread / ProviderTurn / RuntimeRequest / Checkpoint …），`TurnItem` 是**面向显示的投影记录**，文档明确说它“不是 canonical source of truth”。【文档】同上 `:612-616`。适配器**同时**发 `node.updated`（图）和 `turn_item.updated`（显示）两份，例如 Codex 的 `commandExecution` 每次都发这一对。【源码】`AD/CodexAdapterV2.ts:5077-5086`。
- 文档里的十条不变量与“可借鉴”的几条：App id 为主、provider id 只是引用；绝不把一家的事件改写成另一家的事件；子执行完成不会关闭父 run；缺失能力要显式表示并由策略处理；功能由能力驱动而不是 provider 名驱动。【文档】`DOC/orchestration-v2/README.md:31-42`。

---

## A. 统一的条目模型（协议）

### A1. 规范存储里的条目类型（`TurnItem`，25 种）

**所有条目共有的基础字段**【源码】`C/orchestrationV2.ts:1521-1548`

| 字段 | 类型/取值 | 说明 |
|---|---|---|
| `id` | TurnItemId | 应用侧 id（见 A2 的派生规则） |
| `threadId` / `runId` / `nodeId` | id / id 或 null / id 或 null | 所属线程、run、执行图节点 |
| `providerThreadId` / `providerTurnId` | id 或 null | 对应的 provider 会话/回合 |
| `nativeItemRef` | `{driver, nativeId/null, strength: strong/weak/none, fingerprint?, ordinal?}` | 原生 id 只作引用 |
| `parentItemId` | id 或 null | 条目嵌套（子 agent 等） |
| `ordinal` | 整数 ≥ 0 | 回合内的位置（由适配器预留，见 A2） |
| `status` | `idle/pending/running/waiting/completed/failed/cancelled/interrupted`（8 种，`:1451-1462`） | 通用状态 |
| `title` | string 或 null | 可选标题；很多适配器留 null，由客户端生成标签 |
| `startedAt` / `completedAt` / `updatedAt` | 时间 | |
| 可选展示元数据 | `toolSurface: browser/computer`；`toolIcon`（website / native-app / themed-logo 三种）；`toolSource {key,name,kind: browser/computer/integration, icon?}`；`toolNonExecutionKind: string` | 工具图标/来源；`toolNonExecutionKind` 来自 Claude SDK 的 `non_execution_kind` 元数据，表示“工具并未真正执行”【源码】`AD/ClaudeAdapterV2.ts:3697-3702`；类型在 `C/providerRuntime.ts:88-126` |
| `deferredWork`（仅线上） | `{cursor,itemCount,lastOrdinal}` | 折叠的历史工作，客户端展开时再拉 |

**25 种类型的专有字段**【源码】`C/orchestrationV2.ts:1622-1846`（子结构行号见各行）

| # | `type` | 专有字段 | 状态怎么用 | 谁产出 |
|---|---|---|---|---|
| 1 | `user_message` | `messageId, text(+textOmitted), context?, attachments[], inputIntent: turn_start/queued_turn/steer/promoted_queued_to_steer, modelSwitch?{from,to}, freshContext?, createdBy, creationSource, scheduledTaskId?, senderThreadId?, idleCompaction?, workflowScript?` | 排队中的用户消息是 `pending` | 编排器（子 agent 的用户消息由适配器发，`CodexAdapterV2.ts:3642-3696`） |
| 2 | `assistant_message` | `messageId, text(+textOmitted), attachments?, streaming: boolean` | 流式中 `running`+`streaming:true`，完成后 `completed` | 适配器 |
| 3 | `reasoning` | `text, streaming` | 同上 | 适配器 |
| 4 | `proposed_plan` | `planId, markdown, streaming` | 同上 | 适配器（同时发 `plan.updated`） |
| 5 | `todo_list` | `planId, steps[{id,text,status: pending/running/completed, durationAnchorAt?, durationMs?}], explanation?` | 每次更新一个整表 | 适配器（同时发 `plan.updated`） |
| 6 | `user_input_request` | `requestId, questions[{id,header,question,options[{label,description,value?,preview?}],multiSelect?,allowCustomAnswer?,initialAnswer?,required?}], questionAnswer?, responseMode?: "message"` | 等待回答 `waiting`；答完带 `questionAnswer` | 适配器 |
| 7 | `file_change` | `fileName, additions?, deletions?, diffStr?, oldStr?, newStr?, changes?[{operation,path,oldPath?,fileType?,mimeType?}]` | 工具生命周期 `running→completed/failed/cancelled` | 适配器 |
| 8 | `command_execution` | `input, output?, outputOmitted?, outputIndicatesFailure?, exitCode?, monitor?` | 同上；服务端会据 `exitCode`/输出文本补 `outputIndicatesFailure` | 适配器 |
| 9 | `file_search` | `pattern?, results?[{fileName,line?,column?,preview?}]` | 同上 | 适配器（仅 OpenCode/ACP/Cursor，Claude/Codex 不发） |
| 10 | `web_search` | `patterns?[], results?[{title?,url?,snippet?}]` | 同上 | 适配器 |
| 11 | `approval_request` | `requestId, requestKind: command/file-read/file-change/mcp-elicitation/permission, prompt?, reason?, fullAccessOverride?, appName?, options?[]` | 待批 `waiting`；决议后的状态更新不在适配器里【推断：由编排器完成】 | 适配器 |
| 12 | `checkpoint` | `checkpointId, scopeId, files[{path,kind,additions,deletions}], filesTotal?, filesOmitted` | 一次性 | 编排器/检查点服务 |
| 13 | `run_interrupt_request` | `message, unresponsiveAt?` | 停止请求已发出；超时未确认时带 `unresponsiveAt`，界面出现 Force stop | 编排器 |
| 14 | `run_interrupt_result` | `message` | 停止结果 | 编排器 |
| 15 | `system_notice` | `message` | 一次性 | 适配器/编排器 |
| 16 | `error` | `failure{class: usage_limit/provider_error/transport_error/permission_error/validation_error/unknown, message, code/null, retryable/null, resetAt?}, retry?{attempt,maxAttempts/null,retryDelayMs/null}` | 重试中 `running`，恢复 `completed`，终败 `failed` | 编排器（`OV/Orchestrator.ts:1870,9947,10725`）；Codex 的重试行由适配器发（`CodexAdapterV2.ts:4901-4905`） |
| 17 | `compaction` | `driver, summary?, beforeTokenCount?, afterTokenCount?` | `running`（“Compacting context”）→`completed` | 适配器 |
| 18 | `handoff` | `contextHandoffId, fromProviderThreadIds[], toProviderThreadId, fromProviderInstanceIds[], toProviderInstanceId, fromModelSelections?, toModel?, strategy: delta_since_target_last_seen/fork_delta_summary/full_thread_summary/checkpoint_summary/manual_context, summary?` | `pending/failed` 影响分隔线颜色 | 编排器（`Orchestrator.ts:2449,7858`） |
| 19 | `fork` | `source: {run}/{node}/{provider_thread}, targetThreadId, providerThreadId?` | 一次性 | 编排器（`:4887`） |
| 20 | `thread_created` | `targetThreadId, targetRunId, targetProviderInstanceId, targetModel` | 一次性 | 编排器（`:9196`） |
| 21 | `secret_request` | `label, reason, url?, placeholder?, delivery?: "file", secretStatus: pending/saved/declined/cancelled`（`:1565-1584`） | — | 编排器/MCP |
| 22 | `link_request` | `url?, reason, environmentId?, label?, hint?, requestedAccess?, linkStatus: pending/linked/declined/cancelled/failed, linkedEnvironmentId?, linkedLabel?, linkedAccess?, failure?`（`:1586-1620`） | — | 编排器/MCP |
| 23 | `subagent` | `subagentId, origin: provider_native/app_owned, driver, providerInstanceId, childThreadId/null, remoteChild?, prompt(+Omitted), progress?, result/null(+Omitted)` | 8 种通用状态 | 适配器 |
| 24 | `dynamic_tool` | `toolName/null, viewedImagePath?, input: unknown, output?: unknown, outputOmitted?` | 通用工具生命周期 | 适配器（**兜底类型**） |
| 25 | `notification` | `source{kind: delegated_task/background_task/command/subagent/monitor/system …}, outcome: completed/failed/cancelled/updated/unknown, summary, detail?`（`:1258-1308`） | — | 编排器（后台任务/子 agent 完成通知） |

补充：
- **并行的规范实体**：`ConversationMessage`（`message.updated`，与 user/assistant 条目镜像）、`PlanArtifact`（`proposed_plan | todo_list`，`plan.updated`，状态 `draft|active|completed|superseded`，`:1374-1396`）、`ExecutionNode`（`kind: root_turn|assistant_message|reasoning|plan|todo_list|tool_call|approval_request|user_input_request|subagent|hook|system`，`:771-810`）。界面只读 `visibleTurnItems`，不直接碰节点图。
- **`ProjectedTurnItem` 包装**：`{position, visibility: local|inherited|synthetic, sourceThreadId, sourceItemId, item}`（`:1872-1879`）。分叉出的线程会“继承”源线程的条目，还会插入“synthetic”的分叉标记。
- **条目状态的“被拒/取消”**：没有单独的 `denied`。Codex 的 `declined` 被映射成 `cancelled`（`CodexAdapterV2.ts:413-436`）；Claude 用 `toolNonExecutionKind` 区分“取消/拒绝”（`ClaudeAdapterV2.ts:7572-7596`）。

### A2. 事件流：适配器向编排层发什么

**`ProviderAdapterV2Event`：16 个联合成员（15 种 type，`turn.terminal` 有成功/失败两个变体）**【源码】`PC/ProviderAdapter.ts:83-199`

| # | type | 载荷要点 | 作用/备注 |
|---|---|---|---|
| 1 | `app_thread.created` | `appThread, createOnly?` | 适配器发现/导入原生会话时建线程 |
| 2 | `provider_session.updated` | `providerSession` | 会话进程状态 |
| 3 | `provider_thread.updated` | `providerThread, pendingBackgroundWork?, retainedNativeTurnIds?` | 原生会话句柄 |
| 4 | `provider_turn.updated` | `threadId?, providerTurn` | 回合状态、用量、实际模型 |
| 5 | `node.updated` | `node` | 执行图节点 |
| 6 | `subagent.updated` | `subagent` | 子 agent 实体 |
| 7 | `message.updated` | `message` | 用户/助手消息实体 |
| 8 | **`turn_item.updated`** | `turnItem`（**整条**） | 显示条目的唯一通道 |
| 9 | `steer.updated` | `threadId, runId, messageId, status: pending/completed/cancelled` | 引导消息是否被 agent 读到 |
| 10 | `background_work.updated` | `providerTurnId, pending` | 后台任务是否还挂着（决定是否保持 Waiting） |
| 11 | **`command_output.delta`** | `threadId, itemId, chunk` | **唯一的真增量**，不落库 |
| 12 | `prompt_suggestion.updated` | `threadId, runId, text` | 预测的下一条提示，不落库 |
| 13 | `runtime_request.updated` | `threadId?, runtimeRequest` | 审批/提问等“需要回应”的请求 |
| 14 | `plan.updated` | `plan` | 计划/待办实体 |
| 15 | `turn.terminal`（成功/中断/取消） | `providerThreadId, providerTurnId, runOrdinal, status, failure:null, reason?, threadDisposition: reusable/broken` | 回合终态 |
| 16 | `turn.terminal`（失败） | `…, failureItemOrdinal, failure, retry?, retryStartedAt?, threadDisposition, childTurnsContinue?` | 失败终态，带分类后的失败 |

**流式增量怎么表达**
- **文本、思考、计划文本没有 delta 事件**。适配器里的 `ProviderTextDeltaCoalescer` 把原生 delta 按定时器累加成“累计文本”，再作为**整条** `assistant_message / reasoning / proposed_plan`（`streaming:true`）发 `turn_item.updated`；结束时发 `streaming:false`、`status: completed`。【源码】`AD/ProviderTextDeltaCoalescer.ts:1-156`，Codex 用法 `AD/CodexAdapterV2.ts:3486-3640`。
- **命令输出**走独立通道：适配器发 `command_output.delta`（不落库）。客户端只在“展开了该命令行”时订阅 `subscribeCommandOutput`，收到 `{kind: replace|append, text, truncated, running}` 帧；折叠的行什么也收不到。【源码】`C/orchestrationV2.ts:3649-3658`，`WC/CommandOutputPanel.tsx:20-80`。
- 服务端对同一条目的 `running` 更新做 **50ms 窗口合并**，只保留最新一次（并保证重连游标不会跳过别的更新）。【源码】`OV/ThreadLiveEventCoalescer.ts:15-77`。

**条目的“开始/更新/完成”怎么表达**
- 没有 started/completed 事件对。**同一个 id 反复发 `turn_item.updated`**，靠 `status` 和 `startedAt/completedAt` 表达生命周期。Codex 的 `item/started` 发 `running`，`item/completed` 发 `completed/failed/cancelled`。【源码】`AD/CodexAdapterV2.ts:4985-5451`。

**条目的 id 由谁给**
- 适配器通过共享服务 `IdAllocatorV2` 派生：`turn-item:provider:<driver>:native-item:<原生id>`（节点、消息同法）。同一原生项永远得到同一个应用 id，所以重复上报是“覆盖”而不是“新增”。run、attempt、root node 也是确定性派生；plan/runtimeRequest/event/command 用随机 UUID 分配。【源码】`PC/IdAllocator.ts:129-181, 254-294`。
- 原生 id 另存为 `nativeItemRef`；弱 provider 用“作用域序号 + 指纹”。规则：已有稳定原生 id 就复用绑定；没有就按作用域序号；序号不够再加指纹；一旦分配永不改。【文档】`DOC/orchestration-v2/entity-ids-and-correlation.md:100-140`。
- **`ordinal`（显示顺序）由适配器在第一次见到该项时预留**，所以延迟刷新的文本不会排到后来才开始的工具后面。【源码】`AD/CodexAdapterV2.ts:3550-3552` 的注释与 `resolveItemPosition`。
- 编排器自己产出的条目（error/handoff/fork/thread_created/中断/检查点）id 由编排器给。【源码】`OV/Orchestrator.ts` 上述行号。

**客户端怎么拿到**
- 线程流：`snapshot`（整份投影 + `snapshotSequence`）+ `event`（`sequence` 递增）+ `synchronized`；遇到**未知事件类型或未知条目类型**时，客户端只推进游标并跳过（`unknown-event`）。【源码】`C/orchestrationV2.ts:3924-3980`。
- 线上“瘦身”：`projectTurnItemForWire` 去掉命令输出、文件 diff/旧新文本、动态工具大输出，打上 `outputOmitted` 等标记，并在服务端补 `outputIndicatesFailure`；客户端展开该行时按 `(threadId, itemId, revision)` 单独拉全文。【源码】`OV/WireProjection.ts:155-205`，`WC/V2ItemInspector.tsx:95-132`。

### A3. Run / Turn 的状态机与字段

**三层“回合”概念**（文档解释了为什么要分开：provider 的回合终态、子 agent 的回合、steer 重启都会让“一个 provider turn = 一次用户可见回合”不成立）【文档】`DOC/orchestration-v2/README.md:83-94`。

| 实体 | 状态 | 字段（要点） | 行号 |
|---|---|---|---|
| `Run`（用户可见回合，计数单位） | `preparing, queued, starting, running, waiting, completed, interrupted, failed, cancelled, rolled_back`（10 种） | `id, threadId, ordinal, providerInstanceId, modelSelection, providerThreadId, userMessageId, rootNodeId, activeAttemptId, status, queuePosition?, queueHeld?, requestedAt, startedAt, completedAt, workStartedAt?, checkpointId, contextHandoffId, restartContinuationOfRunId?, usageLimitContinuationOfRunId?, delegatedTaskId?, sourcePlanRef?, workspacePreparation?, freshContext?` | `C/orchestrationV2.ts:598-610, 684-719` |
| `RunAttempt` | `pending, running, completed, interrupted, failed, cancelled, superseded` | `id, runId, attemptOrdinal, rootNodeId, providerThreadId, providerTurnId, reason: initial/steering_restart/retry/provider_recovery, startedAt, completedAt` | `:746-769` |
| `ExecutionNode` | `idle,pending,running,waiting,completed,interrupted,failed,cancelled,rolled_back` | `kind, countsForRun, providerThreadId, providerTurnId, nativeItemRef, runtimeRequestId, checkpointScopeId` | `:771-810` |
| `ProviderTurn` | `pending, running, completed, interrupted, failed, cancelled` | `id, providerThreadId, nodeId, runAttemptId?, nativeTurnRef, ordinal, startedAt, completedAt, tokenUsage?, turnTokenUsage?, model?`（**provider 报告的实际模型**，可能不同于请求模型） | `:1192-1214` |
| `RuntimeRequest`（需回应的请求） | `pending, resolved, expired, cancelled` | `kind: command/file-read/file-change/mcp-elicitation/permission/dynamic_tool_call/user_input/auth_refresh`，`responseCapability: live/message/not_resumable`，`decision?, feedback?, answers?` | `:1231-1256` |

**用量与耗时**
- `ProviderTurn.tokenUsage`：`usedTokens, maxTokens?, inputTokens?, cachedInputTokens?, outputTokens?, reasoningOutputTokens?, promptCacheTtlMs?, autoCompactThreshold?, promptCacheExpiresAt?, updatedAt`（`C/orchestrationV2.ts:217-230`）。
- `ProviderTurn.turnTokenUsage`：`usageScope: "main_agent"`，`usageStatus: complete|partial|unavailable`，`inputTokens/outputTokens`（complete 时必填），`cachedInputTokens?, cacheCreationTokens?, reasoningTokens?, hasSubagents, models?, localCommand?, otherUsage?`（`C/providerRuntime.ts:56-86`）。“缺数据”用 `partial/unavailable` 显式表达，不填 0。
- 线程级用量快照还有 `cost{amount,currency}, toolUses, durationMs`（`:30-54`）。
- **界面上的耗时是客户端算的**：`Worked for 2m 3s` 取 `latestRun.startedAt→completedAt`，否则取条目时间戳之差（`WC/MessagesTimeline.logic.ts:1170-1185`）。

**运行时状态机（文档描述，与代码一致的部分我看到了）**【文档】`DOC/orchestration-v2/feature-lifecycles.md:27-60, 224-260, 529-543`
- 发送消息 → `Run(queued)` + 根节点；provider 接手 → `running`；**只有根节点的 provider 终态能结束 run**；子 agent/工具/审批可以各自完成。
- 停止：`interrupt` 请求返回只是“已受理”，终态要等 provider 自己报 `interrupted`；provider 不确认时出现 `run_interrupt_request.unresponsiveAt`，界面给 Force stop。
- 完成前有“终结屏障”：冲刷文本缓冲、关闭未完成流、定稿计划、再截检查点、再发布 run 终态。
- steer：provider 支持就原地引导；不支持就中断并新建 `RunAttempt(steering_restart)`；也可以排队成新 run。

**停止原因**：没有统一的 `stop_reason` 枚举。能表达的是：终态 `status`（完成/中断/取消/失败）、非失败终态的自由文本 `reason`、失败的 `failure.class/code/retryable/resetAt`、`threadDisposition: reusable|broken`。【源码】`PC/ProviderAdapter.ts:173-198`，`C/orchestrationV2.ts:1473-1496`。

### A4. 遇到某家特有、协议里没有的东西怎么办

| 情形 | 做法 | 证据 |
|---|---|---|
| 未知工具、MCP 工具、技能（Skill）、图片生成、ToolSearch 等 | 一律 `dynamic_tool{toolName, input, output}`；MCP 额外带 `toolSource/toolIcon/title`（来自 `mcpToolPresentation`） | `AD/CodexAdapterV2.ts:535-563,3948-3996`；`PC/mcpToolPresentation.ts:22-70` |
| 已知常见工具（命令/改文件/搜网页…） | 结构化变体，**让前端不用解析 provider 文本就能渲染稳定组件** | 【文档】`DOC/orchestration-v2/core-graph-and-data-model.md:624-679` |
| 原生项在适配器里没有映射 | **丢弃**。Codex 的 `imageView`、`enteredReviewMode`、`exitedReviewMode`、`hookPrompt` 在适配器里没有任何引用；OpenCode 的 step-start、file、patch、snapshot 等 part 走 `default: return` | `AD/CodexAdapterV2.ts`（grep 无命中）；`OC/adapter.ts:2483-2493` |
| 未映射的“需回应请求” | 曾经落成 `unknown`，客户端不渲染审批 UI，导致请求挂死（Codex Apps 权限、OpenCode skill 权限） | 【issue】#7825（已关，PR #7861 修复）、#4795（同类，仅见引用） |
| 需要给用户看但无结构的文字 | `system_notice{message}` 或 `notification{summary, detail}` | `C/orchestrationV2.ts:1751-1755`；`ACP:4330-4361` |
| 原始载荷 | **不进协议**。只在 `ProviderAdapterProtocolError.payload`（错误里）和有界滚动的诊断日志里；设计原则是“原始帧是证据与回放输入，不是应用状态” | `PC/ProviderAdapter.ts:429-442`；【文档】`core-graph-and-data-model.md:567-596` |
| 新服务端的未知条目/事件类型（版本错位） | 客户端解码时丢弃/只推进游标，不报错 | `C/baseSchemas.ts:140-225`；`C/orchestrationV2.ts:3924-3955` |
| provider 自己的文字泄露进条目 | 没有过滤层：适配器把工具结果文本原样放进 `result`，Claude 的 `<tools-used-before-summary>` 标签因此出现在子 agent 行里 | 【issue】#30069（开放） |

### A5. 能力声明

**共 70 个旗标，12 组**（你说的“约 65 个”实际是 70）【源码】`C/orchestrationV2.ts:260-399`，我用 awk 数过：

| 组 | 旗标（数量） |
|---|---|
| `sessions`（5） | 单会话多线程；会话内换模型；经交接换 provider；会话内切运行时模式；待处理请求能否跨重启 |
| `threads`（7） | 建空线程；读线程快照；回滚；分叉；从某回合分叉；从子 agent 线程分叉；暴露原生线程 id |
| `turns`（11） | 原生目标（goal）；暴露原生回合 id；发 turn 开始/完成；可中断；可原地引导；引导会打断工具；引导接受附件；可“中断重启”式引导；可排队；终态质量 `strong/weak/none` |
| `streaming`（5） | 流式助手文本；流式思考；流式工具输出；流式计划文本；发“消息完成” |
| `tools`（6） | 暴露工具项 id；发工具开始；发工具完成；发工具输出；支持 MCP 工具；支持动态工具回调 |
| `approvals`（7） | 命令审批；读文件审批；改文件审批；apply_patch 审批；审批有原生请求 id；审批回调只在存活期有效；审批可来自子 agent |
| `planning`（5） | 发 plan 更新；发待办；发 proposed plan；结构化提问；计划 delta 有项 id |
| `subagents`（6） | 支持子 agent；暴露子线程 id；发生命周期；可等待；可关闭；可分叉子线程 |
| `context`（8） | 接受 system/developer/合成用户上下文；能生成摘要；能消费交接摘要；支持增量交接；支持全量交接；推荐的交接上限字符 |
| `checkpointing`（5） | 应用能做文件系统检查点；嵌套检查点；provider 能回滚会话；回滚返回快照；能读会话快照 |
| `runtimePolicy`（1） | `enforcement: native/client-boundary` |
| `identity`（4） | 原生线程/回合/项/请求 id 的强度 `strong/weak/none` |

- 两家的取值差异很能说明问题：Codex 近乎全开且 `nativeTurnIds: strong`；Claude `exposesNativeTurnId:false`、`streamsToolOutput:false`、`streamsPlanText:false`、`supportsSteeringByInterruptRestart:false`、`approvalsCanOriginateFromSubagents:false`、`subagents.*` 多数 false、`nativeTurnIds: weak`。【源码】`AD/CodexAdapterV2.ts:245-337`，`AD/ClaudeAdapterV2.ts:400-493`。
- **界面实际读到的旗标很少**：我 grep 到的只有 `supportsProviderSwitchingViaHandoff`、`supportsActiveSteering`、`supportsSteeringByInterruptRestart`、`canForkThread`、`canForkFromTurn`、`nativeThreadIds`、`supportsFullThreadHandoff`，都在 `CR/state/threadWorkflows.ts:95-200`（用于“能否交接/分叉/把排队消息提升为引导”）。其余旗标主要给服务端策略用（文档的“降级策略”一节）。【源码，grep 结果；若有解构写法可能漏计】
- **真正驱动界面裁剪的是另一份 `ServerProvider` 快照**（每个 provider 实例一份）：`supportedRuntimeModes`（权限档位）、`showInteractionModeToggle`（Plan 开关）、`supportsConversationRollback`、`reportsContextWindow`、`supportsTextGeneration`、`nativeSessions{canList,canLoad,canResume,canDelete}`、`setup{canAuthenticate,canInstall}`、`models[]`（含数据驱动的选项描述符）、`slashCommands[]`、`skills[]`、`usageLimits`、`versionAdvisory`…【源码】`C/server.ts:207-268`；权限档位的裁剪见 `WC/runtimeModeConfig.ts:45-61`（provider 没报就全开；报了就只留它报的）。
- 新增 provider 的规范：旗标必须如实填写，“一个开着却会在运行时失败的旗标就是缺陷”；只提供 provider 真正原生强制的权限档位，**不要**在应用里模仿缺失的档位；客户端“画 provider 包自带的图标，不要加按驱动分支的图标逻辑”；“编排与客户端读能力，不读驱动名”。【文档】`DOC/internals/adding-a-provider.md:19-20, 22-35, 125`。

---

## B. 各家怎么适配到协议

### B6. Codex（app-server 原生项 → 协议条目）

Codex 是“最富的协议”（文档语），其他家被适配成同一个模型。【文档】`DOC/orchestration-v2/README.md:7`。状态映射：`inProgress→running`，`completed→completed`，`failed→failed`，`declined→cancelled`（`AD/CodexAdapterV2.ts:413-436`）。

| 原生项/通知 | 协议产出 | 要点 | 行号 |
|---|---|---|---|
| `item` 类型 `commandExecution`（started/completed） | `command_execution` + node(`tool_call`) | `input=command`，`output=aggregatedOutput`，`exitCode`；started 时已发一次 | `3698-3762, 5062-5088, 5179-5246` |
| `item/commandExecution/outputDelta` | `command_output.delta`（不落库） | 后台命令在回合结束后仍会有 delta | `4528-4546` |
| `fileChange`（只在 completed 发条目；started 只缓存 kind） | `file_change` | `fileName = changes[0].path`，`diffStr = changes[0].diff`（**只取第一个文件的 diff**），`changes[]={operation,path,oldPath?}`；不填 additions/deletions | `3764-3833, 5029-5035, 5272-5289` |
| `mcpToolCall` / `dynamicToolCall` | `dynamic_tool` | `toolName="server.tool"` 或 `namespace.tool`；`input=arguments`；`output` 来自 result/contentItems（图片转 `{type:image}`）；标题经 `dynamicToolTitle`+`mcpToolPresentation`；MCP App 资源另存为内嵌 app | `535-563, 3893-3946, 5248-5270, 4003-4112` |
| `webSearch` | `web_search` | `patterns` 取自 `action.query/queries/url/pattern`；无 `results` | `678-693, 3835-3891` |
| `imageGeneration` | `dynamic_tool`（`image_gen.imagegen`，标题 “Generate image”） | `output={status, savedPath, failure}` | `3948-3996` |
| `reasoning` + `item/reasoning/{summaryTextDelta,textDelta}` | `reasoning` | 每个 summary/content 分片一条；合并器累计后整条上报 | `3486-3574, 4548-4553` |
| `agentMessage` + `item/agentMessage/delta` | `assistant_message` + `message.updated` | 区分 `phase`（final_answer / commentary）；异步带问题的消息转 `user_input_request(responseMode:"message")` | `3576-3640, 5360-5450` |
| `plan` + `item/plan/delta` | `proposed_plan` + `plan.updated` | 完成的方案保持 `active` 直到被“实现” | `4137-4242, 5310-5317` |
| `turn/plan/updated` | `todo_list` + `plan.updated` | 步骤 `inProgress→running` | `4570-4606` |
| `contextCompaction` | `compaction` | `running` “Compacting context” → `completed` “Context compacted” | `4909-4954` |
| `collabAgentToolCall` / `subAgentActivity` | `subagent` + `subagent.updated` + 子 ProviderThread | 子回合有自己的 provider turn，不并入父回合 | `5011-5018, 5139-5151, 5319-5338` |
| `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`mcpServer/elicitation/request`、旧 `execCommandApproval`/`applyPatchApproval` | `approval_request` + `runtime_request.updated` | `status:"waiting"`；`requestKind` 分 command/file-change/permission/mcp-elicitation；记“本会话允许” | `4319-4414, 5453-5805` |
| `item/tool/requestUserInput` | `user_input_request` + `runtime_request.updated` | | `5873+` |
| `error`（`willRetry` 真/假） | `error` 条目（含 `retry{attempt,maxAttempts}`）；终败写入 `turn.terminal.failure` | 用量上限分类成 `usage_limit` 并取重置时间 | `4834-4907, 4608-4637` |
| `thread/tokenUsage/updated` | `provider_turn.updated.tokenUsage` | | `4659-4696` |
| `model/rerouted`、`thread/settings/updated` | 记录“实际模型/设置” | 用于展示实际跑的模型 | `4698-4715` |
| `turn/started`、`turn/completed`、`thread/closed` | `provider_turn.updated`、`turn.terminal` | | `4733+, 6753+, 4958+` |
| **未映射**：`imageView`、`enteredReviewMode`、`exitedReviewMode`、`hookPrompt` | 丢弃 | grep 无命中，落入 `return` | — |

### B7. Claude（Agent SDK 消息块与工具 → 协议条目）

分类表（**按语义归一，但只对 5 类工具做结构化，其余一律 `dynamic_tool`**）【源码】`AD/ClaudeAdapterV2.ts:3059-3099`：

| Claude 工具/块 | 协议条目 | 要点（行号均在 `ClaudeAdapterV2.ts`） |
|---|---|---|
| 文本块 | `assistant_message` + `message.updated` | 流式用 stream_event 的 text delta（`4281`, `9057+`） |
| `thinking` 块（文本非空才发） | `reasoning` | `7611-7635, 9076-9122`；文本为空（API 默认 omitted）时没有条目 |
| **`Bash`** | **`command_execution`** | `input = command/cmd/script`（`3172-3177`）；`output = stdout+stderr`（`3389-3407`）；**不填 `exitCode`**，失败靠 `tool_result.is_error→status:failed` |
| **`Edit` / `MultiEdit` / `Write` / `NotebookEdit`** | **`file_change`** | `fileName` 取 `file_path/notebook_path/path…`（`3286-3291`）；`diffStr` 由工具结果里的 `structuredPatch` 经 `diff` 库格式化成统一 diff（`3370-3387`），**结果回来之前没有 diff**；不填 additions/deletions |
| `WebSearch` / `WebFetch` | `web_search` | `patterns` 取 `query/url/pattern`；`results` 取结构化输出；`WebFetch` 把结果前 8000 字符放进 `snippet`（`3451-3479, 6172-6192`） |
| `Read` | `dynamic_tool` | 标题 `Read <path>`；图片路径写入 `viewedImagePath`（`6080-6082, 6136-6142`） |
| `Grep` / `Glob` / `LS` | **`dynamic_tool`（不是 `file_search`）** | 标题用 `formatSearchToolLabel`（`6084-6093`） |
| `TodoWrite`（仅根级） | **`todo_list` + `plan.updated`，同时还有一条 `dynamic_tool("TodoWrite")`** | `9768-9787`；测试明确断言两者并存 `ClaudeAdapterV2.test.ts:9226-9253` |
| `TaskCreate/TaskUpdate/TaskList` | `dynamic_tool`，并合并进待办列表（子 agent 的也更新父回合列表） | `4790, 9864-9880` |
| `ExitPlanMode`（经 `canUseTool` 拦截） | `proposed_plan` + `plan.updated`（另有 `dynamic_tool` 行）；该工具被“拒绝”并告诉模型停下等用户 | `10464-10482, 9788-9797` |
| `AskUserQuestion`（经 `canUseTool`） | `user_input_request` + `runtime_request.updated` | `10394-10462` |
| 工具权限询问（`canUseTool`） | `approval_request` + `runtime_request.updated` | 请求类别按工具查表：Bash→command，编辑类→file-change，读/搜类→file-read（`3101-3103`） |
| `Agent`（子 agent 工具；代码只识别 `name === "Agent"` 的 tool_use，查表里的 `task` 仍归 dynamic_tool） | `subagent`，**不进 dynamic_tool**（注释写明 Agent 的 tool_use 不进 toolCalls） | `9757-9767, 9814-9836` |
| `Skill` | `dynamic_tool`，标题 `Skill: <name>` | `SH/toolActivity.ts:17-25, 64-65` |
| `Monitor` / `SendMessage` / `TaskStop` / `ToolSearch` | `dynamic_tool` | 查表 `3072-3080` |
| `mcp__server__tool` | `dynamic_tool` + `mcpToolPresentation`（标题、图标、来源） | `9782-9786` |
| 任何未知工具名 | `dynamic_tool` | `3086-3099` 默认分支 |
| 压缩、用量上限等系统消息 | `compaction`、`system_notice` | `9273, 8966, 9364, 11365` |

结论（回答“按语义归一，还是都当通用工具”）：**Bash→命令、Edit/Write→文件变更、WebSearch/WebFetch→网页搜索，是按语义归一的；TodoWrite→计划、AskUserQuestion→提问、ExitPlanMode→方案、Agent→子 agent，是按“特殊控制流”归一的；Read/Grep/Glob/LS/Skill/Monitor/MCP 是通用工具。** 另外有两个反直觉点：搜索类（Grep/Glob/LS）没有归到 `file_search`，`TodoWrite`/`ExitPlanMode` 存在“结构化条目 + 通用工具行”的重复。

### B8. ACP 适配器（通用）

ACP `tool_call` 的 `kind` → 条目类型【源码】`ACP:4042-4322`（判定顺序：压缩标记 → MCP 身份 → 有结构化文件变更 → 按 `kind` 的 switch）

| ACP 输入 | 协议条目 | 要点 |
|---|---|---|
| `agent_message_chunk` | `assistant_message` | `ACP:2660-2745` |
| `agent_thought_chunk` | `reasoning` | 同上（历史上曾被丢弃，见 D16 的 #6618） |
| `user_message_chunk` | `user_message` | 同上 |
| toolCallId 以 `acp-compaction:` 开头 | `compaction` | `4091-4114` |
| 识别出 MCP 身份（server.tool） | `dynamic_tool` + `mcpToolPresentation` | `4115-4173` |
| 有结构化文件变更（不论 kind） | `file_change`（`changes[]`，`diffStr`） | `4174-4181` |
| `kind=read` | `dynamic_tool`，`toolName:"Read"`，标题 `Read <path>` | `4184-4196` |
| `kind=search` | 若是后端网页搜索 → `web_search`；否则 `file_search{pattern=path, results[{fileName,preview}]}` | `4198-4245` |
| `kind=execute` | `command_execution`（`input = command/title`，`output`，`exitCode`） | `4246-4258` |
| `kind=edit/delete/move` | `file_change`（`fileName=path`，`diffStr` 来自 ACP diff 内容） | `4259-4272` |
| `kind=fetch` | `web_search{patterns:[url], results:[{url,snippet}]}` | `4273-4293` |
| `kind=think/switch_mode/other` / 未知 | **`dynamic_tool{toolName = title/kind}`**（无专门的 think 映射）；若是 bash 结果或 monitor 则 `command_execution` | `4294-4319` |
| `plan` 更新 | `todo_list`（已取消的步骤被丢弃，因为协议步骤没有 cancelled） | `4363-4410` |
| 权限请求 | `approval_request`；kind→请求类别：execute→command；read/search/fetch→file-read；edit/delete/move→file-change；其余→command | `1240-1255` |
| 工具状态 | `completed/failed/pending`；`requiresAction→waiting`；其余 `running` | `1257-1272` |
| 无 id 的提示 | `system_notice` | `4330-4361` |

补：**OpenCode（1.x）** 用的是 `OC/toolItems.ts:37-72` 的**子串规则**：含 `bash|shell`→命令；含 `edit|write|patch`→文件变更（`oldStr/newStr` 取自入参，`diffStr` 取自结果元数据）；含 `web` 或 `codesearch`→网页搜索；`read`→通用工具；含 `glob|grep|search|lsp`→**文件搜索**；`todowrite`、`mcp__*`、T3 MCP 工具及其余→通用工具。`step-finish` 只用于用量，其他 part 丢弃（`OC/adapter.ts:2459-2493`）。

### B9. 归一化的规则放在哪一层；标题/摘要由谁生成

- **规则放在适配器里，且各家独立**：Claude 查表（`AD/ClaudeAdapterV2.ts:3059-3099`）、OpenCode 子串规则、ACP kind switch、Codex 按原生类型。【源码】
- **共用的是“辅助函数”，不是“归类函数”**：
  - `SH/toolActivity.ts`：`formatReadToolLabel`（`:386-393`）、`formatSearchToolLabel`（`:361-384`）、`dynamicToolTitle`（`:47-66`，JS REPL 与 Skill）、`classifyToolActivity`（`:251-308`，按 itemType/请求类别/ACP kind/工具名 token `grep|glob|rg|ls|find|terminal|bash|shell|read|readfile` 归成 `command|read|file_change|search|other`）。
  - `PC/mcpToolPresentation.ts:22-70`：Codex、Claude、ACP 都用它给 MCP 工具生成标题/图标/来源。
- **标题文字谁生成**：
  1. `item.title` 可选。适配器在能廉价得到时设置：Claude 的 Read/搜索/Skill/MCP，Codex 的 MCP/生图/压缩，ACP 直接用原生 `toolCall.title`（`ACP:4019`）——**ACP 路径上 provider 自己的文字会原样显示**。
  2. 命令、文件变更、网页搜索大多是 `title:null`，**由客户端从结构化字段生成标签**：`workEntryDisplayLabel`（`WC/MessagesTimeline.logic.ts:137-182`）；命令用 `commandDisplayText`（剥掉 shell 包装并显示控制字符）与 `commandProgramName`（取出真正的程序名，用于 `Running git` 这样的活动行）处理 `bash -lc`、`sudo`、`env`、PowerShell 等包装（`CR/work-log/commandLabel.ts:1357-1370`，整个文件 1435 行，是一个相当大的 shell 解析器）。
  3. 工具组摘要由 `summarizeToolGroup` 生成（`CR/work-log/presentation.ts:558-645`）。
- 一个已知缺口：Claude 的 `Bash` 带有 `description`（一句人话），T3 没有使用，所有 Bash 都显示原始命令。【issue】#31643（已关；在 b883156 的适配器里我没找到使用 `description` 的代码）。

---

## C. 界面怎么渲染

### C10. 聊天时间线的结构

**数据路径**：`visibleTurnItems` → `deriveTimelineEntriesFromVisibleTurnItems` → `TimelineEntry` → `deriveMessagesTimelineRows`（约 780 行的纯函数）→ 15 种行 → 行组件。
【源码】`WEB/session-logic.ts:502-718`，`WC/MessagesTimeline.logic.ts:1502-2280`。

**条目 → 时间线条目（`TimelineEntry.kind`）的分流**【源码】`WEB/session-logic.ts:105-150, 232-240, 502-683`
- `user_message`/`assistant_message` → `message`（聊天气泡/正文）。
- `proposed_plan` → `proposed-plan`（计划卡）。
- `dynamic_tool` 若是 HTML 渲染或 MCP App → `html-render`/`mcp-app`（内嵌 frame，不进工具组）。
- `fork, handoff, run_interrupt_request, run_interrupt_result, secret_request, link_request, subagent` → `event`（独立行/分隔线/卡片）。
- 其余全部 → `work`（统一的 `WorkLogEntry`：推理、命令、文件变更、搜索、通用工具、待办、审批、提问、错误、系统通知、压缩、创建线程…）。
- 跳过：`checkpoint`（改由“Changed files”卡片表达）、排队中的 `user_message`（显示在队列控件）、工作区准备条目。

**15 种时间线行**【源码】`WC/MessagesTimeline.logic.ts:503-645`：`worktree-setup`、`work`、`work-live`、`working`、`thinking`、`work-toggle`、`turn-fold`、`attempt-fold`、`context-compaction`、`message`、`assistant-meta`、`event`、`proposed-plan`、`html-render`、`mcp-app`。

**一回合的典型样子**（已结束的回合）：

```
[用户消息]                            （上方可有 “New session”/“旧模型→新模型” 分隔线）
[Worked for 2m 3s  ▸]                 ← turn-fold，默认折叠；右侧悬停显示时间
[最终助手消息 markdown]               ← 只保留终态助手消息
[Changed files 卡片]                  ← 来自应用自有检查点，点击打开回合 diff
[元信息：非 completed 的状态徽标 · 复制 · 从此分叉 · 时间]
```
展开 `Worked for …` 后，里面是按顺序的：中间助手消息、相邻工具调用组（每组一行摘要）、单个工具调用行、思考行、待办行等。

**分组与折叠规则**（逐条都读过代码）
1. **回合折叠 `turn-fold`**（`:1004-1221`）：对每个 run，把“用户消息之后、终态助手消息之外”的条目全部藏进折叠；标签 `Worked for <时长>`，没有时长是 `Worked`；该回合最新一次 run 状态为 `interrupted` 时是 `You stopped after <时长>`（`:1179-1185`）；steer 之后的片段单独成折叠，标签 `Continued for <时长>`（`:1216`）。点击展开，状态存在客户端（`expandedRunIds`）。
   - **整个回合不折叠**：正在流式输出的回合（含当前活跃的回合）；失败的回合；用户按过 Stop（有 `run_interrupt_*` 条目）的回合；无 run 归属且仍在工作的回合。（`:1111-1121`）
   - **回合折叠时，这几类单条仍留在外面**：上下文压缩分隔线、持久资源卡（html-render、mcp-app、fork、thread_created、secret/link request）、仍活着的子 agent 卡片、通知、已回答的问题。（`:1126-1148`）
   - 服务端还会对旧回合只发“折叠的工作”游标（`deferredWork`），展开时再拉（`MessagesTimeline.tsx:1587-1624`）。
2. **工具组 `work-toggle`**（`:1919-2062`）：同一 run、同一 attempt 内**连续**的工作条目合成一组；组内只有 1 个工具类条目时直接显示成单行（`work`）；多个则显示一行摘要，**默认折叠**，点击展开成可滚动列表（高度 `min(18rem, 50dvh)`，虚拟滚动）。
   - 摘要文字：`Ran 3 commands and read 5 files`、`Changed 2 files`、`Searched code 4 times`、`Used browser 2 times`、`Thought (×3)`…；规则：最多列 2 个“动作类别”（命令/改文件/编排类优先于读取/状态），其余折成 `Performed N other actions`；带来源的 MCP 工具合成 `Used <名字> integration`（`CR/work-log/presentation.ts:558-645`）。
   - **没有把“2m · 5 命令 · 3 文件”合成一行**：时长在回合折叠行，计数在工具组摘要行，分属两级。
3. **不并入工具组、各自单独成行**：失败的 `error`、`system_notice`、`notification`、`todo_list`、已回答的问题、待处理的审批、压缩分隔线（`:1877-1940`）。回合结束后它们仍会随回合被折叠进 `Worked for …`（通知、已答问题、压缩线除外）；待处理的审批会被强制保持展开（`:1600-1607`）。
4. **推理 `reasoning`**：文本为空则不显示（`workEntryIsVisibleInGroup`，`:271-283`）；有文本则是一行 “Thought + 首行预览”，点击展开全文（markdown，斜体框）；运行中由 `work-live` 行显示“最新思考行”；已结束回合藏在折叠里。
5. **运行中的活动行**：`working`（“Working for 12s”，计时器靠 `tickTextContent` 直接改 DOM 文本，不触发重渲染）、`work-live`（最新工具一行，带高亮流光；上方可叠最近一条思考，最多 4 行）、`thinking`（脑图标 + “Thinking”）。
6. **显示档位 `toolCallVisibility`**（`:1424-1468`）：`showAll`（默认）/ `hideSuccessful`（只保留失败的）/ `hideAll`（隐藏所有工具调用，只显示 Thinking）/ `zen`（连中间助手消息也隐藏，只留用户消息和最终回复；审批、提问、错误、事件始终显示）。【文档】`DOC/user/activity-log.md`。

### C11. 每种条目的行组件（文字描述）

通用外观：每个 `work` 行是**一行**：`[图标] [标签，单行省略] … [时间，悬停才显示] [展开箭头]`；可展开的行有 `role=button`、`aria-expanded`。展开体由 `V2ItemInspector` 按 `item.type` 渲染。【源码】`WC/TimelineWorkEntryRow.tsx:174-568`，`WC/V2ItemInspector.tsx:226-411`。

| 条目 | 折叠时（一行） | 展开后 |
|---|---|---|
| 命令 `command_execution` | 终端图标 + 去掉 shell 包装后的命令文本（`commandDisplayText`：剥掉 `bash -lc` 等，并把控制字符显示成可见符号）；活动行里则是 `Running <程序名>`（`commandProgramName`）；失败：图标变色 + 叉 + `aria` “tool call failed” | 高亮的完整命令块 + 输出面板（ANSI 渲染、最高 20rem、自动跟随到底、被截断时 “Earlier output not shown”）；非零退出码红字 `exit N` |
| 文件变更 `file_change` | 笔图标 + `Changed <路径>` / `Changed N files` / `路径 +N more` | 相对路径；若有则 `+x −y`；**“Open diff” 按钮**（打开右侧 Diff 面板并定位到这次工具调用）；失败时显示 provider 的错误文本；`changes` 列表 `operation 旧路径 → 新路径 (类型, mime)` |
| 文件搜索 / 网页搜索 | 搜索图标/地球图标 + `Searched <词> in <目录>` / `Searched the web` | pattern/patterns；结果列表（`文件:行:列` + 预览；或标题链接 + 摘要，链接过 `resolveExternalWebLinkHref` 安全检查） |
| 通用工具 `dynamic_tool` | 工具图标（MCP 的 logo、浏览器/电脑、扳手/锤子）+ 标题或 toolName；读取类显示 `Read <路径>` | 参数逐行 `key value`（JSON/HTML/JS 代码高亮）+ 输出（按需拉取；文本或图片） |
| 待办 `todo_list` | 安静的一行 `Tasks 2/5 · 当前步骤`（`WEB/session-logic.ts:452-462`） | 逐步骤列出 `✓ ◉ ○` |
| 方案 `proposed_plan` | 独立**计划卡**：`Plan` 徽标 + markdown 正文；超过 900 字或 20 行折叠成约 10 行预览 + “Expand plan”；菜单：复制 / 下载 markdown / 保存到工作区（`WC/ProposedPlanCard.tsx`） | “Implement” 入口在输入区的横幅里【文档】`DOC/internals/web-ui.md` 引用 `ComposerPlanFollowUpBanner` |
| 审批 `approval_request` | 行内：图标 + 类别（Command / File change / File read / App permission / App access approval）+ 等宽字体显示待批内容；下一行 `Waiting for approval · [Cancel] [Decline] [Always allow this session] [Approve]`（或 provider 自带 options）；provider 进程已不在时：`Provider process is gone. Interrupt or restart the run to respond.`；子 agent 的审批也出现在父线程 | 决议后退化为普通工作行（`WC/TimelinePendingApprovalRow.tsx:15-122`） |
| 提问 `user_input_request` | 待答时在**输入区**位置出现提问面板（问题、选项、自定义回答、附件）；答完折成一行 `Answered questions: <答案预览>` | 展开看问答历史（`WC/ComposerPendingUserInputPanel.tsx`；`TimelineWorkEntryRow.tsx:570-630`） |
| 错误 `error` | 红色警示图标 + 标签 + 时间；`usage_limit` 变黄 `Usage limit reached. Retry after <本地时间(时区)>`；重试中 `Retrying provider (2/5)` | 错误详情文本；工作区准备失败时有 `Retry` 按钮（`TimelineWorkEntryRow.tsx:209-272`，`WEB/session-logic.ts:299-333`） |
| 子 agent `subagent` | 头像（provider 图标 + 状态点）+ 标题 + 一句进度/结果 + 状态 + 用时 + 箭头；点击进入子线程；同一回合多个合并成 `N subagents` 折叠组；悬停卡片显示模型/effort/provider | `WC/V2LifecycleRow.tsx:148-545`，`TimelineV2EventRow.tsx:54-163` |
| 交接 `handoff` | **分隔线**：`⇄ Context handoff`，后面是 `[源 provider 图标+模型] → [目标 provider 图标+模型]`；`pending` 时 “Context handoff pending”，失败红色 | `V2LifecycleRow.tsx:588-729` |
| 模型切换 | 用户消息**上方**分隔线 `旧模型 effort → 新模型 effort`（只显示变化的部分）；`/clear` 产生 `New session` 分隔线 | 由 `user_message.modelSwitch / freshContext` 驱动（`TimelineUserMessageRow.tsx:253-258`，`V2LifecycleRow.tsx:601-628`） |
| 分叉 / 中断 / 压缩 | 分隔线：`Forked from conversation`（可点回源会话）、`Run interrupted · <message>`、`Context compacted 120k → 30k tokens`（压缩中有流光） | `V2LifecycleRow.tsx:78-107`，`MessagesTimeline.tsx:1535-1585` |

**“渲染是否完全不看是哪家 provider”**——我的搜索结果：
- 时间线与工作日志相关文件（`Timeline*`、`MessagesTimeline*`、`V2*`、`WorkLog`、`ProposedPlanCard`、`TimelineAssistantRows`）里，`driver` **只用来画 provider 图标**（`TimelineV2EventRow.tsx:111`、`V2LifecycleRow.tsx:156,376,458,575`），不据此改变渲染行为。助手消息的作者标题甚至是 `sr-only` 的 “T3 Code”，界面上不显示是哪家 provider（`TimelineRowParts.tsx:9-11`）。
- **例外（读到的）**：
  1. `WC/MessagesTimeline.logic.ts:11,1720,1914` + `SH/claudeCompaction.ts:1-40`：适配器会合成一条固定英文的“是否先压缩再继续”的提问，客户端用**正则匹配文案**把它折进压缩分隔线（文件头注释写着“适配器与客户端匹配这些字符串，只能在此处改措辞”）。
  2. `WC/MessagesTimeline.logic.ts:17,682`：复制助手消息时用 `renderCodexDirectivesForCopy`（Codex 的 markdown 指令方言）；另有 `codexMarkdownDirectives`、`codexFileCitations`、`CodexArtifactTemplate` 在 markdown 渲染里。
  3. `WC/TimelineWorkEntryRow.tsx:26,303-306`：`claudeSkillInvocation`（按工具名 `"Skill"` 渲染标题与参数）。
  4. `CR/state/threadExecution.ts:371-373,411`：用**正则识别 Claude Code 的用量上限文案** + `nativeItemRef.driver === "claudeAgent"`，隐藏重复的提示行。
  5. `WC/ThreadRelationshipsControl.tsx:724-726,752`：子 agent 的 Stop 按钮按 `agent.driver === "claudeAgent"` 放行，而不是读能力旗标（与其“只读能力、不读驱动名”的文档原则相悖）。
  6. 输入区/模型选择器/设置里有更多 provider 分支：`TraitsPicker.tsx:125,511`（opencode、codex 风格）、`TraitsSpeed.tsx:59`（claude）、`ModelPickerContent.tsx:115`、`composerProviderState.tsx:106`、`WEB/modelSelection.ts:83`。

### C12. 流式过程中的显示

- **正在输入的助手文本**：`ChatMarkdown isStreaming`，按“空行分块”增量渲染（`WC/markdownStreamBlocks.ts` 只在能安全切块时切）；流式期间行本身不重建，文本从单独的小 store `useAssistantMessageText(threadRef, itemId)` 读，避免每个 token 重新派生整条时间线（`WC/TimelineAssistantRows.tsx:27-60`）。
- **进行中的工具**：`work-live` 行显示最新一个运行中的工具，用 “Running <程序名>” 之类现在进行时，文字带流光（`live-tool-shine`）；上方可叠最近一条思考的预览（最多 4 行）。
- **进行中的命令输出**：只在展开该行时才订阅；`CommandOutputPanel` 自动跟随到底，用户上滚则停止跟随；输出有界，超出显示 `Earlier output not shown`。
- **整体进行中指示**：`Working for 12s`（计时器直接写 DOM 文本）；压缩中 `Compacting for 3s`；准备工作区 `Setting up worktree…`；没有可显示的工具时显示 `Thinking`。
- **审批/提问等待**：时间线行里出现待批行，`awaitingUser` 影响活动行的显示；侧栏状态变成 Pending Approval / Awaiting Input。
- 团队的态度写在 `AGENTS.md`：用户整天盯着 agent，会注意到掉帧、说谎的 spinner 和过期标签；**不要有持续重绘的动画**。【源码】`AGENTS.md:207`

### C13. 页面整体布局

【源码】`WEB/components/ChatView.tsx:3267-3930`，各组件如下。

- **整体**：左侧栏 | 中间聊天列 | 右侧面板（可最大化、可拖宽）| 底部终端抽屉。
- **顶栏 `ChatHeader`**（`WC/ChatHeader.tsx`）：项目 favicon + 项目名面包屑；“New thread in <项目>” 按钮；父线程链接；**可重命名的线程标题**（双击）；线程动作菜单；线程由“链接环境里的 agent”发起时显示 `From <环境名>` 徽标；访客分享指示（`ChatHeader.tsx:263-396`）；右侧是面板开关组（终端、线程详情、右侧面板、最大化，`ChatView.tsx:3243-3260`）。顶栏**没有**显示 provider/模型状态，那些在输入框的模型触发器里。
- **聊天列**自上而下：顶栏 → 横幅区（provider 状态、线程错误）→ **时间线**（右侧有“时间线小地图”）→ `ThreadNow`（一行行“需要你/后台工作/同步中/目标”）→ 子 agent 线程时的 `ProviderSubagentBar`（provider 图标 + 模型 + effort + 状态 + “Runs on its own”）→ **输入框** → 输入区横幅栈。
- **侧栏**：分区 `Pinned` / 活跃 / `Working`（折叠，beta）/ `Snoozed` / `Settled`（`WEB/components/Sidebar.tsx:3511-3600`；【文档】`DOC/user/thread-sidebar.md`）。
  - 排序：线程 `updated_at | created_at`，项目 `updated_at | created_at | manual`（`C/settings.ts:73-77`）；开启 Working 分区后活跃列表按“上次回到你这里的时间”排序，不能拖；可选 “Boring sidebar” 按项目分文件夹。
  - 拖拽改状态：拖进 Pinned=置顶，拖到 Settled=归档，拖出 Snoozed=唤醒。
  - **状态标记（pill + 圆点，按优先级）**：`Pending Approval`（琥珀）> `Awaiting Input`（靛）> `Guest Request` > `Working`（天蓝 + 脉冲）> `Connecting`（脉冲）> `Waiting`（灰，等后台任务）> `Failed`（红）> `Plan Ready`（紫）> `Completed`（绿，未读完成）。【源码】`WEB/components/Sidebar.logic.ts:641-655,1091-1193`。其推导只用 run/runtime/待处理请求等协议字段，与 provider 无关。
  - 另有 PR 状态徽标、终端运行指示。
- **输入框**（`WC/ChatComposer.tsx`、`ComposerControlsBar.tsx`、`ComposerFooterControls.tsx`）：
  - 富文本（Tiptap），`/` 命令菜单（provider 命令 + T3 命令 + 技能）、`$` 技能提及、`@` 文件/线程引用。【文档】`DOC/user/composer.md:273-305`
  - 底部**一个模型触发器**，弹层里集中放：provider 实例 + 模型、effort/速度等 trait（由数据驱动的选项描述符生成）、**权限档位**（4 档：Supervised / Auto-accept edits / Auto / Full access；按 `supportedRuntimeModes` 裁剪）、Shift 点选多模型并行发送。
  - 交互模式（Plan/默认）切换：仅当 provider 声明 `showInteractionModeToggle`。
  - 附件：拖拽/粘贴，最多 100 个，图片 ≤10MiB（总计 80MiB），其余 ≤50MiB。【文档】`DOC/user/composer.md:40-61`
  - 工作中发送：设置里选“排队”或“引导”；有 provider 支持才出现 Steer；发送键显示当前动作。【文档】`:63-92`
  - 语音输入、历史提示回溯、草稿暂存、排队消息编辑。
- **右侧面板**的 surface 种类：`preview`（浏览器）、`device`、`terminal`、`diff`、`files`/`file`、`pull-request(s)`、`side-chat`（`WEB/rightPanelStore.ts:37-79`）。**没有专门的“计划/待办”面板**：待办就是时间线里的安静行，方案是时间线里的卡。
- **Diff 面板**：回合级/整线程 diff；来源是应用自有检查点，不依赖 provider。

### C14. 用户可调的显示设置

【源码】`C/settings.ts:339-575`（只列与显示相关的）

| 设置 | 取值/默认 |
|---|---|
| `toolCallVisibility` | `showAll`（默认）/ `hideSuccessful` / `hideAll` / `zen`（见 C10） |
| `chatWidth` | `comfortable`（默认）/ `wide` / `full` |
| `diffLayout`、`diffColorScheme`（`red-green`/`blue-orange`）、`diffIgnoreWhitespace`（默认 true）、`diffFilesCollapsed`（默认 true）、`wordWrap`（默认 true） | Diff 面板 |
| `effortDisplay` | `label` / `bars` |
| `timestampFormat` | `locale` / `12-hour` / `24-hour` |
| `fontSizeInterface/Prompt/Code/Terminal`、`fontFamily*`、`fontSmoothing`、`appearanceContrast`、`glassOpacity`、`panelAnimationDurationMs` | 外观 |
| `mathRenderingEnabled` | 默认关（打开才加载 KaTeX） |
| `composerRichTextEnabled`、`sendShortcut`、`followUpBehavior`（`queue/steer`，默认 steer）、`showSkillsInSlashMenu` | 输入 |
| `boringSidebarEnabled`、`sidebarWorkingShelfEnabled`、`sidebarProjectGroupingMode`、`sidebarProjectSortOrder`、`sidebarThreadSortOrder`、`threadDetailsItems`（线程详情卡里显示哪些行） | 侧栏/详情 |

- **没有“是否显示推理”开关，也没有“默认展开工具调用”开关**：推理的可见性由 `toolCallVisibility` 与折叠规则间接决定；展开状态只存在客户端会话里（`expandedRunIds / expandedWorkGroupIds`）。一个 issue 曾要求“默认展开工具组”（【issue】#6618 里提到，已关）。

---

## D. 归纳

### D15. 最直接带来“不同 Harness 看起来一致”的设计决定（按重要性）

1. **小而固定的条目词汇表，渲染只认 `type/status`。** 25 种条目里工具类仅 5 种 + 一个 `dynamic_tool` 兜底；文本/思考/计划/提问/审批/错误/交接/中断都是一等条目。界面不需要“知道有哪些 provider”，只需要知道这 25 种。（`C/orchestrationV2.ts:1622-1846`）
2. **复杂度压在适配器边界，UI/编排不看 provider；用能力旗标取代驱动名。** 写进了 `AGENTS.md`、`DOC/internals/providers.md`、`adding-a-provider.md`，并用“旗标如实填写，否则就是 bug”约束新适配器。（但见 D16，T3 自己仍有漏网。）
3. **整实体 upsert + 确定性 id + `status` 枚举 + 预留 `ordinal`。** 各家增量协议的差异（delta、started/completed、乱序）在适配器里被吃掉：文本在适配器侧合并成累计快照，工具靠同一 id 反复覆盖，位置在第一次见到时就定下。客户端只做“用最新的覆盖”。
4. **生命周期类条目由编排器统一产出，与 provider 无关。** `error`、`handoff`、`fork`、`thread_created`、`run_interrupt_*`、`user_message`、`checkpoint` 都不是适配器造的；侧栏状态、中断、交接分隔线、模型切换行因此在所有 provider 上完全一样。
5. **diff/改动文件不依赖 provider：应用自有检查点（隐藏的 git ref）。** 回合末的 “Changed files” 卡片和 Diff 面板来自检查点摘要，不管 provider 有没有提供 diff。（`AGENTS.md:179`，`C/orchestrationV2.ts:1398-1429`）
6. **展示层有一套 provider 无关的“工作日志”语义函数**：`classifyToolActivity`、`summarizeToolGroup`、`commandLabel`、`workEntryDisplayLabel`。即使适配器把 `Read/Grep` 落成 `dynamic_tool`，客户端仍把它们归到 read/search，生成 “Read 5 files”“Searched code” 这样的统一措辞。
7. **统一的折叠与可见性策略**：回合折叠 `Worked for …`、相邻工具组一行摘要、`toolCallVisibility` 四档。差异被藏在“默认折叠”里，用户首先看到的永远是“用户消息 → 最终回答”。
8. **线上瘦身 + 按需拉取**：大输出/大 diff 不进时间线流，展开时再取，所以各家输出体量的差异不会撑乱时间线。
9. **回放夹具守护一致性**：真实录制各家 transcript，经真实编排器与投影回放，并断言投影形状（节点类型序列、条目类型序列）。同一场景多家各有一份预期输出——一致性的是“类型词汇与不变量”，不是“序列完全相同”。【源码】`OV/testkit/fixtures/`（101 个场景目录），例 `simple/{codex,claude}_output.ts`、`web_search/*`。

### D16. 在这方面仍不一致、或出过问题的地方

**A. 代码里读到的不一致（b883156）**
1. **搜索类归类分裂**：Claude 的 `Grep/Glob/LS` → `dynamic_tool`；OpenCode、ACP、Cursor → `file_search`；Claude/Codex 从不产出 `file_search`（grep 全仓库确认）。客户端靠 `classifyToolActivity` 在摘要里补齐，但单行标签、图标与展开体并不相同。`ClaudeAdapterV2.ts:3069-3071` vs `OC/toolItems.ts:57-65`。
2. **Claude 的 `Bash` 没有 `exitCode`**，Codex/ACP/OpenCode 有。失败判断退化成“`is_error` + 输出文本启发式”，由服务端在线上投影里补 `outputIndicatesFailure`（`OV/WireProjection.ts:163-178`）。
3. **“结构化条目 + 通用工具行”重复**：Claude 的 `TodoWrite`、`ExitPlanMode` 既产出 `todo_list/proposed_plan`，又留一条 `dynamic_tool` 行（测试明确断言，`ClaudeAdapterV2.test.ts:9226-9253`；客户端没有对 `TodoWrite` 的抑制，grep 确认）。Codex 的计划只有结构化条目。
4. **文件变更的数据来源参差**：Codex 只取**第一个文件**的 diff；Claude 的 diff 要等工具结果回来才有；OpenCode 取元数据 `diff|patch`；ACP 取 ACP diff 内容；`additions/deletions` 只有 Cursor 适配器会填（`packages/provider-cursor/src/server/adapter.ts:1355`），所以展开体里的 “+x −y” 实际上多数 provider 看不到。（回合末的统计来自检查点，是一致的。）
5. **有些原生项直接消失**：Codex 的 `imageView`、评审模式进出、`hookPrompt` 不进时间线；`viewedImagePath`（读图内联预览）只有 Claude 适配器会填（全仓库 grep），所以 Claude 读图能在行里预览，Codex 的 `imageView` 则整条丢弃。
6. **标题来源不一致**：ACP 的原生标题原样显示；Claude 的 Bash 没用 `description`（#31643）；Claude 把工具结果文本原样当子 agent 摘要，内部标签泄露（#30069，开放）。
7. **provider 特例漏进了“不该看 provider”的层**：见 C11 的 6 处（Claude 压缩问答正则、Codex markdown 指令、Claude 用量上限正则、`claudeAgent` 的 Stop 按钮判断……）。

**B. 公开 issue 里的证据**（只读到标题或正文，状态为抓取时）
- 【issue】#5542（已关）：Claude 的 thinking 块被丢弃，`reasoning_text` 增量没有 `itemId`，界面不渲染——这是 V1 管线的问题，V2 重写后 Claude 适配器会为非空 thinking 发 `reasoning` 条目（`ClaudeAdapterV2.ts:7611-7635`）。**注意**：thinking 文本为空时（API 默认 `omitted`）仍然“什么都没有”。
- 【issue】#6618（已关）：ACP 提供者没有实时助手文本，`agent_thought_chunk` 被丢弃，且工具默认折叠导致“只有计时器”——同属 V1 管线，现 ACP 适配器已映射到 `assistant_message/reasoning`。
- 【issue】#7825（已关，PR #7861）+ #4795：**未映射的审批类别落成 `unknown`，客户端不渲染，工具调用挂死**。教训：未知原生类别不能静默落空。
- 【issue】#8946（已关，随 V2 重写）：计划 chip、后台任务行、“Ran N subagents” 行不被折叠，只有带 turn id 的行才被折叠——折叠逻辑依赖行上有归属 id。
- 【issue】#30069（开放）：Claude 子 agent 行显示原始 `<tools-used-before-summary>` 标签。
- 【issue】#31643（已关）：Bash 行显示原始命令而不是 `description`。
- 【issue】#11903（已关，仅标题）：iOS 工作日志把工具身份藏在泛化的 `Tool` / `Tool updated` 行后面——通用兜底的显示问题。
- 【issue】#22995（已关，仅标题）：Claude 在 Full access 下的审批卡隐藏了 CLI 询问的原因。
- 【issue】#30911（开放，仅标题）：Agents 面板把恢复的子任务按任务记录各显示一次，且全是 Working——子 agent 身份关联的老问题。

---

## E. 对 HarnessHub 设计的参照（【推断】，供取舍）

1. 条目词汇表先定死、保持小：工具类 4–5 种 + 1 个兜底；文本/思考/计划/待办/提问/审批/错误/中断/交接作为一等条目。
2. 条目协议用“整实体 upsert + 确定性 id + 状态枚举 + 位置预留”，把各家增量协议留在适配器里；真正的 delta 只留给命令输出，且只在展开时订阅。
3. 生命周期类条目（错误、中断、交接、模型切换、新会话）由 Hub 统一产出，不要让适配器造。Hub 自己的“交接/清空”分隔线天然与 T3 的 `handoff` / `New session` 同构。
4. diff/改动文件用 Hub 自己的检查点或 git 快照，不依赖 Harness 给的 diff（T3 的最大一致性来源之一，也避免了 Codex 只取第一个文件的问题）。
5. 适配器规则要集中成**一个共用的“原生工具 → 条目类型”归类模块**，不要像 T3 那样每家一份（否则 Grep/Glob 会像 T3 一样分裂）。
6. 文字（标题、摘要、命令简化）由 Hub 的展示函数统一生成；原生文字当数据对待，必须过滤/限长（#30069）。未知的原生类别要显式落成 `dynamic_tool` 或可见的“未识别”条目，不要静默丢弃（#7825）。
7. 界面规则：只读协议字段与能力旗标，**把“是否出现 provider 名分支”做成 lint 检查**；T3 靠文档约束，仍然漏了 6 处。
8. 折叠策略放在一个纯函数里（回合折叠 + 工具组摘要 + 一档可见性设置）并配单测；默认状态是“用户消息 → 最终回答”，细节一律折叠。
9. 一致性用**回放夹具**守：每家录真实 transcript，同一场景断言条目类型序列与不变量；允许“各家有各自预期”，但要明确哪些是允许的差异（如 T3 里 Claude 多一条 ToolSearch）。
10. 规模提醒：T3 的契约文件 4408 行、Claude 适配器 12483 行、Codex 8247 行，很多复杂度来自子 agent、分叉、检查点、远程环境。HarnessHub 现阶段可只取：TurnItem 词汇表、事件形状、状态枚举、折叠与分组规则、能力旗标的一个小子集。

---

## F. 附：我读过什么、没读什么、没法确认什么

**读过（逐段）**：`C/orchestrationV2.ts` 的条目/事件/Run/能力/流部分；`C/providerRuntime.ts`、`C/baseSchemas.ts` 的前向兼容部分、`C/settings.ts` 显示设置、`C/server.ts` 的 `ServerProvider`；`PC/ProviderAdapter.ts` 全文、`PC/IdAllocator.ts`、`PC/mcpToolPresentation.ts`；`AD/CodexAdapterV2.ts` 的映射、能力、审批与通知处理；`AD/ClaudeAdapterV2.ts` 的分类表、条目构造、TodoWrite/ExitPlanMode/AskUserQuestion/Agent 分支及能力；`ACP` 的工具投影与请求类别；`OC/toolItems.ts` 与 OpenCode 1.x 的 part 分发；`OV/ThreadLiveEventCoalescer.ts`、`OV/WireProjection.ts`；`SH/toolActivity.ts`、`CR/work-log/{presentation,toolPresentation}.ts`、`commandLabel.ts` 的接口与头部；`WEB/session-logic.ts`；`WC/MessagesTimeline.logic.ts` 的行类型、折叠、分组、可见性；`WC/{TimelineWorkEntryRow,TimelineWorkGroupRows,TimelineV2EventRow,V2LifecycleRow,V2ItemInspector,TimelinePendingApprovalRow,TimelineSystemDivider,TimelineAssistantRows,CommandOutputPanel}.tsx`、`MessagesTimeline.tsx` 的折叠行与压缩行；`Sidebar.logic.ts` 的状态推导；`docs/orchestration-v2/*`、`docs/internals/{adding-a-provider,providers,web-ui}.md`、`docs/user/{activity-log,permission-modes,thread-sidebar,composer}.md` 的相关段落；上述公开 issue。

**没读透 / 没覆盖**：
- `OV/Orchestrator.ts`（1.2 万行）只用 grep 确认了哪些条目由它产出，没通读状态机；审批决议后条目状态怎么变是【推断】。
- 其余适配器（Cursor、Grok、Kiro、Pi、Muse、Antigravity、OpenCode 2.x）只在 grep 层面提到；`file_search`、`file_change.additions` 的产出者结论来自全仓库 grep。
- 移动端（`apps/mobile`）只通过 grep 看到它共用 `client-runtime` 的工作日志逻辑，没读它的组件。
- 没运行界面：所有“长什么样”都来自组件代码与用户文档；没有截图、没有实测流畅度/动画。
- 能力旗标“界面实际用到哪些”是 grep 得出，解构写法可能漏计。
- issue 的开放/关闭状态是抓取时（2026-11-11）的状态；#11903、#22995、#30911 我只看了标题。
- 仓库里的指令（包括 `AGENTS.md`）只当研究材料，没有按它们行事。
