# 路由规则与分类器

| 项 | 内容 |
|---|---|
| 分类 | 模型平面 |
| 状态 | 已实现 |
| 验证 | core 规则测试（文本写法、校验、每个条件的命中与不命中）、网关规则与决定测试（回环假上游），经正式守护进程与严格假 provider 的集成测试（每个条件、分类器的缓存与冷却、`hh group rule` 的报错、决定的长轮询）；控制台规则编辑器的契约测试与 Chromium 走查；macOS arm64 本机 `pnpm check` 通过。真实分类器模型未验证；Windows 未验证 |
| 对照 Magpie | 相同：组规则与分类器；部分：路由决定只在管理接口上、组宣称的能力没有 `context`/`levels` 覆盖；未覆盖：System One / Jev 决策 API（[对照表](../../magpie-parity.md#routing-route-groups-and-rules)） |
| 权威文档 | [路由、重试与熔断](../../model-gateway.md#路由重试与熔断)（“路由组规则”“分类器”“路由决定”）、[模型平面 CLI](../../model-plane-api.md#cli)、[ADR 0032](../../decisions/0032-group-rules-and-classifier.md) |

## 用途

让路由组按请求的特征把一轮对话先交给某个成员：长请求给大窗口的模型，带图片的给能看图的模型，某个 Agent、某种意图、压缩请求或某个时段各用各的模型。分类器模型可以判断意图，也可以为每一轮选推理强度；“路由决定”视图说明每一轮为什么选了这个成员。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 路由与 Key → 路由组 → 规则（按命令行写法输入，即时标出出错的词；分类器；推理强度：自动）；路由与 Key → 路由决定（按会话筛选、实时跟随） |
| 命令行 | `hh group rule list <id>`、`hh group rule add <id> use=MEMBER [tokens=200k] [images] [effort[=LEVEL]] [agents=a,b] [intent="..."] [compact] [time=HH:MM-HH:MM] [days=mon-fri] [classifier=REF] [at=N]`、`remove <id> <n>`、`move <id> <n> <to>`、`classifier <id> REF\|off`、`effort <id> auto\|off` |
| HTTP | 路由组的 `rules`、`classifier`、`effort`（`POST /api/v1/route-groups`、`PATCH /api/v1/route-groups/{id}`）；`GET /api/v1/routing/decisions?session=&after=&wait=&limit=`（SDK `routing.decisions`） |

## 已实现的能力

- 规则把命中的请求先交给 `use`（组的一个成员），条件全部满足才命中，取第一条命中的规则。条件：`tokens`（字符数除以 4，不计 base64 媒体与封存的推理；厂商上次计数更大时取它）、`images`、`effort`（`on` 为任意推理）、`agents`（账本的 Agent ID）、`intent`、`compact`（由 `isCompactionRequest` 识别）、`time` 与 `days`（守护进程本地时区，可跨午夜）。
- 一轮开始时决定，以工具结果结尾的请求沿用这一轮的决定；网关没见过开头的一轮不改变（`rule:waits`）；请求达到当前成员窗口的 95% 且有规则指向更大窗口的成员时换过去（`rule:grown:<n>`）。
- 压缩请求单独按 `compact` 规则路由，跳过窗口小于请求的成员，不改变本轮决定、粘性记录与厂商计数。
- 新的一轮里规则的成员排在粘性保留的候选之前（`sticky:broken:rule`），之后是后面同样命中的规则的成员，最后是组的其他候选；规则的成员没有就绪的候选时记 `rule:unready`；组中的组有规则时逐层决定（`rule@<组>:<n>`）。
- 分类器只在新一轮开始、且可能最先命中的规则需要意图（或组为 `effort: "auto"` 且 Agent 要求了推理）时询问：经网关自己的内部 Chat 调用（`temperature: 0`、`max_tokens: 2048`、8 秒超时），用户消息中的 `<`、`>` 转义，回答必须只是一个数字。
- 分类器调用是账本中 Agent 为 `harnesshub-classify`、`purpose` 为 `classify` 的单独条目，记在触发它的 Key 名下，计入它的预算与每分钟请求数，受它的局域网规则约束；分类器随组授权，只有 Key 的 `modelDeny` 列出分类器模型时被拒绝。
- 同一消息的回答保留 10 分钟（`classifier:cached`）；超时、连接失败或 5xx 后 30 秒内不再询问（`classifier:resting`），这期间意图不命中；回答不是数字或 4xx 时不命中但不冷却。
- `effort: "auto"` 时分类器从 low 到 xhigh 选一档，发给没有固定档位的候选（`effort:auto:<level>`），整轮沿用。
- 组在 `/v1/models` 与接线目录中额外宣称规则能保证的能力（core `ruledCapabilities`）：只有 `images` 条件的规则保证的图片输入，只有 `tokens` 条件的规则保证的更大窗口。
- 路由决定在询问厂商之前发布、调用结束时更新：规则（命中第几条、条件、分类器的意图与是否来自缓存或冷却）、选出的档位、粘性、按尝试顺序的候选（最多 20 个）与应答者；只在内存中保留最近 256 条，不含提示词或回答的文字；长轮询最多等 60 秒，网关重启后 `after` 大于最新 `seq` 时从头返回。
- 命令行读不懂规则时退出码 2 并指出是哪个词；控制台编辑器用同一份解析代码 `@harnesshub/sdk/route-rules`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [core/route-rules.ts](../../../packages/core/src/route-rules.ts)、[gateway/rules.ts](../../../packages/gateway/src/rules.ts)、[gateway/classify.ts](../../../packages/gateway/src/classify.ts)、[gateway/trace.ts](../../../packages/gateway/src/trace.ts)、[sdk/route-rules.ts](../../../packages/sdk/src/route-rules.ts)、[daemon/routing-state-routes.ts](../../../packages/daemon/src/http/routing-state-routes.ts)、[console/rules-editor.tsx](../../../packages/console/components/rules-editor.tsx)、[console/route-decisions.tsx](../../../packages/console/components/route-decisions.tsx) |
| 测试 | [core route-rules](../../../packages/core/test/route-rules.test.ts)、[group-rules](../../../packages/gateway/test/group-rules.test.ts)、[route-trace](../../../packages/gateway/test/route-trace.test.ts)、集成 [group-rules](../../../tests/integration/group-rules.test.ts)、[check-console-routing](../../../tools/check-console-routing.test.mjs) |
| 决策 | [ADR 0032 路由组规则与分类器](../../decisions/0032-group-rules-and-classifier.md)（含补充“规则能达到的能力与路由决定”与补充二“网关自己的调用记在触发它的 Key 名下”） |

## 已知限制与未验证

- 规则、分类器缓存与冷却、路由决定都只在内存中；守护进程重启后，没见过开头的一轮按组的顺序路由，直到下一轮开始。
- 分类器与成员共用 Credential 时，分类器的失败也会让该 Credential 休息；ADR 建议给分类器单独的 provider 或 Credential，但写入时没有提示。
- `effort: "auto"` 使 Anthropic 与 Gemini 入站请求改走转换；不接受 `reasoning_effort` 的严格 Chat 上游会拒绝该字段。
- 意图规则是路由提示，不是安全边界：用户消息可以影响分类结果，但只能在组成员之间选择。
- 路由决定只能经管理令牌读取，Agent 不能用自己的 Key 读（Magpie 的 `/v1/magpie/route` 可以）；每次尝试的细节在账本的 `attempts[]` 中，不在决定中。
- 没有 Magpie 的 System One / Jev 决策 API；分类器不按模型的最低档位发送推理强度。
- 真实分类器模型（判断的准确度与延迟）未验证；Windows 未验证。

## 优化候选

- **现状**：路由决定只在 `/api/v1` 上，Agent 与持有 Key 的脚本看不到自己的路由。**方向**：增加按 Key 读取自己会话决定的端点，类似已有的 `GET /v1/harnesshub/limit`。**依据**：对照表 Route decisions 行为部分。
- **现状**：分类器与成员共用 Credential 时，分类器的失败会让成员休息。**方向**：在 `hh group rule classifier` 与控制台保存时检测共用并警告，或分类器的失败不计入成员的熔断。**依据**：[ADR 0032](../../decisions/0032-group-rules-and-classifier.md) 后果。
- **现状**：重启后正在进行的轮次失去规则决定（`rule:waits`）。**方向**：与粘性记录一起持久化轮次决定（同样 24 小时）。**依据**：ADR 0032 后果；[与 03 的差异与未实现项](../../model-gateway.md#与-03-的差异与未实现项)中粘性持久化的待做项。
- **现状**：没有决策 API 类型的 provider。**方向**：增加 System One / Jev 这类决策 API 作为规则来源。**依据**：对照表 Decision APIs 行未覆盖；TODO“路由组规则与分类器”的“未做”。
- **现状**：`effort: "auto"` 选的档位原样发送。**方向**：元数据有档位清单后按模型支持的档位收敛。**依据**：ADR 0032 后果“分类器按模型最低档位发送推理强度”未做。
