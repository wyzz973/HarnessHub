# HarnessHub

HarnessHub 为多个 Agent Harness 提供统一执行入口。Gateway、SQLite、独立Worker、取消/期限、权限、SSE和导出已实现；macOS上Codex、Claude Code、OpenCode、DSH已通过真实文本任务。OpenClaw协议可连接但模型OAuth失效；复杂工具任务、Pi、Windows和Benchmark仍待验收。

架构已确定为 Gateway + 独立 Engine Worker、SQLite 公共状态与事件、JSONL 轨迹导出；接入顺序为 OpenCode → Pi → DSH。具体职责和实施阶段见 [DESIGN.md](DESIGN.md)。

## 开发入口

- [AGENTS.md](AGENTS.md)：人和 Agent 的常驻规则。
- [TODO.md](TODO.md)：开发任务、依赖、优先级、进度和验收。
- [文档索引](docs/README.md)：开发、测试、文档和决策记录。
- [源码调研](<HarnessHub 源码阅读与技术选型讨论稿.md>)：参考仓库与固定源码版本。
- [macOS已安装引擎](docs/macos-engines.md)：现成本机CLI、登录引用与真实连接结果。

## 当前可运行检查

项目固定 Node.js 24.20.0、pnpm 10.12.3。先按锁文件安装并构建：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start --demo
```

服务默认监听 `127.0.0.1:3180`。`--demo` 显式启用假引擎，不调用模型；配置真实引擎时使用 `pnpm start --config engines/local.yaml`。配置格式见 [示例](engines/example.yaml)和 [运行/API 说明](docs/runtime-api.md)。

本机开发过程中下载的 Node 位于 `.tools/node/bin`，可通过 `PATH="$PWD/.tools/node/bin:$PATH" pnpm start --demo` 使用；该目录被忽略，不是发行依赖。

常用检查的实际定义在 [package.json](package.json)：`pnpm build` 同时做严格类型检查和编译，`pnpm test:integration`/`test:smoke` 使用编译产物。`pnpm check` 执行完整本地检查；日常按改动运行必要项，不重复已通过且输入未变化的检查。

独立的文档检查无需安装项目依赖：

```sh
node scripts/check-docs.mjs
node --test scripts/check-docs.test.mjs
```

检查范围见 [文档检查](docs/documentation.md#自动检查与人工审查)。它们不代表业务代码、引擎或 Windows 已验证。

Git、锁文件和 [CI 配置](.github/workflows/ci.yml)已建立；远端 CI 尚未运行。阶段进度及未完成验收见 [TODO](TODO.md)，本次运行证据见 [执行服务验收](docs/verification/2026-09-05-runtime-mvp.md)。
