# OpenClaw 2026.10.x 升级就绪（只读研究，2026-10-22）

本机 OpenClaw 2026.3.23-2（npm 全局，Homebrew 前缀；Gateway 守护进程接着微信与飞书）要不要升级、升到哪条轨道、由谁执行，由 [ADR-052](../decisions/0052-openclaw-upgrade-route.md) 给出选项。本页只记录事实：两个候选版本（latest 2026.10.5、extended-stable 2026.9.33）与本机版本的差异，逐问题给依据；查不到的写“未核实”。

## 方法与边界

- 纯只读。没有运行 `openclaw`（包括 `--version`），没有触碰用户的 Gateway 与 Node 服务，没有读 `~/.openclaw/openclaw.json` 或任何凭据。插件目录只读了 `~/.openclaw/extensions/openclaw-weixin/` 的 `package.json` 与 `openclaw.plugin.json` 中的 `name`、`version`、`openclaw.install`、`peerDependencies`、`engines`、`id`、`channels` 几个键，没有读 `configSchema` 以外的内容。
- 材料：本机包 `/opt/homebrew/lib/node_modules/openclaw`（`package.json`、`docs/`、`dist/`）；`registry.npmjs.org` 的元数据（`npm view`，缓存指到本任务的临时目录）；两个候选版本 tarball 的流式列目录与少量文件抽取（清单见文末）；GitHub `openclaw/openclaw` 的 `v2026.10.5`、`v2026.9.33` 标签源码（`src/acp/*.ts`、`src/gateway/{method-scopes,operator-scopes,device-scope-upgrade}.ts`、`src/gateway/methods/core-method-policy.ts`）与标签内文档（`docs/cli/update/how-updates-run.md`、`docs/cli/gateway/{query,service}.md`）；主代理此前抓取的 main 文档（commit 62cb03ac，2026-10-17）与 2026.10.4 包文档。引用写作 `<版本>:<路径>:<行>`。
- 任务说明里的 `oc-src/` 实际是 OpenCode（sst/opencode）源码，不是 OpenClaw，本页没有使用。

## 版本线（2026-10-22 查询）

| 项 | 本机 2026.3.23-2 | extended-stable 2026.9.33 | latest 2026.10.5 |
|---|---|---|---|
| 发布时间（npm `time`） | 2026-03-24 | 2026-10-15 | 2026-10-18 |
| `engines.node` | `>=22.16.0` | `>=24.16.0 <25 \|\| >=26.1.0` | 同左 |
| 解包大小 / 文件数（npm `dist`） | — | 389,977,999 B / 13,453 | 249,324,552 B / 13,982 |
| 生命周期脚本 | 只有 `prepack`、`prepare` | `preinstall`、`postinstall` | 同左 |
| 随包的 `dist/extensions/` 目录数 | 含 `deepseek`、`feishu` | 65，不含两者 | 67，不含两者 |

其他 dist-tag：`beta` 2026.10.10-beta.3。桥接版本 2026.9.5（2026-09-19 发布）的 `engines.node` 与两个候选相同。

## 问题 1：包、脚本与 `openclaw update`

### `files` 是否排除 deepseek 与 feishu

是，两个候选都排除。`2026.10.5:package.json` 的 `files` 有 421 条，其中 100 条 `!dist/extensions/<名>/**` 排除项，含 `!dist/extensions/deepseek/**` 与 `!dist/extensions/feishu/**`；`2026.9.33:package.json` 407 条，同样含这两条。`tar -tzf` 的完整列目录里两者都没有 `dist/extensions/deepseek` 或 `dist/extensions/feishu` 的任何条目。两者改为“官方外部插件”，由包内目录登记：`scripts/lib/official-external-provider-catalog.json`（`@openclaw/deepseek-provider`，插件 id `deepseek`，`install.minHostVersion ">=2026.6.8"`，默认从 npm 安装）与 `scripts/lib/official-external-channel-catalog.json`（`@openclaw/feishu`，`minHostVersion ">=2026.5.29"`）。两个候选的登记内容相同。

对本机的含义：用户的默认模型走 deepseek 提供方、Gateway 接着飞书，升级后这两项都要作为外部插件装回来；缺失时 Doctor、更新与 Gateway 启动不被阻止，只记一条点名安装命令的警告（`2026.10.5:docs/gateway/doctor/config-migrations.md:633-638`）。`openclaw update` 是否会按配置自动补装它们：未核实（见“未核实”第 3 条）。

### `postinstall-bundled-plugins.mjs` 做什么

`2026.10.5:scripts/postinstall-bundled-plugins.mjs`（442 行；2026.9.33 的版本相差 40 行，结构相同）：

- 按 `dist/postinstall-inventory.json` 删除上一版本残留的、内容哈希命名的 dist 文件（第 22、283-332 行），删除 `dist/extensions/*/node_modules` 这类旧依赖目录（239-251）与空目录（176-232）；扫描上限 100,000 个条目（27）。
- 清除包根的 `.openclaw-lifecycle-pending` 标记（393；标记文件随包发布，`package.json` 的 `files` 列出）。
- 只在 Bun 下安装 Bun CLI 启动器（403-417）。
- `OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL` 可关闭（21）。

它不安装任何插件，也不下载任何东西。`preinstall-package-manager-warning.mjs` 只核对包管理器与 Node 版本并打印警告（1-16 行）。

### `--ignore-scripts` 安装后 deepseek 与 feishu 能否使用

不能，但与脚本无关：两者根本不在包里。`--ignore-scripts` 只会跳过上面的清理与标记清除；残留的 `.openclaw-lifecycle-pending` 由谁消费、是否告警，未核实。官方文档写的安装命令是 `npm install -g openclaw@<版本> --allow-scripts=openclaw`（npm 12 或 11.16+；更早的 npm 省略该参数，`2026.10.5:docs/install/updating.md:82-103`）。本机 nvm 下的 npm 是 11.20.0（[升级与重启验收](../verification/upgrade-restart-2026-10-12.md)）。HarnessHub 现在两处都带 `--ignore-scripts`（`src/infrastructure/management/native.ts:193`、`:218`）。

### `openclaw update` 的流程（候选版本）

依据 `2026.10.5:docs/cli/update.md` 与 `v2026.10.5:docs/cli/update/how-updates-run.md`：

- 轨道：`stable`、`extended-stable`、`beta`、`dev`（update.md:15）。选项：`--channel <轨道>`（成功后持久化；extended-stable 只对包安装）、`--tag <dist-tag|版本|spec>`（只对本次，不能与生效中的 extended-stable 轨道同用）、`--dry-run`（不写配置、不安装、不同步插件、不重启，也不预演候选）、`--json`（输出 `UpdateRunResult`）、`--no-restart`、`--yes`、`--admission <auto|installed>`、`--timeout`（update.md:649-657）。
- 候选自治的准入：目标包先私下预演，由候选自己判断配置、数据库 schema、Node 要求与插件可用性，再激活（update.md:442-525）。
- Doctor：目标版本的 Doctor 在激活前运行（update.md:720）；更新时在候选配置校验之前先套用已知迁移（config-migrations.md:27-29）；配置无效导致 schema 预检读不到路径时拒绝并列出文件与字段，不改配置（update.md:734-737）。
- 重启：更新器自己做受管重启；对 npm 全局安装，即使 `--no-restart`，正在运行的 Gateway 也会在它的监视器发现安装被替换后自行重启（update.md:667-670）。在 LaunchAgent 内运行 `openclaw update` 会交给受管服务助手并以退出码 75 返回（how-updates-run.md:873-900）。
- 插件：“Sync plugins”一步在重启受管服务之前把插件同步到当前轨道；stable 与 beta 用 npm 或 ClawHub（how-updates-run.md:1196-1197）。
- 是否重写 launchd plist：更新后核对 LaunchAgent 是否被 launchd 监管、回环端口是否健康；plist 已装但未被监管时重新 bootstrap；“保留定义时，原生重启/bootstrap 不做文件修复；激活或健康检查失败不会触发事后的 plist 重写”（how-updates-run.md:1039-1049）。`gateway restart` 保留已安装的服务定义（`v2026.10.5:docs/cli/gateway/service.md:27`）。什么条件下会刷新服务定义（运行时不匹配时的“Update refresh”，service.md:160-161）：未核实。

本机 2026.3.23-2 的 `openclaw update`（将要执行第一跳的那份）：`docs/cli/update.md` 列出 `--tag`、`--dry-run`、`--json`、`--no-restart`、`--channel stable|beta|dev`、`--timeout`；npm 安装走“包管理器流程”，装完运行 doctor 并重启 Gateway（`docs/install/updating.md` “Recommended”一节）。[ADR-043](../decisions/0043-upgrade-with-running-programs.md) 已核对它的重启只是 `launchctl kickstart -k`。

### 升级跨度：必须经过 2026.9.5

`2026.10.5:docs/install/updating.md` “Upgrading very old versions”：2026 年 7 月之前的安装要先升到 **2026.9.5**，运行它的 Doctor 迁移，再升到 latest；已经直接装了最新版的，Doctor 会在重写含退役键的配置之前停下并指回这条桥。保留策略：只支持 2026-07-01 及之后发布版本写出的格式（config-migrations.md “Retention policy”）。本机 2026.3.23-2 属于“7 月之前”。文档给的终端步骤：`openclaw gateway stop && npm install -g openclaw@2026.9.5 --allow-scripts=openclaw && openclaw --version && openclaw doctor --fix`，核对后 `npm install -g openclaw@latest --allow-scripts=openclaw && openclaw doctor --fix && openclaw gateway start && openclaw gateway status --deep`。

## 问题 2：配置迁移与 `config validate`

- 2026-10-17 用户点击升级时，候选版本的 `config validate` 没有通过，涉及 `meta`、`messages`、`commands`、`gateway.tailscale`、`gateway.nodes`（[逐份升级验收](../verification/installation-upgrade-2026-10-17.md):59）。
- 候选文档中对应的迁移（两个候选相同）：`messages.tts` → 顶层 `tts`，`messages.tts.<提供方>` → `tts.providers.<提供方>`（`2026.9.33:docs/gateway/doctor/config-migrations.md:353-355`）；`meta.lastTouchedAt` → 共享 SQLite 状态（:360）；`gateway.nodes.allowCommands/denyCommands` → `gateway.nodes.commands.allow/deny`（:391-392）；`gateway.tailscale.resetOnExit` 退役（:252）。2026.10.5 的同一文件在 828-836 行有相同的迁移样例。`commands.ownerDisplay` 的移除只出现在 main（62cb03ac）的文档里，两个候选包内文档都没有这一句——候选版本的 Doctor 能否清掉 `commands` 下的这个键：未核实。
- 严格校验：“OpenClaw 只接受完全符合 schema 的配置。未知键、类型错误或非法值会让 Gateway **拒绝启动**。启动 Gateway 前先运行 `openclaw doctor --fix` 修复旧键”（`2026.10.5:docs/gateway/configuration.md:80-81`）。所以：只装新版本、不跑 Doctor、直接重启（HarnessHub 现在的 ADR-043 路径），Gateway 会起不来，渠道中断直到有人运行 `openclaw doctor --fix`。
- Doctor 直接拒绝的退役输入（要求先经 2026.9.5）包括 `channels.feishu.accounts.<id>.botName`、`messages.queue.mode` 的 `queue`/`steer-backlog`/`steer+backlog`、顶层 `heartbeat`、`routing.allowFrom`、`channels.webchat`、非空 `plugins.installs` 等（`2026.10.5:docs/gateway/doctor/config-migrations.md:242-262`）。本机配置是否含这些键：未核实（没有读配置）。
- 渠道配置需修复时：候选的 Doctor 在私有副本上逐项修复，某项抛错就保留该项之前的配置并继续（config-migrations.md:13-17）；缺失的插件不阻止启动（:633-638）；配置本身非法则拒绝启动（上一条）。
- 热重载对无效编辑的处理：无效编辑保留上一份可用的运行时；重启读的是同一份配置，所以停掉后要先 `openclaw doctor --fix` 再重启（`2026.10.5:docs/gateway/configuration/hot-reload.md:110-136`）。

## 问题 3：ACP 桥

两个候选的 `docs/cli/acp.md` 逐字相同（diff 为空）；`src/acp/` 的 15 个文件在两个标签之间都有改动（例如 `translator.session-lifecycle.ts` 124 行、`translator.agent-events.ts` 103 行、`translator.prompt-stream.ts` 70 行，2026.10.5 把公共部分挪进 `@openclaw/acp-core`），文档描述的行为一致。下表的“行”指 `v2026.10.5:src/acp/<文件>`。

| 项 | 候选版本的事实 | 本机 2026.3.23-2 |
|---|---|---|
| `resumeSession` / `closeSession` | 已实现：resume 把 ACP 会话重新绑定到已有 Gateway 会话键，不回放历史；close 取消桥内工作并释放桥状态（acp.md 兼容表；`translator.session-lifecycle.ts:216-254`）。给了键且 `requireExisting` 时经 `sessions.resolve` 核对（`session-mapper.ts:27-55`） | 兼容表没有这两项；本机 dist 的 `acp-runtime` 不含对应方法名（grep） |
| `loadSession` | 部分：桥建的会话回放 ACP 事件账本，旧会话退回文本转录（acp.md） | 由 [ADR-027](../decisions/0027-openclaw-transcript-reconciliation.md) 对账补足 |
| `listSessions` 与 lineage `_meta` | 已实现：列表与会话信息快照的 `_meta` 带父子 lineage（`translator.session-state.ts:2`、`:46-64`） | 无 |
| 思考流 | 已实现：`thinking` 块映射为 `agent_thought_chunk`，`text` 为 `agent_message_chunk`（`translator.prompt-stream.ts:510-513`） | 本机 `acp-runtime-BHZj-SLU.js` 没有 `agent_thought_chunk`（grep 为 0），思考由转录对账补记 |
| 工具流 | 部分：`tool_call`/`tool_call_update` 含原始输入输出与尽力给出的文件位置（acp.md；`translator.agent-events.ts:110`） | 由转录对账补记 |
| 审批中继 | 部分：本回合内 Gateway 的 exec 审批经 `session/request_permission` 中继，选项 allow-once / allow-always / deny（`permission-relay.ts:25-30`；`translator.agent-events.ts:57`、`:144`）；其他会话的审批忽略 | 本机 `acp-runtime` 没有 `request_permission`（grep 为 0） |
| 默认键前缀 | `acp-bridge:<uuid>`（`translator.session-lifecycle.ts:67`）；这类会话是“合成、可丢弃”的，受过期清理（acp.md “Session mapping”） | HarnessHub 用 `agent:<agent>:harnesshub:<uuid>`（`src/adapters/control/openclaw.ts:102`），不带该前缀 |
| `_meta` 受理的键 | `sessionKey`（别名 `session`、`key`）、`sessionLabel`（`label`）、`resetSession`（`reset`）、`requireExistingSession`（`requireExisting`）、`prefixCwd`（`session-mapper.ts:13-25`；2026.9.33 同一组键） | `acp-cli-BQ740PFm.js` 含 `requireExistingSession`（grep） |
| 每会话 `mcpServers` | 桥模式拒绝（acp.md） | 未核实 |
| `gateway call` 的 operator scope | acp.md:136（两个候选）：“`openclaw gateway call sessions.list` 这条 CLI 路径可能请求一次 fresh-token 的 operator scope 升级”。`src/gateway/method-scopes.ts:45-53` 给 CLI/operator 客户端的默认 scope 集合是 admin、read、write、approvals、questions、pairing、talk-secrets；`sessions.patch` 是动态方法，所需 scope 为 `resolveDynamicSessionMutationRequiredScope(method, params) ?? operator.write`（:157-165）；未分类方法默认拒绝（:187-191）。`models.list`、`sessions.list`、`chat.history`、`skills.status`、`tools.catalog`、`sessions.get` 的静态 scope 来自生成的核心方法元数据（`core-method-policy.ts:62`），本轮没有抓到那份表：未核实。scope 升级流程在 `device-scope-upgrade.ts`（配对设备的升级等待，终态宽限 15 秒） | HarnessHub 经 `openclaw gateway call` 调用这 7 个方法（`openclaw.ts:14`、`:108`） |

## 问题 4：热重载、会话维护、hooks 与插件读法

### 热重载表

两个候选的表相同（`2026.9.33:docs/gateway/configuration/hot-reload.md:117-144`，`2026.10.5:…:161-188`）：

| 类别 | 键 | 需要重启 Gateway？ |
|---|---|---|
| Tools & media | `tools`、`skills`、`mcp`（Apps 监听器设置除外）、`audio`、`talk`、`tts`… | 否 |
| Plugin config | `plugins.entries.*`、`plugins.allow`、`plugins.deny`、`plugins.enabled`、`plugins.slots`、`plugins.load`、旧的 `plugins.installs` | 否（默认重载插件运行时） |
| Automation | `hooks`、`cron`、`agents.defaults.heartbeat` | 否（重载所属子系统） |
| Gateway server | 其他 `gateway.*`（端口、绑定、认证模式、tailscale、TLS） | **是** |
| Infrastructure | 其他 `discovery`、`browser`，MCP Apps 监听器设置，`secrets.egressProxy` | **是** |

没有匹配到规则的路径默认重启（2026.10.5:118-121）；`hot`、`restart` 两种模式已退役，`doctor --fix` 映射为 `hybrid`（:104）。本机 2026.3.23-2 的表（`docs/gateway/configuration.md:459-475`）把 `discovery`、`canvasHost`、`plugins` 整个列为需要重启，与 HarnessHub 的 `RESTART_KEYS`（`src/infrastructure/capabilities/changes.ts:1055`）和 [ADR-045](../decisions/0045-unified-capability-management.md) 裁决 9 一致。升级后，改 `mcp.*` 与 `plugins.*` 不再重启 Gateway——但这是文档，解锁写入仍按审批代理的条件在真实版本上核实。

### 会话维护默认值

`session.maintenance`：`mode: "enforce"`、`pruneAfter: "30d"`、`archiveDashboardAfter: "7d"`、`maxEntries: 5000`、`preserveRecent: false`（`2026.10.5:docs/concepts/session.md:304-320`；2026.9.33 在 253-270 行，相同）。超过上限时归档最老的普通会话；cron、hooks、heartbeat、ACP、子 Agent 这类合成会话可被直接删除（:346-348）。HarnessHub 的 `agent:…:harnesshub:` 键不带 `acp-bridge:` 前缀，按什么类别清理：未核实。

### Hooks 的三类来源

`2026.10.5:docs/cli/hooks.md:53-54`：发现范围是随包 hooks、活动插件的 hooks、托管 hooks、额外目录与所选工作区；JSON 输出根对象含 `workspaceDir`、`managedHooksDir`、`hooks`（:79），每条带 `managedByPlugin`、`enabledByConfig`、`requirementsSatisfied`、`loadable`、`blockedReason`（:83-90）。工作区 hooks 需显式开启，随包与托管的不需要（`docs/automation/hooks.md:80-81`）；开关保存在全局的 `hooks.internal.entries.<hookKey>`（:109）；插件托管的显示为 `plugin:<id>`（:117）。HarnessHub 现在只读 `~/.openclaw/hooks` 目录（`src/adapters/capability-reads.ts:263`）。

### 插件条目

`2026.10.5:docs/gateway/config-extensions.md:205-221`：插件从 `~/.openclaw/extensions`、`<workspace>/.openclaw/extensions` 以及 `plugins.load.paths` 列出的文件或目录加载；扩展根目录下顶层的 `.js/.mjs/.ts` 被忽略；`plugins.allow`（只加载列出的）、`plugins.deny` 优先；`plugins.entries.<id>.{apiKey,env,hooks.*,subagent.*,llm.*,config}`。`plugins.installs` 为旧键：非空或畸形时 Doctor 拒绝，空对象由 `doctor --fix` 删除（config-migrations.md）。技能：`skills.load.extraDirs`（最低优先级）、`allowBundled`（config-extensions.md:142、162-163）。

## 问题 5：openclaw-weixin 2.0.1

- 本机插件包 `@tencent-weixin/openclaw-weixin` 2.0.1：`openclaw.install.minHostVersion ">=2026.3.22"`，`peerDependencies.openclaw ">=2026.3.22"`，`engines.node ">=22"`；`openclaw.plugin.json` 只有 `id`（`openclaw-weixin`）、`version`（2.0.0）、`channels`、`configSchema` 四个键。npm 上 2.0.1 的元数据相同。
- `minHostVersion` 是 semver 区间，2026.9.33 与 2026.10.5 都满足；本机 2026.3.23-2 的 `dist/installs-Qst5vOrV.js` 在安装时核对 `packageMetadata.install.minHostVersion`。但“能加载”不等于“能工作”：插件运行时 API 从 2026.3 到 2026.10 的变化（例如 `OpenClawPluginDefinition.kind` 2026-07-25 弃用、2026-10-01 为移除关口，`2026.10.5:docs/plugins/manifest.md:433`）会不会影响 2.0.1，未核实。
- 候选包的渠道目录登记的是 `@tencent-weixin/openclaw-weixin@2.4.8`（source `external`，带 `expectedIntegrity`，`minHostVersion ">=2026.5.12"`）。npm 上该包最新 2.4.10（2026-10-11）；2.4.6 起要求宿主 `>=2026.5.12`。另有一个不带作用域的 `openclaw-weixin` 包（2.4.6～3.3.1），与本机安装的不是同一个包。
- `openclaw update` 不会升级它：第三方包、本地、Git、marketplace 与自定义 ClawHub 来源保留原选择器，只有 OpenClaw 自有的 npm 包与官方 ClawHub 插件恢复自动更新（`2026.10.5:docs/cli/plugins/uninstall-and-update.md:115-117`）。本机这份是以哪种来源记录的（npm、路径还是 Git）：未核实（安装记录在配置或插件索引里，没有读）。

## 问题 6：Node

两个候选与桥接版本 2026.9.5 的 `engines.node` 都是 `>=24.16.0 <25 || >=26.1.0`。本机：PATH 上的 Node 是 nvm 的 26.11.1，`ai.openclaw.gateway` 与 `ai.openclaw.node` 两个 launchd 服务按 plist 用 `/opt/homebrew/opt/node/bin/node`，已升到 26.11.1（[升级与重启验收](../verification/upgrade-restart-2026-10-12.md):98-100、:111-130）。要求已满足。

## 未核实

1. 候选版本中 `models.list`、`sessions.list`、`sessions.get`、`chat.history`、`skills.status`、`tools.catalog` 的静态 operator scope，以及本机 token 走 `gateway call` 时是否会触发 scope 升级等待。
2. `commands.ownerDisplay` 是否由候选版本的 Doctor 移除（只在 main 文档里见到）。
3. `openclaw update` 的“Sync plugins”是否会按配置里的 `channels.feishu` 与 deepseek 提供方自动安装两个官方外部插件，还是只给警告。
4. 本机配置是否含 Doctor 直接拒绝的退役键（需要 2026.9.5 这一跳才能修）；本机 `plugins.installs` 是否非空。
5. `--ignore-scripts` 安装后残留的 `.openclaw-lifecycle-pending` 标记由谁消费、是否告警。
6. 更新器在什么条件下刷新（重写）launchd 服务定义。
7. openclaw-weixin 2.0.1 在 2026.10.x 宿主上的运行时兼容性，以及它的安装来源记录。
8. HarnessHub 的 `agent:…:harnesshub:` 会话键在新版会话维护中算普通会话还是合成会话。
9. 升级后 HarnessHub 自己的 `launchctl kickstart -k`（ADR-043）与新版 Gateway 的自重启是否会叠加。

## 对 HarnessHub 的直接影响

- 现在的升级路径（装进临时目录跑 `config validate`，再 `npm install --ignore-scripts`，再 kickstart，不跑 doctor）对 2026.10.x 不成立：校验会一直失败；绕过校验直接装会让 Gateway 拒绝启动。官方路径是先到 2026.9.5 跑 Doctor，再到目标版本。
- extended-stable 与 latest 的 ACP 桥能力相同；差别在发布日期、包体积与 `src/acp` 的重构幅度。
- deepseek 提供方与飞书渠道升级后要作为外部插件安装。
- 选项与代价见 [ADR-052](../decisions/0052-openclaw-upgrade-route.md)。

## 本轮用过的命令

本机只读：`python3 -I` 读 `/opt/homebrew/lib/node_modules/openclaw/package.json`；`ls`/`cat`/`grep` 读该包的 `docs/cli/update.md`、`docs/install/updating.md`、`docs/gateway/configuration.md`、`dist/` 文件名与 `acp-*.js`、`installs-*.js` 的字符串；`ls` 与键名受限的 `python3 -I` 读 `~/.openclaw/extensions/openclaw-weixin/{package.json,openclaw.plugin.json}`。

网络（全部只读 HTTPS）：

| 目标 | 内容 |
|---|---|
| `registry.npmjs.org` | `npm view openclaw dist-tags`；`npm view openclaw@2026.10.5` 与 `@2026.9.33` 的 `version engines files scripts dist`；`npm view openclaw time`；`npm view openclaw@2026.9.5 version engines`；`npm view openclaw-weixin`；`npm view @openclaw/weixin`（404）；`npm view @tencent-weixin/openclaw-weixin` 的 `versions` 与 2.0.1、2.4.6、3.0.0（404）、3.3.1（404）的元数据 |
| `registry.npmjs.org/openclaw/-/openclaw-2026.10.5.tgz` | 流式 `tar -tzf` 列目录一次；流式抽取一次（清单见下） |
| `registry.npmjs.org/openclaw/-/openclaw-2026.9.33.tgz` | 同上 |
| `api.github.com/repos/openclaw/openclaw` | `git/ref/tags/v2026.10.5`、`v2026.9.33`；`contents/src/acp?ref=v2026.10.5`、`contents/scripts?ref=v2026.10.5`、`contents/src/cli/gateway-cli?ref=v2026.10.5`、`contents/src/gateway?ref=v2026.10.5` |
| `raw.githubusercontent.com/openclaw/openclaw/v2026.10.5` 与 `v2026.9.33` | `src/acp/` 下 15 个文件各两份：`server.ts`、`translator.ts`、`translator.session-lifecycle.ts`、`translator.session-list.ts`、`translator.session-state.ts`、`session-mapper.ts`、`persistent-bindings.types.ts`、`permission-relay.ts`、`translator.agent-events.ts`、`event-mapper.ts`、`policy.ts`、`commands.ts`、`types.ts`、`translator.session-updates.ts`、`translator.prompt-stream.ts` |
| `raw.githubusercontent.com/openclaw/openclaw/v2026.10.5` | `src/gateway/method-scopes.ts`、`src/gateway/operator-scopes.ts`、`src/gateway/device-scope-upgrade.ts`、`src/gateway/methods/core-method-policy.ts`、`docs/cli/update/how-updates-run.md`、`docs/cli/gateway/query.md`、`docs/cli/gateway/service.md` |

从两个 tarball 流式抽取的文件（只抽取、没有运行）：`package/package.json`、`package/scripts/postinstall-bundled-plugins.mjs`、`package/scripts/preinstall-package-manager-warning.mjs`、`package/scripts/lib/package-lifecycle-marker.mjs`、`package/scripts/lib/official-external-{channel,plugin,provider}-catalog.json`、`package/docs/cli/{update,doctor,gateway,acp,hooks,plugins}.md`、`package/docs/cli/plugins/uninstall-and-update.md`、`package/docs/install/updating.md`、`package/docs/gateway/doctor.md`、`package/docs/gateway/doctor/config-migrations.md`、`package/docs/gateway/configuration.md`、`package/docs/gateway/configuration/hot-reload.md`、`package/docs/gateway/config-extensions.md`、`package/docs/automation/hooks.md`、`package/docs/plugins/manifest.md`、`package/docs/tools/plugin.md`、`package/docs/concepts/session.md`、`package/dist/update-execution.runtime.js`、`package/dist/update-triage-{Cg5qhlnq,NRMm3Jqo}.js`、`package/dist/update-run-notice.runtime.js`、`package/dist/update-command-service-recovery-D5YncPuW.js`、`package/dist/doctor-core-checks.runtime.js`，以及只在 2026.10.5 有的 `package/dist/claws-update-cli.runtime.js`。两份合计 1.7 MB（`update-execution.runtime.js` 只是 57 字节的转发桩，真正的更新逻辑在哈希命名的分块里，没有再抽）。临时目录总量 23 MB，研究结束后删除。
