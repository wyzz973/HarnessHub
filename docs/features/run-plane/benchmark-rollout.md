# Benchmark 与 rollout 导出

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 集成测试（真实 Gateway、Worker、SQLite，fake 引擎与 ACP 夹具；文件任务、权限、重新评分与崩溃窗口）、单元测试（报告）与 smoke（编译后的导出命令），本机 macOS arm64；真实引擎的文件任务只有 2026-09-05 比赛期 macOS 记录（Pi、OpenCode、DSH）；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [Benchmark 运行与重新评分](../../benchmark.md)、[执行服务与 API](../../runtime-api.md#恢复与已知限制)（导出命令） |

## 用途

用版本化的 dataset 让一个或多个引擎做同样的文本、JSON 或文件任务，每次 attempt 用独立的 Session 与工作目录，执行结果与评分分开保存，可以离线重新评分并输出成绩矩阵。rollout 导出把一次 Run 的已提交事件存成 JSON Lines 文件，作为可复查的执行轨迹。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 无 Benchmark 页面；轨迹导出见 [事件、SSE 回放与轨迹导出](events-replay.md) |
| 命令行 | `hh benchmark --dataset FILE --engines ID[,ID]... [--config FILE \| --demo] [--repeat 1] [--permissions deny\|allow-once] [--data-dir ./data/benchmark]`；`hh benchmark --regrade ATTEMPT_ID --data-dir DIR`；`hh benchmark --report --data-dir DIR [--batch BATCH_ID]`；`hh rollout --url http://127.0.0.1:3180 --run RUN_ID --output FILE` |
| HTTP | 无 Benchmark 接口；导出命令读取 `GET /v1/runs/{id}/rollout` |

## 已实现的能力

- dataset 为 `schemaVersion: 1`，含 dataset 与各 task 的 `id/version`、Run 输入（`text`、`timeoutMs`、可选 `outputs`）与版本化评判器；可选 `fixtureFiles` 至多 32 个文本文件，随 dataset 版本与 hash 保存，不复制主机任意文件。
- 准备时独占创建输入文件并记录相对路径、字节数与 SHA-256；提交 Run 前逐项核对完整文件清单，拒绝额外、丢失、修改与链接；`outputs` 不能与输入重叠。
- 每个 attempt 新建 Session 与独占工作区，经 `startHub → HubApplication → Runtime → Worker` 执行；`--engines` 为每个引擎分别准备，`--repeat` 增加独立重复，一个批次至多 1000 个 attempt，依次执行。
- 评判器：`text-exact`（UTF-8 完全一致）、`json-equal`（忽略对象键顺序与空白，保留数组顺序与类型）、`file-sha256`（按产物原始字节）；文本与 JSON 未指定 `artifactName` 时用 Run 的最终 `output`；声明的产物缺任一项即 `failed / required_output_missing`。
- 评分状态：`passed`（1）、`failed`（0）、`execution_failed`、`interrupted`、`evaluator_error`（后三者 score 为 null）；证据至多 8 MiB，文本与 JSON 存原文、二进制存 base64，并保存全部声明产物的 ID、名字、字节数与 hash。
- 权限：默认 `deny` 选实际的 `reject_once`，`allow-once` 选实际的 `allow_once`，每个请求只提交一次，缺少或有歧义时取消 Run。
- attempt 记录 dataset、task 与评判器版本、内容 hash、引擎、配置 revision、Run 配置快照、Node/OS/架构、权限策略与 Run/Session ID；`observedModel` 只从已提交的 `engine.capabilities`、`engine.model` 或 `engine.usage` 事件读取并保留来源序号。
- 重新评分只读保存的证据、不调用模型，每次新增一条 Evaluation 并保留历史；重启后用 Session 与 attempt 的幂等键补齐“Run 已提交、attempt 尚未绑定”的窗口，未知执行结果不重跑。
- 报告只读已保存记录，输出单个 `schemaVersion: 1` JSON：成绩矩阵、各引擎的计数与事后 best-of-engines 指标 `offlineCoverage`；用量与费用在组和引擎级保持 null，不把缺值补零。
- 退出码：全部计划任务通过且未中断为 0，其他失败为 1，命令行有误为 2；SIGINT/SIGTERM 取消当前 Run、等待终态并停止后续任务。
- `hh rollout` 只读取守护进程的导出接口，按网络分块流式写入新文件（0600），目标已存在（含软链接）时拒绝，失败时删除半成品；对运行中的 Run 只包含当时已提交的事件。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [benchmark-main.ts](../../../packages/daemon/src/benchmark-main.ts)、[runner.ts](../../../packages/runtime/src/benchmark/runner.ts)、[evaluation.ts](../../../packages/runtime/src/benchmark/evaluation.ts)、[report.ts](../../../packages/runtime/src/benchmark/report.ts)、[workspace.ts](../../../packages/runtime/src/benchmark/workspace.ts)、[benchmark.ts（契约）](../../../packages/core/src/benchmark.ts)、[benchmark-store.ts](../../../packages/store/src/storage/benchmark-store.ts)、[export.ts](../../../packages/cli/src/rollout/export.ts) |
| 测试 | [benchmark.test.ts](../../../tests/integration/benchmark.test.ts)、[benchmark-files.test.ts](../../../tests/integration/benchmark-files.test.ts)、[benchmark-report.test.ts](../../../packages/daemon/test/benchmark-report.test.ts)、[rollout.test.ts](../../../tests/smoke/rollout.test.ts)；示例 [benchmark-demo.json](../../../examples/benchmark-demo.json)、[benchmark-files.json](../../../examples/benchmark-files.json)、[benchmark-text.json](../../../examples/benchmark-text.json) |
| 决策 | [ADR 0004 文件任务、严格恢复与本机接入修复](../../decisions/0004-file-tasks-and-resume.md) |

## 已知限制与未验证

- Benchmark 启动自己的回环 Gateway 并独占 `--data-dir`，不能与正在运行的守护进程共用数据库；模型平面的 provider 与路由组存于各自数据目录的 SQLite 中，所以守护进程里配好的 `group/default` 在 Benchmark 的数据目录里并不存在。
- attempt 依次执行；独立工作区与路径检查不是 OS 文件系统沙箱；GUI 桌面重置不在范围内。
- 实际的引擎与 Adapter 版本、完整费用不在记录中；正式数据集尚未建立。
- dataset 的 `input` 复用 Run 输入的 schema，可以写 `model`，但 [Benchmark 文档](../../benchmark.md) 没有说明，命令行也没有按引擎指定模型的选项。
- Windows 原生验收未进行。

## 优化候选

- **现状**：`benchmark-main.ts` 是独立入口与独立数据目录。**方向**：改为实验性的 `hh eval`，dataset v1 原样可读，并能对运行中的守护进程提交（共用 provider 与账本）。**依据**：[05 第 8 节](../../proposals/oss/05-run-plane.md#8-评测)、[05 第 11 节](../../proposals/oss/05-run-plane.md#11-与现状的差异与迁移)。
- **现状**：attempt 严格依次执行。**方向**：在并发与工作区隔离允许时并行执行，并支持同一任务多引擎的比较批次。**依据**：[Benchmark 运行](../../benchmark.md#运行)“当前依次执行”、[05 第 7 节](../../proposals/oss/05-run-plane.md#7-并行运行与比较)。
- **现状**：比较模型只能改 dataset。**方向**：增加按批次或按引擎指定 `model`（Model Ref 或路由组）的选项，报告中记录目标与账本中的实际模型。**依据**：阅读代码的观察（`benchmark.ts` 的 task `input` 复用 `runInputSchema`），以及 [任务经共享网关](runs-on-gateway.md)。
- **现状**：GUI 桌面重置、完整的引擎/Adapter 版本与费用采集、正式数据集与 Windows 原生验收仍未做。**方向**：按优先级逐项补齐，先记录版本。**依据**：[验证与边界](../../benchmark.md#验证与边界)。
