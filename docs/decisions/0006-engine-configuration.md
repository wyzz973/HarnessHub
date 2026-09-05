# 0006：引擎独立配置、密钥引用与便携 Skills

状态：accepted。日期：2026-09-05。

## 问题

引擎发现和启动配方不能表达每个引擎独立的 Provider、API URL、Key、Skills 和 MCP；同名环境变量从 Gateway 继承时也不能给不同引擎赋不同值。直接改用户全局配置会影响终端中的原生会话，直接把密钥放进 Profile、argv 或 acpx sessionOptions 则可能被持久化。

## 决定

在 EngineRegistration / EngineProfile 上增加可选 `configuration`，与模型、启动命令共同形成不可变 revision。旧配置省略该字段时保持原行为和原 hash。EngineManager 在保存前校验配置与 SKILL.md 指纹；完整历史仍由 Gateway SQLite 拥有。引擎目录写 version 2，读取 version 1 并原样保留旧 revision；旧程序不接受 version 2，不做静默降级。

密钥采用 env、受限普通文件或 macOS Keychain 引用。控制台输入新 Key 时通过 write-only API 保存到 HarnessHub 专属 Keychain service，每次生成新 ID，值不出现在响应、配置、IPC 或 argv。env/file 引用在 Worker 启动时解析，内容可由外部管理；Keychain 引用不可变，替换密钥创建新引用，旧 revision 仍能使用旧引用。运行中的 Worker 保留已解析的值。Keychain helper 用 Swift/Security 实现，stdin 传参、pipe 返回值，禁止交互弹窗；不支持平台明确失败，可使用 env/file 引用。

每个 Worker 只归属一个 Session。组合根仅把该配置引用的源环境变量交给它；Worker 在自身进程内解析与注入目标环境变量，不修改 Gateway 或其他 Worker 的环境。Provider 转换在 Driver 配置模块中完成，Gateway 不根据引擎分支。自定义原生配置文件只写 Session 所属目录，API Key 使用环境引用。acpx 的 sessionOptions.env 会随 checkpoint 保存，因此绝不把密钥放进该字段。

Skills 使用显式的便携上下文模式：用户选择本地 SKILL.md，保存其 SHA-256；执行时验证指纹，将内容及附件基准目录加入任务文本。此模式不声称已经安装到各厂商的原生技能目录。主指令已固定，附件仍引用原目录，附件版本与原生插件管理不在本次能力内。指令源改变时明确失败，用户审阅后保存新 revision。

启用的 MCP 项经 ACP 的 mcpServers 下发，支持 stdio、HTTP、SSE，以及环境/请求头的秘密引用。每个 Worker 仅得到自己的服务器配置；MCP 工具本身的执行与权限属于引擎，不能把配置下发当作连接或调用成功。CLI 不具备统一 MCP 接口时拒绝注入，不偷偷忽略。

配置检查分静态配置/密钥/Skill 解析和 ACP initialize；不发送模型 prompt，不把握手成功当作认证或模型权限有效。检查进程拥有独立进程组、输出与时间上限，并等待清理；并发最多两次。真实模型/工具链另通过普通 Gateway Session / Run 验证。

## 替代方案与后果

直接写用户全局配置改动少，但会污染现有终端会话，因此采用进程级配置或私有配置文件。所有引擎统一假定 OpenAI API 不符合实际支持范围，因此通过适配能力表限制可配置的 Provider 协议；账号绑定引擎保留原生配置与显式环境引用。逐厂商安装和管理原生 Skills 会扩大本次范围，因此先交付有明确语义的便携上下文模式。

Keychain 比项目目录明文文件更适合控制台保存 Key，但 macOS 构建需要 Xcode Command Line Tools，其他平台不提供该保存后端。现有固定 Provider 的自定义 launcher 不能隐式套用新 Provider 配置；编辑器允许用户明确切换到发现器提供的标准模板。

## 验证

要求真 HTTP / SQLite / Worker 验证配置版本、不同引擎同名秘密变量的隔离、MCP 参数及秘密引用、Skill 启停与指纹变化、旧目录迁移与重启；真实 Keychain 创建/读取/删除测试项；浏览器编辑、检查与重载；真实 Harness 配合本地模拟模型与 MCP 服务验证原生配置实际生效。结果见 [本轮验收](../verification/2026-09-05-engine-configuration.md)。
