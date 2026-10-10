# ADR-016：终端原安装优先与OpenClaw原生接入

状态：accepted，2026-10-11。用户明确以终端OpenClaw2026.3.23-2为本轮修复与DeepSeek验收对象，沿用本机配置/登录，不改全局配置；Provider统一管理仍属于整体链路的后续环节。

## 观察

终端入口为/opt/homebrew/bin/openclaw，原安装2026.3.23-2，原配置校验有效，现有Gateway健康且默认模型已经是deepseek/deepseek-chat。旧inventory用私有management默认覆盖PATH，导致网页选2026.9.9。原安装ACP在session/new响应前发送session_info_update与available_commands_update；旧Driver尚未绑定ID时拒绝这些合法初始化元数据，真实连接又失败。

## 决定

- 本机PATH/显式入口保持发现与执行权威，私有旧副本不能覆盖已发现的原安装，也不能替代损坏的显式/PATH入口。没有本机安装时才继续使用用户曾显式安装的本地副本。不能在启动失败后静默换版本。
- 页面版本/来源对应实际执行入口。版本探测使用原程序，只读运行--version；系统安装不能用“更新并管理”创建另一副本冒充本机升级。原生升级配方未完成验证时明确标出边界，不能写回私人默认掩盖实际版本。
- ACP在open期间仅有界缓存初始化元数据；响应确定原生SessionId后逐项核对身份并处理。早到文本/工具/权限、错误身份、超过128项均失败，不放宽执行输出的生命周期约束。OpenClaw专属Driver采用已安装桥接器支持的_meta.sessionKey，读取JSON5配置确定默认agent，使用完整agent:<id>:harnesshub:<uuid>普通会话键，避免acp命名空间及Gateway规范化导致的结束事件丢失；不以硬编码main替代实际配置。JSON5@2.2.3（MIT）为此有限配置读取的当前依赖。
- DeepSeek由OpenClaw原生配置和认证驱动，不经过HarnessHub Provider；先核实既有DeepSeek配置和认证能否使用。本机现有DeepSeek认证已成功，沿用它而不覆盖为新密钥。2026.3.23-2的ACP未声明模型选择接口，显示实际配置模型并跟随本机，不能虚构可选目录或修改全局默认。需要新的测试配置时，仅使用OpenClaw原生支持的独立profile，保留原全局配置与登录；不执行自动doctor修复或全局模型/认证替换。
- 其他接入沿用同一原安装优先规则。品牌图标使用已固定的本地SVG或已审阅官方来源；不能用另一个产品标志冒充未找到的品牌。

## 验收

真实协议子进程覆盖早到初始化元数据、错误身份与不合法输出；真实目录/HTTP验证原安装优先及版本来源一致。正式Gateway/Runtime和当前原对话需完成OpenClaw切换、原生模型选择与实际DeepSeek回复；全局配置hash、原消息/Run保留、独立关闭证据分别检查。安装管理与所有其他产品的真实升级不由此推断通过。
