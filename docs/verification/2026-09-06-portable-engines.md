# 验收：Windows 便携引擎与 DeepSeek

日期：2026-09-06。环境：Windows 11 ARM64、Node 24.20.0、pnpm 10.12.3；桌面 HarnessHub，分支 `feat/windows-native-support`，基线 `162f39d88e35b45a195b479d918caaac6120d3d6` 加本轮修改。

## 已完成的源码和准备目录验证

最终 `pnpm check` 退出 0（`final-patched-check.log`）：tooling 46 通过 / 1 跳过，unit 70 通过，integration 105 通过 / 2 跳过，smoke 2 通过 / 1 跳过，合计 223 通过、4 项按平台跳过。包含 lint、格式、模块边界、文档、40 项 API 同步及生产控制台构建。Windows 原生专项 17 项通过、无跳过。

开发机准备入口 `prepare-contest.mjs --check` 验证固定 Node、13 个直接 npm 依赖、原生引擎、Hermes 的 Python/wheel 闭包、Kiro/VC、PortableGit、OpenClaw lifecycle、工具包和许可证来源。输出 16 个引擎模板，`downloads:false`、`modelCalled:false`。准备目录检查与发行目录验收分别记录。

用户明确提供 DeepSeek API 并授权测试。本轮仅使用 `deepseek-v4-flash`；未继续使用上一轮 Codex 个人登录。密钥保存为本机 DPAPI 引用，模板和测试脚本不含明文密钥。对本轮 168 个变更/新增源码文件的实际密钥字节扫描为零命中。测试状态保存在忽略目录，不随发行包交付。

## 真实模型任务

直连 API 返回 HTTP 200 和确定标记，报告 20 tokens。以下引擎随后均经正式 Gateway、Worker、ACP/CLI、Benchmark 和确定性评判器通过短文本或 JSON 任务；每次任务总期限为 60 秒。模型服务可用、任务正确及工具执行分别判定。

| 引擎 | 本轮固定版本 | DeepSeek 协议 | 短任务 |
|---|---|---|---|
| Codex | 0.153.4 / codex-acp 1.10.0 | Responses | 通过 |
| Claude Code | 2.1.263 / claude-agent-acp 0.75.1 | Anthropic Messages | 通过 |
| OpenCode | 1.18.29 | Chat Completions | 通过 |
| GitHub Copilot CLI | 1.0.83 | Chat Completions BYOK | 通过 |
| Qwen Code | 0.23.0 | Chat Completions | 通过 |
| MiMo | 0.1.14 | Chat Completions | 通过 |
| Pi | 0.85.1 / pi-acp 0.0.33 | Chat Completions | 通过 |
| Hermes | 0.19.0 | Chat Completions | 通过 |
| Kimi | 1.50.0，非交互 CLI | Chat Completions | 通过 |
| OpenClaw | 2026.9.2 | Chat Completions | 通过 |
| DSH | 0.1.2-rc.1 | Chat Completions | 通过 |

Gemini、Cursor、Kiro、Antigravity、Qoder 随包准备程序，但不将这些引擎记作同一 DeepSeek API 的真实模型通过。Google 兼容 API、厂商登录及服务协议限制仍由相应产品决定。16 个模板不表示 16 个引擎支持任意 Provider。

正式记录位于 `.tmp/contest-planning/deepseek-*.log` 和 `.tmp/contest-acceptance/`；可交付的摘要另导出为 `deepseek-engine-results.json`。失败的早期尝试保留，不覆盖成通过。

## 真实工具与文件

安装同一个零依赖 `workspace-tools` 包，任务要求通过 MCP 读取随机文件，再使用引擎原生写入工具在含中文和空格的指定工作区写出精确字节；由正式 artifact API 读取结果核对，并要求 Run 完成、清理确认。

Codex、OpenCode、MiMo、Claude、Copilot、Qwen 六个引擎均通过 MCP 读取与精确产物检查。Claude 的早期配置启用官方 safe mode，实际只调用了工具 CLI；找到它会禁用 MCP 后，改为单独关闭自动更新、非必要后台流量和官方 marketplace 自动安装，再经本地模拟 API 与真实模型验证 MCP 可见和可用。

早期 Copilot、Qwen 的失败结果保留。Copilot 1.0.83 拒绝 ACP 注入的 stdio MCP，改由 Session 私有原生配置注入；文件只写环境变量引用，HTTP/SSE MCP 仍走 ACP。修复后真实 Run `551eddf0-651b-405f-b025-89924e0e5f92` 通过。Qwen 0.23.0 的后台 MCP 初始化可能晚于首个任务，选用官方阻塞初始化开关后，再修复客户端文件能力声明与精确权限选择；真实 Run `d18c6aa7-cc60-4ded-81b9-86184528b188` 通过 MCP 调用和实际文件产物检查。

验收收集器最初请求 10,000 条事件，但 SQLite 单次返回上限为 1,000。已修复测试脚本分页，并从保存的全量事件只读重建 `results-reconciled.json`，没有为补日志重复模型任务。正式 API 的分页上限保持不变。

## 已修复的运行边界

Pi 更新到与 pi-acp 生命周期兼容的固定版本；Copilot BYOK/OpenClaw 使用其实际的原生模型选择；Qwen 使用原生模型 ID；Hermes 使用 `providers.custom.key_env` 并验证实际鉴权头，PortableGit 的直接二进制避免 Python 管道超时死锁。Codex 提供匹配固定版本的模型元数据和指令基线，消除成功输出中的元数据警告。

ACP 初始化预算与任务总期限独立，恢复会话须等真实 reconnect/resume 完成才停止初始化计时。挂起重连测试确认实际引擎和后代进程消失，同时保留旧会话内容。发行 CLI 检测会被控制台 SQLite 覆盖隐藏的配置变更时明确失败，保留已有设置和历史。

固定 acpx 0.13.2 补丁通过公开 runtime 显式关闭客户端 fs/terminal，保留引擎原生工具及权限请求；支持返回本次请求的精确 optionId，避免同 kind 多选项选错。真实 SDK、初始化、恢复和晚到权限等 19 项相关集成测试通过，补丁原文与许可随包提供，范围见 [ADR 0010](../decisions/0010-acpx-client-capabilities.md)。此设置不构成操作系统文件沙箱。

## 发行验收范围

用户随后明确本轮以“配置好引擎”为收尾范围。发布目录 v3 构建退出 0：16 个引擎模板、118,954 个清单文件，共 5,095,692,990 字节，包含最新 acpx 补丁；构建器实际完成包内 Gateway 导入、生产控制台及静态资源启动检查、文件 hash、原生 addon 架构和开发机路径检查。额外搬迁、发行目录真实模型/取消/重启/Benchmark 与 ZIP 验收不再执行；前述准备目录成功任务不代替这些验收。Windows 10、Windows x64、实际裁判机和具体赛题规则尚未验收；ARM64 包包含需 Windows 11 x64 仿真的 Hermes/Kiro 组件。

本机运行配置已完成：实际 `hub.cmd engines` 入口成功；11 个引擎启用 `deepseek-v4-flash` 和 Windows DPAPI 引用，默认 OpenCode，另 5 个受协议或账户限制的模板停用。`workspace-tools` 已通过发行 CLI 安装并绑定 OpenCode、Codex、Claude、Copilot、Qwen、MiMo。后台 Gateway 3180 与控制台 3330 均已就绪，实际 HTTP 注册表与持久设置核对通过（`configured-preview.json`）；这组启动/配置检查没有调用模型。

生产页面只读复核通过（`configured-browser-confirmed/browser-report.json`）：16 行引擎、11 个启用，Codex 模型/Responses/加密凭证引用正确，新密钥输入为空，未保存弹窗关闭后注册表不变，390px 视口无横向溢出；全程仅本地 GET。首次浏览器脚本未等待异步 Provider 选项而提前失败，其原始报告保留；修正测试脚本等待条件后复核，没有修改业务页面来绕过断言。

API 依据：[DeepSeek 文档](https://api-docs.deepseek.com/zh-cn/)、[Responses](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)、[Anthropic 兼容接口](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)。引擎、Adapter、原生依赖及许可证来源以发布清单和仓库第三方声明为准。
