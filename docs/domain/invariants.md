# 核心不变量

状态：proposed。每条必须映射到自动测试或明确人工证据；测试矩阵记录覆盖范围。INV-13、INV-14、INV-22 按 [ADR-055](../decisions/0055-relay-and-context-scheduling.md) 改写，INV-21 按 ADR-055 扩展，INV-29–36 由 ADR-055 新增（接力系统，2026-11-03），已于 2026-11-03 随 ADR-055 接受，尚未实现、未经真机验证；这些条目的所有者、检查方式与计划用例见下文“接力不变量（ADR-055）”一节。INV-37–42 由 [ADR-056](../decisions/0056-native-hosts-and-sessions.md)（原生宿主与会话租借，2026-11-03 接受）提出，未实现，见下文“宿主与会话租借不变量（ADR-056）”一节。

| ID | 不变量 |
|---|---|
| INV-01 | 公共 Session 身份不随 Harness、BackendBinding 或 Provider 变化 |
| INV-02 | 同一 Session/epoch 同时最多一个有执行权的 Attempt |
| INV-03 | 同一受管理工作区同时最多一个有效写租约；租约不冒充 OS 沙箱 |
| INV-04 | 迟到事件、取消和权限响应不能影响下一 Attempt/epoch |
| INV-05 | 用户明确的 Harness/Provider/模型选择不能静默替换；自动模式的变更有独立决策记录 |
| INV-06 | 输入、终态、权限决定和选择生效先持久提交，后对外发布或发送 |
| INV-07 | 同 principal、scope、Idempotency-Key、等价输入只能产生一个意图；同 key 异输入冲突 |
| INV-08 | 每个 Attempt 只能有一个终态事实，晚到完成不能覆盖已仲裁的取消/期限 |
| INV-09 | 输入接收、协议完成、任务达标、后端应用权限和清理确认分别表达 |
| INV-10 | 执行预算从派发开始，覆盖上下文、启动、模型、工具和结算，等待用户时暂停；外部等待（等待用户决定、排队等待工作区）消耗独立的等待预算；两者到期都经停止链结算，不自动重跑；清理 grace 单独记录（ADR-036） |
| INV-11 | 未知副作用、崩溃或无法确认结束的尝试不自动重跑 |
| INV-12 | 未确认停止/写权隔离前不能让新执行者写同一工作区 |
| INV-13 | 交接单不可变、ID 只由正文派生：正文不变则 ID 与清单不变；清单逐项记录由正文决定的渲染输入（来源区间、策略与渲染器版本、事实指纹、观测指纹、语言、摘要状态、用户编辑与放行），逐 Run 的同意 seq、当前输入指纹与脱敏上下文（规则版本、keyId、集合 HMAC）在送达行；满足恒等式的省略账目、脱敏计数；每条可交接的有效事实要么被渲染，要么被计数，要么记入“未统计”；写入时校验 fold 单元已终结且其用户消息早于当前输入 |
| INV-14 | A 已知的公共事实只由当前 `nativeEpoch` 的送达水位（正面证据或亲历）与清空下限 `epochFloor` 决定，下限随绑定谱系保留；原生位置与送达水位是不同事实；fork 精确性读原生位置且要求源绑定 synced、need(through)=∅、位置在当前纪元内；配置承接（ADR-028）读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 input≠not_recorded 的 Run，跨因清空归档的绑定（VF1-10）；已派发不算送达；clear 经 Hub 确认后进入新纪元并记录下限，确认不了即待核；rewind、未知命令、未知送达、未知回合转待核；待核的绑定在核对、用户选择或策略决定之前不在其水位上组包：默认（`relay.whenUnsure=auto`）由策略决定，策略只做三件事——原样单发（绑定逐字节不变）、补发待核的那份包（每包自动至多一次，更新的外来事实到来才再发）、退到纪元基准后补发完整交接单——从不抬水位、不抬清空下限、不换原生会话；`whenUnsure=ask` 时恢复先核对或由用户选择（cause ∈ {legacy, marker_absent} 且 need=∅ 除外；没有外来事实的单 Harness 对话不核对也不阻挡）；pending 只核对待核的那份包自己 |
| INV-15 | 停用/移除只影响新 admission；已有执行和历史 revision 按明确排空规则处理 |
| INV-16 | 能力的声明、观察、验证、平台和版本是不同事实；未知不能当支持 |
| INV-17 | 秘密仅交给所属边界，不进入公共消息、事件、选择快照、argv 或错误 |
| INV-18 | 每次模型调用/工具/权限都能关联实际 Attempt 与绑定；账本不能由配置猜测 |
| INV-19 | SSE/订阅断开不取消执行；重放允许重复，客户端可按稳定身份去重 |
| INV-20 | 慢订阅者和巨大输出不能造成无界内存；超限明确失败或转不可变产物 |
| INV-21 | 切换请求与生效不同；交接失败保留公共 Session 和真实结果，不假称迁移成功；切换生效与交接送达分别表达；分隔线与“已接棒”只在证据后出现；准备失败不派发、relay 状态不变（open 后失败时原生会话与绑定按第 9 节保留）；只关乎交接单的准备失败（渲染、脱敏、配额、同意日志、放不下最小交接单）默认（`whenUnsure=auto`）降为原样发送、relay 状态不变，用户明确要求附上（`attach:"full"`、`resend`）时仍让 Run 失败、草稿保留；停止未确认时待决切换失败而不悬挂 |
| INV-22 | 配置与原生状态不能替代公共事实源；读模型可重建；同一 `policyVersion` 与同一脱敏上下文下，RunDigest 与交接单可由公共事实（快照、事件、已落库的内容）加已落库的工作区观测逐字节重建；摘要只由已提交的事实生成；摘要记录命中区间，重建先套区间；`harness_note` 只保证可追溯 |
| INV-23 | 存储失败停止接收新执行并进入受控收敛；不能声称不存在的终态已落库 |
| INV-24 | 自动路由只在经过硬约束的候选中选择；质量证据不足时不声称最佳 |
| INV-25 | API、CLI、界面和 SDK 使用相同命令语义；UI 不持有独立执行权 |
| INV-26 | 所有进程、流、计时器、后台工作有所有者、上限和可等待关闭入口 |
| INV-27 | 已取消/关闭的未启动 Turn 留 tombstone；旧 outbox 首次投递也不能获得新启动授权 |
| INV-28 | Owner 接管必须取得排他权并推进持久代次，旧 owner/旧授权不能复活仲裁或派发 |
| INV-29 | 跨 Harness 发出的内容先经已知秘密精确匹配（按名定集合、10 种形式、骨架视图、ANSI 先删）与形状规则脱敏，当前输入（第二段）除外；扫描器出错即不发；出境字节、`relay_*` 表、`relay_log`、接力事件、日志与诊断、错误信息不含秘密原值及其未加盐哈希；钉住按位置存不存原文 |
| INV-30 | 外来事实为空的绑定（从未交接、或清空后未选附上）收到的每条输入与用户原文逐字节相同；`attach:"none"` 的回合（用户选的单发，或策略决定的单发 `alone{by:"policy"}`）逐字节相同、绑定逐字节不变、不产生送达行与证据；携带包时第二段等于原话；每个原生纪元至多一份完整交接单（前一份 not_recorded、unknown 待核或用户再附除外；待核时策略补发的完整交接单每次待核至多一份），之后只追加 delta 与 anchor；同一纪元内 mark 只在 suspect 回退时变小，确认的清空进入新纪元 |
| INV-31 | 一个 Run 至多携带一份交接单（增量可含要点小节）；送达结论只由逐回合证据决定，与终态无关；送达结论不写进已终结的 Run；正面证据可纠正 unknown 与 not_recorded；同值写不算转换 |
| INV-32 | 没有照录的可交接事实必须计入省略账目并给出取回位置，或写明“不可取回”“未统计”；账目恒等式成立 |
| INV-33 | 每次跨厂商派发都有一条先于它提交的 `relay_log` 记录，送达行名该行的 seq：用户的同意，或 `relay.crossVendor=allow`（默认）时该厂商键第一次使用写下的一行（来源 default，全局，`command_id` 取 `default-allow:<厂商键>:<policyVersion>` 以幂等，`unknown:*`、`gateway:*`、`router:*`、`provider:*` 与来源是工作区文件的端点同样如此，并随首次使用给出不拦路的提示）；撤回后不再向该厂商发出历史，默认不改写撤回，用户不撤回时才是默认允许；本纪元内厂商键变化记 `relay.vendor_changed` 不拦；厂商键由 Driver 按机制与它自己解析的端点声明；目的厂商指主模型请求的实际处理方；Harness 自配的辅助模型与记忆不在 Hub 可见范围；`relay.crossVendor=ask` 时恢复原条款：没有目的厂商键的同意记录不向该厂商发出历史，本纪元内厂商键变化须重新同意，`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`，来源是工作区文件的端点每个会话都问，默认写下的行不算用户给的同意；登记过的唯一例外：厂商键为 `local`（Driver 报告回环端点且模型不转云端）且用户在设置页标记“本机模型不出网”（`relay_prefs` 的 `relay.localModelsOffline=true`）时在 `ask` 下免同意，`allow` 下该设置不起作用（首次使用照写一行） |
| INV-34 | 按会话注入的工具在建会话时固定，中途不增不减；规格零凭据、只读 |
| INV-35 | 任何 relay 行的上限在进入事务前按序列化字节校验；转换在应用层先校验；派生行在 SAVEPOINT 内；**预期内的接力失败**（校验、渲染、脱敏、配额、分类、同意）默认（`whenUnsure=auto`）不让本 Run 失败：只关乎交接单的降为原样发送，本 Run 的消息本身发不出（目标启动失败、原话超过通道上限、存储故障）才失败；`whenUnsure=ask` 或用户明确要求附上时它们只让本 Run 失败；任何情况下都不让 Store 进入 failed、不让 Runtime fatal、不波及其他会话；SQLite 约束错误仍是 bug，由应用层校验与无效样例保证不出现（F08） |
| INV-36 | 数据根、HMAC 密钥与工作区按 `(st_dev, st_ino)` 互不包含，这一条检查并提示：包含时启动告警、该工作区的界面横幅提示，携带接力内容的跨厂商回合（任一来源的厂商键与目的不同）照常进行（`relay.dataRootInWorkspace=warn`，默认）；`block` 时它才是跨厂商交接的前提，包含时携带接力内容的跨厂商回合受理即失败并提示；同厂商与单 Harness 对话继续；附件物化目录与密钥不在数据根内，不因设置放宽 |
| INV-37 | 一个原生会话同一时刻至多被一个会话租借持有；租借只由当前选择纪元的 Run 或开启了后台保持的对话取得；迟到的释放、关闭与事件不影响新的租借；宿主上的原生事件只归属持有该会话租借的 Run，附着的子线程与他人的会话不归属（ADR-056） |
| INV-38 | 宿主复用不改变原生会话的内容语义：续用前必须通过新鲜度判定，命中任一不新鲜条件（原程序里继续过、结果未知、绑定未确认或分支中、接力待核、原生命令效果为 clear / rewind / unknown、配置或安装指纹变化、启动参数变化、工作区身份变化、宿主不健康、不可检测）的会话必须重新打开或先核对；判定依据与结果记入事件（ADR-056） |
| INV-39 | 空闲且未固定的宿主不持有工作区写租约；持有写租约的宿主要么正在执行回合，要么被开启了后台保持的对话固定；空闲时可能写工作区的程序不能空闲入池，只能固定或关闭（ADR-056） |
| INV-40 | 宿主在持久登记其进程组身份（组号与组长启动时间）之后才承载回合；所有者结束后，新所有者按登记识别并结束遗留宿主，结果为 terminated、gone 或 unconfirmed 并记入事件；unconfirmed 不释放任何工作区租约（ADR-056） |
| INV-41 | 宿主预算是单一的全局预算：运行中、空闲与固定的宿主计入同一上限；超限只淘汰空闲且未固定的宿主，从不结束正在执行回合或固定的宿主；不能新建时回合等待空位并可见，不静默拒绝（ADR-056） |
| INV-42 | 预热与保活不得建立原生会话：原生会话只在回合取得工作区租约之后建立，没有会话的宿主只保住进程（ADR-056） |

## 接力不变量（ADR-055）

状态：已接受（[ADR-055](../decisions/0055-relay-and-context-scheduling.md)，2026-11-03 验收）。陈述以上表为准，出处是[接力系统终稿](../proposals/relay/relay-architecture.md)（下称“终稿”）第 14.3 节；本节逐条记录变更、所有者、检查方式、状态与说明。上表与本节里的“第 N 节”都指终稿的节号；VF1-10、F08、J1 M11 这类编号是各轮审查的发现与要求，处置见终稿第 18 节与[第四轮处置表](../proposals/relay/round4/v3-dispositions.md)。

- **编号**：终稿 14.3 把 INV-29、INV-30、INV-33 标为“改”、把 INV-35 的变化写作“收窄”，都是相对[第二版草案](../proposals/relay/round3/v2-architecture.md)而言；本文件此前只登记到 INV-28，INV-29–36 在这里都是首次登记。
- **所有者**：终稿第 17 节在“需求 · 不变量”列登记该条的任务；括号里是该任务负责的部分，取自第 17 节的范围与新建文件。第 17 节另让这些任务承担陈述未变的 INV-05、06、09、11、16、17、20、23、25、26，并把本文件划归改写后的 C006。
- **检查方式**：全部是计划中的自动测试，尚未编写。unit、integration、property、security、e2e 层用真实存储与假 Harness（第 17 节：真实的 `SqliteSessionStore`、`LocalContentStore` 与走 stdio 的 `tests/fixtures/control-peer.mjs`）；probe 层是 RelayConformance 真机探针（确定性判定，按各 Harness 最新正式版运行，第 13.3 节）。没有只靠人工审查的条目。计划用例按第 17 节登记进 `plan/test-cases.json` 之后，设计检查（`python3 -I tools/check_design.py`）核对每条不变量至少有一条计划用例。
- **状态**：全部已接受（ADR-055，2026-11-03 验收），尚未实现。依赖终稿 D1–D11 取舍的地方按推荐项登记（用户 2026-11-03 按推荐项接受）。本节的数字都是终稿给定的设计常量或测试参数，不是实测。
- **默认放行（2026-11-10）**：用户当天决定“不要限制太多，不要防御性做产品”，审批代理把它落成[规则](../proposals/relay/permissive-defaults.md)，上表 INV-14、21、30、33、35、36 与下面各节按它改写：**机制保留为严格设置，默认值反转**。六个偏好（`relay_prefs`，默认值在 `RELAY_PREF_DEFAULTS`）：`relay.crossVendor`（默认 `allow`）、`relay.whenUnsure`（默认 `auto`）、`relay.allowUnprobed`（默认 `true`）、`relay.dataRootInWorkspace`（默认 `warn`）、`relay.returnPreference`、`relay.localModelsOffline`；把前四个设为 `ask`、`ask`、`false`、`block`（`RELAY_STRICT_PREFS`）即恢复此前严格的行为，既有的严格用例在这四个设置下原样通过（P9）。**不变的底线**（任何设置下）：不丢事实；不谎报送达；核对不把“没看到”说成“没有”；不隐式改换 Harness、模型或配置；清空只由用户的操作或确凿证据确认；INV-11、13、22、29、31、32、34。默认模式的检查：`tests/integration/relay-permissive.test.ts`（总表 20 行）、`tests/property/relay-delivery.test.ts` 的 G072-PP01（P1–P7、P9）、`tests/property/relay-coordinator.test.ts` 的 G072-PP02（P1、P8）、`tests/unit/relay-coordinator.test.ts` 与 `tests/unit/relay-delivery.test.ts` 的 permissive 用例。

### INV-13（改写）

- 变更：原文“ContextManifest 的所有来源 ID、水位、内容指纹和策略版本可追溯；不静默丢弃事实”。ContextManifest 由交接单（`RelayPacket`）的清单与送达行（`DeliveryRecord`）取代；C006 把 `contracts/context.schema.json` 改写为这两者的 JSON Schema（第 17 节）。
- 所有者：G070（渲染、ID 派生、清单与省略账目，`src/contexts/session/domain/relay/packet.ts`）；G066（`relay_packets` 写入时的 fold 校验）；G067（v12 过渡期的来源过滤：排除未派发的 Run，第 7.6 节）。
- 检查方式：自动测试——属性测试（J1 M11）；重渲染 100 次 1 个 sha。计划用例：G070-P01（property）、G070-C01（unit）、G066-C03（integration，fold 校验）。
- 状态：已接受（ADR-055）。
- 说明：ID 为 `"relay-"` + 20 位 Crockford base32(sha256(最终正文，ID 槽位为占位符))（第 4、5.5 节）。交接单以 `INSERT … ON CONFLICT(session_id, packet_id) DO NOTHING` 入库；`manifest_json` 只含由正文决定的字段，逐 Run 的字段（同意 seq、输入 HMAC、送达位置、压缩游标、重发关系）在 `relay_deliveries`；清单头相同而字节不同在进入事务之前检出，该 Run 以 `RELAY_PREPARE_FAILED{reason:"render_mismatch"}` 失败；fold 校验不满足即 `RELAY_PREPARE_FAILED{reason:"render"}`（第 14.1 节）。当前输入指纹是 HMAC（`inputHmac`），不是未加盐的 sha256（INV-29）。脱敏上下文（`rulesVersion`、`keyId`、`setHmac`）记在送达行，不进清单；正文不变时 ID 与清单不变，脱敏上下文变化只在它改变了正文时才自然产生新 ID，`supersedes` 只用于 resend（第 10.2 节，写入阶段修订）。

### INV-14（改写）

- 变更：原文“返回 A 时不能复用未同步 B 已完成变更的旧原生上下文”，改为由送达水位、清空下限与待核规则决定 A 已知哪些事实。
- 所有者：G068（状态 × 事件全表、`planReturn` 的核对计划、`epochFloor` 与压缩游标的更新、`recoverRelay`：`src/contexts/session/domain/relay/delivery.ts`、`recover.ts`）；G066（`binding.relay`、迁移的纪元谱系、`assertSessionTransition` 的新规则）；G067（v12 推进规则，`src/contexts/session/domain/relay/advance.ts`）；G072（`admit` 的选择检查与 A→B→A 的接入，G072-C07）。
- 检查方式：自动测试——属性测试：任意证据序列下水位单调且不超过实际送达或亲历，回退不低于下限；清空后 20 轮 `dispatched === input`；A 清空 → B 两轮 → 回 A 只补 B；旧包 present 不推进 pending 包。计划用例：G068-P01（property）、G068-C05、G068-C06、G068-C07（integration）。默认放行：G072-PP01（property，策略决定下的 P1–P7、P9，参考模型同上）、`relay-permissive.test.ts` 的行 1–9（integration）。
- 状态：已接受（ADR-055）。
- 说明：
  - “待核”指 `pending` 与 `suspect` 两种同步状态（第 7.2 节）。need=∅ 时只对 `legacy`、`marker_absent` 两种 cause 放行；`rewind`、`unknown_command`、`clear_unconfirmed`、`unknown_turn` 在存在外来事实时先核对，无法核对时由用户选择（`RELAY_CHOICE_REQUIRED{cause:"verify_required"}`）；没有外来事实的单 Harness 对话不核对也不阻挡；`SuspectCause` 共 6 种，每种都由第 7.2 节的某个转换产生；`verify=on_next_open` 的 Driver 在绑定为 suspect 或 pending 时、`verify=after_turn` 的 Driver 在绑定为 suspect 时不复用保留进程（第 7.2、7.4 节）。
  - need 的下界恒为 max(mark, epochFloor)；只有用户一次性选择“附上交接单”（`relay.attach:"full"`）时忽略下限（第 6.3、7.4 节）。
  - 清空下限只在核对确知清空时抬高：回放为空，或水位所站的链全部不在且每个标记都排除了压缩（送达行记有游标且未变）；回退类待核与未确认的清空在核对前叠加时保留水位、清空的 seq 与 carried，并标 `rewound`，链全部不在不再视同清空、由用户选择。回放为空即按清空处理，不区分是清空还是回退清空的（`/undo` 撤空唯一一轮后再一次没执行的 `/clear` 也抬起下限：原生上下文确实为空，下限之前的外来事实照清空后的规则可用“附上”取回，N7）。水位恢复只恢复到仍有标记在场的链节点，或不声称任何外来事实的水位（无水位、native、origin、无包 ID 的回退水位）；legacy 水位不恢复；Driver 不能核对时，未确认的清空在这样的水位上按“没有发生”处理，下限不抬（ADR-055 G068 补记，审批代理 2026-11-09、2026-11-10 的决定）。
  - Driver 自述的清空（`BackendResult.native.cleared`）怎么算（独立审查 I2，ADR-055 B7）：放弃了原生会话的（`replaced` 非空，Claude Code 的合成清空是 Hub 自己的 Driver 所为）在该回合的原生状态确认后即确认；靠原生侧自己的信号得出的（`replaced` 为空：Hermes 的固定回执、OpenClaw 的 `lifecycleRevision`）只对探针已证明该信号的 Driver（`declaration.probed`）算确认，未探针时是未确认的清空（事件 e′，命令按声明的效果、内容回合同样）：下限与纪元不动，由下一次打开或回合结算的核对（回放为空、链全部不在且排除了压缩）或用户的［确认已清空］确认——清空只由用户的操作或确凿证据确认，Driver 未经验证的自述不是。
  - pending 不能自动重发（`autoResends=1` 或 `lateDelivery`）时，`relay.whenUnsure=ask` 下下一条内容输入在受理时同步 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}`（D1 推荐项 (a)，第 7.4 节）；默认（`auto`）不问：能给出证据的 Driver 每包自动补发一次（`lateDelivery` 的也是一次，重发模板自带去重行），之后原样单发、绑定不变，更新的外来事实（新包的 through seq 严格大于待核包的）到来才再发一次（`resend.by:"grown"`，自动计数归零），不能给出证据的 Driver（未声明的）从不自动补发；待核的 suspect 在没有新欠交时原样单发并保持待核，有新欠交（水位之上还有外来事实）时退到纪元基准后补发完整交接单，未确认的清空一律按“没清空”处理（下限不抬、纪元不加）。每包的自动发送至多两次（首发加一次补发），除非更新的外来事实或新的待核判定出现（P5、P6）。“未知回合”是 process 型 Driver 在 unknown 回合之后继续原会话的 `suspect{unknown_turn}`（D6 推荐项 (a)，由探针 P16 门控，第 9 节）。
  - v12 过渡期（G067）只落实第 7.6 节的推进规则 `advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ 已重发一次))`；那时没有纪元与清空下限，清空、回退与效果未知的命令只记 `contextEffect`、不改水位，配置承接取该绑定最后一个已派发的 Run。第 7.6 节把这些列为已知局限，v13 关闭。

### INV-21（扩展）

- 变更：保留原文“切换请求与生效不同；交接失败保留公共 Session 和真实结果，不假称迁移成功”，追加终稿 14.3 的四个分句。
- 所有者：G072（open 之后的准备失败；S5 的等待、停止并切换与停止未确认）；G073（分隔线与“已接棒”按证据显示）；G068（恢复：`recoverRelay`）；G067（v12：unsafe 结束时待决切换记为 failed）。
- 检查方式：自动测试——浏览器测试三种证据路径；故障注入；宽限到期后仍能 resume。计划用例：G073-C01（e2e）、G072-C04（integration）、G068-C08（integration）、G067-C07（integration，“宽限到期后仍能 resume”，写入阶段补入 14.3）。默认放行：`relay-permissive.test.ts` 的行 15、16、19、20（integration，故障注入：脱敏读不到密钥、Store 拒绝交接单行、同意日志写不进、窗口放不下）。“relay 状态不变”指不建交接单行、送达行与 pending、水位不被这次准备推进；open 时回放核对得到的结果是事实，照常随 `run.ended` 提交（第 9 节）。
- 状态：已接受（ADR-055）。
- 说明：错误按阶段归属（第 9 节）：受理时能判定的同步 409，不建 Run、没有进程；启动前（`prePlan`）失败的 Run 没有进程、绑定不变；open 之后（finalize、同意复检、分类复核、精化窗口）失败的 Run 未派发，原生会话与绑定保留（新建的空原生会话下一次按它 resume，不再新建），relay 状态不变，错误经 `run.ended` 与 SSE 到达。停止未确认时，unsafe 的 `run.ended` 在同一事务里把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`、等待它的排队 Run 记为 `SWITCH_NOT_EFFECTIVE`（第 9 节）。
  - 默认放行（`relay.whenUnsure=auto`，2026-11-10）：只关乎交接单的准备失败——渲染（`render`、`render_mismatch`）、脱敏读不到密钥或扫描出错（`redaction_failed`）、交接单行被 Store 拒绝（`storage`、`storage_quota`）、同意日志写不进（`consent_log_full`）、窗口放不下最小交接单（`RELAY_INPUT_LIMIT`）、relay 记录没能恢复（`recovery_failed`）、同意被撤回——不让 Run 失败：这条消息原样发出，relay 状态不变（不建交接单行、送达行与 pending），原因记入 `run.context_prepared.data.relay.decision`，下一条会再试。用户明确要求附上（`attach:"full"`、`resend`、`clearConfirmed`、`native:"new"`）时不改写：仍让 Run 失败、草稿保留。`target_start`（目标启动失败）与 Driver 的整回合拒绝（B4b）仍使 Run 失败，什么都没发。

### INV-22（改写）

- 变更：原文“配置与原生状态不能替代公共事实源；派生摘要、读模型可重建”。“派生摘要可重建”换成终稿 14.3 对 RunDigest 与交接单的表述；“配置与原生状态不能替代公共事实源”“读模型可重建”两句保留——终稿 14.3 在写入阶段修订后同样保留这两句、把接力条款作为补充，因为终稿第 1 节的硬约束仍以 INV-13、INV-22 表达“公共 Session 是唯一业务权威，派生物可追溯、可重建”，`plan/test-cases.json` 里也有标注 INV-22 的非接力用例（如 G008-C01、G015-C03、G057-C01、G060-NC1）。
- 所有者：G070（RunDigest 与索引、命中区间、`bound()` 收紧，`src/contexts/session/domain/relay/digest.ts`）；G066（`relay_digests` 表与不升 version 的 `relayWrite`）。
- 检查方式：自动测试——500 个随机会话增量 = 重建；故障注入（earlyClose、storeDetail 失败）下重建值与在线值相同。计划用例：G070-P02（property）、G070-C06（integration）。
- 状态：已接受（ADR-055）。
- 说明：摘要用安装级秘密集合，在 `run.ended` 时固定，目标新带来的值只在出境前的最终复扫里补上，集合变化不让摘要整体 behind（第 6.4、10.2 节）；摘要只记命中区间 `(ref, offset, length)`、不记值，重建时先套历史区间再扫当前集合，集合变小也不会让曾脱敏的位置复现（第 10.2 节）。派生写入失败只把该 Run 的摘要标为 behind 并异步补建，`run.ended` 照常提交（第 6.4、9 节）。`harness_note` 是交出方说明，v2 不提供入口（第 5.1、9 节）。

### INV-29（新增）

- 所有者：G070（脱敏的应用 `src/contexts/session/domain/relay/redaction.ts`、规则数据 `src/infrastructure/text/secret-rules.ts`、HMAC 密钥 `src/infrastructure/session/relay-keys.ts`）；G073（API 侧，AP-01–AP-03，第 17 节 G073 行在写入阶段补列了 INV-29）。
- 检查方式：自动测试——grep 原值、sha256/sha1/md5(原值) = 0；变异测试；RD-01–RD-10。计划用例：G070-S01…S10（security，RD-01–RD-10）、G073-S01（security，AP-01–AP-03）。
- 状态：已接受（ADR-055）。
- 说明：
  - 范围（第 10.2 节“INV-29 的范围”）：覆盖出境字节、`relay_*` 表、`relay_log`、接力事件的新增字段、日志与诊断、错误信息；不覆盖按设计逐字保存的公共事实（快照里的原话与回复、`run.output`）。relay 字段里凡可能对应秘密的值（原话指纹、发出字节指纹）一律用 HMAC 子密钥，不用未加盐 sha256。
  - 当前输入：第二段永远原样、不脱敏；当前输入里有疑似密钥命中时省略首行并在卡片提示（D4 推荐项 (a)，第 5.5、12.1 节）。“当前输入（第二段）除外”也适用于本条“出境字节……不含秘密原值”一句（按 D4 推荐项，第二段逐字节发送；终稿 14.3 已写明）。第 10.6 节威胁模型表“用户贴入的内容”一行在写入阶段改为“当前输入（第二段）永远原样、不脱敏”，与本条一致。`relayRequest.fingerprint` 等指纹一律用 HMAC 子密钥（`HmacDigest`）。
  - 扫描器本身抛错才 `RELAY_PREPARE_FAILED{reason:"redaction_failed"}`；单个条目超过扫描上限只省略这一条并记 `unscanned`，不 fail closed。按名定集合、10 种形式、安装级与会话两个集合、标签写法见第 10.2 节。
  - 已知违例：现有命令指纹是 `JSON.stringify` 之后的 sha256（`src/contexts/session/application/runtime.ts:783` 交给注入的 `hash`，即 `src/cli/session-application.ts:30`【事实】），含审批答复的 `secret` 输入与发送原文；它在本条范围之外，终稿登记为已知违例，建议独立 ADR 迁移为 HMAC（第 20 节 Q19）。

### INV-30（新增）

- 所有者：G068（事件 b 与 n 的状态转换；零注入集成测试 G068-C01）；G074（真机零注入探针 P15，G074-R02）。
- 检查方式：自动测试——20 轮零延迟假 Harness 插入未派发、合成失败、`/export`、`/clear`、`/undo`、attach none、WorkBuddy 目标断言 `dispatched === input`；ON CONFLICT DO NOTHING 计数。计划用例：G068-C01（integration）、G074-R02（probe，P15）。默认放行：G072-PP01（property，P4：策略单发前后 `BindingRelayState` 逐字节相同、不写送达行）、`relay-permissive.test.ts` 的行 2（二十条连续输入的单发）。
- 状态：已接受（ADR-055）。
- 说明：
  - `attach:"none"` 即“只发这条消息”：原样发送，本回合不产生送达证据，sync、水位与 pending 都不变（事件 n，第 6.3、7.2 节）；pending 下它只在用户回应 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}` 之后出现（D1 推荐项 (a)）。WorkBuddy 与未经探针（`probed=false`）的 Driver 作目标时只提供这一条（第 8.1 节；生产只对已探针的 Driver 开放接力，D11 推荐项 (a)）——默认放行后不再如此：`relay.allowUnprobed` 默认 `true`，未经探针与未声明的 Driver 也接收接力、卡片标“未经真机验证”，设为 `false` 才恢复这一条（`compactionEvidence:"none"` 的常量游标、OpenClaw 的 `lifecycleRevision` 确认、Hermes 的 `setTitle` 与 D6 的 `probed` 要求不因此放开）。
  - 策略单发（默认放行，事件 n 带 `by:"policy"`）与用户的单发同为逐字节原样、绑定不变；区别只在谁决定：`run.context_prepared.data.relay.decision = {kind:"alone", by:"policy", cause}`，界面据此提示“这条只发了原话”，不出现“已接手”。待核时的策略补发（退到纪元基准后的完整交接单）每次待核至多一份：补发后状态是 pending，不再是 suspect，要再退一次必须有新的回退类判定。
  - “携带包时第二段等于原话”依据 D4 推荐项 (a)（第 5.5 节）。
  - “同一纪元内 mark 只在 suspect 回退时变小；清空进入新纪元”：确认的清空（事件 e）进入新纪元，清空前的回合因纪元变化成为外来事实（第 7.2、7.4 节）；第 7.2 节的属性与下文 `assertSessionTransition` 的规则在写入阶段统一为同一措辞。
  - “ON CONFLICT DO NOTHING 计数”指交接单以 `INSERT … ON CONFLICT(session_id, packet_id) DO NOTHING` 入库（第 14.1 节）。

### INV-31（新增）

- 所有者：G066（`relay_deliveries` 表、应用层转换校验与 `relay_deliveries_transition` 触发器）；G068（由逐回合证据判定送达结论）。
- 检查方式：自动测试——独立表转换测试（J1 M3）；触发器无效样例。计划用例：G066-C04（integration）。
- 状态：已接受（ADR-055）。
- 说明：每个 Run 至多一条送达行（主键 `(session_id, run_id)`）。允许的转换（第 4 节 `DeliveryRecord`）：in_flight→{recorded, not_recorded, unknown}；unknown→{recorded, not_recorded}；not_recorded→recorded（只由后续正面证据触发）；unknown→unknown 与 recorded→recorded 的同值写允许（reason 细化、realized 结算）。转换先在应用层校验，触发器只作断言；`UPDATE` 只在 outcome 变化时才把它写进 SET（第 14.1 节）。送达结论存独立表，因为已终结的 Run 不可改写（`src/contexts/session/domain/state.ts:441`【事实】）。

### INV-32（新增）

- 所有者：G070（省略账目与折叠恒等式，`src/contexts/session/domain/relay/packet.ts`）。
- 检查方式：自动测试——属性测试。计划用例：G070-P01（property）。
- 状态：已接受（ADR-055）。
- 说明：账目按类别满足“已渲染 + 已省略 + 未统计 = 全部”（第 2 节），折叠满足 verbatim + compact + line + ranged + excluded = 需交事实的条数（第 6.3 节）；取回方式取 `hub_detail_view`、`workspace`、`native_session`、`none`，“未统计”是类别 `uncounted`（第 4 节 `Omission`）。交接单“未包含”一节不提 HarnessHub 的存放位置，结尾固定为“这些内容没有附上，你也无法读取；需要时以工作区为准。”（第 5.1 节）。

### INV-33（新增）

- 变更（相对 14.3 的文本）：末句“目的厂商指主模型请求的实际处理方；Harness 自配的辅助模型与记忆不在 Hub 可见范围”取自第 10.4 节（“INV-33 写明……”），14.3 的文本没有这一句。
- 所有者：G072（`admit` 预判、finalize 复检与 `run.dispatched` 事务内复读同意）；G074（真机探针 P14 的厂商键夹具）；G069（厂商键的解析，`src/adapters/control/relay-vendor.ts`，用例 G069-C04；第 17 节 G069 行在写入阶段补列了 INV-33）。
- 检查方式：自动测试——集成测试（J4 M12 每条；CS-01–CS-04）。计划用例：G072-C06（integration，CS-01–CS-04）、G074-R03（probe，P14）。默认放行：`relay-permissive.test.ts` 的行 10–13（integration）、G072-PP02（property，P8：任意交错下每个跨厂商的送达行都有先于它提交的日志行，撤回后没有送达行）。
- 状态：已接受（ADR-055）。
- 说明：
  - 时机（第 10.4 节）：受理时按绑定上缓存的 `vendorObserved` 或目录缓存预判，缺同意即同步 `409 RELAY_CONSENT_REQUIRED`；取不到厂商键时按 `unknown:<harnessId>` 询问，这个回答只记“已看过说明”；finalize 用 open 后观测到的模型与端点复检，不符即 `RELAY_CONSENT_REQUIRED{reason:"vendor_changed"}`、不派发；`run.dispatched` 的事务里再读一次，已撤回就不派发。本纪元内收过包的绑定厂商键变化时记 `relay.vendor_changed`。
  - 权威记录在安装级 `relay_log`（只追加，`command_id` 唯一），会话事件 `relay.consent_recorded` / `relay.consent_revoked` 只是镜像（第 10.4、14.2 节）。同一厂商的 account 与 api_key 同记一个键（D7 推荐项 (a)）。
  - 默认放行（`relay.crossVendor=allow`，2026-11-10，用户的决定与审批代理的规则）：向一个厂商键第一次交接历史时，向 `relay_log` 追加一行（`decision` 为 acknowledged，`scope` 全局，`command_id` 为 `default-allow:<厂商键>:<policyVersion>`，`policyVersion` 里的 `/` 写作 `-`，过长的厂商键改用其 FNV 摘要，`consentSourceOf` 由前缀读出来源 `default`），先于或早于 `run.context_prepared` 提交，送达行的 `consentLogSeq` 取该行；之后的交接不再写、事件里说明依据哪一行；撤回是用户的显式指令，该厂商最新一行是 revoke 时不发历史、策略单发（`decision.cause = "consent_revoked"`），不被默认改写；用户之后重新同意则又发。厂商键变化（本纪元的 `consentKey` 与观测到的不同）记 `relay.vendor_changed`（`allowed:true`）并为新键追加一行，不拦。`unknown:*`、`gateway:*`、`router:*`、`provider:*` 与来源是工作区文件的端点与其他键同样默认允许（所有者 2026-11-10 的裁定），首次使用的 `run.context_prepared.data.consent` 给出 `layer` 以便提示。`relay.crossVendor=ask`（严格）时默认写下的行不算用户给的同意，原条款全部恢复；`goal_only` 不变（MVP 只能渲染标准档，所以它下面交接单发不出，默认按策略单发，`decision.cause = "consent_goal_only"`）。
  - 读不出厂商时（独立审查 I1）：Driver 的厂商读取失败、超时或没有回答，说明不了厂商换了，也说明不了没换。送达的包如实记为 `unknown:<harnessId>`，但本纪元的 `consentKey`、该绑定上次所见与它的谱系上次所见的键仍然各自管着用户的撤回：任一被撤回就不发历史（策略单发，`cause=consent_revoked`；显式要求附上则失败），`run.dispatched` 之前的再读也看这些键；读不到的结果不覆盖绑定缓存的 `vendorObserved`，也不记 `relay.vendor_changed`、不改写 `consentKey`。绑定从未被读到过厂商（首次交接且读不出）时没有可对照的键，历史按 `unknown:<harnessId>` 发出——这是已知的限度，不是遗漏。
  - `local` 只在 Driver 报告回环端点且模型不是转发云端的时成立；用户在设置页标记“本机模型不出网”（`relay_prefs` 的键 `relay.localModelsOffline`，可经 `PUT /api/v1/relay/prefs` 写）才豁免同意，否则按 `local` 记一次同意（第 10.4 节）。这一豁免是本条登记过的唯一例外（写入阶段写入上表）。

### INV-34（新增，v1.2 生效）

- 所有者：G077（v1.2 stdio 接力 MCP；deferred，待 G076 与 RelayBench 拉取率 ≥60%）。
- 检查方式：真机探针，deferred——规格指纹跨恢复不变；argv 扫描。计划用例：G077-C01（deferred：v1.2 生效）；对应第 8.2 节的探针 P-M2（argv 用脱敏规则扫描命中 0）与 P-M3（工具规格指纹跨恢复不变）。
- 状态：已接受（ADR-055）；v1.2 之前不适用。
- 说明：Driver 以 `sessionTools: { owner: "program"; listFrozenAtCreate: true; preApproval: … }` 声明（第 4 节）；shim 的规格只含绝对路径，无 headers、无 env 秘密（第 8.2 节）。

### INV-35（新增）

- 变更：相对第二版草案的“接力的任何失败只让本 Run 失败”收窄为预期内的失败。
- 所有者：G066（relay 行的字节校验、转换校验、SAVEPOINT 与恢复的事务接入点：`src/infrastructure/session/relay-tables.ts`，`sqlite-store.ts` 经 G008）。
- 检查方式：自动测试——故障注入：超长钉住、2 万文件、字段打满的中文摘要、ID 冲突、扫描器异常、unknown 同值写，Store 均不 failed。计划用例：G066-C05（integration）。默认放行：`relay-permissive.test.ts` 的行 20（四种注入：脱敏读不到密钥、配额、渲染、同意日志满，Run 完成、原样发出、relay 状态不变、下一条再试）。
- 状态：已接受（ADR-055）。
- 说明：写法（第 3.2、14.1 节）：`mutate` 之前完成全部序列化、字节校验与转换校验，事务内只剩 `INSERT … ON CONFLICT DO NOTHING` 与已校验的 UPDATE（不用 `INSERT OR IGNORE`：它会连 CHECK 违例一起吞掉，随后外键错误让 Store failed）；派生行（摘要、索引、观测）失败回滚到保存点，该 Run 标 behind；权威行写失败时本 Run 以 `RELAY_PREPARE_FAILED{reason:"storage"}` 失败；正文触顶时以 `RELAY_PREPARE_FAILED{reason:"storage_quota"}` 失败（第 9 节）。恢复按会话各自一个 SAVEPOINT，一个会话的 relay 行写失败只让该会话标为 `relay_recovery_failed` 并在打开时拒绝接力（第 9 节）。现状任何 SQLite 错误都会让 Store 置为 failed（`src/infrastructure/session/sqlite-store.ts:626`【事实】），所以约束错误仍按 bug 对待。

### INV-36（新增）

- 所有者：G072（`admit` 的数据根互不包含检查，G072-S01）；G071（观测器排除数据根与 `.tmp/`，WS-01–WS-06）；G070（HMAC 密钥与附件物化目录移出数据根：`src/infrastructure/session/relay-keys.ts`；`content-store.ts` 与 `attachments.ts` 的物化目录经 G008、G032；第 17 节 G070 行在写入阶段补列了 INV-36）。
- 检查方式：自动测试——WS-05、WS-06。计划用例：G071-S01（security，WS-01–WS-06）、G072-S01（security，admit 的数据根检查，在 `relay.dataRootInWorkspace=block` 下）。默认放行：`relay-permissive.test.ts` 的行 14（默认 `warn`：照常交接，`run.context_prepared.data.dataRootInWorkspace=true`，运行时读入口 `relayDataRootExposed(id)` 给工作区横幅；设为 `block` 恢复 409）。
- 状态：已接受（ADR-055）。
- 说明：
  - 判定（第 10.1 节）：启动时与每次 `admit` 沿父目录逐级比较 `(st_dev, st_ino)`，不比较路径字符串；另在工作区内有界查找（深度 ≤6、≤2,000 项、≤100 ms）`.harness-gateway.json` 标记，找到即视为包含。
  - 包含时（第 9、10.1 节）：启动时记录告警，对该工作区的全部会话在界面上告警（默认放行后“首次发送要求确认”取消，只提示）；跨厂商（任一来源的厂商键与目的厂商键不同）且将要携带接力内容的回合在 `relay.dataRootInWorkspace=block` 时受理即 `409 RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`，`warn`（默认）时照常进行；同厂商与单 Harness 对话可继续；观测排除数据根与 `.tmp/`（第 6.1 节在写入阶段写明了这两个前提）。`admit` 只做 `(st_dev, st_ino)` 比较，标记查找在启动时与工作区顶层目录 mtime 变化时做并缓存。
  - 位置（D5 推荐项 (a)）：`relay-key` 放在数据根之外（macOS：`~/Library/Application Support/HarnessHub/relay-key`）；附件物化目录按会话建在 `os.tmpdir()` 下（每会话一个 0700、名字 ≥128 bit 随机的目录），保留 ADR-023 的稳定只读副本语义，随会话删除。本版不改默认数据根（D8 推荐项 (a)，第 20 节 Q9）。

### 状态转换断言（`assertSessionTransition` 扩展）

终稿第 14.3 节给 `assertSessionTransition`（`src/contexts/session/domain/state.ts:410–464`【事实】）加下列规则，它们没有单独编号：

- `binding.relay` 只能由在该绑定上执行的 Run 修改（迁移、恢复与用户的 pin/exclusion/consent 命令除外）；
- `nativeEpoch` 单调；`epochFloor` 只增不减；
- 同一纪元内 `mark.throughSeq` 只在 suspect 回退时变小且不低于 `epochFloor`（确认的清空进入新纪元，INV-30）；
- `throughRunId` 仍须指向同一 harness/control 的已终结 Run（`state.ts:319–320` 不变）；
- `run.relay` 与 `contextReadyAt` 纳入 `state.ts:448` 的“派发后不可改”；
- 归档绑定的 `relay` 不变（拒绝改动归档绑定的是 `state.ts:418`【事实】）；
- 写者 Run 的 `run.ended` 带 `native.cleared` 时允许“归档旧绑定 + 新建同 harness/control 绑定”而不要求 native-reset 命令（Claude 合成清空；现状 `state.ts:418–424` 只放行带 native-reset 的归档【事实】）；
- 回合外的 `usage_update`（`src/adapters/control/acp.ts:634`【事实】）没有写者 Run，只写 `relay_windows`，不改绑定；
- `pending.packetId` 等跨存储引用在 Store 写入时校验。

所有者：G066（用例 G066-C06）；`state.ts` 归 G004，G066 与 G068 经 G004 修改（第 17 节）。检查方式：自动测试——G066-C06（unit）为每条规则各配一个无效样例，含带 `native.cleared` 的归档放行、不带的拒绝。状态：已接受（ADR-055）。

## 宿主与会话租借不变量（ADR-056）

状态：已接受（[ADR-056](../decisions/0056-native-hosts-and-sessions.md)，2026-11-03 验收），未实现、未真机验证。陈述以上表为准，出处是[原生宿主与会话租借设计](../proposals/native-hosts/design.md)第 4 节；本节逐条记录所有者、检查方式与计划用例。全部是计划中的自动测试（unit、integration、property、protocol、platform 层用真实的 `SqliteSessionStore`、真实工作区租约与走 stdio 的子进程夹具）与真机探针（probe 层，最新正式版），没有只靠人工审查的条目。

- **INV-37** — 所有者：G079（宿主池与租借，`src/contexts/session/application/host-pool.ts`）；G081（Driver 多会话事件归属）。检查方式：属性测试 G079-P01（任意租借、释放、淘汰、崩溃序列下每个原生会话至多一个持有者）；协议测试 G081-C02（同连接两个会话的事件按会话归属，附着的子线程不归属）。
- **INV-38** — 所有者：G079（新鲜度判定 `src/contexts/session/domain/host-freshness.ts`）；G083（真机探针 H4 外来回合检测）。检查方式：单元测试 G079-C04（判定表每条一个无效样例，命中即重开并记原因）；探针 G083-R03。
- **INV-39** — 所有者：G079（租借归还时的租约处理）。检查方式：集成测试 G079-C03（同工作区两个对话串行共用空闲宿主，租约随写走）、G079-C06（固定宿主持有租约，另一对话得到 `WORKSPACE_KEPT`）。
- **INV-40** — 所有者：G080（登记表 `src/infrastructure/session/host-registry.ts` 与接管）。检查方式：集成测试 G080-C01（未登记不得承载回合）、G080-C02（另起所有者登记 idle / pinned / leased 三种宿主后 SIGKILL，新所有者结束进程组并记录结果与租约处理）。
- **INV-41** — 所有者：G079（预算 `src/contexts/session/domain/host-budget.ts`）。检查方式：集成测试 G079-C05（类上限或内存预算满时按淘汰顺序只收回空闲未固定的会话与宿主，仍不能则等空位且可见）；属性测试 G079-P01。
- **INV-42** — 所有者：G079（保活与预热规则）。检查方式：集成测试 G079-C09（保活期间与宿主预热路径上原生侧没有新会话：对端夹具计数 `session/new`、`thread/start` 为 0，会话只在取得租约的回合里建立）。依据：2026-11-03 实测，不发提示也会留下原生记录（Codex、dsh、Claude、OpenCode、Hermes）。
