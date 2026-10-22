# ADR-053：按各 Harness 的最新正式版适配，版本只作工程证据

状态：accepted，2026-10-22。方向由用户决定（原话：“接入的harnesshub不应该限定版本才能接入呀，我们实际也不知道用户装的是什么版本的，默认都按照最新版”）；决定正文由总指挥（Fable 5.1）起草，三项产品取舍与一条例外由用户授权的审批代理裁决（见“审批代理的裁决”）。取代 [ADR-038](0038-verified-version-hint.md) 全文；修订 [ADR-039](0039-continue-in-the-original-program.md) 决定 1、[ADR-031](0031-hermes-and-deepseek-harness.md) 第 16/45 行、[ADR-034](0034-codex-plan-mode.md) 第 3/14/37 行、[ADR-035](0035-attention-and-request-deadlines.md) 第 31 行、[ADR-036](0036-approval-wait-budget.md) 第 11 行、[ADR-043](0043-upgrade-with-running-programs.md) 第 26–27 行、[ADR-044](0044-macos-official-channels.md) 第 122/147 行、[ADR-045](0045-unified-capability-management.md) 第 40 行与裁决 9 的“按版本区间留位”、[ADR-046](0046-harness-focus-hardening.md) 第 1/5 项、[ADR-048](0048-harness-scope-and-workbuddy.md) 决定 3/4/5 与完成定义第 4 层、[ADR-050](0050-harness-tiers-and-on-demand-refresh.md) 第 30 行、[ADR-051](0051-hermes-upgrade-route.md) 第 8 条与 A1、[ADR-052](0052-openclaw-upgrade-route.md) 的轨道选择与 T-OC-11（行号都是修订前 f0f9b89 上的位置）。逐条处置见文末“对已有 ADR 的修订一览”。

## 背景

### 用户的原则与它要解决的问题

- 2026-10-21 用户把范围收到七个焦点 Harness 并要求“做精”（[ADR-046](0046-harness-focus-hardening.md)、[ADR-048](0048-harness-scope-and-workbuddy.md)）。2026-10-22 用户补充上面的原则：接入不限定版本，默认按最新版适配。
- 此前的做法把版本当作判断条件：
  - [ADR-038](0038-verified-version-hint.md) 的 `VERIFIED_VERSIONS` 为每个 Harness 记一个真实验证区间，不在区间内就在选择器、列表、欢迎页、详情与确认框里提示“未经验证的版本”；读表另有一个 semver 区间，区间外在能力页标“未核实”。Claude Code 每周发版、Codex 每周发版、dsh 的 npm latest 是预发布版，所以用户日常使用的版本几乎总被标上提示：2026-10-22 这天本机六家的渠道最新版（见下表）全部在区间之外。
  - 版本号还直接开关功能：Codex 协作模式只在 userAgent 版本 ≥ 0.162.1 时提供；OpenCode 的 `/compact` 只在 1.18.x 补入，升到 1.19.3 就会失去；续接命令只对已验证版本给出，为了拿到判断，每次读续接命令都要完整扫描一次本机。
  - 几份记录把基线钉在旧版本上，或者计划把提示升级成拒绝：[ADR-034](0034-codex-plan-mode.md) 第 37 行“计划模式按已验证区间门控”、[ADR-051](0051-hermes-upgrade-route.md) 第 8 条“Hermes ≥ 0.22.3 拒绝建会话”与 A1“钉住 v0.22.2 并不许再运行 `hermes update`”、[ADR-052](0052-openclaw-upgrade-route.md) 的 T-OC-11“按版本门控”与 extended-stable 轨道、[ADR-048](0048-harness-scope-and-workbuddy.md) 决定 3 的“页面触发冒烟，通过才扩区间”。
- 这些机制维护成本高（每次真实验收都要在同一提交里改表、矩阵、目录包、读表并通过四处对账），而且与用户的体验相反：用户装的是渠道最新版，却被告知“未经验证”。

### 2026-10-22 本机版本与渠道最新正式版对照

| Harness | 本机（只读文件核对，未运行程序） | 渠道最新正式版（2026-10-22） | 来源 |
|---|---|---|---|
| Claude Code | 2.1.306（nvm 的 npm 全局，当前使用；Homebrew Node 前缀下另有 2.1.302）+ 适配器 claude-agent-acp 0.89.1（Homebrew Node 的 npm 全局） | 2.1.307（npm latest，2026-10-21）+ claude-agent-acp 0.94.0（npm latest，2026-10-19；ACP 注册表同） | npm dist-tags、CHANGELOG、claude-agent-acp v0.90.0～v0.94.0 release notes 与两版包内 dist 逐文件比对 |
| Codex | 0.162.1（Homebrew cask） | 0.163.0（npm latest；GitHub rust-v0.163.0，2026-10-15；alpha 已到 0.164.0-alpha.10） | npm 外壳包、两个 tag 的源码树与 app-server 协议导出比对 |
| OpenCode | 1.18.35（anomalyco/tap 的 Homebrew formula） | OpenCode 1 线 1.19.3（npm opencode-ai latest、anomalyco/tap/opencode、ACP 注册表、GitHub Latest release，2026-10-16）。厂商主线已是 OpenCode 2（2.1.2：npm @opencode/cli、Homebrew Core 的 opencode、官网首页安装命令），同一个 `opencode` 命令、不能并存、配置写法与插件 API 不同 | npm 两个包的 dist-tags、v1.18.35…v1.19.3 compare、v2.1.2 源码与文档 |
| DeepSeek Harness（dsh） | 0.2.0-rc.2（npm 全局，nvm 前缀） | 0.2.1-rc.2（npm latest，2026-10-17 发布） | npm dist-tags、两版全部子包只读解包比对、GitHub release notes |
| Hermes Agent | 0.12.0（官方脚本 `~/.hermes/hermes-agent`，main 检出 a0556b8，2026-05-06） | v0.22.4（GitHub release 2026-10-21，4d04303） | release notes、v0.22.4 源码与文档、v0.22.3…v0.22.4 compare |
| OpenClaw | 2026.3.23-2（npm 全局，Homebrew 前缀；Gateway 守护进程接着微信与飞书） | 2026.10.5（npm latest；extended-stable 2026.9.33 不再作为选择依据，见决定 6 与 ADR-052 修订） | npm 包与元数据、GitHub v2026.3.24…v2026.10.5 release notes、[升级就绪研究](../research/openclaw-2026.10-upgrade-readiness-2026-10-22.md) |
| WorkBuddy | 未接入（ADR-048 决定 2，M4） | — | — |

研究只读了包内文件、源码、CHANGELOG、release notes 与官方文档，没有运行任何 Harness 程序，也没有触碰用户的 OpenClaw 与 Hermes 网关；结论在真实验收前都是“源码可定”而不是“真实通过”。Hermes 与 OpenClaw 的研究记录在 [docs/research/hermes-upgrade-readiness-2026-10-22.md](../research/hermes-upgrade-readiness-2026-10-22.md) 与 [docs/research/openclaw-2026.10-upgrade-readiness-2026-10-22.md](../research/openclaw-2026.10-upgrade-readiness-2026-10-22.md)；其余四家的结论只在本记录里摘要。

### 研究结论摘要（本机版本 → 最新正式版）

- **Claude Code 2.1.306 + claude-agent-acp 0.89.1 → 2.1.307 + 0.94.0。** 0.94.0 对未声明 subagents、plan、AIR 的 ACP v1 客户端保持兼容：initialize 读取的字段、会话方法、更新种类、stopReason、用量、审批与提问形状都不变；Hub 自带 JSON-RPC 客户端，ACP SDK 2.0.0 的迁移与它无关。变化的是：0.92.0 起每回合多一次 HarnessHub 用不到的预测请求（`promptSuggestions`）；0.94.0 的命令目录出现 `/remote-control`；`session/fork` 现在会启动分支会话（多一次 CLI 启动），0.90.0 起 REMOTE_ERROR 可能发生在副本写出之后；原程序撤回仍打开的请求时发 `$/cancel_request`；取消路径在 `cancelled` 响应前关闭工具调用；CLI 的 `auth status` 新报 `projectsDirectory`。续接命令 2.1.307 仍有 `-r/--resume` 与 `-p`。未验证：真实组合行为、fork 是否超出 Hub 的超时、预测请求是否仍计费、本机 nvm 下的安装是否已自更新。
- **Codex 0.162.1 → 0.163.0。** `codex exec … resume` 与 `codex resume` 的源码未变；0.163.0 上两者会恢复线程保存的权限。协作模式的实验接口仍在，Hub 改为按 `collaborationMode/list` 是否可用判断；`thread/start`、`thread/resume` 回包的稳定字段 `collaborationMode`、`approvalPolicy`、`sandbox` 可以直接回报线程真实值。插件 `_default` 表给没写 `enabled` 的插件提供缺省值；`mcpServerStatus/list` 不带 threadId 时只反映全局配置（口径问题，第四批）；`thread/readState/changed` 只发给实验连接，归为被动通知。状态库新增迁移 0060、0061，上游测试表明可回退。未验证：冷启动续接后稳定字段是否等于线程最后一次的模式、338 MB 平台包没有下载、本机是否运行着 `codex app-server daemon`。
- **OpenCode 1.18.35 → 1.19.3（OpenCode 1 线）。** `acp/` 源码与 SDK 版本逐字节相同，`acp.ts` 不用改；`/compact` 在 1.0.0–1.19.3 与 2.x 的已发布版本里都由原程序处理，而 1.16–1.19 的 ACP 对不认识的 `/` 文本静默丢弃（v1.19.3 `acp/service.ts:585-587`），所以补入改为“目录未列出即补入、空回合判为原程序没有执行”。Homebrew 裸名 `opencode` 在 Core 里已是 2.x，升级要用 `anomalyco/tap/opencode` 全名。`OPENCODE_DISABLE_AUTOUPDATE` 仍生效，1.18.35→1.19.3 没有数据库迁移。OpenCode 2 改了配置写法（`mcp.servers`、permissions 数组、plugins）与插件 API，没有 `models --verbose`，`-s` 遇到未知 ID 会新建会话——按哪条线做“最新版”待用户（见“待用户决定”第 2 题）。未验证：本机 `brew` 对裸名的实际解析、V2 对 V1 数据库的迁移是否可逆。
- **DeepSeek Harness 0.2.0-rc.2 → 0.2.1-rc.2。** ACP 控制层不用改：SDK 仍是 1.4.0，initialize 能力、方法集合、审批选项、stopReason 映射、`dsh --profile acp` 的参数与 profile 模板都没变；仍没有 tui profile；会话日志格式仍是 4。变化：`dsh headless` 不再读界面里保存的密钥与账号登录（dsh-headless 把 credentials、authorization、deepseek-account 三行设为 disabled），只用终端环境、工作区 `.env` 或 `~/.dsh/.env`——续接命令因此要附前提说明；指令除 `~/.dsh/AGENTS.md` 外还读 `$DSH_AGENTS_HOME`（缺省 `~/.agents`）下的 AGENTS.md；插件按 profile 的 `bundles` 与补丁里的 `disabled` 决定启用；新增 working_directory 工具包；`DSH_TOOLS_MODE=both` 已移除。读表的双根与插件规则留给第四批。未验证：本机实际用哪种凭据、0.2.1-rc.2 的真实 initialize 回包与模型目录、子 Agent 回合在 Hub 的拼接。
- **OpenClaw 2026.3.23-2 → 2026.10.5。** 7 个 Gateway 方法、Hub 的会话键 `agent:<id>:harnesshub:<uuid>` 与 `_meta.sessionKey`/`requireExistingSession` 在 latest 仍受理。要按能力适配的：名册改为 `agents.list`（`defaultId`、`selectionRequired`、`agents[].model.primary/workspace`）与配置文件里的 `agents.entries` 键控形状，`selectionRequired` 为真且没有 `defaultId` 时明确报错、不猜 main；桥开始实时转发工具流，ADR-027 的转录对账要按 tool id 去重；设置回读的新取值（fastMode `auto`、response_usage 缺省 `inherit`、`trace_level`）按桥公布的 `currentValue`；`models.list` 带 `available`/`unavailableReason`；fork 交给 `sessionCapabilities` 声明判断。升级要经 2026.9.5 的 Doctor（上游要求），Doctor 改写 `openclaw.json`、会话存储迁到 SQLite，deepseek 提供方与飞书渠道要装回官方外部插件，npm 11.16+ 要 `--allow-scripts=openclaw`。归档会话的恢复、审批中继、断线后的未知结果与 `session/close` 先于杀进程，都需要真实核实或新的“未知结果”契约，留第四批。未验证：归档会话能否恢复、转录里 toolCall 的 id 是否总等于实时事件的 id、本机 npm 11.20.0 对未列入 `--allow-scripts` 的包是否运行脚本、openclaw-weixin 2.0.1 的兼容性。
- **Hermes Agent 0.12.0 → v0.22.4。** v0.22.3 起 `hermes acp` 只是网关的查看器：没有网关就自己起一个，有网关就附着，同一 home 上的旧版网关会被它停掉换新；最新版没有进程内模式可退，所以“只运行 `hermes acp`、不触碰用户网关”（ADR-031）在最新版上不再成立，是否进入用户网关是产品决定（“待用户决定”第 3 题）。0.12 的两个缺陷（ACP 审批桥永远拒绝、审批期限硬编码 60 秒）上游分别在 0.14.0、0.21.4 修复。可从源码确定、与网关无关的准备：审批选项说明按 option id（`allow_always` 写入所有会话共用的允许列表、`allow_session` 只在本会话内、`deny_always` 等同拒绝）；JSON-RPC 错误的 `data.details` 分类（`not_found`、`Gateway starting/incompatible/inaccessible/draining`、`unknown_execution:`、`admitted_turn_failed`）；发现改读 `.hermes/bin/hermes`、`<root>/install-stamp.json` 与 `hermes-acp`/`hermes-agent` 启动器（0.12 布局没有 stamp 时仍退回 dist-info；dist-info 在 v0.21.6 之后读到 0.0.0，视为未知）。升级会把 `config.yaml` 从版本 23 迁到 50 以上、`state.db` 从 schema 11 迁到 31 以上且不能回退，网关会重启一次（QQ 短暂离线），按 ADR-044 由用户在终端运行。未验证：网关模型下的全部实际行为——本轮没有运行任何 Hermes 程序，也没有触碰网关。

## 决定

1. **接入不限定版本。** 只要是本机官网渠道的安装（ADR-044），任何版本、包括读不出版本的安装，都能被发现、选择、建会话、发消息、恢复、分支、导出。版本号从不作为接入、建会话、显示选项或发送命令的条件；禁止“版本 ≥/≤ X 就拒绝”这类规则（ADR-051 第 8 条撤销，不再实现）。

2. **不按版本号提示或劝阻。** 界面照常显示每份安装的版本号、接入口版本、渠道最新版本和“有新版本/已是最新”；不再显示“未经验证的版本”“未核实”“两个版本相隔约 N 个月”“X 还没有验证”这类按版本号推断的提示；预发布版只作中性事实写出，不用警示色。风险只来自产品自己给出的信息（更新器的 dry-run 计划、Doctor 结论、运行时返回的原因）。

3. **续接命令按产品给出，与版本无关。** ADR-039 的两种形式对该产品的任何已安装版本都给出；只保留与产品本身有关的差别（DeepSeek Harness 没有交互形式、Pi 只指向自己的会话列表、OpenClaw 不显示）、普通标识符检查（PLAIN_ID）和前提说明（例如 dsh headless 只读终端环境或 .env 里的密钥）。读取续接命令不触发发现与版本探测（ADR-050 第 30 条随之修改）。页面不再写“已用真实回合验证”；在哪个版本上核对过，写进 ADR-039 的表和验收记录。

4. **能力读取：每个 Harness 一张读表，以最新正式版为准。** 读表的位置与格式按各家最新正式版的官方文档、源码或包内文件核对；核对时的版本记在读表的 `checkedOn` 字段，只作证据，运行时不比较、不标“未核实”。版本高于或低于核对版本时用同一张表读取，读不到的地方如实说“没有读到”，不说“版本不在范围内”。最新正式版改了位置或格式时，在下一轮核对里更新读表并改 `checkedOn`。

5. **功能按程序实际报告的能力判断。** 依据是 ACP `initialize` 的 agentCapabilities/sessionCapabilities/promptCapabilities、`available_commands_update`、`configOptions`、app-server 的 initialize 回包，以及方法调用的结果（-32601、明确拒绝）。不按版本号区间开关功能；版本号只进入 ProtocolObservation 作诊断与证据。原程序不提供的能力，在用到时以具名错误码加原程序给出的原因明确失败（例如“这个 Codex 不提供协作模式”“OpenCode 没有执行 /compact”），不悄悄降级、不提前隐藏、不以空结果充当成功。

6. **升级目标是渠道的最新版。** npm 取 `latest`（预发布版若是 `latest` 也是目标）、Homebrew 取公式或 cask 的当前版本、带官方更新器或轨道的产品取其 stable/latest 轨道、脚本安装取官网脚本当前下发的版本。上游要求的中间迁移步骤（OpenClaw 先到 2026.9.5）按上游要求保留，不是版本门槛。HarnessHub 显示“最新版本”并提供升级入口，但不替用户升级：升级只由用户在 Hub 里点击或明确同意后发生（ADR-043/044 不变）。

7. **真实验收的基线是验收当日各家的最新正式版**（本机已升到它之后）。记录写明提交、渠道、版本、日期、费用与局限；旧版本上的记录全部保留为历史证据。“做精”判据（ADR-048）第 4 层改为“在最新正式版上经 4317 正式入口真实通过，记录写明版本作为证据”。开发侧在新版本发布后做一次回归（原“冒烟”），它是工程动作，不进产品界面，也不改变任何“区间”。

8. **版本记录只作为工程证据保留，代码不读它。** 证据的位置：能力矩阵 `installation` 文本（“真实验收版本 …”）、`docs/verification/` 记录、读表 `checkedOn`、ADR-039 表的“核对时版本”列、ADR-038 中既有的验证记录。删除 `VERIFIED_VERSIONS`、`versionVerification`、`adapterVersionVerification`、`versionConsistency` 及契约字段 `verification`/`target`/`table`/`version-unverified`。

9. **旧版本缺功能时怎么说。** 用户的安装比最新版旧且缺某项能力时，HarnessHub 按第 5 条在用到时说明“原程序没有提供 X”，并在同一处显示渠道最新版本与升级入口，由用户决定是否升级；不替用户升级，不装私有副本冒充本机安装。对某个已知旧版本的事实性行为（目前只有 Hermes 0.12 固定的 60 秒审批等待）允许按 `initialize` 报告的身份给出事实说明或期限，但这类特例只能增加信息、不能减少功能，必须在本 ADR 的“例外”节登记并写明退出条件。

10. **与“沿用本机安装”的关系。** 基线是最新版，对象仍是用户本机的那份官网安装：不是最新版照常接入；验收用本机安装，升级由用户决定；探测只读文件、不运行程序（ADR-044）；不复制用户数据。

## 例外（登记）

| 例外 | 依据 | 只增加信息的证明 | 退出条件 |
|---|---|---|---|
| Hermes 0.12.x 的 60 秒审批期限：`HermesControl` 按 `initialize` 报告的 0.12 身份把审批期限记为 60 秒（`src/adapters/control/hermes.ts` 的 `approvalDeadlineMs`），公共请求由通用层 `AcpControl` 提前 2 秒关闭（`src/adapters/control/acp.ts` 的 `APPROVAL_DEADLINE_MARGIN_MS`），侧栏与审批卡据此显示“N 秒后自动拒绝”（ADR-035） | 0.12 的 ACP 适配层把期限硬编码为 60 秒且不读配置、不向客户端撤回请求（[ADR-031](0031-hermes-and-deepseek-harness.md)）；0.21.4 起期限可配置且桥不报告它，所以其他版本不作任何声明，只显示回合期限 | 只影响期限的显示与提前关闭的时刻，不影响选择、发送、审批选项或任何功能；`AcpControl` 的 `agentVersion` 读取因此保留，只供这条例外与 ProtocolObservation 的证据使用 | Hermes 网关视图接入（ADR-051 修订后的路线）落地、改为读取 `approvals.timeout` 或网关报告的等待时间时删除；在此之前不新增同类特例 |

同日删除的不是例外、而是功能差别的 0.12 特例：0.12 审批桥缺陷的提示（“Hermes 拒绝了这条命令，但没有向 HarnessHub 请求审批”，ADR-031 第 45 行）。它按版本号判断是否显示一段说明，与决定 2 冲突；拒绝文本本身仍按 ADR-031 的工具失败规则标为失败。

## 审批代理的裁决（2026-10-22）

用户授权的审批代理对本记录与第三批任务的裁决，凡与本记录有关的都列在这里：

1. **原则的四点理解**（任何版本可接入不提示、基线最新正式版、功能按能力判断、版本只作证据）：同意，附三点修正，已写进决定 6、9、4——“最新版”按渠道定义，预发布版若是渠道 latest 也是目标；允许对已知旧版本的事实性行为给出只增加信息、不减少功能的说明，必须登记并写退出条件（目前只有 Hermes 0.12 的 60 秒）；读表每家一张、`checkedOn` 只作证据，版本不同也用同一张表读取并如实报告读不到的位置。
2. **删除版本表与四类契约字段**：同意。条件：被删的每条门槛断言都要有对应的正向断言替代（任何版本都给命令、任何版本都不显示版本提示、能力页只显示版本号）；服务端字段与 `web/src/api.ts` 的解码器同一提交改（其中三个字段是必填解码，只改一边页面会报 `INVALID_RESPONSE`）；验证记录与版本号全部保留在 docs 与矩阵里作证据。
3. **保留文件路径 `src/infrastructure/management/verified-versions.ts`**，只放续接命令表 `RESUME_COMMANDS`，直到 M2 T-ARCH-03 迁入 Harness 描述模块：同意。条件：文件头注释写明原因与去向；`plan/tasks.json` 的 G011/G065 与[真实验收操作手册](../engineering/real-acceptance.md)第 8 节同步说明；T-ARCH-03 的范围加入 `RESUME_COMMANDS` 的迁移。
4. **`NativeResumeView.note` 的 `not-verified` 改名 `no-command`；预发布版徽标改中性**：同意。契约、解码器、页面、`web-server.test.ts`、[Web 契约](../contracts/provider-web-mvp.md)同批改。
5. **Claude 会话参数带 `_meta.claudeCode.options.promptSuggestions=false`**（产品取舍）：同意。HarnessHub 不展示预测，省去 0.92.0 起每回合多一次请求；用户自己的 `promptSuggestionEnabled` 设置不受影响；真实验收核对每回合用量不再多一次请求。
6. **`/remote-control` 在 HarnessHub 的 Claude 命令目录中隐藏，用户输入时拒绝并说明**（产品取舍）：同意。理由：HarnessHub 默认每回合结束关闭适配器进程，Remote Control 会随之断开；远端回合在 Hub 只计为未归属的更新；claude.ai 的会话链接不应进入 Run 输出与导出。将来若在“保持原生进程”（ADR-030）下支持 Remote Control，另立 ADR。真实验收不运行它。
7. **Hermes 0.12 的 60 秒审批期限保留为按 initialize 报告身份的事实说明；0.12 审批缺陷提示删除**：同意，附条件——登记在上面的例外节，只能增加信息、不能影响任何功能，网关视图接入时删除。
8. **Codex 协作模式总是提供、`collaborationMode/list` 不可用时 `NATIVE_OPTION_UNAVAILABLE`；OpenCode `/compact` 对任何版本补入、空回合判 `NATIVE_COMMAND_IGNORED`；OpenClaw 的 fork 硬拒绝删除**：同意。条件：错误消息带原程序给出的原因；`/compact` 空回合判定只对 OpenCode，并以 1.18.35 的真实形状（回复文本）为 completed 的依据（[opencode-compact-2026-10-22.md](../verification/opencode-compact-2026-10-22.md)）；协议测试用能力场景而不是版本场景。
9. **JSON-RPC 错误的 `data.details` 透出到 `ControlError.remoteDetail`**：同意，附条件——截 2 KiB、剔除控制字符、不进日志原文；进入用户可见消息的只有匹配固定前缀的分类结果（`not_found`、`Gateway …`），不回显任意文本；`unknown_execution` 本批不映射为 failed（`BackendResult` 没有未知，把未知记成失败违反运行契约），只在诊断里透出原因与 `/discard` 提示，等“未知结果”契约任务。
10. **OpenClaw 思考与识图两格记为本机受阻并写明原因**：同意。说明写“本机默认模型不输出思考/不看图，非接口缺口；用户配置推理或多模态模型后复验”，用户任何时候可以改为先配好模型再验收。
11. **OpenClaw 的 npm 直装升级在本批改为 `UNSUPPORTED_UPGRADE` 并说明改走 `openclaw update`；候选版本的 `config validate` 预演删除**：同意，作为过渡措施，第四批路线 A 落地后放开；确认框文案指向 ADR-052 修订版；用户现在点击升级会看到说明，而不是校验失败。
12. **否决**：ADR-051 的 A1（钉住 v0.22.2 并禁止 `hermes update`）、B 作为终态（停在 0.12.0）、第 8 条（≥ 0.22.3 拒绝建会话）——与用户原则直接冲突；ADR-052 推荐的 extended-stable 2026.9.33 轨道——原则定为 latest，研究中“extended-stable 含同样的 ACP 桥改进”的事实不否认，但不再作为选择依据。
13. **真实验收费用上限**：沿用[手册](../engineering/real-acceptance.md)第 4 节，OpenCode 从 5 次放宽到 ≤ 10 次提示（`/compact` 与可选的 thought-level），Hermes 本轮不做；单回合 > 150k token 或 > 5 分钟即停。
14. **把本机各家升到最新版用于真实验收**：由用户决定（“待用户决定”第 1 题）；无论答复如何，升级只由用户在 Hub 点击或明确同意；OpenCode 的 Hub 升级要等 Homebrew 公式全名的修复部署后再点，否则可能被换成 Core 的 OpenCode 2。

## 不做

- 不读上游最新版本来“阻止”旧版本；不按版本禁用 Harness 或能力。
- 不为迁就旧版本钉住任何 Harness 的版本，不要求用户停在某个版本。
- 不把协议测试通过当作最新版真实通过。
- 不替用户升级，不装私有副本冒充本机安装，不复制用户数据（ADR-043/044 不变）。

## 已撤销的计划

下列此前已登记、尚未实现的门槛按决定 1、2、5、7 撤销，不再实现。历史记录本身不改写，只在这里登记：

| 来源 | 原计划 | 处置 |
|---|---|---|
| [ADR-034](0034-codex-plan-mode.md) 第 37 行（“迟到条件的处置”） | 计划模式只对已核验版本开放：按 ADR-038 的已验证区间门控，区间外禁用并说明“此版本未核验实验接口” | 撤销。协作模式总是提供，`collaborationMode/list` 不可用时在打开线程时明确失败（ADR-034 修订） |
| [ADR-051](0051-hermes-upgrade-route.md) 第 8 条 | 检测到 ≥ 0.22.3 的 `hermes acp` 时拒绝建会话 | 撤销，不实现。最新版的查看器模型如何接入由用户决定（ADR-051 重写） |
| [ADR-052](0052-openclaw-upgrade-route.md) 的 T-OC-11 | 2026.10.x 适配按版本门控，旧版本行为不变 | 撤销。改为按 ACP 桥实际报告的能力判断：实时工具流有则去重、审批中继有则接、思考流有则不再从转录补（ADR-052 修订） |
| [ADR-048](0048-harness-scope-and-workbuddy.md) 用户决定 3 | 检测到新版本后由用户在页面触发一次约 10 次提示的冒烟，通过即扩区间 | 撤销页面入口与“扩区间”。新版本发布后的回归只作开发侧动作（[手册](../engineering/real-acceptance.md)第 6.1 节），不进产品；“只读显示各家的自更新状态”保留 |
| [阶段报告 2026-10-12](../verification/phase-report-2026-10-12.md) 第 200 行与第 211 行 | “Codex 计划模式的版本门控……为首批”；表中“ADR-034：计划模式只对已核验版本开放——采纳，下一阶段首批” | 该计划撤销；报告作为当时的记录保留原文，以本记录为准 |

## 待用户决定（不阻塞本记录）

总指挥 2026-10-22 送给用户的四题，答复前的处置写在括号里：

1. 是否把本机 Claude Code（2.1.306 → 2.1.307，适配器 0.89.1 → 0.94.0）、Codex（0.162.1 → 0.163.0）、OpenCode（1.18.35 → 1.19.3，等公式全名修复部署后）、dsh（0.2.0-rc.2 → 0.2.1-rc.2）升到渠道最新版用于真实验收（都经 Hub 的升级入口或用户确认后执行；推荐都升）。答复前：Hub 的功能照常对当前版本可用，不做任何版本提示。
2. OpenCode 的“最新版”按 OpenCode 1 的 1.19.3（与本机、npm opencode-ai、ACP 注册表一致，推荐）还是直接换到 OpenCode 2（2.1.2，需用户同意替换本机 V1，Hub 要新加渠道识别与 V1/V2 读表）。答复前：本批按 1.19.3 写配方，不加 V2 渠道。
3. Hermes 最新版 v0.22.4 的 `hermes acp` 会附着到用户正在运行、同时服务 QQ 的网关：是否允许 HarnessHub 的 Hermes 会话进入它（[ADR-051](0051-hermes-upgrade-route.md) 修订版只剩这一个待决项）。答复前：Hub 仍接入本机 0.12.0，不做版本提示，不运行任何网关命令，本轮不做 Hermes 真实验收。
4. OpenClaw 升到 latest 的方式：由 HarnessHub 两跳升级（路线 A，推荐）、用户在终端自己按官方命令升级（B）或暂不升级（C）（[ADR-052](0052-openclaw-upgrade-route.md) 修订版）。答复前：OpenClaw 的 npm 直装升级显示说明（裁决 11），在 2026.3.23-2 上用当前代码重做 T-OC-08 复验。

WorkBuddy 的遥测开关与本原则无关，M4 开始前再问（ADR-048）。

## 对已有 ADR 的修订一览

| ADR | 修订（行号为修订前的位置） | 本次状态 |
|---|---|---|
| [ADR-031](0031-hermes-and-deepseek-harness.md) | 第 16 行的 60 秒期限改引本记录的例外登记与退出条件；第 45 行 0.12 审批缺陷提示删除，保留为历史说明；“只运行 `hermes acp`、不触碰用户网关”注明最新版没有进程内模式，是否进入网关待用户（ADR-051） | accepted，已修订 |
| [ADR-034](0034-codex-plan-mode.md) | 第 3、14 行“要求 0.162.1 及以上，读不出版本或更低时不提供”改为总是提供、`collaborationMode/list` 不可用时 `NATIVE_OPTION_UNAVAILABLE`；第 37 行按已验证区间门控撤销；§5 补 `thread/start`、`thread/resume` 回包稳定字段经 `nativeConfig` 回报 | accepted，已修订 |
| [ADR-035](0035-attention-and-request-deadlines.md) | 第 31 行保留事实，改引例外登记与退出条件，不再写“按 initialize 报告的版本门控功能” | accepted，已修订 |
| [ADR-036](0036-approval-wait-budget.md) | 第 11 行加引例外登记 | accepted，已修订 |
| [ADR-038](0038-verified-version-hint.md) | 全文取代：决定 1–6 与“区间语义”一节作废（版本表、判定、显示、维护、四处对账）；2026-10-17 与两段 2026-10-22 补充保留为历史证据，文首写明版本只作证据、代码不再读取 | superseded by ADR-053 |
| [ADR-039](0039-continue-in-the-original-program.md) | 决定 1 改为命令按产品给出、与安装版本无关；表格的版本列改名“核对时版本（证据）”并补“最新版源码核对（2026-10-22）”列；决定 2 的文案去掉“已用真实回合验证”；维护一节改为每次在最新正式版上真实验收时复核；2026-10-21 补充里“版本条件不变”注明已被取代；`note` 取值 `not-verified` 改名 `no-command` | accepted，已修订 |
| [ADR-043](0043-upgrade-with-running-programs.md) | 第 26 行“日历版本相隔两个月以上时说明跨度”与第 27 行“目标版本没有经过验证时按 ADR-038 说明”删除；风险说明只来自产品自己的更新计划或 Doctor 结论 | accepted，已修订 |
| [ADR-044](0044-macos-official-channels.md) | 第 122 行“装好后按 ADR-038 判断，不是验证过的版本就提示”与第 147 行“新版本按 ADR-038 提示未经验证”删除；“预发布版要标出”改为中性事实；第 68 行非官网证据说明保留 | accepted，已修订 |
| [ADR-045](0045-unified-capability-management.md) | 第 40 行“每个 Harness、每个版本范围一张读表”改为每家一张、以最新正式版为准、`checkedOn` 记核对版本；裁决 9 的“声明表按版本区间留位”删除，OpenClaw 的 MCP 与插件写入按最新版的热重载规则经真实核实后开放，不写“这个版本” | accepted，已修订 |
| [ADR-046](0046-harness-focus-hardening.md) | 第 1 项（版本单一来源与一致性检查、数字不改、界面照 ADR-038 提示）与第 5 项（OpenCode 在 1.18.x 补 `/compact`）注明已被本记录取代；第 13–14、43、71、94、124 行同步 | accepted，已修订 |
| [ADR-048](0048-harness-scope-and-workbuddy.md) | 完成定义第 4 层与“做精”判据改为最新正式版；用户决定 3（区间加冒烟）、4（dsh 精确基线）、5（Hermes 停在 0.12.0）按本记录修订；第 21、51、105、117 行同步；新增“ADR-053 对本记录的修订”一节 | accepted，已修订 |
| [ADR-050](0050-harness-tiers-and-on-demand-refresh.md) | 第 30 行“原生恢复命令按请求扫描”改为不扫描；决定 4 的文案去掉“已用真实回合验证” | accepted，已修订 |
| [ADR-051](0051-hermes-upgrade-route.md) | 重写为“Hermes 最新版的接入方式”：删除 A1、B 作为终态与第 8 条；第 1、2 条改引本记录例外；第 6 条由第三批 D4 承接；第 7 条区间删除；唯一待决项是 A2（网关查看器附着） | proposed（等第 3 题） |
| [ADR-052](0052-openclaw-upgrade-route.md) | 轨道改为 latest；路线 A 保留为推荐并等用户确认，流程细节按研究改写；路线 C 只作研究期间的现状；T-OC-11 改为按能力；第 59、76 行文案改写；本批的过渡措施（裁决 11）登记 | proposed（等第 4 题） |
| [索引](README.md) | ADR-038 标 superseded；ADR-034、039、046、048、051、052 的摘要同步；新增本记录 | — |

## 影响

### 代码（第三批 D1–D4，与本记录并行；是否完成以各任务的测试与主代理的集成报告为准）

- **D1 版本门槛拆除。** 删除 `VERIFIED_VERSIONS`、`versionVerification`、`adapterVersionVerification`、`versionConsistency`，以及契约字段 `verification`（管理视图、逐份升级检查）、`target`（安装检查、维护检查）、`table`（能力视图）、`version-unverified`（续接命令）；`NativeResumeView.note` 只剩 `no-command`；续接命令对任何版本给出，`GET /api/v1/sessions/:id/native-resume` 不再扫描；`UpgradeDialog` 的日历跨度提示与预发布警示色删除；读表的 `verified` 区间改为 `checkedOn`；`src/infrastructure/management/verified-versions.ts` 保留路径、只放 `RESUME_COMMANDS`（裁决 3）。被删的门槛断言换成正向断言。
- **D2 控制层按能力判断。** Codex 协作模式总是提供、`collaborationMode/list` 不可用即 `NATIVE_OPTION_UNAVAILABLE`、线程稳定字段经 `nativeConfig` 回报；OpenCode `/compact` 目录未列出即补入、空回合 `NATIVE_COMMAND_IGNORED`；Hermes 审批选项说明按 option id、0.12 缺陷提示删除、JSON-RPC `data.details` 有界透出并分类；Claude 会话参数 `promptSuggestions=false`、`/remote-control` 隐藏并拒绝、`$/cancel_request` 关闭对应请求、fork 超时与 REMOTE_ERROR 分类。
- **D3 OpenClaw 最新版就绪。** 键控名册与 `agents.list`、实时工具流去重、设置回读按桥公布值、模型可用性、去掉 fork 硬拒绝；新增协议测试 `tests/protocol/openclaw.test.ts` 与夹具 `tests/fixtures/openclaw-bridge-peer.mjs`（最小 stdio ACP 代理，Gateway 方法全部走注入的假实现，不运行 openclaw；登记在 `plan/tasks.json` 的 G032）。
- **D4 安装、发现与渠道按最新版。** Homebrew 公式全名（`<tap>/<formula>`）；Hermes 新布局（`.hermes/bin/hermes`、`install-stamp.json`、`hermes-acp`/`hermes-agent` 启动器）；dsh 与 Hermes 的目录条目版本跟随渠道；OpenClaw 官方 npm 命令 `npm install -g openclaw@latest --allow-scripts=openclaw`；`YYYY.M.P-N` 修订号的版本比较；OpenClaw 的 npm 直装升级过渡为 `UNSUPPORTED_UPGRADE`（裁决 11）。

### 产品

- Harness 列表、选择器、欢迎页、详情页与安装/升级/维护确认框不再有任何按版本号推断的提示；版本号、渠道最新版本与“有新版本/已是最新”照常显示，预发布版中性写出。
- 对话详情栏对任何版本都给出该产品的续接命令与复制按钮，没有续接命令的产品只显示原生会话 ID；dsh 的一次性命令旁写凭据前提。
- 能力页只显示版本号，不再标“未核实”。
- 原程序不提供的能力在用到时明确失败并带原程序的原因，同一处给出渠道最新版本与升级入口。

### 流程

- 真实验收以验收当日的最新正式版为对象，每家一份 `docs/verification/<harness>-latest-<日期>.md`；配方提交只改三样：验收记录、矩阵 `installation`（“真实验收版本 …”）与各格的 `real`/`note`/`evidence`、读表 `checkedOn`；ADR-039 的表补“核对时版本”。不再有 `VERIFIED_VERSIONS` 与 `versionConsistency` 对账（[手册](../engineering/real-acceptance.md)第 8 节）。
- 新版本发布后的开发侧回归取代“冒烟加扩区间”，不进产品。
- [设计就绪门禁](../engineering/readiness.md)的 G4 与[测试与验收策略](../engineering/testing.md)的真实层改为最新正式版。

### 计划与文档（第三批 D5，本记录所在的提交序列）

- `plan/test-cases.json`：按版本写的期望改为按能力与任何版本（G011-NC1、G011-NC2、G011-UG3、G054-NC12、G054-NC13、G054-UP1、G054-UG1、G054-FZ3、G032-NC24、G065-A01），并登记 D2、D3、D4 的新用例；`plan/tasks.json` 的 G032 owns 两个新测试文件，G011 与 G065 注明被取代的项；`plan/slices.json` 的 harness-focus 说明同步；`plan/native-capabilities.json` 的版本说法改为证据表述，OpenClaw 两格按裁决 10 记为受阻；TASKS.md、test-matrix.md 与能力矩阵视图由 `python3 -I tools/check_design.py --write` 重新生成。
- README、docs/README、Web 契约、真实验收操作手册、设计就绪门禁、测试与验收策略按上表同步。`docs/verification/` 下的历史记录不改写，它们是证据。

## 验证

- `src/`、`web/src/`、`tests/` 中不再出现 `VERIFIED_VERSIONS`、`versionVerification`、`HarnessVersionVerification`、`version-unverified`、“未经验证”“相隔约”（grep 为 0），“未核实”也不再作为版本标记出现（执行结果未知、升级任务核对版本号、Cursor 读取规则说明里的“未核实”与版本门槛无关，保留）；设计检查、边界检查、工具自检、单元/集成/协议/浏览器测试全部通过，被删的门槛断言换成正向断言（任何版本都给命令、任何版本都不显示版本提示、能力页只显示版本号）。这些由 D1–D4 的测试与主代理的集成检查证明，本记录只登记要求。
- 每家在最新正式版上的真实验收记录入库后，矩阵 `installation`、读表 `checkedOn`、ADR-039 表同一提交更新；不再有 `versionConsistency` 对账。真实验收以用户对“待用户决定”第 1 题的答复为前提，在它之前只有源码核对，不声称最新版真实通过。
- 设计检查对计划与文档的要求：`python3 -I tools/check_design.py --write` 后再运行一次 exit 0；`pnpm check` exit 0；能力矩阵的 `installation` 文本不得再含“已验证区间”“VERIFIED_VERSIONS”“未经验证的版本”（`tools/check_design.py` 新增规则，`tools/test_check_design.py` 有拒绝样例并经临时关闭规则的变异核对）。
