# 工具包与能力包

| 项 | 内容 |
|---|---|
| 分类 | 执行平面 |
| 状态 | 已实现 |
| 验证 | 单元测试（清单、导入、Windows 批处理转义）与集成测试（正式 Gateway 的导入、一键应用、替换与解绑，受控 CLI 经 MCP 在 Session 工作目录运行，不调用模型），本机 macOS arm64；经真实 cmd.exe 的用例只在 Windows 运行，开源版未单独验收；绑定后真实引擎调用这些工具未验证 |
| 对照 Magpie | HarnessHub 独有 |
| 权威文档 | [本地工具包](../../tool-packages.md)、[Capability Pack](../../capability-packs.md)、[原生 MCP](../../native-mcp.md) |

## 用途

把本机选好的 Skills、MCP 服务和命令行程序拷进 HarnessHub 自己的存储，校验每个文件的 hash，再一键写进所有兼容引擎的配置。能力包（Capability Pack）是这一用法的简称：只给一个目录或 JSON 文件和目标引擎，导入、生成清单、绑定与发布新 revision 都由 HarnessHub 完成。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | 工具（`/tools`）：列出已安装的包与使用它的引擎；导入目录或 JSON 文件（默认同时应用到全部引擎并替换旧版本）；把已安装的包应用到全部或所选引擎；解除绑定 |
| 命令行 | `hh tools --root <绝对存储目录> inspect\|install\|import\|list\|verify\|remove\|bind …`；结果为 stdout 上的 JSON，`bind` 只生成登记配置，不发 HTTP 请求 |
| HTTP | `GET /v1/tool-packs`、`POST /v1/tool-packs/import`、`POST /v1/tool-packs/apply`、`DELETE /v1/tool-packs/{id}/{version}/bindings` |

## 已实现的能力

- 完整包用 `tool-package.json`（`schemaVersion: 1`）列出每个文件的路径、大小与 SHA-256，以及 `skills`、`mcpServers`、`cliTools` 与秘密槽默认引用；未知字段或版本明确失败。
- 简易格式导入：Skill 目录（递归查找 `SKILL.md`）、MCP JSON（Claude Desktop/Cursor 的 `mcpServers` 或 VS Code 的 `servers`）、`cli.json`，或直接粘贴 `{"mcpServers":…}`（只能是远程服务）；版本默认 `auto-<内容指纹>`，内容不变时幂等。
- 导入拒绝启动时下载代码的命令（`npx`、`uvx`、`pipx`、`bunx`、`npm exec` 等）、只能从 PATH 查找的命令、导入目录外的文件与 PowerShell 脚本，所有问题合并为一个 `TOOL_PACKAGE_IMPORT_UNSUPPORTED`，不部分安装；像密钥的 env 值不保存，改为同名环境变量的引用并在 `warnings` 中说明。
- 安装逐文件稳定读取并真实拷贝，暂存目录再次全量校验后发布到 `objects/<digest>`；拒绝软链接、junction、多硬链接与未声明文件；同 id/version 不同内容为 `TOOL_PACKAGE_VERSION_CONFLICT`；存储目录用 `.mutation-lock` 防并发（冲突为 `TOOL_PACKAGE_BUSY`），POSIX 私有权限、Windows 私有 DACL。
- 绑定只写进引擎配置，没有第二份登记：Skill 路径与 stdio MCP 参数含 `objects/<digest>`，MCP 名为 `<id>-<name>`；同一版本再次应用先移除旧条目，已有其他版本默认 `TOOL_PACKAGE_BIND_CONFLICT`，`replace: true` 替换；超过单引擎 16 个 Skill 或 16 个 MCP 为 `TOOL_PACKAGE_ENGINE_CAPACITY`。
- `apply` 与带 `applyTo` 的 `import` 逐个引擎经 `prepareEngine` 校验后发布新 revision，结果为 `applied`、`skipped`（停用、演示引擎或不支持 MCP 注入）或 `failed`，单个引擎失败不回滚其他引擎；结果存入 SQLite 的引擎 overlay，重启后仍有效，已有 Session 继续用旧 revision。
- `cliTools`（至多 16 个）经受控的 Command MCP 暴露为 `cli_<name>` 工具：模型只能传有界的字符串 argv（至多 64 个、每个 4096 字符），`shell:false`，单次 30 秒，stdout 与 stderr 合计 256 KiB，工作目录为 Session 目录；Windows 的 `.cmd`/`.bat` 经 `cmd.exe /d /s /v:off /c` 并逐个参数加引号，含 `"`、`%` 或换行的参数被拒绝。
- 指向工作目录的值写成 `${HARNESSHUB_SESSION_WORKSPACE}`，由 Worker 启动服务时替换，同一 revision 可服务不同目录的 Session。
- 秘密槽经 `secretBindings` 绑定到 `env`、`file` 或系统凭证引用，只存引用；缺失时对应 Session 以 `SECRET_UNAVAILABLE` 启动失败。
- `remove` 只把登记标为 `removed`，保留对象与旧 revision 引用的路径；整个存储目录可以搬迁，搬迁后再次 bind 生成新路径。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [management.ts](../../../packages/agents/src/tool-packages/management.ts)、[manifest.ts](../../../packages/agents/src/tool-packages/manifest.ts)、[importer.ts](../../../packages/agents/src/tool-packages/importer.ts)、[store.ts](../../../packages/agents/src/tool-packages/store.ts)、[footprint.ts](../../../packages/agents/src/tool-packages/footprint.ts)、[bind.ts](../../../packages/agents/src/tool-packages/bind.ts)、[cli.ts](../../../packages/agents/src/tool-packages/cli.ts)、[tool-command/server.ts](../../../packages/agents/src/tool-command/server.ts)、[tool-package-routes.ts](../../../packages/daemon/src/http/tool-package-routes.ts)、[tool-packages-main.ts](../../../packages/daemon/src/tool-packages-main.ts) |
| 测试 | [tool-packages.test.ts](../../../tests/integration/tool-packages.test.ts)、[tool-pack-apply.test.ts](../../../tests/integration/tool-pack-apply.test.ts)、[tool-pack-gateway.test.ts](../../../tests/integration/tool-pack-gateway.test.ts)、[workspace-tools.test.ts](../../../tests/integration/workspace-tools.test.ts)、[tool-packages-import.test.ts](../../../tests/unit/tool-packages-import.test.ts)、[tool-packages-manifest.test.ts](../../../packages/agents/test/tool-packages-manifest.test.ts)、[command-mcp-windows-batch.test.ts](../../../packages/agents/test/command-mcp-windows-batch.test.ts)、[command-mcp-windows.test.ts](../../../tests/integration/command-mcp-windows.test.ts) |
| 决策 | [ADR 0013 第 4 节 工具包与控制台](../../decisions/0013-unified-model-gateway.md#4-工具包与控制台) |

## 已知限制与未验证

- hash 只检测内容改变，不是发布者签名或来源认证；包中代码的网络与文件权限由运行环境决定，没有沙箱。
- 运行期间 Worker 只校验启用的 `SKILL.md` 主文件 hash，附件与 MCP 实现文件不持续重算。
- 没有物理垃圾回收；手动删除对象会破坏旧会话引用；进程崩溃可能留下需要人工清理的锁目录。
- 命令行只负责单个引擎登记的绑定，不提供一键应用到全部引擎。
- 非 Kimi 的 CLI 引擎不接受 MCP 注入，只能使用包中的 Skill。

## 优化候选

- **现状**：工具包绑定到执行平面的引擎 revision，Agent 平面另有 Library 同步 Skills、MCP 与指令集，两套内容存储与界面并存。**方向**：已安装的包对象作为 Library 内容对象，绑定关系转为 Profile 中的 Library 选择，`/v1/tool-packs*` 并入 library。**依据**：[04 第 10 节](../../proposals/oss/04-agent-plane.md#10-与现状的差异与迁移)、[06 第 3 节](../../proposals/oss/06-interfaces.md#3-资源与端点清单)末尾的迁移说明。
- **现状**：`remove` 之后对象永远留在磁盘上。**方向**：回收没有登记且不被任何 revision 引用的对象，并清理崩溃留下的暂存目录。**依据**：[安装、验证、移除与搬迁](../../tool-packages.md#安装验证移除与搬迁)。
- **现状**：[工作区只读工具包](../../tool-packages.md#工作区只读工具包)一节仍写“发行 CLI 的 `tools install`、`tools use`”与 `runtime/node.exe`，而 `hh tools --help` 没有 `use` 命令。**方向**：改为当前的 `hh tools` 写法（`install` 后 `bind`，或经 HTTP `apply`）。**依据**：阅读文档与 `hh tools --help` 的观察。
- **现状**：包没有来源与签名信息。**方向**：清单声明 SPDX 许可证与发布者，安装时显示命令、URL 与秘密槽，按分级、签名与撤销机制管理。**依据**：[07 第 7 节](../../proposals/oss/07-data-security.md#7-插件与工具包的信任模型)。
