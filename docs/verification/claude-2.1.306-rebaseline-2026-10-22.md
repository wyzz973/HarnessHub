# Claude Code 2.1.306 真实重验（2026-10-22）

逐项状态以[能力矩阵](native-capability-matrix.md)为准；按[真实验收操作手册](../engineering/real-acceptance.md)第 6.2 节的配方运行。依据：[ADR-048](../decisions/0048-harness-scope-and-workbuddy.md) 用户决定 3（Claude 按版本区间认可，区间扩为 [2.1.296, 2.1.306]）。审批代理的条件：不超过 25 次提示，以 Haiku 为主，1 次压缩；登录 shell PATH 上第一个 `claude` 必须是 nvm 的 2.1.306；先核实适配器是 0.89.1；不选 allow_always；周额度不足即停；守护前后比对。

## 环境与证据头

- commit：`d971661`（uncommittedChanges：false）。
- 安装策略：official；平台：macOS 27.0.1。
- 只读核对：`which -a claude` 依次是 nvm 的 `~/.nvm/versions/node/v26.11.1/bin/claude` 与 `/opt/homebrew/bin/claude`，第一个是 nvm。
- 安装（照抄证据头）：
  - `claude` 2.1.306，npm 全局（nvm v26.11.1），product，active。
  - `claude` 2.1.302，npm 全局（Homebrew 的 Node.js），product，未使用。
  - `claude-agent-acp` 0.89.1，npm 全局（Homebrew 的 Node.js），adapter，active。
- 入口：`claude-acp-npm`（acp-v1，来源 path）。入口版本 0.89.1，适配器与已验证的 0.89.1 相同，所以适配器区间不变。产品版本 2.1.306，取自当前使用安装的渠道记录（`installation`），证据头不运行 `--version`。运行时的 ADR-038 判定是 unverified（当时的已验证版本为 2.1.296/0.89.1），这正是本次要改的。
- 环境：与 [dsh 重验](dsh-rc2-reverification-2026-10-22.md)相同。`env -i`，PATH 用 `zsh -lic` 读取，与 4317 相同；`HH_REAL_TMP=$HOME/.cache/harnesshub-acceptance`；未设 `HH_REAL_MANIFEST`。除另注外，会话模型都用目录里的 `haiku`（`HH_REAL_MODEL_CLAUDE=haiku`）。
- 运行时间：2026-10-22 02:23～02:29（本地时间），共 12 个套件与 1 次人工续接核对。

## 守护

- 整轮：轮前、轮后各拍一次 claude 与共享清单的快照（11 个位置；`~/.claude.json` 只比较 `mcpServers`），`guard.js compare` 退出码 0，没有改动。
- 套件内：12 个套件的每条结果都是 `guard.unchanged: true`。

## 命令与结果

证据在 `~/.cache/harnesshub-acceptance/evidence/2026-10-22/claude-<套件>.json`（不入库）。12 个套件全部通过。

| 套件 | 其他变量 | 提示 | 判据逐项 |
|---|---|---|---|
| native-catalog | 不设 MODEL | 0 | 13 个模型（默认 opus，含 `haiku`、`sonnet`），224 条原生命令；设置项 mode（default、acceptEdits、plan、auto、bypassPermissions）、effort（default、low、medium、high、xhigh、max）、fast（on/off）、agent（default 与 5 个插件代理）；认证状态 ready；`loadSession` true，会话能力 additionalDirectories、close、delete、fork、list、resume、subagents；声明图片与嵌入上下文输入，MCP 声明 http、sse；清理 closed |
| native-resume | — | 2 | 两轮 completed（end_turn），所选模型 haiku；第二轮 `resumed: true`，sourceRunIds 为空，答对标记，未混入回放 |
| native-activity | `HH_REAL_APPROVAL=1`，`HH_REAL_OPTIONS_CLAUDE='{"mode":"default"}'` | 1 | 编辑前请求审批：选项 allow-once、allow-with-updates、reject，选了 allow-once，审批卡带差异（7 行）；Bash、Read、Edit 三个工具已提交，详情可读，Edit 带差异，Read 带位置；文件已编辑；回合用量（输入、输出、缓存读写、合计）、上下文占用（窗口 1,000,000）与会话费用（USD）都有回报；清理 closed |
| native-commands | — | 4 | `/compact` 与 `/export` 都在目录里；首轮 completed；`/compact` 完成，压缩以活动显示；压缩后仍记得先前事实（sourceRunIds 0）；`/export` 由 Hub 复制本会话转录，产出 1 个 ndjson 文件 |
| native-config | `HH_REAL_CONFIG_OPTION=model`，FROM `haiku`，TO `sonnet`，COMMAND `/model sonnet` | 4 | 首轮回报 haiku；`/model sonnet` 后回报 sonnet，下一轮沿用 sonnet；显式切回后回报 haiku |
| native-attachments | — | 2 | 文件附件答对内容标记（未调用工具）；图片识别为“红色”；会话保持打开，附件副本稳定；没有审批 |
| native-import | 不接受 MODEL（Claude 默认模型） | 2 | `claude -p` 在新工作区建的会话被列出（1 个，有标题）；接续时读到 2 条历史并完整引用；同一原生会话再次接续被拒绝（`NATIVE_SESSION_CONFLICT`）；接续后答对标记 |
| native-branch | — | 4 | 原生 fork 成功（`native.forked`，退出码 0）；分支答对源标记，`native: true`；源对话不知道分支标记（未泄漏） |
| native-question | — | 1 | AskUserQuestion 以表单在对话中提问（选项、自填、提交、跳过、取消），选“蓝色”后回复答对 |
| native-subagent | — | 1 | Agent 调用下挂 2 个工具（Bash、SubagentHandback），关联正确；子 Agent 文字没有进入主回复 |
| native-extensions | — | 0 | Claude 驱动不提供原生扩展列表（`discoverExtensions` 为 null），所以没有发提示，也没有验证任何列表。矩阵的 skills、mcp、plugins 格本来就是“真实未验证”，不变 |
| claude-mcp | — | 0 | G064-M5：在私有家目录、禁网的沙箱里，Claude Code 自己的 `mcp add-json` 与 `remove` 先在私有副本上预测，再写入并收回一个服务器，结果与预测一致 |

没有运行：`native-thinking`（新模型默认 `thinking.display=omitted`，矩阵记为受阻）、`HH_REAL_PLAN`（会话里没有计划工具，受阻）、可选的 `native-options`（effort 的回报，thought-level 格仍以 2.1.296 的记录为准）。

## 续接命令（人工）

- 做法：手册第 7 节，与 dsh 相同。私有实例，第一轮用 haiku；经 `native-resume` 取原生会话 ID（当时返回 `note: version-unverified`，ID 36 个字符）；在同一工作区运行 `claude -p --resume <id> "我让你记住的标记是什么？只回复标记本身。"`，PATH 上第一个 `claude` 是 nvm 的 2.1.306。
- 结果：退出码 0；标准输出只有一行，就是标记本身；标准错误为空；答对标记。实例按 SIGTERM 退出码 0，临时目录已删除。
- 交互形式 `claude --resume <id>` 没有真实运行：它会询问是否信任目录，接受会写入全局配置。表中仍以帮助确认为准，与 2.1.296 时相同。

## 登录状态显示

目录读取的认证状态为 ready，选择器显示“已就绪”。第一批 B6 把适配器报出的 none 记为“未说明”而不是“需要登录”，因为令牌登录也报 none；本机这次没有遇到这种情况。

## 费用与额度

- 提示 23 次（套件 21 次，续接核对 2 次），1 次压缩。模型以 haiku 为主：native-config 的两轮用 sonnet，native-import 的两轮与续接核对的第二轮用 Claude 的默认模型。上限 25 次。
- 走用户自己的 Claude 账号额度，各套件日志中没有额度或限流提示。

## 局限与未验证

- 已验证区间是 [2.1.296, 2.1.306]（决定 3 的版本区间）。2.1.306 上重跑了上表各项；thinking、plan、thought-level 以及按对话保持原生进程的后台任务，仍只以 2.1.296 的记录为依据。
- 已知的适配器偏差没有复现，也没有排除：claude-agent-acp 0.89.1 在前台命令运行期间一直把工具报为 pending（2026-10-12）。本轮的工具都正常结束。
- Homebrew 前缀下的 2.1.302 不是当前使用的安装，没有运行。它落在已验证区间内，但这只是区间语义，不是对它的真实验证。
- 只在 macOS 上验证（[ADR-044](../decisions/0044-macos-official-channels.md)）。

## 配方提交

同一次提交完成以下改动：

- `VERIFIED_VERSIONS.claude` 改为 program `["2.1.296", "2.1.306"]`，adapter 不变（`["0.89.1", "0.89.1"]`）。
- 能力矩阵的安装说明整词写出 2.1.306 与 0.89.1，并保留 2.1.296 的记录引用。上表重跑的各格在证据里追加本记录。
- 依赖旧上界的单元测试随之更新。
- ADR-038、ADR-039 补记。
- 读表区间 `>=2.1.277 <2.2.0` 覆盖新的已验证区间两端，`versionConsistency` 为空。
