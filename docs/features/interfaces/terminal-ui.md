# 终端界面

| 项 | 内容 |
|---|---|
| 分类 | 界面与入口 |
| 状态 | 已实现 |
| 验证 | 集成测试经注入的终端对正式守护进程（`startHub`、严格假上游、文件秘密后端）运行，单元测试覆盖按键解码、列宽、截断与样式，在 macOS arm64 本机通过；另在 macOS 真实伪终端中人工运行过（含单可执行文件一次），未写成自动测试；Windows 终端未验证 |
| 对照 Magpie | 部分：Terminal agents screen 一行相同；Other terminal pages 一行（provider、路由、用量、会话、Library 页与 `S` 同步）未覆盖（[Terminal UI and console](../../magpie-parity.md#terminal-ui-and-console)） |
| 权威文档 | [全局接线：终端界面](../../global-wiring.md#终端界面)、[ADR 0028](../../decisions/0028-terminal-ui.md) |

## 用途

在 SSH 会话或不想打开浏览器时，用一个终端界面浏览本机 Agent 并切换它们经网关使用的模型、档位、effort 与选项，保存和应用 Profile。它是 `hh agents`、`hh wire`、`hh profile`、`hh unwire` 的交互版，写入前同样先预览改动。

## 入口

| 入口 | 用法 |
|---|---|
| 命令行 | `hh tui [--url URL] [--data-dir DIR]`；需要终端与运行中的守护进程 |
| HTTP | 无自己的接口；经 SDK 调用 `/api/v1/agents` 与 `/api/v1/profiles`（含 `…/wiring/plan`、`…/plan`） |

## 已实现的能力

- 每个已安装、只有配置目录或已接线的 Agent 一行：接线状态（`✓ wired`，或 `! files changed`、`! key revoked`、`! no key`、`! drift …`、`! managed` 等需要处理的标记）、模型、档位、effort、Adapter 选项，光标所在行显示配置文件；未找到也未接线的 Agent 折叠为一行，`f` 展开。
- `↑↓`（`j`/`k`）选 Agent，`←→`（`h`/`l`、Tab）选字段，`↵` 打开可过滤的选择器：模型按 provider 分组并显示上下文窗口与每百万 token 价格，其后是路由组与未隐藏的自动路由组；当前值与对该 Agent 隐藏的模型有标注；ChatGPT 模式的 Codex 有 `(its own model)` 一项。
- 选定后取守护进程的接线预览，显示各文件的 diff（Key 已遮蔽）、托管配置覆盖的项（`Warning:`）与写入后要做的事（`After writing:`），`y` 写入、`n` 或 Esc 放弃；选择当前已有且状态正常的值时什么都不写。
- `s` 保存 Profile，`p` 列出 Profile 并预览各 Agent 的 diff 后应用；`u` 确认后还原文件并吊销 Key；`R` 确认后换一把新 Key；`r` 重新读取；`q`、Esc 退出，Ctrl+C 任何时候退出。
- 守护进程调用进行中按下的键（Ctrl+C 除外）被丢弃，提前键入的 `y` 不会确认尚未显示的预览；守护进程拒绝的操作与守护进程不可达显示在状态行，界面保留。
- 使用备用屏幕与原始模式，SIGWINCH 时重绘，窄窗口截断行并把按键提示折行，小于 30×8 时只显示尺寸提示；`NO_COLOR` 非空时不输出颜色与样式，所选字段以方括号标出。
- `q`、Ctrl+C、SIGINT、SIGTERM、`exit` 事件与崩溃时都先同步恢复终端（光标、备用屏幕、原始模式、监听器）。
- 退出码：`q` 为 0；没有终端（stdin 或 stdout 不是 TTY，或 `--non-interactive`）为 2 并提示 `hh agents`；守护进程未运行为 3 并提示 `hh serve`；Ctrl+C 与 SIGINT 为 130，SIGTERM 为 143。
- 不依赖第三方库：按键解码、列宽计算、样式与只重绘改变的行由自己的约 350 行代码完成。界面文字为英文。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [packages/cli/src/tui.ts](../../../packages/cli/src/tui.ts)、[packages/cli/src/tui/app.ts](../../../packages/cli/src/tui/app.ts)、[packages/cli/src/tui/terminal.ts](../../../packages/cli/src/tui/terminal.ts) |
| 测试 | [tests/integration/tui.test.ts](../../../tests/integration/tui.test.ts)、[packages/cli/test/tui-terminal.test.ts](../../../packages/cli/test/tui-terminal.test.ts)、注入终端 [tests/support/terminal.ts](../../../tests/support/terminal.ts) |
| 决策 | [ADR 0028 终端界面 `hh tui`](../../decisions/0028-terminal-ui.md) |

## 已知限制与未验证

- 只有 Agent 一个屏幕（加选择器与 Profile 列表）；provider、路由、用量、会话与 Library 只能用命令或控制台。
- 只识别方向键、翻页、回车、退格、Tab、Esc 与 Ctrl+C/N/P/U，其他序列（功能键、鼠标报告）被丢弃；宽字符只按常见东亚宽字符与 emoji 区间计为两列，未覆盖的组合字符可能使个别行宽度偏差。
- 状态靠 `r` 手动刷新，没有推送。
- 真实伪终端中的运行（方向键、SIGWINCH、退出前后 `stty -a` 相同）只做过人工检查。
- Windows Terminal 与 conhost 的虚拟终端模式未验证。

## 优化候选

- **现状**：终端里只有 Agent 屏幕。**方向**：按需增加 provider、路由、用量页与同步快捷键，复用现有 SDK 调用。**依据**：[对照表](../../magpie-parity.md#terminal-ui-and-console) Other terminal pages 一行（未覆盖）。
- **现状**：真实伪终端中的行为只有人工记录。**方向**：在 macOS 与 Linux 的真实伪终端中自动跑一遍方向键、SIGWINCH 与 `stty` 恢复（权衡是否为此引入测试依赖），或写清不自动化的理由。**依据**：[全局接线：验证](../../global-wiring.md#验证)中“未写成自动测试”。
- **现状**：组合字符的列宽可能偏差。**方向**：按 Unicode 宽度属性与字素簇计算列宽，并补充含组合字符的单元测试。**依据**：[ADR 0028](../../decisions/0028-terminal-ui.md)“后果”。
- **现状**：界面数据只在按 `r` 时刷新。**方向**：定时轮询 Agent 列表或漂移状态，另一个入口改动后自动反映。**依据**：ADR 0028“考虑过的替代方案”（轮询已足够）与阅读代码的观察。
