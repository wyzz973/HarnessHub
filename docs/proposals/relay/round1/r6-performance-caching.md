# R6 · 接力的性能、费用与缓存模型（第 1 轮调研）

调研员 R6，2026-11-02，分支 `cc/relay-design`（基点 `07a0825`）。本文是调研与设计建议，不是已接受的决定；除第 2.6 节标明“测量”的数字外，没有任何实现或真实 Harness 验证。

标注：【事实】来源原文或源码直接给出；【测量】本机微基准实测；【推断】由事实或测量推出；【建议】给设计组的方案。

> 要点
> 1. 【测量】现有实现每个回合都先构建完整公共历史再做预算（`runtime.ts:1334`）：在长回复画像下，快照约 1.5 MiB（约 66 个回合）时，**同一 Harness 的普通续接也失败**（`CONTEXT_TOO_LARGE`），1.21 MiB 时仍成功。这与 R4 的 D3 独立吻合。
> 2. 【推断】交接单一旦进入目标的原生转录，就随此后**每一次**模型请求重发；缓存把重发降到 0.025–0.1 倍价，但乘上请求次数后仍是主要成本：在“其后 80 次请求”的假设下，每 1k 注入 token 的总价约为基础输入价的 2.6–8.9 倍（Opus 5.5 约 $0.021，GPT‑6.1 Sol 约 $0.010，DeepSeek V4 Flash 约 $0.0008）。
> 3. 【推断】200 回合时全量历史约 195k token，每次交接约 $4.07（Opus 5.5）、首回合多约 24 s 预填充；结构化交接单约 16.6k token、$0.34、约 2 s。阻塞式模型摘要在切换路径上要 46–105 s，不适合默认路径。
> 4. 【测量】快照越大，Hub 自身越慢：用零延迟假 Harness，受理到派发 0.08 s（0.5 MiB）→ 1.25–1.41 s（7.5 MiB）；每次整份快照提交约 19 ms/MiB，最小回合也有 11 次提交。账本放进快照会让每次提交都更慢；单独建表、按回合追加一次写入只需 0.06 ms（p95 0.75 ms），写入约 8 KiB。
> 5. 【建议】采用确定性、与下一条输入无关、分层限额的交接单（默认不超过 8k）；账本单独建表，每个回合结算时更新一次；返回原 Harness 时按缓存是否仍有效给出估算；后台只做确定性维护，不做模型摘要。

---

## 1 范围与方法

- **阅读日期**：2026-11-02。价格和规则都在当天打开厂商页面核实（第 7 节记录核实方式）。我的训练知识截止于 2026-06，因此“最新”内容一律以当天页面为准。
- **来源类型**：
  - 厂商一手文档：Anthropic 定价与 prompt caching、Claude Code 文档与工程博客、OpenAI 定价与 prompt caching、DeepSeek 定价与上下文缓存。
  - 论文：arXiv 与 ICML。
  - 业界工程文章：Manus、Anthropic Applied AI。
  - 本机已安装 Harness 的源码与文档（只读）：Hermes、OpenClaw、dsh，以及 Codex 的 GitHub 源码。
  - 本仓库源码与 ADR、验证文档。
  - 本机微基准。
- **微基准环境**：Apple M5 Pro（18 核，64 GB），macOS 27.0.1，Node v26.11.1，SQLite 3.53.4。仓库的 `state.ts`、`context.ts`、`runtime.ts`、`sqlite-store.ts` 用主检出里的 `tsc 5.9.3 --noCheck` 编译到 scratchpad，**仓库未改动**；数据用合成会话（中英文混排，含代码块与 JSON 转义字符，不含任何用户数据），临时数据库用后即删。脚本放在 `/private/tmp/claude-501/-Users-sd3-Desktop-project-HarnessHub/ad0e280f-cff4-4061-938f-4e375d14fd26/scratchpad/relay/r6/bench/`（`gen.mjs`、`bench-cpu.mjs`、`bench-store.mjs`、`bench-wal.mjs`、`bench-misc.mjs`、`bench-runtime.mjs`、`cost-model.mjs`）。该目录属本会话，可能被清理。
- **局限**：
  1. 没有运行任何真实 Harness 会话，也没有调用任何模型。首 token 时延和预填充吞吐只能由厂商公布的数字和论文推出，没有在当前模型上实测。
  2. token 数由字节估算：混排文本按约 3 字节/token 计，误差可能达 ±30%。Claude 4.7 及以后的分词器同样文本多约 30% token [S1]。
  3. opencode.ai 无法抓取，OpenCode Zen 只看到搜索摘要。
  4. 部分页面只读到前 10 万字符（S2、S24）。
  5. 合成会话的形状（回复长度、工具数）会影响绝对数字，但不改变斜率和量级结论。

---

## 2 发现

### 2.1 厂商价格（2026-11-02 核实，单位：美元/百万 token）

| 模型 | 基础输入 | 缓存写 | 缓存读 | 输出 | 备注 |
|---|---:|---:|---:|---:|---|
| Claude Fable 5.1 | 10 | 12.50（5m）/ 20（1h） | 0.25（0.025×） | 50 | 【事实】[S1] |
| Claude Opus 5.5 | 4 | 5（5m）/ 8（1h） | 0.20（0.05×） | 20 | 【事实】[S1] |
| Claude Opus 5 / 4.8 / 4.7 / 4.6 | 5 | 6.25 / 10 | 0.50（0.1×） | 25 | 【事实】[S1] |
| Claude Sonnet 5.5 | 2 | 2.50 / 4 | 0.10（0.05×） | 10 | 【事实】[S1]（S3 中 $0.20 的旧值已被 S1 取代） |
| Claude Sonnet 4.6 | 3 | 3.75 / 6 | 0.30 | 15 | 【事实】[S1] |
| Claude Haiku 5.5 | 0.10（≤100k）/ 0.50（>100k） | 0.125 / 0.20（≤100k） | 0.01 | 0.50 / 2.50 | 【事实】按整个提示长度计价，包括缓存读写部分 [S1] |
| OpenAI gpt‑6.1‑sol（Codex 本机默认 [S29]） | 2 | 2.50（30m）/ 5（12h） | 0.10（0.05×） | 10 | 【事实】>272K 时输入价 ×2、输出价 ×1.5 [S9] |
| OpenAI gpt‑5.6‑sol | 4 | 写入 1.25×（30m）/ 2.5×（12h） | 0.40 | 20 | 【事实】[S8][S9]；促销价至少持续到 2026-11-21 [S9] |
| OpenAI gpt‑5.5 | 5 | 不加价（自动） | 0.50 | 30 | 【事实】>272K 时输入 10、输出 45 [S9] |
| DeepSeek V4.1 Flash（`deepseek-flash`，dsh 默认 [S29]） | 0.30（未命中） | 无写入价 | 0.006（命中，2%） | 1.20 | 【事实】高峰价；闲时半价 [S10] |
| DeepSeek V4 Pro | 1.32 | 无写入价 | 0.044（3.3%） | 3.96 | 【事实】高峰价；闲时半价 [S10] |
| OpenCode Zen 免费模型（`opencode/big-pickle` 等，OpenCode 本机默认 [S29]） | 0 | — | 0 | 0 | 【事实，仅搜索摘要】免费列表随时间变化 [S13] |

补充：
- 【事实】Claude 4.6 及以后（Haiku 5.5 除外）的 1M 窗口按标准价计费，没有长上下文加价 [S1]。
- 【事实】`inference_geo:"us"` 对所有类别加价 1.1× [S1]；OpenAI 区域端点加价 10% [S9]。
- 【事实】DeepSeek 的高峰时段为工作日 UTC 01:00–04:00 与 06:00–10:00 [S10]。

### 2.2 厂商缓存规则

**Anthropic** [S1][S2][S3]
- 【事实】按前缀精确匹配，层级依次为 `tools → system → messages`，前面任何一处字节变化都会让其后全部失效。
- 【事实】换模型会让所有层失效（缓存按模型隔离）。图片和 `tool_choice` 的变化会让 messages 层失效。
- 【事实】最多 4 个断点；每个断点最多向前回看 20 个位置（连续的 `tool_use` 或 `tool_result` 各算一个位置）。
- 【事实】最小可缓存长度：Opus 5.5、Sonnet 5.5、Fable 5.x、Haiku 5.5 为 512 token；Opus 4.8、Sonnet 5、Sonnet 4.6 为 1024；Opus 4.7 为 2048；Opus 4.6、Opus 4.5、Haiku 4.5 为 4096。低于下限时静默不缓存，不报错。
- 【事实】TTL 为 5 分钟（写入 1.25×）或 1 小时（写入 2×）。每次读取都免费续期，寿命从请求**开始**时计算。
- 【事实】缓存条目要等首个响应开始返回才可读，并行请求互相读不到。
- 【事实】缓存在 workspace 级隔离，跨组织不共享。
- 【事实】在 Opus 5.x、Fable 5.x、Sonnet 5.5 等模型上，可以把会话中途的 `role:"system"` 消息追加在历史之后，不破坏已缓存的前缀 [S3]。

**OpenAI** [S8][S9][S32]
- 【事实】GPT‑5.6 及以后：
  - 可见输入不少于 1,024 token 才缓存；最短寿命 30 分钟（默认），或经 `prompt_cache_options.ttl` 设为 12 小时。
  - 读取 0.1×（GPT‑6.1 Sol/Terra 为 0.05×）；写入 1.25×（30m）或 2.5×（12h），用量里单列 `cache_write_tokens`。
- 【事实】更早的模型：
  - 写入不加价，`cached_tokens` 按 128 token 向下取整。
  - 内存保留约 5–10 分钟无活动（最长 1 小时），或 `24h` 扩展保留；非 ZDR 组织默认 24h。
  - `prompt_cache_key` 只影响路由，建议每个 key 合计约 15 RPM。
- 【事实】缓存跨组织不共享，也不跨区域处理边界。
- 【事实】`previous_response_id` 链上此前的输入 token 仍按输入计费 [S32]，只是不必由客户端重发。

**DeepSeek** [S10][S11][S12]
- 【事实】磁盘 KV 缓存默认开启。前缀单元在三处持久化：用户输入末尾、模型输出末尾、长输入或输出的固定间隔。
- 【事实】只有完整匹配一个前缀单元才算命中。构建需要几秒；不用后通常几小时到几天内清除；属尽力而为，不保证命中。
- 【事实】2024 年的公告给出 64 token 的存储单元，以及“128K 重复前缀的首 token 从 13 s 降到 0.5 s”[S12]；当前页面未再写出单元大小 [S11]。

**OpenCode Zen** [S13]
- 【事实，仅搜索摘要】官方表列出 Big Pickle、DeepSeek V4 Flash Free、MiMo‑V2.5 Free 等免费模型，缓存读取也免费；免费期多为临时。数据使用条款未核实。

### 2.3 预填充与首 token 时延

| 来源 | 场景 | 未缓存 | 缓存 | 推断的边际预填充吞吐 |
|---|---|---:|---:|---|
| Anthropic 博客（2025-08-14 更新）[S4] | 100k token 的书 | 11.5 s | 2.4 s（−79%） | 约 11k tok/s【推断】 |
| 同上 | 10k token 多样例 | 1.6 s | 1.1 s（−31%） | 固定开销占主导 |
| 同上 | 10 轮对话加长 system | ~10 s | ~2.5 s（−75%） | — |
| DeepSeek（2024-08）[S12] | 128K 重复前缀 | 13 s | 0.5 s | 约 10k tok/s【推断】 |
| Don't Break the Cache（2026-01）[S15] | 10k system 的智能体会话 | — | TTFT −13% 到 −31% | — |
| 同上 | GPT‑4o、50k 提示 | 4,290 ms | 1,699 ms | 约 19k tok/s【推断】 |

- 【推断】在厂商托管模型上，未缓存的边际预填充约为每秒 1 万到 2 万 token。下文代价模型保守取 8k tok/s，并给出灵敏度。2026 年的当前模型（Opus 5.5、GPT‑6.1、DeepSeek V4）**没有找到可靠的公开测量**（Artificial Analysis 的 100k 档每周只测一次且需要交互页面 [S14]），属未解决问题。
- 【事实】思考型模型的首 token 与首个可见答案 token 可能相差几十秒（Artificial Analysis 方法论区分 TTFT 与 TTFAT [S14]）。HarnessHub 的“首字”从受理开始计时，包含 Harness 启动 [S29]。
- 【事实】HarnessHub 已有的本机记录 [S29]：
  - Claude Code 短提示的首字 4.2–5.9 s（自受理起）；复用保留进程时启动 7 ms、首字 1.5 s。
  - Hermes 启动约 4.8–5 s；dsh 的 ACP 初始化约 3.7 s。
  - 旧实现每次启动的切换耗时：Claude 约 2.9 s、Codex 约 4.3 s、OpenClaw 约 1.3 s。
- 【推断】切换后的首回合时延主要来自三部分：
  1. 目标 Harness 冷启动（1.3–5 s）；
  2. 模型首 token（包含交接单的预填充，每 1k token 约 0.05–0.12 s）；
  3. 大会话下 Hub 自身的同步提交（见 2.6）。

  构建交接单本身只需毫秒级。

### 2.4 各 Harness 会话内的缓存行为：交接单会不会随每轮重发

| Harness（本机版本） | 是否每次请求重发完整转录 | 缓存方式与 TTL | 对接力的含义 | 来源 |
|---|---|---|---|---|
| Claude Code | 是（API 无状态，每次重发 system、项目上下文与全部消息） | 显式断点；订阅额度内的主对话用 1h，API key、云厂商或超额时用 5m；`promptCacheTtl` 可改。换模型、换 effort（5.5 系列除外）、增减工具（工具不延迟加载时）、`/compact` 会失效；plan mode、skills、输出风格改动都以追加消息实现，不失效；`--resume` 在 TTL 内可读回缓存；缓存实际按“机器加目录”划分 | 交接单作为首条用户消息时，写入一次，此后每次请求按读价计；返回时是否仍有效取决于 1h 或 5m | 【事实】[S5][S6][S7] |
| Codex 0.166.0 | 是：HTTP 路径 `store:false` 全量重发；WebSocket 路径在新输入延续上次请求时用 `previous_response_id` 增量发送，但计费仍算完整输入 | `prompt_cache_key` 由会话派生；默认 gpt‑6.1‑sol 最短 30 分钟 | 新原生会话换了新 key，不复用旧会话的缓存 | 【事实】[S24][S29][S32] |
| Hermes（本机 `bf0203a`，2026-10-22） | 是 | 默认 4 个断点（静态 system 前缀、system 末尾、最后两条非 system 消息）；默认 `cache_ttl:"5m"`；`auto` 可选，人工会话用 1h、机器会话用 5m。源码注释记录了一份单机实测：交互会话中 63% 的缓存写入 token 发生在 5–60 分钟空闲之后的冷重写 | 交接单所在的消息不再是最后两条之一后，仍靠前缀缓存命中 | 【事实】[S25] |
| OpenClaw 2026.10.9 | 是 | `cacheRetention`：none、short、long；直连 Anthropic 默认 short（5m）；可配心跳保温（例如每 55 分钟）；OpenAI 路线发 `prompt_cache_key`，long 时用 30m 或 24h | 可配合保温，降低返回时冷重写的概率 | 【事实】[S26] |
| dsh 0.2.1‑rc.5 | 是（基于 `@earendil-works/pi-ai`） | DeepSeek 自动磁盘缓存，缓存保留几小时到几天 | A→B→A 时返回 dsh 的冷重写概率最低 | 【事实】[S27][S11] |
| OpenCode 2.2.5 | 是（AI SDK） | 二手来源：Anthropic 类 provider 标记前两条 system 和最后两条非 system 消息；OpenAI 类发 `promptCacheKey` | 本机二进制未能核实 | 【事实，仅二手】[S31] |

- 【推断】结论：在全部 6 个焦点 Harness 中，交接单进入原生转录后都会随此后每次请求重发，直到该 Harness 自己压缩掉它。缓存只降低单价，不消除次数，并且有两个例外：
  1. 用户回合之间的空闲超过 TTL 时，包括交接单在内的整个前缀按写入价重写一次；
  2. 目标压缩之后，交接单会被并入该 Harness 自己的摘要，有损，且由 Harness 控制。

### 2.5 论文与业界实践（与性能、缓存相关的部分）

- 【事实】Manus（2025-07-18）[S21]：KV‑cache 命中率是生产级智能体“最重要的单一指标”，平均输入与输出 token 比约 100:1。对应的做法是：
  - 前缀保持稳定，不在开头放秒级时间戳；
  - 上下文只追加；
  - 序列化保持确定；
  - 用屏蔽代替移除工具；
  - 把文件系统当作可恢复的外部上下文（压缩时保留 URL 或路径）。
- 【事实】Anthropic Applied AI（2025-09-29）[S22]：上下文腐化（context rot）与“注意力预算”；Claude Code 压缩时保留架构决定、未解决的 bug 与实现细节，丢弃冗余工具输出；子 Agent 只交回 1,000–2,000 token 的摘要；倾向即时检索（保留路径与查询，按需读取）。
- 【事实】Anthropic 上下文管理公告 [S23]（仅搜索摘要）：在 100 回合网页搜索评测中，context editing 让原本因上下文耗尽而失败的流程得以完成，token 消耗降低 84%；记忆工具加 context editing 使成绩提升 39%，单用 context editing 提升 29%。
- 【事实】Claude Code 团队（2026-04-30）[S7]：
  - 缓存命中率按可用性监控，过低就定为事故（SEV）；
  - 不要在会话中途换模型：Opus 对话进行到 100k token 时换 Haiku，比让 Opus 继续回答更贵；需要换模型时让子 Agent 接手，由 Opus 写交接说明；
  - 压缩采用“缓存安全的分叉”：复用父会话完全相同的 system、工具和消息，只追加压缩指令；
  - 摘要约 20k token。
- 【事实】Don't Break the Cache（arXiv 2601.06007，2026-01）[S15]：
  - 只缓存 system 提示的效果最稳定：成本降低 41–81%，TTFT 降低 13–31%（10k system）。
  - 全上下文缓存有时反而**增加**时延。
  - 动态工具集或动态工具结果会破坏缓存。
  - 50k 前缀时 GPT‑5.2 节省 89%，Sonnet 4.5 节省 88%。
- 【事实】GitHub Copilot 生产轨迹（arXiv 2608.00101，2026-07-30）[S16]：3.2M 用户、761M 次调用、95T token。
  - 回合内 KV 命中平均 90%，跨回合降到 55%；换模型或压缩之后“大幅失效”。
  - 用户在回合边界有分钟级空闲；一个轻量预测器能覆盖 86–90% 的空闲时间。
- 【事实】Cache‑Aware Prompt Compression（arXiv 2607.15516，2026-07-17）[S17]：
  - 随查询变化的压缩每次产生不同前缀，会破坏前缀缓存，在现实命中率下只有压缩比 r≥6 才划算；
  - 与查询无关的压缩配合显式 `cache_control` 最便宜；
  - Sonnet 4.6 在约 3,500 token 附近有命中阈值，阈值以下 30 次调用的命中率约 0.83。
- 【事实】Sleep‑time Compute（arXiv 2504.13171，2025-04）[S18]：在可预判的查询上，达到同等准确率可少用约 5 倍测试时计算；多个相关查询分摊时，每次查询的成本降低 2.5 倍；**收益强烈依赖查询的可预测性**。
- 【事实】ACE（arXiv 2510.04618，ICLR 2026）[S19]：用条目化的增量更新取代整体重写，避免“上下文坍缩”（反复改写逐步丢失细节）与“简短偏置”。
- 【事实】Auditing Prompt Caching（ICML 2025）[S20]（仅搜索摘要）：缓存命中造成可测的计时侧信道，7 家 API 提供商曾跨用户共享缓存（含 OpenAI）。现行厂商文档写明不跨组织共享 [S2][S8]。

### 2.6 HarnessHub 现状：代码路径与本机测量

#### 2.6.1 代码路径（【事实】[S28]）

- **构建**：`buildPublicContext` 用 `find`/`some` 在 runs 和 messages 上做嵌套查找，把每个已终结的 Run 序列化为 JSON，然后检查两个上限：`utf8Bytes(text) > 1 MiB`，以及 `utf8Bytes(JSON.stringify(text)) + 4096 > 1 MiB`（`context.ts:57`）。
- **调用时机**：`execute()` 在每个回合先用完整历史构建一次（`runtime.ts:1334`），之后才按 `throughRunId` 过滤成增量（1338–1339）。切换校验时还会构建一次（1570）。
- **提交**：`runtime.commit()` 依次执行 `assertOwner`、`load`（`store.get` 完整读出、`JSON.parse`、`parseSession`），再执行 `store.transact`。`transact` 内部又做一遍：
  1. 再次 `readSession`（又一次解析与校验）；
  2. 深度 `freeze`；
  3. 处理 `drafts`（事件 JSON 结构检查、序列化、再解析）；
  4. 对 next 做 `parseSession`，其末尾含一次 `JSON.stringify`；
  5. `assertSessionTransition`（对每个已终结 Run 做 `JSON.stringify` 比较）；
  6. 把整份快照 `UPDATE` 进去；
  7. 用 `SUM(length(event_json))` 扫描事件日志预算；
  8. 在 WAL 模式、`synchronous=FULL` 下 `COMMIT`。
- **流式输出**：ADR-047 把文本合并为不超过 100 ms 或 16 KiB 的窗口，**每个窗口仍是一次整份快照事务**；ADR 已写明这一点（快照缓存属于 M2）[S29]。
- **内容存储**：工具详情以 JSON blob 按 sha256 寻址存放（单条最多：输入 16 KiB、输出 64 KiB、差异 64 KiB）；每次读取都要打开新的 SQLite 连接。

#### 2.6.2 测量 A：CPU 单项（合成会话，p50/p95，单位 ms）【测量】[S30]

| 快照 | Runs、工具数 | `JSON.stringify` | `JSON.parse` | `utf8Bytes` | `Buffer.byteLength` | sha256 | `parseSession`（含 parse） | `freeze`（含 parse） | `assertSessionTransition` | `buildPublicContext`（全量） |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 0.81 MiB | 40、480 | 0.67 | 0.65 | 0.16 | 0.03 | 0.31 | 2.95 / 3.90 | 0.72 | 0.92 | 1.10 ms，成功（497 KiB） |
| 0.99 MiB | 48、576 | 0.88 | 0.79 | 0.15 | 0.04 | 0.39 | 3.72 / 5.53 | 0.91 | 1.13 | 1.25 ms，成功（615 KiB） |
| 4.05 MiB | 160、2,560 | 3.49 | 3.09 | 0.75 | 0.17 | 1.59 | 18.0 / 19.2 | 3.58 | 4.49 | 3.50 ms，**`CONTEXT_TOO_LARGE`** |
| 7.98 MiB | 256、5,120 | 6.93 | 6.42 | 1.50 | 0.35 | 3.13 | 38.8 / 47.6 | 7.44 | 8.73 | 6.17 ms，**`CONTEXT_TOO_LARGE`** |

- 交接单量级的输入：sha256 在 32 KiB 时 0.01 ms、128 KiB 时 0.05 ms、512 KiB 时 0.19 ms（约 2.6 GB/s）。
- 【测量】解析后的 7.98 MiB 快照驻留约 11.6 MiB 堆内存；一次提交至少同时存在 3 份解析副本。

#### 2.6.3 测量 B：真实 `SqliteSessionStore` 的提交成本【测量】[S30]

- **`store.get()`**：约 1 MiB 时 4.8 / 6.1 ms；约 7.6 MiB 时 34.9 / 36.6 ms。
- **一次窗口提交**（等同 `runtime.commit`：`get` + `transact`）：

  | 快照 | 窗口大小 | p50 | p95 |
  |---|---|---:|---:|
  | 1.02 MiB | 60 B | 20.6 ms | 22.8 ms |
  | 1.34 MiB | 16 KiB | 21.4 ms | 24.6 ms |
  | 7.62 MiB | 60 B | **144.1 ms** | **151.5 ms** |

  7.6 MiB 时一次提交已超过 100 ms 的窗口周期，流式期间事件循环基本被提交占满。
- **成本随大小增长**：每次追加一个已完成的 Run，提交耗时依次为 0.02 MiB 1.8 ms、0.75 MiB 14.1 ms、1.47 MiB 23.7 ms、2.97 MiB 49.7 ms、3.98 MiB 73.3 ms、4.98 MiB 99.2 ms、6.49 MiB 127.7 ms、7.62 MiB 147.7 ms，**约为 19 ms/MiB**，近似线性。
- 【推断】按各步拆分，7.6 MiB 时一次提交约为：两次读解析 2×35 ms、对 next 做 `parseSession` 约 39 ms、`freeze` 7 ms、`assertSessionTransition` 9 ms、`stringify` 7 ms、SQLite 写入 16 ms，合计约 148 ms，与实测的 144 ms 吻合。真正的 SQLite I/O 只占约 11%，其余是 JSON 处理与校验的 CPU。

#### 2.6.4 测量 C：经正式 `SessionRuntime` 入口、使用零延迟假 Harness【测量】[S30]

做法：用真实的 `SessionRuntime` 与 `SqliteSessionStore`；假 Harness 的 `initialize`、`open`、`checkpoint`、`startText` 都立即完成，每回合回复 3 段文本。先通过 Store 写入 alpha 的长对话，并保持 alpha 的原生绑定 ready 且同步到最后一个 Run，然后依次执行：

- S1：在 alpha 上普通续接；
- S2：切到 bravo 后的首回合（全量公共历史）；
- S2′：bravo 第二回合；
- S3：返回 alpha（只补增量）。

**长回复画像**（每回合输入 0.8 KB、回复 16 KB、思考 3 KB、16 个工具）：

| 快照 | S1 续接 | S2 切换首回合 | 受理→派发（Hub 自身） | 每回合总耗时 |
|---|---|---|---:|---:|
| 0.50 MiB（22 回合） | 成功，原样发送输入 | 成功，375 KiB JSON | 77 ms | 133 ms |
| 0.91 MiB（40 回合） | 成功 | 成功，681 KiB | 137 ms | 237 ms |
| 1.07 MiB（47 回合） | 成功 | 成功，800 KiB | 160 ms | 278 ms |
| 1.21 MiB（53 回合） | 成功 | 成功，902 KiB | 188 ms | 323 ms |
| **1.50 MiB（66 回合）** | **失败 `CONTEXT_TOO_LARGE`**，未派发 | 失败 | — | 142 ms 后失败 |
| 4.01 MiB（176 回合） | 失败 | 失败 | — | 410 ms 后失败 |
| 5.70 MiB（250 回合） | 失败 | 失败 | — | 约 600 ms 后失败 |

**短公共文本画像**（回复 1.5 KB，思考 26 KB，快照大但历史小）：

| 快照 | 受理→派发 | 其中 preparing→ready | 每回合总耗时 | 每回合提交次数 |
|---|---:|---:|---:|---:|
| 1.01 MiB | 143 ms | 81 ms | 257 ms | 11 |
| 4.02 MiB | 645–669 ms | 353–378 ms | 1.12–1.19 s | 11 |
| 7.53 MiB | **1,251–1,414 ms** | 683–798 ms | **2.19–2.41 s** | 11 |

S3 返回 alpha 时补发的增量是 2.6 KiB（bravo 两个回合的 JSON），符合预期。

- 【事实，经测量证实】**D3（同 R4）**：同一 Harness 的绑定 ready 且已同步，本回合只会发原样输入，但 `runtime.ts:1334` 先对完整历史做预算，超限后整个回合失败。之后该对话每个回合都失败；历史只增不减，对话永久停摆。
  - 长回复画像下，阈值在 53 到 66 个回合之间（渲染后的公共历史约 0.9 MiB，快照约 1.2–1.5 MiB）。
  - 不是极端场景：单条回复最多 1 MiB，几次长回复就能越线（R4 的 R3 用例）。
- 【测量】最小回合（无工具）也有 11 次整份快照提交，其中派发前至少 6 次：受理、preparing、context_prepared、protocol、binding_prepared、authorized、dispatched。真实回合里每个工具、plan、usage、notice、activity 事件各一次提交，提交次数会到几十次。
  - 【推断】7.6 MiB 时，40 次提交约为 5.8 s 的同步主线程 CPU，期间其他对话、HTTP 与 SSE 全部排队。

#### 2.6.5 测量 D：写放大、账本追加与其他 I/O【测量】[S30]

| 操作 | 结果 |
|---|---|
| 整份快照 `UPDATE`+`COMMIT`（纯 SQLite，不含 JSON 校验），1.00 MiB，改动 60 B | 2.3 ms；**WAL 记录 1.05 MiB/次（1.05×快照）** |
| 同上，7.94 MiB | 16.0 ms；**WAL 记录 8.18 MiB/次（1.03×）** |
| 【推断】默认自动检查点（1000 页）会把同样的页再写进主库 | 实际落盘约 2×快照/次。60 B 窗口在 1 MiB 时约 1.7 万倍写放大，在 8 MiB 时约 14 万倍。8 MiB 时，一段约 2 分钟的流式回复受每次提交 144 ms 所限，约有 800 次窗口提交：WAL 写入约 6.5 GiB，加上检查点约 13 GiB |
| 账本式追加（约 1 KiB 条目，独立表，WAL+FULL） | **0.06 ms p50 / 0.75 ms p95；WAL 约 8 KiB/次** |
| 读出并解析 2,000 条账本条目（约 0.9 MiB） | 2.0 ms |
| 事件日志预算查询 `SUM(length(event_json))`，16,384 条事件（37 MiB） | 7.3 / 7.6 ms，**每次提交都执行** |
| 读出、校验 sha256 并解析工具详情：100 条×40 KiB / 500 条×20 KiB / 2,000 条×10 KiB | 4.9 / 15.3 / 41.1 ms（页缓存已热） |
| 合成 git 仓库（3,000 个文件，改动 40 个）：`status --porcelain=v2 -uall` / `diff --numstat` / 完整 diff + sha256 | 15.3 / 18.7 / 17.8 ms |
| 同上，用临时 index 执行 `add -A` 加 `write-tree`（精确的树指纹） | 270.6 / 289.0 ms |

- 【推断】macOS 上 fsync p50 只有 0.06 ms，说明 `synchronous=FULL` 没有用到 `F_FULLFSYNC`，掉电时的持久性弱于 Linux 上同名设置。这与接力无关，记为存储层的待查项。

### 2.7 交接代价模型【推断】

**符号**：
- 目标模型单价：未缓存输入 `p_in`、缓存写 `p_w`、缓存读 `p_r`、输出 `p_out`。OpenAI ≤5.5 与 DeepSeek 没有写入加价，`p_w = p_in`。
- `S_B`：目标的固定前缀（system 加工具定义），约 8–30k token，下文取 15k【假设】。
- `T`：交接单 token 数；`Δ`：返回时需要补的增量；`N_X`：Harness X 的原生上下文大小。
- `q`：每个用户回合的模型请求次数；`R`：交接后到目标压缩或会话结束为止，重读交接单的请求数，`R = Σq`。
- `P`：未缓存预填充吞吐（tok/s）。
- `TTL_X`：Harness X 的缓存寿命（Claude Code 订阅为 1h、API key 为 5m；Codex gpt‑6.1 至少 30m；DeepSeek 几小时以上）；`g`：用户空闲间隔。

**公式**：
1. **单次交接 X→B（B 为新原生会话），归因于接力的额外费用**：
   `C_relay = T·p_w + T·p_r·(R−1) + C_gen + C_pull`，单位 token 的“生命期价格”为 `π = p_w + p_r·(R−1)`。
   - `C_gen`：模型生成摘要的费用，确定性构建为 0。
   - `C_pull = Σ_j t_j·π_j + n_pull·(S_B+T)·p_r`：按需拉取时，每次拉取多一次请求、重读一次前缀。
2. **首回合附加时延**：`ΔTTFT ≈ (T + S_B·[S_B 冷])/P + n_pull·RTT + [摘要阻塞时] (TTFT_A + T_s/v_out)`。
3. **TTL 冷重写**：每个大于 `TTL_B` 的用户空闲间隔，都会把包含交接单的整段前缀按 `p_w` 重写一次：`C_cold = Σ_{g_i>TTL}(S_B + T + C_i)·p_w`。
4. **A→B→A 返回 A**：
   - 原生续接：`C = N_A·(热 ? p_r : p_w) + Δ·p_w`，冷时附加 `N_A/P` 的时延；
   - 改为新会话加交接单：`C = S_A·p_r + T·p_w`；
   - “热”的判定：`now − lastRequestAt_A < TTL_A`。
5. **同 Harness 换模型**：原地换 `C = N·p_w(新模型)`，附加 `N/P` 时延；新原生会话加交接单 `C = (S+T)·p_w(新模型)`。
6. **反模式**：每个回合都追加一个 b token 的“当前状态块”，n 回合累计重读 `Σ_{i≤n} i·b·q·p_r`，呈**二次方**增长。b=2k、n=50、q=8 时，Opus 5.5 上约 $4.08。

**假设**（`cost-model.mjs`）：
- 每回合公共文本：用户 150 token，可见回复 700 token；现有 JSON 包装与转义另加约 15%（长回复时只有 5% 左右）。
- 交接后 `R = 80`（10 个回合×8 次请求）；`P = 8k tok/s`；摘要输出速度 60 tok/s，由来源 Opus 5.5 写，读取其约 12k token/回合的原生上下文（热缓存，上限 160k）。
- 结构化交接单 `T = min(1.5k + 120·n, 14k) + 最近 3 个回合原文（2.55k）`；摘要 2.5k、4k、6k；拉取方式常驻 2k，按 10、50、200 回合分别拉取 2、4、6 次，每次 3k，每次附加 3 s。

**每次交接的额外费用与首回合附加时延**（格式：注入 token · 费用 · 附加时延）：

| 目标模型 | 策略 | 10 回合 | 50 回合 | 200 回合 |
|---|---|---|---|---|
| Claude Opus 5.5（5m） | 全量历史（现状 JSON） | 9.8k · $0.20 · +1.2 s | 48.9k · $1.02 · +6.1 s | 195.5k · **$4.07** · **+24.4 s** |
| | 结构化交接单 | 5.3k · $0.11 · +0.7 s | 10.1k · $0.21 · +1.3 s | 16.6k · **$0.34** · **+2.1 s** |
| | 摘要（来源 Harness 写） | 2.5k · $0.13（其中生成 $0.08）· **+46 s** | 4.0k · $0.20（$0.11）· **+71 s** | 6.0k · $0.28（$0.15）· **+105 s** |
| | 按需拉取 | 2k+拉取 6k · $0.17 · +6.3 s | 2k+12k · $0.31 · +12.3 s | 2k+18k · $0.44 · +18.3 s |
| GPT‑6.1 Sol（Codex 默认；Sonnet 5.5 同价） | 全量 / 结构化 / 摘要 / 拉取 | $0.10 / $0.055 / $0.10 / $0.087 | $0.51 / $0.105 / $0.156 / $0.152 | $2.03 / $0.172 / $0.216 / $0.218 |
| DeepSeek V4 Flash（dsh 默认，高峰价） | 全量 / 结构化 / 摘要 / 拉取 | $0.008 / $0.004 / $0.078 / $0.006 | $0.038 / $0.008 / $0.117 / $0.011 | $0.151 / $0.013 / $0.159 / $0.016 |

各模型下附加时延相同，因为都按同一个 `P` 计算；`P` 取 16k tok/s 时，预填充部分减半。

**每 1k 注入 token 的生命期价格**（写入 1 次、读取 79 次）：
- Opus 5.5：$0.0208（5.2×`p_in`）
- Sonnet 5.5 与 GPT‑6.1 Sol：$0.0104（5.2×）
- GPT‑5.5：$0.0445（8.9×）
- DeepSeek V4 Pro：$0.0048（3.6×）
- DeepSeek V4 Flash：$0.0008（2.6×）

**A→B→A 返回 A**（Opus 5.5、5m，Δ=5k，`S_A`=15k 已缓存，交接单 12k）：

| `N_A` | 原生续接，缓存热 | 原生续接，缓存冷（超过 TTL） | 新会话加交接单 |
|---|---:|---:|---:|
| 40k | $0.033 | $0.225 · +5.0 s | $0.063 · +1.5 s |
| 150k | $0.055 | **$0.775 · +18.8 s** | $0.063 · +1.5 s |
| 400k | $0.105 | **$2.03 · +50 s** | $0.063 · +1.5 s |

**同 Harness 换模型**：
- N=150k 时，原地换到 Sonnet 5.5（5m）一次 $0.375，换到 Opus 5.5（1h，写入 2×）一次 $1.20，都附加约 19 s；改用 12k 交接单只需 $0.03–0.10，附加约 1.5 s。
- 这与 Claude Code 团队的建议（改由子 Agent 接手）一致 [S7]。

**价格悬崖**：
- Haiku 5.5 的提示超过 100k token 时，整次请求的所有 token 都按 5 倍价计 [S1]；OpenAI GPT‑5.4 及以上的输入超过 272K 时，输入价翻倍 [S9]。
- 如果交接单把目标的提示推过阈值，此后每次请求都要付悬崖价。

### 2.8 摘要的代价、后台预计算与预取【推断】

| 谁来生成 | 费用 | 时延 | 性质 |
|---|---|---|---|
| 来源 Harness 的最后一个回合（“写交接说明”） | 热读 `N_A·p_r^A` 加输出 `T_s·p_out^A`。Opus 5.5 下 N_A=120k、T_s=4k 约 $0.024+$0.08≈$0.10；加思考会更多 | 首 token 加 `T_s/v_out`：2.5k–6k token 约 46–105 s | 覆盖最全（能看到工具结果），但属模型自述；写进 A 的转录，用原生 fork 可以避免，Claude Code 的 fork 能读父会话缓存 [S5] |
| 接收方首回合（直接给原文，让 B 自己读） | 等同“全量历史”，落在 B 身上，且按读价随每次请求重复 | `H/P` | 无额外调用，但成本和时延随历史线性增长 |
| 确定性规则（账本投影） | 0 token；CPU 为毫秒级 | 小于 10 ms | 可追溯、可重建、字节确定；但对“为什么”的覆盖有限 |
| Hub 自有模型 | — | — | 当前没有；按 brief §4 不能静默使用用户的模型 |

- **后台预计算**（sleep‑time，每个 Run 结束后增量更新一份模型摘要）：
  - 每个 Run 的成本 `c_s ≈ N·p_r + Δs·p_out`，Opus 5.5 约 $0.01–0.05。若每个 Run 之后切换的概率为 p，平均每份**真正被用上**的摘要花费 `c_s/p`；p=5% 时约 $0.2–1.0，是按需生成（约 $0.08–0.15）的数倍，换来的是切换时省掉 46–105 s。
  - 还有过期（必须带水位）、内容跨厂商流动、没有用户选定的摘要模型三个问题。
  - Sleep‑time 论文本身指出，收益取决于查询能否预判 [S18]。
  - 结论：确定性账本在后台维护；**模型摘要不在后台默认运行**。
- **预取**（用户打开选择器时）：
  - 为每个候选目标预渲染交接单（CPU 毫秒级，内容寻址缓存），并显示估算的 token、费用与时延。没有副作用，有新 Run 时自然失效。
  - 打开选择器时预启动目标 Harness，能省 1–5 s，但会带来进程、资源和启动副作用（更新检查、MCP 拉起、认证提示）。项目已经删掉过“每次选择都启动目标”的旧实现 [S29]。

---

## 3 模式归纳

1. **所有厂商都是前缀精确匹配，且按模型、组织（workspace）隔离**。没有任何机制跨厂商或跨模型复用 KV。接力中真正跨边界的只有文本，所以每次换 Harness 或换模型，注入的内容在目标上都是一次冷写 [S2][S8][S11][S16]。
2. **读取已经很便宜，代价转到写入与重读次数上**：
   - 读取价：Anthropic 0.025–0.1×，OpenAI 0.05–0.1×，DeepSeek 0.02–0.033×。
   - 写入价：Anthropic 1.25–2×，OpenAI 5.6+ 1.25–2.5×，OpenAI ≤5.5 与 DeepSeek 不加价。
   - 交接单的长期成本 ≈ 写入 1 次 + 重读 R 次，R 通常有几十次。
3. **Harness 们的共同做法**：
   - 静态内容在前、动态内容作为消息追加（Claude Code 的 system‑reminder、plan mode 与 skills）；
   - 工具集确定，用延迟加载或屏蔽代替移除；
   - 压缩或摘要走“缓存安全的分叉”；
   - TTL 按节奏选择（Hermes 的 `auto`，Claude Code 订阅用 1h）；
   - 保温心跳（OpenClaw）[S5][S7][S21][S25][S26]。
4. **分歧**：
   - 谁放缓存标记：Claude Code、Hermes、OpenClaw 显式放置；Codex、dsh 依赖厂商自动缓存。
   - 默认 TTL：5m、30m、1h、几小时到几天不等。
   - 缓存键：Codex 由会话派生，新会话不复用。
   - 压缩：都由各 Harness 自己的模型完成，没有跨 Harness 的标准。
5. **研究上的共识**：
   - 增量条目优于整体改写 [S19]；
   - 与查询无关的压缩优于随查询变化的压缩，后者会破坏缓存 [S17]；
   - 只缓存稳定前缀最稳 [S15]；
   - 回合边界的空闲会让命中率从 90% 掉到 55% [S16]；
   - 后台预计算只有在可预判时才划算 [S18]。
6. **HarnessHub 的特殊点**：
   - Hub 不直接调用模型，只能影响注入的内容、位置、时机与大小；
   - Hub 自身的存储层按会话大小线性变慢；
   - 现有交接单是“历史 JSON 嵌在用户消息里”，与上述所有实践相反：随历史线性增长、带转义、超限即停摆。

---

## 4 对 HarnessHub 接力的启示

### 4.1 交接单与预算

1. **【采用】确定性、与下一条输入无关的交接单；切换路径上不调用模型。**
   - 机制：`packet = render(ledger@watermark, policyVersion, tier, targetFamily)`，正文存入内容存储（sha256 寻址），快照与事件里只放引用、指纹、水位和未包含清单。
   - 依据：随查询变化的压缩会破坏缓存 [S17]；同一份字节能在重试、先试 B 再试 C 时复用（见第 12 条）。
   - 目标：构建 p50 ≤ 5 ms。
2. **【采用】分层预算**：
   - 常驻核心不超过 4k：目标、约束、决定、待办、改动摘要、未决审批、失败与教训；
   - 最近 2–3 个回合原文约 2–3k；
   - 引用：run、tool、content 的 ID 与路径，按需取用。
   - 档位：“精简”≤4k；“标准”（默认）≤8k；“完整”≤32k 且不超过目标窗口的 5%；“全量原文”只在用户显式选择时提供，并先给出 token、费用、时延估算。
   - 边际成本：每 1k token 约 5.2×`p_in`（Opus 5.5 约 $0.021、GPT‑6.1 约 $0.010、DeepSeek Flash 约 $0.0008），预填充约 +0.05–0.12 s。质量评测证明需要时可以上调默认值，边际价按上面计算。
   - 按策略选档，记录未包含的内容，**不静默截断**。
3. **【拒绝】默认注入全量公共历史 JSON（现状）。**
   - 理由：随历史线性增长；200 回合时每次交接约 $4.07、多约 24 s；渲染后约 0.9 MiB 就停摆（2.6.4 已证实）；JSON 字符串中的 `\n`、`\"` 转义把多行代码压成一行，token 和可读性都更差（推断，未测 token）。
   - “全量原文”档改为纯文本分页渲染（不再把 JSON 嵌在字符串里），并且只作显式选项。
4. **【改造后采用】按需拉取。**
   - 常驻索引不超过 2k；细节经以下两种通道之一取用：
     - 会话级 MCP：**只能在建立会话时挂接**，中途增减工具会让未延迟加载工具的 Harness 缓存失效 [S5]；工具定义约 0.5–2k token，会随每次请求按读价重读；
     - Hub 自有的只读文件：用原生 Read 读取，无需工具定义；具体位置由通道组决定。
   - 每次拉取多一次往返（约 1–3 s）并追加 token；只有预计每次交接拉取不超过 2–3 次时才比把内容放进交接单便宜（2.7 节表）。
   - 在会话级 MCP 未核实的 Harness 上默认关闭。
5. **【拒绝】切换路径上阻塞式模型摘要**（46–105 s；需要模型；不确定）。
   **【改造后采用】“请 A 写交接说明”作为显式用户动作**：作为 A 的普通回合，或在原生 fork 中运行；结果作为派生材料，标注“模型自述”、水位与来源，放进交接单的“来源方说明”栏，上限约 2k。
6. **【采用】价格悬崖与窗口保护。**
   - 派发前估算目标的“交接后提示长度”，避免越过 Haiku 5.5 的 100k（5 倍）和 OpenAI 的 272K（输入 2 倍）[S1][S9]；需要时降档。
   - 降档只能是可见的策略结果（记录未包含内容），不能静默截断。
   - token 估算的系数按模型族校准：Claude 4.7+ 约多 30% [S1]；不能用 tiktoken 去估 Claude [S3]。

### 4.2 缓存友好的注入

7. **【采用】注入位置与方式。**
   - 交接单作为新原生会话的**第一条用户消息**；如果某个 Harness 支持会话级 system 追加，那么只在该会话内不变时才放在那里。
   - A→B→A 只追加 Δ，绝不重写早先的块。
   - 不在每个回合追加状态块（二次方成本：50 回合约 $4.08）。
   - 目标压缩后，确有需要时只补一次“账本头”增量。
8. **【采用】字节确定性。**
   - 规范排序与格式；开头不放时间戳、随机 ID 或绝对时间；水位与指纹放在末尾。
   - 测试：同一输入重建 100 次只得到 1 个 sha256；用 golden 文件锁定格式；`policyVersion` 变化时视为新前缀，并在交接记录里体现。
9. **【采用】返回原 Harness 时感知 TTL 与原生上下文大小。**
   - 每个绑定记录 `lastRequestAt`、TTL 类别（按 Harness 与登录方式）和 `usage.context.used`。
   - 返回前展示“原生续接（缓存热，约 $0.06）”与“缓存可能已过期（约 19 s、约 $0.78）”的估算，以及“以交接单新建原生会话（约 1.5 s、约 $0.06）”这一选项（数字以 N_A=150k、Opus 5.5 为例）。
   - **不自动改变接续等级**，由用户选择，并记录在交接记录里。
10. **【改造后采用】切换后短期保留来源 Harness 的进程**（扩展 ADR-030）。
    - 每个对话最多 2 个保留进程；保留时长不超过 min(TTL, 10 分钟)；计入 `KEPT_LIMIT=4`；用户可见、可关闭。
    - 在此窗口内 A→B→A 的启动从 1.3–5 s 降到约 7 ms [S29]。
    - 注意：prompt 缓存在服务端，与进程是否存活无关。保留进程只省启动时间，不省缓存。
11. **【采用】同 Harness 换模型时提供“新原生会话加交接单”的选项。**
    - 原生上下文 N≥40k 时显示估算：N=150k 原地换 $0.375–1.20、约 +19 s，交接单 $0.03–0.10、约 +1.5 s。
    - 依据：Claude Code 团队的建议 [S7]，以及 R09（同一 Session 可切模型）。
12. **【采用】Hub 侧缓存交接单字节**：以（账本水位, policy, tier, targetFamily）为键，复用渲染结果，以及在原生分叉、重试时保持字节一致。厂商侧缓存无法跨厂商或跨模型共享，只能靠这一层复用。

### 4.3 账本与存储

13. **【采用（前置修复）】去掉每个回合的全量历史构建**（`runtime.ts:1334`）。
    - 先确定增量来源，只对将要发送的内容做预算；切换校验（1570）同理。
    - 回归测试：在 8 MiB 快照上，同一 Harness 的续接永不出现 `CONTEXT_TOO_LARGE`（当前在 1.5 MiB 失败，2.6.4 节）。
    - 顺带省掉每个回合 1–6 ms 的序列化。
14. **【采用】工作账本单独建表，按 Run 增量维护（O(Δ)）。**
    - 结构：`relay_ledger(session_id, seq, run_id, kind, entry_json, sha256)` 加 `relay_head(session_id, through_run_id, policy_version, head_json, fingerprint)`。
    - 在 `run.ended` **所在的同一个 SQLite 事务**里追加（不多提交、不多 fsync、不多事件）；每个 Run 写入不超过 64 KiB；能从公共事实全量重建（INV-22），0.9 MiB 条目约 2 ms。
    - 实测：追加 0.06 ms（p95 0.75 ms），每次约 8 KiB；对照整份快照重写，每次 1.03–1.05×快照。
    - 可行性：一个 Run 的全部输入在结算时都已有上限（工具 ≤128、plan ≤64、文本 ≤1 MiB、输出 ≤32），折叠一次是 O(该 Run 的大小)；按路径索引文件改动、按规范化哈希去重决定与待办，投影成本是 O(预算)，与历史长度无关。
15. **【拒绝】把账本或交接单放进 Session 快照 JSON。** 每多 1 MiB，每次提交多约 19 ms；每个回合至少 11 次提交，每次提交还要 3 次全量校验；快照的 8 MiB 上限与消息共享。
16. **【拒绝】由 ADR-047 的文本窗口驱动账本。**
    - 窗口本身已经是 O(S) 的提交；账本只需要结算时的最终文本；交接只发生在 Run 边界（切换不转移正在运行的工具）。
    - ADR-047 的崩溃语义（最多丢一个从未发布的窗口，Run 记为 unknown）对账本的影响：unknown 的 Run 只记为“结果未知”，不当作已完成的工作。
17. **【采用】交接单正文进内容存储，事件只带引用。**
    - 事件上限 2 MiB/条、32 MiB/16,384 条/会话；每次交接最多 1 条新事件（或并入 `run.context_prepared`），不为每个账本条目发事件。
18. **【改造后采用】工作区指纹。**
    - 交接时执行 `git status --porcelain=v2` 和 `diff --numstat`（3k 个文件时 15–19 ms）。
    - 精确树哈希（约 270 ms）只在用户要求严格核验时做。
    - 非 git 工作区做有上限的 mtime/size 扫描，超出上限标记“未核验”，不阻塞派发。
19. **【改造后采用（前置，属 M2）】降低整份快照提交的成本。** 不属于接力本身，但决定了大会话里“切换生效到派发”的时延：7.5 MiB 时 Hub 自身就要 1.25–1.41 s；窗口提交 144 ms，已超过 100 ms 的窗口周期。
    - 低成本改动：
      1. `runtime.commit` 不再先 `load` 再在 `transact` 里读第二遍（约 −35 ms@7.6 MiB）；
      2. 按 `version` 缓存已校验的快照（约 −35 ms）；
      3. 对已终结且未变化的 Run 跳过重复校验（约 −30 ms）；
      4. 事件日志字节改用计数列，替代 `SUM` 扫描（约 −7 ms@16k 条事件）。
    - 预期可降到约 45 ms/提交（推断）。长期改为按行存储，使提交成本为 O(Δ)。

### 4.4 预计算、预取与进程

20. **【采用】后台确定性维护账本；打开选择器时预渲染并给出估算**（CPU 毫秒级，不调用模型，不启动进程）。估算显示 token、费用（按当日价格表，见第 6.1 条风险）和首回合附加时延。
21. **【拒绝】默认在后台生成模型摘要（sleep‑time）。**
    - 理由：每份真正被用上的摘要花费 c_s/p，切换概率 5% 时约 $0.2–1.0，是按需生成（$0.08–0.15）的数倍；没有 Hub 自有模型；内容在用户没有切换意图时就流向模型。
    - R05 的自动路由落地、能预判切换时，可以作为显式开关再评估 [S18]。
22. **【拒绝】打开选择器即预启动目标 Harness。** 每次启动 1–5 s，并有启动副作用；旧实现已因此删除 [S29]。改用第 10 条的保留进程。

### 4.5 可测量的性能目标（建议）

| 指标 | 定义与测量点 | 当前基线（2.6 节） | 建议目标 |
|---|---|---|---|
| 正确性：续接不因历史超限失败 | 同 Harness 绑定已同步时，任何快照大小（≤8 MiB）的续接都不报 `CONTEXT_TOO_LARGE` | 1.5 MiB 失败 | 0 次（回归测试） |
| 交接构建 p50/p95 | 从读取账本到交接单字节加 sha256 就绪（进程内计时），不含工作区指纹 | 现有全量 JSON 1.1–6.2 ms，但超过约 0.9 MiB 即失败 | p50 ≤ 5 ms、p95 ≤ 25 ms（8 MiB）；读取不超过 500 条差异时 p95 ≤ 60 ms |
| 工作区指纹 | `git status` 加 `diff --numstat` | 15–19 ms（3k 个文件） | 2 万个文件以内 p95 ≤ 200 ms；超时则标记“未核验” |
| 接力对派发路径的增量 | 相对“同 Harness 普通续接”，交接回合在受理→派发上的差值（假 Harness 基准） | — | 至多多 1 次整份快照提交、CPU ≤ 10 ms |
| 切换生效到派发（Hub 自身） | `dispatchedAt − preparingAt` 减去 Harness 的 initialize 与 open（零延迟假 Harness 基准） | 0.08 s（0.5 MiB）、0.14 s（1 MiB）、0.65 s（4 MiB）、1.25–1.41 s（7.5 MiB） | ≤1 MiB 时 p95 ≤ 150 ms；完成第 19 条后 8 MiB 时 p95 ≤ 400 ms；改为按行存储后 p95 ≤ 150 ms |
| 首回合附加时延 | 交接后首回合的 `firstOutputAt − dispatchedAt`，减去同 Harness 无交接回合的中位数 | 未测 | 标准档（≤8k）p50 ≤ +1.5 s |
| 注入 token | 派发前估算值；实际值取目标上报用量的增量 | 现状约 1.15×H | 精简 ≤4k；标准 ≤8k；完整 ≤32k 且不超过窗口的 5% |
| 估算误差 | \|估算 − 实际\| / 实际 | — | p90 ≤ 20%（按模型族校准） |
| 缓存命中率 | 目标每次请求的 `cachedInput / (input + cachedInput + cacheWrite)`（`NativeUsage.turn`） | 未测 | 交接后第 2 次请求起 ≥ 85%；TTL 内返回时首次请求 ≥ 80% |
| 每次交接额外费用 | 用 `C_relay` 公式和当日价格表估算，事后用上报用量核对 | 200 回合全量约 $4.07（Opus 5.5） | 标准档在 Opus 5.5 档模型、200 回合以内 ≤ $0.35；预计超过 $0.10 时先展示估算 |
| 账本更新 | 每个结算的 Run | — | p95 ≤ 5 ms CPU；写入 ≤ 64 KiB；0 次额外整份快照提交；≤1 条额外事件 |
| 存储增长 | 每个会话的账本字节数 | — | 每会话 ≤ 2 MiB；交接单进内容存储，快照只放引用 |
| 内存 | 构建交接单时额外的峰值堆内存 | 解析一次 8 MiB 快照约 11.6 MiB | 额外峰值 ≤ 16 MiB |

### 4.6 基准方法（建议）

1. **合成会话生成器**（参照 `gen.mjs`，进入 `tests/bench/`，默认不进 CI）：
   - 画像：长回复、多工具、中文为主、代码为主；
   - 大小：0.5、1、4、8 MiB；
   - 切换模式：不切换、A→B、A→B→A、三方轮转、每个回合来回切换；
   - 生成器的输出必须先通过 `parseSession`，保证走真实的校验路径。
2. **进程内微基准**：交接单构建、账本折叠、确定性测试（重建 100 次得到 1 个哈希）。预热后各运行 30 次以上，报告 p50 与 p95，并记录 Node 版本与硬件。
3. **运行时基准**：真实 `SessionRuntime` 加 `SqliteSessionStore`，配零延迟假 `SessionBindingFactory`（与 `bench-runtime.mjs` 同法）。
   - 断言：每回合的提交次数和事件数；受理→派发；交接回合与普通回合的差值；送达目标的字节数。
   - 用 `RunTiming` 的各阶段，并给 `run.context_prepared` 的事件时间戳加一个构建耗时字段。
4. **协议夹具基准**：用 `tests/fixtures/control-peer.mjs`（ACP 与 app‑server）测大交接单的 IPC 分帧与转义成本，并检查各驱动的 `maxFrameBytes` 是否限制交接单大小（夹具上限为 2 MiB）。
5. **token 校准**（离线，不必运行 Harness）：同一批交接单分别用 Claude `count_tokens`、tiktoken `o200k_base`（OpenAI）和 DeepSeek 分词器计数，得出按语言比例与模型族划分的字节→token 系数。
6. **真实小预算验证配方**（供主负责人之后执行，本人未运行）：
   - 选最便宜的两家：dsh（`deepseek-flash`，闲时价）与 Claude Code（Haiku 5.5，0.10/0.50）。
   - 在临时工作区里做一个 10 回合的合成编码任务，每种交接档位各做一次 A→B 和 A→B→A；返回时分“5 分钟内”与“等待超过 5 分钟”两组，以区分缓存热与冷。
   - 记录 `RunTiming`、`NativeUsage`（input、cachedInput、cacheWrite）、注入 token 的估算与实际值；重复 3 次，总预算约 $1。
   - 用户配置不改，凭据不进证据文件。

---

## 5 风险与反模式

1. **破坏缓存的反模式**（第 4.2 节逐条避免）：
   - 每个回合重新渲染并替换早先的块；
   - 在开头放时间戳或随机 ID；
   - 非确定的键序（Map 或 Set 的迭代顺序、对象展开顺序变化）；
   - 会话中途增减 MCP 工具；
   - 原地换模型或换 effort（Claude 5.5 系列可保留 effort 缓存 [S5]）[S2][S5][S7][S21]。
2. **过量注入**：上下文腐化会降低质量 [S22]，而成本按 5 倍左右基础价乘以 token 数增长。“全量”不是“更安全”。
3. **超过 TTL 的隐性成本**：返回 A 时如果缓存已过期，N_A=150k 就要 $0.78 和约 19 s。订阅与 API key 的 TTL 不同（1h 与 5m）[S5]。估算错了会误导用户。
4. **把摘要当权威**：模型写的交接说明可能出现简短偏置或上下文坍缩 [S19]，必须标注为派生、模型自述并带水位，不能覆写事实。
5. **计时侧信道与跨厂商流动**：缓存命中可被计时探测 [S20]。交接单把 A 厂商会话的内容送到 B 厂商，这需要用户知情（属 R 安全组）；预取与后台摘要会在没有切换意图时扩大流动，因此本文拒绝后台摘要。
6. **测量陷阱**：
   - 各驱动的用量口径不同：Codex 只报 token 不报费用，OpenClaw 是近似值 [S29]；
   - Anthropic 的 `input_tokens` 只是未缓存的那部分，总提示长度 = input + 缓存读 + 缓存写 [S3]；
   - OpenAI 早期模型的命中按 128 token 取整，ChatGPT 路线观察到按 1,024 token 一档上报 [S8][S26]。
7. **价格漂移**：价格在几个月内多次变动（Sonnet 5 定价注记，GPT‑5.6 Sol 促销至 11-21）。价格表应集中、带日期、可更新，不写死在代码里；估算界面写明“按某日价格”。
8. **大会话下的事件循环饱和**：在 4 MiB 以上，每次提交 70–150 ms，同步执行；接力如果再加提交、校验或后台任务，会拖慢所有并行对话。第 19 条是前置条件。
9. **写放大与磁盘磨损**：60 B 的窗口在 8 MiB 时约 14 万倍写放大（2.6.5）；账本若放进快照，问题会进一步放大。
10. **token 估算偏差**：中文、代码与 JSON 的比例差异，加上 Claude 4.7+ 约多 30% 的分词器，可能使档位判断越过价格悬崖。必须校准，并留出余量。
11. **macOS 持久性**（推断）：`synchronous=FULL` 没有用到 `F_FULLFSYNC`，掉电时可能丢失最近的提交。这不属于接力问题，转存储组核实。

---

## 6 未解决的问题

1. 当前模型（Opus 5.5、Sonnet 5.5、GPT‑6.1 Sol、DeepSeek V4 Flash/Pro、OpenCode 免费模型）在 10k、50k、200k 输入下的真实预填充吞吐与首 token 时延，没有找到可靠的公开数据，需要按 4.6 节第 6 条做小预算实测。
2. 各驱动经 ACP 或 app‑server 是否上报 `cachedInput` 与 `cacheWrite`，会影响缓存命中率目标能否测量。`NativeUsage` 有这两个字段，但哪些驱动会填写未核实。
3. OpenCode 2.2.5 实际在哪里放缓存标记、用什么 `promptCacheKey`（只有二手来源），以及免费模型的数据使用条款。
4. 订阅额度（Claude Max、ChatGPT Plus/Pro）中缓存读的折算比例：Claude Code 文档写明按缓存价计入额度 [S6]，Codex 或 ChatGPT 的情况未知。
5. 真实的 `R`（交接后每个回合的请求次数、到目标压缩为止的回合数）与切换概率 p，需要从 HarnessHub 自己的 `RunTiming` 与用量统计中取得，只统计数字，不读内容。
6. 交接单质量与大小的关系（决定默认 8k 是否合适），需要质量组的评测。本文只给出边际成本。
7. 账本独立表需要业务库升到 v13，迁移、降级与备份（ADR-049）的成本交存储与契约组评估。
8. `fork()` 引用的历史在超过 1 MiB 时是否同样失败（`quoted()` 的检查），本文未验证。如果失败，对话停摆后连分支逃生也走不通。

---

## 7 来源清单

| 编号 | 标题 | 作者或机构 | 日期或版本 | URL 或路径 | 核实方式 |
|---|---|---|---|---|---|
| S1 | Pricing | Anthropic | 页面无日期，2026-11-02 读取 | https://platform.claude.com/docs/en/about-claude/pricing | 打开原文 |
| S2 | Prompt caching | Anthropic | 页面无日期，2026-11-02 读取（读了前 10 万字符） | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | 打开原文 |
| S3 | claude-api skill：prompt-caching.md、token-counting.md（本机随附参考） | Anthropic（Claude Code 随附 skill 2.1.309，模型表缓存于 2026-10-06） | 2026-10-06 | `/private/tmp/claude-501/bundled-skills/2.1.309/…/claude-api/shared/` | 本机文件，与 S1 冲突处以 S1 为准 |
| S4 | Prompt caching with Claude（时延表） | Anthropic | 2025-08-14 更新（2024-12-17 GA） | https://claude.com/blog/prompt-caching | 打开原文 |
| S5 | How Claude Code uses prompt caching | Anthropic（Claude Code 文档） | 2026-11-02 读取 | https://code.claude.com/docs/en/prompt-caching | 打开原文 |
| S6 | Manage costs effectively | Anthropic（Claude Code 文档） | 2026-11-02 读取 | https://code.claude.com/docs/en/costs | 打开原文 |
| S7 | Lessons from building Claude Code: Prompt caching is everything | Thariq Shihipar（Anthropic） | 2026-04-30 | https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/ | 打开原文 |
| S8 | Prompt caching guide | OpenAI | 页面无日期，2026-11-02 读取 | https://developers.openai.com/api/docs/guides/prompt-caching | 打开原文 |
| S9 | API Pricing | OpenAI | 页面无日期，2026-11-02 读取（含 2026-07-30、11-01、11-21 等日期注记） | https://developers.openai.com/api/docs/pricing | 打开原文 |
| S10 | Models & Pricing | DeepSeek | 2026-11-02 读取（deepseek-flash = V4.1-Flash-1017，v4-pro = V4-Pro-0813） | https://api-docs.deepseek.com/quick_start/pricing | 打开原文 |
| S11 | Context Caching（KV cache guide） | DeepSeek | 2026-11-02 读取 | https://api-docs.deepseek.com/guides/kv_cache | 打开原文 |
| S12 | Context Caching is Available | DeepSeek | 2024-08-02 | https://api-docs.deepseek.com/news/news0802 | 打开原文 |
| S13 | OpenCode Zen 文档 | OpenCode（anomalyco） | 2026 | https://opencode.ai/docs/zen | 仅搜索摘要（站点抓取被拒） |
| S14 | Performance benchmarking methodology | Artificial Analysis | v2.2.0，2026-03-02 | https://artificialanalysis.ai/methodology/performance-benchmarking | 打开原文 |
| S15 | Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks | Elias Lumer 等（PwC） | arXiv 2601.06007 v2，2026-01-31 | https://arxiv.org/html/2601.06007v2 | 打开原文（HTML） |
| S16 | Agentic Coding in the Wild: Characterizing GitHub Copilot Traces at Production Scale | Banruo Liu、Haoran Qiu、Íñigo Goiri、Rodrigo Fonseca、Ricardo Bianchini、Esha Choukse | arXiv 2608.00101 v1，2026-07-30 | https://arxiv.org/abs/2608.00101 | 打开原文（摘要页）；“4.88×”等二手数字未采用 |
| S17 | Cache-Aware Prompt Compression: A Two-Tier Cost Model for LLM API Caching | Yan Song | arXiv 2607.15516 v1，2026-07-17 | https://arxiv.org/abs/2607.15516 | 打开原文（摘要页） |
| S18 | Sleep-time Compute: Beyond Inference Scaling at Test-time | Kevin Lin、Charlie Snell、Yu Wang、Charles Packer、Sarah Wooders、Ion Stoica、Joseph E. Gonzalez | arXiv 2504.13171，2025-04-17 | https://arxiv.org/abs/2504.13171 | 打开原文（摘要页） |
| S19 | Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models | Qizheng Zhang 等 | arXiv 2510.04618 v3，2026-03-29（ICLR 2026） | https://arxiv.org/abs/2510.04618 | 打开原文（摘要页） |
| S20 | Auditing Prompt Caching in Language Model APIs | Chenchen Gu、Xiang Lisa Li、Rohith Kuditipudi、Percy Liang、Tatsunori Hashimoto | ICML 2025（PMLR 267）；arXiv 2502.07776 | https://arxiv.org/abs/2502.07776 | 仅搜索摘要 |
| S21 | Context Engineering for AI Agents: Lessons from Building Manus | Yichao 'Peak' Ji（Manus） | 2025-07-18 | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus | 打开原文 |
| S22 | Effective context engineering for AI agents | Anthropic Applied AI（Prithvi Rajasekaran 等） | 2025-09-29 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | 打开原文 |
| S23 | Managing context on the Claude Developer Platform（context editing 与 memory tool） | Anthropic | 2025-09-29 | https://www.anthropic.com/news/context-management | 仅搜索摘要 |
| S24 | codex-rs/core/src/client.rs | OpenAI（openai/codex） | main 分支，2026-11-02 读取（未固定 commit；本机安装 0.166.0） | https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/client.rs | 打开原文（前 10 万字符） |
| S25 | Hermes Agent `agent/prompt_caching.py`、`agent/agent_init.py`、`hermes_cli/config_defaults.py` | Nous Research | 本机安装 commit `bf0203a`，2026-10-22 | `/Users/sd3/.hermes/hermes-agent/agent/prompt_caching.py` 等 | 本机源码路径（只读） |
| S26 | OpenClaw `docs/reference/prompt-caching.md` | OpenClaw | 2026.10.9（本机安装包） | `/opt/homebrew/lib/node_modules/openclaw/docs/reference/prompt-caching.md` | 本机安装包文档（只读） |
| S27 | dsh 包（依赖 `@earendil-works/pi-ai`） | DeepSeek | 0.2.1-rc.5（本机安装包） | `/Users/sd3/.nvm/versions/node/v26.11.1/lib/node_modules/@deepseek-ai/dsh/` | 本机安装包（只读） |
| S28 | HarnessHub 源码：`context.ts`、`state.ts`、`runtime.ts`、`sqlite-store.ts`、`content-store.ts`、`contracts/*.ts` | HarnessHub | `cc/relay-design` @ `07a0825` | `/Users/sd3/Desktop/project/HarnessGateway-relay/src/…` | 本机源码路径 |
| S29 | HarnessHub ADR-047、ADR-032、ADR-030；验证文档（native-session-experience-2026-10-11、first-chain-polish-2026-10-11、frontend-redesign-2026-10-12、management-actions-2026-10-18、native-capability-matrix：Codex 默认 gpt-6.1-sol、OpenCode 默认 big-pickle、dsh 默认 deepseek-v4-flash） | HarnessHub | `07a0825` | `/Users/sd3/Desktop/project/HarnessGateway-relay/docs/…` | 本机文档 |
| S30 | R6 本机微基准（`bench-cpu.mjs`、`bench-store.mjs`、`bench-wal.mjs`、`bench-misc.mjs`、`bench-runtime.mjs`、`cost-model.mjs`） | R6 | 2026-11-02；Apple M5 Pro、macOS 27.0.1、Node 26.11.1、SQLite 3.53.4 | `/private/tmp/claude-501/-Users-sd3-Desktop-project-HarnessHub/ad0e280f-cff4-4061-938f-4e375d14fd26/scratchpad/relay/r6/bench/` | 本机测量 |
| S31 | OpenCode `applyCaching` 二手描述（BaseHub 论坛帖、Alibaba Cloud Model Studio 显式缓存指南） | 第三方 | 2026 | https://forums.basehub.com/anomalyco/opencode/32 ；https://www.alibabacloud.com/help/en/model-studio/explicit-cache-best-practice | 仅搜索摘要 |
| S32 | Conversation state（`previous_response_id` 计费） | OpenAI | 2026-11-02 读取 | https://developers.openai.com/api/docs/guides/conversation-state | 仅搜索摘要 |
| — | 交叉印证：R4 内部基线 D3（`runtime.ts:1334` 预算对象错误导致对话停摆） | 本组 R4 | 2026-11-02 | `/Users/sd3/Desktop/project/HarnessGateway-relay/docs/proposals/relay/round1/r4-internal-baseline.md` | 本机文件（只读） |
