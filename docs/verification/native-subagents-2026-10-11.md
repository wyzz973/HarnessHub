# 子 Agent 活动（2026-10-11）

逐项状态以[能力矩阵](native-capability-matrix.md)的“子 Agent”一行为准。

## 现状与交付

- Claude（claude-agent-acp 0.89.1）在客户端未协商原生子会话时，把子 Agent 的工具调用平铺在根会话，并以 `_meta.claudeCode.parentToolUseId` 指向发起它的 Agent 调用。Hub 自第 2 轮起已把它记录为工具的 `parentId`；本轮在界面上按此关联嵌套显示：子 Agent 调用标出“子 Agent · N 个工具”，其下是它运行的工具，各自可展开详情。
- 分组规则（`web/src/tool-tree.ts`）：父调用在列表中才嵌套；自指、缺失父调用与成环的平铺；超过三层的挂在第三层祖先下，保证每个工具只显示一次。
- 不协商 `subagents` 能力：协商后子 Agent 的工具、文字与权限请求改走子会话 ID，需要另行设计子会话归属；平铺方式已经提供调用、关联、详情与审批。
- Codex 已有的子 Agent 活动（`subAgentActivity`）与协作调用（`collabAgentToolCall`）显示不变；子线程内的通知仍只计数。
- 真实验收脚本 `pnpm test:real:native-subagent`。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 546 通过、0 失败、0 跳过；`.tmp/cc-batch11-tests.log` |
| `pnpm web:build`、`node --test dist/tests/browser/web.browser.js` | 构建通过（主包仍超过 500 kB 提示阈值）；浏览器 11 通过、0 失败、0 跳过；`.tmp/cc-batch11-webbuild.log`、`.tmp/cc-batch11-browser.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：408 个计划场景、189 个能力格、52 个完整格；它不运行这些场景；`.tmp/cc-batch11-design.log` |

新增测试：分组规则单元测试（嵌套、自指、缺失、成环、超过三层）；浏览器中子 Agent 调用下嵌套显示子工具并可展开详情、窄屏不溢出（ACP 夹具按 Claude 的平铺方式发送）。截图 `artifacts/chat-v3/native-subagent-tools.png`（被忽略的本地产物）已人工检查。

## 本机原安装真实证据

| Harness | 结果 | 证据 |
|---|---|---|
| Claude（haiku） | 回合完成；Agent 调用下关联 Bash 与 SubagentHandback 两个工具；主回复只有“主代理收到”，不含子 Agent 输出；settings.json 不变 | `.tmp/cc-native-subagent-claude.json` |
| Codex 0.162.1 | 部分：子 Agent 活动“/root/echo_sub_ok”与协作调用 `wait` 显示并完成；子线程里运行的命令没有接出；config.toml 不变 | `.tmp/cc-native-subagent-codex.json` |

## 未验证与受阻

- Codex 子线程内的工具与文字、Claude 原生子会话（协商 `subagents`）、Cursor 子 Agent 均未接出；OpenCode 的 task 子 Agent 工具不经 ACP 转发（原程序限制）。
- 未做 Windows 验证。
