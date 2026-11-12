import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sessionId, type SessionEvent, type SessionSnapshot } from "../../src/contracts/session.js";
import { migrateToV14 } from "../../src/infrastructure/session/migrate-v14.js";
import { parseSession } from "../../src/infrastructure/session/legacy/state.js";
import { canonicalJson } from "../../src/infrastructure/session/rows.js";
import { SqliteSessionReader } from "../../src/infrastructure/session/session-reader.js";
import { appStore } from "../fixtures/runtime-store.js";
import { loadV13Fixture, writeV13Root, type V13Fixture } from "../fixtures/storage/v13/database.js";
import { code, rawDatabase, temporary } from "../fixtures/store-helpers.js";

// The command-line tools (`sessions list/show/events`) read a data root without claiming it, whatever the Hub that wrote it was: a root of the store of snapshots (v13 and
// before), a root of tables, and a root whose upgrade to the tables was stopped half way, which holds conversations of both kinds. Only the Harness is absent: the roots are
// the frozen v13 fixtures written to temporary directories, and the tables are written by the store of this build.

const fixtureOf = (name: Parameters<typeof loadV13Fixture>[0]): V13Fixture => loadV13Fixture(name);
const snapshotOf = (fixture: V13Fixture, id: string): SessionSnapshot => parseSession(fixture.sessions.find(row => row.id === id)!.snapshot);
const eventsOf = (fixture: V13Fixture, id: string): readonly unknown[] => fixture.sessions.find(row => row.id === id)!.events;
/** What `list` says of a snapshot. */
const lineOf = (snapshot: SessionSnapshot) => ({ id: snapshot.id, status: snapshot.status, epoch: snapshot.epoch, selection: snapshot.selection, runs: snapshot.runs.length, lastSeq: snapshot.lastSeq });
const byId = <T extends { readonly id: string }>(list: readonly T[]): readonly T[] => [...list].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
/** A converted conversation reads back as the snapshot it was, one version on (the conversion is a commit) and with an empty list of bindings where it had none. */
const converted = (snapshot: SessionSnapshot): unknown => JSON.parse(canonicalJson({ ...snapshot, version: snapshot.version + 1, nativeBindings: snapshot.nativeBindings ?? [] }));
const normal = (snapshot: SessionSnapshot): unknown => JSON.parse(canonicalJson({ ...snapshot, nativeBindings: snapshot.nativeBindings ?? [] }));
function allEvents(reader: SqliteSessionReader, id: string): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = reader.events(sessionId(id), after, 7); if (page.length === 0) return all; all.push(...page); after = page.at(-1)!.seq; }
}

test("a root of the store of snapshots (v13) is listed, shown and paged as the fixture holds it, and the reader writes nothing", t => {
  const fixture = fixtureOf("commands"), data = join(temporary(t), "data");
  writeV13Root(data, [fixture]);
  const before = rawDatabase(data, true), rows = JSON.stringify(before.prepare("SELECT * FROM sessions ORDER BY id").all()), eventCount = before.prepare("SELECT COUNT(*) AS n FROM events").get()!.n; before.close();
  const reader = new SqliteSessionReader(data);
  t.after(() => reader.close());
  assert.deepEqual(reader.upgrade(), { kind: "not-started", version: 13 });
  assert.deepEqual(byId(reader.list(50)), byId(fixture.sessions.map(row => lineOf(snapshotOf(fixture, row.id)))), "one line a conversation, from the snapshot");
  assert.equal(reader.list(1).length, 1, "a page is as long as asked");
  for (const row of fixture.sessions) {
    assert.deepStrictEqual(reader.get(sessionId(row.id)), snapshotOf(fixture, row.id), row.id + ": the snapshot as the fixture holds it");
    assert.deepEqual(allEvents(reader, row.id), eventsOf(fixture, row.id), row.id + ": every event, in order, across pages");
    assert.deepEqual(reader.events(sessionId(row.id), row.lastSeq, 10), [], "nothing after the last");
  }
  assert.throws(() => reader.get(sessionId("session-nobody")), code("SESSION_NOT_FOUND"));
  assert.throws(() => reader.events(sessionId("session-nobody"), 0), code("SESSION_NOT_FOUND"));
  assert.throws(() => reader.list(0), code("INVALID_INPUT"));
  reader.close();
  const after = rawDatabase(data, true);
  try {
    assert.equal(Number(after.prepare("PRAGMA user_version").get()!.user_version), 13, "the root is as it was");
    assert.equal(JSON.stringify(after.prepare("SELECT * FROM sessions ORDER BY id").all()), rows); assert.equal(after.prepare("SELECT COUNT(*) AS n FROM events").get()!.n, eventCount);
  } finally { after.close(); }
});

test("a root of tables (v14) is listed, shown and paged as the store gives it", t => {
  const fixture = fixtureOf("switches"), data = join(temporary(t), "data");
  writeV13Root(data, [fixture]);
  const store = appStore(data, { now: () => new Date("2026-11-13T00:00:00.000Z") });
  const shown = new Map(fixture.sessions.map(row => [row.id, store.snapshot(sessionId(row.id))])), logged = new Map(fixture.sessions.map(row => [row.id, store.events(sessionId(row.id), 0, 100)]));
  store.close();
  const reader = new SqliteSessionReader(data);
  t.after(() => reader.close());
  assert.deepEqual(reader.upgrade(), { kind: "done" });
  assert.deepEqual(byId(reader.list(50)), byId([...shown.values()].map(lineOf)));
  for (const row of fixture.sessions) {
    assert.deepStrictEqual(reader.get(sessionId(row.id)), shown.get(row.id), row.id + ": the conversation in the shape of a snapshot, as the store gives it");
    assert.deepEqual(normal(reader.get(sessionId(row.id))), converted(snapshotOf(fixture, row.id)), row.id + ": which is the snapshot it was, one version on");
    assert.deepEqual(allEvents(reader, row.id), logged.get(row.id), row.id + ": every event, across pages");
  }
  assert.throws(() => reader.get(sessionId("session-nobody")), code("SESSION_NOT_FOUND"));
});

test("a root whose upgrade stopped half way is read as it is: each conversation in the kind it is, and the reader says the rest are not converted yet", t => {
  const fixture = fixtureOf("switches"), data = join(temporary(t), "data");
  writeV13Root(data, [fixture]);
  const order = fixture.sessions.map(row => row.id), victim = order[1]!;
  assert.ok(order.length >= 3);
  // The upgrade stops at the second conversation (its snapshot is one the frozen parse refuses), and that conversation is then put back as it was, so that all can be read.
  const original = JSON.stringify(fixture.sessions[1]!.snapshot), db = new DatabaseSync(join(data, "gateway.sqlite"));
  try {
    db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.status','weird') WHERE id=?").run(victim);
    const report = migrateToV14(db, { root: data });
    assert.equal(report.converted, 1); assert.equal(report.stopped?.sessionId, victim);
    db.prepare("UPDATE sessions SET head=? WHERE id=?").run(original, victim);
  } finally { db.close(); }
  const reader = new SqliteSessionReader(data);
  t.after(() => reader.close());
  const state = reader.upgrade();
  assert.equal(state.kind, "converting");
  assert.ok(state.kind === "converting" && state.converted === 1 && state.remaining === order.length - 1 && state.stopped?.sessionId === victim && /not converted yet/u.test(state.message), JSON.stringify(state));
  assert.deepEqual(byId(reader.list(50)), byId(fixture.sessions.map(row => lineOf(snapshotOf(fixture, row.id)))), "every conversation is listed, with what it said before it was converted");
  assert.deepEqual(normal(reader.get(sessionId(order[0]!))), converted(snapshotOf(fixture, order[0]!)), "the converted one is read from its rows");
  for (const id of order.slice(1)) assert.deepStrictEqual(reader.get(sessionId(id)), snapshotOf(fixture, id), id + ": an unconverted one is the snapshot it still is");
  for (const id of order) assert.deepEqual(allEvents(reader, id), eventsOf(fixture, id), id + ": the events do not depend on the kind");
});

test("a conversation the frozen parse refuses fails its own read and nothing else's", t => {
  const fixture = fixtureOf("switches"), data = join(temporary(t), "data");
  writeV13Root(data, [fixture]);
  const order = fixture.sessions.map(row => row.id), victim = order[1]!;
  const db = new DatabaseSync(join(data, "gateway.sqlite"));
  try { db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.status','weird') WHERE id=?").run(victim); } finally { db.close(); }
  const reader = new SqliteSessionReader(data);
  t.after(() => reader.close());
  assert.throws(() => reader.get(sessionId(victim)), code("INVALID_DATA"));
  assert.deepStrictEqual(reader.get(sessionId(order[0]!)), snapshotOf(fixture, order[0]!), "another conversation is read as it is");
  assert.deepEqual(allEvents(reader, victim), eventsOf(fixture, victim), "and the damaged one's events still can be");
  // The reader is not left broken by the refusal.
  assert.deepStrictEqual(reader.get(sessionId(order[2]!)), snapshotOf(fixture, order[2]!));
});
