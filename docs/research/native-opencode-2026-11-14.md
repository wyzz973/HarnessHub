> 2026-11-14 原生接入调研（只读）。T3 Code 源码：github.com/pingdotgg/t3code @ d19467a5；文中 `/private/tmp/…/scratchpad/` 下的路径是调研时的临时目录。

# OpenCode (and Pi): connecting natively

Research date 2026-11-14. Read-only. Installed: `opencode v2.2.5` (Homebrew core, `/opt/homebrew/bin/opencode`; `brew info` says 2.3.0 is out), `pi 0.85.1` (`/opt/homebrew/bin/pi` resolves to a local source build at `~/Desktop/project/pi/packages/coding-agent/dist/cli.js`, package `@earendil-works/pi-coding-agent`).

How I checked: I ran OpenCode's servers with every XDG directory pointed at a temp folder, so the user's `~/.config/opencode` and `~/.local/share/opencode` were not touched. I sent no prompt, ran no Turn and made no model call. One server took a few session calls (create, update, environment, runtime MCP add, inbox cancel), plus GETs. Separate short runs tested `serve --stdio` and `opencode acp` with `initialize` and `session/new` only. All my processes were stopped. The user's background service (`opencode serve --service`, pid 72418) was left alone. The temp folder is deleted. I saved the 2.2.5 OpenAPI document as a baseline next to this report: `/private/tmp/claude-501/-Users-sd3-Desktop-project-HarnessHub--claude-worktrees-relay-stage2-7cb3e9/2eae1136-e8e6-4dbb-9732-78309e4fdb4d/scratchpad/native-research/opencode-2.2.5-openapi.json`.

Labels: **observed** means I saw it on the installed binary. **schema** means it comes from the 2.2.5 OpenAPI doc or the `@opencode/client@2.2.5` type files. **T3** means it is what T3 Code does at d19467a5. **unconfirmed** means I could not check it without running a Turn.

One correction to the brief: T3 reaches **OpenCode 2** through `@opencode/client` / `@opencode/protocol` / `@opencode/schema` (it pins 2.0.28), in `packages/provider-opencode/src/server/v2/*`. `@opencode-ai/sdk/v2` (latest 1.19.5) belongs to T3's **OpenCode 1.x** path (`server/adapter.ts`). The `driver.ts` picks between the two by probing the major version (`versionProbe.ts:31-35`, `driver.ts:145-196`). For the installed 2.2.5 build, the v2 path is the one that matters.

---

## 1. Programmatic interfaces in OpenCode 2.2.5

| Interface | What it is | Verdict |
|---|---|---|
| `opencode serve` HTTP + SSE (`/api/...`) | The v2 server: 169 operations, OpenAPI 3.1 at `GET /openapi.json` (needs auth). `/doc` and every unknown path return the web app's HTML (observed). The doc calls itself "Experimental HttpApi surface for selected instance routes" and has `info.version` "0.0.1". | **Richest, and official.** Every other interface sits on top of it. |
| `@opencode/client` (promise / effect / solid / `mcp` / `service` entries) | The official generated client ("derived directly from OpenCode's authoritative Effect HttpApi"). Latest 2.3.0; npm lists 47 stable releases from 2.0.0 (2026-09-11) to 2.3.0 (2026-11-13). Its peer deps pin `effect` 4.1.0 exactly. The promise bundle's chunks import no external package (observed in the 2.2.5 dist). | Official client for the HTTP API. Optional for us. |
| `@opencode/sdk` 2.3.0 | An "In-process OpenCode host…executes Server's assembled HTTP router in memory, opening no listener". | Embeds OpenCode's code at a version the Hub would pick, not the user's installed binary. **Not for us.** |
| `opencode acp` | ACP over stdio. **Observed:** it spawns a child `opencode serve --stdio --port 0` and translates ACP to that HTTP API. | What the Hub uses today. It is a layer over the same server. |
| `opencode run [--format json]` | One-shot CLI. Flags: `--session`, `--fork`, `--model provider/model#variant`, `--agent`, `--file`, `--title`, `--thinking`, `--auto`. Uses the background service unless `--standalone` or `--server` is given (help text). | No interactive approvals (only `--auto`), no steering. JSON event shape **unconfirmed** (needs a prompt). Not suitable. |
| `opencode api <operationId \| METHOD path>` | CLI that calls the running server by OpenAPI operation ID. | Handy for probes and debugging. |
| Background service (`opencode serve --service`, `opencode service start/stop/status`) | The TUI's default shared server. Its registration file is `$XDG_STATE_HOME/opencode/service.json` and holds `url`, `pid`, `version` and the **password** (`@opencode/client` `dist/service.d.ts` `Info`). `Service.discover/ensure/stop` manage it. | We can use it, but sharing it with the user's TUI goes against "the Hub owns its sessions". See §2. |
| Client-hosted MCP over WebSocket (`GET /api/experimental/client-mcp`, `connectClientMcp` in `@opencode/client/mcp`) | The client hosts MCP tools for a location. They are exposed as `<name>_<tool>`, and each call carries `sessionID` (`dist/mcp.d.ts`). Experimental. | A good fit for Hub tools; see §3 MCP. |

The richest official interface is the HTTP API with its SSE event stream, used through `opencode serve`.

### Auth and startup facts (observed on 2.2.5)
- HTTP Basic auth is **always** on. The username is `opencode`. A Bearer token gets 401. Without auth, `/api/*` returns `401 {"_tag":"UnauthorizedError"}` with `www-authenticate: Basic`.
- Password: if `OPENCODE_PASSWORD` is set, the server uses it and prints nothing (confirmed). Otherwise it generates one and **prints `server password <value>` to stdout**. T3 sets `OPENCODE_PASSWORD` and drops the inherited 1.x `OPENCODE_SERVER_PASSWORD` (`v2/OpenCode2Server.ts:37-54`). Credentials must be UTF-8 Basic, not Latin-1 `btoa` (`v2/OpenCode2Client.ts:201-205`).
- `serve --stdio` (undocumented; observed): it prints one JSON line `{"url":"http://127.0.0.1:<port>"}`, and with `--port 0` it picks a free port. **It exits cleanly (code 0) when its stdin closes.** Plain `serve` keeps running after stdin closes. This is how `opencode acp` starts its child, and it gives an orphan-proof lifetime for free.
- Startup on an empty, isolated config: the handshake line arrived after 0.10 s, `/api/info` answered at 0.11 s, and the first location load (`agent.list`) took 0.24 s. A fresh database runs a 59-migration bootstrap in 6 ms. One idle server with two locations loaded had about 360 MB RSS. Startup with the user's real config (providers, plugins, MCP servers) was **not measured**.
- Two pairing endpoints, `POST /api/pair` and `GET /auth/connect/{code}`, give out a session token that works as the password (opencode.ai/docs/api/). We don't need them.

## 2. Process model

- **One server serves many sessions and many directories.** Observed: one server held sessions in two different temp directories, each with its own project ID. T3 says the same: "One OpenCode 2 process serves all directories" (`v2/OpenCode2Server.ts:2`).
- **How a request picks the directory:** a query parameter `location[directory]=<absolute path>` in deepObject style, used on 64 operations (schema). `session.create` takes `location: {directory}` in its body. Operations on a session resolve through that session's stored location. Omitting the location falls back to "base location headers, then the server's working directory" (opencode.ai/docs/build/client/). `session.move` relocates a session. `session.list` filters by `directory`, `project`, `subpath`, `parentID`, `archived` and `search`, with cursor paging. Each location loads its own agents, commands, skills, MCP servers and config. `POST /api/location/reload` rebuilds every location and **cancels pending permissions and forms**.
- **Shared or per-conversation server:**
  - Today each ACP connection costs one `opencode acp` process plus one `serve` child (about 360 MB each), and the level is fixed per process through `OPENCODE_CONFIG_CONTENT` (`src/adapters/flavors/opencode.ts:5-37`, `src/adapters/control/factory.ts:32-46`).
  - Natively, the level is a per-session permission ruleset (§3), so nothing needs a separate process. **One Hub-owned private server per Hub process** is enough.
  - Use a private server rather than the user's background service:
    - The private server's environment is ours.
    - We never read the user's `service.json` password.
    - A Hub upgrade or restart never disturbs the user's TUI.
  - Both servers share the same SQLite database. OpenCode itself already does this, since ACP children run next to the service. Interrupt is scoped to "active execution owned by this OpenCode process" (schema, `session.interrupt`).
- **Lifecycle pitfalls T3 handles:**
  - It shares one server for all threads, with a 30 s idle stop (`OpenCodeServerOwner.ts:11`).
  - It keeps a ledger of spawned PIDs to kill orphans after a crash (`OpenCodeServerLedger.ts`). With `--stdio` the pipe takes care of that.
  - It verifies readiness only through `server.info` (`v2/OpenCode2Server.ts:82-115`).
  - It updates only within a generation, because "2.x converts the shared database in place" (`driver.ts:115-119`, `versionProbe.ts:192-201`).
  - It replaces an outdated background service the way the TUI does, handing persistent terminals to the new process (`v2/OpenCode2Service.ts:38-118`).

## 3. Feature by feature (2.2.5 endpoint → `@opencode/client` promise call)

All paths are under `/api`. `{s}` is the session ID (`^ses…`). Message IDs match `^msg_` and **can be chosen by the client**.

| Need | Endpoint / client call | Notes |
|---|---|---|
| Create session | `POST /session` → `session.create({id?, parentID?, title?, agent?, model?, location?, metadata?, permissions?})` | Observed. Returns `Session.Info` (cost, tokens, outcome, time.busy/idle, revert, location). A session created with a title is never auto-titled (T3 `v2/adapter.ts:4569`). |
| List / get | `GET /session` (cursor paging; T3 notes that cursor pages must omit `order`, `OpenCode2Client.ts:355-378`), `GET /session/{s}`, `GET /session/active` (running sessions in this process) | Observed. |
| Messages | `GET /session/{s}/message?type&limit&order&cursor`, `GET /session/{s}/message/{m}`, `GET /session/{s}/context` (since the last compaction), `GET /experimental/session/{s}/export` | Message union: `user, synthetic, system, skill, shell, assistant, compaction, idle, agent-switched, model-switched, location-switched`. |
| Send prompt | `POST /session/{s}/prompt` → `session.prompt({id?, text, files?, agents?, skills?, metadata?, delivery?: "steer"\|"queue", resume?})` | It always returns at once: "Durably admit one session input and schedule agent-loop execution unless resume is false" (a `Session.Inbox.User` item). So the call itself is async; "sync" means waiting for the execution end on SSE or with `POST /experimental/session/{s}/wait`. **There is no per-prompt model or primary agent.** |
| Files and images | `files: [{uri, source?: {type:"inline"} \| {type:"uri", uri}, name?, description?, mention?}]` | T3 sends `file://` URIs for local images only and checks that the file exists first, because "OpenCode rejects the whole prompt if an attached file is missing" (`v2/adapter.ts:4120-4133`). The stored form is `{data: base64, mime, source}`. Inline base64 input is **unconfirmed**. Non-image files are named by path in the text (T3). |
| Event stream | `GET /event?types=…` (SSE), `event.subscribe({types})` | Observed: `data:` frames shaped `{id, created, type, location, data, durable?:{aggregateID, seq, version}}`, with `: heartbeat` comment lines in between. "Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed." There is no replay and no automatic reconnect. **Subscribe before creating or prompting** (T3 `v2/adapter.ts:3747-3750`). |
| Durable replay | `GET /experimental/session/{s}/log?after=<seq>&follow` | Experimental; `SessionLogItem = SessionEventDurable \| log.synced`. Observed: for a session with only metadata events it returned just `log.synced{seq:4}`, whatever the `after` value. Replay of Turn events is **unconfirmed**. T3 does not use it; it reconciles from messages instead (§5). |
| Steer / queue while busy | The same `prompt` with `delivery:"steer"` (taken at the next step boundary, same turn) or `"queue"` (after idle). Inbox: `GET /session/{s}/inbox`, `PATCH /session/{s}/inbox/{id} {delivery}`, `DELETE /session/{s}/inbox/{id}` (cancel before delivery; observed 204). | Events: `session.inbox.enqueued / delivered / cancelled / delivery.changed`. The default delivery when none is given is **unconfirmed**. |
| Abort | `POST /session/{s}/interrupt?resume=` → `{interrupted}` | `resume=true` keeps pending steers and control items, and queued prompts stay parked. `POST /session/{s}/background` moves backgroundable tools out of the foreground. |
| Permission ask | SSE `permission.asked {id(per…), sessionID, action, resources[], save?[], source?:{type:"tool", messageID, id}, message?}`; `GET /session/{s}/permission`, `GET /permission/request?location` | `source.id` is the tool call ID, so it maps to `forCall`. |
| Permission answer | `POST /session/{s}/permission/{rid}/reply {decision:"once"\|"always"\|"reject", message?}` → `permission.replied` | **A rejection with a message lets the model continue. A rejection without one stops the execution** (T3 `v2/adapter.ts:455-460`). `always` writes a saved rule into the project's database (`/permission/saved`), which is user data; T3 instead keeps session-only grants as session rules (`v2/adapter.ts:5047-5064`). |
| Questions | SSE `form.created {form}` (fields: string, number, integer, boolean, multiselect, external), then `POST /session/{s}/form/{f}/reply {answer}` or `DELETE …/form/{f}` | This is the `question` tool. |
| Levels | Per-session ruleset `permissions: [{action, resource, effect: allow\|ask\|deny}]` on `session.create` or `PATCH /session/{s}` (observed 204 plus a `session.permissions` event) | Last match wins. Default agent rules are `* * allow`, with `.env` reads set to ask (observed in `agent.list`). Mapping in §3a. |
| Agents | `GET /agent` (observed: `build`, `plan` primary; `general`, `explore` subagents; `compaction`, `title`, `summary` hidden), `POST /session/{s}/agent {agent}` | The switch applies to "subsequent provider turns". |
| Model and variant | `GET /model` (variants, capabilities.input, limit.context, cost[]), `GET /model/default`, `POST /session/{s}/model {model:{providerID, id, variant?}}` | The variant is the effort setting. To get per-message selection, switch before each prompt the way T3 does (`v2/adapter.ts:4764-4767`). A variant the catalog doesn't list makes OpenCode reject the turn (`v2/adapter.ts:703-720`). |
| Fork | `POST /session/{s}/fork {before?: msgID}` → child `Session.Info` with `fork{sessionID, boundary}` | T3 forks only quiet sessions (`ensureQuiet`, `v2/adapter.ts:3938-3974`). |
| Revert / unrevert | `POST /session/{s}/revert/stage {messageID, files?}`, then `POST …/revert/commit` (cut for good) or `DELETE …/revert` (undo the stage) | 409 `SessionBusyError` while busy. A stage left in place gets committed by the next prompt, so clear it first (T3 `v2/adapter.ts:4768-4770`). T3 uses `files:false` and keeps its own checkpoints (`v2/adapter.ts:4007-4027`). |
| Turn diff | `GET /session/{s}/diff?from&to&context` → `FileDiff.Info[]` | A "turn" runs from a prompt after idle to the next idle, steers included. |
| Compact | `POST /session/{s}/compact {id?, delivery?}` (steers by default) | Events `session.compaction.started/delta/ended/failed`; message `compaction{reason: auto\|manual, summary}`. |
| Share | **None** in 2.2.5's API. Only a `share` key exists in config. | |
| Usage and cost | `Session.Info.cost/tokens`; `session.step.ended {tokens, cost, finish, snapshot, files}` per model call; volatile `session.usage.updated` running totals; durable `session.usage.recorded {source: title\|compaction}`; `GET /experimental/session/stats`; `GET /experimental/usage/limits` (OpenCode Console / Go allowance) | Tokens: `{input, output, reasoning, cache:{read, write}}`. |
| Titles | `session.create {title}`, `PATCH /session/{s} {title}` (observed), event `session.renamed` | With no title, the hidden `title` agent generates one (cost goes to `usage.recorded`). |
| MCP at runtime | `PUT /experimental/mcp/{name}?location {config: local{command[], cwd?, environment?, timeout?} \| remote{url, headers?, oauth?}}`, plus DELETE, `/connect`, `/disconnect`, and `GET /mcp` | **Observed: nothing was written to the config or state directories.** The server is scoped to a location, not a session. Tools are named `<server>_<tool>`. T3 makes one server per thread and adds session rules that deny other threads' servers (`v2/adapter.ts:406-424`). Before 2.2.6, tools load about 100 ms after the connection, so T3 waits 250 ms (`v2/adapter.ts:4196-4199`). |
| Client-hosted MCP | `GET /experimental/client-mcp?name&location&ticket` (WebSocket) | The Hub hosts the tools in-process, and each call says which `sessionID` made it. |
| Per-session env | `PUT /session/{s}/environment {variables}` (observed 204) | Only for "local shell commands for this session". Not for MCP servers or providers. |
| Session instructions | `PUT /experimental/session/{s}/instructions/entries/{key} {value}` (key `^[a-z0-9][a-z0-9._-]*$`), plus list and DELETE | Durable; takes effect at the next step boundary. Too large a value gives 413 `InstructionEntryValueTooLargeError{maxBytes}`; the limit's value is **unconfirmed**. T3 uses key `t3-code` (`v2/adapter.ts:4201-4214`). |
| Context injection | `POST /session/{s}/synthetic {text, description?, delivery?, resume?}` | Puts in a synthetic user input without running anything when `resume:false`. T3 uses it for decline notes. |
| Commands | `GET /command` (observed: `init`, `review`, `goal`), `POST /session/{s}/command {name, text, files?, delivery?}` | This call neither takes nor returns our message ID, so T3 records the history boundary first (`v2/adapter.ts:4486-4489`). |
| Skills | `GET /skill` (observed: it lists more than 100 skills, including the user's `~/.claude` and other home skills, even with XDG isolated), `prompt {skills:[{id}]}`, `POST /experimental/session/{s}/skill` | |
| Shell (`!cmd`) | `POST /session/{s}/shell {command}` → `session.shell.started/ended` | |
| Config read | `GET /config?location` → `[{type:"document", path?, info}, {type:"directory", path}]`, lowest to highest priority | Read-only. Documents come back verbatim and may hold keys, so never log them. `PATCH /experimental/config` changes the user's config; don't use it. |
| Transient generation | `POST /session/{s}/generate {prompt}` | A model call that leaves the session history alone (useful for titles and summaries). |

### 3a. Hub level → OpenCode session ruleset (proposal, following T3 `sessionRules` at `v2/adapter.ts:426-444`)

| Hub level (`contracts/flavor.ts:124-130`) | Agent | Session `permissions` (in order; last match wins) |
|---|---|---|
| plan | `plan` | `edit deny`, `shell deny`, then the plan agent's own path allows re-appended (T3 `agentPaths`, `v2/adapter.ts:526-532`) so its plan file stays writable |
| ask | `build` | `edit ask`, `shell ask`, `external_directory ask` (add `webfetch ask`, `websearch ask` and MCP tool patterns if the Hub's `network`/`tool: ask` should apply) |
| auto_edit | `build` | `edit allow`, `shell ask`, `external_directory ask` |
| auto | `build` | `edit allow`, `shell allow`, `external_directory ask`. The Hub answers `external_directory`: allow reads and commands, reject changes **with a message** so the turn keeps going. |
| full | `build` | `* allow` |

Then add the Hub-tool rules (`harnesshub-*` deny, own server allow) and any session-only grants. The order of agent rules against session rules (session after agent) is T3's design. I did **not confirm it from OpenCode's source**, so test it once on the real machine.

## 4. Event and part model → Hub Turn / item / event

OpenCode's units:
- **session**
- **execution**: `session.execution.started` → `succeeded | failed{error} | interrupted{reason: user|shutdown|superseded|inactivity}`, plus a durable `idle{outcome}` message.
- **step**: one model call. `session.step.started{assistantMessageID, agent, model, snapshot}` → `step.ended{finish, cost, tokens, snapshot, files}` or `step.failed{error}`. 2.3.0 adds `step.first-token`.
- **assistant message**: `content[]` made of text and reasoning blocks keyed by `ordinal`, and tool parts keyed by `id`.
- **tool state**: streaming → running → completed or error.

Delta events (`text.delta`, `reasoning.delta`, `tool.input.delta`, `tool.progress`, `compaction.delta`, `usage.updated`, `session.status`, `permission.*`, `form.*`) have **no `durable` seq**. Everything else is durable and has a seq per aggregate.

| OpenCode event | Hub entity / `ControlEvent` (`contracts/control.ts:131-161`) |
|---|---|
| prompt admitted (`Inbox.User`, our `id`) | Turn accepted. **Not yet recorded.** |
| `session.inbox.delivered{inboxID == our id}` | `input_recorded`. This is exact evidence; ACP only had "lateDelivery unknown". |
| `session.inbox.cancelled{our id}` after `DELETE inbox` | `input: "not_recorded"`. A stop before delivery is now certain. |
| `execution.started` / end events and `idle` | Turn running / `BackendResult` completed, failed or cancelled |
| `text.started/delta/ended` (`assistantMessageID:ordinal`) | `text` item (`ended.text` is the authoritative full text) |
| `reasoning.*` | `thinking` |
| `tool.input.started{id, name}` → `tool.called{input, executed}` → `tool.progress{metadata}` → `tool.success{content[text\|file], metadata}` / `tool.failed{error}` | `tool` events with status. `error.type == "aborted"` means interrupted. The shell tool "succeeds when the command exits non-zero", so read `metadata.exit` (T3 `toolItems.ts:115-120`). |
| tool `todowrite` success with `metadata.todos` | `plan` (T3 `v2/adapter.ts:1304-1307`) |
| tool `subagent`, child from `progress/success.metadata.sessionID`, `session.created{parentID}` | `activity{kind:"subagent"}`. The child session's own events arrive with its own sessionID. |
| tool `question` → `form.created` | `permission_requested{kind:"question"}` |
| `permission.asked` / `permission.replied` | `permission_requested{forCall: source.id, toolKind: action}` / `permission` |
| `step.ended.tokens/cost` | `usage.requests[]` per step; turn totals; `cost{scope:"turn"}`. T3's sum: input = input + cache.read + cache.write; output includes reasoning (`v2/adapter.ts:2802-2813`). Context size comes from `model.limit.context`. |
| `retry.scheduled{attempt, at, error}`, volatile `session.status{type:"retry"}` | `activity{kind:"retry"}`. Retry success is inferred from the first output (T3 `v2/adapter.ts:2656-2665`). |
| `compaction.*` | `activity{kind:"compaction"}` |
| `execution.failed.error{type, message, status, response.body}` | failed result and `notice`. `provider.quota` (not HTTP 402) or `provider.rate-limit` means a usage limit (T3 `v2/adapter.ts:2826-2843`). |
| `session.shell.*`, `shell.*` | `tool` (command) |
| `session.renamed`, `session.permissions`, `session.model.selected`, `session.agent.selected` | Session metadata (title, level, model, mode) |
| `revert.staged/cleared/committed` | Rollback bookkeeping |

## 5. How T3 Code does it (v2, file by file)

- **`v2/OpenCode2Server.ts`**:
  - Connects to a configured URL, or spawns its own server with a 32-byte random password kept in memory (`:37-54`, `:117-175`).
  - Treats only `server.info` as proof of readiness, and keeps credential-bearing error text out of messages (`:68-115`).
- **`v2/OpenCode2Client.ts`**:
  - Basic auth in UTF-8 (`:201-205`).
  - The SSE reader fails the stream after 45 s of silence, since heartbeats come every 10–15 s (`:132-134`, `:175-199`).
  - Undecodable frames with a known execution start or end type become synthetic start and end events, so a turn never hangs on a schema it doesn't know (`:146-173`).
  - A response transform fills the compaction `recent` field that 2.1 dropped, which T3's pinned 2.0.28 schema requires (`:218-261`).
  - Cursor paging (`:355-378`).
  - Image preview through `fs.read` (`:313-338`).
  - `/api/experimental/job` for shell and image jobs (`:284-312`). That route is **absent from 2.2.5** (404) and present in the latest docs.
- **`v2/OpenCode2Service.ts`**: finds the registered background service without leaking its password to another host, and replaces an outdated one with terminal handoff (`:13-118`).
- **`OpenCodeServerOwner.ts` / `OpenCodeServerLedger.ts` / `OpenCodeRuntime.ts`**:
  - Borrow counting with a 30 s idle close.
  - A PID ledger for orphans.
  - Spawns `serve --hostname --port` with `OPENCODE_CONFIG_CONTENT` defaulting to `{}` (`OpenCodeRuntime.ts:43-63`, `:594-625`).
- **`versionProbe.ts`**: `--version`, or `/api/info` for 2.x and `/global/health` for 1.x, requiring JSON because cross-version paths return HTML with status 200 (`:23-58`).
- **`v2/adapter.ts`** (5,303 lines):
  - Capabilities (`:122-212`).
  - Session rules per mode and per-thread MCP rules (`:404-444`).
  - Its own prompt IDs `msg_t3_turn_<session>:<attempt>`, which also serve as fork and rollback boundaries (`:660-666`).
  - `ensureThread` creates sessions with model, permissions and title (`:4543-4622`).
  - `startTurn` (`:4672-4823`):
    - Refuses if a turn is already active.
    - After an unknown end, checks `session.active` and interrupts ("still stopping").
    - Switches agent, then rules, then title, then model.
    - Cancels stranded steers and clears staged reverts.
    - Runs `prepareTurn`: MCP and instructions (`:4148-4215`).
    - Runs `submit`: `/compact` → `session.compact`; listed commands → `session.command`; otherwise `prompt` with files and skills (`:4448-4521`).
    - Treats InvalidRequest, Conflict, Unauthorized, CommandNotFound and SkillNotFound as certainly not admitted; any other failure "may still have admitted the prompt" and marks the session unsettled (`:637-644`, `:4797-4806`).
  - `steerTurn`: `prompt{delivery:"steer", id: msg_t3_steer_…}` (`:4825-4903`).
  - `interruptTurn`: 10 s timeout, and the turn stays open if the stop doesn't land (`:4918-4990`).
  - `respondToRuntimeRequest` (`:5029-5115`):
    - For a decline, it first sends a synthetic steer note and then rejects with a message.
    - "Accept for session" becomes a session grant, not the native `always`.
    - Forms are cancelled when declined.
  - On resume, it rejects requests left over from before the reload (`:2380-2399`).
  - Event routing (`:2651-2848`):
    - Text and reasoning blocks keyed by `assistantMessageID:kind:ordinal`.
    - Tools; the `subagent` tool.
    - Background shells, polled through `shell.output` every 2 s (`:3752-3791`).
    - Todo, retry, compaction and usage.
  - Reconnect: up to 5 attempts, then `reconcile`. Reconcile uses `session.active`, backfills from messages, and lists permissions and forms again to re-show or cancel them (`:3505-3691`).
  - Rollback: `revert.stage{files:false}` plus `commit`, and `clear` on error (`:4007-4027`, `:5134-5183`).
  - Fork: `session.fork{before}`, then `session.move` to the target cwd (`:5184-5261`).
  - Forms: only string and multiselect fields; any other form is cancelled and the turn fails with a reason (`:469-497`, `:2545-2575`).
  - Skill mentions are checked against `skill.list`. On 2.2.5 the model list answers only after the skill scan ends (observed by T3, `:4434-4446`).
- **`toolItems.ts`**: maps tool names to kinds (shell/bash, edit/write/patch, web, glob/grep/lsp, `todowrite`, `read`), and unwraps `read`'s `<path><type><content>` envelope (`:36-113`).
- **Unified contract** (`provider-core/src/server/ProviderAdapter.ts:661-760`):
  - `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread`, `compactThread`, `stopTask`, `unloadThread`, `events`.
  - The capability struct says what each driver supports.

## 6. Our ACP path today: what it gets and what it misses

**Gets** (observed `initialize`: `loadSession`, `sessionCapabilities{list, fork, resume, close, delete, additionalDirectories}`, `mcpCapabilities{http:true, sse:false}`, `promptCapabilities{image, embeddedContext}`, `_meta: opencode/child-session-updates`; `session/new` config options `model` and `mode` with values build/plan):
- Prompt, cancel, load, resume, fork and list.
- Model and mode setting; effort through the model's variants (`flavors/opencode.ts:43-47`).
- Command catalog; usage (context used, size, cost); todo plan; tool calls; approvals; compaction updates.
- Hub tools through ACP `mcpServers`, which OpenCode turns into runtime servers (`flavors/opencode.ts:50-53`).

**Misses or works around:**
- **No steering.** It refuses a second prompt with "Session already has an active ACP prompt" (`flavors/opencode.ts:54-56`, `control/opencode.ts:40`). Native gives `delivery: steer|queue` and an inbox.
- **A rejection ends the turn**, because ACP rejects without a message (`flavors/opencode.ts:14-15`, which is why `auto` uses deny rules). Native can reply with a message.
- **The level is fixed per process** through `OPENCODE_CONFIG_CONTENT`. Native has per-session rules that can change at any time.
- **A cancelled prompt's input stays unknown** (lateDelivery; `control/opencode.ts:13-19`, `:93-95`). Native has `inbox.delivered` / `inbox.cancelled`.
- **`/compact` is a slash workaround**, with the NATIVE_COMMAND_IGNORED heuristic (`control/opencode.ts:26-28`, `:74-83`, `:133-137`). Native has `session.compact`.
- **No per-model input kinds** (`models --verbose` is refused in 2.x, `control/opencode.ts:43-72`). Native `model.list` gives `capabilities.input`, `limit` and `cost`.
- **Missing entirely:** revert/rollback, turn diff, per-step usage and cost, retry events, session instructions (today they go in as `<mcp_instructions>`), synthetic context, title writes, session move, server-side event reconcile, child session detail, forms, `!shell`, `generate`.
- **Process cost:** one process pair per connection.

**What switching costs us:**
- ACP is a cross-Harness standard, and much of `AcpControl` (approvals UI, elicitation, history replay) is shared code. Native is a separate driver.
- The native API calls itself experimental and changes fast (§7). T3's v2 adapter is 5.3k lines.
- We take on server lifecycle: spawn, password, port, crash, upgrade restart. `--stdio` makes this small.
- External or remote servers can't see Hub file paths (T3 `v2/adapter.ts:4122-4123`). That doesn't apply to a private local server.

## 7. Risks: stability, drift, detecting changes

- **Stability:**
  - The OpenAPI doc names itself "Experimental HttpApi surface". `info.version` is "0.0.1" in both 2.2.5 and the latest docs, so it is useless for versioning; use `server.info.version`.
  - Many routes sit under `/api/experimental/*` and say "may change without compatibility guarantees": session log, instructions, MCP add, client-mcp, skill activation, wait, export.
  - Subscriptions are live-only.
- **Cadence:** 47 client releases in about 9 weeks. The user's Homebrew 2.2.5 already trails 2.3.0.
- **Breaks T3 has met so far:**
  - The compaction `recent` field dropped in 2.1.
  - MCP tool load timing before 2.2.6.
  - In 2.0.18, `revert.clear` executed even with nothing staged (`v2/adapter.ts:3993`).
  - `/experimental/job` differs between versions.
  - New event types arrive and old clients can't decode them.
- **Diff, installed 2.2.5 against the latest docs' `/docs/openapi.json`** (fetched 2026-11-14):
  - Operations: 169 → 170 (`experimental.job.list` added; none removed or moved).
  - Schemas: 363 → 501. The latest doc **publishes every event payload as a schema** (`session.*`, `permission.*`, `V2Event`…), where 2.2.5 has `V2EventEncoded = string`.
  - New event types: `session.step.first-token`, `experimental.mcp.event`.
  - `Session.Message.Assistant` gains `time.firstToken`.
  - The request bodies of `session.prompt`, `permission.reply`, `mcp.add`, `fork` and `revert.stage` are unchanged.
- **Detection plan:**
  1. At server start, read `server.info.version` and `GET /openapi.json` (with auth).
  2. Hash the operation IDs, methods, paths and request/response schemas the driver uses, plus the `/event` `types` enum, and compare with a vendored baseline per version (the saved 2.2.5 doc is the first).
  3. On a difference, log one diagnostic. Don't refuse: the product rule is "latest version is the baseline" and "default allow".
  4. Decode events tolerantly. An unknown type becomes a diagnostic. An undecodable execution end still ends the Turn (T3's rule).
  5. Re-run the smoke test when Homebrew moves.
  - `--stdio`'s JSON line is undocumented. Fall back to parsing `server listening on <url>`.

## 8. Recommendation for HarnessHub's OpenCode driver

Replace the OpenCode ACP driver with a native **`opencode-http`** driver, using the Hub's own thin client.

1. **Server.**
   - The Hub runs one private `opencode serve --stdio --hostname 127.0.0.1 --port 0` with a random `OPENCODE_PASSWORD` kept in memory.
   - Its lifetime is tied to the stdin pipe.
   - Restart it when it crashes, and when the user's OpenCode is upgraded (restart once idle).
   - Never touch the user's background service or its `service.json`.
2. **Client.**
   - Hand-written `fetch` plus an SSE parser (a few hundred lines), with tolerant decoding. Keep its types in the adapter layer so `pnpm check:boundaries` holds.
   - The Hub uses no SDKs elsewhere, and `@opencode/client` pins `effect` 4.1.0 as a peer dependency and releases with every server version.
   - The promise client is usable as a pinned reference, but don't depend on it.
3. **Turn flow.**
   - Subscribe to `/event` first.
   - Per Turn: switch agent if needed (`plan` or `build`); write the session rules for the level (§3a); switch model and variant if they changed; write instructions with `instructions.entries.put("harnesshub", …)`.
   - Then `prompt{id: "msg_hub_<turn>", text, files}`.
   - `inbox.delivered` gives `input_recorded`. Execution end events give the result.
   - Words typed mid-Turn go in as `prompt{delivery:"steer"}`. Stop is `interrupt`, plus `inbox.cancel` for undelivered items.
   - Any failure outside T3's "clearly rejected" list (§5) is unknown: never resend it, and check `session.active` before the next Turn.
4. **Approvals.**
   - `permission.asked` becomes the Hub's request, keyed by `source.id`.
   - Answer `once`, or `reject` with a message.
   - Map "allow for this session" to a session rule, never to `always`, so OpenCode's database is not changed.
   - Forms map to Hub questions.
5. **Hub tools.**
   - Start with `experimental.mcp.add` (local command `harnesshub-<conv>`, location-scoped) plus deny/allow session rules, the same as T3. It matches today's ACP behaviour.
   - Try client-hosted MCP over WebSocket later, since each call carries its `sessionID`.
6. **Native extras:**
   - `/compact` → `session.compact`.
   - Rollback → `revert.stage{files:false}` + `commit`, since the Hub keeps its own checkpoints.
   - Fork → `session.fork{before}`.
   - Titles → `PATCH title`.
   - Usage → `step.ended`.
   - Catalog → `model.list`, `agent.list`, `command.list`, `skill.list`.
   - Diff → `session.diff`.
   - Reconcile after a reconnect: `session.active`, `message.list`, `permission.list`, `form.list`.
7. **Keep ACP as the fallback** only for OpenCode 1.x, which is not the baseline.

Unconfirmed points to check on the real machine first: rule ordering (agent vs session); the default `delivery`; whether a duplicate prompt `id` gets a 409 or the existing item; whether inline base64 files are accepted; replay from `session/log`; startup time with the user's real config.

---

## Pi (short)

**Pi's RPC surface** (`pi --mode rpc`; JSONL on stdio with LF framing only, so Node's `readline` is not compliant — `docs/rpc.md:28-38` in the installed package):
- Prompting: `prompt{message, images?, streamingBehavior?: "steer"|"followUp"}`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`.
- State: `get_state`, `get_messages`.
- Model: `set_model`, `cycle_model`, `get_available_models`.
- Thinking: `set_thinking_level` and friends.
- Queues: `set_steering_mode`, `set_follow_up_mode`.
- Compaction: `compact{customInstructions?}`, `set_auto_compaction`.
- Retry: `set_auto_retry`, `abort_retry`.
- Bash: `bash`, `abort_bash`.
- Session: `get_session_stats` (tokens, cost, contextUsage), `export_html`, `switch_session`, `fork{entryId}`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.
- Events: `agent_start/end/settled`, `turn_start/end`, `message_start/update/end` (text, thinking and toolcall deltas), `tool_execution_*`, `queue_update`, `compaction_*`, `auto_retry_*`, `extension_error`.
- Extension UI over RPC: `extension_ui_request` select/confirm/input/editor/notify…, answered with `extension_ui_response` (`docs/rpc.md:39-1375`).
- Pi itself has no permissions and no MCP. Its extensions can block tools (`pi.on("tool_call")` with `ctx.ui.confirm`), register tools, and change the system prompt in `before_agent_start` (`docs/extensions.md:70-78`, `:530-565`, `:778`).

**What we map** (`src/adapters/control/pi.ts`):
- `prompt` (with images), `abort`, `get_state`, `get_available_models`, `get_available_thinking_levels`, `set_thinking_level`, `get_commands`, `compact`, `clone` (fork), `export_html`, and the extension UI.
- Events: `agent_start`, `agent_end`, `agent_settled`, `message_update` deltas, `message_end` usage, `tool_execution_*`, `compaction_*`, `auto_retry_*`, `extension_error`.
- One process per conversation. **A model change restarts Pi** with `--provider/--model` (`pi.ts:106-107`, `:180-189`).
- Levels are policy only: "no permission requests at all" (`flavors/pi.ts:4-7`).
- No Hub tools (`infrastructure/capabilities/hub-tools.ts:33-37`).

**What T3 maps beyond ours** (`packages/provider-pi/src/server/*`):
- `set_model` in the session, `new_session`, `switch_session`.
- `fork{entryId}` plus `get_entries` for fork-from-turn and rollback.
- `get_session_stats`, `set_session_name`, `get_messages`, `get_last_assistant_text`, `clear_queue`.
- Steering through `prompt{streamingBehavior:"steer"}` (`adapter.ts:2961-2965`).
- A generated Pi extension loaded with `--extension` (`mcpInjection.ts:252-320`, `mcpExtensionSource.ts`) that:
  - enforces T3's runtime modes through a `tool_call` hook and `ctx.ui.confirm`. Read-only tools always pass, and edit/write pass in auto-accept-edits (`mcpExtensionSource.ts:355-376`).
  - bridges T3's MCP tools with `pi.registerTool` (`:378-420`; it uses `registerMcpServer` exposure from Pi 0.99, which the installed 0.85.1 predates).
  - adds the orchestration instructions.

**Gaps worth closing, in order:**
1. Steering with `steer`, or `prompt{streamingBehavior:"steer"}`.
2. The Hub's levels, enforced by a small Hub-written Pi extension:
   - Its `tool_call` hook asks through `extension_ui_request confirm`. The Hub already answers those.
   - This is "if the Harness has no native setting, the Hub enforces it on the permission request".
3. Hub tools and session instructions through the same extension, using `registerTool` and `before_agent_start` (or `--append-system-prompt`).
4. `set_model` in the session instead of a process restart.
5. `get_session_stats` for context usage and cost.
6. `set_session_name` for titles.
7. Fork and rollback from a given turn with `get_fork_messages` / `fork{entryId}`.

Not verified on Pi: I started no Pi process; everything above comes from the help text, docs and source.
