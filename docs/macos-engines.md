# macOS 已安装引擎接入

本页说明本机Profile的实际接法，结果与Run ID见 [macOS验收记录](verification/2026-09-05-macos-engines.md)。本地绝对路径和配置引用保存在被Git忽略的 `engines/local.yaml`；没有保存凭证值。

## 启动与使用

```sh
pnpm start --config engines/local.yaml --port 3181 --data-dir ./data/mac-engines
```

创建Session时显式指定 `engineId` 和同名 `workspaceId`：`codex`、`claude`、`opencode`、`dsh`、`openclaw`。前四个已通过真实文本任务；OpenClaw的模型认证尚未通过。调用方法见 [运行API](runtime-api.md)。

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
| OpenCode | 系统 `opencode acp` | 原HOME/XDG配置、数据及缓存目录；禁CLI自动升级 |
| DSH | [专用启动器](../scripts/launch-dsh-acp.mjs)接现有DSH CLI/profile | `engines/dsh-local.patch.yaml`仅引用已有settings/credentials文件；DSH_HOME仍在Worker私有目录 |
| OpenClaw | 系统 `openclaw acp` | `OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR`指现有Gateway配置与状态 |

这些非秘密目录变量通过Profile的明确argv传给引擎子进程。默认Worker不会自动读取用户原HOME；显式原生引用模式由本地Profile选择。不要把token塞入argv或复制凭证文件。

DSH启动器按固定argv启动现有CLI，继承ACP stdio，并转发终止信号。源码checkout和全局CLI没有被本项目改写。用户删除工具目录或移动已有安装后，应重新准备路径与Adapter，不在执行任务期间临时下载依赖。

本机不同引擎使用了不同模型及认证方式，本次单次耗时不能用于排序或决定比赛得分。
