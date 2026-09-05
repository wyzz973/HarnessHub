# 本机引擎发现

发现接口重新扫描已知安装位置和本地 JSON manifest，返回候选及可提交的 `registration`。扫描不会运行引擎、请求模型、读取认证文件、安装 Adapter 或自动注册。`ready` 仅表示找到了启动文件和所需 Adapter；认证、模型可用性与任务执行需要后续 Run 验证。

发现和动态管理入口见 [运行 API](runtime-api.md)。候选与注册字段由 [公共类型](../src/domain/engines.ts)定义。

## 内置安装发现

优先按启动 Gateway 时传入的 `PATH` 顺序找同名可执行文件；未找到时检查用户目录下的 `.local/bin`、`.opencode/bin`、`.npm-global/bin`。只检查普通文件及访问权限，路径中同名目录不会被识别为程序。空 PATH 项不会隐式指向当前目录。

| 引擎 | ACP 启动来源 | 原有配置引用 |
|---|---|---|
| OpenCode | `opencode acp` | 原 HOME 与 XDG 目录；关闭自动更新开关 |
| OpenClaw | `openclaw acp` | 原 `.openclaw` 配置及状态目录；需要已有 Gateway 和可用模型认证 |
| Codex | 本地 `@agentclientprotocol/codex-acp` Adapter | `CODEX_HOME`，显式使用发现到的 Codex executable，初始 read-only 模式 |
| Claude Code | 本地 `@agentclientprotocol/claude-agent-acp` Adapter | 原 HOME，显式使用发现到的 Claude executable，safe mode |
| DSH | PATH 中的 `dsh`，或项目同级 `deepseek-harness/apps/cli/lib/bin.js` | 优先已有本地 launcher 和引用 patch；否则显式引用原 `DSH_HOME` |

Codex 和 Claude Adapter 在项目的 `.tools/adapters/node_modules/@agentclientprotocol/` 下检查。没有 Adapter 时，仍返回引擎候选，状态为 `adapter-required`，但不提供可直接注册的 ACP 配置。发现不临时下载依赖。使用的 Node executable 由 Gateway 注入。

DSH 的同级源码入口存在时，若项目已有 [launcher](../scripts/launch-dsh-acp.mjs) 与 `engines/dsh-local.patch.yaml`，候选复用它们。发现仅检查 patch 文件存在，不读取内容；原设置与凭证引用的准备方式见 [Mac 引擎说明](macos-engines.md)。PATH 中的 DSH 或没有现成 patch 的情况引用原 `DSH_HOME`，候选 notes 会说明共享原生状态。

原配置引用使现有登录可被引擎复用，实际执行仍可能写入引擎的原生状态；发现并不证明所有后端数据都已隔离。发现不更改模型默认值：例如 Codex 默认模型在当前账号不可用时，应在注册时选择已确认支持的模型。

## 通过 manifest 发现自定义引擎

默认扫描 `engines/manifests/*.json`，也可由组合根注入其他目录。每次调用重新读取目录，因此新增或更新 manifest 后，下次扫描立即生效，无需重启 Gateway。此机制让新引擎不必进入内置识别清单；它不会根据任意未知程序猜测启动协议。

每个文件的根对象只允许 `name` 和 `registration`。`registration` 复用正常注册校验，支持 ACP 和 CLI，凭证使用 `credentialEnv` 名称引用；不要把实际密钥放入命令参数或文件。文件不会被作为 JavaScript 导入，也不会执行自定义发现代码。

可运行的 [CLI 示例 manifest](../engines/manifests.example/echo.json) 使用 macOS 的 `/bin/cat` 检查 stdin/stdout 接入，不调用模型。在仓库根目录复制至扫描目录：

```sh
mkdir -p engines/manifests
cp engines/manifests.example/echo.json engines/manifests/echo.json
```

再次发现会返回 `echo-cli` 候选。要接入真实引擎，将 `registration.command` 改为它明确支持的非交互命令及参数，再通过管理接口注册候选。CLI 输入输出约束由 [运行 API](runtime-api.md)说明。

manifest 的 `command[0]` 若为无路径命令名，按 Gateway PATH 查找并固定为绝对路径；若为相对路径，按 manifest 所在目录解析。其他 argv 保持原样，不展开 shell、`~`、环境变量或相对脚本路径。需要脚本参数时使用绝对路径。所有启动命令均为 argv 数组。

每个 manifest 必须是至多 64 KiB 的普通 JSON 文件；符号链接、目录、无效 JSON、未知字段、不支持的 Driver、不可用的 executable 和重复候选 ID 会使整次发现以 `INVALID_ENGINE_MANIFEST` 明确失败。manifest ID 与内置候选重复也会拒绝；要保存同一引擎的另一套配置，请使用独立 ID。无扫描目录时按空 manifest 集合处理。

## 验证范围

[发现测试](../tests/unit/discovery.test.ts) 覆盖安装和 Adapter 变化、PATH 优先级、DSH 文件引用、运行时新增 manifest、无效输入拒绝，以及发现期间没有执行程序。真实模型与 Gateway 注册执行的证据由对应验收记录维护，不能从文件存在推导。
