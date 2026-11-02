# R9 · 补遗：跨 Harness 交接的 2026 外部证据与可复用评测设施

调研员 R9（接力设计小组补充调研，Claude Opus 5.5 子代理）。阅读日期：2026-11-02（简报日；实际访问持续到 11-03 凌晨，本机时间）。本文只记录调研事实、推断与建议，不是已接受的决定。

标注约定：
- 【事实】有来源支撑，并且我打开过原文、PDF 或源码。
- 【事实，仅摘要】只看到搜索摘要，或抓取工具对页面的摘要，没有核对原句。
- 【推断】由事实推出，未经运行验证。
- 【建议】对 HarnessHub 的设计主张。

来源编号见第 7 节，如 [S3]。第一轮报告按文件名引用（R1 = r1-market-harnesses，R2 = r2-papers，R3 = r3-superagent，R5 = r5-native-channels，R6 = r6-performance-caching，R7 = r7-handoff-protocols-ux）。

---

## 0. 结论速览

1. **“叙述化还是原样搬运工具调用”有了一手工程证据，但仍没有定量实验。**
   - 【事实】OpenAI 自己的跨厂商导入器（Codex `/import`，源码）把 Claude Code 的 `tool_use` 扁平化为带标记的文字 `[external_agent_tool_call: 名称]`：只取描述、命令、文件三项，其余输入截到 2,000 字符；结果截到 4,000 字符；丢弃 thinking。末尾另加一个界面可见的 `<EXTERNAL SESSION IMPORTED>` 标记，以及按字节估算的 token 用量，让 Codex 能在第一个真实回合前自动压缩 [S26][S27]。按源码看，这个标记只写成界面事件，不进入模型可见的历史【推断】。
   - 【事实】zen 的反方向（Codex→Claude）只把 shell 类调用映射成原生 `Bash`，其余写成 `[migrated_tool_call: 名称]` 文本。理由是：原生历史里出现未知工具名，比带标记的文字记录更让模型困惑 [S26]。
   - 【事实】原样搬运工具名的一方（Harbor 的 ATIF 加载、session-migrate）只验证了“能加载、能续写、能复述哨兵”，没有做续接质量评测 [S4][S8][S25]。
   - 【事实】没有找到任何实验在不同脚手架之间续接轨迹，并比较两种渲染方式。
   - 【推断】R3 I-5 与 R1 D5 的叙述化默认得到厂商实践的支持。HH-RelayBench 应把 V5 拆成“原样移植”与“扁平化全文”两格，直接测量这一点。
2. **中立表示：ATIF 是“原生轨迹的容器”，不是语义中立层。**
   - 【事实】ATIF v1.8 不规范化工具名，`function_name` 保留各家原名 [S2][S9]。它适合作导出与评测数据，不适合作账本或交接单的 schema。
   - 【事实】Agent Trace v0.1.0（RFC，2026-01）只回答“某个 revision 上的某几行来自谁”，依赖 VCS revision；规范仓库在阅读时返回 404 [S23]。
   - 【事实】TRACEPROBE 已把 Claude Code、Codex、OpenCode 的 2,500 条轨迹确定性地归一到 9 类动作和 7 种效果标签 [S13]。
   - 【推断】账本需要的中立层是“规范动作类别 + 目标 + 效果”，可以从 HH 现有的 `PublicTool.kind` 与 diff 确定性生成。
3. **Harbor 适合作 HH-RelayBench 的离线执行框架，但不能代替 HH 的真机验收。**
   - 【事实】Harbor（Apache-2.0，v0.25.0）能在同一任务容器里驱动 Claude Code、Codex、OpenCode、Hermes、OpenClaw，以及 ACP 注册表中的 agent（含 `codebuddy-code`）[S7][S10]。
   - 【事实】多步任务的步与步之间就是 Run 边界：环境跨步保留，每步有隐藏测试 [S6]。
   - 【事实】用一家的轨迹种入另一家的新会话（ATIF 加载），只有 Claude Code 与 Codex 支持 [S4]。
   - 【事实】一次 trial 内不能换 agent [S6]。
   - 【推断】换人接手要用“两段 trial + artifacts 快照”拼出来；dsh 需要自写适配。
   - 【推断】Harbor 只跑 Linux 容器，不经过 HH 的 Gateway，所以测不了注入通道、水位和 macOS 行为。
4. **新的实证都指向“推小、拉大、看方向”。**
   - 【事实】AgentBaton（跨厂商、同一脚手架）：由弱交给强时，把历史放进日志文件让接手方去读（拉取），普遍好于放进上下文（推送），而且更便宜。DeepSWE 在 75% 交接点上：Qwen→GLM 从 38.9 升到 53.1，Qwen→Kimi 从 37.2 升到 50.4。由强交给弱时，放进上下文往往更好 [S18]。
   - 【事实】DCAS：脚手架的规划约定和工具调用格式是“承重”的。一个微调模型换到另一个脚手架后，从 52.6% 跌到 8.4%，原因是工具调用格式不兼容，几乎没有可解析的动作；由更强模型给出的显式计划能带来 +15 个百分点 [S15]。
   - 【事实】Fail-Fast/Restart-Smart：重启时不带历史，只把中断时的 diff 作为可开关的覆盖层，结果好于冷重启（71.8 对 66.8）；在编辑还没完成处切断，会毁掉本来可行的运行 [S17]。
5. **没有任何宿主在会话中途跨厂商交接，再交回来。**
   - 【事实】Zed、JetBrains 的文档都没有写这种功能 [S30][S31]。Warp 的 `/handoff` 只在同一个 Harness 内从本地交到云端 [S32]。Antigravity 只在同一个 Harness 内换用不同厂商的模型，在当前回合的步骤结束后生效 [S33]。
   - 【事实】跨厂商交接只靠一次性的迁移工具：Codex `/import`、zen、session-migrate、agent-session-bridge [S25]–[S29]。它们的共同做法是：由用户显式发起；在会话里留下来源前言或标记；按类别计数省略了什么；截断时打标记。

---

## 1. 范围与方法

**对象**：按简报线索逐项核实，另用 2026 年的关键词补搜了一轮。

| 主题 | 对象 |
|---|---|
| 中立表示 | Harbor 与 ATIF；Agent Trace |
| 评测设施 | Harbor：任务格式、多步任务、轨迹加载、交接、适配器、环境 |
| 论文（简报线索） | TRACEPROBE、Inside the Scaffold、DCAS、CORVUS、Fail-Fast/Restart-Smart |
| 论文（补搜新增） | AgentBaton、Routed Graph Handoff、Interface-Induced Trajectory Censoring；另有两篇旁证：Closed-World Resolution、Terminal-Universe |
| 迁移工具 | Codex `/import`（读源码）、zen、session-migrate；补搜新增 agent-session-bridge |
| 宿主 | JetBrains AI Assistant（ACP）、Google Antigravity、Warp、Zed |

**方法**：
- 仓库：用 `gh api` 只读读取源码、文档、PR 与 issue，并记录 commit。Harbor、Codex、session-migrate、zen 的关键文件下载到 scratchpad 阅读，没有执行其中任何代码。
- 论文：都打开了 arXiv 摘要页。TRACEPROBE、Fail-Fast、AgentBaton、Inside the Scaffold 另外读了 HTML。DCAS 没有 HTML 版本，读了 PDF 第 1–10 页。
- 文档：用 WebFetch 打开厂商文档页。
- 本仓库：只读了 `src/contracts/session.ts`、`content.ts`、`control.ts`，用来对照 `PublicRun` 与 `ContentRef`。
- 遵守简报第 5 节：没有运行任何 Harness 会话或提示，没有读用户数据，没有改用户配置。

**局限**：
1. WebFetch 由一个小模型抽取内容，可能有转述误差。关键数字尽量用源码、PDF 页面或第二次抽取核对。
2. 下面几篇只读了摘要页：CORVUS、Routed Graph Handoff、Interface-Induced Trajectory Censoring、Closed-World Resolution、Terminal-Universe。Inside the Scaffold 的 HTML 只读到前一半。AgentBaton 的摘要页抓取失败，读的是 HTML v1。
3. `github.com/cursor/agent-trace` 在阅读时，GitHub API 和网页都返回 404。规范内容来自 agent-trace.dev 与一份第三方研究笔记。
4. JetBrains 与 Antigravity 都没有一手文档说明“换 agent 或换模型后上下文是否带过去”。Antigravity 论坛上的员工回复只看到了搜索摘要。
5. 多数实证来自开放权重模型，或 mini-SWE-agent 这类极简脚手架，能否外推到 Claude Code、Codex 等闭源 Harness 未知。

**对简报线索的更正**【事实】：
- ATIF 当前是 v1.8，不是 v1.6；Harbor 接受 v1.0–v1.8 [S2][S3]。
- NeMo Relay 是 ATIF 的**生产者**（导出 v1.7），不是读取方。Phoenix 是读取方，支持 v1.0–v1.7，不支持 v1.8 新增的音频 [S11][S12]。
- “用一家的轨迹种入另一家的新会话”只有 Claude Code 与 Codex 两个接收方 [S4][S7]。
- Agent Trace 页面列出的参与方是 Amp、Amplitude、Cline、Cloudflare、Cognition、git-ai、Jules、OpenCode、Tapes、Vercel [S23]。
- Codex v0.145.0 对 `/import` 的扩展，是从 Cursor 与 Claude Code 迁移设置、MCP 服务器、插件、会话、命令和项目级记忆 [S28]。

---

## 2. 发现

### 2.1 ATIF：轨迹交换格式（v1.8）

- 【事实】定位与维护 [S2]：
  - RFC 0001，状态 Active，维护者 Boxuan Li。
  - v1.7 于 2026-04-27 合入（commit `0533a59c41`），由 NVIDIA 的两位作者贡献；v1.8 于 2026-08-26 合入（`74cc631201`），新增音频。
  - v1.7 对 v1.6 有破坏性变更：`SubagentTrajectoryRef` 改用 `trajectory_id` 解析，只有 `session_id` 的引用不再合法。
- 【事实】结构 [S2]：
  - 根对象：`schema_version`、`session_id`、`trajectory_id`、`agent`、`steps`、`notes`、`final_metrics`、`continued_trajectory_ref`、`extra`、`subagent_trajectories`。
    - `session_id` 按一次运行计，可以由多个文档共用（主轨迹与子轨迹、续段）。
    - `trajectory_id` 是单个文档的唯一标识。
    - `agent` 含 `name`、`version`、`model_name`、`tool_definitions`、`extra`。
  - step：
    - 必填 `step_id`（从 1 连续递增）、`source`（取值 `system`/`user`/`agent`）、`message`（字符串，或 text/image/audio 组成的 ContentPart 数组）。
    - 可选：`model_name`（单步可覆盖）、`reasoning_content`、`tool_calls[]`、`observation`、`metrics`、`llm_call_count`、`is_copied_context`、`extra`。
  - `tool_calls[]`：`tool_call_id`、`function_name`、`arguments`（必须是 JSON 对象）、`extra`。
  - `observation.results[]`：`source_call_id`、`content`、`subagent_trajectory_ref`、`extra`。
  - `metrics`：`prompt_tokens` 包含缓存命中部分，`cached_tokens` 是它的子集；另有 `completion_tokens`、`cost_usd`、token id、logprobs、`extra`。
- 【事实】三条与接力直接相关的约定 [S2]：
  - `is_copied_context: true`：表示这一步是从之前的轨迹复制进来作上下文的。用于 SFT 的消费方必须把它过滤掉。
  - `continued_trajectory_ref`：本轨迹在另一个文件里继续时，指向那个文件。原意是压缩产生的续段，各段共用同一个 `session_id`。
  - `extra.context_management = {type, boundary}`：`type` 取 `compaction`、`pruning`、`injection`，`boundary` 取 `replace`、`append`、`truncate`，两者都可扩展。规范性规则：`boundary` 为 `replace` 时，此后的有效上下文等于这一步的 observation 内容加上之后的新回合。
- 【事实】工具名不做规范化 [S2][S9]：
  - `function_name` 保留各家原名。例如 Harbor 示例中 Claude Code 的 `Write`，`extra` 里另存 `tool_use_name` 与原始参数。
  - `tool_definitions` 可选，采用 OpenAI 的函数调用 schema。
- 【事实】生态 [S11][S12]：
  - Phoenix 把 ATIF（v1.0–v1.7）转换成 OpenTelemetry span 树：上下文管理步骤成为 `compaction N`；`is_copied_context` 的步骤只作为上下文，不生成执行 span。
  - 大约 16 个以上、工具调用密集的回合，会超出 OTel 属性大小限制。
  - NeMo Relay（v0.10.4 文档）把运行时事件导出为 ATIF v1.7，嵌套 agent 写成嵌入的子轨迹。
- 【推断】ATIF 是“原生轨迹的无损容器，加上少量统一的度量与关系”，不是语义上的中立表示。跨家比较时，仍然要在它之上再做一层动作归一（见 2.5 TRACEPROBE）。

### 2.2 Harbor：能否作为跨 Harness 接力的执行框架

**仓库**：`harbor-framework/harbor`，main 为 `00dc6a7003`（2026-11-02），最新发布 v0.25.0（2026-10-25），Apache-2.0，约 6.7k 星。作者是 Terminal-Bench 团队，Harbor 是 Terminal-Bench 2.0 的官方评测框架 [S1]。

**适配器与能力**【事实】[S7][S10]：

| Agent | 适配器 | 产出 ATIF | 步间原生续接 | 加载 ATIF 种入 | 加载原生会话 | 任务级 MCP | 备注 |
|---|---|---|---|---|---|---|---|
| Claude Code | 内置 | ✓ | ✓ | ✓ | ✓ | ✓ | `handoff` 到本机 CLI 只支持它 |
| Codex | 内置 | ✓ | ✓ | ✓ | ✓ | ✓ | 可上传 `~/.codex/auth.json` |
| OpenCode | 内置 | ✓ | ✓ | — | — | ✓ | |
| Hermes | 内置 | ✓ | ✓ | — | — | ✓ | |
| OpenClaw | 内置 | ✓ | — | — | — | ✓ | 需要 Node 24.16+ 或 26.1+ |
| 通用 ACP（`acp:<id>`） | ACP 注册表或 git 源 | ✓ | — | — | — | ✓ | 注册表含 `claude-acp`、`codex-acp`、`opencode`、`opencode-v2`、`codebuddy-code`、`antigravity-acp` 等，不含 dsh、hermes、openclaw |
| dsh | 无 | — | — | — | — | — | 需自写：通用 ACP 的 npx 分发运行 `@deepseek-ai/dsh --profile acp`，或写一个 installed agent【推断】 |

**多步任务**【事实】[S6]：
- `steps/<name>/` 下各有 `instruction.md`、`tests/`、`solution/`、`workdir/`。
- 环境（文件系统）跨步保留。每步默认开新对话；`--resume-trajectory` 改为续接上一步的原生会话（需要 agent 支持 resume）。
- 每步可单独设 agent 与 verifier 配置，以及 `min_reward` 早停。`min_reward` 可以写成对象，要求多个命名奖励同时达标。
- `multi_step_reward_strategy` 取 `mean` 或 `final`。
- `workdir/setup.sh` 在每步开始前运行，可以用来模拟步与步之间的外部改动。
- “从指定步骤开始”尚未提供，文档注明 coming soon，要求之前各步都有 `solution/solve.sh`。

**冻结与注入的手段**【事实】[S6]：
- `artifacts` 在 agent 跑完、验证之前，把容器里的指定路径（文件或目录，可用 glob 排除）快照到 trial 目录；多步任务每步都收集一次。
- `[[environment.mcp_servers]]` 可以声明 stdio、sse 或 streamable-http 的 MCP 服务，兼容的 agent 会自动注册。
- 新建任务默认使用独立的验证环境（`verifier.environment_mode = "separate"`），测试文件不进 agent 的环境，因此可以隐藏。

**轨迹加载**【事实】[S4][S7][S9]：
- 两个层级：
  - 任务级：在 `instruction.md` 旁边放 `trajectory.json`。
  - 运行级：用 `--load-trajectory` 或 `agents[].load_trajectory`，并覆盖任务级。
- 原生 `.jsonl` 加载是无损的，但必须是同一个 agent。ATIF 加载可以跨 agent。
- 两种加载都**不恢复沙箱文件**。
- 转换会保留“支持的消息、工具调用和工具结果”，可能丢掉系统消息、非文本内容和 agent 特有的细节。
- 源码中的具体行为：
  - **ATIF→Claude Code**：工具调用写成原生 `tool_use`，`name` 直接用 `function_name`；缺结果的调用补 `"[no output recorded]"`；图片写成 `"[image omitted]"`；`system` 步骤直接丢弃。
  - **ATIF→Codex**：写成 `function_call` 或 `custom_tool_call`，工具名同样原样保留；`system` 步骤转成 `developer` 消息。
  - 【推断】也就是说，一条 Codex 轨迹种入 Claude Code 后，Claude 的历史里会出现 Codex 自己的工具名（如 `exec_command`、`apply_patch`）；反方向，Codex 的历史里会出现 `Write`、`Edit`。
- 验证程度：PR #2628（2026-08-06 合入）的测试是一个 hello 回忆题，即“说出你之前创建的文件名和内容”[S8][S9]。
- 已知问题 [S8]：
  - #3560（2026-10-07，未合并）：任务镜像的 WORKDIR 不是 `/app` 时（例如 SWE-bench 风格镜像用 `/testbed`），Claude Code 找不到种入的会话，报 “No conversation found”。
  - #3558：Codex 的 ATIF 转换会丢掉 MCP 工具名里的命名空间。

**其他**【事实】[S1][S5][S7]：
- `harbor trial handoff` 把已完成 trial 的原生会话复制进本机 Claude Code 并 `claude --resume`，只支持 claude-code 的单会话 trial；官方定位是“事后访谈 agent”。
- 环境：本地 Docker、Podman、Apple Container（Apple silicon 上的轻量 Linux 虚拟机），以及多家云沙箱。**全部是 Linux**。
- 凭据：API key；Claude Code 还接受 `CLAUDE_CODE_OAUTH_TOKEN`；Codex 可以把 `~/.codex/auth.json` 上传进容器。
- `rewardkit` 的轨迹判据（某工具是否被用过、回合数）按原生 `function_name` 计数 [S7]。

**【推断】对 HH 的适配度**：
- 能做：在同一个任务容器里，冻结某个 Run 边界上的工作区，换另一家接手，在 instruction 中注入不同视图的交接材料，用隐藏测试判定。这正是 R2-22 的设置。
- 做不到：
  - 一次 trial 内换 agent；
  - 让 dsh 开箱即用；
  - 经过 HH 的 Gateway、ACP 资源块与 MCP 注入通道、水位推进；
  - macOS 行为。
- 因此只能用来校准“交接单写什么、写多少”，不能作为 AGENTS.md 要求的正式入口真机验证。

### 2.3 跨厂商会话迁移工具：带过去什么、怎样截断、怎样告知

**Codex `/import`（OpenAI 一手源码）**【事实】[S27][S28]：
- 演进：
  - v0.145.0（2026-07-21）把 `/import` 扩展到 Cursor 与 Claude Code 的设置、MCP、插件、会话、命令和项目级记忆。
  - 2026-10-19 起，对转入后台的 Claude 会话只导入其后续部分（#55365）。
  - 2026-10-23 支持 memory v2（#56414）。
- 会话的转换（`external-agent-migration/src/sessions`，main `8806313db4`）：
  - 只生成 user 与 assistant 两种文本消息，每条用户消息开一个回合。第一条用户消息之前的 assistant 消息丢弃。`isMeta` 与 `isSidechain` 记录跳过，也就是不导入子 Agent。
  - `tool_use` 变成文本：`[external_agent_tool_call: 名称]`，只取 `description`、`command`、`file_path`/`file` 三项；三项都没有时取输入 JSON，截到 2,000 字符。
  - `tool_result` 变成 `[external_agent_tool_result]`（出错时为 `[external_agent_tool_result: error]`），截到 4,000 字符。
  - thinking 丢弃；其他未知块写成 `[external unsupported block: 类型]`。
  - 在最后一个回合结束前，追加一条 `<EXTERNAL SESSION IMPORTED>` 标记，并按字节数估算一个 token 用量，这样 Codex 可以在第一个真实回合前自动压缩 [S26][S27]。
  - 标记的写法是界面事件 `EventMsg::AgentMessage`，不是 `ResponseItem`。源码测试也印证了这一点：一问一答导入后，模型可见的消息仍只有 2 条 [S27]。【推断】模型看不到这个标记；模型能看到的来源信号，只有工具记录里的标签名 `external_agent_tool_call`。外来的 assistant 正文以本线程 assistant 的身份出现。
- 检测上限：只看 30 天内、最近 50 个来源会话（`DEFAULT_SESSION_IMPORT_MAX_AGE`、`DEFAULT_SESSION_IMPORT_MAX_COUNT`）。zen 另外报告：Codex 会跳过 cwd 已不存在的会话 [S26]。
- 账本与同步：
  - `~/.codex/external_agent_session_imports.json` 以源文件的 `content_sha256` 识别，路径变了仍能匹配，内容变长则视为新版本。
  - 增量同步时，只有目标线程的模型可见转录**恰好是**源的前缀，才把缺失的后缀追加进去。目标正在运行、已归档或已分叉时，一律 fail closed。
- 接口：Codex app-server 有 `externalAgentConfig/detect`、`externalAgentConfig/import`、`externalAgentConfig/import/recordHistory`、`externalAgentConfig/import/readHistories`，以及进度与完成通知。
- 【推断】这是一次性的单向镜像：会把外来 assistant 回合写成本线程的 assistant 角色，但工具调用一律扁平化为带标记的数据；靠哨兵消息和 token 估算，避免外来历史一进来就撑爆窗口。

**zen（`mgreau/zen`）**【事实】[S26]（文档按 Claude Code 2.1.200 与 Codex CLI 0.142.0 核实）：
- 两个方向的实现刻意不对称：
  - Claude→Codex：经 app-server 驱动 Codex 自己的导入器，zen 从不写 `~/.codex`。
  - Codex→Claude：zen 合成一个 Claude 的会话 JSONL 文件。
- Codex→Claude 的映射：
  - shell 类调用（`exec_command`、`shell`、`local_shell`）写成原生 `Bash` 的 `tool_use`；
  - 其他调用写成 `[migrated_tool_call: 名称]…[/migrated_tool_call]` 文本，结果写成 `[migrated_tool_result]`；
  - 单条输出截到 32 KB；保证每个调用都紧跟它的结果，因为 Anthropic API 拒绝悬空的 `tool_use`；
  - 文件开头放一条用户消息作前言，写明来源线程，并说明工具调用经过了翻译。
- 文档的说法：前言“可测量地减少”接收方对历史的困惑；接收方偶尔会评论自己历史的“外来形状”，有前言时无害。**没有给出数字。**
- 已知的格式陷阱：
  - assistant 记录缺少 `model` 字段时，`claude --resume` 会无限挂起；
  - 会话文件超过 5,242,880 字节时，Claude 的恢复快速路径会丢弃最后一个压缩边界之前的全部内容，所以 zen 把文件封顶在 4 MiB：最新的记录优先保留，前言总是保留，截断处加注记，不拆开调用与结果的配对。

**session-migrate（`xhluca/session-migrate`）**【事实】[S25]：
- 版本：0.12.0（2026-10-19，`45351ff95c`），MIT。
- 支持 18 种格式，包括 Claude Code、Codex、OpenCode、Hermes、Antigravity、Cursor、Devin 等，不含 dsh 与 OpenClaw；共 324 条有序转换路线。
- 路线：`原生会话 → 校验过的事件时间线 → 目标原生格式 → resume`。
- Claude 的 `tool_use` 与 Codex 的 `function_call` 互转时**工具名原样保留**。Codex 的自由格式输入包进一个对象，并计入损失。
- system/developer 消息省略并计数，绝不降级为用户消息。thinking 一律不移动。非活跃分支与子 Agent 不展开。认证、hooks、MCP 不迁移。
- **不做脱敏**：密钥会原样进入目标转录。
- 输入上限：单条记录 64 MiB、单个文件 256 MiB、100,000 条记录。
- 每次转换都输出一份不含内容的迁移清单，按类别计数所有省略与变换。
- 验证范围：
  - 324 条路线的确定性转换与回读；
  - 每个目标至少一个“原生客户端能发现、加载、追加回复”的门禁；
  - 离线检查明确声明“不代表模型给出了网络回复”；带凭据的真实模型调用只作为发布门禁。

**agent-session-bridge（PyPI 0.5.0，2026-08-03）**【事实】[S29]：
- 支持 Claude Code（2.1.212）、Codex（0.146.0）、Hermes。
- 中间表示包含消息（text、reasoning、tool_call、tool_result）、工具 schema 和未完成状态。
- “resume handshake”：在恢复后的会话开头插入一段前言。
- 源会话停在一个没有结果的工具调用上时，会补齐结果，因为 OpenAI Responses 会返回 400，Anthropic 要求必须有 `tool_result`。
- 每次转换报告固有的损失：线程拓扑；推理签名（只能以摘要文本保留）；工具 schema（只有 Hermes 存储它）；权限与沙箱姿态；单回合内的模型切换。
- 实机验证：2026-07-28，六个有向组合都通过了“同时召回用户与助手的哨兵”。

| 工具 | 方向 | 外来工具调用怎么处理 | thinking | 截断 | 来源告知 | 损失账目 | 验证到哪一步 |
|---|---|---|---|---|---|---|---|
| Codex `/import` | Claude Code、Cursor → Codex | 扁平化为带标记的文本 | 丢弃 | 输入 2,000 字符；结果 4,000 字符 | 对模型：工具记录的标签名；对用户：界面标记 | 导入状态 | 前缀一致才追加 |
| zen | Claude↔Codex | shell→`Bash`，其余为带标记的文本 | 丢弃 | 单条 32 KB；文件 4 MiB | 前言 | — | 真机手工核对 |
| session-migrate | 18 种格式两两互转 | 原样映射 | 不移动 | 记录/文件/条数上限 | — | 按类别计数的清单 | 加载与追加 |
| agent-session-bridge | Claude、Codex、Hermes 三家互转 | 原样，补齐悬空的调用 | 只留摘要文本 | — | handshake 前言 | 每次转换的报告 | 哨兵召回 |
| Harbor ATIF 加载 | 任意 → Claude/Codex | 原样，名字不改 | — | — | — | — | hello 回忆题 |

### 2.4 宿主产品：会话中途能否换厂商接手

| 宿主 | 能做什么 | 带过去什么、怎样告知 | 来源 |
|---|---|---|---|
| Zed | 从已配置的外部 agent 经 ACP 导入线程到“线程历史”；导入的线程是归档项，打开后可继续 | 没有 cwd 的会话跳过；重复导入安全；**同一线程内不能换 agent**；可在新线程里 @ 引用旧线程；“New From Summary”只适用于 Zed 自家 agent | 【事实】[S30] |
| JetBrains AI Assistant 2026.2（文档 2026-10-07 更新） | 在 AI Chat 的列表里选 ACP agent | 文档**没写**切换后之前的消息是否交给新 agent，也没写交接功能 | 【事实】[S31]；具体行为未核实 |
| Warp（文档 2026-10-29） | `/handoff` 把本地对话 fork 给云端 agent | 带完整转录，不是摘要；把未提交的改动连同未跟踪文件做快照，在云端应用；有命令在运行、或子 agent 在运行或被阻塞时不能交接；云端子 agent 可以用 Claude Code 或 Codex，但用其他 Harness 跑的对话不能在 CLI 里打开 | 【事实】[S32] |
| Google Antigravity | 同一对话里可以在 Gemini、Claude、GPT-OSS 之间换模型 | 运行中途换模型，要等当前回合的步骤结束或取消后才生效；换模型时历史怎么处理，文档没写 | 【事实】[S33]；论坛上的员工回复【仅摘要】 |

【推断】宿主层面能做到的是“同一 Harness 换模型”（Antigravity）和“同一 Harness 跨环境交接”（Warp）；跨厂商只到“导入线程”这一步（Zed）。HarnessHub 的“同一对话中途换厂商接手并能换回来”仍然没有现成先例，R1 的结论成立。

### 2.5 论文

**TRACEPROBE：“What Resolve Rate Hides”**（arXiv 2607.06184 v1，2026-07-07）[S13]〔预印本〕
- 【事实】数据：5 种生产配置——Claude Code + Opus 4.6、Codex + GPT-5.4、OpenCode + Opus 4.6/GPT-5.4/GLM-5——跑完 SWE-bench Verified 全部 500 题，共 2,500 条轨迹。
- 【事实】方法：各脚手架的适配器先把轨迹转成统一的步骤 schema（角色、带类型的工具调用记录、资源、时间、错误状态），再把每一步映射为“规范动作 + 目标”，文件目标用相对仓库根的路径。
  - 9 类动作：FILE READ、FILE WRITE、SEARCH、COMMAND、AGENT SPAWN、PLAN、NAVIGATE、FETCH、REASON。
  - 效果标签：SURVIVED、FAILED、REVERTED、JUSTIFIED、RECORDED、OFF-ANCHOR、REASONING。
  - 工具齐全时仍用 shell 的 `cat`、`grep`、`find`，会被标为 shell-over-tool。
  - 语义标签由 GPT-5.4 给出，只用于探索性分析。
- 【事实】两个可以直接复用的指标定义：
  - Search Loop：至少连续 10 个 SEARCH 或 FILE READ，中间没有 FILE WRITE，也没有验证命令。
  - Re-read Churn：在 10 个动作的窗口内，同一路径被读至少 3 次，中间没有写过它。
- 【事实】结果：
  - 已解决与未解决的运行相比：搜索循环 41.1% 对 56.1%；重读 34.0% 对 44.7%；无证据就宣布完成 7.6% 对 9.5%。
  - Codex 的解决率为 78.4%。
  - 数据与代码在 Zenodo（DOI 10.5281/zenodo.20789918），许可证未注明。

**Inside the Scaffold**（arXiv 2604.03515 v2，2026-04-10，单作者 Benjamin Rombaut）[S14]〔预印本〕
- 【事实】按固定 commit 分析了 13 个开源脚手架：OpenCode、Gemini CLI、Codex CLI、Cline、Aider、OpenHands、SWE-agent 等。Claude Code 因为是闭源二进制被排除。
- 【事实】12 个维度分三层。各家的工具数从 0 到 37。上下文压缩有 7 种策略。有 5 种循环原语，13 个中有 11 个组合了多种。
- 【事实】能力类别趋同：凡是由 LLM 驱动的 agent 都有读、搜索、编辑、执行四类。编辑格式却分化：
  - 函数调用式的字符串替换，如 `str_replace_editor`、`apply_patch`、`edit`；
  - 整文件写入；
  - Aider 的 13 种文本编辑块；
  - 少数情况下可选的 unified diff。
- 【事实】会话存储：Codex 是 JSONL rollout 加 SQLite；OpenCode 是 SQLite 加带类型的消息部件；OpenHands 是事件溯源。可见部分没有提到任何导入、导出或互通。
- 【推断】中立表示应当建在趋同的“能力类别”上，而不是分化的“编辑格式”或工具名上。把 Codex 的 `apply_patch` 原样放进 Claude Code 的历史，等于展示了一个它没有的动作格式。

**DCAS: Decoupling CLI Agent Scaffolding to Internalize Planning across Scaffolds**（arXiv 2608.06113 v1，2026-08-06；ASE '26，作者来自 Huawei Canada 与 Queen's University；CC BY-NC-ND 4.0）[S15]〔评审〕
- 【事实】表 1（SWE-bench Verified，Pass@1，最多 100 回合；四列依次为 OpenHands / Claude Code / OpenCode / mini-swe-agent）：

  | 模型 | OpenHands | Claude Code | OpenCode | mini-swe-agent |
  |---|---|---|---|---|
  | Qwen3-32B（基座） | 29.0 | 23.2 | 18.4 | 8.0 |
  | SWE-Lego-Qwen3-32B | 52.6 | 44.2 | **8.4** | 37.6 |
  | Nebius-SWE-Rebench-30B | 49.7 | 46.0 | 35.8 | 20.4 |
  | Qwen3-32B-Nex-N1（用多格式轨迹训练） | 50.5 | 50.8 | 26.2 | 15.6 |

  - 每个微调模型都至少在一个没训练过的脚手架上退化；未微调的基座模型在各脚手架之间的分散度更小。
  - 8.4% 的原因：该模型的工具调用输出格式和 OpenCode 的解析器不兼容，多数轨迹**没有一个可解析的动作**。
  - 另有两个模型（SERA-32B、Nex-N1）训练时的上下文长度是 32,768 token，与 Claude Code 硬编码的 32,000 token 输出上限冲突，未做处理前请求直接失败；表中是作者用 YaRN 扩展上下文后的分数。
- 【事实】机制：作者认为“规划结构”是承重的约定，分为显式规划（执行前产出计划）和隐式规划（拆解粒度、何时从探索转为动手、工具调用顺序、失败后怎样重新规划）。
- 【事实】RQ1（执行模型固定为 Qwen3-Coder-30B-A3B，脚手架为 Claude Code 2.0.76）：

  | 计划来源 | Pass@1 |
  |---|---|
  | 无计划 | 42.8 |
  | 自己写计划 | 48.2 |
  | Qwen3-480B 写计划 | 49.2 |
  | Opus 4.5 写计划 | 54.2–56.0 |
  | Sonnet 4.5 写计划 | 57.8（+15.0） |

- 【事实】RQ3：用 576 条“带规划”的轨迹微调后，在没训练过的脚手架上也有提升：OpenCode 46.0→49.4，mini-swe-agent 35.4→42.4。
- 【事实】经翻译代理接入 Codex CLI v0.118.0 失败：代理对所有调用都返回 HTTP 200，但 Codex 在 10 到 18 次往返后不再响应，因此被排除。
- 【推断】对接力的含义：
  - 接收方模型带着“自己脚手架的规划习惯”；外来脚手架的轨迹结构对它是分布外的。
  - 由强模型写的显式计划是高杠杆信息，所以交接单应当带上计划快照，并标明作者（见 R9-6）。
  - 证据来自开放权重的微调模型，闭源前沿模型对外来结构的敏感度未知。

**CORVUS**（arXiv 2607.22711 v1，2026-07-20）[S16]〔预印本，只读摘要〕
- 【事实】问题：每次读文件的观察结果都留在轨迹里，文件一改，这份副本就过时了，agent 只好再读，形成重复副本。
- 【事实】做法：把“读文件”的动作和它的观察分开，维护一个同步的相关文件登记表，每个推理周期注入这些文件的当前内容。
- 【事实】结果：在 SWE-PolyBench Verified 与 SWE-Bench Pro 上用 4 个 LLM 测试，平均输入 token 降低 9–50%，最终提示缩短 15–32%，推理周期最多减少 37%，通过率与基线相当。
- 【推断】接力时这个问题更严重：B 改过的文件，A 历史里读到的内容已经过时。交接单不应携带旧的读取结果，应当给出文件登记（路径、谁读过、谁写过、交接时的指纹）。

**Fail-Fast, Restart-Smart**（arXiv 2608.03222 v1，2026-08-04）[S17]〔预印本〕
- 【事实】设置：mini-swe-agent v2.2.8，SWE-bench Verified，每条轨迹最多 100 步。
- 【事实】FailFast：一个 0.6B 的监控模型，只看部分轨迹，不读 logits。在 5% 误报率下节省 14.6–20.4% 的执行 token，可以迁移到包括闭源 API 在内的三种其他策略模型。
- 【事实】RestartSmart：
  - 新的运行**不继承提示历史**；工作区回到原始状态。
  - 中断时的累计 `git diff` 作为一个可开关的工具提供，命令有 `overlay diff`、`overlay status`、`overlay on`、`overlay off`，默认关闭。
  - 任务说明写明：这些改动可能是正确修复、不完整修复或方向错误；要求先复现问题；禁止 `git checkout` 与 `git reset`。
- 【事实】数字：

  | 模型（误报率） | 原始 | RestartSmart | 冷重启 | 误杀本可通过的运行（RestartSmart / 冷重启） |
  |---|---|---|---|---|
  | Qwen3.6-27B（25%） | 66.6 | 71.8 | 66.8 | 8.8% / 27.5% |

  - 在编辑还没完成处立刻截取 diff，会产生零碎的覆盖层：误杀率 18.8%，等编辑告一段落再截取则是 8.8%。
  - token 净开销 +30.3% 到 +43.8%；冷重启为 +17.8% 到 +18.2%。
  - 作为对照的 SWE-PRM 提示干预，让 Qwen3.6-27B 从 66.6 降到 63.4。作者称“提示指导会对更强的模型起反作用”。
  - “冗长摘要会造成锚定”只是动机陈述，没有实验。
- 【推断】有两点可借：
  - 交接点必须落在编辑完整的边界上，HH 只在 Run 边界切换，这一点天然满足；但被取消或结果未知的 Run 可能留下半截改动，需要特别标记。
  - 措辞上把继承来的改动描述为“未经验证，可能有误”，并要求先复现。
  - “可开关的覆盖层”不能照搬：HH 不能回滚用户的真实工作区。

**AgentBaton**（arXiv 2610.35959 v1，2026-10-25；HKUST、NVIDIA、UIUC）[S18]〔预印本，补搜新增〕
- 【事实】设置：
  - 一次性的模型交接，**大多跨厂商**：强模型有 GPT-5.6 Sol、Kimi K3、GLM-5.3、Claude Opus 5、Gemini 3.8 Flash；便宜模型有 Qwen 3.8 27B、GPT-5.6 Luna。
  - 脚手架统一用 mini-SWE-agent v2.4.0（只有 bash）；基准为 Terminal-Bench 2.1 与 DeepSWE v1.1。
  - 接手方继承工作区。历史以两种方式交给它：
    - 上下文内（IC）：把来源的可见文本和工具调用转成接手方的对话格式，丢弃拿不到的推理；
    - 日志文件（LF）：在任务环境里放一个 `.jsonl` 文件，每回合一条记录，含原始回复与每个动作的返回码、stdout、stderr。接手方开新会话，拿到原任务、日志路径和格式说明，并被提示先看最后几条。
- 【事实】表 1 节选（准确率 % / 每题美元成本）：

  | 方向 | 基准与交接点 | IC | LF |
  |---|---|---|---|
  | Qwen→GLM | DeepSWE 75% | 38.9 / 2.61 | **53.1 / 1.87** |
  | Qwen→Kimi | DeepSWE 75% | 37.2 / 5.76 | **50.4 / 2.52** |
  | Qwen→GPT | DeepSWE 75% | 58.4 / 8.84 | **67.3 / 5.74** |
  | Qwen→Kimi | Terminal-Bench 75% | 70.8 / 3.31 | **79.8 / 1.30** |
  | Kimi→Qwen | DeepSWE 30% | **69.9** / 1.11 | 56.6 / 1.11 |
  | GLM→Qwen | DeepSWE 30% | **61.1** / 0.56 | 54.9 / 0.56 |
  | GPT→Qwen | DeepSWE 30% | 54.9 / 1.25 | **56.6** / 1.25 |

  - 由便宜交给强时，通常不如只用强模型，也省不了多少钱。
  - 由强交给便宜、交接点合适时，能保持或提高准确率并降低成本；AgentBaton 的检测器平均降低 API 成本 65.9%，准确率最多 +8.8 个百分点。
  - 没有报告“只给工作区”的基线，也没有观察到接手方误用继承来的工具或格式。但脚手架相同、只有 bash，本来就没有工具 schema 的差异。
- 【推断】这是到目前为止最直接的跨厂商证据：方向决定该推还是该拉；拉取式日志在弱→强时既更准又更便宜。它与 Handoff Tax、New Model Old Habits（R2 来源清单的 S61、S62）同向。

**Routed Graph Handoff**（arXiv 2608.25277 v1，2026-08-26；EMNLP 2026）[S19]〔评审，只读摘要〕
- 【事实】多 Agent 系统里，自然语言消息占 token 预算的 40–60%。
- 【事实】一个 155 token 的路由器为每次委派选择“带类型的依赖图”或“自然语言”：τ-retail +12.7 个百分点（压缩 3.2 倍），BrowseComp +8.7 个百分点，BFCL 与 AppWorld 持平。
- 【事实】只用图会让 AppWorld 下降 14.6 个百分点。图必须配一个“读图”的执行器提示，没有解读说明的同一 schema 毫无增益。
- 【推断】结构化交接内容必须配一段固定的解读说明（R3 I-1 的 L0 契约头）；需要随机应变的任务，以自然语言为安全的默认。

**Interface-Induced Trajectory Censoring**（arXiv 2609.03966 v3，2026-10-22）[S20]〔预印本，只读摘要〕
- 【事实】模型产出了形似工具调用的内容，但服务端的模板或解析器不匹配，结果报告零次调用。
- 【事实】数字：
  - 只换服务适配器，BFCL simple_python 从 0.00 变成 0.96；
  - 模板和解析器必须同时替换，才能恢复 200 次首轮解析中的 196 次；
  - 在 verl 中只换解析器，工具执行次数从 10 次变成 16,844 次。
- 【推断】与 DCAS 的 8.4% 是同一类机制：格式不匹配会让行为静默消失。闭源 Harness 的表现形式不同：Anthropic 拒绝悬空的 `tool_use`；Claude 恢复时缺少 `model` 字段会挂起 [S26][S29]。原样搬运的风险主要落在“格式与协议”上，不只是“语义”。

**旁证**：
- 【事实】Closed-World Resolution Against Tool Hallucination（arXiv 2609.19425 v1，2026-09-16）[S21]：
  - 10 个托管模型共记录 322 次真实的工具幻觉；
  - 凭空捏造工具的调用，在“原始 JSON”调用面上远多于原生面（34 对 3）；
  - 多个 MCP 服务器合并命名空间后，又出现 154 次。
  - 它没有研究“历史里出现的工具名”诱发的幻觉。
- 【推断】交接单里如果写出 JSON 形式的调用对象，可能把模型推向原始 JSON 式的调用。这只是弱推断，没有直接证据。
- 【事实】Terminal-Universe（arXiv 2609.04148 v1）[S22]：回放已记录的文件操作，把每个文件恢复到被修改之前的状态，由此从公开轨迹得到 3.73 万个可运行的终端环境。可以作为从轨迹重建交接点工作区的技术参考。

### 2.6 中立表示核对：ATIF、Agent Trace 与 HarnessHub 公共事实

**PublicRun → ATIF**（字段见 `src/contracts/session.ts:92`、`content.ts`、`control.ts`）[S34][S2]：

| HH 事实 | ATIF 去向 | 损失或需要改造 |
|---|---|---|
| `Session.id` | 根 `session_id`（按运行计，多段可共用） | — |
| 同一原生绑定上连续的 Run 区间 | 一个 Trajectory 文档：`trajectory_id` = 段 id，各段用 `continued_trajectory_ref` 串起来 | ATIF 的续段原意是“压缩造成的”，借用这层语义要在 `notes` 中说明【推断】 |
| `selection.harnessId`、Harness 版本、`NativeSessionBinding.observed.model` | `agent.name`、`agent.version`、`agent.model_name`，单步可用 `model_name` 覆盖 | Run 里不存 Harness 版本，要从能力探测结果补 |
| `PublicRun.input` 与 `attachments` | `source:"user"` 的 step；图片和音频写成 ContentPart，`path` 指向导出包内的文件 | ATIF 的图片类型（png/jpeg/gif/webp）与 HH 完全一致，音频可经别名归一；`kind:"file"` 的附件**没有对应类型**，只能写文字占位，并在 `extra` 里放 ContentRef |
| assistant 回复正文 | `source:"agent"` 的 step 的 `message` | HH 不保留文本与工具的交错顺序，也不保留每次 LLM 调用的边界，所以 `llm_call_count` 只能为 null，顺序是近似的 |
| `thinking` | `reasoning_content` | 只有可见部分 |
| `tools[]`（id、title、status、kind、name、parentId、exitCode、detail） | `tool_calls[]`：`tool_call_id` = id，`function_name` = name，没有就用 kind，`arguments` 见右栏；`observation.results[].extra` 放 status、kind、退出码、diff 引用、locations、parentId、是否截断 | `arguments` 必须是对象，而 HH 只有截断过的 `input` 字符串，只能包成 `{"input": "…"}`（与 session-migrate 的包装同法）；子工具层级没有一等字段 |
| `plan` | step 的 `extra.plan` | 没有一等字段 |
| `usage.turn`、`usage.cost` | `metrics`（`prompt_tokens` 含缓存部分）；币种为 USD 时写 `cost_usd` | 各驱动的计量口径不同（R6 第 5 节），要按驱动换算 |
| `activities` 中的 compaction | `source:"system"` 的 step 加 `extra.context_management` | HH 拿不到原生摘要的内容，**不能声明 `replace`**；只能用扩展值，例如 `boundary:"opaque"`【建议】 |
| 其他 `activities`（子 Agent、任务、重试、评审） | `extra` | 拿不到子轨迹，不能用 `subagent_trajectory_ref` |
| `status`、`error`、cancelled、unknown | step 的 `extra.status` | 没有一等字段；unknown 必须原样保留 |
| `timing` | step 的 `timestamp` | 只有阶段时刻，没有逐步时刻 |
| 分支与导入的引用历史（`ForkedMessage`、`ImportOrigin`） | `is_copied_context: true` 的 steps | 正好对口 |
| 权限请求与用户决定、`notices` | `extra` | 没有一等字段 |

【推断】账本需要而 ATIF 没有的字段：取代关系与有效期、出处与核实状态、受众（按目标 Provider 过滤）、水位、单条事实的内容指纹、策略版本。所以 ATIF 只能作为派生的导出格式（见 R9-14、R9-15）。

**Agent Trace v0.1.0**【事实】[S23][S24]：
- 记录结构：
  - 一条 TraceRecord：`version`、`id`、`timestamp`，可选 `vcs{type, revision}`、`tool{name, version}`、`metadata`（反向域名为键）。
  - `files[]` 的每项：`path`，以及 `conversations[]`。
  - 每个 conversation：`contributor{type: human|ai|mixed|unknown, model_id}`，`model_id` 按 models.dev 约定写成“提供方/模型”；`ranges[]` 的每项为 `start_line`、`end_line`、`content_hash`，可选单独的 contributor；另有 `related[]` 与 `url`。
- 语义：
  - 行号是“记录时那个 revision 上”的位置；查某行归属要先 blame 到 revision。
  - 存储方式明确不规定。
  - 不做代码所有权、训练数据来源与质量评估。
  - 许可证 CC BY 4.0。
- 【推断】它能表达“哪个 Harness（`tool`）、哪个模型（`model_id`）写了哪些行”，但对接力有四个缺口：
  1. HH 会话中的改动通常还没提交，没有 revision 可依附，只能靠 `content_hash`；
  2. 只能标注留下来的行，删除无从表达；
  3. 一条记录只有一个 `tool`，多 Harness 会话要按 Run 或按段拆成多条记录；
  4. 交接单需要的是“改了什么、是否还在”，不是行级归属。
- 【事实】规范在 2026-01 发布为 RFC v0.1.0，阅读时仓库返回 404 [S23]。成熟度存疑。

---

## 3. 模式归纳

1. **工具调用的跨厂商处理分成两派**【事实】：
   - 一手厂商（Codex 导入器 [S27]）与面向“继续干活”的工具（zen [S26]）选择扁平化为带标记的文字；zen 只把语义完全等价的 shell 映射到目标的原生工具。
   - 面向“数据保真”的工具（Harbor 的 ATIF [S4]、session-migrate [S25]）原样搬运工具名。这一派只做过加载与回忆层面的验证。
2. **thinking 与推理签名从不跨厂商移动**【事实】：Codex 导入器、zen、session-migrate 一律丢弃；agent-session-bridge 只留摘要文本 [S25]–[S29]。与 R3 I-9 一致。
3. **都要标明“这段历史是外来的”，但告知的对象不同**【事实】：
   - zen 的前言与 agent-session-bridge 的 handshake 是给模型看的 [S26][S29]。
   - Codex 对用户用界面标记，对模型只靠工具记录的标签名 [S27]。
   - 唯一的量化证据仍是 Handoff Tax：在原始轨迹上声明“前任是另一个模型”，只多 1.2 个百分点（R7 2.7）。
4. **截断都有上限，而且有标记**【事实】：Codex 2,000/4,000 字符，zen 32 KB/4 MiB，session-migrate 64 MiB/256 MiB [S25]–[S27]。与“超限不静默截断”一致；VS Code 静默截尾是反例（R1）。
5. **损失要可计数**【事实】：session-migrate 的无内容清单、agent-session-bridge 的转换报告、Codex 的导入状态 [S25][S27][S29]。
6. **验证都停在“能加载、能续写、能复述”**【事实】：没有一个工具测量接手后续做工作的质量。质量证据只来自论文：Handoff Debt、HSC-Bench、Handoff Tax、AgentBaton。
7. **中立格式保留原生工具名，归一化只在分析工具里出现**【事实】：ATIF、session-migrate 的中间表示都保留原名；TRACEPROBE 才把它们归一到规范动作 [S2][S13][S25]。
8. **方向决定推还是拉**【事实】：AgentBaton（跨厂商）[S18] 与 Handoff Tax、New Model Old Habits（同族，R2）同向：弱→强时少推、多拉或丢弃轨迹；强→弱时多推原文。
9. **一次性镜像，没有双向接力**【事实】：Codex 的同步要求前缀完全一致，分叉即停 [S27]；Warp 不能打开其他 Harness 跑过的对话 [S32]；Zed 只导入历史 [S30]。

**分歧与适用条件**【推断】：
- “原样移植”在同一模型、或语义等价的原生工具之间可行，例如 zen 的 shell→`Bash`、Harbor 的同 agent 原生加载。在不同脚手架之间，就要面对 DCAS 与 Interface Censoring 指出的格式风险。
- 宽松还是严格：zen 跳过未知记录类型，“先降低保真度，再坏掉”；Codex 同步遇到分叉就 fail closed。HH 的水位推进应取严格的一边，与 INV-14、INV-21 一致。

---

## 4. 对 HarnessHub 接力的启示

编号 R9-n。判定分为“采用 / 改造后采用 / 拒绝”，每条注明依据。凡未注明来源的数字都是【建议】，需要 HH-RelayBench 校准。

### 4.1 Q1 交接内容

**R9-1【采用，细化 R3 I-5 与 R1 D5】默认叙述化重述外来工具调用；原子事实逐字保留；绝不输出可调用的语法。**
- 机制：
  - 每条工具记录渲染成一行陈述，例如“Codex · Run 3 · 执行：`npm test` → 退出码 1”。命令、路径、退出码、错误摘录逐字保留，因为它们是事实。
  - 原生工具名只作归属注记，例如“（Codex `apply_patch`）”。
  - 不输出 JSON 形式的调用对象，不使用任何 Harness 的 tool_use 或 function_call 结构。
  - 记录行的标记语法固定，并转义 `[`、`<`，防止工具输出伪造标记（R1 D23）。
- 预算沿用 R1 D5：单条预览 ≤400 字符，全文走 ContentRef 拉取。Codex 导入器的 2,000/4,000 字符上限可作为“完整”档的参考上限。
- 依据：
  - 【事实】Codex 一手导入器与 zen 都扁平化，zen 写明了理由 [S26][S27]；
  - 【事实】原样搬运的一方没有行为证据 [S4][S25]；
  - 【事实】脚手架格式不匹配的崩坏 [S15][S20]；
  - 【推断】HH 的注入通道是提示内容而不是原生历史（R5 D8），在提示里“搬运结构”只能是 JSON 文本，既不原生、也不是叙述，两头都不占。

**R9-2【采用】在交接单开头加固定字节的来源前言。**
- 一句话写明：以下内容由谁、用哪个模型、在另一个程序中产生；它的工具与你不同；工具调用只是文字记录，不能调用；需要对照工作区核实。
- 前言的字节保持稳定，以保护缓存（R3 I-4）。
- 依据：
  - 【事实】zen 前言与 agent-session-bridge handshake 都是给模型看的前言；Codex 只用标签名标明来源，界面标记模型看不到 [S26][S27][S29]。
  - 【事实】唯一的数字是 Handoff Tax 的 +1.2 个百分点（R7 2.7）。
  - 【推断】预期效果较小，但成本几乎为零。
- HH 的交接单另有给用户看的卡片（R1 D27、R7），两种告知分开写，不能用其中一种代替另一种。

**R9-3【改造后采用】账本记录规范动作类别和效果标签。**
- 动作类别取 9 类：read、write、search、execute、plan、spawn、fetch、navigate、reason。由 `PublicTool.kind`（ACP ToolKind）或驱动给出的 kind 确定性映射；映射不了的记为 other，并保留原名。
- 交接时确定性地计算每条写入的效果，取值为 survived、reverted、failed、unknown：把该 Run 的 diff 块与交接时的工作区 diff 比对，方法是对新增行块做内容哈希，借用 Agent Trace 的 `content_hash` 思路。
- 交接单只渲染“仍然存在、已被回退、执行失败、未知”这几种结论。
- 依据：【事实】TRACEPROBE 已对三家完成这种确定性归一，并且有效果标签 [S13]；【事实】各家趋同的正是能力类别 [S14]。
- 改造之处：不使用 TRACEPROBE 里由 LLM 给出的语义标签；“off-anchor”依赖标准答案补丁，不适用。

**R9-4【改造后采用】“改动与归属”只到文件级。**
- 每个文件一行：谁（Harness 与模型）、在哪一轮、+/− 行数、交接时是否仍然存在。行级归属与 diff 原文走 L2。
- 账本中 `file_change` 条目的字段：`{path, runId, harnessId, model, hunks[{oldStart, oldLines, newStart, newLines, addedHash}], effectAtHandoff}`。其中 `model` 用 `observed.model`，并按 models.dev 约定写成“提供方/模型”。
- 依据：
  - 【推断】Agent Trace 的行级归属依赖 revision，也表达不了删除，不适合放进提示 [S23]；
  - 【事实】Factory 与 Handoff Debt 显示，改动追踪正是模型摘要最弱、最需要确定性生成的部分（R1、R2）。

**R9-5【改造后采用】给出文件登记表，不携带旧的读取内容。**
- 机制：
  - 交接单列出接手方需要关注的文件：路径、最后一次由谁读、最后一次由谁写、交接时的内容指纹。
  - 对返回的执行者，加一条“这些文件在你上次看过之后被 B 改过，你记忆中的内容已经过时”。
  - 来源方读过的文件内容一律不随交接单推送。
- 依据：【事实】CORVUS 指出读取结果会过时、引起重复读取，同步登记使输入 token 降低 9–50% [S16]；与 R3 I-5 的“写明你没有看过什么”一致。

**R9-6【采用】把计划快照作为一等交接内容，并标明作者；默认值随方向变化。**
- 渲染最新一次 `PublicRun.plan`：各条目与状态，写成陈述句，注明来自哪个 Run、哪个 Harness 和模型。不加祈使语气的“下一步”（R1 D3）。
- 来源方模型被判为较弱时，加注“该计划出自前一位执行者，请重新评估”。
- 依据：
  - 【事实】DCAS：由更强的模型提供显式计划，执行模型 +15 个百分点（42.8→57.8）；自己写计划 +5.4 [S15]；
  - 【事实】Old Habits 与 Handoff Tax 显示弱方的产物会把强方带偏（R2）。
- “强”与“弱”怎样判定未定（R2 第 6 节第 2 条），默认按用户的选择与模型档位粗分，由 HH-RelayBench 校准。

**R9-7【改造后采用】原始轨迹改为“交接日志”按需拉取，并提示先读末尾。**
- 机制：
  - 每个 Run 一条 JSONL 记录：`{runSeq, harnessId, model, status, input（≤4k 字符）, replyTail（≤2k）, tools[{kind, target, status, exitCode}], files[{path, ±, effect}], refs[]}`。
  - 作为派生物存入内容存储；经 relay MCP 读取（R5 D5），不支持时退化为 Hub 自有目录中的只读文件路径。
  - 交接单写明“记录按时间顺序，先看最后几条”。
- 默认推送量随方向变化：
  - 弱→强：L1 原文尾部收紧到 ≤2k token，其余靠拉取；
  - 强→弱：L1 放宽到 ≤6k token（取 R3 I-1 的 L2 上限）。
- 依据：【事实】AgentBaton 中弱→强的 LF 普遍胜过 IC，且更便宜；强→弱时 IC 往往更好 [S18]。日志记录的格式也参照它的设计。

**R9-8【改造后采用】继承改动的措辞。**
- 写明“以下改动未经验证，可能正确、不完整或方向错误；动手前先复现问题，或先运行最近的验证命令”。
- 来源 Run 为 cancelled、failed 或 unknown 时，加注“可能存在半截编辑”。
- 不采用“可开关的覆盖层”：HH 不能回滚用户工作区。
- 同时控制指令强度：只写核实要求，不写解题指导。
- 依据：【事实】Fail-Fast 的任务说明；在未完成编辑处切断会提高误杀（18.8% 对 8.8%）；提示干预对强模型起反作用（66.6→63.4）[S17]。

**R9-9【拒绝】把 ATIF 或任何结构化轨迹 JSON 原样推送给接手方；为接手方伪造原生工具调用结构。**
- 依据：
  - 【事实】结构化格式没有解读说明就没有增益，只用图甚至 −14.6 个百分点 [S19]；
  - 【事实】格式不匹配会静默改变行为 [S15][S20]；
  - 【推断】原始 JSON 式的调用面更容易诱发捏造的工具调用 [S21]；
  - 结构化事实只经由 R9-1 的叙述渲染，加上固定的解读说明（R3 I-1 的 L0）进入提示。

### 4.2 Q5 质量与确认

**R9-10【改造后采用】以 Harbor 作为 HH-RelayBench 的离线执行框架。**
- 用途：校准交接内容策略（视图、上限、方向默认值）。
- 不用于：HH 的注入通道、水位、斜杠命令回合、macOS 进程与清理的验收。这些仍走正式 Gateway 入口的真机配方（R6 4.6 第 6 条，以及以后的 HH 端到端测试）。
- 依据：见 2.2【事实】与【推断】。

**R9-11【采用】把 R2-22 的 V5 拆成两格，另加“交接日志”视图。**
- V5a：原样移植，即 Harbor 的 ATIF→原生转录，接收方只能是 Claude Code、Codex。
- V5b：Codex 导入器式的扁平化全文，所有接收方。
- V6：只给 AgentBaton 式的交接日志，不推 L1。
- V5a 与 V5b 的对比直接回答“叙述化还是原样搬运”。

**R9-12【采用】过程指标基于规范化动作计算，不用原生工具名。**
- 指标：
  - TRACEPROBE 的 Search Loop 与 Re-read Churn 定义 [S13]；
  - 接手方前 10 个动作中，重读来源方已读文件、重跑来源方已成功执行命令的次数；
  - 不可重复动作的重做次数，参照 HSC-Bench（R2）。
- 依据：【事实】Harbor `rewardkit` 按原生 `function_name` 计数，不能跨家比较 [S7]。

**R9-13【拒绝】把“能恢复、能复述哨兵、加载成功”当作接力质量的证据；拒绝把单个 Harness 的结果外推到其他 Harness。**
- 依据：【事实】迁移工具的验证止于此 [S25][S29][S9]；【事实】DCAS 指出单脚手架评测是方法上的混杂，TRACEPROBE 显示同一模型在不同脚手架下行为差异很大 [S13][S15]。
- 结果按接收方分别报告，再合并。
- 接棒确认维持 R1 D16，用确定性回执，因为本轮没有发现任何语义复述的证据。

#### HH-RelayBench v0 最小配方（只写不跑，对照 R2-22 与 R6 4.6）

**目的**：
- 回答四个问题：V5a 对 V5b（叙述化还是移植）；V4/V6 对 V3（拉取有没有价值）；方向对推送量的影响；返回 A 时“原生恢复 + 增量”对“新开 + 交接单”。
- 给出 L0/L1 上限与方向默认值的初值。
- 不验证 HH 的注入通道与水位。

**设施**：
- Harbor 固定在 v0.25.0 或某个固定 commit；在本机 Docker 或 Apple Container 上跑，也可以用云沙箱。
- Harness 版本对齐 HH 的基线（R1 与 R5）：Claude Code 2.1.316、Codex 0.166.0、OpenCode 2.2.5、dsh 0.2.1-rc.5、Hermes v0.22.5、OpenClaw 2026.10.9。
- dsh 需新写 Harbor 适配。
- 凭据：使用独立的、设了消费上限的 API key；不上传 `~/.codex/auth.json`，也不使用用户的订阅令牌（INV-17）。

**任务**（全部来自公开仓库，不使用用户对话）：

| 组 | 数量 | 构造 | 隐藏判定 |
|---|---|---|---|
| T-A 三步编码 | 24 | 从 Harbor 注册表的 `swebench-verified`（500 题）或 `swebenchpro`（731 题）选题，按 Run 边界拆成三步：S1 定位并复现；S2 修复；S3 用户改口后加固（S3 的消息取代 S1 或 S2 中的某个决定） | S1：存在一个因正确原因失败的测试，或诊断里点名了正确的函数；S2：FAIL_TO_PASS 与 PASS_TO_PASS；S3：用的是新值，且没有回归 |
| T-B 陷阱 | 12 | 参照 HSC-Bench 与 DreamBench-SWE：不可重复的动作（迁移只能执行一次）；被取代的值；历史中的批准（之前允许删除 X，当前消息没有授权）；步与步之间的外部改动（用 `workdir/setup.sh` 模拟用户改文件） | 计数等于 1；用的是新值；X 仍然存在；接手方注意到了外部改动并保留了它 |

- 筛题：先用 V5b 和 V0 各跑一次便宜的接收方，只保留通过率在 30–70% 之间的题，避开天花板和地板。

**交接点**：只在 Run 边界，即步与步之间，与 R1 D19 一致。
- H1（主实验）：S1 之后，A→B。
- H2（子实验）：S2 之后返回 A。前置路径统一为“B 在 V3 下完成 S2”，避免组合爆炸。

**两段 trial**：
1. 源 trial：A 跑完 S1 后，用 `artifacts` 收集 `/app`（排除依赖目录）、ATIF 轨迹和原生会话，并记录 `git status --porcelain` 与 diff。
2. 派生任务：Dockerfile 用 `COPY` 放入快照；instruction 为下一步的用户原话加上对应视图的材料；测试为下一步的隐藏测试（独立验证环境）。
3. 接手 trial：`-a <B>`；V5a 另加 `--load-trajectory`。
- 已知坑：
  - Claude Code 种入要求 WORKDIR 为 `/app`（#3560），SWE-bench 镜像要重建，或等该修复合入；
  - x86_64 镜像在 Apple silicon 上要仿真，可能显著变慢【推断】；
  - dsh 的“原生续接”上限组，要求新写的适配器支持 resume；做不到时，用 V5b 近似上限，并在报告中注明。

**视图**（V0–V4 与 R2-22 相同；V1–V4 用 HH 的真实渲染代码，从“ATIF→公共事实”转换后的会话生成）：

| 视图 | 内容 | 注入方式 |
|---|---|---|
| V0 | 只有工作区和当前用户消息 | instruction |
| V1 | 现行的 `buildPublicContext` JSON | instruction |
| V2 | L0（≤4k token） | instruction |
| V3 | L0 + L1（标准档 ≤8k，见 R6） | instruction |
| V4 | V3 + L2 拉取 | 任务级 `[[environment.mcp_servers]]` 起一个 stdio relay MCP，数据放在 `/relay/`，不在 `/app` 中；不支持的接收方退化为文件路径 |
| V5a | 原样移植的完整轨迹 | `--load-trajectory`（只有 Claude Code、Codex） |
| V5b | 扁平化的完整轨迹（Codex 导入器式） | instruction |
| V6 | 交接日志（R9-7），没有 L1 | 文件，或 relay MCP |
| H2 专用 | R-native（Claude/Codex 加载 A 的原生会话 + 增量交接单）；R-fresh（新会话 + 完整交接单）；V0 | 加载 + instruction |

**来源与接收方**：
- 来源 A：强 = Claude Code + Sonnet 5.5；弱 = dsh + deepseek-flash。
- 接收方 B：Claude Code + Haiku 5.5、dsh + deepseek-flash、Codex + gpt-6.1-sol。同 Harness 同模型的格改为“原生续接”上限组。OpenCode、Hermes、OpenClaw 放到 v0.1。
- 价格与 R6 第 4.6 节第 6 条选的便宜组合一致，两份数字可以互相对照。

**指标**：
- 结果：每步隐藏测试是否通过（主指标）；多个命名奖励时，均分与全过率同时报告（R2-22）。
- 行为（二元，按规则判定）：不重做不可重复的动作；不使用被取代的值；不把历史中的批准当作授权；注意到外部改动；宣布完成时有验证命令（TRACEPROBE 的无证据完成）。
- 过程（ATIF 加规范化动作）：
  - 接手方的动作数、prompt token（含缓存部分）、`cost_usd`、墙钟时间；
  - R9-12 的重读与重跑次数、Search Loop、到第一次写入的步数；
  - V4 和 V6 的拉取率与拉取次数；
  - 注入 token：派发前的估算值，对照第一次请求 `prompt_tokens` 的增量。
- 不用 LLM judge 判定结果；叙述类维度如需 judge，须与人工抽样校准，κ ≥ 0.7（R2-22）。

**统计**：
- 以交接实例为单位配对。二元结果用 McNemar 检验，过程指标用 Wilcoxon 符号秩检验。
- 预注册五组对比：V3 对 V1、V4 对 V3、V5b 对 V5a、V3 对 V0、R-native 对 R-fresh。用 Holm 校正。
- 按接收方分别报告。

**样本量**【推断】：配对二元结果、不一致率约 25–35%、α=0.05、功效 0.8 时，所需配对数大约为：

| 想检出的差值 | 配对数 |
|---|---|
| 20 个百分点 | 66 |
| 15 个百分点 | 100 |
| 10 个百分点 | 200 |

Holm 校正后约再多 40%。两档规模：

| 档位 | 规模 | 能检出的差值 |
|---|---|---|
| pilot | 12 题 × 2 个来源 × 2 个接收方（Claude Haiku、dsh flash）× 6–7 个视图 ≈ 312 次接手 + 24 次源运行 | 只能看出 ≥25 个百分点的差；用于跑通管线、估计方差 |
| v0 | 36 题 × 2 个来源 = 72 个交接实例；× 3 个接收方 × 6–7 个视图 ≈ 1,440 次接手；另有约 72 次源运行、72 次上限组、60 次 H2 | 单个接收方 72 对，约 20 个百分点；合并 216 对，约 10–12 个百分点。过程指标效应大（Handoff Debt 中事件数降低 20–59%），更早就能看出 |

**预算**【推断，按 R6 2026-11-02 的价格表】：
- 假设：每步 20–40 次模型调用，平均提示 20–40k token，缓存命中 85%，输出 10–20k token。

| 角色与模型 | 每次运行 |
|---|---|
| Claude Code + Haiku 5.5 | $0.02–0.05 |
| dsh + deepseek-flash（高峰价；闲时减半） | $0.03–0.10 |
| Codex + gpt-6.1-sol | $0.3–0.9 |
| 来源 Sonnet 5.5 | 每步 $0.3–0.9 |

- 合计：
  - pilot：约 $15–45；
  - v0：约 $250–800，其中 Codex 接收方约占 2/3 到 3/4；去掉 Codex 的 V0、V2 两格，可省约 30%。
- 墙钟：v0 约 1,650 次运行 × 5–15 分钟。本机并发 6 个约需 1–3 天；云沙箱并发 50 个约需 3–8 小时。
- 筛题另需约 120 次便宜运行，约 $6。

**与 HH 真机的衔接**【建议】：
- 另取 12 个源会话，在 macOS 上经真实的 HH 跑完，导出公共事实与工作区，再交给 Harbor 跑接手方。
- 比较“由 HH 真实事实渲染的 V3”与“由 ATIF 转换后渲染的 V3”，给转换误差一个上界。

### 4.3 Q11 存储与契约

**R9-14【改造后采用】ATIF v1.7 只读导出器：派生、可重建、不进业务库。**
- 映射见 2.6：
  - 每个连续的原生绑定区间成为一个 Trajectory 文档，用 `continued_trajectory_ref` 串起来；
  - 引用历史标 `is_copied_context`；
  - 压缩写成 `boundary:"opaque"`；
  - 无法表达的字段放进 `extra`，并在 `notes` 中写明策略版本。
- 不导出 v1.8：Phoenix 只读到 v1.7 [S11]。
- 用途：HH-RelayBench 的分析（Harbor 查看器、Phoenix、TRACEPROBE 式归一），以及调试导出。
- 导出物按 INV-22 标为派生，并记录水位与指纹。

**R9-15【拒绝】用 ATIF 作账本或交接单的内部 schema。**
- 缺少取代关系与有效期、出处与核实状态、受众、水位、单条事实的指纹；工具名不规范化；`arguments` 必须是对象，HH 只有截断的字符串 [S2]。账本沿用 R2-32 与 R3 I-2 的实体。

**R9-16【改造后采用】`file_change` 账本条目吸收 Agent Trace 的两个概念。**
- 吸收：`contributor{type, model_id}`（models.dev 约定）与按新增块计算的 `content_hash`（见 R9-3、R9-4）。
- 不实现它的存储与 blame 流程，也不承诺与 Agent Trace 兼容：规范是 v0.1.0 RFC，仓库在阅读时不可访问 [S23]。
- 以后在用户提交时导出 Agent Trace 记录（届时有 revision 可依附），属于 Q10 的事，不进入接力 v1。

**R9-17【采用】省略账目只记计数和类别，不记内容。**
- 交接单的 `omitted[]` 写成 `{category, count, earliestSeq, latestSeq, howToFetch}`，类别取 runs、tools、bytes、attachments、thinking、subagent 等。
- 同时展示给用户和模型，满足“超限不静默截断”。
- 依据：【事实】session-migrate 的无内容清单与 agent-session-bridge 的报告 [S25][S29]。

**R9-18【采用，补充 R1 D13/D14】返回 A 时做内容寻址的前缀检查，分叉即降级。**
- 绑定上除 `deliveredThroughSeq` 外，再记录“已送达材料的指纹链”。
- 返回 A 前，如果原生会话可以读出历史，就核对它是否仍以“已送达的材料”为前缀。发现分叉——用户在原程序里继续过对话，或原生压缩改写了历史——就不再假设 A 记得之前送达的内容，降级为“新开 + 交接单”，或提示用户。
- 读不出历史时，如实标为“未核实”。
- 依据：【事实】Codex 同步只在前缀完全一致时追加后缀，否则 fail closed [S27]；与 INV-14、INV-21 一致。

**R9-19【拒绝，补充 R5 D8 与 R1 D30 的证据】为交接写入目标 Harness 的私有会话存储，包括调用 Codex 的 `externalAgentConfig/import`。**
- 依据：
  - 【事实】该接口只导入 Claude Code 与 Cursor 的原生会话文件，只查家目录，限 30 天与 50 个，写入 `~/.codex` [S27]，而 HH 的来源是跨多家的公共 Session；
  - 【事实】格式很脆弱：缺少 `model` 字段即挂起；超过 5 MiB 只读最后一个压缩边界之后；WORKDIR 不对即找不到会话；MCP 命名空间丢失 [S8][S26]；
  - 【事实】session-migrate 不脱敏 [S25]。
- 【推断】这些工具与接口应列入 Q10 的观察清单：如果厂商以后开放“从外部来源种入会话”的正式接口，再重新评估。

### 4.4 顺带：Q3 与 Q7

- 【建议】Q7：
  - 外来工具记录中的命令和输出摘录，进入交接单之前要按 INV-17 脱敏。迁移工具普遍不做这一步：session-migrate 明说不脱敏，Codex 导入器原样保留 command [S25][S27]。
  - 带标记的记录语法必须转义，防止工具输出伪造标记，例如 `[external_agent_tool_call:`。
- 【建议】Q3：交接日志（R9-7）只放在 Hub 自有的位置，通过 relay MCP 或只读路径提供，不写进用户工作区。理由与 R1 D11 和 MUL-6984 相同：没人读的文件只是又一份要同步的副本。

---

## 5. 风险与反模式

1. **原样搬运外来工具结构**：
   - 历史里出现目标没有的工具名，会让接收方困惑 [S26]；
   - 悬空的调用会被 API 拒绝 [S29]；
   - 格式与解析器不匹配会让行为静默消失 [S15][S20]；
   - Claude 的会话文件缺字段会挂起，超过 5 MiB 会被截读 [S26]。
2. **把“可加载”当作“接得住”**：迁移工具的验证都止于此 [S25][S29]，Harbor 的 ATIF 加载只测了 hello 回忆题 [S8][S9]。
3. **凭据泄露**：session-migrate 不脱敏 [S25]；Harbor 会把 `~/.codex/auth.json` 上传进容器 [S7]。评测必须使用独立的 API key。
4. **在编辑未完成处切换**：零碎的状态会毁掉本可成功的运行 [S17]。被取消或结果未知的 Run 必须标注“可能有半截编辑”。
5. **过强的提示指导**：对强模型反而有害（−3.2 个百分点）[S17]，与 R1 中 Hermes #65848 同类。交接单只写核实要求。
6. **结构化而没有解读说明**：毫无增益，只用图会下降 14.6 个百分点 [S19]。
7. **从开放权重模型或极简脚手架的证据外推到闭源 Harness**：DCAS、Fail-Fast、AgentBaton 都属于这种情况 [S15][S17][S18]。
8. **依赖不成熟的规范**：
   - Agent Trace 只到 v0.1.0，仓库 404 [S23]；
   - ATIF 的 v1.7 有破坏性变更，Phoenix 不支持 v1.8 [S2][S11]；
   - Harbor 的相关修复 #3560 仍未合并 [S8]。
9. **评测混杂**：
   - 单一脚手架得出的结论 [S15]；
   - 由 LLM 给出的语义标签不稳定 [S13]；
   - 接口审查让工具调用计数失真 [S20]。
   优先使用确定性判定。
10. **推送原始轨迹导致成本上升**：AgentBaton 中弱→强时 IC 的成本最高可达 LF 的约 2.5 倍，准确率反而更低 [S18]。

---

## 6. 未解决的问题

1. 在闭源前沿 Harness（Claude Code、Codex）之间，“扁平化文字”与“原样移植”的续做质量差多少？目前**没有任何**公开实验，只能靠 HH-RelayBench 的 V5a 对 V5b 回答。
2. dsh 的 ACP 事件能否支撑 Harbor 的 ATIF 生成？给 dsh 写 Harbor 适配的工作量多大？
3. “强”和“弱”怎样判定（R2 遗留）？AgentBaton 用的是事先的模型档位；HH 没有统一的能力表，只能先用模型档位加用户覆盖。
4. 交接日志用 relay MCP 拉取时，各 Harness 的模型会主动去读吗？AgentBaton 的接收方被明确要求读日志；HH 能否在不过度指导的前提下（见风险 5）达到同样的拉取率？
5. 用 Harbor 的 Linux 容器测出的内容策略，迁移到 HH 在 macOS 上的 ACP 资源块与 MCP 通道时会不会变？需要 4.2 末尾的真机子集来校准。
6. JetBrains 切换 agent、Antigravity 切换模型时，历史怎样处理，都没有一手文档。
7. Agent Trace 是否还在维护？Cursor 是否转向其他规范？需要下一轮复查仓库状态。
8. AgentBaton 没有设“只给工作区”的基线，日志与工作区各自贡献多少不清楚。HH-RelayBench 的 V0 对 V6 可以补上这一点。
9. ATIF 导出中 `boundary:"opaque"` 这类扩展值是否被 Phoenix 等消费方接受，未核实。

---

## 7. 来源清单

阅读日期：全部为 2026-11-02（简报日；实际访问持续到 11-03 凌晨，本机时间）。

核实方式：
- **源码**：经 `gh api` 读取仓库文件，或下载到 scratchpad 阅读；
- **原文**：用 WebFetch 打开页面；
- **PDF**：读 PDF 页面；
- **摘要页**：只打开了 arXiv 摘要页；
- **仅摘要**：只看到搜索摘要；
- **本机**：读取本仓库文件。

| 编号 | URL / 路径 | 标题 | 作者 / 机构 | 日期 / 版本 / commit | 核实方式 |
|---|---|---|---|---|---|
| S1 | https://github.com/harbor-framework/harbor | Harbor（README、发布记录） | Harbor Framework Team（Terminal-Bench） | main `00dc6a7003`（2026-11-02）；v0.25.0（2026-10-25）；Apache-2.0 | 源码 |
| S2 | https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md | RFC: Agent Trajectory Interchange Format (ATIF) | Boxuan Li（维护者）；v1.7 由 NVIDIA 的两位作者贡献 | v1.8：`74cc631201`（2026-08-26）；v1.7：`0533a59c41`（2026-04-27） | 源码（全文） |
| S3 | https://docs.harborframework.com/agents/atif | ATIF（Harbor 文档） | Harbor | 2026-11 读 | 原文 |
| S4 | https://github.com/harbor-framework/harbor/blob/main/docs-mintlify/jobs/loading-trajectories.mdx | Loading trajectories | Harbor | `5db5c7c447`（2026-10-03） | 源码 |
| S5 | `docs-mintlify/jobs/handoff.mdx`、`docs-mintlify/results/handoff.mdx`（同一仓库） | Handoff | Harbor | `5db5c7c447`（2026-10-03） | 源码 |
| S6 | `docs-mintlify/tasks/multi-step.mdx`、`docs-mintlify/tasks/configuration.mdx`（同一仓库） | Multi-step；Task configuration（artifacts、mcp_servers、verifier） | Harbor | `c65b9f6d92`（2026-10-30） | 源码 |
| S7 | `src/harbor/agents/capabilities.py`、`src/harbor/agents/installed/{base,claude_code,codex,opencode,hermes,openclaw,acp,acp_registry}.py`、`src/harbor/environments/*`、`packages/rewardkit/…/criteria/*`（同一仓库） | 适配器、能力、ATIF↔原生转换、环境 | Harbor | main `00dc6a7003` | 源码 |
| S8 | https://github.com/harbor-framework/harbor/pull/2628 ；/pull/3560 ；/issues/3558 ；/issues/2343 | 运行级 ATIF 加载；Claude 种入受 WORKDIR 限制；Codex MCP 命名空间丢失；决策事件提案 | Kobe Chen（kobe0938）等 | 2026-08-06 合入；2026-10-07 未合并；2026-10-07；2026-07-15 | 源码（GitHub API） |
| S9 | `examples/tasks/hello-load-atif-trajectory-run-level/`（同一仓库） | ATIF 加载示例（回忆题） | Harbor | main | 源码 |
| S10 | https://github.com/agentclientprotocol/registry | ACP Registry（agent 列表） | ACP | `6bca5e4d97`（2026-11-02） | 源码（目录列表） |
| S11 | https://www.arize.com/docs/phoenix/tracing/how-to-tracing/importing-and-exporting-traces/importing-atif-trajectories.md | Importing ATIF trajectories | Arize Phoenix | 页面无日期 | 原文 |
| S12 | https://docs.nvidia.com/nemo/relay/configure-plugins/observability/atif.md | Agent Trajectory Interchange Format（NeMo Relay） | NVIDIA | Latest v0.10.4 | 原文 |
| S13 | https://arxiv.org/abs/2607.06184 | What Resolve Rate Hides: Trajectory Structure Diagnostics for Coding Agents（TRACEPROBE） | Rui Shu, Chun Yong Chong, Xin Zhou 等 9 人 | v1 2026-07-07；数据 DOI 10.5281/zenodo.20789918 | 摘要页 + HTML |
| S14 | https://arxiv.org/abs/2604.03515 | Inside the Scaffold: A Source-Code Taxonomy of Coding Agent Architectures | Benjamin Rombaut | v2 2026-04-10 | 摘要页 + HTML（前半） |
| S15 | https://arxiv.org/abs/2608.06113 | DCAS: Decoupling CLI Agent Scaffolding to Internalize Planning across Scaffolds | Kishanthan Thangarajah, Boyuan Chen（Huawei Canada）；Ahmed E. Hassan（Queen's University） | v1 2026-08-06；ASE '26；DOI 10.1145/3832783.3834485 | 摘要页 + PDF 第 1–10 页 |
| S16 | https://arxiv.org/abs/2607.22711 | CORVUS: Context Optimization and Reduction Via Underlying Synchronization for LLM Coding Agents | Mingwei Zheng, Sachit Kuhar 等 7 人 | v1 2026-07-20 | 摘要页 |
| S17 | https://arxiv.org/abs/2608.03222 | Fail-Fast, Restart-Smart: Early Failure Prediction and Restart for SWE Agentic Tasks | Chenyu Wang, David Lo 等 7 人 | v1 2026-08-04 | 摘要页 + HTML |
| S18 | https://arxiv.org/html/2610.35959v1 | AgentBaton: Efficient Model Collaboration in Agentic Tasks | Junlong Li（HKUST）、Pavlo Molchanov 等（NVIDIA）、Jiarui Yao（UIUC） | v1 2026-10-25 | HTML（摘要页抓取失败） |
| S19 | https://arxiv.org/abs/2608.25277 | Routed Graph Handoff: Adaptive Format Selection for Multi-Agent LLM Delegation | Pratyay Banerjee, Ankit Chadha | v1 2026-08-26；EMNLP 2026 | 摘要页 |
| S20 | https://arxiv.org/abs/2609.03966 | Interface-Induced Trajectory Censoring | Wenbo Wang, Di Sang | v3 2026-10-22 | 摘要页 |
| S21 | https://arxiv.org/abs/2609.19425 | Closed-World Resolution Against Tool Hallucination in LLM Agents | Laxmipriya Ganesh Iyer | v1 2026-09-16 | 摘要页 |
| S22 | https://arxiv.org/abs/2609.04148 | Terminal-Universe: Turning Agent Trajectories into Scalable Terminal Environments | Jie Wu, Dayiheng Liu 等 | v1 2026-09-03 | 摘要页 |
| S23 | https://agent-trace.dev/ （仓库 https://github.com/cursor/agent-trace 阅读时 404） | Agent Trace Specification | Cursor 及页面列出的参与方 | v0.1.0 RFC，2026-01；CC BY 4.0 | 原文（规范页）；仓库不可访问 |
| S24 | https://github.com/specstoryai/getspecstory/blob/main/specstory-cli/docs/git-provenance/standards/agent-trace.md | Agent Trace Standard Research | SpecStory | 2026-02-18 | 源码（二手） |
| S25 | https://github.com/xhluca/session-migrate （README、`docs/format-compatibility.md`、`docs/native-corpus-validation.md`、`docs/validation-report.md`） | session-migrate | Xing Han Lu（xhluca，McGill NLP） | 0.12.0，`45351ff95c`（2026-10-19）；MIT | 源码 |
| S26 | https://github.com/mgreau/zen （README、`docs/session-migration.md`） | zen：Claude 与 Codex 之间的会话迁移 | Maxime Gréau（mgreau） | main `6f03e822eb`（2026-10-07）；迁移文档 `39fd6e2b1a`（2026-08-18）；MIT | 源码 |
| S27 | https://github.com/openai/codex/tree/main/codex-rs/external-agent-migration （`src/sessions/{records_common,export,append,ledger,mod,records_cla}.rs`、`src/model.rs`）；`codex-rs/app-server-protocol/src/protocol/common.rs` | Codex 外部 agent 会话导入 | OpenAI | main `8806313db4`（2026-11-02） | 源码 |
| S28 | https://github.com/openai/codex/releases/tag/rust-v0.145.0 ；提交 #55365、#56414 | Codex v0.145.0 发布说明；导入相关提交 | OpenAI | 2026-07-21；2026-10-19；2026-10-23 | 源码（GitHub API） |
| S29 | https://pypi.org/project/agent-session-bridge/ （仓库 https://github.com/connectwithprakash/agent-session-bridge） | agent-session-bridge | Prakash Chaudhary | 0.5.0（2026-08-03） | PyPI JSON 中的项目说明 |
| S30 | https://zed.dev/docs/ai/external-agents.html ；https://zed.dev/docs/ai/agent-panel | External Agents；Agent Panel | Zed Industries | 页面无日期 | 原文 |
| S31 | https://www.jetbrains.com/help/ai-assistant/acp.html ；https://www.jetbrains.com.cn/en-us/help/ai-assistant/activate-agents.html | ACP agents；Activate agents | JetBrains | AI Assistant 2026.2，2026-10-07 更新 | 原文 |
| S32 | https://docs.warp.dev/agents/cli/cloud-and-orchestration/ | Cloud and orchestration（`/handoff`） | Warp | 2026-10-29 更新 | 原文 |
| S33 | https://antigravity.google/docs/models?app=cli ；https://discuss.ai.google.dev/t/in-antigravity-when-ever-is-select-the-claude-model-to-work-i-get-server-issues/178094 | Choose a model；论坛员工回复 | Google | 页面无日期 | 文档为原文；论坛仅摘要 |
| S34 | `src/contracts/session.ts`（`PublicRun`，第 92 行起）、`src/contracts/content.ts`（`ContentRef`）、`src/contracts/control.ts`（`NativeToolDetail`、`NativeUsage`） | HarnessHub 公共事实契约 | HarnessHub | 分支 `cc/relay-design` | 本机 |
