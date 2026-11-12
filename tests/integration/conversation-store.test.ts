import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { Conversation, ConversationRun, HeldItem, Mutation } from "../../src/contracts/conversation.js";
import { SessionError, commandId, runId, sessionId, switchId, type EventDraft, type PublicSwitch } from "../../src/contracts/session.js";
import { verify, verifyTransition } from "../../src/contexts/session/domain/conversation-verify.js";
import { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { NOW, event, item, replyItem, run, sendCommand, toolItem, userItem } from "../fixtures/conversation-builder.js";
import { Scenario, code, count, created, newConversation, openStore, rawDatabase, recoverUnfinished, temporary } from "../fixtures/store-helpers.js";

// The store of conversations (ADR-057, src/infrastructure/session/conversation-store.ts) on real SQLite files in temporary directories: its commit, the ownership of the data
// root, what a refused request leaves behind, and what a process killed at any moment leaves for the next. Only the Harness and the model are made up. After every commit
// the whole-conversation check (T8) runs over what the store holds: it finds nothing.

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const peerPath = join(repository, "tests/fixtures/conversation-store-peer.mjs");

/** The store's conversation held to every rule `verify` knows, and to the transition from the one before it. */
function sound(store: SqliteConversationStore, id: Conversation["id"], label: string = id): void {
  const now = store.get(id);
  assert.deepEqual(verify(now, store), [], label + ": the conversation breaks no rule");
}
/** `store.transact` followed by the checks of a state and of the step into it. */
function step(store: SqliteConversationStore, id: Conversation["id"], change: (current: Conversation) => Partial<Conversation>, events: readonly EventDraft[]) {
  const before = store.get(id);
  const done = store.transact(id, before.version, current => ({ next: { ...current, ...change(current) }, events }));
  assert.deepEqual(verifyTransition(before, done.conversation, events), [], "the step breaks no rule of a transition");
  assert.deepEqual(verify(done.conversation, store), [], "the conversation after the step breaks no rule");
  return done;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------------------------------------------------------------

test("a conversation and its events are one commit: the version and the cursor follow by themselves, and a root opened again finds them as they were", t => {
  const { root, data, store } = openStore(t, { now: () => new Date("2026-11-12T00:00:00.000Z") });
  const made = created(store, newConversation(root, "one"), [{ type: "session.created", data: { nested: ["中文", 1, true, null] } }, { type: "selection.selected", data: {} }]);
  assert.equal(made.conversation.version, 1); assert.equal(made.conversation.lastSeq, 2);
  assert.deepEqual(made.events.map(entry => entry.seq), [1, 2]);
  assert.ok(made.events.every(entry => entry.ownerGeneration === 1 && entry.timestamp === "2026-11-12T00:00:00.000Z" && entry.sessionId === "session-one"));
  const committed = store.transact(made.conversation.id, 1, current => ({ next: { ...current, status: "blocked" }, events: [{ type: "session.updated", data: {} }] }));
  assert.equal(committed.conversation.version, 2); assert.equal(committed.conversation.lastSeq, 3);
  assert.deepEqual(store.events(made.conversation.id, 1).map(entry => entry.seq), [2, 3]);
  assert.deepEqual(store.events(made.conversation.id, 3), []);
  assert.equal(store.get(made.conversation.id), committed.conversation, "the conversation of a version is one object");
  assert.deepEqual(committed.changes.head?.row, { id: "session-one", version: 2, lastSeq: 3, format: 14, status: "blocked", epoch: 1, activeRunId: null, pendingSwitchId: null, kept: false, title: "新对话", runCount: 0, updatedAt: Date.parse("2026-11-12T00:00:00.000Z"),
    deletedAt: null, lastError: null, head: { configuration: committed.conversation.configuration, selection: committed.conversation.selection } });
  store.close();
  const reopened = new SqliteConversationStore(data);
  try {
    assert.equal(reopened.ownerGeneration, 2);
    assert.deepEqual(reopened.get(made.conversation.id), committed.conversation);
    assert.equal(reopened.events(made.conversation.id, 0)[0]?.ownerGeneration, 1);
    sound(reopened, made.conversation.id);
  } finally { reopened.close(); }
});

test("the create command is an idempotency key: the same request returns the conversation it made, another request with the key is refused", t => {
  const { root, store } = openStore(t);
  const made = created(store, newConversation(root, "one"));
  const replayed = created(store, newConversation(root, "other", { commands: [{ ...newConversation(root, "one").commands[0]! }] }));
  assert.equal(replayed.conversation.id, made.conversation.id); assert.equal(replayed.events.length, 0);
  assert.deepEqual(store.list().rows.map(row => row.id), ["session-one"]);
  assert.equal(store.findByCreateKey(commandId("create-one"))?.id, made.conversation.id);
  assert.equal(store.findByCreateKey(commandId("missing")), null);
  assert.throws(() => created(store, newConversation(root, "other", { commands: [{ ...newConversation(root, "one").commands[0]!, fingerprint: "b".repeat(64) }] })), code("IDEMPOTENCY_CONFLICT"));
  assert.throws(() => created(store, newConversation(root, "one", { commands: [{ ...newConversation(root, "one").commands[0]!, id: commandId("create-again") }] })), code("SESSION_EXISTS"));
  assert.equal(store.events(made.conversation.id, 0).length, 1);
});

test("a create without a durable event, or with a cursor that is not zero, commits nothing: no conversation, no create key, no hidden first version", t => {
  const { root, data, store } = openStore(t), state = newConversation(root, "one");
  assert.throws(() => store.create(state, []), code("INVALID_DATA"));
  assert.throws(() => store.create({ ...state, version: 1 }, [event("session.created")]), code("INVALID_INPUT"));
  assert.throws(() => store.create({ ...state, lastSeq: 3 }, [event("session.created")]), code("INVALID_INPUT"));
  assert.throws(() => store.create({ ...state, commands: [] }, [event("session.created")]), code("INVALID_DATA"));
  assert.equal(store.findByCreateKey(commandId("create-one")), null); assert.deepEqual(store.list().rows, []);
  assert.throws(() => store.get(state.id), code("SESSION_NOT_FOUND"));
  const outsider = rawDatabase(data);
  try { for (const table of ["sessions", "create_keys", "events", "commands"]) assert.equal(count(outsider, table), 0, table); } finally { outsider.close(); }
  assert.equal(created(store, state).conversation.version, 1);
});

test("a commit without an event, or one that changes nothing, is not a commit", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one"));
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: { ...current, status: "blocked" }, events: [] })), code("INVALID_DATA"));
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: current, events: [] })), code("INVALID_DATA"));
  assert.equal(store.get(made.conversation.id), made.conversation, "nothing moved, not even the object");
  assert.deepEqual(store.events(made.conversation.id, 0), made.events);
  const outsider = rawDatabase(data);
  try { const row = outsider.prepare("SELECT version, last_seq, status FROM sessions").get(); assert.deepEqual({ ...row }, { version: 1, last_seq: 1, status: "open" }); assert.equal(count(outsider, "events"), 1); } finally { outsider.close(); }
});

test("a lost race and a conversation that breaks a rule leave the head, the cursor and the log as they were, and the memory too", t => {
  const { root, store } = openStore(t), made = created(store, newConversation(root, "one"));
  assert.throws(() => store.transact(made.conversation.id, 2, current => ({ next: current, events: [event("bad.cas")] })), code("VERSION_CONFLICT"));
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: { ...current, epoch: 0 }, events: [event("bad.domain")] })), error => error instanceof SessionError && ["INVALID_DATA", "INVALID_TRANSITION"].includes(error.code), "a rule of the tables refuses it");
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: { ...current, id: sessionId("session-other") }, events: [event("bad.identity")] })), code("INVALID_DATA"));
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: { ...current, commands: [{ ...current.commands[0]!, fingerprint: "b".repeat(64) }] }, events: [event("bad.create")] })), code("INVALID_DATA"));
  assert.throws(() => store.transact(made.conversation.id, 1, () => { throw new Error("the reducer failed"); }), /the reducer failed/u);
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: { ...current, format: 13 as never }, events: [event("bad.format")] })), code("INVALID_DATA"));
  assert.equal(store.get(made.conversation.id), made.conversation); assert.deepEqual(store.events(made.conversation.id, 0), made.events);
  store.assertOwner();
  sound(store, made.conversation.id);
});

test("a mutation cannot change the conversation it was given, which would slip past the comparison of a commit", t => {
  const { root, store } = openStore(t), made = created(store, newConversation(root, "one"));
  assert.throws(() => store.transact(made.conversation.id, 1, current => { Object.assign(current, { version: 99 }); return { next: current, events: [event("bad.mutable-version")] }; }), TypeError);
  assert.throws(() => store.transact(made.conversation.id, 1, current => { (current.commands as unknown[]).push({}); return { next: current, events: [event("bad.commands")] }; }), TypeError);
  assert.throws(() => Object.assign(store.get(made.conversation.id).selection, { harnessId: "modified" }), TypeError);
  assert.equal(store.get(made.conversation.id), made.conversation);
});

test("the events a commit returns and the ones the store reads are independent copies of what the caller gave", t => {
  const { root, store } = openStore(t), data = { value: "original" };
  const made = created(store, newConversation(root, "one"), [{ type: "session.created", data }]);
  data.value = "changed";
  Object.assign(made.events[0]?.data ?? {}, { value: "modified" });
  assert.equal(store.events(made.conversation.id, 0)[0]?.data.value, "original");
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: current, events: [{ type: "bad.event", data: { fn: () => 0 } }] })), code("INVALID_DATA"));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: current, events: [{ type: "bad.event", data: circular }] })), code("INVALID_DATA"));
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: current, events: [{ type: "Not An Event", data: {} }] })), code("INVALID_DATA"));
  let deep: Record<string, unknown> = {};
  for (let level = 0; level < 100; level++) deep = { deep };
  assert.throws(() => store.transact(made.conversation.id, 1, current => ({ next: current, events: [{ type: "bad.event", data: deep }] })), code("INVALID_DATA"));
  store.assertOwner();
});

test("history is kept: a Run, a command or an item cannot be taken away, a finished Run cannot be rewritten, a committed command cannot change", t => {
  const { root, store } = openStore(t), made = created(store, newConversation(root, "one"));
  const scenario = new Scenario(store, made.conversation.id, "run-one");
  scenario.turn("recorded input", "recorded answer");
  const before = store.get(made.conversation.id), events = store.events(made.conversation.id, 0);
  const refused = (change: (current: Conversation) => Partial<Conversation>, label: string) => {
    assert.throws(() => store.transact(before.id, before.version, current => ({ next: { ...current, ...change(current) }, events: [event("bad.history")] })), code("INVALID_TRANSITION"), label);
    assert.equal(store.get(before.id), before, label + ": the conversation is the object it was"); assert.deepEqual(store.events(before.id, 0), events, label);
  };
  refused(() => ({ runs: [], commands: before.commands.filter(entry => entry.kind === "create") }), "every Run taken away");
  refused(current => ({ commands: current.commands.filter(entry => entry.kind === "create") }), "a send command taken away");
  refused(current => ({ commands: current.commands.map(entry => entry.kind === "send" ? { ...entry, fingerprint: "c".repeat(64) } : entry) }), "a send fingerprint rewritten");
  refused(current => ({ runs: current.runs.map(entry => ({ ...entry, backend: { status: "failed" as const, reason: "rewritten" } })) }), "the evidence of a finished Run rewritten");
  refused(current => ({ runs: current.runs.map(entry => ({ ...entry, status: "failed" as const })) }), "a finished Run made another");
  // The items of a finished Run are not held, and none can be added to it: the table refuses it, and the request ends there.
  assert.throws(() => store.transact(before.id, before.version, current => ({ next: { ...current, runs: current.runs.map(entry => ({ ...entry, items: [toolItem("run-one-0", 9, "late", "completed")] })) }, events: [event("bad.late-item")] })),
    error => error instanceof SessionError && (error.code === "INVALID_TRANSITION" || error.code === "INVALID_DATA"));
  store.assertOwner(); sound(store, before.id);
});

test("every commit of a Turn from its input to its end reads back as the conversation the store holds, and breaks no rule of a state or of a step", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one"));
  const id = made.conversation.id, scenario = new Scenario(store, id, "run-one");
  const sameAsTables = (label: string): void => {
    const reader = rawDatabase(data, true);
    try { assert.equal(Number(reader.prepare("SELECT version FROM sessions WHERE id=?").get(id)?.version), store.get(id).version, label); } finally { reader.close(); }
    sound(store, id, label);
  };
  scenario.accept("Hello 你好 👋"); sameAsTables("accepted");
  scenario.start(0); sameAsTables("started");
  const reply = scenario.say(0, "Looking at "); sameAsTables("first window");
  scenario.append(0, reply.seq, "the 文件 now."); sameAsTables("second window");
  assert.equal(store.get(id).runs[0]?.items?.find(held => held.seq === reply.seq)?.textBytes, Buffer.byteLength("Looking at the 文件 now."));
  scenario.tool(0, "t1", "running"); sameAsTables("a call");
  scenario.finish(0); sameAsTables("ended");
  const final = store.get(id);
  assert.equal(final.runs[0]?.items, undefined, "the items of a finished Turn leave memory");
  assert.equal(final.runs[0]?.endedSeq, final.lastSeq);
  const turn = store.turnAt(id, 0)!;
  assert.deepEqual(turn.items.map(held => [held.seq, held.itemId, held.status, held.text.join("")]), [[1, "user", "completed", "Hello 你好 👋"], [2, "text:1", "completed", "Looking at the 文件 now."], [3, "tool:t1", "completed", ""]]);
  assert.equal(count(rawDatabase(data, true), "events"), final.lastSeq);
  // The log is one run of seqs from 1 with nothing missing, whichever commit wrote an event, and every event is the owner's that wrote it.
  const log: number[] = [];
  for (let page = store.events(id, 0, 3); page.length > 0; page = store.events(id, log.at(-1)!, 3)) { log.push(...page.map(entry => entry.seq)); assert.ok(page.every(entry => entry.ownerGeneration === 1 && entry.sessionId === id)); }
  assert.deepEqual(log, Array.from({ length: final.lastSeq }, (_, index) => index + 1));
});

test("the title is worked out once, from the first input (folded and cut to 80 characters, never in the middle of a character), and the head's time is the store's clock at each commit", t => {
  let now = new Date("2026-11-12T01:00:00.000Z");
  const { root, store } = openStore(t, { now: () => now });
  const one = created(store, newConversation(root, "one")), id = one.conversation.id;
  assert.equal(store.head(id).title, "新对话"); assert.equal(store.head(id).updatedAt, now.getTime());
  const scenario = new Scenario(store, id, "run-one");
  now = new Date("2026-11-12T01:00:05.000Z");
  scenario.accept("  first   line\nof\tthe   question  ");
  assert.equal(store.head(id).title, "first line of the question"); assert.equal(store.head(id).updatedAt, now.getTime());
  now = new Date("2026-11-12T01:00:09.000Z");
  scenario.start(0); scenario.finish(0);
  scenario.accept("a second input does not rename it");
  assert.equal(store.head(id).title, "first line of the question"); assert.equal(store.head(id).updatedAt, now.getTime());
  now = new Date("not a date");
  assert.throws(() => scenario.accept("x"), code("INVALID_INPUT"));
  store.assertOwner();
  // A cut that would fall inside a pair of UTF-16 units is made before it: a title is never stored with half a character (SQLite would keep U+FFFD in its place).
  now = new Date("2026-11-12T02:00:00.000Z");
  const two = created(store, newConversation(root, "two")), emoji = new Scenario(store, two.conversation.id, "run-two");
  emoji.accept("x".repeat(79) + "😀 and more");
  assert.equal(store.head(two.conversation.id).title, "x".repeat(79));
  assert.equal(store.list().rows.find(row => row.id === two.conversation.id)?.title, "x".repeat(79));
  const three = created(store, newConversation(root, "three")), blank = new Scenario(store, three.conversation.id, "run-three");
  blank.accept("   \n  ");
  assert.equal(store.head(three.conversation.id).title, "新对话", "an input of spaces names nothing");
});

test("no count or size of a conversation is limited: 300 Turns, 20,000 events, an event of 3 MiB and a reply of 12 MiB are kept and read back whole", t => {
  const { root, store } = openStore(t), made = created(store, newConversation(root, "big")), id = made.conversation.id, scenario = new Scenario(store, id, "run-big", false);
  // More Turns than the first store allowed (256), each a few commits.
  for (let turn = 0; turn < 300; turn++) scenario.turn("question " + turn, "answer " + turn);
  assert.equal(store.get(id).runs.length, 300); sound(store, id);
  // More events than the first store allowed (16,384) in one conversation: a commit of 17,000 events at once.
  const many = Array.from({ length: 17_000 }, (_, index) => event("fixture.noted", { index }));
  step(store, id, () => ({}), many);
  assert.ok(store.get(id).lastSeq > 17_000);
  assert.equal(store.events(id, store.get(id).lastSeq - 5, 5).length, 5);
  // An event of 3 MiB (the first store refused 2 MiB), and the pages that carry it.
  const big = "x".repeat(3 * 1024 * 1024), last = store.get(id).lastSeq;
  step(store, id, () => ({}), [event("fixture.big", { text: big })]);
  const page = store.events(id, last, 100);
  assert.equal(page.length, 1); assert.equal((page[0]!.data.text as string).length, big.length);
  // A reply of 12 MiB in one segment (the first store failed the Turn at 1 MiB), appended window by window, read by byte range.
  const opened = scenario.accept("write a lot"); scenario.start(opened.ordinal);
  const first = scenario.say(opened.ordinal, "start ");
  const window = "窗口".repeat(8000);
  let bytes = Buffer.byteLength("start ");
  while (bytes < 12 * 1024 * 1024) { scenario.append(opened.ordinal, first.seq, window); bytes += Buffer.byteLength(window); }
  scenario.finish(opened.ordinal);
  const range = store.text(runId("run-big-" + opened.ordinal), first.seq, { from: bytes - 12, to: bytes });
  assert.equal(range.total, bytes); assert.equal(range.text, "窗口窗口");
  sound(store, id);
});

test("a commit that is a lost race or a refused rule does not disable the store, and one that the SQLite storage fails does, with nothing of it kept", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one")), id = made.conversation.id, scenario = new Scenario(store, id, "run-one");
  const first = scenario.accept("one"); scenario.start(first.ordinal);
  // A second active Run is a rule of the tables: this request ends with INVALID_DATA, and the store goes on.
  const second = run(1, "running", [userItem("run-one-1", "again")], {}, "run-one");
  assert.throws(() => store.transact(id, store.get(id).version, current => ({ next: { ...current, runs: [...current.runs, second], commands: [...current.commands, sendCommand(1, "run-one")] }, events: [event("message.accepted", { runId: "run-one-1" })] })), code("INVALID_DATA"));
  store.assertOwner();
  assert.equal(store.get(id).runs.length, 1); sound(store, id);
  scenario.finish(first.ordinal);
  // The storage fails (the table of events is gone from under it): the commit is rolled back, nothing of it is kept, and the store is disabled.
  const outsider = rawDatabase(data), version = Number(outsider.prepare("SELECT version FROM sessions").get()?.version), events = count(outsider, "events");
  outsider.exec("ALTER TABLE events RENAME TO events_gone");
  assert.throws(() => store.transact(id, store.get(id).version, current => ({ next: { ...current, status: "blocked" }, events: [event("session.failed-write")] })), code("STORAGE_UNAVAILABLE"));
  assert.equal(Number(outsider.prepare("SELECT version FROM sessions").get()?.version), version); assert.equal(count(outsider, "events_gone"), events);
  assert.throws(() => store.get(id), code("STORAGE_UNAVAILABLE"));
  assert.throws(() => store.close(), code("STORAGE_UNAVAILABLE"));
  outsider.close();
});

test("a transaction cannot begin inside the reducer of another, and says so without disabling the store", t => {
  const { root, store } = openStore(t), made = created(store, newConversation(root, "one")), other = created(store, newConversation(root, "two"));
  assert.throws(() => store.transact(made.conversation.id, 1, current => { store.transact(other.conversation.id, 1, inner => ({ next: inner, events: [event("nested")] })); return { next: current, events: [event("outer")] }; }), code("INVALID_INPUT"));
  assert.equal(store.get(other.conversation.id).version, 1);
  store.transact(made.conversation.id, 1, current => ({ next: { ...current, status: "blocked" }, events: [event("fine")] }));
  assert.equal(store.get(made.conversation.id).version, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The memory
// ---------------------------------------------------------------------------------------------------------------------------------

test("sizes given for the store's memory and its relay texts are checked before the root is touched", t => {
  const data = join(temporary(t), "data");
  for (const options of [{ cache: { conversations: 0 } }, { cache: { runs: 1.5 } }, { snapshotCacheBytes: -1 }, { relayBodyQuotaBytes: 0 }]) {
    assert.throws(() => new SqliteConversationStore(data, options), code("INVALID_INPUT"), JSON.stringify(options));
    assert.equal(existsSync(data), false, "and nothing was made");
  }
});

test("the store holds a bounded number of conversations and Turns, lets go of the least recently used, and reads a conversation it let go of again from its rows", t => {
  const { root, store } = openStore(t, { cache: { conversations: 3, runs: 8 } });
  const names = ["a", "b", "c", "d"], made = names.map(name => created(store, newConversation(root, name)).conversation.id);
  for (const id of made) new Scenario(store, id, "run-" + id.slice(8)).turn("question", "answer");
  const stats = store.cacheStats().conversations;
  assert.ok(stats.conversations <= 3 && stats.runs <= 8 && stats.evictions > 0, JSON.stringify(stats));
  // The oldest was let go; asking for it loads it again, as the object the rows give, equal to what was committed.
  const before = store.cacheStats().conversations.misses;
  const reloaded = store.get(made[0]!);
  assert.equal(store.cacheStats().conversations.misses, before + 1);
  assert.equal(reloaded.runs.length, 1); assert.equal(reloaded.runs[0]?.status, "completed");
  assert.equal(store.get(made[0]!), reloaded, "and is the one object of its version again");
  sound(store, made[0]!);
  // One conversation larger than the whole budget is still held: the one used last is never let go.
  const crowded = new Scenario(store, made[1]!, "run-b");
  for (let turn = 0; turn < 10; turn++) crowded.turn("again " + turn, "ok");
  const held = store.get(made[1]!);
  assert.equal(held.runs.length, 11); assert.equal(store.get(made[1]!), held);
  assert.ok(store.cacheStats().conversations.conversations >= 1);
  // A reducer that kept the object it was given from before the memory let it go is no worse off than slower: the commit finds what changed by value.
  sound(store, made[1]!);
});

test("a commit another connection made to the database is seen: the memory is dropped when the file changed under it, and the next read is the rows", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one")), id = made.conversation.id;
  assert.equal(store.get(id), made.conversation);
  const outsider = rawDatabase(data);
  outsider.prepare("UPDATE sessions SET status='blocked', version=version+1 WHERE id=?").run(id); outsider.close();
  const seen = store.get(id);
  assert.notEqual(seen, made.conversation); assert.equal(seen.status, "blocked"); assert.equal(seen.version, 2);
  assert.equal(store.get(id), seen);
  // And a commit made from the version the store held before is told it lost the race.
  assert.throws(() => store.transact(id, 1, current => ({ next: current, events: [event("late")] })), code("VERSION_CONFLICT"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Ownership of the data root
// ---------------------------------------------------------------------------------------------------------------------------------
interface PeerMessage { readonly type: string; readonly code?: string; readonly generation?: number }
async function peer(t: TestContext, data: string, mode = "hold"): Promise<{ readonly child: ChildProcess; readonly message: PeerMessage }> {
  const child = spawn(process.execPath, [peerPath, data, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostics = "";
  child.stderr?.on("data", value => { diagnostics += String(value); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGCONT"); child.kill("SIGKILL"); await once(child, "exit"); } });
  const message = await new Promise<PeerMessage>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("peer did not publish readiness: " + diagnostics)); }, 15_000);
    const onMessage = (value: unknown): void => {
      if (value === null || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return;
      const fields = value as Record<string, unknown>;
      cleanup(); resolve({ type: value.type, ...(typeof fields.code === "string" ? { code: fields.code } : {}), ...(typeof fields.generation === "number" ? { generation: fields.generation } : {}) });
    };
    const onExit = (): void => { cleanup(); reject(new Error("peer exited before readiness: " + diagnostics)); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError); };
    child.on("message", onMessage); child.once("exit", onExit); child.once("error", onError);
  });
  return { child, message };
}

test("two stores in one process are refused without losing the first's lock, and so is another process, paused or not", async t => {
  const { root, data, store } = openStore(t);
  assert.throws(() => new SqliteConversationStore(data), code("OWNER_BUSY")); store.assertOwner();
  store.close();
  const owner = await peer(t, data); assert.equal(owner.message.type, "ready");
  assert.throws(() => new SqliteConversationStore(data), code("OWNER_BUSY"));
  owner.child.kill("SIGSTOP");
  assert.throws(() => new SqliteConversationStore(data), code("OWNER_BUSY"));
  owner.child.kill("SIGCONT"); const stopped = once(owner.child, "exit"); owner.child.kill("SIGTERM"); await stopped;
  const acquired = new SqliteConversationStore(data);
  try { assert.equal(acquired.ownerGeneration, 3, "the first store was 1 and the process that ended was 2"); created(acquired, newConversation(root, "one")); } finally { acquired.close(); }
  const contender = await peer(t, data, "hold"); assert.equal(contender.message.type, "ready"); assert.equal(contender.message.generation, 4);
});

test("a process killed with work not finished leaves it for the next owner to end, never to replay: the Run that ran is unknown, the queued one cancelled, the switch failed, the open items closed", async t => {
  const data = join(temporary(t), "data");
  const owner = await peer(t, data, "unfinished"); assert.equal(owner.message.type, "ready");
  // A reader that is not the owner sees what the owner committed, and the lock holds against a second owner.
  const reader = rawDatabase(data, true);
  try { assert.equal(reader.prepare("SELECT status FROM runs WHERE ordinal=0").get()?.status, "running"); assert.equal(count(reader, "runs", "status='queued'"), 1); } finally { reader.close(); }
  assert.throws(() => new SqliteConversationStore(data), code("OWNER_BUSY"));
  const died = once(owner.child, "exit"); owner.child.kill("SIGKILL"); await died;
  const recovered = new SqliteConversationStore(data, { recover: recoverUnfinished });
  try {
    const state = recovered.get(sessionId("session-peer"));
    assert.equal(recovered.ownerGeneration, 2); assert.equal(state.status, "blocked"); assert.equal(state.activeRunId, null); assert.equal(state.pendingSwitchId, null);
    assert.deepEqual(state.runs.map(entry => entry.status), ["unknown", "cancelled"]);
    assert.equal(state.switches[0]?.status, "failed");
    assert.deepEqual(state.runs[0]?.endedSeq === state.lastSeq, true, "the end of the Run is the recovery's event");
    const turn = recovered.turnAt(state.id, 0)!;
    assert.deepEqual(turn.items.map(held => [held.itemId, held.status]), [["user", "completed"], ["text:1", "unknown"], ["tool:t1", "unknown"], ["permission:p1", "cancelled"]]);
    assert.equal(turn.items[1]!.text.join(""), "half an ans", "the words that were committed are still there");
    const recovery = recovered.events(state.id, state.lastSeq - 1)[0]; assert.equal(recovery?.type, "session.recovered"); assert.equal(recovery?.data.replayed, false); assert.equal(recovery?.ownerGeneration, 2);
    sound(recovered, state.id);
    const before = state.lastSeq; recovered.close();
    const again = new SqliteConversationStore(data, { recover: recoverUnfinished });
    try { assert.equal(again.get(state.id).lastSeq, before, "a second start finds nothing to recover"); assert.equal(again.get(state.id).runs.length, 2); } finally { again.close(); }
  } finally { try { recovered.close(); } catch { /* closed above */ } }
});

test("the owner's files and its generation are watched on every call: a replaced lock file, a changed generation, a changed schema version, or a moved path ends the store", t => {
  {
    const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one"));
    renameSync(join(data, "owner.sqlite"), join(data, "owner.old.sqlite"));
    new DatabaseSync(join(data, "owner.sqlite")).close();
    assert.throws(() => store.assertOwner(), code("OWNER_LOST"));
    assert.throws(() => new SqliteConversationStore(data), code("OWNER_BUSY"));
    assert.throws(() => store.get(made.conversation.id), code("OWNER_LOST"));
    assert.throws(() => store.close(), code("OWNER_LOST"));
    assert.throws(() => new SqliteConversationStore(data), code("OWNER_UNCONFIRMED"));
  }
  {
    const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one"));
    const outsider = rawDatabase(data); outsider.exec("UPDATE owner_metadata SET owner_generation=owner_generation+1"); outsider.close();
    assert.throws(() => store.get(made.conversation.id), code("OWNER_LOST"));
    assert.throws(() => store.list(), code("OWNER_LOST"));
    assert.throws(() => store.events(made.conversation.id, 0), code("OWNER_LOST"));
    assert.throws(() => store.close(), code("OWNER_LOST"));
  }
  {
    const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one"));
    const outsider = rawDatabase(data); outsider.exec("PRAGMA user_version=99"); outsider.close();
    assert.throws(() => store.get(made.conversation.id), code("OWNER_LOST"));
    assert.throws(() => store.close(), code("OWNER_LOST"));
  }
  {
    const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one"));
    assert.throws(() => store.transact(made.conversation.id, 1, current => {
      renameSync(join(data, ".harness-gateway.json"), join(data, "old-marker.json"));
      writeFileSync(join(data, ".harness-gateway.json"), JSON.stringify({ application: "harness-gateway", schemaVersion: 1 }));
      return { next: { ...current, status: "blocked" }, events: [event("not.committed")] };
    }), code("OWNER_LOST"));
    assert.throws(() => store.close(), code("OWNER_LOST"));
    const outsider = rawDatabase(data);
    try { const row = outsider.prepare("SELECT version, last_seq FROM sessions").get(); assert.deepEqual({ ...row }, { version: 1, last_seq: 1 }); assert.equal(count(outsider, "events"), 1); } finally { outsider.close(); }
  }
  {
    const { store } = openStore(t);
    const lock: unknown = Reflect.get(store, "owner"); assert.ok(lock instanceof DatabaseSync); lock.exec("ROLLBACK");
    assert.throws(() => store.assertOwner(), code("OWNER_LOST")); assert.throws(() => store.close(), code("OWNER_LOST"));
  }
});

test("a store that is closed answers STORE_CLOSED, closing twice is fine, and the lock is free afterwards", t => {
  const { root, data, store } = openStore(t), made = created(store, newConversation(root, "one"));
  store.close(); store.close();
  assert.throws(() => store.get(made.conversation.id), code("STORE_CLOSED"));
  assert.throws(() => store.list(), code("STORE_CLOSED"));
  const next = new SqliteConversationStore(data);
  try { assert.equal(next.get(made.conversation.id).id, made.conversation.id); } finally { next.close(); }
});

test("a new root and its files are private, a directory that holds anything else and no marker is left alone, links and aliases are refused", t => {
  const parent = temporary(t), data = join(parent, "new"), store = new SqliteConversationStore(data);
  assert.equal(statSync(data).mode & 0o777, 0o700); assert.equal(statSync(join(data, "gateway.sqlite")).mode & 0o777, 0o600); store.close();
  const file = join(parent, "user-data.txt"); writeFileSync(file, "preserve me", { mode: 0o640 });
  const before = statSync(parent).mode;
  assert.throws(() => new SqliteConversationStore(parent), code("INVALID_STORAGE"));
  assert.equal(readFileSync(file, "utf8"), "preserve me"); assert.equal(statSync(parent).mode, before); assert.equal(readdirSync(parent).includes(".harness-gateway.json"), false);
  renameSync(join(data, "owner.sqlite"), join(data, "owner.original.sqlite")); symlinkSync(join(data, "owner.original.sqlite"), join(data, "owner.sqlite"));
  assert.throws(() => new SqliteConversationStore(data), error => error instanceof SessionError);
  const alias = join(data, "alias"); symlinkSync(data, alias);
  assert.throws(() => new SqliteConversationStore(alias), code("INVALID_STORAGE"));
  assert.throws(() => new SqliteConversationStore("relative/path"), code("INVALID_INPUT"));
});

test("a database of a version this build does not know, or one with tables and no version, is refused with the lock let go and nothing changed", t => {
  const root = temporary(t), data = join(root, "data");
  new SqliteConversationStore(data).close();
  const db = rawDatabase(data); db.exec("PRAGMA user_version=99"); db.close();
  assert.throws(() => new SqliteConversationStore(data), code("INVALID_DATA"));
  const free = new DatabaseSync(join(data, "owner.sqlite"), { timeout: 0 });
  try { free.exec("BEGIN EXCLUSIVE"); free.exec("ROLLBACK"); } finally { free.close(); }
  const unversioned = join(root, "unversioned");
  mkdirSync(unversioned, { mode: 0o700 }); writeFileSync(join(unversioned, ".harness-gateway.json"), JSON.stringify({ application: "harness-gateway", schemaVersion: 1 }));
  const other = new DatabaseSync(join(unversioned, "gateway.sqlite")); other.exec("CREATE TABLE something(x TEXT)"); other.close();
  assert.throws(() => new SqliteConversationStore(unversioned), code("INVALID_DATA"));
  const check = new DatabaseSync(join(unversioned, "gateway.sqlite"));
  try { assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema").all().map(row => row.name), ["something"]); } finally { check.close(); }
});

