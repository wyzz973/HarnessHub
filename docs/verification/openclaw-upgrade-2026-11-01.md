# OpenClaw 2026.3.23-2 → 2026.10.9：HarnessHub 两跳升级的真实运行（2026-11-01）

按 [ADR-052](../decisions/0052-openclaw-upgrade-route.md) 2026-11-01 实现裁决，由 HarnessHub 的“升级 Harness”（ADR-043）按上游“Upgrading very old versions”的顺序升级本机 OpenClaw。用户 2026-10-22 授权：OpenClaw 由 HarnessHub 支配、直接升级、不再逐项确认。这是该路线的第一次真实运行；升级完成，但网关升级后没有就绪，T-OC-12 没有做。

## 前置（主代理在终端执行）

| 项 | 结果 |
|---|---|
| Homebrew Node（launchd 服务用） | 26.11.1 → 26.13.0_2（`brew upgrade node`，保留旧 keg；2026.10.9 要求 `>=24.22.1 <25 \|\| >=26.12.1`） |
| nvm 默认 Node（CLI 经 PATH 解析） | 26.11.1 → 26.13.0（`nvm install 26.13.0 --reinstall-packages-from=26.11.1`；npm 11.20 跳过了 claude、dsh 的安装脚本并提示，随后按提示 `npm install -g --allow-scripts=…` 重装两者，版本不变：claude 2.1.316、dsh 0.2.1-rc.5）。确认框此前把 CLI 解释器 26.11.1 列为阻止项，重启 4317 后解除 |
| 备份 | `openclaw backup create --output ~/.cache/harnesshub-acceptance/openclaw-backup --verify`：127 MB，`verified: true`（含 `~/.openclaw` 整个状态目录，工作区被它覆盖） |
| 服务状态 | `ai.openclaw.gateway` running（pid 5056，runs 1，端口 18789）；`ai.openclaw.node` running |

## 确认框（`GET /api/v1/harnesses/openclaw/maintenance`，4317 commit `266e863`）

- 两跳：2026.9.5（bridge）→ 2026.10.9；每跳的 Node 要求与三个运行时（CLI 解释器、`ai.openclaw.node`、`ai.openclaw.gateway`）逐一核对，全部满足。
- 命令原文：`openclaw gateway stop`；`/opt/homebrew/bin/npm install --global --prefix /opt/homebrew --no-audit --no-fund --allow-scripts=openclaw --registry=https://registry.npmjs.org openclaw@2026.9.5`；`openclaw doctor --fix --yes`；同样的 npm 与 Doctor 对 2026.10.9；`openclaw gateway start`；`openclaw gateway status --deep`；`openclaw node restart`。
- 说明：Gateway 停止期间渠道离线；Doctor 改写 `~/.openclaw/openclaw.json` 并保留 `.bak` 轮换；官方插件由 Doctor 修复，第三方插件（openclaw-weixin）可能要 `openclaw plugins update`；回退只能从备份恢复（`rollback: null`）。
- 提交：`POST /api/v1/installation-jobs`，`restartServices: ["ai.openclaw.gateway"]`，`backupConfirmed: true`。

## 任务 `management-1ae4bfb6-ee52-43b7-8345-aed8a08d45e5`

| 时间（本地） | 步骤 | 结果 |
|---|---|---|
| 15:13:36 | `openclaw gateway stop` | Stopped LaunchAgent |
| 15:13:37–15:14:18 | npm 2026.9.5 | added 80 / removed 331 / changed 251；npm 11.20 提示 4 个带脚本的依赖（@google/genai、koffi、tree-sitter-bash、protobufjs）不在 `--allow-scripts` 内、脚本未运行 |
| 15:14:18–15:20:27 | Doctor 2026.9.5 | 6 分钟；“Installed missing configured plugin” deepseek、feishu、openclaw-weixin、tavily（从 2026.9.5 的插件版本）；大量 `channels.feishu` 插件路径不可用的告警 |
| ~15:20:30–15:21 | npm 2026.10.9 | 完成（版本经 package.json 核实） |
| 15:21–15:23:28 | Doctor 2026.10.9 | 迁移配置与状态库（`~/.openclaw/openclaw.json.bak*` 15:20–15:21；状态库 schema 20）；报告服务定义与安装器默认值的差别（PATH 含版本管理器、嵌入代理变量、ExitTimeOut 20 s、StandardInPath）；`Restarted LaunchAgent: gui/501/ai.openclaw.gateway`（15:23:08，新 pid 18574）；“Gateway restarted and verified after Doctor repair.” |
| 15:23:31–15:24:18 | `openclaw gateway start` | “Gateway start timed out after 45s waiting for /healthz and /readyz.” |
| 15:24:18 | 任务结束 | **failed**，`GATEWAY_START_FAILED`；`hops`：2026.9.5 installed / doctor ok，2026.10.9 installed / doctor ok；`services`：ai.openclaw.gateway not_recovered；`actualVersion` 2026.10.9；没有回滚、没有重试；`openclaw gateway status --deep` 与 `openclaw node restart` 没有执行 |

## 升级后的状态与恢复尝试（主代理手工）

- `openclaw --version`：2026.10.9（8b18b55）；`ai.openclaw.gateway` 由 launchd 拉起（pid 18574，runs 1），监听 127.0.0.1:18789，但 `/healthz`、`/readyz`、WebSocket 握手都超时（TCP 能连上，0 字节响应；排除了本地代理环境变量的影响）。`gateway status --deep`：Runtime running、Readiness not confirmed、Connectivity timed out。
- 网关自己的日志停在 15:23:28（启动阶段全部完成、“ws client ready”），之后再无输出。15:23:25 一条 `SqliteSchemaVersionError … uses newer schema version 20; this build supports 17. Refused by OpenClaw 2026.9.5`：来自仍以 2026.9.5 代码运行的 `ai.openclaw.node`（第 1 跳的 Doctor 重启过它，之后在崩溃循环，runs=64）。
- `openclaw node restart`（Node 服务换到 2026.10.9 代码，runs 回到 1）；`openclaw gateway restart`（新 pid 35198）：仍不就绪，`Gateway restart timed out after 76s waiting for health checks`。
- `sample <pid>`：主线程 100% 样本都停在 JS 的 `fs.openSync` → `open(2)` 系统调用里（事件循环被一次同步打开阻塞）；`~/.openclaw/tmp` 下没有命名管道；工作区与插件目录没有找到 iCloud 驻留文件。阻塞的路径没有查出来。
- 按 Doctor 建议 `openclaw gateway install --force`（重建服务定义：最小 PATH、去掉代理变量、ExitTimeOut 330、日志改到 `~/Library/Logs/openclaw/gateway.log`）再 `openclaw gateway restart`（pid 48658）：仍然一样。
- 停止在这里：网关留给 launchd 继续运行（0% CPU），不再反复重启；OpenClaw 的会话、配置与备份都在。用户恢复时可以：交互式 `openclaw doctor`；对卡住的进程用 `sample`/`fs_usage` 看它要打开的路径；必要时 `openclaw backup restore <备份> --target <新目录>` 回到升级前（旧版本打不开 schema 20 的库，必须用备份）。

## 结论

- Hub 的路线按设计工作：顺序、同意、备份勾选、每跳的运行时核对、每跳的事实（installed / doctor）、失败即停不回滚，都如确认框所述；受保护配置只由 Doctor 改写。
- 两处待改（记入 [ADR-052](../decisions/0052-openclaw-upgrade-route.md) 真实运行一节）：最后一跳的 Doctor 自己重启了 Gateway，Hub 之后的 `gateway start` 面对的是已运行但不就绪的服务，确认框与判定应说明这一点；`openclaw node restart` 应在最后一跳 Doctor 之前执行或交给 Doctor，避免 Node 服务用旧代码连新库。
- T-OC-12（升级后的复验，≤ ¥5）没有做：网关不就绪。矩阵的 OpenClaw 格保持 2026.3.23-2 时的记录，`installation` 写明本机现为 2026.10.9 且未完成真实验收。
- 费用：0（没有模型回合）。
