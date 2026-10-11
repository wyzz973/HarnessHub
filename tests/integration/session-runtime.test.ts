import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlRun, type HarnessControl, type NativeConversationId, type ProtocolObservation } from "../../src/contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
class Gate<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() { this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
}
interface Fixture { readonly root: string; readonly store: SqliteSessionStore; readonly stores: SqliteSessionStore[]; readonly configuration: SessionConfiguration; readonly runtimes: SessionRuntime[] }
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-session-runtime-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const store = new SqliteSessionStore(join(root, "data"));
  const stores = [store];
  const runtimes: SessionRuntime[] = [];
  t.after(async () => {
    for (const app of runtimes) {
      try { await app.close(); }
      catch (error) { if (!(error instanceof SessionError) || !["SESSION_BLOCKED", "PUBLICATION_FAILED", "STORAGE_UNAVAILABLE"].includes(error.code)) throw error; }
    }
    for (const owned of stores) try { owned.close(); } catch { /* A fault test may already poison its Store. */ }
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, stores, runtimes, configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true } };
}
function runtime(f: Fixture, factory: SessionBindingFactory, publish: (event: SessionEvent) => void = () => {}, idPrefix = ""): SessionRuntime {
  let id = 0;
  const app = new SessionRuntime(f.store, factory, { id: () => idPrefix + String(++id), now: () => new Date("2026-10-09T00:00:00Z"), publish,
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
      startText: async (_id: NativeConversationId, text: string, output: (event: ControlEvent) => void): Promise<ControlRun> => {
        assert.equal(opened, true); fixture.started.resolve(text); output({ type: "text", text: fixture.output });
        if (!fixture.holdResult) fixture.result.resolve({ status: "completed", reason: "fixture" });
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
  const run = app.read(session.id).runs[0]!;
  assert.equal(dispatched, 0); assert.equal(run.status, "cancelled");
  assert.equal(run.backend, null); assert.equal(run.cleanup?.closed, true);
  assert.equal(peer.closeCount, 1); assert.equal(app.read(session.id).status, "open");
});

test("real SQLite and ACP/Codex IPC retain one public Session through A to B to A with new connections", async (t) => {
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
  const final = app.read(state.id);
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
  const run = app.read(state.id).runs[0]!, timing = run.timing!;
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
  await app.wait(state.id); assert.equal(app.read(state.id).runs.length, 1); assert.equal(app.read(state.id).switches.length, 1);
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
  assert.equal(factory.prepared.length, 1); assert.equal(app.read(state.id).selection.harnessId, "alpha");
  first.closed.resolve(clean); await app.wait(state.id);
  const final = app.read(state.id), sw = final.switches.find(sw => sw.id === switchReceipt.switchId)!;
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
  const final = app.read(state.id);
  assert.equal(final.runs[0]?.status, "cancelled"); assert.equal(final.runs[0]?.backend?.status, "completed");
  assert.equal(final.runs[1]?.id, queued.runId); assert.equal(final.runs[1]?.status, "completed");
  assert.equal(first.stopCount, 1); assert.equal(first.closeCount, 1);
});

test("cancel during initialization closes connection without dispatching the input", async (t) => {
  const f = await fixture(t), first = controlled({ holdInitialize: true }), factory = new ControlledFactory([first]), app = runtime(f, factory); t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"), receipt = app.send(state.id, "no dispatch", "send");
  await first.initialized.promise; app.cancel(state.id, "cancel", receipt.runId); await app.wait(state.id);
  assert.equal(app.read(state.id).runs[0]?.status, "cancelled"); assert.equal(app.read(state.id).runs[0]?.backend, null);
  assert.equal(first.stopCount, 0); assert.equal(first.closeCount, 1);
});

test("one global writer waits for confirmed close before another Session starts", async (t) => {
  const f = await fixture(t), first = controlled({ holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory); t.after(() => app.close());
  const a = await app.create(f.configuration, { harnessId: "alpha" }, "a"), b = await app.create(f.configuration, { harnessId: "bravo" }, "b");
  app.send(a.id, "writer a", "a-input"); await first.closing.promise;
  app.send(b.id, "writer b", "b-input"); assert.equal(factory.prepared.length, 1);
  first.closed.resolve(clean); await app.wait(b.id);
  assert.equal(factory.prepared.length, 2); assert.equal(app.read(b.id).runs[0]?.status, "completed");
});

test("target validation failure keeps actual selection and history, but never dispatches input awaiting that switch", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory); t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "preserved input", "first"); await app.wait(state.id);
  app.switch(state.id, { harnessId: "missing" }, "bad-switch"); app.send(state.id, "continue explicitly on alpha", "next"); await app.wait(state.id);
  const final = app.read(state.id);
  assert.equal(final.selection.harnessId, "alpha"); assert.equal(final.epoch, 1); assert.equal(final.switches[0]?.status, "failed");
  assert.equal(final.runs[1]?.status, "failed"); assert.equal(final.runs[1]?.error?.code, "SWITCH_NOT_EFFECTIVE");
  assert.equal(factory.prepared.length, 1);
  app.send(state.id, "explicit continuation after failed switch", "continue"); await app.wait(state.id);
  assert.equal(app.read(state.id).runs[2]?.status, "completed"); assert.equal(app.read(state.id).runs[2]?.selection.harnessId, "alpha");
});

test("unconfirmed cleanup blocks next writer and does not rerun or activate pending switch", async (t) => {
  const f = await fixture(t), first = controlled({ holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  t.after(async () => { try { await app.close(); } catch {} });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "unknown cleanup", "first"); await first.closing.promise;
  app.switch(state.id, { harnessId: "bravo" }, "switch"); app.send(state.id, "never launched", "next");
  first.closed.reject(new SessionError("CLEANUP_FAILED", "synthetic unconfirmed cleanup"));
  await assert.rejects(() => app.wait(state.id), /new dispatch is disabled/);
  const final = app.read(state.id);
  assert.equal(final.status, "blocked"); assert.equal(final.runs[0]?.status, "unknown"); assert.equal(factory.prepared.length, 1);
  assert.equal(final.selection.harnessId, "alpha"); assert.throws(() => app.send(state.id, "retry", "retry"), /disabled/);
});

test("late protocol failure retains backend evidence, fails the reply and leaves a quiescent conversation usable", async (t) => {
  const f = await fixture(t), factory = new PeerFactory(f.root, "duplicate-complete"), app = runtime(f, factory);
  t.after(async () => { try { await app.close(); } catch {} });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "duplicate terminal", "send");
  await app.wait(state.id);
  const final = app.read(state.id), run = final.runs[0]!;
  assert.equal(run.backend?.status, "completed"); assert.equal(run.cleanup?.closed, true); assert.notEqual(run.cleanup?.protocolFailure, null);
  assert.equal(run.status, "failed"); assert.equal(final.status, "open"); assert.equal(factory.prepared.length, 1);
  app.switch(state.id, { harnessId: "bravo" }, "next-selection"); await app.wait(state.id);
  assert.equal(app.read(state.id).selection.harnessId, "bravo");
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
  assert.equal(app.read(state.id).status, "blocked"); assert.ok(app.read(state.id).messages.some(message => message.role === "assistant"));
});

test("real SQLite write failure does not publish output or dispatch later queued input and closes the external resource", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), published: SessionEvent[] = [], app = runtime(f, factory, value => published.push(value));
  t.after(async () => { try { await app.close(); } catch {} });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const db = new DatabaseSync(join(f.root, "data", "gateway.sqlite"));
  db.exec("CREATE TRIGGER fail_output BEFORE INSERT ON events WHEN json_extract(NEW.event_json,'$.type')='run.output' BEGIN SELECT RAISE(FAIL,'synthetic disk write rejection'); END");
  app.send(state.id, "write failure input", "first"); app.send(state.id, "never replay this queued input", "second");
  await assert.rejects(() => app.wait(state.id), /SQLite operation failed/);
  assert.ok(!published.some(value => value.type === "run.output")); assert.equal(factory.prepared.length, 1); assert.equal(factory.prepared[0]?.peer.closeCount, 1);
  const row = db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id); assert.ok(row && typeof row.snapshot === "string");
  const persisted = JSON.parse(row.snapshot) as { runs: readonly { status: string }[]; messages: readonly { role: string }[] };
  assert.equal(persisted.runs[0]?.status, "running"); assert.ok(!persisted.messages.some(message => message.role === "assistant"));
  assert.throws(() => app.send(state.id, "retry", "retry"), /SQLite operation failed/); db.close();
});

test("Session close and runtime close cancel queued inputs, await active cleanup and preserve historical facts", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  t.after(() => app.close());
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "active", "active"); await first.started.promise;
  app.send(state.id, "queued", "queued"); const closed = app.closeSession(state.id, "close");
  first.result.resolve({ status: "cancelled", reason: "fixture" });
  assert.equal((await closed).status, "closed"); assert.equal((await app.closeSession(state.id, "close")).status, "closed");
  assert.equal(factory.prepared.length, 1); assert.ok(app.read(state.id).runs.every(run => run.status === "cancelled"));
  assert.throws(() => app.send(state.id, "after close", "late"), /closed or blocked/);
  const second = await app.create(f.configuration, { harnessId: "alpha" }, "second"); app.send(second.id, "cancel before runtime stop", "second-input");
  await app.close(); assert.equal(app.read(second.id).status, "open"); assert.equal(app.read(second.id).runs[0]?.status, "cancelled");
  assert.throws(() => app.send(second.id, "late", "late"), /not accepting/);
  f.store.assertOwner();
});

test("completed public history survives Store reopen with no automatic dispatch", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "durable history", "send"); await app.wait(state.id); await app.close();
  f.store.close();
  const reopened = new SqliteSessionStore(join(f.root, "data")); t.after(() => reopened.close());
  assert.equal(reopened.get(state.id).runs[0]?.status, "completed"); assert.equal(reopened.get(state.id).messages[0]?.text, "durable history");
  assert.equal(factory.prepared.length, 1); assert.ok(reopened.ownerGeneration > f.store.ownerGeneration);
  reopened.close();
});

test("closing during a busy pending switch retains source identity until old execution settles", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const active = app.send(state.id, "old execution", "active"); await first.started.promise;
  const sw = app.switch(state.id, { harnessId: "bravo" }, "switch");
  const closing = app.closeSession(state.id, "close");
  assert.equal(app.read(state.id).switches[0]?.status, "requested");
  first.result.resolve({ status: "cancelled", reason: "fixture" });
  const final = await closing;
  assert.equal(final.status, "closed"); assert.equal(final.pendingSwitchId, null); assert.equal(final.selection.harnessId, "alpha");
  assert.equal(final.switches[0]?.id, sw.switchId); assert.equal(final.switches[0]?.status, "failed");
  assert.deepEqual(final.switches[0]?.sourceRunIds, [active.runId]); assert.equal(factory.prepared.length, 1);
});

test("queue input count and byte limits reject admission without launching cancelled tombstones", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  for (const value of ["", " ", "x".repeat(64 * 1024 + 1), "中文".repeat(22000), "nul\0input"])
    assert.throws(() => app.send(state.id, value, "invalid"), /64 KiB/);
  const receipts = Array.from({ length: 8 }, (_, index) => app.send(state.id, "queued " + index, "send-" + index));
  assert.throws(() => app.send(state.id, "ninth", "ninth"), /queued input limit/);
  for (const [index, receipt] of receipts.entries()) app.cancel(state.id, "cancel-" + index, receipt.runId);
  await app.wait(state.id);
  assert.equal(factory.prepared.length, 0); assert.ok(app.read(state.id).runs.every(run => run.status === "cancelled"));
});

test("inputs queued before switch retain their original Harness and become completed switch context sources", async (t) => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const active = app.send(state.id, "first active", "first"); await first.started.promise;
  const before = app.send(state.id, "old Harness queued input", "before");
  const sw = app.switch(state.id, { harnessId: "bravo" }, "switch");
  const after = app.send(state.id, "new Harness queued input", "after");
  first.result.resolve({ status: "completed", reason: "fixture" }); await app.wait(state.id);
  const final = app.read(state.id), firstSwitch = final.switches.find(entry => entry.id === sw.switchId)!;
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
  const final = app.read(state.id);
  assert.equal(final.status, "blocked"); assert.equal(final.runs[0]?.backend, null); assert.equal(final.runs[0]?.status, "unknown");
  assert.equal(final.runs[0]?.cleanup?.closed, true); assert.equal(factory.prepared.length, 1);
  const pid = Number(await readFile(factory.prepared[0]!.pid, "utf8")); assert.throws(() => process.kill(pid, 0));
});

test("binding preparation cleanup failure blocks the Session even when no control was returned", async (t) => {
  const f = await fixture(t); let prepares = 0;
  const app = runtime(f, { validate: async request => selection(request), prepare: async () => { prepares += 1; throw new SessionError("BINDING_CLEANUP_FAILED", "synthetic resource owner could not close"); } });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "preparation unknown", "first"); app.send(state.id, "do not launch", "second");
  await assert.rejects(() => app.wait(state.id), /disabled/);
  assert.equal(app.read(state.id).status, "blocked"); assert.equal(app.read(state.id).runs[0]?.status, "unknown"); assert.equal(prepares, 1);
});

test("publication failure after terminal commit preserves completion evidence and durably blocks further dispatch", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory, value => {
    if (value.type === "run.ended") throw new Error("terminal observer failure");
  });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "known completed input", "send");
  await assert.rejects(() => app.wait(state.id), /publication failed/);
  const final = app.read(state.id);
  assert.equal(final.runs[0]?.status, "completed"); assert.equal(final.runs[0]?.backend?.status, "completed");
  assert.equal(final.runs[0]?.cleanup?.closed, true); assert.equal(final.status, "blocked"); assert.equal(factory.prepared.length, 1);
});

test("switch effective watermark advances through validation without creating an unused target connection while later inputs stay excluded from sources", async (t) => {
  const f = await fixture(t), validating = new Gate<void>(), release = new Gate<void>(), factory = new ControlledFactory([]);
  const validate = factory.validate.bind(factory); factory.validate = async request => { const target = await validate(request); if(request.harnessId==="bravo"){validating.resolve();await release.promise;} return target; }; const app=runtime(f,factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"), sw = app.switch(state.id, { harnessId: "bravo" }, "switch");
  await validating.promise;
  const later = app.send(state.id, "later cancelled input", "later"); app.cancel(state.id, "cancel", later.runId);
  const beforeEffective = app.read(state.id).lastSeq;
  release.resolve(); await app.wait(state.id);
  const final = app.read(state.id), effective = final.switches.find(entry => entry.id === sw.switchId)!;
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
  f.store.assertOwner(); assert.equal(f.store.list().length, 0);
  release.resolve(); await Promise.all([closing, creationFailure]);
  assert.equal(finished, true); assert.ok(!(await readdir(f.root)).includes("validation-resource"));
  f.store.assertOwner(); assert.equal(f.store.list().length, 0);
});

test("no more than sixteen creations can hold simultaneous external validation resources", async (t) => {
  const f = await fixture(t), allReady = new Gate<void>(), release = new Gate<void>(); let calls = 0, ready = 0;
  const app = runtime(f, {
    validate: async request => {
      const directory = join(f.root, "validation-" + ++calls); await mkdir(directory);
      if (++ready === 16) allReady.resolve();
      try { await release.promise; return selection(request); } finally { await rm(directory, { recursive: true }); }
    }, prepare: async () => { throw new Error("validation-only fixture must not prepare"); },
  });
  const creations = Array.from({ length: 16 }, (_, index) => app.create(f.configuration, { harnessId: "alpha" }, "create-" + index));
  const failures = creations.map(pending => assert.rejects(pending, (error: unknown) => error instanceof SessionError && error.code === "RUNTIME_CLOSED"));
  await allReady.promise;
  await assert.rejects(() => app.create(f.configuration, { harnessId: "alpha" }, "seventeenth"), (error: unknown) => error instanceof SessionError && error.code === "CREATE_LIMIT");
  assert.equal(calls, 16); assert.equal((await readdir(f.root)).filter(name => name.startsWith("validation-")).length, 16);
  const closing = app.close(); f.store.assertOwner(); release.resolve(); await Promise.all([closing, ...failures]);
  assert.equal((await readdir(f.root)).filter(name => name.startsWith("validation-")).length, 0); assert.equal(f.store.list().length, 0);
});

test("a failed Store create never registers a nonexistent Session for shutdown", async (t) => {
  const f = await fixture(t), app = new SessionRuntime(f.store, new ControlledFactory([]), {
    id: () => "failed-create", now: () => new Date(), publish: () => {}, fingerprint: () => "invalid-fingerprint",
  });
  await assert.rejects(() => app.create(f.configuration, { harnessId: "alpha" }, "create"), (error: unknown) => error instanceof SessionError && error.code === "INVALID_DATA");
  await assert.rejects(() => app.close(), (error: unknown) => error instanceof SessionError && error.code === "INVALID_DATA");
  f.store.assertOwner(); assert.deepEqual(f.store.list(), []);
});

test("shutdown owns one Promise before committed-event callbacks can reenter close", async (t) => {
  const f = await fixture(t), factory = new ControlledFactory([]); let app!: SessionRuntime, reentered: Promise<void> | null = null;
  app = runtime(f, factory, value => { if (value.type === "runtime.stopping") reentered = app.close(); });
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"); app.send(state.id, "cancel before launch", "send");
  const closing = app.close(); assert.equal(app.close(), closing); await closing;
  assert.equal(reentered, closing); assert.equal(factory.prepared.length, 0); assert.equal(app.read(state.id).runs[0]?.status, "cancelled");
});

const providerA = { providerId: "provider-11111111-1111-4111-8111-111111111111", revision: 1, model: "model-a" };
const providerB = { providerId: "provider-22222222-2222-4222-8222-222222222222", revision: 2, model: "model-b" };
test("Provider switch pins the current Turn and waits for cleanup before changing the next Turn", async t => {
  const f = await fixture(t), first = controlled({ holdResult: true, holdClose: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha", provider: providerA }, "provider-create");
  const initial = app.send(state.id, "on A", "provider-first"); await first.started.promise;
  app.switch(state.id, { harnessId: "alpha", provider: providerB }, "provider-switch");
  const next = app.send(state.id, "on B", "provider-next");
  assert.deepEqual(app.read(state.id).selection.provider, providerA);
  first.result.resolve({ status: "completed", reason: "fixture" }); await first.closing.promise;
  assert.equal(factory.prepared.length, 1); assert.deepEqual(app.read(state.id).runs[0]?.selection.provider, providerA);
  first.closed.resolve(clean); await app.wait(state.id);
  const final = app.read(state.id);
  assert.equal(final.runs.find(run => run.id === initial.runId)?.selection.provider?.model, "model-a");
  assert.deepEqual(final.runs.find(run => run.id === next.runId)?.selection.provider, providerB);
  assert.deepEqual(final.selection.provider, providerB); assert.equal(final.epoch, 2);
});
test("Harness-only switch inherits Provider and an explicit null clears managed configuration", async t => {
  const f = await fixture(t), factory = new ControlledFactory([]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha", provider: providerA }, "inherit-create");
  app.switch(state.id, { harnessId: "bravo" }, "inherit-switch"); await app.wait(state.id);
  assert.deepEqual(app.read(state.id).selection.provider, providerA);
  assert.equal(factory.prepared.length,0,"ordinary selection must not start a native process");
  app.switch(state.id, { harnessId: "alpha", provider: null }, "clear-switch"); await app.wait(state.id);
  assert.equal(app.read(state.id).selection.provider, undefined);
});

test("initialization failure with confirmed close fails only that reply and permits another selection in the same Session", async t => {
  const f = await fixture(t), broken = controlled({ holdInitialize: true }), factory = new ControlledFactory([broken]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "before initialization", "first"); await broken.initialized.promise;
  broken.initialize!.reject(new SessionError("GATEWAY_AUTH_REQUIRED", "synthetic missing Gateway token"));
  await app.wait(state.id);
  const failed = app.read(state.id); assert.equal(failed.status, "open"); assert.equal(failed.runs[0]!.status, "failed");
  assert.equal(failed.runs[0]!.backend, null); assert.equal(failed.runs[0]!.cleanup?.closed, true);
  app.switch(state.id, { harnessId: "bravo" }, "choose-working"); await app.wait(state.id);
  app.send(state.id, "explicit next request", "next"); await app.wait(state.id);
  const final = app.read(state.id); assert.equal(final.id, state.id); assert.equal(final.runs[1]!.status, "completed");
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
  assert.equal(app.read(other.id).runs[0]!.status, "completed"); assert.equal(app.read(blocked.id).status, "blocked");
  assert.throws(() => app.send(blocked.id, "implicit retry", "bad-retry"), /disabled/);
  await app.closeSession(blocked.id, "archive-unknown"); assert.equal(app.read(blocked.id).status, "closed");
  assert.equal(app.read(blocked.id).runs[0]!.status, "unknown");
});

test("explicit recovery preserves unknown facts, cancels queued inputs and starts only the user's new request", async t => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]), app = runtime(f, factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(state.id, "result is unknown", "first"); app.send(state.id, "queued input must never be replayed", "queued");
  await first.started.promise; first.result.reject(new SessionError("CONTROL_FAILED", "transport ended without settlement"));
  await assert.rejects(() => app.wait(state.id), /disabled/);
  const before = app.read(state.id);
  assert.throws(() => app.resume(state.id, { harnessId: "bravo" }, "resume", false), error => error instanceof SessionError && error.code === "RECOVERY_ACK_REQUIRED");
  const receipt = app.resume(state.id, { harnessId: "bravo" }, "resume", true); await app.wait(state.id);
  const resumed = app.read(state.id); assert.equal(resumed.status, "open"); assert.equal(resumed.epoch, 2);
  assert.deepEqual(resumed.runs[0], before.runs[0]); assert.equal(resumed.runs[1]!.status, "cancelled");
  assert.equal(factory.prepared.length, 2, "recovery only initializes a fresh connection");
  assert.equal(app.resume(state.id, { harnessId: "bravo" }, "resume", true).switchId, receipt.switchId);
  assert.throws(() => app.switch(state.id, { harnessId: "bravo" }, "resume"), /another request/);
  app.send(state.id, "new explicit input", "new"); await app.wait(state.id);
  assert.equal(factory.prepared.length, 3); assert.equal(app.read(state.id).runs[2]!.status, "completed");
  assert.equal(app.read(state.id).runs[0]!.status, "unknown");
});

test("legacy falsely blocked switch resumes with the same Session and immutable failed-switch evidence", async t => {
  const f=await fixture(t), factory=new ControlledFactory([]), validate=factory.validate.bind(factory); factory.validate=async request=>{if(request.harnessId==="bravo")throw new SessionError("GATEWAY_AUTH_REQUIRED","synthetic legacy authentication failure");return validate(request);}; const app=runtime(f,factory);
  const state = await app.create(f.configuration, { harnessId: "alpha" }, "create"), failed = app.switch(state.id, { harnessId: "bravo" }, "bad-switch");
  await app.wait(state.id);
  const cleanFailure = app.read(state.id);
  f.store.transact(state.id, cleanFailure.version, current => ({ next: { ...current, status: "blocked" }, events: [{type:"switch.failed",data:{switchId:failed.switchId,error:{code:"GATEWAY_AUTH_REQUIRED"},cleanup:clean}},{ type: "session.blocked", data: { switchId: failed.switchId } }] }));
  app.resume(state.id, { harnessId: "alpha" }, "recover"); await app.wait(state.id);
  const current = app.read(state.id); assert.equal(current.id, state.id); assert.equal(current.status, "open");
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
  const delta = JSON.parse((await peers[3]!.started.promise).split("\n").slice(1).join("\n")) as {history:{user:{text:string}}[]};
  assert.deepEqual(delta.history.map(row => row.user.text), ["third from bravo"]);
  assert.deepEqual(resumes, [undefined, "private-native-alpha", undefined, "private-native-alpha"]);
  const saved = app.read(session.id); assert.equal(saved.nativeBindings?.length, 2);
  await app.close(); f.store.close();
  const reopened = new SqliteSessionStore(join(f.root, "data")); f.stores.push(reopened);
  const next = runtime({ ...f, store: reopened }, factory, () => {}, "restart-");
  next.send(session.id, "after owner restart", "five"); await next.wait(session.id);
  assert.equal(await peers[4]!.started.promise, "after owner restart"); assert.equal(resumes.at(-1), "private-native-alpha");
  assert.equal(next.read(session.id).nativeBindings?.filter(binding => binding.status === "ready").length, 2);
  const epoch = next.read(session.id).epoch;
  assert.throws(() => next.resetNative(session.id, "bad-epoch", epoch - 1), /changed/);
  const branched = next.resetNative(session.id, "branch", epoch);
  assert.equal(branched.messages.length, saved.messages.length + 2); assert.equal(branched.nativeBindings?.[0]?.status, "archived");
  assert.deepEqual(next.resetNative(session.id, "branch", epoch), branched);
  assert.throws(() => reopened.transact(session.id, branched.version, current => ({next:{...current,nativeBindings:[]},events:[{type:"invalid.erase",data:{}}]})), /silently erased/);
});

test("uncertain native dispatch cannot be silently restored after public recovery", async t => {
  const f = await fixture(t), first = controlled({ holdResult: true }), factory = new ControlledFactory([first]);
  const prepare = factory.prepare.bind(factory);
  factory.prepare = async (...args) => { const binding = await prepare(...args); return { ...binding, control: { ...binding.control, checkpoint: async () => "private-native-alpha" } }; };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "first unknown", "one"); await first.started.promise;
  first.result.reject(new Error("external connection lost")); await assert.rejects(app.wait(session.id), /needs recovery/);
  assert.equal(app.read(session.id).nativeBindings?.[0]?.status, "unconfirmed");
  app.resume(session.id, { harnessId: "alpha" }, "resume", true); await app.wait(session.id);
  const count = factory.prepared.length;
  app.send(session.id, "must not create empty native state", "two"); await app.wait(session.id);
  assert.equal(factory.prepared.length, count); assert.equal(app.read(session.id).runs.at(-1)?.error?.code, "NATIVE_STATE_UNCONFIRMED");
  const state = app.read(session.id); app.resetNative(session.id, "explicit-branch", state.epoch);
  app.send(session.id, "explicit new native branch", "three"); await app.wait(session.id);
  assert.equal(app.read(session.id).nativeBindings?.[0]?.status, "archived");
  assert.equal(app.read(session.id).nativeBindings?.[1]?.status, "ready");
  assert.equal(app.read(session.id).runs[0]?.status, "unknown");
});

test("a question the Harness withdraws closes its public request and refuses a late answer", { timeout: 10000 }, async t => {
  const f = await fixture(t), peer = controlled({ holdResult: true }), factory = new ControlledFactory([peer]);
  const prepare = factory.prepare.bind(factory), asked = new Gate<void>(), withdrawn = new Gate<void>();
  let emit: ((event: ControlEvent) => void) | null = null;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, enablePermissions: () => {}, decidePermission: async () => { throw new SessionError("PERMISSION_UNAVAILABLE", "withdrawn"); },
      startText: async (id: NativeConversationId, text: string, output: (event: ControlEvent) => void) => { emit = output; const run = await binding.control.startText(id, text, output); output({ type: "permission_requested", id: "native-ui", title: "Timed native dialog", options: [{ id: "yes", name: "Yes" }] }); asked.resolve(); return run; } } };
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
  assert.equal(app.read(session.id).runs[0]?.status, "completed");
});

test("a long native turn beyond the public tool budget completes without blocking the Runtime", { timeout: 10000 }, async t => {
  const f = await fixture(t), peer = controlled(), factory = new ControlledFactory([peer]), prepare = factory.prepare.bind(factory);
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, startText: async (id: NativeConversationId, text: string, output: (event: ControlEvent) => void) => {
      for (let index = 0; index < 140; index++) output({ type: "tool", id: "tool-" + index, title: "step " + index, status: "completed" });
      return binding.control.startText(id, text, output);
    } } };
  };
  const app = runtime(f, factory), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(session.id, "many tools", "one"); await app.wait(session.id);
  const run = app.read(session.id).runs[0]!;
  assert.equal(run.status, "completed"); assert.equal(run.tools?.length, 128);
  app.send(session.id, "still usable", "two"); await app.wait(session.id); assert.equal(app.read(session.id).runs[1]?.status, "completed");
});

test("native activity becomes bounded public facts and tool detail content before the binding closes", { timeout: 10000 }, async t => {
  const f = await fixture(t), peer = controlled({ holdResult: true }), later = controlled({ holdResult: true }), factory = new ControlledFactory([peer, later]), prepare = factory.prepare.bind(factory);
  const content = new LocalContentStore(join(f.root, "data"), () => f.store.assertOwner());
  let emit: ((event: ControlEvent) => void) | null = null;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args);
    return { ...binding, control: { ...binding.control, startText: async (id: NativeConversationId, text: string, output: (event: ControlEvent) => void) => { emit = output; return binding.control.startText(id, text, output); } } };
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
  const run = app.read(session.id).runs[0]!;
  assert.equal(run.status, "completed");
  const shell = run.tools?.find(tool => tool.id === "shell"), edit = run.tools?.find(tool => tool.id === "edit");
  assert.deepEqual([shell?.kind, shell?.name, shell?.exitCode], ["execute", "Bash", 0]); assert.ok(shell?.detail);
  const stored = JSON.parse(await readFile(content.read(shell.detail.id).path, "utf8")) as Record<string, unknown>;
  assert.equal(stored.input, "ls"); assert.equal(stored.truncated, true); assert.equal(Buffer.byteLength(String(stored.output)), 64 * 1024);
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
  assert.deepEqual(app.read(session.id).runs[1]!.notices, [{ severity: "info", title: "new" }]);
  assert.equal(f.store.events(session.id, 0, 100).filter(row => row.type === "run.output" && JSON.stringify(row.data).includes('"title":"fallback"')).length, 3);
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
      startText: (id: NativeConversationId, text: string, output: (event: ControlEvent) => void, files?: readonly { name: string; path: string }[]) => { seen.files.push(...(files ?? []).map(file => ({ name: file.name, path: file.path }))); return binding.control.startText(id, text, output); } } };
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
  assert.equal(app.read(session.id).runs.length, 0);
  const receipt = app.send(session.id, "look", "send-1", [image.id]);
  assert.deepEqual(app.send(session.id, "look", "send-1", [image.id]), { ...receipt, replayed: true });
  assert.throws(() => app.send(session.id, "look", "send-1", []), (error: unknown) => error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT");
  await app.wait(session.id);
  let state = app.read(session.id);
  assert.deepEqual(state.runs[0]?.attachments, [image]); assert.equal(state.runs[0]?.status, "completed");
  assert.deepEqual(received[0]?.checked, [image.id]);
  assert.equal(received[0]?.files[0]?.name, "shot.png"); assert.deepEqual(await readFile(received[0]!.files[0]!.path), png);
  assert.ok(f.store.contentReferences().has(image.id), "admitted attachments are kept as long as the Session references them");
  // A refusal happens before dispatch: the input fails with the Driver's own message, the Session stays open and nothing is unknown.
  refuse = true;
  app.send(session.id, "again", "send-2", [image.id]); await app.wait(session.id);
  state = app.read(session.id);
  assert.equal(state.runs[1]?.status, "failed"); assert.deepEqual(state.runs[1]?.error, { code: "ATTACHMENT_UNSUPPORTED", message: "当前 Harness 或模型不接受图片附件：shot.png" });
  assert.equal(state.status, "open"); assert.equal(received[1]?.files.length, 0, "a refused input never reaches the Harness");
});

test("a branch quotes public history, forks the native session at its latest Turn, and falls back to public context otherwise", { timeout: 10000 }, async t => {
  const f = await fixture(t), peers = Array.from({ length: 8 }, () => controlled()), factory = new ControlledFactory(peers);
  const prepare = factory.prepare.bind(factory), opens: (string | undefined)[] = [], forks: string[] = [];
  let refuse = false;
  factory.prepare = async (...args) => {
    const binding = await prepare(...args), original = binding.control.open;
    return { ...binding, control: { ...binding.control,
      open: async (cwd, model, options, checkpoint) => { opens.push(checkpoint); return original(cwd, model, options, checkpoint); },
      checkpoint: async () => opens.at(-1) ?? "native-source",
      fork: async (checkpoint: string) => { forks.push(checkpoint); if (refuse) throw new SessionError("NATIVE_FORK_UNAVAILABLE", "refused"); return checkpoint + "-copy-" + forks.length; },
    } };
  };
  const app = runtime(f, factory), source = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  app.send(source.id, "first", "one"); await app.wait(source.id);
  app.send(source.id, "second", "two"); await app.wait(source.id);
  const runs = app.read(source.id).runs;
  // Native fork: the source binding is exactly at the latest Turn.
  const branch = app.fork(source.id, "branch-latest");
  assert.deepEqual(branch.origin?.history.map(row => [row.role, row.text]), [["user", "first"], ["assistant", "synthetic response"], ["user", "second"], ["assistant", "synthetic response"]]);
  assert.equal(branch.nativeBindings?.[0]?.status, "fork-pending"); assert.deepEqual(app.fork(source.id, "branch-latest"), branch, "the same command returns the same branch");
  await app.wait(branch.id);
  assert.deepEqual(forks, ["native-source"]);
  assert.deepEqual(app.read(branch.id).nativeBindings?.map(binding => [binding.checkpoint, binding.status]), [["native-source-copy-1", "ready"]]);
  app.send(branch.id, "branch question", "b-one"); await app.wait(branch.id);
  assert.equal(opens.at(-1), "native-source-copy-1", "the branch resumes its own native copy");
  // Each fork and each Turn prepares its own connection: peers 0–1 ran the source, 2 made the fork, 3 runs the branch.
  assert.equal(await peers[3]!.started.promise, "branch question", "a native branch receives only the new input");
  assert.equal(app.read(source.id).nativeBindings?.[0]?.checkpoint, "native-source", "the source keeps its own native session");
  // Public-only branch: an earlier Turn is not where the native session is.
  const early = app.fork(source.id, "branch-early", runs[0]!.id);
  assert.equal(early.nativeBindings, undefined); assert.deepEqual(early.origin?.history.map(row => row.text), ["first", "synthetic response"]);
  app.send(early.id, "early question", "e-one"); await app.wait(early.id);
  const context = JSON.parse((await peers[4]!.started.promise).split("\n").slice(1).join("\n")) as { branchedHistory: { role: string; text: string }[]; history: unknown[] };
  assert.deepEqual(context.branchedHistory.map(row => row.text), ["first", "synthetic response"]); assert.deepEqual(context.history, []);
  // A refused native fork archives the reference; the branch continues from public history.
  refuse = true;
  const refused = app.fork(source.id, "branch-refused"); await app.wait(refused.id);
  assert.deepEqual(app.read(refused.id).nativeBindings?.map(binding => binding.status), ["archived"]);
  assert.ok(f.store.events(refused.id, 0, 100).some(row => row.type === "native.fork_failed"));
  app.send(refused.id, "after refusal", "r-one"); await app.wait(refused.id);
  assert.equal(app.read(refused.id).runs[0]?.status, "completed"); assert.match(await peers[6]!.started.promise, /branchedHistory/u);
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
  assert.deepEqual(app.read(session.id).nativeBindings?.[0]?.observed, { model: null, options: { effort: "high" } });
  // The second Turn applies the native value; its own report is unreadable, so the configuration becomes unknown.
  app.send(session.id, "second", "two"); await app.wait(session.id);
  let state = app.read(session.id);
  assert.deepEqual(opened, [{ effort: "low" }, { effort: "high" }]); assert.equal(state.runs[1]?.status, "completed");
  assert.equal(state.nativeBindings?.[0]?.status, "ready"); assert.equal(state.nativeBindings?.[0]?.observed, undefined);
  // Unknown means the selection is applied as requested; an invalid report is unknown too.
  app.send(session.id, "third", "three"); await app.wait(session.id);
  state = app.read(session.id);
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
  const app = runtime(f, factory), imported = await app.importNative(f.configuration, { harnessId: "alpha" }, "native-a", "import-one");
  const origin = imported.origin!; assert.equal(origin.kind, "import"); if (origin.kind !== "import") return;
  // The newest 200 messages are quoted; the five older ones join the four the Harness already left out.
  assert.equal(origin.title, "Earlier work"); assert.equal(origin.history.length, 200); assert.equal(origin.omitted, 9); assert.equal(origin.complete, false);
  assert.deepEqual([origin.history[0]!.text, origin.history.at(-1)!.text, origin.history.at(-2)!.harnessId], ["message 5", "message 204", "alpha"]);
  assert.deepEqual(imported.nativeBindings, [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "private-native-a", throughRunId: null, status: "ready" }]);
  assert.equal((await app.importNative(f.configuration, { harnessId: "alpha" }, "native-a", "import-one")).id, imported.id); assert.equal(reads.length, 1, "a replayed command reads nothing");
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "native-b", "import-one"), (error: unknown) => error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "native-a", "import-two"), (error: unknown) => error instanceof SessionError && error.code === "NATIVE_SESSION_CONFLICT", "one native session has one conversation");
  app.send(imported.id, "continue please", "send-one"); await app.wait(imported.id);
  assert.equal(await peers[0]!.started.promise, "continue please", "the native session gets the input itself, not a public context");
  assert.deepEqual(opened, ["private-native-a"]); assert.equal(app.read(imported.id).runs[0]?.status, "completed");
  // A Harness that cannot read its history is continued without quoting any.
  (factory as SessionBindingFactory).readNativeSession = async () => ({ checkpoint: "private-native-c", title: null, history: [], omitted: 0, complete: false, historyRead: false });
  const unread = await app.importNative(f.configuration, { harnessId: "alpha" }, "native-c", "import-three");
  assert.deepEqual(unread.origin, { kind: "import", harnessId: "alpha", title: null, omitted: 0, complete: false, historyRead: false, history: [] });
  delete (factory as SessionBindingFactory).readNativeSession;
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "native-d", "import-four"), (error: unknown) => error instanceof SessionError && error.code === "NATIVE_SESSION_LIST_UNAVAILABLE");
  await assert.rejects(app.importNative(f.configuration, { harnessId: "alpha" }, "bad\nid", "import-five"), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
});
