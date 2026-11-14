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

接力（ADR-055；瘦身后的现行设计见 [slim.md](../proposals/relay/slim.md)）从不在受理时拒绝一条消息：没有 409、429 类的接力错误码，长历史也不再报 `CONTEXT_TOO_LARGE`（放不下的整项留在交接单外并在账目里逐项列明；连最小的交接单都放不下时这条消息只发原话）。接力的错误码只有三个：`RELAY_PACKET_NOT_FOUND`（404，读一份本会话没有的交接单），以及只作 Run 失败（经 `run.ended` 与事实流到达，不经 HTTP 返回）的 `RELAY_PREPARE_FAILED{reason}` 与 `RELAY_INPUT_LIMIT`。切换与排队 Run 另有失败原因 `SWITCH_SOURCE_UNKNOWN`、`SWITCH_NOT_EFFECTIVE`；`NATIVE_STATE_UNCONFIRMED` 沿用。接口与字段见下文“接力：接口与字段”。

重试建议不能等同于自动重跑。SDK 可以重连只读事件流；有副作用的提交只在相同幂等身份下重送，未知执行不以新 key 自动再跑。

## 接力：接口与字段

状态：代码完成，合成测试通过（真实 HTTP、真实 SQLite、夹具 Harness 子进程，另有真实网关加真实页面的端到端走查）；没有真机验证。原决定是 [ADR-055](../decisions/0055-relay-and-context-scheduling.md)，现行设计与取舍是 [slim.md](../proposals/relay/slim.md)：瘦身之后，同意、探针、严格设置、钉住与排除、事后核对、预览、数据根告警等机制都已删除，ADR 与 [relay-architecture.md](../proposals/relay/relay-architecture.md) 里关于它们的条文不再有效，以本节为准。类型在 `src/contracts/web.ts` 与 `src/contracts/relay.ts`，路由、校验与错误体在 `src/web/relay-routes.ts`。

路径在本机 Web 入口 `/api/v1` 上（入口约定见 [provider-web-mvp.md](provider-web-mvp.md)）；读写都要登录，写还要同源 `Origin` 与 CSRF 令牌，与其他接口一致。下文 `…` 指 `/api/v1/sessions/:id`。`GET /api/v1/state` 的应答带 `relay: true`：页面只向说了这话的网关读接力。

接口背后的行为：

- 对话换到另一个 Harness 后的第一条消息，自动附上它没有看过的部分（一份交接单）；设置 `relay.attach=off` 时只发原话。
- 交接单是否送达只看手头的证据：E1（Driver 报告了这条输入；`agent_output` 型 Driver 的第一条输出算它）和 E3（Driver 声明“正常结束即证明收到”，且这一轮正常结束）；不回读原生历史。没有证据就是 `unknown`，从不说送达。
- 发出后没有确认的交接单，下一条消息自动再附一次（至多一次）；再不确认，之后的消息只发原话，有新内容再附；用户随时可以 `attach:"full"`。
- 原生命令（`/clear`、`/new`、`/reset`……）永远原样发送、不带交接单。清空由网关执行：不发给原生程序，六个 Driver 一致地放弃当前原生会话、换新的（原生纪元加一）；清空之前的部分不再自动附上，用户可以为下一条附上它。
- 正在运行的工具不转移；未知结果的执行不自动重跑。接力从不在受理时拒绝一条消息：没有 409、429 类的接力错误。

### 发送：`POST …/messages`

请求体 `{ text, commandId, attachments?, relay? }`；`relay` 可选，只有一个字段：

| `relay.attach` | 语义 |
|---|---|
| 不带、`"auto"` | 默认行为（见上） |
| `"full"` | 这一条附上整份之前的对话：清空之后的［附上交接单］，送达没确认之后的［再附一次］。只对这一条生效；没有可附的内容时原样发送，决定里记 `plain/user` |
| `"none"` | 这一条只发原话（［只发这条消息］）：不产生送达证据，水位与同步状态不变，下一条照常附 |

校验是整体的：未知字段、越界值、类型不符一律 400 `INVALID_INPUT`，文案固定、不引用请求内容，不建 Run。`attach` 进命令指纹：同一 `commandId` 换了选择得 409 `IDEMPOTENCY_CONFLICT`；`relay:{}`、`attach:"auto"` 与不带 `relay` 等价。

202 之后的接力失败是 Run 的事：只有用户明确要求（`attach:"full"`）而交接单准备不了或放不下时 Run 失败，错误码 `RELAY_PREPARE_FAILED{reason}`，经 `run.ended` 与事实流到达，草稿保留；没有明确要求时，同样的情形只发原话，并在 `relay.decision` 里写明原因。`reason` 取 `render`、`render_mismatch`、`redaction_failed`、`storage`、`storage_quota`、`input_limit`、`recovery_failed`。长历史不再报 `CONTEXT_TOO_LARGE`：放不下的整项留在交接单外并在账目里逐项列明，连最小的交接单都放不下时这条消息只发原话（`cause:"input_limit"`）。Driver 在发出前的两道保险也让 Run 失败、什么都没有发出：一轮超出它的输入上限（`RELAY_INPUT_LIMIT`，网关已预先量过，只有连原话本身都放不下时才遇到）；原程序把这条读作命令而网关当内容受理了（`RELAY_PREPARE_FAILED`，`reason` 为 `classification_changed`，两处分类不一致时才遇到）。

### Run 与事实流

会话（`GET …`）与事实流里的 Run 带 `relay`（`RunRelayView`）：

```
relay: { packetId: "relay-…" | null, kind: "packet" | "delta" | null,
         continuity: { kind, … }, executedOn: { harnessId, controlId, nativeEpoch } | null,
         delivery?: { state: "in_flight" | "recorded" | "unknown" | "not_recorded", evidence: "E1" | "E3" | null },
         decision?: { kind: "carry" | "alone" | "plain", by: "need" | "policy" | "user", cause?, reason?, resend? } }
```

- `packetId` 是 `relay-` 加 20 位 Crockford base32，由正文派生；一个 Run 至多带一份交接单。`kind`：`packet` 是整份，`delta` 是给已持有一部分的原生会话的增量。
- `continuity` 是接续等级：`native_resume`、`native_resume_delta{tier, runs}`、`rehydrate{tier, complete}`、`native_fork`、`native_import`、`native_cleared`、`blocked{code}`。`tier` 只有 `full`（记录全部放进了交接单）与 `brief`（整项放不下的被省略，交接单末尾的账目逐项列明）。解析器同时接受 v12 事件里的旧字符串。
- `delivery`：每个带交接单的 Run 都有；没有送达行可追踪的交接单是 `{ state: "unknown", evidence: null }`；没带交接单的 Run 没有它。决定之后不再改变（只细化原因）：`in_flight` 变为 `recorded`（E1 或 E3）、`not_recorded` 或 `unknown`。
- `decision`：relay 对这个 Turn 的历史做了什么、谁决定、为什么，读自 `run.context_prepared` 的 `relay.decision`；普通且不欠任何东西的 Turn 没有它。`kind`：`carry` 附了交接单，`alone` 这条只发了原话，`plain` 用户要求附上而没有可附的内容。`by`：`need`（按欠交，普通路径）、`policy`（策略）、`user`（用户的选择，或设置 `off`）。`cause`：`delivery_unconfirmed`、`history_changed`、`input_limit`、`recovery_failed`、`prepare_failed`（`reason` 说为什么）。`resend`（只在 `carry`）：`auto` 是对没确认的那份自动再附一次、同样的事实再发，`grown` 是为更新的事实发的新包、它也带着上次没确认的内容，`all` 是原生会话可能回退过、整份重发而可能与已有内容重复。页面据此如实说“这条只发了原话”，从不把单发的 Turn 说成已接手。
- Web 的 Run 不带 `relayRequest`（它是用户这次选择的 HMAC，留在网关里）；`message.accepted` 事件里的 `relayRequest` 也去掉 `fingerprint`。用户选了什么看 `decision.by === "user"`。
- 事实流（`GET …/events/stream`）在 `snapshot`、`message`、`run` 之外多一种 `relay` 帧，只通知、不是事实：

```
{ "type": "relay", "sessionId": "session-…", "version": 41, "lastSeq": 41,
  "event": { "type": "relay.input_recorded", "sessionId": "session-…", "runId"?: "run-…", "packetId"?: "relay-…", "at": 1794305941906 } }
```

  事件只有 `relay.input_recorded`（交接单有了送达证据）。这一帧跟在承载它的事实帧后面，同一个 `version` 与 `lastSeq`，SSE 的 `id:` 也相同；按水位应用事实的读者把它当空操作，再去读 `event`。它不含正文、原值与它们的哈希；一个背压中的订阅之后拿到完整快照，不补通知。旧版网页客户端遇到它会判为流协议错误 `STREAM_INVALID_FRAME`：这一帧要与认得它的客户端同时上线。

### 只读接口与设置

`GET …/relay` → `RelayView`：

```
{ "bindings": [ { "harnessId", "controlId", "nativeEpoch", "sync": "fresh"｜"synced"｜"pending",
                  "throughRun": 0 | null, "evidence": "E1"｜"E3" | null, "cleared": 0｜1,
                  "canConfirm"?: true｜false, "owed"?: { "runs": 2, "estTokens": 1700 },
                  "attention"?: { "cause": "delivery_unconfirmed"｜"attach_available", "options": [ "attach_full" ],
                                  "counts": { "runs": 2, "packets": 1 }, "key", "packet"?: 2 } } ],
  "packets":  [ { "packetId", "runId", "runIndex": 1, "number": 1, "kind": "packet"｜"delta", "tier": "full"｜"brief",
                  "target": { "harnessId", "model": null }, "estTokens", "omissions", "redactions",
                  "delivery": "in_flight"｜"recorded"｜"unknown"｜"not_recorded", "evidence": "E1"｜"E3" | null } ],
  "handedOver": [ "codex" ],
  "installation"?: [ { "cause": "key_unavailable", "detail"?: "长度是 33 字节，应为 32 字节" } ] }
```

- `bindings`：会话里每个未归档的原生绑定一行。`sync`：`fresh` 是原生会话里还没有这个对话的任何部分，`synced` 是持有一部分（收到过交接单，或自己跑过一轮而当时没有欠交），`pending` 是发出过交接单而没有确认。`throughRun`：绑定持有的最后一个已结束 Run 在会话 Run 里的序号（从 0 起），没有时为 null；`evidence` 是最近一份已记录交接单的证据。`cleared`：1 表示这个对话在这个 Harness 上被清空过，网关不记次数。`canConfirm`：这个 Harness 做的任何事能不能让网关知道交接单送达了；Driver 不声明时是 false，这是 Harness 的事实，不是故障。`owed`：现在向它交接会带的已结束 Run 数与 token 估算（估算偏高，界面写“约”），什么都不欠时不出现。
- `attention`：这个绑定请用户看一眼的事，**从不拦路，下一条消息照样发出**，按这一刻的状态现算。`delivery_unconfirmed`：发出的交接单 `counts.packets` 份没有确认送达，1 份时下一条自动再附一次，2 份时之后只发原话、有新内容再附；`packet` 是“交接单 #n”的 n。`attach_available`：对话被清空了，之前的部分可以为下一条附上，一次。`options` 只有 `attach_full`，即下一次发送的 `{ attach: "full" }`；永不含“只发原话”，那是下一条输入自己会做的事。`key` 命名一次事件，页面按 key 只提示一次、关掉后不再弹（浏览器里记，后端不存）。
- `packets`：每个带交接单的 Run 一项，按 Run 顺序；`number` 是第几个带交接单的 Run（界面“交接单 #n”），`runIndex` 是这个 Run 在会话 Run 里的序号（从 0 起）；`omissions` 是整项省略的总数，`redactions` 是脱敏计数。没有原生绑定可追踪的 Driver 收到的交接单没有送达行：`delivery` 是 `unknown`、`evidence` 是 null。正文没有存下的交接单不列出，它的序号也空着。
- `handedOver`：这个安装向哪些 Harness 交接过对话（交接记录里有送达行为依据的行，按 Harness 标识）。第一次向某个 Harness 交接时，输入框上方说一句“这条消息会附上之前的对话记录交给 X”，只说一次；在这个列表里的 Harness 不再说。读不出来时给空列表（宁可多说一次）。
- `installation`：安装整体现在做不到的事，只要原因在就一直在。现有一种 `key_unavailable`：接力密钥文件不能用，`detail` 是原因的几个字（不含路径与值）；此时每份要带历史的消息都只发原话。没有问题时不出现。
- 读它不改变会话（`lastSeq`、`version` 都不动）。

`GET|HEAD …/relay/:packetId` → 交接单存储的正文，即发出时的字节（不在返回时复扫）：`Content-Type: text/plain; charset=utf-8`，`ETag: "<正文字节的 sha256>"`，`Cache-Control: private, no-cache`，`X-Content-Type-Options: nosniff`，`Content-Security-Policy: default-src 'none'; sandbox`；`If-None-Match` 命中得 304。本会话没有这份交接单——包括别的会话的、不存在的——一律 404 `RELAY_PACKET_NOT_FOUND`，应答逐字相同；会话不存在 404 `SESSION_NOT_FOUND`。页面判“这个网关没有接力 API”的依据只有一条：读 `GET …/relay` 得 404 且 `code` 为 `NOT_FOUND`（统一的路由缺失）或没有 `code`（或 405、501）。

`GET /api/v1/relay/prefs` → `{ "prefs": { "relay.attach": "auto" } }`；`PUT /api/v1/relay/prefs`，请求体 `{ "key": "relay.attach", "value": "auto"｜"off" }`，成功回 200 与写后的 `{ prefs }`；未知键、越界值、多余或缺少的字段 400 `INVALID_INPUT`，什么都不写。这是安装级设置，只有这一项：`auto`（默认）在换 Harness 后的第一条消息自动附上它没看过的部分，`off` 只发原话（用户仍可逐条 `attach:"full"`）。设置页只露出它。

## 对话的改名、归档与工作区（2026-11-14）

状态：代码完成，合成测试通过（真实 HTTP、真实文件存储、夹具 Harness）；没有真机验证。类型在 `src/contracts/web.ts`（`SessionSummary`、`SessionHeadView`、`SessionChange`、`WorkspaceView`），路由在 `src/web/server.ts`。下文 `…` 仍指 `/api/v1/sessions/:id`。

- 列表行 `SessionSummary` 多了 `updatedAt`（最近一次提交的毫秒时间，列表按它从新到旧）、`activeSince`（进行中的那一轮被受理的时间，没有就不带）、`archived: true`（归档了才带）。对话头 `SessionHeadView` 也带 `archived`、`updatedAt`、`activeSince`。列表照旧返回全部对话，归档的也在，分页不变。
- `PATCH …`，请求体 `{ "title"?: string, "archived"?: boolean }`，至少一个，多余字段 400。标题去首尾空白、换行压成空格，空串 400 `INVALID_INPUT`；用户给的标题此后不再被第一句话算出的标题覆盖（第一轮之前改的也一样）。归档只是列表上的标记，和 `status`（结束会话）无关：归档的对话照样打开、照样发消息，新的一轮被受理时在同一次提交里自动取消归档。返回 200 与改后的 `SessionSummary`。改名、归档各是一次提交（事件 `session.renamed`、`session.archived`），和别的提交一样经事实流的提交帧（带 `head`）到达开着这个对话的页面，`lastSeq` 与 `updatedAt` 随之前移；什么都没变的请求不提交。
- `POST …/reveal`，请求体 `{ "path"?: string }`：不带时在访达里打开工作区文件夹，带时在访达里选中这个文件（相对工作区或绝对路径）。路径取真实路径后必须在工作区里（就是工作区时打开它），否则 400；文件不在 404 `FILE_NOT_FOUND`，工作区不在 404 `WORKSPACE_NOT_FOUND`；非 macOS 409 `REVEAL_UNSUPPORTED`。成功 204。
- `GET …/workspace` → `{ "path": "/…", "git"?: { "branch": "main" | null, "dirty": 3 } }`：工作区在 Git 仓库里时带 `git`，`branch` 在分离头指针时为 null，`dirty` 是 `git status --porcelain` 的条数（含未跟踪）。只读：一次 `git status --porcelain=v2 --branch`，`GIT_OPTIONAL_LOCKS=0`，3 秒没答完或失败就不带 `git`，不报错。

## 对话的置顶、稍后提醒、删除与 Harness 起名（2026-11-14）

状态：代码完成，合成测试通过（真实 HTTP、真实文件存储、夹具 Harness）；没有真机验证，没有真的让 Harness 调 `hub_wrap_up` 带 `title`。

- `SessionSummary` 与 `SessionHeadView` 多了 `pinned: true`（置顶了才带）、`snoozedUntil`（毫秒时间戳，设了稍后提醒才带；到没到由页面判断，网关只存）。
- `PATCH …` 的请求体多接受 `pinned?: boolean`、`snoozedUntil?: number | null`（非负整数毫秒；null 取消）。事件 `session.pinned`、`session.snoozed`。新的一轮被受理时，和取消归档同一次提交清掉 `snoozedUntil`；`pinned` 不清。
- 只改名字和标记的提交（改名、归档、置顶、稍后提醒、Harness 起名、删除与恢复）不动 `updatedAt`：列表的先后和“多久以前”只说对话本身的进展。`updatedSeq`/`lastSeq` 照旧变大，页面靠它发现变化。这类提交写进文件的每一行带 `"marks": true`，重读文件时这些行不推时间，重启后一致。
- `DELETE …` → 204：软删除。从列表消失，除恢复外的所有路由都 404 `SESSION_NOT_FOUND`（读、改、发消息、再删一次）；跨对话搜索也不再找它。有一轮在排队或进行、或有待生效的切换时 409 `SESSION_ACTIVE`（先停下）。它保留着的原生进程按结束对话的同一条路放掉（原因 `conversation_deleted`），放掉记下后才回 204。会话文件留在原处，进“最近删除”（见下一节），彻底删除要用户另点。被它委派出去的子对话不动。删除状态记在头里（`deletedAt`），重启后还在。事件 `session.deleted`。
- `POST …/restore`，请求体 `{}` → 200 与 `SessionSummary`：撤销删除，回到列表里它自己的时间所在的位置。没删的对话原样返回。事件 `session.restored`。
- `hub_wrap_up`（以及命令行 `hub wrap-up … --title T`）多一个可选参数 `title`：这段对话的名字，只在第一轮给。Hub 只在用户没改过名、而且这段对话还没被 Harness 起过名时采用（压空白、截到 80 个 UTF-16 单位），采用后列表和对话头的标题随之更新；这不算用户改的名，用户之后改名照样盖过它。存在头里（`harnessTitle`），重启后还在。事件 `session.titled`。

## 最近删除、彻底删除与页面的搜索（2026-11-14）

状态：代码完成，合成测试通过（`tests/integration/web-server.test.ts` 两条：真实 HTTP、真实文件存储与内容存储、夹具 Harness）；没有真机验证，页面还没接上。类型在 `src/contracts/web.ts`（`DeletedSessionSummary`、`DeletedSessionListView`、`PurgedView`、`SearchHitView`、`SearchView`、`SessionSearchHitView`、`SessionSearchView`），路由在 `src/web/recall-routes.ts`，搜索在 `src/web/message-search.ts`。

- `GET /api/v1/sessions/deleted?before=<cursor>&limit=` → `{ sessions: [SessionSummary + deletedAt], next }`：软删除的对话，新删的在前；页大小同列表（默认 100，`limit` 没有上限），`next` 为 null 时到头。坏的 `before` 400。
- `POST /api/v1/sessions/:id/purge`，请求体 `{}` → 204：彻底删除一段已软删除的对话；没软删的 409 `DELETION_REQUIRED`（先删除），不存在的 404，还留着原生进程的先放掉，放不掉 409 `SESSION_ACTIVE`。删掉的：会话文件和它旁边的 WIP 日志、事件日志、折叠缓存（先整体挪进 `trash/purged-<随机>/`，主文件最先挪，挪走那一刻起它就不在了，然后删掉这个文件夹；删不掉的留给下一次彻底删除清理），列表索引行和建立键；只有它提到、别的对话（含其他已删除的）都没提到的内容记录、`content/files/<id>/` 副本和不再有记录用的 blob（读不了某个别的对话时一个内容都不删）；记录目录里它自己的那份 `context/<任务>/<它的标签>/`，任务里没有别的对话时整个任务目录。它是被委派出来的时，它下面那些子对话的目录也一并删掉（它们的链断在它这里，此后自成一个任务，下次需要时在以它命名的新任务目录里重写）。不删：被它委派出去的子对话（`parent` 指向一个不存在的对话；列表、对话头、`…/task` 照常读，任务板从链上还在的最高一段起算）、无文件夹对话的 `chats/` 工作区、Harness 自己保存的原生会话。之后再读、恢复、再删都是 404，重启后也不在。
- `POST /api/v1/sessions/purge-deleted`，请求体 `{}` → `{ "purged": n }`：把最近删除里的全部彻底删除；不能删的（刚被恢复、进程放不掉）跳过。不做定时自动清空。
- `GET /api/v1/search?q=&cursor=&limit=` → `{ hits, next }`：在所有未删除对话的标题、用户的话、Harness 的回复（已结束的消息；不搜工具输出）里找，大小写不敏感（Unicode 大小写折叠），按原样子串匹配（中文不用分词）。按对话分组，对话按最近活动从新到旧；每段先是标题命中，再是消息命中（从新到旧）。一条消息一个命中（它第一处）。每条：`sessionId`、`title`、`runId`、`ordinal`、`messageId`（条目在那一轮里的 `id`，即 `WireItem.id`）、`role`（`user`｜`assistant`｜`title`；标题命中的 `runId`/`ordinal`/`messageId` 为 null）、`snippet`（命中处前约 32、后约 80 个 UTF-16 单位，换行变空格，截断处加“…”）、`match: [start, end)`（在 `snippet` 里的 UTF-16 下标）。默认一页 50，没有总数上限。空查询 400。
- `GET /api/v1/sessions/:id/search?q=&cursor=&limit=` → `{ hits, next }`：只在这段对话的消息里，每一处都给，从第一轮到最新（按轮、轮内按条目顺序、条目内按位置）；每条多 `itemSeq`（条目的 seq，`GET …/runs/:ordinal/items/:itemSeq` 读得到）和 `offset`（命中在那条消息全文里的起点，UTF-16 下标，与页面拿到的文字一致）。删除了的对话 404。
- 没有索引：两者都用 `hub_search` 用的同一个文件扫描（跨对话从每个文件尾往前读，凑够一页就停；单个对话按轮读它的字节段，不进轮次缓存）。实测（本机，合成数据 101 MB：一段 5000 轮 + 300 段各 20 轮，每轮约 2 KB 回复和一次工具调用）：生僻词要读完全部文件，跨对话约 95 ms（冷启动后第一次约 180 ms，含读入各对话的折叠），单段 5000 轮约 90 ms；常见词第一页 1 ms 以内。耗时随文件总量线性增长，主要花在逐行 `JSON.parse` 条目行（工具条目行也解析）；要更快可以先在原始行上筛（查询不含引号、反斜杠和控制字符时，行里没有就不解析），再不够才做索引。

## 在编辑器里打开、读文件、Git 明细、提交与推送（2026-11-14）

状态：代码完成，合成测试通过（真实 HTTP、临时目录里 `git init` 的仓库、本地裸仓库当远端、测试自己的 Git 配置）；没有真机验证，测试里从没真的打开过编辑器。类型在 `src/contracts/web.ts`（`EditorView`、`EditorsView`、`WorkspaceFileView`、`GitView`、`GitFileView`、`GitCommitView`、`GitPushView`），实现在 `src/infrastructure/workspace/`（`place.ts` 是共用的路径判断，访达也改用它）。路径一律先取真实路径，必须是工作区或在工作区里（`..`、别处的绝对路径、指向外面的链接都 400）。删除了的对话这些路由都 404。

- `GET /api/v1/editors` → `{ "editors": [{ "id": "vscode", "name": "VS Code" }, …] }`：`/Applications`、`~/Applications` 里有应用包的才列，每次现查。认得的 id：`vscode`、`cursor`、`windsurf`、`zed`、`sublime`、`xcode`、`nova`、`textmate`、`intellij`、`webstorm`、`pycharm`、`goland`、`rustrover`。
- `POST …/open`，请求体 `{ "editor": string, "path"?: string }` → 204：`open -a <找到的应用包> <工作区或文件>`（`execFile`，不经 shell）。依次检查：不认识的编辑器 400，路径越界 400、不在 404 `FILE_NOT_FOUND`，没装 404 `EDITOR_NOT_FOUND`；都过了才打开。
- `GET …/file?path=<相对或绝对>&offset=<字节>` → `{ path（相对工作区）, size, offset, text, next }`，一页最多 256 KiB，在 UTF-8 字符之间切开；`next` 是下一页的起始字节，读完为 null；`offset` 落在字符中间时从下一个字符起（回答里的 `offset` 是实际起点），超出文件长度 400。前 8 KiB 里有 NUL 的返回 `{ path, size, binary: true }`，不读内容。目录 400，不在 404。只读，打开时不阻塞（FIFO 之类直接 400）。
- `GET …/git` → `{ branch: string | null, upstream?: { name, ahead, behind }, remote: boolean, files: [{ path, from?, index, worktree, added?, removed? }] }`。`git status --porcelain=v2 --branch --untracked-files=all -z` 加 `git diff --numstat -z HEAD`（第一次提交之前对空树比）；`index`/`worktree` 是 porcelain v2 的字母，`.` 表示没变，未跟踪文件是 `?`/`?` 且没有行数，二进制文件也没有行数；改名带 `from`。工作区在仓库的子目录里时只看这个子目录（pathspec `.`），路径都相对工作区。不在仓库里 404 `NOT_A_REPOSITORY`。只读的几条带 `GIT_OPTIONAL_LOCKS=0`。
- `POST …/git/commit`，请求体 `{ "message": string, "paths"?: string[] }` → `{ commit（短哈希）, subject }`。给了 `paths`（相对或绝对、都在工作区里，工作区里已删掉的文件也可以点名）就 `git add -A -- <paths>` 再 `git commit -m <message> -- <paths>`，只提交这几项，别的已暂存内容原样留着；没给就 `git add -A` 再 `git commit -m`（子目录工作区是 pathspec `.`）。pathspec 按字面（`--literal-pathspecs`）。空说明、空的 `paths` 数组 400。没有可提交的 409 `GIT_NOTHING_TO_COMMIT`；钩子失败、没配身份等 409 `GIT_COMMIT_FAILED`；`message` 都是 git 自己的话（太长时掐掉中间，开头和结尾都留）。提交最多给 5 分钟（钩子可能跑检查）。
- `POST …/git/push`，请求体 `{}` → `{ remote, branch }`。有上游 `git push`；没有上游但有 `origin` 就 `git push -u origin <当前分支>`；都没有 409 `GIT_NO_REMOTE`；分离头指针 409 `GIT_DETACHED_HEAD`；git 拒绝或 60 秒没完成 409 `GIT_PUSH_FAILED`，带 git 的话。
- 所有 git 都是 `spawn` 参数数组、不经 shell，stdin 关着，`GIT_TERMINAL_PROMPT=0`，并且在自己的进程会话里跑（没有控制终端，ssh 也问不了密码），超时连同子进程组一起杀掉。提交和推送只在用户点了按钮时由页面调用，网关不自己触发。`code` 以 `GIT_` 开头的一律 409。

### 改动面板的范围：未提交、某次提交、相对分支（2026-11-14）

状态：代码完成，合成测试通过（`tests/integration/web-server.test.ts` 里“changes panel”一条：真实 HTTP、临时仓库、测试自己的 Git 配置）；页面还没接上，没有真机验证。类型在 `src/contracts/web.ts`（`GitScope`、`GitChangedFileView`、`GitChangesView`、`GitFileDiffView`、`GitLogView`、`GitCommitEntryView`、`GitBranchesView`），实现在 `src/infrastructure/workspace/git.ts`。全部只读（`GIT_OPTIONAL_LOCKS=0`，不刷新索引、不写对象）；工作区在仓库子目录里时只看这个子目录，路径都相对工作区（`git diff --relative`，git 在工作区里跑）。用户的 Git 配置照常生效，只是去掉会改输出的几样：`--no-color --no-ext-diff --no-textconv`，补丁两边固定 `a/`、`b/`，路径不做八进制转义；改名检测固定开（`-M`）。

- 范围（查询参数）：`scope=uncommitted`（缺省）是工作区相对 HEAD（已暂存和未暂存合在一起，加上逐个列出的未跟踪文件；还没有提交时相对空树）；`scope=commit&sha=<提交>` 是这次提交相对它的第一个父提交（根提交相对空树）；`scope=branch[&base=<分支>]` 是 `merge-base(<base>, HEAD)` 到工作区现在的内容（含未提交和未跟踪）。`base` 缺省时用默认分支：`origin/HEAD` 指向的（写作 `origin/main`），没有就 `main`，再没有 `master`，都没有 400。`sha`、`base` 先过 `git rev-parse --verify <x>^{commit}`，不是这个仓库里的提交 400；以 `-` 开头或带控制字符的直接 400。`uncommitted` 带 `sha`/`base`、`commit` 不带 `sha` 都 400。没有共同祖先 409 `GIT_NO_MERGE_BASE`，当前分支还没有提交时比分支 409 `GIT_NO_COMMITS`。`whitespace=ignore` 让行数和差异文本按 `-w` 算，不影响文件列表；别的值 400。
- `GET …/git/changes?scope=…` → `{ scope, files: [{ path, oldPath?, status, added?, removed?, binary? }], base?: { ref, sha }, commit?: { sha, parent } }`。`status` 是 `added`/`modified`/`deleted`/`renamed`/`copied`/`typechange`/`untracked`（git 的 U、X 记作 `modified`）。行数来自 `git diff --numstat`；二进制文件不带行数、带 `binary: true`；`-w` 下只改了空白的文件仍列出，行数 0 和 0。未跟踪文件（不含忽略的，`git ls-files --others --exclude-standard`）的行数网关自己数：全部算新增（换行数，最后一行没有换行再加一），前 8000 字节里有 NUL 算二进制，链接算一行；嵌套仓库是一条以 `/` 结尾、不带行数的。按路径排序。`base` 只在 `branch` 有（`ref` 是用的分支名，`sha` 是 merge-base），`commit` 只在 `commit` 有（完整 sha 和第一个父提交，根提交为 null）。
- `GET …/git/diff?scope=…&path=<文件>[&whitespace=ignore]` → `{ path, diff, binary? }`：这个文件在这个范围里的统一差异。`path` 相对或绝对、必须在工作区里（越界 400），工作区里已删掉的也可以。改名的带上原路径一起比（`rename from`/`rename to`）；未跟踪文件给成新文件的差异（`git diff --no-index /dev/null <文件>`，`--- /dev/null`）；这个范围里没变的给 `""`。二进制文件是 git 那一行 `Binary files … differ` 加 `binary: true`。差异不设长度上限：边读 git 边写进应答（分块传输），不在内存里拼整段；git 一开始就失败的照常 409，写出一部分后才失败或超过 5 分钟的直接断开连接（页面拿到的是失败，不是看似完整的半截）。页面断开时 git 被杀掉。
- `GET …/git/log?before=<sha>&limit=<n>` → `{ commits: [{ sha, shortSha, subject, author, committedAt（毫秒） }], next }`：当前分支的提交，按 `git log` 的顺序从新到旧；子目录工作区只列碰过这个子目录的提交。`limit` 缺省 50；`before` 是上一页最后一条（即上一页的 `next`），`next` 为 null 表示没有了。`before` 不是提交 400，不在当前分支的历史里（分支变了）409 `GIT_HISTORY_CHANGED`，从第一页重读。还没有提交时是空页。
- `GET …/git/branches` → `{ current, local, remote, defaultBranch }`：本地分支和远端跟踪分支（不含 `origin/HEAD` 这种符号引用）的名字，最近提交的在前；`current` 分离头指针时为 null；`defaultBranch` 按上面的规则推测，没有为 null。

## 对话的终端（2026-11-14）

状态：代码完成，合成测试通过（`tests/integration/terminal.test.ts`：真实网关、真实 WebSocket、真实 zsh 与伪终端，用临时 HOME 隔开用户的 shell 配置）；页面还没接上，没有真机验证。伪终端在 `src/infrastructure/workspace/terminal.ts`（node-pty），连接在 `src/infrastructure/workspace/terminal-socket.ts`（ws），路由在 `src/web/server.ts`。

`GET /api/v1/sessions/:id/terminal?cols=80&rows=24`，升级成 WebSocket（页面用 `GatewayApi.terminalUrl(id, cols, rows)` 拼地址）。一个连接一个 shell：用户的登录 shell（`$SHELL -l`，不是可执行文件时用 `/bin/zsh -l`）挂在一个伪终端上，起在对话的工作区里，能跑 `vim`、`top` 这类全屏程序。环境是网关给登录 shell 的那一套（`HOME USER LOGNAME LANG TMPDIR`，没有 `LANG` 时补 `en_US.UTF-8`），加 `SHELL`、`TERM=xterm-256color`、`COLORTERM=truecolor` 和 login(1) 的起始 `PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`），其余由 shell 自己的登录配置设。

- 放行：`Host` 必须是网关自己的；`Origin` **必须**等于网关自己的来源（不带也拒），否则 403 `ORIGIN_REJECTED`；没有或过期的登录 401 `AUTH_REQUIRED`（登录 cookie 照常续期，需要时随握手应答发回）；对话不存在或已删除 404；`cols`/`rows` 不是 1–65535 的整数、或带了别的参数 400 `INVALID_INPUT`（不带时 80×24）；工作区文件夹不在 409 `WORKSPACE_UNAVAILABLE`；网关正在关闭 503。拒绝都是普通 HTTP 应答，体为 `{ code, message }`。别的路径的升级请求 404。
- 帧都是 JSON 文本帧。页面发 `{ "type": "input", "data": string }`（原样写进终端）、`{ "type": "resize", "cols": number, "rows": number }`；认不出的帧、二进制帧忽略。网关发 `{ "type": "output", "data": string }`（伪终端的输出，按 UTF-8 流式解码，跨块的多字节字符完整到达）和 shell 退出后的一条 `{ "type": "exit", "code": number | null }`（被信号结束时为 null，shell 没能起来也发 `code: null` 并以 1011 关闭），随后以 1000 关闭连接。
- 背压：发出未写完的输出超过 1 MiB 就暂停读伪终端（shell 的写随之阻塞），降到 256 KiB 以下再读；不丢输出。
- 结束：连接断开就挂断终端——shell 和终端上其他进程（后台作业、前台全屏程序）收到 SIGHUP（用 nohup 起的会忽略它），shell 每 200 毫秒再收一次直到退出，2 秒后还在就 SIGKILL 它和它的进程组。网关关闭时先这样结束所有终端、等 shell 退出，再关监听。
