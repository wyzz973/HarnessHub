# 模型列表、目录与元数据

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 单元测试覆盖解析顺序与来源记录、快照格式、刷新（注入的 fetch 与计时器）与按凭据合并列表；经守护进程的集成测试覆盖预设与快照补齐、覆盖与手工值的优先级、重启后覆盖仍在、网关按补齐的价格计成本、两把 Key 看到不同模型。测试不联网（`HH_OFFLINE=1`，刷新指向回环假服务），运行时刷新没有对真实 models.dev 的自动化测试；真实上游的模型列表只在 DeepSeek 上读过；Windows 未验证 |
| 对照 Magpie | 相同：models.dev 目录与每日刷新、按模型覆盖（含 `provider/*`）；有意不同：不按名称投票补齐元数据；部分：上游模型列表、每把 Key 的列表、`wire` 名；显示名、按模型的推理档位与 `sameAs` 未覆盖（[Providers, presets and import](../../magpie-parity.md#providers-presets-and-import)） |
| 权威文档 | [模型元数据](../../model-plane-api.md#模型元数据)、[模型目录快照](../../../packages/gateway/catalog/README.md)、[运行时刷新](../../../packages/gateway/catalog/README.md#运行时刷新)、[模型解析与列表](../../model-gateway.md#模型解析与列表) |

## 用途

让网关知道每个 provider 提供哪些模型，以及每个模型的上下文窗口、输出上限、能否推理、输入模态、能否调用工具与价格。列表从上游读取或手工填写，元数据按固定优先级从用户覆盖、手工值、上游列表、预设与内置 models.dev 快照补齐，用于 `/v1/models`、Agent 接线写入的模型清单与每次调用的成本。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Provider › 详情 › 模型：刷新模型，窗口、输出与价格及其来源（悬停提示）；编辑对话框的模型列表与“全部模型出现在 /v1/models 与 Agent 的模型选择中”；设置 › 通用 › 模型目录：状态与立即刷新 |
| 命令行 | `hh provider models <id> [--refresh]`；`hh model show <ref>`、`hh model set <ref> KEY=VALUE…`、`hh model unset <ref>`（`<ref>` 可为 `provider/*`）；`hh catalog status`、`hh catalog refresh` |
| HTTP | `POST /api/v1/providers/{id}/models/refresh`、`GET /api/v1/providers/{id}/models`；`GET /api/v1/models/{ref}`；`GET`、`PUT`、`DELETE /api/v1/models/{ref}/overrides`；`GET /api/v1/catalog`、`POST /api/v1/catalog/refresh` |

## 已实现的能力

- 刷新：用启用的凭据请求上游的列表接口（chat 基址 + `/models`、anthropic 基址 + `/v1/models`、gemini 基址 + `/v1beta/models`，跟随 Anthropic 与 Gemini 的分页至多 20 页，15 秒超时、8 MiB 上限）；失败时保留原列表并标记 `stale`，错误只含主机与 HTTP 状态。`harnesshub-remote` 的列表同时读取对方给出的窗口、输出上限、推理与输入模态。
- 按凭据读取：有两个以上启用的凭据能用于列表端点时（订阅账号除外），每个凭据分别读取并合并，`models.listedFor` 记录读到了自己列表的凭据，模型的 `credentials` 记录哪些凭据列出它；某个凭据这次读不到时保留它上次的结果，全部读不到时按失败处理。
- 添加 provider 时不请求上游，模型从预设、套餐或手工列表开始；第一次刷新之前 `hh provider models` 提示运行 `--refresh`。
- 公开范围：`models.expose` 为 `all` 或模型 ID 列表，只有公开的模型出现在 `/v1/models`、自动路由组与 Agent 的模型选择中；不在列表中的模型照常路由，元数据未知。
- 元数据逐字段取第一个已知来源：该模型的覆盖、`provider/*` 覆盖、provider 中手工填写的值、上游列表、预设、内置 models.dev 快照；都没有时为 `unknown`，不按名称猜测，也不回落到默认窗口。
- 来源记录：创建 provider、`PATCH`、刷新与修改覆盖时把解析结果写入每个模型项，并在 `model_provenance` 表记录每个推导值的来源与时间；与推导值不同的存储值视为手工值，之后的写入不覆盖它。`hh model show` 与控制台显示每个值的来源。
- 覆盖：`hh model set` 的键为 `context`、`output`、`reasoning`、`toolcall`、`modalities`、`price.input`、`price.output`、`price.cacheRead`、`price.cacheWrite`（美元每百万 token）；新值与已有覆盖合并，`键=` 删除一项；不在列表中的模型也可以覆盖；删除 provider 时一并删除。
- 内置快照：models.dev `api.json` 的裁剪快照（2026-10-02 取得，226 个 provider、8,371 个模型，MIT），只保留上述字段；先按预设或 provider 的 `catalog` ID 查找，再按 `author/model` 中的作者。
- 后台刷新：默认启动后（距上次尝试超过 24 小时时）立即请求，之后每 24 小时一次，带 `If-None-Match`，10 秒超时、64 MiB 上限；服务了有用量而没有价格的调用后最早 6 小时提前刷新。结果写入 `<dataDir>/catalog`，比内置快照新时才使用；内容变化后重新解析全部 provider 的元数据，网关随即使用新价格。
- `HH_OFFLINE=1` 或 `catalog.autoRefresh: false` 关闭后台刷新，`hh catalog refresh` 仍可手动刷新（失败为 502 `CATALOG_REFRESH_FAILED`，原目录继续使用）；`catalog.url` 可改为其他 HTTPS 地址。
- 成本：网关按解析后的价格计算每次调用的成本（推理按输出价格）；任何用到的 token 类别没有价格时成本为 null，用量中单独计为未计价。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | 上游列表与按凭据合并 [model-list.ts](../../../packages/daemon/src/http/model-list.ts)、写入时补齐 [model-enrichment.ts](../../../packages/daemon/src/http/model-enrichment.ts)、解析顺序 [model-metadata.ts](../../../packages/core/src/model-metadata.ts)、快照读取 [catalog.ts](../../../packages/gateway/src/catalog.ts)、后台刷新 [catalog-refresh.ts](../../../packages/gateway/src/catalog-refresh.ts)、配置 [config-file.ts](../../../packages/daemon/src/config-file.ts)、控制台 [providers-page.tsx](../../../packages/console/components/providers-page.tsx) 与 [settings-page.tsx](../../../packages/console/components/settings-page.tsx) |
| 测试 | [model-metadata.test.ts（单元）](../../../tests/unit/model-metadata.test.ts)、[model-metadata.test.ts（集成）](../../../tests/integration/model-metadata.test.ts)、[catalog-refresh.test.ts](../../../tests/unit/catalog-refresh.test.ts)、[credential-models.test.ts](../../../tests/integration/credential-models.test.ts)、[model-list.test.ts](../../../packages/daemon/test/model-list.test.ts)、[credential-models.test.ts（core）](../../../packages/core/test/credential-models.test.ts) |
| 决策 | [ADR 0020 模型元数据在写入时补齐并记录来源](../../decisions/0020-model-metadata-enrichment.md) |

## 已知限制与未验证

- 每种协议只请求一个固定的列表路径（chat 或 responses 基址后的 `/models` 可经 API 的 `models.listPath` 改成别的路径），不探测其他地址。
- 元数据没有推理档位、结构化输出与按上下文分档的价格；不校验“输出上限小于窗口”，缺窗口时不告警。价格只有美元，没有 `*/<model>` 价格。
- `wire`（上游模型名）只能经 `PATCH /api/v1/providers/{id}` 设置；`expose` 没有 `hh` 命令，只能在控制台编辑对话框或经 API 修改。
- 控制台只显示元数据及其来源，不能编辑覆盖；覆盖只能用 `hh model set` 或 API（阅读控制台代码的观察：它不调用覆盖接口）。
- 订阅账号只读一个列表；Windows 未验证。

## 优化候选

- **现状**：元数据缺推理档位、结构化输出、分档价格与窗口校验。**方向**：在快照与覆盖中加入这些字段，并在输出上限不小于窗口或缺窗口时告警。**依据**：[模型元数据](../../model-plane-api.md#模型元数据) 的“尚未实现”。
- **现状**：控制台不能编辑模型覆盖。**方向**：在 Provider 详情的模型表上加覆盖编辑，调用已有的覆盖接口。**依据**：阅读控制台代码的观察；[控制台说明](../../../packages/console/README.md#页面与状态) 的 Provider 一节只列出查看与刷新。
- **现状**：`wire`、显示名与按模型的推理档位没有命令或编辑器，后两者不存在。**方向**：加 `hh` 子命令与控制台字段，并支持显示名与档位。**依据**：[对照表](../../magpie-parity.md#providers-presets-and-import) 的 `wire` 行（partial）与显示名、档位、`sameAs` 行（not covered）。
- **现状**：列表只请求每种协议的固定路径，`listPath` 也只能经 API 设置。**方向**：路径失败时探测常见的列表地址，并在控制台或 `hh` 中提供 `listPath`。**依据**：对照表的 live model lists 行（partial：“No URL probing”）；阅读 [model-list.ts](../../../packages/daemon/src/http/model-list.ts) 的观察。
