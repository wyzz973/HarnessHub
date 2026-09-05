# 验收：主流 Harness 主动发现与启动适配

日期：2026-09-05。范围：HH-037；结果：Mac 发现、启动配方传输及浏览器已验证；新增引擎的真实模型任务和 Windows 未验证。

## 问题与实现

旧发现器仅检查 Codex、Claude Code、OpenCode、OpenClaw、DSH 五个内置名称；Hermes 和 MiMo 即使在 PATH 上也不会返回。MiMo 的 `.mimocode/bin` 也不在备用路径中。控制台原来需要手动点发现。

现将主流安装标识与启动方式放在 [内置定义](../../src/engine/builtins.ts)，与 DSH 合计 16 种；发现顺序、命令及限制见 [发现说明](../engine-discovery.md)。新增 ACP 配方为 Hermes、MiMo、Gemini、Copilot、Kimi、Qwen、Kiro、Qoder；Pi 使用已有 pi-acp；Cursor、Antigravity 使用明确的文本 CLI。所有配方都不添加自动批准工具的参数。控制台进入引擎页自动扫描，页面可见期间每分钟及重新可见时刷新，离开页面取消在途请求并清理监听和定时器。

本地 manifest 同 ID 优先于内置配方，两个 manifest 重名仍拒绝。已有 Pi/DeepSeek launcher 和已登记配置不会因扩充清单而被替换。优先级变化记录在 [ADR 0003](../decisions/0003-dynamic-engines.md)。发现不自动安装、注册、执行 shell 或调用模型。

## 源码依据

阅读日期均为 2026-09-05，固定来源如下；上游实现是参考，不是本项目运行规则。

| 项目 | 源码与结论 |
|---|---|
| Multica `7a438bd5` | [agents_probe.go](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/server/internal/daemon/agents_probe.go)：已知命令清单、显式路径、PATH、登录 shell 与专属目录；并非识别所有任意二进制。 |
| Multica | [config.go](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/server/internal/daemon/config.go)：登录 shell 使用 `-ilc`，限制命令名称，解析绝对路径并重新验证；有 3 秒 timeout 和 2 秒 wait delay。自定义绝对路径失效不会偷偷改用另一程序。 |
| Multica | [agents_refresh.go](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/server/internal/daemon/agents_refresh.go)：安装发现间隔 2 分钟，版本检查 10 分钟；登录 shell 解析缓存 30 分钟，注册失败另外退避。安装发现与版本/注册分开。 |
| AgentSpace `0f9da1b1` | [router.ts](https://github.com/HKUDS/AgentSpace/blob/0f9da1b125def4d5a0d05b34bf7c5cec0686bbf2/packages/daemon/src/agent-router/router.ts) 和 [utils.ts](https://github.com/HKUDS/AgentSpace/blob/0f9da1b125def4d5a0d05b34bf7c5cec0686bbf2/packages/daemon/src/agent-router/utils.ts)：固定 Adapter registry 并行 detect，PATH/X_OK 检查，Windows 扩展名搜索，启动时注入 executable 目录。 |
| AgentSpace Hermes | [hermes.ts](https://github.com/HKUDS/AgentSpace/blob/0f9da1b125def4d5a0d05b34bf7c5cec0686bbf2/packages/daemon/src/agent-router/adapters/hermes.ts)：探测 `hermes` / `hermes-agent`，查询版本后以自身支持的参数启动文本 CLI。本项目采用本机 Hermes 已提供的原生 ACP，没有照搬其启动参数或自动批准策略。 |
| Hermes `a0556b86` | [ACP 文档](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/website/docs/user-guide/features/acp.md)：`hermes acp`，要求 ACP extra。本机源码和 venv 安装另行核对。 |
| MiMo `6203ea2e` | [安装器](https://github.com/XiaomiMiMo/MiMo-Code/blob/6203ea2e292b86e0f45d2ff2043f19bcfdcfbc85/install)、[ACP 入口](https://github.com/XiaomiMiMo/MiMo-Code/blob/6203ea2e292b86e0f45d2ff2043f19bcfdcfbc85/packages/opencode/src/cli/cmd/acp.ts)、[目录解析](https://github.com/XiaomiMiMo/MiMo-Code/blob/6203ea2e292b86e0f45d2ff2043f19bcfdcfbc85/packages/shared/src/global.ts)：安装到 `.mimocode/bin/mimo`；`mimo acp`；默认数据使用 XDG，不能把安装目录误用作 MIMOCODE_HOME。 |

其他配方依据：[Copilot 官方 ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)、[Qwen 官方 ACP 配置](https://qwenlm.github.io/qwen-code-docs/en/users/integration-jetbrains/)、[Cursor 官方 headless 文本模式](https://docs.cursor.com/en/cli/headless)、Multica 的 [Kimi](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/server/pkg/agent/kimi.go)、[Kiro](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/server/pkg/agent/kiro.go)、[Qoder](https://github.com/multica-ai/multica/blob/7a438bd5b8bf39afd54259a7eb0971390e50a8ef/server/pkg/agent/qoder.go)，以及 AgentSpace 的 [Antigravity](https://github.com/HKUDS/AgentSpace/blob/0f9da1b125def4d5a0d05b34bf7c5cec0686bbf2/packages/daemon/src/agent-router/adapters/antigravity.ts)。Gemini `--acp` 同时从本机 0.38.2 的参数解析源码确认；Pi 从本机 pi-acp 0.0.33 确认 `PI_ACP_PI_COMMAND`。

## 环境与执行证据

基线 `39aa24308cb77580fbe02c01757bf18d6513d91c`，分支 `codex/mvp-runtime`，本轮变更未提交。macOS 26.6.2 arm64，Node 24.20.0、pnpm 10.12.3，acpx 0.13.2。仓库根目录执行以下检查，Node 使用 `.tools/node/bin` 前置 PATH。

- `pnpm build`：通过。
- `node --test dist/tests/unit/discovery.test.js dist/tests/smoke/discovery.test.js dist/tests/integration/engine-management.test.js dist/tests/integration/worker-cli.test.js`：16 项通过，0 跳过。修复前仅运行新增的 mainstream 回归用例，因 Hermes 为 undefined 而失败；修复后通过。
- `pnpm lint`、`pnpm lint:console`、`pnpm typecheck:console`、`pnpm check:boundaries`、`pnpm build:console`：通过。`pnpm format:check`、`pnpm check:docs` 和 `git diff --check` 通过。调整测试 teardown 的进程/目录清理顺序后重跑 discovery smoke，通过。

[正式入口 smoke](../../tests/smoke/discovery.test.ts)独立启动编译后的 Gateway，注入私有 HOME/PATH，以外部协议程序替代真实模型；8 个 ACP 配方和 2 个 CLI 配方均经 HTTP 发现→注册→创建 Session→Run→关闭，校验输出和 Worker lease 清空。测试程序独立校验命令参数；SQLite、IPC、Worker、ACPDriver/CLIDriver 都是真实实现。该测试证明传输和组合接入，不代表各厂商模型或工具全部可用。

在本机将扫描 PATH 缩至 `/usr/bin:/bin`，仍找到 12 个候选：Codex、Claude、OpenCode、OpenClaw、Hermes、MiMo、Gemini、Cursor、DSH，以及 local-echo、独立 OpenCode、定制 Pi 三个 manifest。前三个新增 ACP 使用发现生成的命令实际发送 initialize，没有发送 prompt 或模型任务：

| 本机引擎 | 实际观察 |
|---|---|
| Hermes | ACP v1 initialize 成功；agentInfo 为 hermes-agent 0.12.0；关闭后所属进程组不存在。 |
| MiMo | ACP v1 initialize 成功；该安装自报 agentInfo 名称 OpenCode、版本 0.1.0，保留发现身份 mimo，不用协议自报名称覆盖；关闭后所属进程组不存在。 |
| Gemini | ACP v1 initialize 成功，gemini-cli 0.38.2；stderr 同时表示该客户端不再支持个人版 Code Assist。只计协议连通，认证/模型可用性不通过；关闭后所属进程组不存在。 |
| Cursor | 本机 `cursor-agent --help` 退出 0，确认 `--print`、`--output-format`、text；未发送模型任务。 |

本机原始探测摘要位于忽略目录 `.tmp/discovery-verification/protocol.json`；不保存凭证。控制台 Gateway 的 3184 端口与前端 3330 已在核实无活动 Run 后正常重启，沿用原 SQLite、配置和默认 DSH。

## 浏览器与未验证项

通过真实浏览器进入 `http://127.0.0.1:3330` 的引擎管理页，无需点击发现即可显示“本机发现 12”，含 Hermes、MiMo、Gemini、Cursor，且定制 Pi 仍来自 manifest。浏览器资源记录显示两次自动发现请求间隔约 60,002ms；手动“重新扫描”成功，浏览器无 console error。页面重载后再次进入引擎页，自动发现仍显示上述引擎，已登记行数仍为 8。最终浏览器快照保存在忽略目录 `.tmp/discovery-verification/browser-final.md`。

新增真实引擎的模型生成、工具权限、取消/崩溃、恢复和复杂文件任务未验收；未安装的其他 CLI 只有官方/参考源码与协议替身组合证据。没有为补齐验收安装或升级用户系统工具。Windows 原生脚本后缀、进程监督和认证目录仍未验证；登录 shell PATH 恢复未实现，明确需要继承 PATH 或本地 manifest。发现成功、具备配方、协议握手、真实模型完成是不同事实。
