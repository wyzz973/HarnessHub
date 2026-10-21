# DeepSeek Harness 0.2.0-rc.2 真实重验（2026-10-22）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)运行。依据：[ADR-048](../decisions/0048-harness-scope-and-workbuddy.md) 用户决定 4（以官网 0.2.0-rc.2 为精确基线，尽快重验，花费不超过 ¥3），审批代理的条件见下文“环境”。重验之前，已验证版本是源码构建的 0.2.1-alpha.1，按 [ADR-044](../decisions/0044-macos-official-channels.md) 只作为历史证据；本次在官网 npm 渠道的安装上重新验收。

## 环境与证据头

- commit：`d34f537`（uncommittedChanges：false）。
- 安装策略：official；平台：macOS 27.0.1。
- 安装（照抄证据头）：`dsh` 0.2.0-rc.2，npm 全局（nvm v26.11.1），product，active。
- 入口：`dsh-native`（acp-v1，来源 path）。入口版本 0.2.0-rc.2；产品版本 0.2.0-rc.2，取自 management。运行时的 ADR-038 判定是 unverified（当时的已验证版本为 0.2.1-alpha.1），这正是本次要改的。dsh 的 ACP 自报版本恒为 0.0.1，不作版本依据。
- 环境：`env -i`，只带 HOME、USER、LOGNAME、SHELL、TERM=dumb、LANG、TMPDIR 与登录 shell 的 PATH；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`。未设 `HH_REAL_MANIFEST`，未设 `DSH_PERMISSION_MODE`。审批只“允许一次”（本次 dsh 没有请求审批）。失败不重跑。
- PATH 的读法：与 4317 一样用 `zsh -lic`（交互式登录 shell）。手册原写的 `-l -c` 不执行 `~/.zshrc`，读不到 nvm 的目录，`dsh` 因此不在 PATH 上；本次按 4317 的启动方式取 PATH，两者逐项相同，手册已随本记录更正。
- 运行时间：2026-10-22 02:13～02:16（本地时间），共 8 个套件与 1 次人工续接核对。

## 守护

- 整轮：轮前、轮后各拍一次 dsh 与共享清单的快照（13 个位置，只记摘要），`guard.js compare` 退出码 0，没有改动。
- 套件内：8 个套件的每条结果都是 `guard.unchanged: true`，`changed` 为空。

## 命令与结果

每个套件都是 `RUN HH_REAL_HARNESSES=dsh HH_REAL_EVIDENCE=<证据文件> node --test dist/tests/real/<套件>.real.js`，证据在 `~/.cache/harnesshub-acceptance/evidence/2026-10-22/dsh-<套件>.json`（不入库）。

| 套件 | 其他变量 | 结果 | 判据逐项 |
|---|---|---|---|
| native-catalog | — | 通过 | 3 个模型（默认 deepseek-v4-flash，另有 deepseek-flash、deepseek-v4-pro）；设置项 `reasoning_effort`（thought_level，取值 off/low/high/max）；原生命令 0 个；`loadSession` false，会话能力 close/list/resume；不声明图片与音频输入；MCP 只声明 http；认证状态 unknown；清理 closed、退出码 0 |
| native-resume | — | 通过 | 两轮都 completed（end_turn）；第二轮 `resumed: true`，sourceRunIds 为空，答对标记，未混入回放；绑定 ready；清理 closed |
| native-thinking | — | 通过 | completed；思考 73 个字符，与回复分开，未混进回复 |
| native-activity | — | **未通过 1 项** | completed；6 个工具（todo_write、bash、read、edit、read、todo_write）都已提交，详情可读（有输入与输出，未截断）；文件已编辑；上下文占用已回报（窗口 1,000,000）；清理 closed。未通过的是 `editDiff`：edit 工具的详情不带差异。这与能力矩阵“工具详情”一格记的原接口缺口一致（kind 恒为 other，不带差异与位置），不是回退。dsh 本轮没有请求任何审批（`permissions` 为空） |
| native-attachments | — | 通过 | 文件附件 completed，经 read 工具答对内容标记；dsh 不声明图片输入，图片在派发前被拒绝（`ATTACHMENT_UNSUPPORTED`），没有发给模型；会话保持打开，附件副本稳定 |
| native-options | `HH_REAL_OPTIONS_DSH='{"reasoning_effort":"low"}'` | 通过 | 请求 low，回报 low；completed |
| native-import | — | 通过 | dsh 自己的 ACP 入口建出会话后，在列表中出现 1 个（无标题）；接续时如实标出没有可读历史（messages 0，complete false）；同一原生会话再次接续被拒绝（`NATIVE_SESSION_CONFLICT`）；接续后的回合由原生会话答对标记，sourceRunIds 0 |
| native-branch | — | 通过 | 源对话 completed；dsh 不能原生分支，派发后报 `NATIVE_FORK_UNAVAILABLE`，原生绑定归档；分支回退到公共历史（引用 2 条）并答对标记，`native: false`；隔离检查未泄漏 |

没有运行：native-commands、native-config（dsh 没有原生命令）、native-question、native-subagent、native-extensions（未接出或不适用，见手册 6.3）。

## 续接命令（人工）

- 做法：手册第 7 节。私有 web 实例（官网策略、临时数据与租约目录、它自己的一次性令牌，没有碰 4317），新建 dsh 对话，发送“请记住标记 R-<随机数>。只回复“好的”，不要调用任何工具。”；经 `GET /api/v1/sessions/:id/native-resume` 取原生会话 ID（当时返回 `note: version-unverified`，ID 36 个字符）；在同一工作区用同样的干净环境运行 `dsh headless --session-id <id> "我让你记住的标记是什么？只回复标记本身。"`。
- 结果：退出码 0；标准输出只有一行，就是标记本身；标准错误为空；答对标记。实例按 SIGTERM 退出码 0，临时目录已删除。
- 这是 0.2.0-rc.2 上一次性形式的真实核对；rc.2 没有 tui profile，交互形式不给（[ADR-039](../decisions/0039-continue-in-the-original-program.md) 2026-10-21 补记）。

## 费用

- 提示 14 次（8 个套件 12 次，续接核对 2 次），模型调用约 22 次（含工具循环）。dsh 不回报 token 用量，只回报上下文占用。
- 按 2026-10-11 的接入记录，dsh 每次调用输入约 1.1 万 token。用[阶段报告](phase-report-2026-10-12.md)里的最高价估上界：deepseek-v4-pro 高峰期缓存未命中，输入每百万 token 1.32 美元，按 1 美元约 7.1 元折算，并且把全部输入都算作未命中。这样约 24 万 token，约 ¥2.3。
- 实际用的是默认的 deepseek-v4-flash，同一系统提示的重复部分通常会命中缓存，实际花费应低于这个上界。本轮上限 ¥3。

## 局限与未验证

- 审批：本轮 bash 与 edit 都没有请求审批。ACP 入口不回报生效的权限预设，也不处理 `/permission`，所以仍看不到 dsh 当时按哪个预设运行。矩阵的 approvals 格仍记为受阻，说明改写为本次观察。
- 图片输入：rc.2 的 acp profile 仍不声明图片输入，只能确认 Hub 在派发前拒绝；模型是否识图未验证。
- 思考按整块还是逐字到达，本轮没有记录（套件只记字符数与是否混入回复）。
- native-activity 的 `editDiff` 判据对 dsh 不可能满足（原接口缺口）。套件没有按 Harness 豁免这一项；是否加豁免另行决定，本次不改套件、不重跑。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。

## 配方提交

同一次提交完成以下改动：

- `VERIFIED_VERSIONS.dsh` 改为 `["0.2.0-rc.2", "0.2.0-rc.2"]`，并删除 `unofficial`。
- 能力矩阵中 dsh 的安装说明改为官网 npm 0.2.0-rc.2，去掉 `historical`；重验各格的证据指向本记录。
- 依赖旧数字的单元测试与浏览器测试（G054-FZ3 的替身版本）随之更新。
- ADR-038、ADR-039 补记。
- 目录包版本本来就是 0.2.0-rc.2。读表区间 `>=0.2.0-rc.2 <0.3.0` 覆盖新的已验证区间两端。`versionConsistency` 为空。
