# 统一语言

状态：proposed。对外使用用户和业务语义，第三方字段由 Adapter 防腐层映射。

| 术语 | 定义 | 不应混淆 |
|---|---|---|
| Session | 网关拥有的持续对话与工作容器；Chat 是其交互视图 | 某个 Harness 原生 Session/Thread |
| Message | 持久接收的用户输入或公共输出，具有来源和顺序 | 浏览器草稿、stdout 一行 |
| Turn | 一次已接收输入到结算的工作单元，排队也计入总期限 | 一次模型调用 |
| ExecutionAttempt | Turn 某次被授予执行权的实际尝试 | 网络请求重发；未知尝试不自动再建一次 |
| HarnessRegistration | 可选择执行者的身份、不可变 revision、适配入口与能力证据 | 已安装二进制或 SDK 的全局 singleton |
| BackendBinding | 关联公共 Session 与某个原生会话/进程的私有绑定 | 公共 Session 身份 |
| CapabilityEvidence | 指定版本和平台上 declared、observed、validated 的能力 | 发现到安装文件、营销描述 |
| RoutingDecision | 某个输入在固定策略与候选快照下的排除、比较和选择 | 质量最优的无条件承诺 |
| SelectionPreference | 用户指定或自动模式，以及 Provider/模型、工具与工作区偏好 | 已生效执行配置 |
| ExecutionPlan | 执行启动前固定的 Harness revision、模型、策略、上下文和预算快照 | 后续可以任意改写的实时偏好 |
| ContextManifest | 有界、带来源与水位的交接材料，派生自公共事实 | 原生完整内部状态、盲目复制全部历史 |
| SwitchRequest | 用户或策略提出的执行者/模型变更意图 | 已经完成切换 |
| ContinuityEpoch | 公共 Session 的执行权代次，隔离迟到事件和旧控制 | 第三方原生 session ID |
| ExecutionGrant | Session 根授予某 Turn/Attempt 的可撤销启动授权，绑定 controlSeq 与授权版本 | 未消费 outbox 或仅带 epoch 的旧计划 |
| OwnerGeneration | 取得数据根排他 owner 资格后递增的持久控制代次 | PID、随机身份 token 或 TTL |
| PermissionRequest | 某个尝试及工具操作上实际可选的授权请求 | 整个任务批准或工具成功 |
| WorkspaceLease | 某执行者对受管理工作区的有期限写入归属 | OS 沙箱或对外部程序的强制禁写 |
| Artifact | 已校验并登记的不可变成果 | 任意磁盘路径或任务正确性证明 |
| ModelCall | 某次实际模型请求的归属、上游、协议、结果和用量证据 | 配置中写下的模型名称 |
| CleanupResult | stopped/confirmed、unconfirmed 或 failed 的资源回收证据 | cancel 接口 202、exit code 0 |

公共 SessionId、TurnId、AttemptId、BindingId、SwitchId、PermissionId、ArtifactId 使用不同 opaque 类型；对外不能互换。字段是否采用这些英文名称由 schema 任务冻结，本文先固定语义。
