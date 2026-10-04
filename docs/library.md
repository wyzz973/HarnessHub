# Library

Library 在 HarnessHub 中保存一份指令集、MCP 服务与 Skills，按各 Agent 自己的位置与格式同步到本机已安装的 Agent。写入方式与[全局接线](global-wiring.md)相同：先预览，确认后备份原文件、原子写、回读校验；HarnessHub 只拥有自己写入的部分，移除时只取出这些部分，文件仍是上次写入的样子时写回原始字节。目标设计见 [04 Agent 平面第 8 节](proposals/oss/04-agent-plane.md#8-library)；各 Agent 读取的位置参照 Magpie（`yetone/magpie`，MIT）`internal/library/targets.go` 与 `mcp.go`（`2e340f7`）。

现状：库（`packages/agents/src/library/`）、守护进程的 `/api/v1/library`、SDK 的 `client.library` 与 `hh library` 已实现，以临时主目录经正式守护进程入口验证。尚未实现：项目级放置（`hh library project add`）、MCP Registry 与 `mcp.json` 导入、版本历史接口、Profile 中的 Library 选择、控制台页面；没有用真实 Agent 验证它们读到了写入的内容；Windows 未验证。

## 使用

```sh
pnpm exec hh library add instructions team --file team.md --agent claude,codex,gemini
pnpm exec hh library add mcp github --command github-mcp --arg stdio \
  --secret-env GITHUB_TOKEN=env:GITHUB_TOKEN --agent claude,codex
pnpm exec hh library add mcp search --http https://mcp.example.com/mcp \
  --secret-header Authorization=stdin --agent claude < token.txt
pnpm exec hh library add skill ./skills/pdf-tools --agent all
pnpm exec hh library list                  # 条目与它们去往的 Agent
pnpm exec hh library sync --dry-run        # 只打印各 Agent 的改动
pnpm exec hh library sync                  # 显示改动，确认后写入
pnpm exec hh library sync kimi --allow-plaintext-secret   # 同意把秘密值写入 Kimi 的文件
pnpm exec hh library rm mcp github         # 从 Library 删除，下一次 sync 从 Agent 中取出
```

`add` 只改 Library，不改 Agent 文件；`--replace` 替换同名条目。`sync [agent]...` 默认同步全部 Agent，先打印每个文件的统一 diff、Skill 的放置、被拒绝的条目与警告，确认后按这份预览写入：预览之后文件又被改动则以 5 退出、该 Agent 什么都不写；`--yes` 跳过确认，非交互且没有 `--yes` 时以 4 退出；有条目被拒绝时其余照常写入，以 5 退出并列出被拒绝的条目。`--copy` 复制 Skill 而不是建立链接。

## 条目

| 条目 | 保存 | 去往 |
|---|---|---|
| 指令集 | `<dataDir>/library/instructions/<id>.md`（Markdown，CRLF 转为 LF，最多 256 KiB） | 一个 Agent 只能有一套；Kimi 与 Hermes 没有用户级指令文件，登记时拒绝 |
| MCP 服务 | `library.json` 中的 `{name, transport, command, args, url, env, secretEnv, headers, secretHeaders}` | 不支持该传输的 Agent 登记时拒绝（Codex、Pi 没有 SSE） |
| Skill | 按内容哈希保存的目录 `skills/<sha256>/<name>/`，不再修改 | 每个 Agent 的 Skills 目录，链接或带标记的副本 |

Skill 导入时按 [Agent Skills 规范](https://agentskills.io/specification)校验：`SKILL.md` 以 YAML front matter 开头，`name` 只含小写字母、数字与单个连字符并等于目录名，`description` 必填（最多 1024 个字符）；目录中不能有链接，最多 500 个文件、20 MiB。不合格的目录在导入时就被拒绝（400 `LIBRARY_SKILL_INVALID`），不会同步后被 Agent 静默跳过。同名 Skill 再次导入成为新版本；没有被 Library 或任何 Agent 引用的版本在下一次导入、删除或同步后回收。

## 秘密

Library 不保存秘密值。MCP 的 `secretEnv` 与 `secretHeaders` 是三种引用之一：`env`（变量名）、`file`（绝对路径）、`store`（HarnessHub 秘密库）。经 API 以 `{secret}` 给出的值（`hh library add` 的 `NAME=stdin`）存入秘密库，条目只保留 `store` 引用，任何响应都不返回值；删除或替换条目时删除它不再使用的 `store` 秘密。命令行不接受秘密值。`env` 与 `headers` 中按惯例携带凭据的名称（`…_TOKEN`、`…_API_KEY`、`…_SECRET`、`Authorization`、`Cookie` 等）以及 URL 中的密钥类查询参数都被拒绝，要求改用秘密引用。

**禁止引用 HarnessHub 自身凭据**（[07 第 4.6 节](proposals/oss/07-data-security.md#46-禁止把-harnesshub-自身凭据作为工具秘密)）：登记与同步时，下列引用以 400 `SECRET_REF_FORBIDDEN` 拒绝，什么都不保存：`HH_`、`HARNESSHUB_` 开头的变量；数据目录与配置目录中的文件（管理令牌、秘密库与其主密钥 `secrets.key`）；与任一 provider Credential 相同的变量名、文件（解析链接后）或 `store` ID。`{secret}` 的值以及同意明文写入时解析出的值另与 Gateway Key（`hhk_` 前缀）、管理令牌和各 provider Credential 的值按 SHA-256 摘要比较，相同即拒绝；在本机无法解析的 Credential（变量未设置、文件缺失）没有可比较的值。`{kind: store}` 只能是该服务已经持有的秘密，不能借此引用其他秘密。

**写入 Agent 时**：Agent 支持在配置中引用环境变量时只写引用，值留在 Agent 自己的环境里；否则默认拒绝同步该服务，加 `--allow-plaintext-secret`（API 的 `allowPlaintextSecret`）才把值写入该 Agent 的文件，预览中的值显示为 `<secret>` 并给出警告。`store` 与 `file` 秘密只能以值的形式写入。

| Agent | 引用方式 | 说明 |
|---|---|---|
| Claude Code | `"${VAR}"` | 写在 `~/.claude.json`（或 `$CLAUDE_CONFIG_DIR/.claude.json`）的 `mcpServers` |
| Codex | `env_vars = ["VAR"]`（stdio）、`env_http_headers`（HTTP） | `env_vars` 按原名透传，`secretEnv` 的名称必须与变量同名 |
| Gemini CLI、Qwen Code | `"${VAR}"` | |
| OpenCode | `"{env:VAR}"` | |
| Pi、Crush、Hermes Agent | 无（待核） | 只有明文，需同意 |
| Kimi Code | 无 | 只有明文，需同意 |

## 各 Agent 的位置

| Agent | 指令 | MCP | Skills |
|---|---|---|---|
| Claude Code | `<配置目录>/CLAUDE.md` | `~/.claude.json` 的 `mcpServers`（`type: stdio\|http\|sse`） | `<配置目录>/skills` |
| Codex | `<CODEX_HOME>/AGENTS.md`（存在 `AGENTS.override.md` 时警告） | `config.toml` 的 `[mcp_servers.<name>]`，无 SSE | `<CODEX_HOME>/skills` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `settings.json` 的 `mcpServers`（HTTP 用 `httpUrl`，SSE 用 `url`） | `~/.gemini/skills` |
| Qwen Code | `~/.qwen/QWEN.md` | `settings.json`，格式同 Gemini（待核） | `~/.qwen/skills`（待核） |
| OpenCode | `<配置目录>/AGENTS.md` | `opencode.json` 的 `mcp`（`local` 的 `command` 数组、`remote`） | `<配置目录>/skills` |
| Pi | `~/.pi/agent/AGENTS.md` | `~/.pi/agent/mcp.json`（Pi 0.99 起的原生 MCP），无 SSE | `~/.pi/agent/skills` |
| Crush | `${XDG_CONFIG_HOME:-~/.config}/crush/CRUSH.md` | `crush.json` 的 `mcp`（格式同 Claude Code） | `<crush 配置目录>/skills` |
| Kimi Code | 无 | `~/.kimi/mcp.json`（远程服务带 `transport`） | 共享的 `~/.agents/skills`（Kimi 只读第一个存在的用户级目录） |
| Hermes Agent | 无 | `config.yaml` 的 `mcp_servers`（SSE 写 `transport: sse`） | `${HERMES_HOME:-~/.hermes}/skills` |

配置目录与全局接线一致，遵循 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME`、`HERMES_HOME` 等变量。

## 归属与还原

- **指令**：只写一个带标记的区块，接在用户内容之后、以空行分隔：

  ```markdown
  <!-- harnesshub:begin id=team sha=<SHA-256> -->
  ...
  <!-- harnesshub:end -->
  ```

  区块外的内容不动，CRLF 文件保持 CRLF；区块内容被手工改过（与标记中的哈希不符）时同步给出警告，再替换或移除它。
- **MCP**：经格式保真编辑器写入条目，注释、顺序与其他键不变；与用户已有条目同名时拒绝并报告，不覆盖。写入后重新解析，确认 HarnessHub 的条目与预期一致、其他内容与写前相同。
- **Skills**：POSIX 上建立指向内容对象的符号链接；Windows 上先建目录联接，被拒绝时（以及 `--copy`）复制，副本中带标记文件 `.harnesshub-skill`（记录版本）。只有指向 Library 内容对象的链接、以及内容仍与标记版本一致的副本被视为 HarnessHub 的；同名的其他目录被拒绝，副本被用户改过即归用户所有，之后只给出警告，不再替换或删除。
- **还原**：HarnessHub 在每个文件第一次改动前把原始字节存入 `<dataDir>/backups/wiring/library-<agent>/`，并在 `<dataDir>/library/applied.json` 记录写入了哪些条目、写后的哈希与为此创建的目录。某个文件中不再有 HarnessHub 的内容时：文件仍是上次写入的样子就写回原始字节（原本不存在的文件被删除），否则只取出自己的区块与条目，保留用户之后的改动；为放置而创建、已经为空的目录被删除。
- **并发**：同步与全局接线共用每个 Agent 的锁（`<dataDir>/backups/wiring/<agent>/.lock`）；应用时按预览核对每个要改的文件，文件在预览后被改动则返回 409 `LIBRARY_CONCURRENT_MODIFICATION`，该 Agent 什么都不写。逐个 Agent 写入，每个 Agent 写完即提交状态；写入、回读或提交失败时，该 Agent 已写的内容恢复为写前字节。

## 接口

守护进程以 `hh serve` 的接线目录（主目录，或 `--wiring-home`）为 Agent 文件所在；未设置接线目录时条目照常增删，同步返回 503 `AGENT_WIRING_UNAVAILABLE`。接口见 [API 实现参考](api/reference.md) 的 `library` 各节：

| 接口 | 行为 |
|---|---|
| `GET`、`POST /api/v1/library/instructions`；`GET`、`PUT`、`DELETE /api/v1/library/instructions/{id}` | 指令集；`POST` 遇到已有 id 返回 409 `LIBRARY_EXISTS` |
| `GET`、`POST /api/v1/library/mcp`；`GET`、`PUT`、`DELETE /api/v1/library/mcp/{name}` | MCP 服务；秘密规则见上 |
| `GET`、`POST /api/v1/library/skills`；`GET`、`PATCH`、`DELETE /api/v1/library/skills/{name}` | `POST` 的 `source` 是守护进程所在机器上 Skill 目录的绝对路径；`PATCH` 只改 `agents` |
| `POST /api/v1/library/sync/plan` | `agents`、`allowPlaintextSecret`、`placement`（`auto`\|`copy`），返回每个 Agent 的文件 diff、Skill 动作、被拒绝的条目与警告；不写文件 |
| `POST /api/v1/library/sync/apply` | 同上，另需 `expect`（预览响应即可） |

与 [06 第 3 节](proposals/oss/06-interfaces.md) 的差异：06 设计的是统一的 `/library/items` 与带版本历史的 `/library/sync-plans/{planId}/apply`，现在按条目类型分开、计划由客户端带回核对，且尚无 ETag/`If-Match` 与 `Idempotency-Key`。

## 验证

- `packages/agents/test/library.test.ts`：九个 Agent 在空主目录与已有配置中的写入结果与[审阅过的样本](../packages/agents/test/library-golden.ts)逐字节一致，且再次计划没有改动；全部取出后已有文件逐字节还原、空主目录恢复为空；用户改动后的取出、同名冲突、CRLF 与手改区块、`AGENTS.override.md` 警告；秘密的引用、拒绝、同意后的明文与 diff 掩码、`SECRET_REF_FORBIDDEN` 与凭据值；Skill 的链接往返与更新、副本与用户改动、同名目录；预览后文件被改、提交失败后的恢复；目录变量，以及配置目录改变后旧位置逐字节还原、新位置写入。
- `packages/agents/test/library-validate.test.ts`：MCP 服务、指令集与 Skill 目录的无效样例。
- `tests/integration/library.test.ts`：经正式守护进程与 SDK 的增删查改、同步与还原、各类 `SECRET_REF_FORBIDDEN` 与正例 `MY_MCP_TOKEN`、无接线目录时的 503，以及 `hh library` 命令（stdin 秘密、拒绝时的退出码 5、确认）。
