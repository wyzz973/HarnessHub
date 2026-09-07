# ADR 0011：在 Driver 内适配公司 Chat Completions 网关

- 状态：accepted
- 日期：2026-09-07
- 场景：公司已有 Gateway 改动不能上传，比赛模型服务只提供 OpenAI Chat Completions。固定 Codex 0.153.4 只使用 Responses；固定 Gemini CLI 0.58.0 使用 Google GenerateContent。

## 决定

对 Codex、Gemini 显式选择 `provider.protocol: openai-completions` 时，由所属 Worker 在配置准备阶段建立 Session 私有的协议桥。公司 `baseUrl` 是包含可选 `/v1` 或网关路径前缀的基础地址，桥只向 `${baseUrl}/chat/completions` 发送模型请求。桥位于 [drivers/chat-completions](../../src/drivers/chat-completions/bridge.ts)，不在 Gateway 增加引擎分支，也不修改、替代公司的 Gateway。

桥绑定 `127.0.0.1` 的随机端口并生成随机鉴权令牌；引擎只收到本地令牌，公司模型秘密由桥在内存中用于上游鉴权。未绑定活动 Run、鉴权失败或带浏览器 Origin 的请求不会转发。上游禁止重定向，错误只返回状态和固定说明，不透传认证头、原始响应或异常正文。已有 Worker 环境契约仍允许原生工具继承其父进程环境，这不代表 OS 级秘密隔离。

每次 Run 开始绑定其 AbortSignal；请求客户端断开、Run 取消或 Session 关闭都会取消上游请求。Worker 在发布结果前等待桥的本 Run 请求结束。探测只初始化 ACP，finally 等待关闭监听器。每个 Session 最多同时处理两个模型请求，请求和响应各限 8 MiB；此限制与模型 Token 上限不同。超限、不完整 SSE、无完成原因、未知工具或 Token 截断均不能生成成功完成事件。

## 支持与明确限制

| 原生协议 | 可转换行为 | 不支持的行为 |
|---|---|---|
| Responses | 完整文本历史、system/developer 指令、文本流、标准 function 调用与结果、usage、JSON 输出格式、并行工具；custom 工具通过 `input` 字符串参数往返；namespace 工具使用稳定名称映射后恢复 | `previous_response_id`、服务端存储/压缩、加密推理历史、多模态、托管 Web Search 和其他托管工具 |
| Google GenerateContent | 文本历史、systemInstruction、流式/非流式 GenerateContent、functionDeclarations/functionCall/functionResponse、标准 JSON Schema、usage、文本/JSON 输出 | 缓存内容、Google 专用安全设置、思考签名、多模态、Google 托管搜索、Token 计数/嵌入接口以及无法等价转换的生成参数 |

Codex 的本地配置显式关闭原生推理摘要、设置 reasoning effort 为 none、关闭 hosted Web Search 和 WebSocket；不对不兼容请求自动改协议、改模型或重试。固定 codex-acp 默认使用另一个 Guardian 模型自动审批，Chat 配置明确选择官方 `INITIAL_AGENT_MODE=read-only`，其实际策略是 workspace-write、on-request 和 user reviewer；审批由 ACP 回到 HarnessHub，并未取消审批或切换 full access。custom `apply_patch` 的原始输入由模型放在 JSON `input` 字符串内，恢复后仍由 Codex 的原生工具校验、审批和执行；桥不执行工具。

Gemini 的私有 settings 使用 API-key 认证入口，`model.name` 及核心模型调用固定到用户配置的 model，禁用 thinking、topK、Google Web Search 与 Web Fetch；已登记的工作目录用于非交互启动。固定 Gemini ACP 不广告任意自定义模型 ID，因此模型由初始化前的原生配置选择，Driver 不再发一个必然不支持的 ACP set-model。桥仍核对请求模型，公司上游仅收到所配置的模型。Google 专用子模型若不属于这个配置会明确失败，公司 Agent 应按真实模型能力修改并补验收，不能把未经验证的别名路由计为通过。

Gemini 0.58.0 在关闭 thinking 后仍会给 functionCall 历史插入固定字符串 `skip_thought_signature_validator`。桥仅剥除 functionCall 上这个没有推理内容的原生标记；其他签名、thought 内容或文本块上冒用的标记仍被拒绝，并有正反例验证。

MCP 工具仍由原生引擎或其受控适配层管理，Skills 仍按既有固定指纹的用户选定内容注入。协议桥不代替 MCP、Skills、工具审批和文件隔离，也不增加公共数据库写入者。

## 验证

新增 [协议与资源测试](../../tests/unit/chat-completions.test.ts)覆盖文本/工具映射、拒绝不支持行为、鉴权、Run 所有权、断流、取消和监听器关闭。[正式 Gateway/Worker 集成](../../tests/integration/chat-completions.test.ts)用真实 HTTP、SQLite、Worker 与 ACP peer 验证双协议、Skills/MCP 下发、实际权限决定、文件产物、同 Session 重复 Run、取消、进程及端口消失、数据库不含模型秘密。

[直接 Worker 回归](../../tests/integration/chat-worker-reuse.test.ts)连续 100 次把结果 ACK 与下一 Run 紧邻发送。结果 ACK 在 Worker 同步释放已完成的 Run 所有权，避免下一条 IPC 先于 Promise 清理续体到达而被误判为忙。Driver 和桥的异步清理仍在结果发布之前完成。

固定引擎验证使用本地合成 Chat API，不消耗外部模型额度。真实公司网关的工具调用、结构化输出和流式能力须在公司网络按交接 Skill 独立验收；本地合成服务通过不等于公司模型通过。

## 源码依据

- [Codex 0.153.4 Responses SSE 解析器](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-api/src/sse/responses.rs)、[协议工具类型](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/models.rs)，读取于 2026-09-07。
- [Gemini CLI 0.58.0 内容生成器](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/core/src/core/contentGenerator.ts)，以及固定发行包中的 ModelConfigService、配置 schema 和 CLI auth 验证器，读取于 2026-09-07。

替代方案是要求公司 Gateway 新增 Responses/Google 协议，或只启用原生支持 Chat 的引擎。前者不符合公司现有接口约束，后者无法让这两个开源引擎参与同一模型服务的测试。这里用显式、有限的 Driver 转换承担适配成本，并保持未支持能力可观察。
