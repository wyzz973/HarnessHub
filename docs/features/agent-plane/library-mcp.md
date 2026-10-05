# Library MCP 服务

| 项 | 内容 |
|---|---|
| 分类 | Agent 平面 |
| 状态 | 已实现 |
| 验证 | 单元：[library.test.ts](../../../packages/agents/test/library.test.ts) 覆盖 9 个 Agent 的写入样本、同名冲突、秘密的引用、拒绝、同意后的明文与 diff 掩码、`SECRET_REF_FORBIDDEN` 与凭据值；`library-validate.test.ts` 的无效样例；集成：[library.test.ts](../../../tests/integration/library.test.ts) 经正式守护进程与 SDK 验证各类 `SECRET_REF_FORBIDDEN`、正例 `MY_MCP_TOKEN` 与 `hh library add mcp` 的 stdin 秘密；macOS arm64 本机通过；没有用真实 Agent 启动写入的 MCP 服务；Windows 未验证 |
| 对照 Magpie | 部分：按各 Agent 自己的格式写入为相同；秘密只用引用、不能引用 HarnessHub 自身凭据为有意不同（Magpie 明文保存）；MCP 市场、项目级 MCP 与从 Agent 或 CC Switch 导入未覆盖（[Library](../../magpie-parity.md#library)） |
| 权威文档 | [Library：秘密](../../library.md#秘密)、[各 Agent 的位置](../../library.md#各-agent-的位置)、[归属与还原](../../library.md#归属与还原)、[07 第 4.6 节](../../proposals/oss/07-data-security.md#46-禁止把-harnesshub-自身凭据作为工具秘密)、[API 参考：create_library_mcp](../../api/reference.md#hh_api_v1_create_library_mcp) |

## 用途

把一个 MCP 服务登记一次，同步到多个 Agent 各自的 MCP 配置中（Claude Code 的 `~/.claude.json`、Codex 的 `config.toml` 等），格式由 HarnessHub 按 Agent 转换。服务需要的 Token 以引用保存，能引用环境变量的 Agent 只拿到引用，HarnessHub 自身的凭据不能被当作工具秘密交出去。

## 入口

| 入口 | 用法 |
|---|---|
| 控制台 | Library 页（`/library?tab=mcp`）：本地命令或 HTTP、SSE；普通环境变量与请求头之外，秘密逐个以环境变量、文件或新值登记，已保存的秘密只显示“已保存”；被 `SECRET_REF_FORBIDDEN` 拒绝时显示规则并标出对应的行 |
| 命令行 | `hh library add mcp <name> --command CMD [--arg ARG]... [--env NAME=VALUE]... [--secret-env NAME=SOURCE]... [--agent A]...`；`hh library add mcp <name> --http URL\|--sse URL [--header NAME=VALUE]... [--secret-header NAME=SOURCE]...`；`SOURCE` 为 `env:VARIABLE`、`file:PATH` 或 `stdin`；`hh library list\|show\|rm mcp` |
| HTTP | `GET`、`POST /api/v1/library/mcp`；`GET`、`PUT`、`DELETE /api/v1/library/mcp/{name}` |

## 已实现的能力

- 条目：`{name, transport, command, args, url, env, secretEnv, headers, secretHeaders, agents}` 存于 `library.json`；名称为 1 到 64 个字母、数字、下划线与连字符；`stdio` 只有命令（参数至多 128 个），`http`、`sse` 只有 URL 与请求头，环境变量与请求头各至多 32 项。
- 传输与 Agent：不支持该传输的 Agent 在登记时被拒绝（400 `LIBRARY_UNSUPPORTED`），Codex 与 Pi 没有 SSE。
- 不保存秘密值：`secretEnv`、`secretHeaders` 只能是 `env`（变量名）、`file`（绝对路径）或 `store`（HarnessHub 秘密库）引用；经 API 以 `{secret}` 给出的值（命令行的 `NAME=stdin`）存入秘密库，条目只保留 `store` 引用，任何响应都不返回值；命令行不接受秘密值作为参数。
- 拦截明文凭据：`env` 与 `headers` 中按惯例携带凭据的名称（`…_TOKEN`、`…_API_KEY`、`…_SECRET`、`Authorization`、`Cookie` 等）、URL 中的密钥类查询参数与 `user:password@` 都被拒绝，要求改用秘密引用。
- 禁止引用 HarnessHub 自身凭据：登记与同步时，`HH_`、`HARNESSHUB_` 开头的变量，数据目录与配置目录中的文件（含经链接或 `..` 指进去的路径），与任一 provider Credential 相同的变量名、文件或 `store` ID，均为 400 `SECRET_REF_FORBIDDEN` 且什么都不保存；`{secret}` 的值与同意明文写入时解析出的值另与 Gateway Key、管理令牌和 provider Credential 的值按 SHA-256 摘要比较。
- 写入 Agent 时只写引用：Claude Code、Gemini CLI、Qwen Code 写 `"${VAR}"`，Codex 写 `env_vars`（stdio）或 `env_http_headers`（HTTP），OpenCode 写 `"{env:VAR}"`；值留在 Agent 自己的环境中。
- 明文需同意：Pi、Crush、Hermes、Kimi 不能引用环境变量，`store` 与 `file` 秘密也只能以值写入；这些情况默认拒绝同步该服务，`--allow-plaintext-secret`（API 的 `allowPlaintextSecret`）才写入，预览中值显示为 `<secret>` 并给出警告。
- 归属：经格式保真编辑器写入，注释、顺序与其他键不变；与用户已有条目同名时拒绝并报告，不覆盖；写入后重新解析核对。
- 清理：删除或替换条目时删除它不再使用的 `store` 秘密。
- 备份与同步：`store` 秘密只在带 Key 的备份中以值携带；恢复与同步带入时按同样的规则重新检查，包括 `SECRET_REF_FORBIDDEN`。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [library/validate.ts](../../../packages/agents/src/library/validate.ts)（`parseMcpServer`）、[library/mcp.ts](../../../packages/agents/src/library/mcp.ts)（`renderSecrets`、`encodeServer`）、[library/targets.ts](../../../packages/agents/src/library/targets.ts)（`libraryCapabilities`）、[library-service.ts](../../../packages/daemon/src/library-service.ts)、[secret-refs.ts](../../../packages/daemon/src/secret-refs.ts)、[cli/library.ts](../../../packages/cli/src/library.ts)、[library-page.tsx](../../../packages/console/components/library-page.tsx) |
| 测试 | [packages/agents/test/library.test.ts](../../../packages/agents/test/library.test.ts)、[library-validate.test.ts](../../../packages/agents/test/library-validate.test.ts)、[tests/integration/library.test.ts](../../../tests/integration/library.test.ts)、[backup-library.test.ts](../../../tests/integration/backup-library.test.ts) |
| 决策 | 无专门的 ADR；设计见 [04 第 8 节](../../proposals/oss/04-agent-plane.md#8-library) 与 [07 第 4.6 节](../../proposals/oss/07-data-security.md#46-禁止把-harnesshub-自身凭据作为工具秘密) |

## 已知限制与未验证

- Pi、Crush、Hermes 能否在配置中引用环境变量仍标为“待核”，目前一律按只能写明文处理；Qwen Code 的 MCP 格式也是“待核”。
- 没有 MCP Registry（`server.json`）与 `mcp.json` 导入，不能从 Agent 或 CC Switch 已有的配置导入，没有项目级 MCP。
- 只同步到 Library 的 9 个 Agent。
- 在本机无法解析的 Credential（变量未设置、文件缺失）没有可比较的值，摘要比较对它无效。
- 接口没有 ETag/`If-Match` 与 `Idempotency-Key`（与 06 第 3 节的差异）。
- 没有用真实 Agent 启动写入的服务；Windows 未验证。

## 优化候选

- **现状**：Pi、Crush、Hermes 的秘密只能明文写入。**方向**：用一致性套件确认它们各自的环境变量引用写法，能引用的改为只写引用，并把“待核”改为结论。**依据**：[Library：秘密](../../library.md#秘密)表中的“无（待核）”；[04 第 8 节](../../proposals/oss/04-agent-plane.md#8-library)要求待核项在 Adapter 稳定前确认。
- **现状**：MCP 服务只能手工登记。**方向**：导入 `mcp.json` 系列格式与官方 MCP Registry 的 `server.json`，npm、PyPI 包转为固定版本的 stdio 命令并要求确认。**依据**：[Library 现状](../../library.md)“尚未实现：MCP Registry 与 `mcp.json` 导入”；对照表市场一行（not covered）。
- **现状**：用户在 Claude Code 等 Agent 中已有的 MCP 服务不能进入 Library。**方向**：读取所选 Agent 的 MCP 配置，预览后导入，明文秘密转为 `store` 引用。**依据**：对照表 “Importing existing MCP servers … from agents and CC Switch”（not covered）。
- **现状**：`--agent all` 加 `--sse` 时，因 Codex 与 Pi 不支持 SSE，整条登记被拒绝。**方向**：把 `all` 解释为支持该传输的 Agent，或在错误中列出可用的 Agent。**依据**：阅读 [cli/library.ts](../../../packages/cli/src/library.ts) 的 `agents()` 与 `parseAgents` 的观察，未实际运行。
