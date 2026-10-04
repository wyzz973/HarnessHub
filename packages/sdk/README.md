# @harnesshub/sdk

守护进程 `/api/v1` 的 TypeScript 客户端，只依赖 `@harnesshub/core`，是 `cli` 与控制台调用 API 的唯一途径（[02 第 8 节](../../docs/proposals/oss/02-architecture.md#8-模块与依赖规则)、[06 第 4 节](../../docs/proposals/oss/06-interfaces.md#4-sdk)）。

- [client.ts](src/client.ts)（`@harnesshub/sdk/client`）：`HarnessHubClient` 基于 `fetch`，可直接连接守护进程，也可经路径以 `/` 结尾的基址（请求发到 `<基址>api/v1/...`）。凭据二选一：`token` 是本机管理令牌，以 `Authorization: Bearer` 发送；守护进程提供的控制台页面不持有令牌，改用控制台会话：浏览器自动携带 HttpOnly 的 `hh_console` Cookie，`csrfToken` 选项以 `X-HH-CSRF` 头发送会话的 CSRF 值。`auth` 提供 `createConsoleLink`（需管理令牌）、`createConsoleSession(code)`、`currentConsoleSession` 与 `deleteConsoleSession`（07 第 5.2 节）；它同时再导出所需的记录类型，使用方不必依赖其他包。提供 `system`、`providers`（含 `models(id)`：各模型元数据及来源）、`presets`、`credentials`、`models`（`get`、`getOverride`、`setOverride`、`removeOverride`，Model Ref 中的斜杠按 `%2F` 编码）、`catalog`、`routeGroups`、`gatewayKeys`、`modelCalls` 与 `usage`，类型取自 `@harnesshub/core/model-plane` 与 `@harnesshub/core/model-metadata`。错误响应变为带 `status`、`code`、`requestId` 与原 problem 对象的 `HarnessHubError`，连接失败为 `HarnessHubUnavailableError`；不做重试。
- [local.ts](src/local.ts)（`@harnesshub/sdk/local`，仅 Node）：`readAdminToken(dataDir)` 读取并校验 `<dataDir>/admin.token`（普通文件、POSIX 上本用户 0600），`connectLocal({dataDir, url, token})` 用它或显式令牌创建客户端，默认地址 `http://127.0.0.1:3180`。

类型目前手写；06 第 4 节的 OpenAPI 生成、SSE 与 Run 便捷层随执行 API 迁到 `/api/v1` 时加入。用法见 [模型平面 API 与 CLI](../../docs/model-plane-api.md)。
