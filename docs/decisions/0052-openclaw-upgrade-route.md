# ADR-052：OpenClaw 的升级路线与轨道

状态：proposed，2026-10-22（第二批 C6 的只读研究草案；同日按 [ADR-053](0053-latest-version-baseline.md) 修订——轨道由原则定为 latest，路线 A 保留为推荐并等用户确认，流程细节按研究改写；用户答复后由主代理改 accepted。没有代码改动；本批的过渡措施见文末）。事实见 [OpenClaw 2026.10.x 升级就绪](../research/openclaw-2026.10-upgrade-readiness-2026-10-22.md)与 ADR-053“研究结论摘要”。依据 [ADR-043](0043-upgrade-with-running-programs.md)、[ADR-044](0044-macos-official-channels.md)、[ADR-045](0045-unified-capability-management.md) 裁决 9（已按 ADR-053 修订）、[ADR-048](0048-harness-scope-and-workbuddy.md) 与 ADR-053。

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
- **T-OC-11 的处置**：原“2026.10.x 适配按版本门控，旧版本行为不变”撤销（ADR-053“已撤销的计划”），改为按 ACP 桥实际报告的能力判断——实时工具流有则去重、审批中继有则接、思考流有则不再从转录补；名册、设置回读、模型可用性与 fork 同理。这部分不依赖升级完成，第三批 D3 已按能力落地（协议测试在 `tests/protocol/openclaw.test.ts`），升级后在真实网关上复验。
- **前置**：ADR-043 的确认框改写；用户同意“HarnessHub 运行 `openclaw update`，它会跑 Doctor 迁移你的配置并重启 Gateway 两次”。
- **点击**：2 次确认（两跳各一次；失败即停，不自动进入下一跳、不回滚、不重试），加完成页上插件命令的用户自行执行（若预检第 2 项核实为不会自动补装）。
- **中断**：两次 Gateway 重启（各几十秒）；第二跳之后到装回 deepseek 与飞书插件之间，默认模型与飞书不可用；微信取决于 2.0.1 的兼容性（未核实）。
- **复验**：T-OC-08（2026.3.23-2 上的驱动小修与真实复验）的 14 格有真实证据的能力加上 6 格原先“原接口不提供”的（思考流、工具流、审批中继等），约 25～35 个只读回合，deepseek-chat 每回合约 ¥0.01～0.05，合计 ¥1～2，上限 ¥5。
- **要改的代码**（第四批，在第三批 D1、D4 合并之后，因为与 `service.ts`、`UpgradeDialog.tsx` 重叠）：
  - `src/adapters/management/recipes.ts` 的 `upgradeNotes`：“HarnessHub 不运行 openclaw doctor，也不迁移你的配置”改为“由 `openclaw update` 运行 Doctor 迁移”，并加两跳、插件装回、`openclaw backup`、`--accept-capabilities` 与 latest 轨道的说明；服务声明不变。
  - `src/infrastructure/management/native.ts`：OpenClaw 的“临时目录 + `config validate`”预演已在第三批 D4 删除（过渡措施见文末）；改为 `openclaw update --dry-run --json` 的计划读取；`execute` 新增 `native-update` 一类，运行 `openclaw update …`、解析 `UpdateRunResult`；保留的 npm 直装路径对 OpenClaw 不再使用。
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

- **做法**：不升级；完成 M1b 里程碑的 T-OC-04（Gateway 运行状态、就绪提示与自更新状态，只读）、T-OC-06（Hub 的 /export 经 `sessions.get` 只读导出本会话转录）、T-OC-07（能力页读取 OpenClaw 的 Hooks 与插件条目）、T-OC-15（版本比较；`-N` 修订号的比较已由第三批 D4 落地，轨道已定 latest）、T-OC-16（目录缓存指纹纳入认证与模型文件的身份）；在 2026.3.23-2 上用当前代码重做 T-OC-08（≤ ¥3），把 5 个 ✅ 的证据从已丢失的 `.tmp` 恢复为仓库内记录。
- **前置**：无。**点击**：0。**中断**：无。
- **代价**：ACP 桥没有思考流、实时工具流与审批中继（矩阵 6 格停在“原接口不提供”）；`mcp.*`/`plugins.*` 写入继续只读；安全与缺陷修复落后 7 个月；用户随时可能自己运行 `openclaw update` 跳到 latest——驱动已按能力判断（第三批 D3），不会静默改变行为，但真实复验仍要做。
- 原第 59 行“`recipes.ts` 的说明改为‘当前版本不支持经 HarnessHub 升级到 2026.10.x，官方要求先经 2026.9.5’”的文案 2026-10-22 删除：它把上游的迁移步骤写成了版本门槛。现在的说明见文末过渡措施。

## 推荐

**路线 A，轨道 latest（点击时解析，2026-10-22 为 2026.10.5）。** 理由：

1. 用户已经决定“由 HarnessHub 升级并重启”（ADR-043），A 是在这个决定内把“不跑 Doctor”改成“由产品自己跑 Doctor”——这是官方唯一支持的跨这么大跨度的方式；B 退回命令行，C 把问题留给将来。
2. 原则把升级目标定为渠道最新版（ADR-053 决定 6）；两跳、插件装回与两次重启都要写进确认框；第一跳失败就停。
3. A 的具体形态（两跳、Doctor 改写 `openclaw.json`、两次重启 Gateway 中断微信/飞书、装回两个插件）与用户当初同意的“npm + kickstart”不同，所以仍需用户再确认一次（ADR-053“待用户决定”第 4 题）；实现放第四批。

## 过渡措施（第三批 D4，审批代理裁决 11）

在路线 A 落地之前，OpenClaw 的 npm 直装升级在准备阶段返回 `UNSUPPORTED_UPGRADE` 并说明：“OpenClaw 的升级由它自己的 `openclaw update` 完成（会运行 Doctor 迁移配置并重启 Gateway），HarnessHub 的 npm 直装路径不再用于 OpenClaw；路线见 ADR-052。”候选版本的 `config validate` 预演删除。用户现在点击升级会看到说明，而不是校验失败；第四批把 `native-update` 接上后放开。

## 不做

- 不复制 `openclaw.json` 作备份（含渠道凭据），不代跑 `openclaw backup`（本轮也不代跑 `openclaw plugins install`，预检第 2 项核实后再定），不在 `openclaw update` 之外再 kickstart。
- 不选 extended-stable 轨道；不按版本号门控任何功能（T-OC-11 按能力）。
- ADR-045 裁决 9 的 MCP 与插件写入：按最新版的实际行为（热重载表）决定，由 T-OC-12 在升级后的版本上真实核实后解锁，不写“这个版本”（原第 76 行“等升级后核实再解锁”的说法随 ADR-053 改写）。

## 验证（选定后）

- 集成：`openclaw update` 的替身输出 `UpdateRunResult`（成功、第一跳失败、第二跳失败、退出码 75 的交接）各一例；`--dry-run --json` 计划的解析；latest 的解析与 `--tag <精确版本>` 冻结，升级前目标变了即停止；2026.9.7 条件跳；每跳后的 `openclaw node restart` 与恢复判定；两跳任务的记录与“没有升级”的显示；无效样例：Doctor 拒绝退役键时任务停在第一跳，候选 `config validate` 已不在路径上。过渡期：OpenClaw 的 npm 直装升级在准备阶段返回 `UNSUPPORTED_UPGRADE` 并带说明（第三批 D4 的集成测试）。
- 浏览器：确认框的两跳、插件装回、备份要求、`--accept-capabilities` 的说明、从 extended-stable 换到 latest 轨道的说明与红字说明。
- 真机：只有用户点击；按 ADR-043 第 5 条核实两次重启的恢复与端口；升级后按审批代理的条件做 T-OC-12（只读回合、不停不重启 Gateway 与 Node、`openclaw.json` 前后摘要一致），证据入库后矩阵 `installation` 改为“真实验收版本 2026.10.x”（ADR-053 决定 8）。
