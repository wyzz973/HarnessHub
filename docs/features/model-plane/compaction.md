# 上下文压缩

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（七种 Agent 的压缩请求与不应识别的样例、请求改写、流式任意切分与 JSON 的摘要改写、失败与错误答复、没有摘要、封存项的去除顺序与网关自己的推理）、Codex 透传测试（`/responses/compact` 的 400 与摘要、推理的换回）；经正式守护进程连接白名单模式假 provider 的集成测试，对 Responses 直通与 Chat 转换、流式与非流式各做一次压缩与恢复，并以 `foreignSeals` 怪癖验证封存项被拒绝后的重发；路由规则的 `compact` 条件另有规则测试；macOS arm64。真实 Codex 的 `compaction_trigger` 对真实上游未验证；Windows 未验证 |
| 对照 Magpie | 相同：网关为 `compaction_trigger` 生成摘要，HarnessHub 模型的 `/responses/compact` 答复 400；差别是被拒绝的封存项每轮重新被拒绝一次，Magpie 按会话记住后预先去掉（[对照表](../../magpie-parity.md#gateway-and-protocols)） |
| 权威文档 | [上下文压缩](../../gateway-features.md#上下文压缩)、[Codex 透传](../../model-gateway.md#codex-透传) |

## 用途

Agent 在上下文将满时请模型把对话写成摘要。Codex 的压缩依赖 ChatGPT 后端，网关让它在任何上游上都能完成，并把摘要放回之后的请求；网关还识别各家 Agent 的压缩请求，供路由组把压缩交给合适的模型，以及处理一个账号或厂商封存、另一个读不了的推理与压缩项。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 无（总是生效）；路由组的规则编辑器可写 `compact` 条件 |
| 命令行 | `hh group rule add <id> use=MEMBER compact`（压缩请求的路由规则） |
| HTTP | `POST /v1/responses` 中的 `compaction_trigger`；`POST /v1/responses/compact` 答复 400；Codex 透传 `/backend-api/codex/responses` |

## 已实现的能力

- `isCompactionRequest(protocol, body)` 按各 Agent 发布版本中的压缩提示词识别：system 是 Claude Code 2.1、OpenCode、Pi、Gemini CLI 或 Qwen Code 的压缩提示词，或最后一条用户消息含 Claude Code `/compact`、Codex 或 Kimi Code 的压缩要求，或 Responses 输入中有 `compaction_trigger`；路由规则的 `compact` 条件用它（[rules.ts](../../../packages/gateway/src/rules.ts)），账本记 `rule:compact:<n|none>`。
- `/v1/responses` 中的 `compaction_trigger` 换成 Codex 自己的压缩提示词（openai/codex，Apache-2.0）的用户消息，请求去掉 `tools`、`tool_choice` 与 `parallel_tool_calls`，按普通调用路由（直通或转换）。
- 答复改写为 ChatGPT Codex 后端的形式：模型的文字成为一个 `compaction` 项，`id` 为 `cmp_<响应 ID>`，`encrypted_content` 为 `hh1:` 加摘要的 base64；流式时开头事件立即转发，模型自己的项扣下，最后写出该项与带用量的 `response.completed`；账本记 `compaction:summary`。
- 模型没有写出摘要时在记账前判定失败：账本记 502 `compaction_empty`（上游用量照常计入），客户端得到 502 或 `response.failed`。
- 之后的请求中 `hh1:` 开头的 `compaction` 或 `compaction_summary` 项换成用户消息（Codex 的摘要前言、换行与摘要），账本记 `compaction:restored:<n>`；OpenAI 封存的压缩项不变；Codex 透传同样换回，但透传中的 `compaction_trigger` 属于 ChatGPT 自己的模型，原样转发。
- `/v1/responses/compact`，以及 Codex 透传中模型带 `/` 的同一路径，答复 400 `compact_unsupported` 并写拒绝记录，不转发给 ChatGPT。
- 网关自己编码的推理（`hh-r1.`）不直通到 Responses 上游、也不经透传发给 ChatGPT（`reasoning:dropped:<n>`）；上游以 `invalid_encrypted_content` 等拒绝封存内容时，先去掉推理项、再去掉封存的压缩项，在同一候选上至多重发两次（`sealed:reasoning`、`sealed:compaction`），不计入熔断；只用于 Responses 入站。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/compacting.ts](../../../packages/gateway/src/compacting.ts)、[gateway/codex.ts](../../../packages/gateway/src/codex.ts)、[gateway/rules.ts](../../../packages/gateway/src/rules.ts) |
| 测试 | [gateway-compaction](../../../packages/gateway/test/gateway-compaction.test.ts)、[shared-gateway-codex](../../../packages/gateway/test/shared-gateway-codex.test.ts)、[group-rules](../../../packages/gateway/test/group-rules.test.ts)；集成 [shared-gateway-tool-search-compaction](../../../tests/integration/shared-gateway-tool-search-compaction.test.ts) |
| 决策 | [ADR 0032](../../decisions/0032-group-rules-and-classifier.md)（`compact` 规则）、[ADR 0030](../../decisions/0030-codex-chatgpt-mode-models.md)（透传中的 HarnessHub 模型） |

## 已知限制与未验证

- 被上游拒绝的封存项不按会话记住：换了账号或厂商后，每一轮都先被拒绝一次再去掉重发，多一次往返。
- 只有 Codex 的 `compaction_trigger` 由网关生成摘要；其他 Agent 的压缩请求按普通调用路由。识别只在请求的路由组（或其中的组）有规则时进行（`rules.ts` 的 `ruled`），其余请求的账本不记录它是不是压缩请求。
- 真实 Codex 的 `compaction_trigger` 对真实上游未验证；Windows 未验证。

## 优化候选

- **现状**：被拒绝的封存项每轮重新被拒绝一次。**方向**：按会话记住被拒绝的封存项，之后的请求预先去掉（Magpie 的 refusedSeals）。**依据**：TODO“工具搜索与上下文压缩”的“未做”；对照表 Codex compaction 行的说明。
- **现状**：不在规则中的压缩请求在账本中无法区分。**方向**：对识别出的压缩请求总记一个补丁，使用量可以按“压缩”拆分。**依据**：[上下文压缩](../../gateway-features.md#上下文压缩)“账本没有单独的字段”，只在命中规则时写 `rule:compact:*`。
- **现状**：只用假 provider 验证。**方向**：用真实 Codex 对真实上游触发一次压缩并恢复。**依据**：TODO 同一条的“未验证”。
