# OpenCode 2.2.5（OpenCode 2）真实重验（2026-11-01）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)第 6.5 节运行。用户 2026-10-22 答复 [ADR-053](../decisions/0053-latest-version-baseline.md) 第 2 题：直接换到 OpenCode 2。验收当日 V2 的最新发布是 2.2.5（homebrew/core `opencode`、npm `@opencode/cli`）。此前的记录：OpenCode 1 的 1.18.35（[2026-10-22 的 /compact 记录](opencode-compact-2026-10-22.md)等），只作证据。

## 替换经过（主代理在终端执行，HarnessHub 不代为运行）

1. 退路：`tar -czf ~/.cache/harnesshub-acceptance/opencode-v1-backup-<时间>.tgz .local/share/opencode .config/opencode`（77 MB，验收结束后删除）。
2. `brew update`；`brew uninstall --force anomalyco/tap/opencode`（删掉 Cellar 里 V1 的 1.1.21 与 1.18.35 两个 keg；该 tap 在 Homebrew 5 下标为 Untrusted，`brew info anomalyco/tap/opencode-v2` 会拒绝加载，所以没有选 tap 的 `opencode-v2`）。
3. `brew install opencode`（homebrew/core，bottle 2.2.5）：`/opt/homebrew/bin/opencode -> ../Cellar/opencode/2.2.5/bin/opencode`，`opencode --version` 为 v2.2.5。
4. 首次运行 `opencode models`（只列模型）触发了 V2 的数据迁移：`~/.local/share/opencode/opencode.db-wal` 从 0 增长到 3.5 MB，`opencode.db` 主文件大小不变。本机 `~/.config/opencode/opencode.json` 只有 `$schema` 一个键，没有 V1 写法的内容要迁；`tui.json` 与 `cli.json` 都不存在。
5. `brew upgrade --dry-run --formula opencode` 解析到 2.2.5 自身（已是最新）。
6. Hub 侧：重启 4317（commit `266e863`）后 Harness 页显示 Homebrew 安装 2.2.5。能力页的方言标注本轮没有在页面上看。

## 环境与证据头

- commit：`266e863`（uncommittedChanges：false）。
- 安装策略：official；平台：macOS 27.0.0。
- 安装（照抄证据头）：`opencode` 2.2.5，Homebrew（homebrew/core），product，active。代理自报 OpenCode 2.2.5。
- 入口：`opencode-binary`（acp-v1，来源 system）。
- 环境：`env -i`，只带 HOME、USER、LOGNAME、SHELL、TERM=dumb、LANG、TMPDIR 与登录 shell（`zsh -lic`）的 PATH；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`。未设 `HH_REAL_MANIFEST`。除 native-attachments 外用 OpenCode 的默认模型 `opencode/big-pickle`。审批只“允许一次”（once）。失败不重跑。
- 运行时间：2026-11-01 15:14～15:16（本地时间），11 个套件。

## 守护

- 套件内：每条结果都是 `guard.unchanged: true`，`changed` 为空（opencode 清单：`~/.config/opencode/opencode.json`、`opencode.jsonc`、`AGENTS.md` 与共享清单）。整轮前后没有另拍 opencode 的快照。

## 命令与结果

每个套件都是 `RUN HH_REAL_HARNESSES=opencode HH_REAL_EVIDENCE=<证据文件> node --test dist/tests/real/<套件>.real.js`，证据在 `~/.cache/harnesshub-acceptance/evidence/2026-11-01/opencode-<套件>.json`（不入库）。

| # | 套件 | 其他变量 | 提示 | 结果 | 判据逐项 |
|---|---|---|---|---|---|
| 1 | native-catalog | — | 0 | 通过 | 8 个模型（全部是 `opencode/*-free` 系列，默认 `opencode/big-pickle`；本机没有配置其他提供方）；认证 unknown（V2 不宣告认证方法）；选项 mode（build / plan）；命令 4 条，含 V2 自己宣告的 `compact`；`loadSession` true，会话能力 additionalDirectories/close/delete/fork/list/resume；提示能力 image、embeddedContext；MCP 能力 http、sse；清理 closed、exitCode 0 |
| 2 | native-resume | — | 2 | 通过 | 两轮都 completed（end_turn）；第二轮答对标记，`replayMixed: false`；绑定 ready；清理 closed（`session/load` 用对话自己的工作区作 cwd，照常） |
| 3 | native-thinking | — | 1 | 通过 | completed；思考 73 个字符，与回复分开 |
| 4 | native-activity | `HH_REAL_APPROVAL=1` | 1 | 通过 | 两次审批真实发出并被遵守：命令 `cat notes.txt`（选项 once / always / reject，选 once）与编辑 notes.txt（详情 7 行含 diff，选 once）；工具 shell、read、edit 等 completed、详情可读；文件已编辑；清理 closed |
| 5 | native-attachments | `HH_REAL_MODEL_OPENCODE=opencode/mimo-v2.6-flash-free` | 2 | 通过 | 文件附件经 read 工具答对标记；图片附件答出“红色”（V2 没有 `models --verbose`，Hub 只试一次、安静退回代理声明；识图以这次真实回合为准） |
| 6 | native-commands | — | 3 | 通过 | V2 自己宣告 `compact`（`commands.compact: true`，Hub 不补入，`fill: 0`）；目录没有 export，Hub 也不为 OpenCode 提供 `/export`（`commands.export: false`，没有运行）；首轮 completed；`/compact` completed（无文本）；压缩后仍记得先前事实 |
| 7 | native-options | `HH_REAL_OPTIONS_OPENCODE='{"mode":"plan"}' HH_REAL_EXPECT_UNCHANGED=1` | 1 | 通过 | 请求 plan，回报 plan；completed；工作区文件未改 |
| 8 | native-options | `HH_REAL_COMMAND=/init HH_REAL_COMMAND_FILE=AGENTS.md` | 1 | **未通过** | `/init` 作为原生命令被接受并 completed（`nativeCommand: true`），但工作区里没有生成 AGENTS.md（`created: false`）。V2 的 `/init` 是否仍写 AGENTS.md、或由默认模型 big-pickle 决定是否写，本轮没有查 |
| 9 | native-import | — | 2 | 通过 | 原程序自己建出会话后在列表中出现 1 个、有标题；接续时读到 2 条历史（complete、historyRead、tagQuoted）；再次接续被拒绝（`NATIVE_SESSION_CONFLICT`）；接续后的回合 completed、答对、绑定 ready |
| 10 | native-branch | — | 4 | 通过 | 源对话 completed；原生 fork 成功（引用 2 条，绑定 ready，`native: true`）；分支答对；隔离检查未泄漏 |
| 11 | native-extensions | — | 0 | 通过（无列表） | `discoverExtensions` 对 OpenCode 2 为 null：没有列表、没有发提示、没有验证任何列表。矩阵的 skills、mcp、plugins 格状态不变 |

合计 17 次提示。手册第 4 节 OpenCode 的上限是 ≤ 10 次；本轮是换到 V2 后的重新基线，模型全是 `opencode/*-free`（不计费），审批代理（Fable 5.1，用户授权）把本轮上限放宽到 ≤ 20 次，记在这里。

没有运行：能力写入的真实往返（手册 6.5 的人工项：技能停用/启用、MCP 写入/移除）；续接命令（`opencode run -s <id> "…"`）；`native-question`、`native-subagent`（不适用或未接出）。

## 费用

- 17 次提示，全部走 `opencode/*-free` 免费模型，没有费用。

## 局限与未验证

- `/init` 没有生成 AGENTS.md（见第 8 行）；原因待查。
- 原生扩展列表为 null：OpenCode 2 的 skills、mcp、plugins 三格仍没有列表证据；能力页的两种配置方言标注与写入往返本轮没有在真机上核对（配置文件只有 `$schema`，没有可对照的写法）。
- V1 → V2 的数据迁移只观察到 WAL 增长，没有核对会话是否完整迁入（迁移的可逆性上游没有说明；V1 的副本保留到验收结束）。
- 读表 `checkedOn` 已由实现分支改为 2.2.5（按源码核对），本轮没有在真机上逐项核对读取位置。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。

## 配方提交

同一次提交更新能力矩阵 `plan/native-capabilities.json` 的 opencode `installation`（真实验收版本 2.2.5，OpenCode 2，homebrew/core；2026-11-01 之前：OpenCode 1 的 1.18.35）与上表各格的 `evidence`、`note`；[ADR-039](../decisions/0039-continue-in-the-original-program.md) 的 OpenCode 行本轮没有真实核对续接命令，不改。
