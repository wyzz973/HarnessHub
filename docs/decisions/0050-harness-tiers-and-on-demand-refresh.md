# ADR-050：Harness 分层默认隐藏与按需刷新

状态：accepted，2026-10-22。依据 [ADR-048](0048-harness-scope-and-workbuddy.md)“用户决定”第 1、8 项（用户 2026-10-21 回复“全部按推荐”）；实现细则按总指挥为第二批任务 C3 写的说明，与之不同的两处（任务结束的服务端扫描、`rescan` 的 `after`）在“决定”第 3 条写明理由。

## 背景

- 决定 1：Cursor、Gemini CLI、Pi 冻结并默认隐藏。目录、适配器、测试与历史证据保留；“我的 Agent”、选择器与能力页默认不显示，设置里可再显示；停在它们上面的历史对话照常打开（ADR-044 第 6 条）。
- 决定 8：本机 Harness 的变化只在手动“重新检测”、管理任务完成、登录 shell 目录变化时刷新，另加窗口重新获得焦点时（至少间隔 60 秒）；不再后台轮询。
- 现状（基点 6eee665）：页面每 5 秒（隐藏时至少 10 秒）读一次 `GET /api/v1/state`，有安装任务时每 800 ms；而 `/state` 与 `GET /api/v1/harnesses` 每次都完整扫描：发现、系统版本与原生安装渠道的检查。第一轮评估（2026-10-21）测得每次扫描约 455 ms、10 个 npm/uv 子进程、建删 47 个临时目录，空闲的页面也在不停地付这个代价。
- 两处第一批留下的缺口：只有“只问一次”命令、没有交互命令的已验证程序（dsh）在详情栏只显示会话 ID；公开错误信息先截到 512 字再把家目录写成 `~`，家目录恰好跨过截断点时会留下半截路径。

## 决定

1. **分层**：`HarnessView.tier`（必填）为 `focus`、`frozen` 或 `catalog`，由 `src/adapters/catalog.ts` 的 `harnessTier(id)` 给出：focus 是 ADR-048 的七个（claude、codex、opencode、dsh、hermes、openclaw、workbuddy；WorkBuddy 尚无目录定义，先归 focus），frozen 是 cursor、gemini、pi，其余目录条目是 catalog。类型 `HarnessTier` 与取值列表在 Web 契约里，目录重新导出；能力矩阵（`plan/native-capabilities.json`）也给每个 Harness 记分层，两边须一致。

2. **默认隐藏**：浏览器偏好 `showFrozen`（默认关），设置页“发现”一节的开关“显示冻结的 Harness（Cursor、Gemini CLI、Pi）”，说明“冻结：保留适配与历史对话，不再打磨；停在它们上面的对话照常打开”。
   - 隐藏集合：开关打开时为空，否则为所有 `frozen`，但当前对话的选择与草稿所选的 Harness 永远不隐藏（`hiddenHarnesses`，`web/src/lib/prefs.ts`）。
   - 作用于：Composer 的 Harness 选择器、欢迎页列表、命令面板的“用 X 开始新对话”、“我的 Agent”列表与计数（下方一行“已隐藏 N 个冻结的 Harness，可在设置里显示”，可跳到设置）、能力页的列、“只看一个 Harness”下拉、共享目录与插件说明里逐个 Harness 的行、读取规则列表，以及只被隐藏 Harness 看到的能力条目（能力页正在看的那个 Harness 不隐藏）。
   - 不作用于：名称查找、Inbox、详情栏、条目详情、分支与切换历史，它们继续用完整列表，所以停在冻结 Harness 上的对话照常打开、照常显示名称，Composer 里仍显示并可选当前选择。
   - 开关打开时，“我的 Agent”给冻结项加“冻结”标记。

3. **按需刷新**：
   - `GET /api/v1/state` 与 `GET /api/v1/harnesses` 返回**上次完成的扫描**，不启动发现；有扫描在进行时返回上次结果，不等待。`WebState.harnessesScannedAt`（必填）是那次扫描开始读取本机的 ISO 时间：在它之后的变化可能不在列表里。启动扫描在监听开始前完成，所以总有结果。
   - 服务端扫描的时机：启动；`POST /api/v1/harnesses/rescan`（客户端能要求的唯一完整扫描）；登录 shell 目录变化后；管理任务的检查与提交前；检查更新后；**管理任务的结束经 `GET /api/v1/installation-jobs/:id` 读到时**，任务结束于上次扫描开始之后才扫，同一个结束只扫一次。
   - 任务结束的这条是对总指挥说明的补充。`LocalHarnessManagement` 没有可订阅的任务完成回调，也没有可挂的发布事件，这个任务也不能改它；说明的退路是只靠页面在看到任务结束后要求扫描。实测这样做时，通过 HTTP 等任务结束、再读 Harness 列表的已有集成用例（G011-UG6、G011-UG7、G011-IN5、G011-IN7、G011-UN4 与“upgrade CAS …”，分属其他任务的四个文件）读到的是任务开始前的列表，全部失败：它们写下的“任务完成后，Harness 列表反映它的结果”是 HTTP 契约的一部分，不该只对页面成立。所以由读到任务结束的那次读取承担扫描。它不在 `/state` 与 `/harnesses` 上，也不定时，页面从不读单个任务的记录。
   - `POST /api/v1/harnesses/rescan` 可带 `{after}`（这个 Gateway 时钟的 ISO 时间）：等到一次开始于该时刻或之后的扫描结束才返回，没有就在进行中的扫描之后再扫一次。不带时照旧共用进行中的扫描。页面要求“任务结束后的扫描”时带上任务的结束时间，因此不会误用一次开始得更早、还没看到任务结果的扫描。时钟只到毫秒，同一毫秒开始的扫描算作之后：Gateway 在读到任务结束之后才开始的扫描必然在结果之后。
   - 页面不定时请求。打开页面或回到页面（`window` 的 `focus`、`visibilitychange` 变为可见）时读一次 state，这一步不扫描。上次扫描开始已满 60 秒、并且本页 60 秒内没有因此要求过扫描时，再 `POST rescan`，所以连续的获焦抖动最多一次。
   - 有任务进行时，页面每 800 ms 读一次 state（页面隐藏时 10 秒），这时的 state 已不扫描、没有子进程。看到任务结束于上次扫描开始之后，就以结束时间为 `after` 要求一次扫描，每个结束只要求一次，与读任务的循环分开持有，循环停下不会取消它；这次请求失败时，回到页面那次读取再要求一次。
   - “重新检测”按钮随时扫描，不受 60 秒限制。其他时候页面不发请求。
   - 其他按请求扫描的地方不变：能力页的读取与检查（ADR-045 的范围）。原生恢复命令不扫描：命令与安装版本无关，读上次扫描即可（2026-10-22 按 [ADR-053](0053-latest-version-baseline.md) 决定 3 修订；原文“它只为当前安装的版本给出可执行的命令，与管理检查同理”作废）。导出只需要名称，改用上次扫描。

4. **只问一次的显示**：`NativeResumeView` 没有 `interactive` 而有 `once` 时，详情栏显示“只问一次 · 在该对话的工作区目录中运行”的命令及“复制只问一次的命令”、`onceNote` 和两条提示（首次运行可能询问信任目录；两边的回合会交错），不显示“复制恢复命令”。有 `interactive` 时不变。（文案原为“只问一次（已用真实回合验证）”，2026-10-22 按 ADR-053 去掉括号里的话：页面不写在哪个版本上验证过，核对版本见 ADR-039 的表。）

5. **公开错误信息**：`publicFailure` 先把家目录的每种写法写成 `~`，再截到 512 个字符。家目录在截断之前已整体替换，跨过截断点的家目录不会再留下前半截；截断只缩短已经写成 `~` 的文字。

6. **对话标题**：页面自己打开的对话（新建、分支、接续本机会话）用与 Gateway 相同的规则命名（Web 契约的 `conversationTitle`）。以前页面写一个简化标题，再等 5 秒一次的 state 读取纠正，去掉轮询后，分支与接续的对话会一直显示“新对话”。

## 否决方案

- **保留轻量的 `/state` 轮询**（只读 SQLite，不扫描）：否决。用户选的是“不再后台轮询”，而且任务进行时之外，页面需要的变化都有明确的触发点。
- **服务端定时重扫**：否决。理由同上，而且会在没有人看页面时持续运行子进程。
- **只靠页面在看到任务结束后要求扫描**（总指挥说明的退路）：否决为唯一手段，理由见决定第 3 条。页面的这一路保留，服务端在读到任务结束时补上。
- **在 `LocalHarnessManagement` 加任务完成回调**：本任务不能改 `src/infrastructure/management/*`，留给后续。即使有回调，任务结束对读者可见与扫描完成之间仍有间隙，读到结束时再扫描能给出“读到结束，列表已更新”的保证。
- **删除冻结三项**：ADR-048 决定 1 已否决。

## 影响

- 契约：`HarnessView.tier`、`WebState.harnessesScannedAt`（页面严格解码，缺失或不对即 `INVALID_RESPONSE`）、`/state` 与 `/harnesses` 不扫描、`rescan` 的 `after`、读任务结束时的扫描、`conversationTitle`；见 [Web 契约](../contracts/provider-web-mvp.md) 文末 ADR-050 一节。
- 偏好：`showFrozen`，“恢复默认显示偏好”把它关掉。
- 侧栏里没有打开的对话，其运行状态只在打开或回到页面、有任务进行或用户操作时更新，不再每 5 秒更新；等你处理的审批与提问仍由推送实时更新（[ADR-035](0035-attention-and-request-deadlines.md)）。如果要让后台对话的“进行中”实时变化，需要另外推送对话摘要，留给后续。
- 能力页 MCP、指令、子 Agent 面板里逐个 Harness 的行属于各自的组件，这次不过滤。
- 测试：已有浏览器用例中用 Gemini CLI 或 Cursor 的（未验证版本、官网安装列表、能力页 CA1）先在设置里显示冻结项，CA9 改为按默认隐藏断言；浏览器夹具可以让 control-peer 冒充目录里的 Harness（`--version` 答指定版本），这时发现用的 PATH 只含 Node.js，不会发现本机自己装的 `dsh`、`claude`。

## 验证（合成，2026-10-22）

- `tests/unit/catalog-import.test.ts` G011-NC3：七个 focus、三个 frozen、注册表条目与未知标识为 catalog，分层标识都在内置目录里（WorkBuddy 除外），内置目录里 6、3、36 个。
- `tests/unit/web-api.test.ts`：state 缺少或写错 `tier`、`harnessesScannedAt` 时拒绝；`rescan` 只在给出时间时带 `after`；隐藏规则与例外。
- `tests/integration/web-server.test.ts` G050-NC9：多次读 `/state`、`/harnesses` 不增加扫描次数，`harnessesScannedAt` 不变；`POST rescan` 扫一次且时间更新；扫描进行中读 state 立即返回上次结果；`after` 的覆盖规则与 400；进行中的任务不扫描，读到任务结束扫一次，再读不扫；分层取值（codex=focus、gemini=frozen）。G050-NC10：家目录从第 506 个字符开始、跨过第 512 个字符的错误消息，应答为替换后的前 512 字，不含家目录的任何前缀。
- `tests/browser/web.browser.ts` G054-FZ1：默认的选择器、欢迎页、命令面板与“我的 Agent”都没有冻结三项，提示行可跳到设置；打开开关后出现并带“冻结”标记；在 Gemini CLI 上建立对话后关掉开关，该对话仍能打开、显示 Gemini CLI、Composer 仍显示并提供它，新对话的选择器不再列出它。G054-FZ2：空闲 12 秒没有 state 与 rescan 请求；获焦与可见各读一次 state、上次扫描不满一分钟不扫描；满一分钟时多次获焦只扫一次；按钮立即扫描；任务进行时相邻读取间隔 0.7–3 秒，结束后带结束时间要求一次扫描、之后不再读取；这次请求被拒绝时页面提示连接问题，回到页面时再要求一次且只一次。G054-FZ3：已验证版本的 DeepSeek Harness 详情栏显示“只问一次”的行、`dsh headless --session-id` 命令与两条提示，没有“复制恢复命令”。
- 定向变异（人工执行，未保留）：`/state` 改回调用 `rescan()` 时 G050-NC9 失败；隐藏规则返回空集合时 G054-FZ1 失败；去掉 NativeResume 的只问一次分支时 G054-FZ3 失败；改回先截断再替换时 G050-NC10 失败；去掉读到任务结束时的扫描时，G050-NC9 与上述六个已有集成用例失败；回到页面的读取不再重试任务结束的扫描时，G054-FZ2 失败。
- 正式入口自测：`node dist/src/cli/web.js --port 0 --data-dir <临时> --workspace-lock-root <临时> --cwd <临时> --path-only --no-login-shell`，HOME 为临时目录，PATH 只含 Node.js 与 npm 的链接和 `/usr/bin:/bin`，不会发现或运行本机的任何 Harness。无头浏览器打开页面后空闲 20 秒，`ps` 每秒采样一次，共 19 次，Gateway 没有子进程，页面没有 state 与 rescan 请求；随后点“重新检测本机入口”，采样到 `npm prefix` 等子进程（对照）。SIGTERM 后退出码 0。
- 不在本记录内：真实引擎上的刷新观感由主代理在 4317 上核对。只面向 macOS（ADR-044）。

## 2026-10-22 修订（ADR-053）

- 决定 3 中“原生恢复命令按请求扫描”改为不扫描：`GET /api/v1/sessions/:id/native-resume` 读上次扫描即可，命令与安装版本无关（上文已就地改写）。
- 决定 4 的文案去掉“已用真实回合验证”；背景里“已验证程序（dsh）”说的是当时的机制，现在任何版本的 dsh 都给出一次性命令。
- 上面“验证”一节记录的是 2026-10-22 合成验证时的断言（G054-FZ3 当时写“已验证版本的 DeepSeek Harness”）；`plan/test-cases.json` 里 G054-FZ3 的期望已改为任意版本，第三批 D1 按新期望改写用例。
