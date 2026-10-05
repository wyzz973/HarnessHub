# 凭据

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 经守护进程的集成测试（严格假上游）覆盖添加、轮换、删除、开关、按凭据的模型列表与 provider 的并发上限，并检查凭据值不出现在响应、日志与数据目录文件中；秘密存储的单元测试在临时目录中验证加密文件后端，原生后端用替身，不访问真实钥匙串；真实 DeepSeek Key 经 `--credential-from-stdin` 存入文件后端验证过一次；Windows（DPAPI）未验证 |
| 对照 Magpie | 相同：每个 provider 多把 Key、各自开关、可限定协议、最后一把不能关；部分：每把 Key 自己的模型列表、凭据状态与解除休息；有意不同：并发上限的排队有上限并会转移（[Providers, presets and import](../../magpie-parity.md#providers-presets-and-import)、[Routing](../../magpie-parity.md#routing-route-groups-and-rules)） |
| 权威文档 | [模型平面 API 的资源表](../../model-plane-api.md#资源)（credentials 行）、[模型解析与列表](../../model-gateway.md#模型解析与列表)、[资源上限](../../model-gateway.md#资源上限)、[secrets 包说明](../../../packages/secrets/README.md) |

## 用途

一个 provider 可以挂多把 Key，网关把每个凭据当作独立的路由候选与熔断单位：一把 Key 被限流或额度用完时转到下一把。秘密值只进入秘密存储，provider 配置、备份与日志里只有引用；被风控限制并发的账号可以单独设上限。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Provider › 详情 › 凭据：添加凭据（名称、Key，可限定协议）、轮换、删除、每行的启用开关、“路由状态”列；编辑对话框的“每个凭据的并发” |
| 命令行 | `hh credential list <provider>`；`hh credential add <provider> [--name N] [--id ID] [--protocol P]…`；`hh credential rotate`、`disable`、`enable`、`remove <provider> <credential>`；秘密来自隐藏输入、`--from-stdin`、`--from-env VAR` 或 `--from-file PATH`；`hh provider limits <id> [--concurrency N] [--queue N] [--clear]` |
| HTTP | `GET`、`POST /api/v1/providers/{id}/credentials`；`PATCH`、`DELETE /api/v1/providers/{id}/credentials/{credentialId}`；`PUT …/{credentialId}/secret`；`PATCH /api/v1/providers/{id}` 的 `limits`；`GET /api/v1/routing/state` |

## 已实现的能力

- 每个 provider 可有多个凭据，ID 缺省为 `key-N`；每个启用的凭据是一个路由候选，休息、半开探测与熔断都按凭据计（[路由、重试与熔断](../../model-gateway.md#路由重试与熔断)）。
- `protocols` 把凭据限定在 provider 的某几个端点上；限定了协议的凭据按与请求模型的相配程度排序（Magpie `keyFit`：Claude 模型配 Anthropic 协议，GPT 模型配其他协议）。
- 开关：关闭的凭据不被路由；provider 最后一个启用的凭据不能关闭（409 `CREDENTIAL_LAST_ENABLED`，控制台提示改为停用 provider）；重新打开时清除该凭据的休息与模型标记，下一次请求立即再试，额度读数保留。
- 托管秘密：经 API、CLI 或控制台给出的值存为 `{kind: "store", value: <UUID>}` 引用，响应只回引用；后端由 `hh serve --secrets-backend auto|keychain|dpapi|file` 选择，`auto` 在 macOS 用钥匙串、Windows 用 DPAPI、其他平台用 AES-256-GCM 加密文件（主密钥在配置目录的 `secrets.key`）。
- 外部引用：API 新建凭据时也接受 `env`（变量名，读守护进程启动时的环境快照）与 `file`（绝对路径）引用；provider 记录的格式另允许 `keychain` 引用。网关每次上游尝试解析一次引用，不缓存；解析失败的凭据记为 `credential_unavailable` 并转移。
- 轮换：`PUT …/secret` 或 `hh credential rotate` 在同一 `store` 引用下替换值，引用不变；`env` 与 `file` 引用不能在这里轮换（409 `CREDENTIAL_NOT_MANAGED`）。
- 删除：先删托管秘密再从 provider 移除，失败后重试同一请求即可完成；删除 provider 时同时删除它的托管秘密；新建时 provider 写入失败会删掉刚写入的秘密。
- 秘密从不作为命令行参数：非交互时必须用 `--from-stdin`、`--from-env` 或 `--from-file`，否则以 2 退出；值不出现在响应、日志与错误信息中。
- 并发与排队：每个凭据默认同时 8 个上游请求、排队 64 个；provider 的 `limits` 可另设（并发 1–1024、排队 0–65536），修改对下一个请求生效，调高时排队的请求随即发出。空出的并发位先给占用最少的 Gateway Key；排满或排队超过 60 秒（`slotWaitMs`）为 429 `busy` 并转移到其他候选。
- 每个凭据自己的模型列表：多凭据时刷新按凭据分别读取，路由跳过自己列表里没有所请求模型的凭据（见 [模型列表与元数据](model-catalog.md)）。
- 钉选：请求头 `X-HH-Credential` 按 ID 或名称把一次调用钉在一个凭据上，休息中为 429、不能服务为 400、不在候选中为 404，该头不发往上游（[模型解析与列表](../../model-gateway.md#模型解析与列表)）。
- 路由状态：`GET /api/v1/routing/state` 与控制台凭据表给出每个凭据是否休息、到期时间、最近一次失败的类别与状态码、额度读数，以及它自己的列表没有的模型（`unlistedModels`）。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | 凭据路由 [model-plane-routes.ts](../../../packages/daemon/src/http/model-plane-routes.ts)、托管秘密 [secret-store.ts](../../../packages/secrets/src/secret-store.ts)、外部引用 [secrets.ts](../../../packages/secrets/src/secrets.ts)、候选与 `keyFit` [routing.ts](../../../packages/gateway/src/routing.ts)、并发位 [http.ts](../../../packages/gateway/src/http.ts) 的 `Slots`、上限 [limits.ts](../../../packages/gateway/src/limits.ts)、CLI [admin.ts](../../../packages/cli/src/admin.ts)、控制台 [providers-page.tsx](../../../packages/console/components/providers-page.tsx) |
| 测试 | [api-v1.test.ts](../../../tests/integration/api-v1.test.ts)、[switches.test.ts](../../../tests/integration/switches.test.ts)、[credential-models.test.ts](../../../tests/integration/credential-models.test.ts)、[concurrency-stand-in.test.ts](../../../tests/integration/concurrency-stand-in.test.ts)、[secret-refs.test.ts](../../../tests/integration/secret-refs.test.ts)、[hh-cli.test.ts](../../../tests/integration/hh-cli.test.ts)、[slots.test.ts](../../../packages/gateway/test/slots.test.ts)、[secret-store.test.ts](../../../packages/secrets/test/secret-store.test.ts) |
| 决策 | [ADR 0018 编号迁移、模型平面存储与托管秘密](../../decisions/0018-schema-migrations-and-managed-secrets.md)、[ADR 0008 Windows 系统密钥存储](../../decisions/0008-windows-secret-storage.md)、[ADR 0025 对齐 Magpie 的路由](../../decisions/0025-magpie-routing-parity.md) |

## 已知限制与未验证

- 控制台与 `hh credential` 只保存值：`--from-env VAR` 读取命令行所在环境中的值存为托管秘密，不创建 `env` 引用；`env` 与 `file` 引用只能经 API 或从 Codex 导入（`env_key`）创建（阅读 [admin.ts](../../../packages/cli/src/admin.ts) 与控制台代码的观察）。
- `env` 引用读的是守护进程启动时的环境，变量改变后要重启守护进程。
- 重新打开的凭据不会立即重读自己的模型列表，下次刷新之前被视为能服务所有模型。
- 没有按凭据手工收窄模型（Magpie `accountModels`）；订阅账号只读一个列表。
- 休息只能靠关闭再打开凭据或 provider 解除；没有接口显示每个凭据在途的请求数（Magpie `GET /v1/magpie/concurrency`）。
- Linux 没有 Secret Service 后端（默认加密文件）；Windows 上未校验加密文件后端的 DACL；Windows 未验证。

## 优化候选

- **现状**：CLI 与控制台不能创建 `env`、`file` 引用。**方向**：为 `hh credential add` 与控制台加“引用环境变量或文件”的选项。**依据**：阅读代码的观察；[模型平面 API](../../model-plane-api.md#资源) 已支持这两种引用。
- **现状**：重新打开的凭据要等下次刷新才读自己的模型列表。**方向**：打开时立即读该凭据的列表。**依据**：[TODO.md](../../../TODO.md) 的“开关：凭据、provider 与 Gateway Key”条目的“未覆盖”；[对照表](../../magpie-parity.md#providers-presets-and-import) 的多 Key 行。
- **现状**：不能按凭据手工限定模型。**方向**：在凭据上记录手工模型列表，路由与刷新结果合并。**依据**：TODO 的“每个 Credential 自己的模型列表与协议相配”条目的“未覆盖”；对照表的 model list per key 行（partial）。
- **现状**：看不到每个凭据的在途与排队请求，解除休息只能关再开。**方向**：在 `/api/v1/routing/state` 中加在途数，并提供单独解除休息的操作。**依据**：[对照表](../../magpie-parity.md#routing-route-groups-and-rules) 的并发上限行与凭据状态行（partial）。
- **现状**：Linux 只有加密文件后端。**方向**：接入 Secret Service。**依据**：[secrets 包说明](../../../packages/secrets/README.md)（“Linux Secret Service 尚未实现”）。
