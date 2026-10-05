# 统一模型（遗留）

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 遗留（已弃用、计划移除） |
| 验证 | 单元测试（来源解析、登记策略、迁移为 provider）与集成测试（三种来源的优先级、PUT 重新发布 revision、重启、迁移只做一次并被 Run 使用），本机 macOS arm64，假上游；Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [统一模型](../../engine-configuration.md#统一模型)、[Session Run 与共享网关](../../model-gateway.md#session-run-与共享网关)、[ADR 0013](../../decisions/0013-unified-model-gateway.md)、[ADR 0019](../../decisions/0019-session-runs-on-the-shared-gateway.md) |

## 用途

比赛期的约束：配置一个上游 Chat Completions 模型后，所有引擎只用这一个模型，引擎自带的 Key、登录与订阅都不参与。开源版改由模型平面（provider 与 `group/default`）承担，这里保留的只是兼容旧部署的入口：旧来源仍然生效，并在启动时被镜像进模型平面。新部署请直接用 [模型平面 API 与 CLI](../../model-plane-api.md)。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 统一模型（`/model`）：只在 `/v1/harness/model` 报告已配置时出现在导航中，页首说明已弃用并链接到 Provider；可编辑、保存与“测试连接” |
| 命令行 | `hh serve --harness-model-file FILE` 指定模型文件；环境变量 `HARNESSHUB_MODEL*`；`hh provider show migrated` 查看镜像出的 provider |
| HTTP | `GET /v1/harness/model`、`PUT /v1/harness/model`、`POST /v1/harness/model/test`；密钥先经 `POST /v1/secrets` 换成引用 |

## 已实现的能力

- 三种来源按优先级取一个：环境变量 `HARNESSHUB_MODEL*`（只对本进程，此时 `PUT` 返回 409 `HARNESS_MODEL_ENVIRONMENT_OVERRIDE`）> 模型文件（默认 `<数据目录>/harness-model.json`，`PUT` 立即生效）> `--config` 配置文件顶层的 `model`（改后需重启）；启动时校验所有已提供的来源，任一无效即启动失败。
- 上游协议只接受 `openai-completions`；`apiKey` 与 `secretHeaders` 只接受秘密引用；`alias`（缺省 `harnesshub-model`）是引擎看到的模型名。
- 登记策略：每次登记（文件加载、热加载、`POST/PUT /v1/engines`、overlay 恢复、工具包应用）都把 `model` 与 `configuration.provider` 改成统一模型，移除 `credentialEnv` 与引擎级 `secretEnv`；cursor、antigravity、kiro、qoder、generic 适配器、无法识别适配器的自定义引擎与 ACP 方式的 Kimi 被停用；`fake` 不受影响。
- 原始登记与生效登记的 revision 都持久化，已有 Session 不迁移；去掉统一模型并重启后恢复原始登记；启动时指定的默认引擎被停用时守护进程拒绝启动。
- `GET` 返回来源、模型、别名、只含引用的 provider，以及每个引擎的 `applied`、`unsupported`（附原因）或 `disabled`。
- `POST /v1/harness/model/test` 在默认或指定引擎上用私有临时目录建 Session，提交“只回复 OK”，至多等 90 秒后关闭；会真实调用模型并消耗额度；未配置或引擎不适用为 409，已有测试在运行为 429。
- 迁移到模型平面：启动时与每次 `PUT` 后，当前来源写成 provider `migrated`（唯一模型 `default`，wire 名为上游模型，凭据保留原引用种类，旧网关的规范化写成补丁），名称为 “Unified model (managed by legacy harness-model source)”，只在内容变化时重写并记 `model.migrated`；`group/default = [migrated/default]` 只在不存在时创建，已有的从不改写。
- 应用了统一模型的引擎，其 Run 必须经共享网关使用 `group/default`（或 Run 的 `model`），目标不存在时以 `MODEL_NOT_CONFIGURED` 失败，见 [任务经共享网关](runs-on-gateway.md)。
- 含 `secretHeaders`、`compatibility.reasoning: strip` 或 `drop-fields` 闭集之外 `dropParameters` 的统一模型无法表示为 provider，不迁移（日志 `model.migration.unsupported`），这些 Session 仍由 Worker 内的网关直连上游。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [harness-model.ts（类型）](../../../packages/core/src/harness-model.ts)、[harness-model.ts（服务与迁移）](../../../packages/agents/src/application/harness-model.ts)、[manager.ts](../../../packages/agents/src/engine/manager.ts)、[harness-model-routes.ts](../../../packages/daemon/src/http/harness-model-routes.ts)、[main.ts](../../../packages/daemon/src/main.ts)（`syncModelPlane` 与 `routeSession`） |
| 测试 | [harness-model.test.ts（集成）](../../../tests/integration/harness-model.test.ts)、[harness-model.test.ts（单元）](../../../packages/agents/test/harness-model.test.ts)、[harness-model-migration.test.ts](../../../packages/agents/test/harness-model-migration.test.ts)、[registry-harness-model.test.ts](../../../packages/agents/test/registry-harness-model.test.ts)、[engine-manager.test.ts](../../../packages/agents/test/engine-manager.test.ts)、[session-shared-gateway.test.ts](../../../tests/integration/session-shared-gateway.test.ts) |
| 决策 | [ADR 0013 统一模型网关](../../decisions/0013-unified-model-gateway.md)、[ADR 0019 Session Run 使用共享网关](../../decisions/0019-session-runs-on-the-shared-gateway.md) |

## 已知限制与未验证

- 用户在模型平面中直接修改 provider `migrated`，会在下次启动或 `PUT` 时被旧来源覆盖。
- 旧网关默认去除的 `reasoning_effort`、`prediction`、`modalities`、`audio`、`web_search_options` 不在 `drop-fields` 闭集中，迁移后会转发给上游，严格上游可能拒绝。
- 模型文件在 Windows 上不额外设置 ACL，依赖所在目录的权限。
- 只要存在旧来源，登记策略就会改写引擎登记并停用无法接入网关的引擎，用户可能不清楚为什么引擎被停用（原因只在 `GET /v1/harness/model` 与 `ENGINE_UNAVAILABLE` 的消息中）。

## 优化候选

- **现状**：登记策略、`GET/PUT /v1/harness/model` 与控制台页面仍在。**方向**：按计划删除 `HARNESSHUB_MODEL*`、`harness-model.json` 与统一模型服务，“所有 Agent 只用一个模型”改用 Profile 的默认模型加 Gateway Key 的模型白名单表达；接口由 providers、models 与 route-groups 取代。**依据**：[12 第 1 节](../../proposals/oss/12-roadmap-migration.md#1-现有模块去留)、[ADR 0019 后果](../../decisions/0019-session-runs-on-the-shared-gateway.md#后果)、[06 第 3 节](../../proposals/oss/06-interfaces.md#3-资源与端点清单)。
- **现状**：无法迁移的统一模型（秘密请求头、推理剥离、闭集外的去除参数）只能留在 Worker 网关。**方向**：删除前给出明确的迁移提示或替代写法（例如在模型平面补齐对应补丁），否则这些部署在删除后失去模型。**依据**：[统一模型](../../engine-configuration.md#统一模型)中的不迁移条件、[模型网关的未实现项](../../model-gateway.md#与-03-的差异与未实现项)。
- **现状**：删除后旧数据目录中的 `harness-model.json` 与 `migrated` provider 的去向没有说明。**方向**：在发布说明或 `hh migrate import` 中把 `migrated` 转成普通 provider（去掉“由旧来源管理”的标记），并提示删除旧文件。**依据**：[12 第 1 节](../../proposals/oss/12-roadmap-migration.md#1-现有模块去留)的数据迁移说明；阅读代码的观察（`migratedProvider` 的名称标记）。
