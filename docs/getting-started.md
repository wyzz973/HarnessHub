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

服务绑定loopback，拒绝跨Origin/跨站浏览器访问。当前没有远程多用户认证和租户隔离，不应直接当公网服务部署。

demo控制台首次操作时，将“执行模式”改为“直接执行”，再选择fake并发送文本；默认“自动规划”只选择真实引擎，不能用fake生成计划。

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
| demo提示没有可选引擎 | 将执行模式切换到“直接执行”，明确选择fake；自动规划不支持fake |
| 报缺少console.local.yaml | 这是忽略的本机配置；按README用demo或从example准备自己的配置 |
| macOS找不到swiftc | 安装Xcode Command Line Tools；Keychain helper是本机构建依赖 |
| 找到引擎但没有模型响应 | 区分安装、Adapter、ACP握手、原生登录/Key、模型权限和额度；查看正式Run错误 |
| 配置保存失败 | 不支持的协议、重复MCP名称、非绝对路径、秘密写在普通字段、Skill变化都可能被拒绝 |
| API 200但检查失败 | `/engines/:id/test`的分项在`checks[].status`，不能只看HTTP状态 |
| 更新配置后老对话没变 | 正常；已有Session固定revision，为新配置创建新Session |
| curl SSE结束/断开 | SSE断开不取消Run；带游标重连并查询Run状态 |
| `RUNTIME_ALREADY_RUNNING` | 已有Gateway拥有该数据库；不要开第二个写入者或删除owner记录 |
| Windows能否直接使用 | 尚未完成原生监督、脚本后缀与恢复验收；详见[平台边界](../DESIGN.md#8-windows-能力与验证边界) |

## 本地开发

后端变更后`pnpm build`，再重启对应Gateway；不要覆盖其他人正在使用的数据目录。前端开发运行：

```sh
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm dev:console
```

修改公开接口时同步domain schema、消费者与文档，再运行`pnpm docs:api`和相关验证。文档读者测试和生成文件检查见[贡献指南](../CONTRIBUTING.md)。
