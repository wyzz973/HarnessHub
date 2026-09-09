# Capability Pack：一键配置 Skill、MCP 与 CLI

HarnessHub 在现有 Tool Package 基础上提供 Capability Pack 用法：应用层只选择一个包和目标引擎，Gateway 负责安装、校验、绑定工作区、合并配置并发布新的 Engine revision。不同 Harness 的实际配置方式仍由现有 `EngineConfiguration` 与 Driver/Configuration Adapter 处理。

## 一键应用

本地 Tool Pack 目录可一次安装并应用：

```http
POST /v1/tool-packs/apply
Content-Type: application/json

{
  "engineId": "opencode",
  "source": "D:/tool-packs/developer-toolkit",
  "workspace": "D:/workspace/project",
  "secretBindings": {
    "githubToken": {
      "kind": "env",
      "value": "GITHUB_TOKEN"
    }
  }
}
```

也可以应用已经安装的固定版本：

```json
{
  "engineId": "opencode",
  "package": {
    "id": "developer-toolkit",
    "version": "1.0.0"
  },
  "workspace": "D:/workspace/project"
}
```

成功响应包含新的 Engine revision 和本次加入的能力：

```json
{
  "ok": true,
  "package": {
    "id": "developer-toolkit",
    "version": "1.0.0"
  },
  "engineId": "opencode",
  "revision": "...",
  "capabilities": {
    "skills": [".../SKILL.md"],
    "mcp": ["developer-toolkit-workspace", "developer-toolkit-cli"],
    "cli": ["cli_git", "cli_rg"]
  }
}
```

已有 Session 继续固定原来的 Engine revision；之后创建的新 Session 使用新 revision，避免运行中的 Agent 被配置热替换。

## Tool Pack 清单

`tool-package.json` 的 `schemaVersion` 仍为 `1`，原有 Skill/MCP 包保持兼容。新增可选 `cliTools`：

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
  "mcpServers": [],
  "cliTools": [
    {
      "name": "rg",
      "description": "Search text in the bound workspace.",
      "launch": "native",
      "entry": "bin/rg.exe"
    }
  ]
}
```

`cliTools` 最多 16 个。`launch: node` 使用发行包自带 Node；`launch: native` 要求 `files[].executable=true`。固定参数可以继续使用 package/workspace anchor，与 MCP 参数规则一致。

仓库中的 [Developer CLI 示例](../examples/tool-packages/developer-cli/tool-package.json) 是一个最小可安装 CLI Pack。

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

模型只能选择清单中声明的 CLI，并传递有界的字符串 argv；执行使用 `shell:false`。当前限制包括：最多 64 个动态参数、单参数最多 4096 字符、单次 30 秒、stdout/stderr 合计最多 256 KiB。命令工作目录固定为绑定时明确指定的 workspace。

这使应用层统一配置 Skill、MCP 和 CLI，而具体 Harness 仍通过各自已验证的 MCP/配置适配方式接收工具。若某引擎不支持所需 MCP 注入，现有 EngineConfiguration 校验会明确拒绝，不会静默丢工具。

## Secret

普通 Tool Pack 不包含明文凭证。清单中的 `secretEnv` 只声明逻辑槽，应用时通过 `secretBindings` 绑定到 `env`、`file` 或系统凭证引用。绑定和 Engine revision 中只保存引用；实际值在 Worker 私有配置准备阶段解析。

## 不需要本地 pnpm 安装

`Competition gateway bundle` GitHub Actions workflow 在 GitHub runner 上执行锁定版本的 `pnpm install --frozen-lockfile` 和 `pnpm build`，然后生成 Windows 运行 ZIP。ZIP 包含 Gateway 的 `dist`、npm 运行依赖和固定 Node 可执行程序，并在上传前解压后执行 `--help` 自检。

下载 Actions Artifact 中的 `harnesshub-competition-windows.zip` 后解压即可：

```bat
Start-Competition.cmd --engine opencode --port 6217 --host localhost --config C:\path\to\engines\local.yaml
```

目标机器不需要安装 Node 或 pnpm。Agent 引擎程序仍由 `engines/local.yaml` 指向现有安装位置，或者直接使用 HarnessHub 已有的离线引擎发行包。

## Competition Full Bundle

最终比赛交付可以使用 `Competition full bundle` workflow。它以固定 SHA-256 的 Windows ARM64 OpenSource Engine Bundle 为基底，保留 Codex、Gemini、Qwen、Pi、MiMo、DSH、OpenClaw、Kimi、OpenCode、Hermes 及包内 Node/Python/Git，然后覆盖当前比赛 Gateway，并重新生成 `bundle.json` 全文件哈希清单。

目标机器不需要 Node、pnpm 或 Harness 安装。先按包内 `examples/company-chat.json` 准备私有模型配置并执行：

```bat
hub.cmd configure --file C:\private\competition-settings.json
```

随后按比赛规范启动：

```bat
gateway.cmd --engine opencode
gateway.cmd --engine codex
gateway.cmd --engine qwen
```

默认监听 `localhost:6217`，也可显式传入 `--port`、`--host`。`Start-Competition.cmd` 与 `gateway.cmd` 等价。引擎在启动时选择，不在请求处理中动态切换；模型、Skill、MCP、CLI Tool Pack 仍通过统一配置与 revision 机制下发。
