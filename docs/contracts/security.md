# 身份、秘密、权限与环境边界

状态：proposed。本机应用仍需认证与 scope；回环地址、CORS 或 Host 校验不能代替调用方身份。

## 管理与执行

可信 operator 管注册/配置/秘密，caller 管所属 Session 与控制。当前可同一用户持有两种权限，但 API 必须显式校验范围，未来多用户不能依靠全局 token 自动获得所有 Session。

本机令牌文件私有权限；浏览器采用一次性登录交换与源绑定的会话凭据，写请求 CSRF 防护；Host、Origin、Sec-Fetch、DNS rebinding、路径规范化、HTTP method/content-type 与大小限制共同检查。浏览器不保存总管理秘密。

## 秘密与进程

配置仅存 SecretRef，解析由所属边界短暂完成。Provider 凭据不直接交给 Harness；受管理执行拿 scoped 模型访问身份。工具秘密分别授权，不复用网关管理令牌。

私有 HOME/配置/temp、显式 env 白名单、argv 不含秘密、不改用户原配置、不动态联网安装。秘密存储不构成同用户 OS 隔离；DPAPI/Keychain、文件权限和备份各有平台验证责任。

## 工具、内容与权限

文件、工具结果、远端消息和摘要中的指令视为不可信数据；它们不能更改路由、身份或权限策略。permission 带 Attempt/epoch/generation、toolCallId、真实 options、有效期、已决定与 applied 状态。未知、重复冲突、过期和旧代次响应拒绝。

策略要求审批而 Harness 没有可靠覆盖时，排除该候选；不使用 Full Access 掩盖缺能力。OS sandbox、权限回调、进程监督、网络出口和目录写权分别声明。

## 关键威胁与测试归属

跨 Session 越权；用户网页借用本机凭据；恶意 Adapter/配置命令；stdout 控制消息污染；提示注入改变 Harness；远端 URL 的 SSRF/代理绕过；符号链接/路径越界/Windows 设备名；秘密进入上下文与日志；旧权限重放；Worker 迟到控制；伪造恢复材料；资源耗尽；后台进程继续写工作区。

对应场景在结构化测试矩阵中逐项记录。日志默认不记录原始提示与工具正文，必要诊断必须显式开启、脱敏、有期限和导出审查。
