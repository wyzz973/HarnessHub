> 2026-11-14 原生接入调研（只读）。T3 Code 源码：github.com/pingdotgg/t3code @ d19467a5；文中 `/private/tmp/…/scratchpad/` 下的路径是调研时的临时目录。

# DeepSeek Harness (`dsh`) and WorkBuddy: native integration research

Date: 2026-11-14. Read-only research. No model Turn was started, no server was started, nothing under `~/.dsh`, `~/.workbuddy` or `~/Library` was changed, and no repo file was edited. Unless marked otherwise, every finding comes from reading installed files. Items marked **unconfirmed** were not checked by running anything.

Abbreviations used below:
- `DSH_PKG` = `~/.nvm/versions/node/v26.13.0/lib/node_modules/@deepseek-ai/dsh`
- `DSH_MODS` = `DSH_PKG/node_modules/@deepseek-ai`
- `WB_CLI` = `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli`
- `WB_MAIN` = `main/` inside `/Applications/WorkBuddy.app/Contents/Resources/app.asar`, read by parsing the asar header (offsets are byte offsets into minified files)

---

## 0. Summary and recommendations

**dsh.** dsh ships four programmatic surfaces: ACP (`dsh --profile acp`), an SDK JSON-RPC stdio server (`dsh --profile sdk`, with TS and Python clients), one-shot headless `--json`, and the Web host's own RPC. The Web host RPC is generated Typert over HTTP plus a WebSocket mux. The dsh browser UI and the Desktop app use it, and it has a documented "API caller" entry. It is by far the richest: token streaming, steer, queue editing, fork at any event, rename and titles, search, slash commands (`/compact`, `/plan`, `/permission`), approval answering, per-turn file changes and live projections. But it is an internal, generated contract with no compatibility promise. ACP is the surface upstream documents for automation and keeps stable across versions. The SDK has no cancel at all, so it cannot back the Hub.
**Recommendation:** keep ACP as the backbone and fix three things now:
1. Read `turn/end.reason` from the session log. dsh ACP reports `error` and `blocked` Turns as `end_turn`.
2. Pin which `dsh` runs.
3. Do the Hub-side steer, fork and title work.

Time-box one spike on the Web host RPC for streaming, steer, fork, titles and commands. Adopt it only as an optional richer driver if the user accepts an unversioned internal contract.

**WorkBuddy.** The desktop app itself has **no supported way to be driven by another program**. Its deep links only open UI. Its local IPC broker and daemon are internal and ticket-authenticated. Its engine is a bundled copy of **CodeBuddy Code 2.165.0** (`@tencent-ai/codebuddy-code`), and that CLI's ACP, HTTP (`--serve`), stream-json and Agent SDK surfaces *are* officially documented by Tencent. Running the app's bundled copy from outside the app is possible but undocumented. WorkBuddy itself drives the CLI through ACP: over HTTP/SSE per conversation (`cbc --serve`). The CLI's ACP agent is very rich, with standard modes and config options plus `_codebuddy.ai/*` extensions: steer, queue, rollback, checkpoints, set_model.
**Recommendation:** follow ADR-048 route B, but over **ACP stdio** (`--acp`) on the app-bundled CLI. It needs `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` and `CODEBUDDY_CONFIG_DIR=~/.workbuddy`. **Never call ACP `authenticate`**: it logs the user out first. Use one process per conversation, as WorkBuddy does. Before writing code, get the user's consent for one controlled probe (initialize plus `session/new`, no prompt). It must confirm that a standalone launch sees the user's WorkBuddy login.

---

## Part 1 — DeepSeek Harness (`dsh`)

### 1.1 What is installed, and version drift

| Copy | Version | Where |
|---|---|---|
| npm CLI the Hub uses | **0.2.1-rc.5** | `~/.nvm/versions/node/v26.13.0/bin/dsh` → `DSH_PKG/lib/bin.js`; `DSH_PKG/package.json` |
| second npm CLI | 0.2.1-rc.5 | `~/.nvm/versions/node/v26.11.1/bin/dsh` (`which -a dsh`) |
| DeepSeek Harness Desktop | **0.2.2-rc.3** (`com.deepseek.dsh`) | `/Applications/DeepSeek Harness.app`; bundled dsh packages are 0.2.2-rc.3 (`app.asar` → `/dsh/node_modules/@deepseek-ai/dsh-acp/package.json`); its shim `Contents/Resources/runtime/cli/bin/dsh` runs `dsh-desktop-host/lib/cli.js` under the app's Electron and is not on PATH |
| npm dist-tags (today) | `latest` 0.2.2-rc.1, `next` 0.2.2-rc.3 | `npm view @deepseek-ai/dsh dist-tags` |
| GitHub releases | dsh-v0.2.2-rc.3 published 2026-11-13, all prereleases | `gh api repos/deepseek-ai/deepseek-harness/releases` |
| Hub catalog source pin | rc.2 tag commit `687f282…` | `src/adapters/catalog.ts:53-56` |

So the Hub's CLI is two release candidates behind npm `latest`, and the Desktop app writing to the same `~/.dsh` is newer still. Between rc.5 and 0.2.2-rc.3:
- About 40 packages were added and some renamed (for example `dsh-desktop-host`, `dsh-fs-patch`, `dsh-mcp-manager`, `dsh-tool-executor-*`).
- The SDK protocol grew new methods (§1.3).
- The ACP contract changed only slightly. 0.2.2-rc.3 lists and resumes ordinary forks, and a config change takes effect at the next model step, mid-Turn included (diff of `dsh-acp/README.md` "Protocol contract" between the two copies).

### 1.2 Programmatic interfaces

`DSH_PKG/README.md:5-16`: "SDK and ACP are profiles, not separate public bins"; the entry-mode table lists `acp`, `headless`, `sdk`, `sdk-minimal` and `web`.

| Surface | Start | Transport | Status |
|---|---|---|---|
| **ACP** | `dsh --profile acp` | ACP v1 JSON-RPC over stdio | Documented "automation-only" surface. Upstream tests it with a keyless conformance test (`DSH_MODS/dsh-acp-app/README.md` "Standard automation workflow"). **What the Hub uses today.** |
| **SDK** | `dsh --profile sdk` (or `sdk-minimal`) | newline JSON-RPC over stdio | Documented, with a TS client (`dsh-sdk-client`, not in the npm install) and a Python SDK (`deepseek-harness-sdk` plus `deepseek-harness-runtime-bin`, which carries its own bundled `dsh`; GitHub `python/README.md`). "No protocol-version negotiation … pre-release stance, no compatibility promise" (`DSH_MODS/dsh-sdk-protocol/README.md:120`). |
| **Headless** | `dsh --profile headless --json [--session-id ID] "task"` | NDJSON on stdout, one task per process | Documented (`DSH_MODS/dsh-headless/README.md:76-80`). Events are `session/status/text/thinking/tool_call/tool_result/final/error`, emitted at commit points, not per token. |
| **Web host RPC** | `dsh --profile web --no-open --port N` | HTTP `POST /api` (Typert unary), WebSocket `/api/remote.mux` (streams and `$events`); auth is a launch token, then a signed cookie | Serves the dsh browser UI and Desktop. Has a documented **API caller** entry: `GET /connect?token=…&interactions=answer|none` returns an API cookie plus the mux (`DSH_MODS/dsh-client-connection/README.md:41,51`). Endpoint shapes are generated ("Generated by @deepseek-ai/dsh-typert-generator … do not edit", `DSH_MODS/dsh-api-session-controller/lib/typert.remote-client.d.ts:1`). No compatibility promise found. |
| Session log files | — | `~/.dsh/sessions/<projectKey>/<id>/session.v<N>.jsonl[.zstd]` | Internal persistence format (`dsh-session-persistence-jsonl`); the Hub reads it already (`src/adapters/control/dsh.ts:41-50`). |

**Richest:** the Web host RPC. **Officially intended for programs:** ACP, then the SDK.

### 1.3 SDK protocol in detail (why it cannot back the Hub)

- **0.2.1-rc.5** (`DSH_MODS/dsh-sdk-protocol/lib/types/types.d.ts`):
  - Requests: `initialize {cwd, provider, model, reasoningEffort?, maxTokens?}`, process-wide, so one model route per process; `session/prompt {sessionId, contentBlocks}` returns `{messageId}` (an enqueue receipt only); `session/resume`; `session/wait`; `session/working-directory/get|set`; `shutdown`.
  - Notifications: `session.event` (every durable SessionEvent of every session), `session.status` (`running`/`idle`), `subagent.started|finished`.
- Limits (`dsh-sdk-protocol/README.md:121-122`, `dsh-sdk-jsonrpc-server/README.md:130-131`): **no cancel or session-close method; to abandon a Turn you close the process**. No per-prompt result. Server→client requests (approvals) are "a dead capability".
- **0.2.2-rc.3** (Desktop copy) adds:
  - `session/query`, which runs slash commands.
  - Opt-in `approval/request` (`allowed-once | rejected | cancelled`), `user-question/ask` and `session.query.completed`.
  - It **still has no cancel** (Desktop copy, `dsh-sdk-jsonrpc-server/README.md` "Known Limitations").
- Gain over ACP: raw durable events (per-step usage, `tool/result.meta` diffs, turn-end reasons) arrive live instead of being read back from the log. Loss: no interrupt, no per-session MCP, no list, one model per process. **Not viable** until cancel lands.

### 1.4 Process model, auth, config home

- **ACP and SDK:**
  - One stdio child process. Stdout carries only protocol frames.
  - EOF, SIGINT and SIGTERM drain and exit (`dsh-acp-app/README.md` "Use this package").
  - HMR is disabled, so config changes need a restart.
  - One ACP connection can run several independent sessions (`dsh-acp/README.md:62`).
- **Web:**
  - A long-lived HTTP server on loopback, default port 3080 (`--port` changes it).
  - It prints a tokenized URL; that token is a credential and must never be logged.
  - The cookie-signing secret lives in `$DSH_HOME/.credentials.yaml` (`dsh-client-connection/README.md:43`).
- **Auth:**
  - The user's own login is the credential store (`$DSH_HOME/.credentials.yaml`, DeepSeek account or saved key) before env fallbacks, in the web, SDK and ACP profiles (`dsh-headless/README.md` "Credentials").
  - ACP `authenticate` is a no-op success (`dsh-acp/README.md:65`).
- **Config home:**
  - `$DSH_HOME`, default `~/.dsh`. Present here: `profiles/{acp,desktop,headless,web}`, `sessions` (241 project directories), `settings.yaml.imported`, `.credentials.yaml`.
  - Each profile has its own `cordis.patch.yml` over the shipped bundles, and the home-level `$DSH_HOME/cordis.patch.yml` applies on top (`DSH_PKG/README.md` "Profiles").
  - The permission preset of a process comes from `DSH_PERMISSION_MODE` (`DSH_MODS/dsh-base/cordis.patch.yml:240-276`).

### 1.5 Capability matrix

| Need | ACP (rc.5) | Web host RPC | SDK / headless |
|---|---|---|---|
| Create session | `session/new {cwd abs, mcpServers}` | `session/create {cwd \| workspaceId, sessionId?, agentPreset?}` (`types.d.ts:284-300`) | SDK: lazily on first prompt; headless: one fresh session per process |
| Resume | `session/resume` (no history replay) | `session/create` with an existing blank id, or any op that auto-resumes; `session/writer-held` error | SDK `session/resume`; headless `--session-id` |
| Text + images + files | text, raster images (if the route supports them), `resource_link` turned into `[resource_link …]` text; `embeddedContext:false` (`lib/index.js:1193-1197`) | `session/prompt {requestId, mode, content[]}` with images and **generic files** through upload receipts (`dsh-client-file-upload`) | SDK: ContentBlocks plus base64 images |
| Streaming | **Committed only**: one `agent_thought_chunk` / `agent_message_chunk` per committed `assistant/message` block (`lib/index.js:562-584`); no token deltas | `session/follow` stream: durable events **plus live Assistant chunks** (`assistant/live-chunk`, `dsh-api-session-controller/README.md:54`) | committed events only |
| Reasoning | as `agent_thought_chunk` (committed) | live | event `assistant/message` reasoning blocks |
| Tool calls | generic: `kind:"other"`, `title`=tool name, `rawInput`; results as content blocks; **no diff, no locations** (`lib/index.js:592-624`) | raw `tool/call` and `tool/result` incl. `meta` (fs diff); per-turn **workspace changes** with git/file diffs (`dsh-workspace-changes`) | raw events |
| Plans / todos | not on the wire ("plans, todos … unsupported", `dsh-acp/README.md:80`) | `/plan` plan mode with `exit_plan_mode` review (`dsh-plan-mode`); todo tool events | raw events |
| Steer | **none**: second prompt rejected "a prompt is already in flight" (`lib/index.js:798`) | `session/prompt {mode:'steer'}` (`types.d.ts:336`), `session/updateQueue` (edit, remove, steer queued) | SDK prompts only enqueue (**unconfirmed** whether claimed mid-Turn) |
| Interrupt | `session/cancel` / `$/cancel_request` | `session/cancel` | **none** (kill the process) |
| Approvals | `session/request_permission` with `allow_once`/`reject_once`, only when a sandbox-refused call asks to widen (`src/adapters/flavors/dsh.ts:10-12`) | `approval/request` waterfall answered by an API Peer with `interactions:'answer'` (`dsh-user-approval`, `dsh-api-gateway`); user questions via `dsh-user-questions` | 0.2.2 SDK only: opt-in `approval/request` |
| Hub levels | process preset via `DSH_PERMISSION_MODE`, pinned at session creation (current flavor, `flavors/dsh.ts:24-37`) | per session, live: `commands/execute` `/permission read-only\|workspace-write\|danger-full-access`, native `/plan`; an `auto` preset exists only with the experimental auto-review bundle (`dsh-permission-presets` README) | env only |
| Model / effort | `session/set_config_option` `model`, `reasoning_effort` (off/low/high/max) | `session/selectModel`, `session/modelCatalog` | SDK: once per process in `initialize` |
| Fork | **none** | `session/fork {sessionId, atSeq?}`: exact event prefix, even inside an open Turn (`README.md:63`) | none |
| Rollback | none | fork at a seq; no native file restore found (workspace-changes shows diffs only) | none |
| Compact | automatic only (compaction-basic runs on token pressure) | `/compact` via `commands/execute` (`dsh-command-compact`) | auto; 0.2.2 SDK `session/query` |
| Usage / cost | `usage_update {used,size}` = context occupancy only; the Hub reads per-request `usage` from the log (`dsh.ts:41-50`). No money cost anywhere found | projections `tokenUsage`, `contextPressure`, `sessionStats` (`dsh-token-meter`, `dsh-session-stats`) | raw `assistant/message.usage` |
| List / read sessions | `session/list` returns `{sessionId, cwd}` only, newest first, roots only (`lib/index.js:1300-1323`); no transcript replay | `session/list` (titles, running, availability), `session/search`, `session/page`, `session/follow` | none |
| Titles | LLM titles disabled in the acp profile; no title on the wire | `session/rename`; titles from first prompt or LLM (`dsh-session-title`) | disabled in the sdk profile |
| MCP / Hub tools | per-session stdio (absolute command) or HTTP servers on new and resume; server instructions enter the system prompt (`flavors/dsh.ts:42-45`) | profile config only (**unconfirmed** whether a per-session API exists) | profile config only |
| cwd per session | yes (absolute) | yes | SDK: `session/working-directory/set` |

### 1.6 Event model and mapping to Turn / item / event

Durable SessionEvents (`DSH_MODS/dsh-session/lib/types/types.d.ts:256-434`):
- `turn/start {turn}` … `turn/end {turn, reason}`. Reasons: completed, max-tokens, aborted, interrupted, blocked, error; seed-only `forked`.
- Inside each Turn, `step/start` … `step/end` frames one model call plus its tools.
- Messages: `user/message`, `developer/message`, `system/message` and `assistant/message {message, stream, usage?, interrupted?}`. `assistant/attempt` records a failed or retried attempt.
- Tools: `tool/call {callId, name, arguments}` and `tool/result {message, error?, meta?}`.
- Log-only records: `request/header` and `request/context`.
- `session/end-seed` marks a fork's inherited prefix.
- `plugin:*` records, plus plugin-merged types (permission preset, approval audit, workspace changes, title).
- Compaction replaces surface nodes in place (`surfaceOp: {op:'replace'}`).

Mapping:
- **Hub Turn** = one ACP `session/prompt`. One prompt can cover **several dsh turns**: descendants' results trigger later root turns inside the same prompt interval (`dsh-acp/README.md:76`). `dsh.ts:113-116` already sums usage over the turns added after `before`.
- **Items:**
  - user input → `user/message`
  - assistant message (reasoning + text) → `assistant/message`, one per step
  - tool item → the `tool/call` + `tool/result` pair keyed by `callId`
  - failed attempt → `assistant/attempt`
  - subagent → a separate child session; ACP hides it, and the SDK reports it through `subagent.*`
- **Events:** step boundaries, `usage_update`, config changes.
- **Gap:** ACP maps `error`, `blocked` and `aborted` turn endings to `stopReason: "end_turn"` (`DSH_MODS/dsh-acp/lib/index.js:539-549`). An errored dsh Turn therefore looks complete on the ACP wire. That breaks the Hub's "no false report" rule unless the Hub reads `turn/end.data.reason.kind` from the log. `dsh.ts` reads `turn/end` today only to detect the end.

### 1.7 ACP today: what we get and what we miss

**We get:**
- Persistent sessions (new, list, resume, close) and absolute cwd per session.
- Per-session MCP (that is how Hub tools reach dsh today).
- Model and `reasoning_effort` options, text and raster images, `resource_link`.
- Committed messages, thoughts and tool lifecycle; context occupancy; cancel.
- One-shot permission prompts on sandbox escape.
- Plus, from our own log read: per-Turn token usage and the Turn's end (`dsh.ts`).

**We miss:**
- Token streaming.
- Typed tool items: kind, diff, locations. The diff is in `tool/result.meta` in the log; `docs/decisions/0038-…:70` already records the `editDiff` gap.
- Plans and todos, titles, steer (one prompt at a time), fork, rollback, manual compact.
- Plan mode and per-session permission switching: `/permission` reaches the model as text (`flavors/dsh.ts:15-16`).
- ask-user questions: elicitation is unsupported, and the tool's behaviour over ACP is **unconfirmed**.
- Session search, list titles, subagent visibility, cost.
- A truthful error stop reason (§1.6).

**Gained or lost by switching:**
- **To the Web host RPC:**
  - Gains: everything in the right-hand column of §1.5. Most important are live streaming, steer, queue editing, fork at any seq, titles and rename, `/compact`, `/plan`, `/permission`, per-turn diffs and live projections.
  - Losses: a standard protocol (we would have to implement the Typert unary envelope, the mux framing `open/item/end/cancel` and the `$events` waterfall replies; `dsh-api-gateway/README.md`); stability (generated, internal, no compatibility statement); simplicity (launch token from stdout, cookies, a long-lived server per DSH_HOME).
  - The `web` profile's composition also differs from `acp`: agent presets `standard/ptc/minimal/cordis`, a different tool roster, `DSH_WEB_URL` exposed to shell commands (`dsh-web-app/README.md`). Per-session MCP injection is **unconfirmed**.
- **To the SDK:** gains raw events; loses interrupt (fatal), MCP per session, list and per-process model.
- **To headless:** nothing worth having; one task per process.

### 1.8 Risks and version drift

1. Release candidates move fast. The npm `latest` has moved past the installed rc.5, and the Desktop's 0.2.2-rc.3 adds and renames many packages. The ACP surface has stayed nearly identical between the two (`grep` of feature tokens in both `dsh-acp/lib/index.js`). The SDK and Web host have not.
2. **Shared `~/.dsh` with a newer writer.** A reader refuses a log that contains an unknown non-ignorable event type (`DSH_MODS/dsh-session/lib/types/known-event-types.d.ts`). A session the Desktop 0.2.2 touched may become unreadable to the npm rc.5 ACP resume (**unconfirmed**). Mitigation: resolve and pin which `dsh` the Hub launches, prefer the newest installed copy, and show the version.
3. Our log reader depends on internal paths and encodings (`projectKey`, `encodeSegment`, `session.v<N>`, zstd). Format migrations v0→v4 exist, and a v5 would break it silently (the reader currently returns null, so no numbers).
4. Error Turns reported as `end_turn` (§1.6).
5. One prompt in flight per session, and the prompt includes descendants' follow-up turns. A Hub "steer" must be Hub-side: queue the next Turn, or cancel and resend.
6. The permission preset is pinned at creation (`flavors/dsh.ts:14-18`); level changes after creation only change how the Hub answers.

### 1.9 Recommendation (dsh)

1. **Keep ACP** as the adapter's backbone. It is the documented automation surface, has the least drift and fits the Hub's model: the Hub owns the record and dsh executes Turns.
2. **Fix now:**
   - Read `turn/end.data.reason.kind` from the log, and report an error, blocked or aborted Turn as such.
   - Extend the existing log read to `tool/result.meta` for file diffs and to `assistant/message.usage` (already done).
   - Pin and display the launched `dsh` path and version.
   - Update the catalog's upstream pin from rc.2 to the version actually run.
3. **Hub-side features:**
   - steer = queue the next Turn, or cancel and resend
   - fork and rollback = a new native session seeded from the Hub's record (`fork: "none"` stays native)
   - title = Hub-generated
   - plan = the Hub's plan tool (current `planTool: "hub"`)
4. **Spike, time-boxed:** a read-only probe of the Web host RPC against a temporary `DSH_HOME`, for `session/create|prompt(steer)|follow|cancel|fork|rename` plus `commands/execute`. If it works and the user accepts an internal contract, add it as an optional "rich" driver and keep ACP as the fallback. Re-check the SDK when upstream adds cancel.

---

## Part 2 — WorkBuddy

### 2.1 What is installed

- **App:** `/Applications/WorkBuddy.app`, `com.tencent.workbuddy.mac`, version **5.9.3** (Info.plist). It is Electron, and its URL scheme is `workbuddy://`. The app is running now, user-launched (pids 15204 main, 15748 `daemon-app-server-entry.js --stdio`).
- **Bundled engine:** `WB_CLI`, package `@genie/agent-cli` **2.165.0** with `publishConfig.name: "@tencent-ai/codebuddy-code"`, so it is CodeBuddy Code. Its bins are `codebuddy`, `cbc`, `cbc-prewarm` and `codebuddy-lowmem` (`WB_CLI/package.json`).
  - Only the WorkBuddy-specific build `dist/codebuddy-lite-wb.mjs` (plus `dist/lazy-lite-wb/`) ships.
  - `product.json` sets `productName: "WorkBuddy"`, `dataFolderName: ".workbuddy"`, endpoint `https://www.workbuddy.cn` and auth `workbuddy-desktop`.
- **Versions:** npm `@tencent-ai/codebuddy-code` `latest` is **2.184.0** (`npm view`). ADR-048 recorded 2.115.0 inside WorkBuddy 5.3.14 (`docs/decisions/0048-harness-scope-and-workbuddy.md:19`).
- **Data:**
  - `~/.workbuddy` holds `settings.json`, `workbuddy.db`, `keyblob`, `security/`, `sessions/` (empty), `wbipc/endpoint.json` with keys `endpoint` and `ticket`, and `binaries/node/versions/22.22.2-6`.
  - `~/.codebuddy` holds only `diagnostics` and `logs`.
  - The CLI's own default home is `~/.codebuddy` unless `CODEBUDDY_CONFIG_DIR` is set (`codebuddy-lite-wb.mjs` @1186107, `JobFileStore`), which matches ADR-048's finding.

### 2.2 Is there a supported way to drive WorkBuddy from another program?

**The WorkBuddy app: no.** Nothing in the app is offered for external programs.
- Deep links open UI views only: `workbuddy://chat/<sessionId>`, `workbuddy://automation/run?…`, `home`, `agentmail` (`WB_MAIN/main-bootstrap.js` @663048).
- `~/.workbuddy/wbipc/endpoint.json` names an internal broker. Its pipe protocol (`broker/GetPipe`, `broker/ListPipes`) is authenticated by a ticket (`WB_MAIN/server.js`, `wbipcDiscoveryPath`).
- The daemon talks to Electron over stdio.

None of these are documented for external use. Public results show only IM remote control ("WorkBuddy Claw") and custom models, not a local API (web search, ifanr and cloudbase pages).

**Its engine, CodeBuddy Code: yes, officially.** The following are documented on Tencent's CLI docs, hosted under workbuddy.ai and codebuddy.cn:
- ACP over stdio, `codebuddy --acp` (https://www.workbuddy.ai/docs/cli/acp).
- The HTTP API, `codebuddy --serve`: REST under `/api/v1/*` plus ACP over SSE at `/api/v1/acp`; OpenAPI at `/api/openapi.json`; marked Beta (https://www.codebuddy.cn/docs/cli/http-api).
- The Agent SDK, TS `@tencent-ai/agent-sdk` and Python `codebuddy-agent-sdk`; marked Preview. It locates the CLI through `CODEBUDDY_CODE_PATH` (https://www.workbuddy.ai/docs/cli/sdk).
- `-p --output-format stream-json --input-format stream-json`.

**But** those docs describe the npm product, which has its own login and data in `~/.codebuddy`. Driving the **app-bundled** copy against WorkBuddy's data is not documented anywhere: possible, unsupported. Using the npm CodeBuddy Code instead would be a different Harness, with a different account and product config, so it would be an implicit Harness change.

### 2.3 How WorkBuddy itself drives the engine

1. Electron main starts `daemon-app-server-entry.js --stdio`.
2. Per conversation, the daemon starts a sidecar: `<node> WB_CLI/bin/codebuddy --serve --session-id <id> --port 0 …` (`WB_MAIN/server.js` @1994148 `buildColdStartArgs`, @1983707 `buildPrewarmActivateArgs`). `--acp` is explicitly filtered out (@1986590).
3. A prewarm pool keeps spare processes: `--prewarm --prewarm-id`, see `WB_MAIN/cli-prewarm-pool.js`.
4. The daemon then speaks **ACP over HTTP/SSE** to the sidecar with the ACP SDK's `ClientSideConnection` (`WB_MAIN/node.js` @87315, `WB_MAIN/conversations.js` @613486).
5. Launch arguments (`buildAgentCliRuntimeArgs`, `server.js` @3536006):
   - `--permission-mode`, `--permission-mode-before-plan`, `--model`, `--tools`.
   - `--allowedTools`/`--disallowedTools`.
   - `--system-prompt-file` (WorkBuddy's own prompt), `--prompt-vars-file`.
   - `--settings` JSON (trusted directories, permission allow/ask rules, sandbox, hooks, language).
   - `--mcp-config <file> --strict-mcp-config` (the app's connectors).
6. Environment: `CODEBUDDY_HOST_CAPABILITIES=elicitation.form,…` (@3553927), credential-bootstrap variables and `WORKBUDDY_AT_REST_ENCRYPTION` (`WB_MAIN/sidecar-entry.js`, `credential-protection-bootstrap.js`).

A bare CLI launch therefore does **not** reproduce the app's persona, connectors, tool allow-list or settings. It is "WorkBuddy's engine with WorkBuddy's login", not "the WorkBuddy app". Fidelity is **unconfirmed** until probed.

### 2.4 Process model, start, auth, config home (for the Hub)

- **Command:** `WB_CLI/bin/codebuddy --acp` (stdio). The launcher needs Node ≥ 18.20.8 (`bin/codebuddy` `minNode`). WorkBuddy runs it under its own Node 22.22.2 (`~/.workbuddy/binaries/node/...`). ADR-048 chose PATH's Node; Node 26 compatibility is **unconfirmed**.
- **Required env `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`.** The launcher otherwise looks for `dist/codebuddy-headless` and then `dist/codebuddy`. Neither exists in this bundle, so the process would exit with `MODULE_NOT_FOUND` (`WB_CLI/bin/codebuddy:259-296`, static reading).
- **Config home:** `CODEBUDDY_CONFIG_DIR=~/.workbuddy` and `WORKBUDDY_CONFIG_DIR=~/.workbuddy`, per ADR-048 route B. Without them the CLI makes a private `~/.codebuddy`.
- **Auth:**
  - `initializeSession` throws "auth required" when the CLI's auth manager has no session (`codebuddy-lite-wb.mjs` @2838645).
  - **ACP `authenticate` logs out an existing user before starting a new interactive login** (@2833058). The Hub must never call it. Today's `AcpControl` does not (`grep authenticate src/adapters/control/acp.ts` finds nothing).
  - A standalone launch, with no credential bootstrap variables, runs in `standalone` credential mode (@1735507). Whether it can read WorkBuddy's stored, possibly at-rest-encrypted login under `~/.workbuddy` is **unconfirmed**. Settling it needs one controlled probe, `initialize` + `session/new` with no prompt, which reads the user's login and may refresh tokens. **Ask the user first.**
- **One process per conversation:** the ACP agent keeps a single current session (`currentSession`, writer locks `takeWriter`/`writer_occupied`, @2841825). WorkBuddy also runs one sidecar per conversation.
- **Side effects to switch off in Hub processes** (variable names exist in the bundle; their effect is **unconfirmed**):
  - `DISABLE_AUTOUPDATER` (the lite-wb build appears to have no updater bucket).
  - `CODEBUDDY_DISABLE_AUTO_MEMORY`.
  - `DISABLE_TELEMETRY`, which gates the OTel traces. Product telemetry may be separate. ADR-048 leaves telemetry to the user.
  - `--no-plugin-management`, so marketplace and plugin reconciliation do not run against the app's `~/.workbuddy`.

### 2.5 Capability matrix (bundled CLI 2.165.0)

| Need | ACP stdio (recommended) | Other surfaces |
|---|---|---|
| Create / resume | `session/new` (`_meta` `codebuddy.ai/continue`, `takeWriter`); `session/load` (replays history as updates); `session/resume` (unstable_resumeSession). **No `session/list`, `session/fork` or `session/close` handlers** in this build (`async` methods @2838645–2900326). | CLI `--session-id`, `-r/--resume`, `-c/--continue`; REST `/api/v1/sessions` with `--serve` |
| Text + images + files | `promptCapabilities {image:true, embeddedContext:true}`; MCP over http and sse (@2832639) | stream-json input |
| Streaming | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `current_mode_update`, `config_option_update`, `model_update`, `available_commands_update`, `session_info_update`, `session_end`, plus **non-standard** `tool_call_pending`, `tool_call_arguments_delta/done` and `terminal_update/terminal_output_chunk` (counted in the bundle). Per-token text is likely, since the app's own UI runs on this ACP (**unconfirmed**). | stream-json, `--include-partial-messages` |
| Steer | ext `session/steer {sessionId, contentBlocks, clientUserMessageId?, expectedRequestId?}` returns `{steered, reason: idle\|stale}` (@2918063); message queue ext (`session/enqueue_message`, `send_queue_item_now`, `enqueue_followup`, …) (@2900326) | — |
| Interrupt | `session/cancel` | stream-json control `interrupt`; REST `/runs/{id}/cancel` |
| Approvals | standard `session/request_permission`; ext `_codebuddy.ai/requestSensitiveApproval`/`cancelSensitiveApproval`; questions through elicitation when the host advertises it (WorkBuddy sets `CODEBUDDY_HOST_CAPABILITIES=elicitation.form`) | stream-json `can_use_tool` control (@3509421); SDK `canUseTool` |
| Hub levels | Modes and config option `mode` (@2823071): `default` (Always Ask), `acceptEdits`, `plan`, `auto` (AI classifier), `dontAsk`, `bypassPermissions` ("HIGH/CRITICAL still ask"), `fullAccess`, `delegate`; live via `session/set_mode` or `set_config_option`, or at start with `--permission-mode` | — |
| Model / effort | config options `model` and reasoning (minimal…max); ext `session/set_model`; `--model`, `--effort` | stream-json `set_model` |
| Fork | not over ACP; at process start `--resume <id> --fork-session` (+ `--resume-session-at <msg id>` in print mode) | — |
| Rollback | ext `_codebuddy.ai/session/rollback` (conversation plus file rollback, @2903437); `_codebuddy.ai/checkpoint/list|read` | `--rewind-files <user-message-id> [--dry-run]`; stream-json `rewind_files` |
| Compact | `session/prompt` with `_meta["codebuddy.ai"].isCompactSession: true` (control prompt, @2852285); `--autocompact` | — |
| Usage / cost | `usage_update {used,size}` + `_meta` `usageByCategory`; keys `codebuddy.ai/requestCredits`, `contextUsed` (WorkBuddy bills in credits). Exact per-Turn tokens **unconfirmed**. | SDK `result.total_cost_usd`, `duration_ms` |
| List / read | `session/load` replay only | REST `/api/v1/sessions`, `/sessions/{id}/history` (`--serve`); on-disk location **unconfirmed** |
| Titles | `session_info_update` with `codebuddy.ai/sessionTitle` | REST `/sessions/{id}/rename` |
| MCP / Hub tools | `mcpServers` on new, load and resume (converted to the CLI's dynamic MCP config) | `--mcp-config`, `--strict-mcp-config`; `--append-system-prompt[-file]` for session instructions |
| cwd | process cwd. `session/new`'s `cwd` is not read in this build (static reading, @2841825) | `--add-dir` for extra directories |

**Level mapping (proposal):**

| Hub level | CodeBuddy mode | Note |
|---|---|---|
| plan | `plan` | |
| ask | `default` | |
| auto-edit | `acceptEdits` | |
| auto | `bypassPermissions` | HIGH/CRITICAL prompts are answered by the Hub per the default-allow rule. `auto` is not used: its classifier denies risky actions, which conflicts with default-allow. |
| full | `fullAccess` | The REST docs say `fullAccess` is accepted only for local Web UI requests. Whether ACP accepts it from the Hub is **unconfirmed**; fall back to `bypassPermissions`. |

### 2.6 Event model mapping

- **Hub Turn** = one `session/prompt` and its `stopReason`. Its `_meta` carries `codebuddy.ai/requestId` and `conversationRequestId`.
- **Items:**
  - assistant text by `messageId` from `agent_message_chunk`
  - reasoning from `agent_thought_chunk`
  - tool item by `toolCallId`: `tool_call`, then `tool_call_update`; `pending` and `arguments_*` are pre-states
  - plan from `plan` entries
  - terminal output
  - subagents through `_meta` `codebuddy.ai/parentToolCallId`, `isSubagent`, `parentSessionId`
- **Session-level events:** mode, config, model, title (`session_info_update`), commands, usage, `session_end`.
- The Hub's ACP parser must tolerate the non-standard `sessionUpdate` kinds.

### 2.7 Risks

1. Not a supported integration. The bundle path, the `CODEBUDDY_FORCE_LITE_WB_BUNDLE` switch and the credential-bootstrap design are internal, and any app update can change them. The app updated from 5.3.14 to 5.9.3 in three weeks, and its CLI from 2.115 to 2.165.
2. **Login loss:** calling `authenticate` logs the user out. A failed standalone credential read means "auth required", and the Hub must say so plainly, not retry.
3. **Shared `~/.workbuddy` with the running app:** writer locks, plugin and marketplace reconciliation, settings writes, token refresh races (**unconfirmed**). Use `--no-plugin-management` and never `--prewarm`.
4. Fidelity: without the app's system prompt, connectors and settings, behaviour differs from the app (§2.3).
5. Hub sessions will not appear in the app's conversation list (ADR-048), consistent with "Hub owns sessions".
6. Extensions (`_codebuddy.ai/*`, `session/steer`) are vendor-specific. The public ACP page documents only a few `_meta` keys and marks nothing stable.

### 2.8 Recommendation (WorkBuddy)

1. Implement **route B over ACP stdio**:

   ```
   <node> WB_CLI/bin/codebuddy --acp [--permission-mode M] [--model X] [--no-plugin-management]
   CODEBUDDY_FORCE_LITE_WB_BUNDLE=1  CODEBUDDY_CONFIG_DIR=~/.workbuddy  WORKBUDDY_CONFIG_DIR=~/.workbuddy
   ```

   - Run one process per conversation, with the conversation's cwd as the process cwd. The adapter can reuse the generic `AcpControl` and add a WorkBuddy flavor (modes, steer extension, rollback extension, compact control prompt).
   - Discovery: read `WB_CLI/package.json` for the version as an app-bundle channel, as ADR-048 and ADR-044 describe.
2. **Before coding:**
   - Get the user's consent for one controlled probe: `initialize` + `session/new`, no prompt, under `~/.workbuddy`. It confirms the login is visible, the PATH Node works and `cwd` handling.
   - Get the telemetry decision that ADR-048 left open.
3. Do not use the npm CodeBuddy Code as "WorkBuddy". Do not use `--serve` either: ACP over HTTP adds a password and port with no gain for a single Hub client.

---

## Appendix — what was done

- **Read:**
  - The dsh npm package READMEs and `.d.ts` files, and `dsh-acp/lib/index.js`.
  - The Desktop 0.2.2-rc.3 copies, by parsing `app.asar` with a small header reader.
  - The WorkBuddy app.asar header, with selected `main/*.js` extracted to the temp folder.
  - The bundled CLI `bin/` and `dist/` files.
  - The public CodeBuddy docs (workbuddy.ai, codebuddy.cn).
  - The GitHub API for dsh releases and the Python README.
  - npm dist-tags.
- **Not run:** any dsh server or profile, any CodeBuddy or WorkBuddy CLI command (not even `--version`), any ACP handshake, any model call.
- **Secrets:** no secret values were printed. Config files were inspected by key name only.
- **Cleanup:** the temp folder `…/native-research/tmp-dsh/` and the helper `…/native-research/scripts/` were deleted afterwards.
