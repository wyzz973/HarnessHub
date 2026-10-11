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

## 部署到 4317 服务（批次 5–6）

2026-10-11 19:13–19:14，服务空闲（唯一会话无在途 Run 与待决切换，部署后无新使用）时部署分支与原生扩展：核实 PID 与命令行后 SIGTERM 正常退出；以 APFS 克隆冷备份 `data/` 到 `.tmp/backup-data-v7-20261011-191351/`（逐项比较一致）；在副本上演练 v7→v8（会话 open、14 个 Run、27 条消息、OpenClaw 绑定 ready 全部保留）；主检出快进到 `b0b6bdd`，离线安装依赖并构建；经登录 shell（无代理变量）重启，输出写入私有 `.tmp/service-4317.log`。

部署后核对：业务库 `user_version=8`，原会话 schema 8、open、14 个 Run、27 条消息、OpenClaw 绑定 ready；静态页 200、未登录 API 401。一次性启动链接只在私有日志中，未使用、未展开。回退：停止服务后用 v7 备份替换 `data/`，检出 `c0555f9` 重新构建。

## OpenClaw 技能与插件（同日补充）

OpenClaw 的 ACP 桥不提供扩展列表；驱动改为读取 Gateway 自己的只读报告：`skills.status`（技能名称、说明、来源与是否可用——需同时满足资格、未停用、未被白名单阻止）与 `tools.catalog {includePlugins:true}` 中来源为插件的工具组。OpenClaw 没有 MCP 服务器。面板只读：技能由原程序按需使用，插件工具不被调用。

| 验收 | 结果 | 证据 |
|---|---|---|
| 协议测试 | 技能可用性映射、插件工具组、只请求两个只读方法 | `tests/protocol/acp.test.ts` |
| 本机 OpenClaw | 124 个技能（105 个可用；bundled 50、personal 66、workspace 4、extra 4），1 个插件工具组，无 MCP；openclaw.json 不变 | `.tmp/cc-native-extensions-openclaw.json` |

