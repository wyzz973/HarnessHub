# Documentation index

Start with the project [README](../README.md) ([中文](../README.zh-CN.md)); to develop from source, read [getting started](getting-started.md), and to understand the implementation, the [architecture guide](architecture.md). The open-source design is in [open-source design](proposals/oss/README.md); [DESIGN.md](../DESIGN.md) holds the architecture rules of the current code, and [TODO.md](../TODO.md) the tasks and their progress.

The documents below are in Chinese unless marked **(English)**; English becomes the primary documentation language with the documentation site planned for 0.1. 下列文档除标注 (English) 外均为中文。

## Open-source design

| Document | What it covers |
|---|---|
| [Open-source design](proposals/oss/README.md) | Product definition benchmarked against Magpie, system architecture, the model, agent and run planes, interfaces, data and security, reliability, extensibility, engineering, governance, roadmap and ADR drafts |
| [Roadmap](../ROADMAP.md) **(English)** | Milestones M0–M5 and their acceptance |
| [Package migration](proposals/oss/13-package-migration.md) | OSS-004: dependencies, package mapping, boundary fixes, build and migration steps |
| [Single-executable spike](proposals/oss/sea-spike.md) | OSS-008: how the single executable is built, measured size and cold start, end-to-end checks, blockers, and the retest with every `hh` command (section 10) |

## Using HarnessHub

| Document | What it covers |
|---|---|
| [Features](features/README.md) | Every implemented feature point, grouped by plane: what it does, where to use it, where it is implemented, how far it is verified, its limits and optimization candidates; a summary of the candidates worth looking at first |
| [Quickstart](quickstart.md) | `hh serve`, a provider from a preset (or the fake provider without a key), a Gateway Key, calls from OpenAI or Anthropic clients, usage and wiring an agent |
| [Getting started](getting-started.md) | A fresh clone, ports, data directories, the console's pages, real engines and troubleshooting |
| [Configuration](configuration.md) | `config.jsonc`: settings, precedence (flags, environment, file, defaults), validation, `hh config`, and what stays out of the file |
| [Architecture guide](architecture.md) | Module map, the Run pipeline, configuration and secrets, persistence and recovery |
| [API overview](api/README.md) | Shared conventions, objects, idempotency, streaming and maintenance |
| [Model-plane API and CLI](model-plane-api.md) | `/api/v1`: the admin token, problem errors, providers, credentials, route groups, keys and usage; the SDK and the `hh` commands |
| [Provider presets](provider-presets.md) | The 46 vendor, relay and local presets, choosing regions and plans, verification status and the Magpie source |
| [Subscription accounts](subscriptions.md) | ChatGPT plans through Sign in with ChatGPT, Copilot, the risk notice, loopback-only use, why Claude subscriptions are not offered, allowance readings and the `smart` and `pace` strategies |
| [Provider test and doctor](provider-doctor.md) | `hh provider test` and `hh provider doctor`: per-endpoint tests, 14 checks, plan and cost, proposed patches and `--fix` |
| [HarnessHub for Magpie users](magpie-parity.md) **(English)** | Area-by-area comparison with Magpie `2e340f7` (same, different by design, partial, not covered), and migrating: import links, what does not carry over, one key per agent, and a command map |
| [Importing providers](provider-import.md) | Import links (including Magpie's) and importing from Claude Code and Codex: options, preview and confirmation, safety limits |
| [API reference](api/reference.md) | Every HTTP operation: input and output, call chain, side effects, errors and tests |
| [OpenAPI](api/openapi.json) | The machine-readable API contract generated from the routes |
| [Console](../packages/console/README.md) | Running the console, its pages and states, component sources |
| [Runtime contract](runtime-api.md) | Gateway configuration, Runs and Sessions, execution boundaries |
| [Workflows](workflows.md) | Model planning, human confirmation, routing, dependent steps and failure recovery |
| [Observability](observability.md) | Actual models, tokens, cost sources, timing and evidence coverage |
| [File artifacts](file-artifacts.md) | Collecting outputs, immutable snapshots, downloads and safety limits |
| [Session recovery](session-recovery.md) | Checkpoints, backend identity, suspension and restart |
| [Benchmark](benchmark.md) | Attempts, graders, file fixtures and reports |

## Engines, models and agents

| Document | What it covers |
|---|---|
| [Engine management](engine-management.md) | Registration, file plus overlay, defaults and historical revisions |
| [Engine discovery](engine-discovery.md) | Known harnesses, standard templates, manifests and installation evidence |
| [Engine configuration](engine-configuration.md) | The unified model, providers, models and URLs, secret references, Skills, MCP and configuration checks |
| [Model gateway](model-gateway.md) | Translation between Chat, Responses, Anthropic and Google, upstream normalization, reasoning replay, media, errors, the shared gateway, LAN sharing, the Codex passthrough and keys in the path |
| [Gateway features](gateway-features.md) | Outbound secret redaction and its restoration in tool arguments, vision fallback, web search emulation, image endpoints, tool search and compaction |
| [Engines on the unified model](model-gateway-engines.md) | Each engine's private configuration, defaults and known limits |
| [Global wiring](global-wiring.md) | Pointing the agents installed here at the gateway: preview, backup, atomic writes, restore, drift, the keys each adapter writes, the terminal interface and the agents not covered |
| [Backup, restore and sync](backup-sync.md) | Passphrase-encrypted backups, restoring item by item with agents wired again, and sync between machines through WebDAV or S3 with conflict merging |
| [Compatibility with real agents](compatibility.md) | The conformance suite's results with the real agents installed here, run offline in a sandbox, and the run against a real provider |
| [Library](library.md) | Instructions, MCP servers and Skills synced into agents: ownership, restore, secret references, and why HarnessHub's own credentials may not be referenced |
| [CLI driver](cli-driver.md) | stdin and argv input, text output, exit, cancellation and process cleanup |
| [Installation snapshots](engine-installation.md) | Read-only collection of file hashes and version metadata |
| [Pi](pi-engine.md) | The pinned adapter, its configuration and limits |
| [OpenCode](opencode-engine.md) | Its own configuration and file-task evidence |
| [OpenClaw bridge](openclaw-engine.md) | Native session naming, connection and limits |
| [Tool packs](tool-packages.md) | Installation, simple-format import, SHA-256, Skill, MCP and CLI bindings, and removal |
| [Capability packs](capability-packs.md) | Installing and applying Skills, MCP servers, CLIs and a new engine revision in one step |
| [Native MCP](native-mcp.md) | Pi extensions, OpenClaw's native configuration, Kimi CLI and secret limits |
| [Windows](windows.md) | Native installation, running, secrets and the limits of what is verified |

## Development and governance

- [AGENTS.md](../AGENTS.md): the short rules people and AI coding assistants both follow.
- [Development](development.md): types, module boundaries, errors, resources, compatibility and Git.
- [Testing](testing.md): the change matrix, real entry points and the definition of done.
- [Documentation rules](documentation.md): ownership, examples, links and the generated-documentation checks.
- [Fake provider](../tools/fake-provider/README.md): the strict stand-in upstream for tests and local development: four protocols, field checks, scripts, quirks and request records.
- [Fake proxy](../tools/fake-proxy/index.mjs): local HTTP CONNECT and SOCKS5 proxies, a TLS front and a certificate made at run time, for the outbound-proxy tests and the single-executable check.
- [Contributing](../CONTRIBUTING.md), [governance](../GOVERNANCE.md), [security policy](../SECURITY.md), [code of conduct](../CODE_OF_CONDUCT.md), [support](../SUPPORT.md) and [maintainers](../MAINTAINERS.md) **(English)**.
- [Third-party notices](../THIRD_PARTY_NOTICES.md) **(English)**: third-party code in the repository and its licenses.
- [Decision records](decisions/README.md): architecture choices and their reasons.

## History

The earlier single-model edition's acceptance records, the competition and offline-delivery documents, and the designs of the Windows portable package and the preinstalled tool packs remain on the `archive/competition` branch and are no longer maintained with the open-source edition. Conclusions cited in ADRs refer to that branch's records.
