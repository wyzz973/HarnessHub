# ACP 会话恢复

ACP 会话可以显式配置为可恢复模式，并在 Worker 释放或 Gateway 重启之后继续同一个后端会话。恢复不会重跑旧 Run；客户端需要主动提交新的 Run。跨引擎迁移不在此功能范围内。

## 启用与使用

在引擎配置中增加以下字段，注册流程见 [动态引擎管理](engine-management.md)。此配置表示要求后端恢复能力；它不等于所有引擎已经通过恢复验收。

```yaml
acp:
  sessionMode: resume
```

Driver 在首次建立 ACP 会话时检查后端是否声明 `session/resume` 或 `session/load`。未声明时返回 `ACP_SESSION_RECOVERY_UNSUPPORTED`，不会提交模型任务。未配置该字段的引擎继续保留原有的单 Worker 会话使用方式。

已空闲的可恢复会话可调用 `POST /v1/sessions/:id/suspend` 释放 Worker。成功响应中 `cleanupStatus` 表示进程清理结果；公共 Session 仍然保留。下一次提交 Run 时，Worker 从原私有状态目录严格恢复固定的后端 ID。存在活动或排队 Run 时不能 suspend。

显式 `POST /v1/sessions/:id/close` 关闭公共 Session，后续不再接收 Run；历史记录继续可查询。Driver 释放资源使用 acpx 默认断开行为，保留后端恢复材料，不发送删除历史的后端 `session/close`。

## 身份、持久化与失败

首次 `session/new` 返回后，Driver 发送 `engine.session` 事件，包含 `backendSessionId` 与 `resumed: false`。Gateway 把后端 ID 与事件原子提交到业务数据库，Worker 收到 ACK 后才提交模型 prompt。后续 Run 的执行规范包含该后端 ID，并继续固定原来的配置 revision 与 workspace。

新 Worker 恢复前会核对私有 checkpoint 中的公共 Session ID、后端 ID、cwd、完整命令 argv 和重置标记。以下情况明确失败，不创建空会话替代旧会话：

- 公共记录要求恢复，但 checkpoint 缺失或不兼容。
- checkpoint 存在，公共记录却没有可信后端 ID。
- 后端拒绝 `session/resume` 或 `session/load`，例如其原会话文件已丢失。
- 配置没有开启恢复，或后端没有声明相应能力。

检查点失败与后端恢复失败返回 `ACP_SESSION_RECOVERY_FAILED`。未经启用或缺少能力声明返回 `ACP_SESSION_RECOVERY_UNSUPPORTED`。错误信息不包含 checkpoint 内容、凭证或后端 stderr。恢复成功后的 `engine.session` 事件使用相同后端 ID 与 `resumed: true`；这个事件在 acpx 的 `promptStarted` 确认之后发送，单纯读到磁盘 handle 不算恢复成功。

Gateway 重启后的旧 Run 不会自动执行。无法证明已经完成的 Run 按 [运行契约](../DESIGN.md#5-run-生命周期与控制契约)处理；旧版本缺少后端 ID、但已经开始执行的 ACP 会话不会静默初始化为新上下文。

## acpx 0.13.2 的适配依据

本实现保留 `acpx/runtime`，使用其公开 `AcpSessionStore`、`ensureSession`、`startTurn` 与 `close` 接口，第三方类型留在 Driver 模块。

- `persistent` 模式内部采用 `same-session-only`，恢复失败时不会回退到 `session/new`。
- `ensureSession` 自身可能在 checkpoint 缺失或命令变化时新建，因此外层增加了严格的 Store 身份校验，并传入 `resumeSessionId`。
- `close` 默认只释放客户端并保存 checkpoint；只有 `discardPersistentState: true` 才请求后端关闭。HarnessHub 不使用后者实现 suspend。
- `startTurn.result` 在 checkpoint 与客户端清理结算后返回；恢复成功不能只根据 `ensureSession` 返回的 handle 判断。

这些行为已经对照安装的锁定版本和源码的 `runtime/engine/manager.ts`、`runtime/engine/reconnect.ts` 核实。升级 acpx 时必须复核并运行恢复集成测试。

## Mac 验证范围

`tests/integration/acp-recovery.test.ts` 使用正式 ProcessWorkerHost 与独立 ACP 对端，验证不同 Worker 之间恢复相同后端 ID 和只存在后端的上下文、默认关闭不删除后端，以及上述缺失和不支持路径。原 `worker-acp.test.ts` 继续覆盖同 Worker 多轮和权限选项 ID。

2026-09-05 的 DSH 实测使用 Node 24.20.0、acpx 0.13.2、DSH 0.1.2-alpha.2，以及本机已有 DeepSeek 模型配置。第一轮仅在对话中保存随机 nonce，关闭整个 Host/Worker 后，第二轮只询问之前的 nonce；返回值精确相同，两轮后端 Session ID 相同。DSH 的设置和凭证只通过原有文件路径引用，后端数据仍在本次私有 `DSH_HOME`；没有把 nonce 写入工作区供第二轮读取。

此项证明 DSH 在当前 Mac 配置下能够恢复上下文；不代表所有 ACP 引擎、所有工具中断场景或 Windows 已通过。正式 Gateway 重启验证及完整版本/运行记录见 [本轮验收](verification/2026-09-05-file-tasks-and-recovery.md)。

## 模型与用量观测

Driver 的 `engine.capabilities` 记录执行前的 ACP 模型状态与 `resumeAdvertised`。回合结束后 `engine.usage` 记录 `source: acp-session-checkpoint`、执行后的 `models` 和 `usage`；缺失值保持 `null`。

`usage` 可能包含累计 token、累计费用和以 ACP 用户消息 ID 为键的 `perRequest` 信息。不能把累计值当成本次 Run 的消耗，也不能把缺失字段当成零。安装版本、实际模型与 token 用量的来源需要分别记录；acpx 当前公开状态未提供的后端或 Adapter 版本不据此补猜。
