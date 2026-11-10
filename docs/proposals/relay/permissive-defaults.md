# 默认放行的规则裁定（W5，审批代理，2026-11-10）

**依据与证据等级**：只读 `cd542d2` 的 AGENTS.md、ADR-055、终稿第 6.2、7、8.1、9、10.1、10.4、12 节、`stage3-workstreams.md`、`delivery.ts`、`relay-coordinator.ts`、`contracts/relay.ts`、`relay-tables.ts`、`invariants.md` 与六家 Driver 的声明。没有运行测试或 Harness，没有读工作区未提交的改动。以下是设计裁定，不是实现或验证结论。

**一处要告知**：我把 `cd542d2` 的五个文件导出到了共享 scratchpad（`delivery.ts`、`coord.ts`、`adr.md`、`arch.md`、`contracts-relay.ts`）。那个目录里已有别的代理的文件；如果它原先有同名文件，现在已被 `cd542d2` 的版本覆盖。仓库内没有改动。

## 0. 三条总规则

1. **只关乎交接单的问题不拦消息。** 交接单发不了或拿不准时，消息照发，交接单留作欠交，界面常驻一行提示。只有消息本身发不出（目标启动失败、原话超过通道上限、存储故障）才让 Run 失败。
2. **自动动作只有三种，都不抬水位、不抬清空下限、不换原生会话：**
   - **补发**：事件 `carry`（a）。
   - **退到纪元基准后补发完整交接单**：事件 `carry` 带 `retreat`。
   - **策略单发**：事件 `alone`（n），绑定状态逐字节不变。
3. **用户显式选过的不被策略改写。** 请求带 `relay.attach:"full"`、`resend`、`clearConfirmed`、`native`、`tier` 时按用户的来；显式要“附上”而附不了，仍让 Run 失败、草稿保留。

新增一个模式开关 `relay.whenUnsure ∈ {auto（默认）, ask}`。`ask` 等于 `cd542d2` 的现行行为，现有测试在 `ask` 下应原样通过。

## 1. 默认行为总表（`relay.whenUnsure=auto`）

| # | 情形 | 默认 | 用户看到（不拦路） |
|---|---|---|---|
| 1 | pending，核对后仍未知，`autoResends=0`（含 `lateDelivery` 的 OpenCode、OpenClaw） | 自动补发一次 | “上一份交接单没有确认送达，这条消息已再附一次（#n）” |
| 2 | pending，`autoResends=1`，没有新的外来事实 | 策略单发，pending 不变 | “交接单 #n 发了两次仍未确认送达 · 这条只发了原话 [再附一次] [新开原生会话]” |
| 3 | pending，`autoResends=1`，又来了新的外来事实 | 自动补发（新种类 `grown`），计数归零 | “补交 N 轮（含上次未确认送达的内容）” |
| 4 | 没有任何正面证据机制的 Driver（未声明，如 WorkBuddy） | 首发一次，不自动重发；之后只在有新事实时再发 | “已发给 X，这个 Harness 无法确认是否收到” |
| 5 | suspect（rewind、unknown_command、clear_unconfirmed），核对无定论，没有新欠交 | 策略单发，保持待核，下次 open 再核 | “未能核对 X 原生会话里的交接内容 · 这条按原样发出 [补发完整交接单]” |
| 6 | suspect（上述三种加 legacy、marker_absent），有新欠交 | 退到纪元基准，补发完整交接单 | “未能核对 X 的原生会话，已补发完整交接单（可能与已有内容重复）” |
| 7 | marker_absent 且有新欠交 | 同 6 | “X 的原生会话里找不到之前的交接单，已在同一会话补发” |
| 8 | 未确认的清空 | 按“没清空”：下限不抬；没有新欠交走 5，有新欠交走 6 | “清空待确认 · 不确认的话，下次补交会带上清空前的记录 [确认已清空]” |
| 9 | unknown_turn（D6） | 不带包：现状已不问；带包核不了：现状退回 pending{1}，之后走 2 或 3 | 同 2 |
| 10 | `RELAY_TARGET_UNVERIFIED` | 不拦 | 交接卡标“未经真机验证” |
| 11 | `RELAY_CONSENT_REQUIRED{missing}` | 允许，先写 `relay_log` 再发 | 首次每厂商一句：“这条消息会附上之前的对话记录交给 Codex（OpenAI）· 可在设置里改为每次询问” |
| 12 | `RELAY_CONSENT_REQUIRED{vendor_changed}` | 允许，追加日志，照发 `relay.vendor_changed` | “Codex 这次经 gateway:example.com 处理（上次是 OpenAI），已记录” |
| 13 | 用户撤回过该厂商的同意（revoked） | 策略单发，不发历史 | “你已撤回对 OpenAI 的允许 · 这条只发了原话 [重新允许]” |
| 14 | `RELAY_UNAVAILABLE{data_root_in_workspace}` | 不拦，只提示；“首次发送要求确认”也取消 | 工作区级横幅：“HarnessHub 的数据目录在这个工作区里，目标 Harness 能直接读到全部对话记录；建议用 --data-dir 移到工作区外” |
| 15 | `RELAY_UNAVAILABLE{recovery_failed}` | 策略单发 | “服务重启后没能恢复这个对话的交接记录 · 这条只发了原话 [新开原生会话]” |
| 16 | `RELAY_INPUT_LIMIT` | 先降到放得下的最高档；连最小交接单都放不下才策略单发 | 降档：“X 的窗口较小，交接单已缩为精简”；放不下：“X 的上下文窗口放不下交接单 · 这条只发了原话” |
| 17 | 回到原 Harness | `relay.returnPreference=continue` 不变：续接原会话补增量，从不自动新开 | 终稿 T0、T7 现有文案；并列的“新开并附交接单”只是可点的选项 |
| 18 | 交接后首条是命令 | 现状已是原样发送、交接单留给下一条 | “这是 X 的命令，不会附上交接单；交接单会随下一条普通消息发出” |
| 19 | open 后分类与受理时不符（`classification_changed`） | 同一 Run 内按 open 后的分类重新决定，不失败 | 判为命令时同 18 |
| 20 | 只关乎交接单的准备失败（render、render_mismatch、redaction_failed、storage、storage_quota、consent_log_full） | 策略单发 | “这次没能准备交接单（原因）· 这条只发了原话，下一条会再试” |

默认模式下没有任何一格仍以 409 询问。原来的选项都变成提示条上的按钮。

## 2. 逐条论证

记号：事件名取 `delivery.ts`。“有证据能力”≔ `live≠none ∨ verify≠none ∨ successProvesRecorded`（六家都满足，只有未声明的 Driver 不满足）。“新欠交”≔ 按绑定当前水位算的 `owed()` 非空。

### 2.1 `delivery_unconfirmed`

- **决定位置**：受理不再抛，改在 open 的 k 之后由 `decideTurn` 决定。策略决定的回合，开场核对照常做，不套“只发这条消息的回合开场不问 Driver”（那只对用户自己选的单发）。
- **`pendingResend` 改为** `pendingResend(sync, 声明, 模式, grown)`，返回 `auto | grown | alone | choice`：
  - `ask` 模式：现状。
  - `auto` 模式：无证据能力时，`grown` 则 `grown`，否则 `alone`；`autoResends=0` → `auto`；`grown` → `grown`；其余 `alone`。
  - `grown` ≔ 新包的 `range.throughSeq` 严格大于 `sync.range.throughSeq`。
- **`lateDelivery`**：`auto` 模式下不再把自动重发压到 0 次，仍至多 1 次。迟到写入若落在重发之后，重复一份；重发模板自带去重行。`unknown{late_delivery}` 的结论照记。
- **三种核对能力**：
  - `on_next_open`（Hermes）：open 的 k 先核 P；在场 → g，不重发；其余 → 按上面取值。
  - `after_turn`（Claude Code、Codex、OpenClaw）：结算时已核。策略单发回合的结算要照常对仍 pending 的包做 after_turn 核对，否则它永远等不到 E2。
  - `none`（OpenCode、DeepSeek Harness）：没有核对，直接按计数。两家各靠 E3 与弱 E1 定论，重发通常一次就结束。
- **状态机改动**：
  - `carry` 在 pending 上新增 `resend.by:"grown"`。前提是 top 严格变大，否则 `invalid`；结果 `autoResends=0`，`manualResends` 不变，照写 `resendOf`。
  - `by:"auto"` 的 `lateDelivery` 拒绝条件，改由协调器按模式给值。
  - `BindingSync` 的形状不变，不动契约解析器。
- **重复上界**：同一个 top 至多 2 次自动发送（首发加一次重发），由 `autoResends ∈ {0,1}` 保证；top 变大才再发，由 `grown` 的前提保证。连发 20 条普通消息、没有别的事件，至多 2 行送达行。
- **不丢事实**：`alone` 不改状态；`carry` 的 pending 以 prior 的水位算 need；水位只被 g 推进。
- **`pendingRun=null`（送达行缺失）**：策略单发，`rowMissing` 照记。
- **pending 且 need=∅**：A7 的裁定不变；它落地之前按策略单发。
- **退回的 `pending{autoResends=1}`（carried 核不了）**：状态机不改，仍记 1。这里不自动补发，因为 carried 不保存 P 自己已重发几次，放开就得加计数字段；按第 2、3 行处理，零重复、不拦。

### 2.2 `verify_required` 与 `marker_absent`

现有裁定已把能自动解析的格都解析了（`uncheckedSuspect`、`carriedUnseen`、`clearChecked`、`markers`），这些不动。默认模式只处理 k 之后仍是 suspect 的剩余：

| cause | 核对给出结论 | 核对 unavailable、outside_window、none |
|---|---|---|
| rewind、unknown_command | 现状：恢复、回退或推进，不问 | 无新欠交 → `alone`；有新欠交 → `carry` 带 `retreat` |
| legacy | 没有可核对的东西 | 无新欠交 → 现状 `plain`（nothing_owed）；有新欠交 → `carry` 带 `retreat`，每个 legacy 绑定只发生一次 |
| marker_absent | 结论本身就是 absent | 无新欠交 → 现状 `plain`；有新欠交 → `carry` 带 `retreat` |
| clear_unconfirmed | 规则 ①④ 确认清空，③ 恢复，不问 | 见 2.3 |
| unknown_turn | 现状全部自动 | carried=null 保持原水位；carried≠null 退回 pending{1} |

- **实现**：`decideTurn` 里，suspect、无显式选择、`auto` 模式、`needOn(relay)` 非空时，走现有的 `requested` 分支（`retreatedPrior`，含 R5 的“退回后无可附则原样”），记 `by:"policy"`。`plain` 被 `verify_first` 拒绝时，改返回 `alone{by:"policy"}`，不抛。`admitRelay` 在 `auto` 模式不抛 `choiceRequired`；`clearConfirmed` 的 `INVALID_INPUT` 校验保留。
- **为什么不自动“信任水位”**：回退若真删了带包的回合，Hub 会把没了的事实记成已送达，是丢事实。`carry` 无 `retreat` 的 `verify_first` 拒绝保持不变。
- **为什么没有新欠交时不补发**：此时发出的字节与信任水位时相同，补发整包纯属猜测；待核状态留着，下次 open 再核，多半是瞬时的核对失败。
- **重复上界**：每次待核至多一份完整包加一次自动重发。补发后状态是 pending，不再是 suspect，要再退一次必须有新的 f、e′、D6 或 marker_absent 判定，都由用户的命令、继续操作或一次返回引起。包的大小受档位上限约束。
- **最坏的稳态**：核对恒不可用且用户常用效果未知的命令（OpenClaw 的 `/bash`，其核对可能恒超时）时，每次回到该 Harness 发一份完整包而不是增量。按返回次数有界，不按消息数。
- **不丢事实**：`retreat` 只降水位；`alone` 不改状态。

### 2.3 未确认的清空：按“没清空”

**裁定**：核对无定论时一律按“没清空”，下限不抬、纪元不加。清空仍只由规则 ①④、Driver 的确认或用户的［确认已清空］确认。

- **没有新欠交**：`alone`，保持 `suspect{clear_unconfirmed}`。这样每次 open 还会再核，［确认已清空］一直可点。
- **有新欠交**：`carry` 带 `retreat`，与 2.2 同一条规则。
- **各自的后果**：
  - 当作“清空了”而其实没清：`(水位, floorCandidate]` 里欠交的事实与 carried 包的事实永远不再交付，是丢事实，不可自动。
  - 当作“没清空”而其实清了：下次有新欠交时，完整包会把清空前的外来事实一并带回，是一次有界的多发，违背用户清空的本意但不丢事实。所以提示条从清空那一刻起就要说明并给［确认已清空］。
- **没有采用“信任水位、只发增量”**：`rewound` 与链上有缺失时不健全；统一走 `retreat`，实现者只有一条规则。
- **没有采用“可证明无损时自动确认”**（清空时 `(水位, floorCandidate]` 内无欠交、无 carried、非 rewound）：它确实不丢事实，但与底线“清空由用户的操作或确凿证据确认”的字面冲突。主负责人若把用户敲的 `/clear` 本身算作“用户的操作”，可作为后续优化；本批不做。
- **OpenClaw 的 `lifecycleRevision` 确认**（B7）在探针前仍不得用来确认清空，这是“确凿证据”的底线，不因放行改变。

### 2.4 受理处的门

- **探针门控**：
  - `relay.allowUnprobed` 默认翻为 `true`；`RELAY_TARGET_UNVERIFIED` 只在设为 `false` 时出现。
  - 以下按 `probed` 的判断是正确性，不放开：D6 要求 P16（否则可能重跑回合，INV-11）；`compactionEvidence:"none"` 写常量游标要求探针（规则 ④ 的健全性）；B7；Hermes 的 `setTitle`（B10）。
  - 未声明的 Driver（`relayDeclaration(null)`，即 WorkBuddy 作为目标）也放行：单段文本、斜杠词不捎带（B9）、不自动重发、状态如实写“无法确认”。不放行的话，切到它就是零上下文，比 v12 的 MVP 还退步。
- **同意**：
  - `relay.crossVendor` 默认翻为 `allow`。
  - “留痕”是机制不是提示：某厂商键第一次被使用时，向 `relay_log` 追加一行（`decision:"allow"`，`scope:"global"`，来源记 `default`，`command_id` 取 `default-allow:<厂商键>:<policyVersion>` 以幂等），先于或同事务于 `run.context_prepared`；送达行的 `consentLogSeq` 必须非空。
  - finalize 观测到不同的厂商键：同一事务追加新键的日志行，发 `relay.vendor_changed`，照发。
  - 撤回是用户的显式指令：该厂商最新一行是 revoke 时不发历史，策略单发。
  - `goal_only` 不变。首次说明不再把 Enter 改成“只展开说明”。
- **数据根**：检查照做（`(st_dev, st_ino)` 与标记查找），结果只用于启动告警与横幅；新增 `relay.dataRootInWorkspace=block` 时恢复 409。D5（密钥与附件物化目录在数据根之外）不变，它不拦用户。
- **`recovery_failed`**：策略单发。不自动新开原生会话，那会丢原生上下文。标记的清除条件不变（native-reset 或新开原生会话）。本批不做自动重试恢复。
- **`RELAY_INPUT_LIMIT`**：
  - `chooseBudget` 已是只降档；`hardCap < MIN_PACKET` 时，受理与 finalize 都改为策略单发。
  - 之后每条都单发、零重复，提示每个绑定纪元出现一次。
  - Driver 的越限兜底（B4a）保留；原话自己超过通道上限仍是失败。
- **顺带裁定（主负责人的读法没覆盖）**：“可以不在乎预算”按字面也适用于产品里的费用防御。`chooseBudget` 的费用与时延降档（`COST_USD`、`LATENCY_S`）与价格悬崖降档默认关闭，只保留显示；窗口与通道上限（`hardCap`、5% 规则）是物理与质量约束，保留。实现为策略常量，变更时升 `policyVersion`。主负责人不同意可单独撤回，可逆。

### 2.5 返回、命令与派发前失败

- **返回原 Harness**：默认 `continue`，D9 不变。新开原生会话永不由策略自动选；`new_when_cold` 与 `ask` 保留为可选。
- **首条是命令**：现状已符合，不改。
- **`classification_changed`（Runtime 侧）**：open 后用 Driver 声明的 `classify` 与真实目录重判（C7），并在同一 Run、`run.context_prepared` 之前按新分类重新决定：判为命令 → 原样发送、按命令回合结算（c、d、e、e′、f），交接单留给下一条；判为内容 → 走 `decideTurn`。此前没有任何行落库（INV-21），所以不是重跑。
- **Driver 侧的整回合拒绝（B4b）**：保留为缺陷兜底。Run 失败、什么都没发；界面的［重试］对这个原因带 `attach:"none"` 重发，避免同一文本反复被拒。
- **只关乎交接单的准备失败**：在提交 `run.context_prepared` 之前捕获，改为 `alone{by:"policy"}`。脱敏失败仍然“不发交接单”，INV-29 不变。`target_start` 仍失败。

### 2.6 决定的记录

`run.context_prepared.data.relay` 增加 `decision: { kind: "carry" | "alone" | "plain", by: "need" | "policy" | "user", cause?: "delivery_unconfirmed" | "verify_required" | "marker_absent" | "input_limit" | "recovery_failed" | "consent_revoked" | "prepare_failed" | "classification_changed" }`。事件类型是开放的，不动 DDL。

`GET …/relay` 的每个绑定增加 `attention?: { cause, options, counts }`，形状沿用 `stage3-workstreams.md` 第 3 节的错误体，界面据此画提示条。同一原因在同一次待核内只提示一次，被关掉后不再弹，详情栏常驻状态。

## 3. 新风险与封顶

| 风险 | 封顶 | 清零或解除 |
|---|---|---|
| 每条消息都自动补发 | `autoResends` 至多 1；用尽后只有 `grown`（top 严格变大）才再发 | g；首包的 h 回到 prior；`grown` 或 `retreat` 的新 pending 从 0 起。n、c、d、未确认的 k、退回的 pending 都不清零 |
| 每条消息都补发完整包 | `retreat` 之后状态是 pending，不是 suspect | 新的 f、e′、D6 或 marker_absent 判定 |
| h 之后反复发 | 每次 h 是确知没发出，不构成重复（现状如此） | — |
| 无证据能力的 Driver 每次交接发两份 | `auto` 重发要求有证据能力 | — |
| Driver 的核对与送达证据矛盾（标题行被改写，恒答 absent） | 每次返回一份完整包，按返回有界；不加运行时计数 | RelayConformance 断言：E1 或 E3 记为 recorded 的包，紧接着的核对不得答 absent |
| 策略单发后接力静默停摆 | `attention` 常驻，欠交轮数可见；新事实触发 `grown` 或 `retreat` | 证据到达，或用户点按钮 |
| 默认允许后无痕出境 | `consentLogSeq` 非空是派发前提 | — |

不需要新的持久计数器，也不改 `BindingSync` 的形状。

**新增或修改的属性测试断言**（接进现有的状态机属性测试与假 Harness 参考模型）：

- **P1 不拦**：`auto` 模式、请求不带显式接力选择时，`admitRelay` 与 `decideTurn` 不抛 `RELAY_CHOICE_REQUIRED`、`RELAY_TARGET_UNVERIFIED`、`RELAY_CONSENT_REQUIRED`、`RELAY_UNAVAILABLE`、`RELAY_INPUT_LIMIT`。
- **P2 不丢**（原属性在策略决定下继续成立）：任意序列下 `mark.throughSeq` 不超过参考模型里实际送达或亲历的。
- **P3 策略不确认清空**：只含策略决定的转换里，`epochFloor` 与 `nativeEpoch` 不变。
- **P4 单发不改状态**：`alone{by:"policy"}` 前后的 `BindingRelayState` 逐字节相同，`dispatched === input`，不产生送达行与 `relay.input_recorded`。
- **P5 有界**：任意两行相邻的策略送达行之间，至少发生过其一：top 变大；f、e′、D6 或 marker_absent 判定；前一行是该 top 的首发而本行是它唯一的自动重发；前一行结算为 not_recorded。
- **P6 不按消息重复**：从任意可达状态起，连续 K=20 条内容输入、其间没有别的事件、结果全 unknown、核对全 unavailable，策略送达行至多 2 行。
- **P7**：无证据能力的声明下，`by:"auto"` 的行数为 0；`by:"grown"` 在 top 不变时被拒。
- **P8 留痕**：每个跨厂商的送达行 `consentLogSeq≠null`，且该日志行的 seq 不晚于它的 `run.context_prepared`；厂商最新一行为 revoke 时没有送达行。
- **P9 严格模式等价**：四个严格取值全开时，`cd542d2` 的现有用例原样通过。
- **P10 显式选择优先**：带 `attach:"full"` 或 `resend` 而无法携带时 Run 失败，不被改成单发。
- **P11 如实**：策略单发的 Run 的 `continuity` 与分隔线不出现“已接手”。

## 4. 设置项

| 键 | 取值 | 默认 | 入口 | 说明 |
|---|---|---|---|---|
| `relay.crossVendor` | `ask`、`allow`、`goal_only` | **`allow`**（原 `ask`） | 设置页（“跨厂商交接：允许 / 每次询问 / 只交目标”） | `ask` 恢复 `RELAY_CONSENT_REQUIRED` 全套，含工作区来源端点每会话询问 |
| `relay.whenUnsure`（新） | `auto`、`ask` | `auto` | 设置页（“送达拿不准时：自动处理 / 每次问我”） | `ask` 恢复三种 `RELAY_CHOICE_REQUIRED`、`RELAY_INPUT_LIMIT`、`recovery_failed` 与准备失败的现行行为，以及 `lateDelivery` 0 次重发 |
| `relay.returnPreference` | `continue`、`new_when_cold`、`ask` | `continue`（不变） | 设置页 | — |
| `relay.allowUnprobed` | `true`、`false` | **`true`**（原 `false`） | 只经 API | `false` 恢复 `RELAY_TARGET_UNVERIFIED` |
| `relay.dataRootInWorkspace`（新） | `warn`、`block` | `warn` | 只经 API | `block` 恢复 409 |
| `relay.localModelsOffline` | `true`、`false` | `false`（不变） | 设置页，仅 `crossVendor=ask` 时显示 | `allow` 下不起作用 |

**实现注意**：`relay_prefs` 的 DDL 用 `CHECK(key IN(...))` 枚举了四个键（`relay-tables.ts` 第 67 行），`RELAY_PREF_KEYS` 与 `RELAY_PREF_VALUES` 同步枚举。按 ADR 的记载，v13 还没有部署到任何真实数据根（“不得跑在任何真实对话上”），所以直接改 v13 的 DDL 与契约常量。实现者动手前要确认这一点；若已有 v13 的真实数据根，就得另起迁移放宽 CHECK。

## 5. 对已接受决定的改动

**默认值被反转（机制保留为严格设置）**

- **D1**：改为自动补发，用尽后策略单发；(a) 的 409 留给 `whenUnsure=ask`。
- **D2**：改为降档，放不下则策略单发；429 留给 `ask`。
- **D11**：`allowUnprobed` 默认 `true`。
- **决定 3**：“声明 `lateDelivery` 的 Driver 0 次”改为默认 1 次；“不能自动重发时 409”改为策略单发。
- **决定 7**：费用、时延与悬崖降档默认关闭（顺带裁定）。
- **决定 9**：“生产只对 `probed=true` 开放”“WorkBuddy 受理即拒”反转。
- **决定 10 的数据根与同意两条、INV-33、INV-36**：见下。
- **阶段二“范围与顺序”**：“`allowUnprobed=true` 只在隔离的测试数据根里设置”作废。
- **阶段二“留给所有者本人”**：“`allowUnprobed` 是否用户可见”已定为只经 API。

**保持不变**

- D3（且 B10 仍不启用）、D4、D5、D6（仍要求 P16）、D7、D8、D9、D10。
- INV-11、13、22、29、31、32、34。
- 此前四节审批决定里状态机的全部内容：F1–F13、rewound、`restorable`、“没有可核对的标记”一表、`carriedUnseen` 的门槛、退回的 pending 记 `autoResends=1`、［确认已清空］只由用户选。`step` 的 `verified` 分支、`uncheckedSuspect`、`clearChecked`、`markers` 一行不改。
- A1–A18、B1–B10、C1–C8。其中 A8（受理处接上声明）仍要做，`ask` 模式与命令预分类需要它。
- “同意检查落地之前不得跑在真实对话上”继续有效，含义变为“留痕（`consentLogSeq`）落地之前”。

**必须同步改写**

- **ADR-055**：决定第 3、4（清空未确认一句）、7、8、9、10、13、15 条；“用户拍板的取舍”表的 D1、D2、D11 加“2026-11-10 默认反转”注；“失败边界”一节；把本裁定作为“审批代理的决定（2026-11-10，默认放行）”补记。
- **终稿**：
  - 第 0 节摘要；第 6.1 节受理顺序与“缺项同步返回”；第 6.2 节降档与 `blocked`。
  - 第 7.2 节：pending 行的 a 与 g/h/i 格；suspect 行的 a、b 格；表后的 `admitsWithoutChoice` 段注明只在 `ask` 模式；属性清单加 P1–P11。
  - 第 7.4 节：清空段的“按没有发生处理”扩到全部未定论；“标记缺失 ③”；“unknown 的重发”。
  - 第 8.1 节：OpenCode 回退格“重发 0 次”；WorkBuddy 行。
  - 第 9 节：“超限”“需要用户选择”“准备失败”“错误码按阶段”“Hub 中途重启”“数据根在工作区内”“同意日志触顶”各行。
  - 第 10.1 节的 409 与首次确认；第 10.4 节的键、时机与文案。
  - 第 12.1 节的 T0、T2、T5、T7；第 12.3 节；第 12.4 节的 prefs 六键、`attention` 与错误码。
  - 第 14.1 节 `relay_prefs` 的 CHECK；第 14.2 节 `run.context_prepared` 的 `decision`；第 14.3 节；第 16 节走查；第 19 节把 D1(b)、D11(b) 从否决表移为“默认采用（如实提示）”。
- **`docs/domain/invariants.md`**：
  - **INV-14**：“待核的绑定在核对或用户选择之前不复用”改为“在核对、用户选择或策略决定之前不在其水位上组包；策略只能单发或退到纪元基准后补发”。
  - **INV-21**：加“只关乎交接单的准备失败默认降为原样发送，relay 状态不变”。
  - **INV-30**：n 的前提加“或策略决定的单发”；完整交接单的例外加“待核时策略补发，每次待核至多一份”。
  - **INV-33**：改为“每次跨厂商派发都有一条先于它提交的 `relay_log` 记录（用户同意或默认允许），撤回后不再发出；厂商键变化照记不拦；`ask` 下恢复原条款”。
  - **INV-35**：“只让本 Run 失败”改为“默认不让本 Run 失败”。
  - **INV-36**：“前提”改为“检查并提示；`block` 时为前提；附件物化目录与密钥不在数据根内不变”。
  - 文末“接力不变量”各条的所有者与用例随之更新。
- **契约**：`switching.md` 的 R4、R6、R9、R10；`public-api.md` 的错误码表、prefs、`attention` 与 `decision`；`security.md` 的同意与数据根；`context-transfer.md` 的重发与完整包条款；`stage3-workstreams.md` 第 3 节加 `attention` 与六个 pref 键；`plan/test-cases.json` 登记 P1–P11。

## 6. 留给所有者本人

只有一点是新的、对外且不可收回，我拿不准：

**默认允许是否也覆盖“端点来自工作区文件”与 `unknown:*`、`gateway:*`、`router:*`、`provider:*` 的厂商键。** 原设计对它们每个会话都问，因为上一个 Harness 往工作区写一行 `.env` 就能把下一个 Harness 的端点改向别处，历史随交接单发到用户从未点名的主机。

我的裁定是也允许，加一条醒目提示（第 12 行的文案，注明“来自工作区 .env”）。理由是那个 Harness 在该工作区里本来就会把用户的输入与代码发往同一端点，Hub 多带的只是经过出境脱敏的历史，这与“复用各家 Harness 的能力”一致。所有者没有另外指示时按此实现。如果要更稳，备选是给 `relay.crossVendor` 增加取值 `ask_unverified`：只对工作区来源与未知键询问，其余允许。

其余不是新增、仍归所有者的事项没有变化：推送与 4317 升级；真机探针的账号与额度；Hermes、OpenClaw 的出站范围；B2 的对外措辞。
