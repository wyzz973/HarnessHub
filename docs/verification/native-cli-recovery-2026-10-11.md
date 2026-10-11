# 原CLI认证与Homebrew恢复验收（2026-10-11）

范围依据[ADR-018](../decisions/0018-native-cli-recovery.md)。实际实现位于HarnessGateway；HarnessHub已有未提交文档保持原状。统一Provider管理后置，沿用本机原安装、模型配置和登录。

## 原Homebrew升级

原嵌套sandbox-exec失败通过已安装Homebrew的Sandbox.capture及真实继承接口修复。非PTY子进程保持管理进程组，原SDK创建一个沙箱并验证继承描述符；未伪造描述符、关闭沙箱或修改Homebrew源码。模型、认证、shell目录/文件拒绝写入，Homebrew仓库仍按原SDK保护；SDK源码摘要进入冻结计划。未知或不支持SDK明确失败。

正式管理HTTP→SQLite任务→原Homebrew升级Codex，任务`management-7b9b7048-b3f2-4e74-86c6-2d6ccd85bdba`：原`/opt/homebrew/bin/codex`由0.160.0升级到0.162.1，completed、实际版本核实、configurationPreserved=true、installationId=null。私有回执与日志分别为`.tmp/native-codex-action-result.json`及`.tmp/native-codex-action-logs.json`。升级后原登录/gpt-6.1-sol真实回复、backend.completed、cleanup.closed，见`.tmp/brew-codex-after-upgrade.jsonl`。

`brew ruby`的初次只读SDK探查曾自动打开developer偏好，发现后已恢复原disabled状态。正式执行仅使用进程内HOMEBREW_DEVELOPER=1，升级前后全局developer均disabled。配置内容未导出；Codex/OpenClaw/Gemini/OpenCode/Claude settings及Pi配置摘要仍与此前记录一致。

真实macOS反例测试直接调用原Homebrew SDK：继承认证成功；尝试修改受保护模型文件明确返回EPERM且原内容不变；尝试以写方式打开Homebrew自身也明确返回EPERM。正例与拒绝理由均断言，失败不能算通过。

## Cursor原安装、登录与模型

用户已在官方入口完成登录，原CLI实际status确认。正式管理任务`management-3bc5fe70-2024-4c66-aac0-90874968ee43`通过原Cursor官方更新器把`~/.local/bin/cursor-agent`原安装由2025.09.18-7ae6800升级到2026.10.01-e373342；没有安装替代版本或复制桌面应用凭据。原`.cursor`配置/认证目录纳入维护写保护和配置摘要核实。

原CLI ACP读取44项模型，首次探测默认ID为`default[]`、原生名称Auto；每次读取以原CLI当前返回为准。模型选择通过原ACP接口；UI默认项使用原生名称，内部ID不改写。`.tmp/cursor-final-native-reply.jsonl`记录真实回复“Cursor 接入成功”，backend.completed/end_turn、cleanup.closed=true、exit143、protocolFailure=null。另一次诊断核实CLI及其MCP子进程关闭后进程组为空。

首个独立CLI尝试曾在清理时出现kill EPERM，不能把那次当作完整通过。原日志、临时目录与失败事实保留；后续成功记录不覆盖这个事实。结束后人工核实原拥有者PID不存在，独占本机维护锁下没有其他读租约，也没有Cursor/其BrowserTools MCP进程，再把本轮测试的残留读租约归档到私有目录。这个人工核实没有改成生产自动回收规则，见`.tmp/cursor-test-lease-inspection.json`。

原公共对话分别选择Composer 2.5与跟随本机配置后，原Cursor均实际回复“Upgrade your plan to continue”。协议结束与清理均确认，但这是账号套餐限制，不能当生成任务通过，也不能因为原目录暴露44模型而宣称每项都有使用权限。

原会话`session-80ac61ac-88d8-4614-b96b-c88d2cfc04f4`的7轮原历史保持，新增两轮Cursor套餐提示与一轮OpenClaw验证，共10轮。切回原OpenClaw2026.3.23-2后正常引用最早的“你好”；最后任务`run-9df0fe5b-1a12-4f5f-aee1-efcecdca1466`为completed/end_turn、cleanup.closed=true、protocolFailure=null，原ACP进程退出码1如实保留。会话仍open，无pendingSwitch。原OpenClaw Gateway未升级或重启，原配置摘要一致。持久状态证据`.tmp/native-cli-recovery-public-session.json`，可见结果截图`.tmp/native-cli-recovery-chat.png`。

## Gemini直连DeepSeek

原Gemini0.62.0及原OAuth配置保持。Google已公告个人免费/Pro/Ultra CLI链路自2026-06-18停用；企业/付费Google API Key路线仍支持，升级二进制无法恢复已停用的个人链路。[Google官方公告](https://github.com/google-gemini/gemini-cli/discussions/27274)

用户要求核实DeepSeek Key。使用原Gemini二进制、私有临时API-key配置及本机已有有效DeepSeek凭据，直接指定DeepSeek接口和当前模型deepseek-flash，实际请求失败：404 Not Found、PROCESS_FAILED。此前deepseek-chat试验同样404。仅测试配置隔离，用户原Gemini settings摘要未变化，未保存密钥到仓库、Hub Provider或全局Google配置。

原CLI已安装bundle的createContentGenerator使用GoogleGenAI；自定义base URL仍走Google GenAI协议。DeepSeek提供[OpenAI/Anthropic兼容接口](https://api-docs.deepseek.com/)，它不能直接接收这个GenAI请求。结论限定为当前原生CLI直连不兼容；不隐式新增协议转换代理或更换fork。缺少Google兼容凭据或用户选择的官方迁移路线，Gemini真实回复仍未恢复。

## 检查与边界

- `pnpm test`：457通过、0失败、0跳过、0todo。
- `pnpm build`及`pnpm web:build`通过。
- `node --test dist/tests/real/homebrew-native.real.js`：1通过、0失败、0跳过；macOS原SDK保护正例及两个写入反例。
- `node --test dist/tests/browser/web.browser.js`：4通过、0失败、0跳过；模型名称修正后首次暴露默认选项与显式模型同名，已用“名称 · 本机默认”区分并重新通过，未放宽测试。
- `python3 tools/check_design.py --write`、`pnpm check:design`与`git diff --check`通过；新增平台蓝图335个场景不是运行通过数量。

业务库仍为v4、管理库仍为v2，本次没有格式迁移或清库。原会话和历史失败保留。平台结果限于当前macOS；Windows未验证，全部43个Harness/所有安装渠道未逐项验收。Claude账号周额度限制仍存在。测试蓝图仍为planned，真实运行证据仅由本记录及实际日志说明。
