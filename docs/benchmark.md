# Benchmark 运行与重新评分

当前支持版本化文本任务与 HarnessHub 已登记文本 artifact 的精确判分。每次任务都创建新的 attempt、Session 和空 workspace，经同一个 `startHub → HubApplication → Runtime → Worker` 执行；Benchmark 没有第二套引擎执行器。`completed` 只表示执行正常结束，答案是否正确独立保存为 Evaluation。

## 运行

先在项目根目录完成依赖安装与 `pnpm build`，使用项目固定的 Node 24。下面命令中的 `PATH` 仅影响本次命令。

无需凭证的真实 Worker 示例：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --demo --dataset examples/benchmark-demo.json --engines fake --data-dir ./data/benchmark-demo
```

输出每个 attempt 的 Run ID、引擎、配置 revision、执行终态与评分，最后输出 `planned: 2, executed: 2, passed: 2`，退出码为 0。示例覆盖普通输出与已登记 artifact，两者都严格保留空格、换行和 Unicode 字符，不自动 trim。

本机已经配置好的真实引擎可以直接运行[文本任务示例](../examples/benchmark-text.json)：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --config engines/local.yaml --dataset examples/benchmark-text.json --engines dsh --repeat 1 --data-dir ./data/benchmark-dsh
```

`--engines dsh,codex` 表示同一任务分别交给这些引擎，每个组合独立准备 workspace；`--repeat 2` 增加独立重复次数。一个批次最多 1000 个 attempt，当前按顺序执行以使预算与失败位置清晰。CLI 不自动批准权限，也不安装引擎或补充凭证。收到 SIGINT/SIGTERM 后，通过 Runtime 取消当前 Run，等待其终态并停止后续任务。

Benchmark CLI 自己启动一个仅绑定回环地址的 Gateway，端口自动分配。它必须独占自己的 `data-dir`，不能与正在运行的 Gateway 共用数据库；引擎配置可以复用。数据目录保留历史，不删除或覆盖上一批 workspace。

## 任务与评分

任务格式以[领域契约](../src/domain/benchmark.ts)和[示例](../examples/benchmark-demo.json)为准。必需包含 `schemaVersion: 1`、dataset `id/version`、不重复的 task `id/version`、`input.text/timeoutMs`、`evaluator.id: text-exact`、`evaluator.version: "1"` 和 `expected`。

省略 `artifactName` 时，评判已提交 Run 的最终 `output`；提供 `artifactName` 时，名字必须唯一对应本次 Run 的已登记 artifact。未产生指定输出计为 `failed`，重名 artifact、读取/完整性故障计为 `evaluator_error`。文本证据最多 8 MiB；超限明确失败，不截断后评分。

| Evaluation 状态 | 含义 | score |
|---|---|---|
| `passed` | completed 且证据逐字符匹配 | 1 |
| `failed` | completed，但答案错误或指定输出缺失 | 0 |
| `execution_failed` | 设置失败、引擎失败、取消或超时 | null |
| `interrupted` | Runtime 恢复后判定 Run 结果未知 | null |
| `evaluator_error` | 证据读取、归属或完整性校验失败 | null |

退出码仅在全部计划 attempt 都完成且评分 passed 时为 0。出现失败或中断为非零，不能将执行成功率当作任务得分。

## 持久化、恢复与重新评分

`data-dir/harnesshub.sqlite` 新增 `benchmark_attempts`、`evaluations` 表，通过独立 `benchmark_metadata.schema_version = 1` 管理版本，不改写已有 Runtime 数据库版本。Gateway 进程持有数据库运行锁后才能创建 Benchmark Store；Worker 不写评测表。

attempt 保存 dataset 内容 hash、task/评判器版本及输入、引擎 ID、实际采用的 profile revision、Run 配置快照、Node/OS/架构、workspace、Run/Session 关联。模型字段是 Profile/Run 配置中可得的值；未记录的实际后端模型、Adapter 版本或 usage 不能推断为已知，也不能将缺失成本计为零。

任务结束时校验当前 workspace 身份、artifact Run 归属及内容 hash，然后将选中的 UTF-8 文本、来源和 hash 与 attempt 一起持久化。不同 attempt 的证据不能串用。重新评分只读取这份保存证据，不重新调用模型，也不依赖原 artifact 文件仍在磁盘：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --demo --regrade ATTEMPT_ID --data-dir ./data/benchmark-demo
```

将 `ATTEMPT_ID` 替换为前次输出的实际 ID。每次评分新增 Evaluation，原分数不被覆盖。重启时先由 Runtime 恢复公开 Run，再用 Session 与 attempt Idempotency-Key 补齐“Run 已提交但 attempt 关联尚未写入”的窗口；已保存终态和证据但缺少评分时，只补写 Evaluation。未知结果记录 interrupted，不自动重跑。尚未执行的旧准备记录标记为设置中断。

## 保存成绩矩阵

报告从已保存的 attempt 与 Evaluation 重建，不调用模型、不重新评分，也不另建成绩事实表：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --report --data-dir ./data/benchmark-dsh --config engines/local.yaml
```

输出为单个 `schemaVersion: 1` JSON。`--batch BATCH_ID` 可以只查看一个批次；不指定时，按 batch 与 dataset 的 `id/version/sha256` 分组，各组独立汇总。`--report` 与 `--dataset`、`--engines`、`--regrade` 互斥。报告模式仍通过正式启动入口获取数据目录所有权，但不调用 Benchmark 的恢复评分逻辑，因此准备中、未提交和未评分记录不会被伪造为失败。

`matrix` 每行包含 task/version、engine、configuredModel、observedModel、profile revision、attempt/repetition、Run ID、执行与评分状态、score、失败原因、证据 hash 及预算。`configuredModel` 只来自保存的 Run 配置快照；当前未保存实际观察模型，所以 `observedModel` 为 null。每个 attempt 只采用最后一次已提交 Evaluation，并列出评分总数与重新评分次数，旧评分不会重复计分。

`engines` 分别给出已提交、通过、答案错误、执行失败、中断、评判错误、未提交和未评分数量。`offlineCoverage` 是事后 best-of-engines 指标：同组某个 task/version 只要任一已提交 attempt 的最新评分通过就覆盖一次；分母仅为该组实际已有 Run 的不同任务，重复 attempt 不重复增加任务数。尚未提交的任务不计作失败，也不进入这个分母。完整任务集覆盖率不可从现有记录推出，故 `completeDatasetCoverage` 为 null；比赛是否采纳这个指标仍待规则确认。所有未知 usage 与 cost 均输出 null，不能据此推断免费或零消耗。

## 验证与边界

macOS、Node 24.20.0 上执行了 `pnpm build` 与 `node --test dist/tests/integration/benchmark.test.js`，4 项集成测试通过：正式 Gateway/SQLite/Worker 的正确与错误答案、引擎失败和超时、登记 artifact、独立目录污染拒绝、重启和保存证据重新评分、跨 attempt 证据拒绝、提交关联恢复、真实 SQLite 写入故障保留与恢复，以及编译 CLI 示例 2/2 成功。修改范围的 ESLint 检查通过。

新增 `node --test dist/tests/unit/benchmark-report.test.js` 的 2 项检查通过，覆盖批次/数据集分组、最新评分、离线覆盖、未知值、证据归属，以及编译后 `--report` 只读取准备记录、不创建 Run 或 Evaluation 的 smoke；报告功能没有再次调用模型。

独立 workspace 防止重复使用目录造成的串用，不提供 OS 文件系统沙箱：当前引擎仍可能访问进程权限允许的其他目录。原始 workspace 文件评判、GUI 桌面重置、实际模型/Adapter 版本与 usage/cost 完整采集尚未实现；Windows 原生 Benchmark 和正式任务集评分仍待分别验证，详见 [TODO](../TODO.md)。
