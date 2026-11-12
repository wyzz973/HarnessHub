import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import type { Conversation, ConversationRun } from "../../src/contracts/conversation.js";
import {
  RelayError, parseDeliveryRecord, parseRelayPacket,
  type BindingRelayState, type DeliveryRecord, type RelayPacket, type RelayRows, type RunSpan,
} from "../../src/contracts/relay.js";
import { runId, sessionId, type NativeSessionBinding, type SessionId } from "../../src/contracts/session.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/delivery.js";
import { SqliteConversationStore, type SqliteConversationStoreOptions } from "../../src/infrastructure/session/conversation-store.js";
import { event } from "../fixtures/conversation-builder.js";
import { Scenario, code, count, created, newConversation, openStore, rawDatabase, recoverUnfinished, temporary } from "../fixtures/store-helpers.js";

// The relay's rows beside a conversation kept as tables (ADR-055 §14, ADR-057 3.7): what a commit may write for the relay and the checks that come first, the delivery
// outcomes along their table, the handoff log and the preference, the relay's part of recovery in a SAVEPOINT of its own, and the packet texts that are let go at a quota
// instead of refused. The store is real and so are its rows; nothing here runs a Harness.

const hex = (char: string) => char.repeat(64);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const reason = (expected: string) => (error: unknown): boolean => error instanceof RelayError && error.reason === expected;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function packetIdOf(seed: string): string { return "relay-" + Array.from(createHash("sha256").update(seed).digest().subarray(0, 20), byte => CROCKFORD[byte % 32]).join(""); }
/** A packet manifest for `body` as the coordinator makes one, quoting the Runs `quoted` (their ordinals in the conversation). */
function packetOf(body: string, quoted: readonly RunSpan[], extra: Readonly<Record<string, unknown>> = {}): RelayPacket {
  return parseRelayPacket({ id: packetIdOf(body), kind: "packet", tier: "full",
    target: { harnessId: "alpha", controlId: "alpha-acp", model: null, nativeEpoch: 1 },
    range: { fromSeq: 0, throughSeq: 8, fromRun: 0, throughRun: 1 }, runs: quoted, supersedes: null, policyVersion: "relay/1", language: "en", repeat: false,
    attachOverride: false, firstLineOmitted: null, redactions: 0,
    body: { sha256: sha(body), bytes: Buffer.byteLength(body, "utf8"), estTokens: 12 },
    budget: { capTokens: 8000, window: 200_000, windowSource: "assumed", clampedBy: [] }, omissions: [], ...extra });
}
function deliveryOf(run: string, packet: RelayPacket, extra: Readonly<Record<string, unknown>> = {}): DeliveryRecord {
  return parseDeliveryRecord({ runId: run, packetId: packet.id, channel: "single_text", outcome: { kind: "in_flight" }, handoffLogSeq: null, inputHmac: hex("c"),
    redaction: { rulesVersion: "egress/1", keyId: "key-1", setHmac: "0a1b2c3d" }, autoResend: false, ...extra });
}
const decided = (kind: "recorded" | "not_recorded" | "unknown", seq = 1) => kind === "recorded" ? { kind, evidence: "E3" as const, decidedSeq: seq, decidedAt: 30 }
  : kind === "not_recorded" ? { kind, reason: "rejected_before_insert" as const, decidedSeq: seq, decidedAt: 30 } : { kind, reason: "no_evidence" as const, decidedSeq: seq, decidedAt: 30 };

/** One transaction on `id` that changes nothing of the conversation and writes `relay`. */
function write(store: SqliteConversationStore, id: SessionId, relay: RelayRows) {
  const current = store.get(id);
  return store.transact(id, current.version, state => ({ next: state, events: [event("fixture.relay")], relay }));
}
function outcomeOf(store: SqliteConversationStore, id: SessionId, run: string): DeliveryRecord["outcome"]["kind"] | undefined {
  return store.relayDeliveries(id).find(row => row.runId === run)?.outcome.kind;
}
interface Seeded { readonly id: SessionId; readonly scenario: Scenario; readonly runs: () => readonly ConversationRun[]; readonly binding: NativeSessionBinding }
/**
 * A conversation on alpha with Turns one and two finished and, unless `running` is false, Turn three running; queued inputs follow when asked for. The native session of
 * alpha was settled by Turn two, as a Runtime leaves it.
 */
function seeded(store: SqliteConversationStore, workspace: string, name: string, options: { readonly running?: boolean; readonly queued?: number } = {}): Seeded {
  const made = created(store, newConversation(workspace, name)), id = made.conversation.id, scenario = new Scenario(store, id, "run-" + name);
  scenario.turn("input one", "reply one"); scenario.turn("input two", "reply two");
  const binding: NativeSessionBinding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-" + name, throughRunId: runId("run-" + name + "-1"), status: "ready", relay: initialBindingRelay([], "alpha", "alpha-acp", "new") };
  store.transact(id, store.get(id).version, current => ({ next: { ...current, nativeBindings: [binding] }, events: [event("native.binding_prepared")] }));
  if (options.running !== false) scenario.open("input three", "being said");
  for (let queued = 0; queued < (options.queued ?? 0); queued++) scenario.accept("queued " + queued);
  return { id, scenario, runs: () => store.get(id).runs, binding };
}
const sound = (store: SqliteConversationStore, id: SessionId): void => assert.deepEqual(verify(store.get(id), store), []);

test("the relay tables of a new database are STRICT, a packet may lose its body and a manifest has no ceiling", t => {
  const { data, store } = openStore(t);
  store.close();
  const db = rawDatabase(data, true);
  try {
    for (const table of ["relay_bodies", "relay_packets", "relay_deliveries", "relay_index", "relay_log", "relay_prefs"]) assert.match(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)?.sql), /\)\s*STRICT$/u, table + " is STRICT");
    assert.doesNotMatch(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='relay_packets'").get()?.sql), /65536|body_sha256 TEXT NOT NULL/u);
    assert.doesNotMatch(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='relay_bodies'").get()?.sql), /262144/u);
  } finally { db.close(); }
});

test("a packet that quotes an unfinished Turn, or one accepted after the current input, fails that Turn only and leaves nothing behind", t => {
  const { root, data, store } = openStore(t), refused = seeded(store, root, "refused", { queued: 1 }), kept = seeded(store, root, "kept");
  const three = refused.runs()[2]!, one = refused.runs()[0]!;
  const bodies = new Map<string, string>();
  const make = (text: string, quoted: readonly RunSpan[]) => { const packet = packetOf(text, quoted); bodies.set(packet.id, text); return packet; };
  const attempt = (packet: RelayPacket, current = three) => () => write(store, refused.id, { packets: [{ runId: current.id, packet, body: bodies.get(packet.id)! }], deliveries: [{ kind: "insert", record: deliveryOf(current.id, packet) }] });
  // The current Turn itself and a queued Turn have not finished.
  for (const quoted of [[0, 2], [3], [[0, 2]]] as const) assert.throws(attempt(make("unfinished " + JSON.stringify(quoted), quoted)), reason("render"));
  // Turn two's input came after Turn one's: one cannot quote it.
  assert.throws(attempt(make("later input", [1]), one), reason("render"));
  // A span past the last Turn is refused without being walked.
  assert.throws(attempt(make("far away", [[0, 1_000_000_000]])), reason("render"));
  const db = rawDatabase(data, true);
  try { for (const table of ["relay_bodies", "relay_packets", "relay_deliveries"]) assert.equal(count(db, table, "session_id='session-refused'"), 0, table); } finally { db.close(); }
  // The store goes on; the Turn ends failed with the relay's code, as the coordinator will record it.
  store.assertOwner();
  const failed = refused.scenario.finish(2, "failed");
  assert.equal(failed.conversation.runs[2]?.status, "failed");
  sound(store, refused.id);
  // Finished Turns accepted before the current input are quoted as they are, singly or as spans.
  const good = packetOf("quotes finished Turns", [[0, 1]]);
  const committed = write(store, kept.id, { packets: [{ runId: kept.runs()[2]!.id, packet: good, body: "quotes finished Turns" }], deliveries: [{ kind: "insert", record: deliveryOf(kept.runs()[2]!.id, good) }] });
  assert.equal(committed.events.length, 1); assert.equal(outcomeOf(store, kept.id, kept.runs()[2]!.id), "in_flight");
  assert.equal(store.relayPacket(kept.id, good.id)?.id, good.id); assert.equal(store.relayPacket(refused.id, good.id), null, "another conversation's packet is none");
  assert.equal(store.relayPacketBody(kept.id, good.body.sha256), "quotes finished Turns"); assert.equal(store.relayPacketBody(refused.id, good.body.sha256), null);
  assert.deepEqual(store.relayPackets(kept.id).map(packet => packet.id), [good.id]);
});

test("delivery rows move along the table: in flight to any decided outcome, a decided one only to itself", t => {
  const { root, store } = openStore(t), state = seeded(store, root, "deliveries", { running: false });
  // Ten more finished Turns, each with its own delivery of one packet.
  for (let turn = 0; turn < 10; turn++) state.scenario.turn("more " + turn, "reply");
  const turns = state.runs().slice(2), packet = packetOf("one packet for every Turn", [0]);
  write(store, state.id, { packets: [{ runId: turns[0]!.id, packet, body: "one packet for every Turn" }], deliveries: turns.map(row => ({ kind: "insert" as const, record: deliveryOf(row.id, packet) })) });
  const move = (index: number, kind: "recorded" | "not_recorded" | "unknown") => write(store, state.id, { deliveries: [{ kind: "outcome", runId: turns[index]!.id, outcome: decided(kind) }] });
  const allowed: readonly (readonly ("recorded" | "not_recorded" | "unknown")[])[] = [["recorded"], ["not_recorded"], ["unknown"], ["unknown", "unknown"], ["not_recorded", "not_recorded"], ["recorded", "recorded"]];
  for (const [index, path] of allowed.entries()) { for (const kind of path) move(index, kind); assert.equal(outcomeOf(store, state.id, turns[index]!.id), path.at(-1), path.join(" → ")); }
  for (const [index, to] of [[0, "unknown"], [0, "not_recorded"], [1, "unknown"], [1, "recorded"], [2, "recorded"], [2, "not_recorded"]] as const)
    assert.throws(() => move(index, to), code("INVALID_TRANSITION"), "from " + outcomeOf(store, state.id, turns[index]!.id) + " to " + to);
  assert.throws(() => write(store, state.id, { deliveries: [{ kind: "outcome", runId: turns[8]!.id, outcome: { kind: "in_flight" } as never }] }), code("INVALID_TRANSITION"));
  assert.throws(() => write(store, state.id, { deliveries: [{ kind: "outcome", runId: runId("run-nowhere-0"), outcome: decided("unknown") }] }), code("INVALID_DATA"));
  store.assertOwner(); sound(store, state.id);
  // A same-value write leaves the outcome out of its statement: a guard that refused any change of outcome to itself never fires.
  const db = rawDatabase(join(root, "data"));
  try {
    db.exec("CREATE TRIGGER fixture_same_outcome BEFORE UPDATE OF outcome ON relay_deliveries WHEN NEW.outcome=OLD.outcome BEGIN SELECT RAISE(ABORT,'same-value outcome in SET'); END");
    write(store, state.id, { deliveries: [{ kind: "outcome", runId: turns[3]!.id, outcome: { kind: "unknown", reason: "owner_ended", decidedSeq: 2, decidedAt: 40 } }] });
    assert.equal(outcomeOf(store, state.id, turns[3]!.id), "unknown");
    db.exec("DROP TRIGGER fixture_same_outcome");
    assert.throws(() => db.prepare("UPDATE relay_deliveries SET outcome='in_flight',evidence=NULL,reason=NULL,decided_seq=NULL WHERE session_id=? AND run_id=?").run(state.id, turns[0]!.id), /illegal delivery transition/u);
  } finally { db.close(); }
  store.assertOwner();
});

test("identity clashes and same-value writes end their own request and never the store, and a refused write leaves a bystander conversation working", t => {
  const { root, data, store } = openStore(t), target = seeded(store, root, "faults"), bystander = seeded(store, root, "bystander", { running: false });
  const three = target.runs()[2]!;
  const alive = (): void => { const now = store.get(bystander.id); store.transact(bystander.id, now.version, state => ({ next: state, events: [event("fixture.alive")] })); };
  const packet = packetOf("first text", [0]);
  write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
  // One packet identity with two texts; a second delivery for one Turn; a text that is not its manifest's.
  const clash = parseRelayPacket({ ...packet, body: { ...packet.body, sha256: sha("other text"), bytes: Buffer.byteLength("other text") } });
  assert.throws(() => write(store, target.id, { packets: [{ runId: three.id, packet: clash, body: "other text" }] }), reason("render_mismatch"));
  assert.throws(() => write(store, target.id, { deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] }), reason("storage"));
  assert.throws(() => write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text but longer" }] }), reason("render"), "a text that is not its manifest's");
  assert.throws(() => write(store, target.id, { packets: [{ runId: three.id, packet, body: "first\0text" }] }), reason("render"), "a text with a NUL");
  assert.throws(() => write(store, target.id, { packets: [{ runId: runId("run-bystander-0"), packet, body: "first text" }] }), code("INVALID_DATA"), "a Turn of another conversation");
  assert.throws(() => write(store, target.id, { deliveries: [{ kind: "insert", record: deliveryOf(three.id, packetOf("never written", [0])) }] }), reason("storage"));
  alive();
  // The same text sent again by the same packet identity is kept once.
  write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text" }] });
  // Same-value writes.
  write(store, target.id, { deliveries: [{ kind: "outcome", runId: three.id, outcome: decided("unknown") }] });
  write(store, target.id, { deliveries: [{ kind: "outcome", runId: three.id, outcome: { kind: "unknown", reason: "owner_ended", decidedSeq: 9, decidedAt: 50 } }] });
  alive(); store.assertOwner();
  const check = rawDatabase(data, true);
  try { assert.equal(count(check, "relay_packets", "session_id='session-faults'"), 1); assert.equal(count(check, "relay_bodies", "session_id='session-faults'"), 1); } finally { check.close(); }
  sound(store, target.id);
});

test("a relay state that names a packet the conversation does not keep is refused with the transaction, and accepted when the packet is written with it", t => {
  const { root, store } = openStore(t), state = seeded(store, root, "references", { queued: 1 });
  const binding = state.binding, missing = packetOf("never written", [0]), three = state.runs()[2]!;
  const pending: BindingRelayState = { ...binding.relay!, pending: { packetId: missing.id, fromSeq: 0, throughSeq: 3, autoResends: 0 } };
  const move = (relay?: RelayRows) => store.transact(state.id, store.get(state.id).version, now => ({ next: { ...now, nativeBindings: [{ ...now.nativeBindings![0]!, relay: pending }] }, events: [event("fixture.pending")], ...(relay === undefined ? {} : { relay }) }));
  const before = store.get(state.id);
  assert.throws(() => move(), code("INVALID_DATA"));
  assert.equal(store.get(state.id), before, "and nothing of it is in memory");
  move({ packets: [{ runId: three.id, packet: missing, body: "never written" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, missing) }] });
  assert.equal(store.get(state.id).nativeBindings?.[0]?.relay?.pending?.packetId, missing.id);
  sound(store, state.id);
  // A Turn that names a packet it did not write is refused the same way.
  const other = packetOf("another never written", [0]);
  assert.throws(() => store.transact(state.id, store.get(state.id).version, now => ({ next: { ...now, runs: now.runs.map(row => row.ordinal === 3 ? { ...row, relay: { packetId: other.id, kind: "packet" as const, continuity: { kind: "native_resume" as const }, executedOn: null } } : row) }, events: [event("fixture.names")] })), code("INVALID_DATA"));
  store.assertOwner();
});

test("the handoff log has one row for the first handoff to each Harness, and a delivery names it", t => {
  const { root, data, store } = openStore(t, { now: () => new Date("2026-11-11T12:00:00Z") });
  const first = store.logHandoff("codex");
  assert.deepEqual(first, { record: { logSeq: 1, harnessId: "codex", firstAt: Date.parse("2026-11-11T12:00:00Z") }, created: true });
  assert.deepEqual(store.logHandoff("codex"), { record: first.record, created: false }, "the same Harness again returns the first row");
  assert.equal(store.logHandoff("claude").record.logSeq, 2);
  assert.deepEqual(store.handoffs().map(row => row.harnessId), ["codex", "claude"]);
  assert.throws(() => store.logHandoff("Not A Harness"), code("INVALID_DATA"));
  assert.equal(store.handoffUsed(1), false, "no delivery names it yet");
  const state = seeded(store, root, "handoff"), three = state.runs()[2]!, packet = packetOf("a handoff packet", [0]);
  write(store, state.id, { packets: [{ runId: three.id, packet, body: "a handoff packet" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet, { handoffLogSeq: 1 }) }] });
  assert.equal(store.handoffUsed(1), true); assert.equal(store.handoffUsed(2), false);
  const db = rawDatabase(data);
  try {
    assert.throws(() => db.prepare("UPDATE relay_log SET first_at=0 WHERE seq=1").run(), /append-only/u, "the log is append-only");
    assert.throws(() => db.prepare("INSERT INTO relay_log(harness_id,first_at) VALUES('codex',5)").run(), /UNIQUE/u, "one row per Harness");
  } finally { db.close(); }
  store.assertOwner();
});

test("relay_prefs takes the one key with its values and the last writer wins, and a table made with the old keys is rebuilt when the store opens", t => {
  const { data, store } = openStore(t);
  assert.deepEqual(store.relayPrefs(), {});
  store.setPref("relay.attach", "off"); store.setPref("relay.attach", "auto"); store.setPref("relay.attach", "off");
  assert.deepEqual(store.relayPrefs(), { "relay.attach": "off" });
  for (const [key, value] of [["relay.elsewhere", "x"], ["relay.crossVendor", "allow"], ["relay.attach", "always"], ["relay.attach", "x".repeat(65)]] as const)
    assert.throws(() => store.setPref(key as never, value), code("INVALID_DATA"), key + "=" + value);
  store.assertOwner(); store.close();
  const db = rawDatabase(data);
  db.exec("DROP TABLE relay_prefs");
  db.exec("CREATE TABLE relay_prefs(key TEXT PRIMARY KEY CHECK(key IN('relay.crossVendor','relay.attach')), value TEXT NOT NULL CHECK(length(value)<=64), updated_at INTEGER NOT NULL) STRICT");
  db.prepare("INSERT INTO relay_prefs VALUES('relay.crossVendor','ask',1),('relay.attach','off',2)").run();
  db.close();
  const reopened = new SqliteConversationStore(data);
  try { assert.deepEqual(reopened.relayPrefs(), { "relay.attach": "off" }); reopened.setPref("relay.attach", "auto"); assert.deepEqual(reopened.relayPrefs(), { "relay.attach": "auto" }); } finally { reopened.close(); }
});

test("the relay's part of recovery runs in a SAVEPOINT of its own: one conversation's failure marks only that conversation, and the recovery itself is committed either way", t => {
  const root = temporary(t), data = join(root, "data"), first = new SqliteConversationStore(data);
  for (const name of ["kept", "failing"]) {
    const state = seeded(first, root, name), three = state.runs()[2]!, packet = packetOf("packet of " + name, [0]);
    write(first, state.id, { packets: [{ runId: three.id, packet, body: "packet of " + name }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
  }
  first.close();
  const seen: string[] = [];
  const recoverRelay = ((state: Conversation, deliveries: readonly DeliveryRecord[]) => {
    seen.push(state.id + ":" + deliveries.map(row => row.outcome.kind).join(","));
    if (state.id === "session-failing") throw new Error("injected relay recovery failure");
    return { next: state, deliveries: deliveries.map(row => ({ runId: row.runId, outcome: { kind: "unknown" as const, reason: "owner_ended" as const, decidedSeq: state.lastSeq + 1, decidedAt: 99 } })) };
  }) as unknown as NonNullable<SqliteConversationStoreOptions["recoverRelay"]>;
  const store = new SqliteConversationStore(data, { recover: recoverUnfinished, recoverRelay });
  t.after(() => { try { store.close(); } catch { /* closed below */ } });
  assert.deepEqual(seen.sort(), ["session-failing:in_flight", "session-kept:in_flight"]);
  const kept = store.get(sessionId("session-kept")), failing = store.get(sessionId("session-failing"));
  assert.equal(kept.status, "blocked"); assert.equal(failing.status, "blocked"); assert.equal(kept.runs[2]?.status, "unknown"); assert.equal(failing.runs[2]?.status, "unknown");
  assert.equal(outcomeOf(store, kept.id, kept.runs[2]!.id), "unknown"); assert.equal(outcomeOf(store, failing.id, failing.runs[2]!.id), "in_flight", "its relay rows rolled back");
  assert.equal(kept.relayRecoveryFailed, undefined); assert.equal(failing.relayRecoveryFailed, failing.lastSeq, "the failure is at the seq of the event that recovered it");
  const relayOf = (id: SessionId) => store.events(id, store.get(id).lastSeq - 1).find(entry => entry.type === "session.recovered")!.data.relay;
  assert.deepEqual(relayOf(kept.id), { failed: false, deliveries: [{ runId: kept.runs[2]!.id, outcome: "unknown" }], bindings: [{ harnessId: "alpha", controlId: "alpha-acp", epoch: 1, pending: false }] });
  assert.deepEqual(relayOf(failing.id), { failed: true });
  sound(store, kept.id); sound(store, failing.id);
  assert.equal(store.head(failing.id).head.relayRecoveryFailed, failing.lastSeq);
  store.close();
  // Without a relay recovery, recovery is what it was: its event has no relay part.
  const again = join(temporary(t), "data"), plain = new SqliteConversationStore(again); seeded(plain, join(again, ".."), "plain"); plain.close();
  const reopened = new SqliteConversationStore(again, { recover: recoverUnfinished });
  try { const state = reopened.get(sessionId("session-plain")); assert.equal(reopened.events(state.id, state.lastSeq - 1)[0]?.data.relay, undefined); assert.equal(state.relayRecoveryFailed, undefined); } finally { reopened.close(); }
});

test("a relay recovery that gives something that is not a conversation is a failure of its part and no more", t => {
  const root = temporary(t), data = join(root, "data"), first = new SqliteConversationStore(data);
  seeded(first, root, "odd"); first.close();
  const store = new SqliteConversationStore(data, { recover: recoverUnfinished, recoverRelay: (() => ({ next: { not: "a conversation" }, deliveries: [] })) as never });
  try {
    const state = store.get(sessionId("session-odd"));
    assert.equal(state.runs[2]?.status, "unknown"); assert.equal(state.relayRecoveryFailed, state.lastSeq);
    assert.deepEqual(store.events(state.id, state.lastSeq - 1)[0]?.data.relay, { failed: true });
  } finally { store.close(); }
});

test("past its quota a conversation lets go of the oldest packet texts nothing in flight rests on, keeps their manifests and evidence, and never refuses a write for room", t => {
  const { root, data, store } = openStore(t, { relayBodyQuotaBytes: 100 }), state = seeded(store, root, "quota", { running: false });
  for (let turn = 0; turn < 8; turn++) state.scenario.turn("more " + turn, "reply");
  const turns = state.runs().slice(2), text = (letter: string) => letter.repeat(40);
  const send = (index: number, letter: string) => { const packet = packetOf(text(letter), [0]); write(store, state.id, { packets: [{ runId: turns[index]!.id, packet, body: text(letter) }], deliveries: [{ kind: "insert", record: deliveryOf(turns[index]!.id, packet) }] }); return packet; };
  const decide = (index: number) => write(store, state.id, { deliveries: [{ kind: "outcome", runId: turns[index]!.id, outcome: decided("recorded") }] });
  const body = (packet: RelayPacket): string | null => store.relayPacketBody(state.id, packet.body.sha256);
  const a = send(0, "a"); decide(0);
  const b = send(1, "b"); decide(1);
  assert.equal(body(a), text("a")); assert.equal(body(b), text("b"), "80 bytes fit in 100");
  // The third would pass the quota: the oldest delivered text goes, and the third is kept.
  const c = send(2, "c");
  assert.equal(body(a), null, "the oldest text is let go"); assert.equal(body(b), text("b")); assert.equal(body(c), text("c"));
  assert.equal(store.relayPacket(state.id, a.id)?.id, a.id, "its manifest stays"); assert.equal(outcomeOf(store, state.id, turns[0]!.id), "recorded", "and the evidence of its delivery");
  const db = rawDatabase(data, true);
  try { assert.equal(db.prepare("SELECT body_sha256 FROM relay_packets WHERE packet_id=?").get(a.id)?.body_sha256, null); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM relay_packets").get()?.n, 3); } finally { db.close(); }
  // A packet row is immutable but for losing its body: nothing else can change, and a body does not come back to it.
  const writer = rawDatabase(data);
  try {
    assert.throws(() => writer.prepare("UPDATE relay_packets SET tier='brief' WHERE packet_id=?").run(b.id), /relay packet is immutable/u);
    assert.throws(() => writer.prepare("UPDATE relay_packets SET body_sha256=? WHERE packet_id=?").run(a.body.sha256, a.id), /relay packet is immutable/u);
  } finally { writer.close(); }
  // c is in flight, so d lets go of b (decided) and not of c.
  const d = send(3, "d");
  assert.equal(body(b), null); assert.equal(body(c), text("c")); assert.equal(body(d), text("d"));
  // Texts that deliveries in flight rest on are not let go, however far past the quota: e is written, and nothing is refused.
  const e = send(4, "e");
  assert.equal(body(c), text("c")); assert.equal(body(d), text("d")); assert.equal(body(e), text("e"), "120 bytes in a quota of 100, all of them in flight");
  decide(2); decide(3); decide(4);
  const f = send(5, "f");
  assert.equal(body(c), null); assert.equal(body(d), null); assert.equal(body(e), text("e")); assert.equal(body(f), text("f"));
  // The same packet sent again after its text was let go: the text is kept again (found by its digest), under the packet row that is there already, which does not change.
  decide(5);
  write(store, state.id, { packets: [{ runId: turns[6]!.id, packet: a, body: text("a") }], deliveries: [{ kind: "insert", record: deliveryOf(turns[6]!.id, a) }] });
  assert.equal(body(a), text("a")); assert.equal(body(e), null, "and e made room, being delivered"); assert.equal(body(f), text("f"));
  const after = rawDatabase(data, true);
  try { assert.equal(after.prepare("SELECT COUNT(*) AS n FROM relay_packets WHERE packet_id=?").get(a.id)?.n, 1); assert.equal(after.prepare("SELECT body_sha256 FROM relay_packets WHERE packet_id=?").get(a.id)?.body_sha256, null); } finally { after.close(); }
  sound(store, state.id);
});

test("the index rows of a migrated conversation are read back as they were written, and the relay's rows are keyed to a conversation of their own", t => {
  const { root, data, store } = openStore(t), state = seeded(store, root, "index");
  const db = rawDatabase(data);
  try { db.prepare("INSERT INTO relay_index(session_id,run_id,run_index,index_json) VALUES(?,?,0,?)").run(state.id, state.runs()[0]!.id, JSON.stringify({ runId: state.runs()[0]!.id, index: 0, seq: 3 })); } finally { db.close(); }
  assert.deepEqual(store.relayIndex(state.id), [{ runId: state.runs()[0]!.id, index: { runId: state.runs()[0]!.id, index: 0, seq: 3 } }]);
  assert.deepEqual(store.relayIndex(sessionId("session-elsewhere")), []);
  assert.deepEqual(store.relayDeliveries(state.id), []);
});
