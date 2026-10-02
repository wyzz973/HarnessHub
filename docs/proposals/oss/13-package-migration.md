# 13 多包迁移计划（OSS-004）

状态：已采纳（2026-10-02，AI 维护者），作为 [TODO](../../../TODO.md) 中 OSS-004 的执行计划。目标结构以 [02 第 8 节](02-architecture.md#8-模块与依赖规则) 与 [10 第 1 节](10-engineering.md#1-仓库结构) 为准；本文的取舍及理由记录在 [ADR 0017](../../decisions/0017-package-layout-migration.md)。调研基于 `b0f0b88`，本文数字按 `main` 的 `b5ee7b4` 更新。文中的 `packages/`、`apps/`、`tools/` 路径、`@harnesshub/*` 包名与新增文件都是计划名称，在对应步骤合入之前不存在。

迁移只改变文件位置、包边界和构建方式，不改变行为。测试随代码迁移，断言不放宽；每一步在每个平台上的用例清单与上一步相比，只允许测试文件位置不同。

## 1. 现状

`src` 有 105 个源文件。测试有单元 38 个、集成 42 个、smoke 3 个文件，另有 16 个 fixture 与 2 个支持文件；`scripts/` 下有 14 个工具测试文件。模块之间的导入（不含模块内部导入）：

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

`tools/`：`scripts/` 下的仓库工具全部移入，包括 `check-*` 及其测试、`run-tests`、`lib/`、`build-*`、`clean-build`、`build-info`、`generate-api-docs`、`console`、`start-local`、`mock-chat-provider`、`strict-chat-proxy`、`compare-inventory` 等。`scripts/` 只保留已登记引擎命令与 `engines/*.example.json` 中以绝对路径保存的运行时文件：`launch-engine.mjs`、`spawn-engine.mjs`、`launch-{dsh,openclaw,opencode,pi}-acp.mjs`、`native-mcp/pi-extension.mjs`；`cross-spawn` 因此仍是根依赖。

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

对账方法：测试启动器以 `--inventory` 写出每组用例清单（组名、测试文件名、名称路径、状态），CI 在 `pnpm check` 中设置 `HARNESSHUB_TEST_INVENTORY_DIR` 并按平台上传 `test-inventory-<os>` 构件；用 [`compare-inventory.mjs`](../../../scripts/compare-inventory.mjs) 按平台比较上一步与本步的清单，它忽略文件位置，按组名、名称路径与状态计数匹配。每一步差异必须为空；第 11 步的新 smoke 测试经 `--allow` 列为唯一的预期新增。工具用法见 [测试要求](../../testing.md#测试可靠性)。

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
