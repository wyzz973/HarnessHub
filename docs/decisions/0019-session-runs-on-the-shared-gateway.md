# ADR 0019：Session Run 使用共享网关

Status: proposed

日期：2026-10-03
关联决定：[ADR 0013：统一模型网关](0013-unified-model-gateway.md)、[03 模型平面](../proposals/oss/03-model-plane.md)（第 10 节）、[05 执行平面](../proposals/oss/05-run-plane.md)（第 4 节）

## 问题

ADR 0013 让每个 Session 的 Worker 启动自己的模型网关，由“统一模型”（`harness-model.json`、配置文件 `model` 或 `HARNESSHUB_MODEL*`）配置。开源版又在守护进程端口上提供了共享网关、模型平面（provider、路由组）与 `model.call` 账本。用户因此面对两套模型配置，Run 的调用也不进账本，无法与其他客户端的用量合计。

## 决定

- Session 的 Run 经共享网关使用模型。在 Session 第一个 Run 开始前决定是否走共享网关：引擎登记应用了统一模型时必须走（缺少目标即失败）；引擎可接入网关、没有自己的 provider 时，存在目标才走，否则保留引擎自己的登录。目标是 Run 的 `model`，缺省 `group/default`。
- 每个这样的 Session 有一把 `session:` Gateway Key，`modelAllow` 为空；网关只允许该 Session 活动 Run 的目标，别名与非 Model Ref 的模型名都解析为它。Key 文本只在守护进程内存与 ExecutionSpec 中，Session 关闭且在途调用结束后吊销。
- Run 结束时守护进程先取消并等待该 Session 的在途调用提交（结算屏障），再用已提交的调用与观察到的输出判定 `MODEL_UPSTREAM_ERROR`、`ENGINE_NO_OUTPUT`。规则移到 core，Worker 网关与共享网关共用。用量与 `model.call` Run 事件来自账本。
- 统一模型保留为已弃用的入口：其登记策略不变，当前来源每次启动（及每次 `PUT`）写成 provider `migrated`，`group/default` 只在不存在时创建。

## 考虑过的替代方案

- **去掉统一模型的登记策略，只用模型平面**：最干净，但会改变引擎目录（不再覆盖登记、不再停用无法接入的引擎、`PUT` 不再发布新 revision），控制台与现有集成测试都依赖这些行为。保留策略、把运行时的模型来源改为模型平面，变化最小。
- **只在应用了统一模型时走共享网关**：新部署只通过模型平面配置 `group/default` 时，Session 的 Run 会忽略它。
- **在 Session 创建时签发 Key 并把目标写入 Key 记录**：守护进程重启后 Key 文本已丢失，仍需重新签发；每个 Run 还可以选择不同目标，存进 Key 需要更新记录。改为首个 Run 时签发、目标经活动 Run 端口提供，Key 记录不需要新字段。

## 后果

- Session 的调用与其他客户端共用 provider、重试、熔断、粘性与账本；Run 用量可按 `runId` 汇总。
- 声明了自己 openai-completions provider 的引擎与配置检查仍使用 Worker 网关；含秘密请求头、推理剥离或闭集之外去除参数的统一模型无法迁移，同样保留 Worker 网关。这两类以后迁入模型平面后，Worker 网关可以删除。
- 旧网关默认去除的 `reasoning_effort` 等参数不在 `drop-fields` 闭集中，迁移后会转发给上游；拒绝它们的严格上游需要另行处理。
- 统一模型的修改仍会改写 provider `migrated`（只在内容变化时）；用户在模型平面中直接修改它会在下次启动或 `PUT` 时被覆盖，provider 名称标明它由旧来源管理。
- 统一模型的登记策略（覆盖登记、停用无法接入的引擎）是比赛期的约束，降为遗留行为：只在存在旧的统一模型来源时生效，将被移除。

## 验证要求

经 `startHub` 的 Run 在引擎配置中只看到守护进程地址与 `session:` Key；账本记录带该 Run 的 `runId`；Run 结束后的调用返回 409；Session 关闭后 Key 已吊销；迁移只创建一次 provider、凭据引用与 `group/default`。见 [共享网关 Session 测试](../../tests/integration/session-shared-gateway.test.ts)。

## 补充：控制台的任务按模型平面选择模型（2026-10-05）

**问题。** 控制台的任务区仍以统一模型判断“有没有模型”：没有统一模型时每个任务页显示“未连接模型”，导航的“统一模型”带警告点，新建任务弹出填写上游地址与 Key 的引导。可是按上文的决定，Run 的模型来自模型平面（`group/default` 或 Run 的 `model`），没有目标时引擎用自己的登录。2026-10-05 在本机控制台上复现：DeepSeek provider 已配置、Pi 已接线并完成 6 个任务，任务页仍提示“未连接模型”。同时控制台从不提交 Run 的 `model`，没有 `group/default` 时任务只能用引擎自己的设置，调用不带 `runId`，执行详情显示“未提供”用量。

**决定。**

- 引擎视图（`GET /v1/engines`）增加 `modelSelection`：该引擎的 Run 能否用 `model` 指定 Model Ref 或路由组。它由守护进程决定 Session 是否走共享网关的同一函数给出（应用了统一模型，或可接入网关且没有自己的 provider），控制台不复制这条规则。
- 控制台的任务区不再读统一模型判断能否执行：去掉状态条的模型标记、导航的警告点与连接模型的引导；“统一模型”页只在 `/v1/harness/model` 报告已配置时出现在导航中，页首说明它已弃用并链接到 Provider。
- `modelSelection` 为真时，直接执行的输入框提供与 Agent 页相同的模型选择。缺省不带 `model`（`group/default` 存在时就是它，否则是引擎自己的设置），所以默认行为不变；选中的 Model Ref 或路由组作为 Run 的 `model` 提交。继续一个 Session 时沿用它最后一个 Run 的 `model` 并锁定选择器，因为一个 Session 不能在共享网关与引擎自己的登录之间切换。
- 执行观测的“配置模型”优先取 Run 的 `model`，其次是引擎登记的模型；账本记录了这次执行的调用时，“实际模型”取账本中上游报告的模型，因为经共享网关的引擎只看到别名（如 `harnesshub-model`）。

**考虑过的替代方案。**

- **缺省用 Agent 页为同名 Agent 接线的模型**：用量会自动按执行记账，但走共享网关的 Run 由 Worker 写一份私有配置（例如 Pi 的 `PI_CODING_AGENT_DIR`），用户在 Agent 自己配置中的扩展、推理档位等不再生效，会悄悄改变已有任务的行为。改为显式选择。
- **控制台按适配器列表自行判断能否选择模型**：要复制守护进程的规则（适配器是否可路由、是否声明了 provider、统一模型），两边会走样。

**后果。** 没有统一模型的部署不再看到连接模型的引导；需要按执行记账的任务在输入框中选一个模型即可，执行详情的用量提示也这样说明。`modelSelection` 是引擎视图的新字段，旧客户端忽略它。

**验证。** [共享网关 Session 测试](../../tests/integration/session-shared-gateway.test.ts) 断言可接入网关的引擎 `modelSelection` 为真、`generic` 适配器为假，指定 `model` 的 Run 的观测 `model.configured` 是该目标，以及经共享网关的 Run 的 `model.actual` 是上游报告的模型而不是别名；这些断言在修改前的代码上失败（前两条对旧代码实际运行确认；第三条在旧构建的演示守护进程上显示为别名）。控制台的选择器与导航经类型检查、lint 与构建，并在本机控制台上手工核对。
