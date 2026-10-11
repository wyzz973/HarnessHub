# 逐Harness原生能力矩阵

生成自 plan/native-capabilities.json；使用 python3 tools/check_design.py --write 更新。设计检查要求每个Harness覆盖全部能力项，完整（✅）必须同时满足原接口具备、Hub契约/执行/界面已接出、协议测试通过和本机原安装真实验收通过；其余状态均不算完整接入。

图例：✅ 完整；◐ 已接出并通过协议测试，真实原安装未验收；◑ 部分接出；○ 原接口具备但Hub未接出；✕ 真实验收失败或受阻；— 原接口不提供；？ 未核实。

| 分组 | 能力 | Codex | Claude Code | OpenCode | OpenClaw | Gemini CLI | Cursor | Pi |
|---|---|---|---|---|---|---|---|---|
| 配置与模型 | 模型目录与选择 | ✅ | ✕ | ◐ | ✅ | ✕ | ◑ | ✅ |
| 配置与模型 | 思考档位 | ✅ | ✕ | ◐ | ✅ | — | ○ | ✅ |
| 配置与模型 | 模式与原生设置 | ○ | ✕ | ◐ | ◐ | ✕ | ◐ | — |
| 配置与模型 | 原生命令目录与执行 | — | ✕ | ◐ | ◐ | ✕ | ◐ | ◐ |
| 配置与模型 | 原生命令改配置后的同步 | ○ | ○ | ？ | ○ | ？ | ○ | ○ |
| 执行可见性 | 思考输出 | ◐ | ✕ | ◐ | ◐ | ✕ | ✕ | ◐ |
| 执行可见性 | 工具状态 | ◐ | ✕ | ◐ | ◐ | ✕ | ✕ | ◐ |
| 执行可见性 | 工具输入/输出/差异 | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| 执行可见性 | 计划 | ○ | ○ | — | — | — | ○ | — |
| 执行可见性 | 用量/上下文/费用 | ○ | ○ | ○ | ○ | ○ | — | ○ |
| 交互 | 工具审批 | ◐ | ✕ | ◐ | ○ | ✕ | ✕ | ◐ |
| 交互 | 原生提问与表单 | ◑ | ○ | ？ | — | ？ | ◑ | ◐ |
| 输入输出 | 图片输入 | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| 输入输出 | 音频输入 | ○ | — | — | — | ○ | — | — |
| 输入输出 | 文件/文档输入 | ○ | ○ | ○ | ○ | ○ | ○ | — |
| 输入输出 | 非文本输出 | ○ | ○ | ○ | — | — | ○ | ○ |
| 扩展 | Skills | ○ | ◑ | ◑ | ◑ | ？ | ◑ | ◑ |
| 扩展 | MCP | ◑ | ◑ | ◑ | — | ◑ | ◑ | — |
| 扩展 | 插件/扩展 | ◑ | ◑ | ◑ | ○ | ◑ | ？ | ◑ |
| 会话 | 原生会话恢复 | ✅ | ✕ | ✅ | ✅ | ✕ | ✕ | ✅ |
| 会话 | 原生会话列表/接续 | ○ | ○ | ○ | ○ | — | ○ | — |
| 会话 | 原生分支 | ○ | ○ | ○ | — | — | — | ○ |
| 会话 | 上下文压缩 | ○ | ◑ | ◑ | ◑ | — | ？ | ○ |
| 会话 | 回滚/回退 | ○ | — | ？ | — | ○ | — | ○ |
| 并发与后台 | 子 Agent | ◑ | ○ | ○ | ○ | ？ | ○ | — |
| 并发与后台 | 后台任务 | ○ | ○ | ？ | ○ | ？ | ？ | — |
| 产物 | 导出与产物 | ○ | ○ | ？ | ○ | ？ | — | ○ |

| Harness | ✅ | ◐ | ◑ | ○ | ✕ | — | ？ |
|---|---|---|---|---|---|---|---|
| Codex | 3 | 3 | 4 | 16 | 0 | 1 | 0 |
| Claude Code | 0 | 0 | 4 | 13 | 8 | 2 | 0 |
| OpenCode | 1 | 7 | 4 | 8 | 0 | 2 | 5 |
| OpenClaw | 3 | 4 | 2 | 11 | 0 | 7 | 0 |
| Gemini CLI | 0 | 0 | 2 | 6 | 7 | 6 | 6 |
| Cursor | 0 | 2 | 4 | 9 | 4 | 5 | 3 |
| Pi | 3 | 5 | 2 | 9 | 0 | 8 | 0 |

## Codex

原安装：Codex CLI 0.162.1（Homebrew cask，本机 ChatGPT 登录）；控制入口：codex-app-server。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | model/list、config/read、thread/start.model（0.162.1 schema） | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/cc-native-catalog.json；docs/verification/native-models-2026-10-11.md | 默认 gpt-6.1-sol；目录 7 个模型 |
| 思考档位 | 具备 | Model.supportedReasoningEfforts、turn/start.effort | 已接出 | 通过 | 通过 | .tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | low 档真实使用 |
| 模式与原生设置 | 具备 | approvalPolicy/sandboxPolicy/serviceTier 逐轮参数；collaborationMode 计划模式需 experimentalApi | 未接出 | 未接出 | 未接出 | — | Hub 未接出审批/沙箱/计划模式设置 |
| 原生命令目录与执行 | 不提供 | app-server 无斜杠命令；skills 以 UserInput.skill 调用（见 Skills） | 不适用 | 不适用 | 不适用 | — | — |
| 原生命令改配置后的同步 | 部分 | model/rerouted 通知会改变实际模型；无命令式配置修改 | 未接出 | 未接出 | 未接出 | — | Hub 未记录改路由 |
| 思考输出 | 具备 | item/reasoning/summaryTextDelta、textDelta | 已接出 | 通过 | 未接出 | — | 协议测试覆盖；真实思考输出未单独验收 |
| 工具状态 | 具备 | item/started\|completed 的 commandExecution/fileChange/mcpToolCall/webSearch 等 | 已接出 | 通过 | 未接出 | — | 真实工具调用未验收 |
| 工具输入/输出/差异 | 具备 | commandExecution.aggregatedOutput/exitCode、fileChange.changes[].diff、mcpToolCall 参数与结果、turn/diff/updated | 未接出 | 未接出 | 未接出 | — | 当前仅保留 id/标题/状态 |
| 计划 | 具备 | turn/plan/updated {explanation, plan[{step,status}]} | 未接出 | 未接出 | 未接出 | — | — |
| 用量/上下文/费用 | 具备 | thread/tokenUsage/updated {total,last,modelContextWindow}、account/rateLimits/updated | 未接出 | 未接出 | 未接出 | — | — |
| 工具审批 | 具备 | item/commandExecution\|fileChange/requestApproval；子 Agent 线程审批归属当前回合 | 已接出 | 通过 | 未接出 | — | item/permissions/requestApproval、策略修订决定尚未接出 |
| 原生提问与表单 | 具备 | item/tool/requestUserInput、mcpServer/elicitation/request | 部分 | 通过 | 未接出 | — | requestUserInput 已接出；MCP elicitation 仍被 -32601 拒绝 |
| 图片输入 | 具备 | UserInput.image(data URL)/localImage；Model.inputModalities | 未接出 | 未接出 | 未接出 | — | — |
| 音频输入 | 部分 | UserInput.audio/localAudio，仅 inputModalities 含 audio 的模型 | 未接出 | 未接出 | 未接出 | — | — |
| 文件/文档输入 | 部分 | 无 file 输入类型；仅 localImage/localAudio/mention(app/plugin) 与文本路径 | 未接出 | 未接出 | 未接出 | — | — |
| 非文本输出 | 部分 | imageGeneration.savedPath、imageView.path | 未接出 | 未接出 | 未接出 | — | — |
| Skills | 具备 | skills/list、UserInput.skill | 未接出 | 未接出 | 未接出 | — | — |
| MCP | 具备 | 用户 MCP 按原配置加载；mcpServerStatus/list、mcpServer/oauth/login | 部分 | 未接出 | 未接出 | — | 原程序加载；Hub 无状态/登录界面 |
| 插件/扩展 | 具备 | plugin/list\|install、app/list | 部分 | 未接出 | 未接出 | — | 原程序按配置加载；Hub 无管理界面 |
| 原生会话恢复 | 具备 | thread/resume(excludeTurns)；跨 Hub 进程重启 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；docs/verification/complete-native-capabilities-2026-10-11.md | — |
| 原生会话列表/接续 | 具备 | thread/list、thread/read、thread/turns/list | 未接出 | 未接出 | 未接出 | — | — |
| 原生分支 | 具备 | thread/fork {lastTurnId} | 未接出 | 未接出 | 未接出 | — | — |
| 上下文压缩 | 具备 | thread/compact/start → contextCompaction item | 未接出 | 未接出 | 未接出 | — | — |
| 回滚/回退 | 具备 | thread/revert {beforeTurnId}（只回退历史，不回退文件） | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 具备 | collabAgentToolCall、subAgentActivity；子线程自动附着连接 | 部分 | 通过 | 未接出 | — | 子线程输出不再中断回合、审批交给用户；子 Agent 活动尚未展示 |
| 后台任务 | 具备 | command/exec；后台终端 thread/backgroundTerminals/* 需 experimentalApi | 未接出 | 未接出 | 未接出 | — | 每轮关闭控制进程，需长期资源所有者设计 |
| 导出与产物 | 具备 | thread/read(includeTurns)、Thread.path rollout 路径 | 未接出 | 未接出 | 未接出 | — | — |

## Claude Code

原安装：Claude Code 2.1.296 + claude-agent-acp 0.89.1（本机登录）；控制入口：acp-v1（claude-agent-acp）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | configOptions category=model（含别名） | 已接出 | 通过 | 受阻 | .tmp/cc-native-catalog.json | Claude 账号周额度用完，真实生成无法验收；目录真实读取 13 个模型 |
| 思考档位 | 具备 | configOptions effort(thought_level) | 已接出 | 通过 | 受阻 | .tmp/cc-native-catalog.json | Claude 账号周额度用完，真实生成无法验收 |
| 模式与原生设置 | 具备 | mode(default/acceptEdits/plan/auto/bypassPermissions)、fast、agent | 已接出 | 通过 | 受阻 | .tmp/cc-native-catalog.json | Claude 账号周额度用完，真实生成无法验收 |
| 原生命令目录与执行 | 具备 | available_commands_update（内置、自定义、skills、插件、MCP prompt），/compact /model 等原生处理 | 已接出 | 通过 | 受阻 | .tmp/cc-native-catalog.json | Claude 账号周额度用完，真实生成无法验收；目录真实读取 223 条命令 |
| 原生命令改配置后的同步 | 具备 | /model、ExitPlanMode、回退模型后发送 config_option_update/current_mode_update | 未接出 | 未接出 | 未接出 | — | Hub 尚未把原生变化同步到界面与下一轮选择 |
| 思考输出 | 具备 | agent_thought_chunk（新模型可能只有签名不出文本） | 已接出 | 通过 | 受阻 | — | Claude 账号周额度用完，真实生成无法验收 |
| 工具状态 | 具备 | tool_call/tool_call_update | 已接出 | 通过 | 受阻 | — | Claude 账号周额度用完，真实生成无法验收 |
| 工具输入/输出/差异 | 具备 | kind、content(diff/console)、locations、rawInput/rawOutput、_meta.claudeCode.toolResponse | 未接出 | 未接出 | 未接出 | — | — |
| 计划 | 具备 | plan 全量快照（TodoWrite/Task*） | 未接出 | 未接出 | 未接出 | — | — |
| 用量/上下文/费用 | 具备 | usage_update {used,size,cost USD}、PromptResponse.usage | 未接出 | 未接出 | 未接出 | — | — |
| 工具审批 | 具备 | session/request_permission（allow_once/allow_always/reject_once，ExitPlanMode 选项） | 已接出 | 通过 | 受阻 | — | Claude 账号周额度用完，真实生成无法验收；allow_always 会由原程序写入项目设置 |
| 原生提问与表单 | 具备 | AskUserQuestion/MCP 表单经 elicitation/create，需客户端声明 elicitation.form | 未接出 | 未接出 | 未接出 | — | 未声明能力时原程序禁用 AskUserQuestion |
| 图片输入 | 具备 | promptCapabilities.image；image block base64 | 未接出 | 未接出 | 未接出 | — | — |
| 音频输入 | 不提供 | 未声明 audio，音频块被静默丢弃 | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | 文本 resource 以 <context> 注入；blob 被丢弃；resource_link 只成链接文本 | 未接出 | 未接出 | 未接出 | — | — |
| 非文本输出 | 部分 | assistant 图片块（少见）与工具结果中的图片 | 未接出 | 未接出 | 未接出 | — | — |
| Skills | 具备 | skills 出现在原生命令目录并按原配置加载 | 部分 | 通过 | 未接出 | — | 通过原生命令执行；无独立技能管理界面 |
| MCP | 具备 | 用户/项目/插件 MCP 默认加载；MCP OAuth 需 elicitation.url | 部分 | 未接出 | 未接出 | — | 原程序加载；Hub 无状态/OAuth 界面 |
| 插件/扩展 | 具备 | 已启用插件、hooks 按 settingSources 加载 | 部分 | 未接出 | 未接出 | — | 原程序加载；Hub 无管理界面 |
| 原生会话恢复 | 具备 | session/resume（不回放） | 已接出 | 通过 | 受阻 | — | Claude 账号周额度用完，真实生成无法验收 |
| 原生会话列表/接续 | 具备 | session/list（含 CLI/TUI 创建的会话） | 未接出 | 未接出 | 未接出 | — | — |
| 原生分支 | 具备 | session/fork 复制转录后需 resume | 未接出 | 未接出 | 未接出 | — | — |
| 上下文压缩 | 具备 | /compact 触发原生压缩；compaction_update 需 session.compaction 能力 | 部分 | 未接出 | 未接出 | — | 可经原生命令执行；压缩过程未展示 |
| 回滚/回退 | 不提供 | 非 JetBrains AIR 客户端无指定消息回退 | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 具备 | 子会话 subagent_spawned/state_update 需 subagents 能力；否则工具带 parentToolUseId | 未接出 | 未接出 | 未接出 | — | — |
| 后台任务 | 具备 | 后台 shell 与自主后续回合；async_task_* 仅 AIR | 未接出 | 未接出 | 未接出 | — | 每轮关闭进程会终止后台任务 |
| 导出与产物 | 部分 | 转录在本机磁盘；ACP 无导出方法 | 未接出 | 未接出 | 未接出 | — | — |

## OpenCode

原安装：OpenCode 1.18.35（Homebrew，本机原配置）；控制入口：acp-v1（opencode acp）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | configOptions model(provider/model) | 已接出 | 通过 | 部分通过 | docs/verification/native-models-2026-10-11.md；.tmp/cc-native-resume-batch1.json | 默认 opencode/big-pickle 真实生成；原生接口选择 opencode/exo-free 已生效但未生成 |
| 思考档位 | 具备 | configOptions effort（仅模型有 variants 时） | 已接出 | 通过 | 未接出 | — | 默认模型无档位，未真实验收 |
| 模式与原生设置 | 具备 | configOptions mode(build/plan) | 已接出 | 通过 | 未接出 | — | 未真实验收 |
| 原生命令目录与执行 | 具备 | available_commands_update（init/review、配置命令、MCP prompt、skills） | 已接出 | 通过 | 未接出 | — | 目录真实读取 104 条；执行未验收；未知 / 开头文本会被原程序丢弃 |
| 原生命令改配置后的同步 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 思考输出 | 具备 | agent_thought_chunk | 已接出 | 通过 | 未接出 | — | 未真实验收 |
| 工具状态 | 具备 | tool_call/tool_call_update | 已接出 | 通过 | 未接出 | — | 未真实验收 |
| 工具输入/输出/差异 | 具备 | rawInput/rawOutput、diff、图片附件 | 未接出 | 未接出 | 未接出 | — | — |
| 计划 | 不提供 | 不发送 plan 更新 | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 具备 | 每轮 usage_update {used,size,cost}、PromptResponse.usage | 未接出 | 未接出 | 未接出 | — | — |
| 工具审批 | 具备 | session/request_permission(once/always/reject) | 已接出 | 通过 | 未接出 | — | 批准编辑后原程序会无条件发 fs/write_text_file，需真实工具任务核实 |
| 原生提问与表单 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 图片输入 | 具备 | promptCapabilities.image | 未接出 | 未接出 | 未接出 | — | — |
| 音频输入 | 不提供 | 未声明 audio | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 具备 | promptCapabilities.embeddedContext | 未接出 | 未接出 | 未接出 | — | — |
| 非文本输出 | 部分 | 工具结果中的图片附件；回放中的图片/资源 | 未接出 | 未接出 | 未接出 | — | — |
| Skills | 具备 | skills 出现在原生命令目录 | 部分 | 通过 | 未接出 | — | 通过原生命令执行 |
| MCP | 具备 | 用户 MCP 配置按原程序加载 | 部分 | 未接出 | 未接出 | — | 原程序加载；Hub 无状态界面 |
| 插件/扩展 | 具备 | 插件按原配置加载 | 部分 | 未接出 | 未接出 | — | 原程序加载；Hub 无管理界面 |
| 原生会话恢复 | 具备 | session/resume（不回放）；跨 Hub 进程重启 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/cc-opencode-native-resume.json | — |
| 原生会话列表/接续 | 具备 | session/list | 未接出 | 未接出 | 未接出 | — | — |
| 原生分支 | 具备 | session/fork | 未接出 | 未接出 | 未接出 | — | — |
| 上下文压缩 | 具备 | /compact 原生命令 | 部分 | 未接出 | 未接出 | — | 可经原生命令执行 |
| 回滚/回退 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 具备 | 子会话（task 子 Agent）权限请求 | 未接出 | 未接出 | 未接出 | — | 子会话权限请求当前无人应答 |
| 后台任务 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |

## OpenClaw

原安装：OpenClaw 2026.3.23-2（npm 全局，原 Gateway 守护进程）；控制入口：acp-v1（openclaw acp）+ gateway call。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | gateway models.list + sessions.patch（只改 Hub 自己的会话键） | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | deepseek/deepseek-chat |
| 思考档位 | 具备 | configOptions thought_level | 已接出 | 通过 | 通过 | .tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | low 档真实使用 |
| 模式与原生设置 | 具备 | fast_mode/verbose_level/reasoning_level/response_usage/elevated_level | 已接出 | 通过 | 部分通过 | .tmp/native-complete-real-combined.json | 仅思考档位真实使用；__mode 与思考档位重复 |
| 原生命令目录与执行 | 具备 | 固定 27 条命令（缺 /fast /exec /approve 等） | 已接出 | 通过 | 未接出 | — | 命令执行未真实验收 |
| 原生命令改配置后的同步 | 部分 | 斜杠命令修改 Gateway 会话设置，但 ACP 桥不推送 config_option_update | 未接出 | 未接出 | 未接出 | — | — |
| 思考输出 | 部分 | ACP 桥不实时转发思考，仅 load 回放 | 已接出 | 通过 | 未接出 | — | 需直连 Gateway agent 事件 |
| 工具状态 | 部分 | 桥未声明 tool-events，工具事件很可能不会到达 | 已接出 | 通过 | 未接出 | — | 需直连 Gateway 才能获得工具事件 |
| 工具输入/输出/差异 | 部分 | Gateway agent 事件含工具输入输出（需 tool-events 与 verbose=full） | 未接出 | 未接出 | 未接出 | — | — |
| 计划 | 不提供 | 桥从不发送 plan | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 部分 | usage_update 近似 {used,size}，无费用；sessions.list 含 token/估算费用 | 未接出 | 未接出 | 未接出 | — | — |
| 工具审批 | 部分 | exec.approval.* 只走 Gateway RPC/事件；经 ACP 会静默等待约 120 秒后拒绝 | 未接出 | 未接出 | 未接出 | — | — |
| 原生提问与表单 | 不提供 | ACP 桥不发送提问 | 不适用 | 不适用 | 不适用 | — | — |
| 图片输入 | 具备 | image block → chat.send attachment（≤5 MB） | 未接出 | 未接出 | 未接出 | — | — |
| 音频输入 | 不提供 | 音频块被丢弃 | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | 文本 resource 追加为文本；blob 丢弃；resource_link 成文本 | 未接出 | 未接出 | 未接出 | — | — |
| 非文本输出 | 不提供 | 桥不转发图片/媒体；MEDIA: 行以原文出现 | 不适用 | 不适用 | 不适用 | — | — |
| Skills | 具备 | Gateway skills.status 与技能命令 | 部分 | 未接出 | 未接出 | — | 可经原生命令触发 |
| MCP | 不提供 | ACP 桥不使用 mcpServers | 不适用 | 不适用 | 不适用 | — | — |
| 插件/扩展 | 部分 | Gateway tools.catalog/skills；无插件管理接口 | 未接出 | 未接出 | 未接出 | — | — |
| 原生会话恢复 | 具备 | session/load + Hub 自有会话键 requireExistingSession | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | — |
| 原生会话列表/接续 | 部分 | session/list 声明但桥实际 Method not found；gateway sessions.list 可用 | 未接出 | 未接出 | 未接出 | — | — |
| 原生分支 | 不提供 | 无原生分支 | 不适用 | 不适用 | 不适用 | — | — |
| 上下文压缩 | 具备 | /compact 文本命令（sessions.compact 只截断） | 部分 | 未接出 | 未接出 | — | 可经原生命令执行 |
| 回滚/回退 | 不提供 | 无回退 | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 部分 | sessions_spawn 子会话在桥中不可见 | 未接出 | 未接出 | 未接出 | — | — |
| 后台任务 | 部分 | 后台 exec、cron 在回合结束后继续，需 Gateway 订阅观察 | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 部分 | gateway chat.history / sessions.get | 未接出 | 未接出 | 未接出 | — | — |

## Gemini CLI

原安装：Gemini CLI 0.62.0（Homebrew，个人账号）；控制入口：acp-v1（gemini --acp）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | 旧式 models + session/set_model | 已接出 | 通过 | 受阻 | .tmp/cc-native-catalog.json | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 思考档位 | 不提供 | 无思考档位配置 | 不适用 | 不适用 | 不适用 | — | — |
| 模式与原生设置 | 具备 | 旧式 modes(default/autoEdit/yolo/plan) + session/set_mode | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻；set_mode 会在无 prompt 时发文本块，已改为不中断连接 |
| 原生命令目录与执行 | 具备 | available_commands_update（memory/extensions/init/restore 等） | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 原生命令改配置后的同步 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 思考输出 | 具备 | agent_thought_chunk | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 工具状态 | 具备 | tool_call/tool_call_update | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 工具输入/输出/差异 | 部分 | kind、locations、全文件 diff；无 raw 输入输出 | 未接出 | 未接出 | 未接出 | — | — |
| 计划 | 不提供 | 不发送 plan | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 部分 | 仅 PromptResponse._meta.quota | 未接出 | 未接出 | 未接出 | — | — |
| 工具审批 | 具备 | session/request_permission(allow always/once/reject) | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 原生提问与表单 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 图片输入 | 具备 | promptCapabilities.image | 未接出 | 未接出 | 未接出 | — | — |
| 音频输入 | 具备 | promptCapabilities.audio | 未接出 | 未接出 | 未接出 | — | — |
| 文件/文档输入 | 具备 | promptCapabilities.embeddedContext | 未接出 | 未接出 | 未接出 | — | — |
| 非文本输出 | 不提供 | 只输出文本块 | 不适用 | 不适用 | 不适用 | — | — |
| Skills | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| MCP | 具备 | 用户 MCP/扩展按原配置加载 | 部分 | 未接出 | 未接出 | — | 原程序加载 |
| 插件/扩展 | 具备 | Gemini 扩展按原配置加载 | 部分 | 未接出 | 未接出 | — | 原程序加载 |
| 原生会话恢复 | 具备 | session/load（响应后继续流式回放，已加静默窗口） | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 原生会话列表/接续 | 不提供 | 无 session/list | 不适用 | 不适用 | 不适用 | — | — |
| 原生分支 | 不提供 | 无 fork | 不适用 | 不适用 | 不适用 | — | — |
| 上下文压缩 | 不提供 | ACP 下 /compress 不可用 | 不适用 | 不适用 | 不适用 | — | — |
| 回滚/回退 | 部分 | /restore 检查点（文件恢复） | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 后台任务 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |

## Cursor

原安装：Cursor Agent 2026.10.01-e373342（官方安装，原 ~/.cursor 登录）；控制入口：acp-v1（cursor-agent acp）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 部分 | 模型 config option 会写入全局 cli-config selectedModel | 部分 | 通过 | 部分通过 | .tmp/cc-native-catalog-cursor.json；docs/verification/native-capabilities-round2-2026-10-11.md | 目录真实读取 44 个模型；Hub 只读展示，不代为执行全局切换 |
| 思考档位 | 部分 | 仅客户端声明 parameterizedModelPicker 时出现 thought_level，且随模型全局保存 | 未接出 | 未接出 | 未接出 | — | — |
| 模式与原生设置 | 具备 | mode(agent/plan/ask) 会话级 set_config_option | 已接出 | 通过 | 未接出 | — | 未真实验收 |
| 原生命令目录与执行 | 具备 | copy-request-id、自定义命令、skills | 已接出 | 通过 | 未接出 | — | 执行未验收 |
| 原生命令改配置后的同步 | 部分 | current_mode_update | 未接出 | 未接出 | 未接出 | — | — |
| 思考输出 | 具备 | agent_thought_chunk | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 工具状态 | 具备 | tool_call/tool_call_update（失败工具仍报告 completed） | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 工具输入/输出/差异 | 具备 | rawInput/rawOutput、diff、locations | 未接出 | 未接出 | 未接出 | — | — |
| 计划 | 具备 | plan（create_plan） | 未接出 | 未接出 | 未接出 | — | — |
| 用量/上下文/费用 | 不提供 | 不提供用量 | 不适用 | 不适用 | 不适用 | — | — |
| 工具审批 | 具备 | session/request_permission(allow-once/allow-always/reject-once) | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 原生提问与表单 | 部分 | cursor/ask_question 扩展请求；-32601 时退化为权限选项 | 部分 | 通过 | 未接出 | — | 经权限选项呈现 |
| 图片输入 | 具备 | promptCapabilities.image | 未接出 | 未接出 | 未接出 | — | — |
| 音频输入 | 不提供 | 未声明 audio | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | resource 文本内联（≤20000 字）；项目根内 resource_link 读取 | 未接出 | 未接出 | 未接出 | — | — |
| 非文本输出 | 部分 | cursor/generate_image 扩展请求 | 未接出 | 未接出 | 未接出 | — | — |
| Skills | 具备 | skills 出现在原生命令目录 | 部分 | 通过 | 未接出 | — | 通过原生命令执行 |
| MCP | 具备 | ~/.cursor/mcp.json 与项目 mcp.json；本轮修复后才按原配置目录加载 | 部分 | 未接出 | 未接出 | — | 原程序加载 |
| 插件/扩展 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 原生会话恢复 | 具备 | session/load（完整回放） | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 原生会话列表/接续 | 具备 | session/list（unstable，无分页） | 未接出 | 未接出 | 未接出 | — | — |
| 原生分支 | 不提供 | fork 路由未实现 | 不适用 | 不适用 | 不适用 | — | — |
| 上下文压缩 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 回滚/回退 | 不提供 | 无回退 | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 具备 | subagent_spawned/state_update 需 subagents 能力 | 未接出 | 未接出 | 未接出 | — | — |
| 后台任务 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 不提供 | 无导出接口 | 不适用 | 不适用 | 不适用 | — | — |

## Pi

原安装：Pi 0.85.1（本机开发安装）；控制入口：pi-rpc（pi --mode rpc）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | get_available_models、--provider/--model 启动参数 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1-pi.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | deepseek/deepseek-flash；用户默认 harnesshub 提供方指向未运行的 127.0.0.1:3180 |
| 思考档位 | 具备 | get_available_thinking_levels + Model.reasoning/thinkingLevelMap、set_thinking_level（会话级） | 已接出 | 通过 | 通过 | .tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | low 档真实使用；本轮改为不加载 Pi 内部 JS |
| 模式与原生设置 | 不提供 | 无会话级模式；steering/follow-up/自动压缩设置会写全局 settings.json | 不适用 | 不适用 | 不适用 | — | — |
| 原生命令目录与执行 | 具备 | get_commands（extension/prompt/skill）；内置 TUI 命令不可用 | 已接出 | 通过 | 未接出 | — | 扩展命令无运行时已按原生状态结算；执行未真实验收 |
| 原生命令改配置后的同步 | 部分 | thinking_level_changed 事件；扩展可改模型 | 未接出 | 未接出 | 未接出 | — | — |
| 思考输出 | 具备 | message_update thinking_delta | 已接出 | 通过 | 未接出 | — | 未真实验收 |
| 工具状态 | 具备 | tool_execution_start/end | 已接出 | 通过 | 未接出 | — | 未真实验收 |
| 工具输入/输出/差异 | 具备 | tool_execution_start.args、update.partialResult、end.result.content/details(diff/patch) | 未接出 | 未接出 | 未接出 | — | — |
| 计划 | 不提供 | 无原生计划 | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 具备 | assistant message usage{input,output,cacheRead,cacheWrite,cost}、get_session_stats | 未接出 | 未接出 | 未接出 | — | — |
| 工具审批 | 部分 | 无内置审批；扩展经 extension_ui confirm/select 拦截工具 | 已接出 | 通过 | 未接出 | — | 由扩展决定是否出现 |
| 原生提问与表单 | 具备 | extension_ui select/confirm/input/editor（含超时） | 已接出 | 通过 | 未接出 | — | 编辑器字段与超时已按 0.85.1 修正；未真实验收 |
| 图片输入 | 具备 | prompt.images[{data,mimeType}]，按 Model.input 门控 | 未接出 | 未接出 | 未接出 | — | — |
| 音频输入 | 不提供 | 无音频输入 | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 不提供 | RPC 不支持 @file 附件 | 不适用 | 不适用 | 不适用 | — | — |
| 非文本输出 | 部分 | read 工具返回的图片内容 | 未接出 | 未接出 | 未接出 | — | — |
| Skills | 具备 | /skill:name 经 prompt 展开 | 部分 | 通过 | 未接出 | — | 通过原生命令执行 |
| MCP | 不提供 | 无内置 MCP（仅扩展） | 不适用 | 不适用 | 不适用 | — | — |
| 插件/扩展 | 具备 | extensions/packages 按原配置加载（项目资源需信任） | 部分 | 未接出 | 未接出 | — | 原程序加载 |
| 原生会话恢复 | 具备 | --session 原会话文件 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1-pi.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | 首个助手消息前恢复仍会失败（原程序延迟创建文件） |
| 原生会话列表/接续 | 不提供 | RPC 无会话列表 | 不适用 | 不适用 | 不适用 | — | — |
| 原生分支 | 具备 | fork {entryId}、clone、get_fork_messages | 未接出 | 未接出 | 未接出 | — | — |
| 上下文压缩 | 具备 | compact {customInstructions} | 未接出 | 未接出 | 未接出 | — | — |
| 回滚/回退 | 部分 | 从用户消息 fork；原地树导航仅 TUI | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 不提供 | 无内置子 Agent（仅扩展工具） | 不适用 | 不适用 | 不适用 | — | — |
| 后台任务 | 不提供 | 无内置后台任务 | 不适用 | 不适用 | 不适用 | — | — |
| 导出与产物 | 具备 | export_html {outputPath} | 未接出 | 未接出 | 未接出 | — | — |
