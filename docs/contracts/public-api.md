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

## 速度：标准 / 快（2026-11-14）

状态：代码完成，合成测试通过（`tests/protocol/speed.test.ts`：映射、夹具 Codex app-server、夹具 claude-agent-acp）。真机：Codex 0.166.0 一轮（gpt-5.6-luna，用户配置是 `service_tier = "priority"`，选“标准”时发了 `serviceTier: "default"`、线程回报 `default`、这一轮完成；新进程不给速度续上这个线程，回报仍是 `default`，即线程记住自己的档）；Claude Code（claude-agent-acp 0.99.1）只开了会话、没发提示：Opus 5.5 上 `fast` 由 `off` 设成 `on`（本机列出 `fast` 的只有 Opus 5.5、Opus 5、Opus 4.8；Haiku、Sonnet、Fable、Opus 4.7/4.6 和“Default”都没有）；快速模式下真跑一轮没验（Opus 快速模式按额外用量计费）。两家的配置文件前后哈希不变。

- 原生选项里多一个 Hub 的键 `hub_speed`（和 `hub_permission`、`hub_effort` 一样随对话的 `nativeOptions` 保存，Driver 拿不到 `hub_` 键）：`standard`，或更快的档 `fast`（Harness 还报了别的档时用它自己的档名）。`GET /api/v1/harnesses/:id/models` 的 `flavor.speed` 说这一家怎么做（`option` 是目录里哪个原生选项、`standard` 是哪个原生值、`names` 是原生值到 Hub 名字），页面用 `contracts/flavor.ts` 的 `nativeLevels(flavor, options)` 读出 `speed`（`standard` 在前，每档带原生值，`note` 是 Harness 自己对这一档的说法，如 “Fast · 1.5x speed, increased usage”）、`speedOwn`（不选时 Harness 按自己的设置跑哪一档）和 `speedMissing`。只有模型真有更快的档时 `speed` 才非空，别的模型、别的 Harness 不列。
- Codex：每个模型的目录选项里多了 `service_tier`（`速度`，分类 `speed`），来自 `model/list` 的 `serviceTiers`（旧的 `additionalSpeedTiers` 兜底），值是 `default`（标准）和各档 id（现在只有 `priority`，即 Fast）；当前值是用户配置的 `service_tier`（`fast` 视作 `priority`），否则模型的 `defaultServiceTier`，否则 `default`。打开线程时作为 `thread/start` / `thread/resume` 的 `serviceTier` 传，只对这个线程有效、从不写 `config.toml`；线程回报的档和要的不一样就 `NATIVE_OPTION_MISMATCH`（Codex 对不认识的档回报 null，不报错）。
- Claude Code：claude-agent-acp 的会话选项 `fast`（`on`/`off`，分类 `model_config`），只在会话的模型 `supportsFastMode` 时出现；用 `session/set_config_option` 设，适配器调 SDK 的 `applyFlagSettings({ fastMode })`，只改这个会话的旗标层，不写设置文件。
- 什么时候传：新会话里所选的档就是 Harness 按自己设置会跑的档时什么都不传（“标准”在默认配置下就是不传）；不一样时才传——例如用户的 Codex 配置是 priority、在 Hub 里选“标准”，就传 `default`，否则会谎报。续上的会话（换了选择后新起进程恢复）总是明确传所选的档，因为 Codex 线程会记住上一轮给它的档。选了模型没有的档：什么都不传，按模型自己的跑。不选（没有 `hub_speed`）：一律不传。

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
- 置顶的先后（拖动排序）：`SessionSummary` 与 `SessionHeadView` 多了 `pinnedOrder`（只和 `pinned` 一起出现，小的在前，任意有限数）。`PATCH …` 接受 `pinnedOrder: number`：给已置顶的对话换位置（页面拖到两条之间时可取两者的中间值），或与 `pinned: true` 同给、置顶到指定位置。只给 `pinned: true` 不给位置：没置顶的排到所有置顶的最前（比其他置顶对话里最小的再小 1，没有就是 0），已置顶的留在原位。`pinned: false` 去掉位置，且不能同时给 `pinnedOrder`（400）；不是有限数 400；给没置顶、这次也不置顶的对话位置 409 `PIN_REQUIRED`（页面的列表过时了，重读这一行）。换位置和置顶一样只是标记，不动 `updatedAt`；事件 `session.pinned` 带上 `order`。2026-11-14 之前置顶的对话没有 `pinnedOrder`，页面把它们排在有位置的后面。重启后还在（头与列表缓存里）。合成测试通过（`session-runtime.test.ts`、`web-server.test.ts` 各一条）；页面的拖动还没接，没真机验证。
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

### 检查点、还原文件与拉取请求（2026-11-14）

状态：代码完成，合成测试通过（`tests/integration/checkpoints.test.ts`：真实网关和存储、临时目录里的真实 Git 与测试自己的 Git 配置、一个按提示改文件的 ACP 测试 Harness、本地裸仓库当远端、PATH 最前面的假 gh；从不连 GitHub，没建过真的拉取请求）；页面还没接上，没有真机验证。类型在 `src/contracts/web.ts`（`GitTurnScope`、`GitTurnCompared`、`CheckpointView`、`CheckpointListView`、`CheckpointRestoreView`、`GhState`、`GitPullRequestView`、`GitPullRequestStatusView`、`GitPullRequestCreatedView`），端口在 `src/contracts/workspace.ts`（`WorkspaceCheckpoints`、`WorkspaceOwnership`），实现在 `src/infrastructure/workspace/checkpoints.ts`、`pull-request.ts`，路由在 `src/web/checkpoint-routes.ts`。删除了的对话这些路由都 404。

- 检查点：工作区在 Git 仓库里时，每一轮开始前和结束后（不论怎么结束）网关把整个工作树（仓库顶层起，已暂存、未暂存、未跟踪的都算，`.gitignore` 忽略的不算）存成一个提交，只由网关自己的引用指着：`refs/harnesshub/checkpoints/<sessionId>/<ordinal>/before|after`（`ordinal` 从 0 起）。做法：临时索引（`GIT_INDEX_FILE` 指向临时目录里用户索引的一份拷贝，保留原索引的时间；没有索引时 `git read-tree HEAD`）、`git add -A -- .`、`git write-tree`、`git commit-tree --no-gpg-sign <tree> [-p HEAD] -m "HarnessHub checkpoint"`（作者和提交者都是 `HarnessHub <hub@localhost>`），最后 `git update-ref --stdin` 一次写好。用户的索引、HEAD、分支都不动。`before` 在这一轮准备时开始取，提示送给 Harness 之前等它；一次取用 5 秒没完成就放弃（连同进程组结束 git），这一轮不再等它、也不留引用；失败只写网关的 stderr（`CHECKPOINT_NOT_KEPT`），不影响这一轮。从某一轮分支重来的新一轮占同一个 `ordinal`：它的 `before` 替换原来的，原来那一轮的 `after` 同时删掉。对话彻底删除（`…/purge`、`purge-deleted`）时它在这个仓库里的 `refs/harnesshub/checkpoints/<sessionId>/` 全部删掉。不在仓库里的工作区什么都不做。
- `GET …/checkpoints?before=<ordinal>&limit=<n>` → `{ checkpoints: [{ ordinal, before?, after? }], next, restorable }`：有检查点的轮次，新的在前；`limit` 缺省 50、没有上限；`next` 是下一页的 `before`，null 表示没有了。`restorable` 是这段对话能不能还原文件（见下）。工作区不在仓库里时是空列表、`restorable: false`。
- 这一轮改了什么：`GET …/git/changes?scope=turn&ordinal=<n>[&whitespace=ignore]` 和 `GET …/git/diff?scope=turn&ordinal=<n>&path=<文件>`，应答同上面的范围（`scope: "turn"`，另带 `turn: { ordinal, before, after }`）。比的是这一轮的 `before` 和 `after`；这一轮还在跑、或没留下 `after` 时，和工作树现在的样子比（把现在的工作树也存成一棵树再比，所以开始前就未跟踪的文件按原样比，不会显示成删除），`after` 为 null。没有 `before` 404 `CHECKPOINT_MISSING`；`ordinal` 不是从 0 起的整数、带了别的参数 400。
- 还原文件（“从这里重来”带文件）：`POST …/checkpoints/:ordinal/restore`，请求体 `{}` → `{ restoredTo, savedAs }`。先把现在的工作树存成 `refs/harnesshub/checkpoints/<sessionId>/restore-<毫秒时间>`（`savedAs`，存不下就不还原，409 `GIT_RESTORE_FAILED`），再在仓库顶层 `git restore --source=<before> --worktree --staged -- .` 和 `git clean -fd -- .`（不带 `-x`：忽略的文件留着）。`restoredTo` 是 `before` 的提交。拒绝：这段对话不在自己独占的工作树里 409 `WORKTREE_REQUIRED`（“只有在这段对话自己的工作树里才能还原文件”），有一轮还没结束 409 `SESSION_ACTIVE`，没有 `before` 404 `CHECKPOINT_MISSING`，git 拒绝 409 `GIT_RESTORE_FAILED`（带 git 的话和存下的引用名）。按这个顺序检查。索引也回到 `before` 的样子。
- 拉取请求：只在用户按了按钮时由页面调用。`gh` 在网关的 PATH 和登录 shell 的目录里找。`GET …/git/pr` → `{ gh: "missing" | "signed-out" | "ready", branch, defaultBranch, remote?: { name, url, github }, upstream?, ahead, unpushed, existing?: { url, number, title, state } }`：`gh auth status`（远端是 GitHub 时带 `--hostname`）判断登录，`gh pr view <分支> --json url,number,title,state` 找已有的；`remote` 是分支上游所在的远端，没有就 `origin`（和推送一致），URL 去掉其中的用户名和密码；`github` 看主机是不是 github.com（或 `*.ghe.com`）；`defaultBranch` 是 `refs/remotes/<远端>/HEAD` 指的分支，没有就 `main`、再 `master`；`ahead` 是不在默认分支上的提交数；`unpushed` 有上游时是不在上游的提交数，没有上游时是不在任何远端跟踪分支上的提交数。
- `POST …/git/pr`，请求体 `{ title, body, base? }` → `{ url, number }`。分支没有上游或领先上游时先推送（同 `…/git/push`），再 `gh pr create --title … --body … --base <base 或默认分支> --head <分支>`。拒绝：分离头指针 409 `GIT_DETACHED_HEAD`；就在默认分支上、或 `base` 就是当前分支 409 `GIT_PR_ON_DEFAULT_BRANCH`；找不到 gh 409 `GH_UNAVAILABLE`；gh 没登录 409 `GH_AUTH_REQUIRED`（这几种都不推送）；推送失败 409 `GIT_PUSH_FAILED`；gh 拒绝或 75 秒没完成 409 `GIT_PR_FAILED`，带 gh 的话；没有标题、`body` 不是字符串、多余字段、找不到默认分支又没给 `base` 都 400。gh 在自己的进程会话里跑，stdin 关着，`GH_PROMPT_DISABLED=1`、`GIT_TERMINAL_PROMPT=0`。

## 对话自己的 Git 工作树（2026-11-14）

状态：代码完成，合成测试通过（`tests/integration/worktree.test.ts` 六条：真实 HTTP、真实文件存储、临时目录里的真实 Git 仓库和工作树、测试自己的 Git 配置、夹具 Harness；`web-server.test.ts` 照旧全过）；页面还没接上，没有真机验证，子模块那一步没有测到。类型在 `src/contracts/web.ts`（`CreateWebSession.worktree`、`WorktreeMark`、`WorktreeView`、`PurgeSessionView`、`PurgedView`）与 `src/contracts/session.ts`（`ConversationWorktree`），Git 在 `src/infrastructure/workspace/worktree.ts`，路由与改分支名在 `src/web/worktree-routes.ts`。默认不变：不带 `worktree` 的对话照旧在文件夹原地工作，已有的对话一概不动。

- `POST /api/v1/sessions`，请求体多接受 `"worktree": true`，必须和 `workspace` 一起给（不带 `workspace`、和 `scratch` 一起、不是 `true` 都 400）。`workspace` 不在 Git 仓库里 400 `INVALID_INPUT`；仓库还没有提交 409 `GIT_NO_COMMITS`。网关在 `workspace` 所在的检出里 `git worktree add -b hh/<8 位十六进制> <路径> <HEAD 的提交>`，8 位是 sha256(commandId) 的前 8 位；路径是 `<工作树根>/<主检出的文件夹名>/hh-<8 位>`（就是临时分支名当文件夹名，没再重复一遍 8 位）。有 `.gitmodules` 时接着 `git submodule update --init --recursive`，失败只记日志、工作树照用。`workspace` 是仓库里的子目录时，对话的工作区是工作树里同一个子目录（只有主检出才有的未提交目录会建出来）。回 201 与对话（同不带 `worktree` 时）。
- 工作树根：命令行 `--worktree-dir <目录>`，默认在 `--scratch-dir` 旁边的 `worktrees`（即 `~/HarnessHub/worktrees`）；`startWebServer` 的 `worktreeRoot` 选项，不给时在 scratch 根旁边。
- 幂等：同一个 `commandId` 再来一次（包括两条同时到）回同一段对话，不建第二个工作树——先在同一把按请求的锁里找这条请求建过的对话，找到就不跑 Git。位置上已经是这个仓库在 `hh/<8 位>` 上的工作树（上次建了工作树、对话没建成）就直接用；位置上有别的东西 409 `GIT_WORKTREE_PATH_TAKEN`。工作树是这次新建的、对话却没建成（比如 Harness 不可用）时，把工作树收回（`git worktree remove --force`，分支还停在起点就删掉）。
- 对话头 `SessionHeadView` 和列表行 `SessionSummary` 多了 `worktree?: { root, path, branch, baseSha }`：`root` 是仓库主检出的顶层（页面按它分组），`path` 工作树顶层，`branch` 记下的分支名，`baseSha` 起点提交，都是真实路径。随对话存在头里（会话文件的 `head` 行、列表索引），重启后还在；最近删除的行也带。归档、软删除都不碰工作树。从它委派出去的子对话、从它分出的分支对话工作区在同一个工作树里，但不带 `worktree`（`GET …/worktree` 对它们 404）。
- 分支改名：对话第一次有了标题——用户改名、Harness 在 `hub_wrap_up` 给的 `title`、或第一条消息算出的标题（`conversationTitle`，通常就是它）——就在工作树里 `git branch -m hh/<8 位> hh/<标题 slug>`，只改这一次，而且只在分支还叫临时名、没有上游时改。slug：任何文字的字母、组合符号和数字保留（中文照留），其余连续的字符变成一个 `-`，去掉两头的 `-`，ASCII 字母转小写，最多 48 个 UTF-16 单位（不切半个字符），还要过 `git check-ref-format --branch`；重名依次加 `-2`、`-3`…。没有字母数字、名字 Git 不收、改名失败都保留临时名，只记日志，不再重试。工作树已经在别的分支上（有人自己改了名或切了分支）就把那个分支记下来。改名在提交发布之后异步做，做完用一次只改标记的提交记下新名（事件 `session.worktree_branch`，`{ from, to }`，不动 `updatedAt`），经事实流的 `head` 到达页面。
- `GET /api/v1/sessions/:id/worktree` → `{ path, branch, dirty, shared, missing? }`：`branch` 是工作树里现在检出的分支（分离头指针为 null），`dirty` 是未提交的文件数（`git status --porcelain=v2 --untracked-files=all` 的条数，未跟踪的逐个算），`shared` 是有没有别的、没被彻底删除的对话（含软删除的）的工作区在这个工作树里（比如委派出去的子对话），`missing: true` 是工作树文件夹已经不在了（这时 `branch` 是记下的名字、`dirty` 为 0）。软删除的对话也回答（页面在“最近删除”里彻底删除前要问）；对话没有工作树 404 `WORKTREE_NOT_FOUND`，对话不存在 404。只读，`GIT_OPTIONAL_LOCKS=0`；git 答不出来 409 `GIT_FAILED`。
- 彻底删除多一个可选请求体 `{ "removeWorktree": true }`（`false` 或不带同 `{}`；别的键、不是布尔值 400）。`POST /api/v1/sessions/:id/purge`：对话照旧彻底删除，之后如果它的工作树没有别的剩下的对话（含软删除的）在用，就在主检出里 `git worktree remove --force <路径>`（未提交、未跟踪的文件一起删）再 `git worktree prune`；分支留着，上面的提交仍然可达。只删这个仓库登记的、不是主检出的工作树；文件夹已经不在的只 prune。带了这个键回 200 `PurgeSessionView`：`{ worktreeRemoved: true }`（工作树不在了），`{ worktreeKept: "shared" }`，`{ worktreeKept: "failed", worktreeError: <git 的话> }`（对话已经删了，工作树没删掉，比如被锁住、仓库不在了），对话本来没有工作树就是 `{}`；不带时照旧 204、工作树不动。`POST /api/v1/sessions/purge-deleted` 带它时回 `{ purged, worktreesRemoved, worktreeFailures? }`。
- 原有的 Git 接口（`…/git`、`…/git/commit|push|changes|diff|log|branches`、`…/workspace`）在工作树里照常工作：git 在工作区里跑，工作树的 `.git` 是文件、`--git-common-dir` 和 `--git-dir` 不同都不影响；子目录工作区只看自己。已经在测试里核对过，代码没改。所有 git 调用同前：不经 shell、不问密码（`GIT_TERMINAL_PROMPT=0`、没有控制终端）、只读的不拿可选锁，失败带 git 自己的话。

## 对话的终端（2026-11-14）

状态：代码完成，合成测试通过（`tests/integration/terminal.test.ts`：真实网关、真实 HTTP 与 WebSocket、真实 zsh 与 node-pty 伪终端、临时数据目录，用临时 HOME 隔开用户的 shell 配置）；页面还没接上新接口（终端抽屉在重写），没有真机验证。伪终端在 `src/infrastructure/workspace/terminal.ts`，终端、历史文件和连接在 `src/infrastructure/workspace/terminals.ts`，路由在 `src/web/terminal-routes.ts`，类型在 `src/contracts/terminal.ts`，页面方法在 `web/src/api.ts`（`terminals`、`openTerminal`、`renameTerminal`、`closeTerminal`、`terminalSocketUrl`）。

终端不跟着连接走（学 T3 Code）：打开一个终端就起一个 shell，它一直跑到被关掉、对话被删除或网关关闭；连接只是挂上去看和打字，断开只是摘下来。一个对话可以有任意多个终端。shell 是用户的登录 shell（`$SHELL -l`，不是可执行文件时用 `/bin/zsh -l`），挂在一个伪终端上，起在对话的工作区里，能跑 `vim`、`top` 这类全屏程序。环境是网关给登录 shell 的那一套（`HOME USER LOGNAME LANG TMPDIR`，没有 `LANG` 时补 `en_US.UTF-8`），加 `SHELL`、`TERM=xterm-256color`、`COLORTERM=truecolor` 和 login(1) 的起始 `PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`），其余由 shell 自己的登录配置设。

- `GET /api/v1/sessions/:id/terminals` → `{ terminals: [{ id, title, createdAt（毫秒）, exited?: { code: number | null, signal: string | null } }] }`，先开的在前。shell 已经结束的带 `exited`（被信号结束时 `code` 为 null、`signal` 是信号名如 `SIGKILL`；自己退出时 `signal` 为 null），一直列着直到被关掉。
- `POST /api/v1/sessions/:id/terminals`，请求体 `{ cols, rows, title? }` → 201 `{ id, title, createdAt }`：shell 起来了才应答。`cols`/`rows` 是 1–65535 的整数；`title` 去掉两头空白后不能为空、不能有控制字符，不给时是“终端 N”，N 取这个对话现有终端没占用的最小正整数（关掉“终端 2”后下一个又是“终端 2”）。`id` 形如 `terminal-<24 位十六进制>`。工作区文件夹不在 409 `WORKSPACE_UNAVAILABLE`；shell 起不来 502 `TERMINAL_START_FAILED`；网关正在关闭 503。
- `PATCH /api/v1/sessions/:id/terminals/:tid`，请求体 `{ title }` → 200，这个终端在列表里的样子。标题规则同上。
- `DELETE /api/v1/sessions/:id/terminals/:tid` → 204：先从列表里拿掉（不能再挂上），给 shell 发 SIGTERM，同时像关掉终端窗口那样挂断——shell 和终端上其他进程（后台作业、前台全屏程序）收到 SIGHUP（用 nohup 起的会忽略它）。交互式 zsh、bash 不理 SIGTERM（实测），所以两样一起发；每 200 毫秒再发一次，1 秒后 shell 还在就 SIGKILL 它和它的进程组。shell 结束（或 SIGKILL 后再等 2 秒）后，挂着的连接收到 `exit` 并以 1000 关闭，历史文件删掉，才应答。
- 都要登录 cookie；写（POST、PATCH、DELETE）照常要同源 `Origin` 和 `X-CSRF-Token`。对话不存在或已删除 404 `SESSION_NOT_FOUND`；不是这个对话的终端 404 `TERMINAL_NOT_FOUND`；请求体或参数不对 400 `INVALID_INPUT`。
- 历史：shell 打印的每个字节按到达顺序追加进网关数据目录里的 `terminals/<对话 id>/<终端 id>.log`（文件 0600、目录 0700），不设长度上限。写文件落后超过 1 MiB 就暂停读伪终端（shell 的写随之阻塞），追到 256 KiB 以下再读；写失败每秒重试，不跳过任何输出。终端关掉时删它的历史；对话删除时连目录一起删。shell 不会比网关活得久：网关启动时（拿到数据目录之后、开始监听之前）先删掉整个 `terminals` 目录里上一个网关留下的东西。
- 对话删除（进“最近删除”）就关掉它的所有终端（彻底删除只对已删除的对话，所以也覆盖了）；恢复回来的对话没有终端。归档不影响终端。网关的 `close()` 先这样结束所有终端、等 shell 退出、删掉历史，再关监听。

`GET /api/v1/sessions/:id/terminals/:tid/socket?cols=&rows=`，升级成 WebSocket（页面用 `GatewayApi.terminalSocketUrl(id, tid, cols, rows)` 拼地址），挂到这个终端上。

- 放行：`Host` 必须是网关自己的；`Origin` **必须**等于网关自己的来源（不带也拒），否则 403 `ORIGIN_REJECTED`；没有或过期的登录 401 `AUTH_REQUIRED`（登录 cookie 照常续期，需要时随握手应答发回）；对话不存在或已删除、终端不存在或已关掉都是 404；`cols`/`rows` 只给一个、不是 1–65535 的整数、或带了别的参数 400 `INVALID_INPUT`；网关正在关闭 503。拒绝都是普通 HTTP 应答，体为 `{ code, message }`。别的路径的升级请求 404（旧的 `GET …/terminal` 已去掉）。
- 帧都是 JSON 文本帧。网关先发 `{ "type": "output", "data": string }`：shell 从启动到现在打印的全部内容（从历史文件分块读出），然后一条 `{ "type": "replayed" }`（挂上那一刻之前的都发完了；页面可以在它之前不回应终端查询，免得重放出的查询序列被当成输入写回 shell），再往后是实时输出；shell 结束后一条 `{ "type": "exit", "code": number | null, "signal": string | null }`，随后以 1000 关闭。已经结束的终端照样能挂：历史、`replayed`、`exit`、关闭。输出按 UTF-8 流式解码，跨块的多字节字符完整到达。
- 页面发 `{ "type": "input", "data": string }`（原样写进终端）、`{ "type": "resize", "cols": number, "rows": number }`；认不出的帧、二进制帧忽略。可以同时挂多个连接（两个浏览器标签）：都收到同样的输出，谁的输入都进 shell，尺寸以最后一次调整为准；挂上时带了 `cols`/`rows` 也算一次调整。连接断开只是摘下来，shell 照跑。
- 背压：发给一个连接、还没写出去的超过 1 MiB，就不再把实时输出直接发给它，改由它自己从历史文件里一块一块读（每块 256 KiB，前面的写出去到 256 KiB 以下才读下一块），追上了再改回直接发。慢的连接（后台标签、断网边缘）既不拖住 shell，也不拖住别的连接，网关内存里每个连接最多压着约 1 MiB 加一块，没读的部分在磁盘上。不丢输出。
