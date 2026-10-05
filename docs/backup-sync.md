# 备份、恢复与同步

把本机的模型平面打包成一个用口令加密的文件，带到另一台机器恢复；或者经 WebDAV 目录、S3 兼容存储桶在多台机器之间自动同步。文件格式、按部分三方合并与条件写的做法参照 Magpie（[yetone/magpie](https://github.com/yetone/magpie)，MIT，`internal/backup` 与 `internal/davsync`，@2e340f7），实现是 HarnessHub 自己的。

现状：守护进程的 `POST /api/v1/backup`、`POST /api/v1/restore`、`/api/v1/sync`，SDK 的 `backup`、`sync`，`hh backup|restore|sync`，以及控制台“设置 → 备份与同步”页（`/settings/backup`，同样先预览摘要再恢复，带入 Library 后预览写入 Agent 的改动）已实现，并经正式守护进程入口、真实 `hh` 命令与本机回环上的假 WebDAV、假 S3 服务器验证（见文末）。没有对真实的 WebDAV 服务（坚果云、Synology、Nextcloud 等）或真实的 S3（AWS、R2、MinIO 等）验证，也没有在 Windows 上运行过。

## 使用

```sh
pnpm exec hh backup                      # 写 harnesshub.harnesshub-backup，口令从隐藏提示输入两次
pnpm exec hh backup --no-keys team.harnesshub-backup
pnpm exec hh restore team.harnesshub-backup            # 先显示摘要，确认后恢复
pnpm exec hh restore --no-agents --yes team.harnesshub-backup < passphrase.txt
pnpm exec hh restore --no-library team.harnesshub-backup  # 不带入 Library

pnpm exec hh sync webdav on https://dav.example.com/remote.php/dav/files/me user=me
pnpm exec hh sync s3 on s3://bucket/team access-key-id=AKIA... endpoint=https://<account>.r2.cloudflarestorage.com
pnpm exec hh sync status
pnpm exec hh sync now
pnpm exec hh sync off
```

口令（以及 WebDAV 密码或 S3 secret key）只从隐藏提示读取；stdin 不是终端时按行读取：需要目标凭证时第一行是它，下一行是口令；`hh backup` 与 `hh restore` 只读一行口令。它们从不出现在命令行参数中。`hh backup` 写出的文件权限为 0600，已存在时需确认。`hh restore` 先以 `dryRun` 取得摘要并打印，确认（或 `--yes`）后才恢复；非交互且没有 `--yes` 时以 4 退出、什么都不写。恢复带入了 Library 时，接着对本机已安装的 Agent 计划 Library 同步（`hh library sync` 的同一预览与应用），打印改动并再次确认（`--yes` 时直接应用）；拒绝时提示稍后运行 `hh library sync`。恢复后若有 Agent 接线、共享设置或这次 Library 同步失败，命令以 1 退出并逐项列出。`hh sync … on` 保存设置后立即同步一次，地址、密码或口令有误会马上显示；`hh sync off` 需确认。

`hh sync … on` 的选项：WebDAV 为 `user=`；S3 为 `access-key-id=`（必需）、`endpoint=`（缺省为 AWS 该区域的地址）、`region=`（缺省 `us-east-1`，R2 的地址自动用 `auto`）、`path-style=yes|no`（IP 地址、单段主机名与 HTTPS 下带点的桶名自动使用路径式）；两者都有 `keys=yes|no`（缺省 yes，凭证值随同步上传，加密后）与 `agents=yes|no`（缺省 yes，同步 Agent 接线）。

## 备份的内容

| 部分 | 内容 |
|---|---|
| providers | 每个 provider 的配置（不含凭证）、凭证（`store` 中的秘密：带 Key 时为值，`--no-keys` 时只有名称与协议；`env`、`file`、`keychain` 引用原样保留）、模型元数据来源与模型覆盖 |
| groups | 全部路由组 |
| agents | 每个已接线 Agent 的意图：Agent、model、tiers、effort、options、models（Key 的允许列表，`*` 为全部模型）与 deny（隐藏的模型，Key 的拒绝列表）；自行登录的 Agent（Codex 用 ChatGPT 登录）没有 model 与 models，只有 options。不含配置文件内容 |
| profiles | 全部接线 profile（各 Agent 的模型选择） |
| library | [Library](library.md) 的条目：指令集与正文；MCP 服务，秘密的 `env`、`file` 引用原样保留，`store` 秘密带 Key 时为值、`--no-keys` 时只有名称；Skill 的文件（base64），单个文件超过 2 MiB、或全部 Skill 累计超过 32 MiB 之后的文件不带，名称列入 `left`（规则同 Magpie `internal/library/carry.go`）。各条目的创建与修改时间随之保存。不含 Library 写入各 Agent 的记录（`applied.json`），那属于本机 |
| gatewayFeatures | [网关功能](gateway-features.md)（`gateway-features.json`）：出站脱敏的开关与用户规则、视觉兜底模型、联网搜索后端、用量提醒的阈值；搜索后端的 Key 按 provider 凭证的规则（`store` 秘密带 Key 时为值，`--no-keys` 时只标明有一个，外部引用原样）；最后修改时间 `updatedAt`。图像端点是 provider 记录的一部分，随 providers 一起 |
| settings | 局域网共享设置（`gateway-sharing.json` 的 lan 与 publicBaseUrl）；启动时的目录设置（`catalog.autoRefresh`、`catalog.url`） |
| clientKeys | 未吊销的 `client:` Key 的名称、允许范围、配额、LAN 与到期时间，用于提示重新签发 |

不在备份中：`config.jsonc` 中的其他启动设置（包括[出站代理](configuration.md#出站代理)），任何 Gateway Key 的文本或哈希（文本从不保存，因而不可恢复：恢复时 Agent 以新的 `agent:` Key 重新接线，`client:` Key 列为“需重新签发”）、Session 与 Run、用量账本、引擎目录与 Tool Pack、统一模型文件、Agent 自己的登录，以及[订阅 provider](subscriptions.md)（ChatGPT、Copilot）与它们的账号：账号是这台电脑上的登录（OAuth 授权或 CLI 登录），在每台电脑上分别登录，与 Magpie 相同（“sign in to them on each machine”）。`--no-keys` 另外去掉名称匹配 `auth|key|token|secret|cookie|session|password`（不区分大小写）的 provider 请求头，规则同 Magpie。

## 文件格式

文件是 JSON 信封，`format: "harnesshub-backup"`、`version: 1`、`kdf: "pbkdf2-sha256"`、`iterations`、`salt`、`nonce`、`data`（后三者为 base64）：

| 项 | 值 |
|---|---|
| 密钥派生 | PBKDF2-SHA256，600,000 次（OWASP 2023 建议值，与 Magpie 相同），16 字节随机盐，32 字节密钥 |
| 加密 | AES-256-GCM，12 字节随机 nonce；`data` 为密文后接 16 字节标签 |
| 附加认证数据 | `harnesshub-backup/1/pbkdf2-sha256/<iterations>/<salt 的十六进制>`，信封字段被改即无法打开 |
| 打开时的检查 | 迭代次数 100,000–10,000,000、nonce 12 字节、盐至少 16 字节、整个文件不超过 64 MiB；口令错误与内容被改统一报 `BACKUP_PASSPHRASE` |

解密后的内容为 `version: 1` 的 JSON，逐项按模型平面的记录校验器（`isProviderConfig`、`isRouteGroup`、`isModelOverride` 等）检查后才使用。`version` 或 `kdf` 更新的文件报 `BACKUP_UNSUPPORTED`，提示升级 HarnessHub；格式变化时递增版本，旧版本的读取规则写在本页。

## 恢复

`POST /api/v1/restore` 以 `{backup, passphrase, agents, dryRun}` 调用；`dryRun` 只返回摘要。恢复逐条写入，不清库，也不删除本机的任何记录：

- **provider**：同 id 替换，其余新增。凭证按备份：带值的写入密钥存储（本机同 id 凭证的值相同则沿用原引用），外部引用（环境变量、文件、钥匙串条目）需要确认后原样写入；新秘密先写入，provider 写入失败时删除；provider 写入后，本机不再被引用的旧秘密删除。备份不带 Key 时保留本机凭证（同 id 的以本机为准，本机另有的也保留），并保留本机名称像密钥的请求头。恢复后仍没有任何凭证、而备份中原本有凭证的 provider 列入 `needKey`。模型来源与覆盖随 provider 一起写入，本机有而备份中没有的覆盖被删除，使值、来源与覆盖保持一致。
- **外部引用**（2026-10-05，第二轮安全审查 M5）：备份中的外部引用会让守护进程读取它指向的秘密，并发往同一份备份给出的 provider 地址；构造的备份因此可以读走管理令牌、密钥存储或环境中的上游 Key。指向 HarnessHub 自己的环境变量（`HH_`、`HARNESSHUB_` 开头）或数据目录、配置目录中文件（解析链接后）的凭证永不恢复，列入摘要的 `providers.refused`（说明原因），确认了也不写入；同步带入时同样跳过并写进状态的 `notice.refused`。其余外部引用列入 `providers.references`（凭证、引用的种类与名称、Key 将发往的主机），本机同一凭证已按同样方式读取的不列；有这样的凭证时恢复需要明确确认：接口要 `references: true`，否则 409 `BACKUP_REFERENCES` 且什么都不写；`hh restore` 在预览中逐条列出，在终端中回答确认即可，`--yes` 或非交互时还需要 `--allow-references`，否则以 4 退出。控制台的预览以警告列出这些凭证与主机，勾选确认后“恢复”才可用，请求才带 `references: true`，`providers.refused` 与 `search.refused` 列在“不会恢复”中。同步不询问，外部引用照常带入，只有指向 HarnessHub 自己秘密的被跳过（决定）：同步文件是用同步口令加密的，只有本人加入同步的机器能写出能打开的内容；能写服务器目录而不知道口令的人只能把旧文件放回去，这由下文的防回滚拒绝。同步也没有人可以回答确认，若一律不带入外部引用，各机器用环境变量或文件保存的凭证就无法同步。这条规则与 [Library](library.md) 拒绝工具秘密引用的是同一条（[secret-refs.ts](../packages/daemon/src/secret-refs.ts)）。
- **订阅 provider**：从不写入、替换或删除。较早版本的备份中带有的订阅 provider 不恢复，列入 `signInAgain`（在这台电脑上重新登录：`hh subscription login chatgpt|copilot`）；备份中与本机订阅 provider 同 id 的 provider 不恢复，本机的登录保留，列入 `signedInHere`。演练（`dryRun`）的摘要与实际恢复的结果一致。
- **路由组**：同 id 替换，其余新增；成员指向的 provider 既不在备份中也不在本机时跳过并列入 `skipped`（只在备份中的订阅 provider 不算在内）。
- **网关功能**：出站脱敏的开关取备份的；规则按名称、搜索后端按种类与地址（`baseUrl`）替换或新增，本机另有的保留；备份有视觉兜底模型时取备份的，没有时保留本机的；用量提醒的阈值同样（摘要的 `alerts` 给出恢复后的阈值与是否改变，已提醒的记录 `usage-alerts.json` 不在备份中）。搜索后端的 Key 只接受密钥存储中的值：备份带值的写入密钥存储（与本机同一后端的值相同则沿用原引用）；备份把 Key 写成外部引用的后端不写入（构造的备份可借此把本机任意秘密发往它给出的搜索地址），列入 `search.refused` 并写明引用指向什么，本机同种类同地址的后端保持原样，同步时写进 `notice.refused`；备份不带值时沿用本机同一后端的 Key，本机没有时这个后端不写入（没有 Key 的后端无效），列入 `search.needKey`，用 `hh gateway search add` 重新添加。本机不再被引用的旧 Key 删除。摘要 `gatewayFeatures` 列出规则与后端的 added、replaced、needKey、refused；本机开着而备份关闭出站脱敏时 `redaction.turnsOff` 为 true，`hh restore` 在预览与结果中都以 `WARNING` 行提示。视觉兜底模型指向恢复后本机没有的 provider、路由组，或 provider 列出了模型而其中没有它时，仍然设置，摘要的 `vision.unresolved` 说明原因。较早版本的备份没有这一部分，摘要中为 null，本机的网关功能不变。
- **局域网共享**：与本机不同时经 `GatewayShare.update` 应用；地址不属于本机等原因失败时设置不变，错误写在摘要中。
- **目录设置**：来自配置文件，恢复只报告是否不同。
- **profile**：同名替换，其余新增；应用 profile 仍由用户执行（`hh profile apply`）。
- **Library**：`--no-library`（API 的 `library: false`）跳过；否则指令集、MCP 服务与 Skill 同 id 或同名替换，其余新增，保留原时间，不删除本机条目；本机保留的指令集让出被备份中指令集占用的 Agent（一个 Agent 只有一套）。每个条目按 Library API 的规则重新检查，不合格的或秘密引用 HarnessHub 自身凭据的（`SECRET_REF_FORBIDDEN`）不写入，列入 `library.refused`，本机同名条目保持不变。没有值的 `store` 秘密沿用本机同名服务的同名秘密，本机没有时去掉并列入 `needSecret`。Skill 携带的文件与本机同名 Skill 相同时保留本机版本（包括本机有而备份未带的大文件）；否则以携带的文件导入为新版本，缺了大文件的列入 `incomplete`。恢复不改 Agent 的文件，见上文的同步提示。
- **Agent**：`--no-agents` 跳过；否则对本机已安装（PATH 上有命令，或有配置目录）的 Agent，经 `AgentWiringService` 先预览再以该预览为 `expect` 接线：请求带 model、models、tiers 与 effort（备份中没有的 tiers 与 effort 被清除）以及 options，签发新的 `agent:` Key；之后隐藏的模型与备份不同则经 `setHidden` 设置（保留该 Key）。本机隐藏了备份选中的模型时，先取消隐藏再接线，否则接线会被拒绝。未安装、未知或本守护进程没有接线目录的 Agent 跳过；选择、models 与隐藏的模型都已相同的不动。一个 Agent 失败不影响其他。
- **client Key**：只列出，`hh key create` 重新签发；有限额的附上给出同样限额的 `--rpm` 与 `--budget` 选项。旧备份中的 `tokensPerDay` 与 `costPerMonthUsd` 按存储迁移 6 的方式转换为预算（值为 0 的上限保留，仍拒绝每次调用），转换后不是有效限额的备份以 `BACKUP_INVALID` 拒绝。

恢复与同步在同一队列中依次执行；模型平面 API 的写入可能落在两条记录之间，每条记录本身是原子的。

## 同步

同步默认关闭。设置保存在 `<dataDir>/sync/config.json`（0600），其中 WebDAV 密码或 S3 secret key 与口令只保存为密钥存储的引用。口令存入密钥存储，是为了让守护进程无人值守地同步；开启时会提示：能读取本账户秘密的人也能打开服务器上的副本。每台机器使用同一个口令。

服务器上的对象是 `<地址>/harnesshub/harnesshub.harnesshub-backup`（S3 为 `<prefix>/harnesshub/harnesshub.harnesshub-backup`），内容与备份文件格式相同，服务器只持有密文。守护进程运行期间，开启后约 20 秒同步一次，之后每 3 分钟一次，单次最长 2 分钟；服务器限流（429、503 或 S3 的 SlowDown）时按其 `Retry-After` 等待（介于 3 分钟与 6 小时之间），没有时等待时间翻倍，最长 30 分钟。`POST /api/v1/sync/now`（`hh sync now`）立即同步一次，失败时返回该错误。

**按部分三方合并**：设置分为 `providers`（provider、凭证、元数据来源、覆盖与路由组）、`agents`（接线意图）、`profiles`（接线 profile）、`library`（Library 的条目）与 `features`（网关功能）五部分。`<dataDir>/sync/state.json` 记录上次同步时两边各部分的 SHA-256 与服务器文件的版本（ETag）。读取先带 `If-None-Match`，服务器文件未变时不重新下载，与本地缓存的副本合并。

| 只有本机改了 | 只有服务器改了 | 两边都改了 |
|---|---|---|
| 用本机的 | 带入服务器的 | 保留最后修改的一边：本机该部分记录的最新 `updatedAt`（`agents` 为 `wiredAt`，`profiles` 为 profile 的 `updatedAt`，`library` 为条目的 `updatedAt`，`features` 为网关功能的 `updatedAt`）与服务器文件的生成时间比较；删除没有时间，因此只有删除时服务器一边胜出 |

两边都改时，被替换的一方完整保存到 `<dataDir>/sync/conflicts/<时间>-this-computer.harnesshub-backup`（本机的，加密）或 `…-server.harnesshub-backup`（服务器的），状态的 `notice` 写明哪部分被谁替换；它保留到某次同步产生新的提示为止，`hh sync status` 把它列在产生它的那次同步的时间之下（`Last notice, from the sync at …`），`hh sync now` 区分这次同步产生的（`This sync (…)`）与更早的。第一次加入时服务器的部分替换本机的；本机该部分为空时不算替换。带入 `providers` 是镜像：服务器上已没有的 provider 与路由组在本机删除，但仍被未吊销的 Gateway Key 允许（或被保留的路由组引用）的保留并列入 `notice.kept`。订阅 provider 不上传，也不因镜像被删除或替换；本机的登录改变不算作 `providers` 部分的改变。带入 `agents` 只对本机已安装的 Agent 接线，不撤销本机其他接线。带入 `profiles` 同样是镜像：服务器上已没有的 profile 在本机删除；来自加入 profile 之前的 HarnessHub 的文件没有这一部分，本机的 profile 随之上传。带入 `library` 也是镜像，条目按恢复的规则检查（被拒的条目本机保持原样并记入日志 `sync.library_refused`）；比较时不计未携带的大文件名，因此只缺大文件的 Skill 不会来回同步，本机有完整版本的保留本机版本。开启了 Agent 接线同步（`agents=yes`）时，带入后再把 Library 同步到本机已安装的 Agent（不写秘密值；失败时条目已带入、Agent 文件不变，记入日志 `sync.library_agents_failed`）；来自加入 Library 之前的 HarnessHub 的文件没有这一部分，本机的随之上传。带入 `features` 同样是镜像：出站脱敏的开关、规则、视觉兜底模型、搜索后端与用量提醒的阈值都按服务器的，服务器上已没有的后端在本机删除、它的 Key 从密钥存储删除；服务器的后端没有带 Key 值时沿用本机同一后端的 Key，本机也没有时不带入，列入状态的 `notice.needKey`（此后本机这一部分与服务器不同，直到用 `hh gateway search add` 补上 Key）。来自加入网关功能之前的 HarnessHub 的文件没有这一部分，本机的随之上传。发送方未带 Key 时，合并保留服务器已有的凭证值，本机写入时保留本机凭证。

**出站脱敏的关闭随同步传播**（决定）：`features` 的开关与其余设置一样同步；一台机器关闭出站脱敏，其他机器带入后也关闭。这是安全设置，因此带入后关闭了本机开着的脱敏时，状态的 `notice.redactionOff` 为 true，日志记 `sync.redaction_off`，`hh sync status` 以 `WARNING` 行提示，直到下一次有新的提示；恢复备份时摘要的 `redaction.turnsOff` 同样提示。考虑过不同步这个开关（只同步规则、模型与后端）：各机器会在同步“成功”的同时悄悄保持不同的开关，而用户在一台机器上关闭脱敏通常是有意的（例如规则误伤），同步本来就是让各机器一致；也考虑过只同步“开启”，这会让关闭在其他机器上悄悄失效，同样令人意外。代价是一台机器上的误操作会传到其他机器，由上述提示让用户发现。2026-10-05 起（第二轮安全审查 L9）只有服务器的网关功能比本机的严格更新（服务器部分的 `updatedAt` 晚于本机的，或本机从未改过）时才关闭本机的脱敏；否则（两边都改过而服务器一边在合并中胜出、但它的设置更早）本机的脱敏保持开启，其余设置照常带入，状态的 `notice.redactionOffHeld` 为 true、日志记 `sync.redaction_off_held`，`hh sync status` 提示用户若确实要关闭就在本机运行 `hh gateway redaction off`。服务器的这一部分内容不变时不再重新判断。

**防回滚**（2026-10-05，第二轮安全审查 L8）：能写服务器目录而不知道口令的人仍可以把一份旧的同步文件放回原处，它能用口令打开，合并时会把各台机器带回旧设置。因此同步文件中带 `generation`：每次写回为读到的文件与本机见过的最高值之中较大者加一，它在加密内容之内，不知道口令就无法改动。`state.json` 记录本机读过或写过的最高 `generation`（以及没有 `generation` 的旧版本文件的最新生成时间）；读到更旧的文件时拒绝同步，错误为 409 `SYNC_ROLLBACK`，`hh sync status` 的最近错误说明原因；状态的 `lastErrorCode` 给出最近一次失败的问题代码（后台同步失败时也有），客户端据此提供接受的操作，而不必匹配错误文字。确认服务器上的文件确实要用时运行 `hh sync now --accept-older`（`POST /api/v1/sync/now` 的 `acceptOlder: true`；控制台在“立即同步”遇到 `SYNC_ROLLBACK` 时提供“接受较旧的文件”，先确认风险），本机接受它、照常合并，并写回一个比两者都新的文件，其他机器因此也不会拒绝。改变同步目标或口令时 `state.json` 重新开始。

**只覆盖读到的版本**：写回时带条件——WebDAV 为 `If-Match: <ETag>`，首次写入为 `If-None-Match: *`；S3 相同。被拒（412，或 S3 的 409 `ConditionalRequestConflict`）说明另一台机器刚写过：重新读取对方的版本、再合并一次并重试一次，仍被抢先则报 `SYNC_CONFLICT`，下次同步再试。不支持条件写的 S3 服务（以 501 或提到条件头的 400 回应）改为写前用 HEAD 比较 ETag；若响应带 `x-amz-version-id`（桶开启了版本），写后再列出对象版本，确认紧挨在本次写入之前的版本就是读到的那个，否则读入中间那个版本并合并重试。既不支持条件写也未开启版本的服务器，在 HEAD 与 PUT 之间的写入无法发现。WebDAV 写入后用 HEAD 比较长度，被中转截断的写入以截断后的版本为条件最多重写到三次。

**S3 签名**：AWS Signature Version 4 在 `packages/daemon/src/sync-remote.ts` 中用 `node:crypto` 手写（约 60 行），以 AWS 公布的签名示例（SigV4 测试套件与 S3 文档）验证；不为同步的五种请求引入 AWS SDK 或其他依赖，因此没有新的许可证与安装体积。WebDAV 只用 `fetch`。

不同步的内容：局域网共享与目录设置（与本机地址相关，自动同步可能在另一台机器上意外开放局域网）、`config.jsonc` 中的启动设置（包括出站代理）、client Key、用量。`hh sync off` 删除设置、状态、服务器副本缓存与两项秘密，保留冲突副本与服务器上的文件。

## API 与 SDK

| 接口 | SDK | 说明 |
|---|---|---|
| `POST /api/v1/backup` | `client.backup.create({passphrase, keys?})` | 返回信封 JSON，即文件内容 |
| `POST /api/v1/restore` | `client.backup.restore({backup, passphrase, agents?, library?, references?, dryRun?})` | 摘要或恢复结果（`library` 为带入 Library 的情况，没有或跳过时为 null）；请求体上限 64 MiB |
| `GET`、`PUT`、`DELETE /api/v1/sync` | `client.sync.status()`、`configure(settings)`、`disable()` | 状态不含秘密；`configure` 不同步 |
| `POST /api/v1/sync/now` | `client.sync.now({acceptOlder?})` | 同步一次；服务器文件比本机同步过的旧时 409 `SYNC_ROLLBACK`，除非 `acceptOlder` |

逐接口的错误码见 [API 实现参考](api/reference.md)。口令与秘密只在请求体中出现，守护进程不记录请求体。

## 与 Magpie 的差异

- 不含 provider 图标与 provider 排序（HarnessHub 尚无这些数据）。网关功能（搜索后端、出站脱敏与视觉兜底模型）在备份与同步中，对应 Magpie 备份中的搜索 API 与相应设置。profiles、`library`、`gatewayFeatures` 与接线选择的新字段是内容版本 1 中的可选成员：没有 `profiles`、`library` 或 `gatewayFeatures` 的备份不恢复它们，旧版本 HarnessHub 打开新备份时忽略它们。
- Library 的 MCP 秘密在备份中只有引用或密钥存储中的值；Magpie 以明文保存 MCP 的 env 与 headers，不带 Key 时只清空名称像密钥的值。Magpie 恢复 Library 时整体替换本机的；HarnessHub 的恢复逐条替换与新增，只有同步镜像删除。
- 网关 Key 从不进入备份；Magpie 带 Key 时导出其网关 Key。
- 同步有 `providers`、`agents`、`profiles`、`library` 与 `features` 五部分；局域网与目录设置不同步；不共享用量。
- 同一数据目录只有一个守护进程（存储的所有者锁），同步只在进程内串行，不需要 Magpie 的跨进程文件锁。
- 状态中的部分摘要是普通 SHA-256；用口令做 HMAC 会让摘要成为绕过 PBKDF2 的口令猜测捷径。

## 验证

- [backup-envelope.test.ts](../packages/daemon/test/backup-envelope.test.ts)：600,000 次迭代的往返、错误口令、密文/nonce/盐/迭代次数任一被改即无法打开、非备份与更新版本在解密前被拒。
- [sync-remote.test.ts](../packages/daemon/test/sync-remote.test.ts)：SigV4 对 AWS 公布的 7 个签名示例逐字一致；WebDAV 的地址、建目录、`If-None-Match: *`/`If-Match`、截断重写、限流与登录失败；S3 的虚拟主机式与路径式地址和 R2 区域。
- [sync-loop.test.ts](../packages/daemon/test/sync-loop.test.ts)：关闭时不调度；开启后首延迟、成功后 3 分钟、按 `Retry-After` 与翻倍退避、关闭后停止。
- [backup-restore.test.ts](../tests/integration/backup-restore.test.ts)：经 `startHub` 与文件秘密后端：备份内容逐项核对，`--no-keys` 的明文中没有合成 Key 与密钥请求头；同 id 替换、其余新增、`dryRun` 不写入；覆盖、路由组、外部引用；恢复的凭证经网关到达严格假上游；在临时 home 中以新 Key 重新接线 Codex；不带 Key 时保留本机 Key 并列出 `needKey`、未安装的 Agent 被跳过；Claude 的 tiers、effort 与隐藏模型经预览与接线恢复（本机隐藏了选中模型时先取消隐藏），profile 同名替换、本机其余保留，再次恢复时一切不变；真实 `hh backup|restore` 从 stdin 读口令、确认与错误口令的退出码，输出中没有 Key 与口令。
- [backup-library.test.ts](../tests/integration/backup-library.test.ts)：备份中的 Library（正文、引用、只在带 Key 时的值、Skill 文件与超过 2 MiB 未带的文件）；恢复的预览与写入一致，同 id 替换、本机的 `store` 秘密沿用、`needSecret`、引用本机 provider 凭据变量的服务以 `SECRET_REF_FORBIDDEN` 拒绝、缺大文件的 Skill 列为 `incomplete`、再次恢复时保留本机版本、`library: false`；恢复后的 Library 同步写入 Claude Code；真实 `hh restore` 的 `--no-library` 与恢复后的同步；两台守护进程经假 WebDAV 同步 Library，带入后写入另一台的 Claude Code，删除随之镜像，保留完整的 Skill 版本。[library-backup.test.ts](../packages/daemon/test/library-backup.test.ts) 与 [library-store.test.ts](../packages/agents/test/library-store.test.ts)：携带格式的无效样例、比较视图与秘密值的保留、以文件导入 Skill 的路径检查、按时间恢复与镜像。
- [secret-refs.test.ts](../tests/integration/secret-refs.test.ts)：同一组引用（`HH_`、小写 `hh_`、`HARNESSHUB_` 变量，管理令牌、数据目录本身、经 `..` 与链接指进数据目录的路径、`secrets.key`，以及用户自己的变量与文件）分别经规则本身、Library 工具的秘密引用（`SECRET_REF_FORBIDDEN` 与原因）和恢复备份的预览（`providers.refused` 与原因，或 `providers.references`）检查，三处结果一致；让 Library 不用这条规则时测试失败。
- [backup-sync-security.test.ts](../tests/integration/backup-sync-security.test.ts)（第二轮安全审查 G 组，各项在修复前失败）：经 `startHub`、真实 `hh` 与假 WebDAV：会灾难性回溯的脱敏规则与带凭据的搜索地址在接口、`hh`、恢复中都被拒绝；构造的备份把搜索 Key 写成指向管理令牌或环境变量的引用时不恢复并说明，把 provider 凭证指向数据目录、配置目录中的文件或 `HARNESSHUB_` 变量时永不恢复，其他外部引用在预览中列出 Key 的去向，不确认时接口 409、`hh restore --yes` 以 4 退出，`--allow-references` 后恢复，再次恢复同样的引用不需确认；放回服务器的旧同步文件被两台机器拒绝，`hh sync now --accept-older` 后接受并写回更新的文件；较旧的网关功能不关闭本机的脱敏并提示，更新的照常关闭。
- [backup-features.test.ts](../tests/integration/backup-features.test.ts)：经 `startHub`：备份中的网关功能（带 Key 时搜索 Key 的值、`--no-keys` 时没有值）；在新数据目录上恢复的预览与写入一致、出站脱敏被关闭的提示（API 与真实 `hh restore` 的 `WARNING` 行）、Key 写入新机器的密钥存储、再次恢复不变；不带 Key 时没有本机 Key 的后端列入 `needKey` 不写入，本机有同一后端时沿用本机 Key、本机其余后端保留；视觉兜底模型的 provider 不在时仍设置并说明；没有这一部分的旧备份不改变本机网关功能；两台守护进程经假 WebDAV 同步：加入时带入网关功能与 Key、`notice.redactionOff` 与 `hh sync status` 的提示、删除镜像并删除对方的 Key、两边都改时保留后改的一边并保存副本、服务器只持有密文。
- [sync.test.ts](../tests/integration/sync.test.ts)：两台（或三台）守护进程经回环上的假 WebDAV、假 S3（逐个请求按收到的字节验证 SigV4）同步：首次推送只含密文、加入时带入、一台写入被另一台抢先（412）后读入、合并 `providers` 与 `agents` 并重试；profile 作为单独一部分同步，删除随之镜像；不支持条件写且开启版本的 S3 发现中间写入；两边都改时保留后改的一边并保存副本；镜像删除；错误口令；关闭、无效设置与不带 Key 的上传；真实 `hh sync` 从 stdin 读密码与口令。
