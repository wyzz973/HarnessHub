# RT1 · 红队审查：不变量、存储与迁移（第三轮）

对象：[v1-architecture.md](v1-architecture.md)（已通读）。2026-11-03，`cc/relay-design`，`src/` 与 `07a0825` 相同。对照：[简报](../00-brief.md)、[裁定](../02-round2-rulings.md)、[J1](../round2/j1-contracts-correctness.md)、J2 M3、J3 M1/M2、J4 M12、[R4](../round1/r4-internal-baseline.md) K1–K22。未运行 Harness，未碰 data/ 与 4317；唯一实测是在 scratchpad 用 Node 26.11.1 `node:sqlite` 内存库验证 CHECK 失败的错误形状。【事实】附出处，【推断】由事实推出，修正为建议；字节数为合成 JSON 推算。

## 0. 总评

骨架方向对得上代码：送达结论单独建表、终态 Run 不改写、contextThroughSeq 先于 running 提交、K19 双认、ADR-049 备份条件。问题集中在水位语义、迁移推断和用 CHECK 兜底长度。共 29 条（blocker 7、major 12、minor 10）；blocker 会丢增量、向单 Harness 对话注入或让存储停摆，先改 B1、B4、B5。

## 1. 发现

### RT1-B1【blocker】迁移把未送达的回合推断为已送达（§14.4）

- **场景**：v12 下 A→B→A，回到 A 后的首条输入是以下三种之一：
  - 目录内命令（R4 D1）；
  - 带来源但在派发前就失败的回合；
  - 在写入原生历史之前被拒的回合。
- **证据**：
  - 【事实】`run.context_prepared{sourceRunIds}` 在 prepare 之前提交（runtime.ts:1341–1342）。prepare、open、附件检查都在其后（:1356–1414），命令识别更晚，在 run.authorized 之后（:1393–1396）。
  - 【事实】因此 D1 的命令回合同时带有非空来源的 context_prepared 和 `run.native_command`；派发前失败的 Run 也带着非空来源。
  - 【事实】被拒的回合只在 `backend.reason` 上留痕：Codex 无 turnId 时为 `request_rejected`（codex.ts:511），OpenClaw 为 `model_not_applied`（openclaw.ts:92）。
  - 【推断】按 §14.4 的字面规则，这三种 Run 本身就成了“最后一个携带回合”，迁移得出 synced{legacy}，mark 越过了 B 的回合。这违反 v1 自己的“只降不升”和 INV-14；R2 的验收项“D1 形态推断为 suspect”会失败。
- **修正**：
  - “携带回合”须同时满足：来源非空；该 Run 没有 native_command；有 run.dispatched；reason 不是 request_rejected 或 model_not_applied；状态不是 unknown 或 cancelled（这两种记 suspect）；不晚于 throughRunId。
  - mark 取这些来源 Run 的 run.ended seq 最大值（见 M1）。
  - R0b 在 v12 的 run.ended 事件里保留 `input` 与 `contextEffect`。事件是开放 JSON（sqlite-store.ts:85–97），这样迁移有直接证据可用。
  - 属性测试：对随机生成的 v12 日志，迁移后的 mark 不超过真实送达。

### RT1-B2【blocker】迁移没有覆盖导入与分支绑定，还把清空命令推成 suspect（§14.4、§7.4）

- **场景**：
  - (a) 接续本机会话（ADR-029）后一直只用这一个 Harness；
  - (b) 精确原生分支；
  - (c) 最后一次携带之后执行过 /clear。
- **证据**：
  - 【事实】导入会话在创建时直接写入 ready 绑定（runtime.ts:331–335）。分支先写 fork-pending（:440–442），由 native.forked 转为 ready（:1545–1547）。两者都没有 `binding_prepared{resumed:false}`（该事件只在 :1384–1385 发出），所以规则的扫描起点不存在，originIncluded 的取值也没有写。
  - 【推断】(a)(b) 若 originIncluded 缺省为 false，origin 会成为外来事实，升级后第一条输入就带完整交接单，违反 INV-30 和 J3 M1。若把“缺起点”当作 INVALID_DATA，整笔迁移回滚（sqlite-store.ts:589），新版本无法启动。
  - 【推断】(c) 清空命令被记为 suspect，而 suspect 的默认处理是“补发完整交接单”，这正是裁定 §2 第 3 条禁止的做法。
- **修正**：
  - 导入绑定和分支绑定（ready、fork-pending、forking）一律记 originIncluded=true、synced{0, origin}。resumed:false 起点只用于其余绑定。
  - archived 绑定冻结其 relay，或允许缺省（相应修改 state.ts:228 的白名单）。
  - 清空命令记 fresh{user_cleared}，水位按 B4，nativeEpoch=2。
  - 每种绑定来源各配一个 v12 夹具。

### RT1-B3【blocker】executedOn 不含绑定身份，重建后纪元又从 1 开始（§2、§4、§7.5）

- **场景**：在 Claude Code 上做了 10 轮后执行 native-reset，然后发出下一条内容输入。
- **证据**：
  - 【事实】resetNative 只把绑定标为 archived（runtime.ts:401–416）。新绑定在下一个 Run 以 resumed:false 追加（:1382–1385），harnessId 和 controlId 与旧绑定相同。
  - 【事实】executedOn 只有 {harnessId, controlId, nativeEpoch}。§7.5 写新绑定的纪元“从 1 起”，与 §2、§7.2 的“+1”矛盾。
  - 【推断】旧绑定纪元 1 的 10 轮会被当成新绑定自己的回合，“完整交接单”里不含它们；而新原生会话是空的，于是全部丢失（违反 INV-14）。迁移后懒重建得到的 executedOn 都是纪元 1，同样会撞上。
- **修正**：
  - 让 nativeEpoch 在同一 (harnessId, controlId) 上跨绑定单调递增，或在 executedOn 中加入绑定代次；§7.5 改为“+1”。
  - 属性测试：重建后的 need 覆盖此前全部回合。

### RT1-B4【blocker】fresh{user_cleared} 丢掉了清空水位（§4、§6.3、§7.4、§18）

- **场景**：
  - 单 Harness 对话中执行 /clear，再发下一条；
  - 或 A 执行 /clear，切到 B 做两轮，再回到 A。
- **证据**：
  - 【事实】J3 M2 要求水位记为 `{throughSeq: X, basis: "user_cleared"}`（j3-product-native.md:184–188）。v1 改成不带 mark 的 fresh，并在 §18 称“语义相同”。
  - 【事实】§6.3 的 plan() 只有一个原样分支：need=∅ 且无 reanchor。而清空后纪元加 1，清空前本绑定的回合全部变成外来事实（§7.4）。
  - 【推断】按 §6.3 实现：need 非空就生成 packet，单 Harness 用户清空后的下一条会被注入，违反 INV-30、J3 M1（明确覆盖 /clear）和裁定 §2 第 3 条。
  - 【推断】按 §7.4 特判原样发送：回到 A 时，B 做的两轮永远补交不上，T7 的提示“这些会补交给 Claude Code”成了假话（违反 INV-14）。两节规则互相矛盾，按哪一节实现都错。
- **修正**：
  - fresh 增加 `floorSeq`（清空命令的 run.ended seq），need 取 seq 大于 max(mark, floor) 的事实；“附上交接单”时单次忽略 floor。
  - 在 §6.3 写出这个分支，并改写 §18 的处置。
  - 测试：清空后 20 轮 dispatched===input；清空后 A→B→A 只补交 B 的回合。

### RT1-B5【blocker】本绑定 not_recorded 的回合被当作外来事实，单 Harness 对话会被注入（§2、§6.3、§7.2、§8.1）

- **场景**：只用 Claude Code 的会话执行 /export，或 /remote-control 被拒，然后发下一条。以下情形同理：Codex 首条 REMOTE_ERROR、OpenClaw model_not_applied、OpenCode COMPACT_IGNORED。
- **证据**：
  - 【事实】§2 与 §7.2 都把 not_recorded 的 Run 列为外来事实；§8.1 把上面五种都声明为 not_recorded，它们都是 Driver 合成的结果（claude.ts:24–25、:70–72；codex.ts:511；openclaw.ts:92；opencode.ts:9）。
  - 【事实】fresh 绑定的 mark=null，need 一旦非空就生成 packet。
  - 【推断】从未交接过的绑定会收到一份“此前由另一个 Harness 进行”的交接单，而内容只有一条 /export，违反 INV-30 与 J3 M1。J1 M17 与 J3 M1 都标为采纳，但两者的冲突没有调和。
- **修正**：
  - 这一类外来事实只限于本纪元已收到过交接单的绑定上、非命令的内容回合。命令与 Driver 合成的结果不进 need。
  - fresh 绑定上的这类回合只在界面提示“没有发出”，由用户自己重发。
  - INV-30 的验证补上这五种情形。

### RT1-B6【blocker】CHECK 兜底长度且单位不一致，一次正常操作就能让存储停摆（§14.1、§6.4）

- **场景**：中文用户钉住一段 700 字的约束。应用层上限是“≤1,000 字”，会放行。
- **证据**：
  - 【事实】relay_pins 的 CHECK 是 `length(CAST(quote AS BLOB))<=2048`，按字节计；§14.1 写的却是“≤1,000 字”。
  - 【实测】700 个汉字是 2,100 字节，插入报 ERR_SQLITE_ERROR/275。
  - 【事实】Store 遇到 SQLite 错误时置 `this.failed`（sqlite-store.ts:626）。之后 commit()→fail() 让 Runtime 进入 fatal，停止所有活动回合（runtime.ts:791–796、804–811）。这些回合的 run.ended 无法提交，重启后按 OWNER_ENDED 记 unknown 并阻塞（state.ts:466–479）。
  - 【推算】同类问题还有：
    - 非 git 观测的上限为 2 万项，约 1.93 MB，而 files_json 上限是 256 KiB；
    - RunDigest 各字段上限之和，在中文和 1,024 B 路径（runtime.ts:89）下约 156 KB，超过 64 KiB；
    - approvals 没有条数上限；
    - relay_bodies.bytes 没有约束等于正文长度。
- **修正**：
  - 所有上限在应用层按序列化后的字节先校验、先截断，CHECK 只作 bug 断言；钉住改按字节计（或写成 ≤680 字）。
  - 观测只存变更文件与 tree 指纹，超出部分标 partial。
  - RunDigest 定义全局降级次序，并纳入 policyVersion。
  - 派生行在 mutate 之前转为 behind（J2 M3）。
  - 故障注入：超长钉住、2 万个文件、全中文摘要，都不得让 Store 进入 failed。

### RT1-B7【blocker】分支精确性只看原生位置，不看欠交（§7.5）

- **场景**：A→B（两轮）→A，回 A 的首条是 keep 类命令或一条 pending 的内容回合，用户随后在这一轮分支。
- **证据**：
  - 【事实】§7.5 的精确条件只有三条：throughRunId 相等、之后无同绑定派发、在当前纪元内。满足时，分支设为 originIncluded=true、synced{0, origin}。
  - 【事实】命令回合推进原生位置，但不推进送达水位（§7.4）；fork 复制的是源 checkpoint（runtime.ts:438–442）。
  - 【推断】原生副本里没有 B 的两轮；而 origin 不算外来事实，这两轮永远不会补交（违反 INV-14）。
- **修正**：
  - 精确分支另加条件：源绑定为 synced，且 need(through)=∅。
  - 不满足时，分支绑定继承源 mark，origin 中高于 mark 的部分按外来事实补交。
  - 源绑定为 pending 或 suspect 时，不做原生分支。

### RT1-M1【major】水位比较用的 seq 没有定义（§4、§6.3、§14.4）

- **场景**（K6）：R0 执行期间，用户发 M1（R1 排队），请求切到 B，再发 M2（R2 等待切换）。R1 先在 A 执行（runtime.ts:976–979），R2 在 B 执行，之后回到 A。
- **证据**：
  - 【事实】contextThroughSeq 取的是 lastSeq（context.ts:52、59），R1 的 throughSeq 大于 M2 的 seq。
  - 【事实】RunDigest.seq 和 SourceRange 的口径都没有定义；迁移直接取 context_prepared.throughSeq。
  - 【事实】新 Run 的 sourceRunIds 为空，state.ts:359–361 的 K7 校验因此失效。
  - 【推断】若事实 seq 取用户消息的 seq，R2 的 seq 小于 mark，B 的工作永远补不上，也违反 context-transfer.md 的“不偷偷吸收新输入”。
- **修正**：
  - 事实 seq 取 run.ended seq（Run 串行执行，构成全序），origin 事实取 0；水位取已纳入事实中最大的 seq，而不是 lastSeq。
  - relay_packets 写入时校验 fold 单元已终结，且用户消息早于当前输入，替代 K7。
  - 属性测试按 K6 生成交错序列。

### RT1-M2【major】E1 已提交，送达表要到 run.ended 才更新（§6.1、§9 S15）

- **场景**：收到 Codex 的 E1 并画出分隔线之后，Hub 进程被杀。
- **证据**：
  - 【事实】E1 随 first_output 一起提交，送达结论和绑定状态却在 run.ended 才写。恢复时“有 dispatchedAt 记 unknown”，不读事件。storage-events.md 要求“不建立两份业务权威”。
  - 【推断】重启后事件已显示接棒，送达表却记为 unknown，“有 E1 的 unknown ≤2%”这一统计被抬高。绑定处于 unconfirmed，必须重建，不会错发，所以只定为 major。
- **修正**：E1 所在事务同时把送达行改为 recorded(E1)、绑定改为 synced（J1 M3 允许，写者就是本 Run）；恢复时先查 relay.input_recorded；送达表作为唯一权威。

### RT1-M3【major】同步状态机不完备，无法做属性测试（§4、§7.2、§7.4）

- **证据与推断**：
  1. “pending 遇 not_recorded，回到派发前状态”无法实现：pending 只保存了 mark，basis 和 cause 已丢失。
     - 恢复时 never_dispatched 也要回退，但 §9 又说 recoverSession 不变；实际只能放在 claimAndRecover 里处理（sqlite-store.ts:578–587）。
  2. 表中缺少以下几行：
     - fresh 绑定上不带包的回合；
     - attempts=2 时原样发送的内容回合；
     - reanchor 何时清零；
     - reanchor 与 delta 同发时 kind 取什么（INV-31 要求一个 Run 只带一个包）。
  3. resend 定义为“同一字节”，但 pending 期间 need 会增长。
  4. pending 状态判 absent 时不做压缩分类，而 Hermes 只回放未归档的行（R8 H8），压缩后已送达的包也会被整份重发。
  5. §0 写“五态”，§2 写“四种”。
  6. activities 每个 Run 最多 64 条，超出即丢弃（runtime.ts:1153），压缩证据会漏判。
- **修正**：
  - pending 增加 `prior` 字段；把 §7.2 改成“状态 × 事件”的全表。
  - resend 改为覆盖当前 need 的新包；pending 判 absent 前先做压缩分类；压缩证据单独计数。
  - 属性测试以假 Harness 的真实原生历史为参考模型，验证：
    - mark ≤ 真实送达；
    - 除列明的例外，mark 单调；
    - recorded 之后 need 与已送达部分无交集；
    - 从未收到包的纪元中 dispatched===input。

### RT1-M4【major】RunDigest 取自内存，公共事实里未必有（§6.4、INV-13、INV-22）

- **证据**：
  - 【事实】earlyClose 时跳过 flushNative（runtime.ts:1452），工具详情被丢弃（R4 D15）；storeDetail 失败时只记一条诊断（:1263–1266）。v1 的 RunDigest 读的是 execution.details（:1139–1140）。
  - 【推断】摘要中会出现公共事实里没有的命令与输出，懒重建得到的字节必然不同，INV-22 在故障注入下失败。
  - 【推断】脱敏依赖秘密集合，重启后集合可能变化，旧秘密轮换后可能漏网。
- **修正**：只用已提交的详情生成摘要，其余记为 detailsMissing，或者同时修复 D15。清单记录秘密集合的指纹；指纹不同时只标 behind，不写入。

### RT1-M5【major】前缀和存进每条摘要，与隔离、懒重建相矛盾（§4、§6.4、INV-32）

- **证据**：
  - 【推断】迁移后历史摘要全部为 behind，第一个新 Run 拿不到正确的 cumulative：等待会破坏 p95 ≤2 ms，不等就会写错。
  - 【推断】中间任何一条摘要 behind，之后的值全部失效，只能级联改写，sha256 随之改变；恒等式也不再成立。
- **修正**：摘要只存本 Run 的计数，前缀和在读取时对 ≤256 行现算；恒等式增加“未统计”类别，并写入清单。

### RT1-M6【major】“规范化清单头”没有定义（§4、§9 S15、§14.1）

- **证据**：
  - 【事实】正文里含有 ID，所以清单头不能包含正文的 sha。“同 ID 不同 sha 即 INVALID_DATA”在 transact 内抛出，commit() 随即调用 fail()（runtime.ts:796），Runtime 进入 fatal；会话带着 error 阻塞，recoverable() 永远拒绝恢复（:766–768）。
  - 【推断】若清单头覆盖全部输入，这项“在线检测”永远不会触发；若漏掉任一输入（例如原话），正常流程就会停摆。
  - 【推断】S15 说“得到相同 ID 与字节”，与 resend 的语义矛盾（supersedes 不同，ID 必然不同）；§14.1 说重发“复用同一正文”也不成立。
- **修正**：
  - 清单头逐项列出全部渲染输入：Run ID、原话 sha、观测 seq、预算、编辑与放行、kind、base、supersedes、policyVersion。
  - 不一致在事务开始前检出，只让该 Run 以 `RELAY_PREPARE_FAILED{render_mismatch}` 失败；确定性交给 CI 中的“渲染 100 次只得 1 个 sha”。
  - 改写 S15。

### RT1-M7【major】finalize 中命令识别与 binding_prepared 的顺序未定（§6.1、§7.4）

- **证据**：
  - 【事实】现在命令识别在 run.authorized 之后（runtime.ts:1389–1396），binding_prepared 在 checkpoint 之后（:1377–1386）；v1 却在 run.authorized 之前提交交接单、送达行与 pending。
  - 【推断】若命令识别不前移，命令回合会落下交接单行和送达行，违反“命令回合不携带交接内容”“只在被使用时入库”，not_recorded 的 reason 也对不上。若 finalize 早于 binding_prepared，此时新绑定还不存在，无法置为 pending。
- **修正**：finalize 的顺序固定为：open → checkpoint/binding_prepared → 命令分类 → 核对 → 渲染 → 同一事务提交。命令回合不写交接单行与送达行。

### RT1-M8【major】同意与脱敏的判定放在 open 之后，违反 K8（§6.1、§9、§12.4）

- **证据**：
  - 【事实】R4 K8 已采用：上下文准备失败必须在启动原程序之前结束。v1 的 prePlan 只预检长度，同意与脱敏都放在 open 之后。
  - 【事实】新绑定的 open 会在原程序中建会话（Codex thread/start，codex.ts:350）；§12.4 又要求在 POST 时同步返回 409。
  - 【推断】判定失败时，原程序里已经多出一个空会话；409 与判定时机也互相矛盾。
- **修正**：在 prePlan 中按 nativeModel 或 binding.observed 判定厂商，同意与脱敏都在 prepare 之前完成。只有 `unknown:<harnessId>` 才在 open 之后询问。

### RT1-M9【major】全局同意没有事件归属和幂等键（§10.4、§14.2）

- **证据**：
  - 【事实】事件按会话存储（sqlite-store.ts:465），命令的幂等记录在快照里（state.ts:209–214、403–406），没有安装级日志；J4 M12 要求同意“记录为事件”。
  - 【推断】全局同意不属于任何会话，event_seq 却是 NOT NULL；按 (vendor, scope, session_id) 的主键会让新决定覆盖旧行，交接单的 consent_key 就无法追溯（违反 INV-13）。
- **修正**：
  - 新增安装级 relay_log（自带 seq，command_id 唯一）；同意表改为只追加，另建当前视图。
  - 交接单记录所依据的同意 seq；放行记录与它支撑的 context_prepared 同事务，或更早提交。

### RT1-M10【major】降级说明不实（§14.4）

- **证据**：
  - 【事实】ADR-049 的备份在迁移之前做好，恢复就是用它替换 gateway.sqlite；内容存储里未被引用的条目 7 天后被回收（content-store.ts:13–14、197）。
  - 【推断】从升级到降级之间的全部对话、Run、消息都会丢失；它们引用的附件和详情 7 天后被删。v1 说“公共事实不受影响”不成立。
- **修正**：改写为“恢复备份即回到升级那一刻”。若要做不丢数据的降级，导出时剥离 v13 字段，并按 acknowledgedUnknown 回填 sourceRunIds，以满足 v12 的 K19（state.ts:340–342）。

### RT1-M11【major】legacy 与 origin 水位没有可核对的标记（§7.3、§14.4）

- **证据**：synced{legacy} 与 synced{0, origin} 的 lastPacketId 都是 null，而 §7.3 在核对便宜时一律核对最后一个标记，缺失就分类处理，没有对 null 特判。
- **推断**：升级后第一次回到 Claude、Codex、Hermes 或 OpenClaw，绑定会进入 suspect{marker_absent}，停下来让用户选择，默认是整份补发；精确分支若也走这条路径，会违反 INV-30。
- **修正**：lastPacketId 为 null 时跳过核对，视为 synced，直到本纪元出现第一份 v13 交接单。

### RT1-M12【major】INV-29 的范围与公共事实冲突（§10.2、§14.3）

- **证据**：
  - 【事实】快照里逐字保存了原话与回复，回复也以 `run.output{type:"text"}` 落库（runtime.ts:1219–1231）；S12 承认原话可能夹带秘密。
  - 【推断】“grep 原值为 0”的测试在这类会话上必然失败，只能靠放宽断言通过，而 AGENTS.md 禁止这样做。
- **修正**：INV-29 只覆盖 relay_* 表、relay 事件中新增的字段、正文、日志与错误。

### RT1-m1【minor】v13 需要改动的代码点只列了两处

除 sqlite-store.ts:396、:265 外还要改：sqlite-store.ts:276（create）、:456（白名单）、:457–467（v0 直接建 v12，后续迁移块以 `version >= 1` 守卫，新库永远没有 relay 表，assertOwner 随即 OWNER_LOST）、:656/:674（Reader）；state.ts:279 与 :95、:151、:165、:197、:228 的 keys 白名单；runtime.ts:271、:331、:440 的 `schemaVersion: 12`。备份回读（:136–139）应扩到 8 张 relay 表。

### RT1-m2【minor】存储上限与不可变性没有落到存储层（§14.1、§9）

观测表无会话总量上限（256×256 KiB=64 MiB，推算）；正文 16 MiB 用尽后正文不可修剪却无错误码（完整档约 150 次触顶，推算）；“随会话删除”无对应路径（src 无 DELETE FROM sessions），relay_bodies 全局主键与按会话计量冲突；三张不可变表允许 UPDATE/DELETE，送达转换与 outcome/evidence/reason 组合无 CHECK；快照增量 pending 绑定约 484 B（>384 B）、run.relay 约 276 B（>160 B，推算）。建议 BEFORE UPDATE/DELETE 触发器，写明触顶错误码。

### RT1-m3【minor】assertSessionTransition 的扩展有遗漏（§14.3）

state.ts:448 应覆盖 run.relay 与 contextReadyAt；:420 应要求归档绑定的 relay 不变；回合外 usage_update（acp.ts:634）没有写者 Run，会被 :424 拒绝，只能写 relay_windows；pending.packetId 等跨存储引用须在 Store 写入时校验。

### RT1-m4【minor】INV-14 的纪元条件不应作用于配置承接（§14.3）

ADR-028 比较的是选择纪元（state.ts:393）。若照 INV-14 实现，“先 /model X 再 /clear”之后会退回 selection 里的模型，即 K14 回归。纪元条件只该用于分支精确性。

### RT1-m5【minor】INV-22 的重建输入没有全部落库（§14.3）

附言只在正文里；HMAC 密钥不进备份；摘要主键不含 policy_version，升 relay/2 会覆盖旧摘要；清单不记派发时仍 behind 的回合。修正：附言、秘密集合指纹、detailsMissing 回合进清单，主键加 policy_version。

### RT1-m6【minor】E2 与 E3 的时刻无处存放（§11.2）

§11.2 说时刻“记在 relay_deliveries”，DDL 却没有时间列；同一提交的事件共用时间戳（sqlite-store.ts:594–598），E2 ≤2 s 测不出。建议加 decided_at、verify_ms；“A.chain 末 4 个标记”改为“本纪元最近 4 份 recorded 交接单 ID”；写明 legacy 的 chain 取值。

### RT1-m7【minor】迁移耗时与 Q6 的惰性方案

分页读事件每页都整份解析快照（sqlite-store.ts:171–172），迁移应直接按 seq 扫描；Q6 的“首次打开时惰性推算”与 :154（快照版本须等于库版本）和 :424（写者规则）冲突；整库一个事务重写，WAL 加备份约需两倍库大小空间（ADR-049 写一倍）。

### RT1-m8【minor】S14 的流程走不通（§9、§16）

查看器被杀后，Run 记为 unknown，绑定保持 unconfirmed（runtime.ts:1481、1492）。下一次在 open 之前就会抛出 NATIVE_STATE_UNCONFIRMED（:1336），所以“下次 open 回放出标记”不会发生，只能重建。

### RT1-m9【minor】contentReferences 的断言会误报（§14.4）

内容 ID 的格式是 `content-<uuid>`（content-store.ts:255），而正文里会正常出现 `content-store.ts` 之类的字样。应改为断言 relay 行中没有 ContentRef 形状的对象，或用完整的 UUID 格式匹配。

### RT1-m10【minor】acknowledgedUnknown 需要与 sourceRunIds 同等的校验（§4）

每个 ID 都要满足：Run 的 status 为 unknown、cleanup.closed 为 true、用户消息早于 requestedSeq（参照 state.ts:369–373），而且只能出现在恢复切换上。旧 Run 不可改写（:441），O(R·(R+M)) 的校验成本仍然存在，J1 M9 的基准应把新旧会话分开报告。

## 2. 已核对，无问题

ADR-049 备份条件 1–11→1–12 与 sqlite-store.ts:396 一致，持锁、事务外备份，失败整笔回滚并保留备份，v12 拒绝 v13（:456、:656）；v12 事件类型开放（:85–97），P0 不升库；终态不可改写（state.ts:441）故送达表独立，一 Run 一包由主键保证；contextThroughSeq 先于 running（:448）；never_dispatched 成立（runtime.ts:1415–1417）；recoverSession 语义不变（state.ts:466–479）；K19 双认可行，blocked→open 检查（:426–428）不变；contextReadyAt 兼容旧数据（:155–160）；v12 剥离 BackendResult.input 必要（:95）；同一 transact 写快照、事件与 relay 行可行（sqlite-store.ts:343–363），复合外键合法、外键已开（:247）；relay 不存 ContentRef，回收集合不变（content-store.ts:197）；交接单先于 startText 提交、只发布已提交事件（runtime.ts:791–802）；复用进程不 open 已被考虑（:1345–1354）；重发附在新输入上，不违反 INV-11。

## 3. 不变量对照

INV-01–05、07–10、15、16、18、19、24、25、27、28：机制未改，无冲突（全局同意的幂等见 M9）。INV-06：交接单满足，E1 见 M2、同意见 M9。INV-11、21、26、31：满足。INV-13：M4、M6、M9、m5。INV-14：B1、B3、B4、B7、M1、M3。INV-20/23：B6、m2。INV-22/32：M4、M5、m5。INV-29：M12。INV-30：B2、B4、B5、M11。INV-33：M9。INV-12、17、34 不在本视角。

## 4. 假设

按 v1 字面（含 §6.3 伪代码）推演；未写出的特判须写进文档。真机行为（Q1–Q18）不在范围内。
