# Session v13 冻结夹具（新存储 ADR-057 第 1 步，T1）

这里的 JSON 文件是冻结的 Session v13 业务库，供新存储的存储转换（T3）、迁移引擎（T4）、放条目（T5）和读函数（T6）的测试使用。**它们是在切换点（把存储升到 v14）之前用当时的构建生成的，切换之后不再能重新生成**：生成器靠 v13 的运行时和存储，切换后这两者就是 v14 了。测试只读这些文件，从不运行生成器。

## 怎么读

```ts
import { loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
const fixture = loadV13Fixture("tools");        // 纯数据：sessions[].snapshot（SessionSnapshot v13）、events（事件日志）、relay（relay_* 表的行）…
writeV13Root(join(tmp, "data"), [fixture]);     // 或者写成 v13 的数据根，用 SqliteConversationStore（或整个应用）打开：升级到 v14，再恢复
```

每个文件的结构（与 `tests/fixtures/relay/v12/` 同一做法，多了 relay 表与内容库）：

| 字段 | 内容 |
|---|---|
| `sessions[]` | `id`、`version`、`lastSeq`、`snapshot`（存下来的整份快照原样）、`events`（该会话的全部事件，按 seq） |
| `createKeys` | `create_keys` 表的行 |
| `relay` | `relay_bodies`、`relay_packets`、`relay_deliveries`、`relay_index`、`relay_log`、`relay_prefs` 各表的行（列名 → 值） |
| `contents` | 会话引用到的内容库对象：公开引用，工具详情还带当时存的 UTF-8 文本 |
| `contentReferences` | 生成时那个 v13 存储的 `contentReferences()`：回收器会保留的内容 id 集合（迁移后必须等于它） |
| `unfinished` | `true`：数据库是在所有者还在干活时拷下来的，有回合没结束或有待定的切换；打开它会触发恢复（OWNER_ENDED） |

`database.ts` 里的 DDL 是 v13 构建建出来的表的**冻结拷贝**（不跟着 `sqlite-store.ts`、`relay-tables.ts` 变）。`renamed(fixture, suffix)` 给每个会话换个名字，好把许多份塞进一个库里做体量测试。

## 夹具清单

| 夹具 | 覆盖什么 |
|---|---|
| `switches` | 多家 Harness 与换家（alpha→bravo→alpha）；**同一家只换模型**（alpha model-a→model-b→model-a）；alpha→bravo→charlie→bravo(model-b)→alpha，含 nativeOptions |
| `relay-states` | 接力的各种状态：带上交接单且被回合结束证实（已确认）；带上但永远无法证实（未确认）后再发一次；只发原话（`attach:"none"`）；整份重发（`attach:"full"`）；被 E1 事件证实；原生一侧拒绝（`not_recorded`）；结束时没证据（`unrecorded`） |
| `commands` | 原生命令回合：`/compact`（compact）、Hub 的清空（`native.cleared`，下一回合开新原生会话）、`/status`（none）、`/mystery`（效果未知）、`/skill:review`（keep）、`/undo`（rewind）、被拒绝的命令；换家后第一条输入就是命令（D1）；两家各自的清空 |
| `branch` | 分支：在较早回合之后（公开历史，附件被引用）、在最新回合之后（原生分叉）、分支的分支；历史里带附件（图与文本） |
| `branch-pending` | 分支刚记下、原生分叉还没做的瞬间（`fork-pending` 的绑定） |
| `import` | 接续的原生会话：读到历史（早的几条没引用）、没读到历史；导入会话上的回合、它的分支、换家后欠导入的历史 |
| `tools` | 工具的各种形态（见下）、计划、通知、活动、产物、附件、审批与提问、被取消的回合、托管 Provider 的回合 |
| `text-extremes` | 超长思考（>64 KiB，代理对正好跨第 65,536 个单位）、1,500 字符的命令、正好 4,096 字节的多字节标题（含代理对）、运行时自己设的字节上限处的通知/活动/计划步、控制字符与长得像别的身份的工具 id（`__proto__`、`tool:weird#1`…）、空思考与空回复、以半个代理对结尾的回复与思考、带空格与 CRLF 的长输入、零步的计划 |
| `at-the-old-limits` | 一个回合达到旧运行时每一道上限：128 个工具、32 条通知、64 个活动、64 步计划、32 个产物、8 个附件 |
| `kept-process` | 保留进程：正持有（头里有 `retained` 与进程组身份）、结束过又重开、中途关掉设置 |
| `unknown-recovered` | 结果未知的回合：连接丢了 → 会话阻塞 → 恢复切换认领它（S1）；未知回合后面排着输入、一条被单独取消（S2）；先排队再切换（S3）；命令的结果未知（S4）；停在阻塞态的会话（S5）；已关闭的会话（S6）；**审查 I2 的排列（S7）**：切换请求时排着一个输入，切换的来源因此跳过它（来源里有后一个被单独取消的），它在切换生效之前跑了并丢了连接，切换随它失败（`SWITCH_SOURCE_UNKNOWN`），后来由恢复切换认领。**认领都在 `switch.sourceRunIds` 里**（这个构建的切换不写 `acknowledgedUnknown`、`mode`、`timing`） |
| `unknown-acknowledged` | 上一条的第一个会话，**手工改成**以后的 v13 运行时会写的样子：恢复切换带 `mode`、`timing` 和 `acknowledgedUnknown`，未知回合不再在 `sourceRunIds` 里。**手工改的，不是这个构建写的**（合约和校验认得这三个字段，运行时从不写），是认领的另一条路 |
| `running-crash` / `recovered-after-crash` | 所有者死时有回合在跑（带着没被证实的交接单、思考、回复、没做完的工具、计划、通知、活动），后面排着两个输入（一个被单独取消），还有一个已请求没生效的切换，**它的来源跳过了排队的那个（不是回合的前缀）**；后者是下一个所有者启动、恢复之后的库 |
| `waiting-crash` / `recovered-after-waiting-crash` | 所有者死时一个对话在等审批、另一个在等回答；及恢复之后 |
| `trial-2026-11-11` | 2026-11-11 试用对话里五家 Harness（dsh、codex、opencode、claude、hermes）十一个回合的真实工具标题、种类、名字、状态、详情头与用量，经真实运行时重放（`tests/fixtures/protocol/trial-2026-11-11.json`）；输入与回复文字是编的（录下来的数据里没有） |
| `from-v12-<name>` ×7 | 冻结的 v12 库（`tests/fixtures/relay/v12/`，G066 用真 v12 构建生成）被这个构建打开、迁到 v13 之后的样子：没有 `run.relay` 的旧回合，及 `relay_index` 行 |

**`tools` 里的工具形态**：有/无 detail 的命令；退出码 0 与非 0；非命令也带退出码；带 diff 的修改（单文件与多文件）；读、搜索、网页抓取、Hub 工具（MCP）；带子任务的 Task，其下嵌套的工具（`parentId`）；任务清单调用（`TodoWrite` 有输入、`update_plan` 有 detail 无输入、`todo_write` 无 detail）；Codex 对同一个子 Agent 既发工具（`agent:<线程>`）又发活动（`<线程>`），子 Agent 里再有子 Agent；每种状态词（含认不出的和大小写变体）；回合结束时还开着的调用；通知三种严重度（含 `severity:"error"` 且 `run.error` 非空，及 `run.error` 为空）；五种活动、带 detail、四种状态；产物（图、文件、带 `title`/`mediaType` 的链接、都没有的链接）；计划（带 `priority` 与不带、带说明）；用量（含缓存写、思考、总数，两种 cost 范围，有/无 context 大小）；附件。

## 外来事件（T5 用）

`foreign-events.json` 不是库：是 22 组 `ControlEvent`（含 NUL、孤立代理、空标题、超长标题/id/状态词、越界的数、非法链接…），每组记着**这个构建收到它时的结果**（`v13` 字段）。其中 17 组让提交抛 `INVALID_DATA` 并停掉整个运行时（限制清点的 D21）：落盘校验接受不了的都在这里；新放条目必须全部接受，规整后记在 `native.clipped`。

## v1–v11 各代样本

`tests/fixtures/storage/generations/v1.json` … `v11.json`：每代一个小库，按那一代能有的字段写（`state.ts` 的 `parseSession` 逐版本列了能有什么），打开它走完整的迁移阶梯。**合成的，不是录下来的**（没有旧构建写过它们）；v3 起有一个结果未知、被恢复切换按来源认领的回合，v8 起有分支，v9 起有导入。v12 用 `tests/fixtures/relay/v12/` 的七个文件（真 v12 构建生成，说明见那里的 README）。`generations/database.ts` 里是读法与写成某一代的数据根。

## 切换点（ADR-057 第 2 步）之后加的：整个应用对这些夹具说什么

`wire.ts`、`generate-wire.mjs`、`wire-golden.json`（`tests/integration/cut-wire.test.ts` 用）：把每个夹具（除 `kept-process`：应用启动时会按它记的进程组去结束进程）写成数据根，在它上面起**整个应用和真实的 web 服务**（升级、恢复、首次回收只报告），再用页面和 Harness 工具进程的读法读一遍：对话列表与就绪状态、每个对话的视图、Markdown 与 JSON 导出、事件日志、交接单视图与每张交接单的文字、上下文表（目录、各回合的各部分、搜索），取摘要。**`wire-golden.json` 是切换之前的构建（`SqliteSessionStore`，26d4907）跑同一份 `wire.ts` 得到的**，切换之后的构建必须给出一样的摘要；不比较的只有：对话的 `version`（转成表是一次提交，旧存储没有）、应用启动的时刻（恢复与导出写它，一律记 `<now>`）、对话列表的次序（旧的按创建，现在按最近更新，见 ADR-057 的列表索引；列表按身份当集合比）、JSON 里键的次序。`WIRE_DUMP=<目录>` 把每个摘要对应的文字留下来，两个构建各跑一遍就能 diff。`wire-golden.json` 不要用切换之后的构建重新生成。

## 生成方法

**以下生成器（`generate.mjs`，以及 `tests/fixtures/relay/v12/generate.mjs`）要的是还有 `sqlite-store.js`（v13 的存储）的构建，即切换之前的提交；切换之后的构建里没有它们依赖的存储，这两个生成器不能再跑。**

由 `generate.mjs` 生成：它用给定构建的**真实 v13 运行时与 SQLite 存储**，配进程内的假 Harness（alpha：报告输入记录事件 E1；bravo：正常结束即证实；charlie：什么都证实不了；delta：同 bravo；dsh/codex/opencode/claude/hermes：试用对话用），在 `os.tmpdir()` 下的临时数据根里跑完各场景，把业务库（快照原样、事件按 seq、relay 表）写成 JSON，然后删掉临时目录。身份是固定计数（带夹具前缀，所以不同夹具的会话不重名），时钟从 2026-11-12T00:00:00Z 起每次加 1 秒，接力密钥是固定的，文字窗口不靠计时器提交，所以**同一构建重跑得到逐字节相同的文件**。「所有者死了」的库是在回合还挂着时用只读连接拷下来的，「恢复之后」的库是把它写成数据根、让存储打开、再拷出来的。

本目录的文件用提交 `1a5f020` 的构建生成（T1 不改 `src/`），命令为：

```sh
pnpm build
node tests/fixtures/storage/v13/generate.mjs dist tests/fixtures/storage/v13   # 同时写 ../generations/
```

切换之后（`CURRENT_VERSION=14`）这个命令会因 `user_version` 不是 13 而失败；要重新生成，必须先检出 `1a5f020` 并构建，再把它的 `dist` 目录传给生成器。

## 数据

全部合成：没有真实对话、轨迹、凭据或运行数据，没有运行任何 Harness 或模型，也没有读取任何 `data/` 目录。工作区在文件里一律写作 `/fixtures/storage/v13/workspace`。
