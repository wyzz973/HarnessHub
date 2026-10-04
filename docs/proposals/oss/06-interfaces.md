# 06 接口与交互面

状态：提案（草案），2026-10-02。术语、模块名、端口与数据归属以 [02 系统架构](02-architecture.md) 为准，版本范围以 [01 产品定义](01-product.md) 为准；API 版本与兼容承诺的决定见 [ADR-P11](adr-drafts.md#adr-p11-api-版本与兼容承诺)，控制台形态见 [ADR-P10](adr-drafts.md#adr-p10-控制台改为内嵌静态单页)。网关协议细节见 [03 模型平面](03-model-plane.md)，执行语义见 [05 执行平面](05-run-plane.md)，MCP Server 见 [05 第 9 节](05-run-plane.md#9-mcp-server)。

本文规定所有交互面共用的契约：REST/SSE、SDK、`hh` CLI、Web 控制台、桌面托盘与导入链接。CLI、控制台与 SDK 都只通过 `/api/v1` 工作，不直接访问存储或服务端包（[02 第 8 节](02-architecture.md#8-模块与依赖规则)）。现状的 49 个 HTTP 操作见 [API 参考](../../api/reference.md)，迁移见第 3 节末尾。

## 1. 端口与路径布局

守护进程默认只有一个回环监听器 `127.0.0.1:3180`（沿用现状端口），按路径分流；开启局域网共享后另有一个局域网监听器，只注册下表最后一列标为“注册”的路由：

| 路径 | 用途 | 认证 | 错误格式 | 局域网监听器上 |
|---|---|---|---|---|
| `/api/v1/*` | 管理与执行 API、SSE、`/api/v1/openapi.json`、`/api/v1/mcp` | 本机管理令牌或控制台会话；`/api/v1/mcp` 另接受委派令牌 | `application/problem+json` | 不注册 |
| `/v1/*` | OpenAI Chat、Responses、models；Anthropic Messages 与 count_tokens；Gemini 的 `/v1` 别名 | Gateway Key | 所属协议的原生格式 | 注册，只接受命名的 `client:` Key |
| `/v1beta/*`（及 `/v1alpha/*`） | Gemini generateContent、streamGenerateContent、countTokens、models | Gateway Key（含 `?key=`） | Gemini 原生格式 | 同上 |
| `POST /chat/completions`、`/responses`、`/messages`、`/messages/count_tokens` | 省略 `/v1` 的兼容路径（[03 第 1 节](03-model-plane.md#1-范围与入口)） | Gateway Key | 原生格式 | 同上 |
| `/`、`/assets/*` | 内嵌控制台；`/assets/*` 带内容哈希、长期缓存 | 页面不含数据，数据经 API 鉴权 | — | 不注册 |
| `/healthz` | 存活：事件循环 1 秒内响应即 200，不检查依赖（语义见 [08 第 9 节](08-reliability-observability.md#9-健康检查与告警)） | 无 | JSON | 注册 |
| `/readyz` | 就绪：持有单实例锁、迁移与恢复已完成、30 秒内有过成功的 Store 写入、磁盘可用空间高于水位；否则 503 与原因数组（08 第 9 节） | 无 | JSON | 不注册 |
| `/metrics` | Prometheus 文本格式，指标名与标签见 [08 第 6 节](08-reliability-observability.md#6-指标) | 管理令牌（Bearer） | 文本 | 不注册 |

规则：

- `/v1`、`/v1beta`、`/v1alpha` 只属于模型协议，管理接口永不放在这些前缀下；现状管理接口位于 `/v1/*`，开源版整体迁到 `/api/v1/*`。保留前缀下的未知路径返回所属协议格式的 404，并按 03 第 2 节留下拒绝记录。
- 控制台的单页回退只对 `GET` 且 `Accept` 含 `text/html` 的非保留路径生效；`/api/`、`/v1`、`/v1beta`、`/v1alpha` 永不回退到 `index.html`。
- 端口被占用时启动失败并说明原因，不自动换端口，因为全局接线把地址写进了 Agent 配置；用 `--port` 改端口后，已接线的 Agent 会被漂移检测报告为 `unwired`（[04 第 5 节](04-agent-plane.md#5-漂移检测)）。同一数据根的第二个实例由单实例锁拒绝（02 第 5 节）。
- 浏览器防护：Host、Origin 与 `Sec-Fetch-Site` 的校验在路由之前执行，规则见 [07 第 5.3 节](07-data-security.md#53-hostorigin-与-sec-fetch-校验)（由现状 `packages/daemon/src/http/server.ts:174-195` 演进）；模型协议路径上带 `Origin` 的请求返回 403（03 第 1 节）；`/api/v1` 只接受同源请求，不开放 CORS。
- 局域网监听器的开启条件、TLS 要求与来源校验见 [07 第 5.4 节](07-data-security.md#54-局域网共享10)；回环监听器照常提供全部路由。
- 认证材料与控制台登录按 [07 第 5.2 节](07-data-security.md#52-本机管理令牌与控制台会话)：CLI 读取 `<数据根>/admin.token` 以 Bearer 调用 `/api/v1`；`hh console` 经 `POST /api/v1/auth/console-links` 取得一次性登录码，打开 `/#login=<code>`，单页再调用 `POST /api/v1/auth/console-sessions` 换取 HttpOnly、`SameSite=Strict` 的会话 Cookie。改变状态的请求必须是 `application/json`，守护进程不响应 CORS 预检。Gateway Key 不能访问 `/api/v1`（03 第 2 节）。团队服务器的 OIDC 登录与 RBAC 属于 1.x。

## 2. REST API 规范

### 2.1 资源命名与表示

- 路径用复数、小写、连字符分隔的名词，如 `/api/v1/route-groups`；动作用 POST 子资源，如 `/runs/{id}/cancel`、`/wirings/plans/{id}/apply`，沿用现状的动作风格。
- 系统生成的 ID 是带类型前缀的不透明字符串：`ses_`、`run_`、`prm_`、`art_`、`ws_`、`plan_`、`bat_`、`evr_`；客户端不得解析其内容。用户命名的资源（Agent、provider、路由组、Profile、策略）使用 slug `^[a-z0-9][a-z0-9-]{0,62}$`；Gateway Key 使用 03 的 `keyId`。Model Ref 含 `/`，作为路径参数时整体百分号编码一次（`deepseek%2Fdeepseek-chat`），SDK 负责编码。
- JSON 字段用 camelCase（沿用现状）。时间为 RFC 3339 UTC 字符串，精确到毫秒；时长为整数毫秒，字段名以 `Ms` 结尾；金额为 `{amount: "0.0123", currency: "USD"}`，用十进制字符串避免浮点误差；未知值是 `null` 并附 `missingReason`，不用 0 代替。
- 封闭枚举（Run 状态、Session 状态）在 v1 内不新增取值；开放枚举（事件类型、错误码、stopReason、`settlement` 取值）可以新增，客户端必须容忍未知值。请求中的未知字段返回 400，不静默忽略（沿用 [API 入口](../../api/README.md) 的约定）。

### 2.2 分页与过滤

列表统一使用游标分页：`?limit=`（1–200，默认 50）与 `?cursor=`，响应为 `{items: [...], nextCursor: string | null}`；游标编码 `(排序键, id)`，插入新数据不会造成重复或遗漏。默认按创建时间倒序，`order` 只接受各资源文档列出的取值。过滤使用显式参数，如 `status=failed&agent=codex&label=team:web&createdAfter=…`，不提供通用查询语言；未知参数返回 400。默认不返回总数。Run 事件例外：使用 Run 内的 `seq` 作为天然游标（`afterSeq`），沿用现状。

### 2.3 错误格式

`/api/v1` 的错误一律是 RFC 9457 `application/problem+json`。设计示意，不可直接运行：

```json
{
  "type": "https://harnesshub.dev/problems/run-not-found",
  "title": "Run not found",
  "status": 404,
  "detail": "No run with id run_01J9Z8…",
  "instance": "/api/v1/runs/run_01J9Z8…",
  "code": "RUN_NOT_FOUND",
  "requestId": "req_7Q2…",
  "errors": [{"pointer": "/budget/maxTokens", "detail": "must be a positive integer"}]
}
```

`code` 是 v1 内含义不变的大写错误码，由 `core` 的错误码注册表生成，延续现状 `{"error":{"code","message"}}` 中的 `code`；`type` 的域名在 M0 确定，之前以 `harnesshub.dev` 占位。`title` 与 `detail` 固定为英文，控制台与 CLI 按 `code` 显示本地化文字。状态码约定：400 输入无效（`errors[]` 用 JSON Pointer 定位）；401 未认证；403 无权；404 不存在；409 状态冲突；412 `If-Match` 不符；415 媒体类型不支持；422 幂等键被不同请求复用；428 缺少 `If-Match`；429 达到上限（带 `Retry-After`）；503 未就绪或存储不可用。SSE 开始输出后发生的错误先写一条 `event: error`（data 为 problem 对象）再关闭连接，现状是直接断开。模型网关路径保持各协议的原生错误格式，并带 `x-hh-error-source`（03 第 1 节）。

### 2.4 幂等键

所有创建资源或产生副作用的 POST 接受 `Idempotency-Key` 头（1–128 个可见 ASCII 字符），包括 Session、Run、批次、评测运行、接线与 Library 计划的应用、导入。作用域是“调用方凭据 + 方法 + 路由模板 + 键”，服务器保存请求体哈希与首次响应 24 小时：同键同体重放原响应并带 `Idempotent-Replayed: true`；同键不同体返回 422 `IDEMPOTENCY_KEY_REUSED`；首次请求仍在处理时返回 409 `IDEMPOTENCY_IN_PROGRESS`。Run 提交沿用现状语义：键随 Run 永久保存、作用域为 Session（[DESIGN.md §7](../../../DESIGN.md#7-通用-api-基线)），只把“同键不同输入”的响应从现状的 409 改为 422，与其他资源一致。

### 2.5 ETag 与乐观并发

配置类资源（provider、credential 元数据、model 覆盖、路由组、Gateway Key、Profile、策略、Library 条目、插件、设置）的响应带强 ETag，取值为资源 revision。`PUT`、`PATCH`、`DELETE` 必须带 `If-Match`：缺少时返回 428，不符时返回 412，并在 problem 中附 `currentEtag`。`PATCH` 使用 JSON Merge Patch（RFC 7396，`application/merge-patch+json`），`PUT` 为整体替换。`GET` 支持 `If-None-Match` 返回 304。Session、Run 等状态机资源不用 `If-Match`，状态变化通过幂等的动作接口完成；它们的弱 ETag 只用于轮询时减少传输。改写用户文件的操作另有计划指纹：计划记录目标文件的 SHA-256，应用时文件已变化则返回 412（[04 第 4 节](04-agent-plane.md#4-全局接线)）。

### 2.6 SSE 与断点续传

- `GET /api/v1/runs/{id}/events`：`id` 为 Run 内 `seq`，`event` 为事件类型，`data` 为完整事件信封；支持 `Last-Event-ID` 与优先级更高的 `afterSeq`；游标超过已提交范围返回 400；追平终态后服务器关闭流。客户端断开不取消 Run，重连可能重复投递，客户端按 `(runId, seq)` 去重。以上沿用现状。
- `GET /api/v1/events?topics=runs,permissions,usage,wirings`：控制台使用的全局流，`id` 为全库递增的 `gseq`（05 第 1 节），同样可续传；服务器只保证已提交事件的顺序，主题过滤在服务端完成。
- 每 15 秒发送一条 `: ping` 注释保活，首条消息带 `retry: 3000`；响应头带 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no`，避免反向代理缓冲。注释保活只用于本 API；模型网关的保活规则由 03 第 6 节规定，两者无关。
- 慢订阅者从存储按批分页追赶，不在内存中为订阅者保留无界缓冲；每个 Run 最多 64 个、全局最多 256 个订阅者（05 第 10 节）。
- 不能使用 SSE 的客户端改用长轮询：`GET /api/v1/runs/{id}?wait=30&afterSeq=N` 在状态变化或出现新事件时立即返回，否则等待到期；`wait` 上限 60 秒，与 Magpie `internal/gateway/session_route.go` 的 `routeWaitMax` 相同。

### 2.7 版本与弃用

按 ADR-P11：路径版本 `/api/v1`，1.0 起同一大版本内只做向后兼容的增加，包括新端点、新的可选请求字段、新响应字段与开放枚举的新取值。删除字段、改变类型、收紧校验、给封闭枚举加值都属于破坏性变更，只能出现在 `/api/v2`；新大版本发布后旧版本至少再保留 12 个月。弃用的字段与端点至少保留两个次版本且不少于 6 个月（与 [10 第 5 节](10-engineering.md#5-发布工程) 一致），期间响应带 `Deprecation`（RFC 9745）、`Sunset`（RFC 8594）与 `Link: <迁移文档>; rel="deprecation"`，CLI 在 stderr 提示。标记为实验性的端点在 OpenAPI 中带 `x-hh-stability: experimental`，响应带 `HH-Stability: experimental` 头，不受上述承诺约束。

### 2.8 OpenAPI 3.1 与兼容性测试

契约由 Fastify 路由的 JSON Schema 生成，沿用现状 `packages/daemon/src/http/openapi.ts`、`packages/daemon/src/http/api-catalog.ts` 与 `pnpm docs:api`、`pnpm check:api` 的做法（[文档规范](../../documentation.md)），运行时在 `/api/v1/openapi.json` 提供。CI 中的检查：

1. 路由与文档双向覆盖、`operationId` 唯一、实现与测试链接存在（现有 `check:api` 的规则）。
2. 用上一个发布版本的契约做差异比对（如 oasdiff）：删除字段、改变类型、收紧枚举或校验即失败，除非大版本号变化。
3. 集成测试中每个响应都用 Ajv 按契约校验，包括 4xx 的 problem 对象。
4. SDK 由同一份契约生成，生成结果的新鲜度检查与 SDK 契约测试在每个 PR 运行（第 4 节）。

模型网关端点跟随上游协议，不进入这份 OpenAPI，由 03 第 11 节的协议一致性套件覆盖。

### 2.9 与同类接口的取舍

| 参照 | 做法 | HarnessHub 的取舍 |
|---|---|---|
| [OpenCode server](https://opencode.ai/docs/server/)（`opencode serve`） | 发布 OpenAPI 3.1，SSE `/event`，会话的 fork、abort、revert，权限端点，SDK 由契约生成 | 采用“契约生成 SDK”。取消是 Run 级动作 `POST /runs/{id}/cancel`，返回 202 后以终态为准（05）。1.0 不提供会话 fork：后端上下文属于各 Agent，ACP 的会话分叉并非普遍支持。revert 放到 1.x，形式为 `POST /api/v1/runs/{id}/revert` 把工作区恢复到起点快照（05 第 3 节），并把该 Session 后续上下文标为“与工作区不一致” |
| [sandbox-agent](https://github.com/rivet-dev/sandbox-agent) | 统一 HTTP/SSE 与会话 schema，事件按偏移回放 | 等价于现有事件信封加 `seq` 回放；HarnessHub 在同一 schema 中加入结算、账本与证据强度字段（05 第 4 节） |
| Magpie `internal/gui` | 动作式 RPC（`POST /api/provider/{action}`），无公开契约，前端专用 | 公开、版本化、可生成 SDK 的资源式 API，控制台与第三方使用同一套接口 |

## 3. 资源与端点清单

下表是 `/api/v1` 的完整清单，路径省略 `/api/v1` 前缀。“实验性”标记的端点不纳入 1.0 兼容承诺。

| 资源 | 方法与路径 | 说明 |
|---|---|---|
| agents | `GET /agents`、`GET /agents/{agentId}` | Adapter 与发现结果：安装状态、版本、接线模式、漂移、`stability` 级别、策略与隔离覆盖能力 |
| | `POST /agents/discover` | 重新扫描本机（[04 第 3 节](04-agent-plane.md#3-发现)） |
| | `GET /agents/{agentId}/models` | 该 Agent 可选的模型及不可选的原因 |
| | `GET /agents/{agentId}/native-sessions` | Agent 原生会话的只读列表（1.0 只读，见 01 第 4 节） |
| wirings | `GET /wirings`、`GET /wirings/{id}`、`GET /wirings/{id}/backups` | 当前接线、补丁摘要、备份清单 |
| | `POST /wirings/plans`、`GET /wirings/plans/{planId}` | 计算 wire、unwire、reapply、forget、restore 或 Profile 切换的计划，只预览不写入；计划 10 分钟后过期 |
| | `POST /wirings/plans/{planId}/apply` | 应用计划；目标文件已变化时 412 |
| profiles | `GET`、`POST /profiles`；`GET`、`PATCH`、`DELETE /profiles/{id}` | `POST` 可用 `from: "current"` 快照当前状态；切换通过 Profile 类型的接线计划完成 |
| providers | `GET`、`POST /providers`；`GET`、`PATCH`、`DELETE /providers/{id}` | 被路由组、Key 白名单或 Session 引用时删除返回 409，并列出引用方 |
| | `GET /providers/presets` | 内置预设 |
| | `POST /providers/{id}/doctor` | 能力体检（[03 第 9 节](03-model-plane.md#9-能力体检)），会产生实际调用与费用 |
| | `POST /providers/{id}/models/refresh` | 刷新厂商实时模型列表 |
| credentials | `GET`、`POST /credentials`；`GET`、`DELETE /credentials/{id}` | `POST` 把秘密写入系统密钥库并返回引用；任何响应都不含秘密值 |
| | `PUT /credentials/{id}/secret` | 轮换秘密值，引用不变 |
| models | `GET /models` | 模型目录，可按 provider、能力、Agent 过滤；每个字段带来源 |
| | `GET`、`PATCH /models/{ref}`；`DELETE /models/{ref}/overrides` | 用户覆盖名称、价格、窗口、wire 名 |
| | `GET /catalog` | 目录快照版本、刷新时间与来源 |
| route-groups | `GET`、`POST /route-groups`；`GET`、`PATCH`、`DELETE /route-groups/{id}` | 成员、策略、粘性、重试设置 |
| | `GET /route-groups/{id}/decisions` | 最近的路由决定与熔断状态；支持 `?after=&wait=` 长轮询 |
| gateway-keys | `GET`、`POST /gateway-keys`；`GET`、`PATCH /gateway-keys/{id}` | `POST` 只在本次响应中返回一次明文；`PATCH` 改白名单、额度、过期时间与来源 |
| | `POST /gateway-keys/{id}/revoke`、`POST /gateway-keys/{id}/rotate` | `revoke` 可带 `terminate: true` 同时取消在途调用 |
| usage | `GET /usage` | 聚合：按 Agent、模型、provider、Credential、Key、Session、日期分组，带时间范围 |
| | `GET /model-calls`、`GET /model-calls/{callId}` | `model.call` 账本与逐次尝试（[03 第 8 节](03-model-plane.md#8-用量与成本账本)） |
| | `GET /usage/export?format=csv\|jsonl` | 流式导出，不含提示词与正文 |
| sessions | `GET`、`POST /sessions`；`GET /sessions/{id}` | 创建时解析并冻结 05 第 2 节的字段 |
| | `POST /sessions/{id}/suspend`、`POST /sessions/{id}/close` | 沿用现状语义 |
| | `GET /sessions/{id}/logs` | 诊断日志分页，沿用现状游标 |
| runs | `POST /sessions/{id}/runs` | 提交 Run，返回 202 与 Location |
| | `POST /runs` | 一次创建 Session 与 Run，供 `hh run` 与 SDK 便捷层使用 |
| | `GET /runs`、`GET /runs/{id}` | 过滤 status、agent、model、batch、label；单个 Run 支持 `?wait=&afterSeq=` |
| | `POST /runs/{id}/cancel` | 202 只表示取消请求已受理 |
| | `GET /runs/{id}/settlement` | 三个结算面、命中规则与证据引用（05 第 4.4 节） |
| | `GET /runs/{id}/diff`、`GET /runs/{id}/evaluations` | `changes.patch` 与统计；`verify` 产生的 Evaluation |
| | `POST /runs/{id}/apply-plans`、`POST /runs/{id}/apply-plans/{planId}/apply` | 把改动应用回源目录的计划与执行（05 第 7 节） |
| | `POST /runs/batches`、`GET /runs/batches/{id}` | 比较批次与比较表 |
| events | `GET /runs/{id}/events` | SSE，见 2.6 |
| | `GET /runs/{id}/event-log`、`GET /runs/{id}/rollout` | JSON 分页；NDJSON 导出，可从存储重建 |
| | `GET /events` | 全局 SSE，按主题过滤 |
| permissions | `GET /permissions`、`GET /permissions/{id}` | 过滤 `status=pending`、`decidedBy=policy` 等 |
| | `POST /permissions/{id}/decision` | 提交实际 option ID；过期或冲突返回 409 |
| | `GET`、`POST /permissions/policies`；`GET`、`PUT`、`DELETE /permissions/policies/{id}` | 策略与预设（05 第 5 节） |
| artifacts | `GET /artifacts`、`GET /artifacts/{id}` | 元数据，可按 `runId` 过滤 |
| | `GET /artifacts/{id}/content` | 内容下载：attachment、`nosniff`、CSP sandbox，支持 Range；读取前校验大小与 SHA-256 |
| workspaces | `GET`、`POST /workspaces`；`GET`、`DELETE /workspaces/{id}` | 登记 `path`，创建 `worktree` 或 `temp`；只能删除 HarnessHub 自有的工作区 |
| | `POST /workspaces/gc` | 默认 `dryRun: true`，返回回收计划 |
| library | `GET`、`POST /library/items`；`GET`、`PATCH`、`DELETE /library/items/{id}`；`GET /library/items/{id}/versions` | Skills、MCP 服务与指令集，按内容寻址保存版本 |
| | `POST /library/sync-plans`、`POST /library/sync-plans/{planId}/apply` | 同步到各 Agent 的计划与应用（[04 第 8 节](04-agent-plane.md#8-library)） |
| evals（实验性） | `GET`、`POST /evals/datasets`；`GET /evals/datasets/{id}` | dataset v1 与 v2 |
| | `POST /evals/runs`、`GET /evals/runs/{id}`、`POST /evals/runs/{id}/cancel`、`GET /evals/runs/{id}/report` | 矩阵执行与报告 |
| | `POST /evals/attempts/{id}/regrade` | 只读已保存证据重新评分 |
| plugins | `GET`、`POST /plugins`；`GET`、`PATCH`、`DELETE /plugins/{id}` | 安装要求内容摘要；`PATCH` 启用或停用 |
| | `POST /plugins/{id}/restart`、`GET /plugins/{id}/logs` | 进程管理与日志 |
| system | `GET /system/info` | 版本与构建身份、API 版本、功能开关、数据目录、各维度的隔离能力 |
| | `GET /system/health` | 组件明细：provider 熔断、插件、Worker 数、秘密后端、导出丢弃数（08 第 9 节） |
| | `POST /system/doctor` | 运行环境检查，结果为检查列表，HTTP 200 不代表全部通过 |
| | `GET`、`PATCH /system/settings` | 全局设置，带 ETag |
| | `GET`、`POST /system/tokens`；`DELETE /system/tokens/{id}` | MCP 委派令牌（05 第 9 节）；管理令牌只能用 `hh admin-token rotate` 轮换 |
| | `POST /auth/console-links`、`POST /auth/console-sessions`、`GET`、`DELETE /auth/console-sessions/current` | 控制台一次性登录码、换取会话、读取当前会话的 CSRF 值、登出（07 第 5.2 节，[ADR 0024](../../decisions/0024-embedded-console.md)） |
| | `POST /system/import-links`、`POST /system/import-links/{previewId}/apply` | 导入链接的预览与确认（第 8 节） |
| | `POST /system/exports`、`POST /system/backups`；`POST /system/imports`、`POST /system/imports/{previewId}/apply` | 配置或运行证据的导出与备份、导出归档的预览与导入（[07 第 3 节](07-data-security.md#3-导出导入与备份)）；恢复要求守护进程停止，只能用 `hh restore` |
| | `POST /system/gc` | 按 07 第 2.3 节的保留规则回收，默认只返回计划 |
| | `POST /system/debug-bundles`；`GET /system/debug-bundles/{id}` | 由守护进程生成脱敏诊断包，生成后自检，命中秘密即中止（08 第 8 节）；`hh debug bundle` 调用它 |
| | `GET /openapi.json`、`/mcp` | 契约；MCP Streamable HTTP 端点 |

现状接口的迁移：`/v1/sessions`、`/v1/runs`、`/v1/permissions`、`/v1/workspaces` 等按同名资源迁到 `/api/v1`；`/v1/engines*` 与 `/v1/engine-configuration/*` 拆分进 agents、wirings 与 Session 的隔离接线；`/v1/harness/model*` 由 providers、models 与 route-groups 取代；`/v1/tool-packs*` 并入 library；`/v1/secrets` 改为 credentials；`/v1/observability` 与 `/v1/runs/{id}/observations` 由 usage、model-calls 与 Run 详情取代；`GET /v1/artifacts/{id}` 拆成元数据与 `/content`；`/v1/workflows*` 不进入 1.0（05 第 11 节）；`/health/live`、`/health/ready` 改为 `/healthz`、`/readyz`。0.x 期间不保留旧路径的兼容别名，迁移说明随版本发布。

## 4. SDK

| 项 | TypeScript | Python |
|---|---|---|
| 包名与位置 | `@harnesshub/sdk`，`packages/sdk` | `harnesshub`，`clients/python`，Python 3.10 及以上 |
| 生成部分 | openapi-typescript 从 `/api/v1/openapi.json` 生成类型，放在 `src/generated/` | datamodel-code-generator 生成 pydantic v2 模型 |
| 手写部分 | 基于 `fetch` 的传输、SSE 解析与下表的便捷层 | 基于 httpx 的同步与异步客户端、SSE 解析与同样的便捷层；生成器对 SSE 与重试的支持不足，因此传输手写 |
| 首个版本 | 0.3（01 第 5 节） | 0.3 |

手写便捷层提供：

- `runs.stream(runId)`：异步迭代器，断线后带 `Last-Event-ID` 自动续传，按 `seq` 去重；终态后结束。
- `runs.wait(runId, {timeoutMs})`：基于长轮询，返回终态与 `settlement`。
- `runs.start({agent, model, prompt, ...})`：调用 `POST /runs`，自动生成 UUIDv7 幂等键，网络重试时复用同一个键。
- 权限回调：`onPermission(request) => optionId | "ask-later"`，回调只能返回请求中实际存在的 option ID。
- 错误：problem 对象转为带 `code`、`status`、`requestId` 的类型化异常；`code` 的枚举由 `core` 注册表生成，并保留未知值。
- 重试只发生在幂等请求或带幂等键的请求上，只针对 429 与 503，遵守 `Retry-After`，最多 3 次；其他失败直接抛出。
- 配置更新：`update(resource, patch)` 自动带 `If-Match`；412 时把最新表示交给调用方提供的合并函数，不自动覆盖。
- 功能探测：首次请求读取 `GET /system/info` 的 API 版本与功能开关；调用老守护进程不支持的端点时抛出 `FeatureUnavailable`，而不是让用户面对一个含义不清的 404。

版本策略：两种 SDK 与 `harnesshub` 主包使用同一版本号（[10 第 5 节](10-engineering.md#5-发布工程) 的 changesets fixed 组）。SDK x.y 支持同一大版本内 x.y 与 x.(y−1) 的守护进程，由端到端测试矩阵验证；兼容范围与弃用规则同第 2.7 节。生成代码的新鲜度、类型检查、`examples/` 中 SDK 示例的 smoke 都在每个 PR 运行；Python SDK 另用 mypy strict 检查。其他语言的用户可以直接用 OpenAPI 生成客户端，项目不维护这些客户端。

## 5. CLI

命令树如下（设计示意，不可直接运行）。命名与 01–08 中已出现的命令一致。

```text
hh init                                  首次设置：拉起守护进程、添加 provider 与 Credential、发现 Agent
hh serve [--port 3180] [--data-dir <目录>] [--foreground]
hh status | doctor [agents|providers|platform] | console | version
hh ls [--explain]                        已安装 Agent、当前模型、接线与漂移状态
hh agents show <agent>
hh use <agent> <model-ref> [--set <字段>=<值>]…   计划并应用全局接线
hh wire show|reapply|forget <agent>      管理已有接线（04 第 5 节）
hh unwire <agent> | --all
hh launch <agent> [-- <参数>…]           以 env-launch 方式启动 Agent
hh profile list|save|use|diff|export|import|rm
hh library list|add|show|rm|sync|project add <目录>
hh provider list|presets|add|show|set|set-key|models|doctor|rm
hh credential list|add|rotate|rm
hh model list|show|set|reset
hh group list|add|show|set|rm
hh key list|create|show|rotate|revoke
hh catalog status|refresh
hh usage [--since 7d] [--by agent,model] | export --from --to --format csv|jsonl
hh import <文件> | <链接> | -            导出归档（07 第 3 节）或导入链接（第 8 节），先预览再确认
hh run [--agent <a> | --agents <a,b,…>] --model <ref> [--workspace <路径> | --worktree <仓库> | --temp]
       [--policy <id>] [--timeout <时长>] [--max-tokens N] [--max-cost <金额>] [--verify <命令>]… [--detach] <提示>
hh runs list|show|watch|cancel|explain|diff|apply|export
hh session list|show|suspend|close|logs
hh permission list | decide <permissionId> <optionId>
hh artifact list | get <artifactId> [-o <文件>]
hh workspace list|show|gc
hh eval run|report|regrade               实验性
hh mcp serve | grant | revoke
hh plugin list|add|enable|disable|rm|logs
hh export config|runs                    不含秘密的导出（07 第 3 节）
hh backup | restore <文件>
hh migrate import --from <旧数据目录>
hh gc [--runs-older-than <天数>] [--dry-run]
hh admin-token rotate
hh ci start|stop                         CI 形态的临时实例（07 第 5.6 节）
hh debug bundle|replay
hh completion bash|zsh|fish|powershell
hh self-update [--check] [--channel stable|beta|nightly] [--version X.Y.Z] [--rollback]
                                         校验签名后更新，健康检查失败自动回滚（10 第 5 节）；包管理器安装只打印对应命令
hh migrate up [--confirm-backup]         执行待运行的存储迁移（团队服务器必须显式执行，07 第 2.2 节）
hh restore <文件> [--migration-backup]   从备份或迁移前快照恢复（守护进程须已停止）
hh secrets rekey                         加密文件后端更换主密钥（07 第 4.2 节）
hh credential rm --unreferenced          清理不再被任何 provider 引用的 Credential
hh session reset <session>               丢弃 Session 的后端上下文，保留历史
hh telemetry show|enable|disable|reset-id   匿名统计的状态与同意（07 第 8 节）
hh tls init                              局域网共享的自签证书与指纹（07 第 5.4 节）
hh plugin restart|new|test|index import  插件运维、脚手架与本地索引导入（09 第 4、5 节）
hh audit verify                          团队服务器审计日志哈希链校验（1.x）
hh users list|remove                     团队服务器用户管理（1.x）
                                         另：hh serve --offline 关闭全部外发请求，等价于 HH_OFFLINE=1
```

**输出约定**：默认输出供人阅读，stdout 只放结果，进度、警告与提示写 stderr；终端为 TTY 且未设置 `NO_COLOR` 时才使用颜色；ID 完整显示，不缩写；时间按本地时区显示。`--json` 输出单个 JSON 文档，结构与对应 API 响应相同，因而受 [10 第 5 节](10-engineering.md#5-发布工程) 的兼容承诺约束；流式命令（`hh runs watch`、`hh run` 未加 `--detach` 时）输出 NDJSON，每行一个事件信封，最后一行是终态。加 `--json` 时错误以 problem 对象写到 stdout，同时在 stderr 写一行人读说明。列表命令支持 `--limit` 与 `--all`（按游标取完）。人读输出的语言为 en 或 zh，按 `--lang`、`HH_LANG`、`LC_ALL`、`LANG` 的顺序决定；`--json` 与错误码不随语言变化。

**退出码**：

| 码 | 含义 |
|---|---|
| 0 | 成功；对 `hh run`，所有目标都是 `completed`，且 `verify` 全部通过（如有） |
| 1 | 未分类的内部错误 |
| 2 | 用法错误：未知命令或参数、名称不存在（列出候选）、参数校验失败 |
| 3 | 守护进程不可用：无法连接，且未能或被禁止自动拉起（`--no-start`、`HH_NO_AUTOSTART=1`） |
| 4 | 需要确认，但处于非交互模式且没有 `--yes`；没有写入任何内容 |
| 5 | 冲突或前置条件失败：409、412、422（如计划已过期、幂等键被复用） |
| 6 | 认证或授权失败：401、403 |
| 7 | 达到上限或服务未就绪：429、503 |
| 10、11、12、13 | Run 终态分别为 `failed`、`timed_out`、`cancelled`、`interrupted` |
| 20 | 执行完成但检查未通过：`verify` 失败、`hh eval` 中有未通过的 attempt、`hh doctor` 有失败项 |
| 130 | 用户中断（SIGINT） |

多目标的 `hh run` 按 13、10、11、12、20 的优先级，取各目标结果中优先级最高的码。前台 `hh run` 第一次 Ctrl-C 发送取消请求并等待终态，第二次 Ctrl-C 立即以 130 退出，Run 在服务端继续收敛；`--detach` 在 Run 被接收后打印 ID 并以 0 退出。

**确认与 `--yes`**：改写用户文件或删除数据的命令（`use`、`unwire`、`wire reapply`、`profile use`、`library sync`、`runs apply`、`workspace gc`、`import`、`restore`、`gc`、`credential rm`、`key revoke`、`admin-token rotate`）先显示计划或差异，再询问 `[y/N]`，默认是否。`--yes` 跳过询问但仍打印计划；`--dry-run` 只打印计划，以 0 退出。

**非交互模式**：stdin 不是 TTY、设置了 `CI`、或指定 `--non-interactive` 时进入非交互模式：从不出现提示；缺少必需输入时以 2 退出；需要确认而没有 `--yes` 时以 4 退出；`hh run` 提交的 Run 为 `interactive: false`（05 第 5.4 节）。秘密从不作为位置参数：`hh provider set-key` 与 `hh credential add` 在 TTY 中以隐藏输入读取，非交互模式必须用 `--from-stdin`、`--from-env <变量名>` 或 `--from-file <路径>`。Magpie 的 `magpie provider add deepseek sk-…`（`main.go` 的用法说明）会把 Key 留在 shell 历史中，这里不提供这种写法。

**名称只做精确匹配**：Agent ID、provider、路由组、Profile 与 Model Ref 都按完整名称精确匹配，不做前缀猜测，也不提供别名。Magpie 在唯一前缀匹配时会自动选中（`internal/agent/agent.go:254-278`）；在脚本与 CI 中静默选错对象比直接报错更糟，所以这里找不到时以 2 退出，并列出最多 5 个候选（编辑距离不超过 2，或以输入为前缀），由用户重新输入。Shell 补全负责减少输入量。

## 6. Web 控制台

控制台是 React + Vite 构建的静态单页，内嵌在守护进程中（ADR-P10），只通过 `@harnesshub/sdk` 调用 API；现有组件（shadcn/ui、assistant-ui、AI Elements、Streamdown）按 [packages/console/README.md](../../../packages/console/README.md) 的来源与许可迁移复用。全局元素：顶部状态条（守护进程、网关地址、存储与构建身份）；待决权限收件箱（任何页面都能处理）；命令面板（`Ctrl/⌘+K`）；未隔离或证据强度为 `observed` 时的持续标识。

| 页面 | 核心内容 | 主要 API |
|---|---|---|
| Overview | 首次设置清单（添加 provider、接线第一个 Agent、看到第一次调用，对应 01 旅程 1）；漂移与失败告警；进行中的 Run 与待决权限；今日调用数、token 与成本（标明已知与未知价格的占比） | `system/info`、`agents`、`runs`、`usage`、`events` |
| Agents | Agent 列表：安装状态、版本、当前模型、接线模式、漂移、最近一次网关请求；详情抽屉：配置文件位置、接线计划差异预览与确认、还原、备份、一致性级别、原生会话只读列表；Profile 页签：保存、切换（总预览）、对比 | `agents`、`wirings`、`profiles` |
| Providers 与 Models | provider 列表：类型、端点、Credential 状态、熔断状态、最近体检结果；从预设或自定义添加；Credential 只显示掩码；模型目录表：窗口、输出上限、模态、价格，每个值显示来源与时间；覆盖编辑；体检报告与建议命令 | `providers`、`credentials`、`models`、`catalog` |
| Routing | 路由组：成员顺序（用上移、下移按钮完成，拖拽只是附加方式）、策略、粘性、重试；实时路由决定与熔断状态；Gateway Key 页签：作用域、模型白名单、额度、过期、来源、吊销 | `route-groups`、`gateway-keys` |
| Usage | 按 Agent、模型、provider、Key、Session 的趋势图，每张图都有等价的数据表；`model.call` 账本：过滤、详情（逐次尝试的时间线、补丁、served model）；成本来源标注（上游自报、预设、models.dev、未知）；导出 | `usage`、`model-calls` |
| Runs | Run 列表与过滤；新建 Run（单个或比较批次）；Run 详情：对话流、工具卡片、权限请求、结算面板（三个结算面、命中规则、证据链接）、diff 查看器、产物、本 Run 的调用、诊断日志；比较批次的对照表；评测页签（实验性） | `runs`、`events`、`permissions`、`artifacts`、`evals` |
| Library | Skills、MCP 服务与指令集；版本历史；同步到各 Agent 的计划预览；项目级放置 | `library` |
| Settings | 语言与主题；权限策略编辑与预设；隔离能力报告；令牌（管理令牌与委派令牌）；局域网共享；插件；数据保留、回收、导出与恢复；遥测（默认关闭）；关于（构建身份与许可证） | `system`、`permissions/policies`、`plugins` |

**可访问性（WCAG 2.2 AA）**：全部功能可以只用键盘完成，焦点可见且不被粘性头部或抽屉遮挡（2.4.7、2.4.11）；点击目标不小于 24×24 CSS 像素（2.5.8）；文字对比度不低于 4.5:1，图形与控件边界不低于 3:1；状态同时用图标与文字表达，不只靠颜色；任何拖拽都有单指针替代（2.5.7）；登录使用一次性链接，不要求记忆或转写（3.3.8）；Run 的流式正文不逐 token 播报，而是在每条消息完成时通过 `aria-live="polite"` 通知，状态变化合并后每 2 秒最多播报一次；diff 查看器提供表格模式；尊重 `prefers-reduced-motion`。自动检查沿用 [10 第 3.6 节](10-engineering.md#36-控制台浏览器测试)：Playwright 在真实守护进程上运行，每页用 axe-core 检查，不允许 serious 与 critical 问题，覆盖 1440 与 390 两种视口、英文与中文、深色模式与 reduced-motion。每个次版本发布前，再用 VoiceOver 与 NVDA 走一遍 01 的旅程 1–3 并记录结果；自动检查通过不等于符合 WCAG。

**国际化（en 与 zh）**：英文是源语言，中文为 `zh-CN`。文案使用固定不变的消息 ID 加 ICU MessageFormat（FormatJS），不以英文原文作键；Magpie 的 `internal/gui/assets/i18n.js` 以英文原文作键并回退到英文，英文一改动翻译就静默失效，这里不采用。CI 检查：两种语言的消息 ID 集合一致、ICU 语法有效、没有未使用的 ID；伪本地化构建用于发现截断与硬编码文本。日期、数字、货币一律用 `Intl` 格式化。语言按“用户设置 → 浏览器语言 → en”的顺序决定。错误按 `code` 映射到本地化文字，API 返回的英文 `detail` 放在可展开的技术详情中。

## 7. 桌面托盘（1.x）

托盘是 Tauri 2 薄外壳（`apps/tray`），不包含业务逻辑，所有操作都调用守护进程的 `/api/v1`；守护进程未运行时可以拉起它。功能：显示守护进程与网关状态；列出已接线 Agent 的当前模型（最多 8 个，其余进入控制台）；切换 Profile（弹出小窗显示总预览，确认后应用）；待决权限与 Run 结束的系统通知，点击直接打开控制台对应页面；打开控制台（走第 1 节的一次性登录码流程）；登录时自动启动。托盘读取 `<数据根>/admin.token`，权限与 CLI 相同。平台：macOS 菜单栏、Windows 通知区域、Linux AppIndicator；部分 GNOME 桌面需要扩展才能显示托盘图标，文档中如实说明。托盘不注册系统 URL scheme，导入链接仍走第 8 节的粘贴流程，提供“从剪贴板导入”菜单项。托盘与 `hh` 分开签名发布，安装包体积目标不超过 15 MB，由发布流水线测量。

## 8. 导入链接

导入链接让厂商、中转服务或同事把一份 provider 或 MCP 服务配置交给用户。1.0 不注册系统 URL scheme（01 第 4 节），链接只是可以粘贴的文本，有两种形式：

- 文本形式：`harnesshub://import?v=1&kind=provider&preset=deepseek`，由 `hh import <链接>`、`hh import -`（从 stdin 读取）或控制台的“粘贴链接”识别。
- 网页形式：`https://harnesshub.dev/import#v=1&kind=provider&preset=deepseek`（域名在 M0 确定）。参数放在片段中，浏览器不会把它发给服务器；页面完全在本地解析，显示预览并给出可复制的 `hh import` 命令，不直接调用本机守护进程。

| 参数 | 适用 | 规则 |
|---|---|---|
| `v` | 全部 | 必填，当前为 `1`；更高版本提示升级，不尝试解析 |
| `kind` | 全部 | `provider` 或 `mcp`；其他值拒绝 |
| `preset`、`region` | provider | 使用内置预设与其区域；预设不存在时拒绝 |
| `id`、`name` | provider、mcp | `id` 为 slug，缺省时由 `name` 生成；保留字 `hh`、`harnesshub`、`group` 拒绝；`name` 最长 80 字符 |
| `chat`、`responses`、`anthropic`、`gemini` | provider | 端点基址，规则同 [03 第 4 节](03-model-plane.md#4-provider-与-credential)：HTTPS，回环与 RFC 1918 私网地址可用 HTTP 并显示警告；不允许账号、查询串与片段；以 `/chat/completions` 等结尾时拒绝 |
| `models` | provider | 逗号分隔的 Model 名称，最多 200 个 |
| `catalog`、`website`、`keys` | provider | models.dev 的 provider id；官网与 Key 申请页只接受 HTTPS，只以文本显示，不自动打开 |
| `key` | provider | 可选；最长 4096 字符，不含控制字符；只在确认后写入系统密钥库 |
| `url`、`transport` | mcp | 只接受远程 MCP（`transport=http`，即 Streamable HTTP）；链接不能导入 stdio 命令，因为那等于让链接在本机执行任意程序 |

**预览与确认**：`POST /api/v1/system/import-links` 把解析结果保存在守护进程内存中，返回一次性的 `previewId`（10 分钟有效，读取一次后失效，做法同 Magpie `internal/gui/importlink.go` 的暂存与读后删除）。预览列出：将新建还是替换（替换需要额外确认，并显示与现有配置的差异）；每个端点及其协议；链接是否带 Key（只显示后 4 位）；模型数量；全部警告。确认之前不写入任何内容。导入只创建或替换这一个 provider 或 MCP 条目：不签发 Gateway Key，不改接线、默认模型或路由组，不启用插件。

**安全限制**：链接最长 8 KiB；参数名必须属于上表，出现未知参数或重复参数时整体拒绝并列出问题；不发起任何远程请求，Magpie 支持的 `icon` 参数会被忽略并提示，图标只来自内置预设；含 `key=` 的链接在日志与事件中一律脱敏；CLI 无法清除 shell 历史，因此在 TTY 中发现命令参数里带 Key 时提示改用 `hh import -`；控制台的预览接口要求控制台会话，并受 07 第 5.3 节的 Origin 与 `Sec-Fetch-Site` 校验。

**实现**（2026-10-04，[ADR 0023](../../decisions/0023-provider-presets-and-imports.md)）：接口为 `POST /api/v1/import/preview` 与 `POST /api/v1/import/apply`（保留一次性 `previewId`），`v` 与 `kind` 可省略，并支持从 Claude Code 与 Codex 导入；行为以 [导入 provider](../../provider-import.md) 为准。

**Magpie 兼容**：`hh import` 也接受 `magpie://import?…`，按 `yetone/magpie@d874adb` 的 `internal/provider/importurl.go` 映射 `preset`、`region`、`name`、`id`、`key`、`chat`、`responses`、`anthropic`、`models`、`catalog`、`website`、`keys`，并补上 `v=1&kind=provider`；之后执行与原生链接相同的校验与预览。Magpie 的格式变化不会自动跟进，映射表随 Magpie 的固定版本更新并有测试。
