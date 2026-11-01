# Claude Code 2.1.316 + claude-agent-acp 0.99.1 真实重验（2026-11-01）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)第 6.2 节运行。基线按 [ADR-053](../decisions/0053-latest-version-baseline.md)：验收当日 npm `@anthropic-ai/claude-code` 的 latest 为 2.1.316（stable 2.1.309），本机 nvm 下的那份已是 2.1.316（Claude 自更新）；适配器 `@agentclientprotocol/claude-agent-acp` 的 npm latest 为 0.99.1，本机先经 HarnessHub 的安装升级入口（ADR-044）从 0.94.0 升到它（管理任务 `management-5adda43e-…-f2e14a4ea677`，completed，命令 `/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @agentclientprotocol/claude-agent-acp@0.99.1`，Node ≥22 要求由 /opt/homebrew/bin/node 26.13.0 满足，受保护配置无改动）。此前的记录：[2.1.296（2026-10-11）](claude-real-and-approval-detail-2026-10-11.md)、[2.1.306 + 0.89.1（2026-10-22）](claude-2.1.306-rebaseline-2026-10-22.md)，只作证据。

## 环境与证据头

- commit：`24e86e4`（uncommittedChanges：false）。
- 安装策略：official；平台：macOS 27.0.0。
- 安装（照抄证据头）：`claude` 2.1.316，npm 全局（nvm v26.11.1），product，active；另有 `claude` 2.1.302，npm 全局（Homebrew 的 Node.js），product，不是当前使用的那份；`claude-agent-acp` 0.99.1，npm 全局（Homebrew 的 Node.js），adapter，active。
- 入口：`claude-acp-npm`（acp-v1，来源 system）。入口版本 0.99.1；产品版本 2.1.316，取自 installation（证据头不运行 `--version`）。代理自报 `@agentclientprotocol/claude-agent-acp` 0.99.1。
- 环境：`env -i`，只带 HOME、USER、LOGNAME、SHELL、TERM=dumb、LANG、TMPDIR 与登录 shell（`zsh -lic`）的 PATH；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`。未设 `HH_REAL_MANIFEST`。除 native-import、claude-mcp 外都设 `HH_REAL_MODEL_CLAUDE=haiku`（目录证据的 `modelIds` 里有 `haiku`）。审批只“允许一次”（allow-once）。失败不重跑。
- 运行时间：2026-11-01 14:04～14:09（本地时间），13 个套件。

## 守护

- 整轮：轮前对 claude、codex、dsh 与共享清单拍快照（20 个位置，只记摘要），三家全部套件结束后再拍一次，`guard.js compare` 退出码 0，没有改动（`~/.claude.json` 只比较 `mcpServers`）。
- 套件内：每条结果都是 `guard.unchanged: true`，`changed` 为空。

## 命令与结果

每个套件都是 `RUN HH_REAL_HARNESSES=claude HH_REAL_EVIDENCE=<证据文件> node --test dist/tests/real/<套件>.real.js`，证据在 `~/.cache/harnesshub-acceptance/evidence/2026-11-01/claude-<套件>.json`（不入库）。

| # | 套件 | 其他变量 | 提示 | 结果 | 判据逐项 |
|---|---|---|---|---|---|
| 1 | native-catalog | 不设 MODEL | 0 | 通过 | 13 个模型（默认 `opus`；别名 default/opus/fable/sonnet/haiku 与 8 个完整 id）；认证 ready；选项 mode（default/acceptEdits/plan/auto/bypassPermissions）、effort（default/low/medium/high/xhigh/max）、fast、ultracode（on/off）、agent（6 个取值）；命令 225 条；`loadSession` true，会话能力 additionalDirectories/close/delete/fork/list/resume/systemPrompt（没有 subagents，与 0.94.0 相同）；提示能力 image、embeddedContext；MCP 能力 http、sse；清理 closed、exitCode 0 |
| 2 | native-resume | — | 2 | 通过 | 两轮都 completed（end_turn），模型 haiku；第二轮答对标记，`replayMixed: false`，sourceRunIds 为空；首轮后绑定 ready，第二轮后绑定 ready（throughRunIsSecond）；清理 closed |
| 3 | native-activity | `HH_REAL_APPROVAL=1 HH_REAL_OPTIONS_CLAUDE='{"mode":"default"}'` | 1 | 通过 | mode=default 真实生效：编辑前请求审批（“Edit notes.txt”，详情 7 行含 diff，选项 allow-once / allow-with-updates / reject，选 allow-once）；工具 Bash（cat）、Read、Edit 都 completed、详情可读、diff 可读；文件已编辑；用量回报 cacheWrite/cachedInput/input/output/total，上下文窗口 1,000,000，费用按会话累计（USD）；清理 closed |
| 4 | native-commands | — | 4 | 通过 | 目录含 compact 与 export（Hub 不补入，`fill: 0`）；首轮 completed；`/compact` completed（无文本）；压缩后仍记得先前事实（`remembered: true`）；`/export` 由 Hub 复制转录，completed |
| 5 | native-config | `HH_REAL_CONFIG_OPTION=model HH_REAL_CONFIG_FROM=haiku HH_REAL_CONFIG_TO=sonnet HH_REAL_CONFIG_COMMAND="/model sonnet"` | 4 | 通过 | 首轮回报 haiku；`/model sonnet` 后回报 sonnet，下一轮仍为 sonnet（`carried: ["sonnet"]`，epoch 2）；切回后回报 haiku |
| 6 | native-attachments | — | 2 | 通过 | 文件附件答对内容标记（模型直接读取随附内容，没有调用工具）；图片附件答出“红色”；会话保持打开，附件副本稳定 |
| 7 | native-import | 不设 MODEL | 2 | 通过 | 原程序自己（`claude -p`）建出会话后在列表中出现 1 个、有标题；接续时读到 2 条历史（complete、historyRead、tagQuoted）；同一原生会话再次接续被拒绝（`NATIVE_SESSION_CONFLICT`）；接续后的回合 completed、答对标记、绑定 ready |
| 8 | native-branch | — | 4 | 通过 | 源对话 completed（绑定 ready）；原生 fork 成功（引用 2 条，绑定 ready，`native: true`）；分支答对标记；隔离检查未泄漏。0.99.1 的 fork 会启动分支会话，耗时本轮没有单独记录 |
| 9 | native-question | — | 1 | 通过 | 1 个原生提问“选择一种颜色”（两个选项加 submit/skip/cancel，有输入框与详情）；选“蓝色”后回合 completed、答对 |
| 10 | native-subagent | — | 1 | 通过 | Agent 工具（think 类，下挂 2 个子工具）、子 Agent 的 Bash 与 SubagentHandback 都归属到父工具下（linked）；回合 settled、completed、清理 closed |
| 11 | native-extensions | — | 0 | 通过（无列表） | Claude 驱动的 `discoverExtensions` 仍为 null：没有列表、没有发提示、没有验证任何列表（与 2026-10-22 相同）。矩阵的 skills、mcp、plugins 格保持“真实未验证” |
| 12 | native-options | `HH_REAL_OPTIONS_CLAUDE='{"effort":"low"}'` | 1 | 通过 | 请求 effort=low，回报 low；completed |
| 13 | claude-mcp | — | 0 | 通过 | G064-M5：私有家目录、禁网沙箱里 `claude mcp add-json` / `remove` 往返，先在私有副本预演；outcome completed，用户配置未改 |

合计 23 次提示（上限 25），模型以 haiku 为主（native-import 用 Claude 默认模型）。

没有运行：native-thinking（新模型默认 `thinking.display=omitted`，矩阵按受阻记录）；`HH_REAL_PLAN`（会话里没有 TodoWrite 类计划工具，受阻）；手册 6.2 第 3b 项（回合中途人工停止）；`/remote-control`（Hub 不支持，也不在验收里运行）。

## 续接命令（人工）

本轮没有做（手册第 7 节的 `claude -p --resume <id> "…"`）。2.1.306 上的核对见 2026-10-22 的记录；命令文本未变。

## 费用

- 提示 23 次，Haiku 为主；用的是用户自己的 Claude 订阅，周额度足够，没有换账号。
- 手册 6.2 要求核对“每回合用量不再多出一次预测请求”（`promptSuggestions=false`）：套件证据只记录用量字段的有无，本轮没有按请求计数核对，记为未验证。

## 局限与未验证

- 命令目录只记录了条数（225），本轮没有逐条核对 `/remote-control` 是否在目录里（ADR-053 裁决 6 要求 Hub 隐藏它）。
- 原生扩展列表：`discoverExtensions` 为 null，Claude 的 skills、mcp、plugins 三格仍没有真实证据。
- 能力读表（`src/adapters/capability-reads.ts` 的 claude 条目）本轮没有在 2.1.316 上重新核对读取位置，`checkedOn` 不改。
- 登录状态在页面上的显示本轮没有看（手册 6.2 末段）。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。

## 配方提交

与 Codex、DeepSeek Harness 的同日记录一起，在同一次提交里更新能力矩阵 `plan/native-capabilities.json` 的 claude `installation`（真实验收版本 2.1.316 + claude-agent-acp 0.99.1，2026-11-01 之前：2.1.296、2.1.306 + 0.89.1）与上表各格的 `evidence`；读表 `checkedOn` 不改（见上）。
