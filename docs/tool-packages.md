# 本地便携工具包

工具包将显式选择的本地 MCP stdio 服务和 Skills 拷贝到 HarnessHub 的独立目录，并生成现有引擎配置。包管理器不下载依赖、不运行 npm/pip 安装命令或生命周期脚本、不启动 MCP 服务、不调用模型，也不改用户全局 MCP 配置。所有 Node MCP 依赖必须提前放进包目录并列入清单；启动使用发行包注入的唯一 Node 可执行文件。

本功能是工具文件管理及配置映射。引擎的登录、模型服务可用性和是否支持 MCP 仍由既有 Driver 能力契约决定。启用 MCP 的包可以绑定支持该能力的 ACP 引擎；Pi/OpenClaw 通过专用原生入口，Kimi CLI 通过独立 MCP 文件接收配置，秘密引用和原生审批限制见 [原生 MCP](native-mcp.md)。其他 CLI Driver 明确拒绝统一 MCP 注入。纯 Skill 包可用于现有配置支持的引擎。包中代码的实际网络权限由运行环境决定，本模块不提供网络沙箱，也不会将任意 MCP 代码解释成安全代码。发行中的内置文件工具可只提供本地读取功能。

## 清单与相对路径

每个源目录必须有 `tool-package.json`。版本字段 `schemaVersion` 当前只接受 `1`；字段类型的权威定义为 [types.ts](../src/tool-packages/types.ts)，运行时 schema 与语义校验为 [manifest.ts](../src/tool-packages/manifest.ts)。未知字段或版本明确失败，没有隐式迁移。实际可安装样例为 [portable-review](../examples/tool-packages/portable-review/tool-package.json)，包含一个 SKILL.md 和相对路径引用的附件。

清单使用以下字段：

| 字段            | 含义                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `schemaVersion` | 当前固定为 `1`                                                                                       |
| `id`            | 以小写字母开头，最多 32 个小写字母、数字或连字符                                                     |
| `version`       | 以字母或数字开头，最多 64 个字母、数字、点、下划线或连字符；版本按完整字符串标识，不解释 SemVer 范围 |
| `displayName`   | 最多 128 个字符的本地显示名称                                                                        |
| `files`         | 除清单本身外的所有文件：`path`、字节数 `size`、小写十六进制 `sha256`，以及可选的 `executable`        |
| `skills`        | 可选的 `{path}` 数组，每项指向已声明且文件名为 `SKILL.md` 的文件                                     |
| `mcpServers`    | 可选的本地 stdio 服务声明，见下文                                                                    |

所有文件路径使用 `/` 分隔的相对路径，最多 1,024 个字符、64 层。绝对路径、盘符、UNC、反斜杠、父目录、空段、Windows 保留名称/ADS/末尾点空格、大小写或 Unicode 归一化后的别名均被拒绝。清单不能列出自身，文件不能兼作目录。实际目录只能包含声明文件及其必要父目录；未声明文件、空目录、符号链接、junction、其他非普通文件和多硬链接文件均被拒绝。源目录、存储目录及其祖先也不能经过链接。

单包最多 10,000 个文件、20,000 个目录、256 MiB 内容，单文件最多 128 MiB，清单最多 4 MiB。每包最多 16 个 Skill 和 16 个 MCP 服务；SKILL.md 必须是有效 UTF-8，单文件最多 64 KiB，合计最多 256 KiB。原生可执行文件必须声明 `executable:true`，在 POSIX 系统源文件还须具备所有者执行权限。

MCP 声明包含 `name`、`launch`、`entry` 以及可选的 `args`、`env`、`secretEnv`。`launch` 为 `node` 时，`entry` 是包内 Node 脚本，生成命令是调用方注入的绝对 Node 路径；`launch` 为 `native` 时，生成命令直接指向包内标记为可执行的文件。`entry` 必须已声明在 `files` 内。服务名最多 31 个字母、数字、下划线或连字符，首字符为字母或数字；生成的 MCP 名称为 `<包 id>-<服务 name>`。

参数使用独立 argv，永不拼接 shell 表达式。普通字符串是原样参数；`{"anchor":"package","path":"相对路径"}` 指向清单已声明的文件或其父目录；`{"anchor":"workspace"}` 指向本次明确指定的工作区目录。Node 服务最多 127 个附加参数，原生服务最多 128 个。需要随发行目录搬迁的路径应使用锚点，不应藏在普通字符串里。工作区路径在绑定时固定，换工作区需重新绑定。

`env` 是最多 32 项的普通环境变量，遵守现有配置的进程控制变量和敏感字段限制。`secretEnv` 将目标环境变量映射为逻辑槽名称，例如 `{"API_KEY":"myServiceKey"}`；安装时没有宿主凭证引用。绑定时调用方通过单独 JSON 或 API 参数显式提供 `{"myServiceKey":{"kind":"env","value":"MY_SERVICE_KEY"}}`。还支持既有 `file` 绝对路径引用和 `keychain` 凭证 ID。槽必须完整且无多余项，引用不在本模块中解析，凭证值不进入包清单。

## 安装、验证、移除与搬迁

源目录内容按逐文件稳定读取的字节进行真实拷贝。Windows 使用 native 文件共享锁拒绝并发写句柄；所有平台验证文件/目录身份、单硬链接、字节数和 SHA-256。拷贝后的暂存目录再次进行全量验证，成功后发布到 `objects/<digest>`，再原子替换登记记录。`digest` 是键排序、文件列表排序后的规范化清单 SHA-256，清单包含全部内容 hash；JSON 排版和对象键顺序不影响身份。

存储目录在 Windows 配置当前用户及系统/管理员的私有 DACL，在 POSIX 要求私有权限。登记位于 `records/<身份 hash>.json`，包含 `schemaVersion/id/version/digest/installedAt/status`。同一 id/version 和 digest 重装幂等；同一 id/version 的不同内容明确报版本冲突。已有对象损坏时拒绝安装和使用，不静默覆盖或修复。hash 校验检测内容改变，不等于发布者签名或来源认证，应只导入用户选择的可信代码。

`list` 只读取登记状态，适合快速列出包；`verify` 与 `bind` 都读取并验证整个已安装包的每个文件。`remove` 只将登记标记为 `removed`，禁止生成新绑定，保留所有 `objects` 及旧引擎 revision 仍引用的路径；重复移除幂等。本轮没有物理垃圾回收功能，手动删除对象会破坏旧会话引用。相同源版本可再次安装以恢复登记。

包管理 API 不修改已发布对象。当前用户在外部仍能编辑文件，后续 verify/bind 会发现与登记或清单不符的内容。Worker 的现有运行契约只在执行时校验启用的 SKILL.md 主文件 hash；附件与 MCP 实现文件不会被 Worker 持续重算全量 hash。不得把安装/绑定验证描述为运行期间对整个工具包的持续完整性防护。

存储使用 `.mutation-lock` 防止并发安装/移除。冲突立即报 `TOOL_PACKAGE_BUSY`，不会等待、自动重试或按 PID 猜测恢复。正常完成会等待文件句柄和 native helper 退出后释放锁。进程崩溃可能留下锁、暂存目录或未登记对象；先核实 `owner.json` 对应操作已停止，再由操作者显式清理该精确锁目录。未登记对象不会自动投入使用，暂不自动 GC。

源目录删除或变更不影响已安装副本。整个存储目录可以真实复制或搬到新位置，包清单和登记不含宿主绝对路径；搬迁后再次 bind 生成新绝对路径和引擎 revision。已经生成的旧 registration/旧会话不会自动重写，保留它们需要保留原对象路径，或者为后续会话显式应用新 registration。

## 可脚本化 CLI

开发仓库先完成构建，使用当前 Node 运行 [组合入口](../src/tool-packages-main.ts)。`--root` 必须是第一项，后跟显式绝对存储目录，其余参数交给工具模块。成功向 stdout 输出 JSON；失败向 stderr 输出带 `code/message` 的 JSON 并返回非零状态。调用者负责选择是否保存或提交返回的引擎配置。

```powershell
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages inspect --source C:\HarnessHub\examples\tool-packages\portable-review
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages install --source C:\HarnessHub\examples\tool-packages\portable-review
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages list
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages verify --id portable-review --version 1.0.0
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages bind --id portable-review --version 1.0.0 --engine C:\HarnessHub\registration.json --workspace C:\Projects\example
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages remove --id portable-review --version 1.0.0
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages list --include-removed
```

`bind` 可加 `--bindings <绝对 JSON 文件路径>`。`--engine` 输入完整 [EngineRegistration](../src/domain/engines.ts)，而不是包含 capabilities/revision 的引擎响应对象。结果为 `{registration,revision,package:{id,version}}`。生成的 `registration` 已调用既有 `prepareEngine` 校验及固定 Skill hash，可通过已有 `PUT /v1/engines/:id` 应用。同内容重复绑定幂等；同 Skill 路径或 MCP 名称已有不同配置时明确报冲突。命令不会写回输入文件或发送 HTTP 请求。多个包可依次对上一次返回的 registration 绑定，仍受单引擎既有数量与能力限制。

## 工作区只读工具包

[workspace-tools](../examples/tool-packages/workspace-tools/tool-package.json) 是零依赖 Node 示例，提供 `workspace_list`、`workspace_read`、`workspace_search` 三个本地工具及附带 Skill。先运行发行 CLI 的 `tools install --source <workspace-tools 目录的绝对路径>`，再运行 `tools use workspace-tools 1.0.0 --engine <支持 MCP 的引擎 id>`。绑定会将发行 Node 和选定工作区作为明确的绝对参数传给服务；它不下载、不写工作区、不启动子进程，也不访问网络。

该服务按 [MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[握手生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) 和 [工具协议](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 实现 UTF-8 逐行 JSON-RPC，支持 initialize、initialized 通知、ping、tools/list、tools/call；支持 2025-11-25、2025-06-18、2025-03-26、2024-11-05 的握手版本，未实现 2026 新版传输。未知版本会返回本服务支持的 2025-11-25，由客户端决定是否继续。文件访问和参数错误返回 `isError:true`，协议方法错误使用 JSON-RPC error。stdout 只输出协议 JSON，EOF 关闭进程；SIGINT/SIGTERM 停止读取并等待当前文件句柄关闭。

输入路径使用 `/` 相对路径，根目录用 `.`。`workspace_list` 参数是 `{path}`；`workspace_read` 使用 `{path,startLine?,maxLines?}`，行号从 1 开始，默认读取 100 行，最多 200 行；`workspace_search` 使用 `{path,query,maxResults?}`，query 是区分大小写的字面文本，默认最多 50 个结果，上限 100。结果明确包含 `truncated`，搜索另有 `skipped`，不能把截断结果描述为完整扫描。

单文件上限 1 MiB，只读有效 UTF-8 文本；读取内容最多 16,384 个字符。单目录最多 500 项，搜索最多访问 2,000 项、读取 8 MiB、合作式执行 5 秒，跳过 `.git`、`node_modules`、`.tools` 目录。单消息上限 64 KiB、已接收缓冲上限 128 KiB、响应上限 256 KiB，请求串行处理以形成流量背压。目录链接在列表中标记 blocked，显式读链接、硬链接、越界路径及 Windows 路径别名均失败。读取前后验证文件和目录身份，变化时不返回文件内容；该纯 Node 工具不具有 artifact collector 的 Windows 原生排他读锁，不宣称防御同一用户持续恶意替换文件的竞态。

同一 [脚本](../examples/tool-packages/workspace-tools/workspace-tools.mjs) 可直接用于 CLI，不依赖 MCP 或模型。以下命令从开发仓库运行，发行中使用 `runtime/node.exe` 及已安装副本的脚本路径：

```powershell
node examples/tool-packages/workspace-tools/workspace-tools.mjs --root C:\Projects\example list '{"path":"."}'
node examples/tool-packages/workspace-tools/workspace-tools.mjs --root C:\Projects\example read '{"path":"src/main.ts","startLine":1,"maxLines":40}'
node examples/tool-packages/workspace-tools/workspace-tools.mjs --root C:\Projects\example search '{"path":"src","query":"TODO","maxResults":20}'
```

不支持 MCP 的引擎不能用 `tools use` 将此包的 MCP 部分强行启用；可在现有引擎配置中只选择安装副本的 SKILL.md，或让具备终端能力的引擎在已授权工作区调用上述 CLI。成功输出 JSON，失败退出码为 1。安装校验和真实 stdio/CLI 检查在 [workspace-tools.test.ts](../tests/integration/workspace-tools.test.ts) 中执行，不调用模型。

## 模块接口

统一导出为 [index.ts](../src/tool-packages/index.ts)，CLI 上下文为 [cli.ts](../src/tool-packages/cli.ts)。所有 I/O 接口是 Promise，失败 reject；每次调用自行拥有并等待关闭文件/native helper，不需要调用者额外 close。参数中的源目录、存储根、Node 可执行文件、工作区、JSON 文件必须为绝对路径。

| 接口                                        | 输入与结果                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseManifest(input)`                      | 同步验证 unknown 声明，返回 `{manifest,digest,fileCount,totalBytes}`；不读文件                                                                              |
| `inspectLocal(source)`                      | 全量验证明确的本地源目录，返回 inspection，不执行内容                                                                                                       |
| `installLocal(source, root)`                | 真实拷贝及原子登记，返回 inspection 加 `record`                                                                                                             |
| `listInstalled(root, {includeRemoved?})`    | 默认仅已安装登记；不存在的存储返回空数组；不全量读内容                                                                                                      |
| `verifyInstalled(root, id, version)`        | 全量验证已安装对象并返回 inspection 加 `record`；removed 不可验证为可用安装                                                                                 |
| `removeInstalled(root, id, version)`        | 软注销，返回 removed 记录，保留内容对象                                                                                                                     |
| `bindInstalled(root, id, version, options)` | options 为 `{nodeExecutable,workspace,secretBindings?}`；全量验证并返回 `{skills,mcpServers}`；调用者仍须通过 prepareEngine 检查最终引擎配置                |
| `runToolPackageCli(argv, context)`          | argv 从命令开始；context 为 `{root,nodeExecutable,workspace?,prepareEngine}`；prepareEngine 由组合根注入；返回上述命令 JSON，不自行打印或持久化用户引擎配置 |

主要错误包括 `INVALID_TOOL_PACKAGE`、`INVALID_TOOL_PACKAGE_PATH`、`TOOL_PACKAGE_CONTENT_MISMATCH`、`TOOL_PACKAGE_TOO_LARGE`、`TOOL_PACKAGE_INTEGRITY`、`TOOL_PACKAGE_CHANGED`、`TOOL_PACKAGE_VERSION_CONFLICT`、`TOOL_PACKAGE_REGISTRY_CORRUPT`、`TOOL_PACKAGE_NOT_FOUND`、`TOOL_PACKAGE_BUSY`、`INVALID_TOOL_PACKAGE_BINDING`、`TOOL_PACKAGE_BIND_CONFLICT`、`INVALID_TOOL_PACKAGE_ARGUMENT`。系统 I/O、权限和既有引擎校验错误保持失败，不转为空结果或尝试联网补齐。
