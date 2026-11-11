# 接力尺子：真实的编码任务做到一半换家（2026-11-11）

**证据等级**：脚本、夹具、判分和演练模式写好了，合成测试与演练通过；**真机一次都没有跑**，下面“结果”是空的，等主负责人跑完再填。演练用脚本化的假 Harness，只证明尺子分得出“被告知的”和“没被告知的”，不说明任何模型怎么样。

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

token 上限比玩具走查的 15 万高得多：编码的一步每次工具调用都要重读上下文，回合用量把这些读取累加起来（多数是缓存读取）；一步的时间上限更紧。

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

待真机运行后填写：提交号与日期、两家的版本与模型、证据文件、每格结果（表由脚本打印）、费用、没跑通的格和原因。

| 任务 | 方式 | 路线 | 结果 | 问题 | 第 2 步工具 | reads | reread | tests | explore | 交接单 token |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

## 没验证与已知局限

- 真机没跑；只有 Claude Code 与 Codex；每格一遍，不是统计（`HH_REAL_REPEAT`）。
- 三个任务小，A、B 对强一点的模型可能太容易，地板与接力就拉不开；到时按结果调任务，不调判分。
- Hub 起的原生会话留在各家自己的存储里（工作目录都在 `hh-ruler-*` 下），脚本不去动它们。清 Claude Code 的：`rm -rf ~/.claude/projects/*hh-ruler-*`；Codex 的线程自己在 Codex 里删。
- 夹具在 `tests/fixtures/ruler/`，判分与驱动在 `tests/real/ruler/`，单测在 `tests/unit/relay-ruler.test.ts`，演练的端到端在 `tests/integration/relay-ruler.test.ts`（都进 `pnpm test`）。
