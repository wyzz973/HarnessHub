import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeControl } from "../../src/adapters/control/claude.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { HermesControl } from "../../src/adapters/control/hermes.js";
import type { HermesGatewayPreflight } from "../../src/adapters/control/hermes-gateway.js";
import { OpenClawControl } from "../../src/adapters/control/openclaw.js";
import { dataRootPlacement, dataRootWarning } from "../../src/cli/session-application.js";
import { listedCommand, nativeConversationId, type BackendResult, type CleanupEvidence, type ControlLaunch, type ControlOptions, type HarnessControl, type NativeCommand } from "../../src/contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionRuntimeOptions, type SessionSnapshot } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { MAX_SESSION_BYTES, utf8Bytes } from "../../src/contexts/session/domain/state.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/migrate.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import type { RelayRecord } from "../../src/contexts/session/domain/relay/packet.js";

// G067 (ADR-055 §7.6, P0 on Session v12): the native position rule, command reading before authorization, budgeting only
// what is sent, sending an input alone, stranded switches and the data directory check, through the formal Runtime and a
// real SqliteSessionStore. Harnesses are in-process fakes, or the real drivers on minimal peers this file writes into a
// temporary directory; nothing here runs a Harness.

const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
interface World { readonly root: string; readonly store: SqliteSessionStore; readonly configuration: SessionConfiguration; runtime(factory: SessionBindingFactory, options?: Partial<SessionRuntimeOptions>): SessionRuntime }
async function world(t: test.TestContext): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "relay-p0-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const store = new SqliteSessionStore(join(root, "data")), runtimes: SessionRuntime[] = [];
  t.after(async () => {
    for (const app of runtimes) {
      try { await app.close(); }
      catch (error) { if (!(error instanceof SessionError) || !["SESSION_BLOCKED", "PUBLICATION_FAILED", "STORAGE_UNAVAILABLE", "OWNER_LOST"].includes(error.code)) throw error; }
    }
    try { store.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  let next = 0;
  return { root, store, configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    runtime(factory, options = {}) {
      const app = new SessionRuntime(store, factory, { id: () => String(++next), now: () => new Date("2026-11-03T00:00:00Z"), publish: () => {},
        fingerprint: value => createHash("sha256").update(value).digest("hex"), ...options });
      runtimes.push(app); return app;
    } };
}
/** Every event of a conversation, in order. */
function events(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
function ended(store: SqliteSessionStore, id: SessionId, run: string): Readonly<Record<string, unknown>> {
  const found = events(store, id).find(row => row.type === "run.ended" && row.data.runId === run);
  assert.ok(found, "run.ended of " + run); return found.data;
}
/** Whether a prompt carries a relay packet (ADR-055 §5), read from its layout by the test's own reader. */
function isPacket(prompt: string): boolean { return readRelayPrompt(prompt).packet; }
/** The input a prompt carries: the packet's current words after its end line, or the prompt itself when it went as typed. */
function inputOf(prompt: string): string { return readRelayPrompt(prompt).currentInput.text; }
function binding(state: SessionSnapshot, harnessId: string) { return state.nativeBindings?.find(row => row.harnessId === harnessId && row.status !== "archived"); }
async function sent(app: SessionRuntime, id: SessionId, text: string, key: string, relay?: { readonly attach: "none" }): Promise<PublicRun> {
  const receipt = app.send(id, text, key, [], relay); await app.wait(id);
  return app.read(id).runs.find(row => row.id === receipt.runId)!;
}
async function switched(app: SessionRuntime, id: SessionId, selection: SelectionRequest, key: string): Promise<void> {
  app.switch(id, selection, key); await app.wait(id); assert.equal(app.read(id).selection.harnessId, selection.harnessId);
}

/** How a fake Harness ends one prompt: completed and recorded unless said otherwise; held until its program is ended; or lost. */
type Ending = BackendResult | "hold" | "lost";
/**
 * In-process fake Harnesses alpha and bravo with resumable native sessions that can be forked: each prompt is recorded with
 * the Harness it reached, each started program and opened session too. `ending` decides how a prompt ends; `/model <id>`
 * switches the native session's model, which it reports after the Turn.
 */
class FakeHarnesses implements SessionBindingFactory {
  readonly prompts: { readonly harnessId: string; readonly text: string }[] = [];
  readonly started: string[] = [];
  readonly opened: { readonly harnessId: string; readonly model: string | undefined; readonly checkpoint: string | undefined }[] = [];
  private readonly models = new Map<string, string | null>();
  constructor(private readonly ending: (harnessId: string, text: string) => Ending = () => ({ status: "completed", reason: "fake", input: "recorded" }), private readonly commands: readonly NativeCommand[] = []) {}
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha" && request.harnessId !== "bravo") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp", ...(request.nativeModel === undefined ? {} : { nativeModel: request.nativeModel }) };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId; let opened = false, lose: ((error: Error) => void) | null = null;
    const control: HarnessControl = {
      initialize: async () => { this.started.push(harnessId); return { protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }; },
      open: async (_cwd, model, _options, checkpoint) => {
        opened = true; this.opened.push({ harnessId, model, checkpoint }); if (model !== undefined) this.models.set(harnessId, model);
        return nativeConversationId("native-" + harnessId);
      },
      checkpoint: async () => opened ? "private-native-" + harnessId : null,
      fork: async checkpoint => checkpoint + "-branch",
      models: async () => ({ models: [{ id: "model-a", name: "A" }, { id: "model-x", name: "X" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: this.commands }),
      nativeConfig: async () => ({ model: this.models.get(harnessId) ?? null, options: {} }),
      startText: async (_id, text: string, output) => {
        this.prompts.push({ harnessId, text });
        const model = /^\/model\s+(\S+)/u.exec(text); if (model) this.models.set(harnessId, model[1]!);
        const ending = this.ending(harnessId, text);
        if (ending !== "lost") output({ type: "text", text: "reply from " + harnessId });
        const result = ending === "hold" ? new Promise<BackendResult>((_resolve, reject) => { lose = reject; })
          : ending === "lost" ? new Promise<BackendResult>((_resolve, reject) => { setImmediate(() => reject(new SessionError("CONTROL_FAILED", "the connection ended without a result"))); })
          : Promise.resolve(ending);
        return { result, requestStop: async () => ({ requested: true }) };
      },
      close: async () => { lose?.(new SessionError("CLOSED", "the program was ended")); return clean; },
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  /** What reached `harnessId`, in order. */
  to(harnessId: string): readonly string[] { return this.prompts.filter(row => row.harnessId === harnessId).map(row => row.text); }
}
const recorded = { status: "completed", reason: "fake", input: "recorded" } as const;
const unknownEnd = { status: "completed", reason: "fake" } as const;
const notRecorded = { status: "failed", reason: "fake", error: { code: "FAKE_REFUSED", message: "refused before insertion" }, input: "not_recorded" } as const;

test("G067-C01 the native position follows the v12 rule: nothing owed advances, carried recorded advances, carried unknown advances only once resent, carried not recorded never", async t => {
  const f = await world(t), endings = new Map<string, Ending>([["a1 nothing owed, not recorded", notRecorded], ["a3 carried unknown", unknownEnd], ["a4 resent unknown", unknownEnd], ["b3 carried not recorded", notRecorded]]);
  const fake = new FakeHarnesses((_harness, text) => endings.get(inputOf(text)) ?? recorded);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  // Nothing owed: the Turn advances even though the native side never took its input, so the next one goes as typed.
  const a1 = await sent(app, session.id, "a1 nothing owed, not recorded", "a1");
  assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, a1.id); assert.equal(ended(f.store, session.id, a1.id).input, "not_recorded");
  const a2 = await sent(app, session.id, "a2 as typed", "a2");
  assert.equal(inputOf(fake.to("alpha")[0]!), "a1 nothing owed, not recorded"); assert.equal(fake.to("alpha")[1], "a2 as typed");
  assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, a2.id);
  // Carried and recorded: bravo's first Turn owes alpha's two and advances.
  await switched(app, session.id, { harnessId: "bravo" }, "to-b");
  const b1 = await sent(app, session.id, "b1 carried recorded", "b1"), b2 = await sent(app, session.id, "b2 as typed", "b2");
  assert.ok(isPacket(fake.to("bravo")[0]!)); assert.deepEqual(b1.sourceRunIds, [a1.id, a2.id]); assert.equal(fake.to("bravo")[1], "b2 as typed");
  assert.equal(binding(app.read(session.id), "bravo")?.throughRunId, b2.id);
  // Carried with an unknown outcome: alpha does not advance; the next Turn sends the facts again (relayResendOf) and then advances.
  await switched(app, session.id, { harnessId: "alpha" }, "to-a");
  const a3 = await sent(app, session.id, "a3 carried unknown", "a3");
  assert.deepEqual(a3.sourceRunIds, [b1.id, b2.id]); assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, a2.id);
  assert.equal(ended(f.store, session.id, a3.id).input, "unknown"); assert.equal(ended(f.store, session.id, a3.id).relayResendOf, undefined);
  const a4 = await sent(app, session.id, "a4 resent unknown", "a4");
  assert.deepEqual(a4.sourceRunIds, [b1.id, b2.id, a3.id]); assert.equal(ended(f.store, session.id, a4.id).relayResendOf, a3.id);
  assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, a4.id, "the facts were sent twice; the position moves after the one resend");
  const a5 = await sent(app, session.id, "a5 as typed", "a5");
  assert.equal(fake.to("alpha").at(-1), "a5 as typed"); assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, a5.id);
  // Carried and not recorded: bravo does not advance, and the next Turn is no resend (nothing reached bravo).
  await switched(app, session.id, { harnessId: "bravo" }, "to-b-again");
  const b3 = await sent(app, session.id, "b3 carried not recorded", "b3");
  assert.equal(binding(app.read(session.id), "bravo")?.throughRunId, b2.id); assert.equal(ended(f.store, session.id, b3.id).input, "not_recorded");
  const b4 = await sent(app, session.id, "b4 carried again", "b4");
  assert.deepEqual(b4.sourceRunIds, [a3.id, a4.id, a5.id, b3.id]); assert.equal(ended(f.store, session.id, b4.id).relayResendOf, undefined);
  assert.equal(binding(app.read(session.id), "bravo")?.throughRunId, b4.id);
  // The snapshot never stores the driver's evidence: only the end event keeps it.
  assert.ok(app.read(session.id).runs.every(row => row.backend === null || !("input" in row.backend)));
});

test("G067 acceptance (J1 M1): a command owing facts moves no native position, so a branch at the Turn before leaving is not a native fork", async t => {
  const f = await world(t), fake = new FakeHarnesses(undefined, [{ name: "review", description: "review", contextEffect: "keep" }]);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const a1 = await sent(app, session.id, "first on alpha", "a1");
  await switched(app, session.id, { harnessId: "bravo" }, "to-b"); await sent(app, session.id, "bravo works", "b1");
  await switched(app, session.id, { harnessId: "alpha" }, "to-a");
  const review = await sent(app, session.id, "/review the change", "review");
  assert.equal(fake.to("alpha").at(-1), "/review the change", "a command goes as typed and carries nothing"); assert.deepEqual(review.sourceRunIds, []);
  assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, a1.id);
  assert.equal(ended(f.store, session.id, review.id).contextEffect, "keep");
  assert.ok(events(f.store, session.id).some(row => row.type === "run.native_command" && row.data.runId === review.id && row.data.contextEffect === "keep"));
  // alpha's native session ran the command after a1: it is no longer exactly at a1.
  const branch = app.fork(session.id, "branch-at-a1", a1.id);
  assert.equal(branch.nativeBindings, undefined, "a1 is not where alpha's native session is");
  // The facts the command did not carry go with the next content input.
  await sent(app, session.id, "what did bravo do?", "a3");
  assert.ok(isPacket(fake.to("alpha").at(-1)!) && fake.to("alpha").at(-1)!.includes("bravo works"));
});

test("G067 acceptance (J1 M1): after a command Turn `/model X` that owed facts, the next content Turn still runs X", async t => {
  const f = await world(t), fake = new FakeHarnesses(undefined, [{ name: "model", description: "switch the model", contextEffect: "none" }]);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha", nativeModel: "model-a" }, "create");
  await sent(app, session.id, "first on alpha", "a1");
  await switched(app, session.id, { harnessId: "bravo" }, "to-b"); await sent(app, session.id, "bravo works", "b1");
  await switched(app, session.id, { harnessId: "alpha", nativeModel: "model-a" }, "to-a");
  const command = await sent(app, session.id, "/model model-x", "model");
  assert.equal(binding(app.read(session.id), "alpha")?.observed?.model, "model-x"); assert.notEqual(binding(app.read(session.id), "alpha")?.throughRunId, command.id);
  await sent(app, session.id, "keep going", "a3");
  assert.equal(fake.opened.at(-1)?.model, "model-x", "the model the native session switched to is carried, not reverted");
  assert.ok(events(f.store, session.id).some(row => row.type === "native.config_carried" && row.data.model === "model-x"));
});

test("G067 acceptance (J1 M1): in a single-Harness conversation the input after `/compact` goes as typed, without an envelope", async t => {
  const f = await world(t), fake = new FakeHarnesses(undefined, [{ name: "compact", description: "compact", contextEffect: "compact" }]);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  await sent(app, session.id, "first", "a1");
  const compact = await sent(app, session.id, "/compact", "compact");
  assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, compact.id, "nothing owed: even a command advances");
  assert.equal(ended(f.store, session.id, compact.id).contextEffect, "compact");
  await sent(app, session.id, "after compaction", "a3");
  assert.deepEqual(fake.to("alpha").slice(1), ["/compact", "after compaction"]);
});

test("G067 after a native reset the first carried Turn on the new native session is no resend of the archived one's Turn; the next carried Turn resends its own", async t => {
  const f = await world(t), lostInputs = new Set(["old lost", "new lost", "again lost"]);
  const fake = new FakeHarnesses((_harness, text) => lostInputs.has(inputOf(text)) ? unknownEnd : recorded, [{ name: "model", description: "switch the model", contextEffect: "none" }]);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  await sent(app, session.id, "a1", "a1"); await switched(app, session.id, { harnessId: "bravo" }, "to-b"); await sent(app, session.id, "b1", "b1");
  await switched(app, session.id, { harnessId: "alpha" }, "to-a");
  const old = await sent(app, session.id, "old lost", "old");
  assert.equal(ended(f.store, session.id, old.id).input, "unknown"); assert.ok(old.sourceRunIds.length > 0);
  app.resetNative(session.id, "reset", app.read(session.id).epoch);
  // A command opens the new native session; it carries nothing, so the facts stay owed.
  const command = await sent(app, session.id, "/model model-x", "command");
  assert.deepEqual(command.sourceRunIds, []); assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, null);
  // The first carried attempt in the new native session: `old` carried its facts to the archived one.
  const fresh = await sent(app, session.id, "new lost", "new");
  assert.equal(ended(f.store, session.id, fresh.id).relayResendOf, undefined); assert.equal(ended(f.store, session.id, fresh.id).input, "unknown");
  assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, null, "an unknown first attempt moves nothing");
  const again = await sent(app, session.id, "again lost", "again");
  assert.equal(ended(f.store, session.id, again.id).relayResendOf, fresh.id); assert.equal(binding(app.read(session.id), "alpha")?.throughRunId, again.id);
});

test("G067 a branch's first Turn carried only the history it started from: without evidence either way the next Turn is its resend, so the history goes twice and the position then moves", async t => {
  const f = await world(t), fake = new FakeHarnesses((_harness, text) => /^q\d$/u.test(inputOf(text)) ? unknownEnd : recorded);
  const app = f.runtime(fake), source = await app.create(f.configuration, { harnessId: "alpha" }, "source");
  const first = await sent(app, source.id, "source one", "s1"); await sent(app, source.id, "source two", "s2");
  const branch = app.fork(source.id, "branch", first.id); await app.wait(branch.id);
  assert.equal(branch.nativeBindings, undefined, "alpha's native session is past the branch point");
  const q1 = await sent(app, branch.id, "q1", "q1");
  assert.deepEqual(q1.sourceRunIds, [], "only the branch history was owed");
  assert.ok(events(f.store, branch.id).some(row => row.type === "run.context_prepared" && row.data.runId === q1.id && row.data.carriedOrigin === true));
  assert.equal(binding(app.read(branch.id), "alpha")?.throughRunId, null);
  const q2 = await sent(app, branch.id, "q2", "q2");
  assert.equal(ended(f.store, branch.id, q2.id).relayResendOf, q1.id, "the history q1 carried is sent again once"); assert.equal(binding(app.read(branch.id), "alpha")?.throughRunId, q2.id);
  await sent(app, branch.id, "q3", "q3");
  const branchPrompts = fake.to("alpha").slice(-3);
  assert.deepEqual(branchPrompts.map(prompt => isPacket(prompt) && prompt.includes("source one")), [true, true, false], "the branch history went twice, then the input as typed");
  assert.equal(branchPrompts[2], "q3");
});

test("G067 a branch without a native fork owes the history it started from to the native session its first Turn opens until a Turn carried it there, whatever that first Turn was; an exact native fork holds it already", async t => {
  const f = await world(t), fake = new FakeHarnesses(undefined, [{ name: "review", description: "review", contextEffect: "keep" }]);
  const app = f.runtime(fake), source = await app.create(f.configuration, { harnessId: "alpha" }, "source");
  await sent(app, source.id, "source one", "s1"); await switched(app, source.id, { harnessId: "bravo" }, "to-b");
  const last = await sent(app, source.id, "source two on bravo", "s2");
  await switched(app, source.id, { harnessId: "alpha" }, "to-a");
  for (const [key, first, relay] of [["alone", "first alone", { attach: "none" } as const], ["command", "/review the plan", undefined]] as const) {
    const branch = app.fork(source.id, "fork-" + key, last.id); await app.wait(branch.id);
    assert.equal(branch.nativeBindings, undefined, "alpha's native session is not at the branch point");
    const opening = await sent(app, branch.id, first, key + "-1", relay);
    assert.equal(fake.to("alpha").at(-1), first, "sent exactly as typed"); assert.equal(binding(app.read(branch.id), "alpha")?.throughRunId, null, key + ": the branch history is still owed");
    const next = await sent(app, branch.id, "now continue", key + "-2"), prompt = fake.to("alpha").at(-1)!;
    assert.ok(isPacket(prompt) && prompt.includes("source two on bravo"), key + ": the branch history goes with the next content input");
    assert.deepEqual(next.sourceRunIds, [opening.id]); assert.equal(binding(app.read(branch.id), "alpha")?.throughRunId, next.id);
    await sent(app, branch.id, "and again", key + "-3"); assert.equal(fake.to("alpha").at(-1), "and again", "once carried, nothing is owed");
  }
  // alpha's native session at the source's last Turn: the branch is its exact native fork, which already holds the history.
  const third = await sent(app, source.id, "source three on alpha", "s3");
  const exact = app.fork(source.id, "fork-exact", third.id); await app.wait(exact.id);
  assert.equal(binding(app.read(exact.id), "alpha")?.status, "ready");
  await sent(app, exact.id, "/review the branch", "exact-1"); await sent(app, exact.id, "and go on", "exact-2");
  assert.deepEqual(fake.to("alpha").slice(-2), ["/review the branch", "and go on"]);
});

/**
 * A minimal ACP v1 agent for the real drivers, resumable by session/load. RELAY_PROMPT says how it ends a prompt: `answer`
 * (a reply, RELAY_REPLY or "ok", and end_turn), `silent`, or `error` (refused with RELAY_DETAILS in its error data, as the
 * Python ACP SDK refuses). Every message it received is appended to RELAY_TRACE.
 */
const ACP_PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.RELAY_TRACE, behaviour = process.env.RELAY_PROMPT ?? "answer";
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const commands = sessionId => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: JSON.parse(process.env.RELAY_COMMANDS ?? "[]") });
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line), params = message.params ?? {};
  if (trace) appendFileSync(trace, line + "\\n");
  if (message.method === "initialize") { send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "provider", name: "Provider" }], agentInfo: { name: "relay-peer", version: "1.0.0" } } }); return; }
  if (message.method === "session/new") { send({ id: message.id, result: { sessionId: "relay-session" } }); commands("relay-session"); return; }
  if (message.method === "session/load") { send({ id: message.id, result: {} }); commands(params.sessionId); return; }
  if (message.method === "session/prompt") {
    if (behaviour === "error") { send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: process.env.RELAY_DETAILS } } }); return; }
    if (behaviour === "answer") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.RELAY_REPLY ?? "ok" } });
    send({ id: message.id, result: { stopReason: "end_turn" } }); return;
  }
  if (message.method === "session/cancel") return;
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;
/** A minimal Codex app-server, resumable by thread/resume. RELAY_TURN is `reject` (turn/start refused before any turn) or `answer`. */
const CODEX_PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.RELAY_TRACE, behaviour = process.env.RELAY_TURN ?? "answer";
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
const notify = (method, params) => send({ method, params });
let turns = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (trace) appendFileSync(trace, line + "\\n");
  if (message.method === "initialize") { send({ id: message.id, result: { userAgent: "relay-codex/1.0.0 (fixture)" } }); return; }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" || message.method === "thread/resume") { notify("thread/started", { thread: { id: "relay-thread" } }); send({ id: message.id, result: { thread: { id: "relay-thread" }, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } } }); return; }
  if (message.method === "turn/start") {
    if (behaviour === "reject") { send({ id: message.id, error: { code: -32600, message: "input exceeds the maximum length" } }); return; }
    const id = process.pid + "-" + ++turns, base = { threadId: "relay-thread", turnId: id };
    notify("turn/started", { threadId: "relay-thread", turn: { id, status: "inProgress" } });
    send({ id: message.id, result: { turn: { id, status: "inProgress" } } });
    for (const method of ["item/started", "item/completed"]) notify(method, { ...base, item: { type: "userMessage", id: "user-" + id, content: message.params.input } });
    notify("item/agentMessage/delta", { ...base, itemId: "reply-" + id, delta: "ok" });
    notify("turn/completed", { threadId: "relay-thread", turn: { id, status: "completed" } }); return;
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;
const attached: HermesGatewayPreflight = async () => ({ kind: "attach", verdict: "A", explanation: "fixture gateway", evidence: [] });
/**
 * The real drivers of Claude Code, Codex, Hermes and OpenClaw, each on its own minimal peer: what a connection's peer does
 * is `behaviour(harnessId, n)` for the n-th connection to that Harness, and OpenClaw's Gateway is `gateway(n)`. What each
 * peer received is read from its trace.
 */
class RealDrivers implements SessionBindingFactory {
  private readonly counts = new Map<string, number>();
  constructor(private readonly root: string, private readonly behaviour: (harnessId: string, n: number) => Readonly<Record<string, string>>,
    private readonly gateway: (n: number) => (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown> = () => async () => { throw new Error("no Gateway"); }) {}
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!["claude", "codex", "hermes", "openclaw"].includes(request.harnessId)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-control", ...(request.nativeModel === undefined ? {} : { nativeModel: request.nativeModel }) };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId, n = (this.counts.get(harnessId) ?? 0) + 1; this.counts.set(harnessId, n);
    const env = { HOME: this.root, RELAY_TRACE: this.trace(harnessId), OPENCLAW_CONFIG_PATH: join(this.root, "openclaw.json"), CLAUDE_CONFIG_DIR: join(this.root, "claude"), ...this.behaviour(harnessId, n) };
    const launch: ControlLaunch = { protocol: harnessId === "codex" ? "codex-app-server" : "acp-v1", executable: process.execPath, args: [join(this.root, harnessId === "codex" ? "codex-peer.mjs" : "acp-peer.mjs")], env };
    const options: ControlOptions = { cwd: configuration.workspace, env, requestTimeoutMs: 3000, runTimeoutMs: 6000, maxFrameBytes: 4 * 1024 * 1024, maxDiagnosticBytes: 16 * 1024, closeGraceMs: 150 };
    const control = harnessId === "claude" ? new ClaudeControl(launch, options) : harnessId === "codex" ? new CodexControl(launch, options)
      : harnessId === "hermes" ? new HermesControl(launch, options, attached) : new OpenClawControl(launch, options, this.gateway(n));
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  trace(harnessId: string): string { return join(this.root, "trace-" + harnessId + ".ndjson"); }
  /** The text of every prompt `harnessId` received, in order. */
  async prompts(harnessId: string): Promise<readonly string[]> {
    let text: string;
    try { text = await readFile(this.trace(harnessId), "utf8"); } catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
    return text.trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: { prompt?: { text?: string }[]; input?: { text?: string }[] } })
      .flatMap(row => row.method === "session/prompt" ? [row.params?.prompt?.[0]?.text ?? ""] : row.method === "turn/start" ? [row.params?.input?.[0]?.text ?? ""] : []);
  }
}
async function drivers(f: World, behaviour: (harnessId: string, n: number) => Readonly<Record<string, string>>, gateway?: (n: number) => (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>): Promise<RealDrivers> {
  await writeFile(join(f.root, "acp-peer.mjs"), ACP_PEER); await writeFile(join(f.root, "codex-peer.mjs"), CODEX_PEER);
  await writeFile(join(f.root, "openclaw.json"), '{agents:{list:[{id:"main",default:true}]}}');
  return new RealDrivers(f.root, behaviour, gateway);
}

test("G067-C02 single-Harness /export, /clear, an unapplied OpenClaw model and a Codex refusal before any turn: the next input goes exactly as typed", { timeout: 60000 }, async t => {
  const f = await world(t);
  // OpenClaw's Gateway: the selected model is applied before each prompt; on the second connection the session row cannot
  // be read and the Gateway resolves another model, so that Turn ends with model_not_applied before its prompt.
  const gateway = (n: number) => async (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (method === "models.list") return { models: [{ provider: "vision", id: "large", name: "Vision" }] };
    if (method === "sessions.list") { if (n === 2) throw new Error("row unavailable"); return { sessions: [{ key: params.search, modelProvider: "vision", model: "large" }] }; }
    if (method === "sessions.patch") return { resolved: n === 2 ? { modelProvider: "other", model: "model" } : { modelProvider: "vision", model: "large" } };
    if (method === "sessions.get") return { messages: [] };
    if (method === "chat.history") return { messages: [] };
    throw new Error("unexpected OpenClaw method " + method);
  };
  const real = await drivers(f, (harnessId, n) => harnessId === "codex" ? { RELAY_TURN: n === 2 ? "reject" : "answer" } : { RELAY_PROMPT: "answer" }, gateway);
  const app = f.runtime(real);
  // Claude Code: the Hub's own /export reaches nothing, and /clear runs as typed; neither leaves facts owed.
  const claude = await app.create(f.configuration, { harnessId: "claude" }, "claude");
  await sent(app, claude.id, "first question", "c1");
  const exported = await sent(app, claude.id, "/export", "c2");
  assert.equal(ended(f.store, claude.id, exported.id).input, "not_recorded"); assert.equal(binding(app.read(claude.id), "claude")?.throughRunId, exported.id);
  await sent(app, claude.id, "after export", "c3");
  const cleared = await sent(app, claude.id, "/clear", "c4");
  assert.equal(ended(f.store, claude.id, cleared.id).contextEffect, "clear", "the hidden /clear runs as Claude Code's own command");
  await sent(app, claude.id, "after clear", "c5");
  const claudePrompts = await real.prompts("claude");
  // Nothing owed is nothing carried, a new native session's first Turn included (the v12 envelope wrapped it; the packet
  // never does): every input goes exactly as typed, and /export reached nothing.
  assert.deepEqual(claudePrompts, ["first question", "after export", "/clear", "after clear"]);
  // OpenClaw: the unapplied model sent nothing (not recorded), and the next input goes as typed.
  const openclaw = await app.create(f.configuration, { harnessId: "openclaw", nativeModel: "vision/large" }, "openclaw");
  await sent(app, openclaw.id, "first question", "o1");
  const unapplied = await sent(app, openclaw.id, "second question", "o2");
  assert.equal(unapplied.error?.code, "MODEL_MISMATCH"); assert.equal(ended(f.store, openclaw.id, unapplied.id).input, "not_recorded");
  await sent(app, openclaw.id, "third question", "o3");
  assert.deepEqual((await real.prompts("openclaw")).slice(1), ["third question"]);
  // Codex: turn/start refused before any turn exists (not recorded); the next input goes as typed.
  const codex = await app.create(f.configuration, { harnessId: "codex" }, "codex");
  await sent(app, codex.id, "first question", "x1");
  const refused = await sent(app, codex.id, "second question", "x2");
  assert.equal(refused.status, "failed"); assert.equal(ended(f.store, codex.id, refused.id).input, "not_recorded");
  await sent(app, codex.id, "third question", "x3");
  assert.deepEqual((await real.prompts("codex")).slice(1), ["second question", "third question"]);
  for (const id of [claude.id, openclaw.id, codex.id]) assert.equal(app.read(id).status, "open");
});

test("G067-C04 a full-width space before /clear is read as Hermes reads it: a command sent as typed that carries nothing and is not taken for recorded", { timeout: 60000 }, async t => {
  const f = await world(t), real = await drivers(f, () => ({ RELAY_PROMPT: "answer" })), app = f.runtime(real);
  const session = await app.create(f.configuration, { harnessId: "claude" }, "create");
  const first = await sent(app, session.id, "first question", "c1");
  await switched(app, session.id, { harnessId: "hermes" }, "to-hermes");
  // The shared reading sees content here; Hermes strips the input as Python's lstrip() does and runs /clear.
  assert.equal(listedCommand("　/clear", null).kind, "content");
  const clear = await sent(app, session.id, "　/clear", "h1");
  assert.deepEqual(await real.prompts("hermes"), ["　/clear"], "sent exactly as typed, without the facts it owes");
  assert.deepEqual(clear.sourceRunIds, []);
  assert.ok(events(f.store, session.id).some(row => row.type === "run.native_command" && row.data.runId === clear.id && row.data.name === "clear" && row.data.contextEffect === "clear"));
  const end = ended(f.store, session.id, clear.id);
  assert.equal(end.input, "unknown", "the command's end_turn and reply are no evidence that content was recorded");
  assert.equal(end.contextEffect, "clear");
  assert.equal(binding(app.read(session.id), "hermes")?.throughRunId, null, "a command owing facts moves no native position");
  // The facts stay owed and go with the next content input.
  const next = await sent(app, session.id, "what now?", "h2");
  assert.deepEqual(next.sourceRunIds, [first.id, clear.id]); assert.ok(isPacket((await real.prompts("hermes"))[1]!));
  assert.equal(binding(app.read(session.id), "hermes")?.throughRunId, next.id);
});

test("G067 Hermes refuses a prompt unsent while a lost turn is pending: that Turn is not recorded and moves nothing; after `/discard` the next Turn sends the lost one's facts again", { timeout: 60000 }, async t => {
  const recovery = (state: string) => "unknown_execution: do not resend accepted input; a turn in this session was lost when the gateway restarted and its outcome is unknown (" + state + "). Send `/discard adm-7` here (or `hermes sessions discard s1` in a terminal), then continue.";
  const f = await world(t), real = await drivers(f, (harnessId, n) => harnessId !== "hermes" ? { RELAY_PROMPT: "answer" }
    : n === 1 ? { RELAY_PROMPT: "error", RELAY_DETAILS: recovery("your input is accepted and kept") } : n === 2 ? { RELAY_PROMPT: "error", RELAY_DETAILS: recovery("nothing was submitted") }
    : { RELAY_PROMPT: "answer", RELAY_REPLY: n === 3 ? "Discarded adm-7." : "ok" });
  const app = f.runtime(real), session = await app.create(f.configuration, { harnessId: "claude" }, "create");
  const first = await sent(app, session.id, "first question", "c1");
  await switched(app, session.id, { harnessId: "hermes" }, "to-hermes");
  const lost = await sent(app, session.id, "the turn the gateway lost", "h1");
  assert.equal(ended(f.store, session.id, lost.id).input, "unknown"); assert.deepEqual(lost.sourceRunIds, [first.id]);
  const refused = await sent(app, session.id, "a prompt refused unsent", "h2");
  assert.equal(refused.status, "failed"); assert.equal(ended(f.store, session.id, refused.id).input, "not_recorded");
  assert.equal(ended(f.store, session.id, refused.id).relayResendOf, lost.id, "it carried the lost Turn's facts again, and Hermes took none of it");
  assert.equal(binding(app.read(session.id), "hermes")?.throughRunId, null, "a refusal before admission moves nothing");
  const discard = await sent(app, session.id, "/discard adm-7", "h3");
  assert.deepEqual(discard.sourceRunIds, []); assert.equal(binding(app.read(session.id), "hermes")?.throughRunId, null);
  const next = await sent(app, session.id, "carry on", "h4");
  assert.equal(ended(f.store, session.id, next.id).relayResendOf, lost.id, "the attempt Hermes refused unsent is no attempt"); assert.equal(binding(app.read(session.id), "hermes")?.throughRunId, next.id);
  const prompts = await real.prompts("hermes");
  assert.deepEqual(prompts.map(prompt => isPacket(prompt) ? inputOf(prompt) : "as typed: " + prompt), ["the turn the gateway lost", "a prompt refused unsent", "as typed: /discard adm-7", "carry on"]);
});

test("G067 Hermes's no-change answer to /compress ends the command as a no-op: its effect is none, and the result's word for it is stored nowhere", { timeout: 60000 }, async t => {
  const f = await world(t), real = await drivers(f, (_harnessId, n) => ({ RELAY_PROMPT: "answer", ...(n === 2 ? { RELAY_REPLY: "No changes from compression: 12 messages\nApprox request size: ~1,234 tokens (unchanged)\n" } : {}) }));
  const app = f.runtime(real), session = await app.create(f.configuration, { harnessId: "hermes" }, "create");
  await sent(app, session.id, "first question", "h1");
  const compress = await sent(app, session.id, "/compress", "h2"), compacted = await sent(app, session.id, "/compact", "h3");
  assert.ok(events(f.store, session.id).some(row => row.type === "run.native_command" && row.data.runId === compress.id && row.data.name === "compress" && row.data.contextEffect === "compact"));
  assert.equal(ended(f.store, session.id, compress.id).contextEffect, "none");
  assert.equal(ended(f.store, session.id, compacted.id).contextEffect, "compact", "the alias, answered with an ordinary reply, compacted");
  assert.ok(events(f.store, session.id).every(row => !(row.type === "run.backend_settled" || row.type === "run.ended") || row.data.backend === null || !Object.hasOwn(row.data.backend as object, "command")));
  assert.ok(app.read(session.id).runs.every(row => row.backend === null || !Object.hasOwn(row.backend, "command")));
});

/**
 * Writes `count` finished alpha Turns into a conversation through the Store (the last one settled by its own Turn, as the
 * Runtime would), and alpha's native binding, ready and at the last of them.
 */
function seed(store: SqliteSessionStore, id: SessionId, count: number, profile: { readonly input: number; readonly reply: number; readonly thinking: number; readonly tools: number }): void {
  const state = store.get(id), at = Date.parse("2026-11-01T00:00:00Z");
  const runs: PublicRun[] = [], messages: SessionSnapshot["messages"][number][] = [], commands: SessionSnapshot["commands"][number][] = [];
  for (let index = 0; index < count; index++) {
    const user = state.lastSeq + 1 + index * 2, run = "run-seed-" + index, code = "const value" + index + " = compute(input, " + index + ");\n";
    runs.push({ id: run as PublicRun["id"], commandId: ("send-seed-" + index) as PublicRun["commandId"], input: "请继续第 " + index + " 步：" + "需".repeat(Math.max(0, Math.floor((profile.input - 30) / 3))),
      userMessageId: ("message-seed-user-" + index) as PublicRun["userMessageId"], assistantMessageId: ("message-seed-reply-" + index) as PublicRun["assistantMessageId"],
      selection: state.selection, epoch: 1, status: index === count - 1 ? "settling" : "completed", cancelRequested: false, contextThroughSeq: user - 1, sourceRunIds: [],
      backend: { status: "completed", reason: "seed" }, cleanup: index === count - 1 ? null : clean, error: null, stopRequested: false, awaitingSwitchId: null,
      thinking: "思".repeat(Math.floor(profile.thinking / 3)), tools: Array.from({ length: profile.tools }, (_, tool) => ({ id: "tool-" + index + "-" + tool, title: "Read src/module-" + tool + ".ts", status: "completed" })),
      timing: { acceptedAt: at + index * 10, preparingAt: at + index * 10 + 1, readyAt: at + index * 10 + 2, dispatchedAt: at + index * 10 + 3, firstOutputAt: at + index * 10 + 4, ...(index === count - 1 ? {} : { endedAt: at + index * 10 + 5 }) } });
    messages.push({ id: runs[index]!.userMessageId, runId: runs[index]!.id, role: "user", text: runs[index]!.input, seq: user, status: runs[index]!.status },
      { id: runs[index]!.assistantMessageId, runId: runs[index]!.id, role: "assistant", text: "```ts\n" + code.repeat(Math.ceil(profile.reply / code.length)).slice(0, profile.reply) + "\n```", seq: user + 1, status: runs[index]!.status });
    commands.push({ id: runs[index]!.commandId, kind: "send", fingerprint: "a".repeat(64), resultId: run });
  }
  const last = runs.at(-1)!;
  store.transact(id, state.version, current => ({ next: { ...current, activeRunId: last.id, runs, messages, commands: [...current.commands, ...commands],
    // A v13 binding carries its relay state (G066); this seed starts alpha's first native session.
    nativeBindings: [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "private-native-alpha", throughRunId: null, status: "unconfirmed", relay: initialBindingRelay([], "alpha", "alpha-acp", "new") }] },
    events: runs.flatMap(run => [{ type: "message.accepted", data: { runId: run.id } }, { type: "run.seeded", data: { runId: run.id } }]) }));
  const seeded = store.get(id);
  store.transact(id, seeded.version, current => ({ next: { ...current, activeRunId: null,
    runs: current.runs.map(run => run.id === last.id ? { ...run, status: "completed" as const, cleanup: clean, timing: { ...run.timing!, endedAt: at + count * 10 } } : run),
    messages: current.messages.map(message => message.runId === last.id ? { ...message, status: "completed" as const } : message),
    nativeBindings: [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "private-native-alpha", throughRunId: last.id, status: "ready", relay: current.nativeBindings![0]!.relay! }] },
    events: [{ type: "run.ended", data: { runId: last.id, status: "completed" } }] }));
}

for (const [name, count, profile, least] of [
  // R6's long-reply profile at 66 Turns (input 0.8 KB, reply 16 KB, thinking 3 KB, 16 tools): about 1.5 MiB, where v12 stalled.
  ["R6's 66-Turn long-reply profile", 66, { input: 800, reply: 16 * 1024, thinking: 3 * 1024, tools: 16 }, 1.3 * 1024 * 1024],
  // A snapshot near the 8 MiB Session limit.
  ["an 8 MiB snapshot", 236, { input: 800, reply: 27 * 1024, thinking: 3 * 1024, tools: 16 }, 7 * 1024 * 1024],
] as const) {
  test("G067-C05 " + name + ": continuing on the same Harness, validating a switch and recovering a blocked conversation never fail on its history; a target owed all of it gets it folded into one packet, or the input alone", { timeout: 240000 }, async t => {
    const f = await world(t), fake = new FakeHarnesses((_harness, text) => inputOf(text).includes("loses its connection") ? "lost" : recorded);
    const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
    seed(f.store, session.id, count, profile);
    assert.ok(utf8Bytes(JSON.stringify(app.read(session.id))) >= least && utf8Bytes(JSON.stringify(app.read(session.id))) < MAX_SESSION_BYTES, "the fixed profile's snapshot size");
    // Same Harness, at its native position: nothing is owed, nothing is rendered or budgeted, the input goes as typed.
    const continued = await sent(app, session.id, "继续下一步", "continue");
    assert.equal(continued.status, "completed", JSON.stringify(continued.error)); assert.deepEqual(fake.to("alpha"), ["继续下一步"]);
    // Validating a switch renders nothing.
    await switched(app, session.id, { harnessId: "bravo" }, "to-bravo");
    assert.equal(app.read(session.id).switches.at(-1)?.status, "effective");
    // Sent alone ("只发这条消息"): exactly as typed, and bravo's native position stays where it was (it is still owed everything).
    const alone = await sent(app, session.id, "从这里接着做", "bravo-1", { attach: "none" });
    assert.equal(alone.status, "completed"); assert.deepEqual(fake.to("bravo"), ["从这里接着做"]); assert.deepEqual(alone.sourceRunIds, []);
    assert.equal(binding(app.read(session.id), "bravo")?.throughRunId, null);
    assert.ok(events(f.store, session.id).some(row => row.type === "message.accepted" && row.data.runId === alone.id && JSON.stringify(row.data.relay) === '{"attach":"none"}'));
    assert.throws(() => app.send(session.id, "从这里接着做", "bravo-1"), (error: unknown) => error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT", "a key keeps its choice");
    // bravo is owed every Turn, far more than the JSON envelope could hold: the packet folds them to its budget (ADR-055
    // §6.3) instead of refusing the input (it was CONTEXT_TOO_LARGE before), and accounts for every one of them.
    const carried = await sent(app, session.id, "接着做下一步", "bravo-2");
    assert.equal(carried.status, "completed", JSON.stringify(carried.error)); assert.equal(carried.sourceRunIds.length, count + 2, "the seeded Turns, the one continued and the one sent alone");
    const packet = readRelayPrompt(fake.to("bravo")[1]!), relay = events(f.store, session.id).find(row => row.type === "run.context_prepared" && row.data.runId === carried.id)!.data.relay as RelayRecord;
    assert.equal(packet.kind, "packet"); assert.equal(packet.currentInput.text, "接着做下一步");
    assert.ok(relay.tokens <= relay.budget.cap, relay.tokens + " tokens"); assert.equal(relay.complete, false);
    assert.equal(relay.units.verbatim + relay.units.compact + relay.units.line + relay.units.ranged, count + 2, "every owed Turn is accounted for");
    assert.equal(binding(app.read(session.id), "bravo")?.throughRunId, carried.id, "carried and recorded, bravo's position moves");
    // A Turn whose outcome is lost blocks the conversation; the recovery switch validates without rendering the history.
    const lost = await sent(app, session.id, "这一轮 loses its connection", "bravo-3", { attach: "none" }).catch(() => null);
    assert.equal(lost, null); assert.equal(app.read(session.id).status, "blocked");
    app.resume(session.id, { harnessId: "alpha" }, "recover", true); await app.wait(session.id);
    assert.equal(app.read(session.id).status, "open"); assert.equal(app.read(session.id).selection.harnessId, "alpha");
    // Back on alpha, only bravo's three dispatched Turns are owed, and alpha's native session holds the rest: a delta.
    const back = await sent(app, session.id, "回到 alpha 继续", "alpha-2");
    assert.equal(back.status, "completed"); assert.equal(back.sourceRunIds.length, 3); assert.equal(readRelayPrompt(fake.to("alpha").at(-1)!).kind, "delta");
  });
}

test("G067 a branch whose history filled the old budget: sent alone it stays owed; an input read as a command only once its program started carries it folded, without opening the packet", { timeout: 60000 }, async t => {
  const f = await world(t), fake = new FakeHarnesses();
  const app = f.runtime(fake), source = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  seed(f.store, source.id, 30, { input: 800, reply: 33 * 1024, thinking: 0, tools: 0 });
  const branch = app.fork(source.id, "branch", app.read(source.id).runs.at(-2)!.id); await app.wait(branch.id);
  assert.equal(branch.nativeBindings, undefined, "alpha's native session is past the branch point");
  await sent(app, branch.id, "继续", "b1", { attach: "none" });
  assert.deepEqual(fake.to("alpha"), ["继续"]); assert.equal(binding(app.read(branch.id), "alpha")?.throughRunId, null, "sent alone, the history stays owed");
  // No listed command: `/explain …` is a possible command until the catalog is read, so its packet is rendered once its
  // program started (it failed CONTEXT_TOO_LARGE there before); it carries the folded branch history, and since the input
  // may be a command the packet never starts with it, so the packet cannot become a command's argument.
  const late = await sent(app, branch.id, "/explain the plan", "b2");
  assert.equal(late.status, "completed", JSON.stringify(late.error));
  const prompt = fake.to("alpha")[1]!, packet = readRelayPrompt(prompt);
  assert.match(prompt, /^〔HarnessHub handoff relay-[0-9a-z]{20}〕\n/u, "no first line before the frame");
  assert.equal(packet.currentInput.text, "/explain the plan"); assert.ok(packet.branchedHistory.length > 0, "the branch history is quoted");
  const relay = events(f.store, branch.id).find(row => row.type === "run.context_prepared" && row.data.runId === late.id)!.data.relay as RelayRecord;
  assert.equal(relay.firstLine, false); assert.equal(relay.sources.origin, true); assert.ok(relay.tokens <= relay.budget.cap);
  assert.ok(events(f.store, branch.id).some(row => row.type === "run.context_prepared" && row.data.runId === late.id && row.data.carriedOrigin === true));
  assert.equal(binding(app.read(branch.id), "alpha")?.throughRunId, late.id, "carried and recorded");
  await sent(app, branch.id, "再继续", "b3");
  assert.equal(fake.to("alpha").at(-1), "再继续", "nothing is owed any more: exactly as typed");
});

test("G067-C07 a Turn whose stop is never confirmed fails the switch waiting for it and the inputs waiting for that switch in the same commit; after the grace the conversation can be resumed", { timeout: 30000 }, async t => {
  const f = await world(t), fake = new FakeHarnesses((_harness, text) => inputOf(text) === "never settles" ? "hold" : recorded);
  const app = f.runtime(fake, { stopGraceMs: 50 }), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const stuck = app.send(session.id, "never settles", "stuck");
  for (const deadline = Date.now() + 5000; !fake.to("alpha").length;) { assert.ok(Date.now() < deadline, "the prompt was sent"); await new Promise(resolve => setTimeout(resolve, 5)); }
  const pending = app.switch(session.id, { harnessId: "bravo" }, "to-bravo");
  const waiting = app.send(session.id, "for bravo", "waiting");
  assert.equal(app.read(session.id).runs.find(row => row.id === waiting.runId)?.awaitingSwitchId, pending.switchId);
  // Stop and switch: the program never settles, the stop grace runs out and the program is ended without a result.
  app.cancel(session.id, "stop", stuck.runId);
  await assert.rejects(app.wait(session.id), (error: unknown) => error instanceof SessionError && error.code === "SESSION_BLOCKED");
  const state = app.read(session.id), turn = state.runs.find(row => row.id === stuck.runId)!, queued = state.runs.find(row => row.id === waiting.runId)!;
  assert.equal(turn.status, "unknown"); assert.equal(turn.cleanup?.closed, true); assert.equal(state.status, "blocked"); assert.equal(state.pendingSwitchId, null);
  assert.equal(state.switches.find(row => row.id === pending.switchId)?.status, "failed"); assert.equal(state.switches.find(row => row.id === pending.switchId)?.error?.code, "SWITCH_SOURCE_UNKNOWN");
  assert.equal(queued.status, "failed"); assert.equal(queued.error?.code, "SWITCH_NOT_EFFECTIVE");
  // One commit: the Turn's end, the switch, the waiting input and the block are consecutive events.
  const log = events(f.store, session.id), start = log.findIndex(row => row.type === "run.ended" && row.data.runId === stuck.runId);
  assert.deepEqual(log.slice(start, start + 4).map(row => [row.type, row.data.runId ?? row.data.switchId]), [["run.ended", stuck.runId], ["switch.failed", pending.switchId], ["run.ended", waiting.runId], ["session.blocked", stuck.runId]]);
  assert.equal(log[start + 2]?.data.neverDispatched, true);
  assert.deepEqual(fake.to("bravo"), [], "nothing waiting for the switch was sent");
  // The pending switch no longer holds the blocked conversation: recovery is possible once the unknown Turn is acknowledged.
  assert.throws(() => app.resume(session.id, { harnessId: "bravo" }, "recover-unacknowledged"), (error: unknown) => error instanceof SessionError && error.code === "RECOVERY_ACK_REQUIRED");
  app.resume(session.id, { harnessId: "bravo" }, "recover", true); await app.wait(session.id);
  assert.equal(app.read(session.id).status, "open"); assert.equal(app.read(session.id).selection.harnessId, "bravo");
  const after = await sent(app, session.id, "carry on", "after");
  assert.equal(after.status, "completed"); assert.equal(fake.to("bravo").length, 1);
});

test("G067 R0e the data directory and the workspace are compared by identity along their parents, both ways, and a data directory left in the workspace is found", async t => {
  const root = await mkdtemp(join(tmpdir(), "relay-data-root-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), outside = join(root, "data"), inside = join(workspace, "data");
  await mkdir(join(workspace, "src"), { recursive: true }); await mkdir(outside); await mkdir(inside);
  assert.deepEqual(dataRootPlacement(outside, workspace), { containment: "separate", markers: [] }); assert.equal(dataRootWarning(dataRootPlacement(outside, workspace)), null);
  assert.equal(dataRootPlacement(inside, workspace).containment, "data_root_in_workspace");
  assert.match(String(dataRootWarning(dataRootPlacement(inside, workspace))), /--data-dir/u);
  assert.equal(dataRootPlacement(root, workspace).containment, "workspace_in_data_root");
  // Another spelling of the same directory: a symbolic link to the workspace still contains the data directory.
  await symlink(workspace, join(root, "alias"));
  assert.equal(dataRootPlacement(inside, join(root, "alias")).containment, "data_root_in_workspace");
  assert.equal(dataRootPlacement(join(root, "alias", "data"), workspace).containment, "data_root_in_workspace");
  // A copy left behind in the workspace keeps its ownership marker, so a data directory moved out still warns.
  await mkdir(join(workspace, "old", "data"), { recursive: true }); await writeFile(join(workspace, "old", "data", ".harness-gateway.json"), "{}");
  assert.deepEqual(dataRootPlacement(outside, workspace).markers, ["old/data"]);
  assert.match(String(dataRootWarning(dataRootPlacement(outside, workspace))), /\.\/old\/data/u);
  assert.deepEqual(dataRootPlacement(join(root, "missing"), workspace), { containment: "separate", markers: [] }, "what cannot be read proves nothing");
});

test("G067 R0e a link in the workspace that leads to the data directory puts it in the workspace's reach; the search looks at links without entering them and holds one large directory to its entry bound", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "relay-data-link-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), data = join(root, "elsewhere", "hh-data");
  await mkdir(workspace); await mkdir(join(data, "nested", "data"), { recursive: true });
  await writeFile(join(data, ".harness-gateway.json"), "{}"); await writeFile(join(data, "nested", "data", ".harness-gateway.json"), "{}");
  await symlink(data, join(workspace, "data"));
  // `--cwd workspace --data-dir workspace/data`: its real parents are elsewhere, but the workspace's Harnesses read ./data through the link.
  assert.equal(dataRootPlacement(join(workspace, "data"), workspace).containment, "data_root_in_workspace");
  // Named by its real path it is separate; the link to it is found, and nothing behind the link is searched.
  assert.deepEqual(dataRootPlacement(data, workspace), { containment: "separate", markers: ["data"] });
  // One directory of 3,000 links, each to a copy left behind with its marker: every link the search examines is reported, so
  // the count shows how far it read. The workspace's own two entries and at most 1,998 of the links fit the 2,000-entry bound.
  const copies = join(root, "copies"), big = join(workspace, "many"); await mkdir(join(copies, "data"), { recursive: true }); await mkdir(big);
  await writeFile(join(copies, "data", ".harness-gateway.json"), "{}");
  for (let index = 0; index < 3000; index += 500) await Promise.all(Array.from({ length: 500 }, (_, offset) => symlink(join(copies, "data"), join(big, "copy-" + (index + offset)))));
  const placement = dataRootPlacement(data, workspace), found = placement.markers.filter(path => path.startsWith("many/"));
  assert.equal(placement.containment, "separate"); assert.ok(found.length >= 1 && found.length <= 1998, `markers found in the large directory: ${found.length}`);
  assert.deepEqual(placement.markers.filter(path => !path.startsWith("many/")), ["data"]);
});
