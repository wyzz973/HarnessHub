# 第一链路打磨（2026-10-11）

按用户授权的审批代理（Fable 5.1）给出的本阶段优先级推进：版本显示 → 发现方式整改 → Hermes/dsh 剩余验收 → 启动阶段与首字延迟、错误说明 → 目录缓存与探测会话 → 审批提示与 dsh 预设 → Codex 计划模式 → 后台任务。发现方式整改见 [Hermes 与 dsh 接入记录](hermes-dsh-onboarding-2026-10-11.md)。

## 版本显示（P1）

问题：选择器把适配器版本当成产品版本显示（Claude Code 显示为 claude-agent-acp 的 0.89.1）；Hermes 没有版本（`hermes --version` 输出多个版本号，并在隔离 HOME 里联网检查更新，超过 5 秒探测期限）；网页缺少 favicon。

交付：

- **从安装元数据读取版本，不运行程序**。发现找到入口后，如果目录为它声明了包身份，就读取安装元数据：npm 包从解析后的 bin 向上找名字相符的 package.json，并核对其 bin 指向这个文件；Python 包从控制台脚本的解释器行找到虚拟环境（安装器的 launcher 若只是 `exec "<脚本>" "$@"`，跟随一层），读 `site-packages/<名称>-<版本>.dist-info/METADATA` 并核对名称。有了观察到的版本，管理层不再运行 `--version`。
- **区分产品版本与接入口版本**。产品自己的命令是目录里该产品的第一个命令名；接入口是另一个程序（适配器）时，用同一套隔离的 `--version` 探测读取产品自己的版本，同一命令只读一次。Harness 视图新增 `programVersion`：选择器显示产品版本；Harness 页显示产品版本，接入口版本不同时另标“接入口 v…”。
- Hermes 的控制入口登记 Python 包身份 `hermes-agent`。
- 网页内嵌 favicon（HarnessHub 标志），不再请求 `/favicon.ico`。

检查：

| 命令 | 结果 |
|---|---|
| `pnpm build` 与 `node --test dist/tests/*/*.test.js` | 559 通过、0 失败、0 跳过 |
| `pnpm web:build` 与 `node --test dist/tests/browser/web.browser.js` | 11 通过 |
| `python3 tools/check_design.py --write` 与默认检查 | 通过 |

新增测试：npm 全局 bin 链接读出包版本，非 bin 文件与不同名字不算；Python 控制台脚本与一层 launcher 读出 dist-info 版本，两层 launcher 与缺少 pyvenv.cfg 的环境不算，全程不运行任何程序；适配器入口保留自己的版本、产品版本由产品命令读取且只读一次；产品命令判断（适配器、产品自身、经 Node 运行的包、找不到）。

本机真实观察（`node dist/src/cli/discover.js --json`，只读文件）：Hermes 0.12.0（venv 元数据，经官方 launcher）、claude-agent-acp 0.89.1、Gemini CLI 0.62.0、dsh 0.2.1-alpha.1（自定义入口的 package.json）。独立开发实例的 Harness 页：Claude Code v2.1.296 · 接入口 v0.89.1；Hermes Agent v0.12.0；DeepSeek Harness v0.2.1-alpha.1 · 自定义入口（发现清单）；控制台无错误。

未验证：Windows 的 Python 环境布局（`Lib/site-packages`、`Scripts`）未处理也未验证；PEP 440 预发布版本（如 `0.1.5rc1`）不是语义化版本，仍会回落到 `--version` 探测。

## 回合阶段与首字延迟（P4，ADR-032）

交付：Run 记录受理、开始准备、原生会话就绪、发送、首个可见输出与结束的时间（Session v10，v9→v10 只改版本号）；发送与首个输出各有一条事件。界面按阶段显示“正在启动 X”“已连接 X，正在发送”“等待 X 回复”，超过 2 秒附已用时间，同一对话里同一 Harness 上次的启动时间作为参考；回合结束后显示“首字 … · 用时 …”，执行详情列出启动原程序与发送后首个输出的时间。

检查：

| 命令 | 结果 |
|---|---|
| `node --test dist/tests/*/*.test.js` | 564 通过、0 失败 |
| `node --test dist/tests/browser/web.browser.js` | 11 通过（新增“首字 … · 用时 …”断言） |
| `python3 tools/check_design.py` | 通过 |

新增测试：阶段时间的边界、顺序与只在 v10 出现；v9→v10 迁移保留全部事实，v9 数据里出现阶段时间时整体回滚；真实 IPC 回合按顺序记录全部阶段，发送与首个输出事件各一次。

真实验证（独立开发实例）：已有两个 v9 会话的数据目录启动后迁移为 v10，两个会话完整保留（迁移前已备份）。在已有的 Hermes 对话里再发一条消息：界面依次显示“正在启动 Hermes Agent”，结束后显示“首字 8.0 秒 · 用时 9.7 秒”。这一回合的阶段：受理到准备 0.00 秒，启动原程序（建进程、握手、恢复会话与等待回放）4.76 秒，就绪到发送 0.00 秒，发送到首个输出 3.21 秒，首个输出到结束 1.73 秒（其中包含 Hermes 在标准输入关闭后要等 SIGTERM 才退出）。启动原程序是最大的一段，这也是 ADR-030 保留进程要省掉的部分。
