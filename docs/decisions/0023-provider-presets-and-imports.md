# ADR 0023：预设的地域与套餐，以及 provider 的导入

Status: proposed

日期：2026-10-04
关联决定：[03 模型平面](../proposals/oss/03-model-plane.md)（第 4 节）、[06 接口与交互面](../proposals/oss/06-interfaces.md)（第 8 节）、[ADR 0020](0020-model-metadata-enrichment.md)

## 问题

HarnessHub 有 15 个预设，每个预设只有一组端点：有中国站与国际站的厂商默认收录中国站，其他站点、Coding Plan 等套餐只写在 `notes` 里，用户要手工改端点，模型元数据也仍按默认站点的 models.dev 目录补齐。Magpie（yetone/magpie@2e340f7）有 51 个预设，用“region”同时表示站点与套餐，并支持导入链接与从 Claude Code、Codex 等应用导入。需要在不破坏已保存 provider 的前提下补齐这些能力。

## 决定

- 预设格式新增可选字段：`regions`（站点或云区域，各有完整端点，可有自己的 Key 页面与目录 ID）、`plans`（单独售卖的产品，可替换端点、模型列表、列表来源、Key 页面与目录 ID）、`icon`、`headerHints`（`required` 的 header 在创建时强制）、`userEndpoint`（必须由用户给出基址）、`fallbackModels`、`source`（数据出处，如 `magpie@2e340f7`）与 `magpie`（Magpie 预设 ID 到本预设地域或套餐的映射）。地域与套餐分开：端点依次取套餐、地域、预设；顶层 `endpoints` 必须等于第一个地域与套餐的组合，旧客户端读到的仍是默认端点。
- `ProviderConfig` 新增可选的 `region`、`plan`（只能与 `preset` 同在）与 `catalog`（覆盖预设的目录 ID，供没有预设的导入使用）。元数据补齐按 provider 记录的地域与套餐解析预设；记录中的地域或套餐被之后的预设删除时按默认组合读取，不使已保存的 provider 无效。`PATCH` 以 `preset: null` 解除预设时一并清除地域与套餐。
- Magpie 中分开的中国站预设（`moonshot-cn`、`kimi-code-cn`、`minimax-cn`、`qwen-cn`、`tencent-tokenhub-cn`）合并为地域，经 `magpie` 字段保持 Magpie 链接的含义（Magpie 的 `moonshot` 是国际站，而本项目 `moonshot` 的默认地域是中国站）。Magpie 的 3 个决策 API 预设不收录。HarnessHub 原有预设保留默认地域与核对日期。
- 导入链接：接受 `harnesshub://import?…`、`https://harnesshub.dev/import#…` 以及 Magpie 的两种形式，参数集合是 Magpie 的（另加 `v`、`kind`、`plan`、`gemini`），未知或重复参数整体拒绝，端点按 provider 基址规则校验，`icon` 不下载。解析是 `@harnesshub/core/import-links` 的纯函数。
- 预览与确认：`POST /api/v1/import/preview` 把解析或读取的结果（含 Key）保存在守护进程内存中 10 分钟，返回一次性的 `previewId`；`POST /api/v1/import/apply` 只创建预览中 `new` 的项，经 `POST /providers` 的同一路径。`hh import` 在确认前打印预览，非交互时需要 `--yes`。
- 从其他应用导入：只在组合根给出的接线 home 下、按全局接线定位文件的方式只读 Claude Code 的 `settings.json` 与 Codex 的 `config.toml`；指向本机网关或带 `hhk_` Key 的项跳过；端点与某个预设一致时按该预设创建。

## 考虑过的替代方案

- **照搬 Magpie，每个站点一个预设**：保留 `-cn` 预设能让预设数与 Magpie 相同，但 Key 页面、目录 ID 与说明要在两个文件中重复，本项目已有的 `moonshot`（中国站）与 Magpie 的 `moonshot`（国际站）含义相反。合并为地域后由 `magpie` 映射保持兼容。
- **地域与套餐用同一个列表**（Magpie 的 `regions` + `regionLabel`）：小米与阶跃这样同时有站点和套餐的厂商只能把组合逐个列出；分开后组合规则简单，Magpie 的 `region=coding` 在 Magpie 链接中按“先地域、后套餐”匹配。阶跃的套餐路径随站点变化，仍保持两个预设。
- **06 第 8 节的 `/system/import-links` 与 `/{previewId}/apply`**：按维护者给出的接口改为 `/import/preview` 与 `/import/apply`，保留一次性 `previewId` 的做法：Key 只发送一次，apply 只能创建用户看过的内容，预览之后改动的配置文件不会被悄悄导入。
- **apply 时重新解析链接或重读文件**：无需在内存中保存 Key，但请求要再带一次 Key，并且确认的内容可能与预览不同。
- **把 `v=1&kind=provider` 设为必填**（06 第 8 节）：本项目的链接与 Magpie 的写法因此不同，厂商需要发两种链接；改为可省略，给出时只接受 `1` 与 `provider`。
- **下载链接中的图标**（Magpie 在确认后下载）：这是链接唯一会让本机访问外部地址的参数；只显示自带预设的图标。

## 后果

- 预设从 15 个增加到 46 个（76 个地域与套餐组合），多数新预设的端点取自 Magpie 而未重新核对（`verified: unverified`），用户需要在添加后验证。预设数量少于 Magpie 的 51 个，因为 5 对站点合并为地域、3 个决策 API 未收录，`magpie` 映射覆盖其余 48 个 Magpie ID。
- `ProviderConfig` 多出三个可选字段；旧记录不受影响，旧版本读取新记录时忽略它们，只有新版本按地域与套餐解析元数据。
- 预览中的 Key 在守护进程内存中至多保留 10 分钟（至多 32 份）；守护进程重启后预览失效，需要重新预览。
- Bedrock 只支持 Bedrock API Key；Vertex AI（OAuth）与 SigV4 仍不支持。Codex 的 `env_key` 导入为环境变量引用，守护进程的环境中没有该变量时调用失败（`CREDENTIAL_UNAVAILABLE`）。
- 导入不替换已存在的 provider；需要替换时先删除。Magpie 的 CC Switch 与 Alma 导入、按 key 合并到已有 provider 未实现。

## 验证要求

- 每个预设的每个地域与套餐组合都能展开为有效 provider，Schema 与加载器对每条规则有拒绝样例（`tests/unit/provider-presets.test.ts`），Magpie 的 51 个 ID 中 48 个能映射。
- 经守护进程创建的 provider 记录地域与套餐，元数据按套餐的目录 ID 补齐（`tests/integration/provider-presets.test.ts`）。
- 链接解析有接受与拒绝样例，错误不含 Key（`packages/core/test/import-links.test.ts`）；预览不写入，apply 只能使用一次，Key 不出现在响应、日志与数据目录中；临时 home 中的 Claude Code 与 Codex 配置按规则导入（`tests/integration/provider-import.test.ts`）；真实 `hh import` 在非交互且没有 `--yes` 时不写入（`tests/integration/hh-cli.test.ts`）。
