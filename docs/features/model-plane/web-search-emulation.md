# 联网搜索模拟

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | 网关单元测试（Anthropic 的 server tool 块与 Responses 的 `web_search_call` 呈现、没有后端时不变、6 轮上限、每轮与每个请求的查询上限、每次查询占用每分钟请求数、各家搜索 API 答复的解析与会自己搜索的主机、只按带类型的工具或历史项触发）；经正式守护进程的集成测试覆盖后端的添加、密钥进入秘密存储与被拒绝时的字段指针；备份与同步测试覆盖搜索 Key；macOS arm64。真实 Tavily、Brave、Exa、Firecrawl、SearXNG 与真实客户端对搜索块的显示未验证；Windows 未验证 |
| 对照 Magpie | 部分：只用搜索 API，没有“会搜索的模型”后端；只服务 Responses `web_search` 与 Anthropic `web_search_*`（[对照表](../../magpie-parity.md#gateway-and-protocols)） |
| 权威文档 | [联网搜索模拟](../../gateway-features.md#联网搜索模拟)、[ADR 0027](../../decisions/0027-gateway-features.md) |

## 用途

Codex、Claude Code 等客户端会给模型提供厂商在服务端执行的联网搜索工具，但别家的上游执行不了这种工具。登记了搜索后端后，网关自己完成搜索：把结果交给模型，再把搜索过程按客户端协议原生的形式展示出来，客户端不必知道上游换了厂商。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 设置 → 网关功能 → 联网搜索后端（添加、删除，Key 只发送一次，被拒绝的原因显示在对应栏下） |
| 命令行 | `hh gateway search add tavily\|brave\|exa\|firecrawl\|searxng [--base-url URL] [--key \| --key-from-stdin \| --key-from-env VAR \| --key-from-file PATH]`、`hh gateway search remove ID` |
| HTTP | `POST /api/v1/gateway/features/search`（`kind`、`key`、`baseUrl`）、`DELETE /api/v1/gateway/features/search/{id}`、`GET /api/v1/gateway/features` |

## 已实现的能力

- 后端 Tavily、Brave、Exa、Firecrawl 与 SearXNG，按登记顺序使用，前一个失败或没有结果时用下一个；每个后端至多 30 秒、取 6 个结果，每个结果至多 1500 个字符；查询发出之前经过出站脱敏。
- 密钥只在秘密存储中，设置文件只记引用；`--key-from-env` 只读取命令中指名的变量；`--base-url` 用于 SearXNG（必填）或替换厂商地址，不能带 `user:password@`；接口拒绝时 `errors[].pointer` 指向 `/key` 或 `/baseUrl`。
- 请求带类型以 `web_search` 开头的工具，或历史中有这类搜索项，且候选的上游不会自己执行时生效；消息或函数工具中出现 `web_search` 字样不算。直通到 `api.anthropic.com`（Anthropic）或 `api.openai.com`、`api.x.ai`、`api.deepseek.com`（Responses）的请求保留厂商自己的搜索，其他直通请求改为翻译。
- 网关把搜索工具换成函数工具 `web_search(query)`（客户端已有同名工具时为 `hh_web_search`），模型调用它时并行执行查询，把结果作为工具结果再问一轮；至多 6 轮，第 7 次时告诉模型“No more searches”。
- 每轮至多 `gateway.limits.maxSearchesPerRound`（默认 5）次、每个请求至多 `maxSearchesPerRequest`（默认 20）次查询，每次查询占用发出请求的 Key 的一个每分钟请求；不执行的查询以“Not run: …”告诉模型原因。
- 只调用搜索的回合对客户端不可见；模型同时调用客户端自己的工具时这些调用交给客户端，搜索调用被丢弃；各轮的文本连成一个答复，用量合计。
- 客户端看到原生形式：Anthropic 为 `server_tool_use`（id `srvtoolu_hh_…`）与 `web_search_tool_result` 块，Responses 为 `web_search_call` 项（id `ws_hh_…`，带 `query` 与 `sources`）；这些带标记的块在之后的请求中转成给模型看的文字。
- 账本 `patches[]` 记 `search:emulated`、`search:rounds:<n>`、`search:queries:<n>` 与 `search:refused:<n>`。
- 没有搜索后端时，全局接线为不原生接收 Responses 的模型给 Codex 写入 `web_search = "disabled"`；登记第一个后端或删除最后一个后，目录同步改写已接线 Codex 的文件（[Codex 的两种模式](../../global-wiring.md#codex-的两种模式)）。
- 后端随备份与同步带走；恢复与同步只接受存储中的搜索 Key，外部引用列入 `search.refused`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [gateway/search.ts](../../../packages/gateway/src/search.ts)、[gateway/limits.ts](../../../packages/gateway/src/limits.ts)、[core/gateway-features.ts](../../../packages/core/src/gateway-features.ts)、[daemon/gateway-features.ts](../../../packages/daemon/src/gateway-features.ts)、[daemon/gateway-features-routes.ts](../../../packages/daemon/src/http/gateway-features-routes.ts)、[console/gateway-features-page.tsx](../../../packages/console/components/gateway-features-page.tsx) |
| 测试 | [shared-gateway-search](../../../packages/gateway/test/shared-gateway-search.test.ts)、[core gateway-features](../../../packages/core/test/gateway-features.test.ts)；集成 [gateway-features](../../../tests/integration/gateway-features.test.ts)、[backup-features](../../../tests/integration/backup-features.test.ts)、[backup-sync-security](../../../tests/integration/backup-sync-security.test.ts) |
| 决策 | [ADR 0027](../../decisions/0027-gateway-features.md)、[ADR 0032 补充二](../../decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下)（查询次数上限与每分钟请求数） |

## 已知限制与未验证

- 只用搜索 API；Magpie 首选的“由会搜索的模型执行”没有实现。
- Chat 的 `web_search_options` 与 Gemini 的 `googleSearch` 不在范围内；没有后端时，翻译请求中的这类工具仍被拒绝（`Hosted Responses tool web_search is unsupported`）。
- 搜索 API 的调用不是单独的账本条目，其费用不计入 Key 的预算（HarnessHub 不知道各搜索 API 的价格），只按次数与每分钟请求数限制。
- 真实的五种搜索 API 与真实 Claude Code、Codex 对网关搜索块的显示未验证；Windows 未验证。

## 优化候选

- **现状**：Chat 与 Gemini 客户端的联网搜索不被模拟。**方向**：支持 Chat 的 `web_search_options` 与 Gemini 的 `googleSearch`。**依据**：对照表 Web search emulation 行为部分；[ADR 0027](../../decisions/0027-gateway-features.md) 后果中的“不在本次范围内”。
- **现状**：搜索花费不可见，也不受预算约束。**方向**：每个后端可填每次查询的价格，把搜索记入账本与 Key 的成本预算。**依据**：[ADR 0032 补充二](../../decisions/0032-group-rules-and-classifier.md#补充二网关自己的调用记在触发它的-key-名下)替代方案“把搜索 API 的费用计入预算”。
- **现状**：只能用搜索 API。**方向**：允许把一个会搜索的模型（例如带原生搜索的上游）登记为搜索后端。**依据**：ADR 0027 的替代方案与对照表的说明。
- **现状**：各家搜索 API 的答复只按公开格式解析。**方向**：增加可由持有 Key 的人手动运行的真实后端冒烟检查，类似 `pnpm test:real`。**依据**：[ADR 0027](../../decisions/0027-gateway-features.md) 验证要求中的“未验证”；[真实 provider 检查的做法](../../compatibility.md#怎样重复)。
