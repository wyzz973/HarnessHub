# OpenClaw ACP 接入

HarnessHub 通过 [OpenClaw launcher](../scripts/launch-openclaw-acp.mjs)连接已经运行的本机 OpenClaw Gateway。launcher 只启动 stdio ACP Bridge；模型与工具由原 OpenClaw Gateway 提供，已有登录和配置继续使用文件路径引用。它不启动、重启或修改用户的 Gateway。

## 为什么需要 launcher

本机 OpenClaw `2026.3.23-2` 的 `openclaw acp` 在新建 ACP 会话时使用 `acp:<uuid>` 作为默认 Gateway 会话名。该版本 Gateway 同时使用这个前缀识别另一类由自身 ACP Runtime 管理的会话；缺少对应 `.acp` 元数据时会报 `ACP_SESSION_INIT_FAILED`，提示重新 `/acp spawn`。因此 ACP 握手可以成功，但真正的文本请求仍失败。

这个结论来自已安装版本的 `dist/acp-cli-BQ740PFm.js` 的 `newSession/resolveSessionKey`、`dist/manager-Bw8JrihM.js` 的 `resolveSession` 和 `dist/session-key-DAhnzjyr.js` 的 `isAcpSessionKey`。同版本 `docs/cli/acp.md` 说明 `--session` 可以显式覆盖默认会话映射。该错误与此前失效的 Codex OAuth 是不同问题；本次复测时 OpenClaw 已配置且能够调用 DeepSeek，无需重新认证。

launcher 为每次 Bridge 进程创建独立的 `agent:main:harnesshub:<uuid>`，通过 `openclaw acp --session <key>` 传入。它不复用 `agent:main:main`，也不使用 `--reset-session`。同一个存活 Bridge 的多次 Run 使用其独立会话；不同 Bridge 不共享该会话。

## 配置与边界

固定命令应包含 Node 绝对路径、launcher 的绝对路径和 OpenClaw executable 的绝对路径。若使用外层 `env`，原来的 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 等配置引用继续保留；不要把 token/password 字符串写入 argv。动态注册方法见 [引擎管理](engine-management.md)。

Bridge 使用进程内会话映射。本次接入不设置 `acp.sessionMode: resume`；Worker 丢失后不能以新的 native 会话冒充恢复旧上下文。OpenClaw 内部留下的原生历史不等于 HarnessHub 已实现恢复。Bridge 暂不提供 ACP 客户端 filesystem/terminal 方法，工具实际位置和权限取决于用户 OpenClaw Gateway 配置，不能仅凭 HarnessHub 的 Workspace 声明推断工具已隔离到该目录。

完成判定须核对真实响应或评测结果。该版本可能把路由错误写成文本而让外层执行显示 completed，所以 exit code 0、ACP 连接成功或 completed 都不足以说明任务通过。

## 本机验收

2026-09-05，在 macOS、Node 24.20.0、OpenClaw 2026.3.23-2 下，从正式编译后的 HarnessHub Gateway/Worker/ACP 入口执行短文本任务，Run `cd3515ba-1d5b-4304-a71e-8d7c77cf1273` 在约 5.274 秒后 completed，精确返回 `HARNESSHUB_OPENCLAW_ACP_OK`，没有工具事件。原生 transcript 核对 provider/model 为 `deepseek/deepseek-chat`，使用独立 `agent:main:harnesshub:...` 会话。

专用 Gateway 和公共 Session 已关闭，lease 文件和 launcher 进程均为零。验收摘要在本机忽略目录 `.tmp/openclaw-fix/gateway-result.json`，可用的本机注册配置在 `.tmp/openclaw-fix/profile.json`；这些真实机器路径配置不提交仓库。此证据覆盖文本执行及本地 Bridge 清理，不覆盖工具文件任务、会话恢复或 Windows 原生行为。
