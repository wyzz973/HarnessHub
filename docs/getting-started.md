# 从新克隆启动 HarnessHub

本指南面向从源码运行的开发者；首次安装与构建命令见 [README 快速开始](../README.md#quick-start-from-source)。开源版尚无正式发布的安装包。

## 运行模式与端口

| 项目 | 行为 |
|---|---|
| `pnpm start` | 可从空引擎目录启动，在运行中发现并登记真实引擎 |
| `pnpm start --config <file>` | 读取 YAML/JSON 文件；运行中只热更新引擎目录和默认项 |
| `--port` | Gateway 默认3180；0由系统分配，ready日志中返回实际URL |
| `--data-dir` | 默认`./data`；不同Gateway必须使用不同数据目录 |
| 控制台 | 由 Gateway 在自己的端口提供（`/`），先 `pnpm build:console`；未构建时页面返回 503 并说明构建命令。启动时在 stderr 打印一次性登录链接，`hh console` 生成新链接；见 [控制台](../packages/console/README.md) |
| `--otlp-config <file>` | 可选；JSON 文件中的 `otlp` 配置块，开启模型调用的 OTLP 导出，见 [OTLP 导出](observability.md#otlp-导出) |
| `--version [--json]` | 打印构建身份（版本、提交、是否有未提交改动）后退出；`--json` 输出 `packages/daemon/dist/build-info.json` 的全部字段。同一身份出现在 `GET /v1/runtime/info` 的 `build` 与 `gateway.log` 的 `gateway.start` 记录中；`pnpm build` 生成该文件，缺失或损坏时 Gateway 拒绝启动 |

服务绑定loopback，拒绝跨Origin/跨站浏览器访问。`/api/v1` 需要本机管理令牌或控制台会话；旧 `/v1/*` 管理接口仍只有 loopback 的 Host 与 Origin 校验（[ADR 0024](decisions/0024-embedded-console.md)）。当前没有远程多用户认证和租户隔离，不应直接当公网服务部署。

`--demo` 会额外登记一个名为 `fake` 的引擎。它是自动测试用的协议替身，不做真实推理；除运行仓库自带的测试与示例脚本外不要使用它。

## 控制台页面

打开 `hh serve` 打印的链接或 `hh console` 的输出即登录；会话空闲 12 小时或创建 7 天后结束，守护进程重启后也需要重新登录。首页是 Agent（`/`），每个页面有自己的地址（如 `/providers`、`/usage/conversations`），可以刷新和收藏。顶部状态条每 5 秒探测 `/health/ready`，并显示 Full Access 与统一模型（真实模型名与引擎看到的别名）。Gateway 缺少某个接口时，对应位置显示“当前 Gateway 不支持”，其余功能照常使用。

| 页面 | 用途 |
|---|---|
| 任务工作台 | 默认“直接执行”；会话与历史每 3 秒同步，其他 API 客户端创建的会话也会出现；工具调用显示为卡片（工具名、状态、参数和输出摘要），原始 JSON 默认折叠 |
| 执行详情 | 在任务消息旁点击“执行详情”打开；除耗时、用量和产物外，列出本次 Run 的 `model.call` 记录（入站协议、请求模型与上游模型、状态、耗时、token、错误），并汇总已记录的调用发往哪个上游模型 |
| 统一模型 | 查看和修改上游地址、真实模型 ID、别名、API Key（写入系统安全存储后只保存引用，或填写环境变量名）、上下文窗口、输出上限、自定义请求头和兼容选项；“测试连接”用所选引擎运行一个真实短任务，会调用模型；环境变量提供统一模型时不能在页面修改 |
| 工具与插件 | 列出已安装工具包及绑定的引擎；按本机路径导入 Skills 目录、MCP JSON 或 CLI 清单，可选择安装到全部引擎；对已安装包应用到全部或所选引擎、解除绑定，并显示逐引擎结果与提示 |
| 引擎管理 | 发现、登记、启停和检查引擎；配置统一模型后，引擎配置里的模型与 Provider 只读 |
| 运行观测 | 状态计数、耗时分位、已知用量，可按 Run 回到任务 |

统一模型和工具包的修改只影响新会话，已有会话保持创建时的引擎版本。

## HTTP 接口自测（开发用）

[可执行示例](../examples/http-lifecycle.mjs)走完一遍 HTTP 生命周期，用于验证接口而非体验产品。它需要一个带测试替身引擎的 Gateway（`pnpm start --demo --port 3180 --data-dir ./data/demo`），不调用真实模型：

```sh
node examples/http-lifecycle.mjs http://127.0.0.1:3180
```

脚本依次读取引擎、创建Session、提交带幂等key的artifact场景、重复提交验证同一Run、查询终态、重放SSE、读取JSON事件页与JSONL、下载产物核对hash，最后关闭该Session。它使用Node内置fetch，不依赖jq或真实模型；目标未启用测试替身时会在创建任务前拒绝。

最小curl请求为：

```sh
curl -s http://127.0.0.1:3180/health/ready
curl -s http://127.0.0.1:3180/v1/engines
curl -s -X POST http://127.0.0.1:3180/v1/sessions \
  -H 'Content-Type: application/json' -d '{"engineId":"fake"}'
```

返回Session后，将实际id用于 [Run提交](api/reference.md#hh_post_v1_sessions_id_runs)。完整字段、返回码与错误见 [API文档](api/README.md)。

## 真实引擎流程

1. 在本机安装引擎；需要Adapter时在准备阶段固定版本安装，不在Run中临时下载。
2. 启动Gateway和Console，在引擎管理中发现并登记；找不到自定义引擎时准备绝对路径manifest或完整注册配置。
3. 设置实际Workspace，按引擎支持范围设置模型与Provider。首次使用可先保留原生登录。
4. 点击配置/协议检查，再通过“测试模型”或任务工作台验证实际模型。后者会使用真实额度。
5. 对文件任务声明outputs；仅有模型“完成”文字不等于文件产物或评判通过。

不共享同一Session做并行Run；同Session会排队。更新模型、Key或MCP时新建Session，旧Session保留旧revision。CLI型引擎每轮独立，不自动携带聊天历史。跨Worker恢复只对显式配置且已验证的ACP引擎启用。

## 数据与停止

数据目录含 `harnesshub.sqlite`、所有权锁 `harnesshub.sqlite.lock`、产物、Worker lease、后端checkpoint/私有目录；这些都不属于源代码。同一数据目录同时只能有一个 Gateway：所有权是锁文件上的操作系统文件锁，进程退出（包括崩溃）时由系统释放，与 PID 无关；第二个 Gateway 在写入数据目录中的任何文件之前就以 `RUNTIME_ALREADY_RUNNING` 失败。停止Gateway先用Ctrl+C等待清理，避免直接杀进程造成未知执行结果。重新启动使用原数据目录可查询已提交历史；运行中崩溃的任务不会自动重跑。

目录升级前应在停止写入或使用一致备份机制后备份SQLite及关联产物/后端目录。引擎目录当前为version2，兼容读取version1；旧版本程序不能保证读取新目录。不要删库来绕过迁移或恢复失败。

## 常见问题

| 现象 | 核查 |
|---|---|
| Console连接不上 | Gateway ready日志实际URL；前端启动环境变量；是否把3180和历史3182混用 |
| 控制台显示“当前 Gateway 不支持” | Gateway 版本缺少对应接口（如统一模型、工具包导入）；页面其余功能不受影响，升级 Gateway 后刷新 |
| 报缺少console.local.yaml | 这是忽略的本机配置；按 [example](../engines/example.yaml) 准备自己的配置 |
| macOS找不到swiftc | 安装Xcode Command Line Tools；Keychain helper是本机构建依赖 |
| 找到引擎但没有模型响应 | 区分安装、Adapter、ACP握手、原生登录/Key、模型权限和额度；查看正式Run错误 |
| 配置保存失败 | 不支持的协议、重复MCP名称、非绝对路径、秘密写在普通字段、Skill变化都可能被拒绝 |
| API 200但检查失败 | `/engines/:id/test`的分项在`checks[].status`，不能只看HTTP状态 |
| 更新配置后老对话没变 | 正常；已有Session固定revision，为新配置创建新Session |
| curl SSE结束/断开 | SSE断开不取消Run；带游标重连并查询Run状态 |
| `RUNTIME_ALREADY_RUNNING` | 另一个仍在运行的 Gateway 持有该数据目录的锁；换用其他 `--data-dir` 或先停止它。删除 owner 记录不会绕过它；不要删除运行中的锁文件（POSIX 上锁随文件而非路径，删除后第二个实例会建立新锁） |
| Windows能否直接使用 | 原生启动、Job 监督、脚本后缀与文件路径在早期版本取得过 Windows 证据；见 [Windows 指南](windows.md)及[平台边界](../DESIGN.md#8-windows-能力与验证边界) |

## 本地开发

后端变更后`pnpm build`，再重启对应Gateway；不要覆盖其他人正在使用的数据目录。Gateway 在启动时索引控制台构建，重新 `pnpm build:console` 后也要重启。前端开发用 Vite 开发服务器（127.0.0.1:3330），它把 `/api`、`/v1`、`/health` 与 `/openapi.json` 转发给 Gateway：

```sh
pnpm start:local --dev        # Gateway 3180 + Vite 3330，并打印开发服务器的登录链接
# 或者对已在运行的 Gateway：
HARNESSHUB_DAEMON_URL=http://127.0.0.1:3180 pnpm dev:console
pnpm exec hh console --url http://127.0.0.1:3330 --data-dir ./data/local
```

修改公开接口时同步domain schema、消费者与文档，再运行`pnpm docs:api`和相关验证。文档读者测试和生成文件检查见[贡献指南](../CONTRIBUTING.md)。
