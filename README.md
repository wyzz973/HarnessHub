# HarnessHub

**An open-source control plane for coding agents.** Wire any agent to any model, run agents headless through one API, and keep the evidence of every model call.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Design](docs/proposals/oss/README.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> **Status: pre-release (milestone M0, open-source reset).** There is no published release yet. The code runs from source, and interfaces will change before 0.1. The [roadmap](docs/proposals/oss/12-roadmap-migration.md) lists what each milestone delivers.

## What it is

Developers increasingly use several coding agents at once — Claude Code, Codex, Gemini CLI, OpenCode, Qwen Code and others. HarnessHub manages them from one place:

- **Model plane**: a local gateway that speaks the OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Gemini protocols, so every agent can use the model you choose, with per-key model allowlists and a ledger of every call.
- **Agent plane**: wires the coding agents installed here to the gateway by editing their own configuration in place (preview, backup, drift detection and restore), and syncs instructions, Skills and MCP servers to them.
- **Run plane**: runs agents headless through a REST + SSE API, with sessions, runs, permission round-trips, deadlines, cancellation, file artifacts and durable event logs.

The [product definition](docs/proposals/oss/01-product.md) (in Chinese) compares HarnessHub with [Magpie](https://github.com/yetone/magpie) and other projects in this space. The main difference: HarnessHub runs agents and records verifiable evidence, instead of only switching their configuration.

## Relationship to Magpie

HarnessHub's model and agent planes reimplement, in TypeScript, what [Magpie](https://github.com/yetone/magpie) by yetone (MIT) does in Go, checked against Magpie's source at commit `2e340f7`, and add the run plane and its evidence on top. Thanks to the Magpie project for the design and the field-level knowledge of each agent.

- **Covered:** the gateway's four protocols with passthrough and translation, routing, retries and route groups; 48 of Magpie's 51 provider presets ([taken from Magpie](THIRD_PARTY_NOTICES.md) with its MIT notice); global wiring of 27 of Magpie's 35 agents (plus Qwen Code), each following Magpie's adapter for that agent; profiles, per-agent model lists, the terminal interface, subscription accounts (ChatGPT and Copilot), LAN sharing, backups and sync.
- **Different by design:** every agent gets its own Gateway Key (Magpie's loopback gateway takes any token), and a file the user changed is reported as drift rather than rewritten.
- **Not covered:** agents Magpie switches only to their own models (Goose, Cursor, Copilot CLI, Devin), and Antigravity CLI, OpenHanako, Alma and Cindy ([why](docs/global-wiring.md), in Chinese); agents inside WSL; Magpie's desktop app (HarnessHub has a web console and `hh tui` instead).

[HarnessHub for Magpie users](docs/magpie-parity.md) compares the two area by area, with the gaps, and explains how to migrate.

HarnessHub's own code is MIT licensed; code and data taken from other projects keep their licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What works today

The code base comes from an earlier, single-model edition of HarnessHub and is being reshaped milestone by milestone. Today it provides:

| Area | Current behavior |
|---|---|
| Model gateway | A shared gateway on the daemon port for any OpenAI, Anthropic or Gemini client and for headless runs: providers from 46 presets or by hand, route groups with rules, Gateway Keys with model allowlists and budgets, passthrough to native endpoints or translation between the four protocols, failover, and a `model.call` ledger with usage and cost |
| Agents | Global wiring of 28 agents (`hh init`, `hh wire`, `hh tui` and the console's Agent page): each gets its own Gateway Key in its own configuration file, with a preview, backups, drift detection and restore ([global wiring](docs/global-wiring.md), in Chinese); profiles; a Library of instructions, MCP servers and Skills synced into nine agents |
| Accounts and sharing | ChatGPT plans (Sign in with ChatGPT) and GitHub Copilot as subscription providers for agents on this computer; LAN sharing, and another HarnessHub as an upstream |
| Execution | Durable Sessions and Runs in SQLite, serialized per Session; SSE replay from committed events; idempotent submission; deadlines and cancellation; permission requests; declared file outputs as immutable artifacts; JSONL export; ACP and CLI drivers with per-Session private configuration |
| Tools | Tool packs with Skills, MCP servers and CLI tools, stored by content hash and bound per agent |
| Operations | `config.jsonc` with `hh config`; encrypted backups, restore and WebDAV/S3 sync; OTLP export of model calls; one Worker process per Session, with process groups on POSIX and Job Objects on Windows, and restart recovery |
| Console | A web console served by the daemon itself on the same port (React + Vite), in English and Chinese. Sign-in uses one-time links; the browser never holds the admin token |

A single-executable build of `hh` (`pnpm test:sea`) runs on macOS arm64; other platforms are not built yet, and no release is published. Windows support is implemented but not yet verified on Windows.

## Install from source

Requirements: Git, Node.js 24.20.0 and pnpm 10.12.3. The repository's `.node-version` names the Node version for version managers that read it (fnm, nodenv, Volta); with another Node, pnpm warns "Unsupported engine". Node 24 includes Corepack, so `corepack enable` provides the pinned pnpm (or `npm install -g pnpm@10.12.3`). On macOS, the Xcode Command Line Tools (`swiftc`) build the Keychain helper; on Windows, the system .NET Framework builds the native helpers.

```sh
git clone https://github.com/wyzz973/HarnessHub.git   # about 500 MB of history; add --depth 1 to try it out
cd HarnessHub
pnpm install --frozen-lockfile
pnpm build
pnpm build:console
```

`pnpm install` runs no dependency build script but esbuild's; those of `@google/genai` and `protobufjs` (only the test suites use them, and HarnessHub needs nothing they do) are declined in `package.json`, so it asks about none. The commands below run from the repository root; `pnpm exec hh` is the `hh` command ([apps/hh](apps/hh/README.md)).

## Quickstart

### 1. Start the daemon

```sh
pnpm exec hh serve
```

It listens on `127.0.0.1:3180` and keeps its data in `./data` (`--port` and `--data-dir` change them; every `hh` command then needs the same `--data-dir`, and `--url` for another port). It logs JSON lines and prints `Console: http://127.0.0.1:3180/#login=…`, a one-time sign-in link for the console. Provider keys go to the system's secret store (Keychain on macOS, DPAPI on Windows, an encrypted file elsewhere; `--secrets-backend file` uses the encrypted file everywhere) and are kept only as references. Leave it running and open a second terminal.

### 2. Add a provider and wire your agents

`pnpm exec hh init` walks through it: it adds a provider from a preset with its API key (asked for without echo), refreshes its models, lists the agents installed here, and, after showing every agent's file changes together, wires them to the default model you pick. Without a terminal, options give the answers:

```sh
pnpm exec hh init --preset deepseek --credential-from-env DEEPSEEK_API_KEY \
  --agents claude,codex --model deepseek/<model> --yes
```

`pnpm exec hh provider presets` lists the presets (vendors, relays and local servers) and `pnpm exec hh provider models <provider>` the models of one, as `provider/model`. For a local server (vLLM, LM Studio or Ollama) the wizard asks for its address, and Enter keeps the preset's; without a terminal, give another one with `--base`. A provider of the preset's id that is here already is used as it is; options that differ from it are listed, and asked about in a terminal.

**Without an API key**, the repository's fake provider ([tools/fake-provider](tools/fake-provider/README.md), in Chinese) stands in for one. It calls no real model, listens on loopback only and answers every request with fixed text, which is enough to try every step here. In another terminal:

```sh
HH_FAKE_KEY=sk-test-only node tools/fake-provider/index.mjs --key-env HH_FAKE_KEY --port 8790
```

Then use it as a vLLM preset's server:

```sh
HH_FAKE_KEY=sk-test-only pnpm exec hh init --preset vllm --base http://127.0.0.1:8790 \
  --credential-from-env HH_FAKE_KEY --agents codex --model vllm/upstream-sim --yes
```

### 3. Call a model through the gateway

```sh
HH_KEY=$(pnpm exec hh key create --name me --allow 'vllm/*')
curl http://127.0.0.1:3180/v1/chat/completions \
  -H "Authorization: Bearer $HH_KEY" -H 'content-type: application/json' \
  -d '{"model":"vllm/upstream-sim","messages":[{"role":"user","content":"Hello"}]}'
pnpm exec hh usage --by model --since 1d
```

`hh key create` prints a Gateway Key once; `--allow` limits the models it may use. OpenAI clients use `http://127.0.0.1:3180/v1` as their base URL, Anthropic and Gemini clients `http://127.0.0.1:3180`, with the Gateway Key as their API key; `hh status` prints these addresses. The gateway accepts loopback connections only unless [LAN sharing](docs/model-gateway.md#局域网共享) (in Chinese) is turned on. Every call, refused ones included, is recorded in the ledger behind `hh usage`.

### 4. Agents

```sh
pnpm exec hh agents                         # the agents here: installed, wired, model, drift
pnpm exec hh wire codex vllm/upstream-sim   # show the file changes, confirm, wire
pnpm exec hh tui                            # the same in the terminal: models, tiers, effort, profiles
pnpm exec hh unwire codex                   # restore its files and revoke its key
```

Wiring backs up the agent's own configuration files, writes a key that belongs to that agent alone, and reads the files back. Running agent sessions pick the change up when they restart. In a terminal, `wire`, `unwire` and every other command that changes files or settings ask first; without one (a script, CI or another agent's shell) they show the changes, stop with "No terminal to confirm; pass --yes" (exit 4) and change nothing, so add `--yes` there, as the `hh init` examples above do. Which files and keys each of the 28 agents gets, and the safety rules, are in [global wiring](docs/global-wiring.md) (in Chinese).

### 5. The console

Open the sign-in link that `hh serve` printed, or get a new one with `pnpm exec hh console`; each link works once, for 60 seconds, in a browser on the same computer. The console is in English and Chinese: it follows the browser's language until you choose one under **Settings → Language**, which this browser then keeps. It opens on the **Agents** page: every agent installed here with its model; pick a model to preview and apply the wiring. **Providers**, **Subscriptions**, **Routing and keys**, **Usage**, **Profiles**, **Library** and **Settings** (language, gateway features, backup and sync) cover the rest. Headless runs live under **Tasks**, with engines, tools and observability; a task can pick a gateway model in the composer, and the deprecated unified model page appears only while a legacy source is configured; the [getting started guide](docs/getting-started.md) (in Chinese) covers them, data directories and troubleshooting.

`pnpm start` starts the same daemon without the `hh` command.

## CLI overview

`hh --help` lists the commands and `hh <command> --help` describes one.

| Commands | What they do |
|---|---|
| `serve`, `version`, `config`, `status`, `console` | Start the daemon, print the build, show or edit `config.jsonc`, show the running daemon, sign in to the console |
| `init` | Add a provider from a preset and wire the agents installed here in one go |
| `provider`, `import`, `credential`, `model`, `catalog` | Providers from presets or by hand, import links, their keys, model metadata and the models.dev catalog; `provider test` and `provider doctor` check a provider |
| `key`, `group`, `usage`, `gateway` | Gateway Keys and their budgets, route groups and their rules, usage from the ledger, LAN sharing and gateway features |
| `subscription` | Sign a ChatGPT or Copilot account in for agents on this computer |
| `agents`, `wire` (`use`), `unwire`, `profile`, `tui` | Global wiring of the agents installed here |
| `library` | Instructions, MCP servers and Skills, synced into agents |
| `backup`, `restore`, `sync` | Encrypted backups, and sync through WebDAV or S3 |
| `benchmark`, `tools`, `rollout` | Benchmarks of headless runs, Tool Packs and rollout export |

## Development

```sh
pnpm check              # build, lint, tests (with the protocol suite), API and docs checks, console build
pnpm bench              # gateway latency, per-chunk cost, 200 streams and ledger commits against the M1 targets
pnpm test:conformance   # the real agents installed here, wired and run offline in a sandbox (macOS)
```

[AGENTS.md](AGENTS.md), [development](docs/development.md) and [testing](docs/testing.md) (in Chinese) hold the rules every change follows.

## Documentation

Most documentation is in Chinese; English becomes the primary documentation language with the documentation site planned for 0.1. The [documentation index](docs/README.md) describes every document in English.

| Topic | Where (in Chinese unless noted) |
|---|---|
| Quickstart, configuration and the console | [quickstart](docs/quickstart.md) · [configuration](docs/configuration.md) · [getting started](docs/getting-started.md) · [console](packages/console/README.md) |
| Model gateway, providers and keys | [model gateway](docs/model-gateway.md) · [model-plane API and CLI](docs/model-plane-api.md) · [provider presets](docs/provider-presets.md) · [gateway features](docs/gateway-features.md) |
| Agents | [global wiring](docs/global-wiring.md) · [Library](docs/library.md) · [compatibility with real agents](docs/compatibility.md) |
| HTTP API | [API overview](docs/api/README.md) · [reference](docs/api/reference.md) · [OpenAPI](docs/api/openapi.json) (machine-readable) |
| Design and architecture | [open-source design](docs/proposals/oss/README.md) · [DESIGN.md](DESIGN.md) · [architecture guide](docs/architecture.md) · [decision records](docs/decisions/README.md) |
| Project (in English) | [roadmap](ROADMAP.md) · [changelog](CHANGELOG.md) · [governance](GOVERNANCE.md) · [support](SUPPORT.md) · [maintainers](MAINTAINERS.md) |

## Project

- **License:** [MIT](LICENSE). Third-party code and data keep their own licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Maintenance:** HarnessHub is owned by [@wyzz973](https://github.com/wyzz973). Day-to-day development and maintenance are carried out by an AI maintainer (Claude) under the owner's authorization, as described in [GOVERNANCE.md](GOVERNANCE.md). Every change goes through the same automated checks.
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`).
- **Security:** report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- **Not affiliated:** HarnessHub is not affiliated with the GitHub organization `HarnessHub`, with Harness Inc., or with the vendors of the agents and models it works with. Product names are used only to describe compatibility; see [TRADEMARKS.md](TRADEMARKS.md).
- **History:** the earlier single-model edition and its release artifacts remain available on the `archive/competition` branch.
