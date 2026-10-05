# 功能说明

本目录按功能点梳理 HarnessHub 在 `main` 上已经实现的功能：每个功能点一篇，说明它做什么、从哪里用、实现在哪里、验证到什么程度、已知限制，以及可以优化的方向。它是功能级的导航与优化清单，不是契约：行为细节、默认值与错误以每篇“权威文档”一栏链接的文档和源码为准，本目录只做摘要与链接。

梳理基线：`main` 的 `467e377`（2026-10-05）。功能变化时同次更新对应一篇；“优化候选”只是候选，决定要做的事项进入 [TODO.md](../../TODO.md)，在那里记录验收与证据。

## 分类

<!-- INDEX:START -->
### 模型平面

本地模型网关：协议、provider、路由、Key、账本与网关功能。

| 功能 | 状态 | 对照 Magpie | 用途 |
|---|---|---|---|
| [网关与协议转换](model-plane/gateway-protocols.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 说 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Gemini 协议的客户端（Claude Code、Codex、Gemini CLI、官方 SDK、脚本）都指向守护进程的同一个端口，用 `provider/model`、路由组或裸模型名请求模型。 |
| [Provider 与预设](model-plane/providers-presets.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 添加一个模型上游：从预设中选厂商或中转、地域与套餐并给出 Key，端点、Key 的发送方式、模型列表来源与目录 ID 都由预设提供；预设里没有的上游（本机 vLLM、公司网关）手工填写端点。 |
| [凭据](model-plane/credentials.md) | 已实现 | 混合（相同、有意不同、部分） | 一个 provider 可以挂多把 Key，网关把每个凭据当作独立的路由候选与熔断单位：一把 Key 被限流或额度用完时转到下一把。秘密值只进入秘密存储，provider 配置、备份与日志里只有引用。 |
| [模型列表、目录与元数据](model-plane/model-catalog.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 让网关知道每个 provider 提供哪些模型，以及每个模型的上下文窗口、输出上限、能否推理、输入模态、能否调用工具与价格。列表从上游读取或手工填写，元数据按固定优先级从用户覆盖、手工值、上游列表、预设与内置 models.dev 快照补齐，用于 `/v1/models`、Agent 接线写入的模型清单与每次调用的成本。 |
| [导入](model-plane/provider-import.md) | 已实现 | 混合（相同、部分、未覆盖） | 把厂商、中转服务或同事给出的一条导入链接，或本机 Claude Code、Codex 已经配好的上游，变成 HarnessHub 的 provider，不用手工抄端点与 Key。导入先预览将要添加什么、请求与 Key 会发往哪些主机，确认后才写入。 |
| [检测与体检](model-plane/provider-doctor.md) | 已实现 | 混合（相同、HarnessHub 独有） | 添加或修改一个 provider 之后，用真实请求回答两个问题：每个声明的端点能不能用；这个上游需要哪些设置（Key 的发送方式、输出上限字段、usage、可选字段、推理回传、模型元数据）。 |
| [路由组与策略](model-plane/route-groups.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 把多个模型或 Credential 组织成一个名字 `group/<id>`，客户端只请求这个名字，网关按策略决定先问谁、失败后换谁。成员可以固定推理强度、使用厂商的快速模式或嵌套另一个组。 |
| [路由规则与分类器](model-plane/routing-rules.md) | 已实现 | 混合（相同、部分、未覆盖） | 让路由组按请求的特征把一轮对话先交给某个成员：长请求给大窗口的模型，带图片的给能看图的模型，某个 Agent、某种意图、压缩请求或某个时段各用各的模型。分类器模型可以判断意图，也可以为每一轮选推理强度。 |
| [失败转移、熔断与凭据休息](model-plane/failover-breaker.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 上游失败时，网关按失败的原因决定这个 Credential 休息多久、要不要换下一个候选、要不要原处重试，让 Agent 尽量拿到一个回答，又不反复敲已知坏掉的上游。用户能看到每个凭据为什么在休息、何时恢复，也能把一次调用钉在某个凭据上。 |
| [Gateway Key](model-plane/gateway-keys.md) | 已实现 | 混合（相同、有意不同、部分） | 每个使用网关的 Agent、脚本或 Run 都持有一把 Gateway Key：它决定能用哪些模型、每天每周每月能花多少、每分钟能发多少请求，账本也按它归属用量。Key 可以随时改名、暂停、恢复或吊销，丢失的 Key 不会因为备份或数据目录泄露而被还原出来。 |
| [用量账本、会话与导出](model-plane/usage-ledger.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 网关处理的每一次模型调用都留下一条证据：谁调用、经哪个凭据发往哪个模型、用了多少 token、花了多少钱、是否失败以及为什么。用户按模型、provider、凭据、Key、Agent、日期或会话查看汇总，或导出 CSV 与厂商账单对照。 |
| [额度读数与用量提醒](model-plane/usage-alerts.md) | 已实现 | 混合（有意不同、部分、未覆盖） | 网关从上游的答复中记下每个凭据的额度窗口用了多少、何时重置，用来在多个账号或 Key 之间分配请求，并在某个窗口用到设定的百分比时提醒用户，避免额度在工作中途用完。 |
| [出站脱敏](model-plane/outbound-redaction.md) | 已实现 | 有意不同 | Agent 的提示词、工具结果或历史中可能出现 HarnessHub 自己的秘密（Gateway Key、provider 凭据、订阅令牌、管理令牌）或用户登记的敏感值。网关在请求发往上游之前把它们换成占位符，厂商看不到原值。 |
| [视觉兜底](model-plane/vision-fallback.md) | 已实现 | 部分 | 请求带图片、而目标模型不接受图片输入时，由用户设置的视觉模型先把每张图片描述成文字（并逐字转写图中文字），再交给目标模型。这样只能读文字的模型也能处理截图、图表等输入，不必为看图换掉整个对话的模型。 |
| [联网搜索模拟](model-plane/web-search-emulation.md) | 已实现 | 部分 | Codex、Claude Code 等客户端会给模型提供厂商在服务端执行的联网搜索工具，但别家的上游执行不了这种工具。登记了搜索后端后，网关自己完成搜索：把结果交给模型，再把搜索过程按客户端协议原生的形式展示出来，客户端不必知道上游换了厂商。 |
| [图像生成](model-plane/image-generation.md) | 已实现 | 混合（部分、未覆盖） | 让脚本与 Agent 用 OpenAI Images 的接口生成或编辑图片，模型可以是任何配置了图像端点的 provider，也可以是能在 Chat 中画图的模型。Gateway Key 的白名单、预算、熔断与账本照常适用，失败时转移到下一个 Credential。 |
| [工具搜索](model-plane/tool-search.md) | 已实现 | 相同 | Codex 与 Claude Code 可以先不把全部工具发给模型，让模型按需搜索工具。只有厂商自己的后端认识这类工具，网关把它们改写成任何上游都能执行的普通函数与文字，Agent 换到别家模型时仍能按需加载工具。 |
| [上下文压缩](model-plane/compaction.md) | 已实现 | 相同 | Agent 在上下文将满时请模型把对话写成摘要。Codex 的压缩依赖 ChatGPT 后端，网关让它在任何上游上都能完成，并把摘要放回之后的请求。 |
| [订阅账号](model-plane/subscriptions.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 让本机的 Agent 用用户自己的 ChatGPT 套餐或 GitHub Copilot 订阅调用模型，与 API Key 的 provider 一样参与路由组、熔断与账本。HarnessHub 只用厂商为第三方应用提供的机制（或驱动用户已安装的官方客户端），不冒充其他客户端，也不读其他应用的登录。 |
| [局域网共享与级联](model-plane/lan-sharing.md) | 已实现 | 混合（相同、有意不同、未覆盖） | 让同一局域网中的其他电脑或同事使用这台 HarnessHub 的 provider、额度与账本，而管理接口与控制台不对网络开放；也可以反过来，把另一台开启了共享的 HarnessHub 当作一个 provider，经它的路由组与凭据调用模型。 |
| [出站代理与网络](model-plane/outbound-network.md) | 已实现 | 部分 | 只能经 HTTP(S) 或 SOCKS5 代理访问外网的用户，让守护进程自己发出的所有请求（模型调用、模型列表、目录刷新、ChatGPT 登录、同步、OTLP 等）都经过代理，并在代理出问题时立即得到指向代理的错误。个别 provider 可以直连或使用另一个代理。 |
| [OTLP 导出](model-plane/otlp-export.md) | 已实现 | 相同 | 把每次模型调用作为一个 OpenTelemetry span 发给自己的收集端（本机 Jaeger、OpenTelemetry Collector、Grafana Cloud、Honeycomb、自己部署的 Langfuse），在已有的观测系统里看调用耗时、token、费用与错误；可选另发 GenAI 指标，以及经遮蔽的请求与回答。 |

### Agent 平面

把本机 Agent 接到网关，并同步指令、MCP 与 Skills。

| 功能 | 状态 | 对照 Magpie | 用途 |
|---|---|---|---|
| [全局接线](agent-plane/global-wiring.md) | 已实现 | 混合（相同、有意不同、部分） | 把本机已安装的编码 Agent 改为经 HarnessHub 网关调用模型：直接改写 Agent 自己的用户配置，写入只属于这个 Agent 的 Gateway Key 与所选模型。写入前先给出带掩码 Key 的 diff，写入有备份、原子写与回读校验，随时可以还原。 |
| [支持的 Agent](agent-plane/agent-adapters.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 列出全局接线能改写哪些 Agent、每个写哪些文件、走什么协议、Key 放在哪里，以及各自特有的选项。用户据此判断自己的 Agent 能否接到网关、接线后要注意什么。 |
| [首次使用](agent-plane/first-run-init.md) | 已实现 | 无对应项 | 第一次使用时，把“添加 provider 与 Key → 读取模型 → 选 Agent → 选默认模型 → 一份合并的预览后接线”串成一个流程，不必分别记住 `hh provider add` 与 `hh wire`。终端中是 `hh init`，浏览器中是控制台首页的“开始使用 HarnessHub”。 |
| [Profile](agent-plane/profiles.md) | 已实现 | 混合（相同、部分、未覆盖） | 把所有已接线 Agent 当前的模型选择存成一个有名字的 Profile，之后一次切换回去，例如“工作”与“个人”用不同的模型。切换前逐个 Agent 显示 diff，确认后才写入。 |
| [每个 Agent 的模型清单](agent-plane/agent-model-lists.md) | 已实现 | 混合（相同、部分） | 决定每个 Agent 的模型选择器里出现哪些网关模型，并且让 Agent 的 Key 只能调用这些模型。默认显示网关的全部模型（包括之后新增的），用户可以缩小范围或逐个隐藏，不必重新接线。 |
| [目录同步](agent-plane/catalog-sync.md) | 已实现 | 有意不同 | provider、模型或路由组变化后，让已接线 Agent 文件中的模型清单跟上网关现在能给这把 Key 的模型，用户不必逐个重新接线。用户自己改过的 Agent 不会被覆盖，而是被标出来，由用户决定。 |
| [Library 指令集](agent-plane/library-instructions.md) | 已实现 | 混合（相同、部分、未覆盖） | 在 HarnessHub 中保存一份或几份团队指令（Markdown），同步到各 Agent 自己的用户级指令文件（`CLAUDE.md`、`AGENTS.md`、`GEMINI.md` 等），不再逐个文件复制粘贴。HarnessHub 只占用文件中带标记的一个区块，区块外用户自己的内容不动。 |
| [Library MCP 服务](agent-plane/library-mcp.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 把一个 MCP 服务登记一次，同步到多个 Agent 各自的 MCP 配置中（Claude Code 的 `~/.claude.json`、Codex 的 `config.toml` 等），格式由 HarnessHub 按 Agent 转换。 |
| [Library Skills](agent-plane/library-skills.md) | 已实现 | 混合（相同、部分、未覆盖） | 把符合 Agent Skills 规范的 Skill 目录导入一次，放进多个 Agent 各自的 Skills 目录。导入时就按规范和各平台的路径规则校验，不合格的不会进入 Library，也不会同步后被 Agent 静默跳过。 |
| [Library 同步到 Agent](agent-plane/library-sync.md) | 已实现 | 混合（相同、部分、未覆盖） | 把 Library 中的指令集、MCP 服务与 Skills 写进各 Agent 自己的文件与目录，并在条目删除或改去往后再取出。写入方式与全局接线相同：先预览，确认后备份、原子写、回读校验。 |

### 执行平面

通过 API 驱动 Agent 执行任务，Magpie 没有这一层。

| 功能 | 状态 | 对照 Magpie | 用途 |
|---|---|---|---|
| [Session 与 Run](run-plane/sessions-runs.md) | 已实现 | HarnessHub 独有 | 调用方为一个已登记的引擎创建 Session，再向它逐次提交 Run（一段文本任务）。HarnessHub 负责排队、总期限、取消与唯一终态，调用方随时查询或订阅结果。 |
| [事件、SSE 回放与轨迹导出](run-plane/events-replay.md) | 已实现 | HarnessHub 独有 | 一次 Run 的过程（状态变化、回复文本、工具调用、权限、模型调用、产物）都以事件保存。客户端可以边执行边订阅，断线后从上次的位置续读，结束后把完整轨迹导出成 JSON Lines 文件，用于复查、评测或离线分析。 |
| [权限往返](run-plane/permissions.md) | 已实现 | HarnessHub 独有 | Agent 执行中请求写文件、运行命令等需要确认的操作时，请求经 HarnessHub 交给人或调用方，按实际选项回答一次。决定先落库再送达引擎，事后可以复查谁在什么时候允许或拒绝了哪一次工具调用。 |
| [文件产物](run-plane/artifacts.md) | 已实现 | HarnessHub 独有 | 提交任务时声明“执行完要交回哪些文件”，HarnessHub 在 Agent 正常结束后把这些文件复制成不可变的产物并登记 hash。之后源文件被改写也不影响已交回的版本，下载时再次核对大小与 SHA-256。 |
| [引擎发现、登记与热加载](run-plane/engine-management.md) | 已实现 | HarnessHub 独有 | 守护进程可以从空的引擎目录启动，运行中扫描本机已安装的 Agent，挑选候选登记为引擎，无需重启。每次修改生成新的不可变 revision，已经创建的 Session 继续用原来的命令与配置，换引擎就是为下一项任务新建 Session。 |
| [引擎独立配置与检查](run-plane/engine-configuration.md) | 已实现 | HarnessHub 独有 | 给每个登记的引擎单独指定模型、Provider（地址与密钥）、Skills、MCP 服务和环境变量，不同引擎的同名变量互不影响，密钥只以引用保存。保存前可以检查配置，保存后可以“检查连接”（不调用模型）或“测试模型”（发一条真实请求）。 |
| [ACP 与 CLI 驱动](run-plane/drivers.md) | 已实现 | HarnessHub 独有 | 把不同的 Agent 程序接成同一种执行方式：支持 ACP 的 Agent 经 ACP 驱动建立长会话、上报结构化事件与权限请求；只接受文本输入、向标准输出写文本的命令经 CLI 驱动逐轮运行。 |
| [Worker 隔离、进程清理与恢复](run-plane/worker-isolation.md) | 已实现 | HarnessHub 独有 | 每个 Session 的 Agent 在自己的 Worker 进程里运行，使用私有的 HOME、临时与配置目录，只拿到明确允许的环境变量。Run 结束、取消或 Session 关闭时，HarnessHub 回收整棵进程树并如实报告是否清理干净。 |
| [任务经共享网关](run-plane/runs-on-gateway.md) | 已实现 | HarnessHub 独有 | 让执行平面的任务和本机其他客户端共用同一个模型网关：Run 用模型平面里的 provider 与路由组，享受同样的重试、熔断与粘性，每次调用都进 `model.call` 账本并按 Run 汇总用量与费用。在控制台的任务输入框里可以为这次执行选一个模型。 |
| [先做计划（Workflows）](run-plane/workflows.md) | 已实现 | HarnessHub 独有 | 把一个较大的目标先交给模型拆成几步计划，人审核每一步的说明、依赖、产物与选用的引擎，确认后再按依赖顺序执行。计划、选择理由、每一步的 Session 与 Run 都持久保存，便于复查。 |
| [工具包与能力包](run-plane/tool-packs.md) | 已实现 | HarnessHub 独有 | 把本机选好的 Skills、MCP 服务和命令行程序拷进 HarnessHub 自己的存储，校验每个文件的 hash，再一键写进所有兼容引擎的配置。能力包（Capability Pack）是这一用法的简称：只给一个目录或 JSON 文件和目标引擎，导入、生成清单、绑定与发布新 revision 都由 HarnessHub 完成。 |
| [执行观测](run-plane/observability.md) | 已实现 | HarnessHub 独有 | 回答“这次执行用了哪个模型、花了多少 token 和钱、时间耗在哪里、数据是否完整”，并在出问题时看到 Gateway 与引擎两侧的诊断日志。所有数字都从已提交的事件重建，未知就是未知，不用零或配置值冒充。 |
| [Benchmark 与 rollout 导出](run-plane/benchmark-rollout.md) | 已实现 | HarnessHub 独有 | 用版本化的 dataset 让一个或多个引擎做同样的文本、JSON 或文件任务，每次 attempt 用独立的 Session 与工作目录，执行结果与评分分开保存，可以离线重新评分并输出成绩矩阵。rollout 导出把一次 Run 的已提交事件存成 JSON Lines 文件，作为可复查的执行轨迹。 |
| [统一模型（遗留）](run-plane/unified-model-legacy.md) | 遗留（已弃用、计划移除） | HarnessHub 独有 | 比赛期的约束：配置一个上游 Chat Completions 模型后，所有引擎只用这一个模型，引擎自带的 Key、登录与订阅都不参与。开源版改由模型平面（provider 与 `group/default`）承担，这里保留的只是兼容旧部署的入口：旧来源仍然生效，并在启动时被镜像进模型平面。 |

### 界面与入口

控制台、终端界面、命令行与 HTTP API。

| 功能 | 状态 | 对照 Magpie | 用途 |
|---|---|---|---|
| [Web 控制台](interfaces/web-console.md) | 已实现 | 混合（相同、有意不同、部分、未覆盖） | 在浏览器中管理本机的模型平面与 Agent：接线、provider、订阅账号、路由组与 Key、用量、Profile、Library 与设置，以及无人值守的任务。守护进程在自己的端口直接提供页面，打开 `hh console` 打印的一次性链接即登录，浏览器从不接触管理令牌。 |
| [终端界面](interfaces/terminal-ui.md) | 已实现 | 混合（相同、部分、未覆盖） | 在 SSH 会话或不想打开浏览器时，用一个终端界面浏览本机 Agent 并切换它们经网关使用的模型、档位、effort 与选项，保存和应用 Profile。它是 `hh agents`、`hh wire`、`hh profile`、`hh unwire` 的交互版，写入前同样先预览改动。 |
| [命令行 `hh`](interfaces/cli.md) | 已实现 | 混合（部分、未覆盖） | 一个 `hh` 命令完成启动守护进程、配置 provider 与 Key、接线 Agent、查看用量、备份与同步等全部操作，适合脚本与无浏览器的环境。除 `serve` 等少数命令外，它经 SDK 调用运行中的守护进程，不直接读写数据库。 |
| [HTTP API 与 SDK](interfaces/http-api-sdk.md) | 已实现 | 混合（相同、部分） | 让脚本、CLI 与控制台以同一套 HTTP 接口管理守护进程，并让 Agent 与 SDK 客户端在同一端口调用模型。`@harnesshub/sdk` 是这套管理接口的 TypeScript 客户端，`hh` 与控制台都经它访问 `/api/v1`。 |

### 安全与运维

访问控制、秘密、备份同步、配置、日志、打包与测试门禁。

| 功能 | 状态 | 对照 Magpie | 用途 |
|---|---|---|---|
| [本机访问控制与控制台会话](operations/local-access.md) | 已实现 | 有意不同 | 守护进程默认只服务本机：同一台电脑上的 CLI 用令牌文件、浏览器用一次性链接换来的会话访问管理面，其他网页、本机其他端口的服务与局域网上的机器都不能借用这些凭据。开启局域网共享时，局域网只能调用模型，不能管理守护进程。 |
| [秘密存储](operations/secrets.md) | 已实现 | 有意不同 | provider 凭据、搜索后端的 Key、同步口令等秘密保存在系统密钥库或加密文件中，配置与数据库只保存引用；Gateway Key 与令牌只保存哈希。 |
| [备份与恢复](operations/backup-restore.md) | 已实现 | 混合（相同、有意不同、部分） | 把本机模型平面的配置（provider 与凭据、路由组、Agent 接线、Profile、Library、网关功能与部分设置）封进一个用口令加密的文件，在另一台电脑或重装后恢复。恢复先给出完整摘要，确认后逐条写入，并为本机已安装的 Agent 以新 Key 重新接线。 |
| [多机同步](operations/sync.md) | 已实现 | 混合（相同、有意不同、部分） | 让几台电脑经同一个 WebDAV 目录或 S3 兼容存储桶自动保持 provider、Agent 接线、Profile、Library 与网关功能一致。服务器上只有用同步口令加密的文件，两边同时改动时保留后改的一边并把被替换的一方存为副本。 |
| [配置](operations/configuration.md) | 已实现 | 混合（有意不同、部分） | 把 `hh serve` 的启动设置（端口、数据目录、秘密后端、目录刷新、接线、出站代理、网关上限、OTLP 导出等）写在一个带注释的文件里，并能查看每个值从哪里来。provider、Key、Profile 等业务记录与局域网共享、网关功能等运行时设置不在这个文件中。 |
| [日志与诊断](operations/logs-diagnostics.md) | 已实现 | 部分 | 部署机器上通常不能挂调试器。守护进程与每个 Session 的 Worker 各写一份 JSON Lines 诊断日志，记录访问、生命周期、引擎进程、ACP 流量与模型调用摘要，出问题时能区分是引擎启动、协议、权限、网关还是上游模型的问题，并且不泄露密钥。 |
| [构建身份与打包](operations/build-packaging.md) | 部分实现（构建身份已实现；单可执行文件是原型，没有发布） | 混合（有意不同、部分、未覆盖） | 回答“正在运行的是哪个提交、在哪台机器上构建的”，并为把 HarnessHub 分发成一个不需要另装 Node 的可执行文件做准备。目前用户从源码构建运行。 |
| [测试体系与检查门禁](operations/testing-gates.md) | 已实现 | 无对应项 | 每次改动用同一条 `pnpm check` 在本机证明行为没有退化：从格式、依赖边界、文档链接到真实 SQLite、IPC、HTTP 与官方 SDK 客户端。测试在与开发者环境隔离的沙箱中运行，上游与 Agent 由本机替身代替，默认不消耗真实 API。 |
<!-- INDEX:END -->

## 优化候选摘要

每篇的“优化候选”列出全部候选；这里按分类挑出梳理时最值得先看的几条，详情与依据见所链接的一篇。

### 已确认或疑似的缺陷

- Full Access 没有到达 Worker：守护进程为 Worker 构造环境时只传日志级别，`HARNESSHUB_FULL_ACCESS` 不在白名单中，而 Worker 中的 ACP 驱动读的正是它；控制台显示“完全访问”，Worker 中的自动批准不生效。已对照代码确认，尚无端到端测试（[权限往返](run-plane/permissions.md)）。
- `hh version --help` 打印的是 `hh serve` 的用法（[命令行 `hh`](interfaces/cli.md)）。
- Library 的 `--agent all` 展开为全部 9 个 Agent，不支持的 Agent 让整条登记被拒（指令集遇到 Kimi、Hermes，SSE 的 MCP 服务遇到 Codex、Pi）；不点名 Agent 的同步也会写入未安装的 Agent。来自阅读代码，未实际运行（[Library 同步到 Agent](agent-plane/library-sync.md)）。
- `hh serve --host` 设为非回环地址时，服务器级的 Host 检查整体关闭，旧 `/v1` 管理接口在该网络上不需要凭据；`OPTIONS` 预检的实际行为与 07 第 5.3 节不一致且没有测试（[本机访问控制与控制台会话](operations/local-access.md)）。
- 只设成本预算的 Key 可以无限使用没有价格的模型（[Gateway Key](model-plane/gateway-keys.md)）。
- 添加 provider 时 HTTP 地址的私网判断比出站策略窄：Tailscale（`100.64/10`）、IPv6 私有地址、`.local` 上的本机服务只能用 HTTPS 添加（[Provider 与预设](model-plane/providers-presets.md)）。

### 模型平面

- 移除 Worker 内的 Session 网关：它的规范化规则与共享网关不同，也不经出站代理（[网关与协议转换](model-plane/gateway-protocols.md)、[出站代理与网络](model-plane/outbound-network.md)）。
- 46 个预设中有 26 个标为 unverified，端点取自 Magpie 未重新核对（[Provider 与预设](model-plane/providers-presets.md)）。
- 粘性记录与规则决定只在内存中，重启后会话可能换到另一个凭据，提示缓存与推理签名失效（[路由组与策略](model-plane/route-groups.md)、[路由规则与分类器](model-plane/routing-rules.md)）。
- 局域网共享只有明文 HTTP，局域网 Key 不要求预算，也没有按来源 IP 的失败锁定（[局域网共享与级联](model-plane/lan-sharing.md)）。

### Agent 平面

- Profile 应用中途失败不回滚，Profile 也不含 Library 的选择（[Profile](agent-plane/profiles.md)）。
- 崩溃留下的接线锁只能手工删除，期间这个 Agent 的接线、还原与同步都失败；目录同步整轮失败只记日志（[全局接线](agent-plane/global-wiring.md)、[目录同步](agent-plane/catalog-sync.md)）。
- 28 个 Adapter 中多数只有库层测试，没有用真实 Agent 读取接线后的配置（[支持的 Agent](agent-plane/agent-adapters.md)）。

### 执行平面

- 用 Agent 自己接线运行的任务（没选模型、没有 `group/default`）没有按执行的用量；Workflow 的规划与步骤从不带 `model`（[任务经共享网关](run-plane/runs-on-gateway.md)、[执行观测](run-plane/observability.md)）。
- Worker 不会空闲回收，常驻满 16 个后新 Session 得到 `WORKER_CAPACITY`（[Worker 隔离、进程清理与恢复](run-plane/worker-isolation.md)）。
- 执行接口仍在旧 `/v1`，不受会话保护，SDK 没有 Run 与 SSE 层（[Session 与 Run](run-plane/sessions-runs.md)、[HTTP API 与 SDK](interfaces/http-api-sdk.md)）。

### 界面与运维

- 控制台没有浏览器自动回归测试；从其他网站的链接打开控制台得到 403，放宽与否待所有者决定（[Web 控制台](interfaces/web-console.md)）。
- 还没有可安装的产物：npm 包与单可执行文件都未发布，完整版单可执行文件只在 macOS arm64 上构建过（[构建身份与打包](operations/build-packaging.md)）。
- 多机同步只对假的 WebDAV 与 S3 服务器验证过（[多机同步](operations/sync.md)）。
- 文档：[工具包](../tool-packages.md#工作区只读工具包) 的“工作区只读工具包”一节仍是旧发行包的写法；ADR 0019 已实现但状态仍为 proposed（[工具包与能力包](run-plane/tool-packs.md)、[任务经共享网关](run-plane/runs-on-gateway.md)）。

## 每篇的结构

每篇以一张概要表开头，然后是固定的小节。小节没有内容时写“无”，不删除标题，便于横向比较。

| 概要表的行 | 写什么 |
|---|---|
| 分类 | 模型平面、Agent 平面、执行平面、界面与入口、安全与运维之一 |
| 状态 | 已实现、部分实现，或遗留（已弃用、计划移除） |
| 验证 | 自动化测试覆盖到哪一层（单元、集成、协议、smoke），在哪个平台上通过；是否用真实 Agent 或真实 provider 跑过；Windows 是否验证 |
| 对照 Magpie | 按 [对照表](../magpie-parity.md) 的口径：相同、有意不同、部分、未覆盖，或 HarnessHub 独有 |
| 权威文档 | 这个功能的行为细节所在的文档 |

| 小节 | 写什么 |
|---|---|
| 用途 | 从使用者的角度，两三句话说明它解决什么问题 |
| 入口 | 控制台页面、`hh` 命令、HTTP 接口，哪一个有就列哪一个 |
| 已实现的能力 | 已经能做的具体行为，每条一行 |
| 实现位置 | 主要源码、测试与决策记录的位置 |
| 已知限制与未验证 | 做不到的、只在假上游或某个平台上验证过的 |
| 优化候选 | 每条写清现状、方向与依据（TODO 中的未完成项、对照表中的“部分”与“未覆盖”、文档中的差异与待做，或阅读代码时的观察） |
