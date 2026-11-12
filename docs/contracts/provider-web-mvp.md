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

Web DTO屏蔽commands/fingerprints与私有configuration引用，保留Run/switch/selection/messaging事实。认证失败不可继续；运行前需实际可用control；错误保留可读说明，未知/blocked不能自动恢复。Session、Provider、管理与能力错误的公开`message`（4xx/5xx）把家目录的绝对路径——隐私检查认得的每种写法（给定的与解析后的）——写成`~`（ADR-044），再截到 512 个字符：先替换再截断，跨过截断点的家目录不会留下半截（ADR-050）。HTTP 层自己的说明不变。关闭页面不会取消Run。JSON事件查询仍从已提交seq读取1..100个事件；正常对话通过下述事实流更新，失败不造成功状态。

### 实时对话事实流（ADR-013）

同源认证 `GET /api/v1/sessions/:id/events/stream` 接受 `afterSeq` 或 `Last-Event-ID`，同时提供时必须一致；负数、非规范整数和未来水位明确拒绝。每条SSE的事件名为 `session`，id等于已提交的lastSeq；首连和重连发送当前完整公共Session快照，独立文本提交发送完整canonical消息及version/lastSeq，状态变化发送快照。客户端按身份和水位替换事实，不重复追加文本；缺帧通过新快照补齐，不重新发送消息命令。

订阅先登记再读快照；默认同时最多8条流、每帧最多8MiB、15秒心跳、单连接最多60秒且不超过登录有效期。写背压只保留一个“需要最新快照”标记，drain后读持久事实；10秒仍未drain则关闭该订阅。HTTP关闭先关闭所有订阅，再等待执行与存储关闭。网络错误只影响订阅，权威读取错误保持原来的fail-closed责任并可在关闭时报告。

浏览器验证UTF-8/帧字节、JSON字段、消息归属和递增水位；按浏览器刷新周期合并显示，原始文本仍来自真实提交。异常连接最多连续尝试8次，退避有上限且可取消；认证失败停止，用户可显式重新连接。连接正常到期则重新读取快照。500ms完整Session轮询退出对话更新路径；本机 Harness 的目录与安装状态按需刷新，不定时轮询（ADR-050，见文末）。

消息区使用有界阅读宽度、流式Markdown和生成反馈；自动跟随最新回复，用户上滚后暂停跟随。复制取得原始Markdown，编辑只放回草稿；执行详情按需展开，正常结束不常驻每轮页脚。失败、停止和unknown保留已收到的内容。closed只读；blocked仍可写草稿、改选择、检查恢复或明确结束，普通发送等待恢复成功。输入框自动增长，选择器为紧凑chip，高级控制入口与固定Provider版本放入披露面板；IME、窄屏和reduced-motion分别验证。流式依据见[ADR-013](../decisions/0013-live-chat-experience.md)与[验收](../verification/live-chat-2026-10-10.md)，故障/恢复调整由下节和ADR-014拥有。

### 可恢复的对话交互（ADR-014）

`POST /api/v1/sessions/:id/resume` 接收selection/commandId及可选布尔acknowledgeUnknown，返回202/SwitchReceipt。新恢复命令在blocked状态检查持久关闭证据；未知结果需明确承认，无法确认资源或所有权故障返回409。验证目标和工作区租约后才生效；不发送prompt、不重跑Run、不清租约，普通switch命令不能冒充恢复。请求幂等，失败恢复仍可修改选择再试。

失败的目标切换保留原有效选择/epoch，立即显示可读原因及“继续使用当前选择”动作；失败等待输入不自动交给旧目标。正在切换时区分等待活动回复和保存选择。blocked的显式恢复仍验证连接和清理。失败/停止的回复可由用户明确重试为新Run，unknown不提供一键重跑；历史和部分内容保留。

草稿按当前标签页的工作区/对话保存在sessionStorage，含未确认命令身份，刷新/导航后恢复。不保存Provider表单/密钥，存储字段/字节严格校验；保存的committed标记不能代替服务端事实，写受理仍用canonical命令身份确认。浏览器不能保存时保留内存并提示，不清空用户内容。明确结束会话前显示原生焦点约束对话框，取消不发close；确认后保留历史并停止在途准入/执行。安装/入口发现与原生连接认证分开说明。实际审查与验收见[恢复记录](../verification/conversation-recovery-2026-10-10.md)。

HTTP body≤128KiB（回答审批提问的那条路由≤16MiB）、response≤8MiB、资产≤4MiB、并发请求≤256、连接≤1024（2026-11-12 由 16 与 32 放开）；请求头10s，请求体只在连续10s没有字节、半包连接15s没有任何字节时才被放弃（花多久都不限，静默才算）。登录有活动就续期：每个请求把登录的结束推到 8 小时之后，cookie 的 Max-Age 随之重发，沉默 8 小时才失效。进程关闭等待Run停止/资源清理、HTTP请求、Provider探测，再关闭业务Store。停止服务保留Session历史。

图形布局使用暖白对话正文、浅灰侧栏、铜色强调，Provider管理采用行列表和普通表单。支持键盘、IME、手机侧栏和无横向溢出，状态文字不依赖颜色。品牌为HarnessHub，工程工作目录仍为独立HarnessGateway。

### 原生设置与交互（ADR-019）

选择追加nativeOptions，仅接受有界原生枚举ID/值，不能与managed Provider并用。界面按原Harness实际模型显示思考档位，其他select设置放入高级配置，命令目录填入输入框；不能编造统一档位。切回Harness保留本对话最后的模型/选项，模型变化重新确认模型相关设置。

`POST /api/v1/sessions/:id/permissions/:permissionId`接受optionId、commandId和可选input，使用既有Origin/CSRF保护。只有当前Run实际待决的原生选项可回复；公开DTO包含待决requests，刷新/SSE恢复同一问题。用户决定先持久记录，命令重试不重复回传；无后端确认时明确backendAcknowledged=false。取消、结束和关闭释放问题。Pi confirm/select/input/editor在统一界面呈现；原生思考/工具活动来自实际事件。文本之外的输入、原生checkpoint和持久后台任务尚未完整验收。

ADR-020追加`POST /api/v1/sessions/:id/native-branch`，接受epoch/commandId；仅空闲及资源已核实的所选原生Harness允许重新建立。原生私有引用保留，公开历史不删除；接口不是原生fork。Web仅投影nativeStates的身份/status，checkpoint隐藏；ADR-028起另投影原生回报`observed`与下一回合将沿用的原生值`carried`。ADR-029追加`GET /api/v1/harnesses/:id/native-sessions?controlId=&workspace=&cursor=`（本工作区的本机会话，已被对话持有的带`conversationId`；不支持时`sessions:null`）与`POST /api/v1/sessions/import {workspace?, selection, nativeId, commandId}`（命令幂等；同一原生会话已被持有409，不在本工作区列表404）；会话视图`origin`可为`kind:"import"`。恢复后的历史回放不创造公共回复，thread级用量元数据不绑定当前Turn。Codex原生问答和密码输入通过既有交互往返，回答正文不写权限事件。

ADR-022追加`GET/HEAD /api/v1/content/:id`（`download=1`可选）：需要登录，跨站请求拒绝；只有png/jpeg/gif/webp图片与JSON/纯文本内联，其余强制下载，响应带`Content-Security-Policy: sandbox`与`nosniff`，未知内容404，文件与记录不一致409。工具详情按需读取。SSE新增`run`帧，携带version/lastSeq与活动Run的完整公开事实，用于工具、计划、用量、提示、活动、产物的增量更新；客户端只接受仍在执行的活动Run，身份、输入、选择、epoch与状态不得改变，不符或缺帧时改取完整快照。

ADR-026追加`GET /api/v1/harnesses/:id/extensions?controlId=&workspace=`：按需用短期原生探针读取技能、MCP服务器与插件（每类≤512，标记截断），不缓存；接口没有列表时返回`{extensions:null}`。Codex启用的技能进入命令目录（`skill:名称`）并以原生skill输入调用。

ADR-033追加只读`GET /api/v1/harnesses/readiness`，返回`{readiness}`；`/api/v1/state`同带`readiness`。每项为一个入口最近一次目录读取的结果（`ready`附`signedIn`、`signed_out`、`failed`附稳定`failureCode`），只有回合记录时为`unchecked`；`startupMs`是该入口最近5个带计时回合的启动中位数。读取它不启动任何Harness。`GET /api/v1/harnesses/:id/native-sessions`默认不列出Hub目录读取建出的原生会话（已被对话持有的除外），有隐藏时返回`hiddenProbes`；`probes=include`列出全部。

ADR-030（2026-10-12，Session v11）追加：`POST /api/v1/sessions/:id/retention`（`{enabled, commandId}`，幂等）开启或关闭“保持原生进程”，关闭会结束已保留的进程；`POST /api/v1/sessions/:id/end-process`（`{commandId}`）以正常停止链结束保留的进程，记录关闭后才返回；`GET /api/v1/kept-processes`列出保留进程的对话与工作区。会话视图带`retention: {enabled, process}`，`process`含开始保留时间、最后回合、空闲截止时间与回合外更新条数（只计数）。Run可带`retained`（进程交给对话，`cleanup`为空）与`reused`（复用了保留进程）。另一对话的工作区被保留进程占用时，回合以`WORKSPACE_KEPT`失败且未发出任何内容。

ADR-030 服务异常退出后的清理（2026-10-12，Session v12）：保留记录带进程组身份`retained.process: {group, startedAt}`（v11→v12 只升版本号）。服务启动时先接管上一服务保留的进程组，结果记为对话事件`native.process_lost`（`outcome`为`terminated`、`gone`或`unconfirmed`，`leaseReleased`表示是否释放了工作区租约）；会话视图在本次服务运行期间、该对话下一条消息之前带`retention.lost: {outcome, leaseReleased, at}`。`unconfirmed`时工作区保持隔离。关闭或接管保留进程时，`native.process_closed`与`native.process_lost`带`outside`：发信号前枚举到的、离开该进程组的后代数量、组结束后仍在运行的数量与命令基名（`{state: "enumerated", found, remaining, commands}`），或无法枚举（`{state: "unknown"}`）；Hub 不向它们发信号。仍在运行时，会话视图在下一条消息之前带`retention.outside: {count, at}`。

ADR-035（2026-10-12）追加：待决的审批与提问带`requestedAt`、`expiresAt`、`expiresBy`（`native`为原程序自己的期限，`turn`为本回合期限，取较早者）和`kind`（提问为`question`）。`GET /api/v1/attention`返回`{revision, items}`：所有尚未决定的请求（对话、请求、回合、Harness、类型、期限，不含标题与详情），最多32项，只含当前服务内存中的请求。会话事件流在会话事实之外携带`event: attention`帧（不带事件编号，不移动游标）；没有打开对话的页面订阅`GET /api/v1/attention/stream`（`id`为修订号，与会话流相同的连接上限、心跳与TTL）。回合期限到期时仍在等待的请求记为`permission.closed`且`reason: "expired"`，回合以`RUN_TIMEOUT`结束、结果未知。

> 2026-11-12 起，下面这一段（ADR-036 追加）里的默认预算、上限、最多 4 个对话、同一工作区排队、`queue.kind: "workspace"`、`busyHolders` 与 `WORKSPACE_BUSY`（对话之间）已由[决定记录](../decisions/LOG.md)取代：回合没有时间墙，`--execution-budget`（至少 30 秒）、`--wait-budget`（至少 1 分钟）只是可选的自动停止，`--max-parallel` 可选地限制同时运行的对话数（`queue` 只剩 `slot`），同一目录的对话都运行，后到的一轮带一条通知并有事件 `run.workspace_shared`；回合干活到一定时长时有事件 `run.still_working`；`run.waiting` 的 `kind` 只有 `user` 与 `slot`。

ADR-036（2026-10-12）追加：每个回合有执行预算（默认300秒，从派发起算，等待用户时暂停）和等待预算（默认30分钟、上限2小时，覆盖等待用户决定与排队等待工作区），由`web`命令的`--execution-budget <秒>`（30至3600）和`--wait-budget <分钟>`（1至120）设定，无效值启动失败。待决请求的`expiresBy: "turn"`表示等待预算。执行预算到期以`RUN_TIMEOUT`、等待预算到期以`WAIT_EXPIRED`停止：仍在等待的请求记为`permission.closed`且`reason: "expired"`，回合事件`run.budget_expired`带`kind`与`budgetMs`，宽限内结算的回合为`cancelled`，否则为`unknown`。回合等待时记`run.waiting`（`kind`为`user`或`workspace`；后者带`holderSessionId`），等待结束记`run.waiting_ended`（带`waitedMs`）。最多4个对话同时执行，服务启动时在日志中写出上限与两个预算；同一工作区由另一个对话正在执行的回合持有时，回合保持`queued`排队，会话视图带`queue: {kind: "workspace", runId, holderSessionId, holderWaitsForUser, since, endsAt}`；所有位置已满时，回合等待空位，`queue`为`{kind: "slot", runId, running, limit, since}`，记`run.waiting`（`kind: "slot"`），没有单独的期限；排队超过等待预算时回合以`WORKSPACE_BUSY`失败（从未派发，`run.ended`带`neverDispatched`与`holderSessionId`），会话视图的`busyHolders`按回合给出持有对话（当前服务内存中最多256条）。排队中的回合用`POST /api/v1/sessions/:id/cancel`的`runId`取消。已取消的回合在界面和Markdown导出中按`error.code`说明原因（执行预算用尽、等待你的决定超时、服务重启时没有发出、用户停止）。业务格式不变。

ADR-037（2026-10-12）追加：`GET /api/v1/sessions/:id/runs/:runId/diagnostics?content=0|1`返回`{text, includesContent}`：本轮的诊断纯文本（不超过64 KiB），服务端在请求时拼装、不保存；首行说明是否含对话内容，默认不含，`content=1`时只加入该轮提示词与回复。来自原程序的文字先经Provider脱敏器，再隐去密钥样式字符串、环境变量值、路径与本机账户名。stderr只取本轮最后4 KiB，只在当前服务内存中保留最近64轮。参数无效400，回合不存在404。

ADR-038（2026-10-12）追加的管理视图字段`verification: {state, program, adapter?}`（已验证判定）2026-10-22 起按 ADR-053 删除（第三批 D1）：管理视图照常给出每份安装的版本号与渠道最新版本，不再带任何按版本号推断的判定；页面解码器在同一提交去掉这个字段（ADR-053 裁决 2）。

ADR-039（2026-10-12）追加：`GET /api/v1/sessions/:id/native-resume`返回当前选择的已就绪原生会话`{resume: {harnessId, nativeId?, interactive?, once?, onceNote?, list?, note?} | null}`：`nativeId`只在是普通标识符时给出；`interactive`与`once`按产品给出，与安装版本无关（ADR-053，2026-10-22；原“只给验证过的产品，并且已安装版本须在验证范围内”作废），DeepSeek Harness 只有`once`并带`onceNote`（凭据前提）；没有续接命令的产品（Cursor、Gemini CLI）只给`nativeId`，`note`为`no-command`（原`not-verified`改名，原`version-unverified`删除）；`list`用于会话标识是私有路径的程序。按需读取，读取不触发本机发现与版本探测，不进入会话视图和导出；需要登录，查询参数无效时返回400。

ADR-040（2026-10-12）追加：`GET /api/v1/discovery/login-shell`返回`{available, shell?, dirs, readAt}`；`POST /api/v1/discovery/login-shell`（`{commandId}`）以`$SHELL -l -c`读取一次登录 shell 的 PATH（须列在`/etc/shells`，3 秒、64 KiB），只保存这个 Gateway 尚未搜索的目录并重新检测；`POST /api/v1/discovery/login-shell/remove`（`{dir, commandId}`）移除一个目录。不提供时为409 `LOGIN_SHELL_UNAVAILABLE`，读取失败为502 `LOGIN_SHELL_FAILED`。`web`命令带`--no-login-shell`时，与设置了`CI`或在Windows上一样不提供（`available: false`）。

ADR-041（2026-10-12）追加：`web`、`chat`、`sessions`命令支持`--workspace-lock-root <绝对目录>`，默认仍为每个本机用户共用的`/tmp/harnessgateway-workspaces-<uid>`。显式目录须为规范化绝对路径（否则`INVALID_INPUT`），且为当前用户私有的真实目录（否则`INVALID_STORAGE`）。另用目录的 Gateway 不再与本机其他 Gateway 互斥同一工作区，只用于隔离的测试或刻意独立的实例。

ADR-044（2026-10-17）追加：Harness 视图带`installations`（每份官网安装：`ref`、`channel`、`label`、`command`、`version`、`role`、`active`、`maintained`、`canUninstall`，不含路径）和`unofficial`（`{command, onPath, pathDefault}`或`null`）；`install`带`checkedAt`与官网附注`note`；`WebState.installationPolicy`为`official`或`any`（开发）。`GET /api/v1/harnesses/:id/installations/:ref/uninstall`返回卸载检查：会运行的命令、删除的文件、保留的数据、先停止并注销的产品服务及命令、阻止卸载的未声明服务和常驻程序、仍在运行它的其他程序、使用它的对话、卸载后改用哪一份，以及`fingerprint`。`POST /api/v1/installation-jobs`接受`{harnessId, action: "uninstall", commandId, installation, expectedInstallationFingerprint, stopServices?}`，安装在确认后变了返回409 `INSTALLATION_CHANGED`，找不到返回404 `INSTALLATION_NOT_FOUND`。隐私例外：卸载检查与卸载任务的日志可以出现白名单内、以`~`书写的程序路径；服务端在返回卸载检查前检查，出现家目录的绝对路径就拒绝（500 `PRIVACY_GUARD`）。页面列表仍不含路径。

ADR-044 第 3 步（2026-10-17）追加：Harness 视图的`install`增加`method`（`script`、`npm`或`terminal`）与`available`（这个 Gateway 能否代为安装）。`GET /api/v1/harnesses/:id/install`准备一次按官网方式的安装并返回确认内容：官网命令、来源与 SHA-256、实际运行的命令、可写位置、可能改动的 shell 启动文件和产品配置、npm 的精确版本、前缀与 Node.js 要求、安装后终端里的命令指向哪一份、说明，以及`blocked`（不能安装的原因）、`fingerprint`和`expiresAt`（15 分钟）。`POST /api/v1/installation-jobs`接受`{harnessId, action: "install", commandId, expectedInstallFingerprint}`：过期或未知的确认返回409 `INSTALL_CHECK_EXPIRED`，产品已有官网安装返回409 `INSTALLATION_CHANGED`，Node.js 不满足返回409 `RUNTIME_INCOMPATIBLE`；只给命令的方式返回409 `UNSUPPORTED_INSTALL`。安装检查同样经过隐私检查。

ADR-052 实现裁决（2026-11-01）追加：`GET /api/v1/harnesses/:id/maintenance`的结果对声明了官方升级顺序的产品（OpenClaw 的 npm 安装）多一个`sequence`：`hops`（每跳的`version`、`bridge`与该跳的`runtimes`）、`commands`（按顺序的命令原文，家目录写作 ~）、`gateway`（第一跳前停止、最后一跳后启动的服务`{label, name, pid}`，不在运行时为`null`）、`restarts`（Gateway 恢复后由产品命令重启的服务`{label, name, pid, command}`）、`backupCommand`、`doctor: {command, rewrites, backups}`、`rollback`（只能从备份恢复的说明）；此时顶层`rollback`为`null`，`runtimes`是目标那一跳的，`restart[].command`是产品的启动命令。`POST /api/v1/installation-jobs`的升级请求可带`backupConfirmed: true`：只有这类升级受理，缺它返回409 `BACKUP_CONFIRMATION_REQUIRED`（任务未创建），其他请求带它、或值不是`true`，返回400 `INVALID_INPUT`；它计入命令指纹。任务事实新增`native.hops`（≤ 4，每项`{version, installed, doctor: ok|failed|skipped}`）、`native.backupConfirmed`、`native.configurationMigrated`（Doctor 改写的受保护配置，带 ~；`configurationPreserved`仍只表示 HarnessHub 自己没有写入）；gateway 的启动与 node 的重启记在`native.services`。失败码`DOCTOR_FAILED`（某跳 Doctor 拒绝，带原话）、`GATEWAY_STOP_FAILED`、`HOP_INSTALL_FAILED`、`GATEWAY_START_FAILED`与原有的`SERVICE_NOT_RECOVERED`、`SERVICE_NOT_READY`、`RUNTIME_INCOMPATIBLE`（指名那一跳）。页面解码器同批更新。

ADR-044 第 4 步（2026-10-17）追加：每份安装的视图增加`upgrade`（`version`、`self-update`、`rerun`、`terminal`、`maintenance`或`null`）和`latest`（上次检查更新的结果`{version, source, checkedAt, error}`，`source`为`npm`或`homebrew-local`，未检查时为`null`）。`maintenance`表示这份安装由 ADR-043 的升级负责，页面打开那里的确认。`GET /api/v1/harnesses/:id/installations/:ref/upgrade`准备一次升级并返回确认内容：`kind`、现版本与目标版本（自更新和重跑为`null`）、是否预发布、实际运行的命令、可写位置、脚本来源与 SHA-256、可能改动的 shell 启动文件与产品配置、Homebrew 一并处理的包与其中的共享运行时、Node.js 要求、使用它的对话、其他 HarnessHub 进程、仍在运行它的程序、说明，以及`blocked`、`fingerprint`和`expiresAt`（15 分钟）；“是否预发布”只是事实，页面作中性写出。原“ADR-038 的验证情况”字段（`verification`）与安装、维护检查的`target`字段 2026-10-22 起按 ADR-053 删除。`kind`为`terminal`时另给`terminal: {command, explains, localChanges}`，这种检查不能提交。`POST /api/v1/installation-jobs`接受`{harnessId, action: "upgrade", commandId, installation, expectedInstallationFingerprint}`：过期、未知或已用过的确认返回409 `INSTALL_CHECK_EXPIRED`，安装在确认后变了返回409 `INSTALLATION_CHANGED`，Node.js 不满足返回409 `RUNTIME_INCOMPATIBLE`，由 ADR-043 负责或不升级的安装返回409 `UNSUPPORTED_UPGRADE`。Homebrew 预演改动了已装的包返回409 `HOMEBREW_DRY_RUN_CHANGED`，预演超时或失败返回502。升级任务的事实在`native.installation`：标签、角色、方式、运行的命令、一并处理的包、shell 与配置改动、被阻止的写入；`native.beforeVersion`与`resolvedVersion`是升级前后读到的版本。升级检查同样经过隐私检查。

ADR-045 第 1 步（2026-10-18）追加只读`GET /api/v1/capabilities`，返回`CapabilitiesView`（`src/contracts/capabilities.ts`）。`harnesses`是每个有官网安装的 Harness：`version`取当前使用的那份安装记录的版本（只显示，不作判断），`kinds`按七类写明`read`、`unsupported`或`invisible`，`notes`是读取规则的说明；原`table`字段（读取规则是否按这个版本核实）2026-10-22 起按 ADR-053 删除，读表核对时的版本只记在读表自己的`checkedOn`，作证据。`entries`是技能、MCP、指令、子 Agent、命令、Hooks、插件的条目：每条带`owner`、`source`（只保留 http(s) 地址，去掉账号、查询与片段）、`location`、逐个 Harness 的`edges`（`mechanism`、`status`、`via`、`reason`，MCP 与插件另带`facts`）和`warnings`（`duplicate`、`shadow`、`cross`、`invisible`、`literal`、`redundant`）。`unreadable`列出解析失败或读不了的文件及原因，其中的内容不进入视图；条目上限 4096，超出时`truncated`为真。读取只看用户级文件，不运行任何 Harness 命令，不启动或连接 MCP 服务器。视图只含名字与数量，不含环境变量、请求头或参数的值，也不含 URL 的路径与查询；路径以`~`书写，来自用户文件的说明等文字里的家目录也换成`~`。服务端返回前仍做隐私检查，出现家目录的绝对路径就拒绝（500 `PRIVACY_GUARD`）。同一时间只读一次，期间到达的请求共用这次结果。

ADR-045 第 2 步（2026-10-18，技能开关）追加写入接口，只改用户级配置，每次先检查后确认：
- `GET /api/v1/capabilities/skill-switch?harnessId=&name=&enabled=true|false[&via=]`准备在一个 Harness 里停用（`enabled=false`）或启用一个技能，不写任何文件，返回`CapabilityChangeCheck`：改动的文件（`~`书写）、精确的统一差异（`~`代表家目录，凭据打码）、OpenClaw 的官方命令（`command`，其差异来自在私有副本上运行同一条命令）、现有设置由谁写的（`harnesshub`、`other`、`none`）、提示、`blocked`（无需修改或不能安全修改时的原因，这样的检查不能确认）、`fingerprint`与`expiresAt`（15 分钟、只能用一次）。`via`是 Codex 的那一份（它按 SKILL.md 的路径停用），其他 Harness 忽略它。没有开关的 Harness（Cursor、Pi、DeepSeek Harness）返回 409 `CAPABILITY_UNSUPPORTED`，看不到的技能或 Codex 不读的位置返回 404 `CAPABILITY_NOT_FOUND`。
- `POST /api/v1/capabilities/changes`接受`{fingerprint, commandId}`，返回`CapabilityChangeView`：写入前再读比对，文件变了返回 409 `CAPABILITY_TARGET_CHANGED` 且什么都不写；确认过期、未知或已用过返回 409 `CAPABILITY_CHECK_EXPIRED`；`blocked`的检查返回 409 `CAPABILITY_TARGET_REFUSED`。写入前把原文件备份（每个文件留最近 10 份），原子替换，回读后字节必须与计划一致、解析后除目标设置外完全相等，否则`status`为`failed`并带`backupId`。同一`commandId`再次提交返回第一次的结果，同一编号用于另一项修改返回 400。写入开始后失败的修改照样返回 200、`status`为`failed`；记录与回答里的`error`只含错误码与以`~`书写的位置，例如“写入 ~/.codex/config.toml 失败（EACCES）”，不含系统错误的原文（其中有目标旁临时文件的绝对路径）。恢复备份、Claude Code 的命令与技能文件夹的改动失败时同样如此。
- `GET /api/v1/capabilities/history`返回最近 50 次修改与保留的备份；`GET /api/v1/capabilities/backups/:id/restore`准备恢复一份备份，返回它此刻会造成的差异与`changedSince`（HarnessHub 改动之后文件是否又被改过）；`POST /api/v1/capabilities/restores`接受`{fingerprint, commandId}`，先备份当前文件再恢复。history 读出修改记录与备份说明时把其中家目录的绝对路径写成`~`：旧版本留下、含绝对路径的失败记录逐条这样降级显示（同一`commandId`的重放也一样），不再让整个 history 被隐私检查拒绝；写成`~`之后仍含家目录绝对路径的，隐私检查照旧返回 500 `PRIVACY_GUARD`。
- 修改记录、备份索引与台账保存在数据根的`capabilities/capabilities.sqlite`（第 2 步初版为 schema v1，添加、更新、删除技能后为 v2，见下文），备份在旁边的`backups/`。所有这些回答都经过同样的隐私检查。

ADR-045 第 2 步（2026-10-18，放置与清理）追加：
- 视图里每个 Harness 带`shared`：它怎样读共享目录`~/.agents/skills`（`native`自己读、`external-dir`经配置加的目录、`links`经自己目录里的链接、`no`），自己目录里指向它的链接数`links`与其中多余的`redundant`，以及 HarnessHub 能改的方式`placeable`（`shared-dir`：Hermes；`skill-link`：Claude Code）。共享目录里的技能带`shared: {folder, placed}`：它在共享目录的文件夹和 HarnessHub 放置的链接（都以`~`书写）。
- `GET /api/v1/capabilities/shared-dir?harnessId=&present=true|false`：只用于 Hermes，在`skills.external_dirs`里加上或去掉共享目录（任何解析到它的写法都算），检查里写明会多看到哪些技能；其他 Harness 返回 409 `CAPABILITY_UNSUPPORTED`。
- `GET /api/v1/capabilities/skill-link?harnessId=claude&name=&present=true|false`：为共享技能在`~/.claude/skills/<文件夹>`建绝对路径链接，或移除 HarnessHub 放置的链接；已能看到、位置已被占用、链接不是 HarnessHub 建的，都写在`blocked`里。
- `GET /api/v1/capabilities/link-cleanup?harnessId=hermes|openclaw`：列出这个 Harness 自己目录里指向共享目录、且已多余的链接（Hermes 要先读取共享目录）。
- `GET /api/v1/capabilities/changes/:id/undo`：撤销一次链接改动，删掉当初建的、放回当初删的（按当初写的目标，相对路径保持相对）。
- 这些检查的`links`列出每个要新建或删除的链接；确认同样用`POST /api/v1/capabilities/changes`。应用前逐个核对链接与检查时一致，有一个变了就全部不做（409 `CAPABILITY_TARGET_CHANGED`）；做了的链接记在修改记录的`links`里，部分失败时也能撤销。
- `GET /api/v1/capabilities/history`另带`drift`：台账里 HarnessHub 写过、现在已不是它写的样子的设置与链接（`CapabilityDrift`：不透明的`id`、`kind`为`skill-switch`、`shared-dir`或`skill-link`、`harnessId`、`subject`、以`~`书写的`file`、`state`为`removed`、`changed`或`unreadable`，以及写入它的`changeId`与`at`）。每项按写入它的开关的读法从文件读回比对；文件读不到或无法解析记为`unreadable`，不当作已移除。读取不改任何文件，也不自动改回。
- `GET /api/v1/capabilities/drift/:id/reapply`：用原来的检查准备改回（开关、Hermes 的共享目录那一项、放置的链接），返回`CapabilityChangeCheck`，确认同样用`POST /api/v1/capabilities/changes`；未知的`id`返回 404 `CAPABILITY_NOT_FOUND`。
- `POST /api/v1/capabilities/forget`接受`{id}`，不再跟踪这一项：只删台账，不改文件，返回`{forgotten}`；已不在台账里返回`{forgotten: false}`；仍是 HarnessHub 写的样子时返回 409 `CAPABILITY_TARGET_REFUSED`；格式不对的`id`返回 400。
- 台账的原值：同一设置再次写入时，只有被替换的仍是 HarnessHub 自己的值，才保留它第一次写入前的原值；否则换成这次写入前的值。

ADR-045 第 2 步（2026-10-18，添加、更新、删除技能）追加：
- **读取仓库**：`GET /api/v1/capabilities/skill-sources?source=`。
  - `source`为`owner/repo`、`owner/repo#ref`或`https://github.com/owner/repo[/tree/<ref>/<文件夹>]`；其他主机、HTTP、账号、查询串和点段返回 400。
  - 下载这个版本的压缩包，不写任何文件，返回`SkillSourceListing`：
    - `id`：不透明，15 分钟内用于检查；
    - 仓库、`ref`、提交号；
    - 每个技能的名字、文件夹名、说明、仓库内文件夹、文件数、字节数、可执行文件数、是否带插件清单，以及`state`（`new`、`installed`、`conflict`、`refused`）与`reason`。
  - GitHub 拒绝或跳到 GitHub 以外的主机返回 502 `CAPABILITY_COMMAND_FAILED`；找不到仓库返回 404。
- **添加的检查**：`GET /api/v1/capabilities/skill-add?listing=&names=a,b`，`names`是文件夹名，以逗号分隔。
- **检查更新**：`GET /api/v1/capabilities/skill-updates[?refresh=1]`，返回`SkillUpdateView`。
  - 范围：HarnessHub 装的技能，以及 lock 里记了 GitHub 来源的技能。
  - 每项给出`manager`（`harnesshub`或`skills-cli`）、仓库、`state`（`current`、`available`、`gone`、`unknown`、`unsupported`）、`modified`（不知道时为 null）与`reason`。
  - 每个“仓库 + ref”调一次 GitHub 的树接口；结果保留 10 分钟，`refresh=1`重新读取。
- **更新的检查**：`GET /api/v1/capabilities/skill-update?name=[&overwrite=true]`。本地改过时`blocked`，带`overwrite=true`后`skills[].overwrites`给出覆盖的文件数。
- **删除的检查**：`GET /api/v1/capabilities/skill-delete?name=`。
- **这三类检查的`CapabilityChangeCheck`**：`kind`为`skill-add`、`skill-update`或`skill-delete`，另带：
  - `skills`（`CapabilitySkillPlan`）：每个文件夹的动作、文件数、字节数、可执行文件数、是否带插件清单，更新时还有逐个文件的`changes`（最多 200 个）；
  - `source`：仓库、ref、提交号；
  - `lock`：lock 文件与打码的差异，不改 lock 时为 null；
  - `orphans`：删除后留在原处的停用设置。
  - `links`的每项带`owner`（`harnesshub`或`other`）。
  - `current`在这里表示来源记录：`harnesshub`为 HarnessHub 装的，`other`为 npx skills 的 lock 里有，`none`为没有记录。
  - 确认同样用`POST /api/v1/capabilities/changes`：应用前核对每个文件夹、链接与 lock 仍是检查时的样子，否则 409 `CAPABILITY_TARGET_CHANGED`，什么都不做。
- **修改记录**：`CapabilityChangeView`另带`skills`：每个文件夹前后的 tree id，null 表示没有文件夹。
- **撤销**：`GET /api/v1/capabilities/changes/:id/undo`也接受这三类修改，返回`kind`为`skill-undo`的检查；快照已清理时返回 404。
- **历史**：`GET /api/v1/capabilities/history`另带：
  - `orphans`（`CapabilityOrphan`）：HarnessHub 写的、技能已不在的停用设置；
  - `snapshots`：保留的快照数`count`、字节数`bytes`，以及保留最近多少次修改的快照`keep`（50）。
- **清除孤立的停用设置**：`GET /api/v1/capabilities/orphans/:id/clear`，走开关检查。这个 Harness 仍能看到同名技能时返回 409 `CAPABILITY_TARGET_REFUSED`。
- **视图**：`GET /api/v1/capabilities`里 HarnessHub 装的技能`owner`为`harnesshub`，`source`为它的仓库；两份 lock 都读，`$XDG_STATE_HOME/skills/.skill-lock.json`优先。
- **存储**：升到`capabilities.sqlite` v2，新增`skill_sources`与`skill_undo`；快照在`capabilities/skills/`。降级用`tools/capabilities-v2-to-v1.sql`。

ADR-045 第 3 步（2026-10-18，MCP 统一清单 3a）追加：
- `GET /api/v1/capabilities/mcp`返回`McpInventoryView`：
  - `servers`：清单里的服务器。每个带定义（路径以`~`书写）、打码后的命令行、所需变量及其在 HarnessHub 环境里是否已设置（只给布尔值），以及每个已安装 Harness 的状态`targets`：`synced`、`claimable`、`outdated`、`different`、`changed`、`removed`、`absent`、`unsupported`，附原因与文件。
  - `candidates`：各 Harness 用户级配置里已有的服务器，按名字和定义归组；每项带不透明的`id`、定义或不能收进清单的原因`problem`、所在的 Harness，以及与清单的关系`state`（`new`、`listed`、`different`）。
  - `harnesses`：每个 Harness 能否写入，不能时附原因。
- 改清单（都不改任何 Harness 的文件）：
  - `POST /api/v1/capabilities/mcp/servers`接受`{name, definition, replace?}`，`definition`即`McpDefinitionView`，不合格时返回 400 和原因；
  - `POST /api/v1/capabilities/mcp/servers/delete`接受`{name}`，仍有 HarnessHub 写的条目时返回 409；
  - `POST /api/v1/capabilities/mcp/import`接受`{candidate, claim?}`；
  - `POST /api/v1/capabilities/mcp/claim`接受`{name, harnessIds}`；
  - 认领返回`mcp-claim`修改记录。
- 写入的检查：`GET /api/v1/capabilities/mcp/sync?name=&harnessId=[&overwrite=true]`与`GET /api/v1/capabilities/mcp/remove?name=&harnessId=`，返回`kind`为`mcp-sync`或`mcp-remove`的`CapabilityChangeCheck`。确认同样用`POST /api/v1/capabilities/changes`。HarnessHub 写的条目被外部改动或移除后，要带`overwrite=true`；用户自己的同名条目不会被覆盖。
- 漂移：`history.drift`的`kind`可以是`mcp`，重新应用即带`overwrite`的写入检查。
- 存储：升到`capabilities.sqlite` v3，新增`mcp_servers`。降级用`tools/capabilities-v3-to-v2.sql`，会删除清单、MCP 的修改记录与台账。
- 3c（2026-10-18）：DeepSeek Harness 也可读可写：读每个 profile 的补丁和 `~/.dsh/cordis.patch.yml` 里的 MCP 客户端行，写入全局补丁里 `id` 为 `harnesshub-mcp-<名>` 的独立 insert（`!!js` 引用），列表空了写回 `[]`。名字超过 32 个字符的服务器（它的客户端不接受）在这里显示 `unsupported` 并说明原因。2026-10-19 起，补丁文件由 HarnessHub 新建时，移除最后一个服务器的检查说明“会删除这个文件”，应用后文件不存在；原来就有的文件回到 `[]`。
- 3b（2026-10-18）：Claude Code 也可写。它的检查`command`是要运行的 Claude 命令（`claude mcp add-json …`，更新时为 remove 与 add-json 两条，以“；”分隔）；`rewrite`汇总这一项的前后值（打码）与 Claude 自己补的其他键；`diff`是在私有副本上预演的结果。确认后只比对这一项与检查时相同。

ADR-045 第 4 步（2026-10-18，指令区块）追加：
- `GET /api/v1/capabilities/instructions`返回`InstructionsView`：
  - `shared`：共享指令的文本与保存时间（没保存过时为空文本和`null`）；`additions`：每个 Harness 的追加文本；`limitBytes`：每份文本的上限（16384 字节）。
  - `targets`：每个已安装的 Harness 一项，带它读的文件`file`（以`~`书写，不写时为`null`）、状态`state`（`synced`、`outdated`、`changed`、`removed`、`absent`、`claimable`、`shadowed`、`elsewhere`、`unreadable`、`unsupported`）、原因`reason`、这个版本什么时候读到改动`effect`，以及写入前要先确认的事`cautions`。
- `POST /api/v1/capabilities/instructions`接受`{shared, additions?}`（`additions`以 Harness 标识为键），返回新的视图，不改任何 Harness 的文件。文本超过 16 KiB、含 NUL、含 HarnessHub 的区块标记，或写出家目录的完整路径时返回 400 和原因。
- `POST /api/v1/capabilities/instructions/claim`接受`{harnessId}`：文件里已有与现在的指令一致、但不在台账里的区块时，记为 HarnessHub 的，返回`instructions-claim`修改记录，文件不变。
- 写入的检查：`GET /api/v1/capabilities/instructions/sync?harnessId=[&options=…]`与`GET /api/v1/capabilities/instructions/remove?harnessId=[&options=…]`，返回`kind`为`instructions-sync`或`instructions-remove`的`CapabilityChangeCheck`。
  - `options`是逗号分隔的`acknowledge-cc-switch`、`create-own`、`overwrite`：分别表示知道 cc-switch 可能整份改写这个文件、同意新建 OpenCode 自己的文件（它的回退随之失效）、同意覆盖或移除被改过的区块。
  - cc-switch 的确认只在第一次写入、区块被外部移除后重写、覆盖 HarnessHub 没有对应记录的完整区块时需要；更新 HarnessHub 自己的区块只在`notes`里提示。判断只看`~/.cc-switch`是否存在，不读里面的任何东西。
  - OpenClaw：工作区的 AGENTS.md 不存在时阻止，不替它新建；写入后超过`agents.defaults.bootstrapMaxChars`（默认 20000 字符）时阻止；`notes`列出配置的频道名（不含频道里的值）。
  - 每次检查`notes`的第一句声明只改（或只删）区块，不改任何模型、Provider 或登录配置。
  - 只差用户表态的检查带`proceed: {option, label}`：页面以`label`为按钮，带上`option`重新检查。
  - 确认同样用`POST /api/v1/capabilities/changes`。移除时，HarnessHub 新建、移除后为空的文件会被删除，回读要求它已不存在。
- 漂移：`history.drift`的`kind`可以是`instructions`，重新应用即带`overwrite`的写入检查。
- 存储：升到`capabilities.sqlite` v4，新增`instruction_texts`。降级用`tools/capabilities-v4-to-v3.sql`，会删除指令文本、指令的修改记录与台账，各 Harness 文件里的区块保留。

ADR-045 第 5 步（2026-10-19，子 Agent 与新建技能）追加：
- `GET /api/v1/capabilities/subagents`返回`SubagentInventoryView`：
  - `subagents`：清单里的子 Agent，带定义（`description`、`prompt`）、每个已安装 Harness 的状态`targets`（取值同 MCP 清单：`synced`、`claimable`、`outdated`、`different`、`changed`、`removed`、`absent`、`unsupported`，附原因与文件）。
  - `harnesses`：每个 Harness 能否写入，不能时附原因（Cursor 的本机 CLI 不读家目录的子 Agent；Pi、Hermes、OpenClaw、DeepSeek Harness 没有子 Agent 文件）。
- 改清单（都不改任何 Harness 的文件）：`POST /api/v1/capabilities/subagents/save`接受`{name, definition: {description, prompt}, replace?}`，不合格时返回 400；`POST /api/v1/capabilities/subagents/delete`接受`{name}`，HarnessHub 的文件还在时返回 409；`POST /api/v1/capabilities/subagents/claim`接受`{name, harnessIds}`，返回`subagent-claim`修改记录。
- 写入的检查：`GET /api/v1/capabilities/subagents/sync?name=&harnessId=[&overwrite=true]`与`GET /api/v1/capabilities/subagents/remove?name=&harnessId=`，返回`kind`为`subagent-sync`或`subagent-remove`的`CapabilityChangeCheck`；确认用`POST /api/v1/capabilities/changes`。别的同名定义一律不覆盖；需要时新建目录（0700），移除最后一个文件后删除 HarnessHub 新建的空目录。
- 新建技能：`POST /api/v1/capabilities/skill-create`接受`{name, description, body}`，`POST /api/v1/capabilities/skill-edit`接受`{name, description, body, overwrite?}`，都返回`CapabilityChangeCheck`（`kind`为`skill-create`、`skill-edit`，带 SKILL.md 的差异）；文件夹被改过时编辑检查带`proceed: {option: "overwrite"}`。`GET /api/v1/capabilities/skill-text?name=`返回`{text: {description, body} | null}`，只对 HarnessHub 新建的技能。视图里这类技能的`source`为`HarnessHub 新建`。
- 漂移：`history.drift`的`kind`可以是`subagent`，重新应用即带`overwrite`的写入检查。
- 存储：升到`capabilities.sqlite` v5，新增`subagents`与`skill_sources.kind`。降级用`tools/capabilities-v5-to-v4.sql`。

ADR-045 第 6a 步（2026-10-19，插件启停）追加：
- `GET /api/v1/capabilities`的变化：
  - 每个 Harness 多了`pluginSwitch`（`"file"`或`null`）与`pluginReason`（只读的原因，或`null`）。
  - 插件的`facts`多了`switchable`；`enabled`为`null`表示按这家的规则无法确定（Codex 的表里没有`enabled`、Hermes 的记忆提供方）。
  - Claude Code 与 Codex 都有的`名@市场`插件合成一条，`key`为`plugin:<id>`，每家一条`edges`，各带自己的版本与位置；其他插件的`key`仍是`plugin:<harnessId>:<id>`。
  - Claude Code 的账户同步插件以`<名>@synced`列出，`mechanism`与`owner`为`synced`，位置只到`~/.claude/plugins/synced`，不含账户 ID。
- 检查：`GET /api/v1/capabilities/plugin-switch?harnessId=&id=&enabled=`，`id`为`名@市场`。返回`kind`为`plugin-switch`的`CapabilityChangeCheck`：Claude Code 改`~/.claude/settings.json`的`enabledPlugins.<id>`，Codex 改`~/.codex/config.toml`里这个插件表的`enabled`一行。依赖、管理设置、未安装与账户同步的情况以`blocked`说明原因。只读的 Harness 返回 409 `CAPABILITY_UNSUPPORTED`，非法`id`返回 400。确认用`POST /api/v1/capabilities/changes`。
- 漂移与孤立：`history.drift`的`kind`可以是`plugin`，重新应用即按 HarnessHub 写入的值再检查一次。`history.orphans`的每项多了`kind`（`skill`或`plugin`）；插件的孤立设置是 HarnessHub 为已卸载插件写的`false`，清除即写回原值。
- 存储不升版本（沿用台账表）；回退到旧构建时，这些台账行在漂移列表里显示为“无法读取”。

ADR-050（2026-10-22，Harness 分层与按需刷新，依据 ADR-048 用户决定第 1、8 项）追加：
- 分层：Harness 视图带必填的`tier`：`focus`（ADR-048 的七个焦点 Harness）、`frozen`（Cursor、Gemini CLI、Pi）或`catalog`（其余目录条目），由`src/adapters/catalog.ts`的`harnessTier`给出。`WebState`带必填的`harnessesScannedAt`：上次完成的扫描开始读取本机的 ISO 时间（`toISOString`格式）；在它之后的变化，例如之后才结束的任务，可能不在`harnesses`里。页面严格解码两项，缺失、取值不在列表中或时间格式不对都是`INVALID_RESPONSE`。
- 读取不扫描：`GET /api/v1/state`与`GET /api/v1/harnesses`返回上次完成的扫描，不启动发现；有扫描正在进行时返回上次的结果，不等待。启动扫描在监听开始前完成，所以总有结果。
- 扫描时机：启动；`POST /api/v1/harnesses/rescan`（客户端能要求的唯一完整扫描；正在进行的扫描直接共用。可带`{after}`：这个 Gateway 时钟的 ISO 时间，等到一次开始于该时刻或之后的扫描结束再返回；时钟只到毫秒，同一毫秒算作之后。格式不对返回 400）；登录 shell 目录变化后；管理任务的检查与提交前；检查更新后；管理任务的结束经`GET /api/v1/installation-jobs/:id`读到时（任务结束于上次扫描开始之后才扫，同一个结束只扫一次）。管理服务没有任务完成回调，所以由读到结束的这一次读取承担；等任务结束再读 Harness 列表的客户端因此读到任务留下的结果。能力页的读取与检查仍在请求时扫描；原生恢复命令不扫描，读上次扫描即可，命令与安装版本无关（2026-10-22 按 ADR-053 决定 3 修订，原“原生恢复命令仍在请求时扫描”作废）；导出只用上次扫描里的名称。
- 页面不定时请求：打开页面或回到页面（窗口获焦、`visibilitychange`变为可见）时读一次 state，上次扫描开始已满 60 秒、并且本页 60 秒内没有因此要求过扫描时`POST rescan`；有任务进行时每 800 ms 读一次 state（页面隐藏时 10 秒）；任务结束于上次扫描开始之后时，以该结束时间为`after`要求一次扫描，请求失败时回到页面再要求一次；“重新检测”按钮随时扫描。其他时候不发请求。没有打开的对话在侧栏里的状态因此只在这些时机更新，等你处理的审批与提问仍由推送实时更新（ADR-035）；页面自己打开的对话按 Gateway 的规则命名（`conversationTitle`），不再靠轮询纠正标题。
- 冻结默认隐藏：偏好`showFrozen`（默认关），设置页“发现”一节的开关“显示冻结的 Harness（Cursor、Gemini CLI、Pi）”。关时 Composer 的 Harness 选择器、欢迎页列表、命令面板的“用 X 开始新对话”、“我的 Agent”列表与计数（列表下写“已隐藏 N 个冻结的 Harness，可在设置里显示”并可跳转），以及能力页的列、“只看一个 Harness”下拉、共享目录与插件说明中的逐个 Harness 行、读取规则列表和只被隐藏 Harness 看到的条目，都不含冻结的 Harness；当前对话的选择与草稿所选的 Harness 永远不隐藏，能力页正在看的那个也不隐藏。名称查找、Inbox、详情栏、条目详情、分支与切换历史仍用完整列表，停在冻结 Harness 上的对话照常打开。开关打开时，“我的 Agent”给冻结项加“冻结”标记。能力页 MCP、指令、子 Agent 面板里逐个 Harness 的行这次不过滤。
- 原生恢复（ADR-039）：只有`once`、没有`interactive`时（DeepSeek Harness），详情栏显示“只问一次”的命令及其复制按钮、`onceNote`和两条提示，不显示“复制恢复命令”（原“已验证程序……‘只问一次（已用真实回合验证）’”2026-10-22 按 ADR-053 改写：任何版本都显示，页面不写验证字样）。

ADR-053（2026-10-22，按各 Harness 的最新正式版适配，版本只作工程证据）对本契约的改动汇总：
- 删除的字段：管理视图的`verification`（ADR-038）；安装检查与维护检查的`target`（ADR-038 的目标版本判定）；逐份升级检查的`verification`；能力视图每个 Harness 的`table`。服务端字段与页面的严格解码器由第三批 D1 在同一提交删除（ADR-053 裁决 2），之后服务端不再发送。
- `GET /api/v1/sessions/:id/native-resume`：`interactive`与`once`按产品给出，与安装版本无关；`note`只有`no-command`；dsh 带`onceNote`；读取不触发发现与版本探测。
- 版本号、接入口版本、渠道最新版本与“有新版本/已是最新”照常返回；预发布版只作事实。任何视图都不再带“未经验证”“未核实”这类判定；原程序不提供的能力在用到时以具名错误码加原程序给出的原因失败（例如 Codex 的`NATIVE_OPTION_UNAVAILABLE`、OpenCode 的`NATIVE_COMMAND_IGNORED`、Claude 的`NATIVE_COMMAND_UNAVAILABLE`）。
