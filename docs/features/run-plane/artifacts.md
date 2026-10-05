# 文件产物

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 集成测试（真实 SQLite 与文件系统、正式 Gateway/Worker），本机 macOS arm64；Windows 专用测试（DACL、junction、文件锁、中文与空格路径）只在 Windows 上运行，开源版未单独验收；真实引擎的文件任务只有比赛期 macOS 记录（Pi、OpenCode） |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [文件产物采集](../../file-artifacts.md)、[业务存储与事件](../../../DESIGN.md#6-业务存储与事件)、[ADR 0004](../../decisions/0004-file-tasks-and-resume.md) |

## 用途

提交任务时声明“执行完要交回哪些文件”，HarnessHub 在 Agent 正常结束后把这些文件复制成不可变的产物并登记 hash。之后源文件被改写也不影响已交回的版本，下载时再次核对大小与 SHA-256；缺少的文件如实记录，由评判器判定任务不达标。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 任务（`/tasks`）→ 执行详情 → 产物下载 |
| 命令行 | 无独立命令；[Benchmark](benchmark-rollout.md) 的 dataset 用 `input.outputs` 声明产物 |
| HTTP | `POST /v1/sessions/{id}/runs` 的 `outputs`；`GET /v1/runs/{id}` 的 `artifacts`；`GET /v1/artifacts/{id}` |

## 已实现的能力

- `outputs` 为 1–32 项 `{path, name, mediaType?}`：`path` 是 Workspace 内的相对路径，`name` 是产物名，二者各自唯一；省略 `outputs` 时不扫描任何文件。
- 采集发生在后端正常完成之后、公共终态之前，Run 状态为 `finalizing`，计入总期限；取消或超时会中止采集，未登记的副本被回收。
- 每个文件至多 16 MiB，一次采集合计至多 64 MiB，超出为 `ARTIFACT_TOO_LARGE`；二进制文件不经过 Worker IPC。
- 缺失的文件记 `ARTIFACT_MISSING` 事件，不用空文件代替；Run 仍可为 `completed`，是否达标由评判器决定。
- 路径校验拒绝绝对路径、父级遍历、反斜杠、盘符、UNC、备用数据流、控制字符、Windows 设备名与尾点尾空格；采集器拒绝软链接、junction、目录、特殊文件与多硬链接文件，读取前后比较文件身份、大小与时间，变化时为 `ARTIFACT_CHANGED`。
- 副本写入 Gateway 自己的产物目录（POSIX 目录 0700、文件 0600；Windows 用受保护的 DACL），内部文件名是 UUID，不用用户给的名字拼路径；登记 hash、大小、媒体类型后才对外可见。
- 媒体类型优先用声明值，否则按有限的扩展名表识别，其他为 `application/octet-stream`。
- 下载只接受登记的产物 ID：有界读取并核对大小与 SHA-256，损坏为 `ARTIFACT_CORRUPT`；响应带 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox` 与 `X-Content-SHA256`。
- Windows 上采集期间持有共享读句柄，拒绝并发写入与删除。
- Worker 上报的文本产物（演示引擎的 `artifact` 场景）沿用 4 MiB 的传输上限。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [collector.ts](../../../packages/runtime/src/artifacts/collector.ts)、[publisher.ts](../../../packages/runtime/src/artifacts/publisher.ts)、[files.ts](../../../packages/core/src/files.ts)（路径规则）、[runtime.ts](../../../packages/runtime/src/runtime/runtime.ts)（`collectOutputs`）、[windows-acl.ts](../../../packages/store/src/platform/windows-acl.ts)、[server.ts](../../../packages/daemon/src/http/server.ts)（下载） |
| 测试 | [file-artifacts.test.ts](../../../tests/integration/file-artifacts.test.ts)、[gateway-files.test.ts](../../../tests/integration/gateway-files.test.ts)、[files.test.ts](../../../packages/runtime/test/files.test.ts)、[windows-file-artifacts.test.ts](../../../tests/integration/windows-file-artifacts.test.ts)、[windows-file-lock.test.ts](../../../tests/integration/windows-file-lock.test.ts) |
| 决策 | [ADR 0004 文件任务、严格恢复与本机接入修复](../../decisions/0004-file-tasks-and-resume.md) |

## 已知限制与未验证

- 没有上传接口，Run 输入不能携带文件或图像；`outputs` 也不能用作读取任意主机文件的入口。
- 只能列出具体文件，不支持目录或通配符。
- 这是应用级文件检查，不是 OS 沙箱，不阻止引擎用自己的工具访问其他位置。
- 产物永久保留，没有清理或保留期限。
- SMB/UNC 共享根、网络文件系统与不支持 DACL 的文件系统未验证；Windows 文件 symlink 用例在没有开发者模式时跳过。

## 优化候选

- **现状**：独立的二进制上传接口未实现，输入只有文本。**方向**：增加上传与 artifact 引用作为 Run 输入，同时更新 schema、能力检查与 Driver。**依据**：[执行服务与 API](../../runtime-api.md#权限与产物)、[DESIGN 第 7 节](../../../DESIGN.md#7-通用-api-基线)。
- **现状**：产物与 Run 记录一直保留。**方向**：按数据保留设计提供 `hh gc` 或每日清理，删除前先提交 `retention.pruned` 事件，未终结的 Run 不参与。**依据**：[05 第 10 节](../../proposals/oss/05-run-plane.md#10-容量回收与数据保留)、[07 第 2.3 节](../../proposals/oss/07-data-security.md#23-数据保留)。
- **现状**：缺失的声明文件只记 `ARTIFACT_MISSING` 事件，Run 仍为 `completed`；Run 记录没有缺失清单，控制台代码也不读取这个事件。**方向**：在 Run 视图与执行详情中直接列出缺失的产物。**依据**：阅读代码的观察（`runtime.ts` 的 `collectOutputs`、`packages/console` 中没有 `ARTIFACT_MISSING`）。
