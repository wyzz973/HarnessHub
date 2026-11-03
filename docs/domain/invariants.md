# 核心不变量

状态：proposed。每条必须映射到自动测试或明确人工证据；测试矩阵记录覆盖范围。INV-13、INV-14、INV-22 按 [ADR-055](../decisions/0055-relay-and-context-scheduling.md) 改写，INV-21 按 ADR-055 扩展，INV-29–36 由 ADR-055 新增（接力系统，2026-11-03），已于 2026-11-03 随 ADR-055 接受，尚未实现、未经真机验证；这些条目的所有者、检查方式与计划用例见下文“接力不变量（ADR-055）”一节。

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
| INV-14 | A 已知的公共事实只由当前 `nativeEpoch` 的送达水位（正面证据或亲历）与清空下限 `epochFloor` 决定，下限随绑定谱系保留；原生位置与送达水位是不同事实；fork 精确性读原生位置且要求源绑定 synced、need(through)=∅、位置在当前纪元内；配置承接（ADR-028）读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 input≠not_recorded 的 Run，跨因清空归档的绑定（VF1-10）；已派发不算送达；clear 经 Hub 确认后进入新纪元并记录下限，确认不了即待核；rewind、未知命令、未知送达、未知回合转待核；待核的绑定在核对或用户选择之前不复用（cause ∈ {legacy, marker_absent} 且 need=∅ 除外；没有外来事实的单 Harness 对话不核对也不阻挡）；pending 只核对待核的那份包自己 |
| INV-15 | 停用/移除只影响新 admission；已有执行和历史 revision 按明确排空规则处理 |
| INV-16 | 能力的声明、观察、验证、平台和版本是不同事实；未知不能当支持 |
| INV-17 | 秘密仅交给所属边界，不进入公共消息、事件、选择快照、argv 或错误 |
| INV-18 | 每次模型调用/工具/权限都能关联实际 Attempt 与绑定；账本不能由配置猜测 |
| INV-19 | SSE/订阅断开不取消执行；重放允许重复，客户端可按稳定身份去重 |
| INV-20 | 慢订阅者和巨大输出不能造成无界内存；超限明确失败或转不可变产物 |
| INV-21 | 切换请求与生效不同；交接失败保留公共 Session 和真实结果，不假称迁移成功；切换生效与交接送达分别表达；分隔线与“已接棒”只在证据后出现；准备失败不派发、relay 状态不变（open 后失败时原生会话与绑定按第 9 节保留）；停止未确认时待决切换失败而不悬挂 |
| INV-22 | 配置与原生状态不能替代公共事实源；读模型可重建；同一 `policyVersion` 与同一脱敏上下文下，RunDigest 与交接单可由公共事实（快照、事件、已落库的内容）加已落库的工作区观测逐字节重建；摘要只由已提交的事实生成；摘要记录命中区间，重建先套区间；`harness_note` 只保证可追溯 |
| INV-23 | 存储失败停止接收新执行并进入受控收敛；不能声称不存在的终态已落库 |
| INV-24 | 自动路由只在经过硬约束的候选中选择；质量证据不足时不声称最佳 |
| INV-25 | API、CLI、界面和 SDK 使用相同命令语义；UI 不持有独立执行权 |
| INV-26 | 所有进程、流、计时器、后台工作有所有者、上限和可等待关闭入口 |
| INV-27 | 已取消/关闭的未启动 Turn 留 tombstone；旧 outbox 首次投递也不能获得新启动授权 |
| INV-28 | Owner 接管必须取得排他权并推进持久代次，旧 owner/旧授权不能复活仲裁或派发 |
| INV-29 | 跨 Harness 发出的内容先经已知秘密精确匹配（按名定集合、10 种形式、骨架视图、ANSI 先删）与形状规则脱敏，当前输入（第二段）除外；扫描器出错即不发；出境字节、`relay_*` 表、`relay_log`、接力事件、日志与诊断、错误信息不含秘密原值及其未加盐哈希；钉住按位置存不存原文 |
| INV-30 | 外来事实为空的绑定（从未交接、或清空后未选附上）收到的每条输入与用户原文逐字节相同；`attach:"none"` 的回合逐字节相同且不改水位；携带包时第二段等于原话；每个原生纪元至多一份完整交接单（前一份 not_recorded、unknown 待核或用户再附除外），之后只追加 delta 与 anchor；同一纪元内 mark 只在 suspect 回退时变小，确认的清空进入新纪元 |
| INV-31 | 一个 Run 至多携带一份交接单（增量可含要点小节）；送达结论只由逐回合证据决定，与终态无关；送达结论不写进已终结的 Run；正面证据可纠正 unknown 与 not_recorded；同值写不算转换 |
| INV-32 | 没有照录的可交接事实必须计入省略账目并给出取回位置，或写明“不可取回”“未统计”；账目恒等式成立 |
| INV-33 | 没有目的厂商键的同意记录，不向该厂商发出历史；厂商键由 Driver 按机制与它自己解析的端点声明；撤回后不再发出；本纪元内厂商键变化须重新同意；`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`，来源是工作区文件的端点每个会话都问；目的厂商指主模型请求的实际处理方；Harness 自配的辅助模型与记忆不在 Hub 可见范围；登记过的唯一例外：厂商键为 `local`（Driver 报告回环端点且模型不转云端）且用户在设置页标记“本机模型不出网”（`relay_prefs` 的 `relay.localModelsOffline=true`）时免同意，其他厂商键没有例外 |
| INV-34 | 按会话注入的工具在建会话时固定，中途不增不减；规格零凭据、只读 |
| INV-35 | 任何 relay 行的上限在进入事务前按序列化字节校验；转换在应用层先校验；派生行在 SAVEPOINT 内；**预期内的接力失败**（校验、渲染、脱敏、配额、分类、同意）只让本 Run 失败，不让 Store 进入 failed、不让 Runtime fatal、不波及其他会话；SQLite 约束错误仍是 bug，由应用层校验与无效样例保证不出现（F08） |
| INV-36 | 数据根、HMAC 密钥与工作区按 `(st_dev, st_ino)` 互不包含是跨厂商交接（任一来源的厂商键与目的不同）的前提；包含时携带接力内容的跨厂商回合受理即失败并提示，同厂商与单 Harness 对话继续；附件物化目录与密钥不在数据根内 |

## 接力不变量（ADR-055）

状态：已接受（[ADR-055](../decisions/0055-relay-and-context-scheduling.md)，2026-11-03 验收）。陈述以上表为准，出处是[接力系统终稿](../proposals/relay/relay-architecture.md)（下称“终稿”）第 14.3 节；本节逐条记录变更、所有者、检查方式、状态与说明。上表与本节里的“第 N 节”都指终稿的节号；VF1-10、F08、J1 M11 这类编号是各轮审查的发现与要求，处置见终稿第 18 节与[第四轮处置表](../proposals/relay/round4/v3-dispositions.md)。

- **编号**：终稿 14.3 把 INV-29、INV-30、INV-33 标为“改”、把 INV-35 的变化写作“收窄”，都是相对[第二版草案](../proposals/relay/round3/v2-architecture.md)而言；本文件此前只登记到 INV-28，INV-29–36 在这里都是首次登记。
- **所有者**：终稿第 17 节在“需求 · 不变量”列登记该条的任务；括号里是该任务负责的部分，取自第 17 节的范围与新建文件。第 17 节另让这些任务承担陈述未变的 INV-05、06、09、11、16、17、20、23、25、26，并把本文件划归改写后的 C006。
- **检查方式**：全部是计划中的自动测试，尚未编写。unit、integration、property、security、e2e 层用真实存储与假 Harness（第 17 节：真实的 `SqliteSessionStore`、`LocalContentStore` 与走 stdio 的 `tests/fixtures/control-peer.mjs`）；probe 层是 RelayConformance 真机探针（确定性判定，按各 Harness 最新正式版运行，第 13.3 节）。没有只靠人工审查的条目。计划用例按第 17 节登记进 `plan/test-cases.json` 之后，设计检查（`python3 -I tools/check_design.py`）核对每条不变量至少有一条计划用例。
- **状态**：全部已接受（ADR-055，2026-11-03 验收），尚未实现。依赖终稿 D1–D11 取舍的地方按推荐项登记（用户 2026-11-03 按推荐项接受）。本节的数字都是终稿给定的设计常量或测试参数，不是实测。

### INV-13（改写）

- 变更：原文“ContextManifest 的所有来源 ID、水位、内容指纹和策略版本可追溯；不静默丢弃事实”。ContextManifest 由交接单（`RelayPacket`）的清单与送达行（`DeliveryRecord`）取代；C006 把 `contracts/context.schema.json` 改写为这两者的 JSON Schema（第 17 节）。
- 所有者：G070（渲染、ID 派生、清单与省略账目，`src/contexts/session/domain/relay/packet.ts`）；G066（`relay_packets` 写入时的 fold 校验）；G067（v12 过渡期的来源过滤：排除未派发的 Run，第 7.6 节）。
- 检查方式：自动测试——属性测试（J1 M11）；重渲染 100 次 1 个 sha。计划用例：G070-P01（property）、G070-C01（unit）、G066-C03（integration，fold 校验）。
- 状态：已接受（ADR-055）。
- 说明：ID 为 `"relay-"` + 20 位 Crockford base32(sha256(最终正文，ID 槽位为占位符))（第 4、5.5 节）。交接单以 `INSERT … ON CONFLICT(session_id, packet_id) DO NOTHING` 入库；`manifest_json` 只含由正文决定的字段，逐 Run 的字段（同意 seq、输入 HMAC、送达位置、压缩游标、重发关系）在 `relay_deliveries`；清单头相同而字节不同在进入事务之前检出，该 Run 以 `RELAY_PREPARE_FAILED{reason:"render_mismatch"}` 失败；fold 校验不满足即 `RELAY_PREPARE_FAILED{reason:"render"}`（第 14.1 节）。当前输入指纹是 HMAC（`inputHmac`），不是未加盐的 sha256（INV-29）。脱敏上下文（`rulesVersion`、`keyId`、`setHmac`）记在送达行，不进清单；正文不变时 ID 与清单不变，脱敏上下文变化只在它改变了正文时才自然产生新 ID，`supersedes` 只用于 resend（第 10.2 节，写入阶段修订）。

### INV-14（改写）

- 变更：原文“返回 A 时不能复用未同步 B 已完成变更的旧原生上下文”，改为由送达水位、清空下限与待核规则决定 A 已知哪些事实。
- 所有者：G068（状态 × 事件全表、`planReturn` 的核对计划、`epochFloor` 与压缩游标的更新、`recoverRelay`：`src/contexts/session/domain/relay/delivery.ts`、`recover.ts`）；G066（`binding.relay`、迁移的纪元谱系、`assertSessionTransition` 的新规则）；G067（v12 推进规则，`src/contexts/session/domain/relay/advance.ts`）；G072（`admit` 的选择检查与 A→B→A 的接入，G072-C07）。
- 检查方式：自动测试——属性测试：任意证据序列下水位单调且不超过实际送达或亲历，回退不低于下限；清空后 20 轮 `dispatched === input`；A 清空 → B 两轮 → 回 A 只补 B；旧包 present 不推进 pending 包。计划用例：G068-P01（property）、G068-C05、G068-C06、G068-C07（integration）。
- 状态：已接受（ADR-055）。
- 说明：
  - “待核”指 `pending` 与 `suspect` 两种同步状态（第 7.2 节）。need=∅ 时只对 `legacy`、`marker_absent` 两种 cause 放行；`rewind`、`unknown_command`、`clear_unconfirmed`、`unknown_turn` 在存在外来事实时先核对，无法核对时由用户选择（`RELAY_CHOICE_REQUIRED{cause:"verify_required"}`）；没有外来事实的单 Harness 对话不核对也不阻挡；`SuspectCause` 共 6 种，每种都由第 7.2 节的某个转换产生；`verify=on_next_open` 的 Driver 在绑定为 suspect 或 pending 时不复用保留进程（第 7.2、7.4 节）。
  - need 的下界恒为 max(mark, epochFloor)；只有用户一次性选择“附上交接单”（`relay.attach:"full"`）时忽略下限（第 6.3、7.4 节）。
  - pending 不能自动重发（`autoResends=1` 或 `lateDelivery`）时，下一条内容输入在受理时同步 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}`（D1 推荐项 (a)，第 7.4 节）。“未知回合”是 process 型 Driver 在 unknown 回合之后继续原会话的 `suspect{unknown_turn}`（D6 推荐项 (a)，由探针 P16 门控，第 9 节）。
  - v12 过渡期（G067）只落实第 7.6 节的推进规则 `advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ 已重发一次))`；那时没有纪元与清空下限，清空、回退与效果未知的命令只记 `contextEffect`、不改水位，配置承接取该绑定最后一个已派发的 Run。第 7.6 节把这些列为已知局限，v13 关闭。

### INV-21（扩展）

- 变更：保留原文“切换请求与生效不同；交接失败保留公共 Session 和真实结果，不假称迁移成功”，追加终稿 14.3 的四个分句。
- 所有者：G072（open 之后的准备失败；S5 的等待、停止并切换与停止未确认）；G073（分隔线与“已接棒”按证据显示）；G068（恢复：`recoverRelay`）；G067（v12：unsafe 结束时待决切换记为 failed）。
- 检查方式：自动测试——浏览器测试三种证据路径；故障注入；宽限到期后仍能 resume。计划用例：G073-C01（e2e）、G072-C04（integration）、G068-C08（integration）、G067-C07（integration，“宽限到期后仍能 resume”，写入阶段补入 14.3）。“relay 状态不变”指不建交接单行、送达行与 pending、水位不被这次准备推进；open 时回放核对得到的结果是事实，照常随 `run.ended` 提交（第 9 节）。
- 状态：已接受（ADR-055）。
- 说明：错误按阶段归属（第 9 节）：受理时能判定的同步 409，不建 Run、没有进程；启动前（`prePlan`）失败的 Run 没有进程、绑定不变；open 之后（finalize、同意复检、分类复核、精化窗口）失败的 Run 未派发，原生会话与绑定保留（新建的空原生会话下一次按它 resume，不再新建），relay 状态不变，错误经 `run.ended` 与 SSE 到达。停止未确认时，unsafe 的 `run.ended` 在同一事务里把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`、等待它的排队 Run 记为 `SWITCH_NOT_EFFECTIVE`（第 9 节）。

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
- 检查方式：自动测试——20 轮零延迟假 Harness 插入未派发、合成失败、`/export`、`/clear`、`/undo`、attach none、WorkBuddy 目标断言 `dispatched === input`；ON CONFLICT DO NOTHING 计数。计划用例：G068-C01（integration）、G074-R02（probe，P15）。
- 状态：已接受（ADR-055）。
- 说明：
  - `attach:"none"` 即“只发这条消息”：原样发送，本回合不产生送达证据，sync、水位与 pending 都不变（事件 n，第 6.3、7.2 节）；pending 下它只在用户回应 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}` 之后出现（D1 推荐项 (a)）。WorkBuddy 与未经探针（`probed=false`）的 Driver 作目标时只提供这一条（第 8.1 节；生产只对已探针的 Driver 开放接力，D11 推荐项 (a)）。
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
- 检查方式：自动测试——集成测试（J4 M12 每条；CS-01–CS-04）。计划用例：G072-C06（integration，CS-01–CS-04）、G074-R03（probe，P14）。
- 状态：已接受（ADR-055）。
- 说明：
  - 时机（第 10.4 节）：受理时按绑定上缓存的 `vendorObserved` 或目录缓存预判，缺同意即同步 `409 RELAY_CONSENT_REQUIRED`；取不到厂商键时按 `unknown:<harnessId>` 询问，这个回答只记“已看过说明”；finalize 用 open 后观测到的模型与端点复检，不符即 `RELAY_CONSENT_REQUIRED{reason:"vendor_changed"}`、不派发；`run.dispatched` 的事务里再读一次，已撤回就不派发。本纪元内收过包的绑定厂商键变化时记 `relay.vendor_changed`。
  - 权威记录在安装级 `relay_log`（只追加，`command_id` 唯一），会话事件 `relay.consent_recorded` / `relay.consent_revoked` 只是镜像（第 10.4、14.2 节）。同一厂商的 account 与 api_key 同记一个键（D7 推荐项 (a)）。
  - `local` 只在 Driver 报告回环端点且模型不是转发云端的时成立；用户在设置页标记“本机模型不出网”（`relay_prefs` 的键 `relay.localModelsOffline`，可经 `PUT /api/v1/relay/prefs` 写）才豁免同意，否则按 `local` 记一次同意（第 10.4 节）。这一豁免是本条登记过的唯一例外（写入阶段写入上表）。

### INV-34（新增，v1.2 生效）

- 所有者：G077（v1.2 stdio 接力 MCP；deferred，待 G076 与 RelayBench 拉取率 ≥60%）。
- 检查方式：真机探针，deferred——规格指纹跨恢复不变；argv 扫描。计划用例：G077-C01（deferred：v1.2 生效）；对应第 8.2 节的探针 P-M2（argv 用脱敏规则扫描命中 0）与 P-M3（工具规格指纹跨恢复不变）。
- 状态：已接受（ADR-055）；v1.2 之前不适用。
- 说明：Driver 以 `sessionTools: { owner: "program"; listFrozenAtCreate: true; preApproval: … }` 声明（第 4 节）；shim 的规格只含绝对路径，无 headers、无 env 秘密（第 8.2 节）。

### INV-35（新增）

- 变更：相对第二版草案的“接力的任何失败只让本 Run 失败”收窄为预期内的失败。
- 所有者：G066（relay 行的字节校验、转换校验、SAVEPOINT 与恢复的事务接入点：`src/infrastructure/session/relay-tables.ts`，`sqlite-store.ts` 经 G008）。
- 检查方式：自动测试——故障注入：超长钉住、2 万文件、字段打满的中文摘要、ID 冲突、扫描器异常、unknown 同值写，Store 均不 failed。计划用例：G066-C05（integration）。
- 状态：已接受（ADR-055）。
- 说明：写法（第 3.2、14.1 节）：`mutate` 之前完成全部序列化、字节校验与转换校验，事务内只剩 `INSERT … ON CONFLICT DO NOTHING` 与已校验的 UPDATE（不用 `INSERT OR IGNORE`：它会连 CHECK 违例一起吞掉，随后外键错误让 Store failed）；派生行（摘要、索引、观测）失败回滚到保存点，该 Run 标 behind；权威行写失败时本 Run 以 `RELAY_PREPARE_FAILED{reason:"storage"}` 失败；正文触顶时以 `RELAY_PREPARE_FAILED{reason:"storage_quota"}` 失败（第 9 节）。恢复按会话各自一个 SAVEPOINT，一个会话的 relay 行写失败只让该会话标为 `relay_recovery_failed` 并在打开时拒绝接力（第 9 节）。现状任何 SQLite 错误都会让 Store 置为 failed（`src/infrastructure/session/sqlite-store.ts:626`【事实】），所以约束错误仍按 bug 对待。

### INV-36（新增）

- 所有者：G072（`admit` 的数据根互不包含检查，G072-S01）；G071（观测器排除数据根与 `.tmp/`，WS-01–WS-06）；G070（HMAC 密钥与附件物化目录移出数据根：`src/infrastructure/session/relay-keys.ts`；`content-store.ts` 与 `attachments.ts` 的物化目录经 G008、G032；第 17 节 G070 行在写入阶段补列了 INV-36）。
- 检查方式：自动测试——WS-05、WS-06。计划用例：G071-S01（security，WS-01–WS-06）、G072-S01（security，admit 的数据根检查）。
- 状态：已接受（ADR-055）。
- 说明：
  - 判定（第 10.1 节）：启动时与每次 `admit` 沿父目录逐级比较 `(st_dev, st_ino)`，不比较路径字符串；另在工作区内有界查找（深度 ≤6、≤2,000 项、≤100 ms）`.harness-gateway.json` 标记，找到即视为包含。
  - 包含时（第 9、10.1 节）：启动时记录告警，对该工作区的全部会话在界面上告警并在首次发送时要求确认；跨厂商（任一来源的厂商键与目的厂商键不同）且将要携带接力内容的回合受理即 `409 RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`；同厂商与单 Harness 对话可继续；观测排除数据根与 `.tmp/`（第 6.1 节在写入阶段写明了这两个前提）。`admit` 只做 `(st_dev, st_ino)` 比较，标记查找在启动时与工作区顶层目录 mtime 变化时做并缓存。
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
