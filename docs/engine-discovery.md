# 本机引擎发现

发现接口重新扫描已知安装位置和本地 JSON manifest，返回候选及可提交的 `registration`。控制台进入引擎页时自动扫描，页面可见期间每 60 秒刷新，切回页面时也会刷新；可点击“重新扫描”。离开页面会取消请求并移除定时器和事件监听。扫描不会运行引擎、请求模型、读取认证文件、安装 Adapter 或自动注册。`ready` 仅表示找到了启动文件及本项目要求的 Adapter，并有已知启动配置；安装版本、可选依赖、认证、模型可用性与任务执行仍需验证。

发现和动态管理入口见 [运行 API](runtime-api.md)。候选与注册字段由 [公共类型](../src/domain/engines.ts)定义。

## 内置安装发现

识别清单由 [内置定义](../src/engine/builtins.ts)集中维护，DSH 的同级源码入口由发现器处理，合计 16 个引擎。优先按 Gateway 的 `PATH` 顺序查找，再查 `.local/bin`、`.npm-global/bin`、`.bun/bin`、`.volta/bin`、`Library/pnpm`、`.local/share/pnpm`、`.nvm/current/bin`，以及引擎专属目录。macOS 再检查 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`；其他 POSIX 系统使用后三项。只检查普通文件及访问权限；同名目录、无执行权限文件、失效链接不会被识别为程序。空 PATH 项不会隐式指向当前目录。

| 引擎 | 启动来源 | 原有配置引用 |
|---|---|---|
| OpenCode | `opencode acp` | 原 HOME 与 XDG 目录；关闭自动更新开关 |
| OpenClaw | `openclaw acp` | 原 `.openclaw` 配置及状态目录；需要已有 Gateway 和可用模型认证 |
| Codex | 本地 `@agentclientprotocol/codex-acp` Adapter | `CODEX_HOME`，显式使用发现到的 Codex executable，初始 read-only 模式 |
| Claude Code | 本地 `@agentclientprotocol/claude-agent-acp` Adapter | 原 HOME，显式使用发现到的 Claude executable，safe mode |
| DSH | PATH 中的 `dsh`，或项目同级 `deepseek-harness/apps/cli/lib/bin.js` | 优先已有本地 launcher 和引用 patch；否则显式引用原 `DSH_HOME` |
| Hermes Agent | `hermes acp`；补查 `.hermes/hermes-agent/venv/bin` | 原 `HERMES_HOME`；需要支持 ACP 的版本及 Python ACP extra |
| MiMo Code | `mimo acp`；补查 `.mimocode/bin` | 原 HOME / XDG 目录；关闭自动更新；安装目录不是配置目录 |
| Gemini CLI | `gemini --acp` | 原 `.gemini` 登录和配置；旧版实验参数可用 manifest 固定 |
| GitHub Copilot CLI | `copilot --acp` | 原 HOME 下的已有登录与配置 |
| Kimi Code | `kimi acp` | 原 HOME 下的已有登录与配置 |
| Qwen Code | `qwen --acp` | 原 HOME 下的已有登录与配置 |
| Kiro CLI | `kiro-cli acp` | 原 HOME / XDG 配置；不添加自动批准参数 |
| Qoder CLI | `qodercli --acp`；补查 `.qoder/bin` | 原 HOME 下的已有登录与配置 |
| Pi | 本地或 PATH 上的 `pi-acp` | `PI_ACP_PI_COMMAND` 固定发现的 Pi；原 `.pi/agent`；已有 manifest 优先 |
| Cursor Agent | `cursor-agent --print --output-format text`，stdin 输入 | 通用 CLI；保留原权限默认值，不添加 `--force` |
| Antigravity CLI | `agy -p {prompt}`，argv 输入 | 通用 CLI；保留原权限默认值，不添加 `--yolo` |

Cursor、Antigravity 的接入只保证 CLI 文本传输能力：逐 Run 独立启动，不声称结构化工具事件、交互权限或上下文恢复。其他新增引擎复用 ACPDriver，但不默认开启恢复；具体能力按协议握手和实际任务分别验证。

Pi 同时检查项目 `.tools/pi/node_modules/.bin/pi` 及 `.tools/pi/node_modules/pi-acp/dist/index.js`。只有 Pi 没有 Adapter 时返回 `adapter-required`，不会自动运行 npx 或下载安装。新接入配置显式引用原 HOME/XDG，并为其子进程保留发现路径和 Node 目录；不修改 Gateway 全局环境。使用非默认认证目录或仅环境变量认证时，通过 manifest/API 明确配置目录和 `credentialEnv` 引用。

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

manifest 的 `command[0]` 若为无路径命令名，按 Gateway PATH、通用用户及系统目录查找并固定为绝对路径；若为相对路径，按 manifest 所在目录解析。其他 argv 保持原样，不展开 shell、`~`、环境变量或相对脚本路径。需要脚本参数时使用绝对路径。所有启动命令均为 argv 数组。

每个 manifest 必须是至多 64 KiB 的普通 JSON 文件；符号链接、目录、无效 JSON、未知字段、不支持的 Driver、不可用的 executable 和两个 manifest 重复 ID 会使整次发现以 `INVALID_ENGINE_MANIFEST` 明确失败。同 ID 的有效本地 manifest 优先于内置配方，因此升级识别清单不会覆盖已有 Pi 模型或自定义 launcher。该规则只影响发现候选；已登记的 API overlay 和历史 revision 仍按原目录规则管理。无扫描目录时按空 manifest 集合处理。

## 验证范围

[发现测试](../tests/unit/discovery.test.ts) 覆盖安装和 Adapter 变化、PATH 优先级、DSH 文件引用、运行时新增 manifest、无效输入拒绝，以及发现期间没有执行程序。真实模型与 Gateway 注册执行的证据由对应验收记录维护，不能从文件存在推导。

OpenClaw 若项目中存在专用 Bridge launcher，发现配置会使用独立原生会话名，避免默认ACP前缀冲突；参见 [OpenClaw说明](openclaw-engine.md)。定制 Pi 和独立 OpenCode DeepSeek 可继续通过本机 manifest 加入发现，不需要扩展 Gateway 分支。

本轮参考源码、实际验证及限制见 [主流 Harness 发现与适配](verification/2026-09-05-mainstream-discovery.md)。当前采用可审核的有限清单，不枚举未知程序，也不把 IDE 桌面应用等同于其 CLI。没有继承到 PATH 的 nvm/fnm 临时目录、shell alias/function 和自定义安装位置可能需要从终端启动 Gateway 或声明绝对路径 manifest。未实现登录 shell 执行探测；Windows `.cmd`/`.ps1` 搜索和启动需独立适配验收。
