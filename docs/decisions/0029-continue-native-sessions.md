# ADR-029：在 Hub 中接续本机原生会话

状态：accepted，2026-10-11。依据[ADR-020](0020-complete-native-harness-capabilities.md)、[ADR-025](0025-conversation-branches.md)。用户要求接出原生会话的恢复，并沿用本机原安装与原有会话。

## 背景

- 用户在原程序（终端、编辑器、`exec`/`run`）里已有会话；Hub 只能继续它自己创建的原生会话。
- 原接口能列出工作区的会话：Codex `thread/list`（按 cwd、来源、归档过滤）与 `thread/turns/list`；ACP `session/list`（Claude、OpenCode、Cursor 声明），`session/load` 会先回放全部历史。OpenClaw 桥对 `session/list` 返回 Method not found，Gateway 的其他会话属于渠道与其他代理；Pi、Gemini 没有列表接口。
- 两个对话同时写同一个原生会话会互相交错；原生会话标识在 Codex/ACP 中就是 Hub 的恢复引用。

## 决定

1. **接续是新对话。** 选中的本机会话成为一个新 Session：来源 `origin.kind = "import"`（Harness、标题、引用历史、已读但未引用的条数、历史是否读完整），原生引用直接就绪（`throughRunId` 为空），所以下一条输入原样发给原生会话，不带公共上下文。引用历史不可变、不重新执行，最多 200 条、512 KiB（留给分支的空间），更早的只计数。v9 的定义扩展为包含这一来源（v9 尚未发布到任何数据根，不另升版本）。
2. **只接续本工作区的会话。** 驱动确认会话属于请求的工作区（Codex `thread/read` 的 cwd；ACP 在 `session/list` 中按 cwd 找到它），临时线程不能接续。读取只做 `thread/turns/list` 或 `session/load` 回放，不发送提示，读完即关闭连接。
3. **一个原生会话只有一个持有者。** 就绪或未确认的原生引用即为持有；分支待建的引用与已归档的不算。接续前后两次检查持有者，冲突时拒绝（`NATIVE_SESSION_CONFLICT`）。列表为已被持有的会话标出对话，界面改为“打开对话”。Hub 自己创建的会话同样出现在列表并标为已持有。
4. **接口与界面。** `GET /api/v1/harnesses/:id/native-sessions?controlId=&workspace=&cursor=` 返回 `{sessions, nextCursor}`（不支持时 `sessions: null`）；`POST /api/v1/sessions/import {workspace?, selection, nativeId, commandId}` 返回新对话（命令幂等）。输入框新增“本机会话”面板；对话顶部显示“接续本机 X 会话「标题」”与可展开的历史；侧栏以“接续 · 标题”命名尚无输入的对话。
5. **OpenClaw 明确不接续。** 驱动对列表与读取返回 `NATIVE_SESSION_LIST_UNAVAILABLE`，避免 Hub 向渠道会话写入；只继续 Hub 创建的会话。

## 影响

- 接续后若用户同时在原程序中继续同一会话，两边的回合会交错；界面提示不要这样做，Hub 无法阻止原程序。
- 原生会话保留在原程序自己的存储中；Hub 不删除，也不修改它的标题或归档状态。
- 列表与读取各启动一次原程序（只读探测），不占用工作区写入租约。

## 否决方案

- 把原生历史转成 Hub 的 Run：没有执行过的 Run 会成为伪造的执行证据，也破坏命令与 Run 的对应。
- 不引用历史、只接续：对话界面看不到之前在原程序里说过什么。
- 允许多个对话持有同一原生会话：两个写入者会让原生会话与公共历史都无法确认。

## 验收

见[本机会话接续验收](../verification/native-session-import-2026-10-11.md)。
