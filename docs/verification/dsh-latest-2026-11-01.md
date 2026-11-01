# DeepSeek Harness 0.2.1-rc.5 真实重验（2026-11-01）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)第 6.3 节运行。基线按 [ADR-053](../decisions/0053-latest-version-baseline.md)：验收当日 npm `latest` 为 0.2.1-rc.5（`npm view @deepseek-ai/dsh dist-tags`：latest 与 next 都是 0.2.1-rc.5，alpha 为 0.2.2-alpha.2），本机先经 HarnessHub 的安装升级入口（ADR-044）从 0.2.1-rc.2 升到它（管理任务 `management-f24dad34-…-c1e0edc789d8`，completed，命令 `~/.nvm/versions/node/v26.11.1/bin/npm install --global --prefix ~/.nvm/versions/node/v26.11.1 @deepseek-ai/dsh@0.2.1-rc.5`，受保护配置无改动）。此前的记录：[0.2.0-rc.2（2026-10-22）](dsh-rc2-reverification-2026-10-22.md)，只作证据。

## 环境与证据头

- commit：`24e86e4`（uncommittedChanges：false）。
- 安装策略：official；平台：macOS 27.0.0。
- 安装（照抄证据头）：`dsh` 0.2.1-rc.5，npm 全局（nvm v26.11.1），product，active。
- 入口：`dsh-native`（acp-v1，来源 path，不是 custom-entry）。入口版本 0.2.1-rc.5；产品版本 0.2.1-rc.5，取自 management。dsh 的 ACP 自报版本仍恒为 0.0.1，不作版本依据。
- 环境：`env -i`，只带 HOME、USER、LOGNAME、SHELL、TERM=dumb、LANG、TMPDIR 与登录 shell（`zsh -lic`）的 PATH；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`。未设 `HH_REAL_MANIFEST`、`DSH_PERMISSION_MODE`、`HH_REAL_APPROVAL`。失败不重跑。
- 运行时间：2026-11-01 14:05～14:07（本地时间），8 个套件。

## 守护

- 整轮：轮前对 claude、codex、dsh 与共享清单拍快照（20 个位置，只记摘要），轮后比较，见[本日汇总](#配方提交)。
- 套件内：8 个套件的每条结果都是 `guard.unchanged: true`，`changed` 为空。

## 命令与结果

每个套件都是 `RUN HH_REAL_HARNESSES=dsh HH_REAL_EVIDENCE=<证据文件> node --test dist/tests/real/<套件>.real.js`，证据在 `~/.cache/harnesshub-acceptance/evidence/2026-11-01/dsh-<套件>.json`（不入库）。

| 套件 | 其他变量 | 结果 | 判据逐项 |
|---|---|---|---|
| native-catalog | — | 通过 | 3 个模型（默认 `deepseek-v4-flash`，另有 `deepseek-flash`、`deepseek-v4-pro`；id 形如 `["deepseek-official","deepseek-v4-flash"]`）；设置项 `reasoning_effort`（thought_level，取值 off/low/high/max）；原生命令 0 个；`loadSession` false，会话能力 close/list/resume；不声明图片、音频与 embeddedContext；MCP 能力 http；认证 unknown（dsh 不宣告认证方法）；清理 closed、exitCode 0 |
| native-resume | 不设 MODEL | 通过 | 两轮都 completed（end_turn），选用默认模型；第二轮 sourceRunIds 为空、答对标记；首轮后绑定 ready（throughRunIsFirst）；清理 closed |
| native-thinking | 不设 OPTIONS | 通过 | completed；思考 109 个字符，与回复分开（`thinkingInReply: false`），回复答对标记 |
| native-activity | 不设 APPROVAL | **未通过 1 项** | completed；5 个工具（todo_write、bash、read、edit、todo_write）都已提交且详情可读；文件已编辑；上下文占用已回报（窗口 1,000,000）；清理 closed；没有审批请求（`permissions: []`）。未通过的是 `editDiff`：rc.5 的 edit 工具仍不发 diff（原接口缺口，与 rc.2 相同，按预期记录） |
| native-attachments | — | 通过 | 文件附件 completed，经 read 工具答对内容标记；dsh 不声明图片输入，图片在派发前被拒绝（`ATTACHMENT_UNSUPPORTED`），没有发给模型；会话保持打开，附件副本稳定 |
| native-import | — | 通过 | dsh 自己的 ACP 入口建出会话后在列表中出现 1 个（无标题、无来源标注）；接续时如实标出没有可读历史（messages 0，complete false，historyRead false）；同一原生会话再次接续被拒绝（`NATIVE_SESSION_CONFLICT`）；接续后的回合 completed、答对标记、绑定 ready |
| native-options | `HH_REAL_OPTIONS_DSH='{"reasoning_effort":"low"}'` | 通过 | 请求 low，回报 low；completed |
| native-branch | — | 通过 | 源对话 completed（绑定 ready）；dsh 不能原生分支，派发后报 `NATIVE_FORK_UNAVAILABLE`，原生绑定归档；分支回退到公共历史（引用 2 条）并答对标记，`native: false`；隔离检查未泄漏 |

没有运行：native-commands、native-config（dsh 没有原生命令）、native-question、native-subagent、native-extensions（未接出或不适用，手册 6.3）。手册 6.3 另提的“升级前旧版本建的会话、升级后 `session/resume`”本轮没有做（升级前没有留下会话）。

## 续接命令（人工）

本轮没有做（手册第 7 节的 `dsh headless --session-id <id> "…"`）。rc.2 上的一次性形式核对见 2026-10-22 的记录；命令文本未变，凭据前提（终端环境的 `DEEPSEEK_API_KEY`、工作区 `.env` 或 `~/.dsh/.env`）照旧写在详情栏旁。

## 费用

- 提示 12 次（8 个套件），模型调用更多（含工具循环）。dsh 不回报 token 用量，只回报上下文占用。
- 用的是默认 `deepseek-v4-flash`。按 2026-10-22 记录的估法（每次调用输入约 1.1 万 token、以 v4-pro 高峰未命中价作上界），本轮上界远低于 ¥3；flash 单价更低，实际花费更少。

## 局限与未验证

- 审批：bash 与 edit 都没有请求审批，ACP 入口不回报生效的权限预设；矩阵的 approvals 格仍记为受阻，说明按本次观察改写。
- 图片输入：rc.5 的 acp profile 仍不声明图片输入，只能确认 Hub 在派发前拒绝。
- `editDiff` 判据对 dsh 不可能满足（原接口缺口），套件没有按 Harness 豁免，本次不改套件、不重跑。
- 能力读表（`src/adapters/capability-reads.ts` 的 dsh 条目）本轮没有在 rc.5 上重新核对读取位置，`checkedOn` 不改；手册 6.3 提到的 `$DSH_AGENTS_HOME` 第二根仍是已知差距。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。

## 配方提交

与 Claude Code、Codex 的同日记录一起，在同一次提交里更新能力矩阵 `plan/native-capabilities.json` 的 dsh `installation`（真实验收版本 0.2.1-rc.5，2026-11-01 之前：0.2.0-rc.2、源码版 0.2.1-alpha.1）与各格 `evidence`；读表 `checkedOn` 不改（见上）。
