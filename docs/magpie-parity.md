# HarnessHub for Magpie users

This page compares [Magpie](https://github.com/yetone/magpie) at commit `2e340f7` with HarnessHub's `main` branch as of 2026-10-05, area by area, and then explains how to move from one to the other. HarnessHub reimplements Magpie's model and agent planes in TypeScript ([Relationship to Magpie](../README.md#relationship-to-magpie)), so many rows say "same"; the others say where HarnessHub chose a different design on purpose, or where it has not caught up.

Every row was checked against Magpie's source and against HarnessHub's code or documentation on `main`. The HarnessHub documents linked below are in Chinese unless marked **(English)**.

| Status | Meaning |
|---|---|
| same | Works the same way; the notes list small differences that do not change how you use it |
| different by design | HarnessHub does it another way on purpose; the note or the linked document says why |
| partial | Part of Magpie's behavior exists; the note says which part is missing |
| not covered | HarnessHub has nothing equivalent today |

**Not verified.** Windows is unverified throughout ([Windows](windows.md)). Most adapters that follow Magpie have not been run against the real agent; [compatibility](compatibility.md) lists the agents the conformance suite has run for real. Sync was tested only against fake WebDAV and S3 servers, the Copilot add-on only against a fake SDK, and OTLP export only against a local receiver.

**Console labels.** The web console is in English and Chinese (Settings → Language). This page uses its English names, with the Chinese ones in parentheses: Agents (Agent), Providers (Provider), Subscriptions (订阅账号), Routing and keys (路由与 Key), Usage (用量), Profiles (Profile), Library and Settings (设置). Routing and keys has the tabs Route groups (路由组), Automatic groups (自动路由组), Gateway Keys (Gateway Key), Credential state (凭据状态) and Route decisions (路由决定); Settings has General (通用), Gateway features (网关功能) and Backup and sync (备份与同步).

## Gateway and protocols

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| One local endpoint for Chat Completions, Responses, Anthropic Messages and Gemini; `/v1` optional on the OpenAI and Anthropic paths | same | The daemon's port (default `127.0.0.1:3180`); base URLs in `hh status` and `GET /api/v1/system/info` | The gateway shares the daemon's listener ([shared gateway](model-gateway.md#共享网关)) |
| Passthrough when the provider speaks the client's API, translation otherwise | partial | Automatic from each provider's endpoints; per-provider patches and `translateOnly` | Translation goes through Chat Completions and can also reach Gemini upstreams; there is no per-model list of APIs like Magpie's `usable` ([passthrough and translation](model-gateway.md#直通与转换)) |
| `/v1/models` with window, output limit, reasoning levels, native endpoints, modalities and label; `?format=text`; image and video models | partial | `GET /v1/models`, `/v1/models/{ref}`, `/v1beta/models`, filtered by the caller's Gateway Key | No `max_input_tokens`, `?format=text` or image and video entries; reasoning levels are plain strings ([model listing](model-gateway.md#模型解析与列表)) |
| Anthropic `count_tokens` relayed to an Anthropic upstream, estimated otherwise; Gemini `countTokens` estimated | same | `POST /v1/messages/count_tokens`; the `x-hh-token-count` header says `upstream` or `estimated` | HarnessHub falls back to the estimate on any upstream failure |
| A context overflow rewritten into the client API's own error, so the agent compacts | same | Automatic | Includes Anthropic's `prompt is too long` and Codex's in-stream `response.failed` ([error mapping](model-gateway.md#错误映射)) |
| Image generation and edits (`/v1/images/*`), an automatically chosen drawing model, the `magpie mcp image` server | partial | `hh provider add … --image-endpoint URL`; Settings → Gateway features | The request names a Model Ref or `group/<id>`; no automatic drawing model, no Gemini-native or subscription drawing, no image MCP server ([image generation](gateway-features.md#图像生成)) |
| Video generation (`/v1/videos`) | not covered | — | Out of scope for now ([image generation](gateway-features.md#图像生成)) |
| Web search emulation for upstreams that cannot search | partial | `hh gateway search add tavily\|brave\|exa\|firecrawl\|searxng`; Settings → Gateway features | Search APIs only, no "searching model" ([ADR 0027](decisions/0027-gateway-features.md)); serves Responses `web_search` and Anthropic `web_search_*`, not Chat's `web_search_options` or Gemini's `googleSearch` ([web search](gateway-features.md#联网搜索模拟)) |
| Vision fallback: a vision model describes images for text-only models | partial | `hh gateway vision <ref>\|group/<id>\|off`; Settings → Gateway features | No automatically chosen vision model; without one, images become placeholders where Magpie answers 400 ([vision fallback](gateway-features.md#视觉兜底)) |
| Outbound redaction with reversible placeholders | different by design | On by default; `hh gateway redaction on\|off`, `hh gateway redaction rule add NAME PATTERN` | Redacts only known secrets (Gateway Keys, provider credentials, the admin token, your rules) and restores them only in tool-call arguments; Magpie also pattern-matches JWTs, passwords and personal data ([outbound redaction](gateway-features.md#出站脱敏)) |
| Tool search rewriting (Codex `tool_search`, Claude Code `tool_reference`) | same | Automatic | Also on Responses passthrough ([tool search](gateway-features.md#工具搜索)) |
| Codex compaction: the gateway summarizes `compaction_trigger`, `/responses/compact` answers 400 for gateway models | same | Automatic on `/v1/responses` and the Codex passthrough | HarnessHub strips sealed items on every turn instead of remembering them per session ([compaction](gateway-features.md#上下文压缩)) |
| Codex's ChatGPT sign-in through `/backend-api/codex`: Codex's own requests relayed, gateway models served, lists merged | partial | `hh wire codex --option codexAuth=chatgpt` | Relay, gateway models and the merged list match; HarnessHub does not answer ChatGPT models from a pool of other ChatGPT accounts ([ADR 0025](decisions/0025-magpie-routing-parity.md)) and has no WebSocket handling on this path ([Codex passthrough](model-gateway.md#codex-透传)) |
| Stream keepalive per protocol | different by design | Automatic after 10 s without output | Never SSE comments: openai-node drops them and Codex counts only events, so Chat gets an empty delta and Gemini an empty candidate ([keepalive](model-gateway.md#响应头保活与空闲超时)) |
| Loopback callers may use any token; a key is needed only on the LAN | different by design | Every call needs a Gateway Key: `hh wire` gives each agent one, `hh key create` makes one for scripts | Keys carry a model allow list, budgets and usage attribution ([authentication](model-gateway.md#鉴权与拒绝)); see [one key per agent](#one-key-per-agent) |
| Agents that cannot send an auth header (Command Code, fx, Muse Code) wired with no auth; `GET /muse-code/models` | different by design | `hh wire` writes `<gateway>/k/<agent key>/v1` as their base URL | Needed because HarnessHub always asks for a key; loopback only ([ADR 0033](decisions/0033-gateway-key-in-path.md), [keys in the path](model-gateway.md#路径中的-key)) |

## Routing, route groups and rules

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| Strategies `order`, `rotate` and `usage` | same | `hh group add <id> --member REF… --strategy order\|rotate\|least-used`; Routing and Keys → Route groups | Magpie's `usage` is `least-used`; HarnessHub adds `latency` ([routing](model-gateway.md#路由重试与熔断)) |
| Strategies `smart` (Magpie's default) and `pace` | different by design | `--strategy smart\|pace` | Same thresholds and ordering, but allowance readings come only from rate-limit headers and the Copilot SDK, never from polling vendors' usage endpoints ([allowance readings](subscriptions.md#额度读数与-smartpace)) |
| `manual`: one picked member serves every request | not covered | Ask for the Model Ref directly | |
| A provider's own routing across its keys and accounts, `magpie provider fallback` | partial | A bare Model Ref tries the provider's credentials in order with failover; for a strategy or a fallback model, use a route group | New groups default to `order`, not `smart` |
| Stays: `auto`, `session`, `turn`, `off` | partial | `--stickiness auto\|session\|turn\|off` | Same modes and limits; stays are kept in memory only (Magpie also saves `affinity.json`), the conversation comes from `x-hh-conversation`, `prompt_cache_key` or Anthropic `metadata.user_id`, and a spent allowance does not break a stay |
| Failure classes (proxy, verify, credit, quota, rate) and their rests | same | Automatic; the ledger's `errorClass`; Routing and Keys → Credential state | Same order, word lists and rests; HarnessHub adds auth, model and request classes and opens `other` only after three failures in a row ([ADR 0025](decisions/0025-magpie-routing-parity.md)) |
| A resting candidate moved last, a lone one tried anyway | different by design | Automatic | HarnessHub skips resting credentials, contacts no upstream when all rest, and lets one probe through after the rest ([ADR 0025](decisions/0025-magpie-routing-parity.md)) |
| Failover across candidates, retries on the last one | same | Automatic; a group's `retry` policy through the API | Same 1, 2, 4 s backoff and limits; 400 and 422 refusals (unserved model, refused channel, busy, request shape), safety refusals (an error code or a reply with nothing said, the model's other accounts first) and a too-small `max_tokens` (asked again once with the vendor's floor) fail over as in Magpie, and a 400 that is the client's own fault for every provider never does ([routing](model-gateway.md#路由重试与熔断), [ADR 0025](decisions/0025-magpie-routing-parity.md)); small differences are in [differences](model-gateway.md#与-03-的差异与未实现项) |
| Errors held until the first content event | partial | Automatic (15 s or 1 MiB) | No 4-minute hold for ChatGPT's `safety_buffering` or reasoning-only streams |
| Account pinning with `X-Magpie-Account` | same | `X-HH-Credential: <credential id or name>` | 429 when resting, 400 when it cannot serve, 404 when unknown; never sent upstream |
| Automatic groups `auto-<slug>`; a bare model name resolves to its group | partial | `hh group auto`, `hh group hide\|restore <id>`; Routing and Keys → Automatic groups | No `modelSameAs` merging and no global switch; clients must ask for `group/auto-<slug>` (a bare name is `model_invalid`) and the key must allow it |
| Nested groups (8 deep, cycle check) | same | `--member group/<id>` | |
| Member suffixes `:effort` and `:fast` | partial | `--member openai/gpt-5.5:high:fast` | The fixed effort is sent as written, not fitted to the model's nearest level ([ADR 0031](decisions/0031-group-members-and-key-budgets.md)) |
| A group's advertised window, image input and levels; `context=` and `levels=` overrides | partial | Computed for `/v1/models` and wiring | No `context`, `levels` or `family` fields on a group |
| Group rules (`use`, `tokens`, `images`, `effort`, `agents`, `intent`, `compact`, `time`, `days`) | same | `hh group rule add <id> 'use=… tokens=200k …'`, `list\|remove\|move`; Route groups → rules editor | Magpie's text form, decided per turn, first match wins ([ADR 0032](decisions/0032-group-rules-and-classifier.md)) |
| Classifier model for `intent` and `effort=auto` | same | `hh group rule classifier <id> <ref>\|off`, `hh group rule effort <id> auto\|off` | |
| Decision APIs (System One, Jev; `POST /v1/systemone`) | not covered | — | No decision-API provider kind |
| Route decisions with long polling (`GET /v1/magpie/route`) | partial | `GET /api/v1/routing/decisions?session=&after=&wait=`; Routing and Keys → Route decisions | On the management API, so an agent cannot read it with its own key |
| Per-credential state and allowances, lifting a rest (`/v1/magpie/quotas`) | partial | `GET /api/v1/routing/state`; Routing and Keys → Credential state | Read-only: no lifting a rest by hand, no endpoint for agents |
| Concurrency limit per key or account (`maxConcurrency`) | partial | Fixed at 8 per credential with a queue of 64 | Not configurable; when full HarnessHub answers 429 `busy` and fails over ([limits](model-gateway.md#资源上限)) |

## Providers, presets and import

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| 51 presets, with China sites as separate `-cn` presets | different by design | `hh provider presets`; `hh provider add --preset P [--region R] [--plan P]`; Providers → add from a preset | 46 presets cover 48 of Magpie's 51: the `-cn` pairs became regions, and the three decision APIs are left out ([presets](provider-presets.md#范围与限制)) |
| Regions and plans in one option list | different by design | `--region` and `--plan` | Regions (sites) and plans (products) are separate, each with its own endpoints, key page and model list ([choosing](provider-presets.md#列出与选择)) |
| Header hints, your own endpoint (Azure, remote Magpie), no key for local servers | same | `--base URL`; Providers → add from a preset | HarnessHub enforces required header hints |
| Brand icons, uploaded icons, icons from import links | partial | Preset icons are bundled | No icon for custom providers; an import link's `icon` is never downloaded |
| Several keys per provider, each on or off, optionally limited to one API | same | `hh credential add\|rotate\|remove`; Providers → credentials | Each credential is its own routing candidate |
| A model list per key or account | not covered | — | A credential can be limited to APIs, not to models |
| Live model lists from the vendor | partial | `hh provider models <id> --refresh`; Providers → refresh | One fixed path per API and the first enabled credential; the old list is kept and marked stale on failure. No URL probing or per-key merging |
| models.dev catalog, refreshed daily and earlier for unpriced models | same | Background refresh; `hh catalog status\|refresh` | A snapshot is bundled; `HH_OFFLINE=1` turns background refresh off |
| Metadata filled by a vote on the bare model ID across providers | different by design | `hh model show <ref>` shows each value's source and time | Looks up only the preset's catalog ID and the maker's prefix, never guesses by name ([model metadata](model-plane-api.md#模型元数据)) |
| Per-model overrides of context, output, price and image input, also `provider/*` | same | `hh model set <ref> context=… price.input=…` | HarnessHub adds `reasoning` and `toolcall`; there is no `*/<model>` price |
| Upstream (wire) model names with `*` patterns | partial | `PATCH /api/v1/providers/{id}` with `wire` | No `hh` command or console editor |
| Display names, per-model reasoning levels (`magpie model name\|efforts`), `sameAs` | not covered | — | |
| `magpie://import` and `usemagpie.ai/import#` links, opened from the browser | partial | `hh import '<link>'` or `hh import -`; Providers → import | Magpie links are read as they are; no OS URL handler, so paste the link; an existing ID is skipped, not replaced ([import links](provider-import.md#导入链接)) |
| Import from Claude Code's `settings.json` and Codex's `config.toml` | same | `hh import --from claude-code\|codex [--only TABLE]` | Codex `env_key` becomes a reference to the environment variable ([importing from apps](provider-import.md#从其他应用导入)) |
| Import from CC Switch and Alma; adding an imported key to an existing provider | not covered | — | ([ADR 0023](decisions/0023-provider-presets-and-imports.md)) |
| `magpie provider test` | same | `hh provider test <id> [--model M]`; Providers → test | `hh provider doctor <id> [--deep] [--fix]` adds checks and proposed fixes ([doctor](provider-doctor.md#体检)) |

## Agents and wiring

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| Wiring 35 agents | partial | `hh agents`, `hh wire <agent> <model>`, `hh tui`; Agents | 27 of the 35, each following Magpie's adapter, plus Qwen Code ([supported agents](global-wiring.md#支持的-agent)); the other eight are in the last rows |
| Key-level edits that keep comments, order and other keys in JSON, JSONC, TOML, YAML and dotenv | same | Automatic; every write shows a diff first and asks | ([format-preserving edits](global-wiring.md#格式保真编辑)) |
| An agent's files changed together | same | Automatic | If one write fails, the files already written are put back; a file someone changed in between is left as it is and reported |
| Undo: Magpie puts back the values it replaced (`magpie <agent> default`) | same | `hh unwire <agent>`; Agents → restore | Restores the original bytes when the file is as HarnessHub left it, otherwise takes out only HarnessHub's keys; revokes the agent's key ([backup and safety](global-wiring.md#备份与安全)) |
| Drift: unrouted, replaced, another gateway, and bypassed (the agent was used without the gateway) | partial | `hh agents`; Agents marks drift | No `bypassed` or stale-key drift ([differences](global-wiring.md#与-04-的差异与待做)) |
| Agent files rewritten when the catalog changes | different by design | Automatic (`wiring.autoSync`) | An agent whose files you changed is skipped and reported as drift instead of overwritten ([catalog sync](global-wiring.md#目录同步)) |
| Caller identity from the `magpie-<agent>` token or the User-Agent | different by design | Each agent's own key | No User-Agent header is written; see [one key per agent](#one-key-per-agent) |
| Models shown to an agent, by family, provider or group (`magpie visible`) | partial | `hh wire <agent> --models 'deepseek/*,group/fast'` | No family tags; the console edits only the hidden list |
| Models hidden from an agent | same | `hh agents models <agent> --hide REF --show REF`; Agents → agent detail | HarnessHub also refuses calls to a hidden model (403) ([model lists](global-wiring.md#每个-agent-的模型列表)) |
| Claude Code: main model, Opus, Sonnet, Haiku and Fable tiers, subagent model, `[1m]`, model capabilities and effort | same | `hh wire claude <model> --tier haiku=REF --effort high`; `hh tui` | ([Claude Code](global-wiring.md#claude-code)) |
| A Claude Code tier fixed at its own effort (`<model>:<effort>`) | partial | A one-member route group: `hh group add haiku-high --member REF:high`, then `--tier haiku=group/haiku-high` | The gateway reads `:effort` only on route-group members |
| Codex in API-key mode with a generated model catalog, and in ChatGPT sign-in mode | same | `hh wire codex <model>`; `hh wire codex --option codexAuth=chatgpt [--no-model]` | In ChatGPT mode the key is part of the base URL path ([ADR 0030](decisions/0030-codex-chatgpt-mode-models.md), [Codex modes](global-wiring.md#codex-的两种模式)) |
| Codex's ChatGPT models narrowed to those picked for the subscription | not covered | — | ChatGPT's list is shown as returned, followed by the key's models |
| Claude Desktop | partial | `hh wire claude-desktop <model>` | Models appear as `claude-hh-…` aliases; no aliases that bring up Desktop's effort selector, and small Desktop requests such as titles are not sent back to the chosen model (Magpie's `desktopTurn`) |
| DeepSeek Harness (dsh) | different by design | `hh wire dsh <model>` | Writes `settings.yaml` and `.env` once; Magpie rewrites each profile's `cordis.patch.yml` every 30 s. A model picked inside dsh is drift |
| Command Code, fx and Muse Code | different by design | `hh wire commandcode\|fx\|muse <model>` | The key goes in the base URL path, loopback only ([ADR 0033](decisions/0033-gateway-key-in-path.md)) |
| A restart notice only when the agent is running | partial | Every write ends with "Restart running … sessions" | No check whether the agent is running, and no per-agent wording yet |
| Goose, Cursor, Copilot CLI and Devin (their own models only) | not covered | — | Magpie does not route them through its gateway either |
| Antigravity CLI, OpenHanako, Alma and Cindy | not covered | — | Wired through a launch command, a running app's API or an import link, not a file ([agents not covered](global-wiring.md#支持的-agent)) |
| Agents inside WSL | not covered | — | |

## Subscriptions

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| ChatGPT accounts through Codex CLI's client ID and identity | different by design | `hh subscription login chatgpt`; Subscriptions | Uses OpenAI's Sign in with ChatGPT for open-source apps and the public Responses API, with no borrowed client identity ([ChatGPT](subscriptions.md#chatgptsign-in-with-chatgpt)) |
| Codex's own ChatGPT-signed-in requests passed through | same | `hh wire codex --option codexAuth=chatgpt` | HarnessHub never holds that sign-in ([Codex passthrough](model-gateway.md#codex-透传)) |
| GitHub Copilot accounts through the editors' client ID | different by design | `hh subscription setup copilot [--install]`, `hh subscription login copilot [--token]` | Drives your Copilot CLI through the official Copilot SDK, with the CLI's sign-in or a fine-grained token; not verified with the real SDK ([Copilot](subscriptions.md#github-copilot)) |
| Claude Pro and Max accounts through the `claude` binary | different by design | Use an Anthropic API key | Anthropic does not allow third parties to route requests through these plans ([Claude](subscriptions.md#claude-订阅)) |
| Gemini CLI and Antigravity accounts | not covered | — | Magpie signs in with these CLIs' own Google client IDs, which HarnessHub does not borrow ([ADR-P09](proposals/oss/adr-drafts.md#adr-p09-订阅复用进核心)); Antigravity CLI can still run as a HarnessHub task engine with its own sign-in |
| Cursor, Kiro, Grok, Devin, Qoder, ZCode, WorkBuddy, Zed, MiMo, Factory and Command Code accounts, and OpenCode auth plugins | not covered | — | There is no plugin host yet |
| Several accounts per subscription, sign in again, sign out | same | `hh subscription list`, `hh subscription login chatgpt --account ID`, `hh subscription logout <provider> <account>` | Each account is a credential of the subscription provider |
| Importing sign-ins from other tools; switching an agent's own sign-in (`magpie accounts switch`) | different by design | — | HarnessHub reads no other app's credentials and never changes an agent's sign-in ([common rules](subscriptions.md#共同规则)) |
| Allowances polled from vendors' usage endpoints; `magpie quota` | different by design | Routing and Keys → Credential state; `GET /api/v1/routing/state` | Readings only from rate-limit headers and the Copilot SDK; ChatGPT accounts have none; no CLI view ([ADR 0026](decisions/0026-subscription-accounts.md)) |
| Balances of API-key relays | not covered | — | |
| Warm-up requests, spending Codex reset credits, switching to the next account | different by design | — | Left out on purpose ([ADR 0026](decisions/0026-subscription-accounts.md)) |
| Quota and balance alerts (`magpie quota alert`) | not covered | — | |
| A risk notice before adding an account | different by design | `hh subscription notice`; shown before every sign-in | A notice for each kind of account, versioned; an account accepted under an older version is not used until accepted again |
| Subscription accounts used from the LAN | different by design | — | LAN keys never reach subscription providers, since vendors' terms forbid sharing |

## Usage and observability

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| A record per call: provider, models asked for, sent and served, tokens by kind, duration, time to first token, status, error class, endpoint | same | The `model.call` ledger; `GET /api/v1/model-calls`; Usage → recent calls | HarnessHub adds each attempt, applied patches and the finish reason ([ledger](model-gateway.md#账本)) |
| The record also keeps the effort, the vendor's request ID, the forwarding computer and Codex subtask kinds | not covered | — | The effort is recorded only when a route group fixes it |
| Upstream key or account, caller key and agent on every call | same | `hh usage --by credential\|key\|adapter`; Usage | Agent attribution says whether it comes from the agent's key or was inferred |
| Sessions from `X-Magpie-Session` or the agent's own header, stored as sent | different by design | `x-hh-conversation`, else the client's ID, else a hash of the opening; `hh usage --by conversation`; Usage → Conversations | Only a hash scoped to the key is stored |
| Cost estimates, subscriptions priced at the maker's list price | partial | Prices from model metadata; `hh model set <ref> price.input=…` | No `*/<model>` price or maker fallback; subscription calls have no cost ([cost](observability.md#费用语义)) |
| Past costs priced again when a price changes | different by design | — | The ledger keeps what each call cost when it ran; a new price applies to later calls |
| Unknown prices kept apart from zero | same | Usage shows unpriced calls separately | |
| Totals by agent, model, key, account and session | same | `hh usage --by model\|provider\|day\|key\|adapter\|credential\|conversation` | Days in UTC; USD only |
| CSV export | partial | JSON only: `hh usage --json`, `GET /api/v1/model-calls` | |
| OTLP trace export | same | `otlp` in `config.jsonc` or `hh serve --otlp-config FILE` | Off by default ([OTLP export](observability.md#otlp-导出)) |
| OTLP metrics, and request and reply bodies for tools such as Langfuse | not covered | — | Prompts and replies are never exported |
| Request archive to S3, request bodies, agents' session files (`magpie sessions`) | not covered | — | The ledger keeps no prompt text |
| Charts over time, usage in the menu bar | partial | Usage tables | No charts |

## Backup and sync

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| A passphrase-sealed backup file (PBKDF2-SHA256 at 600,000 rounds, AES-256-GCM) | same | `hh backup [--no-keys] [file]`; Settings → Backup and sync | Same parameters; the file format is HarnessHub's own, so Magpie backups cannot be opened ([file format](backup-sync.md#文件格式)) |
| Contents: providers and keys, route groups, profiles, agents' model settings, the Library | same | `hh backup` | Agents are saved as wiring choices and wired again on restore ([contents](backup-sync.md#备份的内容)) |
| All settings, uploaded icons, search APIs, provider order | partial | LAN sharing and catalog settings; the gateway features (redaction and its rules, the vision model, search backends with their keys) | No uploaded icons or provider order; startup settings in `config.jsonc` stay out ([contents](backup-sync.md#备份的内容)) |
| Gateway keys exported in full | different by design | Only each client key's name, allow list, budgets and expiry; `hh restore` prints the `hh key create` options | Key text is never stored; restored agents get new keys |
| `--no-keys` leaves out credentials and secret-looking headers | same | `hh backup --no-keys` | Same pattern for header names |
| Library MCP secrets in plain text, blanked by `--no-keys` | different by design | Secrets are references; a stored value travels only with keys | ([Library secrets](library.md#秘密)) |
| `backup --no-library`, `restore --no-agents --no-library` | partial | `hh restore --no-agents --no-library` | `hh backup` cannot leave the Library out |
| Restore: replace or add providers, keep local keys, list providers that need a key | same | `hh restore <file>` shows a summary, then asks | Library entries are replaced one by one instead of as a whole ([restore](backup-sync.md#恢复)) |
| WebDAV and S3 sync every 3 minutes with backoff | same | `hh sync webdav on <url> …`, `hh sync s3 on s3://bucket …`, `hh sync status\|now\|off` | Tested against fake servers only ([sync](backup-sync.md#同步)) |
| Three-way merge per part, conflict copies, mirrored deletions, conditional writes | same | Automatic | Parts: providers, agents, profiles, library, gateway features; providers a live key or group still uses are kept; redaction turned off by another machine is called out ([sync](backup-sync.md#同步)) |
| A settings part, `library=no`, usage shared across machines | partial | `keys=yes\|no`, `agents=yes\|no` | Settings are left out on purpose (they could turn on LAN sharing elsewhere); usage is not shared |
| Sync secrets in `sync.json`, a lock across processes | different by design | Secret-store references; one daemon owns the data directory | Keeps the sync password and passphrase out of plain files ([differences](backup-sync.md#与-magpie-的差异)) |

## LAN sharing and Gateway Keys

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| LAN sharing by binding the gateway to all interfaces | different by design | `hh gateway share on --host IP [--port N] [--public-base-url URL]`, `share status\|off`; Settings → General | A separate listener serves only the model paths; the management API is not on it ([LAN sharing](model-gateway.md#局域网共享), [ADR 0021](decisions/0021-gateway-lan-sharing.md)) |
| Remote callers need a named gateway key | same | `hh key create --name N --allow REF… --lan --expires-at TIME` | A LAN key must expire; the console's key form (Routing and keys › Gateway Keys) has the same LAN option |
| Key text kept and shown again later | different by design | Shown once (`hhk_…`); only a hash is stored | A copied data directory or backup holds no usable key |
| Rename, disable, rotate and remove keys | partial | `hh key list\|create\|quota\|limit\|revoke`; Routing and Keys → Keys | No rename, disable or rotate for client keys (agents: `hh wire <agent> --rotate`); client keys expire after 90 days by default |
| Public URL behind a reverse proxy (`MAGPIE_PUBLIC_URL`) | same | `--public-base-url` | Also widens the accepted Host header |
| Budgets per key in local calendar windows, tokens or cost | same | `hh key create … --budget day:tokens=N,cost=USD,cache-reads`, `hh key quota <id> --budget … --rpm N` | Several budgets per key (one per period) plus requests per minute ([CLI](model-plane-api.md#cli)) |
| Reservation per request, 429 with `Retry-After` when over | same | Automatic | The reset time is in `x-hh-limit-reset` |
| A key reads its own limit (`GET /v1/magpie/limit`) | same | `GET /v1/harnesshub/limit` with the key; admins use `hh key limit <id>` | ([ADR 0032](decisions/0032-group-rules-and-classifier.md)) |
| Another instance as an upstream, with its groups | same | `hh provider add <id> --preset harnesshub-remote --base URL` with the remote's LAN key; `--preset magpie-remote` for a Magpie | Each API goes to the remote's same endpoint, so translation happens there ([another HarnessHub](model-gateway.md#另一台-harnesshub-作为上游)) |
| Image and video models across instances | not covered | — | |
| The calling agent and computer shown across instances | not covered | — | The remote records only the LAN key |

## Library

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| Instructions in a managed block of each agent's instruction file | same | `hh library add instructions <id> --file F --agent a,b`, then `hh library sync`; Library | Warns about edits inside the block ([ownership](library.md#归属与还原)) |
| One shared text plus extra text per agent | partial | Several instruction sets, one per agent | No per-agent addition on top of a shared text |
| MCP servers in each agent's own format | same | `hh library add mcp <name> --command …\|--http URL\|--sse URL` | Unsupported transports are refused ([locations](library.md#各-agent-的位置)) |
| Skills linked into agents, copied where links are unavailable | same | `hh library add skill <dir>`, `hh library sync [--copy]` | Skills are checked against the Agent Skills format on import |
| About 30 agents plus WSL twins | partial | Nine: Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode, Pi, Crush, Kimi Code, Hermes | |
| Records what was written, backs files up, removes only its own parts | same | Automatic | Previews and asks first, and refuses if a file changed after the preview |
| Taking over an agent's own same-name skill (`use-library`, `keep-own`) | partial | Conflicts are refused and reported | |
| MCP secrets in plain text | different by design | Secrets are references (environment, file, secret store); HarnessHub's own credentials cannot be referenced | ([secrets](library.md#秘密)) |
| A market of MCP servers and skills, GitHub installs with update checks | not covered | Local folders and uploads | |
| Project-level MCP servers and skills | not covered | — | |
| Importing existing MCP servers, skills and instructions from agents and CC Switch | not covered | — | |
| RTK hooks | not covered | — | |

## Profiles

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| Named profiles: save, use, list, delete | same | `hh profile save\|apply\|list\|show\|rm`; `s` and `p` in `hh tui`; Profiles | ([profiles](global-wiring.md#profile)) |
| A snapshot of every detected agent, empty fields meaning "back to the agent's default" | partial | Saves the wired agents' model, tiers, effort and options | Agents outside the profile stay as they are; a profile cannot unwire an agent |
| The Library setup in a profile | not covered | — | |
| Apply only what differs, stop at the first error | same | `hh profile apply <name>` shows each agent's diff, then asks | Each switched agent gets a new key |
| Profiles in backups and sync | same | Automatic | |

## Terminal UI and console

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| Desktop app | not covered | The web console and `hh tui` | |
| Menu-bar icon, quick panel, usage in the tray | not covered | — | |
| Browser version (`magpie web`), also for WSL or a remote server | different by design | The daemon serves the console; `hh console` prints a one-time sign-in link | The management API accepts only loopback connections, so there is no remote console ([console](../packages/console/README.md#运行)) |
| Pages for agents, providers, routing, keys, usage, sessions, library and settings | partial | Agents, Providers, Subscriptions, Routing and Keys, Usage, Profiles, Library, Settings | No page for agents' own session files ([pages](../packages/console/README.md#页面与状态)) |
| Terminal agents screen: a row per agent, a searchable picker, `s` and `p` for profiles | same | `hh tui` | Adds refresh, unwire, new key, the diff before writing and a fold for agents not found ([terminal UI](global-wiring.md#终端界面)) |
| Other terminal pages (providers, routing, usage, sessions, library), `S` to sync | not covered | `hh catalog refresh` | |
| English and Chinese | partial | The console is in English and Chinese ([ADR 0034](decisions/0034-console-languages.md)); `hh` and `hh tui` are in English only | |
| Omarchy status-bar widget | not covered | — | |

## Packaging and operations

| Magpie capability | HarnessHub status | How in HarnessHub | Notes |
|---|---|---|---|
| One small native binary | partial | Run from source (`pnpm install && pnpm build`, then `hh serve`) | A single-executable prototype builds and passes its checks on five platforms at 98–131 MB, but is not released ([single executable](proposals/oss/sea-spike.md#1-结论)) |
| Downloads for macOS, Windows and Linux, an install script, a signed Mac app | not covered | — | Packages are planned ([release engineering](proposals/oss/10-engineering.md#5-发布工程)) |
| Self-update | not covered | — | |
| Updating the agents' own CLIs | not covered | — | |
| Start at login | not covered | Start `hh serve` yourself | |
| Telemetry: one anonymous event a day, on by default | different by design | — | HarnessHub sends no telemetry ([privacy](proposals/oss/07-data-security.md#8-隐私与遥测)) |
| One `settings.json` for everything | different by design | `config.jsonc` for startup settings (`hh config show\|get\|set\|unset`); everything else in the data directory | The config file refuses secret values ([configuration](configuration.md#启动设置与运行时设置)) |
| Portable mode, XDG directories | partial | `--data-dir`, `--config-dir`, `XDG_CONFIG_HOME` | No portable marker file |
| Docker image, `magpie healthcheck` | partial | `GET /health/live` and `GET /health/ready` | No image yet |
| Outbound proxy (a setting, `*_PROXY`, the system proxy) and a proxy per provider | partial | `network.proxy` and `network.noProxy` in `config.jsonc`, `hh serve --proxy URL\|direct`, `HTTPS_PROXY` and `NO_PROXY`; `hh provider proxy <id> URL\|direct\|default` | HTTP, HTTPS and SOCKS5 proxies, the password as a secret reference; loopback and private networks stay direct. The system proxy settings are not read, the environment wins over the file (Magpie's setting wins over the environment), and there is no proxy per subscription account ([outbound proxy](configuration.md#出站代理)) |
| macOS, Windows and Linux | partial | Node 24 on all three; CI on each | Windows is unverified |

## Migrating from Magpie

### Before you start

- **Both can run at once.** HarnessHub's gateway is on the daemon's port (`127.0.0.1:3180` by default), Magpie's on `3425`. Move one agent at a time if you like.
- **Give each agent to one of them.** First run `magpie <agent> default` (or turn routing off in Magpie's app), so Magpie puts your own settings back, then `hh wire <agent> <model>`. HarnessHub backs up the files as it finds them and `hh unwire` restores exactly that; if Magpie's settings are still there, unwiring brings Magpie's routing back. While both manage the same agent, each rewrite by Magpie shows up in HarnessHub as drift.
- **Nothing is read from Magpie's data.** HarnessHub does not read Magpie's `settings.json`, its backup files (same encryption, different format) or its WebDAV and S3 folder.

### Providers

- **Magpie import links work as they are.** `hh import 'magpie://import?preset=moonshot-cn&key=…'` or the `https://usemagpie.ai/import#…` form shows what it will add and asks; `hh import - < link.txt` keeps the key out of your shell history, and `--yes` skips the question. Magpie's preset IDs are mapped (`moonshot-cn` becomes `moonshot` in its `cn` region, `qwen` becomes `dashscope`, `google` becomes `gemini-openai`, `remote-magpie` becomes `magpie-remote`); links to the three decision APIs are refused ([import links](provider-import.md#导入链接)).
- **Other providers: add them again.** Magpie cannot export a provider as a link, so add each one by preset, `hh init` or the console: `printf '%s' "$KEY" | hh provider add --preset deepseek --credential-from-stdin`. Most preset IDs are the same as Magpie's; `hh provider presets` lists them. Keys never go on the command line.
- **Upstreams set directly in Claude Code or Codex**: `hh import --from claude-code` or `hh import --from codex`. While Magpie still routes that agent, its settings point at Magpie's gateway and the import would offer Magpie itself as a custom provider; decline it, or run `magpie <agent> default` first.
- **Keep a Magpie as an upstream while you move**: `printf '%s' "$MAGPIE_KEY" | hh provider add magpie --preset magpie-remote --base http://<address>:3425 --credential-from-stdin`, where the key is one of that Magpie's gateway keys (needed when it runs on another computer with LAN sharing on). Its models then appear under the `magpie/` prefix.
- **Route groups and rules** are created again with `hh group add` and `hh group rule add`; rules take Magpie's text form, and Magpie's `usage` strategy is `least-used`.

### What does not carry over

| Magpie | In HarnessHub |
|---|---|
| Subscription sign-ins | Sign in again: `hh subscription login chatgpt` or `hh subscription login copilot`. Claude, Gemini CLI, Antigravity and the other built-in or plugin subscriptions are not offered (see [Subscriptions](#subscriptions)) |
| The desktop app, menu-bar icon and quick panel | The web console (`hh console` prints a sign-in link) and `hh tui` |
| Agents inside WSL | Not covered; wire agents on the system HarnessHub runs on |
| Gateway keys, profiles, Library, usage history, settings | Created again: `hh key create`, `hh profile save`, `hh library add`; usage starts empty |
| `magpie-<agent>` tokens and keyless local calls | Refused; see below |

### One key per agent

Magpie's loopback gateway accepts any token: agents are wired with `magpie` or `magpie-<agent>`, which only says who is calling, and any local script can call it without a key. In HarnessHub every model call needs a Gateway Key:

- `hh wire <agent>` issues an `agent:` key for that agent alone and writes it into the agent's own configuration. Codex in ChatGPT mode, Command Code, fx and Muse Code get it in the base URL path instead, accepted on loopback only ([ADR 0033](decisions/0033-gateway-key-in-path.md)).
- The key decides which models the agent may use (`--models`, `hh agents models --hide`), and usage is attributed by key rather than by User-Agent.
- `hh wire <agent> --rotate` replaces the key; `hh unwire <agent>` restores the files and revokes it.
- Scripts and other clients need a client key, shown once: `hh key create --name scripts --allow 'deepseek/*'`. Client keys expire after 90 days unless you give `--expires-at` or `--no-expiry`.
- Requests carrying a Magpie token, or no token, get 401.

The key in an agent's file is a real credential, but it is limited to that agent's models and budgets and can be revoked on its own ([global wiring](global-wiring.md#守护进程与-key)).

### Command map

| Magpie | HarnessHub |
|---|---|
| `magpie`, `magpie web` | `hh serve`, then `hh console` |
| `magpie tui` | `hh tui` |
| `magpie ls`, `magpie agents`, `magpie <agent>` | `hh agents` |
| `magpie <agent> <model>` | `hh wire <agent> <model>` (or `hh use <agent> <model>`) |
| `magpie <agent> effort high` | `hh wire <agent> --effort high` |
| `magpie <agent> default` | `hh unwire <agent>` |
| `magpie save`, `use`, `profiles`, `rm` | `hh profile save`, `apply`, `list`, `rm` |
| `magpie models <agent>`, `magpie visible <agent> …` | `hh agents models <agent> [--hide REF] [--show REF]`, `hh wire <agent> --models …` |
| `magpie providers`, `magpie presets` | `hh provider list`, `hh provider presets` |
| `magpie provider add <preset> <key>` | `hh provider add --preset <preset> --credential-from-stdin` |
| `magpie provider key <id>` | `hh credential add\|rotate\|remove <provider> …` |
| `magpie provider models\|test\|rm <id>` | `hh provider models <id> --refresh`, `hh provider test <id>`, `hh provider remove <id>` |
| `magpie provider fallback <id> <model>…` | A route group: `hh group add <id> --member … --strategy order` |
| `magpie import <link>` | `hh import <link>` |
| `magpie search add <api> <key>` | `hh gateway search add <api> --key-from-stdin` |
| `magpie groups`, `magpie group add … routing=… stays=…` | `hh group list`, `hh group add <id> --member … --strategy … --stickiness …` |
| `magpie accounts`, `magpie accounts add` | `hh subscription list`, `hh subscription login chatgpt\|copilot` |
| `magpie quota` | Routing and Keys → Credential state |
| `magpie gateway-key list\|add\|remove` | `hh key list\|create\|revoke` |
| `magpie gateway-key limit <id> …` | `hh key quota <id> --budget …`, `hh key limit <id>` |
| `magpie usage` | `hh usage --by …` |
| `magpie sync` | `hh catalog refresh`, `hh provider models <id> --refresh` |
| `magpie backup`, `magpie restore` | `hh backup`, `hh restore` (files are not interchangeable) |
| `magpie webdav …`, `magpie s3 …` | `hh sync webdav on …`, `hh sync s3 on …` |
| `magpie library …` | `hh library add\|rm\|sync …` |
| `magpie serve`, `magpie healthcheck` | `hh serve`, `GET /health/ready` |
| `magpie model name\|efforts`, `magpie sessions`, `magpie mcp image`, `magpie plugin`, `magpie update`, `magpie autostart`, `magpie usage --csv` | Not covered |
