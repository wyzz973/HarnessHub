# 工程文档与阅读顺序

最新：[MCP 统一清单验收](verification/capability-mcp-2026-10-18.md)：从各 Harness 现有配置导入 MCP 服务器到一份清单（不存密钥值），按各家写法写入 Codex、Cursor、OpenCode、Gemini、Hermes，矩阵显示每个服务器在每个 Harness 的状态。[添加、更新与删除技能验收](verification/capability-packages-2026-10-18.md)：从 GitHub 添加技能到共享目录，按来源检查更新并更新，删除时连同指向它的链接与 lock 条目，三类修改都可以从快照撤销；与 npx skills 的 lock 互操作只改已有条目。[管理操作验收](verification/management-actions-2026-10-18.md)：经 4317 升级、卸载了两份 Claude Code，安装了 DeepSeek Harness 并确认它能完成初始化；修正了安装程序继承 Gateway 的 umask 077、装出 0600/0700 权限的问题。[ADR-045](decisions/0045-unified-capability-management.md)、[能力视图验收](verification/capabilities-view-2026-10-18.md)、[技能开关验收](verification/capability-switches-2026-10-18.md)与[放置与清理验收](verification/capability-placement-2026-10-18.md)：技能可以在各 Harness 中停用或启用，先显示精确差异、确认后写入并留备份；Hermes 可以经 `skills.external_dirs` 读取共享目录 `~/.agents/skills`，Claude Code 可以逐个放置共享技能，多余的链接可以清理并撤销；HarnessHub 写过、后来被外部移除或改动的设置会列出，不自动改回；侧栏“能力”页统一列出各 Harness 读取的技能、MCP、指令、子 Agent、命令、Hooks 与插件，以及每一项对每个 Harness 是否生效（第 1 步只读）；调研见[九个 Harness 的扩展能力配置](research/native-extension-configs-2026-10-18.md)与[跨 Agent 统一管理的开源做法](research/capability-managers-2026-10-18.md)。此前：[ADR-044](decisions/0044-macos-official-channels.md)与[探测验收](verification/official-channels-2026-10-17.md)、[卸载验收](verification/uninstall-2026-10-17.md)、[安装验收](verification/official-install-2026-10-17.md)、[逐份升级验收](verification/installation-upgrade-2026-10-17.md)：每份官网安装可按其渠道单独卸载（只删程序）和单独升级；没装的产品可以按官网方式代为安装；只面向 macOS；只按官网写明的安装渠道探测 Harness，多份安装全部列出并标出当前使用的一份，非官网安装只作说明，正式入口不读发现清单（[渠道调研](research/official-install-channels-2026-10-17.md)）。[阶段报告（2026-10-12）](verification/phase-report-2026-10-12.md)：按设计采纳、代码完成、测试通过、真实引擎通过与 Windows 分列，含完整能力 78/243、ADR-030～040 的状态与 4317 部署记录。[逐Harness原生能力矩阵](verification/native-capability-matrix.md)（生成自`plan/native-capabilities.json`）。[第一链路打磨](verification/first-chain-polish-2026-10-11.md)：版本显示、回合阶段与首字、失败说明、就绪状态与目录缓存（ADR-033）、审批说明、Codex 计划模式（ADR-034）、保留原生进程（[ADR-030](decisions/0030-retained-native-processes.md)，Session v11、v12，真实 Claude 后台任务跨回合与服务异常退出后的清理通过）、跨对话的待处理提醒与审批期限（[ADR-035](decisions/0035-attention-and-request-deadlines.md)，真实 Claude 审批通过，Hermes 受其自身缺陷阻塞）、并行与两个预算（ADR-036）、复制诊断信息（ADR-037）、未经验证的版本提示（ADR-038）、在原程序中继续（ADR-039）与从登录 shell 补充搜索目录（ADR-040）。[Claude 会话导出](verification/claude-export-2026-10-11.md)：`/export` 复制 Claude Code 自己的转录。[原生提问表单](verification/native-questions-2026-10-11.md)：Claude 的 AskUserQuestion 在对话中逐题提问。[子 Agent 活动](verification/native-subagents-2026-10-11.md)：子 Agent 运行的工具嵌套显示在它的调用之下（Claude 真实通过）。[Claude 真实验收补测与 ACP 审批详情](verification/claude-real-and-approval-detail-2026-10-11.md)：Claude 额度恢复后多项真实通过，ACP 审批显示将要修改的差异。[ADR-029](decisions/0029-continue-native-sessions.md)与[本机会话接续验收](verification/native-session-import-2026-10-11.md)：列出并接续原程序在本工作区的会话。[ADR-028](decisions/0028-native-configuration-sync.md)与[原生配置同步验收](verification/native-config-sync-2026-10-11.md)：原生命令改了所选设置后下一回合沿用原生值，显式切换才按所选应用，业务库v9。[ADR-027](decisions/0027-openclaw-transcript-reconciliation.md)与[OpenClaw 转录对账验收](verification/openclaw-transcript-2026-10-11.md)：OpenClaw 回合补记工具、用量并修正被桥掩盖的错误。[ADR-026](decisions/0026-native-extensions.md)与[原生扩展验收](verification/native-extensions-2026-10-11.md)：技能、MCP、插件只读视图与 Codex 技能调用。[ADR-025](decisions/0025-conversation-branches.md)与[分支验收](verification/native-branch-2026-10-11.md)：从回复分支，能精确复制时建立原生副本，业务库v8。[ADR-024](decisions/0024-native-session-operations.md)与[原生会话操作验收](verification/native-session-actions-2026-10-11.md)：Codex 线程审批策略与沙箱、Codex/Pi 原生压缩与导出、公开对话导出。[ADR-023](decisions/0023-attachment-input.md)与[附件输入验收](verification/native-attachments-2026-10-11.md)：文件、图片、音频按各原接口发送，模型看不到时派发前拒绝。[ADR-022](decisions/0022-native-activity-and-content-store.md)与[原生活动验收](verification/native-activity-2026-10-11.md)：工具详情、计划、用量、提示、活动与产物进入统一聊天，详情与产物存入内容存储，业务库v7。此前：[七个原安装能力面调研](research/native-capability-surfaces-2026-10-11.md)、[ADR-021](decisions/0021-native-profile-and-deviation-tolerance.md)与[第二轮验收](verification/native-capabilities-round2-2026-10-11.md)。完整能力仍进行中。

最新全部Harness原生能力标准：[ADR-020](decisions/0020-complete-native-harness-capabilities.md)、[逐Harness能力清单与本轮恢复证据](verification/complete-native-capabilities-2026-10-11.md)。完整能力仍进行中，原生绑定/增量恢复已实现，业务库现为v9。

当前以本机MVP切片推进；完整蓝图按各自状态管理。ADR-008/009/010/011/012及对应本机契约已认可，目录、控制和公共Session/静止切换已实现；本机Provider和HTTP/工作台按ADR-011实现；完整未来代理账本/自动路由等仍proposed。

最新快速选择与原生会话能力：[ADR-019](decisions/0019-native-session-experience.md)、[切换时延、模型/档位、审批与原对话证据](verification/native-session-experience-2026-10-11.md)。普通选择不再建立控制连接；公共库为v5。统一界面按各Harness原接口接出功能，原生checkpoint、多模态与持久后台任务仍按未验证边界记录。

最新本机管理与接入：[ADR-017](decisions/0017-native-installation-management.md)、[原安装/配置保护/原对话验收](verification/native-management-2026-10-11.md)。管理原渠道、保护模型与认证配置、保留未知结果；Homebrew升级限制、开发目录与各Harness真实回复分别说明。统一Provider管理后置。

本机原安装与OpenClaw修复：[ADR-016](decisions/0016-local-installation-and-openclaw.md)、[真实DeepSeek与当前对话验收](verification/local-openclaw-2026-10-11.md)。本机原安装优先，私有副本不得冒充本机升级。

最新原生接入：[ADR-015](decisions/0015-native-harness-models-and-switching.md)、[Multica调研](research/multica-native-models.md)、[真实模型与页面验收](verification/native-models-2026-10-11.md)。所有native入口默认沿用本机配置和登录，模型从原生接口读取，选择后直接切换；明确独立Provider仍属于显式覆盖。

最新故障与可用性审查：[ADR-014](decisions/0014-conversation-failure-recovery.md)、[对话恢复契约](contracts/provider-web-mvp.md#可恢复的对话交互adr-014)、[审查与验收](verification/conversation-recovery-2026-10-10.md)。连接失败不锁死对话，真正未知仍保留证据和资源检查；存储v3升级需保留备份。

最新实时对话：[ADR-013](decisions/0013-live-chat-experience.md)、[事实流与交互契约](contracts/provider-web-mvp.md#实时对话事实流adr-013)、[验收](verification/live-chat-2026-10-10.md)。已提交SSE、重连及聊天组件在本机验证；真实Codex使用本地确定性模型服务，云模型与其他Harness组合分别验收。

最新Harness管理与UI重做：[ADR-012](decisions/0012-harness-management-workbench.md)、[管理调研](research/harness-management.md)、[实际验证](verification/harness-management-2026-10-10.md)。本机私有安装、升级与动态图形操作作为新切片，完整自动择优仍后置。

最新工作台：[Provider与本机页面契约](contracts/provider-web-mvp.md)、[调研](research/provider-web.md)、[ADR-011](decisions/0011-provider-web-mvp.md)与[验证](verification/provider-web-2026-10-09.md)。自动择优按用户要求后置。

最新推进方式：先读 [MVP 顺序](engineering/mvp.md)与 [S01 检测契约](contracts/discovery.md)。用户明确本机核心优先；后续完整设计仍保留，但不以平台、发布或多发行版矩阵阻塞独立切片。[Harness 检测调研](research/harness-discovery.md)记录当前实现依据。

最新：[目录与控制契约](contracts/catalog-control.md)、[验证记录](verification/catalog-control-2026-10-09.md)；[Harness 发现与适配方案](proposals/harness-discovery-adaptation.md)保留来源与后续顺序。默认目录为 43 个产品/47 个控制入口；目录数量、协议握手和真实任务验证分别记录。

持续对话从[公共Session契约](contracts/public-session-mvp.md)与[Session验证](verification/public-session-2026-10-09.md)开始阅读：公共身份、SQLite历史、幂等、排队、切换、生效水位、崩溃unknown与CLI资源预算。

1. [第一阶段产品范围](product/phase-1.md) → [需求清单](product/requirements.md)。
2. [调研方法与结论](research/README.md) → [协议](research/protocols.md) → [开源实现](research/repositories.md) → [固定来源](research/source-lock.json)。
3. [统一语言](domain/language.md) → [限界上下文](domain/context-map.md) → [不变量](domain/invariants.md)。
4. [总体架构](architecture/overview.md) → [公共 API](contracts/public-api.md) → [适配接口](contracts/adapter-spi.md) → [运行生命周期](contracts/lifecycle.md)。
5. [路由](contracts/routing.md) → [上下文](contracts/context-transfer.md) → [切换](contracts/switching.md) → [存储与事件](contracts/storage-events.md) → [安全](contracts/security.md)。
6. [开发规则](engineering/development.md) → [AI 协作](engineering/ai-workflow.md) → [测试要求](engineering/testing.md) → [测试矩阵](engineering/test-matrix.md)。
7. [原子任务](../TASKS.md) → [设计就绪门禁](engineering/readiness.md) → [ADR](decisions/README.md)。

需求、任务和测试场景的唯一结构化来源分别是 plan/requirements.json、plan/tasks.json、plan/test-cases.json；人读表由工程检查工具生成并检查新鲜度。协议或 SDK 版本改变时更新来源与受影响契约，不能只改依赖版本。
