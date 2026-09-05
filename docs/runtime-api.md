# 执行服务与 API

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

`credentialEnv` 仅填写环境变量名称。Host 从启动时的环境快照提取明确允许的凭证，值不写入 Profile、IPC 或 SQLite。每个 Worker 的 HOME、XDG/AppData 和临时目录位于其后端数据目录，默认不自动读取用户原HOME。需要复用现有CLI登录时，可由本地Profile显式引用原生配置目录；这会共享部分引擎状态，接法及边界见 [macOS接入](macos-engines.md)。

当前 ACPDriver 使用 `acpx/runtime` 的稳定入口，关闭它的 turn timeout，由父 Runtime 管总期限。权限采用 deny-all 基线，Agent 主动上抛的单次权限请求可走 Gateway 往返；客户端文件/terminal 路径不因此自动获准。同一种权限 kind 有多个 optionId 时明确拒绝，避免 acpx 的按 kind 决定误选实际选项。

## 恢复与已知限制

Gateway 重启后，未终结的 Run 标为 interrupted，cleanupStatus 来自旧Worker lease的核实结果，无法证明清理时为unconfirmed；关联 Session 关闭，不会自动重跑有副作用的任务。已完成 Run 和事件可查询、重放、导出。

DSH 已完成 Mac 上的严格上下文恢复验收：显式 `acp.sessionMode: resume` 后，idle suspend 和 Gateway 正常重启可恢复固定 backend ID。未开启恢复的 ACP Profile 继续保守关闭；执行中崩溃/取消/失败按现有策略保留历史并关闭公共会话，不自动重跑。成功会话中的 Worker 可供后续 Run 复用，细节及其它引擎边界见 [会话恢复](session-recovery.md)。

数据库有独占Gateway owner，同一目录被活实例占用时新实例拒绝启动。重启先按旧Worker lease的token、完整命令及PGID核实归属；可确认退出或回收的进程记confirmed，身份不明则保留unconfirmed与隔离容量，不盲杀PID。Windows恢复仍保守返回unconfirmed。

Session/Run保存安全配置快照，包含配置标识、模型选择、凭证变量名和命令hash，不记录凭证值或完整argv；旧记录缺快照时明确标unknown。

Worker IPC 每条消息上限 8 MiB，文本产物入口上限 4 MiB，HTTP body 上限 2 MiB，超限明确失败而非截断；这些传输限制不等于模型 token 预算。Host 对 IPC 用 ACK 控制背压，但不能据此声称 acpx 内部队列或全部输出已受同样约束。

Windows 进程监督尚未原生验收；当前没有统一读/写/网络沙箱。API `/v1/engines` 把能力分为configured、observed和validated：observed按profile revision区分，只含本进程实际记录的Runtime控制/模型信息，不推导恢复或平台支持；没有验证时validated为null。[通用 CLI Driver](cli-driver.md)、[动态发现与管理](engine-management.md)和 [文件与文本 Benchmark](benchmark.md)已实现；直接 Native SDK Driver、跨引擎续聊仍未实现。

独立导出命令为 `node dist/src/cli.js rollout --url http://127.0.0.1:3180 --run RUN_ID --output FILE`。它读取同一Gateway轨迹接口，流式写入新文件，拒绝覆盖，失败清理半成品。对运行中的Run，导出只包含当时已提交的事件，不能称为完整终态轨迹。
