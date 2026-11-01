# 逐Harness原生能力矩阵

生成自 plan/native-capabilities.json；使用 python3 tools/check_design.py --write 更新。设计检查要求每个Harness覆盖全部能力项，完整（✅）必须同时满足原接口具备、Hub契约/执行/界面已接出、协议测试通过和本机原安装真实验收通过；原接口只部分提供时，后三项同样满足且说明写明原接口缺什么的格记为 ☑（Hub 已尽，按 ADR-048 计为终态）；其余状态均不算完整接入。

图例：✅ 完整；☑ 原接口部分提供，Hub 已尽；◐ 已接出并通过协议测试，真实原安装未验收；◑ 部分接出；○ 原接口具备但Hub未接出；✕ 真实验收失败或受阻；— 原接口不提供；？ 未核实。

列名后的（冻结）表示该 Harness 已冻结（tier=frozen，ADR-046 第 6 项与 ADR-048 决定 1）：不再新增 ✅，设计检查拒绝 ✅ 数超过冻结时的 complete_at_freeze；（历史）表示原安装不是官网渠道，证据按 ADR-044 为历史，不计入摘要的 native_capabilities_complete_official。

证据中的 .tmp/ 路径相对于主检出 HarnessGateway（本机运行服务的检出），该目录被忽略、不入库，只作补充：真实验收为通过或部分通过的格至少有一项仓库内证据，可复核的命令、版本、结果与局限写在 docs/verification/ 的验收记录中。

| 分组 | 能力 | Codex | Claude Code | OpenCode | OpenClaw | Gemini CLI（冻结） | Cursor（冻结） | Pi（冻结、历史） | Hermes Agent | DeepSeek Harness |
|---|---|---|---|---|---|---|---|---|---|---|
| 配置与模型 | 模型目录与选择 | ✅ | ✅ | ◐ | ✅ | ✕ | ◑ | ✅ | ✅ | ✅ |
| 配置与模型 | 思考档位 | ✅ | ✅ | ✕ | ✅ | — | ○ | ✅ | — | ✅ |
| 配置与模型 | 模式与原生设置 | ◑ | ✅ | ✅ | ◐ | ✕ | ◐ | — | ◑ | — |
| 配置与模型 | 原生命令目录与执行 | — | ✅ | ✅ | ✅ | ✕ | ◐ | ◐ | ✅ | — |
| 配置与模型 | 原生命令改配置后的同步 | ◑ | ✅ | ？ | ☑ | ？ | ✕ | ✕ | ✕ | — |
| 执行可见性 | 思考输出 | ◐ | ✕ | ✅ | ✕ | ✕ | ✕ | ✅ | ✅ | ✅ |
| 执行可见性 | 工具状态 | ✅ | ✅ | ✅ | ◑ | ✕ | ✕ | ✅ | ✅ | ✅ |
| 执行可见性 | 工具输入/输出/差异 | ✅ | ✅ | ✅ | ◑ | ✕ | ✕ | ✅ | ◐ | ☑ |
| 执行可见性 | 计划 | ✕ | ✕ | — | — | — | ✕ | — | ○ | — |
| 执行可见性 | 用量/上下文/费用 | ✅ | ✅ | ✅ | ☑ | ✕ | — | ✅ | ✅ | ☑ |
| 交互 | 工具审批 | ✅ | ✅ | ✅ | ○ | ✕ | ✕ | ◐ | ✅ | ✕ |
| 交互 | 原生提问与表单 | ◑ | ✅ | ？ | — | ？ | ◑ | ◐ | — | — |
| 输入输出 | 图片输入 | ✅ | ✅ | ✅ | ✕ | ✕ | ✕ | ✅ | ✕ | ✕ |
| 输入输出 | 音频输入 | ✕ | — | — | — | ✕ | — | — | — | — |
| 输入输出 | 文件/文档输入 | ☑ | ☑ | ✅ | ☑ | ✕ | ✕ | ☑ | ☑ | ✅ |
| 输入输出 | 非文本输出 | ◐ | ◐ | ◐ | — | — | ✕ | ○ | — | ◐ |
| 扩展 | Skills | ✅ | ◑ | ◑ | ◑ | ？ | ◑ | ◐ | ○ | ○ |
| 扩展 | MCP | ◑ | ◑ | ◑ | ○ | ◑ | ◑ | — | ○ | ○ |
| 扩展 | 插件/扩展 | ◑ | ◑ | ◑ | ◑ | ◑ | ？ | ◑ | ○ | ○ |
| 会话 | 原生会话恢复 | ✅ | ✅ | ✅ | ✅ | ✕ | ✕ | ✅ | ✅ | ✅ |
| 会话 | 原生会话列表/接续 | ✅ | ✅ | ✅ | ○ | — | ✕ | — | ✕ | ✅ |
| 会话 | 原生分支 | ✅ | ✅ | ✅ | — | — | — | ✅ | ✅ | — |
| 会话 | 上下文压缩 | ✅ | ✅ | ✅ | ✅ | — | ？ | ✅ | ◐ | ○ |
| 会话 | 回滚/回退 | ○ | — | ？ | — | ○ | — | ○ | — | — |
| 并发与后台 | 子 Agent | ✅ | ✅ | ○ | ◑ | ？ | ○ | — | ◑ | ◑ |
| 并发与后台 | 后台任务 | ◐ | ✅ | ？ | ○ | ？ | ？ | — | ◐ | ◐ |
| 产物 | 导出与产物 | ✅ | ☑ | ？ | ○ | ？ | — | ✅ | ✅ | ○ |

| Harness | ✅ | ☑ | ◐ | ◑ | ○ | ✕ | — | ？ |
|---|---|---|---|---|---|---|---|---|
| Codex | 14 | 1 | 3 | 5 | 1 | 2 | 1 | 0 |
| Claude Code | 17 | 2 | 1 | 3 | 0 | 2 | 2 | 0 |
| OpenCode | 13 | 0 | 2 | 3 | 1 | 1 | 2 | 5 |
| OpenClaw | 5 | 3 | 1 | 5 | 5 | 2 | 6 | 0 |
| Gemini CLI（冻结） | 0 | 0 | 0 | 2 | 1 | 12 | 6 | 6 |
| Cursor（冻结） | 0 | 0 | 2 | 4 | 2 | 11 | 5 | 3 |
| Pi（冻结、历史） | 11 | 1 | 4 | 1 | 2 | 1 | 7 | 0 |
| Hermes Agent | 9 | 1 | 3 | 2 | 4 | 3 | 5 | 0 |
| DeepSeek Harness | 7 | 2 | 2 | 1 | 5 | 2 | 8 | 0 |

## Codex

原安装：Codex CLI 真实验收版本 0.166.0（Homebrew cask，本机 ChatGPT 登录；2026-11-01 之前：0.162.1；版本只作证据（ADR-053））；控制入口：codex-app-server；分层：焦点。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | model/list、config/read、thread/start.model（0.162.1 schema） | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/cc-native-catalog.json；docs/verification/native-models-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 默认 gpt-6.1-sol；目录 7 个模型 |
| 思考档位 | 具备 | Model.supportedReasoningEfforts、turn/start.effort | 已接出 | 通过 | 通过 | .tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | low 档真实使用 |
| 模式与原生设置 | 具备 | approvalPolicy/sandboxPolicy/serviceTier 逐轮参数；collaborationMode 计划模式需 experimentalApi（按连接声明） | 部分 | 通过 | 通过 | .tmp/cc-native-activity-codex-approval.json；docs/verification/native-session-actions-2026-10-11.md；.tmp/cc-codex-plan-2026-10-12.json；docs/decisions/0034-codex-plan-mode.md；docs/verification/codex-latest-2026-11-01.md | 审批策略与沙箱作为本 Hub 线程设置接出（取自原配置、由线程回报核实、不写 config.toml）；协作模式（默认/计划）按能力接出：选项对任何版本提供，打开线程时 collaborationMode/list 不可用即 NATIVE_OPTION_UNAVAILABLE（ADR-034 的 2026-10-22 修订、ADR-053），只有明确选择协作模式的回合声明 experimentalApi；真实计划与切回默认在 0.162.1 上通过（证据）；线程会保存模式，跟随本机配置的回合读不到它，Hub 记住最后确认的模式并提示仍为计划模式（审批代理附加条件，已实现并有协议、集成与浏览器测试）；serviceTier 未接出；2026-11-01（0.166.0）：协作模式 plan 经 native-options 真实选择并回报，配置文件未改 |
| 原生命令目录与执行 | 不提供 | app-server 无斜杠命令；skills 以 UserInput.skill 调用（见 Skills） | 不适用 | 不适用 | 不适用 | — | — |
| 原生命令改配置后的同步 | 部分 | model/rerouted 通知（服务端单轮改路由）；app-server 没有修改模型或设置的原生命令 | 部分 | 未接出 | 未接出 | — | 改路由以警告提示逐轮显示；它不是会话设置，不在下一回合沿用（ADR-028）；改路由提示尚无协议测试 |
| 思考输出 | 具备 | item/reasoning/summaryTextDelta、textDelta | 已接出 | 通过 | 未接出 | .tmp/cc-native-thinking-codex.json；docs/verification/native-thinking-2026-10-11.md | 按用户配置（model_reasoning_effort=xhigh，未设置推理摘要）这一回合没有发送推理摘要；协议映射已测试 |
| 工具状态 | 具备 | item/started\|completed 的 commandExecution/fileChange/mcpToolCall/webSearch 等 | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-codex.json；docs/verification/native-activity-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 命令与补丁工具真实回合 |
| 工具输入/输出/差异 | 具备 | commandExecution.aggregatedOutput/exitCode、fileChange.changes[].diff、mcpToolCall 参数与结果、turn/diff/updated | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-codex.json；docs/verification/native-activity-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 命令输入/输出/退出码与补丁差异真实存储；MCP、搜索、图片项仅协议验证 |
| 计划 | 部分 | turn/plan/updated 来自 update_plan 清单工具；工具是否提供取决于模型与模式 | 已接出 | 通过 | 受阻 | .tmp/cc-native-activity-codex-plan.json；docs/verification/native-activity-2026-10-11.md；.tmp/cc-codex-plan-2026-10-12.json；docs/verification/codex-latest-2026-11-01.md | 本机默认 gpt-6.1-sol 回合未提供 update_plan 清单工具（真实回复确认）；计划模式给出的方案以 plan 条目返回，作为回复显示（ADR-034，真实通过），不是清单；2026-11-01（0.166.0）：HH_REAL_PLAN 回合没有计划工具，模型回复“当前环境未提供计划/待办工具”，仍受阻 |
| 用量/上下文/费用 | 具备 | thread/tokenUsage/updated {total,last,modelContextWindow}、account/rateLimits/updated | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-codex.json；docs/verification/native-activity-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 本轮 token 与上下文占用；Codex 不报告费用；账户额度 rateLimits 未接出 |
| 工具审批 | 具备 | item/commandExecution\|fileChange/requestApproval；子 Agent 线程审批归属当前回合 | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-codex-approval.json；docs/verification/native-session-actions-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 只读沙箱 + 按需审批的真实回合：文件修改审批带文件名与差异，允许一次后由原程序写入；原配置 approval_policy=never 时原程序不请求审批 |
| 原生提问与表单 | 具备 | item/tool/requestUserInput、mcpServer/elicitation/request | 部分 | 通过 | 未接出 | — | requestUserInput 已接出；MCP elicitation 仍被 -32601 拒绝 |
| 图片输入 | 具备 | UserInput.image(data URL)/localImage；Model.inputModalities | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-codex.json；docs/verification/native-attachments-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | localImage 指向只读副本；按所开模型 inputModalities 门控 |
| 音频输入 | 部分 | UserInput.audio/localAudio，仅 inputModalities 含 audio 的模型 | 已接出 | 通过 | 受阻 | — | localAudio 已接出；本机模型目录没有声明音频输入的模型，真实无法验收 |
| 文件/文档输入 | 部分 | 无 file 输入类型；仅 localImage/localAudio/mention(app/plugin) 与文本路径 | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-codex.json；docs/verification/native-attachments-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 原接口缺口：没有 file 输入类型（仅 localImage/localAudio/mention(app/plugin) 与文本路径）；Hub 把只读副本路径写入提示，原程序用自己的工具读取 |
| 非文本输出 | 部分 | imageGeneration.savedPath、imageView.path | 已接出 | 通过 | 未接出 | — | imageGeneration.savedPath 读取为产物（回合等待读取完成）、imageView 显示路径；真实图片生成未验收 |
| Skills | 具备 | skills/list、UserInput.skill | 已接出 | 通过 | 通过 | .tmp/cc-native-extensions.json；docs/verification/native-extensions-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | skills/list 列出用户、系统与工作区技能（真实 173 项）；启用的技能以 /skill:名称 作为 Codex 自己的 skill 输入调用，工作区技能真实调用成功 |
| MCP | 具备 | 用户 MCP 按原配置加载；mcpServerStatus/list、mcpServer/oauth/login | 部分 | 通过 | 通过 | .tmp/cc-native-extensions.json；docs/verification/native-extensions-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 原生扩展面板只读显示 MCP 服务器状态、认证与工具数（真实 14 个）；登录与重载在原程序中进行 |
| 插件/扩展 | 具备 | plugin/list\|install、app/list | 部分 | 通过 | 通过 | .tmp/cc-native-extensions.json；docs/verification/native-extensions-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 只读显示已安装插件（真实 46 个）；安装与启停在原程序中进行 |
| 原生会话恢复 | 具备 | thread/resume(excludeTurns)；跨 Hub 进程重启 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；docs/verification/complete-native-capabilities-2026-10-11.md；.tmp/cc-native-resume-commands-2026-10-12.json；docs/verification/codex-latest-2026-11-01.md | 在原程序中继续：`codex resume <id>`（help 确认），以 `codex exec --skip-git-repo-check resume <id> "…"` 真实验证答出标记（ADR-039） |
| 原生会话列表/接续 | 具备 | thread/list（cwd、来源、归档过滤）、thread/read、thread/turns/list（itemsView full） | 已接出 | 通过 | 通过 | .tmp/cc-native-import-codex.json；docs/verification/native-session-import-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 本机输入框“本机会话”列出本工作区线程并接续：引用最近消息，下一条输入直接进入原线程；同一线程只能被一个对话持有 |
| 原生分支 | 具备 | thread/fork {lastTurnId} | 已接出 | 通过 | 通过 | .tmp/cc-native-branch-codex-acp.json；docs/verification/native-branch-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 从最新回复分支时 thread/fork 建立原生副本；更早位置以公共历史分支 |
| 上下文压缩 | 具备 | thread/compact/start → contextCompaction item | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-pi-codex.json；docs/verification/native-session-actions-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | /compact 调用 thread/compact/start 并以活动展示；压缩后原生会话仍记得先前事实 |
| 回滚/回退 | 具备 | thread/revert {beforeTurnId}（只回退历史，不回退文件） | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 具备 | collabAgentToolCall、subAgentActivity；子线程自动附着连接 | 已接出 | 通过 | 通过 | .tmp/cc-native-subagent-codex-threads.json；.tmp/cc-native-subagent-codex.json；docs/verification/native-subagents-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | 子线程以 subAgentActivity/协作调用识别（已安装版本不为子线程发 thread/started）；子线程的工具嵌套在“子 Agent”条目下，最终回复作为条目输出；子线程文字不进入主回复 |
| 后台任务 | 具备 | command/exec；后台终端 thread/backgroundTerminals/* 需 experimentalApi | 已接出 | 通过 | 未接出 | docs/decisions/0030-retained-native-processes.md；docs/verification/first-chain-polish-2026-10-11.md | 同一保留机制：回合之间保留 app-server 进程，下一回合复用（测试替身经正式运行时验证）；后台终端的列出与清理需 experimentalApi，未接出；真实后台终端未验证 |
| 导出与产物 | 具备 | thread/read(includeTurns)、Thread.path rollout 路径 | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-pi-codex.json；docs/verification/native-session-actions-2026-10-11.md；docs/verification/codex-latest-2026-11-01.md | /export 读取线程自己的 rollout JSONL 作为产物；临时线程明确失败 |

## Claude Code

原安装：Claude Code 真实验收版本 2.1.316 + claude-agent-acp 0.99.1（本机登录；2026-11-01 之前：2.1.296（2026-10-11 的记录）、2.1.306 + 0.89.1（2026-10-22 的重验记录）；版本只作证据（ADR-053））；控制入口：acp-v1（claude-agent-acp）；分层：焦点。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | configOptions category=model（含别名） | 已接出 | 通过 | 通过 | .tmp/cc-native-catalog-claude.json；.tmp/cc-native-resume-claude.json；.tmp/cc-native-config-claude-model.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 目录真实读取 13 个模型；本会话选择 haiku、sonnet 真实生效（只作用于 Hub 会话，不改全局配置） |
| 思考档位 | 具备 | configOptions effort(thought_level) | 已接出 | 通过 | 通过 | .tmp/cc-native-config-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-latest-2026-11-01.md | effort 选项按所选应用并由代理回报确认（medium）；原生 /effort 命令后代理不宣告变化 |
| 模式与原生设置 | 具备 | mode(default/acceptEdits/plan/auto/bypassPermissions)、fast、agent | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | mode=default（手动审批）真实生效：编辑前请求审批 |
| 原生命令目录与执行 | 具备 | available_commands_update（内置、自定义、skills、插件、MCP prompt），/compact /model 等原生处理 | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-claude.json；.tmp/cc-native-config-claude-model.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 目录真实读取 223 条（2.1.296）、224 条（2.1.306）命令；/compact、/model 作为原生命令真实执行 |
| 原生命令改配置后的同步 | 具备 | /model、ExitPlanMode、回退模型后发送 config_option_update/current_mode_update | 已接出 | 通过 | 通过 | .tmp/cc-native-config-claude-model.json；.tmp/cc-native-config-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | /model haiku 后代理宣告新模型，下一回合沿用、显式切换后恢复所选；/effort 不被宣告，因此不沿用 |
| 思考输出 | 具备 | agent_thought_chunk（新模型可能只有签名不出文本） | 已接出 | 通过 | 受阻 | .tmp/cc-native-thinking-claude.json；docs/verification/native-thinking-2026-10-11.md | claude-agent-acp 说明新模型默认 thinking.display=omitted，只发送无文本的签名块；Hub 不修改用户设置，本机未产生可显示的思考文本 |
| 工具状态 | 具备 | tool_call/tool_call_update | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；.tmp/cc-parallel-budgets-2026-10-12.json；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | Bash、Read、Edit、ToolSearch 工具真实回合；已知版本偏差：claude-agent-acp 0.89.1 在前台命令运行期间一直把工具报告为 pending（2026-10-12 执行预算检查时 ping 正在运行），回合中途结束时 Hub 显示“未完成（原程序未报告结束）”，不推断是否执行过 |
| 工具输入/输出/差异 | 具备 | kind、content(diff/console)、locations、rawInput/rawOutput、_meta.claudeCode.toolResponse | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 命令输入输出、读取位置与编辑差异真实存储为可读详情 |
| 计划 | 具备 | plan 全量快照（TodoWrite/Task*） | 已接出 | 通过 | 受阻 | .tmp/cc-native-activity-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md | 本机 claude-agent-acp 0.89.1 会话里模型没有 TodoWrite 类计划工具（模型自述），无法产生计划；协议映射已测试 |
| 用量/上下文/费用 | 具备 | usage_update {used,size,cost USD}、PromptResponse.usage | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 回合 token、上下文占用（窗口 1,000,000）与会话费用（USD） |
| 工具审批 | 具备 | session/request_permission（allow_once/allow_always/reject_once，ExitPlanMode 选项） | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-claude-approval.json；.tmp/cc-native-activity-claude.json；.tmp/cc-attention-2026-10-12.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；.tmp/cc-parallel-budgets-2026-10-12.json；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 手动模式下编辑请求审批并一次允许；审批卡显示将要修改的差异；allow_always 会由原程序写入项目设置，验收只选一次允许；审批的期限为 HarnessHub 的等待预算（默认 30 分钟；Claude 没有自己的期限），侧栏与审批卡显示“等待期限 · 剩余 N 分”；等待 349.6 秒后批准，命令执行、回合完成；等待预算到期时以 WAIT_EXPIRED 取消，原程序没有收到批准（ADR-035、ADR-036，真实通过） |
| 原生提问与表单 | 具备 | AskUserQuestion/MCP 表单经 elicitation/create，需客户端声明 elicitation.form | 已接出 | 通过 | 通过 | .tmp/cc-native-question-claude.json；docs/verification/native-questions-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 声明 elicitation.form 后 AskUserQuestion 可用：表单逐题在对话中提问（选项、自填、跳过、取消）；多选题以单个选项加自填回答；含数字等字段的表单整表拒绝 |
| 图片输入 | 具备 | promptCapabilities.image；image block base64 | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 红色图片真实识别 |
| 音频输入 | 不提供 | 未声明 audio，音频块被静默丢弃 | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | 文本 resource 以 <context> 注入；blob 被丢弃；resource_link 只成链接文本 | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 原接口缺口：blob 被丢弃，resource_link 只成链接文本，只有文本 resource 以 <context> 注入；Hub 把小文本文件以嵌入资源发送并真实读取（文件内标记被答出），其余作文件链接 |
| 非文本输出 | 部分 | assistant 图片块（少见）与工具结果中的图片 | 已接出 | 通过 | 未接出 | docs/verification/claude-real-and-approval-detail-2026-10-11.md | 账号额度已恢复；非文本输出尚未单独真实验收 |
| Skills | 具备 | skills 出现在原生命令目录并按原配置加载 | 部分 | 通过 | 未接出 | docs/verification/claude-latest-2026-11-01.md | 通过原生命令执行；无独立技能管理界面；2026-11-01（0.99.1）：discoverExtensions 仍为 null，没有真实证据 |
| MCP | 具备 | 用户/项目/插件 MCP 默认加载；MCP OAuth 需 elicitation.url | 部分 | 未接出 | 未接出 | docs/verification/claude-latest-2026-11-01.md | 原程序加载；Hub 无状态/OAuth 界面；2026-11-01（0.99.1）：discoverExtensions 仍为 null，没有真实证据 |
| 插件/扩展 | 具备 | 已启用插件、hooks 按 settingSources 加载 | 部分 | 未接出 | 未接出 | docs/verification/claude-latest-2026-11-01.md | 原程序加载；Hub 无管理界面；2026-11-01（0.99.1）：discoverExtensions 仍为 null，没有真实证据 |
| 原生会话恢复 | 具备 | session/resume（不回放） | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；.tmp/cc-native-resume-commands-2026-10-12.json；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 第二回合以原生会话恢复，未注入公共上下文并答对；在原程序中继续：`claude --resume <id>`（help 确认），以 `claude -p --resume <id> "…"` 真实验证答出标记（ADR-039；2.1.296 与 2.1.306 各一次，2.1.306 上只输出标记一行） |
| 原生会话列表/接续 | 具备 | session/list（含 CLI/TUI 会话）、session/load 回放 | 已接出 | 通过 | 通过 | .tmp/cc-native-import-claude.json；docs/verification/native-session-import-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 通用 ACP 实现；claude -p 在新工作区创建的会话被列出、接续并答出标记 |
| 原生分支 | 具备 | session/fork 复制转录后需 resume | 已接出 | 通过 | 通过 | .tmp/cc-native-branch-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | session/fork 建立原生副本：分支答出源标记，源对话不知道分支标记 |
| 上下文压缩 | 具备 | /compact 触发原生压缩；compaction_update 需 session.compaction 能力 | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-claude.json；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | /compact 原生命令执行，compaction_update 以活动显示完成；压缩后仍记得先前事实 |
| 回滚/回退 | 不提供 | 非 JetBrains AIR 客户端无指定消息回退 | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 具备 | 子会话 subagent_spawned/state_update 需 subagents 能力；否则工具带 parentToolUseId | 已接出 | 通过 | 通过 | .tmp/cc-native-subagent-claude.json；docs/verification/native-subagents-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 未协商原生子会话时，子 Agent 工具平铺在根会话并带 parentToolUseId；Hub 记录关联并在 Agent 调用下嵌套显示，子 Agent 文字不进入主回复 |
| 后台任务 | 具备 | 后台 shell 与自主后续回合；async_task_* 仅 AIR | 已接出 | 通过 | 通过 | .tmp/cc-kept-process-2026-10-12.json；.tmp/cc-kept-orphan-2026-10-12.json；.tmp/cc-kept-outside-2026-10-12.json；docs/decisions/0030-retained-native-processes.md；docs/verification/first-chain-polish-2026-10-11.md | 按对话开启“保持原生进程”（默认关闭，新对话可在首条消息前开启）；回合之间保留 claude-agent-acp 进程，后台 shell 继续运行，下一回合复用进程读取其输出（真实通过：启动 7 毫秒，读到后台输出）；回合外更新只计数；空闲 30 分钟、切换、关闭、重建、分支与服务关闭时先结束并留证；服务被强制结束后，下一次启动按进程组号与启动时间接管：真实验证中 Claude Code 在输入关闭后自行结束（含后台任务），延迟重启记为已结束，立即重启时由 Hub 结束进程组，两种情况都在确认后释放工作区；Claude 的后台 Bash 在自己的进程组里，靠原程序自己清理；结束或接管前枚举离开进程组的后代，不向它们发信号，仍在运行时提示一次：真实验证找到 3 个、仍在运行 0 个（Claude 自己结束了后台任务），真实场景未出现仍在运行大于 0 的情况，只在集成与浏览器测试中覆盖 |
| 导出与产物 | 部分 | ACP 无导出方法；转录在 <CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<项目>/<会话>.jsonl（claude-agent-acp 也在此查找） | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-claude-export.json；docs/verification/claude-export-2026-10-11.md；docs/verification/claude-2.1.306-rebaseline-2026-10-22.md；docs/verification/claude-latest-2026-11-01.md | 原接口缺口：ACP 没有导出方法，代理也没有自己的 export 命令；Hub 提供 /export，只读复制本会话转录（<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects 下的 jsonl）作为产物，找不到转录时明确失败 |

## OpenCode

原安装：OpenCode 真实验收版本 2.2.5（OpenCode 2，homebrew/core 的 opencode；2026-11-01 之前：OpenCode 1 的 1.18.35（anomalyco/tap），其记录只作证据；版本只作证据（ADR-053））；控制入口：acp-v1（opencode acp）；分层：焦点。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | configOptions model(provider/model) | 已接出 | 通过 | 部分通过 | docs/verification/native-models-2026-10-11.md；.tmp/cc-native-resume-batch1.json；docs/verification/opencode-latest-2026-11-01.md | 默认 opencode/big-pickle 真实生成；原生接口选择 opencode/exo-free 已生效但未生成 |
| 思考档位 | 具备 | configOptions effort（仅模型有 variants 时） | 已接出 | 通过 | 受阻 | docs/verification/native-options-2026-10-11.md | 本机 OpenCode 模型均无思考档位变体（effort 选项只在有变体的模型上出现），无法真实验收 |
| 模式与原生设置 | 具备 | configOptions mode(build/plan) | 已接出 | 通过 | 通过 | .tmp/cc-native-options-opencode.json；docs/verification/native-options-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | mode=plan 真实生效：原生回报 plan，要求修改文件的回合未改动文件 |
| 原生命令目录与执行 | 具备 | available_commands_update（init/review、配置命令、MCP prompt、skills） | 已接出 | 通过 | 通过 | .tmp/cc-native-options-opencode-init.json；docs/verification/native-options-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 目录真实读取 104 条；/init 作为原生命令执行并生成 AGENTS.md；未知 / 开头文本会被原程序丢弃；2026-11-01（2.2.5）：/compact 由 OpenCode 2 自己宣告（Hub 不再补入）；/init 被接受但没有生成 AGENTS.md |
| 原生命令改配置后的同步 | 未核实 | 1.18.35 只在客户端 session/set_config_option（model）后发送 config_option_update；未发现原生命令修改设置后的宣告 | 未接出 | 未接出 | 未接出 | — | 若它宣告设置变化，通用 ACP 机制（ADR-028）会同样记录并沿用；未确认，不计为已接出 |
| 思考输出 | 具备 | agent_thought_chunk | 已接出 | 通过 | 通过 | .tmp/cc-native-thinking-opencode.json；docs/verification/native-thinking-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 推理题的思考内容记录在 Run 上，不混入回复 |
| 工具状态 | 具备 | tool_call/tool_call_update | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-opencode.json；docs/verification/native-activity-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 命令、读取、编辑与 todowrite 真实回合 |
| 工具输入/输出/差异 | 具备 | rawInput/rawOutput、diff、图片附件 | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-opencode.json；docs/verification/native-activity-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 命令/读取/编辑详情与差异真实存储；标题为原程序给出的路径 |
| 计划 | 不提供 | 不发送 plan 更新 | 不适用 | 不适用 | 不适用 | — | 原程序 todowrite 以工具（N todos）显示，不发 ACP plan |
| 用量/上下文/费用 | 具备 | 每轮 usage_update {used,size,cost}、PromptResponse.usage | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-opencode.json；docs/verification/native-activity-2026-10-11.md | 本轮 token、上下文与会话累计费用（原程序报告） |
| 工具审批 | 具备 | session/request_permission(once/always/reject) | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-opencode-approval.json；docs/verification/native-activity-2026-10-11.md；docs/verification/claude-real-and-approval-detail-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 工作区级 opencode.json 要求询问时真实审批（允许一次）；批准编辑后原程序调用未宣告的 fs/write_text_file，Hub 回 -32601 并留审计行，编辑仍由原程序完成；审批卡显示命令或将要修改的差异；2026-11-01（2.2.5）：命令与编辑各请求一次审批（once/always/reject），允许一次后完成 |
| 原生提问与表单 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 图片输入 | 具备 | promptCapabilities.image | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-opencode-vision.json；.tmp/cc-native-attachments-opencode-openclaw.json；docs/verification/native-attachments-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 代理级声明再按 opencode models --verbose 的模型输入细化；mimo-v2.6-flash-free 真实识别图片，默认 big-pickle 在派发前拒绝；2026-11-01（2.2.5）：opencode/mimo-v2.6-flash-free 识图答出颜色；默认 big-pickle 不识图；V2 没有 models --verbose，Hub 只试一次后退回代理声明 |
| 音频输入 | 不提供 | 未声明 audio | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 具备 | promptCapabilities.embeddedContext | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-opencode-vision.json；.tmp/cc-native-attachments-opencode-openclaw.json；docs/verification/native-attachments-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 小文本以嵌入资源发送；模型主动读取工作区外副本时原程序请求外部目录审批 |
| 非文本输出 | 部分 | 工具结果中的图片附件；回放中的图片/资源 | 已接出 | 通过 | 未接出 | — | ACP 非文本块进入产物；真实未验收 |
| Skills | 具备 | skills 出现在原生命令目录 | 部分 | 通过 | 未接出 | docs/verification/opencode-latest-2026-11-01.md | 通过原生命令执行；2026-11-01（2.2.5）：discoverExtensions 为 null，没有列表证据 |
| MCP | 具备 | 用户 MCP 配置按原程序加载 | 部分 | 未接出 | 未接出 | docs/verification/opencode-latest-2026-11-01.md | 原程序加载；Hub 无状态界面；2026-11-01（2.2.5）：discoverExtensions 为 null，没有列表证据 |
| 插件/扩展 | 具备 | 插件按原配置加载 | 部分 | 未接出 | 未接出 | docs/verification/opencode-latest-2026-11-01.md | 原程序加载；Hub 无管理界面；2026-11-01（2.2.5）：discoverExtensions 为 null，没有列表证据 |
| 原生会话恢复 | 具备 | session/resume（不回放）；跨 Hub 进程重启 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/cc-opencode-native-resume.json；.tmp/cc-native-resume-commands-2026-10-12.json；docs/verification/native-capabilities-round2-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 在原程序中继续：`opencode -s <id>`（help 确认），以 `opencode run -s <id> "…"` 真实验证答出标记（ADR-039） |
| 原生会话列表/接续 | 具备 | session/list（每页 100，根会话）、session/load 回放全部历史 | 已接出 | 通过 | 通过 | .tmp/cc-native-import-opencode.json；docs/verification/native-session-import-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | 通用 ACP 实现；opencode run 在新工作区创建的会话被列出、接续并答出标记 |
| 原生分支 | 具备 | session/fork | 已接出 | 通过 | 通过 | .tmp/cc-native-branch-codex-acp.json；docs/verification/native-branch-2026-10-11.md；docs/verification/opencode-latest-2026-11-01.md | session/fork 建立原生副本，复制历史的回放不归属；更早位置以公共历史分支 |
| 上下文压缩 | 具备 | /compact 原生命令；ACP 模块接受目录未列出的 compact（调用 session.summarize；1.0.0–1.19.3 与 2.x 的已发布版本都处理，1.16–1.19 对不认识的 / 文本静默丢弃） | 已接出 | 通过 | 通过 | docs/verification/opencode-compact-2026-10-22.md；docs/verification/opencode-latest-2026-11-01.md | OpenCode 的 ACP 命令目录不列出压缩命令；Hub 在目录未列出时对任何版本补入 /compact 并原样转发，回合没有任何回复、工具或活动时判为原程序没有执行（NATIVE_COMMAND_IGNORED；ADR-053、G032-NC24）；2026-10-22 真实回合：压缩完成并以回复文本交回，压缩后仍记得先前事实，没有压缩活动；2026-11-01（2.2.5）：V2 内置 compact，压缩后仍记得先前事实 |
| 回滚/回退 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 具备 | 子会话（task 子 Agent）权限请求 | 未接出 | 未接出 | 未接出 | — | task 子 Agent 的子会话工具不经 ACP 转发；子会话的权限请求被原程序丢弃（原程序限制） |
| 后台任务 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |

## OpenClaw

原安装：OpenClaw 真实验收版本 2026.3.23-2（npm 全局，原 Gateway 守护进程；版本只作证据，渠道 latest 2026.10.5 的两跳升级待用户确认，ADR-052）；控制入口：acp-v1（openclaw acp）+ gateway call；分层：焦点。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | gateway models.list + sessions.patch（只改 Hub 自己的会话键） | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | deepseek/deepseek-chat（2026-10-11 的验证早于 ADR-047 与 B6，.tmp 证据已不存在，待 M3 T-OC-08 在当前代码上重验） |
| 思考档位 | 具备 | configOptions thought_level | 已接出 | 通过 | 通过 | .tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | low 档真实使用（2026-10-11 的验证早于 ADR-047 与 B6，.tmp 证据已不存在，待 M3 T-OC-08 在当前代码上重验） |
| 模式与原生设置 | 具备 | fast_mode/verbose_level/reasoning_level/response_usage/elevated_level | 已接出 | 通过 | 部分通过 | .tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | 仅思考档位 low 真实使用；verbose/reasoning/usage/elevated 未真实使用；桥的模式选项与思考档位重复（C5 去重） |
| 原生命令目录与执行 | 具备 | 固定 27 条命令（缺 /fast /exec /approve 等） | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-acp.json；docs/verification/native-session-actions-2026-10-11.md | 原生 /compact 真实执行；固定 27 条命令（缺 /fast /exec /approve 等）（2026-10-11 的验证早于 ADR-047 与 B6，.tmp 证据已不存在，待 M3 T-OC-08 在当前代码上重验） |
| 原生命令改配置后的同步 | 部分 | /think、/fast、/verbose、/reasoning、/elevated、/model 等指令持久修改 Gateway 会话设置，但 ACP 桥不推送 config_option_update | 已接出 | 通过 | 通过 | .tmp/cc-native-config-openclaw.json；.tmp/cc-native-config-openclaw-fast.json；docs/verification/native-config-sync-2026-10-11.md | 原接口缺口：ACP 桥不推送 config_option_update，原生指令改过的会话设置不会主动通知 Hub；Hub 每回合后经原 CLI 读回会话行与 chat.history；/think high、/fast on 后下一回合沿用，同选择显式切换后恢复所选；恢复的会话按会话行模型检查图片 |
| 思考输出 | 部分 | ACP 桥不实时转发思考，仅 load 回放 | 部分 | 通过 | 受阻 | .tmp/cc-native-thinking-openclaw-gpt.json | 桥未流式转发思考时，回合结束后从原生转录补记（latest 的桥有思考流时不再从转录补，按能力判断）；本机受阻：默认模型 deepseek-chat 不输出思考，推理模型 openai-codex/gpt-5.4 在本机请求失败——不是接口缺口；用户配置推理模型后复验（审批代理裁决，2026-10-22） |
| 工具状态 | 部分 | 桥未声明 tool-events，工具事件很可能不会到达 | 部分 | 通过 | 通过 | .tmp/cc-native-activity-openclaw.json；docs/verification/openclaw-transcript-2026-10-11.md | ACP 桥不转发工具事件；回合结束后按本会话原生转录补记工具与结果（非实时） |
| 工具输入/输出/差异 | 部分 | Gateway agent 事件含工具输入输出（需 tool-events 与 verbose=full） | 部分 | 通过 | 通过 | .tmp/cc-native-activity-openclaw.json；docs/verification/openclaw-transcript-2026-10-11.md | 工具参数与结果来自本会话原生转录，回合结束后补记；实时工具流需直连 Gateway |
| 计划 | 不提供 | 桥从不发送 plan | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 部分 | usage_update 近似 {used,size}，无费用；sessions.list 含 token/估算费用 | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-openclaw.json；docs/verification/openclaw-transcript-2026-10-11.md | 原接口缺口：桥的 usage_update 只有近似的 {used,size}，没有费用；Hub 的本轮逐次调用用量与费用来自原生转录，上下文占用来自桥 |
| 工具审批 | 部分 | exec.approval.* 只走 Gateway RPC/事件；经 ACP 会静默等待约 120 秒后拒绝 | 未接出 | 未接出 | 未接出 | — | — |
| 原生提问与表单 | 不提供 | ACP 桥不发送提问 | 不适用 | 不适用 | 不适用 | — | — |
| 图片输入 | 具备 | image block → chat.send attachment（≤5 MB） | 已接出 | 通过 | 受阻 | .tmp/cc-native-attachments-opencode-openclaw.json；docs/verification/native-attachments-2026-10-11.md；.tmp/cc-native-attachments-openclaw-gpt.json | 按 models.list 的模型 input 与 5 MB 上限门控；默认 deepseek-chat 不看图，在派发前拒绝（已验证）；本机受阻：识图模型 openai-codex/gpt-5.4 在本机 OpenClaw 中请求失败（原生转录记录错误，Hub 判为失败）——不是接口缺口；用户配置多模态模型后复验（审批代理裁决，2026-10-22） |
| 音频输入 | 不提供 | 音频块被丢弃 | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | 文本 resource 追加为文本；blob 丢弃；resource_link 成文本 | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-opencode-openclaw.json；docs/verification/native-attachments-2026-10-11.md | 原接口缺口：桥丢弃 blob，resource_link 只成文本，只有文本 resource 追加为文本；Hub 的文本资源由桥展开为文本，文件链接成为文本路径 |
| 非文本输出 | 不提供 | 桥不转发图片/媒体；MEDIA: 行以原文出现 | 不适用 | 不适用 | 不适用 | — | — |
| Skills | 具备 | Gateway skills.status 与技能命令 | 部分 | 通过 | 通过 | .tmp/cc-native-extensions-openclaw.json；docs/verification/native-extensions-2026-10-11.md | “原生扩展”面板列出 Gateway skills.status 的技能（124 个，105 个可用）；技能由原程序按需使用，Hub 不单独调用（桥未提供 /skill 命令） |
| MCP | 部分 | 2026.3.23-2 的 openclaw.json（JSON5）有 mcp.servers，另有隐藏的 openclaw mcp set/unset/list/show 命令（docs/research/native-extension-configs-2026-10-18.md:42）；ACP 桥的扩展报告不含 MCP（src/adapters/control/openclaw.ts 的 extensions 返回 mcpServers: []） | 未接出 | 未接出 | 未接出 | — | ACP 桥不报告 MCP；能力页按 ADR-045 只读 openclaw.json 的 mcp.servers（src/adapters/capability-reads.ts 的 mcp: { style: "openclaw" }，不计入本格），写入按 ADR-045 裁决第 9 条推迟到升级之后 |
| 插件/扩展 | 部分 | Gateway tools.catalog/skills；无插件管理接口 | 部分 | 通过 | 通过 | .tmp/cc-native-extensions-openclaw.json；docs/verification/native-extensions-2026-10-11.md | 列出 tools.catalog 中的插件工具组（本机 1 个）；只读，不调用插件工具 |
| 原生会话恢复 | 具备 | session/load + Hub 自有会话键 requireExistingSession | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | 在原程序中继续：不显示（会话在用户自己的 OpenClaw Gateway 中，Hub 不读取其目录，ADR-039）（2026-10-11 的验证早于 ADR-047 与 B6，.tmp 证据已不存在，待 M3 T-OC-08 在当前代码上重验） |
| 原生会话列表/接续 | 部分 | 桥对 session/list 返回 Method not found；Gateway sessions.list 含渠道与其他代理的会话 | 未接出 | 未接出 | 未接出 | docs/verification/native-session-import-2026-10-11.md | 按设计不接续：其他会话属于渠道与代理，Hub 不向其中写入，只继续 Hub 自己创建的会话；明确拒绝已有协议测试 |
| 原生分支 | 不提供 | 无原生分支 | 不适用 | 不适用 | 不适用 | — | — |
| 上下文压缩 | 具备 | /compact 文本命令（sessions.compact 只截断） | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-acp.json；docs/verification/native-session-actions-2026-10-11.md | 原生 /compact 命令真实执行，压缩后仍记得先前事实；桥不发压缩活动（2026-10-11 的验证早于 ADR-047 与 B6，.tmp 证据已不存在，待 M3 T-OC-08 在当前代码上重验） |
| 回滚/回退 | 不提供 | 无回退 | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 部分 | sessions_spawn 子会话在桥中不可见 | 部分 | 未接出 | 未接出 | — | sessions_spawn 在转录对账中映射为子 Agent 工具（src/adapters/control/openclaw.ts 的 TOOL_KIND），只显示调用本身；子会话的内容在桥中不可见，子会话事件没有协议测试 |
| 后台任务 | 部分 | 后台 exec、cron 在回合结束后继续，需 Gateway 订阅观察 | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 部分 | gateway chat.history / sessions.get | 未接出 | 未接出 | 未接出 | — | — |

## Gemini CLI（冻结）

原安装：Gemini CLI 0.62.0（Homebrew，个人账号）；控制入口：acp-v1（gemini --acp）；分层：冻结（冻结时 ✅ 0）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | 旧式 models + session/set_model | 已接出 | 通过 | 受阻 | .tmp/cc-native-catalog.json | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 思考档位 | 不提供 | 无思考档位配置 | 不适用 | 不适用 | 不适用 | — | — |
| 模式与原生设置 | 具备 | 旧式 modes(default/autoEdit/yolo/plan) + session/set_mode | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻；set_mode 会在无 prompt 时发文本块，已改为不中断连接 |
| 原生命令目录与执行 | 具备 | available_commands_update（memory/extensions/init/restore 等） | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 原生命令改配置后的同步 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | 若它宣告设置变化，通用 ACP 机制（ADR-028）会同样记录并沿用；本机客户端被服务端停用，无法确认 |
| 思考输出 | 具备 | agent_thought_chunk | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 工具状态 | 具备 | tool_call/tool_call_update | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 工具输入/输出/差异 | 部分 | kind、locations、全文件 diff；无 raw 输入输出 | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 计划 | 不提供 | 不发送 plan | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 部分 | 仅 PromptResponse._meta.quota | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 工具审批 | 具备 | session/request_permission(allow always/once/reject) | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 原生提问与表单 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 图片输入 | 具备 | promptCapabilities.image | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 音频输入 | 具备 | promptCapabilities.audio | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 文件/文档输入 | 具备 | promptCapabilities.embeddedContext | 已接出 | 通过 | 受阻 | — | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻 |
| 非文本输出 | 不提供 | 只输出文本块 | 不适用 | 不适用 | 不适用 | — | — |
| Skills | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| MCP | 具备 | 用户 MCP/扩展按原配置加载 | 部分 | 未接出 | 未接出 | — | 原程序加载 |
| 插件/扩展 | 具备 | Gemini 扩展按原配置加载 | 部分 | 未接出 | 未接出 | — | 原程序加载 |
| 原生会话恢复 | 具备 | session/load（响应后继续流式回放，已加静默窗口） | 已接出 | 通过 | 受阻 | .tmp/cc-native-resume-commands-2026-10-12.json | Gemini 个人账号客户端被服务端停用（NATIVE_CLIENT_UNSUPPORTED），真实链路受阻；在原程序中继续未验证：`--resume` 只接受 latest 或序号，测试回合被服务端拒绝（ADR-039） |
| 原生会话列表/接续 | 不提供 | 无 session/list | 不适用 | 不适用 | 不适用 | — | — |
| 原生分支 | 不提供 | 无 fork | 不适用 | 不适用 | 不适用 | — | — |
| 上下文压缩 | 不提供 | ACP 下 /compress 不可用 | 不适用 | 不适用 | 不适用 | — | — |
| 回滚/回退 | 部分 | /restore 检查点（文件恢复） | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 后台任务 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |

## Cursor（冻结）

原安装：Cursor Agent 2026.10.01-e373342（官方安装，原 ~/.cursor 登录）；控制入口：acp-v1（cursor-agent acp）；分层：冻结（冻结时 ✅ 0）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 部分 | 模型 config option 会写入全局 cli-config selectedModel | 部分 | 通过 | 部分通过 | .tmp/cc-native-catalog-cursor.json；docs/verification/native-capabilities-round2-2026-10-11.md | 目录真实读取 44 个模型；Hub 只读展示，不代为执行全局切换 |
| 思考档位 | 部分 | 仅客户端声明 parameterizedModelPicker 时出现 thought_level，且随模型全局保存 | 未接出 | 未接出 | 未接出 | — | — |
| 模式与原生设置 | 具备 | mode(agent/plan/ask) 会话级 set_config_option | 已接出 | 通过 | 未接出 | — | 未真实验收 |
| 原生命令目录与执行 | 具备 | copy-request-id、自定义命令、skills | 已接出 | 通过 | 未接出 | — | 执行未验收 |
| 原生命令改配置后的同步 | 部分 | current_mode_update | 已接出 | 通过 | 受阻 | docs/verification/native-config-sync-2026-10-11.md | 通用 ACP 机制（模式宣告与回合后应用）；Cursor 模型选择在 Hub 只读；账号计划受限，未做真实验收 |
| 思考输出 | 具备 | agent_thought_chunk | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 工具状态 | 具备 | tool_call/tool_call_update（失败工具仍报告 completed） | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 工具输入/输出/差异 | 具备 | rawInput/rawOutput、diff、locations | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 计划 | 具备 | plan（create_plan） | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 用量/上下文/费用 | 不提供 | 不提供用量 | 不适用 | 不适用 | 不适用 | — | — |
| 工具审批 | 具备 | session/request_permission(allow-once/allow-always/reject-once) | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 原生提问与表单 | 部分 | cursor/ask_question 扩展请求；-32601 时退化为权限选项 | 部分 | 通过 | 未接出 | — | 经权限选项呈现 |
| 图片输入 | 具备 | promptCapabilities.image | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 音频输入 | 不提供 | 未声明 audio | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | resource 文本内联（≤20000 字）；项目根内 resource_link 读取 | 已接出 | 通过 | 受阻 | — | 未声明嵌入上下文，文件以链接发送（项目根外只显示名称与路径）；Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| 非文本输出 | 部分 | cursor/generate_image 扩展请求 | 已接出 | 通过 | 受阻 | — | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收 |
| Skills | 具备 | skills 出现在原生命令目录 | 部分 | 通过 | 未接出 | — | 通过原生命令执行 |
| MCP | 具备 | ~/.cursor/mcp.json 与项目 mcp.json；本轮修复后才按原配置目录加载 | 部分 | 未接出 | 未接出 | — | 原程序加载 |
| 插件/扩展 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 原生会话恢复 | 具备 | session/load（完整回放） | 已接出 | 通过 | 受阻 | .tmp/cc-native-resume-commands-2026-10-12.json | Cursor 账号套餐限制，原公共对话返回升级提示，生成任务无法验收；在原程序中继续未验证：`-p --resume` 要求工作区信任（`--trust`），为不写用户配置未加；ACP 会话存放在 ~/.cursor/acp-sessions，只显示 ID（ADR-039） |
| 原生会话列表/接续 | 具备 | session/list（unstable，无分页） | 已接出 | 通过 | 受阻 | docs/verification/native-session-import-2026-10-11.md | 通用 ACP 实现；账号计划受限，未做真实验收 |
| 原生分支 | 不提供 | fork 路由未实现 | 不适用 | 不适用 | 不适用 | — | — |
| 上下文压缩 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 回滚/回退 | 不提供 | 无回退 | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 具备 | subagent_spawned/state_update 需 subagents 能力 | 未接出 | 未接出 | 未接出 | — | — |
| 后台任务 | 未核实 | — | 未接出 | 未接出 | 未接出 | — | — |
| 导出与产物 | 不提供 | 无导出接口 | 不适用 | 不适用 | 不适用 | — | — |

## Pi（冻结、历史）

原安装：Pi 0.85.1（本机开发安装；安装渠道非官网，按 ADR-044 不再作为验收对象，以下证据保留为历史）；控制入口：pi-rpc（pi --mode rpc）；分层：冻结（冻结时 ✅ 11）。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | get_available_models、--provider/--model 启动参数 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1-pi.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | deepseek/deepseek-flash；用户默认 harnesshub 提供方指向未运行的 127.0.0.1:3180 |
| 思考档位 | 具备 | get_available_thinking_levels + Model.reasoning/thinkingLevelMap、set_thinking_level（会话级） | 已接出 | 通过 | 通过 | .tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | low 档真实使用；本轮改为不加载 Pi 内部 JS |
| 模式与原生设置 | 不提供 | 无会话级模式；steering/follow-up/自动压缩设置会写全局 settings.json | 不适用 | 不适用 | 不适用 | — | — |
| 原生命令目录与执行 | 具备 | get_commands（extension/prompt/skill）；内置 TUI 命令不可用 | 已接出 | 通过 | 未接出 | — | 扩展命令无运行时已按原生状态结算；执行未真实验收 |
| 原生命令改配置后的同步 | 部分 | get_state 的 model/thinkingLevel；扩展命令可改模型与思考档位；恢复会话文件时 Pi 自己恢复上次的模型与档位 | 已接出 | 通过 | 受阻 | docs/verification/native-config-sync-2026-10-11.md | 回合后读取 get_state；恢复会话不再强加默认模型（只在有选择时指定）；真实触发需要在用户 Pi 配置中加入扩展，不做 |
| 思考输出 | 具备 | message_update thinking_delta | 已接出 | 通过 | 通过 | .tmp/cc-native-thinking-pi.json；docs/verification/native-thinking-2026-10-11.md | deepseek/deepseek-flash、thinking_level=high：思考内容记录在 Run 上，不混入回复 |
| 工具状态 | 具备 | tool_execution_start/end | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-pi.json；docs/verification/native-activity-2026-10-11.md | bash、read、edit 真实回合 |
| 工具输入/输出/差异 | 具备 | tool_execution_start.args、update.partialResult、end.result.content/details(diff/patch) | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-pi.json；docs/verification/native-activity-2026-10-11.md | 参数、结果与 patch 差异真实存储 |
| 计划 | 不提供 | 无原生计划 | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 具备 | assistant message usage{input,output,cacheRead,cacheWrite,cost}、get_session_stats | 已接出 | 通过 | 通过 | .tmp/cc-native-activity-pi.json；docs/verification/native-activity-2026-10-11.md | 逐消息累计 token（含推理与缓存）、上下文窗口与本轮费用 |
| 工具审批 | 部分 | 无内置审批；扩展经 extension_ui confirm/select 拦截工具 | 已接出 | 通过 | 未接出 | — | 由扩展决定是否出现 |
| 原生提问与表单 | 具备 | extension_ui select/confirm/input/editor（含超时） | 已接出 | 通过 | 未接出 | — | 编辑器字段与超时已按 0.85.1 修正；未真实验收 |
| 图片输入 | 具备 | prompt.images[{data,mimeType}]，按 Model.input 门控 | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-pi.json；docs/verification/native-attachments-2026-10-11.md | 按当前模型 Model.input 门控；deepseek-flash 真实识别图片 |
| 音频输入 | 不提供 | 无音频输入 | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | RPC 无 @file 附件；只读副本路径写入提示，由原 read 工具读取 | 已接出 | 通过 | 通过 | .tmp/cc-native-attachments-pi.json；docs/verification/native-attachments-2026-10-11.md | 原接口缺口：Pi 的 RPC 没有文件附件输入（prompt 只带 images），Hub 把只读副本路径写入提示、由原 read 工具读取（docs/verification/native-attachments-2026-10-11.md：文本附件由原 read 工具读取副本并回复代码） |
| 非文本输出 | 部分 | read 工具返回的图片内容 | 未接出 | 未接出 | 未接出 | — | — |
| Skills | 具备 | /skill:name 经 prompt 展开 | 已接出 | 通过 | 部分通过 | .tmp/cc-native-extensions.json；docs/verification/native-extensions-2026-10-11.md | 命令目录中的 skill:名称 列为技能（真实 69 项）并按原生命令调用；新工作区的项目技能需 Pi 信任才加载，技能调用未真实验收 |
| MCP | 不提供 | 无内置 MCP（仅扩展） | 不适用 | 不适用 | 不适用 | — | — |
| 插件/扩展 | 具备 | extensions/packages 按原配置加载（项目资源需信任） | 部分 | 通过 | 通过 | .tmp/cc-native-extensions.json；docs/verification/native-extensions-2026-10-11.md | 只读显示扩展命令来源的扩展（真实 1 个）；安装与启停在原程序中进行 |
| 原生会话恢复 | 具备 | --session 原会话文件 | 已接出 | 通过 | 通过 | .tmp/cc-native-resume-batch1-pi.json；.tmp/native-complete-real-combined.json；docs/verification/complete-native-capabilities-2026-10-11.md | 首个助手消息前恢复仍会失败（原程序延迟创建文件）；在原程序中继续：会话标识是文件路径，只显示“见 Pi 自己的会话列表”（ADR-039） |
| 原生会话列表/接续 | 不提供 | RPC 无会话列表 | 不适用 | 不适用 | 不适用 | — | — |
| 原生分支 | 具备 | fork {entryId}、clone、get_fork_messages | 已接出 | 通过 | 通过 | .tmp/cc-native-branch-codex-pi.json；docs/verification/native-branch-2026-10-11.md | 恢复源会话文件后 clone 为新会话文件；更早位置以公共历史分支 |
| 上下文压缩 | 具备 | compact {customInstructions} | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-pi.json；docs/verification/native-session-actions-2026-10-11.md | /compact 调用 RPC compact（无同名扩展命令时）；会话过小时如实失败并显示原因 |
| 回滚/回退 | 部分 | 从用户消息 fork；原地树导航仅 TUI | 未接出 | 未接出 | 未接出 | — | — |
| 子 Agent | 不提供 | 无内置子 Agent（仅扩展工具） | 不适用 | 不适用 | 不适用 | — | — |
| 后台任务 | 不提供 | 无内置后台任务 | 不适用 | 不适用 | 不适用 | — | — |
| 导出与产物 | 具备 | export_html {outputPath} | 已接出 | 通过 | 通过 | .tmp/cc-native-commands-pi.json；docs/verification/native-session-actions-2026-10-11.md | /export 调用 export_html 写入临时目录后作为产物；会话为空时明确失败 |

## Hermes Agent

原安装：Hermes Agent 真实验收版本 v0.22.5（网关查看器模式：hermes acp 附着到用户正在运行的 launchd 网关，建会话前经只读预检 A，ADR-051 A2；2026-11-01 之前：0.12.0 进程内模式的记录；官方安装方式：~/.hermes/hermes-agent，启动器 ~/.local/bin/hermes；本机默认模型 deepseek:deepseek-v4-pro；版本只作证据（ADR-053））；控制入口：acp-v1（hermes acp）；分层：焦点。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | session/new·session/load 返回 models（提供方精选目录，标识为 <提供方>:<模型>），session/set_model 切换（acp_adapter/server.py） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-dsh-catalog.json；.tmp/cc-hermes-config.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | — |
| 思考档位 | 不提供 | ACP 不公布推理档位：没有 configOptions，set_config_option 只保存不生效（acp_adapter/server.py） | 不适用 | 不适用 | 不适用 | — | — |
| 模式与原生设置 | 具备 | session/set_mode：v0.22.5 的网关查看器提供 default / accept_edits / dont_ask 三个模式（目录选项 __mode） | 部分 | 未接出 | 通过 | docs/verification/hermes-latest-2026-11-01.md | 2026-11-01（v0.22.5）：请求 accept_edits 并回报 accept_edits（native-options）；经通用 ACP 选项接出，协议测试尚未覆盖 Hermes 的 set_mode，所以 Hub 侧记为部分 |
| 原生命令目录与执行 | 具备 | available_commands_update：help、model、tools、context、reset、compact、steer、queue、version，由 Hermes 在本地处理（acp_adapter/server.py _handle_slash_command） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-dsh-catalog.json；.tmp/cc-hermes-commands.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md | — |
| 原生命令改配置后的同步 | 具备 | /model <名称> 在本地切换会话模型，只回固定文本，不发 ACP 更新（acp_adapter/server.py _cmd_model） | 已接出 | 通过 | 失败 | .tmp/cc-hermes-config.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | Hub 只在提示词本身是 /model 命令时读取它的回复，并把新模型记为会话当前模型；2026-11-01（v0.22.5 网关查看器）：/model deepseek-v4-flash 的命令回合以 failed 结束、没有错误对象，之后仍回报 v4-pro——网关模式下 /model 受守卫需确认，Hub 尚未接确认流程 |
| 思考输出 | 具备 | 提供方推理增量 → agent_thought_chunk（acp_adapter/events.py make_thinking_cb） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-dsh-thinking.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | — |
| 工具状态 | 具备 | tool_call / tool_call_update（acp_adapter/events.py、tools.py） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-activity.json；.tmp/cc-attention-2026-10-12.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | Hermes 0.12 的 build_tool_complete 对每个结束的调用都报 completed，失败只写在文本里（“<工具> failed: …”或“BLOCKED: …”）；Hub 据此标为失败（2026-10-12，审批代理决定）。真实回合中 rm -r 被拒绝时曾显示为“完成”；修正后真实回合显示为“失败”；当时同时显示的“Hermes 没有请求审批”提示 2026-10-22 按 ADR-053 删除（它按版本号决定是否显示） |
| 工具输入/输出/差异 | 具备 | 标题、类型、位置、patch/write_file 差异、结果文本；常用工具不带 rawInput/rawOutput（acp_adapter/tools.py _POLISHED_TOOLS） | 已接出 | 通过 | 部分通过 | .tmp/cc-hermes-activity.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | 常用工具的输入只出现在标题和开始内容里；2026-11-01（v0.22.5）：patch 工具不发 diff，editDiff 判据未通过（原接口缺口）；其余工具详情可读 |
| 计划 | 部分 | todo 工具只以展示文本出现在工具卡片，ACP 没有 plan 更新（acp_adapter/tools.py） | 未接出 | 未接出 | 未接出 | — | 未把 todo 文本解析为计划 |
| 用量/上下文/费用 | 具备 | session/prompt 结果的 usage（输入、输出、思考、缓存）与 usage_update（上下文 size/used）（acp_adapter/server.py） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-activity.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | — |
| 工具审批 | 具备 | 危险命令经 session/request_permission 审批（允许一次、始终允许、拒绝），60 秒未答自动拒绝（acp_adapter/permissions.py） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-approval.json；.tmp/cc-attention-2026-10-12.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | 本机 Hermes 0.12.0 的缺陷：tools/approval.py 调用审批回调时传入 allow_permanent，ACP 适配层回调不接受（TypeError），危险命令一律按拒绝处理，审批请求根本不会发出；需要用户升级 Hermes（本机落后上游 18332 个提交）。Hub 的 60 秒期限处理已有协议测试（ADR-053 登记的例外，只增加信息；0.12 的缺陷提示由第三批 D2 删除）；2026-10-12 再次确认（rm -r 被拒绝，模型仍回复“已删除”），侧栏的原生期限倒计时只在 Hermes 0.12.0 夹具的浏览器测试中验证（ADR-035）；2026-11-01（v0.22.5 网关查看器）：编辑前真实请求审批（选项 allow_once / deny），允许一次后编辑完成；0.12 的缺陷随升级消失 |
| 原生提问与表单 | 不提供 | hermes-acp 工具集不含 clarify（toolsets.py） | 不适用 | 不适用 | 不适用 | — | — |
| 图片输入 | 具备 | promptCapabilities.image；图片转为 OpenAI image_url 交给模型（acp_adapter/server.py） | 已接出 | 通过 | 受阻 | .tmp/cc-hermes-dsh-attachments.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | Hermes 公布并转发图片，但本机模型 deepseek-v4-pro 回复看不到图片；2026-11-01（v0.22.5）：默认模型 deepseek-v4-pro 仍回复“看不到这张图片”，按本机模型受阻 |
| 音频输入 | 不提供 | 未公布 audio，音频块被丢弃（acp_adapter/server.py _content_blocks_to_openai_user_content） | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 部分 | resource_link 与嵌入资源不会交给模型（acp_adapter/server.py） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-dsh-attachments.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | 原接口缺口：resource_link 与嵌入资源都不会交给模型（acp_adapter/server.py）；Hub 改为在提示词中附上只读副本路径，由 Hermes 用自己的文件工具读取 |
| 非文本输出 | 不提供 | agent_message_chunk 只发文本（acp_adapter/events.py）；hermes-acp 工具集不含图像生成 | 不适用 | 不适用 | 不适用 | — | — |
| Skills | 部分 | skills_list、skill_view、skill_manage 工具与 ~/.hermes/skills；ACP 没有技能列表（toolsets.py） | 未接出 | 未接出 | 未接出 | — | — |
| MCP | 部分 | config.yaml 的 mcp_servers 在启动时注册，会话也可附加 MCP 服务器；ACP 没有列表（acp_adapter/entry.py、server.py） | 未接出 | 未接出 | 未接出 | — | — |
| 插件/扩展 | 部分 | plugins/ 插件机制；ACP 没有对应接口 | 未接出 | 未接出 | 未接出 | — | — |
| 原生会话恢复 | 具备 | session/load 从 ~/.hermes/state.db 恢复（未知标识返回 null）；session/resume 对未知标识会静默新建（acp_adapter/session.py、server.py） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-dsh-resume.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；.tmp/cc-native-resume-commands-2026-10-12.json；docs/verification/hermes-latest-2026-11-01.md | Hub 只用 session/load；历史回放在响应之后，等待窗口从响应开始计算；在原程序中继续：`hermes --resume <id>`（help 确认，回合结束时 Hermes 自己也打印），以 `hermes chat --resume <id> -q "…"` 真实验证答出标记（ADR-039） |
| 原生会话列表/接续 | 具备 | session/list（按 cwd 过滤、游标分页，只列有消息的 ACP 会话）与 session/load 回放（acp_adapter/server.py） | 已接出 | 通过 | 失败 | .tmp/cc-hermes-dsh-import.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | 只列出经 ACP 创建的会话（编辑器等），CLI、TUI 与消息网关中的会话不在其中；2026-11-01（v0.22.5 网关查看器）：hermes acp 建出会话后 session/list 对工作区返回 0 个，接续套件在列表步骤失败；列表规则待查 |
| 原生分支 | 具备 | session/fork（acp_adapter/session.py fork_session） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-dsh-branch.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | — |
| 上下文压缩 | 具备 | /compact 命令（acp_adapter/server.py _cmd_compact） | 已接出 | 通过 | 未接出 | .tmp/cc-hermes-commands.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | 2026-11-01（v0.22.5）：ACP 命令目录没有 compact，Hub 不为 Hermes 补入，本轮未验证 |
| 回滚/回退 | 不提供 | 只有 /reset 清空整段历史，没有回退到某一轮 | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 部分 | delegate_task 在进程内运行子 Agent；子 Agent 的活动不经 ACP 发出（acp_adapter/tools.py） | 部分 | 未接出 | 未接出 | .tmp/cc-hermes-subagent.json；docs/verification/hermes-dsh-onboarding-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | delegate_task 只显示为一个 execute 工具（无工具名，标题为“delegate: …”）；子 Agent 自己的工具不经 ACP 发出，无法挂到调用下；2026-11-01（v0.22.5）：回合里模型没有调用 delegate_task，子 Agent 未复现（不是接口缺口） |
| 后台任务 | 具备 | process 工具管理后台进程；随每回合结束的 ACP 进程一起结束（toolsets.py） | 已接出 | 通过 | 未接出 | docs/decisions/0030-retained-native-processes.md；docs/verification/first-chain-polish-2026-10-11.md | 同一保留机制：开启后回合之间保留 ACP 进程，后台工作随进程继续（ACP 测试替身经正式运行时验证）；真实后台任务未验证 |
| 导出与产物 | 具备 | hermes sessions export - --session-id <id> 输出 JSONL（hermes_cli/main.py） | 已接出 | 通过 | 通过 | .tmp/cc-hermes-export-2026-10-12.json；docs/verification/first-chain-polish-2026-10-11.md；docs/verification/hermes-latest-2026-11-01.md | Hermes 没有列出自己的 export 命令时，Hub 提供 /export：只在用户执行时运行一次 hermes sessions export - --session-id <id>（5 秒、8 MiB 上限，只接受普通标识符；未知会话的提示句与超限、超时都明确失败，不记录部分内容），会话的 JSON 行作为产物登记；sessions 子命令不触发插件发现与更新检查，真实运行时进程中只有这一条子命令，用户的 gateway 不受影响 |

## DeepSeek Harness

原安装：DeepSeek Harness 真实验收版本 0.2.1-rc.5（npm 官网 @deepseek-ai/dsh，nvm 全局安装；2026-11-01 之前：0.2.0-rc.2（2026-10-22 经官网渠道重验），源码版 0.2.1-alpha.1 的记录按 ADR-044 为历史；版本只作证据（ADR-053））；控制入口：acp-v1（dsh --profile acp）；分层：焦点。

| 能力 | 原接口 | 来源 | Hub | 协议 | 真实原安装 | 证据 | 说明 |
|---|---|---|---|---|---|---|---|
| 模型目录与选择 | 具备 | session/new 的 model 配置项（实时服务目录）与 session/set_config_option（packages/acp/acp/src/model-control.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | — |
| 思考档位 | 具备 | reasoning_effort 配置项（category thought_level，模型声明推理选项时提供）（packages/acp/acp/src/model-control.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | — |
| 模式与原生设置 | 不提供 | ACP 自动化界面不提供 mode（packages/acp/acp/README.md） | 不适用 | 不适用 | 不适用 | — | — |
| 原生命令目录与执行 | 不提供 | ACP 自动化界面不提供命令（packages/acp/acp/README.md） | 不适用 | 不适用 | 不适用 | — | — |
| 原生命令改配置后的同步 | 不提供 | 没有原生命令；配置只经 session/set_config_option 改变 | 不适用 | 不适用 | 不适用 | — | — |
| 思考输出 | 具备 | 已提交的 reasoning 块 → agent_thought_chunk（packages/acp/acp/src/updates.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | 思考与回复分开到达；0.2.1-alpha.1 时观察到按整块到达、不是逐字增量，rc.2 未记录到达方式 |
| 工具状态 | 具备 | tool/call、tool/result → tool_call（in_progress）与 tool_call_update（completed/failed）（packages/acp/acp/src/updates.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | — |
| 工具输入/输出/差异 | 部分 | 工具名、rawInput、结果内容；kind 恒为 other，没有差异和位置（packages/acp/acp/src/updates.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | 原接口缺口：工具 kind 恒为 other，不带差异与位置，只有工具名、rawInput 与结果文本（docs/research/first-chain-products-2026-10-11.md 的 dsh 输出一行，依据 packages/acp/acp/src/updates.ts）；rc.2 重验：todo_write、bash、read、edit 的详情可读，edit 不带差异，native-activity 的 editDiff 判据因此未通过；2026-11-01（0.2.1-rc.5）：edit 工具仍不发 diff，editDiff 判据按预期未通过（原接口缺口） |
| 计划 | 不提供 | ACP 界面不提供计划与 todo（packages/acp/acp/README.md） | 不适用 | 不适用 | 不适用 | — | — |
| 用量/上下文/费用 | 部分 | usage_update（上下文占用与窗口）；session/prompt 结果不带用量（packages/acp/acp/src/updates.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | 原接口缺口：只发 usage_update 的上下文占用与窗口，session/prompt 结果不带 token 用量与费用（docs/research/first-chain-products-2026-10-11.md 的 dsh 输出一行）；rc.2 重验回报了上下文占用与窗口（1,000,000） |
| 工具审批 | 具备 | session/request_permission（允许一次、拒绝）（packages/acp/acp/src/index.ts） | 已接出 | 通过 | 受阻 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | 受阻：无法观察生效预设。rc.2 重验中 bash 与 edit 都没有请求审批；ACP 入口不回报预设、不处理 /permission，HarnessHub 也不读取 dsh 设置，所以不知道当时按哪个预设运行；界面只说明规则；2026-11-01（0.2.1-rc.5）：bash 与 edit 都没有请求审批，ACP 入口不回报生效的权限预设，仍受阻 |
| 原生提问与表单 | 不提供 | 不提供 elicitation（packages/acp/acp/README.md） | 不适用 | 不适用 | 不适用 | — | — |
| 图片输入 | 部分 | 只有挂载持久附件存储且路由支持图片时才公布 promptCapabilities.image（packages/acp/acp/src/index.ts） | 已接出 | 通过 | 受阻 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | rc.2 的 acp profile 仍不声明图片输入；Hub 在派发前拒绝图片（ATTACHMENT_UNSUPPORTED）已在真实环境确认；2026-11-01（0.2.1-rc.5）：acp profile 仍不声明图片输入，Hub 在派发前拒绝 |
| 音频输入 | 不提供 | promptCapabilities.audio=false（packages/acp/acp/src/index.ts） | 不适用 | 不适用 | 不适用 | — | — |
| 文件/文档输入 | 具备 | resource_link 以 [resource_link name=… uri=…] 交给模型，由它的工具读取（packages/acp/acp/README.md、src/content.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | — |
| 非文本输出 | 具备 | assistant 图片块经附件存储转为 ACP image（packages/acp/acp/src/content.ts assistantBlockToAcp） | 已接出 | 通过 | 未接出 | — | — |
| Skills | 部分 | skill 插件；ACP 没有技能列表 | 未接出 | 未接出 | 未接出 | — | — |
| MCP | 部分 | session/new 可挂载 stdio/HTTP MCP；ACP 不列出用户自己的 MCP（packages/acp/acp/README.md、src/mcp.ts） | 未接出 | 未接出 | 未接出 | — | — |
| 插件/扩展 | 部分 | profile bundles 插件机制（dsh plugin）；ACP 没有列表 | 未接出 | 未接出 | 未接出 | — | — |
| 原生会话恢复 | 具备 | session/resume 恢复持久会话，不回放旧更新（packages/acp/acp/src/index.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | 在原程序中继续：官网 0.2.0-rc.2 只给 `dsh headless --session-id <id> "…"`（rc.2 没有 tui profile，ADR-039），2026-10-22 真实核对：退出码 0，只输出标记一行；`dsh tui --resume <id>` 是 0.2.1-alpha.1 源码版的历史证据（ADR-044） |
| 原生会话列表/接续 | 具备 | session/list：从新到旧列出持久根会话（无标题、无时间），可按 cwd 过滤（packages/acp/acp/src/index.ts） | 已接出 | 通过 | 通过 | docs/verification/dsh-rc2-reverification-2026-10-22.md；docs/verification/dsh-latest-2026-11-01.md | 不支持 session/load，接续时没有历史可引用（如实标出），接续后由原生会话回答 |
| 原生分支 | 不提供 | 不支持 fork（packages/acp/acp/README.md） | 不适用 | 不适用 | 不适用 | — | — |
| 上下文压缩 | 部分 | 自动压缩插件（compaction-basic、tool-result-pruner）；ACP 没有压缩命令或更新 | 未接出 | 未接出 | 未接出 | — | — |
| 回滚/回退 | 不提供 | ACP 界面不提供（packages/acp/acp/README.md） | 不适用 | 不适用 | 不适用 | — | — |
| 子 Agent | 部分 | subagent 插件；子会话 origin=subagent 不在列表中，ACP 只发父会话的工具调用（packages/acp/acp/src/index.ts） | 部分 | 未接出 | 未接出 | — | 只显示调用子 Agent 的工具本身 |
| 后台任务 | 部分 | jobs、schedule、goal 等自主工作；没有进行中的 ACP 提示词时，session/cancel 取消自主工作（packages/acp/acp/README.md） | 已接出 | 通过 | 未接出 | docs/decisions/0030-retained-native-processes.md；docs/verification/first-chain-polish-2026-10-11.md | 同一保留机制：开启后回合之间保留 ACP 进程，后台工作随进程继续（ACP 测试替身经正式运行时验证）；真实后台任务未验证 |
| 导出与产物 | 部分 | 会话日志保存在 $DSH_HOME/sessions；ACP 没有导出 | 未接出 | 未接出 | 未接出 | — | — |
