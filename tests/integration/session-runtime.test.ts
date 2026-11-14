import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlRun, type HarnessControl, type NativeConversationId, type ProtocolObservation, type TurnText } from "../../src/contracts/control.js";
import { SessionError, STREAM_WINDOW_MS, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/delivery.js";
import { appStore } from "../fixtures/runtime-store.js";
import type { FileConversationStore } from "../../src/infrastructure/session/file-store.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import { wireItem } from "../../src/web/commit-frame.js";
import { oldShape } from "../fixtures/old-shape.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
class Gate<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() { this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
}
interface Fixture { readonly root: string; readonly store: FileConversationStore; readonly stores: FileConversationStore[]; readonly configuration: SessionConfiguration; readonly runtimes: SessionRuntime[] }
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-session-runtime-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const store = appStore(join(root, "data"));
  const stores = [store];
  const runtimes: SessionRuntime[] = [];
  t.after(async () => {
    const unsound: string[] = []; let checked = 0;
    try {
      for (const app of runtimes) {
        try { await app.close(); }
        // A fault test may already have poisoned its Store, or replaced the owner marker (the ADR-047 owner-loss case).
        catch (error) { if (!(error instanceof SessionError) || !["SESSION_BLOCKED", "PUBLICATION_FAILED", "STORAGE_UNAVAILABLE", "OWNER_LOST"].includes(error.code)) throw error; }
      }
      // Whatever the test did, the conversations it left break no rule of the whole-conversation check: among them that every content the rows mention (a call's detail, an
      // artifact, an attachment, the history a branch quoted) is registered, so that the collector cannot delete what a Turn still shows.
      for (const owned of stores) {
        try { for (const row of owned.list({ limit: 1000 }).rows) { checked++; for (const violation of verify(owned.get(row.id), owned)) unsound.push(row.id + ": " + violation.rule + " at " + violation.where + " (" + violation.detail + ")"); } }
        catch { /* a fault test may already have poisoned its Store, which then answers nothing */ }
      }
    } finally {
      for (const owned of stores) try { owned.close(); } catch { /* A fault test may already poison its Store. */ }
      await rm(root, { recursive: true, force: true });
    }
    if (process.env.RUNTIME_TEST_VERBOSE) t.diagnostic("the whole-conversation check ran over " + checked + " conversation(s)");
    assert.deepEqual(unsound, [], "the conversations the test left break no rule");
  });
  return { root, store, stores, runtimes, configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true } };
}
/** What the Runtime publishes is a commit; these tests read the events it logged. */
const eventsOf = (consume: (event: SessionEvent) => void) => (commit: { readonly events: readonly SessionEvent[] }): void => { for (const event of commit.events) consume(event); };
function runtime(f: Fixture, factory: SessionBindingFactory, publish: (event: SessionEvent) => void = () => {}, idPrefix = ""): SessionRuntime {
  let id = 0;
  const app = new SessionRuntime(f.store, factory, { id: () => idPrefix + String(++id), now: () => new Date("2026-10-09T00:00:00Z"), publish: eventsOf(publish),
    fingerprint: value => createHash("sha256").update(value).digest("hex") });
  f.runtimes.push(app); return app;
}
function selection(request: SelectionRequest): HarnessSelection {
  if (request.harnessId !== "alpha" && request.harnessId !== "bravo") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
  const controlId = request.harnessId === "alpha" ? "alpha-acp" : "bravo-codex";
  if (request.controlId !== undefined && request.controlId !== controlId) throw new SessionError("CONTROL_UNAVAILABLE", "fixture control is unavailable");
  return { harnessId: request.harnessId, controlId, ...(request.provider == null ? {} : { provider: request.provider }) };
}
class PeerFactory implements SessionBindingFactory {
  readonly prepared: { readonly run: string; readonly selection: HarnessSelection; readonly trace: string; readonly pid: string; closed: boolean }[] = [];
  readonly lease: SqliteWorkspaceLeaseProvider;
  constructor(private readonly root: string, private readonly scenario = "chunks") { this.lease = new SqliteWorkspaceLeaseProvider(join(root, "leases")); }
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return selection(request); }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    assert.ok(this.prepared.every(item => item.closed), "next native connection started before preceding cleanup");
    const lease = this.lease.acquire(configuration.workspace, session, run);
    const index = this.prepared.length, trace = join(this.root, "trace-" + index + ".ndjson"), pid = join(this.root, "peer-" + index + ".pid");
    const entry = { run, selection: selected, trace, pid, closed: false }; this.prepared.push(entry);
    const protocol = selected.harnessId === "alpha" ? "acp-v1" : "codex-app-server";
    const env = { FIXTURE_TRACE: trace, FIXTURE_PID: pid, LANG: "C.UTF-8" };
    const launch = { protocol, executable: process.execPath, args: [peer, protocol, this.scenario], env, provenance: "fixture" } as const;
    const options = { cwd: configuration.workspace, env, requestTimeoutMs: 1000, runTimeoutMs: 2000, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 4096, closeGraceMs: 120 };
    const control = protocol === "acp-v1" ? new AcpControl(launch, options) : new CodexControl(launch, options);
    let close: Promise<CleanupEvidence> | null = null;
    return { control, workspace: configuration.workspace, assertOwned: () => lease.assertOwned(), close: () => {
      close ??= (async () => { let evidence: CleanupEvidence | null = null; try { evidence = await control.close(); return evidence; }
        finally { lease.release(evidence?.closed === true); entry.closed = true; } })();
      return close;
    } };
  }
}
interface ControlledPeer {
  readonly started: Gate<string>;
  readonly result: Gate<BackendResult>;
  readonly closing: Gate<void>;
  readonly closed: Gate<CleanupEvidence>;
  readonly initialized: Gate<void>;
  readonly initialize: Gate<void> | null;
  readonly holdResult: boolean;
  readonly holdClose: boolean;
  readonly output: string;
  stopCount: number;
  closeCount: number;
}
function controlled(options: { holdResult?: boolean; holdClose?: boolean; holdInitialize?: boolean; output?: string } = {}): ControlledPeer {
  return { started: new Gate(), result: new Gate(), closing: new Gate(), closed: new Gate(), initialized: new Gate(),
    initialize: options.holdInitialize ? new Gate() : null, holdResult: options.holdResult ?? false,
    holdClose: options.holdClose ?? false, output: options.output ?? "synthetic response", stopCount: 0, closeCount: 0 };
}
class ControlledFactory implements SessionBindingFactory {
  readonly prepared: { readonly run: string; readonly selection: HarnessSelection; readonly peer: ControlledPeer }[] = [];
  constructor(private readonly peers: readonly ControlledPeer[]) {}
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return selection(request); }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration, _session: SessionId, run: string): Promise<PreparedSessionBinding> {
    const fixture = this.peers[this.prepared.length] ?? controlled(); this.prepared.push({ run, selection: selected, peer: fixture });
    let closing: Promise<CleanupEvidence> | null = null, opened = false;
    const control: HarnessControl = {
      initialize: async () => { fixture.initialized.resolve(); if (fixture.initialize) await fixture.initialize.promise; return { protocol: "acp-v1", protocolVersion: 1, agentName: "controlled-fixture", agentVersion: "1", authenticationMethods: [], capabilities: {} } satisfies ProtocolObservation; },
      open: async () => { opened = true; return nativeConversationId("external-fixture"); },
      // A Driver without a placement of its own flattens what it is handed (singleText, G068 phase two).
      startText: async (_id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void): Promise<ControlRun> => {
        assert.equal(opened, true); fixture.started.resolve(singleText(text)); output({ type: "text", text: fixture.output });
        // It answered the prompt, so like a driver it reports the prompt recorded (ADR-055 §7.1); no evidence would be resent once.
        if (!fixture.holdResult) fixture.result.resolve({ status: "completed", reason: "fixture", input: "recorded" });
        return { result: fixture.result.promise, requestStop: async () => { fixture.stopCount += 1; return { requested: true }; } };
      },
      close: () => {
        if (!closing) {
          fixture.closeCount += 1; fixture.closing.resolve();
          if (fixture.initialize) fixture.initialize.reject(new SessionError("CLOSED", "external connection closed"));
          if (!fixture.holdClose) fixture.closed.resolve(clean);
          closing = fixture.closed.promise;
        }
        return closing;
      },
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
async function trace(path: string): Promise<readonly Record<string, unknown>[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}
/**
 * The rows are the only record (ADR-057 step 2): what the Runtime wrote of the Turns it ran holds none of the fields of the old display shape, neither in a Run's row nor in a
 * conversation's head. The words, the tools, the plan, the notices, the activities and the outputs are items.
 */
/** The lines of every conversation file under the data root (`kind`: the main files, their WIP logs or their event logs). */
function sessionLines(f: Fixture, kind: "main" | "wip" | "events" = "main"): Record<string, unknown>[] {
  const dir = join(f.root, "data", "sessions"), found: Record<string, unknown>[] = [];
  for (const folder of readdirSync(dir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const name of readdirSync(join(dir, folder.name))) {
      const wanted = kind === "wip" ? name.endsWith(".wip.jsonl") : kind === "events" ? name.endsWith(".events.jsonl") : name.endsWith(".jsonl") && !name.endsWith(".wip.jsonl") && !name.endsWith(".events.jsonl");
      if (!wanted) continue;
      for (const line of readFileSync(join(dir, folder.name, name), "utf8").split("\n")) if (line !== "") found.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return found;
}
function assertRowsAreTheOnlyRecord(f: Fixture): void {
  const lines = sessionLines(f), runs = lines.filter(line => line.type === "turn"), items = lines.filter(line => line.type === "item");
  assert.ok(runs.length > 0 && items.length > 0, "something was written");
  for (const line of runs) {
    const run = line.run as { readonly runId: string; readonly facts: Record<string, unknown> };
    for (const key of ["input", "tools", "thinking", "notices", "activities", "outputs", "plan", "protocol", "protocolProblem"]) assert.equal(key in run.facts, false, run.runId + ": a Run's row keeps no `" + key + "`");
  }
  for (const line of lines.filter(entry => entry.type === "head")) {
    const head = line.head as Record<string, unknown>;
    for (const key of ["messages", "runs", "schemaVersion"]) assert.equal(key in head, false, "a conversation's head keeps no `" + key + "`");
  }
}

test("cancelling during native command discovery never dispatches the command", async t => {
  const f = await fixture(t), peer = controlled(), factory = new ControlledFactory([peer]);
  const reading = new Gate<void>(), catalog = new Gate<void>();
  const prepare = factory.prepare.bind(factory);
  let dispatched = 0;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control,
      models: async () => { reading.resolve(); await catalog.promise; return {
        models: [], defaultModel: null, canSelect: false, authentication: "unknown" as const,
        commands: [{ name: "native-help", description: "fixture command" }],
      }; },
      startText: async (...input) => { dispatched++; return binding.control.startText(...input); },
    } };
  };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const sent = app.send(session.id, "/native-help", "send");
  await reading.promise;
  app.cancel(session.id, "cancel", sent.runId); catalog.resolve();
  await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(dispatched, 0); assert.equal(run.status, "cancelled");
  assert.equal(run.backend, null); assert.equal(run.cleanup?.closed, true);
  assert.equal(peer.closeCount, 1); assert.equal(oldShape(app, session.id).status, "open");
});

test("real files and ACP/Codex IPC retain one public Session through A to B to A with new connections", async (t) => {
  const f = await fixture(t), factory = new PeerFactory(f.root), published: SessionEvent[] = [], app = runtime(f, factory, value => {
    assert.ok(f.store.events(value.sessionId, value.seq - 1, 1).some(event => event.seq === value.seq), "event published before commit"); published.push(value);
  });
  t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "first public question", "first"); await app.wait(state.id);
  app.send(state.id, "second public question", "second"); await app.wait(state.id);
  const switched = app.switch(state.id, { harnessId: "bravo" }, "switch-b"); await app.wait(state.id);
  app.send(state.id, "third public question", "third"); await app.wait(state.id);
  app.switch(state.id, { harnessId: "alpha" }, "switch-a"); await app.wait(state.id);
  app.send(state.id, "fourth public question", "fourth"); await app.wait(state.id);
  const final = oldShape(app, state.id);
  assert.equal(final.id, state.id); assert.equal(final.epoch, 3); assert.equal(final.status, "open");
  assert.deepEqual(final.runs.map(run => run.status), ["completed", "completed", "completed", "completed"]);
  assert.deepEqual(final.runs.map(run => run.selection.harnessId), ["alpha", "alpha", "bravo", "alpha"]);
  assert.deepEqual(final.runs.map(run => run.epoch), [1, 1, 2, 3]);
  assert.equal(final.switches.find(sw => sw.id === switched.switchId)?.status, "effective");
  assert.equal(factory.prepared.length, 4); assert.ok(factory.prepared.every(entry=>!entry.run.startsWith("switch-"))); assert.ok(factory.prepared.every(entry => entry.closed));
  const prompts: string[] = [];
  for (const entry of factory.prepared) {
    const messages = await trace(entry.trace), sent = messages.find(message => message.method === "session/prompt" || message.method === "turn/start");
    if (entry.run.startsWith("switch-")) assert.equal(sent, undefined, "switch validation sent a prompt");
    else { assert.ok(sent); prompts.push(JSON.stringify(sent)); }
    const pid = Number(await readFile(entry.pid, "utf8")); assert.throws(() => process.kill(pid, 0));
  }
  assert.match(prompts[1]!, /first public question/); assert.match(prompts[1]!, /first second/);
  assert.match(prompts[3]!, /first public question/); assert.match(prompts[3]!, /third public question/);
  assert.deepEqual(final.runs[3]?.sourceRunIds, final.runs.slice(0, 3).map(run => run.id));
  assert.equal(final.lastSeq, published.length);
  // The rows a whole run wrote (four Turns, a switch each way, the bindings) are a conversation the store's checker has nothing to say about.
  assert.deepEqual(verify(f.store.get(state.id), f.store), []);
  assertRowsAreTheOnlyRecord(f);
  // And what the old readers are given of it is what the rows say: the user's words and the answers, in the order of the Turns.
  assert.deepEqual(f.store.snapshot(state.id).runs.map(run => run.userMessageId), final.runs.map(run => run.userMessageId));
});

test("each Run records when it was accepted, prepared, ready, dispatched, first answered and ended, in that order", async t => {
  const f = await fixture(t), factory = new PeerFactory(f.root);
  let clock = Date.parse("2026-10-11T00:00:00Z"), id = 0;
  // Every reading moves the clock on, so each recorded phase has its own time.
  const app = new SessionRuntime(f.store, factory, { id: () => "timing-" + String(++id), now: () => new Date(clock += 7), publish: () => {},
    fingerprint: value => createHash("sha256").update(value).digest("hex") });
  f.runtimes.push(app);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "timed question", "timed"); await app.wait(state.id);
  const run = oldShape(app, state.id).runs[0]!, timing = run.timing!;
  assert.equal(run.status, "completed");
  const order = [timing.acceptedAt, timing.preparingAt, timing.readyAt, timing.dispatchedAt, timing.firstOutputAt, timing.endedAt];
  assert.ok(order.every(value => typeof value === "number"), "every phase of a completed Run is recorded");
  assert.deepEqual([...order].sort((a, b) => a! - b!), order, "phases are recorded in order");
  const types = f.store.events(state.id, 0, 100).map(row => row.type);
  assert.equal(types.filter(type => type === "run.dispatched").length, 1); assert.equal(types.filter(type => type === "run.first_output").length, 1);
  assert.ok(types.indexOf("run.dispatched") < types.indexOf("run.first_output"));
});

test("idempotent create/send/switch/cancel persist one intent and reject key conflicts", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory); t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  assert.equal((await app.create(f.configuration, { harnessId: "alpha" }, "create")).id, state.id);
  await assert.rejects(() => app.create(f.configuration, { harnessId: "bravo" }, "create"), /another request/);
  const sent = app.send(state.id, "idempotent input", "send");
  assert.equal(app.send(state.id, "idempotent input", "send").replayed, true);
  assert.throws(() => app.send(state.id, "different", "send"), /another request/);
  const cancelled = app.cancel(state.id, "cancel", sent.runId);
  assert.equal(cancelled.target, sent.runId); assert.equal(app.cancel(state.id, "cancel", sent.runId).replayed, true);
  const switched = app.switch(state.id, { harnessId: "bravo" }, "switch");
  assert.equal(app.switch(state.id, { harnessId: "bravo" }, "switch").switchId, switched.switchId);
  assert.throws(() => app.switch(state.id, { harnessId: "alpha" }, "switch"), /another request/);
  await app.wait(state.id); assert.equal(oldShape(app, state.id).runs.length, 1); assert.equal(oldShape(app, state.id).switches.length, 1);
  assert.ok(!factory.prepared.some(entry => entry.run === sent.runId), "cancelled queued input was launched");
});

test("busy switch waits for old cleanup and freezes its source identities before later queued cancellation", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true, holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory); t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const initial = app.send(state.id, "current input", "first"); await first.started.promise;
  const switchReceipt = app.switch(state.id, { harnessId: "bravo" }, "switch");
  const cancelled = app.send(state.id, "must not enter switch manifest", "cancelled"); app.cancel(state.id, "cancel", cancelled.runId);
  const next = app.send(state.id, "queued next input", "next");
  assert.throws(() => app.switch(state.id, { harnessId: "alpha" }, "another-switch"), /already pending/);
  first.result.resolve({ status: "completed", reason: "fixture" }); await first.closing.promise;
  assert.equal(factory.prepared.length, 1); assert.equal(oldShape(app, state.id).selection.harnessId, "alpha");
  first.closed.resolve(clean); await app.wait(state.id);
  const final = oldShape(app, state.id), sw = final.switches.find(sw => sw.id === switchReceipt.switchId)!;
  assert.equal(sw.status, "effective"); assert.deepEqual(sw.sourceRunIds, [initial.runId]);
  assert.ok(sw.throughSeq >= final.runs[0]!.contextThroughSeq);
  assert.equal(final.runs.find(run => run.id === next.runId)?.selection.harnessId, "bravo");
  assert.equal(factory.prepared.length, 2);
});

test("new queued input is not included in the active Turn prompt and cancellation wins over late completion", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory); t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const active = app.send(state.id, "first active input", "first");
  const queued = app.send(state.id, "future queued input", "queued");
  const prompt = await first.started.promise; assert.ok(!prompt.includes("future queued input"));
  app.cancel(state.id, "cancel", active.runId); first.result.resolve({ status: "completed", reason: "late completion" });
  await app.wait(state.id);
  const final = oldShape(app, state.id);
  assert.equal(final.runs[0]?.status, "cancelled"); assert.equal(final.runs[0]?.backend?.status, "completed");
  assert.equal(final.runs[1]?.id, queued.runId); assert.equal(final.runs[1]?.status, "completed");
  assert.equal(first.stopCount, 1); assert.equal(first.closeCount, 1);
});

test("cancel during initialization closes connection without dispatching the input", async (t) => {
  const f = await fixture(t), first = controlled({ holdInitialize: true }), factory = new ControlledFactory([first]), app = runtime(f, factory); t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"), receipt = app.send(state.id, "no dispatch", "send");
  await first.initialized.promise; app.cancel(state.id, "cancel", receipt.runId); await app.wait(state.id);
  assert.equal(oldShape(app, state.id).runs[0]?.status, "cancelled"); assert.equal(oldShape(app, state.id).runs[0]?.backend, null);
  assert.equal(first.stopCount, 0); assert.equal(first.closeCount, 1);
});

test("one global writer waits for confirmed close before another Session starts", async (t) => {
  const f = await fixture(t), first = controlled({ holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory); t.after(() => app.close());
  const a = await app.create(f.configuration, { harnessId: "alpha" }, "a"), b = await app.create(f.configuration, { harnessId: "bravo" }, "b");
  app.send(a.id, "writer a", "a-input"); await first.closing.promise;
  app.send(b.id, "writer b", "b-input"); assert.equal(factory.prepared.length, 1);
  first.closed.resolve(clean); await app.wait(b.id);
  assert.equal(factory.prepared.length, 2); assert.equal(oldShape(app, b.id).runs[0]?.status, "completed");
});

test("target validation failure keeps actual selection and history, but never dispatches input awaiting that switch", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory); t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "preserved input", "first"); await app.wait(state.id);
  app.switch(state.id, { harnessId: "missing" }, "bad-switch"); app.send(state.id, "continue explicitly on alpha", "next"); await app.wait(state.id);
  const final = oldShape(app, state.id);
  assert.equal(final.selection.harnessId, "alpha"); assert.equal(final.epoch, 1); assert.equal(final.switches[0]?.status, "failed");
  assert.equal(final.runs[1]?.status, "failed"); assert.equal(final.runs[1]?.error?.code, "SWITCH_NOT_EFFECTIVE");
  assert.equal(factory.prepared.length, 1);
  app.send(state.id, "explicit continuation after failed switch", "continue"); await app.wait(state.id);
  assert.equal(oldShape(app, state.id).runs[2]?.status, "completed"); assert.equal(oldShape(app, state.id).runs[2]?.selection.harnessId, "alpha");
});

test("unconfirmed cleanup blocks next writer and does not rerun or activate pending switch", async (t) => {
  const f = await fixture(t), first = controlled({ holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  t.after(async () => { try { await app.close(); } catch {} });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "unknown cleanup", "first"); await first.closing.promise;
  app.switch(state.id, { harnessId: "bravo" }, "switch"); app.send(state.id, "never launched", "next");
  first.closed.reject(new SessionError("CLEANUP_FAILED", "synthetic unconfirmed cleanup"));
  await assert.rejects(() => app.wait(state.id), /new dispatch is disabled/);
  const final = oldShape(app, state.id);
  assert.equal(final.status, "blocked"); assert.equal(final.runs[0]?.status, "unknown"); assert.equal(factory.prepared.length, 1);
  assert.equal(final.selection.harnessId, "alpha"); assert.throws(() => app.send(state.id, "retry", "retry"), /disabled/);
});

test("late protocol failure retains backend evidence, fails the reply and leaves a quiescent conversation usable", async (t) => {
  const f = await fixture(t), factory = new PeerFactory(f.root, "duplicate-complete"), app = runtime(f, factory);
  t.after(async () => { try { await app.close(); } catch {} });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "duplicate terminal", "send");
  await app.wait(state.id);
  const final = oldShape(app, state.id), run = final.runs[0]!;
  assert.equal(run.backend?.status, "completed"); assert.equal(run.cleanup?.closed, true); assert.notEqual(run.cleanup?.protocolFailure, null);
  assert.equal(run.status, "failed"); assert.equal(final.status, "open"); assert.equal(factory.prepared.length, 1);
  app.switch(state.id, { harnessId: "bravo" }, "next-selection"); await app.wait(state.id);
  assert.equal(oldShape(app, state.id).selection.harnessId, "bravo");
});

test("publication exception occurs after commit, stops resources and records blocked without publishing uncommitted facts", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]); let failed = false;
  const app = runtime(f, factory, value => {
    assert.equal(f.store.events(value.sessionId, value.seq - 1, 1)[0]?.seq, value.seq);
    if (value.type === "run.output") { failed = true; throw new Error("synthetic observer failed"); }
  });
  t.after(async () => { try { await app.close(); } catch {} });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "publication test", "send");
  await assert.rejects(() => app.wait(state.id), /publication failed/);
  assert.equal(failed, true); assert.equal(factory.prepared[0]?.peer.closeCount, 1);
  assert.equal(oldShape(app, state.id).status, "blocked"); assert.ok(oldShape(app, state.id).messages.some(message => message.role === "assistant"));
});

test("Session close and runtime close cancel queued inputs, await active cleanup and preserve historical facts", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "active", "active"); await first.started.promise;
  app.send(state.id, "queued", "queued"); const closed = app.closeSession(state.id, "close");
  first.result.resolve({ status: "cancelled", reason: "fixture" });
  assert.equal((await closed).status, "closed"); assert.equal((await app.closeSession(state.id, "close")).status, "closed");
  assert.equal(factory.prepared.length, 1); assert.ok(oldShape(app, state.id).runs.every(run => run.status === "cancelled"));
  assert.throws(() => app.send(state.id, "after close", "late"), /closed or blocked/);
  const second = await app.create(f.configuration, { harnessId: "alpha" }, "second"); app.send(second.id, "cancel before runtime stop", "second-input");
  await app.close(); assert.equal(oldShape(app, second.id).status, "open"); assert.equal(oldShape(app, second.id).runs[0]?.status, "cancelled");
  assert.throws(() => app.send(second.id, "late", "late"), /not accepting/);
  f.store.assertOwner();
});

test("completed public history survives Store reopen with no automatic dispatch", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "durable history", "send"); await app.wait(state.id); await app.close();
  f.store.close();
  const reopened = appStore(join(f.root, "data")); t.after(() => reopened.close());
  assert.equal(reopened.get(state.id).runs[0]?.status, "completed"); assert.equal(reopened.snapshot(state.id).messages[0]?.text, "durable history");
  assert.equal(factory.prepared.length, 1); assert.ok(reopened.ownerGeneration > f.store.ownerGeneration);
  reopened.close();
});

test("closing during a busy pending switch retains source identity until old execution settles", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const active = app.send(state.id, "old execution", "active"); await first.started.promise;
  const sw = app.switch(state.id, { harnessId: "bravo" }, "switch");
  const closing = app.closeSession(state.id, "close");
  assert.equal(oldShape(app, state.id).switches[0]?.status, "requested");
  first.result.resolve({ status: "cancelled", reason: "fixture" });
  const final = await closing;
  assert.equal(final.status, "closed"); assert.equal(final.pendingSwitchId, null); assert.equal(final.selection.harnessId, "alpha");
  assert.equal(final.switches[0]?.id, sw.switchId); assert.equal(final.switches[0]?.status, "failed");
  assert.deepEqual(final.switches[0]?.sourceRunIds, [active.runId]); assert.equal(factory.prepared.length, 1);
});

test("a message over its byte limit is refused, the queue of waiting inputs has no count limit of its own, and cancelled tombstones launch nothing", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  for (const value of ["", " ", "nul\0input"])
    assert.throws(() => app.send(state.id, value, "invalid"), /32 MiB/);
  // Eight was the most inputs a conversation held waiting; the queue is the conversation's Turns that have not started, bounded only by the conversation itself.
  const receipts = Array.from({ length: 40 }, (_, index) => app.send(state.id, "queued " + index, "send-" + index));
  for (const [index, receipt] of receipts.entries()) app.cancel(state.id, "cancel-" + index, receipt.runId);
  await app.wait(state.id);
  assert.equal(factory.prepared.length, 0); assert.ok(oldShape(app, state.id).runs.every(run => run.status === "cancelled"));
});

test("inputs queued before switch retain their original Harness and become completed switch context sources", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const active = app.send(state.id, "first active", "first"); await first.started.promise;
  const before = app.send(state.id, "old Harness queued input", "before");
  const sw = app.switch(state.id, { harnessId: "bravo" }, "switch");
  const after = app.send(state.id, "new Harness queued input", "after");
  first.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(state.id);
  const final = oldShape(app, state.id), firstSwitch = final.switches.find(entry => entry.id === sw.switchId)!;
  assert.deepEqual(factory.prepared.map(entry => entry.selection.harnessId), ["alpha", "alpha", "bravo"]);
  assert.deepEqual(firstSwitch.sourceRunIds, [active.runId, before.runId]);
  assert.equal(final.runs.find(run => run.id === before.runId)?.epoch, 1);
  assert.equal(final.runs.find(run => run.id === before.runId)?.awaitingSwitchId, null);
  assert.equal(final.runs.find(run => run.id === after.runId)?.epoch, 2);
  assert.equal(final.runs.find(run => run.id === after.runId)?.awaitingSwitchId, sw.switchId);
  assert.ok(!firstSwitch.sourceRunIds.includes(after.runId));
});

test("missing backend settlement times out, confirms resource closure and never replays queued input", async (t) => {
  const f = await fixture(t), factory = new PeerFactory(f.root, "no-settlement"), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "unknown external result", "first"); app.send(state.id, "do not replay", "second");
  await assert.rejects(() => app.wait(state.id), /disabled/);
  const final = oldShape(app, state.id);
  assert.equal(final.status, "blocked"); assert.equal(final.runs[0]?.backend, null); assert.equal(final.runs[0]?.status, "unknown");
  assert.equal(final.runs[0]?.cleanup?.closed, true); assert.equal(factory.prepared.length, 1);
  const pid = Number(await readFile(factory.prepared[0]!.pid, "utf8")); assert.throws(() => process.kill(pid, 0));
});

test("binding preparation cleanup failure blocks the Session even when no control was returned", async (t) => {
  const f = await fixture(t); let prepares = 0;
  const app = runtime(f, { validate: async request => selection(request), prepare: async () => { prepares += 1; throw new SessionError("BINDING_CLEANUP_FAILED", "synthetic resource owner could not close"); } });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "preparation unknown", "first"); app.send(state.id, "do not launch", "second");
  await assert.rejects(() => app.wait(state.id), /disabled/);
  assert.equal(oldShape(app, state.id).status, "blocked"); assert.equal(oldShape(app, state.id).runs[0]?.status, "unknown"); assert.equal(prepares, 1);
});

test("publication failure after terminal commit preserves completion evidence and durably blocks further dispatch", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory, value => {
    if (value.type === "run.ended") throw new Error("terminal observer failure");
  });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "known completed input", "send");
  await assert.rejects(() => app.wait(state.id), /publication failed/);
  const final = oldShape(app, state.id);
  assert.equal(final.runs[0]?.status, "completed"); assert.equal(final.runs[0]?.backend?.status, "completed");
  assert.equal(final.runs[0]?.cleanup?.closed, true); assert.equal(final.status, "blocked"); assert.equal(factory.prepared.length, 1);
});

test("switch effective watermark advances through validation without creating an unused target connection while later inputs stay excluded from sources", async (t) => {
  const f = await fixture(t), validating = new Gate<void>(), release = new Gate<void>(), factory = new ControlledFactory([]);
  const validate = factory.validate.bind(factory); factory.validate = async request => { const target = await validate(request); if(request.harnessId==="bravo"){validating.resolve();await release.promise;} return target; }; const app=runtime(f,factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"), sw = app.switch(state.id, { harnessId: "bravo" }, "switch");
  await validating.promise;
  const later = app.send(state.id, "later cancelled input", "later"); app.cancel(state.id, "cancel", later.runId);
  const beforeEffective = oldShape(app, state.id).lastSeq;
  release.resolve(); await app.wait(state.id);
  const final = oldShape(app, state.id), effective = final.switches.find(entry => entry.id === sw.switchId)!;
  assert.equal(effective.throughSeq, beforeEffective + 1); assert.deepEqual(effective.sourceRunIds, []);
  assert.equal(effective.status, "effective"); assert.equal(final.runs[0]?.status, "cancelled");
  assert.equal(factory.prepared.length, 0);
});

test("runtime shutdown waits for in-flight creation validation to release its real private directory", async (t) => {
  const f = await fixture(t), validating = new Gate<void>(), release = new Gate<void>(), directory = join(f.root, "validation-resource");
  const app = runtime(f, {
    validate: async request => { await mkdir(directory); validating.resolve(); try { await release.promise; return selection(request); }
      finally { await rm(directory, { recursive: true }); } },
    prepare: async () => { throw new Error("closed creation must not prepare a binding"); },
  });
  const creating = app.create(f.configuration, { harnessId: "alpha" }, "create");
  const creationFailure = assert.rejects(creating, (error: unknown) => error instanceof SessionError && error.code === "RUNTIME_CLOSED");
  await validating.promise;
  let finished = false; const closing = app.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.ok((await readdir(f.root)).includes("validation-resource"));
  f.store.assertOwner(); assert.equal(f.store.list().rows.length, 0);
  release.resolve(); await Promise.all([closing, creationFailure]);
  assert.equal(finished, true); assert.ok(!(await readdir(f.root)).includes("validation-resource"));
  f.store.assertOwner(); assert.equal(f.store.list().rows.length, 0);
});

test("creations are not limited in number: twenty-four hold validation resources at once, and closing the runtime ends every one of them", async (t) => {
  const f = await fixture(t), allReady = new Gate<void>(), release = new Gate<void>(); let calls = 0, ready = 0;
  const app = runtime(f, {
    validate: async request => {
      const directory = join(f.root, "validation-" + ++calls); await mkdir(directory);
      if (++ready === 24) allReady.resolve();
      try { await release.promise; return selection(request); } finally { await rm(directory, { recursive: true }); }
    }, prepare: async () => { throw new Error("validation-only fixture must not prepare"); },
  });
  const creations = Array.from({ length: 24 }, (_, index) => app.create(f.configuration, { harnessId: "alpha" }, "create-" + index));
  const failures = creations.map(pending => assert.rejects(pending, (error: unknown) => error instanceof SessionError && error.code === "RUNTIME_CLOSED"));
  await allReady.promise;
  assert.equal(calls, 24); assert.equal((await readdir(f.root)).filter(name => name.startsWith("validation-")).length, 24);
  const closing = app.close(); f.store.assertOwner(); release.resolve(); await Promise.all([closing, ...failures]);
  assert.equal((await readdir(f.root)).filter(name => name.startsWith("validation-")).length, 0); assert.equal(f.store.list().rows.length, 0);
});

test("shutdown owns one Promise before committed-event callbacks can reenter close", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]); let app!: SessionRuntime, reentered: Promise<void> | null = null;
  app = runtime(f, factory, value => { if (value.type === "runtime.stopping") reentered = app.close(); });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "cancel before launch", "send");
  const closing = app.close(); assert.equal(app.close(), closing); await closing;
  assert.equal(reentered, closing); assert.equal(factory.prepared.length, 0); assert.equal(oldShape(app, state.id).runs[0]?.status, "cancelled");
});

const providerA = { providerId: "provider-11111111-1111-4111-8111-111111111111", revision: 1, model: "model-a" };
const providerB = { providerId: "provider-22222222-2222-4222-8222-222222222222", revision: 2, model: "model-b" };
test("Provider switch pins the current Turn and waits for cleanup before changing the next Turn", async t => {
  const f = await fixture(t), first = controlled({ holdResult: true, holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha", provider: providerA }, "provider-create");
  const initial = app.send(state.id, "on A", "provider-first"); await first.started.promise;
  app.switch(state.id, { harnessId: "alpha", provider: providerB }, "provider-switch");
  const next = app.send(state.id, "on B", "provider-next");
  assert.deepEqual(oldShape(app, state.id).selection.provider, providerA);
  first.result.resolve({ status: "completed", reason: "fixture" }); await first.closing.promise;
  assert.equal(factory.prepared.length, 1); assert.deepEqual(oldShape(app, state.id).runs[0]?.selection.provider, providerA);
  first.closed.resolve(clean); await app.wait(state.id);
  const final = oldShape(app, state.id);
  assert.equal(final.runs.find(run => run.id === initial.runId)?.selection.provider?.model, "model-a");
  assert.deepEqual(final.runs.find(run => run.id === next.runId)?.selection.provider, providerB);
  assert.deepEqual(final.selection.provider, providerB); assert.equal(final.epoch, 2);
});
test("Harness-only switch inherits Provider and an explicit null clears managed configuration", async t => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha", provider: providerA }, "inherit-create");
  app.switch(state.id, { harnessId: "bravo" }, "inherit-switch"); await app.wait(state.id);
  assert.deepEqual(oldShape(app, state.id).selection.provider, providerA);
  assert.equal(factory.prepared.length,0,"ordinary selection must not start a native process");
  app.switch(state.id, { harnessId: "alpha", provider: null }, "clear-switch"); await app.wait(state.id);
  assert.equal(oldShape(app, state.id).selection.provider, undefined);
});

test("initialization failure with confirmed close fails only that reply and permits another selection in the same Session", async t => {
  const f = await fixture(t), broken = controlled({ holdInitialize: true }), factory = new ControlledFactory([broken]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "before initialization", "first"); await broken.initialized.promise;
  broken.initialize!.reject(new SessionError("GATEWAY_AUTH_REQUIRED", "synthetic missing Gateway token"));
  await app.wait(state.id);
  const failed = oldShape(app, state.id); assert.equal(failed.status, "open"); assert.equal(failed.runs[0]!.status, "failed");
  assert.equal(failed.runs[0]!.backend, null); assert.equal(failed.runs[0]!.cleanup?.closed, true);
  app.switch(state.id, { harnessId: "bravo" }, "choose-working"); await app.wait(state.id);
  app.send(state.id, "explicit next request", "next"); await app.wait(state.id);
  const final = oldShape(app, state.id); assert.equal(final.id, state.id); assert.equal(final.runs[1]!.status, "completed");
  assert.equal(final.messages[0]!.text, "before initialization"); assert.equal(factory.prepared.length, 2);
});

test("a Session with unknown execution cannot poison a different workspace or admit unconfirmed automatic retries", async t => {
  const f = await fixture(t), unknown = controlled({ holdResult: true }), factory = new ControlledFactory([unknown]), app = runtime(f, factory);
  const blocked = await app.create(f.configuration, { harnessId: "alpha" }, "create-unknown");
  app.send(blocked.id, "unknown first request", "first"); await unknown.started.promise;
  unknown.result.reject(new SessionError("CONTROL_FAILED", "synthetic transport loss"));
  await assert.rejects(() => app.wait(blocked.id), /disabled for this Session/);
  const other = await app.create({ ...f.configuration, workspace: join(f.root, "other-workspace") }, { harnessId: "alpha" }, "create-other");
  app.send(other.id, "another workspace request", "other"); await app.wait(other.id);
  assert.equal(oldShape(app, other.id).runs[0]!.status, "completed"); assert.equal(oldShape(app, blocked.id).status, "blocked");
  assert.throws(() => app.send(blocked.id, "implicit retry", "bad-retry"), /disabled/);
  await app.closeSession(blocked.id, "archive-unknown"); assert.equal(oldShape(app, blocked.id).status, "closed");
  assert.equal(oldShape(app, blocked.id).runs[0]!.status, "unknown");
});

test("explicit recovery preserves unknown facts, cancels queued inputs and starts only the user's new request", async t => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "result is unknown", "first"); app.send(state.id, "queued input must never be replayed", "queued");
  await first.started.promise; first.result.reject(new SessionError("CONTROL_FAILED", "transport ended without settlement"));
  await assert.rejects(() => app.wait(state.id), /disabled/);
  const before = oldShape(app, state.id);
  assert.throws(() => app.resume(state.id, { harnessId: "bravo" }, "resume", false), error => error instanceof SessionError && error.code === "RECOVERY_ACK_REQUIRED");
  const receipt = app.resume(state.id, { harnessId: "bravo" }, "resume", true); await app.wait(state.id);
  const resumed = oldShape(app, state.id); assert.equal(resumed.status, "open"); assert.equal(resumed.epoch, 2);
  assert.deepEqual(resumed.runs[0], before.runs[0]); assert.equal(resumed.runs[1]!.status, "cancelled");
  assert.equal(factory.prepared.length, 2, "recovery only initializes a fresh connection");
  assert.equal(app.resume(state.id, { harnessId: "bravo" }, "resume", true).switchId, receipt.switchId);
  assert.throws(() => app.switch(state.id, { harnessId: "bravo" }, "resume"), /another request/);
  app.send(state.id, "new explicit input", "new"); await app.wait(state.id);
  assert.equal(factory.prepared.length, 3); assert.equal(oldShape(app, state.id).runs[2]!.status, "completed");
  assert.equal(oldShape(app, state.id).runs[0]!.status, "unknown");
  // The recovery switch took the unknown Turn over: the rows say which switch did (the open conversation holds no unknown Turn nobody acknowledged), and the checker agrees.
  const held = f.store.get(state.id);
  assert.equal(held.runs[0]!.status, "unknown"); assert.equal(held.runs[0]!.acknowledgedBy, receipt.switchId, "the unknown Turn is acknowledged by the recovery switch");
  assert.equal(held.runs[1]!.acknowledgedBy, undefined, "a cancelled one is not an unknown one");
  assert.deepEqual(verify(held, f.store), []);
});

test("legacy falsely blocked switch resumes with the same Session and immutable failed-switch evidence", async t => {
  const f=await fixture(t), factory=new ControlledFactory([]), validate=factory.validate.bind(factory); factory.validate=async request=>{if(request.harnessId==="bravo")throw new SessionError("GATEWAY_AUTH_REQUIRED","synthetic legacy authentication failure");return validate(request);}; const app=runtime(f,factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"), failed = app.switch(state.id, { harnessId: "bravo" }, "bad-switch");
  await app.wait(state.id);
  const cleanFailure = oldShape(app, state.id);
  f.store.transact(state.id, cleanFailure.version, current => ({ next: { ...current, status: "blocked" }, events: [{type:"switch.failed",data:{switchId:failed.switchId,error:{code:"GATEWAY_AUTH_REQUIRED"},cleanup:clean}},{ type: "session.blocked", data: { switchId: failed.switchId } }] }));
  app.resume(state.id, { harnessId: "alpha" }, "recover"); await app.wait(state.id);
  const current = oldShape(app, state.id); assert.equal(current.id, state.id); assert.equal(current.status, "open");
  assert.deepEqual(current.switches[0], cleanFailure.switches[0]); assert.equal(current.selection.harnessId, "alpha");
  assert.ok(f.store.events(state.id, 0, 100).some(value => value.type === "switch.effective" && value.data.recovered === true));
});

test("recovery refuses unconfirmed cleanup, authoritative failure and a closed Session without acquiring another binding", async t => {
  const f = await fixture(t), first = controlled({ holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "unconfirmed resources", "first");
  await first.closing.promise; first.closed.reject(new SessionError("CLEANUP_FAILED", "synthetic cleanup failure"));
  await assert.rejects(() => app.wait(state.id), /disabled/);
  assert.throws(() => app.resume(state.id, { harnessId: "bravo" }, "resume", true), error => error instanceof SessionError && error.code === "RECOVERY_UNSAFE");
  assert.equal(factory.prepared.length, 1);
  const separate = await app.create(f.configuration, { harnessId: "alpha" }, "separate");
  f.store.transact(separate.id, separate.version, current => ({ next: { ...current, status: "blocked" }, events: [{ type: "session.blocked", data: { error: { code: "PUBLICATION_FAILED" } } }] }));
  assert.throws(() => app.resume(separate.id, { harnessId: "alpha" }, "unsafe-owner"), error => error instanceof SessionError && error.code === "RECOVERY_UNSAFE");
  await app.closeSession(separate.id, "close");
  assert.throws(() => app.resume(separate.id, { harnessId: "alpha" }, "closed"), error => error instanceof SessionError && error.code === "RECOVERY_UNAVAILABLE");
});

test("native bindings survive process owners, A to B to A sends only unseen public facts, and explicit branches retain old state", async t => {
  const f = await fixture(t), peers = Array.from({ length: 5 }, () => controlled()), factory = new ControlledFactory(peers);
  const prepare = factory.prepare.bind(factory), resumes: (string | undefined)[] = [];
  factory.prepare = async (...args) => {
    const binding = await prepare(...args), original = binding.control.open;
    return { ...binding, control: { ...binding.control,
      open: async (cwd, model, options, checkpoint) => { resumes.push(checkpoint); return original(cwd, model, options, checkpoint); },
      checkpoint: async () => "private-native-" + args[0].harnessId,
    } };
  };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "first", "one"); await app.wait(session.id);
  app.send(session.id, "second", "two"); await app.wait(session.id);
  assert.equal(await peers[1]!.started.promise, "second");
  app.switch(session.id, { harnessId: "bravo" }, "to-b"); await app.wait(session.id);
  app.send(session.id, "third from bravo", "three"); await app.wait(session.id);
  app.switch(session.id, { harnessId: "alpha" }, "to-a"); await app.wait(session.id);
  app.send(session.id, "fourth", "four"); await app.wait(session.id);
  // Back on alpha, whose native session holds the first two Turns: a delta with only what happened while it was away.
  const delta = readRelayPrompt(await peers[3]!.started.promise);
  assert.equal(delta.kind, "delta"); assert.deepEqual(delta.history.map(row => row.user.text), ["third from bravo"]); assert.equal(delta.currentInput.text, "fourth");
  assert.deepEqual(resumes, [undefined, "private-native-alpha", undefined, "private-native-alpha"]);
  const saved = oldShape(app, session.id); assert.equal(saved.nativeBindings?.length, 2);
  await app.close(); f.store.close();
  const reopened = appStore(join(f.root, "data")); f.stores.push(reopened);
  const next = runtime({ ...f, store: reopened }, factory, () => {}, "restart-");
  next.send(session.id, "after owner restart", "five"); await next.wait(session.id);
  assert.equal(await peers[4]!.started.promise, "after owner restart"); assert.equal(resumes.at(-1), "private-native-alpha");
  assert.equal(oldShape(next, session.id).nativeBindings?.filter(binding => binding.status === "ready").length, 2);
  const epoch = oldShape(next, session.id).epoch;
  assert.throws(() => next.resetNative(session.id, "bad-epoch", epoch - 1), /changed/);
  const branched = oldShape(next, next.resetNative(session.id, "branch", epoch).id);
  assert.equal(branched.messages.length, saved.messages.length + 2); assert.equal(branched.nativeBindings?.[0]?.status, "archived");
  assert.deepEqual(oldShape(next, next.resetNative(session.id, "branch", epoch).id), branched);
  assert.throws(() => reopened.transact(session.id, branched.version, current => ({next:{...current,nativeBindings:[]},events:[{type:"invalid.erase",data:{}}]})), /silently erased/);
});

test("uncertain native dispatch cannot be silently restored after public recovery", async t => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]);
  const prepare = factory.prepare.bind(factory);
  factory.prepare = async (...args) => { const binding = await prepare(...args); return { ...binding, control: { ...binding.control, checkpoint: async () => "private-native-alpha" } }; };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "first unknown", "one"); await first.started.promise;
  first.result.reject(new Error("external connection lost")); await assert.rejects(app.wait(session.id), /needs recovery/);
  assert.equal(oldShape(app, session.id).nativeBindings?.[0]?.status, "unconfirmed");
  app.resume(session.id, { harnessId: "alpha" }, "resume", true); await app.wait(session.id);
  const count = factory.prepared.length;
  app.send(session.id, "must not create empty native state", "two"); await app.wait(session.id);
  assert.equal(factory.prepared.length, count); assert.equal(oldShape(app, session.id).runs.at(-1)?.error?.code, "NATIVE_STATE_UNCONFIRMED");
  const state = oldShape(app, session.id); app.resetNative(session.id, "explicit-branch", state.epoch);
  app.send(session.id, "explicit new native branch", "three"); await app.wait(session.id);
  assert.equal(oldShape(app, session.id).nativeBindings?.[0]?.status, "archived");
  assert.equal(oldShape(app, session.id).nativeBindings?.[1]?.status, "ready");
  assert.equal(oldShape(app, session.id).runs[0]?.status, "unknown");
});

test("neither the answer to a question nor the number of requests waiting at once has a limit of the Hub's: a 3 MiB answer reaches the Harness, and two hundred approvals wait together", { timeout: 20000 }, async t => {
  const f = await fixture(t), peer = controlled({ holdResult: true }), factory = new ControlledFactory([peer]);
  const prepare = factory.prepare.bind(factory), asked = new Gate<void>(), answers: { readonly id: string; readonly option: string; readonly input: string | undefined }[] = [];
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, enablePermissions: () => {}, decidePermission: async (id: string, option: string, input?: string) => { answers.push({ id, option, input }); },
      startText: async (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void) => {
        const run = await binding.control.startText(id, text, output);
        // The first is a question that takes free text; two hundred approvals follow it, none decided (the Runtime used to refuse the 33rd and end the Turn).
        output({ type: "permission_requested", id: "question", title: "What should the file say?", kind: "question", options: [{ id: "submit", name: "Submit" }], input: { kind: "text", value: "" } });
        for (let at = 0; at < 200; at++) output({ type: "permission_requested", id: "approval-" + at, title: "Run step " + at, options: [{ id: "yes", name: "Yes" }] });
        asked.resolve(); return run;
      } } };
  };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "ask me everything", "one"); await asked.promise;
  const waiting = app.permissionRequests(session.id);
  assert.equal(waiting.length, 201, "all of them wait for the user"); assert.equal(oldShape(app, session.id).runs[0]!.status, "running", "and the Turn goes on");
  const answer = "答案 ".repeat(500_000);
  assert.ok(Buffer.byteLength(answer) > 3 * 1024 * 1024);
  await app.decidePermission(session.id, waiting[0]!.id, "submit", "answer-1", answer);
  assert.equal(answers.length, 1); assert.equal(answers[0]!.input, answer, "the whole answer, byte for byte");
  await assert.rejects(app.decidePermission(session.id, waiting[1]!.id, "yes", "answer-2", "text for an approval"), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  await assert.rejects(app.decidePermission(session.id, waiting[0]!.id + "x", "submit", "answer-3", "a\0b"), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT", "NUL is still refused");
  peer.result.resolve({ status: "cancelled", reason: "fixture" }); await app.wait(session.id);
});

test("a question the Harness withdraws closes its public request and refuses a late answer", { timeout: 10000 }, async t => {
  const f = await fixture(t), peer = controlled({ holdResult: true }), factory = new ControlledFactory([peer]);
  const prepare = factory.prepare.bind(factory), asked = new Gate<void>(), withdrawn = new Gate<void>();
  let emit: ((event: ControlEvent) => void) | null = null;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, enablePermissions: () => {}, decidePermission: async () => { throw new SessionError("PERMISSION_UNAVAILABLE", "withdrawn"); },
      startText: async (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void) => { emit = output; const run = await binding.control.startText(id, text, output); output({ type: "permission_requested", id: "native-ui", title: "Timed native dialog", options: [{ id: "yes", name: "Yes" }] }); asked.resolve(); return run; } } };
  };
  const events: SessionEvent[] = [], app = runtime(f, factory, event => { events.push(event); if (event.type === "permission.closed") withdrawn.resolve(); });
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "ask me", "one"); await asked.promise;
  const [pending] = app.permissionRequests(session.id); assert.ok(pending);
  emit!({ type: "permission", id: "native-ui", decision: "cancelled" }); await withdrawn.promise;
  assert.deepEqual(app.permissionRequests(session.id), []);
  await assert.rejects(app.decidePermission(session.id, pending.id, "yes", "late"), /no longer pending/);
  peer.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  assert.equal(events.filter(event => event.type === "permission.closed" && event.data.reason === "cancelled").length, 1);
  assert.equal(oldShape(app, session.id).runs[0]?.status, "completed");
});

test("a long native turn with any number of calls completes, and every call it made stays (nothing is dropped at a count)", { timeout: 20000 }, async t => {
  const f = await fixture(t), peer = controlled(), factory = new ControlledFactory([peer]), prepare = factory.prepare.bind(factory), calls = 500;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, startText: async (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void) => {
      for (let index = 0; index < calls; index++) output({ type: "tool", id: "tool-" + index, title: "step " + index, status: "completed" });
      return binding.control.startText(id, text, output);
    } } };
  };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "many tools", "one"); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!, expected = Array.from({ length: calls }, (_, index) => "tool-" + index);
  assert.equal(run.status, "completed"); assert.equal(run.tools?.length, calls); assert.deepEqual(run.tools?.map(tool => tool.id), expected, "in the order they were reported");
  // They are rows, one item each, in the order of the Turn, and the checker has nothing to say about them.
  const turn = f.store.turnAt(session.id, 0, { inlineBytes: Infinity })!;
  assert.deepEqual(turn.items.filter(item => item.type === "tool").map(item => item.itemId), expected.map(id => "tool:" + id));
  assert.deepEqual(verify(f.store.get(session.id), f.store), []);
  assertRowsAreTheOnlyRecord(f);
  app.send(session.id, "still usable", "two"); await app.wait(session.id); assert.equal(oldShape(app, session.id).runs[1]?.status, "completed");
});

test("a tool whose title has a NUL, multibyte text, half a character or more than 4096 bytes is kept as the Harness reported it (a NUL removed and half a character mended, both told in the item) and the Turn runs on", { timeout: 10000 }, async t => {
  const f = await fixture(t), peer = controlled(), factory = new ControlledFactory([peer]), prepare = factory.prepare.bind(factory);
  const long = "长".repeat(2000) + " end", odd = "编译 🚀 项目 — ünïcödé";
  assert.ok(Buffer.byteLength(long) > 4096);
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, startText: async (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void) => {
      output({ type: "tool", id: "nul", title: "run\0 tests", status: "completed" });
      output({ type: "tool", id: "wide", title: odd, status: "completed" });
      output({ type: "tool", id: "long", title: long, status: "completed" });
      output({ type: "tool", id: "half", title: "half \ud83d pair", status: "completed" });
      return binding.control.startText(id, text, output);
    } } };
  };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "odd titles", "one"); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "completed", "no title ended the Turn");
  assert.deepEqual(run.tools?.map(tool => tool.title), ["run tests", odd, long, "half \ufffd pair"]);
  const turn = f.store.turnAt(session.id, 0, { inlineBytes: Infinity })!;
  const told = (id: string): readonly string[] | undefined => (turn.items.find(item => item.itemId === "tool:" + id)?.fields as { readonly native?: { readonly clipped?: readonly string[] } }).native?.clipped;
  assert.deepEqual(told("nul"), ["title:nul"]); assert.deepEqual(told("half"), ["title:surrogate"]);
  assert.equal(told("wide"), undefined, "nothing was changed in a title that was only multibyte"); assert.equal(told("long"), undefined, "and none was cut for its length");
  assert.deepEqual(verify(f.store.get(session.id), f.store), []);
  app.send(session.id, "still usable", "two"); await app.wait(session.id); assert.equal(oldShape(app, session.id).runs[1]?.status, "completed", "the runtime goes on");
});

test("native activity becomes public facts, and each call's detail is stored whole as content before the binding closes", { timeout: 10000 }, async t => {
  const f = await fixture(t), peer = controlled({ holdResult: true }), later = controlled({ holdResult: true }), factory = new ControlledFactory([peer, later]), prepare = factory.prepare.bind(factory);
  const content = new LocalContentStore(join(f.root, "data"), () => f.store.assertOwner());
  let emit: ((event: ControlEvent) => void) | null = null;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, startText: async (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void) => { emit = output; return binding.control.startText(id, text, output); } } };
  };
  let id = 0;
  const app = new SessionRuntime(f.store, factory, { id: () => String(++id), now: () => new Date("2026-10-11T00:00:00Z"), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content });
  f.runtimes.push(app);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "do work", "one"); await peer.started.promise;
  const huge = "x".repeat(200 * 1024);
  emit!({ type: "tool", id: "shell", title: "ls", status: "in_progress", detail: { kind: "execute", name: "Bash", input: "ls" } });
  emit!({ type: "tool", id: "shell", title: "ls", status: "in_progress", detail: { output: huge } });
  emit!({ type: "tool", id: "shell", title: "ls", status: "completed", detail: { exitCode: 0 } });
  emit!({ type: "tool", id: "edit", title: "Edit a.txt", status: "in_progress", detail: { kind: "edit", diff: "--- a/a.txt\n+++ b/a.txt\n" } });
  emit!({ type: "plan", entries: [{ content: "Read", status: "completed" }, { content: "Edit", status: "in_progress", priority: "high" }] });
  emit!({ type: "usage", usage: { context: { used: 10, size: 100 }, cost: { amount: 0.5, currency: "USD", scope: "session" } } });
  emit!({ type: "usage", usage: { turn: { input: 7, output: 3 } } });
  emit!({ type: "notice", severity: "warning", title: "fallback" });
  emit!({ type: "notice", severity: "warning", title: "fallback" });
  emit!({ type: "activity", id: "c1", kind: "compaction", title: "压缩", status: "running" });
  emit!({ type: "activity", id: "c1", kind: "compaction", title: "压缩", status: "completed" });
  emit!({ type: "output", output: { kind: "link", uri: "https://example.invalid/r", name: "r" } });
  emit!({ type: "output", output: { kind: "content", name: "chart.png", mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) } });
  peer.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "completed");
  const shell = run.tools?.find(tool => tool.id === "shell"), edit = run.tools?.find(tool => tool.id === "edit");
  assert.deepEqual([shell?.kind, shell?.name, shell?.exitCode], ["execute", "Bash", 0]); assert.ok(shell?.detail);
  const stored = JSON.parse(await readFile(content.read(shell.detail.id).path, "utf8")) as Record<string, unknown>;
  assert.equal(stored.input, "ls"); assert.equal(stored.truncated, undefined, "the Hub cuts nothing of a call's detail"); assert.equal(Buffer.byteLength(String(stored.output)), 200 * 1024, "what the Harness reported is stored whole");
  assert.ok(edit?.detail, "a tool still running at settlement is flushed before cleanup");
  assert.deepEqual(run.plan, { entries: [{ content: "Read", status: "completed" }, { content: "Edit", status: "in_progress", priority: "high" }] });
  assert.deepEqual(run.usage, { context: { used: 10, size: 100 }, cost: { amount: 0.5, currency: "USD", scope: "session" }, turn: { input: 7, output: 3 } });
  assert.deepEqual(run.notices, [{ severity: "warning", title: "fallback" }]);
  assert.deepEqual(run.activities, [{ id: "c1", kind: "compaction", title: "压缩", status: "completed" }]);
  assert.equal(run.outputs?.length, 2); assert.deepEqual(run.outputs?.[0], { kind: "link", uri: "https://example.invalid/r", name: "r" });
  const image = run.outputs?.[1]; assert.equal(image?.kind === "content" ? image.content.kind : null, "image");
  const log = JSON.stringify(f.store.events(session.id, 0, 100));
  assert.equal(log.includes("xxxxxxxxxxxxxxxx"), false, "large native previews never enter the event log");
  assert.equal(log.includes('"0":137'), false, "stored bytes never enter the event log");
  assert.ok(log.includes('"mediaType":"image/png","bytes":9'), "the event log keeps only the output summary");
  assert.deepEqual(f.store.contentReferences(), new Set([shell.detail.id, edit.detail.id, image?.kind === "content" ? image.content.id : ""]));
  // A Harness restarted for the next Turn repeats its startup warning: the conversation shows it once, the log keeps both.
  app.send(session.id, "again", "two"); await later.started.promise;
  emit!({ type: "notice", severity: "warning", title: "fallback" });
  emit!({ type: "notice", severity: "info", title: "new" });
  later.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  assert.deepEqual(oldShape(app, session.id).runs[1]!.notices, [{ severity: "info", title: "new" }]);
  assertRowsAreTheOnlyRecord(f);
  assert.equal(f.store.events(session.id, 0, 100).filter(row => row.type === "run.output" && JSON.stringify(row.data).includes('"title":"fallback"')).length, 3);
});

test("a call's detail is kept whole at any size: 25 MiB of output is stored in pieces, and a command with 300 KiB and with 2 MiB of output keeps its command in both", { timeout: 60000 }, async t => {
  const f = await fixture(t), peer = controlled({ holdResult: true }), factory = new ControlledFactory([peer]), prepare = factory.prepare.bind(factory);
  const content = new LocalContentStore(join(f.root, "data"), () => f.store.assertOwner());
  let emit: ((event: ControlEvent) => void) | null = null;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, startText: async (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void) => { emit = output; return binding.control.startText(id, text, output); } } };
  };
  let id = 0;
  const app = new SessionRuntime(f.store, factory, { id: () => String(++id), now: () => new Date("2026-10-11T00:00:00Z"), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content });
  f.runtimes.push(app);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "print a lot", "one"); await peer.started.promise;
  const sizes = { small: 300 * 1024, middle: 2 * 1024 * 1024, huge: 25 * 1024 * 1024 };
  for (const [name, size] of Object.entries(sizes)) {
    emit!({ type: "tool", id: name, title: "make " + name, status: "in_progress", detail: { kind: "execute", name: "Bash", input: "make-output --" + name } });
    emit!({ type: "tool", id: name, title: "make " + name, status: "completed", detail: { output: name[0]!.repeat(size), exitCode: 0 } });
  }
  peer.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "completed");
  for (const [name, size] of Object.entries(sizes)) {
    const tool = run.tools?.find(candidate => candidate.id === name);
    assert.ok(tool?.detail, name + ": the detail is kept");
    assert.equal(tool.detail.bytes > size, true, name + ": kept whole, not cut to a bound");
    const text = await readFile(content.read(tool.detail.id).path, "utf8"), stored = JSON.parse(text) as Record<string, unknown>;
    assert.equal(stored.input, "make-output --" + name, name + ": the command is there"); assert.equal((stored.output as string).length, size, name + ": and the whole output");
    assert.equal(stored.truncated, undefined);
  }
  const turn = f.store.turnAt(session.id, 0, { inlineBytes: Infinity })!;
  for (const name of Object.keys(sizes)) {
    const item = turn.items.find(candidate => candidate.itemId === "tool:" + name)!;
    assert.equal((item.fields as { readonly native?: { readonly clipped?: readonly string[] } }).native?.clipped, undefined, name + ": nothing on the item says it was cut");
    assert.ok((item.fields as { readonly detail?: unknown }).detail, name + ": and the row refers to the detail");
  }
  assert.deepEqual(verify(f.store.get(session.id), f.store), []);
});

test("a detail the content store cannot keep is said on the call's item, the Turn goes on, and a detail kept later takes the saying away", { timeout: 20000 }, async t => {
  const f = await fixture(t), peer = controlled({ holdResult: true }), factory = new ControlledFactory([peer]), prepare = factory.prepare.bind(factory);
  const store = new LocalContentStore(join(f.root, "data"), () => f.store.assertOwner());
  let emit: ((event: ControlEvent) => void) | null = null;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, startText: async (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void) => { emit = output; return binding.control.startText(id, text, output); } } };
  };
  // The disk fills for the first two writes, then there is room again.
  const attempts: string[] = []; let failing = 2; const settled = new Gate<void>(), kept = new Gate<void>();
  const content = Object.assign(Object.create(store) as LocalContentStore, {
    storeOutput: async (input: Parameters<LocalContentStore["storeOutput"]>[0]) => {
      attempts.push(input.name);
      if (failing > 0) {
        failing--;
        if (failing === 0) settled.resolve();
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      const ref = await store.storeOutput(input); kept.resolve(); return ref;
    },
  });
  let id = 0;
  const app = new SessionRuntime(f.store, factory, { id: () => String(++id), now: () => new Date("2026-10-11T00:00:00Z"), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content });
  f.runtimes.push(app);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "build it", "one"); await peer.started.promise;
  emit!({ type: "tool", id: "lost", title: "make", status: "completed", detail: { kind: "execute", name: "Bash", input: "make", output: "built nothing", exitCode: 2 } });
  emit!({ type: "tool", id: "later", title: "make again", status: "completed", detail: { kind: "execute", name: "Bash", input: "make", output: "first try", exitCode: 2 } });
  await settled.promise; await new Promise<void>(resolve => setImmediate(resolve));
  // The call that lost its detail is reported once more, finished, with the output it has now: the store has room, and what is kept now is the whole of it.
  emit!({ type: "tool", id: "later", title: "make again", status: "completed", detail: { output: "second try", exitCode: 0 } });
  await kept.promise; await new Promise<void>(resolve => setImmediate(resolve));
  peer.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "completed", "a detail that could not be kept ends nothing");
  const turn = f.store.turnAt(session.id, 0, { inlineBytes: Infinity })!, itemOf = (name: string) => turn.items.find(candidate => candidate.itemId === "tool:" + name)!;
  const fieldsOf = (name: string) => itemOf(name).fields as { readonly detail?: { readonly id: string }; readonly native?: { readonly clipped?: readonly string[] } };
  assert.deepEqual(fieldsOf("lost").native?.clipped, ["detail:not_saved"], "the item of the call that lost its detail says so");
  assert.equal(fieldsOf("lost").detail, undefined, "and refers to no detail");
  assert.equal(fieldsOf("later").native?.clipped, undefined, "a detail kept later takes the saying away");
  assert.ok(fieldsOf("later").detail, "and the item refers to it");
  const stored = JSON.parse(await readFile(content.read(fieldsOf("later").detail!.id).path, "utf8")) as Record<string, unknown>;
  assert.equal(stored.output, "second try"); assert.equal(stored.input, "make");
  assert.equal(attempts.length, 3, "the two writes that failed and the one that was kept");
  const log = f.store.events(session.id, 0, 100).filter(row => row.type === "run.output" && JSON.stringify(row.data).includes("tool detail was not stored"));
  assert.equal(log.length, 2, "the log says why, as it always did");
  assert.deepEqual(f.store.contentReferences(), new Set([fieldsOf("later").detail!.id]), "only the detail that was kept is registered");
  assert.deepEqual(verify(f.store.get(session.id), f.store), []);
  app.send(session.id, "and again", "two"); await app.wait(session.id); assert.equal(oldShape(app, session.id).runs[1]?.status === "completed" || oldShape(app, session.id).runs[1]?.status === "failed", true, "the runtime goes on");
});

test("attachments are admitted with the input, checked and copied before dispatch, and a refusal fails only that input", { timeout: 10000 }, async t => {
  const f = await fixture(t), content = new LocalContentStore(join(f.root, "data"), () => f.store.assertOwner());
  const factory = new ControlledFactory([controlled(), controlled()]), prepare = factory.prepare.bind(factory);
  const received: { checked: string[]; files: { name: string; path: string }[] }[] = [];
  let refuse = false;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args), seen = { checked: [] as string[], files: [] as { name: string; path: string }[] }; received.push(seen);
    return { ...binding, control: { ...binding.control,
      checkAttachments: async refs => { seen.checked.push(...refs.map(ref => ref.id)); if (refuse) throw Object.assign(new Error("当前 Harness 或模型不接受图片附件：shot.png"), { code: "ATTACHMENT_UNSUPPORTED" }); },
      startText: (id: NativeConversationId, text: TurnText, output: (event: ControlEvent) => void, files?: readonly { name: string; path: string }[]) => { seen.files.push(...(files ?? []).map(file => ({ name: file.name, path: file.path }))); return binding.control.startText(id, text, output); } } };
  };
  let next = 0;
  const app = new SessionRuntime(f.store, factory, { id: () => String(++next), now: () => new Date("2026-10-11T00:00:00Z"), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content });
  f.runtimes.push(app);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  async function* body(value: Uint8Array) { yield value; }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  const image = await content.stage({ workspace: f.configuration.workspace, name: "shot.png", mediaType: "image/png", commandId: "upload-1", declaredBytes: png.length, source: body(png) });
  const elsewhere = await content.stage({ workspace: "/elsewhere", name: "x.txt", mediaType: "text/plain", commandId: "upload-2", declaredBytes: 1, source: body(Buffer.from("x")) });
  // Admission is synchronous: an unknown or foreign upload creates no Run.
  assert.throws(() => app.send(session.id, "look", "send-foreign", [elsewhere.id]), (error: unknown) => error instanceof SessionError && error.code === "ATTACHMENT_UNAVAILABLE");
  assert.equal(oldShape(app, session.id).runs.length, 0);
  const receipt = app.send(session.id, "look", "send-1", [image.id]);
  assert.deepEqual(app.send(session.id, "look", "send-1", [image.id]), { ...receipt, replayed: true });
  assert.throws(() => app.send(session.id, "look", "send-1", []), (error: unknown) => error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT");
  await app.wait(session.id);
  let state = oldShape(app, session.id);
  assert.deepEqual(state.runs[0]?.attachments, [image]); assert.equal(state.runs[0]?.status, "completed");
  assert.deepEqual(received[0]?.checked, [image.id]);
  assert.equal(received[0]?.files[0]?.name, "shot.png"); assert.deepEqual(await readFile(received[0]!.files[0]!.path), png);
  assert.ok(f.store.contentReferences().has(image.id), "admitted attachments are kept as long as the Session references them");
  // A refusal happens before dispatch: the input fails with the Driver's own message, the Session stays open and nothing is unknown.
  refuse = true;
  app.send(session.id, "again", "send-2", [image.id]); await app.wait(session.id);
  state = oldShape(app, session.id);
  assert.equal(state.runs[1]?.status, "failed"); assert.deepEqual(state.runs[1]?.error, { code: "ATTACHMENT_UNSUPPORTED", message: "当前 Harness 或模型不接受图片附件：shot.png" });
  assert.equal(state.status, "open"); assert.equal(received[1]?.files.length, 0, "a refused input never reaches the Harness");
});

test("a branch quotes public history, forks the native session at its latest Turn, and falls back to public context otherwise", { timeout: 10000 }, async t => {
  const f = await fixture(t), peers = Array.from({ length: 8 }, () => controlled()), factory = new ControlledFactory(peers);
  const prepare = factory.prepare.bind(factory), opens: (string | undefined)[] = [], forks: string[] = [];
  let refuse = false, fresh = 0;
  factory.prepare = async (...args) => {
    // The native session this connection opened: the one it was asked to resume, else a new one of its own (a native session has one holder in the whole store).
    const binding = await prepare(...args), original = binding.control.open; let held: string | undefined;
    return { ...binding, control: { ...binding.control,
      open: async (cwd, model, options, checkpoint) => { opens.push(checkpoint); held = checkpoint ?? (fresh++ === 0 ? "native-source" : "native-new-" + fresh); return original(cwd, model, options, checkpoint); },
      checkpoint: async () => held ?? "native-source",
      fork: async (checkpoint: string) => { forks.push(checkpoint); if (refuse) throw new SessionError("NATIVE_FORK_UNAVAILABLE", "refused"); return checkpoint + "-copy-" + forks.length; },
    } };
  };
  const app = runtime(f, factory), source = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(source.id, "first", "one"); await app.wait(source.id);
  app.send(source.id, "second", "two"); await app.wait(source.id);
  const runs = oldShape(app, source.id).runs;
  // Native fork: the source binding is exactly at the latest Turn.
  const branch = oldShape(app, app.fork(source.id, "branch-latest").id);
  assert.deepEqual(branch.origin?.history.map(row => [row.role, row.text]), [["user", "first"], ["assistant", "synthetic response"], ["user", "second"], ["assistant", "synthetic response"]]);
  assert.equal(branch.nativeBindings?.[0]?.status, "fork-pending"); assert.deepEqual(oldShape(app, app.fork(source.id, "branch-latest").id), branch, "the same command returns the same branch");
  await app.wait(branch.id);
  assert.deepEqual(forks, ["native-source"]);
  assert.deepEqual(oldShape(app, branch.id).nativeBindings?.map(binding => [binding.checkpoint, binding.status]), [["native-source-copy-1", "ready"]]);
  app.send(branch.id, "branch question", "b-one"); await app.wait(branch.id);
  assert.equal(opens.at(-1), "native-source-copy-1", "the branch resumes its own native copy");
  // Each fork and each Turn prepares its own connection: peers 0–1 ran the source, 2 made the fork, 3 runs the branch.
  assert.equal(await peers[3]!.started.promise, "branch question", "a native branch receives only the new input");
  assert.equal(oldShape(app, source.id).nativeBindings?.[0]?.checkpoint, "native-source", "the source keeps its own native session");
  // Public-only branch: an earlier Turn is not where the native session is.
  const early = oldShape(app, app.fork(source.id, "branch-early", runs[0]!.id).id);
  assert.equal(early.nativeBindings, undefined); assert.deepEqual(early.origin?.history.map(row => row.text), ["first", "synthetic response"]);
  app.send(early.id, "early question", "e-one"); await app.wait(early.id);
  const context = readRelayPrompt(await peers[4]!.started.promise);
  assert.deepEqual(context.branchedHistory.map(row => [row.role, row.text]), [["user", "first"], ["assistant", "synthetic response"]]); assert.deepEqual(context.history, []);
  assert.equal(context.currentInput.text, "early question");
  // A refused native fork archives the reference; the branch continues from public history.
  refuse = true;
  const refused = app.fork(source.id, "branch-refused"); await app.wait(refused.id);
  assert.deepEqual(oldShape(app, refused.id).nativeBindings?.map(binding => binding.status), ["archived"]);
  assert.ok(f.store.events(refused.id, 0, 100).some(row => row.type === "native.fork_failed"));
  app.send(refused.id, "after refusal", "r-one"); await app.wait(refused.id);
  assert.equal(oldShape(app, refused.id).runs[0]?.status, "completed");
  assert.deepEqual(readRelayPrompt(await peers[6]!.started.promise).branchedHistory.map(row => row.text), ["first", "synthetic response", "second", "synthetic response"], "the whole branch history goes with its first input");
  assert.throws(() => app.fork(source.id, "branch-missing", "run-missing"), (error: unknown) => error instanceof SessionError && error.code === "FORK_UNAVAILABLE");
});

test("an unreadable or invalid native configuration report leaves it unknown without changing the Turn's result", async t => {
  const f = await fixture(t), factory = new ControlledFactory(Array.from({ length: 3 }, () => controlled()));
  factory.validate = async request => ({ ...selection(request), ...(request.nativeOptions === undefined ? {} : { nativeOptions: request.nativeOptions }) });
  const prepare = factory.prepare.bind(factory), opened: unknown[] = [];
  const reports: (() => Promise<{ model: string | null; options: Record<string, string> }>)[] = [
    async () => ({ model: null, options: { effort: "high" } }),
    async () => { throw new SessionError("NATIVE_CONFIG_UNAVAILABLE", "settings unreadable"); },
    async () => ({ model: "bad\nmodel", options: {} }),
  ];
  factory.prepare = async (...args) => {
    const binding = await prepare(...args), original = binding.control.open;
    return { ...binding, control: { ...binding.control, open: async (cwd, model, options, checkpoint) => { opened.push(options); return original(cwd, model, options, checkpoint); },
      checkpoint: async () => "private-native-alpha", nativeConfig: () => reports.shift()!() } };
  };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha", nativeOptions: { effort: "low" } }, "create");
  app.send(session.id, "first", "one"); await app.wait(session.id);
  assert.deepEqual(oldShape(app, session.id).nativeBindings?.[0]?.observed, { model: null, options: { effort: "high" } });
  // The second Turn applies the native value; its own report is unreadable, so the configuration becomes unknown.
  app.send(session.id, "second", "two"); await app.wait(session.id);
  let state = oldShape(app, session.id);
  assert.deepEqual(opened, [{ effort: "low" }, { effort: "high" }]); assert.equal(state.runs[1]?.status, "completed");
  assert.equal(state.nativeBindings?.[0]?.status, "ready"); assert.equal(state.nativeBindings?.[0]?.observed, undefined);
  // Unknown means the selection is applied as requested; an invalid report is unknown too.
  app.send(session.id, "third", "three"); await app.wait(session.id);
  state = oldShape(app, session.id);
  assert.deepEqual(opened.at(-1), { effort: "low" }); assert.equal(state.runs[2]?.status, "completed"); assert.equal(state.nativeBindings?.[0]?.observed, undefined);
  assert.deepEqual(f.store.events(session.id, 0, 100).filter(row => row.type === "native.config_unreadable").map(row => row.data.code), ["NATIVE_CONFIG_UNAVAILABLE", "INVALID_DATA"]);
});

test("a native session continues as a new conversation that quotes its recent history and takes the next input directly", async t => {
  const f = await fixture(t), peers = [controlled(), controlled()], factory = new ControlledFactory(peers), reads: string[] = [], opened: (string | undefined)[] = [];
  const history = Array.from({ length: 205 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: "message " + index }));
  (factory as SessionBindingFactory).readNativeSession = async (_selection, _configuration, nativeId) => {
    reads.push(nativeId); return { checkpoint: "private-" + nativeId, title: "Earlier\nwork", history, omitted: 4, complete: false, historyRead: true };
  };
  const prepare = factory.prepare.bind(factory);
  factory.prepare = async (...args) => {
    const binding = await prepare(...args), original = binding.control.open;
    return { ...binding, control: { ...binding.control, open: async (cwd, model, options, checkpoint) => { opened.push(checkpoint); return original(cwd, model, options, checkpoint); }, checkpoint: async () => "private-native-a" } };
  };
  const app = runtime(f, factory), imported = oldShape(app, (await app.importNative(f.configuration, { harnessId: "alpha" }, "native-a", "import-one")).id);
  const origin = imported.origin!; assert.equal(origin.kind, "import"); if (origin.kind !== "import") return;
  // Every message the Harness returned is quoted (the Hub holds no count of them); the four it left out itself are all that is omitted.
  assert.equal(origin.title, "Earlier work"); assert.equal(origin.history.length, 205); assert.equal(origin.omitted, 4); assert.equal(origin.complete, false);
  assert.deepEqual([origin.history[0]!.text, origin.history.at(-1)!.text, origin.history.at(-2)!.harnessId], ["message 0", "message 204", "alpha"]);
  assert.deepEqual(imported.nativeBindings, [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "private-native-a", throughRunId: null, status: "ready", relay: initialBindingRelay([], "alpha", "alpha-acp", "import") }]);
  assert.equal((await app.importNative(f.configuration, { harnessId: "alpha" }, "native-a", "import-one")).id, imported.id); assert.equal(reads.length, 1, "a replayed command reads nothing");
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "native-b", "import-one"), (error: unknown) => error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "native-a", "import-two"), (error: unknown) => error instanceof SessionError && error.code === "NATIVE_SESSION_CONFLICT", "one native session has one conversation");
  app.send(imported.id, "continue please", "send-one"); await app.wait(imported.id);
  assert.equal(await peers[0]!.started.promise, "continue please", "the native session gets the input itself, not a public context");
  assert.deepEqual(opened, ["private-native-a"]); assert.equal(oldShape(app, imported.id).runs[0]?.status, "completed");
  // A Harness that cannot read its history is continued without quoting any.
  (factory as SessionBindingFactory).readNativeSession = async () => ({ checkpoint: "private-native-c", title: null, history: [], omitted: 0, complete: false, historyRead: false });
  const unread = oldShape(app, (await app.importNative(f.configuration, { harnessId: "alpha" }, "native-c", "import-three")).id);
  assert.deepEqual(unread.origin, { kind: "import", harnessId: "alpha", title: null, omitted: 0, complete: false, historyRead: false, history: [] });
  delete (factory as SessionBindingFactory).readNativeSession;
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "native-d", "import-four"), (error: unknown) => error instanceof SessionError && error.code === "NATIVE_SESSION_LIST_UNAVAILABLE");
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "bad\nid", "import-five"), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
});

/** Timers the test fires itself: an ADR-047 window never waits for real time here. */
class ManualTimers {
  private readonly armed = new Map<number, () => void>();
  private count = 0;
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    assert.equal(ms, STREAM_WINDOW_MS, "a window is armed for the contract's window");
    const id = ++this.count; this.armed.set(id, fn); return () => { this.armed.delete(id); };
  };
  get pending(): number { return this.armed.size; }
  /** Runs every timer armed so far, in order, and says how many; one armed while running waits for the next call. */
  fire(): number { const due = [...this.armed.values()]; this.armed.clear(); for (const fn of due) fn(); return due.length; }
}
interface StreamingTurn { readonly emit: (event: ControlEvent) => void; readonly result: Gate<BackendResult>; readonly stopped: Gate<void>; stops: number }
/** A program the test plays itself: each Turn hands out its event callback and settles when the test says (ADR-047 cases). */
class StreamingFactory implements SessionBindingFactory {
  readonly turns: StreamingTurn[] = [];
  closes = 0;
  private readonly waiting = new Map<number, (turn: StreamingTurn) => void>();
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return selection(request); }
  async prepare(_selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const mine: StreamingTurn[] = [];
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "streaming-fixture", agentVersion: "1", authenticationMethods: [], capabilities: {} } satisfies ProtocolObservation),
      open: async () => nativeConversationId("streaming-fixture"),
      startText: async (_id: NativeConversationId, _text: string, output: (event: ControlEvent) => void): Promise<ControlRun> => {
        const turn: StreamingTurn = { emit: output, result: new Gate<BackendResult>(), stopped: new Gate<void>(), stops: 0 };
        this.turns.push(turn); mine.push(turn);
        // Handed to the test only once the Runtime holds the Turn's handle, as a real program's first chunk arrives by I/O after that.
        const waiter = this.waiting.get(this.turns.length); this.waiting.delete(this.turns.length);
        if (waiter) setImmediate(() => waiter(turn));
        return { result: turn.result.promise, requestStop: async () => { turn.stops += 1; turn.stopped.resolve(); return { requested: true }; } };
      },
      // A closed connection settles nothing more: a Turn the test did not settle ends like one whose process was ended.
      close: async () => { this.closes += 1; for (const turn of mine) turn.result.reject(new SessionError("PROCESS_EXITED", "fixture connection closed")); return clean; },
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  /** The `index`th Turn (from one) once the Runtime has dispatched it. */
  dispatched(index: number): Promise<StreamingTurn> {
    const turn = this.turns[index - 1];
    return turn === undefined ? new Promise(resolve => { this.waiting.set(index, resolve); }) : Promise.resolve(turn);
  }
}
/** A Runtime whose ADR-047 windows expire only when the test fires its timers; the clock steps a millisecond per reading. */
function windowed(f: Fixture, factory: SessionBindingFactory, options: { readonly publish?: (event: SessionEvent) => void; readonly executionBudgetMs?: number; readonly waitBudgetMs?: number } = {}): { readonly app: SessionRuntime; readonly timers: ManualTimers } {
  const timers = new ManualTimers(); let id = 0, clock = Date.parse("2026-10-21T00:00:00Z");
  const app = new SessionRuntime(f.store, factory, { id: () => "window-" + String(++id), now: () => new Date(clock += 1), publish: eventsOf(options.publish ?? (() => {})),
    fingerprint: value => createHash("sha256").update(value).digest("hex"), schedule: timers.schedule, ...(options.executionBudgetMs === undefined ? {} : { executionBudgetMs: options.executionBudgetMs }),
    ...(options.waitBudgetMs === undefined ? {} : { waitBudgetMs: options.waitBudgetMs }) });
  f.runtimes.push(app); return { app, timers };
}
/** The whole committed log of a Session, oldest first (the Store pages it). */
function log(f: Fixture, id: SessionId): SessionEvent[] {
  const rows: SessionEvent[] = [];
  for (let after = 0;;) { const page = f.store.events(id, after, 100); if (!page.length) return rows; rows.push(...page); after = page.at(-1)!.seq; }
}
/** Every committed native output as "kind" or "text:…"/"thinking:…", with the requests the program made, in log order. */
function outputs(f: Fixture, id: SessionId): string[] {
  return log(f, id).flatMap(row => {
    if (row.type === "permission.requested") return ["permission"];
    if (row.type !== "run.output") return [];
    const native = row.data.event; assert.ok(native !== null && typeof native === "object" && "type" in native && typeof native.type === "string");
    return [native.type === "text" || native.type === "thinking" ? native.type + ":" + String("text" in native ? native.text : "") : native.type];
  });
}
/** The `index`th assistant reply of a Session, as committed. */
function reply(app: SessionRuntime, id: SessionId, index = 0): string | undefined { return oldShape(app, id).messages.filter(message => message.role === "assistant")[index]?.text; }
/** Replaces the owner marker, so the Store's next ownership check fails with OWNER_LOST (as a taken-over data root does). */
async function loseOwner(f: Fixture): Promise<void> {
  const data = join(f.root, "data");
  await rename(join(data, "owner.sqlite"), join(data, "old-owner.sqlite")); await writeFile(join(data, "owner.sqlite"), Buffer.alloc(0), { mode: 0o600 });
}

test("INV-06/INV-20 ADR-047: 200 text chunks a millisecond apart are committed as windows, the reply is the chunks byte for byte, and the first chunk marks the first output at once; thinking the same", async t => {
  const f = await fixture(t), factory = new StreamingFactory(), published: SessionEvent[] = [];
  const { app, timers } = windowed(f, factory, { publish: event => { assert.ok(f.store.events(event.sessionId, event.seq - 1, 1).some(row => row.seq === event.seq), "published before its commit"); published.push(event); } });
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const chunks = Array.from({ length: 200 }, (_, index) => `第${index}块 🌱 `);
  const first = factory.dispatched(1); app.send(session.id, "stream text", "text"); const turn = await first;
  turn.emit({ type: "text", text: chunks[0]! });
  // The first output is its own committed fact at the chunk's arrival; the text waits for its window.
  assert.deepEqual(log(f, session.id).filter(row => row.type === "run.first_output" || row.type === "run.output").map(row => row.type), ["run.first_output"]);
  assert.equal(timers.pending, 1, "the first chunk arms the window"); assert.equal(reply(app, session.id), undefined, "an open window is not committed");
  const firstOutputAt = oldShape(app, session.id).runs[0]!.timing!.firstOutputAt!;
  // A millisecond between chunks: the window's timer is due after a hundred of them, so it is fired after each hundred.
  for (const [index, text] of chunks.entries()) { if (index > 0) turn.emit({ type: "text", text }); if ((index + 1) % 100 === 0) assert.equal(timers.fire(), 1, "one window is armed at a time"); }
  assert.equal(reply(app, session.id), chunks.join(""), "both windows were committed when their timers ran out");
  turn.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!, windows = outputs(f, session.id).filter(row => row.startsWith("text:"));
  assert.equal(run.status, "completed"); assert.equal(reply(app, session.id), chunks.join(""));
  assert.ok(windows.length <= chunks.length / 10, `${windows.length} run.output events for ${chunks.length} chunks`);
  t.diagnostic(`ADR-047 text: ${chunks.length} chunks became ${windows.length} run.output events (one per chunk before)`);
  assert.equal(windows.map(row => row.slice("text:".length)).join(""), chunks.join(""), "the log's windows, joined, are the chunks");
  assert.equal(run.timing!.firstOutputAt, firstOutputAt, "the first output keeps the first chunk's arrival"); assert.ok(firstOutputAt < run.timing!.endedAt!);
  assert.equal(published.filter(event => event.type === "run.output").length, windows.length, "each window is published once, after its commit");
  assert.equal(timers.pending, 0, "no timer outlives the Turn");
  // Thinking is windowed the same way, in windows of its own.
  const thoughts = Array.from({ length: 200 }, (_, index) => `思考 ${index} `);
  const second = factory.dispatched(2); app.send(session.id, "stream thinking", "thinking"); const next = await second;
  for (const [index, text] of thoughts.entries()) { next.emit({ type: "thinking", text }); if ((index + 1) % 100 === 0) assert.equal(timers.fire(), 1); }
  next.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  const thinking = outputs(f, session.id).filter(row => row.startsWith("thinking:"));
  assert.equal(oldShape(app, session.id).runs[1]!.thinking, thoughts.join("")); assert.ok(thinking.length <= thoughts.length / 10, `${thinking.length} thinking events for ${thoughts.length} chunks`);
  t.diagnostic(`ADR-047 thinking: ${thoughts.length} chunks became ${thinking.length} run.output events (one per chunk before)`);
  assert.equal(thinking.map(row => row.slice("thinking:".length)).join(""), thoughts.join(""));
  assert.equal(log(f, session.id).filter(row => row.type === "run.first_output").length, 2, "one first output per Turn");
});

test("an approval's deadline is the one its program announced, an operator's wait budget when there is one and it comes first, and none without either (2026-11-12)", async t => {
  const ask = (turn: StreamingTurn, id: string, expiry: { readonly expiresInMs?: number; readonly expiresBy?: "native" | "turn" } = {}) => turn.emit({ type: "permission_requested", id, title: "May I?", options: [{ id: "yes", name: "Yes" }], ...expiry });
  // Without a wait budget: a request the program gave no deadline waits for the user; one it gave a deadline keeps it, however long (a day was the longest it took once).
  const f = await fixture(t), factory = new StreamingFactory(), { app } = windowed(f, factory);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "ask", "ask"); const turn = await first;
  ask(turn, "plain"); ask(turn, "native", { expiresInMs: 90_000, expiresBy: "native" }); ask(turn, "week", { expiresInMs: 7 * 24 * 3600_000, expiresBy: "native" });
  const [plain, native, week] = app.attention();
  assert.deepEqual([plain!.expiresAt, plain!.expiresBy], [undefined, undefined], "nothing of the Hub's, nothing of the program's");
  assert.deepEqual([native!.expiresBy, native!.expiresAt! - native!.requestedAt], ["native", 90_000]);
  assert.deepEqual([week!.expiresBy, week!.expiresAt! - week!.requestedAt], ["native", 7 * 24 * 3600_000]);
  // Time passes: none of them is the Runtime's to expire, and the Turn is not cancelled for waiting.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(oldShape(app, session.id).runs[0]!.status, "running"); assert.equal(app.attention().length, 3);
  turn.result.resolve({ status: "cancelled", reason: "fixture" }); await app.wait(session.id);
});

test("an operator's wait budget is the deadline of a request whose program announced none or a later one, and the program's own when it is earlier", async t => {
  const ask = (turn: StreamingTurn, id: string, expiry: { readonly expiresInMs?: number; readonly expiresBy?: "native" | "turn" } = {}) => turn.emit({ type: "permission_requested", id, title: "May I?", options: [{ id: "yes", name: "Yes" }], ...expiry });
  const f = await fixture(t), factory = new StreamingFactory(), { app } = windowed(f, factory, { waitBudgetMs: 60_000 });
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "ask", "ask"); const turn = await first;
  ask(turn, "plain"); ask(turn, "later", { expiresInMs: 600_000, expiresBy: "native" }); ask(turn, "sooner", { expiresInMs: 20_000, expiresBy: "native" });
  const [plain, later, sooner] = app.attention();
  assert.equal(plain!.expiresBy, "turn"); assert.ok(plain!.expiresAt! - plain!.requestedAt <= 60_000 && plain!.expiresAt! - plain!.requestedAt > 59_000);
  assert.equal(later!.expiresBy, "turn", "the budget ends before the program's deadline");
  assert.deepEqual([sooner!.expiresBy, sooner!.expiresAt! - sooner!.requestedAt], ["native", 20_000], "the program's deadline ends before the budget");
  turn.result.resolve({ status: "cancelled", reason: "fixture" }); await app.wait(session.id);
});

test("a refused approval makes the call it is about declined in the rows a reader reads, whichever of the refusal and the program's report of the failure comes first (observed: Codex said declined, Claude Code failed)", async t => {
  const f = await fixture(t), factory = new StreamingFactory(), { app } = windowed(f, factory), prepare = factory.prepare.bind(factory);
  // A program that can be told what the user decided.
  factory.prepare = async (...args) => { const binding = await prepare(...args); return { ...binding, control: { ...binding.control, enablePermissions: () => {}, decidePermission: async () => {} } }; };
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "edit it", "edit"); const turn = await first;
  const options = [{ id: "allow", name: "Allow" }, { id: "reject", name: "Reject" }];
  const refuse = async (key: string): Promise<void> => { const [asked] = app.attention(); assert.ok(asked); await app.decidePermission(session.id, asked.permissionId, "reject", key); };
  const call = (id: string, status: string) => ({ type: "tool" as const, id, title: "Edit a.txt", status, detail: { kind: "edit", name: "Edit" } });
  // The refusal first, then what Claude Code reports of a call that was refused: a failure.
  turn.emit(call("edit-1", "pending")); turn.emit({ type: "permission_requested", id: "ask-1", forCall: "edit-1", title: "Edit a.txt", options });
  await refuse("decide-1");
  turn.emit(call("edit-1", "failed"));
  // The failure first, then the refusal.
  turn.emit(call("edit-2", "pending")); turn.emit({ type: "permission_requested", id: "ask-2", forCall: "edit-2", title: "Edit b.txt", options });
  turn.emit(call("edit-2", "failed"));
  await refuse("decide-2");
  turn.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  const held = f.store.turnAt(session.id, 0, { inlineBytes: Infinity })!.items;
  const word = (itemId: string) => held.find(item => item.itemId === itemId)!.status;
  assert.deepEqual(["tool:edit-1", "tool:edit-2", "permission:ask-1", "permission:ask-2"].map(word), ["declined", "declined", "declined", "declined"]);
  assert.deepEqual(held.filter(item => item.type === "approval").map(item => (item.fields as { forItem?: string }).forItem), ["tool:edit-1", "tool:edit-2"]);
  for (const item of held.filter(row => row.itemId.startsWith("tool:"))) assert.equal(wireItem(item).status, "declined", "the page is told " + item.itemId + " as declined");
  assert.equal(f.store.get(session.id).runs[0]!.status, "completed", "the Turn ended as it did");
});

// Directed mutation (checked by hand): without the flush before a non-text event in output(), or without the flush on a
// change of kind in streamChunk(), the windows land after the tool, plan, usage, request, output, activity and notice they
// preceded, and this case fails on the order asserted below.
test("INV-06 ADR-047: text open when any other event arrives is committed before it, in arrival order, and thinking and text never share a window", async t => {
  const f = await fixture(t), factory = new StreamingFactory(), { app, timers } = windowed(f, factory);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "order", "order"); const turn = await first;
  turn.emit({ type: "thinking", text: "think " }); turn.emit({ type: "thinking", text: "more" });
  turn.emit({ type: "text", text: "a" });
  turn.emit({ type: "tool", id: "t1", title: "ls", status: "completed" });
  turn.emit({ type: "text", text: "b" });
  turn.emit({ type: "plan", entries: [{ content: "step", status: "pending" }] });
  turn.emit({ type: "text", text: "c" });
  turn.emit({ type: "usage", usage: { turn: { input: 1, output: 2 } } });
  turn.emit({ type: "text", text: "d" });
  turn.emit({ type: "permission_requested", id: "ask", title: "May I?", options: [{ id: "yes", name: "Yes" }] });
  turn.emit({ type: "text", text: "e" });
  turn.emit({ type: "output", output: { kind: "link", uri: "https://example.invalid/r", name: "r" } });
  turn.emit({ type: "text", text: "f" });
  turn.emit({ type: "activity", id: "c1", kind: "compaction", title: "压缩", status: "running" });
  turn.emit({ type: "text", text: "g" });
  turn.emit({ type: "notice", severity: "info", title: "note" });
  turn.emit({ type: "text", text: "h1" }); turn.emit({ type: "text", text: "h2" });
  turn.emit({ type: "thinking", text: "late" });
  assert.deepEqual(outputs(f, session.id), ["thinking:think more", "text:a", "tool", "text:b", "plan", "text:c", "usage", "text:d", "permission", "text:e", "output", "text:f", "activity", "text:g", "notice", "text:h1h2"]);
  assert.equal(timers.pending, 1, "only the window still open, the late thinking, is armed");
  turn.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  assert.deepEqual(outputs(f, session.id).slice(-2), ["text:h1h2", "thinking:late"], "the open window is committed at the settlement");
  assert.equal(reply(app, session.id), "abcdefgh1h2"); assert.equal(oldShape(app, session.id).runs[0]!.thinking, "think morelate");
  assert.equal(oldShape(app, session.id).runs[0]!.status, "completed"); assert.equal(timers.pending, 0);
});

test("INV-06 ADR-047: an open window is committed before the settlement, and before a cancel's request and stop; what streams after the stop is kept too", async t => {
  const f = await fixture(t), factory = new StreamingFactory(), { app, timers } = windowed(f, factory);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "settle", "settle"); const settled = await first;
  settled.emit({ type: "text", text: "x1" }); settled.emit({ type: "text", text: "x2" }); assert.equal(timers.pending, 1);
  settled.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(session.id);
  let types = log(f, session.id).map(row => row.type);
  assert.ok(types.includes("run.output") && types.indexOf("run.output") < types.indexOf("run.backend_settled"), "the window precedes the settlement");
  assert.equal(reply(app, session.id), "x1x2"); assert.equal(timers.pending, 0, "the settlement took the window's timer");
  const second = factory.dispatched(2), receipt = app.send(session.id, "cancel me", "cancel-me"), stopped = await second;
  stopped.emit({ type: "text", text: "y1" });
  app.cancel(session.id, "cancel", receipt.runId);
  for (let at = 0; at < 100 && !log(f, session.id).some(row => row.type === "run.stop_requested"); at++) await new Promise(resolve => setImmediate(resolve));
  stopped.emit({ type: "text", text: "y2" });
  stopped.result.resolve({ status: "cancelled", reason: "fixture" }); await app.wait(session.id);
  types = log(f, session.id).map(row => row.type);
  const cancelAt = types.indexOf("run.cancel_requested"), stopAt = types.indexOf("run.stop_requested");
  assert.equal(types[cancelAt - 1], "run.output", "the window precedes the cancel"); assert.equal(stopAt, cancelAt + 1, "the stop request follows the cancel");
  assert.deepEqual(types.slice(stopAt + 1, stopAt + 3), ["run.output", "run.backend_settled"], "text after the stop is committed before the settlement");
  assert.equal(oldShape(app, session.id).runs[1]!.status, "cancelled"); assert.equal(reply(app, session.id, 1), "y1y2"); assert.equal(stopped.stops, 1);
});

test("INV-10 ADR-047: an open window is committed before a budget's end is recorded, and the Turn ends cancelled by its budget with the text kept", async t => {
  const f = await fixture(t), factory = new StreamingFactory(), { app, timers } = windowed(f, factory, { executionBudgetMs: 150 });
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "slow", "slow"); const turn = await first;
  turn.emit({ type: "text", text: "z1" }); assert.equal(timers.pending, 1);
  // The execution budget (real time, its own timer) runs out: the Runtime asks the program to stop.
  await turn.stopped.promise;
  const types = log(f, session.id).map(row => row.type);
  assert.ok(types.indexOf("run.output") < types.indexOf("run.budget_expired"), "the window precedes the expiry");
  assert.equal(timers.pending, 0, "the expiry took the window's timer");
  turn.result.resolve({ status: "cancelled", reason: "fixture" }); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "cancelled"); assert.equal(run.error?.code, "RUN_TIMEOUT"); assert.equal(reply(app, session.id), "z1");
});

test("INV-20 ADR-057 3.7: a reply and a thought have no length they may not pass: a Turn that says three megabytes keeps all of it, a window at a time, and nothing is refused", async t => {
  const f = await fixture(t), factory = new StreamingFactory(), { app, timers } = windowed(f, factory);
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "fill", "fill"); const turn = await first;
  const text = () => outputs(f, session.id).filter(row => row.startsWith("text:")), bytes = () => Buffer.byteLength(reply(app, session.id) ?? "");
  // Chunks at or above the window's bytes are committed at once, one window each; three megabytes stand, well past the 1 MiB a reply could not pass before.
  for (let chunk = 0; chunk < 3; chunk++) turn.emit({ type: "text", text: String.fromCharCode(97 + chunk).repeat(1024 * 1024) });
  assert.equal(bytes(), 3 * 1024 * 1024); assert.equal(timers.pending, 0);
  // A pair split between two chunks is four bytes, not six, and the open window goes on from what is committed.
  const before = text().length;
  turn.emit({ type: "text", text: "c".repeat(100) }); turn.emit({ type: "text", text: "🌱".slice(0, 1) }); turn.emit({ type: "text", text: "🌱".slice(1) });
  assert.equal(text().length, before); assert.equal(timers.pending, 1);
  turn.emit({ type: "text", text: "e" });
  turn.result.resolve({ status: "completed", reason: "end_turn" });
  await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!, said = reply(app, session.id) ?? "";
  assert.equal(run.status, "completed"); assert.equal(run.error, null); assert.equal(Buffer.byteLength(said), 3 * 1024 * 1024 + 100 + 4 + 1); assert.equal(said.endsWith("c".repeat(100) + "🌱e"), true);
  assert.equal(said.startsWith("a"), true);
});

test("INV-06/INV-28 ADR-047: a window its timer commits is published after its commit; once the owner is lost, no window is committed or published", async t => {
  const f = await fixture(t), factory = new StreamingFactory(), published: SessionEvent[] = [];
  const { app, timers } = windowed(f, factory, { publish: event => { assert.ok(f.store.events(event.sessionId, event.seq - 1, 1).some(row => row.seq === event.seq), "published before its commit"); published.push(event); } });
  const session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const first = factory.dispatched(1); app.send(session.id, "lose the owner", "lose"); const turn = await first;
  const windows = () => published.filter(event => event.type === "run.output").length;
  turn.emit({ type: "text", text: "w1" }); assert.equal(windows(), 0, "an open window is not published");
  assert.equal(timers.fire(), 1); assert.equal(windows(), 1); assert.equal(reply(app, session.id), "w1");
  turn.emit({ type: "text", text: "w2" }); assert.equal(timers.pending, 1);
  await loseOwner(f);
  assert.equal(timers.fire(), 1, "the window's timer runs; its commit is refused and stops the Turn");
  await turn.stopped.promise;
  turn.result.resolve({ status: "cancelled", reason: "fixture" });
  await assert.rejects(app.wait(session.id), (error: unknown) => error instanceof SessionError && error.code === "OWNER_LOST");
  assert.equal(windows(), 1, "nothing was published after the owner was lost");
  // Nothing was committed after the owner was lost: one window in the event log, and the reply that stands is the one chunk that was committed.
  assert.equal(sessionLines(f, "events").filter(line => line.type === "run.output").length, 1, "nothing was committed after the owner was lost");
  const chunks = sessionLines(f, "wip").flatMap(line => (line.text as { text: string }[] | undefined) ?? []).map(piece => piece.text);
  assert.deepEqual(chunks, ["w1"]);
  assert.equal(timers.pending, 0);
});

test("a name the user gave and an archive mark are one commit each, survive a restart from the files, and a Turn accepted in an archived conversation takes the mark off", async t => {
  const f = await fixture(t), factory = new ControlledFactory([controlled(), controlled()]), told: string[] = [];
  const app = runtime(f, factory, event => { if (event.type === "session.renamed" || event.type === "session.archived") told.push(event.type + " " + JSON.stringify(event.data)); });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  // Named before its first Turn, with line breaks and spaces around: the name is kept as given, and the first message does not replace it.
  app.updateSession(state.id, { title: "  Plan\n the  launch \r\n" });
  assert.equal(f.store.head(state.id).title, "Plan the  launch");
  assert.throws(() => app.updateSession(state.id, { title: " \n " }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  assert.throws(() => app.updateSession(state.id, {}), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  app.updateSession(state.id, { archived: true });
  assert.equal(f.store.get(state.id).archived, true); assert.equal(f.store.head(state.id).head.archived, true);
  assert.equal(f.store.list().rows.find(row => row.id === state.id)?.archived, true);
  // A change that changes nothing commits nothing.
  const version = f.store.head(state.id).version;
  app.updateSession(state.id, { archived: true, title: "Plan the  launch" }); assert.equal(f.store.head(state.id).version, version);
  // A Turn accepted in it takes the mark off in the commit that accepts it; the name stays.
  app.send(state.id, "the first question", "first");
  assert.equal(f.store.get(state.id).archived, undefined); assert.equal(f.store.list().rows.find(row => row.id === state.id)?.archived, undefined);
  await app.wait(state.id);
  assert.equal(f.store.head(state.id).title, "Plan the  launch");
  app.updateSession(state.id, { title: "Launch plan", archived: true });
  assert.deepEqual(told, ['session.renamed {"title":"Plan the  launch"}', 'session.archived {"archived":true}', 'session.renamed {"title":"Launch plan"}', 'session.archived {"archived":true}']);
  // Read again from the files by a new owner: the name and the mark are there, in the head, the conversation and the list.
  await app.close(); f.store.close();
  const reopened = appStore(join(f.root, "data")); f.stores.push(reopened);
  assert.equal(reopened.head(state.id).title, "Launch plan"); assert.equal(reopened.get(state.id).archived, true); assert.equal(reopened.get(state.id).userTitle, "Launch plan");
  const row = reopened.list().rows.find(entry => entry.id === state.id);
  assert.deepEqual([row?.title, row?.archived], ["Launch plan", true]);
  // A second Turn, under the new owner: the mark comes off and the name the user gave is still the title.
  const next = runtime({ ...f, store: reopened }, factory, () => {}, "restart-");
  next.send(state.id, "a second question", "second"); await next.wait(state.id);
  assert.equal(reopened.get(state.id).archived, undefined); assert.equal(reopened.head(state.id).title, "Launch plan");
});

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

test("a pin and a reminder are kept in the head and survive a restart; a new Turn takes the reminder off and leaves the pin; naming and marking never move the conversation's time", async t => {
  const f = await fixture(t), factory = new ControlledFactory([controlled(), controlled()]), told: string[] = [];
  const app = runtime(f, factory, event => { if (event.type === "session.pinned" || event.type === "session.snoozed") told.push(event.type + " " + JSON.stringify(event.data)); });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "the first question", "first"); await app.wait(state.id);
  const moved = f.store.head(state.id).updatedAt, seq = f.store.head(state.id).lastSeq;
  await pause(15);
  app.updateSession(state.id, { pinned: true, snoozedUntil: 1_900_000_000_000 });
  await pause(15);
  app.updateSession(state.id, { title: "Pinned one", archived: true });
  assert.throws(() => app.updateSession(state.id, { snoozedUntil: -1 }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  assert.throws(() => app.updateSession(state.id, { snoozedUntil: 1.5 }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  // Named and marked: the cursor went on (the page learns of it), the time did not (the list's order and its "how long ago" are the conversation's own).
  const head = f.store.head(state.id), row = f.store.list().rows.find(entry => entry.id === state.id)!;
  assert.equal(head.updatedAt, moved); assert.equal(row.updatedAt, moved); assert.ok(head.lastSeq > seq);
  assert.deepEqual([head.head.pinned, head.head.snoozedUntil, row.pinned, row.snoozedUntil], [true, 1_900_000_000_000, true, 1_900_000_000_000]);
  assert.deepEqual(told, ['session.pinned {"pinned":true,"order":0}', 'session.snoozed {"until":1900000000000}']);
  // Read again from the files by a new owner: the marks are there, and the time is still the one the Turn left.
  await app.close(); f.store.close();
  const reopened = appStore(join(f.root, "data")); f.stores.push(reopened);
  const read = reopened.head(state.id), listed = reopened.list().rows.find(entry => entry.id === state.id)!;
  assert.deepEqual([read.updatedAt, listed.updatedAt, read.title, read.head.pinned, read.head.snoozedUntil, read.head.archived], [moved, moved, "Pinned one", true, 1_900_000_000_000, true]);
  assert.deepEqual([reopened.get(state.id).pinned, reopened.get(state.id).snoozedUntil], [true, 1_900_000_000_000]);
  // A second Turn: the reminder and the archive mark come off in the commit that accepts it, the pin stays, and the time moves on.
  await pause(15);
  const next = runtime({ ...f, store: reopened }, factory, () => {}, "restart-");
  next.send(state.id, "a second question", "second");
  assert.deepEqual([reopened.get(state.id).snoozedUntil, reopened.get(state.id).archived, reopened.get(state.id).pinned], [undefined, undefined, true]);
  await next.wait(state.id);
  assert.ok(reopened.head(state.id).updatedAt > moved);
  // Taking the reminder off with null, and the pin with false.
  next.updateSession(state.id, { snoozedUntil: 1_900_000_000_000 }); next.updateSession(state.id, { snoozedUntil: null, pinned: false });
  assert.deepEqual([reopened.get(state.id).snoozedUntil, reopened.get(state.id).pinned, reopened.list().rows.find(entry => entry.id === state.id)?.pinned], [undefined, undefined, undefined]);
});

test("the pinned keep a place the user sets: a new pin goes first, a place is moved like the pin itself (the time does not move), only a pinned conversation has one, unpinning drops it, and the places survive a restart", async t => {
  const f = await fixture(t), factory = new ControlledFactory([controlled(), controlled()]), told: string[] = [];
  const app = runtime(f, factory, event => { if (event.type === "session.pinned") told.push(JSON.stringify(event.data)); });
  const [a, b, c] = [await app.create(f.configuration, { harnessId: "alpha" }, "a"), await app.create(f.configuration, { harnessId: "alpha" }, "b"), await app.create(f.configuration, { harnessId: "alpha" }, "c")];
  app.send(a.id, "a question", "first"); await app.wait(a.id);
  const moved = f.store.head(a.id).updatedAt, place = (id: string) => f.store.get(id as typeof a.id).pinnedOrder, listed = (id: string) => f.store.list().rows.find(row => row.id === id);
  await pause(15);
  // Each pin without a place goes first: lower than every other pinned one.
  app.updateSession(a.id, { pinned: true }); app.updateSession(b.id, { pinned: true }); app.updateSession(c.id, { pinned: true });
  assert.deepEqual([place(a.id), place(b.id), place(c.id)], [0, -1, -2]);
  // Pinning one already pinned keeps its place; a drag moves it (any finite number, between two others), and nothing of the time moves.
  app.updateSession(b.id, { pinned: true }); assert.equal(place(b.id), -1);
  app.updateSession(a.id, { pinnedOrder: -1.5 });
  assert.deepEqual([place(a.id), listed(a.id)?.pinnedOrder, f.store.head(a.id).head.pinnedOrder, f.store.head(a.id).updatedAt], [-1.5, -1.5, -1.5, moved]);
  const version = f.store.head(a.id).version; app.updateSession(a.id, { pinnedOrder: -1.5 }); assert.equal(f.store.head(a.id).version, version, "the same place commits nothing");
  // Only a pinned conversation has a place; a change that pins it may give one; an order with the pin taken off, or one that is not a finite number, is refused.
  app.updateSession(c.id, { pinned: false }); assert.deepEqual([f.store.get(c.id).pinned, place(c.id), listed(c.id)?.pinnedOrder], [undefined, undefined, undefined]);
  assert.throws(() => app.updateSession(c.id, { pinnedOrder: 3 }), (error: unknown) => error instanceof SessionError && error.code === "PIN_REQUIRED");
  for (const bad of [{ pinnedOrder: Number.NaN }, { pinnedOrder: Number.POSITIVE_INFINITY }, { pinned: false, pinnedOrder: 1 }])
    assert.throws(() => app.updateSession(b.id, bad), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT", JSON.stringify(bad));
  app.updateSession(c.id, { pinned: true, pinnedOrder: 7 }); assert.equal(place(c.id), 7);
  // A deleted pinned conversation is no longer among the pinned: a new pin goes first among those listed.
  await app.deleteSession(b.id);
  app.updateSession(c.id, { pinned: false }); app.updateSession(c.id, { pinned: true }); assert.equal(place(c.id), -2.5);
  assert.deepEqual(told, [{ pinned: true, order: 0 }, { pinned: true, order: -1 }, { pinned: true, order: -2 }, { pinned: true, order: -1.5 }, { pinned: false }, { pinned: true, order: 7 }, { pinned: false }, { pinned: true, order: -2.5 }].map(data => JSON.stringify(data)));
  // Read again from the files by a new owner: the places are in the head, the conversation and the list.
  await app.close(); f.store.close();
  const reopened = appStore(join(f.root, "data")); f.stores.push(reopened);
  assert.deepEqual([reopened.get(a.id).pinnedOrder, reopened.head(a.id).head.pinnedOrder, reopened.list().rows.find(row => row.id === a.id)?.pinnedOrder, reopened.get(c.id).pinnedOrder], [-1.5, -1.5, -1.5, -2.5]);
  // A new Turn leaves the pin and its place.
  const next = runtime({ ...f, store: reopened }, factory, () => {}, "restart-");
  next.send(a.id, "a second question", "second"); await next.wait(a.id);
  assert.deepEqual([reopened.get(a.id).pinned, reopened.get(a.id).pinnedOrder], [true, -1.5]);
});

test("a deleted conversation leaves the list and takes no new work, stays deleted after a restart with its file in place, and is restored where its own time puts it; one with a Turn going on is not deleted", async t => {
  const f = await fixture(t), held = controlled({ holdResult: true }), factory = new ControlledFactory([controlled(), held, controlled()]), told: string[] = [];
  const app = runtime(f, factory, event => { if (event.type === "session.deleted" || event.type === "session.restored") told.push(event.type); });
  const gone = await app.create(f.configuration, { harnessId: "alpha" }, "gone"), busy = await app.create(f.configuration, { harnessId: "alpha" }, "busy");
  app.send(gone.id, "a question", "first"); await app.wait(gone.id);
  const moved = f.store.head(gone.id).updatedAt, file = f.store.fileOf(gone.id);
  await pause(15);
  await app.deleteSession(gone.id);
  assert.equal(f.store.list().rows.some(row => row.id === gone.id), false); assert.notEqual(f.store.head(gone.id).deletedAt, null);
  assert.throws(() => app.send(gone.id, "again", "again"), (error: unknown) => error instanceof SessionError && error.code === "SESSION_NOT_FOUND");
  // Deleting it again changes nothing.
  const version = f.store.head(gone.id).version; await app.deleteSession(gone.id); assert.equal(f.store.head(gone.id).version, version);
  // A Turn going on: refused, and the conversation stays.
  app.send(busy.id, "a long one", "long"); await held.started.promise;
  await assert.rejects(app.deleteSession(busy.id), (error: unknown) => error instanceof SessionError && error.code === "SESSION_ACTIVE");
  held.result.resolve({ status: "completed", reason: "fixture", input: "recorded" }); await app.wait(busy.id);
  assert.equal(f.store.list().rows.some(row => row.id === busy.id), true);
  // A new owner reads the files: still deleted, the file where it was.
  await app.close(); f.store.close();
  const reopened = appStore(join(f.root, "data")); f.stores.push(reopened);
  assert.equal(reopened.list().rows.some(row => row.id === gone.id), false); assert.notEqual(reopened.head(gone.id).deletedAt, null); assert.equal(reopened.fileOf(gone.id), file);
  const next = runtime({ ...f, store: reopened }, factory, () => {}, "restart-");
  next.restoreSession(gone.id);
  const row = reopened.list().rows.find(entry => entry.id === gone.id);
  assert.equal(row?.updatedAt, moved, "restored where its own time puts it"); assert.equal(reopened.head(gone.id).deletedAt, null);
  next.send(gone.id, "back again", "back"); await next.wait(gone.id);
  assert.equal(reopened.get(gone.id).runs.length, 2);
  assert.deepEqual(told, ["session.deleted"]);
});

test("the name a first Turn's wrap-up gives is taken once, while the user has not named the conversation; the user's name goes before it, given before or after", async t => {
  const f = await fixture(t), peers = [controlled({ holdResult: true }), controlled({ holdResult: true }), controlled({ holdResult: true })], factory = new ControlledFactory(peers), told: string[] = [];
  const app = runtime(f, factory, event => { if (event.type === "session.titled") told.push(JSON.stringify(event.data)); });
  const from = { harnessId: "alpha", controlId: "alpha-acp" };
  const turn = async (id: SessionId, peer: ControlledPeer, text: string, key: string, title?: string): Promise<void> => {
    app.send(id, text, key); await peer.started.promise;
    app.hubProgress(id, from, { kind: "recap", summary: "Done.", ...(title === undefined ? {} : { title }) });
    peer.result.resolve({ status: "completed", reason: "fixture", input: "recorded" }); await app.wait(id);
  };
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  await turn(state.id, peers[0]!, "please look at the login page timeout", "first", "  Login\n timeout ");
  const moved = f.store.head(state.id).updatedAt;
  assert.equal(f.store.head(state.id).title, "Login timeout"); assert.equal(f.store.list().rows.find(row => row.id === state.id)?.title, "Login timeout");
  assert.equal(f.store.get(state.id).harnessTitle, "Login timeout"); assert.equal(f.store.get(state.id).userTitle, undefined);
  // A second Turn's title is not taken.
  await turn(state.id, peers[1]!, "and the signup page", "second", "Signup page");
  assert.equal(f.store.head(state.id).title, "Login timeout");
  // The user's name goes before it, and the name is not what moves the time.
  app.updateSession(state.id, { title: "Mine" }); assert.equal(f.store.head(state.id).title, "Mine");
  // Read again from the files: both names kept, the user's the title.
  await app.close(); f.store.close();
  const reopened = appStore(join(f.root, "data")); f.stores.push(reopened);
  assert.deepEqual([reopened.head(state.id).title, reopened.get(state.id).harnessTitle, reopened.get(state.id).userTitle], ["Mine", "Login timeout", "Mine"]);
  assert.ok(reopened.head(state.id).updatedAt >= moved);
  // Named by the user before its first Turn: the wrap-up's title is not taken.
  const peer = controlled({ holdResult: true });
  const named = runtime({ ...f, store: reopened }, new ControlledFactory([peer]), event => { if (event.type === "session.titled") told.push(JSON.stringify(event.data)); }, "named-");
  const other = await named.create(f.configuration, { harnessId: "alpha" }, "other");
  named.updateSession(other.id, { title: "User's own" });
  named.send(other.id, "a question", "q"); await peer.started.promise;
  named.hubProgress(other.id, from, { kind: "recap", summary: "Done.", title: "Harness name" });
  peer.result.resolve({ status: "completed", reason: "fixture", input: "recorded" }); await named.wait(other.id);
  assert.equal(reopened.head(other.id).title, "User's own"); assert.equal(reopened.get(other.id).harnessTitle, undefined);
  assert.deepEqual(told, ['{"title":"Login timeout"}']);
});
