# R4 · 现有接力实现的精确基线与缺口（第 1 轮内部基线）

调研员 R4，2026-11-02。仓库 `HarnessGateway-relay`，分支 `cc/relay-design`（HEAD `07a0825`）。本文件是 R4 在仓库中唯一写入的文件。标注约定：**【事实】** 有代码、文档或运行结果为据；**【推断】** 由事实推出、尚未验证；**【建议】** 只是设计建议，不是已接受的决定。来源编号见第 7 节。

---

## 1. 范围与方法

- **阅读日期**：2026-11-02。
- **来源类型**：
  - 本机源码：领域、应用、基础设施、驱动、Web 服务与前端；
  - 仓库文档：契约、不变量、ADR、能力矩阵、验收记录、任务与测试矩阵；
  - 测试：单元、集成、协议、浏览器、真实用例与夹具；
  - 旧 HarnessHub 文档：只读，用户已确认的方向。
  - 本报告不需要网络来源，也没有使用网络。
- **方法**：
  1. 逐行阅读与接力相关的代码路径：`context.ts`、`runtime.ts` 的 create、import、send、switch、fork、resetNative、execute、applySwitch，`state.ts` 的解析与转移规则，以及 Store 和内容存储；
  2. 对照契约与 ADR，逐条判断哪些已实现、哪些是 proposed、哪些互相矛盾；
  3. **本机合成运行（只读导入仓库源码）**：在会话 scratchpad 里用 Node 加载钩子，在内存中剥离类型，并改写 3 处参数属性构造器（不改仓库文件）。
     - 合成复现 R1–R6：正式的 `SessionRuntime` 加 `SqliteSessionStore`（真实 SQLite，数据根是 scratchpad 里的临时目录，运行后删除），配一个**合成的** `HarnessControl`。它可恢复，命令目录里有 `review`，会记录收到的每条 prompt。
     - 合成测量 M1–M5：纯函数的耗时与预算边界。
     - 运行中没有启动任何 Harness，没有碰 4317 或 `data/`，没有读取用户对话。
- **局限**：
  - 合成复现证明的是 Runtime 的行为，不是真实 Harness 的行为。
  - 原程序在“回合被拒”时是否已把输入写入转录、会话标题是否被信封污染，都没有核实（列入第 6 节）。
  - 测量数字只代表本机（macOS，Node v26.11.1）上的合成数据，用来判断量级。
  - 各驱动只读了与提示构造、命令目录、通道线索有关的部分。

---

## 2. 发现

### 2.1 简报第 2 节逐条复核

| # | 简报说法 | 结论 | 证据 | 更正与补充 |
|---|---|---|---|---|
| 1 | 唯一业务权威是公共 Session（SQLite，业务库 v12） | 正确 | [S9] sqlite-store.ts:265、466；[S3] runtime.ts:271 | 【事实】`state.ts:28` 的 `CURRENT_SCHEMA = 9` 是无人引用的过期常量。 |
| 2 | `nativeBindings[] = {harnessId, controlId, checkpoint, throughRunId, status}` | 基本正确 | [S5] session.ts:149-160；[S4] state.ts:226-235、315-316 | 还有 v9 的 `observed`。status 共 5 个值：ready、unconfirmed、archived、fork-pending、forking。按 `harnessId:controlId` 计，活跃绑定唯一。 |
| 3 | `throughRunId` 是“原生会话已同步到哪一轮公共历史”的水位 | **部分错误** | [S3] runtime.ts:1492-1497、1337-1340 | 【事实】实际语义是“最后一次**已派发**、且原生引用已确认的 Run”：`throughRunId: execution.dispatched ? run.id : binding.throughRunId`。它不看 `backend.status`，也不看这一轮是否真的注入了增量。比较时用的是 `runs` 数组下标，不是 seq。 |
| 4 | 交接材料是全部公共历史的 JSON，前加英文说明，作为用户消息发出；工具、改动、差异、计划、待办、审批、用量都不带 | 正确，需补充 | [S2] context.ts:37-55；[S10] acp.ts:529；[S11] codex.ts:503；R1 | 【事实】每条历史只有 runId、outcome、user（messageId、text、附件的 name/mediaType/kind/bytes）和 assistant（messageId、text）。<br>还缺：执行者 harnessId 与模型、error.code/message、thinking、notices、activities、outputs、timing。<br>`branchedHistory` 丢掉了 `ForkedMessage.harnessId`，也丢掉了 import 的 omitted、complete、historyRead（context.ts:48）。<br>“作为用户消息”成立：ACP 是 prompt 的第一个 text block，Codex 是 `input[0].text`，附件的文件指针追加在它后面。<br>**新对话的第一条输入也会被包成信封（history 为空）**：runtime.ts:1392，合成复现 R1 的第一条是 `envelope()`；真实用例 codex-session.real.ts:134-137 也从模型请求里取信封。 |
| 5 | 超过 `MAX_CONTEXT_BYTES = 1 MiB` 报 `CONTEXT_TOO_LARGE`，不截断、不摘要，长对话因此无法换人 | 正确但**严重低估** | [S2] context.ts:56-58；[S3] runtime.ts:1334、1570；R3、R6；M1 | 【事实】闸门有两个条件，取更严的那个：UTF-8 字节数 > 1 MiB，或者再做一次 JSON 转义后加 4096 > 1 MiB。<br>实测正文上限（100 轮）：散文约 1.01 MB，Markdown 约 0.89 MB，代码类约 0.74 MB。<br>`execute()` 每一轮都**先按完整历史**建一次信封（1334），然后才按绑定过滤。所以历史一旦超限：同一 Harness、绑定就绪的下一轮也失败（R3）；任何切换都失败（R3）；blocked 后的恢复切换也失败，会话永久停在 blocked（R6）。<br>问题不止“不能换人”，而是**对话整体停摆**。 |
| 6 | 换回原 Harness 时只补 `throughRunId` 之后的 Run（仍是 JSON 包装）；没有新 Run 时原样发送（runtime.ts:1334–1340、1392） | 正确，需补充 | [S3] runtime.ts:1335-1340、1392；R4、R5 | 【事实】增量取的是“下标在 throughRunId 之后的全部已终结 Run”，从未派发的输入也在内（已取消的排队输入、SWITCH_NOT_EFFECTIVE、WORKSPACE_BUSY），见 R5。<br>每个增量信封都**重复带上整段 `branchedHistory`**（R4）。<br>绑定不是 ready 时直接 `NATIVE_STATE_UNCONFIRMED`（1336）。 |
| 7 | 疑似缺陷：切换回来后第一条是原生斜杠命令时，不注入增量，但仍推进 throughRunId | **已证实，范围更大** | [S3] runtime.ts:1341、1392-1397、1496；R1、R2 | 【事实】只要命令名出现在原生命令目录里，就走这条路，不只是 `/compact`。其中包括带任务参数的技能命令：Codex 把技能列为 `skill:<名>`（codex.ts:250），ACP 代理也会公告命令（acp.ts:627-629）。<br>**新绑定的首条输入如果是命令，此前的全部历史永不送达**（R2）。<br>持久化的 `Run.sourceRunIds` 仍记着这些未送达的来源，因为 1341 行的提交早于 1393 行的判断。 |
| 8 | 每个 PublicRun 已有 tools、plan、usage、notices、activities、outputs、attachments、thinking、timing；详情栏“改动”页展示差异 | 正确 | [S5] session.ts:92-126；[S17] DetailsPanel.tsx:17-18、91-140 | tools 还有 `name`、`parentId`；`detail` 指向内容存储里的 JSON（2.4.2）。“改动”页只读最近 40 个编辑类工具。【事实】焦点 Harness 实际给出差异或计划的程度差别很大（2.4.4）。 |
| 9 | 容量上限：MAX_RUNS 256、MAX_SESSION_BYTES 8 MiB、MAX_SESSION_EVENTS 16384、输入 64 KiB、输出 1 MiB | 正确 | [S4] state.ts:11-30 | 另有：日志 32 MiB；单条事件 2 MiB+4 KiB；MAX_QUEUE 8；MAX_COMMANDS 1024；MAX_RUN_TOOLS 128（超出后的工具不再记录，runtime.ts:1138）；notices 32、activities 64、plan 64、outputs 32；附件每条输入最多 8 个，合计 32 MiB。 |
| 10 | context-transfer、switching、invariants 只是 proposed，“它们从未实现” | **部分错误** | [S21]:3；[S22]:3；[S26]:3；[S3] runtime.ts:1335-1342；[S48] session-runtime.test.ts:605 | 三份文档确实是 proposed，但各条实现程度不同：<br>• INV-14 的“只补水位之后的事实”已由 ADR-020 实现并有测试，只是被斜杠命令路径破坏。<br>• INV-13 部分实现：Run 记录 sourceRunIds 与 contextThroughSeq，有 `run.context_prepared` 事件，但没有内容指纹和策略版本。<br>• INV-21 部分实现：切换失败保留原选择；SWITCH_NOT_EFFECTIVE；fork 被拒后退回公共历史。<br>• INV-22 目前没有派生摘要可言。<br>• switching.md 已实现 requested/validated/effective/failed、wait_current 和单一待决切换。<br>• 原计划的 V004、C006、G006、G024、G025、G046 仍是 planned [S58]。 |
| 11 | 原生通道线索：ACP 以 `mcpServers: []` 建会话（acp.ts:390），Claude 另带 `_meta`（claude.ts:20） | 正确 | [S10] acp.ts:389-390；[S12] claude.ts:20、57 | 另一条线索：Codex 回合参数 `collaborationMode.settings.developer_instructions` 目前恒为 null，只在选了协作模式时发送（codex.ts:515-516）。通道是否可行不在本报告范围。 |
| 12 | 真实接力证据只有一组 Codex→Gemini→Codex（本地确定性服务）；能力矩阵 27 项里没有“接力” | 正确，需补充 | [S45] README.md:5；[S56] harness-provider-switch.real.ts:116-138；[S44]；[S64] cli/web.ts:38；[S46] | 【事实】这组真实用例走的是受管 Provider（selection.provider），没有原生绑定，每轮全量重建。生产已关闭 Provider 管理（`providerManagement: false`），所以它覆盖的是**生产不再走的路径**。<br>另有 OpenClaw 切出再切回、Cursor→OpenClaw 的真实记录，但只验证了“回来后还记得自己早先说过的内容”（原生恢复），没有验证接手方理解对方做的事。<br>**焦点 Harness 上“原生绑定 + 增量”的 A→B→A 从未有真实证据。** 矩阵确为 27 行（Codex：14+1+3+5+1+2+1=27）。 |

### 2.2 构建、注入或跳过公共上下文的全部路径

“信封”指 context.ts:53-55 的英文说明加 JSON，作为用户消息发出。“推进”指 runtime.ts:1492-1497：派发后原生引用确认、清理干净时，绑定变为 ready，`throughRunId` 改为本轮。

| 路径 | 触发条件 | 实际交给 Harness 的内容 | 水位如何推进 | 潜在问题 |
|---|---|---|---|---|
| P1 新建对话 | `create()` | 什么都不派发 [S3] 259-280 | 没有绑定 | 事件写 `continuity: public_context_rehydrate`（275），实际什么也没交。 |
| P2 新对话首轮 | 第一次 send，没有绑定 | 信封，history 为空，加 currentInput（1334、1392） | 派发前先提交 unconfirmed 绑定（1382-1386），结算后推进 | 【事实】原生转录的第一条就是 JSON 信封，在原程序里续接时可见（ADR-039）。【推断】原程序按首条消息生成的会话标题、本机会话列表里的标题可能被污染（第 6 节）。 |
| P3 普通发送 | 同一 Harness，绑定 ready，此后没有新的已终结 Run | 原样用户输入加附件（1392） | 推进 | 【事实】每轮仍先按完整历史建一次信封做预算（1334），超限就失败（R3）。每轮多一次约 2 ms 的序列化（M2）。 |
| P4 同 Harness 换模型/选项 | 有效切换到同一 harnessId+controlId | 同 P3：同一绑定按 checkpoint 恢复，并带新模型（1371-1374） | 推进 | 新纪元按所选重新应用（ADR-028），没有任何交接内容。 |
| P5 切换后首轮（目标没有绑定） | 切换生效后的第一条 | 信封：全部已终结 Run（含取消、失败、unknown 的部分回复）、`branchedHistory`、currentInput | 新绑定首轮推进 | 只交正文；受预算限制；首条若是原生命令，此前全部历史丢失（R2）。普通切换只校验不连接（1574），目标绑定是否 unconfirmed 要到发送时才暴露。 |
| P6 换回原 Harness（绑定 ready） | 目标已有 ready 绑定 | 信封：throughRunId 之后（按下标）的全部已终结 Run、**整段 branchedHistory**、currentInput；没有增量时原样（1337-1340、1392） | 推进 | origin 重复送达（R4）；未派发的输入也混进来（R5）；绑定不是 ready 时 `NATIVE_STATE_UNCONFIRMED`（1336）。 |
| P7 原生斜杠命令 | 输入以 `/` 开头，且首个词出现在 `models().commands` 中 | 原样命令文本，不注入任何上下文；事件 `run.native_command{publicContextInjected:false}`（1393-1397） | **照常推进**（1496） | 缺陷 D1、D2；Run.sourceRunIds 与实际不符。目录里没有的 `/…` 文本会被包进信封，原程序不会把它当命令执行。 |
| P8 保留原生进程复用（ADR-030） | 开启保留；上一轮正常完成；选择相同；连接健康 | 同 P3/P6：上下文规则不变，只是不再 `open`（1345-1354） | 推进（复用时仍读 checkpoint，先置 unconfirmed，1377-1386） | 【事实】回合之间的原生事件只计数（594），后台改动不进公共事实。切换生效时先关闭保留进程（1565-1566），离开进程组的后台任务会继续运行，接手方不知道（ADR-030 补充）。 |
| P9 分支：原生 fork | 源当前选择的绑定恰好在分支点（437-438） | fork 前不派发；分支首轮原样输入（throughRunId 为 null，过滤后为空） | 首轮推进 | 【推断】首轮仍按完整历史做预算，其中含 ≤1 MiB 的引用历史，可能首条就 CONTEXT_TOO_LARGE（D13）。之后 A→B→A 的增量会重复带 branchedHistory。`forking` 结果未知时阻止原生使用。 |
| P10 分支：公共历史 | 从更早的 Run 分支；源没有 ready 绑定；或 fork 被拒（归档，1548） | 首轮信封：branchedHistory（role、text、outcome、附件，丢掉 harnessId）、空 history、currentInput | 首轮推进 | 引用历史的上限（1 MiB，单次转义，state.ts:252）与上下文预算（1 MiB，二次转义加 4 KiB）不一致。 |
| P11 接续本机会话（ADR-029） | `importNative()` | 首轮原样输入（绑定 ready，throughRunId 为 null，331-334） | 首轮推进 | 切到 B 时，B 收到最多 200 条、512 KiB 的引用，但**不被告知**还有省略、历史不完整或没读到（R4）。回到 A 时又重复带引用。【推断】代码类历史的引用一开始就占掉约 60% 的预算（2.5.1）。 |
| P12 显式重新建立原生会话 | 空闲时由用户操作，归档当前选择的绑定（401-416） | 下一轮按 P5 把全量信封交给新的原生会话 | 新绑定首轮推进 | 同 P5；先关闭保留的进程（414）。 |
| P13 恢复 blocked/unknown | 会话 blocked，清理已确认，用户确认保留未知结果 | 恢复切换只校验并“准备、初始化、open、close”一个新目标连接，不派发（1574-1583）。下一轮：目标绑定若 unconfirmed 则 NATIVE_STATE_UNCONFIRMED，需要重建；否则发全量信封，unknown 回合以 outcome=unknown 加部分回复引用 | 与普通发送一致 | 【事实】历史超限时，恢复切换永远 CONTEXT_TOO_LARGE，会话永久 blocked（R6）。恢复时被取消的排队输入，会以“已取消输入”出现在以后所有信封里。 |
| P14 取消/失败/unknown 回合作为来源 | 回合终结 | 以 outcome 加部分回复正文引用，**不带 error.code/message** | 已派发且确认的取消、失败回合照常推进；未派发的不推进；unknown 的绑定留在 unconfirmed | 接手方不知道失败原因。提前结束进程的回合会跳过工具详情写入（1452）。 |
| P15 附件 | send 带 ≤8 个附件 | 当前输入：派发前由 Driver 检查，复制成只读副本，ACP 用文本指针或资源块，Codex 用 localImage 或指针（1400-1414）。历史：只列 name、mediaType、kind、bytes（context.ts:11-14） | 随输入推进 | 接手方知道“有过一个附件”，但拿不到它。稳定副本 `files/<id>/<name>` 已经存在（content-store.ts:147-172），只是路径没交给目标。 |
| P16 排队中的输入 | 回合进行中 send | 不进入任何其他 Turn 的上下文：只取已终结、seq 更早的 Run（context.ts:16-35） | — | 一旦被取消，或因切换失败终结（SWITCH_NOT_EFFECTIVE），它就作为“已取消/失败输入”进入以后的信封（R5）。 |
| P17 切换与回合的竞态 | 回合进行中提出切换 | 切换等当前回合结束（wait_current）；请求前排队的输入先用旧选择执行（978-979）；applySwitch 重新计算来源（1569）；目标首轮在 execute 时再建上下文 | — | 切换记录的 sourceRunIds/throughSeq 只是信息，目标实际收到的以 execute 时为准，可能多出切换请求后又被取消的输入。切换失败之前，保留进程已经被关闭（1565-1566 早于 1570）。 |

### 2.3 水位与送达不一致（含斜杠命令缺陷）

#### 2.3.1 调用链（【事实】，runtime.ts）

`send()` 343-370 → `schedule()` → `serve()` 965-993 → `execute()` 1303：

1. 1332 提交 `preparing`；
2. 1334 `context = buildPublicContext(current, run)`：**完整历史**，超限在这里抛错；
3. 1335 `previousNative` = 该 Harness/control 的非归档绑定；1336 不是 ready 就抛 `NATIVE_STATE_UNCONFIRMED`；
4. 1337-1340 按下标过滤，只留 throughRunId 之后的 Run，重建 `context`；
5. 1341-1342 提交 `Run.sourceRunIds = context.sourceRunIds`、`contextThroughSeq = state.lastSeq`，事件 `run.context_prepared{continuity:"public_context_rehydrate"}`；
6. 1345-1375 复用保留进程，或 prepare→initialize→open(checkpoint)；
7. 1377-1386 读 checkpoint，绑定置为 `unconfirmed`（事件 `native.binding_prepared{resumed}`）；
8. 1392 `input = previousNative && sourceRunIds.length === 0 ? run.input : context.text`；
9. **1393-1397**：输入以 `/` 开头且 `control.models` 存在时，读命令目录；名字在目录里就 `input = run.input`，提交 `run.native_command{publicContextInjected:false}`；
10. 1415-1417 提交 `run.dispatched`，然后 `startText(native, input, …)`；
11. 1421-1438 后端结算，再读一次 checkpoint，`nativeConfirmed = true`；
12. **1492-1497**：清理干净或已交给对话保留时，绑定变为 ready，`throughRunId = execution.dispatched ? run.id : 旧值`。

下一轮：1338 的 `through` 是这次命令回合的下标，过滤后来源为空，走 1392 的原样输入。**中间另一个 Harness 的回合从此不会再出现在任何增量里。**

#### 2.3.2 最小复现（文字，可直接改写成 `tests/integration/session-runtime.test.ts` 用例：用 `ControlledFactory`，像 :130 那样覆写 `models()`，像 :605 那样覆写 `checkpoint()`）

1. 用 A（可恢复，命令目录含 `review`）新建对话，发“在 README 加一行 X”。A 收到信封，绑定 ready，throughRunId=run1。
2. 切换到 B，发“把 X 改成 Y”。B 收到含 run1 的信封，B 绑定 ready，throughRunId=run2。
3. 切回 A，发 `/review`。增量本应是 [run2]，但 1393 改成原样 `/review`；run3.sourceRunIds=[run2] 照样被持久化；结算后 A.throughRunId=run3。
4. 发“刚才 B 把 X 改成了什么？”。来源过滤后为空，A 收到原样问题。**A 永远不知道 run2。**

预期（INV-14）：A 在 run3 或 run4 之前收到 run2。现状违反 INV-14。

变体：第 2 步中 B 的**第一条**就是 `/review 登录重构`（或 Codex 的 `/skill:x 继续上面的方案`）。这时 A 的全部历史永不送达 B。

#### 2.3.3 合成复现结果（[S63]，正式 Runtime 加真实 SQLite，合成 Harness）

| ID | 场景 | 观察到 | 结论 |
|---|---|---|---|
| R1 | A→B→A，回来的第一条是 `/review` | prompts = `alpha:envelope()`、`bravo:envelope(A1…)`、`alpha:raw(/review)`、`alpha:raw(A3 what did bravo change?)`；`/review` 那轮的 sourceRunIds 长度为 1；alpha.throughRunId 等于最后一轮 | 【事实】D1 成立；第一条（新对话）也被包装（D7）。 |
| R2 | A→B，B 的第一条是命令 | `alpha:envelope()`、`bravo:raw(/review the login refactor)`、`bravo:raw(B2 continue the task)` | 【事实】D2 成立：A1 永不送达 B。 |
| R3 | A 的一次回复是 900 KiB 代码类文本 | run1 completed；run2（同一 Harness，绑定 ready）`failed/CONTEXT_TOO_LARGE`，未派发（只派发过 1 次）；切到 bravo `failed/CONTEXT_TOO_LARGE`；alpha 绑定仍 ready | 【事实】D3：预算检查对象错误，对话停摆。 |
| R4 | 接续本机会话（omitted=40，complete=false），A→B→A | 给 B 的信封含引用历史，但不含 omitted/complete，也不含 harnessId；回到 A 的增量信封（history=[B1]）**再次**含整段引用历史 | 【事实】D5、D6 成立。 |
| R5 | A 回合进行中排队一条再取消，然后继续用 A | `alpha:raw(A2 slow)` 之后，下一条变成 `alpha:envelope(A3 queued then cancelled)` | 【事实】D8：同一 Harness 因一条未派发的输入收到信封。 |
| R6 | 第二轮输出 900 KiB 后连接丢失（unknown，blocked），再 resume(bravo, acknowledgeUnknown) | 恢复切换 `failed/CONTEXT_TOO_LARGE`，会话仍 blocked | 【事实】D3 的恢复分支：超限会话**永远无法恢复**，只能关闭，或从更早的回合分支。 |

#### 2.3.4 同类的“水位与送达”不一致

| ID | 问题 | 类型 | 证据 |
|---|---|---|---|
| W1 | 新绑定的首条是命令，全部历史被吞掉 | 事实 | R2 |
| W2 | 已派发就当作已送达：被拒或早期失败的回合也推进水位。ACP 的 `session/prompt` REMOTE_ERROR 记为 `failed/request_rejected`；推进条件（1492-1496）不看 backend.status | 代码事实；是否真的丢失属**推断**，取决于原程序有没有先把输入写进转录 | [S10] acp.ts:557-560；[S3] 1492-1497 |
| W3 | 持久化的来源与实际派发不一致：1341 早于 1393 的命令判断；`contextThroughSeq = state.lastSeq`（context.ts:50、59），包含了之后才排队的消息 seq，是一个过宽的上界 | 事实 | [S2][S3] |
| W4 | origin（fork/import 的引用历史）在每个增量里重复送达 | 事实 | R4；context.ts:48 无条件带上 |
| W5 | import 的省略、不完整、没读到不告诉接手方 | 事实 | R4 |
| W6 | 未派发就终结的输入进入同一 Harness 的增量 | 事实 | R5；1337-1340 只按下标过滤 |
| W7 | 回合之间的后台活动、在原程序里继续的回合都不进入公共事实，接手方缺这一块 | 事实 | [S38] ADR-030:39；[S42] ADR-039:39-41；runtime.ts:594 |
| W8 | 清空上下文类的原生命令（如果被公告）会让水位反向失真：原生会话已清空，绑定却显示已同步 | 推断 | Claude 内置命令表含 `clear` [S65] capability-reads.ts:239；是否经 ACP 公告、能否派发未核实 |
| W9 | `switch.effective` 的 continuity 恒为 rehydrate，`throughSeq = lastSeq` | 事实 | [S3] 1604-1606 |

### 2.4 交接可用的公共事实

#### 2.4.1 PublicRun 字段（[S5] session.ts:57-126；上限 [S4] state.ts:131-189、[S6] control.ts:65-74、[S7] content.ts:8-13）

| 字段 | 内容与上限 | 存放位置 | 现在进入交接吗 | 接力价值 |
|---|---|---|---|---|
| id、commandId、userMessageId、assistantMessageId | 品牌 ID | 快照 | runId、messageId 进入 | 来源追溯 |
| input / 用户消息 | ≤64 KiB | 快照 | 是 | 需求与目标 |
| 助手消息 text | ≤1 MiB | 快照 messages[] | 是 | 进展与结论 |
| selection | harnessId、controlId、nativeModel?、nativeOptions?、provider? | 快照 | **否** | 谁做的、用的什么模型 |
| epoch | ≥1 | 快照 | 否 | 段落边界 |
| status、cancelRequested、stopRequested | 8 种状态 | 快照 | 只有 outcome | 结果 |
| backend | {status, reason ≤4 KiB, error?} | 快照 | 否 | 停止原因 |
| cleanup | {closed, exitCode, signal, protocolFailure} | 快照 | 否 | 资源证据 |
| error | {code ≤128 B, message ≤4 KiB} | 快照 | **否** | 失败与教训 |
| contextThroughSeq、sourceRunIds | ≤256 个 | 快照 | 只作元数据 | 交接水位（目前不精确） |
| thinking | ≤1 MiB | 快照 | 否 | 推理过程（跨厂商不宜直接交） |
| tools[] | ≤128 个；id ≤512 B、title ≤4 KiB、status ≤128 B、kind ≤64、name ≤256、parentId ≤512、exitCode、detail（ContentRef） | 摘要在快照，详情在内容存储 | **否** | 改了哪些文件、跑了哪些命令、哪些失败 |
| plan | entries ≤64 × 4 KiB（status、priority），explanation ≤4 KiB | 快照 | 否 | 待办（焦点 Harness 基本拿不到，见 2.4.4） |
| usage | turn{input, output, cachedInput, cacheWrite, reasoning, total}、context{used, size}、cost{amount, currency, scope} | 快照 | 否 | 预算估算与费用 |
| notices | ≤32 ×（title 1 KiB + detail 4 KiB） | 快照 | 否 | 警告 |
| activities | ≤64；kind ∈ subagent/task/compaction/retry/review；title 1 KiB、detail 4 KiB | 快照 | 否 | 子 Agent、压缩、评审 |
| outputs | ≤32；ContentRef，或 link（uri ≤4 KiB、name、title、mediaType） | 快照引用 + 内容存储 | 否 | 产物 |
| attachments | ≤8 个，合计 ≤32 MiB，单个 ≤20 MiB | 快照引用 + 内容存储 | 只有名称、类型、大小 | 输入材料 |
| timing | acceptedAt、preparingAt、readyAt、dispatchedAt、firstOutputAt、endedAt（v10） | 快照 | 否 | 性能基线 |
| retained、reused、awaitingSwitchId | v11 / 切换关联 | 快照 | 否 | — |

#### 2.4.2 ContentRef 与内容存储

- **格式**【事实】：
  - 字节存在 `content/blobs/<sha256>`（0600，按内容寻址）；
  - 记录在 `content/content.sqlite`，字段为 id、sha256、name、media_type、kind、bytes、origin（upload/output）、workspace、fingerprint、created_at、discarded [S8] 75；
  - `ContentRef = {id, name, mediaType, kind, bytes, sha256}` [S7] 57-64。
- **工具详情**【事实】：
  - 文件名 `tool-<安全名>.json`，类型 application/json；
  - 正文 `{toolId, kind?, name?, input?, output?, diff?, locations?, exitCode?, parentId?, truncated?}` [S3] runtime.ts:1266；
  - 写入时机：工具进入终态时（1149），或回合结算后、关闭前补写（1297-1301）；**提前结束进程的回合会跳过补写**（1452-1454）；
  - 事件里只记 `run.tool_detail` 的引用（1270）。
- **读取接口**【事实】：
  - 应用层端口 `ContentPort` 只有 storeOutput、resolve、materialize，**没有读** [S7] 97-101；
  - 基础设施的 `LocalContentStore.read(id)` 返回 blob 路径 [S8] 185-190；
  - 网页经 `GET /api/v1/content/:id` 按需读取（ADR-022 决定 6）；
  - “改动”页只读最近 40 个编辑类工具 [S17] 99-100。
- **成本（合成测量 M5）**：每条约 19 KB 时，写入约 8.2 ms，主要是 fsync、每次新开连接、synchronous=FULL；读取约 0.10 ms。读 1,000 条详情约 0.1 s，可以接受；**写入不应进入交接的热路径**。
- **回收**【事实】：
  - 启动时删除超过 7 天、且不被任何 Session 快照引用的记录与 blob；
  - 引用集合只来自 runs 的 tools.detail、outputs、attachments，以及 origin 的附件 [S9] 326-341、[S8] 191-219；
  - **新实体（交接单、账本）引用的内容，如果不并入这个集合，会被回收**；
  - 总量上限 4 GiB、262,144 条，超出后新详情不再保存，回合不受影响 [S8] 11-15。

#### 2.4.3 工具 detail 里实际有什么

【事实】上限 [S6] control.ts:49-67，裁剪方式 [S3] runtime.ts:82-92：

- input：保留头部 16 KiB；
- output：保留**尾部** 64 KiB；
- diff：统一差异文本，保留头部 64 KiB；
- locations：≤16 条，每条 1 KiB；
- 另有 kind、name、exitCode、parentId，以及 truncated 标记。

驱动的原始来源：

- Codex：commandExecution 的 aggregatedOutput 与 exitCode，fileChange.changes[].diff，mcpToolCall，turn/diff/updated；
- ACP：rawInput、rawOutput、diff、locations；Claude 另带 `_meta.claudeCode.toolResponse`；
- OpenClaw：回合结束后从原生转录补记。

出处：[S44] 矩阵 66、100、134、168 行，[S33] ADR-022:9-12。

#### 2.4.4 activities、plan、outputs、usage 的来源，与焦点 Harness 的实际可得性

来源【事实】：驱动只映射原协议实际给出的字段（ADR-022 决定 1）。

- ACP：`plan`、`usage_update`、notices（session.notices）、compaction（session.compaction）、图片与 resource_link 输出；
- Codex：turn/plan/updated、thread/tokenUsage/updated、contextCompaction、协作 Agent、评审、生成图片的 savedPath；
- OpenClaw：转录对账（ADR-027）。

各焦点 Harness 的实际情况（摘自 [S44] 能力矩阵）：

| Harness | 工具输入/输出/差异 | 计划 | 用量/上下文窗口 | 原生恢复 | 原生分支 | 压缩 |
|---|---|---|---|---|---|---|
| Codex | ✅ | ✕ 受阻：默认模型不提供 update_plan | ✅ 有 modelContextWindow，无费用 | ✅ | ✅ | ✅ |
| Claude Code | ✅ | ✕ 受阻：会话里没有 TodoWrite | ✅ 窗口 1,000,000，有费用 | ✅ | ✅ | ✅ |
| OpenCode | ✅ | —（todowrite 只是一个工具） | ✅ | ✅ | ✅ | ✅ |
| OpenClaw | ◑ 回合后从转录补记 | — | ☑ 只有近似的 used/size | ✅ | — | ✅ |
| Hermes | ◐ patch 不发 diff | ○ todo 只是文本 | ✅ | ✅ | ✅ | ◐ |
| dsh | ☑ kind 恒为 other，没有差异和位置 | — | ☑ 只有上下文占用与窗口 | ✅ | — | ○ |

结论：

- 【事实】六个焦点 Harness 在真实使用中基本**拿不到原生 plan**。
- 【事实】dsh、Hermes、OpenClaw 的差异不完整；单轮超过 128 个工具时，之后的工具不再记录。
- 【建议】因此“改了哪些文件”不能只靠工具事实，需要工作区级的差异或指纹。
- 【事实】`usage.context.size` 多数焦点 Harness 都会报告，但只有该 Harness 跑过一轮之后才有；模型目录里没有窗口字段（[S6] control.ts:153-164）。

### 2.5 容量与性能

#### 2.5.1 上限在长对话中何时触发

| 上限 | 检查点 | 长对话里的情形 | 类型 |
|---|---|---|---|
| MAX_CONTEXT_BYTES 1 MiB（二次转义后加 4 KiB） | 每轮开始（1334）、每次切换校验（1570） | 正文约 0.74 MB（代码）到 1.01 MB（散文）就触发（M1）。单条回复最多 1 MiB，**一次长回复就能越线**（R3）。按平均每轮 3.5 KB 估算：代码类约 210 轮；散文约 290 轮，会先被 MAX_RUNS 拦住 | 测量 + 推算 |
| 接续的引用历史（200 条 / 512 KiB，单次转义，runtime.ts:121） | 接续时 | 代码类：512 KiB（单次转义，比例约 1.17）约等于 447 KB 正文，二次转义后约 626 KB，开局就占了约 60% 的预算，剩约 0.3 MB 正文，约 85 轮 | 推算（M1 的转义比例） |
| 分支引用历史 ≤1 MiB（单次转义，state.ts:252） | 分支时 | 与上下文预算的口径不一致，可能建出首条输入就失败的分支（D13） | 推断 |
| MAX_RUNS 256 | send 准入（356） | 第 257 条输入报 RUN_LIMIT | 事实 |
| MAX_SESSION_BYTES 8 MiB | 每次提交（state.ts:381） | thinking（每轮 ≤1 MiB）和工具摘要都计入快照，工具多或思考长的会话可能早于 256 轮触发 | 推断 |
| MAX_SESSION_EVENTS 16384 | 每次提交（state.ts:335） | 每轮固定约 12 条事件，每个工具再 2–4 条，流式时每 100 ms 一个窗口。工具密集的会话约 150–200 轮可能触顶。回合结尾的提交如果被拒，会进入 `fail()`，使**整个 Runtime fatal**（1478-1507） | 推断（未复现） |
| MAX_EVENT_LOG_BYTES 32 MiB | 每次插入事件（sqlite-store.ts:607-610） | 文本窗口事件含正文，流式总量接近 32 MiB 时触发 | 推断 |
| MAX_RUN_TOOLS 128 | 每个工具事件（1138） | 之后的工具不记录，改动可能遗漏 | 事实 |
| MAX_COMMANDS 1024 | 每个命令 | 每次切换占 1 条命令 | 事实 |

#### 2.5.2 `buildPublicContext` 的复杂度与实测（M2）

- 【事实】复杂度：
  - 选源要对每个 Run 做一次 `messages.some`，是 O(R·M)；
  - 每个来源再做两次 `messages.find`，是 O(S·M)；
  - 序列化要 `JSON.stringify(body)`，再两次 UTF-8 编码，再一次转义用的 `JSON.stringify`，整体 O(B)；峰值内存约为 B 的数倍。
- 【事实】调用次数：每轮 1–2 次（1334 全量，1339 增量），每次切换 1 次（1570）。
- 实测（Node 26，中位数）：
  - 857 KB 信封，1.84 ms；
  - 470 KB，1.44 ms；
  - 只含 1 个 Run 的增量，0.028 ms。
- 结论【推断】：构建本身不是瓶颈；问题在于它被当成了闸门，而且检查的对象不对。

#### 2.5.3 快照与事件的写放大（M3、M4，以及 ADR-047 的测量）

- **每次提交都要做这些事**【事实】：
  1. `runtime.load`：完整 `JSON.parse` 加 `parseSession`；
  2. `transact` 里的 `readSession`：再读一次、再解析一次，并对本会话事件做 COUNT；
  3. `parseSession(next)`：其中还要把整份快照 `JSON.stringify` 一次来计字节；
  4. `assertSessionTransition`：对每个 Run、每条命令做 JSON.stringify 比较；
  5. `JSON.stringify` 整份快照写回；
  6. 插入事件前，用 `SUM(length(event_json))` 扫描本会话的全部事件。

  出处：[S9] 144-158、343-363、599-611；[S3] 791-797。`output()` 处理每个原生事件前还有一次 `owned()`，又要再 load 一次（995-1003）。
- **实测**（`JSON.parse` 加 `parseSession`）：
  - 67 KB，0.27 ms；
  - 0.75 MB，3.1 ms；
  - 3.1 MB（每轮 30 个工具摘要），16.8 ms；
  - 6.3 MB，23 ms。

  ADR-047 对整次提交测过：1 MB 时 7.8 ms，4.2 MB 时 44.8 ms [S40]:7。两者量级一致。
- **二次方项**【事实 + 测量】：
  - 每次切换都保存全部已终结 Run 的 ID（runtime.ts:390、1572）。50 次切换后，解析从 3.1 ms 升到 18.4 ms；200 次时 53 ms。
  - 如果每轮都记录全量来源（受管 Provider 的全量重建，或者未来“每轮都做交接”的设计），256 轮时解析需要 158 ms，没有来源时只要 4.3 ms。
  - 原因是 state.ts:359-361、370-373 的嵌套 `some`。
- **流式**【推断】：ADR-047 把文本事件数降了一个量级，但每个窗口仍是一次整份快照事务。以 3 MB 快照、每秒 10 个窗口计，一个对话就占掉约 0.4–0.5 s/s 的主线程。
- 结论【建议】：交接单和账本不能放进 Session 快照；切换和 Run 的来源改存区间水位或交接单 ID；交接构建不能增加每个窗口的提交次数。

### 2.6 契约、不变量与 ADR 对接力的约定

| 文档（状态） | 对接力的约定 | 实现情况 | 矛盾或偏差 |
|---|---|---|---|
| context-transfer.md（proposed）[S21] | 不可变 ContextManifest，包含：目标与约束、已完成与待办、批准的决定、工作区快照、产物 hash、来源指纹、策略版本、预算估计（7）；把文件和工具输出当不可信数据（9）；超限报 CONTEXT_TOO_LARGE，不静默只取最近 N 条，摘要另建派生记录（13）；字节与 token 估计分开记（15）；固定 throughSeq 与工作区指纹，返回 A 时只复用已同步到该水位的绑定（19-21）；三级接续等级，等级与缺失材料对用户可见（25-27） | 只有“来源 + 水位 + 超限失败”。没有 manifest、内容指纹、策略版本、token 估计、工作区指纹，也不显示等级 | import 只引用最近 200 条，又不告诉接手方，对接手方来说违反了第 13 行 |
| switching.md（proposed）[S22] | 状态机 requested→validated→waiting_boundary/quiescing→preparing_context→preparing_binding→effective，另有 blocked、failed、superseded、cancelled（13）；wait_current 与 cancel_current（16）；固定水位，构建 manifest，准备目标绑定（18）；单一待决切换（21）；竞态清单（31） | 已实现 requested、validated、effective、failed，以及 wait_current 和 SWITCH_PENDING | 第 18 行“准备目标绑定”与 ADR-019（accepted：普通切换不建连接）冲突，现以 ADR-019 为准 |
| storage-events.md（proposed）[S23] | 存储对象应包含 context manifests（25）；大正文放进受控对象存储（27）；流式窗口（21） | 没有 manifest 表；内容存储已有 | — |
| public-session-mvp.md（accepted）[S24] | fresh context 含全部已终结 Turn 加本轮（11）；完整历史超预算时启动前拒绝（11）；原生命令直接派发，不注入公共文本包（25，ADR-019）；ready 保存最后已同步的原生 Run，只补水位之后（27，ADR-020）；branchedHistory（31）；附件只列名称（33） | 已实现 | **第 25 行和第 27 行组合起来就是 D1**；第 11、17 行“每轮新会话、rehydrate”的描述已被 ADR-020 部分取代 |
| lifecycle.md（proposed）[S25] | 原生恢复要求 checkpoint 指纹与 manifest 水位匹配；显式 rehydrate 必须显示降级后的接续等级（54）；执行预算覆盖上下文准备（33） | 预算已按 ADR-036 实现（armBudget 在 1323）；等级不显示 | 第 54 行没有落实 |
| invariants.md（proposed）[S26] | INV-13（19）、INV-14（20）、INV-21（27）、INV-22（28） | 见 2.1 第 10 行 | INV-14 被 D1、D2 破坏 |
| context-map.md、language.md [S27] | Continuity 是独立的限界上下文，发布 ContextManifest（context-map:11、20；language:17） | 代码里只有 `session/domain/context.ts`，没有 continuity 上下文；G025 计划交付的 `src/contexts/continuity/domain/verify-handoff.ts` 不存在 [S58] | — |
| adapter-spi.md [S28] | `openOrRestore` 接收公共来源引用、checkpoint 或 ContextManifest，返回接续等级（10） | `HarnessControl.open` 只接收 checkpoint，只返回会话 ID [S6] 181 | — |
| ADR-010（accepted）[S29] | 每轮新连接、新原生会话，完整有界历史，明确为 rehydrate（5）；切换只用已终结 Turn（9） | 被 ADR-020 部分取代 | — |
| ADR-015、ADR-019 [S30][S31] | 切换不取消活动 Run，不转移工具；普通选择不建连接；保留原生命令 | 已实现 | 命令语义与水位没有协调 |
| ADR-020 [S32] | 私有绑定加水位，只同步后续公共事实（9）；派发前先置 unconfirmed（11）；要求切回、增量上下文、恢复失败不 fallback 的真实证据（21） | 增量已实现，有合成测试 | **焦点 Harness 上没有真实的增量证据** |
| ADR-022 [S33] | 工具详情、计划、用量、提示、活动、产物都是 Run 事实，详情进内容存储 | 已实现 | 交接没用到 |
| ADR-024 [S34] | Codex/Pi 以命令名提供 `/compact`、`/export` | 已实现 | 这些命令回合同样推进水位 |
| ADR-025 [S35] | 只在精确位置做原生 fork；branchedHistory | 已实现 | 增量里重复带 origin |
| ADR-028 [S36] | 同一纪元沿用原生改过的值 | 已实现 | — |
| ADR-029 [S37] | 引用 200 条、512 KiB；下一条原样发出 | 已实现 | omitted 不进入交接 |
| ADR-030 [S38] | 保留进程；切换前关闭；回合之间的事件只计数 | 已实现 | 后台改动不进入交接 |
| ADR-036 [S39] | 执行预算和等待预算 | 已实现 | — |
| ADR-047 [S40] | 流式窗口；整份快照事务的 O(会话大小) 成本留到 M2 | 已实现 | 交接设计不得加重这部分成本 |
| ADR-049 [S41] | 升版本前备份，保留两份 | 已实现 | v13 必须走这条路径 |

### 2.7 现有测试（重设计必须保留或改写）

| 测试 | 覆盖内容 | 重设计时的处置 |
|---|---|---|
| unit/session-context.test.ts:22-93（8 个）[S47] | 来源选择、排除排队输入、拒绝未来输入、归属校验、Unicode 与引号、缺失或重复来源、预算二分（含 40 万个 `"`） | 保留选源与归属用例。改写：预算用例（从“整轮失败”改为“分层/派生，并声明省略”），以及依赖信封格式的断言（`/do not execute prior user inputs again/`、`"currentInput":null`） |
| unit/session-state.test.ts:77、81、91、159、173、195 [S54] | 来源不得来自未来输入、来源不超过水位、切换证据、v8 origin、v9 observed、v9 import | 保留；如果切换和 Run 改存区间水位，91、77、81 要改写，并补 v13 的拒绝样例 |
| integration/session-runtime.test.ts:605 [S48] | A→B→A 只送未见过的公共事实、跨 owner 重启、显式重建 | **必须保留并扩展**：回来的第一条是原生命令；回来前有已取消的输入；origin 不重复 |
| 同文件 :156 | 真实 IPC 下的 A→B→A（没有绑定，全量） | 保留，作为全量路径的回归 |
| 同文件 :130、:224、:242、:273、:364、:390、:438 | 命令目录读取期间取消、切换等待并冻结来源、排队顺序、失败不派发、关闭时的待决切换 | 保留 |
| 同文件 :560、:579、:591、:641 | 恢复不重跑；未知的原生状态不能静默恢复，需显式重建 | 保留；新增“超限会话可以恢复” |
| 同文件 :752、:791、:864 | 附件派发前检查；分支（原生 fork、公共历史、被拒后归档，断言了 `branchedHistory` 字段）；接续（引用 200 条、省略计数、下一条原样） | 保留语义，随格式改写断言；新增“切到 B 时声明省略” |
| integration/native-experience.test.ts:44-68 [S49] | 原生命令原样派发，`publicContextInjected:false` | 保留“原样派发”；新增“水位不推进，增量稍后送达” |
| integration/kept-process.test.ts:69-90、115 [S50] | 复用后绑定 ready、throughRunId 为第二轮；切换等操作先关闭保留进程 | 保留 |
| integration/web-server.test.ts:146、391-406 [S51] | 失败的切换不在旧 Harness 上派发；HTTP 分支首条带引用历史（会解析信封） | 保留；改写信封解析 |
| integration/session-cli.test.ts:171-197、303 [S52] | CLI 的 A→B→A 与重开；输出文本含 `public_context_rehydrate` | 保留；改写等级文字 |
| integration/session-store.test.ts:607、628 [S53] | v10/v11→v12 迁移；原生会话持有者 | 扩展到 v12→v13 |
| browser/web.browser.ts:97-256、696-725、812-816 [S55] | 切换界面、重试切换用同一命令键；分支（夹具回复“原生分支线程，公共历史 0 轮，分支历史 0 条”）；接续来源 | 保留；新增接续等级和交接单可见性的用例 |
| real/*.real.ts [S56] | codex-session（从模型请求里找信封，history 长度等于轮次）；harness-provider-switch（Codex→Gemini→Codex，受管 Provider）；native-resume（恢复后 sourceRunIds 为空）；native-branch；native-import；native-commands（压缩后仍记得） | 信封格式一变，codex-session 和 switch 两个用例就要改写。Gemini 已冻结，切换真实用例要换成焦点 Harness、走原生绑定的 A→B→A |
| fixtures：session-peer.mjs:58-62、web-harness-peer.mjs:28-31、43、90 [S57] | 夹具按 `HarnessGateway public conversation context.` 前缀解析信封，并在回复里报告历史条数 | **必须改写**：任何格式变化都会让大量集成测试和浏览器测试失效 |
| 缺口 | 没有测试覆盖 D1/D2、D3（同 Harness 超限、恢复超限）、D5、D6、D8、W2。测试矩阵的 G056-C01、C006-C03 仍是 planned [S58] | 新增 |

### 2.8 界面：切换与接续如何展示给用户

【事实】已展示的：

- **切换中**：选择即提交切换。运行中显示“当前回复结束后自动切换”或“正在保存选择”，状态写“等待选择切换生效”（[S16] Composer.tsx:238；[S15] Turn.tsx:32、ChatPage.tsx:263）。
- **切换失败**：通知“未能切换到 X”，附原因和“继续使用当前选择”；输入框提供“重试切换”（ChatPage.tsx:311-313；Composer.tsx:238）。
- **切换生效后**：分隔线“从这里起由 X 接手 · 模型”，最近一次还有“改回”（Turn.tsx:169-178；ChatPage.tsx:241-262，按 `switch.throughSeq` 放置）。
- **原生会话**：
  - 高级配置里显示“原生会话 · 继续已有会话/状态待确认”，提供“重新建立原生会话”和“在原程序中继续的方式…”，并说明“公共历史与旧原生记录保留；原生内部状态重新建立。”（[S16] 284-288）；
  - 详情栏只对**最新一轮、当前选择**显示原生状态（[S17] 216-219）。
- **分支/接续来源卡片**：来源、条数、原生副本状态、可展开的引用历史；接续时注明“更早的历史只保留在原程序中”（[S18] BranchOrigin.tsx:10-45）。
- **“改动”页**：整段对话按文件聚合的差异，取最近 40 个编辑工具（[S17] 91-140）。

【事实】没有展示的：

- 接续等级（native_resume、rehydrate、blocked）；
- 每一轮交给了接手方什么：`Run.sourceRunIds` 已在前端解码（[S19] api.ts:387-388），但没有组件使用；
- 信封正文；
- 原生命令跳过上下文的事件；
- 交接预算与剩余空间；
- `CONTEXT_TOO_LARGE` 没有中文说明：错误映射（api.ts:840-896）里没有这个码，界面回退为英文 message。

结论：“谁在接手”看得见，“交接了什么、接续到什么程度”看不见。这与 context-transfer.md:27、lifecycle.md:54 不符。

### 2.9 用户已确认方向的旧文档（只读，2026-10-08，针对旧代码库）

| 期望 | 出处 | 现状 |
|---|---|---|
| 公共工作记录分四类：对话与目标；进展与决定（已完成、待办、已确认的选择与约束）；工作成果（工作区、已修改文件、登记的产物及完整性）；执行记录（每段的 Agent、模型、工具、权限、费用、结果归属） | [S61] chat-flow.html:158；[S60] user-journeys.md:40 | 只交接对话正文与 outcome |
| 新执行者要知道“已经做了什么、接下来做什么”；不能只复制最后一句回复；要明确选材、版本与大小边界 | [S61] 189、218 | 没有版本，也没有“接下来做什么” |
| 输出是“可交接的上下文，以及它的来源与版本” | [S61] 218 | 有来源 ID，没有版本和指纹 |
| 首次执行、多轮继续、换 Agent 时，都能说明交给了它什么；超限或不支持时明确失败 | [S59] chat-first README:40 | 说明不了（界面看不见）；超限会失败，但失败面过大 |
| 跨 Agent 的待办与文件变化不丢失；旧摘要不覆盖新事实；超限不静默截断；上下文准备失败时不发起带副作用的执行 | [S59] 99 | 文件变化与待办不交接；没有摘要；“不静默截断”除 import 外都守住了；准备失败在启动原程序之前就结束，守住了 |
| 验收场景：A→B→A、同 Agent 换模型、同时切换、执行中请求、交接失败、资源未清理、重启、其他执行者已改动文件 | [S59] 139 | 前几项有合成测试；“其他执行者已改动文件”没有工作区事实可依 |
| 回到 A 时能理解其他执行者已完成的工作 | [S59] 150-163；[S58] phase-1.md:33 | 只靠增量正文，而且会被命令回合破坏；没有改动事实 |
| 公共上下文接续不等于原生无损迁移；不能假定另一个 Agent 的内部状态可读 | [S60] 43；[S59] 97 | 守住了：信封声明“No native internal state or tool identities are transferred” |

---

## 3. 模式归纳

1. **只有一个水位，却承担三种含义。** `throughRunId` 的真实语义是“已派发并确认引用”，却同时被当作“已送达”“已同步”“可复用”的证据。命令回合（D1、D2）、被拒回合（W2）、清空类命令（W8）都在这里失真。【事实/推断】
2. **一个字节预算承担三种职责，还查错了对象。** 它同时代表送达大小、模型窗口、会话能否继续，检查时却针对完整历史，而不是将要送达的内容（D3、D13）。窗口估计（token）完全没有。【事实】
3. **事实丰富，交接贫乏。** v7 起已持久化工具、差异、错误、执行者、用量和产物，交接只用了文本（D4）。反过来，焦点 Harness 几乎不给原生 plan，部分不给差异，所以“改动与待办”需要另找事实来源（2.4.4）。【事实】
4. **接续等级是文档里的概念，不是数据。** 没有字段，事件里写死成 rehydrate，界面不显示（D10）。【事实】
5. **交接通道就是用户消息。** 首轮也被包装，说明文字以“用户”的身份出现，原生转录被污染（D7），与“像原生”冲突。跨厂商的提示注入面也在这里。【事实/推断】
6. **增量按“Run 下标之后”计算，而不是按“目标还没见过的内容”计算**，结果是未派发的输入混入、origin 重复（D5、D8）。【事实】
7. **快照就是一切。** 每次提交都整份读写，ID 列表随切换线性增长，解析成本随之二次方增长（D12）。新实体如果也放进快照，会进一步放大。【事实 + 测量】
8. **文档漂移。** proposed 的契约（manifest、等级、状态机）与 accepted 的 ADR（019、020、025、029）各自演进，没有一份描述“现行接力”的 as-built 契约。组合缺陷恰好落在两条 accepted 规则的交界处（ADR-019 × ADR-020）。【事实】
9. **地基可靠。** 身份与执行权、不可变历史、未知不重跑、不 fallback 到空会话、单一持有者、切换边界都执行得很严，有校验也有测试。接力可以在这些规则之上安全地叠加。【事实】

---

## 4. 对 HarnessHub 接力的启示（三张表）

处置标签：**采用**（原样保留），**改造后采用**（保留目的，改变机制），**拒绝**。“修复方向”一律是【建议】。

### 4.1 重设计必须保留的不变量与行为

| # | 不变量或行为 | 现有落点 | 处置 | 对接力的含义 |
|---|---|---|---|---|
| K1 | 公共 Session 是唯一权威；历史只追加；终态的 Run、消息、切换证据不可改写 | [S4] state.ts:410-464；[S9] 343-363 | 采用 | 交接单和账本只能是派生记录，独立存放，不写回 Run 或消息 |
| K2 | 先提交再发布；SSE 只发布已提交的事实 | [S3] 791-803；[S23]:21 | 采用 | 交接单先落库（ID、指纹）再派发 |
| K3 | 未知结果不重跑；派发后结果未知即 blocked；unconfirmed 或 forking 的绑定阻止原生复用 | [S3] 1336、1481-1504；[S4] 466-479 | 采用 | 水位只在确认后推进；交接失败不能伪装成成功 |
| K4 | 原生恢复失败不 fallback 到空原生会话 | [S3] 1380 | 采用 | 等级为 blocked 时，由用户显式选择重建 |
| K5 | 一个原生会话只有一个持有者 | [S3] 309-319；[S9] 312-324 | 采用 | — |
| K6 | 切换在回合边界生效（wait_current）；请求前排队的输入用旧选择执行；请求后的输入等待切换，切换失败就不派发 | [S3] 379-395、965-993、1303-1314；[S24]:13 | 采用 | 交接构建的时机是：旧回合结算之后、目标首轮派发之前 |
| K7 | 只有已终结、且用户消息 seq 早于当前输入的 Run 才能做来源；排队输入不进入其他 Turn | [S2] 16-35；[S4] 359-361 | 采用 | 交接单的来源集合继续按这条规则取 |
| K8 | 上下文准备失败在启动原程序之前结束，不产生副作用 | [S3] 1334 早于 1356；[S21]:15 | 采用 | 交接构建失败不能让回合进入派发 |
| K9 | 派发前提交 unconfirmed，结算与清理确认后才变 ready | [S3] 1382-1386、1492；ADR-020:11 | 改造后采用 | 保留“确认后才推进”，但把“已派发”和“已送达”分成两个水位 |
| K10 | 引用的历史不重新执行（“只继续 currentInput”）；声明不迁移原生内部状态 | [S2] 53-55 | 改造后采用 | 语义保留；不再把说明和历史塞进用户消息正文（通道由他组定） |
| K11 | 超限不静默截断 | [S21]:13；[S2] 56-58 | 改造后采用 | 保留“不静默”，把“整轮失败”改为分层预算，并附一份显式的“未包含的内容与水位”清单 |
| K12 | 附件的字节只交给受理它的 Turn；历史只列名称、类型、大小 | [S2] 11-14；ADR-023 | 改造后采用 | 交接单可以列出附件，必要时给出稳定只读副本（已存在），是否给另行决定 |
| K13 | 原生命令原样派发，不注入公共文本包 | [S3] 1393-1397；ADR-019 | 改造后采用 | 保留原样派发；**命令回合不推进“已送达”水位**，增量另行送达 |
| K14 | 同一纪元沿用原生命令改过的设置；显式切换后重新应用 | [S4] 389-399；ADR-028 | 采用 | 同 Harness 换模型时，交接逻辑不能覆盖它 |
| K15 | 切换生效、分支、重建、关闭前先关闭保留进程（工作区只有一个写入者） | [S3] 1565-1566、448、414；ADR-030 | 采用 | B 接手前 A 的进程已关闭；离开进程组的后代要作为“外部改动风险”列入交接 |
| K16 | 只在原生会话恰好位于分支点时做原生 fork | [S3] 437-438；ADR-025 | 采用 | — |
| K17 | 接续本机会话：引用历史只读，下一条原样进入原生会话 | [S3] 331-334；ADR-029 | 采用 | — |
| K18 | 普通切换不启动原生进程，只做校验 | [S3] 1574；ADR-019 | 采用 | 切换本身近乎零时延，交接成本集中在目标首轮 |
| K19 | 恢复的证据关系：open 会话中的 unknown Run，必须是某次 effective 切换的来源 | [S4] 340-342 | 改造后采用 | 如果切换来源改为水位区间，要另存“已确认的未知 Run”，以保持这条校验 |
| K20 | 内容字节不进快照和事件，只存 ContentRef；回收只保留快照引用的内容 | [S7] 56-64；[S9] 326-341 | 改造后采用 | 新实体引用的内容必须并入 `contentReferences()` |
| K21 | 编号迁移只进不退；升版本前自动备份 | [S9] 393-590；ADR-049 | 采用 | v13 要有迁移、拒绝样例和备份测试 |
| K22 | Runtime 不按产品名分支；第三方协议类型留在 Driver | ADR-020:13；AGENTS.md | 采用 | 各 Harness 注入通道的差异，通过 Driver 能力声明来表达 |

### 4.2 必须修复的缺陷

| # | 缺陷 | 证据 | 后果 | 修复方向（建议） | 级别 |
|---|---|---|---|---|---|
| D1 | 原生命令回合不注入增量，却照常推进水位 | [S3] 1392-1397、1496；R1 | B 的工作永远补不到 A；违反 INV-14 | 命令回合保持“已送达”水位不动；增量在下一次普通输入前补交，或走独立的前置送达；派发记录与送达记录分开 | P0 |
| D2 | 新绑定的首条输入是原生命令时，此前全部历史永不送达 | 同上；R2 | B（或重建后的 A）永远缺历史 | 同 D1：新绑定的“已送达”水位，只能由一次真正带了历史的送达来确立 | P0 |
| D3 | 预算闸门检查完整历史：同 Harness 绑定就绪、切换、恢复全部失败 | [S3] 1334、1570；[S2] 56-58；R3、R6 | 一次长回复之后，对话不能继续、不能换人、blocked 后不能恢复 | 只对将要送达的内容做预算；切换与恢复的校验不做全量预算；完整历史超限时生成分层交接单（常驻部分、近期部分、按需部分），并标注未包含的内容 | P0 |
| D4 | 交接只有对话正文 | [S2] 37-52 | B 不知道改了哪些文件、谁做的、为什么失败、产物在哪 | 交接单的确定性层纳入：执行者与模型、工具摘要、改动文件（工作区差异优先）、错误码、附件与产物、用量、未完成事项 | P0 |
| D5 | 增量里重复带 `branchedHistory` | [S2] 48；R4 | 每次最多重复约 1 MiB，浪费 token，也挤占预算 | 绑定记录“原生已含 origin”：fork/import 的绑定天然包含 origin | P1 |
| D6 | import 的省略、不完整，以及回复的执行者，都不进入交接 | [S2] 48；R4 | 静默截断，违反 context-transfer.md:13 | 交接单声明 omitted、complete、historyRead，以及每条回复的执行者 | P1 |
| D7 | 首轮和所有新绑定的首轮，都把英文说明加 JSON 当作用户消息 | [S3] 1392；R1；[S56] codex-session.real.ts:134-137 | 原生转录被污染，在原程序里续接时可见，标题可能受影响（待核实）；“像原生”受损 | 没有历史时原样发送；有历史时走原生的说明或资源通道（等通道调研结论），用户消息只放用户自己的话 | P1 |
| D8 | 已取消、未派发、切换失败的输入，让同一 Harness 收到信封 | [S3] 1337-1340；R5 | 原生转录里出现噪声 | 增量只取“目标还没见过、且有内容”的事实；未派发的输入以结构化条目出现 | P2 |
| D9 | 记录的来源与实际派发不一致；contextThroughSeq 过宽 | [S3] 1341 早于 1393；[S2] 50、59 | INV-13 的审计不成立 | Run 引用交接单 ID 与指纹，并记录实际送达的来源区间 | P1 |
| D10 | 接续等级从不为 native_resume；界面不显示等级与交接来源 | [S2] 8；[S3] 1342、1606；web/src 中没有任何引用 | 违反 context-transfer.md:27、lifecycle.md:54 | 每个 Run 持久化等级：native_resume、native_resume+delta、public_context_rehydrate、native_fork、native_import、blocked；界面展示 | P1 |
| D11 | 已派发即视为已送达（被拒或早期失败的回合也推进） | [S3] 1492-1496；[S10] 557-560 | 如果原程序在记录输入前就失败（例如上下文超窗），增量丢失（推断） | 定义送达确认：backend.status 为 completed，或 Driver 声明“失败回合也会写入转录” | P1（待证实） |
| D12 | 切换和首轮 Run 保存全量来源 ID，解析成本二次方增长 | [S3] 390、1572；[S4] 359-361、370-373；M3、M4 | 50 次切换解析 18 ms，200 次 53 ms；每轮全量来源 256 轮时 158 ms | 改存区间水位或交接单 ID；校验降到 O(R+M) | P1 |
| D13 | 分支和接续的引用上限（1 MiB / 512 KiB，单次转义）与上下文预算（1 MiB，二次转义加 4 KiB）不一致 | [S4] 252；[S3] 121；[S2] 57 | 可能建出首条就失败的分支；代码类接续只剩约 0.3 MB 正文余量（推算） | 随 D3 一起解决：预算只针对送达内容，引用历史作为可分层的来源 | P1 |
| D14 | 回合之间的后台活动、在原程序中继续的回合，不进入公共事实 | [S3] 594；ADR-030:39；ADR-039:39-41 | B 不知道 A 在后台或终端里改了什么 | 交接前核对工作区指纹或差异，把“外部改动”列为事实 | P2 |
| D15 | 提前结束进程（结果未知）的回合跳过工具详情写入 | [S3] 1452 | 最需要交代的失败回合，恰好缺少详情 | earlyClose 时也尽力写入已有的详情（只读内存） | P2 |
| D16 | CONTEXT_TOO_LARGE 没有中文说明，也没有预警 | [S19] 840-896 | 用户只看到英文消息，对话突然无法继续 | 交接预算和余量可见，接近上限前提示；修 D3 之后这个码应当很少出现 | P2 |
| D17 | 回合结尾触到 EVENT_LIMIT 时，`fail()` 会让整个 Runtime fatal | [S3] 1478-1507、796（代码推断，未复现） | 一个长对话拖垮所有对话 | 不在本次接力范围，但长对话接力会更早触发；应补一个集成测试，在 M2 修复 | P2（推断） |
| D18 | 清空类原生命令（如果被公告）会让水位反向失真 | [S3] 1393-1397 不区分命令语义；[S65] | A 实际已清空，却被认为已同步 | Driver 声明每个命令对原生上下文的影响（保持、压缩、清空） | P3（待核实） |

### 4.3 可以直接复用的部件

| # | 部件 | 位置 | 现状与证据 | 处置 | 理由与改造点 |
|---|---|---|---|---|---|
| U1 | PublicRun 上的原生活动事实（tools、plan、usage、notices、activities、outputs、attachments、error、selection、timing） | [S5] 92-126 | 已持久化、有上限，自 v7 起 | 采用 | 交接单确定性层的主要输入 |
| U2 | 工具详情 JSON（input 头部 16 KiB、output 尾部 64 KiB、diff 64 KiB、locations ≤16） | [S3] 82-92、1260-1272；[S6] 49-67 | 读取 0.10 ms/条（M5） | 改造后采用 | 需要新增一个应用层只读端口（ContentPort 没有读），并定义每个交接单读多少条 |
| U3 | LocalContentStore（内容寻址、sha256、0600、owner 守卫） | [S8] | 写入 8.2 ms/条 | 采用 | 用来存交接单正文和大块内容；写入放在热路径之外 |
| U4 | `contentReferences()` 回收集合 | [S9] 326-341 | 只扫描快照 | 改造后采用 | 并入交接单和账本的引用 |
| U5 | `buildPublicContext` 的选源与归属校验 | [S2] 16-46 | 857 KB 时 1.84 ms（M2） | 改造后采用 | 拆成“选源”和“渲染”两步；去掉预算抛错；origin 是否包含改为参数；补上执行者归属 |
| U6 | 每个 Harness 一条的 `nativeBindings` 水位 | [S5] 149-160；[S3] 1335-1340 | A→B→A 增量有合成测试 | 改造后采用 | 拆成 deliveredThrough 与 dispatchedThrough；增加“原生已含 origin”标记 |
| U7 | `run.context_prepared`、`native.binding_prepared{resumed}`、`run.native_command` 三个事件 | [S3] 1342、1385、1396 | 已在事件日志里 | 改造后采用 | 作为接续等级与审计的依据；需补字段（交接单 ID、实际送达的区间） |
| U8 | `conversationMarkdown` 导出器（计划、工具、活动、产物、用量、错误、执行者与模型） | [S14] conversation-export.ts:10-43 | 已在用 | 改造后采用 | 迁到领域层，作为确定性摘要的渲染器（现在在 web 层，输入是 SessionView） |
| U9 | 前端的 `parseUnifiedDiff`、`editTools` 与“改动”页 | [S20] lib/turn.ts:60-89；[S17] 91-140 | 已能按文件聚合增删行数 | 改造后采用 | 服务端需要同等能力，不能依赖前端；最好以工作区差异为准 |
| U10 | `unifiedDiff` 构造器（线性） | src/infrastructure/control/unified-diff.ts:19 | 驱动已在用 | 采用 | 用来生成工作区快照的差异 |
| U11 | `usage.context.{used,size}` | [S6] 70-74；[S44] | 多数焦点 Harness 会报告 | 采用 | 估算目标的预算；首轮之前要有默认值，或从其他会话的历史观测中取 |
| U12 | RunTiming 与启动用时中位数 | [S5] 78-91；[S13] server.ts:225-226 | 已有 | 改造后采用 | 增加 contextPreparedAt、handoffDeliveredAt 两个阶段，作为接力性能指标（当前上下文构建混在 preparing→ready 里） |
| U13 | fork/import 的 origin 与引用历史 | [S5] 164-193；[S3] 297-452 | 已实现 | 采用 | 作为交接单的来源之一，并暴露 omitted 等信息 |
| U14 | `carriedNativeConfiguration` | [S4] 389-399 | 已实现 | 采用 | — |
| U15 | ADR-047 流式窗口 | [S3] 1184-1252 | 事件数降一个量级 | 采用 | 与接力有关的新事实不得增加每个窗口的提交 |
| U16 | 测试夹具对信封的解析 | [S57] | 依赖旧格式 | 改造后采用 | 新格式要同步改夹具、`codex-session.real.ts` 和浏览器用例 |
| U17 | 现有 JSON 信封格式本身（英文说明加 JSON，作为用户消息） | [S2] 53-55 | — | 拒绝作为默认通道 | 只能作为原生通道不可用时的回退；回退也需要结构化，并说明省略了什么 |
| U18 | 把新实体塞进 Session 快照 | — | 每次提交整份重写（M3） | 拒绝 | 另建表或放进内容存储，快照里只放引用 |
| U19 | 原生通道线索：ACP 的 `mcpServers`/`_meta`，Codex 的 `developer_instructions` | [S10] 389-390；[S12] 20、57；[S11] 515-516 | 目前为 `[]` / null | 待通道调研 | 不在本报告范围 |

---

## 5. 风险与反模式

- **把“已派发”当作送达证据**：命令回合、被拒回合、清空类命令都会让水位说谎（D1、D2、D11、D18）。
- **单一字节预算，而且查的是完整历史**：会把“历史长”误判成“不能送达”，让对话停摆（D3）。
- **交接与系统说明放在用户消息里**：污染原生转录；说明以用户身份出现；其他执行者的回复（可能复述了工具输出）被原样转交，带来跨厂商的提示注入面。
- **账本或交接单放进 Session 快照，或者保存全量 ID 列表**：直接放大每次提交的成本（M3/M4 中有 10 到 40 倍的增长）。
- **用原生 plan 推导待办**：焦点 Harness 基本不发。**用工具 kind/diff 推导改动**：dsh 没有，Hermes、OpenClaw 不全，超过 128 个工具后丢失。需要工作区级事实。
- **在热路径上同步写内容存储**：约 8 ms/条，包含 fsync。
- **读取了内容却不登记引用**：7 天后被回收器删除，交接单就无法重建。
- **悄悄改信封格式**：夹具、浏览器用例和真实用例会大面积失效（2.7）。
- **用用户没有选过的模型做摘要**（违反简报硬约束）；把模型自评当作“接住了”的质量证明。
- **只在合成夹具上验证增量**：焦点 Harness 上从未有真实的“原生绑定 + 增量”证据；唯一的真实切换用例走的是生产已关闭的 Provider 路径。
- **切换时关闭保留进程，而离开进程组的后台任务继续写工作区**：接手方不知道（D14）。
- **ACP 的 `session/load` 会先回放全部历史**（ADR-020、ADR-029）：长原生会话的恢复耗时可能主导接力时延（推断，未测量）。
- **用“改回”“重试”等界面动作掩盖交接失败**：失败要有可读原因和等级。

---

## 6. 未解决的问题

1. 各焦点 Harness 在回合被拒或早期失败时，是否已经把用户输入写进原生转录？这决定 D11 要修到什么程度，需要逐个用真实程序或源码核实。
2. 原程序是否用首条消息生成会话标题？信封是否已经污染了标题和“本机会话”列表（D7）？
3. claude-agent-acp 等代理是否会公告 `/clear`、`/new` 一类清空上下文的命令？命令对原生上下文的影响应由谁声明（D18）？
4. 目标模型的窗口在首轮之前从哪里得知？模型目录里没有窗口字段，只有跑过一轮后的 `usage.context.size`。
5. fork/import 的绑定如何表达“原生已含 origin”？origin 是否也需要按 Harness 维护水位？
6. 命令回合之后的增量什么时候补交：同一回合内前置（派发两次）、下一条普通输入之前，还是走不经用户消息的通道？
7. 是否把“交接”做成显式实体（有 ID、指纹、策略版本），由 Run 引用，取代 `Run.sourceRunIds`？v13 迁移如何处理已有的 sourceRunIds，以及 K19 的恢复证据校验？
8. 工作区事实用 git 状态与差异、文件指纹，还是工具事实？非 git 工作区怎么办？
9. 保留进程与接力的冲突：B 接手时，A 的后台任务是否可以继续？这牵涉单一写入者约束（ADR-030 方案 C）。
10. API/SDK 使用方（用户 B）如何读取和编辑交接单，与界面保持同一语义（INV-25）？
11. 长对话的根治需要 M2 的快照缓存或分表。接力设计是等它，还是先把新实体放在快照之外独立推进？
12. EVENT_LIMIT 在回合结尾触发时，是否真的会让整个 Runtime fatal（D17）？需要一个集成测试确认。

---

## 7. 来源清单

除非另注，作者或机构均为“HarnessHub 项目”，版本为 `cc/relay-design` @ `07a0825`（2026-11-02 读取），核实方式为“本机源码路径，打开原文逐行阅读”。仓库根目录为 `/Users/sd3/Desktop/project/HarnessGateway-relay`，下表路径相对于它。

| 编号 | 路径（URL） | 标题或内容 | 版本、日期与核实方式 |
|---|---|---|---|
| S1 | docs/proposals/relay/00-brief.md | 接力系统重新设计·讨论简报（第 0 轮） | 2026-11-02；打开原文 |
| S2 | src/contexts/session/domain/context.ts:1-60 | `buildPublicContext`、信封与预算 | 默认 |
| S3 | src/contexts/session/application/runtime.ts:1-1611 | SessionRuntime：create、import、send、switch、fork、resetNative、execute、applySwitch | 默认 |
| S4 | src/contexts/session/domain/state.ts:1-479 | 上限常量、解析、转移规则、恢复 | 默认 |
| S5 | src/contracts/session.ts:1-414 | PublicRun、PublicSwitch、NativeSessionBinding、Origin、SessionSnapshot | 默认 |
| S6 | src/contracts/control.ts:1-240 | NativeToolDetail、NativeUsage、ControlEvent、NativeModelCatalog、HarnessControl | 默认 |
| S7 | src/contracts/content.ts:1-101 | ContentRef、ContentPort、附件上限 | 默认 |
| S8 | src/infrastructure/session/content-store.ts:1-264 | LocalContentStore：格式、读取、回收 | 默认 |
| S9 | src/infrastructure/session/sqlite-store.ts:1-687 | 业务库 v12、transact、事件写入、contentReferences、迁移与备份 | 默认 |
| S10 | src/adapters/control/acp.ts:389-390、523-575、627-629 | ACP 会话参数、prompt 构造、拒绝处理、命令公告 | 默认 |
| S11 | src/adapters/control/codex.ts:250、484-516 | 技能命令、turn/start 输入、developer_instructions | 默认 |
| S12 | src/adapters/control/claude.ts:20、57 | Claude 会话的 `_meta` | 默认 |
| S13 | src/web/server.ts:225-252 | 会话视图、nativeStates、启动用时 | 默认 |
| S14 | src/web/conversation-export.ts:1-43 | 公开对话导出（确定性渲染） | 默认 |
| S15 | web/src/components/Turn.tsx:32、169-178；web/src/components/ChatPage.tsx:143-147、241-263、311-313 | 切换分隔线与失败提示 | 默认 |
| S16 | web/src/components/Composer.tsx:96-97、160、238、284-289 | 切换中提示、原生会话区块 | 默认 |
| S17 | web/src/components/DetailsPanel.tsx:17-18、91-140、159-170、216-219 | 详情栏：改动、过程、执行事实 | 默认 |
| S18 | web/src/components/BranchOrigin.tsx:10-45 | 分支与接续来源卡片 | 默认 |
| S19 | web/src/api.ts:387-388、840-896 | Run 解码与错误文案 | 默认 |
| S20 | web/src/lib/turn.ts:60-89 | parseUnifiedDiff、editTools | 默认 |
| S21 | docs/contracts/context-transfer.md:1-27 | 公共上下文与交接材料（proposed） | 默认 |
| S22 | docs/contracts/switching.md:1-33 | 切换状态契约（proposed） | 默认 |
| S23 | docs/contracts/storage-events.md:1-52 | 持久事实、事件与恢复（proposed，含 ADR-049 一节） | 默认 |
| S24 | docs/contracts/public-session-mvp.md:1-35 | 公共 Session 本机切片（accepted） | 默认 |
| S25 | docs/contracts/lifecycle.md:1-65 | 接收、执行、停止与恢复（proposed） | 默认 |
| S26 | docs/domain/invariants.md:1-34 | 核心不变量（proposed） | 默认 |
| S27 | docs/domain/context-map.md:11、20；docs/domain/language.md:17 | Continuity 上下文与 ContextManifest 的术语 | 默认 |
| S28 | docs/contracts/adapter-spi.md:10 | openOrRestore | 默认 |
| S29 | docs/decisions/0010-public-session-mvp.md | ADR-010 | 2026-10-09；打开原文 |
| S30 | docs/decisions/0015-native-harness-models-and-switching.md | ADR-015 | 2026-10-11；打开原文 |
| S31 | docs/decisions/0019-native-session-experience.md | ADR-019 | 2026-10-11；打开原文 |
| S32 | docs/decisions/0020-complete-native-harness-capabilities.md | ADR-020 | 2026-10-11；打开原文 |
| S33 | docs/decisions/0022-native-activity-and-content-store.md | ADR-022 | 2026-10-11；打开原文 |
| S34 | docs/decisions/0024-native-session-operations.md | ADR-024 | 2026-10-11（含 10-21 补充）；打开原文 |
| S35 | docs/decisions/0025-conversation-branches.md | ADR-025 | 2026-10-11；打开原文 |
| S36 | docs/decisions/0028-native-configuration-sync.md | ADR-028 | 2026-10-11；打开原文 |
| S37 | docs/decisions/0029-continue-native-sessions.md | ADR-029 | 2026-10-11；打开原文 |
| S38 | docs/decisions/0030-retained-native-processes.md | ADR-030 | 2026-10-11/12；打开原文 |
| S39 | docs/decisions/0036-approval-wait-budget.md（与 lifecycle.md §3） | ADR-036 | 2026-10；搜索相关段落并打开 |
| S40 | docs/decisions/0047-stream-output-coalescing.md | ADR-047（含合成测量） | 2026-10-21；打开原文 |
| S41 | docs/decisions/0049-business-store-backup-before-migration.md（与 storage-events.md:43-52） | ADR-049 | 2026-10；契约段落打开原文，ADR 文件只核对存在 |
| S42 | docs/decisions/0039-continue-in-the-original-program.md | ADR-039 | 2026-10-12（含后续补充）；打开原文 |
| S43 | docs/decisions/0046-harness-focus-hardening.md；docs/decisions/README.md | ADR-046 与决策索引 | 2026-10-21；打开原文 |
| S44 | docs/verification/native-capability-matrix.md | 逐 Harness 原生能力矩阵（27 项） | 生成自 plan/native-capabilities.json；打开原文 |
| S45 | README.md:5、194 | 项目入口：Codex→Gemini→Codex 接续 | 默认 |
| S46 | docs/verification/harness-management-2026-10-10.md:43；native-management-2026-10-11.md:19、40；native-cli-recovery-2026-10-11.md:25 | 真实切换的验收记录 | 2026-10-10/11；打开原文 |
| S47 | tests/unit/session-context.test.ts:1-93 | 上下文单元测试 | 默认 |
| S48 | tests/integration/session-runtime.test.ts:130-153、156-188、224、242、273、364、390、438、560-680、752、791-834、864-893 | Runtime 集成测试 | 默认 |
| S49 | tests/integration/native-experience.test.ts:44-68 | 原生命令不注入 | 默认 |
| S50 | tests/integration/kept-process.test.ts:69-90、115 | 保留进程与水位 | 默认 |
| S51 | tests/integration/web-server.test.ts:146、391-406 | 失败切换；分支经 HTTP | 默认 |
| S52 | tests/integration/session-cli.test.ts:171-197、303 | CLI 的 A→B→A | 默认 |
| S53 | tests/integration/session-store.test.ts:607、628 | 迁移与原生持有者 | 默认 |
| S54 | tests/unit/session-state.test.ts:77、81、91、159、173、195 | 状态解析 | 默认 |
| S55 | tests/browser/web.browser.ts:97-256、696-725、812-816 | 浏览器：切换、分支、接续 | 默认 |
| S56 | tests/real/codex-session.real.ts:134-140；harness-provider-switch.real.ts:116-138；native-resume.real.ts:62-79；native-branch.real.ts:70；native-import.real.ts:108-109；native-commands.real.ts:83 | 真实用例 | 默认（只读，未运行） |
| S57 | tests/fixtures/session-peer.mjs:58-62；web-harness-peer.mjs:28-31、43、90 | 解析信封的夹具 | 默认 |
| S58 | TASKS.md:10、20、48-49、70、1029-1041；docs/engineering/test-matrix.md:205、264；docs/product/phase-1.md:33；docs/product/requirements.md:14-15；docs/engineering/testing.md:30 | 计划任务、测试矩阵、需求 | 默认 |
| S59 | /Users/sd3/Desktop/project/HarnessHub/docs/proposals/chat-first/README.md:3、40、93-99、133-139、150-163 | 以 Chat 为中心的八步蓝图（用户已确认的方向） | 旧 HarnessHub，2026-10-08；本机文件，打开原文 |
| S60 | /Users/sd3/Desktop/project/HarnessHub/docs/features/user-journeys.md:3、34-43、133 | 用户旅程与功能地图 | 旧 HarnessHub，2026-10-08；本机文件，打开原文 |
| S61 | /Users/sd3/Desktop/project/HarnessHub/docs/features/chat-flow.html:158、189、218 | 交互式链路说明 | 旧 HarnessHub，2026-10-08；本机文件，抽取文本阅读 |
| S62 | 会话 scratchpad `bench/bench.mjs`、`bench2.mjs`、`bench3.mjs`（加载钩子 `hooks.mjs`、`register.mjs`） | 合成测量 M1–M5 | R4 编写；2026-11-02 本机合成运行，Node v26.11.1，命令 `node --no-warnings --import ./register.mjs <脚本>`，取 5 次中位数；不是仓库文件 |
| S63 | 会话 scratchpad `bench/repro.mjs`、`repro2.mjs` | 合成复现 R1–R6 | R4 编写；2026-11-02 本机合成运行：正式 Runtime 加真实 SQLite（临时数据根，运行后已删除），合成 HarnessControl；不是真实 Harness 证据 |
| S64 | src/cli/web.ts:38 | 生产 Web 设 `providerManagement: false` | 默认 |
| S65 | src/adapters/capability-reads.ts:239 | Claude 内置命令表（含 clear、compact） | 默认（只核对了列表，未核对 ACP 是否公告） |

合成数据的说明：

- **M1**：100 轮，二分查找每条回复的长度，直到预算报错。
- **M2**：255 轮中文回复。
- **M3**：快照含 30 个工具摘要，或 50/200 次带全量来源的切换。
- **M4**：每个 Run 都带全部前序来源。
- **M5**：200 条约 19 KB 的工具详情。

所有数据都是构造出来的，没有使用任何用户内容。
