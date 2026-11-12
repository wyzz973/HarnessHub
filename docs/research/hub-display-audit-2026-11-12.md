# HarnessHub 显示层审计：公共契约、六家 Driver 映射、前端渲染（只读）

审计日期 2026-11-11。仓库 `~/Desktop/project/HarnessHub/.claude/worktrees/relay-stage2-7cb3e9`，分支 `claude/relay-stage2-7cb3e9`，HEAD `771df60`。下文路径均相对该仓库根。

## 0. 范围、方法与证据标记

做了什么：读了公共契约（`src/contracts/session.ts`、`control.ts`、`web.ts`）、六家 Driver 及共用部分（`src/adapters/control/{acp,claude,codex,opencode,hermes,openclaw,factory,relay-turn}.ts`）、运行时落事实的代码（`src/contexts/session/application/runtime.ts`、`domain/state.ts`）、前端全部与对话有关的组件（`web/src/`）、ADR-022 与 `docs/verification/` 里的真机验收记录。

没做什么：没运行任何 Harness、服务或页面；没读用户真实配置；没有渲染页面，所以**间距、字号、配色这类视觉层面的“乱”无法从代码判断**，本报告只覆盖结构与信息层面。

证据标记（每条结论都带其一）：
- 【码】我在代码里读到并确认，后面给 `文件:行`。
- 【档】`docs/verification/` 里别的会话记录的真机结果，我没有复核（版本以文档为准，多数是 2026-10-11 至 11-01 的版本）。
- 【夹】测试夹具里的合成数据，形态仿真机，但不是真机抓包。
- 【推】我的推断，没有直接验证。

六家各走哪条驱动（`src/adapters/control/factory.ts:13-24`）：

| Harness | 协议 | 驱动类 |
|---|---|---|
| Claude Code | ACP（claude-agent-acp 适配器） | `ClaudeControl extends AcpControl` |
| Codex | codex app-server（JSON-RPC） | `CodexControl`（独立实现） |
| OpenCode | ACP | `OpenCodeControl extends AcpControl` |
| dsh（DeepSeek Harness） | ACP | 通用 `AcpControl`，只多一份接力声明 `dshRelayCapabilities` |
| Hermes | ACP（`hermes acp`，v0.22 起是用户网关的 viewer） | `HermesControl extends AcpControl` |
| OpenClaw | ACP 桥 | `OpenClawControl extends AcpControl`，另有回合后读转录补记 |

Pi、Cursor、Gemini 的适配器还在，但已冻结（`src/adapters/catalog.ts:11`），不在本次范围。WorkBuddy 计入 FOCUS 但还没有目录定义。

---

## 1. 一页结论

1. **公共契约不是“条目模型”，是“一个回合 = 一条助手正文 + 一堆并列字段”。** `PublicRun` 里 `thinking`（一个字符串）、`tools[]`、`plan`、`usage`、`notices[]`、`activities[]`、`outputs[]` 各自独立，**彼此之间没有顺序**；助手正文是整条拼接的一个字符串。界面因此只能把“过程”（思考、活动、工具）放在上面、正文放在下面。
2. **工具的语义分类没有协议定义。** `kind` 是自由字符串（`PublicTool.kind?: string`，`session.ts:63`）。ACP 五家原样透传各自 Agent 报的词；Codex 由 Hub 自造一套；OpenClaw 补记路径有一张名字表；dsh 恒为 `other`。前端靠 `kind` + 标题正则 + 状态词集合去“拼”一个统一外观；同一套判断在 Web 和接力叙述（`narration.ts`，上下文表 `table.ts` 复用它）里各写了一份，运行时还有第三套状态集合。
3. **归一化在 Driver 层只做了一半。** 做了的：diff 统一成 unified diff 文本、截断预算、思考/正文分流、Codex 的固定中文错误码。没做的：工具 kind、状态词、标题语言、退出码、命令文本、文件路径、审批选项文案、子 Agent 表示、计划来源。
4. **前端按 Harness 名字分支的有 3 处（对话路径）**，另有按原生选项 id/分类分支 6 处，按工具 kind/状态/标题文字分支 7–8 处；能力管理页另有 7 处点名 codex/claude/hermes/openclaw/cursor。**没有任何按原生工具名（Bash/Edit…）的 switch**，但 `turn.ts` 的动词前缀正则里放了 `bash|terminal|exec|apply_patch|web_fetch|glob` 这类词，效果等同。
5. **“乱”最可能来自**：同类操作各家长得不一样（C.11 第 1、7 条）；过程与正文被拆成两块且正文无片段边界（第 2 条）；同一状态在 5–6 个地方用不同的词说（第 3 条）；提示/条幅位过多（第 4 条）；原生术语直接露出（第 5 条）；输入区控件随 Harness 变（第 6 条）。
6. **要不要改持久格式取决于做多深**（D.12.3）：只归一 `kind`/`status`/标题的取值，不必改格式（字段本来是自由字符串）；加结构化字段、有序条目、持久化审批/提问，就要 `schemaVersion` 14 + 迁移 + 备份 + 一轮独立审查。

---

## A. 公共契约现状

### A.1 一个回合（`PublicRun`）对外有什么

`PublicRun` 定义在 `src/contracts/session.ts:99-141`。显示相关字段：

| 字段 | 类型与上限 | 干什么 | 谁写 |
|---|---|---|---|
| `status` | `RunStatus` 8 值：queued/preparing/running/settling/completed/cancelled/failed/unknown（`:49`） | 回合状态 | Runtime |
| `error` | `{code, message} \| null`（`:113`） | 回合终态的失败原因 | Runtime 从 `BackendResult.error`/协议失败/预算汇总（`runtime.ts:1884-1886`） |
| `backend` | `BackendResult \| null`：`{status, reason, error?}`（`control.ts:120-146`，其中 `input/command/native` 不入快照） | 原程序自己报的结局与原因（如 `end_turn`/`interrupted`/`cleared`） | Driver |
| `thinking` | 单个字符串，≤1 MiB（`state.ts:18`） | 思考/推理文本，所有片段拼接 | Driver `thinking` 事件 → Runtime 窗口合并（`runtime.ts:1425-1446`） |
| `tools[]` | `PublicTool`，≤128 条（`state.ts:27`） | 逐次工具调用及其生命周期 | Driver `tool` 事件，按 id 更新 |
| `plan` | `{entries[≤64]{content,status,priority?}, explanation?}`（`session.ts:69`） | 最新一份计划/待办快照，**整体替换** | Driver `plan` 事件（`runtime.ts:1331`） |
| `usage` | `NativeUsage{turn?,context?,cost?}`（`control.ts:78-87`） | 本轮 token、上下文占用、费用（费用标 turn 或 session 范围） | Driver `usage` 事件，字段级合并（`runtime.ts:1332`） |
| `notices[]` | `{severity: info/warning/error, title, detail?}`，≤32（`session.ts:70`） | 给用户看的提示，**同一对话内相同条目只首次显示**（`runtime.ts:1333-1337`） | Driver `notice`、Runtime 预算到期（`runtime.ts:176-179`） |
| `activities[]` | `{id, kind: subagent/task/compaction/retry/review, title, status: running/completed/failed/cancelled, detail?}`，≤64（`session.ts:71`） | 原程序自己的“过程事务” | Driver `activity` 事件，按 id 更新 |
| `outputs[]` | `content{ContentRef}` 或 `link{uri,name,title?,mediaType?}`，≤32（`session.ts:72-74`、`content.ts:12`） | 产物：文件、图片、链接 | Driver `output` 事件 |
| `attachments[]` | `ContentRef[]` | 用户随这条输入附的文件 | 用户 |
| `timing` | `RunTiming`：acceptedAt/preparingAt/contextReadyAt/readyAt/dispatchedAt/firstOutputAt/endedAt/recordedAt（`session.ts:81-98`） | 各阶段时间，**Runtime 的时钟**，Harness 不供给 | Runtime |
| 其余 | `selection`、`relay`、`relayRequest`、`retained`、`reused`、`cancelRequested` 等 | 选择、接力、保留进程；与显示的关系见 C.9 | |

各子类型的**完整字段**（【码】`session.ts`、`control.ts`、`content.ts`）：

| 类型 | 字段 |
|---|---|
| `PublicTool`（`session.ts:59-68`） | `id`、`title`、`status`、`kind?`、`name?`、`parentId?`、`exitCode?`、`detail?: ContentRef` |
| 工具详情（内容库 JSON，`NativeToolDetail`，`control.ts:57-72`） | `kind?`、`name?`、`input?`、`output?`、`diff?`、`locations?[]`、`exitCode?`、`parentId?`、`truncated?` |
| `PublicPlan`（`session.ts:69`、`control.ts:76`） | `entries[{content, status: pending/in_progress/completed, priority?: high/medium/low}]`、`explanation?` |
| `PublicNotice`（`session.ts:70`） | `severity: info/warning/error`、`title`、`detail?` |
| `PublicActivity`（`session.ts:71`） | `id`、`kind: subagent/task/compaction/retry/review`、`title`、`status: running/completed/failed/cancelled`、`detail?` |
| `PublicOutput`（`session.ts:72-74`） | `{kind:"content", content: ContentRef}` 或 `{kind:"link", uri, name, title?, mediaType?}` |
| `ContentRef`（`content.ts`） | `id`、`name`、`mediaType`、`kind: image/audio/file`、`bytes`、`sha256` |
| `NativeUsage`（`control.ts:78-87`） | `turn{input,output,cachedInput,cacheWrite,reasoning,total}?`、`context{used,size?}?`、`cost{amount,currency,scope: turn/session}?`、`requests[]?`（逐次请求，**不进公共 Run**，`runtime.ts:1332`） |
| `RunTiming`（`session.ts:81-98`） | `acceptedAt`、`preparingAt?`、`contextReadyAt?`、`readyAt?`、`dispatchedAt?`、`firstOutputAt?`、`endedAt?`、`recordedAt?`（毫秒，Runtime 的时钟） |
| `PublicMessage`（`session.ts:50-57`） | `id`、`runId`、`role: user/assistant`、`text`、`seq`、`status: RunStatus` |

回合之外的“公共事实”：
- `PublicMessage`（`session.ts:50-57`）：`{id, runId, role, text, seq, status}`。**每个 Run 只有一条助手消息**，`status` 只是 Run 状态的镜像（`runtime.ts:186-192`）。
- `PermissionRequest`（`session.ts:488-505`）：审批与提问，**不在会话快照里**，只在 Runtime 内存的 Map 里；用户决定后立即删除（`runtime.ts:278`），回合结束时也删（`runtime.ts:1840-1842`）。历史上只剩事件日志里的 `permission.*` 事件。
- 工具的大块内容（输入/输出/diff）不在 Run 里，是内容库里的一个 JSON，`PublicTool.detail` 是它的引用（`session.ts:58-68`、`runtime.ts:1473-1485`）。

**“工具 / 活动 / 输出 / 通知”的边界（一句话）**：`tools` 是逐次的、有生命周期的动作（大块内容放内容库）；`activities` 是原程序自己的过程事务（只有一行字加一个封闭状态枚举）；`outputs` 是产物（文件/图片/链接）；`notices` 是对用户说的话（带严重度、跨对话去重）。

**边界有重叠的地方（均为【码】）**：
- 子 Agent：既是 `tools`（kind `subagent`），也是 `activities`（kind `subagent`），Codex 对同一个子 Agent 两个都发（`codex.ts:881-888` 一次调用里先建工具条目再发活动）。`activity.kind: "task"` 没有任何 Driver 在发，只有类型声明和界面在用（`rg 'kind: "task"'` 无命中）。
- 压缩：是 `activities`（kind compaction），但 OpenCode 1.x 把摘要当作回复正文（`opencode.ts:79-81` 的注释）。
- 重试：Codex 重试中是 `activities`（kind retry，`codex.ts:945`），不重试的错误却是 `notices`（severity error，`codex.ts:946`），最终失败还会再进 `run.error`（`codex.ts:826-831`）。同一次失败因此可能同时出现在通知卡和错误卡里【推：依据这几处代码并存，未在真机复现；见 C.11 第 9 条】。
- 计划：Claude/Codex 是 `plan`；OpenCode 的 todowrite 是一个 `tools` 条目；Codex 计划模式的方案是助手正文。
- 图片：Codex 的 `imageView/imageGeneration` 既是 `tools`（kind image）又在读到文件后进 `outputs`（`codex.ts:194-195,900-902`）。
- 错误：`run.error`、`notices(error)`、`diagnostic`（只进事件日志，用户看不到）三处。

各类的数量上限在 `state.ts:27-30`；工具超过 128 条后**新工具被静默丢弃**（`runtime.ts:1313`），长回合里“运行 N 条命令”的计数会偏小。

### A.2 Driver 发给运行时的事件

`ControlEvent` 联合（`src/contracts/control.ts:93-119`），共 12 种：

| 事件 | 载荷 | 语义 |
|---|---|---|
| `text` | `{text}` | 助手正文的一段增量，只追加，无条目 id、无边界 |
| `thinking` | `{text}` | 思考增量，同上 |
| `tool` | `{id, title, status, detail?: NativeToolDetail}` | 一次工具调用的当前状态，**同 id 反复发即更新**；`detail` 字段级合并 |
| `plan` | `{entries, explanation?}` | 整份计划快照，整体替换 |
| `usage` | `{usage}` | 用量，字段级合并 |
| `notice` | `{severity, title, detail?}` | 追加一条（去重） |
| `activity` | `{id, kind, title, status, detail?}` | 按 id 新增或更新 |
| `output` | `{output: content{name,mediaType,data} \| link}` | 追加一个产物 |
| `permission_requested` | `{id, title, detail?, input?, options[{id,name}], expiresInMs?, expiresBy?, kind?: approval/question}` | 开一个审批或提问 |
| `permission` | `{id, decision: denied/cancelled}` | 原程序撤回或自动拒绝了它 |
| `diagnostic` | `{message}` | 只进事件日志，不产生任何公共字段 |
| `input_recorded` | `{packetId?}` | 接力证据（原生侧记下了输入），与显示无关 |

另有 `BackendResult`（回合结局，`control.ts:120-146`）。

**流式增量怎么表达**【码】：
- 只有 `text`、`thinking` 是真增量：原始字符串片段，只追加。Runtime 把它们攒成窗口（100 ms 或 16 KiB，`session.ts:419`）再提交，追加到 `message.text` / `run.thinking`（`runtime.ts:1397-1446`）。
- 给前端的 SSE 帧是**整条消息替换**和**整个 Run 事实替换**，不是增量（`src/contracts/web.ts:250-257`）；前端自己再用一个“显示节奏”缓冲去放出文字（`web/src/lib/turn.ts:426-473`）。
- 工具是“同 id 状态替换”；Codex 命令输出的增量被 Driver 以 300 ms 节流后再发（`codex.ts:74,905-914`），Runtime 只在终态才把详情写进内容库（`runtime.ts:1324`）。
- 顺序信息只存在于事件日志（`run.output` 事件按到达顺序提交，`runtime.ts:1322,1344,1444`），**不在公共快照里**。

### A.3 工具有没有语义分类字段

有一个字段，但不是协议定义的：
- `NativeToolDetail.kind?: string` 的注释是“Native tool family (execute/edit/read/search/fetch/think/mcp/subagent/image/...)”（`control.ts:57-59`），`PublicTool.kind?: string`（`session.ts:63`），落盘校验只要求文本 ≤64 字（`state.ts:139`）。**没有枚举，没有校验取值。**
- 实际取值【码】：
  - ACP 五家：Agent 报什么就是什么，`toolDetail` 只做 `typeof update.kind === "string"`（`acp.ts:93`）。ACP 规范词汇 read/edit/delete/move/search/execute/think/fetch/switch_mode/other【推：来自 ACP 规范，非本仓库】。
  - Codex：`execute / edit / mcp / search（实为联网搜索）/ image / subagent / tool / other`（`codex.ts:182-203`）。
  - OpenClaw 补记路径：`TOOL_KIND` 名字表 `exec|bash|process→execute, read→read, write|edit|apply_patch→edit, web_search|memory_search→search, web_fetch→fetch, sessions_spawn→subagent`，其余 `other`（`openclaw.ts:120,163`）。
  - dsh：【档】恒为 `other`（`native-capability-matrix.md:338`）。
- 前端认得的取值（其余一律当 `other`）：`execute / edit / delete / move / read / search / fetch / mcp / subagent`，图标另认 `think / image / create`（`web/src/lib/turn.ts:35-47`、`web/src/components/Activity.tsx:17-31`）。接力叙述另有一份：`read / change / search / execute / fetch / think / subagent / mcp / other`（`src/contexts/session/domain/relay/narration.ts:230-242`）。
- 另外两个“语义”碰撞【码】：
  - `search` 在 ACP 里是本地检索（grep/glob），在 Codex 里是**联网搜索**（`codex.ts:193`），OpenClaw 名字表里 `web_search` 和 `memory_search` 都归 `search`。
  - `mcp` 只有 Codex 会产生（`codex.ts:191`）；ACP 五家的 MCP 工具调用没有被归到 `mcp`，除非 Agent 自己这样报【推：未见任何 ACP 路径产生 `mcp`】。

**标题、输入摘要、输出、diff 各放哪、谁生成**：

| 内容 | 字段 | 谁生成 | 形态 |
|---|---|---|---|
| 标题 | `PublicTool.title`（≤4096） | ACP：Agent 原样的 `title`，仅把控制字符换成空格，没有则“工具调用”（`acp.ts:63-67,887`）；Codex：Hub 生成的中文或命令首行（`codex.ts:182-203`）；OpenClaw 补记：`name: 第一个 command/path/file_path/query/url`（`openclaw.ts:161-162`） | 语言和句式各家不同 |
| 状态 | `PublicTool.status`（自由字符串 ≤128） | Driver 原样；只有 Codex 把 `inProgress` 改成 `in_progress`（`codex.ts:204`），Hermes 把“completed 但输出像失败”改成 `failed`（`hermes.ts:57,190`） | 取值：`pending/in_progress/completed/failed` + Codex 的 `declined` |
| 输入摘要 | **没有这个字段** | 界面把标题当摘要（`web/src/lib/turn.ts:144-151`） | |
| 输入 | 内容库 JSON 的 `input`（头部 ≤16 KiB） | ACP：`rawInput.command` 若是字符串就用它，否则把 `rawInput` 整个 `JSON.stringify` 缩进 2 格（`acp.ts:81-82,69-74`）；Codex：命令字符串或参数 JSON | 非命令工具直接露出原生 JSON |
| 输出 | 内容库 JSON 的 `output`（尾部 ≤64 KiB，`truncated` 标记） | ACP：`content` 里的文本拼接，否则 `rawOutput` 的 JSON（`acp.ts:84-91`）；Codex：`aggregatedOutput` 尾 128 KiB（`codex.ts:185,92`） | |
| diff | 内容库 JSON 的 `diff`（头部 ≤64 KiB） | ACP：Hub 用 `{path,oldText,newText}` 生成单文件 unified diff（`acp.ts:87-89`、`src/infrastructure/control/unified-diff.ts:22-38`）；Codex：原样，缺头则补 `--- a/` `+++ b/`（`codex.ts:93-97`） | 唯一被归一的内容 |
| 位置 | 内容库 JSON 的 `locations`（≤16） | ACP：`path:line`（`acp.ts:92`）；Codex：编辑是文件路径，**命令却是 cwd**（`codex.ts:185,187`） | 同一字段含义不同 |
| 退出码 | `PublicTool.exitCode` | **只有 Codex**（`codex.ts:185`），ACP、OpenClaw、Hermes 均无（`rg exitCode` 在这几个文件无命中） | |
| 父工具 | `PublicTool.parentId` | Claude 的 `_meta.claudeCode.parentToolUseId`（`acp.ts:80,93`）；Codex 子线程（`codex.ts:757,776`） | |

---

## B. 六家 Driver 各自映射成了什么

### B.4 矩阵

图例：● 有且进了预期公共字段；◐ 有，但有明显缺口、版本相关或形态特殊；○ 无；？未核实。

总览（行为 Harness，列为你列出的 15 项；公共字段对应关系：正文→`message`，思考→`thinking`，工具→`tools`，命令输出/diff→内容库 detail，计划→`plan`，用量→`usage`，活动→`activities`，通知→`notices`，输出→`outputs`，审批/提问→`PermissionRequest`（内存），子 Agent→`tools`(parentId)/`activities`，错误→`error`/`backend`/`notices`）：

| | 正文 | 思考 | 工具 | 命令输出 | 文件 diff | 计划 | 用量 | 活动 | 通知 | 输出 | 审批 | 提问 | 子 Agent | 错误 | 原生命令 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | ● | ◐常为空 | ●ACP词 | ●无退出码 | ● | ◐真机未见 | ● | ◐压缩 | ◐ | ◐export | ● | ● | ◐平铺 | ◐正则分类 | ●正文文字 |
| Codex | ● | ◐需配置 | ●Hub自造 | ●含退出码 | ● | ◐默认模型无工具 | ●无费用 | ● | ● | ● | ●中文选项 | ● | ◐双重表示 | ●类型化 | ◐thread操作 |
| OpenCode | ● | ● | ●todowrite是工具 | ● | ● | ○ | ● | ◐压缩 | ◐ | ◐ | ● | ？ | ○ | ◐ | ● |
| dsh | ● | ◐整块 | ◐kind恒other | ● | ○ | ○ | ◐仅上下文 | ○ | ◐ | ◐ | ◐未触发 | ○ | ◐ | ◐ | ○无命令 |
| Hermes | ● | ● | ◐状态恒completed | ◐ | ○ | ○ | ● | ○ | ◐ | ◐export | ● | ○ | ◐ | ◐ | ●本地回答 |
| OpenClaw | ● | ◐可能事后补 | ◐版本相关 | ◐ | ○ | ○ | ◐ | ○ | ◐ | ○ | ○未接出 | ○ | ◐ | ◐读转录 | ●桥命令 |

下面逐列给每一格的细节。

#### B.4.1 助手正文 → `PublicMessage(assistant).text`
- 共同：每个 Run 一条助手消息，所有片段按到达顺序拼接成一个字符串，**片段之间不加分隔**（`runtime.ts:1439-1442`；前端 `StreamingMarkdown` 也不处理边界，`web/src/components/StreamingMarkdown.tsx:57-72`）。是否会粘连取决于各家块是否以换行结尾【推，未验证】。
- Claude Code / OpenCode / dsh / Hermes / OpenClaw：ACP `agent_message_chunk` 的 text 块 → `text` 事件（`acp.ts:876-877`）；非文本块不进正文，进 `outputs` 或写诊断（`acp.ts:869-874`）。
- Codex：`item/agentMessage/delta`；某条消息没发过 delta 时用 completed 的整条（`codex.ts:838-845,856-858`）；**计划模式的 proposed plan 也作为正文**（`codex.ts:861`）。
- Hermes：最后几块可能晚于 prompt 响应，所以 Driver 额外等 250 ms 静默才结算（`hermes.ts:47,192`、`acp.ts:755-759`）。

#### B.4.2 思考 → `PublicRun.thinking`（一个字符串）
- Claude Code：ACP `agent_thought_chunk`（`acp.ts:878`）。【档】新模型默认 `thinking.display=omitted`，只发无文本签名块，所以常为空（`matrix:98`）。
- Codex：`item/reasoning/summaryTextDelta` 与 `textDelta` **都进 `thinking`，不区分摘要与原文**（`codex.ts:846-851`）；`reasoning` 条目本身被忽略（`:875`）。【档】用户配置没开推理摘要就一个字也没有（`matrix:64`）。
- OpenCode、Hermes：ACP thought 块；【档】真机有内容（`matrix:132,302`）。
- dsh：ACP thought 块；【档】0.2.1-alpha.1 观察到整块一次到达，不是逐字（`matrix:336`）。
- OpenClaw：桥流式就实时；**如果本回合一条 thinking 事件都没有，回合结束后从转录补记**，每块末尾加 `\n`（`openclaw.ts:152,492-493,508`）。【档】桥版本不同行为不同（`matrix:166`）。

#### B.4.3 工具调用与 kind → `tools[]`（取值见 A.3）
- Claude Code：标题、kind、状态都是 claude-agent-acp 原样；`name` 来自 `_meta.claudeCode.toolName`，父工具来自 `parentToolUseId`（`acp.ts:79-80,93`）。【夹】子 Agent 的 `Agent` 工具 kind 是 `think`（`tests/fixtures/control-peer.mjs:628`）。【档】0.89.1 在前台命令运行期间一直报 `pending`，回合中途结束时界面显示“未完成”（`matrix:99`）。
- Codex：**Hub 自造**。kind ∈ execute/edit/mcp/search/image/subagent/tool/other；标题中文：文件改动 `修改 a.ts, b.ts`（超过 3 个文件时加“等 N 个文件”）、搜索 `搜索：query`、图片 `查看图片 x.png`、子 Agent `子 Agent · 名字`、等待 `等待 N 秒`；命令标题=命令首行（多行压成一行，`codex.ts:90,185`）；`name` 是伪名 shell/apply_patch/web_search/view_image/`server/tool`；**不认识的 item 类型直接拿类型名当标题**（`codex.ts:892`）。Driver 里没有任何路径给 Codex 产生 `kind=read`（`itemTool` 无此类），Codex 读文件应当走 shell 命令【推】，所以界面上 Codex 不会有“读取 N 个文件”分组。
- OpenCode：ACP 原样；【档】标题是原程序给的路径；todowrite 显示为“N todos”工具，不发 plan（`matrix:134-135`）。
- dsh：【档】kind 恒 `other`，只有工具名、`rawInput` 和结果文本（`matrix:338`）。
- Hermes：【夹】标题形如 `terminal: rm -r x`（`control-peer.mjs:54`）；【档】`delegate_task` 显示为 execute 工具、标题 `delegate: …`（`matrix:321`）；**每个结束的调用都报 completed，Hub 靠输出文本的正则把它改成 failed**（`hermes.ts:57,190`）。
- OpenClaw：2026.10.5 的桥实时转发工具（ACP 词汇）；旧桥或漏掉的由回合后的转录补记：kind 来自 `TOOL_KIND`，标题 `name: 摘要`，**转录里找不到结果的调用状态记作 completed**（`openclaw.ts:162`）。

#### B.4.4 命令输出 → 内容库 `output`
- 共同：Runtime 合并时输入留头 16 KiB、输出留尾 64 KiB、diff 留头 64 KiB，超出打 `truncated`（`runtime.ts:112-122`）；详情在工具终态才写入内容库，用户点开某一步时前端才去取（`web/src/components/Activity.tsx:37-51,72-88`）。
- Claude Code / OpenCode / dsh / Hermes：`content` 文本拼接，没有就拿 `rawOutput` 的 JSON（`acp.ts:84-91`）；无退出码。
- Codex：`aggregatedOutput` 尾 128 KiB，增量 300 ms 节流；**唯一带 `exitCode`**；`locations` 里放的是 cwd（`codex.ts:74,185,905-914`）。
- OpenClaw：补记路径输出尾 64 KiB，无退出码（`openclaw.ts:159`）。

#### B.4.5 文件改动/diff → 内容库 `diff` + `locations`
- Claude Code、OpenCode：ACP `diff` 内容项 → Hub 生成单文件 unified diff；`locations` 为 `path:line`（`acp.ts:87-92`）。【档】真机都有（`matrix:100,134`）。
- Codex：`fileChange.changes[].diff` 原样，缺头补头；`locations` 最多 16 个路径；运行中还有 `patchUpdated` 更新（`codex.ts:93-97,187,911`）。
- dsh：【档】edit 不带 diff，也没有 locations（`matrix:338`）。
- Hermes：【档】patch 工具不发 diff（`matrix:304`）。
- OpenClaw：补记路径不产生 diff 也不产生 locations（`openclaw.ts:163`）。
- 后果【码+推】：前端“改动”页只收 `kind ∈ edit/delete/move` 且带 detail 的工具（`web/src/lib/turn.ts:304-306`），dsh 的编辑（kind 为 other）**不会出现在“改动”里**，即使它真的改了文件。

#### B.4.6 计划/待办 → `PublicRun.plan`
- Claude Code：ACP `plan`（`acp.ts:849-852`）；【档】真机会话里模型没有 TodoWrite 类工具，没见到实例（`matrix:101`）。
- Codex：`turn/plan/updated` → `plan`（`codex.ts:917-922`）；【档】默认模型没有 `update_plan`（`matrix:67`）；计划模式的方案是正文，不是 `plan`。
- OpenCode：无。todowrite 只是工具；ADR-022 明确否决“把 todowrite 推测成计划”（`docs/decisions/0022-native-activity-and-content-store.md` 否决方案一节）。
- dsh、Hermes、OpenClaw：无（dsh 的 `todo_write` 是普通工具；Hermes 不解析 todo 文本，`matrix:305,339`）。

#### B.4.7 用量 → `PublicRun.usage`
- Claude Code / OpenCode / Hermes：`PromptResponse.usage` → turn 各项；`usage_update` → context{used,size} 和 cost{amount, currency, **scope: session（会话累计）**}（`acp.ts:742-746,847-858`）。
- Codex：token 总数减去回合基线得到本轮；context 取“最近一次请求”的总数加窗口；**不报告费用**（`codex.ts:924-938`）。
- dsh：【档】只有 `usage_update` 的上下文占用与窗口，没有本轮 token 和费用（`matrix:340`）。
- OpenClaw：本轮 token 与费用来自转录（费用 **scope=turn，币种写死 USD**，`openclaw.ts:176`），上下文来自桥的近似值。
- 展示三处：回复悬停行、输入框下的状态行、详情“执行”页（见 C.7）。

#### B.4.8 活动 → `PublicRun.activities`
- 只有 Codex 会发 `subagent / compaction / review / retry`（`codex.ts:887-890,945`）。
- ACP 通用路径只会发 `compaction`（`acp.ts:898-904`），所以 Claude Code、OpenCode 有压缩时才有活动；dsh、Hermes、OpenClaw 没有（Hermes 的压缩只在重放里有标记，用作接力证据，不上屏）。

#### B.4.9 通知 → `PublicRun.notices`
- 五家 ACP：`notice` 会话更新（`acp.ts:894-897`；客户端声明了 `session.notices`，`acp.ts:219`）+ Driver 自己造的两条：表单含无法填写的字段（`acp.ts:955`）、审批超时（`acp.ts:1018`）。【档】没有记录到 Codex 之外的真实实例。
- Codex：warning、configWarning、deprecationNotice、guardianWarning、模型被服务端改路由、不重试的 error（`codex.ts:940-953`）。
- 所有家：Runtime 自己的“执行期限已到/等待期限已到”（`runtime.ts:176-179,1264`）。
- **注意**：`diagnostic` 只进事件日志，用户看不到。包括 Hub 接管 `/clear` 的那句说明（`src/adapters/control/relay-turn.ts:127-129`）：清空之后回合显示“已完成，没有文本输出”（`web/src/components/Turn.tsx:87`），说明文字在日志里。

#### B.4.10 输出 → `PublicRun.outputs`
- ACP 非文本块（image/audio/resource/resource_link）→ `outputs`，保存失败只留诊断（`acp.ts:109-123,869-874`）。
- Claude Code：`/export` 把转录 jsonl 作输出（`claude.ts:198`）。Codex：生成图片读文件作输出（`codex.ts:1022-1028`）、`/export`（`:674`）。Hermes：`/export`（`hermes.ts:300`）。OpenCode、dsh：ACP 非文本块，未真机验收。OpenClaw：无。

#### B.4.11 审批请求 → `PermissionRequest`（内存）
- Claude Code / OpenCode / Hermes（dsh、OpenClaw 同一条通用路径）：ACP `session/request_permission`。标题=工具标题；详情=diff，或 `命令：<cmd>`（Hub 加的中文前缀）+ `位置：…` + Hermes 的说明；**选项 id/name 原样来自 Agent**，界面直接当按钮（`acp.ts:98-103,997-1013`、`hermes.ts:76-80,195-200`）。
- Codex：命令/文件改动审批；标题=命令首行或“Codex 请求修改文件：x”；**选项是 Hub 的固定中文四项**“允许一次/本次会话允许/拒绝/取消”（`codex.ts:965-989`）；子 Agent 线程的请求加“子 Agent · ”前缀并归当前回合。
- dsh：【档】真机没触发过，界面用一段 dsh 专用文案解释规则（`web/src/components/Composer.tsx:60-62,597`）。OpenClaw：【档】桥“部分具备，Hub 未接出”（`matrix:171`）。

#### B.4.12 提问 → `PermissionRequest(kind=question)`
- Claude Code：ACP `elicitation/create` 表单，逐字段在对话里问；选项“提交回答/跳过/取消”是 Hub 中文（`acp.ts:927-978`）。
- Codex：`item/tool/requestUserInput`，支持密文输入（`codex.ts:990-1020`）。
- OpenCode：通用路径存在，【档】未核实；dsh、Hermes、OpenClaw 原程序不提供。

#### B.4.13 子 Agent
- Claude Code：子 Agent 的工具平铺在根会话，靠 `parentId` 指回发起它的 `Agent` 工具；没有 `activity`（`acp.ts:80,93`）；【档】主回复不含子 Agent 文字（`native-subagents-2026-10-11.md`）。
- Codex：**双重表示**：工具条目 `agent:<thread>`（kind subagent，子线程里的工具以它为 parentId，`codex.ts:751-777`）+ `activity(subagent)`（`:887`）+ `collabAgentToolCall` 工具（`:197`）。详情“后台”页还会把它再列一遍（`web/src/components/DetailsPanel.tsx:133`）。
- OpenCode：【档】task 子 Agent 不经 ACP 转发（`matrix:151`）。dsh：只显示调用它的那个工具。Hermes：`delegate_task` 只是一个 execute 工具。OpenClaw：`sessions_spawn` 只在补记路径里有 kind=subagent，只显示调用本身。

#### B.4.14 错误
- 五家 ACP：失败码由 `classifyRemoteFailure(message)` **对错误文本做正则**得到（`src/infrastructure/control/json-rpc-process.ts:86-98`），或各 Driver 的 `refusal` 钩子；**停止原因 `max_tokens / max_turn_requests / refusal` 被映射为 `failed` 但不带 `error`**（`acp.ts:748-754`），Runtime 把 `error` 记为 `null`（`runtime.ts:1885-1886`），界面只显示“失败”，没有原因（`Turn.tsx:309` 需要 `run.error` 才画错误卡）。
- Codex：类型化 `codexErrorInfo` → 7 个固定中文错误码（`codex.ts:212-222`）；同一失败还会先发一条 `notice(error)`（`:946`），再在回合终态写 `run.error`（`:826-831`）。
- Hermes：回合“成功结束但没回答”时读 stderr 判失败（`hermes.ts:270-273`）。OpenClaw：回合后读转录，`stopReason=error` 则改为失败（`openclaw.ts:178-181`）。
- 同义不同码：认证 `NATIVE_AUTH_REQUIRED`（ACP）/ `HARNESS_AUTH_REQUIRED`（Codex）；限流 `NATIVE_RATE_LIMITED` / `MODEL_RATE_LIMIT`；上下文 `NATIVE_CONTEXT_EXCEEDED` / `CONTEXT_WINDOW_EXCEEDED`。前端 `failureMessage` 对没有登记的码直接显示 `failure.message`（`web/src/api.ts:974`）。

#### B.4.15 原生命令（斜杠命令）的结果
- Claude Code：目录来自 Agent（【档】223 条）；命令的输出就是正文文字；`/export` 由 Hub 自己实现成产物；`/clear /reset /new` 由 Hub 接管；`/remote-control` 被拒（`claude.ts:48-49,176-183`）。
- Codex：app-server 没有斜杠命令，Driver 只实现 `/compact`（→ 压缩活动）、`/export`（→ 产物）、`/skill:名字`（→ skill 输入，目录里最多 512 条，【档】真机 173 项）；其他 `/x` 是普通文本；`/clear` 等由 Hub 接管（`codex.ts:576-585`、`relay-classify.ts:160-176`）。
- OpenCode：命令回答是正文；Hub 在目录里补 `/compact`（OpenCode 2 自己也宣告）；跑了 `/compact` 却没有任何输出 → 失败 `NATIVE_COMMAND_IGNORED`（`opencode.ts:27-29,136-137`）。
- dsh：没有原生命令；`/clear` 等由 Hub 接管，其余 `/x` 当文本发给模型。
- Hermes：命令由 viewer 本地回答，回答文字进正文；`/model x` 的回答被 Hub 读回成“会话模型已变”；`/compress` 无变化时标 noop；`/export` Hub 实现（`hermes.ts:243-277`）。
- OpenClaw：桥列的命令（【档】27 条）回答进正文；`/new` `/reset` `/clear` 单独出现由 Hub 接管，带参数时是桥自己的命令（`openclaw.ts:525-528`）。
- 界面上命令菜单（输入 `/`）的内容和长度因家而异：0 到 223 条，最多显示前 50 条（`Composer.tsx:317-321`）。

### B.5 同一件事，各家表现不同

**1. 执行一条 shell 命令**

| | 标题 | kind | 输出放哪 | 退出码 | 状态怎么走 |
|---|---|---|---|---|---|
| Claude Code | Agent 原样（【夹】常为命令本身） | ACP 词（execute） | detail.output，无结构 | 无 | pending→completed/failed；【档】旧版前台命令一直 pending |
| Codex | 命令首行（Hub 压成一行） | execute | detail.output，尾 128 KiB，流式 | **有**；`locations=[cwd]` | in_progress→completed/failed/declined |
| OpenCode | Agent 原样 | ACP 词 | detail.output | 无 | ACP 词 |
| dsh | Agent 原样（【推】可能是工具名） | **other** | detail.output | 无 | ACP 词 |
| Hermes | `terminal: <cmd>` | execute | detail.output | 无 | **恒 completed，靠文本正则改 failed** |
| OpenClaw | `exec: <cmd>`（补记）或桥的标题 | execute（名字表） | 补记：尾 64 KiB | 无 | 补记无结果记 completed |

前端的补救：只有 `kind=execute` 的才会被 `VERBS.execute` 去掉开头的 `run|bash|terminal|shell|exec|command` 再加“运行 ”（`web/src/lib/turn.ts:119,144-151`），所以 dsh 那一行没有动词、用扳手图标、被计为“其他工具”而不是“运行 N 条命令”。

**2. 改一个文件**

| | 标题 | kind | diff | 路径放哪 |
|---|---|---|---|---|
| Claude Code | Agent 原样（【档】审批卡示例 `Edit notes.txt`） | edit | Hub 由 old/new 生成 | locations `path:line` |
| Codex | `修改 a.ts, b.ts`（超过 3 个加“等 N 个文件”，Hub 中文） | edit | Codex 原样，缺头补头 | locations ≤16 个路径 |
| OpenCode | Agent 给的路径 | edit | 有 | locations |
| dsh | Agent 原样 | other | **无** | **无** |
| Hermes | Agent 原样 | 【推】edit 或 other | **无**（patch） | 无 |
| OpenClaw | `write|edit: path`（补记） | edit（名字表） | **无** | **无** |

**3. 读文件**：Claude Code/OpenCode 是 `kind=read`+locations，连续几次会被前端合并成“读取 N 个文件”（`turn.ts:98-108`）；Codex 的 Driver 不产生读文件条目（读文件应走 shell【推】，显示成“运行 …”）；dsh 是 `other`；OpenClaw 补记路径是 `read`。

**4. 计划/待办**：Claude → `plan`（有计划条）；Codex → `plan`（默认模型无此工具）或**正文**（计划模式）；OpenCode/dsh → 普通工具；Hermes/OpenClaw → 无。输入框上方的“计划”条只在有 `plan` 时出现（`ChatPage.tsx:715-720`），所以只有两家可能看到它。

**5. 思考**：见 B.4.2。可见性：Claude 新模型空；Codex 要配置；OpenClaw 可能回合后一次性补；dsh 整块；其余逐字。界面里思考默认折叠（`Turn.tsx:184-188`，`thoughts ?? detailed`）。

**6. 回合结束的状态与原因**：ACP `end_turn→completed`、`cancelled`、`max_tokens/max_turn_requests/refusal→failed 且无 error`；Codex `completed/interrupted/failed`，失败必带类型化 error；Hermes/OpenClaw 会在“成功结束”后根据日志/转录改判为 failed；`reason` 字符串（`end_turn`/`completed`/`interrupted`…）存在 `run.backend.reason`，**界面只读它判断 `cleared`**（`web/src/lib/relay-state.ts:205`），其余不显示。

**7. 审批**：Codex 选项是固定中文四项；ACP 的选项名是 Agent 的原词（界面靠正则 `always|session|persist|…|始终|会话` 与 `reject|deny|decline|cancel|…|拒绝|取消` 判断哪些是“长期生效/拒绝”，`Approval.tsx:17-23`）；Hermes 另加说明；dsh 只有一段静态文案。审批请求在输入框的位置“停靠”，提问则留在回合里（`Approval.tsx:28`）。

**8. 子 Agent**：见 B.4.13，四种表示。

**9. 压缩上下文**：Codex、Claude、OpenCode 2 是 `activity(compaction)`，标题固定“上下文压缩”；OpenCode 1.x 把摘要当正文；Hermes、OpenClaw 的 `/compress`、`/compact` 回答是正文文字。

**10. 清空**：六家都由 Hub 接管（五家 ACP 走 `acp.ts:599-611`，Codex 走 `codex.ts:576-585`），**说明只有一条日志级 `diagnostic`**，回合显示“已完成，没有文本输出”；下一回合开新原生会话。

### B.6 被原样透传到界面、没有归一的原生内容

1. 工具 `title`（ACP 只做空白清理，`acp.ts:63-67,887`）。
2. 工具 `status` 取值（`pending/in_progress/completed/failed/declined`…），`PublicTool.status` 是任意字符串（`state.ts:138`）。
3. 工具 `kind`、`name`；“工具名 · kind”在展开的详情里原样露出（`Activity.tsx:79`）。
4. 非命令工具的**输入是原生 JSON**，缩进 2 格整段显示（`acp.ts:69-74`）；`rawOutput` 无文本时也是 JSON（`acp.ts:91`）。
5. 审批的选项 id/name 与标题（`acp.ts:997-1013`）。
6. 通知的标题与说明（`acp.ts:894-897`；Codex 的 `message`，`codex.ts:950-951`）。
7. 没登记的错误码的 `message`（`api.ts:974`）；Codex 的未知 item 类型名当标题（`codex.ts:892`）。
8. 原生选项的 id/名称/取值：设置里显示 `OPTION_NAMES` 里有的中文名，其余是原 id，如 `approval_policy`、`sandbox`、`verbose_level`、`trace_level`、`elevated_level`（`Composer.tsx:63-64`、`ChatPage.tsx:217-227`）。
9. 斜杠命令的名字与说明（`acp.ts:842`）。
10. 计划条目的文字与 priority、压缩摘要、Codex 子 Agent 的模型名（`acp.ts:851-852,903`、`codex.ts:887`）。

---

## C. 前端怎么渲染

### C.7 时间线的组件结构

对话页 `ChatPage`（`web/src/components/ChatPage.tsx`）把 `session.messages` 画成一个平铺列表（`transcriptItems`，`:463-487`）：每条用户消息（`UserMessage`）→ 它的回合（`AssistantTurn`）→ 如果这里发生过换 Harness/模型，再接一条分隔线（`handover`，`:446-456`）。

一个助手回合（`web/src/components/Turn.tsx:263-327`）**自上而下**：

1. 回合头：品牌图标、Harness 名、`describe(run)`（模型 + 选项，`:299-303`）。
2. **过程行**（`TurnProcess`，`:107-195`）：一句话（进行中说在干什么，结束后说干了什么，如“读了 2 个文件，运行 1 条命令 · 用时 3.6 秒”）+ 展开箭头。展开后依次是：
   - “思考过程”（`StreamingMarkdown`；**默认折叠**，只有“显示每一步”密度才展开，`:183-189`）；
   - 活动列表 `ActivityList`（`Activity.tsx:240-248`，一行文字+状态，不可展开）；
   - 工具列表 `ToolList → StepItem`（`Activity.tsx:126-199`）：连续的读取合并成一组，子 Agent 的工具缩进在发起它的那一步下；每步可点开 `ToolDetail`（输入/改动/输出/位置，**默认折叠**，点开才请求内容库）。
   - 展开状态：`open = expandable && (choice ?? (detailed || phase !== "settled"))`（`:114`）——**回合进行中展开，结束约 1.1 秒后折叠成一行**，除非开了“显示每一步”。历史对话一进来就是折叠的。
3. 排队说明（`QueuedTurn`，`:228-236`）。
4. **通知**（`NoticeList`，`Activity.tsx:222-228`）：每条一张卡，**总是展开**。
5. **助手正文**（`StreamingMarkdown`，`:307`），总是显示。
6. 错误卡（`:309-312`），仅 `failed/unknown` 且有 `run.error`。
7. 产物（`OutputList`，`Activity.tsx:250-257`）：图片直接显示，其余是下载按钮。
8. 审批/提问的痕迹（`children`，来自 `ChatPage.turnRequests`，`:428-437`）：已决定的审批一行字（`DecisionLine`）、停靠中的审批的琥珀色标记（`DockedMarker`）、提问卡片（`PermissionCard`）。
9. 元信息行（悬停才显示）：复制、分支、执行详情、重试按钮，加用量和首字时间（`:316-325`）。

计划**不在回合里**：输入框上方的计划条 `PlanBar`（`ChatPage.tsx:715-745`，默认折叠，显示 `N / M · 正在：…`）和详情栏“计划”页（`PlanView`，`Activity.tsx:205-218`）。用量出现三处：回合悬停行、输入框下的状态行 `StatusLine`（`ChatPage.tsx:757-779`）、详情栏“执行”页。

### C.8 前端按 Harness 名字或原生工具名分支的地方

**按 Harness id/名字（对话路径，3 处）**：

| 位置 | 内容 |
|---|---|
| `Composer.tsx:54,72,280-281` | `SETUP_COMMANDS = { hermes: "hermes model" }`：Hermes 未配置时的标签与提示命令 |
| `Composer.tsx:60-62,597` | `APPROVAL_NOTES = { dsh: … }`：dsh 的审批规则说明 |
| `api.ts:925` | `NATIVE_GATEWAY_UNAVAILABLE` 的整段文案只讲 Hermes（`hermes gateway status`…） |

另：`BrandIcon.tsx:49-83` 按 Harness id 选图标，对 `dsh/workbuddy`、`codex` 和一批单色图标有特例（纯外观）。

**按原生选项 id 或分类（6 处）**：`Composer.tsx:63-64`（`THINKING_NAMES`、`OPTION_NAMES` 键为 `thought_level / fast_mode / verbose_level / reasoning_level / response_usage / elevated_level / collaboration_mode`）；`Composer.tsx:256-262`（按 `category` 取 `thought_level / mode / permission` 决定画哪些控件）；`Composer.tsx:295,305`（`collaboration_mode === "plan"`，即 Codex 的计划模式，写了整段提示）；`ChatPage.tsx:223`（正则 `/thought|effort|reasoning/` 判断选项是不是思考档位）；`ChatPage.tsx:420`（`category === "permission"` 找“来自某某策略”的名字）；`App.tsx:72`。

**按工具 kind、状态词、标题文字（7–8 处）**：`Activity.tsx:17-31`（图标 switch）；`turn.ts:8-9,27-29`（状态词集合，认 `pending/in_progress/inProgress/running`，失败只认 `failed/declined`）；`turn.ts:33-47`（8 类 switch）；`turn.ts:110-151`（`VERBS` 动词前缀正则 + `CREATE` 正则）；`turn.ts:167-169`（`askingStep` 假设“ACP 报 pending、Codex 报 in_progress”）；`Approval.tsx:17-23`（选项词正则）；`turn.ts:304-306`（`editTools` 只认 edit/delete/move）。

**没有**按原生工具名（Bash、Edit、apply_patch…）的 switch；`detail.name` 只在展开后作为一小行字显示。

**能力管理页（不在对话路径，7 处）**：`CapabilitiesPage.tsx:123,187`（codex）、`:224-232,318`（claude）、`:301`（hermes/openclaw）、`InstructionsPanel.tsx:67`（cursor）、`SkillTextDialog.tsx:15,20`（点名 Claude Code/OpenCode/Cursor/Codex 的差异文案）。

### C.9 接力相关的界面元素

| 元素 | 文件 | 出现条件 |
|---|---|---|
| 交接分隔线 `RelayDivider`（及旧式 `SwitchDivider`） | `RelayDivider.tsx`、`Turn.tsx:337-364`、`ChatPage.tsx:446-456` | 对话里有一次**生效的切换**（Harness 或模型不同），画在切换前最后一条消息后；状态词：送达中/已开始回复送达待确认/接手/没有确认/没有送达/只发了原话（`relay-state.ts:188-224`）。同 Harness 换模型或网关无接力信息时退回旧式一行 |
| 分隔线上的链接“查看交接单”“改回” | `RelayDivider.tsx` | 有 packetId / 是最近一次且已“接手” |
| “附交接单 #n”条 `RelayAttachment` | `RelayDetails.tsx:13-18`、`Turn.tsx:219` | 这条消息带了交接单（`ChatPage.tsx:322-331`） |
| 消息下的说明行 `RelayNote` | `RelayDetails.tsx:25-27`、`relay-state.ts:151-168` | 接力做了“多于按序交付”的事（重发、全量重发、精简、只发原话及原因） |
| 输入框上方的卡片 `RelayCard`（横幅或一行） | `RelayCard.tsx:35-66`、`relay-state.ts:261-310` | 对话空闲时：有一条**待交付**（“将交给 X：N 轮”）；**首次**交给这家 Harness 时说明去向（`first`）；设置关闭自动附上时说“这条只发原话”（`off`）；或 binding 有需要看的事（交接单未确认送达、上下文已清空）= 横幅，可关闭。带按钮“只发这条消息”/“附上之前的对话”/“再附一次”/“附上交接单” |
| 安装级警告 `RelayInstallation` | `RelayCard.tsx:71-73`、`ChatPage.tsx:594` | 接力密钥文件不可用（`key_unavailable`），常驻 |
| 详情栏“接续”页 | `DetailsPanel.tsx:144`、`RelayDetails.tsx` | 有交接单或多于一个 binding 或有待交付/待看的事（`relayHasStory`） |
| 交接单原文对话框 | `RelayDetails.tsx:36-` | 点上面任一“查看交接单” |

“只发这条消息”：`RelayCard` 的按钮（`SEND_ALONE`），只在有待交付时出现。**首次交接说明**：`RelayCard` 的 `intro` 状态，文字“这条消息会附上之前的对话记录交给 X · 可在设置里关闭”。

**一屏最多同时出现多少提示位**（代码层面的上限，实际常见 3–6 个【推】）：
- 页面顶部 4 个：`error`、`connectionError`、接力安装警告、切换失败（`ChatPage.tsx:591-598`）；
- 输入区上方 2 个：排队提示、工作区被占用（`:633-637`）；
- 输入区内 6 个：`{切换条 | 沿用原生命令设置条 | 暂停提示 | 说明行}` 四选一、原生模型读取失败行、接力卡片/横幅、被暂存的消息、计划条、状态行（`Composer.tsx:403-418,527-537`）；
- 时间线里的接力 3 类：分隔线（含 2 个链接）、交接单条、说明行，数量随切换与消息增加；
- 另外每个回合自己的 `NoticeList` 可有 ≤32 张卡。
合计 15 类槽位；**接力专属 5 类**（分隔线、交接单条、说明行、卡片/横幅、安装警告），加上详情栏“接续”页和对话框是 7 种出现形式。

### C.10 页面整体布局与随 Harness 变化的控件

- 侧栏（`Sidebar.tsx:162-193`）：Logo/首页、收起（⌘B）、“新对话”（⇧⌘O）、搜索（⌘K 命令面板）、“等你处理”收件箱（带数量）、“Harness”页（安装任务/更新徽标）、“能力”页、[“模型连接”页，仅 `providerManagement` 开时；**交付的 CLI 把它关掉了**，`src/cli/web.ts:40`]、按项目分组的对话列表（状态点+图标+标题）、设置（带端口与连接指示）。
- 顶栏（`ChatPage.tsx:558-590`）：窄屏菜单/展开侧栏、对话标题、工作区名、`HeaderState` 状态药丸（“<Harness> 正在执行 · 0:44”，窄屏隐藏）、详情栏开关（带改动数徽标）、“…”菜单（从最新回复分支、在原程序中继续的方式、收起/打开详情、显示每一步、导出 Markdown/JSON、结束对话）。
- 详情栏（`DetailsPanel.tsx:140-145`）6 个页签：改动 / 计划 / 过程 / 后台 / 执行 / 接续。“过程”页重复画一遍各回合的工具列表，“计划”页重复计划条，“后台”页混着保留进程与活动。
- 输入区（`Composer.tsx`）：文本框；左下“+”菜单（添加文件或图片、原生命令、继续原程序的会话）；**权限选择器（只有上报了 `permission` 分类的家才有，实际是 Codex）**；右下“合并选择器”= Harness 选择器（⌘J）｜[Provider]｜模型｜**思考强度药丸**｜**模式药丸（仅在没有思考档位时）**；“本轮结束后发送”暂存键；发送/停止键。Harness 选择器底部“查看技能与扩展…”“高级配置…”。
- **因 Harness 而异的控件**：
  - 模型列表、思考档位的取值（`off/minimal/low/medium/high/xhigh/max/ultra/adaptive` 里各家取一部分，`Composer.tsx:63`）；
  - 模式：只有“没有思考档位”的家，模式才占药丸位（`Composer.tsx:257-260`），OpenCode（Build/Plan）属此类；有思考档位的家（Claude 的 default/acceptEdits/plan/auto/bypassPermissions、Codex 的协作模式 default/plan）模式被放进“高级配置”【推：Claude 的模式是否按 `mode` 分类上报，没有逐项核对】；
  - 权限/审批档位：Codex 在输入框左下单独一个盾牌选择器；Claude 的藏在高级配置；dsh 只有一段文字；其余无；
  - “高级配置”里的原生选项：OpenClaw 有 thought/verbose/trace/reasoning/response_usage/elevated/fast 七八项，Codex 有 approval_policy/sandbox/collaboration_mode，Claude 有 mode/effort/fast/agent（【档】`docs/verification/claude-real-and-approval-detail-2026-10-11.md`）；
  - 原生命令菜单：0（dsh）～223（Claude）条，Codex 是 `/compact`、`/export` 加每个启用技能一条 `/skill:名字`；
  - 审批：Codex 的审批停靠条会写“来自 X 的‘策略名’策略”（`ChatPage.tsx:415-425`）。

### C.11 用户感到“乱”的最可能来源（按可能性排序）

1. **同类操作在不同 Harness 下长得不一样。** 标题语言（Codex 中文、其余原生英文句子/路径/`terminal: x`）、动词（只对 kind=execute/read/edit… 生效）、图标（kind 不认识就是扳手）、分组（Codex 的 Driver 不产生读取条目，不会有“读取 N 个文件”）、结构化信息（只有 Codex 有退出码；Claude/Codex/OpenCode 有 diff，dsh/Hermes/OpenClaw 没有）、摘要计数（dsh 的命令被数成“其他工具”）。依据：`acp.ts:77-96,887-891`、`codex.ts:182-203`、`web/src/lib/turn.ts:35-56,110-151`、`Activity.tsx:17-31`、【档】`matrix:338`。
2. **回合不是按时间排的，且正文是一整块。** 思考、活动、工具永远在上方的“过程”里，正文永远在下面；片段之间没有边界；`PublicRun` 里没有任何跨类型的顺序（`session.ts:99-123`、`Turn.tsx:298-326`、`runtime.ts:1425-1446`）。【推】边工作边说话的 Harness 在这里读起来和它在原生界面里差别很大。
3. **同一状态出现在 5–6 个位置，词也不统一。** 头部药丸（`ChatPage.tsx:680-705`）、回合过程行（`turn.ts:214-259`、`Turn.tsx:79-91`）、侧栏行（`Sidebar.tsx:61-66`）、输入框下状态行（`ChatPage.tsx:757-779`）、详情“执行状态”（`turn.ts:31`）；用词：“完成”（`RUN_STATE`）与“已完成”（头部、过程行）；读屏文本又一套（`api.ts:979-982`），导出一套（`conversation-export.ts:5`）；工具状态“等待/执行中/进行中/正在执行”交替（`turn.ts:9`、`Activity.tsx:151`、`turn.ts:196-202`）。
4. **提示/条幅位太多。** 代码上同屏最多 15 类（C.9）；接力就占 5 类（分隔线、交接单条、说明行、卡片/横幅、安装警告）；加上切换条、沿用设置条、暂停提示、暂存消息、计划条、状态行都挤在输入框周围（`Composer.tsx:403-418`、`ChatPage.tsx:524-537`）。与 AGENTS.md“默认零操作”的方向相反。
5. **原生术语和原生内容直接露出。** 非命令工具的输入是整段 JSON（`acp.ts:69-74`）；“Bash · execute”小字（`Activity.tsx:79`）；Claude/ACP 审批的按钮是 Agent 的原词；原生选项 id（`approval_policy`、`trace_level`…）；没登记的错误码显示原始 message；`think`/`other`/`tool`/`image` 的工具落进“其他工具 N 个”（`turn.ts:35-47,53`）。
6. **输入区控件随 Harness 变。** 药丸位上换成思考或模式（`Composer.tsx:256-262,342`）、权限选择器只有 Codex 有（`codex.ts:178` 是唯一声明 `permission` 分类的 Driver）、高级配置里的项目数各家不同（OpenClaw 最多）、命令菜单 0 到 223 条且不分组（`Composer.tsx:317-321`）。
7. **信息缺口让某些家看起来“空”或“残”。** dsh、Hermes、OpenClaw 没有 diff（“改动”页不收）、没有退出码、没有计划；OpenClaw 的工具/思考可能回合结束后才补出来；Claude 新模型没有思考文本。依据 B.4.2、B.4.5。
8. **子 Agent 与后台任务有四种画法。** Codex 同一个子 Agent 在过程里出现两行（工具行+活动行）还会进“后台”页；Claude 是嵌套工具；Hermes/dsh 只是一个普通工具；OpenCode 不转发（`codex.ts:881-888`、`DetailsPanel.tsx:133`）。
9. **结局说明缺失或重复。** ACP 的 `refusal/max_tokens` 只显示“失败”，没有原因（`acp.ts:748-754`、`runtime.ts:1885`）；Codex 的失败可能同时有一张通知卡和一张错误卡，且两处中文不是同一句（`codex.ts:946,212-222`、`api.ts:974`）【推：依据两处代码的并存，未在真机复现】；`/clear` 的说明只在日志里（`relay-turn.ts:127`）。
10. **审批与提问分两处、且事后无记录。** 审批停靠在输入框的位置（输入框被替换），提问留在回合里；决定后请求即被删除，页面刷新后回合里看不到“你允许了/拒绝了什么”，那几行只来自页面本地状态（`Approval.tsx:28`、`ChatPage.tsx:167-178,405,428-437`、`runtime.ts:278,1841`）。
11. **详情栏有 6 个页签且互相重复。** “过程”页重画一遍时间线里的工具，“计划”页重画计划条，用量在三处（`DetailsPanel.tsx:140-145,243-267`、`ChatPage.tsx:535-537`）。

视觉层面（间距、字号、配色）我没有渲染，无法判断。

---

## D. 归一化要改哪里

### D.12.1 现有契约离“统一条目模型”多远

以你列出的 14 类条目对照：

| 条目 | 现有承载 | 缺口 | 动作 |
|---|---|---|---|
| 消息 | `PublicMessage`（每 Run 一条助手消息） | 一个回合里多段助手文字没有各自的条目与顺序 | 加字段/新结构 |
| 推理 | `run.thinking` 单字符串 | 无条目 id、无顺序、摘要与原文不分 | 合并成条目 |
| 命令执行 | `tool` kind=execute + detail | 命令、cwd、退出码、输出没有结构化；只有 Codex 有退出码；kind 不由协议保证 | 加字段 |
| 文件变更 | `tool` kind=edit/delete/move + detail.diff/locations | 缺 `changes[{path,op,diff}]`；dsh/Hermes/OpenClaw 无 diff | 加字段（接力叙述已有现成的拆 diff 逻辑 `narration.ts` 的 `changesOf`/`diffFiles`，可上提） |
| 文件读取 | `tool` kind=read + locations | 缺 path/范围；Codex 根本没有 | 加字段 |
| 搜索 | `tool` kind=search | 本地检索与联网搜索混在一个值里（`codex.ts:193` vs ACP） | 拆分取值 |
| 网络 | `tool` kind=fetch | 只有 ACP 有；Codex 的联网搜索被当成 search | 取值归并 |
| MCP 工具 | `tool` kind=mcp | 只有 Codex 产生 | Driver 补判定规则 |
| 子 Agent | `tool`(parentId) + `activity(subagent)` | 两处表示，Codex 重复 | 合并 |
| 计划 | `run.plan`（最新快照） | OpenCode todowrite、Codex 计划模式的来源没接 | 已有，补映射；注意 ADR-022 曾否决“推测成计划”，需要新决定 |
| 审批 | `PermissionRequest`（内存） | 不在快照，不落盘，无“用户选了什么” | **新建并持久化** |
| 提问 | 同上 | 同上，用户的回答也没有记录 | **新建并持久化** |
| 错误 | `run.error` + `notice(error)` + `diagnostic` | 三处，错误码同义不同码 | 合并 |
| 通知 | `notices[]` + `activities`(compaction/retry/review) | 通知已够用；活动应归为“状态”类条目 | 已有，小改 |

最大的结构性缺口不是某一类条目，而是**没有统一的有序条目序列**：时间顺序只在事件日志里（`runtime.ts:1322,1344,1444`），公共快照里没有。

还有三个读者在消费同一套 `kind/status`，改取值会同时波及：接力叙述（`src/contexts/session/domain/relay/narration.ts:230-253`，含它自己的 `kindOf`、`FAILED_TOOL=failed|error|declined|rejected|cancelled`、一套 `diffFiles`）、上下文表（`src/contexts/session/domain/table.ts:8,59,116,121,150`，直接复用接力叙述的 `kindOf`/`changesOf`）、Web（`turn.ts`、`Activity.tsx`，又一套状态集合、另一份 `parseUnifiedDiff`）。运行时自己还有一个状态集合 `TERMINAL_TOOL`（`runtime.ts:102`）。所以“工具是否失败/是否结束”现在有 Web（`failed|declined`）、运行时（`completed|failed|declined|cancelled|interrupted|error`）、接力叙述（上面那组）三种口径。约 15 个测试文件引用现有 kind 词汇。接力叙述的输出会进交接单，改它等于改交接单的内容。

### D.12.2 六家 Driver 各自要补多少归一逻辑（粗估，我的判断）

| Harness | 工作量 | 理由 |
|---|---|---|
| Codex | 小到中 | 本来就是类型化的 item，id 和顺序都有；要做：统一 kind 取值与中文标题策略、拆搜索、补推理条目、去掉子 Agent 重复、计划模式的方案改成 `plan` 来源 |
| Claude Code | 中 | 走共用的 ACP 路径；需要按 `kind` + `_meta.claudeCode.toolName` + `rawInput` 抽命令/路径、识别 MCP 与子 Agent（【夹】夹具里 `Agent` 工具的 kind 是 `think`，`control-peer.mjs:628`）、补命令/路径抽取 |
| OpenCode | 中 | 同上；`todowrite`→计划要做，且要先撤回 ADR-022 的否决；标题是路径 |
| dsh | 中到大，且有永久缺口 | kind 恒 other，必须按工具名建表再从 `rawInput` 抽字段；没有 diff 与位置，Hub 无从补 |
| Hermes | 中到大 | 标题 `terminal:`/`delegate:` 要靠前缀识别；状态已有一处修正，需推广；patch 无 diff |
| OpenClaw | 大 | 双路径（桥实时 / 转录补记）取值不同；名字表需扩充；思考可能事后到；无退出码、无 diff；补记时的“无结果记 completed”要改成未知 |

共用部分：五家走 `AcpControl`，工具映射是模块级函数 `toolDetail()`（`acp.ts:77-96`）而不是可覆盖的钩子（现有钩子只有 `toolStatus`，`acp.ts:447`），所以做归一的第一步大概是给 ACP 基类加一个“工具归一钩子”，各家只写差异表【推】。

前端侧：`lib/turn.ts` 与 `Activity.tsx` 里的 `toolCategory / VERBS / TOOL_STATUS / toolIcon / editTools` 都集中在两个文件里，换成按条目类型渲染的工作量小到中；**真正大的是把正文和过程改成按时间交错渲染**（`Turn.tsx`、`StreamingMarkdown`、折叠/动效规则、`lib/turn.ts` 里的显示节奏逻辑都依赖“一整块正文”）【推】。

### D.12.3 持久格式会不会因此要变（`SessionSnapshot.schemaVersion` 现为 13）

分三档：

1. **只归一取值**（kind、status、标题语言、错误码）：**不需要改格式**。`tools[].kind/status/title/name` 在落盘校验里就是自由文本（`state.ts:136-143`），详情在内容库里是自由 JSON。代价是旧会话保留旧取值，三个读者（Web、接力叙述、上下文表）都要同时认新旧两套。
2. **加结构化字段**（语义分类、`command/cwd`、`changes[]`、条目序号）：**要改**。`parsePublicRun`/`publicTool` 的 `keys(...)` 白名单拒绝未知键（`state.ts:137,192`），Web 解码器也是（`api.ts:372-395`）；按现有惯例要升到 `schemaVersion` 14、加“旧版本不得带这些字段”的校验（先例 `state.ts:325-330,389-390`）、写迁移并备份业务库（`src/infrastructure/session/sqlite-store.ts:18,238-252`），旧程序会拒收新版本。按 AGENTS.md，这属于“改持久格式”，要 ADR 加一轮独立审查。
3. **把审批/提问/有序条目变成持久事实**：同上，另外受会话 8 MiB、每 Run 的条目上限约束（`state.ts:20,27-30`）。

另一条不动格式的路【推】：在 API 层做**读侧投影**，用现有 Run 事实 + 事件日志现算统一条目。限制：文字与工具的先后、审批的结果只在事件日志里，日志有上限（`state.ts:21-23`），老 Run 可能缺；所以只能解决“长得一致”，解决不了“按时间交错”和“审批留痕”。

---

## 附录 1：我没有确认的事

- 真实的标题字符串（Claude、OpenCode、dsh、OpenClaw）：没有真机抓包，只有夹具和文档记录。
- Codex 命令条目的 `command` 是否带 shell 外壳：没有验证。
- Codex 的 `commandExecution` 项是否自带命令分类（本仓库没有读取，`rg commandActions` 无命中）：未核实；若有，可直接用来区分读/搜/列文件，是归一 Codex 的线索。
- OpenClaw 各桥版本的差异：以驱动注释为准（`openclaw.ts:462-470`）。
- 正文片段会不会粘连：取决于各家块的内容，未验证。
- Hermes viewer 的 `kind` 取值：只见到 `terminal:`/`delegate:` 两个标题和一个 execute 记录。
- 视觉层面的间距、字号、配色：没有渲染。

## 附录 2：关键文件索引（绝对路径前缀 `~/Desktop/project/HarnessHub/.claude/worktrees/relay-stage2-7cb3e9/`）

- 契约：`src/contracts/session.ts`、`control.ts`、`web.ts`、`table.ts`
- Driver：`src/adapters/control/acp.ts`（ACP 通用）、`claude.ts`、`opencode.ts`、`hermes.ts`、`openclaw.ts`、`codex.ts`、`factory.ts`、`relay-turn.ts`
- 运行时与持久：`src/contexts/session/application/runtime.ts`、`src/contexts/session/domain/state.ts`、`src/infrastructure/session/sqlite-store.ts`
- 接力叙述与上下文表：`src/contexts/session/domain/relay/narration.ts`、`src/contexts/session/domain/table.ts`
- 前端：`web/src/components/{ChatPage,Turn,Activity,Composer,DetailsPanel,Approval,Sidebar,RelayCard,RelayDivider,RelayDetails}.tsx`、`web/src/lib/{turn,relay-state}.ts`、`web/src/api.ts`
- 记录：`docs/verification/native-capability-matrix.md`、`docs/decisions/0022-native-activity-and-content-store.md`、`docs/decisions/0054-design-language-2.md`
