# 本机OpenClaw原安装与DeepSeek验收

日期：2026-10-11，Asia/Singapore。基线2783179。范围：[ADR-016](../decisions/0016-local-installation-and-openclaw.md)的原安装优先、ACP会话兼容、原生DeepSeek和图标补齐。

## 原因与修复

1. 终端的/opt/homebrew/bin/openclaw为2026.3.23-2（7ffe7e4），原配置有效；网页旧逻辑却让私有2026.9.9覆盖PATH，触发新旧配置不兼容。现在实际PATH/显式入口优先，版本和来源与执行入口一致；失败不静默换版本。
2. 原安装在session/new确认前发送session_info_update/available_commands_update。旧Driver尚无SessionId，误判为身份错误。现在仅有界暂存初始化元数据，确认后逐项校验；早到文本、工具、权限、错误身份和超128项仍拒绝。
3. 原桥接默认acp:键进入OpenClaw自己的ACP-runtime路径；普通短键又被Gateway规范化，旧桥接按字符串匹配时收不到结束事件。专属Driver通过安装明确支持的_meta.sessionKey，使用配置中默认agent及完整agent:<id>:harnesshub:<uuid>键。JSON5@2.2.3用于有界读取配置，不复制/修改原安装或全局配置。

OpenClaw原生配置已经默认使用deepseek/deepseek-chat，原auth-profiles中的DeepSeek认证有效。本轮直接沿用它，没有替换成用户后来提供的密钥，也没有新增Hub Provider。2026.3.23-2的ACP没有声明模型切换能力，界面显示实际配置模型并跟随本机；不能用全局models set或硬编码目录冒充会话模型选择。

所读依据为本机该安装的docs/providers/deepseek.md、docs/cli/acp.md及dist/acp-cli-BQ740PFm.js，以及[OpenClaw ACP官方说明](https://docs.openclaw.ai/cli/acp)、[DeepSeek官方OpenClaw接入说明](https://api-docs.deepseek.com/quick_start/agent_integrations/openclaw/)。在线文档可能晚于本机安装；行为以本机版本源码和实测为准。

## 实际证据

| 检查 | 实际结果 |
|---|---|
| `openclaw --version` | 2026.3.23-2（7ffe7e4），原安装未升级 |
| `openclaw config validate --json`、`openclaw health --json` | 原配置valid、已有Gateway健康；原Gateway进程未重启 |
| `pnpm build`、`pnpm web:build` | 严格类型与生产构建通过 |
| `node --test dist/tests/*/*.test.js` | 431通过，0失败/跳过，约18.3s；`.tmp/local-openclaw-tests-final.log` |
| `node --test dist/tests/browser/web.browser.js` | 4通过，0失败/跳过，约23.5s；全部Harness行有已加载的SVG图标，另覆盖选择、草稿、停止、重连、窄屏；`.tmp/local-openclaw-browser-final.log` |
| `node --test dist/tests/real/codex-session.real.js dist/tests/real/harness-provider-switch.real.js dist/tests/real/live-web-stream.real.js` | 3通过，0失败/跳过，约5.3s；真实Codex/Gemini与本地确定性模型，不读个人云凭据；`.tmp/local-openclaw-real-regression.log` |
| 正式CLI `run:harness`，原OpenClaw+原DeepSeek | 文本OPENCLAW_CONFIRMED_DEEPSEEK_OK、backend completed/end_turn、cleanup.closed=true/protocolFailure=null；`.tmp/openclaw-confirmed-deepseek-run.jsonl` |
| 当前原公共对话 | OpenClaw switch effective；一条明确测试输入产生completed Run，回答最早用户消息为“你好”；原messages/runs/switches保持，新Run仅1条；`.tmp/local-openclaw-live-result.json` |
| 模型实际来源 | 原生新会话的对应用户输入与公开Run一致，原生终态记录provider=deepseek、model=deepseek-chat；没有调用Hub Provider或以其他模型fallback算DeepSeek成功 |
| 配置保护 | 原openclaw.json从初始观察到最终检查SHA256均为c652a232ec3217d749bd16bf3848fb39fb6ba5d08d18ba6b69f6ce2d8fbde26e；既有认证原生使用，无全局模型/认证替换 |

旧ACP错误字符串即使被原桥接返回end_turn，也没有作为验收成功；短键第一次实测的模型已经在原生记录完成，但桥接超时，明确记失败。通过完整会话键后的CLI和当前公共对话分别验证真实文本、实际模型及关闭，不用exit code猜完成。OpenClaw桥接在正常关闭时exitCode=1，closed及protocolFailure单独确认；正常owner关闭与意外退出不同。

现场更新前检查无活动Run/待切换，正常停止原服务，以SQLite备份接口保存v4业务库到私有`.tmp/pre-local-openclaw-*/`（0600）。重启仅更新代码，没有格式迁移、清库、改写旧失败记录或重跑旧任务。最终原对话仍open，选择OpenClaw，显示deepseek/deepseek-chat。真实截图在忽略目录`.tmp/openclaw-deepseek-current-chat.png`、`.tmp/local-original-installations.png`。

## 安装管理与图标

五个已连接入口的页面版本现在来自终端原安装：Codex0.160.0、Cursor2025.09.18-7ae6800、Gemini0.62.0、OpenCode1.18.35、OpenClaw2026.3.23-2。旧私有安装记录保留，但不能覆盖已找到或损坏的原入口。原生安装升级配方尚未完成：系统项不再提供“更新并管理”来创建替代副本；HTTP在提交前重查原安装并明确拒绝这种替代操作。没有执行本机程序升级，不能报告原生升级通过。

补齐13个固定ACP Registry官方SVG，并修正Claude Code/Pi身份映射，来源/哈希/审阅边界在[素材记录](../../web/THIRD_PARTY_ASSETS.md)。SVG不包含脚本、事件、foreignObject或外部引用，运行时本地加载。浏览器实际确认43个Harness行的品牌图片完整加载。

## 当前边界

本轮真实云任务覆盖OpenClaw+现有DeepSeek；没有声称所有其他Harness、Windows/Linux或所有安装渠道升级通过。其他原安装采用同一优先与配置沿用规则，原生升级仍须独立配方和验收。Provider统一管理保留为整体链路的后续环节，不作为本轮DeepSeek接入手段。原生公共上下文重建不等同搬运内部checkpoint或正在运行的工具。

凭据、配置正文、原生/公共真实轨迹、备份和截图均不进入Git。原HarnessHub的已有未提交文档未改动。
