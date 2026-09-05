# macOS 已安装引擎接入

本页说明本机Profile接法；最新结果见 [文件与恢复验收](verification/2026-09-05-file-tasks-and-recovery.md)，原始连接证据保留在 [首次验收记录](verification/2026-09-05-macos-engines.md)。本地绝对路径和配置引用保存在被Git忽略的 `engines/local.yaml`；没有保存凭证值。

## 启动与使用

```sh
pnpm start --config engines/local.yaml --port 3181 --data-dir ./data/mac-engines
```

上面是原始文件Profile的启动方式。当前常驻动态服务在 `127.0.0.1:3182`，workspace为 `task`；引擎包括 `codex`、`claude`、`opencode`、`opencode-deepseek`、`dsh`、`openclaw`、`pi`。OpenCode原免费模型近期返回429，比赛文件任务使用显式独立的 `opencode-deepseek`；OpenClaw需使用下面的新Bridge，不能继续照搬旧默认会话名。调用方法见 [运行API](runtime-api.md)。

## Adapter准备

仅Codex和Claude需要额外ACP Adapter，安装到项目工具目录，避免替换系统CLI：

```sh
npm install --prefix .tools/adapters --save-exact --omit=optional --ignore-scripts \
  @agentclientprotocol/codex-acp@1.10.0 \
  @agentclientprotocol/claude-agent-acp@0.74.0
```

Node使用项目固定版本。这里省略可选原生依赖的前提是Profile显式指定现有CLI路径；不应把这条命令用于依赖Adapter内置CLI的部署。

## Profile中的配置引用

| 引擎 | ACP入口 | 显式引用 |
|---|---|---|
| Codex | Node执行codex-acp的dist/index.js | `CODEX_PATH`指系统CLI；`CODEX_HOME`指已有登录目录；本机Profile模型为gpt-5.6-sol |
| Claude Code | Node执行claude-agent-acp的dist/index.js | `CLAUDE_CODE_EXECUTABLE`指系统CLI；Adapter子进程HOME指原HOME；safe mode启用 |
| OpenCode | 原系统ACP或 [独立DeepSeek launcher](opencode-engine.md) | 原Profile保留；独立Profile使用Worker私有HOME、既有模型/插件缓存和DSH认证引用 |
| DSH | [专用启动器](../scripts/launch-dsh-acp.mjs)接现有DSH CLI/profile | `engines/dsh-local.patch.yaml`仅引用已有settings/credentials文件；DSH_HOME仍在Worker私有目录 |
| OpenClaw | [独立session Bridge](openclaw-engine.md) | 原Gateway配置引用不变，避免默认acp会话名前缀冲突 |
| Pi | [固定pi-acp与Pi launcher](pi-engine.md) | Worker私有模型偏好，DSH现有DeepSeek文件引用 |

这些非秘密目录变量通过Profile的明确argv传给引擎子进程。默认Worker不会自动读取用户原HOME；显式原生引用模式由本地Profile选择。不要把token塞入argv或复制凭证文件。

DSH启动器按固定argv启动现有CLI，继承ACP stdio，并转发终止信号。源码checkout和全局CLI没有被本项目改写。用户删除工具目录或移动已有安装后，应重新准备路径与Adapter，不在执行任务期间临时下载依赖。

本机不同引擎使用了不同模型及认证方式，本次单次耗时不能用于排序或决定比赛得分。
