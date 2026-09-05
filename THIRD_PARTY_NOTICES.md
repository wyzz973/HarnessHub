# 第三方来源与许可

HarnessHub自有代码尚未指定开源许可证。以下第三方代码/组件继续遵循各自许可；列出来源不表示其作者为本项目提供背书。

## 仓库内组件

| 内容 | 来源与保留的许可 |
|---|---|
| web/components/ui | 基于shadcn/ui registry；[MIT许可](web/licenses/shadcn-ui.txt) |
| web/components/ai-elements | 基于Vercel AI Elements；[原始声明](web/licenses/ai-elements.txt)、[Apache 2.0](web/licenses/apache-2.0.txt) |

组件已按本项目导入路径、状态和中文界面调整。其他前端组件通过依赖引用，版本见 [web/package.json](web/package.json)。

## 包依赖

Fastify、@fastify/swagger、Ajv、YAML、acpx、ACP SDK以及Next/React、assistant-ui、Streamdown等按 [package.json](package.json)、[前端包](web/package.json)和 [pnpm-lock.yaml](pnpm-lock.yaml)固定。node_modules不随Git仓库发布；分发安装包时应遵守所包含依赖的原许可，不把本文件作为完整的传递依赖许可证清单。

## 外部引擎与参考项目

OpenCode、Pi、Codex、Claude Code、Hermes、MiMo等引擎和Adapter需用户自行安装，通常通过进程/协议连接；本仓库不重新分发它们的二进制或认证文件。

架构参考和固定源码版本见 [源码调研](<HarnessHub 源码阅读与技术选型讨论稿.md>)。发现机制参考Multica/AgentSpace，依据见 [发现验收](docs/verification/2026-09-05-mainstream-discovery.md)；原生配置依据见 [配置验收](docs/verification/2026-09-05-engine-configuration.md)。参考材料中的AGENTS/技能指令不成为本项目规则。
