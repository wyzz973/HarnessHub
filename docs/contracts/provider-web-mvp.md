# 本机 Provider 与图形工作台契约

状态：ADR-011 accepted。本切片在现有公共 Session 基础上实现独立模型目标和实际本机页面；自动择优后置。

## 用户链路

用户在工作台新建对话，选择工作区与 Harness；选择一个 Provider 的具体 revision/model，提交消息。Session 准入输入，Run 固定完整选择，Binding 获取工作区租约并生成私有模型配置，Driver 驱动 Harness，Harness 访问用户指定的模型端点；结果/取消/清理分别持久化。浏览器显示这些实际事实。

改变 Harness 或 Provider/模型先提出切换请求；当前一轮及此前已准入消息收敛后，网关验证目标、初始化并关闭控制连接，才提交下一 epoch。界面区分已生效与等待切换。仅换 Harness 继承现有 Provider，无法兼容时拒绝；选择原生配置模式必须显式传 provider:null。失败切换后的排队输入不能改用旧目标。

Provider 保存名称、协议、Base URL、模型列表、默认模型、启用状态和 hasCredential。新增/编辑都使用命令幂等键；更新要求 expectedRevision。空白密钥字段在前端转换为省略，保留旧密钥；显式空字符串无效。当前不做删除/复用身份，停用后保留全部历史 revision；已准入 Run 保留旧配置，新的准备过程拒绝停用目标。编辑不自动改变当前 Session 的固定 revision，用户需显式应用新版本。

## 兼容矩阵

| Harness/control | Provider 协议 | 当前受管配置 |
|---|---|---|
| Codex / codex-app-server | openai-responses | 私有 CODEX_HOME/config.toml，显式模型与 Base URL；key 仅环境；支持无认证本地端点 |
| Gemini CLI / acp-v1 | gemini | 私有最高优先级 system settings、Gemini Base URL/model/API-key 环境；要求 key |
| 其他控制入口 | 任意 | 明确不支持；安装发现不等于受管模型配置能力 |

管理界面可保存 openai-chat-completions、anthropic-messages 的连接信息与探测模型目录，但当前 Harness 组合禁用选择。协议和 adapter 能力是两个独立事实。受管配置与显式 configHome 互斥，不合并用户配置；原有私有配置根方式仍按原契约使用。

“测试连接”只读取模型目录，不运行生成、不说明模型质量或任务完成。OpenAI/Anthropic Base URL 通常包含 /v1，probe 接 /models；Gemini Base URL 为 API 服务根，probe 接 /v1beta/models。返回的目录不会自动改写不可变模型资源。HTTP/HTTPS均由用户显式指定，URL禁止嵌入认证、query或fragment，不偷偷替换协议/端点。远程HTTP的传输由用户所填端点决定。

## 本机存储、秘密与迁移

公共 Session v2 只记录 {providerId,revision,model}，没有 key/ref/配置内容。Provider SQLite 中的凭据使用 AES-256-GCM，revision 与身份绑定为 AAD，命令指纹用私有主密钥 HMAC；metadata/key/revision/command同事务提交。master与数据库0600、目录0700、链接/身份/大小/损坏显式失败。密钥可被同一OS用户读取，此版本不宣称系统钥匙串隔离。

已知密钥在公开 control metadata、事件、诊断、错误与结算中清洗；文本跨delta分片使用前缀缓冲，不能通过分片逃逸。模型探测禁止redirect，响应≤1MiB，期限5s，同时≤16；shutdown停止准入、取消并等待所有探测，才释放vault/database。

业务SQLite user_version1→2在独占owner内全事务升级经验证的旧快照schemaVersion，保留全部命令、fingerprint、events、水位和业务version；坏数据整笔回滚。新Session必须v2，未知格式拒绝；只读Reader不迁移。旧Session无法凭空获得模型目标，需要显式切换。

## HTTP 与浏览器

服务只绑定127.0.0.1，同源静态页面与/api/v1。一次性启动链接fragment token不进入HTTP URL，兑换HttpOnly/SameSite=Strict cookie；写需要精确Origin与CSRF/JSON，精确Host防重绑定。刷新凭cookie重新取得内存CSRF；浏览器不保存Provider key。

Web DTO屏蔽commands/fingerprints与私有configuration引用，保留Run/switch/selection/messaging事实。认证失败不可继续；运行前需实际可用control；错误保留可读说明，未知/blocked不能自动恢复。关闭页面不会取消Run。游标轮询从已提交seq读取1..100个事件，或者前端有界轮询实际Session；失败不造成功状态。

HTTP body≤128KiB、response≤8MiB、资产≤4MiB、并发请求≤16、连接≤32；body10s和半包连接关闭均有界。进程关闭等待Run停止/资源清理、HTTP请求、Provider探测，再关闭业务Store。停止服务保留Session历史。

图形布局使用暖白对话正文、浅灰侧栏、铜色强调，Provider管理采用行列表和普通表单。支持键盘、IME、手机侧栏和无横向溢出，状态文字不依赖颜色。品牌为HarnessHub，工程工作目录仍为独立HarnessGateway。
