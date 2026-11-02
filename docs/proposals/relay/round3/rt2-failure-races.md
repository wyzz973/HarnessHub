# 红队审查 RT2 · 故障、竞态与恢复

对象 [v1-architecture.md](v1-architecture.md)（通读）；背景为简报、第二轮裁定、J1、J3、R4、R8。2026-11-03。`git diff 07a0825 HEAD -- src web tests` 为空，`file:line` 即基点行号。只读代码与推导，未运行 Harness、测试或服务。【事实】有出处；【推断】由事实推出；【建议】修正。

## 0. 总评

骨架方向正确（独立送达表、两段准备、证据分级、命令不捎带）。问题集中在边界情形：重建、清空、未派发回合下，外来事实判定与纪元编号会丢上下文或给单 Harness 注入；停止未确认时待决切换卡死；网关型 Harness 把查看器退出当成静止证据；S15、S14、S5 有不可达或自相矛盾的说法。共 5 个 blocker、13 个 major、7 个 minor。

## 1. 发现

### RT2-01【blocker】重建后的绑定把旧绑定的回合当成“已知”

- **章节**：§7.5 重建；§2 外来事实；§4 `executedOn`；§7.2 native-reset 行
- **触发**：单 Harness 对话，Claude 做了 10 轮（纪元 1），第 11 轮结果 unknown，用户按 §9 S6 执行 native-reset。新绑定 `fresh{reset}`，`nativeEpoch` “从 1 起”。§7.3“新开并附交接单”、§7.4“新开原生会话”、S10“新会话＋交接单”走同一路径。
- **证据**：
  - 【事实】外来事实只看 `executedOn ≠ (X, e)`，而 `executedOn` 不含绑定身份（§4 第 207 行）。
  - 【推断】旧绑定的 10 轮与新绑定都是 (claude, acp, 1)，因此不算外来事实，§6.3 得出 `need=∅ → raw`。全新的原生会话零上下文，与 §7.5“下一条带完整交接单”矛盾。有 B 时只交出 B 的部分，A 自己的历史丢失。
  - 【事实】§7.2 写“nativeEpoch+1”，§7.5 写“从 1 起”，两处矛盾。
- **修正**：【建议】新绑定 `nativeEpoch` 取本会话同 harness/control 全部绑定（含 archived）的最大值加 1，或在 `executedOn` 加 `bindingGeneration`；统一 §7.2 与 §7.5；迁移按 `binding_prepared{resumed:false}`、`branch_requested` 切分绑定谱系；属性测试：任意 reset/clear 序列后，新绑定的 need 覆盖其原生会话缺少的全部回合。

### RT2-02【blocker】清空后的下一条会自动附上完整交接单，“附上”没有 API

- **章节**：§6.3 plan()；§7.4；§12.4；INV-30
- **触发**：单 Harness 对话里用户发 `/clear`，状态变为 `fresh{user_cleared}`、纪元加 1，然后发一条普通消息。
- **证据**：
  - 【事实】§7.4 说清空前本绑定的回合“成了外来事实”。plan() 只有 `need=∅ → raw` 与 `fresh → packet` 两个分支，没有 `user_cleared` 判断（第 563–565 行）。照伪代码实现，下一条就附上完整交接单，正是裁定 §2 第 3 条判为致命的缺陷。
  - 【事实】§12.4 的 relay 选项里没有“附上”，［附上交接单］按钮无法表达。
  - 【推断】INV-30 照字面会连 A→B 的第一份交接单和“附上”都禁止，无法写成属性测试。
- **修正**：【建议】plan() 首行加 `fresh{user_cleared} ∧ ¬attachHistory → raw`；`relay.attachHistory` 写入请求、命令指纹与 `message.accepted`；INV-30 改为“本纪元没有待交的外来事实，或清空后未选附上时，逐字节等于原文”。

### RT2-03【blocker】未派发回合与本绑定 not_recorded 回合被算作外来事实，单 Harness 被注入

- **章节**：§2；§7.1；§7.2 本绑定普通回合行；§7.6；§17 R0b
- **触发**：单 Harness 对话里出现任一种回合：被取消的排队消息；WORKSPACE_BUSY、ATTACHMENT_UNSUPPORTED、RELAY_PREPARE_FAILED；OpenClaw `model_not_applied`；`/export`、`/remote-control`；OpenCode `COMPACT_IGNORED`；Codex 无 turnId 的拒绝。
- **证据**：
  - 【事实】未派发 Run 的 `executedOn = null`，与 (X, e) 不等；§2 也明文把 not_recorded 列为外来事实。【推断】fresh 绑定因此 need≠∅，下一条发出整包，框架还写“此前由另一个 Harness 进行”。
  - 【事实】这些结果多由 Driver 合成：claude.ts:70–72、codex.ts:507、openclaw.ts:91–94/423。
  - 【推断】P0 规则使 `/export` 之后 throughRunId 不推进，而 `run.dispatched` 在 startText 之前就已提交（runtime.ts:1415）。下一回合 1337–1339 把它当作来源，1392 改发 JSON 信封。现码在这里照常推进（1496），所以这是 R0b 引入的新回归；R4 D8 也仍未关闭。
  - 【推断】RELAY_PREPARE_FAILED 后点［重试］，同一句原话会在一条消息里出现三次。
- **修正**：【建议】外来事实限定为 `dispatched ∧ executedOn≠(X,e)` 的终态 Run 加 origin；未派发与命令回合永不触发交接，本绑定 not_recorded 回合只在已要发包时附一行说明；P0 规则改为 `input≠not_recorded ∨ isCommand`，1337–1339 排除未派发回合；INV-30 测试逐一加入上述回合。

### RT2-04【blocker】“停止并切换”在停止未确认时卡死

- **章节**：§9 S5、S6；§16 S5
- **触发**：Run k 在等审批，用户点［停止并切换］。15 s 宽限内没有结算，连接被关闭，Run 记 unknown，会话 blocked。wait_current 模式下进程退出，结果相同。
- **证据**：【事实】
  - run.ended 只在关闭对话或停服时取消待决切换（runtime.ts:1499–1500），unsafe 结束时 pendingSwitchId 保留（1490）。
  - 会话 blocked 且不是恢复切换时，serve 直接返回（869、972）。
  - `recoverable` 遇到 pendingSwitchId 非空就抛 RECOVERY_UNAVAILABLE（747），`requestSwitch` 也会抛 SWITCH_PENDING（386）。
  - 只有关闭对话或重启（state.ts:476）才能解开。所以“停止未确认 → 恢复切换”这条路走不到。
- **修正**：【建议】
  - unsafe 的 run.ended 在同一事务里把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`，并把等待它的排队 Run 记为 SWITCH_NOT_EFFECTIVE。
  - 补集成测试：待决切换加宽限到期之后，仍能 resume。

### RT2-05【blocker】网关型 Harness 把查看器退出当成静止证据，S14 的回放核对走不到

- **章节**：§9 S14；§8.1 Hermes、OpenClaw 行；§20
- **触发**：Hermes 正在运行 `npm run e2e`，用户点［停止并切换］。宽限到期后 Hub 关闭查看器（runtime.ts:1016–1021），cleanup.closed=true，恢复被允许（750），B 开始写工作区；按 R8 H5、W5 的推断，网关里的回合仍在继续。
- **证据**：
  - 【事实】INV-12 规定，未确认停止就不能让新执行者写同一工作区；ADR-015 规定，切换不转移运行中的工具。v1 没有网关侧的静止判据。
  - 【推断】该 Run 为 unknown，绑定停在 unconfirmed（1492），下次使用会抛 NATIVE_STATE_UNCONFIRMED（1336），只能重建。旧会话不会再被 open，所以 S14 的“下次回放给出标记与 foreignAfterLast”无法产生。
  - 【事实】Hermes 报 `unknown_execution`（hermes.ts:39、120–127）时，Run 记为 failed/request_rejected（acp.ts:560），交接单会写“失败”。
  - 【推断】网关拒绝准入（R8 H4）和 `NATIVE_GATEWAY_UNAVAILABLE`（“没有送达网关”，hermes.ts:124）会被当作 unknown，白白耗掉重发次数。
  - 【事实】J3 R-7 没有进入 §20。
- **修正**：【建议】能力声明加 `execution: process | gateway`；gateway 型的 unknown 须有网关侧确认（Hermes 准入状态、OpenClaw `sessions.get`/`chat.abort`）才算 closed，否则租约隔离、拒绝恢复；给 unconfirmed 绑定加“只读核对打开”（新 ADR）；`unknown_execution` 映射 unknown，拒绝准入与 GATEWAY_UNAVAILABLE 映射 not_recorded；R-7 写入 §20 并加探针。

### RT2-06【major】S15 自相矛盾：recoverSession“不变”却要改 relay 行；“相同 ID 与字节”不成立

- **章节**：§9 S15；§16 S15；§14.4
- **触发**：Run 处于 preparing、running 或 settling 时 Hub 崩溃。
- **证据**：
  - 【事实】claimAndRecover 只写 sessions 与 events（sqlite-store.ts:577–586），recoverSession 不产出 relay 行（state.ts:466–479），所以 in_flight 永远悬挂，“送达中”的占位行不会消失。
  - 【事实】恢复后这类 Run 的 cleanup 为 null，直接 RECOVERY_UNSAFE（runtime.ts:750–751；事件里也没有 session.blocked，766–768）。【推断】对话只能分支或关闭，不存在“下一次派发”；即便分支或重建，事实、观测、纪元和首行都已变化，ID 必然不同。
  - 【事实】“这条消息没有发出”只适用于 queued（contracts/session.ts:348）。
  - 【事实】§6.1 没有写 E1 落库时是否同时把绑定从 pending 改为 synced。
- **修正**：【建议】recoverSession 同时返回 relay 变更（无 dispatchedAt 记 `not_recorded{never_dispatched}`，否则 `unknown{owner_ended}`；pending 按 prior 回退），在同一个 BEGIN IMMEDIATE 里写入；E1 提交同时改送达记录与绑定；删去“相同 ID 与字节”，文案按 queued 与非 queued 分开。

### RT2-07【major】pending 丢了派发前的状态

- **章节**：§4 `BindingSync`；§7.2
- **触发**：清空后点“附上”，随后附件检查失败、取消或缺少同意；或者 suspect{rewind} 时补发被拒。
- **证据**：【事实】pending 只保留 mark，fresh 的 basis 与 suspect 的 cause 都丢了（§4 第 231 行）。【推断】若回退成 fresh{new}，会自动附包（叠加 RT2-02）；若回退成 synced，则把 suspect 洗白。`attempts: 1|2` 也表达不了手动“再附一次”。
- **修正**：【建议】`pending{prior, packetId, range, autoResends: 0|1, manualResends}`；not_recorded 时回到 prior；属性测试覆盖 prior 的每种取值。

### RT2-08【major】finalize 与命令识别、附件检查的顺序未定义，照现码会让 D1 回归

- **章节**：§6.1；§3.2；§7.4
- **触发**：A→B→A 后第一条输入是 Claude 技能命令 `/review`（keep 类）。
- **证据**：
  - 【事实】现码在 run.authorized 之后才识别命令（runtime.ts:1389、1393–1397），附件检查也在这之后（1400–1414）；v1 的 finalize 早于 authorized，就已提交 pending 与 in_flight。
  - 【推断】结果是绑定处于 pending{P} 时命令被原样发出，E3 的“end_turn → recorded”把从未发出的 P 记为已送达，B 的工作永远补不回去，正是 R4 D1。
  - 【推断】prePlan 也会对 `/clear` 做预算检查，欠交量大时，用户连清空都会被 RELAY_INPUT_LIMIT 挡住。
  - 【事实】现码用 execute 开头读到的 previousNative 重建绑定（1382–1384）。【推断】照搬会覆盖 relay 字段。
- **修正**：【建议】
  - 顺序定为 open → binding_prepared → models() 识别命令 → 附件检查 → finalize → authorized → dispatched。
  - 命令回合跳过预算与组包；证据只作用于实际携带的 packetId。
  - 绑定写入一律基于 `current` 合并。

### RT2-09【major】E2“absent → not_recorded”有可预见的假阴性

- **章节**：§7.1；§7.3；§7.4；§4 DeliveryRecord
- **证据**：【推断，依据 R8 与现码】
  1. **Hermes**：P 所在回合内发生压缩，被压缩的行不回放（R8 H8），于是判为 not_recorded，再发整包。§7.4 的压缩分类只覆盖 synced，不覆盖 pending。
  2. **Claude**：只扫 JSONL 尾部 2 MiB，工具密集或之后有多轮时，标记落在窗口外。
  3. **OpenClaw**：回读窗口 200 条（openclaw.ts:20、446）；取消之后网关会补写用户回合（R8 W2）。
  4. **OpenCode**：取消的输入晚到送达（R8 O2）。
  5. **用户粘贴**：用户粘贴的框架行会被误判为 present。
  - 【事实】状态转换不允许 not_recorded → recorded（§4 第 164 行），一次误判无法纠正。
  - 【推断】返回 A 时会误判 suspect，派发前停下让用户选择。
- **修正**：【建议】只有回放完整、且派发后未见压缩时，absent 才判 not_recorded，否则记 `unknown{absent}`；Claude 按派发时字节偏移查，OpenClaw 从 `before` seq 翻页；OpenCode 声明 `lateDelivery`，取消后不自动重发；允许正面证据纠正（not_recorded → recorded）；只匹配 Hub 写入的第一段文本。

### RT2-10【major】自动重发沿用原包字节，丢掉 P 之后新增的外来事实

- **章节**：§7.2；§7.4；§14.1；INV-31
- **触发**：A→B，P1 结果 unknown，B 处于 pending；切到 C 做了 3 轮，再回到 B。
- **证据**：【事实】§7.4 写明重发“沿用同一套单元、同一字节”。【推断】C 的 3 轮不在 P1 的区间内，而 INV-31 禁止同一轮再带第二份包，所以 B 这一轮看不到 C 的改动，违背 §11.1 的“丢失增量 0”。此外，去重行会改变字节，与“重发复用同一正文”矛盾。
- **修正**：【建议】重发时重新渲染全部 need（P1 的单元，加上 P1 之后的外来事实），`supersedes=P1`，开头带去重行；声明 `lateDelivery` 的 Driver 不自动重发。

### RT2-11【major】接力行与业务写在同一事务里，一个约束错误就让整个 Hub 停摆

- **章节**：§14.1；§6.4；§9“派生写入失败”
- **触发**：RunDigest 序列化后超过 65,536 字节（各字段按“字”截断，JSON 转义还会放大）、正文超过 262,144 字节，或外键写入顺序错误。
- **证据**：
  - 【事实】`transaction()` 遇到任何 SQLite 错误都会把存储标记为失败（sqlite-store.ts:626），之后所有 `assertOwner()` 都抛 STORAGE_UNAVAILABLE（259–261）。
  - 【事实】“同 ID 不同 sha 即 INVALID_DATA”会经 `commit()` 进入 `fail()`，整个 Runtime fatal（runtime.ts:796、804–816）。
  - 【推断】v1 承诺“派生写失败绝不让 run.ended 失败”，但同一事务里没有 savepoint；这也违反 ADR-014 第 2 条（单个会话的故障不得波及其他会话）。
- **修正**：【建议】
  - 领域层按序列化后的字节数校验上限。
  - 派生行放进 SAVEPOINT，失败只记为 behind。
  - ID 冲突改为本 Run 的 `RELAY_PREPARE_FAILED{render}`。
  - 三种故障注入测试都应只影响本 Run。

### RT2-12【major】交接单 ID 的派生输入未定义，与预取复用冲突

- **章节**：§4；§6.3；§6.4；§11.1
- **触发**：(a) M1 在插入前被取消，改写成 M2 重发；(b) 预取时 digest 还落后，派发前已补建。
- **证据**：【事实】ID 取“清单头”的哈希，但清单头未定义；正文首行与语言都取决于当前输入（§5.4），清单里却没有当前输入的指纹。【推断】(a)、(b) 都会出现“同 ID 不同正文”，触发 RT2-11 的 fatal；打开选择器时还没有当前输入，“复用字节”做不到。
- **修正**：【建议】
  - ID 由最终正文派生：先以占位符渲染，再算 sha256，最后替换占位符。
  - 清单记录当前输入指纹、语言和 digest 状态。
  - LRU 只缓存与输入无关的分节，按语言分键。
  - 把“预取命中 ≤2 ms”改为分节命中率。

### RT2-13【major】必含块里的用户原话没有上限，长对话会 RELAY_INPUT_LIMIT

- **章节**：§5.1 第 2 节；§6.3 mustHave；§8.1；§16 S4
- **证据**：
  - 【事实】fresh 目标“自上次送达以来的全部用户消息”就是全部消息，每条 ≤4,000 字，且只要推送回复就不得省略；`mustHave > T` 时直接 blocked，没有回退。
  - 【推断】200 条 × 150 字 ≈ 3 万 token（按 1 token/字推算），远超 8,000。这与“历史再长也只分层”以及 §8.1“只可能是原话过长”矛盾。
- **修正**：【建议】
  - 用户原话单独设预算：首条与最近 k 条逐字，其余写成单行，按区间计数。
  - 放不下时先撤回复文字；永不因历史长度 blocked。
  - 增加属性测试。

### RT2-14【major】S5 交接单的句子写死，与真实结果竞态时会误导模型

- **章节**：§9 S5；§16 S5
- **触发**：(a) 刚批准写入 .env（runtime.ts:232、235）就点［停止并切换］；(b) 回合已在 settling 时点［停止并切换］。
- **证据**：【事实】交接单固定写“批准没有给出”和“被停止”，而 `cancelRequested` 优先于 backend 结果（runtime.ts:1487）。【推断】(a) 实际上批准已给出；(b) 已完成的回合被记为 cancelled，模型会重做已完成的工作。
- **修正**：【建议】第 1、7 节由事件推出：permission.decided/submitted/closed、backend.status，以及 stop 与 settled 的先后；增加“停止请求晚于完成”的标注。

### RT2-15【major】源绑定 pending 时仍判为精确分支

- **章节**：§7.5
- **触发**：A 的第 k 轮带了增量 P，Codex 回合 completed 却没有 userMessage（hook 拦截，R8 X4），核对失败后处于 pending；用户在第 k 轮“从这里分支”。
- **证据**：【事实】精确条件只看 throughRunId、后续派发和纪元，分支绑定就被设为 `originIncluded=true`。【推断】P 若没进入原生历史，B 的工作在这个分支里永远不会交出。
- **修正**：【建议】精确分支另加条件：源绑定 synced，且水位覆盖 through 之前的全部外来事实；否则设 `originIncluded=false`，或让分支继承 pending。

### RT2-16【major】OpenCode 的 costly 核对要“另开连接”，在 finalize 里做不到

- **章节**：§7.1；§8.1 OpenCode 行；§9 清理表
- **证据**：
  - 【事实】finalize 在 open 之后执行，此时已持有工作区租约。`factory.prepare` 每次都要获取租约（binding-factory.ts:147），第二次获取会报 WORKSPACE_BUSY（workspace-lease.ts:110）。
  - 【推断】`verifyDelivered` 是 Driver 方法，拿不到 launch 和租约，无法另开连接；第二个进程没有所有者（INV-26），而且会启动用户的 MCP 与插件。
- **修正**：【建议】v1 把 OpenCode 的 verify 声明为 none；若要保留，改用工厂的无租约 probe（binding-factory.ts:237–267），归 Coordinator 所有，在 prepare 之前执行，上限 5 s。

### RT2-17【major】“派发前停下，交给用户选择”没有状态、错误码与期限

- **章节**：§7.2 suspect 无法核对；§7.4 ②；§12.4
- **证据**：【事实】走到这一步时目标进程已启动、持有租约；v1 没有定义 Run 此时的状态，也没有错误码、事件或 API 字段。【推断】若实现成等待，进程与租约会被无限期占用。
- **修正**：【建议】改为派发前失败 `RELAY_CHOICE_REQUIRED{options}`（草稿保留），选择经 `relay.resolution` 进入下一个 Run；或计入等待预算并发出 permission 类事件。

### RT2-18【major】同意检查与厂商观测、撤回之间存在竞态

- **章节**：§10.4；§12.4；INV-33
- **触发**：(a) Claude 经网关实际接的是 DeepSeek，open 之后才观测到真实厂商；(b) finalize 通过同意检查后、run.dispatched 之前，用户撤回了同意。
- **证据**：【事实】同意的键在 open 之后才确定，而 send() 是同步受理（runtime.ts:343–370）。【推断】409 只能针对受理时的猜测；(b) 违反 INV-33。
- **修正**：【建议】受理时按上次观测预检并返回 409；finalize 复检，不符则 RELAY_CONSENT_REQUIRED；在 run.dispatched 的事务里再读一次同意，已撤回就不派发。

### RT2-19【minor】relay 选项不持久，也不进命令指纹

- 【事实】`send()` 的指纹只含正文与附件（runtime.ts:347）。【推断】同一个命令键换了档位或附言再提交，会被当作重放。
- 【建议】把选项写进 `message.accepted` 与 `PublicRun.relayRequest`，并在有选项时扩展指纹。

### RT2-20【minor】清理所有者与观测时机

- 【事实】代码里没有删除会话的路径，“随会话删除”不存在。
- 【事实】relay_bodies 没有 session_id，“16 MiB/会话”既无法执行也无法回收。
- 【推断】预取时的观测既没有所有者，也不在租约内。
- 【事实】§6.1 的观测早于 prepare 获取租约（binding-factory.ts:147）。
- 【推断】S5 所说的“中断时的 diff”，实际是在下一条消息时才观测。
- 【建议】给 relay_bodies 加 session_id 或引用计数；预取只读已落库的观测；观测改到 prepare 之后。

### RT2-21【minor】E1 并入“下一次既有提交”会打乱 ADR-047 的到达顺序

- 【推断】E1 晚到时会排在已收到的文字之前。
- 【事实】ADR-047 第 5 条没有涵盖 E1；earlyClose 时如何处理没有写明。
- 【建议】如有打开的窗口，先冲刷再记录 E1；补一条 ADR 修订；input_recorded 不得设置 firstOutputAt。

### RT2-22【minor】RunDigest 在线值与重建值不一致（INV-22）

- 【事实】在线值用的是内存中的 details；earlyClose 时不写详情（runtime.ts:1452–1454），storeDetail 失败只记一条诊断（1267）。
- 【推断】cumulative 依赖上一条 digest，迁移后全部 behind 时新值无法正确计算。
- 【建议】只用已落库的详情并标注 `detailsMissing`；cumulative 在渲染时求和。

### RT2-23【minor】框架模板假定来源是“另一个 Harness”

- 【推断】native-reset、清空后附上、S10 时来源与目标是同一个 Harness；有多个来源时，模板只能写一个名字。
- 【建议】增加“你的另一个原生会话”和“先后由 X 与 Y 进行”两种变体。

### RT2-24【minor】包类型与命令效果的缺口

- 【事实】“重锚＋增量”没有对应的 kind；plan() 从不产出 reanchor。
- 【事实】pending 遇到 compact 时谁优先没有定义。
- 【事实】OpenClaw `/reset soft` 保留转录（R8 W6），却被映射为 clear。
- 【建议】补齐 kind 与 plan() 分支；contextEffect 按参数判定。

### RT2-25【minor】并行对话共用工作区时，改动来源被误写

- 【事实】ADR-036 下，同一工作区由不同对话轮流持有（runtime.ts:851–855）。
- 【推断】对话 Y 的改动在对话 X 中会显示为“可能来自你的编辑器”。
- 【建议】按其他对话的回合时间窗归属，写成“另一个 HarnessHub 对话”。

## 2. 崩溃注入点表

主线是 A→B 空闲切换后 B 的第一条消息（S15），另加 S5 与保留进程两种情形。各行的状态按现码加 v1 推导，没有实际注入。

| # | 注入点 | 重启后状态 | 用户看到 | 模型看到 | 问题 |
|---|---|---|---|---|---|
| K1 | switch.requested 后、validated 前 | 切换 failed{OWNER_ENDED}；等它的排队 Run 记 cancelled；会话 open（state.ts:473–477） | 切换未生效；消息“已取消（服务重启…）” | 无 | RT2-03 |
| K2 | validated 后、effective 前 | 同 K1 | 同 K1 | 无 | 同 K1 |
| K3 | 恢复切换正在验证目标 | 恢复 failed，仍 blocked；验证进程可能成孤儿 | 可重试恢复 | 无 | 现状遗留 |
| K4 | message.accepted 后 | Run 记 cancelled | “已取消（服务重启…）” | 无 | RT2-03 |
| K5 | run.preparing 后、finalize 前 | unknown，blocked；cleanup=null，RECOVERY_UNSAFE（runtime.ts:750） | 只能分支或关闭 | 程序已启动，未收到提示 | RT2-06 |
| K6 | binding_prepared 后 | 同 K5，目标绑定 unconfirmed | 再用该 Harness 须重建 | 无 | RT2-01 |
| K7 | context_prepared 后、authorized 前 | 同 K5；in_flight 无人修改；pending 不回退 | 占位“送达中”一直挂着 | 无 | RT2-06、RT2-07 |
| K8 | authorized 后、dispatched 前 | 同 K7 | 同 K7 | 无 | RT2-08 |
| K9 | dispatched 后、E1 前 | unknown；送达应为 unknown，实际停在 in_flight | blocked；分支后写“结果未知” | 可能已收到并继续执行 | RT2-05、RT2-06 |
| K10 | E1 已在内存、未提交 | 同 K9（E1 丢失，结果偏保守） | 同 K9 | 已收到包 | 可接受 |
| K11 | first_output（含 E1）提交后 | 送达 recorded；绑定是否 synced 未定义 | 分隔线已出现，随后 blocked | 已收到包 | RT2-06 |
| K12 | backend_settled 后、run.ended 前 | unknown；E3 与核对结果丢失 | 已完成的回复被标为未知 | 本轮已完成 | v1 未交代 |
| K13 | S5 停止请求后、宽限内 | unknown；切换 failed；RECOVERY_UNSAFE | 只能分支或关闭 | 网关型 A 可能继续执行 | RT2-05 |
| K14 | S5 宽限到期、关闭连接后（不崩溃） | unknown；切换仍待决，RECOVERY_UNAVAILABLE | 卡住直到重启 | A 可能继续执行 | RT2-04、RT2-05 |
| K15–K18 | 下一轮 relay.verified 提交前；v13 迁移中；懒重建中；保留进程空闲时 | 分别为：上一轮仍 unknown、本轮同 K5；整笔回滚并保留备份（sqlite-store.ts:452、587）；digest 保持 behind；reapKept 结束进程组，绑定与 relay 不变（runtime.ts:571–593） | 同 K5／启动失败提示／无／“重启时结束了保留的进程” | 无 | 无问题 |

【推断】只有 K1、K2、K4 之后能在同一对话里继续；K5–K14 都要分支或新开对话。S15 的文案和 G056 的故障矩阵应写明这一点。

## 3. 已核对，无问题

已核对：finalize 早于 authorized，与 state.ts:448 相容；送达结论另表存放，不改写终态 Run（state.ts:441）；recoverSession 把非 queued 记 unknown 且不重跑，拒绝 P2 的 cancelled 正确；单待决切换（runtime.ts:386），切换前受理的输入按旧选择执行（976–980），非恢复切换只做 validate（1563、1603），“同时切换”与 J3 M7 文案成立；保留进程复用时不 open（1345–1354），只保留 completed 回合（638），切换时释放（1566），重启时由 reapKept 回收；import 绑定 ready、throughRunId 为 null（334），同一会话不被两个对话持有（310–313），首轮零注入成立；Codex 无 turnId 拒绝与 OpenClaw `model_not_applied` 发生在插入前（R8 X4、W4）；`BackendResult.input` 在 v12 持久化前剥离（state.ts:95）；438 的新增条件修复 J1 F1(a)；迁移只降不升；LRU、观测子进程、after_turn 核对都有上限与所有者。

## 4. 假设与未验证项

- RT2-05 依赖 R8 H5、W5 的推断（置信度中、低中），v1 的 S14 本身以此为前提，需真机核实（J3 R-7）。
- RT2-09 的窗口溢出频率未实测；RT2-13 的 token 数为推算。
- 第 2 节由代码路径推导，未实际注入崩溃；未做网络调研。
