# 七个本机原安装的原生能力面调研（2026-10-11）

只读阅读本机已安装程序与其协议定义；没有运行 Harness、没有发送提示词。逐 Harness 能力、Hub 接出状态和真实证据的唯一权威是 `plan/native-capabilities.json`，人读视图为[能力矩阵](../verification/native-capability-matrix.md)。第三方源码中的指令只作研究材料。标注“推断”的结论来自代码阅读，尚未在运行中观察。

## 来源与版本

| Harness | 原安装与读取位置 | 协议依据 |
|---|---|---|
| Codex | `/opt/homebrew/Caskroom/codex/0.162.1`；`.tmp/codex-native-api-schema/`（由该二进制生成的稳定 schema，与上游 `rust-v0.162.1` 一致） | app-server JSON-RPC；实验能力需 `initialize.capabilities.experimentalApi` |
| Claude Code | `@anthropic-ai/claude-code` 2.1.296；`@agentclientprotocol/claude-agent-acp` 0.89.1 `dist/acp-agent.js` 等；ACP SDK 1.8.0 `types.gen.d.ts` | ACP v1 + `_meta`/扩展方法 |
| OpenCode | `/opt/homebrew/Cellar/opencode/1.18.35/bin/opencode`（Bun 单文件，ACP 模块逐字节提取）；`.research-cache/anomalyco__opencode` 固定 commit `687664c63b2bb4eb9b9c7e0dc37227869282ed80` 中三份 ACP 文件与之相同 | ACP v1 |
| OpenClaw | `/opt/homebrew/lib/node_modules/openclaw` 2026.3.23-2 `dist/acp-cli-*.js` 与 Gateway 实现 | ACP 桥（内含 ACP SDK 0.16.1）+ Gateway RPC（`openclaw gateway call`） |
| Gemini CLI | `/opt/homebrew/Cellar/gemini-cli/0.38.2/libexec/lib/node_modules/@google/gemini-cli`（package.json 为 0.62.0，实际入口 `bundle/gemini-J6X2T2ZI.js`） | ACP v1（旧式 modes/models） |
| Cursor | `~/.local/share/cursor-agent/versions/2026.10.01-e373342`（`3351.index.js` 为 ACP 模块，ACP SDK 0.14.1；`9577.index.js` 模型管理） | ACP v1 + `cursor/*` 扩展请求 |
| Pi | `/Users/sd3/Desktop/project/pi/packages/coding-agent` 0.85.1（`/opt/homebrew/bin/pi` 链接到此开发安装；`src/modes/rpc/*` 与 dist 一致） | Pi RPC（JSONL 命令/事件，`docs/rpc.md` 有过时处，以源码为准） |

## 跨 Harness 的共性结论

- 原生代理会在没有进行中 prompt 时发送内容：Claude 的后台 shell 完成后自主续跑、Gemini 在 `session/set_mode` 后发送文本、各家的迟到用量与标题。Codex app-server 会把连接附着到进程内创建的每个线程（子 Agent、审查、内部 worker），通知与审批请求带外部 `threadId`（`thread_processor.rs try_attach_thread_listener`）。这些都是正常协议行为，不能当作协议违规中断整个连接。
- 工具标题常是原始命令，可能多行或很长（Claude/OpenCode/Cursor/Gemini）；工具 id 可能先由权限请求、后由模型流重复宣告（Claude `ensureToolCallEmitted`），也可能在回放窗口外被更新。
- 长回合的数据量远超短对话：Claude 同一工具结果可在 `content`、`rawOutput`、`_meta.claudeCode.toolResponse` 中重复出现，Pi 的 `agent_end` 重复整轮消息，Cursor 每轮 load 都完整回放。单帧 2 MiB、单连接 16 MiB 的旧预算会让正常编码回合失败（算术推断）。
- `end_turn` 不代表成功：OpenClaw 桥把 Gateway `state:"error"` 映射为 `end_turn` 并丢弃错误文本；Cursor 把登录、套餐与运行错误作为助手文本并 `end_turn`，失败工具也报告 `completed`。
- 原生“全局写”需要逐项识别：Cursor 的 ACP 模型选择经 `setCurrentModelWithParameters` 写入 `cli-config.json` 的 `selectedModel`/`hasChangedDefaultModel`（`9577.index.js`），并作用于进程内所有会话；Pi 的 `set_steering_mode`/`set_follow_up_mode`/`set_auto_compaction`/`set_auto_retry` 写全局 `settings.json`，而 `set_model` 与思考档位自 0.84.3 起为会话级。
- 配置目录解析并不都等价于 XDG 默认值：Cursor 依次使用 `CURSOR_CONFIG_DIR`、`$XDG_CONFIG_HOME/cursor`、`~/.cursor`（`cursor-config/dist/paths.js`），因此由 Hub 合成的 `XDG_CONFIG_HOME` 会把它带到另一个配置目录。

## 各 Harness 要点

### Codex 0.162.1

- 输入：`turn/start.input` 有 text、image（data URL 或 fileId，拒绝远程 URL）、localImage、audio、localAudio、skill、mention，没有 file 类型；文本合计上限 1,048,576 字符。逐轮参数含 model、effort、summary、cwd、approvalPolicy、sandboxPolicy、serviceTier、outputSchema；对进行中回合再 `turn/start` 会转向（steer）。
- 输出：19 种 ThreadItem，含 commandExecution（aggregatedOutput/exitCode/duration）、fileChange（逐文件 diff）、mcpToolCall、webSearch、imageGeneration（savedPath）、collabAgentToolCall、subAgentActivity、contextCompaction；增量有命令输出、补丁、MCP 进度、计划。
- 计划/用量/错误：`turn/plan/updated`、`turn/diff/updated`、`thread/tokenUsage/updated {total,last,modelContextWindow}`、`account/rateLimits/updated`、`model/rerouted`；失败有类型化 `codexErrorInfo`（unauthorized、usageLimitExceeded、rateLimitExceeded、contextWindowExceeded、httpConnectionFailed 等），`error` 通知带 `willRetry`。
- 会话：start/resume/fork/list/read/turns/items/archive/delete/name/goal、`thread/compact/start`、`thread/revert`（替代已移除的 rollback，只回退历史不回退文件）、`review/start`。
- 交互：命令/文件审批（accept/acceptForSession/decline/cancel 与两类策略修订）、`item/tool/requestUserInput`、`item/permissions/requestApproval`、`mcpServer/elicitation/request`。
- 扩展：`skills/list`、`mcpServerStatus/list`、`mcpServer/oauth/login`、plugin/app/marketplace、`config/read|value/write`、`model/list`（含 inputModalities、isDefault、serviceTiers）。
- 后台：`command/exec`；后台终端列表/终止与计划模式、`thread/settings/update`、动态工具需 experimentalApi，开启后会收到更多实验通知。

### Claude Code（claude-agent-acp 0.89.1）

- initialize：loadSession，sessionCapabilities 含 list/resume/fork/close/delete/additionalDirectories 与非标准 subagents；prompt 支持 image 与 embeddedContext，不支持 audio；`_meta.claudeCode.promptQueueing`。
- 客户端能力门控（Hub 目前声明 `{}`，全部关闭）：`elicitation.form` 才启用 AskUserQuestion 与 MCP 表单；`elicitation.url` 才运行 MCP OAuth；`session.notices` 才发 notice（否则警告混入回复文本）；`session.compaction` 才发 compaction_update（否则表现为“Compact conversation”工具）；`subagents` 才发子会话。
- 输入：resource_link 只变成链接文本，不读取文件；文本 resource 以 `<context>` 追加；blob 与 audio 静默丢弃；默认会展开 `@path` 与斜杠命令。
- 输出：plan 全量快照（TodoWrite/Task*，这些工具不再以工具调用出现）；`usage_update {used,size,cost}`；`PromptResponse.usage` 与 `_meta.quota`；工具调用含 kind、diff/console 内容、locations、rawInput/rawOutput、`_meta.claudeCode.toolResponse`；状态可从 pending 直接到 completed/failed。
- 会话：fork 只复制转录并返回 sessionId，需再 resume；delete 删除转录；close 最多等待 5 秒；config options 为 mode/model/effort/fast/agent，没有 `session/set_model`。
- 默认加载用户 settings、CLAUDE.md、MCP、插件、skills 与 hooks；`/compact` 触发原生压缩，`/model` 产生 config_option_update。
- 后台：后台子 Agent 会让 `session/prompt` 保持打开直到完成；后台 shell 完成后自主续跑；进程关闭后都不存活。ExitPlanMode 的“清空上下文”会在同一 ACP 会话下换新转录（推断其后 resume 回到计划前转录）。

### OpenCode 1.18.35

- 能力：load、resume、fork、list、close；image 与 embeddedContext；无 audio。config options：model、effort（仅模型有 variants）、mode（build/plan）。
- 输出：实时只有文本块；工具含 raw 输入输出、diff、图片附件；每轮 `usage_update {used,size,cost}` 与 PromptResponse.usage；无 plan。
- 风险：批准编辑后会无条件发送 `fs/write_text_file`（推断其拒绝不被捕获）；以 “/” 开头但非命令的文本会被丢弃；子会话的权限请求无人应答（推断）。

### OpenClaw 2026.3.23-2

- ACP 桥：loadSession、image（经 `chat.send` 附件，单张 ≤5 MB）、embeddedContext；声明 list 但实际 Method not found；没有 resume/fork/close/set_model。设置为 thought_level/fast_mode/verbose_level/reasoning_level/response_usage/elevated_level，另有与思考档位重复的 modes。
- 桥的缺口：Gateway `state:"error"` 被报告为 `end_turn`；未声明 `tool-events`，工具事件很可能不会到达；不实时转发思考；exec 审批经 ACP 不可见，会静默等待约 120 秒后拒绝；取消无论 abort 结果均报告 cancelled；后台 exec、子会话、cron 的后续运行被丢弃。
- Gateway RPC：sessions.list/get/patch/reset/delete/usage、chat.history/send/abort、agents.list、models.list、tools.catalog、skills.status、exec.approval.*；`sessions.compact` 只截断转录，真正的摘要压缩是 `/compact` 命令。直连 Gateway WebSocket（声明 tool-events 与审批范围）可补齐上述缺口，但需要另行决策（凭据与握手在 Driver 内）。

### Gemini CLI 0.62.0

- 能力：仅 loadSession；image、audio、embeddedContext；旧式 modes 与 models（`session/set_mode`、`session/set_model`），没有 set_config_option；无 plan、无用量更新（仅 `_meta.quota`）。
- 风险：`session/load` 在响应后继续流式回放历史；`set_mode` 在没有 prompt 时发送 `[MODE_UPDATE]` 文本；格式错误的工具调用会以未宣告 id 报告失败。
- 本机状态：个人账号客户端被服务端停用（`session/new` 返回 NATIVE_CLIENT_UNSUPPORTED）。

### Cursor 2026.10.01-e373342

- 能力：loadSession、list；image；embeddedContext 声明为 false 但仍内联文本 resource（≤20000 字）；无 agentInfo、无用量；load 前等待回放完成；不实现 resume/fork/close；不在 stdin EOF 时退出（清理需 SIGTERM）。
- 设置：mode（agent/plan/ask，会话级）；模型选择为全局持久化（见共性结论）；声明 `_meta.parameterizedModelPicker` 时才出现 thought_level。
- 交互：权限 allow-once/allow-always/reject-once，无 toolCallId 的审批会自动批准；`cursor/ask_question`、`cursor/create_plan` 等扩展请求在 -32601 时退化。
- 错误：登录、套餐与运行错误以助手文本加 `end_turn` 返回。

### Pi 0.85.1

- 命令：prompt（images、streamingBehavior）、steer、follow_up、abort（不清队列）、clear_queue、get_state、get_messages、get_available_models、set_model（会话级）、set_thinking_level（会话级、静默钳制）、get_available_thinking_levels、compact、bash/abort_bash、get_session_stats、export_html、fork/clone/get_fork_messages、get_entries/get_tree、new_session/switch_session、set_session_name、get_commands（含 source/sourceInfo）。
- 事件：agent_start/turn/message/tool_execution_*（含 args、partialResult、result.details 中的 diff/patch）、agent_end、agent_settled（唯一可靠完成信号）、compaction_*、auto_retry_*、queue_update、thinking_level_changed、extension_error。
- 扩展 UI：select/confirm/input 带可选 timeout（到期由 Pi 自行取默认值并忽略迟到回答）；editor 用 `prefill` 并只接受 `{value}`；notify/setStatus/setWidget/setTitle 为单向通知。
- 由扩展命令或 input hook 完全处理的 prompt 只回 ack，不启动运行、不发 agent_settled；全部工具返回 terminate 时最终 stopReason 为 toolUse。
- 会话文件在第一条助手消息后才创建；`--session-id` 可提供确定身份（推断）。无内置 MCP、子 Agent、后台任务与计划。

## 局限

- 结论来自代码与 schema 阅读；运行时交错、真实帧大小、Windows 行为均未观察。
- Codex 实验能力的形状取自同版本上游实验 schema 导出，本机二进制只核对了方法名。
- OpenClaw 工具事件不到达、OpenCode 未捕获拒绝、Claude 清空上下文后的恢复目标等标为推断，需要真实工具任务核实。
