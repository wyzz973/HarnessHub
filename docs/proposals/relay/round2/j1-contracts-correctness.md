# J1 · 契约与正确性评审（第二轮）

评审：J1（契约与正确性）。日期：2026-11-03。基线 `cc/relay-design`，代码与 `07a0825` 相同。P1–P4 全文已通读，对现状的每条描述都对照代码核实过。本文没有运行任何 Harness，也没有改代码。

标注：【事实】附 file:line 或报告位置；【推断】由事实推出；【裁定】J1 的结论与要求。

## 1. 评分表

六个子项，每项 1–10 分，总分为六项之和，满分 60：

- A 硬约束与不变量：INV-11/13/14/17/20/26/21/22，以及“先提交再发布”；
- B 状态机与竞态；
- C 水位语义：R4 D1–D3 与 R8 列出的失真情形；
- D 存储与迁移；
- E 模块边界；
- F 幂等与可重建。

### P1 账本优先：42

| 子项 | 分 | 理由 |
|---|---|---|
| A | 7 | INV-13/14/21/22 的修改都写成了可测命题；但组装后移到 open 之后，却没有启动前预检（K8），补折叠也没有声明所有者和关闭入口（INV-26）。 |
| B | 7 | settle/beforeDispatch 覆盖了命令回合、合成结果、插入前取消、清空与回退、进程被杀；但每个 Run 的送达结论写在已终结的 Run 上，下一次 open 才拿到的 E2 写不进去（state.ts:441）。 |
| C | 7 | §6.2 表逐项修复 D1–D3 与 R8 的失真；但 P0 的 `carried` 没有定义，又沿用 throughRunId 当水位（见 F1），而按记录期取增量会让迁移后的旧绑定收到整本账本。 |
| D | 7 | v13 表、ADR-049 条件、contentReferences 的三类新引用和 K19 都写到了；但迁移没有给出 legacy 绑定的 `delivered.ledgerSeq`，before 观测也只在发现回合外改动时才落库。 |
| E | 8 | 领域层是纯函数，观测器在 infrastructure，Driver 只报证据，Runtime 没有产品分支。 |
| F | 6 | 链与 ID 都确定；但补折叠和新回合的折叠交错时，“重建结果与在线结果逐字节相同”不成立，除非规定严格按 Run 顺序折叠。 |

### P2 原文保真优先：36

| 子项 | 分 | 理由 |
|---|---|---|
| A | 6 | INV-29（未照录必给取回位置）很好；但记录文件在提交之前追加并 fsync，交接单正文又“可修剪”，削弱了先提交再发布与 INV-13 的可审计性；建议的 recoverSession 改动还会削弱 INV-11/12。 |
| B | 6 | 证据三态和 `relay_deliveries` 清楚；但 rewind 按“最近 n 个原生轮次”映射到公共单元，在原程序里续过的会话上会映射错；`handoffDeliveredAt` 也写不进已终结的 Run。 |
| C | 5 | extra/rewound 集合能表达不连续的送达；但 P0-2 的字面规则会在单 Harness 对话里引入信封污染，v13 的“throughRunId 随 delivered 推进”又与 state.ts:319–320 矛盾（F1、F2）。 |
| D | 6 | 迁移重放“只降不升”是对的；但第二存储（记录文件）只靠崩溃后截断维持一致，分支时复制的 RunFacts 行还会引用本会话里不存在的 run_id。 |
| E | 7 | 领域纯函数，端口清楚；startTurn 取代 startText 会波及全部 Driver，但没有越界。 |
| F | 6 | 折叠确定，恒等式可测；但 G1 片段的懒重建需要内容读取端口，方案没有列出（`contracts/content.ts:97–101` 没有 read）；正文被修剪后，只能靠旧版渲染器复现。 |

### P3 推小拉大：39

| 子项 | 分 | 理由 |
|---|---|---|
| A | 5 | Hermes 网关持有的 shim 没有 Hub 的关闭入口（INV-26）；数据根可能落在工作区内；组装后移也没有启动前预检。 |
| B | 6 | 挂载失败后作废重渲、resend 与去重都写清楚了；但交接单引用的记录可能尚未物化，标记缺失即新开会话又会误伤压缩过的会话。 |
| C | 8 | “外来事实”定义为别的绑定执行的回合或输入未被记录的回合，再配上 executedOn，是四份里最干净的水位语义。 |
| D | 7 | 两张表，正文进业务库，contentReferences 不变；迁移从事件日志确定性重建；记录目录有清理规则。 |
| E | 6 | shim 不引第三方包，符合 B10；但 lean/standard 的类别表按产品名和模型名取值，应当改按能力证据取值。 |
| F | 7 | L0 是纯函数，记录按 (runId, policy, 指纹) 只写一次，搜索排序确定。 |

### P4 控制面与原生通道优先：46

| 子项 | 分 | 理由 |
|---|---|---|
| A | 8 | prePlan/finalize 两段保住了 K8，“已切换”与“已接棒”分开表达（INV-21），每个新资源都写了所有者。 |
| B | 8 | 五态同步表最完整，还给出了“任意证据序列下 delivered 单调、且不超过实际送达”的属性测试；问题在 diverged 时自动新开会话，以及 contextReadyAt 的位置。 |
| C | 7 | 覆盖了全部失真，并发现了 carriedNativeConfiguration 的回退；但 P0 仍把 throughRunId 当水位，没有处理 fork 精确性，本绑定 unknown 的普通回合还会在下一回合作为增量重发。 |
| D | 7 | `relay_deliveries` 尊重终态不可改写，回收集合不变且有断言；但 legacy 推断只看 D1/D2 形态，漏掉了清空与回退命令和插入前拒绝。 |
| E | 8 | 用能力声明和 SecretScanner 端口表达差异，verifyDelivered 只回布尔与计数，第三方类型留在 Driver。 |
| F | 8 | ID 由内容派生，`INSERT OR IGNORE` 遇到同 ID 不同 sha 即报 INVALID_DATA，相当于在线检查确定性；幂等键列成了表。 |

总分：P4 46 > P1 42 > P3 39 > P2 36。从本视角看，终稿的控制面以 P4 为骨架，水位定义取 P3，账目与可追溯性取 P1/P2。

## 2. 致命缺陷

### F1【P1、P2、P3、P4】P0 切片把 throughRunId 改作“已送达水位”，破坏另外两条已接受的契约

【事实】`throughRunId` 有三个读者，四份方案的 P0（P1 R0②、P2 P0-2、P3 P0-2、P4 R1）都只看到了第一个：

1. 增量来源过滤：runtime.ts:1337–1339；
2. 精确原生分支：runtime.ts:438 的 `native.throughRunId === through.id`。ADR-025 决定 2 规定，只有原生会话恰好同步到分支点时才做原生 fork；
3. 原生配置携带：state.ts:392–393 取 throughRunId 所指 Run 的 epoch（ADR-028）。

【推断】后果有三：

- **(a) 原生分支不再精确。** 返回 A 后的首条是目录内会执行的命令（Claude 自定义命令、Codex `/skill:*`，contextEffect=keep），throughRunId 停在 A 离开前的第 k 轮。此时用户在第 k 轮“从这里分支”，438 判为精确，原生副本却包含这条命令回合。这正是 ADR-025 否决的情形：“副本会包含分支点之后的内容”。
- **(b) 用户换的模型被撤销。** 这条命令若改了模型（如 Hermes `/model`），throughRunId 仍指向上一 epoch 的 Run，393 返回 null，下一回合按 selection 重设模型。P4 发现了 (b)；(a) 四份都没有发现。
- **(c) 信封污染或反复重发。** P2、P4 的字面规则是“命令回合保留原 throughRunId”。这样一来，没有任何切换的单 Harness 对话里，`/compact` 之后的下一条消息会把这条命令回合本身当作来源（1338–1339），1392 于是改发 JSON 信封，引入 D7 式污染。P1 写的是 `carried && input≠not_recorded`，P3 写的是 `dispatched && carried`，但都没有定义 carried。若理解为“发送了信封”，同步状态下的普通原样回合就永远不推进，每个回合都会重发上一回合。

【裁定】修法分四步：

1. v12 的推进规则写死为 `advance ⇔ dispatched ∧ input≠not_recorded ∧ (due=∅ ∨ carried)`。其中 due 指本回合开始时应补交给该绑定的来源集合；
2. 438 增加条件：through 之后没有在同一 harness/control 上派发过的 Run。判定依据是 `run.selection` 与 `timing.dispatchedAt`，v10 起都有；
3. 392 改为取该绑定最后一个已派发的 Run；
4. 补齐 M1 列出的三条回归测试。

v13 中，原生位置与 delivered 分成两个字段。做不到这些，P0 不能先发。

### F2【P2】v13 的“throughRunId 保留并随 delivered 推进”与快照校验矛盾

【事实】state.ts:319–320 要求：非空的 throughRunId 指向已终结、且 selection 为同一 harnessId/controlId 的 Run。P2 的 delivered 是单元序号，送达 B 的回合之后就会越过 B 的 Run（P2 §13“快照 v13”）。

【推断】两种实现都不行：

- 字面实现：parseSession 以 INVALID_DATA 拒绝快照，对话不可读；
- 只推进到“本绑定自己的最后一轮”：又回到 F1 的耦合。

【裁定】throughRunId（或它的继任字段）只表示原生位置，delivered 单独成字段。

### F3【P3】Hermes 网关持有的 shim 没有 Hub 所有者

【事实】P3 §5 写明，shim 规格交给网关的 `editor.mcp_servers`，进程“归网关所有”，靠 stdin 关闭、父进程变化、空闲 15 分钟或目录被删自行退出。INV-26 要求每个进程都有所有者、上限和可等待的关闭入口。

【推断】这个进程由 Hub 引入，却不在 Hub 的关闭链里：Hub 退出、用户撤回同意或删除对话时，Hub 都等不到它结束。规格交给网关后是否会持久化进用户的网关配置，P3 也没有核实；若会，就违反“不改用户配置”。

【裁定】v1 对 Hermes 只用推送，或经核实的文件读取，不挂 shim。

### F4【P3、P4】标记缺失即判为分叉，并自动归档就绪绑定、新开原生会话

【事实】

- R8 H8（r8-gap.md:164）：Hermes 只回放未归档的会话行，被压缩归档的行不回放。所以原生压缩之后，先前送达的标记必然缺失。
- P4 §6 只把 Hub 发出的清空与回退排除在 diverged 之外；P3 §6 不排除任何情形。
- 现有契约里，替换原生会话只有用户显式的 native-reset 一条路（runtime.ts:401–416）；contracts/session.ts:144 写的是 “never silently resumed or replaced”。

【推断】每次自动压缩之后返回 Hermes，A 自己的原生上下文和工具轨迹都会被丢弃，换成一个新会话。A→B→A 在 Hermes 上实际不可用。

【裁定】处理规则见 M5。

## 3. 最佳想法：可嫁接进终稿的机制

1. **五态同步表与属性测试**（P4 §6、§16 R5）：“任意证据序列下 delivered 单调，且不超过实际送达”。这是本视角最需要的验收命题。
2. **独立的送达表**（P4 §13 `relay_deliveries`）：结论从 in_flight 走到 recorded、not_recorded 或 unknown，另有 `verified_in_run`。E2、E3 的时刻不写进已终结的 Run，与 state.ts:441 相容。
3. **两段准备**（P4 §6 prePlan/finalize）：启动前按保守窗口预检，满足 K8 和 context-transfer.md 的“上下文构建失败在启动前结束”；open 之后再核对、定稿（R8 G5）。
4. **外来事实的定义与 executedOn**（P3 §6、§2）：外来事实指本绑定当前纪元以外执行的 Run、输入未被记录的 Run，以及 holdsOrigin=false 时的 origin。`RunRelay.executedOn` 可以导出原生位置，F1 随之消失。
5. **可追溯的三条硬命题**，都能写成属性测试：
   - P1 §13 修改后的 INV-13：每条可交接的有效事实，要么被渲染，要么计入省略账目；
   - P2 §13 INV-29：没有照录的内容，必须给出取回位置，或写明“不可取回”；
   - P2 §4.3 的账目恒等式。
6. **工作区观测作为事实随包落库**（P2 §2）：交接时的工作区观测是记录下来的事实，重建时作为输入（INV-22 细化）。
7. **在线确定性检查**（P4 §13）：ID 由内容派生；`INSERT OR IGNORE` 遇到同 ID 而 sha 不同时，报 INVALID_DATA。
8. **RelayConformance 门控**（P4 §7）：能力声明只在最新正式版上探针通过后才对生产生效（INV-16、ADR-053）。P9 只比对用户配置的 sha256，不打印内容。
9. **失真情形逐行成测**（P1 §6.2）：“情形 → 现状 → 本方案”表的每一行，直接就是一条集成测试。
10. **迁移只降不升**（P2 §13）：迁移重放出的水位只会小于或等于原值，可以写成迁移的属性测试。
11. **carriedNativeConfiguration 的修正**（P4 §16 R1）。
12. **两条工作区安全措施**：数据根落在工作区内时不提供取回，写 `inside_workspace`（P2 §5）；git 观测关闭 fsmonitor，设 `GIT_OPTIONAL_LOCKS=0`（P2 §1）。
13. **核对不回灌内容**（P4 §2）：verifyDelivered 只返回布尔值与计数（R8 §5）。
14. **工具在建会话时冻结**（P3 §13 INV-29）：中途不增不减。以后若做接力 MCP，必须带上这条。

## 4. 终稿必须包含（可验证的表述）

### 水位与证据

**M1 原生位置与送达水位分离。** v13 中，每个绑定分别记录原生位置（最后一个在该绑定、该纪元派发的 Run）和 delivered。runtime.ts:438 与 state.ts:392 只读原生位置。测试：

- A→B→A 后首条为 keep 类命令，之后在 A 离开前那一轮分支，不得产生原生 fork；
- 命令回合 `/model X` 之后的内容回合，仍然使用 X；
- 单 Harness 对话里，`/compact` 之后的下一条原样发送，不带信封。

**M2 推进规则逐字写进契约。**

- delivered 只因正面证据（E1/E2/E3）推进，与回合终态无关；
- 命令回合从不携带交接内容；
- clear：delivered 置空，nativeEpoch 加 1；
- rewind 与效果未知的命令：进入待核（suspect）；
- not_recorded：不推进；
- unknown：记为 pending。

测试：R8 §2.8 与 §2.9 的每一格各有一条协议夹具测试。

**M3 送达结论不写在终态 Run 上。** 存独立表。允许的转换只有两类：in_flight 到 {recorded, not_recorded, unknown}；unknown 到 {recorded, not_recorded}，后者只能由后续核对触发。测试：

- Hermes 回合结束时为 unknown，下一回合 open 时核对为 recorded，期间该 Run 的快照字节不变；
- 属性测试：delivered 单调，且不超过实际送达。

**M5 标记缺失的处理。**

- 送达之后观察到过压缩（compaction 活动，或 contextEffect=compact）：判为 compacted，在同一原生会话里发 reanchor 和未送达的增量；
- 其他情形：派发前停下，交给用户选择，默认在同一会话里发完整交接单；
- 永不自动归档或替换 ready 绑定。

测试：Hermes 压缩后返回，checkpoint 不变；没有用户动作时，绑定数组不增长。

**M17 本绑定回合的送达判定。**

- 有 E1/E2/E3，或有 agent 输出证据：视为已送达；
- not_recorded：按外来事实处理，进入下一次增量；
- unknown 且没有任何 agent 活动：不重发，界面显示“未确认”。

测试：Claude 插入前取消之后，下一条不带交接内容。

### 准备、提交与恢复

**M4 两段准备与提交顺序。**

- 启动前预检：最小必需块加用户原话超出通道硬上限时，在 `factory.prepare` 之前失败（K8）；
- open 之后定稿；
- 交接单、`run.context_prepared` 与 delivery(in_flight) 同一事务提交，且早于 `run.dispatched`；
- contextThroughSeq 在 status 变为 running 之前提交，否则就要显式修订 state.ts:448。

测试：预检失败时没有任何进程启动；每个提交点都做崩溃注入。

**M8 恢复语义。**

- recoverSession 不变：凡非 queued 的 Run 一律记 unknown（INV-11/12）；
- 送达结论另判：没有 dispatchedAt 记 not_recorded(never_dispatched)，有 dispatchedAt 记 unknown；
- unconfirmed 的绑定仍抛 NATIVE_STATE_UNCONFIRMED。

测试：派发前、派发后各做一次崩溃注入。

**M16 E1 的提交顺序。** 按 ADR-047，先提交当前流窗口，再提交 `input_recorded`。测试：事件日志中，分隔线事件不晚于它之后的第一条输出。

**M18 BackendResult.input 的持久化。** v12 中在持久化前剥离（state.ts:95 的白名单）；v13 的解析器显式接纳。测试：v12 拒绝带 input 字段的 backend。

### 存储与迁移

**M6 扩展 assertSessionTransition。**

- binding.relay 只能由在该绑定上执行的 Run 修改，迁移除外；
- nativeEpoch 单调；
- 同一纪元内，delivered 只在 clear 或 suspect 回退时变小；
- 新字段都有解析器，v12 快照照常可读。

测试：每条规则各配一个无效样例，必须被拒绝。

**M7 迁移 v12→v13。**

- 备份条件改为 1–12（sqlite-store.ts:396），owner 版本检查改为 13（:265）；
- legacy 水位保守取值：在最后一个携带来源的回合之后，只要出现过原生命令、`request_rejected`、`model_not_applied` 或清空类命令名中的任何一项，就记为 suspect。

测试：

- 迁移后的 delivered 不大于 v12 throughRunId 所隐含的位置；
- v12 构建拒绝 v13 库；
- 迁移失败时整笔回滚，备份保留。

**M9 K19 的恢复证据。** 新切换使用显式的 `acknowledgedUnknown` 字段，解析器同时接受旧切换的 `sourceRunIds`，state.ts:340–342 两者都认。新 Run 不再写全量 sourceRunIds，校验降到 O(R+M)。测试：200 次切换下的解析时长有基准对照。

**M10 交接单不可变。** 发出的字节在会话存续期间原样保存，不修剪；ID 由内容派生；同 ID 而 sha 不同，报 INVALID_DATA。测试：重渲染 100 次只得到 1 个 sha。

**M11 可追溯（INV-13）。** 清单记录：

- 来源区间；
- 策略版本与渲染器版本；
- 事实指纹；
- 所用工作区观测的指纹（观测本身已落库）；
- 满足恒等式的省略账目。

测试：属性测试，每条可交接的事实要么被渲染，要么被计数。

**M12 内容回收。** relay 结构若存 ContentRef，必须并入 contentReferences()（sqlite-store.ts:326–342）；否则加一条测试，断言 relay 行中不出现 `content-` 标识。

### 资源、工作区与编号

**M13 资源所有者（INV-26）。**

- git 子进程：有超时和 kill，并在 execute 的 finally 中等待；
- 折叠与物化队列、预取 LRU：有上限，有 close()；
- 核对 RPC：有限时；
- 不引入 Hub 无法等待其关闭的进程。

**M14 工作区观测。** 在取得工作区租约之后进行；设 `GIT_OPTIONAL_LOCKS=0`、`-c core.fsmonitor=false`，不运行 hook。测试：`.git/index` 的 mtime 不变；超时记为“未核验”，不阻塞交接。

**M15 取回路径。** 只在数据根位于工作区之外时给出（数据根默认是相对路径，src/cli/session-application.ts:17–18）；否则写 `inside_workspace`。

**M19 统一编号与数量约束。** 从 INV-29 起统一编号，四份方案目前互相冲突。一个 Run 至多携带一份交接单；每个原生纪元至多一份完整交接单，前一份为 not_recorded、unknown 或判为分叉时除外。

## 5. 分歧裁定（本视角）

| # | 裁定 | 理由；与方案作者的分歧 |
|---|---|---|
| C1 | 默认用确定性投影，原话、失败证据和最近回复逐字照录（P1/P4）；保真档作为可选档；不按方向推断；失败后不降档。 | 本视角不判内容优劣，只要求档位记入清单、结果可复现。P2 的默认档留给 RelayBench 裁决；四份都主张失败后不降档，同意。 |
| C2 | 预算只由一个解析器给出：hardCap = min(5%W, 悬崖余量, 32k)，标准档 8k，完整档 32k 只能显式选择；必需块（框架、状态、目标）≤3k；只有“必需块 + 原话”超过通道硬上限才 blocked，并且在启动前判定（K8）。 | 与 P2 的 16k 默认、P3 的 2k L0 不同。但这些数字都是推算，本视角只约束判定位置和可复现性；窗口来源必须进清单，P1/P2/P4 已经做到。 |
| C3 | 两个 text 块：交接单在前，原话在后；标记放在第一块（R8 G15）；不用 resource。 | 与 P3 不同：原话在前时标记落在第二块，而 dsh 会把多块合成一条消息、OpenClaw 会直接拼接（P3 §3 自述），E2 在这种布局下是否稳健，没有证据。 |
| C4 | 权威的接力状态（送达结论、水位、交接单）与所属提交同事务；每轮一行的摘要与 `run.ended` 同事务，出错时隔离；派生文件可以在提交后异步生成，但派发前要设屏障。 | 同意 P1/P2/P4 的同事务写入。P3 的异步物化可以接受，但交接单引用了尚未物化的 ref 时，必须同步补齐，或把该项标为“不可取回”。 |
| C5 | 默认不复述，送达只认 E1/E2/E3。 | 四份一致；AGENTS.md 也禁止拿模型自评作证据。 |
| C6 | v1 只推送，推送部分要自足。文件拉取须同时满足两条：数据根在工作区外；Driver 的读取能力经探针核实。stdio MCP 推迟到三条都满足之后：生命周期归 Hub、工具在建会话时冻结、探针通过。Hermes 不挂 shim。 | 与 P3 不同，见 F3。 |
| C7 | 默认原生续接加增量；核对代价低的就先核对标记。标记缺失按 M5 处理：发生过压缩就发 reanchor；其他情形由用户选，默认在同一会话里发完整交接单；永不自动新开会话。缓存冷且上下文大时，并列给出两种方案，由用户选。 | 与 P3、P4 不同，见 F4。与 P1 接近，但补上了压缩分支。 |
| C8 | 默认关闭；用户显式发起时，作为 A 上一个可见的普通回合，不在 fork 副本里写。 | 与 P4 不同。acp.ts:356–358 写明：fork 被拒后，副本可能已经存在；runtime.ts:1543–1549 的归档仍假设没有副本，副本的清理没有所有者。 |
| C9 | v1 的“决定”只有四个来源：用户钉住；审批记录（只作历史）；用户原话（逐字）；Harness 自述（标“自述，未核实”）。启发式词表抽取默认关闭，RelayBench-X 精度达到 0.8 后才开启，开启后标为“词表选取”。 | 与 P1 的默认开启不同。误抽的“决定”就是一条伪造的事实，而 INV-13 要求事实可追溯，自述只能如实标注等级。 |
| C10 | git 在每个边界观测一次（之前与之后），结果作为事实落库，重建时不重算；非 git 工作区做有界扫描，扫不完记“未核验”；观测失败不阻塞交接；归属只写“第 k 轮期间”或“回合之间”。 | 四份大体一致。另补 M14 的安全参数，并规定在取得租约之后观测。 |

## 6. 方案对现状的误读

1. 【P1–P4】只把 throughRunId 当作增量水位。实际上它还被 runtime.ts:438（ADR-025 精确分支）和 state.ts:392–393（ADR-028）读取。P4 只发现了后者。
2. 【P2】“throughRunId 保留并随 delivered 推进，state.ts:317–323 的校验照常成立”不对。state.ts:319–320 要求 throughRunId 指向同一 harness/control 的 Run，它无法覆盖外来回合。
3. 【P1】“每个 Run 的送达状态存在 PublicRun.relay……不另建送达表”行不通。终态 Run 不可改写（state.ts:441），而 Hermes、OpenCode 的 E2 要到下一次 open 才拿到，届时写不回去。
4. 时序字段与代码不符：
   - 【P2】给 RunTiming 增加 `handoffDeliveredAt`，同样撞上 state.ts:441；
   - 【P4】时序链写成 `readyAt → contextReadyAt`。但 readyAt 与 status=running 在同一次提交（runtime.ts:1389），而 state.ts:448 禁止进入 running 之后再改 contextThroughSeq。
5. 【P3】P0-3 在 BackendResult 上记 input，却没有写持久化前剥离。backend 会落进快照（runtime.ts:1425），解析器的白名单是 `status`、`reason`、`error`（state.ts:95），带 input 的快照会被拒绝，对话随之不可读。
6. 【P2】建议把 preparing 且无 dispatchedAt 的 Run 恢复为 cancelled。无 dispatchedAt 只能证明输入没有发出，不能证明程序已经关闭：派发前绑定已写成 unconfirmed（runtime.ts:1382–1385），清理也未确认。所以应保留 unknown（INV-11/12），只把送达结论判为 not_recorded。
7. 【P3、P4，以及对 R9-18 的直接采用】把标记缺失等同于分叉。Hermes 只回放未归档行（R8 H8），压缩本身就会让标记消失。
8. 【P1–P4】默认 Hermes 的 on_next_open 核对零成本、必然发生。保留进程复用时（ADR-030）并不调用 open（runtime.ts:1345–1354），也就没有回放。只有 backend 为 completed 的回合才会保留进程（runtime.ts:638），此时 E3 已经成立，所以缺口很小；但状态机不能假设核对一定发生过。
9. 【P1、P3】示例与设计都假定数据目录在工作区之外（P1 的 S1 用的是 `~/Library/Application Support/...`）。实际默认是 `resolve("data")`，即启动目录下的 data（src/cli/session-application.ts:17–18），可能就在工作区里。
10. 【P1】把“写入前的工作区指纹核对”标为 INV-12。INV-12 讲的是写租约隔离，不是指纹核对。P4 的“写入前的工作区边界（INV-12 不变）”也有同样的混用。
11. 【P2】`rewind(n)` 把“最近 n 个原生轮次”映射到公共单元。Hub 并不知道原生回合的身份（ADR-025 背景），原程序里也可能有 Hub 之外的回合（ADR-039）。
12. 【P1】S1 写“交接前没有发现回合外的改动”，但 before 观测只在发现改动时才落库（§13 事件表），这句话没有持久的来源，不满足 INV-13。
13. 【P1】`ledgerLive` 在 mutate 回调里同步读 Store。但 transact 的回调运行在 SQLite 事务之内（sqlite-store.ts:346–362），只能用同一连接读，或者先读好再传入，不能再开新事务。

核实无误、可以照用的引用：

- runtime.ts:1334、1392–1397、1496、1569–1573；
- codex.ts:525–528、706；
- openclaw.ts:91–94；
- opencode.ts:79–84；
- claude.ts:24–25、70–72；
- acp.ts:390、557–560、619–625；
- sqlite-store.ts:265、396；
- binding-factory.ts:173；
- 另有一条已核实的事实：v12 的事件类型是开放的（sqlite-store.ts:98–106），所以 P0 新增事件不必升库版本。

## 7. 遗留风险与需要真机核实的点

1. **Claude `/clear` 后再 resume。** 按旧会话 id resume，可能回到清空前的转录（R8 C9，未核实）。若属实，“clear 后 delivered 置空”会造成重复注入。核实：`/clear`，关闭进程，再 resume，读回放。
2. **Hermes `/compress` 后的标记。** 压缩之后回放里是否还有标记，直接决定 M5 的判定。核实：送达带标记的输入，压缩，再 load。
3. **OpenCode 取消后滞留的输入。** 它可能晚到送达（R8 O 系列），与 resend 叠成重复。要用真机核实去重提示是否有效。
4. **两种“成功”回合。** Codex 被 hook 拦截的回合报告 completed，却没有 userMessage；dsh 的 blocked 回合是否先于输入发出 plan 或输出，会影响弱 E1。两者都需要协议夹具，再加一次真机核对。
5. **E3 规则的版本漂移。** Claude CLI 是压缩代码，OpenClaw 是打包产物，E3 规则依赖其内部实现。每个最新正式版都要重跑 RelayConformance（ADR-053）。
6. **v13 迁移的时长。** 迁移在 BEGIN IMMEDIATE 内逐会话扫描事件日志，每会话最多 16,384 条、32 MiB。需要在合成大库上实测，再决定是分批迁移，还是改为首次打开时惰性推算。
7. **快照增长。** 新字段会让快照变大，而 8 MiB 的上限不变；7.6 MiB 时每次提交已需 144 ms（R6 实测）。需要基准测试守住“新增字段只放引用”。
8. **工作区观测的副作用。** 需要在真实仓库上测：submodule、LFS、watchman/fsmonitor、大量未跟踪文件。核对 `.git/index` 不变，2 s 超时成立。
9. **桌面版的数据根。** cask 应用与 CLI 启动时的实际默认数据根，决定 M15 在默认安装下能否开启文件取回。
10. **OpenClaw 的 cwd 前缀。** 桥给提示加 cwd 前缀之后，网关是否还能识别斜杠命令（R8 W6，未核实），影响 contextEffect 的判定。
11. **pre-v13 回合的懒重建。** 结果为 unknown 的回合因 earlyClose 没有写入工具详情（R4 D15），重建出的事实不完整，必须标“详情缺失”，不能当成“没有工具”。
12. **方案自报的数字。** P3 的“本机实测”没有入库脚本，无法复现；各方案的 p95 目标都是推算。只能用作基准的初值，不能写进验收。
