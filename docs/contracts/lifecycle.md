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

receivedAt 建立单调预算，总期限覆盖排队、路由、上下文、启动、模型、工具、权限和结果采集。持久时间戳供恢复核对，单进程内使用单调 clock；系统时钟跳变不可延长预算。清理 grace 独立有界。

取消、deadline、后端完成、存储故障与切换由应用/领域仲裁排序处理。已生效停止原因不被晚到完成改写；重复取消幂等。事件流结束、协议 ACK、模型末块或 exit 0 都不是唯一完成证据。

## 4. 取消与清理

持久记录意图 → 对实际待决权限返回取消结果 → 协议 requestStop → 等待后端证据 → 关闭绑定 → 必要时升级终止进程树 → 采集残留与调用状态 → 提交结果/隔离资源。

后端愿意停止、操作系统已终止进程、工作区不再被旧执行者写入是不同证据。无法确认停止时，后续写执行被阻塞；不能只因清理 grace 到期释放租约。

## 5. 崩溃与恢复

启动时先取得公共 owner lease，检查持久命令、outbox、Attempt、Binding、进程归属与工作区租约。已有终态正常重放；仍活且归属验证通过的进程先受控收敛；未能证明结果的尝试标 interrupted/unknown。

原生恢复需要同 Harness/Adapter 版本、后端身份、checkpoint 指纹和 manifest 水位匹配。失败不能创建空原生会话后声称恢复成功。可显式 public_context_rehydrate，但必须显示降级接续等级，并不重新执行旧工具或旧输入。

## 6. 最小并发承诺

同 Session 串行写执行；多 Session 有界并行；工作区写权独立于 Session。排队有长度/字节上限、FIFO 或明确公平策略、取消和期限。先从这些可证明的规则开始，不依赖“Node 单线程所以没有竞态”。
