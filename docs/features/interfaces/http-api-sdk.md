# HTTP API 与 SDK

| 项 | 内容 |
|---|---|
| 分类 | 界面与入口 |
| 状态 | 已实现 |
| 验证 | 集成测试经 SDK 对进程内守护进程验证认证、校验、错误格式与凭据值不外泄；SDK 单元测试；工具组验证 API 文档检查的拒绝样例；`pnpm check:api` 在 `pnpm check` 中检查生成文件新鲜度；模型协议由协议套件（官方 SDK 客户端）覆盖；均在 macOS arm64 本机通过；Windows 未验证 |
| 对照 Magpie | 部分：同一端口上的模型协议一行相同（[Gateway and protocols](../../magpie-parity.md#gateway-and-protocols) 第一行）；`/api/v1` 管理接口与 SDK 在对照表中没有对应行 |
| 权威文档 | [模型平面 API 与 CLI](../../model-plane-api.md#认证与错误)、[HTTP API 入口](../../api/README.md)、[API 实现参考](../../api/reference.md)、[SDK](../../../packages/sdk/README.md)、[共享网关](../../model-gateway.md#共享网关) |

## 用途

让脚本、CLI 与控制台以同一套 HTTP 接口管理守护进程，并让 Agent 与 SDK 客户端在同一端口调用模型。`@harnesshub/sdk` 是这套管理接口的 TypeScript 客户端，`hh` 与控制台都经它访问 `/api/v1`。

## 入口

| 入口 | 用法 |
|---|---|
| HTTP | 管理：`/api/v1/*`（106 个操作）；旧执行与配置接口：`/v1/*`（46 个操作）；健康与契约：`GET /health/live`、`GET /health/ready`、`GET /openapi.json`；模型协议：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1beta/models/…`、`/v1/models` 等 |
| 命令行 | `pnpm docs:api` 重新生成参考与 OpenAPI JSON；`pnpm check:api` 检查覆盖与新鲜度 |
| SDK | `@harnesshub/sdk/client` 的 `HarnessHubClient`；Node 中用 `@harnesshub/sdk/local` 的 `connectLocal({dataDir, url})` |

## 已实现的能力

- `/api/v1`：只接受回环连接；凭据为本机管理令牌（`Authorization: Bearer`）或控制台会话（Cookie 加 `X-HH-CSRF`），都没有时 401 `ADMIN_TOKEN_REQUIRED`；`Sec-Fetch-Site` 存在时必须是 `same-origin`。
- `/api/v1` 的 POST、PUT、PATCH 必须是 JSON（PATCH 也接受 `application/merge-patch+json`），否则 415；请求中的未知字段 400。
- `/api/v1` 的错误一律是 RFC 9457 `application/problem+json`，带 `code` 与 `requestId`，输入错误另有指向请求体成员或查询参数的 `errors[]`，被引用而不能删除时另有 `references[]`；金额是十进制字符串加币种，时间是 RFC 3339。
- 旧 `/v1/*`（引擎、会话、Run、权限、事件 SSE、产物、工作流、观测、工具包、统一模型）保持原格式 `{"error":{"code","message"}}`，不要求凭据，只校验回环 Host 与同源 Origin；请求体上限 2 MiB。
- 模型协议（Chat Completions、Responses、Anthropic Messages、Gemini）与 `/v1/models`、`/v1/harnesshub/limit` 在 Fastify 之前交给共享网关处理，同一端口，必须带 Gateway Key；分派规则见 [共享网关](../../model-gateway.md#共享网关)。
- OpenAPI：运行中的 `/openapi.json` 给出该进程实际启用的路由；`pnpm docs:api` 启动临时 demo 守护进程，从 [api-catalog.ts](../../../packages/daemon/src/http/api-catalog.ts) 与路由 schema 生成 [reference.md](../../api/reference.md) 与 [openapi.json](../../api/openapi.json)，不调用模型。
- `pnpm check:api` 双向检查路由与目录覆盖、operationId 唯一、源码与测试链接存在、生成文件未过期，已进入 `pnpm check`。
- SDK：基于 `fetch`，可经路径以 `/` 结尾的基址连接；按资源分组（`system`、`auth`、`providers`、`credentials`、`models`、`routeGroups`、`gatewayKeys`、`agents`、`profiles`、`library`、`backup`、`sync`、`modelCalls`、`usage`、`subscriptions` 等）；`modelCalls` 与 `usage` 的 `csv` 返回响应体的流；错误变为带 `status`、`code`、`requestId` 的 `HarnessHubError`，连接失败为 `HarnessHubUnavailableError`；不做重试。
- SDK 的 `local.ts` 读取并校验 `<dataDir>/admin.token`（POSIX 上要求本用户 0600 的普通文件）；`route-rules.ts` 让控制台用与守护进程相同的代码解析路由规则。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/daemon/src/http/api-v1.ts](../../../packages/daemon/src/http/api-v1.ts)、[packages/daemon/src/http/server.ts](../../../packages/daemon/src/http/server.ts)、[packages/daemon/src/http/openapi.ts](../../../packages/daemon/src/http/openapi.ts)、[packages/daemon/src/http/model-gateway-mount.ts](../../../packages/daemon/src/http/model-gateway-mount.ts)、[packages/sdk/src/client.ts](../../../packages/sdk/src/client.ts)、[packages/sdk/src/local.ts](../../../packages/sdk/src/local.ts)、[tools/generate-api-docs.mjs](../../../tools/generate-api-docs.mjs) |
| 测试 | [tests/integration/api-v1.test.ts](../../../tests/integration/api-v1.test.ts)、[packages/sdk/test/client.test.ts](../../../packages/sdk/test/client.test.ts)、[packages/daemon/test/openapi.test.ts](../../../packages/daemon/test/openapi.test.ts)、[tools/check-api-docs.test.mjs](../../../tools/check-api-docs.test.mjs)、[conformance/protocols](../../../conformance/README.md) |
| 决策 | [ADR 0024](../../decisions/0024-embedded-console.md)（会话与旧 `/v1` 的保留）、[文档规范：HTTP 文档同步](../../documentation.md#http文档同步) |

## 已知限制与未验证

- `/api/v1` 尚未实现 ETag 与 `If-Match`、`Idempotency-Key`、`hh admin-token rotate`，配置列表（provider、凭据、路由组、Key）一次返回全部，`nextCursor` 为 `null`。
- 执行平面（会话、Run、SSE、产物、工作流）仍在旧 `/v1/*`，没有凭据要求，也不在 SDK 中；SDK 没有 SSE 与 Run 便捷层。
- SDK 的类型手写，不由 OpenAPI 生成；包标为 `private`，没有发布到 npm。
- 模型协议路径不在生成的参考与 OpenAPI 中（它们不经 Fastify）。
- 生成的参考页头注释仍指向不存在的 `src/gateway/api-catalog.ts`。
- Windows 上未运行过这些测试。

## 优化候选

- **现状**：执行 API 在旧 `/v1/*`，没有凭据要求，SDK 不覆盖。**方向**：迁到 `/api/v1`，统一 problem 错误与会话保护，SDK 增加 Run 与 SSE 便捷层。**依据**：[ADR 0024](../../decisions/0024-embedded-console.md) 决定 4、[SDK](../../../packages/sdk/README.md) 末段。
- **现状**：没有 ETag、`If-Match`、`Idempotency-Key` 与配置列表分页。**方向**：按 06 第 2.4、2.5 节实现，先覆盖会被并发修改的 provider 与路由组。**依据**：[模型平面 API 与 CLI](../../model-plane-api.md#认证与错误)“尚未实现”。
- **现状**：SDK 类型手写且未发布。**方向**：从 OpenAPI 生成类型并与手写类型做等价检查，随 M1 发布 `@harnesshub/sdk`。**依据**：[06 第 4 节](../../proposals/oss/06-interfaces.md#4-sdk)、[TODO 所有者事项](../../../TODO.md#需要所有者处理的事项) 的 npm 注册。
- **现状**：生成的参考页头注释指向不存在的路径。**方向**：修正 [generate-api-docs.mjs](../../../tools/generate-api-docs.mjs) 写出的注释。**依据**：阅读文档与生成器的观察。
