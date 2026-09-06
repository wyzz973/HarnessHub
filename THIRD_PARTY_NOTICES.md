# 第三方来源与许可

HarnessHub自有代码尚未指定开源许可证。以下第三方代码/组件继续遵循各自许可；列出来源不表示其作者为本项目提供背书。

## 仓库内组件

| 内容 | 来源与保留的许可 |
|---|---|
| web/components/ui | 基于shadcn/ui registry；[MIT许可](web/licenses/shadcn-ui.txt) |
| web/components/ai-elements | 基于Vercel AI Elements；[原始声明](web/licenses/ai-elements.txt)、[Apache 2.0](web/licenses/apache-2.0.txt) |
| src/drivers/configuration/codex-default-instructions.ts | OpenAI Codex `rust-v0.153.4` 的 [models-manager/prompt.md](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/prompt.md)；[Apache 2.0 原文](web/licenses/codex-apache-2.0.txt)、[上游 NOTICE](web/licenses/codex-notice.txt)，Copyright 2025 OpenAI |

组件已按本项目导入路径、状态和中文界面调整。其他前端组件通过依赖引用，版本见 [web/package.json](web/package.json)。

Codex 默认提示词保持原文字节，仅封装为 TypeScript 字符串；原文 SHA-256 为 `ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`。它用于为已知第三方模型补充元数据时保留 Codex 原有默认基线。附带 LICENSE 与 NOTICE 均来自同一固定 tag；便携构建将 `web/licenses` 原样包含在发行目录。

## 包依赖

Fastify、@fastify/swagger、Ajv、YAML、acpx、ACP SDK以及Next/React、assistant-ui、Streamdown等按 [package.json](package.json)、[前端包](web/package.json)和 [pnpm-lock.yaml](pnpm-lock.yaml)固定。node_modules不随Git仓库发布；分发安装包时应遵守所包含依赖的原许可，不把本文件作为完整的传递依赖许可证清单。

固定 `acpx@0.13.2`（[OpenClaw Team，MIT](https://github.com/openclaw/acpx)）应用了可复现的 [本地补丁](patches/acpx@0.13.2.patch)：公开传递底层文件/终端能力选项，并支持按原始 optionId 精确返回权限决定。版本与补丁 hash 均由 pnpm 锁定，未直接修改共享包缓存；发行包包含补丁原文及依赖原许可证。

## 外部引擎与参考项目

Windows 脚本启动使用固定版本 [cross-spawn](https://github.com/moxystudio/node-cross-spawn)（MIT），用于 PATH/PATHEXT 与 Windows 参数转义；代码未复制到仓库，版本由主锁文件管理。

源码仓库不包含第三方引擎二进制或认证文件。Windows 便携构建在开发机从固定来源准备 OpenCode、Pi、Codex、Claude Code、Hermes、MiMo 等引擎与 Adapter，随发行目录保留原许可；来源及版本见 distribution 配置与生成的 bundle.json。个人账号与凭据不进入发行目录。

架构参考和固定源码版本见 [源码调研](<HarnessHub 源码阅读与技术选型讨论稿.md>)。发现机制参考Multica/AgentSpace，依据见 [发现验收](docs/verification/2026-09-05-mainstream-discovery.md)；原生配置依据见 [配置验收](docs/verification/2026-09-05-engine-configuration.md)。参考材料中的AGENTS/技能指令不成为本项目规则。
