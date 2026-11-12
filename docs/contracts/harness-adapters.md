# Harness 适配矩阵

每家的适配声明在 `src/adapters/flavors/<harnessId>.ts`（契约 `src/contracts/flavor.ts`）。格子里先写**怎么适配**：原生 / 会话参数 / Hub 策略（Hub 按档位答复权限请求）/ 做不到（附原因），再写**真机**：✓ 已验，✗ 未验。截至 2026-11-12（d9480f5 之后），按代码实际情况填写。

| 能力 | Claude Code | Codex | OpenCode | DeepSeek Harness | Hermes | OpenClaw |
|---|---|---|---|---|---|---|
| 权限五档 | 原生模式 plan/default/acceptEdits/auto/bypassPermissions，叠加 Hub 策略；✓ 五档可选 | 原生 approval_policy + sandbox（只规划另加协作模式 plan），叠加 Hub 策略；✓ “每步询问”连 cat 都先问 | 只规划：原生 plan agent；其余档：Hub 策略（它按自己的配置决定问不问，不来问的 Hub 拦不住，待 harness-fit 改成按会话下发规则）；✗ | Hub 策略（按它自己的预设决定问不问，不来问的拦不住）；✗ | 原生模式 default/accept_edits/dont_ask（“自动执行”用 accept_edits 加策略），只规划用 Hub 策略；✗ | Hub 策略（只有 Gateway 的执行审批会来问）；✗ |
| 思考五档 | 原生 effort（按名对应）；✓ | 原生 reasoning_effort，按模型（minimal 对应“低”，xhigh 对应“最高”）；✓ | 原生 effort 变体，仅有变体的模型；✗ | 原生 reasoning_effort；✓ | 做不到：它的 ACP 不公布推理档位 | 原生 thought_level；✓（low，旧验证） |
| 计划模式 | 原生 plan | 原生协作模式 plan（需实验接口） | 原生 plan agent | Hub 策略：拒绝改文件和命令，并在消息前加只读提示 | Hub 策略（同左） | Hub 策略（同左） |
| 审批与提问 | 原生 request_permission；提问走 elicitation | 原生 requestApproval；提问走 requestUserInput | 原生 request_permission | 原生 request_permission | 原生（只问危险命令），提问 ✗ | 原生执行审批，提问 ✗ |
| 会话级 MCP | 原生 ACP mcpServers；✓ hub_turns | 只能写用户配置 config.toml（安装可选） | 原生 ACP mcpServers；✗ | 只能写 cordis.patch.yml（它的 ACP 不处理 mcpServers） | 原生 ACP mcpServers，转交网关；✗ | 做不到：ACP 桥拒绝按会话传入，写进 openclaw.json 又认不出是哪个对话 |
| 系统提示追加 | 另一路（cc/plan-use）在做 | 同左 | 同左 | 同左 | 同左 | 同左 |
| 原生计划工具 | 另一路（cc/plan-tools）在做 | 同左 | 同左 | 同左 | 同左 | 同左 |
| 用量 | 原生按回合（缓存另报，加回）；✓ | 原生线程累计减基线；✓ | 原生按回合；✓ | 只报上下文占用，无回合用量 | 会话累计减基线（Hub 算）；✗ | 按转录逐次相加；✗ |
| 恢复 | 原生 session/load、resume；✓ | 原生 thread/resume；✓ | 原生 load；✓ | 原生 load；✓ | 原生 load（网关）；✓ | Gateway 会话键；✓ |
| 分叉 | 原生 session/fork；✓ | 原生 thread/fork；✓ | 未查 | 未查 | 未查 | 未查 |
| 附件 | 原生（图片、资源链接）；✓ | 原生（图片、文件提及）；✓ | 原生 ACP；✓ | 原生 ACP；✗ | 文本指针（它读不到资源链接）；✓ | 单段文本内写路径；✗ |
| 原生命令 | 原生目录；✓ | Hub 提供线程操作与技能；✓ | 原生目录；✓ | 原生目录；✓ | 原生目录 + Hub 补 /export；✓ | 原生目录；✓ |
| 改动 diff | Hub 自记 + 它自己报；✓ | Hub 自记 + 它自己报；✓ | Hub 自记 + 它自己报 | Hub 自记（它不报 diff） | Hub 自记（它不报 diff） | Hub 自记 |

**Hub 策略的答复规则**（`HUB_POLICIES`）：读、搜索、思考类请求一律允许，不问用户；提问永远交给用户；没选档位时全部交给用户。

| 档位 | 改文件 | 跑命令 | 联网 | 工具 | 其他 |
|---|---|---|---|---|---|
| 只规划 | 拒绝 | 拒绝 | 允许 | 问用户 | 拒绝 |
| 每步询问 | 问用户 | 问用户 | 问用户 | 问用户 | 问用户 |
| 自动改文件 | 允许 | 问用户 | 问用户 | 问用户 | 问用户 |
| 自动执行 | 允许 | 允许 | 允许 | 允许 | 允许 |
| 完全放行 | 允许 | 允许 | 允许 | 允许 | 允许 |

Hub 替用户做的决定都存成审批条目，决定人记为 `policy`，同时记下档位；页面上显示为“按「自动改文件」自动允许：…”。
