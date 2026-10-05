# 导入

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | core 单元测试覆盖链接的接受与拒绝（错误不含 Key）；经守护进程的集成测试覆盖预览、一次性 apply、Magpie 链接、临时 home 中的 Claude Code 与 Codex 配置，以及 Key 不出现在响应、日志与数据目录中；真实 `hh import` 在非交互且没有 `--yes` 时不写入；没有在真实用户的 Claude Code、Codex 配置上运行；Windows 未验证 |
| 对照 Magpie | 相同：从 Claude Code 的 `settings.json` 与 Codex 的 `config.toml` 导入；部分：`magpie://` 与 `usemagpie.ai` 链接（照原样读取，但没有系统 URL 处理程序，已存在的 ID 跳过）；未覆盖：CC Switch 与 Alma 导入、把导入的 Key 加到已有 provider（[Providers, presets and import](../../magpie-parity.md#providers-presets-and-import)） |
| 权威文档 | [导入 provider](../../provider-import.md)、[导入链接](../../provider-import.md#导入链接)、[从其他应用导入](../../provider-import.md#从其他应用导入)、[安全](../../provider-import.md#安全) |

## 用途

把厂商、中转服务或同事给出的一条导入链接，或本机 Claude Code、Codex 已经配好的上游，变成 HarnessHub 的 provider，不用手工抄端点与 Key。导入先预览将要添加什么、请求与 Key 会发往哪些主机，确认后才写入。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Provider › 导入：粘贴 `harnesshub://` 或 `magpie://` 链接，或“从 Claude Code 导入”“从 Codex 导入”；预览每个 provider 的去向（主机、Key 末四位或环境变量、模型）后选择导入 |
| 命令行 | `hh import '<link>'`；`hh import -`（从 stdin 读链接，Key 不进 shell 历史）；`hh import --from claude-code`；`hh import --from codex [--only REF]…`；`--yes` 不询问 |
| HTTP | `POST /api/v1/import/preview`（`{"link"}` 或 `{"app"}`）、`POST /api/v1/import/apply`（`{"previewId", "refs"?}`） |

## 已实现的能力

- 四种链接：`harnesshub://import?…`（也接受 `harnesshub:import?…` 与 `harnesshub:///import?…`）、`https://harnesshub.dev/import#…`、`magpie://import?…`、`https://usemagpie.ai/import#…`；网页形式只读 `#` 之后的片段，从不访问这些页面，其他主机或路径的网址不是导入链接。
- 参数为 Magpie 的集合另加 `plan`、`gemini`、`v`、`kind`：`preset`、`region`、`plan`、`name`、`id`、`key`、`chat`、`responses`、`anthropic`、`gemini`、`models`、`catalog`、`website`、`keys`、`icon`；未知或重复的参数使整条链接被拒绝。Magpie 的预设 ID 与 `region` 经预设的 `magpie` 映射换成 HarnessHub 的预设、地域或套餐（如 `moonshot-cn` 是 `moonshot` 的 `cn` 地域）；Magpie 的决策 API 预设被拒绝。
- 上限与校验：链接最长 8 KiB；`key` 最长 4096 字符、不含空白；`models` 至多 200 个；`name` 最长 80 字符；`id` 转为 slug，`hh`、`harnesshub`、`group` 为保留字；端点按 provider 基址规则校验，HTTP 只用于回环与私网并给出警告；`icon` 只校验为 HTTPS 而不下载；`website` 与 `keys` 只以文本显示。链接解析错误只指出参数名，不复述参数值。
- 从 Claude Code 导入：读 `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 的 `env`，`ANTHROPIC_BASE_URL` 为空表示直接登录 Anthropic、没有可导入的项；Key 取 `ANTHROPIC_AUTH_TOKEN`（Bearer）或 `ANTHROPIC_API_KEY`（`x-api-key`），各模型变量成为模型列表。
- 从 Codex 导入：读 `${CODEX_HOME:-~/.codex}/config.toml` 中每个带 `base_url` 的 `[model_providers.<表名>]`；`wire_api = "chat"` 为 chat 端点，否则为 responses；`experimental_bearer_token` 写入秘密存储，`env_key` 成为对该环境变量的引用；`http_headers` 成为 provider 的 header（预览只显示名称）。
- 端点与某个预设（任一地域与套餐）完全一致时按该预设创建，否则为 `custom` provider；指向本机网关、带 `hhk_` Key 或表名为 `harnesshub` 的项是 HarnessHub 自己的接线，跳过；没有 Key 或 `env_key` 不是环境变量名的项跳过。
- 只读应用配置，不改写：文件超过 1 MiB、经符号链接指向主目录之外或无法解析时整体失败（409，错误不含文件内容）；守护进程没有接线 home 时 409 `IMPORT_SOURCE_UNAVAILABLE`，导入链接不受影响。
- 预览与确认：预览不写入任何内容，返回一次性的 `previewId`；包括 Key 在内的解析结果只在守护进程内存中保存 10 分钟、至多 32 份（最旧的先淘汰）。apply 只创建预览中状态为 `new` 的项，经与 `POST /providers` 相同的路径；预览无论结果如何只能用一次，之后 404 `IMPORT_PREVIEW_NOT_FOUND`。
- `hh import` 打印 ID 与名称、预设与地域套餐、每个端点、请求与 Key 将发往的主机（`Sends to`）、Key 的来源（长度至少 16 的只显示后四位）、模型与警告，再询问 `[y/N]`；没有终端且没有 `--yes` 时以 4 退出且不写入；在终端命令行上写带 `key=` 的链接时提示改用 `hh import -`。
- ID 已存在的项显示为 `Exists` 并跳过；导入只创建 provider 与它的第一个凭据，不签发 Gateway Key，不改接线、默认模型或路由组；不发起任何网络请求，也不验证 Key。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | 链接解析 [import-links.ts](../../../packages/core/src/import-links.ts)、读取应用配置 [provider-imports.ts](../../../packages/daemon/src/provider-imports.ts)、预览与 apply [import-routes.ts](../../../packages/daemon/src/http/import-routes.ts)、CLI [admin.ts](../../../packages/cli/src/admin.ts)、控制台 [import-dialog.tsx](../../../packages/console/components/import-dialog.tsx) |
| 测试 | [import-links.test.ts](../../../packages/core/test/import-links.test.ts)、[provider-import.test.ts](../../../tests/integration/provider-import.test.ts)、[hh-cli.test.ts](../../../tests/integration/hh-cli.test.ts) |
| 决策 | [ADR 0023 预设的地域与套餐，以及 provider 的导入](../../decisions/0023-provider-presets-and-imports.md) |

## 已知限制与未验证

- 没有操作系统的 URL 处理程序，浏览器中的链接要复制后粘贴到控制台或 `hh import`。
- 不替换已存在的 provider，也不能把导入的 Key 作为凭据加到已有 provider；要替换先删除。
- 不支持 CC Switch 与 Alma；不读 Codex 的 `model_catalog_json`；`kind` 只能是 `provider`（`mcp` 尚不支持），`v` 只能是 `1`。
- 预览只在内存中，守护进程重启后失效。
- 导入时不验证 Key；Codex 的 `env_key` 引用在守护进程的环境中没有该变量时，要到调用时才失败（`CREDENTIAL_UNAVAILABLE`）。
- 只在临时 home 的合成配置上测试过；Windows 未验证。

## 优化候选

- **现状**：同 ID 的 provider 已存在时只能跳过。**方向**：预览中提供“作为新凭据加到已有 provider”。**依据**：[ADR 0023](../../decisions/0023-provider-presets-and-imports.md) 的后果（“按 key 合并到已有 provider 未实现”）、[对照表](../../magpie-parity.md#providers-presets-and-import) 的 not covered 行。
- **现状**：网页上的导入链接不能一点就打开。**方向**：注册系统 URL 处理程序，或让 `https://harnesshub.dev/import#…` 打开本机控制台的导入对话框；后者依赖控制台能否从其他网站的链接打开。**依据**：对照表的导入链接行（partial）；[TODO.md](../../../TODO.md) 中需要所有者决定的“是否允许从其他网站的链接直接打开控制台”。
- **现状**：导入后要到第一次调用才知道 Key、端点或 `env_key` 是否可用。**方向**：apply 之后提示或可选地运行 `hh provider test`。**依据**：[安全](../../provider-import.md#安全)（“不验证 Key”）与 ADR 0023 后果中的 `CREDENTIAL_UNAVAILABLE`。
- **现状**：不能从 CC Switch、Alma 导入，链接不支持 `kind=mcp`。**方向**：按 Magpie 的读取规则加入这两个来源，并定义 MCP 导入链接。**依据**：对照表的 not covered 行；[参数表](../../provider-import.md#参数) 的 `v`、`kind` 一行。
