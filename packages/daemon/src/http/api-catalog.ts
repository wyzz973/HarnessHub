// SPDX-License-Identifier: MIT
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
    tests: [
      "packages/agents/test/discovery.test.ts",
      "tests/smoke/discovery.test.ts",
    ],
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/engine-configuration-routes.ts",
    tests: ["packages/agents/test/discovery.test.ts"],
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
    source: "packages/daemon/src/http/engine-configuration-routes.ts",
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
    source: "packages/daemon/src/http/engine-configuration-routes.ts",
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
    source: "packages/daemon/src/http/engine-configuration-routes.ts",
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
      "createSecret → 平台秘密helper；stdin传值，新UUID写入macOS Keychain或Windows当前用户DPAPI密文目录。",
    effects:
      "写操作，仅macOS；新引用不可变，历史引用不自动删除。业务库不保存密钥值。",
    errors:
      "INVALID_SECRET；KEYCHAIN_UNSUPPORTED；SECRET_UNAVAILABLE（锁定、缺失或不可读）。",
    source: "packages/daemon/src/http/engine-configuration-routes.ts",
    tests: ["tests/unit/engine-configuration.test.ts"],
    operationId: "hh_post_v1_secrets",
  },
  {
    method: "GET",
    path: "/v1/harness/model",
    title: "查看统一模型",
    group: "configuration",
    request: "无参数。",
    response:
      "200：HarnessModelView，含 configured、source（environment/file/settings）、真实 model、alias、只含秘密引用的 provider，以及每个引擎的 applied/unsupported/disabled 状态和原因。",
    implementation:
      "HarnessModelService.view 读取启动时解析的生效来源，并按当前引擎目录计算每个引擎的登记策略结果。",
    effects: "只读；不解析秘密、不调用模型。",
    errors: "未配置时返回 configured=false，不报错。",
    source: "packages/daemon/src/http/harness-model-routes.ts",
    tests: ["tests/integration/harness-model.test.ts"],
    operationId: "hh_get_v1_harness_model",
  },
  {
    method: "PUT",
    path: "/v1/harness/model",
    title: "设置统一模型",
    group: "configuration",
    request:
      "JSON：HarnessModel（model、可选 alias、provider）；provider.protocol 仅接受 openai-completions，apiKey/secretHeaders 只接受秘密引用。",
    response: "200：更新后的 HarnessModelView。",
    implementation:
      "校验后原子写入统一模型文件，再经 EngineManager 登记策略为全部引擎发布新 revision。",
    effects:
      "写统一模型文件和引擎目录；新 Session 使用新 revision，已有 Session 保留原 revision。文件只保存秘密引用。",
    errors:
      "INVALID_HARNESS_MODEL、HARNESS_MODEL_PROTOCOL_UNSUPPORTED（400）；HARNESS_MODEL_ENVIRONMENT_OVERRIDE（409，环境变量来源生效时）；HARNESS_MODEL_FILE_UNAVAILABLE（409）。",
    source: "packages/daemon/src/http/harness-model-routes.ts",
    tests: ["tests/integration/harness-model.test.ts"],
    operationId: "hh_put_v1_harness_model",
  },
  {
    method: "POST",
    path: "/v1/harness/model/test",
    title: "测试统一模型",
    group: "configuration",
    request: "JSON：可选 engineId，缺省使用默认引擎。",
    response:
      "200：ok、status、durationMs、runId 和可选 error；只有 Run 正常完成且回复非空时 ok=true。",
    implementation:
      "在私有临时目录创建正式 Session，提交“只回复 OK”，最多等待 90 秒后关闭 Session；秘密只在 Worker 内解析。",
    effects: "会实际调用模型并消耗额度；产生一条正式 Run 记录。",
    errors:
      "HARNESS_MODEL_NOT_CONFIGURED、HARNESS_MODEL_TEST_UNSUPPORTED（409）；HARNESS_MODEL_TEST_BUSY（429）；HARNESS_MODEL_CLOSED（503）。",
    source: "packages/daemon/src/http/harness-model-routes.ts",
    tests: ["tests/integration/harness-model.test.ts"],
    operationId: "hh_post_v1_harness_model_test",
  },
  {
    method: "GET",
    path: "/v1/tool-packs",
    title: "已安装工具包",
    group: "tool-packs",
    request: "无参数。",
    response:
      "200：packages 数组，每项含登记记录、displayName、Skill/MCP/CLI 数量、正在使用该包的引擎；单个包清单无法读取时以 problem 标出。",
    implementation:
      "读取工具包存储的登记表与各包清单，并按引擎目录计算绑定关系。",
    effects: "只读；不执行包内程序。",
    errors: "TOOL_PACKAGE_REGISTRY_CORRUPT。",
    source: "packages/daemon/src/http/tool-package-routes.ts",
    tests: ["tests/integration/tool-pack-gateway.test.ts"],
    operationId: "hh_get_v1_tool_packs",
  },
  {
    method: "POST",
    path: "/v1/tool-packs/import",
    title: "导入工具包",
    group: "tool-packs",
    request:
      'JSON：source（本机绝对路径：Skill 目录、mcp.json、cli.json、SKILL.md 或完整包目录）与 mcp（直接粘贴的 {"mcpServers":{...}} 文档，最多 256 KiB）二选一；可选 kind、id、version、displayName、applyTo（all 或引擎数组）、replace、secretBindings。',
    response:
      "200：ok、package{id,version}、displayName、digest、format、counts、warnings，以及指定 applyTo 时的 apply 结果。",
    implementation:
      "识别简易格式并生成含 sha256 的清单，校验后安装到工具包存储；运行时下载型命令（npx/uvx 等）拒绝，像密钥的 env 改为同名环境变量引用。内联 mcp 文档先写成临时 mcp.json 再走同一导入器（默认包 id 取自首个服务名），旁边没有文件，因此只有远程 URL 服务能通过，本地命令按离线规则拒绝并提示改用目录导入。",
    effects:
      "写工具包存储；指定 applyTo 时为每个接受的引擎发布新 revision，已有 Session 不变。",
    errors:
      "INVALID_TOOL_PACKAGE_SOURCE、TOOL_PACKAGE_IMPORT_UNSUPPORTED、TOOL_PACKAGE_TOO_LARGE、TOOL_PACKAGE_VERSION_CONFLICT（400）；TOOL_PACKAGE_BUSY。",
    source: "packages/daemon/src/http/tool-package-routes.ts",
    tests: [
      "tests/integration/tool-pack-gateway.test.ts",
      "tests/unit/tool-packages-import.test.ts",
    ],
    operationId: "hh_post_v1_tool_packs_import",
  },
  {
    method: "POST",
    path: "/v1/tool-packs/apply",
    title: "应用工具包到引擎",
    group: "tool-packs",
    request:
      "JSON：engineIds（all 或数组）或旧字段 engineId；package{id,version} 与 source 二选一；可选 replace、secretBindings。",
    response:
      "200：ok、package、results[{engineId,status:applied/skipped/failed,revision?,code?,reason?,capabilities?,replaced?}]、warnings、note；单引擎请求另带顶层 engineId/revision/capabilities。",
    implementation:
      "逐个引擎预检并绑定，每个引擎独立发布新 revision；replace 先移除同一包的旧版本绑定。",
    effects: "写引擎 overlay；只影响新 Session。单个引擎失败不影响其他引擎。",
    errors:
      "INVALID_REQUEST、INVALID_TOOL_PACKAGE_BINDING（400）；TOOL_PACKAGE_NOT_FOUND、ENGINE_UNAVAILABLE（404）；单引擎模式的绑定冲突（409）；ENGINE_LISTING_UNAVAILABLE（501）。",
    source: "packages/daemon/src/http/tool-package-routes.ts",
    tests: [
      "tests/integration/tool-pack-gateway.test.ts",
      "tests/integration/tool-pack-apply.test.ts",
    ],
    operationId: "hh_post_v1_tool_packs_apply",
  },
  {
    method: "DELETE",
    path: "/v1/tool-packs/{id}/{version}/bindings",
    title: "解除工具包绑定",
    group: "tool-packs",
    request:
      "engineIds 必填：JSON body 或查询参数（all，或逗号分隔的引擎 id），二者选一。",
    response:
      "200：ok、package、results[{engineId,status:unbound/skipped/failed,revision?,code?,reason?,removed?}]、note。",
    implementation:
      "从选定引擎移除该包带来的 Skill 与 MCP 条目，并为每个变化的引擎发布新 revision。",
    effects: "写引擎 overlay；已有 Session 不变，工具包文件保留。",
    errors:
      "400；TOOL_PACKAGE_NOT_FOUND（404）；ENGINE_LISTING_UNAVAILABLE（501）。",
    source: "packages/daemon/src/http/tool-package-routes.ts",
    tests: ["tests/integration/tool-pack-gateway.test.ts"],
    operationId: "hh_delete_v1_tool_packs_id_version_bindings",
  },
  {
    method: "GET",
    path: "/v1/runtime/info",
    title: "运行模式信息",
    group: "health",
    request: "无参数。",
    response: "200：build（构建身份）与 fullAccess。",
    implementation: "返回 Gateway 启动时确定的运行模式，供控制台显示。",
    effects: "只读。",
    errors: "无业务错误。",
    source: "packages/daemon/src/http/harness-model-routes.ts",
    tests: ["tests/integration/harness-model.test.ts"],
    operationId: "hh_get_v1_runtime_info",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
    tests: ["tests/integration/gateway.test.ts"],
    operationId: "hh_get_v1_sessions_id_runs",
  },
  {
    method: "GET",
    path: "/v1/sessions/{id}/logs",
    title: "会话诊断日志",
    group: "sessions",
    request:
      "路径Session id；source=engine（默认，引擎日志）或gateway（Gateway日志中属于该Session及其Run的行）；limit默认200，范围1～2000；after为上一页返回的cursor。",
    response:
      "200：source、file、exists、records（JSON Lines记录，旧到新）、cursor、truncated、skipped。",
    implementation:
      "先确认Session存在；SessionLogReader只读当前文件及.1～.3轮转文件：无after时倒序读取最新limit条，有after时按文件身份与字节偏移顺序读取新行；每行再次脱敏后解析。",
    effects:
      "只读文件，不启动或联系Worker；单次最多扫描32 MiB、返回2 MiB；本接口自身的访问行不出现在gateway页中。",
    errors:
      "Session不存在404；非法source/limit/after为400 INVALID_REQUEST；未配置日志503 LOGS_UNAVAILABLE；读文件失败500 LOG_READ_FAILED。文件尚不存在时exists=false、records为空。truncated表示有记录因数量、大小、扫描预算或轮转被跳过。",
    source: "packages/daemon/src/http/server.ts",
    tests: [
      "tests/integration/session-logs.test.ts",
      "packages/daemon/test/session-log-reader.test.ts",
    ],
    operationId: "hh_get_v1_sessions_id_logs",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/server.ts",
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
    source: "packages/daemon/src/http/workflow-routes.ts",
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
    source: "packages/daemon/src/http/workflow-routes.ts",
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
    source: "packages/daemon/src/http/workflow-routes.ts",
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
    source: "packages/daemon/src/http/workflow-routes.ts",
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
    source: "packages/daemon/src/http/workflow-routes.ts",
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
    source: "packages/daemon/src/http/observation-routes.ts",
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
    source: "packages/daemon/src/http/observation-routes.ts",
    tests: ["tests/integration/observability.test.ts"],
    operationId: "hh_get_v1_observability",
  },
  {
    method: "GET",
    path: "/api/v1/system/info",
    title: "守护进程信息",
    group: "system",
    request: "无参数。",
    response:
      "200：apiVersion=v1、version、commit、pid、startedAt、dataDir、secretBackend，以及 gateway：本机客户端使用的模型网关基址 openaiBaseUrl（含 /v1）、anthropicBaseUrl 与 geminiBaseUrl（不含版本段），监听器绑定之前为 null。",
    implementation:
      "组合根在启动时固定的构建身份与秘密后端，加上监听器绑定后的回环地址；`hh status` 读取它并提示客户端的配置方式。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/api-v1.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_get_system_info",
  },
  {
    method: "POST",
    path: "/api/v1/auth/console-links",
    title: "控制台一次性登录码",
    group: "auth",
    request: "空对象 {}。",
    response:
      "201：code（128 位随机值，base64url）与 expiresAt（60 秒后）。`hh console` 把它放进 `http://127.0.0.1:3180/#login=<code>`。",
    implementation:
      "ConsoleSessions 在内存中只保存登录码的 SHA-256 与期限，最多保留 32 个未用登录码，超出时丢弃最早的。",
    effects: "只在内存中；守护进程重启后全部失效。",
    errors:
      "只接受本机管理令牌：无凭据 401 ADMIN_TOKEN_REQUIRED，令牌错误 401 ADMIN_TOKEN_INVALID，用控制台会话调用 403 ADMIN_TOKEN_REQUIRED；Sec-Fetch-Site 不是 same-origin 时 403 LOCAL_ACCESS_REQUIRED。",
    source: "packages/daemon/src/http/console-session.ts",
    tests: [
      "tests/integration/console.test.ts",
      "packages/daemon/test/console-session.test.ts",
    ],
    operationId: "hh_api_v1_create_console_link",
  },
  {
    method: "POST",
    path: "/api/v1/auth/console-sessions",
    title: "以登录码换取控制台会话",
    group: "auth",
    request:
      "code：console-links 返回的 22 字符登录码。不需要凭据；必须是 application/json。",
    response:
      "201：csrfToken、expiresAt（创建后 7 天）与 idleExpiresAt（空闲 12 小时）；Set-Cookie `hh_console=<256 位随机值>; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`（经 TLS 时另加 Secure）；Cache-Control: no-store。",
    implementation:
      "登录码无论是否有效都在这次尝试中作废；请求自带的旧会话 Cookie 在换取成功后被吊销。会话值与 CSRF 值各 256 位随机数，会话只保存 SHA-256。",
    effects:
      "只在内存中，最多 64 个会话，超出时丢弃最早的；守护进程重启后全部失效。",
    errors:
      "登录码未知、已用或过期 401 CONSOLE_LINK_INVALID；格式不符 400 INVALID_REQUEST；非 JSON 415；跨源或 Sec-Fetch-Site 不是 same-origin 时 403 LOCAL_ACCESS_REQUIRED。",
    source: "packages/daemon/src/http/console-session.ts",
    tests: ["tests/integration/console.test.ts"],
    operationId: "hh_api_v1_create_console_session",
  },
  {
    method: "GET",
    path: "/api/v1/auth/console-sessions/current",
    title: "当前控制台会话",
    group: "auth",
    request: "hh_console Cookie。",
    response:
      "200：csrfToken、expiresAt、idleExpiresAt；Cache-Control: no-store。重新加载的页面用它取回 CSRF 值。",
    implementation: "按 Cookie 查找会话并重新开始空闲计时。",
    effects: "更新会话的最近使用时间（内存）。",
    errors:
      "会话已结束 401 CONSOLE_SESSION_INVALID 并清除 Cookie；以管理令牌调用 404 CONSOLE_SESSION_NOT_FOUND。",
    source: "packages/daemon/src/http/console-session.ts",
    tests: ["tests/integration/console.test.ts"],
    operationId: "hh_api_v1_get_console_session",
  },
  {
    method: "DELETE",
    path: "/api/v1/auth/console-sessions/current",
    title: "退出控制台",
    group: "auth",
    request: "hh_console Cookie 与 X-HH-CSRF 头。",
    response: "204；Set-Cookie 以 Max-Age=0 清除 hh_console。",
    implementation: "立即吊销会话，之后同一 Cookie 的请求得到 401。",
    effects: "从内存中删除会话。",
    errors:
      "缺少或不符的 X-HH-CSRF 403 CSRF_TOKEN_INVALID；会话已结束 401 CONSOLE_SESSION_INVALID；以管理令牌调用 404 CONSOLE_SESSION_NOT_FOUND。",
    source: "packages/daemon/src/http/console-session.ts",
    tests: ["tests/integration/console.test.ts"],
    operationId: "hh_api_v1_delete_console_session",
  },
  {
    method: "GET",
    path: "/api/v1/providers",
    title: "provider 列表",
    group: "providers",
    request: "无参数。",
    response:
      "200：items（ProviderConfig，凭据只含引用）、nextCursor=null；配置列表不分页。",
    implementation: "ModelPlaneStore.listProviders，按 id 排序。",
    effects: "只读；从不返回秘密值。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_list_providers",
  },
  {
    method: "POST",
    path: "/api/v1/providers",
    title: "添加 provider",
    group: "providers",
    request:
      "preset（内置预设 ID，可加 region 与 plan，缺省为预设列出的第一个）或 id（slug）与 endpoints（至少一个）；与 preset 同给的字段覆盖预设（endpoints 按协议覆盖，id 默认为预设 ID）；name、kind、auth、headers、models、wire、patches、capabilities、translateOnly、catalog（models.dev provider id）可选；credential（value 或 env/file ref，name 默认 default）添加第一个凭据；未知字段 400。",
    response:
      "201：ProviderConfig（来自预设时含 preset、region、plan）；带 credential 时含该凭据的引用。",
    implementation:
      "预设由 @harnesshub/gateway 的 presets 加载并经 providerFromPreset 展开：端点依次取 plan、region、预设自己的，初始模型依次取 plan 的 models、预设的 models.list 与 fallbackModels，userEndpoint 预设必须给出 endpoints，required 的 headerHints 必须在 headers 中；手动时默认 name=id、kind=custom、auth=authorization-bearer、models={manual,[],all}；端点按官方 SDK 基址约定校验（chat/responses 含 /v1，anthropic、gemini 不含版本段）。每个模型缺的窗口、输出上限、推理、输入模态与价格按 03 第 7 节的优先级（覆盖、预设、models.dev 快照）补齐；请求里给出的值保留。credential 的值先写入秘密存储，provider 写入失败时删除。",
    effects:
      "在一个事务内写入 providers 记录与各模型元数据的来源（model_provenance）；有 credential.value 时写一个托管秘密。",
    errors:
      "400 PRESET_NOT_FOUND（/preset）、PRESET_REGION_NOT_FOUND（/region）、PRESET_PLAN_NOT_FOUND（/plan）、PROVIDER_INVALID（errors[] 指向 /id、/endpoints、/endpoints/<协议>、/headers/<名称> 或没有 preset 时的 /region、/plan：操作路径、版本段、内嵌凭据、查询串、片段、非 HTTPS 的公网地址、userEndpoint 预设缺少端点、缺少必需的 header）、CREDENTIAL_INVALID、INVALID_SECRET；409 PROVIDER_EXISTS；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_create_provider",
  },
  {
    method: "GET",
    path: "/api/v1/providers/{id}",
    title: "provider 详情",
    group: "providers",
    request: "路径参数 id。",
    response: "200：ProviderConfig。",
    implementation: "ModelPlaneStore.getProvider。",
    effects: "只读。",
    errors:
      "404 PROVIDER_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_get_provider",
  },
  {
    method: "PATCH",
    path: "/api/v1/providers/{id}",
    title: "修改 provider",
    group: "providers",
    request:
      "JSON Merge Patch（application/merge-patch+json 或 application/json）：null 删除可选成员；id、credentials、时间戳不可改。",
    response: "200：更新后的 ProviderConfig。",
    implementation:
      "合并后按创建时的规则整体校验，重新解析各模型的元数据（手工设置的值保留，与记录的推导值不同即视为手工设置），再整体替换；同一守护进程内的写入串行执行。",
    effects:
      "在一个事务内更新 providers 记录、updatedAt 与元数据来源。尚无 ETag/If-Match。",
    errors:
      "400 PROVIDER_INVALID 或 INVALID_REQUEST；404 PROVIDER_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/api-v1.test.ts"],
    operationId: "hh_api_v1_update_provider",
  },
  {
    method: "DELETE",
    path: "/api/v1/providers/{id}",
    title: "删除 provider",
    group: "providers",
    request: "路径参数 id。",
    response: "204。",
    implementation:
      "先检查引用；再删除其托管秘密（store 引用），最后删除记录，失败后重试同一请求即可完成。",
    effects: "删除记录、托管秘密，以及该 provider 的模型覆盖与元数据来源。",
    errors:
      "409 PROVIDER_IN_USE（references 列出路由组与未吊销的 Gateway Key）；404；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_delete_provider",
  },
  {
    method: "GET",
    path: "/api/v1/providers/{id}/credentials",
    title: "凭据列表",
    group: "credentials",
    request: "路径参数 id。",
    response:
      "200：items（id、name、ref、protocols、enabled）、nextCursor=null。",
    implementation: "读取 provider 的 credentials。",
    effects:
      "只读；ref 是引用（store 的 UUID、环境变量名或文件路径），从不含值。",
    errors:
      "404 PROVIDER_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/api-v1.test.ts"],
    operationId: "hh_api_v1_list_credentials",
  },
  {
    method: "POST",
    path: "/api/v1/providers/{id}/credentials",
    title: "添加凭据",
    group: "credentials",
    request:
      "name 必填；value（存入秘密后端）与 ref（env 或 file 引用）二选一；id（slug，默认 key-N）、protocols、enabled 可选。",
    response:
      "201：凭据，ref 为 {kind:store,value:UUID} 或给定引用；不回显值。",
    implementation:
      "value 经 SecretStore.create 写入托管秘密，再把引用写进 provider；provider 写入失败时删除刚写入的秘密。",
    effects: "写秘密条目与 providers 记录；值不进入日志与响应。",
    errors:
      "400 CREDENTIAL_INVALID、INVALID_SECRET；409 CREDENTIAL_EXISTS；404；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_add_credential",
  },
  {
    method: "PUT",
    path: "/api/v1/providers/{id}/credentials/{credentialId}/secret",
    title: "轮换凭据",
    group: "credentials",
    request: "value 必填。",
    response: "200：凭据（引用不变）。",
    implementation: "SecretStore.rotate 在同一引用下替换值。",
    effects: "替换托管秘密的值。",
    errors:
      "409 CREDENTIAL_NOT_MANAGED（env/file 引用不能在此轮换）；404 CREDENTIAL_NOT_FOUND；400 INVALID_SECRET；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_rotate_credential",
  },
  {
    method: "DELETE",
    path: "/api/v1/providers/{id}/credentials/{credentialId}",
    title: "删除凭据",
    group: "credentials",
    request: "路径参数 id、credentialId。",
    response: "204。",
    implementation:
      "先删除托管秘密，再从 provider 移除凭据；失败后重试同一请求即可完成。",
    effects: "删除秘密条目，更新 providers 记录。",
    errors:
      "404；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_delete_credential",
  },
  {
    method: "GET",
    path: "/api/v1/route-groups",
    title: "路由组列表",
    group: "route-groups",
    request: "无参数。",
    response: "200：items（RouteGroup）、nextCursor=null。",
    implementation: "ModelPlaneStore.listRouteGroups。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_list_route_groups",
  },
  {
    method: "POST",
    path: "/api/v1/route-groups",
    title: "添加路由组",
    group: "route-groups",
    request:
      "id、members（Model Ref，至少一个，不重复）必填；strategy（默认 order）、stickiness（默认 auto）、retry 可选。",
    response: "201：RouteGroup。",
    implementation: "成员必须是已存在 provider 的模型。",
    effects: "写入 route_groups 表。",
    errors:
      "400 ROUTE_GROUP_INVALID（errors[] 指向 /members/<i>）；409 ROUTE_GROUP_EXISTS；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_create_route_group",
  },
  {
    method: "GET",
    path: "/api/v1/route-groups/{id}",
    title: "路由组详情",
    group: "route-groups",
    request: "路径参数 id。",
    response: "200：RouteGroup。",
    implementation: "ModelPlaneStore.getRouteGroup。",
    effects: "只读。",
    errors:
      "404 ROUTE_GROUP_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/api-v1.test.ts"],
    operationId: "hh_api_v1_get_route_group",
  },
  {
    method: "PATCH",
    path: "/api/v1/route-groups/{id}",
    title: "修改路由组",
    group: "route-groups",
    request:
      "JSON Merge Patch：strategy、stickiness、members、retry（null 删除）。",
    response: "200：RouteGroup。",
    implementation: "合并后整体校验并替换。",
    effects: "更新 route_groups 记录。尚无 ETag/If-Match。",
    errors:
      "400 ROUTE_GROUP_INVALID；404；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/api-v1.test.ts"],
    operationId: "hh_api_v1_update_route_group",
  },
  {
    method: "DELETE",
    path: "/api/v1/route-groups/{id}",
    title: "删除路由组",
    group: "route-groups",
    request: "路径参数 id。",
    response: "204。",
    implementation: "未吊销的 Gateway Key 允许 group/<id> 时拒绝。",
    effects: "删除记录。",
    errors:
      "409 ROUTE_GROUP_IN_USE（references）；404；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_delete_route_group",
  },
  {
    method: "GET",
    path: "/api/v1/auto-groups",
    title: "自动路由组",
    group: "route-groups",
    request: "无参数。",
    response:
      "200：items（id=auto-<slug>、model、members、hidden、createdAt）、nextCursor=null。",
    implementation:
      "core autoGroups：两个及以上就绪 provider 以同一规范化名称（Magpie sameModel）提供的模型；同 ID 的用户路由组优先，不列出；隐藏的照常列出，hidden=true。",
    effects: "只读；自动组每次派生，不存储。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_list_auto_groups",
  },
  {
    method: "POST",
    path: "/api/v1/auto-groups/{id}/hide",
    title: "隐藏自动路由组",
    group: "route-groups",
    request: "路径参数 id；空 JSON 对象。",
    response: "204。",
    implementation:
      "ModelPlaneStore.setAutoGroupHidden(id, true)；已隐藏时幂等。",
    effects:
      "写入 hidden_auto_groups 表；网关不再列出、也不再路由 group/<id>（请求 404），直到恢复。",
    errors:
      "404 AUTO_GROUP_NOT_FOUND（当前没有该自动组）；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_hide_auto_group",
  },
  {
    method: "POST",
    path: "/api/v1/auto-groups/{id}/restore",
    title: "恢复自动路由组",
    group: "route-groups",
    request: "路径参数 id；空 JSON 对象。",
    response: "204。",
    implementation: "ModelPlaneStore.setAutoGroupHidden(id, false)。",
    effects: "删除 hidden_auto_groups 中的记录；组仍可派生时重新出现。",
    errors:
      "404 AUTO_GROUP_NOT_FOUND（该 ID 没有被隐藏）；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_restore_auto_group",
  },
  {
    method: "GET",
    path: "/api/v1/gateway/share",
    title: "局域网共享状态",
    group: "gateway-share",
    request: "无参数。",
    response:
      "200：lan（enabled、host、port、names）、publicBaseUrl、listening（局域网监听器是否在服务）、boundPort、urls（对端使用的基址：每个声明的局域网地址或名称一个，再加 publicBaseUrl）、error（已开启但未能监听的原因）。",
    implementation:
      "GatewayShare.status 读取 <dataDir>/gateway-sharing.json 中的设置与局域网监听器的状态。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；局域网监听器上不存在此路由（404）；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/gateway-share-routes.ts",
    tests: [
      "tests/integration/gateway-lan-share.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_get_gateway_share",
  },
  {
    method: "PUT",
    path: "/api/v1/gateway/share",
    title: "设置局域网共享",
    group: "gateway-share",
    request:
      "完整的设置：lan.enabled 必填；开启时 lan.host 必填（本机 IP，0.0.0.0 或 :: 表示全部地址，此时需 lan.names 或 publicBaseUrl）；lan.port 缺省为守护进程端口；lan.names 为对端使用的其他主机名（最多 20 个）；publicBaseUrl 为反向代理后的对外地址。",
    response: "200：与 GET 相同的状态。",
    implementation:
      "resolveGatewaySharing 校验；新地址先绑定，再原子写入 gateway-sharing.json，最后关闭旧监听器；局域网监听器只把模型协议路径交给网关的 lan 入口。",
    effects:
      "写入 <dataDir>/gateway-sharing.json；开启、移动或关闭局域网监听器；关闭时在途请求继续到结束。",
    errors:
      "400 GATEWAY_SHARE_INVALID（errors[] 指向字段）；409 GATEWAY_SHARE_LISTEN_FAILED（端口被占用、地址不属于本机等，设置不变）；需本机管理令牌与回环连接，否则 401 或 403；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/gateway-share-routes.ts",
    tests: [
      "tests/integration/gateway-lan-share.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_put_gateway_share",
  },
  {
    method: "GET",
    path: "/api/v1/gateway-keys",
    title: "Gateway Key 列表",
    group: "gateway-keys",
    request: "无参数。",
    response:
      "200：items（GatewayKeyView，不含 secretHash）、nextCursor=null，按创建顺序。",
    implementation: "ModelPlaneStore.listGatewayKeys 后去掉哈希。",
    effects: "只读；从不返回 Key 文本或哈希。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_list_gateway_keys",
  },
  {
    method: "POST",
    path: "/api/v1/gateway-keys",
    title: "签发 client Key",
    group: "gateway-keys",
    request:
      "name、modelAllow（provider/model、provider/*、group/<id>，至少一个）必填；quota 可选；allowLan=true 允许在局域网共享监听器上使用；expiresAt 缺省为 90 天后，null 为不过期（allowLan 的 Key 不允许）。",
    response:
      "201：key（hhk_c_… 文本，只在此响应中出现）与 gatewayKey 视图；Cache-Control: no-store。",
    implementation:
      "issueGatewayKey 生成 client 作用域 Key，只保存秘密部分的 SHA-256。",
    effects: "写入 gateway_keys 表。",
    errors:
      "400 GATEWAY_KEY_INVALID（errors[]：/modelAllow/<i>、/expiresAt 必须在未来，allowLan 时必须设置）；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_create_gateway_key",
  },
  {
    method: "GET",
    path: "/api/v1/gateway-keys/{id}",
    title: "Gateway Key 详情",
    group: "gateway-keys",
    request: "路径参数 id（keyId）。",
    response: "200：GatewayKeyView。",
    implementation: "ModelPlaneStore.getGatewayKey 后去掉哈希。",
    effects: "只读。",
    errors:
      "404 GATEWAY_KEY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/api-v1.test.ts"],
    operationId: "hh_api_v1_get_gateway_key",
  },
  {
    method: "POST",
    path: "/api/v1/gateway-keys/{id}/revoke",
    title: "吊销 Gateway Key",
    group: "gateway-keys",
    request: "路径参数 id；请求体为空对象。",
    response: "200：带 revokedAt 的 GatewayKeyView。",
    implementation:
      "ModelPlaneStore.revokeGatewayKey；已吊销的 Key 保留第一次的时间。",
    effects: "更新 gateway_keys 记录；在途调用的终止尚未实现。",
    errors:
      "404 GATEWAY_KEY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_revoke_gateway_key",
  },
  {
    method: "GET",
    path: "/api/v1/model-calls",
    title: "model.call 账本",
    group: "usage",
    request:
      "limit（1–200，默认 50）、cursor；过滤 from（含）、to（不含）、keyId、provider、model、sessionId、agent（agent.id，确定或推断的）。",
    response:
      "200：items（ModelCallEntry，含 conversationKey 与 agent；cost 为 {amount 十进制字符串, currency, priceSource} 或 null）、nextCursor。",
    implementation:
      "ModelPlaneStore.listModelCalls，按 occurredAt 新到旧，游标为不透明字符串。",
    effects: "只读。",
    errors:
      "400 INVALID_REQUEST、INVALID_CURSOR、INVALID_USAGE_FILTER；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/api-v1.test.ts"],
    operationId: "hh_api_v1_list_model_calls",
  },
  {
    method: "GET",
    path: "/api/v1/usage",
    title: "用量聚合",
    group: "usage",
    request:
      "groupBy（day、provider、model、key、adapter、credential，默认 model；credential 的 key 为 <provider>/<credentialId>）与 /model-calls 相同的过滤。",
    response:
      "200：groupBy、items（key、calls、failedCalls、usage、cost 十进制字符串、unpricedCalls）。",
    implementation:
      "ModelPlaneStore.aggregateUsage：状态码不低于 400 记为失败，cost 只累加已知成本，null 成本计入 unpricedCalls，missing 用量按 0 计，日期为 UTC。",
    effects: "只读。",
    errors:
      "400 INVALID_REQUEST、INVALID_USAGE_FILTER；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_get_usage",
  },
  {
    method: "GET",
    path: "/api/v1/conversations",
    title: "会话视图",
    group: "usage",
    request:
      "limit（1–200，默认 50）、cursor；与 /model-calls 相同的过滤（from、to、agent 等），过滤先作用于调用再按会话汇总。",
    response:
      "200：items（key、calls、failedCalls、usage、cost 十进制字符串、unpricedCalls、firstAt、lastAt、models、credentials（<provider>/<credentialId>）、agents）、nextCursor。",
    implementation:
      "ModelPlaneStore.listConversations：按 model_calls.conversation_key 分组，规则同 /usage；最后活动时间新到旧，游标为不透明字符串。",
    effects:
      "只读。没有 conversationKey 的调用（如被拒绝的鉴权失败）不属于任何会话。",
    errors:
      "400 INVALID_REQUEST、INVALID_CURSOR、INVALID_USAGE_FILTER；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/api-v1.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_list_conversations",
  },
  {
    method: "GET",
    path: "/api/v1/conversations/{key}",
    title: "单个会话的调用",
    group: "usage",
    request:
      "路径参数 key（64 位小写十六进制）；limit（1–200，默认 50）、cursor。",
    response:
      "200：items（ModelCallEntry，与 /model-calls 相同）、nextCursor。",
    implementation:
      "ModelPlaneStore.listModelCalls（filter.conversationKey），新到旧。",
    effects: "只读。",
    errors:
      "404 CONVERSATION_NOT_FOUND（首页没有调用）；400 INVALID_REQUEST、INVALID_CURSOR；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/api-v1.test.ts"],
    operationId: "hh_api_v1_get_conversation",
  },
  {
    method: "GET",
    path: "/api/v1/presets",
    title: "provider 预设",
    group: "providers",
    request: "无参数。",
    response:
      "200：items（ProviderPreset：id、name、kind、icon、website、keysUrl、catalog、verified、source、auth.methods 与 apiKeyHeader、endpoints、userEndpoint、regions、plans、headerHints、models、fallbackModels、magpie、capabilities、patches、notes），按 id 排序；nextCursor=null。",
    implementation:
      "组合根注入 @harnesshub/gateway 的 listPresets：读取并校验包内 presets/*.json（JSON Schema、文件名、基址约定、region/plan/Magpie ID 唯一且存在、顶层端点等于默认选择的端点、每个 region 与 plan 都能展开为有效 provider）。",
    effects:
      "只读。verified 为对照厂商文档核对端点与 Key 发送方式的日期或 unverified；source 记录取自 Magpie 的数据（magpie@2e340f7）。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/provider-presets.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_list_presets",
  },
  {
    method: "POST",
    path: "/api/v1/import/preview",
    title: "预览导入",
    group: "providers",
    request:
      "link（harnesshub://import?…、https://harnesshub.dev/import#…、magpie://import?…、https://usemagpie.ai/import#…，最长 8 KiB）或 app（claude-code、codex），二者只给一个。",
    response:
      "200：previewId（10 分钟内用于一次 apply）、expiresAt、source、file（读取的配置文件）、items（ref、status=new/exists/skipped、reason、provider{id、name、kind、preset、region、plan、catalog、endpoints、apiKeyHeader、models、headers 只含名称}、hosts、key{kind=none/value/env，长度不少于 16 的 Key 只给后四位}、website、keysUrl）、warnings。",
    implementation:
      "链接由 @harnesshub/core/import-links 的 parseImportLink 解析：参数只能出现一次，未知参数拒绝，端点按 provider 基址约定校验（HTTPS，回环与私网地址可用 HTTP 并给出警告），icon 只校验不下载；Magpie 链接的预设 ID 与 region 经 resolveMagpiePreset 映射。app 只在组合根给出的接线 home 下按全局接线的位置读取 Claude Code 的 settings.json（env.ANTHROPIC_BASE_URL 与令牌）或 Codex 的 config.toml（每个 [model_providers.*]）；指向本机网关或带 hhk_ Key 的条目跳过；端点与某个预设一致时按该预设导入。每一项按 POST /providers 的规则构造并检查。",
    effects:
      "不写入任何记录或文件；解析结果（含 Key）只保存在守护进程内存中，至多 32 份，过期或 apply 后删除。",
    errors:
      "400 IMPORT_LINK_INVALID（errors[].detail 指出参数名，消息不含参数值）、PRESET_NOT_FOUND、PRESET_REGION_NOT_FOUND、PRESET_PLAN_NOT_FOUND、PROVIDER_INVALID、INVALID_REQUEST；409 IMPORT_SOURCE_UNAVAILABLE（守护进程没有接线 home）、WIRING_CONFIG_UNPARSEABLE、WIRING_SYMLINK_ESCAPE、WIRING_NOT_REGULAR_FILE、WIRING_UNSUPPORTED_STRUCTURE（文件超过 1 MiB）；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/import-routes.ts",
    tests: [
      "tests/integration/provider-import.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_preview_import",
  },
  {
    method: "POST",
    path: "/api/v1/import/apply",
    title: "确认导入",
    group: "providers",
    request: "previewId；refs 可选，只导入这些项（必须是预览中的 ref）。",
    response:
      "200：items（ref、status=created/skipped/failed、reason、失败时的 code、创建的 ProviderConfig）。",
    implementation:
      "取出并删除预览（无论结果如何只能使用一次），对 status=new 的项依次按 POST /providers 的路径创建：Key 先写入秘密存储，provider 写入失败时删除。",
    effects:
      "每个创建的 provider 与 POST /providers 相同：写入 providers 记录、模型元数据来源与托管秘密；不签发 Gateway Key，不改接线。",
    errors:
      "404 IMPORT_PREVIEW_NOT_FOUND（已使用、超过 10 分钟或守护进程重启）；400 INVALID_REQUEST（refs 不在预览中）；单项的 4xx（如 409 PROVIDER_EXISTS）记为该项 failed；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/import-routes.ts",
    tests: [
      "tests/integration/provider-import.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_apply_import",
  },
  {
    method: "POST",
    path: "/api/v1/providers/{id}/models/refresh",
    title: "刷新模型列表",
    group: "providers",
    request: "路径参数 id；请求体为空对象。",
    response:
      "200：更新后的 ProviderConfig，models.source=live、refreshedAt；各模型元数据按覆盖、手工设置、实时列表、预设、models.dev 快照的顺序解析，手工设置的值保留。",
    implementation:
      "用第一个可用于所选端点的启用凭据（经 SecretStore 解析；没有凭据时不带 Key）请求上游：chat/responses 基址 + listPath（默认 /models）、anthropic 基址 + /v1/models（anthropic-version 头，按 after_id 翻页）或 gemini 基址 + /v1beta/models（只取支持 generateContent 的模型，按 pageToken 翻页）；15 秒超时，至多 20 页。上游请求在写入队列之外执行。",
    effects:
      "成功时在一个事务内替换模型列表与元数据来源；失败时保留原列表并标记 models.stale=true。",
    errors:
      "502 MODELS_REFRESH_FAILED（detail 只含主机与 HTTP 状态，不含 Key、查询串或响应体）；409 CREDENTIAL_UNAVAILABLE（凭据无法读取）；404 PROVIDER_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/provider-presets.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_refresh_provider_models",
  },
  {
    method: "GET",
    path: "/api/v1/providers/{id}/models",
    title: "provider 模型元数据",
    group: "models",
    request: "路径参数 id。",
    response:
      "200：items（每个已列出模型的 ModelMetadata：ref、listed、fields 中每个已知字段的 value、source、at，unknown 列出未知字段，overrides 为适用的覆盖）、nextCursor=null。",
    implementation:
      "resolveModelMetadata 逐字段按优先级解析：精确覆盖、provider/* 覆盖、provider 模型上手工设置的值、实时列表、预设（at 为核对日期）、models.dev 快照（先按预设 catalog id，再按 author/model 的作者），都没有则为未知，不回落默认窗口。",
    effects: "只读；首次调用时读取并校验内置快照。",
    errors:
      "404 PROVIDER_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/model-metadata.test.ts"],
    operationId: "hh_api_v1_list_provider_model_metadata",
  },
  {
    method: "GET",
    path: "/api/v1/models/{ref}",
    title: "模型元数据",
    group: "models",
    request: "路径参数 ref：provider/model，斜杠编码为 %2F（模型名可含斜杠）。",
    response:
      "200：ModelMetadata（同 provider 模型元数据的单项；模型不在列表中时 listed=false，仍按覆盖与目录解析）。",
    implementation: "同 GET /api/v1/providers/{id}/models，只解析一个模型。",
    effects: "只读。",
    errors:
      "400 MODEL_REF_INVALID（provider/* 或 group/ 不是单个模型）；404 PROVIDER_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/model-metadata.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_get_model_metadata",
  },
  {
    method: "GET",
    path: "/api/v1/models/{ref}/overrides",
    title: "读取模型覆盖",
    group: "models",
    request: "路径参数 ref：provider/model 或 provider/*（%2F 编码）。",
    response: "200：保存的覆盖（ref、values、updatedAt）。",
    implementation: "ModelMetadataStore.getModelOverride。",
    effects: "只读。",
    errors:
      "400 MODEL_REF_INVALID；404 PROVIDER_NOT_FOUND 或 MODEL_OVERRIDE_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/model-metadata.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_get_model_override",
  },
  {
    method: "PUT",
    path: "/api/v1/models/{ref}/overrides",
    title: "设置模型覆盖",
    group: "models",
    request:
      "路径参数 ref：provider/model 或 provider/*（%2F 编码）；请求体为覆盖值，至少一项：contextWindow、maxOutputTokens（正整数）、reasoning、toolCall（布尔）、inputModalities（text、image、pdf、audio、video，不重复）、price.input/output/cacheRead/cacheWrite（每百万 token 美元，非负）。整体替换该 ref 原有的覆盖。",
    response: "200：保存的覆盖（ref、values、updatedAt）。",
    implementation:
      "按新覆盖重新解析该 provider 全部模型的元数据，与覆盖、provider 记录和元数据来源在同一事务内写入；网关按写入后的价格计算成本。",
    effects:
      "写入 model_overrides 记录，更新 provider 的模型元数据、updatedAt 与 model_provenance。",
    errors:
      "400 MODEL_REF_INVALID、INVALID_REQUEST（值越界、未知字段、空对象）；404 PROVIDER_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/model-metadata.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_put_model_override",
  },
  {
    method: "DELETE",
    path: "/api/v1/models/{ref}/overrides",
    title: "删除模型覆盖",
    group: "models",
    request: "路径参数 ref：provider/model 或 provider/*（%2F 编码）。",
    response: "204。",
    implementation:
      "去掉该覆盖后重新解析 provider 全部模型的元数据，覆盖删除与 provider 写入在同一事务内完成；覆盖带来的值回落到下一个来源。",
    effects: "删除 model_overrides 记录，更新 provider 与 model_provenance。",
    errors:
      "400 MODEL_REF_INVALID；404 PROVIDER_NOT_FOUND 或 MODEL_OVERRIDE_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: ["tests/integration/model-metadata.test.ts"],
    operationId: "hh_api_v1_delete_model_override",
  },
  {
    method: "GET",
    path: "/api/v1/catalog",
    title: "模型目录状态",
    group: "models",
    request: "无参数。",
    response:
      "200：source（bundled 内置快照或 refreshed 刷新副本）、snapshot（使用中目录的 source、repository、license、retrievedAt、etag、commit、上游 api.json 的 sha256 与 bytes、providers、models 数）、url、autoRefresh（enabled，关闭时 disabledBy 为 setting 或 offline）、lastRefresh（at、outcome：updated、unchanged 或 failed，失败时 error）、nextRefreshAt。",
    implementation:
      "组合根注入 @harnesshub/gateway 的 CatalogRefresher：使用内置 catalog/models-dev.json，或 <dataDir>/catalog/models-dev.json 中较新的刷新副本。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/model-metadata.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_get_catalog_status",
  },
  {
    method: "POST",
    path: "/api/v1/catalog/refresh",
    title: "刷新模型目录",
    group: "models",
    request: "请求体为空对象。",
    response: "200：刷新后的目录状态（同 GET /api/v1/catalog）。",
    implementation:
      "立即请求 catalog.url（默认 https://models.dev/api.json，带 If-None-Match，超时 10 秒），后台刷新关闭时也执行；已有刷新在进行时等待同一次。内容有变化时原子写入 <dataDir>/catalog/models-dev.json，再在写入队列中重新解析全部 provider 的模型元数据。",
    effects:
      "可能替换 <dataDir>/catalog 下的刷新副本与 refresh.json，并更新各 provider 的模型元数据；内置快照不变。",
    errors:
      "502 CATALOG_REFRESH_FAILED（detail 只含主机、HTTP 状态或超时，不含响应体；原目录继续使用）；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/model-plane-routes.ts",
    tests: [
      "tests/integration/model-metadata.test.ts",
      "tests/integration/hh-cli.test.ts",
    ],
    operationId: "hh_api_v1_refresh_catalog",
  },
  {
    method: "GET",
    path: "/api/v1/agents",
    title: "本机 Agent 列表",
    group: "agents",
    request: "无参数。",
    response:
      "200：items（Agent：id、name、protocol、keyDelivery、capabilities{tiers、efforts、options（各选项可取值，默认值在前）}、installation{status=installed|configured-only|not-found、executable、configDirectories}、wiring{model?、tiers?、effort?、options?、models（Agent 列出且 Key 可用的模型）、hidden（隐藏的模型）、keyId?、keyState=active|revoked|expired|missing|none、wiredAt、files、drift、driftError、attention?{code、message、at}（上次目录同步没有改写它的文件的原因）}|null）、nextCursor=null。自己登录的 Agent（Codex 的 codexAuth=chatgpt）没有 model 与 keyId，keyState 为 none。",
    implementation:
      "AgentWiringService.list：对每个支持的 Adapter 调用 detectAgent（只查 PATH 与配置目录，不执行 Agent）、读取 WiringRecord 与其 Key，并以当前网关地址调用 detectDrift。",
    effects: "只读；不读取 Agent 的认证文件，不返回 Key 文本。",
    errors:
      "守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_list_agents",
  },
  {
    method: "GET",
    path: "/api/v1/agents/{id}",
    title: "单个 Agent",
    group: "agents",
    request: "路径参数 id（Adapter id）。",
    response: "200：Agent，字段同列表项。",
    implementation: "AgentWiringService.get，与列表的单项相同。",
    effects: "只读。",
    errors:
      "404 WIRING_ADAPTER_UNKNOWN；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_get_agent",
  },
  {
    method: "POST",
    path: "/api/v1/agents/{id}/wiring/plan",
    title: "预览接线",
    group: "agents",
    request:
      "路径参数 id；model（provider/model 或 group/<id>，缺省沿用当前模型）；models 为 Agent 可列出的模型（provider/model、provider/*、group/<id> 或 *，缺省沿用当前列表，首次为 *，即网关的全部模型、包括之后新增的）；tiers（capabilities.tiers 中各档的模型，缺省沿用当前，{} 清除）；effort（capabilities.efforts 之一，缺省沿用当前，null 清除）；options（capabilities.options，如 codexAuth=gateway-key|chatgpt，缺省沿用当前）。codexAuth=chatgpt 时不接受 model、models、tiers、effort。",
    response:
      "200：AgentWiringPlan：adapterId、protocol、keyDelivery、model?、keyId?、changed、files[]（id、path、format、exists、hash、changes[]、diff）；diff 中 Gateway Key 显示为 hhk_a_xxxx…，被替换的旧 Key 值为 <redacted>；HarnessHub 生成的整个文件（Codex 的模型目录）只显示大小，changes 中超过 2000 字符的值被截断。",
    implementation:
      "AgentWiringService.plan：按网关的 provider 与路由组核对模型与各档模型（须由网关提供且未被隐藏），取窗口、输出上限、推理档位（reasoning 模型为 low/medium/high）、图像输入与原生协议，用一把不保存的临时 Key 调用 planWiring；自己登录的 Agent 不用 Key。",
    effects: "只读；不写文件，不签发 Key。",
    errors:
      "404 WIRING_ADAPTER_UNKNOWN；400 AGENT_MODEL_UNAVAILABLE（网关不提供的模型）、AGENT_WIRING_INVALID（缺模型，或自己登录的 Agent 收到模型等）、WIRING_TARGET_INVALID（Agent 没有的档位、effort 或选项）；409 AGENT_MODEL_IN_USE（所选模型被隐藏）、WIRING_CONFIG_UNPARSEABLE、WIRING_SYMLINK_ESCAPE、WIRING_PATH_CONFLICT、WIRING_UNSUPPORTED_STRUCTURE；503 GATEWAY_NOT_LISTENING；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_plan_agent_wiring",
  },
  {
    method: "POST",
    path: "/api/v1/agents/{id}/wiring",
    title: "接线到网关",
    group: "agents",
    request:
      "路径参数 id；model、models、tiers、effort、options 同预览；expect 必填，为用户确认的计划（预览响应即可），按 files[].path、exists、hash 核对。",
    response: "200：接线后的 Agent。",
    implementation:
      "AgentWiringService.wire：签发 agent:<id> 作用域、不过期的新 Key（modelAllow 为 models，未含 * 时加上 model 与各档模型；modelDeny 沿用当前隐藏列表），applyWiring 备份、原子写并回读校验，提交 WiringRecord（含 tiers、effort、options）后吊销旧 Key；任何失败都吊销新 Key。Key 文本只写入 Agent 的配置文件，守护进程不保存。codexAuth=chatgpt 时不签发 Key，只写 openai_base_url，并吊销之前的 Key。",
    effects:
      "改写 Agent 的配置文件（备份在 <dataDir>/backups/wiring/）；写入 gateway_keys 与 wirings 表。",
    errors:
      "409 WIRING_CONCURRENT_MODIFICATION（文件在预览后被改动，新 Key 已吊销）；500 WIRING_WRITE_FAILED、WIRING_VERIFY_FAILED（已写文件恢复为写前字节，消息列出恢复情况）；其余同预览；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_wire_agent",
  },
  {
    method: "POST",
    path: "/api/v1/agents/{id}/wiring/rotate",
    title: "轮换 Agent 的 Key",
    group: "agents",
    request: "路径参数 id；请求体为空对象。",
    response: "200：换 Key 后的 Agent。",
    implementation:
      "AgentWiringService.rotate：以当前 model、tiers、effort、options 与 Key 的 modelAllow、modelDeny 重新接线，流程同接线（不核对预览）。",
    effects: "改写配置文件中的 Key；旧 Key 立即吊销。",
    errors:
      "409 AGENT_NOT_WIRED、AGENT_KEYLESS（自己登录、没有 Key 的 Agent）；其余同接线；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_rotate_agent_key",
  },
  {
    method: "DELETE",
    path: "/api/v1/agents/{id}/wiring",
    title: "还原 Agent 配置",
    group: "agents",
    request: "路径参数 id。",
    response:
      "200：agent（还原后）与 files[]（path、action=restored|deleted|reverse-patched|unchanged|absent）。",
    implementation:
      "AgentWiringService.unwire：unwire 在文件未变时写回原始字节（接线新建的文件被删除）、否则只恢复 HarnessHub 写过的键，然后吊销 Key（有 Key 时）并删除 WiringRecord。",
    effects:
      "改写或删除 Agent 的配置文件；吊销 Key；删除 wirings 记录。失败时记录与 Key 保留，可重试。",
    errors:
      "409 AGENT_NOT_WIRED、WIRING_CONFIG_UNPARSEABLE；500 WIRING_BACKUP_INVALID；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_unwire_agent",
  },
  {
    method: "PUT",
    path: "/api/v1/agents/{id}/models",
    title: "设置 Agent 隐藏的模型",
    group: "agents",
    request:
      "路径参数 id；hidden 必填：要对该 Agent 隐藏的模型（provider/model、provider/*、group/<id> 或 *），其余模型（包括之后新增的）都显示；空数组显示全部。",
    response:
      "200：更新后的 Agent，wiring.models 为显示的模型，wiring.hidden 为隐藏列表。",
    implementation:
      "AgentWiringService.setHidden：把 Agent Key 的 modelDeny 改为 hidden（同一把 Key，不轮换），再从 Agent 文件中读回这把 Key、以过滤后的模型列表经 applyWiring 重写其模型清单（OpenCode、Pi、Crush、Kimi 的模型条目，Codex 的模型目录，Claude 的 CLAUDE_CODE_MODEL_CAPABILITIES）；网关的 /v1/models 与调用对这把 Key 按同一列表过滤。重写失败时 modelDeny 恢复原值。",
    effects:
      "改写 gateway_keys 中该 Key 的 modelDeny；按需改写 Agent 的配置文件（备份同接线）并更新 wirings 记录。",
    errors:
      "400 AGENT_MODELS_INVALID；409 AGENT_NOT_WIRED、AGENT_KEYLESS、AGENT_KEY_INACTIVE（Key 已吊销或丢失）、AGENT_MODEL_IN_USE（隐藏了 Agent 正在用的模型或档位模型）、AGENT_KEY_NOT_IN_FILES（Agent 文件中已没有它的 Key，需 rotate）；其余同接线；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_set_agent_models",
  },
  {
    method: "GET",
    path: "/api/v1/profiles",
    title: "接线 Profile 列表",
    group: "agents",
    request: "无参数。",
    response:
      "200：items（Profile：name、agents{<agent id>: {model?、tiers?、effort?、options?}}、createdAt、updatedAt）按名称排序、nextCursor=null。",
    implementation:
      "AgentWiringService.listProfiles：读取 wiring_profiles 表。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_list_profiles",
  },
  {
    method: "GET",
    path: "/api/v1/profiles/{name}",
    title: "单个接线 Profile",
    group: "agents",
    request:
      "路径参数 name（1 到 64 个字母、数字、.、_、-，以字母或数字开头）。",
    response: "200：Profile，字段同列表项。",
    implementation: "AgentWiringService.getProfile。",
    effects: "只读。",
    errors:
      "400 请求校验失败；404 PROFILE_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_get_profile",
  },
  {
    method: "PUT",
    path: "/api/v1/profiles/{name}",
    title: "保存接线 Profile",
    group: "agents",
    request: "路径参数 name；请求体为空对象。",
    response: "200：保存的 Profile。",
    implementation:
      "AgentWiringService.saveProfile：把每个已接线 Agent 的 model、tiers、effort、options 存为该名称的 Profile，同名则替换（保留 createdAt）。隐藏的模型与 Key 不属于 Profile。",
    effects: "写入 wiring_profiles 表；不改 Agent 文件。",
    errors:
      "400 请求校验失败；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_save_profile",
  },
  {
    method: "DELETE",
    path: "/api/v1/profiles/{name}",
    title: "删除接线 Profile",
    group: "agents",
    request: "路径参数 name。",
    response: "204：无内容。",
    implementation: "AgentWiringService.deleteProfile。",
    effects: "删除 wiring_profiles 中的一行；不改 Agent 文件。",
    errors:
      "404 PROFILE_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_delete_profile",
  },
  {
    method: "POST",
    path: "/api/v1/profiles/{name}/plan",
    title: "预览应用接线 Profile",
    group: "agents",
    request: "路径参数 name；请求体为空对象。",
    response:
      "200：profile 与 agents[]（adapterId、changed、plan）：选择与当前接线相同的 Agent changed=false、plan=null，其余为预览接线的计划。",
    implementation:
      "AgentWiringService.planProfile：对 Profile 中每个 Agent 比较 model、tiers、effort、options，不同的按预览接线计算计划（临时 Key 不保存）。不在 Profile 中的 Agent 不受影响。",
    effects: "只读；不写文件，不签发 Key。",
    errors:
      "404 PROFILE_NOT_FOUND、WIRING_ADAPTER_UNKNOWN；其余同预览接线；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_plan_profile",
  },
  {
    method: "POST",
    path: "/api/v1/profiles/{name}/apply",
    title: "应用接线 Profile",
    group: "agents",
    request:
      "路径参数 name；expect 必填：按 Agent id 给出每个要改变的 Agent 确认过的计划（预览响应中 agents[].plan 即可）。",
    response:
      "200：profile 与 agents[]（adapterId、outcome=applied|unchanged、agent）。",
    implementation:
      "AgentWiringService.applyProfile：先确认每个与当前不同的 Agent 都有 expect，再逐个经接线同一路径（新 Key、备份、原子写、回读校验、吊销旧 Key）切换；遇到第一个失败即停止，错误信息列出已切换的 Agent。",
    effects:
      "改写所切换 Agent 的配置文件；签发新 Key、吊销旧 Key；更新 wirings 记录。",
    errors:
      "409 PROFILE_PLAN_STALE（预览后有 Agent 改变，未写任何文件）、WIRING_CONCURRENT_MODIFICATION；404 PROFILE_NOT_FOUND；其余同接线，消息前缀为停止处的 Agent；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/agents-routes.ts",
    tests: ["tests/integration/agents-wiring.test.ts"],
    operationId: "hh_api_v1_apply_profile",
  },
  {
    method: "POST",
    path: "/api/v1/backup",
    title: "生成加密备份",
    group: "backup",
    request:
      "passphrase（必填，1–1024 字符）；keys 缺省 true，false 时不带凭证值。",
    response:
      "200：加密信封 format=harnesshub-backup、version=1、kdf=pbkdf2-sha256、iterations=600000、salt、nonce、data（base64，AES-256-GCM 密文加 16 字节标签）；即备份文件的内容。",
    implementation:
      "BackupService.create：收集 provider（store 凭证按 keys 解析出值，env/file/keychain 引用原样保留）、覆盖值与来源、路由组、接线意图（Agent、model、models）、client Key 的名称与允许范围、局域网共享与目录设置，再以口令派生的密钥（PBKDF2-SHA256 600,000 次）用 AES-256-GCM 加密，信封字段作为附加认证数据。",
    effects: "只读；口令不保存；Gateway Key 文本从不进入备份。",
    errors:
      "400 INVALID_REQUEST（口令为空等）；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/backup-routes.ts",
    tests: ["tests/integration/backup-restore.test.ts"],
    operationId: "hh_api_v1_create_backup",
  },
  {
    method: "POST",
    path: "/api/v1/restore",
    title: "恢复备份",
    group: "backup",
    request:
      "backup（备份文件的 JSON）、passphrase；agents 缺省 true，false 时不重新接线；dryRun 缺省 false，true 时只返回摘要。请求体上限 64 MiB。",
    response:
      "200：摘要 providers（added、replaced、needKey）、groups（added、replaced、skipped）、overrides、profiles（added、replaced）、gatewayShare（action、settings、error）、catalog（backup、current、differs）、agents[]（agent、model、tiers、effort、options、models、deny 与 action=wire|unchanged|skip-*，恢复后 outcome=wired|failed 与 error）、clientKeys（需重新签发）。",
    implementation:
      "BackupService.restore：解密并校验内容后逐条写入：同 id 的 provider 与同名 profile 替换、其余新增（不带 Key 的备份保留本机凭证；新凭证先写入密钥存储，provider 写失败则删除），路由组，局域网共享设置（GatewayShare.update），再对本机已安装的 Agent 经 AgentWiringService 的 plan 与 wire（expect 为该预览）按 model、models、tiers、effort 与 options 以新的 agent: Key 接线，隐藏的模型不同时经 setHidden 设置。",
    effects:
      "非 dryRun 时写入 providers、模型覆盖与来源、路由组、接线 profile 与密钥存储，可能改写 gateway-sharing.json 与 Agent 配置文件；不删除任何本机记录；单条失败的 Agent 接线不影响其余项。",
    errors:
      "400 BACKUP_PASSPHRASE（口令错误或文件被改）、BACKUP_INVALID、BACKUP_UNSUPPORTED（更新版本的备份）；413 PAYLOAD_TOO_LARGE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/backup-routes.ts",
    tests: ["tests/integration/backup-restore.test.ts"],
    operationId: "hh_api_v1_restore_backup",
  },
  {
    method: "GET",
    path: "/api/v1/sync",
    title: "同步状态",
    group: "backup",
    request: "无参数。",
    response:
      "200：enabled、kind=webdav|s3、url、user、endpoint、region、pathStyle、keys、agents、intervalMs、lastSyncAt、lastError、nextSyncAt、notice（两边都改过时被替换的部分与副本目录）、secretBackend。",
    implementation:
      "SyncService.status 读取 <dataDir>/sync/config.json 与 state.json 的内存副本。",
    effects: "只读；不返回口令或目标凭证。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/backup-routes.ts",
    tests: ["tests/integration/sync.test.ts"],
    operationId: "hh_api_v1_get_sync",
  },
  {
    method: "PUT",
    path: "/api/v1/sync",
    title: "开启或修改同步",
    group: "backup",
    request:
      "kind=webdav|s3、url 必填；user（WebDAV 用户名或 S3 access key ID，S3 必填）、secret（WebDAV 密码或 S3 secret key）、passphrase、endpoint、region、pathStyle（仅 S3）、keys 与 agents（缺省 true）。省略 secret 或 passphrase 时沿用已保存的（secret 只对同一目标与用户）。",
    response: "200：同步状态，warnings 说明口令保存在密钥存储中。",
    implementation:
      "SyncService.configure：校验地址后把 secret 与 passphrase 写入密钥存储，原子写入 config.json（0600），删除被替换的旧密钥，并安排后台同步（之后每 3 分钟一次）。",
    effects: "写入密钥存储与 <dataDir>/sync/config.json；不立即同步。",
    errors:
      "400 SYNC_CONFIG_INVALID 或 INVALID_REQUEST；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/backup-routes.ts",
    tests: ["tests/integration/sync.test.ts"],
    operationId: "hh_api_v1_configure_sync",
  },
  {
    method: "DELETE",
    path: "/api/v1/sync",
    title: "关闭同步",
    group: "backup",
    request: "无参数。",
    response: "200：enabled=false 的同步状态。",
    implementation:
      "SyncService.disable：停止后台循环并中止进行中的同步，删除 config.json、state.json、服务器副本缓存与两项密钥。",
    effects: "冲突副本（<dataDir>/sync/conflicts/）保留；服务器上的文件不动。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/backup-routes.ts",
    tests: ["tests/integration/sync.test.ts"],
    operationId: "hh_api_v1_disable_sync",
  },
  {
    method: "POST",
    path: "/api/v1/sync/now",
    title: "立即同步",
    group: "backup",
    request: "请求体为空对象。",
    response: "200：同步后的状态。",
    implementation:
      "SyncService.now：条件读取服务器文件（If-None-Match），按 providers、agents 与 profiles 三部分三方比较，只改了一边的取该边，两边都改的取最后修改的一边并保存被替换的副本，带入的部分逐条写入本机，合并结果只在服务器仍是读到的版本时写回（WebDAV If-Match；S3 If-Match，或不支持时先比较 ETag 并在有版本时核对前一版本），被抢先写入时读入对方版本重来一次。",
    effects:
      "可能写入 providers、路由组、密钥存储与 Agent 配置文件，删除服务器上已没有的 provider、路由组（Gateway Key 仍允许的保留并列入 notice.kept）与 profile；服务器只收到加密文件。",
    errors:
      "409 SYNC_DISABLED、SYNC_PASSPHRASE（服务器文件不是用此口令加密的）、SYNC_CONFLICT（重试后仍被抢先写入）；502 SYNC_REMOTE_FAILED；503 SYNC_RATE_LIMITED；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json。",
    source: "packages/daemon/src/http/backup-routes.ts",
    tests: ["tests/integration/sync.test.ts"],
    operationId: "hh_api_v1_sync_now",
  },
  {
    method: "GET",
    path: "/api/v1/library/instructions",
    title: "指令集列表",
    group: "library",
    request: "无参数。",
    response:
      "200：items（id、name、sha256、size、agents、createdAt、updatedAt，不含正文）按 id 排序、nextCursor=null。",
    implementation:
      "LibraryService.index：读取 <dataDir>/library/library.json。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_list_library_instructions",
  },
  {
    method: "POST",
    path: "/api/v1/library/instructions",
    title: "新建指令集",
    group: "library",
    request:
      "id（小写字母、数字、连字符，1 到 63 个字符）、text（Markdown，最多 256 KiB，CRLF 转为 LF，首尾空白去掉）必填；name、agents（有用户级指令文件的 Agent，可选）。",
    response: "201：指令集，含 text。",
    implementation:
      "LibraryService.putInstructions → LibraryStore.putInstructionSet：校验后写 instructions/<id>.md 与 library.json（0600，临时文件加 rename）。",
    effects: "写 <dataDir>/library；不改 Agent 文件，同步时才写入。",
    errors:
      "409 LIBRARY_EXISTS（id 已存在）、LIBRARY_CONFLICT（某个 Agent 已有别的指令集，一个 Agent 只能有一套）；400 LIBRARY_INVALID、LIBRARY_UNSUPPORTED（Kimi、Hermes 没有用户级指令文件）；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_create_library_instructions",
  },
  {
    method: "GET",
    path: "/api/v1/library/instructions/{id}",
    title: "单个指令集",
    group: "library",
    request: "路径参数 id。",
    response: "200：指令集，含 text。",
    implementation: "LibraryService.instructions。",
    effects: "只读。",
    errors:
      "404 LIBRARY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_get_library_instructions",
  },
  {
    method: "PUT",
    path: "/api/v1/library/instructions/{id}",
    title: "替换指令集",
    group: "library",
    request:
      "路径参数 id；text 必填，name、agents 可选（整体替换，不存在时新建）。",
    response: "200：指令集，含 text。",
    implementation:
      "LibraryService.putInstructions（create=false）。尚无 ETag/If-Match。",
    effects: "写 <dataDir>/library；Agent 文件在下一次同步时更新。",
    errors:
      "409 LIBRARY_CONFLICT；400 LIBRARY_INVALID、LIBRARY_UNSUPPORTED；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_replace_library_instructions",
  },
  {
    method: "DELETE",
    path: "/api/v1/library/instructions/{id}",
    title: "删除指令集",
    group: "library",
    request: "路径参数 id。",
    response: "204。",
    implementation: "LibraryService.remove → LibraryStore.remove。",
    effects: "从 Library 删除；Agent 文件中的区块保留到下一次同步把它移除。",
    errors:
      "404 LIBRARY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_delete_library_instructions",
  },
  {
    method: "GET",
    path: "/api/v1/library/mcp",
    title: "MCP 服务列表",
    group: "library",
    request: "无参数。",
    response:
      "200：items（name、transport、command、args、url、env、secretEnv、headers、secretHeaders、agents、时间戳）按名称排序；秘密只以引用 {kind: env|file|store, value} 出现，从不返回值。",
    implementation: "LibraryService.index。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_list_library_mcp",
  },
  {
    method: "POST",
    path: "/api/v1/library/mcp",
    title: "新建 MCP 服务",
    group: "library",
    request:
      "name、transport（stdio|http|sse）必填；stdio 用 command、args、env、secretEnv，http/sse 用 url（不得含账号密码或密钥类查询参数）、headers、secretHeaders；秘密为引用 {kind: env|file, value}，或值 {secret}（存入秘密库，条目只保留 store 引用）；env/headers 中 …_TOKEN、…_API_KEY、Authorization 等名称必须放进 secret*；agents 只能是支持该传输的 Agent。",
    response: "201：MCP 服务（秘密为引用）。",
    implementation:
      "LibraryService.putMcp：parseMcpServer 校验；逐个引用做 07 第 4.6 节的登记检查（HH_/HARNESSHUB_ 变量、数据目录与配置目录中的文件、与任一 provider Credential 相同的 env 名、文件或 store ID），值与 Gateway Key、管理令牌及各 provider Credential 的值按 SHA-256 摘要比对；通过后才写秘密库与 library.json。",
    effects: "写秘密库与 <dataDir>/library；不改 Agent 文件。",
    errors:
      "400 SECRET_REF_FORBIDDEN（引用或值是 HarnessHub 自身凭据，未保存任何内容）、LIBRARY_INVALID（含引用了本服务未持有的 store 秘密）、LIBRARY_UNSUPPORTED（如 Codex、Pi 不支持 sse）；409 LIBRARY_EXISTS；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: [
      "tests/integration/library.test.ts",
      "packages/agents/test/library.test.ts",
    ],
    operationId: "hh_api_v1_create_library_mcp",
  },
  {
    method: "GET",
    path: "/api/v1/library/mcp/{name}",
    title: "单个 MCP 服务",
    group: "library",
    request: "路径参数 name（字母、数字、_、-，最多 64 个字符）。",
    response: "200：MCP 服务（秘密为引用）。",
    implementation: "LibraryService.mcp。",
    effects: "只读。",
    errors:
      "404 LIBRARY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_get_library_mcp",
  },
  {
    method: "PUT",
    path: "/api/v1/library/mcp/{name}",
    title: "替换 MCP 服务",
    group: "library",
    request:
      "路径参数 name；字段同新建（不含 name）；{kind: store} 只能是本服务已持有的秘密。",
    response: "200：MCP 服务。",
    implementation:
      "LibraryService.putMcp（create=false）：检查同新建；保存后删除本服务不再使用的 store 秘密（删除失败记日志，只含秘密 ID）。尚无 ETag/If-Match。",
    effects: "写秘密库与 <dataDir>/library。",
    errors:
      "400 SECRET_REF_FORBIDDEN、LIBRARY_INVALID、LIBRARY_UNSUPPORTED；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_replace_library_mcp",
  },
  {
    method: "DELETE",
    path: "/api/v1/library/mcp/{name}",
    title: "删除 MCP 服务",
    group: "library",
    request: "路径参数 name。",
    response: "204。",
    implementation: "LibraryService.remove：删除条目后删除它的 store 秘密。",
    effects:
      "从 Library 与秘密库删除；Agent 文件中的条目保留到下一次同步把它移除。",
    errors:
      "404 LIBRARY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_delete_library_mcp",
  },
  {
    method: "GET",
    path: "/api/v1/library/skills",
    title: "Skill 列表",
    group: "library",
    request: "无参数。",
    response:
      "200：items（name、description、sha256（保存的版本）、files、size、agents、时间戳）。",
    implementation: "LibraryService.index。",
    effects: "只读。",
    errors:
      "需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_list_library_skills",
  },
  {
    method: "POST",
    path: "/api/v1/library/skills",
    title: "导入 Skill",
    group: "library",
    request:
      "source（守护进程所在机器上 Skill 目录的绝对路径）必填，agents 可选。",
    response: "201：Skill。",
    implementation:
      "LibraryService.importSkill → LibraryStore.importSkill：按 Agent Skills 规范校验（SKILL.md 的 YAML front matter 有 name 与 description，name 为小写字母、数字、单个连字符且等于目录名；不含链接；最多 500 个文件、20 MiB），按内容哈希保存到 library/skills/<sha256>/<name>/（已有版本不重复保存）；同名 Skill 指向新版本。",
    effects: "写 <dataDir>/library；回收没有被引用的旧版本。",
    errors:
      "400 LIBRARY_SKILL_INVALID、LIBRARY_INVALID；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: [
      "tests/integration/library.test.ts",
      "packages/agents/test/library.test.ts",
    ],
    operationId: "hh_api_v1_import_library_skill",
  },
  {
    method: "GET",
    path: "/api/v1/library/skills/{name}",
    title: "单个 Skill",
    group: "library",
    request: "路径参数 name。",
    response: "200：Skill。",
    implementation: "LibraryService.skill。",
    effects: "只读。",
    errors:
      "404 LIBRARY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_get_library_skill",
  },
  {
    method: "PATCH",
    path: "/api/v1/library/skills/{name}",
    title: "修改 Skill 的 Agent",
    group: "library",
    request: "路径参数 name；agents 必填（JSON 或 merge-patch+json）。",
    response: "200：Skill。",
    implementation: "LibraryService.setSkillAgents。",
    effects: "写 library.json。",
    errors:
      "404 LIBRARY_NOT_FOUND；400 LIBRARY_INVALID；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_patch_library_skill",
  },
  {
    method: "DELETE",
    path: "/api/v1/library/skills/{name}",
    title: "删除 Skill",
    group: "library",
    request: "路径参数 name。",
    response: "204。",
    implementation:
      "LibraryService.remove：删除条目，回收不再被 Library 或任一 Agent 引用的版本。",
    effects:
      "Agent 中的链接或副本保留到下一次同步把它移除（链接指向的版本在此之前保留）。",
    errors:
      "404 LIBRARY_NOT_FOUND；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: ["tests/integration/library.test.ts"],
    operationId: "hh_api_v1_delete_library_skill",
  },
  {
    method: "POST",
    path: "/api/v1/library/sync/plan",
    title: "Library 同步预览",
    group: "library",
    request:
      "agents（默认全部 Library Agent）、allowPlaintextSecret（把 Agent 无法引用的秘密值写入其文件）、placement（auto 链接，copy 复制 Skill）均可选。",
    response:
      "200：changed 与 agents[]（agent、name、changed、files[]（kind=instructions|mcp、path、exists、hash、action=write|restore|delete|unchanged、diff，明文写入的秘密值显示为 <secret>）、skills[]（name、path、action=place|replace|remove|unchanged）、refused[]（kind、name、reason）、warnings[]）。",
    implementation:
      "LibraryService.plan → planLibrarySync：按各 Agent 的原生位置与格式（Magpie internal/library/targets.go）计算标记区块、MCP 条目与 Skill 链接；同名的用户条目、无法引用的秘密（Kimi 一律、Pi/Crush/Hermes 待核）、不支持的传输与禁止的秘密引用列入 refused。",
    effects: "只读，不写任何文件。",
    errors:
      "409 WIRING_CONFIG_UNPARSEABLE、WIRING_UNSUPPORTED_STRUCTURE、WIRING_SYMLINK_ESCAPE、LIBRARY_CONFLICT（MCP 容器不是对象）；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: [
      "tests/integration/library.test.ts",
      "packages/agents/test/library.test.ts",
    ],
    operationId: "hh_api_v1_plan_library_sync",
  },
  {
    method: "POST",
    path: "/api/v1/library/sync/apply",
    title: "Library 同步应用",
    group: "library",
    request:
      "字段同预览；expect 必填，为用户确认的计划（预览响应即可），按 agents[].files[].path、exists、hash 核对。",
    response: "200：已应用的计划，结构同预览。",
    implementation:
      "LibraryService.apply → applyLibrarySync：逐个 Agent 持有与全局接线共用的锁，重新计划并核对 expect，首次改动前把原始字节存入 <dataDir>/backups/wiring/library-<agent>/，原子写并回读校验，写完一个 Agent 就提交 applied.json；只删除 HarnessHub 写入的条目，文件仍是上次写入的样子时写回原始字节或删除新建的文件。",
    effects:
      "改写 Agent 的指令文件、MCP 配置与 Skills 目录；写 <dataDir>/library/applied.json；回收不再引用的 Skill 版本。",
    errors:
      "409 LIBRARY_CONCURRENT_MODIFICATION（文件在预览后被改动，该 Agent 未写入）、WIRING_BUSY；写入或提交失败时该 Agent 已写的内容恢复为写前字节；其余同预览；守护进程未设置接线目录（startHub 未传 wiringHome；只有 hh serve 传入本机用户目录）时 503 AGENT_WIRING_UNAVAILABLE；需本机管理令牌（Authorization: Bearer，<dataDir>/admin.token）与回环连接，否则 401 ADMIN_TOKEN_REQUIRED/ADMIN_TOKEN_INVALID 或 403 LOCAL_ACCESS_REQUIRED；错误一律为 application/problem+json（code、requestId、errors[] 指向字段）。",
    source: "packages/daemon/src/http/library-routes.ts",
    tests: [
      "tests/integration/library.test.ts",
      "packages/agents/test/library.test.ts",
    ],
    operationId: "hh_api_v1_apply_library_sync",
  },
];
