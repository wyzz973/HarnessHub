# Harness Adapter SPI

状态：proposed。具体类型和 wire schema 由契约任务冻结。Adapter 是第三方系统的防腐层，不能成为另一套业务 Runtime。

| 操作 | 输入 | 输出/责任 |
|---|---|---|
| inspectInstallation | 注册 revision、平台、受控查找目录 | 安装/版本观察，不联网下载、不读取其他应用凭据 |
| probeCapabilities | 固定 Adapter/Harness、初始化预算与受控配置 | 协商结果和证据；声明不自动升级为 validated |
| prepareBinding | BindingId、私有路径、模型访问引用、工具/权限方案 | PreparedBinding；不改用户全局配置，失败可清理 |
| openOrRestore | 公共来源引用、原生 checkpoint 或 ContextManifest | 新/恢复的后端身份、接续等级与 capability snapshot |
| execute | AttemptId、epoch、generation、不可变 ExecutionPlan | 有界事件流、独立后端结果、取消入口和资源关闭入口 |
| answerPermission | 归属身份、实际 optionId 与已提交决定 | delivery/application receipt 或明确未知 |
| requestStop | 当前 Attempt 和 generation、原因 | 只表请求发送/协议确认，不伪造进程清理 |
| changeModelAtBoundary | 已确认静止、目标与预期配置版本 | 原地配置证据；不支持时由应用选择显式重建，不能假称热切换 |
| checkpoint/close | 固定 Binding 身份、期限 | checkpoint 和可等待资源释放结果 |

## 能力声明

每项能力包含：范围、declared/observed/validated、Harness/Adapter/protocol 版本、OS/架构、证据引用与失效条件。能力至少涵盖 prompt 内容、恢复、context import、工具注入、权限覆盖、模型配置、模型原地切换、取消、停止确认、进程/网络/文件隔离及 usage。

恢复级别采用 native_resume、public_context_rehydrate、unsupported；“无缝”的用户体验可以由 rehydrate 实现，但不能以 native_resume 命名。取消和权限各自声明覆盖哪些路径。

## 协议差异

- ACP v1：先初始化/会话准备，映射 prompt/update/permission/cancel，等待原 prompt 的结算；只调用实际协商或公布的可选操作。
- Codex App Server：thread/turn/item/approval 是厂商语义，不能直接塞到公共 Session/Turn 类型。初始化、turn/completed、interrupt 与原生拒绝分别映射。
- OpenCode：ACP 作为首候选；HTTP server 的 prompt_async、abort、事件和权限可成为独立 native Adapter，不能混同两个控制面。
- Claude SDK：库运行厂商二进制，SDK 回调、resume、permissions 和安装条款需独立核验，不当作 Apache/MIT 开源运行时复制。
- Pi RPC：成功 prompt 响应仅表示接受/处理，agent_end 不一定 settled；没有内置完整权限系统时不可冒充统一审批支持。

## 所有权与失败

Adapter 不能分配公共 Session ID、写公共业务库、选择备用 Harness、判任务正确性、吞协议错误或因连接失败自动重跑。它只报告证据和失败类别。

事件、结果、关闭和取消是独立入口。所有流、请求、子进程和回调在 Binding 作用域有所有者。异常输出、stdout 污染、无终止响应、超大消息、无界缓冲、迟到回调和恢复材料不匹配均有明确处理。
