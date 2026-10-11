# 原生设置与原生命令真实验收（2026-10-11）

逐项状态以[能力矩阵](native-capability-matrix.md)为准。本轮没有改动产品代码，只新增真实验收脚本 `pnpm test:real:native-options`：按 `HH_REAL_OPTIONS_<ID>` 选择原生设置，回合后核对原生会话回报的值与所选一致（`HH_REAL_EXPECT_UNCHANGED=1` 时要求被请求修改的文件保持不变）；按 `HH_REAL_COMMAND` 与 `HH_REAL_COMMAND_FILE` 执行一条原生命令并检查它在工作区生成的文件。证据只保留取值、状态与标志。

| Harness | 验收 | 结果 | 证据 |
|---|---|---|---|
| OpenCode 1.18.35 | mode=plan，回合要求把 bravo 改成 delta | 原生回报 mode=plan；文件未被修改；回合完成 | `.tmp/cc-native-options-opencode.json` |
| OpenCode 1.18.35 | 原生命令 `/init`（默认模式） | 作为原生命令发送，回合完成并生成 AGENTS.md | `.tmp/cc-native-options-opencode-init.json` |

第一次运行把 `/init` 放在 plan 模式的同一会话中，命令完成但没有生成文件（plan 模式不允许写文件）；第二次在默认模式下单独运行后通过。各项 opencode.json 均未改变。

OpenCode 的思考档位（effort）只在有变体的模型上出现，本机安装的模型都没有变体，因此无法真实验收。未做 Windows 验证。

## 部署到 4317 服务（第 15–18 轮）

2026-10-11 21:09，服务空闲（唯一会话无在途 Run 与待决切换，上次部署后无新写入）时部署 React 分块、Codex 子 Agent 线程工具、OpenClaw 技能与插件列表及本轮脚本：核实 PID 与命令行后 SIGTERM 正常退出；冷备份 `data/` 到 `.tmp/backup-data-v9-20261011-210928/`（格式未变）；主检出快进到 `9485ee9` 并构建；经干净环境的登录 shell（无代理变量）启动，输出写入私有 `.tmp/service-4317.log`。部署后核对：业务库 `user_version=9`、325 条事件；原会话 schema 9、open、14 个 Run、27 条消息、OpenClaw 原生会话 ready；静态页 200、未登录 API 401。一次性启动链接只在私有日志中，未使用、未展开。回退：停止服务后用该备份替换 `data/`，检出 `93e92f5` 重新构建。
