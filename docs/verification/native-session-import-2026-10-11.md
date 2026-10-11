# 本机会话接续（2026-10-11）

依据[ADR-029](../decisions/0029-continue-native-sessions.md)。逐项状态以[能力矩阵](native-capability-matrix.md)的“原生会话列表/接续”一行为准。

## 交付

- 契约：`HarnessControl.nativeSessions(cwd, cursor?)` 与 `importSession(id, cwd)`；`SessionOrigin` 改为分支与接续两种来源；`SessionStore.nativeOwners`；工厂 `listNativeSessions`、`readNativeSession`。
- 领域：v9 接续来源（Harness、标题、引用历史、省略条数、是否读完整、是否读到历史）及其边界；接续来源必须保留导入时的原生引用；分支待建引用只属于分支来源。
- Runtime：`importNative`（命令幂等、两次持有者检查、引用历史预算 200 条 / 512 KiB、原生引用直接就绪）。
- Driver：Codex `thread/list`、`thread/read`、`thread/turns/list`；ACP `session/list` 与 `session/load` 回放收集（用户与代理文本按角色合并，思考与工具不计入）；OpenClaw 明确不可用。
- 存储：`nativeOwners` 按 SQLite JSON 查询就绪与未确认的原生引用，同一引用出现两个持有者即视为数据错误。
- Web：两个 HTTP 路由；输入框“本机会话”面板（分页、已持有的显示“打开对话”）；来源块“接续本机 X 会话「标题」”与可展开历史；侧栏“接续 · 标题”。
- 真实验收脚本 `pnpm test:real:native-import`：原程序先在新工作区自建会话并记住标记，Hub 列出、接续并提问。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 545 通过、0 失败、0 跳过；`.tmp/cc-batch9-tests.log` |
| `pnpm web:build` | 通过；主包 524.04 kB，仍超过 Vite 的 500 kB 提示阈值；`.tmp/cc-batch9-webbuild.log` |
| `node --test dist/tests/browser/web.browser.js` | 10 通过、0 失败、0 跳过（新增本机会话接续测试）；`.tmp/cc-batch9-browser.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：403 个计划场景、189 个能力格、38 个完整格（上一轮 35：Codex、Claude、OpenCode 的会话列表/接续）；它不运行这些场景；`.tmp/cc-batch9-design.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过；`.tmp/cc-batch9-tools.log` |

新增测试：接续来源的解析边界与不可变；持有者查询（就绪与未确认计入，归档与分支待建不计）；Runtime 接续（预算与省略、重放不再读取、同键不同请求、第二持有者、下一条输入原样发给原生会话、读不到历史、工厂不支持、非法标识）；Codex 与 ACP 的列表与读取（跨页、排除其他工作区与临时线程、不恢复不提示）与 OpenClaw 拒绝；正式 HTTP 入口与真实 ACP 夹具进程的完整链路（列表、接续、私有引用不外露、已持有标记、409/404、侧栏标题、下一条消息以原会话 load 后原样发送）；浏览器面板、来源块、继续对话、“打开对话”与 390 px 不溢出。

变异核验：去掉 Runtime 的持有者检查后，Runtime 测试以“one native session has one conversation”失败，正式入口测试同时失败；核验后重新构建。

界面截图 `artifacts/chat-v3/native-sessions-panel.png`、`native-session-continued-390.png`（被忽略的本地产物）已人工检查。

## 本机原安装真实证据

每个 Harness 在新的临时工作区由原程序自己建会话（`codex exec`、`opencode run`、`claude -p`），并记住随机标记；Hub 列出该工作区的会话、接续第一个并提问。环境同前几轮（干净环境变量、本机原安装与原配置），没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。这些原生会话留在各程序自己的存储中。

| Harness | 结果 | 证据 |
|---|---|---|
| Codex 0.162.1 | 列出 1 个 `exec` 线程；引用 2 条历史（完整，含标记）；第二次接续被拒（`NATIVE_SESSION_CONFLICT`）；接续后的回合答出标记，`sourceRunIds` 为空；config.toml 不变 | `.tmp/cc-native-import-codex.json` |
| OpenCode 1.18.35 | 同上（`session/list` + `session/load` 回放）；opencode.json 不变 | `.tmp/cc-native-import-opencode.json` |
| Claude Code 2.1.296（claude-agent-acp） | 同上；settings.json 不变。此前记录为额度用完，本次 `claude -p` 与接续回合均正常完成 | `.tmp/cc-native-import-claude.json` |

第一次 Codex 运行中 `codex exec` 在管道 stdin 上等待额外输入，6 分钟后超时失败（该次证据已被第二次运行覆盖）；脚本改为立即关闭子进程 stdin 后通过。

## 未验证与受阻

- Cursor 只有通用 ACP 协议验证（账号计划受限）。
- OpenClaw 按设计不接续；Pi、Gemini 没有会话列表接口。
- 接续后若用户同时在原程序中继续同一会话，两边回合会交错，Hub 只能提示，无法阻止。
- 未做 Windows 验证；4317 服务尚未部署本轮与上一轮代码（需要 v8→v9 迁移）。
