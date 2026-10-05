# Worker 隔离、进程清理与恢复

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 集成测试（编译后的 Worker 与真实子进程、进程表、lease 与重启），本机 macOS arm64，Linux `/proc` 路径曾在 Ubuntu CI 运行（F07）；ACP 严格恢复只有 DSH 在比赛期 Mac 上的真实证据；Windows Job Object 有原生专用测试，开源版未单独验收，Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [Session、Worker 与引擎切换](../../../DESIGN.md#4-sessionworker-与引擎切换)、[Windows 能力与验证边界](../../../DESIGN.md#8-windows-能力与验证边界)、[恢复与已知限制](../../runtime-api.md#恢复与已知限制)、[ACP 会话恢复](../../session-recovery.md) |

## 用途

每个 Session 的 Agent 在自己的 Worker 进程里运行，使用私有的 HOME、临时与配置目录，只拿到明确允许的环境变量。Run 结束、取消或 Session 关闭时，HarnessHub 回收整棵进程树并如实报告是否清理干净；守护进程重启后先核实旧进程的归属，再决定哪些 Session 可以继续。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 无专门页面；执行详情显示 `cleanupStatus` 与清理耗时 |
| 命令行 | `hh serve --config <文件>` 设置 `maxWorkers` 与 `cancelGraceMs`；Ctrl+C 停止时先等待清理 |
| HTTP | `POST /v1/sessions/{id}/suspend`（释放可恢复会话的空闲 Worker）、`POST /v1/sessions/{id}/close`；`GET /v1/runs/{id}` 的 `cleanupStatus` |

## 已实现的能力

- Worker 按 Session 归属、第一次 Run 时懒启动（握手期限 10 秒），ACP Session 的后续 Run 复用同一 Worker；CLI 引擎每轮结束、后端失败、取消或超时后关闭 Worker。
- 常驻 Worker 上限 `maxWorkers`（默认 16，未确认清理的隔离 lease 也计入），满时新 Worker 返回 429 `WORKER_CAPACITY`，不静默回收无法恢复的上下文。
- 私有目录位于 `<dataDir>/backends/<sessionId>`：`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TMPDIR`/`TEMP`/`TMP` 与 `XDG_*` 都指向其中，POSIX 权限 0700；环境只含系统变量白名单（`PATH`、Windows 系统变量含 `PSModulePath`、区域与终端变量、用户名）、登记的 `credentialEnv`、配置引用的秘密变量与日志级别。经网关的引擎另删去厂商凭据变量与用户目录变量，见 [凭据与目录隔离](../../model-gateway-engines.md#凭据与目录隔离)。
- Worker IPC 每条消息至多 8 MiB，按 ACK 背压；收到不合协议的消息时 Worker 退出。
- POSIX 上 Worker 自成会话与进程组，清理先 SIGTERM 再 SIGKILL；用 `setsid` 等离开进程组的后代按清理前快照的父链与环境标记 `HARNESSHUB_WORKER_TREE` 认定归属，只对真实与有效 UID 都等于 Gateway 的进程发信号；macOS 上只剩僵尸的进程组回答 EPERM 时有界等待（[ADR 0016](../../decisions/0016-posix-escaped-descendants.md)）。
- Windows 上用 Job Object helper 监督 Worker 进程树，关闭 Job 时结束其后代（[ADR 0007](../../decisions/0007-windows-process-supervision.md)）。
- `cleanupStatus` 为 `confirmed`、`unconfirmed` 或 `failed`；未确认的资源进入隔离，不分配给下一次 Run，同一 Session 再启动返回 503 `WORKER_QUARANTINED`。
- 每个 Worker 在 `<dataDir>/workers` 写 lease（owner token、PID、Worker 路径）；重启时按 token、完整命令与 PGID 核实归属后回收，身份不明时保持 `unconfirmed` 与隔离，不按 PID 盲杀。
- 重启时未终结的 Run 记 `interrupted`（`stopReason: gateway_restarted`）并关闭其 Session；未开启恢复的 ACP Session 被关闭，不自动重跑有副作用的任务。
- 同一数据目录只允许一个 Gateway：所有权是 `harnesshub.sqlite.lock` 上的操作系统文件锁，第二个实例以 `RUNTIME_ALREADY_RUNNING` 失败。
- 显式 `acp.sessionMode: resume` 的引擎：首次后端 ID 提交并确认后才发 prompt；空闲时可 `suspend` 释放 Worker（清理未确认时返回 503 `SESSION_SUSPEND_UNCONFIRMED`）；下一次 Run 或正常重启后按私有 checkpoint 与公共后端 ID 严格恢复，不符时以 `ACP_SESSION_RECOVERY_FAILED` 失败，未启用或引擎未声明能力时为 `ACP_SESSION_RECOVERY_UNSUPPORTED`，不建空会话冒充恢复。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [worker-host.ts](../../../packages/runtime/src/process/worker-host.ts)、[leases.ts](../../../packages/runtime/src/process/leases.ts)、[posix-tree.ts](../../../packages/runtime/src/process/posix-tree.ts)、[process-table.ts](../../../packages/runtime/src/process/process-table.ts)、[windows-job.ts](../../../packages/runtime/src/process/windows-job.ts)、[cleanup-settlement.ts](../../../packages/runtime/src/process/cleanup-settlement.ts)、[session-store.ts](../../../packages/drivers/src/acp/session-store.ts)、[instance-lock.ts](../../../packages/store/src/storage/instance-lock.ts)、[Worker main.ts](../../../packages/daemon/src/worker/main.ts) |
| 测试 | [worker-host.test.ts](../../../tests/integration/worker-host.test.ts)、[posix-escaped-descendants.test.ts](../../../tests/integration/posix-escaped-descendants.test.ts)、[posix-tree.test.ts](../../../tests/unit/posix-tree.test.ts)、[group-eperm.test.ts](../../../packages/runtime/test/group-eperm.test.ts)、[gateway-recovery.test.ts](../../../tests/integration/gateway-recovery.test.ts)、[acp-recovery.test.ts](../../../tests/integration/acp-recovery.test.ts)、[instance-lock.test.ts](../../../tests/integration/instance-lock.test.ts)、[worker-acp.test.ts](../../../tests/integration/worker-acp.test.ts)（私有目录与凭据继承）、[windows-process.test.ts](../../../tests/integration/windows-process.test.ts) |
| 决策 | [ADR 0007 Windows Job Object 进程监督](../../decisions/0007-windows-process-supervision.md)、[ADR 0016 POSIX 上脱离 Worker 进程组的后代](../../decisions/0016-posix-escaped-descendants.md)、[ADR 0004 文件任务、严格恢复与本机接入修复](../../decisions/0004-file-tasks-and-resume.md) |

## 已知限制与未验证

- 独立 Worker 不是 OS 沙箱：没有文件读写、网络、桌面或提权隔离，Agent 拥有当前用户的权限。
- `confirmed` 不覆盖看不到环境标记、且父进程在扫描前已退出的后代（`env -i` 启动、其他用户、Linux 不可 dump、macOS 的 Apple 平台二进制等），也不覆盖服务管理器代为启动的进程；Linux `hidepid` 下读不到的进程同样不在覆盖内。
- 清理会结束 Run 首次启动的共享守护进程（tmux、ssh ControlPersist、gpg-agent、构建守护进程、分离启动的 GUI 应用）。
- Windows 重启恢复保守地返回 `unconfirmed`；WMI、服务、计划任务启动的进程不在 Job 保证内。
- 严格恢复只有 DSH 在比赛期 Mac 上的真实证据；其他引擎、执行中崩溃与 Windows 未验证。

## 优化候选

- **现状**：Worker 只在关闭、失败或手动 `suspend` 时释放，常驻数满就拒绝新 Session。**方向**：对满足可恢复条件的 Session 空闲 10 分钟后自动释放 Worker，不满足的保留到显式关闭。**依据**：[05 第 10 节](../../proposals/oss/05-run-plane.md#10-容量回收与数据保留)、[DESIGN 第 4 节](../../../DESIGN.md#4-sessionworker-与引擎切换)的空闲回收条件。
- **现状**：没有任何文件或网络限制。**方向**：按维度声明 `none`/`partial`/`full`，macOS 用 Seatbelt、Linux 用 Landlock 实现 `workspace-write` 与 `gateway-only`，达不到时以 `ISOLATION_UNSUPPORTED` 失败，并配金丝雀测试。**依据**：[05 第 6 节](../../proposals/oss/05-run-plane.md#6-沙箱与隔离等级)。
- **现状**：Windows 上数据目录继承父目录权限，只有产物与工具包目录设置了 ACL，Session 私有目录依赖所在目录的权限。**方向**：数据目录根新建时设受保护的 DACL。**依据**：[07 第 1 节](../../proposals/oss/07-data-security.md#1-数据目录与文件布局)。
- **现状**：Windows 的重启恢复一律 `unconfirmed`，隔离的 lease 会占用常驻名额直到核实。**方向**：按 Job 与进程身份做与 POSIX 同等的核实，并取得原生证据。**依据**：[恢复与已知限制](../../runtime-api.md#恢复与已知限制)、[DESIGN 第 8 节](../../../DESIGN.md#8-windows-能力与验证边界)。
