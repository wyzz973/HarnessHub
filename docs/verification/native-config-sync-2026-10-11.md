# 原生命令改设置后的同步（2026-10-11）

依据[ADR-028](../decisions/0028-native-configuration-sync.md)。逐项状态以[能力矩阵](native-capability-matrix.md)的“原生命令改配置后的同步”一行为准。

## 交付

- 契约与领域：Session v9，原生引用增加 `observed`（原生回报的模型与选项，有界校验）；`carriedNativeConfiguration` 规则（同一纪元、只针对所选请求的键）；v8→v9 迁移；`HarnessControl.nativeConfig()`。
- Runtime：打开原生会话前按规则沿用原生值并提交 `native.config_carried`；回合结束、关闭前读取回报，无法读取或无效时记 `native.config_unreadable` 并清除旧回报，回合结果不变；准备阶段的未确认引用保留上一份回报。
- Driver：ACP 按代理宣告报告当前值，`set_mode` 成功后记录已应用的模式；OpenClaw 每回合后经原 CLI 读取 `sessions.list`（按本会话 key 精确匹配）与 `chat.history`，映射为桥的选项 ID，恢复的会话按会话行的模型检查图片；Pi 读取 `get_state`，恢复会话只在有选择时指定模型。
- Web：视图 `nativeStates[]` 增加 `observed`、`carried`；输入框提示“原生命令已改为 …；下一回合沿用，不改回所选”与“改用所选设置”；高级配置的原生会话显示原生当前值。
- 真实验收脚本 `pnpm test:real:native-config`（环境变量指定选项、初值、命令与目标值）。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 539 通过、0 失败、0 跳过；`.tmp/cc-batch8-tests.log` |
| `pnpm web:build` | 通过；主包 518.49 kB，仍超过 Vite 的 500 kB 提示阈值；`.tmp/cc-batch8-webbuild.log` |
| `node --test dist/tests/browser/web.browser.js` | 9 通过、0 失败、0 跳过（新增原生设置提示测试）；`.tmp/cc-batch8-browser.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：395 个计划场景、189 个能力格、35 个完整格（不变）；它不运行这些场景；`.tmp/cc-batch8-design.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过；`.tmp/cc-batch8-tools.log` |

新增测试：v9 回报的边界与 v8 拒绝、沿用规则（纪元、受管 Provider、未回报模型、未改动值、无已完成回合）、只有拥有者 Run 可写入；v8→v9 迁移与整笔拒绝；回报不可读与无效时回合结果不变且下一回合按选择应用；ACP 未回显模式的记录；OpenClaw 会话行与 `chat.history` 映射、回合前不报告、恢复会话按会话行模型检查图片；Pi 回报与恢复会话保留上次模型；正式 HTTP 入口与真实 ACP 夹具进程的完整链路（沿用、事件、视图不含私有引用、同选择切换后按选择应用）；浏览器提示、高级配置中的原生当前值、“改用所选设置”与 390 px 宽度不溢出。

变异核验：去掉 Runtime 的沿用后，正式入口测试以“the next Turn applies the native value instead of reverting it”失败；恢复 Pi 恢复时强加默认模型的旧行为后，Pi 测试以模型为 `native/one` 失败。两次核验后均重新构建。

界面截图 `artifacts/chat-v3/native-carried-1280.png`、`native-carried-390.png`（被忽略的本地产物）已人工检查。

全量运行之前的一次协议测试文件运行中，“OpenCode refines agent image support …”出现过两次失败（约 1.0–1.2 秒，夹具超时为 1 秒），未保存失败详情；之后单独 6 次、整文件 4 次、清理 dist 冷构建后 3 次与全量运行均通过，未能复现，原因未确认。

## 本机原安装真实证据

环境同前几轮（干净环境变量、本机原安装与原配置），没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。每次验收新建 Hub 自有的 OpenClaw 会话。

| 验收 | 结果 | 证据 |
|---|---|---|
| OpenClaw（deepseek/deepseek-chat）`thought_level`：所选 low，原生 `/think high` | 首轮读回 low；命令后读回 high；下一回合提交沿用 high，回合后仍为 high；同选择显式切换（纪元 2）后读回 low；四个回合均完成；openclaw.json 不变 | `.tmp/cc-native-config-openclaw.json` |
| OpenClaw `fast_mode`（经 `chat.history` 读取）：所选 off，原生 `/fast on` | 同上：off → on → 沿用 on → 切换后 off；openclaw.json 不变 | `.tmp/cc-native-config-openclaw-fast.json` |

## 未验证与受阻

- Claude（账号周额度用完）、Cursor（账号计划受限）只有通用 ACP 协议验证；Gemini、OpenCode 是否宣告原生命令造成的设置变化未确认，矩阵不计为已接出。
- Pi 的原生改动只能由扩展命令触发，真实验收需要修改用户的 Pi 配置，不做；回报与恢复行为只有协议验证。
- Codex app-server 没有修改设置的原生命令；服务端改路由仍以逐轮警告显示，不沿用，改路由提示尚无协议测试。
- 未做 Windows 验证；4317 服务尚未部署本轮代码（需要 v8→v9 迁移）。
