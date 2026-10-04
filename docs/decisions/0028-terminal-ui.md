# ADR 0028：终端界面 `hh tui`

Status: proposed

日期：2026-10-04
关联决定：[01 第 4 节](../proposals/oss/01-product.md#4-与-magpie-的功能对标矩阵)原定“TUI 不做”，所有者于 2026-10-04 改为对标 Magpie 的终端主界面；[ADR 0022](0022-agent-wiring-semantics.md)（模型列表、档位与 Profile）

## 问题

Magpie 的 `magpie` 命令打开一个终端界面：每个 Agent 一行，方向键选择 Agent 与字段，回车打开可搜索的选择器，`s` 保存 Profile，`p` 应用 Profile。HarnessHub 的同类操作只有逐条命令（`hh agents`、`hh wire`、`hh profile`）和浏览器中的控制台；在 SSH 会话或不想开浏览器时，没有一个能浏览与切换的界面。

## 决定

1. 新增 `hh tui`（`packages/cli/src/tui.ts` 与 `tui/`）。它只经 SDK 调用运行中的守护进程，读写与 `hh agents`、`hh wire`、`hh profile`、`hh unwire` 相同的接口，守护进程不新增逻辑。写入前总是先取 `POST /agents/{id}/wiring/plan` 或 `POST /profiles/{name}/plan`，显示守护进程已遮蔽 Key 的 diff，`y` 之后才以该计划作为 `expect` 写入。
2. 不引入依赖：原始模式输入、ANSI 输出与重绘由约 350 行代码完成（`tui/terminal.ts`），只写光标定位、行与屏幕擦除、SGR、备用屏幕与光标显隐几种序列。`NO_COLOR` 非空时不写任何 SGR，所选字段改用方括号标出。
3. 终端在任何结束方式下都恢复：`q`、Ctrl+C（原始模式下是输入字节）、SIGINT、SIGTERM，以及进程的 `exit` 事件（未捕获的异常与未处理的拒绝都会触发它）。恢复是同步、可重复调用的：显示光标、离开备用屏幕、退出原始模式、暂停输入并移除所有监听器。
4. 按键逐个处理；守护进程调用进行中按下的键（Ctrl+C 除外）被丢弃，提前键入的 `y` 不会确认尚未显示的预览。守护进程拒绝的操作（`HarnessHubError`）与守护进程不可达都显示在状态行，界面保留；其他错误视为缺陷，恢复终端后照常抛出，由 `hh` 的错误报告输出。
5. 没有终端（stdin 或 stdout 不是 TTY，或给了 `--non-interactive`）以 2 退出并提示 `hh agents`；守护进程未运行时在打开界面之前提示 `hh serve` 并以 3 退出。

## 考虑过的替代方案

- **Ink（React for CLI，MIT）**：组件化、生态成熟，但要引入 React、Yoga 布局（WebAssembly）与十余个传递依赖，增加单文件可执行程序的体积与供应链审查面，并且需要 JSX 构建配置；界面只有四种屏幕，收益不足以抵消依赖成本。
- **blessed / neo-blessed（MIT）**：功能完整，但多年未维护，含 terminfo 解析与可选的原生依赖，在单文件构建中需要额外处理。
- **把 TUI 做成控制台的终端版，经守护进程推送状态**：需要新的推送接口；轮询现有接口（`r` 刷新）已经足够。

## 后果

- 一个新的交互入口，规则与 CLI 相同：先预览、确认后写入，Key 不显示；选择当前已有且状态正常的值什么都不写（重新接线只会换一把 Key），有漂移或需要处理的 Agent 选择当前值时照常预览并写入，以修复它。
- 自行解析按键序列：只识别方向键、翻页、回车、退格、Tab、Esc 与 Ctrl+C/N/P/U，其他序列（功能键、鼠标报告）被丢弃。宽字符按常见的东亚宽字符与 emoji 区间计为两列，未覆盖的组合字符可能导致个别行宽度偏差。
- Windows 终端（Windows Terminal、conhost 的虚拟终端模式）理论上支持这些序列，但尚未验证。

## 验证要求

- 集成测试（`tests/integration/tui.test.ts`）经注入的终端（`tests/support/terminal.ts`：记录原始模式的输入、可改变尺寸的输出与按写入序列重建的屏幕）对 `startHub`（临时接线目录、假 provider、文件秘密后端）运行：选择模型、预览、确认后 Agent 已接线且 Key 从未出现在输出中；拒绝、关闭选择器与预览生成期间提前键入的 `y` 都不写入、不签发 Key；Profile 保存、切走、预览、应用的往返；折叠的 Agent 与列表滚动；改变尺寸、窄终端与过小终端；`NO_COLOR`；`q`、Ctrl+C、SIGINT、SIGTERM、`exit` 与崩溃后终端恢复；没有终端时以 2 退出、守护进程未运行时以 3 退出。
- 单元测试（`packages/cli/test/tui-terminal.test.ts`）覆盖按键解码、列宽、截断与样式。
- 在 macOS 的真实伪终端中运行 `hh tui`：方向键、选择器、预览与写入、`SIGWINCH` 改变尺寸，退出码 0，退出前后 `stty -a` 相同。
