# ADR-018：原生CLI认证与Homebrew单沙箱恢复

状态：accepted，2026-10-11。用户要求继续解决Gemini个人登录停用、Cursor登录/旧CLI及Homebrew维护冲突；Gemini优先核实能否直接使用DeepSeek Key。既有本机配置、安装渠道和登录保持所属原程序，统一Provider后置。

- Homebrew恢复通过原`brew ruby`及已安装Sandbox.capture API运行；Homebrew自己传递继承描述符并验证brew文件不能写。将原Homebrew写入范围、仓库保护及用户模型/认证/shell配置拒绝放在同一个沙箱中，不伪造继承、不关闭保护、不修改Homebrew源码。没有对应SDK能力时继续明确拒绝。SDK文件指纹纳入计划；支持判定及配置写入反例通过后才开放实际升级。
- 使用非PTY capture，子进程保持在正式管理进程组内；沿用已有持久任务、维护锁、派发前提交、未知核实与清理。临时developer环境避免`brew ruby`修改用户全局developer偏好。实际版本与配置摘要分别核实。
- Cursor沿用原官方更新器和安装位置，原模型/认证目录写保护；更新后使用原CLI的ACP和原登录，不复制桌面应用凭据或注入另一个账号。
- Gemini仍保留原程序。DeepSeek兼容性以原CLI实际请求及原SDK协议验证；不能把接口地址/Key替换当协议转换成功，也不在HarnessGateway暗中添加模型代理或换成未审核fork。

验收：正式管理HTTP/SQLite/原进程，本机Homebrew继承及拒绝写入配置、真实原渠道升级；Cursor原版本更新/认证/原生模型/真实回复；Gemini原生DeepSeek调用与配置不变证据。平台与外部账号限制分别记录，未通过不宣称完成。
