// A minimal native side for the G069 relay tests (no Harness, no model, nothing outside its own files), on stdio. It plays
// what each Driver's protocol shows of the native history, as the installed releases were read (ADR-055 §8.1; G069
// phase two records which file of which version); it writes only RELAY_STATE, RELAY_TRACE and RELAY_TRANSCRIPT, and exits
// when its input closes.
//
// RELAY_PROTOCOL "acp" (default): ACP v1. session/new answers one session ("relay-session", then "relay-session-2", …) and
//   announces RELAY_COMMANDS (a JSON list of ACP available commands, without contextEffect, as agents send them); every
//   prompt is answered with RELAY_REPLY (default "ok") and RELAY_STOP (default end_turn). With RELAY_STATE (a JSON file the
//   native history is kept in across processes) each prompt's text blocks are stored as one user entry, joined by RELAY_JOIN
//   (default "\n", Hermes's and OpenClaw's join; "" is dsh's, which concatenates), and session/load replays the session's
//   entries before it answers (Hermes's viewer), compaction summaries with `_meta.hermes.compactionSummary`.
//   RELAY_HERMES "1": `/new`, `/clear`, `/reset` empty the history and answer "Conversation history cleared."; `/title X`
//     answers "Session title set: X" and stores nothing.
//   RELAY_OPENCLAW "1": the bridge's `[Working directory: <cwd>]` prefix before the stored text, `__openclaw.seq` numbers,
//     and `/new` appends a reset marker, numbers rows anew and renews the session's lifecycleRevision.
//   RELAY_TRANSCRIPT a Claude configuration directory: each prompt is written to projects/<project>/<session>.jsonl as the
//     CLI writes it (a user line with the blocks as content, then an assistant line), RELAY_TRANSCRIPT_DELAY_MS after the
//     prompt (the CLI's flush lag); RELAY_COMPACT "1" writes a compact_boundary line after the assistant line.
//   RELAY_DROP "1": the prompt is answered but never stored (a native side that did not record it).
//   RELAY_LOAD_FAULT "garbage": session/load replays an update without a kind (a malformed frame).
//   RELAY_NEW_FAULT "second": a second session/new on one connection is refused (-32603).
//   RELAY_SAME_SESSION "1": every session/new answers "relay-session", also when it exists (an agent that hands out a session
//     the client gave up).
//   RELAY_AUTH_KIND: claude-agent-acp's `_auth/status_update` with this kind, after initialize.
//   RELAY_NO_COMMANDS "1": no available_commands_update at all (a catalog that is never announced).
//   RELAY_ACP_MODEL: session/new reports this text as the session's only model and its current one (ACP `models`), as dsh reports
//     its model: a JSON array text of the provider and the model.
//   RELAY_UNPROMPTED_LOAD "1": session/load of a session that was never prompted is refused with -32002 (claude-agent-acp
//     0.99.1 in a new process: the CLI writes a conversation at its first prompt, so resuming one never prompted fails with
//     sessionNotFound, acp-agent.js:2491-2499, 8774-8779, 9255-9262).
//   RELAY_RESUME "1": session/resume is declared (sessionCapabilities.resume, as claude-agent-acp 0.99.1 does) and answered {} for a
//     session the shared state holds, without a replay; a Driver then restores by it, not by session/load. RELAY_UNPROMPTED_RESUME "1":
//     session/resume of a session that was never prompted is refused with -32002, which is what the probe of 2026-11-10 met on the real
//     adapter; RELAY_RESUME_FAULT "internal": every session/resume is refused with -32603.
//   RELAY_CLOSE "1" | "refuse" | "hang": session/close is declared (sessionCapabilities.close) and answered {}, refused
//     (-32603), or never answered.
//   RELAY_LATE_MS: that long after each prompt's answer, an agent message and a permission request of that session (an
//     autonomous follow-up, or an abandoned session's late updates).
//   RELAY_TITLE_FAULT "hang" (with RELAY_HERMES): `/title X` is never answered.
// RELAY_PROTOCOL "codex": Codex app-server v2. thread/start and thread/resume answer thread "thread-relay" with
//   RELAY_MODEL and RELAY_PROVIDER; turn/start stores the turn and reports its user message (echoing clientUserMessageId as
//   RELAY_ECHO_FIELD, default "clientUserMessageId", "none" for no echo) unless RELAY_HOOK "1" (a hook stopped it: the turn
//   completes without one), RELAY_REQUESTS token usage reports (default 1) and a reply; RELAY_COMPACT "1" records a context
//   compaction after the user message. thread/turns/list pages the stored turns (RELAY_TURNS_FAULT "refuse" or "garbage");
//   thread/name/set stores the name (RELAY_NAME_FAULT "refuse", or "hang": never answered); RELAY_TURNS_FAULT "hang" never
//   answers the listing, and RELAY_TURNS_DELAY_MS answers it that late.
//   RELAY_ECHO_VALUE echoes this identity instead of the one the turn was started with. RELAY_ECHO_EXTRA (a JSON object) adds
//   fields to the user message, "$clientUserMessageId" in it standing for the identity the turn was started with (the installed
//   Codex 0.166.0 echoes it as `clientId` only; a Codex that sent both names is played with this). RELAY_SKILL names one enabled
//   skill the catalog reads (config/read, model/list, account/read and skills/list answer as an empty, signed-in Codex).
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const env = process.env, trace = env.RELAY_TRACE, statePath = env.RELAY_STATE;
const commands = JSON.parse(env.RELAY_COMMANDS ?? "[]");
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const notify = (method, params) => send({ method, params });
const update = (sessionId, value) => notify("session/update", { sessionId, update: value });
const load = () => statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sessions: {}, threads: {} };
const save = state => { if (statePath) writeFileSync(statePath, JSON.stringify(state)); };
let state = load(), sessions = 0;
const session = id => (state.sessions[id] ??= { entries: [], seq: 0, revision: randomUUID(), title: null, cwd: null });

function acp(message) {
  const params = message.params ?? {};
  // The client's answers to this peer's own requests (permission requests) need no reply.
  if (message.method === undefined) return;
  if (message.method === "initialize") {
    const sessionCapabilities = { ...(env.RELAY_CLOSE ? { close: {} } : {}), ...(env.RELAY_RESUME ? { resume: {} } : {}) };
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, ...(Object.keys(sessionCapabilities).length ? { sessionCapabilities } : {}) }, authMethods: [{ id: "provider", name: "Provider" }], agentInfo: { name: "relay-control-peer", version: "1.0.0" } } });
    if (env.RELAY_AUTH_KIND) notify("_auth/status_update", { authStatus: { kind: env.RELAY_AUTH_KIND, label: "a label naming the user" } });
    return;
  }
  if (message.method === "session/close") {
    if (env.RELAY_CLOSE === "hang") return;
    send(env.RELAY_CLOSE === "refuse" ? { id: message.id, error: { code: -32603, message: "Internal error" } } : { id: message.id, result: {} });
    return;
  }
  if (message.method === "session/new" || message.method === "session/load" || message.method === "session/resume") {
    if (message.method === "session/resume" && env.RELAY_RESUME_FAULT === "internal") { send({ id: message.id, error: { code: -32603, message: "Internal error" } }); return; }
    if (message.method === "session/new" && env.RELAY_NEW_FAULT === "second" && sessions >= 1) { send({ id: message.id, error: { code: -32603, message: "Internal error" } }); return; }
    state = load();
    // A new session takes the first name no session of the shared state has (each process counts from "relay-session").
    let sessionId = params.sessionId;
    if (message.method === "session/new" && env.RELAY_SAME_SESSION === "1") sessionId = "relay-session";
    else if (message.method === "session/new") do sessionId = ++sessions === 1 ? "relay-session" : "relay-session-" + sessions; while (state.sessions[sessionId] !== undefined);
    if ((message.method === "session/load" && env.RELAY_UNPROMPTED_LOAD === "1" || message.method === "session/resume" && env.RELAY_UNPROMPTED_RESUME === "1") && state.sessions[sessionId]?.prompted !== true) {
      send({ id: message.id, error: { code: -32002, message: "Resource not found", data: { sessionId } } }); return;
    }
    const owned = session(sessionId);
    owned.cwd = params.cwd ?? owned.cwd; save(state);
    if (message.method === "session/load") {
      if (env.RELAY_LOAD_FAULT === "garbage") update(sessionId, { content: { type: "text", text: "no kind" } });
      for (const entry of owned.entries) {
        if (entry.role === "system") continue;
        update(sessionId, { sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text }, ...(entry.summary ? { _meta: { hermes: { compactionSummary: true } } } : {}) });
      }
    }
    send({ id: message.id, result: message.method !== "session/new" ? {} : { sessionId, ...(env.RELAY_ACP_MODEL ? { models: { currentModelId: env.RELAY_ACP_MODEL, availableModels: [{ modelId: env.RELAY_ACP_MODEL, name: env.RELAY_ACP_MODEL }] } } : {}) } });
    if (env.RELAY_NO_COMMANDS !== "1") update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: commands });
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = params.sessionId, blocks = (params.prompt ?? []).filter(block => block.type === "text").map(block => block.text);
    const joined = blocks.join(env.RELAY_JOIN ?? "\n"), command = joined.trimStart();
    if (env.RELAY_HERMES === "1" && env.RELAY_TITLE_FAULT === "hang" && /^\/title\s+\S/u.test(command)) return;
    state = load();
    const owned = session(sessionId);
    owned.prompted = true;
    let reply = env.RELAY_REPLY ?? "ok";
    if (env.RELAY_HERMES === "1" && /^\/(?:new|clear|reset)\b/u.test(command)) { owned.entries = []; reply = "Conversation history cleared."; }
    else if (env.RELAY_HERMES === "1" && /^\/title\s+\S/u.test(command)) { owned.title = command.slice(6).trim(); reply = "Session title set: " + owned.title; }
    else if (env.RELAY_OPENCLAW === "1" && /^\/new\b/u.test(command)) { owned.seq = 0; owned.revision = randomUUID(); owned.entries.push({ role: "system", kind: "reset", seq: ++owned.seq }); }
    else if (env.RELAY_DROP !== "1") {
      const text = env.RELAY_OPENCLAW === "1" ? ("[Working directory: " + owned.cwd + "]\n\n" + joined).trim() : joined;
      owned.entries.push({ role: "user", text, seq: ++owned.seq }, { role: "assistant", text: reply, seq: ++owned.seq });
      if (env.RELAY_TRANSCRIPT) transcript(sessionId, owned.cwd, blocks, reply);
    }
    save(state);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply + (env.RELAY_HERMES === "1" && reply !== (env.RELAY_REPLY ?? "ok") ? "\n" : "") } });
    send({ id: message.id, result: { stopReason: env.RELAY_STOP ?? "end_turn" } });
    if (env.RELAY_LATE_MS) setTimeout(() => {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a late follow-up" } });
      send({ id: "late-" + randomUUID(), method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "late-tool", title: "late" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
    }, Number(env.RELAY_LATE_MS));
    return;
  }
  if (message.method === "session/cancel") return;
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
}
/**
 * Claude Code's transcript lines for one prompt (CLI 2.1.312: the envelope, `type: "user"` with the blocks as content), in
 * the project directory the CLI names: every UTF-16 unit but ASCII letters and digits as `-` (claude-agent-acp 0.99.1
 * session-index/project-dirs.js `sanitize`, a `/g` pattern, so a character outside the BMP is two).
 */
function transcript(sessionId, cwd, blocks, reply) {
  const project = realpathSync(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-"), directory = join(env.RELAY_TRANSCRIPT, "projects", project);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, sessionId + ".jsonl"), base = { sessionId, cwd, userType: "external", version: "2.1.312" };
  const lines = [{ ...base, type: "user", uuid: randomUUID(), message: { role: "user", content: blocks.length === 1 ? blocks[0] : blocks.map(text => ({ type: "text", text })) }, permissionMode: "default" },
    { ...base, type: "assistant", uuid: randomUUID(), message: { role: "assistant", content: [{ type: "text", text: reply }] } },
    ...(env.RELAY_COMPACT === "1" ? [{ ...base, type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: randomUUID(), compactMetadata: { trigger: "auto", preTokens: 1 } }] : [])];
  const write = () => appendFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  const delay = Number(env.RELAY_TRANSCRIPT_DELAY_MS ?? 0);
  if (delay > 0) setTimeout(write, delay); else write();
}

let turns = 0;
function codex(message) {
  const params = message.params ?? {}, threadId = "thread-relay";
  const thread = () => (state.threads[threadId] ??= { turns: [], name: null });
  if (message.method === "initialize") { send({ id: message.id, result: { userAgent: "relay-control-peer/1.0.0 (fixture)" } }); return; }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" || message.method === "thread/resume") {
    state = load(); thread(); save(state);
    notify("thread/started", { thread: { id: threadId } });
    send({ id: message.id, result: { thread: { id: threadId, path: null, modelProvider: env.RELAY_PROVIDER ?? "openai" }, model: env.RELAY_MODEL ?? "gpt-5.5", modelProvider: env.RELAY_PROVIDER ?? "openai" } });
    return;
  }
  if (message.method === "turn/start") {
    state = load();
    const turnId = "turn-" + process.pid + "-" + ++turns, field = env.RELAY_ECHO_FIELD ?? "clientUserMessageId";
    const echoed = env.RELAY_ECHO_VALUE ?? params.clientUserMessageId;
    const extra = env.RELAY_ECHO_EXTRA ? JSON.parse(env.RELAY_ECHO_EXTRA.replaceAll("$clientUserMessageId", params.clientUserMessageId ?? "")) : {};
    const user = { type: "userMessage", id: "user-" + turnId, content: params.input.filter(item => item.type === "text"), ...(field === "none" || echoed === undefined ? {} : { [field]: echoed }), ...extra };
    const items = env.RELAY_HOOK === "1" ? [] : [user, ...(env.RELAY_COMPACT === "1" ? [{ type: "contextCompaction", id: "compact-" + turnId }] : [])];
    items.push({ type: "agentMessage", id: "agent-" + turnId, text: env.RELAY_REPLY ?? "ok" });
    thread().turns.push({ id: turnId, status: "completed", items }); save(state);
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    notify("turn/started", { threadId, turn: { id: turnId } });
    if (env.RELAY_HOOK !== "1") for (const method of ["item/started", "item/completed"]) notify(method, { threadId, turnId, item: user });
    const requests = Number(env.RELAY_REQUESTS ?? 1);
    for (let index = 1; index <= requests; index++) {
      const last = { totalTokens: 110 * index, inputTokens: 100 * index, cachedInputTokens: 50 * index, cacheWriteInputTokens: index, outputTokens: 10, reasoningOutputTokens: 0 };
      notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { ...last, inputTokens: 100 * index * (index + 1) / 2 }, last, modelContextWindow: 1_000_000 } });
    }
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "agent-" + turnId, text: env.RELAY_REPLY ?? "ok" } });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
    return;
  }
  if (message.method === "config/read") { send({ id: message.id, result: { config: { model: env.RELAY_MODEL ?? "gpt-5.5" } } }); return; }
  if (message.method === "model/list") { send({ id: message.id, result: { data: [], nextCursor: null } }); return; }
  if (message.method === "account/read") { send({ id: message.id, result: { account: null, requiresOpenaiAuth: false } }); return; }
  if (message.method === "skills/list") { send({ id: message.id, result: { data: env.RELAY_SKILL ? [{ skills: [{ name: env.RELAY_SKILL, path: "/relay-skills/" + env.RELAY_SKILL + "/SKILL.md", description: "a skill", enabled: true }] }] : [] } }); return; }
  if (message.method === "thread/turns/list") {
    if (env.RELAY_TURNS_FAULT === "hang") return;
    if (env.RELAY_TURNS_FAULT === "refuse") { send({ id: message.id, error: { code: -32600, message: "thread/turns/list is unavailable before first user message" } }); return; }
    if (env.RELAY_TURNS_FAULT === "garbage") { send({ id: message.id, result: { data: "not a page" } }); return; }
    state = load();
    const all = [...thread().turns].reverse(), offset = Number(params.cursor ?? 0), page = all.slice(offset, offset + (params.limit ?? 50));
    const answer = () => send({ id: message.id, result: { data: page, nextCursor: offset + page.length < all.length ? String(offset + page.length) : null, backwardsCursor: null } });
    if (env.RELAY_TURNS_DELAY_MS) setTimeout(answer, Number(env.RELAY_TURNS_DELAY_MS)); else answer();
    return;
  }
  if (message.method === "thread/name/set") {
    if (env.RELAY_NAME_FAULT === "hang") return;
    if (env.RELAY_NAME_FAULT === "refuse") { send({ id: message.id, error: { code: -32600, message: "thread name must not be empty" } }); return; }
    state = load(); thread().name = params.name; save(state);
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
}

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (trace) appendFileSync(trace, line + "\n");
  if (env.RELAY_PROTOCOL === "codex") codex(message); else acp(message);
});
