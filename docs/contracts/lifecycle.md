# 接收、执行、停止和恢复

状态：proposed。公共 Turn、实际 Attempt、原生绑定与清理不能共用一个布尔状态。

## 1. 阶段与事实

Turn：accepted → queued → planning → executing → settling → ended；可出现 rejected、cancelled、timed_out、interrupted。Attempt：allocated → preparing → running/waiting_permission → stopping → settling → terminal。具体闭合集合由 schema 冻结，不将示意状态名当作最终 wire 字段。

结果至少分四个面：execution（正常结束、失败、取消、期限、未知）、modelEvidence（完整、缺口、不适用）、outputs（齐全、缺失、错误、不要求）、cleanup（确认、未确认、失败）。Evaluation 如存在是第五个独立结果，不覆写运行事实。

## 2. 受理与执行权

Session 聚合以 CAS 接收命令并保留有界队列。只有带 Session epoch、Attempt generation 和工作区租约的执行计划才能启动。执行前重新核对 admission revision/能力与策略；资源被停用或目标不再可用时明确失败，不换一个候选冒充原选择。

accepted 事务与 outbox 的失败是未受理；提交成功但响应丢失可用同 key 查询/重送。派发成功与 Worker 接收之间的未知窗口依靠派发记录、控制身份和恢复核对处理，不能承诺外部工具 exactly-once。

### 可撤销的启动授权

Session 根是 ExecutionGrant 的唯一签发者。Grant 绑定 Session/Turn/Attempt、epoch、单调 controlSeq、grantVersion、ownerGeneration 及 issued/authorized/revoked 状态；每个 Session 最多一个有效授权。执行意图不是启动许可。

取消、close、切换及 deadline 命令按 Session 控制顺序持久仲裁。先取消而尚未授权的 Turn 留不可逆 tombstone；后来首次收到旧 outbox 也不能授予执行权。同一 epoch 不足以证明授权仍有效。

Execution 在第一次派发前经 Session 控制仲裁器取得 start authorization；保存派发身份后才能发送给 Worker。Worker 只接受绑定该身份的启动，并维护控制序号/取消 tombstone；重排、迟到和重复启动拒绝。启动授权和取消的线性化顺序必须能从持久事实证明。

若 start authorization 先于取消，取消只表示停止意图，不能承诺此前授权的操作从未开始；若取消先于授权则禁止后续启动。所有网关管理的后续模型/权限/工具派发核对当前 grant 与 controlSeq；原生 Harness 内部工具只能按已验证的停止/隔离能力约束，不能假称逐操作均可被网关仲裁。

恢复时重新核验授权、派发记录与停止证据；未知派发不重新启动。取消消息无法送达或旧后端状态未知时，工作区与绑定继续隔离，直到确认静止才允许切换。

## 3. 期限与控制仲裁

每个 Turn 有两个预算，由 Runtime 用单调 clock 计时（[ADR-036](../decisions/0036-approval-wait-budget.md)）：

- **执行预算**（默认 300 秒）从派发开始计，覆盖路由、上下文、启动、模型、工具和结果采集；Turn 等待用户决定期间暂停。到期以 `RUN_TIMEOUT` 停止。
- **等待预算**（默认 30 分钟，上限 2 小时）覆盖两种外部等待：等待用户的审批或回答，以及排队等待同一工作区中另一个 Session 的 Turn 结束。等待用户时到期：仍在等待的请求记为 expired，原程序收到取消或拒绝，绝不收到批准，然后以 `WAIT_EXPIRED` 停止。排队时到期：Turn 以 `WORKSPACE_BUSY` 结束，从未派发，记录持有者，不自动重试。

两种停止都走正常停止链：在停止 grace 内结算的记为已取消，否则结束进程并记为未知。停止原因一旦判定，不被 grace 内晚到的完成改写；原程序报告的结果单独记录。等待空位（同时执行的 Session 已达上限）不计入预算，也没有单独的期限：空位由其他 Turn 的预算保证释放，按受理先后分配；等待中的 Turn 说明有几个 Session 在执行，可以取消。驱动只保留远大于两个预算之和的硬上限，用于兜底协议挂死。

持久时间戳供恢复核对，单进程内使用单调 clock；系统时钟跳变不可延长预算。预算消耗只在内存中：服务重启后，进行中的 Turn 按恢复规则记为未知或中断，不恢复计时。进入和离开等待记为事件。清理 grace 独立有界。

**与原“总期限从受理起算”的差异和理由（ADR-036 裁决）。** 用户离开时的等待、另一个 Session 占用工作区的时间，都不是这个 Turn 自己的执行。计入同一个期限会让 Turn 在用户回来之前超时并成为结果未知，这与在原程序中使用的体验不一致。因此，外部等待改用独立的、有上限且可见的等待预算，到期以可结算的取消结束；执行预算只计算 Turn 自己的工作。

取消、deadline、后端完成、存储故障与切换由应用/领域仲裁排序处理。已生效停止原因不被晚到完成改写；重复取消幂等。事件流结束、协议 ACK、模型末块或 exit 0 都不是唯一完成证据。

## 4. 取消与清理

持久记录意图 → 对实际待决权限返回取消结果 → 协议 requestStop → 等待后端证据 → 关闭绑定 → 必要时升级终止进程树 → 采集残留与调用状态 → 提交结果/隔离资源。

后端愿意停止、操作系统已终止进程、工作区不再被旧执行者写入是不同证据。无法确认停止时，后续写执行被阻塞；不能只因清理 grace 到期释放租约。

## 5. 崩溃与恢复

启动时先取得公共 owner lease，检查持久命令、outbox、Attempt、Binding、进程归属与工作区租约。已有终态正常重放；仍活且归属验证通过的进程先受控收敛；未能证明结果的尝试标 interrupted/unknown。

原生恢复需要同 Harness/Adapter 版本、后端身份、checkpoint 指纹和 manifest 水位匹配。失败不能创建空原生会话后声称恢复成功。可显式 public_context_rehydrate，但必须显示降级接续等级，并不重新执行旧工具或旧输入。

## 6. 最小并发承诺

同 Session 串行写执行；多 Session 有界并行；工作区写权独立于 Session。排队有长度/字节上限、FIFO 或明确公平策略、取消和期限。先从这些可证明的规则开始，不依赖“Node 单线程所以没有竞态”。

当前实现（ADR-036）：

- 最多 4 个 Session 同时执行，空位按受理先后分配。
- 同一工作区由正在执行的 Turn（运行中，或在等待审批或回答）持有时，同一工作区的其他 Turn 按受理先后 FIFO 排队，不抢占。排队状态可见：持有者是哪个 Session、它是否在等待用户、最多再等多久，不含路径。排队中的 Turn 可以单独取消，并受等待预算限制。
- 工作区租约原语保持不等待，由 Runtime 在持有者结束时唤醒排队者。
- 只由空闲的保留进程持有工作区时，不排队，立即返回 `WORKSPACE_KEPT`（ADR-030）。
