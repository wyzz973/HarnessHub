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

## 2026-10-22 补充

在本机 2026.3.23-2 的协议形态上做以下改动（T-OC-03、T-OC-08 的代码部分），不按版本分支。驱动见 [openclaw.ts](../../src/adapters/control/openclaw.ts)，每项的用例在[协议测试](../../tests/protocol/acp.test.ts)里，标题带括号中的编号。

1. **目录读取不写 Gateway，模型覆盖推迟到第一个回合发送提示之前（G032-NC25）。** `open()` 只按原 CLI 的 `models.list` 核对所选模型：不在目录中仍是 `MODEL_UNAVAILABLE`，目录读取的 `selectionError` 不变，但不再 `sessions.patch`。第一个回合发送提示之前才应用所选模型。会话已在运行这个模型时不写：新会话运行 agent 的配置模型，恢复的会话运行它的 Gateway 会话行里的模型；会话行读不到时视为未知，照常应用。其余情况对 Hub 自己的键调用 `sessions.patch`，并核对 Gateway 解析出的模型，不一致为 `MODEL_MISMATCH`。确认之后，本连接的后续回合不再写，原生 `/model` 的改动因此保留（[ADR-028](0028-native-configuration-sync.md)）。图片按会话将要运行的模型门控：所选模型，否则恢复会话行的模型，否则配置模型。
   - 所选模型未能确认时，本回合的结果是失败（`reason` 为 `model_not_applied`，错误代码如 `MODEL_MISMATCH`），提示没有发出。驱动不抛出：Runtime 把 `run.dispatched` 之后 `startText` 的抛出记为结果未知并暂停对话，而这里确定什么都没有发出。界面对 `MODEL_MISMATCH` 的说明（这条消息没有发出）因此成立。
   - 理由：`sessions.patch` 是 operator.admin 级写入（本机 dist/method-scopes 读出），它会在用户的 Gateway 上创建会话行。带模型的目录读取过去每次都留下一行：本机会话库有 32 个 harnesshub 键，其中 8 个没有转录。读目录不应改变用户的 Gateway，探测和测试产生的数据也不应留下；选择与配置模型相同时，本来就不需要写。

验证：协议测试只用 `control-peer.mjs` 夹具和注入的 Gateway 记录器，包含反例与变异核对；没有运行 openclaw，也没有接触用户的 Gateway。真实复验在 M3 的 T-OC-08（`HH_REAL_READONLY=1`）：届时只计数，核对一次目录读取前后 harnesshub 键的数量不变。

仍未做：

- 现存 Hub 键的清点与删除（T-OC-03 后半）：在页面上列出 Hub 自己创建的键，默认保留，删除由用户点击。`sessions.delete` 同样是 admin 级写入，按 [ADR-045](0045-unified-capability-management.md) 由用户执行。
- 按版本分支（T-OC-11）：2026.10.x 的桥（resume、思考与工具流、审批中继、gateway call 权限）尚未核实，本次只针对 2026.3.23-2。
- 新会话的第一个回合在提示之前失败、Gateway 又没有收到写入时（例如 Gateway 拒绝 patch），这个键可能还没有会话行，而对话的原生绑定仍指向它，下一回合恢复时桥会报告找不到这个键。附件在派发前被拒绝时已有同样的情形。这是按代码推断，没有真实验证，属于 Runtime 的原生绑定生命周期，留给后续任务。
