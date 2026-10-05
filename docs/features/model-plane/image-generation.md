# 图像生成

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（图像端点直通与账本用量、成本，Credential 转移，经 Chat 画不出图或模型不允许时拒绝，流式的部分图片与完成事件，JSON 与 multipart 编辑，图像端点 404 时经 Chat 再试一次，经 Chat 画图的流式完成事件）；经正式守护进程的集成测试覆盖生成与 multipart 编辑到达上游；macOS arm64。真实 OpenAI Images API 与真实厂商的经 Chat 画图未验证；Windows 未验证 |
| 对照 Magpie | 部分：请求必须指定模型，没有自动选择的画图模型、Gemini 原生与订阅画图、图像 MCP；未覆盖：视频生成、跨实例的图像与视频模型（[对照表](../../magpie-parity.md#gateway-and-protocols)） |
| 权威文档 | [图像生成](../../gateway-features.md#图像生成)、[ADR 0027](../../decisions/0027-gateway-features.md)、[ADR 0031](../../decisions/0031-group-members-and-key-budgets.md)（第 7 条） |

## 用途

让脚本与 Agent 用 OpenAI Images 的接口生成或编辑图片，模型可以是任何配置了图像端点的 provider，也可以是能在 Chat 中画图的模型。Gateway Key 的白名单、预算、熔断与账本照常适用，失败时转移到下一个 Credential。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Provider 编辑 → 图像端点（OpenAI 兼容 Images API 的基址）；设置 → 网关功能列出设置了图像端点的 provider |
| 命令行 | `hh provider add <id> --chat URL ... --image-endpoint URL`（只在添加时）；其后用 `hh usage` 查看调用 |
| HTTP | `POST /v1/images/generations`、`POST /v1/images/edits`（JSON 或 `multipart/form-data`，带 Gateway Key）；`PATCH /api/v1/providers/{id}` 的 `imageEndpoint` |

## 已实现的能力

- `model` 是 Model Ref、`group/<id>`（按成员顺序，组中的组展开在其位置上）或裸名称；路径需要带 `/v1`；`modelAllow`、预算与熔断照常适用，上游失败时按模型调用的规则转移到下一个 Credential。
- 设置了 `imageEndpoint`（不含操作路径，网关追加 `/images/generations` 或 `/images/edits`）的 provider 先经图像端点请求；JSON 请求只把 `model` 改为 wire 名，提示词经过出站脱敏，其余字段原样转发；multipart 编辑重新组成表单发出（`image`、`image[]` 与 `mask` 文件原样）。
- 图像端点的 JSON 答复与 `stream: true` 的事件（`image_generation.partial_image`、`image_generation.completed` 等）原样返回；上游最多等 5 分钟。
- 没有图像端点但有 Chat 端点的 provider 经 chat completions 画图：`modalities: ["image", "text"]`、非流式，`size` 换算成宽高比说明并带 `image_config.aspect_ratio`，每张图一次调用，`n` 至多 4；答复中的图片从 `message.images[]`、内容中的 `image_url`、AIHubMix 的 `multi_mod_content` 或文本中的 data URL 取出，以 Images 的形式返回（流式时每张图一个完成事件）；没有画出图片时 502 并转移。
- 图像端点答复 404 或 405 时，在同一 Credential 上改经 Chat 再请求一次；账本记 `images:chat-after-images` 与 `images:via-chat`，两次尝试都在 `attempts[]` 中。
- 每次调用一个账本条目（`inbound.path` 为对应的图像路径），用量取答复或完成事件中的 `usage`，模型有价格时按输入与输出价格计费，没有用量的上游（如 DALL·E）费用为空。
- 订阅 provider 与关闭的 provider 不参与；两种方式都没有时 404 `images_unavailable`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/images.ts](../../../packages/gateway/src/images.ts)、[core/model-plane.ts](../../../packages/core/src/model-plane.ts)（`imageEndpoint`）、[daemon/model-plane-routes.ts](../../../packages/daemon/src/http/model-plane-routes.ts)、[console/providers-page.tsx](../../../packages/console/components/providers-page.tsx) |
| 测试 | [shared-gateway-images](../../../packages/gateway/test/shared-gateway-images.test.ts)；集成 [gateway-features](../../../tests/integration/gateway-features.test.ts) |
| 决策 | [ADR 0027](../../decisions/0027-gateway-features.md)（图像端点是 provider 字段而不是新的线协议）、[ADR 0031](../../decisions/0031-group-members-and-key-budgets.md)（编辑、经 Chat 画图与回退） |

## 已知限制与未验证

- 请求必须指定模型；没有 Magpie 的 `imageGen` 设置与自动选择画图模型。
- 不支持 Gemini 原生 `generateContent` 画图、视频、图像 MCP；multipart 表单中的图片只取上传的文件，不下载 URL。
- `/v1/models` 不列出图像模型；`hh provider` 没有给已有 provider 设置图像端点的子命令，要经控制台或 `PATCH`。
- 经 Chat 画图时不会画图的模型返回 502 并转移，可能先花掉一次计费的调用。
- 真实 OpenAI Images API、真实厂商的经 Chat 画图与 Windows 都未验证。

## 优化候选

- **现状**：调用方必须知道哪个模型能画图。**方向**：增加缺省画图模型设置与按目录自动选择。**依据**：对照表 Image generation 行为部分；[ADR 0031](../../decisions/0031-group-members-and-key-budgets.md) 后果中的“未做”。
- **现状**：`/v1/models` 中没有图像模型，客户端无从发现。**方向**：列出有图像端点或能经 Chat 画图的模型并标明。**依据**：对照表 `/v1/models` 行为部分（no image and video entries）。
- **现状**：Gemini 原生画图与视频不可用。**方向**：增加 Gemini `generateContent` 画图与 `/v1/videos`。**依据**：[图像生成](../../gateway-features.md#图像生成)的“不在范围内”；对照表 Video generation 行未覆盖。
- **现状**：给已有 provider 设图像端点只能经控制台或 API。**方向**：增加 `hh provider` 的对应子命令。**依据**：阅读 `hh provider --help` 的观察。
- **现状**：没有真实画图服务的验证。**方向**：在 `pnpm test:real` 中加入可选的图像检查。**依据**：TODO“路由组成员与 Key 预算”的“未验证：真实厂商的经 Chat 画图”。
