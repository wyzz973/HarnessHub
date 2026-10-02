# ADR 0017：多包布局迁移中的归属与接缝

Status: accepted

日期：2026-10-02
关联决定：[多包迁移计划](../proposals/oss/13-package-migration.md)、[02 第 8 节 模块与依赖规则](../proposals/oss/02-architecture.md#8-模块与依赖规则)、[10 第 1 节 仓库结构](../proposals/oss/10-engineering.md#1-仓库结构)、[开发规范的模块边界](../development.md#模块边界)

## 问题

OSS-004 把 `src` 迁入 12 个 pnpm workspace 包，要求行为不变、用例清单逐平台一致。现有代码有几处无法直接放进 02 第 8 节的依赖图：`platform`（Windows 文件 ACL 原语）同时被 artifacts 与 tool-packages 使用，两者迁移后分属 runtime 与 agents，而 platform 没有对应的包；`drivers/configuration/prepare.ts` 直接调用模型网关的 `startModelGateway`，而 agents 不能依赖 gateway；`process/worker-host.ts` 以相对 URL 派生 `worker/main.js`，迁移后这条路径跨越 runtime 与 daemon 两个包；子进程启动分散在 drivers/cli、secrets、platform、tool-command 与 probe 中，而目标是只由 runtime 的 `ProcessLauncher` 启动；已登记的引擎命令、`engines/*.example.json` 与 SQLite 中的工具包绑定保存了 `scripts/*.mjs` 与 `dist/src/drivers/tool-command/command-mcp.js` 的绝对路径，文件移动会让这些已保存的数据失效。包之间还需要一种导入方式，使迁移中途的类型检查、ESLint 与测试不依赖先构建出最新的 `.d.ts`。

## 决定

适用于 OSS-004 的整个迁移，按 [迁移计划](../proposals/oss/13-package-migration.md#5-步骤与对账) 的步骤落地：

1. **platform 放入 store**：`platform/*` 移到 `packages/store/src/platform/`，ACL 辅助程序源码随之移入 store。runtime（artifacts）与 agents（tool-packages）都可以依赖 store，因此不需要新增包或反向依赖。它被记录为 Windows 文件原语的临时位置，`ProcessLauncher` 或平台层落地时重新评估。
2. **通配导出加源码条件**：每个包导出 `"./*": {"@harnesshub/source": "./src/*.ts", "types": "./dist/src/*.d.ts", "default": "./dist/src/*.js"}`，`tsconfig.base.json` 设置 `customConditions: ["@harnesshub/source"]`。TypeScript 与 ESLint 直接解析依赖包的源码，Node 运行时使用编译产物。公开面暂不收窄，以后由 API Extractor 报告约束；依赖方向由边界检查按 02 的依赖图约束。
3. **注入模型网关工厂**：`ModelGateway`、`ModelGatewayOptions`、`ModelCallRecord`、`InboundProtocol` 移到 `core/model-bridge.ts`；`PreparationHooks` 新增可选的 `startModelGateway`，由 daemon 的 Worker 入口与组合根（配置探测路径）注入。准备过程需要模型路由而调用方没有注入时，抛出具名 HubError，不静默跳过网关。M1 把网关移入 daemon 时沿用同一接缝。
4. **临时 `child_process` 例外**：drivers/cli、secrets、store/platform 与 agents/tool-command 暂时保留各自的 `child_process` 调用；probe.ts 移入 runtime。例外写在边界检查的允许表中，每项带所有者 OSS-010 F08 与期限 M0 退出（OSS-013）。期限到达时 `ProcessLauncher` 接口在 core、实现在 runtime、由 daemon 注入，例外随之删除。
5. **注入 Worker 入口**：Worker 宿主新增必填选项 `workerEntry`；daemon 传入自己的 `new URL("./worker/main.js", import.meta.url)`，测试从 `tests/support/entries.ts` 取得 `WORKER_ENTRY`。租约保存自己的 `workerPath`，迁移前创建的租约继续按其记录校验。OSS-008 之前 Worker 仍按路径派生。
6. **运行时资源留在 `scripts/`**：`launch-engine.mjs`、`spawn-engine.mjs`、`launch-{dsh,openclaw,opencode,pi}-acp.mjs` 与 `native-mcp/pi-extension.mjs` 在 OSS-004 期间不移动，仓库工具移到 `tools/`。agents 只通过 `agents/configuration/launch.ts` 中唯一的 `repositoryScript(name)` 定位这些文件；这一越出包的相对 URL 是归 OSS-004 所有的例外，资源以后带旧路径别名迁移时删除。
7. **映射已保存的旧 command-mcp 路径**：`tool-packages/bind.ts` 把 `command-mcp.js` 的绝对路径写入工具包绑定的 MCP 参数并保存在 SQLite 中。agents 导出 `COMMAND_MCP_ENTRY`；prepare 在启动前把旧位置 `dist/src/drivers/tool-command/command-mcp.js` 映射到当前入口，其他路径原样保留，并以测试固定这一行为。该映射在 M1 删除。

## 考虑过的替代方案

- platform 单独成包或放入 core：单独成包会在 02 固定的 12 个包之外增加第 13 个；core 不依赖任何包、不承载操作系统实现，而 ACL 原语需要启动辅助程序。
- 每个文件单独列出导出、或只解析编译产物的 `types`：逐文件导出在迁移期间每步都要维护长列表，且公开面应由 API 报告而不是手写列表决定；只用 `types` 要求依赖包先构建，编辑器与 ESLint 在构建前会看到过期的声明。
- 让 agents 依赖 gateway，或把网关钩子设为必填：前者违反 02 的依赖图；必填会迫使所有不需要模型路由的 prepare 调用方（测试、探测）构造网关。
- 在迁移前先完成 F08 的 `ProcessLauncher`：迁移会被一项行为改动阻塞，而本次迁移的前提是只移动不改变行为。
- 继续用跨包相对 URL 定位 Worker，或经 `@harnesshub/daemon` 解析：前者让 `new URL` 离开所在包，后者让 runtime 反向依赖 daemon。
- 现在就把运行时资源移入 agents：已登记引擎命令与示例配置中保存的绝对路径会立即失效，而旧路径别名机制尚未建立。
- 改写 SQLite 中已保存的路径，或在旧位置保留一个转发文件：前者是一次修改用户数据的迁移，超出“只移动”的范围；旧的根 `dist/src` 在第 9 步整体消失，转发文件无处可放。

## 后果

store 暂时包含与存储无关的 Windows 文件原语，命名与职责不完全一致，需在平台层设计时收回。通配导出让任何文件都可被跨包导入，直到 API Extractor 报告接入（OSS-005 之后）前，只有依赖图约束包之间的方向。四处 `child_process` 例外与 `repositoryScript` 例外在期限前继续存在；F08 未在 OSS-013 前完成会阻塞 M0 验收。旧 command-mcp 路径映射是一条只为已保存数据保留的兼容路径，M1 删除时必须同时确认工具包绑定已由 Library 取代。`workerEntry` 改为必填后，所有构造 Worker 宿主的地方（含测试）都要显式提供入口。

重新评估条件：`ProcessLauncher` 或平台层落地；API Extractor 接入；运行时资源的旧路径别名机制建立；M1 的 Library 取代工具包绑定。

## 验证要求

- 每一步在 Linux、macOS、Windows 的 CI 中 `pnpm check` 通过，且与上一步相比用例清单（`compare-inventory`）没有差异，第 11 步只有预先列出的新增。
- 边界检查对以下情况各有拒绝样例：越出包的相对导入与 `new URL`、依赖图之外的 `@harnesshub/*` 导入、允许表之外或已过期的 `child_process`。
- 未注入网关钩子而需要模型路由时得到具名 HubError；注入后行为与迁移前一致（单元测试）。
- 未提供 `workerEntry` 时无法构造 Worker 宿主；迁移前创建的租约仍然通过校验（测试）。
- 旧的 command-mcp 路径被映射到 `COMMAND_MCP_ENTRY`，其他路径不变（测试）。
- 每个包的原生辅助程序路径常量指向实际存在的文件（各包测试）；`scripts/` 中的运行时资源仍可由已登记的引擎命令启动（现有 Windows 启动与引擎发现测试）。
