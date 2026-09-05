# Benchmark 运行与重新评分

Benchmark 支持版本化文本、JSON 及文件任务，复用 `startHub → HubApplication → Runtime → Worker` 执行。每次 attempt 拥有新 Session 和独占 workspace；可从 dataset 准备固定输入文件。执行 `completed` 与任务判分分别持久化，Agent 的“已完成”回复不作为文件任务得分。

## 运行

在项目根目录安装依赖并执行 `pnpm build`，使用项目固定的 Node 24。下面的 `PATH` 仅影响本次命令。

无需凭证的 Worker 示例：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --demo --dataset examples/benchmark-demo.json --engines fake --data-dir ./data/benchmark-demo
```

真实引擎的[文件任务](../examples/benchmark-files.json)读取 CSV 订单和 JSON 规则，计算汇总，写出 `result.json` 与 `summary.txt`：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --config engines/local.yaml --dataset examples/benchmark-files.json --engines dsh,opencode --permissions allow-once --data-dir ./data/benchmark-files
```

该样例以 `json-equal` 检查 `result.json` 的所有字段与数组顺序，并要求两份文件都已登记。`summary.txt` 的存在与字节完整性会检查，但此样例没有单独评判其文字正确性。文本任务可使用 [benchmark-text.json](../examples/benchmark-text.json)。引擎 ID 必须已配置；CLI 不安装引擎或补充凭证。

`--engines dsh,opencode` 为每个引擎分别准备 workspace；`--repeat 2` 增加独立重复次数。一个批次最多 1000 个 attempt，当前依次执行。每次输出 attempt、Run、引擎、配置 revision、执行状态和 Evaluation，最后给出计划、执行和通过数量。只有全部计划任务评分通过且未中断，进程才退出 0。

Benchmark CLI 启动仅绑定回环地址的 Gateway，端口自动分配，必须独占自己的 `data-dir`；不能与已运行 Gateway 共用数据库。历史数据和上一批 workspace 均保留。SIGINT/SIGTERM 通过 Runtime 取消当前 Run，等待终态并停止后续任务。

## 数据集与文件准备

格式由[领域契约](../src/domain/benchmark.ts)定义：`schemaVersion: 1`、dataset `id/version`、不同的 task `id/version`、`input.text/timeoutMs` 和版本化 evaluator 为必需项。

可选 `fixtureFiles` 是最多 32 个 `{ "path": "inputs/data.json", "text": "..." }`。内容随 dataset 版本和 hash 保存，不接受主机任意文件路径复制。单个字符串最多 1,048,576 字符，每任务全部 UTF-8 输入不超过 8 MiB。路径使用 `/` 分隔的相对文件名，拒绝绝对路径、父目录、符号链接、大小写或 Unicode 别名、文件/目录重叠及 Windows 保留名。

准备时独占创建文件并记录 `initialFiles` 的相对路径、字节数和 SHA-256。提交 Run 前逐项检查实际字节和完整文件清单，拒绝额外文件、目录、丢失文件、修改和符号链接。`input.outputs` 与输入文件不可重叠，以免预先存在的答案被误计为引擎产出。未带 `initialFiles` 的历史 v1 attempt 按原先“空 workspace”检查，不重写旧记录。

`input.outputs` 显式声明预期产物的 `{ path, name, mediaType? }`。Runtime 在执行完成后收集并登记，Benchmark 只按本 Run 的 artifact 名称取证。所有声明输出都必须唯一存在，缺任意一项即为 `failed / required_output_missing`，即使选定答案本身正确也不能通过。文件收集的路径、期限和清理限制见 [运行/API 说明](runtime-api.md)。

## 确定判分

| evaluator | expected | 判分行为 |
|---|---|---|
| `text-exact`, version `"1"` | 字符串 | UTF-8 文本完全一致，空格、换行、Unicode 均不自动归一化 |
| `json-equal`, version `"1"` | JSON 值 | 解析后比较完整结构；忽略对象键顺序和格式空白，保留数组顺序与数值/字符串类型差别 |
| `file-sha256`, version `"1"` | 64 位小写十六进制 SHA-256 | 必须提供 `artifactName`，按原始二进制字节 hash 判分 |

文本和 JSON 评判器省略 `artifactName` 时使用已提交 Run 的最终 `output`；提供时必须唯一匹配本 Run 已登记的 artifact。JSON 解析失败是答案错误 `failed / invalid_json`。重名产物、读取或证据完整性故障是 `evaluator_error`。

选定证据最多 8 MiB，超限明确失败，不截断。新记录始终保存原始字节数和 hash；文本/JSON 保存 UTF-8 原文，二进制保存 base64，因此重新评分不依赖原文件仍在磁盘。所有声明输出另保存登记的 ID、名字、字节数与 hash。捕获时校验 Run/Session 归属、文件字节和登记元数据；跨 attempt 证据或 hash/大小被篡改不得评分。

| Evaluation 状态 | 含义 | score |
|---|---|---|
| `passed` | 执行 completed，必需产物存在，选定证据符合评判器 | 1 |
| `failed` | 执行 completed，但答案错误或产物缺失 | 0 |
| `execution_failed` | 设置失败、引擎失败、取消或超时 | null |
| `interrupted` | Runtime 恢复后无法确认原执行结果 | null |
| `evaluator_error` | 证据读取、归属或完整性故障 | null |

## 权限与观测信息

`--permissions deny` 是默认策略，收到权限请求立即选择其实际 `reject_once` option ID。`--permissions allow-once` 只针对本次请求选择实际 `allow_once` ID，每个 permission ID 仅提交一次。缺少相应选项或选项有歧义时取消 Run，不猜测 ID，也不创建持久允许规则。Runtime 先持久化决定，再等待 Worker 应用；报告保留决定与 `applied/decided/expired` 状态。这只覆盖传到公共权限通道的请求，不自动覆盖引擎内部所有工具路径。

attempt 保存 dataset/task/evaluator 版本、内容 hash、引擎、配置 revision、Run 配置快照、Node/OS/架构、权限策略、工作目录及 Run/Session ID。`configuredModel` 来自配置快照；`observedModel` 只从已提交的 `engine.capabilities`、`engine.model` 或 `engine.usage` 事件读取，保留来源事件序号，回合后的模型观测可覆盖执行前值。

ACP usage 可能来自 `acp-session-checkpoint`，包含会话累计 token、逐请求 token 或 cost；报告保留原字段并标记 `usageScope`。它不能直接当成任意 Run 的增量消耗相加。没有观测的 model、usage、cost、引擎/Adapter installation 均为 null。当前 ACP 公共状态不提供可验证的实际引擎/Adapter 版本，仍需在真实验收记录补充。

## 持久化、恢复与重新评分

`benchmark_attempts`、`evaluations` 使用独立 `benchmark_metadata.schema_version = 1`。本次增量字段均可选，原有 v1 文本记录继续可读，没有修改既有数据库初始化或重写已保存记录。Benchmark Store 只在当前进程拥有 Gateway 数据目录运行锁时写入；Worker 不写评测表。

重新评分仅读取保存证据，不调用模型，每次新增 Evaluation 并保留历史分数：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --regrade ATTEMPT_ID --data-dir ./data/benchmark-files --config engines/local.yaml
```

替换为实际 attempt ID。重启先由 Runtime 恢复公开 Run，再用 Session 与 attempt 的 Idempotency-Key 补齐“Run 已提交、attempt 尚未绑定”的窗口；绑定要求 Run 属于该 Session 且 key 等于 attempt ID。已保存终态/证据但缺少评分时仅补 Evaluation。未知执行结果不自动重跑；尚未执行的旧准备记录标记设置中断。

## 成绩矩阵

报告只读取已保存记录，不执行任务、恢复或重新评分：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --report --data-dir ./data/benchmark-files --config engines/local.yaml
```

输出单个 `schemaVersion: 1` JSON。可加 `--batch BATCH_ID`；不指定时按 batch 和 dataset 的 `id/version/sha256` 分组。`--report` 与执行或 `--regrade` 参数互斥。每个 attempt 采用最后一次提交的 Evaluation，并展示重新评分次数，不重复计分。

`matrix` 包含任务/引擎、配置和观测模型、来源事件、权限决定、Run、执行与评分状态、score、原因、证据 hash、预算与已有 usage/cost。`engines` 汇总通过、答案错误、执行失败、中断、评判错误、未提交与未评分数量。组和引擎级 usage/cost 总和保持 null，不将缺值补零或直接累加会话统计。

`offlineCoverage` 是事后 best-of-engines 指标：同组 task/version 的任一已提交 attempt 通过，即覆盖一次。分母只包括该组已有 Run 的不同任务；未提交任务和重复 attempt 不扩大分母。不能从记录推断完整任务集覆盖率，所以 `completeDatasetCoverage` 为 null，是否计入比赛成绩仍待赛题规则。

## 验证与边界

macOS 上新增文件集成覆盖正式 Gateway/SQLite/Worker 的 fixture 准备与污染拒绝、文件自动采集、二进制原文/hash、缺失产物、对象键顺序和非法 JSON、一次权限实际 ID、保存证据重启/原文件删除后的重新评分。旧 Benchmark 执行、提交关联恢复、存储失败不伪装、报告只读入口继续验证；具体命令和真实引擎记录见 [开发文档索引](README.md)。

独立 workspace 和路径检查不提供 OS 文件系统沙箱。GUI 桌面重置、完整引擎/Adapter 版本与费用采集、正式比赛数据集和 Windows 原生验收仍待推进，见 [TODO](../TODO.md)。
