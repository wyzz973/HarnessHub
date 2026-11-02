# 第一轮调研摘要（机械汇编）

由第一轮 Workflow `wf_80c957ad-f44` 各成员的结构化返回值汇编，未经改写；全文见同目录各报告，引用编号 `[Sn]` 指对应报告的来源表。覆盖审查（critic）的矛盾、弱结论与按问题的覆盖评估在最后。


## R1 市面 Harness（[r1-market-harnesses.md](r1-market-harnesses.md)，来源 73 条）

**结论**：市面已放弃在同一执行者内用“交接”替代压缩（Amp、Cline 都回到了自动压缩），但跨厂商交接正在出现（VS Code、Multica、OpenClaw、Hermes），做法普遍很浅，也没有公开的质量评测。HarnessHub 应以三样东西为核心：由公共事实确定性渲染的有界交接单、按需取回、两个水位（已送达与已派发）；模型摘要只作可选旁路。


### 发现

- “交接取代压缩”在同一执行者内已被放弃：Amp 于 2025-10-23 用 Handoff 取代压缩，2026-05-06 的新 CLI 改回窗口 90% 时自动压缩，并宣布不再提供 handoff [S31][S34]；Cline 在 2026-07-30（PR #12721）把 /newtask 改成 /compact 的别名 [S40]
- 跨厂商交接已经存在，但很浅。VS Code（2026-10）只允许 Local 会话交给 Copilot、Claude 或 Codex；目标宿主不能导入历史时，只附一段“User:/Assistant:”纯文本，取最后 20,000 字符，不含工具调用，前面直接截掉、没有标记 [S49][S50][S51]。Hermes 切到 Codex 运行时只种入尾部 32,000 字符，工具结果预览每条 400 字符 [S9]。continues 默认带最近 10 条消息加工具活动汇总 [S55]。没有找到任何跨厂商交接的质量评测
- 确定性锚点胜过模型转述。Factory 评测中三种摘要法的文件改动追踪都只有 2.19–2.45/5，总分分别为 3.70、3.44、3.35 [S46]。Hermes 自测：机械抽取的锚点索引把针尖事实召回从 23.3% 提到 60.0%；再允许一次检索已归档原文，平均召回 68.3%，高于默认方案的 45.8%，保留 token 只有其 0.30 倍；Codex 真实压缩后为 36.7% [S11]
- 交接单的框架措辞是高危区。Hermes 有四个真实案例：旧摘要指令被当成当前任务执行（#41607）、“Remaining Work”一节悄悄扩大范围（#38364）、“仅供参考”措辞压制工具调用（#65848），以及为此删掉带行动意味的节标题（#69619）[S72]。Claude Code 也有压缩后旧计划复活（#12505）[S25]
- 缓存经济学决定结构。各家的摘要请求都逐字节复用父会话前缀：Claude 约 1/10 价格、产出约 20k tokens 摘要；dsh 只有尾部指令未命中 [S24][S5]。换模型会整段未命中缓存 [S19]。Multica 把每次运行都会变的上下文块从 messages[0] 移到每轮用户消息（MUL-5377），并删掉了没有任何提供方读取的 issue_context.md（MUL-6984）[S53]
- 原生压缩状态不可携带：OpenAI 的 compaction item 不透明、不是给人读的 [S27]；OpenCode 的原生检查点加密，只能用于同一提供方、同一模型 [S29]；Codex 远程压缩有多类故障（#14860、#48232、#15046）[S28]。跨厂商接力只能以 Hub 自己的公共事实为载体
- 原文始终保留，摘要只是派生层；而且“推小拉大”有效：dsh 遮蔽原文、可确定性重放 [S4]；OpenClaw 与 OpenCode 保留全部消息 [S12][S29]；Cursor 总结后给 agent 一个可搜索的历史文件 [S43]；Amp 的 read_thread 子 Agent 会读原文并检查后来是否被修订或回退，把工具调用当作尝试而非结果 [S35]
- dsh 的跨会话引用是最接近 HarnessHub 的现成设计：只读快照冻结 capturedThroughSeq 与格式版本，附固定的不可信警告，转义 `<` 防止伪造标签；每条消息最多引用 3 个会话，每源预算 max(64KiB, 窗口×4×0.2) 字节；截断时附省略统计，并把全文落盘、给出取回提示 [S6]
- Multica 是真正的跨 runtime 任务交接：工作流的每个状态列指定处理者，可以是不同 runtime 的 agent，并附 brief 与 handoff_note。事实以结构化数据存储，提示文本只是渲染；提示预算 40KB，其中说明最多 12KB；超出时丢最旧的事实并附省略通告，要求 agent 用命令行先拉取 issue、评论和运行记录；原生会话无法恢复时给出如实的连续性通告 [S53]
- OpenClaw 的上下文引擎只为被接受的成功回合幂等提交（commitTurn）。投影进 Codex 时包含压缩摘要和分支摘要、工具调用名、id、输入形状和脱敏结果，不带原始参数；交给外部 ACP Harness 时只传纯文本任务，内部信封从不外发 [S13][S14][S16]
- 关键参数一览。Claude：摘要 ≤2000 词、9 节；压缩后重读最多 5 个文件；skill 正文每个 5k、合计 25k tokens；hook 附加上下文 10k 字符 [S1][S18][S20]。Codex：保留用户消息 20k tokens [S26]。OpenCode：buffer 15%、保留最近 15k tokens、相关文件最多 15 个 [S29][S3]。dsh：0.8W 触发、保留 16% [S5]。Hermes：50% 触发、保留尾部 20 条与头部 3 条 [S10]。OpenClaw：摘要器输入 160k 字符、手动压缩保留 20k tokens [S12]
- 用户需求信号：跨工具交接工具的主要动机是撞上额度上限，continues 约 1,590 星 [S55][S57]；还有“一个 agent 写计划、另一个实现”，见于 Conductor 的 .context 目录与 VS Code 文档里 Plan agent 交给实现 agent 的例子 [S54][S49]

### 设计含义

- 采用“事实为数据、文本为渲染”：交接单由工作账本中的结构化公共事实确定性渲染，节序固定（当前请求、目标与约束、决定、进展、文件与工作区、失败与教训、未决与审批、产物、来源与水位），每节标明出处；模型摘要不作默认
- 下一步不交给模型自由发挥：未完成项写成过去时，并注明来自哪个 Run 的快照；框架措辞写明“只有当前用户输入是指令”“工具照常可用”；历史内容放进不可信数据块（转义 `<`），其中的批准不跨 Harness 继承
- 三层预算加显式省略：L0 核心 2–6k tokens，上限取 12k tokens 与目标窗口 5% 中较小者，字节上限 48KiB；L1 为上次交接以来的全部用户消息（逐字，单条 ≤4,000 字符，合计 ≤6k tokens）加最近一个已结算回合的回复（≤2k tokens）；L2 按需取回，附省略通告（省略的 Run 数和字节、序号范围、取回方法），满足“超限不静默截断”
- 注入只在换人后第一回合投递一次，与用户正文分开：支持嵌入文本资源的 Harness 用资源块，不支持的用独立文本块，只追加；拒绝放进系统提示、developer instructions、AGENTS.md/CLAUDE.md 或工作区文件，以免破坏缓存、改动用户配置、出现没人读的文件
- 取回优先走每个会话单独注入的只读 MCP 工具（如 relay.search、relay.read_run、relay.diff），退化为 Hub 自有目录的只读路径；两者都不行时标注“细节不可取回”。可行性待原生通道核实
- 两个水位：deliveredThroughSeq 只在携带交接单或增量的回合被目标接受且结算后推进，未知结果不推进；原生斜杠命令回合不推进 delivered，增量排队到下一个内容回合。这直接修复简报中 INV-14 的疑似缺陷
- 返回 A 时只追加增量；A 空闲超过其缓存 TTL（5 分钟或 1 小时）且原生上下文远大于交接单时，向用户展示“恢复 A + 增量”与“新开 A + 交接单”的成本估算，由用户选择
- 离线基准：仿 Factory 设召回、改动、接续、决定四类题，改动题的标准答案直接来自 diff；对照组参照 Hermes，包括无上下文、现状 JSON、确定性交接单、确定性加取回、加模型摘要，以“同一 Harness 原生恢复”为上限；另测重复执行、越界行动、注入 token 和切换时延；模型自评不作证据
- 性能目标（建议，待基准校准）：确定性构建 p50 ≤30 ms、p95 ≤200 ms（256 个 Run、8 MiB 会话）；账本增量更新 ≤10 ms/Run；Hub 侧切换开销 p95 ≤500 ms；模型摘要模式不进入关键路径（Hermes 实测每次约 37 秒、约 6 美分）
- 拒绝三件事：用“交接取代压缩”作为长对话策略；读取或写入其他 Harness 的私有会话存储（continues 读、casr 写）；把不透明的原生压缩状态当作跨厂商载体。同一绑定内部的长对话交给原生压缩，Hub 只记录它发生过

### 未决问题

- 七个焦点 Harness 是否把嵌入文本资源与用户正文同等对待（尤其 WorkBuddy 和 dsh 的 ACP 资源处理）？能否按会话注入只读 MCP 而不改全局配置？
- 没有 Hub 自有模型时，“精简交接”的模型摘要由谁写：在来源 Harness 里显式跑一个交接回合（消耗用户额度并写入其原生转录），还是由目标 Harness 第一回合自己通过取回工具读？哪种召回更高、成本更低需要基准回答
- 跨厂商交接基准的题库与任务集怎样构造、样本规模多大才有统计意义？
- CJK 文本的 token 估算（dsh 指出 4 字符/token 会低估 CJK）：L0 上限按目标模型计数器还是保守字节上限？
- VS Code 的 migrate 模式究竟迁移了哪些内容（是否含工具调用），会不会成为事实标准？
- Cursor 本地与云端交接、Devin、Jules、Kilo Code 没有一手资料
- 内容跨厂商流动的用户告知与同意要做到什么程度？市面没有可参照的先例
- 返回 A 时“恢复 + 增量”与“新开 + 交接单”的成本与质量权衡，需要真实的缓存命中数据校准

### 风险

- 旧任务复活与范围扩张：交接单里出现祈使语气的“剩余工作”或“下一步”时，接手方会继续做已被放弃的事（Hermes #41607、#38364，Claude #12505）
- 过强的“仅供参考”措辞会压制工具调用，模型只描述不动手（Hermes #65848）
- 静默截尾：VS Code 只留尾部 20,000 字符且无标记，违反“超限不静默截断”
- 摘要叠摘要的漂移，用户原始要求逐渐丢失
- 依赖不透明或加密的原生压缩状态：远程压缩会出错，状态不能跨模型
- 破缓存风暴：每轮在 messages[0] 或系统提示里重注入、高频压缩、在每次都重发的通道里放大段种子
- 空闲或后台压缩带来意外（Claude #98747），没人读的上下文文件（MUL-6984），同一回合重复通告（MUL-5722）
- 逆向私有会话格式很脆弱，还会越过隐私边界（continues、casr）
- 交接阻塞在超长历史上：Hermes 跨平台交接要整段重放、最长等 15 分钟；VS Code 查看会话时重放整段事件日志
- 跨厂商泄露账号记忆或密钥：摘要可能含账号记忆，工具输出可能含密钥
- 把“已派发”当“已送达”推进水位，导致另一 Harness 的工作永远补不进原生会话（简报中的 INV-14 疑似缺陷）
- 只传摘要会丢掉动作里隐含的决定（Cognition 的警告）

## R2 论文（[r2-papers.md](r2-papers.md)，来源 78 条）

**结论**：2024–2026 年的证据一致指向一种接力做法：确定性、类型化、只追加的工作账本，按目标投影成三层交接单（L0 常驻约 4K token，L1 近期原文，L2 按需取用），切换路径上不调用 LLM，并用行为指标校准方向策略。现行做法把整段 JSON 发过去、以 1 MiB 为上限，与长上下文退化和格式方面的证据都相冲突。


### 发现

- 【事实】输入变长本身就会降低表现，至少 8 个独立团队得到同向结果。NoLiMa 测的 13 个号称 ≥128K 的模型里，11 个在 32K 时跌破自身短上下文基线的 50% [S3]。即使检索完美、无关 token 被 mask，长度增长仍带来 13.9–85% 的下降 [S5]。OpenAI 指南指出，用 JSON 装大量文档时表现特别差 [S43]；现行的 buildPublicContext 正是把整段历史 JSON.stringify 成一行 [L1]。
- 【事实】2026 年有了直接研究接手的实证。带上下文的交接使后继的事件数降低 20–59%、prompt token 降低 42–63%；但原始轨迹带来的解决率提升最大，Devstral 上 +14.9 个百分点 [S59]。HSC-Bench 测了 6 个接收方：结构化状态让全部 6 个的证据恢复都提升，续写上 5 个优于只给最近转录，完整历史仍然最好（GPT-5.4：最近 89.73，状态 92.76，完整 94.51）[S60]。
- 【事实】整体重写会让上下文坍塌。ACE 的实例中，18,282 token 被重写成 122 token，准确率从 66.7 跌到 57.1，低于不用上下文的基线 63.7。ACE 改用带 ID 的 delta 并做确定性合并，Agent 基准 +10.6%，91.8% 的输入 token 命中缓存 [S23]。Factory 的锚定式迭代摘要优于整体重写 [S25]。
- 【事实】压缩会蒸发掉规则和元数据。Claude Code 的 /compact 一轮后保留 53% 的安全规则，五轮后只剩 10% [S18]。交接摘要中边界标记的存活率与事实存活率几乎不相关；类型化的受众白名单可把泄露降到 0/48 [S26]。去掉“未核实”的表述后，风险动作批准率从 5% 升到 60%，另一模型从 9% 升到 98% [S27]。
- 【事实】确定性方法不输给模型摘要。observation masking（保留最近 M=10 个观察）与 LLM 摘要的解决率相当、成本约减半，而摘要让轨迹变长 13–15% [S14]。AgentDiet 剔除过期信息，输入 token 降低 39.9–59.7%，表现不变 [S15]。Factory 评测中，三家 LLM 压缩方案的 artifact（文件追踪）维度都最低，只有 2.19–2.45/5 [S25]。
- 【事实】交接方向和历史作者会影响结果，两组独立研究同向。升级时把弱模型的完整轨迹交给强模型，只追回 47%（Claude）和 36%（GPT）的质量差距，Claude 上成本是只用强模型的 2.2 倍，还不如让强模型从头做 [S61]。New Model Old Habits 发现：强→弱时原始历史最好，弱→强时摘要最好；按方向与作者区分的摘要（DASH）在每一格都胜过原始历史 [S62]。
- 【事实】记录了不等于会照做。完成记录就在上下文里，接收方仍会重复已完成的更新，结构化状态下 18 次，对照组 12 次 [S60]。后继会过度相信前任的解释 [S59]。MAST 中最高频的失败是重复步骤（15.7%）和不知道终止条件（12.4%），丢失历史只占 2.8% [S48]。
- 【事实】记忆产品在“新事实覆盖旧事实”上普遍失败。MemoryAgentBench 的多跳选择性遗忘中，多数方法只有 2–7%，最好 28%；Mem0 为 2，Zep 为 3 [S71]。DreamBench-SWE 的更新传播为 0/3 [S73]。各家在 LoCoMo 上的分数互相矛盾 [S38][S39]。Zep/Graphiti 的双时间轴（作废而不删除）提供了可借鉴的数据结构 [S32]。
- 【事实】按需取用的能力因模型差异很大。Context-Bench 上 Claude Sonnet 4.5 得 74.0%，DeepSeek V3 只有 11.97% [S46]。RLM 把上下文当作 REPL 中的变量，能处理超出窗口两个数量级的输入 [S40]。VISTA 向模型展示上下文仪表盘，使 LOCA-Bench 从 22.7% 升到 50.7% [S20]。
- 【事实】Context-Folding 在 32K 活动上下文下得到 BC-Plus 0.620、SWE-Bench Verified 0.580，但未经 RL 时只有 0.420/0.492，低于 327K ReAct [S11]；MEM1、ReSum、AgentFold 也依赖训练。C2C、KVCOMM、LatentMAS 需要读取 KV 或隐藏状态 [S55][S56][S57]，不适用于跨厂商的闭源 Harness。
- 【事实】Sleep-time compute 在同等准确率下把测试时计算降到约 1/5，查询越可预测收益越大 [S41]。提示缓存使 API 成本降低 41–80%、TTFT 缩短 13–31% [S74]。TokenPilot 靠稳定前缀，在连续模式下降低成本 61–87% [S75]。
- 【事实，跨领域】医疗交接 I-PASS 在 9 家医院、10,740 次住院中，采用结构化交接加接收方复述后，医疗差错降低 23%，可预防不良事件降低 30%，交接时长没有显著变化 [S77]。

### 设计含义

- 【建议】账本采用事件溯源，事实分两类来源：Hub 观测的确定性事实（Run 结果、工具、exit code、文件改动与 diff 引用、计划和待办、审批）是主体，Harness 自述（取自 Run 最终回复，或用户选择的“交棒说明” Run）是辅助。两者对齐后渲染，冲突显式标出。每条带 sources、author、verification、audience 字段。依据 [S59][S65][S25][S27]。
- 【建议】账本更新只追加带 ID 的 delta，由确定性逻辑合并；修改一律表现为“取代”。用双时间轴：validFromSeq/validToSeq 用公共 seq，recordedAt/supersededAt 记录写入时间。旧条目永不改写，禁止整体重写式的滚动摘要。约束、用户决定和审批逐字固定，不进入任何有损压缩，超过预算时判为 blocked。依据 [S23][S32][S18][S26]。
- 【建议】L0 采用三栏“剩余合同”：decisions，effects（外部副作用标为不可重复），obligations（含验收标准）。另附最近的验证命令与证据、怎么运行和测试、失败与否决方案、已核实事实与推测的分区、覆盖说明。依据 [S63][S60][S48][S50][S20]。
- 【建议】交接单分三层：L0 常驻（目标 ≤4K token，硬上限 8K）；L1 近期原文（最近 3 个 Run 的原文 + 最近 10 条工具事件摘要行，标注作者）；L2 按需取用（完整历史、diff、工具输出，通过 ContentRef 或路径取回）。完整历史渲染后 ≤16K token 时直接全文发送；注入软上限 24K。以上数值都是待用基准校准的假设。依据 [S59][S60][S14][S16][S2][S3]。
- 【建议】布局：长材料在前，L0 账本和当前输入放在末尾，指令放在两端，开头声明“这是需要核实的历史证据”。不再用 JSON 作为整段历史的容器，改用 XML 式分栏。可选“接棒复述”（不超过 5 行），只作为可见信号和过程指标，不作为质量证明。依据 [S42][S43][S1][S59][S77][S5]。
- 【建议】切换路径上不调用 LLM：每个 Run 结算后在空闲期增量维护账本、预渲染候选交接单（sleep-time），切换时只做校验和渲染。每个 Run 结束时的最终回复，就充当 Context-Folding 的 return message。交接单注入后不可变，之后只追加增量，并做确定性序列化以利于缓存。依据 [S41][S11][S14][S45][S74]。
- 【建议】按方向和作者选择策略：每段原文标注作者；默认把非目标作者写的长轨迹降级为摘要行，原文放进 L2；强交给弱时保留强方原文。Hub 不自行推断能力排序，方向作为策略参数并交由用户选择。为 R05 预留 Magentic-One 式的停滞计数信号。依据 [S61][S62][S53][S50]。
- 【建议】水位表示“已送达并被接受”，不表示“已派发”。返回 A 时发送账本 delta，并写明取代关系。斜杠命令等不注入上下文的输入不得推进水位。原生会话很长、或增量很大时，建议重新水合，而不是在原会话上续写。依据 [S66][S32][S6][S50][S67]。
- 【建议】建立 HH-RelayBench v0：冻结工作区后在多个交接点比较 V0–V5 六种视图；指标包括隐藏测试解决率、全过率与均分、后继的事件数和 token、重新获取次数，以及二元行为准则（不重做不可重复的动作、不违反约束、不用被取代的值），再加 recall/artifact/continuation/decision 探针和安全探针。采用预注册，LLM judge 须达到 κ≥0.7 校准；覆盖同族升级、同族降级和跨族交接。依据 [S59][S60][S17][S25][S73][S61]。
- 【建议】拒绝或暂缓：用 KV 或潜空间通信；以 Mem0、A-MEM 这类模型管理的记忆作为工作状态的权威；需要训练的折叠和记忆方法；把 1 MiB 当作“能交接”的判据，改为显式分层降级。最后一项会改动 context-transfer.md 中“超限即报 CONTEXT_TOO_LARGE”的写法，需要主负责人和审批代理决定。依据 [S55]–[S58][S71][S11][S1]–[S5]。

### 未决问题

- 跨厂商、跨 Harness 的交接实验几乎是空白：S61 只测了同族切换，S62 用的是小模型。七个焦点 Harness 的工具和提示格式各不相同，非原生轨迹的影响未知。
- Harness 加模型的组合之间，“强”与“弱”怎么定义？拿不到能力排序时，方向策略的默认值怎么设？
- 全文直送阈值、L0/L1 的上限、“返回原生会话 + 增量”与“重新水合”之间的切换点，都没有 Harness 级别的文献数字，必须按目标模型实测。
- 叙述部分由谁来写？只用 Run 最终回复是否足够？专门的“交棒说明” Run 成本和收益各多少？会不会破坏“像原生”的体验？
- 接棒复述能否真正提升行为质量？I-PASS 是针对人类的证据。在不信任模型自评的前提下，复述该怎么用？
- 各 Harness 能否用上 L2 按需取用的通道（按会话注入 MCP、文件、嵌入资源）？需要 R1 和原生通道组确认。
- LLM 生成的派生部分只能做到“可追溯 + 可重新生成（不保证结果相同）”，INV-22 的“可重建”需要在契约层重新定义。
- 没有 Hub 自有模型时，如何把隐含决定显式化？外部对工作区的改动如何与账本调和？多跳交接（A→B→C→A）的累积损失有多大？
- 2026 年的多数论文是单组 v1 预印本，需要跟踪是否出现复现或撤回；S28 的实验数字没能在原文核实。

### 风险

- 过度相信交接文本 [S59]，或完成记录就在眼前仍然重做 [S60]。需要声明“这是需要核实的历史证据”、在基准中检查接收方最初的动作、开工前做基线检查。
- 简略偏置与上下文坍塌 [S23]：一旦用 LLM 整体重写，旧摘要就可能覆盖新事实。
- 规则、边界、核实状态在压缩中蒸发 [S18][S26][S27]，而操作事实保留下来，使损失很难察觉。
- LLM 摘要拉长轨迹、掩盖失败信号 [S14]，还会把注入内容“洗白”成交接方的陈述 [S76][S27]。
- 行为迁移与历史陷阱 [S62][S67][S6]：在一个很长的原生会话上续写，可能被旧行为困住。
- 把“窗口放得下”误当作“能用好”[S2][S3][S5]；也把“完整历史总是最好”外推到超出可靠长度的情形 [S59]。
- 只看完成率会把有损交接误判为无损 [S17]；记忆类基准和 judge 本身也不可靠 [S38][S39][S78]。
- 结构化格式对个别接收方有害（Kimi K2 均分下降）[S60]，一套模板不能通用。
- 依赖训练的成果被误用到现成模型上：未经训练的折叠低于全上下文 [S11]。
- 破坏缓存：带时间戳、键序不稳定、每次切换都重新渲染全文 [S45][S74][S75]。在切换路径上调用 LLM，还会增加时延，并有静默使用模型的风险。
- 外推风险：本报告中多数 2026 年的证据来自单组预印本，参数必须先经 HH-RelayBench 复核。

## R3 Super agent 架构（[r3-superagent.md](r3-superagent.md)，来源 73 条）

**结论**：业界在 2026 年收敛到一种交接模型：只有一个写者；推送一份不可变简报，细节放在可取回的句柄后面按需拉取；水位与版本显式记录；历史内容不授予权限。HarnessHub 应当从确定性维护的工作账本投影出分层交接单，只在增量确实送达后推进水位，按“稳定前缀 / 可变后缀”选择注入通道；同时拒绝共享消息列表，也拒绝跨厂商转移原生 thinking 或压缩产物。


### 发现

- 交接单位收敛为“简报 + 句柄”：子 Agent 回传 1,000–2,000 token 摘要 [S2]；Claude Code 子 Agent 只回传最终报告 [S11]；Manus 用文件路径做可恢复压缩 [S20]；ADK 用 artifact 句柄，内容只加载到本次请求 [S44][S48]；DeerFlow 用 history_search / history_read 分页取回历史 [S23]。完整转录只在同模型 fork 时使用。
- fork 还是隔离，在 2026 年成为一等选项，并且有了第一批数字。Claude Code 交互式会话默认 fork [S11]，Deep Agents 从 0.7.13 起提供 forked 模式 [S40]，DeerFlow 提供 context_mode=isolated/snapshot [S22]。DeerFlow 成对评测中，snapshot 的 token 少 15.5%、耗时少 40.3%；但历史与任务无关时 token 多 47.9% [S24]。
- 单写者是可行多 Agent 模式的公约数。Cognition 2026 的结论是写入保持单线程；不共享上下文、只看 diff 的审阅者平均每个 PR 找到约 2 个 bug，约 58% 为严重 [S15]。Claude Code 团队要求每人拥有不同的文件 [S10]。MAF handoff 的接收方取得完全所有权，并且不在不同类型的 Agent 之间共享 AgentSession [S41]。
- 结构化状态归系统所有，模型只做受限的增量写入。长任务 harness 只允许模型改 JSON 清单的 passes 字段 [S3]；ACE 指出反复重写会导致 context collapse [S69]；Letta 的整体重写是 last-writer-wins [S54]；DeerFlow 的笔记最多 8 条、每条 750 字符，并标为 model_report [S23]；Magentic 的两本 ledger 只由 manager 维护 [S42]。
- 来源与权威分离。Claude Code 跨会话消息不能批准权限，其中的 /compact 等命令只作为文本到达 [S12]；子 Agent 报告会被扫描并降权 [S11]；DeerFlow 规定历史消息不授予当前权限 [S23]；ADK 把其他 Agent 的话改写为叙述，并标注工具调用归属 [S44]。
- 缓存是性能的第一杠杆。缓存前缀顺序为 tools → system → messages，改动工具定义会让缓存全部失效；缓存读取价为基础价的 0.025×–0.1× [S9]。Manus 的输入:输出约 100:1，缓存价差 10× [S19]。Claude Code 把系统提示录制到下次 compaction 才更新，snapshot:false 会丢掉该请求的缓存与早期 thinking [S13]。
- ACP 的 Client-Provided System Prompt RFD 于 2026-10-30 进入 Preview：claude-agent-acp 0.92.0 支持 append 与 override，codex-acp 2.3.0 只支持 append，提示变更都在下次 compaction 生效 [S61]。session/fork 可以生成摘要而不污染用户历史 [S62]；compaction_update 已进入稳定协议 [S63]。
- MCP 2026-07-28 去掉了协议级会话：跨调用状态改用服务器生成的显式句柄，作为普通工具参数传递；tools/list 应确定性排序以提高 prompt cache 命中；结果要求带 ttlMs 与 cacheScope [S58][S59]。
- 原生压缩与推理产物不能跨厂商移植：OpenAI 的 compaction item 不透明、为加密内容 [S32]；Anthropic 的 compaction 块带签名，改动即被拒收 [S6]。MiniMax 指出丢掉 thinking 会掉表现 [S28]，跨厂商接力天然会丢掉它，必须把决定与理由显式写下来。
- 接收确认多是传输层回执加验证型核验，没有系统把模型复述当作证据。例如邮箱写入成功 [S10]、送达/暂扣/拒绝三态 [S12]、开局跑 e2e 测试 [S3]。CFRC 的做法是剩余工作被覆盖才放行，同厂商模型对上准确率与全任务 Agent 相当，成本只有其 22.0%–34.6% [S70]。
- 高质量实现都有显式水位或版本。Anthropic 后台 compaction 记录请求时的消息数 n，结果到达后只替换前 n 条 [S7]；A2A 终态任务不可变，改进须开新任务并用 referenceTaskIds 指向旧任务 [S55][S56]；ADK compaction 有 interval 与 overlap [S45]；DeerFlow 的来源 ID 按内容寻址 [S23]。
- 内部通道的泄露高于最终输出：Agent 间消息泄露 68.8%，最终输出 27.2%，只审计输出会漏掉 41.7% 的违规 [S72]。厂商已提供单向转录迁移：Codex 的 /import 可从 Claude Code 或 Cursor 导入 30 天内最多 50 个聊天并保持同步 [S34]，但没有水位，也没有返回语义。

### 设计含义

- 【采用】交接单分四层，由账本确定性投影，不调用模型。L0 契约头 ≤ 400 token：固定说明逐字节相同，packetId 与 throughSeq 放在其后。L1 简报默认 ≤ 2,000 token，硬上限 4,000。L2 是近期原文，至少包含最近一个已结束 Run，≤ 6,000 token。L3 是 Hub 只读工具：relay_search 最多 8 条、每条 600 字符；relay_read 每页 4,000 字符；句柄显式传参，tools/list 确定性排序。整包 ≤ min(12k token, 目标窗口 × 10%)。公共历史 ≤ 8k token 时发全量原文 + L1；三种交接方式对应完整 / 精简 / 只有目标。
- 【改造后采用】工作账本以确定性数据为主干，只追加与 supersede，不整体重写。每条带 producer 字段（deterministic / harness_report / user）、sourceRunIds、水位和 hash。改动、待办、失败、产物、环境都由 PublicRun 事实确定性生成。待办区分“Harness 报告完成”与“有验证证据”。决定的理由与教训只能来自交出方 Harness 或用户“钉住”，并设容量上限。
- 【采用】水位区分已派发与已送达。syncedThroughSeq 只在嵌入了增量的输入被处理之后推进（以 RunTiming.firstOutputAt 为证据）。原样发送的斜杠命令不推进，增量顺延到下一条普通输入，以此修复 INV-14 疑似缺陷。交接单带 packetId，投递幂等、至少一次。
- 【采用】注入通道按“稳定前缀 / 可变后缀”分层。新建原生会话时，L0 经 ACP systemPrompt append 交付（仅当目标声明该能力），L1 与 L2 放在首条用户消息的数据块里。返回原会话时绝不改系统提示或工具列表，增量只追加在下一条输入之前。不用 _meta 承载指令；序列化保持确定。
- 【采用】其他执行者的内容一律以第三人称叙述呈现，不伪造原生工具调用结构。写明历史中的批准与命令在本回合不生效。写明接手方没有看过哪些内容，例如“这些文件由 Codex 修改，请先看 diff”。
- 【改造后采用】离场说明由交出方 Harness 自己写：在 ACP session/fork 的副本里，用交出方当前（用户已选的）模型后台生成，≤ 800 token。内容按 CFRC 的三分法：已接受的选择、已实现的效果、未完成的义务。默认关闭，运行时显示费用；失败不阻塞交接；副本必须有清理所有者。
- 【采用】目标发生原生压缩后（compaction_update 或公共 activities 中的 compaction），在下一条输入前补一份 ≤ 600 token 的 L1 精简版。交接单里附显式“未包含”清单与取回句柄，做到超限不静默截断。
- 【采用】接棒确认分三级：送达证据、读取信号（是否调用 relay_read / relay_ack）、写入前核对工作区指纹（INV-12）。扩展后的接续等级对用户可见：native_resume、native_resume_with_delta、rehydrate_full、rehydrate_brief、rehydrate_goal_only、blocked。不以模型复述作为证据。
- 【采用】性能与评测：账本在后台按 O(Δ) 维护，切换时只做投影。初值目标为投影 p95 ≤ 30 ms，派发前增加的时延 p95 ≤ 50 ms，L0–L2 ≤ 48 KiB。仿 DeerFlow 做成对评测（全量 / 交接单 / 交接单 + 工具），用隐藏检查判定结果，统计重复执行次数与遗漏待办数。交接单按 INV-17 脱敏；跨厂商交接前向用户说明会把哪些内容交给谁。
- 【拒绝】以下三项不采用：共享一份可变消息列表或共享原生会话（MAF 也明确不共享 AgentSession）；跨厂商转移原生 thinking 或压缩产物；当前阶段的并行多写者 swarm。以后如果并行，只允许单写者加只读审阅者，审阅者从干净上下文开始、只看 diff，结论回到写者过滤。

### 未决问题

- 焦点 Harness 中，哪些会把 MCP resources 或按会话注入的 MCP server 暴露给模型？Codex app-server 是否支持 developer instructions？OpenCode、Hermes、OpenClaw、dsh 的 ACP 适配器是否声明 sessionCapabilities.systemPrompt？需要“原生通道”调研核实。
- relay MCP 工具何时挂载：在每个 Hub 原生会话一开始就挂（缓存稳定，但偏离“像原生”、增加攻击面），还是只在发生过交接的会话上挂（返回那一轮缓存全部失效）？
- 各 Harness 能否提供“这条输入已被模型处理”的可靠证据（I-3 的前提）？firstOutputAt 是否在所有焦点 Harness 上都可得、可信？
- 没有 tokenizer 时如何估计目标模型的 token 数？窗口元数据只是声明（INV-16），按它算预算可能偏差很大。
- 用户在自然语言里做的决定，如何不依赖模型提炼就进入账本：界面“钉住”、离场说明提出后由用户确认，还是两者都要？
- 离场说明的费用由谁承担、怎样征得同意？不支持 fork 的 Harness 有没有不污染转录的替代办法？
- 外部改动（例如用户在 IDE 里直接改）只能从工作区指纹看出“变了”，看不出“为什么变”，交接单该怎样表述？
- 评测任务集怎样构造与维护？每轮都用真实 Harness 跑的费用多大？CFRC 的跨厂商结果需要读全文后再决定是否借用其排序规则。

### 风险

- 沿用现状（把全部历史作为用户消息发送）：会话超过 1 MiB 后无法交接；指令与数据混在一起，遵循度低于系统级指令；每次 rehydrate 都冷写缓存，未缓存输入的价格是缓存读取的 10–40 倍。
- 用模型反复重写摘要或账本，会导致 context collapse 与 last-writer-wins，旧摘要覆盖新事实。
- 只把摘要交给写者，写者会做出与之前冲突的隐含决定（Flappy Bird 问题）；接手方还可能误以为自己看过并未读过的文件。
- 把交接内容放进系统级通道，或在交接时改变工具列表：前者扩大提示注入面并混淆权威，后者让整个 prompt cache 失效。
- 伪造或搬运原生工具调用结构，会让历史畸形，而且跨厂商本来就不兼容。
- 依赖接手方主动拉取 L3：模型没有被训练成会主动取数，推送的部分必须单独够用。
- 短会话过度工程：交接税大于收益；把无关历史也推给接手方会多花约 48% 的 token。
- 只审计最终输出：内部通道泄露率是输出的两倍以上；跨厂商流动需要脱敏，并让用户知情。
- 用 fork 写离场说明会在用户的原生会话列表里留下副本；拒绝可能发生在副本已写入之后，需要明确的清理所有者。
- 依赖不成熟的规范：ACP systemPrompt 仍是 Preview、schema 为 unstable，MCP-over-ACP 是草案，Claude Code agent teams 是实验特性，DeerFlow 的 main 分支变化很快。

## R4 内部基线（[r4-internal-baseline.md](r4-internal-baseline.md)，来源 65 条）

**结论**：现有接力只是把已终结回合的对话正文包成“英文说明 + JSON”塞进用户消息：唯一的水位实为“已派发”、1 MiB 闸门又对完整历史计算，导致已合成复现的 P0 缺陷——命令回合吞掉增量、新绑定首条命令吞掉全部历史、一次长回复后同 Harness、切换、恢复全部失败；而 v7 起已持久的工具、差异、错误、执行者与用量事实完全没有进入交接。


### 发现

- 交接材料是英文说明加全部已终结回合正文的 JSON，作为用户消息发出（ACP 的第一个 text block、Codex 的 input[0].text），新对话首轮也被包装（history 为空）；执行者与模型、工具与差异、错误码、计划、用量、产物都不交 [S2][S3][S10][S11][S63]
- throughRunId 的真实语义是“已派发并确认引用”的 Run 下标，不看 backend.status，也不看是否注入了增量；命令回合（含 Codex 的 skill:* 和 ACP 公告的命令）原样派发却照常推进水位，B 的工作永远补不到 A；新绑定首条为命令时此前全部历史丢失；合成复现 R1、R2 已证实 [S3 runtime.ts:1341,1392-1397,1492-1497][S63]
- 预算闸门对完整历史做二次转义后计算（+4 KiB），实测正文上限散文约 1.01 MB、代码约 0.74 MB；由于 execute 每轮先建全量信封，一次长回复后同 Harness 下一轮、任何切换、blocked 后的恢复切换都报 CONTEXT_TOO_LARGE，会话永久停摆（R3、R6）[S2 context.ts:56-58][S3 runtime.ts:1334,1570][S62][S63]
- 增量按 Run 下标取：每次都重复带整段 branchedHistory，从未派发的已取消、切换失败输入也混进来；接续本机会话时 omitted、complete 与执行者归属不告知接手方，构成静默截断（R4、R5）[S2 context.ts:48][S3 runtime.ts:1337-1340][S63]
- 接续等级只是文档概念：PublicContext.continuity 只有 public_context_rehydrate，事件里写死，从不出现 native_resume 或 blocked；界面只显示“从这里起由 X 接手”，不显示交接了什么、等级和余量；CONTEXT_TOO_LARGE 没有中文文案 [S2][S3 runtime.ts:1342,1606][S15][S19][S21:27][S25:54]
- 公共事实可用但不均：tools（含 detail 引用）、error、selection、usage.context、timing 都已持久化；但焦点 Harness 在真实使用中基本拿不到原生 plan，dsh、Hermes、OpenClaw 的差异不全，单轮超过 128 个工具后不再记录，所以改动需要工作区级事实 [S5][S44][S3 runtime.ts:1138]
- 内容存储：工具详情是 JSON（input 头部 16 KiB、output 尾部 64 KiB、diff 64 KiB、locations ≤16），读 0.10 ms/条、写 8.2 ms/条；应用层 ContentPort 没有读接口；回收只认 Session 快照里的引用，新实体不登记就会在 7 天后被删 [S6][S7][S8][S9 sqlite-store.ts:326-341][S62]
- 写放大：每次提交都要整份读、解析、校验、重写快照（解析 0.75 MB 3.1 ms、6.3 MB 23 ms），并对本会话全部事件做 SUM；每次切换保存全部已终结 Run 的 ID，解析随之二次方增长（50 次 18 ms、200 次 53 ms；每轮都带全量来源时 256 轮 158 ms，对照 4.3 ms）[S9][S4 state.ts:359-361,370-373][S40][S62]
- 契约漂移：context-transfer、switching、lifecycle、invariants 都是 proposed；accepted 的 ADR-019（原生命令不注入）与 ADR-020（只补水位之后）组合起来就是 D1；INV-14 有合成测试（session-runtime:605）但没有覆盖命令、超限、origin 等交界情形 [S21][S24:25,27][S31][S32][S48]
- 真实证据缺口：唯一的真实切换用例（Codex→Gemini→Codex）走生产已关闭的受管 Provider 路径；焦点 Harness 上“原生绑定 + 增量”的 A→B→A 从未真实验证；夹具与真实测试依赖信封前缀，改格式必须同步改写 [S45][S56][S57][S64]

### 设计含义

- 把水位拆成 dispatchedThrough 与 deliveredThrough：命令回合、被拒回合不推进 delivered；新绑定的首个 delivered 只能由一次真正带了历史的送达确立；Driver 声明命令对原生上下文的影响（保持、压缩、清空）
- 预算只针对将要送达的内容；完整历史超限时生成分层交接单（常驻、近期、按需），显式列出未包含的内容与水位；切换和恢复的校验不再做全量预算，修好 R3、R6
- 交接单做成独立的不可变实体（ID、来源区间、内容指纹、策略版本），存在 Session 快照之外（新表或内容存储），Run 只存引用；用区间水位取代全量 sourceRunIds 列表，校验降到 O(R+M)；v13 迁移走 ADR-049 备份，并保留 state.ts:340-342 的恢复证据关系
- 确定性层直接复用已持久的事实：执行者与模型、工具摘要与详情（需要新增只读 ContentPort）、错误码、附件与产物、usage.context；改动以工作区差异为准，工具差异只作补充；新实体引用的内容要并入 contentReferences()
- 增量按“目标还没见过的内容”计算：绑定记录原生已含 origin（fork/import）；未派发的输入以结构化条目出现；import 的 omitted、complete、historyRead 显式声明
- 没有历史时原样发送；有历史时优先走原生说明或资源通道（线索：ACP 的 _meta/mcpServers、Codex 的 developer_instructions，待通道调研），用户消息只放用户自己的话；现有 JSON 信封只作回退
- 每个 Run 持久化接续等级（native_resume、native_resume+delta、public_context_rehydrate、native_fork、native_import、blocked）和交接单引用；界面显示交接了什么、未包含什么、预算余量，并在接近上限前预警
- 性能约束：交接构建不新增每个流式窗口的提交，内容写入不进热路径；新增 contextPreparedAt、handoffDeliveredAt 两个阶段，以 RunTiming 测 p50/p95；以合成基线（构建 1.8 ms@857 KB、详情读 0.1 ms/条）为参照
- 测试：保留 session-runtime:605、:791、:864 与 native-experience:44-68，新增 D1–D8 的回归（R1–R6 可直接改写为集成测试）；夹具和 codex-session.real.ts 随格式改写；真实验收改为焦点 Harness 走原生绑定的 A→B→A

### 未决问题

- 各焦点 Harness 在回合被拒或早期失败时，是否已经把用户输入写进原生转录？这决定 W2/D11 要修到什么程度
- 原程序是否用首条消息生成会话标题？JSON 信封是否已经污染了标题和“本机会话”列表？
- claude-agent-acp 等代理是否公告 /clear、/new 一类清空上下文的命令？由谁声明命令对原生上下文的影响？
- 目标模型窗口在首轮之前从哪里得知（模型目录没有窗口字段，只有跑过一轮后的 usage.context.size）？
- 命令回合之后的增量什么时候补交：同回合前置、下一条普通输入之前，还是走非用户消息的通道？
- 交接单实体如何取代 Run.sourceRunIds 与切换的全量来源列表，同时保留恢复证据校验（state.ts:340-342）？v13 迁移如何处理已有数据？
- 工作区事实用 git 差异、文件指纹还是工具事实？非 git 工作区怎么办？
- B 接手时，A 的保留进程及其离开进程组的后台任务如何处理（ADR-030 的单一写入者约束）？
- 回合结尾触到 EVENT_LIMIT 时，是否真的会让整个 Runtime fatal（runtime.ts:1478-1507，仅代码推断）？

### 风险

- 继续以“已派发”作为送达证据：命令回合、被拒回合、清空类命令都会让水位说谎
- 单一字节预算、而且对完整历史计算：把“历史长”误判为“不能送达”，让对话停摆
- 交接与系统说明留在用户消息里：污染原生转录，说明以用户身份出现，其他执行者回复中的提示注入被原样转交
- 把账本或交接单放进 Session 快照、保存全量 ID 列表：每次提交的解析成本成倍上升（实测 10 到 40 倍）
- 依赖原生 plan 推导待办，或依赖工具 kind/diff 推导改动：焦点 Harness 大多不提供，或提供得不全
- 内容写入（约 8 ms/条，含 fsync）进入热路径；读取了内容却不登记引用，被 7 天回收器删除
- 悄悄改信封格式：夹具、浏览器用例和真实用例大面积失效
- 用用户没有选过的模型做摘要，或者把模型自评当作“接住了”的证明
- 只在合成夹具上验证增量：真实焦点 Harness 至今没有原生绑定 + 增量的证据
- ACP 的 session/load 会先回放全部历史，可能主导长会话接力的时延（推断，未测量）

## R5 原生通道（[r5-native-channels.md](r5-native-channels.md)，来源 41 条）

**结论**：七家里只有用户消息是通用通道。按会话的系统层只有 Claude（ACP systemPrompt）与 Codex（developerInstructions），且都在建会话时冻结，只适合放静态接力协议。原生的无回合注入只有 Codex thread/inject_items 与 OpenCode 的 synthetic 文本。按会话 MCP 可覆盖五到六家（OpenClaw 拒绝）。因此建议的组合是：用户消息承载常驻交接单，Hub 自有的只读接力 MCP 承载按需层，再加一个工作区外的 Hub 目录，各家按能力逐步增强。


### 发现

- 用户消息七家通用，都会写进转录、在压缩时被摘要。上限各不相同：Codex 单条 1,048,576 字符（input_too_large）[S21][S20]，OpenClaw 2,097,152 字节且含 resource 文本 [S39]，ACP SDK 单条 32 MiB [S4]。压缩保留量：Codex 最近用户消息约 20k tokens [S24]，OpenCode 尾部 15k tokens [S33]，dsh 保留最新 16%×(W−O) [S35]，Hermes 在窗口 50% 时压缩 [S38]。
- Claude：claude-agent-acp 0.99.1 声明 ACP unstable systemPrompt（append/override），new、load、resume、fork 都接受；该 RFD 于 2026-10-30 进入 Preview [S5][S7][S8]。Claude Code 在首个请求时记录系统提示，resume 时换文本要到下次压缩才生效 [S12][S16]。另有 additionalDirectories，以及 MCP stdio/http/sse [S7]。
- Codex：thread/start、resume、fork 都能按线程带 developerInstructions、baseInstructions 和任意 config 覆盖，不写 config.toml；但已加载的线程 resume 时会忽略这些覆盖 [S19][S25]。稳定方法 thread/inject_items 把 Raw Responses items 追加到模型可见历史、写入 rollout、不开回合，且不校验条目角色 [S19][S23][S26]。
- OpenCode 2.2.5：带 annotations.audience=["assistant"] 的 text 块会经 session.synthetic 成为持久的 synthetic 上下文，不开回合、在 OpenCode 界面里不显示 [S31][S33]。按会话 MCP 只支持 stdio/http，注册为私有服务器的内存覆盖；sse 会被拒绝。仓库验收记录写的“http、sse”与源码和二进制中的 sse:false 不一致 [S31][S3]。
- 按会话 MCP 各家情况 [S7][S31][S35][S38][S39][S26][S27]：Claude 支持 stdio/http/sse；OpenCode 支持 stdio/http；dsh 支持 stdio（绝对路径）/http，resume 也接受，只消费工具；Hermes 只有 stdio，由用户网关持有（最多 16 个、规格不超过 64 KiB、网关重启后须重送、清单冻结进缓存前缀）；OpenClaw 非空即报错；Codex 经线程 config（推断）或实验字段 dynamicTools；MCP-over-ACP 没有一家声明。
- 同一个 resource 块在各家给模型看到的样子不同，仓库能力矩阵有两格已过时 [S7][S9][S38][S39][S35]：Claude 把全文作为 <context ref> 附在消息末尾，0.99.1 起 blob 的图片、PDF 和文本类型也受支持（矩阵仍写“丢弃”）；Hermes v0.22.5 会读取 resource_link 并内联，最多 512 KiB，超出部分截断、注记只写在模型文本里（矩阵仍写“不交给模型”）；OpenClaw 把文本裸拼进消息、没有 URI 头；dsh 直接拒绝 resource。
- 工作区外文件：Claude 默认（Manual 模式）读工作区外要审批，经 additionalDirectories（即 --add-dir）可免审批，但 --add-dir 会加载那个目录里的 .claude/skills、commands、agents [S11][S10]。OpenCode V2 默认放行外部目录，ACP additionalDirectories 会生成会话级 allow 规则 [S31][S34]。Codex、dsh、Hermes 已有真机记录：读取 Hub 只读副本时没有请求审批 [S3]。
- 原生历史导入：Claude、dsh、Hermes 都没有 [S7][S35][S38]。OpenCode 的 session import 是实验 API，会写进用户自己的 opencode.db [S33]。OpenClaw 的 chat.inject 只是追加一条 UI 注记，是否进入模型上下文未核实 [S39]。
- Hub 能触发压缩并带指令的有三家：Claude `/compact [instructions]` [S13]、Hermes `/compress <focus>`（不是 /compact）[S38]、OpenClaw `/compact [instructions]` [S39]。Codex 的 thread/compact/start 和 OpenCode 的 /compact 都不能带指令 [S19][S31]；dsh 经 ACP 无法触发 [S35]。
- 窗口大小没有一家能在建会话前通过协议读到，只能事后获得：ACP 的 usage_update.size、Codex 的 modelContextWindow、OpenClaw 会话行的 contextWindowDefault/contextBudgetStatus [S19][S39][S3]。HarnessHub 驱动目前会丢弃提示之外收到的 usage_update（acp.ts:634–636）[S2]。
- 七家背后都是前缀缓存。Claude Code：订阅主会话 TTL 1h、API 为 5m；系统提示一变整个前缀失效；技能调用以消息追加，缓存安全 [S16][S18]。OpenAI GPT-5.6+：默认 30m、可设 12h，GPT-6.1 Sol 缓存读取价为 0.05× [S28]。DeepSeek：命中价约为未命中价的 1/30，缓存闲置数小时到数天后清除 [S36][S37]。所以只有“追加在会话尾部”对所有厂商都安全。

### 设计含义

- D1 采用：用户消息作为通用基线。用户原话单独放第一个 text 块；交接单放进定界信封，带 handoffId、来源 Run 区间与水位、内容指纹和策略版本（INV-13）。常驻层控制在约 8k tokens 以内，任何增强通道失败都回退到这里。
- D2 改造后采用：系统层只放 Hub 静态接力协议（版本化，约 1–1.5k tokens，各会话完全相同）。Claude 用 systemPrompt append，Codex 用 thread/start 的 developerInstructions；resume 时重送同一份。任何交接内容都不进系统层，以避免冻结语义、整前缀缓存失效和权威抬升。
- D3/D4 改造后采用：Codex 在线程空闲时用 thread/inject_items 注入 role=user 的交接单，之后 turn/start 只放用户原话；OpenCode 用 audience=assistant 的 synthetic 文本。两者都只在真机核实之后启用。绝不注入 assistant 角色的条目，那等于伪造历史。
- D5 采用：Hub 自有的只读接力 MCP 承载按需层（历史、差异、账本）。支持 http 的家（Claude、OpenCode、dsh、Codex、WorkBuddy）连 Hub 托管的回环 HTTP 端点，带每会话短期 bearer，生命周期归 Hub。只有 Hermes 用 stdio，做成无状态 shim。凭据不进 argv。只提供 tools，并标注 readOnlyHint；单次结果不超过约 8k tokens（低于 Claude 10k 警告线与 CodeBuddy 20k 截断线）。
- D6 采用：Hub 目录放在工作区外（relay/<sessionId>/<handoffId>/，只读，内容寻址）。Claude 与 OpenCode 经 additionalDirectories 授权，Codex、dsh、Hermes 按路径读取，OpenClaw 改为内联。目录里不能有 .claude/、AGENTS.md、CLAUDE.md、.git；凡是会交给 Hermes 的文件不超过 512 KiB。
- D7/D8 拒绝：在工作区内建隐藏目录（污染仓库、可能被误提交、会被其他 Harness 的指令发现扫到）。也拒绝伪造原生转录：Claude 的 JSONL、OpenCode session import、Codex 的 assistant 条目、Hermes 的 state.db。
- D9 改造后采用：原生压缩只作为用户可见的可选瘦身步骤（Claude /compact <focus>、Hermes /compress <focus>、OpenClaw /compact <instructions>），不作为交接机制，因为它有损、要额外一次模型调用，还会让会话层缓存失效。
- D10 采用：窗口预算按四级取值——会话中的原生回报、同 Harness+模型最近的观测缓存、厂商文档常量（Claude 1M，DeepSeek 1M 上下文/384K 输出）、未知时用保守值并在界面标明，不静默截断。驱动要改成在提示之外也记录 usage_update。
- D11 采用：缓存友好的布局。静态协议在建会话时写一次；交接单只在会话尾部追加一次；A→B→A 返回时只发增量。估算：在温热的 Opus 5.5 会话尾部追加 8k tokens，30 轮约 22k token 当量，未缓存约 240k。
- D13 改造后采用：Claude 只经 _meta.claudeCode.options.allowedTools 对 mcp__harnesshub_relay__* 做会话级预放行，并向用户明示。D12 拒绝为此改任何用户全局配置；D15/D16 暂不采用 MCP-over-ACP 和进程级覆盖（dsh --patch、OPENCODE_CONFIG_CONTENT、额外目录下的 CLAUDE.md）。

### 未决问题

- Claude：MCP 工具调用在 Manual 模式下是否逐次审批；allowedTools 是否只作用于本会话；resume 时不重送 mcpServers，工具是否会消失。
- Codex：线程 config 里的 mcp_servers 是否真的按线程启动服务器；default_tools_approval_mode 各取值（auto/prompt/writes/approve）的实际含义。
- Codex：inject_items 注入的条目在 thread/turns/list、codex resume 和压缩之后是什么样子；客户端写入的 developer 消息压缩后是否保留（与 RetainClientDeveloperMessages 的关系）。
- Codex：冷 resume 时带新的 developerInstructions 是否生效；实验字段 additionalContext 是否持久化。
- OpenCode 2：synthetic 在 session/load 回放中是否带 audience 注解；压缩时是被摘要还是被丢弃；OPENCODE_CONFIG_CONTENT 的 V2 键名；initialize 中 sse 实际为 false 还是 true。
- dsh：默认权限预设下，MCP 调用和读取工作区外文件是否需要审批；在 ACP 面发 /compact 文本会怎样。
- Hermes 网关模式：编辑器 stdio MCP 由网关启动时用的环境与 PATH；MCP 调用是否走审批；resource_link 内联是否真实生效；/compress 能否原样经 ACP 发出。
- OpenClaw：chat.inject 的注记是否进入下一回合的模型上下文；Gateway 就绪后，桥对读取工作区外文件的工具策略。
- WorkBuddy（CodeBuddy 2.165.0）：接入后的 ACP systemPrompt 映射、MCP 审批与 --add-dir 行为。
- 各 Agent 是否在 session/new 或 resume 时就已发出 usage_update（若发了，只需改驱动不丢弃即可提前拿到窗口）；各家 MCP 客户端访问回环 HTTP 时是否受沙箱限制。

### 风险

- 往已有会话的系统层塞交接内容：Claude 要到压缩后才生效，且整个前缀缓存失效，还把其他 Harness 的产出抬到最高权威，放大提示注入。
- 沿用把全部历史 JSON 作为交接单的现状（上限 1 MiB，约 25 万 tokens）：每次切换都是未缓存写入，并会触到 Codex 1,048,576 字符和 OpenClaw 2 MiB 的上限。
- resource 的处理各家不同（OpenClaw 裸拼、Claude 附在消息尾）：交接单若不自带定界和来源，接手方无法区分用户原话与 Hub 材料。
- 静默截断：Hermes 对超过 512 KiB 的资源截断，注记只写在模型文本里；Claude 的 MCP 结果超过 25k tokens 会被截断或转存文件。Hub 必须在发送前检查尺寸。
- 审批风暴与权限姿态：不预放行时，Claude 每次 MCP 调用都弹审批；全面放行又会改变会话的权限姿态。只应放行 Hub 的只读工具，并且明示用户。
- Hermes 的 MCP 进程由用户网关持有：Hub 无法等待它关闭，网关重启后服务器消失、必须重送规格。
- 回放污染：Claude 的 <context> 块和 OpenCode 的 synthetic 块会在“继续本机会话”导入时，被 acp.ts 的 collect() 当成用户文本。
- Codex inject_items 在有活动回合时会并入该回合，且不校验条目：必须先确认线程空闲，再与 turn/start 串行执行。
- 依赖 unstable 或实验接口（ACP systemPrompt 处于 Preview，Codex dynamicTools/additionalContext 为实验）：必须按能力门控并保留回退路径。
- 交接内容会跨厂商流动（例如 Claude 会话内容交给 DeepSeek 或 OpenAI），秘密必须在 Hub 侧脱敏。
- Hub 目录在某些环境下读不到：Hermes 用容器或 SSH 后端、Codex 有 deny-read 规则、Claude 开了 blockReadsOutsideWorkingDirectories。按需层需要有不依赖文件的回退（MCP 或内联）。

## R6 性能与缓存（[r6-performance-caching.md](r6-performance-caching.md)，来源 32 条）

**结论**：交接单一进入目标的原生转录，就随此后每次模型请求重发：缓存把单价降到 0.025–0.1 倍，但乘上请求次数后，每注入 1k token 的总价仍是基础输入价的 2.6–8.9 倍，所以接力应改用确定性、分层限额（默认不超过 8k）的交接单，并把工作账本单独建表、按 O(Δ) 维护。另外，现有实现每个回合都按完整历史做预算：长对话即使不换 Harness，快照到约 1.5 MiB 也会报 CONTEXT_TOO_LARGE 停摆，这一点已经正式运行时实测确认，必须先修。


### 发现

- 【测量】经真实 SessionRuntime 与 SqliteSessionStore、零延迟假 Harness 复现：runtime.ts:1334 每个回合先对完整公共历史构建并做预算。长回复画像下，快照 1.21 MiB（53 个回合）还能续接，1.50 MiB（66 个回合）时同一 Harness 的普通续接也失败（CONTEXT_TOO_LARGE），之后每个回合都失败。与 R4 的 D3 独立吻合 [S28][S30]
- 【事实】6 个焦点 Harness 都在每次请求时重发完整转录：Claude Code、Codex（store:false；WebSocket 增量发送也按完整输入计费）、Hermes、OpenClaw、dsh（pi-ai）、OpenCode（二手来源）。交接单因此随此后每次请求重发，直到目标自己压缩掉它 [S5][S24][S25][S26][S27][S31][S32]
- 【事实】2026-11-02 核实的价格（美元/百万 token，依次为输入、写入、读取、输出）：Opus 5.5 为 4、5（5m）或 8（1h）、0.20、20；Sonnet 5.5 为 2、2.5 或 4、0.10、10；GPT-6.1 Sol（Codex 本机默认）为 2、2.5（30m）、0.10、10；DeepSeek V4 Flash（dsh 默认）未命中 0.30、命中 0.006、输出 1.20，闲时半价。Haiku 5.5 的提示超过 100k 时按 5 倍计，OpenAI 输入超过 272K 时输入价翻倍 [S1][S9][S10][S29]
- 【事实】缓存规则：Anthropic 最小可缓存长度 512–4096 token（随模型），TTL 为 5m（写入 1.25×）或 1h（写入 2×），最多 4 个断点、回看 20 个位置，换模型全部失效。OpenAI GPT-5.6 及以后至少 1,024 token，寿命 30m 或 12h，写入 1.25× 或 2.5×；更早的模型写入不加价、保留 24h 或内存级。DeepSeek 磁盘缓存几小时到几天、尽力而为。所有厂商都不跨模型、不跨组织共享缓存 [S2][S8][S11]
- 【推断】代价模型（交接后 80 次请求、8k tok/s 预填充）：200 回合时全量历史约 195k token，每次交接 $4.07（Opus 5.5），首回合多约 24 s；结构化交接单 16.6k token、$0.34、约 2 s。由来源 Harness 写摘要，在切换路径上要阻塞 46–105 s。每 1k 注入 token 的总价：Opus 5.5 $0.021，Sonnet 5.5 与 GPT-6.1 Sol $0.010，DeepSeek Flash $0.0008 [S1][S9][S10][S30]
- 【测量】Hub 自身的开销随快照线性增长：每次整份快照提交约 19 ms/MiB；7.6 MiB 时一次窗口提交 144 ms，已超过 ADR-047 的 100 ms 窗口；零延迟假 Harness 下，受理到派发从 0.08 s（0.5 MiB）增长到 1.25–1.41 s（7.5 MiB）；最小回合也有 11 次提交，派发前至少 6 次 [S28][S29][S30]
- 【测量】写放大：整份快照每次提交在 WAL 中写入 1.03–1.05 倍快照大小（8 MiB 时改动 60 B 约 14 万倍写放大）。独立账本表追加 1 KiB 条目只需 0.06 ms（p95 0.75 ms），写入约 8 KiB。事件日志预算查询在 16k 条事件时，每次提交多 7.3 ms [S30]
- 【推断】A→B→A 返回 A 时，以 N_A=150k、Opus 5.5 为例：缓存仍有效时原生续接 $0.055；超过 TTL 后原生续接 $0.78、多约 19 s；新建会话加交接单 $0.063、约 1.5 s。各家 TTL 不同：Claude Code 订阅主对话 1h、API key 5m；Hermes 默认 5m；OpenClaw 默认 short；Codex gpt-6.1 至少 30m；DeepSeek 几小时以上 [S5][S8][S11][S25][S26]
- 【推断】同 Harness 换模型且 N=150k 时，原地换模型一次 $0.375–1.20，多约 19 s 预填充；改用 12k 交接单只需 $0.03–0.10。这与 Claude Code 团队“不要中途换模型，改由子 Agent 接手”的建议一致 [S1][S5][S7]
- 【事实】时延证据：Anthropic 公布 100k 提示的首 token 从 11.5 s 降到 2.4 s；DeepSeek 公布 128K 前缀从 13 s 降到 0.5 s（推出边际预填充约每秒 1–2 万 token）；Copilot 生产轨迹显示回合内 KV 命中 90%、跨回合 55%；HarnessHub 本机测得 Harness 冷启动 1.3–5 s，复用保留进程时 7 ms [S4][S12][S15][S16][S29]
- 【事实】研究共识：随查询变化的压缩会破坏前缀缓存，与查询无关的压缩配合显式缓存最便宜 [S17]；条目化增量更新能避免上下文坍缩 [S19]；后台预计算只在查询可预判时划算 [S18]；KV-cache 命中率是智能体最重要的指标，上下文应只追加、序列化应保持确定 [S21]
- 【测量】构建交接单的各项成本都很小：sha256 128 KiB 用 0.05 ms；读出 2,000 条账本条目 2 ms；读取并校验 500 条工具差异 15 ms；git status 加 numstat 在 3k 个文件上 15–19 ms；精确树哈希约 270 ms；解析一次 8 MiB 快照驻留约 11.6 MiB 堆内存 [S30]

### 设计含义

- 【采用（前置修复）】去掉 runtime.ts:1334 每个回合的全量历史预算（切换校验 1570 同理），只对将要发送的内容做预算；加回归测试：8 MiB 快照上同一 Harness 的续接永不报 CONTEXT_TOO_LARGE。
- 【采用】交接单确定、与下一条输入无关，切换路径上不调用模型。正文存内容存储（sha256 寻址），快照与事件里只放引用、指纹、水位和未包含清单。分档：精简不超过 4k；标准（默认）不超过 8k；完整不超过 32k 且不超过目标窗口的 5%；全量原文只作显式选项，按纯文本分页、先给估算。任何档位都不静默截断。
- 【采用】交接单作为新原生会话的首条用户消息只注入一次；A→B→A 只追加增量 Δ；不重写早先的块，不在每个回合追加状态块（二次方成本）；同一输入重建 100 次必须得到同一个 sha256，开头不放时间戳或随机 ID。
- 【采用】工作账本单独建表（relay_ledger 加 relay_head），在 run.ended 所在的同一个 SQLite 事务里按 Run 追加：O(Δ)，每个 Run 不超过 64 KiB，不增加整份快照提交，最多多 1 条事件，能从公共事实重建。【拒绝】把账本放进快照 JSON（每多 1 MiB，每次提交多约 19 ms），也拒绝由 ADR-047 文本窗口驱动账本。
- 【采用】返回原 Harness 或同 Harness 换模型时，按缓存是否仍有效给出估算：每个绑定记录 lastRequestAt、TTL 类别和 usage.context.used，展示原生续接与新会话加交接单两种方式的费用和时延，由用户选择接续等级，绝不自动改变。【改造后采用】切换后短期保留来源 Harness 的进程（时长不超过 min(TTL, 10 分钟)，每个对话最多 2 个，计入 KEPT_LIMIT），使 A→B→A 的启动从 1.3–5 s 降到约 7 ms。
- 【采用】价格悬崖与窗口保护：派发前估算目标的交接后提示长度，不越过 Haiku 5.5 的 100k 和 OpenAI 的 272K；token 估算按模型族校准（Claude 4.7 及以后约多 30%，不用 tiktoken 估 Claude）。
- 【采用】后台只做确定性账本维护；打开选择器时为候选目标预渲染交接单，并估算 token、费用与时延（CPU 毫秒级）。【拒绝】默认在后台生成模型摘要，也拒绝打开选择器就预启动目标 Harness。【改造后采用】“请 A 写交接说明”作为显式用户动作（普通回合或原生 fork，不超过 2k，标注为派生的模型自述）。
- 【改造后采用（M2 前置）】降低整份快照提交的成本：commit 不再先 load 再在 transact 里读第二遍；按 version 缓存已校验的快照；对已终结且未变化的 Run 跳过重复校验；事件日志字节改用计数列。预期 7.6 MiB 时从约 144 ms 降到约 45 ms/提交；长期改为按行存储，使提交成本为 O(Δ)。
- 【建议】性能目标：交接构建 p50 不超过 5 ms、p95 不超过 25 ms（含不超过 500 条差异时 p95 不超过 60 ms）；接力在派发路径上最多多 1 次提交、CPU 不超过 10 ms；标准档首回合附加时延 p50 不超过 1.5 s；交接后第 2 次请求起缓存命中率不低于 85%；200 回合以内、Opus 5.5 档模型上每次交接不超过 $0.35；账本更新 p95 不超过 5 ms。基准方法：合成会话生成器、真实运行时配零延迟假 Harness 的基准、协议夹具分帧测试、离线 token 校准，以及约 $1 的真实小预算配方（dsh 闲时价加 Haiku 5.5）。

### 未决问题

- 当前模型（Opus 5.5、Sonnet 5.5、GPT-6.1 Sol、DeepSeek V4、OpenCode 免费模型）在 10k、50k、200k 输入下的真实预填充吞吐与首 token 时延，没有可靠公开数据，需要小预算实测。
- 各驱动经 ACP 或 app-server 是否上报 cachedInput 与 cacheWrite；缓存命中率目标能否测量取决于此。
- OpenCode 2.2.5 实际在哪里放缓存标记、用什么 promptCacheKey（只有二手来源），以及免费模型的数据使用条款。
- 订阅额度（Claude Max、ChatGPT Plus/Pro）中缓存读的折算比例：Claude Code 文档写明按缓存价计入额度，Codex 未知。
- 真实的 R（交接后的请求次数）与切换概率 p，需要从 HarnessHub 自身的 RunTiming 与用量统计中取得，决定预计算是否划算。
- 交接单质量与大小的关系（默认 8k 是否合适），需要质量组评测。
- 账本独立表需要业务库升到 v13，迁移、降级与备份（ADR-049）的成本待评估。
- fork() 引用的历史超过 1 MiB 时是否同样失败，未验证。如果失败，对话停摆后连分支逃生也走不通。

### 风险

- 破坏缓存的反模式：每个回合重新渲染早先的块；开头放时间戳或随机 ID；键序不确定；会话中途增减 MCP 工具；原地换模型或换 effort。任何一种都会把读取价变回写入价，并重新预填充。
- 过量注入：“全量”成本按约 5 倍基础价乘以 token 数增长，并带来上下文腐化导致的质量下降，并不更安全。
- 超过 TTL 返回时的隐性成本（N_A=150k 时约 $0.78、约 19 s），且订阅与 API key 的 TTL 不同，估算错误会误导用户。
- 把模型写的交接说明当成事实：可能出现简短偏置或上下文坍缩，必须标注为派生内容并带水位。
- 计时侧信道与跨厂商内容流动：预取与后台摘要会在没有切换意图时扩大流动。
- 用量口径不一致：Anthropic 的 input_tokens 只是未缓存部分；OpenAI 早期模型按 128 token 取整；Codex 不报费用、OpenClaw 是近似值。这些都会让命中率与费用指标失真。
- 价格漂移：几个月内多次调价或促销。价格表必须带日期、集中维护，不写死在代码里。
- 大会话下事件循环饱和：4 MiB 以上每次提交 70–150 ms 且同步执行；接力再加提交或校验会拖慢所有并行对话；写放大造成数 GiB 级的磁盘写入。
- token 估算偏差（中文、代码、JSON 比例不同；Claude 4.7 及以后的新分词器）可能让档位判断越过价格悬崖。
- macOS 上 synchronous=FULL 没有用到 F_FULLFSYNC，掉电时的持久性较弱（推断，与接力无关，转存储组）。

## R7 交接协议与体验（[r7-handoff-protocols-ux.md](r7-handoff-protocols-ux.md)，来源 44 条）

**结论**：高风险行业与成熟软件的交接有四个共同点：固定字段、主体来自持续维护的状态记录、移交时刻明确、接收方主动核验；“看不见的摘要”是长期失败源。HarnessHub 应在每轮结算时维护工作账本，交接时用确定性投影生成交接单，所发即所见，送达后才显示“由 X 接手”，换回时补交并展示期间增量；首次复述只作实验，不作质量证明。


### 发现

- 结构化交接能减少差错且不拖慢交接：I-PASS 在 9 家医院、10,740 次入院中使医疗差错下降 23%（24.5→18.8/100），可预防不良事件下降 30%（4.7→3.3），口头交接时长 2.4→2.5 分钟（不显著）；效果来自助记符、训练、观察反馈的捆绑，不是模板本身 [S1][S3]。
- 让唯一贯穿始终的人在场能拦截有害错误：患者与家属参与的 I-PASS 使有害差错下降 37.9%（20.7→12.9/1000 患者日），总差错变化不显著 [S5]。在 HarnessHub 里，这个人就是用户。
- Joint Commission 认为交接失败的根源是发送方与接收方的预期失衡；它给出最低内容清单，要求化验和生命体征“带日期”，并引用估计称沟通失败与 30% 的医疗事故索赔相关（5 年 1,744 例死亡）[S2]。Arora 发现最常遗漏的是用药、活跃问题和待回报检查，遗漏导致决策不确定和重复检查 [S7]。
- FAA 空管岗位交接 SOP 与 HarnessHub 最同构：接班者先从状态信息区自我简报，只口头交换异常和截至此刻的信息；责任转移时刻明确，并有交接后的复核步骤；运行中的状态一旦可行就记录；交接双方对完整性负同等责任 [S8]。
- 跨行业研究（航天任务控制、核电、铁路、救护调度）发现：四个领域都没有观察到 readback，靠的是面对面交互提问。任务控制交班前写一段话摘要，交接后有 1 小时重叠；关键活动期间推迟转移。交接失败的代价包括丢弃或重做进行中的工作、不当改变已定决定 [S6]。
- 责任转移必须明确且对所有人可见：SRE 要求收到明确确认才离开，并通知所有参与者 [S10]；PagerDuty 公开宣布移交 [S11]；接力规则只看棒的位置，区外交接取消资格，掉棒由掉棒者捡回（4×100 交接区 30 m）[S13]。
- 看不见的摘要招致长期抱怨：Claude Code 压缩时用户只看到一条“已压缩”提示，相关 issue 从 2025-03 延续到 2026-07，#26771 有 22 个 👍，诉求是摘要丢数据、无法查看 [S19][S20]。Cursor 论坛同类反馈持续不断 [S22]。
- 显式交接普遍采用可编辑草稿：Amp 2025-10 以 Handoff 取代压缩，起草新 thread 的提示供用户编辑 [S16]；VS Code 自定义 agent 的 handoffs 默认不自动发送 [S26]。但 Amp 到 2026 年又加回压缩，并用按问题检索、会检查修订的 read_thread 回查原文 [S17]。
- VS Code（2026-10）已支持把会话交接给 Copilot、Claude、Codex 等 harness，但只能单向交出，也不说明携带的是全文还是摘要 [S23][S25]。Codex 的压缩接收前缀让模型“在前任基础上继续”，偏向信任前任 [S21]。
- 2026 实证一：Handoff Debt 发现带上下文的交接让 agent 事件减少 20–59%、token 减少 42–63%；在“已有行为被破坏”时，原始轨迹比仅仓库高 40 个百分点，摘要只高 10–30 个百分点（n=10）。主要失败模式是笔记丢了确切命令或警告，以及过度信任前任 [S33]。
- 2026 实证二：Handoff Tax 发现最优接口随方向反转。升级到强模型时，完整轨迹只追回不到一半差距（Claude 族：原始轨迹 69.3%，丢弃轨迹 72.1%，只用强模型 78.8%）；降级时保留轨迹有利；只声明“前任是不同模型”仅提升 1.2 个百分点 [S34]。
- HarnessHub 现状：交给目标的是英文说明加 JSON 的用户消息，界面不显示发出了什么、接续等级和省略项。contextThroughSeq/sourceRunIds 已解析但未渲染；分隔线只写“接手”。上下文用量环不按当前执行者过滤（推断，未运行验证）[S40]。

### 设计含义

- 交接单固定 7 个字段、固定顺序：状态与风险（最近结果、unknown、未提交改动、后台进程）→ 目标与约束（用户原话、已批准或否决的决定）→ 已完成与证据（按影响排序的改动、最近验证命令、退出码、原样错误行）→ 待办（带 owner）→ 注意与预案（失败过的尝试）→ 来源与水位（ID、throughSeq、未包含内容）→ 接棒要求。空字段显式写“无”，每条事实带轮次、时间和执行者。
- 工作账本在每轮结算时增量更新；切换时只做确定性投影，不调用模型，构建 p95 ≤100 ms。叙述段只在用户显式请求“让交出方写说明”时，由交出方 Harness 用其已选模型写 ≤1 段（目标 ≤400 token，上限 1,600），不静默使用模型。
- 分隔线在交接单“已送达”后才出现，文案为“从这里起由 X 接手 · 接续等级 · 交接单 #N”。之前显示分阶段进度（0.1 秒内出现，超过 1 秒显示阶段与时间，超过 10 秒可取消）；失败不出现分隔线。原生水位按已送达推进，不按已派发推进。
- 不加模态确认（ADR-015）。生效后在 composer 上方显示一行折叠的交接卡片，可展开、编辑、取消勾选、追加附言，并选择交接方式（标准 / 精简 / 完整）。默认零操作；发送时冻结为不可变记录；用户编辑作为来源为 user 的派生层保存。
- 所发即所见：卡片可展开为逐字的发送原文（同一指纹）；原生程序里看到的是可读 Markdown 而不是 JSON。必须可见：当前执行者、接续等级、省略项、失败与 unknown、首次跨厂商、是否被用户编辑；指纹和策略版本放在详情栏。
- 交接方式按确定性信号默认：上一轮失败或取消后切换时用“精简”（目标、约束、文件状态、原样失败证据），避免接收方被前任错误锚定；超出预算时禁用“完整”并说明原因。大内容只给引用、按需取用，读取时标记是否已被后续修订或回滚。
- 交接单开头声明真相顺序：用户原话 > 工作区实际内容 > 工具记录（只是尝试，不是结果）> 叙述（需核验）。保留“不要重复已完成且已验证的工作”，去掉无条件“在前任基础上继续”。
- 接收方综合作为实验：跨 Harness 的公共记录接续时，请接手方在同一回合开头用 ≤3 行写出“接手理解 + 第一步”，约 50–150 token；原生续接且无增量时不加。界面把它与交接单前 3 条要点并排，由用户核对；不计入质量证明，在基准中对比开关时的重做率。
- 换回时（A→B→A）显示“你离开期间”增量卡（轮数、文件 +/−、新待办、失败），同一份增量注入给 A；被他人改过的文件按 GitHub Viewed 失效的方式标记。增量为空时也要显式写出。首条输入是斜杠命令时也必须补交增量或推迟水位。
- 详情栏新增“接续”小节，显示每个 Harness 的已送达水位与交接单历史，并渲染本轮的 contextThroughSeq/sourceRunIds；为以后并行多个 Harness 准备“谁负责什么一眼可见”的视图。疲劳控制：默认一行，只有风险信号才加标记，2 分钟内连续切换合并显示。

### 未决问题

- 同回合 ≤3 行复述能否降低 LLM 接手的重做和重复提问？目前没有直接证据，需要在接力基准中做开关对照，并按跨厂商与同厂商分层。
- 用户是否可以从交接单删除失败证据？删除后接手方是否应被告知“用户移除了某项”？
- 让交出方 Harness 写说明会在其原生转录留下一轮记录，是否可接受？能否改在原生分支中写（依赖各 Harness 的 fork 能力）？
- “上一轮失败”不等于“用户因失败而切换”，是否需要可跳过的“为什么切换”选项来决定默认交接方式？
- “已送达”判定为原程序受理输入还是首个输出？送达状态未知时，界面与水位应如何表现（需原生通道组核实各协议）？
- 换回时增量过大（如 B 做了 50 轮）怎样分层与限额，是否与交接单共用规则？
- 交接卡片放在 composer 上方还是分隔线处，需要原型测试。
- API/SDK 使用方（用户 B）如何在响应与事件里获得交接单 ID、接续等级与省略项？
- Cursor、Devin 的当前交接 UX 缺一手资料。

### 风险

- 交接疲劳：频繁切换时每次都显示卡片会被习惯性忽略，需要默认一行并只在有风险时标记。
- 交接单过长：原始轨迹无上限、噪声大，长交接单既占窗口又没人读。
- 错误被摘要掩盖：紧凑笔记会丢掉确切命令或警告；破坏状态下摘要的帮助远小于原样证据；摘要可能只保留“有过这份数据”的引用。
- 过度信任与锚定：接手方沿着前任的错误路径继续；升级时完整轨迹反而降低质量。
- 用户以为接手方知道其实不知道：现有分隔线只写“接手”，交接内容不可见，属于预期失衡和静默规格漂移。
- 旧摘要覆盖新事实：返回 A 时使用未同步的旧原生上下文（INV-14），斜杠命令首条会跳过增量。
- 模板主义与仪式化复述：把字段齐全或模型复述误当质量证据；用户不读复述，即 hearback 失败。
- 侵蚀像原生：每次切换都往原生转录注入 Hub 文本；JSON 进入原生程序后可读性差。
- 隐私：内容跨厂商流动，摘要或折叠不等于脱敏，用户可能不知道内容会交给另一家厂商。
- 并行与多人同时交接：以后多个 Harness 并行时写权和“谁负责”可能不唯一。

## R8 补调研：送达证据（源码级）（[r8-gap.md](r8-gap.md)，来源 44 条）

**结论**：六家都在第一次模型请求前把输入写进原生历史，Provider 拒绝或超窗不会丢输入；真正让水位说谎的是插入前的接口拒绝、Hub 驱动自己合成的“未发送”结果、插入前的取消，以及清空和回退类原生命令。“已送达”应定义为 Driver 提供的、输入已进入原生历史的正面证据（实时事件、事后核对或结算推断），与回合终态和 dispatchedAt 脱钩。按此判定：R1 D13 与 R3 I-3 有条件成立，R4 D11 与 R7 H3 不成立。


### 发现

- 【事实】六家写入点都在第一次模型请求之前：Claude CLI 先 await 转录写入（100 ms 写队列）再进查询循环；Codex 在 record_user_prompt_and_emit_turn_item 之后才采样；OpenCode 的 runner 只基于已送达的 inbox 消息运行；dsh 的 step 先追加 user/message；Hermes 用 _persist_turn_start 在第一次 LLM 调用前写入；OpenClaw 的提示投影要求用户回合已持久。所以超窗、4xx、限流都不丢输入 [S13][S22][S21][S33][S37][S41][S43]
- 【事实】HarnessHub 推进水位与 backend.status 无关：completed、cancelled、failed（REMOTE_ERROR 被包成 request_rejected）都会推进，只有 backend 为 null 的 unknown 不推进；dispatchedAt 在调用 startText 之前提交，所以 R7 H3 用 dispatchedAt 定义“已送达”是自相矛盾 [S1][S2][S4]
- 【事实】真实丢增量的情形：Codex 的 turn/start 校验错误（如超过 1,048,576 字符的 input_too_large）在尚无 turnId 时被记为 request_rejected 并推进；OpenClaw 驱动选模未确认时合成 model_not_applied（根本没发送）也推进；dsh 的 blocked 和 aborted 报 end_turn；Codex 被 UserPromptSubmit hook 拦截后报 completed，却没有 userMessage [S20][S4][S7][S36][S37][S21]
- 【事实】Hub 已经收到却丢掉了证据：Codex 驱动丢掉 userMessage 条目（codex.ts:706），也不发稳定字段 clientUserMessageId（它会原样回到 userMessage.clientId）；ACP 驱动丢掉 Hermes 每回合 session/load 回放的 user_message_chunk；OpenClaw 驱动回读转录时忽略 user 行，取消回合还跳过回读 [S4][S28][S2][S39][S7]
- 【事实】Claude（claude-agent-acp 0.99.1）在 ACP v1 下不回显用户消息：适配器用 CLI 的 isReplay 回显激活回合后把它丢掉。但会话 _meta.claudeCode.emitRawSDKMessages 可以让适配器以 _claude/sdkMessage 转发原始回显，这条回显在转录写入之后、模型请求之前；适配器还已实现 ACP v2 的插入式 prompt 响应 [S10][S11][S13]
- 【事实】ACP v2 提案定义“受理等于插入”，但明确插入不等于持久化，也不等于模型已消费；OpenClaw 文档同样禁止把 chat.send 的 ACK（status started）当作持久化。受理、ACK、回执都只能算“已受理” [S17][S19][S44]
- 【事实】OpenCode 2.2.5 采用持久的两段式（InboxEnqueued，再 InboxDelivered），ACP 回合只有收到自己的 inbox.delivered 才算 started；session/load 回放不包含 synthetic 消息（既不带注解，也根本不出现），所以 synthetic 通道无法事后核对。【推断】插入前取消的提示会作为持久 steer 留下，并在下次唤醒时被送达 [S32][S33][S34]
- 【事实】Codex 中断时先记录 <turn_aborted> 标记并 flush，再发 TurnAborted；多数早退路径会先记录输入再返回；rollout 写入只 write 加 flush，不 fsync，新线程要等第一次 Persist 才物化。dsh 的 live 事件最多缓冲 200 ms 再 fsync，Claude 转录写队列为 100 ms [S24][S21][S25][S38][S13]
- 【事实】清空和回退类原生命令真实存在：Hermes 公告 reset（清空）、undo 与 retry（删除最近回合），并路由 new 与 clear；OpenClaw 公告 /new（归档后新开）和 /reset；Claude CLI 的 /clear（别名 reset、new）可在非交互模式执行，适配器虽不公告，但 Hub 在没有新增来源时会原样发送它。R4 D18 应从 P3 上调到 P1 [S39][S42][S44][S13][S10][S1]
- 【事实】Hermes 的准入以（主体、会话、input_id）为持久身份，失败时返回 admitted_turn_failed、结果未知时返回 unknown_execution；Hub 杀掉的是查看器，【推断】网关里的回合会继续运行 [S39][S40]
- 【判定】R1 D13 有条件成立（“接受”必须改为正面证据，且不能挂在结算上）；R3 I-3 有条件成立（packetId 与至少一次投递可用，但 firstOutputAt 既不必要也不充分，Claude 在插入前可能先发 plan）；R4 D11 不成立（completed 既不充分也不必要，按 Driver 的静态声明区分不了插入前后）；R7 H3 不成立（dispatchedAt 本身就是“已派发”） [S1][S9][S10]

### 设计含义

- 【建议】采用三级送达证据并与终态脱钩：E1 实时事件 input_recorded、E2 事后核对 verifyDelivered(marker)、E3 Driver 的结算推断 BackendResult.input；只有带增量的输入取得 recorded 证据，deliveredThroughSeq 才推进，dispatchedThroughSeq 只用于诊断；没有证据记为 unknown，不记为 not_recorded
- 【建议】Driver 能力声明不出现产品名：delivery { live: recorded_event|agent_output|none, verify: after_turn|on_next_open|costly|none, successProvesRecorded, unlistedSlash: executed|text }，命令目录增加 contextEffect（keep|none|compact|clear|rewind|unknown）
- 【建议】Codex：clientUserMessageId 填公共 runId，userMessage 条目作 E1（零额外 RPC），thread/turns/list 作 E2；尚无 turnId 时的 REMOTE_ERROR 标 not_recorded
- 【建议】OpenClaw 把回合后 sessions.get 中 seq 之后的 user 行纳入 E2，并扩展到 cancelled 与 failed 回合；Hermes 在下一回合 open 时用已收到的 load 回放核对，为此 Runtime 要把增量计算挪到 open 之后（runtime.ts:1334–1340 移到 1376 之后），额外成本为零
- 【建议】Claude：E1 用 _meta.claudeCode.emitRawSDKMessages=[{type:"user",origin:"human"}] 拿原始回显（需真机）；E3 规则为 end_turn 或带 errorKind 的错误即已写入；E2 读本会话 JSONL 尾部。OpenCode：非命令回合的 end_turn 即已写入，取消和错误记 unknown；dsh：本回合第一条 agent 输出作弱证据
- 【建议】命令回合与 Driver 合成的结果（notSent、/remote-control、各家 /export、COMPACT_IGNORED）一律不推进 delivered；clear 把 delivered 清空并递增 nativeEpoch，rewind 和 unknown 把 delivered 置为未知；unlistedSlash 为 executed 的 Driver（Claude）遇到目录外的 /name 按 unknown 处理
- 【建议】只在 unknown 时至少一次重发：沿用同一个 relayPacketId，L0 写明“已见过可忽略”；重发只附在用户下一条输入上，不自动重跑（符合 INV-11）；核对超时 2 s，OpenCode 的全量 load 预算 5 s
- 【建议】分隔线随证据出现：有 E1 时在第一个 token 前画；没有 E1 的 Driver 在 E3 或 E2 到手后画；结算后仍为 unknown 显示“交接未确认，下一条会再次附上”；交接标记放在第一段 text 块，不只放在 resource 或 synthetic 里
- 【建议】P0 最小修复顺序：① 命令回合与合成结果不推进；② REMOTE_ERROR 分插入前和插入后；③ 声明 Hermes、OpenClaw、Claude 清空和回退命令的效果；④ 信封加 relayPacketId；⑤ 依次接入 Codex 的 clientId 与 OpenClaw 回读，再做 Hermes 的 open 后核对，最后做 Claude 的原始回显

### 未决问题

- Claude 的 emitRawSDKMessages 过滤器在真机上是否放行本回合的 isReplay 回显，回显是否稳定早于第一个流式事件，打开后是否改变回合行为
- Claude 原样执行 /clear 后，ACP 与 CLI 会话 id 怎样变化；保留进程和重启进程两种情况下原生上下文是否一致
- OpenCode 插入前取消的提示是否真的会在下次唤醒时被送达（僵尸输入）；stdio 私有服务器是否扫描残留执行认领并自动续跑
- Codex legacy 历史模式下回读是否带 clientId；thread/inject_items 注入的条目在 turns/list 中是否可见，有活动回合时注入的条目去向如何
- Hermes 查看器被杀后网关回合是否继续并正常结算，下次 load 时怎样报告这个准入
- OpenClaw 桥默认加的 cwd 前缀是否让网关识别不出斜杠命令；cancelled 回合的 user 行是否一定会补写
- dsh 实际使用中 blocked 与 aborted 出现的频率；第一条 agent 输出之前是否可能已有其他更新
- Hub 信封的 1 MiB 字节上限与 Codex 的 1,048,576 字符上限如何对齐（建议由 Driver 声明单条输入上限）；pendingPacket 与 nativeEpoch 如何进入 v13 迁移

### 风险

- 把受理当持久：ACP v2 的插入、OpenClaw 的 ACK、Hermes 的回执、Codex 的 turn/start 响应都不证明已写入
- 把成功当写入（dsh 的 blocked 报 end_turn、Codex 被 hook 拦截报 completed），或把失败当未写入（Provider 错误时已写入，重发会重复注入）
- 静默丢块：Claude v1 丢 audio 与不支持的 blob，OpenCode 丢 audience 为 user 的文本，OpenClaw 丢非图片 blob；只放在资源块里的交接内容可能没送到
- OpenCode 的 synthetic 不回放、无法核对，prompt 失败或取消后会滞留在 inbox；受管服务还可能自动续跑残留回合，与 INV-11 存在张力
- 清空和回退命令（Hermes 的 /reset、/undo、/retry，OpenClaw 的 /new、/reset，Claude 的 /clear）让水位反向失真，接手方实际已失忆
- 进程被杀的窗口：Claude 不超过 100 ms，dsh 不超过 200 ms，Codex 新线程在第一次 Persist 之前
- 核对时读取原生转录只能做标记匹配，不得把读到的内容回灌到公共事实或交接单，以防提示注入和跨厂商泄露
- 所有结论都没有真机证据；Claude CLI 是压缩代码，OpenClaw 是打包产物，相应条目的置信度为中或中高

## R9 补调研：跨 Harness 外部证据与评测设施（[r9-gap.md](r9-gap.md)，来源 34 条）

**结论**：叙述化的默认做法有一手工程佐证：OpenAI 自己的 Codex /import 把外来工具调用扁平化成带标记的文字，zen 也这样做，而原样搬运结构的工具（Harbor ATIF 加载、session-migrate）只做过能否加载的验证，所以叙述化重述应保持默认。但还没有任何实验比较两种做法，需要 HH-RelayBench 增设 V5a/V5b 对照来量化。Harbor（Apache-2.0）适合拿来离线校准交接单写什么、写多少，不能代替 HH 自身通道和水位的真机验收；ATIF 和 Agent Trace 只能用来导出或借用部分概念，账本的中立层应采用 TRACEPROBE 那样的规范动作类别加效果标签。


### 发现

- 【事实，源码】Codex /import（main 8806313db4）不搬运原生结构：Claude Code 的 tool_use 写成带标记的文字 [external_agent_tool_call: 名称]，只取 description/command/file，其余输入截到 2,000 字符，结果截到 4,000 字符；thinking 丢弃，子 Agent 不导入。来源只扫描 30 天内的 50 个会话。增量同步时，只有目标线程的模型可见转录恰好是源的前缀才追加，否则 fail closed。另有一个 <EXTERNAL SESSION IMPORTED> 标记，但只写成界面事件，模型看不到 [S27][S28]
- 【事实】zen 从 Codex 迁到 Claude 时，只把 shell 类调用映射成原生 Bash，其余写成 [migrated_tool_call] 文字，理由是“历史里的未知工具名比带标记的文字更让模型困惑”，并在开头加来源前言（声称能减少困惑，没给数字）。它也记录了格式陷阱：assistant 记录缺 model 字段会让 claude --resume 挂起；会话文件超过 5 MiB 时只读最后一个压缩边界之后的内容 [S26]
- 【事实】Harbor 的 ATIF 加载只支持 Claude Code 和 Codex 作接收方，把外来工具名原样写成原生 tool_use/function_call，验证只做到 hello 回忆题；WORKDIR 不是 /app 时种入失败（#3560，未合并）。session-migrate 支持 324 条转换路线，工具名原样映射、不做脱敏，只验证到能加载、能追加回复 [S4][S8][S9][S25]
- 【事实】ATIF 当前是 v1.8，不是简报说的 v1.6：工具名不规范化，arguments 必须是对象；它提供 is_copied_context、continued_trajectory_ref、context_management 等约定。Phoenix 读取 v1.0–1.7，NeMo Relay 是导出 v1.7 的生产者，不是读取方 [S2][S11][S12]
- 【事实】Harbor v0.25.0 自带 Claude Code、Codex、OpenCode、Hermes、OpenClaw 的适配器，ACP 注册表还有 codebuddy-code；dsh 没有适配器。多步任务的步间就是 Run 边界：工作区保留，测试可放在独立验证环境里隐藏。有 artifacts 快照和任务级 MCP，但一次 trial 内不能换 agent，环境也只有 Linux 容器 [S6][S7][S10]
- 【事实】AgentBaton（2026-10，跨厂商模型，同用 mini-SWE-agent）：弱交给强时，把历史放进日志文件让接手方去读，普遍好于放进上下文，而且更便宜。DeepSWE 75% 交接点上，Qwen→GLM 38.9→53.1，Qwen→Kimi 37.2→50.4（每题 $5.76→$2.52）。强交给弱时，放进上下文常更好，例如 Kimi→Qwen 69.9 对 56.6 [S18]
- 【事实】DCAS（ASE '26）：脚手架的规划约定和工具调用格式会实质影响结果。SWE-Lego-Qwen3-32B 在 OpenHands 上 52.6%，换到 OpenCode 只剩 8.4%，因为工具调用格式不兼容，几乎没有可解析的动作。更强模型给出的显式计划把执行模型从 42.8 提到 57.8（+15 pp）；用翻译代理接入 Codex v0.118 失败 [S15]
- 【事实】Fail-Fast/Restart-Smart：重启时不带历史，只把中断时的 diff 作为可开关的覆盖层，结果好于冷重启（Qwen3.6-27B：71.8 对 66.8）。在编辑还没完成处切断，本可通过的运行被误杀 18.8%，等编辑完成再切只有 8.8%。提示干预反而让强模型从 66.6 降到 63.4 [S17]
- 【事实】TRACEPROBE 把 Claude Code、Codex、OpenCode 的 2,500 条轨迹确定性地归一到 9 类动作和 7 种效果标签，并给出 search loop 与 re-read churn 的明确定义。Inside the Scaffold 分析 13 个开源脚手架：读、搜索、编辑、执行四类能力趋同，编辑格式各不相同。CORVUS：读文件的旧结果会过时，改为同步的文件登记表后，输入 token 降低 9–50% [S13][S14][S16]
- 【事实】Routed Graph Handoff（EMNLP 2026）：结构化交接没有配解读说明就没有增益，只用图让 AppWorld 下降 14.6 pp。Interface-Induced Trajectory Censoring：只换服务适配器，BFCL 从 0.00 变到 0.96，说明格式不匹配会让工具调用静默消失 [S19][S20]
- 【事实】没有任何宿主支持会话中途换另一家厂商接手再交回：Zed 只能把外部 agent 的线程导入历史；JetBrains 文档没写切换后上下文是否带过去；Warp 的 /handoff 只在同一 Harness 内由本地交给云端，会带上未提交和未跟踪的文件；Antigravity 只在同一 Harness 内换模型，当前回合的步骤结束后才生效 [S30][S31][S32][S33]
- 【事实】Agent Trace 是 v0.1.0 RFC（2026-01，CC BY 4.0），参与方有 Amp、Cognition、OpenCode、Jules 等。行号以记录时的 VCS revision 为准，删除无法表达；cursor/agent-trace 仓库在阅读时返回 404 [S23]

### 设计含义

- R9-1【采用，细化 R3 I-5 与 R1 D5】外来工具调用一律重述为陈述句，例如“Codex · Run 3 · 执行：`npm test` → 退出码 1”。命令、路径、退出码、错误摘录逐字保留；原生工具名只作归属注记；不输出 JSON 调用对象或任何 tool_use 结构；标记要转义防伪造。预览上限沿用 ≤400 字符，全文走 ContentRef 拉取
- R9-2【采用】交接单开头加一段字节固定的来源前言给模型看：谁、哪个模型在另一个程序里做的，工具与你不同，记录只读不可调用，需对照工作区核实。给用户看的卡片另写，两者不能互相代替
- R9-3/R9-4【改造后采用】账本记录规范动作类别（9 类，由 PublicTool.kind 确定性映射）和效果标签：交接时用新增块的内容哈希比对工作区，算出 survived、reverted、failed、unknown。改动与归属只渲染到文件级：谁、哪一轮、增删行数、是否仍然存在；行级归属与 diff 原文走 L2 拉取
- R9-5【改造后采用】借鉴 CORVUS，交接单给文件登记表（路径、最后读者、最后写者、交接时指纹），不推送读文件的旧结果；返回 A 时加注“这些文件在你上次看过之后已被改动”
- R9-6【采用】最新的 PublicRun.plan 快照作为一等内容，写成陈述句，标明作者（Harness 与模型）；来源方较弱时加注“请重新评估”（依据 DCAS 的 +15 pp）
- R9-7【改造后采用】原始轨迹改为 AgentBaton 式的 JSONL 交接日志（每个 Run 一条），经 relay MCP 或只读路径按需读取，并提示先看末尾。推送量随方向调整：弱→强时 L1 收紧到 ≤2k token，强→弱时放宽到 ≤6k token
- R9-10/R9-11【改造后采用】用 Harbor 搭 HH-RelayBench v0，只校准交接单的内容策略。规模约 36 题（24 个三步编码题 + 12 个陷阱题），72 个交接实例，3 个接收方（Claude Code+Haiku 5.5、dsh+deepseek-flash、Codex+gpt-6.1-sol），视图 V0–V6，其中 V5 拆为 V5a 原样移植与 V5b 扁平化全文。约 1,650 次运行、$250–800；pilot 约 $15–45。用 McNemar/Wilcoxon 检验加 Holm 校正，按接收方分别报告
- R9-14/R9-15【改造后采用/拒绝】ATIF v1.7 只作派生的只读导出：每个原生绑定区间一个文档，用 continued_trajectory_ref 串起来，引用历史标 is_copied_context，压缩写成 boundary:"opaque"。不把 ATIF 用作账本或交接单 schema：它缺取代关系、出处、受众、水位和单条事实指纹
- R9-17/R9-18【采用】省略账目只记类别与计数，不记内容，同时展示给用户和模型。返回 A 时核对已送达材料的指纹链是否仍是原生历史的前缀；发现分叉就降级为“新开 + 交接单”，读不出历史则标为未核实
- R9-9/R9-19【拒绝】不把结构化轨迹 JSON 原样推送给接手方；不写入目标 Harness 的私有会话存储，包括 Codex 的 externalAgentConfig/import：它只收 Claude Code/Cursor 的文件、限 30 天与 50 个、写入 ~/.codex，且同类做法都很脆弱

### 未决问题

- 闭源前沿 Harness 之间，“扁平化文字”与“原样移植”的续做质量差多少，目前没有任何公开实验，只能由 HH-RelayBench 的 V5a 对 V5b 回答
- dsh 的 ACP 事件够不够生成 ATIF？给 dsh 写 Harbor 适配要多少工作，能否支持 resume？
- “强”与“弱”怎样判定：HH 没有统一的能力表，方向默认值只能先按模型档位加用户覆盖
- 交接日志改为拉取后，各 Harness 的模型会不会主动去读？在不过度指导的前提下，拉取率能否达到 AgentBaton 的水平？
- 在 Harbor Linux 容器里校准出的内容策略，搬到 HH 在 macOS 上的 ACP 资源块与 MCP 通道后是否仍然成立？需要真机子集校准“ATIF→公共事实”转换带来的误差
- JetBrains 切换 agent、Antigravity 切换模型时历史如何处理，没有一手文档
- Agent Trace 还在维护吗（仓库 404）？Cursor 是否改用其他规范？
- AgentBaton 没有“只给工作区”的基线，日志与工作区各自贡献多少不清楚，可用 V0 对 V6 补上
- boundary:"opaque" 这类 ATIF 扩展值，Phoenix 等消费方是否接受

### 风险

- 原样搬运外来工具结构：会出现目标没有的工具名；悬空的 tool_use 会被 API 拒收；格式与解析器不匹配会让行为静默消失；会话文件缺字段或超过大小上限时会挂起或被截读 [S15][S20][S26][S29]
- 把“能加载、能复述哨兵”误当作接力质量的证据 [S9][S25][S29]
- 凭据外泄：session-migrate 不脱敏；Harbor 可能把 ~/.codex/auth.json 上传进容器；评测必须用独立且设了消费上限的 API key
- 在编辑未完成处切换：被取消或结果未知的 Run 可能留下半截改动，必须明确标注
- 提示指导过强会伤害强模型（−3.2 pp）；结构化内容没有解读说明就没有增益（−14.6 pp）
- 多数证据来自开放权重模型或 mini-SWE-agent，外推到 Claude Code、Codex 等闭源 Harness 不一定成立
- 依赖不成熟的规范：Agent Trace 仓库 404；ATIF v1.7 有破坏性变更；Phoenix 不支持 v1.8；Harbor 修复 #3560 仍未合并
- 评测混杂：只在单一脚手架上评测、由 LLM 给的语义标签不稳定、接口问题会让工具调用计数失真；应优先用确定性判定
- 推送原始轨迹会抬高成本：AgentBaton 中弱→强时上下文内的成本可达日志方式的约 2.5 倍，准确率反而更低

## 覆盖审查


### 报告之间的矛盾

- 【“已送达”的判据】四份报告各说一套。R1 D13：承载交接单的回合被接受并结算后才推进。R3 I-3：Run 有 firstOutputAt 就推进；状态不明时按 packetId 至少一次重发，再请模型忽略重复，去重落在模型行为上。R4 D11：backend.status=completed，或由 Driver 声明失败回合也会写入转录。R7 H3/4.4：分隔线按 dispatchedAt 出现，并把“首轮进入 running”算作接棒完成；若按 Hub 的 Run 状态理解，runtime.ts:1389 在派发之前就置为 running，R7 的判据比现行有缺陷的“已派发”还早。按 R4 的判据，被取消但输入已入转录的回合会被重复补交；按 R3 的判据，在首个输出前被拒的回合会漏交。需要按各家事实裁定（补调研 1）。
- 【接棒复述】R2 R2-12 要求首个回复先用 ≤5 行复述；R7 H7 只在公共记录接续时、在同一回合内写 ≤3 行（实验）；R1 D16 默认不加确认回合，复述只用于评测；R3 I-10 用三级确认，不用复述。R7 自己引用的 Patterson 2004 在四个高后果领域都没有观察到 readback。复述还直接关系到“像原生”，需要定一个默认。
- 【预算与“完整”档】L0 上限：R1 目标 2–6k，硬上限 min(12k, 窗口 5%)；R2 目标 ≤4k，硬上限 8k；R3 是契约头 ≤400 加简报 ≤2k，硬上限 4k。全文直送：R2 在 ≤16k 时直送，R3 在 ≤min(8k, 整包上限) 时直送，R6 只在用户显式选择时提供。整包：R3 ≤min(12k, 窗口 10%)；R6 标准档 ≤8k、完整档 ≤32k 且 ≤窗口 5%；R5 给 Claude 的常驻层 ≤8k。默认档位与阈值没有统一。
- 【默认保真度】R3 D1 认为接力把写者身份交给了目标，应按 Cognition 原则交付尽可能完整、忠实的上下文；R2 R2-18 默认把非目标作者写的长轨迹摘要化；R7 H10 在上一轮失败或刚取消时默认降为“精简”。R7 自己引用的 Handoff Debt 诊断数据却显示，在“已有行为被破坏”状态下，原始轨迹比只给仓库高 40 个百分点，摘要只高 10–30 个百分点（每视图 n=10），H10 与这份证据方向相反。
- 【布局与通道】R2 R2-11 要求长材料在前、当前输入在后、指令放两端；R7 4.2 把“状态与风险”放第一栏；R5 4.2 对 Claude 推荐用户原话作第一个 text 块、交接单作 resource。我核对了 claude-agent-acp 0.99.1：acp-agent.js:10358 生成 <context ref> 块，随后 content.push(...context) 把它追加到整条消息末尾，交接单因此排在用户输入之后，与 R2 的布局和 Anthropic 的长上下文建议都相反。要么改用放在用户原话之前的普通 text 块，要么在交接单末尾重述当前输入，需要二选一。
- 【账本写入时机】R6 #14 在 run.ended 所在的同一个 SQLite 事务里追加；R1 D7 也是与事件同步提交；R3 I-13 在业务事务之外异步更新；R2 R2-14 在空闲期预构建（sleep-time）。这个取舍决定账本水位能否与 Session 原子一致、“先提交再发布”怎样适用，以及崩溃后由谁重建。
- 【系统层通道放什么】R5 D2 只放跨会话逐字节相同的静态协议，不放任何交接内容；R1 D11 也拒绝把运行级内容放进系统提示或 developer instructions。R3 的 L0 契约头在 I-1 中含 packetId、throughSeq、来源指纹等每次交接都变的值，I-4 却称 L0 是固定文本，并建议经 systemPrompt append 交付，前后不一。Claude 在首个请求记录系统提示、直到下次压缩才换，Codex 已加载的线程 resume 时忽略覆盖（R5 核实）；变量一旦进入系统层，同一会话第二次接手时就会过期。
- 【Handoff Tax 的接口】R2 把 Compact 写成“压缩前缀或后缀”，R7 推断为“交出方写摘要 / 接收方写摘要”。原文 3.1 节是后者：两种 Compact 都压缩完整前缀轨迹，区别只在由前任模型还是接手模型来写。R2 的描述有误。两份报告的数字都对，只是来源表不同：R2 用表 1（Raw 69.2%/$1.61，Traj-drop 72.4%/$0.81，Abort+HC fresh 79.2%/$0.90），R7 用按重算交集的表 7（Raw 69.3%/$1.62，Traj-drop 72.1%/$0.94），引用时应注明表号。

### 证据偏弱或有误的说法

- R2 多处（§0 第 6 条、P6、R2-04、风险表）称：完成记录就在上下文里，结构化状态下仍重复 18 次，对照组 12 次。核对 HSC-Bench 原文（表 9、§5.4）：18 对 12 是全部工具类任务的同目标重复次数；在两种视图都明确保留了完成记录的 19 题子集里，114 次结构化接续只有 2 次重复，最近转录为 0。“记录不等于行为”有证据，但量级被夸大了。
- R2 把 HSC-Bench 和 Handoff Debt 当作“确定性投影”的证据（§0 第 2、4 条，P3）。HSC-Bench 的结构化状态由 GPT-4.1 生成（JSON，≤4,000 字符，至少压缩 5 倍），Handoff Debt 的结构化笔记也有 7 个模型字段；它们证明“结构化优于叙述”，不能直接证明“无模型的确定性投影够用”。R2 §0 第 2 条又把 Handoff Debt 中任一带上下文视图的降幅（事件 20–59%、token 42–63%）记在“结构化交接状态”名下，与其正文 2.7 不一致。另外 Kimi K2 的均分降 3.33，全过率却从 27.5% 升到 36.5%，R2 只写了前一半。
- 方向感知策略（R2 R2-18、R2-21，R7 H10）的依据是 Handoff Tax 和 New Model, Old Habits，两者都只测同族或小模型，每种配置只跑一次，没有跨族（如 Claude→GPT）结果。R2 称这是“本轮最接近已复现的规律”，说法偏强。HarnessHub 跨厂商时判断不了谁强谁弱，它只宜作可选参数，不宜作默认。
- R5 的通道矩阵和推荐组合全部未真机。我只证实了两点：Codex 0.166.0 的稳定 schema 里有 ThreadInjectItemsParams；OpenCode content.ts:19–21 会把 audience=assistant 的文本转为 synthetic。注入条目在 rollout、resume 和压缩后的表现，以及客户端 developer 消息压缩后是否保留，都来自网页工具摘要转述的 Rust 源码；回环 HTTP MCP 能否从各 Harness 的沙箱内连通也未核实，本机曾观察到后台沙箱不通 loopback。
- R6 的费用与时延表建立在四个假设上：预填充 8k tok/s（由少量厂商博客推算，当前模型无实测）；交接后重读 R=80 次；按字节估 token（±30%）；单日价格表。“200 回合时全量约 $4.07、多 24 s，结构化约 $0.34、多 2 s”只说明量级，不宜直接写成验收目标。
- R1、R2 称跨厂商交接没有公开评测、实验几乎空白。我做了定向搜索，也没找到直接研究，但找到几项相邻的 2026 工作，没有一份报告引用（只看了搜索摘要，DCAS 打开了摘要页）：DCAS（arXiv 2608.06113）发现微调的开放模型换到非训练脚手架后明显退化，归因于规划约定；TRACEPROBE（2607.06184）把 Claude Code、OpenCode 等的轨迹转成统一步骤 schema；Inside the Scaffold（2604.03515）发现 13 个脚手架的工具接口各不相同；CORVUS（2607.22711，NeurIPS 2026）按仓库现状同步上下文，而不是保留旧的文件读取。这些会影响默认渲染：是叙述化重述，还是原样搬运其他 Harness 的工具调用结构。
- R7 S18 称 Amp 文档仍保留 Handoff，与 R1 不一致。我核对了 Amp 2026-05-06 的公告（ampcode.com/news/neo），原文是 Handoff is gone，理由是压缩让它过时了，压缩改为在窗口 90% 时自动运行，所以应以 R1 为准，R7 引用的文档页可能没更新。不过 R1 说“跨线程连续性改靠引用”是推断：公告只说仍可以引用其他线程，没有说引用取代了 handoff。

### 按问题的覆盖评估

- Q1 交接内容：充分。七份报告对字段已有共识：确定性事实为主，用户原话逐字，模型叙述可选并标注作者，失败原样置顶，每条带出处与水位（R1 D1–D5、R2 R2-01–08、R3 I-2、R4 D4、R7 4.2）。证据缺口有两处：一是没有 Hub 模型时，“决定”和隐含决定怎样确定性地产生，没有答案（R2 Q8、R3 Q7）；二是焦点 Harness 基本不发原生 plan，dsh、Hermes、OpenClaw 的差异也不全（R4 2.4.4），文件改动只能靠工作区 git 事实，非 git 工作区还没有办法。
- Q2 上下文调度：机制覆盖好，参数没有收敛。L0/L1/L2 分层、按 Run 增量维护账本、切换路径不调用模型、原生压缩归各 Harness，这些已有共识；但各档预算和账本写入时机互相冲突（见矛盾 3、6），没有一项经过校准。R1 引用的市面常驻上限我抽查属实：Hermes→Codex 种子 32,000 字符、带省略标记；VS Code 的 transcript 模式保留尾部 20,000 字符、截尾不加标记。另有两个问题未解决：首轮之前拿不到目标窗口（R4 Q4、R5 D10）；CJK 与代码的 token 估算误差约 ±30%（R6）。
- Q3 注入通道：广度好，实证为零。R5 有七家 Harness 乘十种通道的源码级矩阵，我抽查了三条，都属实：Codex 的 thread/inject_items 在 0.166.0 的稳定 schema 中；claude-agent-acp 0.99.1 把 resource 全文追加到消息末尾；OpenCode 把 audience=assistant 的文本转为 synthetic。但所有新通道都没有真机证据，回环 HTTP MCP 在 Harness 沙箱内能否连通没有核实，WorkBuddy 几乎全是未核实。
- Q4 返回与增量：问题定位最扎实，送达判据未定。R4 用合成运行复现了 D1、D2、D3（不是真实 Harness），我对照 runtime.ts:1334、1392–1396、1496 再次核实。弱点在两处：“已送达”的判据四份报告各说一套（矛盾 1）；各家在回合被拒、被取消、超窗、进程中断时，是否已把输入写进原生转录，没有一手核实（R4 Q1、R3 Q6、R7 Q5）。后者是修复 INV-14 的前提，列为补调研 1。
- Q5 质量与确认：有方案，无证据。各报告一致主张用行为指标和确定性判定，不用模型自评；但 HH-RelayBench 的任务集、跨 Harness 运行框架、样本量与预算都没收敛，接棒复述的去留互相矛盾（矛盾 2），跨厂商交接也没有任何公开实证。各报告都没有注意到 Harbor/ATIF 这类可在同一任务上运行多家 Harness 的现成框架（补调研 2）。
- Q6 失败与边界：较充分。已覆盖：wait_current；unknown 不推进；取消与失败的回合如实入单；工作区指纹（git 15–19 ms）；外部改动；超限分层而不报错；摘要失败退回确定性交接单；摘要只由用户显式触发来源 Harness 写。薄弱点有三：保留进程离开进程组后的后台任务；fork 副本残留的清理（acp.ts:337–340、356–358 的注释已承认，非 -32601 的拒绝可能发生在副本写入之后）；超限会话能否经分支逃生（R6 Q8）。
- Q7 安全与隐私：最薄，只有原则。已有的是：不可信数据包裹并转义、审批不跨 Harness 继承、首次跨厂商提示、audience 字段、核实状态走结构字段。缺的是：具体的秘密检测与脱敏方案（规则集、误报、在哪一层做、与 INV-17 的边界）；提示注入经交接单在 Harness 之间传播的威胁模型与测试用例；各厂商与 OpenCode Zen 免费模型的数据条款；同意记录的存储与撤回。现有证据主要是 2026 年的单作者预印本。
- Q8 性能：Hub 侧证据最强，Harness 侧全是推算。Hub 侧有 R4、R6 的本机测量：整份快照提交约 19 ms/MiB，1.5 MiB 时续接停摆，账本独立表追加 0.06 ms，git 指纹 15–19 ms，另有成本与 TTL 冷重写公式。Harness 侧：当前模型的预填充与 TTFT 无实测，各驱动是否上报 cachedInput、cacheWrite 未知（R6 Q2），交接后的真实重读次数 R 与切换概率无统计，价格表只取自同一天。
- Q9 体验：R7 覆盖完整，与 R1 D27 一致：交接区各时刻、可编辑草稿、所发即所见、换回时的“你离开期间”卡、多水位一览、跨厂商提示。缺：分隔线按 dispatchedAt 出现，与“已送达”冲突；复述会不会损害“像原生”没有数据；没有原型或用户测试；API/SDK 使用方的可见性未定。
- Q10 演进：薄，只有原则。已有：建议交接只建议、不自动执行；同 Harness 换模型提供“新会话加交接单”；委派包与结果包；单写者加只读助手。缺：跨厂商时判断不了谁强谁弱，方向策略没有默认值（R2 Q2）；WorkBuddy 的通道几乎全未知；并行多 Harness 的水位与冲突模型没有展开。
- Q11 存储与契约：有草案，未收敛。R2 R2-32、R6 的 relay_ledger/relay_head、R3 I-2 三份实体草案字段不一致，写入时机也冲突（矛盾 6）。R4 已列出必须保留的 K1–K22、需要改写的测试与夹具，并指出回收集合必须并入新实体的引用。缺：v13 迁移与降级方案；来源改存区间水位后，K19 的恢复证据校验怎样保持；事件清单与幂等键；交接单与 Run 的引用关系。

### 已补调研的缺口

- **各焦点 Harness 的输入落盘时机与“已送达”证据（源码级）**：修复 INV-14 是 P0，可“已送达”的判据，四份报告给出了四种互斥的定义（R1 D13、R3 I-3、R4 D11、R7 H3）。没有人用一手资料核实过：回合被拒、被取消、超窗、进程被杀、适配器拒收时，各家是否已把用户输入和随附的交接材料写进原生会话，Hub 又能看到哪个协议事件来证明。这一点决定水位何时推进、要不要至少一次重发并去重、分隔线何时出现。原生斜杠命令（/compact、/clear、/new）对原生上下文的影响（R4 D18）也要一并确定。
- **跨 Harness 交接的 2026 外部证据与可复用评测设施（补遗）**：“不同厂商的 Harness 交接同一份工作”是简报的核心场景，也是外部证据最少的地方：现有结论多来自同族换模型（Handoff Tax、New Model, Old Habits）或同一 Harness 内部的压缩。第一轮漏掉了几条 2026 年的线索（除 DCAS 打开过摘要页，其余只见搜索摘要）：Harbor 框架与 ATIF（Agent Trajectory Interchange Format，据搜索摘要为 v1.0–1.6，可导出或加载 Claude Code、Codex 的轨迹，Phoenix 与 NeMo Relay 能读取）；TRACEPROBE（arXiv 2607.06184）；Inside the Scaffold（2604.03515）；DCAS（2608.06113）；CORVUS（2607.22711）；Fail-Fast, Restart-Smart（2608.03222）；Cursor 牵头的行级 AI 代码归属规范 Agent Trace（RFC v0.1.0，据称 Cognition、Amp、OpenCode、Jules 等参与）；跨厂商会话迁移工具 session-migrate 与 zen；Codex /import 在 v0.145 的扩展。JetBrains、Google Antigravity、Warp、Zed 的跨 Agent 交接行为也没有一手核实。此外，HH-RelayBench 还没有能跨 Harness 运行的执行框架，参数校准无从下手。
