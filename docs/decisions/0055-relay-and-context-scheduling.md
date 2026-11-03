# ADR-055：接力与上下文调度（HarnessHub Relay）

状态：accepted，2026-11-03（用户当天验收，按推荐项接受全部取舍 D1–D11，原话：“按推荐接受”）。设计正文是[接力系统统一架构终稿](../proposals/relay/relay-architecture.md)（第三版，总架构师 Fable 5.1 定稿，下称终稿）；本记录只写取舍、失败边界与验收方式，契约、数据模型、模板与伪代码以终稿各节为准。**未实现、未真机验证**：没有改 Session 运行时，业务库仍是 v12，没有运行任何 Harness 会话，没有改用户配置；原型只用合成数据（`spikes/relay/`，不在 TypeScript 构建范围内）。实现按终稿第 17 节的切片顺序进行；“用户拍板的取舍”一节的 D1–D11 已全部按推荐项接受（终稿[状态与验收](../proposals/relay/relay-architecture.md#状态与验收)）。接受后取代议程 ADR-006（静止交接与 `public_context_rehydrate` 等级；现行实现是 `buildPublicContext` 把公共历史包成 JSON 信封注入），并按文末一节修订若干既有 ADR；proposed 期间不改它们的正文。

标注：【事实】有代码、契约、报告或实测出处；【实测】原型或评审在本机测得（Apple M5 Pro、Node 26.11.1、SQLite 3.53.4、git 2.54.0，全部合成数据）；【推算】未经实测的数字；【推断】由事实推出。“决定”一节都是本设计的建议。代码位置指基点 `07a0825`，当前工作树的 `src/`、`web/`、`tests/` 与它相同。

## 背景

### 用户的要求

2026-11-02 晚，用户原话（[讨论简报](../proposals/relay/00-brief.md)第 0 节）：

> 今晚先把接力做实，我也发现了这个问题，你需要重新设计一下接力系统，以及上下文的调度设计，参考市面上相关的 harness 的优秀实践思路，最新的论文，superagent 架构等等，想想如何适配我们的 harnesshub，设计出一个我们自己的接力系统。你必须反复迭代，设计，升级，搭建小组讨论。直到最后设计出一个完美架构，性能的接力系统。明早我验收。

验收对象是设计（架构、契约、性能目标、实施切片与测试计划），不是实现。接力对应产品的“能接力”承诺与需求 R08（上下文接续）、R09（独立切换）；“像原生”承诺要求只用一个 Harness 的用户感觉不到它。

### 现状与缺陷【事实】

第一轮内部基线 [R4](../proposals/relay/round1/r4-internal-baseline.md) 第 4.2 节列出缺陷 D1–D18；决定方向的几条如下（行号按当前工作树核对）：

- **交接只有对话正文，且整份注入。** `src/contexts/session/domain/context.ts:17–60` 的 `buildPublicContext` 把此前每个已终结 Run 的用户原文、附件名、回复正文与状态序列化成 JSON，前加一句英文说明（`:53–55`），作为用户消息正文发出；工具、文件改动、失败证据、计划与审批都不带（R4 D4、D7）。
- **长对话停摆。** 超过 `MAX_CONTEXT_BYTES`（1 MiB，`state.ts:16`）即 `CONTEXT_TOO_LARGE`（`context.ts:57–58`）。每回合先按全部历史构建一次（`runtime.ts:1334`），切换校验也构建全量（`runtime.ts:1570`），一次长回复之后同 Harness 续接、换人与 blocked 后恢复都会失败（R4 D3）。
- **派发即视为送达，欠交会丢。** 结算时只要已派发就把 `throughRunId` 推进到本轮（`runtime.ts:1496`）；回到原 Harness 时只补 `throughRunId` 之后的 Run（`:1337–1340`），首条若是原生目录里的斜杠命令就原样发送、不带增量（`:1393–1397`），另一 Harness 在中间做的工作从此补不进这个原生会话，违反 INV-14（R4 D1、D2、D11）。`throughRunId` 同时承担送达水位、精确分支（`runtime.ts:438`）与配置承接（`state.ts:392`）三种用途（[第二轮裁定](../proposals/relay/02-round2-rulings.md)致命缺陷 1）。
- **命令识别晚于授权，且与原生解析不一致。** 命令只认 `run.input.startsWith("/")`，而且在 `run.authorized`（`runtime.ts:1389`）之后才判（`:1393–1396`）。Hermes 先 `lstrip()` 再判，全角空格开头的 `/clear` 会被 Hub 当内容附上历史、被 Hermes 当命令执行（VF1-06；python3 的 `lstrip` 去掉 U+3000 与 U+00A0，node 的 `startsWith("/")` 不认，【实测】）。
- **分隔线不看送达。** `web/src/components/Turn.tsx:170–179` 的 `SwitchDivider` 在切换生效时就画“从这里起由 X”。
- **出境不脱敏，数据根在工作区里。** `RedactedHarnessControl` 只在受管 Provider 下包装（`src/infrastructure/session/binding-factory.ts:173`），web 入口固定 `providerManagement: false`（`src/cli/web.ts:38`）。数据根缺省 `resolve("data")`（`src/cli/session-application.ts:17–18`），工作区缺省 `process.cwd()`（`web.ts:32`）；`README.md:15` 与 `docs/HANDOVER.md:184–185` 记载的 4317 启动命令都把数据根放在工作区里，目标 Harness 读得到 `data/gateway.sqlite`（RT4 B1）。
- **停止未确认时待决切换悬挂。** unsafe 结束保留 `pendingSwitchId`（`runtime.ts:1488–1491`），`recoverable` 随即抛 `RECOVERY_UNAVAILABLE`（`:746–748`）（RT2-04）。
- **每次提交整份重写快照。** `src/infrastructure/session/sqlite-store.ts:343–363`；7.5 MiB 时受理到派发 1.25–1.41 s（R6【实测】），接力在这个规模下只占其中 2–5%（J2【推断】），所以存储优化另列前置片。
- **真实证据只有一组。** `README.md:5`：真实 Codex→Gemini→Codex 的同 Session 接续，模型端点是本地确定性服务。

## 证据

### 四轮讨论

| 轮次 | 做了什么 | 记录 |
|---|---|---|
| 0 | 主负责人读现有实现，写共享简报：用户原话、现状与缺陷、11 个设计问题 Q1–Q11、硬约束与成员守则 | [简报](../proposals/relay/00-brief.md) |
| 1 | 7 路并行调研（市面 Harness、论文、super agent 架构、内部基线、原生通道、性能与缓存、交接协议与体验），覆盖审查后补 R8（送达证据，源码级）与 R9（跨 Harness 外部证据与评测设施）；小结出 12 条共识、分歧 C1–C10 与 16 个走查场景 | [汇编](../proposals/relay/round1/00-digest.md)、[第一轮小结](../proposals/relay/01-round1-synthesis.md) |
| 2 | 4 个押注不同的方案（P1 账本优先、P2 原文保真优先、P3 推小拉大、P4 控制面优先）与 4 份评审 J1–J4；P4 平均 7.3 分最高，定为骨架，内容层取 P1 精简后的账本思路，渲染取 P2 的叙述化原文，水位取 P3 的“外来事实加 executedOn” | [第二轮裁定](../proposals/relay/02-round2-rulings.md)、[P4](../proposals/relay/round2/p4-control-plane-first.md) |
| 3 | 总架构师综合出第一版；5 份红队审查 RT1–RT5 共 105 条（blocker 21、major 57、minor 27），处置为修正 97、部分修正 8、反驳 0；按第一版数据模型做原型测量；修订出第二版 | [第一版](../proposals/relay/round3/v1-architecture.md)、[RT1](../proposals/relay/round3/rt1-invariants-storage.md)、[RT2](../proposals/relay/round3/rt2-failure-races.md)、[RT3](../proposals/relay/round3/rt3-performance-cost.md)、[RT4](../proposals/relay/round3/rt4-security-privacy.md)、[RT5](../proposals/relay/round3/rt5-native-fidelity.md)、[处置表](../proposals/relay/round3/v2-dispositions.md)、[第二版](../proposals/relay/round3/v2-architecture.md) |
| 4 | 3 份反驳核验（VF1 送达与水位、VF2 性能与可测性、VF3 原生体验、安全与隐私）与 1 份完整性审查（VF4）共 69 条（blocker 7、major 49、minor 13），处置为修正 63、部分修正 6、反驳 0；定稿为第三版 | [VF1](../proposals/relay/round4/vf1-delivery-watermarks.md)、[VF2](../proposals/relay/round4/vf2-performance-testability.md)、[VF3](../proposals/relay/round4/vf3-native-security.md)、[VF4](../proposals/relay/round4/vf4-completeness.md)、[处置表](../proposals/relay/round4/v3-dispositions.md)、[终稿](../proposals/relay/relay-architecture.md) |

过程说明与约束见[设计过程记录](../proposals/relay/README.md)：没有运行任何 Harness 会话，没有改用户配置，没有碰 4317 服务与 `data/`，没有读取用户对话。要求落实表与否决理由在终稿[第 18 节](../proposals/relay/relay-architecture.md#18-要求落实表)与[第 19 节](../proposals/relay/relay-architecture.md#19-被否决的方案推翻的裁定与理由)。

### 原型测量与本机实测【实测】

[原型](../../spikes/relay/README.md)（`spikes/relay/results.json`，编号 1a–7b、F1–F12）按第一版数据模型实现最小原型，第四轮在同一台机器上补测。影响设计的数字如下，全表见终稿“状态与验收”与[第 11.1 节](../proposals/relay/relay-architecture.md#111-目标表实测列为原型与各轮评审的本机数字目标按实测校准统计口径按-vf2-16)：

- RunDigest 抽取典型 p95 0.578 ms、最坏 1.779 ms，收紧后最大 31,581 B（原型 1a–1d）；逐字段上限之和 181,512 B，必须整体收紧到 ≤48 KiB（F8）。
- 标准档渲染含解析 3.84 / 4.29 ms（原型 2a–2d）；接近 64 KiB 的摘要全量解析 34 / 41 ms、+31.6 MiB（RT3），所以定档改读窄的索引列（RT3 按第一版约 200 B 的形状实测 0.04 / 0.08 ms；本版形状约 1,485 B、CHECK 2,048 B），本版形状的索引读并解析 256 行 0.77 / 0.89 ms（VF2）。
- 按第一版字面规则，256 Run 合成会话的必含块达 83,112 token（原型 3f、F1）：“用户原话不得省略”与“历史再长也只分层”不能同时成立。
- 脱敏不含熵规则 1.25 / 1.85 / 2.91 ms/MiB（原型 5a–5b），含熵规则 6.8–10.3 ms/MiB（VF2、RT3）。
- 工作区观测 495 文件 13.98 / 15.06 ms（原型 7a）；三段流水线 3k 文件 p95 38.2 ms、2 万文件 75.4 ms（VF2，热缓存、小文件）。第一版参数下 `diff --numstat` 对每个改动文件运行 clean 过滤器 2 次（原型 F3）；`-c filter.<n>.clean=` 对名字含 `=` 的驱动无效，`GIT_CONFIG_COUNT/KEY/VALUE` 写法 0 次（VF3，git 2.54.0）。
- 框架 token（o200k）：中文模板 448、填入来源说明后 498，英文 389 / 435；最小交接单的固定部分 770（o200k）/ 1,180（Claude 族），第二版的 `MIN_PACKET=600` 比它小（VF2-01）。
- SQLite：`INSERT OR IGNORE` 连 CHECK 违例一起跳过，随后的外键错误会让 Store failed；触发器拒绝 unknown→unknown 的同值写（VF4）。`fs.realpathSync` 不折叠大小写而 `fs.promises.realpath` 折叠（VF3，APFS）。

仍属推算的：档位常量（`TIER_CAP`、`USER_CAP`、`MIN_PACKET`、`FRAME_CAP` 的初值）、状态节上界、est/2 系数与 p90、首回合附加时延、缓存指标、unknown 率与重复率、冷路径与迁移时长、价格与悬崖判定、RelayBench 的样本量与预算、E1/E2 时延、观测的冷缓存与大文件表现。它们由 G070–G074 的基准与探针校准后再定。

## 决定

1. **范围。** 系统名 HarnessHub Relay，策略版本 `relay/1`（模板、转义表、脱敏规则与配置档、估算器系数、档位常量任一变化即升版）。本版纳入 P0 修复、存储优化前置片、业务库 v13、送达证据与两个水位、确定性交接单、界面与 API、RelayConformance 与 HH-RelayBench pilot，以及数据根检查、Driver 声明的厂商键与命令分类、原生标题回写与 process 型的“继续原会话”。不纳入：账本取代图与词表抽取、保真默认档、拉取通道（v1.1 文件视图、v1.2 stdio MCP）、交出方说明的默认开启、建议交接、WorkBuddy 作为目标、gateway 型 unconfirmed 绑定的只读核对打开、默认数据根移出工作区与命令指纹改 HMAC（终稿[第 0 节](../proposals/relay/relay-architecture.md#0-摘要)“本版范围”、[第 15 节](../proposals/relay/relay-architecture.md#15-演进)）。

2. **原生位置与送达水位是两个事实。** `throughRunId` 只表示原生位置；送达水位 `DeliveredMark` 是有正面证据或亲历的上界。每个原生绑定带 `BindingRelayState`：`nativeEpoch`（在同一 (harnessId, controlId) 的全部绑定上单调递增）、清空下限 `epochFloor`（随绑定谱系保留）与 `fresh / synced / pending / suspect` 四种同步状态。外来事实只取已派发、已终结、`executedOn ≠ (X, e)` 的 Run，以及 `originIncluded=false` 时的分支或接续来源历史；未派发的 Run、命令回合、本绑定本纪元的 Run 都不是外来事实；need 的下界恒为 max(mark, epochFloor)。状态 × 事件全表没有未定义的格（[第 2 节](../proposals/relay/relay-architecture.md#2-术语定稿)、[第 4 节](../proposals/relay/relay-architecture.md#4-数据模型typescript-草案)、[第 7.2 节](../proposals/relay/relay-architecture.md#72-同步状态转换表状态--事件rt1-m3本版补全到没有未定义的格vf1-02vf1-04f03)）。

3. **只凭正面证据推进水位。** E1 实时事件、E2 按派发前记录的核对位置事后核对、E3 结算推断、native 亲历才推进；没有证据记 unknown，只有 Driver 确知未发出才记 not_recorded，核对“没找到”只记 `unknown{absent}`；pending 只核对待核的那份包自己；正面证据可把 unknown 与 not_recorded 纠正为 recorded。送达结论存独立表 `relay_deliveries`，与回合终态无关，不写进已终结的 Run。每包自动重发至多 1 次，声明 `lateDelivery` 的 Driver 0 次；不能自动重发时，下一条内容输入在受理时同步得到 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}`，由用户选［再附一次］［只发这条消息］［新开原生会话］（D1）。任何回合都不自动重跑（INV-11）（[第 7.1 节](../proposals/relay/relay-architecture.md#71-证据与能力声明)、[第 7.4 节](../proposals/relay/relay-architecture.md#74-命令回合清空与回退标记缺失unknown-重发)）。

4. **像原生：外来事实为空时零注入。** 从未交接、或清空后未选“附上”的绑定，收到的每条输入与用户原文逐字节相同；用户选“只发这条消息”（`relay.attach:"none"`）时同样逐字节相同，且不产生证据、不改水位。命令回合原样发送、从不捎带；分类由 Driver 的 `commands.classify` 复刻原生解析（前导空白、注册表与别名、路径排除），受理时按静态声明预分类，open 后复核，不符即 `RELAY_PREPARE_FAILED{reason:"classification_changed"}`；命令效果只在实际执行时生效。用户清空按原生语义：Driver 经 `BackendResult.native.cleared` 确认（Hermes 固定回执、OpenClaw `sessions.get` 见新会话、Claude 由 Driver 合成 `session/new`）后进入新纪元并写 `epochFloor`；确认不了即 `suspect{clear_unconfirmed}`，下次回放核对后才生效；“附上交接单”是只对下一条生效的 `relay.attach:"full"`（第 7.4 节）。

5. **内容是公共事实的确定性投影，切换路径上不调用任何模型。** 每个已终结 Run 一条 RunDigest（收紧后 ≤48 KiB，与 `run.ended` 同事务、在 SAVEPOINT 内写入，只由已提交的公共事实生成、可重建）与约 1.5 KB 的索引列（CHECK 2,048 B），定档只读索引。交接单 `kind ∈ {packet, delta, anchor, resend}`，由两遍确定性折叠生成：整段叙述化历史放得进档位就整份照录（`complete=true`），放不下就分层（逐字、精简、单行、区间行），并附满足“已渲染 + 已省略 + 未统计 = 全部”的省略账目。ID 为 `relay-` 加 20 位 Crockford base32(sha256(ID 槽为占位符的最终正文))，同一输入渲染出的字节相同（[第 5.1 节](../proposals/relay/relay-architecture.md#51-交接单各节字段与来源规则)、[第 5.4 节](../proposals/relay/relay-architecture.md#54-框架措辞固定模板全文)、[第 6.3 节](../proposals/relay/relay-architecture.md#63-内容选择算法两遍确定性折叠)；目标看到的全文见[第 5.6 节](../proposals/relay/relay-architecture.md#56-样例全文)）。

6. **用户原话有预算，当前输入永远原样。** 当前输入不裁剪、不脱敏；其后依次是开场请求、钉住、附言与最近的用户消息（从新到旧逐字，预算 U：标准 2,500 / 精简 1,500 / 只交目标 1,000 / 增量 1,000 / 要点 400 token【推算】，超出部分按轮次计数）、失败证据、最近一轮回复、更早的回合。模型与工具写的文本合计受不可信上限约束：只交目标 0.15·T、精简与标准 0.375·T、保真 0.5·T、完整 0.75·T。布局是两段 text：第一段依次为首行（原话前 ≤200 字）、标题行 `〔HarnessHub 交接单 {packetId}〕` 与来源说明、用户原话、7 条阅读约定、各节、未包含与结束行；第二段是用户原话全文，一字不改（D4）（[第 5.3 节](../proposals/relay/relay-architecture.md#53-逐字保留的优先级用户原话预算与不可信文本上限)、[第 5.5 节](../proposals/relay/relay-architecture.md#55-布局c3-裁定按-rt5-18-与原型-f6-修订)）。

7. **预算只降档，不因历史长度阻断。** 默认档 standard 的上限 T ≤ min(8,000 token, capWindow, 通道上限折算)【推算】，capWindow 取“窗口的 5%”与“窗口减去目标固定前缀、当前原话和 4,096 余量”中较小的一个；hardCap 只看通道与窗口；费用、时延与价格悬崖只在 standard、brief、goal 之间降档，订阅或认证方式未知时不用美元上限；外来事实为空或 `attach:"none"` 时不调用预算解析器。只有 `hardCap < MIN_PACKET[族]` 时才 `RELAY_INPUT_LIMIT`，在受理时按保守窗口判定并提供“只发这条消息”（D2）；`MIN_PACKET` 由构建期渲染的最小交接单按目标族生成并写进 `policyVersion`（o200k 族约 900、Claude 族与未知族约 1,350 token【推算】）。长历史不再报 `CONTEXT_TOO_LARGE`（[第 6.2 节](../proposals/relay/relay-architecture.md#62-预算解析器伪代码)）。

8. **调度时序。** 切换生效时不组包、不做预算。`send()` 受理时由 `coordinator.admit` 同步预检：目标取 `pendingSwitch?.target ?? selection`，命令先预分类并跳过其余检查；接力检查只对将要携带接力内容的回合做（need≠∅、用户选了 `attach:"full"`，或存在外来事实而绑定待核且受理前无法核对），依次查探针门控、（跨厂商时——任一来源的厂商键与目的不同即算——）数据根、需要的用户选择、厂商同意与 `MIN_PACKET`，缺项同步返回，不建 Run、不启动程序；need=∅ 的回合与单 Harness 对话不做任何接力检查、永远不被接力阻挡；排队的 Run 在 `prePlan` 重做一次。`finalize`（核对、精化窗口、渲染、脱敏、同意复检）在 open 之后、`run.authorized` 之前；`run.context_prepared` 与 `run.authorized` 合并为一个事务，每回合比现状少一次整份快照提交。工作区观测在租约之后与启动并行，硬上限 250 ms。E1 先冲刷打开的文字窗口，再与送达结论、绑定变更同事务落库；分隔线只在送达证据之后出现（[第 6.1 节](../proposals/relay/relay-architecture.md#61-时序)、[第 3.2 节](../proposals/relay/relay-architecture.md#32-依赖方向与接口)）。

9. **通道与 Driver 声明。** 本版只用已在生产中的用户消息通道。每个 Driver 导出静态 `RelayCapabilities`，只描述机制、不出现产品名，缺项按最保守值；Runtime 不按产品名分支。生产只对 `probed=true`（P2、P3、P6、P11 在最新正式版通过）的 Driver 开放接力，开发与测试经 `relay.allowUnprobed`（默认 false）放开（D11）；未探针的目标与 WorkBuddy 受理即 `RELAY_TARGET_UNVERIFIED`，只提供“只发这条消息”。因交接新建的会话在首个提示之前回写原生标题（Codex `thread/name/set`、Claude `_session/rename`，Hermes 代发 `/title`，D3），标题先过出境脱敏；OpenCode、dsh 在 P13 通过前列为“未保证”。七家逐家的放置、证据、命令、厂商键与回退见[第 8.1 节](../proposals/relay/relay-architecture.md#81-七家逐家的组合与回退)，v1.1、v1.2 增强通道的启用条件见[第 8.2 节](../proposals/relay/relay-architecture.md#82-v11-与-v12-增强通道的启用条件与探针)。

10. **出境安全**（[第 10 节](../proposals/relay/relay-architecture.md#10-安全与隐私)）。
    - 脱敏：已知秘密按变量名定集合，匹配 10 种形式，在骨架视图上匹配，ANSI 序列先整段删除；再加形状规则（display、diagnostics、egress 三个配置档，单一规则源，经 `SecretScannerPort` 注入领域层）；命中写成 `〔已脱敏 · 类别 · #标签〕`，标签取按会话派生的 HMAC 子密钥；摘要记录命中区间、不记值。当前输入（第二段）除外。
    - 数据根：数据根、HMAC 密钥与工作区按 `(st_dev, st_ino)` 互不包含是跨厂商交接的前提，包含时受理即 `409 RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`，同厂商与单 Harness 对话可继续并在界面告警；密钥与附件物化目录在数据根之外（D5）：附件物化目录按会话建（0700、名字不可猜测），保留 ADR-023 的稳定只读副本语义，随会话删除，不再每个 Run 一个目录。
    - 标识与指纹：交接单 ID 只由正文派生，正文不变时 ID 与清单不变；逐 Run 的同意 seq、输入指纹与脱敏上下文记在送达行；`relayRequest.fingerprint` 等凡可能对应秘密的指纹一律用 HMAC 会话子密钥；API 返回的是存储的正文（发出时的字节），不在返回时复扫，`ETag` 为存储正文的 sha256，出境扫描只在为发送而渲染时做一次。
    - 注入：记录区包在内容派生的 `<<<HH-DATA b BEGIN>>>` 与 `<<<HH-DATA b END>>>` 之间，`〔〕` 只留给 Hub，引用槽「」不可闭合，模型、工具与工作区写的文本不升格为用户原话或 Hub 口吻；批准不跨 Harness 继承。
    - 同意：按 Driver 由它自己解析的端点声明的目的厂商键，权威记录在安装级 `relay_log`；受理时预判，finalize 按 open 后观测到的端点复检（不符即 `RELAY_CONSENT_REQUIRED{reason:"vendor_changed"}`），`run.dispatched` 的事务里再读一次，已撤回就不派发；本纪元内厂商键变化须重新同意；`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`，端点来自工作区文件时每个会话都问；同一厂商的 account 与 api_key 同记一个键（D7）。

11. **返回原 Harness。** A→B→A 时先按待核状态核对，再在同一原生会话补发增量（从未收过交接单的绑定发附全部约定的无基准增量）；默认续接原会话，全程费用差 ≥ $0.10、时延差 ≥10 s 或 N/W ≥0.85 时并列显示“新开并附交接单”（D9），从不静默改等级；费用与时延只用于显示与默认档的降档建议（[第 7.3 节](../proposals/relay/relay-architecture.md#73-aba-算法)）。

12. **分支、导入、重建与合成清空。** 原生分支只在精确位置建立：`throughRunId === through.id`、through 之后同一 harness/control 没有派发过的 Run、位于当前纪元、源绑定 synced 且 need(through)=∅。接续本机会话的绑定记 `synced{throughSeq: 0, basis: origin, lastPacketId: null}`，回放先经 Driver 的 `userTextOf` 剥原生包装，Hub 的交接单按“标题行 ID + 正文一致”识别。native-reset 的新绑定 `fresh{reset}`、继承 `epochFloor`、`nativeEpoch` 取已有最大值 +1。Claude 的合成清空在 `run.ended` 里归档旧绑定、新建继承 `observed` 的绑定。配置承接改读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 `input ≠ not_recorded` 的 Run（[第 7.5 节](../proposals/relay/relay-architecture.md#75-分支导入重建)）。

13. **界面与 API。** 选择器只定档、不渲染、不启动程序；交接卡默认一行，可展开看逐字原文、按轮排除、钉住、加附言、逐项放行误判的密钥；首次跨厂商时内联说明，发送按钮改为“发送并交给 Codex（OpenAI）”，Enter 只展开说明、不算同意；主标签用“继续原会话 / 新会话 / 原生分支 / 接续本机会话 / 上下文已清空 / 无法接续”，送达状态单独显示；费用在 API key 下显示美元，订阅或认证方式未知只显示 token。API：`POST …/messages` 增加 `relay?: RelayRequest`（选项进命令指纹），新增 `/api/v1/sessions/:id/relay` 系列（“核实厂商”经 `POST …/relay/observe`，它会启动目标程序，所以是写请求）、`/api/v1/relay/consents` 与 `/api/v1/relay/prefs`（四个键），SSE 推 `relay.input_recorded`、`relay.verified`、`relay.vendor_changed`；HTTP 状态：`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE`、`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED` 为 409，`RELAY_INPUT_LIMIT` 为 429；`public-api.md` 写明 409 只覆盖受理时可判定的情形。界面文案与无障碍名统一称 Harness，用词检查扩到全部界面字符串（[第 12 节](../proposals/relay/relay-architecture.md#12-体验)）。

14. **存储：业务库 v13。** 新增 11 张表与 4 个触发器（[第 14.1 节](../proposals/relay/relay-architecture.md#141-v13-ddl与-sessionsevents-同库由-transact-在同一事务写入均为-strictcheck-只作-bug-断言上限在应用层按序列化字节先校验先截断)）：正文按 (session_id, sha256) 存在业务库的 `relay_bodies`（不进内容存储，避开 7 天回收）；`relay_packets` 不可变，清单只含由正文决定的字段，逐 Run 的同意 seq、输入 HMAC、送达位置与压缩游标在 `relay_deliveries`；以 `INSERT … ON CONFLICT DO NOTHING` 入库。行上限与送达转换先在应用层按序列化字节与允许表校验，CHECK 与触发器只作断言，派生行在 SAVEPOINT 内。不经快照的写入路径：`relayWrite`（不升 version）、安装级的 `appendRelayLog`、`upsertWindow`、`setPref`。新增 11 个事件（`relay.input_recorded`、`relay.verified`、`relay.pin_added`、`relay.pin_withdrawn`、`relay.exclusion_added`、`relay.exclusion_withdrawn`、`relay.consent_recorded`、`relay.consent_revoked`、`relay.redaction_overridden`、`relay.vendor_changed`、`relay.title_set`），扩展 `run.context_prepared`、`run.ended`、`run.native_command`、`message.accepted`、`switch.*`、`session.recovered`；每次交接新增事件 ≤3 条（请求带 `relay.consent` 时另加同意镜像 1 条），普通回合 0 条（[第 14.2 节](../proposals/relay/relay-architecture.md#142-事件清单与幂等键)）。

15. **不变量**（[第 14.3 节](../proposals/relay/relay-architecture.md#143-不变量的增改改写-inv-13142122293033新增-inv-3132343536其余-inv-0128-不变)，每条都有计划用例）。编号以仓库 `docs/domain/invariants.md` 为基准：它现有 INV-01–28，INV-29–36 都是新增（其中 INV-29、30、33 相对本设计的第一、二版草案改写过，终稿表中标“新，相对第二版改写”）。

    | ID | 要点 |
    |---|---|
    | INV-13（改） | 交接单不可变、ID 只由正文派生，正文不变则 ID 与清单不变；`relay_packets` 的清单只含由正文决定的字段，逐 Run 的同意 seq、当前输入指纹与脱敏上下文（规则版本、keyId、集合 HMAC）在送达行；写入时校验 fold 单元已终结且其用户消息早于当前输入 |
    | INV-14（改） | 已知事实由当前纪元的送达水位与 `epochFloor` 共同决定，下限随绑定谱系保留；配置承接读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 input≠not_recorded 的 Run；clear 经 Hub 确认才进新纪元；pending 只核对待核的那份包；待核绑定只在 cause ∈ {legacy, marker_absent} 且 need=∅ 时放行，没有外来事实的单 Harness 对话不核对也不阻挡 |
    | INV-21（扩） | 切换生效与交接送达分别表达；准备失败不派发、relay 状态不变（不建交接单行、送达行与 pending，水位不被这次准备推进；open 时的回放核对结果是事实，照常提交），open 后失败时原生会话与绑定按第 9 节保留；停止未确认时待决切换失败而不悬挂 |
    | INV-22（改） | 保留原有两句“配置与原生状态不能替代公共事实源；读模型可重建”，接力条款作为补充：同一 `policyVersion` 与同一脱敏上下文下可逐字节重建；摘要记录命中区间，重建先套区间再扫当前集合 |
    | INV-29（新） | 跨 Harness 发出的内容先经已知秘密精确匹配（按名定集合、10 种形式、骨架视图、ANSI 先删）与形状规则脱敏，当前输入（第二段）除外（出境字节一句同样除外）；扫描器出错即不发；接力表、事件与日志不含秘密原值及其未加盐哈希，指纹一律用 HMAC 子密钥；钉住按位置存、不存原文 |
    | INV-30（新） | 外来事实为空的绑定逐字节原样；`attach:"none"` 的回合逐字节相同且不改水位；携带包时第二段等于原话；每个原生纪元至多一份完整交接单（前一份 not_recorded、unknown 待核或用户再附除外）；同一纪元内 mark 只在 suspect 回退时变小，确认的清空进入新纪元 |
    | INV-31（新） | 一个 Run 至多携带一份交接单；送达结论只由逐回合证据决定；正面证据可纠正 unknown 与 not_recorded；同值写不算转换 |
    | INV-32（新） | 没有照录的可交接事实必须计入省略账目并给出取回位置，或写明“不可取回”“未统计”；恒等式成立 |
    | INV-33（新） | 没有目的厂商键的同意记录不发历史；厂商键由 Driver 按机制与它自己解析的端点声明；`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`；工作区文件来源的端点每个会话都问；目的厂商指主模型请求的实际处理方；登记过的唯一例外：`local`（回环端点且不转云端）在用户标记“本机模型不出网”（`relay.localModelsOffline`）后免同意 |
    | INV-34（新，v1.2 生效） | 按会话注入的工具在建会话时固定，规格零凭据、只读 |
    | INV-35（新） | relay 行上限与转换在应用层先校验；预期内的接力失败只让本 Run 失败，不让 Store failed、Runtime fatal 或波及其他会话；SQLite 约束错误仍是 bug |
    | INV-36（新） | 数据根、HMAC 密钥与工作区按 `(st_dev, st_ino)` 互不包含是跨厂商交接的前提；附件物化目录与密钥不在数据根内 |

    `assertSessionTransition` 增加：`epochFloor` 只增不减；同一纪元内 `mark.throughSeq` 只在 suspect 回退时变小，且不低于 `epochFloor`（确认的清空进入新纪元）；写者 Run 的 `run.ended` 带 `native.cleared` 时允许“归档旧绑定 + 新建同 harness/control 绑定”，不要求 native-reset 命令；每条规则各配一个无效样例（G066-C06）。

16. **实施切片**（[第 17 节](../proposals/relay/relay-architecture.md#17-实施切片)，写到可以直接登记进 `plan/tasks.json`）。

    | 任务 | 内容 | 依赖 |
    |---|---|---|
    | G066 | v13 接力存储、契约类型与迁移 | C006、G004、G008、G028、G067 |
    | G067 | P0 过渡期修复（v12，不升库） | G004、G006、G007、G028、G032、G034 |
    | G068 | 送达状态机、核对与恢复 | G066、G067 |
    | G069 | Driver 接力适配 | G066、G067、G007、G032、G034 |
    | G070 | 内容：摘要、渲染、预算与脱敏 | G066、G006、G010、G026 |
    | G071 | 工作区观测器 | G066、G026 |
    | G072 | 接力协调器与返回决策 | G068、G069、G070、G071、G059、G075 |
    | G073 | 界面、API 与用词检查 | G072、G050、G054 |
    | G074 | 验收设施：RelayConformance、RelayBench 与故障矩阵 | G072、G073、G060 |
    | G075 | 存储优化前置片 | G008、G028 |
    | G076 | v1.1 增强通道（deferred） | G074 |
    | G077 | v1.2 stdio 接力 MCP（deferred） | G076 |

    旧议程：C006 改写为本设计的契约任务（交接单清单与送达行的 JSON Schema、S1 样例，接管 context-transfer、switching、storage-events、public-api、security 契约与 invariants）；G006 保留；G056 保留、范围缩小；G024、G025、G045、G046 改为 deferred，分别由 G070、G068、G072、G072 与 G073 接管。顺序：G075 与 G067 不升库，可先发；G066 之后 G068–G071 可并行；G072 集成；G073、G074 收尾；G076、G077 等探针与独立 ADR。

## 被否决的方案与理由

| 被否决 | 理由 |
|---|---|
| 账本优先的 16 种条目、取代边与词表抽取（P1） | 词表误抽的“决定”是伪造的事实，取代逻辑出错会静默丢事实；RelayBench-X 精度 ≥0.8 之前不进默认 |
| 保真档（16k）作默认、记录文件作第二条写路径（P2） | 生命期费用翻倍、首回合约多 2 s；用户角色里 16k 模型文本的权威抬升面最大 |
| v1 就做拉取，shim 由 Hermes 网关持有或放在数据根下（P3） | 资源所有者不清（INV-26）、跨 Harness 沙箱逃逸；拉取通道推迟到 v1.1、v1.2 的探针之后 |
| 标记缺失即判分叉、自动新开原生会话（P4） | 压缩后旧行必然缺失，会丢掉 A 自己的原生上下文；绑定从不被静默替换 |
| 清空后自动灌回完整交接单（P1、P3、P4） | 单 Harness 用户在 Hub 里永远得不到空白上下文 |
| 模型写的摘要作默认内容；复述作默认确认 | 不能静默使用用户没选的模型，模型自评不作证据；复述破坏像原生，还可能把漏网内容复写进回复再转发 |
| 回环 HTTP + bearer 的接力 MCP | Claude 把 MCP 规格放进 argv；后台沙箱曾不通 loopback |
| 未加盐 sha256 作脱敏标签、放行记录或 relay 字段里的指纹 | 低熵秘密可离线验证；一律改用按会话派生的 HMAC |
| 费用、时延与价格悬崖进 hardCap（第一版） | API key 登录且 R/k 高的 Claude 目标、上下文 ≥68k 的 Haiku 绑定与 16–32k 的本地模型都会 blocked；改为只降档（O2） |
| 用户原话“不得省略”的必含块（J3 M8 字面） | 必含块可达 83,112 token【实测】，与“历史再长也只分层”冲突；改为预算 U 从新到旧保留、按轮次计数，且在放入任何回复文字之前先用满（O3） |
| 送达未确认时原样发送、状态不变；脱敏第二段 | 前者是静默降级（D1）；后者与“一字不改”冲突，当前输入没有 Run，无法按位置放行（D4、O8） |
| gateway 型的“继续原会话”、unconfirmed 绑定的只读核对打开提前到本版 | 查看器退出不是静止证据；改动 INV-12（未确认停止/写权隔离前不能让新执行者写同一工作区）的恢复路径需要独立 ADR 与探针 P-R1、P-R2，留到 v1.1 |
| v13 在首次打开时惰性迁移；不丢数据的降级导出 | 前者与“快照版本须等于库版本”及写者规则冲突；后者是一套新的持久格式转换工具，备份恢复已满足 ADR-049 |
| 本版改默认数据根；本版把命令指纹改为 HMAC | 前者改变现有部署（4317 服务）的数据位置（D8、Q9）；后者是接力范围外的既有幂等机制，登记为已知违例（Q19）；各自另立 ADR |

推翻或改造的早先裁定 O1–O12 见终稿第 19 节；第四轮 6 条部分修正的未采纳部分见[第 18.1 节](../proposals/relay/relay-architecture.md#181-红队发现105-条)。

## 失败边界

每种情形的所有者、上限、失败结果与用户所见见终稿[第 9 节](../proposals/relay/relay-architecture.md#9-失败与边界)，资源的所有者、上限与关闭入口见同节的清理所有者表（INV-26）。要点：

- **错误码按阶段。** 只有将要携带接力内容的回合才会遇到这些错误码。受理时（同步返回，不建 Run、没有进程）：`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE{data_root_in_workspace | consent_log_full | recovery_failed}`、`RELAY_CHOICE_REQUIRED{marker_absent | verify_required | delivery_unconfirmed}`、`RELAY_CONSENT_REQUIRED{missing | vendor_changed}` 为 409，`RELAY_INPUT_LIMIT` 为 429。启动前（`prePlan`）：排队 Run 以同一组错误码失败，没有进程，绑定不变。open 之后：`RELAY_PREPARE_FAILED{…}`、`RELAY_CONSENT_REQUIRED{vendor_changed | revoked}`、`RELAY_INPUT_LIMIT`、`RELAY_CHOICE_REQUIRED` 让 Run 失败、未派发，原生会话与绑定保留（新建的空会话下一次按它 resume），relay 状态不变，错误经 `run.ended` 与 SSE 到达。`NATIVE_STATE_UNCONFIRMED` 沿用。【事实】`src/web/server.ts:265–266` 的现有映射已覆盖含 `LIMIT`（429）、含 `UNAVAILABLE` 与以 `_REQUIRED` 结尾（409）的码；`RELAY_TARGET_UNVERIFIED` 不匹配任何规则、会得到 502，终稿第 12.4 节要求实现时为它显式加 409 映射（`server.ts` 由 G073 经其所有者 G050 修改）。
- **准备失败**（渲染出错、脱敏失败、字节越界、缺少同意、厂商变化、分类不符、精化窗口过小）：不派发，relay 状态不变（INV-21）；脱敏 fail closed；切换已生效时界面写“已切换到 Codex，但没能交接：原因。这条消息没有发出，草稿已保留”，提供［重试］［改回 Claude Code］［只发这条消息（不附交接单）］；重试时同一句原话只出现一次。
- **结果未知**：会话 blocked（现有），恢复切换须显式确认并记入 `acknowledgedUnknown`，不自动重跑（INV-11）。process 型 Driver 在 Hub 确认该回合的进程组已结束后可“继续原会话”（D6，P16 门控，确认不了仍是 `RECOVERY_UNSAFE`）；gateway 型（Hermes、OpenClaw）的查看器退出不是静止证据，绑定保持 unconfirmed，返回原 Harness 须 native-reset。
- **停止未确认**：unsafe 的 `run.ended` 在同一事务里把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`、等待它的排队 Run 记为 `SWITCH_NOT_EFFECTIVE`，之后走 blocked → 恢复切换。
- **Hub 中途重启**：`recoverSession` 语义不变；领域纯函数 `recoverRelay` 在 `claimAndRecover` 的同一事务里按会话 SAVEPOINT 写入：没有 `dispatchedAt` 的 → `not_recorded{never_dispatched}`、绑定回到 prior；已派发的 → `unknown{owner_ended}`、保持 pending；已 recorded 的不改。一个会话写失败只把它标为 `relay_recovery_failed`（快照字段 `SessionSnapshot.relayRecoveryFailed` 记该次 `session.recovered` 的 seq）并在之后将要携带接力内容的回合受理时返回 `409 RELAY_UNAVAILABLE{reason:"recovery_failed"}`，不让 `claimAndRecover` 整体失败。
- **派生写入失败**：SAVEPOINT 回滚，RunDigest 标 behind 并异步补建，`run.ended` 照常提交；超长钉住、2 万文件、字段打满的中文摘要、扫描器异常与同值写都不得让 Store 进入 failed（INV-35）。
- **容量与环境**：交接单正文结构上界 64 MiB/会话（256 包 × 256 KiB），触顶 `RELAY_PREPARE_FAILED{reason:"storage_quota"}` 并提供“只发这条消息”；`relay_log` 达到 65,536 行时同一事务轮转到 `relay_log_archive`，仍满即 `409 RELAY_UNAVAILABLE{reason:"consent_log_full"}`；工作区观测失败或超时记 `unavailable`、状态节写“工作区未核验”，不阻塞；窗口未知时按 128k（网关、路由方与本地模型 32k）估算并注明；数据根在工作区内时启动告警、该工作区的全部会话在界面告警并在首次发送时要求确认。

## 测试与真实验收配方

- **设计验收**：读终稿“状态与验收”与第 0、5.6、[16](../proposals/relay/relay-architecture.md#16-场景走查) 节，对 D1–D11 逐条拍板（不拍板即按推荐项）；第 17 节的任务登记进 `plan/tasks.json` 后由 `python3 -I tools/check_design.py` 核对所有权与用例，每个 INV 至少一条计划用例。
- **每片的测试**：一律用真实的 `SqliteSessionStore`、`LocalContentStore` 与走 stdio 的 `tests/fixtures/control-peer.mjs`；用例逐条登记在第 17 节（从 G066-C01 起，每条写明层级与文件）；新增的检查（送达表触发器、`assertSessionTransition` 的新规则、用词检查脚本）各配无效样例。
- **HH-RelayBench X**（[第 13.1 节](../proposals/relay/relay-architecture.md#131-x抽取与渲染确定性进-ci0)；确定性，进 CI，$0）：改动文件召回 ≥0.98（git）/ ≥0.90（非 git）；命令与退出码、失败 1.0；省略账目恒等式 100%；确定性 100/100；增量折叠与重建一致 500/500；est/2 对冻结计数夹具的整包误差 p90 ≤20%；脱敏夹具漏检 0、形状规则召回 ≥0.98、误报 ≤1%；转义模糊 10,000 例零违例；RT4 的 RD、IN、WS、CS、IM、DG、AP 用例全部通过并各附无效样例；≤256 Run 任意档位不 blocked；确定性故障注入矩阵（Driver 声明 × 证据序列 × 崩溃点 K1–K18）重复注入 0、丢增量 0。
- **性能**：CI 只断言计数类量（提交次数、事件数、扫描字节、过滤器执行次数、漏检数）与确定性；毫秒目标在参考机上跑、结果写进验证记录，不作 CI 门槛（第 11.1 节，每行标明实测或推算）。
- **HH-RelayBench Q**（[第 13.2 节](../proposals/relay/relay-architecture.md#132-q续做质量harbor-离线校准内容策略r9-配方)；Harbor 离线校准内容策略，用真模型，不进 CI）：36 题、每题 2 个交接点共 72 个实例，另加 8 道长会话针尖题；pilot 约 288–384 次接手、$20–55【推算】；v0 只作 −10 pp 初筛，正式采纳需 ≥300 配对、−5 pp（D10），预算另批；独立凭据、消费上限，`tests/real/guard.ts` 前后比对。
- **RelayConformance**（[第 13.3 节](../proposals/relay/relay-architecture.md#133-e2erelayconformance真机正式-gateway-入口确定性)；真机，经正式 Gateway 入口，确定性判定）：六家（WorkBuddy 未接入）在临时 git 工作区跑 P1–P14；P15 真机零注入（从原生转录读回每条输入，断言与原文逐字节相同）与 P16 process 型继续原会话只在 Claude、Codex 上跑（P15 各 20 轮）；另加三组 A→B→A 与 gateway 型的“查看器被杀、网关继续”只读确认探针。用最便宜的模型，约 24 回合、每家 $0.5–2.5、六家 ≤$15【推算】；真机探针不用用户凭据，结束即删工作区、只留清单与日志；结果写入 `docs/verification/relay-conformance-<日期>.md`；每家 P2、P3、P6、P11 通过后翻转 `probed=true`；每个最新正式版重跑（ADR-053）。
- **报告**：每片证据分“代码完成 / 测试通过 / 真实引擎通过”三栏。需要真机核实的点 Q1–Q24 见终稿[第 20 节](../proposals/relay/relay-architecture.md#20-未决问题与需要真机核实的点)。

## 迁移与降级

- **过渡期（G067，不升库）**：v12 只有 `throughRunId`，它继续表示原生位置，推进规则写死为 `advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ 已重发一次))`，“已重发一次”由 `run.ended.data.relayResendOf` 推出：单 Harness 下任何已派发回合都推进，due≠∅ 时命令回合不推进。`BackendResult.input` 为瞬时字段、持久化前剥离，`run.ended` 事件保留 `input`、`contextEffect` 与 `relayResendOf`，供 v13 迁移作直接证据。已知局限写进发布说明、由 v13 关闭：清空、回退与效果未知的命令在 v12 只记 `contextEffect`、不改水位；v12 没有纪元；切到新目标后的首条仍可能 `CONTEXT_TOO_LARGE`，此时提供“只发这条消息”（[第 7.6 节](../proposals/relay/relay-architecture.md#76-v12-过渡期的推进规则p0不升库)）。
- **升到 v13（G066）**：迁移前备份的条件从 1–11 改为 1–12，owner 版本改为 13（ADR-049）；迁移在一个事务里建第 14.1 节 DDL 的 11 张表与 4 个触发器，快照升到 13，v12 快照照常可读。按来源推断每个绑定的 `relay`：导入与分支绑定 `synced{throughSeq: 0, basis: origin, lastPacketId: null}`；对每个 (harnessId, controlId) 按事件顺序重放纪元谱系（每个 `binding_prepared{resumed:false}`、native-reset 与归档各开一段，段内每个已执行的清空类命令再加 1）；其余绑定按携带回合推断为 `synced{basis: legacy}`、`suspect{cause: legacy}` 或 `fresh{user_cleared}`。属性测试：迁移后水位只降不升、纪元跨绑定单调、单一 (harness, control) 的 v12 会话迁移后 20 轮 `dispatched === input`（[第 14.4 节](../proposals/relay/relay-architecture.md#144-迁移与降级adr-049)）。
- 历史 RunDigest 不回填，标 `behind` 后按需懒重建；新 Run 不再写全量 `sourceRunIds`，解析器同时认旧数据。
- **时长与空间**：按 seq 直接扫描 events 表；在合成 ≥1 GiB 事件库上实测后决定是否按会话分批（仍在开始服务之前完成）；WAL 加备份约需两倍库大小的空间，写进 ADR-049 的补充。
- **降级**：没有原地脚本；v12 构建遇 v13 以未知版本拒绝；按 ADR-049 手动恢复备份（停服、替换 `gateway.sqlite`、删 `-wal` 与 `-shm`、用旧构建启动）。恢复即回到升级那一刻：之后的对话、Run、消息都会丢失，它们引用的附件与详情 7 天后被内容存储回收；迁移失败整笔回滚、备份保留。不提供不丢数据的降级导出。

## 用户拍板的取舍

2026-11-03 用户按推荐项全部接受（原话：“按推荐接受”）。下表保留各项的推荐、另一选项与代价。

| # | 取舍 | 推荐 | 另一选项与代价 |
|---|---|---|---|
| D1 | 送达未确认、自动重发已用尽（或 Driver 声明 `lateDelivery`）时的下一条消息 | (a) 受理时同步 409，让用户在［再附一次］［只发这条消息］［新开原生会话］中选，只多一次内联选择 | (b) 原样发送、状态不变：目标缺上下文而 Hub 仍记欠交，是静默降级 |
| D2 | 小窗口目标在启动前失败 | (a) `MIN_PACKET` 按目标族取最小交接单（Claude 族约 1,350 token【推算】），窗口低于约 27k 的目标在启动前 `RELAY_INPUT_LIMIT` 并提供“只发这条消息” | (b) 只在 W<12k 时失败、接受启动之后才失败：违反 K8，目标已启动 1.3–5 s 才报错 |
| D3 | Hermes 原生标题 | (a) Driver 在首个交接回合之前代发 `/title <公共标题>`（Hermes 本地作答、不进回放、不提交网关回合），由 P13 断言回放行数不变、网关无新回合；翻转第二版的否决 | (b) 不代发，标题由模型按前 1,000 字生成 |
| D4 | 当前输入里的疑似密钥 | (a) 第二段永远原样，卡片提示“这条消息里有 1 处像密钥的内容，会原样发给 Codex” | (b) 脱敏第二段：与“一字不改”冲突，当前输入没有 Run 无法放行 |
| D5 | HMAC 密钥与附件物化位置 | (a) `relay-key` 放在数据根之外（macOS：`~/Library/Application Support/HarnessHub/relay-key`）；附件物化目录按会话建在数据根之外（`os.tmpdir()` 下每会话一个 0700、名字不可猜测的目录），保留 ADR-023 第 3 条的稳定只读副本语义（后续回合仍可按同一路径读取，缺失即重新物化），随会话删除；不再每个 Run 一个目录 | (b) 都留在数据根：附件指针把数据根路径交给目标，同用户的目标顺着路径能读 `gateway.sqlite` |
| D6 | process 型 Driver 在 unknown 回合之后“继续原会话” | (a) Hub 自己确认进程组已结束后只读 resume，按核对位置判该回合是否入史，绑定 `suspect{unknown_turn}`，need=∅ 时原样续接；由探针 P16 门控 | (b) 维持现状，只能分支、关闭或 native-reset：单 Harness 用户在一次崩溃后拿到整份交接单 |
| D7 | 同一厂商不同登录方式（account / api_key）是否分开记同意（Q11） | (a) 同记一个厂商键，authKind 只作文案：处理方相同 | (b) 分开：只增加提示 |
| D8 | 默认数据根移出工作区（Q9） | (a) 本版只做检查、失败与提示，默认值另立 ADR | (b) 本版就改默认值：牵动现有部署（4317 服务）的数据位置 |
| D9 | 冷返回的默认 | (a) 默认续接原会话：续接保留原生上下文，新开只是估算更便宜（并列显示条件见表下说明） | (b) 冷且长时默认新开 |
| D10 | RelayBench Q 的非劣界值与预算 | (a) v0（72 配对）只作 −10 pp 初筛，正式采纳需 ≥300 配对、−5 pp【推算】；预算另批 | (b) 维持 −3 pp、n=72：没有统计效力 |
| D11 | 未经探针的 Driver 是否开放接力 | (a) 生产只对 `probed=true` 的 Driver 开放，开发用配置 `relay.allowUnprobed`（默认 false） | (b) 一律开放、送达按 unknown 处理：六家都先走 unknown 与重发 |

D9 的并列显示条件以第 7.3 节为准（冷热都适用：全程费用差 ≥ $0.10、时延差 ≥10 s 或 N/W ≥0.85），终稿“状态与验收”的 D9 一行已按它改写。

## 与既有 ADR 的关系

proposed 期间不改下列 ADR 的正文；接受后，对应切片实施时在各 ADR 补注。终稿点名的有 ADR-047 第 5 条的修订、ADR-049 的补充与索引里 ADR-006 一行的取代关系登记（第 14.2、14.4、17 节）。

| ADR | 关系 |
|---|---|
| 议程 ADR-006（[索引](README.md)的议程表）、[ADR-010](0010-public-session-mvp.md) | 本记录接受后取代 ADR-006：现行 `public_context_rehydrate` 的实现（`buildPublicContext` 的 JSON 信封）由交接单与送达水位取代，G070 删除 `buildPublicContext`；`ContinuityLevel` 改为对象，解析器仍接受 v12 事件里的旧字符串；静止交接（回合边界生效、默认 `wait_current`）保留。ADR-010 的公共 Session 唯一权威与先提交再发布不变。ADR-006 没有独立文件，只是索引议程表里的一行：本记录接受后由 C006 在那一行登记“由 ADR-055 取代”（索引由 V008 维护），不新建 `0006-context-handoff.md` |
| [ADR-014](0014-conversation-failure-recovery.md) | 未知结果不重跑；恢复切换显式确认，新切换写 `acknowledgedUnknown`，解析器仍认旧切换的 `sourceRunIds`；单个会话的接力失败不波及其他会话（INV-35、按会话 SAVEPOINT 的恢复） |
| [ADR-015](0015-native-harness-models-and-switching.md) | 沿用：选择即切换、在回合边界生效，切换不转移运行中的工具，不改用户配置；本记录把“切换生效”与“交接送达”分成两个事实，切换生效时不组包 |
| [ADR-022](0022-native-activity-and-content-store.md)、[ADR-023](0023-attachment-input.md) | RunDigest 只读已落库的工具详情（缺的标 `detailsMissing`）；交接单正文存业务库而不是内容存储；附件物化目录移到数据根之外、按会话建立并随会话删除（D5），ADR-023 第 3 条“稳定只读副本，后续回合再次读取时仍可用”保持不变（副本仍按内容寻址、每次授权前复核、缺失即重新物化），只是位置从数据根 `content/files/` 改到会话目录；`ContentPort` 增加有界只读 `readText` 供懒重建读旧 Run 的详情 |
| [ADR-025](0025-conversation-branches.md) | 原生副本的精确条件收紧（决定 12）；不精确时第一份交接单把来源历史作最旧一层，之后的增量不再重复带 `branchedHistory` |
| [ADR-027](0027-openclaw-transcript-reconciliation.md) | OpenClaw 的核对位置用派发前的 `transcriptSeq()`，在其后的客户端 user 行里按标题行查找；200 条窗口没覆盖到位置记 `outside_window` |
| [ADR-028](0028-native-configuration-sync.md) | 配置承接不再依赖 `throughRunId`，改读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 `input ≠ not_recorded` 的 Run，跨因清空归档的绑定；v12 过渡期先把 `state.ts:392` 改为取该绑定最后一个已派发的 Run |
| [ADR-029](0029-continue-native-sessions.md) | 接续本机会话的绑定记 origin 基准；回放先经 `userTextOf` 剥原生包装，交接单按“标题行 ID + 正文一致”识别；交给他人时写明读到与未读的条数 |
| [ADR-030](0030-retained-native-processes.md) | `verify=on_next_open` 的 Driver 在绑定为 suspect 或 pending 时不复用保留进程，先关闭再 open 回放核对；D6 用它的进程组记录确认在途回合已结束（它只记录保留的进程，可行性待 Q23 与 P16）；Claude 合成清空时更新 `kept.conversation` |
| [ADR-033](0033-native-catalog-cache-and-readiness.md) | 受理时的命令预分类读目录缓存与 Driver 静态声明，不建立 control 实例 |
| [ADR-036](0036-approval-wait-budget.md)、[ADR-037](0037-run-diagnostics.md) | 未归属改动按其他对话的回合时间窗归属为“另一个 HarnessHub 对话”；诊断隐去含交接单 ID 或本回合正文的行，诊断视图按 Run 显示准备耗时、证据级别与时延 |
| [ADR-039](0039-continue-in-the-original-program.md) | 交接单作为用户消息留在目标的原生转录里，用户在原程序里续接会看到它（本版接受）；原生会话里 Hub 之外的回合只计数（`foreignAfterLast`） |
| [ADR-042](0042-frontend-redesign.md) | “从这里起由 X 接手”的分隔线改为在送达证据之后出现（现在是切换生效时，`Turn.tsx:170–179`） |
| [ADR-044](0044-macos-official-channels.md) | 只面向 macOS：`relay-key` 的位置、APFS 上大小写与 firmlink 写法的路径比较都按 macOS 验证 |
| [ADR-047](0047-stream-output-coalescing.md) | 窗口合并不变；`relay.input_recorded` 先冲刷打开的文字窗口，再并入 `run.first_output` 的独立事务或本回合下一次既有提交，不设置 `firstOutputAt`；接受后在决定 5 补一条修订 |
| [ADR-048](0048-harness-scope-and-workbuddy.md) | 每片证据按完成定义分栏报告；WorkBuddy 接入时声明最保守能力，探针通过前不作目标 |
| [ADR-049](0049-business-store-backup-before-migration.md) | v13 迁移前备份：条件从 1–11 改为 1–12；“WAL 加备份约需两倍库大小的空间”写进它的补充；降级按它的手动恢复步骤 |
| [ADR-051](0051-hermes-upgrade-route.md) | Hermes 是网关查看器（`execution: gateway`）：查看器退出不是静止证据，unknown 回合的绑定在网关侧确认前保持 unconfirmed；只读核对打开留到 v1.1，另立 ADR |
| [ADR-053](0053-latest-version-baseline.md) | RelayConformance 在各家最新正式版上跑，`probed` 只在探针通过后翻转，版本只作证据、不作门控；每个最新正式版重跑 |
