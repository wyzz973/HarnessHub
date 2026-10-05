# 引擎独立配置与检查

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元测试（schema、各适配器的原生映射、原生 MCP）与集成测试（真实 HTTP、SQLite、Worker 与重启，假上游），本机 macOS arm64；各适配器的真实任务验收只有比赛期记录（归档于 `archive/competition`），Kimi、Qwen 等的部分映射有比赛期 Windows 合成 API 证据；开源版 Windows 未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [引擎独立配置](../../engine-configuration.md#逐引擎配置)、[原生 MCP](../../native-mcp.md)、[引擎经统一模型网关接入](../../model-gateway-engines.md) |

## 用途

给每个登记的引擎单独指定模型、Provider（地址与密钥）、Skills、MCP 服务和环境变量，不同引擎的同名变量互不影响，密钥只以引用保存。保存前可以检查配置，保存后可以“检查连接”（不调用模型）或“测试模型”（发一条真实请求）。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 引擎（`/engines`）→ 每行的“配置”（模型、Provider/URL/API Key、Skills、MCP、环境变量）、“检查连接”、“测试模型” |
| 命令行 | 无；也可在 `hh serve --config` 的引擎配置文件中写 `configuration` |
| HTTP | `POST /v1/engine-configuration/inspect`、`GET /v1/engine-configuration/adapters`、`GET /v1/engine-configuration/templates`、`POST /v1/engines/{id}/test`、`POST /v1/secrets`；登记接口的 `configuration` 字段 |

## 已实现的能力

- 17 个配置适配器（`generic`、`codex`、`claude`、`opencode`、`mimo`、`hermes`、`pi`、`gemini`、`qwen`、`cursor`、`copilot`、`kimi`、`kiro`、`qoder`、`dsh`、`openclaw`、`antigravity`），各自接受的 Provider 协议见 [适配范围](../../engine-configuration.md#provider-适配范围)；Kiro、Qoder 与 generic 只保留原生 Provider，Cursor 与 Antigravity 只把模型转为 `--model`。
- Provider 由 Worker 写入 Session 私有的原生配置（例如 Codex 的私有 `CODEX_HOME/config.toml`、Pi 的私有 `models.json`），不改用户自己的配置；保留“沿用原生账号与配置”时只调整明确填写的字段。
- 秘密只存引用 `{kind, value}`：`env`（启动环境中的变量名）、`file`（绝对路径，单行，至多 8 KiB，权限受检）、`keychain`（macOS 钥匙串或 Windows DPAPI 中本应用创建的条目）与托管秘密 `store`；只在所属 Worker 中解析，不进入 SQLite、IPC、argv 或事件。
- `POST /v1/secrets` 把新值写入只写的安全存储并返回引用，没有读取原值的接口；更换密钥创建新引用，旧引用保留给历史 revision。
- Skills 至多 16 项，每项主指令至多 64 KiB、合计 256 KiB；保存时固定 `SKILL.md` 的 SHA-256，重建 Worker 时内容不符即失败；附件仍从原目录引用。
- MCP 至多 16 项（stdio、HTTP、SSE），`enabled:false` 的不解析秘密也不下发；默认经 ACP 下发，Pi、OpenClaw、Kimi 与 Copilot 的 stdio 服务改用各自原生入口，见 [ACP 与 CLI 驱动](drivers.md)。stdio 服务参数中的 `${HARNESSHUB_SESSION_WORKSPACE}` 在启动时替换为 Session 工作目录。
- 普通 `env` 拒绝常见秘密名与进程控制变量，URL 拒绝内嵌身份、查询串与片段；固定 Provider 的旧启动脚本拒绝被新 Provider 字段隐式覆盖，需显式改用“本机标准启动模板”。
- `acp.initializeTimeoutMs`（1–300,000 ms）单独限制 ACP 初始化，检查连接与实际 Worker 使用同一上限，不延长 Run 总期限。
- `inspect` 返回校验后的 Profile 与 Skill 指纹，不登记、不调用模型；`POST /v1/engines/{id}/test` 解析配置、秘密引用与 Skill 指纹并对 ACP 做 `initialize`，返回分项 `checks[]` 与 `modelCalled:false`，HTTP 200 不代表模型可用。
- 保存后生成新 revision，已有 Session 不切换配置。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [engine-configuration.ts](../../../packages/core/src/engine-configuration.ts)（类型与 schema）、[prepare.ts](../../../packages/agents/src/configuration/prepare.ts)、[native-mcp.ts](../../../packages/agents/src/configuration/native-mcp.ts)、[engine-configuration.ts（服务）](../../../packages/agents/src/application/engine-configuration.ts)、[probe.ts](../../../packages/runtime/src/process/probe.ts)、[engine-configuration-routes.ts](../../../packages/daemon/src/http/engine-configuration-routes.ts) |
| 测试 | [engine-configuration.test.ts（集成）](../../../tests/integration/engine-configuration.test.ts)、[engine-configuration.test.ts（单元）](../../../tests/unit/engine-configuration.test.ts)、[model-gateway-configuration.test.ts](../../../tests/unit/model-gateway-configuration.test.ts)、[native-mcp.test.ts](../../../packages/agents/test/native-mcp.test.ts)、[qwen-configuration.test.ts](../../../packages/agents/test/qwen-configuration.test.ts)、[acp-initialize-timeout.test.ts](../../../tests/integration/acp-initialize-timeout.test.ts) |
| 决策 | [ADR 0006 引擎独立配置、密钥引用与便携 Skills](../../decisions/0006-engine-configuration.md)、[ADR 0008 Windows 密钥存储](../../decisions/0008-windows-secret-storage.md) |

## 已知限制与未验证

- 配置适配不等于该引擎版本已完成真实任务；经原生 MCP 的真实引擎验收尚未在开源版重建。
- 秘密会进入所选引擎及其工具的进程环境，同一用户的其他程序也能调用 DPAPI，不构成 OS 级秘密隔离；Linux 只有 `env`、`file` 与托管秘密。
- 没有清理或轮换未被引用密钥的管理页面。
- HTTP/SSE MCP 的 OAuth、TLS 证书与资源/提示词调用没有真实引擎验收。
- 声明了自己 `openai-completions` Provider 的引擎仍由 Worker 内的 Session 网关直连上游，不进模型平面的账本。

## 优化候选

- **现状**：用户要在模型平面（provider、路由组）与引擎配置两处配置模型。**方向**：引擎的 Provider 改为引用模型平面的 provider 或路由组，迁移后删除 Worker 内的网关。**依据**：[ADR 0019](../../decisions/0019-session-runs-on-the-shared-gateway.md) 的问题与后果、[模型网关的未实现项](../../model-gateway.md#与-03-的差异与未实现项)。
- **现状**：各适配器的原生映射只按固定源码核对，开源版没有真实引擎的验收。**方向**：在 M1 的 Adapter 一致性套件中经正式 Gateway 与 Worker 运行固定版本的真实引擎，覆盖 MCP 工具调用并扫描私有目录中的合成密钥。**依据**：[原生 MCP 验证](../../native-mcp.md#验证)、[10 第 3.3 节](../../proposals/oss/10-engineering.md#33-三类一致性套件)。
- **现状**：每次换 Key 都留下一个旧引用，没有清理入口。**方向**：列出未被任何 revision 引用的密钥并支持删除。**依据**：[密钥与环境](../../engine-configuration.md#密钥与环境)。
- **现状**：“检查连接”只做 `initialize`，不证明认证与额度。**方向**：对接入模型平面的引擎复用 provider 体检的结果，说明模型侧是否可用。**依据**：阅读代码的观察（`test` 返回 `modelCalled:false`），[Provider 测试与体检](../../provider-doctor.md) 已有不经引擎的检查。
