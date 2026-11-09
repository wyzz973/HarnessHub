# ADR-055：接力与上下文调度（HarnessHub Relay）

状态：accepted，2026-11-03（用户当天验收，按推荐项接受全部取舍 D1–D11，原话：“按推荐接受”）。实施进展：G067（P0 修复，不升库）代码完成、合成测试通过，见[验证记录](../verification/relay-p0-2026-11-03.md)；G075（存储优化前置片，不升库）代码完成、合成测试通过，参考机上 8 MiB 快照从受理到派发 p95 281.7 ms（目标 ≤400 ms），见[验证记录](../verification/relay-g075-2026-11-09.md)；都未真机验证。G070 的 MVP 过渡实现（v12 上按需渲染交接单，取代 JSON 信封）代码完成、合成测试通过，见[验证记录](../verification/relay-mvp-2026-11-09.md)与下文“实施补记”；真机冒烟两对：OpenCode → DeepSeek Harness → OpenCode 全程通过；Claude Code → Codex → Claude Code 的交接单一步通过，回到 Claude Code（haiku）时答错了一份内容正确的增量（见验证记录）。设计正文是[接力系统统一架构终稿](../proposals/relay/relay-architecture.md)（第三版，总架构师 Fable 5.1 定稿，下称终稿）；本记录只写取舍、失败边界与验收方式，契约、数据模型、模板与伪代码以终稿各节为准。接受时（2026-11-03）的状态是未实现、未真机验证，原型只用合成数据（`spikes/relay/`，不在 TypeScript 构建范围内）；此后的进展见上面的“实施进展”，业务库仍是 v12。实现按终稿第 17 节的切片顺序进行；“用户拍板的取舍”一节的 D1–D11 已全部按推荐项接受（终稿[状态与验收](../proposals/relay/relay-architecture.md#状态与验收)）。接受后取代议程 ADR-006（静止交接与 `public_context_rehydrate` 等级；现行实现是 `buildPublicContext` 把公共历史包成 JSON 信封注入），并按文末一节修订若干既有 ADR；proposed 期间不改它们的正文。

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

## 实施补记

### G070 的 MVP 过渡实现（2026-11-09，v12，不升库）

- **起因**：用户 2026-11-09 要求“今晚集中精力完成到一个给用户最小可用的版本”。v13 的接力存储（G066）与送达状态机（G068）工作量大，于是先在 v12 上按需渲染交接单，取代 JSON 信封。推进仍按第 7.6 节的 v12 规则（G067）。
- **做法**：每回合准备时，从已提交的快照渲染交接单；`run.context_prepared` 只记策略版本 `relay/1-mvp.3`、ID、sha256、来源与计数，不记正文。实现与差异以[交接内容契约](../contracts/context-transfer.md) §16 为准。
- **对终稿常量的调整**：终稿的常量初值都是推算值，由 G070–G074 校准。MVP 依据合成场景先调整了一部分，依据见验证记录：
  - 不可信份额 0.375 → 0.6；
  - 增量里的回复单独给 1,500 token；
  - 文件表不超过 15% T；
  - 更早轮次的降级顺序为：G1 → 回复截短的 G1 → G2 → 单行。

  这些都没有用真实分词器校准，由 G074 的 RelayBench 重定。
- **已知秘密**：在会话范围内收集，覆盖目标与交接单里出现过的每个 Harness，只在要发交接单时收集。收集失败时，这一回合以 `RELAY_PREPARE_FAILED` 失败，不在缺少已知秘密的情况下发送。读取凭据类路径的命令不附输出。
- **真机**：两对数字接力冒烟。OpenCode → DeepSeek Harness → OpenCode 全程通过；Claude Code → Codex 的交接单一步通过。回到 Claude Code（haiku）时，增量里写着 Codex 的回答，模型却答成了自己的数。原因可能是题目措辞，也可能是阅读约定第 1 条“可能已经过时”让较弱的模型更信自己的原生历史，由 G074 用对照实验确认；确认之前，不改第 5.4 节的约定。
- **独立审查**：共三轮。第一轮否决原样发布：先截断、后脱敏会带出私钥片段，中文场景下交接内容也过少。第二轮确认这些问题已消除，结论是可以发布，另提出筛选过宽、误删普通输出、错误码不对三个新问题，第三轮修正。经过见验证记录。

### G066：v13 接力存储、契约类型与迁移（2026-11-09）

范围按终稿第 4、14 节：`src/contracts/relay.ts`（类型、封闭枚举的 `as const` 数组、解析器、端口）、Session v13 的快照字段与转换规则、业务库 v13（11 张表与 4 个触发器、`transact` 的 relay 行、`relayWrite`、`deleteSession`、安装级同意日志、窗口与偏好）、`migrate.ts`（v12 推断与新绑定的初值）、`claimAndRecover` 的 `recoverRelay` 接入点。运行时只改两类地方：新会话写 `schemaVersion: 13`，每个新建绑定（导入、分支、新原生会话，含 native-reset 之后的）用 `initialBindingRelay` 填 `relay`，续接的绑定沿用原来的 `relay`；交接单的渲染与发送、推进规则、`sourceRunIds` 的写法都没有变，也还没有代码写 relay 行。证据见[验证记录](../verification/relay-g066-2026-11-09.md)。

**偏离终稿的数字**：
- **每绑定 ≤1,024 B、每 Run ≤320 B 做不到。** 按第 4 节的形状取最长合法值（pending 的 prior 是带 `carried` 的 suspect、`carried.prior` 也是 suspect，四个包 ID、两份 64 位链、两个 253 字节的主机名分别在 `consentKey` 与 `vendorObserved.endpoint`），绑定的 `relay` 是 2,044 B；去掉厂商两项也有 1,222 B。Run 的 `relay` 与 `relayRequest` 在 96 字节的 Harness 与 control 标识下是 563 B，快照还要加两个时间字段。终稿与 VF2-14 的估算没有算进第三版加的 `carried`、`vendorObserved`、`compactionSeen` 与 `executedOn` 里的长标识。本实现按逐字段上限定了解析器的总上限 `MAX_BINDING_RELAY_BYTES = 2048`、`MAX_RUN_RELAY_BYTES = 576`，保证所有合法值都放得下（否则 G068 会在合法状态上撞到 INVALID_DATA），G066-C08 断言的是这两个数，并报告实测值。要回到 1,024 / 320 B 只能改第 4 节的形状（例如快照只存厂商键、不存观测到的主机名，`executedOn` 不重复 Run 自己的 harness/control），属于设计变更，留待主负责人决定。
- 字段上限（终稿未写的部分由本实现定）：模型与模型键 ≤96 B、`authKind` ≤16 B、主机名 ≤253 B、路由与 Provider 名 ≤128 B、计数 ≤2^31−1、seq ≤16,384、纪元 ≤16,385、Run 序号 ≤255、`manualResends` ≤256。

**实现方式上的取舍**：
- **`assertSessionTransition(before, after, events?)`**：为“写者 Run 的 `run.ended` 带 `native.cleared` 时放行归档加新建同 harness/control 绑定”，在现有接口上加了可选的第三个参数，Store 的 `transact` 与恢复传入本次提交的事件草稿；不传就是空数组，现有调用不受影响。顺带收紧：写者 Run 归档自己的绑定，现在只有本次提交里它的 `run.ended` 带 `native.cleared` 时才放行（此前现码允许写者直接归档，但没有任何代码路径这样做）；native-reset 与分支失败的归档照旧，三种归档都要求 `relay` 不变（归档即冻结）。
- **接力字段的转换规则**按第 14.3 节逐条实现，各有无效样例（G066-C06）；另加三条配套规则：用户的接力命令（`relay-*`）可以只改 `relay`、不需要写者 Run；新切换带 `acknowledgedUnknown` 时，提交之前会话必须是 blocked（只能出现在恢复切换上，RT1-m10）；`relayRecoveryFailed` 只能由本次提交里的 `session.recovered` 设置，只能由 native-reset 或新绑定清除。沿一个 Harness/control 的绑定纪元严格递增、清空下限不减，作为快照本身的不变量放在解析器里。
- **`PublicSwitch` 的 `mode`、`timing`、`acknowledgedUnknown` 是可选字段**：运行时这次不写它们（G072 才改切换的写法），v13 快照照样合法。`timing` 采用第一版写明的形状 `{requestedAt, validatedAt?, effectiveAt?}`（终稿只写了字段名）。`RunTiming` 另加 `recordedAt`（E1 时刻），只要求在 `dispatchedAt` 与 `endedAt` 之间。
- **接力命令的结果**：`relay-*` 命令的 `resultId` 是一个标识（钉住、排除或同意记录在 relay 行里），快照里不核对它指向什么，由写 relay 行时核对。
- **`SessionSnapshot.relayRecoveryFailed`**（第 9 节 S15）随 `recoverRelay` 的接入点一起加入。`recoverRelay` 是 Store 的构造选项，默认什么都不做（G068 提供领域函数）；它只对 `recoverSession` 有变更的会话调用，在该会话自己的 SAVEPOINT 里校验并写入；它抛错、给出的状态不合法或写送达行失败，都只回滚这个保存点，该会话照常恢复并记 `relayRecoveryFailed` 与事件里的 `relay: { failed: true }`。整个事务被 SQLite 中止时不吞。
- **“进入事务前校验”的做法**：relay 行的全部检查（序列化字节、fold、正文摘要、同 ID 不同正文、64 MiB 配额、送达转换、钉住上限、跨存储引用）都在 `transact` 写第一条语句之前完成；它们要读库里已有的行，所以放在事务开始之后、`mutate` 返回之后，而不是 BEGIN 之前。预期内的失败抛 `RelayError`（`RELAY_PREPARE_FAILED{render | render_mismatch | storage | storage_quota}`）或 INVALID_TRANSITION / INVALID_INPUT / `RELAY_PIN_LIMIT`，事务回滚、Store 不进入 failed。另导出 `checkFold` 供调用方事先检查。
- **派生行**：`SessionMutation.relay.derived` 是一个函数，在保存点内调用，这样扫描器在生成摘要时抛错也只让派生行回滚（G066-C05）；结果经 `SessionCommit.relay.derived` 告诉调用方是 `written` 还是 `behind`（带诊断）。失败时不另写 behind 行：没有当前策略版本的 current 行即视为 behind。
- **送达行**：插入只能是 in_flight；每个 Run 至多一行；结论转换先按第 4 节的表在 TypeScript 里校验，`UPDATE` 只在结论变化时把 `outcome` 写进 SET（用一个“同值即拒绝”的测试触发器证明同值写不会碰到它）。`DeliveryRecord` 多了 `verifyMs`，对应 DDL 已有的 `verify_ms` 列。
- **`relayWrite`**：单独事务，不碰 `sessions` 行；对同一 Run 与策略版本，事务写下的 current 行保留，已结算的 `realized` 保留，`outcome` 从不写。SQLite 拒绝它的语句时回滚、返回诊断并记入 `relayDiagnostics()`（最多 32 条），Store 照常服务；行本身不合法则抛错（调用方的错误）。
- **`deleteSession`** 只删已关闭且没有保留进程的会话，同一事务删 7 张会话级接力表的行、事件、创建键与会话行；安装级的同意日志不删（审计记录）。现在还没有调用方。
- **钉住**：`offset` 与 `length` 按消息文本的 UTF-8 字节计，写入时核对消息属于本会话、作者与消息角色一致、区间在消息内；≤24 个、每个 ≤2,048 B、合计 ≤12,288 B（`RELAY_PIN_LIMIT`）。
- **窗口**：`upsertWindow` 最后写入者胜；每次启动在 `claimAndRecover` 里删掉 `observed_at` 早于 30 天的行。
- **偏好**：四个键的取值按 public-api.md 定为封闭集合（`relay.crossVendor`：ask、allow、goal_only；`relay.returnPreference`：continue、new_when_cold、ask；另两个：true、false），值 ≤64 字节；表上的 CHECK 只作断言。
- **同意日志**：同一命令 ID 再追加时，内容相同返回原记录（含已轮转进归档的），不同则 IDEMPOTENCY_CONFLICT；到 65,536 行时同一事务轮转，归档将超过 1,048,576 行或轮转后仍满都在写入前报 `RELAY_UNAVAILABLE{consent_log_full}`。
- **迁移写的索引行**：每个已终结的已派发 Run 一行，`status='behind'`、`policy_version='relay/0'`（没有任何策略渲染过它）、`digest_json='{}'`、`sha256` 取 `sha256("{}")`、`secret_set_hmac` 为空串；`index_json` 是 `RelayBehindIndex`：`runId`、序号、事实 seq（`run.ended` 的 seq，或终结它的 `session.recovered` 的 seq）、`executedOn`（纪元按谱系）、`dispatched`、状态、`input`（G067 之前的事件记 unknown）与命令效果。迁移时尚未终结的已派发 Run（上一个 owner 中途退出）不写，留给 G068 的恢复与 G070 的懒重建。
- **迁移读事件**：按 seq 直接扫 events 表，并在 SQLite 里按 `json_extract(event_json,'$.type')` 只取推断要用的 9 种事件，再逐条按存储事件校验；不走分页读事件时每页整份解析快照的路径。

**迁移推断里有歧义时的选择**（一律只降不升）：
- **携带回合**：除终稿的六个条件外，输入必须有送达证据——G067 起的事件要 `input: "recorded"`，更早的事件（没有 `input`）要状态为 completed；`input` 为 unknown、状态 unknown 或 cancelled 的携带回合不计，并使绑定 suspect（RT1-B1 写明这两种记 suspect）。
- **水位不取来源的最大 seq，而取连续覆盖到的最大 seq**：从当前水位往上，按 seq 逐个看本绑定欠的外来事实，遇到第一个不在这次来源里的就停。终稿的写法在 G067 之前的数据上不成立：那时命令回合（D1）把原生位置推过了没送达的事实，之后一份交接单只带位置之后的来源，取最大值会把跳过的事实算成已送达。属性测试里有这个形状的专门用例。
- **本绑定自己的内容回合按 native 推进**，但只在它的上下文之前没有欠交（`need=∅`）、没有选“只发这条消息”、且不晚于 v12 位置时，推进到它的 `contextThroughSeq`。
- **“之后出现过原生命令、request_rejected、model_not_applied”**：命令只算已派发的（没派发的命令改不了原生上下文），任何效果的命令都算（终稿原文如此，G067 之前也不知道效果）。
- **没有任何送达或亲历证据的绑定**（水位为空）：欠交时若有上一条的可疑项则 `suspect{legacy, mark: null}`（reset + D1 即此），否则 `fresh`（之前有同 harness/control 的绑定为 `reset`，否则 `new`）；终稿的“need=∅ 为 synced”对有水位的绑定成立，空水位不造一个 0 出来（0 会把来源历史算作已送达）。
- **导入与分支绑定**按终稿原样为 `synced{0, origin}`、纪元按谱系，之后的回合不再推进它（偏保守，切走再切回时可能重复补交一次）；只有确认过的清空让它变成 `fresh{user_cleared}`，并把 `originIncluded` 置为 false（原生会话已经不含来源历史）。
- **清空**：只认 G067 起 `run.ended.contextEffect=clear`（已执行）；更早的事件没有记效果，“按 Driver 目录的命令名回推”需要 Driver 的目录，而迁移在打开存储时运行、没有 Driver，也不读界面层的目录缓存——这类命令按效果未知处理：不加纪元、不写下限、使绑定 suspect。`migrateSession` 留了 `commandEffect` 回推入口，Store 不接。
- **G067 之前的来源历史**：G067 之前每份信封都带 `branchedHistory`（`e02fa52^` 的 `context.ts`），所以那时带了来源 Run 的携带回合按“来源历史也送达了”计；只带来源历史、没有来源 Run 的回合按未携带计（终稿原文）。
- **archived 绑定**按它归档那一刻的事实分类；`vendorObserved` 取绑定的 `observed`（模型超过 96 B 则记 null，模型键为空串，端点 null），`cache` 取该绑定最后一个已派发 Run 的上下文用量，`consentKey` 为 null，压缩游标 `{0, null}`。
- 快照里的绑定与事件造出的绑定对不上（v12 运行时不会写出）时整笔迁移以 INVALID_DATA 失败，库留在原版本、备份保留。

**与简报的差异**：新绑定的初值不是一律 `fresh{new}`：同一 harness/control 之前已有绑定（native-reset 之后）时是 `fresh{reset}`，按第 7.5 节；纪元与下限按谱系。

**经既有所有者修改的文件**：`src/contracts/session.ts`、`src/contexts/session/domain/state.ts`、`tests/unit/session-state.test.ts`（G004）；`src/infrastructure/session/sqlite-store.ts`、`tests/integration/session-store.test.ts`、`tests/fixtures/session-store-peer.mjs`（G008）；`src/contexts/session/application/runtime.ts`、`tests/integration/session-runtime.test.ts`（G028）；另有几份测试因持久格式变化同步改了建会话或建绑定的地方（v12 → v13、补 `relay`）：`tests/integration/session-io.test.ts`（G059）、`tests/integration/snapshot-cache.test.ts` 与 `tests/performance/session-store-commit.test.ts`（G075）、`tests/integration/relay-p0.test.ts`（G067）。MVP 渲染模块 `escape.ts`、`packet.ts`（G070）只把语言、包的种类与等级的类型改成从契约导入，行为不变。`plan/` 下的用例状态仍是 planned（设计检查只允许 planned 与 deferred、证据必须为 null），实际结果写在验证记录。G066-C10 保持 planned：C006 的 JSON Schema（`contracts/context.schema.json`）还没有建立。

### G068（阶段一）：送达状态机、核对计划与恢复（2026-11-09）

范围按简报的阶段一：只有纯领域函数、恢复、参考模型与测试，不接运行时。`src/contexts/session/domain/relay/delivery.ts` 是第 7.2 节状态 × 事件全表的全函数 `step(relay, event)`、第 7.3 节 planReturn 的核对部分 `planReturnVerify`，以及几条结算规则；`recover.ts` 是 Store 构造选项 `recoverRelay` 的实现；`tests/fixtures/relay-harness-peer.mjs` 是原生历史的参考模型。`state.ts`、`sqlite-store.ts`、`runtime.ts`、`session-application.ts` 都没有改，`recoverRelay` 也没有接进生产组合根。独立审查之后按审批代理的裁定修了一轮（见下文“审批代理的决定”），契约文件 `src/contracts/relay.ts` 随之改了三处。证据见[验证记录](../verification/relay-g068-2026-11-09.md)。

**接口的形状**：
- `step` 对每个（状态，事件）都给出结果：`applied`（新状态，可能不变，加上要在同一事务里写的送达行变更）、`replaced`（l 与 Claude 的合成清空：旧绑定按原样冻结，新绑定的状态另给）或 `refused`。表里标“—”的格与前提不满足的事件一律 `refused` 并写明原因，不静默放过：`not_applicable`（不发生的格）、`RELAY_CHOICE_REQUIRED{delivery_unconfirmed}`（自动重发已用尽或 `lateDelivery`）、`verify_first`（suspect 先核对或由用户选择）、`invalid`（数据或上限不对）。每次返回的状态都过一遍 v13 解析器（含字节上限），每条送达行变更都按 `DELIVERY_TRANSITIONS` 校验，变更带上它的起点，调用方可以和送达表的现值对照。
- 送达行的插入只给由状态机决定的字段（Run、包、`attachOverride`、`resendOf`）；位置、同意 seq、输入 HMAC、脱敏上下文与送达时的压缩游标由协调器在同一事务里补齐。
- 结论的 seq 与时间随事件传入，领域里不读时钟。
- 另外导出几条阶段二要用的纯规则：`settledOutcome`（E3 与 not_recorded 的判定）、`commandTurnEvent`（命令效果 = 声明效果 ∧ 实际执行；执行了的 compact 带 `ran`）、`owed`（need）、`pendingResend`（下一条是自动重发还是 409）、`mayReuseKept`（suspect / pending 不复用保留进程）、`retreatedPrior`（用户选“补发完整交接单”后的 prior）、`restorable` 与 `resolvesWithoutCheck`（F2）、`chainAfter`。

**表外的两个事件**：第 7.2 节的行里引用了两个不在 14 列里的转换，这里各给一个事件。其一是 D6 的 `unknown_turn_continued`：pending 时把 `pending.prior` 与包存进 `suspect.carried`。其二是第 9 节“需要用户选择”里的“补发完整交接单”：按事件 a 处理，带 `retreat`，先把水位退到 max(本纪元第一份包 fromSeq − 1, epochFloor)，记 `evidence: choice`。`legacy` 来自迁移 m，单元测试用 G066 的 d1 夹具核对。

#### 审批代理的决定（2026-11-09）

G068 阶段一的独立审查提出 F1–F13 与一个 packetId 重合的疑问，用户授权的审批代理（Fable）作出以下裁定，已全部实现并写回终稿第 4、7.2、7.3、7.4、9、14.4 节、契约 switching.md R2.3 / R4 / R6 / R8 / R9 / R10、public-api.md 与 invariants.md 的 INV-14 说明。其中若干处与终稿 7.2 原文不同，由审批代理批准。

- **F1 清空核对用对标记集**（重要，INV-14）：clear 计划只核对“清空前水位所站的链”——从 `mark.lastPacketId` 的最新送达行出发，沿 `chainAfter(上一行.mark.chain, 本行.body) = 本行.mark.chain` 回溯，至链头或 4 个——以及 carried 包；被 retreat 甩掉的 recorded 行不在链上。k 的次序：① historyEmpty=true → 清空；② carried 在：链上没有未经压缩解释的缺失 → 清空没发生、按 g 推进到 carried，否则不一致（迟到写入落在清空之后）→ `verify_required`；③ 链上有 present 或 compacted → 清空没发生，按标记恢复或回退；④ 链非空、全部 absent、无压缩解释 → 清空；⑤ 链全部 absent 但压缩可以解释 → `verify_required`；⑥ 链为空：可恢复的水位恢复，否则 `verify_required`；⑦ 其余 → `verify_required`。健全性：`epochFloor` 只在 ① 或 ④ 抬高；水位只恢复到仍有标记在场的链节点，或可恢复的水位。不采用“只看 `mark.lastPacketId` 单个标记”：用户先在原程序里撤掉 P2、再经 Hub 清空而清空没生效时，单标记法会误判为已清空，链法得到 P1 在、P2 不在，退到 P1。
- **可恢复的水位**（restorable）≔ 无水位，或 `lastPacketId=null` 且 basis ∈ {native, origin, evidence}。逐基底的健全性：无水位不声称任何事实；native 只由 fresh + b + j 产生，派发时 need=∅，(epochFloor, T] 内没有外来事实，seq 单调不会再出现 ≤T 的新事实，用户 `/undo` 删的是本绑定自己的回合（不是外来事实，不重交给同一绑定，也不重跑，INV-11；切到别家时照常作为外来事实交付）；origin 在同一绑定内没有重交付路径，保持 suspect 换不来补救，用户随时可新开原生会话；回退水位（evidence、无包）等于首包 prior 的声称，prior 为 fresh / native / origin 时为空，为 legacy 时继承 legacy 的不可核验（N1）；legacy 不恢复。
- **F2 永久 409 死角**（重要）：k 收到 `skip{no_marker | unavailable}` 且状态为 `suspect{rewind | unknown_command}` 时，可恢复的水位直接恢复（`relay.verified{result:"restored"}`），否则不变、`verify_required`；`skip{not_now | fresh | decided}` 不解析。协调器对每个计划（包括 skip）都调用一次 k，所以 `verify:"none"` 的 Driver 在 open 时就得到解析。受理：`on_next_open` 的 Driver 不在受理时为 `verify_first` 返回 409（open 后核对），只有 `verify:"none"` 或上次核对 unavailable 才受理即 409，且仅当 `resolvesWithoutCheck(relay) === false`；`verify_required` 的选项按 `counts` 显示，退回后 need=∅ 时不提供［补发完整交接单］。不采纳“n 清除 suspect”：`attach:"none"` 不改状态（INV-30）。
- **F3**：pending 的 k 与 D6 carried 分支先做压缩分类：absent 且送达行游标与当前不同 → 按 compacted（reanchor，送达行 `unknown{compacted}`）。
- **F4**：事件 d 带 `ran`；命令执行或游标变化、且本纪元有可能被折叠的包（packetsInEpoch>0、pending 或 carried）→ reanchor；不报游标时不改 `compactionSeen`；fresh 且无包不置位。
- **F5**：三标记用例与“被 retreat 甩掉的行仍进 suspect 计划”写成单元测试。
- **F6**：属性测试补齐 P-F1、P-F2、不滞留断言与 `nativeTurn`（见验证记录）。
- **F7**：suspect 的 k 里 compacted 视同仍在并置 reanchor，按最新的 present / compacted 标记退：全部 compacted 或最新的 compacted → 水位不动；更早的 compacted、较新的 absent → 退到那个更早的。理由：compacted 的包确已送达并被折叠，与 7.4 ① 一致，只补要点、不整包重发。
- **F8**：`suspect.carried` 允许的 cause 扩为 {rewind, unknown_command, clear_unconfirmed, unknown_turn}（契约 `CARRIED_CAUSES`）；pending + e′/f → suspect{mark=prior 的 mark, cause, carried={prior, P, range}}；suspect{carried} + e′/f 保留 carried；cause 优先级：clear_unconfirmed 一经设立不被 f 覆盖，其余取最新；D6 作用于 suspect 不变；`retreatedPrior` 置 carried=null。suspect 计划另带 carried：carried 在且链上无未解释缺失 → 按 g 推进；在而有未解释缺失 → `verify_required`；不在 → 送达行细化，其余按标记规则。为让字节上限 2,048 仍成立，契约同时写明 pending 的 prior 不带 carried（状态机本来就不产生这种形状）：最长合法值从 2,044 B 变为 1,847 B；若只扩 cause 而不收紧，会到 2,049 B。
- **F9**：skip 与 fresh 分支的 `changed` 反映游标更新。
- **F10**：reset 比对前两边都过解析器；更好的做法（事件直接指明本绑定的索引或 checkpoint）留到阶段二接入时改。
- **F11**：`verify_first{cause}` → 409 cause：marker_absent 时 `marker_absent`，其余（含 legacy）`verify_required`。
- **F12**：after_turn 在结算时对 synced 一律 `skip{decided}`，只核对仍 pending 的包或被命令变成 suspect 的绑定。
- **F13**：`EVIDENCE_CLASSES` 加 `choice`，用户选“补发”产生的回退水位标 `choice`，k 的回退仍标 E2；送达行的 recorded 证据只认 E1、E2、E3（契约 `DELIVERY_EVIDENCE`）。
- **原“需裁定”五点的结果**：
  1. legacy 的 409 cause 为 `verify_required`，不并入 marker_absent（后者没有“只发这条消息”），第 9 节的 cause 列表已补 legacy。
  2. 重发包 P′ 被判 not_recorded（h）时不回 prior：`carry_settled` 带可选 `superseded{packetId, range}`（协调器从 `resendOf` 的送达行与清单取），h 且 autoResends+manualResends>0 时必须给出，否则 `invalid`；结果是 pending 回到 P，计数不变（本次重发计入），`attachOverride` 保留，P′ 行 not_recorded；下一条输入先核对 P，仍未知则 autoResends=1 → 409 `delivery_unconfirmed`。首包的 h 仍回 prior。
  3. K12 维持 `unknown{owner_ended}`（`input` 是瞬时字段，`run.ended` 未提交就读不到 recorded）。
  4. D6 carried=null 且条目不在：`standing(mark)`（b 回合不改水位，条目不在说明原生上下文与回合前相同；回合结果仍未知、不重跑）。carried=null 时 compacted 按“在”处理并置 reanchor。
  5. 原先“比终稿更严”的四处全部写回：suspect 上的 a 必带 retreat（含 legacy）；D6 不改已 suspect 的 cause；交接单水位不低于清空下限；clear_unconfirmed 的恢复按 F1 规则（可恢复的四类水位，不再只是空水位与 native）。
- **packetId 重合**：ID 由最终正文派生；resend 模板有自己的标记行、去重行（含原 ID）与结束行，P′≠P 必然成立；非重发的再次组包（h 回 prior 或 retreat 后 need 与事实完全相同）会得到相同 ID，INV-13 把这当作设计（去重）。属性测试已在 need 相同时按概率复用上一次 not_recorded 包的 ID（47–54 次/全集）。阶段二必须保证：(i) 一个核对计划里不出现两个同 ID 标记（同 ID 行只取最新一行的位置；`planReturnVerify` 已按最新行取）；(ii) 结算事件按 runId 对应到 pending 的那次 Run（协调器自知；建议 pending 增可选 `runId`，阶段二定）。
- **推迟到阶段二**：D6 不带包回合的核对位置（`turnEntry` 的来源：每个内容回合派发前记录 `DeliveryPosition`，或用客户端 ID）；F10 的“事件直接指明绑定”；lateDelivery 的 Driver“迟到写入落在清空 / 回退之后”是否可达只能由真机探针（G074）证实，阶段一按不一致 → `verify_required` 处理。
- **新发现，写进文档、不改代码**：N1 legacy 水位（及其纪元内派生的回退水位）在 `/undo` 后不可核验，是迁移的固有局限（14.4 与发布说明，出路是新开原生会话）；N2 清空未确认而用户又在原程序里说话（h=false）：链非空时规则 ④ 判清空，链为空时按可恢复的水位恢复、不开新纪元，用户失去用“附上”取回本绑定清空前自家回合的入口，没有事实丢失（7.4，接受）；N3 由 F8 的 cause 优先级修掉；N4 `[P1 present, P2 absent]` 退回时 P2 的送达行仍是 recorded（终态），`BindingDelivery.mark` 让此后的链回溯排除它（R2.3）。

#### 实现中发现、超出裁定的两处（待主负责人确认）

两处都是属性测试与定向复现发现的健全性缺口，按最保守的读法实现，并已写进终稿 7.2 表后与契约 R4：

1. **规则 ④ 的“无压缩解释”须是确知**：每个缺失标记的送达行记有游标、且游标在送达后没有变。属性测试的反例（种子 0x68166ef8）：清空没执行，之后一次 `/compact` 把标记折叠进摘要；没有压缩证据的 Driver 报 absent、送达行没有游标，旧写法判为清空，纪元上升而模型里没有任何清空（P-F1 失败）。现在这种情形落到规则 ⑤，`verify_required`。代价：没有压缩证据的 Driver 不能靠“标记都不在”确认清空，只能靠 historyEmpty 或用户选择。
2. **回退与未确认清空的折叠**：回退类待核（rewind、unknown_command、marker_absent）与未确认的清空在核对之前叠加（任一次序：f 后 e′，或 e′ 后 f）时，链上的缺失既可能是清空造成的，也可能是回退造成的；按裁定的规则 ④ 会把回退的效果当成清空，抬高下限，丢掉被撤掉的事实（定向复现：synced P1→P2，`/undo` 撤掉两份包，`/clear` 没执行，核对得到 fresh{user_cleared}、下限 12，事实 3、6、7、9 再也不补）。现在折叠为 suspect{mark=null, clear_unconfirmed, floorCandidate, carried=null}：historyEmpty=true 仍确认清空；否则转为 fresh，下限之上全部重新欠交（健全，代价是可能重复、carried 包不再追踪）。这与裁定里“suspect{carried} + e′/f 保留 carried”在折叠时不一致。pending 上的 e′/f 不折叠：pending 的 prior 由用户的“补发”退回得来，不站在包上（`retreatedPrior` 打平时取基准），链为空，规则 ④ 不会触发；若从 pending 折叠，还会让水位在 pending 上变小，违反 `assertSessionTransition` 的“同一纪元内只在 suspect 时变小”。

**终稿没写、由本实现定的地方**：
- **链**：`chainAfter(prior, body)` = sha256(prior.chain 的十六进制串 ‖ body.sha256 的十六进制串)，按 ASCII 直接拼接；没有水位时从 `EMPTY_CHAIN`（sha256("")）起算。单元测试另有一个在 Node 之外用 `shasum` 算出的向量。
- **suspect 的 k**：标记都只回答 outside_window 或 unavailable 时不得出结论，`verify_required`。都不在时退到的水位记作 `{throughSeq: max(fromSeq − 1, epochFloor), chain: EMPTY_CHAIN, lastPacketId: null, evidence: E2, basis: evidence}`；小于 0 时转为 fresh，basis 有下限时取 user_cleared，纪元 > 1 时取 reset，否则取 new。carried 不在而水位所站的标记集合为空时，按可恢复的水位恢复（与 F2 同一原则），否则 `verify_required`。
- **D6 的 k**：carried=null 时按标记找不到回合自己的条目，k 事件另带 `turnEntry`。
- **e，以及 k 确认的清空**：同时把 `consentKey` 清空，因为它是“本纪元首次送达时的厂商键”；`originIncluded` 置为 false。
- **pending 的 k 与迟到写入**：计划里带上被这份包取代的前几份（`resendOf` 链上尚未 recorded 的）；核对查到它们时把送达行改记 recorded(E2)，绑定不动。每次核对都写一次 unknown→unknown，细化原因（同值写，VF1-12）。
- **recoverRelay**：结论的 seq 取 `state.lastSeq + 1`，因为 recoverSession 只追加一条 `session.recovered`。`RecoverRelay` 没有时钟，`decidedAt` 取该 Run 自己记下的最后一个时刻，作为“owner 结束时刻”的下界。只处理 in_flight 的行；已 recorded 的行不动。没派发的重发包同样回到 `pending.prior`：恢复拿不到被取代包的 range，第 2 点只在结算时适用。

**与计划和简报的出入**：
- `plan/tasks.json` 的验收写“4 × 13 格”，终稿第 7.2 节的属性写“4 种状态 × 14 种事件”，本实现按 14 种（g、h、i 分开）。
- 崩溃注入的 K 表在 RT2 第 2 节，不在终稿第 16 节。
- C10 的“配置承接读 input≠not_recorded 的最后一个已派发 Run”属于 `state.ts` 的 `carriedNativeConfiguration`（G004），现码不看 input；C10 只证实合成清空后模型能承接，没有改它。
- 计划文件：主负责人的 `3bf4d01` 把 `delivery.ts`、`recover.ts` 登记进 `plan/slices.json` 的 relay 切片、把 `plan/tasks.json` 的 G068 置为 in_progress，并重新生成 `TASKS.md`；用例状态仍是 planned。本任务自己没有改 `plan/` 与生成视图。`check:design` 现在通过。
- 契约 `src/contracts/relay.ts` 改了三处（`CARRIED_CAUSES` 与 pending prior 不带 carried，`EVIDENCE_CLASSES` 加 `choice` 与 `DELIVERY_EVIDENCE`），G066 的 `tests/unit/relay-contract.test.ts` 与 `tests/performance/relay-store.test.ts` 的最长合法值与有效 / 无效样例随之更新（合法行为变更）。

**给阶段二的接缝建议**（结算处调用什么、哪些事件由谁在哪里产生）：
- **finalize**（open 之后、authorized 之前）：on_next_open 的 Driver 先调 `mayReuseKept`，为 false 就不复用保留进程。open 之后 `planReturnVerify(moment: "open")`，计划不是 skip 时交给 Driver 的 `verifyDelivered`；**无论计划是什么都调一次** `step({kind: "verified"})`（F2），结果与 `relay.verified` 一起并入 `run.context_prepared` 的事务，准备失败时并入 `run.ended`。随后按 `owed` 与请求选择：need=∅ 用 `plain`；附包用 `carry`，pending 时带 `resend`（由 `pendingResend` 判自动还是 409），suspect 时只在用户选择后带 `retreat`（need 用 `retreatedPrior` 算）；用户选“只发这条消息”用 `alone`。`carry` 的状态与送达行插入、交接单行、`run.relay` 都写进 `run.context_prepared` 与 `run.authorized` 的同一事务。
- **E1**（`relay.input_recorded`）：`step({kind: "carry_settled", outcome: recorded E1, row: "in_flight"})`，与 `run.first_output` 或本回合下一次既有提交同事务；结算时该行已是 recorded，再调一次是 no-op。
- **`run.ended`**：携带包的回合用 `settledOutcome(...)` 加 `carry_settled`，重发回合带 `superseded`（从 `resendOf` 的送达行与清单取）；b 回合用 `plain_settled`；命令回合用 `commandTurnEvent(declared, commandOutcome(...), {cleared: BackendResult.native.cleared, seq, cursor})`（执行了的 compact 带 `ran: true`；自动压缩的 d 为 `ran: false`），Claude 的合成清空用 `cleared{replaced: true}`，新绑定继承 `observed`；after_turn 的 Driver 再调 `planReturnVerify(moment: "settled")` 加 k（synced 得 `skip{decided}`）。这些都与 `run.ended` 同一事务。
- **受理**（admit）：k 的 `note.choice`、`step` 的 `RELAY_CHOICE_REQUIRED`、`verify_first{cause}` 对应第 9 节的三种 cause（F11：marker_absent → marker_absent，其余含 legacy → verify_required）；`on_next_open` 的 Driver 不在受理时为 `verify_first` 返回 409；`resolvesWithoutCheck(relay)` 为真时不返回 409；`verify_required` 的选项按 counts 显示。
- **D6**：Hub 确认进程组已结束（P16）之后，在把绑定改回 ready 的那次提交里调用；carried=null 的核对需要给不带包的回合也记下位置，或用客户端 ID（推迟）。
- **输入数据**：`BindingDelivery` 由送达行与交接单清单（range、body.sha256、reanchor、target.nativeEpoch）拼成，并带上记录它的那次提交写下的水位（`run.ended.binding` 的 sync 后值，或 `relay.input_recorded` 同事务的绑定）——清空核对的链回溯靠它。同 ID 的行只取最新一行；结算事件按 runId 对应 pending 的那次 Run。`owed` 的事实列表来自 `relay_digests` 的索引（seq、executedOn），被恢复终结的 Run 取 `session.recovered` 的 seq。
- **组合根**：生产里用 `new SqliteSessionStore(root, { recoverRelay })` 接入，留给阶段二。

### G069（阶段一）：Driver 的接力声明、命令解析与厂商键（2026-11-09）

范围只有静态声明与纯函数（终稿第 3.2、7.4、8.1、10.4 节）：六家的 `RelayCapabilities`（`probed=false`）、命令解析收敛到一个来源、端点层解析与厂商键、模型键。`TurnText` 放置与首行省略、`deliveryPosition`、`verifyDelivered`、`input_recorded`、`BackendResult.native`、`userTextOf`、`setTitle`、`NativeUsage.requests` 留给阶段二。独立审查之后做了一轮修正（下文“审查后的修正”），其中三处是有意的行为变化。证据见[验证记录](../verification/relay-g069-2026-11-09.md)。

**做法**：
- **命令解析一个来源**（`src/adapters/control/relay-classify.ts`）：各家的解析规则（Claude Code 去前导空白后的命令名与隐藏命令、Codex 精确的 `/export`、`/compact` 与 `/skill:`、OpenCode 去两端空白、Hermes 的 Python `lstrip()` 与注册表名字和别名、OpenClaw 按参数定效果、dsh 恒为内容）都在这里，按 `CommandLookup` 读目录。`HarnessControl.classify` 与声明里的 `commands.classify` 是同一个解析，差别只在声明另外标出把参数当提示提交的命令（`acceptsRelay`：Codex `/skill:`、Hermes `/queue`、`/steer`），`nativeReading()` 把它去掉。`control.ts` 增加 `CommandLookup`、`catalogCommands`、`sharedReading`，`listedCommand` 改为委托给它们。首次收敛零行为变化：8 个解析者 × 1,008 个输入 × 7 种目录 × 6 种附件组合，共 338,688 个结果，前后逐字节相同。
- **厂商键**（`src/adapters/control/relay-vendor.ts`）：`endpointLayers` 只列端点键（Claude Code 的 `env.ANTHROPIC_BASE_URL`、`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`；Codex 的 `openai_base_url` 与 `OPENAI_BASE_URL`；dsh 的 `DEEPSEEK_BASE_URL`；OpenCode 的 `provider.<p>.options.baseURL`；OpenClaw 的 `models.providers.<p>.baseUrl`），路径经 `harnessDirectories` 与原配置路径解析；`readEndpoint` 按层次从高到低取第一个给出端点的层，值当场只留主机名；失败只说哪一层、为什么（`not_a_file`、`too_large`、`unreadable`、`unparseable`、`invalid_endpoint`），状态里的来源是 `<层>:<该层的固定标签>`（如 `user_config:claude/settings.json`、`workspace_file:<workspace>/.env`、`environment:OPENAI_BASE_URL`），不带值、不带路径，解析器自己的报错文本也不保留；环境不枚举，dotenv 只取端点变量那一行；文件以不阻塞方式打开，在同一个描述符上 `fstat` 判常规文件后有界读取，检查与读取之间没有窗口。`vendorObservation` 对读不出的端点返回 null，`observedVendor` 因而给 `unknown:<harness>`。
- **声明**：Claude Code、Codex、OpenCode、Hermes、OpenClaw 的声明在各自 Driver 模块里，dsh 的在 `acp.ts`（dsh 跑在通用 ACP Driver 上，由工厂在建实例时交给它，此后该实例的 `classify` 就是声明的解析）；都是冻结的模块常量。`HarnessControl.relayCapabilities?` 指向同一对象；工厂另有不建实例的 `relayCapabilities(harnessId, protocol)`，Pi、Cursor 与通用 ACP 上的其他 Harness 为 null（按最保守声明对待）。
- **目录缓存**（`src/web/native-catalog-cache.ts`，经 G050）：命令项保留并校验 `contextEffect`（只接受契约的 `CONTEXT_EFFECTS`），缓存往返后的目录与 `models()` 现取的目录读法相同。文件仍是 v2，多一个可选字段；不认识它的旧构建会把整个文件当作读不了，报告一次、保持原样、观察只留在内存里（与 ADR-033 写的“更旧的 Hub 读到 v2 文件”同一处理）；目录本来就只给读它的那个构建复用。

**审查后的修正**（独立审查无阻断项，下列为重要与次要项的处置）：
- **dsh 的端点层**（按本机 `@deepseek-ai/dsh` 0.2.1-rc.5 的安装包源码只读核对）：dsh-llm-deepseek 取 `config.baseURL ?? environment.get("DEEPSEEK_BASE_URL") ?? 默认`，`environment` 是启动环境（dsh-launch-environment 的 process > project-env > user-env），不经凭据存储。所以层序是继承的环境 → 工作区 `.env` → `$DSH_HOME/.env`；`$DSH_HOME/.credentials.yaml` 不是端点层，删掉：它的 `refs`（CredentialRef → 字符串）与 `records` 由凭据服务解析 API key 之类的凭据引用，dsh 从不经它读基础地址，顶层键更是“保留但不解析”。审查报告按 credentials-local 的注释把它排在最前，那是凭据引用的优先级，不是基础地址的。另外 rc.5 的命令行（`--profile`，Hub 就这样启动它）把 `DEEPSEEK_BASE_URL` 列为只能由启动环境设置的变量（dsh-app-boot 的 `BOOTSTRAP_NAMES`），两个 `.env` 里写了它 dsh 会拒绝启动；这两层仍然读、仍按 `gateway:<host>` 记，是为了别的启动方式或别的版本接受它们时不被判成 `deepseek`——宁可多问一次。插件配置的 `baseURL`（最高一层）与 dsh-llm-pi-ai 的其他 Provider 路由都不读：**dsh 的厂商键只在已读的层里准确**，设了这两者的 profile 会被判错；保险是 G072 的探针门控（`probed=false` 时 `RELAY_TARGET_UNVERIFIED`），P14 必须覆盖 dsh 的 profile 与插件配置层之后才能翻转。上一稿“dsh 的 `DSH_*` 端点变量没有读”的说法不对：rc.5 源码里出现的 `DSH_*` 变量（`DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_WEB_URL` 等）没有一个是模型端点，这一前缀也是只能由启动环境设置的引导变量。
- **目录缓存剥掉 `contextEffect`**：见上；对照用例覆盖 Claude、OpenClaw、Hermes、OpenCode。
- **有意的行为变化一（原型链下标）**：`CLAUDE_LISTED_EFFECTS[name]`（解析与 Claude 的 `models()`）与 OpenClaw `models()` 的 `COMMAND_EFFECTS[...]` 改用 `Object.hasOwn`。目录里名叫 `constructor`、`toString`、`valueOf`、`hasOwnProperty`、`__proto__` 的命令从前拿到 `Object.prototype` 上的函数或对象作“效果”，现在 Claude 是 keep、OpenClaw 是目录给的效果（没有就是 unknown）。差分核对里只有这几个名字的结果变了，新结果都是契约里的效果值。
- **有意的行为变化二（dsh 的读法）**：持有注入声明的通用 ACP 实例委托给声明的 `commands.classify`，dsh 上任何输入都是内容；从前没有目录时 `/x` 是疑似命令（Runtime 因而先取一次目录），目录列出命令时是命令。没有注入声明的通用 ACP（Pi、Cursor 走各自的 Driver，Gemini 等走通用 Driver）读法不变。Runtime 路径有用例。
- **收紧一（Claude 的云后端开关加端点）**：`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 与 `ANTHROPIC_BASE_URL` 同时出现即歧义，一律 `unknown:claude`；只有开关没有端点时仍是 `aws-bedrock`、`google-vertex`。这是对第 8.1 节字面顺序（先看端点）的收紧，依据是推断：Bedrock、Vertex 模式下该变量多半不被使用。
- **收紧二（Codex 的端点只属于 openai）**：`OPENAI_BASE_URL`、`openai_base_url` 只在 Provider 缺省或为 `openai` 时应用，其他 Provider 一律不看。随之第 8.1 节的“ollama 且回环 → local”在阶段一走不到（ollama 自己的端点不读），Codex 的 ollama 记 `provider:ollama`。
- **类型（G066 的契约文件 `src/contracts/relay.ts`）**：`RelayCapabilities.commands.classify` 加第三个参数 `attachments: readonly ContentKind[]`，只是类型，不影响持久格式；`docs/contracts/switching.md` 的同一签名一并更新。另外，`relay.ts` 从 `control.ts` 再导出 `CommandClass`，阶段一给它加的可选 `acceptsRelay?: true` 也就间接改了 G066 的契约类型（只加可选字段，解析器不涉及）。
- **其余**：状态里的来源改为按层的固定标签（家目录在工作区里时用户层仍记 `user_config`，`CLAUDE_CONFIG_DIR` 在两者之外时状态里也没有绝对路径）；读文件改为 `open`（`O_NONBLOCK`）→ `fstat` → 有界读取；`inferred` 清单补齐并与下表机器核对。

**偏离终稿或简报之处**：
- 成员名按简报叫 `HarnessControl.relayCapabilities`（终稿第 3.2 节写 `HarnessControl.relay`）；工厂的静态读取多一个 `protocol` 参数（终稿 `factory.relayCapabilities(harnessId)`）：目录会并入上游的控制入口，同一个 Harness 可能经通用 ACP Driver 接入，Codex 又是按协议选 Driver 的。
- `CommandClass.acceptsRelay` 是可选的 `true`（终稿第 4 节是必有的布尔值），这样 `HarnessControl.classify` 的结果不变；经 `relay.ts` 的再导出，它也是 G066 契约类型的一部分（见上）。
- `VendorObservation` 没有 Provider 字段：Codex 的观测约定把线程的 `modelProvider` 写成模型的 `provider/` 前缀（`openai/gpt-5.5`），模型键照样去掉前缀。
- 回环端点除 Ollama、LM Studio 之外一律 `unknown:<harness>`：第 8.1 节在“非回环 → gateway”之后直接落到原厂键，照字面会把本机代理当成原厂；这里按第 10.4 节“判定不了 → unknown”。Claude Code 的 `external`、`gateway` 等其他登录种类同样是 `unknown:claude`。
- 工作区里的 Harness 设置文件记 `workspace_file`，`project_config` 没有用到。Ollama `*-cloud`（以及 `:cloud`）经回环端点时记 `gateway:<观测到的回环主机>`。
- 模型键：去 `provider/` 前缀（Hermes 是 `<provider>:` 前缀）、Bedrock 的地区与 `anthropic.` 前缀及 `-vN:M` 后缀、Vertex 的 `@日期`、日期快照与 `-latest`；`opus`、`sonnet` 这类别名保持为它自己的键。
- Claude 的声明按“Hub 提供自己的 `/export`”读目录：带附件的 `/export` 效果记 unknown；实例按 `models()` 当时的判断读，二者只在这一处可能不同。

**声明里不是第 8.1 节原文的格（待探针验证）**：第 8.1 节的各行没有标【推断】【假设】的格，但有些格写成“待探针”“未核实”“按模型族”，有些字段没写；这些格如实声明为最保守值或现码的读法，`probed` 全部为 false。下表与声明一致性测试（`tests/protocol/relay-capabilities.test.ts` 的 `inferred`）逐项相同，测试读本节核对：

| Harness | 待探针的格 |
|---|---|
| claude | `fixedPrefix` `hostPathRead` `sessionTools` `window` `delivery.lateDelivery` `placement.maxInput` `placement.pointersAfterUser` `vendor.loopback` `vendor.signin` `vendor.backendWithEndpoint` |
| codex | `fixedPrefix` `hostPathRead` `sessionTools` `window` `delivery.lateDelivery` `placement.pointersAfterUser` `commands.unlistedSlash` `vendor.provider` `vendor.loopback` `vendor.endpointProvider` |
| opencode | `fixedPrefix` `hostPathRead` `sessionTools` `window` `delivery.successProvesRecorded` `commands.unlistedSlash` `placement.maxInput` `placement.pointersAfterUser` `cacheTtl` `title` `vendor.loopback` `vendor.otherProvider` |
| dsh | `fixedPrefix` `hostPathRead` `sessionTools` `window` `delivery.lateDelivery` `placement.maxInput` `placement.pointersAfterUser` `title` `vendor.loopback` `vendor.layers` |
| hermes | `fixedPrefix` `hostPathRead` `sessionTools` `window` `delivery.successProvesRecorded` `delivery.lateDelivery` `commands.hidden` `placement.maxInput` `cacheTtl` `vendor.noEndpoint` |
| openclaw | `fixedPrefix` `hostPathRead` `sessionTools` `window` `commands.unlistedSlash` `compactionEvidence` `title` `placement.pointersAfterUser` `vendor.loopback` `vendor.otherProvider` |

各格的含义：`fixedPrefix: null`、`hostPathRead: "none"`（v1.1 未启用）、`sessionTools: null`（v1.2）六家都不是原文；`window` 由“usage.size”“sessions.describe”译为 `session_report`、由 Codex 每回合的 `modelContextWindow` 译为 `turn_report`；`placement.maxInput: null` 是没写输入上限的四家；`placement.pointersAfterUser: false` 是 Hermes 以外的五家（只有 Hermes 写了附件指针在原话之后）；`delivery.lateDelivery: false` 是没写它的四家；`delivery.successProvesRecorded: true` 由 OpenCode、Hermes 的 E3 一格推出；`commands.unlistedSlash: "text"` 是 Codex、OpenCode、OpenClaw 按现码的解析（OpenClaw 属 Q10）；`commands.hidden` 是 Hermes 按现码的 `new`、`clear`；`cacheTtl: "unknown"` 是原文“按模型族”；`compactionEvidence: "none"` 是 OpenClaw 的“未核实”；`title: "none"` 是 OpenClaw 的“待探针”与 OpenCode、dsh 的“未保证”。厂商键一列：`vendor.loopback`（回环端点记 unknown）、`vendor.signin`（Claude 的其他登录种类记 unknown）、`vendor.backendWithEndpoint`（Claude 开关加端点记 unknown）、`vendor.provider`（Codex 的 Provider 写在模型前缀里）、`vendor.endpointProvider`（Codex 的端点只属于 openai）、`vendor.otherProvider`（OpenCode、OpenClaw 未点名的 Provider 记 `provider:<name>`）、`vendor.layers`（dsh 只读三层，插件配置与 pi-ai 路由不读）、`vendor.noEndpoint`（Hermes 没有端点即 unknown）。

端点层的顺序（Q24）：Claude Code 工作区 `settings.local.json` → `settings.json` → 用户 `settings.json` → 进程环境；Codex 工作区 → 用户 `config.toml` → `OPENAI_BASE_URL`；dsh 继承的环境 → 工作区 `.env` → `$DSH_HOME/.env`（rc.5 源码核对过，见上）；OpenCode 工作区 `opencode.jsonc` → `opencode.json` → 用户的两个。Claude Code 的开关按 1、true、yes、on 判真（设置里写成 JSON 数字或布尔值的按它在环境里的文本）。已知读不到的层：Hermes 的 Provider 端点键第 8.1 节没有点名，Hermes 的厂商键阶段一恒为 `unknown:hermes`；dsh 的插件配置 `baseURL` 与 pi-ai 路由、Claude Code 的组织管理设置、Codex 的 `model_providers.*.base_url` 与 OSS 端点、OpenCode 的 `OPENCODE_CONFIG` 自定义路径都没有读。

**已裁定与推迟**（2026-11-09 主负责人裁定）：
- 回环端点记 `unknown:<harness>`：接受；应回写终稿第 8.1、10.4 节的文字（本补记不改终稿原文）。
- 工作区内的设置文件记 `workspace_file`：保留；`project_config` 目前没有使用，枚举里保留（不动持久格式），删不删待 G072 决定。
- dsh 的读法：已改为委托声明（见上），不另建子类。
- 待 G072、G073：
  - `VendorObservation` 加 Provider 与端点状态，会改变绑定里缓存的 `vendorObserved` 的持久格式（G066 契约与 `MAX_BINDING_RELAY_BYTES`），等 G072 做协调器时一并决定。建议形状一：`provider: string | null`（≤128 B，Driver 报告的 Provider 名，Codex 的 `modelProvider`、OpenCode 与 OpenClaw 的前缀），理由是厂商键不该靠解析模型名；建议形状二：`endpoint` 改为 `{ kind: "known"; host; layer } | { kind: "default" } | { kind: "unknown"; layer; problem }`，理由是“读不出”与“没有端点”必须在缓存里也分得开，否则受理时会按 `endpoint: null` 判成原厂。
  - Ollama `*-cloud` 的键名：`gateway:127.0.0.1` 在同意文案里读不懂，审查者建议 `provider:ollama-cloud`，留给 G073 定文案。
  - 主机名判定偏保守的几处（`localhost.` 尾点与含 `_` 的主机判为无效端点即 unknown，`0.0.0.0` 不算回环而记 `gateway:0.0.0.0`）：只记一笔，不改。

**给阶段二的接缝**：
- Driver 在 `open()` 之后用 `readEndpoint(harness, {home, values: 交给 Harness 的环境, workspace}, provider)` 读端点，用 `vendorObservation(reading, model, authKind, declaration.normalizeModel)` 组观测；Claude 的 `authKind` 取 `_auth/status_update` 的 kind（现在只用来判就绪），Codex 的 `modelProvider` 写进模型前缀。
- 首行省略与命令跳过读声明的 `commands.classify`（传入附件种类；`possible_command` 按命令对待），`acceptsRelay` 的命令可以捎带；`placement` 的 `parts`、`pointersAfterUser`、`maxInput` 决定 `TurnText` 的拼法与越限降档。
- 受理时（G072）按 `relayCapabilities(harnessId, protocol)` 读声明，目录取自缓存时经 `relayEntries()` 变成声明的目录。缓存现在保留每个命令的 `contextEffect`，读法与 `models()` 现取的目录相同；上一稿“各 Driver 的 `models()` 本来就补齐了效果”对缓存不成立（缓存当时剥掉了它），已修。缓存不存 `hiddenCommands`，各家的隐藏命令在解析规则里，不依赖目录。

**经既有所有者修改的文件**：`src/contracts/control.ts`（G007）；`src/contracts/relay.ts`（G066，只改 `classify` 的类型）；`src/adapters/control/acp.ts`、`claude.ts`、`opencode.ts`、`hermes.ts`、`openclaw.ts`、`factory.ts`（G032）；`src/adapters/control/codex.ts`（G034）；`src/web/native-catalog-cache.ts`（G050）；`docs/contracts/switching.md`（C006，`classify` 签名与成员名）；ADR-033 的“影响”补一行。`hermes-gateway.ts`、`binding-factory.ts` 没有动。两个新源文件属 G069 的 `owns`，但 `plan/slices.json` 的 relay 切片 `allowed_files` 还没有列它们，`python3 tools/check_design.py` 因此报“application source outside approved slice”两行，由主负责人集成时登记；`plan/` 下 G069 的用例状态仍是 planned，声明一致性与对照用例 G069-D01–D04 没有计划条目。
