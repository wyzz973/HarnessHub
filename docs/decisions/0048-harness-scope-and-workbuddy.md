# ADR-048：七个焦点 Harness 的范围、完成定义与 WorkBuddy 接入路线

状态：accepted，2026-10-21。用户当天对总指挥送出的八项决定回复“全部按推荐”，选定结果见“用户决定”一节；第 6 项（门禁标志与 G0～G5）不在那八项里，已由审批代理于 2026-10-22 裁决并落地，见“审批代理裁决（2026-10-22）”一节。下文“用户待决项”保留当时的选项与代价，作为选择的依据。切片 harness-focus 的第一批工程加固见 [ADR-046](0046-harness-focus-hardening.md)。

## 背景

用户 2026-10-21 的指令：只支持 Claude Code、Codex、OpenCode、DeepSeek Harness、WorkBuddy、Hermes Agent 六个，“把这些适配好，做精”。同日补充：OpenClaw 也保留，加入接入清单，焦点共七个。

本机事实（2026-10-21 只读核对，没有运行任何 Harness）：

| Harness | 本机安装 | HarnessHub 已验证版本（ADR-038） | 现状 |
|---|---|---|---|
| Claude Code | 2.1.306（nvm，当前使用）、2.1.302（npm，Homebrew 前缀）；适配器 claude-agent-acp 0.89.1 | 2.1.296 | 当前版本没有一格真实证据；Claude 每周自更新 |
| Codex | 0.162.1（Homebrew cask） | 0.162.1 | 深度接入；上游已发 0.163.x |
| OpenCode | 1.18.35（Homebrew formula；Cellar 另有 1.1.21） | 1.18.35 | 深度接入；隐藏 `/compact` 未接 |
| Hermes Agent | 0.12.0（官方脚本；网关在运行，从未触碰） | 0.12.0 | 审批是上游缺陷；`hermes update` 会拉 origin/main，上游 main 的 `hermes acp` 是网关投影 |
| DeepSeek Harness（dsh） | 0.2.0-rc.2（npm 官网，2026-10-18 经 4317 安装） | 0.2.1-alpha.1（源码版，按 ADR-044 为历史） | 矩阵 9 格真实证据来自已作废的源码版 |
| OpenClaw | 2026.3.23-2（npm 全局，Homebrew 前缀；Gateway 守护进程在运行，接着消息渠道） | 2026.3.23-2 | 深度接入（Gateway 模型目录、转录对账、原生配置同步）；矩阵 5 格 ✅（2026-10-11 的验证早于 ADR-047 与 B6，`.tmp` 证据已不存在，待 M3 T-OC-08 重验）；升级与重启按 ADR-043 由用户确认——2026-10-17 用户点击升级被目标版本的配置校验拦下（[逐份升级验收](../verification/installation-upgrade-2026-10-17.md)“4317 部署”一节），升级路线待 ADR-0052（第二批 C6 的 proposed 草案） |
| WorkBuddy | `/Applications/WorkBuddy.app` 5.3.14，内嵌 CodeBuddy CLI 2.115.0（`package.json` 的 version 为 0.0.0）；npm 上 `@tencent-ai/codebuddy-code` 最新 2.163.0；`~/.codebuddy` 不存在 | 无 | 完全未接入 |

非焦点三个（Cursor、Gemini CLI、Pi）按 ADR-046 第 6 项已冻结（OpenClaw 已按用户补充归入焦点）：不再新增矩阵 ✅、不更新已验证版本、不承接新能力；适配器、测试与历史证据保留。

## 范围与完成定义

- **范围**：七个焦点 Harness 的会话、模型、连续性、管理（探测、升级、卸载）、能力（技能、MCP、指令、子 Agent、命令、Hooks、插件）。
- **完成按五层分别表述**，不混写：
  1. 设计采纳：ADR accepted，切片登记在 `plan/slices.json`。
  2. 代码完成：正式入口可用，边界检查与设计检查通过。
  3. 测试通过：对应层（unit、integration、protocol、browser）的测试通过，且有无效样例。
  4. 真实引擎通过：在本机官网安装的、`VERIFIED_VERSIONS` 所记的版本上，经 4317 的正式入口真实通过，验收记录写明命令、版本、渠道与局限。
  5. 平台：只有 macOS（ADR-044）；不再写“Windows/Linux 未验证”。
- **“做精”的判据**（每个焦点 Harness）：矩阵的每一格要么是在当前已验证版本上的 ✅，要么是 ☑（原接口部分提供，Hub 已尽：native=partial、hub=done、protocol=pass、real=pass，且说明写明原接口缺什么；审批代理裁决 2，计为终态），要么是写明原因的 —、✕ 或 ○；已验证版本就是本机当前使用的那份官网安装的版本；能力页的每一步在它上面有真实往返记录；在原程序中继续的命令经真实回合验证；每个安装渠道的升级与卸载至少真实执行过一次——OpenClaw 的卸载例外：以替身验证与只读核对真实 launchd 状态代替真实执行（审批代理裁决 3，T-OC-13 选 A）。
- **不算完成**：协议测试通过不算真实通过；指向已不存在的 `.tmp/` 文件的证据不算通过，真实验收为通过或部分通过的格必须至少有一项仓库内证据（设计检查规则，裁决 5）；非官网安装上的证据按 ADR-044 为历史（矩阵 `historical: true`，不计入 `native_capabilities_complete_official`，裁决 6）。

## 用户待决项

### 1. 非焦点三个（Cursor、Gemini CLI、Pi）的处置

- **A 冻结**：维持 ADR-046 第 6 项，界面照常显示。代价：选择器与“我的 Agent”里继续出现三个不再打磨的产品，用户会把它们当作同等支持。
- **B 冻结并默认隐藏**（推荐）：目录、适配器、测试与历史证据全部保留；“我的 Agent”、选择器与能力页默认不显示它们，设置里一个开关“显示非焦点 Harness”；停在它们上面的历史对话照常可以打开（ADR-044 第 6 条）。代价：一个开关与几处过滤；矩阵仍列出它们，标“冻结”。
- **C 删除**（不可逆）：删除三个产品的目录条目、适配器、测试与品牌资产。代价：
  - 仓库唯一的 A→B→A 真实切换证据是 codex↔gemini（`docs/engineering/testing.md` 第 4 节要求至少两个 Harness 的 A→B→A）；
  - 旧对话续聊：ADR-044 第 6 条承诺历史对话保留，删除适配器后只能看、不能续；
  - 还牵动 `tests/unit/verified-versions.test.ts` 把已验证表的键集合与矩阵 Harness 集合绑死的断言、`plan/native-capabilities.json` 的 Harness 列表（设计检查按它校验每格与证据路径）、注册表快照与品牌资产。

### 2. WorkBuddy 的接入路线

事实：WorkBuddy 应用内嵌 CodeBuddy CLI；CLI 的家目录由环境变量 `CODEBUDDY_CONFIG_DIR` 决定，缺省 `~/.codebuddy`；应用自己把数据放在 `~/.workbuddy`，并以 `--serve` 侧车加 streamable-http 的方式运行 CLI。Hub 直接以 stdio 启动内嵌 CLI 而不设环境变量，会建出一份私有的 `~/.codebuddy`，用户要再登录一次，而且遥测、自动更新（会改 PATH）、自动记忆默认开启；Hub 的 stdio 会话不会出现在应用的会话列表里。ACP 注册表登记的是 `npx @tencent-ai/codebuddy-code@2.163.0 --acp`。

- **A npm `@tencent-ai/codebuddy-code`**：走 ADR-044 现有的 npm 渠道，探测、升级、卸载都按现有流程。代价：登录与数据在 `~/.codebuddy`，与应用的 `~/.workbuddy` 是两份，用户要登录两次；版本与应用不同步（2.163.0 对 2.115.0）；两边的会话互不可见。
- **B 应用内嵌 CLI 2.115.0，共享 `~/.workbuddy`**（推荐）：Hub 启动内嵌 CLI 时注入 `CODEBUDDY_CONFIG_DIR=~/.workbuddy`、`WORKBUDDY_CONFIG_DIR=~/.workbuddy`、`WORKBUDDY_DATA_FOLDER_NAME=.workbuddy`、`DISABLE_AUTOUPDATER=1`。这是 [ADR-021](0021-native-profile-and-deviation-tolerance.md)“只透传用户真实设置的配置位置变量”的例外，要写进 ADR-021 并有测试证明只对 WorkBuddy 注入；升级由应用负责，Hub 只显示版本；卸载不适用；[ADR-044](0044-macos-official-channels.md) 需补第五类只读渠道 `app-bundle`（程序在 `/Applications/WorkBuddy.app` 内），只探测、不维护。代价：应用更新后 CLI 版本随之变，需要 ADR-038 的已验证区间；应用不在时这个 Harness 不可用；注入的变量名要在真实启动中核实。
- **C 并列**：A 与 B 同时作为同一产品的两份安装列出（ADR-044 的多份安装），用户选哪份是“当前使用”。代价：两份数据目录、两次登录与“哪份在用”的困惑同时存在，等于把 A 和 B 的代价都留下。

### 3. Harness id 与显示名

- **A id `workbuddy`，显示名“WorkBuddy（CodeBuddy CLI）”**（推荐）：与用户的叫法和应用名一致，显示名说明内核。
- **B id `codebuddy`，显示名“CodeBuddy CLI”**：与 npm 包名和 ACP 注册表一致；选路线 A 时更贴切，但与应用名不一致。

id 一旦进入业务库的选择快照、能力库的台账与矩阵就不能改，所以要在接入前定。

### 4. 遥测、自动记忆、cron 在 Hub 会话里是否关闭

- **A 全部按 CLI 默认（开）**：与终端里一致。代价：Hub 读模型目录的探测会话也会上报遥测、写记忆。
- **B 在 Hub 启动的进程里关闭遥测与自动更新，记忆与 cron 按用户自己的设置**（推荐）：探测会话不留痕，对话行为与应用一致。代价：对应的环境变量或设置项名本轮只做了静态读取，接入前要在真实启动中核实；注入同样是 ADR-021 的例外。
- **C 全部关闭**：最可控。代价：与应用内的行为不一致，用户在 Hub 里得不到记忆与定时任务。

### 5. 运行时

- **A PATH 上的 Node（本机 26.x，nvm）**：与终端一致，不依赖应用。代价：CLI 2.115.0 的 `engines` 要求本轮未核实；nvm 改 PATH 时版本会变。
- **B 应用受管的 Node 22.22.2**（推荐，待核实）：与应用运行 CLI 的环境一致。代价：路径在应用包内，应用更新即变，需要按 app-bundle 渠道重新探测。
- **C `ELECTRON_RUN_AS_NODE=1`，用应用的 Electron 运行 CLI**：与应用自己的侧车最接近。代价：Electron 启动更重，这个变量影响面大，Hub 的进程监督要另行验证。

### 6. 两个永远为 false 的门禁标志与 G0～G5

事实：`plan/tasks.json` 顶层的 `application_implementation_allowed` 与 `plan/slices.json` 的 `gateway_execution_implementation_allowed` 自 2026-10-09 起一直是 false，`tools/check_design.py` 只要求它们为 false；真正起作用的门禁是各已接受切片的 `allowed_files`（源码不在其中就被拒绝）。`docs/engineering/readiness.md` 的 G0～G5 描述的是完整工程地图的门禁，其中 G5 写“各发行平台”，与只面向 macOS 不符。

- 两个标志：**A 保留**（没有成本，但常量冒充门禁，新人误读）；**B 改名**为说明真实含义的字段，例如记录“源码范围只由切片 allowed_files 放开”（要同时改检查工具、它的测试与文档）；**C 删除**（推荐：检查规则“源码不在已接受切片内即拒绝”照旧，去掉两个没有信息量的常量，改检查工具、测试与文档各一处）。
- G0～G5：**A 保留**；**B 改写成五层完成定义的门禁**（推荐：G0 资料可追溯、G1 切片 ADR accepted 且源码在 allowed_files 内、G2 测试通过且有无效样例、G3 正式入口链路通过、G4 真实引擎通过，G5 并入“只面向 macOS”）；**C 删除**，只留切片门禁。

## 原先另行送审的五项

Claude 的版本策略（每周自更新对“只认一个版本号”）、dsh 的验证基线（rc.2 重验收）、Hermes 的升级路线（上游 main 的 `hermes acp` 与 ADR-031 的进程模型冲突）、业务库迁移前备份、审计记录的保留与导出。总指挥把它们与刷新时机一起并入送给用户的八项，已在同一回复里选定，见下节。

## 用户决定（2026-10-21）

总指挥送给用户的八项（非焦点处置、WorkBuddy 路线、Claude 版本策略、dsh 基线、Hermes、业务库迁移前备份、审计、刷新时机）每项附推荐，用户回复“全部按推荐”。选定结果与落点：

| # | 决定 | 选定内容 | 落点 |
|---|---|---|---|
| 1 | 非焦点三个 | 冻结并默认隐藏：目录、适配器、测试与历史证据保留；“我的 Agent”、选择器与能力页默认不显示 Cursor、Gemini CLI、Pi，设置里可再显示；停在它们上面的历史对话照常可以打开（ADR-044 第 6 条） | 目录分层字段与过滤、设计检查规则、浏览器测试 |
| 2 | WorkBuddy | 路线 B：接应用内嵌的 CodeBuddy CLI，与应用共用 `~/.workbuddy`；id `workbuddy`，显示名“WorkBuddy（CodeBuddy CLI）”；Hub 启动的进程里关闭自动更新、自动记忆与 cron；运行时用 PATH 上的 Node；遥测由用户另定 | M4：先只读研究与一次受控 ACP 握手，再写接入 ADR |
| 3 | Claude 版本策略 | 区间加冒烟：已验证区间两端都要有真实记录；检测到新版本后由用户在页面触发一次约 10 次提示的冒烟（目录、原生恢复、审批、续接命令、一项能力生效核对），通过即扩区间；以本机 2.1.306 重验，区间 [2.1.296, 2.1.306]；页面显示各家的自更新状态，只显示，不写配置 | M3 真实重验收；冒烟入口与自更新状态是新功能 |
| 4 | dsh 基线 | 以本机 0.2.0-rc.2 为精确基线，尽快重验（不超过 ¥3）；dsh 按 profile 分开保存设置这一点只在界面说明 | 真实验收的配置守护清单落地后执行 |
| 5 | Hermes | 先只读研究 v0.22.2 标签与当时的 main（网关投影的启用条件、认证、审批期限、`/model` 回复、会话导出、迁移），出 ADR 草案后再定升级与否；期间停在 0.12.0 维护 | 只读研究记录与 ADR 草案 |
| 6 | 业务库迁移前备份 | 每次存储版本提升前用 `VACUUM INTO` 备份，保留最近 2 份，超出删最旧；备份失败则迁移不发生 | 业务库所有者助手；此前不批准持久格式升级 |
| 7 | 审计 | 修改记录、备份、任务与日志保留 90 天，到期导出为 0600 文件后裁剪；可导出 JSON/Markdown；手工操作补记为 manual 类型，标“产品流程外”，不进漂移比对；原生模式下用户自己的凭据在页面与导出里默认打码 | 统一操作记录、保留与导出、补记格式 |
| 8 | 刷新时机 | 手动“重新检测”、管理任务完成、登录 shell 目录变化时刷新，另加窗口重新获得焦点时刷新（至少间隔 60 秒）；不再后台轮询 | 去轮询化与原生检查缓存 |

与本记录先前推荐的出入：上文第 4、5 项原推荐“记忆与 cron 按用户自己的设置”“应用受管的 Node 22.22.2”；用户选定的是总指挥的版本，即在 Hub 会话里关闭记忆与 cron、用 PATH 上的 Node。只读研究要核实内嵌 CLI 2.115.0 的 `engines` 接受 PATH 上的 Node，以及这些开关的变量名在真实启动中生效；任一项不成立，回到用户重新选。遥测是否关闭仍待用户决定，接入前必须定下。

## 审批代理裁决（2026-10-22）

总指挥兼审批代理对第 6 项及由它牵出的证据规则裁决如下，第二批 C1 同日落地（`tools/check_design.py` 与 `tools/test_check_design.py`、`plan/*.json`、`docs/engineering/readiness.md`）：

1. **门禁标志与 G0～G5**：两个标志选 **C 删除**——`plan/tasks.json` 的 `application_implementation_allowed` 与 `plan/slices.json` 的 `gateway_execution_implementation_allowed` 连同检查规则、摘要字段与无效样例一起删除；源码门禁只由各已接受切片的 `allowed_files` 决定（“源码不在已接受切片内即拒绝”照旧，没有任何已接受切片时 `src/`、`web/` 下的每个文件都被拒绝）。G0～G5 选 **B 改写**为五层完成定义的门禁：G0 资料可追溯（plan、docs、source-lock）；G1 设计采纳（切片 ADR accepted，源码在 `allowed_files` 内）；G2 测试通过且新增检查有无效样例（unit/integration/protocol/browser 与 tools 自检）；G3 正式入口链路通过（Gateway/CLI 集成，SQLite/IPC/进程保持真实）；G4 真实引擎通过（本机官网安装版本、`VERIFIED_VERSIONS`、`docs/verification` 记录）；G5 并入“只面向 macOS”，不再单列。`plan/tasks.json` 的 `gate` 字段（G0/G1）只区分设计交付与实现，字段值不改，readiness.md 写明这一点。
2. **☑ 终态**：native=partial、hub=done、protocol=pass、real=pass 且 `note` 写明原接口缺什么的格记为 ☑（“原接口部分提供，Hub 已尽”），按本记录的判据计为终态；同类格没有说明是设计检查错误（不再渲染为 ◐）。摘要新增 `native_capabilities_exhausted`（☑ 数）。
3. **OpenClaw 的卸载真实验收豁免**（T-OC-13 选 A）：真机卸载会注销用户的 Gateway、断开微信与飞书，而 ADR-044 的卸载测试已用替身覆盖停止与注销；“做精”判据写明 OpenClaw 的卸载以替身验证与只读核对真实 launchd 状态代替真实执行。
4. **冻结规则**：矩阵的每个 Harness 带 `tier`（`focus`：claude、codex、opencode、dsh、hermes、openclaw，WorkBuddy 接入后加入；`frozen`：cursor、gemini、pi）；冻结 Harness 带 `complete_at_freeze`（冻结时的 ✅ 数：Cursor 0、Gemini CLI 0、Pi 11），设计检查拒绝冻结列 ✅ 数超过它，以及 focus 列带 `complete_at_freeze`、未知 tier、未知 Harness 级字段。
5. **证据规则**：real 为 pass 或 partial 的格，`evidence` 至少一项不是 `.tmp/` 开头（仓库内路径，沿用存在性检查）；`.tmp/` 只作补充。落地时抓到并修正两格：`opencode/resume`（补第二轮验收记录）与 `openclaw/modes-settings`（补 2026-10-11 的补齐记录）。
6. **历史安装**：dsh 与 pi 的 `installation` 已写明非官网安装，矩阵加 `historical: true`，视图列名后标“（历史）”，摘要在 `native_capabilities_complete` 之外另给 `native_capabilities_complete_official`（不含 historical）。

同次按代码更正 OpenClaw 三格（不改行为）：`mcp` 由“不提供”改为原接口部分提供（2026.3.23-2 的 `mcp.servers` 与隐藏的 `openclaw mcp` 命令）、Hub 未接出（ACP 桥不报告 MCP，能力页的只读按 ADR-045 不计入）；`subagents` 的 Hub 为部分（`sessions_spawn` 映射为子 Agent 工具，子会话内容不可见）；`modes-settings` 补记录与未真实使用的选项。OpenClaw 的五格 ✅ 不动，说明注明待 M3 T-OC-08 重验。

## 影响（用户选定后）

- 第 1 项选 B：Web 层加一处过滤与一个设置开关，矩阵与文档标“冻结”；选 C：另立 ADR 列出删除清单与证据处置。
- 第 2～5 项：目录加一条产品（`src/adapters/catalog.ts`、`catalog-channels.ts`）、`VERIFIED_VERSIONS` 加键、矩阵加一列（设计检查要求每个 Harness 覆盖全部能力项）、ADR-021 的例外表、ADR-044 的第五类渠道、`tests/unit/verified-versions.test.ts` 的键集合。接入前先做一轮只读研究记录（ACP 面、登录位置、`session/load` 能否加载应用会话、探测会话的计费语义），再写接入 ADR。
- 第 6 项（已落地，2026-10-22）：`tools/check_design.py` 与 `tools/test_check_design.py`、`plan/*.json`、`docs/engineering/readiness.md`；tools 自检并入 `pnpm check`（`check:tools`）。

## 验证（用户选定后）

- 非焦点隐藏：浏览器测试覆盖开关的两种状态与停在非焦点 Harness 上的历史对话；设计检查通过。
- WorkBuddy：先只读研究，后接入 ADR；第一次真实回合、登录与会话列表的核对需要用户同意，在 4317 进行。
- 门禁标志与 G0～G5：检查工具的无效样例随改动更新，`python3 -I -B -m unittest discover -s tools -p 'test_*.py'` 通过（2026-10-22：60 个样例通过；tier、complete_at_freeze、仓库内证据、☑ 说明、historical 与未知 Harness 字段各有拒绝样例，并经临时关闭规则的变异核对；`python3 -I tools/check_design.py` 在仓库数据上通过，`--write` 可重现）。
