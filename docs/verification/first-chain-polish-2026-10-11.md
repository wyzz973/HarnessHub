# 第一链路打磨（2026-10-11）

按用户授权的审批代理（Fable 5.1）给出的本阶段优先级推进：版本显示 → 发现方式整改 → Hermes/dsh 剩余验收 → 启动阶段与首字延迟、错误说明 → 目录缓存与探测会话 → 审批提示与 dsh 预设 → Codex 计划模式 → 后台任务。发现方式整改见 [Hermes 与 dsh 接入记录](hermes-dsh-onboarding-2026-10-11.md)。

## 版本显示（P1）

问题：选择器把适配器版本当成产品版本显示（Claude Code 显示为 claude-agent-acp 的 0.89.1）；Hermes 没有版本（`hermes --version` 输出多个版本号，并在隔离 HOME 里联网检查更新，超过 5 秒探测期限）；网页缺少 favicon。

交付：

- **从安装元数据读取版本，不运行程序**。发现找到入口后，如果目录为它声明了包身份，就读取安装元数据：npm 包从解析后的 bin 向上找名字相符的 package.json，并核对其 bin 指向这个文件；Python 包从控制台脚本的解释器行找到虚拟环境（安装器的 launcher 若只是 `exec "<脚本>" "$@"`，跟随一层），读 `site-packages/<名称>-<版本>.dist-info/METADATA` 并核对名称。有了观察到的版本，管理层不再运行 `--version`。
- **区分产品版本与接入口版本**。产品自己的命令是目录里该产品的第一个命令名；接入口是另一个程序（适配器）时，用同一套隔离的 `--version` 探测读取产品自己的版本，同一命令只读一次。Harness 视图新增 `programVersion`：选择器显示产品版本；Harness 页显示产品版本，接入口版本不同时另标“接入口 v…”。
- Hermes 的控制入口登记 Python 包身份 `hermes-agent`。
- 网页内嵌 favicon（HarnessHub 标志），不再请求 `/favicon.ico`。

检查：

| 命令 | 结果 |
|---|---|
| `pnpm build` 与 `node --test dist/tests/*/*.test.js` | 559 通过、0 失败、0 跳过 |
| `pnpm web:build` 与 `node --test dist/tests/browser/web.browser.js` | 11 通过 |
| `python3 tools/check_design.py --write` 与默认检查 | 通过 |

新增测试：npm 全局 bin 链接读出包版本，非 bin 文件与不同名字不算；Python 控制台脚本与一层 launcher 读出 dist-info 版本，两层 launcher 与缺少 pyvenv.cfg 的环境不算，全程不运行任何程序；适配器入口保留自己的版本、产品版本由产品命令读取且只读一次；产品命令判断（适配器、产品自身、经 Node 运行的包、找不到）。

本机真实观察（`node dist/src/cli/discover.js --json`，只读文件）：Hermes 0.12.0（venv 元数据，经官方 launcher）、claude-agent-acp 0.89.1、Gemini CLI 0.62.0、dsh 0.2.1-alpha.1（自定义入口的 package.json）。独立开发实例的 Harness 页：Claude Code v2.1.296 · 接入口 v0.89.1；Hermes Agent v0.12.0；DeepSeek Harness v0.2.1-alpha.1 · 自定义入口（发现清单）；控制台无错误。

未验证：Windows 的 Python 环境布局（`Lib/site-packages`、`Scripts`）未处理也未验证；PEP 440 预发布版本（如 `0.1.5rc1`）不是语义化版本，仍会回落到 `--version` 探测。

## 回合阶段与首字延迟（P4，ADR-032）

交付：Run 记录受理、开始准备、原生会话就绪、发送、首个可见输出与结束的时间（Session v10，v9→v10 只改版本号）；发送与首个输出各有一条事件。界面按阶段显示“正在启动 X”“已连接 X，正在发送”“等待 X 回复”，超过 2 秒附已用时间，同一对话里同一 Harness 上次的启动时间作为参考；回合结束后显示“首字 … · 用时 …”，执行详情列出启动原程序与发送后首个输出的时间。

检查：

| 命令 | 结果 |
|---|---|
| `node --test dist/tests/*/*.test.js` | 564 通过、0 失败 |
| `node --test dist/tests/browser/web.browser.js` | 11 通过（新增“首字 … · 用时 …”断言） |
| `python3 tools/check_design.py` | 通过 |

新增测试：阶段时间的边界、顺序与只在 v10 出现；v9→v10 迁移保留全部事实，v9 数据里出现阶段时间时整体回滚；真实 IPC 回合按顺序记录全部阶段，发送与首个输出事件各一次。

真实验证（独立开发实例）：已有两个 v9 会话的数据目录启动后迁移为 v10，两个会话完整保留（迁移前已备份）。在已有的 Hermes 对话里再发一条消息：界面依次显示“正在启动 Hermes Agent”，结束后显示“首字 8.0 秒 · 用时 9.7 秒”。这一回合的阶段：受理到准备 0.00 秒，启动原程序（建进程、握手、恢复会话与等待回放）4.76 秒，就绪到发送 0.00 秒，发送到首个输出 3.21 秒，首个输出到结束 1.73 秒（其中包含 Hermes 在标准输入关闭后要等 SIGTERM 才退出）。启动原程序是最大的一段，这也是 ADR-030 保留进程要省掉的部分。

## 部署到 4317 服务（Hermes/dsh 接入至回合阶段）

2026-10-11 23:41–23:42，在服务空闲时部署（2 个会话，没有在途 Run，也没有待决切换）。部署内容：Hermes 与 dsh 接入、发现方式整改、版本显示与回合阶段（Session v10）。

步骤：

- 核实 PID 与命令行后发 SIGTERM，服务正常退出。
- 冷备份 `data/` 到 `.tmp/backup-data-v9-20261011-234200/`。
- 主检出快进到 `5e52345` 并构建。
- 在 `.tmp/discovery-manifest.json`（私有，600）写入发现清单，只含一条 `dsh-native` 自定义入口，指向用户源码构建的 `apps/cli/lib/bin.js`。
- 经干净环境的登录 shell 启动，带 `--manifest` 指向该清单。

部署后核对：

- 业务库从 v9 迁移为 `user_version=10`。
- 两个会话都是 schema 10、open：用户原来的 OpenClaw 会话 14 个 Run、27 条消息；用户测试时新建的会话 6 个 Run、10 条消息。
- 静态页 200，未登录 API 401。
- 新的一次性启动链接只写在私有日志里，已按用户先前的做法在用户默认浏览器中打开，未在对话中展示。

回退：停止服务，用上述备份替换 `data/`，检出 `1e7393c` 重新构建，并去掉 `--manifest`。

## 失败的分类与说明（P4）

交付：

- 远程错误按原程序给出的文字归类，并补了几类：认证（加上 401、无效 API key、DeepSeek 的 “Authentication Fails”）、额度或余额（402、“Insufficient Balance”）、限流与过载（429、529、“Rate Limit Reached”）、上下文超限、模型不存在（“Model Not Exist”）。只有 ACP 连接的 -32000（协议规定的 auth_required）按代码判为需要认证，其他 JSON-RPC 对端不受影响。
- 界面给这些分类，以及会话不存在、会话被阻塞、模型或设置未生效、模型请求失败等补上中文说明。原始的提供方文字不发布。
- Hermes 的模型请求失败时仍以 end_turn 结束，回复为空（或只有它自己的 “Error: …”），原因只写在它的 stderr。进程封装为此保留最近 32 KB 的 stderr；回合完成却没有回答、并且本回合的日志有终态失败标记时，回合判为失败并按日志归类，有回答的回合不改判。

检查：全部测试 567 通过；浏览器测试 11 通过。新增测试：提供方原文样例（含 DeepSeek 的说法）的分类，以及 ACP -32000 与其他代码的区别；Hermes 静默失败按日志分类为余额不足，且不发布日志原文；重试后恢复并有回答的回合仍为完成。

真实环境：没能制造出 Hermes 的模型失败。把会话模型切到不存在的模型后，Hermes 下一回合仍正常回答，没有失败可供观察。不能为制造失败去改用户的密钥或配置，所以这一项只有协议测试证据（`.tmp/cc-hermes-silent-failure.json` 记录了这次尝试）。

## 就绪状态、目录缓存与探测会话（P4、P5，ADR-033）

交付（依据 [ADR-033](../decisions/0033-native-catalog-cache-and-readiness.md)）：

- 模型目录按配置指纹复用，最长 24 小时，保存在数据根的 `native-catalogs.json`，跨重启有效；“刷新本机模型”总是重读。文件无法采用时不改动它，报告一次，改为只在内存中保留。
- 选择器在每个 Harness 旁显示上次读取得到的状态：已就绪、需要登录（Hermes 为“需要配置”）、读取失败。悬停提示写明读取时间，以及是否由原程序确认已登录。说明行显示通常启动用时（最近 5 个回合的中位数）。新对话第一次用某个 Harness 时，启动阶段显示“通常约 N 秒”。
- “本机会话”默认不列出 Hub 读取目录时建出的空会话，提示隐藏了几个，可点“显示”查看全部。
- ACP 缺省的 `authMethods` 按规范视为空列表。Hermes 没有 agent 类认证方式（未配置提供方）时不建会话，报需要认证，提示在终端运行 `hermes model`。模型目录接口把 ACP 的需要认证也返回为 `missing`。

检查：

| 命令 | 结果 |
|---|---|
| `pnpm build` 与 `node --test dist/tests/*/*.test.js` | 573 通过、0 失败、0 跳过 |
| `pnpm web:build` 与 `node --test dist/tests/browser/web.browser.js` | 11 通过 |
| `python3 tools/check_design.py --write` 与默认检查 | 通过 |

新增测试：

- 缓存跨实例复用、指纹变化与满 24 小时后不再复用；契约外字段不落盘，超界目录不保存。
- 无法采用的文件（新版本、损坏、多余字段、非私有、链接）保持原样，报告一次，观察只留在内存中。
- 只删除本文件的中断临时文件；所有权无法确认时写入失败只报告一次，不留任何文件。
- 经正式 Gateway 入口：两次启动之间复用目录，`refresh=1` 与配置变化时重读；探测会话默认不列出、`probes=include` 时列出；ACP `-32000` 记为需要登录；就绪接口与 `/state` 一致。
- 协议测试：Hermes 在缺省或只有 terminal 方法时不发出任何 `session/*` 请求；其他代理缺省 `authMethods` 照常打开；存在但不是列表时拒绝。
- 浏览器测试：认证缺失后，选择器中 OpenClaw 显示“需要登录”，Codex 显示“启动约 N 秒”。
- 两处变异（去掉私有权限检查、去掉写入前的字段投影）都会让测试失败。

真实验证（独立开发实例与临时数据，证据 `.tmp/cc-readiness-2026-10-12.json`）：

- 初始时选择器没有任何状态；只有 Hermes 因为已有带计时的回合，显示“启动约 5 秒”。
- 读取了 Hermes、dsh、Codex 三者的目录：Hermes 和 Codex 为“已就绪，已登录”，dsh 为“已就绪”（登录由它自己在发送时核实）。缓存文件权限 600。dsh 的“本机会话”列出 4 个，并提示“已隐藏 1 个”；点“显示”后列出 5 个。
- 重启实例后三条就绪记录仍在。再取 Hermes 目录 28 毫秒返回，没有新增探测会话；此前每次约 5 秒，并在 Hermes 里建一个空会话。
- 在新对话里用 Hermes 发一句话：启动阶段依次显示“正在启动 Hermes Agent（通常约 5 秒）”和已用 2、3、4 秒，随后是“等待 Hermes Agent 回复”和“正在回复”。回合完成，回复“收到”；启动 4.75 秒，发送到首字 3.28 秒，总计 9.55 秒。
- Hermes 的 config.yaml、.env、auth.json 都是几个月前修改的，回合不会改写它们，指纹可以稳定命中。Hub 只读取这些文件的身份信息，不读内容。

未验证：

- Hermes 未配置提供方时的真实程序表现。验证它需要改动用户的 Hermes 配置，或用隔离的 `HERMES_HOME` 运行，这两种做法都被用户的约束排除；目前只有协议测试，以及对本机 0.12.0 源码（`acp_adapter/auth.py`、`server.py`）的阅读。
- 本轮没有读取 Claude Code、Cursor、Gemini CLI、OpenCode、Pi、OpenClaw 的目录，以免在它们那里多建空会话；OpenClaw 的读取还会在用户正在运行的网关上建会话。它们的就绪判断沿用已验证的目录读取路径，只是没有在新界面上实测。
- 本版本之前建出的探测会话无法识别，仍会列出。
- Windows：缓存文件的私有权限检查按 POSIX 模式位进行，未在 Windows 验证。

## 审批说明与 dsh 预设（P6）

交付：

- Hermes 的审批卡在选项之外加一行说明：选“Allow always”会写入 Hermes 自己的配置（`command_allowlist`），之后 Hermes 的所有会话（包括终端和消息网关）遇到同一类危险命令都不再询问。依据本机 0.12.0 源码：`tools/approval.py` 把这一类危险命令的模式写入 `config.yaml`，Hermes 的所有入口都读取它。其他代理不加这行说明：Claude 适配器的选项名称已经写明要写入的规则。
- dsh 的执行配置面板加“审批”一项：审批由 dsh 自己的权限预设决定，workspace-write 在超出工作区时请求审批，danger-full-access 不会请求审批；可在 dsh 自己的界面用 `/permission` 查看或切换，HarnessHub 不改它的设置。

为什么 dsh 不显示具体预设：审批代理原定只读 `permission.defaultPreset`，读不到时显示“由 dsh 决定”。核实后发现三处都读不到：本机没有 `~/.dsh/settings.yaml` 和 `~/.dsh/cordis.patch.yml`，acp profile 的补丁是空列表；默认预设由 dsh 在运行时按沙箱与审批默认推断（`permission-presets/src/index.ts`）；dsh 的 ACP 既不公布预设，也不处理 `/permission`（命令列表为空）。所以按审批代理给的退路，说明规则，不读取用户配置。

检查：全部测试 573 通过；浏览器测试 11 通过；设计检查通过。新增协议测试：Hermes 的审批说明写明“Allow always”会写入 `command_allowlist`；同一请求由普通 ACP 代理发出时没有这行说明。开发实例中已人工核对 dsh 面板的显示。

未验证：Hermes 0.12.0 的审批桥本身有缺陷（任何选择都按拒绝处理，见 Hermes 与 dsh 接入记录），这行说明要等用户升级 Hermes 后才会遇到真实请求；本轮没有真实触发 Hermes 审批。

## 部署到 4317 服务（失败分类至审批说明）

2026-10-12 00:43–00:45，在服务空闲时部署：2 个会话，没有在途 Run，也没有待生效的切换。部署内容为 `96e477e`（失败分类）、`eb51955`（就绪状态与目录缓存，ADR-033）和 `6dcddce`（审批说明与 dsh 预设）。业务格式不变，仍为 v10。

步骤：

- 核实 PID 与命令行后发 SIGTERM，服务 1 秒内正常退出。
- 冷备份 `data/` 到 `.tmp/backup-data-v10-20261012-004402/`，与原目录逐文件一致。
- 主检出快进到 `6dcddce`，然后构建。
- 经用户登录 shell 在沙箱外启动，参数不变（含 `--manifest`），输出追加到 `.tmp/service-4317.log`。

部署后核对：

- 进程环境中没有代理变量；业务库 `user_version=10`。
- 两个会话都在：14 个 Run、27 条消息，以及 6 个 Run、10 条消息。
- 静态页返回 200，未登录 API 返回 401。日志中没有目录缓存告警；`native-catalogs.json` 会在第一次读取目录时建立。
- 新的一次性启动链接只写在私有日志里，已在用户的浏览器窗格中打开，没有在对话中展示。

回退：停止服务，用上述备份替换 `data/`（并删除 `data/native-catalogs.json`），检出 `7ae169e` 重新构建，再以原参数启动。
