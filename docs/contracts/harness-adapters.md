# Harness 适配矩阵

每家的适配声明在 `src/adapters/flavors/<harnessId>.ts`（契约 `src/contracts/flavor.ts`）。格子里先写**怎么适配**：原生 / 会话参数 / Hub 策略（Hub 按档位答复权限请求）/ 做不到（附原因），再写**真机**：✓ 已验，✗ 未验。截至 2026-11-13，按代码实际情况填写；OpenCode、DeepSeek Harness、Hermes、OpenClaw 四列的依据写在各自的声明文件里。

| 能力 | Claude Code | Codex | OpenCode | DeepSeek Harness | Hermes | OpenClaw |
|---|---|---|---|---|---|---|
| 权限五档 | 原生模式 plan/default/acceptEdits/auto/bypassPermissions，叠加 Hub 策略；✓ 五档可选 | 原生 approval_policy + sandbox（只规划另加协作模式 plan），叠加 Hub 策略；✓ “每步询问”连 cat 都先问 | 会话参数：每个进程用 `OPENCODE_CONFIG_CONTENT` 给 build、general（只规划时给 plan）下发规则——每步询问：改文件、命令、工作区外都 ask；自动改文件：改文件 allow；自动执行：改文件和命令 allow、工作区外 ask（Hub 拒绝工作区外的改动）；完全放行：`* allow`；只规划：原生 plan agent，另禁命令；✓ 五档（2026-11-12：只规划不改不跑命令，每步询问问了命令和改动，自动改文件只问命令，自动执行、完全放行都不问；2026-11-13 在页面上：选“每步询问”后新建文件和 `ls` 各问一次，对话中途改成“自动改文件”后改文件不问、`cat` 来问，拒绝后这一回合停下并记为已拒绝） | 会话参数 `DSH_PERMISSION_MODE` + Hub 策略（它只在越出沙箱写文件时来问）：只规划、每步询问、自动改文件用 read-only，自动执行用 workspace-write 并拒绝越权，完全放行用 danger-full-access；会话建立后换档只改 Hub 的答复；✓ 五档（只规划没改文件，每步询问在改文件越权时来问，自动执行、完全放行不问；2026-11-13 自动改文件：改文件的越权由 Hub 自动允许并留痕，没有问用户）。它的请求不带标题、工具类别一律 other，Hub 按请求所指的那次调用的工具名判断是改文件还是命令 | 原生模式：只规划、每步询问 default，自动改文件、自动执行 accept_edits，完全放行 dont_ask 加 `HERMES_YOLO_MODE=1`（只对新建的会话）；Hermes 只问改文件和危险命令，其余靠 Hub 策略；只规划用 Hub 策略加只读提示；✓ 五档（改文件这一路：只规划没改，每步询问来问，其余不问；危险命令与 yolo 未验） | 会话参数：首条消息前 `sessions.patch permissionMode`——只规划 read-only、每步询问和自动改文件 guarded、自动执行 workspace、完全放行 full；改文件从不来问；✓ 五档（只读 echo：只规划被拒，每步询问、自动改文件都来问，自动执行、完全放行不问） |
| 思考五档 | 原生 effort（按名对应）；✓ | 原生 reasoning_effort，按模型（minimal 对应“低”，xhigh 对应“最高”）；✓ | 原生 effort 变体（`none`/`low`/`medium`/`high`/`max`，有 `xhigh`、`thinking` 时就近），仅有变体的模型；✗（本机默认模型 opencode/big-pickle 没有变体） | 原生 reasoning_effort（off/low/high/max，没有“中”）；✓ | 驱动补一个 reasoning_effort 选项，打开会话后发 `/reasoning <档>`（只改这个会话，不写 config.yaml），Hermes 按模型就近降档；✓ low、high | 原生 thought_level，只列 Gateway 对该代理模型实际支持的档（agents.list 的 thinkingLevels；桥报的基础列表会被拒）；✓ off（本机 deepseek-chat 只支持 off） |
| 计划模式 | 原生 plan | 原生协作模式 plan（需实验接口） | 原生 plan agent（只许写它的计划文件），Hub 另禁命令与 general 子代理改动 | Hub 策略：read-only 沙箱 + 拒绝越权 + 只读提示 | Hub 策略：拒绝来问的改文件和危险命令 + 只读提示（普通命令拦不住） | 原生 read-only 权限模式 + 只读提示 |
| 审批与提问 | 原生 request_permission；提问走 elicitation | 原生 requestApproval；提问走 requestUserInput | 原生 request_permission（拒绝会结束它这一回合；用户点“始终允许”会被它记进项目库，以后压过 Hub 下发的询问规则） | 原生 request_permission（只为越出沙箱，工具类别一律报 other、请求没有标题，按所指调用的工具名归类） | 原生（改文件按模式问，命令只问危险的；请求自带类别 edit / execute，Hub 按它归类），提问 ✗ | 原生执行审批（只在提示进行中），改文件从不问，提问 ✗ |
| 会话级 MCP | 原生 ACP mcpServers；✓ hub_turns | 只能写用户配置 config.toml（安装可选） | 原生 ACP mcpServers；✗ | 只能写 cordis.patch.yml（它的 ACP 不处理 mcpServers） | 原生 ACP mcpServers，转交网关；✗ | 做不到：ACP 桥拒绝按会话传入，写进 openclaw.json 又认不出是哪个对话 |
| 系统提示追加 | 原生：ACP 会话 `_meta.systemPrompt.append`；✓ | 原生：`thread/start`、`thread/resume` 的 `developerInstructions`（用户自己的排前面）；✓ | 没有按会话的入口（未做） | 没有按会话的入口（未做） | 没有按会话的入口（未做） | 没有按会话的入口（未做） |
| 任务清单与“下一步” | Hub 工具 `hub_update_plan`、`hub_wrap_up`（会话级 MCP）+ 系统提示；✓ 会主动用 | Hub 工具（用户配置里的 MCP，安装可选）+ 系统提示；✓ 会主动用 | Hub 工具（会话级 MCP）；没有系统提示，会不会主动用 ✗ | Hub 工具要写它的配置（安装可选）；✗ | Hub 工具（会话级 MCP，转交网关）；✗ | 做不到按会话传工具；✗ |
| 用量 | 原生按回合（缓存另报，加回）；✓ | 原生线程累计减基线；✓ | 原生按回合；✓ | 只报上下文占用，无回合用量 | 会话累计减基线（Hub 算）；✗ | 按转录逐次相加；✗ |
| 恢复 | 原生 session/load、resume；✓ | 原生 thread/resume；✓ | 原生 load；✓ | 原生 load；✓ | 原生 load（网关）；✓ | Gateway 会话键；✓ |
| 分叉 | 原生 session/fork；✓ | 原生 thread/fork；✓ | 未查 | 未查 | 未查 | 未查 |
| 附件 | 原生（图片、资源链接）；✓ | 原生（图片、文件提及）；✓ | 原生 ACP；✓ | 原生 ACP；✗ | 文本指针（它读不到资源链接）；✓ | 单段文本内写路径；✗ |
| 原生命令 | 原生目录；✓ | Hub 提供线程操作与技能；✓ | 原生目录；✓ | 原生目录；✓ | 原生目录 + Hub 补 /export；✓ | 原生目录；✓ |
| 改动 diff | Hub 自记 + 它自己报；✓ | Hub 自记 + 它自己报；✓ | Hub 自记 + 它自己报 | Hub 自记（它不报 diff） | Hub 自记（它不报 diff） | Hub 自记 |

**Hub 策略的答复规则**（`HUB_POLICIES`）：读、搜索、思考类请求一律允许，不问用户；提问永远交给用户；没选档位时全部交给用户。请求属于哪一类，依次看：请求自带的工具类别、请求所指那次调用的类别、请求的标题、那次调用在 Hub 里的条目（命令、改文件、读文件，或工具名）。

| 档位 | 改文件 | 跑命令 | 联网 | 工具 | 其他 |
|---|---|---|---|---|---|
| 只规划 | 拒绝 | 拒绝 | 允许 | 问用户 | 拒绝 |
| 每步询问 | 问用户 | 问用户 | 问用户 | 问用户 | 问用户 |
| 自动改文件 | 允许 | 问用户 | 问用户 | 问用户 | 问用户 |
| 自动执行 | 允许 | 允许 | 允许 | 允许 | 允许 |
| 完全放行 | 允许 | 允许 | 允许 | 允许 | 允许 |

Hub 替用户做的决定都存成审批条目，决定人记为 `policy`，同时记下档位；页面上显示为“按「自动改文件」自动允许：…”。
