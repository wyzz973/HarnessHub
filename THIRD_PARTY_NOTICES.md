# Third-party notices

HarnessHub's own code is licensed under the [MIT License](LICENSE). The third-party code and components below keep their own licenses; listing them does not imply endorsement by their authors. A complete notice file generated from the software bill of materials is planned for release builds ([07 data and security §9](docs/proposals/oss/07-data-security.md#9-许可证合规与第三方声明)); until then, this file lists the code copied into the repository.

## Code in this repository

| Location | Origin and retained license |
|---|---|
| `packages/console/components/ui` | Based on the shadcn/ui registry; [MIT](packages/console/licenses/shadcn-ui.txt) |
| `packages/console/components/ai-elements` | Based on Vercel AI Elements; [original notice](packages/console/licenses/ai-elements.txt), [Apache-2.0](packages/console/licenses/apache-2.0.txt) |
| `packages/agents/src/configuration/codex-default-instructions.ts` | OpenAI Codex `rust-v0.153.4` [models-manager/prompt.md](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/prompt.md); [Apache-2.0](packages/console/licenses/codex-apache-2.0.txt) and [upstream NOTICE](packages/console/licenses/codex-notice.txt), Copyright 2025 OpenAI |
| `patches/acpx@0.13.2.patch` | Patch to [acpx](https://github.com/openclaw/acpx) 0.13.2 (MIT, OpenClaw Team): exposes the client file and terminal capability options, returns permission decisions by their original optionId, and adds read-only observation callbacks for diagnostic logs |

The UI components were adapted to this project's import paths, state and interface language. The Codex default instructions keep the original bytes, wrapped as a TypeScript string; the SHA-256 of the original file is `ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`.

## Package dependencies

Runtime and development dependencies (Fastify, @fastify/swagger, Ajv, YAML, acpx, the Agent Client Protocol SDK, cross-spawn, Next.js, React, assistant-ui, Streamdown and others) are pinned in [package.json](package.json), [packages/console/package.json](packages/console/package.json) and [pnpm-lock.yaml](pnpm-lock.yaml). They are not copied into the repository and keep their own licenses.

## Agents and models

HarnessHub does not include, redistribute or modify any coding agent or model. Agents are installed by users from their vendors and run under their own licenses and terms. Product names are used only to describe compatibility; see [TRADEMARKS.md](TRADEMARKS.md).
