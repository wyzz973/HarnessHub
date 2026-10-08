# 协议比较与适配策略

状态：proposed。阅读日期：2026-10-09。协议、传输、SDK、厂商运行契约分别管理；“使用 JSON-RPC”不意味着两个协议可以互换。

| 协议/标准 | 实际解决的问题 | 本项目用法建议 | 明确不保证 |
|---|---|---|---|
| ACP v1 | Client 驱动编码 Agent，协商能力、原生会话、prompt、更新、权限和取消 | 首选本地 Harness Adapter；stdio 为基线 | Provider 配置通用化、权限全覆盖、任意跨 Harness 原生迁移 |
| ACP v2 | 新版控制面草案 | 只跟踪研究，不作为默认稳定依赖 | wire/API 兼容稳定 |
| MCP | Harness 与工具/资源连接 | 通过后端声明的版本和加载能力配置；必要控制由适配器验证 | Harness 生命周期、公共 Session 或统一审批 |
| A2A 1.0 | 独立 Agent 的发现、消息、任务、取消与事件 | 后续远程 Adapter/入口候选 | 本机进程树回收、工作区写租约、实际任务质量 |
| AG-UI | 用户交互、消息/工具/状态/run 事件 | 后续入口映射；公共领域模型不依赖其事件枚举 | Harness 安装、执行控制、持久事件可靠性 |
| 原生 App Server/SDK | 厂商自己的生命周期与能力 | ACP 缺能力或不成熟时独立适配 | 不同厂商相同的成功、取消、恢复语义 |
| JSON-RPC 2.0 | 请求/响应/通知信封 | ACP 与原生协议各自遵循自己的 wire 规范 | 通知的完成确认或持久接收 |
| HTTP + SSE | 调用与单向事件流 | 自有 versioned REST + 持久事件游标，SDK 使用 fetch 流 | Exactly-once、副作用回滚、服务端历史存储 |
| OpenAPI / JSON Schema | 契约描述和输入校验 | 单一 schema 来源、生成类型与客户端并检查漂移 | 自动证明业务不变量 |

## 1. ACP 的实际基线

[官方 overview](https://agentclientprotocol.com/protocol/v1/overview)、[初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[Session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)已经打开核对。initialize 交换版本与能力，new/prompt/update/cancel 是基线；load、resume、close 等只有明确支持才调用。收到 cancel 通知不是取消完成，必须等待原 prompt 的对应结果及本地资源证据。

[Config options](https://agentclientprotocol.com/protocol/v1/session-config-options)允许后端公布 model 等配置选项并通过 set_config_option 修改；这不能推导任意 Provider 都能被接入。只使用实际公布的 ID/选项，保存返回的完整配置；模型能力变化重新校验。

固定源码 docs/protocol/v1/transports.mdx 中，stdio 是明确传输，Streamable HTTP 仍标 draft。SDK 虽有 HTTP/WS 实现，不据此提升协议成熟度。SDK 快照 package.json 为 1.7.0；实现锁版前仍需发行包和真实后端组合验证。

[ACP TCK](https://agentclientprotocol.com/libraries/testing)是实验性、不完整的兼容测试；通过不代表官方一致性认证。可复用它已覆盖的要求，但取消竞态、进程残留、公共 Session 与交接需要自有用例。

## 2. MCP 的版本边界

[2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)与[传输](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)明确无状态、每请求能力与请求范围通信；[2025-11-25 transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)是另一套版本契约。后端仍使用旧版时按显式版本支持，而不是把旧响应形状作为新版 fallback。

本项目第一阶段不自建完整 MCP 聚合器。工具加载、协议版本、HTTP 身份、秘密暴露和权限覆盖由 Adapter 能力记录约束。需要外部审批而后端不提供可靠往返时，该执行组合不可进入相应策略的候选集。

旧版 Streamable HTTP 的服务端 Session 本身可以不建立；initialize 的协议生命周期与是否分配 Session-ID 不是同一概念。这里的版本差异不表示所有 2025 后端必须保存服务端会话。

## 3. A2A 与 AG-UI 的位置

[A2A 当前规范](https://a2a-protocol.org/latest/specification/)与[1.0 入口](https://a2a-protocol.org/v1.0.0/)区分 context、task 和消息，任务可独立于订阅流；不同版本的路径、枚举和版本头也不同。公共 Session 可以映射 context，但不直接采用远端 task 生命周期作为本地领域状态。

[AG-UI 事件](https://docs.ag-ui.com/concepts/events)适合把已提交公共事实映射给交互客户端；内部保留自己的事件身份、顺序、持久性和清理状态，不把 run-finished 当作任务内容正确。

## 4. 对外契约与模型协议

[JSON-RPC](https://www.jsonrpc.org/specification)、[SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)、[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)、[JSON Schema 2020-12](https://json-schema.org/draft/2020-12)、[OpenAPI 3.2](https://spec.openapis.org/oas/v3.2.0.html)作为参考。OpenAPI 具体锁版取决于生成器对 SSE 的验证；不能先宣称生成内容与实现等价。

模型访问采用当前 Harness 实际支持的 Provider 协议。首版优先同协议转发和可核对归属；完整 N×M 转换延后。协议丢失工具、结构化输出、媒体或推理信息时明确拒绝或经显式策略记录损失，不静默降级。

## 5. 版本记录

每次验收记录：规范版本、schema/SDK 版本、Harness 二进制与 Adapter 版本、固定源码 SHA、OS/架构、模型目标、已协商能力、用例与未覆盖项。包主版本不能代替协议协商；“最新规范”链接仅用于发现，固定 commit 与 schema 才用于重现。
