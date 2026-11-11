import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentId, type ContentKind, type ControlAttachment } from "../../src/contracts/content.js";
import type { BackendResult, ContextEffect, ControlEvent, ControlLaunch, ControlOptions, HarnessControl, NativeModelCatalog } from "../../src/contracts/control.js";
import { ClaudeControl } from "../../src/adapters/control/claude.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { HermesControl } from "../../src/adapters/control/hermes.js";
import { OpenClawControl } from "../../src/adapters/control/openclaw.js";
import { OpenCodeControl } from "../../src/adapters/control/opencode.js";
import type { HermesGatewayPreflight } from "../../src/adapters/control/hermes-gateway.js";

// G067-C03 (ADR-055 R0c): what each of the five drivers reports of a prompt reaching its native history, from the peer's own
// protocol only. A refusal before the prompt was inserted is not recorded, a failure after insertion is recorded, and a lost
// outcome is unknown, never sent again by the driver. Each peer is a minimal program written by this test into its own
// temporary directory; nothing here runs a Harness.

/**
 * A minimal ACP v1 agent. RELAY_PROMPT says how it ends a prompt: `answer` (a reply, RELAY_REPLY or "ok", then end_turn),
 * `silent` (end_turn and nothing else), `stop:<reason>` (that stop reason, no reply), `answer-stop:<reason>`,
 * `error:<code>:<details>` (a JSON-RPC error whose data carries the details, as the Python ACP SDK sends them), or
 * `rpc-error` (the JSON-RPC error RELAY_ERROR holds, exactly). RELAY_STDERR is written to stderr first.
 */
const ACP_PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.RELAY_TRACE, behaviour = process.env.RELAY_PROMPT ?? "answer";
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line), params = message.params ?? {};
  if (trace) appendFileSync(trace, line + "\\n");
  if (message.method === "initialize") { send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "provider", name: "Provider" }], agentInfo: { name: "relay-peer", version: "1.0.0" } } }); return; }
  if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "relay-session" } });
    update("relay-session", { sessionUpdate: "available_commands_update", availableCommands: JSON.parse(process.env.RELAY_COMMANDS ?? "[]") }); return;
  }
  if (message.method === "session/prompt") {
    const [kind, ...rest] = behaviour.split(":"), argument = rest.join(":");
    if (process.env.RELAY_STDERR) process.stderr.write(process.env.RELAY_STDERR + "\\n");
    if (kind === "error") { const [code, ...details] = argument.split(":"); send({ id: message.id, error: { code: Number(code), message: "Internal error", data: { details: details.join(":") } } }); return; }
    if (kind === "rpc-error") { send({ id: message.id, error: JSON.parse(process.env.RELAY_ERROR) }); return; }
    if (kind === "answer" || kind === "answer-stop") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.RELAY_REPLY ?? "ok" } });
    send({ id: message.id, result: { stopReason: kind === "stop" || kind === "answer-stop" ? argument : "end_turn" } }); return;
  }
  if (message.method === "session/cancel") return;
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;
/**
 * A minimal Codex app-server. RELAY_TURN says how turn/start goes: `reject` (refused before any turn exists), or a turn that
 * reports the user input as a thread item (`user-…`) or not (`silent-…`) and then completes or fails (`…-completed`, `…-failed`).
 */
const CODEX_PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.RELAY_TRACE, behaviour = process.env.RELAY_TURN ?? "user-completed";
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const notify = (method, params) => send({ method, params });
let turns = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (trace) appendFileSync(trace, line + "\\n");
  if (message.method === "initialize") { send({ id: message.id, result: { userAgent: "relay-codex/1.0.0 (fixture)" } }); return; }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") { notify("thread/started", { thread: { id: "relay-thread" } }); send({ id: message.id, result: { thread: { id: "relay-thread" }, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } } }); return; }
  if (message.method === "turn/start") {
    if (behaviour === "reject") { send({ id: message.id, error: { code: -32600, message: "input exceeds the maximum length" } }); return; }
    const id = "turn-" + ++turns, base = { threadId: "relay-thread", turnId: id };
    notify("turn/started", { threadId: "relay-thread", turn: { id, status: "inProgress" } });
    send({ id: message.id, result: { turn: { id, status: "inProgress" } } });
    if (behaviour.startsWith("user")) for (const method of ["item/started", "item/completed"]) notify(method, { ...base, item: { type: "userMessage", id: "user-" + id, content: message.params.input } });
    const failed = behaviour.endsWith("failed");
    notify("turn/completed", { threadId: "relay-thread", turn: { id, status: failed ? "failed" : "completed", ...(failed ? { error: { message: "limit", codexErrorInfo: "usageLimitExceeded" } } : {}) } }); return;
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;
const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 2000, runTimeoutMs: 4000, maxFrameBytes: 65536, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 150 };
const attached: HermesGatewayPreflight = async () => ({ kind: "attach", verdict: "A", explanation: "fixture gateway", evidence: [] });

async function peers(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "relay-insert-")); t.after(() => rm(root, { recursive: true, force: true }));
  const acp = join(root, "acp-peer.mjs"), codex = join(root, "codex-peer.mjs"); let count = 0;
  await writeFile(acp, ACP_PEER); await writeFile(codex, CODEX_PEER);
  return {
    root,
    /** A launch of one peer with its own trace file, and a reader of what it received. */
    launch(protocol: "acp-v1" | "codex-app-server", env: Readonly<Record<string, string>>) {
      const trace = join(root, "trace-" + ++count + ".ndjson");
      const launch: ControlLaunch = { protocol, executable: process.execPath, args: [protocol === "acp-v1" ? acp : codex], env: { RELAY_TRACE: trace, ...env } };
      const lines = async (): Promise<readonly { readonly method?: string; readonly params?: { readonly prompt?: readonly { readonly text?: string }[] } }[]> => {
        try { return (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string }); }
        catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
      };
      const received = async (method: string): Promise<number> => (await lines()).filter(line => line.method === method).length;
      /** The first text block of each prompt the peer received. */
      const prompts = async (): Promise<readonly string[]> => (await lines()).filter(line => line.method === "session/prompt").map(line => line.params?.prompt?.[0]?.text ?? "");
      return { launch, received, prompts };
    },
  };
}
/** One prompt on a fresh connection, after reading the catalog when asked: the result the driver reports and the Turn's events. */
async function turn(driver: HarnessControl, prompt: string, model?: string, catalog = false, attachments: readonly ControlAttachment[] = []): Promise<{ readonly result: BackendResult; readonly events: readonly ControlEvent[] }> {
  const events: ControlEvent[] = [];
  try {
    await driver.initialize(); const id = await driver.open(process.cwd(), model);
    if (catalog) await driver.models?.();
    return { result: await (await driver.startText(id, prompt, event => events.push(event), attachments)).result, events };
  } finally { await driver.close(); }
}
/** A launch of the ACP peer that refuses every prompt with exactly this JSON-RPC error. */
function refusing(f: Awaited<ReturnType<typeof peers>>, error: unknown, env: Readonly<Record<string, string>> = {}) { return f.launch("acp-v1", { RELAY_PROMPT: "rpc-error", RELAY_ERROR: JSON.stringify(error), ...env }); }
/** A small text file to attach (or, as `image`, a PNG), written into the fixture directory. */
async function attachment(root: string, name: string, kind: "file" | "image" = "file"): Promise<ControlAttachment> {
  const path = join(root, name), data = kind === "image" ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) : Buffer.from("notes\n"); await writeFile(path, data);
  return { id: contentId("content-" + name.replace(/[^a-z0-9]/giu, "")), name, mediaType: kind === "image" ? "image/png" : "text/plain", kind, bytes: data.length, sha256: "0".repeat(64), path };
}
/** The diagnostics a Turn reported. */
function diagnostics(events: readonly ControlEvent[]): readonly string[] { return events.flatMap(event => event.type === "diagnostic" ? [event.message] : []); }

test("G067-C03 Claude Code: its own refusal is not recorded, a prompt it stopped after writing it is recorded, a lost outcome is unknown and sent once", async t => {
  const f = await peers(t);
  // /remote-control is refused by the driver itself where Claude Code reads it as a command, the slash as the first character: nothing is sent.
  const refused = f.launch("acp-v1", { RELAY_PROMPT: "answer" });
  const remote = await turn(new ClaudeControl(refused.launch, options), "/remote-control");
  assert.equal(remote.result.input, "not_recorded"); assert.equal(remote.result.error?.code, "NATIVE_COMMAND_UNAVAILABLE");
  assert.equal(await refused.received("session/prompt"), 0);
  // Behind a space it is words (the CLI strips nothing, G074-F1): sent as typed, and its answer proves it recorded.
  const spaced = f.launch("acp-v1", { RELAY_PROMPT: "answer" });
  const words = await turn(new ClaudeControl(spaced.launch, options), "  /remote-control");
  assert.deepEqual([words.result.status, words.result.input], ["completed", "recorded"]); assert.deepEqual(await spaced.prompts(), ["  /remote-control"]);
  // The Hub's own /export reads Claude Code's record and sends nothing either.
  const exporting = f.launch("acp-v1", { RELAY_PROMPT: "answer", CLAUDE_CONFIG_DIR: join(f.root, "no-claude-config") });
  const exported = await turn(new ClaudeControl(exporting.launch, options), "/export", undefined, true);
  assert.equal(exported.result.input, "not_recorded"); assert.equal(await exporting.received("session/prompt"), 0);
  // max_tokens and max_turn_requests come only once Claude Code wrote the prompt to its transcript: a failure after insertion.
  for (const reason of ["max_tokens", "max_turn_requests"]) {
    const stopped = f.launch("acp-v1", { RELAY_PROMPT: "stop:" + reason });
    const { result } = await turn(new ClaudeControl(stopped.launch, options), "do the work");
    assert.deepEqual(result, { status: "failed", reason, input: "recorded" }, reason);
  }
  // A refusal the adapter does not explain may come before or after insertion: unknown, and the driver does not send it again.
  const lost = f.launch("acp-v1", { RELAY_PROMPT: "error:-32603:query stream ended" });
  const unknown = await turn(new ClaudeControl(lost.launch, options), "do the work");
  assert.equal(unknown.result.status, "failed"); assert.equal(unknown.result.input, undefined);
  assert.equal(await lost.received("session/prompt"), 1);
  // A command's reply proves nothing about history: `/compact` that Claude Code answered stays unknown.
  const compact = f.launch("acp-v1", { RELAY_PROMPT: "answer", RELAY_COMMANDS: JSON.stringify([{ name: "compact", description: "compact" }]) });
  assert.equal((await turn(new ClaudeControl(compact.launch, options), "/compact")).result.input, undefined);
});

test("G067-C03 Codex: turn/start refused before any turn is not recorded, a turn that recorded its input is recorded even when it fails, one without that item is unknown", async t => {
  const f = await peers(t);
  const rejected = f.launch("codex-app-server", { RELAY_TURN: "reject" });
  assert.deepEqual((await turn(new CodexControl(rejected.launch, options), "a prompt too large")).result, { status: "failed", reason: "request_rejected", input: "not_recorded" });
  const failed = f.launch("codex-app-server", { RELAY_TURN: "user-failed" });
  const after = await turn(new CodexControl(failed.launch, options), "do the work");
  assert.equal(after.result.status, "failed"); assert.equal(after.result.error?.code, "NATIVE_QUOTA_EXCEEDED"); assert.equal(after.result.input, "recorded");
  const completed = f.launch("codex-app-server", { RELAY_TURN: "user-completed" });
  assert.deepEqual((await turn(new CodexControl(completed.launch, options), "do the work")).result, { status: "completed", reason: "completed", input: "recorded" });
  // A turn can complete without recording its input (a hook stopped it): no item, no evidence, and nothing is sent again.
  const silent = f.launch("codex-app-server", { RELAY_TURN: "silent-completed" });
  assert.deepEqual((await turn(new CodexControl(silent.launch, options), "do the work")).result, { status: "completed", reason: "completed" });
  assert.equal(await silent.received("turn/start"), 1);
  // The driver's own /export sends nothing to Codex.
  const exporting = f.launch("codex-app-server", {});
  const exported = await turn(new CodexControl(exporting.launch, options), "/export");
  assert.equal(exported.result.input, "not_recorded"); assert.equal(await exporting.received("turn/start"), 0);
});

test("G067-C03 OpenCode: an ignored /compact reached nothing, a prompt stopped after delivery is recorded, a cancelled one stays unknown", async t => {
  const f = await peers(t);
  const ignored = f.launch("acp-v1", { RELAY_PROMPT: "silent" });
  const compact = await turn(new OpenCodeControl(ignored.launch, options), "/compact");
  assert.equal(compact.result.error?.code, "NATIVE_COMMAND_IGNORED"); assert.equal(compact.result.input, "not_recorded");
  for (const reason of ["max_tokens", "refusal"]) {
    const stopped = f.launch("acp-v1", { RELAY_PROMPT: "stop:" + reason });
    assert.deepEqual((await turn(new OpenCodeControl(stopped.launch, options), "do the work")).result, { status: "failed", reason, input: "recorded" }, reason);
  }
  assert.deepEqual((await turn(new OpenCodeControl(f.launch("acp-v1", { RELAY_PROMPT: "silent" }).launch, options), "do the work")).result, { status: "completed", reason: "end_turn", input: "recorded" });
  // A cancelled input can still be delivered later (OpenCode keeps it pending): unknown, and sent once.
  const cancelled = f.launch("acp-v1", { RELAY_PROMPT: "stop:cancelled" });
  assert.deepEqual((await turn(new OpenCodeControl(cancelled.launch, options), "do the work")).result, { status: "cancelled", reason: "cancelled" });
  assert.equal(await cancelled.received("session/prompt"), 1);
});

test("G067-C03 Hermes: a gateway that was unavailable admitted nothing, a failure after end_turn is recorded, unknown_execution is unknown and never sent again", async t => {
  const f = await peers(t);
  const unavailable = f.launch("acp-v1", { RELAY_PROMPT: "error:-32603:Gateway starting: warming_up" });
  const refused = await turn(new HermesControl(unavailable.launch, options, attached), "do the work");
  assert.equal(refused.result.error?.code, "NATIVE_GATEWAY_UNAVAILABLE"); assert.equal(refused.result.input, "not_recorded");
  // The turn was admitted and written before the model call; the model call then failed (its log names the class).
  const quiet = f.launch("acp-v1", { RELAY_PROMPT: "silent", RELAY_STDERR: "API call failed after 3 retries: RateLimitError" });
  const failed = await turn(new HermesControl(quiet.launch, options, attached), "do the work");
  assert.equal(failed.result.status, "failed"); assert.equal(failed.result.reason, "native_error"); assert.equal(failed.result.input, "recorded");
  // The gateway lost the outcome: it may have run, Hermes says not to send it again, and nothing is concluded.
  const lost = f.launch("acp-v1", { RELAY_PROMPT: "error:-32603:unknown_execution: admission adm-7 has no outcome; /discard adm-7" });
  const unknown = await turn(new HermesControl(lost.launch, options, attached), "do the work");
  assert.equal(unknown.result.status, "failed"); assert.equal(unknown.result.input, undefined);
  assert.ok(unknown.events.some(event => event.type === "diagnostic" && event.message.includes("/discard adm-7")));
  assert.equal(await lost.received("session/prompt"), 1);
  // A slash input is a command as the viewer reads it (Python's lstrip, so a full-width space too): its reply proves nothing.
  const compressed = f.launch("acp-v1", { RELAY_PROMPT: "answer" });
  assert.equal((await turn(new HermesControl(compressed.launch, options, attached), "　/compress")).result.input, undefined);
});

test("G067-C03 OpenClaw: an unapplied model sent nothing, a user row in the turn's transcript is recorded even when the turn failed, an unreadable transcript is unknown", async t => {
  const f = await peers(t), config = join(f.root, "openclaw.json");
  await writeFile(config, '{agents:{list:[{id:"main",default:true}]}}');
  const earlier = { role: "assistant", content: [{ type: "text", text: "earlier" }], stopReason: "stop", __openclaw: { seq: 5 } };
  const turnRows = [earlier, { role: "user", content: [{ type: "text", text: "do the work" }], __openclaw: { seq: 6 } },
    { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "You've hit your weekly limit", __openclaw: { seq: 7 } }];
  const gateway = (after: "rows" | "unreadable", patched?: string) => {
    let reads = 0;
    return async (method: string): Promise<unknown> => {
      if (method === "sessions.get") { if (reads++ === 0) return { messages: [earlier] }; if (after === "unreadable") throw new Error("gateway unavailable"); return { messages: turnRows }; }
      if (method === "models.list") return { models: [{ provider: "vision", id: "large", name: "Vision" }] };
      if (method === "sessions.patch") return { resolved: { modelProvider: patched ?? "vision", model: "large" } };
      if (method === "sessions.list") return { sessions: [] };
      if (method === "chat.history") return { messages: [] };
      throw new Error("no such Gateway method in this fixture: " + method);
    };
  };
  const openclaw = (env: Readonly<Record<string, string>>, request: (method: string) => Promise<unknown>) => {
    const peer = f.launch("acp-v1", { HOME: f.root, OPENCLAW_CONFIG_PATH: config, ...env });
    return { driver: new OpenClawControl(peer.launch, { ...options, env: { HOME: f.root, OPENCLAW_CONFIG_PATH: config } }, request), received: peer.received };
  };
  const mismatch = openclaw({ RELAY_PROMPT: "answer" }, gateway("rows", "other"));
  const notApplied = await turn(mismatch.driver, "do the work", "vision/large");
  assert.equal(notApplied.result.reason, "model_not_applied"); assert.equal(notApplied.result.input, "not_recorded");
  assert.equal(await mismatch.received("session/prompt"), 0);
  // The bridge reports end_turn, the transcript the error; its user row says the Gateway committed the prompt.
  const failed = await turn(openclaw({ RELAY_PROMPT: "silent" }, gateway("rows")).driver, "do the work");
  assert.equal(failed.result.status, "failed"); assert.equal(failed.result.error?.code, "NATIVE_QUOTA_EXCEEDED"); assert.equal(failed.result.input, "recorded");
  const unreadable = openclaw({ RELAY_PROMPT: "silent" }, gateway("unreadable"));
  const unknown = await turn(unreadable.driver, "do the work");
  assert.deepEqual(unknown.result, { status: "completed", reason: "end_turn" });
  assert.equal(await unreadable.received("session/prompt"), 1);
});

test("G067-C03 Claude Code refusals by their wire shape (claude-agent-acp 0.99.1): a model failure's errorKind is recorded, a refusal before enqueueing is not, the adapter's own kinds stay unknown", async t => {
  const f = await peers(t);
  // errorKindData(lastAssistantError): the model call failed after the prompt was written to the transcript.
  for (const errorKind of ["rate_limit", "overloaded", "max_output_tokens"]) {
    const { result } = await turn(new ClaudeControl(refusing(f, { code: -32603, message: "Internal error: API Error: request failed", data: { errorKind } }).launch, options), "do the work");
    assert.equal(result.status, "failed", errorKind); assert.equal(result.input, "recorded", errorKind);
  }
  // R8 C4: the session's query stream had ended (SESSION_ENDED_MESSAGE, no data) or the session is unknown (sessionNotFound).
  for (const error of [{ code: -32603, message: "Internal error: The Claude Agent session has ended. Please start a new session." }, { code: -32002, message: "Resource not found", data: { sessionId: "relay-session" } }]) {
    const peer = refusing(f, error), { result } = await turn(new ClaudeControl(peer.launch, options), "do the work");
    assert.equal(result.input, "not_recorded", error.message); assert.equal(await peer.received("session/prompt"), 1, "sent once, never again by the driver");
  }
  // The adapter's own failures can come before Claude Code read the prompt, and the C4 words with data are not the C4 refusal.
  for (const error of [{ code: -32603, message: "Internal error", data: { errorKind: "transport_lost" } }, { code: -32603, message: "Internal error", data: { errorKind: "worker_shutdown" } },
    { code: -32603, message: "Internal error: The Claude Agent session has ended. Please start a new session.", data: { errorKind: "no_result" } }, { code: -32603, message: "Internal error: API Error", data: { errorKind: "something_new" } },
    // A sign-in failure arrives as a bare auth_required, never with its errorKind, and the adapter's guard sends the same before a turn.
    { code: -32603, message: "Internal error: API Error", data: { errorKind: "authentication_failed" } }])
    assert.equal((await turn(new ClaudeControl(refusing(f, error).launch, options), "do the work")).result.input, undefined, JSON.stringify(error));
  const signedOut = await turn(new ClaudeControl(refusing(f, { code: -32000, message: "Authentication required" }).launch, options), "do the work");
  assert.equal(signedOut.result.input, undefined); assert.equal(signedOut.result.error?.code, "NATIVE_AUTH_REQUIRED");
  // A command prompt is never reported recorded, whatever its failure says.
  const compact = refusing(f, { code: -32603, message: "Internal error", data: { errorKind: "rate_limit" } }, { RELAY_COMMANDS: JSON.stringify([{ name: "compact", description: "compact" }]) });
  assert.equal((await turn(new ClaudeControl(compact.launch, options), "/compact")).result.input, undefined);
});

test("G067-C03 OpenCode refusals by their wire shape (2.2.5): a model failure after delivery is recorded, a refusal before delivery is not, the ambiguous ones stay unknown", async t => {
  const f = await peers(t), input = async (error: unknown) => (await turn(new OpenCodeControl(refusing(f, error).launch, options), "do the work")).result.input;
  // R8 O3: the turn reads a step or execution error only after delivery, as ServiceFailure of service "session", or auth_required for a provider sign-in.
  assert.equal(await input({ code: -32603, message: "Internal error: Rate limit exceeded", data: { service: "session", errorName: "provider.rate-limit" } }), "recorded");
  assert.equal(await input({ code: -32000, message: "Authentication required: provider authentication required", data: {} }), "recorded");
  // R8 O4 and the turn's own guards: an image without data, an attachment or skill the session refused, an unknown session, a
  // session already running an ACP prompt, a catalog still loading.
  for (const error of [{ code: -32602, message: "Invalid params: image content has no data or uri", data: { field: "prompt" } }, { code: -32602, message: "Invalid params: file is unreadable", data: { field: "files" } },
    { code: -32602, message: "Invalid params: Skill not found: review", data: { field: "skills" } }, { code: -32602, message: "Invalid params: session not found: relay-session", data: { sessionId: "relay-session" } },
    { code: -32603, message: "Internal error: Session already has an active ACP prompt: relay-session", data: { service: "session" } }, { code: -32603, message: "Internal error: models are not ready", data: { errorName: "CatalogNotReady" } }])
    assert.equal(await input(error), "not_recorded", error.message);
  // The server unreachable mid-request, or any other internal failure (a prompt identity conflict among them), can come either way.
  for (const error of [{ code: -32603, message: "Internal error: OpenCode server is unavailable", data: { errorName: "ServerUnavailable" } }, { code: -32603, message: "Internal error: Internal service failure", data: { errorName: "Error" } },
    { code: -32603, message: "Internal error: Rate limit exceeded", data: { errorName: "provider.rate-limit" } }, { code: -32602, message: "Invalid params: cursor", data: { field: "cursor" } }])
    assert.equal(await input(error), undefined, JSON.stringify(error));
});

test("G067-C03 Hermes v0.22.5's own words: a lost turn is unknown and never sent again; a later prompt it refuses while that turn is pending, and one refused before admission, are not recorded", async t => {
  const f = await peers(t), hermes = (details: string) => f.launch("acp-v1", { RELAY_PROMPT: "error:-32603:" + details });
  const recovery = (state: string) => "unknown_execution: do not resend accepted input; a turn in this session was lost when the gateway restarted and its outcome is unknown (" + state + "). Send `/discard adm-7` here (or `hermes sessions discard s1` in a terminal), then continue.";
  // `_unknown_recovery(submitted=True)`: this prompt's own turn was lost; it may have run.
  const lost = hermes(recovery("your input is accepted and kept")), unknown = await turn(new HermesControl(lost.launch, options, attached), "do the work");
  assert.equal(unknown.result.input, undefined); assert.equal(await lost.received("session/prompt"), 1);
  assert.equal(diagnostics(unknown.events).length, 1); assert.match(diagnostics(unknown.events)[0]!, /不要重发/u); assert.match(diagnostics(unknown.events)[0]!, /\/discard adm-7/u);
  // `_unknown_recovery(submitted=False)`: a later prompt refused before submit while the lost turn is pending.
  const pending = hermes(recovery("nothing was submitted")), refused = await turn(new HermesControl(pending.launch, options, attached), "do the work");
  assert.equal(refused.result.input, "not_recorded");
  assert.equal(diagnostics(refused.events).length, 1); assert.match(diagnostics(refused.events)[0]!, /\/discard adm-7/u); assert.doesNotMatch(diagnostics(refused.events)[0]!, /不要重发|可能已经执行/u);
  // R8 H4: an unknown session, and the owner's refusal of the submit by its bounded reason code, admit nothing.
  for (const reason of ["not_found", "invalid_params", "permission_denied"])
    assert.equal((await turn(new HermesControl(hermes(reason).launch, options, attached), "do the work")).result.input, "not_recorded", reason);
  // A failure after admission, or a reason code inside other words, is no such refusal.
  for (const reason of ["admitted_turn_failed", "permission_denied by the owner"])
    assert.equal((await turn(new HermesControl(hermes(reason).launch, options, attached), "do the work")).result.input, undefined, reason);
});

test("G067 Hermes: a /compress the viewer answers with its no-change report ran and changed nothing (noop); one that removed messages, and the same words for any other input, did not", async t => {
  const f = await peers(t), answered = async (prompt: string, reply: string) => (await turn(new HermesControl(f.launch("acp-v1", { RELAY_PROMPT: "answer", RELAY_REPLY: reply + "\n" }).launch, options, attached), prompt)).result;
  for (const reply of ["No changes from compression.", "No changes from compression: 12 messages\nApprox request size: ~1,234 tokens (unchanged)",
    "Compression refused (summary would grow the conversation): 12 messages preserved\nThe generated summary was larger than what it would replace; no messages were removed.",
    "Compression aborted: 12 messages preserved\nSummary generation failed; no messages were removed."])
    assert.deepEqual(await answered("/compress", reply), { status: "completed", reason: "end_turn", command: "noop" }, reply);
  // The registry's alias, in any case, is the same command.
  assert.equal((await answered(" /COMPACT", "No changes from compression.")).command, "noop");
  assert.deepEqual(await answered("/compress", "Compressed: 12 → 4 messages\nApprox request size: ~9,000 → ~2,000 tokens"), { status: "completed", reason: "end_turn" });
  assert.deepEqual(await answered("what does Hermes say when nothing compresses?", "No changes from compression."), { status: "completed", reason: "end_turn", input: "recorded" });
});

test("G067 Hermes: a slash word in neither its registry copy nor its catalog is prompt text, but its end proves nothing, so a newer Hermes command is never taken for recorded content", async t => {
  const f = await peers(t), answered = async (prompt: string) => (await turn(new HermesControl(f.launch("acp-v1", { RELAY_PROMPT: "answer" }).launch, options, attached), prompt)).result;
  const reader = new HermesControl(f.launch("acp-v1", {}).launch, options, attached);
  const catalog: NativeModelCatalog = { models: [], defaultModel: null, authentication: "ready", canSelect: false, commands: [{ name: "reset", description: "reset" }] };
  assert.deepEqual(reader.classify("/thanks for that", catalog), { kind: "content" }, "read as text, so it can carry what it owes"); await reader.close();
  for (const prompt of ["/thanks for that", "/Rewind-2 now"]) assert.deepEqual(await answered(prompt), { status: "completed", reason: "end_turn" }, prompt);
  // What no Hermes reads as a command stays proven by its answer: plain text, a path, a word unlike any command name.
  for (const prompt of ["thanks for that", "/etc/hosts 这一行是什么意思", "/你好"]) assert.deepEqual(await answered(prompt), { status: "completed", reason: "end_turn", input: "recorded" }, prompt);
});

test("G067 R0d each driver's own handling of an input follows its reading: leading whitespace and attachments decide the Hub's /export, Codex's thread operations and OpenCode's /compact alike", async t => {
  const f = await peers(t), file = await attachment(f.root, "notes.txt");
  // Claude Code reads `/export` as /export, so the Hub's export runs and nothing is sent; behind a space it is words and goes to
  // Claude Code (the CLI strips nothing, G074-F1); with an attachment it goes to Claude Code too, which reads it as content (the
  // CLI looks for a command only in the last block, the attachment's).
  const claudeExport = f.launch("acp-v1", { RELAY_PROMPT: "answer", CLAUDE_CONFIG_DIR: join(f.root, "no-claude-config") });
  assert.equal((await turn(new ClaudeControl(claudeExport.launch, options), "/export", undefined, true)).result.input, "not_recorded"); assert.equal(await claudeExport.received("session/prompt"), 0);
  const claudeSpaced = f.launch("acp-v1", { RELAY_PROMPT: "answer", CLAUDE_CONFIG_DIR: join(f.root, "no-claude-config") });
  const spacedExport = await turn(new ClaudeControl(claudeSpaced.launch, options), "  /export", undefined, true);
  assert.deepEqual([spacedExport.result.status, spacedExport.result.input], ["completed", "recorded"]); assert.deepEqual(await claudeSpaced.prompts(), ["  /export"]);
  const claudeAttached = f.launch("acp-v1", { RELAY_PROMPT: "answer" }), claude = new ClaudeControl(claudeAttached.launch, options);
  try {
    await claude.initialize(); const id = await claude.open(process.cwd()), catalog = await claude.models();
    assert.deepEqual(claude.classify("/export", catalog, ["file"]), { kind: "content" }, "with an attachment it is not the Hub's export, nor any command");
    const sent = await (await claude.startText(id, "/export", () => {}, [file])).result;
    assert.deepEqual([sent.status, sent.input], ["completed", "recorded"], "content: its answer proves it recorded"); assert.equal(await claudeAttached.received("session/prompt"), 1);
  } finally { await claude.close(); }
  // Codex: `/compact` with an attachment is an ordinary turn, as classify says.
  const codexCompact = f.launch("codex-app-server", { RELAY_TURN: "user-completed" });
  assert.deepEqual(new CodexControl(codexCompact.launch, options).classify("/compact", null, ["file"]), { kind: "content" });
  assert.equal((await turn(new CodexControl(codexCompact.launch, options), "/compact", undefined, false, [file])).result.input, "recorded");
  assert.equal(await codexCompact.received("turn/start"), 1); assert.equal(await codexCompact.received("thread/compact/start"), 0);
  // Hermes: `  /EXPORT` is its registry's export, which the Hub runs when Hermes lists none. With an image `/clear` is prompt text;
  // a file goes as a text pointer after a command, and Hermes still runs it (`/compress`; the Hub's own `/clear` is not sent).
  const hermesExport = f.launch("acp-v1", { RELAY_PROMPT: "answer" });
  const exported = await turn(new HermesControl(hermesExport.launch, options, attached), "  /EXPORT", undefined, true);
  assert.equal(exported.result.reason, "export_failed"); assert.equal(exported.result.input, "not_recorded"); assert.equal(await hermesExport.received("session/prompt"), 0);
  const hermesImage = f.launch("acp-v1", { RELAY_PROMPT: "answer" }), picture = await attachment(f.root, "screen.png", "image");
  assert.equal((await turn(new HermesControl(hermesImage.launch, options, attached), "/clear", undefined, false, [picture])).result.input, "recorded", "read as content, its answer proves it recorded");
  const hermesFile = f.launch("acp-v1", { RELAY_PROMPT: "answer" });
  assert.deepEqual((await turn(new HermesControl(hermesFile.launch, options, attached), "/compress", undefined, false, [file])).result, { status: "completed", reason: "end_turn" }, "a command: its answer proves nothing");
  assert.match((await hermesFile.prompts())[0]!, /^\/compress\n\n\[Attached file\] notes\.txt /u);
  // OpenCode trims an input before it looks for a command (`Iuf`): `  /compact` that answered nothing was ignored.
  const ignored = await turn(new OpenCodeControl(f.launch("acp-v1", { RELAY_PROMPT: "silent" }).launch, options), "  /compact");
  assert.equal(ignored.result.error?.code, "NATIVE_COMMAND_IGNORED");
});

test("G067 R0d each driver reads an input as its native side parses it: whitespace, names and paths, listed and hidden commands, effects by arguments", async t => {
  const f = await peers(t), launch = f.launch("acp-v1", {}).launch, codexLaunch = f.launch("codex-app-server", {}).launch;
  const listed = (...commands: readonly [string, ContextEffect][]): NativeModelCatalog => ({ models: [], defaultModel: null, authentication: "ready", canSelect: false,
    commands: commands.map(([name, contextEffect]) => ({ name, description: name, contextEffect })) });
  const read = (driver: HarnessControl, text: string, catalog: NativeModelCatalog | null = null, attachments: readonly ContentKind[] = []) => { const value = driver.classify!(text, catalog, attachments); return value.kind === "command" ? [value.kind, value.name, value.effect, value.args] : value.kind === "possible_command" ? [value.kind, value.name] : [value.kind]; };
  // Claude Code: a command only with the slash as the first character (nothing is stripped, G074-F1), a name the catalog lists is a
  // command and one it does not is words, except the hidden ones (it runs /clear unlisted, G074-F3), a path is content.
  const claude = new ClaudeControl(launch, options);
  assert.deepEqual(read(claude, "/clear"), ["command", "clear", "clear", ""]);
  assert.deepEqual(read(claude, "  /clear"), ["content"]); assert.deepEqual(read(claude, "　/clear"), ["content"]); assert.deepEqual(read(claude, "\n/clear"), ["content"]);
  assert.deepEqual(read(claude, "/remote-control now"), ["command", "remote-control", "none", "now"]);
  assert.deepEqual(read(claude, "/Users/me/notes.md 看看这个"), ["content"]);
  assert.deepEqual(read(claude, "/compact"), ["possible_command", "compact"]);
  assert.deepEqual(read(claude, "/compact keep the plan", listed(["compact", "compact"])), ["command", "compact", "compact", "keep the plan"]);
  assert.deepEqual(read(claude, "/my-command", listed(["compact", "compact"])), ["content"], "a word outside the catalog is words (G074-F3)");
  assert.deepEqual(read(claude, "/my-command"), ["possible_command", "my-command"], "without a catalog it waits for one");
  // Codex: exactly the driver's own thread operations, and a skill the catalog lists; leading whitespace is text for Codex.
  const codex = new CodexControl(codexLaunch, options);
  assert.deepEqual(read(codex, "/compact"), ["command", "compact", "compact", ""]); assert.deepEqual(read(codex, " /compact"), ["content"]);
  assert.deepEqual(read(codex, "/skill:review the diff"), ["possible_command", "skill:review"]);
  assert.deepEqual(read(codex, "/skill:review the diff", listed(["skill:review", "keep"])), ["command", "skill:review", "keep", "the diff"]);
  assert.deepEqual(read(codex, "/skill:other", listed(["skill:review", "keep"])), ["content"]); assert.deepEqual(read(codex, "/review"), ["content"]);
  // The Hub's clear: `/clear`, `/new` and `/reset` alone; with arguments, a leading space or an attachment they are text.
  assert.deepEqual(read(codex, "/clear"), ["command", "clear", "clear", ""]); assert.deepEqual(read(codex, "/new "), ["command", "new", "clear", ""]);
  assert.deepEqual(read(codex, "/clear now"), ["content"]); assert.deepEqual(read(codex, " /clear"), ["content"]); assert.deepEqual(read(codex, "/clear", null, ["file"]), ["content"]);
  // With attachments the thread operations are text for Codex; a listed skill is still a skill.
  assert.deepEqual(read(codex, "/compact", null, ["file"]), ["content"]); assert.deepEqual(read(codex, "/export", null, ["image"]), ["content"]);
  assert.deepEqual(read(codex, "/skill:review it", listed(["skill:review", "keep"]), ["image"]), ["command", "skill:review", "keep", "it"]);
  // OpenCode: listed commands and its own /compact; any other slash input is text for the model.
  const opencode = new OpenCodeControl(launch, options);
  assert.deepEqual(read(opencode, "/compact"), ["command", "compact", "compact", ""]); assert.deepEqual(read(opencode, "/review"), ["possible_command", "review"]);
  assert.deepEqual(read(opencode, "/review now", listed(["review", "keep"])), ["command", "review", "keep", "now"]); assert.deepEqual(read(opencode, "/nope", listed(["review", "keep"])), ["content"]);
  // Its ACP has no clear: the Hub's `/clear`, `/new` and `/reset` alone, trimmed like its commands, without an attachment.
  assert.deepEqual(read(opencode, "/clear"), ["command", "clear", "clear", ""]); assert.deepEqual(read(opencode, " /new\t"), ["command", "new", "clear", ""]);
  assert.deepEqual(read(opencode, "/reset the plan"), ["possible_command", "reset"]); assert.deepEqual(read(opencode, "/clear", null, ["file"]), ["possible_command", "clear"]);
  assert.deepEqual(read(opencode, "/clear", listed(["review", "keep"])), ["command", "clear", "clear", ""]); assert.deepEqual(read(opencode, "/reset the plan", listed(["review", "keep"])), ["content"]);
  // It trims an input before it looks for its command (`Iuf`), attachments or not.
  assert.deepEqual(read(opencode, "  /compact  "), ["command", "compact", "compact", ""]); assert.deepEqual(read(opencode, "\t/review  now ", listed(["review", "keep"])), ["command", "review", "keep", "now"]);
  assert.deepEqual(read(opencode, "/compact", null, ["image", "file"]), ["command", "compact", "compact", ""]); assert.deepEqual(read(opencode, "/ compact"), ["content"]);
  // Hermes: Python's lstrip() and split() (full-width and no-break spaces, not U+FEFF); a word its registry resolves, in any
  // case and by alias, or one it announced, is a command, with effects by registry name and arguments; a path is text.
  const hermes = new HermesControl(launch, options, attached);
  assert.deepEqual(read(hermes, "　/clear"), ["command", "clear", "clear", ""]); assert.deepEqual(read(hermes, " /undo　2 "), ["command", "undo", "rewind", "2"]);
  assert.deepEqual(read(hermes, "/compress --preview"), ["command", "compress", "none", "--preview"]); assert.deepEqual(read(hermes, "/compress"), ["command", "compress", "compact", ""]);
  assert.deepEqual(read(hermes, "/compress focus on tests"), ["command", "compress", "compact", "focus on tests"]);
  for (const flag of ["--DRY-RUN", "--dryrun", "--Preview", "--aggressive"]) assert.deepEqual(read(hermes, "/compress keep " + flag), ["command", "compress", "none", "keep " + flag], flag);
  assert.deepEqual(read(hermes, "/queue later"), ["command", "queue", "keep", "later"]); assert.deepEqual(read(hermes, "/CLEAR"), ["command", "clear", "clear", ""]);
  for (const [typed, name, effect] of [["/reset", "new", "clear"], ["/compact", "compress", "compact"], ["/q later", "queue", "keep"], ["/s left", "steer", "keep"], ["/fork", "branch", "none"], ["/ctx", "context", "none"], ["/V", "version", "none"]] as const)
    assert.deepEqual(read(hermes, typed).slice(0, 3), ["command", name, effect], typed);
  assert.deepEqual(read(hermes, "/sessions list"), ["command", "sessions", "unknown", "list"], "a registry command the gateway's slash.exec answers");
  assert.deepEqual(read(hermes, "/etc/hosts 这一行是什么意思"), ["content"]); assert.deepEqual(read(hermes, "/tmp/x"), ["content"]); assert.deepEqual(read(hermes, "/ clear"), ["content"]);
  // A word outside the registry waits for the catalog: a command when this Hermes announced it, text otherwise.
  assert.deepEqual(read(hermes, "/skill-from-gateway"), ["possible_command", "skill-from-gateway"]);
  assert.deepEqual(read(hermes, "/skill-from-gateway now", listed(["skill-from-gateway", "keep"])), ["command", "skill-from-gateway", "keep", "now"]);
  assert.deepEqual(read(hermes, "/thanks for that", listed(["skill-from-gateway", "keep"])), ["content"]);
  // With an image the viewer runs no command; a file (a text pointer here) and audio (which its converter drops) leave the text alone.
  assert.deepEqual(read(hermes, "/clear", null, ["image"]), ["content"]); assert.deepEqual(read(hermes, "/clear", null, ["file", "image"]), ["content"]);
  assert.deepEqual(read(hermes, "/clear", null, ["file"]), ["command", "clear", "clear", ""]); assert.deepEqual(read(hermes, "/clear", null, ["audio"]), ["command", "clear", "clear", ""]);
  assert.deepEqual(read(hermes, "﻿/clear"), ["content"]); assert.deepEqual(read(hermes, "/"), ["content"]);
  // OpenClaw: the bridge's listed commands, with `/reset soft` keeping the transcript (a compaction) and `/reset` clearing it.
  const openclaw = new OpenClawControl(launch, options, async () => { throw new Error("no Gateway"); }), bridge = listed(["new", "clear"], ["reset", "clear"], ["think", "none"]);
  assert.deepEqual(read(openclaw, "/reset soft", bridge), ["command", "reset", "compact", "soft"]); assert.deepEqual(read(openclaw, "/reset", bridge), ["command", "reset", "clear", ""]);
  assert.deepEqual(read(openclaw, "/new", bridge), ["command", "new", "clear", ""]); assert.deepEqual(read(openclaw, "/think high", bridge), ["command", "think", "none", "high"]);
  assert.deepEqual(read(openclaw, "/nope", bridge), ["content"]); assert.deepEqual(read(openclaw, "/nope"), ["possible_command", "nope"]);
  // The Hub's clear words are commands whatever the catalog lists, or none yet; `/reset soft` stays the bridge's own.
  assert.deepEqual(read(openclaw, "/new"), ["command", "new", "clear", ""]); assert.deepEqual(read(openclaw, "/clear"), ["command", "clear", "clear", ""]); assert.deepEqual(read(openclaw, "/reset soft"), ["command", "reset", "compact", "soft"]);
  for (const driver of [claude, codex, opencode, hermes, openclaw]) await driver.close();
});
