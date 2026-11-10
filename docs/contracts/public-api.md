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

已接受（ADR-055）：接力新增 `RELAY_INPUT_LIMIT`、`RELAY_PREPARE_FAILED`、`RELAY_CONSENT_REQUIRED`、`RELAY_CHOICE_REQUIRED`、`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE`；切换与排队 Run 另有失败原因 `SWITCH_SOURCE_UNKNOWN`、`SWITCH_NOT_EFFECTIVE`；`NATIVE_STATE_UNCONFIRMED` 沿用。409 只覆盖受理时可判定的情形（`RELAY_INPUT_LIMIT` 在受理时是 429）；受理之后的接力失败是 Run 失败，经 `run.ended` 与 SSE 到达。长历史不再报 CONTEXT_TOO_LARGE：放不下的历史分层并记省略账目，只有“最小交接单 + 当前原话”放不下时才 `RELAY_INPUT_LIMIT`。阶段、HTTP 状态与选项见下文“接力：资源、接口与错误”。

重试建议不能等同于自动重跑。SDK 可以重连只读事件流；有副作用的提交只在相同幂等身份下重送，未知执行不以新 key 自动再跑。

## 接力：资源、接口与错误（已接受（ADR-055））

状态：已接受（[ADR-055](../decisions/0055-relay-and-context-scheduling.md)，2026-11-03 验收）。第三阶段的接口（G073，2026-11-10，已接上运行时与界面）代码完成、合成测试通过（含真实网关加真实页面的端到端走查），确切形状见下文“第三阶段已实现的 HTTP 形状”；本节其余仍是设计、未实现；整个接力没有真机验证。本节按接力终稿 [relay-architecture.md](../proposals/relay/relay-architecture.md)（下称“终稿”）的第 4 节（类型草案）、6.1 节（受理时序）、7.4 节（选择与重发）、9 节（失败与边界）、12.4 节（API 与错误码）与 14.2 节（事件）写成；字段名与枚举以终稿第 4 节为唯一来源，本节不另起名字。终稿留给用户拍板的 D1（送达未确认时受理同步 409 三选一）、D2（小窗口目标在启动前 `RELAY_INPUT_LIMIT` 并提供“只发这条消息”）、D4（当前输入永远原样）、D11（生产只对已探针的 Driver 开放）按推荐项写入，用户另作决定时改写本节。

标注：【事实】是现状代码，`file:line` 以本仓库为准；【实测】是本文作者在本机对现状代码求值的结果；【推断】是终稿没有逐字写出、由其条文推出的解读；【推算】是终稿声明未经实测、待 G070–G074 校准的常量初值。其余条文是终稿的设计决定，数字除另注外都是终稿给定的设计上限或初值。安全侧的规则（出境类别、脱敏、同意、数据根）见 [security.md](security.md) 的接力一节。

**入口位置**：本节路径在本机 Web 入口 `/api/v1` 上（入口约定见 [provider-web-mvp.md](provider-web-mvp.md)），不是上文表格里长期 `/v1` 的建议路径；两者的对应、schema 与 operationId 仍由 C009 冻结。第三阶段之前 `src/` 与 `web/src/` 没有任何接力路由或 `RELAY_*` 错误码；现在 `src/web/relay-routes.ts` 提供 `GET …/relay`、`GET|HEAD …/relay/:packetId`、`GET|PUT /api/v1/relay/prefs` 与 `POST …/messages` 的 `relay` 成员（`src/web/server.ts` 只挂载它们），下文其余路由仍是设计。API、CLI 与界面用同一套命令语义（INV-25）：界面上的每个选择都经下面的请求字段表达，API 使用方收到与界面相同的 409 与选项（终稿第 16 节 S16）。下文 `…` 指 `/api/v1/sessions/:id`。

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
| `GET /api/v1/relay/prefs`、`PUT /api/v1/relay/prefs` | 安装级偏好，六个键都可写，`GET` 一律列出六个、没设过的给默认：`relay.crossVendor`（`ask`、`allow`、`goal_only`，**默认 `allow`**；`goal_only` 只交目标，MVP 里等于只发原话）、`relay.whenUnsure`（`auto`、`ask`，**默认 `auto`**：送达拿不准、核对不了时自己处理，`ask` 恢复 `RELAY_CHOICE_REQUIRED`）、`relay.returnPreference`（`continue` 总是续接、`new_when_cold` 冷且长时新开、`ask` 每次询问，默认 `continue`）、`relay.allowUnprobed`（`true`、`false`，**默认 `true`**，`false` 恢复 `RELAY_TARGET_UNVERIFIED`，只经 API）、`relay.dataRootInWorkspace`（`warn`、`block`，**默认 `warn`**，`block` 恢复数据根在工作区内的 409，只经 API）、`relay.localModelsOffline`（`true`、`false`，默认 `false`；“本机模型不出网”，只在 `crossVendor=ask` 时起作用） | 存 `relay_prefs`，最后写入者胜，值 ≤64 字符；默认放行下首次向一个厂商键交接，先向 `relay_log` 追加一行默认允许的记录再发（permissive-defaults §2.4）；`ask` 下 `allow` 不覆盖 `unknown:*`、`gateway:*`、`router:*`、`provider:*`，来源是工作区文件的端点每个会话都问（INV-33） |
| `POST …/switches` | 增加可选 `mode`（见上文“切换”） | 既有幂等与校验不变 |

**共同前置**：新端点沿用 cookie、CSRF 与 Host/Origin/Sec-Fetch 校验（`src/web/server.ts:505–535`【事实】）；读取其他会话的 packetId 返回 404；SSE 不含正文、原值与原值的哈希（RT4 AP-01–AP-03）。

**事实流**：会话事实流（`GET …/events/stream`）推送 `run.context_prepared`、`relay.input_recorded`、`relay.verified`、`relay.vendor_changed`、`run.ended`，事件数据形状与幂等键见终稿第 14.2 节；事实流上这些事件怎样出现（快照里的 Run 带送达状态、跟在事实后面的 `relay` 帧）见下文“Run 与事实流”。每次交接新增事件 ≤3 条（`relay.input_recorded`、`relay.verified`、`relay.title_set`），请求带 `relay.consent` 时另加同意镜像 1 条；普通回合 0 条。

### 第三阶段已实现的 HTTP 形状（G073 后端，2026-11-10）

状态：代码完成，合成测试通过（`tests/integration/relay-api.test.ts`、`tests/security/relay-api.test.ts`：真实 HTTP、真实 SQLite，Harness 是夹具子进程）；没有任何真实 Harness 参与，真机验证未做。类型在 `src/contracts/web.ts`，路由、校验与错误体在 `src/web/relay-routes.ts`。本小节是这一阶段**确切的形状**，与上文设计的描述冲突处以本小节为准；设计里本阶段没有做的部分——`relay/preview`、`relay/observe`、钉住、排除、同意记录的读出与撤回、`excludeRuns`/`excludeSections`/`reveal` 等请求字段——仍是设计，请求里带这些字段得 400。

**默认放行之后，受理时不返回这些 409/429**（用户 2026-11-10 的决定，[ADR-055](../decisions/0055-relay-and-context-scheduling.md) 末节；规则全文见 [permissive-defaults.md](../proposals/relay/permissive-defaults.md)）：只关乎交接单的问题不拦消息。送达没确认、核对不了、标记丢失、窗口放不下、记录没能恢复、同意被撤回、准备失败，都在 open 之后由运行时决定——自动补发一次、退到纪元基准补发完整交接单、或策略单发（这条消息原样发出）——同一个 Run 完成，原因写进 `run.context_prepared` 的 `relay.decision`，这个绑定的 `attention` 常驻（下文 `GET …/relay`），页面据此画提示条。**严格设置**把它们恢复成同步的拒绝：`relay.whenUnsure=ask` 恢复 `RELAY_CHOICE_REQUIRED`、`RELAY_INPUT_LIMIT`（429）与 `RELAY_UNAVAILABLE{recovery_failed}`，`relay.allowUnprobed=false` 恢复 `RELAY_TARGET_UNVERIFIED`，`relay.crossVendor=ask` 恢复 `RELAY_CONSENT_REQUIRED`，`relay.dataRootInWorkspace=block` 恢复 `RELAY_UNAVAILABLE{data_root_in_workspace}`；用户显式选择无法满足时（`attach:"full"`、`resend`、`clearConfirmed`、`native:"new"`）仍然失败、草稿保留。界面要能处理这些码出现的情形：输入框上方一行说明和 `options` 对应的按钮，草稿保留。

#### 发送：`POST /api/v1/sessions/:id/messages`

请求体 `{ text, commandId, attachments?, relay? }`；`relay` 可选，不带即默认行为：

| 字段 | 取值 | 本阶段 |
|---|---|---|
| `attach` | `"auto"`（默认，等于不带）、`"full"`、`"none"` | 生效，交给运行时（`runtime.send` 的第五个参数）。`full`：附上或补发完整交接单（界面只发它，A4）；`none`：只发这条消息 |
| `resend` | `true` | 生效 |
| `clearConfirmed` | `true` | 生效；不在可确认的状态时 400 `INVALID_INPUT`（没有待确认的清空，或清空是否执行已有结论），不建 Run |
| `tier` | `goal`、`brief`、`standard`、`fidelity`、`full` | 生效，交给运行时，随 Run 记录（`relay.decision` 之外的选择记录）；MVP 只渲染标准档，所以它不算“显式选择”，不让策略单发失败 |
| `native` | `continue`、`new` | 生效，交给运行时。`new` 是［新开原生会话］：这个 Harness 控制入口的原生会话与本条输入同一事务归档（与 `native-reset` 相同的条件：对话空闲、选择是原生 Harness、没有未确认资源），本条输入开一个新的并得到完整交接单；`continue` 记录选择，不要求历史 |
| `note` | 文本，非空白，≤4096 字节，除换行、回车、制表外无控制字符 | 只校验，不使用（交接单要等 G070 才收附言）；带了不报错、不改变这条发送 |
| `consent` | `{ vendor, decision: "acknowledged"｜"goal_only", scope: "session"｜"global" }`；`vendor` 须是合法的厂商键 | 生效，交给运行时：同意先写入安装级 `relay_log`，再以 `relay.consent_recorded` 镜像进本会话（`crossVendor=allow` 下重新允许被撤回的厂商就是它，页面的［重新允许］） |

校验是整体的：只认这些字段，未知字段、越界值、类型不符、`attach:"none"` 同时带 `resend`/`clearConfirmed`/`native:"new"`/`consent` 一律 400 `INVALID_INPUT`，文案固定、不引用请求内容，不建 Run。`note` 只校验、不使用。**幂等**：交给运行时的选择（`attach`、`resend`、`clearConfirmed`、`tier`、`native`、`consent`）进命令指纹，同一 `commandId` 换选择得 409 `IDEMPOTENCY_CONFLICT`；`attach:"auto"`、`relay:{}` 与不带 `relay` 等价。受理时的 409（严格设置下）不建 Run，也不占用 `commandId`：用户作出选择后，同一 `commandId` 带上选择重发即可。

#### 错误体

```
{ "code": "RELAY_CHOICE_REQUIRED", "message": "…",
  "relay": { "binding": { "harnessId": "codex", "controlId": "codex-app-server" },
             "cause": "delivery_unconfirmed",
             "options": ["attach_full", "send_alone", "new_native"],
             "counts": { "runs": 1, "packets": 0 } } }
```

`relay` 成员（`RelayErrorView`）只出现在用户能回答的接力错误上（`RELAY_CHOICE_REQUIRED`、`RELAY_CONSENT_REQUIRED`、`RELAY_TARGET_UNVERIFIED`、`RELAY_UNAVAILABLE`、`RELAY_INPUT_LIMIT`），只含标识、封闭的词和计数，没有历史的文字：

| 字段 | 含义 |
|---|---|
| `binding` | `{ harnessId, controlId }`：这条输入将要在其上执行的绑定（待决切换的目标，否则当前选择）；运行时在错误里点名了绑定时用它点名的 |
| `cause` | 错误的封闭原因：`delivery_unconfirmed`、`verify_required`、`marker_absent`（选择类）；`missing`、`vendor_changed`（同意类）；`recovery_failed`、`data_root_in_workspace`、`consent_log_full`（不可用类）；`unprobed`、`undeclared`（目标未经探针、Driver 不声明接力机制）；`min_packet`、`input_limit`（放不下）。不是封闭词的原因不出现 |
| `options` | 用户接下来可以选什么，每个对应下一次发送的一个字段：`attach_full`＝`{ attach: "full" }`，`send_alone`＝`{ attach: "none" }`，`new_native`＝`{ native: "new" }`，`clear_confirmed`＝`{ clearConfirmed: true }`，`acknowledge`＝`{ consent: { vendor, decision: "acknowledged", scope } }` |
| `counts` | 只在选择类与同意类：`runs`＝这个绑定被欠的、下一次交接要带的已结束 Run 数（别的 Harness 或它自己更早纪元的），`packets`＝它在当前原生纪元里已记录送达的交接单数。算不出时不出现 |
| `vendor` | 只在运行时点名了厂商键时：`acknowledge` 要同意的那个键 |

选项按原因与绑定状态定：选择类 `attach_full`、`send_alone`、`new_native`（`marker_absent` 与 `verify_required` 相同），绑定为 `suspect{clear_unconfirmed}`（有可确认的清空下限）而原因是 `verify_required` 时另加 `clear_confirmed`；同意类 `acknowledge`、`send_alone`；`RELAY_UNAVAILABLE{recovery_failed}` 为 `send_alone`、`new_native`，其余原因只有 `send_alone`；`RELAY_TARGET_UNVERIFIED` 与 `RELAY_INPUT_LIMIT` 只有 `send_alone`。HTTP 状态不变：`RELAY_INPUT_LIMIT` 429，其余四个 409。

#### 只读接口

`GET /api/v1/sessions/:id/relay` → `RelayView`：

```
{ "bindings": [ { "harnessId", "controlId", "nativeEpoch", "sync": "fresh"｜"synced"｜"pending"｜"suspect",
                  "throughRun": 0 | null, "evidence": "E1"｜"E2"｜"E3"｜"native"｜"legacy"｜"origin"｜"choice" | null,
                  "cleared": 0, "probed": false,
                  "canConfirm"?: true｜false, "vendor"?: "openai",
                  "owed"?: { "runs": 2, "estTokens": 1700 },
                  "vendorChange"?: { "from": "openai", "to": "deepseek", "runIndex": 3 },
                  "attention"?: { "cause", "options": [ "attach_full"｜"new_native"｜"clear_confirmed"｜"acknowledge" ],
                                  "counts": { "runs": 2, "packets": 1 }, "key", "packet"?: 2, "vendor"?: "openai" } } ],
  "packets":  [ { "packetId", "runId", "runIndex": 1, "number": 1, "kind": "packet"｜"delta"｜"anchor"｜"resend", "tier",
                  "target": { "harnessId", "model": null }, "estTokens", "omissions", "redactions",
                  "delivery": "in_flight"｜"recorded"｜"unknown"｜"not_recorded", "evidence": "E1"｜"E2"｜"E3" | null } ],
  "dataRootExposed"?: true,
  "installation"?: [ { "cause": "key_unavailable", "detail"?: "长度是 33 字节，应为 32 字节" } ] }
```

- `bindings`：会话里每个未归档的原生绑定一行。`throughRun`：绑定的标记所覆盖的最后一个已结束 Run 在会话 Run 里的序号（从 0 起），不覆盖任何 Run（没有标记，或只是会话起点的历史）时为 null；`evidence` 是标记的依据；待核、待定的绑定仍给出它最后所站的标记。`cleared`：当前原生会话里清空过几次——确认的清空就地抬高纪元；Harness 放弃它清空的原生会话（Claude Code 的合成清空）则新会话不在其中抬高纪元，它留下的 `fresh{user_cleared}` 状态算作造出它的那一次清空。`probed`：Driver 的接力机制是否在真机上证明过；Driver 不声明接力机制时也是 false（读自运行时，工厂无从判断时按声明）。
- `canConfirm`：这个 Harness 做的任何事能不能让网关知道交接单送达了（实时信号、事后核对，或一次正常结束的 prompt 就证明它记下了）；Driver 不声明接力机制时是 false——送达永远没法确认是 Harness 的事实，不是故障；网关答不出时不出现。
- `vendor`：这个绑定的 Harness 最后一次被看到在哪项模型服务上运行，只给固定词的（`openai`、`anthropic`、`deepseek`…）；用户自己的网关、路由、provider 以主机名或标识命名，不在这里给（只有［重新允许］在 `attention.vendor` 里点名）；Harness 还没运行过时不出现。
- `vendorChange`：这个绑定的 Harness 最近一次换了模型服务（`relay.vendor_changed` 且 `allowed:true`，默认放行下不拦、只记）：`from`、`to` 是厂商键（固定词，或 `gateway:<主机>` 这类事件里本来就公开的键），`runIndex` 是看到这次变化的 Turn 在会话 Run 里的序号（从 0 起）；页面在该 Turn 的消息下写“X 这次经 … 处理（上次是 …），已记录”。只给最近一次；从没变过、或那个 Run 已不在时不出现。
- `owed`：现在向这个绑定交接会带的已结束 Run 数（分支引用的父会话历史也按它的用户轮数算入）与对它们的 token 估算（它们的原话与回复，加交接单的框架，封顶在窗口未知的标准档上限；估算偏高，不是交接单的大小，界面写“约”）；什么都不欠时不出现。运行时为这个 Harness 保有原生会话时，它就是欠交的唯一说法（清空与下限是运行时才知道的）。
- `attention`：运行时的 `Runtime.relayAttention`（permissive-defaults §2.6），这个绑定请用户看一眼的事，**从不拦路，下一条消息照样发出**；没有事时不出现。**按这一刻的状态现算（独立审查 I5），不从“最近一个 Run 的决定”推**：绑定的同步状态（待核、清空待确认、记录没能恢复），加上它仍欠交时（`counts.runs`>0）该厂商键当前的同意站位（用户撤回过、或只同意了目标）与它已知的窗口放不放得下最小的交接单——所以撤回的提示条在两条消息之间的命令回合里不会消失、用户重新允许后立即消失而不用等下一个 Run，窗口读到更大后同样；`counts.runs` 把会话起点的历史（分支引用的父会话）也算作欠交的轮数。同一厂商之后的又一次撤回是另一次事件（`key` 里带那条日志记录的序号），关掉过的提示条会再出现。`cause`：`delivery_unconfirmed`｜`verify_required`｜`marker_absent`｜`clear_unconfirmed`｜`recovery_failed`｜`input_limit`｜`consent_revoked`｜`consent_goal_only`。`options` 是用户可以怎么处理，每个对应下一次发送的一个字段（同错误体的 `options`），**永不含 `send_alone`**（单发是下一条输入自己会做的事）。`counts.runs`：这个绑定仍欠的对话轮数；`counts.packets`：已发出还没确认送达的交接单份数（`delivery_unconfirmed` 时为 1＋自动补发＋用户补发）。`key` 命名一次事件：同一个原因在同一次待核内是同一个 key，**页面按 key 只提示一次、关掉后不再弹**（浏览器里记，后端不存）。`packet`：`delivery_unconfirmed` 说的是“交接单 #n”；`vendor`：只在选项含 `acknowledge` 时给，是要重新允许的那个厂商键，关系视图里点名厂商的唯一地方。
- `installation`：安装整体现在做不到的事，只要原因在就一直在（`Runtime.relayInstallation`）；不是某个对话的提示，所以不进 `attention`。现有一种 `key_unavailable`：接力密钥文件不能用（长度不对、路径上是目录等），`detail` 是原因的几个字（不含路径与值）；此时每份要带历史的消息都只发原话（`prepare_failed{redaction_failed}`）。页面在每个对话里给一条不能关的提示，写明原因与怎么修（把 relay-key 文件移走、重启，旧的交接记录将无法核验）。没有问题时不出现。
- `dataRootExposed`：数据目录在这个会话的工作区的可及范围内（`Runtime.relayDataRootExposed`）；一个警告，不是拦截，页面在工作区层面给一行可关的横幅（`relay.dataRootInWorkspace=block` 才拒绝）。
- `packets`：每个带交接单的 Run 一项，按 Run 顺序；`number` 是第几个 `relay.packetId` 非 null 的 Run（界面“交接单 #n”），`runIndex` 是这个 Run 在会话 Run 里的序号（从 0 起）。同一份交接单被另一个 Run 再发是另一项。`kind` 是交接单自己的种类：自动补发的包仍是 `packet`，区分它的是 Run 的 `relay.decision`，不是 `kind`。`omissions` 是省略项总数，`redactions` 是脱敏计数。没有原生绑定可追踪的 Driver（没有可恢复的原生会话）收到的交接单没有送达行，`delivery` 是 `unknown`、`evidence` 是 null——没有任何证据，不说送达。正文没有存下的交接单不列出，它的序号也空着。
- 读它不改变会话（`lastSeq`、`version` 都不动）。

`GET|HEAD /api/v1/sessions/:id/relay/:packetId` → 交接单存储的正文，即发出时的字节（不在返回时复扫）：`Content-Type: text/plain; charset=utf-8`，`ETag: "<正文字节的 sha256>"`（强校验），`Cache-Control: private, no-cache`，`X-Content-Type-Options: nosniff`，`Content-Security-Policy: default-src 'none'; sandbox`。`If-None-Match`（`*`、弱写法、列表都认）命中得 304 与同一 `ETag`，无正文；`HEAD` 只回头。本会话没有这份交接单——包括别的会话的、不存在的——一律 404 `RELAY_PACKET_NOT_FOUND`，应答逐字相同，不回显标识；会话不存在 404 `SESSION_NOT_FOUND`；会话标识不合法 400。`:packetId` 不是 `relay-` 加 20 位 Crockford base32（小写）的写法、或带查询串，则不是这条路由（404 `NOT_FOUND` 或 400），`relay/preview` 这类未实现的路径同理。页面判“这个网关没有接力 API”的依据只有一条：读 `GET …/relay` 得 404 且 `code` 为 `NOT_FOUND`（统一的路由缺失）或没有 `code`（或 405、501）；`RELAY_PACKET_NOT_FOUND`（包不存在）与 `SESSION_NOT_FOUND`（对话不存在）都不是，包不存在不会让页面忘掉这个网关有接力。

`GET /api/v1/relay/prefs` → `{ "prefs": { 六个键 } }`：六个键都在，没设置过的给默认（`RELAY_PREF_DEFAULTS`：`relay.crossVendor=allow`、`relay.returnPreference=continue`、`relay.allowUnprobed=true`、`relay.localModelsOffline=false`、`relay.whenUnsure=auto`、`relay.dataRootInWorkspace=warn`），页面从不猜默认。`PUT /api/v1/relay/prefs`，请求体 `{ "key", "value" }`，键与取值取 `RELAY_PREF_KEYS`、`RELAY_PREF_VALUES`（`relay.crossVendor`: `ask`｜`allow`｜`goal_only`；`relay.returnPreference`: `continue`｜`new_when_cold`｜`ask`；`relay.whenUnsure`: `auto`｜`ask`；`relay.dataRootInWorkspace`: `warn`｜`block`；`relay.allowUnprobed`、`relay.localModelsOffline`: `true`｜`false`），最后写入者胜；成功回 200 与写后的 `{ prefs }`。未知键、越界值、多余或缺少的字段 400 `INVALID_INPUT`，什么都不写。设置页只露出 `relay.crossVendor`（允许（默认）／每次询问／只交目标）与 `relay.whenUnsure`（自动处理（默认）／每次问我）；其余四个只经 API。

三者都要登录；`PUT` 与发送一样要同源 `Origin` 与 CSRF 令牌（`src/web/server.ts` 的统一检查）；其余方法与路径落到统一的 404。

#### Run 与事实流

**Run 的送达状态与决定**：`GET /api/v1/sessions/:id` 与事实流里的 Run（`SessionView.runs`、`run` 帧）的 `relay`（`RunRelayView`）在快照已有的 `packetId`、`kind`、`continuity`、`executedOn` 之外多两个可选成员。`delivery: { state, evidence }`：每个带交接单（`packetId` 非 null）的 Run 都有；没有送达行可追踪的交接单是 `{ state: "unknown", evidence: null }`；没带交接单的 Run 没有它；送达行读不出来时（`INVALID_DATA`）整个会话的 Run 不带它，会话本身不受影响。**Run 结束后它仍会变**——后来的核对可以把 `unknown` 改成 `recorded`（E2）——变化随提交它的那次事实帧到达。`decision: { kind: "carry"｜"alone"｜"plain", by: "need"｜"policy"｜"user", cause?, reason?, resend?: "auto"｜"grown"｜"user" }`：relay 对这个 Turn 的历史做了什么、谁决定、为什么（读自事件 `run.context_prepared` 的 `relay.decision`，授权后才被撤回同意的 Turn 以 `relay.withheld` 的决定为准——后写的为准；每个会话读一次、之后只读新事件；只跑在同一个 Harness 控制入口上、没有任何交接的会话不读事件）。普通且不欠任何东西的 Turn 没有它；`carry/need` 是按欠交发出的交接单，`carry/policy` 是策略自动补发或退到纪元基准补发完整交接单（`resend` 区分补发的两种：`auto` 是对没确认送达的那份包自动再附一次、同样的事实再发，`grown` 是为更新的事实发的新包、它也带着上次没确认送达的内容，界面写“补交 N 轮（含上次未确认送达的内容）”；用户自己的［再附一次］是 `carry/user`＋`resend:"user"`；不是补发的交接单没有 `resend`），`alone/policy` 是策略单发（`cause` 说为什么：`delivery_unconfirmed`、`verify_required`、`marker_absent`、`input_limit`、`recovery_failed`、`consent_revoked`、`consent_goal_only`、`prepare_failed`、`classification_changed`），`alone/user` 与 `carry/user` 是用户自己的选择。页面据此如实说“这条只发了原话”，从不把单发的 Turn 说成“已接手”。**Web 的 Run 不带 `relayRequest`**：它是用户这次选择的 HMAC（`fingerprint`），留在网关里，用户选了什么看 `decision.by === "user"`；事件页（`GET …/events`）里 `message.accepted` 的 `relayRequest` 也去掉 `fingerprint`。

**`relay` 帧**：会话事实流在 `snapshot`、`message`、`run` 之外多一种帧，只通知、不是事实：

```
{ "type": "relay", "sessionId": "session-…", "version": 41, "lastSeq": 41,
  "event": { "type": "relay.input_recorded"｜"relay.verified"｜"relay.vendor_changed"｜"relay.clear_confirmed",
             "sessionId": "session-…", "runId"?: "run-…", "packetId"?: "relay-…", "at": 1794305941906 } }
```

- 每个这四类事件一帧，跟在承载它的事实帧后面，**同一个 `version` 与 `lastSeq`**，SSE 的 `id:` 也相同；按水位应用事实的读者把它当空操作，再去读 `event`。同一次提交里有几个接力事件，各有一帧，都在同一个水位下。
- `runId`：事件发生在哪个 Run 里（核对的 `inRunId`、厂商变化的 `observedInRun`）；`packetId`：事件点名的那一份交接单（`relay.input_recorded` 的包；`relay.verified` 只在这次核对只看了一份包时给）；`at` 是毫秒时间戳。
- 不含正文、原值，也不含原值的哈希、标记、位置、厂商键：事件里的这些都不复制。一个背压中的订阅（连接写不出去）之后拿到完整的快照，不补通知。
- 接力帧是 `SessionStreamFrame` 的成员（`RelayStreamFrame`）：页面的解码先读 `event`，再把它当同水位的空操作交给 reducer（它不带事实，所以水位在它之前或之后都不改变会话）。旧版网页客户端（`web/src/session-stream.ts` 的 `envelope`，只认三种帧）遇到它会判为流协议错误 `STREAM_INVALID_FRAME` 并中断这条流：接力帧要与认得它的客户端同时上线。

**状态里的 `relay`**：`GET /api/v1/state` 的应答多一个可选的 `relay: true`：这个网关有接力 API，页面只向说了这话的网关读接力。

#### 本阶段的错误码

| 码 | HTTP | 何时 |
|---|---|---|
| `RELAY_CHOICE_REQUIRED` | 409 | 只在 `relay.whenUnsure=ask` 时：`delivery_unconfirmed`、`verify_required`、`marker_absent`；带 `relay` 成员。默认下运行时自己处理，不返回 |
| `RELAY_CONSENT_REQUIRED` | 409 | 只在 `relay.crossVendor=ask`（或同意被撤回、厂商变了）时；带 `relay` 成员 |
| `RELAY_TARGET_UNVERIFIED` | 409 | 只在 `relay.allowUnprobed=false` 时目标未经探针；带 `relay` 成员 |
| `RELAY_UNAVAILABLE` | 409 | `recovery_failed`（`whenUnsure=ask`）、`consent_log_full`，以及 `data_root_in_workspace`（`dataRootInWorkspace=block`）；带 `relay` 成员 |
| `RELAY_INPUT_LIMIT` | 429 | 只在 `relay.whenUnsure=ask` 时最小交接单放不下；带 `relay` 成员（`options` 为 `send_alone`） |
| `RELAY_PACKET_NOT_FOUND` | 404 | 本会话没有这份交接单 |
| `INVALID_INPUT` | 400 | `relay` 成员、偏好、会话标识不合规，或［确认已清空］不在可确认的状态 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同一 `commandId` 带了不同的接力选择 |

`RELAY_PREPARE_FAILED` 仍只作 Run 失败，不经 HTTP 返回。

### 错误码、阶段与选项

| 阶段 | 错误码 | HTTP | 结果与用户选项 |
|---|---|---|---|
| 受理时（同步预检；不建 Run、不启动程序、草稿保留） | `RELAY_TARGET_UNVERIFIED` | 409 | 目标 Driver 未经探针（`probed=false`；WorkBuddy 走同一路径），等级“无法接续”，只提供［只发这条消息］（`attach:"none"`）；开发与测试经配置 `relay.allowUnprobed=true` 放开（默认 false，D11） |
| | `RELAY_UNAVAILABLE{reason}` | 409 | `data_root_in_workspace`：数据根、HMAC 密钥文件与工作区互相包含时受理跨厂商交接（任一来源的厂商键与目的不同即算跨厂商；同厂商与单 Harness 对话可继续，见 security.md）；`consent_log_full`：同意日志轮转后仍满；`recovery_failed`：该会话恢复时 relay 行写入失败（`SessionSnapshot.relayRecoveryFailed`），native-reset 或新开原生会话后清除 |
| | `RELAY_CHOICE_REQUIRED{binding, cause, options, counts}` | 409 | `marker_absent`（核对为 absent 的 suspect 且 need≠∅）：［在同一会话补发完整交接单］［新开原生会话］；`verify_required`（存在外来事实、绑定 suspect 且 cause ∈ {rewind, unknown_command, clear_unconfirmed, unknown_turn, legacy}、受理前核对不可用）：［在同一会话补发完整交接单］［只发这条消息］［新开原生会话］，按 `counts` 显示，退回后 need=∅ 时不提供第一项；绑定为 suspect{clear_unconfirmed} 且核对未定论时另有［确认已清空］（阶段二：按 e 处理、`epochFloor=floorCandidate`、记 `relay.clear_confirmed{by:"user"}`，只由用户选择，建议请求字段 `relay.clearConfirmed:true`）；受理时只对任何核对都无法改变结论的待核绑定返回它：没有可核对标记且水位不声称外来事实的 suspect、carried=null 的 unknown_turn、`verify:"none"` 下水位不声称外来事实的 clear_unconfirmed 不返回它（open 时直接解析），能核对的 Driver（`on_next_open`，以及在 open 核对 suspect 的 `after_turn`）在绑定带 carried 包或水位站在包上时也不返回，open 后核对，仍未定论的让该 Run 以同一错误码在派发前失败；carried 包核不了而退回 pending 的，改走 `delivery_unconfirmed`（ADR-055 G068 补记，审批代理 2026-11-09、2026-11-10）；`delivery_unconfirmed`（pending 且自动重发已用尽或 Driver 声明 `lateDelivery`）：［再附一次］（`relay.resend:true`）［只发这条消息］（`attach:"none"`）［新开原生会话］（`relay.native:"new"`），即 D1 |
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

**错误体**：接力错误只带错误码与计数，接力代码的异常一律用固定文案、不引用输入片段（见 security.md）。错误体在 `{code, message}` 之外，对用户能回答的接力错误多一个 `relay` 成员（`WebError.relay`，确切形状见下文“错误体”）；字段与上文 RFC 9457 扩展成员的对应仍由 C009 冻结。

**HTTP 状态从哪来**：现状由 `publicFailure` 的子串规则映射（`src/web/server.ts:265–266`【事实】：含 `NOT_FOUND` 为 404，含 `LIMIT` 为 429，含 `UNAVAILABLE`、以 `_REQUIRED` 结尾等为 409，其余为 502）。按现状规则对各码求值【实测：本文作者在本机用 node 对该表达式的逐字副本求值】：`RELAY_INPUT_LIMIT` 429；`RELAY_UNAVAILABLE`、`RELAY_CONSENT_REQUIRED`、`RELAY_CHOICE_REQUIRED` 409；`RELAY_TARGET_UNVERIFIED` 按子串规则却是 502，所以 `publicFailure` 为它显式映射 409（现已在 `src/web/server.ts` 里）。`RELAY_PREPARE_FAILED` 只作 Run 失败，不经 HTTP 返回。

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
