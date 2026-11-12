import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { listedCommand, nativeConversationId, type BackendResult, type CleanupEvidence, type HarnessControl, type NativeCommand } from "../../src/contracts/control.js";
import type { ContentPort } from "../../src/contracts/content.js";
import type { BindingRelayState, RelayBehindIndex } from "../../src/contracts/relay.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { migrateSession, type MigrationEvent } from "../../src/infrastructure/session/legacy/migrate.js";
import { parseSession } from "../../src/infrastructure/session/legacy/state.js";
import { appStore } from "../fixtures/runtime-store.js";
import { writeV12Root } from "../fixtures/relay/v12/database.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { oldShape } from "../fixtures/old-shape.js";

// Random v12 conversations (ADR-055 §14.4): random v12 conversations migrated to v13. The conversations are made by the formal
// SessionRuntime and a real SqliteConversationStore with an in-process model Harness that keeps the ground truth of every native
// session: which public Turns it ever received in a packet. The store's v13 relay fields are then taken away again, which
// gives exactly the v12 data the v12 runtime wrote (G066 changed the runtime only there), optionally with the event fields
// G067 added also taken away (the data of older v12 builds). Every case names its seed; nothing here runs a Harness.

const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
// The three the random conversations use, and the scripted ones below: a rewind, a command of unknown effect (it declares none) and one that
// enters the context like a message.
const COMMANDS: readonly NativeCommand[] = [{ name: "compact", description: "compact", contextEffect: "compact" }, { name: "clear", description: "clear", contextEffect: "clear" }, { name: "model", description: "model", contextEffect: "none" },
  { name: "undo", description: "undo", contextEffect: "rewind" }, { name: "mystery", description: "mystery" }, { name: "skill", description: "skill", contextEffect: "keep" }];
const HARNESSES = ["alpha", "bravo", "gamma"] as const;
/** mulberry32: a small seeded generator, so every case is reproducible from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ (state >>> 15), 1 | state); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
/** What one native session holds, as the model Harness knows it: the public Turns it ever received, and the starting history. */
interface Truth { readonly harnessId: string; readonly delivered: Set<string>; knowsOrigin: boolean }
type Ending = "recorded" | "rejected" | "failed_after_insert" | "no_evidence" | "lost";
/**
 * Model Harnesses alpha, bravo and gamma. Each native session is its own (a new identity per open without a checkpoint);
 * a prompt ends as `decide` says, decided from the seed and the Run so the same case always ends the same; what a prompt
 * carried is read from the Run's own `run.context_prepared`, as the Hub committed it before dispatch.
 */
class ModelHarnesses implements SessionBindingFactory {
  readonly truth = new Map<string, Truth>();
  readonly sent: { readonly session: string; readonly input: string; readonly text: string }[] = [];
  private opened = 0;
  constructor(private store: SqliteConversationStore, private readonly decide: (run: string, command: boolean) => Ending, private readonly legacy = false) {}
  use(store: SqliteConversationStore): void { this.store = store; }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!(HARNESSES as readonly string[]).includes(request.harnessId)) throw new SessionError("HARNESS_UNAVAILABLE", "unknown model Harness");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async readNativeSession(selection: HarnessSelection, _configuration: SessionConfiguration, nativeId: string) {
    this.truth.set(nativeId, { harnessId: selection.harnessId, delivered: new Set(), knowsOrigin: true });
    return { checkpoint: nativeId, title: "imported", history: [{ role: "user" as const, text: "earlier" }, { role: "assistant" as const, text: "answer" }], omitted: 0, complete: true, historyRead: true };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    let current: string | null = null;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "model", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => {
        if (checkpoint !== undefined && !this.truth.has(checkpoint)) throw new SessionError("NATIVE_SESSION_MISSING", "no such model session");
        current = checkpoint ?? "native-" + selected.harnessId + "-" + ++this.opened;
        if (!this.truth.has(current)) this.truth.set(current, { harnessId: selected.harnessId, delivered: new Set(), knowsOrigin: false });
        return nativeConversationId(current);
      },
      checkpoint: async () => current,
      fork: async checkpoint => { const copy = checkpoint + "-fork-" + ++this.opened; this.truth.set(copy, { harnessId: selected.harnessId, delivered: new Set(), knowsOrigin: true }); return copy; },
      models: async () => ({ models: [{ id: "model-a", name: "A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: COMMANDS }),
      classify: (text, catalog) => listedCommand(text, catalog),
      startText: async (_id, text: string, output) => {
        const events = all(this.store, session), prepared = events.findLast(event => event.type === "run.context_prepared" && event.data.runId === run);
        const command = events.some(event => event.type === "run.native_command" && event.data.runId === run);
        const input = this.store.snapshot(session).runs.find(row => row.id === run)!.input;
        this.sent.push({ session, input, text });
        const truth = this.truth.get(current!)!, ending = this.decide(run, command);
        const sources = (prepared?.data.sourceRunIds as readonly string[] | undefined) ?? [];
        const inserted = ending === "recorded" || ending === "failed_after_insert" || ending === "no_evidence" || ending === "lost" && this.decide(run + ":inserted", command) === "recorded";
        // A packet carried the starting history when its range starts at it (the v13 Runtime says so by the range, as a v12 build did by carriedOrigin);
        // a build before G067 repeated that history in every packet.
        const range = prepared?.data.range as { readonly fromSeq?: number } | undefined, origin = (this.store.snapshot(session).origin?.history.length ?? 0) > 0;
        const carriedOrigin = prepared?.data.carriedOrigin === true || range?.fromSeq === 0 || this.legacy && origin && sources.length > 0;
        if (inserted) { for (const source of sources) truth.delivered.add(source); if (carriedOrigin) truth.knowsOrigin = true; }
        if (ending !== "lost") output({ type: "text", text: "reply" });
        const result: Promise<BackendResult> = ending === "lost" ? new Promise((_resolve, reject) => { setImmediate(() => reject(new SessionError("CONTROL_FAILED", "the connection ended without a result"))); })
          : Promise.resolve(ending === "rejected" ? { status: "failed", reason: "request_rejected", error: { code: "REMOTE_ERROR", message: "refused" }, input: "not_recorded" }
            : ending === "failed_after_insert" ? { status: "failed", reason: "model_error", error: { code: "REMOTE_ERROR", message: "model failed" }, input: "recorded" }
            : ending === "no_evidence" || command ? { status: "completed", reason: "model" } : { status: "completed", reason: "model", input: "recorded" });
        return { result, requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
function all(store: SqliteConversationStore, id: SessionId): readonly SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return events; events.push(...page); after = page.at(-1)!.seq; }
}
/** An image the content store admits; every model Harness refuses attachments before dispatch. */
const content: ContentPort = {
  storeOutput: async () => { throw new Error("no outputs"); },
  resolve: ids => ids.map(id => ({ id: id as never, name: "photo.png", mediaType: "image/png", kind: "image", bytes: 8, sha256: "0".repeat(64) })),
  materialize: async () => { throw new Error("refused before copied"); },
};
interface World { readonly root: string; readonly data: string; readonly workspace: string; store: SqliteConversationStore; readonly harness: ModelHarnesses; runtime: SessionRuntime; readonly next: () => string }
function world(t: TestContext, seed: number, outcomes: { readonly rejected: number; readonly lost: number }, legacy = false): World {
  const root = mkdtempSync(join(tmpdir(), "g066-property-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data"), workspace = root, store = appStore(data);
  const unit = (key: string) => createHash("sha256").update(seed + ":" + key).digest()[0]! / 256;
  const harness = new ModelHarnesses(store, (run, command) => {
    const draw = unit(run);
    if (command) return draw < outcomes.rejected ? "rejected" : "recorded";
    return draw < outcomes.rejected ? "rejected" : draw < outcomes.rejected + 0.04 ? "failed_after_insert" : draw < outcomes.rejected + 0.09 ? "no_evidence" : draw < outcomes.rejected + 0.09 + outcomes.lost ? "lost" : "recorded";
  }, legacy);
  let ids = 0;
  const next = () => String(++ids);
  const runtime = new SessionRuntime(store, harness, { id: next, now: () => new Date(Date.UTC(2026, 10, 9) + ids * 1000), publish: () => {}, content, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  return { root, data, workspace, store, harness, runtime, next };
}
const configuration = (workspace: string): SessionConfiguration => ({ workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true });

/** Random steps on one conversation: inputs, native commands, attachments refused before dispatch, switches, native resets, recoveries. */
async function play(w: World, id: SessionId, random: () => number, steps: number, harnesses: readonly string[]): Promise<void> {
  const app = w.runtime, key = () => "key-" + w.next();
  const settle = async () => { try { await app.wait(id); } catch (error) { if (!(error instanceof SessionError) || error.code !== "SESSION_BLOCKED") throw error; } };
  for (let step = 0; step < steps; step++) {
    const state = oldShape(app, id), selected = state.selection.harnessId;
    if (state.status === "blocked") { app.resume(id, { harnessId: harnesses[Math.floor(random() * harnesses.length)]! }, key(), true); await settle(); continue; }
    if (state.nativeBindings?.some(binding => binding.harnessId === selected && (binding.status === "unconfirmed" || binding.status === "forking"))) { app.resetNative(id, key(), state.epoch); continue; }
    const draw = random();
    try {
      if (draw < 0.5) app.send(id, "input " + step + " on " + selected, key());
      else if (draw < 0.6) app.send(id, ["/compact", "/clear", "/model model-a"][Math.floor(random() * 3)]!, key());
      else if (draw < 0.65) app.send(id, "input " + step + " alone", key(), [], { attach: "none" });
      else if (draw < 0.69) app.send(id, "input " + step + " with a photo", key(), ["content-photo"]);
      else if (draw < 0.9 && harnesses.length > 1) app.switch(id, { harnessId: harnesses.filter(name => name !== selected)[Math.floor(random() * (harnesses.length - 1))]! }, key());
      else if (draw < 0.95 && state.nativeBindings?.some(binding => binding.harnessId === selected && binding.status === "ready")) app.resetNative(id, key(), state.epoch);
      else app.send(id, "input " + step + " on " + selected, key());
    } catch (error) { if (!(error instanceof SessionError)) throw error; }
    await settle();
  }
}
/**
 * The v12 snapshot a v12 build would hold: the v13 relay state taken away, a binding's opensNew included (v13 only; since G068 fix
 * batch 2, I-1a, a new binding whose first Turn ends before dispatch carries it).
 */
function v12(state: SessionSnapshot): SessionSnapshot {
  // Since G068 phase two the Runtime also writes each Run's relay and its v13 phases (contextReadyAt, recordedAt); v12 has none.
  const { relayRecoveryFailed: _failed, ...rest } = state;
  return parseSession({ ...rest, schemaVersion: 12, runs: state.runs.map(({ relay: _relay, relayRequest: _request, ...run }) => {
    if (run.timing === undefined) return run;
    const { contextReadyAt: _ready, recordedAt: _recorded, ...timing } = run.timing;
    return { ...run, timing };
  }), ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings.map(({ relay: _relay, opensNew: _opensNew, ...binding }) => binding) }) });
}
/** What a v12 build wrote in `run.context_prepared` that the v13 Runtime says by its range: that the packet carried the starting history. */
function v12Event(event: MigrationEvent): MigrationEvent {
  const range = event.data.range as { readonly fromSeq?: number } | undefined;
  return event.type === "run.context_prepared" && range?.fromSeq === 0 && event.data.carriedOrigin !== true ? { ...event, data: { ...event.data, carriedOrigin: true } } : event;
}
/** The event data G067 added (2026-11-03), taken away: what an older v12 build wrote. */
function older(event: MigrationEvent): MigrationEvent {
  const strip = (keys: readonly string[]) => ({ ...event, data: Object.fromEntries(Object.entries(event.data).filter(([key]) => !keys.includes(key))) });
  switch (event.type) {
    case "run.ended": return strip(["input", "contextEffect", "relayResendOf"]);
    case "run.native_command": return strip(["contextEffect"]);
    case "run.context_prepared": return strip(["carriedOrigin", "relay"]);
    case "message.accepted": return strip(["relay"]);
  }
  return event;
}
/**
 * The native positions a build before G067 left: it moved a binding's `throughRunId` to every Turn it dispatched there
 * that settled (commands, refusals and Turns sent alone included), where G067 moves it only by its rule (ADR-055 §7.6).
 * Which binding a Turn ran on is read from its `native.binding_prepared`, independently of the migration.
 */
function preG067Positions(state: SessionSnapshot, events: readonly MigrationEvent[]): SessionSnapshot {
  const bindings = state.nativeBindings ?? [];
  if (!bindings.length) return state;
  const active = new Map<string, number>(), ofRun = new Map<string, number>(), name = (data: Readonly<Record<string, unknown>>) => String(data.harnessId) + ":" + String(data.controlId);
  let made = 0;
  for (const event of events) {
    if (event.type === "session.created" && (state.origin?.kind === "import" || event.data.continuity === "native_fork")) { active.set(bindings[0]!.harnessId + ":" + bindings[0]!.controlId, 0); made = 1; }
    if (event.type === "native.binding_prepared") { if (event.data.resumed === false) active.set(name(event.data), made++); const index = active.get(name(event.data)); if (index !== undefined) ofRun.set(String(event.data.runId), index); }
    if (event.type === "native.branch_requested" || event.type === "native.fork_failed") active.delete(name(event.data));
  }
  return parseSession({ ...state, nativeBindings: bindings.map((binding, index) => {
    if (binding.status !== "ready" && binding.status !== "archived") return binding;
    const at = binding.throughRunId === null ? -1 : state.runs.findIndex(run => run.id === binding.throughRunId);
    const last = state.runs.findLastIndex(run => ofRun.get(run.id) === index && run.backend !== null && run.cleanup?.closed === true && run.cleanup.protocolFailure === null && ["completed", "failed", "cancelled"].includes(run.status));
    return last > at ? { ...binding, throughRunId: state.runs[last]!.id } : binding;
  }) });
}
/**
 * A data root a v12 build would have left: the conversations (taken back to v12 as `v12` does, with the events as a v12 build wrote them) in a v12 database of their own
 * (tests/fixtures/relay/v12/database.ts), which a store then climbs to the tables.
 */
let rootsMade = 0;
/** A v12 root of the conversations `ids` of a world (its store still open): the data a v12 build would have left of them. */
function downgrade(w: World, ids: readonly SessionId[]): string {
  const data = join(w.root, "v12-data-" + ++rootsMade);
  v12Root(data, ids.map(id => ({ state: v12(w.store.snapshot(id)), events: all(w.store, id) })));
  return data;
}
function v12Root(root: string, states: readonly { readonly state: SessionSnapshot; readonly events: readonly SessionEvent[] }[]): void {
  writeV12Root(root, [{ fixture: "model", describe: "conversations of the model Harnesses taken back to v12", userVersion: 12, ownerGeneration: 1,
    sessions: states.map(({ state, events }) => ({ id: state.id, version: state.version, lastSeq: state.lastSeq, snapshot: state as unknown as Record<string, unknown>,
      events: events.map(event => ({ ...event, data: v12Event({ seq: event.seq, type: event.type, data: event.data }).data })) })),
    createKeys: states.map(({ state }) => { const create = state.commands.find(command => command.kind === "create")!; return { commandId: create.id, sessionId: state.id, fingerprint: create.fingerprint }; }) }]);
}
/** Checks the migration's result for one v12 conversation against the model Harnesses' ground truth (C02's properties). */
function check(label: string, state: SessionSnapshot, bindings: readonly BindingRelayState[], runs: readonly RelayBehindIndex[], truth: ReadonlyMap<string, Truth>): void {
  const facts = runs.filter(run => run.commandEffect === null);
  const lineage = new Map<string, number>();
  for (const [index, binding] of (state.nativeBindings ?? []).entries()) {
    const relay = bindings[index]!, mark = relay.mark >= 0 ? { throughSeq: relay.mark } : null, key = binding.harnessId + ":" + binding.controlId, where = label + " binding " + index + " (" + key + ")";
    // Epochs strictly grow along the bindings of one Harness control.
    assert.ok(relay.epoch > (lineage.get(key) ?? 0), where + ": epoch " + relay.epoch); lineage.set(key, relay.epoch);
    // Only down: never past the v12 native position.
    const position = binding.throughRunId === null ? 0 : runs.find(run => run.runId === binding.throughRunId)?.seq ?? 0;
    if (mark !== null) assert.ok(mark.throughSeq <= position, where + ": mark " + mark.throughSeq + " passes the v12 position " + position);
    const native = truth.get(binding.checkpoint);
    if (native === undefined) { assert.equal(mark?.throughSeq ?? 0, 0, where + ": a session the model never held"); continue; }
    // Never more than delivered: every fact the mark claims for this binding reached its native session.
    if (mark !== null) {
      for (const fact of facts) {
        const foreign = fact.executedOn === null || fact.executedOn.harnessId !== binding.harnessId || fact.executedOn.controlId !== binding.controlId || fact.executedOn.nativeEpoch !== relay.epoch;
        if (foreign && fact.seq > relay.floor && fact.seq <= mark.throughSeq) assert.ok(native.delivered.has(fact.runId), where + ": the mark " + mark.throughSeq + " claims " + fact.runId + " (seq " + fact.seq + ") it never received");
      }
      if (mark.throughSeq >= 0 && relay.floor < 0 && (state.origin?.history.length ?? 0) > 0) assert.ok(native.knowsOrigin, where + ": the mark claims the starting history");
    }
  }
}

for (const [seed, legacy] of [[1, false], [2, false], [3, true], [4, false], [5, true], [6, true], [7, false], [8, true]] as const) {
  test("G066-C02 seed " + seed + (legacy ? " (pre-G067 events)" : "") + ": migrated marks stay within what each native session received and its v12 position, epochs grow along bindings", async t => {
    const random = generator(seed), w = world(t, seed, { rejected: 0.08, lost: 0.04 }, legacy);
    const sessions: SessionId[] = [];
    for (let index = 0; index < 4; index++) {
      const shape = random(), harnesses = HARNESSES.slice(0, 1 + Math.floor(random() * 3));
      let session: { readonly id: SessionId };
      if (shape < 0.2) session = await w.runtime.importNative(configuration(w.workspace), { harnessId: harnesses[0]! }, "native-imported-" + seed + "-" + index, "import-" + index);
      else if (shape < 0.4 && sessions.length > 0) {
        const source = sessions[Math.floor(random() * sessions.length)]!, finished = oldShape(w.runtime, source).runs.filter(run => ["completed", "failed", "cancelled", "unknown"].includes(run.status));
        if (!finished.length || oldShape(w.runtime, source).status !== "open") { session = await w.runtime.create(configuration(w.workspace), { harnessId: harnesses[0]! }, "create-" + index); }
        else { session = w.runtime.fork(source, "branch-" + index, finished.at(-1)!.id); try { await w.runtime.wait(session.id); } catch { /* a refused fork leaves the branch on public history */ } }
      } else session = await w.runtime.create(configuration(w.workspace), { harnessId: harnesses[0]! }, "create-" + index);
      sessions.push(session.id);
      await play(w, session.id, random, 12 + Math.floor(random() * 8), harnesses);
    }
    await w.runtime.close();
    const logged = sessions.map(id => all(w.store, id));
    const states = sessions.map((id, index) => ({ state: v12(w.store.snapshot(id)), events: logged[index]!.map(event => v12Event({ seq: event.seq, type: event.type, data: event.data })) }));
    w.store.close();
    let bindings = 0;
    for (const [index, { state, events }] of states.entries()) {
      // Data of a build before G067: positions moved by every settled Turn, and no G067 event fields.
      const v12state = legacy ? preG067Positions(state, events) : state;
      const migrated = migrateSession(v12state, legacy ? events.map(older) : events);
      check("seed " + seed + " session " + index, v12state, migrated.bindings, migrated.runs, w.harness.truth);
      bindings += migrated.bindings.length;
    }
    // The Store migrates the same database to the same relay state (the G067 fields kept, as a v12 database holds them).
    if (!legacy) {
      const data = join(w.root, "v12-data");
      v12Root(data, states.map(({ state }, index) => ({ state, events: logged[index]! })));
      const store = appStore(data);
      try { for (const [index, id] of sessions.entries()) assert.deepEqual(store.snapshot(id).nativeBindings?.map(row => row.relay), migrateSession(states[index]!.state, states[index]!.events).bindings, "seed " + seed + " session " + index); }
      finally { store.close(); }
    }
    t.diagnostic("seed " + seed + ": " + sessions.length + " conversations, " + bindings + " bindings, " + states.reduce((total, row) => total + row.state.runs.length, 0) + " Turns");
  });
}

test("G066-C02 a v12 conversation on one Harness, migrated, sends its next 20 inputs exactly as typed", async t => {
  for (const seed of [11, 12, 13, 14]) {
    const random = generator(seed), w = world(t, seed, { rejected: 0.08, lost: 0 });
    const session = await w.runtime.create(configuration(w.workspace), { harnessId: "alpha" }, "create");
    // One Harness, no native reset: the binding's own Turns are never owed to it.
    for (let step = 0; step < 15; step++) {
      const draw = random(), text = draw < 0.7 ? "input " + step : draw < 0.85 ? ["/compact", "/clear", "/model model-a"][step % 3]! : draw < 0.92 ? "input " + step + " with a photo" : "input " + step + " alone";
      try { w.runtime.send(session.id, text, "key-" + step, text.endsWith("photo") ? ["content-photo"] : [], text.endsWith("alone") ? { attach: "none" } : undefined); } catch (error) { if (!(error instanceof SessionError)) throw error; }
      await w.runtime.wait(session.id);
    }
    await w.runtime.close();
    const v12data = downgrade(w, [session.id]); w.store.close();
    w.store = appStore(v12data); w.harness.use(w.store);
    // A command or a refusal that may have changed the native session sets resendAll whether or not anything is owed (the migration, like v13);
    // with no other Harness there is nothing foreign for that flag to send, so the inputs below still go as typed.
    const relay = w.store.snapshot(session.id).nativeBindings![0]!.relay!;
    assert.equal(relay.pending, null, "seed " + seed + ": no packet waits for its only binding");
    w.runtime = new SessionRuntime(w.store, w.harness, { id: w.next, now: () => new Date(Date.UTC(2026, 10, 10)), publish: () => {}, content, fingerprint: value => createHash("sha256").update(value).digest("hex") });
    const before = w.harness.sent.length;
    for (let round = 0; round < 20; round++) { w.runtime.send(session.id, "after the migration " + round, "after-" + round); await w.runtime.wait(session.id); }
    const sent = w.harness.sent.slice(before);
    assert.equal(sent.length, 20, "seed " + seed);
    for (const row of sent) assert.equal(row.text, row.input, "seed " + seed + ": dispatched === input");
    await w.runtime.close(); w.store.close();
  }
});

test("G066-C02 before G067 a command moved the position past what it owed: the next packet does not make the mark claim the skipped Turns", async t => {
  const w = world(t, 99, { rejected: 0, lost: 0 }), app = w.runtime;
  const session = await app.create(configuration(w.workspace), { harnessId: "alpha" }, "create"), id = session.id;
  const send = async (text: string, key: string) => { app.send(id, text, key); await app.wait(id); };
  const to = async (harnessId: string, key: string) => { app.switch(id, { harnessId }, key); await app.wait(id); };
  await send("a1", "a1"); await send("a2", "a2"); await to("bravo", "to-b"); await send("b1", "b1"); await send("b2", "b2"); await to("alpha", "to-a");
  await send("/compact", "d1");
  // A build before G067 moved alpha's position to the command, past bravo's two Turns it never sent there (R4 D1).
  const command = oldShape(app, id).runs.at(-1)!;
  const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
  db.prepare("UPDATE bindings SET through_run_id=?, binding_json=json_set(binding_json,'$.throughRunId',?) WHERE session_id=? AND harness_id='alpha' AND status<>'archived'").run(command.id, command.id, id);
  db.close();
  await to("bravo", "to-b2"); await send("b3", "b3"); await to("alpha", "to-a2"); await send("a4", "a4");
  const state = v12(w.store.snapshot(id)), runs = state.runs, a4 = runs.at(-1)!, b3 = runs.find(run => run.input === "b3")!.id;
  // The v13 Runtime (G068 phase two) owes by the watermark, not the position, so its a4 carried bravo's three Turns; the build
  // before G067 carried only what came after the command, which its events say: a4's run.context_prepared is written as it was.
  assert.deepEqual(a4.sourceRunIds, ["b1", "b2", "b3"].map(input => runs.find(run => run.input === input)!.id), "v13 carries what alpha is owed");
  await app.close();
  const events = all(w.store, id).map(event => ({ seq: event.seq, type: event.type,
    data: event.type === "run.context_prepared" && event.data.runId === a4.id ? { ...event.data, sourceRunIds: [b3] } : event.data }));
  for (const legacy of [false, true]) {
    const migrated = migrateSession(state, legacy ? events.map(older) : events);
    check("D1 before G067" + (legacy ? " (pre-G067 events)" : ""), state, migrated.bindings, migrated.runs, w.harness.truth);
    const alpha = migrated.bindings[state.nativeBindings!.findIndex(binding => binding.harnessId === "alpha")]!;
    const b1 = migrated.runs.find(row => row.runId === runs.find(run => run.input === "b1")!.id)!;
    assert.ok(alpha.mark < b1.seq, "alpha's mark stays before bravo's first Turn, which is still owed (" + alpha.mark + " < " + b1.seq + ")");
  }
  w.store.close();
});

// The independent review of 2026-11-11 (persistent format): v13 sets resendAll after a command that may have rewound or changed the native
// session whether or not anything is owed (delivery.ts commandTurnEvent), where the migration set it only while facts were owed. A binding
// that holds everything and then ran a rewind (or a command of unknown effect) must be sent everything again after the migration too.
test("G066-C02 a binding a command may have rewound or changed is sent everything again after the migration, whether or not facts are owed to it", async t => {
  for (const [command, resendAll] of [["", false], ["/undo", true], ["/mystery", true]] as const) {
    const w = world(t, 97, { rejected: 0, lost: 0 }), app = w.runtime, label = JSON.stringify(command);
    const id = (await app.create(configuration(w.workspace), { harnessId: "alpha" }, "create")).id;
    const send = async (text: string, key: string) => { app.send(id, text, key); await app.wait(id); };
    const to = async (harnessId: string, key: string) => { app.switch(id, { harnessId }, key); await app.wait(id); };
    // Bravo's Turn is given to alpha in a packet: alpha holds everything of bravo's, and nothing is owed to it. Then the command ran on alpha.
    await send("a1", "a1"); await to("bravo", "to-b"); await send("b1", "b1"); await to("alpha", "to-a"); await send("a2", "a2");
    if (command !== "") await send(command, "command");
    await app.close();
    const state = v12(w.store.snapshot(id)), events = all(w.store, id).map(event => v12Event({ seq: event.seq, type: event.type, data: event.data })), runs = state.runs;
    const v12data = downgrade(w, [id]);
    w.store.close();
    assert.deepEqual(runs.find(run => run.input === "a2")!.sourceRunIds, [runs.find(run => run.input === "b1")!.id], label + ": alpha was given bravo's Turn");
    const migrated = migrateSession(state, events), at = (harnessId: string) => migrated.bindings[state.nativeBindings!.findIndex(binding => binding.harnessId === harnessId)]!;
    const b1 = migrated.runs.find(row => row.runId === runs.find(run => run.input === "b1")!.id)!;
    assert.ok(at("alpha").mark >= b1.seq, label + ": nothing is owed to alpha (its mark " + at("alpha").mark + " covers bravo's Turn, seq " + b1.seq + ")");
    assert.equal(at("alpha").resendAll, resendAll, label + ": alpha");
    assert.equal(at("bravo").resendAll, false, label + ": the command ran on alpha only");
    // The Store migrates the same database to the same relay state.
    const store = appStore(v12data);
    try { assert.deepEqual(store.snapshot(id).nativeBindings?.map(row => row.relay), migrated.bindings, label + ": the Store's migration"); }
    finally { store.close(); }
  }
});

// The independent review of 2026-11-11 (lost content): a command that entered the context like a message (effect keep) was no fact, so the
// next Harness never heard of that Turn. A v12 conversation's commands are placed by the migration's index rows, which say each one's effect.
test("G066-C02 a v12 command that entered the context like a message (effect keep) is a fact after the migration: the next Harness is given its Turn, a command of any other effect is not", async t => {
  const w = world(t, 96, { rejected: 0, lost: 0 });
  const id = (await w.runtime.create(configuration(w.workspace), { harnessId: "alpha" }, "create")).id;
  const send = async (text: string, key: string) => { w.runtime.send(id, text, key); await w.runtime.wait(id); };
  await send("a1", "a1"); await send("/skill review the diff", "skill");
  for (const [index, words] of ["/compact", "/model model-a", "/undo", "/mystery", "/clear"].entries()) await send(words, "other-" + index);
  await w.runtime.close();
  const v12data = downgrade(w, [id]); w.store.close();
  w.store = appStore(v12data); w.harness.use(w.store);
  w.runtime = new SessionRuntime(w.store, w.harness, { id: w.next, now: () => new Date(Date.UTC(2026, 10, 10)), publish: () => {}, content, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  const runs = w.store.snapshot(id).runs, ofInput = (input: string) => runs.find(run => run.input === input)!;
  assert.deepEqual(w.store.relayIndex(id).filter(row => row.index.commandEffect === "keep").map(row => row.runId), [ofInput("/skill review the diff").id], "the migration placed the skill as a command that kept");
  w.runtime.switch(id, { harnessId: "bravo" }, "to-b"); await w.runtime.wait(id);
  await send("b1", "b1");
  const prepared = all(w.store, id).findLast(event => event.type === "run.context_prepared" && event.data.runId === w.store.snapshot(id).runs.find(run => run.input === "b1")!.id);
  assert.deepEqual(prepared?.data.sourceRunIds, [ofInput("a1").id, ofInput("/skill review the diff").id], "alpha's Turn and its skill, and none of the other commands");
  await w.runtime.close(); w.store.close();
});
