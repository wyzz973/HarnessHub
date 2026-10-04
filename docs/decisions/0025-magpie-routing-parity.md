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
