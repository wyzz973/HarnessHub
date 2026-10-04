# 导入 provider

两种导入都先预览、确认后才写入：一是厂商、中转服务或同事给出的**导入链接**，二是本机其他应用（Claude Code、Codex）已经配置的上游。导入只创建 provider 与它的第一个凭据，不签发 Gateway Key，不改接线、默认模型或路由组。预设本身见 [Provider 预设](provider-presets.md)；取舍见 [ADR 0023](decisions/0023-provider-presets-and-imports.md)。

## 导入链接

### 形式

| 形式 | 示例 | 预设 ID |
|---|---|---|
| 文本 | `harnesshub://import?preset=deepseek&key=sk-…`（也接受 `harnesshub:import?…` 与 `harnesshub:///import?…`） | HarnessHub 的 |
| 网页 | `https://harnesshub.dev/import#preset=deepseek&key=sk-…` | HarnessHub 的 |
| Magpie 文本 | `magpie://import?preset=moonshot-cn&key=sk-…` | Magpie 的 |
| Magpie 网页 | `https://usemagpie.ai/import#preset=moonshot-cn&key=sk-…` | Magpie 的 |

网页形式的参数在 `#` 之后，浏览器不会把它们发给服务器；HarnessHub 只读取片段，从不访问这些页面。其他主机或路径的网址不是导入链接。

### 参数

每个参数最多出现一次，出现未知参数或重复参数时整条链接被拒绝；链接最长 8 KiB。值按 URL 编码，Key 中的 `+` 必须写成 `%2B`（未编码的 `+` 会被读成空格，Key 因而被拒绝）。

| 参数 | 规则 |
|---|---|
| `preset` | 预设 ID。Magpie 链接用 Magpie 的 ID，按预设的 `magpie` 映射（如 `moonshot-cn` 是 `moonshot` 的 `cn` 地域，`qwen` 是 `dashscope` 的 `intl` 地域）；Magpie 的决策 API 预设没有对应，被拒绝 |
| `region` | 预设的地域。Magpie 链接的 `region` 不是地域而是套餐名时按套餐处理（Magpie 只有一组选项，如 `zhipu` 的 `coding`） |
| `plan` | 预设的套餐；只有 HarnessHub 链接可用 |
| `name` | 不给 `preset` 时必填，最长 80 字符，不含控制字符 |
| `id` | 转换为 slug（小写字母、数字与 `-`）；不给时取预设 ID，没有预设时由 `name` 生成。`hh`、`harnesshub`、`group` 是保留字 |
| `key` | 可选，最长 4096 字符，不含空白与控制字符；确认后写入秘密存储 |
| `chat`、`responses`、`anthropic`、`gemini` | 端点基址，规则同 provider：HTTPS；回环与私网地址可用 HTTP，预览给出警告；不能含账号密码、查询串、片段或操作路径。与 `preset` 同给时按协议替换预设的端点；没有 `preset` 时至少给一个。`gemini` 只有 HarnessHub 链接可用 |
| `models` | 逗号分隔的模型 ID，最多 200 个，不含空白；成为新 provider 的模型列表 |
| `catalog` | models.dev 的 provider ID，用于补齐窗口与价格；记录在 provider 的 `catalog` 上 |
| `website`、`keys` | 官网与 Key 申请页，只以文本显示；不是 HTTPS 的被忽略并给出警告 |
| `icon` | 必须是 HTTPS 地址，但不下载：HarnessHub 只显示自带预设的图标，预览给出警告 |
| `v`、`kind` | 只有 HarnessHub 链接可用，可省略：`v` 只能是 `1`（更高的版本提示升级 HarnessHub），`kind` 只能是 `provider`（`mcp` 尚不支持） |

与 [06 第 8 节](proposals/oss/06-interfaces.md#8-导入链接) 的设计相比：`v` 与 `kind` 可以省略，以便与 Magpie 的链接写法一致。

### 命令行

```sh
hh import 'harnesshub://import?preset=moonshot&region=global&key=…'
hh import - < link.txt         # 从 stdin 读取链接，Key 不留在 shell 历史中
hh import - --yes < link.txt   # 不询问，直接添加
```

`hh import` 先列出将要添加的 provider：ID 与名称、预设及其地域与套餐、每个端点、请求与 Key 将发往的主机（`Sends to`）、Key 的来源（长度至少 16 的 Key 只显示后四位）、模型与警告，然后询问 `[y/N]`。没有终端且没有 `--yes` 时以退出码 4 结束，不写入任何内容。ID 已被占用的显示为 `Exists` 并跳过（不替换现有 provider）；没有可添加的项时输出 `Nothing to add.` 并以 0 退出。在终端中把带 `key=` 的链接写在命令行上时，会提示改用 `hh import -`。

## 从其他应用导入

```sh
hh import --from claude-code
hh import --from codex [--only <表名>]...
```

只读取 `hh serve` 所在账户的配置，位置与[全局接线](global-wiring.md)相同，不改写这些文件：

- **Claude Code**：`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 的 `env`。`ANTHROPIC_BASE_URL` 为空时表示 Claude Code 直接登录 Anthropic，没有可导入的项。Key 取 `ANTHROPIC_AUTH_TOKEN`（以 Bearer 发送），没有时取 `ANTHROPIC_API_KEY`（以 `x-api-key` 发送；按预设导入时用预设的发送方式）；`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 与 `ANTHROPIC_SMALL_FAST_MODEL` 成为模型列表。
- **Codex**：`${CODEX_HOME:-~/.codex}/config.toml` 的每个带 `base_url` 的 `[model_providers.<表名>]`。`wire_api = "chat"` 时端点为 chat，否则为 responses；Key 取 `experimental_bearer_token`（写入秘密存储），没有时取 `env_key` 指名的环境变量（凭据是对该变量的引用，由守护进程的环境解析）；`http_headers` 成为 provider 的 header（预览只显示名称）；模型取顶层 `model` 与选中该表的 `[profiles.*]` 的 `model`。Codex 的 `model_catalog_json` 不读取。

规则：端点与某个预设（任一地域与套餐）的端点完全一致时，按该预设创建（如 `https://api.deepseek.com/anthropic` 成为 `deepseek` 预设的 provider，三种协议的端点都可用）；否则创建 `custom` provider，ID 由表名或主机名生成。指向本机网关、带 HarnessHub Gateway Key（`hhk_`）或表名为 `harnesshub` 的项是 HarnessHub 自己的接线，跳过；没有 Key 的项，以及 `env_key` 不是环境变量名（大写字母、数字与下划线）的项跳过。文件超过 1 MiB、经符号链接指向主目录之外或无法解析时整体失败（409，错误不含文件内容）。

守护进程不是由 `hh serve` 启动、没有接线 home 时，从应用导入以 409 `IMPORT_SOURCE_UNAVAILABLE` 失败；导入链接不受影响。

## API

| 操作 | 说明 |
|---|---|
| `POST /api/v1/import/preview` | 请求体 `{"link": "…"}` 或 `{"app": "claude-code" \| "codex"}`。返回 `previewId`、`expiresAt`、`source`、`file`、`items[]`（`ref`、`status` 为 `new`/`exists`/`skipped`、`reason`、`provider`、`hosts`、`key`）与 `warnings`。不写入任何内容；包括 Key 在内的解析结果只在守护进程内存中保存 10 分钟，至多 32 份 |
| `POST /api/v1/import/apply` | 请求体 `{"previewId": "…", "refs": ["…"]}`（`refs` 可选）。按 `POST /providers` 的路径逐项创建 `new` 的项，返回每项的 `created`、`skipped` 或 `failed`。预览无论结果如何只能使用一次，之后 404 `IMPORT_PREVIEW_NOT_FOUND` |

错误码与字段见 [逐接口参考](api/reference.md)；SDK 为 `client.imports.preview` 与 `client.imports.apply`。

## 安全

- 确认之前不写入任何内容；预览按 ID 引用，apply 只能创建预览中显示过的项。
- Key 只进入秘密存储（或保持为环境变量引用），不出现在响应、日志与错误信息中；预览至多显示后四位。链接解析错误只指出参数名，不复述参数值。
- 不发起任何网络请求：不下载 `icon`，不访问网页形式的链接所在页面，不验证 Key。
- 管理接口只接受本机管理令牌与回环连接（[模型平面 API](model-plane-api.md)）。

测试：[import-links.test.ts](../packages/core/test/import-links.test.ts) 覆盖链接的接受与拒绝；[provider-import.test.ts](../tests/integration/provider-import.test.ts) 经守护进程验证预览、一次性 apply、Magpie 链接、临时 home 中的 Claude Code 与 Codex 配置，以及 Key 不出现在响应、日志与数据目录中；[hh-cli.test.ts](../tests/integration/hh-cli.test.ts) 运行真实的 `hh import`。
