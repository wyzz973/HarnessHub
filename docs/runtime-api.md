# 执行服务与 API

完整40项接口的参数、返回码、处理链路和副作用见 [API入口](api/README.md)、[生成参考](api/reference.md)与 [OpenAPI快照](api/openapi.json)。本页保留执行配置与运行契约说明。

本页描述已实现的本地执行服务。架构以 [DESIGN.md](../DESIGN.md)为准；接口声明见 [领域类型](../src/domain/types.ts)、[HTTP schema](../src/domain/schemas.ts)和 [IPC schema](../src/domain/ipc.ts)。

## 启动

使用固定 Node 24.20.0/pnpm 10.12.3 安装、构建后运行：

```sh
pnpm start --demo --port 3180 --data-dir ./data
```

进程 stdout 输出一条包含 URL 和 PID 的 ready JSON。`/health/live` 报告进程存活，`/health/ready` 在 Runtime 停止或持久化故障时返回 503。服务绑定本机，不包含远程用户认证。

假引擎只能通过 `--demo` 启用；真实引擎可通过 `--config <file>` 或 [动态管理 API](engine-management.md)登记，未提供时允许空目录启动，不能把假引擎结果作为真实模型能力证据。默认工作目录为启动 cwd；配置中的相对 Workspace 路径按配置文件所在目录解析。

## 创建并执行任务

创建会话，返回 Session 的 `id`：

```sh
curl -s http://127.0.0.1:3180/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"engineId":"fake","workspaceId":"default"}'
```

以下 `SESSION_ID` 替换成返回值；Run 接收成功返回 202、Run `id` 与 Location：

```sh
curl -s http://127.0.0.1:3180/v1/sessions/SESSION_ID/runs \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-001' \
  -d '{"text":"Hello HarnessHub","timeoutMs":10000,"fixture":{"scenario":"artifact"}}'
```

同一 Session 内相同 key 和相同输入返回同一 Run；不同输入返回 409。已有幂等请求在队列已满时仍可重放；新请求队列满返回 429。文本必填，timeoutMs 默认由配置解析为 60 秒；请求可明确设置，期限从持久接收起覆盖排队、启动和权限等待。

用 `GET /v1/runs/RUN_ID` 查询状态、权限和产物；用 `GET /v1/runs/RUN_ID/events` 订阅 SSE。SSE id 是 Run 内 seq，支持 `Last-Event-ID` 或 `afterSeq`；流断开不取消任务。游标超过已提交范围返回 400。结束后流自动关闭。

当前后端文本事件为 `message.delta`，工具状态为 `tool.update`；公共生命周期使用 `RUN_QUEUED`、`RUN_STATUS` 和唯一终态事件。所有 SSE 事件先提交 SQLite，慢客户端通过有界分页追赶。

取消使用 `POST /v1/runs/RUN_ID/cancel`；202 仅确认取消请求，最终结果仍通过 Run 查询或 SSE 获取。关闭会话使用 `POST /v1/sessions/SESSION_ID/close`，只收敛该会话的工作。

## 权限与产物

Run 查询返回 `permissions`。向 `POST /v1/permissions/PERMISSION_ID/decision` 发送 `{"optionId":"实际选项ID"}`；不存在选项返回 400，冲突或过期返回 409。`applied` 及 `PERMISSION_APPLIED.acknowledgement=worker` 表示 Worker 已接收并应用映射后的决定，不代表外部工具已执行成功。

Run 查询中的 artifacts 可用 `GET /v1/artifacts/ARTIFACT_ID` 读取；服务核对登记大小和 SHA-256。`GET /v1/runs/RUN_ID/rollout` 将已提交事件导出 NDJSON，可从数据库重建。已支持 Run 显式 `outputs` 的普通文件与二进制采集，说明见 [文件产物](file-artifacts.md)。下载使用 attachment、nosniff 与 sandbox；独立二进制上传接口仍未实现。

`GET /openapi.json` 从实际注册路由生成接口清单、输入与JSON响应schema；SSE、NDJSON和文件内容以流式字符串/二进制描述。尚不支持的多模态输入或上传字段会被请求校验拒绝。

## 本地配置

参考 [配置示例](../engines/example.yaml)。命令必须是 argv 数组，不经额外 shell 拼接；执行期间不安装引擎。可配置全局/每引擎并发、排队数量、常驻 Worker 数、默认期限和取消 grace。`maxWorkers` 默认 16，容量满时新 Worker 返回明确失败，需要先关闭闲置 Session；不会静默回收未验证可恢复的上下文。`AGENT_ENGINE` 只影响新 Session 的默认引擎；与持久动态目录的优先级见 [管理说明](engine-management.md)。

`credentialEnv` 仅填写环境变量名称。Host 从启动时的环境快照提取明确允许的凭证，值不写入 Profile、IPC 或 SQLite。其余只继承固定的系统变量白名单（[worker-host.ts](../src/process/worker-host.ts) 的 `systemNames`：PATH、PATHEXT、SystemRoot、ComSpec、区域与终端变量、用户名和 `PSModulePath`）。缺少 `PSModulePath` 时，Windows PowerShell 5.1 每条需要自动加载模块的命令（`Write-Output`/`echo`、`>` 重定向、`ConvertTo-Json` 等）都要多花约 22 秒；引擎的 shell 工具每条命令启动一次 PowerShell，Gemini CLI 启动两次（AST 解析和执行）。2026-09-19 Windows x64 CI 实测 Gemini 一次 shell 工具往返由约 50 秒降到 2 秒。每个 Worker 的 HOME、XDG/AppData 和临时目录位于其后端数据目录，默认不自动读取用户原HOME。需要复用现有CLI登录时，可由本地Profile显式引用原生配置目录；这会共享部分引擎状态，接法及边界见 macOS接入（归档于 `archive/competition` 分支的 `macos-engines.md`）。

当前 ACPDriver 使用 `acpx/runtime` 的稳定入口，关闭它的 turn timeout，由父 Runtime 管总期限。权限采用 deny-all 基线，Agent 主动上抛的单次权限请求可走 Gateway 往返；客户端文件/terminal 路径不因此自动获准。同一种权限 kind 有多个 optionId 时明确拒绝，避免 acpx 的按 kind 决定误选实际选项。

## 恢复与已知限制

Gateway 重启后，未终结的 Run 标为 interrupted，cleanupStatus 来自旧Worker lease的核实结果，无法证明清理时为unconfirmed；关联 Session 关闭，不会自动重跑有副作用的任务。已完成 Run 和事件可查询、重放、导出。

DSH 已完成 Mac 上的严格上下文恢复验收：显式 `acp.sessionMode: resume` 后，idle suspend 和 Gateway 正常重启可恢复固定 backend ID。未开启恢复的 ACP Profile 继续保守关闭；执行中崩溃/取消/失败按现有策略保留历史并关闭公共会话，不自动重跑。成功会话中的 Worker 可供后续 Run 复用，细节及其它引擎边界见 [会话恢复](session-recovery.md)。

数据库有独占Gateway owner，同一目录被活实例占用时新实例拒绝启动。重启先按旧Worker lease的token、完整命令及PGID核实归属；可确认退出或回收的进程记confirmed，身份不明则保留unconfirmed与隔离容量，不盲杀PID。Windows恢复仍保守返回unconfirmed。

### POSIX 上脱离进程组的后代

POSIX 上 Worker 自成会话与进程组，清理先按组发送 SIGTERM、再 SIGKILL。用 setsid（例如 Node 的 `detached: true`）、守护化或作业控制离开该组的后代另行认定归属，规则在 [posix-tree.ts](../src/process/posix-tree.ts)，决定见 [ADR 0016](decisions/0016-posix-escaped-descendants.md)：

- 每次读取进程表都在一个短生命周期的子进程中进行，最长 5 秒、输出最多 64 MiB，到期即发送 SIGKILL 并立即返回，Gateway 自身不执行可能阻塞的读取。macOS 用 `/bin/ps`（`LC_ALL=C`、`TZ=UTC0`）。Linux 由子进程逐个读取 `/proc/<pid>/stat`、`status` 与 `environ`：读取某个进程的 `environ` 要拿它的内存映射锁，可能因卡住的 NFS/FUSE 映射而长时间阻塞，阻塞只影响这个子进程。
- 发送 shutdown 前读取一次进程表，按父链记录 Worker 树中的每个进程，以 PID 加启动时间识别：进程被重新托管后仍可认定，记录与之后的扫描之间 PID 被复用也能区分。Worker 崩溃后尚未被回收（僵尸）时，从其进程组成员开始记录。
- 每个 POSIX Worker 的环境含 `HARNESSHUB_WORKER_TREE=<owner token>`。引擎及继承环境的工具都会携带；HarnessHub 下发的 stdio MCP 服务配置也加入该变量，Worker 应用引擎环境时不会被启动配方或凭证隔离替换或删除。macOS 用 `ps -E` 读取同用户进程的环境，并用不带 `-E` 的第二次读取排除参数中出现的同名文本；Linux 读 `/proc/<pid>/environ`。该值是公开的：同一用户的任何进程都能读到它，也能把它写进自己的环境，因此不得把它用作凭证。
- 进程组确认退出后再扫描一次：仍存活的已记录进程、环境带本 Worker 标记的进程以及它们的后代逐个收到 SIGTERM，宽限期后对剩余者发送 SIGKILL，最后重新扫描。只有扫描不到任何此类进程时才是 `confirmed`。仍有残留、进程表无法读取、无法区分参数与环境，或按规则可达的进程属于其他用户时为 `unconfirmed`，资源保持隔离，原因写入 Gateway 日志的 `worker.tree_unconfirmed` 或 `worker.tree_record_failed` 记录。没有任何后代逃逸时只多两次进程表读取，不发信号。
- 只有真实与有效 UID 都等于 Gateway 有效 UID 的进程可以归属。按上述规则可达、但属于其他用户的进程（例如 `sudo` 启动的进程）从不收到信号，并使结果为 `unconfirmed`；以 root 运行的 Gateway 上，其他本地用户可以在自己的进程中写入公开的标记，使这类会话一直处于 `unconfirmed`。
- Linux 的 `hidepid` 挂载下，无权读取的 `/proc/<pid>` 记录（EACCES/EPERM）被跳过，只记入日志中的 `hidden` 计数，不使结果变为 `unconfirmed`。这些进程要么属于其他用户（本来就不能归属），要么是同用户的不可 dump 进程（其环境即使没有 `hidepid` 也读不到，属于下面的缺口）；同用户的普通进程始终可读。
- 重启恢复以 lease 中的 token 作为标记执行同一检查；旧 Worker 仍存活并通过身份核实时，同样先记录其进程树。快照显示 Gateway 自身或其祖先在被租用的进程组中，或者读不到快照时，恢复不发送任何信号，直接返回 `unconfirmed`。
- 不会向未被证明归属的进程发送信号。Gateway 自身及其祖先永不归属，归属也不经由它们向下传递；进程组只在快照显示组长和所有成员都归属时整体发信号；PID 或进程组 0、1 以及 Gateway 自己的进程组在发信号前一律被拒绝。

标记会被 Run 启动的所有进程继承，包括 Run 首次启动的共享守护进程和应用：tmux 或 screen 服务器（及其全部窗格）、ssh 的 ControlPersist 主连接、gpg-agent、Gradle/Bazel/Nx 守护进程、以分离方式启动的 GUI 应用（例如 VS Code 尚未运行时执行的 `code .`），以及它们之后为用户启动的一切。清理时这些进程连同其后代一起被结束；此前它们在调用 setsid 后会留存。在旧 Worker 树中启动的新 Gateway 在恢复时不会结束自己，但同样带有旧标记的兄弟进程（例如同一 IDE 的其他终端）会被结束。

已知缺口：父进程在能把它与 Worker 联系起来的那次扫描之前已经退出、且环境里看不到标记的后代无法识别，此时 `cleanupStatus` 仍可能为 `confirmed`，`confirmed` 不证明这类进程已经结束。这包括清理开始前已被重新托管的后代，以及在 shutdown 前的快照之后才创建、且父进程在最终扫描前退出的后代。看不到标记的情况包括：以全新环境启动（`env -i` 或显式的 `env` 选项）、属于其他用户、Linux 上不可 dump 的进程，以及 macOS 上 `ps -E` 不显示环境的 Apple 平台二进制（2026-10-02 在 macOS 26.6 上核实 `/bin/sh`、`/bin/bash`、`/bin/sleep`、`/usr/bin/perl`；Node 及非 Apple 签名的程序可读）。由 launchd、systemd 等服务管理器代为启动的进程从一开始就不在 Worker 树内，也不受此清理覆盖。读取进程表的子进程若阻塞在内核中，SIGKILL 后可能要等读取返回才退出；Gateway 不等待它。

Session/Run保存安全配置快照，包含配置标识、模型选择、凭证变量名和命令hash，不记录凭证值或完整argv；旧记录缺快照时明确标unknown。

Worker IPC 每条消息上限 8 MiB，文本产物入口上限 4 MiB，HTTP body 上限 2 MiB，超限明确失败而非截断；这些传输限制不等于模型 token 预算。Host 对 IPC 用 ACK 控制背压，但不能据此声称 acpx 内部队列或全部输出已受同样约束。

Windows 进程监督尚未原生验收；当前没有统一读/写/网络沙箱。API `/v1/engines` 把能力分为configured、observed和validated：observed按profile revision区分，只含本进程实际记录的Runtime控制/模型信息，不推导恢复或平台支持；没有验证时validated为null。[通用 CLI Driver](cli-driver.md)、[动态发现与管理](engine-management.md)和 [文件与文本 Benchmark](benchmark.md)已实现；直接 Native SDK Driver、跨引擎续聊仍未实现。

独立导出命令为 `node dist/src/cli.js rollout --url http://127.0.0.1:3180 --run RUN_ID --output FILE`。它读取同一Gateway轨迹接口，流式写入新文件，拒绝覆盖，失败清理半成品。对运行中的Run，导出只包含当时已提交的事件，不能称为完整终态轨迹。
