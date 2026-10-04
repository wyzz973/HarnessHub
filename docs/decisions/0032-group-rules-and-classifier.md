# ADR 0032：路由组规则与分类器

Status: proposed

日期：2026-10-05
关联决定：[ADR 0025](0025-magpie-routing-parity.md)（对齐 Magpie 的路由）；[ADR 0031](0031-group-members-and-key-budgets.md)（路由组成员与 Key 预算）；对标清单 #30

## 问题

HarnessHub 的路由组只按策略排列成员：长请求、带图片的请求、要求高推理强度的请求、某个 Agent 的请求、压缩请求和高峰时段的请求，都和其他请求一样排列。Magpie 的路由组可以带规则：一轮开始时按请求本身可见的特征（长度、图片、推理强度、Agent、压缩、时段）把某个成员放到最前，或者让一个小模型判断用户消息属于哪种意图、需要多少推理。

Gateway Key 只能经管理接口查看自己的额度，持有 Key 的客户端无法自己查询。Magpie 有 `GET /v1/magpie/limit`。

## 决定

1. **规则存在路由组上**：`rules[]`，每条 `{use, tokens, images, effort, agents, intent, compact, time{from,to,days}}`。`use` 是组的一个成员，规则至少有一个条件，已设置的条件全部满足才算命中，多条规则按顺序取第一条命中的。组另有 `classifier`（Model Ref 或另一个组）与 `effort: "auto"`。
   - 校验与匹配都在 `@harnesshub/core/route-rules`，守护进程写入时调用 `cleanGroupRules`，把规则规范化后再存：档位小写，Agent 去重并转小写，意图合并空白，时间写成 `HH:MM`，日按周一到周日排列，七天全选时省略。存储记录的校验要求规则已经是这种形式。
   - 错误指向具体字段：`/rules/<i>/use`、`/rules/<i>/tokens`、`/classifier` 等。删除路由组时，被用作成员的组和被用作分类器的组都会被拒绝（409）。
   - 不需要存储迁移：路由组记录本来就是 JSON，新增字段可选。
2. **CLI 用 Magpie 的文本写法**：`hh group rule add <group> 'use=… tokens=200k images effort=high agents=claude intent="…" compact time=09:00-18:00 days=mon-fri classifier=… at=N'`，并接受 Magpie 的同义词（`model=`、`longer=`、`hours=` 等）。
   - 成员可以写全名、模型名，或模型名的最后一段；也可以不带成员上的档位后缀。名字匹配到多个成员时会报错。
   - 读不懂的部分以 `RuleSyntaxError` 指出具体是哪个词（例如 `unknown "colour=red"`、`tokens "lots" is not a length`）。
   - 另有 `list`、`remove`、`move`、`classifier <ref>|off` 与 `effort auto|off`。
3. **网关在一轮开始时做决定，整轮沿用**（`gateway/rules.ts`，对应 Magpie `gw/rules.go`）。
   - 决定按“组、会话、会话第一条用户消息的哈希”保存，子 Agent 因此与主 Agent 分开。
   - 以工具结果结尾的请求属于同一轮，沿用这一轮开始时的决定。网关没见过开头的一轮不会被规则改变。
   - 只有一个例外：请求达到当前成员窗口的 95%（没有规则命中时，取最小成员的窗口），并且第一条命中的规则指向窗口更大的成员时，换到那个成员。
   - 长度为请求文本的字符数除以 4，不计入 base64 媒体与封存的推理；如果厂商上次实际计数的输入更大，以它为准。
4. **压缩请求单独处理**：用 `compacting.ts` 的 `isCompactionRequest` 识别，按带 `compact` 的规则路由，并跳过窗口小于请求长度的成员。
   - 压缩不改变这一轮的决定，也不更新粘性记录和厂商计数。
5. **规则与粘性**：新的一轮中，规则的成员排在粘性保留的候选之前；如果首个候选因此改变，粘性补丁记为 `sticky:broken:rule`。同一轮内粘性优先。
   - 命中规则的成员没有就绪的候选时，改用后面同样命中的规则的成员，账本记 `rule:unready`。
   - 组中的组如果有自己的规则，则沿着排在最前的成员逐层决定，补丁为 `rule@<组>:<n>`。
6. **分类器**（`gateway/classify.ts`，对应 Magpie `gw/classify.go`）：只在新一轮开始时调用，并且只在以下两种情况调用：可能最先命中的规则需要意图；或组设置了 `effort: "auto"` 且 Agent 要求了推理。
   - 调用经网关自己的内部 Chat 路径，`temperature: 0`、`max_tokens: 2048`，单次超时 8 秒。在账本中是一条独立的记录，Agent 为 `harnesshub-classify`，因此用量与成本可以单独查看；不计入调用者 Key 的额度。
   - 同一条消息与同一组意图的回答缓存 10 分钟。分类器失败后 30 秒内不再询问，期间意图不命中，组按自身顺序路由。如果分类器有回答但不是数字，不进入冷却。
   - 分类器自己的调用不再询问分类器。
   - `effort: "auto"` 选出的档位（low 到 xhigh）发给没有固定档位的候选，整轮沿用，账本记 `effort:auto:<level>`。
7. **账本补丁**：`rule:<n>`、`rule:none`、`rule:held:<n|none>`、`rule:waits`、`rule:grown:<n>`、`rule:compact:<n|none>`、`rule:unready`、`classifier:asked|cached|failed|resting`、`effort:auto:<level>`。
8. **`GET /v1/harnesshub/limit`**：用调用者自己的 Gateway Key 认证，返回该 Key 的 `KeyLimitStatus`，另加 `object: "gateway_key.limit"` 与 `limited`。不会返回其他 Key 的任何信息。回环与局域网监听器都提供，局域网监听器只接受允许局域网的 Key。

## 考虑过的替代方案

- **每个请求都重新匹配规则**：实现更简单，但一轮中途换模型会让工具调用的结果回到另一个模型，提示缓存失效，推理签名也会被拒绝。Magpie 只在一轮开始时决定，这里采用同样的做法。
- **分类器直接调用上游，不经网关**：可以少一层，但会失去凭据选择、转移、熔断与账本记录，分类器的成本也就看不到了。
- **把规则存在单独的表**：规则只对所属的组有意义，与组一起读写、备份与恢复更简单。
- **规则按字段单独校验，不比较规范形式**：这样同一规则可能存成多种写法，`hh group rule list` 与比较都会变复杂。

## 后果

- 新增 `@harnesshub/core/route-rules`（类型在 `model-plane.ts`）、`gateway/rules.ts` 与 `gateway/classify.ts`；`Candidate.path` 记录候选来自哪个成员，`planGroup` 另返回经过的组。
- 规则与分类器的状态只在内存中，守护进程重启后清空。重启后没见过开头的一轮按组的顺序路由，直到下一轮开始。
- 分类器与成员共用一个 Credential 时，分类器的失败也会让这个 Credential 进入熔断休息。建议给分类器配一个单独的 provider 或 Credential。
- `effort: "auto"` 对 Anthropic 与 Gemini 的入站请求强制走转换路径（与固定档位的成员相同）；对不接受 `reasoning_effort` 的严格 Chat 上游，该字段会被拒绝。
- 未做：
  - Magpie 的 System One / Jev 决策 API（厂商专用）；
  - 分类器按模型最低档位发送推理强度（HarnessHub 的元数据没有档位清单）；
  - manual/pick 与组的 `context`、`levels` 覆盖。
- 按规则调整宣称的能力与路由决定的追踪见下面的补充。

## 验证要求

- core（`packages/core/test/route-rules.test.ts`）：文本写法的每个词与同义词、报错时指出具体的词、规范化、字段校验与指针、每个字段命中与不命中（含跨午夜与时区）、取第一条命中、后续成员、意图的范围、存储记录的校验与无效样例。
- 网关（`packages/gateway/test/group-rules.test.ts`）：
  - 请求视图（长度不计媒体、图片、推理、轮次）；
  - 每个字段在网关中的路由；
  - 同一轮沿用决定、95% 窗口时换成员、网关没见过开头的一轮；
  - 压缩请求跳过窗口太小的成员且不改变粘性；
  - 规则打破粘性；
  - 分类器的询问、缓存、10 分钟过期、失败后 30 秒冷却，以及回答不是数字时不冷却；
  - `effort: "auto"`、组中组的规则、`/v1/harnesshub/limit`。
- 集成（`tests/integration/group-rules.test.ts`）：经正式守护进程与严格的假 provider 验证：
  - 每个字段命中与不命中；
  - 分类器的缓存、账本记录与冷却；
  - 写入校验与 `hh group rule` 的报错；
  - 成员被规则使用时不能移除，被用作分类器的组不能删除；
  - 自查端点只返回调用者自己的 Key。
- 协议一致性套件（`pnpm test:protocol`）保持通过。

## 补充：规则能达到的能力与路由决定

日期：2026-10-05

1. **组宣称规则能保证的能力**（core `ruledCapabilities`，照 Magpie `ruledEntry`），`/v1/models` 与接线目录都用它。在组模型共有的能力之上：
   - 图片：一条只有 `images` 条件的规则把带图片的请求交给其模型都接受图片的成员，且它之前每条规则的成员也都接受图片（之前的规则可能先拿到这样的请求）。
   - 更大的窗口：一条只有 `tokens` 条件的规则把至少这么长的请求交给窗口更大的成员。前提是其他窗口已知的成员都能接受到该长度的请求（更短的请求按组的顺序路由）；窗口取这个成员的，但不超过它之前每条规则的成员的窗口，之前某条规则的成员窗口未知时不放大。
   - 成员的窗口是其模型中已知的最小窗口；成员的模型都接受图片时它才算接受图片。带其他条件的规则不改变宣称的能力，因为不能保证每个这样的请求都命中它。组中组的规则只影响它自己宣称的能力，与 Magpie 相同。
2. **路由决定的追踪**（`gateway/trace.ts`，对应 Magpie 的 route trace 与 `/v1/magpie/route`）：路由组的请求在一轮开始时、规则在一轮中把它换走时，或压缩请求单独路由时，发布一条决定，在询问厂商之前；调用结束时再更新一次，`seq` 随之增大。
   - 内容：规则（请求的组在前，其后是组中组：命中第几条、条件、后续成员、是否未就绪、分类器的意图与是否来自缓存或冷却）、分类器选的档位、粘性、按尝试顺序的候选（最多 20 个），以及结束后的状态与应答的候选。不含提示词或回答的文字。
   - 不发布：同一轮内的工具结果、内部调用、直接请求 Model Ref 的调用（它们的候选只是同一 provider 的 Credential，粘性已写在账本中）。
   - 保留：内存中的环，最近 256 条，守护进程重启后清空。不写入存储：决定解释的是正在进行的路由，账本中的 `patches[]` 已长期记录每次调用的规则与粘性结果；把逐轮决定写进存储会增加写入，却不增加可追溯的事实。
   - `GET /api/v1/routing/decisions?session=&after=&wait=&limit=`：管理令牌与回环连接（与其他 `/api/v1` 相同），`session` 为会话键（账本的 `conversationKey`）或 HarnessHub Session。返回 `seq` 大于 `after` 的决定，从旧到新；没有时最多等待 `wait` 秒（不超过 60），客户端断开或守护进程关闭时提前返回。`after` 大于最新的 `seq`（网关重启过）时从头返回。SDK 为 `routing.decisions`。
   - 与 Magpie 的差别：Magpie 按会话返回最新的一条，并记录每次尝试；这里返回某个 `seq` 之后的全部决定，以便控制台逐轮列出，每次尝试的细节仍在账本的 `attempts[]` 中。
3. 验证：core 的 `ruledCapabilities` 正反样例（只有图片的规则、带其他条件的规则、之前的规则不接受图片、长度规则与其他成员的窗口、之前规则的窗口上限、窗口未知）；网关的 `/v1/models` 与决定的发布、结束、等待；`route-trace.test.ts` 的环、过滤、副本、等待、中止与关闭；经守护进程的 `/v1/models`、OpenCode 接线计划中的窗口、长轮询、会话过滤与管理令牌。
