# 原生扩展：技能、MCP 与插件（2026-10-11）

依据[ADR-026](../decisions/0026-native-extensions.md)。本轮接出原生扩展的只读视图与 Codex 技能调用。逐项状态以[能力矩阵](native-capability-matrix.md)为准。

## 交付

- 契约：`NativeExtensions`（技能、MCP 服务器、插件，有界）与 `HarnessControl.extensions()`。
- Codex：`skills/list`、`mcpServerStatus/list`（分页）、`plugin/installed`；启用的技能作为 `skill:名称` 命令并以 skill 输入调用；旧版本没有 `skills/list` 时无技能。
- Pi：从命令目录列出技能（`skill:名称`）与扩展来源。
- 探针：模型目录与扩展列表共用同一原生探针生命周期；`GET /api/v1/harnesses/:id/extensions`。
- 界面：输入框工具栏的“原生扩展”面板（技能、MCP 服务器、插件；点选技能填入命令）。
- 真实验收脚本 `pnpm test:real:native-extensions`。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 531 通过、0 失败、0 跳过；`.tmp/cc-batch6-tests.log` |
| `pnpm web:build` | 通过；主包 517.34 kB，仍略超 Vite 的 500 kB 提示阈值；`.tmp/cc-batch6-webbuild.log` |
| `node --test dist/tests/browser/web.browser.js` | 8 通过、0 失败、0 跳过；`.tmp/cc-batch6-browser.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：385 个计划场景、189 个能力格、35 个完整格（上一轮 34）；它不运行这些场景；`.tmp/cc-batch6-design.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过；`.tmp/cc-batch6-tools.log` |

新增测试：Codex 列表与技能调用、停用技能不调用、旧版本无技能；Pi 技能与扩展来源；HTTP 扩展路由（Codex 列表、ACP 为 null、参数校验）；浏览器扩展面板与技能调用。

## 本机原安装真实证据

测试工作区只放一个 `.agents/skills/hh-echo/SKILL.md`（要求回复 HH-SKILL-OK），不触碰用户自己的技能目录；证据只记数量与状态分布。

| Harness | 结果 | 证据 |
|---|---|---|
| Codex | 173 个技能（user 167、system 5、repo 1，即工作区技能）、14 个 MCP 服务器（11 个按需启动、3 个读取失败）、46 个已安装插件；`/skill:hh-echo` 经原生命令路径发送，回复 HH-SKILL-OK；config.toml 不变 | `.tmp/cc-native-extensions.json` |
| Pi | 69 个用户技能、1 个扩展、无 MCP；新工作区的项目技能因 Pi 的信任策略未加载，技能调用未真实验收；原配置不变 | `.tmp/cc-native-extensions.json` |

## 未验证与受阻

- Claude、OpenCode、Cursor、Gemini 的 ACP 接口没有扩展列表，技能经原生命令目录使用；OpenClaw 的 Gateway 技能与工具目录需直连 Gateway。
- MCP 登录、插件安装与启停不在 Hub 中进行。
- 未做 Windows 验证；4317 服务尚未部署本轮代码。
