# 备份与恢复

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 已实现 |
| 验证 | 单元测试（信封的 600,000 次迭代往返、错误口令、任一字段被改即无法打开；Library 与网关功能的携带格式；旧限额字段转换）、集成测试经正式守护进程、文件秘密后端、严格假上游与真实 `hh backup\|restore`（逐项内容、`--no-keys`、预览与写入一致、外部引用与拒绝项、重新接线 Codex 与 Claude Code、Library 恢复后同步写入 Agent），在 macOS arm64 本机通过；Windows 未验证 |
| 对照 Magpie | 部分：口令加密文件、内容、`--no-keys` 与恢复四行相同；Gateway keys exported in full 与 Library MCP secrets 两行有意不同；All settings 与 `backup --no-library` 两行部分（[Backup and sync](../../magpie-parity.md#backup-and-sync)） |
| 权威文档 | [备份、恢复与同步](../../backup-sync.md#恢复)、[备份的内容](../../backup-sync.md#备份的内容)、[文件格式](../../backup-sync.md#文件格式) |

## 用途

把本机模型平面的配置（provider 与凭据、路由组、Agent 接线、Profile、Library、网关功能与部分设置）封进一个用口令加密的文件，在另一台电脑或重装后恢复。恢复先给出完整摘要，确认后逐条写入，并为本机已安装的 Agent 以新 Key 重新接线。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 备份与同步（`/settings/backup`）：口令输入两次后下载；恢复先上传、输入口令并预览，确认后恢复 |
| 命令行 | `hh backup [--no-keys] [file]`（默认 `harnesshub.harnesshub-backup`）；`hh restore [--no-agents] [--no-library] [--allow-references] <file>` |
| HTTP | `POST /api/v1/backup`、`POST /api/v1/restore`（`dryRun` 只返回摘要）；SDK `client.backup.create`、`client.backup.restore` |

## 已实现的能力

- 文件是 JSON 信封：PBKDF2-SHA256 600,000 次、16 字节盐派生 32 字节密钥，AES-256-GCM 加密，附加认证数据绑定格式、迭代次数与盐；打开时限制迭代次数范围与 64 MiB 文件大小，口令错误与内容被改统一报 `BACKUP_PASSPHRASE`，更新版本报 `BACKUP_UNSUPPORTED`。
- 口令只来自隐藏提示（备份时输入两次）或 stdin 的一行，从不出现在命令行参数中；写出的文件为 0600，已存在时先确认。
- 内容：provider（含凭据：`store` 秘密带值，`--no-keys` 时只有名称与协议并去掉名称像密钥的请求头；`env`、`file`、`keychain` 引用原样）、路由组、Agent 的接线意图（不含配置文件）、Profile、Library（Skill 单文件超过 2 MiB 或累计超过 32 MiB 后不带）、网关功能、局域网共享与目录设置，以及 `client:` Key 的名称、范围、限额与到期时间（不含 Key 文本）。
- 恢复前先演练：`hh restore` 打印摘要并询问，控制台显示预览；非交互且没有 `--yes` 时以 4 退出、什么都不写。
- 恢复不清库：同 id 替换、其余新增，本机另有的记录保留；新秘密先写入，provider 写入失败时删除。
- 外部引用会让守护进程读取它指向的秘密并发往备份给出的主机：这类凭据列入 `providers.references`，需要明确确认（接口 `references: true`，否则 409 `BACKUP_REFERENCES`；`hh restore` 在终端回答，`--yes` 时还需 `--allow-references`，否则以 4 退出）。
- 指向 HarnessHub 自身秘密的凭据（`HH_`、`HARNESSHUB_` 变量，数据目录或配置目录中的文件）与写成外部引用的搜索 Key 永不恢复，连同原因列入 `providers.refused` 与 `search.refused`。
- 备份会关闭本机开着的出站脱敏时，预览与结果都给出 `WARNING`（控制台在顶部醒目提示）。
- 订阅 provider 与它们的账号不进入备份，较早备份中的列入 `signInAgain`；恢复后仍没有凭据的 provider 列入 `needKey`。
- Agent：对本机已安装的 Agent 先预览再以该预览接线，签发新的 `agent:` Key 并恢复隐藏的模型；未安装的跳过，已相同的不动，一个失败不影响其他；`--no-agents` 跳过。`client:` Key 只列出，附重新签发所需的 `hh key create` 选项。
- 带入 Library 后，接着对本机 Agent 预览 Library 同步并再次确认；`--no-library` 跳过。有 Agent 接线、共享设置或 Library 同步失败时 `hh restore` 以 1 退出并逐项列出。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/daemon/src/backup.ts](../../../packages/daemon/src/backup.ts)、[packages/daemon/src/backup-envelope.ts](../../../packages/daemon/src/backup-envelope.ts)、[packages/daemon/src/features-backup.ts](../../../packages/daemon/src/features-backup.ts)、[packages/daemon/src/library-backup.ts](../../../packages/daemon/src/library-backup.ts)、[packages/daemon/src/http/backup-routes.ts](../../../packages/daemon/src/http/backup-routes.ts)、[packages/cli/src/backup.ts](../../../packages/cli/src/backup.ts)、[packages/console/components/backup-page.tsx](../../../packages/console/components/backup-page.tsx) |
| 测试 | [packages/daemon/test/backup-envelope.test.ts](../../../packages/daemon/test/backup-envelope.test.ts)、[packages/daemon/test/backup-quota.test.ts](../../../packages/daemon/test/backup-quota.test.ts)、[tests/integration/backup-restore.test.ts](../../../tests/integration/backup-restore.test.ts)、[tests/integration/backup-library.test.ts](../../../tests/integration/backup-library.test.ts)、[tests/integration/backup-features.test.ts](../../../tests/integration/backup-features.test.ts)、[tests/integration/backup-sync-security.test.ts](../../../tests/integration/backup-sync-security.test.ts)、[tests/integration/secret-refs.test.ts](../../../tests/integration/secret-refs.test.ts) |
| 决策 | 格式与取舍写在 [备份、恢复与同步](../../backup-sync.md#与-magpie-的差异)；设计输入见 [07 第 3 节](../../proposals/oss/07-data-security.md#3-导出导入与备份) |

## 已知限制与未验证

- 不在备份中：`config.jsonc` 的其他启动设置（含出站代理）、任何 Gateway Key 的文本、Session 与 Run、用量账本、引擎目录与 Tool Pack、统一模型文件、Agent 自己的登录与订阅账号。它不是执行平面的灾难恢复。
- 文件格式是 HarnessHub 自己的，Magpie 的备份不能打开；没有 provider 图标与排序；目录设置只比较、不恢复。
- `hh backup` 不能排除 Library（只有恢复有 `--no-library`）。
- 恢复逐条写入，每条原子，但整次恢复不是一个事务；模型平面 API 的写入可能落在两条记录之间。
- Windows 上未验证（包括 0600 文件权限的对应做法）。

## 优化候选

- **现状**：Session、Run 与用量账本不在任何备份中。**方向**：按 07 第 3 节提供数据库一致快照（`VACUUM INTO`）的备份或 `hh export runs`，与现有的配置备份分开。**依据**：[07 第 3 节](../../proposals/oss/07-data-security.md#3-导出导入与备份)。
- **现状**：备份总是带上 Library。**方向**：增加 `hh backup --no-library` 与对应的 API 选项。**依据**：[对照表](../../magpie-parity.md#backup-and-sync) `backup --no-library` 一行（部分）。
- **现状**：恢复中途失败会留下部分写入的记录。**方向**：评估把同一部分的写入放进一个事务，或在摘要中列出已写入与未写入的部分。**依据**：[恢复](../../backup-sync.md#恢复)末段的说明与 07 第 3 节“在一个事务中写入”的设计。
- **现状**：恢复后的 `client:` Key 需要逐个手工重建。**方向**：在确认后按备份的名称、范围与限额批量签发新 Key 并一次性显示。**依据**：[恢复](../../backup-sync.md#恢复)中 client Key 一条（只列出 `hh key create` 选项）。
