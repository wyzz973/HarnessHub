# 文件产物采集

Run 的 `outputs` 声明需要保存的工作目录文件，字段定义见 [FileOutput](../src/domain/types.ts)，路径规则见 [公共输入校验](../src/domain/files.ts)。每项的 `path` 是 Workspace 内相对路径，`name` 是产物名称，`mediaType` 可选。省略 `outputs` 不扫描文件；声明列表必须为 1～32 项，名称和源路径分别唯一。

Agent 通过自己的工具写入 Workspace。后端正常完成后，Gateway 在总 deadline 内调用 [采集器](../src/artifacts/collector.ts)，读取声明文件的原始 bytes，写入自己的产物目录并同步到磁盘，然后登记 SQLite 元数据。二进制文件不经过 Worker IPC。已有 Worker 文本产物仍使用原来的 4 MiB 传输限额。

每个声明文件最多 16 MiB，一次采集累计最多 64 MiB。缺失文件以产物 `name` 返回给 Runtime，独立 Evaluator 据此判断任务不达标；缺失不被替换为空文件。`completed` 仍只表示执行完成，文件存在和任务正确性由评测结果表达。

路径不能包含绝对地址、父级遍历、反斜杠、盘符、空段、控制字符、Windows 设备别名或尾点/尾空格。Workspace 起点必须保持登记时的 canonical 路径。采集器逐层核查源目录，拒绝源文件和目录中的软链接，拒绝目录、特殊文件和多硬链接文件；读取使用 `O_NOFOLLOW`、有界分段读取以及前后文件身份、大小、mtime、ctime 检查，变化中的文件明确失败。这里是应用级文件检查，不是 OS 沙箱，也不承诺阻止引擎在自身工具中访问其他位置。

目标目录由 Gateway 创建，目录权限为 0700，文件权限为 0600。内部文件名使用独立 UUID；用户传入的名称不用于拼接目标路径。发布检查目标祖先及文件身份，出现错误或取消时删除本次尚未登记的目标。Runtime 在登记前再次仲裁取消和 deadline；未登记文件由 [discardArtifacts](../src/artifacts/publisher.ts)回收。源文件从不由采集器删除或修改。

声明 `mediaType` 时使用声明值；否则按有限扩展名表识别 txt、md、json、csv、html、pdf、png、jpg/jpeg、zip，其他文件使用 `application/octet-stream`。媒体类型不承担内容正确性判断。

已登记产物通过 `GET /v1/artifacts/:id` 获取。读取器只访问登记到产物根目录的文件，有界读取并验证大小与 SHA-256；源文件之后被改写不影响已发布快照，私有副本损坏则返回 `ARTIFACT_CORRUPT`。旧版 macOS `/var` 路径记录只进行对应 `/private/var` 系统别名归一化，不泛化为任意软链接兼容。

常见错误：

| 错误码 | 含义 |
|---|---|
| `INVALID_ARTIFACT_PATH` | 声明非法、重复名称/路径、软链接或 Workspace/目标目录不符合约束 |
| `ARTIFACT_NOT_REGULAR` | 源不是单一硬链接的普通文件 |
| `ARTIFACT_TOO_LARGE` | 单文件或本次总大小超限 |
| `ARTIFACT_CHANGED` | 文件或目录在访问中改变 |
| `ARTIFACT_IO_ERROR` | 其他文件访问失败 |
| `ARTIFACT_CORRUPT` | 已登记副本的大小或 SHA-256 不匹配 |

[文件集成测试](../tests/integration/file-artifacts.test.ts)覆盖真实 SQLite 登记与重开、二进制完整性、源修改后的快照稳定性、缺失、非法路径、源与目标软链接、Workspace 被替换、目录、硬链接、16/64 MiB 限额、中途失败回收、取消、旧文本发布兼容及并发修改拒绝。2026-09-05 在本机 macOS、Node 24.20.0 上执行 `pnpm build` 和 `node --test dist/tests/integration/file-artifacts.test.js`，9/9 通过。Gateway 集成及真实引擎证据由本轮主验收记录补充；本测试不是 Windows 原生证据。
