# HarnessHub

**An open-source control plane for coding agents.** Wire any agent to any model, run agents headless through one API, and keep the evidence of every model call.

[中文说明](README.zh-CN.md) · [Design](docs/proposals/oss/README.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> **Status: pre-release (milestone M0, open-source reset).** There is no published release yet. The code runs from source, and interfaces will change before 0.1. The [roadmap](docs/proposals/oss/12-roadmap-migration.md) lists what each milestone delivers.

## What it is

Developers increasingly use several coding agents at once — Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code and others. HarnessHub manages them from one place:

- **Model plane**: a local gateway that speaks the OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Gemini protocols, so every agent can use the model you choose.
- **Agent plane**: wires the coding agents installed here to the gateway by editing their own configuration in place (preview, backup, drift detection and restore), and syncs instructions, Skills and MCP servers to them.
- **Run plane**: runs agents headless through a REST + SSE API, with sessions, runs, permission round-trips, deadlines, cancellation, file artifacts and durable event logs.

The [product definition](docs/proposals/oss/01-product.md) compares HarnessHub with [Magpie](https://github.com/yetone/magpie) and other projects in this space. The main difference: HarnessHub runs agents and records verifiable evidence, instead of only switching their configuration.

## Relationship to Magpie

HarnessHub's model and agent planes reimplement, in TypeScript, what [Magpie](https://github.com/yetone/magpie) by yetone (MIT) does in Go, checked against Magpie's source at commit `2e340f7`, and add the run plane and its evidence on top. Thanks to the Magpie project for the design and the field-level knowledge of each agent.

- **Covered:** the gateway's four protocols with passthrough and translation, routing, retries and route groups; 48 of Magpie's 51 provider presets ([taken from Magpie](THIRD_PARTY_NOTICES.md) with its MIT notice); global wiring of 27 of Magpie's 35 agents (plus Qwen Code), each following Magpie's adapter for that agent; profiles, per-agent model lists, the terminal interface, subscription accounts (ChatGPT and Copilot), LAN sharing, backups and sync.
- **Different by design:** every agent gets its own Gateway Key (Magpie's loopback gateway takes any token), and a file the user changed is reported as drift rather than rewritten.
- **Not covered:** agents Magpie switches only to their own models (Goose, Cursor, Copilot CLI, Devin), and Antigravity CLI, OpenHanako, Alma and Cindy ([why](docs/global-wiring.md)); agents inside WSL; Magpie's desktop app (HarnessHub has a web console and `hh tui` instead).

HarnessHub's own code is MIT licensed; code and data taken from other projects keep their licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What works today

The code base comes from an earlier, single-model edition of HarnessHub and is being reshaped milestone by milestone. Today it provides:

| Area | Current behavior |
|---|---|
| Execution | Durable Sessions and Runs in SQLite, serialized per Session; SSE replay from committed events; idempotent submission; deadlines and cancellation; permission requests; declared file outputs as immutable artifacts; JSONL export |
| Agents | Global wiring of 28 agents (`hh init`, `hh wire`, `hh tui` and the console's Agents page): each gets its own Gateway Key in its own configuration file, with a preview, backups, drift detection and restore ([global wiring](docs/global-wiring.md)); for headless runs, ACP and CLI drivers with per-Session private configuration |
| Model gateway | A shared gateway on the daemon port for any OpenAI, Anthropic or Gemini client and for headless runs: providers from presets or by hand, route groups, Gateway Keys with model allowlists, passthrough to native endpoints or translation between the four protocols, and a `model.call` ledger with usage and cost |
| Tools | Tool packs with Skills, MCP servers and CLI tools, stored by content hash and bound per agent |
| Process supervision | One Worker process per Session; process groups on POSIX and Job Objects on Windows; restart recovery |
| Console | A web console served by the daemon itself on the same port (React + Vite): agents, providers, subscription accounts, routing and keys, usage, profiles, the Library and settings, plus tasks, engines, tools and observability for headless runs. Sign-in uses one-time links from `hh console`; the browser never holds the admin token |

A single-executable build of `hh` (`pnpm test:sea`) runs on macOS arm64; other platforms are not built yet, and no release is published.

## Quick start (from source)

Requirements: Git, Node.js 24.20.0 and pnpm 10.12.3. The repository's `.node-version` names the Node version for version managers that read it (fnm, nodenv, Volta); with another Node, pnpm warns "Unsupported engine". Node 24 includes Corepack, so `corepack enable` provides the pinned pnpm (or `npm install -g pnpm@10.12.3`). On macOS, the Xcode Command Line Tools (`swiftc`) build the Keychain helper; on Windows, the system .NET Framework builds the native helpers.

```sh
git clone https://github.com/wyzz973/HarnessHub.git   # about 500 MB of history; add --depth 1 to try it out
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
pnpm exec hh serve
```

`pnpm install` may report "Ignored build scripts: @google/genai, protobufjs"; those packages only serve the test suites, so there is nothing to approve. `hh serve` listens on `127.0.0.1:3180` and keeps its data in `./data` (`--port` and `--data-dir` change them; every `hh` command then needs the same `--data-dir`). It logs JSON lines and prints `Console: http://127.0.0.1:3180/#login=…`: a one-time sign-in link, valid once for 60 seconds, to open in a browser on the same machine. For a new link, run `pnpm exec hh console` in a second terminal.

In a second terminal, `pnpm exec hh init` sets up the rest: it adds a provider from a preset with its key, refreshes its models, and wires the agents installed here to a default model after showing every change together. For a local server on another address than the preset's (vLLM, LM Studio or Ollama elsewhere), give it with `--base`. Without an API key, the [quickstart](docs/quickstart.md#没有-api-key-时) shows how to try everything against a local stand-in. `pnpm exec hh tui` then shows every agent with its model, tiers and effort in the terminal: pick a model from a searchable list, review the file changes and apply them, or save and apply profiles.

To use the model gateway from any OpenAI or Anthropic client: add a provider from a preset (`hh provider add --preset deepseek --credential-from-stdin`), create a Gateway Key (`hh key create --name me --allow 'deepseek/*'`) and point the client at `http://127.0.0.1:3180/v1` (Anthropic: `http://127.0.0.1:3180`). The [quickstart](docs/quickstart.md) walks through it.

The console is in Chinese for now. It opens on the **Agent** page: every agent installed here with its model; pick a model to preview and apply the wiring. **Provider**, **路由与 Key** (routing and keys) and **用量** (usage) manage the model plane. Headless runs live under **任务** (tasks), with the unified model (统一模型), engines (引擎), tools (工具) and observability (观测); see the [getting started guide](docs/getting-started.md) for data directories, real agents and troubleshooting. Secrets are stored as references (Keychain, DPAPI, environment variable or file), never as plain values in configuration files.

`pnpm start` starts the same daemon without the `hh` command, which also runs `benchmark`, `tools` and `rollout` ([apps/hh](apps/hh/README.md)).

```sh
pnpm check   # build, lint, tests (with the protocol suite), API and docs checks, console build
pnpm bench   # gateway latency, per-chunk cost, 200 streams and ledger commits against the M1 targets
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
