# ADR-052：OpenClaw 的升级路线与轨道

状态：proposed，2026-10-22（只读研究的草案，供用户在路线 A/B/C 与轨道 latest / extended-stable 之间选择；没有代码改动）。事实见 [OpenClaw 2026.10.x 升级就绪](../research/openclaw-2026.10-upgrade-readiness-2026-10-22.md)。依据 [ADR-043](0043-upgrade-with-running-programs.md)、[ADR-044](0044-macos-official-channels.md)、[ADR-045](0045-unified-capability-management.md) 裁决 9、[ADR-048](0048-harness-scope-and-workbuddy.md)。

## 背景

- 本机 OpenClaw 2026.3.23-2（npm 全局，Homebrew 前缀），Gateway 守护进程接着微信（openclaw-weixin 2.0.1）与飞书，默认模型走 deepseek 提供方。Node 前提已满足（PATH 与两个 launchd 服务都是 26.11.1）。
- 2026-10-17 用户点击升级被 HarnessHub 的兼容校验拦下：候选版本的 `config validate` 拒绝了 `meta`、`messages`、`commands`、`gateway.tailscale`、`gateway.nodes` 几个键。这些正是候选版本的 Doctor 在更新时迁移的键，而 HarnessHub 的校验预演不跑 Doctor。
- 候选版本只接受完全符合 schema 的配置，否则 Gateway 拒绝启动。所以 HarnessHub 现在的路径（装新版本、不跑 Doctor、kickstart）即便绕过校验也会让渠道中断，直到有人运行 `openclaw doctor --fix`。
- 官方要求 2026 年 7 月之前的安装先升到 **2026.9.5** 并运行它的 Doctor，再升到目标版本；直接装最新版会被 Doctor 停在退役键前。
- deepseek 提供方与飞书渠道在两个候选版本里都不随包发布，改为官方外部插件（`@openclaw/deepseek-provider`、`@openclaw/feishu`），升级后要装回来；缺失不阻止 Gateway 启动，但默认模型和飞书渠道在装回之前不可用。
- 两个候选的 ACP 桥能力相同（resume/close、lineage `_meta`、思考流、工具流、审批中继，默认键 `acp-bridge:`，`_meta.sessionKey`/`requireExistingSession` 仍受理）；差别是发布日期（10-15 对 10-18）、包体积（390 MB 对 249 MB 解包）与 `src/acp` 的重构幅度。
- 新版本改 `mcp.*` 与 `plugins.*` 不再重启 Gateway（文档），ADR-045 裁决 9 的解锁仍按审批代理的条件在真实版本上核实。

## 轨道

- **latest（2026.10.5）**：最新修复在这条线；`src/acp` 刚做过重构（公共部分进 `@openclaw/acp-core`）。
- **extended-stable（2026.9.33）**：维护线，只对包安装，`--tag` 不能与它同用；ACP 桥与 latest 的文档逐字相同。
- 用户此前的条件是“若 extended-stable 不含这些 ACP 桥改进则选 latest，否则选 extended-stable”。研究结果是**含**，所以按用户自己的规则应选 **extended-stable**。从 2026.9.33 再到 2026.10.x 在同一迁移窗口内，以后可以再走一次同样的流程。

## 路线

下表的“点击”指用户在 4317 上的确认次数，“中断”指 Gateway 重启或插件缺失造成的渠道不可用，“复验”指 T-OC-12（升级后的真实重验收与已验证版本更新）在升级后版本上的真实回合（审批代理：`HH_REAL_READONLY=1`，审批只“允许一次”一条只读命令，≤ ¥5）。本 ADR 里的 T-OC-nn 编号来自总指挥 2026-10-21 的 OpenClaw 透镜计划，M1b 是其路线图里程碑“规范与证据基线的其余部分”；它们尚未登记进 `plan/tasks.json` 或 `TASKS.md`，所以首次出现处都用几个字说明。

### A：HarnessHub 在预检与备份后调用官方 `openclaw update`，事后核实

- **流程**（两跳，因为桥接版本是硬要求）：
  1. 预检（只读）：版本与渠道、Node（已满足）、磁盘（两跳各一份包）、`openclaw update --dry-run --json`（不预演候选，只给计划）、插件目录名清单、Gateway 与 Node 服务的进程与端口（ADR-043 的维护接口）。
  2. 备份：不复制 `openclaw.json`（它含渠道凭据，ADR-043 第 8 条禁止复制），只记录它与插件目录的摘要；依赖 OpenClaw 自己的备份（Doctor 改写前的 `.bak`～`.bak.4`、迁移前的 SQLite 快照）并在确认框写明。要求用户在确认前自己运行一次 `openclaw backup`（HarnessHub 不代跑）。
  3. 第一跳：`openclaw update --tag 2026.9.5 --json --yes --timeout 1200`（由本机 2026.3.23-2 的更新器执行：装包、跑 2026.9.5 的 Doctor、重启 Gateway）。HarnessHub 不再自己 kickstart；用 ADR-043 第 5 条的恢复判定核实 `ai.openclaw.gateway` 的新进程与端口，再读 `openclaw update status --json`。**这一跳的生命周期脚本是关键路径上的未知数**：旧更新器发起的是不带脚本参数的 `npm i -g <spec>`（`dist/server-startup-matrix-migration-DR8lh8kT.js:682-702` 的 `globalInstallArgs`，只追加静默参数；本机整个 `dist/` 没有 `allow-scripts`，更新器与这个分块也没有 `ignore-scripts`），而 2026.9.5 带 `preinstall`/`postinstall`，候选文档要求 npm 12 或 11.16+ 加 `--allow-scripts=openclaw` 才运行它们（`2026.10.5:docs/install/updating.md:102-103`），本机 PATH 上的 npm 是 11.20.0。所以第一跳很可能跳过这两个脚本：preinstall 的 Node 核对（本机已满足，无影响）与 postinstall 的旧文件清理和 `.openclaw-lifecycle-pending` 标记清除——残留标记由谁消费、是否告警，是研究记录的未核实第 5、10 条。处置见“推荐”的第四件事。
  4. 第二跳：`openclaw update --channel extended-stable --json --yes --timeout 1200`（或 latest 时 `--tag 2026.10.5`），由 2026.9.5 的更新器执行（带候选自治准入：候选自己判断配置、schema、Node 与插件可用性）。
  5. 插件：核实 `openclaw plugins list --json` 里 deepseek 提供方与飞书渠道的状态；缺失则在完成页给出 `openclaw plugins install deepseek` / `openclaw plugins install feishu`（裸 id 走官方目录：`2026.10.5:docs/cli/plugins/install.md:42` 的 `openclaw plugins install @openclaw/<package>` 是受信官方目录，`:64` 官方插件 id 与不带限定的官方包名按目录声明的来源顺序安装，`:225` 裸 spec 命中官方插件 id 时直接装目录条目）的命令，HarnessHub 本轮不代装；openclaw-weixin 保持 2.0.1（不会被自动升级），其兼容性在第二跳后由用户确认微信是否恢复。
  6. 事后：重新探测版本、读 `openclaw gateway status --deep`（只读）、核对 `openclaw.json` 摘要变化并归入“重启后的服务自己写的”；然后 T-OC-11（2026.10.x 适配：按版本门控，旧版本行为不变）的版本门控与 T-OC-12 的复验。
- **前置**：ADR-043 的确认框改写；用户同意“HarnessHub 运行 `openclaw update`，它会跑 Doctor 迁移你的配置并重启 Gateway 两次”。
- **点击**：2 次确认（两跳各一次；失败即停，不自动进入下一跳、不回滚、不重试），加完成页上插件命令的用户自行执行。
- **中断**：两次 Gateway 重启（各几十秒）；第二跳之后到装回 deepseek 与飞书插件之间，默认模型与飞书不可用；微信取决于 2.0.1 的兼容性（未核实）。
- **复验**：T-OC-08（2026.3.23-2 上的驱动小修与真实重验收）的 14 格有真实证据的能力加上 6 格原先“原接口不提供”的（思考流、工具流、审批中继等），约 25～35 个只读回合，deepseek-chat 每回合约 ¥0.01～0.05，合计 ¥1～2，上限 ¥5。
- **要改的代码**：
  - `src/adapters/management/recipes.ts:11-27`：`upgradeNotes` 第 1、3 条（“HarnessHub 不运行 openclaw doctor，也不迁移你的配置”）改为“由 `openclaw update` 运行 Doctor 迁移”，并加两跳、插件装回与 `openclaw backup` 的说明；服务声明不变。
  - `src/infrastructure/management/native.ts:183-204`：去掉对 OpenClaw 的“临时目录 + `config validate`”预演（它对候选版本必然失败），改为 `openclaw update --dry-run --json` 的计划读取；`:191-193` 与 `:218` 的 `--ignore-scripts` 对 A 不再适用（安装由 `openclaw update` 完成），对保留的 npm 直装路径改为官方写法 `--allow-scripts=openclaw`（npm ≥ 11.16）。
  - `native.ts` 的 `execute` 新增 `native-update` 一类：运行 `openclaw update …`，解析 `UpdateRunResult`。期限是 HarnessHub 自己的决定，不依赖更新器的默认值：候选版本的更新器省略 `--timeout` 时**没有**工作期限（`2026.10.5:docs/cli/update.md:638-639`、`:654`，`:806` 默认 Unset），本机 2026.3.23-2 的更新器每步默认 1200 秒（本机 `docs/cli/update.md:38`；`dist/update-cli-6OGXKQdy.js:1361` 传给 `runPackageInstallUpdate` 的 `timeoutMs ?? 20 * 6e4`），2026.9.5 更新器的默认值未核实。决定：两跳都显式传 `--timeout 1200`（沿用旧更新器的每步 20 分钟；两个候选解包 250～390 MB，再加 Doctor），每跳的管理任务另设 3600 秒外层期限（装包、Doctor、重启与 ADR-043 第 5 条的恢复判定），到期按第 6 条判失败、不回滚不重试；数值在真机第一次运行后按实测回合复核。
  - ADR-043 的 kickstart 路径（`program-usage.ts`）：对 A 不执行 kickstart，只做恢复判定；确认框里“将要执行的命令原文”改为 `openclaw update …` 的原文。第 6 条“失败不回滚不重试”保持。
  - 管理库：任务新增“两跳”的阶段记录（是否提升版本号、迁移前备份按用户决定 6（迁移前 `VACUUM INTO` 备份，C4 的 ADR-049）的规则，由管理库的所有者定）。
- **代价**：一次不小的管理功能改动；HarnessHub 对升级过程的掌控变弱（Doctor 的迁移与插件同步由 OpenClaw 决定）；需要一次真机验证，而真机只有用户的那份安装。

### B：HarnessHub 只给终端命令，用户自己运行，事后重新探测并复验

- **命令**（按官方文档，HarnessHub 在 Harness 页显示，不代跑）：
  `openclaw backup`；`openclaw gateway stop && npm install -g openclaw@2026.9.5 --allow-scripts=openclaw && openclaw --version && openclaw doctor --fix`；核对 Doctor 的导入结果；`npm install -g openclaw@2026.9.33 --allow-scripts=openclaw && openclaw doctor --fix && openclaw gateway start && openclaw gateway status --deep`（latest 时把版本换成 2026.10.5）；然后 `openclaw plugins install deepseek`、`openclaw plugins install feishu`，必要时 `openclaw plugins update openclaw-weixin`。
- **前置**：把 OpenClaw 的升级类型从 npm 改为“终端命令”（`catalog-channels.ts` 已有 Hermes 的 `terminal` 类型可复用）；ADR-043 的 OpenClaw 升级确认框停用或只保留只读检查。
- **点击**：0 次；用户在终端执行 5～7 条命令。
- **中断**：同 A（两次重启加插件装回的窗口），但由用户掌握时机。
- **复验**：同 A。
- **要改的代码**：`recipes.ts` 的说明与升级类型、Harness 页的命令展示；T-OC-11 的版本门控（`src/adapters/control/openclaw.ts` 按 `initialize` 的版本或探测到的包版本分支：思考流与审批中继有了之后，[ADR-027](0027-openclaw-transcript-reconciliation.md) 的转录对账只补缺）。
- **代价**：与 ADR-043“由 HarnessHub 升级并重启”的用户决定相悖，需要用户同意回到“只给命令”；升级结果靠事后探测。

### C：暂停在 2026.3.23-2，先把当前版本做精

- **做法**：不升级；完成 C5（本批的驱动清理）与 M1b 里程碑的 T-OC-04（Gateway 运行状态、就绪提示与自更新状态，只读）、T-OC-06（Hub 的 /export 经 `sessions.get` 只读导出本会话转录）、T-OC-07（能力页读取 OpenClaw 的 Hooks 与插件条目）、T-OC-15（版本比较与更新轨道）、T-OC-16（目录缓存指纹纳入认证与模型文件的身份）；`recipes.ts` 的说明改为“当前版本不支持经 HarnessHub 升级到 2026.10.x，官方要求先经 2026.9.5”。
- **前置**：无。**点击**：0。**中断**：无。**复验**：T-OC-08 在当前版本上（≤ ¥3）。
- **代价**：ACP 桥没有思考流、工具流与审批中继（矩阵 6 格停在“原接口不提供”）；`mcp.*`/`plugins.*` 写入继续只读；安全与缺陷修复落后 7 个月；用户随时可能自己运行 `openclaw update` 跳到 latest——那时 HarnessHub 没有版本门控会静默改变行为，所以 T-OC-11 的门控在 C 下也要做。

## 推荐

**路线 A，轨道 extended-stable（2026.9.33）；研究期之外的默认状态是 C。** 理由：

1. 用户已经决定“由 HarnessHub 升级并重启”（ADR-043），A 是在这个决定内把“不跑 Doctor”改成“由产品自己跑 Doctor”——这是官方唯一支持的跨这么大跨度的方式；B 退回命令行，C 把问题留给将来。
2. extended-stable 的 ACP 桥与 latest 相同，按用户自己定的规则应选它；它是维护线，重构幅度小，渠道断开的风险最低。
3. 两跳、插件装回与两次重启都要写进确认框；第一跳失败就停。

**选 A 之前要先核实的四件事**（都可以只读做）：候选 Doctor 对本机配置的实际裁决（用户运行一次 `openclaw doctor`，不带 `--fix`，把输出里的键名告诉 HarnessHub，不贴值）；`openclaw update` 会不会自动补装 deepseek 与飞书插件；openclaw-weixin 2.0.1 在新宿主上能否加载（没有办法只读核实，只能在第二跳后观察，所以确认框要写“微信可能需要升级插件”）；第一跳的生命周期脚本——旧更新器的 `npm i -g` 在本机 npm 11.20.0 下会不会运行 2026.9.5 的 `preinstall`/`postinstall`，以及残留的 `.openclaw-lifecycle-pending` 标记有没有后果（研究记录未核实第 5、10 条；可只读核实：npm 11.16+ 对未列入 `--allow-scripts` 的包是否跳过脚本，2026.9.5 的 Doctor 与 Gateway 启动是否读这个标记）。前三项任一项不成立，回到用户重新选；第四项若脚本确实被跳过且标记有后果，第一跳改为 HarnessHub 自己运行官方命令 `npm install -g openclaw@2026.9.5 --allow-scripts=openclaw`（替换 `native.ts` 现有的 `--ignore-scripts` 直装路径）再 `openclaw doctor --fix`，确认框相应改写，这样第一跳就不再经过旧更新器。

## 不做

- 不复制 `openclaw.json` 作备份（含渠道凭据），不代跑 `openclaw backup`、`openclaw plugins install`（本轮），不在 `openclaw update` 之外再 kickstart。
- 不解锁 ADR-045 裁决 9（MCP 与插件写入），直到 T-OC-12 在升级后的版本上核实。

## 验证（选定后）

- 集成：`openclaw update` 的替身输出 `UpdateRunResult`（成功、第一跳失败、第二跳失败、退出码 75 的交接）各一例；`--dry-run --json` 计划的解析；两跳任务的记录与“没有升级”的显示；无效样例：候选 `config validate` 失败不再阻止（它已不在路径上），Doctor 拒绝退役键时任务停在第一跳。
- 浏览器：确认框的两跳、插件装回、备份要求与红字说明。
- 真机：只有用户点击；按 ADR-043 第 5 条核实两次重启的恢复与端口；升级后按审批代理的条件做 T-OC-12（只读回合、不停不重启 Gateway 与 Node、`openclaw.json` 前后摘要一致）。
