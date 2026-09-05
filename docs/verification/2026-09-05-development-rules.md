# 验收：开发规范与文档检查

日期：2026-09-05。范围：根开发规则、三类规范、决策/验收模板及零依赖文档检查。结果：该范围已验证；业务、Node 24 和 Windows 兼容性未验证。

## 环境与版本

环境为 macOS / Darwin arm64，实际 Node 为 v25.9.0。项目尚未初始化 Git，本次记录以脚本 SHA-256 标识检查器版本：

| 文件 | SHA-256 |
|---|---|
| [检查入口](../../scripts/check-docs.mjs) | `e44c6eea585d5086903643da110ac9daba8f6ee9a2d328876c9e0798217eab1e` |
| [测试](../../scripts/check-docs.test.mjs) | `faac6a6800c77b019ec509d5cd22fb29c40934cdf1ba177f5c061cd836d02ab2` |

业务目标运行时仍按 [DESIGN.md](../../DESIGN.md)采用 Node 24 LTS；本次运行检查器不改变该决定。

## 实际执行

工作目录为 HarnessHub 项目根。

| 命令 | 结果 |
|---|---|
| `node scripts/check-docs.mjs` | exit 0；本记录加入前的 13 份 Markdown 通过离线检查 |
| `node --test scripts/check-docs.test.mjs` | exit 0；14 tests，14 pass，0 fail，0 skipped |

测试包含缺失链接、根目录越界、绝对路径、编码路径、代码示例、生成目录排除、无 Markdown、读取失败、UTF-8/BOM/CRLF/结尾换行、未闭合围栏，以及失败 CLI 非零退出。有效样例与对应反例均有覆盖。

## 文档复核

已交叉检查根入口、设计基线、开发规范、测试要求和文档规范。检查接入按模块和阶段推进；首个假引擎骨架不被真实引擎凭证阻塞，阶段 B 完成需要 Windows 原生证据。

另对规范中的 20 个本地标题引用核对目标文件与标题，未发现缺失。该次复核不等于文档脚本已具备锚点校验能力。

## 未验证项

没有 Gateway、Worker 或引擎执行证据，没有 Node 24 和 Windows 测试结果，没有包管理、lint、typecheck 或 CI 成功声明。自动检查的 Markdown 语法覆盖限制见 [文档规范](../documentation.md#自动检查与人工审查)。

## 关联文档

[AGENTS.md](../../AGENTS.md)、[开发规范](../development.md)、[测试要求](../testing.md)、[治理决定](../decisions/0001-development-governance.md)。脚本变化后须重新运行相关测试，并更新本记录的适用版本或新建验收记录。
