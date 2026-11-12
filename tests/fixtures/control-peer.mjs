import { createInterface } from "node:readline";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A native session of this fixture is named by FIXTURE_SESSION_ID (an ACP session) and FIXTURE_THREAD_ID (a Codex thread) when a test runs several conversations against it: one
 * native session has one holder in the store. FIXTURE_UNIQUE_SESSIONS=1 gives each process names of its own: for a test whose conversations each start the program and none of
 * them resumes a session in another process (a Turn resumed by a new process must find the name it left).
 */
const own = process.env.FIXTURE_UNIQUE_SESSIONS === "1" ? "-" + process.pid : "";
const SESSION = process.env.FIXTURE_SESSION_ID ?? "session-fixture" + own, THREAD = process.env.FIXTURE_THREAD_ID ?? "thread-fixture" + own;
const protocol = process.argv[2], scenario = process.argv[3] ?? "basic";
if (process.env.FIXTURE_PID) writeFileSync(process.env.FIXTURE_PID, String(process.pid));
if (scenario === "resist") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
if (scenario === "descendant") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  if (process.env.FIXTURE_CHILD_PID) writeFileSync(process.env.FIXTURE_CHILD_PID, String(child.pid));
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => { child.once("exit", () => process.exit(0)); child.kill("SIGTERM"); });
}
// A background task in this program's process group (FIXTURE_LINGER): the program exits when its input closes, and the task
// outlives it, as a shell job started by an agent does.
if (process.env.FIXTURE_LINGER) {
  const lingering = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  lingering.unref();
  if (process.env.FIXTURE_CHILD_PID) writeFileSync(process.env.FIXTURE_CHILD_PID, String(lingering.pid));
}
// A program that keeps running after its input closes (FIXTURE_HOLD), until it is signalled.
if (process.env.FIXTURE_HOLD) setInterval(() => {}, 1000);
// A background task that left this program's process group (FIXTURE_OUTSIDER), as an agent's detached job does: ending the
// group does not reach it.
if (process.env.FIXTURE_OUTSIDER) {
  const outsider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  outsider.unref();
  // One line per program that started one, so a test can end every one of them.
  appendFileSync(process.env.FIXTURE_OUTSIDER, outsider.pid + "\n");
}
/**
 * Refusals of Hermes's gateway viewer (v0.22.3 and later), which the ACP SDK sends as -32603 with the cause only in
 * data.details: FIXTURE_LOAD_ERROR for session/load, FIXTURE_SESSION_ERROR for session/new, FIXTURE_PROMPT_ERROR for
 * session/prompt. "gateway-private" stands in for a cause that carries a path and a credential-like value.
 */
const HERMES_REFUSALS = { "not_found": "not_found: session-fixture", "gateway-starting": "Gateway starting: deadline", "gateway-draining": "Gateway draining: update_paused",
  "gateway-private": "Gateway could not start: /home/private-user/.hermes/gateway.sock: fetch failed (private-synthetic-key)",
  "unknown-execution": "unknown_execution: do not resend accepted input; run /discard adm-7f3a to drop it" };
function hermesRefusal(id, cause) { emit({ id, error: { code: -32603, message: "Internal error", data: { details: HERMES_REFUSALS[cause] ?? cause } } }); }
/** Hermes's approval options: 0.12's three, or (FIXTURE_PERMISSION_OPTIONS=five) the gateway viewer's five (acp_adapter/permissions.py). */
function hermesOptions() {
  return process.env.FIXTURE_PERMISSION_OPTIONS === "five"
    ? [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "allow_session", kind: "allow_always", name: "Allow for session" }, { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
      { optionId: "deny", kind: "reject_once", name: "Deny" }, { optionId: "deny_always", kind: "reject_always", name: "Deny always" }]
    : [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "allow_always", kind: "allow_always", name: "Allow always" }, { optionId: "deny", kind: "reject_once", name: "Deny" }];
}
/** A Hermes terminal call that its approval gate refused, reported as Hermes 0.12 reports it: completed, with failure text. */
function hermesBlocked(sessionId, id = "terminal-blocked") {
  notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: id, title: "terminal: rm -r attention-check", kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: "$ rm -r attention-check" } }] } });
  notification("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: id, kind: "execute", status: "completed", content: [{ type: "content", content: { type: "text", text: "terminal failed: BLOCKED: User denied. Do NOT retry." } }] } });
}
const lines = createInterface({ input: process.stdin });
// FIXTURE_DEAF_MS: a program that takes in no input for this long at first (a busy one, reading late).
if (Number(process.env.FIXTURE_DEAF_MS ?? 0) > 0) { lines.pause(); setTimeout(() => lines.resume(), Number(process.env.FIXTURE_DEAF_MS)); }
let promptId = null, turn = 0, initialized = false, pendingPermission = false;
// The workspace of the session Hermes opened last (session/new names it), where STEP_APPROVAL waits for its go-ahead.
let sessionCwd = null;
// STEP_APPROVAL_FAILS: once its step is refused, the Turn fails (Hermes answers the prompt with an error) instead of ending.
let stepFails = false;
let resumedThread = false;
// The Codex `hooks` scenario: the turn that has been reported (turn/started) and the one that has ended (completed or interrupted).
let hooksStarted = 0, hooksEnded = 0;
// Codex app-server gates experimental methods and fields per connection on initialize.capabilities.experimentalApi.
let experimental = false;
let selectedModel = "native-model-a", thinking = "low", fast = "off";
function nativeConfiguration() { return [
 { id:"native-model",category:"model",type:"select",currentValue:selectedModel,options:[{value:"native-model-a",name:"Native A"},{value:"native-model-b",name:"Native B"}] },
 { id:"native-thinking",name:"Native effort",category:"thought_level",type:"select",currentValue:thinking,options:[{value:"low",name:"Low"},{value:"max",name:"Max"}] },
 { id:"native-fast",name:"Native fast",type:"select",currentValue:fast,options:[{value:"off",name:"Off"},{value:"on",name:"On"}] }
]; }

// Hermes lists `<provider>:<model>` choices from its curated catalogue (unstable session model state).
function hermesModels() { return { currentModelId: "deepseek:deepseek-v4-pro", availableModels: [{ modelId: "deepseek:deepseek-v4-pro", name: "deepseek-v4-pro" }, { modelId: "deepseek:deepseek-v4-flash", name: "deepseek-v4-flash" }] }; }
// The OpenClaw bridge's session presentation: six select options and the same thinking levels again as modes.
// FIXTURE_OPENCLAW_MODES=distinct stands in for a bridge whose modes are not its thinking levels: as many modes, one of
// them ("plan", the current one) no thinking level.
const openclawLevels = ["off", "minimal", "low", "medium", "high", "adaptive"].map(value => ({ value, name: value }));
const openclawModes = process.env.FIXTURE_OPENCLAW_MODES === "distinct"
  ? { currentModeId: "plan", availableModes: [...openclawLevels.slice(0, -1), { value: "plan", name: "Plan" }].map(row => ({ id: row.value, name: row.name })) }
  : { currentModeId: "adaptive", availableModes: openclawLevels.map(row => ({ id: row.value, name: row.name })) };
function openclawPresentation() { return { configOptions: [
  { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "adaptive", options: openclawLevels },
  ...[["fast_mode", ["off", "on"]], ["verbose_level", ["off", "on", "full"]], ["reasoning_level", ["off", "on", "stream"]], ["response_usage", ["off", "tokens", "full"]], ["elevated_level", ["off", "on", "ask", "full"]]]
    .map(([id, values]) => ({ id, name: id, type: "select", currentValue: "off", options: values.map(value => ({ value, name: value })) })),
], modes: openclawModes }; }
/**
 * The identity the agent reports in initialize: claude-agent-acp 0.89.1 for claude-auth (where its sign-in report was first
 * read; the identity is only the fixture's) and 0.94.0 for claude; OpenCode for opencode-compact, with the version from
 * FIXTURE_AGENT_VERSION (default 1.18.35; "absent" omits agentInfo); otherwise Hermes when FIXTURE_AGENT_VERSION is set,
 * and the plain fixture when it is not.
 */
function agentInfo() {
  if (scenario === "claude-auth") return { name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.89.1" };
  if (scenario === "claude") return { name: "@agentclientprotocol/claude-agent-acp", title: "Claude Agent", version: "0.94.0" };
  if (scenario === "opencode-compact") return process.env.FIXTURE_AGENT_VERSION === "absent" ? undefined : { name: "OpenCode", version: process.env.FIXTURE_AGENT_VERSION ?? "1.18.35" };
  return process.env.FIXTURE_AGENT_VERSION ? { name: "hermes-agent", version: process.env.FIXTURE_AGENT_VERSION } : { name: "fixture", version: "1.0" };
}
/**
 * The params of claude-agent-acp's `_auth/status_update` for one kind, shaped like auth-status.js in 0.89.1 builds them.
 * "omitted" leaves the kind out, and "malformed" sends a string instead of an object. The label, detail and account fields
 * carry "private-" markers, which a client must never keep or show.
 */
function claudeAuthStatus(kind = "none") {
  if (kind === "malformed") return { authStatus: "private-auth-label" };
  return { authStatus: { ...(kind === "omitted" ? {} : { kind }), label: "private-auth-label " + kind,
    ...(kind === "account" ? { account: { plan: "max", email: "private-account@example.invalid" } } : kind === "api_key" || kind === "gateway" ? { detail: "private-auth-detail" } : {}) } };
}
function emit(message) {
  const envelope = protocol === "acp-v1" ? { jsonrpc: "2.0", ...message } : message;
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  if (scenario === "split") {
    for (let i = 0; i < bytes.length; i += 3) process.stdout.write(bytes.subarray(i, i + 3));
  } else process.stdout.write(bytes);
}
function answer(id, result) { emit({ id, result }); }
function emitAtomicBatch(messages) {
  // Submit both negative frames in one small write, rather than allowing a
  // legitimate owner to begin closing between two separate writes.
  process.stdout.write(messages.map(message => JSON.stringify(protocol === "acp-v1" ? { jsonrpc: "2.0", ...message } : message) + "\n").join(""));
}
function notification(method, params) { emit({ method, params }); }
/**
 * claude-agent-acp's withdrawal of a request it still has open ($/cancel_request): 300 ms after asking, it withdraws that
 * request and then one that nothing waits for, and ends the turn with its reply. An answer that came anyway is ignored.
 */
function withdrawLater(requestId) {
  setTimeout(() => {
    notification("$/cancel_request", { requestId });
    notification("$/cancel_request", { requestId: "never-asked" });
    setTimeout(() => { acpOutput(); finish(); }, 100);
  }, 300);
}
function acpOutput(sessionId = SESSION) {
  if(scenario==="native-experience") {
    notification("session/update",{sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"Observed fixture thinking"}}});
    notification("session/update",{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"native-tool",title:"Read fixture",status:"in_progress"}});
    notification("session/update",{sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:"native-tool",status:"completed"}});
  }
  if (scenario === "chunks") {
    for (const value of ["first ", "second"]) notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } });
    return;
  }
  notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好 fixture" } } });
}
function codexOutput(turnId = `turn-${turn}`, threadId = THREAD) {
  if (scenario === "chunks") {
    for (const value of ["first ", "second"]) notification("item/agentMessage/delta", { threadId, turnId, itemId: `message-${turn}`, delta: value });
    return;
  }
  notification("item/agentMessage/delta", { threadId, turnId, itemId: `message-${turn}`, delta: "你好 fixture" });
}
function finish(cancelled = false) {
  if (protocol === "acp-v1") answer(promptId, { stopReason: cancelled ? "cancelled" : (scenario === "refusal" ? "refusal" : "end_turn") });
  else notification("turn/completed", { threadId: THREAD, turn: { id: `turn-${turn}`, status: cancelled ? "interrupted" : (scenario === "failed" ? "failed" : "completed") } });
}
lines.on("line", line => {
  const message = JSON.parse(line);
  if (process.env.FIXTURE_TRACE) appendFileSync(process.env.FIXTURE_TRACE, `${JSON.stringify(message)}\n`);
  if (message.method === "initialize") {
    if (scenario === "gateway-auth-failure") { process.stderr.write("unauthorized: gateway token missing\nprivate synthetic credential: never-public\n"); process.exit(1); }
    if (scenario === "invalid-native-config") { process.stderr.write("Harness config is invalid\nprivate synthetic credential: never-public\nUnrecognized key\n"); process.exit(1); }
    if (scenario === "timeout" || scenario === "resist") return;
    if (scenario === "bad-json") { process.stdout.write("not-json\n"); return; }
    if (scenario === "bad-utf8") { process.stdout.write(Buffer.from([0xff, 0x0a])); return; }
    if (scenario === "huge") { process.stdout.write(`${" ".repeat(100000)}\n`); return; }
    // One answer far larger than a chunk of the pipe (FIXTURE_BIG_BYTES, 64 MiB by default), written in pieces: the client assembles a big frame from many chunks.
    if (scenario === "bigframe") {
      const total = Number(process.env.FIXTURE_BIG_BYTES ?? 64 * 1024 * 1024), head = `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"text":"`, piece = "x".repeat(64 * 1024);
      let written = 0;
      process.stdout.write(head);
      function more() {
        while (written < total) { const size = Math.min(piece.length, total - written); written += size; if (!process.stdout.write(size === piece.length ? piece : piece.slice(0, size))) { process.stdout.once("drain", more); return; } }
        process.stdout.write('"}}\n');
      }
      more();
      return;
    }
    if (scenario === "half") { process.stdout.write('{"id":'); process.exit(0); }
    if (scenario === "orphan") {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
      if (process.env.FIXTURE_CHILD_PID) writeFileSync(process.env.FIXTURE_CHILD_PID, String(child.pid));
      process.exit(0);
    }
    if (scenario === "unknown-response") { answer(999999, {}); return; }
    if (scenario === "invalid-response") { emit({ id: message.id, result: {}, error: { code: -1, message: "wrong" } }); return; }
    if (scenario === "remote-error") { emit({ id: message.id, error: { code: -32001, message: "test remote error" } }); return; }
    // An ACP SDK peer that explains an internal error only in its error data: FIXTURE_ERROR_DATA as JSON (so it can hold
    // control characters), or data without details.
    if (scenario === "remote-detail") { emit({ id: message.id, error: { code: -32603, message: "Internal error", data: JSON.parse(process.env.FIXTURE_ERROR_DATA ?? '{"reason":"serverShuttingDown"}') } }); return; }
    if (scenario === "stderr") process.stderr.write("diagnostic".repeat(100000));
    const result = protocol === "acp-v1"
      ? { protocolVersion: scenario === "version" ? 2 : 1, agentCapabilities: { loadSession: ["native-resume", "resume-fails", "resume-wrong-identity", "load-trailing-replay", "native-config", "openclaw-settings", "session-list", "hermes", "claude"].includes(scenario), ...(scenario === "hermes" ? { sessionCapabilities: { resume: {}, list: {}, fork: {} }, promptCapabilities: { image: true } } : {}),
        ...(scenario === "claude" ? { sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }, promptCapabilities: { image: true, embeddedContext: true }, _meta: { claudeCode: { promptQueueing: true } } } : {}), ...(scenario === "session-list" ? { sessionCapabilities: { list: {} } } : {}), ...(scenario === "attachments" || scenario === "openclaw-settings" ? { promptCapabilities: { image: true, audio: true, embeddedContext: true } } : {}), ...(scenario === "forkable" ? { sessionCapabilities: { fork: {} } } : {}), ...(scenario === "claude-auth" ? { _meta: { claudeCode: { promptQueueing: true }, authStatus: {} } } : {}) }, ...(process.env.FIXTURE_AUTH === "none" ? {} : { authMethods: process.env.FIXTURE_AUTH === "terminal" ? [{ id: "hermes-setup", name: "Set up Hermes", type: "terminal", args: ["--setup"] }] : process.env.FIXTURE_AUTH === "invalid" ? { id: "fixture-login" } : [{ id: "fixture-login", name: "Fixture Login" }] }), agentInfo: agentInfo() }
      : { userAgent: scenario === "plan-mode" ? "codex_cli_rs/0.162.1 (fixture)" : scenario === "plan-old" ? "codex_cli_rs/0.161.0 (fixture)" : "fixture-codex/1.0", codexHome: process.cwd(), platformFamily: "unix", platformOs: process.platform };
    if (protocol === "codex-app-server") experimental = message.params?.capabilities?.experimentalApi === true;
    // claude-agent-acp pushes its sign-in report after the initialize response. FIXTURE_AUTH_AT=initialize sends the report
    // in the same write, so the client reads both from one chunk.
    // FIXTURE_INITIALIZE_DELAY_MS: a program that is slow to start answers its handshake late.
    if (Number(process.env.FIXTURE_INITIALIZE_DELAY_MS ?? 0) > 0) { setTimeout(() => answer(message.id, result), Number(process.env.FIXTURE_INITIALIZE_DELAY_MS)); return; }
    if (scenario === "claude-auth" && process.env.FIXTURE_AUTH_AT === "initialize") emitAtomicBatch([{ id: message.id, result }, { method: "_auth/status_update", params: claudeAuthStatus(process.env.FIXTURE_AUTH_KIND) }]);
    else answer(message.id, result);
    if (scenario === "flood") {
      // FIXTURE_FLOOD_FRAMES frames of FIXTURE_FLOOD_BYTES each (10,000 of 2 KiB by default).
      let remaining = Number(process.env.FIXTURE_FLOOD_FRAMES ?? 10000);
      const frame = `${JSON.stringify({ jsonrpc: "2.0", method: "fixture/flood", params: { text: "x".repeat(Number(process.env.FIXTURE_FLOOD_BYTES ?? 2048)) } })}\n`;
      function drain() {
        while (remaining-- > 0) if (!process.stdout.write(frame)) { process.stdout.once("drain", drain); return; }
      }
      drain();
    }
    if (scenario === "duplicate-response") answer(message.id, result);
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method === "config/read") { answer(message.id, { config: { model: "native-model-a", privateCredential: "synthetic-never-public", ...(["permissions-settings", "ignore-permissions"].includes(scenario) ? { approval_policy: "never", sandbox_mode: "danger-full-access" } : {}) } }); return; }
  if (message.method === "collaborationMode/list") {
    // A Codex without collaboration modes, whatever version it states.
    if (scenario === "collab-missing") { emit({ id: message.id, error: { code: -32601, message: "Method not found" } }); return; }
    if (!experimental) { emit({ id: message.id, error: { code: -32600, message: "collaborationMode/list requires experimentalApi capability" } }); return; }
    // The user's plan-mode effort (plan_mode_reasoning_effort) comes with the plan preset.
    answer(message.id, { data: [{ name: "Plan", mode: "plan", model: null, reasoning_effort: "high" }, { name: "Default", mode: "default", model: null, reasoning_effort: null }] }); return;
  }
  if (message.method === "account/read") { answer(message.id, { account: { type: "chatgpt", email: "private-account@example.invalid" }, requiresOpenaiAuth: true }); return; }
  if (message.method === "skills/list" && scenario === "no-skills") { emit({ id: message.id, error: { code: -32601, message: "Method not found" } }); return; }
  if (message.method === "skills/list") {
    const skills = scenario === "skills" ? [{ name: "review-helper", description: "Reviews code\nin depth", path: "/skills/review-helper/SKILL.md", scope: "user", enabled: true }, { name: "dormant", description: "Disabled skill", path: "/skills/dormant/SKILL.md", scope: "repo", enabled: false }, { name: "bad name", description: "", path: "relative", enabled: true }] : [];
    answer(message.id, { data: [{ cwd: message.params.cwds?.[0] ?? "/", skills, errors: [] }] }); return;
  }
  if (message.method === "mcpServerStatus/list") {
    answer(message.id, { data: scenario === "skills" ? [{ name: "docs", runtimeStatus: null, authStatus: "unsupported", tools: { search: {}, read: {} }, toolsError: null }, { name: "remote", runtimeStatus: "failed", authStatus: "notLoggedIn", tools: {}, toolsError: "login required" }] : [], nextCursor: null }); return;
  }
  if (message.method === "plugin/installed") {
    answer(message.id, { marketplaces: scenario === "skills" ? [{ name: "openai-curated", plugins: [{ name: "github", installed: true, enabled: true, localVersion: "1.2.0" }, { name: "not-here", installed: false, enabled: false }] }] : [], marketplaceLoadErrors: [] }); return;
  }
  if (message.method === "model/list") { answer(message.id, { data: ["native-model-a", "native-model-b"].map(model => ({ model, displayName: model, ...(scenario === "attachments" ? { inputModalities: model === "native-model-a" ? ["text", "image", "audio"] : ["text"] } : {}) })), nextCursor: null }); return; }
  if (scenario === "hermes" && message.method === "session/new") {
    if (process.env.FIXTURE_SESSION_ERROR) { hermesRefusal(message.id, process.env.FIXTURE_SESSION_ERROR); return; }
    if (typeof message.params?.cwd === "string") sessionCwd = message.params.cwd;
    answer(message.id, { sessionId: SESSION, models: hermesModels() }); return;
  }
  // An ACP agent that needs its own sign-in before it opens a session (ACP auth_required).
  if (scenario === "auth-session" && message.method === "session/new") { emit({ id: message.id, error: { code: -32000, message: "Authentication required" } }); return; }
  // claude-agent-acp sends the session response, then its sign-in report (FIXTURE_AUTH_KIND, unless the report already came
  // with initialize), then its commands. A catalog read that waits for the commands has therefore read the report.
  if (scenario === "claude-auth" && message.method === "session/new") {
    answer(message.id, { sessionId: SESSION });
    if (process.env.FIXTURE_AUTH_AT !== "initialize") notification("_auth/status_update", claudeAuthStatus(process.env.FIXTURE_AUTH_KIND));
    notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Clear conversation history but keep a summary in context" }] } });
    return;
  }
  // claude-agent-acp 0.94.0 answers session/new and then lists its commands, its own /remote-control among them (0.93.0 and
  // later); it lists and continues the sessions of the workspace, and resumes one without replaying it.
  if (scenario === "claude" && message.method === "session/new") {
    answer(message.id, { sessionId: SESSION });
    notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Clear conversation history but keep a summary in context" }, { name: "remote-control", description: "Connect this session to claude.ai" }] } });
    return;
  }
  if (scenario === "claude" && message.method === "session/list") { answer(message.id, { sessions: [{ sessionId: SESSION, cwd: message.params.cwd, title: "Claude work", updatedAt: "2026-10-22T10:00:00Z" }] }); return; }
  if (scenario === "claude" && message.method === "session/resume") { answer(message.id, {}); return; }
  // OpenCode 1.16–1.19 sends the session response and then its commands (setTimeout 0). `compact` is not among them, unless
  // FIXTURE_COMPACT_LISTED stands in for a version that lists it.
  if (scenario === "opencode-compact" && message.method === "session/new") {
    answer(message.id, { sessionId: SESSION });
    notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "create/update AGENTS.md" }, { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
      ...(process.env.FIXTURE_COMPACT_LISTED ? [{ name: "compact", description: "OpenCode's own compact" }] : [])] } });
    return;
  }
  if (message.method === "session/new" && scenario === "attachments") {
    answer(message.id, { sessionId: SESSION, configOptions: [{ id: "model", category: "model", type: "select", currentValue: "native/model-a", options: [{ value: "native/model-a", name: "Model A" }, { value: "native/model-b", name: "Model B" }] }] }); return;
  }
  if (message.method === "session/set_config_option" && scenario === "attachments") {
    answer(message.id, { configOptions: [{ id: "model", category: "model", type: "select", currentValue: message.params.value, options: [{ value: "native/model-a", name: "Model A" }, { value: "native/model-b", name: "Model B" }] }] }); return;
  }
  if (message.method === "session/new" && (scenario === "native-experience" || scenario === "native-config")) {
    notification("session/update",{sessionId:SESSION,update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"native-help",description:"Native fixture help"},...(scenario==="native-config"?[{name:"native-fast",description:"Turns fast mode on or off"}]:[])]}});
    answer(message.id,{sessionId:SESSION,configOptions:nativeConfiguration()});return;
  }
  // An agent's own session catalogue (two pages) and a load that replays the history before answering.
  if (scenario === "session-list" && message.method === "session/list") {
    const here = message.params.cwd;
    if (message.params.cursor === "p2") { answer(message.id, { sessions: [{ sessionId: "native-b", cwd: here, title: null, updatedAt: "2026-10-01T09:00:00Z" }], nextCursor: null }); return; }
    answer(message.id, { sessions: [{ sessionId: "native-a", cwd: here, title: "Earlier  work", updatedAt: "2026-10-01T10:00:00Z" }, { sessionId: "native-x", cwd: "/elsewhere", title: "Elsewhere" }], nextCursor: "p2" }); return;
  }
  if (scenario === "session-list" && message.method === "session/load") {
    const sessionId = message.params.sessionId, chunk = (kind, text) => notification("session/update", { sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } });
    chunk("user_message_chunk", "first "); chunk("user_message_chunk", "question"); chunk("agent_thought_chunk", "thinking is not history"); chunk("agent_message_chunk", "first answer");
    notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "old tool", status: "completed" } });
    chunk("user_message_chunk", "second question"); chunk("agent_message_chunk", "second answer");
    answer(message.id, {}); return;
  }
  // Like many agents, the mode change is acknowledged without echoing a current_mode_update.
  if (message.method === "session/set_mode" && scenario === "openclaw-settings") { answer(message.id, {}); return; }
  if ((message.method === "session/new" || message.method === "session/load") && scenario === "openclaw-settings") {
    answer(message.id, { ...(message.method === "session/new" ? { sessionId: SESSION } : {}), ...openclawPresentation() }); return;
  }
  // A restored native-config session reports its options; a new process starts from the defaults until the client applies them.
  if (message.method === "session/load" && scenario === "native-config") {
    notification("session/update",{sessionId:message.params.sessionId,update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"native-help",description:"Native fixture help"},{name:"native-fast",description:"Turns fast mode on or off"}]}});
    answer(message.id,{configOptions:nativeConfiguration()});return;
  }
  if (message.method === "session/set_config_option" && (scenario === "native-experience" || scenario === "native-config")) { const p=message.params;if(p.configId==="native-model")selectedModel=p.value;else if(p.configId==="native-thinking")thinking=p.value;else if(p.configId==="native-fast")fast=p.value;answer(message.id,{configOptions:nativeConfiguration()});return; }
  if (message.method === "session/new") {
    if (scenario === "unsupported-client") { emit({ id: message.id, error: { code: -32000, message: "This client is no longer supported for Gemini Code Assist. private-synthetic-key" } }); return; }
    if (["opening-metadata", "opening-wrong-identity", "opening-flood", "opening-text"].includes(scenario)) {
      const sessionId = scenario === "opening-wrong-identity" ? "wrong-session" : SESSION;
      for (let i = 0; i < (scenario === "opening-flood" ? 129 : 1); i++) notification("session/update", { sessionId, update: { sessionUpdate: "session_info_update", title: "new session" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
      if (scenario === "opening-text") acpOutput();
    }
    // Real agents announce their commands just after the session/new response.
    if (scenario === "late-commands") setTimeout(() => notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "late", description: "arrives after session creation" }] } }), 200);
    if (scenario === "unlisted-model") { answer(message.id, { sessionId: SESSION, configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: "resumed-unlisted", options: [{ value: "native-model-a", name: "Native A" }] }] }); return; }
    answer(message.id, { sessionId: SESSION, ...(scenario === "native-models" ? { configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "native-model-a", name: "Native A" }, { value: "native-model-b", name: "Native B" }] }] } : {}),
    ...(["legacy-configured-model", "duplicate-models"].includes(scenario) ? { models: { currentModelId: "configured-model", availableModels: [{ modelId: "suggested-model", name: "Suggested" }, ...(scenario === "duplicate-models" ? [{ modelId: "suggested-model", name: "Duplicate" }] : [])] } } : {}) }); return; }
  if (scenario === "hermes" && message.method === "session/load") {
    if (process.env.FIXTURE_LOAD_ERROR) { hermesRefusal(message.id, process.env.FIXTURE_LOAD_ERROR); return; }
    // Hermes 0.12: an identity it does not have answers null; a known one restores slowly and replays history after the response.
    if (message.params.sessionId === "missing-session") { answer(message.id, null); return; }
    setTimeout(() => {
      answer(message.id, { models: hermesModels() });
      const replay = (kind, text) => notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } });
      setTimeout(() => replay("user_message_chunk", "earlier question"), 20); setTimeout(() => replay("agent_message_chunk", "old replayed answer"), 60);
    }, 300);
    return;
  }
  if (scenario === "hermes" && message.method === "session/list") { answer(message.id, { sessions: [{ sessionId: SESSION, cwd: message.params.cwd, title: "Hermes work", updatedAt: "2026-10-11T10:00:00Z" }] }); return; }
  // Hermes starts a new session for an unknown identity without saying so; a client must not rely on it.
  // Hermes 0.12 answers resume with nothing; FIXTURE_RESUME_MODELS stands in for an agent that reports its models there too.
  if (scenario === "hermes" && message.method === "session/resume") { answer(message.id, process.env.FIXTURE_RESUME_MODELS ? { models: hermesModels() } : {}); return; }
  if (message.method === "session/load" && scenario === "load-trailing-replay") {
    // Gemini-style: the load response returns first and history keeps streaming afterwards.
    answer(message.id, {});
    for (const delay of [30, 90]) setTimeout(() => notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old replayed answer " } } }), delay);
    return;
  }
  if (message.method === "session/load") {
    if (scenario === "resume-fails") { emit({ id: message.id, error: { code: -32001, message: "Original native state unavailable" } }); return; }
    const sessionId = scenario === "resume-wrong-identity" ? "another-session" : message.params.sessionId;
    notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "previous native reply" } } });
    notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Native history tool", status: "completed" } });
    answer(message.id, {}); return;
  }
  if (message.method === "session/set_model") { selectedModel = message.params.modelId; answer(message.id, {}); return; }
  if (message.method === "session/set_config_option") { selectedModel = message.params.value; answer(message.id, { configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "native-model-a", name: "Native A" }, { value: "native-model-b", name: "Native B" }] }] }); return; }
  // Codex thread catalogue: two pages of this workspace's threads plus ones the client must not continue.
  if (scenario === "threads" && message.method === "thread/list") {
    const here = process.cwd(), base = { name: null, ephemeral: false, modelProvider: "openai", cliVersion: "fixture", status: { type: "notLoaded" }, turns: [] };
    if (message.params.cursor === "page-2") { answer(message.id, { data: [{ ...base, id: "thread-older", preview: "older\nquestion", cwd: here, createdAt: 1700000000, updatedAt: 1700000100, source: { subAgent: "review" } }], nextCursor: null }); return; }
    answer(message.id, { data: [{ ...base, id: "thread-recent", name: "Recent work", preview: "ignored preview", cwd: here, createdAt: 1700000200, updatedAt: 1700000300, source: "cli" },
      { ...base, id: "thread-elsewhere", preview: "elsewhere", cwd: "/elsewhere", createdAt: 1, updatedAt: 2, source: "cli" }, { ...base, id: "thread-ephemeral", preview: "temporary", cwd: here, createdAt: 1, updatedAt: 2, source: "exec", ephemeral: true }], nextCursor: "page-2" }); return;
  }
  if (scenario === "threads" && message.method === "thread/read") {
    const id = message.params.threadId;
    answer(message.id, { thread: { id, name: id === "thread-recent" ? "Recent work" : null, preview: "older question", cwd: id === "thread-elsewhere" ? "/elsewhere" : process.cwd(), ephemeral: id === "thread-ephemeral", createdAt: 1, updatedAt: 2, source: "cli", turns: [] } }); return;
  }
  if (scenario === "threads" && message.method === "thread/turns/list") {
    const turnOf = (n, input) => ({ id: "turn-" + n, status: "completed", items: [{ type: "userMessage", id: "u" + n, content: input }, { type: "commandExecution", id: "c" + n, command: "ls", status: "completed" },
      { type: "agentMessage", id: "a" + n, text: "answer " + n, phase: "final_answer" }] });
    if (message.params.cursor === "older") { answer(message.id, { data: [turnOf(1, [{ type: "text", text: "question 1" }])], nextCursor: null }); return; }
    answer(message.id, { data: [turnOf(3, [{ type: "text", text: "question 3" }]), turnOf(2, [{ type: "text", text: "question 2" }, { type: "localImage", path: "/tmp/shot.png" }])], nextCursor: "older" }); return;
  }
  // Outside the "threads" scenario the turn listing is refused, as a server without it refuses; unanswered it would time out.
  if (message.method === "thread/turns/list") { emit({ id: message.id, error: { code: -32601, message: "Method not found" } }); return; }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    resumedThread = message.method === "thread/resume";
    if (!initialized) { emit({ id: message.id, error: { code: -32600, message: "Not initialized" } }); return; }
    const id = scenario === "resume-wrong-identity" && message.method === "thread/resume" ? "thread-replacement" : THREAD;
    notification("thread/started", { thread: { id } });
    // The thread reports the policy it runs with: requested overrides apply unless the scenario refuses them.
    const sandboxType = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[message.params.sandbox ?? "danger-full-access"];
    // A thread reports its own rollout file; the fixture writes one so export has native bytes to copy.
    const rollout = scenario === "rollout" ? join(tmpdir(), `codex-rollout-${process.pid}.jsonl`) : null;
    if (rollout) { writeFileSync(rollout, '{"type":"session_meta"}\n'); process.on("exit", () => rmSync(rollout, { force: true })); }
    // FIXTURE_THREAD_MODE is the effective collaboration mode thread/resume reports (a stable field; thread/start has none);
    // FIXTURE_THREAD_POLICY=odd reports an approval policy and a sandbox that no option of the Hub knows.
    const odd = process.env.FIXTURE_THREAD_POLICY === "odd", mode = message.method === "thread/resume" ? process.env.FIXTURE_THREAD_MODE : undefined;
    answer(message.id, { thread: { id, ...(rollout ? { path: rollout } : {}) }, approvalPolicy: odd ? { granular: { sandbox_approval: true } } : scenario === "ignore-permissions" ? "never" : message.params.approvalPolicy ?? "never",
      sandbox: { type: odd ? "externalSandbox" : scenario === "ignore-permissions" ? "dangerFullAccess" : sandboxType },
      ...(mode === undefined ? {} : { collaborationMode: { mode, settings: { model: "native-model-a", reasoning_effort: null, developer_instructions: null } } }) }); return;
  }
  if (message.method === "ping") { answer(message.id, { echoed: message.params }); return; }
  if (message.method === "thread/fork") {
    if (scenario === "fork-refused") { emit({ id: message.id, error: { code: -32600, message: "thread cannot be forked" } }); return; }
    notification("thread/started", { thread: { id: "thread-forked" } });
    // Like the installed app-server, the copy reports its own status on every attached connection.
    notification("thread/status/changed", { threadId: "thread-forked", status: { type: "idle" } });
    notification("thread/tokenUsage/updated", { threadId: "thread-forked", turnId: "copied-turn", tokenUsage: { total: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } });
    answer(message.id, { thread: { id: scenario === "fork-same" ? message.params.threadId : "thread-forked" } }); return;
  }
  if (message.method === "session/fork") {
    // FIXTURE_FORK_ERROR refuses with that JSON-RPC error code; FIXTURE_FORK_DELAY_MS answers that much later, as an agent
    // that starts the copy as a session before answering does.
    if (process.env.FIXTURE_FORK_ERROR) { emit({ id: message.id, error: { code: Number(process.env.FIXTURE_FORK_ERROR), message: process.env.FIXTURE_FORK_ERROR === "-32601" ? "Method not found" : "Internal error" } }); return; }
    // ACP agents replay the copied history for the new session before answering.
    const fork = () => {
      notification("session/update", { sessionId: "session-forked", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "copied question" } } });
      notification("session/update", { sessionId: "session-forked", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "copied answer" } } });
      answer(message.id, { sessionId: "session-forked" });
    };
    if (process.env.FIXTURE_FORK_DELAY_MS) setTimeout(fork, Number(process.env.FIXTURE_FORK_DELAY_MS)); else fork();
    return;
  }
  if (message.method === "thread/compact/start") {
    // Codex runs compaction as its own turn: the receipt is empty and the turn identity arrives by notification.
    answer(message.id, {}); turn += 1;
    const base = { threadId: THREAD, turnId: `turn-${turn}` };
    notification("turn/started", { threadId: THREAD, turn: { id: base.turnId, status: "inProgress" } });
    notification("item/started", { ...base, item: { type: "contextCompaction", id: "compact-item" } });
    notification("item/completed", { ...base, item: { type: "contextCompaction", id: "compact-item" } });
    notification("turn/completed", { threadId: THREAD, turn: { id: base.turnId, status: "completed" } }); return;
  }
  if (message.method === "turn/start" && message.params?.collaborationMode !== undefined && !experimental) {
    emit({ id: message.id, error: { code: -32600, message: "turn/start.collaborationMode requires experimentalApi capability" } }); return;
  }
  if (message.method === "session/prompt" || message.method === "turn/start") {
    // An ACP agent reports a missing login with the protocol's auth_required code, whatever its own words are.
    if (scenario === "auth-code") { emit({ id: message.id, error: { code: -32000, message: "agent setup needed" } }); return; }
    if (scenario === "quota-rejected" || scenario === "auth-rejected") { emit({ id: message.id, error: { code: -32001, message: (scenario === "quota-rejected" ? "You've hit your weekly limit" : "Authentication required") + " private-synthetic-key" } }); return; }
    if (scenario === "prompt-rejected") { emit({ id: message.id, error: { code: -32001, message: "private rejected request synthetic-key" } }); return; }
    promptId = message.id; turn += 1;
    if (scenario === "exit-zero") { process.exit(0); }
    // claude-agent-acp re-reads its sign-in when each prompt starts and pushes any change mid-turn (FIXTURE_AUTH_TURN_KIND).
    if (scenario === "claude-auth" && process.env.FIXTURE_AUTH_TURN_KIND) notification("_auth/status_update", claudeAuthStatus(process.env.FIXTURE_AUTH_TURN_KIND));
    // For a `/compact` it does not list, OpenCode summarizes the session (session.summarize) and hands the summary back as reply
    // text (1.18.35). FIXTURE_COMPACT=activity reports the compaction as an activity only, as an agent that announces it does;
    // FIXTURE_COMPACT=ignored drops any slash input starting with /compact and ends the turn with nothing.
    if (scenario === "opencode-compact" && /^\/compact/u.test(message.params.prompt?.[0]?.text ?? "")) {
      const sessionId = message.params.sessionId;
      if (process.env.FIXTURE_COMPACT === "activity") for (const status of ["in_progress", "completed"]) notification("session/update", { sessionId, update: { sessionUpdate: "compaction_update", compactionId: "compact-1", status } });
      else if (process.env.FIXTURE_COMPACT !== "ignored") notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "compacted" } } });
      finish(); return;
    }
    // A native command changes a session setting and the agent announces it, as ACP agents do for their own changes.
    if (scenario === "native-config" && JSON.stringify(message.params.prompt).includes("/native-fast on")) {
      fast = "on"; notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: nativeConfiguration() } });
    }
    if (scenario === "unknown-method") {
      emit({ id: "unsupported", method: "fixture/unsupported", params: {} });
      pendingPermission = true;
    }
    // Codex 0.166.0 answers turn/start at once and runs the user's hooks before it reports the turn (turn/started) and takes an
    // interrupt: until then turn/interrupt is refused with -32600 "no active turn to interrupt" (relay-conformance.md F4).
    // FIXTURE_START_MS is how long that takes (default 120 ms); a prompt with "finish" in it ends by itself once started, any other
    // waits for an interrupt (FIXTURE_INTERRUPT_REFUSAL: the words of the refusal, "no active turn to interrupt" by default).
    if (protocol === "codex-app-server" && scenario === "hooks") {
      const current = turn;
      answer(message.id, { turn: { id: `turn-${current}`, status: "inProgress" } });
      setTimeout(() => {
        hooksStarted = current;
        notification("turn/started", { threadId: THREAD, turn: { id: `turn-${current}`, status: "inProgress" } });
        codexOutput(`turn-${current}`);
        if (JSON.stringify(message.params.input).includes("finish")) { hooksEnded = current; finish(); }
      }, Number(process.env.FIXTURE_START_MS ?? 120));
      return;
    }
    if (protocol === "codex-app-server") {
      if (resumedThread) notification("thread/tokenUsage/updated", { threadId: THREAD, turnId: "previous-native-turn", tokenUsage: {} });
      notification("turn/started", { threadId: THREAD, turn: { id: `turn-${turn}`, status: "inProgress" } });
      if (scenario !== "early-complete" && scenario !== "slow-start") answer(message.id, { turn: { id: `turn-${turn}`, status: "inProgress" } });
    }
    if (scenario === "wrong-identity") {
      if (protocol === "acp-v1") acpOutput("another-session"); else codexOutput(`turn-${turn}`, "another-thread");
      return;
    }
    if (scenario === "wrong-turn") { codexOutput("another-turn"); return; }
    // A sub-agent thread spawned for this turn runs a command and reports back; an unrelated thread works at the same time.
    if (protocol === "codex-app-server" && scenario === "child-tools") {
      const child = { threadId: "thread-child", turnId: "child-turn" };
      notification("thread/started", { thread: { id: "thread-child", parentThreadId: THREAD, agentNickname: "Researcher" } });
      notification("thread/started", { thread: { id: "thread-grandchild", parentThreadId: "thread-child" } });
      // Installed Codex announces a spawned agent only through the parent's subAgentActivity item.
      notification("item/started", { threadId: THREAD, turnId: `turn-${turn}`, item: { type: "subAgentActivity", id: "spawn-1", agentPath: "/root/helper", agentThreadId: "thread-helper", kind: "started" } });
      notification("item/completed", { threadId: "thread-helper", turnId: "helper-turn", item: { type: "commandExecution", id: "cmd-4", command: "pwd", cwd: "/w", status: "completed", aggregatedOutput: "/w", exitCode: 0 } });
      notification("thread/started", { thread: { id: "thread-unrelated" } });
      notification("turn/started", { threadId: "thread-child", turn: { id: "child-turn", status: "inProgress" } });
      notification("item/started", { ...child, item: { type: "commandExecution", id: "cmd-1", command: "echo SUB-OK", cwd: "/w", status: "inProgress" } });
      notification("item/completed", { ...child, item: { type: "commandExecution", id: "cmd-1", command: "echo SUB-OK", cwd: "/w", status: "completed", aggregatedOutput: "SUB-OK", exitCode: 0 } });
      notification("item/completed", { threadId: "thread-grandchild", turnId: "g-turn", item: { type: "commandExecution", id: "cmd-2", command: "ls", cwd: "/w", status: "completed", aggregatedOutput: "a", exitCode: 0 } });
      notification("item/completed", { threadId: "thread-unrelated", turnId: "u-turn", item: { type: "commandExecution", id: "cmd-3", command: "rm -rf /tmp/x", cwd: "/w", status: "completed", aggregatedOutput: "", exitCode: 0 } });
      notification("item/completed", { ...child, item: { type: "agentMessage", id: "child-msg", text: "child report: SUB-OK" } });
      notification("turn/completed", { threadId: "thread-child", turn: { id: "child-turn", status: "completed" } });
      codexOutput(); setTimeout(() => finish(), 30); return;
    }
    if (protocol === "codex-app-server" && scenario === "foreign-thread") {
      notification("thread/started", { thread: { id: "thread-child", parentThreadId: THREAD } });
      notification("thread/started", { thread: { id: "thread-unrelated" } });
      notification("item/agentMessage/delta", { threadId: "thread-child", turnId: "child-turn", itemId: "child-message", delta: "child output" });
      notification("turn/completed", { threadId: "thread-unrelated", turn: { id: "unrelated-turn", status: "completed" } });
      emit({ id: "child-approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread-child", turnId: "child-turn", itemId: "child-tool", command: "ls" } });
      emit({ id: "unrelated-approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread-unrelated", turnId: "unrelated-turn", itemId: "unrelated-tool", command: "rm -rf /tmp/x" } });
      codexOutput(); setTimeout(() => finish(), 30); return;
    }
    if (protocol === "codex-app-server" && scenario === "native-activity") {
      const base = { threadId: THREAD, turnId: `turn-${turn}` };
      notification("thread/tokenUsage/updated", { threadId: THREAD, turnId: "older-turn", tokenUsage: { total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 0 }, last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 0 }, modelContextWindow: 100000 } });
      notification("item/started", { ...base, item: { type: "commandExecution", id: "cmd-1", command: "printf 'a'\nprintf 'b'", cwd: "/w", status: "inProgress" } });
      notification("item/commandExecution/outputDelta", { ...base, itemId: "cmd-1", delta: "a" });
      notification("item/commandExecution/outputDelta", { ...base, itemId: "cmd-1", delta: "b" });
      notification("item/completed", { ...base, item: { type: "commandExecution", id: "cmd-1", command: "printf 'a'\nprintf 'b'", cwd: "/w", status: "completed", aggregatedOutput: "ab", exitCode: 0 } });
      notification("item/completed", { ...base, item: { type: "fileChange", id: "patch-1", status: "completed", changes: [{ path: "/w/a.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" }] } });
      notification("item/completed", { ...base, item: { type: "mcpToolCall", id: "mcp-1", server: "docs", tool: "search", arguments: { q: "acp" }, status: "completed", result: { content: [{ type: "text", text: "found" }] } } });
      notification("item/started", { ...base, item: { type: "contextCompaction", id: "compact-1" } });
      notification("item/completed", { ...base, item: { type: "subAgentActivity", id: "agent-item", agentPath: "researcher", agentThreadId: "thread-child", kind: "completed" } });
      notification("turn/plan/updated", { ...base, explanation: "two steps", plan: [{ step: "Inspect", status: "completed" }, { step: "Patch", status: "inProgress" }] });
      notification("error", { ...base, error: { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: {} } }, willRetry: true });
      notification("model/rerouted", { ...base, fromModel: "gpt-a", toModel: "gpt-b", reason: "highRiskCyberActivity" });
      notification("thread/tokenUsage/updated", { ...base, tokenUsage: { total: { totalTokens: 1600, inputTokens: 1200, cachedInputTokens: 300, outputTokens: 400, reasoningOutputTokens: 50 }, last: { totalTokens: 600, inputTokens: 400, cachedInputTokens: 200, outputTokens: 200, reasoningOutputTokens: 50 }, modelContextWindow: 100000 } });
      // The saved image is read after item/completed; turn/completed follows immediately and must not drop it.
      const image = join(tmpdir(), `codex-fixture-${process.pid}.png`); writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])); process.on("exit", () => rmSync(image, { force: true }));
      notification("item/completed", { ...base, item: { type: "imageGeneration", id: "img-1", status: "completed", revisedPrompt: "a chart", savedPath: image } });
      notification("item/started", { ...base, item: { type: "commandExecution", id: "cmd-2", command: "tail log", cwd: "/w", status: "inProgress" } });
      notification("item/commandExecution/outputDelta", { ...base, itemId: "cmd-2", delta: "line1" });
      codexOutput(); finish(); return;
    }
    // Plan mode answers with a proposed plan item; its deltas may differ from the completed item, which is authoritative. A
    // connection that declared the experimental API also hears the thread's read state change before the turn completes.
    if (protocol === "codex-app-server" && scenario === "plan-mode") {
      const base = { threadId: THREAD, turnId: `turn-${turn}` };
      if (message.params.collaborationMode?.mode === "plan") {
        notification("item/plan/delta", { ...base, itemId: "plan-1", delta: "1. 读" });
        notification("item/plan/delta", { ...base, itemId: "plan-1", delta: "代码（草稿）" });
        notification("item/completed", { ...base, item: { type: "plan", id: "plan-1", text: "1. 读代码\n2. 改实现" } });
      } else codexOutput();
      if (experimental) notification("thread/readState/changed", { threadId: THREAD, readState: { lastReadTurnId: base.turnId } });
      finish(); return;
    }
    if (protocol === "codex-app-server" && scenario === "typed-failure") {
      notification("turn/completed", { threadId: THREAD, turn: { id: `turn-${turn}`, status: "failed", error: { message: "provider said something unhelpful", codexErrorInfo: "usageLimitExceeded" } } }); return;
    }
    if (protocol === "acp-v1" && scenario === "native-activity") {
      const sessionId = SESSION, update = value => notification("session/update", { sessionId, update: value });
      update({ sessionUpdate: "plan", entries: [{ content: "Read", status: "completed", priority: "high" }, { content: "Edit", status: "in_progress", priority: "medium" }] });
      update({ sessionUpdate: "tool_call", toolCallId: "shell-1", title: "ls -la", kind: "execute", status: "pending", rawInput: { command: "ls -la" } });
      update({ sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit a.txt", kind: "edit", status: "pending", name: "Edit", rawInput: { file_path: "/w/a.txt" }, _meta: { claudeCode: { toolName: "Edit", parentToolUseId: "parent-task" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "edited" } }, { type: "diff", path: "a.txt", oldText: "one\ntwo", newText: "one\nTWO" }], locations: [{ path: "/w/a.txt", line: 2 }] });
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.25, currency: "USD" } });
      update({ sessionUpdate: "notice", severity: "warning", title: "Model fallback", description: "switched model" });
      update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" });
      update({ sessionUpdate: "compaction_summary_chunk", compactionId: "compact-1", content: { type: "text", text: "summary text" } });
      update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: Buffer.from("png!").toString("base64"), mimeType: "image/png" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.invalid/report", name: "report", title: "Report" } });
      acpOutput(); answer(promptId, { stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 300, cachedReadTokens: 50, totalTokens: 1250 } }); return;
    }
    // The tool calls five Harnesses really sent in the trial of 2026-11-11 (tests/fixtures/protocol/trial-2026-11-11.json), in each one's own spelling:
    // DeepSeek Harness's `bash` and `read` (kind other, the title only the tool's name), Claude Code's command and the Hub's own MCP tool, an edit with
    // its diff, Hermes's `terminal: …` title, and a call no rule knows.
    if (protocol === "acp-v1" && scenario === "protocol-trial") {
      const sessionId = SESSION, update = value => notification("session/update", { sessionId, update: value });
      const text = value => [{ type: "content", content: { type: "text", text: value } }];
      update({ sessionUpdate: "tool_call", toolCallId: "d-bash", title: "bash", kind: "other", status: "in_progress", rawInput: { command: "pwd && ls -la" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "d-bash", status: "completed", content: text("/w") });
      update({ sessionUpdate: "tool_call", toolCallId: "d-read", title: "read", kind: "other", status: "in_progress", rawInput: { file_path: "/w/src/cart.js" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "d-read", status: "completed", content: text("1: export const x = 1;") });
      update({ sessionUpdate: "tool_call", toolCallId: "c-bash", title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" }, _meta: { claudeCode: { toolName: "Bash" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "c-bash", status: "completed", content: text("ok") });
      update({ sessionUpdate: "tool_call", toolCallId: "c-hub", title: "mcp__harnesshub__hub_turns", kind: "other", status: "pending", _meta: { claudeCode: { toolName: "mcp__harnesshub__hub_turns" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "c-hub", status: "completed", content: text("Turns 1-1 of 1.") });
      update({ sessionUpdate: "tool_call", toolCallId: "e-edit", title: "Edit a.txt", kind: "edit", status: "pending", rawInput: { file_path: "/w/a.txt" }, _meta: { claudeCode: { toolName: "Edit" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "e-edit", status: "completed", content: [{ type: "diff", path: "a.txt", oldText: "one\ntwo", newText: "one\nTWO" }], locations: [{ path: "/w/a.txt", line: 2 }] });
      update({ sessionUpdate: "tool_call", toolCallId: "h-term", title: "terminal: ls -la", kind: "execute", status: "completed" });
      update({ sessionUpdate: "tool_call", toolCallId: "x-odd", title: "Brainstorm", kind: "other", status: "completed" });
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
      acpOutput(); finish(); return;
    }
    if (protocol === "acp-v1" && scenario === "tool-merge") {
      const sessionId = SESSION;
      notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "merged", title: "printf 'a'\nprintf 'b'", status: "pending" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "merged", title: "printf 'a'\nprintf 'b'", status: "pending" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "late-announced", status: "completed" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aGk=", mimeType: "image/png" } } });
      acpOutput(); finish(); return;
    }
    if (protocol === "acp-v1" && scenario === "late-output") {
      acpOutput(); finish();
      setTimeout(() => {
        notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "autonomous follow-up" } } });
        emit({ id: "late-permission", method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: "late-tool" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } });
      }, 10);
      return;
    }
    if (scenario === "hermes") {
      if (process.env.FIXTURE_PROMPT_ERROR) { hermesRefusal(message.id, process.env.FIXTURE_PROMPT_ERROR); return; }
      // A dangerous command asks Hermes's approval bridge; otherwise the reply arrives after a pause, as a model turn does.
      // A model call that failed for good: Hermes logs why on stderr and still ends the turn, with nothing answered.
      if (JSON.stringify(message.params.prompt).includes("fail quietly")) { process.stderr.write("2026-10-11 12:00:00 [ERROR] run_agent: API call failed after 3 retries. Error code: 402 - Insufficient Balance | provider=deepseek model=deepseek-v4-pro\n"); setTimeout(() => finish(), 20); return; }
      // A failure that a retry overcame is logged too, but the turn answers.
      if (JSON.stringify(message.params.prompt).includes("recovered failure")) { process.stderr.write("2026-10-11 12:00:00 [WARNING] run_agent: RateLimitError on attempt 1, retrying\n"); acpOutput(message.params.sessionId); finish(); return; }
      // Hermes can send its last reply chunk after the prompt response.
      if (JSON.stringify(message.params.prompt).includes("late tail")) { acpOutput(message.params.sessionId); finish(); setTimeout(() => notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " tail" } } }), 100); return; }
      // Hermes handles its own /model command locally and only answers in text.
      if (JSON.stringify(message.params.prompt).includes("/model deepseek-v4-flash")) { notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Model switched to: deepseek-v4-flash\nProvider: deepseek" } } }); finish(); return; }
      // Hermes 0.12 reports every finished call as completed; a refused command only says so in its text (acp_adapter/tools.py).
      if (JSON.stringify(message.params.prompt).includes("blocked command")) {
        hermesBlocked(message.params.sessionId); hermesBlocked(message.params.sessionId, "terminal-blocked-2");
        notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已删除" } } }); finish(); return;
      }
      // A step that asks before it runs, as ACP agents report it: the call is pending while its approval waits and runs once
      // allowed. Allowed, it holds in progress until the test writes "step-continue" into the workspace, so its running is seen.
      if (JSON.stringify(message.params.prompt).includes("STEP_APPROVAL")) {
        const sessionId = message.params.sessionId, update = value => notification("session/update", { sessionId, update: value });
        stepFails = JSON.stringify(message.params.prompt).includes("STEP_APPROVAL_FAILS");
        update({ sessionUpdate: "tool_call", toolCallId: "step-read", title: "Read " + join(sessionCwd ?? process.cwd(), "src", "app.ts"), kind: "read", status: "completed" });
        update({ sessionUpdate: "tool_call", toolCallId: "step-ask", title: "terminal: rm -rf build", kind: "execute", status: "pending" });
        emit({ id: "hermes-permission-step", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "step-ask", title: "rm -rf build", kind: "execute" }, options: hermesOptions() } });
        return;
      }
      if (JSON.stringify(message.params.prompt).includes("ask then blocked")) {
        emit({ id: "hermes-permission-blocked", method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "perm-check", title: "rm -r build", kind: "execute" },
          options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "deny", kind: "reject_once", name: "Deny" }] } });
        return;
      }
      if (JSON.stringify(message.params.prompt).includes("approve")) {
        emit({ id: "hermes-permission", method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "perm-check", title: "rm -rf build", kind: "execute" },
          options: hermesOptions() } });
        return;
      }
      setTimeout(() => { acpOutput(message.params.sessionId); finish(); }, 150); return;
    }
    if (scenario === "passive") notification("fixture/passive", { privateSecret: "must-not-leak" });
    if (scenario === "native-question") {
      pendingPermission = true;
      notification("item/reasoning/summaryTextDelta", { threadId: THREAD, turnId: `turn-${turn}`, itemId: "native-reasoning", summaryIndex: 0, delta: "native reasoning summary" });
      emit({ id: "native-question", method: "item/tool/requestUserInput", params: { threadId: THREAD, turnId: `turn-${turn}`, itemId: "native-question-tool", isBlocking: true, questions: [
        { id: "native-choice", header: "Native choice", question: "选择原生计划", options: [{ label: "First", description: "native first" }, { label: "Second", description: "native second" }] },
        { id: "native-text", header: "Native input", question: "输入原生问题答案", isSecret: true, options: null },
      ] } }); return;
    }
    // Claude Code takes back an approval it still has open (a request with a numeric id here).
    if (scenario === "permission-withdrawn") {
      emit({ id: 41, method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "tool-1", title: "Edit notes.txt", kind: "edit" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
      withdrawLater(41); return;
    }
    if (scenario === "permission" || scenario === "duplicate-permission") {
      pendingPermission = true;
      const permission = protocol === "acp-v1"
        ? { id: "permission-1", method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: "tool-1",
          // The proposed change travels with the request, as Claude and OpenCode send it for an edit.
          ...(scenario === "duplicate-permission" ? {} : { title: "Edit notes.txt", kind: "edit", content: [{ type: "diff", path: "/w/notes.txt", oldText: "alpha\nbravo\n", newText: "alpha\ndelta\n" }], locations: [{ path: "/w/notes.txt" }] }) },
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } }
        : { id: "permission-1", method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: `turn-${turn}`, itemId: "tool-1" } };
      emit(permission); if (scenario === "duplicate-permission") emit(permission); return;
    }
    // Claude's AskUserQuestion form: a single select with its "Other" companion and a multi-select; or a form with a number field.
    // In "elicitation-withdrawn" Claude Code takes the question back while its first field is asked.
    if (scenario === "elicitation" || scenario === "elicitation-number" || scenario === "elicitation-withdrawn") {
      const option = (label, description) => ({ const: label, title: label, ...(description ? { description } : {}) });
      const properties = scenario === "elicitation-number" ? { count: { type: "number", title: "How many?" } } : {
        question_0: { type: "string", title: "Color", description: "Which color?", oneOf: [option("Red", "warm"), option("Blue", "cool")] },
        question_0_custom: { type: "string", title: "Other", description: "Type your own answer" },
        question_1: { type: "array", title: "Sizes", description: "Which sizes?", items: { anyOf: [option("S"), option("M")] } },
        question_1_custom: { type: "string", title: "Other", description: "Type your own answer" } };
      emit({ id: "elicit-1", method: "elicitation/create", params: { mode: "form", sessionId: message.params.sessionId, toolCallId: "ask-1", message: "Please answer the following questions.", requestedSchema: { type: "object", properties } } });
      if (scenario === "elicitation-withdrawn") withdrawLater("elicit-1");
      return;
    }
    // A sub-agent call whose own tool runs flattened in the root session, stamped with the parent call (Claude's default).
    if (scenario === "subagent") {
      const sessionId = message.params.sessionId, update = value => notification("session/update", { sessionId, update: value });
      update({ sessionUpdate: "tool_call", toolCallId: "agent-1", title: "Run echo SUB-OK", kind: "think", status: "in_progress", rawInput: { description: "Run echo SUB-OK", prompt: "run echo SUB-OK" }, _meta: { claudeCode: { toolName: "Agent" } } });
      update({ sessionUpdate: "tool_call", toolCallId: "bash-1", title: "echo SUB-OK", kind: "execute", status: "completed", rawInput: { command: "echo SUB-OK" }, content: [{ type: "content", content: { type: "text", text: "SUB-OK" } }], _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "agent-1" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "agent-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "子代理报告：SUB-OK" } }] });
    }
    // A continued session answers under its own identity.
    if (protocol === "acp-v1") acpOutput(scenario === "session-list" ? message.params.sessionId : undefined); else codexOutput();
    if (["stop", "stop-permission", "slow-start", "no-settlement", "ignore-cancel", "complete-on-cancel"].includes(scenario)) {
      if (scenario === "slow-start") setTimeout(() => answer(message.id, { turn: { id: `turn-${turn}`, status: "inProgress" } }), 50);
      return;
    }
    if (scenario === "duplicate-complete") {
      const terminal = protocol === "acp-v1" ? { id: promptId, result: { stopReason: "end_turn" } }
        : { method: "turn/completed", params: { threadId: THREAD, turn: { id: `turn-${turn}`, status: "completed" } } };
      emitAtomicBatch([terminal, terminal]); return;
    }
    if (!pendingPermission) finish();
    if (scenario === "early-complete") answer(message.id, { turn: { id: `turn-${turn}`, status: "inProgress" } });
    return;
  }
  if (message.method === "session/cancel" || message.method === "turn/interrupt") {
    // hooks: before the turn is reported, and once it has ended, there is no active turn to interrupt.
    if (scenario === "hooks" && message.method === "turn/interrupt") {
      if (hooksStarted !== turn || hooksEnded === turn) { emit({ id: message.id, error: { code: -32600, message: process.env.FIXTURE_INTERRUPT_REFUSAL ?? "no active turn to interrupt" } }); return; }
      hooksEnded = turn;
    }
    if (message.method === "turn/interrupt") answer(message.id, {});
    // A program that never settles its turn after a stop request: only ending its process ends the turn.
    if (scenario === "ignore-cancel") return;
    // A program whose turn completes on its own just after the stop request, as if the stop came too late.
    if (scenario === "complete-on-cancel") { setTimeout(() => finish(false), 50); return; }
    if (scenario === "stop-permission") {
      emit(protocol === "acp-v1"
        ? { id: "permission-after-stop", method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: "tool-1" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } }
        : { id: "permission-after-stop", method: "item/fileChange/requestApproval", params: { threadId: THREAD, turnId: `turn-${turn}`, itemId: "tool-1" } });
    }
    setTimeout(() => finish(true), 50); return;
  }
  if (scenario.endsWith("-withdrawn") && (message.id === 41 || message.id === "elicit-1")) return;
  if (message.id === "hermes-permission") { notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission " + JSON.stringify(message.result) } } }); finish(); return; }
  if (message.id === "hermes-permission-blocked") { hermesBlocked(SESSION); finish(); return; }
  if (message.id === "hermes-permission-step") {
    const update = value => notification("session/update", { sessionId: SESSION, update: value });
    if (message.result?.outcome?.optionId !== "allow_once") {
      update({ sessionUpdate: "tool_call_update", toolCallId: "step-ask", status: "failed" });
      if (stepFails) hermesRefusal(promptId, "the refused step was needed"); else finish();
      return;
    }
    update({ sessionUpdate: "tool_call_update", toolCallId: "step-ask", status: "in_progress" });
    const go = join(sessionCwd ?? process.cwd(), "step-continue"), hold = setInterval(() => {
      if (!existsSync(go)) return;
      clearInterval(hold); rmSync(go, { force: true });
      update({ sessionUpdate: "tool_call_update", toolCallId: "step-ask", status: "completed", content: [{ type: "content", content: { type: "text", text: "removed build" } }] });
      notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "构建目录已清理。" } } });
      finish();
    }, 50);
    return;
  }
  if (message.id === "elicit-1") { notification("session/update", { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "form " + JSON.stringify(message.result) } } }); finish(); return; }
  if (message.id === "late-permission" || message.id === "child-approval" || message.id === "unrelated-approval") return;
  if (message.id === "permission-1" || message.id === "unsupported" || message.id === "native-question") {
    if (protocol === "acp-v1") acpOutput(); else codexOutput();
    pendingPermission = false; finish();
  }
});
