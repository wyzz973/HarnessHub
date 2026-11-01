# ADR-051：Hermes 最新版的接入方式

状态：accepted。用户 2026-10-22 答复：允许 HarnessHub 的 Hermes 会话进入正在运行的网关；Hermes 由用户交 HarnessHub 支配（[ADR-053](0053-latest-version-baseline.md)“待用户决定”第 3 题）。A2 的建会话前只读预检 2026-11-01 落地，见文末“实现”；真实两步验收待运行。此前：proposed，2026-10-22（第二批 C6 的只读研究草案，原题“Hermes 的升级路线”；同日按 ADR-053 重写——按用户“接入不限定版本，默认按最新版”的原则重排选项，只剩一个待用户决定的选项 A2；当时没有代码改动）。事实见 [Hermes v0.22.2 与 main 的升级就绪](../research/hermes-upgrade-readiness-2026-10-22.md)与 ADR-053“研究结论摘要”里关于 v0.22.4 的部分。依据 [ADR-031](0031-hermes-and-deepseek-harness.md)、[ADR-044](0044-macos-official-channels.md)、[ADR-048](0048-harness-scope-and-workbuddy.md) 决定 5（已按 ADR-053 修订为“基线是最新正式版”）与 ADR-053。

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
6. **发现方式。** 版本从 `<root>/install-stamp.json` 的 displayVersion（缺则 baseVersion）读取；有 stamp 就以它为准，stamp 里没有可用的版本值时为未知；没有 stamp 时才退回 venv 的 dist-info（0.12 布局），dist-info 为 0.0.0 或读不到时为未知，版本未知的安装照样算官网安装；程序改为 `.hermes/bin/hermes`（0.12 布局的 `venv/bin/hermes` 作兼容候选）；启动器与卸载白名单加 `~/.local/bin/hermes-acp`、`~/.local/bin/hermes-agent`；常驻网关的进程名正则补 `hermes_cli.main --profile <名> gateway run` 与 `.hermes/bin/hermes … gateway run` 两种形态。仍然只读文件，不运行程序。第三批 D4 承接。
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

## 实现（2026-11-01，分支 fb5/hermes，基于 24e86e4）

依据本机检出 `~/.hermes/hermes-agent`（v0.22.4+70.g4e58c72，commit 4e58c721c8cf…，stable 轨道）的源码核对；下面的行号都是这个检出的。只读了源码与状态文件，没有运行任何启动、停止或重启网关的命令。

### 落地内容

- `src/adapters/control/hermes-gateway.ts`：纯判定 `judgeGateway(facts)`（A–E 与 in-process）、只读事实读取 `readGatewayFacts`、`resolveHermesHome`（与 `src/infrastructure/capabilities/service.ts` 同一规则）、`launchdLabel`、`parseLaunchctlPrint`/`parsePsRow`、真实宿主查询 `hostQueries`（`/bin/launchctl print`、`/bin/ps -o lstart=,command=`，各 5 秒，可注入）与 `gatewayRefusalMessage`。
- `src/adapters/control/acp.ts`：新扩展点 `beforeConnect()`，在 `initializeOnce()` 发第一条请求之前运行——进程在第一条请求时才 spawn（`JsonRpcProcess.start()`），所以抛出时没有任何进程；抛出的 ControlError 走 initialize 失败的同一路径，之后 `open()`、目录读取与再次 `initialize()` 以同一错误拒绝，`close()` 返回 `exitCode/signal` 为 null 的清理证据。
- `src/adapters/control/hermes.ts`：构造函数第三个参数 `preflight`（默认真实读取；测试注入判定）；`beforeConnect()` 用 `{ ...options.env, ...launch.env }` 与 `launch.executable` 调预检，非 A 抛 `NATIVE_GATEWAY_UNAVAILABLE`，消息含判定字母、解释、Hermes 命令与竞态说明。目录探测（`binding-factory.ts` 的 `probe()` → `initialize()` → `open()`）与会话的 `open()` 都经过它。
- `web/src/api.ts`：`NATIVE_GATEWAY_UNAVAILABLE` 的产品文案（页面只拿到错误码，见“消息到达哪里”）。
- 测试：`tests/unit/hermes-gateway.test.ts`（G032-NC31、NC32），`tests/protocol/acp.test.ts` 新增用例（G032-NC33），既有 Hermes 用例注入判定 A。
- 计划：G032 新增 owns 与三条用例；`hermes-gateway.ts` 登记在 `complete-native-capabilities` 切片——`tools/check_design.py` 要求切片 allowed_files 里的文件由该切片的任务拥有，而 harness-focus 的任务（G063、G065）只拥有工具与 ADR，所以没有按原计划登记到 harness-focus。

### 预检比较的事实与 Hermes 的对应逻辑

`hermes acp` 的进程是查看器（`acp_adapter/entry.py:201-210`）；它在第一次需要网关的请求时才连接（`acp_adapter/gateway_server.py:152-176` `_client()` → `connect_gateway()`，连接后只核对 `runtime.describe` 的 `profile_id` 等于自己的 home）。`connect_gateway`（`hermes_cli/gateway_client.py:262-299`）调用 `ensure_gateway_runtime(home, idle_exit=True)`（`hermes_cli/gateway_runtime.py:390-495`），结果不可附着时抛 `Gateway <state>: <reason>`（即第三批 D2 已映射为 `NATIVE_GATEWAY_UNAVAILABLE` 的文字）。`ensure_gateway_runtime` 的分支与预检的对应：

| Hermes 的行为 | 源码 | 预检读取的事实 | 判定 |
|---|---|---|---|
| 更新占有安装（`.hermes-update-in-progress` 标记）→ `draining/update_paused`，不启动不替换 | gateway_runtime.py:325-363；hermes_cli/update_lock.py:58 | home 或检出下存在该标记 | C |
| 经 `gateway.sock` 的 `identify` 得到 `ready`、`runtime_protocol == 1`、`served_profiles` 含本 home、capabilities 含 session-authority-v1 → 附着 | gateway_runtime.py:98-152、441-442；gateway_runtime_discovery.py:143-200 | `gateway_state.json` 的 `gateway_state == "running"`，其 pid 经 `ps` 存活、启动时间与 `start_time`（macOS 为进程出生时间 ×100，gateway/status.py:472-503）相差 ≤ 5 秒、命令行是网关（`gateway run/restart`、`gateway/run.py`、`-m gateway.run`；排除 osascript 包装，status.py:592-663）、记录的 `hermes_home` 不是别的 profile，且 `gateway.sock`（或 `gateway.sock.path` 指向的 `control.sock`）存在 | A（代码一致时） |
| 网关的 `runtime_protocol` 比查看器旧 → `incompatible/runtime_protocol` → 像 `hermes gateway stop` 一样停掉它一次并启动新的（`draining/replaced`） | gateway_runtime.py:366-387、394-398 | 文件里读不到 runtime_protocol：用 `gateway_state.json` 的 `code_sha`（网关启动时的提交，status.py:799-813）与检出 `install-stamp.json` 的 `commit`（`hermes update` 完成时写入，hermes_cli/source_stamp.py:15-47）比较，不同或任一侧未知 | B |
| `starting`/`draining`/`conflict` → 等待，到 60 秒报告 `starting/deadline`；控制套接字超时同样 | gateway_runtime.py:20、117-121、435-440、488-489 | `gateway_state` 不是 running/stopped/startup_failed 且进程在；running 但没有套接字；`gateway.lock`/`gateway.pid` 的进程在而没有 running 状态（`missing_owner_state` 的 starting，gateway_runtime_discovery.py:233-244）；launchd 任务 `state = running` 而网关未发布 | C |
| `absent` 且已有服务 → `launchctl kickstart gui/<uid>/<label>`（已加载）或 `launchctl bootstrap`（plist 在 `~/Library/LaunchAgents` 但未加载） | gateway_runtime_service.py:186-218、276-296；标签规则 37-58 | `launchctl print gui/<uid>/<label>` 退出 0（已加载）或 113（未加载）与 plist 是否存在；无法查询也归此 | D |
| `absent` 且没有服务 → `spawn_unmanaged_gateway(idle_exit=True)` | gateway_runtime.py:461-483 | 以上都没有 | E |
| 检出没有 `acp_adapter/gateway_server.py`（v0.22.2 及以前）：`hermes acp` 在自己进程里运行 | 本检出该文件存在；背景一节 | 文件不存在 | in-process：不判定网关、照常启动（ADR-053 决定 1，任何版本都能建会话） |

校正背景一节的简化说法“旧版网关会被它停掉换新”：查看器只替换运行协议不同的旧网关；同协议、旧代码的网关它会直接附着（陈旧代码由 `hermes_cli/gateway_runtime_cli.py:28-32` 的 `client_code_sha` 对比在 CLI 侧提示“must restart it rather than re-attach”），所以 B 的说明写明两种可能，HarnessHub 对两者都不动手。pid 存活与启动时间的核对沿用 Hermes 自己的身份链（gateway_runtime.py:243-271；status.py:756-770、883-896）。home 解析：`HERMES_HOME`，否则 `~/.hermes/active_profile` 指向的存在的 profile 目录，否则 `~/.hermes`（hermes_constants.py:188-195；hermes_cli/main.py `_apply_profile_override`），比较时都取 realpath（Hermes 的 `_canonical_hermes_home`、`service_suffix` 也是）。检出：可执行文件在 `<检出>/.hermes/bin/hermes(-acp)` 时取它，否则官方安装布局 `~/.hermes/hermes-agent`。

只读边界：只读 home 下的 `gateway.sock`、`gateway.sock.path`、`gateway_state.json`、`gateway.pid`、`gateway.lock`、`.hermes-update-in-progress`、`active_profile`，检出下的 `install-stamp.json`、`acp_adapter/gateway_server.py`、`.hermes-update-in-progress`，以及 plist 是否存在；不做 flock，不连套接字，不读 `.env`、`auth.json`、`config.yaml`、`state.db`（单元测试以读取轨迹和 mode 000 的凭据文件证明）。

### 消息到达哪里

- `ControlError.message`（判定字母、解释、命令、竞态说明）完整到达：协议层、`src/cli/control.ts`、`CleanupEvidence.protocolFailure.message`（≤ 512 字符）。
- 页面只拿到错误码：目录读取经 `src/web/server.ts` 变成 `HttpError(502, code, 固定文案)`；Run 经 `runtime.ts` 的 `fault()` 只保留 code（ControlError 的 message 换成固定句）；有 Provider 注入时 `RedactedHarnessControl.safe()` 也只保留 code。所以 `web/src/api.ts` 的 `failureMessage` 新增 `NATIVE_GATEWAY_UNAVAILABLE` 的通用文案（不区分 B–E，写明不代为启停、给出 `hermes gateway status/start/restart`）。把判定字母与解释带到页面留给后续。

### 未做（如实列出）

- “未知结果”契约（`BackendResult` 的 unknown 贯通 runtime、存储与页面；回合中关闭查看器先 `session/cancel`、杀进程后 Run 记 unknown、`cleanup.closed` 不再作为 Hermes 原生工作已停止的证据），与 OpenClaw 断线共用：未做。`unknown_execution` 仍按第三批 D2 只在诊断里透出 `/discard`。
- 0.12 的 60 秒审批例外（ADR-053 例外登记）原样保留；其退出条件——改读 `approvals.timeout` 或网关报告的等待时间——不在本次范围。
- 预检是文件层近似：读不到 `identify` 的 `runtime_protocol`、`served_profiles`、`capabilities`，用 code_sha/commit 与状态文件代替；检查与 `session/new` 之间的竞态只写明不解决。
- `HERMES_TUI_GATEWAY_URL`（gateway_client.py:272-282，远程网关）未处理：预检仍按本地 home 判断，可能误拒，不会误启动。多路复用的 served secondary（gateway_runtime.py:209-237）与 `parked_profiles`、systemd/s6/Windows 分支未实现（只做 macOS，ADR-044）。
- 真实运行：“验证”一节的第一步（隔离 `HERMES_HOME` 的私有网关）与第二步（对真实网关只附着一次）都没有运行；默认的真实宿主查询 `hostQueries` 没有在真实网关上验证，只验证了解析函数。审批卡“Allow always 写入共用允许列表”的说明已由第三批 D2 落地（`OPTION_NOTES`）。
- `hermes-acp` 入口能否避开 `hermes_cli.main` 的启动收尾、`fileBlocks` 恢复、usage 增量换算、安装指纹变化时释放保留进程：未做。
