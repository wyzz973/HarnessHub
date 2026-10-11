# 对话分支与原生会话副本（2026-10-11）

依据[ADR-025](../decisions/0025-conversation-branches.md)。本轮实现“从这里分支”：新对话带上引用历史，能精确复制时在原程序中建立原生副本。逐项状态以[能力矩阵](native-capability-matrix.md)为准。

## 交付

- 契约与领域：Session v8、`origin`（源对话、分支点、引用历史）、原生引用状态 `fork-pending`/`forking`、只沿 fork 路径推进的状态转换、来源不可变；v7→v8 迁移；引用历史中的附件计入内容引用。
- Runtime：`fork`（同步建立新对话，命令幂等）；Runner 在分支的任何输入前执行原生 fork；公共上下文带上 `branchedHistory`。
- Driver：Codex `thread/fork`（fork 连接上的线程通知只计数）、ACP `session/fork`（需声明，回放计数）、Pi 恢复后 `clone`、OpenClaw 明确不可用；脱敏包装转发。
- Web：`POST /api/v1/sessions/:id/fork`；视图 `origin` 与 `forking` 原生状态；分支命名；回复操作“从这里分支”；分支来源块与“打开原对话”。
- 真实验收脚本 `pnpm test:real:native-branch`。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 528 通过、0 失败、0 跳过；`.tmp/cc-batch5-tests.log` |
| `pnpm web:build` | 通过；主包 511.74 kB，仍略超 Vite 的 500 kB 提示阈值；`.tmp/cc-batch5-webbuild.log` |
| `node --test dist/tests/browser/web.browser.js` | 7 通过、0 失败、0 跳过（新增分支界面测试）；`.tmp/cc-batch5-browser.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：380 个计划场景、189 个能力格、34 个完整格（上一轮 31）；它不运行这些场景；`.tmp/cc-batch5-design.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过；`.tmp/cc-batch5-tools.log` |

新增测试：v8 来源与 fork 状态转换（合法路径与越级拒绝、来源不可变）；v7→v8 迁移与 v7 数据中出现来源的整笔拒绝；Runtime 原生 fork、公共历史分支、拒绝后归档并继续、命令幂等；Codex、ACP、Pi 的 fork 协议测试；HTTP 分支路由；浏览器分支界面（来源块、原生副本状态、分支在副本线程继续、原对话仍在原线程、窄屏不溢出）。真实验收发现 Codex 会把副本的状态与用量通知发到 fork 连接，原实现据此判定身份不符；修正后夹具复现该通知，变异核验确认测试能拒绝缺少修正的实现。

界面截图 `artifacts/chat-v3/branch-origin.png`（被忽略的本地产物）已人工检查。

## 本机原安装真实证据

源对话记住随机标记 A；分支后在分支里问 A；再只告诉分支标记 B，回到源对话问是否知道 B。环境同前几轮，没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。

| Harness | 分支方式 | 结果 | 证据 |
|---|---|---|---|
| Codex（gpt-6.1-sol） | `thread/fork` 原生副本 | 分支答出 A，`sourceRunIds` 为空；源对话不知道 B；config.toml 不变 | `.tmp/cc-native-branch-codex-acp.json` |
| OpenCode（opencode/big-pickle） | `session/fork` 原生副本 | 同上 | `.tmp/cc-native-branch-codex-acp.json` |
| Pi（deepseek/deepseek-flash） | 恢复后 `clone` 为新会话文件 | 同上 | `.tmp/cc-native-branch-codex-pi.json` |
| OpenClaw（deepseek/deepseek-chat） | 不支持 fork，归档引用后以公共历史继续 | 分支借引用历史答出 A；源对话不知道 B | `.tmp/cc-native-branch-codex-acp.json` |

## 未验证与受阻

- Claude（账号周额度用完）只有协议验证；Gemini、Cursor 没有原生 fork，可以公共历史分支。
- 在更早回复处的原生 fork、原生会话列表与导入未实现。
- 未做 Windows 验证；4317 服务尚未部署本轮代码（需要 v7→v8 迁移）。
