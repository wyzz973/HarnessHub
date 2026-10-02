# @harnesshub/sdk

守护进程 `/api/v1` 的 TypeScript 客户端，只依赖 `@harnesshub/core`，是 `cli` 与控制台调用 API 的唯一途径（[02 第 8 节](../../docs/proposals/oss/02-architecture.md#8-模块与依赖规则)、[06 第 4 节](../../docs/proposals/oss/06-interfaces.md#4-sdk)）。

- [client.ts](src/client.ts)（`@harnesshub/sdk/client`）：`HarnessHubClient` 基于 `fetch`，提供 `system`、`providers`、`credentials`、`routeGroups`、`gatewayKeys`、`modelCalls` 与 `usage`，类型取自 `@harnesshub/core/model-plane`。错误响应变为带 `status`、`code`、`requestId` 与原 problem 对象的 `HarnessHubError`，连接失败为 `HarnessHubUnavailableError`；不做重试。
- [local.ts](src/local.ts)（`@harnesshub/sdk/local`，仅 Node）：`readAdminToken(dataDir)` 读取并校验 `<dataDir>/admin.token`（普通文件、POSIX 上本用户 0600），`connectLocal({dataDir, url, token})` 用它或显式令牌创建客户端，默认地址 `http://127.0.0.1:3180`。

类型目前手写；06 第 4 节的 OpenAPI 生成、SSE 与 Run 便捷层随执行 API 迁到 `/api/v1` 时加入。用法见 [模型平面 API 与 CLI](../../docs/model-plane-api.md)。
