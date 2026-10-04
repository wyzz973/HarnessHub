# Provider 预设

每个文件 `<id>.json` 描述一个模型厂商、中转网关或本机服务（[03 第 4 节](../../../docs/proposals/oss/03-model-plane.md#4-provider-与-credential)），`POST /api/v1/providers` 的 `preset`（加 `region`、`plan`）、`hh provider add --preset`、导入链接与控制台的“从预设”用它创建 provider。用户如何选择预设、地域与套餐见 [Provider 预设](../../../docs/provider-presets.md)。

格式由 [`@harnesshub/core/provider-presets`](../../core/src/provider-presets.ts) 的 `providerPresetSchema` 定义，加载器是 [src/presets.ts](../src/presets.ts)。每个文件先按 JSON Schema 校验，再检查：文件名与 `id` 一致；顶层、每个地域与每个套餐的端点符合基址约定（`endpointProblem`）；地域、套餐、Magpie ID 与 header 名称各自不重复；`magpie` 指向的地域与套餐存在；顶层 `endpoints` 等于第一个地域与第一个套餐组合出的端点；每个“地域 × 套餐”组合都能展开为有效的 provider。所有文件之间，一个 Magpie ID 只能属于一个预设。任何一项不满足都会让加载失败。[provider-presets.test.ts](../../../tests/unit/provider-presets.test.ts) 校验全部文件与全部组合，并对每条规则给出无效样例；[model-metadata.test.ts](../../../tests/unit/model-metadata.test.ts) 检查预设、地域与套餐的 `catalog` 都在内置快照中。单可执行文件把本目录的 `*.json` 与 `magpie.LICENSE` 作为资源解出到同一相对路径（`tools/sea/build.mjs` 的 `presetAssets`）。

## 字段

- `kind`：`vendor`（模型厂商自己）、`relay`（中转与聚合）、`local`（本机服务）；`hh provider presets` 按它分组。
- `icon`：[lobehub icons](https://github.com/lobehub/lobe-icons) 的图标名（如 `deepseek-color`），供界面显示，取自 Magpie。
- `endpoints`：厂商官方 SDK 使用的基址。chat 与 responses 通常含版本段（如 `https://api.openai.com/v1`，网关追加 `/chat/completions`、`/responses`）；anthropic 不含 `/v1`（网关追加 `/v1/messages`）；gemini 不含版本段（网关追加 `/v1beta/models/…`）。本机服务可以用 `http://127.0.0.1`。有地域或套餐时，它们是默认组合的端点。
- `regions`：同一 API 的不同站点或云区域（中国站与国际站、Bedrock 的 AWS 区域），至少两个，第一个是默认值。每个地域给出完整的 `endpoints`（没有列出的协议在该地域不提供），可以另给 `keysUrl`、`catalog` 与 `notes`。
- `plans`：厂商单独售卖、通常各用各的 Key 的产品（Coding Plan、企业版、按量付费），至少两个，第一个是默认值。`endpoints` 给出时整体替换地域的端点；`models` 是该套餐提供的模型 ID；`modelSource` 替换 `models.source`（如按量付费有模型列表接口而套餐没有）；也可以另给 `keysUrl`、`catalog` 与 `notes`。
- 组合规则：端点依次取套餐、地域、预设的；`keysUrl` 与 `catalog` 同样；初始模型列表依次取套餐的 `models`、`models.list`、`fallbackModels`。创建的 provider 记录 `preset`、`region` 与 `plan`，模型元数据按该组合的 `catalog` 补齐；之后的预设版本删除了记录中的地域或套餐时，按默认组合读取，已保存的 provider 不会因此无效。
- `auth.apiKeyHeader`：Key 的发送方式；`auth.methods` 为 `["api-key"]`，本机服务为 `["none"]`（可选 Key 时两者都列）。一个 provider 只有一种 Key 发送方式。厂商的不同端点要求不同方式时（如 Gemini 的原生端点用 `x-goog-api-key`、OpenAI 兼容端点用 Bearer），预设只收录与认证方式一致的端点，其余写在 `notes` 中或另设一个预设（`gemini` 与 `gemini-openai`）。
- `userEndpoint`：为 `true` 时基址由用户提供（Azure 的资源地址、另一台机器上的网关）；`endpoints` 只表示形状，创建 provider 时必须给出端点（`--base` 或 `--chat` 等），否则 400 `PROVIDER_INVALID`。
- `headerHints`：厂商文档列出、由用户填写的请求头（`name`、`required`、`notes`）。`required: true` 的 header 必须出现在 provider 的 `headers` 中，否则创建失败；携带 Key 的头（`Authorization`、`x-api-key`、`api-key`、`x-goog-api-key`）不能出现在这里。
- `models.source`：优先 `live`，由 `POST /api/v1/providers/{id}/models/refresh` 从上游列出；没有列表接口时用 `static`。列表中模型的窗口、价格等值的来源记为“预设”，`verified` 为其时间。
- `fallbackModels`：模型 ID 列表，用于没有列表接口的厂商，或列表不含套餐模型的中转；新 provider 以它们开始，刷新失败时保留。
- `catalog`：该厂商在 [models.dev 目录快照](../catalog/README.md) 中的 provider id，用于补齐模型的窗口、输出上限与价格；必须在内置快照中存在。本机服务不写。
- `verified`：对照厂商官方文档核对端点基址与 Key 的发送方式的日期（`YYYY-MM-DD`），没有核对时写 `unverified`；`website`、`keysUrl`、`notes` 中的链接与 `fallbackModels` 只是方便，不在核对范围内。修改端点时同步更新它。一个预设有多个地域或套餐时，日期表示全部组合都已核对。
- `source`：数据不是直接取自厂商时的出处，形如 `<项目>@<提交>`。含有取自 [Magpie](https://github.com/yetone/magpie)（MIT，见 [magpie.LICENSE](magpie.LICENSE)）的预设、地域、套餐、图标或 header 提示的文件写 `magpie@2e340f7`；这些数据的端点按本页的基址约定换算，未重新核对的标为 `unverified`。
- `magpie`：Magpie 导入链接（`magpie://import?preset=…&region=…`）中哪些 Magpie 预设 ID 指向本预设，以及各自隐含的地域或套餐；不写时 Magpie 用本预设的 ID。Magpie 把中国站另设为 `-cn` 预设，这里合并为地域，例如 `moonshot` 的 `[{"id":"moonshot","region":"global"},{"id":"moonshot-cn","region":"cn"}]`。
- `notes`：展示给用户的简短说明，例如 Key 不通用的站点或需要修改端点的本机服务。

## 来源与核对

- 2026-10-04 以 Magpie 2e340f7 的 `internal/provider/presets.go` 补齐到 46 个预设（25 个 vendor、18 个 relay、3 个 local），合计 76 个“地域 × 套餐”组合。Magpie 的 51 个预设中 48 个有对应：`moonshot-cn`、`kimi-code-cn`、`minimax-cn`、`qwen-cn`、`tencent-tokenhub-cn` 合并为地域，`qwen` 对应 `dashscope`，`google` 对应 `gemini-openai`，`remote-magpie` 对应 `magpie-remote`。另外 3 个是决策 API（`typesafe`、`vercel-jev`、`cloudflare-jev`），它们只为路由组挑选模型、不提供对话，HarnessHub 没有这类 provider，未收录。原有 15 个预设保留各自的端点与核对日期，只加入地域、套餐、图标与 header 提示。
- 同日核对并标注日期的：`gemini-openai`（Google 的 OpenAI 兼容文档）、`minimax`（国际站与中国站文档；中国站域名已改为 `api.minimax.cn`，与 Magpie 不同）、`bedrock`（AWS 的 Chat Completions 文档：`bedrock-runtime` 的 `/openai/v1`，Bedrock API Key 以 Bearer 发送，没有 `/models`）、`anthropic` 的 `anthropic-workspace-id`、`openrouter` 的署名 header（OpenRouter 的 App Attribution 文档）、`magpie-remote`（Magpie 源码 `remote_magpie.go`）。其余新预设为 `unverified`。
- 未收录：Google Vertex AI 需要 OAuth 访问令牌，Bedrock 的 SigV4 签名不受支持（Bedrock 预设只用 Bedrock API Key）。Bedrock 上的 Claude 只经 Anthropic Messages 端点提供，Magpie 对它只发 `x-api-key`，与本预设的 Bearer 不同，需要时另建 provider。

添加预设只需新增一个文件，并在提交说明中给出核对所依据的官方文档链接。
