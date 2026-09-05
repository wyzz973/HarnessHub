# 验收：macOS 已安装 Agent 引擎连接

日期：2026-09-05。范围：用户指定的 Codex、Claude Code、OpenCode、OpenClaw、DSH。结果：四个引擎通过 HarnessHub 正式 Gateway/Worker 完成真实模型文本 smoke；OpenClaw 协议连接通过，但原生模型调用报告 OAuth 失效。

## HarnessHub 正式入口结果

服务为 `http://127.0.0.1:3181`，启动参数使用本地 `engines/local.yaml` 和 `data/mac-engines`。测试文本要求精确回复 `HARNESSHUB_OK`，不使用工具、编辑文件或对外发消息。以下是单次接入测试耗时，含启动/排队，不是性能或质量排名。

| 引擎 | 本机入口版本 | 模型选择 | Run结果与标记 | 耗时 |
|---|---|---|---|---|
| Codex | codex-cli 0.144.5 | gpt-5.6-sol | completed；精确标记通过 | 47.705s |
| Claude Code | 系统Claude 2.1.261 | opus别名（原配置） | completed；精确标记通过 | 5.601s |
| OpenCode | 1.1.21 | opencode/big-pickle（默认） | completed；精确标记通过 | 9.414s |
| DSH | 0.1.2-alpha.2，源码0a53fb55 | deepseek-official/deepseek-v4-flash | completed；精确标记通过 | 2.738s |
| OpenClaw | 2026.3.23-2 / 7ffe7e4 | 原生调用最终openai-codex/gpt-5.4 | ACP初始化通过；原生模型调用OAuth错误 | 未重复发起Gateway模型任务 |

前四项使用同一份Gateway、Runtime和ACPDriver实现，仅更换本地Profile和官方Adapter。各Run均有 `engine.capabilities`、文本事件和唯一 `RUN_COMPLETED`，记录到SQLite并可导出Rollout；轨迹中工具调用事件为0。各测试workspace最后仍为空。

| 引擎 | Session ID | Run ID |
|---|---|---|
| Claude Code | `43978213-c5f4-48de-add0-5a4bc642fa43` | `e44f9e15-20ad-454d-9ab0-738d263d4576` |
| Codex | `ad6f20eb-86dd-418a-b696-03935f4bdb85` | `6b9bd374-b243-4404-9a2d-e2c501c908ac` |
| DSH | `0ab23103-a6d9-4f4f-998f-ff6cf5d0ef28` | `18051e60-9684-4ec2-a91f-692c99c62bc0` |
| OpenCode | `632e59a8-e4da-4f07-94f7-4cbf6a82b13a` | `325157d7-cc81-4a01-aa38-93f8a9ad5eb7` |

查询 `GET /v1/runs/RUN_ID` 或 `GET /v1/runs/RUN_ID/rollout`。四个Session均已通过API关闭，返回200；Worker lease目录为空，4个所属进程组均已不存在。测试创建的轨迹保留，用户原有应用进程和OpenClaw Gateway未重启。

## 连接问题及解决依据

Codex现成ChatGPT登录有效，但原配置的 `gpt-6-astra` 不在当前CLI的 `model/list` 中。一次原生调用失败后，仅作只读模型查询，选择CLI声明的默认 `gpt-5.6-sol` 作为本地Profile覆盖，随后Gateway测试成功。用户原 `config.toml` 未改；首次错误只有not-found信号被保留，不能补造更精确的报错。

Claude原生CLI先独立通过短任务。私有HOME中仅设置 `CLAUDE_CONFIG_DIR` 仍未登录；当前系统CLI的登录元数据和Keychain namespace与默认HOME关联，因此只对Claude Adapter/CLI子进程显式引用原HOME，并启用 `CLAUDE_CODE_SAFE_MODE=1`。没有提取或复制Keychain token。

OpenCode原凭证列表为空，但返回默认Big Pickle及其他模型目录。引用原HOME/XDG配置与缓存后，ACP initialize/session-new在1.205秒通过，随后Gateway默认模型任务成功。上一轮全私有目录的17秒超时不再出现，但未唯一定位具体冷启动阻塞点。OpenCode启动时自行补装了配置目录中的插件依赖并写lockfile；未升级CLI、未手工回滚用户配置。

DSH不在PATH中，使用现有checkout的 `apps/cli/lib/bin.js --profile acp`。新建的本地patch仅引用原settings/credentials路径，watch关闭；DSH_HOME仍随Worker私有HOME隔离。独立ACP短任务与Gateway短任务均通过。

OpenClaw现有Gateway health为ok，ACP初始化也通过。但一次原生任务虽然CLI exit 0、summary completed，payload却是 `Encountered invalidated oauth token for user, failing request`，所以模型任务判失败。没有把exit 0当通过，也没有反复请求、复制其他应用token或改动正在运行的Gateway认证。

## 版本和认证边界

官方Adapter安装在被Git忽略的 `.tools/adapters`，精确入口版本为 `@agentclientprotocol/codex-acp@1.10.0` 和 `@agentclientprotocol/claude-agent-acp@0.74.0`。安装时省略可选原生包，因为明确通过 `CODEX_PATH` / `CLAUDE_CODE_EXECUTABLE` 使用系统已安装CLI；不是在验证Adapter附带的另一套引擎。

Worker和acpx本身仍有私有HOME，但本次本地Profile显式引用部分原生配置目录：Codex的CODEX_HOME、Claude的原HOME、OpenCode的原HOME/XDG、OpenClaw的config/state路径。底层引擎可以写入原生会话和缓存，因此不能称为完全私有后端状态。凭证值没有写入Profile、命令参数、仓库或报告。

认证参考：[OpenAI官方认证说明](https://developers.openai.com/codex/auth/)。Adapter路径覆盖依据见其已安装源码；本机检测、只读认证和真实任务结果是本次结论的依据。

## 后续范围

本次证明连接、会话创建、文本执行、事件记录和正常关闭，不代表文件工具、复杂编码、GUI、取消中的真实引擎收敛、跨Worker上下文恢复、Windows或Benchmark得分已经验收。OpenClaw需要先恢复其模型认证，再做对应最小任务。

本次没有修改Gateway业务代码，也没有运行不相关的全套测试。环境准备、四个Gateway Run和各阶段脱敏诊断保留在被忽略的 `.tmp/mac-engine-smoke`、`.tmp/dsh-openclaw-probes` 与 `data/mac-engines` 中。
