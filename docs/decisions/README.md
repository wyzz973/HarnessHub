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

- [ADR-034：Codex 计划模式（实验接口按回合声明）](0034-codex-plan-mode.md)（accepted；2026-10-22 按 [ADR-053](0053-latest-version-baseline.md) 修订）：Codex 的“协作模式”（默认、计划）总是作为选项提供，打开线程时 `collaborationMode/list` 不可用即明确失败，不按版本号开关；只有明确选择协作模式的回合声明 experimentalApi；方案条目作为回复显示；打开线程时不再读取账号与技能；“按已验证区间门控”的计划撤销。

- [ADR-035：跨对话的待处理提醒与审批期限](0035-attention-and-request-deadlines.md)（accepted）：审批与提问带服务端给出的最早期限并标明来源（原程序或回合）；侧栏标记等待中的对话并倒计时，到期即消失，决定只在对话内；每个页面一条长连接；回合期限到期的请求记为 expired；浏览器通知由用户开启，只含 Harness 名称与剩余时间。其中的回合期限部分已由 ADR-036 取代，改为等待预算，到期记为 `WAIT_EXPIRED` 取消。第 6 项的界面由 ADR-054 修订：入口改为“等你处理”，一次性选项可在收件箱直接决定，等待状态说“等你批准”“等你回答”。

- [ADR-036：等待用户决定的时间不计入回合期限](0036-approval-wait-budget.md)（accepted，已实施）：
  - 回合期限拆为执行预算（300 秒，从派发起算，等待用户时暂停）和等待预算（默认 30 分钟、上限 2 小时，覆盖等待用户决定和等待工作区），由 Runtime 计时。
  - 不同工作区的对话最多 4 个并行；同一工作区按受理先后可见排队，可以取消。
  - 等待到期以 `WAIT_EXPIRED` 取消并结算；排队到期以 `WORKSPACE_BUSY` 结束并带上持有者。
  - 修改了 lifecycle §3 和 INV-10。

- [ADR-037：复制一轮的诊断信息](0037-run-diagnostics.md)（accepted）：执行详情中复制本轮的版本、阶段、结束原因、清理状态与 stderr 最后 4 KiB；服务端现场拼装并清洗（路径、环境变量值、密钥样式字符串、账户名），不保存；默认不含对话内容。
- [ADR-038：未经验证的版本提示](0038-verified-version-hint.md)（superseded by [ADR-053](0053-latest-version-baseline.md)，2026-10-22）：
  - 原决定：每个 Harness 记录真实验证过的版本范围，本机版本不在范围内时提示“未经验证的版本”，由测试与能力矩阵四处对账。
  - 2026-10-22 起版本表、判定、显示与对账全部作废；文中的验证记录（2.1.296、2.1.306、0.2.0-rc.2 等）只作工程证据保留，代码不再读取。
- [ADR-039：在原程序中继续原生会话](0039-continue-in-the-original-program.md)（accepted；2026-10-22 按 ADR-053 修订）：
  - 对话的执行配置显示原生会话 ID，并给出在原程序中继续的命令。
  - 命令按产品给出，与安装版本无关：交互形式按最新正式版的帮助核对，一次性形式在最新正式版上真实核对，核对时的版本只作证据写在表里。
  - 没有续接命令的产品（Cursor、Gemini）只显示 ID；Pi 指向它自己的会话列表；OpenClaw 不显示；DeepSeek Harness 只给一次性命令并附凭据前提。
  - 读取不触发发现与版本探测；不进入会话视图和导出，Hub 不执行这些命令。
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
  - 2026-11-01 补充：声明了官方升级顺序的产品（OpenClaw 的 npm 安装）由它自己的命令停止与启动，HarnessHub 运行它的 Doctor，配置迁移记为 `configurationMigrated`（[ADR-052](0052-openclaw-upgrade-route.md) 实现裁决）。
- [ADR-044：只面向 macOS，按官网安装渠道探测和维护 Harness](0044-macos-official-channels.md)（accepted；2026-11-01 补充 OpenCode 2 的渠道与安装命令）：
  - 程序落在产品官网写明的渠道里才算已安装；同一产品的多份安装全部列出并标出当前使用的一份；正式入口默认只认官网。
  - 每份官网安装可按其渠道单独卸载（只删程序）、单独升级；没装的产品可以按官网方式代为安装。每次都先确认，写入在沙箱里受限。
  - 管理库升到 v6，附逐级降级 SQL。
- [ADR-045：统一管理各 Harness 的能力](0045-unified-capability-management.md)（accepted；2026-11-01 补充 OpenCode 2 的两种配置写法）：
  - 技能、MCP、指令、子 Agent、命令、Hooks、插件在一个“能力”页统一查看；只改用户级配置，每次写入先预览并经用户确认，只认领自己写入的条目。取代 ADR-026 的否决条。
  - 技能以 `~/.agents/skills` 为唯一实体，只给 Claude（逐个链接）和 Hermes（`external_dirs`）放置；按 Harness 停用写各家自己的配置。
  - MCP 由 HarnessHub 保存只含变量名的清单，按各家格式写入；OpenClaw 的 MCP 与插件装卸推迟到升级之后。分六步实施，第 1 步是只读统一视图。
- [ADR-046：聚焦七个 Harness 的工程加固切片](0046-harness-focus-hardening.md)（accepted，2026-10-21，总指挥兼审批代理裁决）：
  - 方向由用户决定：只支持 Claude Code、Codex、OpenCode、DeepSeek Harness、WorkBuddy、Hermes Agent 并做精；同日补充 OpenClaw 保留并加入接入清单，共七个。
  - 切片 harness-focus 承接第一批六项加固：版本单一来源与一致性检查（预发布语义）、失败写入记录去路径化与 history 逐条降级、流式输出按窗口合并提交（ADR-047）、G063 边界检查落地、Claude 认证状态与 OpenCode `/compact` 接出、非焦点三个（Cursor、Gemini CLI、Pi）即日冻结。
  - 处置 ADR-001～007（见上表）。第 1 项（版本单一来源与一致性检查）与第 5 项中“OpenCode 在 1.18.x 补 `/compact`”2026-10-22 起被 [ADR-053](0053-latest-version-baseline.md) 取代：版本表与对账删除，`/compact` 在目录未列出时对任何版本补入。
- [ADR-047：流式输出按窗口合并提交](0047-stream-output-coalescing.md)（accepted，2026-10-21，总指挥兼审批代理裁决）：每回合的事件数与提交成本降一个量级，先提交再发布不变。
- [ADR-048：七个焦点 Harness 的范围、完成定义与 WorkBuddy 接入路线](0048-harness-scope-and-workbuddy.md)（accepted，2026-10-21，用户回复“全部按推荐”）：
  - 五层完成定义（设计采纳 / 代码完成 / 测试通过 / 真实引擎通过 / 只面向 macOS）与“做精”的判据。
  - 用户决定：非焦点三个冻结并默认隐藏；WorkBuddy 接应用内嵌 CLI、共用 `~/.workbuddy`，id `workbuddy`；Claude 以最新正式版为基线，新版本发布后的回归只作开发侧动作（原“区间加冒烟”按 [ADR-053](0053-latest-version-baseline.md) 修订）；dsh 以 npm latest 为基线（原“精确基线 0.2.0-rc.2”，同上修订；0.2.0-rc.2 的重验保留为证据）；Hermes 基线是最新正式版，是否进入用户网关待用户（原“先只读研究、停在 0.12.0”）；业务库迁移前备份保留 2 份；审计保留 90 天、可导出、手工操作补记、凭据默认打码；页面在重新检测、任务完成与切回窗口（至少间隔 60 秒）时刷新，不再轮询。
  - 审批代理裁决（2026-10-22）：两个门禁标志删除，G0～G5 改写为五层完成定义的门禁；矩阵新增 ☑ 终态（原接口部分提供、Hub 已尽，须写明缺口）、Harness 分层（焦点/冻结，冻结的 ✅ 数不得超过 `complete_at_freeze`）、仓库内证据规则与 `historical` 标记；OpenClaw 的卸载以替身验证代替真实执行。
  - 待定：WorkBuddy 的遥测开关（用户）。
- [ADR-049：业务库迁移前备份](0049-business-store-backup-before-migration.md)（accepted，2026-10-22，第二批 C4）：每次业务库版本提升前用 `VACUUM INTO` 在数据根的 backups 目录留备份，只保留最新 2 份；备份失败则迁移不发生（`STORAGE_BACKUP_FAILED`，user_version 不变、不接管 owner）。
- [ADR-050：Harness 分层与按需刷新](0050-harness-tiers-and-on-demand-refresh.md)（accepted，2026-10-22，第二批 C3）：目录按 focus、frozen、catalog 分层（`HarnessView.tier`），冻结的三个默认不在选择器、欢迎页、“我的 Agent”与能力页里，设置开关可再显示，停在它们上面的对话照常打开；页面不再后台轮询，重新检测、安装任务完成与窗口重新获焦（至少间隔 60 秒）时刷新。
- [ADR-051：Hermes 最新版的接入方式](0051-hermes-upgrade-route.md)（accepted，用户 2026-10-22 答复允许；A2 的预检 2026-11-01 落地；原为 2026-10-22 第二批 C6 的只读研究，同日按 ADR-053 重写）：最新版 v0.22.4 的 `hermes acp` 只是网关的查看器，没有进程内模式；钉住 v0.22.2（A1）、停在 0.12.0 作终态（B）与“≥ 0.22.3 拒绝建会话”（第 8 条）按用户原则撤销；采纳 A2——HarnessHub 的 Hermes 会话附着到用户正在运行的兼容网关：建会话前的只读预检（gateway.sock、gateway_state.json、gateway.pid/.lock、install-stamp.json、`launchctl print`、`ps`）只在判定 A 时启动 `hermes acp`，B（会停掉旧网关换新）、C（会等 60 秒）、D（会拉起 launchd 服务）、E（会起无监督守护进程）以 `NATIVE_GATEWAY_UNAVAILABLE` 拒绝并给出 Hermes 自己的命令，从不启动、停止或替换用户的网关；没有网关查看器的检出照常在进程内运行。未知结果契约与 60 秒例外的退出条件仍待做；真实两步验收待运行。
- [ADR-052：OpenClaw 升级路线](0052-openclaw-upgrade-route.md)（accepted，2026-11-01；2026-10-22 作为第二批 C6 的只读研究提出并按 ADR-053 修订）：轨道 latest（点击时解析 npm latest），保留上游要求的 2026.9.5 中间跳；用户答复“由你直接升级”后，2026-11-01 实现裁决定为上游文档的显式顺序，由“升级 Harness”驱动：`openclaw gateway stop` → 每跳 npm 安装（`--allow-scripts=openclaw`）、核实、`openclaw doctor --fix --yes` → `openclaw gateway start` 与恢复判定（不 kickstart）→ `status --deep` 入日志 → `openclaw node restart`；确认框显示跳与命令原文，要求先 `openclaw backup create` 并勾选（`backupConfirmed`），每跳的 Node.js 要求都核对；事实 `hops`、`services`、`configurationMigrated`。不调用 `openclaw update`；2026-10-22 的过渡措施（npm 直装返回 `UNSUPPORTED_UPGRADE`）成为历史，逐份升级路径对 OpenClaw 仍拒绝单独直装。
- [ADR-053：按各 Harness 的最新正式版适配，版本只作工程证据](0053-latest-version-baseline.md)（accepted，2026-10-22，用户原则“接入不限定版本，默认按最新版”）：
  - 任何官网渠道的安装、任何版本（包括读不出版本的）都能接入；不再按版本号提示或劝阻；续接命令按产品对任何版本给出；读表每家一张、`checkedOn` 只作证据；功能按程序实际报告的能力判断，缺的能力在用到时明确失败并带原因；升级目标是渠道最新版；真实验收以验收当日的最新正式版为对象。
  - 取代 ADR-038 全文，修订 ADR-031/034/035/036/039/043/044/045/046/048/050，重排 ADR-051/052 的选项；登记 Hermes 0.12 的 60 秒审批期限为唯一例外及其退出条件；撤销 ADR-034 第 37 行、ADR-051 第 8 条、ADR-052 T-OC-11、ADR-048 决定 3 页面冒烟入口等已登记的版本门槛计划。
  - 三项产品取舍由审批代理裁决：Claude 会话关闭 promptSuggestions；`/remote-control` 在 HarnessHub 不支持；Hermes 0.12 期限作例外。
  - 2026-11-01 补记用户对第 2 题的答复“直接换到 OpenCode 2”：OpenCode 1 与 2 是共用命令与目录的两条产品线，哪条装着由渠道记录判定（包名、formula、tap、脚本的 opencode2 垫片），不是版本门槛；两条线的渠道都登记（ADR-044 补充），读表读两种配置写法、写入写文件已有的写法（ADR-045 补充），续接命令附产品线说明（ADR-039 补充），真实验收手册 6.5 节按 V2 重写。
- [ADR-054：设计语言 2.0：中性外观、系统字体、校准的动效与新图标](0054-design-language-2.md)（accepted，2026-11-01，用户要求按设计稿第 20 版实现）：
  - 取代 ADR-042 的视觉方向与第 4 节（字体与内容安全策略）：正文改用系统字体，代码保留 Geist Mono，不再加载 Google Fonts，内容安全策略恢复为只允许本机网关
  - 修订 ADR-042 第 5 节：侧栏按项目归组、等你处理成为常驻入口；审批停在输入框的位置（⏎ 允许一次、esc 拒绝）
  - 动效按 Claude 桌面版与 Codex 的实际数值校准；应用图标改为“一点分发”；只显示网关已有的事实
  - 2026-11-02 补充集成时的取舍（审批代理裁定）：详情面板默认关闭；Agent 详情在宽屏是卡片旁的侧栏；能力页与 Agent 页没有返回箭头；两种等待状态全站只说“等你批准”“等你回答”；用户停止的回合写“已停止”；完成通知仍不写对话标题
  - 2026-11-02 用户决定：界面上这个概念叫“Harness”（推翻补充 Q，画板里的“Agent”也一并改为“Harness”）
- [ADR-055：接力与上下文调度（HarnessHub Relay）](0055-relay-and-context-scheduling.md)（accepted，2026-11-03；设计正文为[接力系统终稿](../proposals/relay/relay-architecture.md)；已实现 G067、G075 与 G070 的 v12 过渡版交接单，合成测试通过，真机冒烟两对：OpenCode → DeepSeek Harness → OpenCode 全程通过；Claude Code → Codex → Claude Code 的交接单一步通过，回到 Claude Code（haiku）时答错了一份内容正确的增量（见验证记录））：原生位置与送达水位分开，水位只凭正面送达证据推进；交接单由公共事实确定性生成，按预算分层并附省略账目，历史再长也不失败；外来事实为空时零注入，命令与清空按原生语义；跨 Harness 发出的内容先脱敏，跨厂商交接按目的厂商键取得同意；业务库 v13；实施任务 G066–G077，D1–D11 已按推荐项接受。
- [ADR-056：原生宿主与会话租借——会话是数据，进程是可以切换会话的宿主](0056-native-hosts-and-sessions.md)（accepted，2026-11-03，D1–D7 按推荐项接受；设计正文为[原生宿主与会话租借设计](../proposals/native-hosts/design.md)，实测见 `spikes/native-hosts/`；G078 契约与 G085 关闭链、私有 TMPDIR 代码完成、合成测试通过，见[验证记录](../verification/native-hosts-g078-g085-2026-11-06.md)，其余未实现，均未真机验证）：回合租借宿主上的原生会话而不拥有进程；宿主池按 Harness + 入口 + 安装指纹 + 启动环境分类，预算以内存为主、按类封顶（实测 Claude 每会话约 1.3 GB、Codex 每线程约 0.9 GB 且进程内收不回，OpenCode、dsh、Hermes、OpenClaw 的会话 ≤10 MiB）；复用须通过新鲜度判定；空闲宿主不持工作区租约、有后台任务的宿主固定在对话上（ADR-030 方案 C 保留）；宿主登记先于使用、崩溃后按进程组身份接管；关闭宽限 ≥1.5 s、先 EOF 再核对离组后代；每类一个稳定私有 TMPDIR；预热不得建会话（INV-42）；归类按实测——服务型 Hermes、OpenClaw，便宜多会话 OpenCode、dsh，重且可收回 Claude，重且收不回 Codex（每对话一个进程），Pi 待测；三期（进程池与切换后保留来源宿主 → 多会话先 OpenCode、dsh、Hermes 再 Claude、Codex 不做 → 记录树）；新增 INV-37–42；取舍 D1–D7 已按推荐项接受，任务 G078–G085。
