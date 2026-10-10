# 本机目录 v2 与控制契约

日期：2026-10-09。状态：accepted，限 ADR-009 范围。

目录定义产品 id/name/aliases、本机 binaryNames、只读 configHints、可选 controls 和固定来源。control 独立 id/protocol/executableNames/args/env/package/distribution/requiredExecutables。程序名不是 shell 命令；包身份/固定分发元数据不证明安装。目录最多128产品/256控制入口，参数32项；外部描述最多256KiB，未知字段/协议/重复身份/非法路径拒绝。

v1 描述继续通过原解析器校验，再显式转换；v1 binary/adapter override 指向迁移后指定入口，不合并为隐式 shell。v2 overrides 按 controlId 指向绝对 executable；无效指定入口不回退。未提供路径时当前 PATH 默认入口优先；其已存在但损坏时保留 blocked，其他安装显示为候选而不自动替换。无 PATH 入口时可选指定/已知目录中的首个有效候选。

发现端口 enumerate(names,override?) 返回所有 canonical 去重安装、原始入口与来源、selected/defaultResolution/diagnostics；配置命中与安装分开。版本管理器扫描只遍历固定已知根和固定深度，每根32项，全局128目录；截断明确报告。已有 npm 包只读确认 package.json 身份/bin，不运行包管理器，bin不能越过包根；Python 入口依据指定的现有环境，不凭 uvx 存在推断目标包。

控制端口统一 initialize/open/startText/close；ControlRun.result 与 requestStop 分开。NativeConversationId 是独立品牌类型，只属于该连接。ACP初始化只声明空客户端能力；Codex read-only/untrusted/ephemeral。权限默认拒绝并输出事件；没有实现 fs/terminal 注入。不读/改用户全局配置；CLI通过受控私有配置运行真实探测。

上述空私有native默认已由ADR-015覆盖：所有接入程序使用本机既有配置和登录，配置只读，模型通过会话RPC参数覆盖。显式私有fixture/config-home仍保持所属来源；系统/代理/目录变量与所选Harness前缀及配置显式引用的凭据变量传入，其他宿主秘密不转发。Codex读取实际model/list/config/read/account/read，ACP读取实际模型配置项；可选models()是只读目录端口，open(cwd,nativeModel)验证并应用。没有声明的模型能力明确不支持，不猜接口。

ACP原 prompt.stopReason 和Codex匹配turn/completed是后端结果；spawn成功、exit0、interrupt ACK均不是执行终态。单连接只有一个active run；未知/wrong身份事件拒绝，不重跑。close必须可等待、幂等、限期升级停止、清理自有进程组；回调抛错也释放资源。帧2MiB、连接双向累计wire16MiB、诊断64KiB；请求、执行和关闭期限有界。

CleanupEvidence.closed 只表资源确认关闭，protocolFailure独立保留连接故障。收到completed后再遇重复终态不能把故障抹掉，CLI必须非零。清理结束前保留SIGINT/SIGTERM守护；未确认资源关闭时保留自有临时目录，不删除活跃路径。CLI不继承宿主秘密，描述中的HOME/XDG/CODEX_HOME等不能覆盖隔离配置。

测试分开：领域描述接受/拒绝；真实目录/包/链接；真实子进程和IPC，外部模型用确定性协议对端；编译后CLI；真实Harness的initialize与清理。真实prompt缺模型/认证时记未验证。公共Session、Provider热切换和任务正确性不由Driver证明。

ADR-016：原PATH/显式控制入口优先于旧受管副本；candidate/blocked不被覆盖，只有缺失控制可使用已安装私有入口。OpenClaw专属Driver处理其普通Gateway会话键扩展，ACP有界延迟验证session/new前的初始化元数据；错误身份/早到输出仍拒绝。
