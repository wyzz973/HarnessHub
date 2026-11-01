# Hermes Agent v0.22.5 真实重验（2026-11-01，网关查看器模式）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)第 6.6 节运行。基线按 [ADR-053](../decisions/0053-latest-version-baseline.md)：验收当日 stable 轨道的最新发布是 v0.22.5（`hermes update --check`），本机先 `hermes backup`（归档在 `~/.cache/harnesshub-acceptance/`），再在终端运行 `hermes update --yes`（v0.22.4+70.g4e58c72 → v0.22.5，commit bf0203a794a0；更新器自己暂停并重启了 launchd 网关 `ai.hermes.gateway`，QQ 在这段时间离线约 1 分钟）。用户 2026-10-22 已允许 HarnessHub 的 Hermes 会话进入正在运行的网关（[ADR-051](../decisions/0051-hermes-upgrade-route.md) A2，accepted）。此前的记录：0.12.0 进程内模式的 [2026-10-11 接入记录](hermes-dsh-onboarding-2026-10-11.md)等，只作证据。

## 环境与证据头

- commit：`d0d6487`（预检修复 `ed8bdd4` 之前的目录读取与之后的全部套件：修复后的目录读取证据头写 `uncommittedChanges: true`，是当时尚未提交的这处修复；套件运行时它已构建进 dist）。
- 安装策略：official；平台：macOS 27.0.0。
- 安装（照抄证据头）：`hermes` 0.22.5，官方安装脚本（`~/.hermes/hermes-agent`，启动器 `~/.local/bin/hermes`），product，active。代理自报 hermes-agent 0.22.5。
- 入口：`hermes-native`（acp-v1，来源 system）。
- 环境：`env -i`，只带 HOME、USER、LOGNAME、SHELL、TERM=dumb、LANG、TMPDIR 与登录 shell（`zsh -lic`）的 PATH；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`。未设 `HH_REAL_MANIFEST`、`HH_REAL_MODEL_HERMES`（用网关的默认模型 `deepseek:deepseek-v4-pro`）。审批只“允许一次”（allow_once）。失败不重跑。
- 网关：用户自己的 launchd 网关（服务 QQ，`platforms.qqbot.state = connected`）。每轮开始前核对 `~/.hermes/gateway_state.json`：`gateway_state = running`、`active_agents = 0`、`active_work = null`、`code_sha` 等于 `~/.hermes/hermes-agent/install-stamp.json` 的 `commit`。全程不启动、不停止、不重启网关（`hermes update` 的重启在验收之前）。
- 运行时间：2026-11-01 14:33～14:42（本地时间）。

## 预检（ADR-051 A2）

| 场景 | 判定 | 结果 |
|---|---|---|
| 空的临时 `HERMES_HOME`（没有网关、没有登记的 launchd 服务） | E | 在启动 `hermes acp` 之前拒绝（`NATIVE_GATEWAY_UNAVAILABLE`，说明会起无人监督的守护进程，给出 `hermes gateway status`、`hermes gateway start`）；没有运行任何 Hermes 进程。手册第一步的其余部分（私有网关上的 16 格）没有做：隔离 home 需要单独提供模型凭据，本轮不复制用户凭据 |
| 真实网关，预检第一版 | C（误判） | 真实网关由 launchd 以 `python3 -I -c <引导脚本>` 形式启动，`ps` 看到的是被截断的引导源码，记录里的 kind 是 `hermes-gateway`；第一版把它当作“launchd 在运行但网关未发布就绪”。修复 `ed8bdd4`：内联引导进程按记录的 argv 判定、kind 常量改为 Hermes 的 `hermes-gateway`（gateway/status.py:40、555-563；gateway/status_inline_source.py:67-162） |
| 真实网关，修复后 | A | 附着成功，目录读取通过（下表第 1 行） |

## 守护

- 套件内：每条结果都是 `guard.unchanged: true`，`changed` 为空（hermes 清单：`~/.hermes/config.yaml`、`SOUL.md`、`~/.hermes/skills`、`~/.agents/skills` 与共享清单）。整轮前后没有另拍 hermes 的快照。

## 命令与结果

每个套件都是 `RUN HH_REAL_HARNESSES=hermes HH_REAL_EVIDENCE=<证据文件> node --test dist/tests/real/<套件>.real.js`，证据在 `~/.cache/harnesshub-acceptance/evidence/2026-11-01/hermes-<套件>.json`（不入库）。

| # | 套件 | 其他变量 | 提示 | 结果 | 判据逐项 |
|---|---|---|---|---|---|
| 1 | native-catalog | — | 0 | 通过 | 76 个模型（默认 `deepseek:deepseek-v4-pro`，含 openrouter、anthropic、deepseek 等提供方；证据只保留前 64 个 id）；认证 ready；命令 15 条；选项 `__mode`（default / accept_edits / dont_ask，即 session/set_mode）；`loadSession` true，会话能力 fork/list/resume；提示能力 image；清理 closed、exitCode 0 |
| 2 | native-resume | — | 2 | 通过 | 两轮都 completed（end_turn）；第二轮答对标记，`replayMixed: false`；绑定 ready；清理 closed |
| 3 | native-thinking | — | 1 | 通过 | completed；思考 229 个字符，与回复分开 |
| 4 | native-activity | — | 1 | **未通过 1 项** | **审批真实发出并被遵守**：编辑前请求“Approve edit: …notes.txt”（详情 7 行含 diff，选项 allow_once / deny，选 allow_once）后编辑完成——0.12 时代“审批桥永远拒绝”的缺陷随升级消失。工具 tool_describe、terminal（cat）、todo_list、patch 等都 completed、详情可读；文件已编辑；用量回报 cachedInput/input/output/reasoning/total，上下文窗口 1,048,576。未通过的是 `editDiff`：patch 工具不发 diff（原接口缺口） |
| 5 | native-attachments | — | 2 | **未通过 1 项** | 文件附件经 read_file 答对标记；图片附件由 Hermes 转发，但默认模型回复“我看不到这张图片（视觉分析不可用）”，与 0.12 时相同，按本机模型受阻记录 |
| 6 | native-commands | — | 2 | 通过（部分） | 命令目录没有 compact（`commands.compact: false`，Hub 不为 Hermes 补入），所以没有运行 `/compact`；首轮 completed；Hub 提供的 `/export` completed |
| 7 | native-import | — | 1 | **未通过** | `hermes acp` 自己建出会话后，`session/list` 对该工作区返回 0 个会话（“the Harness listed no session for the workspace”），接续没有进行。0.12 时能列出 ACP 建的会话；网关视图下的列表规则待查 |
| 8 | native-branch | — | 4 | 通过 | 源对话 completed；原生 fork 成功（引用 2 条，绑定 ready，`native: true`）；分支答对；隔离检查未泄漏 |
| 9 | native-subagent | — | 1 | **未通过** | 回合 completed，但模型只用了一个 terminal 类工具，没有调用 delegate_task（`subAgentCall: false`）；子 Agent 一格本轮没有复现，不算接口缺口 |
| 10 | native-config | `HH_REAL_CONFIG_OPTION=model HH_REAL_CONFIG_FROM=deepseek:deepseek-v4-pro HH_REAL_CONFIG_TO=deepseek:deepseek-v4-flash HH_REAL_CONFIG_COMMAND="/model deepseek-v4-flash"` | 4 | **未通过** | 首轮回报 v4-pro；`/model deepseek-v4-flash` 的命令回合以 failed 结束（没有错误对象，回复里没有 Hermes 的切换确认），之后两轮仍回报 v4-pro。网关视图下 `/model` 是受守卫的命令（ADR-051“验证”列出的“受守卫的 /model 确认”），Hub 尚未接它的确认流程 |
| 11 | native-options | `HH_REAL_OPTIONS_HERMES='{"__mode":"accept_edits"}'` | 1 | 通过 | 请求 accept_edits，回报 accept_edits；completed |

合计约 19 次提示，模型 deepseek-v4-pro（经用户网关自己的凭据）。

## 费用

- 约 19 次提示、更多次模型调用（含工具循环）；用户的 DeepSeek 额度，经 Hermes 网关。Hermes 回报的用量是会话累计值，本轮没有换算成增量；按 dsh 记录的估法上界在 ¥3 以内。

## 局限与未验证

- 手册 6.6 第一步（隔离 `HERMES_HOME` 的私有网关上验 16 格）只做了预检 E 的拒绝，没有起私有网关：需要单独的模型凭据。
- 第二步是在 QQ 已连接、`active_work` 为空时进行的“只附着”运行；Hub 的回合与 QQ 共用一个网关进程这一代价照 ADR-051 写进了界面文案，本轮没有观察到对 QQ 的影响，也没有核对 `state.db` 里 Hub 会话的行。
- 未复现或未通过并待查：`session/list` 为空、`/model` 受守卫、子 Agent 未调用、`/compact` 不在目录。`editDiff` 与图片是原接口/模型的缺口。
- 续接命令（手册第 7 节 `hermes chat --resume <id> -q "…"`）本轮没有做。
- 能力读表（`src/adapters/capability-reads.ts` 的 hermes 条目）没有在 v0.22.5 上重新核对，`checkedOn` 不改；ADR-051 第 7 条列的读表更新仍是待办。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。

## 配方提交

同一次提交更新能力矩阵 `plan/native-capabilities.json` 的 hermes `installation`（真实验收版本 v0.22.5，网关查看器模式；2026-11-01 之前：0.12.0 进程内模式）与上表各格的 `real`、`note`、`evidence`；[ADR-051](../decisions/0051-hermes-upgrade-route.md) 补“真实运行”一节；读表 `checkedOn` 不改（见上）。
