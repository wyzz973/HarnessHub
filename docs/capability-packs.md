# Capability Pack：一键配置 Skill、MCP 与 CLI

HarnessHub 在 [Tool Package](tool-packages.md) 基础上提供 Capability Pack 用法：用户只选择一个本机目录或 JSON 文件和目标引擎，HarnessHub 负责导入、校验、生成清单、绑定并为每个引擎发布新的 Engine revision。不同 Harness 的实际配置方式仍由现有 `EngineConfiguration` 与 Driver/Configuration Adapter 处理。MCP 服务和 CLI 工具在每个 Session 自己的工作目录中运行（比赛中即评测方传入的 `directory`），安装时不需要也不再接受固定工作区。

## 一键安装到所有引擎

三种方式使用同一套导入与绑定规则：每个引擎独立预检，不兼容的引擎记为 `skipped` 并说明原因，单个引擎失败不影响其他引擎。已有 Session 继续使用创建时固定的 revision；之后新建的 Session 使用新 revision，运行中的 Agent 不会被热替换。

### HTTP

直接导入一个包含 Skill 目录、`mcp.json` 和 `cli.json` 的目录，并应用到所有引擎：

```http
POST /v1/tool-packs/import
Content-Type: application/json

{
  "source": "D:/tool-packs/my-tools",
  "applyTo": "all"
}
```

响应中 `package` 是生成的 `{id,version}`，`counts` 是 Skill/MCP/CLI 数量，`warnings` 说明被跳过的文件和被改为环境变量引用的秘密；`apply.results` 逐个引擎给出结果：

```json
{
  "ok": true,
  "package": { "id": "my-tools", "version": "auto-3f2a9c1d0b7e" },
  "format": "generated",
  "counts": { "skills": 1, "mcp": 1, "cli": 1 },
  "warnings": [],
  "apply": {
    "ok": true,
    "results": [
      {
        "engineId": "opencode",
        "status": "applied",
        "revision": "...",
        "capabilities": {
          "skills": [".../SKILL.md"],
          "mcp": ["my-tools-overview", "my-tools-cli"],
          "cli": ["cli_wordcount"]
        }
      },
      {
        "engineId": "local-cli",
        "status": "skipped",
        "code": "INVALID_ENGINE_CONFIGURATION",
        "reason": "MCP injection requires an ACP engine; this CLI adapter cannot apply it"
      }
    ]
  }
}
```

`source` 也可以是单个 `mcp.json`、`cli.json`、`SKILL.md` 或含 `tool-package.json` 的完整包目录；`applyTo` 可以换成引擎 id 数组。已安装的包用 apply 应用到所有引擎：

```json
{
  "engineIds": "all",
  "package": { "id": "my-tools", "version": "auto-3f2a9c1d0b7e" }
}
```

修改目录内容后再次导入会得到新版本。引擎上已有同一包的旧版本时，应用结果为 `failed`（`TOOL_PACKAGE_BIND_CONFLICT`）；在 import 或 apply 中加 `"replace": true` 即先移除旧版本再绑定。解除绑定使用 `DELETE /v1/tool-packs/my-tools/<version>/bindings?engineIds=all`，`GET /v1/tool-packs` 列出已安装的包及正在使用它的引擎。字段、状态和错误码的完整说明见 [HTTP 接口](tool-packages.md#http-接口)。

HTTP 应用的结果保存在 Gateway 的引擎 overlay 中，立即对新 Session 生效，重启后仍然有效，并优先于 `state/settings.json` 中同一引擎的定义。

### 控制台

比赛控制台的工具包页属于 [ADR 0013](decisions/0013-unified-model-gateway.md#4-工具包控制台与交付) 的控制台交付，使用上面同一组 HTTP 接口：选择本机目录或 JSON 文件对应 import 的 `source`，“应用到所有引擎”对应 `applyTo:"all"`，切换版本对应 `replace:true`，解除绑定对应 DELETE 接口。页面本身不在本工具包变更中，具体操作以控制台实际界面为准。

### CLI（离线发行包）

发行包根目录的 `Install-Tool-Pack.cmd` 在不启动 Gateway 的情况下完成同样的导入与绑定，并把接受该包的引擎配置原子写入 `state/settings.json`：

```bat
Install-Tool-Pack.cmd --source D:\tool-packs\my-tools --engines all
Install-Tool-Pack.cmd --source D:\configs\mcp.json --kind mcp --id github-tools --engines opencode,codex
Install-Tool-Pack.cmd --source D:\tool-packs\my-tools --engines all --replace
```

可选参数为 `--kind auto|skills|mcp|cli`、`--id`、`--version`、`--replace` 和 `--bindings <秘密引用 JSON 文件>`；旧参数 `--workspace` 仍被接受但不再生效。输出 JSON 与 HTTP 结果相同，含每个引擎的 `applied/skipped/failed`；至少一个引擎应用且没有失败时退出码为 0，否则为 1。只要有引擎接受，settings 就会保存；没有引擎接受时 settings 保持不变，包仍留在 `state/tool-packages`。写入 settings 后需要重启 Competition Gateway，再创建新 Session。同一个引擎不要同时用 HTTP 和本命令配置，HTTP overlay 会遮住之后写入 settings 的变更。

只需要把包导入存储、不绑定引擎时，可以用 `hub.cmd tools import --source <路径>`；开发仓库中的等价命令见 [可脚本化 CLI](tool-packages.md#可脚本化-cli)。

## 简易格式示例

仓库中的 [simple-toolkit](../examples/tool-packages/simple-toolkit/mcp.json) 是一个不需要 `tool-package.json` 的目录，发行包中位于 `tool-packs\simple-toolkit`：

```text
simple-toolkit/
  skills/toolkit-guide/SKILL.md          Skill 及其 references/usage.md
  mcp.json                               {"mcpServers":{"overview":{"command":"node","args":["servers/overview-mcp.mjs","--root","${workspaceFolder}"]}}}
  servers/overview-mcp.mjs               零依赖 MCP stdio 服务，列出 Session 工作目录
  cli.json                               {"cliTools":[{"name":"wordcount","entry":"bin/wordcount.mjs","launch":"node"}]}
  bin/wordcount.mjs                      统计 Session 工作目录中文件的行数、词数和字节数
```

导入后得到 1 个 Skill、MCP 服务 `simple-toolkit-overview` 和受控 CLI 服务 `simple-toolkit-cli`（工具 `cli_wordcount`）。`${workspaceFolder}` 被换成会话工作目录占位符，由 Worker 在启动服务时替换为 Session 目录。`mcp.json` 和 `cli.json` 本身不会被拷贝。

识别规则摘要：Skill 是任意层级下名为 `SKILL.md` 的文件所在目录；MCP JSON 支持 Claude Desktop/Cursor 的 `mcpServers` 与 VS Code 的 `servers`；`command` 为 `node` 或相对路径的程序，`npx`、`uvx`、`pipx`、`bunx` 等运行时下载命令在离线环境不可用，会被明确拒绝；名称像密钥的 env 值不会保存，改为引用同名环境变量，这些变量必须在启动 Gateway 前设置，否则使用该包的 Session 启动失败。完整规则见 [简易格式导入](tool-packages.md#简易格式导入)。

## Tool Pack 清单

需要精确控制文件、参数和秘密槽时，可以手写 `tool-package.json`，规则见 [清单与相对路径](tool-packages.md#清单与相对路径)。`cliTools` 示例：

```json
{
  "schemaVersion": 1,
  "id": "developer-toolkit",
  "version": "1.0.0",
  "displayName": "Developer Toolkit",
  "files": [
    {
      "path": "skills/coding/SKILL.md",
      "size": 100,
      "sha256": "..."
    },
    {
      "path": "bin/rg.exe",
      "size": 100,
      "sha256": "...",
      "executable": true
    }
  ],
  "skills": [
    {
      "path": "skills/coding/SKILL.md"
    }
  ],
  "cliTools": [
    {
      "name": "rg",
      "description": "Search text in the Session workspace.",
      "launch": "native",
      "entry": "bin/rg.exe"
    }
  ]
}
```

`cliTools` 最多 16 个。`launch: node` 使用发行包自带 Node；`launch: native` 要求 `files[].executable=true`。固定参数可以使用 package/workspace anchor，与 MCP 参数规则一致。仓库中的 [Developer CLI 示例](../examples/tool-packages/developer-cli/tool-package.json) 是一个最小可安装 CLI Pack。

## CLI 如何统一给不同 Harness 使用

CLI 不直接拼进任意 shell 字符串，也不要求所有 Harness 都实现相同 Bash/Shell 接口。绑定时 HarnessHub 自动生成一个受控的 Command MCP：

```text
Tool Pack cliTools
       |
       v
allow-listed Command MCP
       |
       +-- cli_git
       +-- cli_rg
       +-- cli_prettier
       |
       v
EngineConfiguration.mcpServers
       |
       v
ACP / native MCP adapter
```

模型只能选择清单中声明的 CLI，并传递有界的字符串 argv；执行使用 `shell:false`。当前限制包括：最多 64 个动态参数、单参数最多 4096 字符、单次 30 秒、stdout/stderr 合计最多 256 KiB。命令工作目录是当前 Session 的工作目录，由 Worker 在启动 Command MCP 时通过 `--workspace` 传入。Windows 上的 `.cmd`/`.bat` 入口经 `cmd.exe /d /s /v:off /c` 启动，每个参数加引号；含 `"`、`%` 或换行的参数会被拒绝，`.ps1` 入口需用 `.cmd` 包装，详见 [CLI 工具与 Windows 批处理](tool-packages.md#cli-工具与-windows-批处理)。

这使应用层统一配置 Skill、MCP 和 CLI，而具体 Harness 仍通过各自已验证的 MCP/配置适配方式接收工具。若某引擎不支持所需 MCP 注入，现有 EngineConfiguration 校验会明确拒绝，结果中该引擎为 `skipped`，不会静默丢工具。

## Secret

普通 Tool Pack 不包含明文凭证。清单中的 `secretEnv` 与 `secretHeaders` 只声明逻辑槽，应用时通过 `secretBindings` 绑定到 `env`、`file` 或系统凭证引用；简易格式导入会把像密钥的值改成默认的同名环境变量引用。绑定和 Engine revision 中只保存引用；实际值在 Worker 私有配置准备阶段解析，缺失时对应 Session 以 `SECRET_UNAVAILABLE` 启动失败。

```json
{
  "engineIds": "all",
  "package": { "id": "github-tools", "version": "1.0.0" },
  "secretBindings": {
    "GITHUB_TOKEN": { "kind": "env", "value": "GITHUB_TOKEN" }
  }
}
```

## 比赛离线交付

比赛机是离线 Windows x64，不在目标机器上联网安装任何依赖。两种交付物都由 GitHub Actions 构建并发布到 Release，流程与验收见 [Windows 便携发布包](portable-bundle.md) 和 [离线归档与恢复](offline-artifacts.md)：

- **x64 完整运行包**（`competition-latest`）：解压即可运行，内含 10 个固定版本引擎、Node/Python/Git、Gateway 与控制台。设置 `AGENT_ENGINE` 和统一模型环境变量后运行 `gateway.cmd`。
- **离线开发包**（`offline-dev-latest`，可作为提交物 `solution/code`）：包含源码、离线依赖和固定引擎。先运行 `Setup-Competition-Offline.cmd`，在不联网的前提下编译并生成比赛运行布局，再用 `Start-Competition.cmd` 启动。评测执行方按 [INSTRUCTION.md](../distribution/INSTRUCTION.md) 操作。

两种方式下，所有引擎都只使用 `HARNESSHUB_MODEL*` 配置的统一模型，Tool Pack 按上文用 `Install-Tool-Pack.cmd --engines all` 或 HTTP 接口安装到全部引擎。比赛 API 默认监听 `localhost:6217`，引擎在启动时选择，不在请求中动态切换；控制台随比赛入口一并启动。
