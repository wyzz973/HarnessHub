# 第四轮终审发现处置表（v3-dispositions）

对象：[第二版架构](../round3/v2-architecture.md)的四份终审核验 [VF1](vf1-delivery-watermarks.md)（送达与水位）、[VF2](vf2-performance-testability.md)（性能与可测性）、[VF3](vf3-native-security.md)（原生体验、安全与隐私）、[VF4](vf4-completeness.md)（完整性），共 69 条（blocker 7、major 49、minor 13）。处置落实在[终稿 relay-architecture.md](../relay-architecture.md)（下称终稿），“节”列指终稿的节号。作者：总架构师 Fable 5.1，2026-11-03。代码行号以本工作树（与 `07a0825` 相同）为准；本表与终稿是本轮只写的两个文件。

处置取值：**修正**（按发现的修正意见或等价方案改了设计）、**部分修正**（采纳了一部分，未采纳部分写明理由）、**反驳**（有证据不改）。规则：blocker 与 major 必须修正或有证据反驳；minor 视情况处理。本轮没有整条反驳；6 条部分修正的未采纳部分在“理由”列写明，并汇总在终稿第 18.1 节与第 19 节。四份报告引用的代码事实（`runtime.ts:343–370`、`:401–416`、`:435–442`、`:635–641`、`:745–752`、`:1332–1420`、`:1488–1500`；`state.ts:385–396`、`:416–426`、`:464–481`；`sqlite-store.ts:28–34`、`:575–592`、`:620–630`；`claude.ts:20–40`、`:60–75`；`hermes.ts:34–42`、`:94–128`；`opencode.ts:5–12`、`:76–86`；`codex.ts:505–530`、`:700–710`；`openclaw.ts:418–450`；`native-environment.ts:14–26`；`binding-factory.ts:144–175`；`content-store.ts:54–62`；`attachments.ts:28–38`；`acp.ts:270–290`、`:372–386`、`:520–545`、`:630–640`；`control.ts:66–78`；`server.ts:262–270`、`:503–537`；`contracts/web.ts:8–16`）本轮逐条在工作树上重读核对，与报告所述一致【事实】。

汇总：修正 63、部分修正 6、反驳 0（VF1 14/1/0；VF2 15/1/0；VF3 14/3/0；VF4 20/1/0）。需要用户拍板的取舍由处置引出的共 11 条，列在终稿开头“状态与验收”一节（D1–D11），每条附推荐项。

## VF1 · 送达与水位（15 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| VF1-01 | blocker | 修正 | 6.1、7.1、7.2、7.3 | 发现成立：第二版 `planReturn` 只在 `mark.lastPacketId ≠ null` 时核对且核对的是“本纪元最近 ≤4 份 recorded 包”，首份包（prior.mark=null）不核对就重发，而 Hermes 对 `unknown_execution` 明说“可能已执行，不要重发”（`hermes.ts:38、125–127`【事实】）。终稿：pending 只核对待核的那份包自己的标题行（首份包也核对），suspect 才核对已 recorded 的 ≤4 份；`verifyDelivered(position, markers)` 按标记逐个回答；§6.1 的条件改为“pending ∨ (suspect ∧ lastPacketId≠null) ∨ clear_unconfirmed”；属性测试“旧包 present 不推进 pending 包” |
| VF1-02 | blocker | 修正 | 4、6.1、6.3、7.2、7.4、9、12.1 | 发现成立：pending 行 a、b 列都写“不发生”，自动重发用尽或 `lateDelivery` 之后这一回合既不能带包也不能不带包，`attach:"none"` 在 plan() 没有分支。终稿：新增事件 n（内容回合不带包但 need≠∅，只在用户选 `attach:"none"` 后发生：原样、水位与 pending 不变、不产生证据）；pending 的 a 只作为 resend 并写明前提；自动重发不可用时受理同步 `409 RELAY_CHOICE_REQUIRED{cause:"delivery_unconfirmed"}`［再附一次］［只发这条消息］［新开原生会话］（D1）；`attach:"none"` 进 plan() 首行；OpenCode 送达之后的 Provider 错误按 R8 O3 记 E3 recorded；属性测试枚举 4 种状态 × 13 种事件没有未定义的格 |
| VF1-03 | blocker | 修正 | 3.2、4、6.4、7.2、7.4、8.1、9 | 发现成立：Hermes `/clear` 在结算时无法确认，第二版只能走 f 列进 suspect，下一次回放为空时按 k 列“都不在 → 退到第一份包之前”把清空前的历史整份补回；网关 reset 后推送 `context_tokens=0`（`gateway_commands.py:226–236`【事实】）又会被“used 下降 ≥30%”当成压缩证据。终稿：`BackendResult.native{cleared, replaced}` 由 Driver 在结算时确认（Hermes 固定回执 `Conversation history cleared.`、OpenClaw `sessions.get`、Claude 合成）；确认不了 → 事件 e′ `suspect{clear_unconfirmed, floorCandidate}`，`VerifyResult.historyEmpty` 为 true 或标记都不在才按 e 转换，标记仍在则回到清空前；usage 下降规则排除 `commandEffect ∈ {clear, rewind}` 的回合与 `clear_unconfirmed` 期间；suspect / pending 不复用保留进程；测试“收过包后 `/clear` 再发 20 条 `dispatched === input`” |
| VF1-04 | major | 修正 | 7.1、7.2 | 发现成立：j 定义为“不带包的本绑定回合结算”，命令回合有输出就把 fresh 推成 synced，A1 永不送达（D2 回归）。终稿：j 只是 b 的结算（内容回合、派发时 need=∅、未选 attach:none），命令回合与 n 的结算单列“不变”；native 证据行同样限定；属性测试“fresh 上任意命令序列之后 need 不变” |
| VF1-05 | major | 修正 | 4、6.1、7.4、8.1、14.2 | 发现成立：分类在 open 之后，admit 与 prePlan 只看 need≠∅，`/clear` 会被同意、选择、数据根与 `RELAY_INPUT_LIMIT` 挡住（小窗口下成死路，与 RT2-08 的处置矛盾）；没执行的命令仍按声明效果转换。终稿：受理时按 Driver 静态声明 `classify` 加目录缓存预分类，命令与疑似命令跳过四项检查；open 后 `models()` 复核，不符 → `RELAY_PREPARE_FAILED{classification_changed}`；命令效果 = 声明效果 ∧ `run.native_command.executed`（OpenCode 合成忽略、Codex 无 turnId 拒绝、Hermes noop 不转换）；`remote-control` 列入 hidden none |
| VF1-06 | major | 修正 | 4、5.5、7.4、8.1、13.3 | 发现成立：Hermes 先 `lstrip()`（`gateway_server.py:32`【事实】）而 Hub 用 `startsWith("/")`（`runtime.ts:1393`【事实】），全角空格开头的 `/clear` 被 Hub 当内容带包、被 Hermes 当命令执行。终稿：`RelayCapabilities.commands.classify(text, catalog)` 由 Driver 复刻原生解析（前导空白、注册表与别名、路径排除），首行省略、命令跳过与 E3 共用；RelayConformance P5 每家加半角、全角前导空格各一例 |
| VF1-07 | major | 修正 | 2、4、6.3、7.2、7.5、14.3 INV-14、INV-30 | 发现成立：synced 不带 floor，f 列把 suspect 的 floor 写成 −1，回退会把清空前的历史补回；重建的 `fresh{reset, floor:null}` 也丢下限；resend 读新请求丢掉“附上”。终稿：`BindingRelayState.epochFloor` 随绑定谱系保留（synced、重建、Claude 合成清空的新绑定都继承），need 下界恒为 max(mark, epochFloor)，k 列回退退到 max(本纪元第一份包 range.fromSeq − 1, epochFloor)；pending 记 `attachOverride` 供 resend 继承；新绑定 `originIncluded=false`；INV-30 把 suspect 回退列为唯一例外 |
| VF1-08 | major | 修正 | 2、4、6.4、7.2、7.4、8.1、14.1 | 发现成立：Hermes 压缩摘要作为普通消息持久（`acp_adapter/server.py:83–98`【事实】），“回放标记出现即置 reanchor”会每回合都发要点；分类 ① 没存送达时的压缩状态；§7.2 与 §7.4 ② 互相矛盾；`packetsInEpoch` 何时加 1 未定义。终稿：压缩证据改为游标 `compactionSeen{count, digest}`，只在变化时算“观察到压缩”；送达行记 `compactionAtDelivery`，分类 ① 据此判“送达后压缩过”；Hermes 核对跳过带 `compactionSummary` 元数据的条目；§7.2 k 列与 §7.4 统一（outside_window / unavailable 只记 `relay.verified`）；`packetsInEpoch` 只在 g 时加 1 |
| VF1-09 | major | 修正 | 7.2、7.4、8.1、19 O12 | 发现成立：`keepable` 只看 completed 与清理（`runtime.ts:635–641`【事实】），命令回合也会被保留，复用时不 open 没有回放（`:1345–1354`【事实】），need=∅ 的 suspect 放行会吞掉 `/undo`。终稿：need=∅ 的放行只限 cause ∈ {legacy, verify_unavailable, vendor_changed, marker_absent}；rewind、unknown_command、clear_unconfirmed、unknown_turn 必须先核对；`verify=on_next_open` 的 Driver 在 suspect / pending 时不复用保留进程；§8.1 Hermes 行改写 |
| VF1-10 | major | 修正 | 7.5、8.1、14.3 INV-14、20 Q22 | 发现成立：`carriedNativeConfiguration` 只读当前 ready 绑定的 observed 与 throughRunId（`state.ts:391–393`【事实】），合成清空的新绑定两者皆空，先 `/model X` 再 `/clear` 会退回 selection 模型（K14 回归）；保留进程的 `kept.conversation` 仍是旧 ID。终稿：新绑定继承 observed，Driver 用观测模型 `session/new`；承接改读同一 (harnessId, controlId) 当前选择纪元内最后一个已派发且 `input ≠ not_recorded` 的 Run、跨因清空归档的绑定（顺带修 OpenClaw `model_not_applied` 后承接旧模型）；checkpoint 变化时更新 `kept.conversation`；P6 加“`/model X` → `/clear` → 仍为 X”；“Claude CLI 的 `/clear` 保留模型”列为 Q22 |
| VF1-11 | major | 修正 | 7.6、17 G067 | 发现成立：旧规则让 unknown 推进（插入前取消在 P0 仍 ✗、R0c 的“只重发一次”无计数字段），让 not_recorded 的内容回合不推进（单 Harness 的 `model_not_applied`、Codex 无 turnId 之后下一回合把失败回合当来源改发 JSON 信封，`runtime.ts:1337–1339`、`:1392`【事实】，新回归），R0a 没列“切换后首条仍可能超限”。终稿：`advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ 已重发一次))`，次数由 `run.ended.data.relayResendOf` 推出；“切换后首条在 G070 前仍可能 `CONTEXT_TOO_LARGE`”写进已知局限，R0a 对它提供“只发这条消息” |
| VF1-12 | major | 修正 | 4、9、14.1、14.3 INV-35 | 发现成立：`BEFORE UPDATE OF outcome` 只要 SET 里有 outcome 就触发，i 列的 unknown→unknown 同值写是 SQLite 错误，`sqlite-store.ts:623–627` 会把 Store 置 failed【事实】；`claimAndRecover` 一个事务覆盖全部会话（`:577–590`【事实】）。终稿：触发器放行 unknown→unknown 与 recorded→recorded；转换先在应用层按允许表校验，UPDATE 只在 outcome 变化时把它写进 SET；relay 写失败映射为本 Run 失败；恢复按会话各自 SAVEPOINT，一个会话失败只标该会话 |
| VF1-13 | minor | 修正 | 7.1、8.1 | 发现成立：OpenClaw 对 cancelled 不回读（`openclaw.ts:440`【事实】）而网关尽力补写用户回合，“补写不算”会导致重发重复、补写落在下一回合 `before` 之后时本包被判 absent。终稿：OpenClaw 声明 `lateDelivery=true`，取消记 `unknown{late_delivery}`、不自动重发；核对在位置之后的客户端用户条目里按本包标题行查找，查到的上一包顺带改记 recorded；Claude 的 orphan 输入同样处理 |
| VF1-14 | minor | 部分修正 | 12.1、14.2、19 | 采纳：撤回排除的语义写明——只影响之后渲染的包，水位已越过被排除 Run 的绑定不再补交，界面写明。未采纳部分：“为已越过的绑定记欠交补集”——会让 need 不再单调、水位之下出现新欠交，与 INV-14 的单调性质冲突；排除是用户主动选择，撤回后不补交是可解释的结果 |
| VF1-15 | minor | 修正 | 9、14.2 | 发现成立：`recoverSession` 只写 `session.recovered`（`state.ts:466–479`【事实】），被它终结的 Run 没有 `run.ended`，事实 seq 无定义。终稿：这类 Run 的事实 seq 取 `session.recovered` 事件的 seq；`recoverRelay` 对已 recorded 的送达行不改（E1 已提交的不会被 `owner_ended` 覆盖） |

## VF2 · 性能与可测性（16 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| VF2-01 | blocker | 修正 | 0、5.3、6.1、6.2、6.3、9、19 O10 | 发现成立：第二版 `MIN_PACKET=600` 小于固定部分（VF2 实测 o200k 770、est/1×1.3 1,180，末单元另需 120 / 156），W 在 12k–37k 时 plan() 到 finalize 才 blocked，目标程序已启动 1.3–5 s，违反 K8。终稿：`MIN_PACKET[族]` 由构建期渲染“最小交接单”（含 ≤400 字错误原文的状态节上界）生成、进 `policyVersion`、CI 断言，初值 o200k 族 900、Claude 族与未知族 1,350【推算】；受理时按保守窗口判定并同步 409 提供“只发这条消息”，finalize 用精化窗口复判；属性测试 W 对数均匀取 4k–2M；§6.3 的末行 blocked 改为“不可达，属性测试断言”；用户取舍 D2 |
| VF2-02 | major | 修正 | 0、5.4、6.2 | 发现成立：第二版中文模板 o200k 448、填入后 498，英文 389 / 435【实测，VF2】，≤420 被自己的模板否定；作预算常量时固定部分被低估 80–370 token。终稿：`FRAME_CAP[语言][kind]` 由 CI 渲染模板计数生成（zh.packet 500、en.packet 450 初值），超过常量即不通过，常量变化升 `policyVersion`；不合并约定（模板措辞按 RT5-10 已定） |
| VF2-03 | major | 修正 | 0、5.2 N4/N19、6.4、11.1 | 发现成立：原型脱敏未实现键名、熵规则与排除表（`spikes/relay/proto/redaction.ts:2`【事实】），≤3 ms/MiB 只在无熵规则下成立（加熵规则实测 6.8–10.3）；N19 的扫描范围未写明，最坏可到 1.4 MiB/Run。终稿：N19 写死扫描范围（每条目窗口两侧各 8 KiB、单条目 ≤64 KiB、每 Run ≤0.2 MiB，CI 断言扫描字节与正则遍数）；脱敏目标分两档（精确 + 形状 ≤3 ms/MiB，加熵规则 ≤12 ms/MiB【推算】）；RunDigest 的脱敏另计 ≤3 ms；骨架映射加 ASCII 快路径；按秘密数 {20, 100, 300} × 10 种形式 × 文本类型重测后再定 |
| VF2-04 | major | 修正 | 4、6.2、14.1 | 发现成立：`documented(model)` 按裸名查表会落到 128k（S4 的 V4 Pro 1M 只得 6,400）；`relay_windows.model NOT NULL` 学不到 null 模型的窗口；`gateway:*` 等的假设窗口未定义；5%·W 不扣目标固定前缀 S_B。终稿：Driver 声明 `normalizeModel()` 与 `fixedPrefix`；`capWindow = max(0, min(0.05·W, W − S_B − S_new − RESERVE))`；`ASSUMED_WINDOW` 按厂商键种类的显式表（gateway / router / provider / unknown / local 都从 32k 起）；`relay_windows.model_key` 默认 '' 并记 `first_turn_used`；属性测试 |
| VF2-05 | major | 修正 | 6.2、6.3、12.1 | 发现成立：悬崖判定用 `1.2 × TIER_CAP[tier]` 而不是本包估算，Haiku 97.5k 时降到只交目标仍越线却照发；89k 时本不越线却被降档；`S_new` 未定义；越线时没有提示。终稿：`cliffCheck` 在 plan() 渲染出本包之后用 `contextUsed + S_new + est(本包)×(1+e90) + 2000` 判定，`S_new = est(当前原话)`；越线时降档重排，仍越则卡片提示［先压缩］［只发这条消息］［照发］并按悬崖价计 π；属性测试 contextUsed ∈ [cliff−5k, cliff+2k] |
| VF2-06 | major | 修正 | 5.1、5.3、6.2 | 发现成立：按字的上限（开场 1,900 字、每条头 3,000 + 尾 800）与按 token 的 U 冲突，Claude 族中文一条长消息约 4,900 token 连一条都放不下；只交目标档固定部分 1,180 之后 `USER_CAP` 1,200 不可达。终稿：单条上限只按 token（开场 ≤0.4·U，其余每条 ≤min(0.5·U, 1,600)，头 4 : 尾 1），字数只作显示折算；`TIER_CAP.goal` 2,000 → 2,500、`USER_CAP.goal` 1,200 → 1,000；“5–8 条”由 CI 在中英夹具（含每条 2,000 字的全中文）上重算后写回 |
| VF2-07 | major | 修正 | 7.3、12.1、19 O11 | 发现成立：C7 要求并列首个请求与之后每个请求的费用，第二版只显示首个请求且并列条件只在冷时触发；首个请求差只占全程差 24%（R=80 全程续接约 $3.22、新开约 $0.48【VF2 §2 重算】）；R̂ 右删失、“工具调用数 + 1”遇并行调用高估。终稿：`perRequestDiff` 与 `wholeDiff` 写进 `planReturn`，卡片写“每个后续请求 +$x”，并列条件改用全程差、冷热都适用；R̂ 用 Kaplan–Meier 生存估计；请求数取 `NativeUsage.requests` 条数；表驱动单测覆盖四点 (R, k) |
| VF2-08 | major | 修正 | 0、10.6、11.1、14.2 | 发现成立：零延迟假 Harness 下 `max(0, 观测 − 启动)` 恒等于观测，基线测不出；复用路径的 50 ms 被观测 38 ms 吃掉；`rev-parse` 与 `config --list` 串行；带 `relay.consent` 时多一条同意镜像打破“≤3 条”。终稿：Δ 取同一快照下 `attach:"auto"` 与 `"none"` 的 ABBA 成对差，断言 p95(Δ_i − max(0, obs_i − start_i)) ≤15 ms；假 Harness 启动延迟 {0, 7 ms, 1.3 s}；`rev-parse` 与 `config --list` 并行、驱动名按配置 stat 缓存；复用目标改为观测 p95 + 15 ms；事件上限写“≤3 + 同意镜像” |
| VF2-09 | major | 修正 | 3.2、11.1、13.3 P10 | 发现成立：`NativeUsage` 只有回合级（`control.ts:70–74`【事实】），ACP 丢回合外 `usage_update`（`acp.ts:635`【事实】），Codex 只用 `last.totalTokens`，OpenClaw 逐条相加；DeepSeek 无写入计量。终稿：契约加有界 `NativeUsage.requests?`（≤64 条），所有者切片 G069；P10 改为两轮各一个请求、禁用工具、固定长度回复，有工具即作废；DeepSeek 用 cache miss；未上报记“未上报”不算通过 |
| VF2-10 | major | 修正 | 0、6.2、11.1 | 发现成立：工作区内缓存跨会话共享、DeepSeek 自动前缀缓存使同文会话从第 2 个起斜率趋 0；“首个任意事件”含 OpenClaw 的 diagnostic（`openclaw.ts:424–426`【事实】）；两个时间戳都在提交函数里读；Haiku 5.5 与 V4 Flash 非默认目标且分词器不能外推；本地 P̂=8k 永不触发降档。终稿：每会话首段带基准专用 nonce（不进生产渲染）并断言缓存读 ≤ S_B；终点取首个 text/thinking/tool 事件的单调时间；三个默认目标族每档 ≥10 会话、分高峰与闲时；Theil–Sen + bootstrap；本地 P̂ 取 2,000 tok/s 保守值 |
| VF2-11 | major | 修正 | 6.2、11.1、13.1 | 发现成立：`count_tokens` 带凭据联网，“离线脚本”与“进 CI $0”冲突；RT3 的 17% 只是 o200k 样本内；“anthropic 族”不是一个分词器（Opus 4.7 起与 Haiku 5.5 不同）；按段 p90 与决策无关。终稿：一次性生成按模型 ID 的冻结计数夹具（`tests/fixtures/relay/tokens`，记日期与分词器代次），CI 只对夹具算误差，定期作业刷新、漂移即升 `policyVersion`；族键按分词器代次；门槛改为整包误差 p90 ≤20% 与近 hardCap 的低估概率 ≤5% |
| VF2-12 | major | 修正 | 11.1、13.1、13.3 P13 | 发现成立：每家约 20 回合的探针验收不了 ≤2% / ≤1/100（0/20 的 95% 上界约 14%；证明 ≤2% 要 ≥149 次、≤1/100 要 ≥299 次）；P13 的“主题一致”要语义判断。终稿：确定性的假 Harness 故障注入矩阵（Driver 声明 × 证据序列 × 崩溃点）进 CI，断言重复 0、丢增量 0；真机比例作上线监控，报 Wilson 上界并写最小样本量；P13 改为标题含预置关键词之一且不含禁用串 |
| VF2-13 | major | 部分修正 | 13.2 | 采纳：预注册写功效分析（n=72、20% 不一致率时单侧下界约 d̂ − 8.7 pp；d=0、80% 功效约需 1,375 配对【推算】）；标准误按题聚类；序贯设计（2 个中期看点，O'Brien–Fleming）；H7 改为渲染器确定性用例加 ≥100 个注入实例的专门集合；v0 的 −3 pp 改为 −10 pp 初筛，正式采纳需 ≥300 配对、−5 pp（D10）。未采纳部分：直接把 v0 加到 1,375 个配对——按每次接手 $0.3–1 推算要 $1.2k–4k 以上且需三个接收方各跑一遍，本轮先以初筛 + 正式两级设计登记，预算另批 |
| VF2-14 | minor | 修正 | 0、4、11.1、12.4、14.1 | 发现成立：第二版形状的 pending 绑定 571–759 B、带附言的 `relayRequest` 约 4.9 KB/Run【推算，VF2】，≤512 / ≤320 B 沿用的是第一版形状。终稿：绑定上限改 ≤1,024 B、用最长合法值（`gateway:<253 字符主机名>`、pending 加 suspect prior）断言；`relayRequest` 的附言、放行与排除正文进 relay 表，快照只留 {tier, attach, native, resend, fingerprint}；Run 仍 ≤320 B。未按建议把 prior / chain / lastPacketId 移出快照：跨存储引用会让 `assertSessionTransition` 看不到绑定状态，1,024 B 的上限足以容纳 |
| VF2-15 | minor | 修正 | 6.3、6.4、11.1 | 发现成立：2 万文件只测小文件热缓存；索引按第二版形状 1,485 B、`line.userHead` 可见化后可到 12–13 B/字、无收紧次序；G3 级补建算不出 verbatim 尺寸；“派发最多等 1 s”不在派发目标里。终稿：观测基准加大文件与冷页缓存；索引字段给字节预算与收紧次序（`userHead` ≤360 B 等）；G3 级补建把 `size.verbatim` 标为未知、整份直送按放不下处理；冷路径等待计入派发增量目标 |
| VF2-16 | minor | 修正 | 4、7.3、11.1 | 发现成立：原型 n=100 / 30 估不出 p99；堆未测；p95 跑间波动 ±0.2 ms；CI 机器不同；E1 的 `recordedAt − dispatchedAt` 含派发提交；`lastRequestEndedAt` 判“热”会把长生成后已过期的缓存判成热。终稿：p99 ≥1,000 样本并报 bootstrap 区间；堆用 `--expose-gc` 后的 heapUsed 增量并以 `--max-old-space-size` 子进程复核；CI 只断言计数类量，毫秒目标在参考机上跑并记机器指纹；E1 用 Driver 在 `startText` 前的单调时间戳；“热”改用 `cache.lastRequestStartedAt` |

## VF3 · 原生体验、安全与隐私（17 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| VF3-01 | blocker | 修正 | 2、4、8.1、10.4、13.3 P14、14.3 INV-33 | 发现成立：第二版 `vendor()` 只收 Hub 交给 Harness 的变量名，看不到 Harness 自己配置的端点——Claude 用户设置里的 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`（Hub 只读 auth 的 kind，`claude.ts:35–38`【事实】）、Codex 的 `OPENAI_BASE_URL`（0.166.0 二进制含该名【事实，VF3】）、dsh 每一层都可供端点含工作区 `.env`（`dsh-llm-deepseek/lib/index.js:404–407`【事实，VF3】）、Ollama `*-cloud` 经本机端口转云端，已全局允许的用户会把别家历史发往这些端点。终稿：`resolveVendor(observed)` 的 `observed` 带 Driver 按各家优先级解析出的端点 host 与来源层（只读端点键、不记录值）；非回环端点 → `gateway:<host>`；来源是工作区文件的永不被 `allow` 覆盖、每会话都问；`local` 要求回环且模型不是转云端，并只在用户标记“本机模型不出网”时豁免；`allow` 不覆盖 `router:*`、`provider:*`；P14 加四个夹具；各家优先级列 Q24 |
| VF3-02 | major | 部分修正 | 3.2、6.1、10.4、12.1、12.4 | 采纳：admit 的目标写死为 `pendingSwitch?.target ?? selection`（`send()` 只记 `awaitingSwitchId`，`runtime.ts:343–370`【事实】）；`unknown:<h>` 的回答只记“已看过说明”，open 后观测到真实厂商键仍须同意；排在活动 Run 后的消息在 prePlan 时重做 admit，不通过的在启动前失败；`GET …/relay/preview?observe=true` 持租约打开、不派发、只读厂商键；`public-api.md` 写明 409 只覆盖受理时可判定的情形。未采纳部分：把 `observe=true` 作为自动预检——它要启动目标程序 1.3–5 s 并拉起用户的 MCP 与插件（RT2-16 否决无租约 probe 的同一理由），终稿只在用户点“核实厂商”时做 |
| VF3-03 | major | 修正 | 10.2、13.1 | 发现成立：按值形状的排除既误伤（`AWS_PROFILE=default`、`ANTHROPIC_MODEL=…` 进集合后来源说明被改成标签）又漏（含 `/` 的 AWS secret 被当路径、路径里带令牌的 URL 被当 URL）。终稿：集合按变量名定（凭据词进、`*_MODEL` / `*_REGION` / `*_PROFILE` / `*_DIR` / `*_PATH` / `*_HOME` / `*_URL` 按名排除；`referencedNativeValues` 不看名字全进）；“路径”只认 `stat` 成功的绝对路径；已知值加 base64 三种对齐与十六进制共 10 种形式；RD-09、RD-10 各配无效样例 |
| VF3-04 | major | 修正 | 5.2 N1/N19、10.2 | 发现成立：N1 只删 ESC 字节，`grep --color=always` 的 `[01;31m[K` 残片把秘密切开（原型 `escape.ts:24–25` 同样只删控制字节，夹具只在秘密两侧着色【事实】）。终稿：N1 先整段删除 ANSI 序列（CSI、OSC、U+009B、两字节 ESC 序列）再删 C0；RD-03 加“着色在秘密内部”的夹具 |
| VF3-05 | major | 修正 | 6.4、10.2、14.3 INV-22 | 发现成立：集合变小（令牌轮换后旧值仍有效）后指纹不同 → behind → 按新集合从原始事实重建，旧值复现。终稿：摘要记录命中区间 `(ref, offset, length)` 不记值，重建时先套历史区间再扫当前集合；属性测试“曾被脱敏的位置之后仍被脱敏”；与 F06 一并改为安装级集合 |
| VF3-06 | major | 修正 | 1 G4、5.1、5.5、12.1、14.3 INV-30、19 O8 | 发现成立：§5.5 同时写“第二段一字不改”与“同一种脱敏处理”；当前输入没有 Run，`reveal` 无法放行；原样路径本就逐字节发送。终稿：第二段永远原样；当前输入有命中时省略首行；T2 卡片提示“这条消息里有 1 处像密钥的内容，会原样发给 X”；INV-30 补“携带包时第二段等于原话”；用户取舍 D4 |
| VF3-07 | major | 修正 | 5.1、5.2 N4、10.3 | 发现成立：内联转义不处理「」，审批标题 `rm -rf dist」→ 用户批准。HarnessHub 记录：…「x` 可闭合引用槽并在围栏外续写 Hub 口吻的句子；钉住的助手原话在围栏外却按约定 3 有效。终稿：不可信字符串里的 `「」` 映射为 `﹁﹂`；钉住的助手消息放进“用户原话”节内单独的 HH-DATA 区并标作者；IN-04 与保留串表加闭合括号；模糊测试加「」槽 |
| VF3-08 | major | 修正 | 5.1、5.4、5.6、10.3 | 发现成立：约定 6 按字面把 ```` ```text ```` 里的用户原话也说成“不是指令”，与约定 3 冲突；错误原文用代码围栏却不在 HH-DATA 里。终稿：约定 6 改为“HH-DATA 区与行内反引号、「」里的名称是引用；‘用户原话’的逐字块是用户本人的话，按第 3 条对待”（中英两套与 S1 样例同步）；错误原文改入“状态与风险”节内的 HH-DATA 区 |
| VF3-09 | major | 修正 | 3.2、7.5、10.5、20 Q23 | 发现成立：Claude bash 模式的 `<bash-input>` / `<bash-stdout>` 作为用户条目回放（CLI 2.1.316 含该模板、claude-agent-acp 回放标记表无 bash 类【事实，VF3】），Hub 同角色分块直接拼接（`acp.ts:280`【事实】），README 里的注入会升格为用户原话；回放还混有 Hub 附件指针、Hermes 附件正文、OpenClaw cwd 前缀，后两者改变字节让自家交接单认不出。终稿：Driver 声明 `userTextOf(replayed)` 剥四类包装、剥下部分记 external_output；交接单识别改为“标题行 ID + 标题行到结束行与已存正文一致（允许 Driver 声明的前后缀）”；认不出但含 `〔HarnessHub` 标记的整段记 external_output；bash 模式与 `<local-command-stdout>` 是否入转录列 Q23 |
| VF3-10 | major | 修正 | 0、10.6 | 发现成立：`-c filter.a=b.clean=` 在第一个 `=` 处被切开，VF3 实测 git 2.54.0 下过滤器仍跑 2 次而 `GIT_CONFIG_COUNT/KEY/VALUE` 写法 0 次；`config --list` 超 64 KiB 语义未写；驱动名可含点；git 从哪来未定（PATH 含工作区内目录时假 git 在沙箱外执行）。终稿：中和一律走 `GIT_CONFIG_COUNT` / `KEY_n` / `VALUE_n`；驱动名不匹配 `^[A-Za-z0-9._-]{1,64}$`、列表超 64 KiB 或含 include 时退 tree；驱动名取 `filter.` 之后到最后一个点之前；git 启动时从工作区外的绝对 PATH 项解析一次并记 realpath；`HOME=<空目录>` 写明只管观测子进程；WS-06 |
| VF3-11 | major | 修正 | 1 G4、3.1、9、10.1、10.2、14.3 INV-36 | 发现成立：数据根用 `realpathSync`（不折叠大小写）、工作区用 `fs.promises.realpath`（折叠），`--data-dir /users/sd3/proj/data` 的前缀比较判为不包含【实测，VF3，APFS】，firmlink 写法同样漏判；附件指针把 `<数据根>/content/files/…` 交给目标，同用户可读的目标顺着它能读 `gateway.sqlite` 与 `relay-key`；库里是全部对话不只跨厂商的；复制数据目录后旧 `./data` 仍在工作区。终稿：沿父目录比较 `(st_dev, st_ino)`；工作区内有界查找 `.harness-gateway.json` 标记；包含时对该工作区全部会话告警并要求确认；附件物化到 `os.tmpdir()` 下 0700 不可猜测目录；`relay-key` 移到 `~/Library/Application Support/HarnessHub/`（D5）；G4 改为“工作区内不可达；同用户可读以目标的沙箱为界” |
| VF3-12 | major | 修正 | 5.1、6.1、8.1、13.3 P13、14.2 | 发现成立：Claude 按提示尾部 1,000 字符起标题（`session-titles.js:24–26`【事实】），第二版前移原话节对它无效；`_session/rename` 要等首个交接回合结束，回合 unknown 或 Hub 重启就不改；生成失败回退为原始首条提示；回写的公共标题不经脱敏。终稿：因交接新建的会话在 `session/new`（Codex `thread/start`）之后、首个提示之前回写（客户端定过标题即不再生成，`session-titles.js:130、175`；rename 允许未写盘的会话，`session-index/connection.js:147–158`【事实，VF3】）；`relay.title_set` 并入 `run.context_prepared` 事务；标题先过出境脱敏，有命中用“新对话”；P13 断言不出现 ai-title |
| VF3-13 | major | 部分修正 | 8.1、15、19 O9、20 Q14 | 采纳：Hermes 声明 `title: set`，Driver 在首个交接回合前代发 `/title` 并吞掉回执——`_run_slash` 本地作答、不向网关提交输入（`gateway_server.py:728–744`【事实，VF3】），第二版“多出一轮用户没发过的输入”的否决理由不成立，撤销否决（O9，D3）；探针断言回放行数不变、网关无新回合；OpenCode、dsh 在 P13 通过前列为“未保证”。未采纳部分：把标题行与来源说明挪到用户原话节之后作缓解——那会让模型在读到任何说明之前先读到一段无框架的用户话，削弱“这是历史”的定位；H9 验证的是原话前移，不是框架后移 |
| VF3-14 | major | 修正 | 14.4 | 发现成立：§14.4 只给绑定的纪元，v12 Run 的 `executedOn.nativeEpoch` 没写从哪来；填 1 时单 Harness `/clear` 之后的回合成了外来事实，升级后同一原生会话收到增量。终稿：迁移事务按事件顺序重放纪元谱系（`binding_prepared{resumed:false}`、`branch_requested`、归档各开一段，清空类命令各 +1），已派发 Run 的 `executedOn` 按派发时所在段写进索引；属性测试“单一 (harness, control) 的 v12 会话迁移后 20 轮 `dispatched === input`”（与 F02 同一处置） |
| VF3-15 | major | 部分修正 | 1 G3、4、9、13.3 P16、16 S6/S15、20 Q23 | 采纳（只限 process 型）：Hub 自己确认该回合的进程组已结束后，绑定改 ready 且 `suspect{cause:"unknown_turn"}`，提供“继续原会话”——只读 resume、按 `DeliveryPosition` 判用户条目是否入史、need=∅ 时原样续接、不重跑回合；P16 证明只读打开不触发回合，通过前 G3 写明不含这条路径；用户取舍 D6。未采纳部分：gateway 型也提前到本版——查看器退出不是静止证据（RT2-05），只读打开是否触发网关回合需 P-R1/P-R2 与独立 ADR，仍在 v1.1；进程组能否由新所有者确认（ADR-030 只记录保留的进程）列 Q23 |
| VF3-16 | minor | 修正 | 10.1、12.4、17 G073 | 发现成立：检查只看新增文案；“产品名除外”无清单；侧栏与“前往”菜单仍是“我的 Agent”（`Sidebar.tsx:101`、`HarnessesPage.tsx:171`、`App.tsx:823` 等 11 处【事实，grep】）；§10.1 文案写“目标程序”。终稿：检查扩到全部界面字符串与无障碍名，例外写成固定清单（`Hermes Agent`、`Claude Agent` 这类注册表名、`子 Agent`），既有 11 处在 G073 一并改为 Harness，“目标程序”改“目标 Harness” |
| VF3-17 | minor | 修正 | 9、10.2 | 发现成立：“权限不对即拒绝使用”加 O_EXCL 不许重建，`chmod -R 755` 之后跨厂商交接从此 fail closed；删掉重建则集合指纹全失配。终稿：属主是本用户时改回 0600 并告警；否则轮换、写新 `keyId`、放行记录失效并提示重新确认，摘要不因此 behind；RD-08 覆盖三种情形 |

## VF4 · 完整性（21 条）

| 编号 | 严重度 | 处置 | 节 | 理由 |
|---|---|---|---|---|
| F01 | blocker | 修正 | 4、6.3、7.1、7.2、8.1、14.3 INV-30 | 发现成立：`attach` 可取 `"none"` 但全文没有语义，plan() 只处理 full；fresh 行 j 格只要 recorded 就进 synced{contextThroughSeq} 不看 need，WorkBuddy 作目标时“只发这条消息”会把欠交历史记成已知且永不补交。终稿：plan() 首行 `attach=="none"` → 原样、不产生证据、sync 与水位不变（事件 n）；j 只在派发时 need=∅ 时生效；INV-30 测试加 attach none 与 WorkBuddy 两例（与 VF1-02、VF1-04 同一处置） |
| F02 | blocker | 修正 | 14.4 | 发现成立：RT1-B3 的迁移部分在第二版正文没有落实（处置表称已修正）；v12 下“10 轮 → native-reset → 新绑定首条 `/compact`”升级后旧 10 轮与新绑定同为纪元 1，need 可能为空而被视同 synced，10 轮永久丢失。终稿：按 `binding_prepared{resumed:false}`、`branch_requested` 与归档切分谱系，纪元 1..n、每次清空再加 1，v12 Run 的 `executedOn` 取派发时所在段；“reset + D1”夹具与属性测试（与 VF3-14 同一处置） |
| F03 | major | 修正 | 4、7.2、7.3、7.4 | 四处都成立：① synced 遇 outside_window / unavailable 时 §7.2 进 suspect 而 §7.4 说重发一次，送达行已是终态 recorded；② `verifyDelivered` 只回一个结果而 suspect 要“退回最后一个仍在的标记”，planReturn 还读 pending 的 mark；③ (pending, a) 写“不发生”而 i 列与 plan() 都会派发 resend；④ 不许自动重发的守卫只在注释里。终稿：① 保持 synced 只记 `relay.verified`；② 按标记逐个返回，pending 只核对自己；③ (pending, a) 定义为 resend 并写前提；④ plan() 写出守卫，不能自动重发时受理同步 409（未采纳“原样发送、状态不变”：那是静默降级，见 D1 与第 19 节） |
| F04 | major | 修正 | 3.2、4、7.5、8.1、14.1、14.3 | 发现成立：Driver 接口无法回报“原生会话已替换”；checkpoint 在派发前取得并在结算时置 ready（`runtime.ts:1378`、`:1496`【事实】）；归档必须带 native-reset 命令（`state.ts:418–424`【事实】），实现会抛 INVALID_TRANSITION 让 Runtime fatal（`:796`）。终稿：`BackendResult.native{cleared, replaced: {checkpoint}}`；§7.2 加 e′ 列（未确认）并把 e 定义为“Hub 确认”；`assertSessionTransition` 新增“写者 Run 的 `run.ended` 带 `native.cleared` 时允许归档 + 新建同 harness/control 绑定”，配无效样例（G066-C06） |
| F05 | major | 修正 | 3.1、3.2、9、10.2 | 发现成立：`recoverSession` 是领域纯函数（`state.ts:466`），由 `claimAndRecover` 在 Store 打开时调用（`sqlite-store.ts:579`【事实】），Coordinator 此时不存在，且 B1 禁止领域层引用应用层；领域层 `redaction.ts` 引用 infrastructure 的规则模块会让 G063 边界检查失败。终稿：领域纯函数 `recoverRelay(state, deliveries)`（`domain/relay/recover.ts`）由 `claimAndRecover` 在同一事务内调用；规则经 `SecretScannerPort` 注入，`redaction.ts` 以参数接收编译后的规则 |
| F06 | major | 修正 | 6.4、10.2 | 发现成立：目标的环境要到 prepare 时才算出（`binding-factory.ts:156`【事实】），交接时集合变大让 200 条摘要同时 behind，时延目标与 S4 走查失效。终稿：摘要用安装级集合（全部已配置 Harness 的引用值 + Hub 自身凭据 + 受管秘密），目标新带来的值只在出境前的最终复扫补上；LRU 键加集合 HMAC；配合 VF3-05 的命中区间，集合变化不再使摘要 behind |
| F07 | major | 修正 | 3.1、3.2、6.4、7.3、10.4、12.4、14.1 | 发现成立：`transact` 每次重写整份快照（`sqlite-store.ts:343–363`【事实】）、`commit` 遇意外错误一律 `fail()`（`runtime.ts:796`【事实】），懒重建、idle 时的 `realized`、回合外 `relay_windows`、无会话的同意都没有提交路径；`relay.crossVendor` 与返回偏好没有表也没有 API；7.6 MiB 一次提交约 144 ms 做不到“每片 ≤20 ms”。终稿：`SessionStore.relayWrite(id, rows)` 单独事务、不升 version、只写派生行；安装级 `RelayLogPort.append / upsertWindow / setPref`，各写明所有者与失败语义；`realized` 在下次需要 R̂ 时惰性结算；`relay_prefs` 表与 `GET/PUT /api/v1/relay/prefs` |
| F08 | major | 修正 | 4、14.1、14.3 INV-35 | 发现成立：ID 只由正文派生而 `consentLogSeq`、输入 HMAC 这类逐 Run 字段存在 `relay_packets`，`INSERT OR IGNORE` 会静默丢掉第二个 Run 的清单；OR IGNORE 跳过 CHECK 违例随后外键错误（787）、`ON CONFLICT DO NOTHING` 照报 CHECK 错误（275）、同值写被触发器拒绝（1811）【VF4 实测，SQLite 3.53.4】，都会让 Store failed。终稿：逐 Run 字段移到 `relay_deliveries`；写入改用 `ON CONFLICT DO NOTHING` 并在应用层先查存在；INV-35 收窄为“预期内的接力失败只让本 Run 失败；SQLite 约束错误仍是 bug，由应用层校验与无效样例保证不出现” |
| F09 | major | 修正 | 5.1、5.5、14.1、14.2、14.3 INV-29 | 发现成立：§5.5 两处自相矛盾；`relay_pins.quote` 与 `relay.pin_added` 存原文而 INV-29 覆盖它们。终稿：当前输入一律原样只脱敏历史（O8）；钉住改存 `(messageId, start_offset, length)` 与 `quote_hmac`，渲染时取原消息子串；事件不含原文 |
| F10 | major | 修正 | 3.2、4、6.1、10.4 | 发现成立：`send()` 同步（`runtime.ts:343`【事实】）而 control 实例在租约与环境之后才建立（`binding-factory.ts:147–172`【事实】），`relay?` 挂在实例上受理时拿不到；厂商键函数只读变量名却要产出 `gateway:<host>`。终稿：Driver 模块导出静态 `relayCapabilities`，`factory.relayCapabilities(harnessId)` 同步读取；结算时把 `VendorObservation{model, modelKey, authKind, endpoint, loopback}` 缓存到 `binding.relay.vendorObserved`，admit 只读这份缓存（与 VF3-01 同一处置） |
| F11 | major | 修正 | 6.1、9、12.4 | 发现成立：finalize 在 open 与 `binding_prepared` 之后（`codex.ts:350`、`runtime.ts:1384`【事实】），第二版却写“绑定不变”“启动前判定”；`RELAY_INPUT_LIMIT` 列为 429 但在 Run 建立之后抛出 HTTP 已无从返回。终稿：第 9 节加“错误码按阶段”表（受理时 / 启动前 / open 后），写明 open 后失败时 Run 失败未派发、原生会话与绑定保留（`runtime.ts:1496` 未派发不推进 throughRunId）、下一次按空会话 resume、relay 状态不变；窗口检查前移到 admit（保守窗口）并在 finalize 复判；`public-api.md` 写明 409 只覆盖受理时可判定的情形 |
| F12 | major | 修正 | 4、13.1、14.1、14.2、14.4 | 四条都成立：RT1-M1 的 fold 校验替代 K7、RT2-19 的 `message.accepted` 扩展、RT1-m6 的 legacy chain、RT4-M2 的 RD-06 在第二版正文缺失。终稿：`relay_packets` 写入时校验 fold 单元已终结且用户消息早于当前输入（`state.ts:359–361` 的校验由它替代）；`message.accepted` 带 `relayRequest`；legacy 的 chain 取 sha256("")；RD-06 拆成 06a（出境范围）与 06b（既有命令指纹，登记为已知违例） |
| F13 | major | 修正 | 2、4、8.1、12.1、14.1 | 发现成立：能力声明要等探针通过才生效而探针在最后的 G074，没有发布门，结果要么六家全部 409、要么全部 unknown 并重发；按版本门控又与 ADR-053 冲突。终稿：两态“已声明 / 已探针”——`RelayCapabilities.probed` 静态布尔，P2、P3、P6、P11 在最新正式版通过后翻转（版本只作证据）；生产只对 `probed=true` 开放，`probed=false` 走 `RELAY_TARGET_UNVERIFIED`；开发经 `relay_prefs` 的 `relay.allowUnprobed`（默认 false）放开；用户取舍 D11 |
| F14 | major | 修正 | 11.1、13.3、18.2 | 发现成立：J3 M1 的“另做真机两家”与 J2 M10 的冷回合计数在第二版缺失。终稿：P15 真机零注入两家各 20 轮（含 `/clear`、压缩后、外部编辑后），从原生转录读回断言逐字节相同；`realized.closedBy` 与 `relay.verified` 计数进诊断视图；§18.2 补两行 |
| F15 | major | 修正 | 17 | 发现成立：第二版只列 G006 与 G010 两个所有者，被改动的文件还分属 G004、G007、G008、G026、G028、G031、G032、G034、G050、G054、G059、G060、G064；`web/src/lib/api.ts` 不存在（实际 `web/src/api.ts`）；花括号与通配写法不能登记；`docs/contracts`、`invariants.md` 无主；G024-C02 与 C006-C02 的“超限时报错”与设计冲突。终稿第 17 节重写为任务 G066–G077：每个任务写标题、依赖、新建文件（唯一所有者，目录按整目录归属）、现有文件及其所有者、需求（只用已有编号）、不变量、范围、不做什么、验收、用例（含层级）；旧议程的 C006 改写、G006 与 G056 保留、G024 / G025 / G045 / G046 接管并写明用例去向；两条冲突用例改写；切片 `relay` 的 decision、task_ids 与 allowed_files 写明 |
| F16 | major | 修正 | 14.3、17 | 发现成立：`check_design.py:412` 要求每个 INV 都有计划用例，第二版只写了验证方式。终稿：§14.3 加“计划用例”列，INV-13、14、21、22、29、30、31、32、33、35、36 各指向第 17 节的具体用例 ID（security / integration / property / probe），INV-34 指向 G077-C01（deferred，v1.2 生效） |
| F17 | minor | 修正 | 0、4、11.1、12.2 | 三处都成立：绑定 ≤512 B 沿用第一版实测；模板约 445–460 token 超 420 且 `FRAME_CAP` 的 est/2 口径与 o200k 不同；10 个视图只按 8 个写预算。终稿：绑定上限 ≤1,024 B 用最长取值断言（VF2-14）；`FRAME_CAP` 按语言 × kind 由 CI 以 o200k 口径生成（VF2-02）；预算段写明 v0 为 8 视图的费用、V-order 与 V-rb 两个对照臂在 pilot 内按同价估算 |
| F18 | minor | 修正 | 2、4、6.2、7.3、9、10.1、14.3 | 发现成立：`brief` 同时指档位与包类型；K、Q 两套编号混用；O16 不存在；“INV-01–28 不变”与改写 INV-13 等矛盾；reason 枚举缺 `storage_quota`；`S_A` 未定义。终稿：要点包改名 `anchor`（`kind`、`SectionId`、DDL 一并改）；K 指 RT2 崩溃注入点、Q 指第 20 节问题，两处引用都加来源；O16 的引用改为“第 19 节的否决表”；§14.3 标题改为“改写 INV-13、14、21、22、29、30、33，新增 31、32、34、35、36，其余不变”；`RELAY_PREPARE_FAILED` 的 reason 集中列出（加 `storage_quota`、`classification_changed`）；`S_A` 在 7.3 定义为本纪元首个请求的固定前缀 |
| F19 | minor | 修正 | 5.6、16 S1 | 三处都成立：`summary.ts` 新文件的 numstat 是最终行数 58 + 4 − 1 = 61；“第 3 轮期间 +9 −4”推不出（观测只在交接边界）；S1 的档位是标准不是“完整记录”。终稿：改 +61 并加解释；增量样例改写为“与你上次看到的版本相比 +9 −4（两次观测之差）”；S1 标为“交接单（标准）” |
| F20 | minor | 修正 | 3.2、4、8.1、17 G074 | 四处都成立：Hermes 位置“标题行”不在位置类型里；`deliveryPosition` 晚于写入它的事务；Unicode 版本不在 `policyVersion`；接续等级从字符串改对象而现有事件用旧格式；删 `spikes/relay` 会让 `check_design.py:384` 报断链。终稿：Hermes 用 `{kind:"seq", before: 回放条目计数}`；`deliveryPosition` 在 finalize 之后、`context_prepared` 事务之前调用；`policyVersion` 的变化项加 Unicode 版本（Node ICU）；解析器同时接受旧字符串（`runtime.ts:275`【事实】）；原型目录保留不删，测量脚本迁入后在 README 加“已迁移”一行 |
| F21 | minor | 部分修正 | 8.1、9、12.1、14.2 | 采纳：`relay.exclusion_withdrawn` 的语义（只影响之后的包，已越过的不补交，界面写明）；`relay_log` 触顶时同一事务轮转到 `relay_log_archive`，仍满则 `RELAY_UNAVAILABLE{consent_log_full}`；交接单永久留在原生转录的取舍写进 §8.1（接受：它就是目标收到的历史），v1.1 文件视图可换成短指针作缓解。未采纳部分：撤回后重新欠交——与 VF1-14 同一理由，need 保持单调 |

## 处置引出的用户取舍

| 取舍 | 来源 | 推荐 |
|---|---|---|
| D1 送达未确认时同步 409 三选一，而不是原样发送 | VF1-02、F03 | 409 |
| D2 `MIN_PACKET` 按族生成，约 27k 以下的目标在受理时失败并提供“只发这条消息” | VF2-01 | 采纳 |
| D3 Hermes 代发 `/title` | VF3-13 | 采纳 |
| D4 第二段永远原样，卡片提示 | VF3-06、F09 | 采纳 |
| D5 `relay-key` 与附件物化移出数据根 | VF3-11 | 采纳 |
| D6 process 型“继续原会话” | VF3-15 | 采纳，P16 门控 |
| D7 account 与 api_key 同记一个厂商键 | Q11 | 同记 |
| D8 默认数据根只做检查，默认值另立 ADR | Q9 | 另立 ADR |
| D9 冷返回默认续接、按全程差并列 | VF2-07 | 保持 |
| D10 RelayBench 的两级界值与预算 | VF2-13 | 采纳，预算另批 |
| D11 未探针的 Driver 不开放 | F13 | 采纳 |

## 未处置的事项

本轮没有未处置的 blocker 或 major。四份报告的“假设与未核实”项全部进入终稿第 20 节：Q22（Claude `/clear` 保留模型）、Q23（进程组确认与 bash 模式转录）、Q24（各家端点优先级）为本轮新增，Q2、Q3、Q14 按报告更新。

## 写入阶段矛盾的处置

对象：[writer-conflicts.md](writer-conflicts.md) 汇编的 98 条（ADR-055 作者 15、交接内容契约 26、切换与存储契约 16、公开接口与安全契约 16、不变量 13、实施计划 12；有重复）。处置人：总架构师 Fable 5.1，2026-11-03。处置取值：**修正**（终稿按裁定改写，相关已写文件定点对齐）、**确定**（终稿补上原来没写的值或规则）、**未决**（列出承接任务，实现前须定）。各作者在自己文件里的处理与终稿修订不一致的地方已定点改回一致；`plan/*.json` 与生成视图由计划作者按本节同步。总裁定与理由：

1. **受理检查的前提**（ADR 12、契约 17、切换 7、安全 A13、不变量 7）：第 6.1 节的接力检查（探针、数据根、选择、同意、`MIN_PACKET`）只对将要携带接力内容的回合生效——need≠∅、用户选了 `attach:"full"`、或存在外来事实（F≠∅）而绑定 suspect 且 cause ∈ {rewind, unknown_command, clear_unconfirmed, unknown_turn}（水位存疑，need 要核对后才知道）；need=∅ 的回合、`attach:"none"` 的回合与单 Harness 对话（F=∅）不做任何接力检查、永远不被接力阻挡。比裁定原文多出第三种前提，理由：rewind 之后的 need=∅ 是按存疑的旧水位算的，7.2 要求先核对，而“单 Harness 对话不阻挡”用 F=∅ 表达正好覆盖裁定的本意。数据根的拒绝只针对跨厂商交接，任一来源的厂商键与目的不同就算跨厂商。
2. **HTTP 状态**（ADR 4、切换 3、接口 A1、计划 2）：`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED`、`RELAY_UNAVAILABLE`、`RELAY_TARGET_UNVERIFIED` 为 409，`RELAY_INPUT_LIMIT` 沿用现有 LIMIT 规则为 429；删掉“全部由 `server.ts:266` 映射为 409【事实】”；`RELAY_TARGET_UNVERIFIED` 不匹配现有子串规则，实现时由 G073 经 G050 为它显式加 409 映射（第 6.1、9、12.4、17 节）。
3. **D5**（切换 12、安全 A4、存储 R7）：HMAC 密钥放在数据根之外；附件物化目录按会话建在数据根之外（0700、名字不可猜测），保留 ADR-023 第 3 条的稳定只读副本语义（后续回合仍可按同一路径读取，缺失即重新物化），随会话删除；不再每个 Run 一个目录、随 Run 删除（状态与验收 D5、第 3.1、9、10.1 节；ADR-055 的 D5 行与 ADR-022/023 行、security.md、storage-events.md、invariants.md 对齐）。
4. **`relayRequest.fingerprint`**（契约 24、安全 A5）：改用 HMAC 会话子密钥，新增 `HmacDigest` 类型；Web DTO 不带它（第 4、12.4、14.2 节）。
5. **交接单 ID 只由正文派生**（契约 20、安全 A6、不变量 4）：正文不变时 ID 与清单不变；脱敏上下文（`rulesVersion`、`keyId`、`setHmac`）与同意 seq 记在送达行（`relay_deliveries` 加三列，`relay_packets` 去掉两列）；删除“脱敏上下文变化即换新 ID 并写 `supersedes`”，`supersedes` 只用于 resend（第 4、10.2、14.1、14.3 节）。
6. **API 返回存储的正文**（契约 23、安全 A7、接口 7）：即发出时的字节，不在返回时复扫，`ETag` 为存储正文的 sha256；出境扫描只在为发送而渲染时做一次，“API 返回的正文”从出境复扫清单删除（第 10.2、12.4 节）。
7. **状态机补全**（切换 4、5、6）：`suspect` 增加 `carried{prior, packetId, range}`（只在 cause=unknown_turn 且 unknown 回合携带了包时非空），k 列按 carried 推进到 P 的区间或回到 prior；`verify_unavailable` 与 `vendor_changed` 没有产生它们的转换，从 `SuspectCause` 删除（核对不可用走 `RELAY_CHOICE_REQUIRED{verify_required}`，厂商键变化走 `RELAY_CONSENT_REQUIRED{vendor_changed}`），放行集合收为 {legacy, marker_absent}；`RELAY_CHOICE_REQUIRED` 的 cause 补 `verify_required`；属性测试断言 4 种状态 × 14 种事件没有未定义组合、每个 `SuspectCause` 取值都由某个转换产生（第 4、6.1、7.2、9、12.4、17 节）。
8. **不变量措辞**（不变量 1、2、5、8）：INV-30 写成“同一纪元内 mark 只在 suspect 回退时变小；清空进入新纪元”，7.2 属性与 `assertSessionTransition` 规则同步；INV-33 补“目的厂商指主模型请求的实际处理方……”并把 `local` 豁免（`relay.localModelsOffline`）登记为唯一例外；INV-22 恢复“配置与原生状态不能替代公共事实源”“读模型可重建”两句，接力条款作为补充；`docs/domain/invariants.md` 的对应条目同步。
9. **数字与引用统一**：11 张表加 4 个触发器（第 14.4 节）；每绑定 ≤1,024 B（18.2 J2 M13、Q7）；10 种形式逐一列出（第 10.2 节，18.2 J4 M1）；capWindow 各处含 S_new（第 0 节）；不可信文本 goal 档 375（第 0、5.3 节）；探针六家 P1–P14、Claude 与 Codex 另跑 P15、P16（第 2、13.3、17 节）；术语表区分 C2 的 K8 与 RT2 的 K1–K18；代码引用改正（`context.ts:27–28` 来源选择、`:56–58` 预算检查、`runtime.ts:1337–1339`；`hermes.ts:120–122`；`state.ts:418`、`410–464`；`Turn.tsx:170–179`）；`docs/HANDOVER.md:184–185` 存在，第 10.1 节改为核实过的事实；ADR-006 没有独立文件，C006 改为在 ADR 索引的 ADR-006 一行登记取代关系（经 V008）。
10. **其余各条**逐一见下表；能确定的已写进终稿，仍未决的列“承接任务”。

计划层面（终稿第 17 节；`plan/*.json` 由计划作者按此执行）：(1) `ContentPort.readText`：G070 的范围写明经 G004 改 `src/contracts/content.ts`、经 G008 改 `content-store.ts`；(2) G066-C08 → `tests/performance/relay-store.test.ts`、G070-C06 → `tests/integration/relay-digest.test.ts`、G071-C05 → `tests/platform/workspace-observer.test.ts`、G072-P01 → `tests/property/relay-coordinator.test.ts`，各加进所属任务的 owns；(3) G073 加 INV-29、G069 加 INV-33，另把 G070 加 INV-36、INV-21 的计划用例加 G067-C07（不变量作者发现的缺口，同样补上）；(4) `spikes/relay/README.md` 加进 G074 的 owns；(5) 旧用例接手映射按语义修正（G024-C01–C03 → G070-C02、G070-P01 与 G066-C03、G070-S11 与 G070-S01–S10；G025-C01–C03 → G068-C06、G066-C03、G068-P01；G045-C01–C03 → G072-C01、G072-C04、G072-P01；G046-C01–C04 → G072-C03、G068-C09 与 G074-C02、G072-P01、G072-C10 与 G068-C08）；(6) S5 按钮统一为“［等这一轮结束］［停止并切换］”；(7) G028、G047、G050、G059 对 G025、G045、G046 的依赖不改，relay 切片的 note 写明用户验收后改指 G068 与 G072。

### ADR-055 作者（15 条）

| # | 处置 | 终稿落实 |
|---|---|---|
| 1 | 修正 | 14.4 改为 11 张表与 4 个触发器 |
| 2 | 修正 | 18.2 J2 M13 与 Q7 改为每绑定 ≤1,024 B |
| 3 | 修正 | 5.3 与第 0 节：goal 档 375（按 `TIER_CAP.goal` 2,500 重算） |
| 4 | 修正 | 总裁定 2 |
| 5 | 修正 | D9 行按 7.3 改为冷热都适用，加 N/W ≥0.85；ADR-055 删去提醒 |
| 6 | 修正 | 14.3 标题与标签改为“改写 INV-13、14、22，扩展 INV-21；新增 INV-29–36”，INV-29、30、33 标“新，相对第二版改写” |
| 7 | 修正 | 10.1 引 `docs/HANDOVER.md:184–185` 为核实过的事实 |
| 8 | 修正 | 总裁定 9：C006 在索引登记取代关系，不建文件 |
| 9 | 修正 | 第 17 节 G006 与 G067 行改为 `context.ts:27–28` 来源选择、`:56–58` 预算检查；12.1 改 `Turn.tsx:170–179` |
| 10 | 修正 | 第 0 节 capWindow 含 S_new |
| 11 | 修正 | 13.3 与 G074：六家 P1–P14，两家 P15、P16；R01/R03 的 P14 分工写明 |
| 12 | 修正 | 总裁定 1：数据根只拦跨厂商 |
| 13 | 修正 | 第 4 节“新增事件”补 `message.accepted` |
| 14 | 修正 | 18.2 J4 M1（10 种形式）、J2 M15（最后一个请求的开始时刻）按正文改 |
| 15 | 确定 | `relay.allowUnprobed` 是 `relay_prefs` 的行，可经 PUT 写，不在设置页露出（3.1、12.4） |

### 交接内容契约（26 条）

| # | 处置 | 终稿落实 |
|---|---|---|
| 1 | 修正 | 5.3 的 delta 行按 6.3：扩展到 min(DELTA_USER_EXT + 固定部分, T)，原话最多 2,000 |
| 2 | 修正 | goal 档 375 |
| 3 | 修正 | capWindow 含 S_new |
| 4 | 修正 | 第 2、4 节索引列改为约 1,485 B、CHECK 2,048 B（RT3 的 200 B 是第一版形状） |
| 5 | 确定 | `counts` 为每个 `OmissionCategory` 一个计数（16 类） |
| 6 | 确定 | 6.3 引入 candidates（排除前的候选单元），恒等式按它计数，用户排除以 excluded{by:"user"} 计入 |
| 7 | 修正 | N19 与 10.2 统一：没扫过的字节不发，需扫范围超过 64 KiB 的条目整条省略并记 unscanned |
| 8 | 确定 | G2 用 RunDigest 存下的 head（≤3,000 字）与 tail（≤800 字）；字数只是存储字段上限，预算按 token；余量 ③ 按 token 受 U |
| 9 | 确定 | 12.2“完整记录”= complete=true：用户消息、回复、计划三类为 0 且无未扫描条目；`OmissionCategory` 没有失败类 |
| 10 | 未决（承接 G070） | 英文 delta、anchor、resend 与中文 resend、英文单元标题与结尾句列为 G070 带黄金文件的交付物（5.4、17）；5.6 的增量样例已补全 7 条约定 |
| 11 | 修正 | 第 0 节 policyVersion 列入 Unicode 版本（Node ICU） |
| 12 | 确定 | goal_only = 只允许 tier=goal 的交接单（第 4、10.4 节） |
| 13 | 确定 | 按名排除只作用于 (a)(c)，(b)(d) 不看名字全进；值形状排除作用于四类（10.2） |
| 14 | 确定 | `noteIncluded` 指用户附言（第 4 节） |
| 15 | 确定 | “从 n−2 往前”= 从倒数第二个单元（0 起计）往前（6.3） |
| 16 | 修正 | 5.1 按 O6 改写：其他绑定上 not_recorded 的回合是外来事实并注明；本绑定自己的不是 |
| 17 | 修正 | 总裁定 1 |
| 18 | 确定 | 先按单条上限头 4 : 尾 1 截断，仍放不下才在保留的头尾里用词表挑整句删（6.3） |
| 19 | 修正 | 取消“只发计数通知”：撤回后返回 A 走 `RELAY_CONSENT_REQUIRED{missing}`，选项［重新同意］［只发这条消息］（10.4） |
| 20 | 修正 | 总裁定 5 |
| 21 | 修正 | 10 种形式逐一列出 |
| 22 | 修正 | 10.6 威胁表改为第二段永远原样 |
| 23 | 修正 | 总裁定 6 |
| 24 | 修正 | 总裁定 4 |
| 25 | 修正 | 10.4 改为送达行记录 consentLogSeq |
| 26 | 修正 | Q7 改为 1,024/320 B |

### 切换与存储契约（16 条）

| # | 处置 | 终稿落实 |
|---|---|---|
| 1 | 确定 | 14.2 run.ended：等待该切换的排队 Run 以 `SWITCH_NOT_EFFECTIVE` 失败（status failed，沿用 `runtime.ts:1308–1310` 的用法） |
| 2 | 修正 | 11 张表与 4 个触发器 |
| 3 | 修正 | 总裁定 2 |
| 4 | 修正 | 总裁定 7：`suspect.carried` |
| 5 | 修正 | 总裁定 7：删除两个 cause |
| 6 | 修正 | 总裁定 7：cause 补 `verify_required`，6.1、9、12.4 列全选项 |
| 7 | 修正 | 总裁定 1 |
| 8 | 修正 | capWindow 含 S_new |
| 9 | 修正 | 1,024 B |
| 10 | 确定 | 四个键都是 `relay_prefs` 的行、都可经 PUT 写；`allowUnprobed` 开发用不露出 |
| 11 | 确定 | `relay_recovery_failed` 存快照字段 `SessionSnapshot.relayRecoveryFailed`（该次 `session.recovered` 的 seq，事件带 `relay.failed`），之后携带接力内容的回合受理即 `RELAY_UNAVAILABLE{recovery_failed}`（第 9、14.2 节） |
| 12 | 修正 | 总裁定 3 |
| 13 | 确定 | 14.1 新增“回收”段：每个 Run 只留当前 policyVersion 的摘要行、`relay_windows` 30 天、`relay_log_archive` 只增不删上限 1,048,576 行；`relay_digests.status` 删 failed |
| 14 | 修正 | 第 2 节术语表区分两个 K8 |
| 15 | 修正 | `hermes.ts:120–122`；`context.ts:27–28` 与 `:56–58` |
| 16 | 修正 | 第 4 节补 `message.accepted`；14.3 标签按仓库基准；备份回读的 11 张表只对 v13 及之后的来源有意义（14.1 代码点） |

### 公开接口与安全契约（16 条）

| # | 处置 | 终稿落实 |
|---|---|---|
| A1 | 修正 | 总裁定 2 |
| A2 | 修正 | 第 9 节 open 之后一栏补 `RELAY_CHOICE_REQUIRED{marker_absent ｜ verify_required}` |
| A3 | 修正 | 10.6 威胁表改为第二段永远原样 |
| A4 | 修正 | 总裁定 3 |
| A5 | 修正 | 总裁定 4 |
| A6 | 修正 | 总裁定 5 |
| A7 | 修正 | 总裁定 6 |
| A8 | 确定 | 接续等级在 API 与快照里统一叫 `continuity`（12.4） |
| A9 | 确定 | 删除 `observation_required`：观测失败或超时从不让准备失败（第 9 节） |
| A10 | 确定 / 未决 | (1) `relay.returnPreference ∈ {continue, new_when_cold, ask}`；(2) `DELETE /api/v1/relay/consents/:vendor` 撤回 global，`DELETE …/sessions/:id/relay/consents/:vendor` 撤回 session；(3) `GET /api/v1/relay/consents` 读出，`GET …/sessions/:id/relay` 列本会话有效记录；(4) 四个键都可经 PUT 写；(5) `RELAY_UNAVAILABLE{recovery_failed}`；(6) 取消“只发计数通知”，走 `RELAY_CONSENT_REQUIRED{missing}`；(7) 厂商键变化 `RELAY_CONSENT_REQUIRED{vendor_changed}`（受理时 409、open 后 Run 失败），撤回后返回 A 为 `missing`；(8) `attach:"none"` 跳过全部接力检查。请求与响应的最终字段仍由 C009 冻结 |
| A11 | 未决（承接 C009、G073） | 事实流新增 `{ type: "relay", event }` 帧、错误体扩展 `relay?: {binding, cause, options, counts}` 成员（12.4 写明方向，形状由 C009 冻结） |
| A12 | 修正 | `GET …/relay/preview?observe=true` 改为 `POST …/relay/observe`，走写请求的 CSRF 与同源校验（10.4、12.4、17、19） |
| A13 | 确定 | 任一来源的厂商键与目的不同即算跨厂商（10.1、INV-36） |
| A14 | 确定 | `admit` 只做 `(st_dev, st_ino)` 比较；标记查找在启动时与工作区顶层目录 mtime 变化时做并缓存，不进受理→派发增量预算（10.1，G072） |
| A15 | 修正 | 10 种形式逐一列出；consentLogSeq 在送达行 |
| A16 | 修正 | 11 张表；1,024 B |

### 不变量（13 条）

| # | 处置 | 终稿落实 |
|---|---|---|
| 1 | 修正 | INV-22 恢复两句通用条款，接力条款作为补充 |
| 2 | 修正 | INV-33 补“目的厂商指主模型请求的实际处理方……” |
| 3 | 修正 | 10.6 威胁表改第二段原样；INV-29 写明例外同样适用于出境字节一句 |
| 4 | 修正 | 总裁定 5；INV-13 改为“正文不变则 ID 与清单不变……脱敏上下文在送达行” |
| 5 | 修正 | INV-30 统一措辞；7.2 属性与 `assertSessionTransition` 同步 |
| 6 | 修正 | 第 17 节 G073 加 INV-29、G069 加 INV-33、G070 加 INV-36；INV-21 的计划用例加 G067-C07 |
| 7 | 修正 | 总裁定 1 |
| 8 | 修正 | INV-33 把 `local` 豁免登记为唯一例外 |
| 9 | 确定 | INV-21 的“relay 状态不变”= 不建交接单行、送达行与 pending、水位不被这次准备推进；open 时的回放核对结果是事实、照常随 `run.ended` 提交（第 9、14.3 节；G072-C04 的预期同步） |
| 10 | 确定 | INV-14 在 v12 只部分成立已是 7.6 的已知局限，不另改 |
| 11 | 修正 | 14.3 标签按仓库基准 |
| 12 | 修正 | `state.ts:418`、`410–464` |
| 13 | 修正 | 11 张表；1,024 B；“INV-11 的恢复路径”引文属 INV-12——第 8.2 与 19 节的引文改为 INV-12（见下） |

### 实施计划（12 条）

| # | 处置 | 终稿落实 |
|---|---|---|
| 1 | 修正 | 11 张表与 4 个触发器 |
| 2 | 修正 | 总裁定 2；G072-C02 与 G073 验收按 429/409 改写；G073 范围加 `server.ts` 的映射扩展 |
| 3 | 修正 | G073 加 INV-29（计划层面 (3)） |
| 4 | 修正 | 1,024 B；10 种形式；最后一个请求的开始时刻 |
| 5 | 修正 | 四条用例改到对应层级的新文件并加进 owns（计划层面 (2)） |
| 6 | 修正 | G006 与 G067 行写全路径与正确的行号含义 |
| 7 | 确定 | 依赖不改，relay 切片 note 写明验收后改指 G068 与 G072（计划层面 (7)） |
| 8 | 修正 | `ContentPort.readText` 归 G070 范围，经 G004 与 G008 修改（计划层面 (1)） |
| 9 | 修正 | `spikes/relay/README.md` 加进 G074 的 owns（计划层面 (4)） |
| 10 | 确定 | G076、G077 及其用例保持 deferred 并带 defer_reason |
| 11 | 修正 | 旧用例接手映射按语义修正（计划层面 (5)） |
| 12 | 修正 | S5 按钮统一（计划层面 (6)） |

### 仍未决的事项与承接任务

- 英文 delta、anchor、resend 模板与中文 resend 模板、英文单元标题与“未包含”结尾句：G070 带黄金文件交付并评审后进 `policyVersion`。
- 事实流的 `relay` 帧与扩展错误体的字段形状：C009 冻结，G073 实现。
- `RELAY_TARGET_UNVERIFIED` 的 409 映射：G073 经 G050 扩展 `server.ts:265–266`。
- 接续等级字段名（`continuity`）、同意读出与两个范围的撤回接口、`relay.returnPreference` 取值等本节“确定”的 API 细节，仍以 C009 冻结的契约为最终形状。
- `plan/tasks.json`、`plan/test-cases.json`、`plan/slices.json` 与生成视图按本节的计划层面 (1)–(7) 以及“G070 加 INV-36、INV-21 加 G067-C07”同步：计划作者。
