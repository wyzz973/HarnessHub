# ADR 0007：Windows Job Object 进程监督

Status: accepted

日期：2026-09-06
关联决定：[执行链路协议](0002-runtime-mvp.md)、[平台边界](../../DESIGN.md#8-windows-能力与验证边界)

## 问题

原 ProcessHost 在 Windows 只使用直接子进程和 `taskkill /T`，无法证明根进程先退出后其后代已经回收。重启后的 PID 可能复用，不能据此终止未知归属的进程。ACP 配置探测会执行 Adapter 初始化，同样需要在执行前建立所有权。

## 决定

增加一个独立 C# helper，通过 Win32 Job Object API 管理进程归属。Windows 构建使用系统 .NET Framework C# 编译器生成 AnyCPU 的 `dist/native/harnesshub-job.exe`；编译器或所需原生 API 不可用时明确失败。helper 不进入业务域，Gateway 仍是业务数据库的唯一写入者。

每个 Worker 使用随机 UUID 对应的本机会话命名 Job，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不允许 breakaway。Worker 先由 Node fork 建立 IPC，helper 将空闲 Worker 分配到 Job；ProcessHost 同时等待 Worker ready 和原生分配成功，才发送第一个 Run。分配前 Worker 只能运行受信任的协议入口，不能创建引擎或执行 Run。分配失败、超时或提前取消都会收敛本次启动，不降级为无监督执行。

helper 持有 Gateway 和 Worker 的进程句柄，等待任一退出后终止 Job 并查询 `ActiveProcesses=0`。helper 本身意外退出时，最后一个 Job 句柄关闭触发内核回收。正常关闭先请求 Worker 协议 shutdown，再按清理期限升级为 Job 终止；仅发出终止请求不作为确认依据。

ACP 探测通过 helper 的 `run` 模式执行。`PROC_THREAD_ATTRIBUTE_JOB_LIST` 将创建进程与 Job 分配合为原子步骤，子进程还以 suspended 状态创建，随后恢复主线程。这样 helper 在 CreateProcess 周期内被强制结束，也不会留下尚未归属的暂停进程。命令使用 Windows CRT argv 编码；cmd/PowerShell 的解释由引擎命令准备层拥有。

Windows 新 Worker lease 使用 version 2，ownerToken 同时确定命名 Job。恢复只打开该 Job 并查询或终止，不按恢复记录中的 PID 杀进程；PID 只用于保守判断根进程是否已消失。旧版 Windows lease 未建立 Job 证据，仍返回 `unconfirmed` 并保留隔离。POSIX lease version 1 的既有恢复语义不变，不自动重跑未知结果的 Run。

## 考虑过的替代方案

- 继续 `taskkill /T`：无法在父进程已退出后证明后代所有权，也没有 Gateway 崩溃时的内核清理保证。
- PowerShell 常驻脚本或进程枚举：引入脚本解释与启动成本，仍需 Win32 API 才能建立相同所有权，PID 枚举存在复用及竞态。
- 新增编译器或 Node 原生 addon：此环境已有 .NET Framework 编译器；独立 helper 可保持依赖和 ABI 成本较小，并使句柄关闭与进程生命周期绑定。
- 仅使用 suspended CreateProcess 后再 AssignProcessToJobObject：helper 在两步之间崩溃会留下未分配的暂停进程，因此探测采用原子 JobList 属性。

## 后果

这实现 Windows 创建进程路径上的监督与清理，并非 OS 沙箱。没有提供文件读写、网络、令牌、凭证、提权或桌面隔离。通过 WMI、系统服务、计划任务或其他外部 broker 创建的进程不属于已验证路径；第三方引擎若使用这些路径须单独验收。也不声称阻止同用户恶意程序篡改运行目录或 Job。

目标为 Windows 10/11；JobList 属性要求 Windows 10 及以上。当前证据来自 Windows 11 ARM64，本次没有在 Windows 10 或 Windows x64 主机上执行。普通 CreateProcess 后代与已验证的嵌套 Job 行为不能泛化为所有引擎、MCP 或提权工作流。

Microsoft 说明 [Job 的继承、关闭和限制](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)，以及 [JobList 的 Windows 版本与分配契约](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。阅读日期：2026-09-06。

## 验证要求

使用正式编译后的 Gateway/Worker、真实 SQLite、HTTP/SSE 和原生 helper 验证启动取消、执行取消、deadline、正常/失败结果后的后代回收、Gateway/helper 强制退出、重启 interrupted 及唯一终态、身份不匹配不误杀、旧 lease 隔离、中文与空格 argv、stdio 和 ACP 初始化探测。实际命令与已验证范围见 [Windows 进程验收](../verification/2026-09-06-windows-process.md)。
