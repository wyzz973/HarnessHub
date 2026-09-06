# Third-party components in this portable bundle

HarnessHub's own source has no declared open-source license. Each bundled third-party component remains subject to its original license and vendor terms; this inventory does not grant additional redistribution rights.

The generated `bundle.json` identifies exact component versions, sources, and file hashes. npm components retain their package metadata and LICENSE/NOTICE files under `engines/npm/node_modules` and `node_modules`. Native engine folders retain the notices supplied by their vendors. Python wheels retain `.dist-info` licenses; PortableGit retains its bundled license collection.

The console includes components based on shadcn/ui (MIT) and Vercel AI Elements (Apache 2.0). Their full license and notice texts are in the bundle's `web/licenses/` directory.

The fixed `acpx@0.13.2` runtime from the OpenClaw Team (MIT) includes the reproducible HarnessHub patch at `patches/acpx@0.13.2.patch`. It forwards the existing client filesystem/terminal capability controls and adds exact option-ID permission decisions. The original MIT LICENSE remains in the bundled acpx package; the patch and modified files are covered by the file hashes in `bundle.json`.

The fixed Codex generic system-instruction baseline comes from [OpenAI Codex rust-v0.153.4, codex-rs/models-manager/prompt.md](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/models-manager/prompt.md), Copyright 2025 OpenAI, licensed under Apache 2.0. The original text is unchanged and is wrapped as a TypeScript string; its SHA-256 is `ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`. The complete fixed-tag LICENSE and NOTICE texts are included as `web/licenses/codex-apache-2.0.txt` and `web/licenses/codex-notice.txt`. Source attribution is retained in the compiled module. DeepSeek model metadata follows DeepSeek's official Codex integration documentation; no account configuration is copied.

Codex, Claude Code, Gemini CLI, Qwen Code, Copilot CLI, Qoder CLI, Pi, MiMo, DeepSeek Harness, OpenClaw, Antigravity, Cursor, Kimi, OpenCode, Hermes and Kiro remain independent upstream products. Proprietary account requirements and vendor terms still apply. Microsoft VC runtime components remain subject to Microsoft's runtime redistribution terms.

Local portability checks establish technical behavior only. They do not imply vendor endorsement, a blanket license grant, or compliance with an unspecified competition's rules.
