# 模型平面 API 与 CLI

守护进程在 `/api/v1` 下提供模型平面的管理接口：provider 与凭据、模型元数据与覆盖、路由组、`client:` Gateway Key、`model.call` 账本与用量（设计见 [06 接口与交互面](proposals/oss/06-interfaces.md) 与 [03 模型平面](proposals/oss/03-model-plane.md)）。[`@harnesshub/sdk`](../packages/sdk/README.md) 是它的类型化客户端，`hh provider|credential|model|catalog|key|group|usage|status` 经 SDK 调用它。现有的 `/v1/*` 管理路由暂时保持原样，之后再迁到 `/api/v1`；模型网关的挂载与全局接线路由在网关与接线库落地后加入。逐接口的输入、返回与错误见 [API 实现参考](api/reference.md)（`/api/v1` 各节）。

## 认证与错误

- 守护进程启动时在数据目录中创建 `admin.token`（256 位随机数的 base64url，0600；已存在则校验后沿用），内存中只保留其 SHA-256。`/api/v1` 的每个请求都必须带 `Authorization: Bearer <令牌>`，而且来自回环连接；服务器原有的 Host、Origin 与 `Sec-Fetch-Site` 校验照常执行在前。令牌文件可被其他用户读取、是链接或内容无效时启动失败（`ADMIN_TOKEN_INSECURE`），删除后重启会生成新令牌。令牌不经命令行参数或环境变量传递。
- 改变状态的请求（POST、PUT、PATCH）必须是 `application/json`（PATCH 也接受 `application/merge-patch+json`），否则 415。请求中的未知字段返回 400。
- 错误一律是 RFC 9457 `application/problem+json`：`type`、`title`、`status`、`detail`、`instance`、`code`、`requestId`，输入错误另有 `errors[]`（`pointer` 指向请求体成员，或 `parameter` 指向查询参数），被引用而不能删除时另有 `references[]`。
- 金额是十进制字符串 `{amount, currency: "USD"}`；时间是 RFC 3339。

尚未实现：ETag 与 `If-Match`、`Idempotency-Key`、控制台会话，以及配置列表的分页（provider、凭据、路由组与 Key 的列表一次返回全部，`nextCursor` 为 `null`）。

## 资源

| 资源 | 操作 | 要点 |
|---|---|---|
| presets | `GET /presets` | 内置的 provider 预设（[presets](../packages/gateway/presets/README.md)）：端点、Key 的发送方式、获取 Key 的页面与核对日期 `verified` |
| providers | `GET`、`POST /providers`；`GET`、`PATCH`、`DELETE /providers/{id}`；`POST /providers/{id}/models/refresh` | `POST` 可以只给 `preset`（可加 `id`、`name`、按协议覆盖的 `endpoints` 与第一个 `credential`）。刷新用第一个启用的凭据从上游列出模型（chat 基址 + `/models`、anthropic 基址 + `/v1/models`、gemini 基址 + `/v1beta/models`），按[模型元数据](#模型元数据)补齐每个模型的窗口与价格，手工填写的值保留；失败时保留原列表并标记 `stale`，错误只含主机与 HTTP 状态。端点是厂商官方 SDK 的基址：chat 与 responses 含 `/v1`，anthropic 与 gemini 不含版本段；以操作路径或版本段结尾、内嵌凭据、带查询串或片段、公网 HTTP 的基址被拒绝，`errors[]` 指向 `/endpoints/<协议>`。`PATCH` 是 JSON Merge Patch。被路由组或未吊销的 Key 引用时删除返回 409 |
| credentials | `GET`、`POST /providers/{id}/credentials`；`PUT .../{credentialId}/secret`；`DELETE .../{credentialId}` | `value` 存入秘密后端，响应只含 `{kind:"store", value:<UUID>}` 引用；也可以给 `env` 或 `file` 引用。轮换保持引用不变；删除凭据或 provider 时同时删除托管秘密。06 第 3 节的 `/credentials` 顶层资源改为挂在 provider 下 |
| models | `GET /providers/{id}/models`；`GET /models/{ref}`；`GET`、`PUT`、`DELETE /models/{ref}/overrides` | 见[模型元数据](#模型元数据)。`{ref}` 中的斜杠编码为 `%2F`（模型名本身可含斜杠）；覆盖的 `{ref}` 也可以是 `provider/*` |
| catalog | `GET /catalog` | 内置 models.dev 快照的来源、取得时间、上游提交与 SHA-256、provider 与模型数；`autoRefresh` 为 `false` |
| route-groups | `GET`、`POST /route-groups`；`GET`、`PATCH`、`DELETE /route-groups/{id}` | 成员必须是已存在 provider 的 Model Ref；被未吊销的 Key 允许时删除返回 409 |
| gateway-keys | `GET`、`POST /gateway-keys`；`GET /gateway-keys/{id}`；`POST /gateway-keys/{id}/revoke` | 只签发 `client:` 作用域，`modelAllow` 必填；默认 90 天后过期，`expiresAt: null` 不过期。Key 文本只出现在创建响应中，列表与详情不含哈希 |
| model-calls | `GET /model-calls` | 新到旧，`limit` 1–200（默认 50），`cursor` 为上一页的 `nextCursor`；按 `from`（含）、`to`（不含）、`keyId`、`provider`、`model`、`sessionId` 过滤 |
| usage | `GET /usage` | `groupBy` 为 `day`（UTC）、`provider`、`model`（默认）、`key` 或 `adapter`；状态码不低于 400 记为失败，成本只累加已知价格，未知价格计入 `unpricedCalls`，`missing` 用量按 0 计 |
| system | `GET /system/info` | 版本、提交、pid、启动时间、数据目录、秘密后端，以及 `gateway`：本机客户端使用的模型网关基址（`openaiBaseUrl` 含 `/v1`，`anthropicBaseUrl` 与 `geminiBaseUrl` 不含版本段） |

秘密后端由 `hh serve --secrets-backend auto|keychain|dpapi|file` 选择（默认 `auto`：macOS 钥匙串、Windows DPAPI、其他平台加密文件），加密文件后端的主密钥在 `--config-dir`（默认为平台的 HarnessHub 配置目录）下的 `secrets.key`，见 [secrets](../packages/secrets/README.md)。

## 模型元数据

每个模型的上下文窗口、最大输出、是否推理、输入模态、是否支持工具调用与价格（输入、输出、缓存读、缓存写，美元每百万 token）逐字段按以下顺序取第一个已知的值（[03 第 7 节](proposals/oss/03-model-plane.md#7-模型目录与元数据)）：

| 优先级 | 来源（`source`） | 时间（`at`） |
|---|---|---|
| 1 | 该模型的覆盖（`override`） | 覆盖的保存时间 |
| 2 | `provider/*` 覆盖（`override-provider`） | 同上 |
| 3 | provider 配置中手工填写的值（`provider`） | provider 的 `updatedAt` |
| 4 | 上游模型列表（`live`），如 Gemini 的 `inputTokenLimit` | 刷新时间 |
| 5 | provider 预设（`preset`） | 预设的 `verified` 日期 |
| 6 | 内置 [models.dev 快照](../packages/gateway/catalog/README.md)（`catalog`），先按预设的 `catalog` id，再按 `author/model` 中的作者 | 快照的取得时间 |

都没有时字段为未知（`unknown`），不按名称猜测，也不回落到任何默认窗口。

- 创建 provider、`PATCH`、刷新模型列表与修改覆盖时，守护进程把解析结果写入 provider 的每个 `models.list` 项，网关按这些值计算成本（`priceSource: "provider"`）并在 `/v1/models` 中列出窗口与输出上限；同一事务内在 `model_provenance` 表中记录每个推导值的来源、时间与写入的值。
- 手工填写：存储的值与记录的推导值不同，就视为用户在 provider 配置中填写的值，之后的写入不覆盖它；把读到的列表原样写回（如控制台编辑）不会把推导值变成手工值。覆盖会替换手工值，删除覆盖后手工值恢复。本功能之前创建的 provider 没有来源记录，其中已有的值都按手工值保留。
- 覆盖存放在 `model_overrides` 表中，`PUT` 整体替换该 ref 的覆盖，删除 provider 时一并删除。`GET /models/{ref}` 返回 `fields`（每个已知字段的 `value`、`source`、`at`）、`unknown`、`listed`（provider 列表中是否有该模型）与适用的 `overrides`；不在列表中的模型同样可以覆盖与查询。
- 运行时不联网。快照随发行附带 models.dev 的 MIT 许可文本，由 `tools/catalog-snapshot.mjs` 重新生成。03 第 7 节中经用户同意的后台刷新、`hh catalog refresh`、推理档位、结构化输出、按上下文分档的价格与“输出上限小于窗口”的统一校验尚未实现。

## CLI

命令经 `--url`（默认 `http://127.0.0.1:3180`）连接守护进程，从 `--data-dir`（默认 `./data`，与 `hh serve` 相同）读取 `admin.token`。默认输出表格，`--json` 输出与 API 响应相同的 JSON；失败时 `--json` 把 problem 对象写到 stdout，并在 stderr 写一行说明。

```sh
hh status
hh provider presets
printf '%s' "$KEY" | hh provider add --preset deepseek --credential-from-stdin
hh provider models deepseek --refresh
hh provider add local-llm --chat http://127.0.0.1:8000/v1 --model my-model
hh credential add deepseek --name main          # 在终端中隐藏输入
printf '%s' "$KEY" | hh credential add deepseek --from-stdin
hh credential rotate deepseek key-1 --from-env NEW_KEY
hh model show deepseek/deepseek-chat         # 每个值的来源与时间
hh model set deepseek/deepseek-chat context=65536 price.input=0.27 price.output=1.1
hh model set 'deepseek/*' output=8192        # 该 provider 的全部模型
hh model set deepseek/deepseek-chat price.output=   # 删除覆盖中的一项
hh model unset deepseek/deepseek-chat
hh catalog status
hh group add fast --member deepseek/deepseek-chat --strategy latency
hh key create --name ci --allow deepseek/* --allow group/fast   # Key 只打印这一次
hh usage --by provider --since 7d
hh key revoke <keyId> --yes
```

- `hh model set` 的键：`context`、`output`（token 数）、`reasoning`、`toolcall`（yes 或 no）、`modalities`（逗号分隔的 text、image、pdf、audio、video）、`price.input`、`price.output`、`price.cacheRead`、`price.cacheWrite`（美元每百万 token）。新值与已有覆盖合并，`键=` 删除一项，全部删除后覆盖被移除。
- 秘密从不作为参数：终端中隐藏输入，非交互时必须用 `--from-stdin`、`--from-env <变量>` 或 `--from-file <路径>`，否则以 2 退出。
- `provider remove`、`credential remove`、`group remove` 与 `key revoke` 需要确认；`--yes` 跳过，非交互且没有 `--yes` 时以 4 退出且不做修改。stdin 不是终端、设置了 `CI` 或给出 `--non-interactive` 时为非交互。
- 退出码（06 第 5 节）：0 成功；1 内部错误；2 用法错误、输入无效或名称不存在；3 守护进程不可达或数据目录中没有令牌；4 需要确认；5 冲突（409、412、422）；6 认证失败；7 达到上限或未就绪（429、503）；130 中断。

控制台的 Provider、路由组、Gateway Key 与用量页面经同源代理调用这些接口；代理在服务端从 `HARNESSHUB_DATA_DIR/admin.token` 读取令牌，浏览器拿不到它（见 [控制台](../packages/console/README.md)）。

测试：[api-v1.test.ts](../tests/integration/api-v1.test.ts) 在进程内启动守护进程，经 SDK 验证认证、校验、凭据值不出现在任何响应、日志与数据目录文件中、Key 的签发与吊销、基于写入账本的用量；[hh-cli.test.ts](../tests/integration/hh-cli.test.ts) 对同一守护进程运行真实的 `hh` 入口；[model-metadata.test.ts](../tests/integration/model-metadata.test.ts) 经 SDK 验证预设与快照补齐、覆盖与手工值的优先级、重启后覆盖仍在，以及网关按补齐的价格计算成本，[单元测试](../tests/unit/model-metadata.test.ts) 覆盖解析顺序与来源记录。
