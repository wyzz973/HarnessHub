# ADR-051：Hermes 最新版的接入方式

状态：proposed，2026-10-22（第二批 C6 的只读研究草案，原题“Hermes 的升级路线”；同日按 [ADR-053](0053-latest-version-baseline.md) 重写——按用户“接入不限定版本，默认按最新版”的原则重排选项，只剩一个待用户决定的选项 A2；用户答复后由主代理改 accepted。没有代码改动）。事实见 [Hermes v0.22.2 与 main 的升级就绪](../research/hermes-upgrade-readiness-2026-10-22.md)与 ADR-053“研究结论摘要”里关于 v0.22.4 的部分。依据 [ADR-031](0031-hermes-and-deepseek-harness.md)、[ADR-044](0044-macos-official-channels.md)、[ADR-048](0048-harness-scope-and-workbuddy.md) 决定 5（已按 ADR-053 修订为“基线是最新正式版”）与 ADR-053。

## 背景

- 本机 Hermes 是 0.12.0（2026-05-06 的 main 检出 a0556b8，官方脚本安装）。真实验收记录在 0.12.0 上：能力矩阵 Hermes 列 27 格中 16 格有真实证据（13 格通过、1 格部分、2 格受阻；其余 6 格原接口不提供、5 格没有真实证据）。按 ADR-053，0.12.0 照常接入、不做任何版本提示，这些记录只作证据。
- 0.12.0 的两个已知缺陷：ACP 审批桥永远拒绝（审批格受阻），审批期限硬编码 60 秒。上游在 v2026.5.16（0.14.0）修了前者、v2026.9.21（0.21.4）修了后者。60 秒期限是 ADR-053 登记的唯一例外（按 initialize 报告的 0.12 身份给出事实说明，不影响功能）；审批缺陷的提示由第三批 D2 删除（ADR-031 修订）。
- 上游从 v0.21.6（2026-10-08）起改为语义版本的稳定发布线。**v0.22.2（10-15）是最后一个 `hermes acp` 仍在自己进程里跑模型的发布**；v0.22.3（10-21）起 `hermes acp` 是网关的查看器：没有网关就自己起一个，有网关就附着，同一 home 上的旧版网关会被它停掉换新。最新正式版 v0.22.4（2026-10-21，4d04303）没有进程内模式可退（`acp_adapter/server.py`、`entry.py`）；v0.22.3→v0.22.4 只改了 `gateway/status.py` 与 scoped lock，`acp_adapter` 与 `gateway_runtime` 没有改动。
- `hermes update` 的落点：从 0.12.0 运行落到 main 顶端；从 v0.22.x 运行落到 stable 轨道头。两者都是网关投影。
- 发现与版本：v0.22.x 的安装没有 venv，程序在 `.hermes/bin/hermes`，版本在 `<root>/install-stamp.json`（dist-info 在 v0.21.6 之后读到 0.0.0）；启动器多了 `hermes-acp`、`hermes-agent`。
- 用户此前接受的边界（[ADR-031](0031-hermes-and-deepseek-harness.md)“验收边界”）：只运行 `hermes acp`，不触碰用户的 Hermes 网关。这个网关同时服务 QQ。

## 按 ADR-053 重排后的选项

### 撤销的选项（不再提供）

- **A1：升级到 v0.22.2 并钉住提交 d923a5eb、之后不许再运行 `hermes update`。** 与“升级目标是渠道最新版”“不为迁就旧版本钉住任何 Harness 的版本”冲突，且 v0.22.2 已被上游超过，每次 `hermes update` 都会把用户带到网关投影。撤销（审批代理否决）。
- **B：停在 0.12.0 作为终态。** 与“默认按最新版”冲突。0.12.0 继续接入只是用户答复前的现状（见下文），不是目标。撤销。
- **原第 8 条：检测到 ≥ 0.22.3 的 `hermes acp`（`initialize` 回报的版本）时拒绝建会话。** 直接违反“任何版本都能建会话”。撤销，不实现（ADR-053“已撤销的计划”）。

### 保留并改写的条目（与网关无关，可以先做）

原第 1–7 条按新原则改写，另加一条错误原因的映射：

1. **审批期限。** 0.12 的 60 秒作为 ADR-053 登记的例外，按 initialize 报告的身份给出事实说明与期限；其他版本不作任何声明，只显示回合期限；网关视图接入时改读 `approvals.timeout` 或网关报告的等待时间，并删除例外。（原文“按版本：0.12.x 60 秒；≥ 0.21.4 取 `approvals.timeout`”作废：不按版本号区间开关。）
2. **0.12 审批缺陷提示。** 删除（ADR-031 修订）。审批格在 0.12 上仍记为受阻并写明原因，升级后真实复验。
3. **审批选项说明。** 接受 `allow_session`（会话内放行）作为第三种审批选项；说明按 option id 识别，不按位置：`allow_always` 写入所有会话共用的允许列表（网关模型下包括 QQ 的会话）、`allow_session` 只在本 HarnessHub 会话内有效、不写 Hermes 配置、`deny_always` 等同拒绝一次、不保存任何东西。第三批 D2 承接。
4. **编辑审批模式。** `session/set_mode` 的三个模式（default / accept_edits / dont_ask）作为 Hermes 的原生选项显示；todo 结果转成的 plan 更新按通用 ACP 计划处理。待网关视图接入时一并验证。
5. **工具失败。** 结构化失败已由 Hermes 报 `failed`，文本启发式（`TOOL_FAILURE`）保留为后备。
6. **发现方式。** 版本从 `<root>/install-stamp.json` 的 displayVersion（缺则 baseVersion）读取；没有 stamp（或 stamp 里没有可用的版本值）时退回 venv 的 dist-info（0.12 布局）；dist-info 为 0.0.0（或两处都读不到）时为未知，版本未知的安装照样算官网安装；程序改为 `.hermes/bin/hermes`（0.12 布局的 `venv/bin/hermes` 作兼容候选）；启动器与卸载白名单加 `~/.local/bin/hermes-acp`、`~/.local/bin/hermes-agent`；常驻网关的进程名正则补 `hermes_cli.main --profile <名> gateway run` 与 `.hermes/bin/hermes … gateway run` 两种形态。仍然只读文件，不运行程序。第三批 D4 承接。
7. **能力读表。** 原“`verified` 区间改为 `>=0.22.2 <0.22.3`”删除：读表只记 `checkedOn`（ADR-053 决定 4）；内容更新（MCP 接受 `url` 类条目、`~/.hermes/hooks/<名>/HOOK.yaml` 来源、项目级技能目录与 `skills.create_dir`、`plugin.json`、排除目录）放在第四批“读表按最新版核对”任务里按 v0.22.4 做。
8. **错误原因（新增）。** JSON-RPC 错误的 `data.details` 有界透出到 `ControlError.remoteDetail`；`session/load`、`session/resume` 的 `not_found` → `NATIVE_SESSION_NOT_FOUND`；`Gateway starting/incompatible/inaccessible/draining/could not start` → 具名的“Hermes 网关不可用”错误并附 Hermes 给出的原因；`unknown_execution:` 前缀与“Gateway disconnected; turn outcome is unknown”本批只在诊断里透出原因与 `/discard <admission_id>` 提示，不映射为失败——`BackendResult` 没有未知，把未知记成失败违反运行契约，等 A2 的“未知结果”契约。第三批 D2 承接。

### A2（唯一待用户决定）：HarnessHub 的 `hermes acp` 作为网关查看器附着到用户正在运行的兼容网关

- **进程模型。** HarnessHub 启动的 `hermes acp` 附着到用户的网关，回合在网关进程里执行，共用它的凭据、MCP、钩子与审批策略；审批、取消、未知结果以网关的执行所有者为准。ADR-031 的“只运行 `hermes acp`、不触碰用户网关”随之修订为“只附着：不启动、不停止、不替换”。
- **建会话前的只读预检（A–E）。** 放在模型目录探测与 `open()` 之前，只读文件判断：`~/.hermes/gateway.sock` 是否存在；`gateway_state.json` 的 gateway_state、platforms、code_sha、pid（再用 `ps` 核对 pid 与启动时间）；`gateway.pid`、`gateway.lock` 的 JSON 记录（只读，不做 flock）；`launchctl print gui/<uid>/ai.hermes.gateway`；检出的 `install-stamp.json`。只有判定为 **A（兼容网关已在运行）** 时才发 `session/new`；判定为 B（会停掉旧网关换新）、C（会卡 60 秒等网关）、D（会拉起 launchd 服务）、E（会起无监督守护进程）时都不发请求，改为说明影响，并给出 Hermes 自己的命令（`hermes gateway status/start/restart`）。检查与使用之间仍有竞态，界面写明。
- **停止与清理。** 活动回合中关闭查看器之前先发 `session/cancel`，在有限时间内等到 `cancelled`。不得不直接杀进程时，Run 记为未知，工作区保持阻塞，直到新开的查看器 `session/load` 拿到的快照里这个会话没有 started 或 queued 的 admission。对 Hermes，进程关闭产生的 `cleanup.closed` 不再作为“原生工作已停止”的证据。这需要 `BackendResult` 的“未知结果”贯通 runtime、存储与页面（Run 记 unknown、不重发、展示 `/discard` 恢复说明），是同一任务的一部分，OpenClaw 的断线未知结果共用它。
- **代价（写进确认与 Harness 页）。** Hub 的回合与 QQ 在同一个网关进程里执行；选“Allow always”会写入所有会话共用的允许列表、影响 QQ；网关断线或查看器被杀时回合结果未知，恢复靠 Hermes 的 `/discard`；`hermes acp` 入口会经过 `hermes_cli.main` 的启动收尾（恢复被中断更新暂停的网关、跑迁移），改用 `hermes-acp` 入口能否避开未验证；usage 是会话累计值，要换算成本回合的增量；`fileBlocks` 可以恢复发 ACP 文件块（v0.22.4 的查看器会读取并内联 `file://` 资源，待验证）；Hermes 安装指纹（`install-stamp.json` 的 commit）变化时释放保留的进程，避免旧代码的查看器连新网关。
- **升级 Hermes 本身。** 按 ADR-044 由用户在终端运行 `hermes update`（先 `hermes backup`）：v0.22.x 会在改动检出前暂停网关，依赖就绪后以新代码重启，QQ 在这段时间离线；从 0.12.0 运行会落到 main，装完后 `hermes update --set-channel stable` 回到发布线或接受 main；`config.yaml` 从版本 23 迁到 50 以上、`state.db` 从 schema 11 迁到 31 以上，新网关写过后不能回滚；首次启动会把被中断的输入标为 unknown。HarnessHub 只显示命令与这些说明，不代跑。

### 用户答复前的现状（不是终态）

Hub 继续接入本机 0.12.0：不做任何版本提示，不升级 Hermes，不运行任何网关命令，本轮不做 Hermes 真实验收。代价：审批格受阻、60 秒期限、没有 HTTP MCP 与模式的现状不变。第三批 D2、D4 承接的条目（上面第 3、6、8 条）与网关无关，在答复前照常落地。

## 推荐

**A2，附条件。** 理由：这是 Hermes 上游唯一的方向，拒绝它等于让 Hermes 永远停在 0.12；附带的预检与“只附着、不启停”把对 QQ 的影响限制在“共用一个进程”这一点上，并写进界面。条件：

1. Hub 只在预检判定为 A 时建会话；绝不启动、停止或替换用户的网关，B–E 只给说明与 Hermes 自己的命令。
2. 审批卡写明“Allow always”会写入所有会话共用的允许列表。
3. 先在隔离的 `HERMES_HOME` 验协议与 16 格，再经用户同意、在 QQ 空闲时对真实网关做一次只附着的受控运行。
4. 60 秒例外在网关视图接入、改读 `approvals.timeout` 或网关报告的等待时间时删除。

用户选“暂不进入网关”时，Hub 按上面的现状继续接入 0.12.0，等用户之后再决定。

## 不做

- 不由 HarnessHub 代为运行安装脚本或 `hermes update`（ADR-044：会交互提问、要装 git 与 Python 的脚本不代跑；`hermes update` 会重启网关）。
- 不为 0.12.0 修补上游缺陷；不钉住任何版本；不按版本号拒绝建会话或开关功能。

## 验证（选定 A2 后）

- 协议测试：替身要模拟网关投影（附着、断线后的 unknown、`/discard`、-32603 加 `data.details`），不沿用进程内的替身；`allow_session` 被接受、三个模式作为选项显示；例外删除后审批期限不再提前关闭。
- 单元：预检 A–E 的只读判定各有正反样例；版本从 `install-stamp.json` 读取、没有 stamp 时退回 dist-info、dist-info 为 0.0.0 视为未知（第三批 D4，G012-OC5）；卸载白名单含 `hermes-acp`、`hermes-agent`。
- 真实，第一步（隔离）：在 v0.22.4 上用临时 `HERMES_HOME`（`~/.hermes` 之外、不在 `profiles/` 下、不建 `gateway.lock` 符号链接；config 里不配消息平台，`approvals.mode` 为 manual；模型凭据经用户同意后单独提供），让 `hermes acp` 为这个 home 起私有的 idle-exit 网关，覆盖 16 格与网关用例：回合中 Stop（`prompt.cancel` → cancelled）、回合中杀查看器（回合继续，Hub 记 unknown）、杀掉私有网关（unknown_execution → `/discard`）、load/resume 不存在的 id、受守卫的 `/model` 确认、三种模式、fork、两种审批说明文字、clarify 表单、usage 增量、session/list、/export。结束后执行 `HERMES_HOME=<临时目录> hermes gateway stop` 并删除目录：私有网关在 Hub 进程组之外，必须显式停止。
- 真实，第二步（受控附着）：在用户明确同意、QQ 空闲时对真实网关做一次只附着的运行，只在预检判定为 A 时进行；核对网关 pid 与启动时间不变、`gateway_state.json` 里 QQ 的平台状态不变、Hub 的会话行写进了用户的 `state.db`、关闭后会话在 FIFO 空闲时被结束。B–E 只用只读文件模拟判定，不去停或起用户的网关。
- 证据按仓库内格式入库；矩阵 `installation` 改为“真实验收版本 v0.22.4”、读表 `checkedOn` 同一提交更新（ADR-053 决定 8；不再有 `VERIFIED_VERSIONS`）。
