# 2026-09-05 Mac 文件任务、恢复与引擎修复

## 环境与范围

Node 24.20.0、macOS arm64、acpx 0.13.2。完成本轮 HH-029～HH-031 的 Mac 范围及 HH-032 的本机任务集/Windows交接说明；先前 Windows 原生任务没有改标为通过。真实轨迹和认证引用放在忽略目录，代码与文档随本次提交保存。

## 同一文件任务的真实结果

版本化任务集 `examples/benchmark-files.json`：读取 orders.csv 与 rules.json，仅汇总 paid 订单，输出 result.json 和 summary.txt。正确总量为 4 单、10 件、5750 分。公共 Run 的 JSON/Binary 文件由 Gateway 收集后登记；JSON 结构由评判器判分，主负责人另外读取已登记 summary.txt，核对精确 42 字节及末尾 LF。

| 引擎配置 | Run | 耗时 | 结果 |
|---|---|---|---|
| DSH / deepseek-v4-flash | `7299a247-351b-449a-841a-247e5987272b` | 14.385s | completed、json-equal passed、2 个 Artifact |
| OpenCode 原 big-pickle | `dbb0e958-e127-4c64-a025-1f3548deaa9e` | 181.060s 含清理 | timed_out、execution_failed、0 个 Artifact |
| OpenCode 独立 DeepSeek | `c1018f57-c65d-4255-a203-b45d84abadae` | 10.017s | completed、passed、2 个 Artifact；2 次真实权限决定均 applied |
| Pi / deepseek-v4-flash | `e575dc03-516e-4130-8e1a-ba09f02746b8` | 8.798s | completed、passed、2 个 Artifact |

原 OpenCode 的日志明确出现 HTTP 429 / FreeUsageLimitError，内部重试持续到 deadline；工具准备正常。这次失败记录和评分保留，没有用通过结果覆盖。新增 `opencode-deepseek` 使用已有 DeepSeek 认证引用、独立 HOME/XDG 与缓存，明确更改配置后只重试一次，原用户配置未修改。配置说明见 [OpenCode](../opencode-engine.md)。

DSH 和 Pi 没有触发权限请求，不把 `allow-once` CLI 策略当成实际审批覆盖。三个通过的任务输入保持原样、两份输出内容正确、所属 Worker lease 清空。数据分别保存在 `data/benchmark-files-mac`、`data/benchmark-opencode-deepseek-mac`、`data/benchmark-pi-files-mac`；合并脱敏核对结果为 `.tmp/mac-final/file-matrix.json`。这些是受控任务结果，不代表正式赛题成绩。

## DSH 正式 Gateway 恢复

启用 `acp.sessionMode: resume`，首次仅在对话里存随机 nonce，不写文件。公共后端 ID 为 `992ff610-364c-4e06-bdd1-bf56aefb14b4`。

| 场景 | Run | 结果 |
|---|---|---|
| 初次保存 | `a16770ec-8f55-435a-8a67-c39ef6409086` | 2.603s，STORED |
| idle suspend 释放 Worker 后新 Run | `80d61f17-94ff-4632-9067-2b48e88631f8` | 2.108s，精确找回 nonce |
| Gateway 正常关闭/重启后新 Run | `2d3f6a79-2f64-4873-a89f-f90d9dd5364c` | 2.607s，精确找回同一 nonce |

两次恢复使用同一后端 ID，后续 prompt 不包含 nonce。会话最后关闭，专用 Gateway 退出。证据 `.tmp/mac-final/gateway-recovery.json`；另外的低层双 Worker 探针位于 `.tmp/acp-recovery-probe/result.json`。本地对端测试覆盖 checkpoint 缺失/损坏/身份变更/后端拒绝，均没有偷偷发起第二个 `session/new`。旧 Run 不自动重跑，执行中的崩溃/取消仍遵守保守关闭策略。

## OpenClaw 与 Pi

OpenClaw 原生调用当前已使用 DeepSeek，旧 OAuth 错误属于旧配置。其 ACP Bridge 默认 `acp:<uuid>` 与内部 ACP Runtime 会话分类冲突，首个正式尝试返回错误文本，虽然协议回合结束，也没有记作模型成功。独立 session-key launcher 修复后，Run `cd3515ba-1d5b-4304-a71e-8d7c77cf1273` 在 5.274s 精确回复 `HARNESSHUB_OPENCLAW_ACP_OK`；独立 native key、不复用用户主会话，无工具事件、无残留 Worker。没有修改全局 Gateway 配置或凭证。见 [OpenClaw说明](../openclaw-engine.md)。

Pi 固定 `pi-acp 0.0.33`、Pi `0.85.0`，先经正式 Gateway 文本验证，再通过上表文件任务。原凭证仅在 launcher 子进程环境使用；本次数据检查没有发现密钥明文。包安装和缺失依赖补充见 [Pi说明](../pi-engine.md)。Pi 的恢复、真实审批与取消尚未专项验证。

## 自动检查与边界

新增文件采集 9 项、ACP 严格恢复 8 项、原 Worker ACP 2 项、安装快照 7 项、挂起检查的 deadline/cancel/close 3 项、Backend ID 原子持久测试及正式 Gateway 文件/恢复组合均通过。Benchmark 的文件/旧格式/权限/离线证据与模型观测按受影响范围通过。未重复调用已经通过且配置未变化的模型任务。

修复了终态后的 Session close 不幂等问题，避免已超时的 ACP Run 在 Benchmark 清理时再次报错；也修复了只读安装检查挂起时阻碍取消收敛的问题。安装快照和 ACP 模型事件可进入报告；后端未返回 token/usage/cost 时保留 null，累计 usage 不当成本轮消耗。

Windows ACL/句柄/进程树与发行仍未验证，移交步骤见 [VMware 验收](../vmware-validation.md)。当前没有自动任务拆分、跨引擎无损迁移或可视化控制台；这些是独立后续产品任务，不在本轮 Mac 执行链验收范围。

## 常驻服务与最终检查

本轮代码已用于重启原 `127.0.0.1:3182` 服务，`ready=true`。默认 `dsh` 新版本已开启 resume；Pi、OpenClaw新Bridge、opencode-deepseek 均已登记启用并可被发现。原 opencode 免费配置保留，使用前需注意已有429限流证据；旧 Run 和原 revision 仍可查。当前注册信息保存在 `.tmp/mac-final/live-service.json`；升级服务时确认没有活动 Run，没有为最终部署再重复模型调用。

最后一批受影响的Gateway/队列/动态目录/文件/恢复/安装取消/发现检查19项全部通过，构建、ESLint、37个源文件的模块边界及35份Markdown文档检查通过。仅一个源文件的格式检查失败，格式化该文件后局部复查通过；没有因此重跑模型或整套无关测试。所有真实失败（旧OpenClaw Bridge与OpenCode免费限流）都保留在运行目录及本文。
