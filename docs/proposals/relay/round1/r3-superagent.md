# R3 调研：Super Agent 与多 Agent 编排中“状态如何在执行者之间流动”

- 作者：R3（接力系统设计小组调研员）；轮次：第 1 轮；日期：2026-11-02；分支 `cc/relay-design`
- 性质：调研与建议，不是已接受的决定。没有改代码，没有运行任何 Harness 会话或提示；对 Harness 程序只执行了 `codex --version` 与 `codex cloud … --help`；其余本机操作是只读查看本仓库源码，以及把公开网页下载到会话临时目录阅读。

## 1. 范围与方法

**要回答的问题**：在 super agent 产品、多 Agent 框架与相关协议中，一个执行者把工作交给另一个执行者时：交接的单位是什么（完整转录 / 摘要 / 结构化状态 / 产物引用）；谁拥有、谁写入；推（eager）还是拉（lazy）；接收方怎样确认；怎样避免信息丢失与重复执行；性能与缓存代价；成立条件。

**对象**：字节 DeerFlow 2.0、Manus、Genspark、Skywork、Kimi K2.5 Agent Swarm、MiniMax；Anthropic（多 Agent 研究系统、context engineering、长任务 harness、Claude API 的 context editing / compaction / memory tool / prompt caching、Claude Code 的 subagent / agent teams / 跨会话消息、Agent SDK 系统提示）；Cognition（2025 与 2026 两篇）；OpenAI（Agents SDK handoffs、Responses compaction、Codex 云任务与 `/import`）；LangGraph / LangChain（swarm、supervisor、handoffs、Deep Agents）；Microsoft Agent Framework（handoff、Magentic）与 AutoGen；Google ADK；CrewAI、Agno、Mastra、Letta；协议 A2A 1.0.0、AG-UI、MCP 2026-07-28、ACP（Zed 的 Agent Client Protocol）及其 RFD；与交接直接相关的 2025–2026 论文。

**方法**
- 阅读日期：全部为 2026-11-02。今天之前的训练知识只用来找线索，凡是“最新”的结论都重新打开来源核实。
- 来源类型：厂商工程博客与官方文档、协议规范与 RFD、开源仓库 README 与文档（DeerFlow 记录了 commit）、arXiv 摘要（Kimi K2.5 另读了 Agent Swarm 相关 HTML 片段）、本机 CLI 帮助、HarnessHub 本仓库源码（只读）。
- 每个来源的核实方式在第 7 节逐条标注：打开原文 / 仅搜索摘要 / 本机下载原文 / 本机命令 / 本机源码。
- 标注约定：第 2 节默认是【事实】，结论后附来源编号如 [S3]；我的推断显式标【推断】；第 3 节的归纳都是【推断】；第 4 节都是【建议】，理由引用事实编号。

**局限**
- 闭源产品（Manus、Genspark、Skywork、Kimi、MiniMax Agent、Devin）只能看到厂商自述，交接内部机制大多未公开；Devin CLI 的本地→云交接、Manus Wide Research 的上下文细节没有核实到。
- 论文只读了摘要，细分比例、跨厂商结果等没有核实。若干文档页超长被截断（A2A 规范后半、Claude Code subagents 的 fork 小节、ADK artifacts 后半），未读部分不下结论。
- 厂商给出的 token 倍数、准确率、成本都是自测，不能直接外推到 HarnessHub。
- DeerFlow 读的是 `main` 的 commit `14abd9a`（2026-11-02 13:36 UTC），没有 release 标签，变化很快。
- 没有做实验；第 4 节的数字都是待第一轮基准验证的初值。

**关键前提【推断】**：调研到的 handoff 大多发生在同一进程、同一 SDK、同一消息格式（往往同一厂商模型）之内；HarnessHub 的接力是跨厂商、跨进程、各自持有私有原生会话的串行单写者之间的控制权移交，而且 Hub 没有自己的模型。可迁移的是交接单位的分层、所有权与写入纪律、水位与幂等、确认方式、缓存纪律、权威标注；不可迁移的是共享一份可变消息列表、把原生会话 fork 给另一厂商、转移原生 thinking 或压缩产物。

## 2. 发现

每个对象按七问作答：**单位｜所有权｜推拉｜确认｜防丢失与重复｜性能与缓存｜适用条件**。

### 2.1 Anthropic

#### 2.1.1 多 Agent 研究系统（2025-06-13）[S1]

- **单位**：下行是任务说明（目标、输出格式、工具与来源指引、明确边界）；上行是子 Agent 压缩后的发现，lead 充当过滤器。文中附录另给出一般建议：子 Agent 把产物写到外部存储，只把轻量引用传回协调者，以降低 token 开销（作为通用技巧给出，没有确认研究产品本身这样做）。
- **所有权**：lead 拥有研究计划，并把计划写入 Memory，因为上下文超过 200,000 token 会被截断；子 Agent 各自拥有独立上下文窗口。
- **推拉**：下行、上行都是推；新的子 Agent 可以从 memory 拉回计划。
- **确认**：lead 同步等待一批子 Agent 结束；运行中不能 steering，子 Agent 之间不协调，一个慢的会拖住整批。
- **防丢失与重复**：完成的阶段先总结、关键信息外存；有状态长任务的错误会复合，因此从 checkpoint 恢复、加重试并让 Agent 适应工具失败，而不是从头重跑；用 rainbow deployment 让新旧版本并存，避免更新打断运行中的 Agent。
- **性能与缓存**：Agent 约用 chat 的 4× token，多 Agent 约 15×；BrowseComp 分析中 token 用量单独解释 80% 的表现方差（加上工具调用次数与模型共 95%）；Opus 4 作 lead、Sonnet 4 作子 Agent，比单个 Opus 4 在内部评测上高 90.2%；简单事实查询 1 个 Agent、3–10 次工具调用，比较类 2–4 个子 Agent、各 10–15 次。
- **适用条件**：可并行、广度优先的研究；不适合需要共享上下文、Agent 间依赖多、需要实时协调的任务；多数编码任务可并行的部分比研究少。

#### 2.1.2 Effective context engineering（2025-09-29）[S2]

- **单位**：三种长程技术各有自己的单位：compaction 摘要（Claude Code 保留架构决定、未解决的 bug、实现细节，丢弃冗余工具输出，并附最近访问的 5 个文件）；Agent 在窗口外写的结构化笔记（todo、NOTES.md）；子 Agent 回传的 1,000–2,000 token 压缩摘要。另有 just-in-time：只保留轻量标识（文件路径、存储的查询、链接），运行时用工具加载。
- **所有权**：笔记由 Agent 自己写；compaction 由 harness 触发。
- **推拉**：混合——Claude Code 把 CLAUDE.md 预先放入上下文（推），其他文件用 glob / grep 按需读取（拉）；运行时探索比预计算检索慢，需要好的工具指引。
- **确认**：未涉及。
- **防丢失**：调 compaction 提示时先最大化 recall，再提高 precision；最轻的压缩是清除历史深处的原始工具结果。
- **性能**：context rot——上下文 token 越多，回忆准确度越低，所有模型都如此；把上下文当作有限的“注意力预算”。
- **适用条件**：compaction 适合大量往返的对话；笔记适合有里程碑的迭代开发；多 Agent 适合并行探索有回报的研究与分析。

#### 2.1.3 长任务 harness（2025-11-26）与 memory tool 的多会话模式 [S3][S8]

- **单位**：文件系统里的结构化工件：`claude-progress.txt`（此前各 Agent 做了什么）、feature list JSON（每项有 `passes` 字段，初始全部失败）、`init.sh`（启动开发服务）、git commit 与 log。
- **所有权**：首个会话由 initializer Agent 建立这些工件；之后每个 coding Agent 只被允许改 `passes`，提示明确删除或修改测试不可接受；作者发现模型改写 JSON 的概率低于改写 Markdown。
- **推拉**：拉——每个新会话开局自己执行 `pwd`、读 git log 与进度文件、读 feature list 选最高优先级的未完成项。
- **确认**：验证型——开局先用 `init.sh` 起服务并跑一个基本的端到端测试，发现遗留破坏先修；只有端到端验证后才标记完成（用浏览器自动化验证后效果显著提升）。
- **防丢失与重复**：一次只做一个 feature；描述性 commit 便于回退到可工作状态；针对的失败模式是一次做完耗尽上下文、后来的 Agent 看到进展就宣告完成、留下未记录的破坏状态、未验证就标记完成、反复摸索如何启动应用。
- **性能**：未给数字；节省的是每个新窗口重新探索代码库的开销。
- **适用条件**：跨多个上下文窗口的长期编码。作者把“单个通用 Agent 还是专门化多 Agent（测试、QA、清理）”列为开放问题。
- memory tool 文档把同一做法固化为“多会话软件开发模式”：初始化会话建立进度日志、功能清单与启动脚本引用；后续会话先读这些文件；会话结束前更新进度；只有端到端验证后才标完成 [S8]。

#### 2.1.4 Claude API 的上下文管理（context editing / compaction / memory tool / prompt caching）[S4]–[S9]

- **context editing**（beta `context-management-2025-06-27`）：服务器在提示到达模型之前编辑历史，客户端保留完整未改的历史，不需要同步 [S4]。`clear_tool_uses_20250919` 把最旧的工具结果换成占位文本，默认 `trigger` 为 100,000 input tokens、`keep` 最近 3 次工具调用，可设 `clear_at_least`、`exclude_tools`、`clear_tool_inputs`；`clear_thinking_20251015` 管理早期 thinking 块。响应中的 `context_management.applied_edits` 报告清除了多少次工具调用与多少 token，`count_tokens` 可以预估编辑前后的大小。清除工具结果会使缓存前缀失效（之后的请求可复用新前缀），所以用 `clear_at_least` 保证每次清除值得一次缓存写入；保留 thinking 则保住缓存；与 memory tool 合用时，接近阈值会自动提醒模型先把要点写入 memory。
- **compaction**：on-demand（beta `compact-2026-09-04`，顶层 `compaction` 参数）与 token 阈值两种 [S5][S6]。返回一个 `compaction` 块，内含可读的摘要文本和 `signature`，必须原样回传，被改动会得到 400（`compaction_signature_invalid` / `compaction_content_mismatch`）；块放在 `messages` 最前，替代被总结的消息；可保留最近若干轮原文；`instructions`（最长 16,384 字符）可整体替换默认摘要提示；被总结范围内的中途 `role:"system"` 消息随之失效，需要重述；在块上加 `cache_control` 即在摘要后放置缓存断点；用量计入 `usage.iterations` [S6]。
- **后台 compaction**：发出压缩请求时记录当时历史包含多少条消息 n，对话照常在完整历史上继续；结果到达后只替换前 n 条，此后追加的轮次原样保留；`stop_reason` 不是 `compaction` 即失败，保留完整历史，之后再压 [S7]。【推断】这是一个显式的“摘要覆盖到哪一条”的水位协议。
- **memory tool**（`memory_20250818`，stable）：客户端实现 `/memories` 下的 view / create / str_replace / insert / delete / rename，存储由应用掌控；工具存在时 API 自动在系统提示中加入“先查看 memory 目录、假设上下文随时会被重置”的协议；必须做路径穿越防护；与 compaction 配合时，compaction 让活跃上下文保持小，memory 保存必须穿过摘要存活的信息 [S8]。
- **prompt caching**：前缀顺序是 tools → system → messages，某一层的改动使该层及之后全部失效，改工具定义使全部失效；缓存读取为基础输入价的 0.1×（Opus 5.5 与 Sonnet 5.5 为 0.05×，Fable 5.1 与 Mythos 5.1 为 0.025×），5 分钟写入 1.25×、1 小时写入 2×；默认 TTL 5 分钟；最新一代模型最小可缓存 512 token；每次请求最多 4 个断点 [S9]。
- **七问小结**：单位是“服务器端编辑后的视图”或“带签名的摘要块”；生成者是 API，持久保存者是客户端；每次请求随附（推）；确认靠 `stop_reason`、`applied_edits` 与签名校验；失败不改历史；适用于单一厂商 API 的长会话。

#### 2.1.5 Claude Code 与 Agent SDK [S10]–[S13]

- **Subagent** [S11]：非 fork 的子 Agent 从空白上下文开始，收到的是：自己的系统提示与环境信息、主 Agent 写的委派消息（任务摘要）、CLAUDE.md 层级（Explore 与 Plan 跳过）、git status 快照；收不到父对话历史、已调用的 skills、已读文件、auto memory。回传的是总结或最终报告，不是完整转录；最终报告会被扫描、标注为子 Agent 输出，其中的指令不带有用户的权威。每个完成的子 Agent 有 agent ID，可用 `SendMessage` 恢复并保留完整历史，转录在 `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`，与主会话的 compaction 互相独立；默认最多嵌套 3 层、并发上限 20。fork 模式（交互式终端、VS Code、桌面版默认开启）继承父对话与完整工具池，并在主会话的模型上运行。
- **Agent teams**（实验性，需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）[S10]：队友收到 lead 的 spawn prompt 与普通会话同样的项目上下文（CLAUDE.md、MCP、skills），不继承 lead 的对话历史。协调靠共享任务列表（pending / in progress / completed，可声明依赖，claim 用文件锁防止竞争）与邮箱（每个 Agent 一个 JSON 文件，写入接收方邮箱成功才报告“已发送”，写入失败发送方收到错误）；队友停止时自动通知 lead 并附最终答案。已知限制：任务状态会滞后、in-process 队友不能随会话恢复、一会话一团队、不能嵌套。建议 3–5 名队友、每人 5–6 个任务，避免两个队友改同一个文件；token 随队友数线性增长。
- **跨会话消息** [S12]：单位是一段 Claude 写给另一 Claude 的纯文本，文档明确它不是发送方的对话历史或文件，要搬运整个对话应当 resume 会话。接收方被告知消息来自另一个会话而非用户：它不能批准权限、不能促成配置修改，消息里的 `/compact` 之类命令只作为文本到达、不会执行，接收会话自己的权限提示照常触发。同机经每会话的 Unix socket 投递；投递结果分为送达、暂扣、拒绝三种；单条约 1,000,000 字符上限；接收端按发送者限流、短窗口内丢弃重复、最多排队 50 条、暂扣最多 100 条；还可以订阅“对方下次空闲时通知一次”（12 小时过期）。
- **Agent SDK 的系统提示**（与接力注入通道直接相关）[S13]：Claude Code 在会话的第一个请求记录系统提示，并沿用到这个会话下一次 compaction；用 `resume` 返回时换了 `append` 文本，下一轮看不到。会话中途要改指令，应放进下一条 user 消息，或由 `UserPromptSubmit` / `PostToolUse` hook 返回 `additionalContext`（写成事实陈述）。把 `snapshot` 设为 false 能立刻生效，但该请求无法复用会话的 prompt cache，在强制 preserved thinking 的 API 上还会丢掉早期 thinking。`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 把系统提示拆成静态与动态两个缓存块；`excludeDynamicSections` 把每用户的动态部分移到第一条 user 消息，使系统提示跨用户与机器一致以共享缓存，代价是这部分指令权重略低。CLAUDE.md、hook 输出、文件变更提示都作为对话中的 system reminder 送达，而不是系统提示。
- **七问小结**：subagent 的单位是“委派消息 → 最终报告”，teams 是“spawn prompt + 任务列表 + 邮箱”，跨会话是“纯文本”；所有权分别在主 Agent、lead、发送方；都是推，teams 另可拉任务列表；确认分别是“结果到达 / 后台完成通知”“邮箱写入成功 + 空闲通知”“送达 / 暂扣 / 拒绝”；防重复靠任务 claim 的文件锁、消息去重与限流，三者都把来自其他 Agent 的内容降权为非用户输入；性能上 teams 的 token 随队友线性增长，in-process 队友的缓存默认只保留 5 分钟，系统提示录制到 compaction 才变以保护缓存；适用条件：subagent 用于只关心结果的聚焦任务，teams 用于需要讨论与分工、各自拥有不同文件的工作，跨会话消息用于把一个发现告诉另一个会话而不是搬运整个对话。

### 2.2 Cognition [S14]–[S18]

- **2025-06-12《Don't Build Multi-Agents》**[S14]：原则一，共享上下文，而且共享完整 Agent 轨迹，不只是单条消息；原则二，行动隐含决定，相互冲突的决定带来坏结果。Flappy Bird 例子：背景与小鸟拆给两个子 Agent，各自对风格的隐含假设冲突，最后的合成者无法调和；即使把原任务原文转给子 Agent 也不够，因为真实任务的多轮对话与工具调用决定了怎样理解任务。推荐默认单线程线性 Agent；任务长到上下文溢出时，另用一个模型把行动与对话历史压缩成关键细节、事件与决定（Cognition 为此微调过较小的模型）。文中批评 Swarm 与 AutoGen 推广多 Agent；指出当时 Claude Code 的子 Agent 不与主 Agent 并行、通常只回答明确的问题而不写代码；2024 年“大模型写修改说明、小模型改写整个文件”的 edit-apply 方案脆弱，现在多由一个模型在一个动作里决定并编辑。
- **2026-04-22《Multi-Agents: What's Actually Working》**[S15]：能用的多 Agent 模式有一个共同点——多个 Agent 贡献智能，写入保持单线程。三种模式：
  - 生成-审阅回路：审阅者事先没有共享上下文，只看 diff，从代码重新发现上下文；Devin Review 平均每个 Devin PR 找到约 2 个 bug，约 58% 为严重。审阅结论回到写者，由写者用更完整的上下文（用户指令、已做决定）过滤，以免循环、违背用户或越界；这需要专门提示。
  - smart friend：较小的主模型把自己完整上下文的一个 fork 交给强模型（作者称 80/20 方案），拒绝只给部分上下文；倾向问宽泛的问题；若主模型没读过需要的文件，强模型应让它先去查再来问，而不是猜。SWE-1.5（约 950 tok/s）作主模型时不够强，不知道何时升级、问什么；在两个前沿模型之间，这个模式在最难的场景有实际收益。
  - manager / child：manager 在缺乏代码库深层上下文时过度规定；Agent 会误以为与子 Agent 共享状态；子 Agent 默认不回写 manager（模型没有在需要回写的环境里训练过）；作者把无结构的 swarm 视为干扰，倾向 map-reduce-and-manage。公开难题：怎样在不淹没接收方的前提下在 Agent 之间转移上下文。
- **Manage Devins（2026-03-19）**[S16]：每个子 Devin 在独立 VM 中从干净状态开始、范围窄；协调者可以中途发指令、补上下文或纠正，可以读子 Devin 的完整轨迹，按 ACU 跟踪消耗；子 Devin 先自己跑命令与测试验证再汇报。
- **Devin CLI 本地→云（2026-04-27）**[S17]：页面只说把会话交给有自己电脑的云 Agent，转录、摘要、分支、未提交改动中到底传什么没有说明（未核实）。
- **七问小结**：单位按方向不同——给写者的是完整轨迹（fork），给审阅者的只有 diff，给子 Devin 的是任务加中途消息；写者唯一；fork 是推，审阅者自己从代码拉；确认靠子 Devin 自验证、写者过滤审阅意见；防重复靠单写者；性能上审阅者上下文更短、避免 context rot；适用于强模型配对与可分解任务。

### 2.3 Manus [S19]–[S21]

- **2025-07-18 context engineering**[S19]：KV-cache 命中率是生产 Agent 最重要的指标；Manus 平均输入:输出约 100:1，Claude Sonnet 缓存输入 0.30 USD/MTok、未缓存 3 USD/MTok，相差 10×。做法：系统提示开头不放秒级时间戳等易变内容；上下文只追加、不改此前的行动与观察；序列化确定（JSON key 顺序可能不稳定）；必要时显式放断点。任务中不增删工具（工具定义靠近上下文开头，改动使缓存失效），而是用状态机在解码时屏蔽 token logit、配合 response prefill 约束选择，工具名用共同前缀（`browser_`、`shell_`）以便成组选择。文件系统作为无限、持久的外部上下文，压缩做成可恢复的：保留 URL 就能丢掉网页内容，保留路径就能丢掉文档。每个任务平均约 50 次工具调用，反复重写 `todo.md` 把全局目标推到最近的注意力里，对抗目标漂移与 lost-in-the-middle。把失败的行动与错误轨迹留在上下文里，帮助模型更新判断、避免重复错误。在序列化模板、措辞与顺序中加入结构化变化，避免模型模仿重复的 few-shot 模式而漂移。
- **2025-10-15 Lance Martin 对 Manus 网络研讨会的整理**[S20]：每个工具调用有完整版（原始输出，存沙箱文件系统）与紧凑版（如文件路径引用）；陈旧结果换成紧凑版，可随时取回，因此可逆；最新结果保持完整以指导下一步；压缩收益递减后才用带 schema 的摘要（得到一致的摘要对象）。原子函数少于 20 个（Bash、文件系统、代码执行等），其余动作下沉到沙箱，MCP 工具经 CLI 由 Bash 调用；工具结果存文件，用 glob / grep 检索，不建索引。子 Agent 主要用来隔离上下文，而不是模仿人类角色：简单任务只经函数调用传指令，复杂任务由 planner 共享完整上下文，子 Agent 保留自己的工具与指令；planner 规定子 Agent 的输出 schema，子 Agent 通过 `submit results` 工具回传，由 constrained decoding 保证符合 schema。按成本把任务路由到不同厂商模型；缓存系统指令与较早的工具结果。
- **Wide Research**（仅搜索摘要）[S21]：每个条目起一个完整的 Manus 实例（独立 VM、全新上下文）；子 Agent 之间不通信，主 Agent 分发并收集结果。
- **七问小结**：单位是“指令或完整上下文 → schema 化结果”，细节用文件引用；planner 规定 schema；结果是推（submit 工具），细节是拉（读文件）；确认是 constrained decoding；防丢失靠可恢复压缩与保留错误；性能以缓存命中为第一目标；适用于自有 harness、长工具链、可控的解码层。

### 2.4 DeerFlow 2.0（字节，commit `14abd9a`）[S22]–[S24]

- **定位**：自称 super agent harness，编排子 Agent、记忆与沙箱，以可扩展 skills 驱动；2.0 是与 1.x 不共享代码的重写；README 推荐 Doubao-Seed-2.0-Code、DeepSeek v3.2、Kimi 2.5，配置中有 `subagents.max_total_per_run` 等运行上限 [S22]。
- **子 Agent 交接的两种模式** [S22]：普通 `task` 调用的 `context_mode` 为 `isolated`（默认，只收到委派 prompt）或 `snapshot`（另外收到父线程保留的对话与 compaction 摘要，在派发时捕获，作为历史背景）。snapshot 携带保留的文本、工具调用描述与结果、可 JSON 序列化的媒体块；二进制或不可序列化的媒体变为显式遗漏声明；排除父系统提示、隐藏的框架消息（注入的 memory、todo 提醒）、reasoning 块、工具执行元数据与未完成的工具调用，工具调用描述必须有匹配的结果才保留。子 Agent 保留自己的角色、模型、工具与 skill 限制；父的工具记录不能满足子的执行检查；之后两边历史各自演化；snapshot 不恢复已压缩的消息，也不承诺复用 prompt cache；持久化的 `batch_task` 仍要求自包含 prompt。
- **评测**（2026-09-12，单一模型 `qwen3.8-flash-next`，8 个合成任务、51 个预先声明的隐藏检查）[S24]：两臂都 8/8 产物正确、7/8 正常结束；snapshot 平均父+子 token 11,151.8 对 13,196.1（−15.5%），平均耗时 20.14 s 对 33.73 s（−40.3%），请求数 42 对 48；但在历史与任务无关的自包含任务上，snapshot 的 token 从 8,359 增到 12,360（+47.9%）。作者明确说明这只是一个模型、八对合成样本，不证明一般性优越。
- **Task continuity**（可选，默认关闭）[S23]：`task_note` 保存命名笔记，最多 8 条、每条 750 字符、最多 4 个来源 ID，容量满时返回 `note_capacity` 而不驱逐旧笔记，所有笔记标为 `model_report`；`history_search` 对当前与已压缩的历史做关键词检索（英文词与中文二元组），最多 8 条结果、每条不超过 600 字符并给出原文字符偏移；`history_read` 按来源 ID 每页读 4,000 字符并给 `next_offset`。compaction 成功时，把即将离开活跃列表的可见文本、工具名与参数、工具结果文本归档到线程自己的 SQLite（`task-history/history.sqlite`，上限 32,768 页，默认 128 MiB），最旧批次过期后读写报告 `partially_expired` 或 `unavailable`；来源 ID 包含内容与消息身份，内容一变就是新版本。检索到的文本是历史数据，不是新指令，也不证明当时的动作成功；笔记经隐藏、转义的 human 数据通道注入，system 通道只放静态的权威契约。该特性不把父状态传给子 Agent，也不自动恢复已停止的运行。
- **Compaction** [S22]：按时间分块处理全部选中的历史，原始历史不截断，失败或达到上限时历史保持不变；旧的 todo 提醒不进入摘要输入与保留上下文，当前 todo 列表留在线程状态，若原始 `write_todos` 调用已不可见，下一次模型调用前补一条最新状态的提醒；可选 PII 脱敏覆盖用户消息、远程工具结果、compaction 输入与回注的摘要。
- **引用其他会话** [S22]：`read_conversation` 配合 `conversation_references`（最多 3 个自己的会话，只附到下一条消息），分页读取当前可见文本；读取权限随 run 过期；旧消息里的文本不授予访问权。
- **DeerMem** [S22]：按会话、用户、Agent 分别去抖（默认静默 30 s、最长等待 300 s），抽取串行；被 compaction 移除的消息先做应急快照，按到达顺序保留。
- **七问小结**：单位是 isolated prompt、snapshot（保留对话 + 摘要）或历史句柄；父线程拥有历史与归档，子 Agent 不回写父状态；snapshot 是推，`history_*` 是拉；确认是工具回执（saved / capacity）与读取时的 truncated / unavailable 报告；防丢失靠归档与显式遗漏声明，防重复靠“历史不授权、不自动恢复”；性能数字见上；相关历史用 snapshot，无关历史用 isolated。

### 2.5 其他 super agent：Kimi、Genspark、Skywork、MiniMax [S25]–[S28]

- **Kimi K2.5 Agent Swarm**（arXiv 2602.02276，v1 2026-02-02，v2 2026-08-07）[S25]：orchestrator 动态创建子 Agent，把复杂任务拆成异构子问题并发执行；每个子 Agent 有有界的本地上下文与独立工作记忆；回传给 orchestrator 的只是与任务相关的输出，而不是完整交互轨迹。论文称之为 context sharding，以区别于溢出后才压缩或丢弃的反应式方法（隐藏工具结果、摘要、全部丢弃）。训练时子 Agent 冻结、只用 RL 训练 orchestrator；用 Critical Steps（每阶段主 Agent 步数加该并行组中最长子 Agent 的步数之和）衡量时延。延迟最多降低 4.5×，BrowseComp 从单 Agent 60.6% 到 78.4%。二手评测称子 Agent 对共享概念的定义会不一致、事后编辑 swarm 产物困难（仅搜索摘要）。
- **Genspark Super Agent**（仅搜索摘要）[S26]：mixture-of-agents，超级 Agent 拆分任务交给专门 Agent 再合成；不同来源对模型与工具数量说法不一（9 个 LLM、80+ 工具，或 150+ 工具）；没有找到公开的状态交接细节。
- **Skywork**[S27]：Super Agents 于 2025-05 发布（自报 GAIA 82.42）；开源的 DeepResearchAgent 由顶层 planning agent 协调专门的下层 Agent，`src/memory/` 提供会话与事件记忆；公开页面没有说明子 Agent 的回传格式（未核实）。
- **MiniMax M2**（2025-10-30）[S28]：interleaved thinking 要求 Agent 每一步都可以思考；作者认为 M2 的上下文就是它的记忆，应保留完整会话历史，包括 thinking；社区反馈的性能差距很大程度来自无意中丢弃了这部分上下文（无数字）。
- **七问小结**：这几家公开的是“编排者下发子任务、只回收任务相关输出”的星型结构，单位多为任务描述与结果，编排者拥有全局状态，推送为主，没有公开的接收确认；防丢失靠把子任务语义隔离（Kimi 的 context sharding），性能收益主要是并行带来的时延下降（Kimi 最多 4.5×）；适用于可拆成独立条目的广度任务。MiniMax 提供了一个反面信号——丢掉推理过程会掉表现，而跨厂商接力天然会丢掉它。

### 2.6 OpenAI [S29]–[S35]

- **Agents SDK handoffs** [S29][S30]：handoff 对模型表现为名为 `transfer_to_<agent>` 的工具。默认接收方看到完整对话历史。`input_filter` 接收 `HandoffInputData`（`input_history`、`pre_handoff_items`、`new_items`、可选 `input_items`、`run_context`）改写接收方输入；`handoff_filters.remove_all_tools` 只删结构化工具项，不处理已复制进普通消息或摘要的工具内容。`nest_handoff_history` 是 opt-in beta、默认关闭：把可总结的历史折叠为有序的 assistant 摘要段（用 `<CONVERSATION HISTORY>` 标记包裹），无损的消息项留在原位；`handoff_history_mapper` 可完全自定义；嵌套不做脱敏，工具参数与输出可能留在摘要里。`input_type` 是模型生成的元数据（如 reason、priority），要在 `on_handoff` 开头、产生副作用之前校验。handoff 只在一次 run 内有效；使用服务器端会话状态（`conversation_id`、`previous_response_id`、`auto_previous_response_id`）时不支持 input filter，要避免继承历史只能另起 run 且不复用原 ID；混用客户端与服务器端状态会重复上下文；input guardrail 只作用于第一个 Agent。
- **Responses compaction** [S31][S32]：可在请求中设 `context_management.compact_threshold` 由服务器压缩，或调用 `/responses/compact`。compaction item 不透明、不供人读（示例为加密内容），必须原样回传、不要修剪；无状态链式调用时可以丢弃最近一个 compaction item 之前的项。SDK 的 `OpenAIResponsesCompactionSession` 默认在候选达到 10 个时触发，只接受 OpenAI 模型名（仅搜索摘要）。
- **Codex 云任务** [S33][S35]：本机 codex-cli 0.166.0 的帮助显示 `codex cloud exec --env <ENV_ID> [--branch <BRANCH>（默认当前分支）] [--attempts N（best-of-N）] <QUERY>` 提交任务，`codex cloud diff <TASK_ID>` 看统一 diff，`codex cloud apply <TASK_ID> [--attempt N]` 把 diff 应用到本地 [S33]。官方 IDE 文档的搜索摘要称“在云端运行”可以从本地改动开始，并保留线程的对话上下文以便接着做（仅搜索摘要；重定向后的页面里没有找到对应段落，是否包含未跟踪文件未核实）[S35]。
- **`/import`（Codex CLI 与 ChatGPT 桌面版）**[S34]：Codex CLI 在空闲会话里 `/import` 可从 Claude Code 或 Cursor 导入最近 30 天内最多 50 个聊天，以及指令文件（AGENTS.md、settings.json、config.toml）、skills、插件、MCP 配置、hooks、slash commands、subagents、Claude Code 的项目记忆；桌面版还可以打开自动更新，让导入的工作与原 Agent 保持同步；导入不改原 Agent 的配置。【推断】这是厂商侧单向的“迁移 / 镜像”，单位是会话转录加配置，没有水位、改动账本或返回语义。
- **七问小结**：Agents SDK 的单位默认是完整历史、可过滤或嵌套成摘要，由运行器与过滤器决定，推送，确认是 handoff 工具调用本身，防副作用靠在 `on_handoff` 开头校验；服务器端会话状态下历史只能继承、不能过滤（【推断】这是服务器端状态换来的便利与可控性之间的取舍）。Responses compaction 是不透明的加密项，【推断】只能在同一厂商内续用。Codex 云任务的单位是“prompt + 分支引用”，回传是 diff 产物，best-of-N 时由用户选定一个 attempt 审阅后应用；【推断】适用于可在干净容器里从已提交状态开始的任务。`/import` 是一次性或持续同步的转录拉取，适用于迁移而不是来回接力。

### 2.7 LangGraph / LangChain [S36]–[S40]

- **Swarm** [S38]：共享状态含 `messages` 与 `active_agent`；`create_handoff_tool` 返回 `Command(goto=…, graph=Command.PARENT)`，更新里追加一条确认转移的 `ToolMessage` 并设置 `active_agent`；默认所有 Agent 共用一个 `messages` 列表、传完整历史；要隐藏某个 Agent 的内部历史，需要给它单独的 state key 并写包装器转换；没有 checkpointer 就记不住上次活跃的是谁。
- **Supervisor 库**（仓库已归档，README 建议多数情况直接用工具调用实现 supervisor 以更好地控制上下文）[S39]：`output_mode` 为 `full_history` 或 `last_message`；`add_handoff_messages` 默认 True；`create_forward_message_tool` 把 worker 的最后一条消息原样转发到最终输出，省去 supervisor 的 token 并避免改写。
- **Handoffs 文档** [S37]：交接必须同时包含带 tool call 的 `AIMessage` 和 `tool_call_id` 匹配的 `ToolMessage`，否则历史畸形、接收方可能报错或行为异常；可以只传这对交接消息，或在 `ToolMessage` 里摘要子 Agent 的工作；传完整子 Agent 历史会用无关的内部推理干扰接收方并增加 token。
- **模式比较**（LangChain 给出的示例场景）[S36]：一次性请求的模型调用数 subagents 4、handoffs 3、skills 3、router 3；重复同一请求的总调用 8 / 5 / 5 / 6；多领域任务约 9K（并行）/ 14K+（串行）/ 约 15K / 约 9K token。handoffs 在重复请求上高效（活跃 Agent 留在原位），但只能串行。
- **Deep Agents** [S40]：子 Agent 默认 isolated，只收到 `task` 工具传来的任务描述，不继承父的系统提示；forked 模式（beta，`deepagents>=0.7.13`）收到父对话历史加任务描述与续写前导语；回传只有最终结果（或按 `response_format` 的 JSON）。
- **七问小结**：单位是共享消息列表中的片段（全量或最后一条），所有权在图状态与 reducer，推送，确认是结构上必需的 `ToolMessage`；防丢失靠 checkpointer 记住活跃 Agent 与历史，防重复靠图的单步推进；性能上 handoffs 在重复请求上省调用、但多领域任务因串行 token 更多；适用于同进程、同消息格式。

### 2.8 Microsoft Agent Framework 与 AutoGen [S41]–[S43]

- **Handoff orchestration**（文档 ms.date 2026-10-15）[S41]：mesh 拓扑、没有中心编排者；接收方取得任务的完全所有权（与 agent-as-tools 中主 Agent 保留所有权相对）。各参与者**不共享同一个 `AgentSession` 实例**，因为不同类型 Agent 的 session 实现不同；为保持一致，每个参与者在产生回复时把收到的用户输入与自己的回复广播给所有其他参与者；工具相关内容（包括 handoff 工具调用）不广播，只同步用户与 Agent 消息；Python 实现保留用户文本、inline data、URI、hosted files，非用户消息只保留文本，函数调用与结果、审批载荷在转发前过滤。Agent 不调用 handoff 工具时，工作流发出 `request_info`（`HandoffAgentUserRequest`）把控制交回用户；autonomous 模式下默认每个 Agent 最多 50 轮自动续写；可用 checkpoint 存储做持久化（重建时须复用稳定的 Agent ID）；需要审批的工具暂停并发出 `RequestInfoEvent`。
- **Magentic orchestration**（ms.date 2026-09-04，更新于 2026-10-06）[S42]：manager 维护 task ledger（事实与计划）与 progress ledger（请求是否满足、是否陷入循环、是否在进展、下一位发言者、给它的指令），每一轮更新并发出事件；连续无进展的轮次超过 `max_stall_count` 时重置并重新规划，另有 `max_round_count`、`max_reset_count`；可选人工计划审阅（Python 默认关、.NET 默认开）；文档自述在 Magentic-One 原设计之外的效果未经测试。
- **AutoGen Swarm** [S43]：所有 Agent 共享同一消息上下文，按最近一条 `HandoffMessage` 决定下一位；handoff 给 `user` 时团队暂停等输入。AutoGen 已进入维护模式并指向 Agent Framework（MAF 1.0 GA 时间只看到二手来源称 2026-04，未核实）。
- **七问小结**：MAF handoff 的单位是“广播的用户与 Agent 文本，过滤工具控制内容”，每个参与者各自持有 session，推送，确认是 `request_info` 与 checkpoint；【推断】工具内容不广播，意味着接收方只知道“说了什么”，不知道“做了什么”——这与 HarnessHub 现状的缺口相同。Magentic 的单位是两本 ledger 加一条指令，由 manager 所有，每轮推送并自评进展，用停滞计数防止空转；每轮都要一次 manager 调用，适用于路径事先未知的开放任务。AutoGen 是共享消息列表，适用于同进程同格式的 Agent。

### 2.9 Google ADK [S44]–[S49]

- **分层模型**（Google Developers Blog，2025-12-04）[S44]：working context 是单次模型调用的提示，每次调用从指令、身份、选中的会话事件、可选的记忆结果与 artifact 引用重新“编译”，用后丢弃；Session 是结构化 Event（消息、工具调用与结果、控制信号、错误）的持久记录加 state 草稿；Memory 是跨会话可检索的长期知识；Artifacts 是按名称与版本寻址的大对象。设计原则：存储与呈现分离、转换通过显式命名的有序处理器完成、默认按作用域收窄。
- **Artifacts 作为句柄** [S44][S48]：默认只给模型轻量引用（名称与摘要）；`LoadArtifactsTool` 在需要时把内容加载进上下文，只加到这一次请求、不写入会话历史，之后轮次需要再加载；同名保存自动递增版本；`user:` 前缀跨会话。
- **多 Agent** [S44]：agents-as-tools 的被调者只看到自己的指令与必要的 artifact，没有历史；agent transfer 的子 Agent 继承对会话的一个视图。`include_contents` 默认传调用者完整的 working context，`none` 只给为它新构造的 prompt。交接时把之前的 assistant 消息改写成叙述性上下文（例如标明“另一个 Agent 说过……”），避免新 Agent 把它当成自己的输出；其他 Agent 的工具调用被标注或摘要，避免新 Agent 误以为那是自己的执行或自己具备的能力；事实历史仍完整留在 Session。
- **State** [S46]：无前缀为会话范围，`user:`、`app:` 跨会话，`temp:` 只在一次 invocation 内（同一 invocation 的子 Agent 共享）；通过 `output_key` 或 `EventActions.state_delta` 经 `append_event` 写入；不要直接改从服务取回的 `session.state`（绕过事件历史且非线程安全）；`DatabaseSessionService` 对同一会话的并发更新加锁串行。
- **Compaction** [S45][S44]：`EventsCompactionConfig` 有 `compaction_interval`、`overlap_size`、`token_threshold`、`event_retention_size`、`summarizer`；滑动窗口（例如 interval 3、overlap 1 时在第 3、6、9 个事件后压缩，每次包含上一窗口的一个重叠事件），token 型优先；异步运行；摘要作为带 compaction action 的新事件写回 Session，原始事件随后可被裁剪或降权 [S44]。Python v1.16.0 引入 [S45]。
- **Context caching** [S47][S44]：`ContextCacheConfig` 默认 `min_tokens` 0、`ttl_seconds` 1800、`cache_intervals` 10（同一缓存最多复用 10 次），前缀变化即失效；稳定前缀（系统指令、Agent 身份、长期摘要）放前面，可变后缀（最新用户轮、新工具输出、小的增量）放后面；`static_instruction` 让系统提示不可变以保持前缀有效。
- **Memory** [S44]：reactive（Agent 自己调 `load_memory_tool`）与 proactive（预处理器按最新输入做相似度检索，经 `preload_memory_tool` 注入）。
- **ADK Java 1.0**（InfoQ 2026-04-20）[S49]：加入事件 compaction、暂停前确认后恢复（`requestConfirmation()`）、原生 A2A、`ContextFilterPlugin` 等插件。
- **七问小结**：单位是“由 Session 事件编译出的视图 + artifact 句柄”，事实只经 `append_event` 写入 Session；常驻部分推、artifact 拉（只在本次请求有效）；确认是事件持久化；交接时做叙述化重述与工具调用归属标注；缓存靠稳定前缀。

### 2.10 CrewAI、Agno、Mastra、Letta [S50]–[S54]

- **CrewAI** [S50]：顺序流程默认把上一任务的输出传给下一任务；`context=[…]` 显式指定来源任务（只能引用之前的任务）；`TaskOutput` 有 `raw`、`pydantic`、`json_dict`；guardrail 失败时把错误交回 Agent 重试（默认最多 3 次）；被 `context` 引用的异步任务会让下游等待。单位是“上游任务输出”，推送。
- **Agno Teams** [S51]：mode 为 coordinate（默认，leader 为每个成员编写任务并合成）、route（把请求原样交给一个成员并直接返回其回复）、broadcast、tasks；`determine_input_for_members=False` 时成员收到原始用户消息；成员响应与 leader 分开记录。单位是 leader 写的任务或原始输入。
- **Mastra** [S52][S53]：working memory 可用 Markdown 模板（每次整体替换）或 schema（深度合并，`null` 删除字段，数组整体替换），默认 resource 范围，默认放在 system message，`readOnly` 适合路由与子 Agent。Observational Memory（`@mastra/memory` 1.1.0 起）：Observer 在消息历史达 30,000 token 时把历史压成带日期与优先级的观察笔记（通常 5–40× 压缩），Reflector 在观察达 40,000 token 时整体重写；观察只追加，前缀稳定可缓存，反思重写时前缀才变；后台缓冲约每 6K token 一次；thread 范围为默认，resource 范围已弃用，因为伤害 prompt cache、理解与表现。
- **Letta** [S54]：旧版共享 memory block 可挂到多个 Agent，一方改动其他方立即可见；`memory_insert`（只追加）并发安全，`memory_replace` 在目标文本已变时失败，`memory_rethink`（整体重写）是 last-writer-wins，建议由一个所有者负责重写；文档已不推荐 memory block。新版 MemFS（仅搜索摘要）是 git 支持的 Markdown 记忆文件系统（context repository），每次编辑都提交，共享仓库可挂到多个云端 Agent，要 commit 并 push 后其他 Agent 才能 pull，记忆子 Agent 用 git worktree 并行写。
- **七问小结**：CrewAI 与 Agno 的单位是上游输出或 leader 写的任务，推送，确认靠 guardrail 或 leader 合成，适用于流水线与路由；Mastra 的单位是注入系统消息的 working memory 与观察日志，由 Observer / Reflector 或 Agent 工具写入，每轮推送，没有接收确认，性能上靠观察只追加保住前缀缓存；Letta 的单位是共享块或 git 仓库中的文件，拉取，确认是 git commit / push，防覆盖靠只追加写与单一重写者。这一组的共同点是把“共享记忆”从可变块转向只追加或版本化（Mastra 观察只追加、resource 范围弃用；Letta 从 block 转向 git 提交）。

### 2.11 协议：A2A、AG-UI、MCP、ACP [S55]–[S67]

- **A2A 1.0.0** [S55][S56]：
  - Task 字段 `id`（服务器生成，客户端不能自定）、`contextId`、`status`、`artifacts`、`history`、`metadata`。`contextId` 把相关任务与消息归为一个会话上下文，Agent 可以在消息没带时生成并必须在响应中返回，客户端应把它当作不透明值；Agent 可以用它保存状态或会话历史，也可以让它过期（需公开过期策略）。
  - Message 有 `messageId`（创建者生成）、`role`、`parts`，可选 `taskId`、`contextId`、`referenceTaskIds`、`extensions`、`metadata`；消息不保证进入任务历史，不能当作关键信息的可靠投递通道。
  - `historyLength`：不设由服务器决定，0 不返回历史，大于 0 至多返回最近 N 条。
  - 终态（COMPLETED、FAILED、CANCELED、REJECTED）的任务不能再接收消息（`UnsupportedOperationError`），也不能重启；改进须在同一 `contextId` 下开新任务，用 `referenceTaskIds` 指向旧任务；INPUT_REQUIRED、AUTH_REQUIRED 是中断态，用同一 `taskId` 继续。
  - Artifact 有 `artifactId`（任务内唯一）、`name`、`parts`（至少一个）；流式 `TaskArtifactUpdateEvent` 用 `append` 与 `lastChunk` 拼接；改进某个产物时客户端应指明具体 artifact 与版本，版本历史由客户端负责；推送通知可能重复，应当幂等处理。
- **AG-UI** [S57]：事件分为生命周期、文本、工具调用、状态（`StateSnapshot`、`StateDelta` 即 RFC 6902 JSON Patch、`MessagesSnapshot`）、Activity、Reasoning（含 `ReasoningEncryptedValue`）、Subagent、Raw / Custom、Meta（草案）；中断通过 `RunFinished` 的 `outcome.interrupt` 表达，客户端用带 `resume` 的新 run 继续。状态在 Agent 与前端之间双向共享；交互开始、断线重连、大的变更时发快照，高频小更新发差量；发现不一致时可以请求新快照重新同步。
- **MCP 2026-07-28** [S58][S59]：
  - 去掉协议级 session 与 `Mcp-Session-Id`，去掉 initialize 握手；每个请求在 `_meta` 中携带协议版本、客户端能力与身份；需要跨调用状态的服务器使用显式、由服务器生成的句柄，作为普通工具参数传递（SEP-2567）。规范中的非规范性指引建议：句柄不透明、每次调用都校验授权、在创建工具的描述里说明保留期、对过期或未知句柄返回可恢复的工具执行错误。
  - `tools/list` 等列表不随连接变化，服务器应确定性排序，以便客户端缓存并提高 LLM prompt cache 命中率；`tools/list`、`resources/read` 等结果必须带 `ttlMs` 与 `cacheScope`（public / private）。
  - `subscriptions/listen` 取代 `resources/subscribe`；MRTR（`input_required` 结果加 `requestState`，客户端带 `inputResponses` 重试）取代服务器发起的请求；Roots、Sampling、Logging 弃用（目录改由工具参数或资源 URI 传递）；tasks 移入官方扩展；响应流断开不再续传，必须以新请求 ID 重发。
  - 工具结果内容类型包括 text、image、audio、`resource_link`（不保证出现在 `resources/list` 中）与嵌入资源，都支持 audience、priority、lastModified 注解；`structuredContent` 可配 `outputSchema`。
- **ACP**（Agent Client Protocol）[S60]–[S67]：
  - v1 会话：`session/new(cwd, mcpServers)`；`session/load` 要求 Agent 在响应前以 `session/update` 重放整个对话；`session/resume` 恢复上下文但不重放（已稳定）；`session/close`（已稳定）；`additionalDirectories`。`_meta` 约定用于传播 trace 与关联 ID，规范要求实现不得对其中的值作假设，因此不适合承载 Agent 需要执行的指令 [S60][S61][S66]。
  - **Client-Provided System Prompt RFD**（2026-10-30 进入 Preview，schema 仍为 unstable）[S61]：能力 `sessionCapabilities.systemPrompt`；`session/new`、`session/load`、`session/resume`、`session/fork` 可带 `systemPrompt { mode: "append" | "override", content: ContentBlock[] }`，文本为基线；客户端在各生命周期请求上重发；提示变化时 Agent SHOULD 应用，但为了不丢 prompt cache 或保留的推理，可以推迟到下次重建提示（如 compaction）；无法应用时必须报错且不创建会话。实现：claude-agent-acp v0.92.0 支持 append 与 override，resume 时的变更在下次 compaction 生效；codex-acp v2.3.0 只支持 append，以 developer instructions 交付，变更在下次 compaction 生效，会话有工作或后台终端在跑时拒绝变更。RFD 的动机里列出了现状：没有该字段时，客户端只能把行为指令混在用户消息里（例如 Buzz 每轮在用户消息前加 `[System]` 前缀），引用 Instruction Hierarchy 等研究说明系统级指令比用户消息中的指令更受遵循。
  - **Session fork RFD** [S62]：为了用当前对话生成摘要、PR 描述等而不污染用户历史，先 fork 再在副本上发消息，最后关闭副本；参数同 `session/load`。
  - **Session Compaction RFD**（已完成，进入稳定协议）[S63][S67]：`compaction_update`（in_progress / completed，同一 ID 原地更新）与可选的 `compaction_summary_chunk` 或 `summary`，让客户端在会话时间线上看到原生压缩的边界与可展示的保留摘要；v1 需要 `session.compaction` 能力；load 时按同样语义重放。
  - **MCP-over-ACP**（草案，只面向 MCP 2026-07-28）[S64]：客户端或代理以 `type: "acp"` 声明 MCP server，经已有的 ACP 连接用 `mcp/message` 发无状态 MCP 请求，不需要额外进程或网络端口。
  - **Proxy chains RFD** [S65]：位于客户端与 Agent 之间的代理可以注入或修改提示、添加全局上下文、通过 MCP-over-ACP 提供工具、过滤响应，由 conductor 编排。
  - 其他 [S66]：Subagent Sessions RFD 让 Agent 把自建的子 Agent 暴露为受限的 ACP 会话；Message ID（已稳定）让 Agent 为消息块生成 ID；Session usage（已稳定）报告上下文大小与累计成本。
- **七问小结**：A2A 的单位是 Task 与 Artifact（`contextId` 归组），服务端 Agent 拥有任务，推（流与推送）拉（getTask 与 `historyLength`）兼有，确认靠任务状态机，防重复靠终态不可变与推送幂等，适用于跨组织的不透明 Agent 之间；AG-UI 是快照加差量，Agent 与前端共同拥有，防丢失靠快照重同步，适用于 Agent 与界面之间；MCP 是被模型拉取的工具结果与显式句柄，服务器拥有，确认靠 `resultType` 与错误类型，2026-07-28 之后状态全部显式化，列表确定性排序是为了缓存；ACP 是 `session/prompt` 的内容块，Agent 拥有原生会话，load 重放、resume 不重放，压缩边界可见，systemPrompt 仍是 Preview，适用于客户端驱动本机 Agent——这正是 HarnessHub 与多数焦点 Harness 之间的那一层。

### 2.12 与交接直接相关的论文 [S68]–[S72]

- **MAST**（arXiv 2503.13657，v3 2025-10-26）[S68]：1600+ 条标注轨迹、7 个框架，14 种失败模式归为 3 类（系统设计、Agent 间失配、任务验证），标注一致性 κ=0.88（各模式比例未从摘要核实）。
- **ACE: Agentic Context Engineering**（arXiv 2510.04618，v3 2026-03-29）[S69]：迭代重写会逐渐侵蚀细节（context collapse），摘要倾向过度简短而丢掉领域洞见（brevity bias）；用“生成、反思、策展”的结构化增量更新维护不断演化的 playbook；agent 基准 +10.6%、金融 +8.6%。
- **Do Not Restart: Residual Completion for Stateful Agent Handoffs**（arXiv 2609.13800，v1 2026-09-12，v4 2026-09-26）[S70]：把模型间交接表述为受承诺约束的残余完成：从已接受的进展冻结一份残余契约（已接受的选择、已实现的效果、未完成的义务），只有剩余部分被覆盖时才允许执行；排序规则为目标先于提案、整体提案先于授权、实时证据先于成功；实时回执清偿义务。5 个环境、两组同厂商模型对，宏平均准确率与强的全任务 Agent 相当，成本为其 22.0%–34.6%；跨厂商结果摘要只说“迁移更广”，未细读。
- **Attention Tax, Handoff Tax**（arXiv 2610.06069，2026-10-05）[S71]：分解降低长上下文带来的注意力税，但带来信息被压缩或转移时的交接税；当重置上下文省下的注意力成本超过交接成本时分解更优；在其账本对账任务上交叉点在深度 10，深度 20 / 50 / 100 时分解胜出，实测成功率与预测差距在 9 个百分点以内。
- **AgentLeak**（arXiv 2602.11510，v3 2026-06-15）[S72]：1,000 个场景、5 个模型、4,979 条有效轨迹；多 Agent 的最终输出泄露 27.2%（单 Agent 基线 43.2%），但 Agent 间消息泄露 68.8%，只审计最终输出会漏掉 41.7% 的违规。

### 2.13 比较表：交接单位 × 所有权 × 推拉 × 确认

| 对象 | 交接单位 | 所有权（谁写） | 推 / 拉 | 接收方确认 |
|---|---|---|---|---|
| Anthropic 研究系统 [S1] | 下：任务说明；上：压缩发现（可选：文件 + 引用） | lead 写计划（存 Memory）；子 Agent 写结果 | 下推、上推；计划可拉 | 同步等批次结束；无语义确认 |
| Anthropic 长任务 harness [S3] | 进度日志 + feature JSON（`passes`）+ git | initializer 建立；后续只改 `passes` | 拉（开局自读） | 验证型：开局跑 e2e，验证后才标完成 |
| Claude API compaction / context editing [S4][S6] | 带签名的摘要块；服务器端编辑视图 | API 生成；客户端原样保存 | 每次请求随附 | `stop_reason`、`applied_edits`、签名校验 |
| Claude Code subagent [S11] | 委派消息 + CLAUDE.md + git status → 最终报告；fork 继承全文 | 主 Agent 写委派；子 Agent 写报告 | 推 / 推 | 结果到达或后台完成通知；报告被扫描降权 |
| Claude Code agent teams [S10] | spawn prompt + 共享任务列表 + 邮箱 | lead 建任务；队友 claim（文件锁） | 自动投递（推）+ 任务列表（拉） | 邮箱写入成功才算发送；空闲通知附最终答案 |
| Claude Code 跨会话消息 [S12] | 纯文本（≤ 约 1M 字符） | 发送方 Claude | 推 | 送达 / 暂扣 / 拒绝；不具用户权威 |
| Cognition [S14][S15] | 完整轨迹 fork；审阅只给 diff；任务 + 中途消息 | 单写者 | fork 推；审阅者从代码拉 | 写者过滤审阅意见；子 Devin 自验证后汇报 |
| Manus [S19][S20] | 指令或完整上下文 → schema 化结果；文件引用 | planner 规定 schema | 结果推；细节拉（文件） | constrained decoding 保证 schema |
| DeerFlow 2.0 [S22][S23] | isolated prompt / snapshot（保留对话 + 摘要）/ 历史句柄 | 父线程拥有历史与归档；子不回写 | snapshot 推；`history_*` 拉 | 工具回执；读取报告 truncated / unavailable |
| Kimi Agent Swarm [S25] | 子任务 → 任务相关输出 | orchestrator（被训练）；子 Agent 冻结 | 推 / 推 | 无显式确认 |
| OpenAI Agents SDK [S29] | 完整历史（默认）/ 过滤 / 嵌套摘要 | 运行器与 input filter | 推 | handoff 工具调用；`on_handoff` 校验 |
| OpenAI Responses compaction [S32] | 加密的 compaction item | 服务器 | 每次随附 | 无（不透明） |
| Codex 云任务 [S33] | prompt + 分支引用 → diff | 云任务写 diff；用户决定应用 | 云端拉仓库；本地拉 diff | 用户审阅后 `apply` |
| Codex `/import` [S34] | 会话转录（≤ 50 个 / 30 天）+ 配置 | 导入方转换 | 拉（一次或自动同步） | 导入状态卡 |
| LangGraph swarm / supervisor [S38][S39] | 共享 `messages`（全量）或最后一条 | 图状态与 reducer | 推 | 结构上必需的 `ToolMessage` |
| MAF handoff [S41] | 广播的用户与 Agent 文本（滤掉工具内容） | 每个参与者各自的 session | 推（广播） | `request_info` 交回用户；checkpoint |
| MAF Magentic [S42] | task ledger + progress ledger + 指令 | manager | 推 | 每轮 progress ledger（满足 / 循环 / 进展） |
| Google ADK [S44] | 编译视图 + artifact 句柄；transfer 时叙述化重述 | Session 事件（`append_event`） | 常驻推；artifact 拉（仅本次请求） | 事件持久化；无语义确认 |
| Mastra [S52][S53] | 观察日志 / working memory（schema 合并） | Observer、Reflector；Agent 工具 | 每轮注入（推） | 无 |
| Letta [S54] | 共享 block / MemFS git 仓库 | 多 Agent（建议单一重写者） | 拉（读文件）；block 即时可见 | git commit / push |
| A2A [S55] | Task + Artifact + Message（`contextId` 归组） | 服务端 Agent 拥有任务 | 流与推送（推）+ getTask（拉） | 任务状态机；终态不可变 |
| AG-UI [S57] | 状态快照 + JSON Patch 差量 | Agent 与前端双向 | 推 | 不一致时请求新快照 |
| MCP 2026-07-28 [S58][S59] | 工具结果、资源、显式句柄 | 服务器 | 拉（模型调用工具） | `resultType`、`isError`、句柄过期错误 |
| ACP [S60][S61] | `session/prompt` 内容块；systemPrompt（Preview）；load 重放 / resume 不重放 | Agent 拥有原生会话 | 推；load 时 Agent 推重放 | 回合 stopReason；`compaction_update` |
| CFRC 论文 [S70] | 残余契约：已接受选择 / 已实现效果 / 未完成义务 | 冻结的契约 | 推 | 剩余被覆盖才放行；实时回执清偿义务 |
| HarnessHub 现状 [S73] | 全部公共历史 JSON（正文、附件名、结果状态）作为用户消息 | Hub（公共 Session） | 推 | 已派发即推进 `throughRunId`（简报所述疑似缺陷） |

## 3. 模式归纳（全部为【推断】）

**P1 交接单位收敛为“简报 + 句柄”，完整转录只在同模型 fork 时使用。** 下行给写者的内容越来越完整（Cognition 的 fork [S15]、DeerFlow snapshot [S22]、Claude Code fork [S11]、Deep Agents forked [S40]），上行给协调者的内容越来越精简（1–2K token 摘要 [S2]、任务相关输出 [S25]、最后一条消息 [S39]），细节都改成可取回的引用（文件路径 [S20]、artifact 句柄 [S44][S48]、历史 source ID [S23]、MCP 句柄 [S58]）。

**P2 “fork 还是隔离”在 2026 年成为一等选项，而且有了第一批数字。** Claude Code 交互式默认 fork [S11]，Deep Agents 在 0.7.13 加了 forked [S40]，DeerFlow 让调用方按任务选 `isolated` / `snapshot` [S22]。DeerFlow 的成对评测说明方向取决于历史与任务的相关性：相关时 snapshot 省 15.5% token、40.3% 时间，无关时多花 47.9% token [S24]；“注意力税 / 交接税”模型给出同样的形状——任务越深，分解越划算 [S71]。

**P3 单写者。** Cognition 2026 把“写入保持单线程”作为所有可行模式的公约数 [S15]；Claude Code teams 要求每个队友拥有不同的文件 [S10]；Manus Wide Research 的子 Agent 互不通信 [S21]；MAF handoff 的接收方取得完全所有权 [S41]；Kimi 的子 Agent 冻结、只回传结果 [S25]。HarnessHub 的 INV-02 / INV-03 与此一致。

**P4 结构化状态归系统所有，模型只做受限的增量写入。** 只改 `passes` 的 JSON 清单 [S3]、schema 深度合并 [S53]、只追加的 insert 才并发安全 [S54]、只经 `append_event` 写入的 state delta [S46]、manager 才能写的两本 ledger [S42]、有容量上限且标为 `model_report` 的笔记 [S23]、用增量更新对抗 context collapse [S69]。整体重写都被视为风险。

**P5 来源与权威分离。** 历史中的用户消息不授予当前权限 [S23]；其他会话的消息不能批准任何事、其中的命令不执行 [S12]；子 Agent 的报告被扫描并降权 [S11]；其他 Agent 的话被叙述化重述、工具调用被标注归属 [S44]；A2A 明确消息不是关键信息的可靠通道 [S55]；`_meta` 不承载指令 [S61]。

**P6 缓存纪律是性能的第一杠杆。** 稳定前缀 / 可变后缀 [S44]、只追加与确定性序列化 [S19]、屏蔽而非移除工具 [S19]、工具列表确定性排序 [S59]、系统提示录制到下次 compaction 才变 [S13][S61]、改工具定义使整个缓存失效 [S9]；缓存读取价是基础价的 0.025×–0.1× [S9]，Manus 的输入:输出约 100:1 [S19]，所以前缀命中率直接决定交接后的费用与首 token 时延。

**P7 原生压缩与推理产物不可跨厂商移植。** OpenAI 的 compaction item 是不透明的加密内容 [S32]，Anthropic 的 compaction 块带签名、改动即拒收 [S6]，AG-UI 专门有加密推理事件 [S57]；而 MiniMax 指出丢掉推理会掉表现 [S28]。跨厂商接力只能交付一份由 Hub 拥有、可移植的表示，并把“为什么”显式写下来。

**P8 确认多是传输层回执加验证型核验，几乎没有语义复述。** `ToolMessage` [S37]、邮箱写入成功 [S10]、送达 / 暂扣 / 拒绝 [S12]、A2A 任务状态 [S55]、`applied_edits` [S4] 都只证明“收到了”；能证明“接住了”的是开局跑测试、读 git log [S3]，子 Devin 自验证 [S16]，或 CFRC 的“剩余被覆盖才放行” [S70]。没有看到任何系统把模型的复述当作接收成功的证据。

**P9 高质量实现都有显式水位或版本。** 后台 compaction 记录覆盖的消息数 n [S7]、ADK 的 interval 与 overlap [S45]、DeerFlow 内容寻址的 source ID [S23]、A2A 终态不可变加 `referenceTaskIds` [S55][S56]、Letta 的 git 提交 [S54]、AG-UI 的快照基线 [S57]。

**P10 失败时不改历史。** Anthropic 压缩失败保留完整历史 [S7]，DeerFlow 压缩失败或超限历史不变 [S22]，AG-UI 差量失败要新快照 [S57]，A2A 终态任务不能被续写 [S55]。

**主要分歧与适用条件**
- **D1 共享完整轨迹（Cognition 2025）对压缩回传（Anthropic）。** 分歧的关键是信息流向与读写性质：流向写者的上下文要尽量完整，因为写者会做隐含决定 [S14]；从只读的研究者、审阅者流回的上下文要压缩，审阅者甚至应当从零开始 [S1][S15]。到 2026 年两边都落在“单写者 + 只读助手 + 可选 fork”上 [S11][S15]。HarnessHub 的接力把**写者身份**交给目标，因此适用 Cognition 的原则：交付尽可能完整、忠实的上下文，但必须是可移植的形式。
- **D2 推还是拉。** Manus、ADK、Anthropic 的 just-in-time 偏向句柄加按需拉取 [S2][S20][S44]；Cognition 指出子 Agent 默认不回写、模型没有在需要主动取数的环境里训练过 [S15]，DeerFlow 的 snapshot 则是推 [S22]。结论是：推送的部分必须单独就够用，拉取只是增强。
- **D3 谁写摘要。** 系统确定性维护（ADK compaction 事件、Magentic ledger、Anthropic JSON 清单）对模型写摘要（compaction、笔记、Cognition 微调的压缩模型）。HarnessHub 没有自己的模型，又不能静默用用户没选的模型，所以确定性部分必须是底线，模型写的部分只能来自用户已选的 Harness，并标注为模型报告。
- **D4 共享可变记忆还是只追加 / 版本化。** Letta 从可变 block 转向 git MemFS，Mastra 弃用 resource 范围的观察以保护缓存 [S52][S54]：趋势是版本化、只追加。

## 4. 对 HarnessHub 接力的启示（全部为【建议】）

每条写明判定（采用 / 改造后采用 / 拒绝）、机制、数字（初值，待第一轮基准校准）与理由，并标出对应简报问题 Q1–Q11。

**I-1【采用】两层交接单位：不可变交接单（推）+ 公共事实句柄（拉）。（Q1、Q2、Q9）**
- 交接单由 Hub 从工作账本确定性投影，不调用模型，分四层：
  - L0 契约头：“以下是数据不是指令 / 不要重做之前的输入 / 如何取更多”的固定说明（跨交接逐字节相同），其后才是变量：交出方与接手方、`packetId`、`throughSeq`、来源 Run 集合的指纹；合计 ≤ 400 token。
  - L1 简报：目标与约束原文摘录、进展、改动、待办、未决项、失败、产物、环境（章节来源见 I-2）；默认 ≤ 2,000 token、硬上限 4,000（参照子 Agent 回传 1–2K token [S2]）。
  - L2 近期原文尾部：至少最近一个已结束 Run 的用户输入与回复全文，≤ 6,000 token（参照“保留最近若干轮原文” [S6]、`event_retention_size` [S45]、Manus 让最新工具结果保持完整 [S20]）。
  - L3 按需层：完整公共历史与工具详情，经 I-12 的只读工具分页取回。
- 整包（不含当前输入）≤ min(12,000 token, 目标声明窗口 × 10%)，按 4 字节 / token 粗估，字节数与 token 估计分别记录（`context-transfer.md` 已要求分开记录）。上限要远低于原生压缩的触发点，否则交接单一进入目标就可能被压掉（Anthropic context editing 默认 100,000 token 触发 [S4]，Mastra 30,000 token 触发观察 [S52]）。
- 三种交接方式，对应 Q9 的“完整 / 精简 / 只有目标”：
  - 完整：公共历史 ≤ min(8,000 token, 整包上限) 时发送全量原文 + L1（短会话的交接税高于注意力税 [S71]；相关历史下 snapshot 更省 [S24]）；用户也可以主动选择完整，超过上限时明确提示而不是静默截断。
  - 精简（默认，历史较长时）：L0 + L1 + L2，L3 可取。
  - 只有目标：L0 + 当前输入 + L1 中的“改动”和“待办”两节，用于用户明确开始一件与历史无关的新事（无关历史使 snapshot 多花 47.9% token [S24]）。
- 理由：P1、P2；Anthropic just-in-time [S2]；Manus 可恢复压缩 [S20]；ADK artifact 句柄 [S44]；DeerFlow 的 isolated / snapshot 与历史句柄 [S22][S23]。

**I-2【改造后采用】工作账本：确定性主干 + 受限、可追溯的模型增量。（Q1、Q2、Q11）**
- 条目字段：`id`、`kind`、`text`、`sourceRunIds`、`sourceSeq`、`producer`（`deterministic` / `harness_report` / `user`）、`status`、`supersededBy`、`policyVersion`、`contentHash`。只追加与 supersede，不整体重写，避免 context collapse 与 last-writer-wins [S69][S54]；“旧摘要不覆盖新事实”用 supersede 链加水位比较实现。
- 各章节的取材与确定性：
  - 目标与约束：会话第一条用户消息加最近 K 条用户消息原文摘录（不提炼，标注截断）← `messages`，确定性。
  - 进展：各 Run 的结果状态、最后一条回复的尾部、计划条目状态 ← `PublicRun.status`、`plan`，确定性（属于 Harness 报告）。
  - 改动：`tools` 中编辑类条目的文件路径、增删行数、diff 的 `ContentRef`、由哪个 Run 与 Harness 产生 ← `PublicRun.tools[].detail`，确定性。
  - 待办：最新计划中未完成的条目；状态分“Harness 报告已完成”和“有验证证据”，不把前者当后者（长任务 harness 只在端到端验证后才标完成 [S3]）。
  - 未决：等待中的审批与问题。审批不跨执行者继承，只作为事实列出 [S12][S23]。
  - 失败与教训：最近 3 条 `exitCode ≠ 0` 的工具与错误摘录、error 级 notice、Run 错误 ← 确定性（“保留错误” [S19]）；“教训”只能来自模型（I-6）。
  - 产物：`outputs`、附件的 `ContentRef` 与 hash ← 确定性。
  - 环境：cwd、分支、HEAD、未提交文件指纹 ← 确定性（Hub 是否已经采集 git 状态待内部基线核实）。
  - 决定：用户的权限决定、切换决定 ← 确定性；决定的理由只能来自模型（I-6）或用户手动“钉住”。
- 写入在 Run 结算后增量进行，按 `(runId, factId)` 幂等，可以从公共事实整体重建（INV-13、INV-22）。模型写的条目一律 `producer=harness_report` 并设容量（参照 DeerFlow 8 条 × 750 字符 [S23]）。

**I-3【采用】水位分“已派发 / 已送达”，交接单幂等、至少一次投递。（Q4、Q6）**
- 每个原生绑定保存 `syncedThroughSeq`。只有当**嵌入了该增量的输入**被目标真正处理时才推进：该 Run 有 `RunTiming.firstOutputAt`（原生已产出第一个可见输出，`src/contracts/session.ts` 已有此字段），或终态证据表明模型读过这条输入。原样发送的斜杠命令等没有嵌入增量的输入一律不推进——这修复简报指出的 INV-14 疑似缺陷，增量顺延到下一条普通输入。
- 交接单带 `packetId` 与 `throughSeq`，并在 L0 声明“已经见过同一 packetId 的内容可以忽略”；状态不明时下次重发（至少一次）。依据：后台 compaction 只替换请求时记录的前 n 条 [S7]，A2A 推送应幂等处理 [S55]，Claude Code 跨会话消息在短窗口内丢弃重复 [S12]。
- 多个 Harness 各自一条水位；返回 A 时只补 A 的 `syncedThroughSeq` 之后的增量（现有 `throughRunId` 思路，改为以“已送达”为准）。

**I-4【采用】注入通道按“稳定前缀 / 可变后缀”分层。（Q3、Q8）**
- **新建原生会话（public_context_rehydrate）**：L0 是固定文本，若目标在 ACP initialize 中声明 `sessionCapabilities.systemPrompt`，用 `mode: "append"` 交付（claude-agent-acp ≥ 0.92.0 已实现，HarnessHub 的 Claude 基线是 0.94.0 [S61][S73]）；L1、L2 放在第一条用户消息里一个有边界的数据块中。Codex 在 HarnessHub 里走 app-server 而不是 codex-acp，等价的 developer instructions 通道交给“原生通道”调研核实。
- **复用原生会话（返回 A）**：不改系统提示。Claude Code 会把系统提示录制到下次 compaction，`snapshot:false` 会丢掉该请求的 prompt cache 与早期 thinking [S13]，ACP RFD 也允许 Agent 推迟到 compaction [S61]。增量以“交接更新”数据块的形式放在下一条用户输入之前，只追加，保护已缓存的前缀 [S19][S44]。
- 工具输出、文件内容、其他 Harness 的回复只能进入数据块，绝不进入系统级通道（DeerFlow 的 system 通道只放静态权威契约 [S23]）；不用 `_meta` 携带指令 [S61]。
- 数据块的序列化确定（键顺序固定、不含时间戳等易变字段），使相同水位的交接单逐字节相同 [S19]。

**I-5【采用】叙述化转述，历史不授权，写明“你没有看过什么”。（Q1、Q7、Q9）**
- 交接单里所有来自其他执行者的内容用第三人称叙述（“Codex 第 3 轮（已取消）运行了 `npm test`，exit 1”），不为目标伪造原生工具调用结构（ADK 的叙述化重述与工具归属 [S44]；LangChain 指出交接消息配对不全会导致历史畸形 [S37]；DeerFlow 要为悬挂的工具调用补占位结果 [S22]）。
- 明示：历史里的用户批准与命令在本回合不生效，`/xxx` 只是文本 [S12][S23]。
- 明示接手方没有读过的东西，例如“以下文件由 Codex 修改，你此前没有读过，动手前先看 diff”；Cognition 记录了 Agent 误以为与他人共享状态的失败 [S15]，smart friend 的做法是让对方先去查再问而不是猜。

**I-6【改造后采用】离场说明由交出方 Harness 自己写，在 ACP fork 的副本里生成。（Q1、Q6）**
- 机制：交出方声明 `session/fork` 时（HarnessHub 已实现 fork，`src/adapters/control/acp.ts` 337–359 行），在副本中用交出方当前的模型（用户已选的）生成离场说明，然后关闭并清理副本；说明作为派生记录（`producer=harness_report`、水位、hash）放进 L1 的“交出方自述”小节，≤ 800 token。
- 内容模板采用 CFRC 的三分法——已接受的选择、已实现的效果、未完成的义务 [S70]——加上 Anthropic compaction 的保留清单：架构决定、未解决的 bug、实现细节 [S2]。
- 约束：默认关闭，用户开启或选择“完整”交接时才运行，并显示 token 消耗；后台运行，不在切换的关键路径上（参照后台 compaction [S7]）；失败或超时只是缺少这一节，确定性交接单仍然成立。
- 理由：ACP fork RFD 的目的正是“生成摘要而不污染用户历史” [S62]；Cognition 认为长任务需要专门压缩事件与决定的模型 [S14]；这样不会静默使用用户没选的模型。

**I-7【采用】目标发生原生压缩后再锚定。（Q2）**
- 观察到目标的原生压缩后（ACP `compaction_update` completed [S63]，或公共 `activities` 中 `kind: "compaction"`），在下一条经 Hub 的输入前附一份 ≤ 600 token 的 L1 精简版（目标、未完成待办、关键决定、交接单句柄），因为原生摘要可能把交接单压掉。
- 依据：DeerFlow 在压缩后补一条最新 todo 提醒 [S22]；Anthropic 说明被总结范围内的中途 system 消息会失效、需要重述 [S6]。

**I-8【拒绝】共享一份可变消息列表或共享原生会话。（Q4）**
- MAF 明确不在不同类型的 Agent 之间共享 `AgentSession`，因为实现各异 [S41]；LangGraph swarm 与 AutoGen swarm 的共享列表依赖同一进程与同一消息格式 [S38][S43]。HarnessHub 的执行者是不同厂商的独立进程，公共 Session 加私有原生绑定是正确的结构；MAF 式“广播公共文本、过滤工具控制内容”是现状的底线，在此之上补结构化事实（I-2）。

**I-9【拒绝】跨厂商转移原生 thinking 或压缩产物。（Q1、Q7）**
- 它们加密、签名或不透明 [S6][S32][S57]，只有返回同一 Harness 时才由原生会话自己保留。补偿办法是在账本里显式记录“决定 + 理由”（I-2、I-6），因为丢掉推理会掉表现 [S28]。

**I-10【采用】接棒确认分三级，不把复述当质量证明。（Q5）**
- 送达：Hub 记录派发输入中的 `packetId`、hash 与目标处理了这条输入的证据（I-3）。
- 读取（可选信号）：挂了 I-12 的工具时，记录目标是否调用 `relay_read` 或 `relay_ack`；这是模型行为，只作信号。
- 状态核验：目标写入前，核对工作区指纹（HEAD 与未提交文件 hash）是否与交接单记录一致，不一致就明确报告冲突（INV-12）；类似长任务 harness 开局先核对再动手 [S3]。
- 对用户展示扩展后的接续等级：`native_resume`、`native_resume_with_delta`、`rehydrate_full`、`rehydrate_brief`、`rehydrate_goal_only`、`blocked`，以及交接单摘要（多少条改动、待办、遗漏项、水位）。依据 P8：调研对象没有把模型复述当作接收证据的；AGENTS.md 也禁止把 Agent 回复当达标证据。

**I-11【采用】显式“未包含”清单。（Q1、Q6）**
- 交接单列出因预算没有放入的 Run 区间、省略的附件字节、截断的工具输出，并给出取回句柄。依据：ADK 把压缩写成可见事件 [S45]，DeerFlow 把省略的媒体写成显式声明 [S22]，A2A 明确 `historyLength` 的取舍语义 [S55]；也满足 `context-transfer.md`“超限不静默截断”。

**I-12【采用】Hub 只读接力工具，按 MCP 2026-07-28 的无状态模型设计。（Q2、Q3、Q8）**
- 不超过 3 个工具：`relay_search(query, role?, harness?)` 至多 8 条结果、每条 ≤ 600 字符并带偏移；`relay_read(sourceId, offset)` 每页 4,000 字符、返回 `next_offset`（尺寸取自 DeerFlow [S23]）；可选 `relay_ack(packetId)`。
- Session 与交接单的句柄作为普通参数显式传递，不依赖 MCP 会话（SEP-2567 [S58]）；句柄不透明、每次校验、写明保留期；结果带 `ttlMs` 与 `cacheScope: "private"`；`tools/list` 确定性排序 [S59]。
- 现状所有 ACP 会话都以 `mcpServers: []` 建立（`src/adapters/control/acp.ts:390`）。何时挂载是一个取舍：会话开始时就挂，工具列表稳定、缓存友好，但偏离“像原生”；返回时才挂，会改变工具定义并让该轮缓存全部失效 [S9]。列为开放问题。
- 理由：DeerFlow 的分页历史工具 [S23]；ADK 的 `LoadArtifactsTool` 只把内容加到本次请求 [S48]；Anthropic just-in-time [S2]。以后 MCP-over-ACP（草案）可省去单独进程 [S64]。

**I-13【采用】后台增量维护，切换路径只做 O(Δ) 投影。（Q2、Q8）**
- Run 结算后在业务事务之外异步更新账本（派生、可重建），切换时只做投影（ADK 异步 compaction [S45]、Mastra 后台缓冲 [S52]、Anthropic 后台 compaction [S7]）。
- 性能初值（待基准）：账本更新 p95 ≤ 10 ms / Run；在 `MAX_RUNS = 256`、`MAX_SESSION_BYTES = 8 MiB` 内，交接单投影 p95 ≤ 30 ms；交接给派发前增加的时延 p95 ≤ 50 ms（不含 Harness 启动）；L0–L2 ≤ 48 KiB。
- 缓存目标：同一 Harness 返回时，交接更新只追加在末尾，不触碰已缓存的前缀；用 ACP usage 更新或 Harness 报告的 usage（`cache_read` 类字段，若有）测缓存读取比例。

**I-14【采用】评测用成对实验与隐藏检查，不用模型自评。（Q5、Q8）**
- 仿照 DeerFlow 的 context snapshot 评测：每个任务预先声明隐藏检查，记录 token、耗时、请求数，并如实写明模型与样本量的局限 [S24]。
- 三臂：全量公共历史（现状）、交接单 L0–L2、交接单 + L3 工具。场景：A→B→A、同 Harness 换模型、执行中请求切换、其他执行者改过文件、外部改动、超过 1 MiB 的长会话、交接说明失败。
- 指标：隐藏检查通过率、重复执行次数（同一副作用命令再次运行）、遗漏待办数、目标首个输出时延、注入 token、缓存读取比例（有 usage 时）。

**I-15【采用】内部通道同样要审计与脱敏，跨厂商流动对用户可见。（Q7）**
- 交接单是 AgentLeak 所说的内部通道：Agent 间消息泄露 68.8%，远高于最终输出的 27.2%，只审计输出会漏掉 41.7% [S72]；OpenAI 的嵌套历史与 `remove_all_tools` 都不做脱敏 [S29]。
- 构建交接单时按 INV-17 规则脱敏（凭据模式、环境变量值）；跨厂商交接在界面上说明“将把哪些内容交给 X”，允许用户编辑交接单或改用“精简 / 只有目标”；DeerFlow 的可选 PII 脱敏覆盖压缩输入与回注摘要，可作参考 [S22]。

**I-16【拒绝（当前阶段）】并行多写者 swarm；【改造后采用（以后）】只读助手。（Q10）**
- 以后同一 Session 并行多个 Harness 时，只允许一个写者，其他执行者只读：审阅者从干净上下文开始、只看 diff，结论回到写者由写者过滤 [S15]；避免两个执行者改同一文件 [S10]；子执行者互不通信、由 Hub 汇总 [S21]。这与 INV-02、INV-03 一致。

**I-17【改造后采用】借用 A2A 的终态不可变与引用语义，不实现 A2A。（Q4、Q11）**
- HarnessHub 的 Run 已是终态不可变；交接单为每条事实提供 `referenceRunIds` 与产物版本引用，便于接手方在回复中引用、便于审计 [S55][S56]。HarnessHub 不是 Agent 间网络，没有必要实现 A2A 协议本身。

**I-18【采用】为“建议交接”预留信号，只建议不自动切换。（Q10）**
- 可用信号：ACP 的上下文大小与成本更新（已稳定）[S66]、原生压缩次数 [S63]、Magentic 式的连续无进展计数 [S42]。只生成建议，INV-05 不变。

**I-19【参考】竞品信号：Codex `/import`。（Q10）**
- 厂商已经提供从 Claude Code、Cursor 单向导入转录（≤ 50 个、30 天内）与配置，并可自动同步 [S34]。【推断】转录搬运会成为基本盘，HarnessHub 的差异化应当是双向、带水位、带改动与待办账本、可审计的接力。

## 5. 风险与反模式

1. **把全部历史当用户消息发给目标（现状）。** 长会话超过 1 MiB 后无法交接；行为指令与数据混在用户消息里，遵循度低于系统级指令（ACP RFD 的论证 [S61]）；每次 rehydrate 都要冷写缓存，未缓存输入约为缓存价的 10–40 倍 [S9][S19]。
2. **用模型反复重写摘要或账本。** context collapse 与 brevity bias [S69]，last-writer-wins [S54]。对策：确定性主干、只追加与 supersede、定期从事实重建（I-2）。
3. **只把摘要交给写者。** 写者会做与之前冲突的隐含决定，即 Flappy Bird 问题 [S14]。对策：L2 原文尾部、决定条目、按需原文（I-1、I-12）。
4. **接手方以为自己知道其实不知道的东西。** Cognition 记录了误以为共享状态的失败 [S15]。对策：写明“你没有看过什么”（I-5）。
5. **把“报告已完成”当作已验证。** 长任务 harness 专门防这个 [S3]，AGENTS.md 也禁止。对策：待办状态区分报告与验证（I-2）。
6. **让交接内容进入系统级通道或改变工具列表。** 前者带来提示注入面与权威混淆 [S23]，后者让整个缓存失效 [S9]、违反“屏蔽而非移除” [S19]。
7. **伪造或搬运原生工具调用结构。** 配对不全导致历史畸形 [S37][S22]，而且跨厂商本来就不兼容。对策：叙述化（I-5）。
8. **用 `_meta` 传指令。** 规范要求实现不得对其值做假设，实际实现曾在数月里悄悄丢弃字段 [S61]。
9. **依赖接手方主动拉取。** 模型没有被训练成会回写、会主动取数 [S15]。对策：推送的部分必须单独够用，拉取只是增强，评测里统计工具使用率（I-14）。
10. **对短会话过度工程。** 交接税在浅任务上大于收益 [S71]，无关历史会多花 47.9% token [S24]。对策：分级（I-1）。
11. **只审计最终输出。** 内部通道泄露更多 [S72]。对策：I-15。
12. **重复执行。** 接手方重跑历史中有副作用的命令，或重做之前的用户输入。对策：“已实现的效果”一节 [S70]、终态不可变、明确“不要重做”；未知结果不自动重跑（INV-11）。
13. **fork 副本残留。** 用 fork 写离场说明会在用户的原生会话列表里留下副本；HarnessHub 的 fork 代码注释指出，非 -32601 的拒绝可能发生在副本已写入之后 [S73]。对策：副本的关闭、删除或归档有明确所有者与清理入口（INV-26），清理失败要如实报告。
14. **依赖不成熟的规范。** ACP systemPrompt 仍是 Preview、schema 为 unstable [S61]；MCP-over-ACP 是草案 [S64]；Claude Code agent teams 是实验性的 [S10]；DeerFlow 的 main 分支变化快 [S22]。对策：能力探测、只用已声明能力、未知不当支持（INV-16）。

## 6. 未解决的问题

1. 焦点 Harness 中哪些会把 MCP resources 暴露给模型、哪些只支持工具；哪些支持按会话注入 MCP server（需“原生通道”调研核实）。
2. Codex app-server 在 `thread/start` 与 `thread/resume` 上是否支持 developer instructions，变更何时生效、对缓存有何影响；OpenCode、Hermes、OpenClaw、dsh 的 ACP 适配器是否声明 `sessionCapabilities.systemPrompt`。
3. relay MCP 是在每个 Hub 原生会话一开始就挂（缓存稳定、但偏离“像原生”、增加攻击面），还是只在发生过交接的会话上挂（返回那一轮缓存失效）。
4. 没有 tokenizer 时如何估计目标模型的 token 数；窗口元数据只是声明（INV-16），预算按它算可能偏差很大。
5. 离场说明的费用由谁承担、怎样征得同意；fork 不可用的 Harness 是否有不污染转录的替代办法。
6. 各 Harness 能否提供“这条输入已被模型处理”的可靠证据（I-3 的前提），例如 ACP 回放、Codex 的线程读取接口。
7. 用户在自然语言里做的决定如何进入账本而不依赖模型提炼：界面“钉住”、交出方离场说明提出后由用户确认，还是两者都要。
8. 外部改动（用户在 IDE 里直接改）只能从工作区指纹看出“变了”，看不出“为什么变”，交接单该怎样表述。
9. 评测任务集如何构造与维护；每轮都用真实 Harness 跑的费用；隐藏检查的编写规范。
10. CFRC 论文的跨厂商结果与残余契约的具体格式需要读全文后再决定是否借用其排序规则。

## 7. 来源清单

阅读日期均为 2026-11-02。核实方式：“打开原文”指用抓取工具打开页面阅读；“本机下载原文”指用 curl 下载原始文件后在本机阅读；“仅搜索摘要”指只看到搜索结果摘要或二手转述。

| 编号 | URL | 标题 | 作者 / 机构 | 发布日期或版本 | 核实方式 |
|---|---|---|---|---|---|
| S1 | https://www.anthropic.com/engineering/multi-agent-research-system | How we built our multi-agent research system | Anthropic（Jeremy Hadfield 等） | 2025-06-13 | 打开原文 |
| S2 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | Effective context engineering for AI agents | Anthropic（Prithvi Rajasekaran 等） | 2025-09-29 | 打开原文 |
| S3 | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents | Effective harnesses for long-running agents | Anthropic（Justin Young） | 2025-11-26 | 打开原文 |
| S4 | https://platform.claude.com/docs/en/build-with-claude/context-editing | Context editing | Anthropic 文档 | 页面无日期；beta `context-management-2025-06-27` | 打开原文（前 100,000 字符） |
| S5 | https://platform.claude.com/docs/en/build-with-claude/compaction | Compaction overview | Anthropic 文档 | 页面无日期 | 打开原文 |
| S6 | https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand | Compaction on demand | Anthropic 文档 | beta `compact-2026-09-04` | 打开原文 |
| S7 | https://platform.claude.com/docs/en/build-with-claude/compaction-background | Compaction in the background | Anthropic 文档 | beta `compact-2026-09-04` | 打开原文 |
| S8 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool | Memory tool | Anthropic 文档 | `memory_20250818`，stable | 打开原文 |
| S9 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | Prompt caching | Anthropic 文档 | 页面无日期 | 打开原文（前 100,000 字符） |
| S10 | https://code.claude.com/docs/en/agent-teams | Orchestrate teams of Claude Code sessions | Anthropic（Claude Code 文档） | 实验特性；页面提及 v2.1.309 | 打开原文 |
| S11 | https://code.claude.com/docs/en/sub-agents | Subagents | Anthropic（Claude Code 文档） | 页面提及 v2.1.304 | 打开原文（前 100,000 字符；fork 小节未读到） |
| S12 | https://code.claude.com/docs/en/cross-session-messaging | Message your other Claude Code sessions | Anthropic（Claude Code 文档） | 需 v2.1.224+ | 打开原文 |
| S13 | https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts | Modifying system prompts | Anthropic（Agent SDK 文档） | 页面无日期 | 打开原文 |
| S14 | https://cognition.com/blog/dont-build-multi-agents | Don't Build Multi-Agents | Cognition（Walden Yan） | 2025-06-12 | 打开原文 |
| S15 | https://cognition.com/blog/multi-agents-working | Multi-Agents: What's Actually Working | Cognition（Walden Yan） | 2026-04-22 | 打开原文 |
| S16 | https://cognition.com/blog/devin-can-now-manage-devins | Devin can now Manage Devins | Cognition | 2026-03-19 | 打开原文 |
| S17 | https://cognition.com/blog/devin-for-terminal | Devin CLI: Start Local, Hand Off to the Cloud | Cognition | 2026-04-27 | 打开原文（交接机制未公开） |
| S18 | https://cognition.com/blog | Cognition 博客索引 | Cognition | 截至 2026-10-28 | 打开原文 |
| S19 | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus | Context Engineering for AI Agents: Lessons from Building Manus | Manus（Yichao “Peak” Ji） | 2025-07-18 | 打开原文 |
| S20 | https://rlancemartin.github.io/2025/10/15/manus | Context Engineering in Manus | Lance Martin（整理 Manus 研讨会） | 2025-10-15 | 打开原文 |
| S21 | https://manus.im/blog/manus-wide-research-solve-context-problem ；https://manus.im/features/wide-research | Wide Research | Manus | 搜索结果显示 10 月 29 日（周三，推断为 2025 年）；该地址的多语言标题已变为 Manus 2.0，内容可能已更新 | 仅搜索摘要 |
| S22 | https://github.com/bytedance/deer-flow | DeerFlow 2.0 README | ByteDance | commit `14abd9a28eb0`（2026-11-02T13:36:59Z） | 本机下载原文（raw README） |
| S23 | https://github.com/bytedance/deer-flow/blob/main/docs/task-continuity.md | Task continuity after compaction | ByteDance | 同上 commit | 本机下载原文 |
| S24 | https://github.com/bytedance/deer-flow/blob/main/backend/scripts/benchmark/context_snapshot/README.md | Synthetic context snapshot evaluation | ByteDance | 结果 2026-09-12；同上 commit | 本机下载原文 |
| S25 | https://arxiv.org/abs/2602.02276 | Kimi K2.5: Visual Agentic Intelligence | Kimi Team（Moonshot AI） | v1 2026-02-02，v2 2026-08-07 | 打开原文（摘要 + HTML 片段） |
| S26 | https://claude.com/customers/genspark 及二手报道 | Genspark Super Agent | Genspark / Anthropic 客户案例 | 未核实 | 仅搜索摘要 |
| S27 | https://technode.global/prnasia/skywork-launches-skywork-super-agents-globally-the-ai-powered-office-suite-built-on-deep-research/ ；https://github.com/SkyworkAI/DeepResearchAgent | Skywork Super Agents 发布稿；DeepResearchAgent | Skywork AI | 发布稿 2025-05；仓库无 release | 发布稿仅搜索摘要；仓库打开原文 |
| S28 | https://huggingface.co/blog/MiniMax-AI/aligning-to-what | Aligning to What? Rethinking Agent Generalization in MiniMax M2 | MiniMax-AI | 2025-10-30 | 打开原文 |
| S29 | https://openai.github.io/openai-agents-python/handoffs/ | Handoffs | OpenAI Agents SDK 文档 | 页面无版本 | 打开原文 |
| S30 | https://openai.github.io/openai-agents-python/running_agents/ | Running agents | OpenAI Agents SDK 文档 | 页面无版本 | 打开原文 |
| S31 | https://openai.github.io/openai-agents-python/ref/memory/openai_responses_compaction_session/ | OpenAIResponsesCompactionSession | OpenAI Agents SDK 参考 | 页面无版本 | 仅搜索摘要 |
| S32 | https://developers.openai.com/api/docs/guides/compaction | Compaction | OpenAI API 文档 | 页面无日期 | 打开原文 |
| S33 | 本机 `codex cloud --help`、`codex cloud exec --help`、`codex cloud apply --help` | Codex Cloud 子命令帮助 | OpenAI | codex-cli 0.166.0 | 本机命令 |
| S34 | https://learn.chatgpt.com/codex/import | Import from another agent | OpenAI（ChatGPT / Codex 文档） | 页面无日期 | 本机下载原文（HTML） |
| S35 | https://developers.openai.com/codex/ide/cloud-tasks（重定向到 learn.chatgpt.com/docs/cloud） | Codex IDE cloud delegation | OpenAI | 未核实 | 仅搜索摘要 |
| S36 | https://docs.langchain.com/oss/python/langchain/multi-agent | Multi-agent | LangChain 文档 | 页面无版本 | 打开原文 |
| S37 | https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs | Handoffs | LangChain 文档 | 页面无版本 | 打开原文 |
| S38 | https://github.com/langchain-ai/langgraph-swarm-py | langgraph-swarm-py README | LangChain | 无 release | 打开原文 |
| S39 | https://github.com/langchain-ai/langgraph-supervisor-py | langgraph-supervisor-py README（已归档） | LangChain | 已归档 | 打开原文 |
| S40 | https://docs.langchain.com/oss/python/deepagents/subagents | Deep Agents: Subagents | LangChain 文档 | forked 需 deepagents ≥ 0.7.13 | 打开原文 |
| S41 | https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff | Handoff orchestration | Microsoft（TaoChenOSU） | ms.date 2026-10-15，git `04837f2` | 打开原文 |
| S42 | https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic | Magentic orchestration | Microsoft（TaoChenOSU） | ms.date 2026-09-04，更新 2026-10-06，git `97f6754` | 打开原文 |
| S43 | https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html | AutoGen Swarm | Microsoft | stable 文档；维护模式与 MAF GA 日期据二手来源 | Swarm 页打开原文；维护状态仅搜索摘要 |
| S44 | https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/ | Architecting efficient context-aware multi-agent framework for production | Google（Hangfei Lin） | 2025-12-04 | 打开原文 |
| S45 | https://adk.dev/context/compaction/ | Context compaction | Google ADK 文档 | Python v1.16.0 引入 | 打开原文 |
| S46 | https://adk.dev/sessions/state/ | State | Google ADK 文档 | 页面无版本 | 打开原文 |
| S47 | https://adk.dev/context/caching/ | Context caching | Google ADK 文档 | Python v1.15.0 引入 | 打开原文 |
| S48 | https://adk.dev/artifacts/ | Artifacts | Google ADK 文档 | 页面无版本 | 打开原文（前 100,000 字符） |
| S49 | https://www.infoq.com/news/2026/04/google-adk-1-0-new-architecture/ | Google ADK for Java 1.0 | InfoQ | 2026-04-20 | 打开原文 |
| S50 | https://docs.crewai.com/en/concepts/tasks | Tasks | CrewAI 文档 | 页面无版本 | 打开原文 |
| S51 | https://docs.agno.com/teams/overview ；https://docs.agno.com/teams/delegation | Teams；Delegation | Agno 文档 | 页面无版本 | 打开原文 |
| S52 | https://mastra.ai/docs/memory/observational-memory | Observational Memory | Mastra 文档 | `@mastra/memory` 1.1.0 起 | 打开原文 |
| S53 | https://mastra.ai/docs/memory/working-memory | Working Memory | Mastra 文档 | 页面无版本 | 打开原文 |
| S54 | https://docs.letta.com/guides/agents/multi-agent-shared-memory ；https://docs.letta.com/concepts/memfs | Shared memory（legacy）；MemFS | Letta 文档 | 页面无日期 | shared memory 打开原文；MemFS 仅搜索摘要 |
| S55 | https://a2a-protocol.org/latest/specification/ | Agent2Agent Protocol Specification | A2A Project（Linux Foundation） | 1.0.0 | 打开原文（前 200,000 字符） |
| S56 | https://a2a-protocol.org/latest/topics/life-of-a-task/ | Life of a Task | A2A Project | latest | 打开原文 |
| S57 | https://docs.ag-ui.com/concepts/state ；https://docs.ag-ui.com/concepts/events | State；Events | AG-UI 文档 | 页面无版本号 | 打开原文 |
| S58 | https://modelcontextprotocol.io/specification/2026-07-28/changelog | Key Changes（2026-07-28） | Model Context Protocol | 2026-07-28 | 打开原文 |
| S59 | https://modelcontextprotocol.io/specification/2026-07-28/server/tools | Tools（2026-07-28） | Model Context Protocol | 2026-07-28 | 打开原文 |
| S60 | https://agentclientprotocol.com/protocol/session-setup | Session Setup（v1） | Agent Client Protocol | protocol v1 | 打开原文 |
| S61 | https://agentclientprotocol.com/rfds/client-system-prompt | Client-Provided System Prompt（RFD） | ACP（@wpfleger96，champion @benbrandt） | 2026-10-30 进入 Preview | 本机下载原文（.md） |
| S62 | https://agentclientprotocol.com/rfds/session-fork | Forking of existing sessions（RFD） | ACP（@josevalim） | 未记录日期 | 本机下载原文（.md） |
| S63 | https://agentclientprotocol.com/rfds/session-compaction | Session Compaction（RFD） | ACP（@benbrandt） | 已完成并稳定 | 本机下载原文（.md） |
| S64 | https://agentclientprotocol.com/rfds/mcp-over-acp | MCP-over-ACP: Stateless MCP Requests over ACP（RFD） | ACP（nikomatsakis） | 草案 | 本机下载原文（.md） |
| S65 | https://agentclientprotocol.com/rfds/proxy-chains | Agent Extensions via ACP Proxies（RFD） | ACP（nikomatsakis） | 草案 | 本机下载原文（.md） |
| S66 | https://agentclientprotocol.com/rfds/subagents ；/rfds/message-id ；/rfds/meta-propagation ；/rfds/session-usage ；https://agentclientprotocol.com/llms.txt | Subagent Sessions；Message ID；Meta Field Propagation；Session Context Size and Cost | ACP | Message ID 与 Session usage 已稳定 | 本机下载原文（.md 与索引） |
| S67 | https://agentclientprotocol.com/rfds/updates | RFD Updates | ACP | 仓库 head `971b6cb`（2026-11-02T15:27:53Z） | 本机下载原文（.md） |
| S68 | https://arxiv.org/abs/2503.13657 | Why Do Multi-Agent LLM Systems Fail? | Cemri, Pan, Yang 等（UC Berkeley 等） | v3 2025-10-26 | 打开原文（摘要） |
| S69 | https://arxiv.org/abs/2510.04618 | Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models | Zhang, Hu 等 | v3 2026-03-29 | 打开原文（摘要） |
| S70 | https://arxiv.org/abs/2609.13800 | Do Not Restart: Residual Completion for Stateful Agent Handoffs | Deng, Zhong, Zhao, Zhou | v4 2026-09-26 | 打开原文（摘要） |
| S71 | https://arxiv.org/abs/2610.06069 | Attention Tax, Handoff Tax: A Stylised Model of When Multi-Agent LLM Systems Help | Anchan, Sen | v1 2026-10-05 | 打开原文（摘要） |
| S72 | https://arxiv.org/abs/2602.11510 | AgentLeak: A Benchmark for Internal-Channel Privacy Leakage in Multi-Agent LLM Systems | El Yagoubi, Badu-Marfo, Al Mallah | v3 2026-06-15 | 打开原文（摘要） |
| S73 | 本仓库：`docs/proposals/relay/00-brief.md`、`docs/contracts/context-transfer.md`、`docs/contracts/switching.md`、`docs/domain/invariants.md`、`src/contexts/session/domain/context.ts`、`src/contracts/session.ts`、`src/adapters/control/acp.ts`（337–359、390 行）、`src/adapters/control/claude.ts`、`src/adapters/control/codex.ts` | HarnessHub 现状 | HarnessHub | 分支 `cc/relay-design`，基点 `07a0825` | 本机源码 |
