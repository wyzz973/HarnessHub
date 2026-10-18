# ADR-044：只面向 macOS，按官网安装渠道探测和维护 Harness

状态：accepted，2026-10-17。方向由用户决定；实现细节交给用户授权的审批代理（Fable 5.1）审阅。

## 背景

用户在 2026-10-17 统一了方向：

> 目前我们只专注开发 macos 版本的，优先适配 macos；寻找用户电脑中的 harness 不通过源码安装的方式，而是通过一般官网介绍的安装方式进行寻找，我们的平台可以探测到，帮他们维护版本，更新，卸载等。

对三个具体问题，用户都选了推荐项：
- 只认官网安装；
- 未安装的 Harness，点击后按官网方式代为安装；
- 卸载只删程序，数据保留。

在此之前：
- 探测会在 PATH、标准目录和版本管理器目录里按命令名查找，不区分安装方式。
- 源码安装通过发现清单里的自定义入口接入（2026-10-11 的做法）。本机的 Pi 指向开发目录，DeepSeek Harness 是源码构建，都是这样接进来的。
- 需求 R20 要求 POSIX 和 Windows 分别设计、分别验证。

## 决定

1. **平台只面向 macOS。**
   - Windows、Linux 不再计划，也不再验证，文档和报告里不再列“未验证”，直接写明当前只面向 macOS。
   - 已有的平台分支代码保留但不扩展。新功能只实现 macOS；在其他平台上运行时，明确报告不支持。
   - R20 改为“macOS 的进程、权限与隔离边界如实设计和验证”。
2. **“已安装”只指落在官方渠道里的程序。** 每个产品的官方渠道登记在目录里，附官网来源和日期，见 `docs/research/official-install-channels-2026-10-17.md`。渠道分四类：
   - **npm 全局**：程序在某个 npm 全局前缀的 `lib/node_modules/<官方包名>` 下。Homebrew 的 Node、nvm 等任何前缀都算。
   - **Homebrew**：`Cellar/<官方 formula>` 或 `Caskroom/<官方 cask>`。
   - **官方脚本**：产品官方安装脚本的固定布局，例如 Claude Code 的 `~/.local/share/claude/versions`、Cursor 的 `~/.local/share/cursor-agent/versions`、OpenCode 的 `~/.opencode/bin`、Hermes 的 `~/.hermes/hermes-agent`、Codex 的 `~/.codex/packages/standalone`。
   - **uv 工具**：产品官网写明用 uv 安装的。

   在其他位置找到的程序不算已安装，例如源码目录、`npm link`、自行编译的产物。这样的 Harness 显示“未安装”，并给出官网安装方式；详情里注明“在 <路径> 发现一个非官网安装，平台不使用也不维护”。
3. **一个产品装了多份时，全部列出。**
   - PATH 里排在最前面的那份标为“当前使用”。它就是终端里实际运行的那份，对话也默认用它。
   - 升级和卸载都针对具体的某一份。
4. **维护都按渠道走官网方式。**
   - **安装**：点击后先弹确认框，写明官网命令原文、来源、装到哪里，以及会不会改 shell 配置；确认后才执行，装好后核实程序和版本。平台不会自动安装。
   - **卸载**：只删程序，配置、登录和会话数据保留。产品有后台服务的，先按产品自己的方式停止并注销服务，例如 OpenClaw 先 `openclaw gateway stop`，再 `openclaw gateway uninstall`。和 ADR-043 一样先检查再确认：HarnessHub 的空闲进程先关闭，正在回复的对话阻止卸载。
   - **升级**：沿用 ADR-043，并补上官方脚本渠道各产品自己的更新命令。
   - 官方卸载命令如果会连数据一起删（例如 `openclaw uninstall`），就不用它，改按产品文档里只删程序和服务的步骤做。
5. **自定义入口和发现清单只用于开发和测试。**
   - `--manifest` 保留，测试仍用它把 Harness 指向测试用的假程序，但只在开发模式（`--allow-unofficial`）下读取。正式使用不提供：4317 不再带 `--manifest` 启动，界面也不提供添加自定义入口。
   - 设置里“从登录 shell 补充目录”仍然保留：它只是扩大查找 PATH 的范围，找到的程序照样要按渠道判断。
6. **已有对话保留。** Pi、DeepSeek Harness 等 Harness 的历史对话照样可以查看。要继续对话，需要先按官网方式装好；对话停在一个未安装的 Harness 上时，界面提示安装。

## 审批代理的裁决（2026-10-17）

- **非官网安装只写一句说明，不带路径。** 页面状态不含私有路径的约定仍然有效。说明写成：“在 PATH 中发现一个非官网安装（开发目录、npm link 或其他），命令名 pi；平台不使用也不维护它，终端里能用的就是它。”，后面附官网安装方式。具体路径只出现在 `discover --json` 和服务日志里。
- **每个版本管理器的每个版本目录都要查。** 这台电脑上 Claude Code 实际有三份 npm 安装：Homebrew 前缀下 2.1.296，nvm v23.10.0 下 1.0.31，nvm v26.11.1 下 2.1.302。
- **pnpm、bun、yarn 全局安装的官方包，显示为“已安装（pnpm 全局）”这类**，但维护按钮不可用，注明当前版本不维护这种安装方式；不能显示为未安装。
- **“当前使用”的含义。** 它指 HarnessHub 环境里 PATH 优先的那一份。用户终端常被 nvm 改 PATH，界面要写明终端里用的可能是另一份。
- **代为安装：**
  - 不直接 `curl | bash`。先把脚本下载到临时目录（大小有上限，校验 TLS），确认框显示来源 URL 和下载文件的 SHA-256，执行的就是这份副本。
  - 在受保护的沙箱里运行，写入范围按渠道给白名单，网络放开。
  - 产品有不改 shell 配置的参数就用（例如 OpenCode 的 `--no-modify-path`）。没有的，只为那个文件放开写入，并把改动前后的差异记进任务日志、显示在完成页。HarnessHub 自己绝不编辑 shell 配置文件。
  - 会交互提问、或要现装 git 和 Python 的脚本（Hermes），平台不代为运行，只给出终端命令。
  - npm 安装前，核对目标版本的 `engines.node` 和所在前缀的 `node --version`，不满足就停下说明。平台不安装 Node.js。
  - Homebrew 操作一律带 `HOMEBREW_NO_INSTALL_CLEANUP=1`；需要 `brew update` 时，作为确认框里可见的一步，不悄悄执行。
- **卸载的删除范围精确到程序目录，并要有拒绝样例测试：**
  - Codex（脚本）只删 `~/.local/bin/codex` 和 `~/.codex/packages/standalone`。
  - Hermes 只删 `~/.hermes/hermes-agent` 和 `~/.local/bin/hermes`；删之前只读运行 `git status --porcelain`，有本地改动就在确认框里提醒。
  - Claude Code（脚本）只删 `~/.local/bin/claude` 和 `~/.local/share/claude`。
  - Cursor 注明“官网没写，按安装脚本的布局推断”。
  - 解析后落在白名单之外（包括经符号链接）的路径，一律拒绝。
- **卸载会停网关的产品**（OpenClaw 断开微信和飞书，Hermes 断开 QQ），走 ADR-043 的检查和确认，只由用户点击。
- **会自己更新的渠道**（Claude Code 脚本版、Cursor）由产品自己更新。平台只显示版本，并提供 `claude update`、`agent update`，不跟它们对着干。
- **能力矩阵里 Pi、dsh 的真实验收证据**来自非官网安装。证据保留，注明“安装渠道非官网，不再作为验收对象”；ADR-038 的已验证版本表随之说明。
- **适配器**（例如 `claude-agent-acp`）同样按 npm 渠道探测和维护，单独一行显示。
- **Gemini 的 keg 版本（0.38.2）和程序自报的版本（0.62.0）不一致**：维护决定以渠道版本为准，两个都显示。
- **真机验证**：用临时 npm 前缀加测试包；Homebrew 用没有依赖的小 formula `hello`，并带 `HOMEBREW_NO_AUTO_UPDATE=1` 和 `HOMEBREW_NO_INSTALL_CLEANUP=1`，前后比对 `brew list --versions`。第一个请用户点击卸载的，是 nvm v23.10.0 下明显过时、也不在使用的 Claude Code 1.0.31。

## 审批代理对实现的裁决（2026-10-17，第二轮）

- PATH 第一个是非官网程序、后面还有官网安装时，平台用官网那份。说明写明：终端里运行的是那份非官网安装，HarnessHub 用的是标为“当前使用”的官网安装。
- “当前使用”按 HarnessHub 服务进程的 PATH 顺序确定，悬停写“按 HarnessHub 服务进程的 PATH 顺序；终端里可能不同”。PATH 条目排在标准目录和版本管理器目录之前。
- **正式模式一律不读发现清单。** 给了 `--manifest` 也不读，服务日志和 `discover` 输出写明“安装策略为 official，发现清单的入口被忽略；开发和测试请加 --allow-unofficial”。
- `--package-root` 找到的包同样按渠道判定。适配器按自己的包、产品按产品渠道各自判定；HarnessHub 自己的受管安装仍标“HarnessHub 管理”。
- 开发模式下，“我的 Agent”顶部显示“开发模式：接受非官网安装”。
- 每条官网安装命令附来源和核对日期；Gemini CLI 旁写明官方已对免费用户以 Antigravity CLI 取代。

## 实现（第 1 步：按渠道探测，2026-10-17）

- **判定。** `src/contexts/catalog/domain/channels.ts` 只做纯判定：npm 全局（任意前缀）、Homebrew formula 与 cask（先于 npm 识别，因为 formula 的 keg 里也有 `lib/node_modules`）、官方脚本的目录或“启动器加目录内程序”、uv 工具、pnpm 与 bun 全局。各产品的渠道登记在 `src/adapters/catalog-channels.ts`，附官网来源和日期。`src/infrastructure/discovery/installation-channels.ts` 读文件判定启动器是否有效，并读渠道记录的版本（package.json、keg 目录名、`versions/<版本>`），不运行程序。
- **策略。** `InstallationPolicy` 为 `official` 或 `any`，在组合根 `application()` 里默认 `official`。新建对话（`DirectorySessionBindingFactory`）和 Harness 列表读同一个策略，所以列表显示已安装的，新建对话也能绑定。`web`、`chat`、`discover`、`control` 命令都接受 `--allow-unofficial`，只用于开发和测试；测试的夹具显式使用 `any`。
- **选择。** 在 `official` 下，官方渠道外的程序归入 `unofficial`，不算安装，控制入口也不可用。PATH 默认指向的程序不是官网安装时，按搜索顺序选第一份官网安装。PATH 默认损坏时仍然什么都不选。
- **页面。** Harness 视图新增 `installations`（渠道、名称、命令、版本、产品或适配器、是否当前使用、是否维护；不含路径）和 `unofficial`（命令名、是否在 PATH 上、是否 PATH 默认）。`install` 增加核对日期和官网附注。9 个产品都有官网安装命令。
- **本机结果。** 详见[验收记录](../verification/official-channels-2026-10-17.md)。

## 审批代理对卸载设计的裁决（2026-10-17，第三轮）

- 每份安装单独卸载，用不含路径的引用定位，提交时带检查时的指纹，安装变了就拒绝。
- npm 卸载用该前缀自己的 npm，包自己的卸载脚本照常运行，但在沙箱里只能写该前缀、npm 缓存和临时目录；Homebrew 遇到多版本或被依赖时按它的报错原样失败，不加 `--force`；不用 `--zap`。
- Codex 安装脚本还会写 `~/.local/bin/codex-code-mode-host`，一并列入白名单。
- 顺序固定为：停服务 → 注销服务 → 删程序；确认框说明服务注册会被移除，重新安装后需要再安装服务。产品没有声明的 launchd 服务在运行就阻止。
- 产品声明的常驻程序（openclaw-gateway、openclaw-node、Hermes 网关等）只要在运行就阻止，不论是否由 launchd 启动，并给出停止命令；其他终端进程只警告、不阻止。
- 确认框和任务日志可以显示白名单内、以 `~` 书写的程序路径，这是知道会删什么所必需的；页面列表仍不含路径。这一例外写进契约，并有服务端检查和无效样例测试。
- 管理库升 v4，附降级脚本；降级会删除卸载任务的记录，写进说明。

## 实现（第 2 步：卸载，2026-10-17）

- **入口与确认。** “本机找到的官网安装”里每份可维护的安装都有“卸载”（pnpm、bun 的没有）。点击后先读 `GET /api/v1/harnesses/{id}/installations/{ref}/uninstall`，确认框列出：会运行的命令、删除的文件、保留的数据（例如 `~/.claude`、`~/.claude.json`）、先停止并注销的服务及其命令和影响、阻止卸载的原因、仍在运行它的其他程序、卸载后 HarnessHub 改用哪一份。
- **各渠道的做法。** 没有用产品自带的卸载命令：`opencode uninstall`、`hermes uninstall` 会交互提问或改 shell 配置，`openclaw uninstall` 会删数据。
  - npm：`<前缀>/bin/npm uninstall --global --prefix <前缀> <包>`，沙箱只允许写该前缀和任务目录；核实包目录没了。
  - Homebrew：在 Homebrew 自己的继承沙箱里运行 `brew uninstall --formula|--cask <名>`，带 `HOMEBREW_NO_AUTOREMOVE`；核实 keg 或 Caskroom 目录没了。
  - uv：`uv tool uninstall <包>`，沙箱只允许写工具目录、bin 目录和任务目录。
  - 官方脚本：HarnessHub 按白名单自己删除。Claude Code 删 `~/.local/bin/claude` 和 `~/.local/share/claude`（官网写明）；Codex 删两个链接和 `~/.codex/packages/standalone`；Cursor 删两个链接和 `~/.local/share/cursor-agent`（官网没写，按安装脚本）；OpenCode 删 `~/.opencode/bin/opencode`，`bin` 目录空了才删；Hermes 删启动器 `~/.local/bin/hermes` 和 `~/.hermes/hermes-agent`，确认框提醒本地改动。链接只在指向本安装的目录时删；用户自己的启动脚本或指向别处的链接保留并说明；目录是链接或上级目录经链接指向别处时拒绝。
- **服务与程序。** OpenClaw 的 gateway 和 node 服务、Hermes 的 gateway 服务按产品命令停止并注销（`openclaw gateway stop`、`openclaw gateway uninstall` 等），停完核实系统服务管理器里没有了才删程序。
- **HarnessHub 自己。** 卸载的是当前使用的那份时，正在回复的对话和其他 HarnessHub 进程阻止卸载，空闲保留进程先关闭，期间持有维护锁。结果未知的卸载不会重跑，可以“核实本机结果”，只记录文件还在不在。
- **验收。** 见[卸载验收记录](../verification/uninstall-2026-10-17.md)。
- **配置摘要只记录，不判失败。**
  - 卸载和升级前后都会比对受保护配置文件的摘要。但包管理器在沙箱里写不了这些文件，脚本安装的卸载也只删白名单里的文件。
  - 所以摘要有了变化，只可能是仍在运行的程序写的，例如正在运行的 Claude Code 会改写 `~/.claude.json`，网关也会改写自己的配置。
  - 现在只在任务日志里记一笔，不再判失败。此前 ADR-043 的升级会因此误报“结果未知”；这次一并修正。
- **存储与接口。** 管理库 v4 新增 `management_installation_targets`，冻结每个卸载任务的目标；`tools/management-v4-to-v3.sql` 降回 v3，会删除卸载任务及其日志。错误码 `*_CHANGED` 和 `*REFUSED` 返回 409。

## 审批代理对安装设计的裁决（2026-10-17，第四轮）

- 安装脚本的下载只允许跳到登记的域名，例如 `claude.ai` 跳到 `downloads.claude.ai`，`chatgpt.com` 跳到 `releases.openai.com`，`opencode.ai` 跳到 `raw.githubusercontent.com`。跳到其他域名就停下，请用户在终端运行官网命令。确认框显示最终地址和 SHA-256，并写明脚本自己还会下载程序本体、平台不校验那部分；Cursor 另注明它的脚本不校验下载的完整性。
- 脚本拿到的是 Gateway 从登录 shell 得到的 PATH，与用户终端一致。沙箱拦下的写入要在任务里写明“尝试写入 X，已被阻止”。期限 10 分钟；失败不卸载、不重试，留下的文件可以在列表里卸载。
- Claude Code 的官方安装会写 `~/.claude.json`：放开它，但只记录变化的键，已知的安装字段显示值，其他键只写“值已更改（未显示）”。Codex 的脚本按 `$SHELL` 选择 shell 启动文件（macOS 上 zsh 是 `~/.zprofile`，bash 是 `~/.bash_profile`），只放开那一个文件，并记录增删的行。OpenCode 用 `--no-modify-path` 时写明“终端里找不到 opencode 时，需要自己把 `~/.opencode/bin` 加入 PATH”。
- 装好后按 ADR-038 判断，不是验证过的版本就提示。
- npm 加 `--no-audit --no-fund` 并关闭更新提示；前缀取 Gateway PATH 上第一个 Node.js 的前缀，确认框显示它。
- 不改用户的 Homebrew，暂不提供 Homebrew 安装：9 个产品的首选渠道都不是 Homebrew。测试用临时 npm 前缀和本地假脚本，含跳转、超限、摘要不一致、越界写入等无效样例。第一个请用户点击的真实安装是 DeepSeek Harness，第二个是 Pi。每个安装确认框都有固定一行，说明“安装后终端里的命令指向哪一份”。
- 同一产品的安装、卸载、升级互斥。
- 脚本在沙箱里仍能读取家目录并联网，这是 `curl | bash` 固有的风险。平台只保证运行的就是确认框里那一份。

## 实现（第 3 步：按官网方式安装，2026-10-17）

- **方式。**
  - 官方脚本：Claude Code、Codex（`CODEX_NON_INTERACTIVE=1`）、OpenCode（`--no-modify-path`）、Cursor。
  - npm：OpenClaw、Gemini CLI、Pi、DeepSeek Harness。OpenClaw 的官方脚本会安装 Homebrew 和 Node.js 并进入交互式引导，所以改用官网同样列出的 npm 方式，装好后提示运行 `openclaw onboard --install-daemon`。
  - Hermes：只显示终端命令。
  - 各产品的方式登记在 `catalog-channels.ts`，附来源。
- **准备与确认。** `GET /api/v1/harnesses/{id}/install` 准备一次安装：脚本下载到管理目录里的私有位置并计算 SHA-256；npm 先解析出精确版本，再读取该前缀 Node.js 的版本。确认框显示：官网命令、来源与 SHA-256、实际运行的命令、可写位置、可能改动的 shell 启动文件或产品配置、Node.js 是否满足、安装后终端里的命令指向哪一份，以及各产品的说明。准备好的安装等待 15 分钟。
- **执行。**
  - 提交时，脚本副本移入任务自己的目录，运行前再核对 SHA-256。
  - 脚本在沙箱里只能写它的安装目录、任务目录、`/dev` 和那一个允许的文件。缺少的上级目录（例如 `~/.local/share`）由 HarnessHub 先建好空目录。
  - npm 在沙箱里只能写该前缀和任务目录，包自己的安装脚本照常运行。
  - 装完按渠道判定，产品必须出现在它的官方渠道里，再在只读沙箱里读出版本。
- **存储与接口。** 管理库 v5 新增 `management_install_requests`，冻结每个安装任务；`tools/management-v5-to-v4.sql` 降回 v4，会删除这些安装任务的记录。错误码 `*_EXPIRED`、`*INCOMPATIBLE` 返回 409。
- **验收。** 见[安装验收记录](../verification/official-install-2026-10-17.md)。

## 审批代理对升级设计的裁决（2026-10-17，第五轮）

- **各渠道。**
  - npm：确认框显示“现版本 → 目标精确版本”，预发布版要标出。升级的是适配器（例如 claude-agent-acp）时写明 HarnessHub 对该产品的控制在哪个适配器版本上验证过，新版本按 ADR-038 提示未经验证。
  - Homebrew：用本地记录，命令带 `HOMEBREW_NO_AUTO_UPDATE=1`、`HOMEBREW_NO_INSTALL_CLEANUP=1`、`HOMEBREW_NO_AUTOREMOVE=1`；先预演一次，把一并升级的包列进确认框；其中有 node 这类共享运行时时单独红字警告。
  - 会自更新的脚本安装（Claude Code、Cursor）只提供“立即更新”，执行前后各读一次版本，完成时显示“2.1.302 → 2.1.305”或“已是最新”。
  - Codex、OpenCode 的脚本安装重新运行官方脚本，前后版本同样记录。
  - Hermes 只给终端命令。详情写明 `hermes update --yes` 会 stash、pull 或 reset 仓库，重装依赖，迁移 `config.yaml`，并重启网关（QQ 会断开）；克隆里有本地改动时另行提醒。
- **确认流程。** 不是当前使用的那份，升级后“当前使用”不变；是当前使用的那份时，写明 HarnessHub 的对话下次发消息起使用新版本。按路径匹配到 HarnessHub 自己的进程时，不论是否当前使用，空闲保留进程先关、正在回复的对话阻止；其他程序只警告，与 ADR-043 一致。产品声明了服务的，仍走 ADR-043 的升级确认。
- **检查更新。** Homebrew 的结果标注“本地记录”；暂不提供“运行 brew update”。
- **存储。** 升到 v6 并给降级脚本，手工降级照旧用测试证明。
- **真机验证。** 用户点击升级 Homebrew 前缀下那份 Claude Code 2.1.296；核对 nvm v26 那份的版本与“当前使用”不变，`~/.claude.json` 与 `~/.claude` 没有被任务写入（运行中的 Claude 自己写入的除外），Homebrew 前缀下的命令链接指向新版本。自更新与脚本重跑只用临时家目录和替身验证。

## 审批代理对 Homebrew 预演的裁决（2026-10-17，第六轮）

实现时发现：Homebrew 7.0.9 的 `brew upgrade --dry-run` 即使只预演也检查整个前缀可写，在只读沙箱里直接退出。另外，ADR-043 原来的 Homebrew 升级把 HOME 和缓存都指到任务目录，等于每次重新下载 Homebrew 的 API 数据，实际按网上最新版升级，并不是本地记录。裁决选方案 A，附条件：

- 预演与升级用同一个 Homebrew 继承沙箱：可写前缀、临时目录和 Homebrew 缓存，禁写用户配置，网络放开。都带上面三个环境变量，并用用户自己的 HOME、Homebrew 设置和缓存，所以检查、预演和升级读同一份本地记录。预演期限 60 秒，升级期限 15 分钟。
- 预演前后各取一次 `brew list --versions` 和 Cellar、Caskroom 的目录快照；有任何变化就停止并请用户在终端核对。要有替身预演偷改前缀被拦下的无效样例。
- 确认框写明“预演由 Homebrew 在它的沙箱里运行，可能下载清单到它的缓存，不改已装的程序”，以及本地记录的更新日期和“没有运行 brew update”。
- 一并升级的包全部列出；共享运行时红字说明影响范围（例如所有 npm 全局程序，包括 OpenClaw 网关）。Homebrew 标为弃用或停用的包单独提示，Gemini 另附 Antigravity 的说明。
- 升级前再预演一次，目标版本或一并升级的包有变化就不升级，请用户重新检查。
- ADR-043 的 Homebrew 升级同样改为真实 HOME 加用户缓存，并用测试证明在真实 HOME 下 `~/.zshrc`、`~/.config` 仍不可写。

## 实现（第 4 步：逐份升级，2026-10-17）

- **入口。** “本机找到的官网安装”里每份可维护的安装都有升级按钮：
  - npm 和 Homebrew 的写“升级”，上次检查有新版本时写“升级到 vX”；自更新和脚本重跑的写“立即更新”；Hermes 写“更新方式”，只显示终端命令。
  - 当前使用、且产品声明了服务的那份（OpenClaw）打开 ADR-043 的升级确认，由它在升级后按产品方式重启服务。
  - 每份安装下面写上次检查的结果：“已是最新”“可升级到 vX”，Homebrew 的注明“本地记录”。
- **检查。** `GET /api/v1/harnesses/{id}/installations/{ref}/upgrade` 准备一次升级，期间不改任何已装的程序：
  - npm 解析出精确版本，检查 Node.js 要求和会被替换的命令；Homebrew 跑预演；脚本重跑先下载官方脚本并计算 SHA-256。
  - 确认框显示现版本与目标、实际运行的命令、可写位置、一并升级的包与共享运行时、仍在运行它的程序、会先关闭的空闲进程，以及阻止原因。
  - 现版本在检查时重新读取，不用上次扫描的结果。准备好的升级等待 15 分钟。
- **执行。**
  - 先核对安装没有变化，再查使用者：这份安装上的后台服务阻止升级；HarnessHub 自己的进程在运行它时，正在回复的对话阻止升级，空闲保留进程先关闭；是当前使用的那份时，其他 HarnessHub 进程阻止升级，并持有维护锁。
  - 然后读升级前的版本，按渠道升级：npm 用该前缀自己的 npm 安装精确版本，沙箱只放开前缀和任务目录；Homebrew 先再预演一次，计划一致才升级；自更新和脚本重跑与安装用同一个受限运行器，记录 shell 启动文件和产品配置的改动、被阻止的写入。
  - 最后读升级后的版本。npm 和 Homebrew 必须正好是确认的版本，自更新与重跑记录前后版本，相同时显示“已是最新”。
- **版本怎么读。** 与列表一致：npm 读包的 package.json，Homebrew 和带版本目录的脚本读命令指向的版本目录；只有 OpenCode 这类没有版本记录的，才在只读沙箱里运行 `--version`。
- **Homebrew 的统一做法。** 检查更新的 `brew info`、预演、升级和卸载都用真实 HOME、用户的 `HOMEBREW_*` 设置和缓存；查询在禁写、禁网的沙箱里运行，预演和升级在 Homebrew 自己的继承沙箱里运行。ADR-043 的 Homebrew 升级和第 2 步的 Homebrew 卸载随之改为同样的环境。
- **检查更新。** “检查更新”也逐份查询 npm 和 Homebrew 安装的最新版本，结果只放在内存里。
- **存储与接口。** 管理库 v6 新增 `management_installation_upgrades`，冻结每个升级任务；`tools/management-v6-to-v5.sql` 降回 v5，会删除这些升级任务的记录。结果未知的升级可以“核实本机结果”，只读取现在的版本，不重跑。
- **验收。** 见[逐份升级验收记录](../verification/installation-upgrade-2026-10-17.md)。

## 修正：安装程序的 umask（2026-10-18）

- **问题。** 用户要求经 4317 升级 Homebrew Node.js 前缀里的 Claude Code，升级完成后发现：装出来的包里普通文件是 0600、目录是 0700。用户在终端装的同一版本是 0644/0755。
  - 原因：4317 以 umask 077 启动，用来保护数据目录；HarnessHub 启动的 npm、brew、官方脚本继承了这个 umask。
  - 影响：对用户本人能用，但与官网命令在终端里的结果不一致。
- **修正。** 管理用的子进程一律经 `/bin/sh -c 'umask 022 && exec "$@"'` 启动（`process.ts`）。
  - 022 是 macOS 的默认值，也是终端运行官网命令时的 umask。
  - 外壳在最外层：`/bin/sh` → `sandbox-exec` → 程序。外壳只设 umask 后 exec，PID、进程组、输出与取消语义不变，沙箱限制的仍是原来那条命令。
  - 启动前先检查程序是否存在且可执行，找不到时仍报 PROCESS_START_FAILED。
  - **取舍**：不读用户登录 shell 的 umask，因为登录 shell 只在用户请求时读一次，而且只读 PATH。自定义了 umask（如 027）的用户，装出来的权限按 022 计算。
- **一次性修补**（审批代理同意）：
  - 先核对 Homebrew 前缀那份与用户在终端装的 nvm v26.11.1 那份（同为 2.1.302）：文件清单和内容完全一致，只有权限不同。
  - 然后把前者 14 项（9 个文件、5 个目录）的权限逐项设成后者的值，没有重新下载。
  - 记录见[管理操作验收](../verification/management-actions-2026-10-18.md)。

## 影响

- 这台电脑上，Pi（开发目录）和 DeepSeek Harness（源码构建）会显示为未安装。Claude Code 会列出三份 npm 安装。
- 取代 ADR-017 里“开发目录链接保留原入口”的做法，以及 2026-10-11 “非标准安装通过自定义入口接入”的约定。ADR-043 的确认与重启流程不变；它的 Homebrew 升级改为读用户的本地记录（见第六轮裁决）。
- Gemini CLI 的官方仓库写着，自 2026-06-18 起对免费用户已由 Antigravity CLI 取代；是否接入 Antigravity CLI 另行决定。

## 验证

- 单元：按渠道判定（npm 的各种前缀、Homebrew formula 与 cask、官方脚本布局、源码目录、`npm link`），以及多份安装的排序和“当前使用”。
- 集成：正式入口不带清单时，非官网安装显示未安装并附说明；带清单的测试照常运行。
- 真机：先核对 4317 上 9 个已接入 Harness 的渠道判定。安装和卸载的真实执行要等用户点击，或者用不影响用户的临时 npm 前缀来验证。
