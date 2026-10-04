# 一致性套件

`conformance/` 是黑盒测试树（[10 第 1、3.3 节](../docs/proposals/oss/10-engineering.md#33-三类一致性套件)）：只经 `hh` 命令、HTTP 接口与 `@harnesshub/sdk` 操作 HarnessHub，不导入任何内部包，因此同一套用例也能对其他网关运行。边界检查（`tools/check-boundaries.mjs`）强制这一点，唯一的例外是协议套件的官方 SDK 客户端，见 [ADR 0029](../docs/decisions/0029-protocol-suite.md)。

目前只有协议套件；Adapter 与 Provider 套件、报文黄金语料 `corpus/` 和兼容矩阵生成器尚未建立（真实 Agent 的套件暂在 `tests/conformance/`）。

## 协议套件

```sh
pnpm build
pnpm test:protocol      # 也包含在 pnpm test 与 pnpm check 中
```

`conformance/protocols/` 在每个测试文件中启动一个严格假上游（`tools/fake-provider`，白名单模式，只监听回环）和一个 `hh serve`，经 `@harnesshub/sdk` 为每种上游协议建一个 provider 和一个 Gateway Key，再用各入站协议的官方 SDK 当客户端：

| 入站协议 | 客户端（根 `package.json` 固定版本） |
|---|---|
| OpenAI Chat Completions、Responses | `openai` |
| Anthropic Messages | `@anthropic-ai/sdk` |
| Gemini | `@google/genai` |

每个用例覆盖 4 种入站 × 4 种上游的 16 个方向（同协议即直通），流式与非流式各一遍：

| 文件 | 内容 |
|---|---|
| `conversation.test.ts` | 单轮与多轮文本、推理、图片、带缓存读取的 usage、`length` 与 `content_filter` 停止原因 |
| `tools.test.ts` | 推理后的单个工具调用及其签名回传、两个并行调用（含上游交错的参数增量）、Responses 的 custom 工具 |
| `failures.test.ts` | 上游 400、401、500、上下文超长、带与不带 `Retry-After` 的 429（网关与 SDK 各自遵守等待），流中断开与流内错误 |
| `keepalive.test.ts` | 上游在首个数据前只发保活 11.5 秒：流式在数据之前收到入站协议自己的保活，SDK 读完整个答复 |

断言：SDK 解析每个响应和流而不报错；失败时 SDK 抛出与状态码对应的错误类型；`Retry-After` 被遵守；每个文件最后检查严格上游记录的字段违规为零。用例以提示中的唯一标记选中假上游的脚本回合，错误用例各用一个 provider，互不受熔断影响。

所有 Key 都是合成的金丝雀值，进程只在回环地址监听，测试在 `tools/run-tests.mjs` 的私有 HOME 中运行。套件依赖从仓库根目录运行（它按工作目录找到 `apps/hh/bin/hh.mjs` 与 `tools/fake-provider/index.mjs`）。

`conformance/real/matrix.ts` 是同一批客户端对真实上游的矩阵：每种入站协议、流式与非流式各一轮文本与一次工具往返，模型答错时重试并报告；`pnpm test:real` 启动网关后运行它（见[兼容性](../docs/compatibility.md#怎样重复)）。

尚未覆盖：Vercel AI SDK 与 Python SDK；对真实 provider 的在线抽样；直通用例的逐字节黄金语料比较；Open Responses 的验收用例；`count_tokens` 与 `/v1/models`。
