> 2026-11-14 原生接入调研（只读）。T3 Code 源码：github.com/pingdotgg/t3code @ d19467a5；文中 `/private/tmp/…/scratchpad/` 下的路径是调研时的临时目录。

# OpenClaw and Hermes Agent: native driver research (read-only, 2026-11-14)

Scope: which official programmatic interface HarnessHub should drive for **OpenClaw 2026.10.9** and **Hermes Agent v0.22.5**, replacing today's ACP paths (`src/adapters/control/openclaw.ts`, `src/adapters/control/hermes.ts`, `hermes-gateway.ts`). T3 Code supports neither, so this starts from the products' own sources and docs.

## TL;DR

| | OpenClaw | Hermes Agent |
|---|---|---|
| Richest official interface | **Gateway WebSocket protocol, wire v4** (`ws://127.0.0.1:18789`), the documented path for external apps, with MIT reference packages `@openclaw/gateway-client` and `@openclaw/gateway-protocol` (2026.10.9 published) | **Canonical gateway WebSocket `hermes-gateway-v1`** (JSON-RPC 2.0 at `<api_origin>/api/ws`), bootstrapped through the same-user control socket `~/.hermes/gateway.sock`. The Desktop, Ink TUI, classic CLI and `hermes acp` itself all use it |
| What `acp` is today | A thin bridge process: one more WS client of the Gateway, built for IDEs | A viewer that translates ACP onto `hermes-gateway-v1` (`acp_adapter/gateway_server.py`) |
| Recommendation | Replace ACP plus `openclaw gateway call` with **one persistent Gateway WS connection per Hub process**, authenticated by a Hub-owned paired device | Replace `hermes acp` plus the file preflight, the `state.db` reads and the CLI export with **one canonical WS connection**: `identify`, then `session-ticket`, then WS |
| Biggest gains | Real session `cwd` (today it is never stored: see A5), steer with pending/cancel semantics, `ask_user` questions, plugin approvals, plan/patch/usage/compaction events, fork, rewind, branches, diff, titles, LLM compaction, no CLI process per RPC, no reading `openclaw.json` | True steer and redirect (they never fall back to a new turn), exact admission receipts and unknown-outcome handling, effort/model/rename/compress/rewind/branch as fenced mutations, usage and cost from the protocol, export, checkpoints, no `hermes acp` Python process, and an authoritative live `identify` instead of guessing the gateway's state from files |
| Main risks | A large, fast-moving surface (additive within v4); needs `operator.admin` for full mode, arbitrary cwd, compact and rewind; the Gateway also serves Feishu and Weixin, so never call `send`/`message.*`/`conversations.*` and never set `deliver` | The protocol is Hermes's own surface for its own clients, not a promise to third parties; the turns run inside the gateway that also serves the user's messaging bots; `source: "acp"` is needed to get per-session MCP and edit approvals |

---

## Method and limits

- Read: the installed OpenClaw package `/opt/homebrew/lib/node_modules/openclaw` (`docs/`, `dist/`), the Hermes checkout `~/.hermes/hermes-agent` (install stamp commit `bf0203a7…`, `baseVersion 0.22.5`), the Hub's adapters, the earlier research pages, and `ProviderAdapter.ts` from T3 Code.
- Ran: `openclaw --version/--help`, `openclaw gateway --help`, `openclaw gateway call --help`; `hermes --version/--help`, `hermes acp|mcp|serve --help`; `npm view` (metadata only) for `@openclaw/gateway-client` and `@openclaw/gateway-protocol`; `gh api` reads of release lists, one Hermes source file and the v0.23.1 OpenRPC contract; `ps`/`lsof`, which are read-only.
- **One read-only call to a running daemon**: Hermes's control-socket verb `identify` (a pure read: `gateway/run_bootstrap.py:293-308`). Only non-secret keys were printed. I made **no** call to the OpenClaw Gateway, because `openclaw gateway call` can trigger a scope-upgrade pairing write (`docs/cli/acp.md:143`).
- Config: I read **key names only** in `~/.openclaw/openclaw.json`, plus the non-secret values `port`, `bind`, `mode` and `auth.mode`. No token values were read or printed. Nothing was started, stopped or changed. I sent no message and ran no Turn.
- Unless a path says otherwise, OpenClaw citations are relative to the package root (`docs/…`, `dist/…`), and Hermes citations are relative to the checkout.

---

# Part A — OpenClaw 2026.10.9

## A1. Interfaces in the installed version

| Interface | What it is | Fit for driving coding sessions |
|---|---|---|
| **Gateway WS protocol v4** | "The single control plane" for every client: CLI, web UI, apps, nodes (`docs/gateway/protocol.md:11-26`). External apps are told to use it: "External apps talk to OpenClaw through the Gateway protocol … start agent runs, stream events, wait for results, cancel work" (`docs/gateway/external-apps.md:13-55`). Constants: `PROTOCOL_VERSION = 4`, `MIN_CLIENT_PROTOCOL_VERSION = 4` (`dist/version-CwNT1gaY.mjs:3-9`); the online docs also say v4 today. There are about 517 core methods with scopes (`dist/core-method-policy-DkntKRY_.mjs`), and the TypeBox schemas are bundled (`dist/src-D6kL8tMP.mjs`, `dist/sessions-CLLc4meF.mjs`) | **Richest. Officially supported** ("Ready", external-apps.md:35-42). `@openclaw/gateway-client`/`-protocol` are MIT; the docs pin 2026.8.1 as "verified stable" (`docs/gateway/clients.md:19-36`), and `2026.10.9`, matching the install, is published on npm |
| `openclaw acp` | An ACP bridge over stdio that "forwards prompts to the Gateway over WebSocket … focuses on session routing, prompt delivery, and streaming updates" (`docs/cli/acp.md:9-53`). Several areas are Partial or Unsupported (matrix at acp.md:28-43) | A subset of the above (see A5) |
| `openclaw gateway call <method> --json` | A one-shot CLI RPC: each call is its own process and its own WS connection | Fine for scripts; this is what the Hub uses today for 8 methods (`openclaw.ts:19`, `:360-366`) |
| `openclaw agent --json` | A one-shot agent Turn through the Gateway (`docs/cli/agent.md`) | Fire-and-forget only, with no stream controls |
| HTTP: OpenAI `/v1/chat/completions`, OpenResponses, `/tools/invoke`, Admin HTTP RPC plugin | Compatibility surfaces (`docs/gateway/openai-http-api.md`, `openresponses-http-api.md`, `tools-invoke-http-api.md`) | Chat-shaped: no approvals or session controls |
| `openclaw mcp serve` | Exposes **channel conversations** to an MCP client, including `messages_send` (`docs/cli/mcp.md:11-33`) | Not for coding, and it can send outbound |
| Plugin SDK `openclaw/plugin-sdk/*` | For code that runs **inside** OpenClaw; "External apps should not import" it (external-apps.md:320-340) | No |

## A2. Process model, reaching it, auth, identity

- **One long-lived daemon that everything shares**: `dist/index.js gateway --port 18789`, started by launchd (pid 48658, up since 2026-11-01, listening on `127.0.0.1:18789` and `[::1]:18789`). Config: `gateway.mode=local`, `bind=loopback`, `auth.mode=token`; the channels configured are `feishu` and `openclaw-weixin` (key names only). The same process serves channels, cron, nodes, the Control UI and every operator client. Every ACP bridge, every `gateway call` and any Hub connection is just another client of it.
- **Frames**: `{type:"req",id,method,params}`, `{type:"res",id,ok,payload|error}`, `{type:"event",event,payload,seq?}` (`docs/gateway/protocol/transport.md:56-60`). The first frame must be `connect`. After `hello-ok`, the client honours `policy.maxPayload` (25 MiB) and `policy.attachments` (20 MB; images 6 MB) (`docs/gateway/protocol/handshake.md:67-126`). Side-effecting methods take idempotency keys (transport.md:177).
- **Handshake and auth** (handshake.md:14-92; `docs/gateway/protocol/auth.md:14-56`):
  1. Wait for the `connect.challenge` event with `{nonce, ts}`.
  2. Send `connect` with `minProtocol=maxProtocol=4`, `role:"operator"`, `scopes`, `caps`, `auth.token` (the shared gateway token, only for the first bootstrap) and a `device` (an Ed25519 key that signs the v3 payload, including the nonce).
  3. `hello-ok` returns `auth.deviceToken` and the effective scopes.
  - **Pairing**: loopback connections are approved silently, including role and scope upgrades (`docs/gateway/pairing.md:229-252`). Scope upgrades also need the shared token on that connection (`docs/gateway/config-gateway.md:222`). After that, the Hub reconnects with its stored device token.
  - **Do not** use the reserved device-less `gateway-client` backend path (auth.md:144-162).
- **Where the secret lives**: `gateway.auth.token` in `~/.openclaw/openclaw.json` is present as a plaintext string (type checked; value not read). `OPENCLAW_GATEWAY_TOKEN` env is the documented alternative. `openclaw gateway auth-token` reveals it; never print it. Recommended bootstrap: read it once in memory, either from the config the driver already parses (`openclaw.ts:282-292`) or from the env, without logging it. Pair a **HarnessHub device** (its own key in the Hub's data directory), then use only the device token. The docs say not to hand-edit `openclaw.json` to mint tokens (clients.md:72-94); the Hub writes nothing there.
- **Scopes the Hub needs**: `operator.read`, `operator.write`, `operator.approvals` and `operator.questions`. Add `operator.admin` for `permissionMode:"full"` (`docs/gateway/permission-modes.md:30`), a `cwd` outside the agent workspaces (`sessions.create.cwd` description, `dist/src-D6kL8tMP.mjs:1566-1569`), `sessions.compact`, `sessions.rewind`, `sessions.reset` and `sessions.branches.switch` (`dist/core-method-policy-DkntKRY_.mjs:1227,1308,1320`). The existing ACP bridge already holds admin (the CLI's default scope set, earlier page `docs/research/openclaw-2026.10-upgrade-readiness-2026-10-22.md:87`).
- **Identity model**: session keys are `agent:<agentId>:<rest>`; the Hub keeps `agent:<id>:harnesshub:<uuid>` (`openclaw.ts:21`). Rows carry `sessionId` (the transcript generation under the key), `parentSessionKey`, `forkSource`, `createdVia/createdActor` (`docs/gateway/protocol/rpc-session-control.md:45`). Runs have a `runId` with a per-run `seq` (clients.md:176-205).
- **Readiness and restarts**: `connect` can return a retryable `UNAVAILABLE` `startup-sidecars`. A `shutdown` event with `restartExpectedMs` comes before close code 1012 (`docs/gateway/embedding.md:91-126`). After a reconnect the client re-subscribes and rebuilds from `chat.history.inFlightRun` (clients.md:153-205).

## A3. Capability map (Gateway WS)

| Need | Native mechanism (scope) | Notes |
|---|---|---|
| Create session | `sessions.create {key, agentId, cwd, model, thinkingLevel, fastMode, permissionMode, toolOverrides, label, displayName, titleSource, category, parentSessionKey, fork, worktree, message?, attachments?}` (dynamic scope; `dist/src-D6kL8tMP.mjs:1503-1570`) | Atomic: model, permission mode and cwd are set **before** the first Turn, so no follow-up `sessions.patch` is needed. `worktree:true` provisions a managed worktree |
| Resume | Address the existing `key`; `sessions.describe`/`sessions.resolve` (read); `chat.history` with `inFlightRun` after reconnect | No bridge-side "resume" is needed: the session lives in the Gateway |
| Send Turn (text + images + files) | `chat.send {sessionKey, message, attachments[{type,mimeType,fileName,content}], thinking, fastMode, queueMode, timeoutMs, expectedPermissionMode, idempotencyKey}` (write; `dist/sessions-CLLc4meF.mjs:2376-2459`). `sessions.send` is a simpler alternative. The `agent` RPC also takes `cwd`, `extraSystemPrompt` and `disableMessageTool` (`dist/src-D6kL8tMP.mjs:2706-2765`) | Images are bounded by `policy.attachments`. Non-image file handling "depends on the entrypoint and the resolved model" (clients.md:143-151): **unconfirmed** |
| Streaming | `chat` events (`delta` with `deltaText`/`replace`, `final`, `aborted`, `error` with `errorKind`/`errorDetail`, `status` phases; sessions-CLLc4meF.mjs:2490-2585). `agent` events with `stream` ∈ lifecycle, assistant, thinking, tool, item, patch, plan, command_output, compaction, usage, approval, run_status, error (stream names emitted in `dist/*.mjs`; tool events need cap `tool-events`, clients.md:119-124). `session.message`, `session.tool`, `session.approval` and `sessions.changed` via `sessions.messages.subscribe` / `sessions.subscribe` (`docs/gateway/protocol/rpc-bootstrap-and-events.md:96-200`) | Use one text projection: `chat`, or `agent` assistant text, not both (rpc-bootstrap-and-events.md:180-196). Advertise `chat-only-assistant-text` if `chat` is used |
| Steer | `chat.send {queueMode:"steer"}`: "atomically injects the message into that session's direct active run, or starts a new turn when the session is idle". Each input keeps its own `runId`. A still-pending steer can be withdrawn with `chat.abort({sessionKey, runId})` (rpc-session-control.md:67; `docs/concepts/queue-steering.md:134-165`) | The Hub must check `hasActiveRun/activeRunIds` first; when the steer falls back to a follow-up, the Hub can withdraw it. This maps to T3's `steer.updated` pending/completed/cancelled |
| Interrupt | `chat.abort {sessionKey, runId?}` / `sessions.abort {key, runId?, clearQueued?}` (write) | Terminal `chat` `aborted` with `stopReason` |
| Approvals | `exec.approval.requested/resolved`, `plugin.approval.requested/resolved`, `session.approval` (with `includeApprovals`), `exec.approval.list/resolve`, `plugin.approval.resolve` (`operator.approvals`); caps `exec-approvals`, `plugin-approvals`, `approvals` (`docs/gateway/protocol/operator-methods.md:301-314`; clients.md:329-335) | Backfill with `exec.approval.list` after `hello-ok` |
| Questions (`ask_user`) | `question.requested/resolved` events; `question.list/get/resolve` (`operator.questions`) (`docs/tools/ask-user.md:85-130`) | The ACP bridge has **no** question handling (0 matches in `dist/server-DNoj34fZ.mjs`), so today an `ask_user` waits 900 s and the agent gets `no_answer` |
| Hub levels | `permissionMode`: read-only / guarded / workspace / full (`dist/sessions-row-NKWz9YsI.mjs:76-81`; permission-modes.md table). plan→read-only, ask→guarded, auto_edit→guarded, auto→workspace (the Hub auto-allows what escalates), full→full (admin) | As in `flavors/openclaw.ts:13-23`, but set at create, and `chat.send.expectedPermissionMode` fences each Turn. OpenClaw has **no edit approvals** |
| Model / effort / provider | `models.list {sessionKey?, view, includeDetails}` (input modalities, `available`, `unavailableReason`; operator-methods.md:112-170); `sessions.create/patch {model:"provider/model", thinkingLevel, fastMode}`. The patch receipt reports the resolved model (rpc-session-control.md:55-56) | Removes the need to read `models.providers.*.input` from `openclaw.json` (`openclaw.ts:298-313`) |
| Fork | `sessions.fork {sessionKey, entryId}` (write; returns `sessionKey` plus editor text) or `sessions.create {parentSessionKey, fork:true, forkFrom:"last-completed"}` (sessions-CLLc4meF.mjs:3051-3070) | Refused for externally-harness-owned conversations (`docs/web/control-ui/chat.md:443`) |
| Rollback | `sessions.rewind {sessionKey, entryId}` (admin). It "moves chat context only — files … are not reverted" (chat.md:443). Plus `sessions.branches.list/switch` | No file checkpoints. Worktree sessions get `sessions.diff {scope: all\|uncommitted\|commit}` (read; chat.md:446) |
| Compact | `sessions.compact {key, maxLines?}` (admin): LLM summary without `maxLines`, truncation with it; returns `tokensBefore/After` (`docs/cli/sessions.md:522-570`). `compaction` agent stream; history rows `kind:"compaction"` (clients.md:269-283) | The earlier note that it "only truncates" is out of date |
| Usage / cost | `usage` on `chat` final/delta and the `usage` agent stream; `sessions.usage`, `usage.cost` (read; embedding.md:133-139). `sessions.changed` rows carry usage | No need to rebuild usage from the transcript (`openclaw.ts:136-188`) |
| List / read sessions | `sessions.list/subscribe` (rich filters, `ownerFirst`, compact rows); `chat.history` (paged, `deltaCursor`, `__openclaw.id/seq`), `chat.message.get`, `sessions.get`, `sessions.preview` | The "no import of OpenClaw's own sessions" rule (`openclaw.ts:391-397`) stays a product decision, not a missing interface |
| Titles | `sessions.create.displayName/titleSource`; `sessions.title.prepare` (write); `sessions.patch {label}`; `sessions.changed` reason `chat.title` (rpc-session-control.md:72-75) | |
| MCP / Hub tools | `sessions.patch/create.toolOverrides` only toggles MCP servers that are **already configured** (`sessions-row-NKWz9YsI.mjs:108-113`). Nodes can publish agent-visible MCP tools (`node.pluginTools.update`, `docs/nodes/mcp-and-skills.md`), but those are global, for every agent and channel. `agent.extraSystemPrompt` gives per-run instructions | There is no per-session MCP injection, so keep today's "Hub tools as a CLI the agent runs" (`flavors/openclaw.ts:29-38`). `extraSystemPrompt` (via the `agent` RPC) could replace first-prompt instructions; scope and behaviour **unconfirmed** |
| Workspace / cwd | `sessions.create.cwd` (admin outside the agent workspaces), `worktree`, `worktreeBaseRef`, `execNode`; the permission modes confine file tools to `sessionRoot` | See A5: today's Hub sessions never get their cwd |
| Skills / commands | `skills.status`, `commands.list {agentId, scope, includeArgs}`, `tools.catalog`, `tools.effective {sessionKey}` (read; operator-methods.md:16-70). Slash commands go in as `chat.send` text | |
| Subagents / background | `sessions.list {spawnedBy}`, `childSessions`, `sessions.processes.list/stop` (core-method-policy table, "2026.9") | |

## A4. Event model mapped to hh/1 Turns and items

| OpenClaw | hh/1 (`src/contracts/protocol.ts`) |
|---|---|
| `chat.send` ack `{runId, status, messageSeq?}` (`messageSeq` only when the input is committed, rpc-session-control.md:69) | Turn `queued`/`preparing`; input recorded once `messageSeq` is present, which replaces the transcript-seq guess in `openclaw.ts:526-596` |
| `chat` `status` (phases waiting_for_state … starting_model) | Turn `preparing` |
| `agent` lifecycle `start/finishing/end/error` | Turn `running` → terminal |
| `chat` delta/final (`message`, `deltaText`, `replace`) | `assistant_message` (append or replace) |
| `agent` `thinking` | `reasoning` |
| `agent` `tool` start/update/result (`toolCallId`, `name`, `args`, `partialResult`, `result`, `isError`) | Work items by name: exec/bash→`command`, read→`file_read`, write/edit/apply_patch→`file_change`, web_search/fetch→`web`, sessions_spawn→`subagent`, others→`tool` (today's TOOL_KIND, `openclaw.ts:126`) |
| `agent` `patch` (`added/modified/deleted`, `itemId`) | `file_change.changes` |
| `agent` `command_output` | Command output delta (T3 `command_output.delta`) |
| `agent` `plan` (progress_card) | `plan` |
| `agent` `compaction`, history `kind:"compaction"`/`"reset"` | `context_event` compaction/clear |
| `agent` `usage`, `chat` final `usage` | `TurnUsage` (+ `cost` when the provider prices it) |
| `exec.approval.*`, `plugin.approval.*`, `session.approval` | `approval` (subject command/tool; decision allow-once/allow-always/deny) |
| `question.requested/resolved` | `question` |
| `chat` `error` (`errorKind` refusal/timeout/rate_limit/context_length/state_contention + `errorDetail.httpStatus`) | `error` with class, stopReason `error`/`refusal` |
| `chat` `aborted` | Turn `cancelled`, stopReason `user_stopped` |
| `sessions.changed` (title, model, permissionMode, activeRunIds) | Conversation metadata, title, `switch` facts |

Ordering: the per-run `payload.seq` orders the stream within a run, and the outer `seq` orders the connection. A gap means: reload `chat.history` (clients.md:176-205; transport.md:73-92).

## A5. Today's ACP path: what it gets, what it misses

The Hub runs `openclaw acp` and also spawns `openclaw gateway call` processes for `agents.list`, `models.list`, `sessions.patch`, `sessions.get`, `sessions.list`, `chat.history`, `skills.status` and `tools.catalog` (`openclaw.ts:19`, `:360-366`). It also reads and parses `openclaw.json` itself (`:282-320`).

**What it gets:**
- text, and thinking (from the bridge's `chat` projection);
- live tool calls (the bridge sends `tool-events`, `dist/server-DNoj34fZ.mjs:2594`);
- exec approvals, only while a prompt is active (`server-DNoj34fZ.mjs:880-1000`);
- the thought level and other bridge options, and images;
- the model and permission mode, through extra CLI calls;
- usage, tools and the real stop reason, rebuilt after the Turn from `sessions.get` (`openclaw.ts:136-188`, `547-598`).

**What it misses (confirmed in source):**
1. **The session's `cwd` is never stored.** The bridge calls `sessions.create {key, cwd}` only when the client gives no explicit key; the Hub always gives `_meta.sessionKey`, so the create is skipped (`server-DNoj34fZ.mjs:1676-1691`). Hub Turns run with the agent's workspace as `sessionRoot` and only a text prefix `[Working directory: …]` (`openclaw.ts:252-256`; the flavor comment admits it, `flavors/openclaw.ts:4-8`).
2. `ask_user` questions: not relayed at all.
3. Plugin approvals: not relayed; the bridge advertises only `exec-approvals` and `tool-events`.
4. Steer: none (`flavors/openclaw.ts:35-38`). The bridge's prompt cancels running work before it admits another prompt.
5. Fork, rewind and branches: not declared by the bridge.
6. Plan, patch/diff, compaction, `command_output`, `item` and lifecycle streams: dropped by the bridge, which only handles the `approval` and `tool` agent streams (`server-DNoj34fZ.mjs:899-910`).
7. Usage: only "approximate, no cost" (acp.md:51), so the Hub rebuilds it from the transcript.
8. Titles: none (`openClawRelayCapabilities.title:"none"`).
9. Per-session MCP: rejected by the bridge (acp.md:41).
10. Cost: one Node CLI start plus a WS handshake per RPC, plus file reads that the embedding guide warns against ("Do not read … files … under `~/.openclaw`", embedding.md:146-148).

**Gained by switching:** everything in A3. One connection, atomic session setup, a real cwd and worktree, the real outcome per input (`messageSeq`, terminal events), and none of the transcript-reconcile, transcript-window or model-patch workarounds.

**Lost by switching:** the ACP ledger replay for `session/load` (not needed: `chat.history` is richer), the bridge's isolated `acp-bridge:` disposable keys, and the reuse of a generic ACP layer. The Hub must now implement device pairing and keep its own device token.

## A6. Risks

- **Protocol stability**: wire v4 is pinned, and changes are "additive first"; a bump to the wire version is an explicit breaking event (clients.md:337-350). The method surface changes every release (method specs carry `since` tags), and the docs tell clients to pin versions and re-check them (external-apps.md:44-55). Online docs still say v4 today. npm `latest` is 2026.11.3 while the install is 2026.10.9 (version drift, see the user's latest-version baseline).
- **Daemon side effects**: the Gateway serves Feishu and Weixin. A driver must never call `send`, `poll`, `message.action`, `conversations.send/turn`, `push.*`, `wake`, `cron.*` or `talk.*` (core-method-policy entries such as `send` :1658, `conversations.send` :1663). It must never pass `deliver:true` or `originating*` on `chat.send`: without `deliver`, the route is the internal channel (`dist/chat-send-handler-B0jivtwJ.mjs:2369-2382`).
  - The agent's own `message` tool could still send to a channel if the model chooses to. The `agent` RPC has `disableMessageTool`, `chat.send` does not. Whether that tool is offered in a channel-less Hub session is **unconfirmed**.
  - Hub sessions appear in the user's Control UI sidebar (rows carry `createdVia`). Consider `category:"HarnessHub"`.
  - Session maintenance archives old ordinary sessions (30 d / 5000 entries, earlier page :105-107).
- **Auth**: requesting `operator.admin` gives the Hub's device full config power. It is still needed for full mode, cwd, compact and rewind. Silent local pairing writes a device record in the Gateway's SQLite. Revoking the token, or `autoApproveLocal:false`, needs an approval flow in the UI.
- **Load**: the Gateway shares response bytes between connections and limits queue concurrency (transport.md:117-141). The Hub should subscribe narrowly: `sessions.messages.subscribe` only for live Hub sessions.

## A7. Recommendation (OpenClaw)

Write an `OpenClawGatewayDriver` that keeps **one WS client** (use `@openclaw/gateway-client@<installed version>`, MIT, pinned to the installed OpenClaw):

- Pairing: a Hub-owned Ed25519 device; read the shared token once from the env or config in memory, then use the device token.
- Caps: `tool-events`, `exec-approvals`, `plugin-approvals`, `approvals`, `agent-kind`, `chat-only-assistant-text`, `model-selection-policy`.
- Scopes: read, write, approvals, questions, admin.
- Session setup: `sessions.create` with key `agent:<id>:harnesshub:<uuid>`, cwd, model, thinkingLevel and permissionMode in one call.
- Turns: `chat.send`, without `deliver`.
- Steer: `chat.send queueMode:"steer"` when `activeRunIds` holds the Hub's run; otherwise withdraw the follow-up with `chat.abort runId`.
- Map `chat` plus non-text `agent` streams into hh/1 items.
- Answer `exec.approval`, `plugin.approval` and `question` from the Hub levels.
- Also: `sessions.fork/rewind/compact/diff`, and `models.list includeDetails` for the picker and input kinds.
- Keep the ACP driver only as a fallback until the WS driver passes the real-device smoke test.

---

# Part B — Hermes Agent v0.22.5

## B1. Interfaces in the installed version

Hermes documents **three** protocols for external programs (`website/docs/developer-guide/programmatic-integration.md:9-17`): ACP, the "TUI gateway JSON-RPC (stdio or WebSocket)" for "custom hosts that want fine-grained control of sessions, slash commands, approvals, and streaming events", and the OpenAI-compatible API server. It also offers an in-process Python embed (`run_agent.AIAgent`). The doc's own advice is: "custom desktop / web / TUI host [that wants] every Hermes feature → TUI gateway JSON-RPC" (:225-230).

Since v0.22.3 the backend behind all of them is **one gateway daemon that owns every session**: "the composed gateway listener" with a `SessionAuthority` (`website/docs/developer-guide/gateway-local-sessions.md:6-33`). v0.23.0's notes say this outright: "each machine runs one gateway that owns every session, and every surface attaches to it as a client" (GitHub release v0.23.0).

| Interface | What it is | Fit |
|---|---|---|
| **Canonical WS `hermes-gateway-v1`** | JSON-RPC 2.0 at `<api_origin>/api/ws` (`hermes_cli/gateway_client.py:13-43`; `gateway/session_contract.py:9`). Served by `AuthorityConnection.dispatch` (`gateway/session_controls.py:113-330`). OpenRPC contract `apps/shared/src/gateway-contract.openrpc.json`: 258 methods, 48 authority-only `x-canonical-methods`, 80 notifications, 16 server requests | **Richest**, and what Hermes's own Desktop, Ink, CLI and ACP use. Documented in the developer guide, not as a semver'd public SDK |
| `hermes acp` | Since v0.22.3 `GatewayACPAgent`, a viewer that projects ACP onto the canonical WS (`acp_adapter/gateway_server.py:1`, `:138-294`). It uses only `session.create/resume/info/stats/detach/mutate/interrupt/steer`, `prompt.submit/receipt/cancel/resolve_unknown`, `approval.respond`, `clarify.respond`, `config.set`, `slash.exec` and `runtime.describe` | A subset; it costs an extra Python process per connection |
| Standalone TUI sidecar (`tui_gateway/entry.py`, stdio) | The older separate in-process runtime; gateway-owned sessions now avoid it (gateway-local-sessions.md:8-10) | Not the direction Hermes is going |
| API server (`gateway/platforms/api_server*.py`) | HTTP+SSE: `/v1/runs` (approval, steer, stop), `/api/sessions/*` (programmatic-integration.md:127-222; `website/docs/user-guide/features/api-server.md:792-822`) | Needs `API_SERVER_ENABLED` and `API_SERVER_KEY` in `.env` (a config change). No per-session cwd (`cwd` appears 0 times in `api_server*.py`). Chat-shaped |
| MCP server | The `mcp-serve` plugin (not installed): "list and read your messaging conversations … send messages" (`plugin-catalog/mcp-serve.yaml`) | No, and it can send outbound |
| CLI `-z/--oneshot`, `--usage-file`, `hermes sessions export` | One-shot or batch | Utilities only |
| Python `AIAgent` | In-process embed | Bypasses the gateway, which is the single writer by design: no |

## B2. Process model, reaching it, auth, identity

- **One long-lived gateway daemon per machine**: launchd `ai.hermes.gateway`, with profile multiplexing on by default (`website/docs/developer-guide/multiplexing-gateway.md:8-31`). It also runs the user's messaging adapters, cron and kanban. Viewers attach and detach; "Closing every viewer leaves the execution and its pending approval alive" (gateway-local-sessions.md:29-33).
- **Live identify** (read-only, run once in this research): `state: ready`, `runtime_protocol: 1`, `supervisor: launchd`, `capabilities: [session-authority-v1, durable-admission-v1, event-replay-v1]`, `api_origin` = `http://127.0.0.1:56285`, 1 served profile, `code_sha` equal to the install stamp.
- **Bootstrap, with no stored token at all** (same-OS-user trust):
  1. Connect to the Unix socket `<HERMES_HOME>/gateway.sock` (or the pointer `gateway.sock.path`). Verify that the peer uid equals ours (`hermes_cli/gateway_runtime_discovery.py:124-171`).
  2. Send `{"protocol":1,"verb":"identify","id":1}\n` and get the endpoint: `api_origin`, `profile_id` in `served_profiles`, `instance_id`, `authority_epoch`, `capabilities`, `code_sha`. Validate it as `hermes_cli/gateway_runtime.py:98-150` does.
  3. Send `{"protocol":1,"id":1,"verb":"session-ticket","params":{"profile_id","instance_id","purpose":"interactive"}}` and get a one-use ticket that expires in 30 s (`gateway/control_socket.py:317-388`; `gateway_client.py:225-258`).
  4. WS connect with subprotocols `["hermes-gateway-v1", "hermes-gateway-ticket.<ticket>"]`, and check the echoed subprotocol (`gateway_client.py:37-43`, `:304-307`).
  - Do **not** call `ensure_gateway_runtime`, which may start, replace or wait for a gateway (`gateway_client.py:283-299`). Attach only when the gateway is `ready`. This makes the ADR-051 preflight (`hermes-gateway.ts`, reading files plus `ps` plus `launchctl`) unnecessary: `identify` is the authoritative answer.
- **Capabilities on a ticket connection**: `session:read/submit/control/approve/respond`, plus `session:create` (`gateway/session_controls.py:113-129`).
- **Identity model**: a stable logical `session_id`, plus a private physical transcript that rotates on compression or reset (gateway-local-sessions.md:18-28). Each input has an `admission_id`, an `execution_generation` for the running turn, a `revision` for metadata fences, and `replay_epoch` with `seq` for events (`gateway/session_events.py:38-45`). `session.create.request_id` makes creation idempotent.

## B3. Capability map (canonical WS)

| Need | Native mechanism | Notes |
|---|---|---|
| Create | `session.create {request_id, source, cwd, model, provider, reasoning, toolsets, skills, yolo, checkpoints, max_turns, editor:{mcp_servers}, title, hidden, …}` (`gateway/session_policy.py:15-18`; gateway-local-sessions.md:66-102) | Launch policy is frozen at creation. `source:"acp"` gives the `hermes-acp` coding toolset (no messaging, `toolsets.py:188-195`), editor MCP and edit approvals. `editor` is accepted only from `source:"acp"` (`gateway/session_local_editor.py:9-34`) |
| Resume | `session.resume {session_id}` returns a snapshot with messages, `pending` admissions, `prompts` (open approvals and clarifies), `inflight`, `revision`, `execution_generation` and the replay watermark. `session.events.since` replays (programmatic-integration.md:101-105; `website/docs/developer-guide/gateway-internals.md:65-97`) | Lets a client reattach to a running turn |
| Send Turn | `prompt.submit {session_id, input_id, text, attachments:[{path,mime}]}` returns a durable admission receipt; `prompt.receipt` gives its exact status (queued/started/terminal/unknown). Images: `image.attach_bytes` (base64, staged in the profile cache) or a path in `cache/images/`. Files: `file.attach` returns an `@file:` reference (gateway-internals.md:99-114; `gateway/session_images.py:8-40`; `gateway/session_ancillary.py:136`) | Up to 10 images, image MIME types only. File references replace today's text pointers. File attach semantics **unconfirmed** live |
| Streaming | `event` notifications `{type, session_id, admission_id, replay_epoch, seq, execution_generation, payload}`: `message.start/delta/interim/complete`, `reasoning.delta/available`, `tool.start/progress/generating/complete` (args, `result`, `inline_diff`, `duration_s`), `todo.updated`, `approval.request/settled`, `clarify.request/settled`, `session.info/updated/usage/title`, `session.replay_gap`, `notice`, `error` (`tui_gateway/contracts/events.py:161-467`; `acp_adapter/gateway_server.py:938-985`) | Reasoning streams only after `config.set {key:"show_reasoning", value:"1"}` (gateway_server.py:203-217) |
| Steer | `session.steer {session_id, text, execution_generation}` → `queued` / `rejected` / `stale_generation`. `session.redirect` cancels the active model request and continues the same turn. They "never create a queued admission or silently fall back to a new turn" (gateway-internals.md:168-186). Also `prompt.steer_queued` and `prompt.replace_queued` | Exactly the semantics the Hub wants (the reason `flavors/hermes.ts:41-45` refuses steer today) |
| Interrupt | `session.interrupt {session_id, execution_generation}`; `prompt.cancel {admission_id}` for queued input (gateway_server.py:416-449) | |
| Approvals | `approval.request` (choices once/session/always/deny; `command`/`description`, or an `edit` proposal for edit approvals) → `approval.respond {prompt_id, execution_generation, choice}`. Clarify: `clarify.respond`. Server requests `sudo`/`secret`/… are answered by a JSON-RPC response (gateway-internals.md:197-216; programmatic-integration.md:88-101) | The first answer wins; detaching does not deny |
| Hub levels | `edit_policy` ask / workspace_session / session (ACP source; `session.mutate edit_policy`, idle only) plus the `yolo` launch flag plus dangerous-command approvals. plan→ask, with the Hub refusing edits and dangerous commands; ask→ask; auto_edit→workspace_session; auto→workspace_session, with the Hub auto-allowing; full→session + `yolo:true` at create | Same table as `flavors/hermes.ts:16-29`. `yolo` is frozen at create, so leaving full needs a new session. A read-only `toolsets` set for plan is possible in principle; **unconfirmed** |
| Model / effort / provider | `session.create {model, provider, reasoning}` (an impossible pair is refused with suggestions, programmatic-integration.md:62-64); `session.mutate model` (deferred while busy, `confirmation_required` guard) and `session.mutate reasoning`; `model.options` for picker rows, pricing and capabilities (programmatic-integration.md:158-180) | Replaces the `/reasoning` slash with its fragile reply matching (`hermes.ts:256-263`) |
| Fork | `session.mutate branch {through_message_id?, title?}` → `branched_session_id` (gateway-internals.md:236-242) | |
| Rollback | Transcript: `session.mutate rewind`, or `prompt.submit` with `truncate_before_row_id` + `confirm_truncate` (edit/regenerate; programmatic-integration.md:66-82). Files: `rollback.list/diff/restore/session_diff` (requires launch `checkpoints:true`) | File checkpoints exist here, unlike OpenClaw |
| Compact | `session.mutate compress` (allow up to 660 s, `gateway_client.py:22-26`) | |
| Usage / cost | `session.usage` events (`Usage.cost_usd`, context used/max, cache; `tui_gateway/contracts/common.py:28-53`); `message.complete.usage/billing`; `session.stats` raw counters | Replaces the direct `state.db` read (`hermes.ts:401-419`) |
| List / read | `session.list {scope:"live"\|"stored"}`, `session.info`, `session.history`, `session.export`, `session.transcript` (v0.23.1) | Replaces shelling out to `hermes sessions export` (`hermes.ts:455-477`) |
| Titles | `session.mutate rename` (revision-fenced); auto-title arrives in `session.info` / `session.title` | Replaces `/title` (`hermes.ts:211-219`, disabled today) |
| MCP / Hub tools | `session.create editor.mcp_servers` (source acp); `session.mutate editor_mcp` to rebind (gateway_server.py:400-406) | Same capability as today's ACP `mcpServers`, without ACP |
| Workspace | `session.create cwd`; `session.mutate workspace {cwd}` (idle only) | |
| Skills / commands | `commands.catalog`, `complete.slash`, `slash.exec` (a reviewed read set plus `/title`), `command.dispatch`; skills at create (gateway-internals.md:139-166) | |
| Subagents / processes | `subagent.list/tail/steer/interrupt`, `process.list/stop/kill` (gateway-internals.md:42-62; `gateway/session_ancillary.py:16-60`) | |

## B4. Event model mapped to hh/1

| Hermes | hh/1 |
|---|---|
| `prompt.submit` receipt / `session.info.pending` (queued → started → terminal / unknown) | Turn `queued` → `running` → terminal. `unknown` maps straight to `TurnStatus "unknown"`; never resend (gateway-internals.md:76-97) |
| `message.delta` (null text = segment boundary), `message.interim` | `assistant_message` segments |
| `reasoning.delta` / `reasoning.available` | `reasoning` |
| `tool.start` / `tool.progress` / `tool.complete` (`name`, `args`, `result`, `inline_diff`, `duration_s`) | Work items: terminal→`command`, read_file→`file_read`, patch/write_file→`file_change` (from `inline_diff`), search_files→`search`, web_*→`web`, `mcp-*`→`mcp_tool`, delegate→`subagent` |
| `todo.updated` | `plan` |
| `approval.request` / `approval.settled` | `approval` (subject command, or file_change for `edit`; roles once→allow_once, session→allow_session, always→allow_always, deny) |
| `clarify.request` / `clarify.settled`, server requests `secret`/`sudo` | `question` (`secret: true` for secret) |
| `message.complete` (`status`, `usage`, `billing`, `error`, `failure_reason`, `partial`, `persisted_turn`) | Turn terminal, `TurnUsage`, `error` item |
| `session.usage` | `TurnUsage.context`, `cost` |
| `session.updated` (model refused / confirmation_required), `notice`, `session.tools_changed` | `notice` |
| compress mutation result | `context_event` compaction |
| `session.replay_gap` | Resync with `session.resume` |

## B5. Today's ACP path: what it gets, what it misses

**What it gets:** session new/load/resume/fork/list/cancel, text with images, streamed text, reasoning and tools, approvals and clarifies (as permission or elicitation), modes (edit policy), model switching with confirmation, `usage_update`, title updates and the command list (`acp_adapter/gateway_server.py:138-700`).

**What it misses or works around:**
- steer and redirect (no ACP equivalent);
- queued-input steering and replacement;
- exact admission receipts: today a lost turn becomes a diagnostic telling the user to type `/discard` (`hermes.ts:310-316`);
- reasoning effort (a `/reasoning` slash with reply parsing);
- rename (disabled `/title`);
- compress (slash text matching, `hermes.ts:41`, `:381`);
- rewind and edit/regenerate;
- file checkpoints;
- per-Turn usage (read from `state.db`);
- export (CLI process);
- file attachments (text pointers, because ACP resource blocks never reached the model, `hermes.ts:114-116`);
- subagent and process lists;
- gateway state (a file-based guess with five verdicts, `hermes-gateway.ts:1-23`, `:144-182`, where only A attaches).

There is also an extra `hermes acp` Python process per connection, whose stderr is scraped for failures (`hermes.ts:64-66`, `:384-388`).

**Gained by switching:** all of B3; the Hub's driver logic shrinks a lot. The preflight becomes `identify`, which is authoritative and live, and nothing can start, replace or wait on a gateway.

**Lost by switching:** the ACP SDK framing and the viewer's careful edge-case handling, for example re-adoption after a replay gap (gateway_server.py:986-1014) and cancel races (:416-438). The Hub must reimplement those against the same verbs.

## B6. Risks

- **Stability**: `hermes-gateway-v1` is Hermes's internal client protocol, and Hermes ships weekly. Within it, the coding verbs stayed stable from v0.22.5 to v0.23.1 (the v0.23.1 OpenRPC diff only adds `session.transcript`, the `bot_relay.cancel` and `groups.peer.*` methods; nothing canonical was removed; protocol name unchanged). It is documented in the developer guide but not offered as a supported third-party SDK. The installed version is behind the latest stable (v0.23.1).
- **`source:"acp"` from a non-ACP client**: inside the protocol, but it relies on an "editor" policy meant for the ACP viewer. `source:"tool"` exists for third-party integrations (gateway-local-sessions.md:68-73), but it gets no editor MCP and no edit approvals.
- **Daemon side effects**: Hub Turns run inside the same process as the user's messaging bots (QQ, per earlier pages). Never call `bot_relay.*`, `a2a.forward`, `cron.*`, `kanban.run`, `groups.*` or `shell.exec`, or the `hermes send` CLI. The `hermes-acp` toolset has no messaging tools, and Hermes has no agent-callable `send_message` (`toolsets.py:188-190`). `approval.respond choice:"always"` writes `command_allowlist`, which every surface uses (the warning is kept in `hermes.ts:91-95`). A gateway restart turns started turns into `unknown` and pauses the session until they are resolved; the Hub must surface that and never auto-resolve it (an outcome is unknown, so nothing may re-run automatically).
- **Auth**: same-user Unix-socket trust; tickets are one-use and last 30 s. No secret is stored or printed. A ticket for another profile is refused.

## B7. Recommendation (Hermes)

Write a `HermesGatewayDriver` that speaks `hermes-gateway-v1` directly:

- **Connect**: `identify` → refuse unless `ready` and `code_sha` equals the install stamp → `session-ticket` → WS → `runtime.describe` (check `acp-editor-policy-v1` and `acp-session-mcp-v1`).
- **Sessions**: `session.create` with source acp, cwd, model, provider, reasoning, editor MCP for Hub tools, yolo for full, checkpoints as needed. Then `config.set show_reasoning`.
- **Turns**: `prompt.submit`, with `image.attach_bytes` and `file.attach` for attachments. Read the events into hh/1 items.
- **Controls**: `session.steer` for the Hub's steer, `session.interrupt` and `prompt.cancel`, `approval.respond` and `clarify.respond` by level, and `session.mutate` for model, reasoning, rename, compress, branch and rewind.
- **Data**: `session.stats`/`session.usage` for usage, `session.export` for export.
- **Removable**: `hermes-gateway.ts` (the preflight), `state.db` reads, CLI export, stderr scraping and the `/reasoning`/`/title`/`/compress` reply matching.

---

# Part C — Against T3 Code's `ProviderAdapterV2`

| T3 contract (`ProviderAdapter.ts`) | OpenClaw WS | Hermes canonical WS |
|---|---|---|
| `openSession` / `canResumeAfterRestart` | One Gateway connection; sessions survive Hub restarts (true) | One gateway connection; sessions and queued admissions are durable (true) |
| `ensureThread` / `resumeThread` | `sessions.create` / existing key, `chat.history` | `session.create` / `session.resume` |
| `startTurn` | `chat.send` | `prompt.submit` |
| `steerTurn` + `steer.updated` | `chat.send queueMode:steer`, withdraw with `chat.abort runId` | `session.steer` (queued/rejected) |
| `interruptTurn` | `chat.abort` / `sessions.abort` | `session.interrupt` / `prompt.cancel` |
| `respondToRuntimeRequest` | `exec.approval.resolve`, `plugin.approval.resolve`, `question.resolve` | `approval.respond`, `clarify.respond`, server-request responses |
| `readThreadSnapshot` | `chat.history` (+ `inFlightRun`) | `session.resume` / `session.history` |
| `rollbackThread` | `sessions.rewind` (chat only) | `session.mutate rewind`, `rollback.restore` (files) |
| `forkThread` | `sessions.fork` / `sessions.create fork` | `session.mutate branch` |
| `compactThread` | `sessions.compact` | `session.mutate compress` |
| `applyModelSelection` | `sessions.patch model/thinkingLevel` | `session.mutate model/reasoning` |
| `stopSubagent` | `sessions.abort` on the child key | `subagent.interrupt` |
| `mcpApps` / Hub tools | None per session (CLI instructions) | `editor.mcp_servers` |
| `turn.terminal` threadDisposition | `chat` final/aborted/error | `message.complete` + receipt (`unknown` blocks the thread) |

## Unconfirmed (said plainly)

1. **OpenClaw**:
   - the scope and behaviour of the `agent` RPC's `extraSystemPrompt`, `cwd` and `disableMessageTool` (scope is "dynamic");
   - non-image attachments through `chat.send`;
   - whether the `message` tool is offered in a channel-less Hub session;
   - that a client sending `chat.send` receives its run's `chat`/`agent` events without subscribing (inferred: the ACP bridge never subscribes);
   - silent local pairing for a new non-CLI device on this machine;
   - how session maintenance classifies `harnesshub` keys.
   - Nothing was exercised against the live Gateway.
2. **Hermes**:
   - a non-Hermes WS client connecting with a minted ticket was not tried (no ticket was minted);
   - read-only `toolsets` for plan;
   - `file.attach` semantics for files outside the cwd;
   - `rollback.*` needs `checkpoints:true` at create;
   - which `session.list` scopes a ticket identity sees;
   - `cost_usd` depends on the provider.
3. **Both**: behaviour on the latest releases (OpenClaw 2026.11.3, Hermes v0.23.1) was checked only through docs and contract diffs, not run.

None of the above has been verified on the real machine. Every claim here comes from reading code or docs, except the single Hermes `identify` reply.
