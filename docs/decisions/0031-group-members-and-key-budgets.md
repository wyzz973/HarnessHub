# ADR 0031：路由组成员与 Gateway Key 预算

Status: proposed

日期：2026-10-05
关联决定：[ADR 0025](0025-magpie-routing-parity.md)（对齐 Magpie 的路由）；[ADR 0027](0027-gateway-features.md)（图像端点）；对标清单 #10、#22、#27

## 问题

Magpie 的路由组成员可以带 `:effort` 与 `:fast` 后缀，也可以是另一个组；组对外宣称的窗口与档位来自它的成员。HarnessHub 的成员只是 Model Ref，组不能嵌套，`/v1/models` 与接线只按直接成员的元数据描述组。

Gateway Key 的额度只有按 UTC 日计的 token 与按 UTC 自然月计的成本，用的是已提交的账本：并发请求都按同一合计放行，拒绝只给 `Retry-After`，也没有接口查看一个 Key 用了多少。Magpie 的 key 预算按本地日历的日、周、月计算，在途请求持有预留，拒绝时告诉 SDK 不要自动重试，并有查询端点。

图像只有 `/v1/images/generations`，且只直通到声明了图像端点的 provider。

## 决定

1. **成员写成字符串**：`provider/model`、`provider/model:<effort>`（`none` 到 `max`）、最后再加 `:fast`，或 `group/<id>`。解析在 `@harnesshub/core/route-groups`：最后一段是档位名或 `fast`，且整个 ID 不是 provider 列出的模型时才拆分（`deepseek-r1:free`、`qwen:7b` 原样保留）。
   - 不像 Magpie 那样把 fast 单独存在 `fast[]` 中：Magpie 这样做是为了让旧版本仍能路由到该成员。HarnessHub 在 1.0 之前不承诺旧版本读取新数据，一种写法更简单。
   - 写入时检查：模型成员属于已存在的 provider；`:fast` 要求模型有网关能请求的快速模式；组成员必须存在、不能含自身（无论多深）、嵌套最多 8 层，且不带后缀。后缀存为小写。
   - 被其他组用作成员的组不能删除，被用作成员的自动组不能隐藏（409 `ROUTE_GROUP_IN_USE`）。
2. **固定强度与快速模式在每次尝试时加入请求**（`gateway/members.ts`）。
   - 固定强度无论请求要什么都覆盖：Chat 直通写 `reasoning_effort`，Responses 直通写 `reasoning.effort`；Anthropic 与 Gemini 请求改为转换，由上游编码器按该强度设置思考预算。强度原样发送：元数据只记录模型会推理，不记录它有哪些档位，因此不能像 Magpie 那样换成最接近的档位。
   - 快速模式只在 Magpie `CanFast` 认可的组合上发送：api.openai.com 上的 GPT 与 o 系列、ChatGPT 账号的 GPT 用 `service_tier: "priority"`；api.anthropic.com 上有快速模式的 Claude Opus 用 `speed: "fast"` 加 beta 头。
   - 与 Magpie 的差别：OpenAI 的 Chat 端点也发送 `service_tier: "priority"`，因为 Chat Completions 同样接受该字段。
3. **嵌套组按 Magpie 的 `planGroup` 规划**：内层组按自己的策略排好，作为一个整体。
   - `order`、`rotate`、`latency` 下，内层组按成员顺序放在自己的位置上。
   - `least-used`、`smart`、`pace` 下，内层组与本组模型的各个 Credential 一起排序，以它第一个未休息的候选代表整体。
   - 同一模型、同一强度、同一 Credential 只保留第一次出现的位置。
   - 实现时发现网关此前只对 `least-used` 组排序：`smart` 与 `pace` 组实际按配置顺序尝试。新的规划对三种策略都排序。
4. **组的能力由 core 的 `groupCapabilities` 统一给出**，`/v1/models` 与接线（`agents-wiring` 的 `gatewayModels`）都用它。
   - 取全部模型（组中的组展开）中最小的窗口与输出上限，模态取交集。
   - 档位是所有跟随请求的模型共有的档位；固定了强度的成员不缩小它；全部成员都固定时，为它们固定的档位。
   - 推理模型的档位取 low、medium、high，与接线写入 Agent 的相同。`/v1/models` 新增 `supported_reasoning_levels`。
5. **Key 额度改为 `budgets[]`**：每个 period（day、week、month）至多一项，`tokens` 与/或 `costUsd`，`cacheReads` 时缓存读取也计入 tokens；`requestsPerMinute` 保留。
   - 上限可以是 0：该窗口内的每次调用都被拒绝，Key 保留但被封住，与之前值为 0 的上限相同。
   - 窗口是守护进程本地时区的日历窗口：日从零点、周从周一零点、月从 1 日零点，用 `Intl` 计算以正确跨过夏令时。
   - 放行的请求持有预留，计算方式与 Magpie 相同：请求体字节 / 4，加上本窗口的平均输出；成本上限按窗口的平均每 token 成本折算，没有有价格的调用时用模型的输入价格。已用加在途预留达到上限即拒绝。
   - 拒绝时返回 429，带 `retry-after`、`x-should-retry: false` 与 `x-hh-limit-reset`。
   - 新增 `GET /api/v1/gateway-keys/{id}/limit` 与 `PUT /api/v1/gateway-keys/{id}/quota`，SDK 为 `gatewayKeys.limit` 与 `setQuota`，CLI 为 `hh key limit|quota` 与 `hh key create --budget/--rpm`。
   - 查询结果包含该网关在途请求的预留，因此由网关处理函数给出，守护进程只转交。
6. **存储迁移 6** 用 SQL 改写已存的 Key 记录。
   - `tokensPerDay` 改为 `cacheReads: true` 的日预算，保留它原来计入全部 token 的口径；`costPerMonthUsd` 改为月预算；窗口改为本地时区。
   - 每个上限原样带过来，包括 0：值为 0 的上限原本拒绝每一次调用，迁移后仍然如此。迁移不能让任何 Key 比之前能做更多的事，所以不删除上限，也不吊销 Key。
   - 旧备份中的这两个字段在恢复时同样转换（`backup.ts` 的 `currentQuota`），转换后按当前的额度格式校验，不合格的备份以 `BACKUP_INVALID` 拒绝，而不是丢掉这个上限。`hh restore` 列出需重新签发的 Key 时附上给出同样限额的 `hh key create` 选项。
7. **图像**：新增 `/v1/images/edits`，接受 JSON 或 multipart（multipart 由 Node 的 `Response.formData()` 解析，发出时重新组成 `FormData`）。
   - 没有图像端点但有 Chat 端点的 provider 经 chat completions 画图（`modalities: ["image", "text"]`，每张图一次，至多 4 张）。
   - 图像端点答复 404 或 405 时，在同一 Credential 上改经 Chat 再试一次。这一项对应 Magpie 的 `viaFor` 与 `draw`，但不包括按目录判断模型画图方式、自动选择画图模型与 Gemini 原生画图。

## 考虑过的替代方案

- **成员改为对象**（`{model, effort, fast}`）：读起来更明确，但 API、备份、控制台与接线都要改格式；字符串与 Magpie 的写法一致，CLI 也能直接给出。
- **预算保留 UTC 窗口**：Magpie 用本地日历，用户看到的“今天”“本月”也是本地的；UTC 在中国时区意味着每天早上 8 点重置。
- **预算查询只读账本**：管理接口不需要访问网关，但看不到在途请求持有的预留，而预留正是并发请求被拒绝的原因。
- **固定强度时把档位换成模型最接近的**：需要每个模型的档位清单，模型元数据还没有这一项。
- **multipart 用第三方解析库**：Node 24 的 `Response.formData()` 已能解析，不增加依赖。

## 后果

- 路由组可以表达“这个模型高强度、那个模型低强度”与“先用这一组，不行再用那一组”。
- 行为变化（修复缺陷）：`smart` 与 `pace` 组现在真正按读数排序。此前网关只对 `least-used` 组排序，这两种策略实际按配置顺序尝试；升级后同样配置的组可能先用另一个 Credential。
- 写入时拒绝成环；绕过 API 写入的环在运行时于闭合处截断（core 的 `groupModels` 与网关的 `planGroup`）。
- 预算按本地时区计算，守护进程的时区（`TZ`）决定窗口；查询结果给出所用时区。
- 并发请求最多超出约一次调用的量。
- 一个 Key 的在途预留只存在于本网关进程的内存中，重启后从零开始。
- 没有图像端点的 provider 现在也会被要求经 Chat 画图；不会画图的模型返回 502（“drew nothing”），并转移到下一个 Credential。之前这类请求得到 404 `images_unavailable`。
- 未做：Magpie 的组规则、分类器、`manual`/`pick`、组自定义的 `context` 与 `levels`、按 Key 自己的预算查询端点（Magpie 的 `/v1/magpie/limit`）、按目录判断画图方式与自动选择画图模型。

## 验证要求

- core（`packages/core/test/route-groups.test.ts`）：成员解析、嵌套展开、成环与深度、能力计算、预算记录的拒绝样例。
- 网关（`group-members.test.ts`、`key-budgets.test.ts`、`shared-gateway-images.test.ts`、`shared-gateway-sticky.test.ts`）：
  - 快速模式的判定与写入；嵌套规划；固定强度到达上游；`/v1/models` 的能力；
  - 日、周、月窗口跨夏令时与跨月；在途预留与拒绝的消息、响应头；
  - JSON 与 multipart 编辑；经 Chat 画图与回退；流式的完成事件。
- 存储（`tests/integration/store-migrations.test.ts`）：迁移 6 从版本 5 数据库转换各种旧额度，`tokensPerDay` 为 0、`costPerMonthUsd` 为 0 与两者都为 0 的 Key 转换后仍存在、可列出，上限仍为 0。
- 备份（`packages/daemon/test/backup-quota.test.ts`）：旧额度的转换保留 0；不是上限的值（字符串、负数、小数的 token 数）使备份无效。
- 集成（`tests/integration/groups-budgets.test.ts`、`gateway-features.test.ts`）：经正式守护进程与严格假 provider 验证：
  - 嵌套组、后缀与成环的写入检查，删除与隐藏的 409；
  - 嵌套组的调用、`/v1/models` 与接线计划；
  - 预算的设置、429 与响应头、查询接口，以及 `hh key create|quota|limit`；
  - 版本 5 数据中上限为 0 的 Key 经迁移 6 后每次调用都得到带 `retry-after` 的 429；旧备份经 `hh restore` 列出同样的限额，按所列选项签发的 Key 同样被拒绝；
  - multipart 编辑经守护进程到达上游。
