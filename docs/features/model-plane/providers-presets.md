# Provider 与预设

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 单元测试校验全部 46 个预设与 76 个“地域 × 套餐”组合（每条格式规则有无效样例）；经守护进程的集成测试覆盖从预设创建、地域与套餐、元数据补齐、provider 与凭据开关（严格假上游），网关单元测试覆盖补丁；20 个预设核对过官方文档，26 个标为 `unverified`；真实 provider 只跑过 `deepseek` 预设；Windows 未验证 |
| 对照 Magpie | 有意不同：预设数与 `-cn` 站点合并为地域、地域与套餐分开；相同：header 提示、自填端点、本机服务不需要 Key；部分：图标、provider 开关与改名、`wire` 名；决策 API 未覆盖（[Providers, presets and import](../../magpie-parity.md#providers-presets-and-import)、[Routing](../../magpie-parity.md#routing-route-groups-and-rules) 的决策 API 一行） |
| 权威文档 | [Provider 预设](../../provider-presets.md)、[presets 目录说明](../../../packages/gateway/presets/README.md)、[模型平面 API 的资源表](../../model-plane-api.md#资源)、[直通与转换](../../model-gateway.md#直通与转换)（补丁） |

## 用途

添加一个模型上游：从预设中选厂商或中转、地域与套餐并给出 Key，端点、Key 的发送方式、模型列表来源与目录 ID 都由预设提供；预设里没有的上游（本机 vLLM、公司网关）手工填写端点。之后可以停用、编辑或删除 provider，并为不兼容的上游声明请求补丁。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Provider › 添加 provider › 从预设（可搜索，选区域与套餐，填写预设列出的请求头）或手动填写；列表与详情页的启用开关；编辑对话框（端点、图像端点、代理、每个凭据的并发、模型与公开范围） |
| 命令行 | `hh provider presets [--json]`；`hh provider add [<id>] --preset P [--region R] [--plan P] [--base URL]`；`hh provider add <id> --chat URL [--responses URL] [--anthropic URL] [--gemini URL] [--kind K] [--api-key-header H] [--model ID]…`；`hh provider list`、`show`、`disable`、`enable`、`remove` |
| HTTP | `GET /api/v1/presets`；`GET`、`POST /api/v1/providers`；`GET`、`PATCH`（JSON Merge Patch）、`DELETE /api/v1/providers/{id}` |

## 已实现的能力

- 46 个预设：25 个厂商、18 个中转、3 个本机服务，合计 76 个“地域 × 套餐”组合；每个预设给出各协议端点、Key 的发送方式、模型列表来源、获取 Key 的页面、models.dev 目录 ID、核对日期与数据出处。预设随版本发布，不在运行时下载。
- 地域（同一 API 的不同站点，如 Moonshot 的 `cn` 与 `global`）与套餐（单独售卖的产品，如智谱的 `coding`）分开选择，第一个为默认；不存在的地域或套餐以退出码 2 失败并列出可选值。provider 记录所选组合，元数据按该组合的目录 ID 补齐。
- `--base URL` 把所选组合的每个端点路径接到自己的地址之后；`userEndpoint` 预设（Azure、`harnesshub-remote`、`magpie-remote`）必须给出地址，否则 400 `PROVIDER_INVALID`；显式的 `--chat` 等端点优先。
- 套餐带模型列表时新 provider 以它开始；添加时不请求上游，第一次 `hh provider models <id> --refresh` 之前显示“not refreshed yet”。
- header 提示：预设列出厂商文档中由用户填写的请求头（`anthropic-workspace-id`、OpenRouter 的 `HTTP-Referer` 与 `X-OpenRouter-Title`），标为 `required` 的缺少时创建失败；携带 Key 的头不能出现在提示中。目前的预设没有必填的 header。
- 手工 provider：每个协议一个基址（chat、responses、anthropic、gemini，按厂商官方 SDK 的约定：前两者含 `/v1`，后两者不含版本段）；Key 的发送方式为 `authorization-bearer`、`x-api-key`、`api-key`、`x-goog-api-key`、`query-key` 或 `custom:<header>`；类型为 vendor、relay、local 或 custom。基址须为 HTTPS（回环与 RFC 1918 地址可用 HTTP），不能含凭据、查询串、片段或操作路径。
- 停用与启用：`enabled: false` 的 provider 保留配置、凭据与接到它模型上的 Agent，但没有路由候选（400 `unsupported_route`），不出现在 `/v1/models`、自动路由组、裸名称与接线目录中，路由组跳过它；接到它模型上的 Agent 标为 `AGENT_MODEL_UNAVAILABLE`。重新启用时清除其凭据的休息与模型标记。控制台停用前先确认。
- 删除：被路由组或未吊销的 Key 引用时 409；删除 provider 时一并删除它的托管秘密。
- 请求补丁：按端点声明的闭集（`developer-to-system`、`max-tokens-field`、`drop-fields`、`include-usage`、`json-schema-to-json-object`、`merge-system-messages`、`anthropic-beta-allow`、`anthropic-strip-beta-fields` 等 10 个名字）；`drop-fields` 只能去掉 10 个可选字段（`store`、`metadata`、`service_tier`、`stream_options`、`parallel_tool_calls` 等）。生效的补丁写入账本 `patches[]`；各家 Anthropic 兼容 API 的预设声明 `anthropic-strip-beta-fields`。
- 其他设置：`wire`（上游模型名，可用 `*` 模式）、`translateOnly`（从不直通）、`capabilities.requiresReasoningReplay`、`imageEndpoint`（`--image-endpoint`，见 [图像生成](../../gateway-features.md#图像生成)）、`proxy`（见 [出站代理与网络](outbound-network.md)）、`limits`（见 [凭据](credentials.md)）。
- `harnesshub-remote` 预设把另一台开启了局域网共享的 HarnessHub 当作 provider（[另一台 HarnessHub 作为上游](../../model-gateway.md#另一台-harnesshub-作为上游)）。
- 连不上守护进程时，`hh provider presets` 列出 `hh` 自带的同一份预设并在标准错误说明原因。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [presets 目录](../../../packages/gateway/presets/README.md)、加载器 [presets.ts](../../../packages/gateway/src/presets.ts)、格式 [provider-presets.ts](../../../packages/core/src/provider-presets.ts)、provider 记录与基址校验 [model-plane-records.ts](../../../packages/core/src/model-plane-records.ts)、类型 [model-plane.ts](../../../packages/core/src/model-plane.ts)、路由 [model-plane-routes.ts](../../../packages/daemon/src/http/model-plane-routes.ts)、补丁 [passthrough.ts](../../../packages/gateway/src/passthrough.ts)、控制台 [providers-page.tsx](../../../packages/console/components/providers-page.tsx) 与 [preset-pane.tsx](../../../packages/console/components/preset-pane.tsx) |
| 测试 | [provider-presets.test.ts（单元）](../../../tests/unit/provider-presets.test.ts)、[provider-presets.test.ts（集成）](../../../tests/integration/provider-presets.test.ts)、[switches.test.ts](../../../tests/integration/switches.test.ts)、[shared-gateway-patches.test.ts](../../../packages/gateway/test/shared-gateway-patches.test.ts)、[model-plane-records.test.ts](../../../packages/core/test/model-plane-records.test.ts)、[hh-cli.test.ts](../../../tests/integration/hh-cli.test.ts) |
| 决策 | [ADR 0023 预设的地域与套餐，以及 provider 的导入](../../decisions/0023-provider-presets-and-imports.md)、[ADR 0018 编号迁移、模型平面存储与托管秘密](../../decisions/0018-schema-migrations-and-managed-secrets.md) |

## 已知限制与未验证

- 26 个预设的端点取自 Magpie 2e340f7 而未重新核对（`verified: unverified`），添加后需要自己用一次刷新或调用确认。
- 不支持需要 OAuth 或请求签名的接入：Google Vertex AI、Bedrock 的 AWS SigV4；Bedrock 预设只用 Bedrock API Key，Bedrock 上的 Claude 需要另建 provider。订阅账号不是预设（见 [订阅账号](../../subscriptions.md)）。
- 补丁、`wire`、`translateOnly`、`capabilities` 与手工 provider 的请求头没有 `hh` 子命令，控制台表单也不编辑它们，只能经 `PATCH /api/v1/providers/{id}`；补丁另可由体检的 `--fix` 或控制台“检测”的“应用建议的修改”写入。
- `thinking-off-unless-asked` 与 `lift-additional-tools` 在补丁闭集中但未实现，声明它们的候选以 500 `patch_unsupported` 跳过。
- provider 不能改 ID；停用时接到它的 Agent 只被标记，不像 Magpie 那样换到别的模型。自定义 provider 没有图标。
- 手工 provider 的 HTTP 基址只接受回环与 RFC 1918 IPv4（[model-plane-records.ts](../../../packages/core/src/model-plane-records.ts) 的 `localHost`），`100.64.0.0/10`（Tailscale）、IPv6 私有地址、`.local` 与不带点的主机名上的本机服务只能用 HTTPS 添加，而出站策略把这些地址当作私有网络直连（阅读代码的观察）。
- Windows 未验证。

## 优化候选

- **现状**：46 个预设中 26 个 `unverified`。**方向**：持 Key 者逐个用 `hh provider doctor` 或 `pnpm test:real` 核对，写入核对日期。**依据**：[presets 目录说明的来源与核对](../../../packages/gateway/presets/README.md#来源与核对)、[Provider 预设](../../provider-presets.md#列出与选择)。
- **现状**：补丁、`wire` 与手工请求头只能经 API 修改。**方向**：为它们加 `hh provider` 子命令与控制台表单项。**依据**：[对照表](../../magpie-parity.md#providers-presets-and-import) 的 `wire` 行（partial：“No hh command or console editor”）；阅读控制台与 CLI 代码的观察。
- **现状**：两个补丁名在闭集中却没有实现，声明后候选被跳过。**方向**：实现它们，或从闭集与 schema 中移除。**依据**：[直通与转换](../../model-gateway.md#直通与转换)；[passthrough.ts](../../../packages/gateway/src/passthrough.ts) 的 `unsupportedPatches`。
- **现状**：HTTP 基址的“本地地址”判断比出站策略的私有网络窄。**方向**：两处共用同一个私有地址判断。**依据**：阅读代码的观察（`localHost` 与 [出站代理](../../configuration.md#出站代理) 的“不经代理”）。
- **现状**：provider 不能改名，停用时 Agent 不自动换模型。**方向**：支持改 ID 并连同路由组、Agent 接线一起迁移。**依据**：[对照表](../../magpie-parity.md#providers-presets-and-import) 的 provider 开关与改名行（partial）。
