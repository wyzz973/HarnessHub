# ADR-011：手动 Provider 选择与本机图形工作台

状态：accepted（2026-10-09，用户要求 Provider 管理与图形界面优先，并选择 Claude 对话 + CC Switch 配置）。自动择优延后；只开放本切片，完整未来工程门禁保持关闭。

## 决定

Provider 是模型资源上下文中的独立聚合，Session 只保存 `providerId/revision/model` 引用。Provider 每次编辑产生不可变 revision，凭据对应不可变加密版本；已有 Run 的目标不能随编辑改变。当前 Provider 禁用后拒绝新的 dispatch，但不改写运行中的环境。删除以禁用表达，旧 revision 留作审计和历史解释。

Harness 与 Provider 两个选择使用现有静止切换链路。用户只换 Harness 时继承当前 Provider；显式 `provider:null` 解除受管 Provider。当前 Run 结束并确认资源关闭后验证目标、建立/关闭目标控制连接，再提交切换生效。失败保持原生效选择，等待该切换的新输入明确失败，不偷偷回退。

第一版受管组合是 Codex + OpenAI Responses、Gemini CLI + Gemini。协议名称相同不代表所有 Harness 兼容；其他产品仍可发现，受管配置能力明确不支持。每轮生成私有配置目录，密钥仅放子进程环境；不改用户全局配置。Gemini 使用私有最高优先级系统 settings，不设置语义不一致的 GEMINI_CLI_HOME。实际支持范围与真实验证分别记录。

凭据保存在本机私有目录，AES-GCM 加密；主密钥和密文文件为 0600、目录 0700。这个方案保护误提交、API/浏览器和普通配置泄漏，同一 OS 用户对主密钥和进程环境有访问权。当前不宣称 OS Keychain/DPAPI 隔离。API 不返回凭据或凭据引用；公开控制输出与错误清洗已知密钥。

Session 业务 SQLite 格式从 user_version 1 升到 2：在取得独占 owner 后单事务验证全部旧快照、升级 schemaVersion；消息、事件、命令指纹、身份、序号和业务 version 保留。失败整笔回滚，不清库；格式迁移不会产生一次业务切换。只读入口可以识别 1/2，不擅自迁移。新 Session 使用 schemaVersion 2。

图形工作台是同源本机 HTTP + React/Vite。服务只绑定 127.0.0.1；精确 Host/Origin、一次性 fragment token 换 HttpOnly/SameSite=Strict cookie，写请求需 JSON 与 CSRF。浏览器刷新通过 cookie 恢复，断开浏览器不取消执行。首版轮询持久快照/有界事件游标，不引入未验证的 SSE 重连抽象。请求大小、响应大小、并发、解析期限和关闭均有所有者。

## 分工与验收

主负责人独占 Session 契约/领域/迁移/Runtime/Binding/应用组合、根依赖、工程门禁与文档。Provider 负责人独占模型契约/资源服务/vault/配置 Adapter 与对应测试。HTTP 负责人独占 Web 契约/server/CLI 与 HTTP 测试。前端负责人独占 web 源码/布局/交互。

先完成纯规则、真实 SQLite/vault/迁移和 HTTP/IPC 集成测试，再运行真实 Codex 对两个本地确定性 Provider 的 A→B→A，核查请求 endpoint/model/key/history。浏览器实际验证新增/编辑/测试连接/禁用/选择/对话/切换/刷新/错误与桌面/移动布局。模型列表可达只称“模型列表可达”，不称模型调用成功。合成外部模型与真实云模型证据分开。

## 来源与限制

调研日期 2026-10-09。配置依据 [Codex 配置](https://learn.chatgpt.com/docs/config-file/config-advanced)、[Gemini CLI 配置](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)，结合已安装程序源代码；[OpenCode 配置](https://opencode.ai/docs/config)存在版本差异且本机启动未通过，暂不受管。交互参考 [CC Switch](https://github.com/farion1231/cc-switch) 与 [Claude 设置说明](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings)。使用自有品牌与组件，不宣称当前官方页面逐像素复刻。

真实双 Harness、真实云模型、其他宿主、自动路由、部署/发行与成本账本不由本次局部验收推断。
