# Provider 预设

预设是 HarnessHub 已经认识的模型厂商、中转服务或本机服务：从预设添加 provider 时只需选择地域或套餐并给出 Key，端点、Key 的发送方式、模型列表的来源与 models.dev 目录 ID 都由预设提供。预设文件的格式、校验与来源记录见 [presets 目录说明](../packages/gateway/presets/README.md)；导入链接与从其他应用导入见 [导入 provider](provider-import.md)。

## 列出与选择

前置条件：守护进程在运行（`hh serve`），命令能读到它的数据目录（`--data-dir`，默认 `./data`）。

```sh
hh provider presets            # 按 Vendors、Relays、Local 分组
hh provider presets --json     # GET /api/v1/presets 的原始响应
```

每行显示预设 ID、名称、端点协议、地域（`REGIONS`）、套餐（`PLANS`）、Key 是否必需与核对日期（`VERIFIED`）。`KEY` 列为 `+base URL` 的预设需要你自己的服务地址（如 Azure 资源）。

- **地域**（region）是同一 API 的不同站点或云区域，例如 Moonshot 的 `cn` 与 `global`、Bedrock 的 AWS 区域。中国站与国际站的账号和 Key 通常不通用，按 Key 所属站点选择。第一个地域是默认值；HarnessHub 原有的预设保留原来的默认地域（多为中国站），取自 Magpie 的预设沿用 Magpie 的默认值。
- **套餐**（plan）是厂商单独售卖的产品，例如智谱与 Z.ai 的 `api`（按量付费）与 `coding`（GLM Coding Plan）、火山方舟的 `coding`、`agent` 与 `api`、百度千帆的个人版、企业版与按量付费。套餐通常有自己的端点、模型与 Key，套餐的 Key 发往按量付费端点会被拒绝。
- `VERIFIED` 是对照厂商文档核对端点与 Key 发送方式的日期；`unverified` 的预设取自 [Magpie](https://github.com/yetone/magpie) 2e340f7 而尚未重新核对，添加后先用 `hh provider models <id> --refresh` 或一次调用确认。

## 添加

```sh
printf '%s' "$KEY" | hh provider add --preset moonshot --region global --credential-from-stdin
printf '%s' "$KEY" | hh provider add glm --preset zhipu --plan coding --credential-from-stdin
hh provider add ark-lan --preset volcengine --plan api --base http://10.0.0.2:8080
hh provider add team --preset azure --base https://team.openai.azure.com
```

预期结果：输出 `Added provider <id> from preset <预设>, region <地域>, plan <套餐>`；`hh provider show <id>` 的 `Preset:` 行显示所选组合，端点为该组合的端点。

- 不给 `--region`、`--plan` 时取预设列出的第一个。不存在的地域或套餐以退出码 2 失败（`PRESET_REGION_NOT_FOUND`、`PRESET_PLAN_NOT_FOUND`），错误信息列出可选值。
- `--base URL` 把所选组合的每个端点路径接到 `URL` 之后；`--chat` 等显式端点优先。需要你自己地址的预设（Azure、`harnesshub-remote`、`magpie-remote`）没有 `--base` 或端点时以退出码 2 失败（`PROVIDER_INVALID`，指向 `/endpoints`）。
- 套餐带有模型列表时（如火山方舟、千帆、华为云的套餐），新 provider 以这些模型开始；有列表接口的厂商仍可以 `hh provider models <id> --refresh`。模型的窗口、输出上限与价格按所选组合的 models.dev 目录 ID 补齐，例如 GLM Coding Plan 的模型价格为 0。
- 预设的 `headerHints` 列出厂商文档中由你填写的请求头，例如 Anthropic 多工作区 Key 需要的 `anthropic-workspace-id`、OpenRouter 的署名头 `HTTP-Referer` 与 `X-OpenRouter-Title`。经 API 创建时放在 `headers` 中；标为必需的 header 缺少时创建失败。

API：`POST /api/v1/providers` 的 `preset`、`region`、`plan`，见 [模型平面 API](model-plane-api.md)。`PATCH /api/v1/providers/{id}` 以 `preset: null` 解除预设时一并清除地域与套餐；`catalog` 可以单独设置或以 `null` 清除。

## 范围与限制

- 共 46 个预设（25 个厂商、18 个中转、3 个本机服务），76 个“地域 × 套餐”组合；Magpie 的 51 个预设中除 3 个决策 API 外都有对应，对应关系见 [presets 目录说明](../packages/gateway/presets/README.md#来源与核对)。
- 不支持需要 OAuth 或请求签名的接入：Google Vertex AI（OAuth 访问令牌）、Bedrock 的 AWS SigV4。Bedrock 预设只用 Bedrock API Key，且只收录 OpenAI 兼容端点；Claude 在 Bedrock 上经 Anthropic Messages 端点提供，需要另建 provider。
- 订阅账号（Claude、ChatGPT 登录等）不是预设。
- 预设随 HarnessHub 版本发布，不在运行时下载。

致谢：地域、套餐、图标、header 提示与大部分新增预设的数据取自 [yetone/magpie](https://github.com/yetone/magpie) 2e340f7 的 `internal/provider/presets.go`（MIT，Copyright (c) 2026 yetone，许可文本见 [magpie.LICENSE](../packages/gateway/presets/magpie.LICENSE)），并列入 [第三方声明](../THIRD_PARTY_NOTICES.md)。
