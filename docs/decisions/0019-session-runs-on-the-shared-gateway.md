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
- 统一模型的修改仍会改写 provider `migrated`；用户在模型平面中直接修改它会在下次启动或 `PUT` 时被覆盖。

## 验证要求

经 `startHub` 的 Run 在引擎配置中只看到守护进程地址与 `session:` Key；账本记录带该 Run 的 `runId`；Run 结束后的调用返回 409；Session 关闭后 Key 已吊销；迁移只创建一次 provider、凭据引用与 `group/default`。见 [共享网关 Session 测试](../../tests/integration/session-shared-gateway.test.ts)。
