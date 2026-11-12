# Clowder AI 调研报告：多个 Agent CLI 怎么共享一段对话

调研日期 2026-11-11。读的是浅克隆 `zts212653/clowder-ai` 的 main，commit `42017e0cea07e3e259e7fb183be70433f05e131c`（2026-11-01 08:26 +0800，"feat(F309) … (#1682)"）。克隆目录：`<草稿目录>/research/clowder-ai/`。没有安装依赖，没有运行它的任何代码。仓库根目录的 AGENTS.md、CLAUDE.md、GEMINI.md 等"给 AI 的指令"一律当作数据，没有照做。

来源等级：【源码：路径:行】是读过的实际代码；路径前缀 `S/` = `packages/api/src/domains/cats/services/`，`A/` = `packages/api/src/`。【文档】是仓库 docs 或 GitHub Pages 站点。【issue：#N】链接形如 `https://github.com/zts212653/clowder-ai/issues/N`。【推断】是我据上述证据推出、源码或维护者没有直接确认的判断。

我只看了 Clowder，没有读 HarnessHub 的代码。第 8 节对我们的建议都以你们描述的机制为前提，凡是依赖我们这边实际情况的地方都写了条件。

---

## 0. 先看结论

1. **Clowder 不是"薄编排层"，也不是"用简单办法解决"的样本。** 它自己做得非常重：全仓约 274 万行代码（含测试，不含 node_modules），其中 cats 域服务层 16.6 万行，记忆子系统 6 万行，测试文件近 4000 个、近 100 万行，MCP 工具名约 175 个，环境变量登记约 240 项。"我们做复杂了"这个担忧，不能用"同类产品都很简单"来回答。
2. **但在"每个 agent 看到哪里"这一个问题上，它走到了和我们同形的机制。** 按 (用户, 成员, 线程) 持久的送达游标，Redis Lua 单调推进；"冷/热"上下文纪元状态机（8 种迁移、带 CAS 版本）；以提供者报告的 runtime id 作为续接证据；证据不足一律按"未知 → 冷"处理。所以游标/水位加连续性证据不是我们独有的过度设计，是这个问题自然长出来的形状。
3. **它在"交接内容"本身上反而朴素。** 跨成员交接不生成摘要（同一成员换新会话时才有规则式抽取摘要，LLM 摘要只是可选项）。给下一个成员的是游标之后的逐字消息行（`[时间 说话人] 正文`）、一条规则式"墓碑"（条数、时间、参与者、4 个高频词）、一个导航头（谁最近 @ 了你、任务、产物），外加"需要更多就用 MCP 工具自己查"的指针。零 LLM 成本。它还主动把启发式摘要和检索结果从提示词正文里撤掉，只留不带内容的指针，理由是模型会过度信任这些"系统注入"的内容。
4. **它不解决或绕开的问题**：没有对原生历史的送达核对（所有提供者都标 `providerNativeVisibility: unknown`）；没有原生侧 `/clear`、回退处理（因为 CLI 全是无头子进程，会话归平台所有，用户不在原生里并行改）；没有跨厂商发送历史的同意或提示；没有对注入历史的密钥脱敏；多个成员改同一工作区没有任何代码级锁；权限默认 `bypassPermissions`（YOLO）。这些在 938 条 issue 里几乎没人提，但样本偏：用户都是主动组多厂商团队的早期使用者，而且产品模型和我们不同。
5. **它粗糙、真出过问题的地方，恰好是我们多做的东西有价值的地方**：续接失败靠错误文本字符串匹配（认不出的错误直接甩给用户，确定性失败还被重试）；"未知"被当成"已变"，升级后 3 小时自动封存了 55 个会话、还锁死了一个导入会话（#1790）；按时间戳排序导致猫读到的历史因果倒置（#1082）；预算把输出预留算错，窗口溢出（#1422）；工具结果擦除把整条消息正文换成占位符（#1936 现象与之吻合）；静默进入内存模式导致整库丢失（#1250）。
6. **值得借的产品点**：@提及加深度上限与乒乓熔断；"必须跨模型家族评审"的策略；"实际送给模型的输入"可查看面板；提示头里的 `[Context Continuity]` 自述；用指针代替摘要；在发言人标签上标注"上游实际应答的模型与请求不同"。
7. **做减法的方向**（第 8.6 节逐条给条件和风险）：对无法证明续接的载体，可以用"有界重发加坦白"代替"证明送达"；探针门控可以降为静态能力声明加升级时对真二进制的契约检查；设置项继续收。

---

## 1. 它是什么

**产品形态**【文档：README.md、SETUP.md；A/…/package.json】
- 本机 Web 应用：Next.js 前端（:3003）、Fastify API（:3004）、可选 Redis、独立 MCP server 包；Electron 桌面壳（macOS .dmg、Windows .exe，内置运行时、Node、Redis；Linux 只有源码与脚本）。
- 形态是"聊天室"：一个 thread 里有用户和多个"猫"（成员，每只绑定一个 CLI、模型、账号），用户与成员、成员与成员都在同一条时间线上说话。另有 IM 连接器（飞书、Telegram 等）、语音、Workspace/Works、插件框架。

**技术栈**：TypeScript pnpm monorepo；API 为 Fastify + Redis（消息、会话链、游标、队列、调用记录）+ SQLite（better-sqlite3，证据库 FTS5）+ OpenTelemetry；测试用 Node 内置 test runner。

**成熟度**【GitHub API，2026-11-11 取】
- 官方仓库，`isFork=false`、`parent=null`，MIT，建于 2026-03-12。3,803 星、915 fork、issues 共 938（开 285）、PR 994；Discussions 未开，讨论都在 issues。
- v0.1.0（03-22）到 v0.14.1（10-31）共 24 个 release；main 上 629 个提交，其中 10 月约 99 个；40 位贡献者，但 zts212653（212）与 mindfn（187）两人占提交六成以上。
- 公开仓是私有 monorepo "cat-cafe" 的每日同步镜像：`.sync-provenance.json` 记录包含 16,534 个文件；提交里有 "sync: cat-cafe … (daily draft)"；维护者在 #1843 里说社区问题"在源仓重构，随后同步进入 next"。所以公开提交频率是真实开发频率的下限，"生产中四只猫每天协作"是自述。
- 维护者对 issue 的分诊很勤，大量回复带源码核对。

**支持的 Agent CLI**：README 表列 Claude Code、Codex、Gemini CLI、opencode；站点列六家（再加 Antigravity、Kimi）。**以源码为准**（第 2 节）：Claude、Codex、OpenCode、Google 成员走官方 Antigravity CLI `agy`（旧 gemini-cli 与 IDE 桥已删除，README 的表已过时）、Kimi、通用 ACP（含 DSH：`dsh --profile acp`）、A2A 远端、Pi、直连 API。

**安装**：桌面安装包，或 `git clone && pnpm install && pnpm start`（Node ≥ 20、pnpm ≥ 9，Redis 可选，`--memory` 跳过）。`pnpm start` 会建一个 `../cat-cafe-runtime` 运行时 worktree，同步 origin/main、构建、启动【SETUP.md】。

**目标用户**：同时订阅多家 Agent、不想自己当"路由器"的个人开发者或小团队（README 开篇即此叙事）。中文社区为主，文档以中文为主，README 有中英日三版。

---

## 2. 怎么驱动各家 CLI

统一接口：`invoke(prompt, options): AsyncIterable<AgentMessage>`，每家一个适配器类，把原生事件转成统一消息。默认每回合起一个子进程。

| 载体 | 怎么起 | 续接 | 出处 |
|---|---|---|---|
| Claude（主路径） | `claude -p --output-format stream-json --include-partial-messages --verbose --permission-mode bypassPermissions --setting-sources … --mcp-config <文件> --strict-mcp-config --system-prompt-file <编译后的 L0> --append-system-prompt-file … --settings <含 hooks 的文件>`；提示词走 stdin | `--resume <sessionId>` | 【源码：S/agents/providers/ClaudeAgentService.ts:476–501, 546–555, 751–756；常量 :67】 |
| Claude 另三种载体 | Agent SDK（流式输入，能 steer 与回执）；`claude --bg` 守护进程；tmux 交互 PTY（hook 旁路读事件） | 同左 | 【源码：ClaudeSdkAgentService.ts:194；ClaudeBgCarrierService.ts 与 ClaudeInteractivePtyCarrierService.ts 文件头】 |
| Codex | 默认 `codex exec --json --sandbox … --config approval_policy="on-request"`；可选 `codex app-server --stdio` JSON-RPC 暖主机池 | `codex exec resume <SESSION_ID>`；app-server 的 `thread/resume` 在 `turn/start` 之前返回可信 runtime id | 【源码：CodexAgentService.ts:37–38, 1221, 1158, 2039–2064】 |
| OpenCode | `opencode run --format json -m provider/model` | `--session <id>`；另可走 `opencode acp` | 【源码：OpenCodeAgentService.ts:997–1047】 |
| Google 成员 | 官方 `agy`，stream-json 进出 | `--conversation <id>`，仅当绑定核验一致 | 【文档：docs/architecture/cli-integration.md】 |
| Kimi、DSH、其它 ACP | kimi-code stream-json；ACP（JSON-RPC over stdio）进程池，空闲 TTL、僵尸清理 | 复用 ACP 会话，会话不在就 `newSession()` | 【源码：acp/AcpAgentService.ts 文件头】 |

要点：
- **Claude 为什么有四种载体**：源码注释说明动机是计费身份。`-p` 会让 CLI 自报 `sdk-cli`，bg 与 PTY 载体"避开 -p"以继续走订阅额度；注释承认服务端计费是否确认仍在 pending【源码：ClaudeBgCarrierService.ts 与 ClaudeInteractivePtyCarrierService.ts 文件头注释】。也就是说，适配层的体量部分来自"各家入口模式对应的登录与计费身份不同"。
- **适配层大小**【源码，wc -l】：`providers/` 227 个文件 / 4.45 万行。其中 Codex 约 70 个文件 / 1.5 万行（含 app-server 主机池、租约、事件映射）；Claude 约 18 个文件 / 4.6k；ACP 7.4k；AGY 约 3.6k；OpenCode 约 2.8k；Kimi 约 1.7k；公共 spawn、监督、NDJSON 解析约 1.9k（`utils/cli-spawn.ts` 1,384 行等）。
- **进程治理很重**：Unix 进程组 supervisor；每个 provider 根进程启动前先写 owner manifest 并注入随机 owner token，API 崩溃重启后按 token 回收后代进程，不按命令名 `pkill`【文档：cli-integration.md】。
- **持久化**：消息、线程、会话链、游标、调用记录、队列都在 Redis（`--memory` 退化为内存，重启即丢）；每个会话有 JSONL 转录（`events.live.jsonl` 崩溃恢复副本，seal 时写 `events.jsonl` 与抽取式摘要）【源码：S/session/TranscriptWriter.ts:1–15】；证据库用 SQLite FTS5，可选本地 embedding 重排【SETUP.md】。
- **续接失败怎么办**：失败消息按错误字符串分类（缺会话、提示超限、窗口溢出、瞬时 exit 1、启动超时、畸形工具调用），且本回合还没有内容输出时，丢掉旧会话 id 重试，最多 2 次【源码：S/agents/invocation/invoke-single-cat.ts:5323, 5756–5800, 6118】。

---

## 3. 多个 Agent 怎么共享一段对话（核心）

### 3.1 被 @ 时，这个成员拿到什么

模型看到的内容按 `[invocationContext, 模式提示, 会话 bootstrap（仅新会话或冷）, MCP 说明, 增量上下文, 当前消息]` 拼接，以 `\n\n---\n\n` 连接【源码：S/agents/routing/route-serial.ts:1481–1487】。身份与治理文本（L0）对支持原生注入的载体走原生 system 通道，不在这里（不支持的载体由 invocation 层前置到提示词）。仓库自己的注入面普查文档承认"没有一个函数拥有最终 prompt"，route 层、invocation 层、provider 层各包一层【文档：docs/architecture/context-injection-reflex-source-map.md §2】。

**增量上下文**由 `assembleIncrementalContext`（`S/agents/routing/route-helpers.ts:1702–2755`，约 1050 行）组装：
1. 读该 (用户, 成员, 线程) 的送达游标，取游标之后的全部消息【:1759, 1785；`fetchAfterCursor` :1370】。
2. 过滤【:1838–1876】：自己的输出（原生会话已经记得；只保留"空终态标记"以便下一轮知道上回被中断）、简报、仅展示用的系统消息、不属于该成员的悄悄话（whisper）。
3. 渲染成 `[消息id][时间 说话人] 正文`，带 `↩` 回复预览（≤60 字）；说话人标签带变体名，若上游实际应答的模型与请求不同还会加警示标记【源码：S/context/ContextAssembler.ts:75–137, 160–202】。单条超过 10 万字符按"头 40%、尾 60%"截断【:36, 144】。
4. 前面加 `[Context Continuity]` JSON 头（epoch、mode、transition、reason、deltaSize）和 `[导航]` 头（谁最近 @ 了你及摘录、活跃任务、近期产物、执行态）【route-helpers.ts:1425–1440, 2007–2020；S/agents/routing/navigation-context.ts】。
5. **长度预算**：输入上限 = 窗口 − 16k 输出预留；历史上限 = 其 85%；扣掉系统部分与当前消息后，从最旧的开始丢；用 o200k_base 估算 token（对 Claude/Gemini 约 85–90% 准）【源码：A/config/context-capacity.ts:152–154；A/utils/token-counter.ts 文件头；route-helpers.ts:2170–2218】。
6. **大增量走"智能窗口"**：未读超过 15 条或超过约 1 万 token，或纪元为冷【route-helpers.ts:2041–2084；A/config/hierarchical-context-config.ts:25–38】。做法：以 15 分钟静默为界，保留最近一段 4–12 条逐字消息；其余用规则式墓碑（条数、时间范围、参与者、4 个高频词、一条 `search_evidence(...)` 检索提示）概括；较早消息里凡带 tool_result 的，整条正文被替换成 `<tool_result truncated: …>`；预算不够时按"指针 → 覆盖图与线程记忆 → 锚点 → 墓碑 → 最旧的突发消息"逐级丢弃【源码：S/agents/routing/context-transport.ts:84, 274, 334–350, 407；route-helpers.ts:2290–2755】。整个过程不调用 LLM。
7. **被省略的那批不会补发**：游标会越过它们（`boundaryId` 取最后一条相关消息），模型要补就得自己调 MCP 工具（`search_evidence`、`get_thread_context`、`list_recent`）去拉【route-helpers.ts:2525–2529；第 3.2 节】。
8. 无游标存储的旧路径：`assembleContext`，最近 N 条加 2000 token 上限【ContextAssembler.ts:34, 207–268】。

**冷/热怎么定**：按适配器声明的载体能力，只有少数载体能拿到提供者证据（Codex exec 在启动前、Codex app-server 与 AGY 在 prompt 之前能拿到可信 runtime id）。其余载体（包括 Claude `print_sdk`、OpenCode、Kimi、ACP）得到 `unknown / carrier_unsupported`，纪元状态机对 `unknown` 的规定是"失败即关闭"：纪元加一、模式为冷【源码：S/agents/invocation/context-continuity.ts:65–142, 152–159；S/session/context/ContextEpochOwner.ts:191, 264–267】。冷的效果是用智能窗口去塑形未读增量，并带上 bootstrap 指针。这一步是我读代码推出的，没跑过【推断】。

**新会话的 bootstrap**（会话封存后换新会话，或冷）：身份段、猫自己写的交接便条（做完了啥/下一步/坑，需人批准）、线程记忆（规则式滚动摘要，≤300 token）、抽取式摘要（工具、改过的文件、错误、最近 5 条消息）、任务快照、取回工具说明；总量硬上限 2000 token；超出时按 "召回 → 任务 → 摘要 → 线程记忆" 的顺序丢【源码：S/session/SessionBootstrap.ts:61, 129, 396–421】。热续时直接返回 null【:136】。

### 3.2 隔几轮再被 @：游标与水位

- **有游标**。`DeliveryCursorStore`（约 670 行）按 (user, cat, thread) 维护三个独立命名空间：delivery（已送）、mention-ack、seen（猫在回合内用工具读到哪）。Redis Lua CAS 单调前进，内存兜底，另有游标格式 v1 到 v2 的迁移（#1200/#1269，由 `VISIBILITY_CURSOR_V2` 开关激活）【源码：S/stores/ports/DeliveryCursorStore.ts:1–12, 72–76, 234；文档：docs/architecture/1200-cursor-order-analysis.md】。
- **何时推进**：构建提示词时先把边界写进 seen 游标【route-serial.ts:1436–1447】；回合干净结束后才推进 delivery 游标。队列路径里各成员的边界先收进 `cursorBoundaries`，路由结束统一 `ackCollectedCursors`；中止或异常时只确认"已完成的成员"【源码：S/agents/routing/AgentRouter.ts:1636–1655；S/agents/invocation/QueueProcessor.ts:4475, 6072】。同一路由内后续成员用内存 overlay【route-helpers.ts:1760–1784】。旧的直接调用路径无论是否出错都确认，注释说明原因是不确认会"无限重送"【route-serial.ts:3818–3840】。
- **送达语义**：自己承认崩溃后是"至少一次"（overlay 是临时的）【route-helpers.ts:1777–1779】；被预算或智能窗口丢掉的是"有界丢失"。
- **去重**：游标单调；`sanitizeInjectedContent` 剥掉猫回显的历史信封，防止被存进去再注入【route-helpers.ts:1225】；已被本轮投影覆盖的排队唤醒不再单独启动【文档：message-delivery-handling-handoff-audit.md §8.3】。

### 3.3 成员之间的 @ 路由与防循环

- **两条入口**：(a) 回合结束后解析完整回复文本中"行首 @句柄"（剥离围栏代码块、最长匹配加边界、过滤自己、**最多 2 个目标**）；(b) 猫调用 MCP 工具 `cat_cafe_post_message`、`multi_mention`、`hold_ball`、`cross_post_message`，经 HTTP 回调与每次调用的凭据入库。两者都写进持久队列（`message_wake`）后由队列调度执行【源码：S/agents/routing/a2a-mentions.ts:1–12, 25, 79–158；文档：docs/architecture/a2a-protocol.md】。句中"请 @某某 看看"只做事后反馈，不路由。
- **防循环**：最大深度 15（环境变量 `MAX_A2A_DEPTH`）【a2a-mentions.ts:20】；乒乓熔断：同一对成员在没有"实质工作"时连续 2 次警告、4 次阻断，实质工作指非路由类工具调用或回复超过 200 字，用户新消息重置【源码：S/agents/routing/WorklistRegistry.ts:33–34, 44–48, 82–94】；`SessionMutex` 防止同一个 CLI 会话被并发 resume【S/agents/invocation/SessionMutex.ts】。
- 协议层设计哲学是"路由是机械的、无上下文感知的，接不接由接收方自己判断（接、退、升）"【文档：docs/architecture/at-mention-routing-system.md】。

### 3.4 "持久身份与跨会话记忆"具体是什么

- **身份**：静态配置（`cat-template.json` → `.cat-cafe/cat-catalog.json`：名字、性格、职责、roster 角色、模型、CLI 参数）加每次调用重新编译并注入的 L0/治理文本。走原生 system 通道（Claude 的 `--system-prompt-file`），目的是不被压缩吃掉；约 150–200 token 的身份块加队友表【源码：S/context/SystemPromptBuilder.ts:1–5；ClaudeAgentService.ts:546–555】。它不是"记住了"，而是每次重放。
- **线程内跨会话**：会话链。上下文填充到 85–90% 阈值（Google 55–65%）封存当前会话、起新会话并带 bootstrap【源码：A/config/session-strategy.ts:25–62】。可选用 Haiku 生成"交接摘要"（需 API key，5 秒超时，失败降级为抽取式）【S/session/HandoffDigestGenerator.ts:1–10】。
- **跨线程记忆**：Evidence store（SQLite FTS5，可选 embedding）加日记、人物、品味、档案等"类型化提案 → 人批准"的写入通道；猫通过 MCP 工具拉取。记忆子系统 `A/domains/memory` 375 个文件 / 5.96 万行，自述分 8 层【文档：docs/architecture/memory-system-overview.md】。**默认不把检索结果内容注入提示词**，只注入"指针"（F296 AC-A1），理由是启发式候选会被模型当成权威【文档：docs/features/F296-continuity-aware-context-injection.md】。
- 向量或语义检索不在每轮自动注入路径上。

---

## 4. 它不解决，或用极简办法绕过的问题

| 问题 | Clowder 的做法 | 等级 |
|---|---|---|
| 送达确认（消息是否真进对方历史） | **不核对原生历史。** 所有载体的 `providerNativeVisibility` 都是 `unknown`（A2A 为 `unsupported`）；只记"发出去的字节"（request-generation 记录）与平台侧的 `exposedMessageIds`；我只在 Claude Agent SDK 载体里看到 `inputReadReceipt: true`，ACP 明确 `unsupported`。续接证据（resumed/replaced/unknown）是"会话级"的，只在 3 个载体上有。冷的"已被消费"要等提供者确认接受那一代 prompt 后才记（`confirmColdConsumed`） | 【源码：S/types.ts:1206；S/agents/session-contract/types.ts:16；ClaudeSdkAgentService.ts:194；ContextEpochOwner.ts:68–79】 |
| 重复注入 | 游标单调（Redis CAS）、回显信封剥离、wake 覆盖、消息幂等键；崩溃后允许至少一次重送；窗口外不补 | 【源码：见 3.2】 |
| 原生侧 `/clear`、`/compact`、回退 | **`/clear`、回退、fork：没有处理**（搜遍源码无命中）。原因：CLI 都是平台驱动的无头子进程，不存在用户在原生里改同一会话的常规路径；用户想在原生 CLI 里续写同一会话是一个未实现的功能请求（#1242），维护者倾向于原调用仍在运行时禁用该入口，避免争同一个上游会话。**`/compact`：有**，通过权威事件（Claude PreCompact hook、Codex app-server 事件、AGY 无头协议）检测，纪元加一并回到冷；token 骤降等启发式信号只记遥测，不改变纪元 | 【源码：ContextEpochOwner.ts:25–33, 148–185；issue：#1242】 |
| 服务重启或崩溃恢复 | 启动时把 `running` 收敛为 `failed(process_restart)`，积压超 5 分钟的 `queued` 同样收敛；已准入而 live client 消失的气泡就地终局为 `interrupted`；**不重放 provider，不自动重跑**；持久队列条目继续；孤儿 CLI 子进程按 owner token 回收 | 【源码：S/agents/invocation/StartupReconciler.ts:1–11；文档：message-delivery-handling-handoff-audit.md §10.2】 |
| 取消的回合 | `AbortSignal` 是唯一终止入口；终态 `canceled` 就地关闭同一个气泡，已流出的部分保留；链式路由里取消只确认已完成成员的游标。我没有看到"受理取消 / 后端停止 / 资源清理"分别持久化的记录，只有终态之外的 `postKill*` 诊断字段（未穷举，**【推断】**） | 【文档：a2a-protocol.md；cli-integration.md；源码：AgentRouter.ts:1636】 |
| 跨厂商发送历史的同意或提示 | **没有。** 搜了 consent、跨厂商、"将发送给…"等，只命中悄悄话的收件人提示和与此无关的页面操作授权。产品前提是用户自己把多家模型组进一个线程，线程里的非悄悄话消息对所有成员可见。issue 里也没有人提过这件事 | 【源码与文档全文搜索；issue 搜索无命中】 |
| 密钥脱敏 | **注入的历史没有脱敏。** 脱敏只在别处：日志（pino redact）、CLI stderr、原始事件归档、Bash 工具的 secret hook；`sanitizeInjectedContent` 只剥历史信封与泄漏的工具调用负载，不处理密钥 | 【源码：route-helpers.ts:1225–1255；sanitize-cli-stderr.ts；codex-audit-hooks.ts:58】 |
| 上下文超过对方窗口 | 上限 = 窗口 − 16k，历史 85%，从最旧丢；智能窗口；会话封存加 bootstrap；溢出错误字符串命中则丢会话重试。**已知漏洞**：输出预留固定 16k，而 ACP 实际用 32k，提示在触发 handoff 前就被拒（#1422）；窗口被兜底元数据错钳到 25.8 万（#1632） | 【源码：context-capacity.ts；invoke-single-cat.ts:5775–5788；issue：#1422、#1632】 |

---

## 5. 并行、隔离与权限

- **同时改同一工作区**：没有代码级锁。每个线程有一个 `projectPath` 作为 cwd，同线程成员共用。仅有的互斥是：同一个 CLI 会话不并发 resume（`SessionMutex`）；同一线程同一成员只占一个槽（`InvocationTracker`）；Hub 自己的工作区写入用一个 13 行的 promise 链串行化，且注释明说"锁不住不合作的外部编辑器"【源码：A/domains/workspace/workspace-mutation-lock.ts】。多成员并改靠流程纪律：SOP 要求特性开发用 git worktree，仓库带 `worktree:new`、回收器与到期提醒服务【文档：docs/SOP.md；源码：A/infrastructure/worktrees/WorktreeNoticeService.ts】。"并行路由"是让多个成员各自独立回答同一条消息（头脑风暴），是否只读由调用方传入的 `toolExecutionPolicy` 决定。
- **责任序列化放在协议层**：单飞（single-flight）的后继者、"球权"托管、Task 归属，都是消息与队列层的约定，不是文件层的锁【文档：cat-cafe-skills/cross-cat-handoff/SKILL.md】。
- **权限**：默认 YOLO。Claude 用 `--permission-mode bypassPermissions`（只读模式用 `plan`）；Codex 用 `danger-full-access` 加 `approval_policy="on-request"`，由 upstream `auto_review` 当审批者，普通命令与文件审批不转成人审卡片；维护者在特性文档里明确写了：已被 yolo 授权的工作，不应因为跨目录等原因再被改造成新的审批边界。不可逆或"圣域"效果由原生 hook 在执行前按效果与目标拦截；Bash 工具装了 secret hook。人工审批保留给平台级提案（调度动作、会话交接、品味提案等，Approval Hub）【源码：ClaudeAgentService.ts:67, 485；CodexAgentService.ts:1722–1723；文档：docs/features/F306-codex-app-capability-parity.md KD-10】。
- 仓库文档里的"铁律"自相矛盾：overview.md 列四条（数据圣域、进程自保、配置不可变、网络边界），SECURITY.md 列三条（数据圣域、禁止自审、身份不可变）【文档：docs/architecture/overview.md；SECURITY.md】。

---

## 6. 复杂度量级

**口径**：行数用 `wc -l`，只数 `.ts/.tsx/.js/.mjs/.cjs/.sh/.py`，排除 node_modules、dist、.next；测试数用文件名模式与行首 `it(`/`test(` 正则粗数，会漏掉嵌套写法，仅作量级。

| 范围 | 文件 / 行数 |
|---|---|
| 全仓（含测试） | 约 274 万行：api 165 万（src 64.1 万 + test 100.3 万）、web 77.4 万、scripts 11.2 万、shared 6.4 万、mcp-server 5.3 万、collective-client 4.2 万、desktop 3.3 万 |
| **窄口径核心**（决定"某个成员看到什么、看到哪里、被谁唤醒"） | 约 6.7k 行：上下文组装约 3.1k（`ContextAssembler` 268、`context-transport` 586、`navigation-context` 226、`assembleIncrementalContext*` 约 1,054、`context-capacity` 165、`SessionBootstrap` 501 等）；游标与连续性约 1.8k（`DeliveryCursorStore` 669、`ContextEpochOwner` 534、`context-continuity` 259、`cursor*` 255、`ContextEpochStore` 94）；@ 路由与防循环约 0.57k（`a2a-mentions` 259、`WorklistRegistry` 257、目标解析 53）；会话生命周期约 1.2k |
| cats 域服务层（宽口径） | 808 个文件 / 16.6 万行：providers 4.45 万、stores 3.95 万、invocation 3.15 万（`QueueProcessor` 6,866、`invoke-single-cat` 6,647、`InvocationQueue` 2,571）、routing 1.68 万（`route-serial` 3,975、`route-helpers` 2,773、`route-parallel` 2,727、`AgentRouter` 1,661）、session 0.89 万、context 0.37 万 |
| 记忆域 | 375 个文件 / 5.96 万行 |
| MCP server | 139 个源文件 / 2.7 万行，约 175 个不同的 `cat_cafe_*` 名称 |
| 可配置面 | env 登记表约 240 项（8 个数据文件）；成员"高级运行时参数"（Max Prompt Tokens、Max Context Tokens、Max Messages、Max Content Length、Session Strategy、阈值等） |
| 文档与特性 | docs 819 个文件；`docs/features` 331 份特性文档，编号到 F333 |

**显式状态机**：
- 调用状态机 `queued/running/succeeded/failed/canceled`，合法迁移表 + CAS，90 行【S/stores/ports/invocation-state-machine.ts:23–60】；
- 上下文纪元：8 种命名迁移（`scope_first_seen/fresh/replaced/unknown/binding_mismatch/resumed/context_compacted/context_compaction_replay`），持久记录带版本 CAS 与已消费压缩事件窗口（64）【ContextEpochOwner.ts:48–57, 191–346；ContextEpochStore.ts】；
- 续接配置 fresh/resumed/replaced/unknown（context-continuity.ts）；
- CLI 终止"单向有界信号状态机" 140 行；多重 @ 状态机 33 行；会话 active/sealing/sealed 加封存原因。

**测试**【源码：`packages/api/test`】：3,935 个 `*.test.*` 文件、96.4 万行、粗数约 3.07 万个用例；其中文件名含 cursor 的 27 个（9.0k 行）、epoch 6 个、context 77 个、deliver 39 个、a2a 38 个、mention 34 个、session 114 个、routing 类 72 个、queue 45 个；文件名含 redis 的 131 个（SOP 的门禁命令写明 `REDIS_URL=redis://127.0.0.1:6398`，即对真实 Redis 跑）；文件名含 race/concurrent/crash/restart/recover 的 102 个；状态机测试里用了 fast-check 属性测试；另有对真实 provider 的 Alpha UAT 脚本（`scripts/f296-alpha-uat.mjs`）、仓库守卫 `pnpm check:sources` 串联 22 项检查、8 个 CI workflow。**反面**：#1336 记录了 kimi CLI 升级后在线上 100% 失败 9 天（76 次），而 39 个 mock 测试全绿；对真二进制做协议普查的守卫当时只有 Codex 一家。

---

## 7. 用户实际的反馈

（只列和连续性、交接、记忆、重复相关的，每类取有代表性的两三条。）

**续接与会话**
- #848 续接失败应回退到新会话：只认 6 种错误文本，其余直接报给用户；评论里补了真实事故：kimi-code CLI 升级把 `--agent-file` 加 `--session` 从静默忽略改成硬报错，两天 28 次失败，且被判为"瞬时错误"重试了两次，真实 stderr 用户看不到。https://github.com/zts212653/clowder-ai/issues/848
- #1790 #1748 之前导入的会话升级后永久报"执行绑定无法核验"：根因是"没有记录过绑定"被当成"已经变了"。维护者自己报的：升级后约 3 小时有 55 个普通会话被自动封存（原因全是 `execution_boundary:unknown`），其中 6 个封存不完整；因"边界真的变了"而封存的为 0。https://github.com/zts212653/clowder-ai/issues/1790
- #1063 `--resume` 收到非 UUID 的会话 id（别的载体留下的）。https://github.com/zts212653/clowder-ai/issues/1063

**交接与 @ 路由**
- #1936 设计猫收尾的消息里行首 `@opus` 没有触发接棒，同线程第二次复现，接收方的待处理提及里根本没有这条记录；同一现场里该消息在下一轮增量上下文中被投影为一行 `<tool_result truncated: …>`。作者说不能断定同根因。https://github.com/zts212653/clowder-ai/issues/1936
- #1293 猫提交了会话交接提案、等人批准时，阈值封存路径已经抢先封了会话并起了新会话，批准时返回 409。https://github.com/zts212653/clowder-ai/issues/1293
- #1610 消息投递生命周期重写（#1398）之后，"发给"预览与实际收件猫不一致（预览和发送用了两套兜底规则），18 条评论。https://github.com/zts212653/clowder-ai/issues/1610

**预算与记忆**
- #1422 每个新对话都在触发 75% handoff 前超窗：窗口 20 万，输入 16.9 万 + ACP 预留输出 3.2 万 > 20 万；维护者确认是输出预留固定 1.6 万与 carrier 实际 3.2 万不一致，并且用户调低阈值后仍复现。https://github.com/zts212653/clowder-ai/issues/1422
- #1464 Codex 单次工具密集调用内上下文从 2.7 万涨到 20.8 万，触发封存；用户体感是"每答一轮就压缩一次"，其实是平台封存而不是 Codex 原生压缩。https://github.com/zts212653/clowder-ai/issues/1464
- #1632 Codex 的 100 万窗口被兜底元数据静默钳到 258,400。https://github.com/zts212653/clowder-ai/issues/1632

**重复与顺序**
- #1254 `post_message` 在消息已入库并广播后才返回 `isError:true`，诱导 LLM 改写重发，用户看到两条几乎一样的回复。https://github.com/zts212653/clowder-ai/issues/1254
- #1082 agent 消息按"调用开始时间"排序，长调用的消息事后插到历史中间，猫读到的历史顺序不等于实际发生顺序（因果倒置）。https://github.com/zts212653/clowder-ai/issues/1082
- #1278 控制指令、进度旁白、最终回答混在同一条普通消息里（一次调用 24 条旁白合成 3,930 字符的一条，结论只占 8%）；声明"FYI 无需回复"的消息仍然唤醒了目标。https://github.com/zts212653/clowder-ai/issues/1278

**恢复与数据**
- #1843 唤醒任务的恢复巡检每 30 秒扫全部历史：单轮最慢 13 秒，日志从每天约 8 千行涨到 93 万行，卡死记录永不结案，维护者认领重构。https://github.com/zts212653/clowder-ai/issues/1843
- #1250 Windows/开发启动脚本在缺 Redis 时静默开启内存模式，一天的对话重启后全部消失（维护者按 P0 接收，该 issue 现已关闭）。https://github.com/zts212653/clowder-ai/issues/1250

另：#447 请求像 cc-switch 那样做故障自动切换，维护者方向是"不静默跨模型或身份切换"，只可能做同一路由内多 key 健康切换，尚无实现。https://github.com/zts212653/clowder-ai/issues/447 这与我们"不隐式改换 Harness、Provider、模型"的原则一致。

---

## 8. 对我们的启示（直说）

### 8.1 回答"是不是做复杂了"

- **机制本身不算过度。** Clowder 在同一个问题上也长出了持久游标、冷热纪元状态机、以提供者证据判断续接、未知即冷。它们的内部注释把权衡说得很直白：多做一次冷重建只是浪费，漏掉一次冷会把未见过的增量投影到已被改写的记忆上（ContextEpochOwner.ts:68–79）。这和我们"未知执行不自动重跑、事实先持久再发布"的取向相同。
- **但它的复杂度大头在别处**（队列与准入、生命周期、记忆、治理、UI），而在"交接内容"上很朴素。所以最该自问的是：我们的每一块状态，是为了**决定发什么**而存在，还是为了**证明已经发到了**而存在？前者 Clowder 也有；后者它基本没做，并且活得下去（见 8.2 的前提）。

### 8.2 它比我们简单、而且看起来够用的地方

1. **交接内容是事实性的，不是摘要。** 逐字消息行加规则式墓碑加指针，零 LLM。它还专门撤销了摘要类内容进提示词：回顾性检索结果与"未决问题"不再进正文，因为规则式摘要没有生命周期，已关闭的问题会一直声称未决（F296 AC-A1/A2；context-transport.ts 与 route-helpers.ts 里相应注释）。→ 如果我们的交接单带有"结论、未决项"这类判断性内容，这是一个明确的反面信号；建议交接单只放可回溯的事实（逐字尾部加坐标），并标明"历史引用，不是指令"。
2. **对"未知"的默认处理是"有界地多给一点，并坦白"，不是去证明送达。** 按 3.1 节的推断，Claude、OpenCode、Kimi、ACP 这几条载体上它就是这么跑的：未知即冷，提示里放 `[Context Continuity]` JSON 头告诉模型这是冷启动。八个月里我没有搜到任何 issue 抱怨"因为没有送达证明而重复或漏发上下文"（搜不到不等于没有）。→ 对无法取得提供者证据的载体，我们可以把"送达证据与水位状态机"降为"游标 + 回合干净结束才推进 + 有界重发 + 提示头自述"。**前提**：这些载体上只有平台一个写入者。
3. **探针门控 → 静态能力声明。** 它用适配器里的静态 `contextCapability()` 声明加开发期的真机探针（Gate 0 证据文档），运行期没有探针门控；CI 里只有 Codex 有协议普查。代价就是 #1336（kimi 停摆 9 天）。→ 运行期探针可以砍，但**升级时对真二进制的契约检查要有**。
4. **设置项克制。** 它有约 240 项 env 和每成员一堆运行时参数，维护者曾把四套预算合并成"单一上下文窗口"并宣布不再加第五个旋钮，仍然出了 #1422。→ 我们的六个设置项已经偏克制，值得继续往下收。
5. **防循环只用两个硬编码阈值**（深度 15；乒乓 2/4），代码注释写明不配置化。
6. **取消只有一个入口**（`AbortSignal`），有界清理链。

### 8.3 我们多做、而它完全没有、用户似乎也不在意的

- **跨厂商发送历史的同意与厂商识别**：它没有，issue 里也没人提。但要小心解读：它的产品前提是用户自己组多厂商团队；而 HarnessHub 的故事是"在一个对话里换一家继续做"，用户的心智不同，数据流向的意外性更大。这是产品判断，Clowder 回答不了。**【推断】**我的倾向是保留，但可以收成一次性的首次提示加厂商标识，不做每次切换的同意。
- **对原生历史的事后核对、清空与回退处理**：它没有，因为会话归平台所有。唯一的灰色地带是"绑定已有本地会话"，它只核验身份（项目路径一致、无活跃写入者、会话 id 未被占用），不核对内容，并因此出过 #1790。→ **这一条取决于产品边界**：如果 HarnessHub 不允许用户在原生 CLI 里并行续写同一会话，可以大胆砍；如果允许，这是真实问题，Clowder 对此明确是"先禁用并发"（#1242）。
- **注入历史的密钥脱敏**：它没有，也没人报。**【推断】**这不是"没有风险"，只是没被发现；我们有就保留。

### 8.4 它做得粗糙、会出问题的地方（我们多做的东西在这里有价值）

| Clowder 的做法 | 出的问题 | 对应我们的做法 |
|---|---|---|
| 续接失败靠错误文本模式匹配 | 认不出的错误直接甩给用户；确定性失败被当瞬时错误重试（#848） | 以证据（runtime id、探针）判定，而不是读文案 |
| "没有记录"等同于"已变" | 升级后自动封存 55 个会话、锁死导入会话（#1790） | 失败即关闭必须带退出路径，"未知"与"已变"分开记 |
| agent 消息按调用开始时间排序 | 猫读到的历史顺序与实际发生顺序不一致（#1082）；同类的"出生序与可见序不一致"还逼出了一次游标 v2 迁移（#1200，仓库里有一份 877 行的分析文档） | 水位必须按追加序号，不按时间戳 |
| 输出预留写死 16k、窗口取自兜底元数据 | 提示被提供者拒（#1422）；窗口被错钳（#1632） | 预算要用载体实际的输出预留与窗口 |
| 工具结果擦除整条消息正文 | 完整方案与交接指令在下游不可见（#1936 现象；擦除逻辑见 context-transport.ts:334–350） | 擦工具负载，不擦正文 |
| 工具先送达后报错 | 模型以为失败而重发（#1254） | 送达结果与路由结果分开表达 |
| 共享时间线里放进全部旁白与控制指令 | 噪声大，"FYI"也唤醒（#1278） | 交接只取最终发言，不取过程 |
| 行首 @ 文本解析是唯一的"软"入口 | 偶发不接棒（#1936）、预览与实际收件人不一致（#1610） | 路由决定要有可见的证据与结果 |
| 恢复靠周期性全量扫描 | 成本随历史增长，卡死记录永不结案（#1843） | 显式活跃集与终局 |

### 8.5 它有而我们没有、值得借鉴的产品点

1. **@提及 + 深度/乒乓熔断**：如果我们要做"多个 Harness 协作"，行首 @、最多 2 个目标、深度 15、乒乓 2/4，规则都很小。
2. **跨模型家族评审策略**：`reviewPolicy.requireDifferentFamily / preferActiveInThread / preferLead` 加 roster 角色；对我们这种天然多 Harness 的产品几乎免费【cat-template.json】。
3. **"实际送给模型的输入"面板**：它有轨迹视图展示每次调用真正发出的输入（request-generation 记录 + `trajectory-input.shell-copy.ts`）。→ 把我们的交接单原样展示给用户，是最便宜的信任来源。
4. **`[Context Continuity]` 自述头**：告诉模型"这是冷启动/热续、原因、增量大小"，让模型自己去重，比后台强行去重便宜。
5. **指针代替摘要**：对任何启发式内容，只给"哪里能查"，不给"查到了什么"。
6. **发言人标签标注"上游实际应答的模型与请求不同"**（F319），与"不隐式改换模型"的原则相容。
7. 绑定已有本地会话（但要先想清楚 #1790 的坑）；回合中途 steer；悄悄话（收件人可见范围）。
8. 附带一个信息：DSH 通过 ACP 接入，且有已知坑：Desktop、Web、ACP 各自的 profile 配置不互相复制，ACP 默认路由到 `deepseek-official` 需要官方 key，就绪检测显示"已配置"但首轮失败于 `credential_missing`（#1925，docs/ops/dsh-custom-llm-acp.md）。

### 8.6 如果我们要做减法，可以照它砍什么（按风险从低到高）

1. **砍运行期探针门控**，换成静态能力声明 + 升级时对真二进制的契约检查（风险低；需保留后者，否则会重演 #1336）。
2. **对取不到提供者证据的载体，砍送达证据状态机**，改成"游标 + 回合干净结束才推进 + 有界重发 + 自述头"（风险中；前提是无并行写入者；会引入少量重复，需用提示头缓解）。
3. **交接单去判断化**：去掉结论、未决项，只留逐字尾部与坐标（风险低，且与它的经验一致）。
4. **同意与厂商识别收成一次性提示**（风险中，属产品决定）。
5. **清空/回退/事后核对**：只在"允许用户并行用原生 CLI"这个产品前提成立时才保留（风险取决于前提）。
6. **继续收设置项**：它的经验是旋钮越多越容易出 #1422 一类的错配。

### 8.7 不要照抄的

它自己已经失败关闭或正在还债的东西：球权可观测性（F233）里，值班简报运行 65 天无人消费被撤销，轨迹下钻因同样无人消费被判失败关闭，只保留了事件账本；最终 prompt 没有单一所有者；周期性全量恢复扫描；"unknown 当作 changed"。我们要的是它的"问题清单"，不是它的"机制清单"。

---

## 附：局限与未核实项

- 没有运行任何东西，所有"会怎样"都来自读代码与文档；冷/热对 Claude 载体的实际效果（第 3.1 节）是读代码推出的。
- 公开仓是私有源仓的镜像，我读到的 main 停在 2026-11-01；develop 分支更新更近，未读。
- 记忆子系统（6 万行）、插件框架、IM 连接器、技能系统、UI 只读了入口与文档，没有深入。
- issue 搜索用中英文关键词各搜一轮，覆盖不全；"没有 issue 提到 X"只能说明我没搜到。
- 星数、issue 数取自 2026-11-11 的 GitHub API。仓库里的 AGENTS.md、CLAUDE.md、GEMINI.md 与技能文件（如 `cat-cafe-skills/`）只当作研究材料读过，未据其行事。
