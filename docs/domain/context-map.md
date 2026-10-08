# DDD 限界上下文与一致性边界

状态：proposed。按业务语义划边界，首版在一个模块化单体内实现；边界不等于必须拆成微服务或多个 npm 包。

| 上下文 | 核心责任与拥有的数据 | 对外发布 | 不负责 |
|---|---|---|---|
| Interaction | 公共 Session、Message、输入幂等、待执行 Turn 意图、执行权代次与切换意图 | SessionCommand/SessionView、已提交公共事实 | 厂商 SDK、选择算法、进程控制 |
| Harness Catalog | 注册/停用/排空、不可变 revision、能力与证据 | HarnessDescriptor、候选快照 | 运行中擅自换执行者 |
| Selection | 任务约束、候选过滤、固定版本策略与决策证据 | RoutingDecision | 执行、上下文摘要、编造质量分 |
| Execution | Attempt、BackendBinding、权限、期限、取消、写租约、清理与结果结算 | ExecutionOutcome、QuiescenceEvidence | 公共对话事实、Provider 密钥管理 |
| Continuity | 公共上下文取材、manifest、交接水位与接续等级 | ContextManifest、验证结果 | 原生无损迁移、执行副作用回滚 |
| Model Access | Provider/模型引用、受管理调用入口、调用归属与账本 | ModelAccessBinding、ModelCallEvidence | Agent 工具编排、业务终态 |
| Access & Policy | 调用方身份、范围、秘密引用、策略判断 | Principal、PolicyDecision、ScopedSecretAccess | 所有业务上下文的统一“大对象” |

## 聚合与状态责任

- Session 是 Interaction 的聚合根，保存有界状态与引用：当前代次、准入槽位、偏好与待处理意图。消息和历史按游标读取，不把整个对话装进一次聚合加载。
- ExecutionAttempt 是 Execution 的聚合根，仲裁运行、停止和终态；Permission 属于该次执行责任。BackendBinding 的原生身份、资源与清理有独立实体身份。
- HarnessRegistration 是 Catalog 聚合根；历史 revision 不变，新 admission 使用当前可接收的 revision。
- ContextManifest、RoutingDecision 和 ExecutionPlan 是不可变值/记录；它们的来源、策略与版本可以重建和审计。
- SwitchRequest 的准入与偏好生效由 Session 根控制。跨上下文交接由应用层 process manager 协调，不能让 Adapter 直接修改 Session 或“写库即切换”。

## 跨上下文协作

Session 接收命令时只提交自己的状态、输入记录与 outbox；Execution 以预分配 ID 幂等消费执行意图，提交自己的状态与 outbox。结果再由 Interaction 以 expected version/epoch 应用。消息/outbox 与所属聚合共事务；不把两个上下文的数据强行放进一个万能 Repository。

Session 可以显示“输入已接受，执行尚未启动”。Execution 已终态但 Interaction 尚未消费时显示待结算，恢复会对账，不提前释放写权或伪造全局完成。读模型可组合多个上下文事实，但不成为新的写入权威。

Session 的 admission 不只是 outbox 记录：根以事务授予唯一 ExecutionGrant，绑定 TurnId、AttemptId、epoch、controlSeq、grantVersion 与 ownerGeneration。取消、close 和切换推进控制顺序并撤销未启动授权；outbox 的旧启动消息必须重新申请/核对授权，去重不能代替有效性判断。执行授权和网关派发由单一 Session 控制仲裁顺序协调，细则见运行契约。

应用服务只编排端口；业务规则在聚合/领域策略。跨上下文只交换发布的契约和 ID，不直接导入另一个上下文的内部实体或私有表。防腐层拥有第三方消息与 SDK 类型。

## 设计来源

[Bounded Context](https://martinfowler.com/bliki/BoundedContext.html)用于解释语言边界；[Aggregate](https://martinfowler.com/bliki/DDD_Aggregate.html)用于局部一致性；[DDD 分层](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/ddd-oriented-microservice)用于区分领域与应用编排。具体七个上下文是本项目的设计推导，需随实际用例检验，不能仅凭目录名字声称完成 DDD。
