# ADR 0016：POSIX 上脱离 Worker 进程组的后代

Status: accepted

日期：2026-10-02
关联决定：[ADR 0002](0002-runtime-mvp.md)（lease 与清理隔离）、[ADR 0007](0007-windows-process-supervision.md)（Windows Job Object）。开源版路线图先行修复 F07（[路线图第 3 节](../proposals/oss/12-roadmap-migration.md#3-先行修复)）。

## 问题

POSIX 上 Worker 以 `detached: true` 启动，自成会话与进程组；清理按组发信号，组消失后报告 `confirmed`。引擎或工具用 setsid（Node 的 `detached: true`、`setsid`、守护化程序）或作业控制建立新的会话或进程组后，该后代不再收到组信号，Worker 清理后仍在运行，Run 与 Session 却报告 `confirmed`。这违反 [DESIGN 第 5 节](../../DESIGN.md#5-run-生命周期与控制契约) 中 `cleanupStatus` 的含义：未经证明的清理不能报告为已确认。Windows 的 Job Object 已经包含所有后代，不受影响。

## 决定

归属依据两项事实，以及由它们出发的父链：

1. **清理开始前的进程树**。发送 shutdown 前读取一次进程表（macOS：`/bin/ps -A -o pid=,ppid=,pgid=,uid=,ruid=,stat=,lstart=`；Linux：`/proc/<pid>/stat` 与 `status`），从本 Worker 的根进程及其进程组成员出发，按父链记录全部后代，以 PID 加启动时间识别。启动时间使记录在进程被重新托管后仍然有效，并能区分记录与之后的扫描之间被复用的 PID；扫描与随后发信号之间的复用窗口是 POSIX 通常的竞态，仍然存在。Worker 崩溃后在快照时仍是未回收的僵尸时，它的 PID 和进程组 ID 都不会被复用，记录从其进程组成员开始。
2. **Worker 树标记**。每个 POSIX Worker 的环境含 `HARNESSHUB_WORKER_TREE=<owner token>`，引擎和继承环境的工具自动携带。HarnessHub 下发的 stdio MCP 服务配置加入该变量，因为部分引擎只用配置的变量启动 MCP。Worker 应用引擎环境后重新写回标记，启动配方和凭证隔离不能替换或删除它。值复用 owner token：它已出现在 Worker 命令行和 lease 中，因此重启恢复无需改变 lease 格式。这个值是公开的，不能成为任何凭证，Worker IPC 和由同一 token 得出的 Windows Job 名称都不能依赖它保密。macOS 用 `ps -E` 读取同用户进程的环境，再用不带 `-E` 的读取排除参数中出现的同名文本；Linux 读 `/proc/<pid>/environ`。

只有真实与有效 UID 都等于 Gateway 有效 UID 的进程可以归属；按上述规则可达、但属于其他用户的进程不发信号，父链遍历在它处停止，结果为 `unconfirmed`。

进程组确认退出后，扫描一次：仍存活的已记录进程、带本 Worker 标记的进程及它们的后代先收到 SIGTERM，宽限期后剩余者收到 SIGKILL，最后再扫描确认。只有扫描不到这类进程时才报告 `confirmed`；仍有残留、进程表无法读取、无法区分参数与环境、可达进程属于其他用户时报告 `unconfirmed`，资源按原有隔离规则保留，原因写入 Gateway 日志。Gateway 自身及其祖先永不归属，归属也不经由它们向下传递（在旧 Worker 树中启动的新 Gateway 不会在恢复时结束自己）；进程组只在快照显示组长和全部成员都归属时整体发信号；发信号前再拒绝 PID 或进程组 0、1 和 Gateway 自己的进程组。重启恢复先核实旧 Worker 身份；快照显示 Gateway 或其祖先在被租用的进程组中，或读不到快照时，不发任何信号并返回 `unconfirmed`；否则以 lease 中的 token 执行同一检查。旧 Worker 已消失时只按标记认定。Windows 路径不变。

**有界的读取。** 每次读取进程表都在短生命周期的子进程中完成，5 秒期限、64 MiB 输出上限，到期发送 SIGKILL 并立即返回，不等待子进程退出，也不占用 Gateway 的 libuv 线程池。Linux 上读取 `/proc/<pid>/environ` 要拿目标进程的内存映射锁，可能因卡住的 NFS/FUSE 映射长时间阻塞，所以由子进程 `proc-scan-main.ts` 逐个读取。读取失败的原因只保留退出码、信号或 errno 代码，绝不包含子进程输出：`ps -E` 的输出含有同一用户所有进程的环境，包括凭证。

**`hidepid`。** Linux `/proc` 以 `hidepid` 挂载时，无权读取的进程记录（EACCES/EPERM）被跳过并计入日志中的 `hidden`，不使结果变为 `unconfirmed`。理由：这些进程要么属于其他用户，按上面的 UID 规则本来就不能归属；要么是同用户的不可 dump 进程，它们的环境即使没有 `hidepid` 也读不到，已经属于下文的缺口。同用户的普通进程在 `hidepid` 下始终可读。另一种做法是把它们视为未知、结果一律 `unconfirmed`；隔离的 lease 占用 `maxWorkers` 容量并在重启后保留，这样做会让启用 `hidepid` 的主机逐步耗尽容量，而换来的只是对本来就不能结束的进程的报告，因此不采用。

## 考虑过的替代方案

**只按父链。** 守护化程序在清理开始前就让中间进程退出，后代被 init/launchd 收养，父链已断，仍会漏报。父链只能覆盖清理开始时链路完整的后代。

**只按环境标记。** 以全新环境启动的后代（`env -i`、显式 `env` 选项）不带标记；清理开始时其父链仍完整的情况可由进程树记录覆盖，因此两者并用。

**Linux 子进程收割者（`PR_SET_CHILD_SUBREAPER`）或 cgroup。** 能让孤儿留在 Worker 之下或按 cgroup 整体终止，但 Node 不暴露 `prctl`，cgroup 需要 systemd 委托或额外权限，macOS 没有等价机制。需要原生 helper 时另行评估。

**单独生成随机标记并写入 lease。** 需要升级 lease 格式，旧 lease 仍无法使用；owner token 已具备唯一性且已经公开在 Worker 命令行中，复用它不增加暴露。

## 后果

没有后代逃逸时，每次清理多读两次进程表、不多发信号；在约 1300 个进程的 macOS 开发机上，`ps -E` 一次约 70 ms。Linux 上每次读取另需启动一个 Node 子进程。有逃逸时最多再读两次进程表（macOS 上出现标记文本时，每次另对候选进程读一次参数），并等待一到两个宽限期。最坏情况由每次读取的 5 秒期限和宽限期限定。

标记会被 Run 启动的所有进程继承，包括 Run 首次启动的共享守护进程和应用：tmux 或 screen 服务器及其全部窗格、ssh 的 ControlPersist 主连接、gpg-agent、Gradle/Bazel/Nx 守护进程、以分离方式启动的 GUI 应用（例如 VS Code 尚未运行时执行的 `code .`），以及它们之后为用户启动的一切。清理会结束这些进程；此前它们调用 setsid 后会留存。这符合 DESIGN 第 5 节，但对用户可见。恢复时，在旧 Worker 树中启动的新 Gateway 会留存，同样带有旧标记的兄弟进程（例如同一 IDE 的其他终端）会被结束。

以 root 运行的 Gateway 上，其他本地用户可以把公开的标记写进自己进程的环境；按 UID 规则这些进程不会收到信号，但会让对应会话一直为 `unconfirmed` 并占用容量。

无法识别的情况仍然存在：父进程在能把它与 Worker 联系起来的那次扫描之前已经退出、且环境中看不到标记的后代。这包括清理开始前已被重新托管的后代，以及在 shutdown 前的快照之后才创建、且父进程在最终扫描前退出的后代。看不到标记包括以全新环境启动、属于其他用户、Linux 上不可 dump 的进程，以及 macOS 上 `ps -E` 不显示环境的 Apple 平台二进制（2026-10-02 在 macOS 26.6 上核实 `/bin/sh`、`/bin/bash`、`/bin/sleep`、`/usr/bin/perl`）。此时 `cleanupStatus` 仍可能为 `confirmed`；这一限制写在 [运行说明](../runtime-api.md#posix-上脱离进程组的后代) 中，不宣称 `confirmed` 覆盖它。由 launchd、systemd 等服务管理器代为启动的进程不属于 Worker 树。读取进程表的子进程若阻塞在内核中，SIGKILL 后可能要等读取返回才退出，Gateway 不等待它。若需要完全覆盖，应改用 cgroup 或原生 helper，并以新 ADR 记录。

## 验证要求

经正式编译的 Worker 与 Gateway：setsid 后代在关闭 Session、CLI Run 完成、Worker 崩溃（快照时仍是僵尸）和重启恢复后都被回收，`cleanupStatus` 为 `confirmed`，进程实际不存在；父进程已退出但带标记的后代被找到并回收；无法发信号的后代使清理为 `unconfirmed`、lease 保留并记录原因；命令行含相同脚本与标记文本、但不属于本 Worker 的进程不收到任何信号；被租用的进程组包含恢复中的 Gateway 时不发信号。单元测试覆盖 UID 规则、`hidepid`、进程组判定、发信号前的拒绝规则、未知结论与未完成记录，以及读取期限和不含输出的错误。去掉对应实现后上述用例失败。Linux 只在 CI 上运行，macOS 结果不代表 Linux。
