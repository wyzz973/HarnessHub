# ADR-027：OpenClaw 回合按原生转录对账

状态：accepted，2026-10-11。依据[ADR-020](0020-complete-native-harness-capabilities.md)与 OpenClaw 调研（[能力面调研](../research/native-capability-surfaces-2026-10-11.md)）。

## 背景

OpenClaw ACP 桥只转发回复文本：不声明 tool-events，工具调用、思考与用量不会到达 Hub；模型或 Provider 出错时桥报告 `end_turn`，Hub 会把失败记成完成。直连 Gateway WebSocket 能收到完整事件，但需要设备身份签名与配对，会在用户的 Gateway 上新增已配对设备并由 Hub 处理 Gateway 凭据，属于改变用户安全状态的决定，不在本轮自主执行。

OpenClaw 的会话转录是 Pi 格式的消息：助手消息带 `thinking`、`toolCall` 块、逐次 `usage` 与 `stopReason`/`errorMessage`，工具结果为 `toolResult` 消息，每条带 `__openclaw.seq`。原 CLI 的 `gateway call sessions.get` 用 OpenClaw 自己的身份与授权读取（只读范围）。

## 决定

1. Hub 自己的 OpenClaw 会话在每轮发送前读取转录的最高序号；桥报告结束后再读取转录尾部（最多 200 条），只取本轮追加的条目。
2. 从这些条目补记：工具调用（标题、参数、结果、失败状态）、桥未流式转发时的思考、逐次调用用量与费用之和（本轮作用域）。
3. 本轮最后一条助手消息的 `stopReason` 为 `error` 而桥报告完成时，本轮记为失败；错误按已知类别（额度、认证、连接、客户端停用）给出产品说明，否则为通用的模型请求失败，不把原生错误原文放入公开事实。
4. 读取失败只留诊断，保持桥报告的结果；取消的回合不对账。
5. 直连 Gateway（实时工具流、执行审批、`sessions.changed`）暂缓（用户授权的审批代理 2026-10-11 决定）。将来的提案必须满足：配对前在界面逐项确认，并给出撤销方法；先只订阅只读事件，不开放 `chat.send`；只针对 Hub 自己的会话键；先在独立的测试 Gateway 上验证，绝不在用户正在运行的生产 Gateway 上做。

## 影响

- OpenClaw 回复下可以看到工具与用量，模型错误不再被记成完成；补记发生在回合结束时，不是实时流。
- 每轮多两次原 CLI 调用（读取转录），回合结束时间增加约 1–2 秒。
- 执行审批仍受桥限制：OpenClaw 若要求审批，桥会静默等待约 120 秒后按回退策略拒绝；本机当前策略为 `security=full`，不请求审批。

## 否决方案

- 直接使用 OpenClaw CLI 的设备私钥连接 Gateway：冒用原程序身份。
- 自建设备身份并配对：改变用户 Gateway 的已配对设备，需要用户决定。

## 验收

见[OpenClaw 转录对账验收](../verification/openclaw-transcript-2026-10-11.md)。
