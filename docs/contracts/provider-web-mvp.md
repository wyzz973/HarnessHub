# 本机 Provider 与图形工作台契约

状态：ADR-011 accepted。本切片在现有公共 Session 基础上实现独立模型目标和实际本机页面；自动择优后置。

当前用户链路由ADR-017限定为本机Harness原生配置。生产CLI Web设置providerManagement=false，Provider导航和新对话Provider选择后置；Web DTO返回该显式能力。旧资源/API及明确的旧Provider会话仍保留其选择，不静默替换。实验入口可显式启用Provider界面；以下独立模型链路属于该实验能力，不能作为当前原生接入的模型来源。

## 用户链路

用户在工作台新建对话，选择工作区与 Harness；选择一个 Provider 的具体 revision/model，提交消息。Session 准入输入，Run 固定完整选择，Binding 获取工作区租约并生成私有模型配置，Driver 驱动 Harness，Harness 访问用户指定的模型端点；结果/取消/清理分别持久化。浏览器显示这些实际事实。

改变 Harness 或 Provider/模型先提出切换请求；当前一轮及此前已准入消息收敛后，网关验证目标入口/配置后提交下一 epoch；普通选择不启动控制连接，认证与模型执行在发送时分别核实。界面区分已生效与等待切换。仅换 Harness 继承现有 Provider，无法兼容时拒绝；选择原生配置模式必须显式传 provider:null。失败切换后的排队输入不能改用旧目标。

ADR-015后，选择器变化即提出意图，不再另点Apply。快速选择时只提交最新尚未受理选择，已受理请求使用原幂等键确认后收敛；期间新消息禁止发给中间目标。界面保留最新用户选择，不被较早切换快照覆盖；失败不自动重试，用户可明确重试或继续原有效选择。

所有native入口沿用本机已安装Harness的配置目录、模型与登录，不创建空配置或写全局模型。选择nativeModel与managed provider互斥；native模型通过原生RPC传给新会话。`GET /api/v1/harnesses/:id/models?controlId=...&workspace=...&nativeModel=...&refresh=1`读取相同入口/配置的模型、默认和安全认证状态；Codex config/read/account/read/model/list，ACP声明的model配置项或明确的旧models接口。没有原生选择能力就明确说明由Harness管理，不伪造静态目录。后台最多8个读探测、同请求共享、20s期限，关闭取消并等待进程；认证缺失（含ACP的NATIVE_AUTH_REQUIRED）返回missing，异常不缓存空目录。成功非空结果按配置指纹与读取它的Hub构建缓存，最长24小时、最多32项，跨重启保存在数据根`native-catalogs.json`（ADR-033，格式v2），配置/入口身份变化、Hub换构建和refresh=1失效；选中模型专属档位通过nativeModel读取。Pi目录/档位来自原CLI/SDK，OpenClaw通过原CLI读取models.list并只patch本轮Hub会话的模型。

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

业务SQLite在独占owner内全事务执行既有user_version1→2→3及新增3→4→5→6→7→8→9迁移，保留全部命令、fingerprint、events、水位和业务version；坏数据整笔回滚。新Session必须v9，未知格式拒绝；只读Reader支持已知旧版本但不迁移。旧Session无法凭空获得模型目标，需要明确选择。旧程序不能读取v9；回退前停止服务并恢复升级前备份（含数据根下的`content`目录）。

## HTTP 与浏览器

服务只绑定127.0.0.1，同源静态页面与/api/v1。一次性启动链接fragment token不进入HTTP URL，兑换HttpOnly/SameSite=Strict cookie；写需要精确Origin与CSRF/JSON，精确Host防重绑定。刷新凭cookie重新取得内存CSRF；浏览器不保存Provider key。

Web DTO屏蔽commands/fingerprints与私有configuration引用，保留Run/switch/selection/messaging事实。认证失败不可继续；运行前需实际可用control；错误保留可读说明，未知/blocked不能自动恢复。关闭页面不会取消Run。JSON事件查询仍从已提交seq读取1..100个事件；正常对话通过下述事实流更新，失败不造成功状态。

### 实时对话事实流（ADR-013）

同源认证 `GET /api/v1/sessions/:id/events/stream` 接受 `afterSeq` 或 `Last-Event-ID`，同时提供时必须一致；负数、非规范整数和未来水位明确拒绝。每条SSE的事件名为 `session`，id等于已提交的lastSeq；首连和重连发送当前完整公共Session快照，独立文本提交发送完整canonical消息及version/lastSeq，状态变化发送快照。客户端按身份和水位替换事实，不重复追加文本；缺帧通过新快照补齐，不重新发送消息命令。

订阅先登记再读快照；默认同时最多8条流、每帧最多8MiB、15秒心跳、单连接最多60秒且不超过登录有效期。写背压只保留一个“需要最新快照”标记，drain后读持久事实；10秒仍未drain则关闭该订阅。HTTP关闭先关闭所有订阅，再等待执行与存储关闭。网络错误只影响订阅，权威读取错误保持原来的fail-closed责任并可在关闭时报告。

浏览器验证UTF-8/帧字节、JSON字段、消息归属和递增水位；按浏览器刷新周期合并显示，原始文本仍来自真实提交。异常连接最多连续尝试8次，退避有上限且可取消；认证失败停止，用户可显式重新连接。连接正常到期则重新读取快照。500ms完整Session轮询退出对话更新路径，目录和安装状态仍独立刷新。

消息区使用有界阅读宽度、流式Markdown和生成反馈；自动跟随最新回复，用户上滚后暂停跟随。复制取得原始Markdown，编辑只放回草稿；执行详情按需展开，正常结束不常驻每轮页脚。失败、停止和unknown保留已收到的内容。closed只读；blocked仍可写草稿、改选择、检查恢复或明确结束，普通发送等待恢复成功。输入框自动增长，选择器为紧凑chip，高级控制入口与固定Provider版本放入披露面板；IME、窄屏和reduced-motion分别验证。流式依据见[ADR-013](../decisions/0013-live-chat-experience.md)与[验收](../verification/live-chat-2026-10-10.md)，故障/恢复调整由下节和ADR-014拥有。

### 可恢复的对话交互（ADR-014）

`POST /api/v1/sessions/:id/resume` 接收selection/commandId及可选布尔acknowledgeUnknown，返回202/SwitchReceipt。新恢复命令在blocked状态检查持久关闭证据；未知结果需明确承认，无法确认资源或所有权故障返回409。验证目标和工作区租约后才生效；不发送prompt、不重跑Run、不清租约，普通switch命令不能冒充恢复。请求幂等，失败恢复仍可修改选择再试。

失败的目标切换保留原有效选择/epoch，立即显示可读原因及“继续使用当前选择”动作；失败等待输入不自动交给旧目标。正在切换时区分等待活动回复和保存选择。blocked的显式恢复仍验证连接和清理。失败/停止的回复可由用户明确重试为新Run，unknown不提供一键重跑；历史和部分内容保留。

草稿按当前标签页的工作区/对话保存在sessionStorage，含未确认命令身份，刷新/导航后恢复。不保存Provider表单/密钥，存储字段/字节严格校验；保存的committed标记不能代替服务端事实，写受理仍用canonical命令身份确认。浏览器不能保存时保留内存并提示，不清空用户内容。明确结束会话前显示原生焦点约束对话框，取消不发close；确认后保留历史并停止在途准入/执行。安装/入口发现与原生连接认证分开说明。实际审查与验收见[恢复记录](../verification/conversation-recovery-2026-10-10.md)。

HTTP body≤128KiB、response≤8MiB、资产≤4MiB、并发请求≤16、连接≤32；body10s和半包连接关闭均有界。进程关闭等待Run停止/资源清理、HTTP请求、Provider探测，再关闭业务Store。停止服务保留Session历史。

图形布局使用暖白对话正文、浅灰侧栏、铜色强调，Provider管理采用行列表和普通表单。支持键盘、IME、手机侧栏和无横向溢出，状态文字不依赖颜色。品牌为HarnessHub，工程工作目录仍为独立HarnessGateway。

### 原生设置与交互（ADR-019）

选择追加nativeOptions，仅接受有界原生枚举ID/值，不能与managed Provider并用。界面按原Harness实际模型显示思考档位，其他select设置放入高级配置，命令目录填入输入框；不能编造统一档位。切回Harness保留本对话最后的模型/选项，模型变化重新确认模型相关设置。

`POST /api/v1/sessions/:id/permissions/:permissionId`接受optionId、commandId和可选input，使用既有Origin/CSRF保护。只有当前Run实际待决的原生选项可回复；公开DTO包含待决requests，刷新/SSE恢复同一问题。用户决定先持久记录，命令重试不重复回传；无后端确认时明确backendAcknowledged=false。取消、结束和关闭释放问题。Pi confirm/select/input/editor在统一界面呈现；原生思考/工具活动来自实际事件。文本之外的输入、原生checkpoint和持久后台任务尚未完整验收。

ADR-020追加`POST /api/v1/sessions/:id/native-branch`，接受epoch/commandId；仅空闲及资源已核实的所选原生Harness允许重新建立。原生私有引用保留，公开历史不删除；接口不是原生fork。Web仅投影nativeStates的身份/status，checkpoint隐藏；ADR-028起另投影原生回报`observed`与下一回合将沿用的原生值`carried`。ADR-029追加`GET /api/v1/harnesses/:id/native-sessions?controlId=&workspace=&cursor=`（本工作区的本机会话，已被对话持有的带`conversationId`；不支持时`sessions:null`）与`POST /api/v1/sessions/import {workspace?, selection, nativeId, commandId}`（命令幂等；同一原生会话已被持有409，不在本工作区列表404）；会话视图`origin`可为`kind:"import"`。恢复后的历史回放不创造公共回复，thread级用量元数据不绑定当前Turn。Codex原生问答和密码输入通过既有交互往返，回答正文不写权限事件。

ADR-022追加`GET/HEAD /api/v1/content/:id`（`download=1`可选）：需要登录，跨站请求拒绝；只有png/jpeg/gif/webp图片与JSON/纯文本内联，其余强制下载，响应带`Content-Security-Policy: sandbox`与`nosniff`，未知内容404，文件与记录不一致409。工具详情按需读取。SSE新增`run`帧，携带version/lastSeq与活动Run的完整公开事实，用于工具、计划、用量、提示、活动、产物的增量更新；客户端只接受仍在执行的活动Run，身份、输入、选择、epoch与状态不得改变，不符或缺帧时改取完整快照。

ADR-026追加`GET /api/v1/harnesses/:id/extensions?controlId=&workspace=`：按需用短期原生探针读取技能、MCP服务器与插件（每类≤512，标记截断），不缓存；接口没有列表时返回`{extensions:null}`。Codex启用的技能进入命令目录（`skill:名称`）并以原生skill输入调用。

ADR-033追加只读`GET /api/v1/harnesses/readiness`，返回`{readiness}`；`/api/v1/state`同带`readiness`。每项为一个入口最近一次目录读取的结果（`ready`附`signedIn`、`signed_out`、`failed`附稳定`failureCode`），只有回合记录时为`unchecked`；`startupMs`是该入口最近5个带计时回合的启动中位数。读取它不启动任何Harness。`GET /api/v1/harnesses/:id/native-sessions`默认不列出Hub目录读取建出的原生会话（已被对话持有的除外），有隐藏时返回`hiddenProbes`；`probes=include`列出全部。

ADR-030（2026-10-12，Session v11）追加：`POST /api/v1/sessions/:id/retention`（`{enabled, commandId}`，幂等）开启或关闭“保持原生进程”，关闭会结束已保留的进程；`POST /api/v1/sessions/:id/end-process`（`{commandId}`）以正常停止链结束保留的进程，记录关闭后才返回；`GET /api/v1/kept-processes`列出保留进程的对话与工作区。会话视图带`retention: {enabled, process}`，`process`含开始保留时间、最后回合、空闲截止时间与回合外更新条数（只计数）。Run可带`retained`（进程交给对话，`cleanup`为空）与`reused`（复用了保留进程）。另一对话的工作区被保留进程占用时，回合以`WORKSPACE_KEPT`失败且未发出任何内容。

ADR-030 服务异常退出后的清理（2026-10-12，Session v12）：保留记录带进程组身份`retained.process: {group, startedAt}`（v11→v12 只升版本号）。服务启动时先接管上一服务保留的进程组，结果记为对话事件`native.process_lost`（`outcome`为`terminated`、`gone`或`unconfirmed`，`leaseReleased`表示是否释放了工作区租约）；会话视图在本次服务运行期间、该对话下一条消息之前带`retention.lost: {outcome, leaseReleased, at}`。`unconfirmed`时工作区保持隔离。

ADR-035（2026-10-12）追加：待决的审批与提问带`requestedAt`、`expiresAt`、`expiresBy`（`native`为原程序自己的期限，`turn`为本回合期限，取较早者）和`kind`（提问为`question`）。`GET /api/v1/attention`返回`{revision, items}`：所有尚未决定的请求（对话、请求、回合、Harness、类型、期限，不含标题与详情），最多32项，只含当前服务内存中的请求。会话事件流在会话事实之外携带`event: attention`帧（不带事件编号，不移动游标）；没有打开对话的页面订阅`GET /api/v1/attention/stream`（`id`为修订号，与会话流相同的连接上限、心跳与TTL）。回合期限到期时仍在等待的请求记为`permission.closed`且`reason: "expired"`，回合以`RUN_TIMEOUT`结束、结果未知。

ADR-036（2026-10-12）追加：每个回合有执行预算（默认300秒，从派发起算，等待用户时暂停）和等待预算（默认30分钟、上限2小时，覆盖等待用户决定与排队等待工作区），由`web`命令的`--execution-budget <秒>`（30至3600）和`--wait-budget <分钟>`（1至120）设定，无效值启动失败。待决请求的`expiresBy: "turn"`表示等待预算。执行预算到期以`RUN_TIMEOUT`、等待预算到期以`WAIT_EXPIRED`停止：仍在等待的请求记为`permission.closed`且`reason: "expired"`，回合事件`run.budget_expired`带`kind`与`budgetMs`，宽限内结算的回合为`cancelled`，否则为`unknown`。回合等待时记`run.waiting`（`kind`为`user`或`workspace`；后者带`holderSessionId`），等待结束记`run.waiting_ended`（带`waitedMs`）。最多4个对话同时执行，服务启动时在日志中写出上限与两个预算；同一工作区由另一个对话正在执行的回合持有时，回合保持`queued`排队，会话视图带`queue: {kind: "workspace", runId, holderSessionId, holderWaitsForUser, since, endsAt}`；所有位置已满时，回合等待空位，`queue`为`{kind: "slot", runId, running, limit, since}`，记`run.waiting`（`kind: "slot"`），没有单独的期限；排队超过等待预算时回合以`WORKSPACE_BUSY`失败（从未派发，`run.ended`带`neverDispatched`与`holderSessionId`），会话视图的`busyHolders`按回合给出持有对话（当前服务内存中最多256条）。排队中的回合用`POST /api/v1/sessions/:id/cancel`的`runId`取消。已取消的回合在界面和Markdown导出中按`error.code`说明原因（执行预算用尽、等待你的决定超时、服务重启时没有发出、用户停止）。业务格式不变。

ADR-037（2026-10-12）追加：`GET /api/v1/sessions/:id/runs/:runId/diagnostics?content=0|1`返回`{text, includesContent}`：本轮的诊断纯文本（不超过64 KiB），服务端在请求时拼装、不保存；首行说明是否含对话内容，默认不含，`content=1`时只加入该轮提示词与回复。来自原程序的文字先经Provider脱敏器，再隐去密钥样式字符串、环境变量值、路径与本机账户名。stderr只取本轮最后4 KiB，只在当前服务内存中保留最近64轮。参数无效400，回合不存在404。

ADR-038（2026-10-12）追加：Harness 的管理视图在产品版本已知、且这个 Harness 有真实验证记录时带`verification: {state: "verified"|"unverified", program, adapter?}`，`program`与`adapter`为验证过的版本（单个版本或“起–止”）。这只是提示，不影响选择、发送、安装或升级。

ADR-039（2026-10-12）追加：`GET /api/v1/sessions/:id/native-resume`返回当前选择的已就绪原生会话`{resume: {harnessId, nativeId?, interactive?, once?, list?, note?} | null}`：`nativeId`只在是普通标识符时给出；`interactive`与`once`只给验证过的产品，并且已安装版本须在验证范围内（ADR-038）；`note`为`version-unverified`或`not-verified`；`list`用于会话标识是私有路径的程序。按需读取，不进入会话视图和导出；需要登录，查询参数无效时返回400。
