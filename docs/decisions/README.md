# 决策记录

下表七项完整架构议程仍为 proposed，记录建议、替代与代价；没有因生成文档而自动变为 accepted。

已接受：[ADR-008](0008-local-first-mvp.md)开放本机只读检测；[ADR-009](0009-catalog-control-slice.md)依据用户开始实现的授权，开放目录扩展与受控原生控制连接。范围不等于全部未来架构已冻结。

[ADR-010](0010-public-session-mvp.md)采纳本机公共Session、SQLite事实日志与每轮public_context_rehydrate、静止Harness切换；不自动采纳整套未来HTTP/模型转发/路由方案。

[ADR-011](0011-provider-web-mvp.md)采纳本机Provider资源、不可变revision、私有配置与同源图形工作台；自动择优由用户明确后置。

[ADR-012](0012-harness-management-workbench.md)按用户授权采纳本机Harness安装/升级与品牌化原生工作台，默认私有受管目录，自动择优不变。

[ADR-013](0013-live-chat-experience.md)按实际对话反馈采纳实时会话SSE及紧凑聊天组件；不改变Run/选择/重试语义。

[ADR-014](0014-conversation-failure-recovery.md)按用户审查要求区分连接失败/执行未知/清理未知，保留对话与草稿，加入显式恢复和结束确认；存储v3保留历史与未知事实，未知任务不自动重跑。

[ADR-015](0015-native-harness-models-and-switching.md)按用户明确要求沿用所有本机Harness既有配置/登录，读取原生模型，并直接切换选择；覆盖先前native空HOME默认，追加v4格式。

| ADR | 建议 | 替代/代价 | 关闭条件 |
|---|---|---|---|
| ADR-001 | 公共 Session 与原生 BackendBinding 分离 | 直接暴露原生 ID 简单，但锁定 Harness，无法承载公共连续性 | D-02 与 D-04 冻结 |
| ADR-002 | 模块化单体、DDD 上下文与防腐 Adapter | 微服务有部署/一致性成本；巨型统一模型会污染领域 | 边界与应用契约评审 |
| ADR-003 | ACP v1 优先，原生协议单独适配 | 全部套 ACP 会丢失真实能力；只用 native 会重复生命周期逻辑 | D-01 能力报告 |
| ADR-004 | 规则式路由、硬约束优先、质量未知如实表达 | LLM/学习排名可扩展，但缺校准证据、成本与可复现性 | D-07 基线与策略版本 |
| ADR-005 | 持久意图/outbox、epoch fencing、先提交后发布 | 直接调用简单，但响应丢失/重启会重复副作用；全量 Event Sourcing 复杂度高 | D-02 与故障模型评审 |
| ADR-006 | 静止交接、public_context_rehydrate 为明确等级 | 把原生内部状态强行互换无法泛化；只允许换新公共 Session 不符合需求 | D-03/D-04 冻结 |
| ADR-007 | 模型目标独立，最小同协议桥接并记录调用 | 首版完整 N×M 转换扩大范围；直接传 Provider 秘密给 Harness 削弱归属 | D-01/D-06 与模型路径验证 |

每条被采纳时拆成独立 ADR 文件，写清上下文、证据、决定、否决方案、失败边界、测试、迁移与日期。当前表是决策议程，不能在开发中以“表里写了”绕过未决条件。

## 冻结交付所有权

ADR-001 由 C003，ADR-002/003 由 C008，ADR-004 由 C007，ADR-005 由 C004，ADR-006 由 C006，ADR-007 由 C010 交付独立记录；具体路径在任务唯一所有权中。索引由 V008 维护。

V008 必须核对每条核心 ADR 的 accepted/proposed 状态、契约/版本/验证证据、独立文件与索引一致性以及阻塞项。核心记录仍 proposed、缺证据或未交付时 G1 不通过；不能因为依赖图与格式检查通过就自动接受决定。

- [0016：本机原安装优先与OpenClaw原生接入](0016-local-installation-and-openclaw.md)（accepted）。
- [0017：原渠道安装管理与原生接入](0017-native-installation-management.md)（accepted）：覆盖生产私有安装默认；真实本机管理、配置保护和明确能力边界，统一Provider管理后置。

- [0018：原生CLI认证与Homebrew单沙箱恢复](0018-native-cli-recovery.md)（accepted）：原Homebrew SDK配置保护恢复、Cursor原生更新/登录和Gemini直连协议边界。

- [0019：快速选择与原生会话能力](0019-native-session-experience.md)（accepted）：选择与连接分离；本机配置/思考/命令/审批及v5迁移。统一聊天界面承载各Harness原生功能。

- [ADR-020：全部接入的Harness按原生能力接出](0020-complete-native-harness-capabilities.md)：所有Harness的完整接入标准、原生绑定与恢复、能力缺口及逐项验收。

- [ADR-021：原生配置来源透传、原生协议偏差容忍与能力矩阵](0021-native-profile-and-deviation-tolerance.md)（accepted）：只透传用户真实设置的配置位置变量；正常协议偏差归一而不归属；不代为执行原生全局写；逐Harness能力矩阵由设计检查校验。

- [ADR-022：原生活动事实、内容存储与运行帧](0022-native-activity-and-content-store.md)（accepted）：工具详情、计划、用量、提示、活动与产物作为Run事实；详情与产物进入内容存储；Session v7；内容读取路由与SSE run帧。

- [ADR-023：文件、图片与音频输入](0023-attachment-input.md)（accepted）：原始字节上传与工作区暂存；附件随输入准入且不可变；派发前按代理与模型输入能力检查并复制为只读副本；各原接口映射与界面附件交互。

- [ADR-024：原生会话操作——权限设置、压缩与导出](0024-native-session-operations.md)（accepted）：Codex线程审批策略与沙箱只覆盖Hub线程并核实；Codex/Pi原生压缩与导出以命令名提供；ACP命令公告等待；公开对话导出。

- [ADR-025：对话分支与原生会话副本](0025-conversation-branches.md)（accepted）：分支为带引用历史的新Session；原生会话恰好在分支点时由Runner建立原生副本，否则以公共历史继续；Session v8。

- [ADR-026：原生扩展的只读视图与技能调用](0026-native-extensions.md)（accepted）：Codex/Pi 技能、MCP 与插件按需只读列出；Codex 技能以原生 skill 输入经命令调用。

- [ADR-027：OpenClaw 回合按原生转录对账](0027-openclaw-transcript-reconciliation.md)（accepted）：桥结束后读取本会话本轮追加的原生转录，补记工具、思考与用量并修正真实停止原因；直连 Gateway 暂缓（条件见正文）。

- [ADR-028：原生命令改设置后的同步](0028-native-configuration-sync.md)（accepted）：回合后记录原生回报的模型与选项；同一纪元下一回合按原生值应用被改动的所选值，显式切换才按所选；Session v9。

- [ADR-029：在 Hub 中接续本机原生会话](0029-continue-native-sessions.md)（accepted）：列出原程序在本工作区的会话，接续为带引用历史的新对话并直接继续原生会话；一个原生会话只有一个持有者；OpenClaw 不接续渠道会话。

- [ADR-030：在回合之间保留原生进程以运行后台任务](0030-retained-native-processes.md)（accepted，2026-10-12 实施，Session v11、v12）：采纳“需要时由用户选择结束后台进程”；按对话显式开启、默认关闭，空闲 30 分钟结束，最多保留 4 个；下一回合复用保留的进程，各种关闭都留证据；服务异常退出后，下一次启动按进程组号和启动时间识别并结束遗留的进程组，确认后才释放工作区；真实 Claude 后台任务跨回合与重启清理通过。

- [ADR-031：接入 Hermes Agent 与 DeepSeek Harness](0031-hermes-and-deepseek-harness.md)（accepted）：两者经内置 ACP 接入；Hermes 恢复只用 session/load、文件改为文本指针、60 秒审批期限、/model 回复同步；通用 ACP 的 load 回放窗口从响应开始；发现只走 PATH/标准目录与显式自定义入口。

- [ADR-032：记录并显示回合阶段与首字延迟](0032-run-phases-and-first-output.md)（accepted）：Run 记录受理、准备、就绪、发送、首个输出与结束（Session v10）；界面按阶段显示已用时间，结束后显示首字与用时。

- [ADR-033：本机目录缓存、就绪状态与探测会话](0033-native-catalog-cache-and-readiness.md)（accepted）：目录按配置指纹复用最长 24 小时并跨重启保存；选择器显示上次读取得到的就绪状态与通常启动用时，不在后台启动 Harness；读取目录建出的原生会话默认不列出；ACP 缺省 authMethods 按空列表处理，Hermes 未配置提供方时不建会话、提示 `hermes model`。

- [ADR-034：Codex 计划模式（实验接口按回合声明）](0034-codex-plan-mode.md)（accepted）：Codex 0.162.1 起提供“协作模式”（默认、计划）；只有明确选择协作模式的回合声明 experimentalApi；方案条目作为回复显示；打开线程时不再读取账号与技能。

- [ADR-035：跨对话的待处理提醒与审批期限](0035-attention-and-request-deadlines.md)（accepted）：审批与提问带服务端给出的最早期限并标明来源（原程序或回合）；侧栏标记等待中的对话并倒计时，到期即消失，决定只在对话内；每个页面一条长连接；回合期限到期的请求记为 expired；浏览器通知由用户开启，只含 Harness 名称与剩余时间。

- [ADR-036：等待用户决定的时间不计入回合期限](0036-approval-wait-budget.md)（accepted，待实施）：回合期限拆为执行预算（300 秒）与等待预算（默认 30 分钟、上限 2 小时），计时改归 Runtime；先实现不同工作区的有界并行，再交付等待预算；等待到期以 `WAIT_EXPIRED` 取消并结算；`WORKSPACE_BUSY` 带持有者。

- [ADR-037：复制一轮的诊断信息](0037-run-diagnostics.md)（accepted）：执行详情中复制本轮的版本、阶段、结束原因、清理状态与 stderr 最后 4 KiB；服务端现场拼装并清洗（路径、环境变量值、密钥样式字符串、账户名），不保存；默认不含对话内容。
