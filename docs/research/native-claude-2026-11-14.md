> 2026-11-14 原生接入调研（只读）。T3 Code 源码：github.com/pingdotgg/t3code @ d19467a5；文中 `/private/tmp/…/scratchpad/` 下的路径是调研时的临时目录。

# Connecting HarnessHub to Claude Code natively — research report

Date: 2026-11-14. Read-only research; nothing in the repo, `~/.claude`, `~/.claude.json` or the running service was changed. No model Turn was started and no `claude` session was launched (so no runtime numbers were measured on this Mac; see "Not confirmed" at the end).

Sources used

- Installed CLI: `claude` 2.1.316, `~/.nvm/versions/node/v26.13.0/bin/claude` → `lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, which is a **Mach-O arm64 native binary** (310 MB) despite the `.exe` name. `claude --help` (full flag list quoted below where relevant).
- Agent SDK type files, downloaded with `npm pack` into the temp folder (since deleted): `@anthropic-ai/claude-agent-sdk@0.3.325` (latest, published 2026-11-13, `claudeCodeVersion` 2.1.325) and `@0.3.316` (the release paired with the installed CLI). Line numbers below are from **0.3.325 `sdk.d.ts`** unless marked otherwise.
- Official docs (fetched 2026-11-14): code.claude.com/docs/en/agent-sdk/overview, …/agent-sdk/streaming-vs-single-mode, …/agent-sdk/sessions, …/agent-sdk/permissions, …/agent-sdk/hosting, …/agent-sdk/typescript, …/headless, …/legal-and-compliance; the SDK CHANGELOG on GitHub.
- T3 Code at commit d19467a5 (paths relative to its repo root).
- HarnessHub worktree `relay-stage2-7cb3e9`, and the installed ACP adapter at `/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp` (0.99.1).

---

## Summary

- The richest **officially supported** programmatic interface of Claude Code is the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, TS). It is not a separate engine: it spawns the `claude` binary with `--output-format stream-json --verbose --input-format stream-json` and speaks a bidirectional control protocol over stdin/stdout. Headless `claude -p` with stream-json is the same wire, minus the control protocol helpers (callbacks for permissions and hooks, in-process MCP servers), which are documented only through the SDK's types. Our current ACP path is itself an SDK consumer (claude-agent-acp 0.99.1 embeds SDK 0.3.312), plus one more process and a lossy ACP translation.
- `pathToClaudeCodeExecutable` makes the SDK run the user's installed binary. If it is not set and the bundled platform binary is missing, the SDK throws. It never falls back silently, so the Hub stays in control of which binary runs.
- Process model: one `claude` process per session (`query()`). In streaming-input mode the process stays alive across Turns until the Hub closes it. Resuming starts a new process with `resume: <sessionId>`, and optionally `resumeSessionAt: <message uuid>`, which rolls the native transcript back to the Hub's view.
- Almost everything the Hub's unified protocol needs is available natively:
  - streaming text and thinking, tool calls with structured inputs and outputs, and subagents/background tasks;
  - steering with `priority: 'next' | 'now' | 'later'`, interrupt with a receipt, `canUseTool` and `permissionMode` for the five levels;
  - live changes to model, effort and fast mode, fork at a message, rollback, compaction, per-model usage and cost, rate-limit events;
  - listing and reading native sessions, titles, per-session MCP (including in-process Hub tools), and flag-layer settings that never touch the user's files.
- Main risks:
  - **Policy on subscription logins.** Anthropic's legal page says SDK-based products should use API keys and must not "route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users". It also says this does not stop "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". This risk is the same for the ACP path we use today.
  - **SDK churn.** 23 releases in the last 30 days.
  - **Licence.** The SDK is proprietary, not MIT.
  - **Version coupling.** The SDK should not be newer than the user's CLI.
- **Recommendation:** move Claude Code from ACP to a direct Agent-SDK driver, in streaming-input mode with an exact-pinned SDK, always pointed at the user's binary. Build it slice by slice and delete the ACP driver once the SDK driver passes real-machine smoke. Details in §8.

---

## 1. Interfaces Claude Code 2.1.316 offers

| Interface | What it is | Official? | Richness |
|---|---|---|---|
| **Agent SDK (TypeScript)** `@anthropic-ai/claude-agent-sdk` | Library; `query()` spawns `claude` and drives it over stdio with a control protocol | Yes, the documented programmatic interface ("Build production AI agents with Claude Code as a library", agent-sdk/overview) | Richest: 40 message kinds in `SDKMessage`, 30 `Query` control methods, callbacks for permissions/hooks/elicitation/dialogs, in-process MCP, session helpers |
| **Headless `claude -p`** with `--input-format stream-json --output-format stream-json [--include-partial-messages] [--replay-user-messages] [--include-hook-events] [--permission-prompt-tool …] [--permission-prompts host\|none]` | Same process the SDK spawns | Yes (docs/en/headless: "Use the Agent SDK to run Claude Code programmatically from the CLI"). The page documents message kinds but not the control protocol | Same events. Without the SDK you must implement `initialize`, `can_use_tool`, `hook_callback`, `mcp_message` and other control frames yourself. They are typed only in `sdk.d.ts` (`SDKControlRequest` ~5432, `StdoutMessage` ~10355) |
| **ACP via claude-agent-acp** | Separate Node adapter (Anthropic/Zed/JetBrains, `"license": "proprietary"`, `acp-registry.json:186-216`) that embeds the SDK and translates to ACP JSON-RPC | Third-party-maintained wrapper of the SDK (ACP registry) | Lossy subset of the SDK (see §6) |
| `--bg` / `claude agents` / `attach` / `logs` / `--remote-control` / `--cloud` | Background-session daemon and remote control | Yes, but for people, not hosts | Not a host API |
| SDK `/bridge` and `/browser` entries | Transport handles for cloud (CCR) workers (`bridge.d.ts:1-28`) | Alpha | Not relevant locally |
| `claude mcp …` | Manages MCP config; Claude Code can also run as an MCP server | Yes | Exposes tools, not agent sessions (whether `mcp serve` is still present in 2.1.316 is not confirmed) |

**Richest and supported: the Agent SDK.** The headless docs themselves point programmatic users there: "For the Python and TypeScript SDK packages with structured outputs, tool approval callbacks, and native message objects, see the full Agent SDK documentation" (docs/en/headless).

### How the SDK uses a given `claude`

- `Options.pathToClaudeCodeExecutable?: string` — "Path to the Claude Code executable. Uses the built-in executable if not specified." (`sdk.d.ts:2107-2110`).
- In `sdk.mjs`:
  - When the path is unset, the SDK resolves `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` from its optional dependencies. If that is absent it throws `Native CLI binary for <platform>-<arch> not found. Reinstall … without --omit=optional, or set options.pathToClaudeCodeExecutable.`
  - When the path is set, it spawns that path directly.
  - A path ending in `.js/.mjs/.ts/.tsx/.jsx` runs through a JS runtime (`executable: 'bun'|'deno'|'node'`, `executableArgs`). Any other path is treated as a native binary. So the user's `claude.exe` (Mach-O) is run directly.
- Arguments the SDK always passes: `--output-format stream-json --verbose --input-format stream-json`, plus flags derived from options:
  - `--thinking…`, `--effort`, `--model`, `--resume`, `--setting-sources`, `--permission-mode`, `--mcp-config <json>`, `--allowedTools` and others;
  - `--permission-prompt-tool=stdio` when `canUseTool` is given.
- Environment: when `CLAUDE_CODE_ENTRYPOINT` is unset the SDK sets it to `sdk-ts`. It also deletes `NODE_OPTIONS`.
- The bundled binary is large. The 0.3.325 `manifest.json` lists `darwin-arm64` at 347,406,976 bytes, shipped as optional dependency `@anthropic-ai/claude-agent-sdk-darwin-arm64`. With pnpm we can skip it (`pnpm.ignoredOptionalDependencies`, or install without optionals). Then a missing `pathToClaudeCodeExecutable` fails closed instead of silently running a different Claude Code.

### Versions and Node

- SDK `engines.node >=18.14.0`; docs say "Node.js 18.14+ for the TypeScript SDK" (agent-sdk/hosting). HarnessHub requires Node ≥24 (`package.json`), and the Mac has Node 26.13.0. Fine.
- Peer dependencies: `zod ^4`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29`. The root entry inlines them at runtime (its runtime imports are Node built-ins only). `sdk.d.ts:1-15` imports their types, so they are needed for type checking or need `skipLibCheck`. The `/core` entry does not inline them (README).
- SDK version tracks CLI version: SDK 0.3.N bundles Claude Code 2.1.N (`package.json` `"claudeCodeVersion"`; docs/typescript: "SDK v0.3.191 bundles Claude Code v2.1.191"). The installed CLI 2.1.316 pairs with SDK **0.3.316**.
- Compatibility direction (inferred, not documented as a contract): each SDK package's `manifest.json` carries `sdkCompat.testedWrapperVersions` for its bundled CLI.
  - CLI 2.1.316 lists SDK wrappers **0.3.283–0.3.306** (22 versions).
  - CLI 2.1.325 lists **0.3.291–0.3.324** (30 versions).
  - So a CLI is tested against older SDKs, never newer ones. **Keep the SDK at or below the user's CLI version, within ~30 patches.** Feature-detect with `system/init.capabilities` and `claude_code_version` instead of sniffing versions (docs/headless "Read session metadata"). Many options say "older CLIs ignore the field" (for example `verbatimPrompts`, `sdk.d.ts:2020`).
- For reference: T3 Code depends on `^0.3.321` (`apps/server/package.json:39`) and its manifest recommends Claude Code `>=2.1.301` (`apps/server/src/provider/model-manifest.json:26-29`). Our ACP adapter runs SDK 0.3.312 against CLI 2.1.316 today.

---

## 2. Process model

- **One `claude` process per session.** "One agent session maps to one subprocess. Running N concurrent sessions means N subprocesses" (agent-sdk/hosting, "The subprocess model"). There is no multi-session process, so ADR-056's multi-session host does not apply. The nearest equivalent is the SDK's spare-process pool (below).
- **Streaming-input mode** (`prompt: AsyncIterable<SDKUserMessage>`) is "the preferred way". It "allows the agent to operate as a long lived process that takes in user input, handles interruptions, surfaces permission requests, and handles session management" (agent-sdk/streaming-vs-single-mode).
  - Every control method on `Query` (interrupt, setModel, setPermissionMode, applyFlagSettings, …) is "only supported when streaming input/output is used" (`sdk.d.ts:3024-3028`).
  - Single-message mode does not support images, queueing or interrupts.
- **Lifetime.**
  - The process lives until the Hub calls `close()` (or `[Symbol.asyncDispose]`), the input iterable ends, or the process dies. There is no session timeout ("Known limitations", agent-sdk/hosting).
  - `close()` ends stdin first, then signals after a ~2 s grace (`SpawnOptions.signal` docs, `sdk.d.ts:10302-10340`).
  - SIGTERM leaves the running Turn unfinished. SIGINT or `interrupt()` ends it cleanly (docs/headless "Stop a run with SIGTERM").
  - Background work (background Bash, background subagents, Monitor, workflows) **lives in the process**. Closing the process kills it. T3 refuses to replace a process with live background work (`ClaudeAdapterV2.ts:12104-12113`).
- **Wake turns.** A live process can start a Turn the host did not send, for example when a background task finishes (`task_notification`), on a scheduled wakeup, or from a Monitor. The host must attribute frames to its own prompt by `user_message_uuid`/`user_message_uuids`, which the CLI echoes only when the host set `uuid` on the message (docs/typescript). T3 has a whole "prompt echo gating" layer for this (`ClaudeAdapterV2.ts:11343-11491`), plus `isClaudeResultForOtherTurn` and wake buffering.
- **Resume.**
  - A new process with `resume: <id>` loads `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, or the same path under `$CLAUDE_CONFIG_DIR`. Since 2.1.223 the lookup searches all projects (agent-sdk/sessions).
  - `sessionId: <uuid>` fixes the id of a new session (`sdk.d.ts:2227-2232`). T3 uses `sessionId` for the first open and `resume` afterwards (`ClaudeAdapterV2.ts:2022-2024`, `12140-12145`).
  - `resumeSessionAt: <uuid>` truncates to a message (§3, rollback).
  - MCP servers connect in the background by default (changelog 0.3.142, breaking), so a resumed session's first request can go out before they connect. T3 sets `MCP_CONNECTION_NONBLOCKING=0` on resume (`ClaudeAdapterV2.ts:1892-1917`).
- **Cost of starting.** Spawn, initialize handshake, settings, plugins, MCP connections and SessionStart hooks, then the first API request.
  - Docs: a pre-warmed spare uses "roughly 230 to 260 MB while it waits" (docs/typescript, `prewarm`). "1 GiB RAM, 5 GiB disk, and 1 CPU per agent is a reasonable starting point" (agent-sdk/hosting).
  - T3 allows 5 minutes for boot on overloaded hosts and 90 s for MCP registration (`ClaudeAdapterV2.ts:352-353`).
  - To hide start-up latency: `startup()` returns a warmed `WarmQuery` (`sdk.d.ts:10342-10356`, `10741-10752`). `prewarm()` returns a `SpareProcess` that can be `claim()`ed later with a `cwd` (alpha, `sdk.d.ts:2998-3005`, `348-404`, `10166-10247`). Per-session `claim` options include model, permissionMode, settings overlay, appendSystemPrompt and title.
  - **Not measured here**: launching `claude` might touch `~/.claude.json`, so no session was started. `claude --version` takes 0.01 s, which says nothing about session start.
- **Current Hub behaviour, for contrast.** The ACP Claude driver closes the adapter process at the end of each Turn by default (`src/adapters/control/claude.ts:46-49`, ADR-053 reference). With the SDK that is still possible (resume each Turn), but it kills background work and pays start-up per Turn. Better: keep the process while a Turn or background work is live, and release it when idle.

---

## 3. Capability by capability

Notation: **Yes** = native in SDK 0.3.316/0.3.325 against CLI 2.1.316, unless a minimum version is given.

### Start and resume a session — Yes
- `query({ prompt: asyncIterable, options: { cwd, sessionId | resume, model, permissionMode, … } })` (`sdk.d.ts:3458-3461`, Options `1651-2615`).
- The session id is in `system/init.session_id` and on every message. `continue: true` picks the most recent session in the cwd; the Hub should not use it.
- `persistSession: false` keeps the transcript in memory only (useful for probes).

### Send a Turn with text, images and files — Yes
- A Turn is an `SDKUserMessage` (`sdk.d.ts:6869-6970`) whose `message` is an Anthropic `MessageParam`. Content blocks:
  - `text`;
  - `image` (base64: png/jpeg/gif/webp; T3 `ClaudeAdapterV2.ts:2614-2627`, `2899-2906`);
  - `document` (base64 PDF; T3 `2954-2957`).
- T3 sends other files as paths in the text (`providerMessageTextWithAttachmentPaths`, `2825-2834`) and adds the attachments folder to `additionalDirectories` (`2146-2150`). T3 budgets 28 MB / 100 PDF pages per message to stay under the API's 32 MB request limit (`2756-2757`, `2841-2844`).
- Other fields:
  - `uuid` — echoed back to bind the reply to the send;
  - `pasted_content` / `inline_pastes`;
  - `shouldQuery: false` — append to the transcript without a Turn (docs/typescript);
  - `client_composed: true` — deliver verbatim: no `@path` expansion, no slash dispatch, and the turn-start attachment pass is skipped (`sdk.d.ts:6923-6926`; options-wide `verbatimPrompts`, `2001-2024`, ≥2.1.248).

### Streaming events — Yes
- Partial text and thinking: `includePartialMessages: true` → `stream_event` with raw Messages API stream events (`content_block_delta` `text_delta` / `thinking_delta` / `input_json_delta`; `sdk.d.ts:5966-5995`).
  - Complete blocks arrive as `assistant` messages, one per content block, sharing `message.id` (`3852-3941`).
  - Thinking summaries need `thinking: { type: 'adaptive', display: 'summarized' }` (`ThinkingAdaptive`, `10511-10517`). T3 also sets `settings.showThinkingSummaries: true` (`ClaudeAdapterV2.ts:2016-2021`, `2102-2112`).
  - `system/thinking_tokens` gives estimates (`6751-6762`).
- Tool calls: `tool_use` blocks (name, input; streamed input via `input_json_delta`). Results come as `user` messages with `tool_result` blocks, plus `tool_use_result`, the tool's **structured output object** (`6877-6880`). Examples: `FileEditOutput.structuredPatch` for diffs (T3 builds unified diffs from it, `ClaudeAdapterV2.ts:3630-3660`), `BashOutput`, `AgentOutput`. Typed in `sdk-tools.d.ts`, which has 80+ `*Input`/`*Output` types.
  - `tool_progress` heartbeats (`6764-6783`); `tool_use_summary` (`6785-6795`); `permission_denied` (`6004-6031`).
- File edits: `Edit`/`Write`/`NotebookEdit` tool_use and their structured outputs. Optional `enableFileCheckpointing` with `rewindFiles(userMessageId, {dryRun})` (`1817-1824`, `3331-3333`; checkpoint snapshots are not copied on fork).
- Todos and plans:
  - SDK/headless sessions use **Task tools** (`TaskCreate/TaskUpdate/TaskList/TaskGet`) since 0.3.142 (breaking). `TodoWrite` may still appear; T3 handles both (`ClaudeAdapterV2.ts:5144-5187`, `10857`).
  - Plan mode ends with the `ExitPlanMode` tool (`ExitPlanModeInput` has the plan markdown). T3 captures the plan in `canUseTool` and denies the tool with a message (`11619-11637`).
- Subagents / Task:
  - The `Agent` tool (named `Task` in older versions). Messages carry `parent_tool_use_id`, `agent_id`, `subagent_type` and `task_description` (`6955-6967`).
  - By default only tool_use/tool_result from subagents are forwarded. `forwardSubagentText: true` forwards their text and thinking for nested transcripts (`1994-2000`).
  - Task lifecycle: `system/task_started`, `task_progress` (with optional AI summary via `agentProgressSummaries`), `task_updated`, `task_notification`, `background_tasks_changed` (replace-semantics roster) (`6610-6750`, `3956-3988`).
  - Controls: `stopTask(taskId)`, `backgroundTasks(toolUseId?)` (`3431-3446`); `perTaskStopAffordance` changes what interrupt does to background tasks (`1919-1938`). History via `getSubagentMessages` / `listSubagents`.
- Compaction: `system/compact_boundary` {trigger manual|auto, pre_tokens, post_tokens, duration_ms, preserved segment} (`4002-4040`); `system/status` {status:'compacting', compact_result, compact_error} (`6492-6508`); hooks `PreCompact` / `PostCompact`.

### Steer vs queue — Yes, natively, via `priority` on a streamed user message (docs/typescript, SDKUserMessage)
- `'next'` or no priority: "Claude reads the message in the same turn, as soon as the tool calls it is running finish. If the turn ends first, the message starts the next turn." This is **steer**.
- `'later'`: "Claude Code holds the message until the turn ends and sends it as a new turn." This is **queue**.
- `'now'` with `origin: { kind: "human" }` (≥2.1.286): "work that can continue in the background moves there, and Claude reads the message in the same turn"; otherwise it interrupts. `'now'` without origin: interrupts the turn and Claude reads the message next.
- Acknowledgement: the uuid appears in later frames' and the result's `user_message_uuids`. Several sends can merge into one Turn. `queued_turn_count` on the result counts human-origin sends still queued (`6162-6385`).
- Hub's rule "never start a Turn from steer words": with `'next'`, a steer that loses the race with the turn's end starts a new turn. T3 guards the race and fails the steer (`ClaudeAdapterV2.ts:12966-12975`). There is a `cancel_async_message` control request in the protocol types, but no public `Query` method for it (not confirmed usable).
- T3 sends `priority: "now"` **without** `origin`, so its steers interrupt. It backgrounds foreground subagents first so they survive (`12826-12847`, `12925-12975`). The Hub can do better by stamping `origin: {kind:'human'}`.

### Interrupt — Yes
- `interrupt()` → `SDKControlInterruptResponse { still_queued, cancelled? }` on CLIs advertising `interrupt_receipt_v1` (`sdk.d.ts:3030-3037`). With `interrupt_cancel_queued_v1` it can also cancel queued sends.
- The Turn ends with a `result`: `error_during_execution`, `terminal_reason` (for example `aborted_streaming` / `aborted_tools`, T3 `4310-4314`), and `aborted: true` on a truncated assistant message (`3930-3932`).
- T3 interrupts, then closes the process and waits up to 10 s for confirmation (`ClaudeAdapterV2.ts:12738-12824`).

### Permissions — Yes
- **`permissionMode`**: `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'` (`2654`). Change it live with `setPermissionMode` (`3044`). The CLI's `--permission-mode` choices also list `manual`, a display name for `default` (the CLI calls it "Manual mode").
- **`canUseTool(toolName, input, {signal, suggestions, blockedPath, mcpServer, decisionReason, title, displayName, description, defaultToNo, suppressAlwaysAllowRule, toolUseID, agentID, requestId, matchedAskRule})`** returns `PermissionResult` `allow{updatedInput, updatedPermissions}` or `deny{message, interrupt}` (`241-336`, `2679-2691`). It is called only when nothing earlier decided the call.
- **Evaluation order** (agent-sdk/permissions): (1) hooks → (2) deny rules → (3) ask rules → (4) permission mode → (5) allow rules → (6) `canUseTool`.
  - Ask rules, `AskUserQuestion`, MCP tools marked `requiresUserInteraction`, org-"ask" connectors and `Dangerous rm` reach the callback **even in bypassPermissions**.
  - `dontAsk` turns every prompt into a denial.
  - `permissionPrompts: 'none'` denies anything that would prompt (`2143-2151`, ≥2.1.259).
- **Hooks as SDK callbacks**: `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>` (`1849-1861`). There are 33 events (`HOOK_EVENTS`, `1029`). `PreToolUse` can allow, deny, ask or defer and can rewrite input (`2920`). It runs for every call, including auto-approved ones, so it is where a host enforces its own policy regardless of mode. A hook `allow` does not skip deny or ask rules.
- **Five Hub levels** — proposed mapping (`plan / ask / auto_edit / auto / full`; current ACP flavor already maps them to the same native modes, `src/adapters/flavors/claude.ts:7`):

| Hub level | Options | `canUseTool` behaviour |
|---|---|---|
| plan | `permissionMode:'plan'`; add flag setting `useAutoModeDuringPlan:false` if "plan" must not run classified shell commands (docs: plan sends shell/web calls to the auto classifier when available) | `ExitPlanMode` → emit `plan_proposal`; deny with a "captured" message unless the user approves leaving plan mode (T3 `11619-11637`). File-tool edits during planning always reach the callback, so deny them |
| ask | `permissionMode:'default'` | Every prompt → Hub approval UI |
| auto_edit | `'acceptEdits'` | Edits inside working dirs auto-approved. Other prompts → Hub (T3 installs the callback for this mode, `3149-3155`) |
| auto | `'auto'` (classifier; needs `ModelInfo.supportsAutoMode`; switching to an unsupported model drops the session to `default` with a `status` message, ≥2.1.299) | Undecidable calls → Hub |
| full | `'bypassPermissions'` + `allowDangerouslySkipPermissions:true` (needed to switch into bypass later too) | Only ask rules, interaction tools and dangerous `rm` arrive. "Default allow" means the Hub answers them automatically, except AskUserQuestion. Respect `permissions.disableBypassPermissionsMode` / `disableAutoMode` (T3 downgrades bypass → auto → default, `3130-3140`, `3176-3265`) |

- **Never let "always allow" write the user's files.** `suggestions` / `updatedPermissions` carry `destination: 'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg'` (`2727`). Returning them unchanged writes rules into the user's settings. The Hub must rewrite them to `'session'` or drop them (AGENTS.md: 不改用户真实的 Harness 配置).

### Switch model, effort/thinking, fast mode mid-session — Yes, with one caveat
- Model: `setModel(model?)` (`3073`). `ModelInfo` lists `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode` and `supportsAutoMode` (`1512-1552`). Get them from `initializationResult().models` or `supportedModels()`.
- Effort and fast mode: `applyFlagSettings({ effortLevel, fastMode, ultracode })`, session flag layer only (`3101-3136`; `'max'` is session-only). This is what T3 does live (`ClaudeAdapterV2.ts:12012-12033`, `1882-1890`).
- Caveat: changing the thinking on/off setting, or clearing effort, needs a **new process** (T3 `1871-1880`). `setMaxThinkingTokens` is deprecated.
- Reported state: `system/init` is re-emitted with `model`, `permissionMode`, `effort` and `fast_mode_state` ("newest frame wins", `6510-6608`). Results also carry `fast_mode_state`.

### Fork — Yes
- `forkSession(sessionId, { dir, upToMessageId, title })` → `{ sessionId }`. It copies the transcript with **new uuids** and no file-history snapshots (`sdk.d.ts:889-935`). Alternatively open with `resume + forkSession: true` (+ `sessionId` to pick the new id) (`1836-1840`, `2228-2232`).
- Pitfalls handled by T3:
  - Read the fork's head uuid with `getSessionMessages` before its first run appends (`ClaudeAdapterV2.ts:1791-1806`).
  - Run the in-process helpers in a child process when the session's `CLAUDE_CONFIG_DIR` differs from the Hub's own env (`1765-1779`, `apps/server/src/claudeHistoryWorker.ts`).

### Rollback / resume at a message — Yes
- `resume` + `resumeSessionAt: <uuid>` keeps messages up to and including that uuid (`2234-2240`). `resumeDropsTurn: <prompt uuid>` makes the CLI refuse the truncation if something else (a queued message or task notification) would be discarded; map that refusal to a plain resume (`2241-2291`). This works on the headless/SDK lane only.
- T3 records the SDK assistant message cursor per Turn and uses it for rollback and for every reopen (`ClaudeAdapterV2.ts:12054`, `13555-13610`). The Hub's record can stay authoritative and the native transcript is cut back to it. T3 does not use `resumeDropsTurn`; the Hub should.

### Compact — Yes
- Send `/compact [instructions]` as a user message (T3 `compactThread`, `ClaudeAdapterV2.ts:13262-13265`). Auto-compaction is governed by the `autoCompactWindow` setting or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (T3 `2036-2075`). Events as above.

### Usage, cost, rate limits — Yes
- `result.usage` is **main loop only, per Turn**. `result.modelUsage` gives per-model input/output/cache/thinking, `costUSD`, `contextWindow` and `maxOutputTokens`, **cumulative for the process**. `total_cost_usd` is cumulative and an estimate (`6162-6385`, `ModelUsage` `1554-1587`).
- T3 keeps a per-process ledger and takes deltas to count subagent and compaction work, and adds steered segments' usage (`apps/server/src/provider/ClaudeTurnTokenUsage.ts:24-125`, `134-241`).
- `getContextUsage({detail:'summary'|'full'})` gives a context-window breakdown (`3220-3222`).
- `rate_limit_event` carries `{status, resetsAt, rateLimitType five_hour|seven_day|…, utilization, overage…}` (`6121-6160`). T3 turns it into usage limits and a notice (`ClaudeAdapterV2.ts:9890-9975`).
- `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors})` returns plan windows. It is unstable (`3224-3242`). T3 uses it in its probe with `skipBehaviors:true`, because the transcript scan can take too long.
- `system/api_retry` (attempt, delay, error category).

### Read or list native sessions on disk — Yes
- `listSessions({ dir, limit, offset, includeWorktrees, includeProgrammatic })` → `SDKSessionInfo {sessionId, summary, lastModified, customTitle, firstPrompt, gitBranch, cwd, tag, createdAt, archived}` (`1187-1230`, `6387-6435`).
- `getSessionInfo`, `getSessionMessages(id, {dir, limit, offset, includeSystemMessages})` (`942-1007`), `getSubagentMessages`, `listSubagents`, and `rename/tag/archive/unarchive/deleteSession`.
- These run **in the Hub process** and read `CLAUDE_CONFIG_DIR` from its env. Today the Hub's ACP driver reads the JSONL files itself for `/export` (`src/adapters/control/claude.ts:200-221`).

### Titles — Yes
- `Options.title` sets the title of a new session. It also skips Claude's own naming request; T3: "a supplied title skips Claude's redundant naming request" (`ClaudeAdapterV2.ts:2079-2080`; `sdk.d.ts:2584-2592`).
- `renameSession(id, title)` appends a custom-title entry (`3463-3469`).
- The ACP path has **no** title today (`src/adapters/control/claude.ts:21-23`, `33`).

### MCP servers per session, including in-process Hub tools — Yes
- `mcpServers: Record<name, stdio|sse|http|sdk>` (`2075-2088`, `1274-1474`). The SDK puts process servers on **argv** as `--mcp-config <json>`. T3 therefore sends credentialed servers later with `setMcpServers()` over stdin (`ClaudeAdapterV2.ts:1341-1342`, `1457-1504`).
- `createSdkMcpServer({name, tools:[tool(name, desc, zodShape, handler)]})` runs tools **inside the Hub process** through `mcp_message` control frames (`664`, `10537`). No HTTP endpoint or token is needed, and nothing is written to the user's MCP config. Today the Hub installs its `harnesshub` tools into the user-level Claude config (docs/decisions/LOG.md, the 上下文桌 entry).
- MCP tools may be deferred behind ToolSearch. T3 says so in the system prompt and sets `ENABLE_TOOL_SEARCH` (`1919-1955`). `alwaysLoad` exists per server.
- Also: `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer`, `setMcpPermissionModeOverride`, `readMcpResource`.
- Pitfalls: `strictMcpConfig` drops the user's servers, so don't set it for normal sessions. `managed-mcp.json` forbids `--strict-mcp-config` (T3 `ClaudeHome.ts:90-101`).

### Slash commands, skills, plugins — Yes
- `initializationResult()` gives `commands`, `agents`, `models`, `account`, `output_style`, `fast_mode_state` and `claude_code_version` (`4930-5011`). `system/init` gives `slash_commands`, `skills`, `plugins`, `plugin_errors`, `terminal_slash_commands` and `capabilities`. Also `supportedCommands()` returns `{name, description, argumentHint, aliases, builtin}` (`10136-10164`), `commands_changed`, `reloadPlugins`, `reloadSkills`, and options `skills: 'all'|string[]` (`2423-2445`) and `plugins: [{type:'local', path}]` (`2152-2166`).
- In SDK and `-p` sessions, user skills and custom commands work as `/name args`. Terminal-only commands such as `/login` are not available. `/model`, `/effort`, `/fast` and `/rename` take arguments (docs/headless note).
- `/clear` resets in-process (`conversation_reset` with a new conversation id, `5586-5604`). The Hub owns clear, so it should open a new native session instead.
- T3 pitfalls:
  - It discovers skills from disk itself (user, project and plugin roots, settings overrides, YAML 1.1 booleans) because the command list has no paths (`apps/server/src/provider/Drivers/ClaudeSkills.ts`).
  - Claude expands only **one** skill per message, and only when `/name` **starts the last text block**. Images must come before that block (`Drivers/ClaudeSkillDispatch.ts:1-60`; `ClaudeAdapterV2.ts:2967-2972`).

### Hooks — Yes
- The user's settings hooks run as usual when `settingSources` includes them (default: all). SDK-side hook callbacks are added per session. `includeHookEvents` streams `hook_started/progress/response` (`1979-1988`). SessionStart/Setup hook events are always emitted.
- T3's capability probe uses `settings: { disableAllHooks: true }` so health checks don't fire SessionStart (`ClaudeProvider.ts:242-243`).

### Settings sources: read the user's config, never change it — Yes
- `settingSources` is omitted (all of user, project and local are loaded, CLAUDE.md included) or an explicit list (`2412-2422`). Auto-memory loads regardless (agent-sdk/hosting, "Multi-tenant isolation").
- Hub overlays go into the **flag layer**: `settings` at open, `applyFlagSettings` mid-session. Both are session-only and never written to files.
- Do **not** call `updateSettings()`; it writes settings files (`3137-3149`). Never return `updatedPermissions` with file destinations (above).
- `resolveSettings()` reads effective settings with provenance (`3475-3592`). T3 also uses a hidden `getSettings` control request missing from the types (`ClaudeProvider.ts:284-291`); avoid it.
- Caveat: Claude Code itself still does its own bookkeeping in `~/.claude.json` (projects, counters); the SDK warns about lost `global_config` writes in `session_writes_lost`, `6448-6468`. That is the CLI's behaviour, exactly as on today's ACP path, not a Hub change.

### Env and cwd per session — Yes
- `cwd`, `additionalDirectories`, `projectConfigRoot`, `env` (`1657-1793`).
  - `projectConfigRoot` is the checkout that `cwd` is a worktree of; project settings, `.mcp.json`, `.claude/` trees and `CLAUDE_PROJECT_DIR` come from it. This matches the Hub's per-conversation worktrees.
  - `env` **replaces** the whole environment, so spread `process.env` yourself.
- Pitfalls from T3 `Drivers/ClaudeHome.ts`:
  - Use `CLAUDE_CONFIG_DIR`, never `HOME`, for another config dir, or the macOS Keychain login is lost (`43`).
  - Strip host-session variables when the Hub itself runs under Claude Code: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`, `CLAUDE_EFFORT`, `CLAUDE_PID`, `CLAUDE_AGENT_SDK_VERSION`, … (`48-63`, `78`).
  - Honour a `CLAUDE_CODE_ENTRYPOINT` set in the user's settings env (`83-87`).
- `CLAUDE_AGENT_SDK_CLIENT_APP` names the app in the User-Agent (`1783-1789`). `spawnClaudeCodeProcess` lets the Hub spawn the process itself (process group, kill tree, stderr tail) (`2595-2614`, `10250-10340`). T3 does exactly this (`ClaudeAdapterV2.ts:1386-1444`).

---

## 4. All SDK message types and their mapping to Turn / item / event

`SDKMessage` (`sdk.d.ts:5805-5808`) has 40 members, plus `SDKActiveGoalMessage` and the control frames in `StdoutMessage`. The Hub columns use our `ControlEvent` (`src/contracts/control.ts:131-160`) and protocol item types (`src/contracts/protocol.ts`: user_message, assistant_message, reasoning, tool, command, file_read, file_change, search, web, mcp_tool, plan, plan_proposal, question, approval, subagent, delegation, context_event, notice, error, interrupt, switch, recap, artifact).

| SDK message (type / subtype) | Meaning | Hub mapping |
|---|---|---|
| `system/init` | Session metadata: model, permissionMode, tools, mcp_servers, slash_commands, skills, plugins, plugin_errors, effort, fast_mode_state, capabilities, claude_code_version; re-emitted per Turn | `ProtocolObservation`, `nativeConfig()`, `extensions()`; set the checkpoint from `session_id` |
| `assistant` | Complete content block(s): text / thinking / tool_use; `error`, `aborted`, `supersedes`, `parent_tool_use_id`, `user_message_uuid(s)` | `assistant_message` / `reasoning` / start of `tool`-family items; `supersedes` → remove retracted items; `error` → `error`/notice; subagent frames → nested under `subagent` |
| `stream_event` | Raw stream deltas (text, thinking, tool input JSON), `ttft_ms` | `text` / `thinking` deltas; tool input streaming |
| `user` (not replay) | tool_result blocks + `tool_use_result` structured output; subagent prompts | Finish the `tool` item. Classify by tool: Bash→`command`, Read→`file_read`, Edit/Write/NotebookEdit→`file_change` (diff from `structuredPatch`), Grep/Glob→`search`, WebFetch/WebSearch→`web`, `mcp__*`→`mcp_tool`, Agent→`subagent`, TaskCreate/TaskUpdate/TodoWrite→`plan`, AskUserQuestion→`question`, ExitPlanMode→`plan_proposal` |
| `user` replay (`isReplay`) | Echo of sent user messages (`--replay-user-messages`) | `input_recorded` evidence (ADR-055 E1): the prompt reached the transcript |
| `result` success / error_during_execution / error_max_turns / error_max_budget_usd / error_max_structured_output_retries | **Turn-complete signal**, exactly one per Turn; usage, modelUsage, cost, permission_denials, terminal_reason, queued_turn_count, user_message_uuids, fast_mode_state | `BackendResult` + `usage` event. Attribute by `user_message_uuids`; a result for another uuid belongs to a wake turn |
| `system/status` | `compacting`/`requesting`/null; permissionMode changes; compact_result | Activity indicator; `nativeConfig` permission mode; compaction `context_event` |
| `system/compact_boundary` | Compaction happened (manual/auto, tokens) | `context_event` (kind compaction) |
| `system/api_retry` | Retrying with delay and error category | Activity `retry` / notice |
| `system/task_started` / `task_progress` / `task_updated` / `task_notification` | Subagent, shell, monitor, workflow and MCP tasks; nesting, background flag, usage, summary; `skip_transcript`, `ambient` | `subagent` item (or background-task activity); hide `skip_transcript` and `ambient` |
| `system/background_tasks_changed` | Full roster of live background tasks (replace) | Keep the process alive while non-empty; "background work pending" |
| `tool_progress` | Heartbeat per running tool (elapsed, subagent retry) | Update the `tool` item's running time |
| `tool_use_summary` | Summary of preceding tool calls | Optional `recap`-style row |
| `system/permission_denied` | A call was denied (by mode, rule or classifier) and why | `notice` beside the tool item; with "default allow" it should be rare |
| `system/thinking_tokens` | Estimated thinking tokens | Optional progress |
| `rate_limit_event` | claude.ai plan window status | Usage limits + `notice` when rejected |
| `system/model_refusal_fallback` / `model_refusal_no_fallback` | Refusal; model swapped (session or local) and retracted uuids | `switch`/notice; remove retracted items. "Never change the model silently" means we must show it |
| `system/notification`, `system/informational` | CLI notices (level info/notice/suggestion/warning; `prevent_continuation`) | `notice` |
| `system/local_command_output` | Output of a local slash command | `assistant_message` (command output) |
| `system/hook_started` / `hook_progress` / `hook_response` | Hook lifecycle (opt-in) | Diagnostics, or a quiet `notice` |
| `system/plugin_install` | Plugin install progress (opt-in) | Diagnostic |
| `auth_status` | Authentication in progress, output, error | Readiness / NATIVE_AUTH_REQUIRED |
| `system/commands_changed` | New command list | Refresh catalog commands |
| `system/session_state_changed` | idle / running / requires_action | Session status |
| `system/memory_recall` | Memories surfaced (paths, scope) | Optional `context_event` |
| `system/files_persisted` | Files uploaded (cloud) | Ignore locally |
| `system/elicitation_complete` | MCP elicitation finished | Close the `question` |
| `system/session_writes_lost` | Disk full: transcript or global config writes lost | `error` notice (data-loss floor) |
| `system/mirror_error` | SessionStore mirror failed | n/a (no store) |
| `system/control_request_progress` | Progress of a long control request | Ignore / diagnostic |
| `system/worker_shutting_down` | Remote worker teardown | n/a locally |
| `conversation_reset` | `/clear` (or plan-exit-clear) started a new conversation in-process | The Hub owns clear: never send `/clear`. If seen, record the native id change |
| `prompt_suggestion` | Predicted next prompt (after result) | Off (`promptSuggestions` defaults to false) |
| `active_goal` | `/goal` state | Optional |
| Control frames: `can_use_tool`, `hook_callback`, `mcp_message`, `elicitation`, `request_user_dialog` | Handled by SDK callbacks | `permission_requested` / `question`; answers via `decidePermission` |

Turn model: a Hub Turn = one `SDKUserMessage` with a Hub-chosen `uuid`, plus every frame whose `user_message_uuid(s)` contains it (or that follows it before its `result`), up to the `result` naming it. Steers add their uuids to the same Turn. Frames between results with other uuids, or none, are Harness-initiated wake turns (counted by `unattributedUpdates` today).

---

## 5. How T3 Code does it, file by file

Unified contract, `packages/provider-core/src/server/ProviderAdapter.ts`:
- Runtime policy `{runtimeMode, interactionMode, cwd, approvalPolicy, sandboxPolicy, maxRuntimeMode}` (`46-58`).
- Typed events: `provider_thread/turn.updated`, `turn_item.updated`, `steer.updated` pending/completed/cancelled, `background_work.updated`, `command_output.delta`, … (`82-204`).
- Session runtime methods (`661-782`): `ensureThread`, `resumeThread`, `injectHistory`, `startTurn`, `compactThread`, `steerTurn`, `applyModelSelection`, `stopTask`, `awaitBackgroundTasks`, `interruptTurn`, `stopSubagent`, `unloadThread`, `respondToRuntimeRequest`, `readThreadSnapshot`, `mcpApps`, `rollbackThread`, `forkThread`.
- Typed errors include `SteerDeclined`, `InterruptTimeout` and `ThreadInUse`.

`apps/server/src/provider/Drivers/ClaudeDriver.ts` builds the instance:
- the process env (`114`) and the orchestration adapter (`149-173`);
- a capabilities probe cached on binary + config dir + cwd (`180-236`);
- the server's `stateDir` as probe cwd, because `claude` wrappers refuse `$HOME` (`104-106`);
- reset-credit redemption (`309-371`). This reads the account config; the Hub should not copy it.

`Drivers/ClaudeExecutable.ts`, the shim pitfall:
- On Windows the SDK skips shell/PATHEXT lookup, and Node ≥20.12 cannot spawn `.cmd/.bat/.ps1` launchers.
- So T3 resolves the npm shim to `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (new packages) or `cli.js` (old ones) (`10-69`).
- On macOS, which is all the Hub supports, there is no shim problem: npm global `bin/claude` is a symlink to the Mach-O `claude.exe`.
- macOS pitfalls are different: the path depends on the nvm Node version (`~/.nvm/versions/node/v26.13.0/...`), and native installs live under `~/.local/bin`. The Hub's existing `bindNativeDependencies` resolves PATH and `~/.local/bin` with realpath (`src/adapters/control/native-dependencies.ts:8-24`); reuse it.

`Drivers/ClaudeHome.ts`:
- `CLAUDE_CONFIG_DIR` instead of `HOME`, to keep Keychain login (`33-46`);
- strips host-session variables and sets entrypoint `t3-code` (`48-88`);
- the managed-mcp vs `--strict-mcp-config` conflict (`90-101`);
- the signed-out message tells the user to run `claude auth login` themselves (`125-134`).

`ClaudeProvider.ts`, health and catalog probe:
- `query()` with a **never-yielding prompt**, so initialize runs and no API request is sent (`442-486`);
- probe options `persistSession:false`, `settings:{disableAllHooks:true}`, `allowedTools:[]`, `mcpServers:{}` + `strictMcpConfig`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, no IDE auto-connect (`230-260`);
- reads account, commands and models from `initializationResult()`, usage windows with `skipBehaviors:true`, effort caps via hidden `getSettings` (`491-550`);
- auth is decided from `tokenSource`/`apiKeySource`/`apiProvider` (`201-217`);
- `claude --version` gives the version (`652-726`).

`ClaudeModelCatalog.ts` + `model-manifest.json`:
- a curated manifest with per-model min/max Claude Code versions (`262-324`), merged with models the CLI reports and deduplicated by slug/alias/`resolvedModel`, ignoring `default` (`176-222`);
- dated ids normalized (`243-253`);
- effort caps from settings `maxEffortLevel`/`modelSettings` (`326-480`);
- the `[1m]` context suffix handled (`339`).

`ClaudeTurnTokenUsage.ts`:
- `result.usage` is main-loop and per-segment, so steered segments are summed;
- `modelUsage` is process-cumulative, so deltas are taken;
- "other usage" (subagents, compaction) is ledger minus main; usage is marked complete, partial or unavailable (`24-241`).

`Drivers/ClaudeSkills.ts` / `ClaudeSkillDispatch.ts`: disk discovery of skills (user, project, plugin, synced plugins, settings overrides) and the one-skill-per-message dispatch rule.

`orchestration-v2/Adapters/ClaudeAdapterV2.ts` (13,784 lines), key mechanics:
- **Runner** (`1330-1743`):
  - prompt queue → `Stream.toAsyncIterable` as the streaming prompt;
  - credentialed MCP via `setMcpServers` after `initializationResult()` (boot timeout 5 min, MCP 90 s);
  - wraps the binary in a scope unit and spawns it in a process group with descendant tracking;
  - stderr tail kept only before the first answer (private text);
  - SIGKILL and await exit on a failed open; one retry for resume when MCP registration timed out.
- **Hidden control requests** `mcp_call` and `list_permission_rules`, reached by reflecting on the private `Query.request` (`841-855`). Fragile; avoid.
- **Options builder** (`1968-2154`):
  - preset tools, permission mode, partial messages, effort, `sessionId`/`resume`, `resumeSessionAt`, `canUseTool`;
  - thinking summaries; `systemPrompt: {type:'preset', preset:'claude_code', append: T3 instructions}`;
  - SubagentStart hook adds instructions; `additionalDirectories` incl. attachments;
  - alias pinning env `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` when a custom model has an alias's name (`2047-2054`).
- **Policy** (`3063-3272`): runtime mode → permissionMode, bypass/auto availability downgrade, when to install `canUseTool`.
- **Prompt echo gating and wake turns** (`11343-11491`, `4310-4333`).
- **canUseTool** (`11493-11756`):
  - no active turn → deny;
  - AskUserQuestion → UI → `allow{updatedInput:{questions, answers}}`;
  - ExitPlanMode → capture plan, deny with message;
  - dangerous-rm under bypass → deny with guidance;
  - otherwise the approval UI, answered through the AbortSignal-aware deferred.
- **Live selection** (`12012-12033`). **Open/reuse** (`12035-12200`): reuse the live process when the policy key matches, restore from a stuck plan mode, refuse replacement while background work runs, resume with `resumeSessionAt` = native head.
- **Interrupt** = interrupt + close + 10 s confirm (`12738-12824`). **Steer** = background foreground subagents, then `priority:"now"` (`12826-12975`). **Compact** = `/compact` (`13262-13265`). **Snapshot**: not implemented (`13547-13554`). **Rollback**: `resumeSessionAt` from the recorded cursor (`13555-13610`).

---

## 6. Current ACP path: what it gets and what it misses

How it runs today:
- The recipe `claude` uses `acp-v1` with adapter binary `claude-agent-acp` (`src/adapters/recipes.ts:7`). The registry pins `@agentclientprotocol/claude-agent-acp@0.88.0` (`acp-registry.json:186-216`), but 0.99.1 is installed under Homebrew's npm. It embeds SDK **0.3.312** and its own darwin-arm64 Claude Code **2.1.312** binary (334 MB on disk).
- The Hub binds the user's CLI via `CLAUDE_CODE_EXECUTABLE` (`native-dependencies.ts:8-24`; the adapter honours it, `acp-agent.js:675-678`, `9089`). So the bundled binary is unused, but it is a second Node process between the Hub and `claude`.
- The Hub's ACP driver uses: `session/new|load|resume|fork|list|close|prompt|cancel|set_mode|set_model|set_config_option`, `_session/steering`, `session/request_permission`, `session/update` (message/thought chunks, tool_call/update, plan, usage_update, available_commands/current_mode/config_option/session_info updates) and `_auth/status_update` (counted in `src/adapters/control/acp.ts`).

What the ACP path gets (`src/adapters/flavors/claude.ts:5-21`, `claude.ts`):
- text and thinking chunks, tool calls with ACP kinds, diffs as content, plan entries;
- the five levels through native modes; effort through the `thought_level` option; fast through the `fast` config option (which itself calls `applyFlagSettings`);
- per-session MCP and a system-prompt append through `_meta`;
- resume, fork (ACP `session/fork`), session list, attachments, per-Turn usage, questions, and steer through `_session/steering` (`idleBehavior:"promptRequired"`).

What it misses or has to work around:
- **No title.** Rename works only for JetBrains AIR clients (`claude.ts:21-23`).
- **No export.** The Hub reads JSONL itself (`claude.ts:200-221`).
- **Prompt suggestions on** since 0.92; the Hub must switch them off per session (`claude.ts:44-45`, `89-91`).
- **`/remote-control`** must be refused (`claude.ts:46-49`).
- **Error classification by message text** (`SESSION_ENDED` string, `errorKind` sets; `claude.ts:50-68`, `148-162`).
- **One process per connection, closed per Turn.** Background tasks die and every Turn pays start-up.
- **Not reachable or lossy through ACP** (the adapter consumes much of this internally, but the Hub driver does not get it):
  - rollback at a message (`resumeSessionAt`) and fork at a message;
  - priority `later`/`now` + origin; interrupt receipts;
  - `client_composed` for relay packets;
  - structured `tool_use_result` (exact diffs, Bash exit codes, Agent reports);
  - subagent/task lifecycle (`task_*`, `background_tasks_changed`, `stopTask`, `backgroundTasks`);
  - `rate_limit_event`; per-model `modelUsage` and cost; `getContextUsage`;
  - compaction boundaries with token counts (only "compaction events" through the adapter's mapping);
  - rich `canUseTool` fields (`title`, `decisionReason`, `blockedPath`, `matchedAskRule`, `suggestions`);
  - hook callbacks; in-process MCP; `reloadPlugins/Skills`; `mcpServerStatus`; `accountInfo`; `supportedAgents`; `listSessions`/`getSessionMessages` paging.
- **Version lag and drift.** The adapter's SDK (0.3.312) trails the CLI (2.1.316), the registry pin (0.88.0) differs from the installed version (0.99.1), and the adapter's own behaviour changes between releases (prompt suggestions, remote-control, AIR-only rename).

If we switch:
- **We gain:** everything in §3 directly, one fewer process and translation layer, our own error typing from structured fields (`SDKAssistantMessageError`, `terminal_reason`, `startup_failure_reason`), and no dependency on the ACP registry for Claude.
- **We lose:**
  - the shared ACP driver code path: the Claude driver becomes bespoke, like Codex's app-server driver;
  - the adapter's ready-made mapping (tool kinds, plan entries, permission option lists), which we would write ourselves;
  - the adapter's Zed/JetBrains-tested quirks handling.
- **The trade:** we take on SDK churn directly instead of through the adapter. The policy and licence posture does not change, because the adapter is also an SDK product.

---

## 7. Risks

1. **SDK churn.**
   - 346 versions since 2025-09; 23 in the last 30 days; 79 in 90.
   - `sdk.d.ts` 0.3.316→0.3.325 differs by 801 lines: mostly additive (new `archiveSession`, `unarchiveSession`, `matchDeniedModels`, `SDKSessionWritesLostMessage`), but 0.3.317 removed a `FileReadOutput` variant.
   - Breaking releases exist (0.3.142: background MCP connect, Task tools replacing TodoWrite, v2 session API removed; 0.2.113: `env` replaces `process.env`) (CHANGELOG).
   - Experimental surfaces (`usage_EXPERIMENTAL…`, `@alpha` prewarm/SessionStore) may change without notice.
   - Mitigation: pin the exact version, keep all SDK types inside one adapter file (the boundary check already enforces adapters-only third-party imports, `tools/boundary-rules.json` B1–B3), feature-detect via `capabilities`, and bump in lockstep with the Hub-managed CLI upgrade.
2. **Version coupling to the user's CLI.** The SDK must not be newer than the CLI (§1). If the user's CLI is older than the pinned SDK, either refuse with a clear "update Claude Code" message (the Hub already manages upgrades) or keep a floor.
3. **Licence.**
   - The SDK's `LICENSE.md` reads "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements…". The docs: "Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers and end users" (agent-sdk/overview).
   - HarnessHub is MIT (`LICENSE`). Depending on the npm package is fine, but shipping it inside a Hub bundle (the cask) redistributes proprietary code under those terms, and our users become subject to them. The ACP adapter has the same issue (`"license": "proprietary"`), but today the user installs it separately.
   - Branding: the docs say SDK partner products must not call themselves "Claude Code". Saying in plain text that a product "runs Claude Code" is allowed (legal-and-compliance). Naming the Harness "Claude Code" in our list is an accurate statement of what runs; the product name must stay HarnessHub. **Needs the user's decision; not legal advice.**
4. **Bundled CLI.** The SDK ships a ~350 MB platform binary as an optional dependency. Exclude it at install, and always pass `pathToClaudeCodeExecutable`. Without the path and the package the SDK throws instead of silently switching; that satisfies "不隐式改换 Harness".
5. **Auth / policy** (legal-and-compliance, "Authentication and credential use"), quoted:
   - "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication…"
   - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users."
   - "developers may not collect, store, or intermediate Claude.ai credentials or session tokens"
   - and: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
   - The overview repeats: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
   - HarnessHub runs locally for one user, drives the user's own unmodified binary, and never sees tokens. That is closest to the permitted "end user signs in to the unmodified binary" case, but it is a grey zone, and "Anthropic reserves the right to take measures … without prior notice".
   - The risk is **the same for ACP, headless and SDK**: all three drive the same binary with the same login.
   - Rules for the driver:
     - never read Keychain, OAuth or `~/.claude.json` account data (T3 reads the org id for reset credits; we should not);
     - never offer a login UI that handles tokens; point the user to `claude auth login`;
     - show plan limits only as Claude reports them.
   - **Needs the user's decision; not legal advice.**
6. **Hidden APIs.** T3 relies on private `Query.request` and an untyped `getSettings`. Don't, or isolate them behind capability checks.
7. **Resources.** ~0.25–1 GiB per live process (docs). Keeping processes alive across Turns needs an idle release policy.
8. **Trust.** `-p`/SDK runs project hooks and `.mcp.json` with no workspace trust dialog (docs/headless). This is the same as ACP today. With "default allow" it is acceptable, but worth one line in the UI.
9. **Writes to the user's config by Claude itself.** CLI bookkeeping in `~/.claude.json`, permission suggestions (rewrite them to `session`), a model-driven `/config key=value` or plugin installs. The driver must never call `updateSettings`.

---

## 8. Recommendation for HarnessHub

**Switch the Claude Code driver from ACP to a direct Agent-SDK driver.** Reasons:
- It is the official, richest interface, and our current ACP path is already an SDK consumer one layer removed.
- It provides natively the things our unified protocol and recent features need: rollback for resend with checkpoints (`resumeSessionAt`), fork at a message, steer vs queue (`priority`), relay packets delivered verbatim (`client_composed`), titles, structured diffs, subagent/task trees, per-model usage and rate limits, in-process Hub tools with nothing written to user config, and permissions that never touch the user's files.
- T3 Code has proven the model in production. Its pitfalls are known and listed above.
- It removes the adapter's version drift and the AIR-only and prompt-suggestion quirks.

Shape:
- **Dependency:** `@anthropic-ai/claude-agent-sdk` pinned exactly at a version ≤ the oldest Claude Code we support, currently `0.3.316` to match the installed 2.1.316. Exclude the platform binaries (`pnpm.ignoredOptionalDependencies`). Types come from the SDK's peer packages as devDependencies (or `skipLibCheck`).
- **Process:**
  - one `query()` per Hub conversation, in streaming-input mode;
  - `pathToClaudeCodeExecutable` from the existing discovery (`bindNativeDependencies`); fail if absent;
  - `spawnClaudeCodeProcess` on our own process supervisor (process group, awaitable close, stderr tail);
  - keep the process while a Turn or background work is live and release it when idle;
  - the next Turn resumes with `resume` + `resumeSessionAt` = the last native uuid the Hub recorded (+ `resumeDropsTurn`);
  - new conversations use `sessionId` = a Hub-minted UUID.
- **Turns:**
  - each Turn is an `SDKUserMessage` with `uuid`; frames bound by `user_message_uuid(s)`;
  - relay or handoff text sent with `client_composed: true`;
  - steer with `priority:'next'` (or `'now'` + `origin:{kind:'human'}` for "interject"), queue with `'later'`;
  - stop with `interrupt()`, then close if it does not settle.
- **Levels:** the table in §3. `canUseTool` answers per "default allow" and rewrites every `updatedPermissions` to `session`. Use `setPermissionMode` live and always pass `allowDangerouslySkipPermissions: true`.
- **Selection:** `setModel` + `applyFlagSettings({effortLevel, fastMode})` live. A thinking on/off change reopens the process. Catalog from `initializationResult()`, read with T3's never-yielding-prompt probe.
- **Hub tools:** `createSdkMcpServer` in-process, so we can drop the user-level `harnesshub` MCP entry for Claude.
- **Sessions:** `listSessions`/`getSessionMessages` for `nativeSessions`/`importSession`, `forkSession` for fork, `title` / `renameSession` for titles.
- **Do not use:** `updateSettings`, the hidden control requests, `usage_EXPERIMENTAL` (optional, behind a try), `/clear` (the Hub opens a new session instead), and `continue`.

Slices (each one is a real-machine test):
1. Open, Turn and result with streamed text, thinking and tools, plus usage.
2. Levels, approvals, questions and plan proposals.
3. Steer, queue and interrupt.
4. Live model, effort and fast changes; the catalog probe.
5. Resume after idle release; rollback on resend; fork; native session list and import; titles.
6. Hub tools as an SDK MCP server.
7. Subagents, background tasks and wake turns.

Delete the ACP Claude driver after slice 1–3 smoke passes on the real machine.

**Decisions for the user (recommended answers in brackets):**
- (a) Accept a proprietary SDK dependency in the MIT repo and in the cask. [yes, installed as a dependency; note the terms in the README]
- (b) The subscription-login policy risk, which is unchanged from today. [proceed; never touch credentials]
- (c) Keep processes alive between Turns instead of closing them after each Turn. [yes, with an idle release]

---

## Not confirmed

- Real start-up time and memory of `claude` 2.1.316 sessions on this Mac. Not measured, because no session was launched.
- The `system/init.capabilities` list of 2.1.316, for example whether `interrupt_receipt_v1` and `interrupt_cancel_queued_v1` are present.
- Whether an initialize-only probe writes to `~/.claude.json`.
- That `priority:'now'` + `origin` behaves as documented on 2.1.316 (the docs give ≥2.1.286).
- The meaning of `sdkCompat.testedWrapperVersions` (inferred from the data, not documented).
- Whether claude-agent-acp exposes fork-at-message or rollback to ACP clients.
- Whether `claude mcp serve` still exists in 2.1.316.
- Whether a public way exists to cancel a queued steer (the `cancel_async_message` control subtype exists in the types, but there is no `Query` method).
- The legal reading in §7.3 and §7.5. It is the user's call; this is not legal advice.
