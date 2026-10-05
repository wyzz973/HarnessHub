# 模型平面 API 与 CLI

守护进程在 `/api/v1` 下提供模型平面的管理接口：provider 与凭据、模型元数据与覆盖、路由组与自动路由组、`client:` Gateway Key、`model.call` 账本、用量与会话视图（设计见 [06 接口与交互面](proposals/oss/06-interfaces.md) 与 [03 模型平面](proposals/oss/03-model-plane.md)）。[`@harnesshub/sdk`](../packages/sdk/README.md) 是它的类型化客户端，`hh provider|credential|model|catalog|key|group|usage|status|gateway|import` 经 SDK 调用它。现有的 `/v1/*` 管理路由暂时保持原样，之后再迁到 `/api/v1`；全局接线（`/agents`，`hh agents|wire|use|unwire`）见 [全局接线](global-wiring.md)。逐接口的输入、返回与错误见 [API 实现参考](api/reference.md)（`/api/v1` 各节）。

## 认证与错误

- 守护进程启动时在数据目录中创建 `admin.token`（256 位随机数的 base64url，0600；已存在则校验后沿用），内存中只保留其 SHA-256。`/api/v1` 的每个请求都必须来自回环连接，并带下面两种凭据之一；服务器原有的 Host 与 Origin 校验照常执行在前，`Sec-Fetch-Site` 存在时必须是 `same-origin`（否则 403 `LOCAL_ACCESS_REQUIRED`）。令牌文件可被其他用户读取、是链接或内容无效时启动失败（`ADMIN_TOKEN_INSECURE`），删除后重启会生成新令牌。令牌不经命令行参数或环境变量传递。
  - 本机管理令牌：`Authorization: Bearer <令牌>`，供 CLI 与 SDK 使用；带了这个头就只按令牌判断（错误为 401 `ADMIN_TOKEN_INVALID`）。
  - 控制台会话（[07 第 5.2 节](proposals/oss/07-data-security.md#52-本机管理令牌与控制台会话)，[ADR 0024](decisions/0024-embedded-console.md)）：`hh console` 用令牌调用 `POST /auth/console-links` 取得 60 秒内可用一次的登录码并打印 `http://127.0.0.1:3180/#login=<code>`；页面立即从地址栏清除登录码，再以 `POST /auth/console-sessions` 换取会话：浏览器的 `hh_console` Cookie（`HttpOnly; SameSite=Strict; Path=/`，有效期 7 天、空闲 12 小时；同一浏览器的多个会话共用）与这个标签页的会话令牌（`csrfToken`，只在这里返回一次）。之后的每个请求（GET 与 HEAD 也一样）都要同时带 Cookie 与 `X-HH-CSRF: <令牌>`；只有其中一个、两者不属于同一会话或会话已结束都是 401 `CONSOLE_SESSION_INVALID`，因此收到 Cookie 的其他本地端口无法使用它（[ADR 0024 补充](decisions/0024-embedded-console.md#补充会话分为浏览器-cookie-与标签页令牌2026-10-05安全审查-m3)）。重新加载的标签页用 `GET /auth/console-sessions/current` 确认保存的令牌（不返回令牌），`DELETE /auth/console-sessions/current` 退出本标签页。每个标签页分别登录；会话只在内存中，守护进程重启后需要重新登录。
  - 两者都没有：401 `ADMIN_TOKEN_REQUIRED`。
- 改变状态的请求（POST、PUT、PATCH）必须是 `application/json`（PATCH 也接受 `application/merge-patch+json`），否则 415。请求中的未知字段返回 400。
- 错误一律是 RFC 9457 `application/problem+json`：`type`、`title`、`status`、`detail`、`instance`、`code`、`requestId`，输入错误另有 `errors[]`（`pointer` 指向请求体成员，或 `parameter` 指向查询参数），被引用而不能删除时另有 `references[]`。
- 金额是十进制字符串 `{amount, currency: "USD"}`；时间是 RFC 3339。

尚未实现：ETag 与 `If-Match`、`Idempotency-Key`、`hh admin-token rotate`（07 第 5.2 节要求它同时吊销控制台会话），以及配置列表的分页（provider、凭据、路由组与 Key 的列表一次返回全部，`nextCursor` 为 `null`）。

## 资源

| 资源 | 操作 | 要点 |
|---|---|---|
| presets | `GET /presets` | 内置的 provider 预设（[Provider 预设](provider-presets.md)，格式见 [presets](../packages/gateway/presets/README.md)）：端点、地域 `regions`、套餐 `plans`、图标、header 提示、Key 的发送方式、获取 Key 的页面、核对日期 `verified` 与数据出处 `source` |
| providers | `GET`、`POST /providers`；`GET`、`PATCH`、`DELETE /providers/{id}`；`POST /providers/{id}/models/refresh` | `POST` 可以只给 `preset`（可加 `region`、`plan`、`id`、`name`、按协议覆盖的 `endpoints` 与第一个 `credential`）；provider 记录所选的 `region` 与 `plan`，元数据按该组合的目录 ID 补齐，`catalog` 可以另行指定。刷新用第一个启用的凭据从上游列出模型（chat 基址 + `/models`、anthropic 基址 + `/v1/models`、gemini 基址 + `/v1beta/models`），按[模型元数据](#模型元数据)补齐每个模型的窗口与价格，手工填写的值保留；失败时保留原列表并标记 `stale`，错误只含主机与 HTTP 状态。端点是厂商官方 SDK 的基址：chat 与 responses 含 `/v1`，anthropic 与 gemini 不含版本段；以操作路径或版本段结尾、内嵌凭据、带查询串或片段、公网 HTTP 的基址被拒绝，`errors[]` 指向 `/endpoints/<协议>`。`proxy` 是该 provider 自己的代理（`direct` 或不含凭据的代理地址，见[出站代理](configuration.md#出站代理)），不合格时 `errors[]` 指向 `/proxy`。`limits` 为它的每个 Credential 另设并发数 `concurrentPerCredential` 与排队数 `queuePerCredential`（见[资源上限](model-gateway.md#资源上限)），不合格时 `errors[]` 指向 `/limits/<字段>`。`PATCH` 是 JSON Merge Patch。`PATCH {"enabled": false}` 关闭 provider（Magpie `provider off`），`true` 重新打开；关闭时记录带 `enabled: false`，打开时不带该字段。关闭的 provider 保留配置、凭据和接到它模型上的 Agent，但不产生路由候选（请求它的模型返回 400 `unsupported_route`，消息为 `<ref>: the provider is switched off`），不出现在 `/v1/models`、自动路由组与 Agent 接线目录中，路由组跳过它；接到它模型上的 Agent 在写入提交后立即标记 attention `AGENT_MODEL_UNAVAILABLE`（不等目录同步），文件不改写，重新打开后标记随即清除；`hh provider disable|enable` 列出被标记的 Agent。重新打开时清除其各凭据的休息与模型标记。被路由组或未吊销的 Key 引用时删除返回 409 |
| test、doctor | `POST /providers/{id}/test`；`POST /providers/{id}/doctor` | 向上游发送真实请求：每个端点一个最小请求，或 03 第 9 节的全部检查（`dryRun` 只返回计划）；每个请求记入账本，作用域 `client:doctor`；报告附带提议的 provider 补丁，不修改配置。见 [Provider 测试与体检](provider-doctor.md) |
| import | `POST /import/preview`；`POST /import/apply` | 导入链接或其他应用（Claude Code、Codex）的配置先预览为一次性的 `previewId`，确认后按 `POST /providers` 创建；见 [导入 provider](provider-import.md) |
| credentials | `GET`、`POST /providers/{id}/credentials`；`PATCH .../{credentialId}`；`PUT .../{credentialId}/secret`；`DELETE .../{credentialId}` | `value` 存入秘密后端，响应只含 `{kind:"store", value:<UUID>}` 引用；也可以给 `env` 或 `file` 引用。`PATCH {"enabled": false}` 关闭凭据，`{"enabled": true}` 打开（Magpie `SetKeyOn`）：关闭的凭据不被路由；provider 最后一个启用的凭据不能关闭（409 `CREDENTIAL_LAST_ENABLED`，要停用整个 provider 就关闭 provider）；重新打开的凭据清除休息与模型标记，下一次请求立即再试，额度读数保留。轮换保持引用不变；删除凭据或 provider 时同时删除托管秘密。06 第 3 节的 `/credentials` 顶层资源改为挂在 provider 下 |
| models | `GET /providers/{id}/models`；`GET /models/{ref}`；`GET`、`PUT`、`DELETE /models/{ref}/overrides` | 见[模型元数据](#模型元数据)。`{ref}` 中的斜杠编码为 `%2F`（模型名本身可含斜杠）；覆盖的 `{ref}` 也可以是 `provider/*` |
| catalog | `GET /catalog`；`POST /catalog/refresh` | 使用中的 models.dev 目录（`source` 为内置快照 `bundled` 或刷新副本 `refreshed`）及其取得时间、上游提交与 SHA-256、provider 与模型数，刷新地址、是否后台刷新（关闭原因 `setting` 或 `offline`）、上次刷新与下次时间。`POST` 立即刷新，后台刷新关闭时也执行；失败为 502 `CATALOG_REFRESH_FAILED`，原目录继续使用 |
| route-groups | `GET`、`POST /route-groups`；`GET`、`PATCH`、`DELETE /route-groups/{id}` | 成员必须是已存在 provider 的 Model Ref；被未吊销的 Key 允许时删除返回 409 |
| auto-groups | `GET /auto-groups`；`POST /auto-groups/{id}/hide`、`POST /auto-groups/{id}/restore` | 自动路由组：两个及以上就绪的 provider（无凭据，或至少一个凭据启用）以同一规范化名称提供的模型，即 `group/auto-<slug>`。名称规范化同 Magpie：小写、`_` 换成 `-`、只取最后一个 `/` 之后、数字之间的 `.` 或 `p` 换成 `-`、去掉快照日期（`-YYYYMMDD`、`@YYYYMMDD`、火山方舟的 `-YYMMDD`）；成员按 provider 的添加顺序，每个 provider 取第一个同名模型。自动组每次派生、不存储；同 ID 的用户路由组优先，不再列出。列表含 `id`、`model`（共同名称）、`members`、`hidden`、`createdAt`。`hide` 把 ID 写入 `hidden_auto_groups` 表（幂等），网关此后不列出、不路由它；当前没有该自动组时 404 `AUTO_GROUP_NOT_FOUND`。`restore` 删除隐藏记录，该 ID 没有被隐藏时 404 |
| gateway-keys | `GET`、`POST /gateway-keys`；`GET`、`PATCH /gateway-keys/{id}`；`POST /gateway-keys/{id}/suspend`、`/resume`、`/revoke` | 只签发 `client:` 作用域，`modelAllow` 必填；默认 90 天后过期，`expiresAt: null` 不过期。`allowLan: true` 的 Key 可以在局域网共享监听器上使用，必须有过期时间。Key 文本只出现在创建响应中，列表与详情不含哈希。`PATCH {"name"}` 重命名（`client:` Key 的 `scope.name` 一并更新），Key 文本不变。`suspend` 暂停：记录 `suspendedAt`，下一个请求起返回 401 `key_suspended`，Key 保留；`resume` 去掉 `suspendedAt`。二者可重复，已吊销的 Key 返回 409 `GATEWAY_KEY_REVOKED`。Agent 的 Key 同样可以暂停，接线视图 `keyState` 为 `suspended`，解除接线照常吊销 |
| gateway/share | `GET`、`PUT /gateway/share` | 局域网共享的设置（`lan.enabled`、`lan.host`、`lan.port`、`lan.names`、`publicBaseUrl`）与监听器状态（`listening`、`boundPort`、`urls`、`error`）；`PUT` 替换整份设置，先绑定再保存，绑定失败 409 `GATEWAY_SHARE_LISTEN_FAILED`、设置无效 400 `GATEWAY_SHARE_INVALID`，均不改变现状。规则见 [局域网共享](model-gateway.md#局域网共享) |
| model-calls | `GET /model-calls` | 新到旧，`limit` 1–200（默认 50），`cursor` 为上一页的 `nextCursor`；按 `from`（含）、`to`（不含）、`keyId`、`provider`、`model`、`sessionId`、`agent` 过滤。每项带网关记录的 `conversationKey`（会话键的 SHA-256，按 Gateway Key 隔离）与 `agent`（`{id, source}`：`key` 来自 `agent:` Key 的作用域，`user-agent` 与 `route` 是推断）。`format=csv`（或不带 `format` 而 `Accept` 把 `text/csv` 排在 JSON 之前）返回所有匹配调用的 CSV 附件，不分页，带 `cursor` 时 400（[CSV 导出](observability.md#csv-导出)） |
| usage | `GET /usage` | `groupBy` 为 `day`（UTC）、`provider`、`model`（默认）、`key`、`adapter` 或 `credential`（键为 `<provider>/<credentialId>`，凭据 ID 只在 provider 内唯一）；状态码不低于 400 记为失败，成本只累加已知价格，未知价格计入 `unpricedCalls`，`missing` 用量按 0 计；`format=csv` 或 `Accept: text/csv` 时为同样各桶的 CSV |
| usage alerts | `GET /usage/alerts` | 用量提醒的阈值（`usagePercent`，未设置为 null）与最近 40 天的提醒（`items`：`at`、`provider`、`credential`、`credentialName`、`window`、`usedPercent`、`resetsAt`），新到旧；阈值由 `PUT|DELETE /gateway/features/alerts` 设置（[用量提醒](gateway-features.md#用量提醒)） |
| conversations | `GET /conversations`；`GET /conversations/{key}` | 列表按会话汇总有 `conversationKey` 的调用：`calls`、`failedCalls`、`usage`、`cost`、`unpricedCalls`、`firstAt`、`lastAt`，以及用到的 `models`、`credentials`（`<provider>/<credentialId>`）与 `agents`，最后活动的会话在前；`limit`、`cursor` 与过滤同 `/model-calls`，过滤先作用于调用再汇总。`/{key}` 返回该会话的调用（与 `/model-calls` 相同的项与分页），首页没有调用时 404 `CONVERSATION_NOT_FOUND`，`key` 不是 64 位小写十六进制时 400 |
| subscriptions | `GET /subscriptions/notices`、`GET /subscriptions/accounts`；`POST /subscriptions/sign-in`、`GET /subscriptions/sign-in/{id}`；`GET`、`POST /subscriptions/copilot/setup`；`POST /providers/{id}/credentials/{credentialId}/sign-out` | 订阅账号（[订阅账号](subscriptions.md)）。`sign-in` 需要 `backend`（`siwc` 或 `copilot`）与 `acceptNotice`（该后端当前告知的版本，否则 409 `SUBSCRIPTION_NOTICE_NOT_ACCEPTED`），可选 `provider`（缺省 `chatgpt` 或 `copilot`）与 `credential`（让已有账号重新登录）。`siwc` 返回 202 与浏览器要打开的 `authorizeUrl`，状态在 10 分钟内可查，成功后带 `credential`、`email`、`firstSignIn`；`copilot` 另可给 `auth`（`login` 缺省或 `token`）与 `token`（细粒度 PAT，否则 400 `COPILOT_TOKEN_INVALID`），在返回前完成，成功后带 `credential`、`login`、`firstSignIn`。`GET copilot/setup` 报告 SDK 附加组件与 Copilot CLI，并给出 npm 安装命令；`POST` 以用户的 npm 安装受支持的 SDK（409 `NPM_NOT_FOUND`、502 `COPILOT_SDK_INSTALL_FAILED`）。账号列表不含令牌；`sign-out` 结束厂商侧会话（Copilot：停止宿主进程）并清空令牌，返回 `revoked`。订阅账号的令牌不能经 `PUT …/secret` 轮换（409 `SUBSCRIPTION_ACCOUNT`） |
| agents | `GET /agents`、`GET /agents/{id}`；`POST /agents/{id}/wiring/plan`、`POST /agents/{id}/wiring`、`POST /agents/{id}/wiring/rotate`、`DELETE /agents/{id}/wiring` | 本机 Agent 的安装、接线与漂移；接线签发 `agent:` Key，Key 文本只写入 Agent 的配置文件。见 [全局接线](global-wiring.md) |
| backup、sync | `POST /backup`、`POST /restore`；`GET`、`PUT`、`DELETE /sync`、`POST /sync/now` | 口令加密的备份与恢复、经 WebDAV 或 S3 的多机同步。见 [备份、恢复与同步](backup-sync.md) |
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
- 目录默认在后台刷新：每 24 小时请求一次 `https://models.dev/api.json`，服务了无价格的调用后最早 6 小时提前刷新；结果存放在 `<dataDir>/catalog`，不覆盖内置快照，内容变化后重新解析全部 provider 的元数据。`HH_OFFLINE=1` 或 `catalog.autoRefresh: false` 关闭后台刷新，`hh catalog refresh` 仍可手动刷新。细节见 [模型目录](../packages/gateway/catalog/README.md#运行时刷新)。快照随发行附带 models.dev 的 MIT 许可文本。
- 尚未实现：推理档位、结构化输出、按上下文分档的价格、“输出上限小于窗口”的统一校验与缺窗口告警，以及 `catalog.autoRefresh` 的配置文件入口（目前是 `startHub` 的选项）。

## CLI

命令经 `--url`（默认 `http://127.0.0.1:3180`）连接守护进程，从 `--data-dir`（默认 `./data`，与 `hh serve` 相同）读取 `admin.token`。默认输出表格，`--json` 输出与 API 响应相同的 JSON；失败时 `--json` 把 problem 对象写到 stdout，并在 stderr 写一行说明。这些通用选项（还有 `--yes`、`--non-interactive`）写在命令之后，也可以写在命令之前（`hh --url URL provider list`，见 [apps/hh](../apps/hh/README.md)）。

```sh
hh status
hh provider presets
printf '%s' "$KEY" | hh provider add --preset deepseek --credential-from-stdin
printf '%s' "$KEY" | hh provider add --preset moonshot --region global --credential-from-stdin
hh provider add glm --preset zhipu --plan coding
hh provider models deepseek --refresh
hh provider test deepseek                     # 每个端点一个最小请求
hh provider doctor deepseek [--deep] [--fix]  # 先打印计划与预计成本，再逐项检查
hh import - --yes < link.txt                 # 从 stdin 读导入链接，不询问（stdin 不是终端，没有 --yes 时只预览并以 4 退出）
hh import --from codex                        # 导入 Codex 已配置的上游
hh provider add local-llm --chat http://127.0.0.1:8000/v1 --model my-model
hh provider proxy deepseek direct             # 这个 provider 不经代理；default 回到守护进程的代理
hh provider limits deepseek --concurrency 2 --queue 10   # 每个 Credential 同时 2 个、排队 10 个；--clear 回到网关的上限
hh credential add deepseek --name main          # 在终端中隐藏输入
printf '%s' "$KEY" | hh credential add deepseek --from-stdin
hh credential rotate deepseek key-1 --from-env NEW_KEY
hh credential disable deepseek key-2          # 不再路由到它；enable 打开，立即再试
hh provider disable deepseek                  # 关闭整个 provider，保留配置；enable 打开
hh model show deepseek/deepseek-chat         # 每个值的来源与时间
hh model set deepseek/deepseek-chat context=65536 price.input=0.27 price.output=1.1
hh model set 'deepseek/*' output=8192        # 该 provider 的全部模型
hh model set deepseek/deepseek-chat price.output=   # 删除覆盖中的一项
hh model unset deepseek/deepseek-chat
hh catalog status                            # 使用中的目录、上次刷新、是否后台刷新
hh catalog refresh
hh group add fast --member deepseek/deepseek-chat --strategy latency
hh group add plans --member chatgpt/gpt-plan --member keyed/model --strategy smart   # 也可 pace
hh group add deep --member openai/gpt-5.5:high:fast --member group/fast   # 固定强度、快速模式、组中的组
hh group rule add deep 'use=group/fast tokens=200k'          # 长请求先给 group/fast
hh group rule add deep use=gpt-5.5 images days=sat,sun        # 周末带图片的请求
hh group rule add deep use=gpt-5.5 intent="a quick question" classifier=groq/llama-3.1-8b
hh group rule list deep                      # 规则、条件与分类器；remove|move <n> 删除或调整次序
hh group rule effort deep auto               # 分类器为每一轮选推理强度；off 关闭
hh group auto                                # 自动路由组及是否隐藏
hh group hide auto-deepseek-v4               # hh group restore auto-deepseek-v4 恢复
hh key create --name ci --allow deepseek/* --allow group/fast   # Key 只打印这一次
hh key create --name team --allow deepseek/* --rpm 60 --budget day:tokens=2000000 --budget month:cost=20
hh key quota <keyId> --budget week:tokens=5000000,cache-reads   # 替换限额；--clear 删除
hh key limit <keyId>                         # 每个预算本窗口的用量、在途请求与重置时刻
hh key rename <keyId> laptop
hh key suspend <keyId>                       # 暂时拒绝（401 key_suspended），hh key resume <keyId> 恢复
hh usage --by provider --since 7d
hh usage --by key                            # 每把 Key 的 ID 与名称
hh usage --by credential --since 1d          # 每个凭据：<provider>/<credentialId>
hh usage --by conversation --agent codex     # 每个会话：调用数、token、成本、首末时间
hh usage --by call --since 30d --format csv > calls.csv   # 每次调用一行，列同 magpie usage --csv
hh usage --by provider --format csv          # 汇总表的 CSV
hh key revoke <keyId> --yes
hh gateway share on --host 192.168.1.5        # 另在局域网地址上监听，端口默认同守护进程
hh key create --name laptop --allow deepseek/* --lan   # 局域网上只接受这种 Key
hh gateway share status
hh gateway share off
hh subscription notice                       # 订阅账号的风险告知
hh subscription login chatgpt                # 显示告知，确认后在浏览器中 Continue with ChatGPT
hh subscription list
hh subscription logout chatgpt account-1 --yes
hh subscription setup copilot [--install]    # Copilot SDK 附加组件与 Copilot CLI 是否就绪；--install 用 npm 安装 SDK
hh subscription login copilot                # 用 Copilot CLI 自己的登录；--token 等改用细粒度 PAT
# 另一台机器：把这台 HarnessHub 当作 provider
printf '%s' "$LAN_KEY" | hh provider add office --preset harnesshub-remote \
  --base http://192.168.1.5:3180 --credential-from-stdin
hh provider models office --refresh           # 模型名为 office/<provider>/<model>
```

- `hh key create` 与 `hh key quota` 的 `--budget PERIOD:tokens=N,cost=USD,cache-reads`：PERIOD 为 day、week 或 month（守护进程本地时区的日历窗口），`tokens` 与 `cost` 至少一个，值为 0 时该窗口内的每次调用都被拒绝，`cache-reads` 时缓存读取也计入 tokens；`--rpm N` 是每分钟请求数。`hh key quota` 替换整个限额，`--clear` 删除。路由组成员的写法见 [统一模型网关](model-gateway.md#路由重试与熔断)：`provider/model:<effort>`、最后的 `:fast` 与 `group/<id>`。
- `hh group rule add <group> WORD...`：Magpie 的写法，`use=<成员>`（全名、模型名或其最后一段，可省略成员的档位后缀）加至少一个条件：`tokens=200k`（也写 `1.5m`）、`images`、`effort[=on|low|medium|high|xhigh|max]`、`agents=claude,codex`、`intent="…"`（需要组的分类器，可在同一行给出 `classifier=<provider/model>`）、`compact`、`time=HH:MM-HH:MM`（本地时间，可跨午夜）、`days=mon-fri`；`at=N` 放到第 N 位。整条规则也可以放在一个引号里。读不懂时退出码 2，并指出是哪个词。`hh group rule classifier <group> <ref>|off` 设置或去掉分类器。规则的含义与路由见 [统一模型网关](model-gateway.md#路由重试与熔断)。
- `hh model set` 的键：`context`、`output`（token 数）、`reasoning`、`toolcall`（yes 或 no）、`modalities`（逗号分隔的 text、image、pdf、audio、video）、`price.input`、`price.output`、`price.cacheRead`、`price.cacheWrite`（美元每百万 token）。新值与已有覆盖合并，`键=` 删除一项，全部删除后覆盖被移除。
- `hh gateway share on` 的 `--host`（本机 IP，`0.0.0.0` 表示全部地址，此时需要 `--name`）、`--port`、可重复的 `--name` 与 `--public-base-url` 未给出时沿用当前设置；`off` 保留地址只关闭监听器。`hh provider add --preset P [--region R] [--plan P] --base URL` 把所选组合的每个端点路径接到 `URL` 之后，`--chat` 等显式端点优先。
- 秘密从不作为参数：终端中隐藏输入，非交互时必须用 `--from-stdin`、`--from-env <变量>` 或 `--from-file <路径>`，否则以 2 退出。
- `hh usage --by conversation` 经 `GET /conversations` 列出最后活动的 200 个会话（会话键只显示前 12 位，`--json` 输出完整的 API 响应），可用 `--since`、`--from`、`--to`、`--agent` 等缩小范围；`--by call` 经 `GET /model-calls` 列出最近 50 次调用；其他 `--by` 取值经 `GET /usage` 汇总。`--format text|json|csv`（`json` 同 `--json`，二者不能同时给出）：`csv` 把 `--by call` 的所有匹配调用（不止 50 次）或汇总表原样写到标准输出，不支持 `--by conversation`。CSV 的列与写法见 [运行观测](observability.md#csv-导出)。`hh group hide` 与 `restore` 只接受自动路由组，可以随时恢复，因此不需要确认。
- `provider remove`、`credential remove`、`group remove`、`key revoke` 与 `import` 需要确认；`--yes` 跳过，非交互且没有 `--yes` 时以 4 退出且不做修改，错误为确认问题加上 “No terminal to confirm; pass --yes.”（接线、Profile、Library 同步、备份与恢复、同步、体检、订阅登录与 `hh init` 的接线确认措辞相同）。stdin 不是终端、设置了 `CI` 或给出 `--non-interactive` 时为非交互。
- 退出码（06 第 5 节）：0 成功；1 内部错误；2 用法错误、输入无效或名称不存在；3 守护进程不可达或数据目录中没有令牌；4 需要确认；5 冲突（409、412、422）；6 认证失败；7 达到上限或未就绪（429、503）；130 中断。

控制台由守护进程在同一端口提供，它的 Agent、Profile、Provider、路由与 Key、用量与设置页面以控制台会话经 SDK 调用这些接口，浏览器拿不到管理令牌（见 [控制台](../packages/console/README.md)）。`hh console [--url URL] [--data-dir DIR] [--json]` 打印登录链接，退出码同上。

测试：[api-v1.test.ts](../tests/integration/api-v1.test.ts) 在进程内启动守护进程，经 SDK 验证认证、校验、凭据值不出现在任何响应、日志与数据目录文件中、Key 的签发与吊销、基于写入账本的用量、会话视图与按凭据汇总、自动路由组的派生、隐藏（重启后仍在）与恢复；[hh-cli.test.ts](../tests/integration/hh-cli.test.ts) 对同一守护进程运行真实的 `hh` 入口；[model-metadata.test.ts](../tests/integration/model-metadata.test.ts) 经 SDK 验证预设与快照补齐、覆盖与手工值的优先级、重启后覆盖仍在，以及网关按补齐的价格计算成本，[单元测试](../tests/unit/model-metadata.test.ts) 覆盖解析顺序与来源记录。
