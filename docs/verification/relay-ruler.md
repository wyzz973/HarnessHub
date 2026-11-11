# 接力尺子：真实的编码任务做到一半换家（2026-11-11）

**证据等级**：脚本、夹具、判分和演练模式写好了，合成测试与演练通过；**真机一次都没有跑**，下面“结果”是空的，等主负责人跑完再填。演练用脚本化的假 Harness，只证明尺子分得出“被告知的”和“没被告知的”，不说明任何模型怎么样。带上上下文桌的开关（`HH_REAL_TABLE=1`，见“带上上下文桌”一节）同样只做了演练和夹具进程的测试，没有对真实的 Claude Code、Codex 跑过。

## 量什么

此前的真机只验证过“记住一个数”。这把尺子量：**一个真实的编码任务做到一半换一家 Harness，新那家接不接得上，接上要花多少**。上下文的传递方式（推少量 + 按需读回）要改，改前改后各跑一遍，对比这张表。

三个任务，运行时各在临时目录里生成一个独立的小仓库（几个源文件 + 一套会失败的 `node --test` 测试，不装依赖），各分两步，第 2 步只有知道第 1 步才说得通：

| 任务 | 第 1 步（用户说） | 第 2 步（用户说） | 第 2 步依赖 | 判分 |
|---|---|---|---|---|
| A `cart` | 读代码，只修 `test/money.test.js` 里失败的那条；给三条规矩：不许改 `test/`，不许改 `src/rates.js`（别的团队的拷贝，有问题在自己的代码里绕），金额一律整数分 | “继续，把剩下的也修好。” | 三条规矩、哪条已修 | 10 条测试全过；`test/` 与 `src/rates.js` 的文件摘要没变；评判者的隐藏探针（测试没用到的金额）里金额是整数分且数值对 |
| B `booking` | 调查一条失败测试的根因，**只汇报、不改任何文件** | “按刚才的结论修掉它。” | 第 1 步汇报的根因（`src/range.js` 的 `contains()` 把区间末端算进去了） | 测试全过；探针直接检验 `contains()` 的契约（只在调用处绕过去的“治标”会被抓到）；第 1 步后文件摘要没变；汇报点名了 `contains` 与 `range` |
| C `worker` | 运行 `node scripts/worker.js`（处理并清空 `queue/` 的 100 个任务，输出约 100 行），只用一句话概括 | 问某个任务那一行的 `etag` | 第 1 步那次运行的**完整输出**（队列被清空，重跑得不到；每格的队列与答案各不相同） | 回复含正确的 `etag`；另记是对 / 错 / 不知道 / 其他，以及是否又跑了一遍 worker |

C 是给以后“按需读回”备的：交接单本来就不带成功命令的输出，现在的预期是答不上或答错，如实记。

每个任务三种跑法：`solo` 基线（两步同一家，两家各一遍）；`relay`（第 2 步前换到另一家，Hub 按默认附交接单，两个方向各一遍）；`floor` 地板（同 `relay`，第 2 步请求带 `relay:{attach:"none"}`，两个方向各一遍）。

## 判分与指标

判分全由脚本做，不问模型：跑仓库自己的测试（TAP 逐条名字）、比文件摘要（改了、加了、删了什么）、跑评判者的隐藏探针、读回复里的字符串。第 1 步没做成第 2 步要的事（A 没修好 money 或顺手修了别的；B 第 1 步就把 bug 修了；C 没运行 worker；任一步没正常结束）的格记 `INVALID`，不算接力的结果，连续 4 格 `INVALID` 就停；`ERROR` 是脚本没能跑这一格（Harness 不可用之类），3 格就停。

第 2 步的衔接成本从工具调用里数：总工具数、读了多少个不同的文件（`reads`）、其中第 1 步已读或已改过的（`reread`）、跑了几次测试（`tests`）、第一次修改之前探索了多少个工具（`explore`）。另记第 2 步交接单的估计 token 和带了哪些条目（`handoff`，来自 Store 里的 `run.context_prepared`）、两步耗时、回合用量、回合状态、回答原生审批的次数。Claude Code 按工具名和路径数；Codex 用 shell 命令读文件，按命令文本对照仓库已知文件识别，**Codex 一侧的读数是近似的**，总数不近似。原生审批只选“允许一次”（Claude Code 的 `allow-once`、Codex 的 `accept`），从不选带“以后都允许”的那项。

## 怎么跑

```sh
. "$HOME/.cache/harnesshub-acceptance/env.sh"        # LOGIN_PATH 与 RUN（real-acceptance.md 第 1 节）
pnpm build
HH_REAL_DRY=1 node --test dist/tests/real/relay-task.real.js      # 先演练，约 15 秒，不启动任何 Harness

EVIDENCE="$HOME/.cache/harnesshub-acceptance/evidence/$(date +%F)-ruler"; mkdir -p -m 700 "$EVIDENCE"
RUN node dist/tests/real/guard.js snapshot claude,codex "$EVIDENCE/guard-before.json"
RUN HH_REAL_HARNESSES=claude,codex HH_REAL_MODEL_CLAUDE=haiku HH_REAL_MODEL_CODEX=gpt-6-luna HH_REAL_OPTIONS_CODEX='{"reasoning_effort":"low"}' \
  HH_REAL_EVIDENCE="$EVIDENCE/ruler.json" node --test dist/tests/real/relay-task.real.js
RUN node dist/tests/real/guard.js snapshot claude,codex "$EVIDENCE/guard-after.json"
RUN node dist/tests/real/guard.js compare "$EVIDENCE/guard-before.json" "$EVIDENCE/guard-after.json"   # 退出码 1：停下报告，不要自行恢复
```

模型按本机可用的便宜型号选（上面是 `relay-conformance.md` 里用过的）。脚本自己也在整趟前后各拍一次配置守护并比较，变了就失败；外面这一轮是手册的整轮要求。证据 JSON 每格跑完写一次，中途断了也留着已完成的格；终端最后打印一张表：每格一行，再按任务和跑法汇总。先试一格：

```sh
RUN HH_REAL_HARNESSES=claude,codex HH_REAL_MODEL_CLAUDE=haiku HH_REAL_MODEL_CODEX=gpt-6-luna HH_REAL_EVIDENCE="$EVIDENCE/ruler-one.json" \
  HH_REAL_TASKS=booking HH_REAL_MODES=relay HH_REAL_DIRECTIONS=forward node --test dist/tests/real/relay-task.real.js      # 1 格，2 条提示
```

演练也可以带真名（`HH_REAL_DRY=1 HH_REAL_HARNESSES=claude,codex …`），打出带真实路线名的表，看一眼格式，不启动任何东西。

| 变量 | 作用 | 默认 |
|---|---|---|
| `HH_REAL_HARNESSES` | 两家 Harness，顺序即“正向”（第一家→第二家） | 必填（演练默认 alpha,bravo） |
| `HH_REAL_EVIDENCE` | 证据 JSON | 必填（演练可不填） |
| `HH_REAL_MODEL_<ID>`、`HH_REAL_OPTIONS_<ID>` | 各家的模型、原生选项（JSON 对象） | 本机默认 |
| `HH_REAL_TASKS` | `cart,booking,worker`（或 `a,b,c`） | 全部 |
| `HH_REAL_MODES` | `solo,relay,floor` | 全部 |
| `HH_REAL_DIRECTIONS` | `both`，或 `forward`（只第一家→第二家；`solo` 仍两家各一遍） | `both` |
| `HH_REAL_REPEAT` | 每格重复几遍（模型有随机性，一遍不是统计） | 1 |
| `HH_REAL_STEP_MINUTES` | 一步的执行预算（脚本另有多 1 分钟的兜底） | 5 |
| `HH_REAL_TOKEN_LIMIT` | 一步超过这么多 token 就停整趟 | 2000000 |
| `HH_REAL_KEEP=1` | 不删临时目录（排查某格的仓库） | 删 |
| `HH_REAL_TABLE=1` | 带上上下文桌，见下一节 | 不带（行为与此前完全一样） |

token 上限比玩具走查的 15 万高得多：编码的一步每次工具调用都要重读上下文，回合用量把这些读取累加起来（多数是缓存读取）；一步的时间上限更紧。

## 带上上下文桌（`HH_REAL_TABLE=1`）

默认的尺子直接用 `application()` 的 Runtime，不起网页服务，`TableMount` 没有地址，原生进程拿不到桌子的环境变量，换家的交接单也不会提工具。要量“交接单 + 经 Hub 的工具读回”这条路，打开这个开关：

- **每格起一个真实的网页服务**（`startWebServer`，回环的随机端口，与 4317 是同一份实现），回合仍由尺子直接驱动这个服务的应用实例，所以 Hub 起的每个原生进程都带 `HARNESSHUB_URL` 与自己的令牌，Harness 配置里有 Hub 工具条目时就能调用 `hub_turns`、`hub_read_turn`、`hub_search`。关闭时一切与以前一样，基线可以重跑对比，终端表格也不多列。
- **尺子不安装工具条目，只读。** 条目是管家的事，要先装：用管家的接口 `POST /api/v1/capabilities/hub-tools/install`，请求体 `{"harnessId":"claude"}` 与 `{"harnessId":"codex"}`（登录与 CSRF 同其他写接口；`GET /api/v1/capabilities/hub-tools` 看两家现在的状态；不用时同路径换 `uninstall` 取下）。**必须从跑尺子的同一份构建装**：条目里写的是 Hub 所用的 Node 和这份构建的 `dist/src/cli/hub-tools.js` 的路径，路径与 Hub 现在要写的不一致（在别的 worktree 里装的、构建搬了位置）就被判为没装，状态会是 `outdated` 或 `different`，那一格的证据里 `tools` 为 false，交接单也不会提工具。
- **交接单只在事实成立时提工具**：目标这家的进程带着桌子的环境变量，并且它的用户级配置里有 Hub 现在会写的那条条目（装好了、没被改过、指向这份构建）。成立时说明部分多三句（这是摘要、完整对话与每条命令的完整输出在 HarnessHub 里可用三个工具读回、轮次编号相同、查不到再说不知道、别为拿输出重跑有副作用的命令），并在每条“没附输出”的命令后标“输出共 N 行，未附”。不成立时交接单与以前逐字节相同。
- **证据里每一步多一项 `table`**：`carried`（这一步的进程带了桌子的环境变量）、`tools`（这家的配置里有 Hub 的工具条目，按步骤结束时读到的算）、`told`（这一步的交接单提了工具，没有交接单的步骤为 false）、`calls` 与 `called`（这一步调用了几次 `hub_*` 工具、各是哪个；按工具名里是否含 `hub_turns`、`hub_read_turn`、`hub_search` 数，所以 `mcp__harnesshub__hub_read_turn`、`harnesshub/hub_read_turn` 这类带前缀的都算；名字不含这几个词、只在标题里提到的，要标题同时含 `harnesshub` 才算，shell 命令里出现这些词不算）。`relay.hubTools` 是交接单自己记下的“提过工具”。证据文件顶层多 `tableMounted`。
- **终端表格多一列 `s2 hub`**（汇总表多 `hub calls`，第 2 步调用次数的中位数）：`no-env`（进程没带桌子）、`env`（带了环境变量，这家配置里没有条目）、`tools`（有条目，交接单没提）、`tools+told`（有条目，交接单也提了），后面是调用次数和各是哪个，例如 `tools+told 2:search,read_turn`。

真机只在上面的命令里多一个变量，先试一格再整趟（装好条目之后）：

```sh
RUN HH_REAL_TABLE=1 HH_REAL_HARNESSES=claude,codex HH_REAL_MODEL_CLAUDE=haiku HH_REAL_MODEL_CODEX=gpt-6-luna HH_REAL_EVIDENCE="$EVIDENCE/ruler-table-one.json" \
  HH_REAL_TASKS=worker HH_REAL_MODES=relay HH_REAL_DIRECTIONS=forward node --test dist/tests/real/relay-task.real.js      # 1 格，2 条提示：任务 C，claude 换到 codex
```

演练也能带上它：`HH_REAL_DRY=1 HH_REAL_TABLE=1 node --test dist/tests/real/relay-task.real.js`（约 15 秒，仍然不启动任何 Harness）。脚本化的 Harness 在这里扮演“配置里已有 Hub 工具条目”的 Harness：每个绑定拿到桌子的环境变量并声明有工具，一个回环上的小服务为这一格的 Runtime 回答 Hub 真正的 `/api/table` 路由；worker 的第 2 步里，被交接单告知有工具的那家，用 Hub 真正的工具程序（`cli/hub-tools.js`，作为独立进程、带着拿到的环境变量）先搜后读，把第 1 步的完整输出取回来，答出 etag；没被告知的（地板）答“不知道”。这证明环境变量经 `TableMount` 到了进程里、令牌在真实的 `/api/table` 路由上有效、工具程序读得回一轮、尺子分得出“有工具且被告知”和“没有”，**不证明**真实的 Claude Code 与 Codex 会把环境变量转给 MCP 服务器、会加载条目、会照说明去调用。

## 每跑一遍大约多少条真实提示

每格 2 条（两步各一条消息）。

| 范围 | 格 | 提示 |
|---|---|---|
| 全部（3 任务 × solo 2 + relay 2 + floor 2） | 18 | **36** |
| 一个任务 | 6 | 12 |
| 只量 relay 与 floor（`HH_REAL_MODES=relay,floor`） | 12 | 24 |
| 只正向（`HH_REAL_DIRECTIONS=forward`） | 12 | 24 |
| 一格 | 1 | 2 |
| `HH_REAL_REPEAT=N` | ×N | ×N |

每条是一个带若干次工具调用的回合，不是一句话；换家时第二家冷启动。按每格几分钟估，整趟约一到一个半小时；用量没有实测。

## 结果

**2026-11-11 真机**。真实的 Claude Code（模型 haiku）与 Codex（默认模型，`reasoning_effort` low），本机原安装与登录。每格一遍，两个方向各一格。证据在 `~/.cache/harnesshub-acceptance/evidence/2026-11-11-ruler/`（`ruler-baseline.json`、`ruler-table.json`）。每趟前后配置守护一致。

基线（代码 `1b8ad08`，没有桌子，36 条真实提示）：

| 任务 | 全程一家 | 换家（交接单） | 换家且不给交接单 |
|---|---|---|---|
| cart：按用户定的规矩接着修 | 2/2 | 2/2 | 0/2（改了测试或汇率文件） |
| booking：按上一家的结论修根因 | 2/2 | 2/2 | 2/2 |
| worker：问完整输出里的细节 | 2/2 | 0/2（答不上） | 0/2 |

带桌子（代码 `895f210`，`HH_REAL_TABLE=1`，工具经管家装进两家的用户级配置，只跑换家，12 条真实提示）：

| 任务 | 路线 | 结果 | 第 2 步调用 Hub 工具 | 交接单 token |
|---|---|---|---|---|
| cart | claude>codex | 通过 | 0 | 1329 |
| cart | codex>claude | 通过 | 0 | 1890 |
| booking | claude>codex | 通过 | 0 | 1491 |
| booking | codex>claude | 通过 | 0 | 1455 |
| worker | claude>codex | 通过 | 1（search） | 900 |
| worker | codex>claude | 通过 | 2（search、read_turn） | 870 |

- worker 从 0/2 变成 2/2：两家都真的调用了 Hub 的工具，读回上一家那条命令的完整输出，答对了。工具条目的加载、会话标识的转发、模型主动调用，在两家上都第一次得到真机证据。
- cart 与 booking 里新那家没有调用工具（交接单够用），结果与基线相同。交接单因多了“怎么取更多”一段，大了约 150–200 token。
- 换家的额外成本（基线，booking 第 2 步中位数）：工具调用 2 → 3.5 次，重读文件 0 → 5 个，耗时约 14 → 16 秒；不给交接单是 5.5 次、5.5 个、约 23 秒。

## 没验证与已知局限

- 只有 Claude Code 与 Codex；每格一遍，不是统计（`HH_REAL_REPEAT`）；带桌子时没有重跑“全程一家”和“不给交接单”。
- 带桌子的真机路径（`HH_REAL_TABLE=1` 不加 `HH_REAL_DRY`）没有对真实的 Harness 跑过：网页服务的起停与桌子的接线用夹具进程（一个会用环境变量读回对话的 ACP 夹具）测过，工具条目在 Claude Code 与 Codex 里的加载、环境变量的转发、模型会不会调用，都要等第一遍真机。每格要多起一次网页服务（含一次发现扫描和各家的版本探测，与 4317 启动时做的相同），整趟会慢一些。
- 三个任务小，A、B 对强一点的模型可能太容易，地板与接力就拉不开；到时按结果调任务，不调判分。
- Hub 起的原生会话留在各家自己的存储里（工作目录都在 `hh-ruler-*` 下），脚本不去动它们。清 Claude Code 的：`rm -rf ~/.claude/projects/*hh-ruler-*`；Codex 的线程自己在 Codex 里删。
- 夹具在 `tests/fixtures/ruler/`，判分与驱动在 `tests/real/ruler/`（带桌子的部分：`mount.ts` 记录哪个进程拿到过桌子、`web.ts` 起真实的网页服务、`dry.ts` 的 `dryTableHub`），单测在 `tests/unit/relay-ruler.test.ts`，演练的端到端在 `tests/integration/relay-ruler.test.ts`，网页服务那一格用夹具进程测的在 `tests/integration/relay-ruler-web.test.ts`（都进 `pnpm test`）。
