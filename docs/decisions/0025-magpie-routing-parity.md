# ADR 0025：对齐 Magpie 的路由、失败休息与 Codex 透传

Status: proposed

日期：2026-10-04
关联决定：[03 模型平面](../proposals/oss/03-model-plane.md)（第 5、8 节）、开源版 [ADR-P05](../proposals/oss/adr-drafts.md#adr-p05-路由重试与故障转移)（本记录修订其中的重试部分）、[ADR-P09](../proposals/oss/adr-drafts.md#adr-p09-订阅复用进核心)

## 问题

开源版以 Magpie 为对标。共享网关原有的熔断只区分“计数失败、冷却、认证、模型标记”，配额与余额失败最多休息 10 分钟，额度用完的 Credential 每 10 分钟就被探测一次；每个候选先在原处重试两次再转移，一个故障上游会让每次调用先等待退避；`least-used` 只看本次启动以来按成员统计的 token。Magpie 按失败的原因决定休息多久，失败时先换候选、只对最后一个候选重试，并提供自动组、账号钉选与 Codex 透传。用户要求按 Magpie 的行为对齐，同时保留共享网关的熔断半开探测与“先提交后发布”。

## 决定

- **失败类别**：上游失败按 Magpie `failure()` 的顺序与词表分为 `proxy`、`verify`、`credit`、`quota`、`rate`，再加上本网关原有的 `auth`、`model`、`other`（5xx、超时、连接失败）与 `request`（请求本身的问题，含上下文超长）。词表集中在一张表中，以正反样例测试。尝试与调用的 `errorClass` 按类别取值。
- **休息**：`credit` 与 `verify` 30 分钟；`quota` 到厂商说明的重置时间（错误体优先，其次响应头），否则 15 分钟，最长 8 天；`rate` 按响应头的等待，否则 1 分钟；`proxy` 不休息；`auth` 与 `model` 不变（10 分钟或 Credential 引用变化；只标记该模型 10 分钟）；`other` 保留“连续 3 次才打开”，打开时长 1 分钟起翻倍到 10 分钟。休息到期后仍然只放行一个探测请求。
- **转移与重试**（修订 ADR-P05 与 03 第 5 节的重试表）：失败只要还有其他可尝试的候选就立即转移；只有最后一个还能尝试的候选（其后的候选都在休息）在原处重试，等待 `baseBackoffMs × 2^n`（默认 1、2、4 秒）或响应头的等待，超过 8 秒不等，不加抖动。可重试的是 5xx、408、超时、连接失败与 `rate` 类 429（包括没有 `Retry-After` 的）；余额、额度、认证类失败照旧不重试。`DEFAULT_RETRY_POLICY` 改为 `perCandidate: 3`、`baseBackoffMs: 1000`。
- **`least-used`** 采用 Magpie `usage` 的排序：路由组所有成员的 Credential 一起排，先比较已用比例，再比较每小时减半的 token 数。HarnessHub 没有订阅额度读数，已用比例取上游答复的限流头（OpenAI 与 Anthropic 的 `ratelimit` 头）；初值从账本最近 8 小时、至多 5000 条调用读取。
- **自动组**：同一规范名（Magpie `sameModel`）由两个以上就绪 provider 提供的模型成为 `group/auto-<slug>`，从 provider 派生、不存储，同 ID 的用户组优先；用户隐藏的 ID 存入新表，可以恢复。派生函数在 core，网关与管理接口共用。
- **`X-HH-Credential`** 对应 Magpie 的 `X-Magpie-Account`：按 ID 或名称钉选，休息中 429、不提供该模型 400、不存在 404，不发往上游。
- **调用归属**：账本记录增加 `conversationKey`（粘性会话键的哈希）与 `agent`（Key 作用域，或标为推断的 User-Agent 与路由），并增加对应列、会话汇总接口与按 Credential 的用量。
- **Codex 透传**：回环监听器上的 `/backend-api/codex/*` 原样转发到 ChatGPT 的 Codex 后端，客户端自己的 `Authorization` 与 `ChatGPT-Account-Id` 不变，网关不持有这份登录，Authorization 的值不写日志与账本；带模型的调用以虚拟 provider `chatgpt-subscription` 入账，终止事件在提交之后写出。上游基址只供测试注入。

## 考虑过的替代方案

- **保留“先原处重试再转移”**：对单个故障上游最友好，但多候选时每次调用都先付出退避，而换一个候选通常立刻成功；Magpie 只在没有替代时等待。
- **完全照搬 Magpie 的“不跳过休息中的候选、只把它排到最后”**：在只有一个候选时更宽容，但会在已知失败的上游上重复尝试，也违背 03 中“全部熔断时不访问上游”的约定；因此保留跳过与半开探测，只有钉选或休息到期的探测会触达它。
- **`other` 第一次失败就休息**（Magpie 的做法）：单个 Credential 的 provider 会因一次 503 停用一分钟；保留连续 3 次的门槛。
- **`least-used` 的已用比例恒为 0**（HarnessHub 没有订阅额度）：排序退化为只看 token；限流头是现有的、按 Credential 的余量读数，因此采用。
- **Codex 透传由 HarnessHub 自己的 ChatGPT 账号应答**（Magpie 的订阅 provider）：属于 ADR-P09 的订阅 provider，需要单独的登录流程与风险提示，不在这里实现；透传只转发 Codex 自己的请求，不伪造任何客户端身份。
- **自动组写入路由组表**：需要在 provider 变化时同步更新与清理；派生加“隐藏名单”与 Magpie 一致，也不需要迁移已有组。

## 后果

- 额度或余额用完的 Credential 休息得更久，期间新的调用不再触达它；厂商提前恢复时，要等休息到期的探测或成功调用才会结束休息。
- 5xx 在最后一个候选上最多重试 2 次（第三次失败打开熔断），`rate` 最多 3 次，与 Magpie 的 `lastRetries`、`rateRetries` 相同。没有 `Retry-After` 的限流 429 现在会在最后一个候选上等待并重试，客户端看到失败的时间最多推迟约 7 秒。
- 账本 schema 增加迁移 5（迁移 4 是全局接线的 `wiring_profiles`）；旧记录没有 `conversationKey`，`agent` 只能从 `agent:` Key 补齐。
- Codex 透传使守护进程把请求转发到 chatgpt.com，这是网关第一个固定的外部上游；它只在 Codex 被接线到这里时才有流量。
- 未对齐的 Magpie 细节列在 [统一模型网关](../model-gateway.md#与-03-的差异与未实现项) 中。

## 验证要求

- 单元：失败类别的判定顺序与词表正反样例；每种类别的休息时长；默认退避与上限；`least-used` 的衰减、限流比例与账本初值；`sameModel` 与自动组派生。
- 网关 HTTP（回环假上游、合成密钥）：休息到期前不访问上游、到期后一次探测；只在最后一个候选上重试；钉选的 429、400、404 与请求头不外发；自动组的列出、路由、隐藏与用户组优先；Codex 透传的逐字节转发、不保存 Authorization、用量入账与先提交后发布。
- 存储与接口：迁移 5 的升级与补齐、会话汇总的游标、按 Credential 汇总、隐藏与恢复。
- 未验证：真实 ChatGPT 后端与真实 Codex 经透传的会话；真实厂商的限流头与错误措辞以它们公开的格式为准，没有录制语料。

## 补充：拒绝类 400/422 与安全拒绝的转移

日期：2026-10-05

原先 400 与 422 只有带“模型不存在”措辞时才转移，其余都按 `request` 直接返回客户端。Magpie 在下列情况会换下一个候选（`internal/gateway/fallback.go` 的 `retryable`、`shapeRefused`、`policyRefusal`、`refusedReply`，`gateway.go` 的 `withTokenFloor` 与拒绝分支）：

- 400/422 的错误体带它的余额、用尽或繁忙措辞（`quotaWords`）、模型不存在措辞（`unservedWords`）、拒绝渠道措辞（`refusedWords`）或请求形状措辞（`shapeWords`）；
- 安全过滤器拒绝了请求，表现为错误码，或者一个什么都没说的回答；
- 厂商嫌请求要的回复太短。

### 决定

1. **新增三个失败类别**，词表照搬 Magpie，集中在 `FAILURE_WORDS` 与 `policyRefusal`：
   - `policy`：安全过滤器拒绝了这个请求，另一个账号或厂商可能会回答。按错误码判断（`refusal`、`content_filter`、`content_policy_violation`、Gemini 的各种 `SAFETY` 原因、`<名称>_policy`、被标记的 `invalid_prompt`），429 以外的任何状态都算，因为流内的拒绝可能被映射成 5xx。
   - `refused`：厂商拒绝这个客户端或渠道的所有请求。
   - `shape`：这个 API 读不懂请求的形状，另一个 API 可能读得懂。
   - 繁忙措辞的 400/422（`overloaded`、`too many requests` 等）归入 `other`，与 Magpie 的 `failOther` 一致。模型不存在措辞补上 Magpie 的 `unknown` 与 `invalid`。
2. **客户端自己的错误永不转移**：400/422 先用 `clientFault` 词表排除对所有 provider 都错的请求，它们一律是 `request`。
   - 这些请求包括：缺少必填字段（`field required`、`missing field`）、消息为空或缺失、请求体不是 JSON。
   - 这一步排在其他词表之前，因为 axum 的 “Failed to deserialize the JSON body …: missing field `messages`” 同时会命中形状词表。
   - 这是 HarnessHub 新增的显式区分：Magpie 只是靠词表没有收录这些措辞来避免转移。
3. **休息**（照 Magpie）：
   - `policy` 与 `shape` 不休息，因为 Credential 本身没有问题；
   - `refused` 与繁忙类计入熔断，与 `other` 相同（Magpie 是退避休息）；
   - 都不在原处重试。
4. **转移的方向**：
   - `shape`：跳过其余同一 provider、同一上游协议的候选。同一个 API 再问一次也读不懂；别的 provider 或协议可能读得懂。Magpie 只是问下一个候选，不跳过。
   - `policy`：先问同一 provider、同一模型与强度、未休息的其他 Credential（Magpie `matesFirst`）。
5. **回复长度下限**（Magpie `tokenFloor`、`withTokenFloor`）：
   - 400 说出下限（`max_tokens must be greater than 2`、`Expected >= 16` 等，至多 1024），而本次请求要求的长度低于它时，同一候选立即重发一次。
   - 之后这次调用的每个请求都至少要求这么长，账本记 `max-tokens:floor:<n>`。
   - 请求没有要求长度，或要求已经足够时，这个 400 说的是别的事，照常返回。
6. **什么都没说的安全拒绝**（Magpie `refusedReply`、#248）：
   - 2xx 回答以安全拒绝结束（各协议的拒绝原因统一记为 `content_filter`），且没有文字、推理或工具调用，同时客户端尚未收到任何字节时，按 400 的 `policy` 失败处理：
     - 有候选就转移；
     - 没有候选时客户端得到这个 400，而不是一个它会再发一遍、每次都付提示词费用的空回答。
   - 只要还有重试或候选，流就会在第一个内容事件之前被扣留，所以流式与非流式的处理相同。
   - 流内的错误事件保留厂商的错误对象（`GatewayError.detail`，只用于分类，不保存也不发出），所以 Responses 的 `response.failed`（`bio_policy`）这类流内拒绝也会被识别。

### 考虑过的替代方案

- **`shape` 也像 Magpie 一样问下一个候选，不跳过**：同一 provider 的其他 Credential 指向同一个 API，必然得到同样的答复，只会白白多一次请求。
- **最后一个候选的拒绝原样交给客户端**：对协议保真更好，但 Codex 这类客户端会把空回答再发一遍（Magpie #248），所以采用 Magpie 的做法。
- **为拒绝另设账本字段**：`errorClass` 已经能区分；尝试的 `errorClass` 与 `decision` 记录了转移。

### 后果

- 以前直接返回的一些 400/422 现在会转移到其他候选，客户端更少看到厂商特有的形状或渠道错误，但调用可能多一次上游请求。
- 被拒绝的尝试若有用量（什么都没说的拒绝也可能计了输入），只计在那个上游，不进入这次调用的账本用量。
- 与 Magpie 的其余差别列在 [统一模型网关](../model-gateway.md#与-03-的差异与未实现项)：
  - 推理之后才出现的拒绝不再转移；
  - Gemini 的 `RECITATION` 也算拒绝；
  - 只有 `promptFeedback.blockReason` 的回答不识别为拒绝。

### 验证

- 单元测试 `shared-gateway-failover.test.ts`：
  - 失败类别表，新增安全拒绝、拒绝渠道、繁忙、形状与客户端错误的正反样例；
  - 每个词表的正反样例；
  - 新类别的休息与转移。
- 单元测试 `refusal-failover.test.ts`：
  - 照搬 Magpie 的 `policyRefusal` 与 `tokenFloor` 样例；
  - `withTokenFloor` 与 `matesFirst`；
  - 回环假上游上的各种情况：
    - 形状错误跳过同一 API；
    - 安全拒绝先问同一模型的其他 Credential；
    - 拒绝渠道与繁忙；
    - 客户端错误不重试、不转移；
    - 下限重发与不重发；
    - 什么都没说的回答，非流式与流式，以及没有候选时的 400；
    - 转换路径；
    - Responses 流内的 `bio_policy`。
- 假 provider 新增怪癖 `refuse`（`policy`、`shape`、`channel`、`busy`、`unserved`、`client`）、`tokenFloor` 与 `safetyRefusal`，各有四个协议的用例与无效样例。
- 集成测试 `tests/integration/refusal-failover.test.ts` 经正式守护进程与两个严格假 provider 验证：
  - 五类拒绝与什么都没说的拒绝（含流式与 Anthropic 入站）都转移到第二个 provider，账本记录每次尝试的类别与决定；
  - 客户端错误与普通 400 不重试、不转移；
  - 回复太短时同一 provider 重发。
  - 在修改前的网关代码上，两个用例都失败。
- 协议一致性套件保持通过。

## 修订（2026-10-05，第二轮安全审查）

第二轮安全审查（F 组）发现，照 Magpie 的路由在共享网关上可以被一把 Key 利用来影响别的 Key。以下决定替换上文与之冲突的部分。

### 决定

1. **休息不受请求左右（H2）**。休息的类别从去掉请求自身词语的错误体判断（`echoFree`：请求的字符串值与 `model` 以外的键中的词，不分大小写，CJK 逐字），这次请求的转移仍按完整的错误体。Claude Code 的 `limit reached|<Unix 秒>` 只在 429 或订阅账号的答复中读取。
   - 只去掉回显而保留措辞做不到：厂商的回显会被截断、改写或夹在自己的句子里。按词去掉会多去掉提示词与厂商措辞共有的词，代价只是休息变短或没有，所以只用于休息，不用于转移。
   - 保留键名 `model` 的词，因为每个请求都有它，而“model … not found”需要它；它的值由网关设定，照常去掉。
2. **一把 Key 的失败只给 1 分钟（H2）**。比 `PROVISIONAL_MS`（1 分钟）长的休息与模型标记先只给 1 分钟；到期后的探测来自另一把 Key、并再次得到需要长休息的失败时，才给完整时长。休息期间没有别的 Key 能到达这个 Credential，所以“另一把 Key 的确认”就是探测。
   - 代价：只有一把 Key 时，额度用完或欠费的 Credential 每分钟被探测一次（一次失败的请求，随后转移）。以前一次失败就让它休息到重置（最长 8 天）。
   - 计入熔断的失败（5xx、超时）不受此限：它们由状态码决定，请求左右不了。
3. **其他 Key 看不到某把 Key 的上游错误（H2）**。“所有候选都在休息”只给出类别与状态码。
4. **安全拒绝的转移（M2）**，替换上文 4 中的 `policy`（`matesFirst`）：
   - 不转给同一厂商的其他候选：端点主机相同即同一厂商，包括同一 API 上的其他 provider。同一厂商的其他账号适用同一套政策，逐个去问只会把被标记的提示发给每个账号，让这些账号都可能被厂商处理。Magpie 先问同一模型的其他账号，是赌另一账号的过滤结果不同；共享网关上这让一个 Key 能把一条提示扇出到所有账号。
   - 一次调用至多再问一个别的厂商，第二次拒绝即返回。
   - 一把 Key 在 10 分钟内被拒绝超过 5 次（`POLICY_FAILOVERS`）后，它的拒绝不再转移，直接返回。这是固定行为，没有设置项；有人需要时再加。
5. **被丢弃的拒绝回答计费（M3）**，替换上文后果中“只计在那个上游”：什么都没说的拒绝回答的 usage 与成本加到这次调用的账本记录（`refused:usage:<n>`），从而计入 Key 的预算。

### 后果

- 依赖文字措辞的休息（400 的余额、额度、模型不存在、渠道与繁忙措辞）在提示词恰好含有这些词时不再发生，那个 Credential 下次照常被尝试并再次转移。
- 一个提示被所有账号的安全过滤器拒绝时，客户端更快拿到拒绝，不再逐个尝试。
- 安全拒绝的调用在账本中的用量与成本可能比以前大，因为包含被丢弃的回答。

### 验证

- 单元测试：
  - `shared-gateway-failover.test.ts`：回显的字段名不再决定休息，请求仍转移；去掉回显后厂商自己的措辞仍在；1 分钟的暂定休息、同一 Key 的探测、另一 Key 的确认；
  - `refusal-failover.test.ts`：`dropVendor` 与 `PolicyRefusals`；拒绝不转给同一厂商的其他 Credential；一次调用至多两个厂商；Key 超过 5 次后不再转移；被丢弃回答的用量与成本；
  - 改为暂定休息后，按完整休息断言的原有测试（钉选、路由状态、ChatGPT 订阅）用两把 Key 或改为 1 分钟。
- 集成测试 `tests/integration/routing-review.test.ts` 由审查脚本改写，经正式守护进程验证每一项。它在修改前的网关代码上全部失败。
