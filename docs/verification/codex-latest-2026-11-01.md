# Codex 0.166.0 真实重验（2026-11-01）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)第 6.4 节运行。基线按 [ADR-053](../decisions/0053-latest-version-baseline.md)：验收当日 Homebrew 本地记录里 cask `codex` 的最新版为 0.166.0（`brew update` 之后）。此前的记录：[0.162.1（2026-10-11）](native-models-2026-10-11.md)，只作证据；0.163.0 没有单独的真实记录。

## 升级经过（含一处 HarnessHub 缺陷）

- 先在 HarnessHub 的安装升级入口（ADR-044，Homebrew cask 路径）点了两次升级（管理任务 `management-cc5f0806-…-2095ca663d89` 等）。确认框正常（0.163.0 → 0.166.0，`brew upgrade --cask codex`，预演无依赖），但任务派发后失败：Homebrew 在 HarnessHub 的沙箱里把解包目录（任务的 stage，位于 `data/management/upgrade-job-*/homebrew-protected-*/homebrew-sandbox*/homebrew-unpack-*/bin`）rename 到 `/opt/homebrew/var/homebrew/tmp/.caskroom/codex/0.166.0/bin` 时报 `Operation timed out @ rb_file_s_rename`，两次下载都这样结束，`brew` 退出非零，任务记为 failed（UPGRADE_FAILED，dispatched true，版本仍为 0.163.0）。失败后 `/tmp/harnesshub-native-<uid>/codex/pending.json` 留下“结果待核实”标记，第二次点击在改动前就以 NATIVE_INSTALLATION_UNKNOWN 停下（设计如此）。
- 核实安装状态（Caskroom 只有 0.163.0，`brew list --cask --versions codex` 为 0.163.0）后删除该标记，在终端运行 `brew upgrade --cask codex`（HOMEBREW_NO_INSTALL_CLEANUP=1）完成升级：0.163.0 → 0.166.0，`codex --version` 为 codex-cli 0.166.0。这一步没有经过 HarnessHub。
- 缺陷待修（任务另立）：Hub 的 Homebrew cask 升级在沙箱里的 rename 失败原因未定（两目录同卷 `/System/Volumes/Data`，`~/Desktop` 不在 iCloud 同步目录里）；同时“待核实”标记没有页面入口，只能手工处理。

## 环境与证据头

- commit：`24e86e4`（uncommittedChanges：false）。
- 安装策略：official；平台：macOS 27.0.0。
- 安装（照抄证据头）：`codex` 0.166.0，Homebrew Cask，product，active。
- 入口：`codex-native`（codex-app-server，来源 system）。代理自报 codex 0.166.0；产品版本 0.166.0，取自 management。
- 环境：`env -i`，只带 HOME、USER、LOGNAME、SHELL、TERM=dumb、LANG、TMPDIR 与登录 shell（`zsh -lic`）的 PATH；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`。未设 `HH_REAL_MANIFEST`、`HH_REAL_MODEL_CODEX`（用 Codex 默认模型）。审批只“允许一次”（accept）。失败不重跑。升级前只读核对没有 `codex app-server daemon` 在运行。
- 运行时间：2026-11-01 14:05～14:11（本地时间），17 个套件（11 个原生套件，6 个不调用模型的旧 Provider/切换/流/私有安装/Homebrew 套件）。

## 守护

- 整轮：与 Claude Code、DeepSeek Harness 共用轮前、轮后快照（20 个位置），`guard.js compare` 退出码 0，没有改动。
- 套件内：每条结果都是 `guard.unchanged: true`，`changed` 为空（含失败的两个旧套件）。

## 命令与结果

每个套件都是 `RUN HH_REAL_HARNESSES=codex HH_REAL_EVIDENCE=<证据文件> node --test dist/tests/real/<套件>.real.js`，证据在 `~/.cache/harnesshub-acceptance/evidence/2026-11-01/codex-<套件>.json`（不入库）。

| 套件 | 其他变量 | 提示 | 结果 | 判据逐项 |
|---|---|---|---|---|
| native-catalog | — | 0 | 通过 | 8 个模型（默认 `gpt-6.1-sol`）；认证 ready；选项 collaboration_mode（default/plan）、approval_policy（untrusted/on-request/never）、sandbox（read-only/workspace-write/danger-full-access）、reasoning_effort（low/medium/high/xhigh/max/ultra）；命令 220 条（skills 作为命令）；清理 closed、exitCode 0 |
| native-resume | — | 2 | 通过 | 两轮都 completed，默认模型 gpt-6.1-sol；第二轮答对标记，`replayMixed: false`；首轮后绑定 ready；清理 closed |
| native-activity | `HH_REAL_APPROVAL=1 HH_REAL_OPTIONS_CODEX='{"approval_policy":"on-request","sandbox":"read-only"}'` | 1 | 通过 | 覆盖本机 `approval_policy=never` 后真实请求审批（“Codex 请求修改文件：notes.txt”，详情 7 行含 diff，选项 accept/decline/cancel，选 accept）；工具 shell（cat）、apply_patch、shell（cat）completed、详情可读、diff 可读；文件已编辑；用量含 reasoning，上下文窗口 828,400；清理 closed |
| native-activity | `HH_REAL_PLAN=1` | 1 | **未通过（按预期）** | 回合 completed，但没有工具、没有计划：模型回复“当前环境未提供计划/待办工具”。0.166.0 的 app-server 会话里仍没有计划工具，矩阵 plan 格保持受阻，说明改写为本次观察 |
| native-attachments | — | 2 | 通过 | 文件附件经 shell（cat）答对内容标记；图片附件答出“红色”；会话保持打开，附件副本稳定 |
| native-commands | — | 4 | 通过 | 目录含 compact 与 export（`fill: 0`）；首轮 completed；`/compact` completed；压缩后仍记得先前事实；`/export` completed |
| native-import | — | 2 | 通过 | 原程序自己（`codex exec`）建出线程后在列表中出现 1 个、有标题、来源 exec；接续时读到 2 条历史（complete、historyRead、tagQuoted）；再次接续被拒绝（`NATIVE_SESSION_CONFLICT`）；接续后的回合 completed、答对、绑定 ready |
| native-branch | — | 4 | 通过 | 源对话 completed；原生 fork 成功（引用 2 条，绑定 ready，`native: true`）；分支答对；隔离检查未泄漏 |
| native-subagent | — | 1 | 通过 | codex-subagent（下挂 1 个）、wait、子 Agent 的 shell 归属正确（linked）；settled、completed、清理 closed |
| native-extensions | — | 1 | 通过 | 列表来自原程序：技能 173（repo 1、user 167、system 5，全部启用）、MCP 服务器 13（10 个 notStarted、3 个 failed）、插件 43，未截断；工作区技能经原生命令 `skill:hh-echo` 调用，回合 completed、答出 HH-SKILL-OK |
| native-options | `HH_REAL_OPTIONS_CODEX='{"collaboration_mode":"plan"}'` | 1 | 通过 | 请求协作模式 plan，回报 plan；completed；配置文件未改（协作模式按能力提供，不再按版本号，ADR-034 修订） |
| codex-local-provider | — | 0 | 通过 | 正式 Gateway CLI 下的本地确定性 Provider 回合 completed |
| provider-switch | — | 0 | 通过 | 受管 Provider A→B 切换 completed |
| managed-install | — | 0 | 通过 | 从 npm 装入私有版本 0.160.0、0.162.1 并升级，completed |
| homebrew-native | — | 0 | 通过 | 原 Homebrew 的继承沙箱认证（G060-N04）completed |
| codex-session | — | 0 | **未通过** | “real Codex preserves public history across two turns and a new formal chat process using only a local deterministic provider”：本地 Provider 收到的第二轮请求里是 “first public Session turn” 而不是 “second public Session turn”（`assertProvider`）。属于旧私有安装/Provider 链路（G060-S01），与原生接入无关；原因未定，没有重跑 |
| live-web-stream | — | 0 | **未通过** | “real Codex delivers partial text over authenticated web SSE before model completion and survives reconnect”：SSE 流里没有出现 `event: session`（`assert.ok(lines.includes("event: session"))`）。同属旧链路（G060-P*）；原因未定，没有重跑 |

原生套件合计 19 次提示（上限 20）。没有运行：native-thinking、native-question（可选，手册 6.4）；手册 6.4 另提的“Hub 重启后 `thread/resume` 带与不带权限覆盖各一次”、“可信工作区 `.codex/config.toml` 的 MCP 预期”、“测试用 `CODEX_HOME` 里 `[plugins._default] enabled=false`”三项核对本轮没有做。

## 续接命令（人工）

本轮没有做（手册第 7 节的 `codex exec [--skip-git-repo-check] resume <id> "…"`）。

## 费用

- 提示 19 次，用的是用户自己的 ChatGPT 登录；6 个旧套件不调用模型。

## 局限与未验证

- 计划：0.166.0 的 app-server 会话里没有计划工具，plan 格受阻（观察见上）。
- 两个旧链路套件失败（codex-session、live-web-stream），原因待查；它们不改变原生格的结论。
- Hub 的 Homebrew cask 升级路径有缺陷（见“升级经过”），本次升级是在终端完成的。
- 能力读表（`src/adapters/capability-reads.ts` 的 codex 条目）本轮没有在 0.166.0 上重新核对，`checkedOn` 不改。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。

## 配方提交

与 Claude Code、DeepSeek Harness 的同日记录一起，在同一次提交里更新能力矩阵 `plan/native-capabilities.json` 的 codex `installation`（真实验收版本 0.166.0，2026-11-01 之前：0.162.1）与上表各格的 `evidence`、`note`；读表 `checkedOn` 不改。
