# OpenCode 的独立 DeepSeek Profile

本机 OpenCode 已通过 ACP 接入。原 `opencode / opencode/big-pickle` Profile 保留；新增 `opencode-deepseek` 使用现有 DSH 的 DeepSeek 配置与凭证引用，方便在默认模型额度不足时显式选择另一套配置。

## 本机故障与处理依据

2026-09-05，原 Profile 的文件任务在 180 秒外层 deadline 到期后记为 `timed_out`。只读 OpenCode 日志发现，09:42:39—09:44:47 UTC 内 `big-pickle` 多次返回 HTTP 429、`FreeUsageLimitError`；09:42:52 有 `AI_RetryError / maxRetriesExceeded`。引擎仍持续内部重试，ACP 未将这些重试错误上报为公共失败事件。工具准备仅 33 ms，故没有将这次故障误记为 MCP 启动失败或文件能力缺失。

新的 `opencode-deepseek` 使用已配置的 `deepseek-v4-flash`，不是修改旧 Profile 的含义或重跑原来的限流请求。原用户 OpenCode 配置和系统 CLI 均未修改。

## 版本、配置与隔离

[启动脚本](../scripts/launch-opencode-acp.mjs)面向本机 OpenCode `1.1.21`，复用已安装的 `@opencode-ai/plugin 1.1.21` 依赖。配置能力由该二进制内嵌源码与本地 SDK 类型核对：

- `OPENCODE_CONFIG_CONTENT` 支持进程级配置；`model`、`small_model`、`enabled_providers` 和 `provider.models` 可以独立设置。
- `@ai-sdk/openai-compatible` 已内置，不需要安装新的 Provider 包。
- 该实现的 `reasoningEffort` 接受字符串并映射为请求中的 `reasoning_effort`，其余模型选项透传；因此显式使用 `max` 与 `thinking: { type: "enabled" }`。
- 本地已有模型目录包含 `deepseek-v4-flash` 及其 `reasoning_content` 传输方式。context/output 元数据从该目录读取，不猜测或降低模型上限；OpenCode 自身既有输出预算逻辑继续生效。

脚本要求 Worker 私有 HOME，拒绝直接复用当前系统用户的 HOME。HOME/XDG 配置、缓存、数据和状态目录都属于本次 Worker。只复制已安装的 `package.json`、`bun.lock`、`node_modules` 与公开模型目录，不复制 OpenCode 的原 auth 文件、用户插件或原配置。

OpenCode 1.1.21 会固定执行一次 `bun add` 与 `bun install` 核对插件依赖。脚本提前复制对应依赖，在私有目录设置冻结 lockfile 和回环地址 registry，并关闭默认外部插件、自动升级、模型目录刷新、LSP 下载及 Claude Code 配置读取。本次预检和真实运行均复用了现有依赖，没有出现远程 registry 或下载记录。该配置只限制本启动链的自动安装，不是操作系统网络沙箱。

## 凭证引用与使用

DSH 设置必须选择 `deepseek-official / deepseek-v4-flash / max`。脚本读取已有凭证文件中的 `refs.DEEPSEEK_API_KEY`，只将该值传给 OpenCode 子进程环境；不会写入新的配置文件、认证文件或 HarnessHub 数据库。

复制[无凭证示例](../engines/opencode-deepseek.example.json)，把各个绝对路径替换为本机位置，然后作为配置文件 `engines` 数组中的一项，或经动态注册 API 登记。新的公开引擎 ID 是 `opencode-deepseek`，模型 ID 是 `deepseek/deepseek-v4-flash`。不要把实际密钥写进 Profile。

脚本的 `--check-config` 末尾参数只校验本地解析结果，输出模型、reasoning、插件版本和隔离模式，不调用模型。Benchmark 文件任务使用：

```sh
PATH="$PWD/.tools/node/bin:$PATH" node dist/src/benchmark-main.js --config .tmp/opencode-file-fix/opencode-deepseek.json --dataset examples/benchmark-files.json --engines opencode-deepseek --permissions allow-once --data-dir data/benchmark-opencode-deepseek-mac
```

上面的配置路径是本次本机验证所生成的独立配置，不属于可跨机器直接使用的模板。其他机器应从 example 替换实际路径，并准备相应本地依赖。

## 本次 macOS 验收

2026-09-05，在 macOS、Node `24.20.0`、OpenCode `1.1.21` 上完成一次有实质配置变更的同题验证：

| 项目 | 结果 |
|---|---|
| Run | `c1018f57-c65d-4255-a203-b45d84abadae` |
| 实际 ACP 模型 | `deepseek/deepseek-v4-flash` |
| 耗时 | 10,017 ms |
| 执行与评分 | `completed`，`json-equal: passed`，1/1 |
| 工具与权限 | 19 个工具更新，2 次真实权限选择，实际 option ID `once`，均 `applied` |
| 产物 | `result.json` 447 字节；`summary.txt` 42 字节，均自动登记 hash |
| 正确性 | JSON 汇总为 4 单、10 件、5750 分；另外按字节核对摘要及末尾换行一致 |
| 清理 | Benchmark 已关闭 Session；Worker lease 为 0 |
| 安装与消耗 | 保存了 `engine.installation` 本地文件快照；ACP 本轮 usage 未提供，保持 null |

证据保留在本机 `.tmp/opencode-file-fix/success-summary.json` 和 `data/benchmark-opencode-deepseek-mac/harnesshub.sqlite`，不提交真实运行数据。此验收证明本机的读取、计算、写文件、权限往返、自动收集和判分链路；不代替 Windows、上下文恢复或所有 OpenCode 版本的兼容性验证。
