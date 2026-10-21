# ADR-048：六个焦点 Harness 的范围、完成定义与 WorkBuddy 接入路线（提案）

状态：proposed，2026-10-21，等待用户决定。本记录只列事实、选项与推荐，不替用户选；每一项由用户选定后，审批代理补裁决，本记录转 accepted。切片 harness-focus 的第一批工程加固见 [ADR-046](0046-harness-focus-hardening.md)，不被本记录阻塞。

## 背景

用户 2026-10-21 的指令：只支持 Claude Code、Codex、OpenCode、DeepSeek Harness、WorkBuddy、Hermes Agent 六个，“把这些适配好，做精”。

本机事实（2026-10-21 只读核对，没有运行任何 Harness）：

| Harness | 本机安装 | HarnessHub 已验证版本（ADR-038） | 现状 |
|---|---|---|---|
| Claude Code | 2.1.306（nvm，当前使用）、2.1.302（npm，Homebrew 前缀）；适配器 claude-agent-acp 0.89.1 | 2.1.296 | 当前版本没有一格真实证据；Claude 每周自更新 |
| Codex | 0.162.1（Homebrew cask） | 0.162.1 | 深度接入；上游已发 0.163.x |
| OpenCode | 1.18.35（Homebrew formula；Cellar 另有 1.1.21） | 1.18.35 | 深度接入；隐藏 `/compact` 未接 |
| Hermes Agent | 0.12.0（官方脚本；网关在运行，从未触碰） | 0.12.0 | 审批是上游缺陷；`hermes update` 会拉 origin/main，上游 main 的 `hermes acp` 是网关投影 |
| DeepSeek Harness（dsh） | 0.2.0-rc.2（npm 官网，2026-10-18 经 4317 安装） | 0.2.1-alpha.1（源码版，按 ADR-044 为历史） | 矩阵 9 格真实证据来自已作废的源码版 |
| WorkBuddy | `/Applications/WorkBuddy.app` 5.3.14，内嵌 CodeBuddy CLI 2.115.0（`package.json` 的 version 为 0.0.0）；npm 上 `@tencent-ai/codebuddy-code` 最新 2.163.0；`~/.codebuddy` 不存在 | 无 | 完全未接入 |

非焦点四个（Cursor、Gemini CLI、OpenClaw、Pi）按 ADR-046 第 6 项已冻结：不再新增矩阵 ✅、不更新已验证版本、不承接新能力；适配器、测试与历史证据保留。

## 范围与完成定义

- **范围**：六个焦点 Harness 的会话、模型、连续性、管理（探测、升级、卸载）、能力（技能、MCP、指令、子 Agent、命令、Hooks、插件）。
- **完成按五层分别表述**，不混写：
  1. 设计采纳：ADR accepted，切片登记在 `plan/slices.json`。
  2. 代码完成：正式入口可用，边界检查与设计检查通过。
  3. 测试通过：对应层（unit、integration、protocol、browser）的测试通过，且有无效样例。
  4. 真实引擎通过：在本机官网安装的、`VERIFIED_VERSIONS` 所记的版本上，经 4317 的正式入口真实通过，验收记录写明命令、版本、渠道与局限。
  5. 平台：只有 macOS（ADR-044）；不再写“Windows/Linux 未验证”。
- **“做精”的判据**（每个焦点 Harness）：矩阵的每一格要么是在当前已验证版本上的 ✅，要么是写明原因的 —、✕ 或 ○；已验证版本就是本机当前使用的那份官网安装的版本；能力页的每一步在它上面有真实往返记录；在原程序中继续的命令经真实回合验证；每个安装渠道的升级与卸载至少真实执行过一次。
- **不算完成**：协议测试通过不算真实通过；指向已不存在的 `.tmp/` 文件的证据不算通过；非官网安装上的证据按 ADR-044 为历史。

## 用户待决项

### 1. 非焦点四个（Cursor、Gemini CLI、OpenClaw、Pi）的处置

- **A 冻结**：维持 ADR-046 第 6 项，界面照常显示。代价：选择器与“我的 Agent”里继续出现四个不再打磨的产品，用户会把它们当作同等支持。
- **B 冻结并默认隐藏**（推荐）：目录、适配器、测试与历史证据全部保留；“我的 Agent”、选择器与能力页默认不显示它们，设置里一个开关“显示非焦点 Harness”；停在它们上面的历史对话照常可以打开（ADR-044 第 6 条）。代价：一个开关与几处过滤；矩阵仍列出它们，标“冻结”。
- **C 删除**（不可逆）：删除四个产品的目录条目、适配器、测试与品牌资产。代价：
  - ADR-027（OpenClaw 转录对账）与 ADR-028（原生配置同步）的真实验证只来自 OpenClaw，删除后这两条决定没有真实证据；
  - 仓库唯一的 A→B→A 真实切换证据是 codex↔gemini（`docs/engineering/testing.md` 第 4 节要求至少两个 Harness 的 A→B→A）；
  - 本机 OpenClaw 网关正在运行并接着微信、飞书，它的升级与重启（ADR-043 的真实验收来自它）由 HarnessHub 管理，删除后只能在终端维护；
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

## 不在本提案内（另行送审）

Claude 的版本策略（每周自更新对“只认一个版本号”）、dsh 的验证基线（rc.2 重验收）、Hermes 的升级路线（上游 main 的 `hermes acp` 与 ADR-031 的进程模型冲突）、业务库迁移前备份、审计记录的保留与导出。这些不阻塞第一批。

## 影响（用户选定后）

- 第 1 项选 B：Web 层加一处过滤与一个设置开关，矩阵与文档标“冻结”；选 C：另立 ADR 列出删除清单与证据处置。
- 第 2～5 项：目录加一条产品（`src/adapters/catalog.ts`、`catalog-channels.ts`）、`VERIFIED_VERSIONS` 加键、矩阵加一列（设计检查要求每个 Harness 覆盖全部能力项）、ADR-021 的例外表、ADR-044 的第五类渠道、`tests/unit/verified-versions.test.ts` 的键集合。接入前先做一轮只读研究记录（ACP 面、登录位置、`session/load` 能否加载应用会话、探测会话的计费语义），再写接入 ADR。
- 第 6 项：`tools/check_design.py` 与 `tools/test_check_design.py`、`plan/*.json`、`docs/engineering/readiness.md`。

## 验证（用户选定后）

- 非焦点隐藏：浏览器测试覆盖开关的两种状态与停在非焦点 Harness 上的历史对话；设计检查通过。
- WorkBuddy：先只读研究，后接入 ADR；第一次真实回合、登录与会话列表的核对需要用户同意，在 4317 进行。
- 门禁标志与 G0～G5：检查工具的无效样例随改动更新，`python3 -I -B -m unittest discover -s tools -p 'test_*.py'` 通过。
