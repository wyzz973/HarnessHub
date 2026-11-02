# R5 · 原生通道：七个焦点 Harness 交付交接材料的可用通道（第 1 轮调研）

调研员 R5（Claude Opus 5.5 子代理）。阅读日期 2026-11-02。分支 `cc/relay-design`（基点 `07a0825`）。本文是调研结论，不是已接受决定；“支持”指原接口或源码支持，不等于 HarnessHub 真实通过。

## 1. 范围与方法

### 1.1 对象（版本只作证据，ADR-053）

| Harness | 本机安装（2026-11-02 只读核对） | 控制入口 |
|---|---|---|
| Claude Code | CLI 2.1.316（nvm，`claude.exe` 今日更新）+ `@agentclientprotocol/claude-agent-acp` 0.99.1（Homebrew 前缀，内含 ACP SDK 2.1.0、claude-agent-sdk 0.3.312） | ACP |
| Codex | 0.166.0（Homebrew cask，Rust 二进制） | app-server JSON-RPC |
| OpenCode | 2.2.5（homebrew/core，Bun 单文件二进制；源码 anomalyco/opencode `v2.2.5`） | `opencode acp` |
| DeepSeek Harness | `@deepseek-ai/dsh` 0.2.1-rc.5（nvm 全局，JS） | `dsh --profile acp` |
| Hermes Agent | v0.22.5（`~/.hermes/hermes-agent` @ `bf0203a794`，Python） | `hermes acp`（网关查看器） |
| OpenClaw | 2026.10.9（npm 全局，JS；升级后 Gateway 未就绪） | `openclaw acp` 桥 + `gateway call` |
| WorkBuddy | `/Applications/WorkBuddy.app` 5.9.3，内嵌 CodeBuddy CLI `@genie/agent-cli` 2.165.0（ADR-048 记录时为 5.3.14 / 2.115.0） | 未接入 |

### 1.2 方法与来源类型

- **本机安装包源码（只读）**：claude-agent-acp `dist/*.js`、dsh 包内 README 与 `lib/index.js`、Hermes `acp_adapter/`、`gateway/`、`hermes_cli/`、OpenClaw `dist/` 与随包 `docs/`、WorkBuddy 内嵌 CLI bundle。Claude Code 与 Codex 是原生二进制，只做 `strings`。
- **协议生成（不建会话）**：`codex app-server generate-json-schema --out …/r5/codex-schema`、加 `--experimental` 到 `…/r5/codex-schema-exp`、`generate-ts --out …/r5/codex-ts`（目录前缀 `/private/tmp/claude-501/-Users-sd3-Desktop-project-HarnessHub/ad0e280f-cff4-4061-938f-4e375d14fd26/scratchpad/relay/r5/`）。
- **固定 tag 的上游源码**：openai/codex `rust-v0.166.0`（raw.githubusercontent，经网页读取工具摘要）；anomalyco/opencode `v2.2.5`（curl 下载到同一 scratch 目录的 `src-opencode-acp/`、`src-opencode-core/`，并用已装二进制中的同名字符串核对一致）。
- **官方文档**：code.claude.com、platform.claude.com、learn.chatgpt.com（Codex，developers.openai.com 已 308 跳转至此）、developers.openai.com、opencode.ai/v2、api-docs.deepseek.com、agentclientprotocol.com、workbuddy.ai。
- **仓库**：`src/adapters/control/*`、`src/infrastructure/control/attachments.ts`、`docs/verification/*`（已有真机证据）。

只运行了 `codex --version`、`codex app-server … --help` 与上述两个生成子命令、`dsh --help`；没有启动任何 Harness 会话或提示，没有改用户配置，没有碰 4317 与 `data/`。WorkBuddy 内嵌 CLI 一次也没运行（ADR-048：不带环境变量直接启动会新建 `~/.codebuddy`）。

### 1.3 局限

- 本文提出的新通道（ACP `systemPrompt`、`mcpServers`、`additionalDirectories`、Codex `thread/inject_items`、OpenCode synthetic）**都没有真机验证**；第 6 节给出核实清单。
- Codex 的 `inject.rs`、`session/mod.rs`、`compact.rs`、`thread_processor.rs` 经网页读取工具摘要转述，关键结论已用生成的 schema、二进制字符串与官方 app-server 文档交叉核对，仍标“源码（摘要）”。
- OpenClaw 2026.10.9 的 Gateway 升级后未就绪，桥行为只读源码与随包文档。二手来源（博客、搜索摘要）只作线索，在来源表中注明。

标注：**【事实】** 打开原文或源码可复核；**【推断】** 由事实推出、未直接验证；**【建议】** 给设计的意见。来源编号见第 7 节。

## 2. 发现

### 2.0 协议层（ACP v1）与 HarnessHub 现状

- 【事实】ACP v1 稳定面：`session/new` 的 `mcpServers`（必填）与 `additionalDirectories`（RFD 2026-06-01 Completed）；稳定 `sessionCapabilities` 键为 list、delete、additionalDirectories、resume、close；`promptCapabilities` 的基线是 `text` 与 `resource_link`，`resource` 需 `embeddedContext`；stdio MCP 所有 Agent 必须支持，`http`/`sse` 默认 false [S4][S6]。
- 【事实】unstable 面：`systemPrompt`（append 是基线，override 需子能力；new/load/resume/fork 都可带）、`session/fork`、`McpServerAcp`（经 `mcp/message` 把 MCP 跑在 ACP 通道上）、`providers/*`、会话间 `session_message` [S4]。client-system-prompt RFD 于 2026-10-30 进入 Preview：load/resume 带了不同提示，Agent SHOULD 应用，也 MAY 推迟到下次重建（例如压缩后）；Agent 不必持久化；客户端 SHOULD 每次送同一份 [S5]。
- 【事实】ACP 没有客户端发给 Agent 的压缩、历史导入或无回合注入方法；压缩只有 Agent 发出的 `compaction_update`，前提是客户端声明 `session.compaction` [S4][S6]。
- 【事实】ACP TS SDK 2.1.0 单条入站消息默认上限 32 MiB（`DEFAULT_MAX_MESSAGE_BYTES`），超限抛 `MessageTooLargeError`；OpenCode 2 在该错误时退出进程 [S4][S32]。
- 【事实·HarnessHub】`AcpControl` 在 new/load/resume/fork 一律发 `mcpServers: []`，不发 `systemPrompt`、`additionalDirectories`（`acp.ts:351、389–390`）；Claude 只带 `_meta.claudeCode.options.promptSuggestions=false`（`claude.ts:20`）；OpenClaw 只带会话键类 `_meta`（`openclaw.ts:215–229`）。文本附件不超过 256 KiB 且 Agent 声明 `embeddedContext` 时作为 `resource` 发送，否则作为 `resource_link`；Hermes 改为文本指针（`acp.ts:38、376–384、528–530`；`hermes.ts:101`；`attachments.ts:31–35`）。`usage_update` 只在有活动提示时转成事件，建会话或恢复时 Agent 先报的窗口被丢弃（`acp.ts:634–636`）[S2]。
- 【事实·HarnessHub】Codex 驱动的 thread/start 与 thread/resume 只带 cwd、ephemeral 或 excludeTurns、model 和 approvalPolicy/sandbox 覆盖（`codex.ts:350–352`）；turn/start 只带 input、effort、collaborationMode（`developer_instructions: null`，`codex.ts:514–516`）；只有选了协作模式的连接才声明 `experimentalApi`（`codex.ts:233`）[S2]。

### 2.1 Claude Code 2.1.316 + claude-agent-acp 0.99.1

initialize 回报（`acp-agent.js:1405–1450`）：`promptCapabilities {image, embeddedContext}`；`mcpCapabilities {http, sse}`（没有 acp）；`sessionCapabilities {additionalDirectories, close, delete, fork, list, resume, systemPrompt: {mode: {override: {}}}}`；`loadSession`；`_meta.claudeCode.promptQueueing` [S7]。

1. **用户消息**。【事实】适配器没有长度上限，只受 SDK 32 MiB 单条上限与模型窗口约束。正文作为 user message 写入 `~/.claude/projects/<项目>/<会话>.jsonl`，压缩时与其余会话层一起被摘要 [S7][S14]。
2. **系统说明**。【事实】ACP unstable `systemPrompt`：append 映射为 SDK 的 `{type:"preset", preset:"claude_code", append}`，override 映射为自定义字符串；只接受 text 块，否则 `invalid_params`，会话不建立；new、load、resume、fork 都校验（`acp-agent.js:1494、1552、8744、8821`；`client-system-prompt.js`）[S7][S8]。另有适配器扩展 `_meta.systemPrompt`：字符串表示替换，对象表示 preset 选项（可带 append、excludeDynamicSections），规范字段优先 [S7]。作用域只是这个 SDK 会话，不写 settings [S12]。
   【事实】Claude Code 在会话首个请求时“记录”系统提示，resume 时沿用这份记录直到下次压缩；中途改指令应写进下一条用户消息或 hook 的 additionalContext；`snapshot: false` 让每次请求重建提示，代价是丢失提示缓存 [S12][S16]。压缩后系统提示与输出风格仍然生效 [S14]。
3. **嵌入资源**。【事实】text resource 变成正文里的 Markdown 链接（`[@name]` 后接 `(uri)`），加上放在本条 user message **末尾**的 `<context ref="uri">全文</context>`；blob 中 png/jpeg/gif/webp 转 image 块，PDF 转 document 块，text 类 MIME 解码为文本，其余（如 zip）在 v1 跳过（`acp-agent.js:10316–10390`；`blob-resources.js`）[S7][S9]。能力矩阵中“blob 被丢弃”是旧版适配器的事实，0.99.1 已经不同。
4. **resource_link**。【事实】只变成 markdown 链接文本，适配器不读取文件 [S7]。
5. **按会话 MCP**。【事实】stdio（无 type）、http、sse 转成 SDK `mcpServers`，与 `_meta.claudeCode.options.mcpServers` 合并；`acp` 类型被忽略（`acp-agent.js:8868–8892、9063–9066`）[S7]。`...userProvidedOptions` 整体展开进 SDK options，所以 `allowedTools` 这类会话级选项可以经 `_meta.claudeCode.options` 传入（`acp-agent.js:9030–9052`）[S7]。
   【事实·文档】SDK 与 `--mcp-config` 提供的服务器不走 `.mcp.json` 的项目审批；`mcp__<server>__*` 形式的 allow 规则可放行整台服务器；工具元数据 `_meta["anthropic/requiresUserInteraction"]: true` 强制每次审批；`readOnlyHint` 让只读调用可并行 [S17][S11]。【推断】没有预先放行时，每次 MCP 调用都会走 canUseTool → `session/request_permission`，在 Hub 里表现为审批卡。
   输出上限【事实】：超过 10k tokens 警告，默认上限 25k（`MAX_MCP_OUTPUT_TOKENS`），超过 50,000 字符的成功文本结果存成文件 [S17]。缓存【事实】：工具搜索（支持的模型默认开启）延迟加载 MCP 工具时，会话中途连上或断开服务器不破坏已有缓存；否则新增工具定义会使缓存失效 [S16]。
6. **工作区外文件**。【事实·文档】只读工具在工作目录与 additional directories 内免审批；ACP `additionalDirectories`（及旧扩展 `_meta.additionalRoots`）合并进 SDK `additionalDirectories`，等同 `--add-dir`（`acp-agent.js:8963–8967、9228–9232`）[S7][S11]。
   【事实】`--add-dir` 的目录还会加载其中的 `.claude/skills/`（热重载）、`.claude/commands/`、`.claude/agents/` 以及 settings 里的 enabledPlugins 与 extraKnownMarketplaces；其中的 CLAUDE.md 只在设了 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 时加载 [S11]。`permissions.blockReadsOutsideWorkingDirectories` 会让工作目录外的读取一律被拒绝 [S10][S11]。【推断】Manual 模式下读工作目录外会弹出 “Allow this read outside the working directories?”（来自二进制字符串）[S10]。
7. **原生注入或导入**。【事实】ACP 与适配器都没有这类接口，`session/load` 只回放 [S7]。【推断】hook 的 additionalContext 只能在 SDK 进程内以回调返回，ACP 客户端用不上。【建议】手写 transcript JSONL 再 resume 等于伪造历史，拒绝。
8. **压缩**。【事实】`/compact [instructions]` 可带聚焦指令；`/rewind` 可以只摘要一段；自动压缩阈值随模型而定（Haiku 5.5 约 967K），可用环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 覆盖 [S13][S15]。适配器把它当原生命令执行并发 `compaction_update`（Hub 已声明 `session.compaction`，真机通过）[S7][S3]。
   压缩后会重新注入或保留的内容【事实】：系统提示保留；根目录 CLAUDE.md 与 auto memory 从磁盘重注入；技能描述重建；已调用技能的正文重注入（每个最多 5,000 tokens，合计 25,000）；最近改动的最多 5 个文件重读（超过 5,000 tokens 的只给路径）；hook 加入的上下文被摘要 [S14]。
9. **窗口**。【事实】`usage_update {used, size, cost}`，真机 size=1,000,000；Fable、Sonnet 5 及以后、Haiku 5.5、Opus 4.7 及以后默认 1M，`CLAUDE_CODE_DISABLE_1M_CONTEXT` 可关 [S3][S15]。ACP 读不到输出上限。

**缓存**。【事实】Claude Code 的 TTL：订阅且在额度内的主会话 1h，API key 或额度外 5m，环境变量 `CLAUDE_CODE_PROMPT_CACHE_TTL` 可改。分层顺序：系统提示（含工具定义）→ 项目上下文（CLAUDE.md 等）→ 会话；系统提示一变，全部失效；技能调用与计划模式以消息追加，缓存安全；实际作用域是“同一台机器、同一目录” [S16]。
API 层【事实】：写入 1.25×（5m）或 2×（1h），读取 0.1×，Opus 5.5 与 Sonnet 5.5 读取 0.05×，Fable 5.1 为 0.025×；新模型最小可缓存长度 512 tokens；最多 4 个断点，每个断点回看 20 个位置 [S18]。

### 2.2 Codex 0.166.0（app-server JSON-RPC）

1. **用户消息**。【事实】`MAX_USER_INPUT_TEXT_CHARS = 1 << 20`，即 1,048,576 字符，源码注释写的是 “Conservative cap so one user message cannot monopolize a large context window”；超限返回 `input_too_large {max_chars, actual_chars}` [S20][S21]。正文写入 rollout。
   压缩【事实】：保留最近的用户消息（从新到旧，合计不超过 20,000 tokens，`COMPACT_USER_MESSAGE_MAX_TOKENS`；超出的截断并标为不完整），其余进摘要；初始规范上下文压缩后重新注入（“Re-inject canonical context from the current session since we stripped it”）[S24]。
2. **开发者说明**。【事实】thread/start、thread/resume、thread/fork 都有 `baseInstructions`、`developerInstructions` 与 `config`（任意键，同 `-c` 覆盖）[S19][S22]。app-server 把它们放进该线程的 ConfigOverrides（`build_thread_config_overrides`），不写 config.toml；Hub 已在 approvalPolicy/sandbox 这条同类路径上真机核实过“不写 config.toml”[S25][S3]。
   【事实】已经在本进程加载的线程，resume 时带的 config、baseInstructions、developerInstructions 都被忽略，记作 “… was provided and ignored while running”[S25]。冷 resume 会把它们传入 overrides，但是否改写已持久的初始上下文**未核实**。【推断】developerInstructions 属于初始规范上下文，压缩后会重注入，比用户消息更耐压缩 [S24]。
   【事实】配置键 `developer_instructions`、`model_instructions_file`、`compact_prompt`、`model_context_window`、`model_auto_compact_token_limit`、`tool_output_token_limit` 都存在 [S27]。
3. **嵌入资源**。【事实】UserInput 只有 text、image（url/fileId）、localImage、audio、localAudio、skill、mention 七种，没有 resource [S19]。实验字段 turn/start `additionalContext` 的值是 `{kind: "untrusted"|"application", name?, value}`，源码注释说 name 用来“label its tool output”，需要 `experimentalApi`；是否持久化，源码没写 [S19][S22]。
4. **resource_link**。不适用。Hub 现在把文件路径写进文本，由 Codex 自己读（真机通过）[S3]。
5. **按线程 MCP**。【推断】thread/start 的 `config` 可以写 `mcp_servers.<id>.{command,args,env | url, enabled, required, startup_timeout_sec, tool_timeout_sec, enabled_tools, default_tools_approval_mode, tools.<t>.approval_mode}`；README 写明 MCP 连接按线程（“With threadId, the request reuses the thread's current MCP connection and tool catalog”）；未真机 [S26][S27]。
   【事实】实验字段 `dynamicTools`（function 或 namespace 规格）：模型调用时 app-server 向客户端发 `item/tool/call`；规格持久化在 rollout 元数据，resume 时恢复 [S19][S26]。稳定字段 turn/start `toolOutput`：用客户端工具的输出开一个回合（input 必须为空），结果作为 functionCallOutput 进历史，`retain` 请求保留 [S19][S26]。
   审批模式取值 auto/prompt/writes/approve，官方文档没有写各自含义；【二手】auto 不弹提示，writes 按 readOnlyHint 放行只读工具 [S27][S29]。
6. **工作区外文件**。【事实·真机】Codex 用 shell 读取工作区外的 Hub 只读副本并答出标记，没有请求审批（按当时的用户沙箱配置）[S3]。【二手】read-only 与 workspace-write 沙箱都允许全盘读，deny-read 规则可以拒绝 [S30]。【推断】实验字段 `runtimeWorkspaceRoots` 会把目录变成工作区根，在 workspace-write 下可写，不适合放只读材料。
7. **原生注入**。【事实】稳定方法 `thread/inject_items {threadId, items}`：把 Raw Responses API items 追加到已加载线程的模型可见历史，不开用户回合；写入 rollout，之后的模型请求可见 [S19][S22][S26]。
   【事实·源码（摘要）】没有活动回合时直接 `record_conversation_items`，注释是 “Appends to history, persists the prepared items, then notifies raw-item observers”；有活动回合时并入该回合的待处理输入；不校验 item 类型与角色，只在特性 `RetainClientDeveloperMessages` 打开时给 developer 消息加 client_authored 标记 [S23]。【推断】这个特性没开时，客户端注入的 developer 消息在压缩时如何处理不明。
8. **压缩**。【事实】`thread/compact/start {threadId}` 没有指令参数，立即返回 `{}`，进度以 contextCompaction item 报告（Hub 真机通过）[S19][S26][S3]。`compact_prompt` 可以覆盖压缩提示 [S24][S27]；【推断】它也能按线程经 `config` 设置。
9. **窗口**。【事实】`thread/tokenUsage/updated.tokenUsage.modelContextWindow`（int64，可空），resume 时也报历史总量；`model/list` 的 Model 没有窗口或输出上限字段 [S19][S2]。

**缓存**。【事实】OpenAI 自动前缀缓存：GPT-5.6 及以后，最小 1,024 tokens，断点在最新合格消息末尾；TTL 默认 30m，可设 12h（`prompt_cache_options.ttl`）；读取 0.1×（GPT-6.1 Sol/Terra 为 0.05×），写入 1.25×（30m）或 2.5×（12h）；换模型、工具、reasoning.effort，或发生压缩，都会降低复用 [S28]。【推断】这些请求参数由 Codex 自己决定，Hub 控制不了。

### 2.3 OpenCode 2.2.5（`opencode acp`）

initialize（`service.ts:121–127`；已装二进制含同一字符串 `mcpCapabilities:{http:!0,sse:!1}`）：`loadSession`；`mcpCapabilities {http: true, sse: false}`；`promptCapabilities {embeddedContext, image}`；`sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}`；没有 systemPrompt [S31]。2026-11-01 的验收记录写“MCP 能力 http、sse”，与源码和二进制的 `sse: false` 不一致，应按原始 initialize JSON 复核 [S3]。
`opencode acp` 自己起一个私有的 `opencode serve --stdio --port 0`：随机密码，租约管道随进程结束 [S32]。

1. **用户消息**。【事实】文本 part 写入会话（同一个 `opencode.db`）；ACP 入站消息超过 SDK 上限时进程退出 [S32]。压缩保留最近的尾部（默认 `keep` 15,000 tokens），摘要模板固定：需求、决定、未决问题、工作状态、下一步 [S33]。
2. **系统说明**。【事实】ACP 不读 systemPrompt，也不从 `_meta` 读提示 [S31]。指令（AGENTS.md、config 的 `instructions`）按会话记录基线，之后的变化作为带渲染文本的持久事件追加，不改历史前缀（`instruction-state.ts`）[S33]。【推断】可以用进程级环境变量 `OPENCODE_CONFIG_CONTENT`（ADR-053 列出的环境变量之一）注入 `instructions`，只作用于这个私有服务器，不写用户配置；V2 的键名未核实。
3. **嵌入资源**。【事实】text resource 变成文本 part `[路径(:行)]\n内容`；blob 变成 file part（data URL）。**text 块带 `annotations.audience: ["assistant"]` 时成为 `synthetic` 文本**，经 `session.synthetic({text, description: "ACP embedded context", delivery: "steer", resume: false})` 作为持久入站项提交，不唤醒执行；`audience: ["user"]` 标为 ignored（给人看，不给模型）（`content.ts:17–58`、`turn.ts:225–237`、`core/session/session.ts:286–323`）[S31][S33]。
4. **resource_link**。【事实】file:// 变成 file part；文件不可读时退为链接文本（`prompt.ts`）[S31]。
5. **按会话 MCP**。【事实】支持 stdio 与 http；sse 与 acp 返回 InvalidRequest：“Only stdio and HTTP MCP servers are supported”。服务器经 `client.experimental.mcp.add({server, location: {directory}, config})` 注册为私有服务器的内存覆盖（`overrides.set` 后 reload），不写配置；同名同配置不重复注册（`sessions.ts:93–113`、`core/mcp/index.ts:776–780`）[S31][S33]。
   【事实·文档】V2 基础策略是 `{action:"*", resource:"*", effect:"allow"}`，MCP 工具名 `<server>_<tool>` 落在这条之下；没有规则匹配时为 ask；多条规则匹配时最后一条生效 [S34]。
6. **工作区外文件**。【事实】V2 默认允许 external_directory [S34]；ACP `additionalDirectories` 变成会话级规则 `external_directory allow <dir>/*`，写在会话记录 permissions 的前部，所以用户自己的规则仍然优先（`directories.ts`）[S31]。【事实·真机（V1）】OpenCode 1 读工作区外副本时请求过外部目录审批 [S3]。
7. **原生注入或导入**。【事实】见第 3 条的 synthetic 持久入站项，不开回合 [S31][S33]。另有 `opencode session import <file|url>`，调用实验 API `/api/experimental/session/import`，把 OpenCode 自己的导出格式写进用户的 `opencode.db` [S33]。
8. **压缩**。【事实】内置 `/compact` 调用 `session.compact({sessionID, id})`，不带参数，也不带指令 [S31]。自动压缩配置是 `compaction.{auto（默认 true）, buffer（可写百分比）, keep.tokens}`，另有实验开关 `background_compaction` [S33]。V2 真机压缩后仍记得先前事实 [S3]。
9. **窗口**。【事实】`usage_update {used, size, cost}`（真机）；V2 的 `opencode models` 没有 `--verbose` [S3]。【推断】窗口来自 models.dev 的 `model.limit`；窗口未知时不触发自动压缩 [S33]。

**缓存**。【事实】压缩请求沿用正常请求的前缀以命中缓存；指令变化作为增量事件追加 [S33]。默认模型 opencode/big-pickle 背后厂商的缓存策略未核实。

### 2.4 DeepSeek Harness 0.2.1-rc.5（`dsh --profile acp`）

initialize（`dsh-acp/lib/index.js:1192–1201`）：`mcpCapabilities {http: true}`；`promptCapabilities {image（按路由）, audio: false, embeddedContext: false}`；`sessionCapabilities {close, list, resume}`。不支持 session/load、fork、`additionalDirectories`（非空即 invalidParams，`index.js:1454`）、modes、commands、elicitation [S35]。

1. **用户消息**。【事实】文本与图片保序合成一条 user message；README 写明 “Prompt content … remain in that session until compaction”；没有看到长度上限 [S35]。
2. **系统说明**。【事实】ACP 不提供。系统提示由 `dsh-system-prompt` 插件在每一步组装（personaPrefix、personaSuffix 等）；工作区指令是持久的 user message（`<system-reminder>`）[S35]。【推断】`dsh --profile acp --patch <overlay.yml>` 可以在进程级覆盖 personaSuffix，未核实，并且影响这个进程里的所有会话。
3. **嵌入资源**。【事实】`resource` 返回错误 “embedded resource prompt content is not supported”（`index.js:115`）[S35]。
4. **resource_link**。【事实】变成 `[resource_link name=… uri=…]` 文本，模型用自己的工具打开（`index.js:91`；真机通过）[S35][S3]。
5. **按会话 MCP**。【事实】session/new 与 session/resume 都接受 mcpServers：stdio 的 command 必须是绝对路径；http 要绝对 URL 加 headers；sse 与 acp 拒绝；README 称 “ACP clients are trusted controllers”，挂载失败就回滚；只消费 MCP 工具，资源与提示没有消费方（`index.js:225–257、1265`）[S35]。
   调用审批：rc.2 与 rc.5 真机中 bash 和 edit 都没有请求审批，ACP 也不回报生效的权限预设，MCP 调用是否需要审批**未核实** [S3]。
6. **工作区外文件**。【事实·真机】`resource_link` 指向的 Hub 副本被读取并答出 [S3]；工作区外读取的沙箱规则未核实。
7. **注入**。不支持 [S35]。
8. **压缩**。【事实】自动压缩在 `floor(min(W×0.8, W−O−65,536))` 触发，保留最新的 16% × (W−O)；上下文溢出后压缩再重试；`/compact` 由 `dsh-command-compact` 提供，但 ACP 面没有命令 [S35]。所以 Hub 无法经 ACP 触发压缩。
9. **窗口**。【事实】`usage_update` 带上下文占用与窗口（真机 1,000,000）；prompt 结果不带用量 [S3]。DeepSeek API 文档：deepseek-v4-pro 与 deepseek-flash 都是 1M 上下文，最大输出 384K [S37]。

**缓存**。【事实】README 说路由与组装好的前缀不变时 append-only 命中 KV cache，换模型就从新路由开始 [S35]。DeepSeek 磁盘缓存默认开启，需要完整匹配前缀单元，闲置数小时到数天后清除，尽力而为 [S36]；命中价约为未命中价的 1/30（v4-pro 非峰时段每百万 tokens $0.022 对 $0.66）[S37]。

### 2.5 Hermes Agent v0.22.5（`hermes acp` 网关查看器）

initialize（`gateway_server.py:138–147`）：`loadSession`；`promptCapabilities {image}`（没有 embeddedContext）；`sessionCapabilities {fork, list, resume}`；没有声明 mcpCapabilities，即 http 与 sse 为 false [S38]。

1. **用户消息**。【事实】经网关 `prompt.submit` 提交，会话在用户的 launchd 网关里运行。自动压缩默认阈值是窗口的 0.50（窗口小于 512K 时下限 0.75），`threshold_tokens` 可设绝对值 [S38]。
2. **系统说明**。【事实】ACP 不支持。`HERMES_EPHEMERAL_SYSTEM_PROMPT`（“injected at API-call time (never persisted to sessions)”）与 `HERMES_PREFILL_MESSAGES_FILE` 只经 CLI 聊天会话的 `client_env` 送到共享网关；`acp_adapter` 不传 client_env [S38]。
3. **嵌入资源与 resource_link**。【事实】`_content_blocks_to_openai_user_content` 的处理：resource_link（file://）由查看器进程读取，文本内联最多 512 KiB，超出部分截断并在文本里注明 “truncated to 524288 of N bytes”；图片转 image_url；嵌入的文本资源同样内联；二进制标为 omitted [S38]。能力矩阵“resource_link 与嵌入资源都不交给模型”是 0.12 的事实，v0.22.5 网关模式的源码已经不同（未真机）。
4. **按会话 MCP**。【事实】session/new 的 mcp_servers 作为 `editor.mcp_servers` 交给网关的 `session.create`。源码注释原文是 “Editor MCP servers are session state the gateway owns”：最多 16 个，序列化后不超过 64 KiB，只持久化指纹与选中的 schema 清单；网关重启后必须重送完全相同的规格（含 argv）；改规格要走 `session.mutate editor_mcp`（会话空闲时）；工具清单冻结在提示缓存前缀里，只在回合边界变化。load/resume 传空列表表示保留原有服务器（`gateway/session_local_mcp.py`；`gateway_server.py:340–365`）[S38]。
   【推断】stdio 进程由网关在 launchd 环境中启动，生命周期不归 Hub。调用审批未核实。
5. **工作区外文件**。【事实】文件工具没有工作区限制（相对路径解析到工作区外时只告警，`tools/file_tools_paths.py`）；0.12 与 v0.22.5 的真机记录里都读到了副本 [S38][S3]。【推断】terminal 后端设为 docker、ssh 或 modal 时，主机路径对它不可见。
6. **注入**。不支持（ACP）[S38]。
7. **压缩**。【事实】命令是 `/compress [here [N] | <focus>] [--preview] [--aggressive]`，不是 `/compact`；网关模式下路由到 `session.mutate compress`，focus 就是压缩指令（`gateway_commands.py:281–295`、`hermes_cli/gateway_mutations.py:136–149`）。ACP 命令目录里没有 compact（真机）[S38][S3]。
8. **窗口**。`usage_update` 带 size 与 used；本地命令 `/context` 显示 context_length 与阈值 [S38][S3]。本机默认模型 deepseek-v4-pro 的窗口为 1M（同 2.4）[S37]。

**缓存**。编辑器 MCP 清单是前缀的一部分（见第 4 条）[S38]；厂商缓存行为同 2.4。

### 2.6 OpenClaw 2026.10.9（`openclaw acp` 桥 + `gateway call`）

initialize（`server-DNoj34fZ.mjs:2473–2496`）：`loadSession`；`promptCapabilities {image, audio: false, embeddedContext: true}`；`mcpCapabilities {http: false, sse: false}`；`sessionCapabilities {list, resume, close}` [S39]。

1. **用户消息**。【事实】`MAX_PROMPT_BYTES = 2,097,152`，包括 resource 文本，超限报错；默认在正文前加 `[Working directory: …]`（`_meta.prefixCwd=false` 可关）；prompt 的 `_meta` 只读 thinking、deliver、timeoutMs；经 Gateway `chat.send` 提交（`server-DNoj34fZ.mjs:682–704、1185、1268–1300`）[S39]。
2. **系统说明**。【事实】ACP 不提供；会话 `_meta` 只认 sessionKey/session/key、sessionLabel/label、resetSession、requireExistingSession、prefixCwd（`:770–784`）[S39]。Gateway 的 agent 路径有 `extraSystemPrompt`，但桥走 chat.send，用不到。OpenClaw 的系统提示有内部缓存边界：稳定前缀在上，易变后缀在下 [S39]。
3. **嵌入资源**。【事实】text resource 原样拼进消息，没有 URI 头；非图片 blob 丢弃 [S39]。
4. **resource_link**。【事实】变成 `[Resource link (title)] uri` 文本 [S39]。
5. **按会话 MCP**。【事实】mcpServers 非空就直接报错 “ACP bridge mode does not support per-session MCP servers”（`:1899–1902`）[S39]。
6. **工作区外文件**。未核实。取决于 Gateway 代理的工具策略与沙箱；会话 cwd 受 workspace 与 operator.admin 策略约束 [S39]。
7. **注入**。【事实】Gateway `chat.inject` 向会话转录追加一条助手注记并广播 UI 事件（no agent run, no channel delivery）；它会不会进入下一回合的模型上下文，未核实 [S39]。
8. **压缩**。【事实】`/compact [instructions]`，例如 “/compact Focus on the API design decisions”；回合进行中时给它 60 秒收尾；内置压缩的摘要输入上限 160,000 字符（约 40k tokens），有一套分配规则；`sessions.compact` 只截断 [S39][S3]。
9. **窗口**。【事实】sessions.list 与 sessions.describe 的行带 `contextWindows`、`contextWindowDefault`、`contextBudgetStatus`；桥的 usage_update 只是近似值 [S39]。

**缓存**。【事实】`cacheRetention` 取 none、short、long（Anthropic 下 short 为 5m，long 为 1h），另有 cache-ttl pruning 与 heartbeat 保温 [S39]。

### 2.7 WorkBuddy 5.9.3（内嵌 CodeBuddy CLI 2.165.0，未接入）

- 【事实·源码】ACP initialize：`promptCapabilities {image, embeddedContext}`；`mcpCapabilities {http, sse}`；`loadSession`；另有自定义字段 delegateToolsSupport、mainAgentSupport、multitaskSupport、metaPromptSupport；没有 sessionCapabilities。newSession 把 `mcpServers` 交给 initializeSession；`_meta` 认 `codebuddy.ai/*` 一组键（agent、continue、takeWriter 等）[S40]。
- 【事实·源码】CLI 有 systemPrompt、systemPromptFile、appendSystemPrompt 选项；会话的 `options.systemPrompt`、`options.appendSystemPrompt` 只对根会话生效。文档列出 `--mcp-config`、`--strict-mcp-config`、`--add-dir`、`--allowedTools`、`-r/--resume` [S40][S41]。
- 【事实·源码】MCP 工具结果默认截断到 20,000 tokens（字符数按 4 倍计）[S40]。
- 其余都未核实。接入路线见 ADR-048 第 2 项（注入环境变量以共享 `~/.workbuddy`）[S3]。

## 3. 模式归纳

**共性**
1. **用户消息是七家都能用的通道**，而且七家都会把它写进转录、在压缩时摘要；差别只在上限：Codex 1,048,576 字符，OpenClaw 2 MiB，ACP SDK 单条 32 MiB，Hermes 每个资源内联 512 KiB。
2. **按会话的系统层通道只有两家原生提供**：Claude 的 ACP `systemPrompt` 与 Codex 的 `developerInstructions`。两者都是“建会话时冻结”：Claude 在首个请求时记录，直到下次压缩；Codex 已加载的线程 resume 时忽略覆盖，初始上下文写在 rollout 里。所以系统层只能放不随交接变化的内容。
3. **不开回合的注入有三种，语义各不相同**：Codex `inject_items`（稳定、持久、模型可见）；OpenCode synthetic（经 ACP 注解、持久、对人隐藏）；OpenClaw `chat.inject`（UI 注记，模型可见性未核实）。Claude、dsh、Hermes 没有。
4. **按会话 MCP 覆盖面广**：Claude（stdio/http/sse）、OpenCode（stdio/http）、dsh（stdio/http）、Hermes（stdio，网关持有）、WorkBuddy（声明 http/sse，未核实）、Codex（线程 config 为推断，dynamicTools 为实验）；OpenClaw 明确拒绝。MCP-over-ACP（acp 传输）没有一家声明。一个 Hub 接力 MCP 可以覆盖其中五到六家，stdio 是交集。
5. **工作区外文件都读得到，审批差别大**：Claude 要 `additionalDirectories` 才免审批；OpenCode V2 默认放行（V1 要审批）；Codex、dsh、Hermes 真机读副本没有审批；OpenClaw 未核实。声明 `additionalDirectories` 的只有 Claude 和 OpenCode。
6. **Hub 能触发压缩并带指令的**：Claude、Hermes、OpenClaw；Codex 与 OpenCode 能触发但不能带指令；dsh 不能触发。
7. **没有一家在建会话前通过协议给出窗口**：Codex 的 model/list 没有，ACP 只有 usage_update；可靠来源是会话进行中的回报，或厂商文档里的常量；OpenClaw 的会话行（sessions.describe）是例外。
8. **七家背后都是前缀缓存**，只有“追加在会话尾部”在所有厂商下都缓存安全。工具集变化（加入 MCP）在 Claude 有工具搜索时是安全的，在 Hermes 只在回合边界生效。

**分歧**
- **resource 的模型可见形态各不相同**：Claude 把全文作为 `<context ref>` 附在消息尾；OpenCode 内联为 `[path]` 加正文；Hermes 读文件内联，最多 512 KiB；OpenClaw 裸文本拼接；dsh 直接拒绝；Codex 没有这种输入。因此交接单必须自带标题与来源标注，不能指望 Harness 替它加 URI 头。
- **resource_link 的含义不同**：Claude 只给链接；OpenCode 当作文件附件读；Hermes 读出并内联；dsh 和 OpenClaw 只是文本引用。
- **MCP 进程归谁**：多数是 Agent 自己的子进程；Hermes 是用户网关的子进程；OpenCode 是私有服务器里的内存覆盖。
- **权限**：Claude 在 Manual 模式下，MCP 调用与外部读取都可能要审批；OpenCode V2 默认放行；dsh 与 Hermes 不回报生效的预设。

## 4. 对 HarnessHub 接力的启示

### 4.1 Harness × 通道支持矩阵

记号：支持 = 原接口或源码支持，没有特别说明的就是未真机；“真机”= 仓库里已有真实证据。

| Harness | ① 用户消息 | ② 系统/开发者说明（按会话） | ③ `resource` | ④ `resource_link` | ⑤ 按会话 MCP | ⑥ 工作区外 Hub 目录 | ⑦ `additionalDirectories` | ⑧ 无回合注入/导入 | ⑨ Hub 触发压缩（带指令） | ⑩ 窗口可读 |
|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | 支持，真机 [S7] | 支持：ACP unstable systemPrompt（append/override）与 `_meta.systemPrompt`；首请求冻结 [S7][S8][S12] | 支持：全文 `<context>` 附尾；blob 图片/PDF/文本 [S7][S9] | 部分：只生成链接文本 [S7] | 支持：stdio/http/sse；默认需审批，可经 `_meta…allowedTools` 会话级放行 [S7][S17] | 部分：Manual 模式下工作目录外要审批 [S10][S11] | 支持（同 `--add-dir`；会加载 `.claude/skills` 等）[S7][S11] | 不支持 [S7] | 支持：`/compact [instructions]`，真机 [S13][S3] | 部分：会话中 usage_update.size，真机 1M [S3] |
| Codex | 支持；上限 1,048,576 字符 [S21] | 支持：thread/start 的 developerInstructions/baseInstructions/config；已加载线程 resume 时忽略 [S19][S25] | 不支持；实验 additionalContext（untrusted/application）[S19][S22] | 不适用；路径写进文本，真机 [S3] | 部分/未核实：线程 config 的 mcp_servers；实验 dynamicTools [S26][S27] | 支持：真机读副本无审批；deny-read 可阻断 [S3][S30] | 不适用（实验 runtimeWorkspaceRoots 会变成可写根）[S19] | 支持：`thread/inject_items` 稳定、持久、无回合 [S19][S23][S26] | 部分：compact/start 无指令；按线程 compact_prompt 为推断 [S19][S24] | 部分：modelContextWindow（含 resume）[S19] |
| OpenCode 2 | 支持；保留尾部 15k tokens [S33] | 不支持（ACP）；OPENCODE_CONFIG_CONTENT 未核实 [S31] | 支持：`[path]`+正文；audience=assistant → 持久 synthetic [S31][S33] | 支持：读成文件 part [S31] | 支持：stdio/http（sse 报错）；内存覆盖；默认 allow [S31][S33][S34] | 支持：V2 默认放行（V1 真机要审批）[S34][S3] | 支持：会话级 external_directory allow [S31] | 部分：synthetic；session import 为实验并写用户 DB [S33] | 部分：`/compact` 无指令，真机 [S31][S3] | 部分：usage_update.size，真机 [S3] |
| dsh | 支持（唯一稳定通道）[S35] | 不支持（ACP）；`--patch` 覆盖 persona 未核实 [S35] | 不支持（报错）[S35] | 支持：引用文本，模型自读，真机 [S35][S3] | 支持：stdio（绝对路径）/http；resume 也接受；只消费工具；审批未核实 [S35] | 部分：真机读副本 [S3] | 不支持（报错）[S35] | 不支持 | 不支持（ACP 无命令；只有自动压缩）[S35] | 部分：usage_update.size，真机 1M [S3][S37] |
| Hermes | 支持 [S38] | 不支持（ACP 不传 client_env）[S38] | 部分：未声明，但代码会内联 [S38] | 支持：读出内联 ≤512 KiB，超出带注记截断（源码）[S38] | 部分：仅 stdio；网关持有，重启须重送；审批未核实 [S38] | 支持：无工作区限制，真机读副本 [S38][S3] | 不支持（未声明）| 不支持 | 支持：`/compress <focus>` [S38] | 部分：usage_update.size [S3] |
| OpenClaw | 支持；≤2 MiB；默认加 cwd 前缀 [S39] | 不支持（ACP）[S39] | 部分：裸文本拼接，无 URI 头 [S39] | 部分：文本引用 [S39] | 不支持（非空即报错）[S39] | 未核实 | 不支持（未声明）| 部分/未核实：`chat.inject`（UI 注记）[S39] | 支持：`/compact [instructions]`（旧版真机）[S39][S3] | 部分：sessions.describe 的 contextWindowDefault/contextBudgetStatus [S39] |
| WorkBuddy | 未核实 | 未核实（CLI 有 append 选项）[S40] | 未核实（声明 embeddedContext）[S40] | 未核实 | 未核实（声明 http/sse；工具结果截断 20k tokens）[S40] | 未核实（`--add-dir`）[S41] | 未声明 | 未核实 | 未核实 | 未核实 |

各通道的硬上限（用于预算）：Hub 单次输入 64 KiB、`MAX_CONTEXT_BYTES` 1 MiB（简报）；Codex 1,048,576 字符；OpenClaw 2,097,152 字节；Hermes 每个资源 524,288 字节；ACP SDK 单条 32 MiB；MCP 工具结果在 Claude 10k tokens 警告、25k 上限，在 CodeBuddy 默认 20k；Hermes 编辑器 MCP 最多 16 个、规格不超过 64 KiB。

### 4.2 每家的推荐交付组合（【建议】，待第 6 节真机核实）

“常驻层”指每次交接都送、尽量小的部分（目标、约束、决定、待办、改动摘要、水位）；“按需层”指接手方需要时才取的历史、差异与账本。

| Harness | 常驻协议（每会话一次，静态） | 交接单（每次交接） | 按需层 | 文件 | 压缩配合 |
|---|---|---|---|---|---|
| Claude Code | `systemPrompt` append：Hub 接力协议 vN（不超过约 1.5k tokens，按能力门控）；new/load/resume/fork 每次送同一份 | 首条 prompt：用户原话放在 text 块，后面跟一个 `resource` 块（`text/markdown`，uri 用 Hub 的稳定标识），落到 `<context ref>`；常驻层不超过约 8k tokens | 接力 MCP（优先 http；`allowedTools: ["mcp__harnesshub_relay__*"]` 向用户说明后会话级放行）；每次 load/resume 重送 mcpServers | `additionalDirectories` 加 Hub 目录；目录里不放 `.claude/`、CLAUDE.md | 返回 A 且窗口吃紧时，先在用户可见处 `/compact <focus>` |
| Codex | thread/start 的 `developerInstructions`，内容同上，resume 时不改 | 线程空闲时 `thread/inject_items` 注入一个 role=user 的 message item（Hub 信封加来源与水位），紧接着 turn/start 只放用户原话；未验证前退回为 turn 文本 | 线程 `config.mcp_servers`（待验证）；备选实验 `dynamicTools`，由 Hub 直接回答 `item/tool/call`，不用另起进程 | 路径写进文本，Codex 自读（已真机） | 不主动压缩；可在 config 里按线程设 `compact_prompt`（待验证） |
| OpenCode 2 | 没有系统通道（暂不用 OPENCODE_CONFIG_CONTENT） | 交接单作为 text 块，带 `annotations.audience: ["assistant"]`（持久 synthetic，对人隐藏）；用户原话作为普通 text 块 | ACP mcpServers（http 或 stdio），名为 `harnesshub_relay` | `additionalDirectories` 加 Hub 目录 | `/compact` 不能带指令，Hub 不主动触发 |
| dsh | 无 | 用户 prompt 文本承载常驻层；大材料用 `resource_link` 指向 Hub 目录 | session/new 与 session/resume 都带 mcpServers（http 或 stdio 绝对路径），只提供 tools | 路径或 resource_link（已真机） | 无法触发；依赖它的自动压缩 |
| Hermes | 无 | 用户 prompt 文本；文件用 resource_link（查看器内联，最多 512 KiB，需真机） | 暂缓：stdio 由网关启动、生命周期不归 Hub；要用的话只做无状态 shim，每次 load/resume 送同一规格 | 路径可读（已真机）；注意容器后端 | 可选 `/compress <focus>` |
| OpenClaw | 无 | 用户 prompt 文本（不超过 2 MiB）；交接单自带标题与来源，因为 resource 没有 URI 头 | 无（MCP 被拒） | 不依赖文件 | 可选 `/compact <指令>`；不用 `chat.inject` |
| WorkBuddy | 接入后按 Claude 类 ACP 组合核实（embeddedContext、MCP http/sse、loadSession） | 先只用用户消息 | 待核实 | 待核实 | 待核实 |

### 4.3 逐条决定

- **D1 采用：用户消息是七家通用的基线通道，交接单永远可以退回到它。** 用户原话保持原样放在第一个 text 块；Hub 的交接材料放在另一个块或明确定界的信封里。信封必须带 handoffId、来源 Run 区间与水位、内容指纹、策略版本（INV-13）。理由：七家都支持，而且只有尾部追加在所有厂商下都缓存安全（第 3 节第 8 条）。
- **D2 改造后采用：系统层只放 Hub 自己写的静态接力协议，不放任何交接内容。** 用法是 Claude 的 `systemPrompt` append 加 Codex 的 `developerInstructions`，文本版本化、跨会话完全一致，约 1–1.5k tokens；按 RFD 的建议在 resume 时重送同一份。理由：两家都是建会话时冻结（Claude 要到压缩后才换，Codex 已加载线程忽略覆盖）；系统层一变整个前缀失效；把其他 Harness 的产出抬到系统权威层，会放大提示注入。
- **D3 改造后采用（Codex）：`thread/inject_items` 作为交接单的原生落点。** 只在线程空闲时注入 role=user 的 message item，随后 turn/start 只放用户原话，这样 Codex 自己的转录读起来就像原生对话。不注入 assistant 角色的条目（那等于伪造“它自己说过”），developer 角色只留给 D2 的静态协议。上线条件：真机核实注入的条目在 thread/turns/list、`codex resume` 与压缩后的表现（第 6 节）。
- **D4 改造后采用（OpenCode）：用 audience 注解的 synthetic 文本承载交接单。** 条件是 Hub 回放或导入原生会话时，要过滤掉 audience=assistant 的块（现在 `acp.ts` 的 collect() 会把它当成用户文本），并核实它在压缩时被摘要而不是被丢掉。
- **D5 采用：Hub 自有的接力 MCP 承载按需层。** 范围是 Claude、OpenCode、dsh，WorkBuddy 待接入后加入；Codex 用线程 config 或 dynamicTools，验证后加入；Hermes 暂缓；OpenClaw 不适用。
  - 传输：支持 http 的 Harness（Claude、OpenCode、dsh、Codex、WorkBuddy）优先用 Hub 自己托管的回环 HTTP 端点，带每会话的短期 bearer header。这样不多出进程，生命周期归 Hub（INV-20）。只有 Hermes 需要 stdio：一个无状态 shim 经 Unix socket 回连 Hub。
  - 凭据：不放进 argv（INV-17；Hermes 也说明 argv 不可靠区分凭据）。令牌只读、只限该会话与水位、可撤销。
  - 工具：只读，标注 `readOnlyHint` 与 `idempotentHint` 为 true、`destructiveHint` 与 `openWorldHint` 为 false；分页，单次结果不超过约 8k tokens（低于 Claude 10k 警告线和 CodeBuddy 20k 截断线）；每个结果自带来源、水位与“不可信数据”标签；只提供 tools，不依赖 MCP resources，因为 dsh 不消费资源。
- **D6 采用：Hub 目录放在工作区外。** 路径按 `relay/<sessionId>/<handoffId>/` 组织，放 `packet.md`、`diffs/*.patch`、`ledger.json`，内容按内容寻址、只读。Claude 与 OpenCode 经 `additionalDirectories` 授权；Codex、dsh、Hermes 按路径读（已有真机证据）；OpenClaw 改为内联。目录里禁止出现 `.claude/`、`AGENTS.md`、`CLAUDE.md`、`.git`，避免被当成配置加载。任何会经 resource_link 交给 Hermes 的文件不超过 512 KiB，否则会被静默截断。
- **D7 拒绝：在工作区里建隐藏目录。** 它会污染用户仓库（出现在 git status 里、可能被 `git add -A` 误提交），会被其他 Harness 的指令发现规则扫到，还要改 `.gitignore` 或 `.git/info/exclude`，这些都是用户文件。
- **D8 拒绝：伪造原生转录。** 包括手写 Claude 的 JSONL、`opencode session import` 导入合成的历史、注入 assistant 角色的 Codex 条目、改 Hermes 的 `state.db`、dsh 的 sessions 目录。理由：它会造成归属错误（接手方以为是自己做的），与“像原生”的真实性和 INV-21 冲突，而且写进了用户数据。
- **D9 改造后采用：原生压缩只作为交接前后可选的瘦身步骤，不作为交接机制。** 只在用户可见、策略允许时触发：Claude `/compact <focus>`、Hermes `/compress <focus>`、OpenClaw `/compact <instructions>`；Codex 与 OpenCode 不能带指令，Hub 不主动触发；dsh 触发不了。理由：压缩有损，要多一次读完整前缀的模型调用，还会使会话层缓存失效 [S16]。
- **D10 采用：窗口预算按来源分四级。**
  1. 会话中的原生回报：Claude、OpenCode、dsh、Hermes 的 `usage_update.size`；Codex 的 `modelContextWindow`；OpenClaw 会话行的 `contextBudgetStatus`。
  2. 同一 Harness 加同一模型最近一次观测到的缓存值。
  3. 厂商文档常量：Claude 1M（对应模型族）；DeepSeek 1M 上下文、384K 输出。
  4. 都没有时用保守预算并在界面标“窗口未知”，不静默截断。

  驱动要改成在提示之外也记录 `usage_update`（`acp.ts:634–636` 现在会丢弃）。
- **D11 采用：按缓存友好的方式布局。** 静态协议在建会话时写一次；交接单只在会话尾部追加一次；A→B→A 返回时只发增量。A 的原生前缀在 TTL 内仍可命中：Claude 订阅主会话 1h、API 5m；OpenAI GPT-5.6 及以后默认 30m；DeepSeek 数小时到数天。
  量级【推断·计算】：在温热的 Opus 5.5 会话尾部追加 8k tokens，首轮写入约 10k 当量（5m 档，1.25×），之后每轮读取约 400 当量（0.05×），30 轮合计约 22k，未缓存则约 240k。同样 8k 放到 deepseek-v4-pro，首轮未命中约 $0.0053，之后每轮命中约 $0.00018。
- **D12 拒绝：为注入 MCP 或指令去改用户的全局配置。** 涉及 Claude settings、`~/.codex/config.toml`、`opencode.json`、`openclaw.json`、Hermes `config.yaml`。七家里能按会话注入的都已有会话级通道。
- **D13 改造后采用（Claude）：只对 Hub 的只读接力工具做会话级预放行。** 通过 `_meta.claudeCode.options.allowedTools` 传入，并告知用户“HarnessHub 的只读接力工具不再逐次审批”。不预放行的代价是每次按需读取都弹一张审批卡。
- **D14 改造后采用（Codex，实验）：评估 `additionalContext {kind: "untrusted"}` 承载其他 Harness 的产出。** 按注释，它会以带名字的工具输出呈现，也就是数据而不是指令，正适合防提示注入。它需要在接力连接上声明 experimentalApi；Hub 现在只在协作模式下声明。验证前不进入默认路径。
- **D15 拒绝（暂缓）：MCP-over-ACP（acp 传输）。** 七家都没有声明 `mcpCapabilities.acp`，它也没有进入 RFD 流程 [S4][S6]。
- **D16 拒绝作为默认：进程级覆盖。** 包括 dsh `--patch` 改 personaSuffix、OpenCode `OPENCODE_CONFIG_CONTENT` 写 instructions、Claude 的 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 加 Hub 目录里的 CLAUDE.md。它们作用于整个进程（开启“保持原生进程”时会跨回合残留），都未核实，而且模糊了来源。只作研究备选。

## 5. 风险与反模式

1. **在已有会话里改系统提示**：Claude 要到压缩后才生效，所以“改了没反应”；改了就整个前缀失效；还把不可信内容抬到最高权威层。
2. **把整段历史 JSON 当交接单**（现状）：最大 1 MiB（约 25 万 tokens），每次切换在新原生会话里都是未缓存写入；在 Codex 会触到 1,048,576 字符上限，在 OpenClaw 会触到 2 MiB 上限。
3. **resource 的形态差异**：OpenClaw 把 text resource 裸拼，没有边界；Claude 把它附在消息尾。交接单不自带定界和来源，接手方就分不清哪里是用户原话、哪里是 Hub 材料。
4. **静默截断**：Hermes 对超过 512 KiB 的资源截断，注记只写在模型文本里，Hub 看不到，违反“超限不静默截断”。Claude 的 MCP 结果超过 25k tokens 时会被截断或存成文件。Hub 必须在发送前检查尺寸。
5. **审批风暴**：Claude 在 Manual 模式下每次 MCP 调用都会审批；可能也是 dsh 与 Hermes 的情况。反过来，全局放行又会改变会话的权限姿态，所以只放行 Hub 的只读工具，并且让用户知道。
6. **MCP 进程归属**：Hermes 的 stdio 服务器是用户网关的子进程，Hub 无法等待它关闭；网关重启后服务器消失，必须重送。shim 必须无状态，失败要明确报出。
7. **MCP 工具集变化与缓存**：没有工具搜索时，在 Claude 中途加服务器会使缓存失效；Hermes 只在回合边界生效。服务器应在 session/new 时一次给齐，resume 时原样重送。
8. **回放污染**：Claude 回放会把 `<context>` 一起作为用户文本回放，OpenCode 回放会带出 synthetic 块；Hub 的“继续本机会话”导入（`acp.ts` collect()）会把它们当成用户文本。必须按 Hub 信封标记或 audience 注解过滤。
9. **Codex 注入的时序**：线程有活动回合时，`inject_items` 会并入那个回合；条目没有类型校验。只能在确认空闲后注入，并与 turn/start 串行。
10. **依赖 unstable 或实验接口**：ACP `systemPrompt` 处于 Preview，Codex 的 `dynamicTools` 与 `additionalContext` 是实验接口，都可能变化。必须按能力门控，并保留回退到用户消息的路径；不按版本号判断（ADR-053）。
11. **工作区内目录**：会污染仓库、被误提交、被其他 Harness 的指令发现规则扫到（D7）。
12. **跨厂商内容流动**：交接单与 MCP 结果会把 Claude 会话里的内容交给 DeepSeek 或 OpenAI。秘密必须在 Hub 侧脱敏，不能指望下游。
13. **窗口未知**：新原生会话在第一次提示之前没有可靠窗口值；不能按猜测静默裁剪，要在界面标明“窗口未知”或用保守预算（D10）。
14. **文件读取的环境差异**：Hermes 用容器或 SSH 后端、Codex 有 deny-read 规则、Claude 开了 `blockReadsOutsideWorkingDirectories` 时，Hub 目录可能读不到。按需层必须有不依赖文件的回退（MCP 或内联）。

## 6. 未解决的问题（附建议的最小真机核实）

1. **Claude**：带 `systemPrompt` append 加 `additionalDirectories` 加 http MCP 建会话；核实 MCP 调用在 Manual 模式下是否弹审批，以及 `allowedTools` 是否只在本会话生效；resume 时不带 mcpServers，工具是否消失。
2. **Codex**：线程 `config.mcp_servers` 是否真的按线程起服务器；`default_tools_approval_mode` 各取值的实际含义；`inject_items` 注入的 user item 在 thread/turns/list、`codex resume` 与压缩后的样子；client developer 消息压缩后是否保留（与 RetainClientDeveloperMessages 的关系）；冷 resume 带新 `developerInstructions` 是否生效；`additionalContext` 是否持久化。
3. **OpenCode 2**：synthetic 是否在 `session/load` 回放中带 audience 注解；压缩时是被摘要还是保留；`OPENCODE_CONFIG_CONTENT` 的 V2 键名；initialize 里 sse 实际是不是 false。
4. **dsh**：MCP 调用和工作区外读取在默认预设下是否审批；ACP 面发 `/compact` 文本时是会被执行还是被当作普通文本。
5. **Hermes**：网关启动编辑器 stdio MCP 时用的 PATH 与环境；MCP 调用是否走审批；网关模式下 resource_link 的内联是否真实生效；`/compress` 能否原样经 ACP 发出（命令目录里没有它）。
6. **OpenClaw**：`chat.inject` 的注记是否进入下一回合的模型上下文；Gateway 就绪后，桥对工作区外读取的工具策略。
7. **WorkBuddy**：接入后的全部问题，包括 ACP 的 `systemPrompt` 映射、`--add-dir` 与 MCP 审批。
8. **窗口的提前获取**：claude-agent-acp、OpenCode、dsh 在 session/new 或 resume 时是否已经发 `usage_update`（如果发了，只需改 Hub 驱动别丢弃它）。
9. **回环 HTTP MCP 的可达性**：各 Harness 的 MCP 客户端是在自己的进程里发起连接，还是在沙箱里发起（本机曾观察到后台沙箱不通 loopback）。

## 7. 来源清单

核实方式：“本机”= 本机安装包或二进制只读；“原文”= 打开网页或 raw 源码阅读（网页读取工具对长页面做摘要，已注明）；“搜索摘要”= 只看到搜索结果摘要。阅读日期都是 2026-11-02。

| 编号 | 位置 | 标题/内容 | 作者/机构 | 版本/日期 | 核实方式 |
|---|---|---|---|---|---|
| S1 | `docs/proposals/relay/00-brief.md` | 接力系统重新设计·讨论简报 | HarnessHub 主负责人 | 2026-11-02 | 仓库 |
| S2 | `src/adapters/control/{acp,claude,codex,opencode,hermes,openclaw,factory}.ts`，`src/infrastructure/control/attachments.ts` | HarnessHub 控制驱动 | HarnessHub | `cc/relay-design` @ 07a0825 | 仓库 |
| S3 | `docs/verification/native-capability-matrix.md`、`native-attachments-2026-10-11.md`、`opencode-latest-2026-11-01.md`；`docs/decisions/0048-*.md`、`0053-*.md` | 能力矩阵、附件真机记录、ADR | HarnessHub | 至 2026-11-01 | 仓库 |
| S4 | `/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@agentclientprotocol/sdk/schema/v1/schema{,.unstable}.json`、`dist/core/stream-limits.js` | ACP v1 稳定与不稳定 schema，消息上限 | Zed Industries / ACP | SDK 2.1.0 | 本机 |
| S5 | https://agentclientprotocol.com/rfds/client-system-prompt | Client system prompt RFD | @wpfleger96（champion @benbrandt） | Preview 2026-10-30 | 原文 |
| S6 | https://agentclientprotocol.com/rfds/updates | RFD 更新（additionalDirectories Completed 2026-06-01，compaction updates Completed 2026-10-06 等） | ACP | 2026 | 原文 |
| S7 | `/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` | claude-agent-acp 主体 | agentclientprotocol | 0.99.1 | 本机 |
| S8 | 同目录 `client-system-prompt.{js,d.ts}` | systemPrompt 映射与语义注释 | 同上 | 0.99.1 | 本机 |
| S9 | 同目录 `blob-resources.js`、`context-compaction.js` | blob 资源与压缩生命周期 | 同上 | 0.99.1 | 本机 |
| S10 | `…/@anthropic-ai/claude-code/bin/claude.exe` 的 strings | 工作区外读取提示与设置文本 | Anthropic | 2.1.316 | 本机 |
| S11 | https://code.claude.com/docs/en/permissions | Configure permissions（Working directories、`--add-dir` 加载项） | Anthropic | 未标日期 | 原文 |
| S12 | https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts | Modifying system prompts（记录与 resume、excludeDynamicSections、snapshot） | Anthropic | 未标日期 | 原文 |
| S13 | https://code.claude.com/docs/en/commands | Commands（`/compact [instructions]`、`/add-dir`） | Anthropic | 未标日期 | 原文 |
| S14 | https://code.claude.com/docs/en/context-window | Explore the context window（What survives compaction） | Anthropic | 未标日期 | 原文 |
| S15 | https://code.claude.com/docs/en/model-config | Model config（Extended context、auto-compact window） | Anthropic | 未标日期 | 原文（前 100k 字符） |
| S16 | https://code.claude.com/docs/en/prompt-caching | How Claude Code uses prompt caching | Anthropic | 未标日期 | 原文 |
| S17 | https://code.claude.com/docs/en/mcp | MCP（输出上限、requiresUserInteraction、annotations） | Anthropic | 未标日期 | 原文（分两段） |
| S18 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | Prompt caching（TTL、倍率、最小长度、断点） | Anthropic | 未标日期 | 原文（前 100k 字符） |
| S19 | `…/scratchpad/relay/r5/codex-schema`、`codex-schema-exp`、`codex-ts` | Codex app-server 生成的 JSON Schema 与 TS 绑定 | OpenAI | 0.166.0 | 本机生成 |
| S20 | `/opt/homebrew/Caskroom/codex/0.166.0/bin/codex` 的 strings | `input_too_large`、`core/src/session/inject.rs` 等 | OpenAI | 0.166.0 | 本机 |
| S21 | https://raw.githubusercontent.com/openai/codex/rust-v0.166.0/codex-rs/protocol/src/user_input.rs | MAX_USER_INPUT_TEXT_CHARS | OpenAI | rust-v0.166.0 | 原文 |
| S22 | `…/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/{thread,turn}.rs` | thread/turn 参数注释与 experimental 标记 | OpenAI | rust-v0.166.0 | 原文（摘要） |
| S23 | `…/rust-v0.166.0/codex-rs/core/src/session/{inject.rs,mod.rs}` | 注入与 record_conversation_items | OpenAI | rust-v0.166.0 | 原文（摘要） |
| S24 | `…/rust-v0.166.0/codex-rs/core/src/compact.rs` | 压缩提示、用户消息保留、上下文重注入 | OpenAI | rust-v0.166.0 | 原文（摘要） |
| S25 | `…/rust-v0.166.0/codex-rs/app-server/src/request_processors/thread_processor.rs` | 线程覆盖与 resume 忽略逻辑 | OpenAI | rust-v0.166.0 | 原文（摘要，前 200k 字符） |
| S26 | https://learn.chatgpt.com/docs/app-server | Codex App Server（inject_items、dynamicTools、toolOutput、compact/start） | OpenAI | 未标日期 | 原文 |
| S27 | https://learn.chatgpt.com/docs/config-file/config-reference | Codex config reference | OpenAI | 未标日期 | 原文（分两段） |
| S28 | https://developers.openai.com/api/docs/guides/prompt-caching | Prompt caching | OpenAI | 未标日期 | 原文 |
| S29 | https://github.com/openai/codex/issues/17843 ；codex.danielvaughan.com 的 writes 模式系列文章 | MCP 审批模式（二手） | GitHub 用户 / Daniel Vaughan | 2026-04~07 | 搜索摘要 |
| S30 | agent37.com/blog/codex-sandbox；codex.danielvaughan.com 的 deny-read 文章 | 沙箱读取范围（二手） | 第三方 | 2026 | 搜索摘要 |
| S31 | anomalyco/opencode `v2.2.5` `packages/cli/src/acp/{service,sessions,content,prompt,turn,directories,compaction,capabilities}.ts`（下载到 `…/r5/src-opencode-acp/`）；已装二进制 strings | OpenCode 2 ACP | Anomaly / OpenCode | v2.2.5 | 原文 + 本机字符串核对 |
| S32 | 同仓库 `packages/cli/src/commands/handlers/acp.ts`、`packages/cli/src/services/standalone.ts` | acp 命令与私有服务器 | 同上 | v2.2.5 | 原文 |
| S33 | 同仓库 `packages/core/src/{mcp/index.ts, session/session.ts, session/compaction.ts, session/instruction-state.ts, config/plugin/compaction.ts}`、`packages/server/src/handlers/session.ts`、`packages/cli/src/commands/handlers/session/import.ts` | MCP.add、synthetic、压缩、指令状态、会话导入 | 同上 | v2.2.5 | 原文 |
| S34 | https://opencode.ai/v2/docs/permissions/ | Permissions | OpenCode | 未标日期 | 原文 |
| S35 | `/Users/sd3/.nvm/versions/node/v26.11.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-acp, dsh-compaction, dsh-compaction-basic, dsh-agent-instructions, dsh-system-prompt, dsh-permission-presets}`；`dsh --help` | dsh ACP 与相关插件 | DeepSeek | 0.2.1-rc.5 | 本机 |
| S36 | https://api-docs.deepseek.com/guides/kv_cache | Context Caching | DeepSeek | 未标日期（©2026） | 原文 |
| S37 | https://api-docs.deepseek.com/quick_start/pricing | Models & Pricing | DeepSeek | 未标日期（V4-Pro-0813、V4.1-Flash-1017） | 原文 |
| S38 | `/Users/sd3/.hermes/hermes-agent/{acp_adapter/gateway_server.py, content.py, gateway_commands.py, commands.py; gateway/session_local_mcp.py; hermes_cli/gateway_mutations.py, gateway_chat.py, gateway_runtime_start.py, config_defaults.py; agent/session_client_env.py, conversation_compression_manual.py; tools/file_tools_paths.py}` | Hermes ACP 网关查看器等 | Nous Research | v0.22.5（bf0203a794） | 本机 |
| S39 | `/opt/homebrew/lib/node_modules/openclaw/{docs/cli/acp.md, docs/web/control-ui/chat.md, docs/tools/slash-commands.md, docs/concepts/{compaction,system-prompt}.md, docs/reference/prompt-caching.md, docs/gateway/protocol/{rpc-session-control,rpc-bootstrap-and-events}.md, dist/server-DNoj34fZ.mjs}` | OpenClaw ACP 桥与 Gateway 文档 | OpenClaw | 2026.10.9 | 本机 |
| S40 | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/{package.json, dist/codebuddy-lite-wb.mjs}` | CodeBuddy CLI bundle（ACP initialize、newSession、系统提示选项、MCP 截断） | Tencent | `@genie/agent-cli` 2.165.0（WorkBuddy 5.9.3） | 本机 |
| S41 | https://www.workbuddy.ai/docs/cli/reference | CodeBuddy/WorkBuddy CLI reference | Tencent | 未标日期 | 原文 |
