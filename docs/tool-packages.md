# 本地便携工具包

工具包将显式选择的本地 Skills、MCP 服务声明和 CLI 程序拷贝到 HarnessHub 的独立目录，并生成现有引擎配置。包管理器不下载依赖、不运行 npm/pip 安装命令或生命周期脚本、不启动 MCP 服务、不调用模型，也不改用户全局 MCP 配置。所有 Node MCP 依赖必须提前放进包目录；启动使用发行包注入的唯一 Node 可执行文件。除完整清单 `tool-package.json` 外，也可以直接导入 Skill 目录、`mcp.json` 和 `cli.json`，由 HarnessHub 生成清单，见 [简易格式导入](#简易格式导入)。

本功能是工具文件管理及配置映射。引擎的登录、模型服务可用性和是否支持 MCP 仍由既有 Driver 能力契约决定。启用 MCP 的包可以绑定支持该能力的 ACP 引擎；Pi/OpenClaw 通过专用原生入口，Kimi CLI 通过独立 MCP 文件接收配置，秘密引用和原生审批限制见 [原生 MCP](native-mcp.md)。其他 CLI Driver 明确拒绝统一 MCP 注入。纯 Skill 包可用于现有配置支持的引擎。包中代码的实际网络权限由运行环境决定，本模块不提供网络沙箱，也不会将任意 MCP 代码解释成安全代码。发行中的内置文件工具可只提供本地读取功能。

## 清单与相对路径

完整包目录有 `tool-package.json`。版本字段 `schemaVersion` 当前只接受 `1`；字段类型的权威定义为 [types.ts](../src/tool-packages/types.ts)，运行时 schema 与语义校验为 [manifest.ts](../src/tool-packages/manifest.ts)。未知字段或版本明确失败，没有隐式迁移。实际可安装样例为 [portable-review](../examples/tool-packages/portable-review/tool-package.json)，包含一个 SKILL.md 和相对路径引用的附件。

清单使用以下字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 当前固定为 `1` |
| `id` | 以小写字母开头，最多 32 个小写字母、数字或连字符 |
| `version` | 以字母或数字开头，最多 64 个字母、数字、点、下划线或连字符；版本按完整字符串标识，不解释 SemVer 范围 |
| `displayName` | 最多 128 个字符的本地显示名称 |
| `files` | 除清单本身外的所有文件：`path`、字节数 `size`、小写十六进制 `sha256`，以及可选的 `executable`；只声明远程 MCP 的包可以为空数组 |
| `skills` | 可选的 `{path}` 数组，每项指向已声明且文件名为 `SKILL.md` 的文件 |
| `mcpServers` | 可选的本地 stdio 服务或远程 HTTP/SSE 端点声明，见下文 |
| `cliTools` | 可选的受控 CLI 程序，见 [Capability Pack](capability-packs.md) 与下文 [CLI 工具与 Windows 批处理](#cli-工具与-windows-批处理) |
| `defaultSecretBindings` | 可选；秘密槽的默认引用 `{"槽":{"kind":"env","value":"变量名"}}`，只允许环境变量名 |

所有文件路径使用 `/` 分隔的相对路径，最多 1,024 个字符、64 层。绝对路径、盘符、UNC、反斜杠、父目录、空段、Windows 保留名称/ADS/末尾点空格、大小写或 Unicode 归一化后的别名均被拒绝。清单不能列出自身，文件不能兼作目录。实际目录只能包含声明文件及其必要父目录；未声明文件、空目录、符号链接、junction、其他非普通文件和多硬链接文件均被拒绝。源目录、存储目录及其祖先也不能经过链接。

单包最多 10,000 个文件、20,000 个目录、256 MiB 内容，单文件最多 128 MiB，清单最多 4 MiB。每包最多 16 个 Skill、16 个 MCP 服务和 16 个 CLI 工具；含 CLI 工具时 MCP 服务最多 15 个，因为 CLI 工具共用一个受控 MCP 服务。SKILL.md 必须是有效 UTF-8，单文件最多 64 KiB，合计最多 256 KiB。原生可执行文件必须声明 `executable:true`，在 POSIX 系统源文件还须具备所有者执行权限。

本地 MCP 声明包含 `name`、`launch`、`entry` 以及可选的 `args`、`env`、`secretEnv`。`launch` 为 `node` 时，`entry` 是包内 Node 脚本，生成命令是调用方注入的绝对 Node 路径；`launch` 为 `native` 时，生成命令直接指向包内标记为可执行的文件。`entry` 必须已声明在 `files` 内。服务名最多 31 个字母、数字、下划线或连字符，首字符为字母或数字；生成的 MCP 名称为 `<包 id>-<服务 name>`。

远程 MCP 声明为 `{name,type,url,headers?,secretHeaders?}`，`type` 为 `http`（Streamable HTTP）或 `sse`。URL 必须是不含用户名、密码、查询串和片段的 HTTP(S) 地址；名称像密钥（KEY、TOKEN、SECRET、PASSWORD、AUTHORIZATION、COOKIE）或值像凭证的请求头只能放在 `secretHeaders`，它把请求头映射到秘密槽。远程服务不拷贝文件，是否可达由运行环境决定。

参数使用独立 argv，永不拼接 shell 表达式。普通字符串是原样参数；`{"anchor":"package","path":"相对路径"}` 指向清单已声明的文件或其父目录；`{"anchor":"workspace"}` 表示当前 Session 的工作目录，绑定时写成占位符，见 [会话工作目录占位符](#会话工作目录占位符)。Node 服务最多 127 个附加参数，原生服务最多 128 个。需要随发行目录搬迁的路径应使用锚点，不应藏在普通字符串里。

`env` 是最多 32 项的普通环境变量，遵守现有配置的进程控制变量和敏感字段限制。`secretEnv` 与 `secretHeaders` 将目标环境变量或请求头映射为逻辑槽名称，例如 `{"API_KEY":"myServiceKey"}`；清单中没有宿主凭证值。绑定时每个槽依次取调用方提供的 `secretBindings`（例如 `{"myServiceKey":{"kind":"env","value":"MY_SERVICE_KEY"}}`，也支持 `file` 绝对路径和 `keychain` 凭证 ID），再取清单的 `defaultSecretBindings`；两者都没有时绑定失败，`secretBindings` 中出现未声明的槽也失败。引用只在所属 Worker 准备 Session 时解析；环境变量缺失或为空时，该 Session 以 `SECRET_UNAVAILABLE` 启动失败。

## 会话工作目录占位符

按 [ADR 0013](decisions/0013-unified-model-gateway.md#会话工作目录占位符)，绑定不再写死工作区绝对路径。凡是指向工作目录的值都写成字面量 `${HARNESSHUB_SESSION_WORKSPACE}`：清单参数 `{"anchor":"workspace"}`；导入时 MCP 参数或 env 值中的 `${workspaceFolder}`（及旧名 `${workspaceRoot}`）；受控 CLI 服务 `<id>-cli` 的工作目录参数 `--workspace ${HARNESSHUB_SESSION_WORKSPACE}`。同一个引擎 revision 因此可以服务于不同目录的 Session。

Worker 准备 Session 的 MCP 时，必须把 stdio 服务 `args` 和 `env` 值中出现的每一处占位符替换为该 Session 的实际目录（比赛中即评测方传入的 `directory`），再交给 ACP 或原生适配器。替换位于 [prepare.ts](../src/drivers/configuration/prepare.ts)，由 Worker 配置任务交付，本页只定义契约。没有替换时，受控 CLI 服务和 [simple-toolkit](../examples/tool-packages/simple-toolkit/mcp.json) 示例服务都以 “placeholder was not substituted” 明确失败，不会退回进程当前目录。

CLI 声明里的工作区参数在 `HHCAP_CLI_TOOLS_JSON` 环境值中保持结构化的 `{"anchor":"workspace"}`，由受控 CLI 服务按自己的 `--workspace` 解析；该 JSON 中不允许出现占位符字面量，因为按字符串替换会破坏 Windows 路径在 JSON 中的转义。本变更之前发布的 revision 仍在 `HHCAP_CLI_WORKSPACE` 中带有当时的绝对工作区，受控 CLI 服务继续兼容读取；再次应用同一版本即可换成占位符。

## 简易格式导入

`POST /v1/tool-packs/import`、`Install-Tool-Pack.cmd`、CLI `import` 命令和模块函数 `importLocal` 使用同一规则，实现为 [importer.ts](../src/tool-packages/importer.ts)。`source` 必须是本机绝对路径，可以是目录或文件：

| 输入 | 处理 |
| --- | --- |
| 含 `tool-package.json` 的目录或该文件本身（`kind` 为 auto） | 原样安装并逐文件校验 hash；此时不能再指定 id、version 或 displayName |
| Skill 目录 | 递归查找名为 `SKILL.md` 的文件，跳过符号链接、`.git`、`node_modules` 等目录；每个 SKILL.md 所在目录连同资源文件是一个 Skill。也可以直接给出一个 `SKILL.md` 文件 |
| MCP JSON | 目录根的 `mcp.json`、`.mcp.json`、`.vscode/mcp.json`、`.cursor/mcp.json`、`claude_desktop_config.json`，或直接给出的 JSON 文件；支持 Claude Desktop/Cursor 的 `{"mcpServers":{...}}` 和 VS Code 的 `{"servers":{...}}` |
| CLI 清单 | 目录根的 `cli.json` 或直接给出的文件：`{"cliTools":[{"name","description","entry","launch","args"}]}`，`entry` 相对清单所在目录，`launch` 省略时按扩展名推断 |

`kind` 取 `auto`（默认，按内容识别，允许在一个目录中混合 Skills、MCP JSON 和 `cli.json`）、`skills`、`mcp` 或 `cli`。JSON 必须是严格 UTF-8 JSON，允许 BOM，不支持注释和尾逗号。仓库中的 [simple-toolkit](../examples/tool-packages/simple-toolkit/cli.json) 是一个同时包含 Skill 目录、`mcp.json` 和 `cli.json` 的示例。

MCP 服务按以下规则转换：

- `command` 为 `node` 时，第一个参数必须是导入目录内的脚本，改用发行包自带的 Node 启动，不支持 Node 选项。其他命令可以写成相对 JSON 所在目录的路径，或写成该目录中存在的文件名；`.js`、`.mjs`、`.cjs` 用 Node 启动，其余按原生可执行文件启动并自动标记 `executable`。
- `npx`、`pnpx`、`bunx`、`uvx`、`pipx`，以及 `npm exec/x`、`pnpm dlx/exec`、`yarn dlx`、`bun x`、`uv tool/run` 会在服务启动时下载代码，离线环境不可用，因此明确拒绝。请先把服务安装进导入目录（例如 `node_modules`），再用 `node` 加相对脚本路径启动。只能从 PATH 查找的命令、导入目录外的文件、`cwd`、`envFile` 和 PowerShell 脚本同样拒绝。一次导入发现的全部问题合并在一个 `TOOL_PACKAGE_IMPORT_UNSUPPORTED` 错误中返回，不会部分安装。
- 参数中的 `${workspaceFolder}` 转为会话工作目录；以 `./`、`../` 开头或为绝对路径、且指向导入目录内文件或目录的参数转为包内路径锚点；其他字符串原样保留。形如 `--config=./x` 的组合参数不转换，路径请单独成项。
- `env` 名称必须是大写环境变量名。名称像密钥（KEY、TOKEN、SECRET、PASSWORD、PASSWD、AUTH、COOKIE、CREDENTIAL、PRIVATE）或值像凭证（`sk-`、`ghp_`、`Bearer `）的变量不保存值，改为 `secretEnv`，默认引用同名环境变量；值为 `${env:NAME}`、`${input:id}` 或 `${NAME}` 时引用对应的环境变量。远程请求头按同样规则进入 `secretHeaders`，默认环境变量名由请求头名转成大写下划线形式，例如 `Authorization` 对应 `AUTHORIZATION`，该变量需包含完整请求头值。响应的 `warnings` 逐项说明这些转换。
- 远程 `type` 支持 `http`、`streamable-http`、`sse`；只写 `url` 时按 `http`。`disabled:true` 的服务不导入；`autoApprove` 等客户端专用字段被忽略并给出警告。

拷贝范围：只有 Skill 时拷贝各 Skill 目录，不含其中的 `node_modules`；包含本地 MCP 或 CLI 程序时拷贝整个导入目录，包括 `node_modules`，因为程序可能依赖其中任意文件。被解释的 JSON 配置文件、根目录的 `tool-package.json`、`.env` 和 `.env.*`、`.git`/`.hg`/`.svn`/`.vscode`/`.cursor`/`.idea` 目录、系统元数据文件和符号链接始终不拷贝，其中环境文件和链接会给出警告，因此配置中的秘密值不会进入存储。多硬链接文件按内容拷贝。导入仍受单包文件数和大小限制；pnpm 默认的符号链接 `node_modules` 布局不可用，请用 `npm install`，或用 pnpm 的 hoisted/copy 布局准备依赖。

id 默认取目录名；源为 JSON 文件时取文件名，`mcp.json` 这类通用文件名取所在目录名。名称转为小写 ASCII 后为空（例如纯中文目录名）时，使用目录路径的哈希 `pack-<10 位十六进制>`。version 默认 `auto-<内容指纹前 12 位>`：内容不变时重复导入幂等，内容改变得到新版本，再配合 `replace` 切换引擎上的版本。显式指定的同一 id/version 若内容不同，按安装规则报 `TOOL_PACKAGE_VERSION_CONFLICT`。源文件在计算 hash 与拷贝之间发生变化时报 `TOOL_PACKAGE_CHANGED`，不会登记。

## 引擎绑定、替换与解除

绑定结果只保存在引擎配置中，没有第二份绑定登记。HarnessHub 从配置本身识别某个包版本的条目：Skill 路径和 stdio MCP 的启动参数包含内容对象目录 `objects/<digest>`，MCP 名称为 `<id>-<name>`，远程 MCP 另外核对 URL。因此存储目录搬迁后仍能识别。

- 同一版本再次应用时先移除该版本已有的条目再写入，可用于更新秘密绑定，或把旧 revision 中固定的工作区改为占位符。
- 引擎上已有同一包的其他版本时默认报 `TOOL_PACKAGE_BIND_CONFLICT`；`replace:true` 先移除该包其他所有版本的条目再绑定，结果中的 `replaced` 列出被替换的版本。
- 不属于该包的同名 Skill 路径或 MCP 名称永远不会被删除，冲突时报 `TOOL_PACKAGE_BIND_CONFLICT`。
- 合并后超过单引擎 16 个 Skill 或 16 个 MCP 服务时报 `TOOL_PACKAGE_ENGINE_CAPACITY`。
- 解除绑定只删除指定版本拥有的条目并生成新 revision；引擎上没有该版本时结果为 `skipped`，代码 `TOOL_PACKAGE_NOT_BOUND`，重复解除是幂等的。

每次变更都先经 `prepareEngine` 校验再发布新 revision。已有 Session 继续使用创建时固定的 revision，之后新建的 Session 才获得变更。经 HTTP 应用的结果保存在 Gateway 的引擎 overlay（SQLite）中，重启后仍然有效，并优先于配置文件和 `state/settings.json` 中同一引擎的定义；`Install-Tool-Pack.cmd` 写的是 `settings.json`。同一个引擎不要混用两种方式，否则 overlay 会遮住之后写入 settings 的变更。

## HTTP 接口

四个路由都受 Gateway 的 loopback Host/Origin 检查，请求与响应 schema 定义在 [tool-package-routes.ts](../src/gateway/tool-package-routes.ts)，实现为 [management.ts](../src/tool-packages/management.ts)。所有变更请求在同一进程内串行执行；多个引擎逐个处理，单个引擎失败不回滚、也不影响其他引擎。

`GET /v1/tool-packs` 返回 `{packages:[...]}`。每项是登记记录 `schemaVersion/id/version/digest/installedAt/status`，加上 `displayName`、`counts:{skills,mcp,cli}` 和 `engines`（当前配置包含该版本的引擎 id）；发行包 [预装](capability-packs.md#预装工具包) 的那个版本另带 `preinstalled:true`，其余不含该字段。清单无法读取的包仍会列出，并附 `problem:{code,message}`。

`POST /v1/tool-packs/apply` 的 body 字段：

- `engineIds` 为 `"all"` 或 1 至 64 个不重复的引擎 id；旧字段 `engineId` 与它二选一。
- `package:{id,version}` 与 `source`（完整包目录的绝对路径，先安装）二选一；简易格式请用 import。
- `replace` 默认 false；`secretBindings` 为秘密槽引用；`workspace` 仅为兼容旧请求而接受，不再生效，响应 `warnings` 会说明。

响应为 `{ok,package,results,warnings,note}`。`results[]` 每项为 `{engineId,status,revision?,code?,reason?,capabilities?,replaced?}`：

- `applied`：附新 revision 和本包能力 `{skills,mcp,cli}`；
- `skipped`：引擎不接受此包，包括停用引擎（`ENGINE_DISABLED`）、演示引擎，以及 prepareEngine 以 `INVALID_ENGINE_CONFIGURATION`、`ENGINE_CONFIGURATION_UNSUPPORTED`、`INVALID_CONFIG` 或 `ENGINE_RESERVED` 拒绝的情况，例如非 Kimi 的 CLI 引擎不支持 MCP；
- `failed`：未登记的引擎、版本冲突、容量不足或登记错误。

`ok` 在至少一个引擎为 applied 且没有 failed 时为 true；批量结果一律返回 HTTP 200。只给 `engineId` 时保持旧契约：成功响应额外带顶层 `engineId`、`revision`、`capabilities`，失败按原错误返回 4xx，例如引擎未启用返回 404、冲突返回 409。

```json
{
  "engineIds": "all",
  "package": { "id": "simple-toolkit", "version": "auto-9b2bab58436f" },
  "replace": true
}
```

`POST /v1/tool-packs/import` 的 body 为 `{source,kind?,id?,version?,displayName?,applyTo?,replace?,secretBindings?}`，或用 `mcp` 代替 `source`：`mcp` 是直接粘贴的 `{"mcpServers":{...}}` 文档（序列化后最多 256 KiB，`kind` 只能省略或为 `mcp`，默认包 id 为 `mcp-<首个服务名>`）。内联文档旁边没有文件，只有远程 URL 服务能通过；本地命令按离线规则以 `TOOL_PACKAGE_IMPORT_UNSUPPORTED` 拒绝，需把服务文件放进目录后用 `source` 导入。其中 `replace` 与 `secretBindings` 只能与 `applyTo` 一起使用，`applyTo` 与 `engineIds` 取值相同。响应为 `{ok,package,displayName,digest,format,counts,warnings,apply?}`；`format` 为 `tool-package` 或 `generated`；给出 `applyTo` 时 `apply` 是上面的 apply 响应，`ok` 同时反映导入和应用结果。导入失败返回 400，例如 `INVALID_TOOL_PACKAGE_SOURCE`、`TOOL_PACKAGE_IMPORT_UNSUPPORTED`、`TOOL_PACKAGE_TOO_LARGE`，不会登记部分内容。

`DELETE /v1/tool-packs/{id}/{version}/bindings` 必须提供 `engineIds`：放在 JSON body 中（`"all"` 或数组），或放在查询串中（`?engineIds=all`、`?engineIds=a,b`），二者只能选一。响应为 `{ok,package,results,note}`，`results[]` 每项为 `{engineId,status,revision?,code?,reason?,removed?:{skills,mcp}}`，`status` 为 `unbound`、`skipped` 或 `failed`；没有 failed 时 `ok` 为 true。未登记的包版本返回 404。

`engineIds:"all"`、从所有引擎解除绑定以及 `engines` 列表需要组合根向 `createToolPackageManagement` 注入 `listEngines`（当前全部引擎，含停用项）。未注入时前两者返回 501 `ENGINE_LISTING_UNAVAILABLE`，列表省略 `engines`，显式列出的引擎 id 仍可使用。

## 安装、验证、移除与搬迁

源目录内容按逐文件稳定读取的字节进行真实拷贝。Windows 使用 native 文件共享锁拒绝并发写句柄；所有平台验证文件/目录身份、单硬链接、字节数和 SHA-256。拷贝后的暂存目录再次进行全量验证，成功后发布到 `objects/<digest>`，再原子替换登记记录。`digest` 是键排序、文件列表排序后的规范化清单 SHA-256，清单包含全部内容 hash；JSON 排版和对象键顺序不影响身份。

存储目录在 Windows 配置当前用户及系统/管理员的私有 DACL，在 POSIX 要求私有权限。登记位于 `records/<身份 hash>.json`，包含 `schemaVersion/id/version/digest/installedAt/status`。同一 id/version 和 digest 重装幂等；同一 id/version 的不同内容明确报版本冲突。已有对象损坏时拒绝安装和使用，不静默覆盖或修复。hash 校验检测内容改变，不等于发布者签名或来源认证，应只导入用户选择的可信代码。

`list` 只读取登记状态，适合快速列出包；`verify` 与 `bind` 都读取并验证整个已安装包的每个文件。`remove` 只将登记标记为 `removed`，禁止生成新绑定，保留所有 `objects` 及旧引擎 revision 仍引用的路径；重复移除幂等。本轮没有物理垃圾回收功能，手动删除对象会破坏旧会话引用。相同源版本可再次安装以恢复登记。

包管理 API 不修改已发布对象。当前用户在外部仍能编辑文件，后续 verify/bind 会发现与登记或清单不符的内容。Worker 的现有运行契约只在执行时校验启用的 SKILL.md 主文件 hash；附件与 MCP 实现文件不会被 Worker 持续重算全量 hash。不得把安装/绑定验证描述为运行期间对整个工具包的持续完整性防护。

存储使用 `.mutation-lock` 防止并发安装/移除。冲突立即报 `TOOL_PACKAGE_BUSY`，不会等待、自动重试或按 PID 猜测恢复。正常完成会等待文件句柄和 native helper 退出后释放锁。进程崩溃可能留下锁、暂存目录或未登记对象；先核实 `owner.json` 对应操作已停止，再由操作者显式清理该精确锁目录。未登记对象不会自动投入使用，暂不自动 GC。

源目录删除或变更不影响已安装副本。整个存储目录可以真实复制或搬到新位置，包清单和登记不含宿主绝对路径；搬迁后再次 bind 生成新绝对路径和引擎 revision。已经生成的旧 registration/旧会话不会自动重写，保留它们需要保留原对象路径，或者为后续会话显式应用新 registration。

## 可脚本化 CLI

开发仓库先完成构建，使用当前 Node 运行 [组合入口](../src/tool-packages-main.ts)。`--root` 必须是第一项，后跟显式绝对存储目录，其余参数交给工具模块。成功向 stdout 输出 JSON；失败向 stderr 输出带 `code/message` 的 JSON 并返回非零状态。调用者负责选择是否保存或提交返回的引擎配置。发行包的 `hub.cmd tools <命令>` 把同样的命令交给该模块，存储目录固定为 `state/tool-packages`。

```powershell
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages inspect --source C:\HarnessHub\examples\tool-packages\portable-review
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages install --source C:\HarnessHub\examples\tool-packages\portable-review
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages import --source C:\HarnessHub\examples\tool-packages\simple-toolkit
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages import --source D:\configs\mcp.json --kind mcp --id github-tools --version 1.0.0
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages list
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages verify --id portable-review --version 1.0.0
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages bind --id portable-review --version 1.0.0 --engine C:\HarnessHub\registration.json
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages remove --id portable-review --version 1.0.0
node dist/src/tool-packages-main.js --root C:\HarnessHub\state\tool-packages list --include-removed
```

`import` 可加 `--kind`、`--id`、`--version`、`--display-name`，输出 `{package,displayName,digest,format,counts,warnings}`，只安装不绑定。`bind` 可加 `--bindings <绝对 JSON 文件路径>` 和 `--replace`；`--workspace` 仍被接受但不再生效。`--engine` 输入完整 [EngineRegistration](../src/domain/engines.ts)，而不是包含 capabilities/revision 的引擎响应对象。结果为 `{registration,revision,package:{id,version},capabilities,replaced?}`。生成的 `registration` 已调用既有 `prepareEngine` 校验及固定 Skill hash，可通过已有 `PUT /v1/engines/:id` 应用。同一版本重复绑定会刷新该版本的条目；绑定、替换和冲突规则与上文 [引擎绑定、替换与解除](#引擎绑定替换与解除) 相同。命令不会写回输入文件或发送 HTTP 请求。多个包可依次对上一次返回的 registration 绑定，仍受单引擎既有数量与能力限制。

## CLI 工具与 Windows 批处理

`cliTools` 由受控 MCP 服务 [command-mcp.ts](../src/drivers/tool-command/command-mcp.ts) 暴露为 `cli_<name>` 工具，配置解析在 [config.ts](../src/drivers/tool-command/config.ts)。工作目录取自 `--workspace`（Worker 替换后的 Session 目录），旧 revision 取 `HHCAP_CLI_WORKSPACE`；缺失、相对路径或未替换的占位符都会让服务启动失败。模型只能传有界字符串 argv，执行使用 `shell:false`，限制见 [Capability Pack](capability-packs.md#cli-如何统一给不同-harness-使用)。

Windows 上 Node 拒绝直接启动 `.cmd`/`.bat`（CVE-2024-27980，报 EINVAL）。受控服务改用绝对路径的 `cmd.exe /d /s /v:off /c "<行>"` 启动这类入口，并以 `windowsVerbatimArguments` 传入整行；`cmd.exe` 取自以 `cmd.exe` 结尾的绝对 `ComSpec`，否则取 `%SystemRoot%\System32\cmd.exe`，不经 PATH 查找。批处理路径和每个参数都用双引号包围，末尾反斜杠加倍，因此 `&|<>()^!`、空格和中文在外层 cmd 解析和批处理的 `%*` 展开中都保持原样。cmd.exe 即使在引号内也会展开或重新切分的 `"`、`%`、CR、LF 和 NUL 无法安全传递，含这些字符的调用返回 `isError`，不会改写参数；需要这类值时请改用原生可执行文件。`/v:off` 只关闭外层解析的延迟展开，批处理自己开启延迟展开时仍可能改写 `!`。`.ps1` 入口明确拒绝，请用 `.cmd` 包装。超时只终止 cmd.exe 本身，批处理启动的子进程由 Worker 的进程树监督回收。

转义规则由 [单元测试](../tests/unit/command-mcp-windows-batch.test.ts) 在所有平台验证；经真实 cmd.exe 的端到端用例 [command-mcp-windows.test.ts](../tests/integration/command-mcp-windows.test.ts) 只在 Windows 运行，其他平台记为 skipped。

## 工作区只读工具包

[workspace-tools](../examples/tool-packages/workspace-tools/tool-package.json) 是零依赖 Node 示例，提供 `workspace_list`、`workspace_read`、`workspace_search` 三个本地工具及附带 Skill。先运行发行 CLI 的 `tools install --source <workspace-tools 目录的绝对路径>`，再运行 `tools use workspace-tools 1.0.0 --engine <支持 MCP 的引擎 id>`。绑定把发行 Node 作为命令，把会话工作目录占位符作为 `--root` 参数，由 Worker 在启动时替换为 Session 目录；服务不下载、不写工作区、不启动子进程，也不访问网络。

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

统一导出为 [index.ts](../src/tool-packages/index.ts)，CLI 上下文为 [cli.ts](../src/tool-packages/cli.ts)，绑定归属与合并规则为 [footprint.ts](../src/tool-packages/footprint.ts)。所有 I/O 接口是 Promise，失败 reject；每次调用自行拥有并等待关闭文件/native helper，不需要调用者额外 close。参数中的源目录、存储根、Node 可执行文件和 JSON 文件必须为绝对路径。

| 接口 | 输入与结果 |
| --- | --- |
| `parseManifest(input)` | 同步验证 unknown 声明，返回 `{manifest,digest,fileCount,totalBytes}`；不读文件 |
| `inspectLocal(source)` | 全量验证明确的本地源目录，返回 inspection，不执行内容 |
| `installLocal(source, root)` | 真实拷贝及原子登记，返回 inspection 加 `record` |
| `installGenerated(manifest, read, root)` | 安装调用方生成的清单，文件字节由 `read` 提供并逐个核对大小和 hash；登记规则同 installLocal |
| `importLocal(source, root, options?)` | 按 [简易格式导入](#简易格式导入) 生成或原样安装，返回 `{installed,format,counts,warnings}` |
| `inspectImport(source, options?)` | 与 importLocal 相同的校验和错误，返回它将登记的 `{manifest,digest,format,counts,warnings}`，但不创建、锁定或改动任何存储；相同字节得到相同 digest，用于在导入前判断来源是否变化（预装工具包） |
| `listInstalled(root, {includeRemoved?})` | 默认仅已安装登记；不存在的存储返回空数组；不全量读内容 |
| `readManifest(root, record)`、`listManifests(root, options?)` | 只读取并核对已登记对象的清单，不重算文件 hash；用于列表和绑定归属判断 |
| `verifyInstalled(root, id, version)` | 全量验证已安装对象并返回 inspection 加 `record`；removed 不可验证为可用安装 |
| `removeInstalled(root, id, version)` | 软注销，返回 removed 记录，保留内容对象 |
| `bindInstalled(root, id, version, options)` | options 为 `{nodeExecutable,commandMcpEntry?,secretBindings?}`，旧字段 `workspace` 被忽略；全量验证并返回 `{skills,mcpServers}`；调用者仍须通过 prepareEngine 检查最终引擎配置 |
| `planBinding(configuration, adapter, target, versions, fragment, replace)` | 纯函数，按上文规则计算绑定后的引擎配置及被替换的版本 |
| `createToolPackageManagement(options)` | HTTP 服务实现；options 为 `{root,nodeExecutable,commandMcpEntry,engineProfile,registerEngine,listEngines?,preinstalled?}`。除路由使用的 list/apply/import/unbind 外还有 `ensure({id,version}, engineIds)`：只给当前配置中没有该版本的引擎绑定（替换旧版本），已带有、已停用、未登记或不兼容的引擎记为 `skipped` 且不产生新的引擎 revision；供预装工具包补齐被 overlay 遮住的引擎 |
| `runToolPackageCli(argv, context)` | argv 从命令开始；context 为 `{root,nodeExecutable,commandMcpEntry?,prepareEngine}`；prepareEngine 由组合根注入；返回上述命令 JSON，不自行打印或持久化用户引擎配置 |

主要错误包括 `INVALID_TOOL_PACKAGE`、`INVALID_TOOL_PACKAGE_PATH`、`INVALID_TOOL_PACKAGE_SOURCE`、`TOOL_PACKAGE_IMPORT_UNSUPPORTED`、`TOOL_PACKAGE_CONTENT_MISMATCH`、`TOOL_PACKAGE_TOO_LARGE`、`TOOL_PACKAGE_INTEGRITY`、`TOOL_PACKAGE_CHANGED`、`TOOL_PACKAGE_VERSION_CONFLICT`、`TOOL_PACKAGE_REGISTRY_CORRUPT`、`TOOL_PACKAGE_NOT_FOUND`、`TOOL_PACKAGE_BUSY`、`INVALID_TOOL_PACKAGE_BINDING`、`TOOL_PACKAGE_BIND_CONFLICT`、`TOOL_PACKAGE_ENGINE_CAPACITY`、`ENGINE_LISTING_UNAVAILABLE`、`INVALID_TOOL_PACKAGE_ARGUMENT`；批量结果中另有 `ENGINE_DISABLED` 与 `TOOL_PACKAGE_NOT_BOUND`。系统 I/O、权限和既有引擎校验错误保持失败，不转为空结果或尝试联网补齐。
