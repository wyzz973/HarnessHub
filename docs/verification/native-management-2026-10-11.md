# 本机安装管理与原生接入验收

日期：2026-10-11。本切片基线`e7cf8e9`，分支`codex/local-discovery`；决定为[ADR-017](../decisions/0017-native-installation-management.md)。实现位于独立HarnessGateway，HarnessHub既有未提交文档保持原样。平台为macOS27.0.1 arm64、Node25.9.0；不据此声明Linux或Windows通过。

## 实现与责任

生产安装沿本机原渠道与位置。npm读取原HOME及已有npm prefix配置，核实精确目标版本的元数据/bin，拒绝覆盖其他程序入口；uv读取原工具/入口目录；审核归档先在私有目录解包和验证，再发布用户程序入口。已有开发目录保留，不换成另一个安装。Pi管理以原生CLI作为默认对象，不提示为已可用原生入口安装多余ACP适配器。旧私有版本槽及任务只保留历史与显式测试模式。页面的版本列标明接入口版本，适配器版本不能冒充原CLI版本。

模型与登录由原Harness读取。Claude ACP绑定原Claude Code可执行文件，未设置CLAUDE_CONFIG_DIR时保持未设置；本机设置该变量会改变登录文件位置，因此不能强行补默认。Pi直接连接原CLI，读取本机模型，以启动参数选择模型，禁止调用会写全局默认的set_model；实际协议等待agent_settled，prompt受理、后端结果、静止与清理分开。当前生产Web的统一Provider导航后置，原生接入没有创建Hub Provider或替换原配置。

原生任务冻结渠道/原入口/版本/指纹并持久提交。跨CLI/Web的读租约保留到进程关闭，维护使用写租约；未核实资源或已派发未知结果保留同步落盘的标记。模型发现关闭失败同样保留资源归属。安装及安装后的版本验证都在本机配置写保护下执行，核对配置摘要；配置内容/认证值不进入公共DTO。显式核实只读当前程序，原任务仍标失败并记录实际版本，不重跑、不冒充完成。

管理库追加v1→v2表及冻结计划；旧任务保留，无效新表迁移回滚。当前原对话部署前已分别备份业务库和管理库到忽略的私有目录，迁移后原5个管理任务保留，业务会话格式仍为v4。

## 实际本机证据

| Harness | 原入口/版本 | 真实结果 |
|---|---|---|
| OpenClaw | `/opt/homebrew/bin/openclaw`，2026.3.23-2 | 原Gateway仍运行，原生DeepSeek配置；原对话中切出再切回并回复，正确引用最早的“你好” |
| Codex | Homebrew cask原安装，0.160.0 | 本机登录/gpt-6.1-sol正常回复；原对话连续切换后回复“你好”，进程清理确认 |
| OpenCode | Homebrew原安装，1.18.35 | 原配置真实回复“OpenCode 本机配置测试成功”；原接口模型目录可选 |
| Pi | `/opt/homebrew/bin/pi`链接用户开发目录，0.85.1 | 原生模型目录11项；原默认模型仍保留；明确选择已配置的`deepseek/deepseek-flash`后通过正式Runtime/SQLite及原对话真实回复，settings/models摘要不变 |
| Claude Code | 原npm CLI2.1.296；ACP接入口0.89.1 | ACP通过原npm位置的正式HTTP管理任务安装；原CLI版本保留。沿用本机Claude/Max登录，实际返回周额度用完并映射NATIVE_QUOTA_EXCEEDED；不能算生成回复通过 |
| Gemini CLI | 原Homebrew目录，实际0.62.0 | 原OAuth配置被服务端明确拒绝，提示客户端已不支持；NATIVE_CLIENT_UNSUPPORTED，不能算回复通过，未降级或改登录/模型 |
| Cursor | 原`~/.local/bin/cursor-agent`，2025.09.18-7ae6800 | 本机未登录，旧CLI的ACP接入未通过；不能算回复支持，未替换安装或假造DeepSeek兼容 |

Pi环境认证变量及配置显式引用按本机SDK规则沿用，私有fixture不继承宿主密钥。Pi本机源码HEAD为`da840b6216578c2a571d0374ac6a2091a83f9d91`；运行验收以原CLI0.85.1及实际RPC为准。Claude ACP源码核对固定`4e1fc1e8df2b9af3b1b2d6880ba90c5862283ba8`中的原CLI覆盖机制，未复制上游代码。Multica原生来源/模型机制沿用[此前固定调研](../research/multica-native-models.md)。

Codex原渠道升级到0.162.1的实际尝试失败：Homebrew解包的嵌套sandbox-exec返回Operation not permitted。没有绕过Homebrew保护或修改它的源码；通过正式HTTP核实后记录原版本0.160.0，清除待核实标记，未重跑安装。生产能力现明确阻止该Homebrew升级路径，版本检查与原CLI接入仍可用。第一次隔离验收脚本误清除了未知任务的临时数据库，已向用户说明；只恢复了外部保留回执/原安装核实证据，不声称丢失日志已恢复。后续未知验收保留数据库和日志，并通过正式HTTP核实。

Codex、OpenClaw、Gemini、OpenCode、Claude settings配置摘要均与本轮初始记录相同；没有修改模型配置。Claude正常CLI使用会更新自身运行记账，不能声称整个用户目录逐字节不变。DeepSeek凭据沿用本机已有效配置；未把用户提供的Key写入仓库或Hub Provider。

原公共对话ID保持不变，原4轮与历史失败保留，新增Pi→Codex→OpenClaw三轮均completed、cleanup.closed，切换后仍为open，无在途Run/切换。三个Harness均从完整公共历史正确引用最早的“你好”。这证明当前文本上下文接续及真实回复，未声明工具状态无损迁移或任务质量评估通过。

## 检查与局限

- `pnpm build`与`pnpm web:build`通过。
- `node --test dist/tests/*/*.test.js`：457通过、0失败、0跳过、0todo；没有把skip/todo算通过。Native集成保留真实SQLite、HTTP、进程、文件系统与macOS写保护，仅替换外部包管理器内容；覆盖精确目标版本、原prefix/uv目录、其他程序bin冲突、安装及版本检查写配置反例、共享维护锁、未知核实不重派发、旧库迁移与失败回滚。
- `node --test dist/tests/browser/web.browser.js`：浏览器4通过、0失败、0跳过：旧实验Provider管理回归、流式SSE/重连、失败切换保持同对话与草稿、原生模型直接选择/无Apply/320–943宽度重试按钮。生产原对话另作可见UI与实际数据核对。
- 真实Codex→Gemini→Codex的受控模型服务回归、真实Web SSE回归各1项通过。真实npm私有版本安装/升级回归1项通过，测试使用隔离HOME/PATH，不能把它称为本机系统升级；本机安装证据来自Claude ACP的原npm位置任务。
- `python3 tools/check_design.py --write`、`pnpm check:design`与`git diff --check`通过。蓝图场景仍为planned，数量不是运行结果；完整未来架构门禁仍关闭。

Homebrew升级、本机Cursor认证/旧协议、Gemini服务端停用、Claude额度是当前明确限制。OpenClaw旧版ACP未暴露运行时模型切换，当前沿用其本机默认DeepSeek；未伪造可选模型或改全局默认。未验收所有43个目录项、所有归档/Python真实安装与全平台；不为了扩大通过数量改变用户原安装/原配置。统一Provider管理后续另按Magpie链路实现。
