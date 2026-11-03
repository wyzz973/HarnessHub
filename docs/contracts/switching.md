# Harness 与模型切换状态契约

状态：proposed。切换过程由应用层 process manager 协调，Session 聚合控制意图准入和生效。

**接力部分（proposed（ADR-055））**：凡标注“proposed（ADR-055）”的段落，以及“接力：切换、准备与送达”一章，来自[接力系统终稿](../proposals/relay/relay-architecture.md)（[ADR-055](../decisions/0055-relay-and-context-scheduling.md) 的设计正文，下称“终稿”）。它们的状态是 proposed，**未实现、未真机验证**：用户验收之前不改 Session 运行时，也不改业务库格式。未标注的段落是 ADR-055 之前的契约原文，其中已实现的部分以[公共Session本机切片](public-session-mvp.md)为准。接力的表、事件、迁移与保留期限见[存储契约](storage-events.md)的“接力存储与事件”一章。标注约定与终稿相同：【事实】有代码或文档出处（代码位置都指基点 `07a0825` 的实际代码，本工作树的 `src/` 与之相同）；【实测】是原型或评审在本机测得的；【推断】由事实推出；【建议】是 ADR-055 的决定；【推算】是未经实测的数字。

## 模式与入口

用户手动指定；auto 策略为下一 Turn 作选择；策略建议交接（有独立建议证据）。第一版不做静默的执行中 Harness 替换。用户在任何阶段都能提出请求，但请求与生效分开。

切换可以只改 Harness、只改 Provider/模型或同时改；所有选择组成不可变 desiredSelection。是否继承默认模型/工具必须显式记录，不能因为换 Agent 就偷偷恢复它自己的账号。

**proposed（ADR-055）**：执行中切换仍不替换正在运行的 Harness。`POST …/switches` 增加可选的 `mode`（`wait_current` ｜ `cancel_current`），快照里的切换记录同时记下 `mode`、`timing` 与 `acknowledgedUnknown`（R1.1）。切换只改选择；交接单在切换生效之后的第一条内容输入的 Run 里生成，不在切换时生成。

## 过程建议

requested → validated → waiting_boundary/quiescing → preparing_context → preparing_binding → effective；另有 blocked、failed、superseded、cancelled。具体 wire 状态由契约冻结。

1. 以 key、expected epoch/version 持久记录请求；验证目标版本与能力。
2. idle 时可直接准备；busy 时按用户指定的 wait_current 或 cancel_current 处理。默认建议 wait_current，需在产品验收前冻结。
3. 旧 Attempt 结算，取消待决权限，模型调用停止，进程和写租约达到足够的 quiescence evidence。unconfirmed 时 blocked，不给新执行者写权。
4. 固定公共水位并构建 ContextManifest；准备目标绑定，模型变更需要验证原地操作或显式重建。
5. Session 根以 CAS 更新 epoch 和实际 selection，发布 effective 事实；下一 Turn/Attempt 使用新快照。

**proposed（ADR-055）对第 2–4 步的改写**：

- 第 2 步：busy 时默认 `wait_current`，在回合边界生效；［停止并切换］即 `cancel_current`，走停止链（R1.1）。
- 第 3 步：停止未确认时，unsafe 的 `run.ended` 在同一事务里把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`，等待它的排队 Run 以 `SWITCH_NOT_EFFECTIVE` 结束，切换不再悬挂（R1.1）。
- 第 4 步：切换生效时**不组包、不做预算**。`ContextManifest` 由交接单 `RelayPacket` 的清单与送达行 `DeliveryRecord` 取代（任务 C006 按终稿第 4 节改写 `contracts/context.schema.json`）；交接单在之后第一条需要交接的内容输入里由 `prePlan` 与 `finalize` 生成，目标绑定也在那时准备（R1.2）。

用户可以先提出切换，再发送下一条消息。第一版建议一次只保留一个待决切换，新的不同请求返回 SWITCH_PENDING；是否允许替换待决请求另做显式命令，不能靠最后一次 UI 状态覆盖。

## 失败与恢复

目标准备失败不改实际 selection，保留公共历史与真实结果；旧后端已经关闭时不能声称它仍活着。后续继续需要验证旧绑定或从公共上下文重建，并报告接续等级。

切换受理后不能自动重新运行上一输入。请求生效但响应丢失时按 SwitchId 查询；崩溃恢复先核对 epoch、执行、outbox、绑定和租约，再继续仅无副作用的准备步骤。

**proposed（ADR-055）**：切换生效之后，交接准备失败（渲染、脱敏、字节越界、缺少同意、厂商变化、分类不符、精化窗口过小）时切换不回退：这条消息不派发，relay 状态不变，界面提供重试、改回原来的 Harness 与“只发这条消息”三个选择（R1.4）。崩溃恢复对送达表与绑定接力状态的处理见 R10。

## 竞态

切换与完成/取消/deadline；两个切换请求；切换与新消息；目标 drain；工作区变化；模型目录更新；权限 late reply；旧 Worker 复活/迟到事件；切换提交前后崩溃。

每一种交错必须保留唯一实际 selection 和执行权；只有生效事件能改变用户看到的实际执行者。请求态界面不能提前把新 Harness 显示成已经运行。

**proposed（ADR-055）**：接力新增的交错及其裁决见 R11。“已接棒”与分隔线只在送达证据之后出现（INV-21）。

## 接力：切换、准备与送达（proposed（ADR-055））

本章是 ADR-055 的设计（【建议】），全部未实现。读法：

- 本章的小节用 R 编号。直接取自终稿的段落与表格（下称“引文”）保留终稿原文，其中的“第 n 节”“n.m”“§n”都指**终稿**的节号；引文里个别按实际代码或终稿其他节改过的地方，都在原处写明。
- 术语以终稿第 2 节为准。常用的几个：**外来事实**——对绑定 X 的当前纪元 e 而言，已派发（有 `dispatchedAt`）且已终结、`executedOn ≠ (X.harnessId, X.controlId, e)` 的 Run，以及 `originIncluded=false` 时的分支或接续来源历史；未派发的 Run、命令回合、本绑定本纪元的 Run（不论送达结论）都不是外来事实。**事实 seq**——Run 取其 `run.ended` 事件的 seq（Run 串行执行，构成全序；被恢复终结、没有 `run.ended` 的 Run 取 `session.recovered` 的 seq，VF1-15），origin 取 0。**need**——交接时应补交给该绑定的外来事实（R3.2）。
- 两个“K”编号不要混淆：**K8** 指第二轮 C2 裁定“超出最小交接单时，在启动程序之前失败”（R1.3）；**K1–K18** 指 RT2 的[崩溃注入点表](../proposals/relay/round3/rt2-failure-races.md)（R10）。
- INV-29 至 INV-36 是 ADR-055 新增的编号（ADR-055 之前的[不变量表](../domain/invariants.md)只有 INV-01–28）；终稿第 14.3 节对 INV-29、30、33 写的“改”是相对它自己的第一、二版草稿。
- 代码位置的简写：`runtime.ts` 指 `src/contexts/session/application/runtime.ts`，`state.ts` 指 `src/contexts/session/domain/state.ts`，`context.ts` 指 `src/contexts/session/domain/context.ts`，`sqlite-store.ts` 指 `src/infrastructure/session/sqlite-store.ts`，`server.ts` 指 `src/web/server.ts`；`acp.ts`、`claude.ts`、`codex.ts`、`opencode.ts`、`hermes.ts`、`openclaw.ts` 在 `src/adapters/control/`。

### R0 现状基线（已实现，【事实】）

ADR-055 改动的出发点，都是现有代码：

- 切换只 `validate` 目标的入口与配置（`runtime.ts:1563`），`switch.validated` 仍用 `buildPublicContext` 固定来源 Run（`runtime.ts:1569–1573`），生效时 `epoch+1` 并改 `selection`（`runtime.ts:1603`），不启动控制连接。`switch.requested` 事件已带 `mode: "wait_current"`（`runtime.ts:392`），快照里的切换记录没有这个字段（`state.ts:197`）。
- 每个 Run 在 open 之前构建 JSON 信封（`runtime.ts:1334–1342`）：来源是全部已终结的更早 Run，不看是否派发过（`context.ts:27–28`）；已有原生绑定时只取 `throughRunId` 之后的来源（`runtime.ts:1337–1339`）；信封超过 `MAX_CONTEXT_BYTES`（1 MiB，`state.ts:16`，文档常量）即 `CONTEXT_TOO_LARGE`（`context.ts:56–58`）。
- 命令识别在 `run.authorized` 之后：`run.input.startsWith("/")` 且名字在 `models()` 的目录里（`runtime.ts:1389–1396`），前导空白不认；目录项只有 `name` 与 `description`（`contracts/control.ts:163`）。
- `BackendResult` 只有 `status`、`reason`、`error`（`contracts/control.ts:100–104`），持久化时只认这三个键（`state.ts:95`）。
- 未确认的绑定在 open 之前抛 `NATIVE_STATE_UNCONFIRMED`（`runtime.ts:1336`）；绑定写入用 execute 开头读到的 `previousNative`（`runtime.ts:1382–1385`）；结算时只有已派发的 Run 推进 `throughRunId`（`runtime.ts:1496`）。
- 配置承接（ADR-028）读该绑定 `throughRunId` 指向的 Run，并要求它在当前选择纪元里（`state.ts:389–399`）。
- 分支只在源绑定 `throughRunId === through.id` 时建立原生副本（`runtime.ts:438`）。
- unsafe 结束时，只有关闭对话或停服才取消待决切换（`runtime.ts:1499–1500`）；blocked 且 `pendingSwitchId` 非空时 `recoverable` 抛 `RECOVERY_UNAVAILABLE`（`runtime.ts:746–748`）。等待的切换失败时，排队 Run 以 `failed{SWITCH_NOT_EFFECTIVE}` 结束、`neverDispatched: true`（`runtime.ts:1308–1310`）。
- 保留进程（ADR-030）复用时不 open、没有回放（`runtime.ts:1345–1354`）；`keepable` 只看 completed 与清理（`runtime.ts:635–641`），所以命令回合之后进程也会被保留。
- 重启恢复：非 queued 的 Run 记 unknown、queued 取消、待决切换 failed（`state.ts:466–479`），由 `claimAndRecover` 在同一个 `BEGIN IMMEDIATE` 事务里写入全部会话（`sqlite-store.ts:452`、`:577–590`）。
- 代码里还没有任何接力实现（`src/` 中没有 `relayCapabilities`）。

### R1 切换与准备的状态机

#### R1.1 切换请求与生效

切换的现有状态（`requested → validated → effective`，另有 `failed`；会话可进入 `blocked`）、一次只有一个待决切换（`SWITCH_PENDING`，`runtime.ts:386`【事实】）与 FIFO 准入都不变。ADR-055 的改动：

- **生效时不组包、不做预算**（修 R4 D3）：`switch.validated` 不再构建全量上下文（G067 R0a“切换校验不构建全量”）；交接单只在之后的内容输入里生成。生效之后、发消息之前“改回”零代价，因为目标只在需要时启动。
- **回合边界** = 无活动 Run，且没有早于 `requestedSeq` 受理的排队 Run（`runtime.ts:976–980`【事实】）。
- **执行中切换与停止未确认**（引文，终稿第 9 节）：

| 情形 | 语义（所有者 · 上限 · 失败结果 · 用户所见） |
|---|---|
| 执行中切换（S5） | 默认 `wait_current` 到回合边界生效（回合边界 = 无活动 Run 且无早于 requestedSeq 受理的排队 Run，`runtime.ts:976–980`【事实】）；有待批准请求时写明“批准或拒绝之前这一轮不会结束”，提供［等这一轮结束］［停止并切换］；停止走停止链（`STOP_GRACE_MS` 15 s），未答复的审批与问题关闭、不转交，工具不转移。**停止未确认**：unsafe 的 `run.ended` 在同一事务里把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`、等待它的排队 Run 记为 `SWITCH_NOT_EFFECTIVE`（现状 unsafe 结束时 `pendingSwitchId` 保留，`runtime.ts:1490`，而 blocked 且 pendingSwitchId 非空时 `recoverable` 抛 RECOVERY_UNAVAILABLE，`:747`【事实】，RT2-04）；之后走 blocked → 恢复切换。交接单“状态与风险”里停止、批准、完成的先后由 `permission.decided/closed`、`backend.status`、stop 与 settled 的事件顺序推出，附“停止请求晚于完成”的标注（RT2-14），并附边界观测（中断时的 diff 优于冷重启，R9[S17]） |

- **停止未确认时排队 Run 的结局**：终稿第 9 节与第 0 节写“等待它的排队 Run 记为 `SWITCH_NOT_EFFECTIVE`”（RT2-04 的修正），第 14.2 节的 `run.ended` 一格写“排队 Run 的 cancelled”，两处不一致。本契约按第 9 节：沿用现有错误码 `SWITCH_NOT_EFFECTIVE`；终稿没有写这些 Run 的状态，按该错误码的现有用法取 `failed`（`runtime.ts:1308–1310`）【推断】。
- **`PublicSwitch` 增补（v13）**：`mode: "wait_current" | "cancel_current"`、`timing`、`acknowledgedUnknown: readonly RunId[]`。新切换只写 `acknowledgedUnknown`，解析器同时接受旧切换的 `sourceRunIds`（现状由它认可恢复切换覆盖的 unknown Run，`state.ts:340–342`【事实】）；`acknowledgedUnknown` 的每个 ID 须是 status=unknown、`cleanup.closed=true`、用户消息早于 `requestedSeq` 的 Run，且只能出现在恢复切换上（RT1-m10）。`switch.*` 事件的扩展见存储契约 R3。
- **切换生效后交接准备失败**：切换不回退（非恢复切换只 validate，生效即改 selection，`runtime.ts:1563`、`:1603`【事实】），见 R1.4。

#### R1.2 Run 的准备阶段与接力钩子

Runtime 没有产品名分支：差异只经 `RelayCapabilities` 与命令目录的 `contextEffect` 进入。

| 钩子 | 时机 | 职责 | 不通过时 |
|---|---|---|---|
| `coordinator.admit(state, request)` | `send()` 同步受理时（受理本来就是同步的，`runtime.ts:343–370`【事实】） | 受理时的同步预检（下文引文第一条） | 同步抛错，不建 Run、不启动进程，草稿保留 |
| `coordinator.prePlan(state, run)` | `factory.prepare` 之前 | 排队 Run 重做一次 admit；外来事实、need、档位、保守窗口；原样路径判定 | Run 在启动前以同一错误码失败，没有进程，绑定不变 |
| `coordinator.finalize(state, run, control, observation)` | open、checkpoint、`binding_prepared`、setTitle、命令分类复核与附件检查之后，`run.authorized` 之前 | on_next_open 的回放核对、精化窗口、渲染（占位符 → sha256 → ID）、脱敏、字节校验、同意复检（观测到的厂商键对 `consentKey`）、悬崖判定 | Run 失败、未派发（R1.4 的“open 之后”） |
| `coordinator.settle(execution, backend, evidence)` | `run.ended` 事务内 | 送达结论、绑定 sync、RunDigest 与索引（SAVEPOINT） | 派生行写失败只把该 Run 标为 behind，`run.ended` 照常提交 |
| `recoverRelay(state, deliveries)`（领域纯函数 `domain/relay/recover.ts`） | `claimAndRecover` 调用 `recoverSession` 的同一事务（`sqlite-store.ts:579`【事实】）；此时 Coordinator 还不存在 | R10 | 按会话各自一个 SAVEPOINT，一个会话失败只标该会话 |

**固定顺序**（终稿第 6.1 节的时序图，按步骤写开）：

```text
受理  admit：目标 = pendingSwitch?.target ?? selection；命令预分类；同步预检（缺项 → 同步错误，不建 Run）
排队  prePlan：排队 Run 重做 admit；外来事实、need、档位、保守窗口；attach=none 或 need=∅ ∧ ¬reanchor ∧ attach≠full → 原样路径（不进预算解析器）
启动  prepare（取工作区租约）· initialize · open（Hermes 回放在此到达；suspect/pending 不复用保留进程）
      并行：observe(workspace)（≤250 ms，租约之后，与启动并行）
      checkpoint → native.binding_prepared（基于 current 合并，relay 字段不丢）
      setTitle（只对因交接新建的会话，首个提示之前；标题先过出境脱敏）
      models() → classify 复核：与受理时分类不符 → RELAY_PREPARE_FAILED{classification_changed}；命令回合跳过预算与组包
      附件检查
定稿  finalize：on_next_open 回放核对 · 精化窗口（更小 → RELAY_INPUT_LIMIT，派发前失败）· 渲染 · 脱敏 · 字节校验 · 同意复检 · 悬崖判定
      deliveryPosition(id)（只读，事务之前）
提交  一个事务：run.context_prepared{contextReadyAt} + run.authorized{readyAt} + 交接单行 + 送达行(in_flight, position, consentLogSeq, inputHmac, compactionAtDelivery) + 绑定 pending + 观测行(SAVEPOINT)
派发  run.dispatched（事务内再读同意；已撤回 → 不派发，Run 失败 RELAY_CONSENT_REQUIRED）→ startText(TurnText)
送达  input_recorded（E1）：先冲刷打开的文字窗口，再随 run.first_output（或下一次既有提交）落库：送达 recorded(E1) + 绑定 synced
结算  BackendResult.input（E3）；E1/E3 未定论且 verify=after_turn → verifyDelivered(position)（≤2 s）（E2）
      一个事务：run.ended + 送达结论 + 绑定 sync + RunDigest 与索引(SAVEPOINT)
```

引文（终稿第 3.2 节的 Runtime 接口与第 6.1 节的要点）：

**与 Runtime 的接口**（`execute` 内的新钩子，`runtime.ts:1325–1420` 改造；顺序见第 6.1 节）：`coordinator.admit(state, request)` 在 `send()` 受理时同步执行（目标取 `pendingSwitch?.target ?? selection`，VF3-02；命令预分类；选择、同意、数据根预检，缺项即同步抛 `*_REQUIRED` / `RELAY_UNAVAILABLE`，`server.ts:266` 映射为 409【事实】；只读 Driver 模块的静态声明与绑定上缓存的 `vendorObserved`，不建立 control 实例，F10）；排队的 Run 在 `prePlan` 时重做一次 admit（它前面的回合可能改了模型或清空），不通过的让该 Run 以同一错误码在启动前失败；`coordinator.prePlan(state, run)` 在 `factory.prepare` 之前；`coordinator.finalize(state, run, control, observation)` 在 open、checkpoint、`binding_prepared`、命令分类与附件检查之后、`run.authorized` 之前；`coordinator.settle(execution, backend, evidence)` 在 `run.ended` 事务内；恢复用领域纯函数 `recoverRelay(state, deliveries)`（`domain/relay/recover.ts`），由 `claimAndRecover` 在它调用 `recoverSession` 的同一个事务里调用并写入（`sqlite-store.ts:579`【事实】；Coordinator 此时还不存在，F05）。

- **受理时的同步预检**（`send()` 是同步受理，`runtime.ts:343–370`【事实】）：`admit` 读目标绑定（目标 = `pendingSwitch?.target ?? selection`：切换已受理但未生效时消息会在目标上执行，VF3-02）的当前状态、Driver 模块的静态声明与绑定上缓存的 `vendorObserved`，不打开程序、不建 control 实例（F10）。先做**命令预分类**：`classify(text, 目录缓存)` 判为命令（非 `acceptsRelay`）或疑似命令的输入跳过下面全部检查（命令不带包，不需要同意、选择、数据根与预算；VF1-05）。内容输入依次：目标未经探针 → `RELAY_TARGET_UNVERIFIED`；数据根在工作区内 → `RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`；需要用户选择——suspect 且无法核对且 need≠∅ 而请求没带 `relay.native`，或 pending 且不能自动重发（`autoResends=1` 或 `lateDelivery`）而请求没带 `relay.resend` / `attach:"none"` / `relay.native` → `RELAY_CHOICE_REQUIRED{binding, cause: "marker_absent" | "delivery_unconfirmed", options, counts}`（VF1-02）；厂商键缺同意 → `RELAY_CONSENT_REQUIRED` 附预览计数，取不到厂商键时按 `unknown:<harnessId>` 询问，这个回答只记“已看过说明”，open 后观测到真实厂商键仍须同意（VF3-02）；`hardCap < MIN_PACKET[族]` → `RELAY_INPUT_LIMIT` 并提供“只发这条消息”（VF2-01）。这些由 `server.ts:265–267` 的规则映射为 HTTP 状态（终稿原文为“都由 `server.ts:266` 的规则映射为 409”；按现行规则 `RELAY_INPUT_LIMIT` 为 429、`RELAY_TARGET_UNVERIFIED` 没有对应分支，见 R1.4），Run 不建立，草稿保留（RT1-M8、RT2-17、RT2-18、RT5-13）。排在活动 Run 之后的消息在 `prePlan` 时重做一次 admit（前面的回合可能换了模型或清空），不通过的让该 Run 在启动前以同一错误码失败（VF3-02）。
- **切换生效时不组包、不做预算**（修 R4 D3）；`prePlan` 在 `factory.prepare` 之前，用保守窗口复核 MIN_PACKET（K8）；`attach:"none"`、或外来事实为空且无重锚、未选附上时直接走原样路径，不调用 `chooseBudget`（RT3 P02；单 Harness 对话因此永不被预算挡住）。
- **顺序固定**：open → checkpoint → `binding_prepared` → setTitle（新会话）→ 命令分类复核 → 附件检查 → finalize → `deliveryPosition` → authorized → dispatched（RT1-M7、RT2-08）。现状命令识别在 `run.authorized` 之后（`runtime.ts:1389–1396`【事实】），本稿前移到 authorized 之前：受理时按静态声明预判，open 后按 `models()` 复核，不符即 `RELAY_PREPARE_FAILED{reason:"classification_changed"}` 不派发（VF1-05）；命令回合不写交接单行与送达行；绑定写入一律基于 `current` 合并，不用 execute 开头读到的 `previousNative` 覆盖（`runtime.ts:1382–1384`【事实】会丢 relay 字段）。
- **错误码按阶段**（F11；完整表见第 9 节）：受理时可判定的同步 409，不建 Run；启动前（prePlan）失败的 Run 失败且没有进程；open 之后（finalize、同意复检、精化窗口、分类复核）失败的 Run 失败且未派发，原生会话与绑定保留（新建的空会话下一次按它 resume，不再新建），relay 状态不变。
- `finalize` 在 open 之后（Hermes 的回放核对零成本，R8 G5），但在 `run.authorized` 之前；`context_prepared` 与 `authorized` 合并为一个事务（`assertSessionTransition` 只禁止 running/settling 状态下改 `contextThroughSeq`，`state.ts:448`【事实】，preparing → running 的同一次变更允许），每回合比现状少一次整份快照提交（RT3 P15）。
- **观测在租约之后**（`factory.prepare` 获取租约，`binding-factory.ts:147`【事实】），与 initialize/open 并行；预取时不观测，只读已落库的观测行（RT2-20）。
- E1 不单独提交；E1 所在事务同时写送达结论与绑定（RT1-M2、RT2-06）。
- 结算路径上 `costly` 核对已取消（RT2-16）；E1 或 E3 已定论时 `run.ended` 不等 after_turn 核对（RT3 P07）。

本契约对引文的两处补充：

- **预检的前提**（终稿第 6.1 节写明）：受理时的这些检查只针对将要携带接力内容的内容输入——按当前水位 need≠∅、请求带 `relay.attach:"full"`，或存在外来事实（F≠∅）而绑定 suspect 且 cause ∈ {rewind, unknown_command, clear_unconfirmed, unknown_turn}（水位存疑，need 要核对后才知道）。不满足前提的回合（need=∅、`attach:"none"`、单 Harness 对话）不做任何接力检查、永远不被接力阻挡。数据根检查另只拦跨厂商交接（任一来源的厂商键与目的不同即算，第 10.1 节）；`probed=false` 的 Driver 只在作目标且携带接力内容时 `RELAY_TARGET_UNVERIFIED`（第 8.1 节）。
- **RunTiming**：`contextReadyAt` 进入单调链 `preparingAt → contextReadyAt → readyAt → dispatchedAt → firstOutputAt → endedAt`（现有的链是 `state.ts:148` 的 `TIMING_PHASES`【事实】）；`recordedAt`（E1 的时刻）只约束 `dispatchedAt ≤ recordedAt ≤ endedAt`，不入单调链，也不设置 `firstOutputAt`（RT2-21）；`run.relay` 与 `contextReadyAt` 纳入派发后不可改的范围（`state.ts:448`）。

#### R1.3 K8：最小交接单与启动前失败

K8（第二轮 C2 裁定）：超出最小交接单时，在启动程序之前失败。终稿的落实是三次判定：admit 用保守窗口判定并同步返回 `RELAY_INPUT_LIMIT`（附“只发这条消息”）；prePlan 在 `factory.prepare` 之前复核；finalize 用精化窗口再判，更小则 Run 在派发前失败——这一次已经 open 过，是 K8 唯一发生在启动之后的失败（R1.4 的“open 之后”）。判据（引文，终稿第 6.2 节预算解析器的节选；解析器本身归 G070）：

```text
  DELTA_CAP = 1500; DELTA_USER_CAP = 1000; DELTA_USER_EXT = 2000; ANCHOR_CAP = 400; RESERVE = 4096
  FRAME_CAP[lang][kind]、STATE_CAP、MIN_PACKET[family] = 构建期常量：由模板渲染“最小交接单”（框架 + 状态节上界（≤400 字错误原文）+ 末单元单行 + 账目 + 结束行）按各估算口径计数生成，写进 policyVersion，CI 断言模板 ≤ 常量
    // 初值【推算，按 VF2 实测的固定部分 770 / 1,180 与末单元 120 / 156 加余量】：FRAME_CAP zh.packet 500、en.packet 450（o200k）；MIN_PACKET o200k 族 900、Claude 族 1,350、未知族 1,350
  ASSUMED_WINDOW = 按厂商键种类的显式表（VF2-04）：anthropic / openai / google / deepseek / aws-bedrock / google-vertex 128k；gateway:* / router:* / provider:* / unknown:* 32k；local 32k
chooseBudget(target, binding, request, auth):               // 只在 need ≠ ∅ ∨ reanchor ∨ attach=full 时调用；attach=none 不调用
  modelKey = relay.normalizeModel(binding.observed.model)    // 去 provider 前缀与别名（Hermes `<provider>:<model>`、OpenCode/OpenClaw `provider/model`）；null → ''
  W, src = binding.cache.contextSize ?? relay_windows(harness, control, modelKey, 30 天) ?? documented(modelKey) ?? ASSUMED_WINDOW[vendorKind]
  S_B = relay.fixedPrefix?.tokens ?? relay_windows.firstTurnUsed ?? FIXED_PREFIX_DEFAULT[vendorKind]
  S_new = est(当前原话, family)
  capWindow = max(0, min(floor(0.05 × W), W − S_B − S_new − RESERVE))     // 既不超过 5%，也要在目标固定前缀与原话之后放得下（VF2-04）
  capChannel = placement.maxInput ? toTokens(limit − size(原话) − RESERVE, unit) : ∞    // chars 与 bytes 分别折算（原型 F11）
  hardCap = min(capWindow, capChannel, TIER_CAP.full)
  if hardCap < MIN_PACKET[family] → blocked(RELAY_INPUT_LIMIT)   // admit 用保守 W 判定并同步失败（HTTP 429）；prePlan 复核；finalize 用精化 W 再判，更小则 Run 在派发前失败（VF2-01）
```

`capWindow` 的含义：标准档要 W ≥ 160k 才不被压低，保真 ≥ 320k，完整 ≥ 640k【推算，原型 6.2】；`MIN_PACKET` 决定启动前失败的窗口：o200k 族约 W < 18k、Claude 族与未知族约 W < 27k（加上中文错误原文时约 37k）会在受理时 `RELAY_INPUT_LIMIT` 并提供“只发这条消息”【推算，VF2-01】；窗口未知时界面注明“窗口未知，按 128k（网关、路由方与本地模型 32k）估算”。订阅或认证方式未知时不用美元上限（RT3 P02 第 6 条）。属性测试：W 在 4k–2M 上按对数均匀取样，在任意 (R̂, k̂, 价格, 窗口, contextUsed, 语言) 下，只要受理通过且精化窗口不小于保守窗口，plan() 就不出现 blocked；原样路径与 `attach:"none"` 断言不调用 `chooseBudget`。

要点：只有通道与窗口进硬上限，费用、时延与价格悬崖只在标准、精简、只交目标之间降档（第 19 节 O2）；历史长度永不导致 blocked，不再有 `CONTEXT_TOO_LARGE` 停摆（取代 R0 所列 `context.ts:56–58` 的整份上限）。终稿第 0 节摘要里的 capWindow 写作 `max(0, min(5%·W, W − S_B − 4,096))`，少了 `S_new`；本契约按第 6.2 节的伪代码。

**待拍板 D2**（终稿“状态与验收”，用户未另作决定时按推荐项登记）：推荐 (a) `MIN_PACKET` 按目标族取最小交接单，W 低于约 27k 的目标在启动前 `RELAY_INPUT_LIMIT` 并提供“只发这条消息”；(b) 放宽为只在 W<12k 时失败，会违反 K8（目标程序已启动 1.3–5 s 才报错，VF2-01）。

#### R1.4 错误码按阶段与准备失败（INV-21 扩）

引文（终稿第 9 节的相关行）：

| 情形 | 语义（所有者 · 上限 · 失败结果 · 用户所见） |
|---|---|
| 超限 | 分层降档并记省略账目；只有“最小交接单 + 当前原话”超过通道硬上限或 capWindow（`hardCap < MIN_PACKET[族]`：o200k 族约 W < 18k、Claude 族与未知族约 W < 27k【推算】）才 `RELAY_INPUT_LIMIT`，在受理时按保守窗口判定并提供“只发这条消息”（K8；RT3 P01、P02；VF2-01）；finalize 用精化窗口复判，更小时 Run 在派发前失败（open 后失败，见下表）；历史长度永不导致 blocked（属性测试，W 对数均匀取 4k–2M）；不再有 `CONTEXT_TOO_LARGE` 停摆 |
| 需要用户选择 | 受理时能判定的同步 `409 RELAY_CHOICE_REQUIRED{binding, cause, options, counts}`，不建 Run：cause `marker_absent`（suspect 无法核对且 need≠∅）选项［在同一会话补发完整交接单］［新开原生会话］；cause `delivery_unconfirmed`（pending 且自动重发已用尽或 `lateDelivery`）选项［再附一次］［只发这条消息］［新开原生会话］（VF1-02，D1）。只能在 open 之后发现的（返回 A 核对为 absent）让该 Run 以同一错误码在派发前失败，租约与进程随 Run 结束释放，草稿保留，选择经 `relay.native` / `relay.attach` / `relay.resend` 进入下一次请求（RT2-17、RT5-13） |
| 准备失败（渲染出错、脱敏失败、字节越界、缺少同意、厂商变化、分类不符、精化窗口过小） | 不派发，Run 失败（`RELAY_PREPARE_FAILED{reason: render ｜ render_mismatch ｜ redaction_failed ｜ storage ｜ storage_quota ｜ target_start ｜ classification_changed}`（没有 observation_required：观测失败或超时从不让准备失败）/ `RELAY_CONSENT_REQUIRED{reason: missing ｜ vendor_changed ｜ revoked}` / `RELAY_INPUT_LIMIT`），relay 状态不变（INV-21：不建交接单行、送达行与 pending，水位不被这次准备推进；open 时回放核对得到的结果照常随 `run.ended` 提交；原生会话与绑定按下表“open 后”处理）；脱敏 fail closed；切换已生效（非恢复切换只 validate，生效即改 selection，`runtime.ts:1563`、`:1603`【事实】），界面写“已切换到 Codex，但没能交接：原因。这条消息没有发出，草稿已保留”，提供［重试］［改回 Claude Code］［只发这条消息（不附交接单）］（J3 M7）；重试时同一句原话只出现一次（草稿不叠加，RT2-03） |
| **错误码按阶段**（F11） | **受理时**（同步 409，不建 Run，没有进程）：`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE{data_root_in_workspace ｜ consent_log_full}`、`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED{missing}`、`RELAY_INPUT_LIMIT`（按保守窗口；HTTP 429）。**启动前**（prePlan；Run 失败，没有进程，绑定不变）：排队 Run 重做 admit 的同一组错误码。**open 之后**（finalize、同意复检、分类复核、精化窗口；Run 失败、未派发）：`RELAY_PREPARE_FAILED{…}`、`RELAY_CONSENT_REQUIRED{vendor_changed ｜ revoked}`、`RELAY_INPUT_LIMIT`——此时原生会话已建立、绑定已写入（`codex.ts:350`、`runtime.ts:1384`【事实】），结算时按现状把绑定置为 ready、`throughRunId` 不动（`runtime.ts:1496`【事实】：未派发不推进）；新建的空原生会话随绑定保留，下一次按它 resume、不再新建；relay 状态不变；HTTP 已无从返回，错误经 `run.ended` 与 SSE 到达，`public-api.md` 写明 409 只覆盖受理时可判定的情形（VF3-02） |
| 目标启动失败 | 派发前失败，什么都没送达；文案同上（“Codex 没能启动”） |
| 数据根在工作区内 | 启动时记录告警，并对该工作区的全部会话在界面上告警、首次发送要求确认（库里是全部对话，不只跨厂商的，VF3-11）；受理跨厂商交接时 `409 RELAY_UNAVAILABLE{reason:"data_root_in_workspace"}`；同厂商与单 Harness 对话可继续；观测排除数据根与 `.tmp/`（10.1） |

取值汇总：`RELAY_PREPARE_FAILED.reason` ∈ {`render`, `render_mismatch`, `redaction_failed`, `storage`, `storage_quota`, `target_start`, `classification_changed`}（观测失败或超时从不让准备失败，没有 `observation_required`）；`RELAY_CONSENT_REQUIRED.reason` ∈ {`missing`, `vendor_changed`, `revoked`}（受理时 `missing` 与 `vendor_changed`；撤回后再缺同意就是 `missing`）；`RELAY_CHOICE_REQUIRED` 带 `{binding, cause, options, counts}`，cause ∈ {`marker_absent`, `verify_required`, `delivery_unconfirmed`}；`RELAY_UNAVAILABLE.reason` ∈ {`data_root_in_workspace`, `consent_log_full`, `recovery_failed`}；`NATIVE_STATE_UNCONFIRMED` 沿用；`SWITCH_SOURCE_UNKNOWN`、`SWITCH_NOT_EFFECTIVE` 是切换与排队 Run 的失败原因。`public-api.md` 写明 409 只覆盖受理时可判定的情形、长历史不再报 `CONTEXT_TOO_LARGE`。

**HTTP 映射**【事实】：`src/web/server.ts:265–267` 按错误码文本映射状态——含 `LIMIT` → 429；以 `_REQUIRED` 结尾、或含 `UNAVAILABLE` → 409；其余落到 502。所以 `RELAY_INPUT_LIMIT` 是 429（与第 9 节、第 12.4 节一致），`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED`、`RELAY_UNAVAILABLE` 是 409，而 `RELAY_TARGET_UNVERIFIED` 不匹配现行规则的任何一支、会得到 502。终稿第 12.4 节写明它取 409，实现时由 G073 经 `server.ts` 的所有者 G050 为它显式扩展这条规则。

**核对不可用时的选择**：R4 表里 suspect 行的 b 列规定 cause ∈ {rewind, unknown_command, clear_unconfirmed, unknown_turn} 且存在外来事实时必须先核对；受理前无法核对（`verify=none`，或上次核对 unavailable）即 `409 RELAY_CHOICE_REQUIRED{cause:"verify_required"}`，选项［在同一会话补发完整交接单］［只发这条消息］［新开原生会话］；`on_next_open` 的 Driver 在 open 后才核对，核对不可用则该 Run 在派发前以同一错误码失败（终稿第 6.1、9 节）。

### R2 送达证据与 Driver 能力声明

#### R2.1 证据等级（引文，终稿第 7.1 节）

| 等级 | 含义 | 来源（机制，不按产品） | 推进 |
|---|---|---|---|
| E1 | 实时事件 | `delivery.live = recorded_event`：Driver 收到原生历史的用户条目回显（含客户端 ID）；`agent_output`：本回合第一条 agent 文本/思考/工具调用（弱 E1，不认 plan 与 usage） | 推进 |
| E2 | 事后按位置核对 | `verify = after_turn`（结算后 ≤2 s，只在 E1/E3 未定论时）、`on_next_open`（下次 open 回放，零成本）；派发前记录 `DeliveryPosition`，核对只读该位置之后的客户端用户条目并匹配标题行（J4 M10）；pending 时只核对待核的那份包自己（首份包 mark=null 也核对），suspect 时核对已 recorded 的 ≤4 份标记，按标记逐个给结果（VF1-01、F03）；迟到写入：在位置之后的用户条目里按本包标题行查找，查到的上一包顺带改记 recorded（VF1-13）；结果 `present` 推进；`absent` 只记 `unknown{absent}`，除非 Driver 另有插入前失败的证据；`outside_window`、`compacted`、`unavailable` 记对应 unknown | present 推进；其余不推进 |
| E3 | 结算推断 | `BackendResult.input = recorded`：Driver 按协议语义判定输入已入原生历史（非命令回合的 end_turn、带 errorKind 的失败、OpenCode 在送达之后发生的 Provider 错误（R8 O3））；`successProvesRecorded=false` 时 completed 不算；Driver 的 `classify` 判为命令的回合不成立（RT5-05、VF1-06） | 推进 |
| native | 亲历 | 本绑定在当前纪元执行了不带包、派发时 need=∅ 的内容回合（事件 b；命令回合与 `attach:"none"` 的回合不算，VF1-04、F01），结论 recorded 或有 agent 输出：该回合及其之前的 need（当时为空）视为已知 | 推进到该回合的 `contextThroughSeq` |
| not_recorded | Driver 确知未发出 | 插入前的接口拒绝（Codex 无 turnId 的 REMOTE_ERROR，`codex.ts:511`、`:527`【事实】）、Driver 合成的结果（OpenClaw `model_not_applied`，`openclaw.ts:91–94`【事实】；Claude `/remote-control` 拒绝、`/export`，`claude.ts:24–25`、`:70–72`【事实】；OpenCode `COMPACT_IGNORED`，`opencode.ts:9`【事实】）、插入前取消（只限 Driver 能证明插入未发生的：Codex 无 turnId）、未派发、Hermes 网关拒绝准入与 `NATIVE_GATEWAY_UNAVAILABLE`（`hermes.ts:96–98`、`:120–122`【事实】） | 不推进；欠交区间不变 |
| unknown | 没有证据 | 其余一切（ACP 通用 REMOTE_ERROR，`acp.ts:557–560`【事实】；Hermes `unknown_execution`，`hermes.ts:39`【事实】；进程被杀；核对超时、不可用、窗口外、压缩、absent；`lateDelivery` 的 Driver（OpenCode、OpenClaw）取消后的回合记 `unknown{late_delivery}`：OpenClaw 对 cancelled 不回读（`openclaw.ts:440`【事实】）而网关会尽力补写用户回合（R8 W2，VF1-13）） | 不推进；进入 pending |

上表 Hermes 一格的代码位置按实际代码改为 `hermes.ts:120–122`（`NATIVE_GATEWAY_UNAVAILABLE` 在这里返回；终稿写的 `:124` 是相邻的“结果未知”判断）。

#### R2.2 规则（J1 M2，逐字进契约）

> delivered 只因 E1/E2(present)/E3/native 推进，与回合终态无关；命令回合从不携带交接内容；`attach:"none"` 的回合不产生证据、不改水位；clear：Hub 确认后进入新纪元并记录清空下限，确认不了即 suspect{clear_unconfirmed}；rewind 与效果未知的命令：suspect；not_recorded：不推进；unknown：pending；正面证据可把 unknown 与 not_recorded 纠正为 recorded（RT2-09）。

#### R2.3 送达结论与送达行

```ts
/** 送达证据等级与结论（R8）。没有证据就是 unknown，不是 not_recorded；核对“没找到”也只是 unknown。 */
export type EvidenceClass = "E1" | "E2" | "E3" | "legacy" | "origin" | "native";
export type DeliveryOutcome =
  | { kind: "in_flight" }
  | { kind: "recorded"; evidence: EvidenceClass; decidedSeq: number; decidedAt: number; verifiedInRun: RunId | null }
  | { kind: "not_recorded"; reason: "rejected_before_insert" | "driver_synthesized" | "cancelled_before_insert" | "never_dispatched" | "gateway_refused"; decidedSeq: number; decidedAt: number }
  | { kind: "unknown"; reason: "no_evidence" | "owner_ended" | "verify_timeout" | "verify_unavailable" | "absent" | "outside_window" | "compacted" | "late_delivery"; decidedSeq: number; decidedAt: number };
/** 核对位置：open 之后、派发前由 Driver 记录；核对只读该位置之后的首条用户条目（RT3 P03）。第三方字段只在 Driver 内解释；Hermes 用回放条目计数（`seq`，F20）。 */
export type DeliveryPosition = { kind: "file_offset"; path: string; bytes: number } | { kind: "seq"; before: number } | { kind: "client_id"; id: string } | { kind: "none" };
export type MarkerResult = "present" | "absent" | "outside_window" | "compacted" | "unavailable";
/** 按标记逐个回答（F03）；historyEmpty 只有能读整段历史的 Driver 给出（Hermes 回放、OpenClaw `sessions.get`），用于确认清空（VF1-03）；compaction 是回放或事件里的压缩游标（VF1-08）。 */
export interface VerifyResult { markers: readonly { packetId: RelayPacketId; result: MarkerResult }[]; historyEmpty: boolean | null; compaction: { count: number; digest: Fingerprint | null } | null; foreignAfterLast: number | null; verifyMs: number }
/**
 * 独立送达表的一行：每个 Run 至多一行。允许的转换：in_flight→{recorded, not_recorded, unknown}；unknown→{recorded, not_recorded}；
 * not_recorded→recorded（只由后续正面证据触发，纠正误判，RT2-09）；unknown→unknown 与 recorded→recorded 的同值写允许（reason 细化、realized 结算，VF1-12）。
 * 逐 Run 的清单字段（同意 seq、当前输入 HMAC、送达时的压缩游标、重发关系）放这里，不放按正文去重的 relay_packets（F08）。
 */
export interface DeliveryRecord { runId: RunId; packetId: RelayPacketId; channel: "text_block" | "single_text"; position: DeliveryPosition; outcome: DeliveryOutcome;
  consentLogSeq: number | null; inputHmac: RedactionTag; compactionAtDelivery: { count: number; digest: Fingerprint | null } | null; resendOf: RunId | null; attachOverride: boolean;
  realized: { requests: number; cacheHits: number; closedBy: "compaction" | "clear" | "epoch" | "idle" } | null }   // 窗口关闭时只以计数写入，供 R̂、k̂ 统计（RT3 P10）
```

- 本章的类型片段都摘自终稿第 4 节（`src/contracts/relay.ts` 草案）；其中引用的 `RelayPacketId`、`Fingerprint`、`RedactionTag`、`SourceRange`、`VendorKey`、`VendorObservation`、`Tier`、`DataClass` 等定义见该节，`RunId` 是现有类型（`src/contracts/session.ts:11`【事实】）。
- 送达结论存独立的 `relay_deliveries` 表，每个 Run 至多一行（INV-31），不写进已终结的 Run（终结的 Run 不可改写，`state.ts:441`【事实】）。表的列、触发器与写法见存储契约 R2。
- 转换先在应用层按上面注释里的允许表校验，触发器只作断言；同值写（unknown→unknown 的 reason 细化、recorded→recorded 的 realized 结算）不算转换（VF1-12）。
- 核对“没找到”只记 `unknown{absent}`，除非 Driver 另有插入前失败的证据；只有 Driver 确知未发出才记 not_recorded。

#### R2.4 Driver 接口与能力声明

**与 Driver 的接口**（`control.ts` 增补）：Driver 模块导出静态 `relayCapabilities: RelayCapabilities`（受理时经 `factory.relayCapabilities(harnessId)` 同步读取，不建实例，F10）与 `HarnessControl.relay?` 指向同一对象；`deliveryPosition?(id): Promise<DeliveryPosition | null>`（open 之后、`context_prepared` 事务之前调用，只读，位置随送达行同事务落库，F20）；`startText(id, text: TurnText, …)`，`TurnText = string | { readonly user: string; readonly relay: { readonly packetId: RelayPacketId; readonly body: string; readonly firstLine: boolean } }`，由 Driver 决定拼接（两段 text、单 text、技能项 + 正文 + 余下原话）；`ControlEvent` 增加 `{ type: "input_recorded"; packetId?: RelayPacketId }`；`BackendResult.input?: "recorded" | "not_recorded"`（缺省 unknown；v12 持久化前剥离，v13 解析器接纳）；`BackendResult.native?: { cleared: true; replaced: { checkpoint: string } | null }`（Driver 确认本回合清空了原生历史：Hermes 的固定回执、OpenClaw `sessions.get` 见新会话、Claude 合成 `session/new` 时带新会话的 checkpoint；F04、VF1-03）；`verifyDelivered?(position, markers): Promise<VerifyResult>`——按标记逐个回 `present | absent | outside_window | compacted | unavailable`，另回 `historyEmpty`、压缩游标与 `foreignAfterLast` 计数，不回灌原生内容（R8 §5；F03）；`userTextOf?(replayed): { user: string; stripped: readonly { kind: DataClass; bytes: number }[] }`（回放导入时剥掉原生包装，VF3-09）；`NativeModelCatalog.commands[i].contextEffect?: ContextEffect | ((args: string) => ContextEffect)`、`hiddenCommands?`；`relay.commands.classify(text)` 复刻原生解析（VF1-06）；`setTitle?(id, title)` 在因交接新建的会话 `session/new`（Codex `thread/start`）之后、首个提示之前调用（Codex `thread/name/set`、Claude `_session/rename`、Hermes `/title`，第 5.1 节；VF3-12、13）；`NativeUsage.requests?: readonly { input: number; cachedInput?: number; cacheWrite?: number }[]`（有界 ≤64 条，逐请求用量，缓存指标与 R̂ 用，VF2-09）。

```ts
/** Driver 的静态能力声明：只描述机制，不出现产品名；缺项按最保守值（INV-16）。模块级常量，受理时不建实例即可读（F10）。 */
export interface RelayCapabilities {
  probed: boolean;                                                                    // 该 Driver 的 P2、P3、P6、P11 探针已在最新正式版通过（F13）；生产只对 true 开放
  delivery: { live: "recorded_event" | "agent_output" | "none"; verify: "after_turn" | "on_next_open" | "none"; successProvesRecorded: boolean; lateDelivery: boolean };   // lateDelivery：取消的回合其输入可能晚到（OpenCode、OpenClaw）
  execution: "process" | "gateway";                                                   // gateway：查看器退出不是静止证据（RT2-05）
  commands: { unlistedSlash: "executed" | "text"; hidden: readonly { name: string; effect: ContextEffectRule; acceptsRelay?: boolean }[];
    classify: (text: string, catalog: readonly { name: string; effect: ContextEffectRule; acceptsRelay?: boolean }[] | null) => CommandClass };   // 复刻原生解析（VF1-06）；unlistedSlash=text 时恒为 content
  placement: { parts: "multiple" | "single"; maxInput: { unit: "chars" | "bytes"; limit: number } | null; pointersAfterUser: boolean };
  window: "session_report" | "turn_report" | "none";
  fixedPrefix: { tokens: number; basis: "measured" | "assumed" } | null;              // 目标自己的系统提示与工具规格 S_B（VF2-04）
  cacheTtl: "5m" | "30m" | "1h" | "hours" | "unknown" | "auth_dependent";
  compactionEvidence: "event" | "replay_marker" | "usage_drop" | "none";              // RT5-07；replay_marker 的 Driver 从回放回报游标（VF1-08）
  resolveVendor: (observed: VendorObservation) => VendorKey;                          // 端点由 Driver 按各家优先级从它自己的配置层解析，Hub 只看结果（VF3-01）
  normalizeModel: (model: string | null) => string;                                  // 去 provider 前缀与别名，供 relay_windows 与 documented() 查表（VF2-04）
  title: "set" | "none";                                                              // 因交接新建的会话在首个提示之前回写公共标题（RT5-04、VF3-12）
  hostPathRead: "verified" | "declared" | "needs_grant" | "none";                     // v1.1
  sessionTools: null | { owner: "program"; listFrozenAtCreate: true; preApproval: "session_allow_list" | "read_only_auto" | "unknown" };  // v1.2
}
export type TurnText = string | { user: string; relay: { packetId: RelayPacketId; body: string; firstLine: boolean } };
```

#### R2.5 七家的声明（终稿第 8.1 节的摘要）

下表摘自终稿第 8.1 节（【建议】；第三方行为的出处以终稿为准，本文只核对了 Hub 侧的代码位置）。每项增强对应一个 RelayConformance 探针，探针在最新正式版上通过后才改该 Driver 的声明（ADR-053、INV-16）；终稿只对 OpenCode 与 OpenClaw 声明 `lateDelivery: true`。

| Harness | 放置 | E1（live） | E2（verify 与核对位置） | E3 与 not_recorded | lateDelivery · execution · 压缩证据 | 清空确认 · 原生标题 |
|---|---|---|---|---|---|---|
| Claude Code（claude-agent-acp） | 两个 text 块，不用 resource | none | after_turn；`file_offset`：`startText` 前 stat 本会话 JSONL 的字节长度，核对只读该偏移之后的客户端用户条目，并先确认该 JSONL 属于当前对话 | end_turn、max_tokens、max_turn_requests、带 errorKind 的失败 → recorded；cancelled → unknown；`/remote-control` 拒绝与 `/export` → not_recorded；successProvesRecorded true；after_turn 超时 → unknown | 未声明 · process · event（`compaction_update`） | 由 Driver 合成 `session/new`，经 `BackendResult.native{cleared, replaced.checkpoint}` 回报（P6 探针证明前不声明持久清空）· set（`_session/rename`，首个提示之前） |
| Codex（app-server） | 单 text：正文 + 换行 + 原话；`clientUserMessageId = runId` | recorded_event：`userMessage.clientId == runId`（现状 `codex.ts:706` 丢弃 userMessage 条目【事实】） | after_turn；`client_id`：`thread/turns/list` 找该 ID | successProvesRecorded false（hook 拦截的回合报 completed 却无 userMessage）；无 turnId 的 REMOTE_ERROR → not_recorded（`codex.ts:525–527`【事实】）；`/export` → not_recorded；E1 未到且核对失败 → unknown | 未声明 · process · event | 终稿未写 · set（`thread/name/set`，`thread/start` 之后、首个 `turn/start` 之前） |
| OpenCode 2 | 两个 text 块，不用 synthetic | none | none（`costly` 核对要另开连接，在 finalize 内拿不到租约） | 非命令回合 end_turn → recorded；送达之后发生的 Provider 错误（ServiceFailure）→ recorded；cancelled → `unknown{late_delivery}`；`COMPACT_IGNORED` 与合成的 `NATIVE_COMMAND_IGNORED`（`opencode.ts:9–10`、`:79–84`【事实】）→ not_recorded | true · process · event | 终稿未写 · 无协议入口，P13 通过前“未保证” |
| DeepSeek Harness（dsh） | 两个 text 块（dsh 合成一条 user message） | agent_output（首条 message/thought/tool_call，弱 E1） | none | successProvesRecorded false；无弱 E1 → unknown | 未声明 · process · none | dsh 无命令 · 无入口，P13 通过前“未保证” |
| Hermes Agent（网关查看器） | 两个 text 块；附件指针附在原话段之后（`pointersAfterUser`） | none | on_next_open（每回合 open 都 `session/load` 回放，`restoreByLoad`，`hermes.ts:100`【事实】）；`seq`：open 时回放的条目计数，核对在该计数之后的客户端用户条目里匹配标题行，跳过带 `compactionSummary` 元数据的条目；`historyEmpty` 由回放给出 | `classify` 判为内容的回合 end_turn → recorded；`unknown_execution` → unknown（`hermes.ts:39`【事实】）；网关拒绝准入与 `NATIVE_GATEWAY_UNAVAILABLE` → `not_recorded{gateway_refused}`（`hermes.ts:96–98`、`:120–122`【事实】）；`/export` → not_recorded | 未声明 · gateway · replay_marker | `/clear` 类命令的回复等于固定回执 `Conversation history cleared.` 时确认，否则 `suspect{clear_unconfirmed}` 到下次回放 · set（首个交接回合之前代发 `/title <公共标题>` 并吞掉回执，D3） |
| OpenClaw | 单 text（桥加 cwd 前缀；`userTextOf` 剥掉它） | none | after_turn；`seq`：派发前的 `transcriptSeq()`（`openclaw.ts:429`【事实】），在 `before` 之后的客户端 user 行里按本包标题行查找；200 条窗口（`openclaw.ts:18`【事实】）没覆盖到 `before+1` → outside_window（`openclaw.ts:446–447`【事实】） | cancelled → `unknown{late_delivery}`（Driver 对 cancelled 不回读，`openclaw.ts:440`【事实】）；`model_not_applied` → not_recorded（`openclaw.ts:91–94`【事实】）；successProvesRecorded false；回读不可读 → unknown | true · gateway · 未核实（终稿 Q 表） | `/new` 后 `sessions.get` 见新会话 · `_meta.sessionLabel` 待探针 |
| WorkBuddy | 未接入 | — | — | 作为目标：`RELAY_TARGET_UNVERIFIED`（等级“无法接续”，只提供“只发这条消息”）；作为交出方不受影响 | — | — |

共同做法：只用会话级参数，不写任何用户配置；Driver 为厂商键读取 Harness 自己的配置层时只读端点键、不读别的键、不记录值；工作区内不建任何文件。输入上限由 Driver 声明 `maxInput`（Codex 1,048,576 字符、OpenClaw 2,097,152 字节，文档常量），派发前检查、越限降档，降到 goal 仍越限则 `RELAY_INPUT_LIMIT` 在派发前失败。厂商键与同意的规则属[安全契约](security.md)与终稿第 10.4 节，本契约只引用受理时的检查。

#### R2.6 已声明与已探针（D11）

Driver 的接力能力有两态：代码里写出声明即“已声明”；该 Driver 的 RelayConformance 探针 P2、P3、P6、P11 在最新正式版通过后翻转 `probed=true` 即“已探针”。`probed=false` 的 Driver 作目标时受理即 `RELAY_TARGET_UNVERIFIED`（等级“无法接续”，只提供“只发这条消息”= `attach:"none"`：原样发送、不产生证据、水位不变），与 WorkBuddy 同一路径；开发与测试经配置 `relay.allowUnprobed=true` 放开（默认 false）。**待拍板 D11**：推荐 (a) 生产只对 `probed=true` 的 Driver 开放；(b) 一律开放、送达按 unknown 处理。六家声明的初值都是 `probed=false`（G069 的范围），所以探针通过之前，生产环境里的每一次交接都走这条路径【推断】。

#### R2.7 E1 的提交与分隔线

- E1 由 `input_recorded` 触发：先冲刷打开的文字窗口（[ADR-047](../decisions/0047-stream-output-coalescing.md)），再并入 `run.first_output`（本来就是独立事务，`runtime.ts:1175`【事实】）或本回合下一次既有提交；没有输出时并入 `run.ended`。同一事务把送达行改为 recorded(E1)、绑定改为 synced（写者就是本 Run）；不设置 `firstOutputAt`；ADR-047 第 5 条补一条修订（RT2-21）。
- 分隔线“从这里起由 X 接手”只在拿到 E1、E2 或 E3 之后出现；只有 E3 的 Driver 收到第一条输出时显示“已开始回复，送达待确认”，只显示、不推进水位；证据到达之前不出现“已接棒”（现状按切换生效画线，改为按证据；INV-21）。

### R3 原生位置与送达水位

#### R3.1 两个字段，两个事实

- **原生位置**：v12 已有的 `throughRunId`，语义收紧为“该绑定最后一个在它上面派发的 Run”；它所属的纪元由该 Run 的 `relay.executedOn.nativeEpoch` 记录。`throughRunId` 仍须指向同一 harness/control 的已终结 Run（`state.ts:319–320`【事实】，不变）。分支精确性读它。
- **送达水位**：v13 新增的 `DeliveredMark`，在 `binding.relay.sync` 里，是有正面证据表明已进入该绑定原生历史、或该绑定亲历的事实上界。只有 E1、E2（present）、E3 与 native 推进它；已派发不算送达。
- 两者分开存、分开推进：命令回合推进原生位置而不动水位；携带包的回合 unknown 时原生位置照常推进，水位不动、绑定进入 pending。

```ts
/** 原生绑定的接力状态（v13：NativeSessionBinding.relay）。throughRunId 另存原生位置。序列化 ≤1,024 B（用最长合法值断言）。 */
export interface DeliveredMark { throughSeq: number; chain: Fingerprint; lastPacketId: RelayPacketId | null; evidence: EvidenceClass; basis: "evidence" | "origin" | "legacy" | "native" }
export type SyncPrior = { kind: "fresh"; basis: "new" | "user_cleared" | "reset" } | { kind: "synced"; mark: DeliveredMark }
  | { kind: "suspect"; mark: DeliveredMark | null; cause: SuspectCause; floorCandidate: number | null;
      carried: { prior: SyncPrior; packetId: RelayPacketId; range: SourceRange } | null };   // floorCandidate：clear_unconfirmed 时清空 Run 的 run.ended seq，确认后写入 epochFloor（VF1-03）；carried：只在 cause=unknown_turn 且那个 unknown 回合携带了包 P 时非空，保存进入 pending 前的 prior 与 P，核对后按 R4 推进或回到 prior（D6）；嵌套的 prior 不再带 carried
export type SuspectCause = "rewind" | "unknown_command" | "legacy" | "marker_absent" | "clear_unconfirmed" | "unknown_turn";   // 每个取值都由 R4 的某个转换产生；unknown_turn：process 型 Driver 崩溃后继续原会话（D6）；厂商键变化走 RELAY_CONSENT_REQUIRED{vendor_changed}，核对不可用走 RELAY_CHOICE_REQUIRED{verify_required}
export type BindingSync =
  | SyncPrior
  | { kind: "pending"; prior: SyncPrior; packetId: RelayPacketId; range: SourceRange; autoResends: 0 | 1; manualResends: number; attachOverride: boolean };   // RT2-07；attachOverride 供 resend 继承（VF1-07）
export interface BindingRelayState {
  nativeEpoch: number; sync: BindingSync; originIncluded: boolean; reanchor: boolean; packetsInEpoch: number;
  epochFloor: number;                                                                  // 清空下限：−1 表示没有；随谱系继承；need 下界恒为 max(mark, epochFloor)（VF1-07）
  compactionSeen: { count: number; digest: Fingerprint | null };                       // 压缩游标；只在变化时算“观察到压缩”（VF1-08）
  consentKey: VendorKey | null;                                                        // 本纪元首次送达时的厂商键；观测到不同即须重新同意（RT4 M9）
  vendorObserved: VendorObservation | null;                                            // 上次结算时 Driver 报告的端点与模型，供受理时预判（F10）
  cache: { lastRequestStartedAt: number | null; contextUsed: number | null; contextSize: number | null };   // 判“热”用最后一个请求的开始时刻（VF2-16）；model 取 binding.observed.model
}
```

`epochFloor` 不在 `sync` 里，随绑定谱系保留（VF1-07）；archived 绑定的 `relay` 冻结（RT1-B2）；绑定的 `relay` 序列化 ≤1,024 B，用最长合法值断言（例如 `gateway:<253 字符主机名>`）。`ContinuityLevel` 从字符串改为对象，解析器同时接受 v12 事件里的旧字符串（`runtime.ts:275`【事实】）：

```ts
/** 接续等级：主标签（用户可见）与内部取值。 */
export type ContinuityLevel =
  | { kind: "native_resume" }
  | { kind: "native_resume_delta"; tier: Tier; runs: number }
  | { kind: "rehydrate"; tier: Tier; complete: boolean }
  | { kind: "native_fork" } | { kind: "native_import" }
  | { kind: "native_cleared" }
  | { kind: "blocked"; code: "RELAY_INPUT_LIMIT" | "NATIVE_STATE_UNCONFIRMED" | "RELAY_CONSENT_REQUIRED" | "RELAY_CHOICE_REQUIRED" | "RELAY_TARGET_UNVERIFIED" | "RELAY_UNAVAILABLE" };
export type DeliveryStatus = "in_flight" | "recorded" | "unknown" | "not_recorded";
```

#### R3.2 外来事实与 need

引文（终稿第 6.3 节 `plan()` 的开头）：

```text
plan(run, binding, request, budget?):
  if request.attach == "none" → raw                           // 用户选“只发这条消息”：原样发送（事件 n）；本回合不产生 native 证据，sync、水位与 pending 都不变；下一条照常附包（F01、VF1-02）
  F = foreignFacts(binding)                                   // 第 2 节：已派发 ∧ 终态 ∧ executedOn ≠ (X, e)，加 origin（originIncluded=false 时）
  floor = request.attach == "full" ? −1 : binding.relay.epochFloor   // 下限随绑定保留，与 sync 的 kind 无关（VF1-07）
  base  = mark(binding.sync)?.throughSeq ?? −1
  need  = { f ∈ F | f.seq > max(base, floor) } \ request.excludeRuns \ session.exclusions
  if need = ∅ ∧ ¬binding.reanchor → raw                      // 原样发送（事件 b），等级 native_resume / native_cleared；不进预算
  budget ??= chooseBudget(...)
  if binding.sync.kind == "pending":                          // 到这里说明 admit 已判定可以自动重发（autoResends=0 ∧ ¬lateDelivery）或用户选了 relay.resend，否则受理时已 409
    kind = "resend"; attach = binding.sync.attachOverride      // 重发继承被取代包的“附上”（VF1-07）
  else kind = need = ∅ ∧ reanchor ? "anchor"
       : mark == null ? "packet" : "delta"                    // basis native/origin/legacy 的 synced 也发 delta；lastPacketId=null 时增量附全部约定
```

- 本绑定上 not_recorded 的内容回合不是它自己的外来事实，只提示“没有发出”；对其他绑定它是外来事实（`executedOn` 不同），原话注明“没有送达任何 Harness”（第 19 节 O6）。
- 用户排除的轮次（`relay.exclusion_added`）不进 need；撤回排除只影响之后渲染的包，水位已越过被排除 Run 的绑定不再补交，界面写明（VF1-14、F21）。
- need 的下界恒为 max(水位, `epochFloor`)；“附上交接单”是一次性的 `relay.attach:"full"`，只对那一条请求把下限当作 −1。

#### R3.3 纪元与清空下限

- **`nativeEpoch`**：确认的清空类命令、显式重建、新开原生会话时加 1；在同一会话同一 (harnessId, controlId) 的所有绑定（含 archived）上单调递增，重建后的新绑定取已有最大值 +1（RT1-B3、RT2-01）。
- **`epochFloor`**：用户清空类命令所在 Run 的 `run.ended` seq，在 Hub 确认清空发生后写入；−1 表示没有；随同一 (harnessId, controlId) 的绑定谱系保留（synced、重建、Claude 合成清空的新绑定都继承）；只增不减；水位回退不低于它。
- **`packetsInEpoch`**：只在事件 g（携带包的回合 recorded）时加 1，清空时归零；决定压缩之后是否重锚（R6）。
- **`consentKey`**：本纪元首次送达时的厂商键；观测到不同即须重新同意（RT4 M9）。

#### R3.4 分支与重建（引文，终稿第 7.5 节）

- **分支（ADR-025）**：原生副本只在精确位置建立：`throughRunId === through.id`、`through` 之后没有在同一 harness/control 上派发过的 Run（`runtime.ts:438` 增加这一条件，修 J1 F1(a)）、`through` 在该绑定当前 `nativeEpoch` 内派发、**源绑定为 synced 且 need(through) = ∅**（RT1-B7、RT2-15）；精确时新对话的绑定 `originIncluded=true`、`sync=synced{throughSeq: 0, basis: origin, lastPacketId: null}`；源绑定为 pending 或 suspect 时不做原生分支；其余情形 `fresh{new}`，第一份交接单把来源历史作最旧一层（区间行或 G3），之后 delta 不再带 `branchedHistory`（修 R4 D5，`context.ts:48`）。

- **重建（native-reset，`runtime.ts:401–416`【事实】）**：归档旧绑定（其 `relay` 冻结）；新绑定 `fresh{reset}`，`originIncluded=false`，`epochFloor` 继承旧绑定的值（用户清空过的历史不因重建回来，一次性“附上”仍可取回，VF1-07），`compactionSeen` 归零，`nativeEpoch` 取同一 (harnessId, controlId) 已有绑定的最大值 +1（RT1-B3、RT2-01）；旧绑定的回合因纪元不同成为外来事实，下一条带完整交接单，来源说明用“同一家的另一个会话”。

接续本机会话（ADR-029）：import 绑定 `originIncluded=true`、`synced{0, origin}`；回放的用户条目先经 Driver 的 `userTextOf(replayed)` 剥掉原生包装，判定 Hub 交接单要求标题行里的 ID 在本安装 `relay_packets` 中、且从标题行到结束行的字节与已存正文一致（允许 Driver 声明的前后缀）；原程序里多出的回合只计数（`foreignAfterLast`，ADR-039）。导入卫生的完整规则见终稿第 7.5 节与第 10.5 节。

#### R3.5 配置承接（ADR-028，INV-14 改）

配置承接改为读同一 (harnessId, controlId) 在当前选择纪元内最后一个已派发且 `input ≠ not_recorded` 的 Run，跨因清空归档的绑定（VF1-10）；不再依赖 `throughRunId`（现状读 `throughRunId`，`state.ts:392`【事实】），顺带修掉 OpenClaw `model_not_applied` 之后承接旧模型的既有问题。v12 过渡期（P0）先改为取该绑定最后一个已派发的 Run（R3.6）。

#### R3.6 v12 过渡期的推进规则（P0，G067，不升库）

引文（终稿第 7.6 节）：

v12 只有 `throughRunId` 一个字段，它继续表示原生位置，推进规则写死为 `advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ 已重发一次))`（J1 F1 裁定，RT2-03、VF1-11 修订），其中 due 是本回合开始时应补交给该绑定的来源集合、carried 表示本回合携带了交接内容、“已重发一次”由 `run.ended.data.relayResendOf`（重发回合指向被取代的回合）推出。含义：单 Harness（due=∅）下任何已派发回合都推进，本绑定 not_recorded 的回合也推进（否则下一回合把失败回合当来源改发 JSON 信封，`runtime.ts:1337–1339`、`:1392`【事实】，是 OpenClaw `model_not_applied` 与 Codex 无 turnId 拒绝之后的新回归）；due≠∅ 时命令回合不推进（D1、D2）；携带回合 not_recorded 不推进；unknown 第一次不推进、下一回合重发，重发后推进（“插入前取消”在 P0 仍可能重复一次，v13 改按核对）。配套：`runtime.ts:1337–1339` 的来源过滤排除未派发的 Run（现状把无 `dispatchedAt` 的 Run 也算来源【推断】）；`runtime.ts:438` 增加“through 之后没有在同一 harness/control 上派发过的 Run”；`state.ts:392` 改为取该绑定最后一个已派发的 Run（命令回合不推进水位后，配置承接不再依赖 `throughRunId`）；`BackendResult.input` 为瞬时字段，持久化前剥离（`state.ts:95` 白名单不变【事实】），但 `run.ended` 事件数据保留 `input`、`contextEffect` 与 `relayResendOf`（事件类型开放，`sqlite-store.ts:85–106`【事实】），供 v13 迁移作直接证据（RT1-B1）。清空、回退与效果未知的命令在 v12 只记录 `contextEffect`、不改水位；它们欠下的补交由 v13 的 suspect 核对补齐；v12 也没有纪元，清空之后的旧位置仍会被 `runtime.ts:438` 判为精确。**已知局限**（写进发布说明，v13 关闭）：上述两点；以及 R0a 只对将要发送的内容预算，切到新目标时要发的就是全部来源，900 KiB 回复之后 B 的第一条仍可能 `CONTEXT_TOO_LARGE`（R4 的 R3、R6），R0a 对这条错误提供“只发这条消息”（`attach:"none"` 的 P0 版本：原样发送、不改 `throughRunId`），分层预算要到 G070（VF1-11）。

### R4 同步状态及其转换

四种状态的类型见 R3.1（`fresh` / `synced` / `pending` / `suspect`；终稿第一版摘要写“五态”是笔误，RT1-M3）。引文（终稿第 7.2 节）：

事件：**a** 内容回合派发且携带包 P（pending 时只能是 resend P′）；**b** 内容回合派发不带包且派发时 need=∅；**n** 内容回合派发不带包但 need≠∅（只在用户选择 `attach:"none"` 后发生）；**c** 命令 keep/none；**d** compact 命令或压缩游标变化；**e** clear 命令且 Hub 确认（Driver 的 `BackendResult.native.cleared`、OpenClaw `sessions.get` 见新会话、Hermes 固定回执、Claude 合成）；**e′** clear 命令但结算时确认不了；**f** rewind 或效果未知的命令；**g / h / i** 携带包的回合 recorded / not_recorded / unknown；**j** b 的结算（命令回合与 n 的结算单列：**不变**，VF1-04）；**k** 核对结果（按标记逐个）；**l** native-reset；**m** 迁移（14.4）。`epochFloor` 不在状态里，随绑定保留（VF1-07）。

| 状态 \ 事件 | a | b | n | c | d | e | e′ | f | g / h / i | j | k | l |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **fresh{basis}** | pending{prior=本状态, P, range, autoResends=0, manualResends=0, attachOverride} | 不变（派发时） | 不变（无证据） | 不变 | 不变（packetsInEpoch=0 不置 reanchor；游标更新） | fresh{user_cleared}，epochFloor=本 Run 的 run.ended seq，epoch+1 | suspect{mark=null, cause=clear_unconfirmed, floorCandidate=本 Run seq} | suspect{mark=null, cause} | — | recorded 或有 agent 输出 → synced{throughSeq=contextThroughSeq, chain=sha256(""), lastPacketId=null, evidence=native, basis=native}；not_recorded → 不变，界面“没有发出”；unknown 且无活动 → 不变，界面“未确认” | 跳过（无标记） | 归档；新绑定 fresh{reset}，epochFloor 继承，epoch=max+1，originIncluded=false |
| **synced{mark}** | pending{prior=本状态, …} | 不变 | 不变 | 不变 | 游标变化且 packetsInEpoch>0 → reanchor=true | fresh{user_cleared}，epochFloor=本 Run seq，epoch+1，reanchor=false，packetsInEpoch=0 | suspect{mark, cause=clear_unconfirmed, floorCandidate} | suspect{mark, cause} | — | recorded 或有 agent 输出 → mark 不动（本绑定回合不是外来事实）；not_recorded → 该 Run 对其他绑定是外来事实，对本绑定只提示“没有发出”；unknown → 不变，界面“未确认”（J1 M17 改造） | lastPacketId=null → 跳过；present → 不变；outside_window / unavailable → 不变，只记 `relay.verified`（送达行已是终态 recorded，不重发，F03）；absent（窗口覆盖位置且送达后游标未变）→ suspect{marker_absent}（只在 need≠∅ 时停下，RT5-08）；compacted 或送达后游标变过 → reanchor=true | 同上 |
| **pending{prior, P}** | 只作为 resend：pending{prior 不变, packetId=P′(supersedes P), autoResends+1 或 manualResends+1}；前提 autoResends=0 ∧ ¬lateDelivery，或用户 `relay.resend`，否则受理时已 409（F03） | 不发生（need≠∅） | 不变：水位与 pending 都不变，本回合不产生证据，下一条内容输入前仍先核对 P（VF1-02） | 不变（命令不捎带，水位不动） | 游标更新；先做压缩分类（7.4）再判 k | fresh{user_cleared}，epochFloor=本 Run seq，epoch+1（P 的送达不再追究） | suspect{mark=prior 的 mark, cause=clear_unconfirmed, floorCandidate} | suspect{mark=prior 的 mark, cause} | g：synced{throughSeq=P.range.throughSeq, chain=sha256(prior.chain ‖ P.body.sha256), lastPacketId=P, evidence}，packetsInEpoch+1；h：回到 prior（RT2-07）；i：保持 pending；下一条内容输入：先核对 P 自己（k）；仍未知且 autoResends=0 ∧ ¬lateDelivery → a（resend）；否则受理同步 `RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}`［再附一次］［只发这条消息］［新开原生会话］ | —（pending 下不发生 b） | 只核对 P 自己的标题行（VF1-01）：present → g；absent → i（unknown{absent}）；compacted → reanchor=true 且 i；outside_window / unavailable → i；旧包 present 不推进 P | 同上 |
| **suspect{mark, cause, floorCandidate, carried}** | pending{prior=本状态, …}（只在核对后或用户选择后） | 只对 cause ∈ {legacy, marker_absent} 且 need=∅ 允许：视同 synced 并记 `relay.verified{result:"nothing_owed"}`（RT5-08）；cause ∈ {rewind, unknown_command, clear_unconfirmed, unknown_turn} 在 F≠∅ 时必须先核对（k），受理前无法核对 → 409 `RELAY_CHOICE_REQUIRED{cause:"verify_required"}`，open 后无法核对 → 派发前以同一错误码失败（VF1-09；终稿第 9 节）；F=∅（单 Harness 对话）→ 不核对、按 b 原样派发 | 不变 | 不变 | 游标更新 | fresh{user_cleared}，epochFloor=本 Run seq，epoch+1 | cause=clear_unconfirmed，floorCandidate 取最新 | 不变（cause 取最新） | — | 同 synced 的 j（只在 b 放行之后） | 已 recorded 的 ≤4 份标记逐个核对：全在 → synced{mark}；部分在 → synced{mark 退到最后一个仍在的标记}（欠交区间变大，同一会话补发）；都不在且送达后游标未变 → mark 退到 max(本纪元第一份包 range.fromSeq − 1, epochFloor)（VF1-07）；compacted 或游标变过 → reanchor=true 并按仍在的标记退；cause=clear_unconfirmed：historyEmpty=true 或标记都不在且游标未变 → fresh{user_cleared}，epochFloor=floorCandidate，epoch+1；标记仍在 → 回到清空前的状态；cause=unknown_turn：该回合的用户条目在位置之后 → carried≠null 时按 g 推进（synced{throughSeq=carried.range.throughSeq, chain=sha256(prior.chain ‖ P.body.sha256), lastPacketId=carried.packetId, evidence=E2}，送达行 recorded(E2)，packetsInEpoch+1；回合结果仍未知，交接单注明），carried=null 时 synced{mark}（mark 不动）；不在 → carried≠null 时回到 carried.prior（送达行 unknown{absent}，下一条内容输入照常按 need 组包），carried=null 时不变；unavailable / outside_window → 停在派发前，`RELAY_CHOICE_REQUIRED{cause:"verify_required"}`（7.4） | 同上 |

表外说明：

- 事件 m（迁移）不是从某个状态出发的转换，而是为每个绑定给出初始的 `relay`，规则见存储契约 R4；属性测试枚举“4 种状态 × 表中全部 14 种事件”（a、b、n、c、d、e、e′、f、g、h、i、j、k、l），m 单独在迁移的属性测试里覆盖。
- “—”表示该事件不会在该状态下发生（例如 pending 下不发生 b）。
- `SuspectCause` 共 6 种（R3.1）。need=∅ 时只有 legacy、marker_absent 两种放行；rewind、unknown_command、clear_unconfirmed、unknown_turn 在存在外来事实（F≠∅）时必须先核对，没有外来事实的单 Harness 对话不核对也不阻挡（第 19 节 O12）。表中进入 suspect 的事件产生 rewind、unknown_command（f）、clear_unconfirmed（e′）、marker_absent（k）、unknown_turn（R10 的 D6 路径）与 legacy（迁移）——每个取值都有进入转换；原先的 verify_unavailable 与 vendor_changed 没有进入转换，已从类型删除（写入阶段处置）。

属性（J1 M3，写成属性测试，以假 Harness 的真实原生历史为参考模型，RT1-M3）：任意证据序列下 `mark.throughSeq` 不超过实际送达或亲历；同一纪元内只在 suspect 回退时变小且不低于 `epochFloor`（确认的清空进入新纪元，INV-30）；recorded 之后 need 与已送达部分无交集；外来事实为空的纪元里、以及 `attach:"none"` 的回合里 `dispatched === input`；fresh 上任意命令序列之后 need 不变（VF1-04）；旧包 present 不推进 pending 包（VF1-01）；任意 reset/clear 序列后，新绑定的 need 覆盖其原生会话缺少的全部回合且不含 `epochFloor` 之前的回合（RT2-01、VF1-07）；收过包后 `/clear` 再发 20 条，`dispatched === input`（VF1-03）；枚举 4 种状态 × 14 种事件，没有未定义的组合，且每个 `SuspectCause` 取值都由某个转换产生（VF1-02）。送达结论存独立表，不写进已终结的 Run（`state.ts:441`【事实】）。

### R5 命令回合与 contextEffect

```ts
/** 命令目录项的上下文效果；缺省 unknown；可按参数给出（OpenClaw `/reset soft`、Hermes `/compress --preview`，RT2-24、RT5-17）。 */
export type ContextEffect = "keep" | "none" | "compact" | "clear" | "rewind" | "unknown";
export type ContextEffectRule = ContextEffect | { readonly byArgs: (args: string) => ContextEffect };
/** 命令分类结果：由 Driver 的 `classify(text)` 复刻原生解析（前导空白、注册表与别名、路径排除）给出；首行省略、命令跳过与 E3 共用（VF1-06）。 */
export type CommandClass = { kind: "command"; name: string; args: string; effect: ContextEffect; acceptsRelay: boolean } | { kind: "content" } | { kind: "possible_command"; name: string };   // possible_command：合语法但目录缓存缺失，finalize 时定
```

引文（终稿第 7.4 节）：

- **命令回合**：分类由 Driver 的 `classify(text, catalog)` 复刻原生解析给出（VF1-06）：Hermes 先 `text.lstrip()` 再判（`hermes-agent/acp_adapter/gateway_server.py:32`【事实】，python 的 lstrip 去掉 U+3000、U+00A0），Hub 现状的 `run.input.startsWith("/")`（`runtime.ts:1393`【事实】）不认全角空格——输入“　/clear”会被 Hub 当内容带包，被 Hermes 当 `/clear` 执行，交接单丢失且 E3 误判为 recorded；所以首行省略、命令跳过与 E3 共用同一个 `classify`，RelayConformance 对每家加半角、全角前导空格各一例。目录内命令（`acceptsRelay` 除外）、`hidden` 列表里的命令，以及 `unlistedSlash=executed` 时 `classify` 判为命令的任何 `/x` 一律原样发送、不捎带；判为内容的 `/…`（Claude 的路径 `/Users/…`，RT5-05）是内容；原生位置照常推进到该 Run；送达水位不动；欠交内容留给下一条内容输入（同时修 R4 D1、D2）。**受理时就按静态声明预分类**：命令与疑似命令跳过同意、选择、数据根与预算检查（第二版让 `/clear` 也被 `RELAY_INPUT_LIMIT` 挡住，小窗口下成死路，VF1-05）；open 后 `models()` 复核，不符 → `RELAY_PREPARE_FAILED{reason:"classification_changed"}`。**命令效果 = 声明效果 ∧ 实际执行了**：被判为 not_recorded 或 noop 的命令回合（OpenCode 合成 `NATIVE_COMMAND_IGNORED`，`opencode.ts:79–84`【事实】；Codex `/compact` 无 turnId 拒绝，`codex.ts:511`【事实】；Hermes `/compress` 答 noop，`gateway_commands.py:213–222`【事实，VF1】）不按 d/e/f 转换；Claude `/remote-control` 列入 hidden（effect none），不再因“目录外合语法”变成 suspect（`claude.ts:65–70`【事实】）。交接后第一条是命令时，卡片写“这是 X 的命令，不会附上交接单；交接单会随下一条普通消息发出”（RT5-16）；Hermes `/queue`、`/steer` 在无运行中回合时把参数当提示提交（`gateway_commands.py:42–47`，RT5-16），声明 `acceptsRelay`。

各家的分类（终稿第 8.1 节“命令语法与效果”列的摘要）：

| Harness | `classify` 规则 | clear | compact | rewind | keep（acceptsRelay） | 其余 |
|---|---|---|---|---|---|---|
| Claude Code | 去前导空白后按 `^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$` 取名字，路径不是命令；unlistedSlash executed | clear、reset、new，由 Driver 合成（R6）；不保留进程时从审批选项去掉 `exit-plan-clear-*`，保留时记为一次 clear | compact | — | 技能与自定义命令 → keep | `/model` 等 → none；`remote-control` → hidden none；目录外合语法的 `/x` → unknown |
| Codex | 同 ACP（去前导空白） | 终稿未写 | compact | — | `skill:*` → keep 且 acceptsRelay | export → none |
| OpenCode 2 | 目录内命令 | 终稿未写 | compact（Hub 补入） | — | 配置命令 → keep（提交即返回、模板在回合外续跑，交接单状态节写“命令在后台继续运行，结果未记录”） | 被合成忽略的命令不按声明效果转换 |
| DeepSeek Harness | unlistedSlash text；`classify` 恒为 content（dsh 无命令） | — | — | — | — | — |
| Hermes Agent | 复刻 `gateway_server.py:32` 的 `lstrip()` 后按注册表全部名字与别名判定（约 104 条，RT5-05 的 grep 计数；公告只有 14 条）；unlistedSlash executed | new、clear、reset | compress；`--preview` → none（byArgs）；`/compress` 答 noop 时不转换 | undo、retry | queue、steer → keep 且 acceptsRelay | 其余 none 或 unknown |
| OpenClaw | 桥识别的斜杠命令（终稿 Q10） | new；确认不了 → `suspect{clear_unconfirmed}` | compact；reset 按参数（`soft` 保留转录 → compact） | — | — | stop → none；restart、bash → unknown |

`run.native_command` 事件增加 `contextEffect`、`argsClass`、`executed: true ｜ false ｜ unknown`，效果只在 executed 时生效，提交点前移到 authorized 之前（存储契约 R3）。

### R6 清空、回退与压缩

引文（终稿第 7.4 节、第 7.5 节与第 6.4 节）：

- **清空**（J3 M2 恢复水位语义，RT1-B4、RT2-02、RT5-02；确认路径按 VF1-03、F04）：`contextEffect=clear` 的回合结算时，Driver 能确认（`BackendResult.native.cleared`：Hermes 的固定回执 `Conversation history cleared.`（`gateway_commands.py:192、205`【事实，VF1】）；OpenClaw `sessions.get` 见新会话；Claude 合成 `session/new` 并带新 checkpoint）→ 事件 e：`nativeEpoch+1`、`sync=fresh{user_cleared}`、`epochFloor=本 Run 的 run.ended seq`、`reanchor=false`、`packetsInEpoch=0`；`throughRunId` 保持但属于上一纪元。确认不了 → 事件 e′：`suspect{clear_unconfirmed, floorCandidate}`，纪元不加、下限不写；下一次 open（Hermes 每回合都回放）核对：回放为空或标记都不在 → 这时才按 e 转换；标记仍在 → 回到清空前的状态（清空没发生）。第二版靠“下一次回放为空再退回第一份包之前”会把清空前的历史整份补回，而 `usage_update` 的 `context_tokens=0` 又会被当压缩证据，本版两路都堵上（6.4）。`clear_unconfirmed` 期间不复用保留进程、need=∅ 也不放行（VF1-09）。输入框上方显示“X 的上下文已清空 · 下一条不附历史［附上交接单］”（确认之前写“清空待确认”）；默认原样发送（need 以 `epochFloor` 为下限）；点“附上”即下一条请求带 `relay.attach:"full"`，只对那一条忽略下限——清空前本绑定自己的回合因纪元变化成了外来事实，自然包含在内，来源说明用“同一家的另一个会话”变体；附上的包若 unknown，resend 继承 `attachOverride`（VF1-07）。A 清空 → B 两轮 → 回 A：只补交 B 的两轮（下限之后的外来事实）。

- **Claude 的合成清空**（F04、VF1-10）：Driver 结束原生会话并 `session/new`，在 `BackendResult.native.replaced.checkpoint` 回报新会话；Runtime 在 `run.ended` 事务里归档旧绑定（`assertSessionTransition` 新增一条：写者 Run 的 `run.ended` 带 `native.cleared` 时允许“归档 + 新建同 harness/control 绑定”，不要求 native-reset 命令，`state.ts:418–424`【事实】只放行带 native-reset 的归档）；新绑定 `fresh{user_cleared}`、`epochFloor=本 Run seq`、`nativeEpoch=max+1`、`originIncluded=false`，并**继承旧绑定的 `observed`**，Driver 用观测模型打开（否则先 `/model X` 再 `/clear` 会被悄悄换回 selection 的模型，即 RT1-m4 要避免的 K14 回归）；配置承接（ADR-028）改为读同一 (harnessId, controlId) 在当前选择纪元内最后一个已派发且 `input ≠ not_recorded` 的 Run，跨因清空归档的绑定（顺带修掉 OpenClaw `model_not_applied` 之后承接旧模型的既有问题，`state.ts:391–394`【事实】）；保留进程的 `kept.conversation` 在 checkpoint 变化时更新（否则下一回合被 `acp.ts:525` 以 IDENTITY_MISMATCH 拒绝【推断】）。【假设】Claude CLI 的 `/clear` 保留当前模型，列入 P6（Q22）。

- **回退**：Hermes `/undo N`、`/retry` → suspect{cause: rewind}；下一回合 open 时回放给出仍在的标记，mark 回退（不低于 `epochFloor`）、欠交区间变大，在同一会话补发。保留原生进程时命令回合也会被保留（`keepable` 只看 completed 与清理，`runtime.ts:635–641`【事实】），复用时不 open、没有回放（`runtime.ts:1345–1354`【事实】）：所以 `verify=on_next_open` 的 Driver 在绑定为 suspect 或 pending 时不复用保留进程，先关闭再 open 回放核对（VF1-09）。

- **压缩**：Hub 不为交接触发压缩；压缩只是用户可见的可选步骤。压缩证据是一个**游标**而不是一个标志（VF1-08）：绑定存 `compactionSeen{count, digest}`——`compactionEvidence=event` 的 Driver 每个事件加 1；`replay_marker` 的 Driver（Hermes）从回放里数带 `_meta.hermes.compactionSummary` / `containsCompactionSummary` 或以 `[CONTEXT COMPACTION — REFERENCE ONLY]` / `[CONTEXT SUMMARY]:` 开头的条目（`hermes-agent/acp_adapter/server.py:83–98`、`agent/context_compressor.py:261、295`【事实，VF1】；摘要作为普通消息持久，此后每次回放都在），取计数与最后一条的指纹；`usage_drop` 的 Driver 用“相邻两回合 `usage_update.used` 下降 ≥30%【建议值】”加 1，但 `commandEffect ∈ {clear, rewind}` 的回合与 `clear_unconfirmed` 期间不计（清空后网关推送 `context_tokens=0`，`gateway_commands.py:226–236`【事实，VF1】）。只有游标**变化**才算“观察到压缩”：本纪元收到过交接单的绑定（`packetsInEpoch > 0`，只在事件 g 时加 1）在游标变化时置 `reanchor`，下一条内容输入附要点（单独的 `anchor` 包，或 delta 里的要点小节），每次压缩至多一次（R3 I-7）；从未收到交接单的绑定不置位（J3 M1）。送达行记录送达时的游标 `compactionAtDelivery`，标记缺失的分类据此判断“送达后压缩过”（7.4）。pending 期间观察到压缩：先按 7.4 的压缩分类，再判核对结果（RT2-24、RT1-M3）。返回 A 时 `contextUsed/contextSize ≥ 0.85` → 选择器提示“先压缩再续接”或“新开并附交接单”。

### R7 标记缺失时的分类

引文（终稿第 7.4 节）：

- **标记缺失的分类**（返回 A，synced 且核对最后一个标记；与 7.2 的 k 列同一套规则，F03）：① `compacted`（核对结果本身，或送达行的 `compactionAtDelivery` 与当前游标不同）→ 置 `reanchor`，在同一原生会话发带要点的增量；② `outside_window` / `unavailable` → 只记 `relay.verified`，状态不变、不重发（送达行已是终态 recorded；第二版“按 pending 规则重发一次”会重发已送达的包）；③ `absent` 且窗口覆盖派发位置且游标未变 → suspect{marker_absent}：need=∅ 时视同 synced（RT5-08）；need≠∅ 时派发前以 `RELAY_CHOICE_REQUIRED` 结束（草稿保留，租约与进程随 Run 结束释放），选项默认“在同一会话补发完整交接单（可能与已有内容重复）”，另有“新开原生会话”；永不自动归档 ready 绑定（J1 M5；`contracts/session.ts:144`）。核对只认客户端写入的用户条目，且只匹配本回合派发的第一段文本的标题行；用户粘贴的框架行不在派发位置之后的首条用户条目里，不会误判（RT2-09）；Hermes 没有数字位置，核对须跳过带 `compactionSummary` 元数据的条目（VF1-08）。

### R8 A→B→A

引文（终稿第 7.3 节）：

```text
planReturn(A, now):                                        // 在 open 之后、finalize 内执行；只对 verify=on_next_open 的 Driver 在此核对，after_turn 的在上一回合结算时已核对
  if A.sync == pending → verifyDelivered(position(P), [P])             // 只核对待核的那份包自己，首份包（prior.mark=null）也核对；旧包 present 不推进（VF1-01）→ 按 7.2 pending 行的 k
  else if A.sync == suspect ∧ cause == clear_unconfirmed → verifyDelivered(…) 读 historyEmpty 与仍在的标记 → 按 suspect 行的 k
  else if A.sync == suspect ∧ A.mark?.lastPacketId ≠ null → verifyDelivered(本纪元最近 ≤4 份 recorded 交接单的位置与标题行) → 按 suspect 行的 k 逐个更新
  else if A.sync == synced ∧ A.mark.lastPacketId ≠ null → 核对最后一个标记；结果按 synced 行的 k，压缩按游标与送达行的 compactionAtDelivery 比较   // lastPacketId=null（legacy/origin/native）跳过（RT1-M11）
  Δ = need(A)                                              // 下界 max(mark, epochFloor)
  warm = now − A.cache.lastRequestStartedAt < 0.8 × ttl(A.cacheTtl, auth)                    // 缓存寿命从请求开始计，用最后一个请求的开始时刻作代理（VF2-16）
  N = A.cache.contextUsed ?? 估算；T = est(交接单)；S_new = est(当前原话)
  S_A = A 本纪元首个请求的固定前缀（系统提示与工具规格）：relay.fixedPrefix ?? relay_windows.firstTurnUsed ?? FIXED_PREFIX_DEFAULT（F18 的 S_A 定义）
  native = { 等级 Δ=∅ ? native_resume : native_resume_delta,
             首个请求 = N·(warm ? p_r : p_w) + (|Δ| + S_new)·p_w,   之后每个请求 = (N + |Δ| + S_new)·p_r + 新增·p_w,
             时延 = warm ? (|Δ| + S_new)/P̂ : (N + |Δ| + S_new)/P̂ }
  fresh  = { 等级 rehydrate, 首个请求 (S_A + T + S_new)·p_w, 之后每个请求 (S_A + T + S_new)·p_r + 新增·p_w, 时延 (S_A + T + S_new)/P̂ }      // 只估算，不执行
  perRequestDiff = native.之后每个请求 − fresh.之后每个请求 = (N + |Δ| − S_A − T)·p_r         // 卡片写明“每个后续请求 +$x”（C7，VF2-07）
  wholeDiff = (native.首个请求 − fresh.首个请求) + (R̂ − 1) × perRequestDiff
  默认 native；并列显示 fresh 的条件（冷热都适用）：wholeDiff ≥ $0.10 ∨ native.时延 − fresh.时延 ≥ 10 s ∨ N/W ≥ 0.85（J2 M15 改造）
  用户偏好 relay.returnPreference：总是续接 / 冷且长时新开 / 每次询问（J3 B11；存 relay_prefs，F07）；从不静默改等级；选择经 relay.native 进入请求
```

费用与时延数字只用于显示与默认档的降档建议（RT3 P10）：R̂、k̂ 取同一（harness、模型族、认证类别）最近 50 个实现值的**生存估计**（实现值在窗口关闭时以计数写入 `relay_deliveries.realized`，仍开着的窗口是右删失，按 Kaplan–Meier 取中位数，VF2-07），请求数取 Driver 报告的 `NativeUsage.requests` 条数（没有则取“工具调用数 + 1”并标注“推算”），n < 20 时用 R=80、k=0 并标注“先验”；订阅用户只显示 token。依据：Opus 5.5 上 N_A=150k 冷续接首个请求约 $0.78、+19 s，新开 T=8k 时约 $0.115、+2.9 s；按 R=80 全程续接约 $3.22、新开约 $0.48，首个请求的差只占全程差的 24%（R6 §2.7 公式，RT3 P10、VF2 §2 复算；第一版 T0 的“$0.06、+1.5 s”是 R6 表的点值，改用公式）。表驱动单测覆盖 (R, k) ∈ {(80,0), (80,5), (300,0), (300,15)} 四点。

- 增量包：Claude 这类从未收到过交接单、靠亲历进入 synced 的绑定（`lastPacketId=null`），返回时的增量附全部 7 条阅读约定（终稿原型 d1 实测 1,095 token，系数 1.3；有基准时 642【实测】）；其余增量两行框架。增量不写 `basePacketId`。
- **待拍板 D9**：推荐 (a) 默认续接原会话，冷且全程费用差 ≥ $0.10 或时延差 ≥10 s 时并列显示“新开并附交接单”；(b) 冷且长时默认新开。返回偏好 `relay.returnPreference` 存安装级 `relay_prefs`（存储契约 R2）。

### R9 unknown 时的重发

引文（终稿第 7.4 节）：

- **unknown 的重发**：每个包最多自动重发 1 次（`resend`，`supersedes`，重渲染全部 need，继承 `attachOverride`），之后由用户决定；声明 `lateDelivery` 的 Driver（OpenCode、OpenClaw：取消的输入可能晚到，R8 O2、W2）不自动重发。**不能自动重发时**，下一条内容输入在受理时同步 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed", options}`：［再附一次］（`relay.resend:true`，manualResends+1，J3 M14）、［只发这条消息］（`attach:"none"`，事件 n）、［新开原生会话］（`relay.native:"new"`）；第二版这一格没有转换，字面实现会越过上限继续重发或永停 pending（VF1-02、F03）。不自动重跑任何回合（INV-11）。

补充：

- resend 重新渲染当前全部 need（pending 期间新增的外来事实一并带上），`supersedes` 指向原包，开头带去重行“如已看过 {原 ID} 可忽略重复部分”（RT2-10）；`kind` 为 `resend`，继承被取代包的 `attachOverride`（VF1-07）。
- pending 下用户选“只发这条消息”（事件 n）：原样发送、本回合不产生证据，水位与 pending 都不变，下一条内容输入前仍先核对 P（VF1-02）。
- **待拍板 D1**：推荐 (a) 受理时同步 409 让用户三选一（［再附一次］［只发这条消息］［新开原生会话］）；(b) 原样发送、状态不变是静默降级。
- v12 过渡期（P0）：unknown 第一次不推进、下一回合重发，重发之后推进，次数由 `run.ended.data.relayResendOf` 推出（R3.6）；“插入前取消”在 P0 仍可能重复一次，v13 改按核对。

### R10 重启与恢复

引文（终稿第 9 节的相关行）：

| 情形 | 语义（所有者 · 上限 · 失败结果 · 用户所见） |
|---|---|
| Hub 中途重启（S15） | `recoverSession` 语义不变：非 queued 的 Run 一律 unknown、待决切换 failed（`state.ts:466–479`【事实】，INV-11/12）；`claimAndRecover` 在调用它的同一个 BEGIN IMMEDIATE 里再调用领域纯函数 `recoverRelay(state, deliveries)` 并写入其 relay 变更（`sqlite-store.ts:577–590`【事实】只写 sessions 与 events，本稿扩展；`recoverSession` 是领域函数、Coordinator 此时不存在，F05）：没有 `dispatchedAt` 的 → 送达 `not_recorded{never_dispatched}`、绑定回到 `prior`；有 `dispatchedAt` 的 → `unknown{owner_ended}`、绑定保持 pending；送达行已是 recorded 的（E1 已提交）→ 不改。被恢复终结的 Run 没有 `run.ended`，其事实 seq 取 `session.recovered` 事件的 seq（VF1-15）。恢复按会话各自一个 SAVEPOINT，一个会话的 relay 行写失败只让该会话标为 `relay_recovery_failed` 并在打开时拒绝接力，不让 `claimAndRecover` 整体失败（VF1-12）。unconfirmed 绑定仍抛 `NATIVE_STATE_UNCONFIRMED`。文案按 Run 状态分开：queued → “这条消息没有发出”（`contracts/session.ts:348`【事实】）；其他 → “服务重启，这一轮结果未知”。恢复后这类 Run 的 cleanup 为 null，直接 `RECOVERY_UNSAFE`（`runtime.ts:750–751`【事实】）：gateway 型对话只能分支或关闭，process 型按 S6 的 D6 路径可继续原会话；K1、K2、K4 之后才能在同一对话里继续（RT2 第 2 节的崩溃注入表），G074 的故障矩阵与 S15 文案写明。不再承诺“下一次派发得到相同 ID 与字节”（事实、观测、首行都已变化，RT1-M6、RT2-06） |
| 上一回合 unknown（S6） | 会话 blocked（现有）；恢复切换须显式确认并记入 `acknowledgedUnknown`；交接单写“第 k 轮结果未知、未重新执行、先检查工作区”；对应观测标“未确认”；不自动重跑（INV-11）。**gateway 型**：A 的绑定仍 unconfirmed → 返回 A 必须 native-reset（v1.1 的只读核对打开可免，8.2）。**process 型（D6，VF3-15）**：Hub 自己确认该回合的进程组已结束（ADR-030 的进程组记录；确认不了仍是 `RECOVERY_UNSAFE`）后，绑定改为 ready 且 `suspect{cause:"unknown_turn"}`，提供“继续原会话”：下一次 open 只读 resume（Claude `session/load`、Codex `thread/resume`、OpenCode / dsh 同其恢复入口），按该回合的 `DeliveryPosition` 判用户条目是否在原生历史里（在 → synced{mark}，不在 → 回到 prior），need=∅ 时原样续接，need≠∅ 时照常附增量；不重跑回合（INV-11 不变）；由探针 P16 证明只读打开不触发回合，通过前 G3 写明不含这条路径 |
| Hermes / OpenClaw 查看器被杀、网关回合继续（S14） | `execution=gateway`：查看器退出不是静止证据（INV-12、ADR-015；RT2-05）。Run 记 unknown，绑定 unconfirmed，租约不释放给其他执行者，`recoverable` 拒绝恢复直到网关侧确认（Hermes 准入状态 / `/discard`，OpenClaw `sessions.get` 显示回合已结束）；v2 里确认手段是用户在原程序里操作后的 native-reset，v1.1 加“只读核对打开”（8.2）。界面“Hermes Agent 在 HarnessHub 断开后可能仍在执行第 9 轮，请在 Hermes 里确认后再继续”；交给他人时写明该事实与计数，不搬原生内容。第一版的“下次 open 回放给出标记”在现码上不可达（`runtime.ts:1336` 在 open 前抛 NATIVE_STATE_UNCONFIRMED【事实】，RT1-m8、RT5-09） |
| OpenClaw `/new`、Hermes `/clear` | clear：Driver 确认（OpenClaw `sessions.get` 观察到新会话；Hermes 固定回执）→ fresh{user_cleared}、epochFloor、epoch+1；确认不了 → suspect{clear_unconfirmed}，下次回放为空再生效（7.4） |

- **崩溃注入点**：K1–K18 的定义见 RT2 的[崩溃注入点表](../proposals/relay/round3/rt2-failure-races.md)；G068 的验收要求 K7–K11 崩溃注入之后送达表与绑定状态一致，G072 对每个提交点做崩溃注入，G074 的故障矩阵覆盖 K1–K18。
- **待拍板 D6**：推荐 (a) process 型 Driver 在 unknown 回合之后经 Hub 自己确认进程组已结束、只读 resume 并按核对位置判定，绑定 `suspect{unknown_turn}`，need=∅ 时原样续接；(b) 维持现状，只能分支、关闭或 native-reset。(a) 由探针 P16 门控，通过之前 G3 写明不含这条路径。
- 恢复按会话各自一个 SAVEPOINT；某个会话的 relay 行写失败只把该会话标为 `relay_recovery_failed`：快照的会话级字段 `SessionSnapshot.relayRecoveryFailed`（该次 `session.recovered` 事件的 seq，事件数据带 `relay.failed: true`），之后将要携带接力内容的回合受理即 `409 RELAY_UNAVAILABLE{reason:"recovery_failed"}`，need=∅ 的回合与单 Harness 对话照常；用户在该会话上 native-reset 或新开原生会话后清除（终稿第 9 节）。

### R11 竞态（补充）

| 交错 | 裁决 | 依据 |
|---|---|---|
| 切换已受理未生效时发消息 | admit 的目标取 `pendingSwitch?.target ?? selection`，按将要执行它的绑定预检 | 终稿第 6.1 节，VF3-02 |
| 排队消息前面的回合换了模型或清空 | 排队 Run 在 prePlan 时重做 admit，不通过的在启动前失败 | 终稿第 6.1 节 |
| 受理分类与 open 后的目录不符 | `RELAY_PREPARE_FAILED{reason:"classification_changed"}`，不派发 | 终稿第 6.1 节，VF1-05 |
| 同意在 finalize 之后被撤回 | `run.dispatched` 的事务里再读一次同意，已撤回就不派发；撤回时一并作废待发的重发与 LRU 缓存 | 终稿第 10.4 节，RT2-18 |
| open 后观测到的厂商键与受理时预判或 `consentKey` 不同 | `RELAY_CONSENT_REQUIRED{reason:"vendor_changed"}`，不派发；本纪元收过包的绑定记 `relay.vendor_changed` | 终稿第 10.4 节，RT4 M9 |
| E1 与流式文字窗口 | 先冲刷窗口，再提交 E1，保持 ADR-047 的到达顺序 | 终稿第 14.2 节，RT2-21 |
| 保留进程与待核的绑定 | `verify=on_next_open` 的 Driver 在绑定为 suspect 或 pending 时不复用保留进程，先关闭再 open 回放核对 | 终稿第 7.4 节，VF1-09 |
| 迟到写入（取消的输入晚到） | 在位置之后的用户条目里按本包标题行查找，查到的上一包顺带改记 recorded；`lateDelivery` 的 Driver 不自动重发 | 终稿第 7.1 节、第 7.4 节，VF1-13 |
| 回合外的 `usage_update` | 没有写者 Run，只写 `relay_windows`，不改绑定 | 终稿第 14.3 节（`acp.ts:634`【事实】） |
| 停止并切换时停止未确认 | 同一事务里待决切换 failed、排队 Run `SWITCH_NOT_EFFECTIVE`，之后走恢复切换 | R1.1 |

### R12 不变量与 assertSessionTransition

引文（终稿第 14.3 节中与切换和送达有关的行）：

| ID | 内容 | 验证 | 计划用例 |
|---|---|---|---|
| INV-14（改） | A 已知的公共事实只由当前 `nativeEpoch` 的送达水位（正面证据或亲历）与清空下限 `epochFloor` 决定，下限随绑定谱系保留；原生位置与送达水位是不同事实；fork 精确性读原生位置且要求源绑定 synced、need(through)=∅、位置在当前纪元内；配置承接（ADR-028）读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 input≠not_recorded 的 Run，跨因清空归档的绑定（VF1-10）；已派发不算送达；clear 经 Hub 确认后进入新纪元并记录下限，确认不了即待核；rewind、未知命令、未知送达、未知回合转待核；待核的绑定在核对或用户选择之前不复用（cause ∈ {legacy, marker_absent} 且 need=∅ 除外；没有外来事实的单 Harness 对话不核对也不阻挡）；pending 只核对待核的那份包自己 | 属性测试：任意证据序列下水位单调且不超过实际送达或亲历，回退不低于下限；清空后 20 轮 `dispatched === input`；A 清空 → B 两轮 → 回 A 只补 B；旧包 present 不推进 pending 包 | G068-P01（property）、G068-C05、G068-C06、G068-C07（integration） |
| INV-21（扩） | 切换生效与交接送达分别表达；分隔线与“已接棒”只在证据后出现；准备失败不派发、relay 状态不变——不建交接单行、送达行与 pending，水位不被这次准备推进；open 时回放核对得到的结果是事实，照常提交（open 后失败时原生会话与绑定按第 9 节保留）；停止未确认时待决切换失败而不悬挂 | 浏览器测试三种证据路径；故障注入；宽限到期后仍能 resume | G073-C01（e2e）、G072-C04（integration）、G068-C08（integration）、G067-C07（integration，宽限到期后仍能 resume） |
| INV-30（新，相对第二版改写） | 外来事实为空的绑定（从未交接、或清空后未选附上）收到的每条输入与用户原文逐字节相同；`attach:"none"` 的回合逐字节相同且不改水位；携带包时第二段等于原话；每个原生纪元至多一份完整交接单（前一份 not_recorded、unknown 待核或用户再附除外），之后只追加 delta 与 anchor；同一纪元内 mark 只在 suspect 回退时变小，确认的清空进入新纪元 | 20 轮零延迟假 Harness 插入未派发、合成失败、`/export`、`/clear`、`/undo`、attach none、WorkBuddy 目标断言 `dispatched === input`；ON CONFLICT DO NOTHING 计数 | G068-C01（integration）、G074-R02（probe，P15） |
| INV-31（新） | 一个 Run 至多携带一份交接单（增量可含要点小节）；送达结论只由逐回合证据决定，与终态无关；送达结论不写进已终结的 Run；正面证据可纠正 unknown 与 not_recorded；同值写不算转换 | 独立表转换测试（J1 M3）；触发器无效样例 | G066-C04（integration） |
| INV-33（新，相对第二版改写） | 没有目的厂商键的同意记录，不向该厂商发出历史；厂商键由 Driver 按机制与它自己解析的端点声明；撤回后不再发出；本纪元内厂商键变化须重新同意；`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`，来源是工作区文件的端点每个会话都问；目的厂商指主模型请求的实际处理方，Harness 自配的辅助模型与记忆不在 Hub 可见范围；登记过的唯一例外：厂商键为 `local`（回环端点且模型不转云端）且用户标记“本机模型不出网”（`relay_prefs` 的 `relay.localModelsOffline=true`）时免同意 | 集成测试（J4 M12 每条；CS-01–CS-04，含 `local` 例外的正反两例） | G072-C06（integration，CS-01–CS-04）、G074-R03（probe，P14） |

`assertSessionTransition`（`state.ts:410–464`【事实】）扩展（J1 M6；RT1-m3）：`binding.relay` 只能由在该绑定上执行的 Run 修改（迁移、恢复与用户的 pin/exclusion/consent 命令除外）；`nativeEpoch` 单调；`epochFloor` 只增不减；同一纪元内 `mark.throughSeq` 只在 suspect 回退时变小且不低于 `epochFloor`（确认的清空进入新纪元，INV-30）；`throughRunId` 仍须指向同一 harness/control 的已终结 Run（`state.ts:319–320` 不变）；`run.relay` 与 `contextReadyAt` 纳入 `:448` 的“派发后不可改”；归档绑定的 `relay` 不变（拒绝改动归档绑定的是 `:418`）；**写者 Run 的 `run.ended` 带 `native.cleared` 时允许“归档旧绑定 + 新建同 harness/control 绑定”而不要求 native-reset 命令**（Claude 合成清空，F04；`:418–424` 现状只放行带 native-reset 的归档）；回合外的 `usage_update`（`acp.ts:634`【事实】）没有写者 Run，只写 `relay_windows`，不改绑定；`pending.packetId` 等跨存储引用在 Store 写入时校验；每条规则各配一个无效样例（G066-C06）。

### R13 待决、未定之处与实施归属

**写入阶段提出、终稿已修订处置的点**（处置见[第四轮处置表](../proposals/relay/round4/v3-dispositions.md)末节，本契约的 R3.1、R4、R1.4、R10 已按修订后的终稿改写）：

- suspect{unknown_turn} 带 `carried{prior, packetId, range}`：携带包的回合 unknown 之后进入 suspect 时保存 prior 与 P，核对“在”则按 g 推进到 P 的区间、“不在”则回到 prior（R3.1、R4）。
- `SuspectCause` 删除没有进入转换的 verify_unavailable 与 vendor_changed；核对不可用走 `RELAY_CHOICE_REQUIRED{verify_required}`，厂商键变化走 `RELAY_CONSENT_REQUIRED{vendor_changed}`（R4）。
- `RELAY_CHOICE_REQUIRED` 的 cause 增加 `verify_required`；`RELAY_TARGET_UNVERIFIED` 在实现中显式映射为 409（R1.4）。
- `relay_recovery_failed` 存快照字段 `SessionSnapshot.relayRecoveryFailed`，之后携带接力内容的回合受理即 `RELAY_UNAVAILABLE{reason:"recovery_failed"}`（R10）。

**需要真机核实**（终稿第 20 节，与本契约有关的）：Q1 Claude `/clear` 后按旧会话 ID resume 是否回到清空前的转录；Q2 Hermes 压缩标记行是否稳定、游标 `digest` 是否跨回放不变；Q3 OpenCode 与 OpenClaw 取消后的输入是否晚到；Q4 Codex hook 拦截的回合与 dsh blocked 回合的证据；Q5 E3 规则随版本漂移；Q10 OpenClaw 桥加 cwd 前缀后网关是否仍识别斜杠命令；Q21 Hermes、OpenClaw 网关侧的静止确认与只读核对打开；Q22 Claude `/clear` 是否保留当前模型；Q23 Hub 崩溃时在途回合的进程组能否由新所有者确认已结束。

**实施归属**（终稿第 17 节；用例 ID 以终稿为准，登记进 `plan/test-cases.json` 后由设计检查核对）：

| 本契约的部分 | 任务 | 主要用例 |
|---|---|---|
| R3.6 的 P0 修复：推进规则、命令识别前移、来源过滤、`runtime.ts:438` 与 `state.ts:392`、unsafe 结束时待决切换 failed、“只发这条消息” | G067 | G067-C01–C07 |
| 契约类型、`binding.relay`、`switch.*`、解析器、`assertSessionTransition` 的无效样例 | G066 | G066-C06 |
| R4 的状态 × 事件全表、R8 的核对计划、R9 的重发、R10 的 `recoverRelay` 与 D6 | G068 | G068-C01–C10、G068-P01 |
| R2 与 R5 的 Driver 声明、`classify`、`deliveryPosition`、`verifyDelivered`、`BackendResult.native`、`userTextOf`、`setTitle` | G069 | G069-C01–C09 |
| R1 的 admit、prePlan、finalize、settle，R8 的返回决策与费用估算，S5 | G072 | G072-C01–C11、G072-P01、G072-S01 |
| 分隔线、交接卡、三选一、S5 按钮、错误码与 HTTP 映射 | G073 | G073-C01–C07、G073-S01 |
| RelayConformance P1–P16、故障矩阵与 K1–K18 | G074 | G074-C01、G074-C02、G074-R01–R03 |
