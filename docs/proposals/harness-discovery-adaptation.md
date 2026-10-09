# Harness 发现与适配扩展方案

日期：2026-10-09。状态：proposed。目标：扩大可识别和可接入的 Harness 范围，继续以当前宿主的核心链路为优先；本轮交付调研与方案，没有新增运行时实现或真实 Harness 验收。

建议采用“可更新的 Harness 目录 + 多来源发现 + 协议族 Driver + 少量产品配置适配”。先把目录从固定 8 个条目扩展为能消费 ACP 官方目录的结构，再完成通用 ACP 和 Codex 原生控制链路。目录条目数、发现数量、握手成功数与任务执行成功数分别统计。

## 1. 最新源码核实

固定证据和 SHA-256 见[本轮来源清单](../research/harness-expansion-sources-2026-10-09.json)。本轮下载并固定 82 份源码/描述文件，选读检测/接入核心函数，并解析全部 42 个 ACP 描述；其他文件保留备查。未运行参考项目，不表示审计全部源码。

| 项目 | 本轮固定版本 | 实际观察 | 适合借鉴的部分 |
|---|---|---|---|
| CC Switch | 正式版 v4.0.5，2db86e94；发布于 2026-10-08。另核对 main 元数据，未用 main 文件代替发行源码 | 10 个 AppType；工具版本检测白名单有 9 个 CLI。按产品实现配置管理、安装信息与模型代理 | 安装目录补全、版本与运行错误区分、重复安装诊断、不同配置格式映射 |
| Magpie | main 62b1c995，2026-10-09；GitHub latest release API 本轮返回 404，因此按主分支 commit 固定 | All() 中有 50 个固定 Agent 构造项，另有动态 profile/WSL 镜像；包含 CLI、桌面应用、IDE 与扩展配置 | 组合检测线索、环境补全、产品身份识别、按文件 revision 缓存及重新扫描 |
| ACP Registry | c56a2b3f，2026-10-09 | 42 个 agent.json；19 条含 binary、23 条含 npx、2 条含 uvx，集合有重叠 | 作为上游接入目录与分发描述来源，减少手工维护产品名单 |
| acpx | b3cd8433，正式版信息另记为 v0.19.4 | 数据表描述 argv、installedArgv、requiredCommands 和包装器包；安装检查与 package execution 分开 | 原生入口和外部适配器分离、本地包 bin 解析、通用 ACP 调用 |

上述数量是本次源码快照的目录规模，不能比较为已经可靠执行了多少种 Harness。CC Switch 和 Magpie 的主要适配是各产品的配置与模型请求；它们的会话阅读/恢复能力也不等于 HarnessGateway 所需的统一 Session 中跨 Harness 执行与交接。

## 2. CC Switch 怎样发现

主要入口是[commands/misc.rs](https://github.com/farion1231/cc-switch/blob/2db86e94da13365caae55bb08d09295e31500d21/src-tauri/src/commands/misc.rs)。

- get_tool_versions 只接收 VALID_TOOLS 中的已知产品，不扫描任意未知程序。
- 本机版本首先通过 shell 的命令解析与 --version 探测，按 ShellProbe::NotFound 分支进入常见目录搜索，FoundButFailed 单独报告。该版本仍把部分空输出、无诊断的非零退出或 shell 启动错误归为 NotFound；这不是严格的“程序不存在”证明。我们进一步区分未找到与探测失败，避免用另一个旧安装覆盖当前程序的错误。
- build_tool_search_paths 补查 .local/bin、npm、pnpm、Volta、mise、fnm、nvm、Homebrew 及产品自己的安装位置；OpenCode、Grok、MiniMax Code 等有专属目录和环境变量规则。
- enumerate_tool_installations 枚举多处安装，按 canonical 路径去重，标记默认命令使用的那一处；这是一项冲突诊断，不要求做所有发行版的支持矩阵。
- 本地版本和远程最新版本是两类操作；get_single_tool_version_impl 还会访问 npm/GitHub/PyPI。我们不把这类联网检查放进默认的只读发现。
- 配置适配由[provider/live.rs](https://github.com/farion1231/cc-switch/blob/2db86e94da13365caae55bb08d09295e31500d21/src-tauri/src/services/provider/live.rs)等产品模块分发，处理各自的配置文件与写入方式。

可借鉴它的安装环境覆盖与错误分类。部分版本探测路径直接使用 output()，方案应统一增加期限、输出上限和可等待关闭，不照搬无界等待。当前阶段不做它的安装/升级与多平台分发管理。

## 3. Magpie 怎样发现

通用[Agent.Detected](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/agent/agent.go)优先运行产品专用 detect；否则查看配置路径、非共享配置目录和 exec.LookPath。其语义是“似乎安装或配置过”，配置残留也可能命中。

[proc.UserPath/UserBinDirs](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/proc/path_other.go)补全 GUI 启动时缺失的路径：先加已知 bin 目录，再向登录 shell 请求 PATH 与部分 Agent 目录变量；有 shell 输出标记和超时。它还读取 npm prefix，并覆盖 nvm/fnm/mise 等 Node 安装目录。

产品专用检测处理通用规则的例外：Gemini 不把共享 .gemini 目录当作 CLI 安装；Goose 排除同名的 Go 数据库迁移工具；Reasonix 区分原生程序与历史 npm 包；VS Code 结合 product.json 排除 Cursor 的 code 入口；桌面应用使用已知应用目录与包信息。Rescan 可以失效之前较慢的探测缓存。

我们采用这些检测策略，但保持结果为证据：配置命中记为 configured，文件入口记为 located，身份确认记为 identified，握手记为 protocol_ready。默认发现不读取登录凭据，也不把登录 shell 的变量写入网关全局环境。

## 4. 当前实现的具体缺口

当前[配方表](../../src/adapters/recipes.ts)有 8 项，[检测器](../../src/infrastructure/discovery/local.ts)查 PATH 与有限目录，并且每个产品只返回第一个可执行文件。它是已经测试过的基础，但无法充分覆盖以下情况：

1. 缺少上游目录导入；binary 只有一个名字，没有产品别名与多个控制入口。
2. 没有 Node/Python 管理器目录、GUI 环境和产品专用路径的系统化扩展。
3. 没有配置、桌面应用与 IDE 的独立发现证据；这类证据也不能直接进入任务路由。
4. nativeRequired 与 adapterBinary 只表达简单依赖，不能描述 Node + 本地包装器、Python 虚拟环境或已有的解压程序入口。
5. 没有产品身份、运行环境、协议握手和能力验证。
6. 描述文件 v1 不包含注册表中的 distribution、env 和包入口。把 npx 本身检测为存在，会错误推导出目标 Harness 已安装；新增程序名也不能补齐真实调用链路。

## 5. 目录结构和接入状态

保持三个概念独立，不新增业务限界上下文：

- HarnessDefinition：产品身份、别名、用途、来源 revision、发现策略、可选控制方式。CLI/桌面/IDE 是入口性质，独立 ACP 服务也可以成为任务执行入口。
- InstallationObservation：具体宿主、原始与真实入口、来源、默认解析关系、时间和诊断。一个产品可以有多处安装，一处安装可有多个别名。
- ControlBindingCandidate：控制协议、解析后的 executable/argv、私有环境、依赖和能力证据。同一产品可有原生与 ACP 两个候选，但不计成两个产品。

安装、身份、协议、认证和功能能力使用独立状态维度，不能塞进单个 installed 布尔值。建议对用户展示“发现配置”“找到程序”“缺适配器”“无法启动”“需要登录”“可执行任务”等结果，并提供原因。认证失败不改写成未安装，协议失败不删除安装事实。

Catalog 负责产品目录、安装观察与能力材料；Execution 负责运行与资源归属；ModelAccess 负责 Provider/模型选择；ContextContinuity 负责公共上下文交接。Driver 在防腐层转换第三方消息，Gateway 不按产品名称分支。

### 上游目录合并

先采用审阅后固定的 ACP Registry 快照，把 42 个条目作为候选目录来源；保留全部上游 ID 和出处，不声称 42 个已接通。Magpie/CC Switch 只用来补充产品别名、配置线索和探测规则。

内置定义与上游快照合并成网关目录，再应用本地显式覆盖。重复 ID、别名冲突与来源差异先报告；不静默覆盖。claude-acp/codex-acp/pi-acp 等上游控制入口可以显式关联到产品，但仍保留包装器版本和能力。两个显示名均为 GitHub Copilot 的上游条目 github-copilot-cli 和 github-copilot 必须保留真实 ID；后者的包身份是 @github/copilot-language-server，不能仅凭显示名称合并。

目录更新是明确操作，默认发现不联网；离线保留已审阅目录。扩展配置 v2 前定义 schema、无效样例及 v1 到 v2 的迁移映射，现有 v1 输入继续按现行契约校验；不隐式把旧数据变成包下载命令。

### 发现策略

按顺序使用：指定入口 → 当前 PATH → 指定目录 → 已知安装目录/有界版本管理器目录 → 配置/应用线索。产品专用环境变量按所属描述解析，输出一个 DiscoveryEnvironment，不改进程全局变量。

版本管理器目录只遍历已知固定根的一层或固定深度，有数量、字节和时间上限，不全盘递归。指定入口失效明确失败；PATH 默认入口损坏时保留该诊断，其他安装可显示但不能自动成为替代执行者。

登录 shell PATH 补全放进可选的主动环境探测：固定 shell/载荷、输出标记、期限、进程组关闭与结果校验；失败时说明可用静态路径证据。默认只读发现继续不执行任何程序。

## 6. 不同 Harness 怎样适配

```mermaid
flowchart LR
  C[用户消息与公共 Session] --> G[网关应用服务]
  G --> R[目录和能力过滤]
  R --> P[解析具体控制入口]
  P --> A[通用 ACP Driver]
  P --> N[原生 Driver]
  A --> H[各种 Harness]
  N --> H
  H --> M[独立 Provider 与模型配置]
```

控制设计保留 ACP、Codex App Server 与 Pi RPC 三个协议族；首轮只实现 ACP 与 Codex 原生控制面，Pi RPC 后续单独交付。Pi 如先使用 ACP 包装器，也需独立验证该入口。避免每个产品重写一套执行框架：

| 接入方式 | 首批对象 | 变化点 |
|---|---|---|
| 原生 ACP | OpenCode、Gemini、Qwen、Kimi、Copilot CLI、Goose、Qoder、Auggie、Kilo、MiniMax Code、Grok Build 等 | 同一 Driver；产品目录提供命令、必要环境和已观察差异 |
| 本地 ACP 包装器 | Claude Agent ACP、Codex ACP、Pi ACP、Amp ACP 等 | 包装器与其依赖分别检测；仍消费同一 ACP Driver |
| 原生控制接口 | 首轮 Codex App Server；后续 Pi RPC | 专用 Driver 转换 thread/turn/item 或 RPC 事件，公共 Session 语义由网关持有 |
| 其他原生 SDK/HTTP | 有当前使用方且已有明确协议的对象 | 后续逐项加入；只读发现能展示，未接通前不能路由任务 |
| 只有 GUI 或配置 | 暂无独立控制接口的客户端 | 先显示发现证据；找到该产品的 CLI/ACP/SDK 入口后才能作为执行者 |

ACP 官方注册表还包含 Cline、CodeBuddy、Factory Droid、Junie、Mistral Vibe 等候选。首轮优先上述可用本地入口，剩余条目保持可展示、缺依赖可解释，不等待 42 个产品都跑通才交付统一入口。

命令必须取固定来源和实际握手结果。不能统一追加 --acp：例如固定目录里的 Grok 是 agent stdio，Kimi 是 acp，Qoder 是 --acp，Droid 的目录条目是 exec --output-format acp-daemon，与所读 acpx 的 acp 参数有差异。它们应保留为不同来源配方，验证后选定，不猜测兼容。

### 本地包装器和分发描述

[官方 registry 格式](https://github.com/agentclientprotocol/registry/blob/c56a2b3f94c98b14f8145eb93d87359470c930d8/FORMAT.md)提供 binary/npx/uvx。它是安装或启动描述，不能证明宿主上已有程序。

- binary：先绑定用户已有入口或网关私有目录中的已有文件；archive 相对 cmd 只能在对应受控安装根解析，拒绝越界。
- npx：映射为固定 npm 包身份及本地 package.json/bin 解析，记录实际 Node 入口。没有本地包即缺依赖；发现和正式执行不临时运行 npx 下载。
- uvx：映射为固定 Python 包与已存在的虚拟环境入口；只有 uv/uvx 命令并不表示目标包已安装。
- distribution.env：只进入具体 Binding 的私有环境。必需变量缺失明确失败；不把上游元数据中的任意环境设置或覆盖静默写入用户配置。
- 安装帮助与执行分开。第一阶段可以提供缺失依赖及安装说明；自动下载/升级不阻塞首个调用闭环。

### 握手和能力

ACP Driver 统一处理初始化、会话创建、prompt、流式 update、权限请求、cancel 与关闭。按[初始化规范](https://agentclientprotocol.com/protocol/v1/initialization)协商版本、认证和能力；没有声明的可选能力不调用。握手成功只进入 protocol_ready；有认证要求时标记 auth_required；实际短任务通过再形成 execution_validated 证据。

read/write/terminal/MCP 等客户端能力只有实际实现后才能声明。审批覆盖、取消请求、后端结束与资源静止分别核验。统一 Driver 不代表外部 Harness 的工具都经网关审批；未验证的路径按能力报告限制，不伪造强制安全能力。

### Provider 与模型

定义、安装和控制入口独立于 Provider 选择。ModelAccess 生成具体 Binding 的模型访问配置，ConfigurationAdapter 只转换到目标支持的环境变量、私有配置或原生会话选项。

[ACP configOptions](https://agentclientprotocol.com/protocol/v1/session-config-options)可以提供模型选项与 session/set_config_option，但它不保证任意 Harness 都接受任意 Provider。先消费 Agent 实际提供的选项；需要自定义 Provider 的产品单独验证配置映射。不支持的组合明确返回 unsupported，不能换 Harness 或模型来掩盖。

切换模型/Provider 先在任务边界执行。支持原地改变时核对回执与下一次真实调用；需要重建时创建新原生 Binding 并接续公共上下文。运行中的工具不搬运。CC Switch/Magpie 修改全局配置的办法可用于了解字段含义，网关的 Session 运行应采用私有配置，不干扰用户终端里的 Agent。

## 7. 第一轮交付目标

第一轮扩大目录覆盖，并把核心控制链路做出来：

1. 导入 42 个 ACP 条目的候选快照，补充本地入口和别名；对尚无本地入口的条目明确显示缺依赖。
2. 扩展已知安装目录、枚举重复安装并保留默认入口诊断；配置和 GUI 证据只作为线索。
3. 主动探测程序身份和协议，再完成通用 ACP Driver 与 Codex App Server Driver。
4. 真实跑通 Codex、OpenCode 和 Claude ACP 包装器；Claude 包装器当前本机未发现，准备依赖是独立步骤，未准备好时先用已找到的 Gemini 作为第三个对象，记录真实使用对象。
5. 再接通统一 Session 的 A→B→A 与独立模型访问配置。新 Harness 的自动路由资格来自已验证能力，不来自目录里的名字。

目标是“目录可以扩展，新增同协议 Harness 主要增加描述和验证，核心链路实际可用”。原生 Driver 只为真实协议差异存在，当前不加三平台或多发行版验收矩阵。

## 8. 原子实现切片建议

下表是待冻结的细化提案，不替代 plan/tasks.json，也不自动扩大当前 plan/slices.json 的实现许可。进入实现时将各切片映射到已有 Catalog/Adapter/ModelAccess/Continuity 任务，并核对唯一文件 owner。

| ID | 单一职责 | 依赖 | 独占交付物建议 | 完成证据 |
|---|---|---|---|---|
| E01 | 定义目录 v2 和 v1 迁移 | 无 | catalog schema、迁移映射与有效/无效样例 | 重复/冲突/无效描述全部可拒绝 |
| E02 | 归一化 ACP 上游快照 | E01 | registry normalizer、审阅快照和目录测试 | 42 项可追溯；不把分发工具当作安装 |
| E03 | 枚举宿主安装证据 | E01 | discovery resolver 和真实文件系统测试 | 有界目录、别名、多安装、残留配置正确分类 |
| E04 | 确认程序身份与环境 | E03 | identity probe 和真实子进程测试 | 超时/非零/同名错误/清理可观察 |
| E05 | 解析已有包装器及依赖 | E02、E03 | local package resolver 和包夹具 | 本地 bin/Node/Python 入口正确；无隐式下载 |
| E06 | 实现通用 ACP 控制面 | E01、E04；仅包装器组合用例再依赖 E05 | ACP Driver 与协议进程测试 | 原生 ACP 可先接通；握手、流、权限、取消、关闭；可选能力受限 |
| E07 | 实现 Codex 原生控制面 | E04 | Codex Driver 与原生协议进程测试 | thread/turn/item/approval/interrupt 正确映射 |
| E08 | 生成 Binding 私有模型配置 | E01、C010 的最小配置契约；真实验收再依赖相应 Driver | ConfigurationAdapter/ModelAccess 与配置测试 | 配置生成先独立测试；不改全局；拒绝不支持组合；真实调用在 E09 核查 |
| E09 | 正式入口与 Session 接续验收 | E06、E07；模型用例再依赖 E08；另依赖既有统一 Session、历史与切换实现 | 独立 E2E 用例与验收记录 | 真实多 Harness 对话、A→B→A、失败不重跑 |

能力材料 schema 归 E01；探测实施归 E04/E06/E07；正式能力验收归 E09，避免各任务重新定义能力类型。E06/E07 不能修改 E09 的入口用例来修正本模块失败。公共 Session、历史、执行归属和切换消费既有工程任务的契约与实现；组合根在 G059 的本机子切片中集成，先冻结它当前消费的依赖与范围，后置平台/发布依赖不成为本机 E09 的前提。E09 只做验收，不重新实现这些模块。

### 正式入口的明确前置范围

当前 plan/tasks.json 的 G059 是 planned，且仍依赖已 deferred 的 Windows G030。完整蓝图依赖还没有被重排，不能声称本方案已解除其阻塞。下一步先在结构化计划和 plan/slices.json 中明确下面的本机子切片，再实现；不把 G030 标为通过或删除其未来责任。

| 正式验收阶段 | 必需的本机实现范围 | 当前状态与后置范围 |
|---|---|---|
| S03：统一入口单次对话与历史 | G001 工具链；G002/G004/G005/G007 的最小身份、消息、执行与端口契约；G008 事务存储；G017 预算；G018/G019/G020 公共 Session、消息与执行权；G026/G027/G028/G029 单写归属、Attempt、派发和 POSIX 监督；E06/E07 两个 Driver；G038/G039/G040/G041/G043 权限、期限、取消与结算；G044 的持久游标与 CLI 流投影；G049 关闭；G059-local 本机组合根 | 除 G001 部分完成，其余均未实现。先采用用户明确指定 Harness 和受控私有模型配置/单独测试登录；自动择优、模型代理账本、HTTP/SSE/UI 与平台发布不属于这个子切片 |
| S04：同 Session A→B→A | S03；G006/G024/G025 公共上下文类型、构建与水位；G045/G046 idle/busy 静止交接；E09 对应接续用例 | 均未实现；必须在旧执行确认静止后交接，不把内部状态搬运承诺给用户 |
| S06：独立 Provider/模型选择 | S03/S04；C010/G016 资源契约与登记；E08 私有配置；G047 模型切换；涉及网关转发时再消费 G035/G036/G037 及秘密引用任务 | 均未实现；不能以完成 ACP 握手声称这些已可用 |

G059-local 是拟议子切片标识，当前不存在新的可运行入口。上表是需要重排的消费范围，不表示原 G 任务全部验收完成；原任务中的自动路由、完整模型账本和 HTTP 等责任继续保留。G028 的“用户指定”执行计划仍要持久记录，不能隐式沿用原自动路由依赖或跳过执行授权。具体最小 schema、scope 与每个子切片的依赖须同步进入结构化计划；C001/C003/C004/C005/C008 按本机实际消费的部分冻结，C002/E01 共同确定能力类型 owner，不要求一次冻结完整未来 OpenAPI。

## 9. 测试方案

发现测试覆盖：程序别名、相同显示名不同控制入口、配置残留、同名误检测、损坏默认入口、不可执行和坏链接、多个入口同 canonical 目标、不同安装位置、已知根数量/深度上限、无环境变量泄漏、缓存失效和手动重扫。默认发现继续用副作用 sentinel 证明不启动程序。

描述与分发测试覆盖：42 个固定条目、未知字段/协议、缺主机入口、只有 npx/uvx 工具、Node 缺失、包装器内部运行时、缺外部原生 CLI、包路径越界、必需环境变量、相对 archive cmd、同产品两种控制面以及显式覆盖失败。所有自动检查新增拒绝规则都要有无效样例。

主动探测/Driver 使用真实子进程与 IPC，替代外部模型服务：空版本输出、无诊断的非零退出、shell 启动失败、输出污染、错误身份、版本不协商、缺认证、能力缺失、超时、超大消息、迟到响应、重复结束、取消后未静止、父进程退出与关闭失败。声明的客户端能力必须有对应行为测试。

最后从正式网关入口验证真实 Harness，而非直接调用 Driver：公共消息、流式内容、历史、权限、取消、模型来源、同 Session 切换和上下文接续。未知结果不得自动重跑；没有准备的真实 Harness 写未验证。参考项目源码研究与目录数量均不作为上述运行验收。

## 10. 本轮结果与下一步

本轮产物：最新源码证据、42 条 ACP 候选目录分析与本方案。当前应用仍是 commit 8101598 的只读发现实现，未新增任何已支持运行的 Harness。

实际检查：python3 tools/check_design.py 通过；82 份固定文件的字节数/SHA-256 与缓存一致；9 个 CC Switch CLI、50 个 Magpie 固定构造项与 42 个 ACP 描述的统计经过本地核对。独立阅读复核修正了 CC Switch 失败分类、Copilot 上游 ID、首轮协议范围以及正式入口的待实现依赖；修订后限定复核通过。复核是静态阅读，结构化任务状态由主执行者另行核对。没有重跑应用测试或运行参考项目；本轮没有修改应用源码。

建议下一步按 E01/E02/E03 准备并冻结最小扩展契约，随后 E04/E05/E06/E07 把程序检测推进为真实调用。目录扩展和调用闭环紧邻交付，避免只增加程序名单而长期没有一个统一对话入口。
