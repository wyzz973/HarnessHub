# 接力真机探针记录（G074 RelayConformance，Driver 层，2026-11-10）

对象是 [ADR-055](../decisions/0055-relay-and-context-scheduling.md) 里六家 Driver 的接力声明（`RelayCapabilities`）与协议行为。阶段二的验证记录（[relay-stage2-2026-11-10.md](relay-stage2-2026-11-10.md)“待真机探针验证”一节）和 ADR“待探针的格”表把一批协议事实标成推断；本记录把其中能在 Driver 层测的，用本机真实安装的 Harness 证实、证伪，或如实写成未能验证。

**证据等级**：真机。本机原安装与登录，经生产的绑定工厂（`DirectorySessionBindingFactory.prepare`）直接驱动各家 Driver，发送合成的交接单。运行了 Claude Code、Codex、OpenCode、DeepSeek Harness 四家；Hermes、OpenClaw 只写了探针脚本，**没有运行**（经各自网关的出站范围所有者尚未放行）。没有改任何 Driver 与声明，没有翻转任何 `probed`；翻转与声明的改动是下面各节的“建议”，由主负责人决定。只在 macOS 上运行。

**一次配置守护事故**（先读这一条）：Codex 的整套探针结束后，`tests/real/guard.ts` 报告 `~/.codex/config.toml` 被改动。原因查明：探针的 P14 夹具在 Codex 的私有工作区里写了一个 `.codex/config.toml`（把 `openai_base_url` 指向本机关闭的端口，用来看 Codex 采不采纳工作区层的端点），Codex 随后在**用户自己的** `~/.codex/config.toml` 里新增了一段：

```toml
[projects."~/.cache/harnesshub-acceptance/hh-relay-probe-vLGF56/codex-redirect"]
trust_level = "trusted"
```

（标题里的路径本来是绝对路径，这里写成 `~`；文件第 175 行起的两行。）该临时工作区已随探针删除，这一段指向一个不存在的目录。按真机验收手册（§2.1，退出码 1）没有自行恢复，**留给所有者决定**：删掉这两行即可。守护只比较摘要，无法证明这一段是该文件唯一的改动；能说的是：文件的修改时间落在 Codex 探针运行期间，而且文件里只有这一段提到探针的路径。此后：脚本不再为 Codex 写这个夹具；其他家的夹具只在显式设了 `HH_REAL_PROBE_LAYERS=1` 时运行（见“局限与未做”）。其余三家的每次运行前后守护都显示未改动。

## 环境

- **代码**：基点 `cd542d2`；探针脚本 [tests/real/relay-conformance.real.ts](../../tests/real/relay-conformance.real.ts) 在运行时还没有提交（证据头 `uncommittedChanges: true`，`commit: cd542d2`），随后提交为 `67aecd1`（分支 `cc/relay-probe`），本记录在它之后单独提交。没有改 `src/**`。运行用的是 `pnpm build` 之后的 `dist/`；证据文件头里的 `script` 是编译产物的 sha256 前 16 位，脚本在两遍之间有改动（见“做法”），所以同一家的不同遍可能对应不同的 `script`。
- **系统与工具**：macOS 27.0.1，Node 26.13.0（nvm），pnpm 10.12.3。
- **安装**（证据头 `installations`，策略 `official`，入口都来自 `path`）：
  - Claude Code 2.1.316（npm 全局，nvm v26.13.0）与适配器 claude-agent-acp 0.99.1；
  - Codex 0.166.0（Homebrew Cask）；
  - OpenCode 2.2.5（Homebrew formula）；
  - DeepSeek Harness（dsh）0.2.1-rc.5（npm 全局，nvm v26.13.0）。
- **模型**：Claude Code 用 `haiku`（转录里记的是 claude-haiku-5-5）；Codex 用 `gpt-6-luna`，`reasoning_effort: low`；OpenCode 用免费模型 `opencode/deepseek-v4.1-flash-free`；dsh 用它的默认模型 `["deepseek-official","deepseek-v4-flash"]`（dsh 的模型 id 本身就是这个 JSON 数组文本）。
- **运行方式**：按[真机验收手册](../engineering/real-acceptance.md)第 1 节，`env -i`、登录 shell 的 PATH、`HH_REAL_TMP=~/.cache/harnesshub-acceptance`、不设 `HH_REAL_MANIFEST`、本机原安装与登录；沙箱内即可运行，没有绕过任何限制。数据与临时工作区在 `~/.cache/harnesshub-acceptance/hh-relay-probe-<随机>/`，每次运行结束删除。没有碰 4317、主检出与 `HarnessGateway/data`。
- **守护**：整轮前拍了一次快照（`claude,codex,opencode,dsh` 与共享清单），每次运行前后另有套件内的快照与比较。结果见“配置守护事故”与“用量与清理”。

## 做法

脚本在同一个文件里与原来的两 Harness 冒烟并存（`HH_REAL_HARNESSES` 仍是冒烟，行为不变，只有第 3 步的问法按审批 D2 改为点名对方显示名）；`HH_REAL_PROBE=<id,…>` 选 Driver 层探针。

- **怎么驱动**：经 `application().factory.prepare(...)` 取得与生产一致的 Driver（同样的环境、PATH、TMPDIR、工作区租约），再直接调 `initialize / open / models / deliveryPosition / startText / verifyDelivered / relayVendor / setTitle / close`。交接单用仓库的渲染器（`renderRelay`）按合成事实渲染：另一家的一轮工作（加标题行、跑测试、一句“核对暗号”）加用户原话，暗号由随机数派生，只有这份包里有。
- **怎么读原生记录**：Claude Code 读它在 `projects/<项目>/<会话>.jsonl` 里的转录；Codex 经 Driver 自己的连接读 `thread/turns/list`（`itemsView: full`）；OpenCode 经 Driver 的 `importSession`（`session/load`）读回放；dsh 没有可读的历史（`loadSession: false`，会话日志手册不让读），改为让模型逐字引用收到的标题行与最后一行，**只作弱证据**。
- **线上探针**：脚本在探针期间给 `JsonRpcProcess` 的 `request / notify / dispatch` 加了一个只读的旁路，记下各连接收发的方法与载荷（只在内存里，证据里只留形状、计数与时间），用来读 `turn/start` 的参数、`userMessage` 条目的回显字段、`session/load` 的回放块、旧会话 `session/resume` 的错误。
- **证据里有什么**：判定、键与值的类型、哈希前缀、计数、字符数、耗时、模型 id、主机名与层；没有回复、交接单、配置值或凭据。原生标题只在是合成内容派生时引用（≤80 字符）。
- **做法上的几次改动**（1、2、4、5 是真机第一遍之后发现问题再改的，3 是合成自测时发现的）：
  1. 第一遍的 P1 用户原话里写了“交接单”，Claude 据此起的标题含“交接”，是探针自己引入的污染，改为中性原话后重跑；
  2. OpenCode 的回放把两个文本块用换行拼成一块，判据把这种拼法也算原样，重跑 P1、READ；
  3. 回放读不到时原先误报“证伪”，改为只在能读回放时判；
  4. Claude 的 LATE 在“取消后会话根本没写”时重开抛错，改为记录该错误并加一次“取消后继续发下一条”的观察；
  5. 为 `execution: process` 加了“杀掉进程组 15 秒后，被杀的这一轮有没有被原生侧自己做完”的判据（见 OpenCode 一节）。
  6. 提交的脚本与跑出这些证据的版本（`script` 为 `3a667282…`）相比，只删了一个没用到的导入、一个恒等的三元式和一处没用到的声明；之后在合成 peer 上六家各跑一遍（没有 `error` 判定），在真机上四家各跑一次零提示的 CAT/EMPTY（`script` 为 `7127ddb6…`，守护未改动）。

### 探针与判据

| 探针 | 对应 | 判据（通过 = 证实） |
|---|---|---|
| CAT | 声明快照 | 实例带的声明与工厂静态返回的是同一个冻结对象；`verify` 声明与 `verifyDelivered` 是否存在一致 |
| CLS | 分类（VF1-06） | 无判据，记录 Driver 与声明对 12 个固定输入的读法（真实目录） |
| VEND | `relayVendor()`（P14 的一部分） | 无判据，记录模型、登录种类、端点主机与层、厂商键 |
| P3 | 插入前拒绝不推进 | 原话被读作命令的带包回合整回合失败：`input=not_recorded`、`RELAY_PREPARE_FAILED`、线上没有 prompt；超过输入上限的包 `RELAY_INPUT_LIMIT`，同样不发 |
| EMPTY | 空会话续接 | 无判据，记录另一个进程续接一个没发过消息的会话时 Driver 抛什么 |
| P1 | 放置 | 原生用户条目里标题行、结束行、整份包逐字在，原话在其后且是最后；附件指针落在原话之后；模型答得出包里的暗号 |
| P2 | 证据级别与核对 | 一个带包的完成回合显示的证据（`input_recorded` 事件、`input`、`verifyDelivered` 是否存在）与声明一致；同连接与新进程的核对在记录的位置找到包；没发过的包答 absent；耗时对照 1.8 s |
| P11 | 窗口 | 对 Claude Code 的真转录：尾部读完时没发过的包答 absent，尾部超过一次核对读的量（追加 17 MiB）时答 unavailable，从不答 absent，发过的包仍找得到 |
| P13 | 原生标题 | 原生标题（名称、预览、列表或自动生成）不含 `HarnessHub\|交接\|接手\|handoff\|relay-\|〔\|ai-title` |
| SLASH | 目录外斜杠词、附件时斜杠读作内容、前导空白 | 与声明和分类的读法一致，以“本地命令不调用模型、内容调用模型”区分 |
| P6 | 清空 | Claude Code：合成清空不发 prompt、报告 `native.cleared` 与 `checkpoint: null`、旧转录不变且仍可续接、下一回合是不知道旧暗号的新原生会话；并观察 CLI 自己的 `/clear` |
| LATE | 取消后晚到 | 取消后，输入先不在原生记录里、后来出现，才算晚到；一次时机的不出现只是观察 |
| P16 | 杀进程组后只读续接 | 进程组确已结束；另一个进程续接，打开时与之后 1.5 s 内不发 prompt、不出现回合、不写转录；下一条输入原样写入；被杀的那一轮不会自己做完 |
| READ | 读题（审批 D2） | 点名对方显示名的题目：发出的文本与原生用户条目逐字一致，且答对对方的数；间接问法只记观察和模型 id |
| P15 | 零注入 | 十种形状的普通回合，原生转录里的用户条目与原文逐字节相同 |
| E1 / E3 | Codex 回显与 `itemsView` | `turn/start` 带 `clientUserMessageId`，`userMessage` 条目回显它（记字段名），`itemsView: full` 带 items |
| P14 | 工作区层端点 | 把工作区层的端点指到本机关闭的端口，Harness 连不上模型，才算它采纳了这一层 |

## 结果（逐家）

“证实”“证伪”“未能验证”“观察”四种：证实 = 判据成立；证伪 = 判据不成立（声明或 Driver 与现象不符）；未能验证 = 这一格在这家上测不了，或没有测；观察 = 只记现象，没有判据。时间都是毫秒级的单次测量，不是分布。

### Claude Code（claude-agent-acp 0.99.1 + CLI 2.1.316，haiku）

| 探针 / 格 | 结果 | 关键事实 |
|---|---|---|
| CAT 声明与 `verify` | 证实 | 实例声明与工厂静态声明是同一个冻结对象；`verify: after_turn` 与 `verifyDelivered`、`deliveryPosition` 都存在一致 |
| CLS 分类 | 观察 | Driver 与声明的读法 12 项相同：`/compact`→compact，`/clear`、前导空格或 U+3000 的 `/clear`→clear，带文件或图片→内容，路径→内容，`/export`、`/model`→none，未知词与 `/skill:x`→命令（效果未知） |
| VEND | 观察 | 模型 `haiku`，登录种类 `account`，无端点覆盖 → 厂商键 `anthropic` |
| P3 命令不捎带 | 证实 | 带包回合的原话是 `/compact`：整回合 `failed / classification_changed`，`input: not_recorded`，`RELAY_PREPARE_FAILED`，线上没有 `session/prompt`。声明无输入上限，超限没有可测的格 |
| EMPTY 空会话续接 | 观察 | `session/resume` 被适配器拒绝：JSON-RPC `-32002`，`Resource not found`，错误数据里只有 `sessionId`；Driver 抛的是 `REMOTE_ERROR`，**没有映射成 `NATIVE_SESSION_NOT_FOUND`**（见 F2） |
| P1 放置 | 证实 | 转录里的用户条目是两个 text 块，与 Driver 发出的两块逐块相同（1,384 字符，sha256 相同）；标题行、结束行、整份包逐字在，原话在其后且是最后一块；模型答出了只有包里有的暗号 |
| P1 `pointersAfterUser` | 证实 | 文件附件被 CLI 变成原话之后的两个额外 text 块（共 4 块，1,638 字符对发出的 1,370），文件名出现在原话之后 |
| P2 证据级别 | 证实 | `live: none`：没有 `input_recorded` 事件；`successProvesRecorded: true`：`end_turn` 的内容回合报 `input: recorded`；位置是 `file_offset`（相对 `projects/` 的路径加字节数）；首个 agent 输出 4.0–4.6 s |
| P2 核对 | 证实 | 同连接核对 2 ms 得 present；关进程、新进程续接后核对三个标记得 `[present, present, absent]`，306 ms（其中没发过的包要等 CLI 的 300 ms 刷新再读一次）；没发过的包在更早位置答 absent；在一个后来的位置问发过的包也答 absent（核对只读位置之后） |
| P11 窗口 | 证实 | 真转录：尾部读完时 `[present, absent]`；在位置之后追加 17 MiB（尾部共 19.2 MB）后 `[present, unavailable]`，351–368 ms，没发过的包从不答 absent |
| P13 标题 | 证实 | Claude Code 自动生成的标题（转录里的 `ai-title`，三次相同）是“导出文件标题行与测试”，不含禁用串。第一遍的用户原话里写了“交接单”，标题随之是“交接单核对暗号查询”，这是探针自己引入的，改为中性原话后消失：标题跟着用户的话和包里的工作走 |
| SLASH 目录外词 | **证伪** | 声明 `unlistedSlash: executed`。`/zzprobe-unlisted hello` 被当作文本送给了模型（调用了模型，转录里是原文的用户条目）。见 F3 |
| SLASH 附件时读作内容 | 证实 | `/context` 单独发：不调用模型，本地命令的报告 56,508 字符；带一个文件发：调用模型，转录里是三个 text 块 |
| SLASH 前导空白 | **证伪** | `" /context"` 与 `"　/context"`：CLI 都**没有**当命令执行，而是调用了模型；Driver 的分类把它们读成命令（见 F1） |
| P6 清空 | 证实 | 合成清空：回合 `completed / cleared`，`input: not_recorded`，`native.cleared` 且 `checkpoint: null`，线上没有 `session/prompt`，旧转录字节数不变；同一连接开的下一个原生会话不知道旧暗号；旧会话之后在新进程续接，仍答得出旧暗号 |
| P6 CLI 自己的 `/clear`（Q1） | 观察 | 经通用 ACP Driver 原样发 `/clear`：0.2 s 完成，不调用模型，CLI 另写了一个新转录文件（3→4 个），**适配器没有采用它**：用旧 id 续接仍回到清空前的对话，答得出旧暗号 |
| LATE 取消后晚到 | 观察 | 在 prompt 刚发出时取消：4 ms 收尾，`input` 缺省，无事件；包既不在转录里，其后接着发一条普通回合、关闭、再续接也始终不在（第一遍里这个会话根本没有写到磁盘，续接得 `-32002`）。第一个输出之后取消（约 3.5 s）：`cancelled`，Driver 报 `input: recorded`，转录里立即就有。两种时机都没有晚到 |
| P16 杀进程组后续接 | 证实 | 进程组确已结束；另一个进程只读续接，打开时发出的请求是 `initialize`、`session/resume`、`session/set_config_option`（应用所选模型），没有 prompt，之后 1.5 s 无回合，转录字节数不变；被杀的那一轮的用户条目已在转录里，回复只有 22 字符，没有做完（不会自己继续）；下一条输入逐字写入 |
| READ 点名的题 | 证实 | “Codex 刚才回复了哪个数字？”：发出的文本与转录里的用户条目逐字一致（sha256 相同），两轮独立基线都答对对方的数 |
| READ 间接问法 | 观察 | “另一个 Harness 刚才回复了哪个数字？”：haiku 两轮独立基线都答成**自己的**数（0/2），文本逐字送达；与[上次排查](relay-claude-delta-2026-11-10.md)一致 |
| P15 零注入 | 证实 | 十种形状（含首尾空格、空行、制表符、U+3000 开头、CRLF、反引号与路径、表情与组合字符、标题行仿冒、长行）的普通回合，转录里的用户条目与原文逐字节相同 |
| P14 工作区层端点 | 证实 | 工作区 `.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 指到本机关闭端口：Claude Code 采纳了它（45 秒内回合不收尾，转录里有 7 条 `api_error` 系统行与 7 次 API 请求）。Driver 读到这一层：主机 127.0.0.1、层 `workspace_file`、回环 → 厂商键 `unknown:claude`。回答 Q24 对 Claude 的那一问（工作区 settings 的 `env` 可以改端点） |
| 用量字段（Q12） | 观察 | 每回合报 `input / output / cachedInput / cacheWrite / total`、`context.used / size`（haiku 窗口 1,000,000）、`cost`（USD，会话级累计）。新会话一个很短的提示的第一次请求约 30.6k tokens（固定前缀的量级） |

### Codex 0.166.0（gpt-6-luna）

| 探针 / 格 | 结果 | 关键事实 |
|---|---|---|
| CAT | 证实 | 同上；`verify: after_turn` 与方法一致 |
| CLS | 观察 | 只有 `/compact`→compact、`/export`→none 是命令；`/clear`、`/model`、未知词、未列出的 `/skill:x` 都是内容 |
| VEND | 观察 | 模型前缀 `openai/gpt-6-luna`（Codex 的 `modelProvider`），无端点覆盖 → `openai` |
| P3 | 证实 | 带包的 `/compact` 整回合拒绝（`RELAY_PREPARE_FAILED`，`not_recorded`，线上无 `turn/start`、`thread/compact/start`）；超过 1,048,576 字符的包 `RELAY_INPUT_LIMIT`、`not_recorded`、发送前就拒绝 |
| EMPTY | 观察 | 续接一个没发过消息的线程**成功**（不报错） |
| P2 证据级别 | 证实 | `live: recorded_event`：`input_recorded` 事件在 turn/start 后 4.15 s 到达（带包的 packetId 对得上），首个 agent 输出在 5.44 s；回合 `input: recorded`；位置是 `client_id` |
| E1 回显 | 证实 | `turn/start` 带 `clientUserMessageId`；`userMessage` 条目回显它，**字段名是 `clientId`**（条目键：`clientId, completedAtMs, content, id, startedAtMs, type`），`item/started` 与 `item/completed` 各一次（相隔 2 ms）。`turn/start` 的响应在 56 ms 就到，用户消息条目约 4 s 之后才出现（本机用户的钩子在这之前运行，推断） |
| E3 `itemsView: full` | 证实 | 每个回合都带 `items`；回合键 `completedAt, durationMs, error, id, items, itemsView, rootTurnId, startedAt, status`；用户条目带 `clientId` |
| P1 放置 | 证实 | 单个 text，与 Driver 发出的逐字节相同（1,421 字符）；标题行、结束行、整份包、原话顺序都对；模型答出了暗号 |
| P1 `pointersAfterUser` | 证实 | 文件指针（`[Attached file] notes.txt …`）作为文本接在原话之后、同一个 text 里 |
| P2 核对 | 证实 | 同连接 3 ms present；新进程 `[present, present, absent]` 2–3 ms；没发过的包 absent；后来位置 absent |
| P13 标题 | **证伪（预览）** | `thread/name/set` 在首个回合前接受，`thread/read` 与列表读回的名称就是公共标题（Hub 能设）；但 `thread.preview` 是第一条用户消息的开头，含“原话首行 + 〔HarnessHub 交接单 relay-…〕”，带了禁用串（见 F5） |
| P11 | 未能验证 | Codex 的窗口是 400 个回合（`VERIFY_TURNS`），没有造这么长的线程 |
| SLASH 目录外词 | 证实 | 声明 `text`：`/zzprobe-unlisted hello` 调用了模型，用户条目是原文 |
| P6 清空 | 不适用 | 声明里没有清空命令，目录里也没有 |
| LATE | 观察 | 在 turn/start 刚返回时取消：`turn/interrupt` 被 Codex 拒绝，`-32600 no active turn to interrupt`（38 ms），Driver 把它当协议失败**弄坏了连接**，回合结果丢失（状态空，`input` 缺省），包始终不在线程里（见 F4）。第一个输出之后取消：`cancelled / interrupted`，`input: recorded`，线程里立即就有。没有晚到 |
| P16 杀进程组后续接 | 证实 | 进程组结束；只读续接发出 `config/read, initialize, model/list, thread/resume`，无回合；被杀的那一轮的用户条目在线程里，回复 0 字符，不会自己继续；下一条输入逐字写入 |
| READ | 证实 | 点名题：文本逐字一致且答对；间接问法 gpt-6-luna 也答对 |
| P15 零注入 | 证实 | 十种形状全部逐字节相同 |
| P14 | 未运行 | 见开头的守护事故。同一次运行里另一项观察：把 `openai_base_url` 指到关闭端口的工作区配置没有挡住回合（回合正常收尾），也就是这一层没有被采纳；同时 Codex 在用户配置里把该工作区记成了可信（开头的事故） |
| 用量字段 | 观察 | `input / output / cachedInput / reasoning / total`（`cacheWrite` 恒为 0），`context.size` 每回合报（`modelContextWindow` 828,400）；不报费用。第一次请求约 33.2k tokens |

### OpenCode 2.2.5（opencode/deepseek-v4.1-flash-free）

| 探针 / 格 | 结果 | 关键事实 |
|---|---|---|
| CAT | 证实 | `verify: none`：没有 `verifyDelivered`、没有 `deliveryPosition` |
| CLS | 观察 | 目录有 `init`、`review`、`compact`；`/compact`→compact，其余（含 `/clear`、`/export`、`/model`）都是内容 |
| VEND | 观察 | 免费 `opencode/*` 模型 → `provider:opencode-zen`，无端点覆盖 |
| P3 | 证实 | 带包的 `/compact` 整回合拒绝；无输入上限 |
| EMPTY | 观察 | 续接没发过消息的会话成功 |
| P2 证据级别 | 证实 | `live: none`、`verify: none`、`successProvesRecorded: true`：`end_turn` 的回合报 `input: recorded`，没有 `input_recorded` 事件，没有位置；首个输出 2.8–4.0 s。回放是读原生记录的唯一办法，见下 |
| P1 放置 | 证实 | 回放里的用户条目只有一个 text，是发出的两块**用一个换行拼起来**的（1,422 字符对发出的 1,421）；标题行、结束行、整份包、原话顺序都对。多出的一个换行：包与原话之间是两个空行，`stripPacket` 允许最多三个换行，不影响（见 F6） |
| P1 `pointersAfterUser` | 证实 | 回放里文件名在原话之后 |
| P2 核对 | 未能验证 | 没有核对，符合声明 |
| P13 标题 | **证伪** | 自动生成的标题带包里的词：“交接记录里的核对暗号”（第一遍）、“Code word from handoff record”（第二遍），含“交接”“handoff”（见 F7）。Hub 对 OpenCode 没有设标题的入口 |
| P11 | 不适用 | `verify: none` |
| SLASH 目录外词 | 证实 | 声明 `text`：调用了模型，回放里是原文 |
| P6 | 不适用 | 无清空命令 |
| LATE | 观察 | 刚发出就取消：`cancelled`，`input` 缺省，包始终不在回放里（关闭、另一个进程读，之后又发一条普通回合也不在）；第一个输出之后取消：`cancelled`，Driver 报 `input: recorded`，回放里有。没有晚到，声明的 `lateDelivery: true` 没有被这两种时机证实，也没有被证伪 |
| P16 杀进程组后续接 | 证实 | 进程组结束；`session/resume` 只读续接，无回合；被杀的那一轮的用户条目在回放里，**没有回复**（15 s 后仍然没有）：执行随进程结束，`execution: process` 成立（本机另有一个常驻的 `opencode serve --service`，已运行 9 天，不是探针启动的；被杀的回合没有在里面继续）；下一条输入在回放里逐字一致 |
| READ | 证实（点名） | 点名题答对；回放里文本与发出的文本只差那个换行，内容逐字在；间接问法这个模型也答对 |
| P15 | 未做 | P15 只在 Claude Code 与 Codex 上做（终稿 §13.3） |
| 用量字段 | 观察 | `input / output / cachedInput / reasoning / total`，无 `cacheWrite`；窗口 200,000；费用 USD 0（免费模型）。第一次请求约 17.4k tokens |

### DeepSeek Harness 0.2.1-rc.5（默认 deepseek-v4-flash）

| 探针 / 格 | 结果 | 关键事实 |
|---|---|---|
| CAT | 证实 | `verify: none`，无 `verifyDelivered`、`deliveryPosition` |
| CLS | 观察 | 没有命令：所有输入都是内容 |
| VEND | 观察 | 厂商键 `deepseek`；模型 id 与 `modelKey` 都是 JSON 数组文本 `["deepseek-official","deepseek-v4-flash"]`，不是普通的模型名（见 F8） |
| P3 | 未能验证 | 没有命令可读成命令，也没有输入上限 |
| EMPTY | 观察 | 续接没发过消息的会话成功（`session/resume`） |
| P2 证据级别 | 证实 | `live: agent_output`：Driver 不发 `input_recorded`，首个 agent 输出在 1.4 s；回合报 `input: recorded`（有 agent 输出）；无核对、无位置 |
| P1 放置 | 未能验证（弱证据证实） | 原生历史读不到（`loadSession: false`，会话日志手册不让读）。让模型逐字引用：它原样引用了标题行，并且“最后一行”就是用户原话；只是模型自述 |
| P1 `pointersAfterUser` | 未能验证 | 同上 |
| P13 标题 | 未能验证 | `session/list` 里列不到这个会话的标题 |
| SLASH 目录外词 | 观察 | 没有命令，模型回复了 539 字符；dsh 不报回合用量，无法用 token 数判断是否调用了模型 |
| P6 | 不适用 | 无清空命令 |
| LATE | 未能验证 | 原生历史读不到 |
| P16 杀进程组后续接 | 部分 | 进程组结束；`session/resume` 只读续接，无回合；但这一轮在被杀之前已经收尾（`completed`），没有“做到一半”的情形；被杀的回复是否继续、下一条输入是否逐字，都读不到 |
| READ | 证实（点名） | 点名题答对；文本逐字一致无法核对；间接问法这个模型也答对 |
| 用量字段 | 观察 | 不报回合 token，只报 `context.used`（第一次请求后 11,191）与 `size`（1,000,000）；没有缓存字段、没有费用 |

### Hermes、OpenClaw（只写了脚本，未运行）

`probeHermes` 与 `probeOpenClaw` 在脚本里，默认被挡住：`HH_REAL_PROBE=hermes` 或 `openclaw` 不带 `HH_REAL_PROBE_GATEWAY=<id>` 会直接失败并说明原因（已验证，不是静默跳过）。它们只在合成 peer 上跑过一遍代码（`HH_REAL_PROBE_PEER=1`），那不是证据。

- Hermes：回放完整性（两个回合的会话重开后回放里正好两个用户条目）；`/title` 不写历史行（`setTitle` 前后回放的用户条目数与其他更新数不变，且线上只有一个 `session/prompt`）；`/clear` 的固定回执被读成 `native.cleared`，重开后回放为空。
- OpenClaw：`gateway call sessions.get` 冷启动、再次、200 条窗口三次耗时，对照 1.8 s 的核对预算；`lifecycleRevision`（B7）：`/compact`、`/reset soft`、换模型三项之后都不变，`/new` 之后改变且回合被读成确认的清空；重置后序号。

## Hub 层的两 Harness 冒烟（审批 D2 的改题）

`HH_REAL_HARNESSES=<A>,<B>`：A 想一个五位数，B 只能从交接单知道它并加一，回到 A 的原生会话后问“<B 的显示名> 刚才回复了哪个数字？”。第 3 步改为点名后，四对都通过（全部走正式 Runtime 入口，每次运行前后守护未改动）：

| 对 | A 的数 | B 的回答 | 回到 A 的回答 | 交接单 / 增量 |
|---|---|---|---|---|
| Claude Code（haiku）→ Codex → Claude Code | 47291 | 47292 | 47292 | 完整包 1,213 tokens；增量 1,041 tokens |
| Codex → OpenCode → Codex | 58307 | 58308 | 58308 | 1,205；1,065 |
| OpenCode → DeepSeek Harness → OpenCode | 47293 | 47294 | 47294 | 1,225；1,063 |
| DeepSeek Harness → Codex → DeepSeek Harness | 47283 | 47284 | 47284 | 1,213；1,042 |

haiku 作为 A 在点名题上答对了；它在间接问法上答成自己的数（见上面 READ），所以第 3 步不再用间接问法。第 2 步的“上一位 Harness”问法在 Codex、OpenCode、DeepSeek Harness 上答对；Claude Code（haiku）只做了 A，没有做 B，所以没有碰到它在这个问法上的弱点。

## 与“待探针的格”表逐格对照

格取自 ADR-055 G069 阶段一补记的表；“声明现值”取自各 Driver 模块。没有列出的格（Hermes、OpenClaw 的全部，以及下面写“未验证”的）没有证据。

**Claude Code**

| 格 | 声明现值 | 结果 |
|---|---|---|
| `fixedPrefix` | null | 观察：新会话的第一次请求（很短的提示）约 30.6k tokens；可以记 `{tokens: 30600, basis: "measured"}`，随模型与 CLI 版本变 |
| `hostPathRead` | none | 未验证（v1.1，未启用） |
| `sessionTools` | null | 未验证（v1.2） |
| `window` | session_report | 证实：每回合带 `context.size = 1,000,000` |
| `delivery.lateDelivery` | false | 观察：两种取消时机都没有晚到；一次时机不能证明，声明与观察一致 |
| `placement.maxInput` | null | 未验证（没测上限） |
| `placement.pointersAfterUser` | true | 证实：附件成为原话之后的额外 text 块 |
| `title` | none | 观察：Hub 不能设；自动标题在中性原话下不含禁用串 |
| `vendor.loopback` | 回环记 unknown | 证实（P14 夹具）：工作区层 127.0.0.1 → `unknown:claude` |
| `vendor.signin` | 其他登录种类记 unknown | 未验证（只遇到 `account`） |
| `vendor.backendWithEndpoint` | 开关加端点记 unknown | 未验证 |

**Codex**

| 格 | 声明现值 | 结果 |
|---|---|---|
| `fixedPrefix` | null | 观察：约 33.2k tokens |
| `hostPathRead`、`sessionTools` | none、null | 未验证 |
| `window` | turn_report | 证实：每回合报 `context.size`（828,400） |
| `delivery.lateDelivery` | false | 观察：没有晚到（取消点见 F4） |
| `placement.pointersAfterUser` | true | 证实：文本指针接在原话之后 |
| `commands.unlistedSlash` | text | 证实 |
| `vendor.provider` | 写在模型前缀里 | 证实：`openai/gpt-6-luna` → `openai` |
| `vendor.loopback`、`vendor.endpointProvider` | — | 未验证（P14 未运行） |

**OpenCode**

| 格 | 声明现值 | 结果 |
|---|---|---|
| `fixedPrefix` | null | 观察：约 17.4k tokens |
| `hostPathRead`、`sessionTools` | none、null | 未验证 |
| `window` | session_report | 证实：200,000 |
| `delivery.successProvesRecorded` | true | 证实：完成的内容回合报 `recorded`，回放里确有该条目 |
| `commands.unlistedSlash` | text | 证实 |
| `placement.maxInput` | null | 未验证 |
| `placement.pointersAfterUser` | true | 证实（回放里文件名在原话之后） |
| `cacheTtl` | unknown | 未验证 |
| `title` | none | 观察：自动标题带“交接”“handoff”（F7） |
| `vendor.loopback` | — | 未验证（P14 未运行） |
| `vendor.otherProvider` | `provider:<name>` | 观察：免费 `opencode/*` → `provider:opencode-zen` |

**DeepSeek Harness**

| 格 | 声明现值 | 结果 |
|---|---|---|
| `fixedPrefix` | null | 观察：第一次请求后 `context.used` 为 11,191（含几十 token 的提示与一句回复） |
| `hostPathRead`、`sessionTools` | none、null | 未验证 |
| `window` | session_report | 证实：1,000,000 |
| `delivery.lateDelivery` | false | 未验证（原生历史读不到） |
| `placement.maxInput`、`placement.pointersAfterUser`、`title` | — | 未验证 |
| `vendor.loopback`、`vendor.layers` | — | 未验证（P14 未运行） |

## 证伪与偏离，及建议

下面只是建议，没有改任何 Driver 或声明。编号 F1–F10 是现象，建议在每条里。

- **F1 Claude 的前导空白读法（Driver）。** 现象：`" /context"`、`"　/context"` 在原生都没有被当作命令（调用了模型），而 `claudeCommand` 用 `trimStart()` 把它们读作命令。后果：`" /clear"` 会被 Driver 合成清空、放弃原生会话，而原生只会把它当文本；带包回合的原话以空白加斜杠词开头时被整回合拒绝；这样的回合因为被读作命令，`input` 缺省，虽然原生其实记录了它（上面 SLASH 的第三条回合就是这样：模型回复了，`input` 缺省）。建议：`claudeCommand` 不去前导空白（命令名只在第一个字符就是 `/` 时才成立），同步 `claudeReadsSlash`、声明的 `classify`、终稿 §7.4 与 RT5-05 里“去前导空白后”的文字，并补用例（含 U+3000）；不要保留当前的保守读法，因为它会误触发合成清空。
- **F2 Claude 续接空会话的错误没有映射（Driver，阻断 C5 的兜底）。** 现象：另一个进程 `session/resume` 一个没发过消息的会话，适配器答 `-32002 Resource not found`，Driver 抛 `REMOTE_ERROR`，不是 `NATIVE_SESSION_NOT_FOUND`，所以阶段二补记里写的“Claude 预开的空会话/清空后的空会话改开新原生会话”的兜底在真实 Claude 上不会触发。这条路径不罕见：第一遍里一个刚发出就被取消的首回合没有让 CLI 写出会话，续接同样得 `-32002`。Codex、OpenCode、DeepSeek Harness 续接空会话都成功，不需要。建议：在 `AcpControl` 的会话建立处把 `session/resume`、`session/load` 上 `remoteCode === -32002` 且带 `remoteFields.sessionId` 的拒绝映射成 `NATIVE_SESSION_NOT_FOUND`（Hermes 的 `not_found` 另行核对）。
- **F3 Claude 的 `unlistedSlash: executed` 与现象不符（声明）。** 现象：一个目录外的未知斜杠词被当作文本送给模型。选项：(a) 声明改为 `text`，目录外却被 CLI 执行的几个仍靠 `hidden`（clear、reset、new、remote-control）；(b) 保留 `executed` 作为有意的保守读法（目录外的 `/x` 不带包、按效果未知处理），在这一格的注释里写明“观察到的是文本”。(a) 与观察一致，但会让 `claudeReading` 对目录外的词不再算“效果未知的命令”，要同时改 Runtime 的读法与用例，请主负责人定。
- **F4 Codex 在回合真正开始之前停止，会弄坏连接（Driver）。** 现象：`startText` 返回后立刻 `requestStop()`，Driver 等到 `turn/start` 的响应（几十毫秒）就发 `turn/interrupt`，Codex 答 `-32600 no active turn to interrupt`（本机用户的钩子要运行几秒，用户条目约 4 s 才出现），`stopTurn` 把任何失败都当协议失败 `abort`，Run 的结果丢失（状态空、`input` 缺省）。包在线程里始终不存在（不会晚到）。用户在回合开始的头几秒点“停止”就走这条路。建议：把这一个错误当作“回合尚未开始”处理——等到用户条目/`turn/started` 到达后再中断，或者直接记取消、不 `abort`。
- **F5 Codex 的 `thread.preview` 带着标题行（声明与包的版面）。** 现象：`name` 设成公共标题后读回正确，但 `preview`（第一条用户消息的开头）是“原话首行 + 〔HarnessHub 交接单 relay-…〕”，带 `HarnessHub`、`交接`、`relay-`、`〔`。P13 的判据按“名称、预览、列表”读，所以证伪；Codex 的界面有名称时显示名称，预览是否出现在别处没有查。建议：要么把 P13 对 Codex 的判据限定为名称（Hub 设得了），要么让包的开头把标题行推出预览的长度（首行很短时标题行落进预览）。
- **F6 OpenCode 把两个文本块用换行拼成一块（观察，不需要改）。** 回放里是一个 text，包与原话之间多一个换行（两个空行）。`stripPacket` 允许最多三个换行，这一点已被设计覆盖。判据把“块之间一个换行”算原样。
- **F7 OpenCode 自动生成的标题带“交接”“handoff”（观察，P13 证伪）。** 两遍都是：“交接记录里的核对暗号”“Code word from handoff record”。Hub 对 OpenCode 没有设标题的入口，声明 `title: none` 如实；P13 通过前 OpenCode 保持“未保证”，这一点现在有了数据。Claude Code 在中性原话下的自动标题没有这个问题。
- **F8 DeepSeek Harness 的模型 id 与用量。** `modelKey` 是 JSON 数组文本 `["deepseek-official","deepseek-v4-flash"]` 整体（`slashModelKey` 没有处理），厂商键 `deepseek` 不受影响。建议 dsh 的 `normalizeModel` 取数组的最后一项作模型键。dsh 不报回合 token、缓存字段与费用（只报 `context.used / size`），所以缓存指标对 dsh 只能写“未上报”（回答 Q12：四家里 Claude Code 报 `cachedInput`、`cacheWrite` 与费用，Codex 报 `cachedInput` 与 `reasoning`、`cacheWrite` 恒 0、不报费用，OpenCode 报 `cachedInput` 与 `reasoning`、无 `cacheWrite`）。
- **F9 声明里可以写进去的实测数。** `fixedPrefix`：Claude Code 约 30.6k、Codex 约 33.2k、OpenCode 约 17.4k、DeepSeek Harness 约 11.2k tokens（各自第一次请求，随模型与版本变）。
- **F10 守护事故的教训（手册）。** 见开头。真机验收手册应补一句：不要在私有工作区里写 `.codex/config.toml`——Codex 会把这个工作区记进用户自己的 `~/.codex/config.toml`。

## 翻转 `probed` 的条件

条件取自终稿 §13.3 与 ADR 审批 A3：P2、P3、P6、P11 通过，process 型另加 P16。

| Harness | P2 | P3 | P6 | P11 | P16 | 判断 |
|---|---|---|---|---|---|---|
| Claude Code | 证实 | 证实 | 证实 | 证实 | 证实 | 五项都证实，满足。先处理 F2（C5 的兜底在真机上不触发）与 F3（有一格与现象不符）再翻转；F1 不影响这五项，但会误触发合成清空 |
| Codex | 证实 | 证实 | 不适用 | **未能验证** | 证实 | 适用的项里只有 P11 没做（窗口是 400 个回合，没造这么长的线程；窗口逻辑只有合成测试）。若主负责人认为 P6 不适用、P11 的逻辑已由合成测试覆盖，则满足；否则不满足。F4 是取消路径上的 Driver 缺陷，不在这五项里 |
| OpenCode | 证实 | 证实 | 不适用 | 不适用 | 证实 | 适用的项都证实；P6（无清空命令）、P11（`verify: none`）本身不存在。F7 的标题是 P13，不在翻转条件里 |
| DeepSeek Harness | 证实（弱 E1 一致） | **未能验证** | 不适用 | 不适用 | **部分** | 不满足：P3 没有命令可测；P16 的“被杀的回复是否继续”“下一条输入是否逐字”读不到，那一轮在被杀前已收尾；P1 放置只有模型自述 |
| Hermes、OpenClaw | 未运行 | 未运行 | 未运行 | 未运行 | gateway 型，P16 不适用 | 不满足：没有证据 |

“不适用”是这家没有这个机制（无清空命令、无核对），探针无从通过；是否把它按“通过”算，是主负责人的决定。默认放行之后 `probed` 只影响交接卡上的“未经真机验证”标注（ADR 用户决定 D11）。

## 用量与清理

**调用次数与花费**（“提示”指探针发给 Driver 的回合，包含不调用模型的本地命令；“到模型”指实际调用了模型的回合）：

| Harness | 运行 | 提示 | 到模型 | 报告的 token（多为缓存的固定前缀） | 自报费用 |
|---|---|---|---|---|---|
| Claude Code | 首遍 3、完整 30、第二遍 13、P16 3、冒烟 2 | 51 | 约 46 | 约 1.5M | 约 US$0.15（会话级累计费用按连接取最后一个再相加） |
| Codex | 完整 24、LATE 2、P16 3、冒烟 4 | 33 | 约 31 | 约 1.1M | 不报 |
| OpenCode | 完整 12、第二遍 9、P16 3、冒烟 3 | 27 | 约 22 | 约 0.4M | US$0（免费模型） |
| DeepSeek Harness | 完整 14、P16 3、冒烟 3 | 20 | 约 19 | 不报 | 不报（回合都很短，输出至多 539 字符） |

没有任何回合超过 5 分钟或 15 万 token：最长的完成回合 18.6 s（OpenCode），最大单回合 55,947 tokens（Claude Code）；P14 的两次软限制（45 s、60 s）是故意不让它等重试到底。另有三次不到模型的静态运行（目录、空会话续接，共 0 提示）。

**守护**：整轮前后的比较退出码 1，唯一的改动是 `~/.codex/config.toml`（开头的事故）；`claude`、`opencode`、`dsh` 与共享清单整轮不变。每次运行前后的套件内守护：Codex 的完整运行报告改动（事故），其余全部未改动。

**清理**：
- 每次运行的私有根目录（数据、工作区、租约）都已删除，`~/.cache/harnesshub-acceptance/` 里只剩 `evidence/`（证据与日志，0600，不入库）、手册的 `env.sh` 与我自己的 PATH 副本 `env-probe.sh`、两个与探针无关的备份。
- Claude Code：每次运行删除了为临时工作区写的转录目录；冒烟的一个转录目录也已删除；核对过 `~/.claude/projects` 里没有本次的 `hh-relay` 目录（11-09 的两个旧目录不是这次的，没动）。`~/.claude.json` 的 `projects` 里可能多出这些临时工作区的条目，守护不比较这一项，没有动它。
- Codex：探针线程在运行结束时用 `thread/delete` 逐个删除（Driver 的连接对别的线程的删除通知会报 `IDENTITY_MISMATCH`，所以先续接再删）；早先一次静态运行有一个线程在删除时被这个守卫打断，事后用 `thread/list` 按目录核对为 0；冒烟留下的 3 个线程事后删除。
- OpenCode：`session/delete`。第二遍有 5 个会话因脚本只在跑过 CAT 时才知道会话支持删除而漏删（已修），事后用不带 cwd 的 `session/list` 按目录找到并删除；冒烟的 2 个也已删除。11-09 的旧冒烟会话（Codex 与 OpenCode 各一个）不是这次的，没动。
- DeepSeek Harness：没有删除会话的办法，探针与冒烟写下的约 16 个会话留在 dsh 自己的存储里，内容全是合成的。
- Codex 的 `~/.codex/config.toml` 多了一段（事故），留给所有者。

## 局限与未做

- **Hermes、OpenClaw 没有运行**（脚本在，默认被挡住）。它们的 `lifecycleRevision`（B7）、`/title`（B10）、`gateway call` 冷启动、回放完整性、P7、gateway 型的“查看器被杀、网关继续”都没有证据。
- 没有做：P4（插入前取消后覆盖重发，属 Runtime 流程）、P5（命令回合不动水位，属 Runtime）、P7（回退，Hermes）、P8 的真 B 以外的三组（冒烟只做了四对中的 A、B 各一次，且 Claude Code 没当过 B）、P9 的“工作区除任务改动外无新文件”（配置侧由守护覆盖，工作区侧没查）、P10（缓存增量，只记了字段）、P12（git 过滤器，属工作区观测）、P13 的“带/不带交接单的同一句原话对照”、P15 的 `/clear`、压缩后、外部编辑后三例与 20 轮（做了 10 种形状）、P14 的四个夹具（只做了 Claude 的工作区层，Codex 因事故撤掉，OpenCode、DeepSeek Harness 的夹具在脚本里但默认不跑，因为 Codex 的教训：写在私有工作区里的项目级配置可能被 Harness 记进它自己的全局配置；要跑设 `HH_REAL_PROBE_LAYERS=1`）。
- 每个探针一次运行、一段对话：READ 的间接问法每家 1–2 次独立基线，不是统计；LATE 只测了两个取消时机；P11 对 Codex（400 回合）与 OpenClaw（200 条）没有造长度。
- 没有测：Claude 的计划模式“清空上下文继续”（没有信号，契约缺口）、`/model X` → `/clear` → 仍为 X（Q22，Driver 的合成清空已不经 CLI）、压缩证据、`cacheTtl`、`placement.maxInput`（除 Codex 的发送前拒绝）。
- DeepSeek Harness 的原生历史读不到，P1、P13、LATE、P16 的“逐字”只能是模型自述或未验证。
- 证据文件头里的 `commit` 是基点 `cd542d2`，`uncommittedChanges: true`（脚本当时未提交）。
- 脚本自测：`HH_REAL_PROBE_PEER=1` 在合成 peer 上六家都跑过一遍没有 `error` 判定，那只证明脚本本身能跑，不是证据。

## 复跑

```sh
. ~/.cache/harnesshub-acceptance/env.sh        # 手册第 1 节的 LOGIN_PATH 与 RUN
pnpm build
EVIDENCE="$HOME/.cache/harnesshub-acceptance/evidence/$(date +%F)"; mkdir -p -m 700 "$EVIDENCE"
RUN HH_REAL_PROBE=claude HH_REAL_MODEL_CLAUDE=haiku HH_REAL_EVIDENCE="$EVIDENCE/relay-claude.json" node --test dist/tests/real/relay-conformance.real.js
RUN HH_REAL_PROBE=codex HH_REAL_MODEL_CODEX=gpt-6-luna HH_REAL_OPTIONS_CODEX='{"reasoning_effort":"low"}' HH_REAL_EVIDENCE="$EVIDENCE/relay-codex.json" node --test dist/tests/real/relay-conformance.real.js
RUN HH_REAL_PROBE=opencode HH_REAL_MODEL_OPENCODE=opencode/deepseek-v4.1-flash-free HH_REAL_EVIDENCE="$EVIDENCE/relay-opencode.json" node --test dist/tests/real/relay-conformance.real.js
RUN HH_REAL_PROBE=dsh HH_REAL_EVIDENCE="$EVIDENCE/relay-dsh.json" node --test dist/tests/real/relay-conformance.real.js
# 只跑某几个探针：HH_REAL_PROBE_ONLY=P1,P16；endpoint 夹具：HH_REAL_PROBE_LAYERS=1（Codex 的不会写）
# Hermes、OpenClaw：HH_REAL_PROBE=hermes HH_REAL_PROBE_GATEWAY=hermes（所有者放行之后）
# 两 Harness 冒烟（审批 D2 的点名题）：RUN HH_REAL_HARNESSES=claude,codex HH_REAL_EVIDENCE=… node --test dist/tests/real/relay-conformance.real.js
```

每次运行前后都要有手册 2.1 的整轮守护快照与比较；比较退出码 1 时停止并报告，不要自行恢复。

## 来源

- 证据（不入库）：`~/.cache/harnesshub-acceptance/evidence/2026-11-10-probe/`：`claude-full-1.json`、`claude-pass2.json`、`codex-full-1.json`、`codex-pass2.json`、`opencode-full-1.json`、`opencode-pass2.json`、`dsh-full-1.json`、`p16-all.json`、`static.json`、`p1-claude.json`、四个 `smoke-*.json`、整轮的 `guard-before.json` 与 `guard-after.json`。
- Codex 0.166.0 的应用服务器协议绑定由 `codex app-server generate-ts` 在本机生成（只读了 `ThreadItem` 的 `userMessage` 变体有 `clientId`、`TurnItemsView` 取值、`thread/delete` 存在），读完删除。
- 代码：`tests/real/relay-conformance.real.ts`；相关 Driver：`src/adapters/control/{claude,codex,opencode,acp,relay-turn,relay-classify}.ts`。
- 文档：[ADR-055](../decisions/0055-relay-and-context-scheduling.md) 的 G069 补记（待探针的格）、审批 D2、2026-11-10 用户决定；终稿 §8.1、§13.3、§20；[阶段二验证记录](relay-stage2-2026-11-10.md)；[Claude Code 读错增量的排查](relay-claude-delta-2026-11-10.md)。
