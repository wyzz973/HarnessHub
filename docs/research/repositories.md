# 开源实现比较与阅读证据

日期：2026-10-09。固定 commit 来自公开仓库 API；选读代码不代表全仓审计或运行验收。厂商 SDK 的公开仓库也不自动意味着运行时为开源许可。

| 项目 | 研究角色 | 固定快照 | 阅读范围 |
|---|---|---|---|
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | 多后端交互产品 | [7af57f8a5411](https://github.com/OpenHands/OpenHands/tree/7af57f8a54115a84d7215192f822850707369122) | README、agent-server-adapter.ts、session-frames.ts |
| [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | 运行 SDK/服务端 | [16662b0bd2c1](https://github.com/OpenHands/software-agent-sdk/tree/16662b0bd2c1a93d3c5e282b48da05b95e90a0c8) | session_protocol.py、conversation_router.py、ACP 示例 |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | Agent 协作协议 | [12e9d2fbb9ba](https://github.com/a2aproject/A2A/tree/12e9d2fbb9badfe98f8ab4f660697870eeb1940b) | README、当前 1.0 规范与版本/取消段 |
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) | 用户交互协议 | [4c3e36d31dc1](https://github.com/ag-ui-protocol/ag-ui/tree/4c3e36d31dc1adedd48b03126ffbb737e8251118) | README、官方事件页与 schema 页面 |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | 协议基线 | [5ed386e81033](https://github.com/agentclientprotocol/agent-client-protocol/tree/5ed386e81033918fe5e3a0503beaa6030280666e) | README、v1 初始化/会话/prompt/config/工具/传输与 meta schema |
| [agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk) | 官方客户端 | [17720e4d24d8](https://github.com/agentclientprotocol/typescript-sdk/tree/17720e4d24d89af34a05f11d1fe77d1d70b97dd6) | package.json、connection.ts、stream.ts |
| [agentgateway/agentgateway](https://github.com/agentgateway/agentgateway) | 模型/MCP/A2A 流量网关 | [1170b64ad456](https://github.com/agentgateway/agentgateway/tree/1170b64ad4568e479f8671a02c9c56f53b8686f5) | README、mcp/README.md、a2a/mod.rs |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | ACP 与 HTTP Harness | [687664c63b2b](https://github.com/anomalyco/opencode/tree/687664c63b2bb4eb9b9c7e0dc37227869282ed80) | 官方 server 文档、acp/session/permission/config-option、session routes |
| [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) | 厂商 SDK | [799dc78749f5](https://github.com/anthropics/claude-agent-sdk-typescript/tree/799dc78749f5568e2965699c6ed4d2542031082d) | 官方 overview/sessions/permissions、README、LICENSE、CHANGELOG |
| [badlogic/pi-mono](https://github.com/earendil-works/pi) | 原生 RPC Harness | [6fb2e7815167](https://github.com/earendil-works/pi/tree/6fb2e7815167e6b19006fc526d1a5d0f5f998787) | README、rpc.md、rpc-types.ts、rpc-mode.ts |
| [coder/agentapi](https://github.com/coder/agentapi) | 终端抓取路线对照 | [7c468d5b25ec](https://github.com/coder/agentapi/tree/7c468d5b25ec9d3d76c41313cf4e08904ff5968d) | README 与仓库 archived 元数据 |
| [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) | 工具协议 | [c518f7a927cf](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/c518f7a927cff918bce35d3522fcdb046d264d7c) | README、LICENSE、2026/2025 官方规范和传输 |
| [openai/codex](https://github.com/openai/codex) | 原生 Harness | [9b738582b13c](https://github.com/openai/codex/tree/9b738582b13c2cdbeff54af0afd04c50c3e7ba09) | 官方 App Server 文档、app-server README、protocol/v2 的 mod/thread/turn |
| [openclaw/acpx](https://github.com/openclaw/acpx) | 无头 ACP 客户端 | [b3cd84337952](https://github.com/openclaw/acpx/tree/b3cd84337952e0d2cadd094f564612e89d71daa5) | runtime.ts、prompt-turn.ts、controls.ts、reuse-policy.ts |
| [rivet-dev/sandbox-agent](https://github.com/rivet-dev/agents) | 聚合执行 API | [d00849b2a391](https://github.com/rivet-dev/agents/tree/d00849b2a3914a9d771f5f4c2b6a6e876e0edf16) | 子目录 README、session-persistence/restoration、ACP proxy/process |
| [yetone/magpie](https://github.com/yetone/magpie) | 模型与配置管理对照 | [ed31293c0ee1](https://github.com/yetone/magpie/tree/ed31293c0ee1bc57f2ff26b50ebd3876fddd8df9) | README 与元数据 |

## OpenHands/OpenHands

采用/借鉴候选：参考统一界面与后端防腐适配；依赖层和后端帧分开。

边界与不采纳：产品切换体验不是跨 Harness 语义无损或任务择优的证明。

许可/状态：元数据 MIT；archived=false。

固定阅读位置：[src/api/agent-server-adapter.ts](https://github.com/OpenHands/OpenHands/blob/7af57f8a54115a84d7215192f822850707369122/src/api/agent-server-adapter.ts)；[src/types/agent-server/session-frames.ts](https://github.com/OpenHands/OpenHands/blob/7af57f8a54115a84d7215192f822850707369122/src/types/agent-server/session-frames.ts)。

## OpenHands/software-agent-sdk

采用/借鉴候选：参考 durable 与 transient frame 分离、cursor、背压和版本化 envelope。

边界与不采纳：未选用整个服务端；目录/接口所有权和领域模型仍由本项目定义。

许可/状态：元数据 MIT；archived=false。

固定阅读位置：[openhands-agent-server/openhands/agent_server/session_protocol.py](https://github.com/OpenHands/software-agent-sdk/blob/16662b0bd2c1a93d3c5e282b48da05b95e90a0c8/openhands-agent-server/openhands/agent_server/session_protocol.py)；[examples/01_standalone_sdk/40_acp_agent_example.py](https://github.com/OpenHands/software-agent-sdk/blob/16662b0bd2c1a93d3c5e282b48da05b95e90a0c8/examples/01_standalone_sdk/40_acp_agent_example.py)；[openhands-agent-server/openhands/agent_server/conversation_router.py](https://github.com/OpenHands/software-agent-sdk/blob/16662b0bd2c1a93d3c5e282b48da05b95e90a0c8/openhands-agent-server/openhands/agent_server/conversation_router.py)。

## a2aproject/A2A

采用/借鉴候选：研究 context/task 分离、版本协商和独立事件订阅。

边界与不采纳：远程 task 不直接成为本机公共业务状态。

许可/状态：元数据 Apache-2.0；archived=false。

## ag-ui-protocol/ag-ui

采用/借鉴候选：将来可把公共事件映射到兼容交互入口。

边界与不采纳：不作为内部领域状态机或 Harness 监督协议。

许可/状态：元数据 MIT；archived=false。

## agentclientprotocol/agent-client-protocol

采用/借鉴候选：采用稳定 wire v1 与能力协商；取消等待原 prompt 结算。

边界与不采纳：v2 与 HTTP 草案不默认稳定；原生会话不作为公共 Session。

许可/状态：元数据 Apache-2.0；archived=false。

固定阅读位置：[docs/protocol/v1/initialization.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/5ed386e81033918fe5e3a0503beaa6030280666e/docs/protocol/v1/initialization.mdx)；[docs/protocol/v1/tool-calls.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/5ed386e81033918fe5e3a0503beaa6030280666e/docs/protocol/v1/tool-calls.mdx)；[docs/protocol/v1/session-config-options.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/5ed386e81033918fe5e3a0503beaa6030280666e/docs/protocol/v1/session-config-options.mdx)；[docs/protocol/v1/session-setup.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/5ed386e81033918fe5e3a0503beaa6030280666e/docs/protocol/v1/session-setup.mdx)。

## agentclientprotocol/typescript-sdk

采用/借鉴候选：参考请求相关、stdio framing、类型和能力边界；快照版本 1.7.0。

边界与不采纳：SDK 版本与 wire version 分离；先做畸形输入、背压和关闭验证。

许可/状态：元数据 Apache-2.0；archived=false。

固定阅读位置：[src/stream.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/17720e4d24d89af34a05f11d1fe77d1d70b97dd6/src/stream.ts)；[package.json](https://github.com/agentclientprotocol/typescript-sdk/blob/17720e4d24d89af34a05f11d1fe77d1d70b97dd6/package.json)；[src/connection.ts](https://github.com/agentclientprotocol/typescript-sdk/blob/17720e4d24d89af34a05f11d1fe77d1d70b97dd6/src/connection.ts)。

## agentgateway/agentgateway

采用/借鉴候选：参考路由策略与控制面/数据面边界。

边界与不采纳：网络流量代理不自动提供本机 Harness 的进程、权限和公共连续性。

许可/状态：元数据 Apache-2.0；archived=false。

固定阅读位置：[crates/agentgateway/src/mcp/README.md](https://github.com/agentgateway/agentgateway/blob/1170b64ad4568e479f8671a02c9c56f53b8686f5/crates/agentgateway/src/mcp/README.md)；[crates/agentgateway/src/a2a/mod.rs](https://github.com/agentgateway/agentgateway/blob/1170b64ad4568e479f8671a02c9c56f53b8686f5/crates/agentgateway/src/a2a/mod.rs)。

## anomalyco/opencode

采用/借鉴候选：首个 ACP 候选；核对 provider/model 选项与实际权限映射。

边界与不采纳：ACP 与 HTTP 入口不混用；中断 ACK 与资源清理分别证明。

许可/状态：元数据 MIT；archived=false。

固定阅读位置：[packages/opencode/src/acp/session.ts](https://github.com/anomalyco/opencode/blob/687664c63b2bb4eb9b9c7e0dc37227869282ed80/packages/opencode/src/acp/session.ts)；[packages/opencode/src/acp/permission.ts](https://github.com/anomalyco/opencode/blob/687664c63b2bb4eb9b9c7e0dc37227869282ed80/packages/opencode/src/acp/permission.ts)；[packages/opencode/src/acp/config-option.ts](https://github.com/anomalyco/opencode/blob/687664c63b2bb4eb9b9c7e0dc37227869282ed80/packages/opencode/src/acp/config-option.ts)；[packages/opencode/src/server/routes/instance/httpapi/groups/session.ts](https://github.com/anomalyco/opencode/blob/687664c63b2bb4eb9b9c7e0dc37227869282ed80/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts)。

## anthropics/claude-agent-sdk-typescript

采用/借鉴候选：研究受控进程、resume 和权限回调的适配边界。

边界与不采纳：LICENSE 为商业条款，不能当开源代码复制或默认许可再分发。

许可/状态：元数据 None；archived=false。LICENSE.md states Anthropic commercial terms; not assumed open-source or redistributable

固定阅读位置：[LICENSE.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/799dc78749f5568e2965699c6ed4d2542031082d/LICENSE.md)；[CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/799dc78749f5568e2965699c6ed4d2542031082d/CHANGELOG.md)。

## badlogic/pi-mono

采用/借鉴候选：参考命令相关、流背压、accepted/agent_end/agent_settled 区别。

边界与不采纳：未内置完整权限限制；需要审批的策略不能自动认作兼容。

许可/状态：元数据 MIT；archived=false。

固定阅读位置：[packages/coding-agent/docs/rpc.md](https://github.com/badlogic/pi-mono/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/rpc.md)；[packages/coding-agent/src/modes/rpc/rpc-types.ts](https://github.com/badlogic/pi-mono/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/modes/rpc/rpc-types.ts)；[packages/coding-agent/src/modes/rpc/rpc-mode.ts](https://github.com/badlogic/pi-mono/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/modes/rpc/rpc-mode.ts)。

## coder/agentapi

采用/借鉴候选：归档和 deprecated 状态已核对，作为历史方法风险参照。

边界与不采纳：不采用抓取终端作为首要执行/完成协议。

许可/状态：元数据 MIT；archived=true。

## modelcontextprotocol/modelcontextprotocol

采用/借鉴候选：区分不同 wire 生命周期、工具能力和上下文。

边界与不采纳：当前许可迁移需按文件核验；不能混用两个版本协议。

许可/状态：元数据 NOASSERTION；archived=false。LICENSE describes MIT to Apache-2.0 transition; verify per-file license before reuse

固定阅读位置：[LICENSE](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/c518f7a927cff918bce35d3522fcdb046d264d7c/LICENSE)。

## openai/codex

采用/借鉴候选：研究 thread/turn、通知、审批、中断和 schema 生成作为独立 Adapter。

边界与不采纳：thread/turn 与公共 Session/Turn 分开；实验字段明确 opt-in。

许可/状态：元数据 Apache-2.0；archived=false。

固定阅读位置：[codex-rs/app-server/README.md](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/app-server/README.md)；[codex-rs/app-server-protocol/src/protocol/v2/mod.rs](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/app-server-protocol/src/protocol/v2/mod.rs)；[codex-rs/app-server-protocol/src/protocol/v2/thread.rs](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)；[codex-rs/app-server-protocol/src/protocol/v2/turn.rs](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)。

## openclaw/acpx

采用/借鉴候选：参考 caller-owned controls、会话复用条件和生命周期分层。

边界与不采纳：超时/响应 drain 仍须服从网关 deadline；不继承其结果恢复作为公共成功。

许可/状态：元数据 MIT；archived=false。

固定阅读位置：[package.json](https://github.com/openclaw/acpx/blob/b3cd84337952e0d2cadd094f564612e89d71daa5/package.json)；[src/runtime.ts](https://github.com/openclaw/acpx/blob/b3cd84337952e0d2cadd094f564612e89d71daa5/src/runtime.ts)；[src/runtime/engine/prompt-turn.ts](https://github.com/openclaw/acpx/blob/b3cd84337952e0d2cadd094f564612e89d71daa5/src/runtime/engine/prompt-turn.ts)；[src/runtime/engine/controls.ts](https://github.com/openclaw/acpx/blob/b3cd84337952e0d2cadd094f564612e89d71daa5/src/runtime/engine/controls.ts)。

## rivet-dev/sandbox-agent

采用/借鉴候选：参考 HTTP/ACP 聚合与可插拔会话事件持久接口。

边界与不采纳：默认内存存储与自动重建/有限历史重放不是本项目的未知执行恢复策略。

许可/状态：元数据 Apache-2.0；archived=false。

固定阅读位置：[sandbox-agent/README.md](https://github.com/rivet-dev/sandbox-agent/blob/d00849b2a3914a9d771f5f4c2b6a6e876e0edf16/sandbox-agent/README.md)；[sandbox-agent/docs/content/docs/session-persistence.mdx](https://github.com/rivet-dev/sandbox-agent/blob/d00849b2a3914a9d771f5f4c2b6a6e876e0edf16/sandbox-agent/docs/content/docs/session-persistence.mdx)；[sandbox-agent/docs/content/docs/session-restoration.mdx](https://github.com/rivet-dev/sandbox-agent/blob/d00849b2a3914a9d771f5f4c2b6a6e876e0edf16/sandbox-agent/docs/content/docs/session-restoration.mdx)；[sandbox-agent/server/packages/acp-http-adapter/src/process.rs](https://github.com/rivet-dev/sandbox-agent/blob/d00849b2a3914a9d771f5f4c2b6a6e876e0edf16/sandbox-agent/server/packages/acp-http-adapter/src/process.rs)。

## yetone/magpie

采用/借鉴候选：参考共享模型资源与配置接线的边界。

边界与不采纳：不把配置重写和新开原生会话当作公共 Session 连续执行。

许可/状态：元数据 MIT；archived=false。

## 研究取舍

优先从 ACP v1 统一控制面与一个原生 Adapter 证明防腐层有效，核心应用服务不按厂商分支。OpenCode ACP 和 Codex 原生接口为首批候选；Claude、Pi、远程 A2A 等按能力与许可逐个准入。

任何引用复用之前都要核对具体文件许可、发行包与对应二进制版本；公开源码快照不等于默认装入依赖，更不等于已完成真实任务。
