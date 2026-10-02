# 13 多包迁移计划（OSS-004）

状态：已采纳（2026-10-02，AI 维护者），作为 [TODO](../../../TODO.md) 中 OSS-004 的执行计划。目标结构以 [02 第 8 节](02-architecture.md#8-模块与依赖规则) 与 [10 第 1 节](10-engineering.md#1-仓库结构) 为准；本文的取舍及理由记录在 [ADR 0017](../../decisions/0017-package-layout-migration.md)。调研基于 `b0f0b88`，本文数字按 `main` 的 `b5ee7b4` 更新。文中的 `packages/`、`apps/`、`tools/` 路径、`@harnesshub/*` 包名与新增文件都是计划名称，在对应步骤合入之前不存在。

迁移只改变文件位置、包边界和构建方式，不改变行为。测试随代码迁移，断言不放宽；每一步在每个平台上的用例清单与上一步相比，只允许测试文件位置不同。

## 1. 现状

`src` 有 105 个源文件。测试有单元 38 个、集成 42 个、smoke 3 个文件，另有 16 个 fixture 与 2 个支持文件；`scripts/` 下有 14 个工具测试文件（第 1 步后位于 `tools/`）。模块之间的导入（不含模块内部导入）：

| 模块 | 导入的其他模块（导入数） | 第三方 |
|---|---|---|
| domain | — | ajv |
| storage | domain 14 | node:sqlite |
| platform | domain 2 | child_process（ACL 辅助程序） |
| process | domain 12 | ajv、child_process |
| runtime | domain 6 | — |
| application | domain 19，runtime 1（`service.ts`） | — |
| benchmark | domain 10，application 1（`runner.ts`） | — |
| artifacts | domain 5，platform 3 | — |
| engine | domain 16 | ajv、yaml |
| tool-packages | domain 17，platform 2（`files.ts`） | ajv |
| logging、rollout | domain | — |
| gateway（HTTP） | domain 20，application 6 | fastify、@fastify/swagger |
| drivers/acp | domain 10，driver 1，configuration 1（类型 `RuntimeMcpServer`） | acpx |
| drivers/cli、fake | domain，driver | cli 使用 child_process |
| drivers/chat-completions | domain 2 | node:http |
| drivers/configuration | domain 12，chat-completions 1（`prepare.ts` → `startModelGateway`） | yaml；probe 与 secrets 使用 child_process |
| drivers/tool-command | 无（作为独立进程运行） | child_process |
| worker | domain 7，drivers 7（`main.ts`、`outcome.ts`），logging 1 | — |
| 入口 `main.ts`、`benchmark-main.ts`、`cli.ts`、`tool-packages-main.ts` | 组合根，导入大部分模块 | — |

另有按路径而非导入定位的文件：`process/worker-host.ts` 以 `../worker/main.js` 派生 Worker；`main.ts` 与 `tool-packages-main.ts` 指向 `drivers/tool-command/command-mcp.js`；`engine/discovery.ts`、`engine/installation.ts`、`drivers/configuration/launch.ts` 指向 `scripts/launch-engine.mjs`；`drivers/configuration/native-mcp.ts` 指向 `scripts/native-mcp/pi-extension.mjs`；五个文件指向 `dist/native/*`；`main.ts` 读取 `dist/build-info.json`；`benchmark-main.ts` 读取根 `package.json`。`cross-spawn` 只被 `scripts/spawn-engine.mjs` 使用，`@agentclientprotocol/sdk` 只被 8 个测试 fixture 使用。原 `storage/release-catalog.ts` 没有任何导入方，已在第 0 步删除。

## 2. 目标映射

布局规则：每个旧模块在所属包内保留自己的目录（`packages/<包>/src/<模块>/…`），模块内部的导入不变，多数 `../../native/x` URL 继续有效；只有跨包导入改为 `@harnesshub/<包>/<模块>/<文件>`。

| 包 | 内容 | 第三方 |
|---|---|---|
| core | `domain/*`（16 个）平铺到 `src/`；新增 `model-bridge.ts`（从 `chat-completions/gateway.ts` 移出的类型）；`RuntimeMcpServer` 类型 | ajv |
| store | `storage/*`（5 个）；`platform/*` 放入 `src/platform/`；`windows-acl.cs` | — |
| secrets | `configuration/secrets.ts`；`keychain.swift`、`windows-secrets.cs` | — |
| gateway | `chat-completions/*`（11 个） | — |
| agents | `engine/`；`configuration/` 的 prepare、launch、native-mcp、codex-models、codex-default-instructions；`tool-packages/`；`tool-command/`；`application/` 的 engine-configuration 与 harness-model | ajv、yaml |
| runtime | `runtime.ts`；`application/` 的 service、workflows、observability；`process/*`；`configuration/probe.ts` 改放 `process/probe.ts`；`benchmark/`；`artifacts/`；`windows-job.cs` | ajv |
| drivers | `driver.ts`、`acp/`、`cli/`、`fake/` | acpx（含现有补丁） |
| daemon | `main.ts`、`benchmark-main.ts`、`tool-packages-main.ts`；`gateway/` 改放 `src/http/`；`logging/`；`worker/` | fastify、@fastify/swagger |
| cli | `cli.ts`、`rollout/export.ts` | — |
| console | `git mv web packages/console` | 不变 |
| plugin-host、sdk | `package.json`、`src/index.ts`（`export {}`）与 README | — |

`apps/hh`：npm 包名 `harnesshub`，命令 `hh`；`src/main.ts` 把 `serve`、`benchmark`、`tools` 分派给 daemon，把 `rollout` 分派给 cli（从各入口的直接执行判断中抽出 `main(argv)` 函数）。OSS-008 之前 Worker 仍按路径派生。根包改名（如 `harnesshub-workspace`）。

`tools/`：`scripts/` 下的仓库工具全部移入，包括 `check-*` 及其测试、`run-tests`、`lib/`、`build-*`、`clean-build`、`build-info`、`generate-api-docs`、`console`、`start-local`、`mock-chat-provider`、`strict-chat-proxy`、`compare-inventory`，以及 OSS-008 的 SEA 原型 `sea/`。`scripts/` 只保留已登记引擎命令与 `engines/*.example.json` 中以绝对路径保存的运行时文件：`launch-engine.mjs`、`spawn-engine.mjs`、`launch-{dsh,openclaw,opencode,pi}-acp.mjs`、`native-mcp/pi-extension.mjs`；`cross-spawn` 因此仍是根依赖。原生辅助程序源码 `scripts/native/` 也暂留原处，在第 3、4、8 步随所属包一次迁移，避免移动两次。

测试：25 个单元测试移入所属包的 `packages/<包>/test/`。core：schema、worker-protocol；gateway：model-gateway、model-gateway-runs、model-gateway-upstream、model-gateway-keepalive；agents：command-mcp-windows-batch、config、discovery、engine-manager、harness-model、installation、mimo-mcp-logging、native-mcp、qwen-configuration、registry-harness-model、tool-packages-import、tool-packages-manifest、windows-launch；runtime：files、runtime-inspection；daemon：benchmark-report、diagnostic-log、openapi、session-log-reader、worker-outcome。其余单元测试跨包或依赖 `tests/support`，暂留 `tests/unit`。集成、smoke、fixture 与支持文件不动；新增 `tests/support/entries.ts` 向测试提供各入口路径。

## 3. 违反目标依赖图的边

| 编号 | 边 | 修复 |
|---|---|---|
| V1 | agents（`prepare.ts`）→ gateway（`startModelGateway` 与类型） | `ModelGateway`、`ModelGatewayOptions`、`ModelCallRecord`、`InboundProtocol` 移到 `core/model-bridge.ts`。新增 `PreparationHooks.startModelGateway`，由 daemon 的 `worker/main.ts` 与 `main.ts`（配置探测路径）注入；需要路由而未注入时抛出具名 HubError。M1 把网关移入 daemon 时沿用这一接缝。 |
| V2 | drivers（`acp/driver.ts`）→ agents（类型 `RuntimeMcpServer`） | 类型移到 core，`prepare.ts` 再导出。 |
| V3 | daemon `worker/outcome.ts` → gateway 类型 | 改用 core 中的类型。 |
| V4 | 配置接线在 Worker 内运行 | 不违反：Worker 入口属于 daemon，daemon → agents → secrets 允许，drivers 不导入 secrets。 |
| V5 | runtime `worker-host` → `daemon/worker/main.js`（路径） | 新增必填选项 `workerEntry`；daemon 传入 `new URL("./worker/main.js")`，测试使用 `tests/support/entries.ts` 的 `WORKER_ENTRY`。租约保存自己的 `workerPath`，既有租约照常校验。 |
| V6 | 子进程启动分散在多处 | probe.ts 移入 runtime。drivers/cli、secrets、store/platform 与 agents/tool-command 暂时允许 `child_process`，所有者为 OSS-010 F08，期限为 M0 退出（OSS-013）：届时 `ProcessLauncher` 接口进入 core，实现在 runtime，由 daemon 注入。 |
| V7 | runtime 的 artifacts 与 agents 的 tool-packages → platform | platform 放入 store，两者都可以依赖 store。 |
| V8 | agents → 仓库 `scripts/` 资源（相对 URL） | `agents/configuration/launch.ts` 中只有一个 `repositoryScript(name)` 辅助函数；该例外归 OSS-004 所有，资源带旧路径别名移走时删除。 |
| V9 | daemon → `command-mcp.js`（相对 URL） | agents 导出常量 `COMMAND_MCP_ENTRY`。 |

daemon 内只有 `src/worker/**` 可以导入 drivers。

## 4. 构建与工具

- 使用 `tsc -b` 项目引用。`tsconfig.base.json` 保存现有编译选项，并加入 `composite` 与 `customConditions: ["@harnesshub/source"]`。每个包：`rootDir "."`、`outDir "dist"`、`tsBuildInfoFile "dist/.tsbuildinfo"`，包含 `src` 与 `test`，引用其依赖。导出：`"./*": {"@harnesshub/source": "./src/*.ts", "types": "./dist/src/*.d.ts", "default": "./dist/src/*.js"}`。迁移期间根 `tsconfig.json` 是一个 solution，另引用 `tsconfig.legacy.json`（`src` 加 `tests`，composite）；daemon 步骤中它改为 `tests/tsconfig.json`，输出到 `../dist/tests`。
- 测试先编译，再经 `tools/run-tests.mjs` 以 `node --test` 运行。单元组为 `packages/*/dist/test/*.test.js` 加 `dist/tests/unit/*.test.js`；集成与 smoke 的匹配不变。`check-windows` 还要找到 `packages/agents/dist/test/windows-launch.test.js`。
- 原生辅助程序构建到所属包的 `dist/native`（store：acl；secrets：keychain、secrets.exe；runtime：job.exe），各包导出路径常量供测试与 start-local 使用。`build-info.json` 写到 `packages/daemon/dist/`。`benchmark-main.ts` 读取根 `package.json`。`clean-build` 删除 `*/dist/{src,test,.tsbuildinfo}`，保留 `native/`。
- OSS-004 的边界检查：扫描 `src`、`packages`、`apps`；`@harnesshub/*` 导入遵守 02 第 8 节的依赖图；相对导入与 `new URL` 不得离开所在包（列入允许表的 scripts 资源除外）；旧模块规则按子目录沿用；第三方依赖的位置（acpx、sqlite、fastify，以及带期限的 `child_process` 允许表）；还在 `src` 中的文件经临时别名表把包子路径映射到旧模块名。OSS-005 再加入：声明的依赖是依赖图的子集、导入是声明依赖的子集、第三方只在声明它的包内、黑盒规则，每条规则一个拒绝样例。
- 脚本：`build` = clean → `tsc -b` → build-info → native；`typecheck` = `tsc -b`；lint 为 `eslint packages apps tests`（控制台单独）；格式检查的匹配同步更新；`start`、`benchmark`、`tools` 指向 daemon 的 dist；`check:*` 指向 `tools/`。第三方依赖随代码移出根包。
- CI：`ci.yml` 的检查不变；`dco.yml` 与 `labels.yml` 改用 `tools/` 路径；每个平台上传用例清单构件；`.gitignore` 加入新的 dist 与 `.next` 路径。

## 5. 步骤与对账

每一步一个 PR，squash 合并，三平台 CI 都通过；每一步修好自己造成的文档链接（`check:docs`）。

| 步骤 | 内容 | 风险 |
|---|---|---|
| 0 | 用例清单 reporter 与对比工具，记录各平台基线；删除无人引用的 `storage/release-catalog.ts`（单独提交）；本计划与 ADR 0017 | 低 |
| 1 | 仓库工具从 `scripts/` 移到 `tools/`；工作流与文档链接 | 低 |
| 2 | workspace 骨架、基础 tsconfig、solution 与 legacy 项目、ESLint projectService、边界扫描、core，以及空的 plugin-host 与 sdk | 中高 |
| 3 | store、platform 与 ACL 辅助程序 | 中 |
| 4 | secrets 与 Keychain、DPAPI 辅助程序 | 中 |
| 5 | gateway、`core/model-bridge` 与工厂注入（V1） | 中 |
| 6 | drivers 与 `RuntimeMcpServer`（V2）；acpx | 低 |
| 7 | agents、脚本 URL、`COMMAND_MCP_ENTRY`、已保存的旧 command-mcp 路径映射（附测试） | 高 |
| 8 | runtime、`workerEntry`（V5）、Job 辅助程序 | 高 |
| 9 | daemon 与 cli；删除 `src` 与 legacy 项目；`tests/tsconfig.json`；api-catalog 中的源码路径并重新生成 `docs/api` | 高 |
| 10 | 控制台迁移 | 中 |
| 11 | 迁移包内单元测试；apps/hh 骨架及 1 个 smoke 测试（唯一的用例数变化）；最终对账 | 低中 |

对账方法：测试启动器以 `--inventory` 写出每组用例清单（组名、测试文件名、名称路径、状态），CI 在 `pnpm check` 中设置 `HARNESSHUB_TEST_INVENTORY_DIR` 并按平台上传 `test-inventory-<os>` 构件；用 [`compare-inventory.mjs`](../../../tools/compare-inventory.mjs) 按平台比较上一步与本步的清单，它忽略文件位置，按组名、名称路径与状态计数匹配。每一步差异必须为空；第 11 步的新 smoke 测试经 `--allow` 列为唯一的预期新增。工具用法见 [测试要求](../../testing.md#测试可靠性)。

## 6. 决定

已采纳，前七项的理由与替代方案见 [ADR 0017](../../decisions/0017-package-layout-migration.md)：

1. SQLite 中保存的 `command-mcp.js` 路径（`tool-packages/bind.ts` 写入工具包绑定的 MCP 参数）：在 prepare 中把旧路径映射到当前入口，附测试；M1 删除。
2. 运行时资源在 OSS-004 期间留在 `scripts/`，以后带别名迁移。
3. platform 放入 store，作为 artifacts 与工具包共用的 Windows 文件原语的位置；`ProcessLauncher` 或平台层落地时重新评估。
4. 模型网关以可选钩子注入，需要而未注入时给出明确错误。
5. 通配导出加源码条件；以后用 API Extractor 收窄公开面。
6. 临时 `child_process` 例外带所有者与期限。
7. Worker 入口以 `workerEntry` 注入。
8. harness-model 服务归 agents；probe.ts 归 runtime。
9. 跨包测试暂留根目录 `tests/unit`。
10. 现在就建 apps/hh 骨架，分派到各包导出的入口函数。
11. `erasableSyntaxOnly` 在第 11 步之后单独提交。
12. 每个包为其原生辅助程序路径各加一个存在性测试；legacy 项目设为 composite，避免重复输出（TS6307）；用例清单按平台逐一比较。

## 7. 实施中确定的细节

第 2 步（workspace 骨架与 core）：

- 根包改名为 `harnesshub-workspace`，以 `workspace:*` 依赖 `@harnesshub/core`，`src/` 与 `tests/` 的编译产物经根 `node_modules` 解析它。各包都设 `private: true`，到 M1 发布 `core` 与 `sdk` 时再放开。
- core 声明 `ajv`；根包同时保留 `ajv`，直到 `src/` 中最后一个导入方（engine、process、tool-packages 与单元测试）迁出。plugin-host 与 sdk 暂不声明任何依赖，出现第一个导入时再加。
- legacy 项目的 `.tsbuildinfo` 在 `dist/.tsbuildinfo`，包的在各自 `dist/.tsbuildinfo`。`tsc -b` 只凭 `.tsbuildinfo` 判断项目是否最新：产物被删而它还在时，会不写出任何文件，因此 `clean-build` 每次同时删除产物与 `.tsbuildinfo`，并有测试固定这一点。`typecheck` 改为 `tsc -b`，会写出产物。
- ESLint 用 `projectService` 经 solution `tsconfig.json` 找到每个文件所属项目，并经源码条件直接读取依赖包的源码，lint 前不需要构建。lint 范围是 `src tests packages`；`apps` 在第 11 步建立后加入，因为 ESLint 对不存在的路径报错。
- 边界检查的命令行参数改为仓库根目录。包内不属于任何旧模块的新代码只受依赖图与第三方位置规则约束；包内测试只受依赖图与“不离开所在包”约束，与不扫描 `tests/` 的做法一致。
- 带期限的 `child_process` 允许表在第 3 步 platform 迁入 store 时加入，此前沿用旧模块规则；`new URL` 的 scripts 资源允许表在第 7 步（V8）加入，目前包内没有越界的 URL。

第 3 步（store）：

- `src/storage` 与 `src/platform` 原样迁入 `packages/store/src/` 的同名子目录；ACL 辅助程序源码与构建脚本迁入 `packages/store/native/`，脚本按自身位置计算路径，在 Windows 上输出到 `packages/store/dist/native/harnesshub-acl.exe`。`src/platform` 原来的 `new URL("../../native/harnesshub-acl.exe", import.meta.url)` 因此不变地指向包内产物；两处调用改为同一个 `aclHelperPath()`，仍在每次调用时计算，以便 SEA 改写 `import.meta.url` 后照常解析。
- 第一个包内测试 `packages/store/test/native-helper.test.ts`：所有平台检查路径落在 `packages/store/dist/native/harnesshub-acl.exe`；文件存在只在 Windows 上检查，其他平台跳过并写明原因（辅助程序只在 Windows 上构建）。单元组的匹配因此加入 `packages/*/dist/test/*.test.js`。
- 三个集成测试需要把编译后的 Store 模块地址交给子进程或 Worker 线程，改用 `import.meta.resolve("@harnesshub/store/storage/...")`，按包导出解析到编译产物。
- 边界检查：别名表的值可以是该包保存的旧模块列表（store 为 storage 与 platform），导入的第一段子路径必须是其中之一，并按该模块的规则检查；`node:sqlite` 只允许在 store 的 storage 中；包内的 `node:child_process` 只允许 `CHILD_PROCESS_EXCEPTIONS` 中的条目，每项写明所有者与到期任务，检查读取 `TODO.md`，该任务勾选后、或缺少 `TODO.md` 而无法判断时，导入即失败。
- SEA 构建把每个包的 `dist/native` 与根 `dist/native` 一样按仓库相对路径嵌入并解包。

第 4 步（secrets）：

- `drivers/configuration/secrets.ts` 平铺迁入 `packages/secrets/src/secrets.ts`，以 `@harnesshub/secrets/secrets` 导入；它只依赖 core。别名表把它映射到原 `drivers` 模块，因此 `src/` 中只有原来可以导入 drivers 的模块（drivers 自身、worker 与组合根）可以导入它。
- 钥匙串（Swift）与 DPAPI（C#）辅助程序源码及构建脚本迁入 `packages/secrets/native/`，构建到本包的 `dist/native`。运行时路径由 `secretHelperPath(platform)` 计算，相对层级从 `../../../native/` 变为 `../native/`；包内测试在所有平台检查两个路径，并在各自平台检查文件存在。`src/secrets.ts` 启动辅助程序，因此是第二个 `child_process` 例外（所有者 OSS-010 F08，随 OSS-013 到期）。
- 一个 Windows DPAPI 测试把编译后的模块交给子进程，改用 `import.meta.resolve`。

第 5 步（gateway 与 V1、V3）：

- `drivers/chat-completions` 的 11 个文件平铺迁入 `packages/gateway/src/`，以 `@harnesshub/gateway/<文件>` 导入；包只依赖 core。`InboundProtocol`、`ModelGatewayOptions`、`ModelCallRecord`、`ModelGateway` 从 `gateway.ts` 原样移到 `packages/core/src/model-bridge.ts`，不在网关中再导出；测试从 core 导入这些类型。
- V1：`PreparationHooks.startModelGateway` 由 Worker 入口与组合根的配置探测注入；需要路由而未注入时，在解析任何秘密、写入任何文件之前抛出 `MODEL_GATEWAY_NOT_INJECTED`（500，表示组合缺陷），由新单元测试固定。直接调用 `prepareConfiguration` 并经网关路由的 6 个单元测试文件改为注入同一个工厂。V3：`worker/outcome.ts` 改用 core 类型。
- 边界检查：别名表把 gateway 映射到原 `drivers` 模块；新增 `LEGACY_DESTINATIONS`，按第 2 节记录每个 `src/` 路径将迁入的包，`src/` 文件的 `@harnesshub/*` 导入还必须是该包按依赖图可以依赖的包。这使 V1（agents 的 `prepare.ts` 不得导入 gateway）与 V4（drivers 不得导入 secrets）从现在起就被检查，而不是等到对应文件迁入包时。
- 第 4 步安全审查提出的三项加固随第 5 步提交：SEA 构建只嵌入 `NATIVE_HELPERS` 列出的原生辅助程序，`dist/native` 或各包 `dist/native` 中的其他文件使构建失败，开发机上旧构建留下的辅助程序因此不会被打包（迁移辅助程序的步骤同时更新该表，第 8 步移走 Job 辅助程序）；`build.json` 记录每个嵌入资源的 SHA-256，`measure.mjs` 检查当前平台的密钥辅助程序解包后与记录一致，Linux 注明原因后跳过；`check-spdx` 拒绝 `packages/*/native` 中不是 `.cs`、`.swift`、`.mjs` 的文件和含 NUL 字节的文件，编译产物因此不会被提交。
- macOS 钥匙串条目的访问控制绑定创建它的那个辅助程序二进制。`swiftc` 的产物每次构建都不同（同一源码路径连续两次构建的 cdhash 也不同），另一个构建的辅助程序读取已有条目时，系统会等待用户批准，`interactionNotAllowed` 不能阻止；运行时在 20 秒后终止辅助程序并报 `SECRET_UNAVAILABLE`。这在迁移前的每次 `pnpm build` 后就已存在，迁移没有改变它；稳定的签名身份留给 M1 的发布签名。

第 6 步（drivers 与 V2）：

- `drivers/driver.ts`、`acp/`、`cli/`、`fake/` 迁入 `packages/drivers/src/`，子目录不变，以 `@harnesshub/drivers/<子目录>/<文件>` 导入；包只依赖 core，平铺映射到原 `drivers` 模块，ACP 规则因此照旧只允许 `src/acp` 使用 acpx。
- V2：`RuntimeMcpServer` 原样移到 `packages/core/src/runtime-mcp.ts`，`prepare.ts` 再导出它，ACP 驱动从 core 导入。
- `acpx` 成为 drivers 的依赖；根包只有一个集成测试直接导入 `acpx/runtime`，因此改为根包的开发依赖。根 `package.json` 的 `patchedDependencies` 对整个 workspace 生效，drivers 与根解析到同一个已打补丁的实例，补丁哈希不变。
- 边界检查：CLI 驱动是第三个 `child_process` 例外（所有者 OSS-010 F08，随 OSS-013 到期）；守护进程中只有 `worker/` 可以导入 drivers，对将迁入守护进程的 `src/` 文件和将来的 `packages/daemon` 同样检查。

第 7 步（agents 与 V8、V9）：

- `engine/`、`tool-packages/`、`drivers/tool-command/`、`drivers/configuration/` 的 prepare、launch、native-mcp、codex-models、codex-default-instructions，以及 `application/` 的 engine-configuration 与 harness-model 迁入 `packages/agents/src/` 的 `engine/`、`tool-packages/`、`tool-command/`、`configuration/`、`application/`；包依赖 core、store、secrets、ajv 与 yaml。根包的 `yaml` 只剩测试使用，改为开发依赖；`ajv` 仍有 `src/process` 使用。`probe.ts` 留在 `src/drivers/configuration`，第 8 步迁入 runtime。
- 边界检查用 `PACKAGE_ORIGINS` 取代原来的平铺表与别名表：每个包的文件按其来源映射回原路径（agents 的 `configuration/`、`tool-command/` 映射到 `drivers/...`），原模块规则与 `src/` 的导入规则都按映射后的路径执行；包内不属于原模块的文件是包级代码，本包各模块都可以使用。
- V8：`repositoryScript(name)` 放在包级的 `repository.ts`，因为 engine 的发现与安装快照也要定位启动器，而 engine 不能依赖原 drivers 模块；它是唯一越出包的 URL，登记为 `URL_EXCEPTIONS`（所有者 OSS-004，随 OSS-013 到期，与 `child_process` 例外一样读取 `TODO.md` 判断到期）。
- V9：`tool-command/entry.ts` 导出 `COMMAND_MCP_ENTRY`，`main.ts`、`tool-packages-main.ts` 与两个集成测试使用它。同一文件的 `LEGACY_COMMAND_MCP_ENTRY` 是迁移前的编译位置；准备 MCP 服务器时，等于它的参数改为当前入口（Windows 上不区分大小写），SQLite 中的记录不改写。集成测试在真实 Gateway 中登记与旧绑定相同的记录，重启后读回，确认记录未变、准备后的参数是新入口，并经它启动 command MCP 列出工具；去掉映射时该测试失败。该映射在 M1 删除。
- command MCP 服务器用 `node:child_process` 执行工具，是第四个 `child_process` 例外；`configuration/launch.ts` 不启动进程，不需要例外。
- SEA：command MCP 角色改为 `packages/agents/dist/src/tool-command/command-mcp.js`，`entry.mjs`、`build.mjs` 与 `measure.mjs` 同步。

第 8 步（runtime 与 V5）：

- `runtime/`、`process/`（含 F07 的 posix-tree、process-table、proc-scan 与 proc-scan-main）、`benchmark/`、`artifacts/` 与 application 的 service、workflows、observability 迁入 `packages/runtime/src/` 的同名目录；`drivers/configuration/probe.ts` 迁为 `process/probe.ts`。包依赖 core、store、agents 与 ajv；根包的 `ajv` 只剩一个单元测试使用，改为开发依赖。`src/` 只剩 daemon 与 cli 的部分（gateway、logging、worker、rollout 与入口）。
- 探测文件移入 `process/`，但仍导入 agents 中准备好的配置类型，而原 `process` 模块不能依赖 drivers；因此 `PACKAGE_ORIGINS` 支持单个文件的来源，`process/probe.ts` 按原 `drivers/configuration/probe.ts` 检查。
- `child_process`：runtime 的 `process/` 是 `ProcessLauncher` 实现的长期归属（02 第 8 节、10 第 2 节），边界检查以 `PROCESS_LAUNCHERS` 永久允许，不设期限；F08 再把范围收窄到启动器实现本身。runtime 的其他目录仍不允许。
- V5：`ProcessWorkerHost` 的 `workerEntry` 必填（文件 URL 或绝对路径），`main.ts` 传入 `new URL("./worker/main.js", import.meta.url)`，27 处测试构造与一个夹具使用 `tests/support/entries.ts` 的 `WORKER_ENTRY`。新集成测试用入口不同且不存在的宿主回收旧宿主写下的租约，确认租约按自己记录的 Worker 路径校验并回收；相对路径的入口被拒绝。
- Job 辅助程序的源码与构建脚本迁入 `packages/runtime/native/`，构建到本包的 `dist/native`；`windows-job.ts` 导出 `jobHelperPath()`，但不导入包内其他模块，因为一个 Windows 测试单独复制它来检查缺少辅助程序的情况，该测试改用 `import.meta.resolve` 取得编译后的文件。`probe.ts` 按相同层级自行计算路径；`start-local` 指向新位置；包内测试检查路径，并在 Windows 上检查文件存在。
- SEA：proc-scan 角色改为 `packages/runtime/dist/src/process/proc-scan-main.js`；`NATIVE_HELPERS` 中 Job 辅助程序移到 `packages/runtime/dist/native`，根 `dist/native` 不再允许任何文件，旧构建留下的辅助程序会使 SEA 构建失败。
