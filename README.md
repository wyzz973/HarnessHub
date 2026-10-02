# HarnessHub

**An open-source control plane for coding agents.** Wire any agent to any model, run agents headless through one API, and keep the evidence of every model call.

[中文说明](README.zh-CN.md) · [Design](docs/proposals/oss/README.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> **Status: pre-release (milestone M0, open-source reset).** There is no published release yet. The code runs from source, and interfaces will change before 0.1. The [roadmap](docs/proposals/oss/12-roadmap-migration.md) lists what each milestone delivers.

## What it is

Developers increasingly use several coding agents at once — Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code and others. HarnessHub manages them from one place:

- **Model plane**: a local gateway that speaks the OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Gemini protocols, so every agent can use the model you choose.
- **Agent plane**: discovers installed agents and prepares their configuration, Skills and MCP servers.
- **Run plane**: runs agents headless through a REST + SSE API, with sessions, runs, permission round-trips, deadlines, cancellation, file artifacts and durable event logs.

The [product definition](docs/proposals/oss/01-product.md) compares HarnessHub with [Magpie](https://github.com/yetone/magpie) and other projects in this space. The main difference: HarnessHub runs agents and records verifiable evidence, instead of only switching their configuration.

## What works today

The code base comes from an earlier, single-model edition of HarnessHub and is being reshaped milestone by milestone. Today it provides:

| Area | Current behavior |
|---|---|
| Execution | Durable Sessions and Runs in SQLite, serialized per Session; SSE replay from committed events; idempotent submission; deadlines and cancellation; permission requests; declared file outputs as immutable artifacts; JSONL export |
| Agents | ACP and CLI drivers; discovery of installed agents (OpenCode, Codex, Qwen Code, Gemini CLI, Pi, MiMo, DSH, OpenClaw, Kimi, Hermes and more); per-Session private configuration, so user configuration files are never modified |
| Model gateway | One configured upstream model (OpenAI-compatible streaming Chat Completions); Responses, Anthropic Messages and Gemini requests are translated; every call is recorded as a `model.call` event |
| Tools | Tool packs with Skills, MCP servers and CLI tools, stored by content hash and bound per agent |
| Process supervision | One Worker process per Session; process groups on POSIX and Job Objects on Windows; restart recovery |
| Console | A local web console (Next.js) for tasks, models, tools, agents and observability |

Multi-provider routing, global agent wiring, the single-binary build and the new console are planned for 0.1–0.3 and are not implemented yet.

## Quick start (from source)

Requirements: Git, Node.js 24.20.0 and pnpm 10.12.3. On macOS, the Xcode Command Line Tools (`swiftc`) build the Keychain helper; on Windows, the system .NET Framework builds the native helpers.

```sh
git clone https://github.com/wyzz973/HarnessHub.git
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
pnpm start --port 3180 --data-dir ./data/local
```

In a second terminal, start the console and open <http://127.0.0.1:3330>:

```sh
HARNESSHUB_GATEWAY_URL=http://127.0.0.1:3180 pnpm start:console
```

Configure a model on the **Model** page and register installed agents on the **Engines** page. Discovery never installs anything. Secrets are stored as references (Keychain, DPAPI, environment variable or file), never as plain values in configuration files. The [getting started guide](docs/getting-started.md) covers data directories, real agents and troubleshooting.

```sh
pnpm check   # build, lint, tests, API and docs checks, console build
```

## Documentation

| Topic | Where |
|---|---|
| Open-source design: product, architecture, planes, security, engineering, governance | [docs/proposals/oss](docs/proposals/oss/README.md) |
| Current architecture and runtime contract | [DESIGN.md](DESIGN.md) · [architecture guide](docs/architecture.md) |
| HTTP API | [API overview](docs/api/README.md) · [reference](docs/api/reference.md) · [OpenAPI](docs/api/openapi.json) |
| Development and testing | [development](docs/development.md) · [testing](docs/testing.md) · [documentation rules](docs/documentation.md) |
| All documents | [docs index](docs/README.md) |

Most documentation is currently written in Chinese. English becomes the primary documentation language with the documentation site planned for 0.1.

## Project

- **License:** [MIT](LICENSE).
- **Maintenance:** HarnessHub is owned by [@wyzz973](https://github.com/wyzz973). Day-to-day development and maintenance are carried out by an AI maintainer (Claude) under the owner's authorization, as described in [GOVERNANCE.md](GOVERNANCE.md). Every change goes through the same automated checks.
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`).
- **Security:** report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- **Not affiliated:** HarnessHub is not affiliated with the GitHub organization `HarnessHub`, with Harness Inc., or with the vendors of the agents and models it works with. Product names are used only to describe compatibility; see [TRADEMARKS.md](TRADEMARKS.md).
- **History:** the earlier single-model edition and its release artifacts remain available on the `archive/competition` branch.
