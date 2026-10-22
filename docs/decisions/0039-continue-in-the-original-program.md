# ADR-039：在原程序中继续原生会话

状态：accepted，2026-10-12。依据用户授权的审批代理（Fable 5.1）为排序第 6 项 C 定下的条件，以及它对验证方式的裁决（采纳方案 B）。对应[第一链路调研](../research/first-chain-products-2026-10-11.md)的差距 9。2026-10-22 按 [ADR-053](0053-latest-version-baseline.md) 修订决定 1、2、6 与“维护”一节：命令按产品给出，与安装版本无关；在哪个版本上核对过只作证据写在下表。

## 背景

- 用户在 HarnessHub 里与某个 Harness 对话，原程序自己也保存着这段原生会话。用户有时想回到原程序的终端里继续，例如使用 Hub 还没有接出的原生功能。界面原来不显示原生会话 ID，也不给出继续的方法。
- 参考产品：Happy 为每个会话给出一条可复制的原生恢复命令；Zed 在只能恢复时明确提示，不显示之前的消息。

## 决定

1. **命令按产品给出，与安装版本无关（2026-10-22 修订，ADR-053 决定 3）。** 每个产品有两种形式：
   - 交互形式，例如 `claude --resume <id>`：按该产品最新正式版的 `--help` 或源码核对，不从非交互形式推断；
   - 只问一次的非交互形式，例如 `claude -p --resume <id> "你的问题"`：在最新正式版上做真实核对。HarnessHub 先在对话中让原程序记住一个标记，再用这条命令恢复 Hub 记录的原生会话 ID，原程序答出标记数字的倒序（这串数字不出现在历史中）。

   两种形式对该产品的任何已安装版本（包括读不出版本的安装）都给出；只保留与产品本身有关的差别（DeepSeek Harness 没有交互形式、Pi 只指向自己的会话列表、OpenClaw 不显示）、普通标识符检查（第 4 项）和前提说明（例如 dsh headless 只读终端环境或 `.env` 里的密钥）。没有续接命令的产品只显示原生会话 ID（接口的 `note` 为 `no-command`）。读取续接命令不触发发现与版本探测。命令表 `RESUME_COMMANDS` 暂留在 `src/infrastructure/management/verified-versions.ts`：ADR-038 的版本表已删除，这个文件只放这张表，直到 T-ARCH-03 迁入 Harness 描述模块。在哪个版本上核对过，只作证据写在第 3 项的表和验收记录里。

   原文（2026-10-12 至 2026-10-22）为“只给验证过的命令……安装版本在验证范围内才给出命令；超出范围只显示原生会话 ID，并注明‘恢复命令未在此版本验证’”，已按 ADR-053 作废。
2. **与审批代理“与验证形式完全一致”要求的偏离（裁决 B）。**
   - 交互形式在新目录中会先询问是否信任这个目录，接受后会写入用户自己的全局配置，例如 `~/.claude.json`、`~/.codex/config.toml`。后者还存放用户的模型设置。因此真实核对使用非交互形式：它们不询问信任，也不写这些配置，恢复标志、ID 和目录都与交互形式相同。
   - 界面主显示交互形式，悬停说明“交互形式按原程序帮助给出，一次性形式经真实回合核对”。展开后提供“只问一次”的非交互形式。两种都只供复制。页面不写“已用真实回合验证”，也不写在哪个版本上核对过（2026-10-22 修订）；核对版本见下表。
3. **各产品（核对记录；版本只作证据）：**

   | Harness（核对时版本，证据） | 交互形式 | 一次性形式（真实核对） | 最新版源码核对（2026-10-22，只读） | 结论 |
   |---|---|---|---|---|
   | Claude Code 2.1.296、2.1.306（claude-agent-acp 0.89.1） | `claude --resume <id>` | `claude -p --resume <id> "…"`（2.1.296 与 2.1.306 上各真实核对一次） | 2.1.307 仍有 `-r/--resume` 与 `-p/--print`（darwin-arm64 二进制里的选项表） | 给出 |
   | Codex 0.162.1 | `codex resume <id>` | `codex exec --skip-git-repo-check resume <id> "…"` | 0.163.0 的 `exec/src/cli.rs` 与 `cli/src/main.rs` 不变；两条命令会恢复线程保存的权限 | 给出；`--skip-git-repo-check` 绕过 Codex 的 Git 仓库检查，只在工作区不是 Git 仓库时加入，并注明原因，是仓库时为 `codex exec resume <id> "…"`。`codex resume` 的帮助中没有这个标志，交互形式不加 |
   | OpenCode 1.18.35 | `opencode -s <id>` | `opencode run -s <id> "…"` | 1.19.3 的 `-s` 不变（`cli/cmd/run.ts`、`cli/cmd/tui.ts`）；OpenCode 2 的 `-s` 遇到不存在的 ID 会新建会话，接入 V2 前要先核对 | 给出 |
   | Hermes 0.12.0 | `hermes --resume <id>`（Hermes 自己在回合结束时也打印这条命令） | `hermes chat --resume <id> -q "…"` | v0.22.4 的 `hermes_cli/_parser.py` 仍有 `--resume` 与 `chat --resume -q` | 给出 |
   | DeepSeek Harness 0.2.0-rc.2（2026-10-22 真实核对；此前为源码版 0.2.1-alpha.1） | 不给（2026-10-21）：原为 `dsh tui --resume <id>`，官网 npm 包没有 tui profile，见文末补充 | `dsh headless --session-id <id> "…"`（2026-10-22 在 0.2.0-rc.2 上真实核对） | 0.2.1-rc.2 的 `--session-id` 不变、仍没有 tui profile；但 headless 不再读界面里保存的密钥与账号登录（dsh-headless 把 credentials、authorization、deepseek-account 三行设为 disabled），命令旁加前提说明：只用终端环境的 `DEEPSEEK_API_KEY`、工作区 `.env` 或 `~/.dsh/.env`，只在界面里保存过密钥的用户要先在终端 export | 只给一次性命令，附前提说明 |
   | Cursor Agent 2026.10.01-e373342 | `--resume [chatId]` 存在 | `-p --resume` 停在工作区信任，要求 `--trust` | 冻结，未核对 | 只显示 ID（`no-command`）：为不写用户配置，没有加 `--trust`；它的 ACP 会话存放在 `~/.cursor/acp-sessions` 下，能否被 `--resume` 找到也未验证 |
   | Gemini CLI 0.62.0 | `--resume` 只接受 `latest` 或序号 | — | 冻结，未核对 | 只显示 ID（`no-command`）：测试回合被模型服务以客户端版本过旧拒绝 |
   | Pi 0.85.1 | — | — | 冻结，未核对 | 会话标识是文件路径，只显示“见 Pi 自己的会话列表” |
   | OpenClaw | — | — | —（latest 有 `openclaw tui --session <key>` 与 `openclaw agent --session-key <key> --message "…"`，待真实核对后再议，T-OC-05） | 不显示：它的会话在用户自己的 OpenClaw Gateway 中，Hub 不读取其目录 |

4. **ID 与安全。** 原生会话 ID 只有在是普通标识符（字母、数字、`_`、`-`，至多 128 个字符）时才显示或放进命令。原程序返回的其他内容一律不出现在页面或命令中，避免复制出意外的 shell 命令。命令中不含工作区路径，文字写“在该对话的工作区目录中运行”。
5. **提示。** 命令旁边说明两点：
   - 原程序首次在这个目录运行时可能先询问是否信任这个目录，接受会写入它自己的全局配置；
   - 在原程序中继续会使两边的回合交错，回到 HarnessHub 继续前，先在原程序中结束。

   原生会话中多出的回合按 ADR-029 的既有说明处理。
6. **接口。** `GET /api/v1/sessions/:id/native-resume` 返回当前选择的已就绪原生会话的 `{resume: {harnessId, nativeId?, interactive?, once?, onceNote?, list?, note?} | null}`。`note` 只有 `no-command`（没有续接命令的产品；2026-10-22 起，原 `version-unverified` 删除、`not-verified` 改名）；`onceNote` 是一次性命令的前提说明。它在打开执行配置时按需读取，不扫描本机、不进入会话视图和导出。HarnessHub 不执行这些命令。

## 维护（2026-10-22 修订）

每次在最新正式版上做真实验收时复核这些命令：交互形式按帮助或源码核对，一次性形式按[真实验收操作手册](../engineering/real-acceptance.md)第 7 节真实核对；只更新第 3 项的表和验收记录，不改任何代码里的版本条件（没有这样的条件了）。命令文本本身变了才改 `RESUME_COMMANDS`。新的产品要先完成本 ADR 第 1 项的两种核对，才能加入表中。

## 2026-10-21 补充：DeepSeek Harness 只给一次性命令

总指挥（Fable 5.1）为第一批任务 B2 定下的修正。

- **原因。** 官网 npm 渠道的 DeepSeek Harness 是 0.2.0-rc.2（2026-10-18 经 4317 安装）。按它的包内文件只读核实：
  - `dsh <名>` 是 `dsh --profile <名>` 的简写。发运的 profile 模板只有 acp、web、headless、sdk、sdk-minimal（dsh-app-boot 的 `PROFILE_TEMPLATES`）。
  - 一个 profile 既没有 `package.json` 又没有模板时，`loadProfile` 直接报错 `profile "tui" does not exist`。帮助里的 `dsh tui --resume <session>` 只是用户自建 profile 的示例。
  - 所以 `dsh tui --resume <id>` 在官网安装上不成立。
  - dsh-headless 仍有 `--session-id <id>`（沿用已持久化的会话，未知 id 报错），一次性命令不变。它的真实回合验证仍是 0.2.1-alpha.1 上的那次。
- **做法。**
  - 恢复命令表的交互形式改为可选，DeepSeek Harness 只登记一次性命令。
  - 接口照旧：没有交互形式时，`nativeResume` 的结果不含 `interactive` 字段，`NativeResumeView` 本来就允许它缺省。
  - 版本条件不变：仍只在已验证的 0.2.1-alpha.1 上给出命令。官网的 0.2.0-rc.2 不是已验证版本（ADR-038 的区间语义），所以本机只显示原生会话 ID 和“恢复命令未在此版本验证”。（2026-10-22 起被 ADR-053 取代：命令对任何版本给出，不再有版本条件。）
- **界面（未改）。** 详情栏的“在原程序中继续”目前只在有交互形式时才显示一次性命令（`web/src/components/NativeResume.tsx`）。没有交互形式的 DeepSeek Harness 在已验证版本上只会显示原生会话 ID。改为直接显示一次性命令属于前端，留待另行安排。
- **其他记录。** 能力矩阵中 DeepSeek Harness“原生会话恢复”一格仍写着 `dsh tui --resume <id>`（help 确认），那是 0.2.1-alpha.1 源码版上的历史记录。

## 2026-10-22 补充：DeepSeek Harness 一次性命令在 0.2.0-rc.2 上真实核对

- 按[真实验收操作手册](../engineering/real-acceptance.md)第 7 节核对。用私有实例建出 dsh 对话，取原生会话 ID，在同一工作区用干净环境运行 `dsh headless --session-id <id> "…"`。结果：退出码 0，标准输出只有答案一行，答对标记，标准错误为空。记录见 [dsh-rc2-reverification-2026-10-22.md](../verification/dsh-rc2-reverification-2026-10-22.md)。
- 已验证版本随之改为 0.2.0-rc.2（ADR-038 同日补充）。本机详情栏的“在原程序中继续”现在会给出这条一次性命令，并注明“只问一次”。这个显示由 [ADR-050](0050-harness-tiers-and-on-demand-refresh.md) 实现，上文 2026-10-21 补充里“界面（未改）”一条的差距随之关闭。

## 2026-10-22 补充：Claude Code 2.1.306 上的一次性命令

用与 DeepSeek Harness 相同的做法，在 2.1.306 上真实核对了 `claude -p --resume <id> "…"`：退出码 0，标准输出只有答案一行，答对标记。记录见 [claude-2.1.306-rebaseline-2026-10-22.md](../verification/claude-2.1.306-rebaseline-2026-10-22.md)。交互形式没有真实运行：它会询问是否信任目录，接受后会写入全局配置。交互形式仍以帮助确认为准。已验证版本扩到 2.1.296～2.1.306（ADR-038 同日补充），本机详情栏随之给出两种命令。
