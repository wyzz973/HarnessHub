# 工程现状（HarnessGateway）

> 本篇原是仓库首页 README，2026-11-07 起移到这里；公开首页见[项目 README](../../README.md)。

工作名，2026-10-09 建立。目标是一个统一的 Harness 聚合网关：用户通过一个入口持续对话或发送命令，网关管理不同 Harness 的接入、选择、执行和交接；公共 Session 不绑定某个厂商的原生会话。

当前先做本机核心 MVP。已实现目录/安装发现、ACP/Codex控制、持久公共Session、多轮历史、同Session手动切换Harness、取消与有界命令行入口。默认目录含45产品/49控制描述，数量不代表全部已可执行。已实现Provider管理/不可变配置版本/静止切换与本机图形工作台。自动择优按用户要求暂缓。已验证真实Codex→Gemini→Codex的同Session接续，模型端点为本地确定性服务；真实云模型不由此推断。

## 图形工作台

界面已重做为紧凑的原生工作台：真实品牌图标、可搜索选择器、清晰字号、可折叠侧栏、安装任务与详情侧板，并结合Magpie/CC Switch管理流程。使用自有HarnessHub品牌。先启动本机页面：

~~~sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm web:build
pnpm web --cwd /absolute/workspace --data-dir data --port 4317
~~~

将工作目录换成已有目录，打开启动时打印的一次性链接。服务只监听127.0.0.1；链接中的认证令牌兑换后从地址栏移除，刷新使用本机cookie。当前对话ID保留在页面fragment；关页面不取消任务，Ctrl+C等待清理并保留历史。服务独占该data-dir；直接使用CLI同数据根前先停止服务。

对话现通过已提交事实的SSE实时显示回复，刷新或重连不会重新执行消息。消息区支持流式Markdown、生成反馈、阅读时暂停滚动、复制与执行详情；停止后保留部分内容。输入区为自动增长文本框和紧凑选择器，高级配置按需展开。短回复若模型几乎同时返回，仍可能一次显示；没有人工打字延迟。验收见[实时对话记录](../verification/live-chat-2026-10-10.md)，可单独运行 `pnpm test:real:stream` 验证真实Codex和本地确定性Provider的首块/重连。

Harness连接或目标切换失败时，历史与原选择保留，可继续使用当前选择或明确重试。草稿在当前标签页按对话保存，刷新也可恢复。旧blocked会话可选择Harness并“检查连接并恢复对话”；未知结果需明确确认，清理未确认仍需先处理资源，不自动重跑旧任务。结束会话前说明后果并确认。审查见[对话恢复记录](../verification/conversation-recovery-2026-10-10.md)。当前业务存储为v12（保留v1→v2→v3→v4→v5→v6→v7→v8→v9→v10→v11→v12事务迁移）；每次版本提升前HarnessHub先在数据根的`backups`目录留一份副本，只保留最新2份，备份失败则不迁移；回退旧程序时按[存储契约](../contracts/storage-events.md#业务库迁移前备份adr-049)的手动恢复步骤换回升级前的副本（[ADR-049](../decisions/0049-business-store-backup-before-migration.md)）。

所有接入的Harness使用本机已安装入口，默认沿用本机模型配置和登录。模型列表由所选Harness原生接口读取，未指定时跟随其本机默认；不写全局模型配置，不创建空native HOME。选择Harness、Provider或模型后直接提出切换，不再点“应用”；当前回复保持原选择，新消息等待最后一次选择生效。配置验证失败保留原选择与草稿，快速改选只推进最新未受理选择。普通切换不启动目标进程，effective表示下一轮配置选择已保存；原生连接、认证与额度在发送时分别核实。选择器显示每个入口上次读取模型目录时的状态（已就绪、需要登录或配置、读取失败）和通常启动用时；目录按配置指纹复用最长24小时并跨重启保存在数据根的`native-catalogs.json`，读取目录时原程序建出的空会话默认不在“本机会话”中列出（[ADR-033](../decisions/0033-native-catalog-cache-and-readiness.md)）。对话可在执行配置里开启“保持原生进程”（默认关闭）：回合之间不关闭原程序，后台任务可以继续，下一条消息直接复用它而不必冷启动；空闲30分钟后结束，同时最多保留4个，切换、关闭、重建、分支与服务关闭时先结束并留证；服务异常退出后，下一次启动先结束上一服务遗留的进程组，确认后才释放工作区，无法确认时工作区保持隔离；关闭或接管时记录离开进程组的后台任务，HarnessHub不结束它们，仍在运行时在对话中提示一次（[ADR-030](../decisions/0030-retained-native-processes.md)，业务格式v12；升级前备份数据目录，回退旧程序需恢复升级前备份）。审批与提问显示期限及来源（原程序自己的期限或HarnessHub的等待期限）；侧栏在每个项目里把等你处理的对话排在最前并倒计时，侧栏的“等你处理”列出所有对话中等待的审批与提问；审批停在输入框的位置决定，提问留在它的回合里；浏览器通知默认关闭，由你在“等你处理”或设置中开启（[ADR-035](../decisions/0035-attention-and-request-deadlines.md)，[ADR-054](../decisions/0054-design-language-2.md)）。每个回合的执行时间上限默认300秒，等待你决定的时间不计入，另有默认30分钟的等待期限，到期本回合取消、原程序不会收到决定；可用`--execution-budget <秒>`与`--wait-budget <分钟>`调整。不同工作区的对话最多4个同时执行；同一工作区的后一个对话排队，并说明在等哪个对话、它是否在等你，可以打开那个对话或取消排队（[ADR-036](../decisions/0036-approval-wait-budget.md)）。任何官网渠道的安装、任何版本（包括读不出版本的）都照常接入，界面只显示版本号与渠道最新版本，不按版本号提示或劝阻（[ADR-053](../decisions/0053-latest-version-baseline.md)，2026-10-22；取代 ADR-038 的“未经验证的版本”提示）。设置页的“发现”可以由你触发，从登录shell的PATH补充搜索目录（会执行你的shell登录配置，只在点击时读取一次，可逐项移除；[ADR-040](../decisions/0040-login-shell-search-directories.md)）。对话的详情栏“执行”页显示原生会话ID，并给出在原程序中继续的命令（按产品对任何版本给出；交互形式按原程序帮助给出，一次性形式在最新正式版上核对过），只供复制，HarnessHub不执行（[ADR-039](../decisions/0039-continue-in-the-original-program.md)）。每轮的执行详情可以复制诊断信息：版本、阶段耗时、结束原因、清理状态与本轮stderr的最后4 KiB，服务端已隐去路径、环境变量值和密钥样式的字符串，默认不含对话内容（[ADR-037](../decisions/0037-run-diagnostics.md)）。

Web界面按用户确认的设计稿第 20 版实现设计语言 2.0（[ADR-054](../decisions/0054-design-language-2.md)，[验收记录](../verification/design-language-2-2026-11-01.md)；取代 [ADR-042](../decisions/0042-frontend-redesign.md) 的视觉方向）：中性冷灰与蓝色强调，颜色只表达状态；侧栏按项目归组，用状态点区分进行中、等你处理与失败；每轮回复前标出 Harness、模型与思考强度，工具默认折叠为一行摘要（失败与未完成的数量写在摘要里），可切换为详细；计划条停在输入框上方，状态栏在下方；审批停在输入框的位置，⏎ 允许一次、esc 拒绝；右侧详情栏分改动、计划、过程、后台与执行，⌘\ 打开或收起；回复进行中可以先写下一条，本轮正常结束后自动发出一次，其他情况放回输入框；⌘K 命令面板、⌘J 换 Harness、⌘. 停止、⌥⌘↓ 下一件等你处理、⌘/ 快捷键表、⇧⌘O 新对话；浅色、深色或跟随系统，系统开启“减少动态效果”时只保留短淡入淡出。正文用系统字体（中文引号取本机苹方的全角字形），代码用随前端打包的 Geist Mono；页面不加载任何外部资源，内容安全策略只允许本机网关。

当前生产页面只使用各Harness本机已配置的模型，统一Provider管理后置。旧Provider接口与实验验收保留，已有显式Provider会话不会静默改成原生模式。原生模型选择/直接切换见[ADR-015](../decisions/0015-native-harness-models-and-switching.md)、[Multica调研](../research/multica-native-models.md)及[验收](../verification/native-models-2026-10-11.md)。业务格式现为v12，升级前备份，回退旧程序前恢复旧备份。

当前受管组合为 **Codex + OpenAI Responses**、**Gemini CLI + Gemini（API Key）**。其他产品继续检测，但协议/受管配置能力单独标明。OpenAI/Anthropic连接地址通常含/v1；Gemini填写API服务根。密钥只写入本机加密vault，不回显到UI/Session；同OS用户可访问主密钥，本版不宣称系统钥匙串隔离。

详见[工作台与Provider契约](../contracts/provider-web-mvp.md)、[取舍](../decisions/0011-provider-web-mvp.md)、[实际验证](../verification/provider-web-2026-10-09.md)。

## 本机原安装与版本管理

已发现的本机PATH/显式入口优先，原安装和既有配置/登录作为当前执行来源，旧私有副本不能覆盖它。生产管理任务使用原npm/uv位置或已审核用户程序目录，真实CLI版本、原配置保护与未知结果分别记录。macOS Homebrew升级通过原SDK创建一个可认证的继承沙箱，模型/登录/shell配置与Homebrew仓库均拒绝写入；没有对应SDK时明确不可用。用户开发目录不自动替换。管理库v1→v2追加冻结计划；业务会话库现为v12。旧私有版本槽只保留历史及显式测试模式。详见[ADR-017](../decisions/0017-native-installation-management.md)与[本轮验收](../verification/native-management-2026-10-11.md)。

升级本机 Harness 时先检查再确认（[ADR-043](../decisions/0043-upgrade-with-running-programs.md)）：
- 确认框列出会重启的后台服务及命令原文、仍用旧版本的程序、会先关闭的 HarnessHub 空闲进程、插件、退回命令，以及新版本要求的 Node.js。
- 正在回复的对话、其他 HarnessHub 进程、不满足的 Node.js 要求会阻止升级。
- 同意后安装并核实版本，随即按产品自己的方式重启它的服务，并确认它重新运行、在端口上监听。OpenClaw 按它官方文档的顺序（[ADR-052](../decisions/0052-openclaw-upgrade-route.md)，2026-11-01）：先 `openclaw gateway stop`，逐个版本 npm 安装（2026 年 7 月前的安装先经 2026.9.5）并运行 `openclaw doctor --fix --yes`，再 `openclaw gateway start` 与 `openclaw node restart`；确认框列出命令原文，要求先运行 `openclaw backup create` 并勾选，退回旧版本只能从这份备份恢复。
- 改动前停下的任务显示“没有升级”。管理库因此升到 v3（只改版本号），退回旧构建前用 `tools/management-v3-to-v2.sql` 降级。验收见[升级与重启验收](../verification/upgrade-restart-2026-10-12.md)。

只认官网安装方式（[ADR-044](../decisions/0044-macos-official-channels.md)，2026-10-17）：
- 程序落在产品官网写明的渠道里才算已安装：npm 全局（任意前缀，含 Homebrew 的 Node.js 和 nvm 等版本管理器）、Homebrew formula 或 cask、官方安装脚本的固定目录、uv 工具。各产品的渠道和来源见[渠道调研](../research/official-install-channels-2026-10-17.md)。
- 源码目录、`npm link`、自行编译的程序不算；Harness 页显示未安装、给出官网安装命令，并用一句不带路径的话说明发现了非官网安装。pnpm、bun 全局装的官方包列出但暂不维护。
- 同一产品装了多份时全部列出，按 HarnessHub 服务进程的 PATH 顺序标出“当前使用”的一份；终端的 PATH 可能不同。
- 正式入口默认只认官网，不读发现清单；`--allow-unofficial` 只用于开发和测试，此时 Harness 页顶部显示开发模式。
- 每份可维护的安装都可以单独卸载，只删程序，配置、登录和会话数据保留（[验收记录](../verification/uninstall-2026-10-17.md)）：
  - 确认框先列出会运行的命令、删除的文件、保留的数据，以及先按产品命令停止并注销的后台服务（例如 OpenClaw、Hermes 的网关）。
  - npm 用该前缀自己的 npm，Homebrew 用它自己的沙箱，官方脚本按安装脚本写入的白名单删除。
  - 正在回复的对话、产品的常驻程序、产品没有声明的后台服务会阻止卸载。
  - 管理库因此升到 v4，退回旧构建前先用 `tools/management-v4-to-v3.sql` 降级（会删除卸载任务的记录），再用 `tools/management-v3-to-v2.sql`。
- 没装的产品可以按官网方式代为安装（[验收记录](../verification/official-install-2026-10-17.md)）：
  - Claude Code、Codex、OpenCode、Cursor 运行官方脚本，OpenClaw、Gemini CLI、Pi、DeepSeek Harness 用 npm，Hermes 只给终端命令。
  - 确认框先显示来源和 SHA-256、实际运行的命令、可写位置、可能改动的 shell 启动文件，以及安装后终端里的命令指向哪一份。
  - 脚本在沙箱里只能写它的安装目录；npm 装入 PATH 上第一个 Node.js 的前缀，装的是确认时的精确版本。
  - 管理库升到 v5，降级先用 `tools/management-v5-to-v4.sql`。
- 每份可维护的安装都可以单独升级（[验收记录](../verification/installation-upgrade-2026-10-17.md)）：
  - npm 用该前缀自己的 npm 装入确认时的精确版本；Homebrew 按它的本地记录升级，先预演，把一并升级的包（含 node 这类共享运行时）列进确认框，预演改动了已装的包就停止。
  - Claude Code、Cursor 的脚本安装运行产品自己的更新命令（“立即更新”），Codex、OpenCode 的脚本安装重新运行官方脚本；Hermes 只给终端命令 `hermes update --yes` 并说明它会做什么。
  - 确认框显示现版本与目标、实际运行的命令、可写位置和仍在运行它的程序；正在回复的对话、这份安装上的后台服务会阻止升级。OpenClaw 当前使用的那份仍走上面的升级与重启流程。
  - 管理库升到 v6，降级先用 `tools/management-v6-to-v5.sql`（会删除这些升级任务的记录）。
- 安装、升级和卸载的程序都按终端的默认 umask 022 运行，不随 Gateway 自己的 umask（4317 用 077），装出来的权限与在终端运行官网命令相同（[管理操作验收](../verification/management-actions-2026-10-18.md)）。

统一查看各 Harness 的能力（[ADR-045](../decisions/0045-unified-capability-management.md)，2026-10-18，第 1 步只读）：

- 侧栏的“能力”页分技能、MCP、指令、子 Agent、命令、Hooks、插件七类，列出每个官网安装的 Harness 能看到什么、经由哪里（共享目录、链接、自有目录、兼容读取等）、是否生效（停用、被覆盖、重复、被跳过、链接失效、无效）。
- 页面提示重复、遮蔽、交叉、不可见、明文值与多余的链接；Harness 详情可以直接打开这个 Harness 的能力。
- 只读用户级文件，不运行 Harness 命令，不启动 MCP 服务器；只显示名字与数量，不显示任何值。
- 展开技能可以在各 Harness 中停用或启用它（第 2 步，[技能开关验收](../verification/capability-switches-2026-10-18.md)）：
  - 先显示要改的文件、精确差异（密钥打码）和现有设置由谁写的，确认后才写入；
  - 写入前备份原文件（每个文件留最近 10 份），写后回读核对，可以在“修改与备份”里恢复；
  - OpenClaw 用它自己的命令，在沙箱里先对副本预演；Cursor、Pi、DeepSeek Harness 没有开关。
  - 新存储 `data/capabilities/`（`capabilities.sqlite` 与备份）。
- 共享技能目录 `~/.agents/skills`（[放置与清理验收](../verification/capability-placement-2026-10-18.md)）：
  - 技能页签上方写明各 Harness 怎样读取它（自己读、经 `skills.external_dirs`、经链接），以及自己目录里有几个多余的链接；
  - 可以让 Hermes 经 `skills.external_dirs` 读取它，为 Claude Code 逐个放置共享技能（绝对路径链接），清理 Hermes、OpenClaw 已多余的链接；
  - 链接改动可以在“修改与备份”里撤销。
- HarnessHub 写过的设置和链接被外部移除或改动时（例如 Harness 整份重写了配置文件），页面顶部列出，不自动改回；可以先看改动再重新应用，或不再跟踪（文件不变）。
- 技能的添加、更新与删除（[验收记录](../verification/capability-packages-2026-10-18.md)）：
  - **添加**：在“共享技能目录”卡片里“从 GitHub 添加技能”，先读取仓库，列出每个技能的文件数、可执行文件数和状态（可添加、已安装、同名冲突、不能安装），确认后写进 `~/.agents/skills`。按 npx skills 的规则命名，`metadata.json`、`.git` 等不复制；HarnessHub 自己添加的不写 lock。
  - **检查更新**：对 HarnessHub 装的技能和 npx skills 从 GitHub 装的技能，每个仓库调一次 GitHub 的匿名树接口（每小时 60 次）。
  - **更新**：逐个列出文件改动和 lock 的差异；本地改过时要选择“覆盖本地改动并更新”。lock 只改 `skillFolderHash` 和 `updatedAt`，其余字节不变，改前先备份。
  - **删除**：连同指向它的链接（按 HarnessHub 放置的、其他工具建的分组列出）和 lock 条目一起删；HarnessHub 写的停用设置留在原处，显示为“孤立的停用设置”，可以单独清除。
  - **撤销**：被替换或删除的文件夹先存快照，三类修改都可以在“修改与备份”里撤销（保留最近 50 次修改的快照）。
  - **存储**：`capabilities.sqlite` 升到 v2（新增 `skill_sources`、`skill_undo`），降级先用 `tools/capabilities-v2-to-v1.sql`；快照在 `data/capabilities/skills/`。
- MCP 统一清单（[验收记录](../verification/capability-mcp-2026-10-18.md)，第 3 步 3a–3c）：
  - **清单**：HarnessHub 保存一份 MCP 服务器清单。值像密钥的只记变量名，普通设置可以是字面值；不保存任何密钥值。
  - **导入**：从各 Harness 现有配置导入时，与清单一致的条目可以认领，不改文件；含明文密钥或带令牌地址的不能导入，并说明原因。
  - **写入**：按各 Harness 自己的写法写进它们的用户级配置，先显示差异、要运行的程序和所需变量。目前支持 Claude Code（用它自己的 `claude mcp add-json/remove`，先在私有副本上预演）、Codex（TOML 表组）、Cursor、OpenCode、Gemini、Hermes、DeepSeek Harness（`~/.dsh/cordis.patch.yml` 里 HarnessHub 自己的 insert）；只改自有键，用户加的设置保留。OpenClaw 暂为只读。
  - **状态**：矩阵显示每个服务器在每个 Harness 的状态；被外部改动或移除的不自动写回。
  - **真实环境**：
    - Codex 的 openaiDeveloperDocs 写进 Cursor 后保留。
    - Claude Code 与 DeepSeek Harness 做了往返写入（写入、核对、移除），最后保持移除。
    - DeepSeek Harness 启动时，客户端连接了服务器。
  - **存储**：`capabilities.sqlite` 升到 v3（新增 `mcp_servers`），降级先用 `tools/capabilities-v3-to-v2.sql`。
  - DeepSeek Harness 的补丁文件由 HarnessHub 新建时，移除最后一个服务器后删除文件；原来就有的回到 `[]`。
- 统一指令（[验收记录](../verification/capability-instructions-2026-10-19.md)，第 4 步）：
  - **内容**：一份共享指令，加每个 Harness 的追加文本，存在 HarnessHub 里；保存不改任何 Harness 的文件。
  - **写入**：以带标记的区块（`<!-- harnesshub:begin id=instructions sha=… -->`）写进各 Harness 实际读取的用户级指令文件，区块外的内容不动；先显示差异和什么时候生效。支持 Claude Code、Codex（非空的 override 优先）、Gemini（按 `context.fileName`）、OpenCode、OpenClaw（默认 agent 的工作区）、DeepSeek Harness、Pi；Hermes（SOUL.md 是人格文件）与 Cursor（用户规则不在磁盘上）不写。
  - **确认**：cc-switch 管理的文件第一次写入、新建 OpenCode 自己的文件（它对 Claude 文件的回退随之失效）、覆盖被改过的区块，都要用户先表态；OpenClaw 超过单个文件上限时不写。
  - **移除**：文件回到写入前的字节；HarnessHub 新建的文件在移除后删除。被外部改动或移除的区块进入漂移列表，不自动写回。
  - **存储**：`capabilities.sqlite` 升到 v4（新增 `instruction_texts`），降级先用 `tools/capabilities-v4-to-v3.sql`。
  - **真实环境**：DeepSeek Harness 与 Codex 做了往返写入，最后保持移除。dsh 自带的读取函数读到了区块；Codex 只验证了文件，会话里是否读到未验证。
- 统一子 Agent 与新建技能（[验收记录](../verification/capability-subagents-2026-10-19.md)，第 5 步）：
  - **子 Agent**：HarnessHub 保存一份子 Agent 清单（名字、说明、正文），按各家格式写进 Claude Code、Codex、Gemini、OpenCode 的用户级目录；不写工具、模型、权限，子 Agent 继承父会话。各家的内置名不能用，别人的同名定义不覆盖。Cursor 的本机 CLI 不读家目录的子 Agent，不写。
  - **命令**：不写各家的原生命令文件，改为在技能页“新建技能”：写进共享目录，本机所有 Harness 都读得到；正文不能含 `` !`…` ``（OpenCode 会不经确认执行）。
  - **存储**：`capabilities.sqlite` 升到 v5（新增 `subagents` 与技能来源种类），降级先用 `tools/capabilities-v5-to-v4.sql`。
  - **真实环境**：核对用子 Agent 在四家做了往返写入，最后连同新建的目录一起移除；各家会话里能否列出未验证。
- 插件启停（[验收记录](../verification/capability-plugins-2026-10-19.md)，第 6a 步）：
  - **开关**：能力页“插件”里可以停用或启用 Claude Code 与 Codex 的插件。Claude 只改 `settings.json` 的 `enabledPlugins` 里这一项，Codex 只改 `config.toml` 里这个插件表的 `enabled` 一行；先显示差异、什么时候生效、哪些设置能覆盖它，确认后才写入，并保留备份。
  - **规则**：依赖不连带改动，停用被启用插件依赖的插件、启用依赖已停用的插件都会被拒绝并点名；组织的管理设置决定或可能决定的插件不改；账户同步的插件与没有安装记录的来源只读。
  - **视图**：两家都有的插件合成一行；没有条目的插件按默认显示；改正了 OpenCode（单数 `plugin/`、点文件、tuple、TUI 插件）与 Hermes（没有启用列表时都不启用、分类布局、记忆与模型提供方）的读取，新增 DeepSeek Harness 各 profile 的插件。
  - **其他 Harness**：只读，页面写明原因。安装与卸载（第 6b 步）以后再做。
  - **真实环境**：`swift-lsp` 插件在 Claude Code 与 Codex 各往返一次，每次只改一行，启用后两个文件都逐字节回到原样；新会话里是否真的少了它，没有验证。
- 新增依赖 jsonc-parser 3.3.1、yaml 2.9.1、smol-toml 1.9.0。验收见[能力视图验收](../verification/capabilities-view-2026-10-18.md)。

原版OpenClaw2026.3.23-2、Codex0.162.1、OpenCode1.18.35、Pi0.85.1已通过本机真实模型回复；OpenClaw/Pi使用原生DeepSeek。Hermes Agent 0.12.0（官方安装方式）与 DeepSeek Harness（`dsh`）经各自内置 ACP 接入，已通过真实回复、跨 Hub 重启的原生恢复、思考与工具活动验收，见[ADR-031](../decisions/0031-hermes-and-deepseek-harness.md)与[验收记录](../verification/hermes-dsh-onboarding-2026-10-11.md)。dsh 本机现为 npm 官网的 0.2.0-rc.2（2026-10-18 经 4317 安装）；上述验收时它是源码构建 0.2.1-alpha.1、经发现清单的自定义入口接入，这些证据来自非官网安装，按 ADR-044 为历史证据。2026-10-22 已在官网 npm 的 0.2.0-rc.2 上真实重验，8 个套件中 7 个通过，一次性续接命令也已核对，真实验收版本为 0.2.0-rc.2（[重验记录](../verification/dsh-rc2-reverification-2026-10-22.md)）；Pi 的证据仍是历史证据。Claude接入口绑定本机Claude Code及既有登录：本机现为 2.1.306（nvm，当前使用）与 2.1.302（npm，Homebrew 前缀）。2026-10-22 在 2.1.306 上真实重验，12 个套件全部通过，真实验收版本为 2.1.296 与 2.1.306（适配器 claude-agent-acp 0.89.1；[重验记录](../verification/claude-2.1.306-rebaseline-2026-10-22.md)，[ADR-046](../decisions/0046-harness-focus-hardening.md)）。这些版本只是验收记录里的证据：2026-10-22 起按 [ADR-053](../decisions/0053-latest-version-baseline.md)，任何版本都接入、不按版本号提示，下一轮真实验收以各家当日的最新正式版为对象。Cursor原安装已升级至2026.10.01-e373342，沿用本机登录、44项原生模型目录并通过独立短提示回复；原公共对话实测仍返回账号套餐升级提示，不能算该对话回复通过。Gemini0.62.0的个人登录被服务端停用，直连DeepSeek实际返回404（Google GenAI协议与DeepSeek接口不匹配），不能算回复通过。所有接入口版本与原程序版本分开解释，不把ACP适配器版本当原CLI版本。

Provider统一管理仍是用户→HarnessHub→不同Harness→Provider统一管理的后续环节；当前原生接入直接使用各Harness已配置模型，不通过本项目Provider来完成DeepSeek测试。

### 旧私有安装切片（保留历史实现与证据）

在 Harnesses 查看全部支持目录、已安装、待安装或可更新项。点击安装会在后台执行已审核配方；详情中查看实际阶段、日志和取消。安装完成后验证包/入口/版本并重新发现，才启用受管默认；不会把打开下载页面或exit 0算作成功。

点击“检查更新”读取发行方版本。系统安装可“更新并管理”：新版写入HarnessHub私有版本目录，系统安装保留；后续网关使用受管默认。每次升级创建独立版本，旧版运行仍使用捕获的路径，下一轮记录实际安装身份。不同版本文件不互相覆盖。

当前实现npm、Python/uv与归档安装方式；Codex原生采用官方npm包，ACP包装器单独描述。运行环境不匹配时可为目标准备一个私有Node24；不改宿主Node或个人配置。未登记、缺运行时、上游迁移或当前不支持的配方会明确解释，不能把45个目录项叫45个已验收安装/执行组合。安装成功后登录/Provider兼容与真实任务仍需分别验证。

管理任务和默认版本独立持久保存；刷新/关浏览器不会重跑或取消。结果未知不自动恢复执行，旧默认保留。详细契约和证据见[ADR-012](../decisions/0012-harness-management-workbench.md)、[调研](../research/harness-management.md)、[验证](../verification/harness-management-2026-10-10.md)。

## 第一阶段

统一入口、公共 Session、可扩展的 Harness 注册与适配、可解释的自动选择与用户指定、受控执行、权限与取消、上下文接续、切换、持久事件和程序接入。

自动选择表示在当前能力、策略和已有评测证据下选出合适执行者，不声称存在未经测量的绝对最优 Harness。接续公共上下文不表示可以搬运不同 Harness 的内部状态。

旧 HarnessHub 保留为独立研究材料；新项目不继承它的存储格式、目录结构或 Session 绑定模型。当前只面向 macOS（[ADR-044](../decisions/0044-macos-official-channels.md)），Windows、Linux 不再计划；发布和 Harness 多发行版矩阵延后。

## 先运行检测

要求 Node.js 24 或以上、pnpm 10.12.3。使用实际安装的 Node，不建立多版本矩阵；依赖保留锁文件。

~~~sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm catalog
pnpm discover
pnpm --silent discover --json
pnpm --silent discover --legacy --json
pnpm discover --allow-unofficial --manifest examples/discovery-manifest.json
pnpm probe --harness codex --json
pnpm probe --harness gemini --json
pnpm test
pnpm test:real:codex
pnpm test:real:session
pnpm test:real:provider
pnpm test:real:gemini-provider
pnpm test:real:switch
pnpm test:real:native-catalog
pnpm test:real:native-resume
pnpm test:real:native-activity
pnpm test:real:native-attachments
pnpm test:real:native-commands
pnpm test:real:native-branch
pnpm test:real:native-extensions
pnpm exec playwright install chromium
pnpm test:web
~~~

discover 默认输出 schemaVersion=2，分别展示配置线索、多个安装（每个带官方渠道与版本）、非官网安装和控制依赖；它不执行找到的程序或下载包。默认只认官网安装、不读发现清单，开发和测试加 `--allow-unofficial`。v1 描述可显式迁移；旧 JSON 使用方可用 --legacy 保留 schemaVersion=1。通过 v2 描述和 --package-root 指定已有包可扩展目录。详见[当前契约](../contracts/catalog-control.md)与[旧 v1 契约](../contracts/discovery.md)。

probe 主动启动所选控制入口并初始化，输出 NDJSON 协议观察与独立清理证据；它不发送 prompt。run:harness 明确发送一次文本，输出流/后端结果/清理，不创建公共 Session，也不承诺任务正确性。多个可用控制入口必须 --control 指定，不自动替换。默认沿用本机已有配置与登录，未指定工作区时使用自有临时工作区；--config-home只用于调用者明确准备的配置来源，测试使用私有fixture来源。

pnpm test 使用真实文件系统与协议子进程夹具；test:real:codex 是独立显式验收，需要本机已安装 Codex，使用真实 Harness 和本地模拟 Responses Provider、临时配置与测试 key，不使用个人登录。当前实际结果见[验证记录](../verification/catalog-control-2026-10-09.md)。

## 持续会话

~~~sh
pnpm chat --harness codex --data-dir data --cwd /absolute/workspace --config-home /absolute/private-profile
pnpm chat --session session-ID --data-dir data
pnpm sessions list --data-dir data --json
pnpm sessions show --session session-ID --data-dir data --json
pnpm sessions events --session session-ID --data-dir data --after-seq 0 --limit 50 --json
pnpm sessions close --session session-ID --data-dir data
pnpm sessions resume --session session-ID --data-dir data --harness codex
~~~

将示例路径/Session ID替换为自己的值。新会话输出公共Session ID；续接使用相同数据根。默认原生模式沿用本机已有模型/登录；显式--config-home的Codex配置在该根codex目录。真实本机登录、云模型和私有合成模型验收分别记录，不能互相替代。

在chat中输入文本发送消息，使用 :harness gemini（或id:controlId）提出切换，:cancel取消当前工作，:history查看公共历史，:quit停止本次入口。切换先requested、旧执行与先前准入输入结束后再effective；等待失败切换的消息明确不派发。:quit保留可续接Session；sessions close才持久关闭准入。

单条消息也可 pnpm chat --harness codex --prompt "hello" --command-id request-1；续接同公共Session重试相同key不会重复调用，同key不同输入明确冲突。支持恢复的原接口沿用私有原生绑定，后续同Harness输入只补未同步公共事实；不支持原生恢复时仍为完整有界public_context_rehydrate。原生恢复失败明确拒绝，不静默创建空会话。

SQLite数据和命令幂等/事件先提交再发布；多个入口不能同时持有同数据根owner或同工作区writer。owner崩溃后未知执行/工作区残留会blocked/quarantined，历史仍可读，不自动重跑、清库或按PID杀未知进程。当前没有绕过未知状态的恢复命令。CLI显式私有配置目录仅固定路径引用，目录内容不构成不可变模型资源；图形工作台受管Provider使用不可变revision/model引用与每轮生成的私有配置。

test:real:session会运行真实Codex三轮、两个独立入口并检查实际收到前两轮公共上下文，Provider为本地模拟服务，不读取个人凭据。详见[当前Session验证](../verification/public-session-2026-10-09.md)。

## 从这里阅读

- [工程文档入口](../README.md)：按产品、研究、DDD、契约、工程、任务和门禁顺序阅读。
- [第一阶段范围](../product/phase-1.md)：统一入口、公共 Session、自动分配和安全接续。
- [调研与固定证据](../research/README.md)：16 个仓库、68 份固定文件，以及 6 份官方协议网页快照。
- [发现与适配扩展方案](../proposals/harness-discovery-adaptation.md)：最新 CC Switch/Magpie 研究；目录与控制切片已实现，后续公共 Session/切换仍按独立切片推进。
- [DDD 上下文](../domain/context-map.md)与[运行不变量](../domain/invariants.md)。
- [当前 MVP 顺序](mvp.md)：先检测，再接通控制面和统一对话；切片范围在 plan/slices.json 明确。
- [完整任务地图](../../TASKS.md)：保留未来工程分解，不让后置平台/发布事项阻塞已冻结的独立本机切片。
- [测试计划](testing.md)与[场景矩阵](test-matrix.md)：保留完整蓝图和当前切片场景，含后置项目；当前实际测试见[验证记录](../verification/catalog-control-2026-10-09.md)。
- [范围与门禁](readiness.md)：本机目录、控制、公共Session、Provider与工作台切片已开放；完整未来模型代理/账本/路由仍按各自契约推进。
- [目录与控制验证](../verification/catalog-control-2026-10-09.md)：当前实现、测试和未验证范围；[旧检测记录](../verification/discovery-2026-10-09.md)与[初始设计记录](../verification/design-review-2026-10-09.md)保留基线证据。
- [聚焦七个 Harness（ADR-046）](../decisions/0046-harness-focus-hardening.md)：2026-10-21 起只做精 Claude Code、Codex、OpenCode、DeepSeek Harness、WorkBuddy、Hermes Agent、OpenClaw，第一批六项工程加固，非焦点三个（Cursor、Gemini CLI、Pi）冻结；用户 2026-10-21 对范围、WorkBuddy 接入路线、版本基线、备份、审计与刷新时机的决定见[ADR-048](../decisions/0048-harness-scope-and-workbuddy.md)（accepted；第 6 项由审批代理 2026-10-22 裁决：门禁标志删除、G0～G5 改写为五层完成定义、矩阵新增 ☑ 终态与分层/冻结/仓库内证据规则）。
- [按各 Harness 的最新正式版适配，版本只作工程证据（ADR-053）](../decisions/0053-latest-version-baseline.md)：2026-10-22 用户的原则——接入不限定版本、默认按最新版。任何官网渠道的安装都接入，不按版本号提示或劝阻；续接命令按产品对任何版本给出；读表每家一张、核对版本只作证据；功能按程序实际报告的能力判断，缺的能力在用到时明确失败并带原因；升级目标是渠道最新版；真实验收以最新正式版为对象。ADR-038 被取代，ADR-031/034/035/036/039/043/044/045/046/048/050 修订，ADR-051（Hermes 是否进入用户网关）与 ADR-052（OpenClaw 两跳升级到 latest）等用户决定。

## 现在可运行的检查

只需 Python 3 标准库，不安装应用依赖：

~~~sh
python3 tools/check_design.py
python3 -m unittest discover -s tools -p 'test_*.py' -v
~~~

安装应用依赖（`pnpm install`）后，`pnpm check` 依次运行构建、前端构建、设计检查、依赖边界检查（`pnpm check:boundaries`，规则在 tools/boundary-rules.json，范围与限制见[开发规范](development.md)）与 tools 自检（`pnpm check:tools`，即上面的 unittest，设计检查每条规则的无效样例）；`pnpm test` 运行单元、集成与协议测试，`pnpm test:web` 运行浏览器测试。

修改 plan 中的结构化来源后运行 python3 tools/check_design.py --write 更新人读清单，再运行默认检查。仅本机已抓取缓存可追加 --verify-cache 核对内容 SHA-256；缓存不入库，其他机器必须重新取得对应来源才能执行该项检查。版本化网页可能重新渲染，哈希变化需要重新审阅，不自动改来源锁。

设计检查实际保证 ID/依赖、唯一路径所有权（含大小写/NFC）、获准切片源码范围（源码不在任何已接受切片的 allowed_files 内即拒绝；没有单独的门禁标志）、需求/测试关联、生成新鲜度、简单相对文件链接、来源元数据，以及能力矩阵的规则：每个 Harness 标 tier（焦点或冻结），冻结的 ✅ 数不得超过 complete_at_freeze，真实验收通过的格至少一项仓库内证据，原接口部分提供而真实通过的格（☑）必须写明原接口缺什么，installation 文本只把版本记作证据（不得含“已验证区间”“VERIFIED_VERSIONS”“未经验证的版本”，ADR-053）。它不证明任务语义天然原子、DDD 正确、外部 URL 永久有效、Markdown 全语法、运行时行为或平台能力。

原CLI恢复与原Homebrew升级证据见[ADR-018](../decisions/0018-native-cli-recovery.md)与[恢复验收](../verification/native-cli-recovery-2026-10-11.md)。

快速切换、原生思考档位、选项、命令与工具审批按[ADR-019](../decisions/0019-native-session-experience.md)实现。原OpenClaw可读取其Gateway模型目录，仅为Hub自己的会话覆盖模型；Codex与Pi档位来自原安装接口。统一聊天界面承接原生审批与Pi输入交互，配置/登录保持本机来源。当前实测选择提交52–96ms；首次模型目录读取和首条回复仍受原程序启动及网络影响。范围与实际证据见[本轮验收](../verification/native-session-experience-2026-10-11.md)，不将这些结果称为全部Harness原生功能等价。

所有Harness以[ADR-020](../decisions/0020-complete-native-harness-capabilities.md)的完整原生能力标准验收；当前通用原生恢复已接入，OpenClaw/Codex/Pi真实恢复通过。未确认的原生状态不能自动继续；高级配置可明确重新建立原生会话并保留旧记录。业务库现为v12，升级前备份；其余能力缺口及七个原接口审查见[验收记录](../verification/complete-native-capabilities-2026-10-11.md)，完整目标仍进行中。

逐Harness原生能力与验收状态以[能力矩阵](../verification/native-capability-matrix.md)为准（机器权威`plan/native-capabilities.json`，设计检查拒绝无证据的完整声明），来源见[七个原安装的能力面调研](../research/native-capability-surfaces-2026-10-11.md)。[ADR-021](../decisions/0021-native-profile-and-deviation-tolerance.md)起，原生模式只透传用户真实设置的配置位置变量（Cursor因此回到原`~/.cursor`并加载原MCP配置）；原生协议的正常偏差（迟到输出、外部线程、重复工具id、多行标题、load后回放）归一而不归属，不再中断回合；会改写全局默认值的原生设置（Cursor模型、Pi全局settings命令）不由Hub执行。本轮OpenCode、OpenClaw、Codex、Pi跨Hub进程重启的原生恢复真实通过，见[第二轮验收](../verification/native-capabilities-round2-2026-10-11.md)；完整能力仍在进行中。

[ADR-022](../decisions/0022-native-activity-and-content-store.md)起，统一聊天在回复下显示原生计划、提示、工具（展开查看输入、输出与着色差异）、子Agent/压缩/重试活动、图片与文件产物和本轮用量；详情与产物存入数据根下的`content`目录（7天未引用自动回收），事件日志只存摘要。Codex、OpenCode、Pi的真实命令与编辑回合已通过，OpenCode工作区级审批已通过；Claude、Cursor、Gemini受账号限制只有协议验证，OpenClaw需直连Gateway才能取得工具事件。见[原生活动验收](../verification/native-activity-2026-10-11.md)。`test:real:native-*`需要`HH_REAL_HARNESSES`与`HH_REAL_EVIDENCE`，使用本机原安装与登录，真实调用模型。

[ADR-023](../decisions/0023-attachment-input.md)起，输入框可选择、拖放或粘贴文件、图片和音频，附件随对话草稿保存。Hub按各原接口发送（ACP内容块、Codex本地路径、Pi图片），并按代理与所选模型的输入能力在派发前拒绝看不到的附件；附件副本留在数据根内，不写入工作区。Codex、Pi、OpenCode的真实文件与图片回合已通过，OpenClaw文本附件通过、识图模型未验收；音频只有协议验证。见[附件输入验收](../verification/native-attachments-2026-10-11.md)。

[ADR-024](../decisions/0024-native-session-operations.md)起，Codex 可在高级配置中为本次对话选择审批策略与沙箱（只覆盖 Hub 的线程，不改 config.toml），审批请求带文件名与差异；Codex 与 Pi 的命令目录提供 `/compact`、`/export`，调用原程序自己的压缩与导出，导出文件可从回复下载；Hermes 没有列出自己的 export 命令时，`/export` 只运行一次它自己的 `hermes sessions export - --session-id <id>`（5 秒、8 MiB 上限，不触及它的消息网关），会话的 JSON 行作为产物下载；对话头部可把公开对话导出为 Markdown 或 JSON。见[原生会话操作验收](../verification/native-session-actions-2026-10-11.md)。

[ADR-025](../decisions/0025-conversation-branches.md)起，可在任一完成的回复上“从这里分支”：新对话带上到此为止的历史；原生会话恰好在这一处时（Codex、OpenCode、Pi 已真实验证），由原程序建立原生副本，否则以公共历史继续（如 OpenClaw）。分支与原对话互不影响。见[分支验收](../verification/native-branch-2026-10-11.md)。

[ADR-026](../decisions/0026-native-extensions.md)起，输入框的“原生扩展”面板只读列出所选 Harness 加载的技能、MCP 服务器与插件（Codex、Pi），点选技能即填入命令；Codex 技能以它自己的 skill 输入调用。见[原生扩展验收](../verification/native-extensions-2026-10-11.md)。

[ADR-027](../decisions/0027-openclaw-transcript-reconciliation.md)起，OpenClaw 每轮结束后按它自己的会话转录补记工具调用与结果、思考和用量，模型错误不再被桥记成完成；实时工具流与执行审批需直连 Gateway，待决定。见[OpenClaw 转录对账验收](../verification/openclaw-transcript-2026-10-11.md)。

[ADR-028](../decisions/0028-native-configuration-sync.md)起，原生命令在原生会话里改了所选设置（如 OpenClaw `/think high`、`/fast on`）后，下一回合沿用原生当前值而不改回；输入框提示被沿用的设置，可“改用所选设置”。OpenClaw 已真实验证。见[原生配置同步验收](../verification/native-config-sync-2026-10-11.md)。

[ADR-029](../decisions/0029-continue-native-sessions.md)起，输入框的“本机会话”列出所选 Harness 在本工作区自己的会话（Codex、Claude、OpenCode、Cursor），可接续为新对话：对话引用最近的消息，下一条输入直接发给那个原生会话。Codex、Claude、OpenCode 已真实验证。见[本机会话接续验收](../verification/native-session-import-2026-10-11.md)。
