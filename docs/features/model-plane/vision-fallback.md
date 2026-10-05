# 视觉兜底

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（每张图描述一次并缓存、本轮图片描述失败时该候选失败、未设置时行为不变、Key 白名单不含视觉模型时不描述、每个请求至多描述的张数与内部调用数、1000 张图只描述 16 张且记在 Key 名下、描述占用每分钟请求数）；经正式守护进程的集成测试覆盖经接口与 `hh gateway` 设置视觉模型；macOS arm64。只用回环假上游，真实视觉模型的描述质量与延迟未验证；Windows 未验证 |
| 对照 Magpie | 部分：没有自动选择的视觉模型；没有设置时图片变成占位文字，Magpie 返回 400（[对照表](../../magpie-parity.md#gateway-and-protocols)） |
| 权威文档 | [视觉兜底](../../gateway-features.md#视觉兜底)、[ADR 0027](../../decisions/0027-gateway-features.md)、[ADR 0032 补充二](../../decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下) |

## 用途

请求带图片、而目标模型不接受图片输入时，由用户设置的视觉模型先把每张图片描述成文字（并逐字转写图中文字），再交给目标模型。这样只能读文字的模型也能处理截图、图表等输入，不必为看图换掉整个对话的模型。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 网关功能 → 视觉兜底（可搜索的模型选择器，或不使用；说明费用、隐私与 Key 白名单要求） |
| 命令行 | `hh gateway vision MODEL\|off`（`MODEL` 为 Model Ref 或 `group/<id>`）、`hh gateway features` |
| HTTP | `PUT /api/v1/gateway/features/vision`（`model`）、`DELETE /api/v1/gateway/features/vision`、`GET /api/v1/gateway/features` |

## 已实现的能力

- 翻译的请求在目标模型元数据没有声明图片输入时描述；直通的请求只在元数据明确不含图片输入时描述，此时请求改为翻译（账本照常记录模式）。没有设置视觉模型时行为不变：翻译的请求中图片是占位文字，直通的请求原样发送。
- 每张图片一次 Chat 调用，图片替换为 `[image: <描述>]`；调用经网关自己的完整路径（路由组、熔断、失败转移、凭据、脱敏），从一个只监听 127.0.0.1、只接受本进程随机令牌的内部监听器发出；同时至多描述 4 张，内部调用不再触发视觉兜底。
- 描述以发出请求的 Gateway Key 进行：是这把 Key 的独立账本条目（Agent 为 `harnesshub-vision`、`purpose` 为 `vision`），按视觉模型的价格计入它的预算，每次占用它的一个每分钟请求；允许局域网使用的 Key 的描述不使用订阅账号。
- 视觉模型（Model Ref 或组）必须在 Key 自己的白名单中，因为描述会进入客户端模型的输入；否则不描述，账本记 `vision:not-allowed`。
- 每个请求至多描述 `gateway.limits.maxDescribedImages`（默认 16）张没有缓存的图片，从最新的开始；描述与分类器的内部调用合计至多 `maxInternalCalls`（默认 20）次；其余按没有描述处理，记 `vision:skipped:<n>`。
- 按图片内容（URL 或 data URL 的 SHA-256）缓存最近 256 条描述。
- 本轮新图片描述失败时该候选以 502 `vision_failed` 跳过，能看图的其他候选仍可服务；描述因 Key 的预算或每分钟请求数被拒时为 429 `quota_exceeded`；历史中的图片描述失败时保留占位文字。
- 原调用的 `patches[]` 只记计数：`vision:described:<n>`、`vision:cached:<n>`、`vision:failed:<n>`、`vision:skipped:<n>`；设置随备份与同步带走，恢复时视觉模型指向本机没有的 provider 或组时仍设置并说明。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/vision.ts](../../../packages/gateway/src/vision.ts)、[gateway/internal.ts](../../../packages/gateway/src/internal.ts)、[gateway/limits.ts](../../../packages/gateway/src/limits.ts)、[daemon/gateway-features-routes.ts](../../../packages/daemon/src/http/gateway-features-routes.ts)、[console/gateway-features-page.tsx](../../../packages/console/components/gateway-features-page.tsx) |
| 测试 | [shared-gateway-vision](../../../packages/gateway/test/shared-gateway-vision.test.ts)；集成 [gateway-features](../../../tests/integration/gateway-features.test.ts)、[backup-features](../../../tests/integration/backup-features.test.ts) |
| 决策 | [ADR 0027](../../decisions/0027-gateway-features.md)、[ADR 0032 补充二：网关自己的调用记在触发它的 Key 名下](../../decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下) |

## 已知限制与未验证

- 没有自动选择的视觉模型，必须手工设置；没有设置时图片悄悄变成占位文字，客户端得不到错误。
- 是否描述完全取决于模型元数据的图片输入字段：元数据错误或未知时，直通请求的图片原样发送，翻译请求的图片被描述或变成占位文字。
- `session:` Key 只能用 Run 选定的目标，所以无人值守 Run 中的图片不再被描述（视觉模型就是目标时除外）。
- 描述缓存只在内存中，重启后清空；只缓存 256 条。
- 只用回环假上游验证，真实视觉模型的描述质量、费用与延迟未验证；Windows 未验证。

## 优化候选

- **现状**：视觉模型只能手工设置。**方向**：按模型元数据在 Key 允许的模型中自动挑选一个接受图片的模型，设置中可关闭。**依据**：对照表 Vision fallback 行为部分（No automatically chosen vision model）。
- **现状**：没有视觉模型时图片变成占位文字，模型可能在不知情的情况下回答。**方向**：提供一个选项，没有视觉模型时以 400 告诉客户端目标模型不能看图（Magpie 的做法）。**依据**：对照表 Vision fallback 行的说明。
- **现状**：无人值守 Run 中的图片得不到描述。**方向**：让 Run 的配置可以同时选定视觉模型，并写入 `session:` Key 的白名单。**依据**：[ADR 0032 补充二](../../decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下)的后果。
- **现状**：描述缓存在内存中、只有 256 条，重启后同一张图片重新描述并再次计费。**方向**：把描述缓存放进数据目录并设大小上限。**依据**：阅读 [视觉兜底](../../gateway-features.md#视觉兜底)“缓存”一条的观察。
