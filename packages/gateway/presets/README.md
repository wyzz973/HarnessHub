# Provider 预设

每个文件 `<id>.json` 描述一个模型厂商、中转网关或本机服务（[03 第 4 节](../../../docs/proposals/oss/03-model-plane.md#4-provider-与-credential)），`POST /api/v1/providers` 的 `preset`、`hh provider add --preset` 与控制台的“从预设”用它创建 provider。格式由 [`@harnesshub/core/provider-presets`](../../core/src/provider-presets.ts) 的 `providerPresetSchema` 定义，加载器是 [src/presets.ts](../src/presets.ts)：每个文件先按 JSON Schema 校验，再检查文件名与 `id` 一致、端点符合基址约定（`endpointProblem`）并能展开为有效的 provider；任何一个文件无效都会让加载失败。[provider-presets.test.ts](../../../tests/unit/provider-presets.test.ts) 校验全部文件并带无效样例。单可执行文件把本目录的 `*.json` 作为资源解出到同一相对路径（`tools/sea/build.mjs` 的 `presetAssets`）。

字段：

- `endpoints`：厂商官方 SDK 使用的基址。chat 与 responses 通常含版本段（如 `https://api.openai.com/v1`，网关追加 `/chat/completions`、`/responses`）；anthropic 不含 `/v1`（网关追加 `/v1/messages`）；gemini 不含版本段（网关追加 `/v1beta/models/…`）。本机服务可以用 `http://127.0.0.1`。
- `auth.apiKeyHeader`：Key 的发送方式；`auth.methods` 为 `["api-key"]`，本机服务为 `["none"]`（可选 Key 时两者都列）。
- `models.source`：优先 `live`，由 `POST /api/v1/providers/{id}/models/refresh` 从上游列出；只有稳定时才给 `static` 的小列表。
- `verified`：对照厂商官方文档核对端点基址与 Key 的发送方式的日期（`YYYY-MM-DD`），没有核对时写 `unverified`；`website`、`keysUrl` 与 `notes` 中的链接只是方便，不在核对范围内。修改端点时同步更新它。
- 一个 provider 只有一种 Key 发送方式。厂商的不同端点要求不同方式时（如 DeepSeek 的对话端点用 Bearer、Anthropic 兼容端点用 `x-api-key`），预设只收录与认证方式一致的端点，其余写在 `notes` 中。
- `notes`：展示给用户的简短说明，例如国际站地址或需要修改端点的本机服务。

添加预设只需新增一个文件，并在提交说明中给出核对所依据的官方文档链接。
