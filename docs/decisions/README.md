# 决策记录

下表七项完整架构议程的状态按 [ADR-046](0046-harness-focus-hardening.md) 的“对 ADR-001～007 的处置”一节记录（2026-10-21）：五项 accepted-by-implementation、ADR-005 部分实现、ADR-004 deferred。表中的建议、替代与代价保留；没有因生成文档而自动变为 accepted，accepted-by-implementation 也不等于原议程要求的独立 ADR 文件已交付。

已接受：[ADR-008](0008-local-first-mvp.md)（accepted）开放本机只读检测；[ADR-009](0009-catalog-control-slice.md)（accepted）依据用户开始实现的授权，开放目录扩展与受控原生控制连接。范围不等于全部未来架构已冻结。

[ADR-010](0010-public-session-mvp.md)（accepted）采纳本机公共Session、SQLite事实日志与每轮public_context_rehydrate、静止Harness切换；不自动采纳整套未来HTTP/模型转发/路由方案。

[ADR-011](0011-provider-web-mvp.md)（accepted）采纳本机Provider资源、不可变revision、私有配置与同源图形工作台；自动择优由用户明确后置。

[ADR-012](0012-harness-management-workbench.md)（accepted）按用户授权采纳本机Harness安装/升级与品牌化原生工作台，默认私有受管目录，自动择优不变。

[ADR-013](0013-live-chat-experience.md)（accepted）按实际对话反馈采纳实时会话SSE及紧凑聊天组件；不改变Run/选择/重试语义。

[ADR-014](0014-conversation-failure-recovery.md)（accepted）按用户审查要求区分连接失败/执行未知/清理未知，保留对话与草稿，加入显式恢复和结束确认；存储v3保留历史与未知事实，未知任务不自动重跑。

[ADR-015](0015-native-harness-models-and-switching.md)（accepted）按用户明确要求沿用所有本机Harness既有配置/登录，读取原生模型，并直接切换选择；覆盖先前native空HOME默认，追加v4格式。

| ADR | 建议 | 替代/代价 | 关闭条件 | 状态（ADR-046 处置） |
|---|---|---|---|---|
| ADR-001 | 公共 Session 与原生 BackendBinding 分离 | 直接暴露原生 ID 简单，但锁定 Harness，无法承载公共连续性 | D-02 与 D-04 冻结 | accepted-by-implementation（`src/contracts/session.ts` 的 nativeBindings） |
| ADR-002 | 模块化单体、DDD 上下文与防腐 Adapter | 微服务有部署/一致性成本；巨型统一模型会污染领域 | 边界与应用契约评审 | accepted-by-implementation（`src/contexts/` 的五个上下文） |
| ADR-003 | ACP v1 优先，原生协议单独适配 | 全部套 ACP 会丢失真实能力；只用 native 会重复生命周期逻辑 | D-01 能力报告 | accepted-by-implementation（`src/adapters/control/factory.ts`） |
| ADR-004 | 规则式路由、硬约束优先、质量未知如实表达 | LLM/学习排名可扩展，但缺校准证据、成本与可复现性 | D-07 基线与策略版本 | deferred（自动择优后置，ADR-011） |
| ADR-005 | 持久意图/outbox、epoch fencing、先提交后发布 | 直接调用简单，但响应丢失/重启会重复副作用；全量 Event Sourcing 复杂度高 | D-02 与故障模型评审 | 部分实现（先提交后发布与 epoch fencing 已实现；outbox 未实现） |
| ADR-006 | 静止交接、public_context_rehydrate 为明确等级 | 把原生内部状态强行互换无法泛化；只允许换新公共 Session 不符合需求 | D-03/D-04 冻结 | accepted-by-implementation（`src/contexts/session/domain/context.ts` 的 public_context_rehydrate） |
| ADR-007 | 模型目标独立，最小同协议桥接并记录调用 | 首版完整 N×M 转换扩大范围；直接传 Provider 秘密给 Harness 削弱归属 | D-01/D-06 与模型路径验证 | accepted-by-implementation（ADR-011） |

每条被采纳时拆成独立 ADR 文件，写清上下文、证据、决定、否决方案、失败边界、测试、迁移与日期。当前表是决策议程，不能在开发中以“表里写了”绕过未决条件。ADR-046 只记录处置与落地位置；独立文件是否补写由后续的契约 as-built 改写决定。

## 冻结交付所有权

ADR-001 由 C003，ADR-002/003 由 C008，ADR-004 由 C007，ADR-005 由 C004，ADR-006 由 C006，ADR-007 由 C010 交付独立记录；具体路径在任务唯一所有权中。索引由 V008 维护。

V008 必须核对每条核心 ADR 的 accepted/proposed 状态、契约/版本/验证证据、独立文件与索引一致性以及阻塞项。核心记录仍 proposed、缺证据或未交付时 G1 不通过；不能因为依赖图与格式检查通过就自动接受决定。

- [0016：本机原安装优先与OpenClaw原生接入](0016-local-installation-and-openclaw.md)（accepted；决定第一条“本机PATH/显式入口保持发现与执行权威”中的显式入口（发现清单）一项被 [ADR-044](0044-macos-official-channels.md) 部分取代：自 ADR-044 起正式入口不读发现清单，只在开发模式 `--allow-unofficial` 下读取）。
- [0017：原渠道安装管理与原生接入](0017-native-installation-management.md)（accepted；被 [ADR-043](0043-upgrade-with-running-programs.md) 与 [ADR-044](0044-macos-official-channels.md) 各部分取代一条：“发现活动本机进程时拒绝原地升级”改为先确认再按产品方式重启，“开发目录链接保留原入口”改为非官网安装不维护）：覆盖生产私有安装默认；真实本机管理、配置保护和明确能力边界，统一Provider管理后置。

- [0018：原生CLI认证与Homebrew单沙箱恢复](0018-native-cli-recovery.md)（accepted）：原Homebrew SDK配置保护恢复、Cursor原生更新/登录和Gemini直连协议边界。

- [0019：快速选择与原生会话能力](0019-native-session-experience.md)（accepted）：选择与连接分离；本机配置/思考/命令/审批及v5迁移。统一聊天界面承载各Harness原生功能。

- [ADR-020：全部接入的Harness按原生能力接出](0020-complete-native-harness-capabilities.md)（accepted，2026-10-11；完整能力仍进行中）：所有Harness的完整接入标准、原生绑定与恢复、能力缺口及逐项验收。

- [ADR-021：原生配置来源透传、原生协议偏差容忍与能力矩阵](0021-native-profile-and-deviation-tolerance.md)（accepted）：只透传用户真实设置的配置位置变量；正常协议偏差归一而不归属；不代为执行原生全局写；逐Harness能力矩阵由设计检查校验。

- [ADR-022：原生活动事实、内容存储与运行帧](0022-native-activity-and-content-store.md)（accepted）：工具详情、计划、用量、提示、活动与产物作为Run事实；详情与产物进入内容存储；Session v7；内容读取路由与SSE run帧。

- [ADR-023：文件、图片与音频输入](0023-attachment-input.md)（accepted）：原始字节上传与工作区暂存；附件随输入准入且不可变；派发前按代理与模型输入能力检查并复制为只读副本；各原接口映射与界面附件交互。

- [ADR-024：原生会话操作——权限设置、压缩与导出](0024-native-session-operations.md)（accepted）：Codex线程审批策略与沙箱只覆盖Hub线程并核实；Codex/Pi原生压缩与导出以命令名提供；ACP命令公告等待；公开对话导出。

- [ADR-025：对话分支与原生会话副本](0025-conversation-branches.md)（accepted）：分支为带引用历史的新Session；原生会话恰好在分支点时由Runner建立原生副本，否则以公共历史继续；Session v8。

- [ADR-026：原生扩展的只读视图与技能调用](0026-native-extensions.md)（accepted；否决“由 Hub 写技能或 MCP 配置”一条 2026-10-18 起被 [ADR-045](0045-unified-capability-management.md) 部分取代）：Codex/Pi 技能、MCP 与插件按需只读列出；Codex 技能以原生 skill 输入经命令调用。

- [ADR-027：OpenClaw 回合按原生转录对账](0027-openclaw-transcript-reconciliation.md)（accepted）：桥结束后读取本会话本轮追加的原生转录，补记工具、思考与用量并修正真实停止原因；直连 Gateway 暂缓（条件见正文）。

- [ADR-028：原生命令改设置后的同步](0028-native-configuration-sync.md)（accepted）：回合后记录原生回报的模型与选项；同一纪元下一回合按原生值应用被改动的所选值，显式切换才按所选；Session v9。

- [ADR-029：在 Hub 中接续本机原生会话](0029-continue-native-sessions.md)（accepted）：列出原程序在本工作区的会话，接续为带引用历史的新对话并直接继续原生会话；一个原生会话只有一个持有者；OpenClaw 不接续渠道会话。

- [ADR-030：在回合之间保留原生进程以运行后台任务](0030-retained-native-processes.md)（accepted，2026-10-12 实施，Session v11、v12）：采纳“需要时由用户选择结束后台进程”；按对话显式开启、默认关闭，空闲 30 分钟结束，最多保留 4 个；下一回合复用保留的进程，各种关闭都留证据；服务异常退出后，下一次启动按进程组号和启动时间识别并结束遗留的进程组，确认后才释放工作区；真实 Claude 后台任务跨回合与重启清理通过。

- [ADR-031：接入 Hermes Agent 与 DeepSeek Harness](0031-hermes-and-deepseek-harness.md)（accepted；“固定探测目录并复用探测会话”与“dsh 醒目显示权限预设”两项分别被 [ADR-033](0033-native-catalog-cache-and-readiness.md) 与[第一链路打磨](../verification/first-chain-polish-2026-10-11.md)部分取代；发现方式一节“非标准安装通过显式自定义入口接入”一条被 [ADR-044](0044-macos-official-channels.md) 取代——正式入口不读发现清单）：两者经内置 ACP 接入；Hermes 恢复只用 session/load、文件改为文本指针、60 秒审批期限、/model 回复同步；通用 ACP 的 load 回放窗口从响应开始；发现只走 PATH/标准目录与显式自定义入口（ADR-044 之前的做法，自定义入口现只用于开发和测试）。

- [ADR-032：记录并显示回合阶段与首字延迟](0032-run-phases-and-first-output.md)（accepted）：Run 记录受理、准备、就绪、发送、首个输出与结束（Session v10）；界面按阶段显示已用时间，结束后显示首字与用时。

- [ADR-033：本机目录缓存、就绪状态与探测会话](0033-native-catalog-cache-and-readiness.md)（accepted）：目录按配置指纹复用最长 24 小时并跨重启保存；选择器显示上次读取得到的就绪状态与通常启动用时，不在后台启动 Harness；读取目录建出的原生会话默认不列出；ACP 缺省 authMethods 按空列表处理，Hermes 未配置提供方时不建会话、提示 `hermes model`。

- [ADR-034：Codex 计划模式（实验接口按回合声明）](0034-codex-plan-mode.md)（accepted）：Codex 0.162.1 起提供“协作模式”（默认、计划）；只有明确选择协作模式的回合声明 experimentalApi；方案条目作为回复显示；打开线程时不再读取账号与技能。

- [ADR-035：跨对话的待处理提醒与审批期限](0035-attention-and-request-deadlines.md)（accepted）：审批与提问带服务端给出的最早期限并标明来源（原程序或回合）；侧栏标记等待中的对话并倒计时，到期即消失，决定只在对话内；每个页面一条长连接；回合期限到期的请求记为 expired；浏览器通知由用户开启，只含 Harness 名称与剩余时间。其中的回合期限部分已由 ADR-036 取代，改为等待预算，到期记为 `WAIT_EXPIRED` 取消。

- [ADR-036：等待用户决定的时间不计入回合期限](0036-approval-wait-budget.md)（accepted，已实施）：
  - 回合期限拆为执行预算（300 秒，从派发起算，等待用户时暂停）和等待预算（默认 30 分钟、上限 2 小时，覆盖等待用户决定和等待工作区），由 Runtime 计时。
  - 不同工作区的对话最多 4 个并行；同一工作区按受理先后可见排队，可以取消。
  - 等待到期以 `WAIT_EXPIRED` 取消并结算；排队到期以 `WORKSPACE_BUSY` 结束并带上持有者。
  - 修改了 lifecycle §3 和 INV-10。

- [ADR-037：复制一轮的诊断信息](0037-run-diagnostics.md)（accepted）：执行详情中复制本轮的版本、阶段、结束原因、清理状态与 stderr 最后 4 KiB；服务端现场拼装并清洗（路径、环境变量值、密钥样式字符串、账户名），不保存；默认不含对话内容。
- [ADR-038：未经验证的版本提示](0038-verified-version-hint.md)（accepted）：
  - 每个 Harness 记录真实验证过的版本范围（经适配器接入的还记录适配器版本），由测试与能力矩阵保持一致。
  - 本机版本不在范围内时，选择器与 Harnesses 列表提示“未经验证的版本”，不阻止使用。
  - 版本未知或从未验证的 Harness 不下结论。
  - Pi 与 DeepSeek Harness 两行的已验证版本来自非官网安装，按 [ADR-044](0044-macos-official-channels.md) 为历史证据（部分取代）；dsh 的继续命令与 Hermes 的版本读取由 ADR-046 第 1 项更新。
- [ADR-039：在原程序中继续原生会话](0039-continue-in-the-original-program.md)（accepted）：
  - 对话的执行配置显示原生会话 ID，并给出在原程序中继续的命令。
  - 交互形式按已安装版本的帮助给出，恢复机制以非交互形式真实验证；版本在验证范围内才给出命令。
  - Cursor 与 Gemini 未验证，只显示 ID；Pi 指向它自己的会话列表；OpenClaw 不显示。
  - 不进入会话视图和导出，Hub 不执行这些命令。
- [ADR-040：从登录 shell 补充搜索目录](0040-login-shell-search-directories.md)（accepted）：
  - 用户在 Harnesses 页触发时，才以 `$SHELL -l -c` 读取一次 PATH；shell 须列在 `/etc/shells`，限 3 秒、64 KiB，结束整个进程组。
  - 只加入 Gateway 尚未搜索的目录，用于发现与新对话，可逐项移除；不写入 Gateway 环境。
  - CI 与 Windows 不提供。
  - G(i)（DSH Desktop 的命令位置）因没有官方证据而取消。
- [ADR-041：显式指定工作区租约目录，测试不再写入共享目录](0041-workspace-lock-root.md)（accepted）：
  - `web`、`chat`、`sessions` 支持 `--workspace-lock-root <绝对目录>`，默认仍为每个本机用户共用的 `/tmp/harnessgateway-workspaces-<uid>`。
  - 显式目录必须是规范化的绝对路径，私有且属于当前用户；另用目录会失去与本机其他 Gateway 的互斥，只用于隔离的测试或刻意独立的实例。
  - 测试一律使用自己的临时租约目录。已有文件的清理和 `/tmp` 不耐久的问题，下一阶段先写提案。
- [ADR-042：重写 Web 界面，沿用数据层与对话状态逻辑](0042-frontend-redesign.md)（accepted）：
  - 全部视图按用户确认的设计稿重写；数据层与对话状态逻辑（幂等键、草稿、切换、重连）不改行为。
  - Tailwind CSS v4、Base UI、Shiki（按需加载、JavaScript 正则引擎）；Geist 随前端打包。补充：中文按用户选择从 Google Fonts 加载 Noto Sans SC，内容安全策略只为它放开 `fonts.googleapis.com` 与 `fonts.gstatic.com`。
  - 侧栏按状态分组与收件箱、审批卡片放在对话里、过程折叠摘要、详情栏、暂存下一条消息、命令面板与明暗主题。
  - 不做：对话重命名、置顶、归档（需要后端元数据），差异行评论。
- [ADR-043：升级时处理正在使用安装的程序](0043-upgrade-with-running-programs.md)（accepted）：
  - 取代 ADR-017 中“发现活动本机进程时拒绝原地升级”一条。按用户决定，升级前先列出会重启、会关闭和仍用旧版本的程序，用户同意后在新版本核实后立即按产品自己的方式重启它的后台服务（launchd `kickstart -k`）。
  - HarnessHub 自己的空闲进程先关闭；正在回复的对话、其他 HarnessHub 进程、不满足的 Node.js 要求阻止升级；写记录的进程已结束的旧记录在维护锁内清除。
  - 管理库 v3（只改版本号，附经过测试的降级 SQL）；业务库仍是 v12。
- [ADR-044：只面向 macOS，按官网安装渠道探测和维护 Harness](0044-macos-official-channels.md)（accepted）：
  - 程序落在产品官网写明的渠道里才算已安装；同一产品的多份安装全部列出并标出当前使用的一份；正式入口默认只认官网。
  - 每份官网安装可按其渠道单独卸载（只删程序）、单独升级；没装的产品可以按官网方式代为安装。每次都先确认，写入在沙箱里受限。
  - 管理库升到 v6，附逐级降级 SQL。
- [ADR-045：统一管理各 Harness 的能力](0045-unified-capability-management.md)（accepted）：
  - 技能、MCP、指令、子 Agent、命令、Hooks、插件在一个“能力”页统一查看；只改用户级配置，每次写入先预览并经用户确认，只认领自己写入的条目。取代 ADR-026 的否决条。
  - 技能以 `~/.agents/skills` 为唯一实体，只给 Claude（逐个链接）和 Hermes（`external_dirs`）放置；按 Harness 停用写各家自己的配置。
  - MCP 由 HarnessHub 保存只含变量名的清单，按各家格式写入；OpenClaw 的 MCP 与插件装卸推迟到升级之后。分六步实施，第 1 步是只读统一视图。
- [ADR-046：聚焦七个 Harness 的工程加固切片](0046-harness-focus-hardening.md)（accepted，2026-10-21，总指挥兼审批代理裁决）：
  - 方向由用户决定：只支持 Claude Code、Codex、OpenCode、DeepSeek Harness、WorkBuddy、Hermes Agent 并做精；同日补充 OpenClaw 保留并加入接入清单，共七个。
  - 切片 harness-focus 承接第一批六项加固：版本单一来源与一致性检查（预发布语义）、失败写入记录去路径化与 history 逐条降级、流式输出按窗口合并提交（ADR-047）、G063 边界检查落地、Claude 认证状态与 OpenCode `/compact` 接出、非焦点三个（Cursor、Gemini CLI、Pi）即日冻结。
  - 处置 ADR-001～007（见上表）；`VERIFIED_VERSIONS` 的数字在真实重验收前不改。
- [ADR-047：流式输出按窗口合并提交](0047-stream-output-coalescing.md)（accepted，2026-10-21，总指挥兼审批代理裁决）：每回合的事件数与提交成本降一个量级，先提交再发布不变。
- [ADR-048：七个焦点 Harness 的范围、完成定义与 WorkBuddy 接入路线](0048-harness-scope-and-workbuddy.md)（accepted，2026-10-21，用户回复“全部按推荐”）：
  - 五层完成定义（设计采纳 / 代码完成 / 测试通过 / 真实引擎通过 / 只面向 macOS）与“做精”的判据。
  - 用户决定：非焦点三个冻结并默认隐藏；WorkBuddy 接应用内嵌 CLI、共用 `~/.workbuddy`，id `workbuddy`；Claude 按版本区间加冒烟；dsh 以 0.2.0-rc.2 为基线尽快重验；Hermes 先只读研究；业务库迁移前备份保留 2 份；审计保留 90 天、可导出、手工操作补记、凭据默认打码；页面在重新检测、任务完成与切回窗口（至少间隔 60 秒）时刷新，不再轮询。
  - 审批代理裁决（2026-10-22）：两个门禁标志删除，G0～G5 改写为五层完成定义的门禁；矩阵新增 ☑ 终态（原接口部分提供、Hub 已尽，须写明缺口）、Harness 分层（焦点/冻结，冻结的 ✅ 数不得超过 `complete_at_freeze`）、仓库内证据规则与 `historical` 标记；OpenClaw 的卸载以替身验证代替真实执行。
  - 待定：WorkBuddy 的遥测开关（用户）。
- [ADR-049：业务库迁移前备份](0049-business-store-backup-before-migration.md)（accepted，2026-10-22，第二批 C4）：每次业务库版本提升前用 `VACUUM INTO` 在数据根的 backups 目录留备份，只保留最新 2 份；备份失败则迁移不发生（`STORAGE_BACKUP_FAILED`，user_version 不变、不接管 owner）。
- [ADR-050：Harness 分层与按需刷新](0050-harness-tiers-and-on-demand-refresh.md)（accepted，2026-10-22，第二批 C3）：目录按 focus、frozen、catalog 分层（`HarnessView.tier`），冻结的三个默认不在选择器、欢迎页、“我的 Agent”与能力页里，设置开关可再显示，停在它们上面的对话照常打开；页面不再后台轮询，重新检测、安装任务完成与窗口重新获焦（至少间隔 60 秒）时刷新。
- [ADR-051：Hermes 升级路线](0051-hermes-upgrade-route.md)（proposed，2026-10-22，第二批 C6）：对 v0.22.2 标签与当时 main 的只读研究（网关投影的启用条件、认证、审批期限、`/model` 回复、会话导出、迁移）后的升级路线草案；期间停在 0.12.0。
- [ADR-052：OpenClaw 升级路线](0052-openclaw-upgrade-route.md)（proposed，2026-10-22，第二批 C6）：2026.10.x 升级就绪研究后的路线草案；2026-10-17 用户点击升级被目标版本的配置校验拦下，原安装 2026.3.23-2 保留。
