/** Reviewed HTTP behavior and implementation pointers. Consumed by OpenAPI and the documentation generator; schemas remain the validation authority. */
export interface ApiDocumentation {
  method: string;
  path: string;
  title: string;
  group: string;
  request: string;
  response: string;
  implementation: string;
  effects: string;
  errors: string;
  source: string;
  tests: readonly string[];
  operationId: string;
}
export const apiCatalog: readonly ApiDocumentation[] = [
  {
    method: "GET",
    path: "/health/live",
    title: "进程存活",
    group: "health",
    request: "无参数。",
    response: "200：status=ok。",
    implementation: "路由直接返回固定存活标记，不调用 Engine、不检查模型。",
    effects: "只读；不写库。",
    errors: "仍受 loopback Host/Origin 检查。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_get_health_live",
  },
  {
    method: "GET",
    path: "/health/ready",
    title: "服务就绪",
    group: "health",
    request: "无参数。",
    response: "200 或 503：ready 布尔值。",
    implementation:
      "汇总 HubApplication.isReady 与 WorkflowService.isReady；Runtime/存储失败会反映为未就绪。",
    effects: "只读。引擎是否安装或登录不在此检查中。",
    errors: "503 表示服务当前不接收可靠执行，不能用重跑未知 Run 修复。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_get_health_ready",
  },
  {
    method: "GET",
    path: "/openapi.json",
    title: "运行时 OpenAPI",
    group: "health",
    request: "无参数。",
    response: "200：OpenAPI 3.0.3 对象。",
    implementation:
      "@fastify/swagger 从已注册路由 schema 生成文档；api-catalog 补充说明。",
    effects: "只读；不枚举真实引擎配置、凭证或任务。",
    errors: "仅包含本次组合根启用的路由；startHub 启用全部模块。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/observability.test.ts"],
    operationId: "hh_get_openapi_json",
  },
  {
    method: "GET",
    path: "/v1/engines",
    title: "已登记引擎",
    group: "engines",
    request: "无参数。",
    response:
      "200：engines 数组。capabilities 分 configured / observed / validated。",
    implementation:
      "HubApplication.engines → Runtime.listEngines → EngineManager 当前文件+overlay视图；观测按 revision 关联。",
    effects: "只读，包含停用项，不自动发现/注册。",
    errors: "validated 无证据时为 null；不能从 configured 推断验证通过。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/engine-management.test.ts"],
    operationId: "hh_get_v1_engines",
  },
  {
    method: "GET",
    path: "/v1/engines/discover",
    title: "发现本机引擎",
    group: "engines",
    request: "无参数。",
    response:
      "200：candidates，含 source/status/notes，可用项有 registration。",
    implementation:
      "HubApplication.discoverEngines → EngineManager.discover → discoverEngines；扫描 PATH、固定安装目录、JSON manifest。",
    effects: "读取安装和 manifest；不执行程序、不安装包、不调用模型或注册。",
    errors:
      "INVALID_ENGINE_MANIFEST：目录/内容/命令非法或多个 manifest 同 ID。",
    source: "src/gateway/server.ts",
    tests: ["tests/unit/discovery.test.ts", "tests/smoke/discovery.test.ts"],
    operationId: "hh_get_v1_engines_discover",
  },
  {
    method: "GET",
    path: "/v1/engines/registry",
    title: "引擎目录状态",
    group: "engines",
    request: "无参数。",
    response: "200：defaultEngine、watching、lastReloadAt、lastError。",
    implementation:
      "读取 EngineManager.status/defaultId，展示上次配置 reload 的结果。",
    effects: "只读；不是检查运行中的每个模型。",
    errors: "无有效默认引擎时 defaultEngine 为空字符串。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/engine-management.test.ts"],
    operationId: "hh_get_v1_engines_registry",
  },
  {
    method: "POST",
    path: "/v1/engines",
    title: "完整登记或替换引擎",
    group: "engines",
    request:
      "完整 EngineRegistration：id/driver/command 必填，model/credentialEnv/configuration/cli/acp 等可选。PUT 路径 id 必须等于 body.id。",
    response: "201：EngineProfile；capabilities 是平面的配置声明。",
    implementation:
      "Gateway schema → HubApplication.registerEngine → EngineManager 串行队列 → prepareEngine 校验/Skill指纹 → normalizeEngine生成hash → publish。",
    effects:
      "先写 SQLite engine_catalog v2（overlay与完整历史revision），再替换内存目录；旧 Session 保留旧 revision。不是 PATCH。",
    errors:
      "INVALID_REQUEST、INVALID_CONFIG、INVALID_ENGINE_CONFIGURATION、ENGINE_CONFIGURATION_UNSUPPORTED、ENGINE_RESERVED、ENGINE_CATALOG_FULL；PUT另有ENGINE_ID_MISMATCH。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/engine-management.test.ts",
      "tests/integration/engine-configuration.test.ts",
    ],
    operationId: "hh_post_v1_engines",
  },
  {
    method: "PUT",
    path: "/v1/engines/{id}",
    title: "完整登记或替换引擎",
    group: "engines",
    request:
      "完整 EngineRegistration：id/driver/command 必填，model/credentialEnv/configuration/cli/acp 等可选。PUT 路径 id 必须等于 body.id。",
    response: "200：EngineProfile；capabilities 是平面的配置声明。",
    implementation:
      "Gateway schema → HubApplication.registerEngine → EngineManager 串行队列 → prepareEngine 校验/Skill指纹 → normalizeEngine生成hash → publish。",
    effects:
      "先写 SQLite engine_catalog v2（overlay与完整历史revision），再替换内存目录；旧 Session 保留旧 revision。不是 PATCH。",
    errors:
      "INVALID_REQUEST、INVALID_CONFIG、INVALID_ENGINE_CONFIGURATION、ENGINE_CONFIGURATION_UNSUPPORTED、ENGINE_RESERVED、ENGINE_CATALOG_FULL；PUT另有ENGINE_ID_MISMATCH。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/engine-management.test.ts",
      "tests/integration/engine-configuration.test.ts",
    ],
    operationId: "hh_put_v1_engines_id",
  },
  {
    method: "DELETE",
    path: "/v1/engines/{id}",
    title: "移除当前引擎",
    group: "engines",
    request: "路径 id。",
    response: "200：removed=true。",
    implementation:
      "EngineManager.remove 在串行管理队列写入 overlay tombstone。",
    effects:
      "影响新 Session；保留历史配置、Session、Run，文件 reload 不会使已删除项复活。",
    errors:
      "ENGINE_UNAVAILABLE：未登记；ENGINE_RESERVED：demo 引擎不能由此删除。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/engine-management.test.ts"],
    operationId: "hh_delete_v1_engines_id",
  },
  {
    method: "PUT",
    path: "/v1/engines/default",
    title: "修改新会话默认引擎",
    group: "engines",
    request: "body：engineId。",
    response: "200：目录状态与新的 defaultEngine。",
    implementation:
      "EngineManager.resolve 校验可用性，持久化 defaultOverride 后发布。",
    effects: "只改变新 Session 的默认选择。",
    errors:
      "ENGINE_UNAVAILABLE：不存在/停用；ENGINE_RESERVED：fake默认由demo控制。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/engine-management.test.ts"],
    operationId: "hh_put_v1_engines_default",
  },
  {
    method: "POST",
    path: "/v1/engines/reload",
    title: "重读文件配置",
    group: "engines",
    request: "无需请求体。",
    response: "200：engines 数量、defaultEngine。",
    implementation:
      "EngineManager.reload → loadConfig → 部署字段一致性检查 → publish；与文件监听共用路径。",
    effects:
      "全量校验通过后才应用引擎项；失败保留最后有效目录并记录 lastError。API overlay继续优先。",
    errors:
      "CONFIG_RESTART_REQUIRED：Workspace/并发等部署项变化；配置/文件错误不部分应用。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/engine-management.test.ts"],
    operationId: "hh_post_v1_engines_reload",
  },
  {
    method: "GET",
    path: "/v1/engine-configuration/templates",
    title: "本机标准启动模板",
    group: "configuration",
    request: "无参数。",
    response: "200：candidates，结构同发现结果。",
    implementation:
      "注入的 ConfigurationManagement.templates 调用发现器 includeManifests=false。",
    effects: "只读安装证据，故意忽略 manifest 覆盖，供用户明确替换固定脚本。",
    errors: "模板缺失/adapter-required 不等于自动安装；文件访问错误单独失败。",
    source: "src/gateway/engine-configuration-routes.ts",
    tests: ["tests/unit/discovery.test.ts"],
    operationId: "hh_get_v1_engine_configuration_templates",
  },
  {
    method: "GET",
    path: "/v1/engine-configuration/adapters",
    title: "配置适配能力",
    group: "configuration",
    request: "无参数。",
    response: "200：adapters，含 id、providerProtocols、description。",
    implementation:
      "组合根将 configurationAdapters 与 providerProtocols 交给 EngineConfigurationService。",
    effects: "只读静态能力表；不保证某个二进制版本已安装或已验证。",
    errors:
      "协议列表为空时保留原生配置/显式环境引用，不接受统一 Provider 字段。",
    source: "src/gateway/engine-configuration-routes.ts",
    tests: ["tests/unit/engine-configuration.test.ts"],
    operationId: "hh_get_v1_engine_configuration_adapters",
  },
  {
    method: "POST",
    path: "/v1/engine-configuration/inspect",
    title: "检查待保存配置",
    group: "configuration",
    request: "完整 EngineRegistration；不接受原始 API Key。",
    response: "200：带 revision 与 Skill 指纹的 EngineProfile。",
    implementation:
      "EngineConfigurationService.inspect → prepareEngine；schema和语义校验，再读取启用的SKILL.md并pin SHA-256。",
    effects:
      "读本地 Skill 文件，不注册、不写业务库、不解析秘密值、不启动引擎。",
    errors: "配置不支持、Skill不可用/过大/指纹已变化均失败。",
    source: "src/gateway/engine-configuration-routes.ts",
    tests: [
      "tests/unit/engine-configuration.test.ts",
      "tests/integration/engine-configuration.test.ts",
    ],
    operationId: "hh_post_v1_engine_configuration_inspect",
  },
  {
    method: "POST",
    path: "/v1/engines/{id}/test",
    title: "配置与协议检查",
    group: "configuration",
    request: "路径 id；检查已保存配置，通常发送空对象。",
    response:
      "通常200：engineId/revision/checkedAt/modelCalled=false/checks；必须检查 checks[].status。",
    implementation:
      "最多两次并发；私有测试目录中prepareConfiguration解析秘密/Skills/native配置，然后probeConfiguration执行ACP initialize或检查CLI executable。",
    effects:
      "会读秘密、创建临时文件并启动ACP检查进程；不发送prompt。结束等待进程组清理并回收测试目录。",
    errors:
      "不存在/fake → ENGINE_UNAVAILABLE；并发满 → PROBE_BUSY/429；解析/握手失败通常是200中的failed分项，不是模型可用证明。",
    source: "src/gateway/engine-configuration-routes.ts",
    tests: [
      "tests/unit/engine-configuration.test.ts",
      "tests/integration/engine-configuration.test.ts",
    ],
    operationId: "hh_post_v1_engines_id_test",
  },
  {
    method: "POST",
    path: "/v1/secrets",
    title: "保存新的密钥引用",
    group: "configuration",
    request: "JSON：value，非空单行、至多8KiB；不要用真实值写入脚本/文档。",
    response: "201：reference={kind:keychain,value:UUID}；不返回原密钥。",
    implementation:
      "createSecret → Swift Security helper；stdin传值，固定HarnessHub service和新UUID写入Keychain。",
    effects:
      "写操作，仅macOS；新引用不可变，历史引用不自动删除。业务库不保存密钥值。",
    errors:
      "INVALID_SECRET；KEYCHAIN_UNSUPPORTED；SECRET_UNAVAILABLE（锁定、缺失或不可读）。",
    source: "src/gateway/engine-configuration-routes.ts",
    tests: ["tests/unit/engine-configuration.test.ts"],
    operationId: "hh_post_v1_secrets",
  },
  {
    method: "GET",
    path: "/v1/workspaces",
    title: "可用工作区与默认项",
    group: "sessions",
    request: "无参数。",
    response: "200：workspaces[{id,path}]、defaultEngine、defaultWorkspace。",
    implementation: "HubApplication读取已解析并realpath校验的部署配置。",
    effects: "只读；本版本无远程创建/修改Workspace接口，调整部署工作区需重启。",
    errors: "HTTP只接收已登记workspaceId，不能在Run里提交任意cwd。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_get_v1_workspaces",
  },
  {
    method: "GET",
    path: "/v1/sessions",
    title: "最近会话",
    group: "sessions",
    request: "limit默认100，范围1～200。",
    response: "200：sessions，按updatedAt降序截取。",
    implementation: "Gateway读取Store全部Session后排序并限制返回数量。",
    effects: "只读；当前不是分页游标API，也不是大规模数据库分页。",
    errors: "INVALID_REQUEST：非法limit；空集合返回空数组。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/console-lifecycle.test.ts"],
    operationId: "hh_get_v1_sessions",
  },
  {
    method: "POST",
    path: "/v1/sessions",
    title: "创建绑定引擎的会话",
    group: "sessions",
    request: "JSON对象：engineId、workspaceId均可省略。",
    response: "201：SessionRecord。",
    implementation:
      "Runtime选择默认/显式引擎与Workspace，固定engineId+profileRevision并写Session。",
    effects: "写SQLite；Worker懒启动，创建Session本身不请求模型。",
    errors:
      "ENGINE_UNAVAILABLE、Workspace不可用、服务关闭；无跨引擎迁移或调用方身份隔离。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/gateway.test.ts",
      "tests/integration/engine-management.test.ts",
    ],
    operationId: "hh_post_v1_sessions",
  },
  {
    method: "POST",
    path: "/v1/sessions/auto",
    title: "自动选引擎并创建会话",
    group: "sessions",
    request:
      "workspaceId可选；requiredCapabilities可选且只支持permissions/images。",
    response: "201：session和selection（候选资格、score、reason、revision）。",
    implementation:
      "selectWorkflowEngine按能力、历史、负载和默认偏好选取，Runtime创建显式绑定Session，selection记入routing。",
    effects: "写Session与选路证据；不安装、调用或重新分配已有Session。",
    errors: "无符合能力的已启用引擎会失败；不是模型质量最优的证明。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/workflows.test.ts"],
    operationId: "hh_post_v1_sessions_auto",
  },
  {
    method: "GET",
    path: "/v1/sessions/{id}",
    title: "读取会话",
    group: "sessions",
    request: "路径 id。",
    response: "200：SessionRecord。",
    implementation: "HubApplication.getSession → SqliteStore.getSession。",
    effects: "只读，包括已关闭会话；不恢复Worker。",
    errors: "未知ID明确失败，不创建同名空会话。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_get_v1_sessions_id",
  },
  {
    method: "POST",
    path: "/v1/sessions/{id}/suspend",
    title: "释放可恢复会话的空闲Worker",
    group: "sessions",
    request: "路径 id；无需请求体。",
    response: "200：session、cleanupStatus。",
    implementation:
      "Runtime校验空闲及acp.sessionMode=resume，ProcessHost关闭所属Worker；公共Session和backend身份保留。",
    effects:
      "回收进程，写清理/会话状态；后续Run严格按原backend/checkpoint恢复。",
    errors: "忙碌/有排队工作/恢复不支持时拒绝；清理未确认不得当作成功可复用。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/gateway-recovery.test.ts",
      "tests/integration/acp-recovery.test.ts",
    ],
    operationId: "hh_post_v1_sessions_id_suspend",
  },
  {
    method: "POST",
    path: "/v1/sessions/{id}/close",
    title: "关闭会话",
    group: "sessions",
    request: "路径 id；无需请求体。",
    response: "200：最终Session状态。",
    implementation:
      "Runtime关闭接收入口，取消本Session排队/活动Run，等待Host清理。",
    effects:
      "会结束该会话所属执行资源；保留历史记录、事件与产物；不等待其他Session的Run。",
    errors:
      "未知ID失败；已关闭的调用保持收敛语义；无法确认清理时不能据返回文本推断进程已消失。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_post_v1_sessions_id_close",
  },
  {
    method: "GET",
    path: "/v1/runs",
    title: "最近运行",
    group: "runs",
    request: "limit默认100，范围1～200。",
    response: "200：runs，按createdAt降序。",
    implementation: "Gateway读Store运行集合，再排序并截取。",
    effects: "只读；没有过滤任意engine/状态的查询参数。",
    errors: "INVALID_REQUEST：非法/未知query参数。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/console-lifecycle.test.ts"],
    operationId: "hh_get_v1_runs",
  },
  {
    method: "GET",
    path: "/v1/sessions/{id}/runs",
    title: "会话运行历史",
    group: "runs",
    request: "路径Session id；无分页query。",
    response: "200：runs，保留Store顺序的最后200项。",
    implementation: "先确认Session存在，Store按Session读Run并slice(-200)。",
    effects: "只读；不是全量历史导出接口。",
    errors: "Session不存在失败；Run数组可为空。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_get_v1_sessions_id_runs",
  },
  {
    method: "POST",
    path: "/v1/sessions/{id}/runs",
    title: "提交一次执行",
    group: "runs",
    request:
      "text必填；timeoutMs、outputs可选。fixture仅demo/fake使用。Idempotency-Key可选。",
    response: "202：RunRecord+replayed；Location指向/v1/runs/{runId}。",
    implementation:
      "schema → Runtime.submit → Store幂等接收/原子事件 → 排队调度 → 安装快照 → ProcessHost/Worker/Driver。",
    effects:
      "先持久接收再异步执行；相同Session串行、跨Session受并发限制；截止时间从接收起算。",
    errors:
      "幂等key相同且输入不同冲突；会话关闭、队列满、能力/outputs非法会拒绝。202不是任务完成。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/gateway.test.ts",
      "tests/integration/gateway-files.test.ts",
    ],
    operationId: "hh_post_v1_sessions_id_runs",
  },
  {
    method: "GET",
    path: "/v1/runs/{id}",
    title: "运行状态与关联记录",
    group: "runs",
    request: "路径 Run id。",
    response: "200：RunRecord，并带 permissions、artifacts。",
    implementation:
      "HubApplication.getRun组合Store中的Run、Permission和Artifact元数据。",
    effects: "只读持久记录，不因浏览器查询而启动任务。",
    errors: "未知ID失败；completed只表示执行正常结束，正确性由Evaluator判断。",
    source: "src/gateway/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_get_v1_runs_id",
  },
  {
    method: "POST",
    path: "/v1/runs/{id}/cancel",
    title: "请求取消运行",
    group: "runs",
    request: "路径 Run id；无需请求体。",
    response: "202：当前Run状态。",
    implementation:
      "Runtime.cancel幂等仲裁，排队任务直接收敛；活动执行向Worker发送cancel，再按Host策略升级终止。",
    effects: "写取消与终态相关事件，回收拥有的进程；迟到完成不能覆盖取消结果。",
    errors: "202不代表进程已经退出；轮询Run的终态和cleanupStatus。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/worker-cli.test.ts",
      "tests/integration/gateway.test.ts",
    ],
    operationId: "hh_post_v1_runs_id_cancel",
  },
  {
    method: "POST",
    path: "/v1/permissions/{id}/decision",
    title: "决定工具权限",
    group: "runs",
    request: "body：optionId，必须使用该Permission返回的实际options[].id。",
    response: "200：PermissionRecord（decided/applied等状态）。",
    implementation:
      "Runtime核对run/generation/tool关联、有效期和实际选项，Store先提交决定，再发送Worker；后端确认再记applied。",
    effects: "会允许或拒绝所选工具动作；重复相同决定幂等，冲突不能覆盖。",
    errors: "不存在、过期、冲突和非法option明确失败；decided不等于后端已执行。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/gateway.test.ts",
      "tests/integration/pressure.test.ts",
    ],
    operationId: "hh_post_v1_permissions_id_decision",
  },
  {
    method: "GET",
    path: "/v1/runs/{id}/event-log",
    title: "读取已提交事件页",
    group: "events",
    request: "afterSeq默认0；limit默认1000，范围1～1000。",
    response: "200：events数组，按seq递增，返回seq大于afterSeq的事件。",
    implementation:
      "HubApplication.events → SqliteStore.events；直接查询持久日志，不依赖实时订阅内存。",
    effects: "只读；客户端用最后一条seq继续请求；此接口不阻塞等待新事件。",
    errors: "参数非法失败；不要把空页当作执行结束，另查Run终态。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/observability.test.ts",
      "tests/integration/store.test.ts",
    ],
    operationId: "hh_get_v1_runs_id_event_log",
  },
  {
    method: "GET",
    path: "/v1/runs/{id}/events",
    title: "订阅与重放SSE",
    group: "events",
    request:
      "afterSeq优先，其次Last-Event-ID，均默认0；游标不得大于Run.lastSeq。",
    response:
      "200 text/event-stream：id=seq，event=type，data=完整AgentEvent。",
    implementation:
      "每批查100条已提交事件，按seq发送；背压等待drain；无新事件25ms后继续，终态且追平后结束。",
    effects: "只读。客户端断开仅取消订阅，不取消Run；客户端按runId/seq去重。",
    errors: "INVALID_CURSOR；写流后错误会断开连接，需带游标重连并查询Run。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/gateway.test.ts",
      "tests/integration/pressure.test.ts",
    ],
    operationId: "hh_get_v1_runs_id_events",
  },
  {
    method: "GET",
    path: "/v1/runs/{id}/rollout",
    title: "导出提交日志",
    group: "events",
    request: "路径 Run id。",
    response: "200 application/x-ndjson：逐行完整AgentEvent。",
    implementation:
      "HubApplication.rollout每批100条从Store读取，Readable流返回；不读取独立第二份JSONL事实源。",
    effects: "只读；活动Run的导出是读取当时可见的提交日志，不是持续SSE订阅。",
    errors: "未知Run失败；流输出开始后不能再返回标准JSON错误。",
    source: "src/gateway/server.ts",
    tests: ["tests/smoke/rollout.test.ts"],
    operationId: "hh_get_v1_runs_id_rollout",
  },
  {
    method: "GET",
    path: "/v1/artifacts/{id}",
    title: "下载登记产物",
    group: "artifacts",
    request: "路径Artifact id；不接受任意文件路径。",
    response:
      "200：原mediaType字节；Content-Disposition、X-Content-SHA256、nosniff/CSP。",
    implementation:
      "HubApplication.artifact先查Store元数据，再由注入reader校验/读取受控产物。",
    effects:
      "只读不可变快照；元数据来自Run.artifacts，不直接暴露内部storagePath。",
    errors: "未登记、文件缺失/身份或完整性变化明确失败。",
    source: "src/gateway/server.ts",
    tests: [
      "tests/integration/gateway-files.test.ts",
      "tests/integration/file-artifacts.test.ts",
    ],
    operationId: "hh_get_v1_artifacts_id",
  },
  {
    method: "GET",
    path: "/v1/workflows",
    title: "工作流历史",
    group: "workflows",
    request: "无参数。",
    response: "200：workflows。",
    implementation:
      "WorkflowService.list → SqliteWorkflowStore；包含规划中、draft及终态记录。",
    effects: "只读；不重新规划、不自动重跑。",
    errors: "该模块由startHub启用；其他自定义组合根可以不注册此组路由。",
    source: "src/gateway/workflow-routes.ts",
    tests: ["tests/integration/workflows.test.ts"],
    operationId: "hh_get_v1_workflows",
  },
  {
    method: "POST",
    path: "/v1/workflows",
    title: "模型生成计划",
    group: "workflows",
    request:
      "goal必填；workspaceId、engineId、plannerEngineId、timeoutMs可选；可带Idempotency-Key。",
    response: "202：Workflow，初始planning；成功生成合法计划后进入draft。",
    implementation:
      "WorkflowService.create持久化请求/选择，创建规划Session/Run，让引擎返回有界DAG，校验计划和工具行为。",
    effects:
      "会调用所选规划引擎；draft之前不执行步骤。计划最多8步，校验依赖、输出路径与能力。",
    errors:
      "幂等输入冲突；规划超时/非法JSON/环/越界/规划工具行为等记失败；202不表示计划已通过。",
    source: "src/gateway/workflow-routes.ts",
    tests: ["tests/integration/workflows.test.ts"],
    operationId: "hh_post_v1_workflows",
  },
  {
    method: "GET",
    path: "/v1/workflows/{id}",
    title: "读取计划与步骤状态",
    group: "workflows",
    request: "路径Workflow id。",
    response:
      "200：Workflow，含steps、selection、关联Session/Run、outputs和error。",
    implementation: "WorkflowService.get从持久Store读取一致记录。",
    effects: "只读，可在刷新/重启后恢复查看；不恢复未知执行。",
    errors: "未知Workflow失败。",
    source: "src/gateway/workflow-routes.ts",
    tests: ["tests/integration/workflows.test.ts"],
    operationId: "hh_get_v1_workflows_id",
  },
  {
    method: "POST",
    path: "/v1/workflows/{id}/approve",
    title: "确认并执行计划",
    group: "workflows",
    request: "路径Workflow id；无需请求体。",
    response: "202：Workflow。",
    implementation:
      "首次WorkflowService.approve要求draft，核对计划固定的引擎revision，绑定步骤Session后串行按依赖执行；已批准计划重复审批返回原记录，不重复提交步骤。",
    effects:
      "会实际执行计划中的文件/工具/模型动作，沿用Runtime权限、期限、产物与事件机制。",
    errors:
      "revision变化、状态不允许或引擎不可用拒绝；任一步骤失败即停止整个计划，全部尚未执行步骤（包括无依赖步骤）标记blocked，不切换引擎或重跑。",
    source: "src/gateway/workflow-routes.ts",
    tests: ["tests/integration/workflows.test.ts"],
    operationId: "hh_post_v1_workflows_id_approve",
  },
  {
    method: "POST",
    path: "/v1/workflows/{id}/cancel",
    title: "取消工作流",
    group: "workflows",
    request: "路径Workflow id；无需请求体。",
    response: "200：当前Workflow。",
    implementation:
      "WorkflowService.cancel持久化取消意图，取消活动Run，阻止后续步骤并关闭所属Session。",
    effects: "会结束工作流拥有的执行；保留已提交步骤结果与产物。",
    errors: "状态可能仍为cancelling，需继续查询；重启不会重新提交旧步骤。",
    source: "src/gateway/workflow-routes.ts",
    tests: ["tests/integration/workflows.test.ts"],
    operationId: "hh_post_v1_workflows_id_cancel",
  },
  {
    method: "GET",
    path: "/v1/runs/{id}/observations",
    title: "重建单次运行观测",
    group: "observability",
    request: "路径Run id。",
    response:
      "200：schemaVersion=1的model/timings/tokens/cost/counts/versions/coverage。",
    implementation:
      "ObservationService.run从已提交事件和可用原生usage证据重建；区分配置模型和实际模型。",
    effects: "只读投影；不另调用模型、账户账单或计费API。",
    errors:
      "缺失证据保留null及missingReason；累计Session用量不能重复归入每个Run。",
    source: "src/gateway/observation-routes.ts",
    tests: [
      "tests/integration/observability.test.ts",
      "tests/unit/observability.test.ts",
    ],
    operationId: "hh_get_v1_runs_id_observations",
  },
  {
    method: "GET",
    path: "/v1/observability",
    title: "全局观测概览",
    group: "observability",
    request: "limit默认50，范围1～200。",
    response: "200：scope、summary、engines、recentRuns。",
    implementation:
      "ObservationService.overview读取Run集合，选最近样本重建观测，计算计数与有证据的耗时/用量统计。",
    effects:
      "只读；scope明确totalRuns和sampledRuns，不将近期样本冒充全量账单。",
    errors: "INVALID_OBSERVATION_LIMIT/INVALID_REQUEST；未知费用或用量不补0。",
    source: "src/gateway/observation-routes.ts",
    tests: ["tests/integration/observability.test.ts"],
    operationId: "hh_get_v1_observability",
  },
];
