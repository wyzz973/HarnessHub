# HTTP API

正式组合根 `startHub` 注册 **40 个 HTTP 操作**，覆盖引擎、配置、会话、运行、权限、事件、产物、工作流和观测。默认地址为 `http://127.0.0.1:3180`；Console通过同源 `/api/gateway` 代理访问实际Gateway。

- [逐接口实现参考](reference.md)：每项的输入、返回、处理链路、持久化/副作用、错误和测试入口。
- [OpenAPI JSON](openapi.json)：可供编辑器与客户端工具读取的生成契约。
- 运行中的 `/openapi.json`：该进程实际启用路由的schema与说明。
- [可执行HTTP示例](../../examples/http-lifecycle.mjs)：无模型依赖的demo生命周期。

## 共同约定

请求体使用JSON。Gateway限制请求体总大小2MiB；各字段还有自己的schema约束。未知业务配置/请求字段通常明确失败，不会删除后偷偷采用默认值；不读取body的动作接口没有额外body语义。时间戳为Unix毫秒，ID为不透明字符串。

当前没有调用方用户身份或租户ID。服务绑定loopback并验证Host/Origin，拒绝跨Origin和跨站请求；不能把此API直接当公网多用户服务。

普通错误格式：

```json
{"error":{"code":"INVALID_REQUEST","message":"Request does not match the API schema"}}
```

部分schema错误附details。400表示无效输入，404用于未找到/不可用资源，409用于状态/幂等/归属冲突，429用于资源上限，503用于服务或清理未就绪；具体错误以接口和实现为准。开始输出的SSE/JSONL流失败会断开连接，不能再返回JSON错误。

**例外**：配置/协议检查通常返回HTTP 200，并用`checks[].status`表达passed/failed。ready接口用503返回`{"ready":false}`。不要只用HTTP 200判断模型或工具可用。

## 主要对象

| 对象 | 关键含义 |
|---|---|
| EngineRegistration | 完整命令/Driver配置；秘密只保存引用；POST/PUT不是局部PATCH |
| EngineProfile | registration解析后的不可变revision与配置能力；登记/inspect返回此平面capabilities结构 |
| GET engines结果 | 在Profile上包装configured/observed/validated能力，不能与登记返回的capabilities结构混用 |
| Session | 固定engineId、profileRevision、workspaceId；创建时不一定有Worker |
| Run | 单次提交与总deadline；状态、输入、配置快照、输出、cleanupStatus与lastSeq |
| Permission | 一次具体工具请求的实际选项、期限和决定/应用状态 |
| AgentEvent | Run内递增seq与完整身份；是SSE/JSONL/观测的提交事实 |
| Artifact | 不可变文件的ID、name、mediaType、size、hash；下载不接受文件路径 |
| Workflow | 模型生成计划、确认、步骤依赖与绑定的Session/Run |
| Observation | 从持久证据计算的模型/时序/用量/费用；缺失值保留null与原因 |

当前Run输入是`text`、可选`timeoutMs/outputs`；不是任意多模态内容块或上传文件API。outputs是执行后要收集的Workspace相对路径，不能用作任意主机文件读取入口。

## 幂等、流式与生命周期

Run提交的`Idempotency-Key`在**同一Session**内作用：同key同输入重放同一Run，同key不同输入冲突。Workflow key由WorkflowStore独立管理；不要把它当成跨API或调用方隔离机制。

202代表已接收，必须查询Run/Workflow的实际状态。`completed`代表执行正常结束；任务正确性由文件/文本/JSON评判证明。cancel返回后继续查终态和cleanupStatus。

SSE使用`id: seq`、`event: type`、`data: AgentEvent JSON`。`afterSeq`优先于Last-Event-ID；重连可能重放，按Run ID和seq去重。流断开不会取消任务。`event-log`用于有界JSON页读取，`rollout`用于当前已提交日志导出。

## 文档维护

人工说明集中在 [api-catalog.ts](../../src/gateway/api-catalog.ts)，参数与响应schema保留在原domain/route声明。运行：

```sh
pnpm docs:api
pnpm check:api
```

生成器启动一个临时demo Gateway以读取实际路由，不调用引擎/模型；同时补齐导出版的SSE/NDJSON/二进制媒体类型。`check:api`双向检查路由与文档覆盖、唯一operationId、源码/测试链接以及生成文件是否过期，已加入`pnpm check`。泛型JSON扩展事件/原生观测仍保留开放schema，不假装为第三方所有payload提供封闭类型。

新增、删除或修改路由时，同次更新catalog、schema、实现与相关测试，然后重新生成两个文件；不要直接编辑reference.md/openapi.json。检查器的拒绝用例见 [API文档检查测试](../../scripts/check-api-docs.test.mjs)。
