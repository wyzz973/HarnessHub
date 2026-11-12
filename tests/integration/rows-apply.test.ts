import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Conversation, ConversationRun, Mutation } from "../../src/contracts/conversation.js";
import type { ContentRef } from "../../src/contracts/content.js";
import { SessionError, switchId, type NativeSessionBinding, type PublicSwitch } from "../../src/contracts/session.js";
import { applyMutation } from "../../src/infrastructure/session/apply.js";
import { diffConversation, settleConversation } from "../../src/infrastructure/session/diff.js";
import { loadConversation, loadItems, WHOLE } from "../../src/infrastructure/session/load.js";
import { bindingRowOf, runRowOf } from "../../src/infrastructure/session/rows.js";
import {
  NOW, SESSION, STAMP, bytes, commit, conversation, conversionMutation, counts, event, item, openDatabase, reduce, replaceRun, replyItem, run, sendCommand, seedConverted, switchCommand, toolItem, userItem, type Env,
} from "../fixtures/conversation-builder.js";

// The first line of work of ADR-057 (T2): a Mutation made by comparing two conversations, written to a real database, read back. The Harness
// and the model are made up; the rows, the keys and the triggers are SQLite's. Every case reads the conversation back from the tables and
// compares it with the one the commit returned.

const same = (env: Env, expected: Conversation): void => assert.deepEqual(loadConversation(env.db, SESSION), expected);
const running = (ordinal: number, items: ConversationRun["items"], extra: Partial<ConversationRun> = {}): ConversationRun =>
  run(ordinal, "running", items, { timing: { acceptedAt: NOW, preparingAt: NOW + 1, readyAt: NOW + 2, dispatchedAt: NOW + 3 }, ...extra });
const oneRun = (current: Conversation): ConversationRun => current.runs[0]!;
/** The conversation with the first Run's items changed. */
const withItems = (state: Conversation, change: (items: NonNullable<ConversationRun["items"]>) => NonNullable<ConversationRun["items"]>, ordinal = 0): Conversation =>
  reduce(state, current => ({ runs: replaceRun(current, ordinal, entry => ({ ...entry, items: change(entry.items!) })) }));
const completedBackend = { backend: { status: "completed" as const, reason: "done" }, cleanup: { closed: true as const, exitCode: 0, signal: null, protocolFailure: null } };
const rows = (env: Env, sql: string): Record<string, unknown>[] => env.db.prepare(sql).all().map(row => ({ ...row }));

/** A conversation with one Run that is queued, accepted by event `message.accepted` (seq 2). */
function queuedConversation(env: Env, text = "Hello"): Conversation {
  const created = commit(env, null, conversation(), [event("session.created")]).conversation;
  return commit(env, created, reduce(created, current => ({ runs: [run(0, "queued", [userItem("run-0", text)])], commands: [...current.commands, sendCommand(0)] })), [event("message.accepted", { runId: "run-0" })]).conversation;
}
/** The Run started: running, active, with the timing of a started Run. */
function runningConversation(env: Env, state: Conversation, items?: ConversationRun["items"]): Conversation {
  return commit(env, state, reduce(state, current => ({ activeRunId: oneRun(current).id, runs: replaceRun(current, 0, entry => ({ ...entry, ...running(0, items ?? entry.items!) })) })), [event("run.started", { runId: "run-0" })]).conversation;
}

test("a Turn from its first word to its last: every commit reads back as the conversation it committed", t => {
  const env = openDatabase(t);
  // Create: the conversation and its create command, with one event.
  let state = commit(env, null, conversation(), [event("session.created")]).conversation;
  assert.equal(state.version, 1); assert.equal(state.lastSeq, 1);
  same(env, state);

  // Send: a Run is queued with its user item; the input's seq and the item's are the seq of the `message.accepted` event.
  state = commit(env, state, reduce(state, current => ({ runs: [run(0, "queued", [userItem("run-0", "Hello 你好 👋")])], commands: [...current.commands, sendCommand(0)] })), [event("message.accepted", { runId: "run-0" })]).conversation;
  assert.equal(oneRun(state).userSeq, 2); assert.equal(oneRun(state).items![0]!.createdSeq, 2);
  same(env, state);

  // The Run starts: running, and the head names it as the active one.
  state = runningConversation(env, state);
  same(env, state);

  // A reply segment opens with its first window of text and grows by a window; a tool call goes pending, running, completed.
  state = commit(env, state, withItems(state, items => [...items, replyItem("run-0", 2, 1, "running", ["Looking at "])]), [event("run.output", { runId: "run-0" })]).conversation;
  assert.equal(oneRun(state).items![1]!.createdSeq, 4);
  state = commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "the 文件 now."] } : it)), [event("run.output", { runId: "run-0" })]).conversation;
  assert.equal(oneRun(state).items![1]!.textBytes, bytes("Looking at the 文件 now.")); assert.equal(oneRun(state).items![1]!.textChunks, 2);
  same(env, state);
  for (const status of ["pending", "running", "completed"] as const) {
    state = commit(env, state, withItems(state, items => [...items.filter(it => it.seq !== 3), toolItem("run-0", 3, "t1", status, status === "completed" ? { exitCode: 0 } : {})]), [event("run.output", { runId: "run-0", status })]).conversation;
    same(env, state);
  }

  // An approval asks; the user decides: the same row changes, and the decision is in its fields.
  const waiting = item("run-0", 4, "permission:p1", "approval", "waiting", { subject: "command", title: "Run it?", options: [{ id: "once", role: "allow_once", label: "Allow" }] });
  state = commit(env, state, withItems(state, items => [...items, waiting]), [event("run.permission_requested", { runId: "run-0" })]).conversation;
  state = commit(env, state, withItems(state, items => items.map(it => it.seq === 4 ? { ...it, status: "completed", fields: { ...it.fields, decision: { role: "allow_once", by: "user", at: NOW + 9 } } as typeof it.fields } : it)), [event("run.permission_decided", { runId: "run-0" })]).conversation;
  same(env, state);

  // The end: the open segment is closed first, then the Run becomes terminal and the head names no active Run. The Run's items leave memory and stay in the tables.
  state = commit(env, state, reduce(state, current => ({ activeRunId: null, runs: replaceRun(current, 0, entry => ({ ...entry, status: "completed", ...completedBackend, timing: { ...entry.timing!, endedAt: NOW + 50 },
    items: entry.items!.map(it => it.seq === 2 ? { ...it, status: "completed" } : it) })) })), [event("run.ended", { runId: "run-0", status: "completed" })]).conversation;
  same(env, state);
  assert.equal(oneRun(state).items, undefined); assert.equal(oneRun(state).endedSeq, 11);
  assert.deepEqual(loadItems(env.db, "run-0", WHOLE).map(it => [it.seq, it.itemId, it.status, it.text.join("")]), [
    [1, "user", "completed", "Hello 你好 👋"], [2, "text:1", "completed", "Looking at the 文件 now."], [3, "tool:t1", "completed", ""], [4, "permission:p1", "completed", ""]]);
  // The log: one event per seq, the generation and the time of the owner that wrote it.
  assert.deepEqual(rows(env, "SELECT seq, owner_generation AS generation, json_extract(event_json,'$.type') AS type, json_extract(event_json,'$.timestamp') AS stamp, json_extract(event_json,'$.sessionId') AS session FROM events ORDER BY seq"),
    ["session.created", "message.accepted", "run.started", "run.output", "run.output", "run.output", "run.output", "run.output", "run.permission_requested", "run.permission_decided", "run.ended"]
      .map((type, index) => ({ seq: index + 1, generation: 1, type, stamp: STAMP, session: SESSION })));
  assert.equal(counts(env, "sessions", "version=" + state.version + " AND last_seq=" + state.lastSeq), 1);
});

test("a window of text commits only its chunk and the head: nothing else of the Turn is written, whatever its history", t => {
  const env = openDatabase(t);
  let state = runningConversation(env, queuedConversation(env));
  state = commit(env, state, withItems(state, items => [...items, replyItem("run-0", 2, 1, "running", ["one "])]), [event("run.output")]).conversation;
  const next = withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "two 二 "] } : it));
  const { mutation, applied, conversation: after } = commit(env, state, next, [event("run.output")]);
  assert.deepEqual(Object.keys(mutation).sort(), ["events", "head", "text"]);
  assert.deepEqual(mutation.text, [{ runId: "run-0", itemSeq: 2, chunk: 1, text: "two 二 ", byteOffset: 4 }]);
  assert.deepEqual(applied.changes.text, mutation.text);
  assert.equal(applied.changes.head!.row.version, after.version);
  same(env, after);
  // Text read back chunk by chunk, each where the one before ended.
  assert.deepEqual(rows(env, "SELECT chunk, byte_offset AS offset, bytes, text FROM item_text WHERE item_seq=2 ORDER BY chunk"), [{ chunk: 0, offset: 0, bytes: 4, text: "one " }, { chunk: 1, offset: 4, bytes: bytes("two 二 "), text: "two 二 " }]);
});

test("a Run cancelled while it waits, a Run stopped while it works: the open items close as the Run's end says, the end's seq is the event's", t => {
  const env = openDatabase(t);
  // Two inputs: the first runs, the second queues behind it.
  let state = queuedConversation(env);
  state = commit(env, state, reduce(state, current => ({ runs: [...current.runs, run(1, "queued", [userItem("run-1", "Second")])], commands: [...current.commands, sendCommand(1)] })), [event("message.accepted", { runId: "run-1" })]).conversation;
  assert.equal(state.runs[1]!.userSeq, 3);
  state = runningConversation(env, state);
  state = commit(env, state, withItems(state, items => [...items, toolItem("run-0", 2, "t1", "running"), item("run-0", 3, "permission:p", "approval", "waiting", { subject: "other", title: "?", options: [] })]), [event("run.output")]).conversation;
  // The user cancels the queued input and asks to stop the active Run: the queued one ends cancelled, the active one records the request.
  state = commit(env, state, reduce(state, current => ({ runs: current.runs.map(entry => entry.ordinal === 1 ? { ...entry, status: "cancelled" as const, cancelRequested: true, error: { code: "CANCELLED", message: "the user cancelled it" } } : { ...entry, cancelRequested: true }) })),
    [event("run.ended", { runId: "run-1", status: "cancelled" }), event("run.cancel_requested", { runId: "run-0" })]).conversation;
  assert.equal(state.runs[1]!.endedSeq, state.lastSeq - 1); assert.equal(state.runs[1]!.items, undefined);
  same(env, state);
  // The active Run ends cancelled: its running tool is cancelled (it was not known to finish), the waiting approval is cancelled too; the Run follows its items.
  state = commit(env, state, reduce(state, current => ({ activeRunId: null, runs: replaceRun(current, 0, entry => ({ ...entry, status: "cancelled", stopRequested: true, backend: { status: "cancelled", reason: "stopped" }, cleanup: { closed: true, exitCode: null, signal: "SIGTERM", protocolFailure: null },
    items: entry.items!.map(it => it.status === "running" || it.status === "waiting" ? { ...it, status: "cancelled" } : it) })) })), [event("run.ended", { runId: "run-0", status: "cancelled" })]).conversation;
  same(env, state);
  assert.deepEqual(loadItems(env.db, "run-0", WHOLE).map(it => it.status), ["completed", "cancelled", "cancelled"]);
  assert.deepEqual(rows(env, "SELECT ordinal, status, cancel_requested AS cancel, stop_requested AS stop, ended_seq AS ended FROM runs ORDER BY ordinal"),
    [{ ordinal: 0, status: "cancelled", cancel: 1, stop: 1, ended: state.lastSeq }, { ordinal: 1, status: "cancelled", cancel: 1, stop: 0, ended: state.lastSeq - 2 }]);
});

test("a Run that ended unknown is acknowledged once by a recovery switch, and then the conversation may open again", t => {
  const env = openDatabase(t);
  let state = runningConversation(env, queuedConversation(env));
  state = commit(env, state, withItems(state, items => [...items, toolItem("run-0", 2, "t1", "running")]), [event("run.output")]).conversation;
  // The owner ended without settling: recovery closes the Run as unknown (and its running tool), and blocks the conversation.
  state = commit(env, state, reduce(state, current => ({ status: "blocked", activeRunId: null, runs: replaceRun(current, 0, entry => ({ ...entry, status: "unknown", error: { code: "OWNER_ENDED", message: "ended" }, ...completedBackend,
    items: entry.items!.map(it => it.status === "running" ? { ...it, status: "unknown" } : it) })) })), [event("session.recovered", { unknownRunIds: ["run-0"], cancelledRunIds: [] })]).conversation;
  same(env, state);
  assert.equal(oneRun(state).endedSeq, state.lastSeq);
  // A head that says open while the unknown Run is not acknowledged is refused by the table, and nothing of that commit stays.
  const before = counts(env, "events");
  assert.throws(() => commit(env, state, reduce(state, () => ({ status: "open" })), [event("session.reopened")]), (error: unknown) => error instanceof SessionError && error.code === "INVALID_TRANSITION" && /nobody acknowledged/u.test(error.message));
  assert.equal(counts(env, "events"), before);
  // The recovery switch is asked for and becomes effective, naming the unknown Run; the Run records the switch that acknowledged it; the conversation opens at the next epoch.
  const asked: PublicSwitch = { id: switchId("switch-1"), commandId: switchCommand(1).id, requested: { harnessId: "beta" }, requestedSeq: 9, target: null, status: "requested", throughSeq: 0, sourceRunIds: [oneRun(state).id], error: null };
  state = commit(env, state, reduce(state, current => ({ switches: [asked], pendingSwitchId: asked.id, commands: [...current.commands, switchCommand(1)] })), [event("switch.requested")]).conversation;
  same(env, state);
  const effective: PublicSwitch = { ...asked, status: "effective", target: { harnessId: "beta", controlId: "beta-acp" }, acknowledgedUnknown: [oneRun(state).id] };
  state = commit(env, state, reduce(state, current => ({ status: "open", epoch: 2, selection: { harnessId: "beta", controlId: "beta-acp" }, pendingSwitchId: null, switches: [effective],
    runs: replaceRun(current, 0, entry => ({ ...entry, acknowledgedBy: asked.id })) })), [event("switch.effective")]).conversation;
  same(env, state);
  assert.deepEqual(rows(env, "SELECT status, acknowledged_by AS by FROM runs"), [{ status: "unknown", by: "switch-1" }]);
  assert.deepEqual(rows(env, "SELECT ordinal, status, source_through_ordinal AS through FROM switches"), [{ ordinal: 0, status: "effective", through: 0 }]);
  // Acknowledged once: another switch cannot take it over.
  assert.throws(() => commit(env, state, reduce(state, current => ({ runs: replaceRun(current, 0, entry => ({ ...entry, acknowledgedBy: switchId("switch-2") })) })), [event("x")]), /only an unknown Run is acknowledged/u);
});

test("native bindings: a binding is archived before the one that replaces it is inserted, and a relay state with nothing yet (-1) is stored as it is", t => {
  const env = openDatabase(t);
  let state = runningConversation(env, queuedConversation(env));
  state = commit(env, state, reduce(state, current => ({ activeRunId: null, runs: replaceRun(current, 0, entry => ({ ...entry, status: "completed", ...completedBackend })) })), [event("run.ended", { runId: "run-0" })]).conversation;
  const first: NativeSessionBinding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-1", throughRunId: oneRun(state).id, status: "ready", relay: { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false } };
  state = commit(env, state, reduce(state, () => ({ nativeBindings: [first] })), [event("native.binding")]).conversation;
  same(env, state);
  assert.deepEqual(rows(env, "SELECT ordinal, status, relay_epoch AS epoch, relay_mark AS mark, relay_floor AS floor FROM bindings"), [{ ordinal: 0, status: "ready", epoch: 1, mark: -1, floor: -1 }]);
  // The same control starts a new native session: the old binding is archived and the new one inserted in one commit, whichever order the array lists them.
  const archived: NativeSessionBinding = { ...first, status: "archived" };
  const second: NativeSessionBinding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-2", throughRunId: null, status: "ready", opensNew: true, relay: { epoch: 2, mark: -1, floor: 0, pending: null, resendAll: false } };
  state = commit(env, state, reduce(state, () => ({ nativeBindings: [archived, second] })), [event("native.cleared")]).conversation;
  same(env, state);
  assert.deepEqual(rows(env, "SELECT ordinal, status, opens_new AS fresh, relay_epoch AS epoch FROM bindings ORDER BY ordinal"), [{ ordinal: 0, status: "archived", fresh: 0, epoch: 1 }, { ordinal: 1, status: "ready", fresh: 1, epoch: 2 }]);
  // A binding without its relay state is not one of a converted conversation.
  assert.throws(() => bindingRowOf(SESSION, 2, { harnessId: "a", controlId: "b", checkpoint: "c", throughRunId: null, status: "ready" }), /relay state/u);
});

test("what a table refuses comes back as a failure of the one request, with the SQLite error as its cause, and nothing of the commit is left", t => {
  const env = openDatabase(t);
  const state = runningConversation(env, queuedConversation(env));
  // A key refuses a second active Run: INVALID_DATA, not a failure of the store.
  const second = run(1, "running", [userItem("run-1", "again")]);
  assert.throws(() => commit(env, state, reduce(state, current => ({ runs: [...current.runs, second], commands: [...current.commands, sendCommand(1)] })), [event("message.accepted", { runId: "run-1" })]), (error: unknown) => {
    assert.ok(error instanceof SessionError); assert.equal(error.code, "INVALID_DATA"); assert.match(error.message, /UNIQUE/u); return true;
  });
  assert.equal(counts(env, "runs"), 1);
  const done = commit(env, state, reduce(state, current => ({ activeRunId: null, runs: replaceRun(current, 0, entry => ({ ...entry, status: "completed", ...completedBackend })) })), [event("run.ended", { runId: "run-0" })]).conversation;
  const events = counts(env, "events"), items = counts(env, "items");
  // A hand-made Mutation (the diff would not make it): a new item for a finished Run, after an event and a head move. The trigger refuses; everything is rolled back.
  const mutation: Mutation = { head: { row: { ...loadHead(env), version: done.version, lastSeq: done.lastSeq + 1 } }, items: [{ op: "insert", row: { ...item("run-0", 9, "tool:late", "command", "completed", { command: "x" }), textBytes: 0, textChunks: 0 } }],
    events: [event("late")] };
  assert.throws(() => applyMutation(env.db, mutation, { ownerGeneration: 1, timestamp: STAMP }), (error: unknown) => {
    assert.ok(error instanceof SessionError); assert.equal(error.code, "INVALID_TRANSITION"); assert.match(error.message, /no item is added to a finished Run/u);
    assert.equal((error.cause as { errcode?: number }).errcode, 1811);
    return true;
  });
  assert.equal(counts(env, "events"), events); assert.equal(counts(env, "items"), items); assert.equal(env.db.isTransaction, false);
  same(env, done);
  // The same Mutation twice is a lost race, told as VERSION_CONFLICT; a stale cursor too.
  const next = reduce(done, () => ({ status: "open" }));
  const once = commit(env, done, next, [event("noted")]);
  assert.throws(() => applyMutation(env.db, once.mutation, { ownerGeneration: 1, timestamp: STAMP }), (error: unknown) => error instanceof SessionError && error.code === "VERSION_CONFLICT");
  assert.throws(() => applyMutation(env.db, { ...once.mutation, head: { row: { ...once.mutation.head!.row, version: once.conversation.version, lastSeq: once.conversation.lastSeq + 5 } }, events: [event("noted")] }, { ownerGeneration: 1, timestamp: STAMP }),
    (error: unknown) => error instanceof SessionError && error.code === "VERSION_CONFLICT");
  // A failure that is not a rule of ours (a table that is not there) is passed on as SQLite gave it: the store is not to be trusted after it.
  const broken = new DatabaseSync(":memory:");
  broken.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, version INTEGER, last_seq INTEGER, head TEXT, format INTEGER, status TEXT, epoch INTEGER, active_run_id TEXT, pending_switch_id TEXT, kept INTEGER, title TEXT, run_count INTEGER, updated_at INTEGER, deleted_at INTEGER, last_error TEXT)");
  assert.throws(() => applyMutation(broken, { head: { row: { ...loadHead(env), version: 0, lastSeq: 1 } }, events: [event("x")] }, { ownerGeneration: 1, timestamp: STAMP }), (error: unknown) => !(error instanceof SessionError) && /no such table: events/u.test(String((error as Error).message)));
  assert.equal(broken.isTransaction, false); broken.close();
});
function loadHead(env: Env) {
  const stored = env.db.prepare("SELECT * FROM sessions WHERE id=?").get(SESSION)!;
  return { id: SESSION, version: Number(stored.version), lastSeq: Number(stored.last_seq), format: 14 as const, status: stored.status as "open", epoch: Number(stored.epoch), activeRunId: null, pendingSwitchId: null, kept: false, title: String(stored.title),
    runCount: Number(stored.run_count), updatedAt: Number(stored.updated_at), deletedAt: null, lastError: null, head: JSON.parse(String(stored.head)) };
}

test("text is whole code points: half a surrogate pair is refused, the pair held for the next chunk reads back whole, and SQLite would have changed the half", t => {
  const env = openDatabase(t);
  let state = runningConversation(env, queuedConversation(env));
  state = commit(env, state, withItems(state, items => [...items, replyItem("run-0", 2, 1, "running", ["a"])]), [event("run.output")]).conversation;
  // What SQLite does to half a pair: it keeps U+FFFD in its place. A chunk that is a half would read back as another text.
  const probe = new DatabaseSync(":memory:"); probe.exec("CREATE TABLE s(v TEXT)");
  probe.prepare("INSERT INTO s VALUES(?)").run("tail\ud83d");
  assert.equal(String(probe.prepare("SELECT v FROM s").get()!.v), "tail�"); probe.close();
  // So the writer's chunk ends before the pair, and the next one starts with it.
  const before = counts(env, "item_text");
  assert.throws(() => commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "b\ud83d"] } : it)), [event("run.output")]), /ends in half of a surrogate pair/u);
  assert.throws(() => commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "\ude00 b"] } : it)), [event("run.output")]), /holds half of a surrogate pair/u);
  assert.equal(counts(env, "item_text"), before);
  state = commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "b"] } : it)), [event("run.output")]).conversation;
  state = commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "😀 c"] } : it)), [event("run.output")]).conversation;
  same(env, state);
  assert.equal(loadItems(env.db, "run-0", WHOLE)[1]!.text.join(""), "ab😀 c");
  assert.equal(oneRun(state).items![1]!.textBytes, bytes("ab😀 c"));
});

test("text is only appended, one chunk after another, each where the last ended", t => {
  const env = openDatabase(t);
  let state = runningConversation(env, queuedConversation(env));
  state = commit(env, state, withItems(state, items => [...items, replyItem("run-0", 2, 1, "running", ["abc", "def"])]), [event("run.output")]).conversation;
  same(env, state);
  assert.deepEqual(rows(env, "SELECT chunk, byte_offset AS offset FROM item_text WHERE item_seq=2 ORDER BY chunk"), [{ chunk: 0, offset: 0 }, { chunk: 1, offset: 3 }]);
  const grow = (change: (text: readonly string[]) => readonly string[]) => withItems(state, items => items.map(it => it.seq === 2 ? { ...it, text: change(it.text) } : it));
  assert.throws(() => commit(env, state, grow(text => text.slice(0, 1)), [event("x")]), /shrank/u);
  assert.throws(() => commit(env, state, grow(text => ["abX", ...text.slice(1)]), [event("x")]), /chunk 0 .* changed/u);
  // Hand-made appends that the writer got wrong: a chunk number that skips, an offset that is not where the text ends.
  const head = (): NonNullable<Mutation["head"]> => ({ row: { ...loadHead(env), lastSeq: loadHead(env).lastSeq + 1 } });
  const append = (chunk: number, byteOffset?: number): Mutation => ({ head: head(), text: [{ runId: oneRun(state).id, itemSeq: 2, chunk, text: "z", ...(byteOffset === undefined ? {} : { byteOffset }) }], events: [event("x")] });
  assert.throws(() => applyMutation(env.db, append(3), { ownerGeneration: 1, timestamp: STAMP }), /does not follow chunk 1/u);
  assert.throws(() => applyMutation(env.db, append(2, 4), { ownerGeneration: 1, timestamp: STAMP }), /starts at byte 4 and the text so far ends at 6/u);
  assert.throws(() => applyMutation(env.db, { head: head(), text: [{ runId: oneRun(state).id, itemSeq: 9, chunk: 0, text: "z" }], events: [event("x")] }, { ownerGeneration: 1, timestamp: STAMP }), /item that does not exist/u);
  same(env, state);
  // And the table itself refuses a rewrite.
  assert.throws(() => env.db.exec("UPDATE item_text SET text='x' WHERE item_seq=2"), /only appended/u);
});

test("content: the details and attachments a Turn refers to are written once as references, and a detail that is replaced stays as the one it superseded", t => {
  const env = openDatabase(t);
  const ref = (id: string): ContentRef => ({ id: id as ContentRef["id"], name: id + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "a".repeat(64) });
  let state = commit(env, null, conversation(), [event("session.created")]).conversation;
  state = commit(env, state, reduce(state, current => ({ runs: [run(0, "queued", [userItem("run-0", "see attached")], { attachments: [ref("content-attached")] })], commands: [...current.commands, sendCommand(0)] })), [event("message.accepted", { runId: "run-0" })]).conversation;
  state = runningConversation(env, state);
  state = commit(env, state, withItems(state, items => [...items, toolItem("run-0", 2, "t1", "running")]), [event("run.output")]).conversation;
  state = commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, status: "completed", fields: { ...it.fields, detail: ref("content-detail-1") } as typeof it.fields } : it)), [event("run.tool_detail")]).conversation;
  state = commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, fields: { ...it.fields, detail: ref("content-detail-2") } as typeof it.fields } : it)), [event("run.tool_detail")]).conversation;
  state = commit(env, state, withItems(state, items => [...items, item("run-0", 3, "output:1", "artifact", "completed", { kind: "image", name: "a.png", content: ref("content-output") })]), [event("run.output")]).conversation;
  assert.deepEqual(rows(env, "SELECT content_id AS id, run_id AS run, item_seq AS seq, role FROM content_refs ORDER BY content_id, role"), [
    { id: "content-attached", run: "run-0", seq: 1, role: "attachment" },
    { id: "content-detail-1", run: "run-0", seq: 2, role: "superseded_detail" },
    { id: "content-detail-1", run: "run-0", seq: 2, role: "tool_detail" },
    { id: "content-detail-2", run: "run-0", seq: 2, role: "tool_detail" },
    { id: "content-output", run: "run-0", seq: 3, role: "output" }]);
  // The same references again change nothing.
  state = commit(env, state, withItems(state, items => items.map(it => it.seq === 2 ? { ...it, endedAt: NOW } : it)), [event("run.output")]).conversation;
  assert.equal(counts(env, "content_refs"), 5);
  same(env, state);
});

test("notice prints and a quoted history are written with the commit, and a notice shown before is not written again", t => {
  const env = openDatabase(t);
  const first = commit(env, null, conversation(), [event("session.created")], { noticePrints: ["print-a", "print-b"], originHistory: [
    { sessionId: SESSION, idx: 0, kind: "fork", message: { role: "user", text: "quoted", status: "completed" } }, { sessionId: SESSION, idx: 1, kind: "fork", message: { role: "assistant", text: "answer 回答", status: "completed" } }] });
  commit(env, first.conversation, reduce(first.conversation, () => ({ status: "open" })), [event("noted")], { noticePrints: ["print-b", "print-c"] });
  assert.deepEqual(rows(env, "SELECT print FROM notice_prints ORDER BY print"), [{ print: "print-a" }, { print: "print-b" }, { print: "print-c" }]);
  assert.deepEqual(rows(env, "SELECT idx, kind, json_extract(message_json,'$.text') AS text FROM origin_history ORDER BY idx"), [{ idx: 0, kind: "fork", text: "quoted" }, { idx: 1, kind: "fork", text: "answer 回答" }]);
});

test("a conversation being converted is written freely, its head last, and it is fixed when the head says 14", t => {
  const env = openDatabase(t);
  // A v13 row as the upgrade leaves it: the whole snapshot in `head`, no tables yet.
  env.db.prepare("INSERT INTO sessions(id,version,last_seq,head,format) VALUES(?,?,?,?,13)").run(SESSION, 4, 9, '{"schemaVersion":13}');
  const finished = run(0, "completed", [userItem("run-0", "old question"), replyItem("run-0", 2, 1, "completed", ["old ", "answer"])], { endedSeq: 9, ...completedBackend });
  // The Run is terminal at its insert and its items follow it: possible only because the conversation is not 14 yet.
  const applied = applyMutation(env.db, conversionMutation(conversation([finished], { version: 4, lastSeq: 9 }), 4, 9), { ownerGeneration: 1, timestamp: STAMP });
  assert.equal(applied.changes.head!.row.version, 5);
  const loaded = loadConversation(env.db, SESSION);
  assert.equal(loaded.version, 5); assert.equal(loaded.lastSeq, 9); assert.equal(loaded.format, 14);
  const { items: _items, ...held } = finished;
  assert.deepEqual(loaded.runs, [held]);
  assert.deepEqual(loadItems(env.db, "run-0", WHOLE).map(it => it.text.join("")), ["old question", "old answer"]);
  assert.throws(() => env.db.exec("UPDATE items SET status='failed' WHERE run_id='run-0'"), /finished Run never change/u);
  assert.throws(() => env.db.exec("UPDATE sessions SET format=13"), /never converted back/u);
});

test("the relay's rows are written by the writer the store gives, after the events and before the head; a Mutation that has them and no writer is refused", t => {
  const env = openDatabase(t);
  const state = runningConversation(env, queuedConversation(env));
  const next = reduce(state, () => ({ status: "open" }));
  const seen: { events: number; version: number }[] = [];
  const mutation = { ...diffConversation(state, next, { events: [event("noted")], title: "Hello", updatedAt: NOW }), relay: { deliveries: [] } };
  assert.throws(() => applyMutation(env.db, mutation, { ownerGeneration: 1, timestamp: STAMP }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  assert.equal(counts(env, "events"), state.lastSeq, "refused before anything stays");
  const applied = applyMutation(env.db, mutation, { ownerGeneration: 1, timestamp: STAMP, writeRelay: rows => { assert.deepEqual(rows, { deliveries: [] }); seen.push({ events: counts(env, "events"), version: Number(env.db.prepare("SELECT version FROM sessions").get()!.version) }); } });
  assert.deepEqual(seen, [{ events: state.lastSeq + 1, version: state.version }], "the event is in, the head is still the old one");
  assert.equal(applied.changes.head!.row.version, state.version + 1);
  // A writer that refuses takes the whole commit with it.
  const again = diffConversation(settle(state, applied), reduce(settle(state, applied), () => ({ status: "open" })), { events: [event("noted.again")], title: "Hello", updatedAt: NOW });
  assert.throws(() => applyMutation(env.db, { ...again, relay: { packets: [] } }, { ownerGeneration: 1, timestamp: STAMP, writeRelay: () => { throw new SessionError("RELAY_FAILED", "no"); } }), (error: unknown) => error instanceof SessionError && error.code === "RELAY_FAILED");
  assert.equal(counts(env, "events"), state.lastSeq + 1);
});
function settle(state: Conversation, applied: ReturnType<typeof applyMutation>): Conversation { return { ...state, version: applied.changes.head!.row.version, lastSeq: applied.changes.head!.row.lastSeq }; }

test("a Mutation writes only into the conversation its head names", t => {
  const env = openDatabase(t);
  const state = queuedConversation(env);
  const row = runRowOf(SESSION, oneRun(state));
  const foreign = { ...row, sessionId: "session-other" as typeof SESSION, ordinal: 1, runId: "run-foreign" as typeof row.runId, commandId: "command-foreign" as typeof row.commandId };
  assert.throws(() => applyMutation(env.db, { head: { row: { ...loadHead(env), lastSeq: loadHead(env).lastSeq } }, runs: [{ op: "insert", row: foreign }], events: [] }, { ownerGeneration: 1, timestamp: STAMP }), /belongs to another conversation/u);
  assert.throws(() => applyMutation(env.db, { head: { row: { ...loadHead(env), lastSeq: loadHead(env).lastSeq } }, items: [{ op: "insert", row: { ...item("run-nowhere", 1, "x", "tool", "running"), textBytes: 0, textChunks: 0 } }], events: [] }, { ownerGeneration: 1, timestamp: STAMP }),
    /Run that is not this conversation's/u);
  // An event that is not an event, or holds what JSON cannot: a failure of the request, nothing written.
  const bad = (events: Mutation["events"]) => () => applyMutation(env.db, { head: { row: { ...loadHead(env), lastSeq: loadHead(env).lastSeq + events.length } }, events }, { ownerGeneration: 1, timestamp: STAMP });
  assert.throws(bad([{ type: "Not An Event", data: {} }]), /invalid event draft/u);
  assert.throws(bad([{ type: "ok.event", data: { big: 1n as unknown as number } }]), /not JSON/u);
  assert.equal(loadHead(env).lastSeq, state.lastSeq);
});

test("the cost of a commit does not grow with the history: appending a window of text to a conversation of 10 Turns and to one of 5,000", t => {
  // The history as a conversion writes it: a v13 row, then every finished Turn in one Mutation, the head last; then a Turn in progress.
  const history = (turns: number) => {
    const env = openDatabase(t);
    const finishedRuns: ConversationRun[] = Array.from({ length: turns }, (_, ordinal) => run(ordinal, "completed", [userItem("run-" + ordinal, "question " + ordinal), replyItem("run-" + ordinal, 2, 1, "completed", ["answer ", String(ordinal)])], { endedSeq: 100 + ordinal, ...completedBackend }));
    const loaded = seedConverted(env, conversation(finishedRuns, { version: 1, lastSeq: 5 }));
    assert.equal(loaded.runs.length, turns);
    const active = run(turns, "running", [userItem("run-" + turns, "now"), replyItem("run-" + turns, 2, 1, "running", ["w"])], { timing: { acceptedAt: NOW, preparingAt: NOW + 1, readyAt: NOW + 2, dispatchedAt: NOW + 3 } });
    const state = commit(env, loaded, reduce(loaded, current => ({ runs: [...current.runs, active], commands: [...current.commands, sendCommand(turns)], activeRunId: active.id })), [event("message.accepted", { runId: active.id }), event("run.started")]).conversation;
    return { env, state, turns, diff: [] as number[], apply: [] as number[], settle: [] as number[], total: [] as number[] };
  };
  const small = history(10), large = history(5000);
  // 440 windows of text appended to the reply of the Turn in progress, each its own commit; the two conversations take turns, so that whatever else the machine does, it does to both.
  for (let window = 0; window < 440; window++) {
    for (const side of [small, large]) {
      const next = reduce(side.state, current => ({ runs: current.runs.map(entry => entry.ordinal !== side.turns ? entry : { ...entry, items: entry.items!.map(it => it.seq === 2 ? { ...it, text: [...it.text, "window " + window + " of text 窗口 "] } : it) }) }));
      const t0 = performance.now();
      const mutation = diffConversation(side.state, next, { events: [event("run.output", { runId: "run-" + side.turns })], title: "Hello", updatedAt: NOW });
      const t1 = performance.now();
      const applied = applyMutation(side.env.db, mutation, { ownerGeneration: 1, timestamp: STAMP });
      const t2 = performance.now();
      side.state = settleConversation(next, applied);
      const t3 = performance.now();
      if (window >= 40) { side.diff.push(t1 - t0); side.apply.push(t2 - t1); side.settle.push(t3 - t2); side.total.push(t3 - t0); }
    }
  }
  const median = (values: number[]): number => values.sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
  const report = (name: string, key: "diff" | "apply" | "settle" | "total") => { const a = median(small[key]), b = median(large[key]); return name + " " + a.toFixed(3) + " -> " + b.toFixed(3) + " ms (x" + (b / a).toFixed(2) + ")"; };
  console.log("commit of one text window, median of 400, 10 Turns -> 5,000 Turns: " + [report("write", "apply"), report("compare", "diff"), report("settle", "settle"), report("all", "total")].join("; "));
  assert.equal(small.state.runs[10]!.items![1]!.textChunks, 441); assert.equal(large.state.runs[5000]!.items![1]!.textChunks, 441);
  const ratio = median(large.total) / median(small.total), writes = median(large.apply) / median(small.apply);
  assert.ok(writes < 2, "writing a commit costs " + writes.toFixed(2) + " times as much with 5,000 Turns as with 10");
  assert.ok(ratio < 2, "a commit costs " + ratio.toFixed(2) + " times as much with 5,000 Turns as with 10");
});
