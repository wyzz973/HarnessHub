# 工具搜索

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（请求改写、命名空间合并、空结果、长名称、流式任意切分与 JSON 答复的改回、带命名空间的同名调用不改、两种转换）；经正式守护进程连接白名单模式假 provider 的集成测试（`execution`、`tools`、`defer_loading` 在那里都是违规字段），对 Responses 直通与 Chat 转换、流式与非流式各做一次搜索往返并调用找到的工具，以及 Anthropic 到 Chat 的 `tool_reference`；macOS arm64。真实 Codex 与 Claude Code 对真实上游未验证；Windows 未验证 |
| 对照 Magpie | 相同：Codex `tool_search` 与 Claude Code `tool_reference` 的改写，HarnessHub 在 Responses 直通上也改写（[对照表](../../magpie-parity.md#gateway-and-protocols)） |
| 权威文档 | [工具搜索](../../gateway-features.md#工具搜索) |

## 用途

Codex 与 Claude Code 可以先不把全部工具发给模型，让模型按需搜索工具。只有厂商自己的后端认识这类工具，网关把它们改写成任何上游都能执行的普通函数与文字，Agent 换到别家模型时仍能按需加载工具。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 无（总是生效，没有设置） |
| 命令行 | 无 |
| HTTP | 无单独接口：作用于 `/v1/responses`、`/v1/messages` 等模型调用与 Codex 透传中 HarnessHub 的模型 |

## 已实现的能力

- Codex 的 `tool_search` 工具（`execution: "client"`，由 Codex 自己执行搜索）发往上游时是普通函数 `tool_search`，描述与参数不变。
- 历史中的 `tool_search_call` 改为对它的 `function_call`，`tool_search_output` 改为 `function_call_output`，内容为 “These tools are now available to call: a, b”（没有结果时为 “No tools matched the search.”）。
- 找到的工具去掉 `defer_loading` 后加入工具列表，每个只加一次，同一命名空间再次找到时只补上缺少的工具。
- 模型调用 `tool_search` 函数（不带命名空间）时，答复中的该项改回 Codex 执行的 `tool_search_call`（`execution: "client"`，`arguments` 为对象），流式事件与 JSON 答复都改。
- 直通到 Responses 上游时改写请求体，账本记 `tool-search:function`；转换的请求（Chat 等上游）在转换中完成，`tool_search_call` 的 ID 以 `tsc_` 开头；订阅账号的请求总是转换。
- `execution` 不是 `client` 的托管搜索仍按托管工具拒绝。
- Claude Code：ToolSearch 工具结果中的 `tool_reference` 块在转换时成为 “Tool X is loaded and can be called now.”，`DeferredToolPlaceholder` 工具不提供给模型，工具定义上的 `defer_loading` 不发送；直通到 Anthropic 端点时原样发送。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/toolsearch.ts](../../../packages/gateway/src/toolsearch.ts)、[gateway/call.ts](../../../packages/gateway/src/call.ts)（`tool-search:function` 补丁） |
| 测试 | [gateway-tool-search](../../../packages/gateway/test/gateway-tool-search.test.ts)；集成 [shared-gateway-tool-search-compaction](../../../tests/integration/shared-gateway-tool-search-compaction.test.ts)；[假 provider](../../../tools/fake-provider/README.md) |
| 决策 | 无单独的 ADR；任务记录见 [TODO.md](../../../TODO.md) 的“工具搜索与上下文压缩” |

## 已知限制与未验证

- 只在直通到 Responses 上游的改写处记补丁 `tool-search:function`；转换路径上完成的改写在账本中没有标记。
- `execution` 不是 `client` 的托管工具搜索不被模拟，翻译时拒绝。
- 尚未用真实 Codex 与 Claude Code 对真实上游验证；Windows 未验证。

## 优化候选

- **现状**：转换路径上的工具搜索改写不在账本中留下痕迹。**方向**：转换时同样记一个补丁（例如区分直通与转换），便于排查 Agent 找不到工具的问题。**依据**：阅读 [call.ts](../../../packages/gateway/src/call.ts) 与 [toolsearch.ts](../../../packages/gateway/src/toolsearch.ts) 的观察（只有直通改写处记补丁）。
- **现状**：只用假 provider 验证。**方向**：在真实 Agent 一致性套件中加入 Codex 与 Claude Code 的工具搜索用例（需要按需加载的工具），并对真实上游跑一次。**依据**：[工具搜索](../../gateway-features.md#工具搜索)“验证”中的“尚未用真实 Codex 与 Claude Code 对真实上游验证”；[真实 Agent 兼容性](../../compatibility.md)。
