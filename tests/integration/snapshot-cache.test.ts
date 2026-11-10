import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type HarnessControl } from "../../src/contracts/control.js";
import { SessionError, commandId, messageId, runId, sessionId, type EventDraft, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionSnapshot } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { MAX_EVENT_LOG_BYTES, parseSession, utf8Bytes } from "../../src/contexts/session/domain/state.js";
import { MAX_SNAPSHOT_CACHE_BYTES, SnapshotCache } from "../../src/infrastructure/session/snapshot-cache.js";
import { SqliteSessionReader, SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// G075-C02 and G075-C03 (ADR-055 §11.2): the Store's cache of validated snapshots by version, the event log size counted
// with each commit, and finished Runs that a commit keeps as they were, through a real SqliteSessionStore on a temporary
// data root (and the formal SessionRuntime with an in-process fake Harness for concurrent commits). Nothing runs a Harness.

const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const NOW = "2026-11-08T00:00:00.000Z";
/** A temporary directory removed after the test, once everything opened in it is closed, last opened first. */
const closers = new WeakMap<TestContext, (() => unknown)[]>();
function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "g075-snapshot-cache-")), owned: (() => unknown)[] = [];
  closers.set(t, owned);
  t.after(async () => {
    // A fault test may already have disabled what it opened.
    for (const close of owned.reverse()) { try { await close(); } catch { /* already disabled */ } }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function later(t: TestContext, close: () => unknown): void { closers.get(t)!.push(close); }
function code(expected: string): (error: unknown) => boolean { return error => error instanceof SessionError && error.code === expected; }
function draft(type = "session.created", data: Readonly<Record<string, unknown>> = {}): readonly EventDraft[] { return [{ type, data }]; }
function initial(root: string, suffix = "one"): SessionSnapshot {
  const id = sessionId("session-" + suffix);
  return { schemaVersion: 13, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
    configuration: { workspace: root, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: false },
    selection: { harnessId: "fixture", controlId: "fixture-acp" }, activeRunId: null, pendingSwitchId: null,
    runs: [], messages: [], switches: [], commands: [{ id: commandId("create-" + suffix), kind: "create", fingerprint: "a".repeat(64), resultId: id }] };
}
function open(t: TestContext, root: string, options: { readonly snapshotCacheBytes?: number } = {}): SqliteSessionStore {
  const store = new SqliteSessionStore(root, { now: () => new Date(NOW), ...options });
  later(t, () => store.close()); return store;
}
function outsider(t: TestContext, root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, "gateway.sqlite"), { timeout: 0 });
  later(t, () => { if (db.isOpen) db.close(); }); return db;
}
/** Three finished Turns (completed, failed, cancelled) and one queued input, committed by one transaction. */
function finished(store: SqliteSessionStore, root: string, suffix = "one"): SessionSnapshot {
  const created = store.create(initial(root, suffix), draft());
  const ending: readonly { readonly status: PublicRun["status"]; readonly backend: BackendResult | null; readonly error: PublicRun["error"]; readonly cancelRequested: boolean }[] = [
    { status: "completed", backend: { status: "completed", reason: "fixture" }, error: null, cancelRequested: false },
    { status: "failed", backend: { status: "failed", reason: "fixture", error: { code: "FIXTURE_FAILED", message: "it failed" } }, error: { code: "FIXTURE_FAILED", message: "it failed" }, cancelRequested: false },
    { status: "cancelled", backend: { status: "cancelled", reason: "fixture" }, error: null, cancelRequested: true },
    { status: "queued", backend: null, error: null, cancelRequested: false },
  ];
  return store.transact(created.session.id, created.session.version, current => {
    const runs: PublicRun[] = [], messages: SessionSnapshot["messages"][number][] = [], commands = [...current.commands];
    ending.forEach((end, index) => {
      const id = runId("run-" + index), user = messageId("message-user-" + index), assistant = messageId("message-reply-" + index), queued = end.status === "queued";
      runs.push({ id, commandId: commandId("send-" + index), input: "第 " + index + " 个输入", userMessageId: user, assistantMessageId: assistant, selection: current.selection, epoch: 1,
        status: end.status, cancelRequested: end.cancelRequested, contextThroughSeq: queued ? 0 : current.lastSeq + messages.length, sourceRunIds: [], backend: end.backend,
        cleanup: queued ? null : clean, error: end.error, stopRequested: false, awaitingSwitchId: null, ...(queued ? {} : { thinking: "想".repeat(64), tools: [{ id: "tool-" + index, title: "Read file", status: "completed" }] }) });
      messages.push({ id: user, runId: id, role: "user", text: "第 " + index + " 个输入", seq: current.lastSeq + messages.length + 1, status: end.status });
      if (!queued) messages.push({ id: assistant, runId: id, role: "assistant", text: "第 " + index + " 个回复", seq: current.lastSeq + messages.length + 1, status: end.status });
      commands.push({ id: commandId("send-" + index), kind: "send", fingerprint: "b".repeat(64), resultId: id });
    });
    return { next: { ...current, runs, messages, commands }, events: messages.map(message => ({ type: "message.recorded", data: { messageId: message.id } })) };
  }).session;
}
/** Commits only an event; the snapshot changes by its version and cursor alone. */
function touch(store: SqliteSessionStore, id: SessionSnapshot["id"], type = "test.touched"): SessionSnapshot {
  return store.transact(id, store.get(id).version, current => ({ next: current, events: draft(type) })).session;
}

test("G075-C02 a committed snapshot is served by version, and any other version, even one this connection wrote, misses", t => {
  const root = directory(t), store = open(t, root), created = store.create(initial(root), draft()), id = created.session.id;
  assert.ok(Object.isFrozen(created.session) && Object.isFrozen(created.session.commands[0]), "a committed snapshot is deeply frozen before it is shared");
  const start = store.cacheStats();
  assert.equal(store.get(id), created.session, "the version just committed is served as it was committed");
  assert.equal(store.cacheStats().hits, start.hits + 1); assert.equal(store.cacheStats().misses, start.misses);
  const second = touch(store, id);
  assert.equal(second.version, 2); assert.equal(store.get(id), second); assert.notEqual(store.get(id), created.session);
  // A write that went past the cache on the same connection (PRAGMA data_version stays) is found by its version alone.
  const own: unknown = Reflect.get(store, "database"); assert.ok(own instanceof DatabaseSync);
  own.prepare("UPDATE sessions SET version=version+1,snapshot=json_set(snapshot,'$.version',version+1) WHERE id=?").run(id);
  const before = store.cacheStats(), reread = store.get(id);
  assert.equal(reread.version, 3); assert.notEqual(reread, second); assert.deepEqual({ ...reread, version: 2 }, { ...second });
  assert.equal(store.cacheStats().misses, before.misses + 1, "the stale version was read and validated again");
  assert.equal(store.get(id), reread, "and the version read again is what is served next");
  // The cache itself: a lookup for any other version than the cached one misses and drops it.
  const cache = new SnapshotCache(1024 * 1024);
  cache.put(second, 1000);
  assert.equal(cache.get(id, 2, second.lastSeq), second);
  assert.equal(cache.get(id, 3, second.lastSeq), undefined); assert.equal(cache.stats().entries, 0);
  assert.equal(cache.get(id, 2, second.lastSeq), undefined, "an older version is gone too");
  cache.put(second, 1000); assert.equal(cache.get(id, 2, second.lastSeq + 1), undefined, "the event cursor is part of the version");
});

test("G075-C02 another connection's commit drops the cache even when it keeps the version, and corruption is still found", t => {
  const root = directory(t), store = open(t, root), created = store.create(initial(root), draft()), id = created.session.id, db = outsider(t, root);
  assert.equal(store.get(id), created.session);
  db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.selection.harnessId','other') WHERE id=?").run(id);
  const changed = store.get(id);
  assert.equal(changed.version, created.session.version); assert.equal(changed.selection.harnessId, "other", "the stored snapshot, not the cached one");
  assert.equal(store.cacheStats().entries, 1);
  db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.epoch',0) WHERE id=?").run(id);
  assert.throws(() => store.get(id), code("INVALID_DATA"));
  db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.epoch',1) WHERE id=?").run(id);
  assert.equal(store.get(id).epoch, 1);
  db.exec("DELETE FROM events");
  assert.throws(() => store.get(id), code("INVALID_DATA"), "a missing event under a cached snapshot is found");
});

test("G075-C02 a transaction reads only committed state: never an older snapshot, nor one a rolled-back transaction wrote", t => {
  const root = directory(t), store = open(t, root), created = store.create(initial(root), draft()), id = created.session.id;
  // Two operations that read the same version: the second to commit is refused before its mutation sees anything.
  const stale = store.get(id), first = touch(store, id, "test.first");
  let ran = false;
  assert.throws(() => store.transact(id, stale.version, current => { ran = true; return { next: current, events: draft("test.stale") }; }), code("VERSION_CONFLICT"));
  assert.equal(ran, false, "the refused mutation never saw a snapshot");
  // Inside a transaction the Store reads the committed state the mutation got, not the older one nor the one being written.
  let inside: SessionSnapshot | null = null, given: SessionSnapshot | null = null;
  const second = store.transact(id, first.version, current => { given = current; inside = store.get(id); return { next: { ...current, retainNative: true }, events: draft("test.second") }; }).session;
  assert.equal(inside, given); assert.equal(given, first); assert.equal(store.get(id), second); assert.equal(second.retainNative, true);
  // Refused after the snapshot was written in the transaction (the event log is full): the committed version stays served.
  const full = { type: "test.big", data: { text: "x".repeat(2_000_000) } };
  const filled = store.transact(id, second.version, current => ({ next: current, events: Array.from({ length: 16 }, () => full) })).session;
  const hits = store.cacheStats().hits;
  for (const refused of [
    () => store.transact(id, filled.version, current => ({ next: { ...current, status: "blocked" }, events: [full] })),
    () => store.transact(id, filled.version, current => ({ next: { ...current, epoch: 0 }, events: draft("test.invalid") })),
    () => store.transact(id, filled.version, () => { throw new SessionError("FIXTURE_REFUSED", "the mutation itself failed"); }),
  ]) assert.throws(refused, (error: unknown) => error instanceof SessionError && ["EVENT_LIMIT", "INVALID_DATA", "FIXTURE_REFUSED"].includes(error.code));
  assert.equal(store.get(id), filled, "the committed snapshot, served from the cache"); assert.equal(store.get(id).status, "open");
  assert.ok(store.cacheStats().hits >= hits + 4, "refused transactions left the committed entry in place");
  let current: SessionSnapshot | null = null;
  store.transact(id, filled.version, state => { current = state; return { next: state, events: draft("test.after") }; }).session;
  assert.equal(current, filled, "the next transaction starts from the committed snapshot");
  // A storage failure disables the Store and drops everything cached.
  const db = outsider(t, root); db.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected event failure'); END");
  assert.throws(() => store.transact(id, filled.version + 1, state => ({ next: state, events: draft("test.refused") })), code("STORAGE_UNAVAILABLE"));
  assert.equal(store.cacheStats().entries, 0); assert.throws(() => store.get(id), code("STORAGE_UNAVAILABLE"));
});

/** A Harness that holds each prompt until the test lets it end, and resumes its native session. */
class HeldHarness implements SessionBindingFactory {
  readonly prompts: string[] = [];
  private readonly waiting: ((result: BackendResult) => void)[] = [];
  private notify: (() => void) | null = null;
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" }; }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    let opened = false;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "held", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-" + selected.harnessId); },
      checkpoint: async () => opened ? "private-native-" + selected.harnessId : null,
      startText: async (_id, turn, output) => {
        const text = singleText(turn);
        this.prompts.push(text); output({ type: "text", text: "reply to " + text });
        const result = new Promise<BackendResult>(resolve => { this.waiting.push(resolve); }); this.notify?.();
        return { result, requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  async held(): Promise<void> { while (this.waiting.length === 0) await new Promise<void>(resolve => { this.notify = resolve; }); this.notify = null; }
  release(): void { this.waiting.shift()?.({ status: "completed", reason: "held", input: "recorded" }); }
}
/** Waits until the Harness holds a prompt; fails at once when the conversation's work ends without one reaching it. */
async function reached(app: SessionRuntime, harness: HeldHarness, id: SessionSnapshot["id"]): Promise<void> {
  let held = false;
  const ended = app.wait(id).then(() => { if (!held) throw new Error("the conversation's work ended before an input reached the Harness"); });
  ended.catch(() => {});
  await Promise.race([harness.held().then(() => { held = true; }), ended]);
}
function events(store: SqliteSessionStore, id: SessionSnapshot["id"]): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}

test("G075-C02 the Runtime's concurrent commits and a commit made past it through the Store never build on an older snapshot", { timeout: 60_000 }, async t => {
  const root = directory(t), data = join(root, "data"), workspace = join(root, "workspace"); mkdirSync(workspace);
  const store = open(t, data), harness = new HeldHarness();
  let next = 0, outside = 0;
  const app = new SessionRuntime(store, harness, { id: () => String(++next), now: () => new Date(NOW), fingerprint: value => createHash("sha256").update(value).digest("hex"),
    // Right after run.authorized is committed and before run.dispatched, a commit goes past the Runtime (ADR-055 §11.2): the
    // Runtime's next commit then names a version that is no longer current, and must read the Session again. (run.context_prepared
    // and run.authorized are one transaction since G068 phase two, ADR-055 §6.1, so nothing can come between them.)
    publish: event => { if (event.type === "run.authorized") { outside += 1; touch(store, event.sessionId, "test.outside"); } } });
  later(t, () => app.close());
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const session = await app.create(configuration, { harnessId: "alpha" }, "create");
  const first = app.send(session.id, "first", "send-first");
  await reached(app, harness, session.id);
  // While the first Turn runs, a second input is accepted: its commit lands between the running Turn's commits.
  const second = app.send(session.id, "second", "send-second");
  harness.release(); await reached(app, harness, session.id); harness.release();
  await app.wait(session.id);
  const state = store.get(session.id), log = events(store, session.id);
  assert.deepEqual(state.runs.map(run => [run.id, run.status]), [[first.runId, "completed"], [second.runId, "completed"]]);
  // The first input started the native session and carried the conversation's public context; the second went as typed.
  assert.equal(harness.prompts.length, 2); assert.match(harness.prompts[0]!, /first/u); assert.equal(harness.prompts[1], "second"); assert.equal(outside, 2);
  assert.deepEqual(log.map(row => row.seq), log.map((_, index) => index + 1)); assert.equal(state.lastSeq, log.length);
  for (const run of [first.runId, second.runId]) {
    const order = log.filter(row => row.data.runId === run || row.type === "test.outside").map(row => row.type), prepared = order.indexOf("run.context_prepared");
    assert.deepEqual(order.slice(prepared, prepared + 4), ["run.context_prepared", "run.authorized", "test.outside", "run.dispatched"], "the Runtime committed after the outside commit, on top of it");
  }
  // What the Store serves is what is stored: a reader without a cache reads the same snapshot and events.
  assert.ok(log.length < 100);
  const reader = new SqliteSessionReader(data);
  try { assert.deepEqual(reader.get(session.id), state); assert.deepEqual(reader.events(session.id, 0, 100), log); } finally { reader.close(); }
});

test("G075-C02 the cache has its Store as owner, a byte budget of at most 96 MiB, and lists do not fill it", t => {
  const root = directory(t), missing = join(root, "never-created");
  assert.throws(() => new SnapshotCache(MAX_SNAPSHOT_CACHE_BYTES + 1), code("INVALID_INPUT"));
  for (const bad of [-1, 1.5, Number.NaN, MAX_SNAPSHOT_CACHE_BYTES + 1]) assert.throws(() => new SqliteSessionStore(missing, { snapshotCacheBytes: bad }), code("INVALID_INPUT"));
  assert.equal(existsSync(missing), false, "an invalid budget is refused before the data root is touched");
  assert.equal(new SnapshotCache().maxBytes, 96 * 1024 * 1024);
  // A budget for about two of these snapshots: the least recently used goes first.
  const small = join(root, "small"), probe = open(t, join(root, "probe")), size = utf8Bytes(JSON.stringify(finished(probe, root)));
  const store = open(t, small, { snapshotCacheBytes: Math.floor(size * 2.5) });
  const one = finished(store, root, "one"), two = finished(store, root, "two");
  assert.equal(store.get(one.id), one); assert.equal(store.cacheStats().entries, 2);
  const three = finished(store, root, "three"), stats = store.cacheStats();
  assert.equal(stats.entries, 2); assert.equal(stats.evictions, 1); assert.ok(stats.bytes <= stats.maxBytes);
  assert.equal(store.get(one.id), one, "the one read last stayed"); assert.equal(store.get(three.id), three);
  const misses = store.cacheStats().misses, again = store.get(two.id);
  assert.notEqual(again, two); assert.deepEqual(again, two); assert.equal(store.cacheStats().misses, misses + 1, "the evicted one is read and validated again");
  // Lists and scans use what is cached but do not cache what they read, so they never push out the conversations in use.
  const lister = open(t, join(root, "lister")), listed = [finished(lister, root, "a"), finished(lister, root, "b")].map(state => state.id).sort();
  lister.close();
  const fresh = open(t, join(root, "lister"));
  assert.deepEqual(fresh.list().map(state => state.id).sort(), listed); assert.deepEqual(fresh.listKept(), []);
  assert.equal(fresh.cacheStats().entries, 0); assert.equal(fresh.cacheStats().misses, 2);
  assert.deepEqual(fresh.get(listed[0]!).id, listed[0]); assert.equal(fresh.cacheStats().entries, 1, "an ordinary read caches");
  // A budget below one snapshot keeps none, and 0 turns the cache off; reads stay correct.
  for (const budget of [100, 0]) {
    const tiny = open(t, join(root, "tiny-" + budget), { snapshotCacheBytes: budget }), state = finished(tiny, root);
    assert.deepEqual(tiny.get(state.id), state); assert.notEqual(tiny.get(state.id), state); assert.equal(tiny.cacheStats().entries, 0);
  }
  // Only frozen snapshots are shared; after close the cache holds nothing and keeps nothing, and so does its Store's.
  const cache = new SnapshotCache(1024 * 1024);
  assert.throws(() => cache.put({ ...one }, 10), code("INVALID_INPUT"));
  assert.throws(() => cache.put(one, 0), code("INVALID_INPUT"));
  cache.put(one, 10); cache.close();
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, maxBytes: 1024 * 1024, hits: 0, misses: 0, evictions: 0 });
  cache.put(one, 10); assert.equal(cache.get(one.id, one.version, one.lastSeq), undefined); assert.equal(cache.stats().misses, 0);
  store.close(); assert.equal(store.cacheStats().entries, 0); assert.equal(store.cacheStats().bytes, 0);
});

test("G075-C02 the event log size counted with each commit is SQLite's own sum and holds the 32 MiB limit to the byte", t => {
  const root = directory(t), store = open(t, root), created = store.create(initial(root), draft()), id = created.session.id, db = outsider(t, root);
  const stored = () => Number(db.prepare("SELECT SUM(length(CAST(event_json AS BLOB))) AS bytes FROM events WHERE session_id=?").get(id)?.bytes);
  // The bytes SQLite will store for an event at `seq`: its JSON with identity, cursor, owner and the fixed clock's time.
  const size = (seq: number, text: string) => utf8Bytes(JSON.stringify({ type: "test.fill", data: { text }, sessionId: id, seq, ownerGeneration: store.ownerGeneration, timestamp: NOW }));
  // Multibyte text, so the count is of UTF-8 bytes: three for 汉, four for the emoji's surrogate pair.
  const prefix = "汉字🙂", padded = (seq: number, bytes: number) => prefix + "x".repeat(bytes - size(seq, prefix));
  let state = store.transact(id, created.session.version, current => ({ next: current, events: Array.from({ length: 16 }, () => ({ type: "test.fill", data: { text: prefix + "x".repeat(2_000_000) } })) })).session;
  const remaining = MAX_EVENT_LOG_BYTES - stored();
  assert.ok(remaining > 1000 && remaining < 2 * 1024 * 1024, "the last event fits within one event's budget: " + remaining);
  const seq = state.lastSeq + 1;
  assert.throws(() => store.transact(id, state.version, current => ({ next: current, events: [{ type: "test.fill", data: { text: padded(seq, remaining + 1) } }] })), code("EVENT_LIMIT"));
  assert.equal(stored(), MAX_EVENT_LOG_BYTES - remaining, "the refused event left the log and its count as they were");
  state = store.transact(id, state.version, current => ({ next: current, events: [{ type: "test.fill", data: { text: padded(seq, remaining) } }] })).session;
  assert.equal(stored(), MAX_EVENT_LOG_BYTES, "exactly at the limit");
  assert.throws(() => store.transact(id, state.version, current => ({ next: current, events: draft("test.one-more") })), code("EVENT_LIMIT"));
  // A new owner counts the log in SQLite once and holds the same boundary.
  store.close();
  const reopened = open(t, root);
  assert.throws(() => reopened.transact(id, state.version, current => ({ next: current, events: draft("test.one-more") })), code("EVENT_LIMIT"));
  assert.equal(stored(), MAX_EVENT_LOG_BYTES);
});

test("G075-C03 finished Runs a commit keeps as they were are not parsed again, and every invalid transition is still refused", t => {
  const root = directory(t), store = open(t, root), base = finished(store, root), id = base.id, terminal = [0, 1, 2] as const;
  // Kept by identity: the committed snapshot holds the very objects, which only happens on the skipping path.
  let given: SessionSnapshot | null = null;
  const kept = store.transact(id, base.version, current => { given = current; return { next: current, events: draft("test.kept") }; }).session;
  for (const index of terminal) assert.equal(kept.runs[index], given!.runs[index], "finished Run " + index + " was kept as the same object");
  const reads = store.get(id);
  assert.equal(reads, kept);
  const refusals: readonly [string, string, (current: SessionSnapshot) => SessionSnapshot][] = [
    ["finished Run evidence rewritten in a copy", "INVALID_TRANSITION", current => ({ ...current, runs: current.runs.map((run, index) => index === 0 ? { ...run, backend: { status: "completed", reason: "rewritten" } } : run) })],
    ["the same rewrite, frozen like a kept Run", "INVALID_TRANSITION", current => ({ ...current, runs: current.runs.map((run, index) => index === 1 ? Object.freeze({ ...run, error: { code: "OTHER", message: "rewritten" } }) : run) })],
    ["a finished Run's status reopened", "INVALID_TRANSITION", current => ({ ...current, activeRunId: current.runs[2]!.id, runs: current.runs.map((run, index) => index === 2 ? { ...run, status: "running" as const, backend: null, cleanup: null } : run),
      messages: current.messages.map(message => message.runId === current.runs[2]!.id ? { ...message, status: "running" as const } : message) })],
    ["kept Runs swapped in place", "INVALID_TRANSITION", current => ({ ...current, runs: [current.runs[1]!, current.runs[0]!, ...current.runs.slice(2)] })],
    ["a kept Run removed with its messages and command", "INVALID_TRANSITION", current => ({ ...current, runs: current.runs.slice(1), messages: current.messages.filter(message => message.runId !== current.runs[0]!.id),
      commands: current.commands.filter(command => command.resultId !== current.runs[0]!.id) })],
    ["a kept Run appended a second time", "INVALID_DATA", current => ({ ...current, runs: [...current.runs, current.runs[0]!] })],
    ["a kept Run whose reply was rewritten", "INVALID_TRANSITION", current => ({ ...current, messages: current.messages.map(message => message.id === current.runs[0]!.assistantMessageId ? { ...message, text: "另一个回复" } : message) })],
    ["a kept Run whose input was rewritten", "INVALID_TRANSITION", current => ({ ...current, runs: current.runs.map((run, index) => index === 1 ? { ...run, input: "改过的输入" } : run),
      messages: current.messages.map(message => message.id === current.runs[1]!.userMessageId ? { ...message, text: "改过的输入" } : message) })],
    ["a kept Run whose send command was rewritten", "INVALID_TRANSITION", current => ({ ...current, commands: current.commands.map(command => command.resultId === current.runs[0]!.id ? { ...command, fingerprint: "c".repeat(64) } : command) })],
    ["a kept Run whose send command now names another Run", "INVALID_DATA", current => ({ ...current, commands: current.commands.map(command => command.resultId === current.runs[0]!.id ? { ...command, resultId: current.runs[1]!.id } : command) })],
    ["kept Runs under a selection changed without a switch", "INVALID_TRANSITION", current => ({ ...current, selection: { harnessId: "other", controlId: "other-acp" } })],
  ];
  for (const [label, expected, rewrite] of refusals) {
    assert.throws(() => store.transact(id, kept.version, current => ({ next: rewrite(current), events: draft("test.refused") })), code(expected), label);
    assert.equal(store.get(id), kept, label + ": nothing was committed or cached");
  }
  // parseSession takes a Run as it is only when it is the very object it validated and froze in `before`.
  const frozen = (value: unknown): void => { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } };
  const bogus = { ...kept.runs[0]!, tools: [{ id: "tool-0", title: "", status: "completed" }] }; frozen(bogus);
  const forged = { ...kept, runs: [bogus, ...kept.runs.slice(1)] }; frozen(forged);
  assert.throws(() => parseSession({ ...forged, version: kept.version + 1 }, forged), code("INVALID_DATA"), "a frozen Run parseSession never validated is parsed in full");
  const copy = parseSession(JSON.parse(JSON.stringify(kept)));
  assert.notEqual(parseSession({ ...copy }, copy).runs[0], copy.runs[0], "an unfrozen `before` is not taken as validated");
  assert.equal(parseSession({ ...kept }, kept).runs[0], kept.runs[0]);
  assert.notEqual(parseSession({ ...kept, runs: [kept.runs[1]!, kept.runs[0]!, ...kept.runs.slice(2)] }, kept).runs[0], kept.runs[1], "a Run at another position is parsed in full");
  assert.notEqual(parseSession({ ...kept }, kept).runs[3], kept.runs[3], "an unfinished Run is parsed in full");
});

test("G075-C02 a lost owner drops its cached snapshots at once instead of holding them until close", t => {
  const root = directory(t), store = open(t, root), created = store.create(initial(root), draft());
  assert.equal(store.get(created.session.id), created.session); assert.ok(store.cacheStats().entries > 0, "the committed snapshot is cached");
  // Another owner taking the data directory over is seen as a changed owner record.
  renameSync(join(root, ".harness-gateway.json"), join(root, ".harness-gateway.json.moved"));
  assert.throws(() => store.get(created.session.id), (error: unknown) => error instanceof SessionError && error.code === "OWNER_LOST");
  assert.equal(store.cacheStats().entries, 0, "nothing stays cached for an owner that can no longer read");
});
