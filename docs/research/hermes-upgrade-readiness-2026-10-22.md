# Hermes v0.22.2 与 main 的升级就绪（只读研究，2026-10-22）

用户决定 5（[ADR-048](../decisions/0048-harness-scope-and-workbuddy.md)）：Hermes 先只读研究 v0.22.2 标签与当时的 main，出 ADR 草案后再定升不升级，期间停在 0.12.0 维护。本页记录事实；选项与推荐见 [ADR-051](../decisions/0051-hermes-upgrade-route.md)。

## 方法与边界

- 纯只读。没有运行 `hermes`（包括 `--version`、`acp --check`），没有触碰用户的 Hermes 网关（launchd `ai.hermes.gateway`），没有读 `~/.hermes/config.yaml`、`.env`、`auth.json`、`state.db`。
- 本机安装 `~/.hermes/hermes-agent`：只用 `git -C … log/show/ls-tree/tag/grep` 读本地对象，没有 fetch。这个检出的 HEAD 是 2026-05-06 的 a0556b861f，但本地已经有到 v0.22.3 的 206 个标签（此前某次拉取带来的，不是本轮），所以 v0.22.2（commit d923a5eb）与 v0.22.3（5b147ab0）的树都能在本地读；main 当日顶端 4d04303 不在本地，只从 GitHub 读了几个文件。
- 网络：GitHub API 与 raw 文件（清单见文末）。主代理此前抓取的 `hermes-releases/`（v0.21.6～v2026.9.11 的发布说明）、`hermes-main-docs/`（2026-10-18 的 main 文档）、`hermes-main-src/`（同日 main 的 `acp_adapter/server.py`、`gateway_server.py` 等）也用到了；它们没有记录 commit，引用时注明“main（2026-10-18 抓取）”。
- 引用写作 `<版本>:<路径>:<行>`；`0.12.0` 指本机 a0556b8。

## 问题 1：版本线与 `hermes update`

### 发布节奏与版本号格式

| 标签 | 日期 | `pyproject` 版本 | 说明 |
|---|---|---|---|
| v2026.4.30 | 2026-04-30 | 0.12.0 | 本机 HEAD（05-06）在它之后 649 个提交（`git describe`：`v2026.4.30-649-ga0556b861f`），`hermes_cli/__init__.py:17-18` 仍写 `0.12.0`、`2026.4.30` |
| v2026.5.7 … v2026.9.24 | 05-07 … 09-24 | 0.13.0 … 0.21.5 | 标签名按日期，发布标题带语义版本（GitHub releases：“Hermes Agent v0.21.5 (v2026.9.24)”）；大致每周一到两个 |
| v0.21.6、v0.21.7 | 10-08、10-11 | 0.0.0 | 改为语义版本标签，`pyproject` 版本改成占位的 0.0.0；v0.21.6 是“Docker 与 Hermes Cloud 的稳定标签”，v0.21.7 加上桌面与安装器（发布说明） |
| v0.22.0 | 10-13 | 0.0.0 | “The Threshold Release”：稳定发布渠道、每台机器一个网关、插件目录 600 项（`hermes-releases/v0.22.0.md:20-54`） |
| v0.22.1 | 10-14 | 0.0.0 | “从错误的提交构建，带进了未发布的网关工作”（`v0.22.2.md` 开头）；本地树里有 `acp_adapter/gateway_server.py` |
| **v0.22.2** | 10-15 | 0.0.0 | commit d923a5eb；v0.22.1 本该是的样子；`acp_adapter/` 14 个文件，**没有** `gateway_server.py` |
| v0.22.3 | 10-21 | 0.0.0 | `acp_adapter/` 22 个文件，含 `gateway_server.py`、`gateway_commands.py`、`gateway_media.py`、`gateway_reply.py`、`gateway_session_meta.py`、`elicitation.py`、`modes.py`、`catalog.py` |
| main | 10-21 16:00Z | 0.0.0 | 4d04303；与 2026-10-18 抓取的 main 一样有网关投影 |

另有每日 `v0.22.2+canary.<时间戳>` 标签。从 v0.21.6 起版本不再写在 `pyproject.toml`（`v0.22.2:pyproject.toml:7` 是 `version = "0.0.0"`），而由 `hermes_cli/version_info.py` 解析：先读构建时写的 `install-stamp.json`（`baseVersion`、`displayVersion`、`commit`、`updateMechanism`；`version_info.py:1-10`、`:130-200`；路径由 `pm/paths.py:34` 给出，在检出根目录），没有 stamp 的源码安装用 git 标签推导（`:246-259`）；`hermes_cli/__init__.py` 的 `__version__` 改为按需从 stamp 读取（`v0.22.2:hermes_cli/__init__.py:7-33`）。

### `hermes update` 拉什么

- **0.12.0**：`hermes_cli/main.py:6967` 起。`git fetch origin`（:7070）；不在 `main` 就先自动 stash 再 `checkout main`（:7114-7116）；`pull --ff-only origin main`（:7185），不能快进则 `reset --hard origin/main`（:7198）；然后重装依赖、迁移 `config.yaml`，最后“自动重启**所有**网关”（:7482）。参数只有 `--gateway`、`--check`、`--no-backup`、`--backup`、`--yes`（:10394-10430）。没有钉住标签的办法；git 坏掉时的 ZIP 后备也下载 `archive/refs/heads/main.zip`（:5821-5833）。所以从 0.12.0 运行 `hermes update`，落点是 main 当日顶端（今天是带网关投影的 4d04303 之后），不是 v0.22.2。
- **v0.22.2**：`hermes_cli/subcommands/update.py` 的参数：`--gateway`、`--check`、`--plan`、`--list-venv-holders`、`--no-backup`、`--backup`、`--yes`、`--keep-stash`、`--branch NAME`、`--switch-branch`、`--force`、`--force-venv`、`--set-channel`、`--install-id`、`--channel`、`--no-gateway-restart`。轨道 `stable`、`canary`、`main`（`hermes_cli/update_channel.py:47-49`）；跟随官方 origin 的源码检出默认 `stable`，其他默认 `main`（:140-164）；`stable` 是仓库最新发布的 GitHub release 的精确提交（`hermes_cli/source_releases.py:172-182`），检出比最新发布还新时等待下一个发布（:86-95）；`--set-channel` 持久化，`--channel` 只对本次（`update.py:76-108`）。没有“钉住某个标签”的参数；`--channel` 的名字“从发布归档解析，不是内置列表”，能否写具体发布名：未核实。
- **发布说明的表述**（`hermes-releases/v0.22.0.md:20`、`:83`）：源码安装默认“从发布到发布”而不是跟踪 main 的每个提交；要 main 用 `hermes update --set-channel main`；降到更老的发布视为回滚，必须询问；fork 留在 main。`v0.22.2.md:262`：CLI 与安装脚本的安装用 `hermes update` 或重跑安装一行命令回到发布线。
- **安装脚本 v0.22.2**（`scripts/install.sh`）：`--branch NAME`、`--commit SHA`、`--dir PATH`（:24-25、:45-56、:68）；对已有检出，没有 `--commit` 时按 `config.yaml` 里记录的轨道修复（:592-601），否则 fetch 并快进到 `origin/<branch>`，不能快进就备份本地提交后对齐远端（:647-700）；`--commit` 必须在所选分支上（:753-757）。这是官方脚本里唯一能钉住精确提交（例如 d923a5eb）的途径。
- **旧更新器的接管**：新树带 `hermes_cli/_old_updater.py`（从正在运行的历史更新器帧 `_cmd_update_impl`/`cmd_update` 接手，:1-30）与 `_update_takeover.py`（切换检出后同步依赖、发布启动器、登记网关重启义务，:1-40、:68-79）。也就是说，0.12.0 的更新器把树拉到 main 之后，由新树完成收尾并重启网关；接管不会把检出移回 stable 轨道（`_update_takeover.py` 里没有轨道逻辑）。

## 问题 2：`hermes acp` 的进程模型

| 项 | 0.12.0（本机） | v0.22.2 | v0.22.3 / main |
|---|---|---|---|
| 进程模型 | 进程内：`hermes acp` 自己构造 `AIAgent`，模型调用在这个进程里 | 同左：`acp_adapter/entry.py:218` 直接 `HermesACPAgent()`，`server.py` 没有 `__new__`；配置里的 MCP 服务器由本进程启动（`entry.py:210` 仍读 `HERMES_ACP_SKIP_CONFIGURED_MCP`） | **网关投影**：`server.py:245-249` 的 `__new__` 在没有传入 `session_manager` 时返回 `GatewayACPAgent`；`gateway_server.py:1`“ACP projection of the profile gateway; never constructs an execution owner”；`entry.py:202` 仍写 `HermesACPAgent()`，没有独立运行的参数 |
| 网关投影的启用条件 | 不存在 | 不存在 | 无条件。`hermes_cli/gateway_client.py:262-288` 的 `connect_gateway` 先 `ensure_gateway_runtime(home, idle_exit=True)`：没有网关就为这个 home 启动一个空闲即退出的无托管守护；已有兼容的网关就附着；**同一 home 上旧版 Hermes 留下的网关会被停掉并换成当前版本的**（`gateway_runtime.py:390-404` 的说明）；别的安装或更新的 Hermes 的网关则拒绝 |
| 没有网关时能否独立运行 | 能 | 能 | 不能独立；会自己起一个空闲退出的网关（同上）。main 文档：“`hermes acp` / `hermes-acp` 作为网关守护进程的查看器运行，自己从不启动 `config.yaml` 的 MCP 服务器”（`hermes-main-docs/user-guide_features_acp.md` “Host integration”） |
| 认证方法 | 只在提供方凭据可解析时公布 agent 方法（`server.py:463-492`，[ADR-033](../decisions/0033-native-catalog-cache-and-readiness.md)） | `acp_adapter/auth.py:30-50`：凭据可解析时公布 `AuthMethodAgent(id=<提供方>)`，并**总是**公布 `TerminalAuthMethod(id="hermes-setup", args=["--setup"])`（:8） | 同 v0.22.2（`hermes-main-src/acp_adapter_server.py:27`、`:540`） |
| 审批缺陷与期限 | `acp_adapter/permissions.py:43` 的回调不接受 `allow_permanent`，`tools/approval.py:594-599` 以它调用 → 异常 → deny；等待硬编码 60 秒（`permissions.py:30`） | 回调接受 `allow_permanent`（`permissions.py:136`）；期限为 `approvals.timeout`（默认 300 秒，`:117-125`、`:142`），多出 `allow_session` 一档（`:34`、文档“Session-scoped edit auto-approval”） | 同 v0.22.2 |
| 修复落在哪个标签 | — | 本地逐标签核对 `acp_adapter/permissions.py`：v2026.4.30、v2026.5.7 没有 `allow_permanent`，**v2026.5.16（0.14.0，2026-05-16）起有**；可配置期限从 **v2026.9.21（0.21.4）** 起（提交 b9ba9d503f，2026-09-18，“approval prompts wait approvals.timeout instead of a hardcoded 60 s”）。[ADR-031](../decisions/0031-hermes-and-deepseek-harness.md) 写的“上游 v0.21.6 已接受”成立，但修复更早 | — |
| `/model` 回复 | `server.py:1151` `_cmd_model`：“Model switched to: <模型>\nProvider: <提供方>” | `acp_adapter/commands.py:139-148`：同样的两行文本；切换经 `_switch_model` 走与 CLI 相同的目录、别名与凭据校验，“ACP never persists”（`server.py:322-345`）；另有 `set_session_model`（:1022） | 同 v0.22.2（`hermes-main-src/acp_adapter_server.py:321-345`） |
| 会话导出 | `hermes sessions export - --session-id <id>`（HarnessHub 现用，`src/adapters/control/hermes.ts:115`） | 仍有：`hermes_cli/subcommands/sessions.py:77-96`，`OUTPUT` 为 `-` 时输出到 stdout（只限 jsonl/trace），`--format jsonl|md|qmd|html|trace`，默认 jsonl，`--session-id` | 未核实 |
| 模式 | 无 | `server.py:240-252` `_MODES`：`default`（问过再改）、`accept_edits`、`dont_ask`，映射到编辑审批策略；`set_session_mode`（:1060）、`set_config_option`（:1074） | 同，另有 `modes.py` |
| 计划 | 无 | todo 工具结果转成 plan 更新（`server.py:165`） | 同 |
| 提问（request_user_input） | 无 | 无（grep 为 0） | v0.22.3 新增 `acp_adapter/elicitation.py`；main 的 `gateway_server.py:884` `_answer_clarify`：未核实其 ACP 形态 |
| 工具失败状态 | 全部报 `completed`，失败只在文本里（ADR-031） | `acp_adapter/tools.py:168-185`：结构化的工具失败映射为 ACP `failed` | 同 |
| 启动器 | `~/.local/bin/hermes` | main 文档：近期安装同时写 `hermes` 与 `hermes-acp` 两个启动器，`hermes update` 给旧安装补 `hermes-acp`（`user-guide_features_acp.md` “Buzz Desktop”）；v0.22.2 的 `install.sh` 里没有直接写这个名字（启动器由 PM 发布，未核实） | 同 |

## 问题 3：迁移

| 项 | 0.12.0 | v0.22.2 | 依据 |
|---|---|---|---|
| `config.yaml` 版本 | `_config_version` 23（`hermes_cli/config.py:1310`） | 50（`hermes_cli/config_defaults.py:2721`） | 迁移由 `hermes update`（`--yes` 自动套用不需要输入的项，API key 的提问跳过，`update.py:41-44`）或 `hermes config migrate` 完成；每次成功解析与改写前都在 `backups/config/config.yaml.<原因>.<时间>` 留副本（`hermes-main-docs/user-guide_configuration.md:217`）；更新前备份 `updates.pre_update_backup: quick|full|off`（:209-215）；坏掉的 `config.yaml` 退回上一份好的副本（`v0.22.0.md:154`） |
| `state.db` schema | `SCHEMA_VERSION = 11`（`hermes_state.py:36`） | 31（`hermes_state_common.py:283`；`hermes_state*.py` 拆成 33 个模块） | v2026.9.11（0.21.2）是 state.db 修复专版（`v2026.9.11.md:1-24`）；v0.22.0 起默认自动清理结束超过 90 天的会话、可回收 25% 时才 VACUUM（`v0.22.0.md:145`）。升级后能否回到 0.12.0 读同一份库：未核实（没有找到降级说明） |
| `SOUL.md` | `~/.hermes/SOUL.md` | 不变，仍是系统提示第一槽、默认自动播种（`user-guide_features_personality.md:9-18`） | HarnessHub 不写它（[ADR-045](../decisions/0045-unified-capability-management.md)） |
| 技能 | `~/.hermes/skills` 递归 + `skills.external_dirs`，不读 `~/.agents/skills`；`skills.disabled`、`platform_disabled` | 用户级不变：`external_dirs` 只收录存在的目录并去重（`agent/skill_utils.py:321-336`），`skills.disabled`/`platform_disabled` 同名（`hermes_cli/skills_config.py:28-53`）；**新增** `skills.create_dir`（:349）与项目级 `<项目根>/.hermes/skills`、`<项目根>/.agents/skills`（:490-496）；优先级 project → local → create_dir → external_dirs（`user-guide_features_skills.md:498`）。用户级 `~/.agents/skills` 仍只能经 `external_dirs`（:408-415） | ADR-045 的放置方式不变 |
| `mcp_servers` | 只有 stdio | 新增 HTTP：Streamable HTTP、`transport: sse`、`auth: oauth`、`trust: full|untrusted`、mTLS（`v0.22.2:website/docs/reference/mcp-config-reference.md:28-71`） | HarnessHub 的 Hermes MCP 写法（`capability-reads.ts` 的 `hermes` 样式）要接受 `url` 条目 |
| 插件 | `plugins.enabled` 缺失则一个都不启用；`hermes plugins enable` 经 `save_config` 整份重写 | 仍是 `plugins.enabled` 允许列表（config schema v21+，已装的用户插件在升级时自动“祖父化”进 enabled，`user-guide_features_plugins.md:342`）；写入只改本次翻转的行，但最终仍经 `_admit_and_save_plugin_sets` → `save_config` 整份写（`hermes_cli/plugins_cmd_toggle.py:127-150`、`plugins_cmd.py:586-607`） | 语义比较的漂移检测仍然需要 |
| Hooks | `config.yaml` 的 `hooks` | 另有网关 hooks：`~/.hermes/hooks/<名>/HOOK.yaml + handler.py`，放进去就是启用，不受 `plugins.enabled` 约束（`v0.22.2:website/docs/user-guide/features/hooks.md:13`、`:29-39`） | `capability-reads.ts` 的 Hermes hooks 读法要加这一来源 |
| 版本读取 | HarnessHub 读 `venv/lib/python3.*/site-packages/hermes_agent-0.12.0.dist-info/METADATA`（`src/infrastructure/discovery/packages.ts:95-109`、`installation-channels.ts:21-29`） | `pyproject` 版本是 0.0.0，PM 用可编辑安装（`pm/environment.py:133-156` 提到项目的 `__editable__` 指针），所以 dist-info 名推断为 `hermes_agent-0.0.0.dist-info`，HarnessHub 会读到 0.0.0；真实版本在 `install-stamp.json`（打包构建）或 git 标签（源码安装），ACP `initialize` 回报的是 `get_version_info().base_version`（`server.py:528-542`） | 升级前必须改版本读取（见 ADR-051） |

## 问题 4：对本机 QQ 网关的风险

- **升级本身会重启网关**：0.12.0 的更新器装完后重启所有网关（`main.py:7482`）；v0.22.2 的更新器同样做“fleet restart”，有 `_restart_macos_launchd_gateways`（`hermes_cli/update_cmd.py:55-63`），可用 `--no-gateway-restart` 推迟。QQ 会断开片刻；这与 [ADR-044](../decisions/0044-macos-official-channels.md) 第五轮裁决里给用户的说明一致。
- **v0.22.2 不改变 HarnessHub 的进程模型**：`hermes acp` 仍在自己的进程里跑模型，不连接、不启动、不停止网关，与 ADR-031“只运行 `hermes acp`，不触碰用户的 Hermes 网关”相容。
- **v0.22.3 与 main 会**：`hermes acp` 变成网关的查看器，HarnessHub 的每一回合都在用户的网关进程（`ai.hermes.gateway`，也服务 QQ）里执行；审批、取消、未知结果都由网关的“执行所有者”裁定（`gateway_server.py`、`v0.22.1.md:77-78`“Project execution-owned approvals to ACP viewers”“Attach ACP transport to canonical session execution”）。更危险的一条：如果用户升级了检出但 launchd 网关还在跑旧代码，HarnessHub 启动的新 `hermes acp` 会按 `ensure_gateway_runtime` 的规则把那个旧网关**停掉并换成**当前版本（`gateway_runtime.py:394-398`）——这是对网关的直接操作，HarnessHub 现在没有任何机制阻止。
- **`hermes update` 的落点决定了哪种情况会发生**：从 0.12.0 运行它落到 main（网关投影）；从 v0.22.x 运行它落到 stable 轨道头（今天是 v0.22.3，同样是网关投影）。要停在 v0.22.2，只能用 `install.sh --commit d923a5eb…` 这类精确钉住，而且之后不能再运行 `hermes update`。

## 未核实

1. `--channel`/`--set-channel` 能否指定某个具体发布名（钉住 v0.22.2）而不是只有 stable/canary/main。
2. v0.22.2 之后 `hermes-acp` 启动器由哪一步写入（`install.sh` 里没有该名字）。
3. `hermes acp`（v0.22.2）在目录探测时是否仍写入一行空会话（ADR-033 的处理依据）。
4. state.db 从 31 回到 11 是否可能；Hermes 是否有官方降级说明。
5. main 的提问（elicitation）在 ACP 上的形态，以及它在网关投影下的审批/取消/未知结果语义（只读了文件头与函数名）。
6. v0.22.2 在 `hermes acp` 下的 `/compact`、`/export` 命令表，以及 `session/list` 的分页与过滤（只看到 `list_sessions` 签名）。
7. PM 的可编辑安装是否仍产生 `hermes_agent-0.0.0.dist-info`（推断自 `pyproject` 与 `pm/environment.py`，没有执行安装）。
8. v0.22.2 的 Hermes 工具失败文本（“<工具> failed: …”、“BLOCKED: …”）是否保持原样（只核对了结构化失败映射）。

## 本轮用过的命令

本机只读：`git -C ~/.hermes/hermes-agent` 的 `log`、`tag --list`、`branch -a`、`remote -v`、`describe`、`rev-parse`、`cat-file -t`、`for-each-ref`、`ls-tree`、`show <标签或提交>:<路径>`、`grep <提交> -- <路径>`、`log <标签> -S<字符串> -- <路径>`、`tag --contains`；`ls`、`grep`、`sed -n` 读本机检出的 `hermes_cli/main.py`、`hermes_cli/__init__.py`、`hermes_cli/config.py`、`hermes_cli/skills_config.py`、`hermes_state.py`、`acp_adapter/permissions.py`、`acp_adapter/server.py`、`tools/approval.py`、`pyproject.toml`、`hermes_agent.egg-info/PKG-INFO` 与 `venv/lib/python3.*/site-packages` 的目录名。

网络（全部只读 HTTPS）：

| 目标 | 内容 |
|---|---|
| `api.github.com/repos/NousResearch/hermes-agent` | `git/ref/tags/v0.22.2`、`git/tags/7b77e29e…`（标签对象）、`git/ref/tags/v0.22.3`；`commits/main`；`tags?per_page=60`；`releases?per_page=15`；`contents/hermes_cli?ref=4d04303…`；`contents/acp_adapter?ref=d923a5eb…`、`?ref=v0.22.3`；`contents/hermes_cli/subcommands?ref=d923a5eb…`；`contents/acp_adapter/permissions.py?ref=d923a5eb…`（raw 媒体类型） |
| `raw.githubusercontent.com/NousResearch/hermes-agent/v0.22.2`（或 d923a5eb） | `pyproject.toml`（第一次 SSL 失败，重试成功）、`acp_adapter/permissions.py`、`tools/approval.py`、`hermes_cli/__init__.py`、`hermes_cli/version_info.py`、`hermes_cli/update_channel.py`、`hermes_cli/release_channels.py`、`hermes_cli/source_releases.py`（第一次 429，重试成功）、`hermes_cli/steward.py`、`hermes_cli/subcommands/update.py`、`scripts/install.sh`、`hermes_cli/_update_takeover.py`、`hermes_cli/_old_updater.py` |
| `raw.githubusercontent.com/NousResearch/hermes-agent/4d04303…`（main） | `pyproject.toml`、`acp_adapter/permissions.py`、`tools/approval.py`、`hermes_cli/__init__.py` |

没有下载归档，没有运行任何脚本；临时目录与研究其他内容一并删除。
