# HarnessHub

HarnessHub 为多个 Agent Harness 提供统一执行入口，管理 Session、Run、事件与评测。当前处于设计和开发规范阶段，尚无可运行的 Gateway 或真实引擎接入。

架构已确定为 Gateway + 独立 Engine Worker、SQLite 公共状态与事件、JSONL 轨迹导出；接入顺序为 OpenCode → Pi → DSH。具体职责和实施阶段见 [DESIGN.md](DESIGN.md)。

## 开发入口

- [AGENTS.md](AGENTS.md)：人和 Agent 的常驻规则。
- [TODO.md](TODO.md)：开发任务、依赖、优先级、进度和验收。
- [文档索引](docs/README.md)：开发、测试、文档和决策记录。
- [源码调研](<HarnessHub 源码阅读与技术选型讨论稿.md>)：参考仓库与固定源码版本。

## 当前可运行检查

下列检查使用 Node.js 标准库，无需安装项目依赖：

```sh
node scripts/check-docs.mjs
node --test scripts/check-docs.test.mjs
```

检查范围见 [文档检查](docs/documentation.md#自动检查与人工审查)。它们不代表业务代码、引擎或 Windows 已验证。

当前尚无 `package.json`、Git 仓库或 CI 配置。首次实现业务骨架时建立固定版本的 Node 24/pnpm 工具链和 [计划中的质量检查](docs/testing.md#检查入口与接入顺序)；不得把未存在的 `pnpm` 命令写成已通过。
