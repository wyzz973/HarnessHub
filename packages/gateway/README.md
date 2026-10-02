# @harnesshub/gateway

模型平面：每个 Session 私有的回环模型网关（ADR 0013）。它把引擎发来的 Chat Completions、Responses、Anthropic Messages 与 Google generateContent 请求转换为上游 Chat Completions，规范化参数、回填推理文本、施加限额，并为每次调用产生一条 `ModelCallRecord`。内容即原 `src/drivers/chat-completions`，在 OSS-004 第 5 步平铺迁入 `src/`；行为与限额见 [模型网关](../../docs/model-gateway.md)。只依赖 `@harnesshub/core`。

网关与配置准备之间的契约（`ModelGateway`、`ModelGatewayOptions`、`ModelCallRecord`、`InboundProtocol`）在 `@harnesshub/core/model-bridge`。配置准备不导入本包：Worker 与组合根把 [gateway.ts](src/gateway.ts) 的 `startModelGateway` 经 `PreparationHooks.startModelGateway` 注入，需要路由而未注入时准备失败并报 `MODEL_GATEWAY_NOT_INJECTED`，见 [ADR 0017](../../docs/decisions/0017-package-layout-migration.md)。
