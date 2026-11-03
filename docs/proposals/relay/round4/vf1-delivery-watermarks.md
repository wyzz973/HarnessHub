# 终审核验 VF1 · 送达与水位（反驳者）

2026-11-03。对象：[第二版架构](../round3/v2-architecture.md)与[处置表](../round3/v2-dispositions.md)；背景：[简报](../00-brief.md)、[裁定](../02-round2-rulings.md)、[R4](../round1/r4-internal-baseline.md)、[R8](../round1/r8-gap.md)、[J1](../round2/j1-contracts-correctness.md)、RT1–RT5、[原型](../../../../spikes/relay/README.md)。代码基线 `07a0825`（本工作树 src、web、tests 与之相同【事实】）；第三方只读本机 Hermes 源码 `bf0203a794`，写作 `hermes-agent/…`。未运行任何 Harness、测试或服务，只用 python3 与 node 比较了前导空白【实测】。【事实】有出处，【推断】由事实与 v2 规则推出，修正即建议；P0 指第 7.6 节的过渡期。

## 0. 结论

不通过。逐格推演 v2 的状态 × 事件表、伪代码与代码，得到 blocker 3 条（VF1-01～03）、major 9 条（VF1-04～12）、minor 3 条（VF1-13～15）。三个 blocker：pending 的回放核对查错了包；自动重发用尽、lateDelivery 或“只发这条”之后内容回合在表中没有转换；Hermes 的清空在结算时无法确认，之后的回放会把清空前的历史补回。

已核对的项目见第 2 节；D2、清空、配置承接、unknown 重发只在特定条件下成立。

## 1. 发现

### VF1-01【blocker】pending 的回放核对查的是旧包，首份包不查

- **章节**：§7.3 planReturn 首行；§6.1 finalize；§7.2 pending 行 k 列。
- **场景**：Hermes 本纪元已收 P0（recorded）；回 Hermes 带增量 P1 的回合在准入前被取消（R8 H2：不写用户回合），无 E3 → pending{prior=synced{lastPacketId=P0}, P1}；用户再发一条。
- **证据**：planReturn 只在 `A.mark?.lastPacketId ≠ null` 时核对，对象是“本纪元最近 ≤4 份 recorded 交接单”，再“按 7.2 的 k 更新”。P0 在回放里 → present → pending 行 k 列“present → g” → synced{P1.range.throughSeq}：P1 从未进入 Hermes 历史，B 的回合被记为已送达且不再补交，违反 INV-14 与“mark 不超过实际送达”。首次交接时 mark=null，条件不成立，不核对就自动重发，而 Hermes 对 `unknown_execution` 明说“可能已经执行，不要重发”（hermes.ts:38、:125–127【事实】）。R3 验收“unknown → 下回合 open 核对 recorded”对首份包不可达。
- **修正**：pending 只核对 `pending.packetId` 自己的标题行，与 prior 有无 mark 无关；suspect 才核对已 recorded 的包；§6.1 条件改为“pending ∨ (suspect ∧ lastPacketId≠null)”；属性测试：旧包 present 不推进 pending 包。

### VF1-02【blocker】pending 下内容回合没有转换：重发上限、lateDelivery、`attach:none` 落空

- **章节**：§7.2 pending 行；§6.3 plan()；§7.4；§8.1 OpenCode 行；§9。
- **场景**：Claude → OpenCode，首个交接回合遇额度错误或被取消（§8.1：unknown、lateDelivery、verify none）；或 Codex 的确定性 UserPromptSubmit hook 拦下交接提示，completed 而无 userMessage（R8 X4），P 与重发 P′ 都 unknown。用户继续发消息。
- **证据**：pending 行 a 列“不发生”，b 列“不发生（need≠∅ 时必带包）”，i 列“autoResends=1 仍未知 → 不再自动重发”“lateDelivery 不自动重发”，这一回合既不能带包也不能不带包。plan() 字面上（`kind = …pending ? "resend"`）继续重发，越过上限；按注释原样发送，则在 need≠∅ 时复用原生上下文（INV-14），绑定永停 pending（j 列为“—”），之后别家做的回合也不再自动补交，§11.1“丢失增量 0”落空。OpenCode 一次取消或 Provider 错误（R8 O3：发生在送达之后）就落到这里；`attach:"none"` 在 plan() 也没有分支。
- **修正**：补事件“need≠∅ 时内容回合不带包派发”：水位与 pending 不变，只在用户显式选择后发生；自动重发不可用时 admit 同步 409 `RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}`（［再附一次］［只发这条消息］［新开原生会话］）；`attach:"none"` 进 plan() 首行；OpenCode 的 ServiceFailure 按 R8 O3 记 E3；属性测试：没有未定义的（状态，事件）组合。

### VF1-03【blocker】Hermes 清空在结算时无法确认，回放后整份补回

- **章节**：§7.4 清空；§7.2 f、k 列；§6.4；§8.1 Hermes 行；§4 `VerifyResult`。
- **场景**：Claude 两轮 → Hermes 收 P1 → Hermes 几轮 → `/clear`（`session.mutate reset`，回复 `Conversation history cleared.`，`gateway_commands.py:192、205`【事实】）→ 下一条普通消息。
- **证据**：§7.4 规定“说已清空前需要便宜的观察（…Hermes 回放为空…），否则按 suspect”。回放要到下一次 open，结算只能走 f 列：suspect{mark, floor=−1}，纪元不加。下一条 open 时回放为空，核对 P1 得 absent，VerifyResult 没有“已清空”，k 列走“都不在 → mark 退到本纪元第一份包之前”，need 重含 Claude 两轮，发整份交接单。另一路：reset 后网关推送 context_tokens=0 的 usage_update（gateway_commands.py:226–236，gateway_server.py:1064–1069【事实】），§6.4 的“used 下降 ≥30%”把它当压缩证据 → reanchor，need=∅ 也发要点包。两路都违反裁定第 2 节第 3 条与 INV-30。保留进程时 `/clear` 回合会被保留（runtime.ts:638），下一回合不 open，永远确认不了。
- **修正**：新增 cause `clear_unconfirmed`，floorSeq 取清空 Run 的 run.ended seq；VerifyResult 加 `empty`，收到即转 fresh{user_cleared, floor}、nativeEpoch+1，present 则回 synced；或由 Driver 按网关固定回复在结算时确认（P6 覆盖）；usage 规则排除 clear 回合；suspect 不复用保留进程。测试：收过包后 `/clear` 再发 20 条，`dispatched === input`。

### VF1-04【major】j 列未限定为内容回合，字面实现让 D2 回归

- **章节**：§7.2 事件定义与 fresh 行 j 列；§7.1 native 行。
- **场景**：Codex 一轮 → 切到 Claude，Claude 的第一条是目录内 keep 命令（技能或自定义命令，如 `/review 登录重构`，R4 D2）。
- **证据**：派发时是 c（不变）；结算时 j 定义为“不带包的本绑定回合结算”，命令回合正属此类，fresh 行 j 列“recorded 或有 agent 输出 → synced{native}”。命令有输出，Claude 被推成 synced，下一条 need=∅ 原样，A1 永不送达。§7.1、§7.4 的本意不同，但逐字进契约、写成属性测试的是这张表（J1 M2）。
- **修正**：j 改为“b 的结算”（内容回合、派发时 need=∅、未选 attach:none），命令回合结算单列“不变”；属性测试：fresh 上任意命令序列之后 need 不变。

### VF1-05【major】命令回合：受理时被当成要带包，结算时效果不看是否执行

- **章节**：§6.1 admit、prePlan；§7.2 c、d、f 列；§8.1。
- **场景与证据**：(1) A（Claude）→ B（Codex）→ 回 A 先发 `/clear` 或 `/compact`。分类在 open 之后，admit、prePlan 只看 need≠∅：未同意 → 409 `RELAY_CONSENT_REQUIRED`；suspect 且返回时不核对 → 409 `RELAY_CHOICE_REQUIRED`；数据根在工作区 → 409 `RELAY_UNAVAILABLE`；窗口 <12k → `RELAY_INPUT_LIMIT`。小窗口时连 `/clear` 也发不出，native-reset 后 need 更大，成死路；与 RT2-08 处置“含 /clear 不做预算检查”矛盾。(2) 没执行的命令仍按声明效果：OpenCode 合成 NATIVE_COMMAND_IGNORED（opencode.ts:9–10、79–84）、Codex `/compact` 无 turnId 拒绝（codex.ts:511）、Hermes `/compress` 答 noop（gateway_commands.py:213–222）都没压缩，却按 d 列置 reanchor；Claude `/remote-control` 被移出目录（claude.ts:65）再拒绝（:70），按“目录外合语法 → unknown”成 suspect。
- **修正**：admit 与 prePlan 用 Driver 静态声明（grammar、hidden、unlistedSlash）加 ADR-033 目录缓存预分类，命令（非 acceptsRelay）跳过同意、选择、数据根与预算；finalize 分类不符则 `RELAY_PREPARE_FAILED{reason:"classification_changed"}`、不派发。命令效果 = 声明效果 ∧ 未判为 not_recorded 或 noop；`remote-control` 列入 hidden（none）。

### VF1-06【major】命令识别的规范化与 Hermes 不一致（前导空白）

- **章节**：§7.4；§5.1 首行规则；§8.1 Hermes 行；§4 `commands.grammar`。
- **证据**：Hermes 判命令前先 `text.lstrip()`（`hermes-agent/acp_adapter/gateway_server.py:32`【事实】）；Hub 用 `run.input.startsWith("/")`（runtime.ts:1393【事实】），首行省略也按“以 / 开头”。python3 的 lstrip 去掉 U+3000、U+00A0，node 的 startsWith 不认【实测】。
- **推演**：输入“　/clear”（全角空格）：Hub 判为内容，回 Hermes 且 need≠∅ 时带包、首行不省略；Hermes 把整段当 `/clear` 的参数执行 reset，交接单丢失；E3 由 Hub 判定为“非命令 → recorded”，水位越过 B 的回合；清空也没记录，R8 的“清空让水位反向失真”复现。
- **修正**：Driver 声明 `classify(text)` 复刻原生解析（lstrip、注册表与别名、路径排除），首行省略、命令跳过与 E3 共用结果；RelayConformance 加半角、全角前导空格各一例。

### VF1-07【major】清空下限不随状态保留，“附上”在重发时丢失

- **章节**：§4 `BindingRelayState`；§7.2 f、k 列；§6.3；§7.5；INV-30。
- **场景**（设 VF1-03 已修）：Claude r1–r2 → Hermes r3 收 P1 → r4 `/clear`（floor=s4）→ Claude r5 → Hermes r6 收 P2（只含 r5）→ r7 `/undo` 撤掉 r6 → r8。
- **证据**：synced 不带 floor，f 列把 suspect 的 floor 写成 −1；r8 核对 P2 得 absent，k 列“退到本纪元第一份包之前”按“恢复其前的 mark”即 −1，need={r1, r2, r5}，清空前两轮被补回。选“补发完整交接单”、重建的 `fresh{reset, floor:null}` 同样丢下限；新绑定的 originIncluded 没写。另：清空后“附上”的 P 若 unknown，重发时 plan() 的 floor 读新请求（未带 attach），附上的历史被丢，清单里的 `inputs.attachOverride` 未被使用。
- **修正**：`BindingRelayState` 加 `epochFloor`，各状态继承，need 下界恒为 max(mark, epochFloor)；k 列退到 max(本纪元第一份包 range.fromSeq − 1, epochFloor)；重建继承最近下限；新绑定 originIncluded=false；resend 继承被取代包的 attachOverride；INV-30 把回退列为例外。

### VF1-08【major】Hermes 的压缩证据是持续状态，v2 没有游标

- **章节**：§6.4；§7.4 标记缺失分类；§7.2 k 列；§8.1 Hermes 行。
- **证据**【事实】：压缩摘要作为普通消息持久（user 或 assistant 角色），回放带 `_meta.hermes.compactionSummary` 或 `containsCompactionSummary`（`hermes-agent/acp_adapter/server.py:83–98`）；归档行不回放（gateway_server.py:380）；摘要以 `[CONTEXT COMPACTION — REFERENCE ONLY]` 或旧版 `[CONTEXT SUMMARY]:` 开头（agent/context_compressor.py:261、295）。所以摘要会出现在此后每次回放里，直到下一次压缩（Q2 可由源码回答）。
- **推演**：(1) “回放标记出现即置 reanchor、每次压缩至多一次”，绑定却不记“见过哪次压缩”：照字面每回合都发要点包。(2) 分类 ① 要“标记送达之后观察到过压缩”，送达时的压缩状态没存；有摘要就判 compacted，哪怕包在最近一次压缩之后送达、因 `/undo` 而缺失（应为 suspect），于是只发要点加新增量，那批回合丢失。(3) §7.2 synced 行 k 列把 outside_window/unavailable 判 suspect，§7.4 ② 写“unknown，不停下”，互相矛盾；packetsInEpoch 何时加 1 未定义。
- **修正**：Driver 从回放回报 `compaction:{count, digest}`，绑定存 `compactionSeen`，变化才置 reanchor；送达行记录送达时的值，分类 ① 只在其后变过时成立；Hermes 没有数字位置，核对须排除带 compactionSummary 元数据的条目；统一两节；packetsInEpoch 只在 g 时加 1。

### VF1-09【major】保留进程下 Hermes 回退无法核对，need=∅ 的放行吞掉回退

- **章节**：§7.2 suspect 行 b 列；§7.4 回退；§8.1 Hermes 行。
- **场景**：开启保留原生进程；Claude r1–r2 → Hermes r3 收 P1 → r4 `/undo` 撤掉 r3（归档该行，gateway_commands.py:116–140【事实】）→ r5“继续”。
- **推演**：r4 是 completed 的命令回合，`keepable` 只看 completed 与清理（runtime.ts:635–641【事实】），进程被保留，结算转 suspect{rewind}。r5 按旧水位 need=∅，复用进程不 open（runtime.ts:1345–1354），没有回放，k 不发生，b 列“need=∅ 视同 synced”放行：Hermes 已不记得 Claude 两轮，Hub 却当已知（INV-14）。§8.1“只有 completed 回合才保留，此时 E3 已成立”对命令回合不成立。
- **修正**：need=∅ 放行只限 cause ∈ {legacy, verify_unavailable, vendor_changed}；rewind、unknown_command、clear_unconfirmed 必须先核对；on_next_open 的 Driver 在 suspect 或 pending 时不复用保留进程。

### VF1-10【major】Claude 合成清空换了新绑定，配置承接断开

- **章节**：§8.1 Claude 行；§14.3 INV-14“配置承接只读原生位置与选择纪元”。
- **推演**：`carriedNativeConfiguration` 只读当前 ready 绑定的 observed 与 throughRunId（state.ts:391–393【事实】）。v2 的合成清空“归档旧绑定、新绑定 fresh{user_cleared}”，未写新绑定的 throughRunId 与 observed；照现有写法（runtime.ts:1382–1383）两者皆空，承接为 null，按 selection 的模型打开：先 `/model X` 再 `/clear`，模型被悄悄换回，即 RT1-m4 要避免的 K14 回归。【假设】Claude CLI 的 `/clear` 保留当前模型，未核实。保留进程的 `kept.conversation` 取自 `opened`（runtime.ts:1376、1475），清空后仍是旧 ID，下一回合会被 acp.ts:525 以 IDENTITY_MISMATCH 拒绝【推断】。
- **修正**：清空新建的绑定继承 observed，Driver 用观测模型 `session/new`；承接改读同一 (harnessId, controlId) 当前选择纪元内最后一个 input≠not_recorded 的已派发 Run（跨因清空归档的绑定，顺带修掉 OpenClaw `model_not_applied` 后承接旧模型的既有问题，state.ts:394）；checkpoint 变化时更新保留进程的 conversation；P6 加“`/model X` → `/clear` → 仍为 X”。

### VF1-11【major】P0 规则对 unknown 与 not_recorded 各错一边，D3 只修一半

- **章节**：§7.6；§17 R0a–R0c。
- **推演**：`advance ⇔ dispatched ∧ (input ≠ not_recorded ∨ isCommand) ∧ (due = ∅ ∨ carried)`。(1) unknown 推进：回 Claude 带信封的回合在插入前取消（R8 C2），推进后 B 的回合不再是来源，“插入前取消”在 P0 仍是 ✗；R0c 验收“unknown 只重发一次”在 v12 无可计数的字段，与规则（0 次）矛盾。(2) not_recorded 内容回合不推进：单 Harness 的 OpenClaw `model_not_applied`（openclaw.ts:423，dispatchedAt 已在 runtime.ts:1415 提交）或 Codex 无 turnId 拒绝（codex.ts:527）之后，下一回合 runtime.ts:1337–1339 把失败回合当来源，1392 改发 JSON 信封；现码（1496）照常推进，这是新回归，RT2-03 的触发清单本有这两种。(3) R0a 只对要发送的内容预算，而切到新目标时要发的就是全部来源：900 KiB 回复后 B 的第一条仍 `CONTEXT_TOO_LARGE`（R4 的 R3、R6），§7.6 未列。
- **修正**：`advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ 已重发 1 次))`，次数由开放事件 `run.ended.data.relayResendOf` 推出；“切换后首条在 R4 前仍可能超限”写进已知局限，或 R0a 提供“只发这条消息”。

### VF1-12【major】送达表触发器禁止 unknown→unknown，违例即 Store failed

- **章节**：§14.1 `relay_deliveries_transition`；§7.2 pending 行 i、k 列；INV-35。
- **推演**：触发器只放行 in_flight→任意、unknown→{recorded, not_recorded}、not_recorded→recorded。v2 的 i（仍未知，原因细化为 absent 等并更新 decided_*）是 unknown→unknown；`BEFORE UPDATE OF outcome` 只要 SET 里有 outcome 就触发，与值是否变化无关。一次写回同值即是 SQLite 错误，sqlite-store.ts:623–627 把 Store 置为 failed【事实】，Runtime fatal、全部会话停摆，与 INV-35 相反；claimAndRecover 一个事务覆盖全部会话（sqlite-store.ts:577–590），同样写法会让 Hub 起不来。
- **修正**：放行 `OLD.outcome = NEW.outcome AND OLD.outcome IN ('unknown','recorded')`（recorded 不改 evidence）；转换先在应用层校验，触发器只作断言；relay 写失败映射为本 Run 失败；恢复按会话分 SAVEPOINT。

### VF1-13【minor】迟到写入让“位置之后首条用户条目”误判

- **章节**：§8.1 OpenClaw、Claude 行；§7.1 E2。
- **推演**：OpenClaw 中止后网关尽力补写用户回合（R8 W2），Driver 对 cancelled 不回读（openclaw.ts:440【事实】），v2 又写“取消后网关补写的用户回合不算”。补写的行就是之后会被读到的历史，不算即重发、重复；补写落在下一回合 `before` 之后时，首条 user 行是上一包，本包被判 absent 再重发。Claude 的 orphan 输入同理（R8 第 3 节）。
- **修正**：OpenClaw 取消按 lateDelivery 处理；在位置之后的客户端用户条目里按本包标题行查找，查到的上一包顺带改记 recorded。

### VF1-14【minor】撤回排除后补不回来

- **章节**：§6.3 need；§14.2 `relay.exclusion_withdrawn`。
- **推演**：need 先按 seq 过滤再减排除。排除期间收到包，或外来事实全被排除时经 j 列 native 证据，水位都会越过被排除的 Run；撤回后它在 mark 以下，再不进 need。
- **修正**：撤回时为已越过的绑定记欠交补集，下一份增量带上；或界面写明撤回只影响尚未越过的绑定。

### VF1-15【minor】恢复产生的终态没有 run.ended，事实 seq 无定义

- **章节**：§2 事实 seq；§9 S15。
- **推演**：recoverSession 只写 `session.recovered`（state.ts:466–479【事实】），被它终结的 Run 没有 run.ended，事实 seq 与“同事务”的 RunDigest 都无定义；K12 时已持久的 E3 被 `unknown{owner_ended}` 覆盖。这类对话随后 RECOVERY_UNSAFE，影响限于分支来源与详情。
- **修正**：以 `session.recovered` 的 seq 作事实 seq；`coordinator.recover` 读到 backend.input=recorded 时记 E3。

## 2. 已核对

1. **D1（v13）**：Claude r1 原样 → synced{native}；Codex r2 收包；回 Claude 的 `/review` 在 authorized 前分类，c 列不变；下一条 need={r2} → 增量。P0：命令未携带、不推进，下一条来源含 r2。前提是 VF1-04、VF1-05。
2. **D2**：v13 见 VF1-04；Codex `/skill:x` 声明 acceptsRelay，带包。P0：首条命令不推进，下一条带全部来源。
3. **D3（v13）**：need=∅ 不进 chooseBudget；切换生效时不再全量构建（现码 runtime.ts:1569–1570）；超限只分层；RELAY_INPUT_LIMIT 只看框架加当前原话。P0 见 VF1-11。
4. **插入前接口拒绝**：Codex 无 turnId（codex.ts:527）→ not_recorded → 回 prior；ACP 通用 REMOTE_ERROR → unknown；Hermes 网关拒绝 → not_recorded。都不越过水位。
5. **Driver 合成结果（内容回合）**：`model_not_applied` 对本绑定不是外来事实（O6），单 Harness 下一条原样；对其他绑定注明“没有送达任何 Harness”。
6. **插入前取消**：各家只给 unknown，水位不动；重复与否见 VF1-01、VF1-13，OpenCode 见 VF1-02。
7. **J1 精确分支（runtime.ts:438）**：原生位置随命令前进；在命令回合上分支时 need(through) 含 B；清空后纪元不同；pending、suspect 不分支；P0 加“through 之后无同绑定派发”。推不出“副本含分支点之后内容”或“欠交被 origin 吞掉”。
8. **J1 配置承接（state.ts:392）**：`/model X` 命令回合成为原生位置且在当前选择纪元内 → 承接 X；Hermes、OpenClaw 清空不换绑定。例外见 VF1-10。
9. **切换中途 Hub 重启**：K1、K2、K4 无已派发 Run，无 relay 行；K5–K8 → never_dispatched 并回 prior；K9 → unknown{owner_ended}；K11 的 E1 已与送达行、绑定同事务；下一 Run 派发前崩溃时，`relay.verified` 已随其 context_prepared 落库，核对结果不丢。之后 RECOVERY_UNSAFE（runtime.ts:750–751）；余下见 VF1-15。
10. **分支、接续之后再切换**：精确分支 → synced{0, origin}，origin 事实 seq=0 不大于 mark；B 的 originIncluded=false，origin 作最旧一层；回 A 不再带 branchedHistory（修 R4 D5）；import 绑定 lastPacketId=null 跳过核对，交给 B 时写明 omitted 与 complete。新绑定的 originIncluded 见 VF1-07。

## 3. 假设与未核实

- VF1-03 的“回放为空”与 VF1-10 的“Claude `/clear` 保留模型”未经真机核实，也未读网关 reset 的实现；推演按 v2 字面（含伪代码与表格），未写出的特判视为不存在。
