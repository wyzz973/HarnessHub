# 引擎发现、登记与热加载

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元测试（发现、目录管理、安装快照）、集成与 smoke（编译后的 Gateway 经真实登记、SQLite 与 ACP/CLI Worker 执行发现到的配方），本机 macOS arm64；发现只证明安装文件存在，不证明模型可用；Windows 发现与启动有专用测试，开源版未单独验收 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [动态引擎管理](../../engine-management.md)、[本机引擎发现](../../engine-discovery.md)、[本机引擎安装快照](../../engine-installation.md) |

## 用途

守护进程可以从空的引擎目录启动，运行中扫描本机已安装的 Agent，挑选候选登记为引擎，无需重启。每次修改生成新的不可变 revision，已经创建的 Session 继续用原来的命令与配置，换引擎就是为下一项任务新建 Session。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 引擎（`/engines`）：进入时自动扫描，可见期间每 60 秒刷新，可“重新扫描”；登记、启停、设为默认与热加载 |
| 命令行 | `hh serve --config <引擎配置文件>` 作为基础目录并监视变化，`--engine <id>`（或环境变量 `AGENT_ENGINE`）指定新 Session 的默认引擎；没有单独的引擎管理命令 |
| HTTP | `GET /v1/engines`、`GET /v1/engines/discover`、`GET /v1/engines/registry`、`POST /v1/engines`、`PUT /v1/engines/{id}`、`DELETE /v1/engines/{id}`、`PUT /v1/engines/default`、`POST /v1/engines/reload` |

## 已实现的能力

- 内置识别 16 个引擎（OpenCode、OpenClaw、Codex、Claude Code、DSH、Hermes、MiMo、Gemini CLI、Copilot CLI、Kimi、Qwen、Kiro、Qoder、Pi 走 ACP，Cursor Agent 与 Antigravity 走通用 CLI），按 Gateway 的 `PATH` 顺序再查常见用户与包管理器目录；只检查文件与权限，不运行程序、不读认证文件、不联网安装 Adapter。
- 候选状态为 `ready` 或 `adapter-required`（例如缺少 Codex、Claude 或 Pi 的 ACP Adapter）；`ready` 只表示启动文件与 Adapter 存在。
- 自定义引擎经 `engines/manifests/*.json` 描述（每个至多 64 KiB，只含 `name` 与 `registration`），每次扫描重新读取；同 ID 的有效 manifest 优先于内置配方，两个 manifest 重名或任一无效则整次发现以 `INVALID_ENGINE_MANIFEST` 失败。
- 登记字段为 `id`、`driver`、`command`（argv 数组，不经 shell）与可选的 `enabled`、`model`、`credentialEnv`、`maxConcurrency`、`cli`、`acp`、`configuration`；未知字段（含嵌套拼写错误）、保留 ID（`fake`、`default`、`discover`、`registry`、`reload`）与命令中的明文凭据在持久化前被拒绝。
- `POST`/`PUT` 是完整替换，不是局部修改；`DELETE` 写移除标记，文件重载或重启后不会复活；停用是带 `enabled:false` 的完整登记。
- 配置文件是基础目录，API 登记是持久 overlay，同 ID 时 API 优先；每次写入先提交 SQLite（`runtime_metadata.engine_catalog` version 2，兼容读取 version 1）再发布内存目录，含全部历史 revision。
- 默认引擎的取值顺序：启动时显式的 `--engine`/`AGENT_ENGINE`，已保存的默认，配置文件默认，首个启用的引擎；默认引擎被移除或停用后，不指定引擎的新 Session 返回 `ENGINE_UNAVAILABLE`，不自动改派。
- `--config` 每 500 ms 检查一次，支持编辑器的原子替换保存；完整校验通过才应用，失败保留最后有效目录并在 `registry` 中给出错误码；改动 Workspace、并发、Worker 数、默认期限等部署设置返回 `CONFIG_RESTART_REQUIRED`，该次引擎修改也不生效。
- `GET /v1/engines` 把能力分为 `configured`、`observed`（本进程按 revision 实际记录的协议信息）与 `validated`（没有验证时为 null），另有 `modelSelection`（见 [任务经共享网关](runs-on-gateway.md)）。
- 每个 Session 第一次执行前（CLI 引擎每轮）记录 `engine.installation` 安装快照：启动文件的路径、大小、SHA-256 与可读到的包名和版本，不执行 `--version`。
- 存在旧的统一模型来源时，登记会被改写或停用，见 [统一模型（遗留）](unified-model-legacy.md)。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [manager.ts](../../../packages/agents/src/engine/manager.ts)、[discovery.ts](../../../packages/agents/src/engine/discovery.ts)、[builtins.ts](../../../packages/agents/src/engine/builtins.ts)、[registry.ts](../../../packages/agents/src/engine/registry.ts)、[installation.ts](../../../packages/agents/src/engine/installation.ts)、[engines.ts](../../../packages/core/src/engines.ts)（候选与登记类型）、[server.ts](../../../packages/daemon/src/http/server.ts) |
| 测试 | [engine-management.test.ts](../../../tests/integration/engine-management.test.ts)、[engine-validation.test.ts](../../../tests/integration/engine-validation.test.ts)、[discovery.test.ts](../../../packages/agents/test/discovery.test.ts)、[engine-manager.test.ts](../../../packages/agents/test/engine-manager.test.ts)、[installation.test.ts](../../../packages/agents/test/installation.test.ts)、[smoke discovery.test.ts](../../../tests/smoke/discovery.test.ts)、[windows-engine-launch.test.ts](../../../tests/integration/windows-engine-launch.test.ts) |
| 决策 | [ADR 0003 动态引擎目录与通用 CLI 接入](../../decisions/0003-dynamic-engines.md) |

## 已知限制与未验证

- 发现不执行登录 shell：只存在于 nvm/fnm 临时目录、shell alias 或自定义位置的程序，需要从终端启动守护进程或写绝对路径的 manifest。
- 目录最多 1000 个当前引擎、10000 个历史 revision，满时明确失败，不自动删除旧 Session 需要的版本。
- 安装快照不识别间接依赖，也不能给出 ACP Adapter 的实际版本；Windows 上的 PATH/PATHEXT 快照未原生验收。
- 管理接口只有本机 Host/Origin 检查，登记的命令可以启动任意本机程序，由本机用户自己负责。

## 优化候选

- **现状**：历史 revision 只增不减，上限 10000。**方向**：回收不再被任何 Session 或 Run 引用的 revision。**依据**：[动态引擎管理](../../engine-management.md#本机调用边界)的上限说明。
- **现状**：执行平面的引擎目录（`/v1/engines`）与 Agent 平面的本机 Agent 清单（`/api/v1/agents`）是两份各自发现的清单。**方向**：按设计拆分进 agents、wirings 与 Session 的隔离接线。**依据**：[06 第 3 节](../../proposals/oss/06-interfaces.md#3-资源与端点清单)末尾的迁移说明。
- **现状**：实际的引擎与 Adapter 版本不在公共状态中，只有安装文件 hash 与就近的 `package.json`；ACP 初始化返回的名称与版本只写进 Session 的诊断日志。**方向**：把握手报告的名称与版本作为事件提交，进入观测与 Benchmark 记录。**依据**：[DESIGN 第 2 节](../../../DESIGN.md#2-技术栈基线)“真实引擎/Adapter 版本及实际模型仍需验收记录补充”、[Benchmark](../../benchmark.md#权限与观测信息)。
- **现状**：引擎管理只有 HTTP 与控制台。**方向**：增加 `hh` 的引擎列表、发现与登记命令，复用同一 API。**依据**：`hh --help` 中没有对应命令。
