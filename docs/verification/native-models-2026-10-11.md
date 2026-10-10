# 本机配置、原生模型与直接切换验收

日期：2026-10-11，Asia/Singapore。基线49c40b9。切片native-models-switching；决定见[ADR-015](../decisions/0015-native-harness-models-and-switching.md)，参考资料见[Multica调研](../research/multica-native-models.md)。

## 原因与实现

原生连接原先创建空HOME/CODEX_HOME，导致本机已有的Codex配置和ChatGPT登录没有进入实际请求。协议握手仍能通过，随后模型请求失败，公开记录只剩failed，未说明原因。此次native默认使用本机已安装程序及其原配置目录、登录和必要环境；模型由实际原生接口读取，通过会话/调用参数选择，不改写用户全局配置。显式受管Provider保留为用户另选的覆盖来源。

模型列表来自Codex的config/read、account/read、model/list，ACP来自安装实际返回的configOptions或旧models。列表只投影模型身份、名称、默认值、可选能力和认证状态，不输出账号、邮箱、令牌或原始诊断。模型与受管Provider互斥。当前配置模型可以与推荐目录不同，保留Harness返回的真实当前模型，不换成猜测值。

选择Harness/Provider/模型即提出切换，无单独应用按钮。客户端串行推进切换，快速改选最终收敛到最新意图；运行中的回复保留原选择。新输入等待最终目标生效，失败保留原选择、草稿与历史，用户可改选或明确重试。未知执行、未确认清理及owner故障仍遵循原恢复边界。失败回复显示安全原因；重试按钮在窄屏保持横排。

## 已执行验证

环境：macOS arm64、Node25.9.0、pnpm10.12.3、TypeScript5.9.3、Playwright1.64.0及配套Chromium。正式真实入口回归使用本机Codex0.160.0、Gemini；native页面可以使用用户此前在本机显式安装并设为默认的私有版本，不自动下载、升级或改默认版本。

| 检查 | 结果与证据 |
|---|---|
| `pnpm build`、`pnpm web:build` | 严格类型和生产构建通过 |
| `node --test dist/tests/*/*.test.js` | 426通过，0失败/跳过，约6.5s；`.tmp/native-tests-delivery.log` |
| `node --test dist/tests/browser/web.browser.js` | 4通过，0失败/跳过，约25s；原生模型、快速改选、无Apply、失败刷新不自动重试、943/390/320px重试布局；`.tmp/native-browser-final.log` |
| `node --test dist/tests/real/codex-session.real.js dist/tests/real/harness-provider-switch.real.js dist/tests/real/live-web-stream.real.js` | 3通过，0失败/跳过，约5s；真实Codex/Gemini、SQLite、HTTP和SSE，本地确定性模型及合成凭据；`.tmp/native-real-delivery.log` |
| 真实native Codex | 沿用本机ChatGPT登录与配置默认gpt-6.1-sol，实际返回7个模型；系统0.160.0及页面当前使用的0.162.1分别通过正式Runtime发出小型云模型请求，completed、文本NATIVE_CODEX_OK / NATIVE_ACTIVE_CODEX_OK，cleanup.closed=true、protocolFailure=null；`.tmp/native-codex-cloud-result.json`、`.tmp/native-codex-active-version-result.json` |
| 真实native OpenCode | 实际返回11个模型及默认opencode/big-pickle；正式Runtime通过原生模型接口选择opencode/exo-free，switch effective、runs=0，没有prompt；`.tmp/native-opencode-model-result.json` |
| `pnpm probe --harness openclaw --json` | 沿用本机配置后真实ACP握手通过，openclaw-acp 2026.3.23-2；独立关闭确认，未发prompt；`.tmp/native-openclaw-probe.json` |

补充真实回归首次发现本机Gemini的旧models返回currentModelId=gemini-2.5-flash，而availableModels为另一个推荐目录；此前校验错误拒绝切换。保留实际配置模型后，添加真实协议进程兼容用例及重复模型拒绝反例，完整回归通过；最终426项另含配置拒绝脱敏反例，三项真实回归通过。断言未放宽为允许切换失败或少发请求。

Native合成测试显式注入私有HOME/config，不读取个人账号；外部依赖由协议对端进程替代，SQLite/HTTP/Runtime/RPC/关闭实际运行。取消发现不能启动协议操作，也不能删除配置来源。旧v3样例迁移至v4，未知格式改用5，保留严格拒绝。

## 存储与当前页面

业务格式v4追加v3→v4事务升级，保留v1→v2→v3迁移与原身份、消息、Run、命令、事件和业务水位。旧版本程序不能直接读v4；回退必须停止服务后恢复升级前备份。现场更新前确认无活动Run/待切换，通过SQLite备份接口保存v3库于私有`.tmp/pre-native-v4-*/`（0600），正常关闭原服务并启动新正式入口。v3→v4后所有Session事实仅schemaVersion变化，消息、Run、选择记录、命令、事件字节及version/lastSeq均不变；`.tmp/native-live-migration-result.json`。

原页面读取Codex的7个模型及本机默认gpt-6.1-sol，选择原生模型后无需Apply，真实switch effective、epoch升为4，没有新Run。随后两次明确选择OpenClaw复现启动失败；原Session仍open、原Codex模型选择有效，点击“继续使用当前选择”可编辑草稿且发送按钮可用。临时验证草稿已清空；未重跑用户失败消息。刷新失败目标没有新增switch，原消息/Run/选择记录/事件全部逐项保留，最终runs仍2；`.tmp/native-live-final-result.json`。

OpenClaw的现场失败是本机已显式安装并设默认的2026.9.9拒绝现有旧配置，包含已退役的messages.tts、gateway.tailscale.resetOnExit等键。另一系统安装2026.3.23-2握手通过，不能将此握手当作当前默认版本可用。本项目未执行第三方输出建议的doctor --fix或静默换版本，新增NATIVE_CONFIGURATION_INVALID安全分类与公开提示。原Codex/会话仍可使用。

从模型读取/现场切换前的基线到最终检查，Codex config.toml、OpenCode opencode.json、Gemini settings.json、OpenClaw openclaw.json四份本机全局配置SHA256全部保持。此检查不承诺Harness正常刷新认证缓存不发生；凭据不会进入公开DTO或Git。页面当前Codex0.162.1的补充云请求使用已安装记录的完整原命令（Node启动器、原Codex脚本和app-server参数），在私有验收Session完成；本机登录/配置来源与当前页面一致，原用户会话没有新Run。当前原对话页面已更新并留在Codex/gpt-6.1-sol；真实截图在忽略目录`.tmp/native-codex-model-picker.png`和`.tmp/native-openclaw-compatible-config-error.png`。

## 当前边界

真实原生云回复验收覆盖Codex；OpenCode覆盖目录及模型选择，OpenClaw系统安装覆盖协议握手，当前默认版本的真实连接因配置不兼容明确失败。没有把握手、模型枚举、exit code或目录中的43产品等同43个云执行组合通过。ACP未提供模型目录/接口的安装明确显示不可选择，不虚构模型；认证unknown不当作ready。

跨Harness连续性为公共历史重建，不能宣称转移原生checkpoint或正在运行的工具。Windows/Linux及所有账号、企业Provider/环境配置形式未逐项验收。凭据、配置正文、真实对话、备份、日志和截图不进入Git。

设计检查与交付：`python3 tools/check_design.py --write`、默认检查、`git diff --check`通过；26需求、81任务、324蓝图场景、8个accepted切片。完整未来门禁仍false；这些检查不执行Runtime测试。原HarnessHub已有未提交文档保持未动。
