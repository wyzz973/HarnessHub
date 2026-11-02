# 第三轮红队发现处置表（v2-dispositions）

对象：[v1-architecture.md](v1-architecture.md) 的五份红队审查 [RT1](rt1-invariants-storage.md)、[RT2](rt2-failure-races.md)、[RT3](rt3-performance-cost.md)、[RT4](rt4-security-privacy.md)、[RT5](rt5-native-fidelity.md)，共 105 条；另附原型测量 [spikes/relay/README.md](../../../../spikes/relay/README.md) 的 F1–F12。处置落实在 [v2-architecture.md](v2-architecture.md)（下称 v2），“节”列指 v2 的节号。作者：总架构师 Fable 5.1，2026-11-03。

处置取值：**修正**（按发现的修正意见或等价方案改了设计）、**部分修正**（采纳了一部分，未采纳部分写明理由）、**反驳**（有证据不改）。规则：blocker 与 major 必须修正或有证据反驳；minor 视情况处理。本轮没有整条反驳；8 条部分修正的未采纳部分在“理由”列写明，并汇总在 v2 第 19 节。

汇总：修正 97、部分修正 8、反驳 0（RT1 28/1/0；RT2 24/1/0；RT3 14/1/0；RT4 16/2/0；RT5 15/3/0）。

## RT1 · 不变量、存储与迁移（29 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| RT1-B1 | blocker | 修正 | 14.4、7.6 | “携带回合”改为六个条件同时成立（来源非空、无 `native_command`、有 `run.dispatched`、reason 非 `request_rejected`/`model_not_applied`、状态非 unknown/cancelled、不晚于 `throughRunId`）；水位取来源 Run 的 `run.ended` seq 最大值；R0b 在 v12 的 `run.ended` 事件里保留 `input` 与 `contextEffect` 供迁移直接取证；属性测试“迁移后 mark 不超过真实送达”。发现成立：现状 `context_prepared` 在 prepare 之前提交（`runtime.ts:1341`），命令回合也带非空来源 |
| RT1-B2 | blocker | 修正 | 14.4、7.4、4 | 导入与分支绑定（ready、fork-pending、forking）一律 `originIncluded=true`、`synced{0, origin}`；`resumed:false` 起点只用于其余绑定；archived 绑定的 `relay` 冻结（白名单相应放宽）；清空命令迁移为 `fresh{user_cleared, floor}`、`nativeEpoch=2`，不再推成 suspect；每种绑定来源各一个 v12 夹具 |
| RT1-B3 | blocker | 修正 | 2、7.5、7.2 | `nativeEpoch` 在同一会话同一 (harnessId, controlId) 的全部绑定（含 archived）上单调递增，重建取 max+1；§7.5 的“从 1 起”改为“max+1”，与 §7.2 一致；`executedOn` 不必再加绑定代次（纪元已足以区分）；属性测试“任意 reset/clear 序列后 need 覆盖原生会话缺少的全部回合” |
| RT1-B4 | blocker | 修正 | 4、6.3、7.4、18.2 | `fresh` 增加 `floorSeq`；need 取 seq > max(mark, floor)；“附上交接单”是一次性的 `relay.attach:"full"`，只对那一条忽略 floor；§6.3 伪代码写出该分支；J3 M2 的处置改回“恢复 J3 原意”；两条测试（清空后 20 轮原样；A 清空 → B 两轮 → 回 A 只补 B） |
| RT1-B5 | blocker | 修正 | 2、7.1、7.2、19 O6 | 外来事实只取“已派发 ∧ 终态 ∧ executedOn ≠ (X, e)”的 Run 与 origin；本绑定 not_recorded 的回合对本绑定只提示“没有发出”；对其他绑定它是外来事实，原话注明“没有送达任何 Harness”；INV-30 的验证补上五种合成结果 |
| RT1-B6 | blocker | 修正 | 14.1、6.4、4、14.3 INV-35 | 所有上限在应用层按序列化字节校验与截断，CHECK 只作 bug 断言；钉住按字节 ≤2,048（界面写 ≤680 字）；观测只存 ≤1,000 项并记 partial；RunDigest 定义全局收紧次序 `bound`（原型 F8 实测收紧后 29,790 B）；approvals ≤16；派生行在 SAVEPOINT 内；故障注入三例都不得让 Store 进入 failed。RT1 的实测（700 个汉字 2,100 字节触发 ERR_SQLITE_ERROR）与 `sqlite-store.ts:626` 的 `this.failed` 路径成立 |
| RT1-B7 | blocker | 修正 | 7.5、14.3 INV-14 | 精确分支另加条件：源绑定 synced 且 need(through)=∅；源绑定 pending 或 suspect 时不做原生分支；不精确时 `fresh{new}`，来源历史作最旧一层 |
| RT1-M1 | major | 修正 | 2、6.3、14.4 | 定义“事实 seq”= Run 的 `run.ended` seq（串行全序），origin 取 0；水位取已纳入事实的最大 seq，不取 lastSeq；`relay_packets` 写入时校验 fold 单元已终结且用户消息早于当前输入（替代 K7）；属性测试按 K6 交错序列生成 |
| RT1-M2 | major | 修正 | 6.1、14.2、9 S15 | E1 所在事务同时把送达行改为 recorded(E1)、绑定改为 synced；恢复时 `coordinator.recover` 先看送达表，送达表作为唯一权威 |
| RT1-M3 | major | 修正 | 4、7.2、6.4 | `pending{prior, packetId, range, autoResends, manualResends}`；§7.2 改为状态 × 事件全表（含 fresh 不带包回合、autoResends=1 时的内容回合、reanchor 清零、增量附要点仍是一个包）；resend 重渲染当前 need；pending 判 absent 前先做压缩分类；压缩证据独立于 64 条活动上限单独计数（`activities.compactionCapped`）；“五态”笔误改为四种 kind；属性测试以假 Harness 的原生历史为参考模型 |
| RT1-M4 | major | 修正 | 6.4、4、14.3 INV-22 | 摘要只由已提交的事实生成（消息取快照，工具详情只取已落库的），其余 `detailsMissing`；清单与摘要记录秘密集合的 HMAC（`secretSetHmac`、`redaction.setHmac`），不同时只标 behind 不写入 |
| RT1-M5 | major | 修正 | 4、6.3 | 摘要只存本 Run 的计数（`RunDigestIndex.counts`，13 类），前缀和在读取时对 ≤256 行现算；恒等式增加“未统计”类别并写入清单 |
| RT1-M6 | major | 修正 | 5.5、14.1、9 S15 | ID 由最终正文派生（占位符渲染 → sha256 → 替换）；清单逐项列出全部渲染输入（含当前输入 HMAC、观测 seq、预算、编辑与放行、kind、base、supersedes、policyVersion、语言、摘要状态、脱敏上下文）；清单头相同而字节不同在事务前检出，只让本 Run 以 `RELAY_PREPARE_FAILED{render_mismatch}` 失败；S15 改写，不再承诺“相同 ID 与字节” |
| RT1-M7 | major | 修正 | 6.1 | finalize 顺序固定为 open → checkpoint/binding_prepared → 命令分类（前移到 authorized 之前） → 附件检查 → 核对 → 渲染 → 同一事务提交；命令回合不写交接单行与送达行 |
| RT1-M8 | major | 修正 | 6.1、10.4 | 受理时（`admit`）按 Driver 声明的厂商键（目录缓存 + 上次 authKind）预检同意，缺则同步 409；脱敏与渲染仍在 finalize（它们需要观测与 open 后的窗口），但失败只让 Run 失败、不启动第二个会话的风险由“open 之前已确认同意”消除；只有取不到厂商键时才按 `unknown:<harnessId>` 先问 |
| RT1-M9 | major | 修正 | 14.1、10.4、4 | 新增安装级 `relay_log`（自带 seq、`command_id` 唯一、只追加，触发器禁止 UPDATE）；会话事件只作镜像；交接单记录 `consentLogSeq`；放行记录与它支撑的 `context_prepared` 同事务或更早 |
| RT1-M10 | major | 修正 | 14.4、19 | 降级说明改为“恢复备份即回到升级那一刻，升级之后的对话、Run、消息丢失，引用的内容 7 天后回收”；不丢数据的降级导出不做（理由见 v2 第 19 节），作为非目标写明 |
| RT1-M11 | major | 修正 | 7.3、7.2 | `lastPacketId=null`（legacy、origin、native）时跳过核对，视为 synced，直到本纪元出现第一份 v13 交接单 |
| RT1-M12 | major | 修正 | 10.2、14.3 INV-29 | INV-29 只覆盖出境字节、`relay_*` 表、`relay_log`、接力事件、日志与诊断、错误信息；公共事实按设计逐字保存，不在范围内；relay 字段里的指纹改用 HMAC |
| RT1-m1 | minor | 修正 | 14.1 | 列出全部代码点：`sqlite-store.ts:276、:456、:457–467（v0 须直接建 v13 含 relay 表）、:656/:674、:136–139`；`state.ts:279` 与 `:95、:151、:165、:197、:228` 白名单；`runtime.ts:271、:331、:440` |
| RT1-m2 | minor | 修正 | 14.1、9、11.1 | `relay_bodies` 主键改 (session_id, sha256)，随会话删除路径（v13 新增 `deleteSession`）回收；正文结构上界 64 MiB/会话，触顶错误码 `RELAY_PREPARE_FAILED{storage_quota}`；观测行 ≤1,000 项（≤128 KiB）；不可变表加 BEFORE UPDATE 触发器，送达转换加触发器与 CHECK；快照增量上限改为 ≤512 / ≤320 B |
| RT1-m3 | minor | 修正 | 14.3 | `run.relay` 与 `contextReadyAt` 纳入 `state.ts:448`；归档绑定的 `relay` 不变；回合外 `usage_update` 只写 `relay_windows`；跨存储引用在 Store 写入时校验 |
| RT1-m4 | minor | 修正 | 14.3 INV-14 | 原生纪元条件只用于分支精确性；配置承接（ADR-028）仍按选择纪元（`state.ts:393`），避免“先 /model X 再 /clear”退回 selection 模型的 K14 回归 |
| RT1-m5 | minor | 修正 | 14.1、4 | 摘要主键加 `policy_version`；清单记录附言是否包含（附言正文在正文里即可重建）、秘密集合 HMAC、`digestBehind`、`detailsMissing` 回合 |
| RT1-m6 | minor | 修正 | 14.1、7.3、11.2 | 送达行加 `decided_at`、`verify_ms`；“A.chain 末 4 个标记”改为“本纪元最近 ≤4 份 recorded 交接单的位置与标题行”；legacy 的 chain 取 sha256("") |
| RT1-m7 | minor | 部分修正 | 14.4、19 | 采纳：迁移按 seq 直接扫描 events 表、不走分页读快照；WAL 加备份约两倍库大小写进 ADR-049 补充；是否按会话分批在 ≥1 GiB 合成库实测后定。未采纳部分：Q6 的“首次打开时惰性推算”本就与 `:154`、`:424` 冲突，RT1 自己也指出，本版直接否决而不是保留为备选 |
| RT1-m8 | minor | 修正 | 9 S14、8.2、15 | S14 改写：查看器被杀后绑定 unconfirmed，`runtime.ts:1336` 在 open 前就抛 NATIVE_STATE_UNCONFIRMED，“下次 open 回放”不可达；v2 按 blocked + 用户在原程序确认 + native-reset；只读核对打开放 v1.1 并需 ADR |
| RT1-m9 | minor | 修正 | 14.4 | 断言改为“relay 行中没有 `ContentRef` 形状的对象”，不用 `content-` 字面匹配 |
| RT1-m10 | minor | 修正 | 4、14.4 | `acknowledgedUnknown` 的每个 ID 须是 status=unknown、`cleanup.closed=true`、用户消息早于 `requestedSeq` 的 Run，且只能出现在恢复切换上；J1 M9 的基准分新旧会话报告 |

## RT2 · 故障、竞态与恢复（25 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| RT2-01 | blocker | 修正 | 2、7.5、7.2、14.4 | 同 RT1-B3：纪元跨绑定单调、重建取 max+1；迁移按 `binding_prepared{resumed:false}` 与 `branch_requested` 切分谱系；属性测试采纳 |
| RT2-02 | blocker | 修正 | 6.3、7.4、12.4、14.3 INV-30 | plan() 首行 `need=∅ ∧ ¬reanchor → raw`，need 以 floor 为下限；`relay.attach` 进请求、命令指纹与 `PublicRun.relayRequest`；INV-30 改为“外来事实为空（含清空后未选附上）时逐字节相同” |
| RT2-03 | blocker | 修正 | 2、7.1、7.6、17 R0b | 外来事实限定为已派发 ∧ executedOn ≠ (X, e) 的终态 Run 加 origin；未派发与命令回合永不触发交接；P0 规则改为 `input≠not_recorded ∨ isCommand`；`runtime.ts:1337–1339` 排除未派发回合；重试时草稿不叠加（同一句原话只出现一次）；INV-30 测试逐一加入这些回合 |
| RT2-04 | blocker | 修正 | 9 S5、14.2、14.3 INV-21 | unsafe 的 `run.ended` 同一事务把待决切换记 `failed{SWITCH_SOURCE_UNKNOWN}`、等待它的排队 Run 记 `SWITCH_NOT_EFFECTIVE`；集成测试“宽限到期后仍能 resume”。发现成立：`runtime.ts:1490` 保留 pendingSwitchId，`:747` 拒绝恢复 |
| RT2-05 | blocker | 部分修正 | 4、8.1、9 S14、8.2、15、19 | 采纳：能力声明 `execution: process ｜ gateway`；gateway 型的 unknown 不以查看器退出作静止证据，租约不交给他人、拒绝恢复直到网关侧确认；`unknown_execution` → unknown，拒绝准入与 `NATIVE_GATEWAY_UNAVAILABLE` → not_recorded{gateway_refused}；J3 R-7 进 Q21 并加探针。未采纳部分：unconfirmed 绑定的“只读核对打开”不进 v2，放 v1.1 并需独立 ADR——它改动 INV-11 的恢复路径，且需探针证明只读打开不会触发网关回合；v2 的确认手段是用户在原程序里操作后 native-reset |
| RT2-06 | major | 修正 | 9 S15、14.2、6.1 | `recoverSession` 调用 `coordinator.recover` 返回 relay 变更，在 `claimAndRecover` 同一 BEGIN IMMEDIATE 写入（无 dispatchedAt → not_recorded{never_dispatched} 且绑定回到 prior；否则 unknown{owner_ended}）；E1 提交同时改送达与绑定；删去“相同 ID 与字节”；文案按 queued 与非 queued 分开；K5–K14 后只能分支或关闭写进 S15 与 G056 |
| RT2-07 | major | 修正 | 4、7.2 | `pending{prior, packetId, range, autoResends: 0｜1, manualResends}`；not_recorded 回到 prior；手动“再附一次”走 `relay.resend` 并计 manualResends；属性测试覆盖 prior 的每种取值 |
| RT2-08 | major | 修正 | 6.1 | 顺序定为 open → binding_prepared → models() 识别命令 → 附件检查 → finalize → authorized → dispatched；命令回合跳过预算与组包（含 `/clear` 不做预算检查）；证据只作用于实际携带的 packetId；绑定写入一律基于 `current` 合并 |
| RT2-09 | major | 修正 | 7.1、7.4、4、8.1 | 只有窗口覆盖派发位置且派发后未见压缩时 absent 才有意义，且 absent 也只记 `unknown{absent}`，除非 Driver 另有插入前失败证据；Claude 按派发时字节偏移查、OpenClaw 从 `before` 翻、Codex 按 clientId；OpenCode 声明 `lateDelivery`，取消后不自动重发；允许 not_recorded → recorded 的纠正（触发器放行）；只匹配本回合派发的第一段文本的标题行，用户粘贴的框架行不在派发位置之后的首条用户条目里 |
| RT2-10 | major | 修正 | 6.3、7.4、14.1 | 重发时重新渲染全部 need（P1 的单元 + P1 之后的外来事实），`supersedes=P1`，开头带去重行；`lateDelivery` 的 Driver 不自动重发；“重发复用同一正文”改为同一会话内按 sha256 去重（内容相同时自然复用） |
| RT2-11 | major | 修正 | 3.2、6.4、14.1、14.3 INV-35 | 领域层按序列化字节校验上限；派生行放 SAVEPOINT，失败只记 behind；ID 冲突改为本 Run 的 `RELAY_PREPARE_FAILED{render_mismatch}`，在事务前检出；权威行写失败也只让本 Run 失败（事务内只剩 INSERT）；三种故障注入只影响本 Run；ADR-014 第 2 条写进硬约束 |
| RT2-12 | major | 修正 | 5.5、4、6.4 | ID 由最终正文派生；清单记录当前输入 HMAC、语言、摘要状态；LRU 只缓存与输入、观测无关的分节并按语言分键；“预取命中 ≤2 ms”改为 finalize 拼接 p95 ≤5 ms |
| RT2-13 | major | 修正 | 5.3、6.2、6.3、19 O3 | 用户原话单独预算 U：开场与最近 k 条逐字（从新到旧），其余按轮次区间计数；放不下时先撤回复文字；永不因历史长度 blocked；属性测试“任意档位与 kind 下 ≤256 Run 不出现 blocked” |
| RT2-14 | major | 修正 | 5.1、9 S5、16 S5 | 状态节与审批节由 `permission.decided/submitted/closed`、`backend.status`、stop 与 settled 的事件先后推出；增加“停止请求晚于完成”的标注；不再写死“批准没有给出” |
| RT2-15 | major | 修正 | 7.5 | 同 RT1-B7：精确分支要求源绑定 synced 且水位覆盖 through 之前的全部外来事实；源绑定 pending 时不做原生分支 |
| RT2-16 | major | 修正 | 8.1、7.1、9 清理表 | v2 把 OpenCode 的 verify 声明为 none（`costly` 删除）：finalize 内已持租约，`factory.prepare` 再获取会报 WORKSPACE_BUSY（`workspace-lease.ts:110`），Driver 方法也拿不到 launch；无租约 probe 的方案不采用（会启动用户的 MCP 与插件，且结算路径多出 ≤5 s） |
| RT2-17 | major | 修正 | 6.1、9、12.4 | 受理时能判定的以 `409 RELAY_CHOICE_REQUIRED{binding, cause, options, counts}` 同步失败、不建 Run；只能在 open 后发现的让 Run 以同一错误码在派发前失败，租约与进程随 Run 结束释放，草稿保留；选择经 `relay.native` / `relay.attach` 进入下一次请求；不实现“等待”状态 |
| RT2-18 | major | 修正 | 6.1、10.4 | 受理时按上次观测与目录缓存预检并 409；finalize 用 open 后观测复检，不符 `RELAY_CONSENT_REQUIRED{vendor_changed}`；`run.dispatched` 事务内再读同意，已撤回就不派发 |
| RT2-19 | minor | 修正 | 4、12.4 | `RelayRequest` 持久化到 `PublicRun.relayRequest` 与 `message.accepted`，有选项时扩展命令指纹 |
| RT2-20 | minor | 修正 | 14.1、6.1、6.4、9 | `relay_bodies` 加 session_id 主键并随 `deleteSession` 回收；预取只读已落库的观测；观测在 prepare 获取租约之后、与 initialize/open 并行；S5 的“边界观测”如实写为下一条消息派发时的观测 |
| RT2-21 | minor | 修正 | 14.2、4 | E1 落库前先冲刷打开的文字窗口；`input_recorded` 不设置 `firstOutputAt`；ADR-047 第 5 条补一条修订；earlyClose 时 E1 并入 `run.ended` |
| RT2-22 | minor | 修正 | 6.4、4 | 同 RT1-M4、M5：只用已落库的详情并标 `detailsMissing`；前缀和在读取时求和 |
| RT2-23 | minor | 修正 | 5.4 | 来源说明三种变体：另一家 / 同一家的另一个会话 / 多家（超过 3 家加“等”）；模型未知去掉“，模型 …” |
| RT2-24 | minor | 修正 | 4、6.3、6.4、8.1 | 增量可附要点小节（仍是一个包，`reanchor` 标志）；need=∅ ∧ reanchor → `brief` 包；pending 遇 compact 先做压缩分类再判核对结果；`contextEffect` 可按参数判定（OpenClaw `/reset soft` → compact） |
| RT2-25 | minor | 修正 | 5.1、9 S7、16 S7 | 按 ADR-036 下其他对话的回合时间窗归属为“另一个 HarnessHub 对话”；文案“可能来自你的编辑器或另一个 HarnessHub 对话” |

## RT3 · 性能与成本（15 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| RT3-P01 | blocker | 修正 | 5.3、6.2、6.3、19 O3 | 用户原话预算 U 按档位与包类型（标准 2,500 / 精简 1,500 / 只交目标 1,200 / 增量 1,000 / 要点 400）；填入顺序开场 → 钉住与附言 → 从新到旧；增量不含开场；`RELAY_INPUT_LIMIT` 只在“框架 + 当前输入”超过通道或窗口最小值时出现并在 prePlan 判定；J3 M8 改写；属性测试。实测依据：原型 3f 字面必含块 83,112 token |
| RT3-P02 | blocker | 修正 | 6.2、6.1、19 O2 | need=∅ ∧ ¬reanchor 先原样发送、不进 chooseBudget；硬上限只保留通道与窗口；费用与时延只在标准/精简/只交目标间降档；悬崖只在 `contextUsed < cliff ≤ contextUsed + S_new + 1.2T + 2k` 时降档，已越过的不降档、按悬崖价提示；窗口未知且本地/未知 Provider 按 32k；订阅或认证未知不用美元上限；属性测试与“原样路径不调用 chooseBudget”断言。RT3 1.4 的 capCost 表与原型 6.2 的预算向量（Haiku 返回 hardCap −6,000）证实第一版会 blocked |
| RT3-P03 | blocker | 修正 | 7.1、7.3、7.4、8.1、13.3 | 按位置核对：Claude 派发前 stat JSONL 字节长度并在 open 时缓存路径；OpenClaw 用 `before`；Codex 用 clientId；核对只读位置之后的首条用户条目；窗口未覆盖 → `unknown{outside_window}`；只有位置存在且是另一条用户条目才算 absent（且 absent 也只到 unknown）；RelayConformance P11；verifyMs 目标本机读 p95 ≤20 ms、RPC ≤300 ms |
| RT3-P04 | blocker | 修正 | 14.1、4、9、14.3 INV-35 | 所有 relay 行进入事务前用 `Buffer.byteLength` 校验并按字段字节预算截断；观测只存 ≤1,000 项（改动优先）另存计数与指纹，越界记 partial；relay 写入失败映射为本 Run 的 `RELAY_PREPARE_FAILED`，不进入 `fail()`；三种测试（2 万文件非 git、5k 未跟踪文件、字段打满的中文摘要）交接照常完成 |
| RT3-P05 | major | 修正 | 4、6.3、6.4、11.1、14.1 | `relay_digests` 增加约 200 B 的 `index_json` 窄列放在 `digest_json` 之前，含尺寸三元组（两种语言）、13 类计数、G3 所需字段；定档只读索引，只对 G1/G2 单元读整条摘要；懒重建分两级（G3/区间行只用快照 `PublicRun.tools`，尾部与锚点读详情）；目标改为定档 p95 ≤2 ms、组装+脱敏+哈希 p95 ≤10 ms、额外堆 ≤8 MiB（RT3 建议 ≤4 MiB，本版取 8 MiB：原型未测堆，待 R4 基准后再收紧）；合成生成器含打满上限的摘要 |
| RT3-P06 | major | 修正 | 6.4、12.1 T2/T3 | 预取只缓存与输入、观测无关的分节；finalize 拼接首行与状态、文件节并算 ID，p95 ≤5 ms；选择器只定档不渲染，每次打开总 CPU ≤20 ms、分片、候选 ≤8；卡片写明“状态与文件改动按发送时的工作区生成” |
| RT3-P07 | major | 部分修正 | 11.1、6.1、10.6、19 | 采纳：新增“接力造成的受理→派发增量”目标（新启动 p95 ≤ max(0, 观测 − 启动) + 15 ms；复用进程返回 p95 ≤50 ms），零延迟假 Harness 测量并断言 load 次数；HEAD 与 `.git/index` mtime 未变且 ≤60 s 复用观测；核对按位置；`costly` 删除；E1/E3 已定论时 `run.ended` 不等 after_turn；finalize 复用 prePlan 的快照。未采纳部分：“用户开始输入时就启动观测”——此时没有 Run、没有租约、没有所有者（INV-26；RT2-20 同样指出预取时的观测无所有者） |
| RT3-P08 | major | 修正 | 7.1、7.2、5.4、14.3 INV-30 | 新增 native 证据：fresh 绑定执行过不带包、need=∅ 的内容回合且 recorded 或有 agent 输出 → `synced{basis: native}`；回到 A 发 delta；无基准增量附全部约定（原型 d1 实测 1,095 token，有基准 642）；goals 只取外来 Run 的原话；INV-30 改为“外来事实为空时逐字节相同”。与 RT5-03、原型 F4 相同 |
| RT3-P09 | major | 修正 | 6.2、11.1、13.1、5.4 | est/2：每个模型族一组四系数（字母数字与空格、其他 ASCII 符号、CJK、其余字节），非负最小二乘在 RelayBench-X 交接单语料上拟合、留出集验证 p90 ≤20%；接近 hardCap 按 est × (1+e90)；校准工具写明（o200k 离线、`count_tokens` 独立凭据、DeepSeek 分词器文件）；系数版本进 `policyVersion`；文中样例数字标注“由 CI 重算”；框架目标改按 o200k ≤420 token（第一版中文实测 368） |
| RT3-P10 | major | 修正 | 4、7.3、11.1、12.3 | 每个包在窗口关闭时把实现值 R、k 以计数写入 `relay_deliveries.realized`；R̂、k̂ 取同一（harness、模型族、认证类别）最近 50 个实现值中位数，n<20 用 R=80、k=0 标“先验”；只用于显示与降档建议；判“热”用 now − endedAt < 0.8·TTL；T0 的“$0.06、+1.5 s”改为按公式的 $0.115、+2.9 s |
| RT3-P11 | major | 修正 | 11.1、13.3 P10 | 缓存指标改为：交接回合 cacheWrite − 配对无交接首回合 ∈ T±20%；TTL 内后续回合 cacheWrite ≤ 新增输入 + 512；与原生会话配对的占比差 ≥ −0.05；0.85 只作参考 |
| RT3-P12 | major | 修正 | 11.1、6.2 | 回归设计 T ∈ {0, 2k, 4k, 8k, 16k}、每档每模型族 ≥30 个随机顺序新会话、测派发到首个任意事件；验收 T_标准 × 斜率 95% 上界 ≤1.5 s；P̂ 用离线值标注日期；capLatency 用离线 P̂ 表而不是生产 `firstOutputAt` |
| RT3-P13 | major | 修正 | 6.4、11.1 | `run.ended` 内只对要存储的字段（≤48 KiB）脱敏；size 用脱敏后文本算并留标签余量；目标按原型实测校准：典型 p95 ≤2 ms（实测 0.578）、最坏输入 p95 ≤3 ms（实测 1.779）、p99 ≤8 ms；最坏输入微基准进 CI。RT3 指出第一版引用的 0.06/0.75 ms 是插入耗时不是抽取——成立，本版改引原型 1a–1c |
| RT3-P14 | minor | 修正 | 11.1、14.1、9 | 上限改为绑定 ≤512 B、Run ≤320 B，用最长 ID 断言；`relay_bodies` 主键 (session_id, sha256)，删除会话同一事务回收；结构上界 64 MiB/会话作硬上限、触顶只让本 Run 失败；R1 的快照缓存按字节设上限（≤96 MiB）并写进 11.1 |
| RT3-P15 | minor | 修正 | 6.1、14.2、11.1 | `run.context_prepared` 与 `run.authorized` 合并为一个事务（`state.ts:448` 允许 preparing → running 的同一次变更设置 contextThroughSeq）；基准断言提交次数等于现状减一 |

## RT4 · 安全与隐私（18 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| RT4-B1 | blocker | 部分修正 | 10.1、9、14.3 INV-36、15、19、20 Q9 | 采纳：启动时与每次 `admit` 按 realpath（含符号链接与反向包含）检查数据根、HMAC 密钥与工作区互不包含；包含时跨厂商交接受理即 `409 RELAY_UNAVAILABLE{data_root_in_workspace}` 并提示用 `--data-dir`；观测排除数据根与 `.tmp/`；“未包含”一节不再提存放位置；WS-05。未采纳部分：本稿不改默认数据根——这是 CLI 默认值与现有部署（4317 服务）数据位置的变更，需迁移说明与独立 ADR（Q9）；v2 先保证包含时不出境 |
| RT4-B2 | blocker | 修正 | 10.2、14.3 INV-29 | 集合改排除法四类：Hub 交给任何绑定的全部值（减 `nativeBaseValues` 白名单与路径/数字/布尔/无用户信息 URL）、`referencedNativeValues` 引入的值、Hub 自身环境中匹配凭据规则的值、受管 Provider 秘密；长度下限 6；熵规则加十六进制分支（排除 git 对象 ID 语境）；集合 HMAC 写进清单；RD-01、RD-02 |
| RT4-M1 | major | 修正 | 5.2 N19、10.2 | 顺序改为：换行规范化 → 删 C0 → 脱敏（骨架视图，每个条目原文 ≤64 KiB，窗口两侧各 8 KiB 余量）→ 截断（切点落在命中区间之外、去残片）→ 可见化 → 围栏；单条目超限只省略该条并记 `unscanned`，只有扫描器抛错才 fail closed；出境前对最终正文再扫一遍；形式扩到任意 scheme 的 `user:pass@`、百分号大小写、`\uXXXX`、`'\''`、折行（base64 与 HTML 实体不承诺，原型实测仍漏）；RD-03–RD-05 |
| RT4-M2 | major | 部分修正 | 10.2、14.3 INV-29、4、20 Q19、19 | 采纳：INV-29 收窄为出境字节、`relay_*` 表、`relay_log`、接力事件、日志与诊断；`user.sha256`、`sent.sha256` 改为 HMAC 子密钥（非 git 内容哈希只作指纹不对应秘密）；凭据路径不计算哈希；grep 同时查 sha256(原值)、sha1、md5；RD-06 在 relay 范围内。未采纳部分：命令指纹 `sha256(JSON)` 迁移为 `hmac1:`——它是既有幂等机制且存在全部已有快照里，超出接力范围，登记为已知违例并建议独立 ADR（Q19） |
| RT4-M3 | major | 修正 | 4、5.5、14.1、14.3 INV-22 | 清单加 `redaction:{profile, rulesVersion, keyId, setHmac}`；脱敏上下文一变就换新 ID 并写 `supersedes`；ID 由正文派生后“同 ID 异 sha”不再可能，清单头相同而字节不同在事务前检出为本 Run 失败；INV-22 加“同一脱敏上下文”前提；RD-07 |
| RT4-M4 | major | 修正 | 5.2 N4、5.4、10.5 | 〔〕只留给 Hub，英文模板也用〔〕；不可信内容中〔〕→［］、`<<<` → `‹‹‹`；先 NFKC 与 UTS #39 混淆骨架映射再按“包含”匹配；全部模板（中英、packet/delta/brief/resend）的标记行一张表；导入只认 ID 与正文都一致的包（RT4 M10）；IN-01。原型 4c 的 5,744 + 3,329 例证实第一版缺口 |
| RT4-M5 | major | 修正 | 5.2 N1–N2、10.3 | 凡 Cc（\t、\n 除外）、Cf、Co、Cs、Cn、Zl、Zp 或 Default_Ignorable 的码点一律改写为 `‹U+XXXX›`；先把 U+2028/2029/0085 统一为 LF 再执行行规则；两个转义器共用同一张表并对全部码点做属性测试；IN-02。原型 4c 的 8,519 例残留证实 |
| RT4-M6 | major | 修正 | 5.1、5.4、5.6、10.3 | Hub 口吻的节只写结构化值（退出码、路径、计数、状态），不解析输出里的数字；外来字符串放带作者的引用槽「…」；审批写作“{来源} 请求批准「…」”；增量包与要点包都带 HH-DATA 区；钉住校验 quote 是原消息子串并标作者；模型名限定字符集；约定 6 扩展到「」与反引号；S1 与增量样例按此改写；IN-03–IN-05 |
| RT4-M7 | major | 修正 | 10.6、13.3 P12、20 Q8 | 环境只保留 git 路径、`HOME=<空目录>`、`LC_ALL=C`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_CEILING_DIRECTORIES`；先只读列出 `filter.*` 驱动名，对每个传 `-c filter.<n>.{clean,smudge,process}= -c filter.<n>.required=false`，另加 `--attr-source=<空树> -c core.attributesFile=/dev/null -c core.hooksPath=/dev/null`；include 时退回 tree 并记 partial；toplevel 须等于工作区、gitdir 在工作区内否则拒绝；工作区为 `/`、`$HOME` 时不扫描；LFS 记未核验；WS-01–WS-04；`process=` 与 include 场景列为待实测。原型 F3 实测（clean 过滤器 2 次、`--attr-source` 挡不住 `.git/info/attributes`、`-c filter.<name>.clean=` 有效）证实 |
| RT4-M8 | major | 修正 | 4、10.4、8.1、19 | 厂商键由 Driver 按机制声明：account/api_key 且无 `*_BASE_URL` 才按模型推断；external → `aws-bedrock` / `google-vertex`；gateway 或 base URL → `gateway:<host>`；无法判定 → `unknown:<harnessId>`；只有 Driver 报告回环端点才豁免本地；路由方 `router:<名>`；`allow` 不覆盖 `unknown:*` 与 `gateway:*`；CS-01、CS-02；P14 探针（本条与 RT5-12 的“Claude 固定 anthropic”冲突，本版采 RT4） |
| RT4-M9 | major | 修正 | 10.4、16 S10、14.3 INV-33 | 本纪元内收过包的绑定，请求的或观测到的厂商键 ≠ `consentKey` 时派发前 blocked［同意］［新开原生会话］［取消］并记 `relay.vendor_changed`；撤回后返回 A 且有增量 → blocked［只发计数通知］［重新同意］［native-reset］；撤回时作废待发重发与 LRU；CS-03、CS-04 |
| RT4-M10 | major | 修正 | 7.5、10.5、16 S9 | 只有用户自己输入的文字算 user_text；资源原文与命令展开记 external_output/harness_text；判定 Hub 交接单须 ID 在本安装 `relay_packets` 且字节与正文一致；不满足的转义并标“导入，未核实”；IM-01 |
| RT4-M11 | major | 修正 | 10.5、9 | 某行出现交接单 ID（含转义形式）或本回合所发正文中任意 ≥16 字的行（Aho–Corasick）即隐去该行及续行；诊断接入 `SecretScannerPort`；接力代码异常固定文案，`JSON.parse` 片段不进 `run.error`；DG-01、DG-02 |
| RT4-M12 | major | 修正 | 4、5.1、12.4、14.1、14.2 | 会话级 `relay.exclusion_added/withdrawn` 事件与 `relay_exclusions` 表，之后的包、预览和重发都遵守；用户排除优先于“不得省略”；`reveal` 改为按位置放行、标签只作校验；AP-02 |
| RT4-m1 | minor | 修正 | 10.2、5.5、19 O5 | 标签用 HMAC(安装密钥, "relay-tag/1" ‖ sessionId) 的会话子密钥；首行、附言与第二段同一种脱敏处理；措辞改“远端无法离线验证”；密钥文件 O_EXCL 0600、长度与权限不对即拒绝；清单记 keyId；RD-08 |
| RT4-m2 | minor | 修正 | 3.1、10.2 | 规则作为纯数据放进中立模块 `src/infrastructure/text/secret-rules.ts`，分 display / diagnostics / egress 三档各做变异测试；egress 不含诊断档的 ASSIGNMENT 与 PATHS；熵规则对所有类别生效但只匹配令牌语境 |
| RT4-m3 | minor | 修正 | 4、10.1、10.4、12.1 T2 | 增加 `workspace_meta` 类别并计数；凭据路径补全（id_ed25519、*.pfx、.npmrc、.netrc、.git-credentials、.docker/config.json、kubeconfig、*.tfvars、terraform.tfstate、auth.json、.credentials.json）；读凭据路径的执行只计数；curl/wget/gh api/http 输出归 external_output；剥掉 `<think>` 块；首次跨厂商时 Enter 只展开说明 |
| RT4-m4 | minor | 修正 | 8.2、9 清理表、14.1 | shim 只读已脱敏、已获同意的物化正文；撤回先提交“停止供给”再留墓碑并删除文件；“随会话删除”落为 v13 的 `deleteSession`；`relay_bodies` 按会话主键回收；保留期写明 |

## RT5 · 原生保真与逐家可行性（18 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| RT5-01 | blocker | 修正 | 2、7.1、7.2、13.1 | 同 RT1-B5、RT2-03：外来事实只取已派发且 `executedOn ∉ {null, (X, e)}` 的终态 Run 与 origin；未派发、本绑定 not_recorded 与命令回合永不使 need 非空；其原话只在本来就组包时进“用户原话”并注明“没有送达任何 Harness”；§7.2 该格改写；20 轮假 Harness 断言 |
| RT5-02 | blocker | 修正 | 4、6.3、7.4 | 同 RT1-B4、RT2-02：`fresh{user_cleared, floorSeq}`；need 下限 `max(mark ?? −1, floor ?? −1)`；“附上交接单”= 一次性 `relay.attach:"full"`；清空后其他 Harness 的回合照常补交；两条测试 |
| RT5-03 | blocker | 修正 | 7.1、7.2、5.1、5.6、16 S2 | 新增 native 证据与 fresh → synced 的边；INV-30 与 reanchor 前提改读 `packetsInEpoch`；“用户原话”节改为“自上次已知位置（送达或亲历）以来”；S2 按此改写（无基准增量约 1.1k token）；测试“A 开场 → B 两轮 → 回 A 断言 delta 且不含 A 的原话” |
| RT5-04 | major | 部分修正 | 5.1、5.4、8.1、13.3 P13、19、20 Q14 | 采纳：声明 `title: set` 的 Driver 在首个交接回合后用协议入口把标题设为公共标题（Codex `thread/name/set`、Claude `_session/rename`），OpenClaw `_meta.sessionLabel` 探针后；用户原话节移到阅读约定之前，使前 1,000 字以原话为主；结束行不用“交接”二字；P13 改为每家同一句原话（短、长各一）带／不带交接单各开新会话读原生标题比主题。未采纳部分：Hermes 用 `/title` 回写——它是用户可见的原生命令，Hub 代发等于在原程序里多出一轮用户没发过的输入，违反命令回合原样与不隐式改配置的约束；OpenCode、dsh 无入口留 Q14 |
| RT5-05 | major | 修正 | 4、7.4、8.1、5.5 | Driver 声明 `commands.grammar` 与 `hidden` 列表：Hermes 列注册表全部名字与别名（new/clear/reset → clear；compress → compact；undo/retry → rewind；queue/steer → keep 且 acceptsRelay；其余 none 或 unknown），R8 给 Hermes 的 `unlistedSlash: text` 改为 executed；Claude 列 clear/reset/new 与 `UNSUPPORTED_COMMANDS`，命令名语法 `^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$`，路径不是命令；输入以 `/` 开头且携带包时省略首行；E3 只对原生侧也不判为命令的回合成立 |
| RT5-06 | major | 修正 | 8.1、7.4、13.3 P6、20 Q1 | Claude 的 `/clear /reset /new` 由 Driver 合成（同 `/export`）：结束原生会话并 `session/new`，Runtime 归档旧绑定、新绑定 `fresh{user_cleared, floor}`；P6 证明前不声明持久清空，Q1 列为 P6 首项；不保留进程时从审批选项去掉 `exit-plan-clear-*`，保留时记为一次 clear；E2 先确认 JSONL 属于当前对话，否则 unknown |
| RT5-07 | major | 修正 | 4、7.1、7.4、8.1、6.4 | `verifyDelivered` 返回 present ｜ absent ｜ outside_window ｜ compacted ｜ unavailable；窗口覆盖派发位置且无压缩证据才判 absent，absent 也只降为 unknown；§8.1 加“压缩证据”列（Claude、Codex、OpenCode 有事件；dsh 无；Hermes 回放标记 `[CONTEXT COMPACTION — REFERENCE ONLY]` / `[CONTEXT SUMMARY]:`；OpenClaw 未核实）；通用：相邻两回合 `usage_update.used` 降 ≥30%（建议值）记推断压缩；suspect 分支同样先排除压缩 |
| RT5-08 | major | 修正 | 7.2、7.4、14.4 | 一切“派发前停下”以 need≠∅ 为前提；need=∅ 的 suspect 视同 synced 并记 `relay.verified{result:"nothing_owed"}`；无外来事实的绑定迁移为 `synced{basis: legacy}`；单 Harness dsh 会话升级后不再弹选择 |
| RT5-09 | major | 部分修正 | 9 S14、8.2、15、19 | 采纳：S14 改写为 blocked 直到网关侧确认；`verify ∈ {on_next_open, after_turn}` 的 gateway 型 Driver 的“核对后确认”（只读 open，回放显示该回合已结算且无未决准入时改回 ready 并计入 `foreignAfterLast`）作为 v1.1 的 P-R1/P-R2 与独立 ADR。未采纳部分：不进 v2——它改动 INV-11 的恢复路径，RT5 自己也要求独立 ADR 与探针；v2 的确认手段是用户在原程序里操作后 native-reset（与 RT2-05 同一处置） |
| RT5-10 | major | 修正 | 5.4、5.6、13.2 | 采用 RT5 的改写稿（来源说明三种变体、用户原话节前移、约定不引用节号、约定 4 写明可重跑检查、约定 5 去掉“已完成并已验证”、约定 7 要求归因、“未包含”结尾不提 HarnessHub）；增量框架不写 basePacketId；要点包只放逐字原话与 Hub 观测值，不摘句、不断言约束仍有效（C9）；英文逐条对译；H9 验证原话前移的代价 |
| RT5-11 | major | 修正 | 5.4 | 统计前去掉反引号内文本、URL、路径与以 `at `、`Error`、`Traceback` 开头的行；剩余汉字 ≥4 个或占比 ≥20% 选中文；否则看本会话全部用户消息；仍不定用界面语言；语言按“绑定 × 纪元”固定，除非最近 3 条用户消息都判为另一种语言 |
| RT5-12 | major | 部分修正 | 10.4、8.1、4、20 Q20 | 采纳：厂商键由 Driver 声明（dsh 固定 deepseek 除非有 base URL；Codex 取 `modelProvider`；OpenCode、OpenClaw 取“/”前缀；Hermes 取“:”前缀；删 `o*`；本地只在报告回环端点时豁免）；建会话前取 ADR-033 目录缓存，取不到时按钮写“厂商待确认”，open 后不同则派发前失败；同意文案采用 RT5 版本（含辅助模型与记忆的提示）；INV-33 写明辅助模型与记忆不在 Hub 可见范围；Q20 加探针。未采纳部分：“Claude Code 固定 anthropic、authKind 只作文案”——经 base URL、Bedrock、Vertex 或 gateway 登录时实际处理方不是 Anthropic，`allow` 会覆盖它们（RT4 M8），本版按机制区分 `gateway:<host>` / `aws-bedrock` / `google-vertex` |
| RT5-13 | major | 修正 | 6.1、9、12.4、4 | `POST …/messages` 加 `relay.attach: auto｜full｜none`、`relay.native: continue｜new`、`relay.resend`；需要选择时同步 `409 RELAY_CHOICE_REQUIRED{binding, cause, options, counts}` 不建 Run；同意在受理时判定缺则 409；open 后厂商变化 `RELAY_CONSENT_REQUIRED{vendor_changed}` 不派发；`public-api.md` 写明 `Run.relay.delivery` 在 Run 结束后仍会变并以 `relay.verified` SSE 与 ETag 通知 |
| RT5-14 | major | 修正 | 8.1、12.1 T0、15、4 | WorkBuddy 作为目标 `RELAY_TARGET_UNVERIFIED`（等级“无法接续”，只提供“只发这条消息”），直到至少一种正面证据（E2 或 E3）、命令语法与清空语义经 RelayConformance 证实；作为交出方不受影响；“最保守声明”不再等于可用 |
| RT5-15 | minor | 修正 | 12.1、12.2 | 只有 E3 的 Driver 收到第一条输出时改为“已开始回复，送达待确认”（只显示不推进）；仍未知时“已回复，但没有确认收到交接单；下一条消息会再附上一次”；详情栏改为“已同步到第 4 轮（实时确认）· 清空过 1 次 · 缓存 4 分钟前用过”；T3/T5 统一为会话内序号；T5“新会话”改“Codex 新会话”；T7“其中 1 个它改过”改“其中 1 个 Claude Code 之前也改过” |
| RT5-16 | minor | 修正 | 7.4、8.1、12.1 T2 | 交接后首条是命令时卡片写“这是 X 的命令，不会附上交接单；交接单会随下一条普通消息发出”；Hermes queue/steer 声明 acceptsRelay；OpenCode 配置命令提交即返回时状态节写“命令在后台继续运行，结果未记录” |
| RT5-17 | minor | 修正 | 4、7.4、8.1、20 Q10 | `contextEffect` 可按参数判定（OpenClaw `/reset soft` → compact；Hermes `/compress --preview` → none）；说“已清空”前需便宜的观察（OpenClaw `sessions.get` 见新会话、Hermes 回放为空、Claude 由 Driver 合成），否则按 suspect |
| RT5-18 | minor | 修正 | 3.2、5.5、8.1、4 | `TurnText` 增加 `firstLine` 标志由 Driver 组装；Hermes 声明 `pointersAfterUser`，指针附在原话段之后；Codex 对 `TurnText.user` 解析 `/skill:` 并组装“技能项 + 正文（去首行）+ 余下原话”；“只收一个 text”改为“Hub 只发一个 text”（`turn/start` 的 `input` 是数组） |

## 原型测量（spikes/relay）F1–F12 的处置

| 编号 | 处置 | 节 | 理由 |
|---|---|---|---|
| F1 必含块无条数上限 | 修正 | 5.3、6.3 | 同 RT3 P01：用户原话预算 U；`MUST_HAVE_CAP` 取消，改为 U 与框架、状态分别计 |
| F2 长离开的增量放不下全部原话 | 修正 | 5.3 | 增量 U=1,000（可扩到 2,000），其余按轮次计数并在“未包含”写明；不切换为 packet（增量的价值是只带新东西） |
| F3 观测命令执行仓库过滤器 | 修正 | 10.6 | diff 加 `-c core.fsmonitor=false`；先列驱动名再逐个传空值；`--attr-source` 与 `core.attributesFile` 只作补充；`process=` 与 include 场景由 WS-01 实测；进 RelayConformance P12 |
| F4 原始 Harness 返回得不到增量 | 修正 | 7.2、5.4 | 同 RT5-03、RT3 P08：native 证据与无基准增量框架（原型实测 1,095 / 642 token） |
| F5 转义集合缺口 | 修正 | 5.2 N2、N4 | 采用扩展集合（不可见字符全表、全部模板标记行、定界符变体）；框架约定 6 自身含 `<<<HH-DATA`，检查器对该行白名单 |
| F6 首行逐字前缀影响 Markdown | 修正 | 5.5 | 行首围栏改写为 `‹```›`、奇数反引号时加空行并改写孤立反引号；原生标题仍取原话本身 |
| F7 脱敏顺序 | 修正 | 5.2 N19、10.2 | 顺序改为换行规范化 → 删 C0 → 脱敏（骨架视图、8 KiB 余量）→ 截断 → 可见化 → 围栏；扩展形式采纳，base64 与 HTML 实体明确不承诺 |
| F8 逐字段上限之和超 64 KiB | 修正 | 4、6.4 | `bound()` 收紧步骤与全局次序写进类型（`RunDigest.bound`）；目标 ≤48 KiB，CHECK 65,536 只作断言 |
| F9 RunDigest 形状 | 修正 | 4 | narrated 改结构化（与语言无关）、size 按语言各一份、`commands[].tail`、13 类计数进索引、git 观测补 mtime 以支持“之后另有修改”、尺寸按脱敏后文本算 |
| F10 渲染成本主要在解析摘要 | 修正 | 4、6.3、14.1 | 索引列 `index_json`（同 RT3 P05） |
| F11 预算解析器语义 | 修正 | 6.2、5.3 | 不可信上限按比例缩放；悬崖不进 hardCap；`capWindow` 单一分支；est 的 factor 改为四系数并在 ceil 内；`byteCap` 按单位分别折算 |
| F12 存储增量小、提交耗时在应用层 | 修正 | 11.2 | 前置片目标与依据更新（SQL 层 9.0 ms vs 应用层 144 ms） |
