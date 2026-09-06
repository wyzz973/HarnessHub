# Pi 引擎接入

Pi 通过现成 `pi-acp` Adapter 复用 HarnessHub 的 ACPDriver。当前 Windows 发行组合与下文 2026-09-05 的 macOS 历史配置分别记录，不应混用版本、入口或认证目录。

## 当前 Windows 发布组合

[便携发布包](portable-bundle.md)固定 `@earendil-works/pi-coding-agent@0.85.1` 与 `pi-acp@0.0.33`，通过包内 Node 启动 Pi 的 `dist/bundle/cli.js`。完整依赖由开发机按 distribution 锁文件准备，裁判机不再安装 Pi 或补充包。不要替换成旧 0.73.1；该版本没有 Adapter 用于结束请求的 `agent_settled` 事件。

比赛 Provider 使用 [独立配置](engine-configuration.md)生成私有 models.json/settings.json，并以 `$HARNESSHUB_PROVIDER_KEY` 引用子进程密钥。它支持配置矩阵中的 OpenAI Completions、Responses 和 Anthropic；不引用下文的个人 DSH 凭证文件。统一 ACP MCP 注入明确拒绝，原生扩展与工具调用须另行验证。实际模型、文件、取消和恢复证据以对应 Windows 验收记录为准。

## 2026-09-05 macOS 固定安装

采用 ACP Registry 指向的 [svkozak/pi-acp](https://github.com/svkozak/pi-acp)，其方式是启动 Pi 的 RPC 模式并转换 ACP 消息。Pi 本体来自 [earendil-works/pi](https://github.com/earendil-works/pi)。本次锁定版本如下：

| 部件 | 版本 |
|---|---|
| Node | 24.20.0 |
| HarnessHub ACP Runtime | acpx 0.13.2 |
| Pi Adapter | pi-acp 0.0.33 |
| Pi | @earendil-works/pi-coding-agent 0.85.0 |
| Pi 配套缺失依赖 | @earendil-works/pi-server 0.85.0 |

在项目根目录安装到独立目录，不修改主包依赖或系统 Pi：

```sh
PATH="$PWD/.tools/node/bin:$PATH" npm install --prefix .tools/pi --save-exact --ignore-scripts --no-audit --no-fund pi-acp@0.0.33 @earendil-works/pi-coding-agent@0.85.0 @earendil-works/pi-server@0.85.0
PATH="$PWD/.tools/node/bin:$PATH" node .tools/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --version
```

`.tools/pi/package.json` 和 `package-lock.json` 保存精确安装状态。再次安装同一环境使用该目录现有 lock 与 `npm ci --prefix .tools/pi --ignore-scripts`；运行任务时不执行包安装或升级。

Pi 0.85.0 的发布包包含对 `@earendil-works/pi-server` 的静态导入，但未在其依赖表声明；只安装 Pi 时，`--version` 即报 `ERR_MODULE_NOT_FOUND`。本次显式安装同版本配套包后可以正常启动。没有修改上游包源码。升级 Pi 后需重新核对是否仍需这项补充依赖。

## 现有 DeepSeek 凭证引用

[launch-pi-acp.mjs](../scripts/launch-pi-acp.mjs) 的四个参数都是绝对路径：Adapter 入口、Pi 可执行文件、已有 DSH 设置文件、已有 DSH 凭证文件。[配置示例](../engines/pi.example.json)可通过 [动态管理 API](engine-management.md)注册；替换其中的占位路径即可。它是单个引擎配置，不是完整 Gateway 配置文件。

Launcher 只接受 DSH `agent-default-model.provider: deepseek-official`，沿用其模型 ID 和显式 `reasoningEffort`。Pi 官方 [Provider 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)支持 `DEEPSEEK_API_KEY` 环境变量；本实现读取已有凭证文件中的 `refs.DEEPSEEK_API_KEY`，只传给启动的 Adapter/Pi 子进程环境。不会把原密钥写入 HarnessHub 配置、业务数据库或新的 `auth.json`。

模型偏好保存到 Worker 私有 HOME 下的 `.pi/agent/settings.json`；默认 Provider 映射为 Pi 的 `deepseek`。本次使用 `deepseek-v4-flash` 和 `max`，已核对 Pi 0.85.0 的内置模型目录支持这两个值。该偏好文件只包含模型、thinking 和启动选项，不含凭证。

Launcher 拒绝使用操作系统用户的原始 HOME，避免直接运行时改写其全局 Pi 设置。它关闭启动阶段的版本检查与安装遥测，使用固定的 Pi 可执行路径。`PI_OFFLINE=1` 按 Pi 的 [设置说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)仅禁止启动阶段网络操作；实际模型请求仍发送给原有 DeepSeek API。

## 2026-09-05 macOS 历史验收

测试通过独立 Gateway 与私有数据目录完成：

1. 使用管理 API 注册 Pi 配置。
2. 创建公共 Session，提交只要求精确返回 `HARNESSHUB_PI_OK` 的任务。
3. ACP 实际模型报告 `deepseek/deepseek-v4-flash`，Run 正常完成，输出精确相同。
4. 通过 API 关闭 Session，再关闭专用 Gateway。Worker lease 清空。

任务耗时约 3.09 秒；未调用工具。公开 Run ID 为 `0bae18a5-56d3-4c13-b366-47a39aa01303`。本机证据位于忽略提交的 `.tmp/pi-connect/result.json`、`rollout.jsonl` 和 `launcher-verification.json`。

Launcher 的正例及原始 HOME、缺失凭证两项拒绝测试通过；对本次数据目录的 9 个文件检查未发现实际密钥明文。该检查只证明这次运行，没有将凭证输出到日志或验收记录。

随后复用 [文件 Benchmark](../examples/benchmark-files.json)执行一次完整文件任务，沿用相同模型和 `max` 配置：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --config .tmp/pi-connect/benchmark.config.json --dataset examples/benchmark-files.json --engines pi --permissions allow-once --data-dir data/benchmark-pi-files-mac
```

此命令引用本次本机配置路径；在其他机器运行时需先按配置示例生成自己的完整配置。结果为 `completed` 与 `passed / json_match`，约 8.80 秒，`result.json` 的全部字段和数组顺序匹配预期。另对 `summary.txt` 独立核对了精确的 42 字节内容：`paid_orders=4 units=10 revenue_cents=5750` 加一个换行。原输入文件 SHA-256 不变，两份产物均已登记，关闭后 Worker lease 为零。

文件 Run 为 `e575dc03-516e-4130-8e1a-ba09f02746b8`，attempt 为 `f454cbea-0871-4e0b-a30d-1fdff4f25087`；证据在 `.tmp/pi-connect/file-result.json`、`file-report.json` 和 `data/benchmark-pi-files-mac`。此次记录了 18 条工具更新，未触发权限请求；`allow-once` 是运行策略，不能作为 Pi 审批往返已经通过的证据。

## 仍需验证的能力

- Adapter 在握手中声明 `session/load`；这只是能力声明，本配置尚未设置 `acp.sessionMode: resume`，需另做上下文恢复验收。
- Pi 的工具由引擎本地执行。不能把 ACPDriver 支持权限往返理解为 Pi 的全部工具都有审批；本次文件任务没有触发权限请求。
- 本次 `engine.usage` 的模型信息存在，但 `usage` 为 `null`，因此没有 token 或费用完成数据。
- 以上 Mac 文本和文件结果不覆盖 Pi 专项的取消、强制退出、上下文恢复或 Windows 原生进程清理；这些能力须查对应版本和平台的验收记录。
