# ADR-052：OpenClaw 的升级路线与轨道

状态：accepted，2026-11-01。2026-10-22 作为第二批 C6 的只读研究草案提出，同日按 [ADR-053](0053-latest-version-baseline.md) 修订（轨道由原则定为 latest，路线 A 保留为推荐并等用户确认）；用户同日答复 ADR-053“待用户决定”第 4 题“由你直接升级……OpenClaw 完全由你支配”，2026-11-01 由用户授权的审批代理（Fable 5.1）裁决实现形态并落地，见文末“2026-11-01 实现裁决”——它是实现依据，上文“路线”一节保留为研究时的草案，与它不同处以它为准。事实见 [OpenClaw 2026.10.x 升级就绪](../research/openclaw-2026.10-upgrade-readiness-2026-10-22.md)与 ADR-053“研究结论摘要”。依据 [ADR-043](0043-upgrade-with-running-programs.md)、[ADR-044](0044-macos-official-channels.md)、[ADR-045](0045-unified-capability-management.md) 裁决 9（已按 ADR-053 修订）、[ADR-048](0048-harness-scope-and-workbuddy.md) 与 ADR-053。

## 背景

- 本机 OpenClaw 2026.3.23-2（npm 全局，Homebrew 前缀），Gateway 守护进程接着微信（openclaw-weixin 2.0.1）与飞书，默认模型走 deepseek 提供方。Node 前提已满足（PATH 与两个 launchd 服务都是 26.11.1）。
- 2026-10-17 用户点击升级被 HarnessHub 的兼容校验拦下：候选版本的 `config validate` 拒绝了 `meta`、`messages`、`commands`、`gateway.tailscale`、`gateway.nodes` 几个键。这些正是候选版本的 Doctor 在更新时迁移的键，而 HarnessHub 的校验预演不跑 Doctor。
- 候选版本只接受完全符合 schema 的配置，否则 Gateway 拒绝启动。所以 HarnessHub 原来的路径（装新版本、不跑 Doctor、kickstart）即便绕过校验也会让渠道中断，直到有人运行 `openclaw doctor --fix`。
- 官方要求 2026 年 7 月之前的安装先升到 **2026.9.5** 并运行它的 Doctor，再升到目标版本；直接装最新版会被 Doctor 停在退役键前。按 ADR-053 决定 6，这是上游要求的中间迁移步骤，保留；它不是版本门槛。
- deepseek 提供方与飞书渠道在新版本里都不随包发布，改为官方外部插件（`@openclaw/deepseek-provider`、`@openclaw/feishu`），升级后要装回来；缺失不阻止 Gateway 启动，但默认模型和飞书渠道在装回之前不可用。
- latest（2026.10.5）与 extended-stable（2026.9.33）的 ACP 桥能力相同（resume/close、lineage `_meta`、思考流、实时工具流、审批中继，默认键 `acp-bridge:`，`_meta.sessionKey`/`requireExistingSession` 仍受理）；差别是发布日期（10-15 对 10-18）、包体积（390 MB 对 249 MB 解包）与 `src/acp` 的重构幅度（公共部分进 `@openclaw/acp-core`）。
- 新版本改 `mcp.*` 与 `plugins.*` 不再重启 Gateway（文档说法）；ADR-045 裁决 9 的 OpenClaw MCP 与插件写入按最新版的实际行为（它的热重载表）决定，由升级后的真实核实解锁，不写“这个版本”。
- 生命周期脚本：2026.9.5 起的包带 `preinstall`/`postinstall`，候选文档要求 npm 12 或 11.16+ 加 `--allow-scripts=openclaw` 才运行它们；本机 PATH 上的 npm 是 11.20.0。本机 2026.3.23-2 的更新器发起的是不带脚本参数的 `npm i -g <spec>`。
- 更新器的期限：2026.3.23-2 的更新器每步默认 1200 秒；2026.9.5 的更新器默认 1800 秒；2026.10.5 省略 `--timeout` 时没有工作期限。

## 轨道（已定：latest）

- 按 ADR-053 决定 6，升级目标是渠道最新版：点击时解析 npm `latest`（2026-10-22 为 2026.10.5），计划时用 `--tag <精确版本>` 冻结目标，确认框显示它；升级前再解析一次，目标变了就不升级、请用户重新检查（ADR-044 第六轮裁决的同一规则）。
- extended-stable（2026.9.33）不再作为选择依据。研究的事实不否认——它含同样的 ACP 桥改进——但原来“用户此前的条件是‘若 extended-stable 不含这些改进则选 latest，否则选 extended-stable’，所以应选 extended-stable”的推理作废（审批代理否决）。本机若装的是 extended-stable（补丁号 ≥ 33，或 `update.channel` 为 extended-stable），确认框写明这次会换到 latest 轨道。
- 2026.9.5 的中间跳保留：上游要求，不是版本门槛。Doctor 报告退役的记忆索引时按上游要求再加 2026.9.7 一跳。

## 路线

下表的“点击”指用户在 4317 上的确认次数，“中断”指 Gateway 重启或插件缺失造成的渠道不可用，“复验”指 T-OC-12（升级后的真实复验与证据更新）在升级后版本上的真实回合（审批代理：`HH_REAL_READONLY=1`，审批只“允许一次”一条只读命令，≤ ¥5）。本 ADR 里的 T-OC-nn 编号来自总指挥 2026-10-21 的 OpenClaw 透镜计划，M1b 是其路线图里程碑“规范与证据基线的其余部分”；它们尚未登记进 `plan/tasks.json` 或 `TASKS.md`，所以首次出现处都用几个字说明。

### A（推荐，等用户确认）：HarnessHub 在预检与备份后调用官方 `openclaw update`，事后核实

- **第一跳之前的四项只读预检**（都不改任何东西）：
  1. 候选 Doctor 对本机配置的实际裁决：用户运行一次 `openclaw doctor`（不带 `--fix`），只把输出里的键名告诉 HarnessHub，不贴值。
  2. `openclaw update` 会不会自动补装 deepseek 与飞书插件（只读核实源码与文档）。
  3. openclaw-weixin 2.0.1 在新宿主上能否加载：没有办法只读核实，只能在第二跳后观察，确认框写“微信可能需要升级插件”。
  4. 第一跳的生命周期脚本：本机 npm 11.20.0 对未列入 `--allow-scripts` 的包是否运行 2026.9.5 的 `preinstall`/`postinstall`，残留的 `.openclaw-lifecycle-pending` 标记有没有后果。

  前两项任一不成立，回到用户重新选；第四项若脚本确实被跳过且标记有后果，第一跳改为 HarnessHub 自己运行官方命令 `npm install -g openclaw@2026.9.5 --allow-scripts=openclaw` 再 `openclaw doctor --fix`，不再经过旧更新器。
- **流程**（两跳，因为桥接版本是硬要求）：
  1. 预检（只读）：版本与渠道、Node（已满足）、磁盘（两跳各一份包）、`openclaw update --dry-run --json`（不预演候选，只给计划）、插件目录名清单、Gateway 与 Node 服务的进程与端口（ADR-043 的维护接口）。
  2. 备份：不复制 `openclaw.json`（它含渠道凭据，ADR-043 第 8 条禁止复制），只记录它与插件目录的摘要；依赖 OpenClaw 自己的备份（Doctor 改写前的 `.bak`～`.bak.4`、迁移前的 SQLite 快照）并在确认框写明。要求用户在确认前自己运行一次 `openclaw backup`（HarnessHub 不代跑）。
  3. 第一跳到 2026.9.5：装回 `@openclaw/deepseek-provider` 与 `@openclaw/feishu`（`openclaw plugins install deepseek` / `feishu`，裸 id 走官方目录）放在桥接版 Doctor 运行之前——上游要求先装受影响的插件再让 Doctor 导入渠道状态；若 `openclaw update --tag 2026.9.5 --json --yes --timeout 1800` 不能在它自己的 Doctor 之前停下，第一跳改为显式三步：装包（预检第 4 项决定走旧更新器还是 `npm install -g … --allow-scripts=openclaw`）→ 装回两个插件 → `openclaw doctor --fix`。Doctor 报告退役的记忆索引时加 2026.9.7 一跳。HarnessHub 不再自己 kickstart；用 ADR-043 第 5 条的恢复判定核实 `ai.openclaw.gateway` 的新进程与端口，再读 `openclaw update status --json`。
  4. 第二跳到 latest：`openclaw update --tag <点击时解析的精确版本> --json --yes --timeout 1800`，由 2026.9.5 的更新器执行（带候选自治准入：候选自己判断配置、schema、Node 与插件可用性）。
  5. 每跳显式传 `--timeout`，不短于 2026.9.5 更新器的默认 1800 秒（两个候选解包 225～390 MB，再加 Doctor）；每跳的管理任务另设 3600 秒外层期限，到期按 ADR-043 第 6 条判失败、不回滚不重试；数值在真机第一次运行后按实测复核。不代传 `--accept-capabilities`：候选版本要求接受的能力声明写进确认框，由用户自己看过再确认。
  6. 每跳之后：`openclaw node restart`（Node 服务不随 `openclaw update` 重启）与 ADR-043 第 5 条的恢复判定（Gateway 新进程、端口在监听）。
  7. 事后：重新探测版本、读 `openclaw gateway status --deep`（只读）、核对 `openclaw.json` 摘要变化并归入“重启后的服务自己写的”，核实 `openclaw plugins list --json` 里 deepseek 提供方与飞书渠道的状态（缺失则在完成页给出装回命令，HarnessHub 本轮不代装）；openclaw-weixin 保持 2.0.1，其兼容性由用户确认微信是否恢复。然后 T-OC-12 在 latest 上复验（≤ ¥5）。
- **T-OC-11 的处置**：原“2026.10.x 适配按版本门控，旧版本行为不变”撤销（ADR-053“已撤销的计划”），改为按 ACP 桥实际报告的能力判断——实时工具流有则去重、审批中继有则接、思考流有则不再从转录补；名册、设置回读、模型可用性与 fork 同理。这部分不依赖升级完成，由第三批 D3 按能力落地（协议测试在 `tests/protocol/openclaw.test.ts`，用能力场景而不是版本场景），升级后在真实网关上复验。
- **前置**：ADR-043 的确认框改写；用户同意“HarnessHub 运行 `openclaw update`，它会跑 Doctor 迁移你的配置并重启 Gateway 两次”。
- **点击**：2 次确认（两跳各一次；失败即停，不自动进入下一跳、不回滚、不重试），加完成页上插件命令的用户自行执行（若预检第 2 项核实为不会自动补装）。
- **中断**：两次 Gateway 重启（各几十秒）；第二跳之后到装回 deepseek 与飞书插件之间，默认模型与飞书不可用；微信取决于 2.0.1 的兼容性（未核实）。
- **复验**：T-OC-08（2026.3.23-2 上的驱动小修与真实复验）的 14 格有真实证据的能力加上 6 格原先“原接口不提供”的（思考流、工具流、审批中继等），约 25～35 个只读回合，deepseek-chat 每回合约 ¥0.01～0.05，合计 ¥1～2，上限 ¥5。
- **要改的代码**（第四批，在第三批 D1、D4 合并之后，因为与 `service.ts`、`UpgradeDialog.tsx` 重叠）：
  - `src/adapters/management/recipes.ts` 的 `upgradeNotes`：“HarnessHub 不运行 openclaw doctor，也不迁移你的配置”改为“由 `openclaw update` 运行 Doctor 迁移”，并加两跳、插件装回、`openclaw backup`、`--accept-capabilities` 与 latest 轨道的说明；服务声明不变。
  - `src/infrastructure/management/native.ts`：OpenClaw 的“临时目录 + `config validate`”预演由第三批 D4 删除（过渡措施见文末）；改为 `openclaw update --dry-run --json` 的计划读取；`execute` 新增 `native-update` 一类，运行 `openclaw update …`、解析 `UpdateRunResult`；保留的 npm 直装路径对 OpenClaw 不再使用。
  - ADR-043 的 kickstart 路径（`program-usage.ts`）：对 A 不执行 kickstart，只做恢复判定与 `openclaw node restart`；确认框里“将要执行的命令原文”改为 `openclaw update …` 的原文。第 6 条“失败不回滚不重试”保持。
  - 管理库：任务新增“两跳”的阶段记录（是否提升版本号、迁移前备份按用户决定 6 的规则，由管理库的所有者定）。
- **代价**：一次不小的管理功能改动；HarnessHub 对升级过程的掌控变弱（Doctor 的迁移与插件同步由 OpenClaw 决定）；需要一次真机验证，而真机只有用户的那份安装。

### B：HarnessHub 只给终端命令，用户自己运行，事后重新探测并复验

- **命令**（按官方文档，HarnessHub 在 Harness 页显示，不代跑）：
  `openclaw backup`；`openclaw gateway stop && npm install -g openclaw@2026.9.5 --allow-scripts=openclaw && openclaw plugins install deepseek && openclaw plugins install feishu && openclaw --version && openclaw doctor --fix`；核对 Doctor 的导入结果；`npm install -g openclaw@latest --allow-scripts=openclaw && openclaw doctor --fix && openclaw gateway start && openclaw node restart && openclaw gateway status --deep`；必要时 `openclaw plugins update openclaw-weixin`。
- **前置**：把 OpenClaw 的升级类型从 npm 改为“终端命令”（`catalog-channels.ts` 已有 Hermes 的 `terminal` 类型可复用）；ADR-043 的 OpenClaw 升级确认框停用或只保留只读检查。
- **点击**：0 次；用户在终端执行 5～7 条命令。
- **中断**：同 A（两次重启加插件装回的窗口），但由用户掌握时机。
- **复验**：同 A。
- **要改的代码**：`recipes.ts` 的说明与升级类型、Harness 页的命令展示。
- **代价**：与 ADR-043“由 HarnessHub 升级并重启”的用户决定相悖，需要用户同意回到“只给命令”；升级结果靠事后探测。

### C：暂不升级（只作研究期间与用户答复前的现状，不再是“默认状态”）

- **做法**：不升级；完成 M1b 里程碑的 T-OC-04（Gateway 运行状态、就绪提示与自更新状态，只读）、T-OC-06（Hub 的 /export 经 `sessions.get` 只读导出本会话转录）、T-OC-07（能力页读取 OpenClaw 的 Hooks 与插件条目）、T-OC-15（版本比较；`-N` 修订号的比较由第三批 D4 落地，轨道已定 latest）、T-OC-16（目录缓存指纹纳入认证与模型文件的身份）；在 2026.3.23-2 上用当前代码重做 T-OC-08（≤ ¥3），把 5 个 ✅ 的证据从已丢失的 `.tmp` 恢复为仓库内记录。
- **前置**：无。**点击**：0。**中断**：无。
- **代价**：ACP 桥没有思考流、实时工具流与审批中继（矩阵 6 格停在“原接口不提供”）；`mcp.*`/`plugins.*` 写入继续只读；安全与缺陷修复落后 7 个月；用户随时可能自己运行 `openclaw update` 跳到 latest——驱动按能力判断（第三批 D3），不会静默改变行为，但真实复验仍要做。
- 原第 59 行“`recipes.ts` 的说明改为‘当前版本不支持经 HarnessHub 升级到 2026.10.x，官方要求先经 2026.9.5’”的文案 2026-10-22 删除：它把上游的迁移步骤写成了版本门槛。现在的说明见文末过渡措施。

## 推荐

**路线 A，轨道 latest（点击时解析，2026-10-22 为 2026.10.5）。** 理由：

1. 用户已经决定“由 HarnessHub 升级并重启”（ADR-043），A 是在这个决定内把“不跑 Doctor”改成“由产品自己跑 Doctor”——这是官方唯一支持的跨这么大跨度的方式；B 退回命令行，C 把问题留给将来。
2. 原则把升级目标定为渠道最新版（ADR-053 决定 6）；两跳、插件装回与两次重启都要写进确认框；第一跳失败就停。
3. A 的具体形态（两跳、Doctor 改写 `openclaw.json`、两次重启 Gateway 中断微信/飞书、装回两个插件）与用户当初同意的“npm + kickstart”不同，所以仍需用户再确认一次（ADR-053“待用户决定”第 4 题）；实现放第四批。

## 过渡措施（历史：2026-10-22 第三批 D4，审批代理裁决 11；2026-11-01 由下文的实现裁决取代）

2026-10-22 至 2026-11-01，OpenClaw 的 npm 直装升级在准备阶段返回 `UNSUPPORTED_UPGRADE` 并说明：“OpenClaw 的升级由它自己的 `openclaw update` 完成（会运行 Doctor 迁移配置并重启 Gateway），HarnessHub 的 npm 直装路径不再用于 OpenClaw；路线见 ADR-052。”候选版本的 `config validate` 预演同时删除。D4 部署后用户点击升级看到的是说明，而不是校验失败。实现裁决落地后，“升级 Harness”对 OpenClaw 运行下文的顺序；ADR-044 的逐份升级路径（单独 npm 直装某一份 OpenClaw）仍拒绝，说明改走“升级 Harness”。

## 2026-11-01 实现裁决（审批代理；用户 2026-10-22 答复“由你直接升级……OpenClaw 完全由你支配”）

### 本机事实（2026-11-01 核对）

- OpenClaw 2026.3.23-2 装在 Homebrew Node 前缀的 npm 全局：包目录 `/opt/homebrew/lib/node_modules/openclaw`，入口 `/opt/homebrew/bin/openclaw → ../lib/node_modules/openclaw/openclaw.mjs`，npm `/opt/homebrew/bin/npm`（11.20.0）。npm dist-tags：latest 2026.10.9、extended-stable 2026.9.36、beta 2026.10.10-beta.5。
- launchd：`ai.openclaw.gateway` 在运行（`/opt/homebrew/opt/node/bin/node … gateway --port 18789`，runs = 1），`ai.openclaw.node` 在运行。`openclaw gateway status` 报告 “Gateway service PATH missing required dirs: ~/.nvm; run openclaw doctor”。
- 本机 2026.3.23-2 的 CLI：`openclaw update [--tag] [--dry-run] [--json] [--yes] [--timeout <秒>，默认 1200] [--no-restart] [--channel]`；`openclaw update --dry-run --json` 给出 installKind package、mode npm、tag openclaw@latest、2026.3.23-2 → 2026.10.9、downgradeRisk false 与四步动作（装包、同步插件、刷新补全、重启 gateway 并跑 doctor）；`openclaw update status --json` 却把 packageManager 判为 pnpm（deps lockfile missing）。另有 `openclaw doctor [--fix|--repair] [--yes] [--non-interactive] [--deep] [--force]`、`openclaw backup create|verify`、`openclaw gateway stop|start|status [--deep]`、`openclaw node restart`。

### 上游（docs.openclaw.ai，2026-11-01 读）

- [install/updating](https://docs.openclaw.ai/install/updating) “Upgrading very old versions”：2026 年 7 月之前的安装先升到 2026.9.5、运行它的 Doctor 迁移，再升到 latest。npm 顺序：`openclaw gateway stop && npm install -g openclaw@2026.9.5 --allow-scripts=openclaw && openclaw --version && openclaw doctor --fix`，然后 `npm install -g openclaw@latest --allow-scripts=openclaw && openclaw doctor --fix && openclaw gateway start && openclaw gateway status --deep`。直接装了太新版本的，Doctor 在改写含退役键的配置前停下并指回这一跳；退役的同文件记忆索引要先经 2026.9.7（[cli/doctor/state-migrations](https://docs.openclaw.ai/cli/doctor/state-migrations)，CHANGELOG/2026.9.7.md）。
- [cli/doctor/checks](https://docs.openclaw.ai/cli/doctor/checks)：Doctor 每次写配置都轮换 `~/.openclaw/openclaw.json.bak`（.bak.1–.bak.4）。
- npm 注册表的 `engines.node`：2026.9.5 与 2026.9.7 是 `>=24.16.0 <25 || >=26.1.0`；2026.10.6–2026.10.9 是 `>=24.22.1 <25 || >=26.12.1`。本机 Homebrew Node 2026-11-01 是 26.11.1，真机运行前由主代理升级（`brew upgrade node`）；代码对服务的 Node 不满足的那一跳阻止升级，给出这条命令。
- 2026.10.x 的 `openclaw update` 带 `--json` 输出 `UpdateRunResult`，交给受管服务助手时以退出码 75 返回（`src/infra/update-run-result.ts`、`src/cli/update-cli/update-command-handoff.ts`）；更新器只重启 gateway，不重启 `ai.openclaw.node`（[install/update-troubleshooting](https://docs.openclaw.ai/install/update-troubleshooting#headless-nodes-waiting-on-2026-9-6)）。
- [cli/backup](https://docs.openclaw.ai/cli/backup)、[install/updating/rollback-and-recovery](https://docs.openclaw.ai/install/updating/rollback-and-recovery)：`openclaw backup create --output <目录> --verify` 写出带时间戳的 .tar.gz；恢复只用 `openclaw backup restore <备份文件> --target <新目录>`，不在原地恢复。旧版本打不开新版本的数据库，“退回旧版本”只能从升级前的备份。

### 裁决

1. **路线是上游文档的显式顺序，由 HarnessHub 在 ADR-043 的“升级 Harness”里驱动；npm 安装的 OpenClaw 只有这一条代码路径。** `openclaw gateway stop` → 每一跳：`<前缀的 npm> install --global --prefix <前缀> --no-audit --no-fund --allow-scripts=openclaw --registry=https://registry.npmjs.org openclaw@<版本>`（现有的配置写保护沙箱里；前缀的 npm 用的是服务启动用的那个 Node.js，所以发布的 preinstall 核对的正是它）→ 读包目录的 `package.json` 核实版本（不运行程序：生命周期脚本可能仍待补跑）→ `openclaw doctor --fix --yes` → 最后一跳之后 `openclaw gateway start` → 恢复判定（ADR-043 第 5 条的规则，但**不 kickstart**：state running、新进程、runs ≤ 升级前 + 1、连续 5 秒不变、60 秒内在 18789 上监听；等待循环抽成 `awaitServiceRecovery`）→ `openclaw gateway status --deep` 的末尾写入任务日志（有界）→ 升级前 `ai.openclaw.node` 在运行时 `openclaw node restart` 并做同样的判定（无端口）。跳数：已装版本早于 2026.7.0（`compareReleases`）时 [2026.9.5, 目标]，否则 [目标]。不调用 2026.3.23-2 的 `openclaw update --tag`：它在本机把包管理器判为 pnpm，也不传 `--allow-scripts`，第一跳可能落到别的前缀或留下待补跑的脚本；上游对 7 月前的安装给的就是显式顺序。`openclaw update` 的分阶段准入（与退出码 75）记为将来的细化，现在不实现。2026.9.7 一跳不自动加：某一跳的 Doctor 拒绝时任务停在那一跳、带 Doctor 原话（`DOCTOR_FAILED`），已装入的版本如实记录（磁盘上是哪一跳就记哪一跳），不回滚不重试（ADR-043 第 6 条）。
2. **确认框**（`MaintenanceCheck.sequence` → `MaintenanceView` → `UpgradeDialog`）：跳 `[{version, bridge, runtimes}]`、命令原文（家目录写作 ~）、Gateway 在第一跳前停止、最后一跳后启动（期间渠道离线；HarnessHub 不 kickstart）、node 服务的重启、Doctor 改写的配置与 .bak 轮换、备份要求（`openclaw backup create --output <目录> --verify`）、插件说明（官方插件由 Doctor 按核心版本修复；第三方如 openclaw-weixin 可能要 `openclaw plugins update`）、只能从备份退回（顶层 `rollback` 为 null，确认框说明原因）。必选复选框“我已运行 openclaw backup create … 并核对了备份”放开确认按钮；同意带 `backupConfirmed: true` 随命令提交（`parseManagementInput` 只对带本机安装指纹的 Harness 升级受理；服务层只对声明了顺序的配方受理），计入命令指纹并记入任务事实；没有它的提交在创建任务之前拒绝（409 `BACKUP_CONFIRMATION_REQUIRED`）。
3. **运行环境**：每一跳的 `engines.node`（npm 注册表元数据）对照 CLI 的解释器与 Gateway、node 服务的 Node.js；不满足的跳阻止确认，并在改动前拒绝任务（`RUNTIME_INCOMPATIBLE`，指名那一跳的版本）。node 服务由这条路线重启，所以它的 Node.js 也算“随升级重启”。
4. **同意**：`ai.openclaw.gateway` 的同意沿用现状（`restartServices`）；对这条路线它表示“升级前由 OpenClaw 自己的命令停止、最后一跳后启动”。
5. **事实**：`native.hops: [{version, installed, doctor: ok|failed|skipped}]`（≤ 4）、gateway start 与 node restart 作为 `native.services` 里的 `ServiceRestartFact`、`native.backupConfirmed`、新事实 `native.configurationMigrated: ["~/.openclaw/openclaw.json"]`——这条路线里受保护配置摘要的变化是预期的，记录而不判失败；`configurationPreserved: true` 仍只表示 HarnessHub 自己没有写入。`parseManagementJob` 校验全部事实并保持 64 KiB 视图预算；不升管理库版本（事实在 `view_json` 里，v6 的读取器以外的旧构建会拒绝这些字段，与 v3 以来的做法相同）。
6. **进程**：npm 在现有的“configuration”写保护沙箱里运行（用户配置目录拒写）；`openclaw gateway stop/start/status`、`doctor --fix --yes`、`node restart` 不带那层拒写（它们要写配置与 launchd 状态），但用用户真实的家目录与 `OPENCLAW_*` 变量、以任务目录为 TMPDIR、输出有界、各有期限（doctor ≤ 1800 秒，其余 ≤ 120 秒）；任务外层期限对这条路线按每跳 3600 秒（`SEQUENCE_HOP_MS`）。所有进程经 `runManagementProcess` / `ProgramHost`，测试可替身。
7. **路线由配方声明**（`ManagementRecipe.upgradeSequence`：`bridge`、`npmFlags`、`gateway` 的 stop/start/status、`doctor`、`restarts`、`backupCommand`、`migrates`、`migrationBackups`、`rollback`），管理代码按声明执行、不按产品分支（ADR-043 决定 9）。

### 验证

- 替身（无真实运行）：`tests/integration/native-management.test.ts` 的 G011-UP10–UP16（跳的计算；命令顺序、恢复判定与事实；第二跳 Doctor 拒绝；某跳运行环境不满足；缺备份确认；Doctor 改写配置记为迁移；gateway start 后不监听），`tests/unit/management-state.test.ts` 的 G011-UP17（事实与同意的解析），`tests/browser/web.browser.ts` 的 G054-UP3（确认框、复选框、提交的同意与任务事实）。替身的 `openclaw` 把每条命令行记入轨迹文件，launchd 替身由产品的 stop/start/restart 驱动。
- 真机：由主代理在本机 Node 升到 ≥ 26.12.1、用户运行 `openclaw backup create --output <目录> --verify` 之后，在 4317 点击“升级 Harness”执行，之后做 T-OC-12（只读回合，≤ ¥5）。本记录不声称任何真实运行；结果写入 `docs/verification/`。

## 不做

- 不复制 `openclaw.json` 作备份（含渠道凭据），不代跑 `openclaw backup`（用户运行后在确认框勾选），本轮不代跑 `openclaw plugins install`。
- 不 kickstart；不调用 `openclaw update`（2026-11-01 实现裁决 1）。
- 不选 extended-stable 轨道；不按版本号门控任何功能（T-OC-11 按能力）。
- ADR-045 裁决 9 的 MCP 与插件写入：按最新版的实际行为（热重载表）决定，由 T-OC-12 在升级后的版本上真实核实后解锁，不写“这个版本”（原第 76 行“等升级后核实再解锁”的说法随 ADR-053 改写）。

## 验证（2026-10-22 研究时的计划；实际验证见“2026-11-01 实现裁决”）

- 集成：`openclaw update` 的替身输出 `UpdateRunResult`（成功、第一跳失败、第二跳失败、退出码 75 的交接）各一例；`--dry-run --json` 计划的解析；latest 的解析与 `--tag <精确版本>` 冻结，升级前目标变了就停止；2026.9.7 条件跳；每跳后的 `openclaw node restart` 与恢复判定；两跳任务的记录与“没有升级”的显示；无效样例：Doctor 拒绝退役键时任务停在第一跳，候选 `config validate` 不在路径上。过渡期：OpenClaw 的 npm 直装升级在准备阶段返回 `UNSUPPORTED_UPGRADE` 并带说明（第三批 D4 的集成测试）。
- 浏览器：确认框的两跳、插件装回、备份要求、`--accept-capabilities` 的说明、从 extended-stable 换到 latest 轨道的说明与红字说明。
- 真机：只有用户点击；按 ADR-043 第 5 条核实两次重启的恢复与端口；升级后按审批代理的条件做 T-OC-12（只读回合、不停不重启 Gateway 与 Node、`openclaw.json` 前后摘要一致），证据入库后矩阵 `installation` 改为“真实验收版本 2026.10.x”（ADR-053 决定 8）。
