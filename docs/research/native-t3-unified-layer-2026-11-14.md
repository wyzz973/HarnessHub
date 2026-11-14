> 2026-11-14 原生接入调研（只读）。T3 Code 源码：github.com/pingdotgg/t3code @ d19467a5；文中 `/private/tmp/…/scratchpad/` 下的路径是调研时的临时目录。

# T3 Code's unified provider layer, and what HarnessHub should take from it

This study is read-only. It covers T3 Code at commit `d19467a5` ("fix(server): a thread visit stores only its read state").

- `$T3` means `/private/tmp/claude-501/-Users-sd3-Desktop-project-HarnessHub--claude-worktrees-relay-stage2-7cb3e9/2eae1136-e8e6-4dbb-9732-78309e4fdb4d/scratchpad/t3src/t3code`.
- `OV2` means `$T3/apps/server/src/orchestration-v2`.
- `HH` means the HarnessHub worktree `/Users/sd3/Desktop/project/HarnessHub/.claude/worktrees/relay-stage2-7cb3e9`.

Citations take the form `file:line`.

**Method.** I read the following myself, and spot-checked every subagent claim I lean on:
- the adapter contract, the contracts package, handoff, MCP sessions, runtime policy, the provider-switch policy and the context-handoff delivery;
- HarnessHub's current contracts.

Four read-only sub-reads covered the large areas:
- the ACP runtime
- the process lifecycle
- cross-cutting features
- event persistence

Nothing was run, and no file in either repository was changed.

**Scale, for calibration.** `OV2` alone is 105k lines across 317 files. The largest are:
- `Orchestrator.ts`: 15,954 lines
- `Adapters/ClaudeAdapterV2.ts`: 13,784 lines
- `ProjectionStore.ts`: 9,036 lines
- `Adapters/CodexAdapterV2.ts`: 8,649 lines

The shared ACP adapter (`$T3/packages/provider-acp/src/server/adapter.ts`) is about 9.7k lines. HarnessHub's whole driver layer is about 13k lines (`HH/src/contracts/*.ts`, `HH/src/adapters/control/*.ts`, `HH/web/src/lib/protocol/*.ts`).

---

## 0. The short version

1. **There are three layers, each with one job.** A *driver*, one per Harness kind, builds *instances*: configured copies, several per kind (`$T3/packages/provider-core/src/server/driver.ts:40-122`). Each instance has an `orchestrationAdapter: ProviderAdapterV2`. This is a small instance-level service with three methods: `getCapabilities`, `planSelectionTransition` and `openSession` (`ProviderAdapter.ts:766-782`). `openSession` returns a `ProviderAdapterV2SessionRuntime` with about 25 operations, of which 11 are mandatory (`ProviderAdapter.ts:661-764`).
2. **Adapters speak the app's own domain entities, not a neutral event language.** Every adapter event carries a *complete* contracts entity: an `AppThread`, `ProviderSession`, `ProviderThread`, `ProviderTurn`, `ExecutionNode`, `Subagent`, `ConversationMessage`, `TurnItem`, `RuntimeRequest` or `PlanArtifact` (`ProviderAdapter.ts:83-203`). The server stores each by id as last-writer-wins. Text deltas are coalesced into whole-text snapshots inside the adapter. Only `command_output.delta` and `prompt_suggestion.updated` are ephemeral.
3. **The server is event-sourced over SQLite.** A command goes through a decider that produces domain events and effects. One transaction writes the event log, the projection tables, the outbox and the command receipt. Only after the commit does anything publish. An effect worker then runs side effects such as `startTurn` from a per-thread FIFO lane. Clients subscribe with a snapshot plus a sequence cursor and resume with `afterSequence`.
4. **One app thread holds many provider threads, one per instance it ran on.** Switching Harness creates or reuses a provider thread on the target instance. It hands off only the turns that thread has not seen (`delta_since_target_last_seen`), or the full thread when that thread has no native identity yet (`Orchestrator.ts:2614-2640`). This is HarnessHub's relay, and T3 has it in production shape.
5. **Capabilities are a large declared matrix:** 11 groups and about 70 booleans (`orchestrationV2.ts:273-414`). Policy reads it to decide steer vs restart, native fork vs portable context, and native rollback vs checkpoint-only.
6. **What HarnessHub should not copy:**
   - T3 caps handoff history at 16k tokens / 64 KB (`handoffBudget.ts:14-19`).
   - It installs and manages its own Codex binary and auth in "managed" mode.
   - It auto-dispatches "Continue where you left off" after restarts and limit resets.
   - It steers by interrupt-and-restart when a provider lacks native steering.
   - When a provider does not support a runtime mode, it falls back to `approval-required` rather than enforcing the level itself (`RuntimePolicy.ts:91-100`).

   Each of these contradicts a HarnessHub rule.

---

## 1. The adapter contract

### 1.1 Layers and their lifetimes

| Layer | What it is | Lifetime | Source |
|---|---|---|---|
| `ProviderDriver<Config>` | `driverKind`, `metadata {displayName, supportsMultipleInstances?, hasDefaultInstance?}`, `configSchema`, `defaultConfig()`, `create(input) → ProviderInstance`, `usage?`. "create calls with different instanceId/config must share no mutable state"; "Failures become unavailable snapshots; never throw defects." | process | `driver.ts:25-30, 110-122` |
| `ProviderInstance` | `instanceId`, `driverKind`, `continuationIdentity`, `snapshot: ManagedServerProvider` (status, models, maintenance), `snapshotForCwd?`, `refreshModels?`, `afterUpdate?`, `consumeResetCredit?`, **`orchestrationAdapter: ProviderAdapterV2`**, `textGeneration`, `auth?`, `acpSessionManagement?` | one Effect scope per instance | `driver.ts:40-84` |
| `ProviderAdapterV2` (instance service) | `getCapabilities()`, `planSelectionTransition(input)`, `openSession(input)` (scoped) | instance | `ProviderAdapter.ts:766-782` |
| `ProviderAdapterV2SessionRuntime` | the per-session operations below, plus the `events` stream | session scope | `ProviderAdapter.ts:661-764` |

Each driver plugs in a `ProviderHost` that gives it:
- paths, including `attachmentsDir`, which "agents that sandbox file reads must be granted"
- settings
- a background-work gate
- attachment path resolution
- a T3-owned credential store

(`ProviderHost.ts:15-55`)

### 1.2 Every operation

`Effect<A, ProviderAdapterV2Error>` is written as `→ A` below. IDs are branded strings from the contracts package.

| Operation | Input | Output | Notes and typed errors |
|---|---|---|---|
| `getCapabilities()` | none | `OrchestrationV2ProviderCapabilities` | `ProviderAdapterCapabilitiesError` (`:206-216`) |
| `planSelectionTransition({current, target, sessionCapabilities})` | two `ModelSelection`s plus the session's *negotiated* capabilities | `{type: apply_on_next_turn \| restart_session \| create_with_handoff \| reject(reason)}` | `selectionTransition.ts:3-32`. Codex, Claude and OpenCode return `apply_on_next_turn`. ACP rejects a model change unless `supportsModelSwitchInSession` (`:19-32`). |
| `openSession(OpenSessionInput)` (needs `Scope`) | `threadId`, `providerSessionId`, `modelSelection`, `runtimePolicy`, `promptSuggestions?` (a live flag), `resumeFromSession?` (the old session's projection), `initialNativeThreadId?`, `initialProviderItemIdentityVersion?` | `SessionRuntime` | `:504-514`. Errors: `ProviderAdapterOpenSessionError {requiresSignIn?}` (`:218-230`). Closing the scope closes the session: `ProviderAdapterCloseSessionError` (`:232-243`). |
| `ensureThread(EnsureThreadInput)` | `threadId`, `title?`, `modelSelection`, `runtimePolicy`, `providerSessionId?`, `existingProviderThread?`, `forceNewNativeThread?` | `ProviderThread` | Binds or creates the native thread (`:516-524, 690-692`); `ProviderAdapterEnsureThreadError`. `forceNewNativeThread` is how "fresh context" and recovery replace a native thread. |
| `resumeThread({providerThread, threadId?, modelSelection?, runtimePolicy?})` | stored `ProviderThread` | `ProviderThread` | `:693-698`. `ProviderAdapterResumeThreadError` (`:245-257`). **`ProviderAdapterThreadInUseError`**: "the native thread is live in another process that owns its writes … callers must not fall back" (`:259-275`). |
| `injectHistory?({messages, context, providerThread})` | historical messages plus a coverage note | `boolean` | Native history injection. `false` means "the native protocol explicitly does not support history injection" (`:699-704`). Only Codex implements it, as `thread/inject_items`; an unknown-method error returns `false`, any other error stays ambiguous (`CodexAdapterV2.ts:7783-7806`). |
| `startTurn(TurnInput)` | see below | `void` (results arrive as events) | `:526-543, 705-707`. `ProviderAdapterTurnStartError`. `ProviderAdapterProtocolError {reason?: "previous_turn_active" \| "attachment_unreadable"}`, where only fixed reasons reach messages because "detail can contain private configuration" (`:450-470`). |
| `compactThread?(TurnInput)` | same as a turn | `void` | `ProviderCompactionUnsupportedError` (`:277-290, 708-710`). |
| `steerTurn(SteerInput)` | `threadId`, `runId`, `providerThread`, `providerTurnId`, `message`, `modelSelection?` (only when it differs) | `void` | `:545-553, 711-713`. Three distinct errors: `SteerRunUnsupported` (no capability), **`SteerDeclined`** (the provider refused, so the words are still unsent), and `SteerRunError` (unknown) (`:360-393`). |
| `applyModelSelection?({providerThread, modelSelection})` | | `void` | "Applies a thread's new selection to its running process where the provider can; otherwise it waits for the next turn" (`:714-718`). |
| `interruptTurn({providerThread, providerTurnId, requestRuntimeRestart?})` | | `void` | `:555-559, 732-734`. `ProviderAdapterInterruptError`. **`ProviderAdapterInterruptTimeoutError {timeoutMs}`**: "did not confirm a stop in time; its processes may still be running" (`:409-422`). The UI then offers Force stop. |
| `stopTask?`, `awaitBackgroundTasks?`, `stopSubagent?` | background task and native subagent ids | `void`, `{matched}`, or an outcome | `:719-740`. `stopSubagent` takes `requestedAt` so that "a delayed Stop must not interrupt a task resumed after this request". |
| `unloadThread?({providerThread, archive?})` | | `void` | `:741-745`. Frees a thread on a shared process. `archive` also hides it from the provider's own clients. |
| `respondToRuntimeRequest({requestId, decision?, feedback?, answers?})` | `ProviderApprovalDecision` = `accept \| acceptForSession \| acceptAlways \| decline \| cancel` (`providerPolicy.ts:58-65`) | `void` | `:561-566, 746-748`. `ProviderAdapterRuntimeRequestResponseError`. |
| `readThreadSnapshot({providerThread})` | | `ThreadSnapshot {providerThread, providerTurns, messages, reasoningMessageIds?, runtimeRequests, providerPayload?}` | `:568-580, 749-751`. Used only by the native-session importer, never by recovery (`apps/server/src/project/AgentSessionImporter.ts:570`, per the persistence sub-read). |
| `rollbackThread({providerThread, target, providerThreadTurns})` | `target = {type:"thread_start", checkpointId, appRunOrdinal:0}` or `{type:"provider_turn", checkpointId, appRunOrdinal, providerTurn, message?}` | `ThreadSnapshot` | `:582-600, 758-760`. `ProviderAdapterRollbackThreadError`. |
| `forkThread({sourceProviderThread, sourceProviderTurns?, providerTurnId?, targetThreadId, ownerNodeId?, modelSelection?, runtimePolicy?})` | | `ProviderThread` | `:602-610, 761-763`. `ProviderAdapterForkThreadError`. |
| `uploadFeedback?`, `mcpApps?` (`listTools`, `callTool`, `readResource`) | | | `:752-757, 622-653`. Interactive MCP-app rows. |
| Session-level fields | `instanceId`, `driver`, `providerSessionId`, `providerSession`, `canResumeAfterRestart?`, `events` stream, `subscribeEvents?` (multi-consumer), `hasPendingBackgroundWork?`, `hasPendingBackgroundWorkForThread?`, `backgroundTasksEndWithProcess?`, `getModelContextWindow?`, `canReuseContextUsage?`, `normalizeThreadLoadModelSelection?` | | `:661-689` |

**`TurnInput`** (`:526-543`) carries everything a turn needs, so the adapter holds no thread state of its own:
- `appThread`, `threadId`, `runId`, `runOrdinal`, `nativeThreadHasTurns?`, `providerTurnOrdinal`, `restartContinuationOfRunId?`
- `attemptId`, `rootNodeId`
- `providerThread`
- `message {messageId, text, attachments, createdBy, creationSource, scheduledTaskId, senderThreadId}`
- **`inlineContextLength`**: "leading characters of message.text that are inline handoff context, not the user's words"
- `modelSelection`, `runtimePolicy`
- `appContext[]`: keyed text blocks the adapter places where the protocol allows

**Errors** form one tagged union, `ProviderAdapterV2Error` (`:481-502`). `ProviderAdapterSessionStoppedError` means "No running … session owns this thread" (`:472-479`).

### 1.3 Capabilities

`OrchestrationV2ProviderCapabilities` (`orchestrationV2.ts:397-414`) has 11 groups. Policy consults them; the UI uses some.

| Group | Fields (lines) |
|---|---|
| `sessions` | `supportsMultipleProviderThreadsPerSession`, `supportsModelSwitchInSession`, `supportsProviderSwitchingViaHandoff`, `supportsRuntimeModeSwitchInSession`, `pendingRequestsSurviveRestart` (273-280) |
| `threads` | `canCreateEmptyThread`, `canReadThreadSnapshot`, `canRollbackThread`, `canForkThread`, `canForkFromTurn`, `canForkFromSubagentThread`, `exposesNativeThreadId` (282-291) |
| `turns` | `supportsNativeGoals?`, `exposesNativeTurnId`, `emitsTurnStarted/Completed`, `supportsInterrupt`, `supportsActiveSteering`, `activeSteeringInterruptsTools?`, `activeSteeringAcceptsAttachments?`, `activeSteeringDuringCompaction?`, `supportsSteeringByInterruptRestart`, `supportsQueuedMessages`, `terminalStatusQuality: strong\|weak\|none` (293-310) |
| `streaming`, `tools`, `approvals`, `planning`, `subagents` | 5–7 booleans each (312-359) |
| `context` | `acceptsSystemContext`, `acceptsDeveloperContext`, `acceptsSyntheticUserContext`, `canGenerateSummaries`, `canConsumeHandoffSummaries`, `supportsDeltaHandoff`, `supportsFullThreadHandoff`, `maxRecommendedHandoffChars` (361-371) |
| `checkpointing` | `appCanCheckpointFilesystem`, `supportsNestedCheckpointScopes`, `providerCanRollbackConversation`, `providerRollbackReturnsSnapshot`, `providerCanReadConversationSnapshot` (373-381) |
| `identity` | `nativeThreadIds`, `nativeTurnIds`, `nativeItemIds`, `nativeRequestIds`, each `strong\|weak\|none` (389-395) |
| `runtimePolicy` | `enforcement: native \| client-boundary` (383-387) |

Codex's full declaration is at `CodexAdapterV2.ts:254-330`. Two facts about how these are used:
- Capabilities are re-negotiated per session after the handshake. For example, the ACP adapter sets `canForkThread` from the agent's `sessionCapabilities.fork` (`provider-acp/.../adapter.ts:853-889`).
- **Some flags appear to be declarative only.** I found no code that reads `runtimePolicy.enforcement`, `pendingRequestsSurviveRestart` or `metadata.supportsMultipleInstances` (ACP, lifecycle and persistence sub-reads, each confirmed by grep).

### 1.4 Runtime policy

The policy types (`ProviderAdapter.ts:48-60`, `providerPolicy.ts:10-47`) are:
- `runtimeMode`: one of four, `approval-required < auto-accept-edits < auto < full-access`. The default is `full-access` (`providerPolicy.ts:25-43`).
- `interactionMode`: `default | plan`.
- `cwd`.
- `approvalPolicy?` and `sandboxPolicy?`: opaque overrides, used by tests and delegated children (`RuntimePolicy.ts:62-68, 198-227`).
- `maxRuntimeMode?`: an administrator ceiling. "adapters use it to refuse native mode choices a user makes beside T3 Code's own."

Resolution (`RuntimePolicy.ts:140-196`) takes the thread's modes and the project's workspace root as `cwd`, and refuses anything above the ceiling. Then comes the important line: **when the instance's snapshot lists `supportedRuntimeModes` and the thread's mode is not among them, the mode becomes `approval-required`** (`RuntimePolicy.ts:91-100, 188`). T3 degrades to the safest mode. It does not emulate the requested one.

How the drivers map the policy:

| Driver | Mapping | Source |
|---|---|---|
| Codex | `approval-required` → `untrusted` + `readOnly` sandbox. `auto-accept-edits` → `on-request` + `workspaceWrite` (reviewer user). `auto` → `on-request` + `workspaceWrite` + `approvalsReviewer: "auto_review"`. `full-access` → `never` + `dangerFullAccess`. Sent per turn with `turn/start`. | `CodexAdapterV2.ts:722-760, 789-800` |
| Claude (Agent SDK) | `plan` → `permissionMode: "plan"` (the permission callback is always installed, because "Claude routes Plan-mode writes to the callback even in Auto or Full access"). Otherwise `default` / `acceptEdits` / `auto` / `bypassPermissions` (+ `allowDangerouslySkipPermissions`). A read-only sandbox gives `dontAsk` with a read-only tool list. When the user's settings disable bypass, it downgrades to `auto`, else to `default`. The callback is installed for `approval-required` and `auto-accept-edits`. | `ClaudeAdapterV2.ts:3063-3172` |
| ACP flavors (Grok, Kiro, fx, Antigravity, registry) | **`enforcement: "client-boundary"`.** T3 itself answers `session/request_permission`: reads always allowed; workspace-write edits allowed only inside cwd or the writable roots (realpath-checked, fails closed); `ask` becomes a runtime request; `allow` picks `allow_once` and `deny` picks `reject_once`. Flavors add native modes on top: Kiro `autopilot` only for full access; fx `ask`/`auto`; Antigravity `default`/`auto_edit`/`yolo`; Grok permissions in argv so Grok's own settings cannot loosen them. | `packages/provider-acp/src/server/clientPolicy.ts:40-252`; ACP sub-read §3 |
| Plan mode on ACP | switches to a mode or option whose id ends in `plan` or `architect`, and restores the saved "build" configuration on exit | `provider-acp/.../adapter.ts:1384-1388, 7618-7671` |

HarnessHub's `HUB_POLICIES` (`HH/src/contracts/flavor.ts:119-130`) is already a copy of T3's client policy. HarnessHub goes further, though, and offers all five levels on every Harness.

### 1.5 Selection and session transitions

`decideProviderSessionTransition` (`OV2/ProviderSessionTransitionPolicy.ts:32-88`) is the policy every switch goes through. It returns one of `reuse`, `switch_model_in_session`, `restart_and_resume`, `create_with_handoff` or `reject`, by these rules in order:

| Situation | Result |
|---|---|
| target unavailable | `reject` |
| no current session | `create_with_handoff` |
| different driver or continuation key | `create_with_handoff` |
| same instance, selection changed | the adapter's plan: `create_with_handoff` or `reject`; an unclassified change is rejected |
| instance, runtime mode or workspace changed | `restart_and_resume` |
| selection changed, plan `apply_on_next_turn` | `switch_model_in_session` |
| selection changed, plan `restart_session` | `restart_and_resume` |
| otherwise (interaction mode is applied on the next turn) | `reuse` |

`ProviderSwitchService.plan` (`OV2/ProviderSwitchService.ts`) feeds it the negotiated capabilities of the live session. It also returns which sessions to release: only the replaced one for a restart, and every session of other instances for a handoff.

---

## 2. The event model

### 2.1 Adapter events

All events carry `driver`. Persistence and fan-out come from `ProviderEventIngestor.normalize` (`OV2/ProviderEventIngestor.ts:458-683`) and the session manager's pump (`OV2/ProviderSessionManager.ts:2646-2664`).

| Event (`ProviderAdapter.ts`) | Payload | Stored as | Semantics |
|---|---|---|---|
| `app_thread.created` (84-89) | full `AppThread`, `createOnly?` | `thread.created`, or `thread.metadata-updated` if changed; nothing if unchanged (ingestor 463-494) | how a native subagent becomes a child app thread (`lineage.relationshipToParent = "subagent"`) |
| `provider_session.updated` (90-94) | full `ProviderSession` (status, cwd, model, negotiated capabilities, `extensionStatuses`, `lastError`) | `provider-session.updated` | |
| `provider_thread.updated` (95-104) | full `ProviderThread`, plus `pendingBackgroundWork?`, `sessionScoped?`, `retainedNativeTurnIds?` | `provider-thread.updated`. `retainedNativeTurnIds` marks the runs not retained as `rolled_back` and their checkpoints `stale` (502-519, 386-456). | a native rewind detected from the provider side |
| `provider_turn.updated` (105-110) | full `ProviderTurn` (native ref, ordinal, status, `tokenUsage`, `turnTokenUsage`, reported `model`) | `provider-turn.updated`; a terminal status also cancels pending native user-input requests (520-537) | the token usage field is merged, not replaced (ProjectionStore 800-811) |
| `node.updated` (111-115) | full `ExecutionNode` (kind `root_turn\|assistant_message\|reasoning\|plan\|todo_list\|tool_call\|approval_request\|user_input_request\|subagent\|hook\|system`) | dropped when equal to the stored row, because "adapters resend unchanged nodes with every text delta" (539-541) | the execution tree |
| `subagent.updated` (116-120) | full `Subagent` (origin `provider_native\|app_owned`, child thread, prompt, result, workflow) | `subagent.updated` | |
| `message.updated` (121-125) | full `ConversationMessage` (`streaming` flag) | `message.updated` | **full text each time** |
| `turn_item.updated` (126-132) | full `TurnItem` (24 types, `orchestrationV2.ts:1681-1909`), `sessionScoped?` | `turn-item.updated` | the timeline row |
| `steer.updated` (133-141) | `threadId`, `runId`, `messageId`, `status: pending\|completed\|cancelled` | rewrites the steer's `user_message` item status (618-646) | "stays pending until the agent reads it; cancelled if dropped unread". Emitted by Claude and Pi only (grep). |
| `background_work.updated` (142-149) | `providerTurnId`, `pending` | **not stored**; keeps the run's event subscription open past the root terminal (RunExecutionService 1316-1360, 1670-1676) | Codex only (grep) |
| `command_output.delta` (150-157) | `threadId`, `itemId`, `chunk` | **ephemeral**: goes to `CommandOutputHub`, frames at most every 100 ms, a 16 KiB lag gives a "replace" with the tail (`CommandOutputHub.ts:29-41`) | "Unpersisted deltas go only to clients showing the row; final output arrives in turn_item.updated" |
| `prompt_suggestion.updated` (158-165) | `runId`, `text` | **ephemeral** `SubscriptionRef` | predicted next prompt, after the root terminal |
| `runtime_request.updated` (166-171) | full `RuntimeRequest` (`kind`, `status pending\|resolved\|expired\|cancelled`, `responseCapability live{providerSessionId}\|message\|not_resumable{reason}`) | `runtime-request.updated` | `responseCapability: message` lets a user's next message answer a question after a restart |
| `plan.updated` (172-176) | `PlanArtifact` (`proposed_plan` markdown or `todo_list` steps) | `plan.updated` | |
| `turn.terminal` (177-202) | two variants. Non-failed: `status completed\|interrupted\|cancelled`, `failure: null`, `reason?`. Failed: `failureItemOrdinal`, `failure: ProviderFailure`, `retry?`, `retryStartedAt?`, `childTurnsContinue?`. Both have **`threadDisposition: reusable\|broken`**. | on `failed`, adds an `error` turn item (653-682). Only the root turn's terminal finalizes the run (RunExecutionService 529-532). | `broken` sets the provider thread to `status: error`; the session manager forgets the loaded native thread, and the next start resumes or replaces it (RunExecutionService 332-336; ProviderSessionManager 2706-2723) |

### 2.2 Semantics

- **The meaning is upsert of full state, not delta.** Projections apply events with `upsertById`, and the SQL side is `INSERT … ON CONFLICT(id) DO UPDATE` (ProjectionStore 789-798, 965-1031, 2284-2911). A few fields merge instead of replace: token usage, delegated completion, background-work cancellations, subagent completion delivery (ProjectionStore 800-838).
- **Text streaming is coalesced in the adapter.** `ProviderTextDeltaCoalescer` keeps `${existing}${delta}` and flushes on a timer: 50 ms for Claude and Codex text, 400 ms for Codex plans (`OV2/Adapters/ProviderTextDeltaCoalescer.ts:105-127`; `ClaudeAdapterV2.ts:8548-8549`; `CodexAdapterV2.ts:224-226`). ACP uses its own 50 ms flush with a permit, so a late flush cannot land after the completed snapshot (ACP sub-read §2).
- **Persistence of streaming text is then shaped by the server.** In the default `paragraph` mode, text is cut only at Markdown boundaries, at most once per 400 ms, with an 800 ms idle flush. `turn` mode stores only final text (`OV2/assistantStreaming.ts:153-242`). Each subscriber coalesces again over 50 ms (`OV2/ThreadLiveEventCoalescer.ts:18-77`).
- **IDs are deterministic; event ids are random.** Entity ids derive from native ids, for example `turn-item:provider:<driver>:native-item:<id>` (`packages/provider-core/src/server/IdAllocator.ts:274-318`). A repeated snapshot therefore produces an identical upsert, which makes it idempotent at the projection level. The event log still gets a new row.
- **Timeline order is assigned by the server, not the adapter.** `TurnItemPositionStore` fixes each item's slot on first sight, in a band of `runOrdinal × 1_000_000` (`OV2/TurnItemPositionStore.ts:54-126`).
- **Stale writers are fenced, not versioned.** Conditional writes inside the transaction check that the run is current, that the provider thread's owner is current, and that the payload is equal (`OV2/EventSink.ts:511-713`). Events from another run's attempt are dropped (`RunExecutionService.ts:364-534`). There is no per-entity version compare: a late snapshot of the same entity overwrites an earlier one.
- **Commits are batched.** Snapshot-type events (node, message, turn_item, plan) from all runs share one transaction of up to 64 events or 1 MiB, with a savepoint per job. Any other type flushes the batch (`OV2/ProviderCommitBatch.ts:12-215`).

### 2.3 Domain events, commands and the wire

- **`OrchestrationV2DomainEvent`** (`orchestrationV2.ts:1955-2104`) has about 45 types, among them `thread.*`, `run.created/updated`, `run-attempt.*`, `node.updated`, `subagent.updated`, `provider-session.attached/updated/detached`, `provider-thread.updated`, `provider-turn.updated`, `runtime-request.updated`, `message.updated`, `turn-item.updated`, `plan.updated`, `checkpoint-scope.created`, `checkpoint.captured`, `checkpoint.rollback-requested`, `context-handoff.updated` and `context-transfer.created/updated`. They are stored as `StoredEvent {sequence, commandId, event}` (2388-2393).
- **Commands** (`orchestrationV2.ts:3050-3535`) number about 70 public ones plus internal ones. Examples: `message.dispatch` with a dispatch mode (`defer_start`, `steer_active{targetRunId}`, `restart_active`, `queue_after_active`, `start_immediately`), `run.interrupt`, `runtime-request.respond`, `checkpoint.rollback`, `thread.fork`, `thread.merge_back`, `delegated_task.request`, `provider.switch`, and the `queued-run.*` family.
- **WebSocket methods** (`orchestrationV2.ts:3768-3792`) include `dispatchCommand`, `subscribeThread`, `subscribeShell`, `subscribeCommandOutput`, `subscribePromptSuggestion`, `getThreadProjection`, `getTurnItem` (full bodies on demand), `launchThread`, `forceStopThread` and search.

### 2.4 Ordering, idempotence and replay after reconnect

| Concern | Mechanism | Source |
|---|---|---|
| Ordering | one global `sequence INTEGER PRIMARY KEY AUTOINCREMENT` plus a per-thread `stream_version` | `apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:7-23`; `OrchestrationEventStore.ts:490-501` |
| Publish order | a single-permit `publishLane` serializes commit-and-publish: "reordered publication makes clients drop earlier sequences" | `OV2/EventSink.ts:302-329` |
| Command idempotence | `orchestration_command_receipts`: a repeated `commandId` returns the stored events. A rejected receipt is also stored. | `Orchestrator.ts:14950-15205`; `OV2/CommandReceiptStore.ts:102-128` |
| Snapshot | the projection and `MAX(sequence)` are read in one transaction | `ProjectionStore.ts:6309-6326` |
| Resume | `subscribeThread` with `afterSequence` replays when the gap is at most 128 events or 1 MiB and is not pruned. Otherwise the server sends a snapshot. Then it emits `synchronized`, then the live tail. Live subscription is taken *before* reading the high-water mark, so there is no gap; overlap is filtered on the server. | `apps/server/src/ws.ts:892-1123`; `OV2/ThreadStream.ts:18-27, 99-118`; `OV2/LiveStreamBudget.ts:320-387` |
| Client | drops `sequence <= lastSequence`. A snapshot resets the cursor. On reconnect it sends `afterSequence`. | `packages/client-runtime/src/state/threads.ts:523-545, 645-656, 1090-1100` |
| Shell (thread list) | `subscribeShell` with the same scheme, but a budget of 1,000 events / 8 MiB, a `snapshot-required` HTTP fallback, and per-50 ms grouping | `OV2/ShellStream.ts:45-105, 535-590` |
| Backpressure | 1,000 items or 8 MiB per subscriber. On overflow the stream fails with "Resume from the last received sequence". Delivery is paced by ACK. | `LiveStreamBudget.ts:18-19, 67-84, 175-184` |
| Retention | the event log keeps about a day (`RETAINED_EVENT_HISTORY`). The pruned-through mark forces resuming clients onto a snapshot. **The projections are the system of record; nothing rebuilds them from the log.** | `OV2/ProjectionMaintenance.ts:41-45, 121-138, 284-292` |

---

## 3. Entities, binding and storage

### 3.1 The entity graph

```
AppThread (the user's conversation; owns modes, model selection, worktree, lineage)
 ├─ activeProviderThreadId ───────────────┐
 ├─ Run (one user/agent input; ordinal)    │   ProviderSession (one native process/connection; capabilities)
 │   └─ RunAttempt (initial|steering_restart|retry|provider_recovery; nativeThreadId)
 │        └─ ExecutionNode tree (root_turn → tool_call, subagent, approval_request …)
 │             └─ ProviderTurn (native turn; tokenUsage; model) ── belongs to ──┐
 ├─ ProviderThread × N (one per instance the thread ran on) ◄───────────────────┘
 │     nativeThreadRef {driver, nativeId, strength}, nativeConversationHeadRef,
 │     providerSessionId, firstRunOrdinal/lastRunOrdinal, handoffIds, forkedFrom,
 │     pendingBackgroundTasks, contextUsage, nativeMetadata, goal
 ├─ ConversationMessage, TurnItem (24 types), PlanArtifact, RuntimeRequest, Subagent
 ├─ CheckpointScope → Checkpoint (git refs)
 └─ ContextHandoff, ContextTransfer (fork | provider_handoff | merge_back | subagent_spawn | subagent_result)
```

The definitions are in `orchestrationV2.ts`:

| Entity | Lines |
|---|---|
| AppThread | 466-540 |
| Run | 724-760 |
| RunAttempt | 769-791 |
| ExecutionNode | 794-832 |
| Subagent | 920-960 |
| CheckpointScope | 969-981 |
| ProviderSession | 984-1003 |
| ProviderThread | 1126-1160 |
| ContextHandoff | 1176-1217 |
| ProviderTurn | 1220-1241 |
| RuntimeRequest | 1259-1283 |
| ConversationMessage | 1369-1399 |
| Checkpoint | 1470-1484 |
| TurnItem | 1681-1909 |
| ContextTransfer | 245-270 |

### 3.2 How a native thread binds to an app thread

- **A `ProviderRef` records a native id together with a strength:** `{driver, nativeId|null, strength: strong|weak|none, fingerprint?, ordinal?}` (`orchestrationV2.ts:155-165`). ACP turn and item ids are `weak` because T3 synthesizes them, for example `<sessionId>:turn:<ordinal>`. Codex ids are `strong` (ACP sub-read §2; Codex capabilities `identity`).
- **The binding runs both ways.** `AppThread.activeProviderThreadId` points to the provider thread (480), and `ProviderThread.appThreadId` plus `providerInstanceId` point back (1126-1135). A provider thread whose `nativeThreadRef` is null has not been started natively yet. This is what decides between a "full" and a "delta" handoff (`Orchestrator.ts:2635-2640`).
- **The native input destination is recorded per attempt** (`RunAttempt.nativeThreadId`): "Provider-thread rows can be reused after recovery; retain the native input destination" (`orchestrationV2.ts:771-772`).
- **The session id is chosen by the orchestrator, not the adapter** (`Orchestrator.ts:1559-1577`):
  - multi-thread adapters get `provider-session:provider-instance:<id>:shared`;
  - others get a random `…:thread:<threadId>:<uuid>`.

  The id is stored on the provider-thread row and reused (`Orchestrator.ts:2761-2795`).

### 3.3 Continuation identity

Each instance has a continuation identity `{driverKind, continuationKey}` (`driver.ts:86-99`):
- The default key is `${driver}:instance:${instanceId}`.
- Codex uses `codex:home:<sharedHomePath>`; Claude uses `claude:home:<config dir>` (lifecycle sub-read §1).

Two instances with the same key can continue each other's native threads (`restart_and_resume`). Different keys force `create_with_handoff` (`ProviderSessionTransitionPolicy.ts:46-51`). The web composer refuses a cross-key switch when the provider does not support handoff (`apps/web/src/components/chat/useComposerSelection.ts:138-153`).

**Key point.** The continuation key names *the native store*, not the process. That is the right identity for "can this native thread be resumed here".

### 3.4 Persistence

- **Engine.** SQLite via `node:sqlite`, with separate reader and writer threads, WAL and `synchronous=NORMAL` (`apps/server/src/persistence/Sqlite.ts:72-121`).
- **Tables** (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:54-313`, plus `Foundation.ts`):
  - the global `orchestration_events`;
  - one projection table per entity (`orchestration_v2_projection_{threads, runs, run_attempts, nodes, provider_sessions, provider_threads, provider_turns, runtime_requests, messages, plans, turn_items, checkpoint_scopes, checkpoints, context_handoffs, context_transfers, subagents}`), each with key columns plus `payload_json`;
  - an effect outbox;
  - turn-item positions;
  - projection metadata;
  - command receipts.
- **Facts are committed before they are published.** One transaction covers the receipt, the events, the projections, `last_sequence`, the outbox effects and the receipt result (`EventSink.ts:731-807`). Publication is uninterruptible once the commit has happened (`EventSink.ts:304-329`). A runtime-request response effect refuses to run unless the stored request is already `resolved` (`RuntimeRequestService.ts:~88-95`).
- **The outbox and `EffectWorker`:**
  - Effects include `provider-turn.start|steer|restart|interrupt`, `runtime-request.respond`, `provider-thread.rollback`, `checkpoint.capture`, `provider-runtime.continue`, cleanups and title generation. They are split into process-bound and replay-safe kinds (`EffectOutbox.ts:34-160`).
  - Each thread is a FIFO lane with leases (`EffectOutbox.ts:327-381, 549-579`).
  - Retries: 5 attempts with exponential backoff up to 30 s. Concurrency is 4 (`EffectWorker.ts:707, 874-889, 945-946`).
  - **A declined steer is re-dispatched as an ordinary message with the same message id** (`EffectWorker.ts:255-379`).

### 3.5 Projection and push

- **`ThreadProjection`** holds every entity array plus `visibleTurnItems` (`orchestrationV2.ts:2107-2133`).
- **Forks do not copy rows.** At read time, the source thread's rows up to the fork run are marked `inherited`, a `synthetic` fork marker is added, then the `local` rows follow. This is a recursive SQL read (`ProjectionStore.ts:1426-1605, 4375-4524`).
- **Visibility** hides rolled-back runs, still-queued or cancelled queued messages, and interrupt results of superseded attempts (`packages/shared/src/orchestrationV2Timeline.ts:75-120`).
- **Paging and the wire.** Snapshots are paged by 10 user turns / 75 items / 500 turn items / 1 MiB, with a base64url cursor (`OV2/threadHistoryPaging.ts:16-53`). The wire strips command output, diffs and handoff summaries (`outputOmitted`), and caps checkpoint file lists at 200. Full bodies come through `getTurnItem` (`OV2/WireProjection.ts:26-343`). Opt-in deduped bodies blank repeated text (`packages/shared/src/orchestrationV2DedupedBodies.ts`).

### 3.6 Resume after a server restart

- **Startup order.** Recovery runs before the effect worker starts (`apps/server/src/serverRuntimeStartup.ts:528-549`).
- **What `ProviderRuntimeRecoveryService.reconcile` does** (`OV2/ProviderRuntimeRecoveryService.ts:208-984`):
  - cancels non-terminal runs, except `waiting` runs with a pending checkpoint capture;
  - re-holds undelivered user runs in the queue;
  - expires live runtime requests, while questions switch to answer-by-message;
  - marks sessions stopped and provider threads idle;
  - records lost background work;
  - adds a "Server restarted" notice;
  - cancels process-bound effects.
- **The next turn re-binds the native thread** (`ProviderTurnStartService.ts:1216-1428`):
  1. It opens a fresh session with `resumeFromSession` and `initialNativeThreadId`.
  2. It calls `resumeThread`.
  3. If that fails, or the context budget is exhausted, it starts a fresh native thread, keeps the row identity, and writes a "Recovered context" handoff.
  4. `ThreadInUse` aborts instead.
- **Optional auto-continue** (setting `continueThreadsAfterServerUpdate`): a running run with a strong native ref gets a `provider-runtime.continue` effect. That dispatches "Continue where you left off…", at most 3 times in 5 minutes (`OV2/RestartContinuation.ts:33-37, 114-329`).

### 3.7 Checkpoints

- **Storage.** Checkpoints are git commits outside branches: `refs/t3/orchestration-v2/checkpoints/<b64url(sha256(scopeId)[:32])>/ordinal/<n>`, written with a temporary index file (`OV2/CheckpointService.ts:26, 154-165`; `apps/server/src/vcs/GitVcsDriver.ts:969-1365`).
- **Scopes.** There is one root scope per thread, and a baseline is captured before each run. The schema allows `subagent`, `tool`, `provider_thread` and `manual` scopes, but only `root_run` scopes are created (persistence sub-read §7, not contradicted).
- **Run completion waits for the capture.** A completed turn leaves the run `waiting` until `checkpoint.capture` flips it to `completed`, so queued runs wait for the capture (`RunExecutionService.ts:731-776`; `CheckpointCaptureService.ts:197-212`).
- **Rollback** (`OV2/CheckpointRollbackService.ts:143-420`) runs in this order:
  1. validate;
  2. open or resume the session;
  3. `session.rollbackThread` rewinds the conversation;
  4. `git restore --source <ref> --worktree --staged` and `git clean -fd`;
  5. mark later runs `rolled_back` and checkpoints `stale`.

  `restoreFiles: false` is a conversation-only rewind.

---

## 4. Processes and lifecycle

### 4.1 Instances and the registry

- **Config.** `ProviderInstanceConfig = {driver, displayName?, accentColor?, environment?: [{name, value|SecretReference, sensitive}], enabled?, config?: unknown}` (`packages/contracts/src/providerInstance.ts:32-82`). Instances are stored in `settings.providerInstances` (`settings.ts:1546-1549`).
- **Default instances.** Each built-in driver gets a default instance whose id is the driver kind, except `acpRegistry` (`OV2/../provider/ProviderInstanceRegistryHydration.ts:55-87`; `provider-acp-registry/src/server/driver.ts:506-507`). By default only Codex and Claude are enabled (`settings.ts:1592-1617`).
- **Building an entry.** `ProviderInstanceRegistry.buildEntry` turns a policy block, an unknown driver, an undecodable config, an unreadable secret or a failing `create` into an *unavailable snapshot*. Otherwise it runs `create` in a child scope (`apps/server/src/provider/ProviderInstanceRegistry.ts:204-362`).
- **Reconcile** compares entries with `Equal.equals`. It closes the scopes of changed or removed instances *before* building their replacements, keeps unchanged ones, reads secrets in one batch, and is serialized by a semaphore (`:364-565`). Hydration subscribes to settings changes before reading the seed settings (`ProviderInstanceRegistryHydration.ts:134-210`).
- **`ProviderRegistry`** sits on top: snapshots, refresh, model catalogs, maintenance and a change stream (`apps/server/src/provider/ProviderRegistry.ts:55-126, 871-1010`).

### 4.2 Status snapshots and caching

- **Contents.** `ServerProvider` (`packages/contracts/src/server.ts:220-288`) holds identity, capabilities, installed/version/status/auth, models, slash commands, skills, per-cwd workspace snapshots (5-minute TTL, at most 16), usage limits, version and compatibility advisories, and update state.
- **Probing.** Probes run at creation, on settings changes, and on an interval of 1, 5 or 15 minutes by activity profile (`packages/provider-core/src/server/managedProvider.ts:147-443`; `packages/shared/src/backgroundActivitySettings.ts:23-57`). Probe commands time out after 4 s, or 10 s for auth (`snapshotProbe.ts:45-46`).
- **Disk cache.** Snapshots are cached per instance at `<providerStatusCacheDir>/<instanceId>.json` and hydrated at boot only if the identity matches (`apps/server/src/provider/providerStatusCache.ts:57-144`).
- **Push.** Clients receive deltas (`ws.ts:493-514, 3325-3330`).

### 4.3 Sessions

- **Keying.** The session manager keys live sessions by `providerSessionId`. `open` runs under a per-id lock. It reuses a live entry; a second thread may attach only if `supportsMultipleProviderThreads`. Otherwise it calls `adapter.openSession` in a fresh scope behind the installation gate (`OV2/ProviderSessionManager.ts:343-345, 510-514, 2843-2961`).
- **Native-thread cache.** Loads are cached by native ref, model selection and policy, so a repeated `resumeThread` is skipped (`:373-402, 2244-2309`).
- **Idle handling:**
  - Sessions idle out after **30 minutes**.
  - A session is pinned for up to **4 hours** while `hasPendingBackgroundWork`, or while a delegated child awaits delivery (`:65-66, 1358-1502`).
  - Shared sessions also unload individual idle threads after 30 minutes. Codex does this with `thread/unsubscribe` or `thread/archive` (`:1827-1988`; `CodexAdapterV2.ts:7889-7905`).
- **Release.** The reasons are `idle_timeout`, `runtime_error`, `manual_shutdown` and `server_shutdown`. A release writes stopped or error, expires requests, clears background rosters only if `backgroundTasksEndWithProcess`, and closes the scope with a 30 s cap (`:127-133, 742-934, 1202-1234`).

### 4.4 How many native processes run

| Driver | Native unit | Count and lifetime | Source |
|---|---|---|---|
| Codex | `codex app-server` | **one per instance**, serving every thread: "One app-server serves every Codex thread on an instance". 2 s force-kill. | `CodexAdapterV2.ts:1470, 1513-1560, 1709-1966` |
| Claude | Agent SDK `query()`, which spawns the CLI | **one per app thread**, opened lazily at turn start, reused while the native thread, policy and selection match. The default binary is the user's own `claude` on PATH (`binaryPath` defaults to `"claude"`). Runs in its own process group under a `/bin/sh` watcher that kills the group when the server's pipe hits EOF. | `ClaudeAdapterV2.ts:376-434, 2121-2123, 12035-12207`; `packages/contracts/src/settings.ts:614-624, 784` |
| OpenCode 1 | `opencode serve` | one per thread (or a configured `serverUrl`) | `provider-opencode/src/server/adapter.ts:949-961` |
| OpenCode 2 | `opencode serve` | **one per instance**, reference-counted and closed 30 s after the last borrower. Recorded under `stateDir/opencode-servers`; orphans are reaped at start. | `v2/OpenCode2Server.ts:2, 158-174`; `OpenCodeServerOwner.ts:11-156`; `OpenCodeServerLedger.ts:275-312` |
| ACP flavors | agent child process | one per session, which in practice means one per thread | `provider-acp/src/server/adapter.ts:715-722, 7072-7112` |
| Pi | `pi` RPC child | one per thread | `packages/provider-pi/src/server/rpc.ts:208-227`; `adapter.ts:100` |
| Probes | short-lived copies of the above | per probe | `CodexProvider.ts:624-705`; registry `probe.ts:429-444` |

**Containment.** Processes run under `AgentScope` (systemd scopes where available), or a cgroup v2 lease / POSIX ownership ledger for ACP (`packages/shared/src/AgentScope.ts`; `AcpSessionRuntime.ts:258-1625`). On Linux, Claude's pids are recorded and survivors are killed at start (`process/providerProcesses.ts:44-120`). The session manager drops post-signal events and releases everything in parallel at shutdown (`ProviderSessionManager.ts:494-509, 2814-2839`).

**"Managed" means three things in this code.** Only one of them conflicts with HarnessHub:
1. the snapshot manager (`managedProvider.ts`);
2. **a T3-installed Codex binary**, under `baseDir/tools/codex`, with a shadow home and ChatGPT OAuth through a token broker (`CodexInstallation.ts:199-210`; `CodexManagedHome.ts:6-19`; `CodexManagedRuntime.ts:22-133`). This is the one that conflicts;
3. an administrator policy.

**Installation gate.** Each instance has a turnstile. `update` drains in-flight opens, queries and text generation for every instance that shares the install before it runs the update (`apps/server/src/provider/ProviderInstallationGate.ts:9-73`; `providerMaintenanceRunner.ts:585-596`).

---

## 5. Cross-cutting features

### 5.1 Attachments

- **Limits** (`packages/contracts/src/chatAttachment.ts:13-31`):
  - 120,000 prompt characters and 100 attachments;
  - 10 MiB per image and 80 MiB of images per message;
  - 50 MiB per file;
  - native image types gif, jpeg, png and webp.
- **Storage.** Files are stored under `stateDir/attachments` and claimed per thread. A claim copies the pending file, checks its size, extracts text for docx/xlsx/pptx/odt/rtf/epub/ipynb into a `.txt` sidecar (in a sandboxed child process, 15 s, 4 MiB), and rolls back on error (`OV2/AttachmentClaims.ts:67-171`; `apps/server/src/provider/DocumentText.ts:14-110`).
- **Prompt text.** Every attachment is always listed in the prompt as `[Attached <type> "<name>" is saved at: <path> (text extracted to: <path>.txt)]`. An unresolved one is named, not dropped (`packages/provider-core/src/server/attachmentPrompt.ts:171-183`).
- **Native blocks.** Images go as native blocks: Claude base64 image and PDF document blocks (28 MiB / 100 pages per session); Codex `data:` URLs; ACP image blocks only if the agent negotiated images (cross-cutting sub-read §A).
- **Sandbox.** `attachmentsDir` is added to Claude's `additionalDirectories` (`ClaudeAdapterV2.ts:2146-2152`). I did not find a Codex sandbox grant for it.

### 5.2 MCP injection: T3's own tools in every provider

- **The server.** T3 runs one HTTP MCP server, "T3 Code" at `/mcp`. A bearer token resolves to a session through `McpSessionRegistry` (`apps/server/src/mcp/McpHttpServer.ts:244-265, 1303-1327`).
- **`McpProviderSessions`** (`packages/provider-core/src/server/McpProviderSessions.ts:31-184`) is only a per-thread map of `McpProviderSessionConfig {environmentId, threadId, providerSessionId, providerInstanceId, endpoint, authorizationHeader, browserToolsAvailable, capabilities?, agentDeviceEnvironment?, hasPendingWake?}` (`mcpSession.ts:10-23`). It also matches HTML renders back to attachments.
- **Deferred tools.** The header `t3-tool-exposure` lets clients that cannot defer tools see a core set plus `tool_search` (`mcpSession.ts:4-8`).

How each driver receives the server:

| Driver | Instructions | MCP entry |
|---|---|---|
| Claude | `systemPrompt: {preset: "claude_code", append}` (`ClaudeAdapterV2.ts:2125-2139`) | `mcpServers["t3-code"]`, type http with `Authorization` (`:2270-2290`) |
| Codex | `additionalContext` entries, restored after compaction with `thread/inject_items` (`CodexDeveloperInstructions.ts:40-60`; `CodexAdapterV2.ts:826-843, 1883-1900`) | thread `config.mcp_servers.t3-code` with `http_headers.Authorization`, plus a `t3-code-direct` server exposing only `t3_thread_wait` (`:1440-1487`) |
| ACP | inside the prompt as a `<t3_code_instructions>` wrapper, resent after compaction (`packages/provider-core/src/server/orchestrationInstructions.ts:76-105`; acp `adapter.ts:8222-8257`) | `{type:"acp", serverId:"t3-code"}` when the agent advertises MCP-over-ACP; otherwise HTTP (opt-in per flavor, because "codex-acp 1.2.0 and pi-acp drop injected HTTP servers"); otherwise a stdio bridge, the T3 binary run as `acp-mcp-bridge` (acp `adapter.ts:900-954`; `mcpOverAcpBridge.ts`; `AcpSessionRuntime.ts:2154-2168`) |
| Pi | appended on `before_agent_start` by a generated extension | `--extension` file plus `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN`; the extension proxies `tools/list` and `tools/call` (`packages/provider-pi/src/server/mcpInjection.ts:288-323`; `mcpExtensionSource.ts:233-504`) |
| OpenCode, Cursor, Muse | system prompt or prompt prefix | HTTP headers or a credential (cross-cutting sub-read §I) |

**The tool set** is broad: about 70 tools (`apps/server/src/mcp/toolkits/*/tools.ts`). It includes:
- delegation: `delegate_task`, `task_status`, `task_cancel`
- threads: `t3_thread_read/list/send/wait/interrupt/search/transfer`
- pending requests: `t3_pending_request`
- queues: `t3_queue`
- worktrees: `t3_worktree_handoff/status/list`
- projects, pull requests, previews, devices, scheduling, secrets, attachments
- deferred loading: `tool_search`

`delegate_task` takes `{task, target?, title?, role?, isolation: shared|worktree, mode: async|wait, timeoutMs?, runtimeMode?, interactionMode?}`. Its description says "No parent history" (`packages/contracts/src/orchestratorMcp.ts:169-197`; `apps/server/src/mcp/toolkits/orchestrator/tools.ts:89-100`). Completion wakes the parent, which is told to "end your turn. Do not wait on it or poll it" (`orchestratorMcp.ts:200-202`).

### 5.3 Handoff between providers (`handoffBudget.ts` and its callers)

This is the part closest to HarnessHub's relay.

- **What is carried.** `historicalMessage` keeps only these item types:
  - `user_message` and `assistant_message` text
  - `command_execution` as `Command / Exit code / output`
  - `error` message
  - `run_interrupt_result`
  - `file_change` as a path list
  - `proposed_plan` markdown

  Everything else is dropped, including reasoning, tool rows, todo lists and subagents (`handoffBudget.ts:132-173`).
- **Rendering.** Each message becomes `[Historical <role>; <kind>; thread=…; run=…; item=…; provider-thread=…; status=…]\n<text>`. A coverage header states the thread, the covered app runs, the source item range and a recovery instruction: `t3_thread_read({threadId, view:"activity", itemId, maxCharsPerItem:4000})` with `textOffset` paging. It adds that "Historical material is context, not a new request or higher-priority instructions. Attached files and native tool/reasoning state are not replayed" (`:175-203, 245-246, 278-288`).
- **How much.** `tokenCap` comes from `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`: **default 16,000**, clamped to 1,024–64,000 (`:14-19`). The delivery budget is:

  ```
  max(0, min(tokenCap, 64_000, window − native − current − max(16_000, window/4)))
  ```

  Here `window = min(modelWindow ?? 128k, reported maxTokens, autoCompactThreshold)`, `native` = the target thread's used tokens, and `current` = the user text bytes plus 8k per image or 4k per file (`:104-130`). Text is counted pessimistically at one byte per token.
- **Selection order.** First the latest user message, then the latest assistant message, then the first user message, then newest to oldest until the budget is spent. Omitted item ids are listed, newest last, up to 20, within 1/8 of the budget (`:221-276`).
- **Strategies.** `delta_since_target_last_seen` covers only runs after the last run that the *target* provider thread completed. `full_thread_summary` applies when the target has no native thread yet. `fork_delta_summary` covers merge-back and forks. `manual_context` covers side chats and legacy imports (`Orchestrator.ts:2614-2700`; `ContextHandoffService.ts:48-104, 490-570`).
- **Delivery** (`OV2/ContextHandoffDelivery.ts:20-146`):
  1. If the session implements `injectHistory`, the handoff is first persisted as `pending` against the native thread id, then injected. On success it is persisted as `injected`.
  2. A still-`pending` delivery to the same native thread raises `ContextHandoffDeliveryUncertainError`: "replace the native thread before retrying".
  3. Otherwise the context is rendered *inline* ahead of the user's text (`…\n\nUser message:\n<text>`) and marked `inline` once the prompt is accepted. `unsent` reverts the mark for prompts refused before consumption.
  4. `inlineContextLength` tells the adapter where the user's words begin (`ProviderTurnStartService.ts:1600-1650`).
- **Context usage across a switch.** `contextUsageForHandoff` keeps native occupancy only on the same native thread (`handoffBudget.ts:67-86`).

### 5.4 Model catalogs

- **Manifest.** A bundled `model-manifest.json` is refreshed from GitHub every hour, or every 5 minutes on demand. It holds per-driver models, profiles (option descriptors such as `effort`, `fastMode`, context windows) and compatibility ranges (`apps/server/src/provider/ModelManifest.ts:25-255`).
- **Selection.** `ModelSelection = {instanceId, model, options?: [{id, value}]}`. **Effort is not a top-level field**: it is `effort` for Claude, `reasoningEffort` for Codex, and `agent`/`variant` for OpenCode (`packages/contracts/src/modelSelection.ts:9-38`; `model.ts:7-195`).
- **Per-cwd catalogs.** `snapshotForCwd` returns per-directory skills, commands and, for OpenCode, models (`driver.ts:31-50`).

### 5.5 Usage and limits

- **Turn usage.** `TurnTokenUsage {usageStatus complete|partial|unavailable, usageScope main_agent, otherUsage?, models?}` (`packages/contracts/src/providerRuntime.ts:56-87`). Codex turn usage is the change in thread totals from a baseline; Claude sums the segments split by steering (`CodexTurnTokenUsage.ts:69-169`; `ClaudeTurnTokenUsage.ts:24-241`).
- **Limit windows** (session/weekly/monthly) come from probes and streamed events, and are merged by window id (`packages/provider-core/src/server/usageLimits.ts:50-130`; `claudeUsageLimits.ts:154-217`; `codexUsageLimits.ts:59-203`).
- **Auto-resume after a reset.** The `UsageLimitRecoveryWorker` arms `limitRecovery` and, after the reset, dispatches "Continue where you left off." (`OV2/UsageLimitRecoveryWorker.ts:17-155`).

### 5.6 Auth

- **The default is the user's own CLI login.** When signed out, the UI shows "Run `claude auth login`" or "Run `codex login`" (`ClaudeProvider.ts:790-801`; `CodexProvider.ts:903-904`).
- **T3-owned credentials** exist only for:
  - managed Codex (ChatGPT OAuth);
  - Cursor;
  - Antigravity;
  - ACP registry agents (owner `provider`).

  They are stored 0600 under a secrets directory (`packages/provider-core/src/server/auth.ts:12-58`; `providerAuthFlow.ts`; `ProviderCredentialStore.ts:6-23`).
- **Sign-in changes.** A change stops every session that shares the credential binding (`ProviderAuthService.ts:93-197`).

### 5.7 Logging

- **Files.** One NDJSON file per thread: `stateDir/logs/provider/events.<thread>.log`, with lines `[ISO] NTIVE|CANON|ORCH: <json>`.
- **Rotation and retention.** 10 MiB × 10 files, 512 MiB and 14 days in total, written in 1-second batches.
- **What is dropped.** Streaming deltas are dropped, and oversized records are summarized (`apps/server/src/provider/EventNdjsonLogger.ts:28-765`).
- **Payload values.** `summarizeNativeProtocolPayload` never logs payload values; it records only types, byte lengths and key counts (`nativeProtocolLogging.ts:7-36`).
- **Gaps.**
  - Codex's wire logger redacts tokens (`CodexAdapterV2.ts:1616-1691`).
  - No production writer for the `canonical` channel was found.

### 5.8 Testing: recorded native transcripts, replayed through the real orchestrator

- **Transcript format.** A `transcript_start` header (provider, protocol, version, scenario), followed by entries `expect_outbound{frame}`, `emit_inbound{frame, afterMs?}` and `runtime_exit` (`packages/contracts/src/orchestrationV2.ts:4521-4565`; `packages/provider-testing/src/replayTranscript.ts:52-160`).
- **Recording.** Recorders exist per protocol, for example `apps/server/scripts/record-codex-app-server-replay-fixture.ts:1022-1080`. Workspace, home and hostname are replaced with placeholders.
- **Replay.** Outbound frames must match exactly; otherwise `CodexAppServerReplayFrameMismatchError` (`packages/effect-codex-app-server/src/replay.ts:475-500`). Gates can hold inbound frames at a label (`replayGate.ts:24-114`).
- **Harness.** The real OrchestratorV2 runs on in-memory SQLite (`OV2/testkit/ProviderReplayHarness.ts:83-609`).
- **Fixtures are shared scenarios across drivers.** A fixture is `{name, buildInput(){steps, workspaceFiles?, runtimeMode?, interactionMode?}, providers:[{driver, transcriptFile, modelSelection, assertOutput, …}]}`. Steps include message, steer, interrupt, restart, fork, rollback, approve, advance_clock and set_model (`OV2/testkit/fixtures/shared.ts:172-307`). "simple" runs on 10 drivers (`fixtures/index.ts:809-866`). A guard fails if a driver has no replay test file (`ProviderReplayFixtures.ts:28-48`).
- **Projection check.** `ProjectionReplay` asserts that the projections equal a replay of the unpruned log (`OV2/testkit/ProjectionReplay.ts:28-38`).

### 5.9 Maintenance and updates

- **Detecting the install method.** `maintenanceResolver.ts:740-958` recognizes mise, Nix, MacPorts, the native installer, Vite+/bun/pnpm/yarn/Volta, an npm prefix and Homebrew, and builds a matching update command. A `manualCommand` is "Displayed for manual updates; never executed by T3 Code" (`maintenance.ts:20-21`).
- **Updates run only on user request.** The trigger is `serverUpdateProvider` (`ws.ts:2572-2573`). An update takes a per-`lockKey` lock, checks the target against the compatibility manifest, drains the installation gate, and has a 30-minute timeout (`providerMaintenanceRunner.ts:44-697`).

---

## 6. The shared ACP runtime (`packages/provider-acp`)

**Architecture.**
- `effect-acp` handles the wire and version layer. `initialize` always sends `protocolVersion: 2`, and the version is detected from the response *shape*, because "Antigravity … reports version 2 with the v1 … shape". It pins `schema-v2.0.0-alpha.3` and `schema-v1.21.0` (`packages/effect-acp/src/client.ts:693-723`; `scripts/generate.ts:16-17`).
- `AcpSessionRuntime` is one per child process.
- `makeAcpAdapterV2` maps ACP onto T3's model, with about 90 optional hooks on an `AcpAdapterV2Flavor` (`adapter.ts:338-620`).

Users of this adapter: Grok, Kiro, fx, Antigravity and the ACP registry. Cursor and Pi do not use it.

**What it adds on top of plain ACP:**

1. **Process containment and replacement.**
   - Agents run under AgentScope, with a cgroup v2 lease or POSIX ownership ledger and escalating SIGTERM/SIGKILL with verification (`AcpSessionRuntime.ts:258-1625`).
   - A replacement runtime (for rollback or a forced new thread) holds its updates until committed. A generation counter turns late callbacks from the old process into no-ops (`adapter.ts:2084-2133, 7114-7284`).
   - A lazy `runtimeRestartRequired` respawns after crash, inactivity or hidden failures (`:8266-8284`).
2. **Mapping `session/update` onto entity snapshots.**
   - `agent_message_chunk` → node + message + turn item, flushed every 50 ms.
   - Thought → reasoning.
   - `tool_call` and `tool_call_update` → a node, with the item type taken from the ACP tool kind: command, file change, search, web, MCP `dynamic_tool`, compaction.
   - `plan` → `plan.updated` plus a todo item.
   - `usage_update` → provider thread context usage.
   - Unknown kinds → a completed `dynamic_tool` titled "Unsupported ACP update: X" (`adapter.ts:2839-5717`).
   - Tool updates are throttled twice (`runtimeModel.ts:962-1054`; `adapter.ts:1753-1777`).
3. **Client-boundary permissions** (§1.4) and plan-mode mapping onto modes and config options, with build-mode restore (`adapter.ts:7419-7680`).
4. **Client capabilities.**
   - fs reads, only for Antigravity, scoped to cwd plus attachments. Writes are never advertised, because "Advertising writes swaps the agent's diff edits for whole-file client_edit_file".
   - Client terminals, only for Devin: 16 live, 4–8 MiB of output each.
   - Elicitation forms → `user_input_request`.
   - The MCP-over-ACP bridge (§5.2).
   - (`clientTerminals.ts`; `elicitationForm.ts:180-254`; `mcpOverAcpBridge.ts`)
5. **Load and resume.**
   - The runtime prefers `session/load` and falls back to `session/resume`. On v2, load is `resume` with `replayFrom: start`.
   - A load completes when the RPC returns, or after 2 s of replay quiet (90 s cap).
   - Replayed updates rebuild `readThreadSnapshot` (`AcpSessionRuntime.ts:81-82, 1961-2266`).
6. **Steering, interrupt, compaction and fork per flavor.**
   - The base declares `supportsActiveSteering: false` and `supportsSteeringByInterruptRestart: true` (`adapter.ts:737-738`). Only Kiro steers natively.
   - Interrupt sends `session/cancel`, waits up to 15 s for a prompt to confirm (fx, Antigravity), then a 10 s stop timeout raises `InterruptTimeout`.
   - Compaction is `/compact`, or Kiro's `_kiro/session/compact`, or an advertised `compact` command.
   - Fork from a turn other than the head is Kiro-only.
   - **Rollback is checkpoint-only:** a fresh `session/new` plus an empty snapshot (`adapter.ts:794-795, 9037-9692`).
7. **Per-flavor quirks:**
   - **Grok:** prompt completion via `x.ai/session/prompt_complete`, rate limits mapped to −32003, `x.ai/ask_user_question`, `x.ai/exit_plan_mode`, background task notifications.
   - **Kiro:** agent mode set before model, hooks, `_session/steer`.
   - **fx:** mode write forced after load because fx enforces its saved default.
   - **Antigravity:** eager OAuth, `_meta.antigravity.systemPrompt.append`, a session-log watcher for hidden errors.
   - **Registry:** Claude ACP via `followAgentWorkState`, Copilot's event feed, Devin terminals, Mistral retries; agents are installed from the ACP CDN registry with sha256 checks.
   - (ACP sub-read §6)
8. **Robustness.**
   - A malformed NDJSON line ends the connection, while undecodable `session/update` payloads are dropped with one warning per distinct failure (`effect-acp/src/protocol.ts:175-220, 622-647`).
   - Request ids start at 2^30 for the Kotlin SDK (`:274-279`).
   - Updates that arrive before `session/new` returns are buffered, up to 32 (`AcpSessionRuntime.ts:1750-1765`).
   - stderr keeps a redacted 4 KB tail, which is attached to exit errors (`stderr.ts:1-36`).

**Not emitted by any ACP adapter:** `steer.updated`, `command_output.delta`, `background_work.updated` (grep).

---

## 7. Assessment for HarnessHub

### 7.1 Strengths worth copying

1. **Separate the session runtime from the instance, and the instance from the driver kind.** HarnessHub's `HarnessControl` mixes all three into one connection object, which holds "one native conversation and active run per connection" (`HH/src/contracts/control.ts:324-450`). T3's shape gives a clean home for three things HarnessHub already wants:
   - several instances per Harness (two Codex homes);
   - one shared process per instance (Codex, OpenCode 2);
   - per-thread processes (ACP).

   It also slots into HarnessHub's existing `HostPool` and `HostKind` (`HH/src/contracts/native-host.ts:128-148, 270-286`).
2. **Adapters emit complete entities keyed by deterministic ids, and the server upserts them.**
   - Idempotence comes for free.
   - Reconnect is snapshot plus cursor.
   - Out-of-band text deltas stay ephemeral.
   - It removes the delta-reassembly code HarnessHub has today: `ControlEvent` is `text`/`thinking` chunks plus `tool` and `plan` updates with no ids for text (`HH/src/contracts/control.ts:131-161`).

   HarnessHub's hh/1 `ProtocolItem` (`HH/src/contracts/protocol.ts`) already *is* the entity vocabulary. The adapters should emit those items directly.
3. **Server-assigned timeline positions, fixed at first sight** (`TurnItemPositionStore`). HarnessHub has `seq` "fixed when the item is first seen" (`HH/src/contracts/protocol.ts:30-33`). Keep that assignment in the store, not in each driver.
4. **One app thread, many provider threads, delta handoff by the target's watermark.** This is exactly HarnessHub's relay. T3 also has three robustness pieces HarnessHub should copy:
   - persisted delivery state (`pending → injected | inline`) bound to the native thread id;
   - "uncertain delivery ⇒ replace the native thread";
   - `inlineContextLength`, so adapters and logs know where the user's words start.

   HarnessHub's `input_recorded` and `BackendResult.input` (`control.ts:156-174`) are stronger evidence than T3 has. Combine the two.
5. **Native history injection as an optional capability** (`injectHistory`, Codex `thread/inject_items`), with inline text as the fallback. It keeps the user's words clean in the native record.
6. **Precise, typed failure modes**, each with a policy consequence:
   - `ThreadInUse`: never fall back;
   - `SteerDeclined` vs `SteerRunError`, where only declined is safe to resend;
   - `InterruptTimeout`: offer Force stop;
   - `threadDisposition: broken`: replace or re-resume the native thread.
7. **Fork without copying**, as inherited rows plus a synthetic marker plus local rows. And `responseCapability` on runtime requests (`live | message | not_resumable`), which tells the UI after a restart whether a question can still be answered.
8. **A declared capability matrix, negotiated per session.** Policy branches on capability, never on Harness name. This matches HarnessHub's flavor principle (`HH/src/contracts/flavor.ts:4-10`).
9. **Commit before publish, an outbox with per-thread FIFO lanes, and command receipts.** These enforce HarnessHub's rule "事实先持久提交再发布" (commit facts durably before publishing) in one place.
10. **Recorded transcript replay through the real orchestrator, with shared scenarios across drivers.** This is the right shape for HarnessHub's small set of smoke tests: real storage, only the Harness replaced (AGENTS.md). Exact outbound-frame matching catches protocol regressions when a Harness updates.
11. **One MCP server for the Hub's tools, injected per session through the richest entry each Harness has.** The entries are SDK `mcpServers`, Codex thread config, ACP `mcpServers` (with MCP-over-ACP and a stdio bridge as fallbacks), and a Pi extension. The `tool_search` deferral keeps a large tool set cheap. HarnessHub already has the per-session entries (`HubToolsEntry`, `flavor.ts:55-65`). The bridge and the deferral are the missing pieces.
12. **Each top Harness uses its native SDK or server, not ACP.** Claude goes through the Agent SDK `query()` against the user's own `claude` binary. Codex goes through app-server. OpenCode goes through `opencode serve` with SDK v2, one server per instance. ACP is the long-tail path. This answers "every Harness through its richest native interface": HarnessHub drives Claude Code via claude-agent-acp and OpenCode via ACP today (`HH/docs/contracts/harness-adapters.md`).

### 7.2 Complexity and weaknesses to avoid

1. **Size and coupling.**
   - The orchestrator is one 16k-line decider.
   - The Claude adapter alone is 13.8k lines.
   - `ProviderAdapterV2Event` carries contracts entities that hold app-level fields: `AppThread` has pins, snooze, guest share, PR links and more (`orchestrationV2.ts:466-540`).

   Adapters therefore know the app's schema. **HarnessHub should give adapters a narrower entity set**: session, native thread, turn, item, request, subagent, usage. The Hub, not the adapter, should own conversation and app-thread entities. The single exception is a child-thread proposal for native subagents.
2. **Flags that nothing reads**: `enforcement`, `pendingRequestsSurviveRestart`, `supportsMultipleInstances` (§1.3). Declare only what policy consumes. Keep the capability list close to HarnessHub's `HostCapabilities` and `RelayCapabilities`.
3. **The handoff cap and budget formula: do not copy.** The 16k-token default and 64 KB hard cap (`handoffBudget.ts:14-19`) violate HarnessHub's decisions: "不设上限… 给 Harness 推多少的预算也算上限" (no limits; the budget pushed to a Harness counts as a limit too) and "永不因历史太长卡死、省略有账" (never stall on long history; record every omission). HarnessHub should size the push by the target's *reported* window and occupancy, without an absolute cap, and keep T3's omitted-ids ledger and recovery-tool pointer. T3 also drops reasoning and tool detail from handoffs. HarnessHub's relay packet already carries more (commands with "N lines not attached" pointers).
4. **Automatic continuation.** "Continue where you left off" after a server restart (`RestartContinuation.ts`) and after a limit reset (`UsageLimitRecoveryWorker.ts`) resumes runs whose outcome is unknown. That breaks "不自动重跑结果未知的执行" (never automatically re-run an execution whose outcome is unknown). If HarnessHub offers this at all, make it a hint with a button.
5. **Steering by interrupt-and-restart** (`supportsSteeringByInterruptRestart`; ACP base default `true`; `Orchestrator.ts:6315-6474`) re-runs a turn whose outcome is unknown. HarnessHub already rejects this: "Never emulated by stopping the turn and sending again" (`HH/src/contracts/control.ts:433-437`). Keep HarnessHub's queue-after fallback.
6. **Degrading unsupported modes to `approval-required`** (`RuntimePolicy.ts:91-100`) is defensive, and it quietly changes the user's choice. HarnessHub's model is better: the Hub enforces the level through its own answers to permission requests (`flavor.ts` `PermissionWay.policy`, `HUB_POLICIES`). Keep it, and record `decision.by: "policy"`, as HarnessHub does.
7. **Managed installs and T3-owned auth** (managed Codex, the ACP registry downloading agents, Cursor and Antigravity sign-in) conflict with "use the user's own installation, never managed copies". Separately, the decision log records that running T3's Codex wrote a project trust entry into `~/.codex/config.toml` (`HH/docs/decisions/LOG.md`, 2026-11-14, right-sidebar entry). HarnessHub must keep every per-session setting in protocol parameters (thread `config`, `-c` flags, session `_meta`), never in config files.
8. **Write amplification of streaming text.** Every coalesced snapshot is a new event-log row plus a projection upsert. It works because the log is pruned after a day. HarnessHub keeps the full record ("no limits", store v14 items). It should persist the final item plus checkpoints of long streams, and send live text as ephemeral deltas, as T3 already does for command output.
9. **Run completion waiting on a git capture** (`waiting` until `checkpoint.capture`) couples conversation latency to git. HarnessHub's per-Turn checkpoints should be captured *asynchronously* after the turn is marked complete. They are recorded as a separate fact.
10. **Pagination limits on snapshots** (10 turns / 75 items / 500 items / 1 MiB) are fine as page sizes. HarnessHub counts them as "单次传输的页大小" (single-transfer page sizes), which are allowed. They must stay page sizes, not totals.

### 7.3 What T3 lacks for HarnessHub's own ideas

| HarnessHub idea | T3 status | What HarnessHub has to add |
|---|---|---|
| **Hub owns the record; the Harness only executes** | Partial. The app thread is the record, but adapters write app entities directly, including `app_thread.created` and messages. | Adapters emit only native-side facts. The Hub maps them into its own record (sessions, runs, items, `ProtocolItem`). |
| **Relay with a handoff packet** | Yes, but capped (16k), limited to text-like items, and with no evidence that the input was recorded | HarnessHub's `input_recorded` / `BackendResult.input`, the relay packet id, per-binding watermark and clear boundary, uncapped sizing, and the `switch` item (`protocol.ts` `SwitchItem`) |
| **Delegation as a child conversation** | Yes: `delegate_task` → an app-owned subagent child thread with a completion wake, cohorts, `task_status`/`task_cancel`, and worktree isolation. But: "No parent history", and the child is chosen by a model (`target`). | HarnessHub's delegation passes task context (task board, record pointers) and lets the user start a delegation. Copy T3's completion-wake and delivery-state machine (`DelegatedCompletionCohort`, `orchestrationV2.ts:652-683`). |
| **Task board** | None. The closest are `plan.updated` (per-turn todo list) and `/goal` native goals (`orchestrationV2.ts:595-624, 1105-1124`). | Keep HarnessHub's `TaskBoard`/`BoardEntry` (`HH/src/contracts/session.ts:246-256`) as a Hub-side entity, with no adapter involvement except the Hub tools. |
| **Hub tools reading the Hub's record** | Yes: `t3_thread_read`, `t3_thread_search`, `t3_pending_request`, … Recovery pointers are embedded in handoffs. | Already have `hub_turns`/`hub_read_turn`/`hub_search`/`hub_task`/`hub_board`/`hub_remember` (`HH/src/contracts/table.ts:21`). Add MCP-over-ACP plus a stdio bridge where HTTP or env is not honored, and `tool_search` deferral as the set grows. |
| **Five unified levels enforced by the Hub** | Four runtime modes plus plan. Client-boundary enforcement exists only for ACP, and unsupported modes degrade. | Keep the five levels and `PermissionWay {native, session, policy}`. Report `enforcement` *per level* (native, session or policy), so the UI can say how a level is carried out. Record policy decisions on the approval item. |
| **Steer** | `steerTurn` plus `steer.updated` (pending, completed, cancelled), with a declined steer re-dispatched as a message | Already close: `SteerOutcome taken/not_taken` and `UserMessageItem.steered` with five statuses. Adopt T3's distinct error tags and `activeSteeringAcceptsAttachments`. |
| **Per-Turn checkpoints, worktrees** | Git-ref checkpoints per run plus conversation rollback via the adapter; worktree launch strategies | HarnessHub has `refs/harnesshub/checkpoints/…` (LOG 2026-11-14). Add the adapter `rollbackThread` capability, so "edit and resend" can rewind natively where possible (Codex, OpenCode `revert`) instead of always opening a new native session. |
| **Clear = a new native session** | `freshContext` runs: "Starts a new provider conversation; earlier runs stay visible but never reach the provider" (`orchestrationV2.ts:758-759`), via `ensureThread({forceNewNativeThread})` | The same mechanism. HarnessHub's `native.cleared` result (`control.ts:181-187`) becomes `ensureThread({forceNew: true})` plus a clear boundary on the binding. |
| **The user's own installs, configs untouched** | Mostly the user's own CLIs. The exceptions are managed Codex, the registry downloads, and one observed config write. | No managed mode. Probes only. Updates only through the official channel and only on request (memory: discovery-market-consistent). |

---

## 8. Proposal sketch: HarnessHub's adapter contract and event model

The goal is T3's layering and entity-upsert events, scoped to the native side, with HarnessHub's correctness rules built into the types. Names reuse HarnessHub's where they exist. The sketch is TypeScript-like and is not tied to Effect.

### 8.1 Driver, instance, host

```ts
// One per Harness kind (claude-code, codex, opencode, dsh, hermes, openclaw, workbuddy, pi).
interface HarnessDriver<Config> {
  readonly harnessId: string;
  readonly flavor: HarnessFlavor;                 // existing: levels, entries, policy (contracts/flavor.ts)
  readonly configSchema: Codec<Config>;           // binary path override, home dir, env — never a managed install
  discover(): Promise<InstallFacts>;              // official-install detection only (existing catalog)
  create(input: { instanceId: InstanceId; config: Config; env: Env }): Promise<HarnessInstance>;
}

interface HarnessInstance {
  readonly instanceId: InstanceId;                // default instance id = harnessId; more for a second home
  readonly continuationKey: string;               // names the native store: "codex:home:<CODEX_HOME>", "claude:home:<dir>"
  readonly status: Observable<HarnessStatus>;     // installed, version, auth, catalog, usage limits (cached to disk)
  readonly adapter: HarnessAdapter;
  close(): Promise<CleanupEvidence>;
}

interface HarnessAdapter {
  capabilities(): HarnessCapabilities;            // static declaration, refined per session
  planSelection(i: { current: Selection; target: Selection; session: HarnessCapabilities }):
    | { type: "next_turn" } | { type: "apply_live" } | { type: "restart_and_resume" } | { type: "new_with_relay" } | { type: "reject"; reason: string };
  // Host = one native process or server connection (HostPool decides reuse; T3's "shared" vs "per-thread" is HostKind).
  openHost(i: { selection: Selection; levels: ChosenLevels; cwd: string; entry: SessionEntry }): Promise<NativeHostRuntime>;
}
```

**What changes from T3, and why:**
- There is no managed mode and no T3-owned credentials (user rule).
- `continuationKey` stays. It is what lets two instances that share one home continue a native thread.
- `planSelection` adds `apply_live` (Claude `setModel`/`applyFlagSettings`, Codex per-turn parameters) and renames `create_with_handoff` to `new_with_relay`.
- `openHost` replaces `openSession`. HarnessHub already has a host pool with leases (`native-host.ts`), so pooling is the Hub's decision, not the adapter's.

### 8.2 Session runtime (one native host; one or more native threads)

```ts
interface NativeHostRuntime {
  readonly hostId: HostId;
  readonly capabilities: HarnessCapabilities;     // negotiated after initialize
  readonly events: AsyncIterable<NativeEvent>;    // single stream per host; the Hub fans out
  // threads
  ensureThread(i: { binding: NativeBinding | null; forceNew?: boolean; title?: string }): Promise<NativeThread>; // clear = forceNew
  resumeThread(i: { binding: NativeBinding }): Promise<NativeThread>;            // throws ThreadInUse — never fall back
  unloadThread?(i: { thread: NativeThreadRef; archive?: boolean }): Promise<void>;
  readThread?(i: { thread: NativeThreadRef }): Promise<NativeThreadSnapshot>;    // import, verification
  forkThread?(i: { thread: NativeThreadRef; atTurn?: NativeTurnRef }): Promise<NativeThread>;
  rollbackThread?(i: { thread: NativeThreadRef; toTurn: NativeTurnRef | "start" }): Promise<NativeThreadSnapshot>;
  compactThread?(i: { thread: NativeThreadRef }): Promise<void>;
  injectHistory?(i: { thread: NativeThreadRef; packet: RelayPacket }): Promise<"injected" | "unsupported">; // Codex thread/inject_items
  // turns
  startTurn(i: {
    thread: NativeThreadRef; runId: RunId; turnN: number;
    input: { user: string; relay?: RelayPacket; placement: "inline" | "injected" }; // keeps the user's words separate (T3 inlineContextLength)
    attachments: readonly ControlAttachment[];
    selection: Selection; levels: ChosenLevels; appContext?: readonly { key: string; text: string }[];
  }): Promise<void>;                                // results only as events
  steerTurn?(i: { thread: NativeThreadRef; turn: NativeTurnRef; text: string; messageId: MessageId }): Promise<SteerOutcome>; // "taken" | "not_taken"
  interruptTurn(i: { thread: NativeThreadRef; turn: NativeTurnRef }): Promise<void>;     // throws InterruptTimeout
  applySelection?(i: { thread: NativeThreadRef; selection: Selection; levels: ChosenLevels }): Promise<void>;
  respond(i: { requestId: RequestId; answer: ApprovalAnswer | QuestionAnswer }): Promise<void>; // resolves only after the native write
  stopBackground?(i: { thread: NativeThreadRef; taskId: string }): Promise<void>;
  // native catalog and housekeeping (existing HarnessControl methods move here)
  catalog(): Promise<NativeModelCatalog>; extensions?(): Promise<NativeExtensions>;
  nativeSessions?(cwd: string, cursor?: string): Promise<NativeSessionPage>;
  close(): Promise<CleanupEvidence>;
}

type HarnessAdapterError =
  | { tag: "OpenFailed"; requiresSignIn?: true }
  | { tag: "ThreadInUse" }                                   // never start a replacement
  | { tag: "ResumeFailed" }                                  // Hub may open new + relay
  | { tag: "TurnRefused"; reason: "previous_turn_active" | "attachment_unsupported" | "selection_unapplied"; recorded: "not_recorded" }
  | { tag: "SteerUnsupported" } | { tag: "SteerError"; recorded: "unknown" }  // only not_taken may be resent
  | { tag: "InterruptTimeout"; timeoutMs: number }           // UI: Force stop
  | { tag: "RespondFailed" } | { tag: "CompactionUnsupported" } | { tag: "ForkUnavailable" } | { tag: "RollbackUnavailable" }
  | { tag: "ProtocolError"; code: string };                  // fixed codes; detail kept private
```

**What changes from T3, and why:**
- Every error that can follow a send carries `recorded: recorded | not_recorded | unknown`. This builds HarnessHub's delivery evidence (ADR-055 §7.1) into the contract, so "never re-run an unknown outcome" is enforced by type.
- `steerTurn` returns `SteerOutcome` instead of `void`. T3 has to infer the outcome from `SteerDeclined`.
- There is no `supportsSteeringByInterruptRestart` path.
- `startTurn.input` keeps the relay packet structured. The adapter chooses the placement its declaration allows. Today's `TurnText` (`HH/src/contracts/relay.ts`) becomes this field.
- The Hub, not the adapter, decides when a forced new thread happens (clear, broken disposition, failed resume).

### 8.3 Native events: complete snapshots of native-side facts, keyed by native identity

```ts
type NativeRef = { nativeId: string | null; strength: "strong" | "weak" | "none" }; // T3 ProviderRef

type NativeEvent =
  | { type: "host.updated"; status: "starting" | "ready" | "busy" | "stopped" | "error"; capabilities?: HarnessCapabilities; lastError?: string }
  | { type: "thread.updated"; thread: NativeThreadRef; status: "idle" | "active" | "error";
      context?: { used: number; size?: number; autoCompactAt?: number }; rewoundTo?: NativeTurnRef /* native rewind seen */ }
  | { type: "turn.updated"; thread: NativeThreadRef; turn: NativeTurnRef & NativeRef;
      status: "running" | "completed" | "interrupted" | "failed"; model?: string; usage?: TurnUsage }
  // The hh/1 vocabulary IS the item payload: adapters normalize once, into ProtocolItem (contracts/protocol.ts).
  | { type: "item.updated"; turn: NativeTurnRef; item: ProtocolItemDraft & { native: NativeRef } } // full state; Hub assigns id + seq
  | { type: "item.delta"; turn: NativeTurnRef; native: NativeRef; field: "text" | "output"; chunk: string } // ephemeral, live only
  | { type: "request.updated"; turn: NativeTurnRef | null; request: { id: RequestId; native: NativeRef;
      kind: "approval" | "question"; subject: RequestKind; forItem?: NativeRef; options: readonly ApprovalOption[];
      status: "pending" | "resolved" | "expired" | "cancelled"; answerable: "live" | "by_message" | "not_resumable";
      expiresInMs?: number; expiresBy?: "native" } }
  | { type: "subagent.updated"; turn: NativeTurnRef; native: NativeRef; title: string; status: ItemStatus;
      childThread?: NativeThreadRef /* proposes a child conversation; the Hub decides */ }
  | { type: "input.recorded"; turn: NativeTurnRef; relayPacketId?: RelayPacketId } // HH-only: native history took the input
  | { type: "steer.updated"; turn: NativeTurnRef; messageId: MessageId; status: "pending" | "taken" | "not_taken" | "unknown" }
  | { type: "background.updated"; thread: NativeThreadRef; pending: boolean; tasks?: readonly BackgroundTask[] }
  | { type: "turn.terminal"; thread: NativeThreadRef; turn: NativeTurnRef;
      status: "completed" | "interrupted" | "cancelled" | "failed"; failure?: { class: ErrorClass; code?: string; message: string; resetAt?: string };
      input: "recorded" | "not_recorded" | "unknown";             // HH addition (BackendResult.input)
      threadDisposition: "reusable" | "broken" }                   // T3: broken ⇒ Hub re-resumes or replaces
  | { type: "catalog.updated"; catalog: NativeModelCatalog }         // available_commands/config/mode updates
  | { type: "diagnostic"; message: string };                         // private, redacted before leaving the Gateway
```

**Semantics.** These are T3's rules, adjusted for HarnessHub:

1. **Upsert full state** for `host`, `thread`, `turn`, `item`, `request` and `subagent`. The Hub keys each by `(harness, native thread, native ref)` deterministically, so a repeat is a no-op. Native item ids are strong where the protocol has them (Codex, Claude SDK, OpenCode). Otherwise the adapter mints weak ids in a stable band (turn ordinal × N), as T3 does for ACP.
2. **The Hub assigns item `seq` at first sight** (it already does). Adapters never send ordinals.
3. **`item.delta` is ephemeral.** It goes to live subscribers only, and the final text arrives in `item.updated`. This replaces today's `text`/`thinking` chunk events. Persisting the full stream is unnecessary, because `item.updated` with streaming false is the record. This is T3's `command_output.delta` rule extended to assistant text, which fixes the write amplification of §7.2.8.
4. **Order:** within one host, events come in protocol order; across hosts they are unordered. The Hub writes each event in one transaction (record, projection and outbox) and publishes after the commit, behind one publish lane.
5. **Replay.** The Hub's web protocol keeps hh/1 turns and items as the client entities, with snapshot plus `afterSequence` resume, a bounded replay, and a snapshot fallback. These are page sizes, not totals.
6. **Policy answers are Hub events.** When `request.updated` arrives for a level the Hub enforces (`PermissionWay.policy`), the Hub answers it. It records `ApprovalItem.decision {by: "policy", level}`, then calls `respond`. Adapters never auto-answer. That differs from T3's client-boundary inside the ACP adapter. Enforcement lives in one place, and the record says who decided.

### 8.4 Capabilities (only what policy reads)

```ts
interface HarnessCapabilities {
  hosts:   { threadsPerHost: "one" | "many"; liveSelectionChange: boolean; levelChangeNeedsRestart: boolean };
  threads: { nativeIds: "strong" | "weak" | "none"; resume: boolean; fork: "none" | "head" | "any_turn"; rollback: boolean; read: boolean; inject: boolean };
  turns:   { steer: boolean; steerAttachments: boolean; interrupt: boolean; terminal: "strong" | "weak"; reportsInputRecorded: boolean; compaction: "native" | "command" | "none" };
  requests:{ asksFor: AsksFor /* existing */; questions: boolean; nativeRequestIds: boolean; survivesRestart: boolean };
  content: { images: boolean; files: "native" | "path" | "none"; mcpEntry: HubToolsEntry; instructionsEntry: InstructionsEntry };
  levels:  Record<PermissionLevel, "native" | "session" | "policy" | "impossible">; // per level, from the flavor declaration
  usage:   "turn" | "session_total" | "context_only" | "none";
}
```

This merges T3's 11 groups with HarnessHub's existing `HostCapabilities`, `RelayCapabilities` and `FlavorCapabilities`. It drops what no policy reads, and it reports enforcement *per level*.

### 8.5 Hub-side entities the adapter never sees

These are HarnessHub's own:
- `Session` (conversation), `Run` / Turn, `ProtocolItem`
- `NativeBinding` = T3's `ProviderThread` plus HarnessHub's watermark: "第几个原生会话、看到哪里、清空边界、未确认的包、下次是否整份重发" (which native session this is, how far it has seen, the clear boundary, unconfirmed packets, whether the next send is a full resend)
- `RelayDelivery` = T3's `ContextHandoff.delivery` {nativeThreadId, status pending|injected|inline, itemIds, omittedItemIds}
- `Delegation` (child Session plus completion delivery state)
- `TaskBoard`, `Checkpoint`

**Relay flow, as T3 does it, with HarnessHub's rules:**
1. Pick the target binding, the native thread for the target `continuationKey`.
2. Covered turns = those after the binding's watermark.
3. If the binding has no native thread, deliver the whole conversation (full).
4. Size the packet by the target's reported window and occupancy, with no absolute cap. Omitted items are listed with `hub_read_turn` pointers.
5. Persist `pending`, then `injectHistory` (→ `injected`) or inline (→ `inline` once `input.recorded` arrives).
6. If a `pending` delivery to the same native thread exists, open a new native thread.

### 8.6 Transport per Harness

This is "richest native interface", taking T3 as evidence where it covers the Harness. The sibling reports in this folder (`claude.md`, `codex.md`, `opencode.md`, `dsh-workbuddy.md`, `openclaw-hermes.md`) are the per-Harness authority.

| Harness | Today (HH) | T3's choice | Suggested |
|---|---|---|---|
| Claude Code | claude-agent-acp (ACP) | Agent SDK `query()` with `pathToClaudeCodeExecutable` = the user's `claude` (`ClaudeAdapterV2.ts:2121-2123`); per-thread process; `setModel` live (`:1597`); `forkSession` (`:43, 1744`); rollback by resuming at a message, `resumeSessionAt` (`:1010, 13555-13570`) | Agent SDK (or its stream-json control protocol) against the user's binary. This gains the permission callback, hooks, live model and effort changes, rewind by `resumeSessionAt`, and subagent lifecycle. |
| Codex | app-server | app-server, one per instance: `thread/inject_items` (`CodexAdapterV2.ts:1893`), `thread/compact/start` (`:7759`), `turn/steer` (`:7870`), `thread/read` (`:8432`), `thread/revert` for rollback (`:8463-8494`), `thread/fork` (`:8543`), `thread/archive`/`unsubscribe` (`:7898-7905`) | Keep app-server. Move to one host per instance (`threadsPerHost: many`), and add `injectHistory` and `rollbackThread`. |
| OpenCode | ACP | `opencode serve` HTTP + SSE (SDK v2), one server per instance, ref-counted | `opencode serve`, matching T3 (revert, permissions, per-directory models). |
| Pi | pi-rpc | Pi RPC plus an MCP extension | Keep. Add the extension-based tool entry if env is not honored. |
| dsh, Hermes, OpenClaw, WorkBuddy | ACP / gateway / bridge | not covered by T3 | Use the shared ACP runtime ideas (§6): client-boundary policy moved to the Hub, MCP-over-ACP plus a stdio bridge, replay-quiet load completion, replacement runtimes, and weak-id bands. |

### 8.7 Testing (fits "a few smoke tests, real storage, only the Harness replaced")

- **Record once per Harness version, replay against the real Gateway.** Record native transcripts with T3's format (`transcript_start`, `expect_outbound`, `emit_inbound`, `runtime_exit`, with placeholders for workspace and home), and replay them against the real Gateway with an in-memory or temporary store. Two or three shared scenarios cover it: simple turn, approval, steer.
- **When a Harness upgrades,** a mismatch on an outbound frame is the signal to re-record. This replaces the probe gates the relay work has already been reducing.

---

## Sub-reads and what could not be confirmed

- **Delegated reads.** The ACP runtime, the process lifecycle, the cross-cutting features and the event persistence were read by four read-only subagents. I spot-checked the citations I rely on, and they matched:
  - `ProviderEventIngestor.ts:645-655`
  - `EventSink.ts:300-330`
  - `ProviderSessionManager.ts:62-68, 2646-2665`
  - `Orchestrator.ts:1559-1578`
  - Codex and Claude policy mapping
  - capabilities
  - handoff delivery
  - provider switch
- **Not confirmed:**
  - whether anything reads `runtimePolicy.enforcement`, `pendingRequestsSurviveRestart` or `supportsMultipleInstances` (none found);
  - whether a rebuilt instance closes its live sessions;
  - whether per-subagent checkpoint scopes are created;
  - a Codex sandbox grant for `attachmentsDir`;
  - a production writer for the `canonical` log channel;
  - exact Claude Agent SDK version compatibility with the user's installed `claude`.
- **Line numbers** marked `~` are within a few lines.
