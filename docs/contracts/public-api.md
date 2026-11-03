# 公共 API 与入口契约

状态：proposed，尚无 HTTP 服务。以下为可评审契约，不是可运行接口。Session 是公共稳定身份；原生 thread/session 不接受用户直接填写。

## 入口分层

认证 → 大小/格式/schema 校验 → principal 与 scope 校验 → 应用命令 → 所属聚合持久接收 → 响应。后台处理通过 outbox 继续；返回 202 不表示已经启动或完成。

| 方法与路径建议 | 语义 | 幂等与前置 |
|---|---|---|
| POST /v1/sessions | 建立公共 Session、工作区和选择偏好 | principal 范围 Idempotency-Key |
| GET /v1/sessions、GET /v1/sessions/{id} | 游标列表与公共状态 | 所有权；固定列表水位 |
| POST /v1/sessions/{id}/messages | 接收 text 或 typed command；产生 Message 和 Turn 意图 | key + canonical body hash；明确输入版本 |
| GET /v1/sessions/{id}/messages | 按公共顺序查询历史 | 有界 limit、游标和保留期 |
| POST /v1/sessions/{id}/switches | 申请更改 Harness/模型偏好 | expected epoch/version；重复同 key 返回同意图 |
| GET /v1/sessions/{id}/switches/{switchId} | 查看请求、准备、阻塞、生效或失败 | 请求与生效分开 |
| POST /v1/sessions/{id}/close | 停止新 admission，收敛当前执行和绑定 | 幂等，历史保留 |
| GET /v1/turns/{id} | 接收、排队、路由、执行与结算状态 | 不把不存在的 Attempt 伪造为运行中 |
| POST /v1/turns/{id}/cancel | 持久记录取消意图 | 202 表示受理；终态与清理另查 |
| GET /v1/sessions/{id}/events | SSE 重放/追踪公共事实 | Last-Event-ID/afterSeq，稳定事件身份 |
| POST /v1/permissions/{id}/decision | 提交实际 optionId | Attempt/epoch、未过期、有效选项、冲突决定拒绝 |
| GET /v1/artifacts/{id} | 下载登记成果 | 所有权、大小/hash 核验，不接受任意路径 |
| GET /v1/harnesses | 用户可见能力摘要；默认自动选择可隐藏具体列表 | 只读，标注证据等级 |
| POST/PUT /v1/admin/harnesses/{id} | 可信管理员注册或发布新 revision | 完整校验、expected revision |
| POST /v1/admin/harnesses/{id}/drain | 停止新 admission 并排空 | 当前执行不被无声杀掉 |
| DELETE /v1/admin/harnesses/{id} | 创建移除标记，受引用和排空规则限制 | 不删历史 revision |
| POST/GET /v1/admin/providers | 登记上游引用、协议与可用模型 | 秘密值经单独安全写入，不进入普通配置 |

接口最终路径、schema 和 operationId 由专属契约任务冻结；实现与 SDK 由同一契约生成或等价检查。不得把这张表当作已经存在的 API。

完整操作目录与 OpenAPI 的唯一所有者为 C009；Session 入口 G050、执行/权限入口 G051、Harness 管理 G061、Provider 管理 G062 分别实现各自路由，组合根 G059 集成。不能只完成前两类入口就声称注册/排空/移除已经可通过公共入口使用。

## 身份、幂等与并发

Idempotency-Key 是本项目自定义接口约定，不假称其已经是最终 IETF 标准。scope 为 principal + 操作类别 + Session（创建 Session 使用 principal 级）；同 key 与规范化等价 body 返回相同意图，异 body 为 IDEMPOTENCY_CONFLICT。等价规则、保存期限与清理明确记录；失去幂等记录时不得假装仍能去重。

命令接收事务保存确定的 Message/Turn/Switch ID、receivedAt、deadline、输入 hash、用户偏好以及 outbox。路由后 ExecutionPlan 另行固定实际 Harness revision、Provider/模型、context 与策略；偏好不等于已生效选择。

Session/配置变更使用 expectedVersion 或条件请求；缺少必须前置条件时 428，版本冲突 409/412 由契约任务统一。取消、deadline 和切换不通过普通新消息绕过控制仲裁。

## 输入、命令与错误

普通文本与网关 typed command 分开。CLI 的命令解析到相同应用命令；未知命令明确拒绝，不偷偷变成模型提示。允许的原生命令由 Adapter 显式声明，不能靠“以斜线开头”放行。

公共错误采用 RFC 9457 的 type/title/status/detail/instance，并扩展 code、requestId、可重试类别和字段错误；原生 cause 仅留脱敏诊断。领域错误码至少覆盖：UNSUPPORTED_CAPABILITY、NO_ELIGIBLE_HARNESS、MODEL_UNSUPPORTED、CONTEXT_TOO_LARGE、SESSION_BUSY、STALE_EPOCH、PERMISSION_EXPIRED、SWITCH_BLOCKED、RESOURCE_CLEANUP_UNCONFIRMED、STORAGE_UNAVAILABLE、EXECUTION_INTERRUPTED。

proposed（ADR-055）：接力新增 `RELAY_INPUT_LIMIT`、`RELAY_PREPARE_FAILED`、`RELAY_CONSENT_REQUIRED`、`RELAY_CHOICE_REQUIRED`、`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE`；切换与排队 Run 另有失败原因 `SWITCH_SOURCE_UNKNOWN`、`SWITCH_NOT_EFFECTIVE`；`NATIVE_STATE_UNCONFIRMED` 沿用。409 只覆盖受理时可判定的情形（`RELAY_INPUT_LIMIT` 在受理时是 429）；受理之后的接力失败是 Run 失败，经 `run.ended` 与 SSE 到达。长历史不再报 CONTEXT_TOO_LARGE：放不下的历史分层并记省略账目，只有“最小交接单 + 当前原话”放不下时才 `RELAY_INPUT_LIMIT`。阶段、HTTP 状态与选项见下文“接力：资源、接口与错误”。

重试建议不能等同于自动重跑。SDK 可以重连只读事件流；有副作用的提交只在相同幂等身份下重送，未知执行不以新 key 自动再跑。

## 接力：资源、接口与错误（proposed（ADR-055））

状态：proposed（[ADR-055](../decisions/0055-relay-and-context-scheduling.md)），未实现、未真机验证，用户验收之前不进入实现。本节按接力终稿 [relay-architecture.md](../proposals/relay/relay-architecture.md)（下称“终稿”）的第 4 节（类型草案）、6.1 节（受理时序）、7.4 节（选择与重发）、9 节（失败与边界）、12.4 节（API 与错误码）与 14.2 节（事件）写成；字段名与枚举以终稿第 4 节为唯一来源，本节不另起名字。终稿留给用户拍板的 D1（送达未确认时受理同步 409 三选一）、D2（小窗口目标在启动前 `RELAY_INPUT_LIMIT` 并提供“只发这条消息”）、D4（当前输入永远原样）、D11（生产只对已探针的 Driver 开放）按推荐项写入，用户另作决定时改写本节。

标注：【事实】是现状代码，`file:line` 以本仓库为准；【实测】是本文作者在本机对现状代码求值的结果；【推断】是终稿没有逐字写出、由其条文推出的解读；【推算】是终稿声明未经实测、待 G070–G074 校准的常量初值。其余条文是终稿的设计决定，数字除另注外都是终稿给定的设计上限或初值。安全侧的规则（出境类别、脱敏、同意、数据根）见 [security.md](security.md) 的接力一节。

**入口位置**：本节路径在本机 Web 入口 `/api/v1` 上（入口约定见 [provider-web-mvp.md](provider-web-mvp.md)），不是上文表格里长期 `/v1` 的建议路径；两者的对应、schema 与 operationId 仍由 C009 冻结。现状 `src/` 与 `web/src/` 没有任何接力路由或 `RELAY_*` 错误码【事实，grep】：会话下的路由只有 permissions、native-branch（`src/web/server.ts:758–759`）、events/stream（`:966`）、runs/:runId/diagnostics（`:994`）与 messages、switches、resume、cancel、close、events、export、fork、retention、end-process、native-resume（`:1017`）【事实】。API、CLI 与界面用同一套命令语义（INV-25）：界面上的每个选择都经下面的请求字段表达，API 使用方收到与界面相同的 409 与选项（终稿第 16 节 S16）。下文 `…` 指 `/api/v1/sessions/:id`。

### Run、切换与时间上的接力字段

**快照（v13）**：`PublicRun.relay?: { packetId: RelayPacketId | null; kind: RelayPacket["kind"] | null; continuity: ContinuityLevel; executedOn: { harnessId; controlId; nativeEpoch } | null }`；`PublicRun.relayRequest?: { tier?; attach?; native?; resend?; fingerprint }`，附言、放行与排除的正文不进快照，进 `relay_packets.manifest_json`。`ContinuityLevel` 从字符串改为对象，解析器同时接受 v12 事件里的旧字符串（现状写 `continuity: "public_context_rehydrate"`，`src/contexts/session/application/runtime.ts:275`【事实】）。新 Run 的 `sourceRunIds` 写空数组，旧数据照读。

**Run 资源**（终稿 12.4）带 `relay` 与 `relayRequest`。快照只存 `packetId`、`kind`、`continuity`、`executedOn`，其余字段在读取时从 `relay_packets` 与 `relay_deliveries` 组装【推断】：

| 字段 | 取值与含义 | 来源 |
|---|---|---|
| `relay.packetId` | 本 Run 携带的交接单 ID：`relay-` 加 20 位 Crockford base32，由正文派生；不携带时为 null。一个 Run 至多携带一份交接单（INV-31） | 快照 `PublicRun.relay` |
| `relay.kind` | `packet`（交接单）、`delta`（增量，可含要点小节）、`anchor`（要点包）、`resend`（重发，`supersedes` 指向被取代的包） | 快照 `PublicRun.relay` |
| `relay.continuity` | 接续等级（API 与快照同名，终稿 12.4）。主标签：继续原会话、新会话、原生分支、接续本机会话、上下文已清空、无法接续；内部取值 `native_resume`、`native_resume_delta{tier, runs}`、`rehydrate{tier, complete}`、`native_fork`、`native_import`、`native_cleared`、`blocked{code}` | 快照 `PublicRun.relay.continuity` |
| `relay.tier` | `goal`、`brief`、`standard`、`fidelity`、`full`（只交目标、精简、标准、保真、完整记录），默认 `standard`；“完整”只在省略账目里用户消息、回复、计划、失败四类都为 0 时使用 | `relay_packets.tier` |
| `relay.delivery.state` | `in_flight`、`recorded`、`unknown`、`not_recorded` | `relay_deliveries.outcome` |
| `relay.delivery.evidence` | `recorded` 时的证据级别：`E1`（实时事件）、`E2`（事后按位置核对）、`E3`（结算推断），以及 `legacy`、`origin`、`native` | `relay_deliveries.evidence` |
| `relay.omissions` | 省略账目的汇总：按类别的计数、回合区间、字数与取回方式（`hub_detail_view`、`workspace`、`native_session`、`none`）；每类 已渲染 + 已省略 + 未统计 = 全部（INV-32）；汇总的形状由 G073 定 | 清单 `omissions` |
| `relay.redactions` | 脱敏计数；不含原值，也不含原值的哈希 | 清单 `redaction` |
| `relay.userEdits` | 用户编辑：`excluded_run`、`excluded_section`、`note_added`、`tier_changed`、`pinned`、`revealed`，各带 `ref` | 清单 `userEdits` |
| `relayRequest` | `tier`、`attach`、`native`、`resend`；`fingerprint` 不进 Web DTO（终稿 12.4：沿用 provider-web-mvp.md 的“Web DTO 屏蔽 commands/fingerprints”）；快照与 `message.accepted` 里的 `fingerprint` 是 HMAC 会话子密钥对全部选项的 `HmacDigest`，不是未加盐 sha256（INV-29） | 快照 `PublicRun.relayRequest` |

**送达结论在 Run 结束后仍会变**：送达结论只由逐回合证据决定，存在独立的 `relay_deliveries` 表，不写进已终结的 Run（INV-31）。允许的转换：`in_flight` → `recorded`、`not_recorded` 或 `unknown`；`unknown` → `recorded` 或 `not_recorded`；`not_recorded` → `recorded`（只由后续正面证据触发）；`unknown` → `unknown` 与 `recorded` → `recorded` 的同值写（reason 细化、realized 结算）不算转换。声明 `verify = on_next_open` 的 Driver（Hermes）要到下一回合 open 时才核对（E2），所以客户端不能把已终结 Run 的 `relay.delivery` 当作定值：变化以 `relay.verified` 事件与 ETag 通知（终稿 12.4；ETag 属于哪个资源、怎么生成，终稿没写，由 C009 与 G073 冻结）。界面的送达状态（交接中、已接棒、已开始回复，送达待确认、未确认、没有送达）与分隔线只在证据之后出现（INV-21），文案见终稿 12.1、12.2。

**切换**：`POST …/switches` 增加可选 `mode`：`wait_current`（默认，到回合边界生效）或 `cancel_current`（界面的［停止并切换］：走停止链，未答复的审批与问题关闭、不转交，工具不转移）。`PublicSwitch` 增加 `mode`、`timing` 与 `acknowledgedUnknown: readonly RunId[]`：每个 ID 须是 status=unknown、`cleanup.closed=true`、用户消息早于 `requestedSeq` 的 Run，且只能出现在恢复切换上；解析器同时接受旧切换的 `sourceRunIds`。停止未确认时，unsafe 的 `run.ended` 在同一事务把待决切换记为 `failed{SWITCH_SOURCE_UNKNOWN}`、把等待它的排队 Run 记为 `SWITCH_NOT_EFFECTIVE`。切换生效时不组包、不做预算，交接单随下一条消息准备。

**时间**：`RunTiming` 增加 `contextReadyAt`，单调链为 `preparingAt → contextReadyAt → readyAt → dispatchedAt → firstOutputAt → endedAt`；E1 的时刻 `recordedAt` 只满足 `dispatchedAt ≤ recordedAt ≤ endedAt`，不入单调链，也不设置 `firstOutputAt`。

### 消息请求里的接力选项

`POST …/messages` 增加可选 `relay?: RelayRequest`（现状请求体只收 `text`、`commandId`、`attachments`，`src/web/server.ts:1052`【事实】）：

| 字段 | 取值 | 语义 |
|---|---|---|
| `tier` | `goal`、`brief`、`standard`、`fidelity`、`full` | 显式选档只受 hardCap（通道与窗口）压低，卡片先显示估算；不带时默认 `standard`，费用与时延只在 standard → brief → goal 之间降档，从不抬高 |
| `attach` | `auto`、`full`、`none` | `full`：只对这一条忽略清空下限（清空后的［附上交接单］），附上的包若 unknown，重发继承它；`none`：［只发这条消息］，原样发送、不产生送达证据、水位与同步状态都不变，下一条内容输入照常附包（INV-30）；`auto` 是普通路径 |
| `native` | `continue`、`new` | 用户的选择与返回决策经它进入请求：`new` 是［新开原生会话］；`continue` 是续接原会话，也是 `marker_absent` 时的［在同一会话补发完整交接单］【推断：受理检查以“请求没带 relay.native”判定需要选择】 |
| `resend` | `true` | ［再附一次］：pending 且不能自动重发时手动重发（manualResends+1），重新渲染当前全部 need，开头带去重行 |
| `excludeRuns`、`excludeSections` | 轮次序号【推断：与清单 fold 的 runIndex 同一编号】；节 ID `words`、`state`、`record`、`failures`、`files`、`plan`、`approvals`、`note`、`away`、`anchor`、`omissions` | 本次交接不放这些轮次或节；会话级排除走下文的 exclusions 接口 |
| `note` | ≤1,200 token | 附言：放在数据围栏之外，经出境脱敏 |
| `reveal` | `{ runId, ref, offset, length, tag }` 的数组 | 按位置放行误报的脱敏，标签只作校验，只对本会话中该位置生效 |
| `consent` | `{ vendor, decision, scope }`：decision 为 `acknowledged` 或 `goal_only`，scope 为 `session` 或 `global` | 随消息记录同意；权威写入安装级 `relay_log`，会话里写一条镜像事件 |

**受理检查**（`send()` 是同步受理，`src/contexts/session/application/runtime.ts:343–370`【事实】）：目标取 `pendingSwitch?.target ?? selection`（切换已受理但未生效时，消息在目标上执行）；只读 Driver 模块的静态声明与绑定上缓存的 `vendorObserved`，不打开程序。先做命令预分类：目标 Driver 的 `classify(text, 目录缓存)` 复刻原生解析（含前导空白，例如以全角空格开头的“/clear”），判为命令（声明 `acceptsRelay` 的除外）或疑似命令的输入跳过同意、选择、数据根与预算检查，原样发送、从不携带交接单，欠交内容留给下一条内容输入；open 后按 `models()` 复核，不符即 `RELAY_PREPARE_FAILED{reason:"classification_changed"}`。这与上文“允许的原生命令由 Adapter 显式声明，不能靠以斜线开头放行”一致。内容输入依次检查：目标未经探针、数据根与工作区互相包含、需要用户选择、厂商键缺同意、`hardCap < MIN_PACKET[族]`；缺项即同步返回下文的错误，不建 Run。排在活动 Run 之后的消息在启动前（`prePlan`）重做一次同样的检查。

**幂等**：接力选项进命令指纹，同一 `commandId` 配不同的接力选项得 `IDEMPOTENCY_CONFLICT`（`replayCommand` 按种类与指纹比较，`src/contexts/session/domain/state.ts:403–407`【事实】；现状 send 的指纹只含正文与附件，`runtime.ts:347`【事实】）。快照里的 `PublicRun.relayRequest` 只留 `{tier, attach, native, resend, fingerprint}`，`message.accepted` 带同一份。受理时的 409 不建 Run，也就没有命令记录，草稿保留；用户作出选择后可以用同一 `commandId` 带上选择重新提交【推断：409 在提交之前抛出】。

**当前输入**：第二段永远是用户原话全文，一字不改、不脱敏（D4 推荐项；INV-30 的“携带包时第二段等于原话”）；当前输入里有疑似密钥时省略首行，卡片提示“这条消息里有 1 处像密钥的内容，会原样发给 Codex”（终稿 12.1 的文案示例）。

### 接力接口

| 方法与路径 | 语义 | 前置、上限与失败 |
|---|---|---|
| `GET …/relay` | 各绑定的接力状态与本会话的交接单列表 | 只读 |
| `GET …/relay/:packetId` | 交接单存储的正文——即发出时的字节，与目标原生转录里留下的那段逐字相同（终稿 8.1、10.2）；不在返回时复扫，`ETag` 为存储正文的 sha256 | 读取其他会话的 packetId 返回 404；正文不可变（`relay_bodies`、`relay_packets` 有禁止 UPDATE 的触发器），同一 packetId 的 ETag 不变；出境扫描只在为发送而渲染时做一次，之后集合变化不改写已存正文 |
| `GET …/relay/preview?harnessId=&controlId=&nativeModel=&tier=` | 只定档估算，不渲染、不落库、不启动程序：等级与规模（如“Codex 新会话 · 交接单（标准）· 约 1.7k tokens”）；窗口未知时注明“窗口未知，按 128k（网关、路由方与本地模型 32k）估算” | 没有副作用的 GET；不再接受 `observe=true` |
| `POST …/relay/observe`（请求体 `{harnessId, controlId}`） | “核实厂商”：持租约打开目标、不派发、只读出厂商键 | 它会启动目标程序（1.3–5 s）、拉起用户的 MCP 与插件并持有租约，是有副作用的操作，所以是写请求、走写请求的 CSRF 与同源 Origin 校验；只在用户点“核实厂商”时调用，不自动做（终稿 10.4、12.4） |
| `POST …/relay/pins`、`DELETE …/relay/pins/:pinId` | 钉住与撤回：按 (messageId, offset, length) 记录，不存原文，渲染时从原消息取子串并标出作者；事件 `relay.pin_added`、`relay.pin_withdrawn`（带 `quoteHmac`，不含原文） | 写入时检查上限：≤24 个、每个 ≤2,048 字节、合计 ≤12,288 字节（界面写“≤680 字”） |
| `POST …/relay/exclusions`、`DELETE …/relay/exclusions/:id`（这里的 `:id` 是排除 ID） | 会话级排除（`kind` 为 `run` 或 `section`）与撤回；事件 `relay.exclusion_added`、`relay.exclusion_withdrawn` | 被排除的轮次从不出现，优先于“不得省略”，之后的包与预览都遵守；撤回只影响之后渲染的包，水位已越过被排除 Run 的绑定不再补交，界面写明 |
| `GET /api/v1/relay/consents`、`POST /api/v1/relay/consents`、`DELETE /api/v1/relay/consents/:vendor`、`DELETE …/sessions/:id/relay/consents/:vendor` | 安装级同意的读出（每个 (vendor, scope) 的当前视图；`GET …/sessions/:id/relay` 另列对本会话有效的记录）、记录与撤回，按目的厂商键；`DELETE /api/v1/relay/consents/:vendor` 撤回 global 记录，带会话路径的 DELETE 撤回本会话的 session 记录；权威记录在 `relay_log`（自带 seq、`command_id` 唯一、只追加，撤回也是追加一行），会话事件 `relay.consent_recorded`、`relay.consent_revoked` 只作镜像 | `relay_log` 写入失败让该同意命令失败（界面 500），不改任何会话；达到 65,536 行时同一事务轮转到 `relay_log_archive`，仍满即 `409 RELAY_UNAVAILABLE{reason:"consent_log_full"}`；撤回时一并作废待发的重发与预取缓存 |
| `GET /api/v1/relay/prefs`、`PUT /api/v1/relay/prefs` | 安装级偏好，四个键都可写：`relay.crossVendor`（`ask`、`allow`、`goal_only`；`goal_only` 只允许 tier=goal 的交接单）、`relay.returnPreference`（`continue` 总是续接、`new_when_cold` 冷且长时新开、`ask` 每次询问）、`relay.localModelsOffline`（“本机模型不出网”，INV-33 的唯一免同意例外）、`relay.allowUnprobed`（开发用，不在设置页露出） | 存 `relay_prefs`，最后写入者胜，值 ≤64 字符；`allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`，来源是工作区文件的端点每个会话都问（INV-33） |
| `POST …/switches` | 增加可选 `mode`（见上文“切换”） | 既有幂等与校验不变 |

**共同前置**：新端点沿用 cookie、CSRF 与 Host/Origin/Sec-Fetch 校验（`src/web/server.ts:505–535`【事实】）；读取其他会话的 packetId 返回 404；SSE 不含正文、原值与原值的哈希（RT4 AP-01–AP-03）。

**事实流**：会话事实流（`GET …/events/stream`）推送 `run.context_prepared`、`relay.input_recorded`、`relay.verified`、`relay.vendor_changed`、`run.ended`，事件数据形状与幂等键见终稿第 14.2 节。每次交接新增事件 ≤3 条（`relay.input_recorded`、`relay.verified`、`relay.title_set`），请求带 `relay.consent` 时另加同意镜像 1 条；普通回合 0 条。

### 错误码、阶段与选项

| 阶段 | 错误码 | HTTP | 结果与用户选项 |
|---|---|---|---|
| 受理时（同步预检；不建 Run、不启动程序、草稿保留） | `RELAY_TARGET_UNVERIFIED` | 409 | 目标 Driver 未经探针（`probed=false`；WorkBuddy 走同一路径），等级“无法接续”，只提供［只发这条消息］（`attach:"none"`）；开发与测试经配置 `relay.allowUnprobed=true` 放开（默认 false，D11） |
| | `RELAY_UNAVAILABLE{reason}` | 409 | `data_root_in_workspace`：数据根、HMAC 密钥文件与工作区互相包含时受理跨厂商交接（任一来源的厂商键与目的不同即算跨厂商；同厂商与单 Harness 对话可继续，见 security.md）；`consent_log_full`：同意日志轮转后仍满；`recovery_failed`：该会话恢复时 relay 行写入失败（`SessionSnapshot.relayRecoveryFailed`），native-reset 或新开原生会话后清除 |
| | `RELAY_CHOICE_REQUIRED{binding, cause, options, counts}` | 409 | `marker_absent`（核对为 absent 的 suspect 且 need≠∅）：［在同一会话补发完整交接单］［新开原生会话］；`verify_required`（存在外来事实、绑定 suspect 且 cause ∈ {rewind, unknown_command, clear_unconfirmed, unknown_turn}、受理前核对不可用）：［在同一会话补发完整交接单］［只发这条消息］［新开原生会话］；`delivery_unconfirmed`（pending 且自动重发已用尽或 Driver 声明 `lateDelivery`）：［再附一次］（`relay.resend:true`）［只发这条消息］（`attach:"none"`）［新开原生会话］（`relay.native:"new"`），即 D1 |
| | `RELAY_CONSENT_REQUIRED{reason: "missing" 或 "vendor_changed"}` | 409 | `missing`：目的厂商键缺同意（含撤回之后再次缺同意），附预览计数，选项［同意］［只发这条消息］；取不到厂商键时按 `unknown:<harnessId>` 询问，这个回答只记“已看过说明”，open 后观测到真实厂商键仍须同意；不静默改成不送历史。`vendor_changed`：本纪元收过包的绑定，请求的厂商键与 `consentKey` 不同，选项［同意］［新开原生会话］［取消］，并记 `relay.vendor_changed` |
| | `RELAY_INPUT_LIMIT` | 429 | 按保守窗口判定 `hardCap < MIN_PACKET[族]`（o200k 族约 W < 18k，Claude 族与未知族约 W < 27k【推算】），提供［只发这条消息］，即 D2 |
| 启动前（排队 Run 在 `prePlan` 重做受理检查） | 上一组的同一错误码 | —（请求早已以 202 受理） | 该 Run 以同一错误码失败，没有进程，绑定不变；经 `run.ended` 与 SSE 到达 |
| open 之后、派发之前（finalize、同意复检、分类复核、精化窗口） | `RELAY_PREPARE_FAILED{reason}`、`RELAY_CONSENT_REQUIRED{reason: "vendor_changed" 或 "revoked"}`、`RELAY_INPUT_LIMIT`、`RELAY_CHOICE_REQUIRED{marker_absent 或 verify_required}`（返回 A 时核对为 absent，或 `on_next_open` 的核对不可用） | —（HTTP 已无从返回） | Run 失败、未派发，经 `run.ended` 与 SSE 到达；原生会话已建立、绑定已写入（`src/adapters/control/codex.ts:350`、`runtime.ts:1384`【事实】），结算时绑定置为 ready、`throughRunId` 不动（`runtime.ts:1496`【事实】：未派发不推进）；新建的空原生会话随绑定保留，下一次按它 resume、不再新建；relay 状态不变（INV-21）。`run.dispatched` 的事务里再读一次同意，已撤回即不派发（`revoked`） |

`RELAY_PREPARE_FAILED` 的 reason：

| reason | 何时 |
|---|---|
| `render` | 渲染出错；写 `relay_packets` 时 fold 校验不过（单元指向的 Run 未终结，或其用户消息不早于当前输入） |
| `render_mismatch` | 清单头（全部渲染输入）相同而正文字节不同，在进入事务之前检出 |
| `redaction_failed` | 扫描器本身抛错，fail closed、不派发；单个条目超过扫描上限不在此列，只省略这一条并记 `unscanned` |
| `storage` | 权威 relay 行（交接单、送达、同意引用）在进入事务之前的序列化、字节或转换校验不过：只让本 Run 失败，不让事务失败、不让 Store 进入 failed（INV-35） |
| `storage_quota` | 正文存储达到结构上界 64 MiB/会话（256 包 × 256 KiB），提供［只发这条消息］，不影响其他会话 |
| `target_start` | 目标在派发前没能启动，什么都没送达（界面写“Codex 没能启动”） |
| `classification_changed` | open 后按 `models()` 复核的命令分类与受理时的预分类不符 |

`RELAY_CONSENT_REQUIRED` 的 reason：`missing`（受理时缺同意）；`vendor_changed`（finalize 用 open 后观测到的模型与端点复检，与受理时不符）；`revoked`（`run.dispatched` 事务内复读同意时已撤回）。本纪元收过包的绑定，请求的或观测到的厂商键与 `consentKey` 不同时，受理时同步 409、open 后作 Run 失败，都是 `vendor_changed`，选项［同意］［新开原生会话］［取消］，并记 `relay.vendor_changed`；撤回 A 所属厂商的同意后返回 A 且有增量就是缺同意，走 `missing`，选项［重新同意］［只发这条消息］，没有单独的“只发计数通知”（终稿 10.4）。观测失败或超时从不让准备失败，所以 `RELAY_PREPARE_FAILED` 没有 `observation_required` 这个 reason。

**沿用与相关的码**：`NATIVE_STATE_UNCONFIRMED` 沿用（gateway 型查看器被杀后绑定 unconfirmed，现状在 open 之前抛出，`runtime.ts:1336`【事实】）；`SWITCH_SOURCE_UNKNOWN` 是停止未确认时待决切换的失败原因，`SWITCH_NOT_EFFECTIVE` 是等待它的排队 Run 的失败原因。预期内的接力失败（校验、渲染、脱敏、配额、分类、同意）只让本 Run 失败，不让 Store 进入 failed、不让 Runtime fatal、不波及其他会话（INV-35）。

**open 之后失败时的界面**：“已切换到 Codex，但没能交接：原因。这条消息没有发出，草稿已保留”，提供［重试］［改回 Claude Code］［只发这条消息（不附交接单）］；重试时同一句原话只出现一次（草稿不叠加）。

**长历史不再报 `CONTEXT_TOO_LARGE`**：现状在 `src/contexts/session/domain/context.ts:58` 抛出【事实】。v13（G070）起，历史超出预算时分层降档并记满足恒等式的省略账目；只有“最小交接单 + 当前原话”超过通道硬上限或 capWindow 时才 `RELAY_INPUT_LIMIT`；历史长度永不导致 blocked（属性测试：W 在 4k–2M 上按对数均匀取样），RelayConformance 断言不出现 `CONTEXT_TOO_LARGE`。过渡期（G067，v12、不升库）：每回合只对将要发送的内容预算，同 Harness 续接、切换校验与 blocked 后恢复不再报它；切到新目标时要发的就是全部来源，900 KiB 回复之后 B 的第一条仍可能 `CONTEXT_TOO_LARGE`，此时提供［只发这条消息］（`attach:"none"` 的 P0 版本：原样发送、不改 `throughRunId`），这一点写进发布说明，分层预算到 G070 落地。

**错误体**：接力错误只带错误码与计数，接力代码的异常一律用固定文案、不引用输入片段（见 security.md）。现状错误体只有 `{code, message}`（`src/contracts/web.ts:264`、`src/web/server.ts:1088`【事实】）；`RELAY_CHOICE_REQUIRED` 的 `{binding, cause, options, counts}` 与 `RELAY_CONSENT_REQUIRED` 的预览计数需要扩展错误体，字段与上文 RFC 9457 扩展成员的对应由 C009 冻结。

**HTTP 状态从哪来**：现状由 `publicFailure` 的子串规则映射（`src/web/server.ts:265–266`【事实】：含 `NOT_FOUND` 为 404，含 `LIMIT` 为 429，含 `UNAVAILABLE`、以 `_REQUIRED` 结尾等为 409，其余为 502）。按现状规则对各码求值【实测：本文作者在本机用 node 对该表达式的逐字副本求值】：`RELAY_INPUT_LIMIT` 429；`RELAY_UNAVAILABLE`、`RELAY_CONSENT_REQUIRED`、`RELAY_CHOICE_REQUIRED` 409；`RELAY_TARGET_UNVERIFIED` 却是 502，实现时须为它显式映射 409（G073，经 `server.ts` 的所有者 G050）。`RELAY_PREPARE_FAILED` 只作 Run 失败，不经 HTTP 返回。

### 写入阶段提出、终稿已修订处置的点

处置见[第四轮处置表](../proposals/relay/round4/v3-dispositions.md)末节；本文件正文已按修订后的终稿改写。记录如下：

1. HTTP 状态：终稿第 6.1、12.4 节改为写明 `RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE`、`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED` 为 409、`RELAY_INPUT_LIMIT` 为 429，并删去“全部由 `server.ts:266` 映射为 409【事实】”；`RELAY_TARGET_UNVERIFIED` 的 409 映射在实现中由 G073 经 G050 扩展 `server.ts`。
2. 终稿第 9 节“错误码按阶段”的 open 之后一栏补上 `RELAY_CHOICE_REQUIRED{marker_absent 或 verify_required}`。
3. 接续等级在 API 与快照里统一叫 `continuity`。
4. `relayRequest.fingerprint` 改用 HMAC 会话子密钥（`HmacDigest`），Web DTO 不带它。
5. 事实流新增 `{ type: "relay", event }` 帧，错误体扩展 `relay?: {binding, cause, options, counts}` 成员；帧与字段的形状由 C009 冻结（仍未决，承接 C009 与 G073）。
6. 终稿补齐的值：`relay.returnPreference ∈ {continue, new_when_cold, ask}`；`DELETE /api/v1/relay/consents/:vendor` 撤回 global、`DELETE …/sessions/:id/relay/consents/:vendor` 撤回 session，`GET /api/v1/relay/consents` 读出；`relay_prefs` 四个键都可经 PUT 写；没有 `observation_required`；`relay_recovery_failed` 用 `RELAY_UNAVAILABLE{recovery_failed}`；撤回后返回 A 走 `RELAY_CONSENT_REQUIRED{missing}`，没有“只发计数通知”；`attach:"none"` 与 need=∅ 的回合跳过全部接力检查。
7. `GET …/relay/:packetId` 返回存储的正文、不复扫，`ETag` 为存储正文的 sha256；出境扫描只在为发送而渲染时做一次。
8. 带副作用的 `observe=true` 从 GET 预览里拿掉，改为 `POST …/relay/observe`。
