# 多机同步

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 已实现 |
| 验证 | 单元测试（SigV4 与 AWS 公布的 7 个签名示例逐字一致；WebDAV 的条件写、截断重写、限流与登录失败；调度的首延迟、3 分钟周期与退避）、集成测试（两台或三台守护进程经回环上的假 WebDAV 与假 S3 同步：首次推送、加入、抢先写入后重读合并、冲突副本、镜像删除、防回滚与 `--accept-older`、脱敏关闭的传播与保持、真实 `hh sync` 读口令），在 macOS arm64 本机通过；没有对真实 WebDAV 或 S3 服务验证；Windows 未验证 |
| 对照 Magpie | 部分：WebDAV and S3 sync 与 Three-way merge 两行相同；A settings part, `library=no`, usage shared 一行部分；Sync secrets in `sync.json` 一行有意不同（[Backup and sync](../../magpie-parity.md#backup-and-sync)） |
| 权威文档 | [备份、恢复与同步：同步](../../backup-sync.md#同步)、[API 与 SDK](../../backup-sync.md#api-与-sdk) |

## 用途

让几台电脑经同一个 WebDAV 目录或 S3 兼容存储桶自动保持 provider、Agent 接线、Profile、Library 与网关功能一致。服务器上只有用同步口令加密的文件，两边同时改动时保留后改的一边并把被替换的一方存为副本。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 备份与同步：WebDAV 或 S3 设置、状态、立即同步、“接受较旧的文件”与关闭 |
| 命令行 | `hh sync webdav on <https://…> [user=NAME] [keys=yes\|no] [agents=yes\|no]`；`hh sync s3 on <s3://bucket[/prefix]> access-key-id=ID [endpoint=URL] [region=R] [path-style=yes\|no]`；`hh sync status\|now [--accept-older]\|off` |
| HTTP | `GET`、`PUT`、`DELETE /api/v1/sync`；`POST /api/v1/sync/now`（`acceptOlder`）；SDK `client.sync.status`、`configure`、`disable`、`now` |

## 已实现的能力

- 默认关闭。设置存于 `<dataDir>/sync/config.json`（0600），WebDAV 密码、S3 secret key 与口令只保存为密钥存储的引用；口令与秘密从隐藏提示或 stdin 的行读取。`on` 保存后立即同步一次，地址、密码或口令有误马上显示。
- 服务器对象为 `<地址>/harnesshub/harnesshub.harnesshub-backup`，格式与备份文件相同，服务器只持有密文。
- 调度：开启后约 20 秒首次同步，之后每 3 分钟一次，单次最长 2 分钟；限流（429、503、S3 SlowDown）时按 `Retry-After` 等待（3 分钟到 6 小时），没有时翻倍退避到 30 分钟。
- 按五部分（`providers`、`agents`、`profiles`、`library`、`features`）三方合并：`state.json` 记录上次两边各部分的 SHA-256 与 ETag；只有一边改了取那一边；两边都改时比较本机该部分的最新修改时间与服务器文件的生成时间，保留后改的一边。
- 被替换的一方完整保存到 `<dataDir>/sync/conflicts/`（本机副本加密），状态的 `notice` 写明哪部分被谁替换。
- 带入是镜像：服务器上已没有的 provider、路由组、Profile、Library 条目与搜索后端在本机删除；仍被未吊销 Key 或保留的路由组引用的 provider 保留并列入 `notice.kept`；订阅 provider 不上传也不被删除；`agents` 只对本机已安装的 Agent 接线，`agents=yes` 时再把 Library 同步进本机 Agent。
- 出站脱敏的关闭随同步传播，带入后关闭了本机脱敏时状态给出 `notice.redactionOff` 并在 `hh sync status` 以 `WARNING` 提示；服务器的网关功能不比本机严格更新时本机保持开启，给出 `notice.redactionOffHeld`。
- 防回滚：同步文件在加密内容中带 `generation`，读到比本机见过的更旧的文件时拒绝（409 `SYNC_ROLLBACK`，状态的 `lastErrorCode`）；确认后 `hh sync now --accept-older` 或控制台按钮接受它并写回更新的文件。
- 条件写：WebDAV 与 S3 都以 `If-Match`（首次 `If-None-Match: *`）写回，被抢先时重新读取、合并并重试一次，仍被抢先报 `SYNC_CONFLICT`；不支持条件写的 S3 改用 HEAD 比较 ETag，开启了版本的桶写后核对版本序列。
- 外部引用照常带入，只有指向 HarnessHub 自身秘密的被跳过并写进 `notice.refused`。
- S3 签名（SigV4）在 [sync-remote.ts](../../../packages/daemon/src/sync-remote.ts) 中用 `node:crypto` 手写，WebDAV 只用 `fetch`，没有新增依赖；请求经守护进程的出站代理。
- `hh sync off`（需确认）删除设置、状态、服务器副本缓存与两项秘密，保留冲突副本与服务器上的文件。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/daemon/src/sync.ts](../../../packages/daemon/src/sync.ts)、[packages/daemon/src/sync-remote.ts](../../../packages/daemon/src/sync-remote.ts)、[packages/daemon/src/http/backup-routes.ts](../../../packages/daemon/src/http/backup-routes.ts)、[packages/cli/src/backup.ts](../../../packages/cli/src/backup.ts)、[packages/console/components/backup-page.tsx](../../../packages/console/components/backup-page.tsx) |
| 测试 | [packages/daemon/test/sync-remote.test.ts](../../../packages/daemon/test/sync-remote.test.ts)、[packages/daemon/test/sync-loop.test.ts](../../../packages/daemon/test/sync-loop.test.ts)、[tests/integration/sync.test.ts](../../../tests/integration/sync.test.ts)、[tests/integration/backup-sync-security.test.ts](../../../tests/integration/backup-sync-security.test.ts)、[tests/integration/backup-features.test.ts](../../../tests/integration/backup-features.test.ts)、[tests/integration/backup-library.test.ts](../../../tests/integration/backup-library.test.ts) |
| 决策 | 合并、脱敏传播与防回滚的取舍写在 [备份、恢复与同步](../../backup-sync.md#同步) 与 [与 Magpie 的差异](../../backup-sync.md#与-magpie-的差异) |

## 已知限制与未验证

- 只对回环上的假 WebDAV 与假 S3 服务器验证过；坚果云、Synology、Nextcloud、AWS、R2、MinIO 等真实服务未验证。Windows 未验证。
- 不同步：局域网共享与目录设置（避免在另一台机器上意外开放局域网）、`config.jsonc` 的启动设置、`client:` Key 与用量；没有 `library=no`，Library 总是同步。
- 既不支持条件写也未开启版本的 S3 服务，在 HEAD 与 PUT 之间的写入无法发现。
- “后改的一边”比较的是不同机器写下的时间，依赖各机器的时钟。
- 口令保存在本机密钥存储中以便无人值守同步，能读取本账户秘密的人也能打开服务器上的副本。
- 冲突副本没有保留期限，`<dataDir>/sync/conflicts/` 会一直增长（阅读 [sync.ts](../../../packages/daemon/src/sync.ts) 的观察：只写不清理）。

## 优化候选

- **现状**：只对假服务器验证。**方向**：对至少一种真实 WebDAV 与一种真实 S3（如 R2 或 MinIO）各跑一次加入、冲突与防回滚流程，并记录验收。**依据**：[备份、恢复与同步](../../backup-sync.md)现状段、[对照表](../../magpie-parity.md#harnesshub-for-magpie-users)的 Not verified 段。
- **现状**：Library 总是同步。**方向**：增加 `library=yes|no` 选项，与 `keys`、`agents` 并列。**依据**：[对照表](../../magpie-parity.md#backup-and-sync) A settings part, `library=no` 一行（部分）。
- **现状**：用量不跨机器共享。**方向**：评估只读汇总各机器账本的方式（不进入同步文件的合并）。**依据**：同一对照行（usage shared 部分）。
- **现状**：冲突副本只增不减。**方向**：按数量或时间保留最近的副本，并在 `hh sync status` 显示占用。**依据**：阅读代码的观察。
