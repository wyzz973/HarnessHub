# R1 · 市面 Harness 与多 Harness 产品的接力与上下文做法

调研员：R1（接力系统设计小组，第一轮）。阅读日期：2026-11-02。本文件只记录调研事实、推断与建议，不代表已接受的决定。

标注约定：【事实】有来源支撑；【推断】由事实推出、未经运行验证；【建议】对 HarnessHub 的设计主张。来源编号见第 7 节，如 [S12]。

---

## 0. 结论速览

1. **“交接取代压缩”在同一执行者内部已经被市场放弃，但“跨执行者交接”正在变成标配。** Amp 于 2025-10 用 Handoff 取代压缩，2026-05 的新 CLI 又改回 90% 自动压缩 [S31][S34]；Cline 在 2026-07 把 `/newtask` 改成 `/compact` 的别名 [S40]。与此同时，VS Code（2026-10）允许把本地会话交给 Copilot / Claude / Codex 三个不同厂商的 Harness 继续 [S49][S50]，Multica 用工作流列把同一个 issue 交给不同 runtime 的 agent [S53]，OpenClaw 把自己的转录投影进 Codex 原生线程 [S14]。HarnessHub 的接力属于后一类，但应吸取前一类的教训：默认自动、不要求用户手写交接稿。
2. **跨厂商交接普遍很浅。** VS Code 在目标 Harness 不支持导入历史时，只附一段“User:/Assistant:”纯文本，保留最后 20,000 字符，不含工具调用 [S51]；Hermes 切到 Codex 运行时只种入最近约 32,000 字符的历史 [S9]；continues 默认带最近 10 条消息和工具活动汇总 [S55]。**没有找到任何产品公开跨厂商交接的质量评测。**
3. **确定性锚点优于模型转述，“推小拉大”优于“一次塞满”。** Factory 的评测显示所有摘要法在“文件改动追踪”上都只有 2.19–2.45/5 [S46]；Hermes 自测：机械抽取的锚点索引把“针尖事实”召回从 23.3% 提到 60.0%，再允许一次检索已归档原文，平均召回从 45.8% 升到 68.3%，保留 token 只有原来的 0.30 倍 [S11]。HarnessHub 已持久化工具、差异、计划等公共事实，这是做确定性交接单的天然优势。
4. **交接单的框架措辞是高危区。** Hermes 有三类真实故障：旧摘要里的任务被当成当前任务执行 [S72 #41607]，“剩余工作”一节悄悄扩大范围 [#38364]，过强的“仅供参考”措辞让模型不再调用工具 [#65848]。Claude Code 也有“压缩后旧计划复活” [S25 #12505]。
5. **缓存经济学决定注入位置。** 换模型或换 Harness 必然整段未命中缓存 [S19][S24]。Multica 把逐次变化的上下文块从 messages[0] 移到每轮用户消息，以免整段历史缓存失效 [S53]。各家摘要请求都复用父会话的完全相同前缀，只有尾部指令未命中 [S5][S24]。
6. **原生压缩状态不可携带。** OpenAI 的 compaction item 不透明 [S27]，OpenCode 的原生检查点加密且只能用于同一提供方、同一模型 [S29]。跨厂商接力只能以 Hub 自己的公共事实为载体。

---

## 1. 范围与方法

- **对象**：7 个焦点 Harness（本机只读查看安装包）；14 个以交接或上下文管理为卖点的产品；约 15 个多 Harness 统一界面、编排或跨工具交接工具。
- **本机来源**（只读；未启动任何会话；未读取 `~/.hermes/sessions`、`memories` 等用户数据目录与任何配置文件）：
  - Claude Code 2.1.316（`@anthropic-ai/claude-code`，2026-11-02 安装）二进制中的压缩提示词字符串 [S1]
  - Codex 0.166.0 二进制字符串 [S2]
  - OpenCode 2.2.5 二进制字符串 [S3]
  - dsh 0.2.1-rc.5 随包 README 与库代码 [S4]–[S7]
  - Hermes Agent v0.22.5（`~/.hermes/hermes-agent`，commit `bf0203a`，2026-10-22）源码、文档与评测 [S8]–[S11]
  - OpenClaw 2026.10.9 随包文档 [S12]–[S16]
  - HarnessHub 仓库已有调研与能力矩阵 [S17]
- **网络来源**：厂商文档、官方博客、公开仓库源码（`gh api` 只读）、GitHub issue 元数据（编号、标题、反应数、日期）。第三方文章和搜索摘要分别标注。
- **局限**：
  1. 网页经抓取工具转述，个别措辞可能失真；关键数字尽量用源码或二进制交叉核对。
  2. Cursor、WorkBuddy 文档是前端渲染，未能直接读取；Devin、Jules、Kilo Code 没有深入。
  3. Factory、Hermes 的评测是厂商自评，未独立复现。
  4. 本文不判定各 Harness 原生注入通道是否可行，那属于“原生通道”核实；这里只给市面做法与建议。

---

## 2. 发现

### 2.0 焦点 Harness 原生机制对照（截至 2026-11-02）

| Harness / 版本 | 自动触发 | 谁写摘要 | 逐字保留 | 摘要形态 | 原始记录 | 用户可控 | 缓存要点 |
|---|---|---|---|---|---|---|---|
| Claude Code 2.1.316 | 默认在模型窗口上限；原生 1M 窗口的模型约 967K；可设 100K–1M；空闲压缩可关 [S22][S19] | 会话模型，自 v2.1.198 起继承 thinking 设置 [S18] | 部分压缩可保留前段或后段；压缩后重读最多 5 个文件 [S18][S21] | 9 节，≤2000 词，带 `<analysis>` 草稿（剥离）[S1] | 转录保留原文，可 rewind [S21] | `/compact <指令>`；PreCompact 可阻止；PostCompact 拿到摘要 [S20] | 摘要请求复用父前缀，约 1/10 价格 [S24] |
| Codex 0.166.0 / main@`c62e9df` | `model_auto_compact_token_limit` [S2][S48] | 本地：同模型 + 交接提示词；远程：OpenAI 服务端生成不透明项 [S26][S27] | 用户消息 ≤20,000 tokens；远程 v2 保留 ≤64,000 tokens [S26] | 4 类要点 + “另一个模型”前缀 [S2] | rollout JSONL | `/compact`；`compact_prompt` [S2] | 远程项不可读，也不跨模型 [S27] |
| OpenCode 2.2.5 | 窗口减去 buffer（默认 15%，至少 16k）[S29] | 会话模型，或 `agents.compaction.model` [S29] | `keep.tokens` 默认 15,000 [S29] | 7 节（Objective…Important Context）[S3] | 早期消息仍存储 [S29] | `/compact`；`session.compaction.*` 事件 | 原生检查点加密，只能同提供方同模型 [S29] |
| dsh 0.2.1-rc.5 | `floor(min(0.8W, W−O−65,536))` [S5] | 配置的摘要模型，否则用最近一次路由目标 [S5] | 最新 16%×(W−O) [S5] | 8 节，以 `<compacted-summary>` 包在 user 消息里 [S5] | 原事件在日志中被遮蔽，可确定性重放 [S4] | `/compact` 只给人用，不给模型工具 [S4] | 逐字节重放前缀，只有尾部指令未命中 [S5] |
| Hermes v0.22.5 | 窗口的 50% [S10] | 辅助模型，默认主模型，可单独配置 [S10] | 头 3 条、尾 20 条 + 尾部 token 预算 [S10] | 12 节，另有 lean 模式 [S8] | 新建续接会话（lineage），旧行归档 [S10] | `/compress`；`progress_notices` | micro-compaction 默认关闭，因为破坏缓存 [S8] |
| OpenClaw 2026.10.9 | 接近上限或溢出时 [S12] | 会话模型，或 `compaction.model` [S12] | 手动压缩保留最近 20,000 tokens（`keepRecentTokens`）；工具调用与结果成对保留 [S12] | safeguard 模式做质量审计 [S12] | 转录保留全部消息 [S12] | `/compact <focus ≤800 码点>`；`notifyUser` | Codex 运行时下原生压缩归 Codex [S14] |
| WorkBuddy / CodeBuddy Code（未安装）| 未知 | 未知 | 摘要连续失败时退化为无模型裁剪，保留最近几轮 [S68] | 未知 | 未知 | `/compact`、`/memory`、`CODEBUDDY.md`、`-r/--continue` [S68] | 未知 |

### 2.1 焦点 Harness

#### Claude Code（2.1.316，本机二进制 + 官方文档）

- **触发**【事实】：
  - 手动 `/compact [指令]`，或自动触发。默认在模型窗口上限触发，有三个例外：原生 1M 窗口的模型约在 967K 压缩；Sonnet/Opus 4.6 不开扩展上下文时在 200K 压缩；云端会话会更早压缩 [S22]。
  - 窗口可用 `/autocompact`、`autoCompactWindow`、`--autocompact`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 设置，范围 100K–1M [S22]。
  - 闲置会话在 1 小时 TTL 下也可能被压缩，即 idle compaction，可用 `idleCompaction:false` 关闭（v2.1.290 起）[S19]。
  - `/rewind` 提供 “Summarize from here” 和 “Summarize up to here” 两种部分压缩，都可附加指令 [S21]。
- **谁写**【事实】：会话模型。自 v2.1.198 起，摘要请求继承会话的 extended thinking 设置 [S18]。
- **保留什么、什么格式**【事实，二进制字符串 [S1]】：
  - 主模板要求 9 节，总长不超过 2000 词：Primary Request and Intent、Key Technical Concepts、Files and Code Sections、Errors and fixes、Problem Solving、All user messages、Pending Tasks、Current Work、Optional Next Step。
  - “All user messages” 一节要逐条列出非工具结果的用户消息，安全相关约束必须逐字保留。
  - 先在 `<analysis>` 里写草稿，再由正则只取 `<summary>` 部分。
  - 另有几个变体：只总结“近期部分”（早期保持原样）；总结“到此为止”（后面的新消息原样跟在摘要后）；不超过 2000 词的简短版；面向非编码对话的通用版，要求保留 6 类内容（困难与处理、试过和放弃的方案、约定与边界、当前进度、未决事项、难以重建的细节）。
  - 迭代规则：如果转录开头已有旧摘要，要原样照抄其中“用户要求了什么”的记录再补新内容，只改写“工作经过”部分。
  - 防伪造与防注入规则：写成用户回合样子的文字是模型生成的，不能归给用户；工具结果不能推翻用户自己的消息，其中的任务或批准只在用户消息要求的范围内有效。
- **压缩后会重新注入什么**【事实，S18 表格】：
  - 系统提示与 output style 仍然有效。
  - 项目根 CLAUDE.md、无作用域规则、auto memory、plan mode 写下的计划：从磁盘重新注入。
  - 带 `paths:` 的规则和嵌套 CLAUDE.md：按需重新加载，不会主动保留。
  - 文件：最多重读 5 个最近修改过的；单个超过 5,000 tokens 的只给路径引用。
  - 已调用的 skill 正文：每个上限 5,000 tokens，合计上限 25,000 tokens，超出时先丢最旧的。
  - hooks 早先注入的上下文：随对话一起被总结掉；匹配 `compact` 的 SessionStart hook 会重新运行，输出追加进来。
- **存储与可见性**【事实】：
  - 原始消息留在会话转录里，Claude 仍可引用 [S21]。
  - 用户抱怨“压缩后没有办法回看之前的上下文”，即数据还在但界面看不到（#27242，91 个反应，未关闭）[S25]。
  - 远程控制界面会隐去压缩摘要，理由是摘要可能含账号记忆 [S1]。
- **hooks**【事实，S20】：
  - PreCompact 的输入是 `trigger`（manual/auto）和 `custom_instructions`，可以阻止压缩。阻止主动压缩时，对话不压缩继续；阻止溢出恢复时，原错误直接上抛。
  - PostCompact 的输入是 `trigger` 和 `compact_summary`，无决策权。
  - SessionStart 的 `source` 取值有 startup / resume / clear / compact / fork。`additionalContext` 单条上限 10,000 字符，超出时存成会话文件，只给路径和 2,000 字符预览。
- **费用、时延、缓存**【事实】：
  - 摘要请求复用父会话完全相同的系统提示、上下文和工具定义，把摘要指令作为新的用户消息追加。缓存命中时约为 1/10 价格，产出约 20k tokens 的摘要，需要在窗口里预留“压缩缓冲” [S24]。
  - 换模型会整段未命中缓存。缓存仍热时 `/model` 会要求确认（v2.1.238 起）。官方推荐的做法是用子 Agent：由当前模型写一份交接消息给另一个模型 [S19][S24]。
  - `/recap` 只追加、不替换历史，所以不破缓存 [S19]。
  - TTL 有 5 分钟和 1 小时两档 [S19]。
- **子 Agent 与跨界面**【事实】：
  - 子 Agent 在独立上下文里工作，只把摘要和一小段元数据尾注交回 [S18]。
  - fork 继承父会话的前缀，因此能命中父缓存 [S19]。
  - `--teleport` 把云端会话拉到终端：先核对同一仓库，拉取并检出分支，再载入对话。要求工作区干净（会提示 stash）。已被压缩的早期消息不会复制过来 [S23]。
  - `--cloud` 上传本地仓库时，会排除 `.env`、`*.pem`、`id_rsa`、`*.tfvars` 这类凭据型文件中未提交的改动 [S23]。
- **已知失败与抱怨**【事实，S25】：
  - #98747：2.1.286 的空闲压缩悄悄丢弃工作上下文、无法关闭、日志还记成 manual（2026-10，已关闭）。
  - #6354：压缩后忘记 CLAUDE.md。
  - #12505：压缩后旧计划复活。
  - #7530：压缩出错（99 个反应）。
  - #14258：要求 PostCompact hook 和压缩内容控制（已实现）。

#### Codex（0.166.0 二进制 + GitHub main 源码 @`c62e9df39f`，2026-10-28）

- **触发**【事实】：
  - 手动 `/compact`，或用量超过 `model_auto_compact_token_limit` 时自动触发。这个键与 `compact_prompt`、`experimental_compact_prompt_file`、`project_doc_max_bytes` 都存在于 0.166.0 二进制中 [S2]。
  - 默认阈值随模型不同，第三方给出的例子是 180k 和 244k；第三方称阈值不能高于窗口的 90% [S48]。
  - headless exec 模式下自动压缩不触发（#16033）[S28]。
- **谁写、写成什么**【事实】：
  - 本地路径用同一模型。提示词大意是：做一次“上下文检查点压缩”，为接手任务的另一个 LLM 写交接摘要，内容包括进展与关键决定、约束与用户偏好、剩余工作和清晰的下一步、继续所需的关键数据，要求简洁、结构化 [S2]。
  - 新上下文以一段前缀开头，告诉接手模型：另一个语言模型已经做过这部分工作，你也能看到它用过的工具状态，请在此基础上继续、不要重复 [S2]。
- **保留什么**【事实，S26】：
  - 按新到旧收集用户消息，最多 20,000 tokens（`COMPACT_USER_MESSAGE_MAX_TOKENS`），再加摘要。
  - 初始上下文重新插到最后一条真实用户消息或摘要之前。
  - 显式标记过的、有名字的工具输出要么整条保留，要么整条丢弃。
  - 远程压缩 v2：保留消息预算 64,000 tokens，单条 agent 消息上限 10,000 tokens。
  - 还有一种“token 预算压缩”：不做摘要，直接装入新窗口，但仍按压缩生命周期走，让 compact hooks 能看到。
- **远程压缩**【事实，S27】：
  - OpenAI 服务端压缩分两种：一种在请求里通过 `context_management` 设置 `compact_threshold` 自动触发；另一种是独立的 `/responses/compact` 调用。产出不透明的 compaction item，官方说明它不是给人读的。
  - 在 `store=false` 时兼容零数据保留（ZDR）。
  - 文档没有说这个 item 能否跨模型使用。
  - 第三方称：走 OpenAI 托管模型时 `compact_prompt` 会被忽略 [S48]，未核实。
- **已知失败与抱怨**【事实，S28】：
  - “Error running remote compact task”（#14860，90 个反应）。
  - 用 ChatGPT 登录的用户远程压缩报 401（#48232）。
  - 流中断（#15046）。
  - 压缩不稳定加剧额度消耗（#19585）。
  - 要求控制自动压缩参数（#4106，138 个反应，未关闭）。
- **第三方实测**【事实，Hermes 团队评测 [S11]】：Codex v0.147.0 真实自动压缩后，在 4 份 500K 转录各 15 题的召回测试中平均 36.7%，压缩后保留状态约 4.5K tokens（不透明块加用户消息）。

#### OpenCode 2（2.2.5 二进制 + V2 官方文档）

- **触发**【事实，S29】：
  - 对话占满“窗口减去 buffer”时自动压缩。buffer 默认 15%，至少 16k。
  - 提供方以“过长”拒绝请求时，压缩后重试一次；第二次失败直接报错。
  - 手动 `/compact` 在下一个安全点执行，排在仍在等待的提示之前；多次请求会合并。`auto:false` 只关闭自动检查。
- **谁写**【事实】：默认是会话模型；配置了 `agents.compaction.model` 时用该模型，解析失败则退回会话模型。原生压缩总是用会话模型 [S29]。
- **格式**【事实，二进制 [S3]】：
  - 模板 7 节：Objective、Requirements、Decisions、Work State（Completed / Active / Blocked）、Next Move、Relevant Files（最多 15 个，“另一个 agent 需要打开的”，最重要的在前）、Important Context。
  - 规则：每条一行；能从代码或所列文件找回的信息可以省略；只延续仍未回答的用户问题；必须保留工作流状态，即改动是未提交、已提交、已推送、评审中还是已合并。
- **保留与存储**【事实，S29】：
  - 最近 `keep.tokens`（默认 15,000）原文和摘要一起保留，其中长工具输出会被缩短，附件数据换成简短描述。
  - 更早的消息仍在存储里，只是不再发给模型。
  - 原生检查点加密，只能用于同一提供方、同一模型。
  - 后台压缩是实验特性：暂存的摘要重启即丢，约 64k tokens 以下的会话不做。
  - V2 的 `prune` 选项目前没有运行时效果（仅搜索摘要）。
- **失败**【事实，S30】：
  - 压缩后 agent 停下不动（#13217）。
  - `opencode.db` 的 event 表涨到 13GB 以上，主要是 `message.updated` 快照，没有保留期或压缩（#33356）。
  - 用户要求把计划存成文件，以便压缩后仍能保留（#7579）。

#### DeepSeek Harness（dsh 0.2.1-rc.5，随包 README 与库代码）

- **触发**【事实，S5】：
  - 阈值 `floor(min(W×0.8, W−O−65,536))`，W 是窗口，O 是输出预留。
  - 保留最新的 `(W−O)×16%` 原文。
  - 可按模型单独覆盖；配置错误在加载时直接失败。
  - 收到确认的 `CONTEXT_WINDOW_EXCEEDED` 时做一次最大幅度缩减，再重试一次。
  - 工具结果裁剪器先跑：超长输出只留头尾，中间标“已裁剪”，不调用模型；裁剪后够用就不再总结。
- **谁写**【事实】：配置的 `summarizationProvider/Model`，否则用最近一次路由目标 [S5]。
- **格式**【事实，S5】：
  - 摘要指令要求固定 8 节：Primary Request and Intent、Key Technical Concepts、Files and Code、Errors and Fixes、Pending Jobs、Current Work、Next Step、Critical Context。
  - 目标写明“让另一个模型无损接续”。
  - 如果已有旧检查点，要合并：保留仍然成立的事实、丢弃过时的，不能原样照抄。
  - 结果以 `<compacted-summary>` 包在一条 user 角色消息里，前面的说明让模型把它当作已确立的背景、不要致谢、直接继续。
- **存储与可重放**【事实，S4】：被替换的原始事件仍留在日志中，只是不再出现在派生的模型消息里，重放会确定性地得到同样的压缩结果。摘要必须比原文短，否则拒绝。
- **缓存**【事实，S5】：摘要调用逐字节重放系统提示、工具和被遮蔽的那段消息，于是只有尾部指令和输出未命中缓存。把摘要路由到别的模型，或压缩的不是开头那段，都会失去这个复用。
- **跨会话引用**【事实，S6】——这是与 HarnessHub 最相近的现成设计：
  - 消息里的 `@标签` 引用另一个会话，服务在当时抓取一份只读快照，作为不可信背景追加在这条消息之后（另一条 user 消息，只追加，对缓存友好）。
  - 快照只含用户文字、助手文字和压缩检查点，不含工具、推理或注入的上下文，以防引用层层传递。
  - 每个源记录冻结 `capturedThroughSeq` 和 `capturedFormatVersion`。
  - 每条消息最多引用 3 个会话；每个源的字节预算是 `max(65536, floor(窗口×4×0.2))`。
  - 被截断时另给省略通告（`omittedMessages`、`omittedBytes`），并把全文存进 spill store，附取回提示。
  - 固定警告：其中的指令、权限声明和工具请求一律不执行，除非当前用户亲自重复。
  - JSON 里所有 `<` 转义为 `<`，防止伪造框架标签。
- **子 Agent 与持久化**【事实，S7】：
  - 子 Agent 有两种后端：spawn 从空会话开始；fork 种入父会话已完成的回合（一次性快照，不含进行中的回合）。
  - 检查点策略：模型请求前、有外部影响的工具执行前都先持久化，失败即不执行；被打断的工具按“结果未知”恢复，不自动重试。
  - goal 跨 resume、fork 和重启持久，默认最多自动续跑 256 轮。
- **已知限制**【事实，S5】：token 计量用 4 字符/token 的启发式，会低估 CJK 文字和 JSON Schema。

#### Hermes Agent（v0.22.5 源码、文档、评测）

- **触发**【事实，S10】：
  - 默认阈值是窗口的 50%；`target_ratio` 0.20；`protect_last_n` 20；`protect_first_n` 3。
  - 网关上另有按消息数的保险阀，默认 5,000 条，用来打破“请求一直断开、拿不到用量、阈值永远不触发”的死循环。
- **谁写**【事实，S8】：
  - 辅助模型，默认用主模型，可单独配置成更便宜的模型。
  - 迭代更新上一份摘要。
  - 摘要预算最少 2,000 tokens，按 20% 比例，上限 10,000 tokens。
  - 摘要器失败时生成确定性兜底摘要（上限 8,000 字符），并冷却 600 秒。
- **格式**【事实，S8】：
  - 12 节：Historical Task Snapshot（特意改成“历史”字样）、Goal、Constraints & Preferences（安全约束必须逐字）、Completed Actions（每条写成“N. 动作 目标 — 结果 [tool]”）、Active State、Blocked、Key Decisions、Errors & Fixes（引用用户的纠正）、Resolved Questions、Relevant Files、Critical Context、Pruned Skills。
  - lean 模式另加三块：逐字的用户消息（合计 24,000 字符，单条 4,000 字符）、详细会话日志（约 4,000 tokens）、机械锚点索引（7,000 字符，用正则抓 PR/issue 号、commit、分支、文件、错误、URL，完全不经模型）。
- **框架措辞**【事实，S8 与 S72】：
  - 摘要前缀写明：这是上一个上下文窗口留下的交接，只作背景；已解决的请求不要再做；摘要之后的最新用户消息是唯一的当前指令，哪怕话题重叠也以它为准；“停止、撤销”这类反向信号要立刻终止摘要里描述的工作；工具照常可用。
  - 这些措辞每一条都对应真实故障：#41607 旧指令被当成当前任务执行；#38364 “Remaining Work”一节悄悄扩大范围；#65848 “REFERENCE ONLY”措辞压制了工具调用，曾连续 7 轮只说不做；#69619 去掉了摘要模板里带行动意味的节标题。
- **存储**【事实，S10】：
  - 每次压缩都新建一个续接会话，记录父会话 id，标题自动编号（如 #2、#3）。
  - 归档的旧行仍可通过 `session_search` 检索。
  - 只在 OpenAI 少数路线上启用服务端原生压缩，本地压缩器作为后备 [S8]。
- **跨引擎交接，与 HarnessHub 场景同构**【事实，S9、S10】：
  - 会话从其他提供方经 `/model` 切到 Codex app-server 运行时、或 Codex 线程无法恢复时，把之前的回合种入 `thread/start.developerInstructions`。
  - 种入内容包括用户和助手文字、工具名、工具结果预览（单条 400 字符），只保留尾部 32,000 字符（约 8k tokens），前面加“更早的回合已省略”标记。
  - 理由：Codex 每次请求都会重发这段说明，所以必须封顶。
  - 能恢复的线程不种入。恢复失败时清掉旧 id、新开线程，并在状态栏提示一行“无法恢复，已新开”。
  - 起因是 #26035、#74712：Codex 运行时下 Hermes 的系统提示和记忆从未送达模型 [S72]。
- **同一 Harness 跨界面交接**【事实，S10】：
  - `/handoff telegram` 把 CLI 会话移到消息平台，使用同一个会话 id。
  - 执行中拒绝交接。
  - 网关会伪造一条用户回合，让 agent 确认并总结，再在新线程里回复。
  - 长会话要整段重放一个真实回合，最长等待 15 分钟。
- **子 Agent**【事实，S10】：
  - `delegate_task` 的子 Agent 从全新对话开始，只拿到 goal 和 context 两个字段，外加工作区的项目上下文文件。
  - 子 Agent 交回结构化摘要。若声明了 `output_schema`，校验失败时只给一次纠正机会；仍失败也不丢弃结果，而是标注 `schema_valid:false`。
- **评测**【事实，S11】：
  - 方法：从将被压缩的区段生成召回题，只给压缩后的上下文作答，由 LLM 评分。
  - 4 份 500K 转录各 15 题的平均召回：

    | 方案 | 召回 | 保留 token |
    |---|---|---|
    | 不压缩（上限） | 96.7% | 500K |
    | 默认方案 | 45.8% | 约 162K |
    | lean，不检索 | 40.0% | 约 49K |
    | lean + 一次检索归档原文 | 68.3% | 约 49K |

  - 锚点索引把“针尖事实”题目从 23.3% 提到 60.0%。
  - 另一轮对比（2026-09-19）：每次摘要式压缩约 37 秒、约 6 美分；按决策模型删工具结果的方案约 1.4 秒、不到 1 美分，但压缩更频繁、每次都破缓存，结论是不采用。

#### OpenClaw（2026.10.9 随包文档）

- **触发**【事实，S12】：
  - 接近上限时自动压缩；也在提供方返回溢出错误时压缩后重试。
  - 工具已结算后被拒的请求，可以从已记录的结果继续，不重放已完成的动作。
  - 新配置默认 safeguard 模式：必需的节标题、未决请求和原样标识符都必须留在最终文本里，否则只做有限次纠正；仍不过就不写入，保留原历史。
- **谁写**【事实，S12】：默认会话模型，可用 `compaction.model` 指定。摘要失败可沿会话的模型回退链重试，但回退选择不写回会话。
- **摘要器输入预算**【事实，S12】：
  - 每次请求的输入上限 160,000 字符（约 40,000 tokens）。
  - 分配：最新消息逐字占 1/2；较早的用户消息占 1/4，每条截到 2,000 字符；最旧消息占 1/10；其余按均匀间隔取片段，每段截到 6,000 字符。
  - 每个缺口标注省略了多少条，并告诉摘要器不要猜内容。
  - 手动压缩保留最近 20,000 tokens；用户给的 focus 指令最多 800 码点，作为数据转义后再放进请求。
- **超时退化**【事实，S12】：
  - 摘要超时（或收到 HTTP 408/504）时，提交一次“无摘要压缩”：保留最近消息，沿用上一份摘要，注明删了多少条。
  - 代价是这一次放弃标识符保留保证，被删的旧事实之后也不会回来。
- **压缩前的记忆冲刷**【事实，S12】：压缩前先跑一次静默回合，把要长期保留的内容写进记忆文件，可以指定本地模型来做。
- **上下文引擎接口**【事实，S13】：
  - 生命周期是 ingest / assemble / compact / afterTurn。
  - `commitTurn` 按 `advancementKey` 原子、幂等，并且只对“被接受的成功回合”提交；失败或中止的回合不推进引擎状态。
- **Codex 运行时下的转录与投影**【事实，S14】：
  - Codex 拥有原生线程和原生压缩，OpenClaw 只维护一份镜像，并把组装好的上下文投影进 developer instructions 和当轮提示。
  - 新开 Codex 线程时，投影包括已保存的压缩摘要和分支摘要，作为引用的先前上下文，与当前请求分开。
  - 工具方面只投影调用名、id、输入形状和脱敏后的结果，不复制原始参数值。
  - 本地 rewind 或切换分支会让旧的原生绑定失效，下次从选定的历史新开线程。
  - 设计原则：原生运行时拥有规范线程状态时，OpenClaw 只做镜像和投影，不改写它不支持的内部状态 [S14]。
- **Continue as branch**【事实，S14】：从原生 Codex 会话（CLI、VS Code、ChatGPT）建分支时，镜像源会话到最后一个已持久化终态回合为止的有界用户与助手历史；推理、工具调用和工具结果都不克隆；源会话本身不被恢复。
- **交给外部 Harness**【事实，S16】：
  - 通过 `sessions_spawn runtime:"acp"` 交给 Claude Code、Gemini CLI、OpenCode 等外部 Harness 时，只传纯文本 `task`，可选 `resumeSessionId` 走 `session/load`。
  - OpenClaw 内部的上下文信封从不发给外部 Harness，完成事件也改写成普通提示。
- **其他**【事实，S15】：
  - `sessions_spawn` 默认隔离上下文，`fork` 只限同一 agent。
  - `sessions_history` 单次上限 80KB，返回 `truncated`、`droppedMessages`、`contentRedacted` 等标志。
  - 会话状态变更日志支持 `changesSince`，请求的版本早于保留范围时返回 `historyGap`。
  - 记忆有来源 lineage，可以按会话整体遗忘。

#### WorkBuddy / CodeBuddy Code（未安装，资料有限）

- 【事实】CodeBuddy Code CLI 有 `/compact`、`/memory`、`CODEBUDDY.md`，可用 `-r <id>`、`--continue` 续接 [S68]。
- 【事实】v2.125.5 修复：因超限触发的紧急压缩，在摘要连续失败后改为不依赖模型的工程裁剪，保留最近几轮并做结构化压缩 [S68]。
- 【事实】Multica 源码注释称 CodeBuddy 是 Claude Code 的分支，使用自己的 `.codebuddy/` 目录 [S53]。
- 【推断】行为大概率接近 Claude Code，但交接与压缩细节未核实。

### 2.2 以交接或上下文为卖点的产品

**Amp（Sourcegraph / Amp）**——最值得看的演进轨迹。
- 2025-10-23【事实】Handoff 取代压缩 [S31]：
  - 用户给出新目标；Amp 分析当前线程，在新线程里起草开场提示和相关文件列表；用户可以先审阅、修改再发送。
  - 理由：压缩有损，而且鼓励漫长、绕来绕去的线程，摘要叠摘要。
  - 交接线程用哪个模型，用户不能选（二手）。
- 2025-10-29【事实】可以 @ 其他线程；另一个模型只抽取与当前指令相关的部分 [S32]。
- 2025-12【事实】加入按关键词或碰过的文件找线程、线程关系图（fork、handoff、引用）、标签 [S38]。
- 2026-01-13【事实】可以直接用自然语言要求交接；fork 命令被移除 [S33]。
- 2026-05-06【事实】重写后的 CLI 在窗口 90% 时自动压缩，并明确宣布不再提供 handoff，跨线程连续性改靠引用 [S34]。
- 2026-07-02【事实】`read_thread` 改成子 Agent，跑在 GLM 5.2 上 [S35]：
  - 会搜索线程，并检查后来是否被修订或回退。
  - 把工具调用当作“尝试”而不是“结果”。
  - 先用压缩摘要定位，需要精确细节时读原文。
  - 改版原因：一次性抽取会偏重线程首尾、忽略中间。
  - 最长的线程被压缩过 68 次以上，原文超过 2,100 万 tokens。
- 2026-07-17【事实】agent 之间可以互相启动、发消息、传文件；子 agent 的上下文由父 agent 显式传递 [S36]。
- 【事实】“200k tokens 就够”一文已归档，并注明自动压缩已让长线程可用；文中观点是短线程更便宜也更好，长线程的长空闲间隔更容易错过提示缓存 [S37]。

**Cline**
- 【事实】2025-08 [S39]：
  - Focus Chain：任务开始时生成待办，每 6 条消息重新注入一次，并且跨压缩保留。
  - Auto Compact 保留决定、代码改动和状态。
  - `/newtask` 把计划、决定、相关文件和下一步打包成新任务。
  - Memory Bank 用仓库里的 markdown 文件保存长期上下文。
- 【事实】2026-07-30 的 PR #12721：在 SDK 运行时上，`/newtask` 改为 `/compact` 的别名，因为压缩已经实现了“用新的摘要窗口继续”这一目标，不再需要旧的 new_task 工具 [S40]。
- 【事实】SDK 压缩把压缩后的工作上下文存成旁路数据，不替换规范转录；模型窗口未知时按 64,000 输入 tokens 估算 [S40]。

**Roo Code / Kilo Code**
- 【事实】Orchestrator（原 Boomerang）[S41]：
  - 用 `new_task(message, mode)` 启动子任务；子任务有完全独立的历史。
  - 子任务用 `attempt_completion(result)` 交回，父任务只拿回这份摘要，并把它当作“已完成工作的权威记录”。
  - Orchestrator 默认不能读写文件，以避免上下文污染。
- 【事实，二手】Roo Code 于 2026-05-15 停掉扩展、云服务和 Router [S42]。Kilo Code 现状未核实。

**Cursor**
- 【事实，二手】接近上限时自动总结，员工答复阈值约 90%；可手动 `/summarize` [S44]。
- 【事实，二手】主要抱怨：摘要漏掉关键细节，看不到摘要内容和总结次数，要求可审阅、可修改 [S44]。
- 【事实】2026-01-06 的“动态上下文发现”[S43]：
  - 总结后把完整聊天历史存成文件，并给 agent 一个引用，摘要缺细节时可以搜索。
  - 长工具输出写进文件，agent 先看末尾再按需读。
  - 终端输出同步成文件。
  - MCP 工具按需加载，在用到 MCP 的运行中总 token 降低 46.9%。
- 【事实，二手】Cursor 3（2026-04）和 3.7（2026-06）支持把 agent 会话在本地与云端之间移动。论坛报告：只有本机已有同仓库的本地 agent 时才出现“移到本地” [S45]。

**Factory（Droid）**
- 【事实】“锚定迭代摘要”[S47]：
  - T_max 是触发线，T_retained 是压缩后保留线。
  - 只总结新被截掉的那段，再并入持久摘要。
  - 持久摘要包含会话意图、事件经过、改动轨迹，以及文件路径、函数名等用来重新取回内容的线索。
  - 两条线间隔太窄会频繁破坏缓存；压得太狠会迫使 agent 重新读取，得不偿失。
- 【事实】2025-12-16 评测 [S46]：
  - 规模：36,611 条生产消息。题型分 recall、artifact、continuation、decision 四类。GPT-5.2 盲评，0–5 分，6 个维度。
  - 总分：Factory 3.70、Anthropic 3.44、OpenAI 3.35。压缩率分别是 98.6%、98.7%、99.3%。
  - “文件改动追踪”维度三家都只有 2.19–2.45，作者认为这是未解决问题，建议单独建改动索引或显式跟踪文件状态。
  - 结论：压缩率不是正确指标，应该看每个任务花了多少 token。

**Cognition（Devin、Windsurf）**
- 【事实】2025-06 的原则 [S61]：共享完整的 agent 轨迹，不只是消息；动作里隐含决定，决定冲突会导致坏结果。专门压缩长历史的 LLM 很难做对。
- 【事实】Windsurf 的自动记忆只存在本机、按工作区隔离、不进仓库；官方建议把需要长期共享的知识写进规则或 `AGENTS.md` [S66]。
- Devin 的交接细节未核实。

**Kiro**【事实，二手】`.kiro/specs/<feature>/` 下有 requirements、design、tasks 三份文件，`.kiro/steering/` 放始终加载的约定。规格文件本身就是持久上下文 [S67]。

**Gemini CLI**
- 【事实】`compressionThreshold` 同时作用于自动压缩和 `/compress`。默认值有冲突：设置参考写 0.5，另一页写 0.7（仅搜索摘要）[S62]。
- 【事实】检查点默认关闭 [S62]：
  - 每次批准改文件的工具前，在 `~/.gemini/history/<hash>` 的影子 git 仓库里提交快照，同时保存对话和待执行的工具调用。
  - `/restore` 同时回滚文件和对话。
- 【事实】页面注明 Gemini CLI 已于 2026-06-18 被 Antigravity CLI 取代 [S62]。

**Goose**【事实，仅搜索摘要】默认在 80% 自动压缩，阈值可用 `GOOSE_AUTO_COMPACT_THRESHOLD` 调；`/compact` 取代已弃用的 `/summarize`；兜底策略可选 summarize、truncate、clear、prompt；较早的工具输出在后台总结 [S63]。

**Aider**【事实】repo map 用依赖图排序，`--map-tokens` 默认 1k，会随对话状态动态伸缩，每次请求都发送 [S64]。

**OpenHands**【事实，仅搜索摘要】`LLMSummarizingCondenser` 按事件数（`max_size`）触发，前 `keep_first` 个事件永不压缩，压缩后约剩一半；文档声称每回合费用最多降一半 [S65]。

**GitHub Copilot / Agent HQ**
- 【事实】2026-02 起 Claude 和 Codex 可作为 GitHub 上的编码 agent。可以把同一个任务派给多个 agent 比较结果；在 PR 评论里 @ 某个 agent 让它接着改；会话日志可查看 [S52]。
- 【推断】这里的“交接”媒介是 PR 和评论，没有找到“一个 agent 接着另一个 agent 的会话往下做”的文档语义。

**Zed**
- 【事实】Zed 自家 agent 的线程会自动压缩，也可以“New From Summary”用摘要开新线程 [S70]。
- 【事实】外部 ACP agent 不支持部分功能（如中途引导）。重开会话时优先 `session/load`，否则用 `session/resume` 并提示看不到之前的消息 [S17]。

**Warp**【事实，仅搜索摘要】超过上限自动总结；可以中途换模型；执行 shell 命令后或空闲 3 小时后会自动开新对话 [S71]。

**Jules、Kilo Code、Devin 细节**：未覆盖，见第 6 节。

### 2.3 多 Harness 统一界面与跨厂商交接：谁真的在不同厂商之间交接同一份工作

**VS Code（2026-10-28 文档与 2026-10-22 源码）——与 HarnessHub 最接近的现成产品**
- 【事实】怎么触发 [S49][S50]：
  - 在 Local harness 会话里，从 Session Target 下拉框选 Copilot、Claude 或 Codex。
  - 文档说会携带对话历史和上下文；目标会话使用所选 Harness 自己的工具、权限和模型。
  - 只有 Local 会话能发起交接；接收方不能再往下交，也不能交给云端。
  - 企业策略可能强制把 Local 会话移到 Copilot，此时保留历史和未发送的输入，但不自动提交。
- 【事实】源码里的三种实现 [S51]：
  - `migrate`：目标宿主支持导入历史时，直接迁移回合，源会话归档。
  - `transcript`：目标宿主不能导入时，新建对话，附一个名为“Previous conversation”的粘贴附件，内容是“User:/Assistant:”纯文本，只取每个回合的 markdown 回复，不含工具调用。超过 20,000 字符时只保留尾部，**前面直接截掉、没有标记**。源会话不归档，因为这不算迁移。
  - `newChat`：只带未发送的草稿。
  - 历史加载失败会提示用户原对话仍在。
- 【事实】VS Code 正在做通用 ACP 宿主（#340860）；有 issue 指出查看非常驻的 Copilot CLI 会话会恢复 SDK 会话并重放整段事件日志（#344559）[S51]。
- 【推断】VS Code 也没有解决接力质量问题；它的 transcript 模式与 HarnessHub 现状相近，区别只是用截尾换掉了报错。

**Multica（main @ 2026-11-02 源码）**
- 【事实】工作流交接 [S53]：
  - 每个状态列有一个处理者（agent、squad 或成员）、一段说明，以及完成后和退回时分别去哪个状态。
  - issue 进入某列，就分配给该列的处理者；如果处理者是 agent，就用该列的说明启动它的运行。
  - 移动前有预览，显示之前的运行和交给对方的 brief，需要确认。
  - 各 agent 可以绑定不同 runtime（Claude、Codex、Hermes、dsh 等），所以这就是跨厂商交接；共享的权威记录是 issue 本身（描述、评论、运行记录）。
- 【事实】`handoff_note` 是指派时附带的自由文本说明，渲染进开场提示，不伪造成评论（MUL-3375）[S53]。
- 【事实】唤醒证据：事实以结构化数据存在 task.context，备注文本只是一种渲染 [S53]。
  - 提示预算 40KB，其中说明最多 12KB。
  - 超出时从最旧的事实开始丢，并附一句通告：部分触发细节已省略，请先读取当前的评论、运行和状态再决定。
- 【事实】拉取式上下文 [S53]：
  - 开场提示要求 agent 先运行 `multica issue get`。
  - 评论先用 `--roots-only --summary --compact` 浏览，只展开相关线程（`--thread <id> --tail 30`）；聊天记录用 `multica chat history`。
- 【事实】会话连续性通告 [S53]：原生会话无法恢复时，告诉 agent 三件事：权威记录在哪；丢掉的是自己的工作记忆（试过什么、排除了什么、做到哪）；请重新推导、不要声称有记录无法支撑的连续性，也不要在回复开头宣布这件事。
- 【事实】三条工程教训 [S53]：
  - MUL-5377：每次运行都会变的上下文块原本写在运行 brief 里，而 Claude Code 会把 brief 放进 messages[0]，每次恢复都让整段历史的缓存失效；改为追加到每轮用户消息后。
  - MUL-6984：删掉了 `.agent_context/issue_context.md`，因为没有任何提供方读它，它只是需要同步的第三份副本。
  - MUL-5722：同一回合只允许出现一条连续性通告，从结构上消除重复。

**Conductor**
- 【事实】0.28.1（2025-12-23）起每个工作区有 `.context` 目录，自动存放附件、Claude Code 写的计划和笔记，默认被 gitignore；从 fork 出来的对话产生的摘要存进新工作区的该目录 [S54]。
- 【事实，仅搜索摘要】博客说目的是让 Claude Code 写的计划交给 Codex 实现；团队考虑过本地数据库、注入提示、专用工具，最后选了普通文件，因为编码 agent 本来就擅长读文件 [S54]。

**continues、casr、relai（工具层的跨厂商交接）**
- 【事实】continues [S55]：
  - 支持 16 个工具，只读扫描它们的原生会话存储。
  - 生成 markdown 交接文档：最近消息（四档预设：3、10、20、50 条）、工具活动汇总（命令次数、退出码、改了哪些文件）、模型与 token、思考块，以及原会话文件路径。
  - 把文档注入目标工具；同一工具则走原生 resume。
  - 2026-11 约 1,590 星。README 开篇的场景是调试到一半撞上额度上限。
- 【事实，二手】交接文档会占用目标窗口，详细档约 10–30k tokens；各家会话格式是逆向得来的，小版本变更就可能失效 [S57]。
- 【事实】casr 把会话转成规范中间表示，再写成目标工具的原生会话文件，并回读校验；对 OpenCode 2 只读不写，因为那些表是其事件日志的投影 [S56]。
- 【事实，二手】relai（Product Hunt）主打“任何工具中恢复任何会话”，动机同样是额度上限 [S73]。

**其他**
- 【事实】Vibe Kanban 续聊时不调用 `session/load`，而是把保存的历史拼成“RESUME CONTEXT”提示词发给新会话 [S17]。
- 【事实】Claude Squad 用 tmux 加 git worktree，每个会话在创建时选定程序，checkout 即提交并暂停，没有上下文交接 [S58]。
- 【事实】AionUi、Toad、Happy、Omnara、sandbox-agent 都没有发现会话内换 Harness 的接力功能（见既有调研 [S17] 与本轮抽查）。
- 【事实，仅搜索摘要】Zen/PAL MCP 在 MCP 服务端内存里保存对话线程，通过 `continuation_id` 让另一个模型接续，会重建包含文件引用的历史，进程重启即丢 [S59]。
- 【事实，仅搜索摘要】Beads 是给 agent 用的图状 issue 跟踪器，充当外部工作账本，旧的已关闭任务会被总结掉，可供 Claude 和 Codex 共用 [S60]。

**小结：谁在交接同一份工作**【推断】

| 类型 | 产品 | 交接媒介 |
|---|---|---|
| 会话级跨厂商 | VS Code | 历史迁移或纯文本附件 |
| 会话级跨厂商 | Hermes→Codex | 尾部种子 |
| 会话级跨厂商 | OpenClaw↔Codex | 投影或镜像 |
| 任务级跨厂商 | Multica | 共享 issue 记录 + brief + 拉取 |
| 任务级跨厂商 | Conductor | 共享文件夹 |
| 任务级跨厂商 | GitHub Agent HQ | PR |
| 工具级 | continues、casr、relai、Zen MCP | 读原生存储或自建线程 |

效果方面：没有找到量化评测；用户评价主要表现为 continues 的星数，以及“额度用尽换工具”这一需求反复出现 [S55][S57]。

---

## 3. 模式归纳

1. **两类连续性机制**【事实】：
   - 同执行者内部压缩：几乎所有产品都有。共同点是中段换成摘要、近期原文保留、系统与项目上下文从磁盘重载、原始记录另存。
   - 跨上下文交接：新线程、子 Agent、云端与本地、换 Harness，都给新上下文一份种子。
   - 前者在 2026 年成为默认且自动的机制（Amp、Cline 都回到压缩）[S34][S40]；后者在跨环境、跨执行者场景扩张 [S23][S45][S49][S53]。
2. **模板趋同**【事实】：
   - 共同的节有：意图与目标、约束与偏好（安全约束逐字）、决定及理由、已完成/进行中/阻塞、文件与路径、错误与修复（含用户纠正）、未决事项、关键标识符。
   - 对应来源：Claude 9 节 [S1]、dsh 8 节 [S5]、OpenCode 7 节 [S3]、Hermes 12 节 [S8]、Codex 4 类 [S2]、Factory [S47]。
   - 分歧在于是否带祈使语气的“下一步”。Claude（Optional Next Step）和 dsh（Next Step）有 [S1][S5]；OpenCode 有 Next Move 动作列表，但规则限定只延续仍未回答的用户请求 [S3]；Hermes 已把相关节改成“历史”字样，并在前缀里强调“最新用户消息为准”，以抑制它 [S8][S72]。
3. **确定性锚点优于模型转述**【事实】：
   - Hermes 用正则抽锚点，摘要失败时有确定性兜底 [S8][S11]。
   - OpenClaw 默认严格保留标识符，并做质量审计 [S12]。
   - CodeBuddy 和 Codex 都有不经模型的退化路径 [S26][S68]。
   - continues 的工具活动汇总是机械生成的 [S55]。
   - Factory 的结论：改动追踪需要专门处理 [S46]。
4. **原文永远保留，摘要只是派生层**【事实】：dsh 遮蔽而不删 [S4]、OpenClaw [S12]、OpenCode [S29]、Cline 旁路数据 [S40]、Claude rewind [S21]、Cursor 历史文件 [S43]、Amp 读原文 [S35]、Hermes 归档后可检索 [S10]。
5. **推小拉大**【事实】：常驻部分有界，细节按需取。
   - 常驻上限：Hermes 种子 32k 字符 [S9]、VS Code 20k 字符 [S51]、Multica 40KB [S53]、Claude 单条附加上下文 10k 字符（超出给路径和 2k 预览）[S20]、dsh 每源 64KiB 起 [S6]、continues 预设 [S55]。
   - 取回渠道：Hermes 检索 [S11]、Cursor 文件 [S43]、Amp 子 Agent [S35]、Multica 命令行 [S53]、dsh 落盘与取回提示 [S6]。
   - 召回证据：同样约 49K tokens，加一次检索比不检索高 28.3 个百分点 [S11]。
6. **缓存决定结构**【事实】：
   - 摘要请求逐字节复用前缀 [S5][S24]。
   - 运行级信息不放 messages[0] 或系统提示 [S53][S24]。
   - 换模型等于缓存清零 [S19]。
   - micro-compaction 和高频删工具结果都会破缓存 [S8][S11]。
   - 种子放在“每次都重发”的通道时必须封顶 [S9]。
7. **措辞失败**【事实】：旧任务复活 [S72 #41607][S25 #12505]，范围扩张 [S72 #38364]，工具调用被压制 [S72 #65848]，把模型生成的文字误当成用户发言 [S1]。
8. **不可信内容的边界**【事实】：dsh 加固定警告并转义 [S6]；OpenClaw 不向外发内部信封、投影时脱敏、不带原始参数 [S14][S16]；Claude 规定工具结果不能推翻用户 [S1]；Hermes 摘要脱敏 [S8]；Claude 远程控制隐藏摘要 [S1]。
9. **水位与谱系**【事实】：dsh 的 `capturedThroughSeq` 与格式版本 [S6]；OpenClaw 只对被接受的回合幂等提交、状态变更日志带 `historyGap` [S13][S15]；Hermes 会话谱系 [S10]；Multica 的事实与渲染分离 [S53]。
10. **如实说明连续性**【事实】：Multica 连续性通告 [S53]；Hermes 恢复失败提示 [S10]；Claude teleport 说明被压缩部分不复制 [S23]；OpenClaw 有界投影时提示用户重发要点 [S14]；Zed “看不到之前的消息” [S17]。
11. **工作区状态是交接的一部分**【事实】：teleport 要求工作区干净、同一分支 [S23]；OpenCode 模板要求写明提交状态 [S3]；Multica 对 worktree 冲突单独提示 [S53]；上传仓库时过滤凭据文件 [S23]。
12. **摘要模型的选择**【事实】：默认几乎都是会话模型（Claude、OpenCode、OpenClaw、dsh），可另配便宜模型（Hermes、OpenClaw、OpenCode、dsh）；Amp 的读线程用一个小模型 [S35]。【推断】没有一家在用户不知情的情况下改用其他厂商的模型；跨厂商只有工具层产品（continues）在做，而且是用户主动发起。
13. **超级 Agent 形态**【事实】：中心调度、子上下文隔离、只交回摘要，是事实上的标准（Claude 子 Agent、Hermes delegate_task、OpenClaw sessions_spawn、Roo Orchestrator、Amp agent 间协作）[S18][S10][S15][S41][S36]。Cognition 提醒：只传摘要会丢掉动作里隐含的决定 [S61]。

---

## 4. 对 HarnessHub 接力的启示

按设计问题 Q1–Q11 编排。每条注明“采用 / 改造后采用 / 拒绝”。数字凡未注明来源者，均为【建议】，需要基准测试校准。

### Q1 交接内容

- **D1【采用】交接单以“事实为数据、文本为渲染”。**
  - 交接单（Relay Packet）由工作账本中的结构化事实确定性地渲染，渲染结果可重建、不可变，并带策略版本。
  - 理由：Multica 把事实存在 task.context，备注只是渲染 [S53]；Factory 显示模型摘要最差的就是改动追踪 [S46]；Hermes 的锚点索引补上了针尖事实 [S11]。
  - HarnessHub 已经有 `PublicRun.tools/plan/usage/outputs/attachments` 和内容存储里的差异，确定性部分可以覆盖文件改动、命令与退出码、计划快照、失败回合、未决审批、产物、用量。
- **D2【采用，按出处拆分】共识模板，固定节序，每节标明出处**（确定性 / 用户原话 / 模型撰写）：
  1. 当前请求：只引最新用户输入，逐字。
  2. 目标与约束：用户原话；安全和禁止事项逐字 [S1][S8]。
  3. 决定：来源为用户批准的决定或 plan 中的决定，附 Run 与消息 id。
  4. 进展：已完成 / 进行中 / 阻塞，来自 plan 快照与 Run 结果状态，写成过去时 [S3]。
  5. 文件与工作区：确定性生成，见 D12。
  6. 失败与教训：失败的工具调用和错误原文，以及用户的纠正 [S8]。
  7. 未决问题与审批。
  8. 产物：id 与 hash。
  9. 来源与水位：包含的 Run 区间、省略统计、指纹、策略版本。
- **D3【改造后采用】“下一步”不交给模型自由发挥。** 只渲染“plan 中未完成项（来自 Run X 的快照）”这样的陈述句，不写祈使句；明确说明只有当前用户输入是指令。理由：Hermes #38364、#41607 与 Claude #12505 [S72][S25]。
- **D4【采用】用户原话优先。** 自上次交接以来的全部用户消息逐字带上，单条 ≤4,000 字符，超出部分用显式省略标记并给出引用，合计 ≤6k tokens。理由：Codex 保留用户消息 20k tokens [S26]；Hermes lean 模式逐字用户消息 24k 字符、单条 4k [S8]；OpenClaw 给旧用户消息 1/4 预算、每条 2,000 字符 [S12]；Claude 要求列出所有用户消息 [S1]。
- **D5【采用】工具内容只投影形状，不带原文。**
  - 投影：工具类别、目标、状态、退出码，外加 ≤400 字符的预览。
  - 原始输出和差异只给内容引用。
  - 理由：OpenClaw 只投影名称、id、形状和脱敏结果，不带原始参数 [S14]；Hermes 预览 400 字符 [S9]；continues 汇总工具活动 [S55]。

### Q2 上下文调度

- **D6【采用】三层预算。**
  - L0 交接单核心：目标 2–6k tokens；硬上限取 12k tokens 与目标窗口 5% 中的较小者；字节上限 48 KiB。
  - L1 近期原文：见 D4，外加最近一个已结算回合的最终回复，≤2k tokens。
  - L2 按需取回：其余全部内容。
  - 超出 L0/L1 的内容一律进 L2，并附省略通告：省略了多少 Run 和字节、最早与最晚序号、怎样取回。这样满足“超限不静默截断”。
  - 依据：S9、S20、S51、S53、S6，以及 S11 中“推小拉大”的召回数据。
- **D7【采用】增量维护工作账本，与事件同步提交。**
  - 每个 Run 结算时增量更新账本，只对已结算且结果不是“未知”的 Run 推进，与 OpenClaw 只提交被接受回合同理 [S13]。
  - 切换时只做投影，不做重算。
  - 目标：账本更新 ≤10 ms/Run；交接单构建 p50 ≤30 ms、p95 ≤200 ms（256 个 Run、8 MiB 会话、无模型调用）。
  - 打开 Harness 选择器时可预构建，但预构建只是缓存，不能当作已固定的水位。
- **D8【改造后采用】与原生压缩分工。**
  - 同一个绑定内部的长对话交给原生压缩，因为它命中缓存，Claude 约 1/10 价格 [S24]、dsh 逐字节复用前缀 [S5]。Hub 不替代、不阻止它。
  - 交接只在换执行者时发生。
  - 原生压缩的产物不进入公共事实：远程项不透明、检查点加密 [S27][S29]。
  - 在 Hub 自己的活动流里记录“原生压缩已发生”，用于说明原生侧丢了什么。
- **D9【拒绝】以“交接取代压缩”作为长对话的总策略，或强制用户手写交接稿。** 理由：Amp 和 Cline 都已撤回 [S34][S40]。

### Q3 注入通道

- **D10【采用】交接单只在换人后的第一回合投递一次，与用户正文分开。**
  - 在支持的 Harness 上作为独立的嵌入文本资源（Claude 以 `<context>` 注入文本资源、OpenCode 支持 embeddedContext、OpenClaw 的桥会把资源展开成文本，见能力矩阵 [S17]）；不支持的 Harness 用独立的文本块。
  - 不要和用户正文拼成一个字符串。VS Code 用附件、dsh 用第二条 user 消息，都是这样分开的 [S51][S6]。
  - 不重复注入。
- **D11【拒绝】把运行级的交接内容放进系统提示、developer instructions、`AGENTS.md`/`CLAUDE.md`，或 Hub 在工作区里写的上下文文件。**
  - 理由：破坏整段缓存（MUL-5377）[S53]；Codex 的 developerInstructions 每次请求都会重发 [S9]；没有被指向的文件没人读（MUL-6984）[S53]；还会改动用户的工作区和全局配置。
  - 【改造后采用】Hub 自有目录里的只读大件（差异、日志）只作为 L2 的取回目标，并由交接单写明路径。注意 OpenCode 读取工作区外文件需要审批 [S17]。
- **D12【采用】取回优先走每个会话单独注入的只读工具，退化为文件路径。**
  - 优先：每个会话注入的只读 MCP 工具，例如 `relay.search`、`relay.read_run`、`relay.diff`。
  - 退化：只读文件路径。
  - 两者都不行：交接单只给 L0/L1，并标注“细节不可取回”。
  - 依据：S6、S11、S43、S53。是否可行待原生通道核实，ACP 的 `session/new` 带有 `mcpServers` 字段 [S17]。
  - 【事实】ACP 于 2026-04-22 把 `session/resume` 定为稳定，fork 仍是实验特性；没有找到标准化的“导入历史 / 种入上下文”方法 [S69]。【推断】交接单在协议层只能走提示内容（文本或资源块）或各家私有 `_meta`。

### Q4 返回与增量

- **D13【采用】水位分两个。**
  - `deliveredThroughSeq`：携带交接单或增量的那个回合已被目标接受且结算后才推进，未知结果不推进。
  - `dispatchedThroughSeq`：只用于诊断。
  - 原生斜杠命令回合（如 `/compact`）不推进 delivered；待补的增量排队，到下一个内容回合注入。这直接修复简报里的 INV-14 疑似缺陷。
  - 依据：S13、S6。
- **D14【采用】返回 A 时只追加增量，并按缓存与规模给出选择。**
  - 增量只写 B 在 A 的水位之后做了什么，包括文件差异摘要；只追加，不重放 A 已经知道的内容。
  - 【建议】A 空闲超过其缓存 TTL（5 分钟或 1 小时 [S19]）且原生上下文远大于交接单时，原生恢复要整段按未命中计费。此时向用户展示两个选项的估算：“恢复 A + 增量”保留 A 的内部状态，“新开 A + 交接单”更便宜。
- **D15【采用】每次交接形成不可变记录，串成谱系。** 每次交接有 id，记录来源与目标绑定、`throughSeq`、格式版本与指纹；按会话串成链，借鉴 Hermes 的会话谱系与 OpenClaw 的 `changesSince/historyGap` [S10][S15]。

### Q5 质量与确认

- **D16【采用】默认不加确认回合；接棒回执是确定性的。** 回执的条件是：交接单已随派发的提示送达，且目标回合已结算。Hermes 跨平台交接会伪造一条“请确认并总结”的回合，代价是一整轮和一次原生转录写入 [S10]；只在评测模式下使用复述检查。
- **D17【采用】离线基准，用对照组。**
  - 题型：仿 Factory 的四类题，即召回、改动、接续、决定 [S46]。“改动”题的标准答案直接来自 diff，确定、不用模型判断。
  - 对照：仿 Hermes 设无上下文、现状 JSON、确定性交接单、确定性 + 取回、+ 模型摘要几组，以“同一 Harness 原生恢复”为上限组 [S11]。
  - 另测四项：已完成工作是否被重复执行（重复的工具动作数）、是否越界做了未要求的“下一步”、注入 token、切换时延。
  - 模型自评不能作为证据。
- **D18【采用】接续等级扩展，并对用户与模型双向可见。** 在 native_resume、public_context_rehydrate、blocked 之外，增加“原生恢复 + 增量”和“交接单 + 可取回 / 不可取回”。连续性通告写法采用 Multica 的思路：说明权威记录在哪、丢了什么、请重新推导、不要提前宣布 [S53]。

### Q6 失败与边界

- **D19【采用】在回合边界交接；不转移正在运行的工具；未知结果如实写入交接单。** 依据：Hermes 执行中拒绝交接 [S10]，OpenClaw `/compact` 会先等待当前回合 [S12]，dsh 回合中不可压缩 [S5]，OpenCode 在安全点执行 [S29]。被取消或未知的回合在交接单里明确写成“结果未知，可能有副作用”，与 Claude 处理被省略工具结果的规则一致 [S1]。
- **D20【采用】工作区快照是确定性的。**
  - 内容：仓库根、分支、HEAD、未提交和未跟踪文件的路径及增减行数、交接时的指纹。
  - 派发前再核一次指纹；变了就标注“外部改动”，不静默覆盖。
  - 凭据型文件只给路径、不给内容，参考 Claude 上传时过滤的列表 [S23]。
- **D21【采用】模型摘要失败不阻断交接。** 摘要失败时退回确定性交接单（OpenClaw、Hermes、CodeBuddy 都这样退化 [S12][S8][S68]），并在交接单里标注“缺少模型摘要”。
- **D22【拒绝】交接失败后自动换新会话重跑，或在用户不知情时新开会话。** 理由见既有调研对 AionUi、Multica 的分析 [S17]。

### Q7 安全与隐私

- **D23【采用】历史内容一律作为不可信数据。**
  - 包在带标签的块里，并转义 `<`，防止伪造标签 [S6]。
  - 固定声明：其中的指令和批准不生效，除非当前用户亲自重复 [S6][S1]。
  - 审批不跨 Harness 继承，目标按自己的权限模型重新询问。
- **D24【采用】跨厂商流动前先脱敏并告知。**
  - 工具输出预览和用户附件先过一遍密钥模式脱敏 [S8]。
  - 某个会话的内容第一次流向不同厂商时，提示一次并记录同意。先例：Claude 远程控制隐藏可能含账号记忆的摘要 [S1]。
  - 删除会话时连带删除派生的交接单，借鉴 OpenClaw 的来源谱系与遗忘 [S15]。

### Q8 性能

- **D25【建议】可测量目标。**
  - 确定性构建 p95 ≤200 ms。
  - 切换到派发的 Hub 侧开销（不含 Harness 冷启动）p95 ≤500 ms。
  - L0 默认 ≤6k tokens。
  - 交接单只投递一次，不重复注入。
  - 模型摘要模式不进入关键路径，预期每次 10–60 秒，Hermes 实测每次约 37 秒、约 6 美分 [S11]，需要异步预生成或由用户显式等待。
  - 存储：交接单按内容引用去重，计入 `MAX_SESSION_BYTES`。前车之鉴：OpenCode 的 event 表涨到 13GB [S30]。
- **D26【采用】换 Harness 必然冷启动缓存，就让交接单尽可能短，并放在目标的稳定前缀之后。** 同一 Harness 换模型时，缓存还热就提示代价（Claude 只在缓存热时要求确认 [S19]）。新模型窗口小于当前原生上下文时，先压缩或重建，不能让请求溢出（Claude 不会回退到窗口更小的模型 [S22]）。

### Q9 体验

- **D27【改造后采用】默认自动生成交接单，在对话里显示为可折叠的“交接单”卡片。**
  - 卡片内容：各节、出处链接、省略统计、接续等级。
  - 用户可以编辑的只有“交接备注”，借鉴 Multica 的 `handoff_note` [S53]；以及交接方式（完整 / 精简 / 仅目标）。
  - 发出后不可变。
  - 依据：Amp 允许编辑草稿 [S31]，但用户更想要自动 [S34]；Claude #27242 用户想回看被压缩的内容 [S25]。

### Q10 演进

- **D28【采用】建议交接**：当前 Harness 报告额度达到 90%，或出现额度/限流类错误时，提示用户可以换人，并在后台预构建交接单。依据：Happy 在 90% 预警 [S17]；continues 和 relai 的用户动机都是额度 [S55][S73]。只建议，不自动执行。
- **D29【采用】同一份交接单格式兼作“委派包”，并配套“结果包”。** 为以后并行使用多个 Harness 做准备：结果包是结构化摘要，可附 schema 校验，失败时只纠正一次（Hermes [S10]）；也就是 Roo 那种“消息进、结果出”的模式 [S41]。

### Q11 存储与契约

- **D30【拒绝】读取或写入其他 Harness 的私有会话存储作为接力来源**，即 continues 读、casr 写 [S55][S56]。理由：违反“不读用户对话、不改原生状态”；格式是逆向得来的，很脆弱；而 Hub 的公共 Session 本来就有需要的事实。
- **D31【采用】交接单记录格式版本与 `capturedFormatVersion`，并记录渲染器版本** [S6]，以便迁移和重建。

---

## 5. 风险与反模式

1. **旧任务复活与范围扩张**：交接单里出现祈使语气的“剩余工作”或“下一步”时，接手方会继续做用户已经放弃的事 [S72 #41607 #38364][S25 #12505]。
2. **过强的“仅供参考”措辞压制工具调用**：模型开始只描述、不动手 [S72 #65848]。
3. **静默截尾**：VS Code 只留尾部 20,000 字符且没有标记 [S51]；Hermes 的种子虽有标记，仍是截尾 [S9]。两者都违反 HarnessHub 的“超限不静默截断”。
4. **摘要叠摘要的漂移**：多次迭代会丢掉用户的原始要求。Claude 用“原样照抄用户要求部分”对抗 [S1]，dsh 用“合并、丢掉过时内容”对抗 [S5]。
5. **依赖不透明的原生状态**：远程压缩出错、401、流中断 [S28]；加密检查点不能跨模型 [S29]。
6. **破缓存风暴**：每轮在 messages[0] 重注入 [S53]；高频压缩或高频删工具结果 [S11][S47]；在每次都重发的通道里放大段种子 [S9]。
7. **空闲或后台压缩带来意外**：Claude #98747 [S25]；OpenCode 后台摘要重启即丢 [S29]。
8. **没人读的上下文文件**（MUL-6984 [S53]），以及同一回合出现重复通告（MUL-5722 [S53]）。
9. **私有格式逆向带来的脆弱性**，以及隐私越界 [S57]。
10. **交接阻塞在超长历史上**：Hermes 跨平台交接最长等 15 分钟 [S10]；VS Code 查看会话时重放整段事件日志 [S51 #344559]。
11. **跨厂商泄露记忆或密钥**：摘要里可能含账号记忆 [S1]，工具输出里可能含密钥 [S8]。
12. **把“已派发”当“已送达”**：简报所述 INV-14 疑似缺陷的根源。OpenClaw 只推进已接受回合的做法可以作为对照 [S13]。
13. **只传摘要丢掉隐含决定**：Cognition 的警告 [S61]。交接单应附带决定的来源，并允许取回原文。

---

## 6. 未解决的问题

1. 七个焦点 Harness 是否都把嵌入文本资源与用户正文同等对待，尤其是 WorkBuddy 和 dsh 的 ACP 资源处理？是否支持每个会话单独注入的只读 MCP 而不改全局配置？需要原生通道核实。
2. 没有 Hub 自有模型时，“精简交接”的模型摘要由谁写？候选一：在来源 Harness 里显式跑一个“交接回合”，消耗用户额度并写入其原生转录，Amp 由当前模型起草、Claude 官方建议由当前模型写交接消息都是先例 [S31][S24]。候选二：目标 Harness 第一回合通过取回工具自己读。哪种方式召回更高、成本更低，需要基准测试回答。
3. 跨厂商交接没有公开基准。D17 的题库与任务集如何构造、样本规模多大才有统计意义，尚未确定。
4. CJK 文本的 token 估算：dsh 已指出 4 字符/token 会低估 CJK [S5]。L0 的 token 上限应该用目标模型的计数器，还是用保守的字节上限？
5. VS Code 的 `migrate` 模式究竟迁移了哪些内容（是否包括工具调用），源码之外没有文档 [S51]；是否会成为事实标准？
6. Cursor 本地与云端交接、Devin、Jules、Kilo Code 的交接细节没有一手资料。
7. 内容跨厂商流动的用户告知与同意，在产品和法务上需要做到什么程度？市面没有可参照的先例，只有 Claude 远程控制隐藏摘要这一个旁例 [S1]。
8. 返回 A 时，“恢复 + 增量”与“新开 + 交接单”的成本和质量如何权衡（D14），需要用真实的缓存命中数据校准。

---

## 7. 来源清单

核实方式：本机 = 读取本机安装包或源码；原文 = 打开原文核实；源码 = 经 `gh api` 读取公开仓库；搜索 = 仅看到搜索摘要；二手 = 第三方转述。

| 编号 | URL / 路径 | 标题 | 作者 / 机构 | 日期 / 版本 | 核实 |
|---|---|---|---|---|---|
| S1 | `~/.nvm/versions/node/v26.11.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` | 压缩提示词与相关字符串 | Anthropic | Claude Code 2.1.316 | 本机 |
| S2 | `/opt/homebrew/Caskroom/codex/0.166.0/bin/codex` | 压缩提示词、SUMMARY_PREFIX、配置键 | OpenAI | codex-cli 0.166.0 | 本机 |
| S3 | `/opt/homebrew/Cellar/opencode/2.2.5/bin/opencode` | 压缩模板与规则 | Anomaly / OpenCode | 2.2.5 | 本机 |
| S4 | `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction/README.md` | dsh-compaction | DeepSeek | 0.2.1-rc.5 | 本机 |
| S5 | `…/dsh-compaction-basic/README.md` | dsh-compaction-basic | DeepSeek | 0.2.1-rc.5 | 本机 |
| S6 | `…/dsh-session-reference/README.md`、`lib/index.js` | dsh-session-reference | DeepSeek | 0.2.1-rc.5 | 本机 |
| S7 | `…/dsh-subagent-fork-in-process`、`-spawn-in-process`、`dsh-session-checkpoint-policy`、`dsh-goal`、`dsh-compaction-tool-result-pruner`、`dsh-agent-instructions` README | dsh 子 Agent、检查点、目标 | DeepSeek | 0.2.1-rc.5 | 本机 |
| S8 | `~/.hermes/hermes-agent/agent/context_compressor.py` | ContextCompressor | Nous Research | v0.22.5，`bf0203a`（2026-10-22） | 本机 |
| S9 | `~/.hermes/hermes-agent/agent/codex_runtime_history_seed.py` | Codex 历史种子 | Nous Research | 同上 | 本机 |
| S10 | `~/.hermes/hermes-agent/website/docs/user-guide/{sessions.md,configuration.md,features/delegation.md,features/codex-app-server-runtime.md}` | Hermes 用户文档 | Nous Research | 同上 | 本机 |
| S11 | `~/.hermes/hermes-agent/evals/compaction/{README.md,results/SCORECARD-2026-08-15.md,results/SCORECARD-2026-09-19-jev.md}` | 压缩评测 | Nous Research | 2026-08-15、2026-09-19 | 本机 |
| S12 | `/opt/homebrew/lib/node_modules/openclaw/docs/concepts/compaction.md` | Compaction | OpenClaw | 2026.10.9 | 本机 |
| S13 | `…/openclaw/docs/concepts/context-engine.md` | Context engine | OpenClaw | 2026.10.9 | 本机 |
| S14 | `…/openclaw/docs/plugins/codex-harness-runtime/{compaction.md,threads.md}`、`docs/concepts/agent-runtimes.md` | Codex 运行时：压缩、镜像、线程 | OpenClaw | 2026.10.9 | 本机 |
| S15 | `…/openclaw/docs/concepts/{session-tool.md,subagent-yield-handoff.md,memory-provenance.md}` | Session 工具、子 Agent 交接、记忆来源 | OpenClaw | 2026.10.9 | 本机 |
| S16 | `…/openclaw/docs/tools/acp-agents/{delivery.md,sessions.md}` | ACP agents 投递与会话 | OpenClaw | 2026.10.9 | 本机 |
| S17 | 本仓库 `docs/research/first-chain-products-2026-10-11.md`、`docs/research/native-capability-surfaces-2026-10-11.md`、`docs/verification/native-capability-matrix.md` | 既有调研与能力矩阵 | HarnessHub | 2026-10-11 至 2026-11-01 | 本机 |
| S18 | https://code.claude.com/docs/en/context-window | Explore the context window | Anthropic | 2026-11-02 读 | 原文 |
| S19 | https://code.claude.com/docs/en/prompt-caching | How Claude Code uses prompt caching | Anthropic | 2026-11-02 读 | 原文 |
| S20 | https://code.claude.com/docs/en/hooks | Hooks reference | Anthropic | 2026-11-02 读 | 原文（分段） |
| S21 | https://code.claude.com/docs/en/checkpointing | Checkpointing | Anthropic | 2026-11-02 读 | 原文 |
| S22 | https://code.claude.com/docs/en/model-config | Model configuration | Anthropic | 2026-11-02 读 | 原文（分段） |
| S23 | https://code.claude.com/docs/en/claude-code-on-the-web | Use Claude Code in the cloud | Anthropic | 2026-11-02 读 | 原文 |
| S24 | https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/ | Lessons from building Claude Code: Prompt caching is everything | Thariq Shihipar / Anthropic | 2026-04-30 | 原文 |
| S25 | https://github.com/anthropics/claude-code/issues （#27242 #98747 #6354 #12505 #14258 #7530） | Claude Code 压缩相关 issue | 社区 | 2025-08 至 2026-10 | 源码（search API） |
| S26 | https://github.com/openai/codex/tree/main/codex-rs/core/src （compact.rs 等） | Codex 压缩实现 | OpenAI | main，`c62e9df39f`（2026-10-28） | 源码 |
| S27 | https://developers.openai.com/api/docs/guides/compaction | Compaction | OpenAI | 2026-11-02 读 | 原文 |
| S28 | https://github.com/openai/codex/issues （#14860 #48232 #15046 #19585 #16033 #4106） | Codex 压缩相关 issue | 社区 | 2025-09 至 2026-09 | 源码（search API）；#16033 为搜索 |
| S29 | https://opencode.ai/v2/docs/compaction | Compaction（V2） | OpenCode | 2026-11-02 读 | 原文 |
| S30 | https://github.com/anomalyco/opencode/issues （#13217 #33356 #7579） | OpenCode 压缩相关 issue | 社区 | 2026-01 至 2026-06 | 源码（search API） |
| S31 | https://ampcode.com/news/handoff | Handoff (No More Compaction) | Amp | 2025-10-23 | 原文 |
| S32 | https://ampcode.com/news/read-threads | Amp Now Reads Threads | Amp | 2025-10-29 | 原文 |
| S33 | https://ampcode.com/news/ask-to-handoff ；https://ampcode.com/news/stick-a-fork-in-it | Handoff, Please；Stick a Fork in It | Amp | 2026-01-13 | 原文；后者仅见索引 |
| S34 | https://ampcode.com/news/neo | Amp, Rebuilt | Amp | 2026-05-06 | 原文 |
| S35 | https://ampcode.com/news/read-bigger-threads | Read Bigger Threads | Amp | 2026-07-02 | 原文 |
| S36 | https://ampcode.com/news/from-agent-to-agent | From Agent to Agent | Amp | 2026-07-17 | 原文 |
| S37 | https://ampcode.com/notes/200k-tokens-is-plenty | 200k Tokens Is Plenty | Lewis Metcalf / Amp | 2025-12-09（已归档） | 原文 |
| S38 | https://ampcode.com/news | Amp News 索引 | Amp | 至 2026-10-29 | 原文 |
| S39 | https://cline.bot/blog/how-to-think-about-context-engineering-in-cline | How to think about context engineering in Cline | Nick Baumann / Cline | 2025-08-19 | 原文 |
| S40 | https://github.com/cline/cline/blob/main/apps/vscode/src/shared/slashCommands.ts ；`apps/vscode/src/sdk/sdk-compaction.ts` | `/newtask` 改为 `/compact` 别名（PR #12721） | Cline | 2026-07-30 | 源码 |
| S41 | https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks | Boomerang Tasks | Roo Code | 2026-11-02 读 | 原文 |
| S42 | https://thenewstack.io/?p=22820574 、https://www.distillintelligence.com/news/roomote | Roo Code 停运报道 | The New Stack 等 | 2026-04 至 05 | 搜索 / 二手 |
| S43 | https://cursor.com/en-US/blog/dynamic-context-discovery | Dynamic context discovery | Jediah Katz / Cursor | 2026-01-06 | 原文 |
| S44 | https://forum.cursor.com/t/context-window-summarization-and-choice/148699 等 | Cursor 论坛关于总结的讨论 | 社区 / Cursor 员工 | 2025 至 2026 | 搜索 |
| S45 | https://techdevnotes.com/releases/cursor-ide/20260628-000503Z-24c56c815201/content/changelog.txt ；https://forum.cursor.com/t/…/162470 | Cursor 本地与云端交接 | 第三方镜像 / 社区 | 2026-06 | 搜索 / 二手 |
| S46 | https://factory.com/news/evaluating-compression | Evaluating Context Compression for AI Agents | Factory Research | 2025-12-16 | 原文 |
| S47 | https://factory.com/news/compressing-context | Compressing Context | Theo Luan / Factory | 2025-07-21 | 原文 |
| S48 | https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f | Context Compaction Research: Claude Code, Codex CLI, OpenCode, Amp | Mario Zechner（badlogic） | 2025-12-02 | 原文 / 二手 |
| S49 | https://code.visualstudio.com/docs/agents/concepts/sessions | Understand sessions and chats（Hand off a session） | Microsoft | 2026-10-28 | 原文 |
| S50 | https://code.visualstudio.com/docs/agents/run/agent-harnesses | Choose an agent harness | Microsoft | 2026-10-28 | 原文 |
| S51 | https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatContinueInAction.ts ；issues #340860 #344559 | 交接实现 | Microsoft | `e847f29361`（2026-10-22） | 源码 |
| S52 | https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents ；https://github.blog/changelog/2026-02-04-claude-and-codex-are-now-available-in-public-preview-on-github/ | 第三方编码 agent；Claude 与 Codex 公开预览 | GitHub | 2026-02-04 起 | 原文；changelog 为搜索 |
| S53 | https://github.com/multica-ai/multica （`server/migrations/122_task_handoff_note.up.sql`、`packages/core/types/issue-workflow.ts`、`server/internal/service/issue_wakeup_evidence.go`、`server/internal/daemon/prompt.go`、`server/internal/daemon/execenv/{context.go,runtime_config_sections.go}`） | Multica 工作流交接与提示构建 | Multica | main，2026-11-02 | 源码 |
| S54 | https://www.conductor.build/changelog/0.28.1-context-directory-set-working-directories ；https://www.conductor.build/docs/concepts/workflow ；https://www.conductor.build/blog/context | `.context` 目录 | Conductor | 0.28.1（2025-12-23） | 原文；blog 为搜索 |
| S55 | https://github.com/yigitkonur/cli-continues | continues README | Yigit Konur | 推送于 2026-05-07，约 1,590 星 | 源码 |
| S56 | https://github.com/Dicklesworthstone/cross_agent_session_resumer | casr README | Jeffrey Emanuel（Dicklesworthstone） | 推送于 2026-10-14 | 源码 |
| S57 | https://codex.danielvaughan.com/2026/06/01/codex-cli-cross-agent-session-portability-continues-casr-handoff/ | Cross-Agent Session Portability | Daniel Vaughan | 2026-06-01（更新于 2026-11-02） | 原文 / 二手 |
| S58 | https://github.com/smtg-ai/claude-squad | Claude Squad README | smtg-ai | 推送于 2026-08-20 | 源码 |
| S59 | https://glama.ai/mcp/servers/@BeehiveInnovations/zen-mcp-server/blob/12090646ee83f2368311d595d87ae947e46ddacd/docs/context-revival.md | Context Revival | BeehiveInnovations | 未注明 | 搜索 |
| S60 | https://github.com/steveyegge/beads | Beads | Steve Yegge | 2026-11-02 读 | 搜索 |
| S61 | https://cognition.com/blog/dont-build-multi-agents | Don't Build Multi-Agents | Walden Yan / Cognition | 2025-06-12 | 原文 |
| S62 | https://geminicli.com/docs/cli/checkpointing/ ；https://geminicli.com/docs/get-started/configuration | Checkpointing；Configuration | Google | 2026-11-02 读 | 前者原文；后者搜索 |
| S63 | https://block.github.io/goose/docs/guides/smart-context-management | Smart Context Management | Block / AAIF | 2026-11-02 读 | 搜索 |
| S64 | https://aider.chat/docs/repomap.html | Repository map | Aider | 2026-11-02 读 | 原文 |
| S65 | https://docs.openhands.dev/sdk/guides/context-condenser | Context condenser | OpenHands | 2026-11-02 读 | 搜索 |
| S66 | https://docs.windsurf.com/windsurf/cascade/memories | Cascade Memories | Windsurf / Cognition | 2026-11-02 读 | 搜索 |
| S67 | https://www.promptz.dev/steering/promptz-steering-kiro-specs 等 | Kiro specs 与 steering | 第三方 | 2026 | 搜索 / 二手 |
| S68 | https://www.workbuddy.ai/docs/cli/release-notes/v2.125.5 ；https://www.workbuddy.ai/docs/cli/cli-reference | CodeBuddy Code v2.125.5 发布说明；CLI 参考 | Tencent | v2.125.5（无日期） | 原文；后者搜索 |
| S69 | https://agentclientprotocol.com/announcements/session-resume-stabilized | Session resume stabilized | ACP | 2026-04-22 | 搜索 |
| S70 | https://zed.dev/docs/ai/agent-panel | Agent Panel | Zed Industries | 2026-11-02 读 | 搜索 |
| S71 | https://docs.warp.dev/agents/using-agents/agent-conversations | Agent Conversations | Warp | 2026-11-02 读 | 搜索 |
| S72 | https://github.com/NousResearch/hermes-agent/issues/41607 （以及 #38364 #65848 #69619 #26035 #74712 #26081） | Hermes 压缩与 Codex 运行时 issue | 社区 / Nous Research | 2026-05 至 2026-07 | 源码（GitHub API） |
| S73 | https://www.producthunt.com/p/relai-2/relai | relai | relai 作者 | 2026 | 搜索 / 二手 |

