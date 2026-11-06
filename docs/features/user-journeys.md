# 从两类用户的任务理解 HarnessHub

整理日期：2026-10-08。现状依据：main 的 6bc1baf、[产品定位](positioning.md)及本目录 58 篇功能说明。用户随后确认的产品方向是：两类用户使用同一条任务执行链路，在同一个 Chat 内切换 Harness Agent，并为 Agent 切换 Provider 与模型。本文区分这一已确认方向、当前实现、尚待讨论的交接机制与功能呈现建议；不把方向确认写成实现或验收完成。具体行为与验证证据仍由各功能文档负责，开发任务与验收仍由 [TODO](../../TODO.md) 管理。

推进方式补充（用户 2026-10-08 明确）：按全新项目重新拆分链路，再按步骤建设；实施顺序与验收目标见 [以 Chat 为中心的八步蓝图](../proposals/chat-first/README.md)。本文保留现状映射，不作为逐个修补旧页面或继承旧 Session 绑定模型的实施顺序。

## 1. 一个连续的 Chat，两类使用入口

可配合 [交互式流转说明](chat-flow.html) 阅读：按步骤查看一轮执行，模拟切换 Agent 与 Provider，并对照现状和待设计机制。

两类用户可以是同一个人，区别在于从哪里使用和怎样集成。两类用户共用对话、任务、Agent 与模型资源；下面的路线是需求视角，不是两个相互独立的产品。

| 用户 | 核心诉求 | 一条完整的使用路线 | 用户最后应拿到什么 |
|---|---|---|---|
| A：同时使用多个编码 Agent 的开发者 | 在一个 Chat 中推进工作，按需要换 Agent 和模型，减少重复配置 | 接入模型与工具 → 开始 Chat → 选择 Agent 与 Provider/模型 → 对话执行并按需要切换 → 看结果与花费 | 连续的对话和工作成果，执行者与模型可更换，配置与证据可查 |
| B：需要集成 Agent 的工具与平台开发者 | 在自己的程序里使用相同的 Chat 与执行能力 | 准备可执行 Agent → 经 API/SDK 创建或继续 Chat → 选择或切换 Agent 与模型 → 接收事件与处理权限 → 取得结果和证据 | 与本机交互入口一致的任务语义，以及可由程序消费的接口 |

以上是确认后的产品目标，当前代码尚没有贯穿多个 Agent 原生会话的公共 Chat 对象，也没有完整的跨 Agent 连续切换。现有 Session 固定绑定引擎与配置 revision，切换执行引擎需要新建 Session；SDK 尚无执行层。当前能力映射与缺口见后文。

### 贯穿整体的链路

用户 → HarnessHub 中的 Chat → 当前选择的 Harness Agent → 共享模型网关 → 当前选择的 Provider/模型。回复、工具过程、文件与调用证据回到同一个 Chat；工具执行由 Harness Agent 负责。

| 对象 | 用户如何理解 | 谁负责连续性与选择 |
|---|---|---|
| Chat | 持续对话与推进工作的容器 | HarnessHub 持有公共消息、目标、进展与结果；更换 Agent 或 Provider 后仍是同一个 Chat |
| 任务 | Chat 中正在推进的工作目标 | HarnessHub 关联目标、进展、工作区与产物；是否另设独立 Task 实体、如何处理一个 Chat 中的多个目标，尚待设计 |
| 一段执行 | 当前 Agent 按选定配置处理一次输入及后续工具过程 | 记录实际 Agent、配置版本、模型目标、实际调用、结果与清理状态；与现有 Run 如何映射尚待设计 |
| Harness Agent | Claude Code、Codex、OpenCode 等执行者，负责自身的规划、工具调用与执行 | 用户可选择或切换；适配器明确执行、工具、上下文和模型切换支持范围 |
| Provider/模型 | 为当前 Agent 提供推理的上游与具体模型 | 用户可独立选择或切换；共享网关统一处理凭据、协议、路由与调用账本 |

两个切换维度相互独立：保留 Agent 换 Provider/模型；保留模型资源换 Agent；也可以同时更换两者。它们都属于同一个 Chat 的执行选择。不能把“配置文件可以改写”直接当作运行中的组合已能切换。

例如同一个 Chat：第一段用 Agent A 与 Provider X 分析，第二段换 Agent B 与 Provider Y 修改文件，第三段保留 Agent B 改用 Provider Z 继续，第四段回到 Agent A 检查。对话、任务进展和工作成果保持归属；每段的实际执行者、模型与费用可追溯。

### 切换时保持什么、改变什么

| 应保持 | 允许改变 | 仍需定义的机制 |
|---|---|---|
| Chat 身份、公共对话、目标与进展、工作文件与产物、已有执行证据 | Harness Agent、Provider、模型及显式选择的工具配置 | 如何选择并准备可交接上下文；不同 Agent 原生会话如何创建、复用或恢复；模型变化是否需要重建后端会话 |
| 已发生的文件修改与其他操作的真实记录 | 后续执行的配置选择 | 执行中收到切换请求时，当前模型调用、工具操作、待决权限和资源如何停止或结算 |

用户可以随时提出切换。具体在哪个执行边界生效、是否等待当前操作完成或明确取消，以及失败后如何继续，需要单独设计；不能假定正在运行的工具能无缝转移。公共 Chat 上下文接续也不等于跨引擎原生会话无损迁移。

模型、凭据、工具内容与调用证据服务于这条统一链路。全局接线继续支持用户在原 Agent 中工作，修改用户自己的配置；Chat 内执行使用受管理的运行配置。两种作用域需要保留，而资源选择和效果应能互相解释。

三平面用于说明架构；产品主线以 Chat 为连续容器，以 Harness Agent 和 Provider/模型为两个可切换的选择。

## 2. 用户 A：管理我日常使用的 Agent

这类用户的目标交互入口是 HarnessHub 的连续 Chat；hh init、hh wire、TUI 和全局接线承担资源准备与外部 Agent 使用。当前已经存在的最短路线是接入一个上游、给一个 Agent 选好模型、在该 Agent 中完成一次调用并看到用量；还需要把这些资源直接用于 Chat 内执行与切换。

| 用户任务 | 应归到一起的现有功能 | 用户需要理解的概念 | 当前闭环的缺口 |
|---|---|---|---|
| A1 接入并开始使用 | 首次使用、Provider 预设与导入、凭据、模型检测、Agent 发现与接线 | 上游账号或 API Key、已安装 Agent、所选模型 | 接线适配与真实 Agent 验收范围不同；当前 28 个接线 Adapter 不表示 28 个都能无人值守执行；仍需从源码安装 |
| A2 切换模型与工作方案 | 模型目录、每个 Agent 的模型清单、Profile、路由组与规则 | Agent 默认模型、可选模型；需要时再理解 Profile 和路由 | Profile 只保存模型相关选择，不含 Library，也不能直接供 Session 使用；跨 Agent 应用中途失败会留下部分切换 |
| A3 统一指令与工具 | Library 指令集、Skills、MCP 服务、预览与同步 | 内容是什么、应用到哪些 Agent、是否已同步 | Library 支持范围小于接线范围；登记、同步写入、Agent 实际加载是三个不同状态；真实加载证据尚缺 |
| A4 看花费并控制使用 | 调用账本、用量汇总、额度提醒、Gateway Key 的模型范围与预算 | 哪个 Agent 用了哪个模型、多少 token、费用来源 | 未定价费用仍未知；只设成本预算不能约束未定价模型；接线调用不天然归属某次 HarnessHub Run |
| A5 安全维护与换机器 | 漂移检测、接线还原、配置备份恢复、多机同步、故障诊断 | 哪些内容由 HarnessHub 管理、哪些已被自己修改、哪些可以恢复 | Profile、Library 同步与恢复多为逐项应用；配置备份不包含 Session、Run、账本、引擎目录与 Tool Pack |

建议由“我的 Agent”承接 A1–A3 的资源管理，由 Chat 直接选择这些资源并开始工作；管理页中的配置应说明它作用于外部接线、Chat 执行还是两者。Provider、路由和秘密作为复用资源；高级路由、订阅和兼容开关按需要展开。

## 3. 用户 B：在我的程序里调用 Agent

这类用户通过 API、SDK 与事件使用同一个 Chat 和执行语义，控制台用于准备、调试和查看结果。现在可以用 HTTP 走 Session/Run 执行链路，但还没有贯穿多个 Agent 的公共 Chat API、完整执行 SDK 或提交任务的 hh 命令。

| 用户任务 | 应归到一起的现有功能 | 用户需要给出或取得什么 | 当前闭环的缺口 |
|---|---|---|---|
| B1 准备一个可执行 Agent | 引擎发现与登记、配置检查、模型选择、Skills/MCP 与工具包绑定 | 引擎及固定 revision、工作区、模型目标、工具内容；能力与限制 | Agent 接线目录与执行引擎目录独立；模型与工具有多处配置入口；Profile 不能直接用于 Session |
| B2 提交和控制任务 | Session/Run、幂等提交、串行队列、期限、取消、权限往返 | 一个 runId、可查询状态、权限选项与确定的停止结果 | 执行 API 仍在旧 /v1，默认依靠本机 Host/Origin 限制，尚无调用方凭据认证；SDK 未覆盖 Run/SSE；Full Access 的 Worker 传递存在已知缺陷，权限只覆盖引擎上报的请求 |
| B3 取得结果并说明发生了什么 | SSE 与回放、文件产物、执行观测、按 Run 的模型调用、诊断与导出 | 文本、不可变文件、调用与费用证据、失败原因、清理状态 | 按 Run 计量依赖共享网关的 Session Key 路径；原生接线和部分旧路径有缺口；日常 Run 没有独立的结果评分 |
| B4 接入自己的应用或流水线 | HTTP API、SDK、契约文档、错误格式、事件订阅方式 | 可复用的接入步骤与示例，连接中断后的续读方式 | 管理 API 与执行 API 的认证、错误、客户端分成两套；SDK 未发布；没有提交 Run 的 CLI、面向外部调用者的执行 MCP 服务或 GitHub Action |

建议用同一 Chat 中的执行记录与结果承接 B2–B3，用开发者接入文档承接 B4。B1 应展示同一 Agent 的无人值守能力、启动条件和配置作用域，API 与交互入口都使用这组能力与选择。

有三件事需要分别说明：Run 正常结束、任务内容达标、进程资源清理确认。当前 completed 只表达执行层面的结果；Benchmark 有独立评分，日常任务没有。文件产物的完整性也不能单独证明文件内容正确。

## 4. 共用支撑与进阶功能放在哪里

主归属用于帮助用户找到功能，不表示只有一类用户可以使用它。模型与 Library 资源应同时供交互 Chat 和程序调用选择；现有实现尚未全部贯通。

| 归属 | 内容 | 建议如何呈现 |
|---|---|---|
| C1 模型连接与兼容 | 四协议转换、凭据选择、失败转移、工具搜索、压缩、视觉兜底、搜索模拟、目录同步、Run 接入共享网关 | 大部分自动处理；需要配置的能力在模型详情或高级设置中说明支持范围与额外调用 |
| C2 安全与使用范围 | Gateway Key、秘密存储、访问控制、出站脱敏 | 当前已接线 Agent 和经共享网关的 Session 自动取得所属 Key，其他运行路径不得假定已覆盖；脚本使用者管理 client Key；用户能看到模型范围、预算与限制 |
| C3 安装与维护 | 构建打包、启动配置、代理与网络 | 安装指引与设置；明确区分启动配置、业务配置和备份内容 |
| C4 运行可靠性 | Driver、Worker、进程监督、持久化与测试门禁 | 通过可理解的能力声明、状态、错误与清理结果体现；实现细节放开发文档 |
| E 进阶与可选 | Workflow、Benchmark、图像生成、局域网共享与级联 | 保留明确入口与限制；Workflow/Benchmark 的实验性定位见各功能的迁移候选，不扩充首次使用路线 |
| L 遗留迁移 | 统一模型强制配置、仍使用 Worker 网关的配置路径 | 已弃用入口和迁移说明；兼容旧部署时明确它如何影响现在的选择 |
| I 使用入口 | Web、TUI、CLI | 展示同一批用户任务；入口支持范围分别说明。API/SDK 是 B4 的核心交付，并支撑其他入口 |

图像生成与局域网共享已有实现，但对上述两条最短路线不是前置条件。Workflow 是多步骤执行，Benchmark 是离线评分与比较；二者不等于计划中的“同一日常任务、多 Agent 并行比较”，后者尚未实现。

## 5. 现在为什么让人理不清

下表区分了有必要保留的语义差异和目前需要连接起来的重复概念。建议是产品整理方向，具体迁移仍需要单独设计和验收。

| 目前看到的两套概念 | 应保留的区别 | 当前造成的困惑 | 建议收敛方向与依据 |
|---|---|---|---|
| Agent 与 Engine | 已安装程序、能否全局接线、能否无人值守运行是不同能力 | 同一个程序在两个页面发现、登记和配置，支持数量也不同 | 一个可理解的 Agent 目录，分别标出接线与执行能力；执行登记和固定 revision 继续表达运行条件。见 [引擎发现](run-plane/engine-management.md)、[支持的 Agent](agent-plane/agent-adapters.md) |
| 全局接线与 Session 私有配置 | 前者改用户文件，后者服务指定 Session | 用户不知道任务是否沿用刚才在 Agent 页选好的模型与工具 | 在同一 Agent 上展示两种使用方式与继承范围；明确哪些配置会应用、哪些不会。见 [全局接线](agent-plane/global-wiring.md)、[引擎配置](run-plane/engine-configuration.md) |
| Library 与 Tool Pack | 内容、安装来源、可执行命令及运行绑定有不同安全责任 | 两处都有 Skills/MCP，用户不知道该导入哪处 | 统一工具内容的查找与选择，保留版本、来源和绑定作用域；现有迁移候选是包对象进入 Library。见 [工具包](run-plane/tool-packs.md) |
| 模型平面与引擎 Provider、旧统一模型 | 共享资源选择与历史兼容需要分别报告 | 多处填模型与 Key，执行走的路径和账本覆盖不同 | 模型资源集中管理，任务引用模型或组，逐步迁移残留 Worker 网关。见 [任务经共享网关](run-plane/runs-on-gateway.md)、[引擎配置](run-plane/engine-configuration.md) |
| Profile 与执行配置 revision | 前者是用户保存的选择，后者固定运行配置版本 | 名字相近，但 Profile 不包含完整工具方案，也不能拿来启动 Session | 明确当前 Profile 是模型选择快照；是否扩为可复用的模型与工具方案，沿既有提案讨论。见 [Profile](agent-plane/profiles.md) |
| 用量与执行观测 | 账本看模型调用，执行观测看整次任务；覆盖可不同 | 相同任务在不同页面出现不同数字或“未提供” | 任务详情能追到同一调用账本，并显示缺口和费用来源；不强行填零。见 [执行观测](run-plane/observability.md)、[任务经共享网关](run-plane/runs-on-gateway.md) |
| 新管理 API 与旧执行 API | 管理配置、驱动任务、调用模型是不同契约 | SDK、认证、错误和控制台客户端不一致 | 管理与执行接口按既有迁移方向统一认证和错误，模型协议保留自己的兼容契约。见 [HTTP API 与 SDK](interfaces/http-api-sdk.md) |

这说明整理工作不应只改菜单名称。先明确每个资源的所有者、使用作用域和继承关系，才能让用户沿一条路线完成任务。

## 6. 建议如何安排产品入口与下一步讨论

建议把下面六个区域作为讨论起点；这不是已经落地的导航或新的架构决定。

| 区域 | 主要回答的问题 |
|---|---|
| 我的 Agent | 本机有哪些 Agent？用哪个模型？带哪些工具？能否执行任务？配置是否被改动？ |
| 模型与账号 | 有哪些可用模型与上游账号？连接是否可用？需要怎样的路由？ |
| Library | 有哪些指令、Skills、MCP 和工具内容？应用到哪些 Agent 或运行配置？ |
| Chat、任务与结果 | 当前对话在推进什么？用哪个 Harness Agent 和 Provider/模型？切换后怎样继续？是否需要批准？结果和执行证据在哪里？ |
| 用量 | 哪个 Agent、任务或脚本用了哪些模型？费用和额度是否可信、是否接近限制？ |
| 设置 | 网络、秘密、访问控制、配置备份同步与本机运行状态怎样管理？ |

Chat 是主要工作入口，“我的 Agent”“模型与账号”和 Library 为它准备资源。Profile 属于“我的 Agent”的复用选择；路由属于“模型与账号”的高级功能；每段执行从 Chat 链接到调用账本。Workflow/Benchmark 可放进阶入口；旧统一模型进入迁移入口。开发者接入文档从 Chat 与执行结果直接可达。

建议按以下顺序讨论和验收，先连接已有能力，再决定新增范围。以下是候选顺序，不是已批准的开发排期：

1. 先明确统一 Chat 的公共身份与上下文责任，以及它与任务、一段执行、现有 Session/Run 的关系；保留现有原生会话绑定契约，单独设计跨 Agent 交接。
2. 统一资源选择与作用域：Agent/Engine、Profile/revision、Library/Tool Pack、全局接线/Session 配置；为同一 Agent 展示独立的接线、执行和模型切换能力。
3. 补齐交互闭环：一个 Chat → 选 Agent 与模型 → 执行 → 切 Agent 或 Provider/模型 → 继续 → 查结果与账本；验证可交接上下文、工具实际加载、失败与取消边界。
4. 经 API/SDK 提供同一闭环：认证 → 创建或继续 Chat → 执行与切换选择 → 事件与权限 → 结果与证据；逐步迁移旧网关与工具配置，明确配置备份和执行历史导出的不同范围。
5. 在基础闭环有证据后，讨论日常多 Agent 比较，以及 Workflow、Benchmark 等进阶能力的产品范围。

目标闭环的判据是：A 用户在同一 Chat 内选择与切换 Agent、Provider/模型并继续工作；B 用户经 API/SDK 获得相同语义；每段执行都能解释上下文来源、实际模型、工具、配置作用域和结果。资源管理、查账和还原也应服务该闭环。当前功能文档中的“已实现”不等于这些整条用户路线均已实现或验收。

## 7. 全部 58 篇功能的归属索引

每篇只列一个主归属，便于核对有无遗漏。A1–A5、B1–B4 对应上面的用户任务；C1–C4 是共用支撑；E 是进阶可选；L 是遗留；I 是使用入口。主归属不排除其他用户复用，原有单篇文档保留技术分类与证据。

| 功能说明 | 主归属 | 在用户任务中如何理解 |
|---|---|---|
| [Provider 与预设](model-plane/providers-presets.md) | A1 | 接入上游服务 |
| [凭据](model-plane/credentials.md) | A1 | 管理上游认证材料与多个账号/Key |
| [导入](model-plane/provider-import.md) | A1 | 搬入已有模型配置 |
| [检测与体检](model-plane/provider-doctor.md) | A1 | 确认上游能否使用及兼容设置 |
| [订阅账号](model-plane/subscriptions.md) | A1 | 可选的模型来源，有本机使用限制 |
| [首次使用](agent-plane/first-run-init.md) | A1 | 串起第一次接入与接线 |
| [支持的 Agent](agent-plane/agent-adapters.md) | A1 | 确认接线支持与验证范围 |
| [全局接线](agent-plane/global-wiring.md) | A1 | 为自己的 Agent 应用模型配置，可还原 |
| [模型列表、目录与元数据](model-plane/model-catalog.md) | A2 | 找模型并了解能力与价格来源 |
| [路由组与策略](model-plane/route-groups.md) | A2 | 选择一组模型及使用顺序 |
| [路由规则与分类器](model-plane/routing-rules.md) | A2 | 高级的按请求选模型规则 |
| [Profile](agent-plane/profiles.md) | A2 | 复用各 Agent 的模型选择 |
| [每个 Agent 的模型清单](agent-plane/agent-model-lists.md) | A2 | 控制选择器与实际可调用模型 |
| [Library 指令集](agent-plane/library-instructions.md) | A3 | 统一用户级指令 |
| [Library MCP 服务](agent-plane/library-mcp.md) | A3 | 登记可供 Agent 使用的 MCP |
| [Library Skills](agent-plane/library-skills.md) | A3 | 导入可复用的 Skill 内容 |
| [Library 同步到 Agent](agent-plane/library-sync.md) | A3 | 预览并应用内容到 Agent |
| [用量账本、会话与导出](model-plane/usage-ledger.md) | A4 | 查调用与花费，导出核对 |
| [额度读数与用量提醒](model-plane/usage-alerts.md) | A4 | 了解上游额度与提醒 |
| [备份与恢复](operations/backup-restore.md) | A5 | 恢复模型与 Agent 配置，范围有限 |
| [多机同步](operations/sync.md) | A5 | 在自己的机器间同步配置 |
| [引擎发现、登记与热加载](run-plane/engine-management.md) | B1 | 准备无人值守执行的启动方式 |
| [引擎独立配置与检查](run-plane/engine-configuration.md) | B1 | 准备 Session 私有模型与工具配置 |
| [工具包与能力包](run-plane/tool-packs.md) | B1 | 向执行配置提供固定版本工具内容 |
| [Session 与 Run](run-plane/sessions-runs.md) | B2 | 提交、继续、排队与停止任务 |
| [权限往返](run-plane/permissions.md) | B2 | 对引擎上报的操作作决定 |
| [事件、SSE 回放与轨迹导出](run-plane/events-replay.md) | B3 | 接收过程、断线续读与复查 |
| [文件产物](run-plane/artifacts.md) | B3 | 取得不可变文件及完整性证据 |
| [执行观测](run-plane/observability.md) | B3 | 解释任务的模型、用量、耗时与缺口 |
| [日志与诊断](operations/logs-diagnostics.md) | B3 | 排查执行和网关故障，A 也复用 |
| [OTLP 导出](model-plane/otlp-export.md) | B3 | 可选地接入现有观测系统 |
| [HTTP API 与 SDK](interfaces/http-api-sdk.md) | B4 | 程序集成入口，执行 SDK 尚缺 |
| [网关与协议转换](model-plane/gateway-protocols.md) | C1 | 多 Agent/模型连接的共同基础 |
| [失败转移、熔断与凭据休息](model-plane/failover-breaker.md) | C1 | 自动应对上游故障并解释选择 |
| [视觉兜底](model-plane/vision-fallback.md) | C1 | 可选的跨模型图片输入兼容 |
| [联网搜索模拟](model-plane/web-search-emulation.md) | C1 | 可选的跨厂商搜索兼容 |
| [工具搜索](model-plane/tool-search.md) | C1 | 兼容 Agent 的延迟工具加载 |
| [上下文压缩](model-plane/compaction.md) | C1 | 兼容 Codex 的摘要请求 |
| [目录同步](agent-plane/catalog-sync.md) | C1 | 模型变化后维护 Agent 模型清单 |
| [任务经共享网关](run-plane/runs-on-gateway.md) | C1 | 把共享模型资源和调用账本连接到 Run |
| [Gateway Key](model-plane/gateway-keys.md) | C2 | 区分调用方，控制模型范围与预算 |
| [出站脱敏](model-plane/outbound-redaction.md) | C2 | 请求离开本机前遮蔽已知秘密 |
| [本机访问控制与控制台会话](operations/local-access.md) | C2 | 限制管理入口与浏览器会话 |
| [秘密存储](operations/secrets.md) | C2 | 安全保存凭据，配置只留引用 |
| [出站代理与网络](model-plane/outbound-network.md) | C3 | 配置本机访问上游的网络路径 |
| [配置](operations/configuration.md) | C3 | 管理启动设置及来源优先级 |
| [构建身份与打包](operations/build-packaging.md) | C3 | 安装、分发与确认运行版本 |
| [ACP 与 CLI 驱动](run-plane/drivers.md) | C4 | 接入不同执行协议 |
| [Worker 隔离、进程清理与恢复](run-plane/worker-isolation.md) | C4 | 监督执行资源，明确隔离与恢复边界 |
| [测试体系与检查门禁](operations/testing-gates.md) | C4 | 验证实现与真实用户路线的依据 |
| [图像生成](model-plane/image-generation.md) | E | 可选的模型网关扩展能力 |
| [局域网共享与级联](model-plane/lan-sharing.md) | E | 可选的跨机器模型使用，不等于团队服务器 |
| [先做计划（Workflows）](run-plane/workflows.md) | E | 多步骤计划与串行执行，范围仍需讨论 |
| [Benchmark 与 rollout 导出](run-plane/benchmark-rollout.md) | E | 数据集评分与离线比较；轨迹导出也服务 B3 |
| [统一模型（遗留）](run-plane/unified-model-legacy.md) | L | 兼容旧部署的强制模型入口 |
| [Web 控制台](interfaces/web-console.md) | I | A 的日常管理与 B 的准备、调试、查看 |
| [终端界面](interfaces/terminal-ui.md) | I | A 的终端模型选择与 Profile 管理 |
| [命令行 hh](interfaces/cli.md) | I | 管理和维护入口，尚不能提交 Run |

## 8. 阅读与验证边界

本次整理依据功能文档和已读取的实现入口，不是用户访谈或可用性研究；“目前混乱的原因”和分组建议是基于这些材料的分析。各功能的真实 Agent、上游、平台与端到端验收范围仍见所属文档，本次不新增通过声明。

DESIGN 与架构导览仍保留部分旧 Worker 单模型网关、Next.js 控制台描述；当前功能文档和源码入口已是共享网关与 React/Vite 控制台，旧路径仍有残留。本文将这视为迁移期的现状，不借产品分组改写运行契约或宣告迁移完成。
