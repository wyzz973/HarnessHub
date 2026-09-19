# 从新克隆启动 HarnessHub

本指南只依赖仓库提交的文件；首次安装与构建命令见 [README 快速开始](../README.md#快速开始不需要-api-key)。历史的本机路径与数据库记录不是必备文件。

## 运行模式与端口

| 项目 | 行为 |
|---|---|
| `pnpm start --demo` | 明确添加 fake 引擎，外部推理替身；适合体验 HTTP/控制台与自动测试 |
| `pnpm start` | 可从空引擎目录启动，在运行中发现并登记真实引擎 |
| `pnpm start --config <file>` | 读取 YAML/JSON 文件；运行中只热更新引擎目录和默认项 |
| `--port` | Gateway 默认3180；0由系统分配，ready日志中返回实际URL |
| `--data-dir` | 默认`./data`；不同Gateway必须使用不同数据目录 |
| Console | 默认3330；生产模式必须先`pnpm build:console`；开发用`pnpm dev:console` |
| Console 后端 | `HARNESSHUB_GATEWAY_URL`；新环境显式设置为实际Gateway URL，不能依赖历史3182默认 |
| `--console-url <URL>` | 可选；Gateway 根路径 `/` 302 跳转到该控制台地址，并在 `GET /v1/runtime/info` 中返回 |

服务绑定loopback，拒绝跨Origin/跨站浏览器访问。当前没有远程多用户认证和租户隔离，不应直接当公网服务部署。

demo控制台默认“直接执行”，选择fake后直接发送文本即可；“自动规划”只选择真实引擎，不能用fake生成计划。

## 比赛入口自带控制台

前置条件：已解压 Windows x64 完整包，并按 [统一模型](engine-configuration.md#统一模型)配置模型。在包根目录运行 `gateway.cmd --engine <id>`（与 `Start-Competition.cmd` 相同，默认开启 Full Access），它在同一进程启动比赛 Gateway（默认 `localhost:6217`，接口见 [比赛接口](competition-api.md)），并由包内 Job helper 启动控制台（默认 `http://127.0.0.1:3330`）。

| 参数 | 行为 |
|---|---|
| `--console-port <端口>` | 控制台端口，默认 3330；端口被占用或与比赛端口相同时自动改用空闲端口，并在 stderr 与 `console.port-fallback` 事件中说明 |
| `--no-console` | 只启动比赛 Gateway，不与 `--console-port`、`--open` 同时使用 |
| `--open` | 控制台就绪后用系统默认浏览器打开 |

成功判据：stdout 输出一行 `{"event":"competition.ready",...,"consoleUrl":"http://127.0.0.1:3330"}`，控制台能经代理访问 Gateway 后再输出 `{"event":"console.ready",...}`；浏览器打开 `http://localhost:6217/` 会跳转到控制台。控制台进程只拿到系统变量、`PORT`、`HOSTNAME=127.0.0.1` 与 `HARNESSHUB_GATEWAY_URL`，拿不到模型凭证；它的日志以 `[console]` 前缀写到 stderr。

控制台异常退出只输出 `console.exited` 事件（`"gateway":"running"`），比赛 Gateway 继续服务，评测不受影响；需要时可重新运行入口或改用 `--no-console`。Ctrl+C 或 Gateway 进程退出时，Job 会连同子进程一起结束控制台。以上 Job 行为依赖 Windows，macOS/Linux 的自动测试只覆盖端口选择、环境隔离和故障隔离，Windows 行为需在 Windows 上验证。

源码环境可用 `pnpm start --demo --competition --engine fake --console-url http://127.0.0.1:3330` 加 `HARNESSHUB_GATEWAY_URL=http://127.0.0.1:6217 pnpm start:console` 得到同样的页面。

## 控制台页面

顶部状态条每 5 秒探测 `/health/ready`，并显示运行模式（比赛/普通）、比赛引擎、Full Access 与统一模型（真实模型名与引擎看到的别名）。Gateway 缺少某个接口时，对应位置显示“当前 Gateway 不支持”，其余功能照常使用。

| 页面 | 用途 |
|---|---|
| 任务工作台 | 默认“直接执行”，比赛模式默认选中比赛引擎；会话与历史每 3 秒同步，评测方经比赛接口创建的会话带“比赛 API”标记，只读显示，控制台不会向其发送消息或停止任务；工具调用显示为卡片（工具名、状态、参数和输出摘要），原始 JSON 默认折叠 |
| 执行详情 | 在任务消息旁点击“执行详情”打开；除耗时、用量和产物外，列出本次 Run 的 `model.call` 记录（入站协议、请求模型与上游模型、状态、耗时、token、错误），并汇总已记录的调用发往哪个上游模型 |
| 统一模型 | 查看和修改上游地址、真实模型 ID、别名、API Key（写入系统安全存储后只保存引用，或填写环境变量名）、上下文窗口、输出上限、自定义请求头和兼容选项；“测试连接”用所选引擎运行一个真实短任务，会调用模型；环境变量提供统一模型时不能在页面修改 |
| 工具与插件 | 列出已安装工具包及绑定的引擎；按本机路径导入 Skills 目录、MCP JSON 或 CLI 清单，可选择安装到全部引擎；对已安装包应用到全部或所选引擎、解除绑定，并显示逐引擎结果与提示 |
| 引擎管理 | 发现、登记、启停和检查引擎；配置统一模型后，引擎配置里的模型与 Provider 只读；比赛模式下“设为默认”只影响控制台新建任务，比赛接口仍固定使用启动引擎 |
| 运行观测 | 状态计数、耗时分位、已知用量，可按 Run 回到任务 |

统一模型和工具包的修改只影响新会话，已有会话保持创建时的引擎版本。

## HTTP 演示

在已有 demo Gateway 下运行 [可执行示例](../examples/http-lifecycle.mjs)：

```sh
node examples/http-lifecycle.mjs http://127.0.0.1:3180
```

脚本依次读取引擎、创建Session、提交带幂等key的artifact场景、重复提交验证同一Run、查询终态、重放SSE、读取JSON事件页与JSONL、下载产物核对hash，最后关闭该Session。它使用Node内置fetch，不依赖jq或真实模型；如果目标未启用fake，会在创建任务前拒绝。

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

数据目录含 `harnesshub.sqlite`、产物、Worker lease、后端checkpoint/私有目录；这些都不属于源代码。停止Gateway先用Ctrl+C等待清理，避免直接杀进程造成未知执行结果。重新启动使用原数据目录可查询已提交历史；运行中崩溃的任务不会自动重跑。

目录升级前应在停止写入或使用一致备份机制后备份SQLite及关联产物/后端目录。引擎目录当前为version2，兼容读取version1；旧版本程序不能保证读取新目录。不要删库来绕过迁移或恢复失败。

## 常见问题

| 现象 | 核查 |
|---|---|
| Console连接不上 | Gateway ready日志实际URL；前端启动环境变量；是否把3180和历史3182混用 |
| demo提示没有可选引擎 | 确认执行模式为“直接执行”（默认）并选择fake；自动规划不支持fake |
| 打开 `localhost:6217` 只有 404 | 比赛入口启动时带了 `--no-console`，或使用的是旧版入口；查看 stdout 的 `competition.ready` 是否含 `consoleUrl` |
| 控制台显示“当前 Gateway 不支持” | Gateway 版本缺少对应接口（如统一模型、工具包导入）；页面其余功能不受影响，升级 Gateway 后刷新 |
| 报缺少console.local.yaml | 这是忽略的本机配置；按README用demo或从example准备自己的配置 |
| macOS找不到swiftc | 安装Xcode Command Line Tools；Keychain helper是本机构建依赖 |
| 找到引擎但没有模型响应 | 区分安装、Adapter、ACP握手、原生登录/Key、模型权限和额度；查看正式Run错误 |
| 配置保存失败 | 不支持的协议、重复MCP名称、非绝对路径、秘密写在普通字段、Skill变化都可能被拒绝 |
| API 200但检查失败 | `/engines/:id/test`的分项在`checks[].status`，不能只看HTTP状态 |
| 更新配置后老对话没变 | 正常；已有Session固定revision，为新配置创建新Session |
| curl SSE结束/断开 | SSE断开不取消Run；带游标重连并查询Run状态 |
| `RUNTIME_ALREADY_RUNNING` | 已有Gateway拥有该数据库；不要开第二个写入者或删除owner记录 |
| Windows能否直接使用 | 原生启动、Job 监督、脚本后缀、文件路径与 Codex 已取得 Windows 11 ARM64 证据；见 [Windows 指南](windows.md)及[平台边界](../DESIGN.md#8-windows-能力与验证边界) |

## 本地开发

后端变更后`pnpm build`，再重启对应Gateway；不要覆盖其他人正在使用的数据目录。前端开发运行：

```sh
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm dev:console
```

修改公开接口时同步domain schema、消费者与文档，再运行`pnpm docs:api`和相关验证。文档读者测试和生成文件检查见[贡献指南](../CONTRIBUTING.md)。
