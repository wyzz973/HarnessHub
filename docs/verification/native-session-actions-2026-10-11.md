# 原生会话操作：权限设置、压缩与导出（2026-10-11）

依据[ADR-024](../decisions/0024-native-session-operations.md)。本轮接出 Codex 线程级审批策略与沙箱、Codex 与 Pi 的原生压缩和导出、ACP 命令目录的公告等待，以及公开对话导出。逐项状态以[能力矩阵](native-capability-matrix.md)为准。

## 交付

- Codex：`approval_policy`、`sandbox` 原生选项（取自 `config/read`，只覆盖 Hub 线程，线程回报核实）；文件修改审批带文件名与差异，命令审批带原因与目录；`/compact` 调用 `thread/compact/start`；`/export` 复制 rollout JSONL 为产物。
- Pi：`/compact [说明]` 调用 RPC `compact` 并以活动显示前后 token；`/export` 经 `export_html` 写入私有临时目录后作为产物；同名扩展命令优先按原样发送；原生拒绝带错误说明。
- ACP：目录读取等待首次命令公告（最多 1.5 秒，每个连接一次）。修正前 OpenCode 的目录读取返回空命令列表。
- Web：`GET /api/v1/sessions/:id/export?format=markdown|json`；对话头部导出菜单。
- 真实验收脚本 `pnpm test:real:native-commands`（`HH_REAL_HARNESSES`、`HH_REAL_EVIDENCE`，可选 `HH_REAL_MODEL_<ID>`、`HH_REAL_FILL=n`）；`test:real:native-activity` 新增 `HH_REAL_OPTIONS_<ID>`。

## 检查

| 命令 | 结果 |
|---|---|
| `pnpm build`（清理 dist 后）与 `node --test dist/tests/*/*.test.js` | 521 通过、0 失败、0 跳过；`.tmp/cc-batch4-tests.log` |
| `pnpm web:build` | 通过；主包 508.47 kB，仍略超 Vite 的 500 kB 提示阈值；`.tmp/cc-batch4-webbuild.log` |
| `node --test dist/tests/browser/web.browser.js` | 6 通过、0 失败、0 跳过（附件测试中增加导出菜单）；`.tmp/cc-batch4-browser.log` |
| `python3 tools/check_design.py --write` 与默认检查 | 通过：371 个计划场景、189 个能力格、31 个完整格（上一轮 24）；它不运行这些场景；`.tmp/cc-batch4-design.log` |
| `python3 -m unittest discover -s tools -p 'test_*.py'` | 47 通过；`.tmp/cc-batch4-tools.log` |

新增测试：Codex 权限设置（原配置取值、线程参数、未知值与未应用的拒绝）、`/compact` 回合绑定与不发 `turn/start`、`/export` 成功与临时线程失败；Pi `/compact`（自定义说明、前后 token、扩展同名优先）与 `/export`（成功与空会话失败）；ACP 命令公告等待（公告结束等待、不公告只等一次）；公开对话导出（Markdown、JSON、围栏、私有绑定不导出、格式与登录校验）；浏览器导出菜单。

## 本机原安装真实证据

环境同前两轮：与 4317 服务一致的 PATH、无代理变量、独立临时数据根与工作区；没有触碰 4317 服务、原公共对话或 OpenClaw Gateway 守护进程。

| 验收 | 结果 | 证据 |
|---|---|---|
| Codex 只读沙箱 + 按需审批 | 读取不需审批；编辑时出现“Codex 请求修改文件：notes.txt”，详情 7 行含差异；允许一次后原程序写入，回合完成；config.toml 不变 | `.tmp/cc-native-activity-codex-approval.json` |
| Codex `/compact`、`/export` | 压缩回合完成并显示压缩活动；压缩后原生会话仍答出先前记住的 42，`sourceRunIds` 为空；导出 376,468 字节 rollout JSONL | `.tmp/cc-native-commands-pi-codex.json` |
| Pi `/compact`、`/export`（deepseek/deepseek-flash） | 短会话时 Pi 拒绝（“Nothing to compact (session too small)”），如实失败；加 3 条约 50 KB 的参考消息后压缩 35,228 → 26,257 tokens，之后仍答出 42；导出 542,154 字节 HTML | `.tmp/cc-native-commands-pi.json` |
| OpenClaw 原生 `/compact`（deepseek/deepseek-chat） | 原生命令执行完成，之后仍答出 42；目录没有导出命令 | `.tmp/cc-native-commands-acp.json` |
| OpenCode 命令目录 | 修正后读取 104 条命令（skills、init、review 等），其中没有压缩或导出命令 | `.tmp/cc-native-commands-acp.json` |

## 未验证与受阻

- Codex 计划模式（需 experimentalApi）、serviceTier；会话分支、原生会话列表、子 Agent 会话与后台任务未接出。
- OpenCode 压缩只能在原 TUI 中执行；Claude、Cursor、Gemini 受账号限制没有真实验收。
- 未做 Windows 验证；4317 服务尚未部署本轮代码。

## 部署到 4317 服务

2026-10-11 18:34–18:36，在服务空闲时部署批次 2–4：

1. 确认唯一会话没有在途 Run 与待决切换，核实 PID 与命令行后发送 SIGTERM，服务正常退出（WAL 已合并）。
2. 冷备份 `data/` 到 `.tmp/backup-data-v6-20261011-183421/`（与原目录逐字节比较一致）。
3. 在只含业务库、所有者标记与 Provider 目录的副本上用新代码演练 v6→v7：会话保持 open，14 个 Run、27 条消息、OpenClaw 原生绑定 ready 全部保留。管理库记录了数据根绝对路径，复制到别处会按设计拒绝，因此不参与演练。
4. 主检出 `codex/local-discovery` 快进到 `199faa3`，离线按锁文件安装依赖并构建服务与页面。
5. 经登录 shell（无代理变量）重启：`node dist/src/cli/web.js --cwd /Users/sd3/Desktop/project/HarnessGateway --data-dir …/data --port 4317`，输出写入私有文件 `.tmp/service-4317.log`（0600）。

部署后核对：业务库 `user_version=7`，原会话为 schema 7、open、14 个 Run、27 条消息、OpenClaw 绑定 ready；新建 `data/content`；静态页 200、未登录 API 401；进程无代理变量。一次性启动链接只在私有日志中，未在任何记录里展开；本次没有使用它，也没有在原对话中发送消息。回退：停止服务后用备份目录替换 `data/`，并检出 `d3da700` 重新构建。
