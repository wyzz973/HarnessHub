import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { RelayLedger } from "../../src/contexts/session/application/relay-coordinator.js";
import { noticePrint } from "../../src/contexts/session/domain/items-place.js";
import { renderRelay } from "../../src/contexts/session/domain/relay/packet.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { storageConversion } from "../../src/contexts/session/domain/store-conversion.js";
import type { ConvertedRun, StorageConversion } from "../../src/contracts/conversation.js";
import type { RelayIndexRow } from "../../src/contracts/relay.js";
import { SessionError, sessionId, type SessionEvent, type SessionSnapshot } from "../../src/contracts/session.js";
import { conversationTitle } from "../../src/contracts/web.js";
import { backupBeforeV14, databaseBytes } from "../../src/infrastructure/session/backup.js";
import { climbToV13 } from "../../src/infrastructure/session/legacy/ladder.js";
import { LegacyRelayLedger } from "../../src/infrastructure/session/legacy/ledger.js";
import { parseSession as liveParse } from "../../src/infrastructure/session/legacy/state.js";
import {
  acknowledgeFirstStart, collectionGate, compareReferences, convertConversation, migrateToV14, migrationState, relayFactsFromRows, upgradeSchema,
} from "../../src/infrastructure/session/migrate-v14.js";
import { loadConversation } from "../../src/infrastructure/session/load.js";
import { ConversationTables } from "../../src/infrastructure/session/read.js";
import { canonicalJson } from "../../src/infrastructure/session/rows.js";
import { schemaV14Statements } from "../../src/infrastructure/session/schema-v14.js";
import { indexStates, rebuildSearchIndex } from "../../src/infrastructure/session/search-index.js";
import { snapshotFromRows } from "../../src/infrastructure/session/snapshot-adapter.js";
import { appStore } from "../fixtures/runtime-store.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { V12_FIXTURES, loadV12Fixture, writeV12Root } from "../fixtures/relay/v12/database.js";
import { GENERATIONS, loadGeneration, writeGenerationRoot } from "../fixtures/storage/generations/database.js";
import { V13_FIXTURES, later, loadV13Fixture, writeV13Root, type V13Fixture, type V13FixtureName } from "../fixtures/storage/v13/database.js";
import { syntheticFixture } from "../fixtures/synthetic-v13.js";

// The migration engine of ADR-057 3.6 (src/infrastructure/session/migrate-v14.ts): every frozen fixture of every generation converts to v14 and checks; what the checks
// are is shown by breaking each of them; a conversation that does not check stops the migration with the others as they were; a process killed at any moment and
// started again leaves the rows an uninterrupted one leaves; the backup, the space, the full-text index and the gate for the content collector. All of it on copies in
// temporary directories: nothing here opens a real database.

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const peerPath = join(repository, "tests/fixtures/migration-peer.mjs");

// ---------------------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------------------
const closers = new WeakMap<TestContext, (() => unknown)[]>();
/** A temporary directory removed after the test, once what was opened in it is closed (last opened, first closed). */
function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "migrate-v14-")), owned: (() => unknown)[] = [];
  closers.set(t, owned);
  t.after(() => { for (const close of owned.reverse()) { try { close(); } catch { /* already closed */ } } rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
function connect(t: TestContext, root: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(join(root, "gateway.sqlite"), readOnly ? { readOnly: true } : {});
  closers.get(t)!.push(() => db.close());
  return db;
}
/**
 * The fixtures made fit for one database: each of them was made alone, and two hold the same native session (`native-alpha-1`), which one database never does
 * (the v13 store refused it, and the new tables key on it). All but the first get their native sessions renamed.
 */
function together(fixtures: readonly V13Fixture[]): readonly V13Fixture[] {
  return fixtures.map((fixture, index) => {
    if (index === 0) return fixture;
    const own = new Set(fixture.sessions.flatMap(row => ((row.snapshot.nativeBindings ?? []) as readonly { checkpoint: string }[]).map(binding => binding.checkpoint)));
    const swap = (value: unknown): unknown => typeof value === "string" ? (own.has(value) ? value + "-f" + index : value) : Array.isArray(value) ? value.map(swap)
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, swap(item)])) : value;
    return { ...fixture, sessions: fixture.sessions.map(row => ({ ...row, snapshot: swap(row.snapshot) as Record<string, unknown>, events: swap(row.events) as typeof row.events })) };
  });
}
/** A data root holding `fixtures` as a v13 database, and the connection to it. */
function v13Root(t: TestContext, fixtures: readonly V13Fixture[]): { readonly root: string; readonly db: DatabaseSync } {
  const root = join(temporary(t), "data");
  writeV13Root(root, together(fixtures));
  return { root, db: connect(t, root) };
}
const userVersion = (db: DatabaseSync): number => Number(db.prepare("PRAGMA user_version").get()?.user_version);
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => Number(db.prepare(sql).get(...args)?.n);
type Dump = Readonly<Record<string, readonly string[]>>;
/** Everything the database holds that is not a full-text index: its schema, its version, and every row of every table (as text, sorted), so that two databases can be compared whole. */
function dumpOf(db: DatabaseSync): Dump {
  const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const out: Record<string, readonly string[]> = { "#schema": schema.map(row => JSON.stringify(row)), "#user_version": [String(userVersion(db))] };
  for (const row of schema) {
    const name = String(row.name);
    if (row.type !== "table" || /^search_/u.test(name) || !String(row.sql).startsWith("CREATE TABLE")) continue;
    out[name] = db.prepare('SELECT * FROM "' + name + '"').all().map(entry => JSON.stringify(entry)).sort();
  }
  return out;
}
function rowsOf(db: DatabaseSync, table: string): readonly string[] { return dumpOf(db)[table] ?? []; }
/** The snapshot text of every conversation, by id, as the database holds it before the first transaction (`snapshot`) or after (`head`, while it is not converted). */
function snapshotsOf(db: DatabaseSync): Map<string, string> {
  const column = userVersion(db) >= 14 ? "head" : "snapshot";
  return new Map(db.prepare("SELECT id, " + column + " AS text FROM sessions ORDER BY rowid").all().map(row => [String(row.id), String(row.text)]));
}
/** What a converted conversation reads back as, held to the snapshot it came from: the same but for the version (one more) and an empty list of bindings where there were none. */
function assertReadsBack(db: DatabaseSync, id: string, original: string, where: string): void {
  const before = JSON.parse(original) as SessionSnapshot, back = snapshotFromRows(db, sessionId(id));
  const expected = { ...before, version: before.version + 1, nativeBindings: before.nativeBindings ?? [] };
  assert.deepStrictEqual(JSON.parse(canonicalJson({ ...back, nativeBindings: back.nativeBindings ?? [] })), JSON.parse(canonicalJson(expected)), where);
}
const ok = (db: DatabaseSync): void => {
  assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map(row => ({ ...row })), [{ integrity_check: "ok" }]);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
};
/** The named fixtures that can share one database (no two hold the same conversation), in the order given. */
function sharable(names: readonly V13FixtureName[]): V13Fixture[] {
  const taken = new Set<string>(), chosen: V13Fixture[] = [];
  for (const name of names) {
    const fixture = loadV13Fixture(name);
    if (fixture.sessions.some(row => taken.has(row.id)) || fixture.createKeys.some(row => taken.has("key:" + row.commandId))) continue;
    for (const row of fixture.sessions) taken.add(row.id);
    for (const row of fixture.createKeys) taken.add("key:" + row.commandId);
    chosen.push(fixture);
  }
  return chosen;
}
function codeOf(expected: string): (error: unknown) => boolean { return error => error instanceof SessionError && error.code === expected; }
const BACKUP = "gateway-v13-before-v14.sqlite";

// ---------------------------------------------------------------------------------------------------------------------------------
// Every v13 fixture converts, checks and reads back
// ---------------------------------------------------------------------------------------------------------------------------------
const timings: { readonly name: string; readonly bytes: number; readonly ms: number }[] = [];
for (const name of V13_FIXTURES) {
  test(`${name}: converts to v14, every conversation checks and reads back as it was, and what is not a conversation is as it was`, t => {
    const fixture = loadV13Fixture(name), { root, db } = v13Root(t, [fixture]);
    const originals = snapshotsOf(db), before = dumpOf(db);
    assert.deepEqual(migrationState(db), { kind: "not-started", version: 13 });
    const started = performance.now();
    // With the whole-conversation checker (T8): every conversation of every fixture, as converted, breaks none of its rules.
    const report = migrateToV14(db, { root, verify });
    timings.push({ name, bytes: [...originals.values()].reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0), ms: performance.now() - started });
    assert.equal(report.stopped, null);
    assert.equal(report.from, 13);
    assert.equal(report.converted, fixture.sessions.length);
    assert.equal(report.alreadyConverted, 0);
    assert.equal(report.references?.equal, true);
    assert.equal(userVersion(db), 14);
    assert.deepEqual(migrationState(db), { kind: "done" });
    ok(db);

    // Each conversation: the head's columns, and the rows read back as the snapshot it came from.
    for (const row of fixture.sessions) {
      const old = JSON.parse(originals.get(row.id)!) as SessionSnapshot, head = db.prepare("SELECT * FROM sessions WHERE id=?").get(row.id)!;
      assert.equal(head.format, 14, row.id);
      assert.equal(head.last_error, null, row.id);
      assert.equal(head.version, old.version + 1, row.id);
      assert.equal(head.last_seq, old.lastSeq, row.id);
      assert.equal(head.status, old.status, row.id);
      assert.equal(head.epoch, old.epoch, row.id);
      assert.equal(head.active_run_id, old.activeRunId, row.id);
      assert.equal(head.pending_switch_id, old.pendingSwitchId, row.id);
      assert.equal(head.kept, old.retained === undefined ? 0 : 1, row.id);
      assert.equal(head.title, conversationTitle(old), row.id);
      assert.equal(head.run_count, old.runs.length, row.id);
      assert.equal(head.updated_at, Date.parse(row.events.at(-1)?.timestamp ?? ""), row.id + ": the time of its last event");
      assert.equal(head.deleted_at, null, row.id);
      const small = JSON.parse(String(head.head)) as Record<string, unknown>;
      assert.equal(small.runs, undefined, row.id + ": the Runs are rows now");
      assert.equal(small.messages, undefined, row.id);
      assert.deepEqual(small.configuration, old.configuration, row.id);
      assert.deepEqual(small.selection, old.selection, row.id);
      assertReadsBack(db, row.id, originals.get(row.id)!, row.id);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM runs WHERE session_id=?", row.id), old.runs.length, row.id);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM commands WHERE session_id=?", row.id), old.commands.length, row.id);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM switches WHERE session_id=?", row.id), old.switches.length, row.id);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM bindings WHERE session_id=?", row.id), old.nativeBindings?.length ?? 0, row.id);
    }

    // What is not a conversation is as it was: the event log, the create keys, and the relay's rows (the two tables rebuilt keep every row and every value).
    const after = dumpOf(db);
    for (const table of ["events", "create_keys", "owner_metadata", "relay_bodies", "relay_packets", "relay_deliveries", "relay_index", "relay_log", "relay_prefs"])
      assert.deepEqual(after[table], before[table], table + " is as it was");
    // The content the conversations still refer to is the set the v13 store that wrote the fixture worked out.
    assert.deepEqual([...new ConversationTables(db).contentReferences()].sort(), fixture.contentReferences, "the references the collector will use");
    // No full-text index was written; the Run's content references are the conversations' own.
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM search_fts"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM search_chars"), 0);
    assert.deepEqual(indexStates(db), { search_fts: "empty", search_chars: "empty" });
  });
}

test("the time to convert the largest fixture conversation, for the record", t => {
  const largest = [...timings].sort((left, right) => right.bytes - left.bytes)[0];
  assert.ok(largest !== undefined && timings.length >= V13_FIXTURES.length, "the fixtures ran first");
  t.diagnostic(`largest v13 fixture: ${largest.name}, ${largest.bytes} bytes of snapshots, converted in ${largest.ms.toFixed(1)} ms; slowest fixture ${[...timings].sort((left, right) => right.ms - left.ms)[0]!.ms.toFixed(1)} ms`);
  assert.ok(largest.ms < 5000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The older generations: the frozen ladder gives what the live store's ladder gives, and the result converts
// ---------------------------------------------------------------------------------------------------------------------------------
interface Generation { readonly label: string; readonly from: number; readonly write: (root: string) => void }
const GENERATION_ROOTS: Generation[] = [
  ...GENERATIONS.map((version): Generation => ({ label: `v${version}`, from: version, write: root => writeGenerationRoot(root, loadGeneration(version)) })),
  ...V12_FIXTURES.map((name): Generation => ({ label: `v12-${name}`, from: 12, write: root => writeV12Root(root, [loadV12Fixture(name)]) })),
];
for (const generation of GENERATION_ROOTS) {
  test(`${generation.label}: the frozen ladder climbs to v13 (conversations and index rows), and the result converts and reads back`, t => {
    const directory = temporary(t), mine = join(directory, "mine"), live = join(directory, "live");
    generation.write(mine); generation.write(live);
    // The reference is the ladder run alone, on a copy. (The store of v13 that made the same climb, and that this test used to compare it with, went with the cut: until
    // then the two were asserted equal for every generation; now the ladder is the one the migration runs, and what is checked is what the conversion makes of it.)
    const reference = connect(t, live);
    reference.exec("BEGIN IMMEDIATE"); climbToV13(reference, generation.from); reference.exec("COMMIT");
    const expected = new Map(reference.prepare("SELECT id, snapshot FROM sessions ORDER BY rowid").all().map(row => [String(row.id), String(row.snapshot)]));
    const expectedIndex = reference.prepare("SELECT * FROM relay_index ORDER BY session_id, run_index").all().map(row => JSON.stringify(row));
    assert.equal(userVersion(reference), 13);

    const db = connect(t, mine);
    const report = migrateToV14(db, { root: mine });
    assert.equal(report.stopped, null);
    assert.equal(report.from, generation.from);
    assert.equal(report.converted, expected.size);
    assert.equal(userVersion(db), 14);
    ok(db);
    assert.deepEqual(db.prepare("SELECT * FROM relay_index ORDER BY session_id, run_index").all().map(row => JSON.stringify(row)), expectedIndex, "the index rows of the v13 migration");
    for (const [id, text] of expected) assertReadsBack(db, id, text, generation.label + " " + id);
    // The backup is of the database as it was, at its own version.
    const backup = new DatabaseSync(report.backup!, { readOnly: true });
    try { assert.equal(userVersion(backup), generation.from); assert.equal(count(backup, "SELECT COUNT(*) AS n FROM sessions"), expected.size); } finally { backup.close(); }
  });
}

// The climb is one transaction: a conversation of an old generation that cannot be read ends it with the database as it was (these were the old store's tests of its migrations).
for (const [version, victim] of [[8, 1], [11, 2]] as const) {
  test(`v${version}: a conversation the ladder cannot read, met after others were migrated, ends the first transaction with the database as it was: the version, every row, the schema`, t => {
    const root = join(temporary(t), "data");
    writeGenerationRoot(root, loadGeneration(version));
    const db = connect(t, root), ids = [...snapshotsOf(db).keys()];
    assert.ok(ids.length > victim);
    // A status no version has ever had: the frozen parse refuses it, when the ladder gets to it.
    db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.status','weird') WHERE id=?").run(ids[victim]!);
    const before = dumpOf(db);
    // The error says which conversation the ladder cannot read and the rule, and nothing else of it.
    assert.throws(() => migrateToV14(db, { root }), error => codeOf("MIGRATION_REFUSED")(error) && (error as SessionError).message.includes(ids[victim]!) && /unknown Session status/u.test((error as SessionError).message) && !(error as SessionError).message.includes("weird"));
    assert.deepEqual(dumpOf(db), before, "nothing of the climb stayed");
    assert.equal(userVersion(db), version);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'relay_%' OR name LIKE 'migration_v14%'"), 0, "no table of a later version was left");
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The frozen ledger is the one the Runtime's was
// ---------------------------------------------------------------------------------------------------------------------------------
// (The event-reading ledger the web server's relay view once had was the same code; it is gone now that the view reads the Runs' rows, and the frozen ledger is what is left of it:
// the test below holds the rows' ledger to the frozen one on every binding of every fixture.)

test("the Runtime's ledger reads the Runs' rows and gives the facts the frozen ledger gives, on every binding of every fixture and every place a Run ran (a Run made before v13 is placed by its row)", t => {
  let compared = 0, legacyPlaced = 0;
  for (const name of V13_FIXTURES) {
    const fixture = loadV13Fixture(name), { root, db } = v13Root(t, [fixture]);
    assert.equal(migrateToV14(db, { root }).stopped, null);
    for (const row of fixture.sessions) {
      const state = liveParse(row.snapshot), events = row.events as readonly SessionEvent[], conversation = loadConversation(db, sessionId(row.id));
      const read = (_id: unknown, after: number, limit: number): readonly SessionEvent[] => events.filter(event => event.seq > after).slice(0, limit);
      const index: RelayIndexRow[] = fixture.relay.index.filter(entry => entry.session_id === row.id).map(entry => ({ runId: entry.run_id as never, index: JSON.parse(String(entry.index_json)) as Record<string, unknown> }));
      legacyPlaced += conversation.runs.filter(run => run.executedOn !== undefined).length;
      // The places: a binding's, every place a Run ran (its own `relay`, or for a Run made before v13 the row's `executedOn` the migration took from the index), and one nothing ran at.
      const places = [{ harnessId: "none", controlId: "none", nativeEpoch: 1 }, ...(state.nativeBindings ?? []).map(binding => ({ harnessId: binding.harnessId, controlId: binding.controlId, nativeEpoch: binding.relay?.epoch ?? 1 })),
        ...state.runs.flatMap(run => run.relay?.executedOn == null ? [] : [run.relay.executedOn]), ...conversation.runs.flatMap(run => run.executedOn === undefined ? [] : [run.executedOn])];
      for (const place of places) {
        assert.deepStrictEqual(new RelayLedger().facts(conversation, place), new LegacyRelayLedger(read).facts(state, index, place), name + " " + row.id + " " + JSON.stringify(place));
        compared++;
      }
    }
  }
  assert.ok(compared > 60); assert.ok(legacyPlaced > 0, "the fixtures hold Runs made before v13, which only their rows place");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// What the Runs get from the events and the index (review I1, I2)
// ---------------------------------------------------------------------------------------------------------------------------------
interface RunColumns { readonly run_id: string; readonly status: string; readonly user_seq: number; readonly ended_seq: number | null; readonly is_command: number; readonly command_effect: string | null; readonly settled_effect: string | null; readonly acknowledged_by: string | null; readonly executed_harness_id: string | null; readonly executed_control_id: string | null; readonly executed_epoch: number | null; readonly dispatched: number }
function runColumns(db: DatabaseSync, session: string): Map<string, RunColumns> {
  return new Map(db.prepare("SELECT run_id, status, user_seq, ended_seq, is_command, command_effect, settled_effect, acknowledged_by, executed_harness_id, executed_control_id, executed_epoch, dispatched FROM runs WHERE session_id=? ORDER BY ordinal").all(session)
    .map(row => [String(row.run_id), row as unknown as RunColumns]));
}
test("command Runs are told from ordinary ones, with the effect they were read with and the one their end settled", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("commands")]);
  assert.equal(migrateToV14(db, { root }).stopped, null);
  const runs = runColumns(db, "session-cm-1");
  const plain = runs.get("run-cm-2")!;
  assert.deepEqual([plain.is_command, plain.command_effect, plain.settled_effect, plain.ended_seq], [0, null, null, 12]);
  for (const [run, effect, seq] of [["run-cm-5", "compact", 24], ["run-cm-11", "clear", 47], ["run-cm-17", "none", 70], ["run-cm-20", "unknown", 82], ["run-cm-23", "keep", 94], ["run-cm-26", "rewind", 106]] as const) {
    const found = runs.get(run)!;
    assert.deepEqual([found.is_command, found.command_effect, found.settled_effect, found.ended_seq], [1, effect, effect, seq], run);
  }
  // The facts for a binding no Run of this conversation ran on: the ordinary Runs and the one command that kept; the commands that compacted, cleared, rewound, left alone or did not know are none.
  const facts = relayFactsFromRows(db, sessionId("session-cm-1"), Number(db.prepare("SELECT last_seq FROM sessions WHERE id='session-cm-1'").get()!.last_seq), { harnessId: "elsewhere", controlId: "elsewhere", nativeEpoch: 1 });
  const ids = facts.map(fact => fact.runId as string);
  assert.ok(ids.includes("run-cm-23"), "the command that kept is a fact");
  for (const run of ["run-cm-5", "run-cm-11", "run-cm-17", "run-cm-20", "run-cm-26", "run-cm-32"]) assert.ok(!ids.includes(run), run + " is not");
  assert.ok(ids.includes("run-cm-2") && ids.includes("run-cm-29"));
});

test("a command whose effect cannot be read is still a command, with neither effect, and is not a fact", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("commands")]);
  // The effect the command was read with and the one its end settled, both made unreadable for one Run.
  db.exec("UPDATE events SET event_json = replace(event_json, '\"contextEffect\":\"compact\"', '\"contextEffect\":\"?\"') WHERE session_id='session-cm-1' AND json_extract(event_json,'$.data.runId')='run-cm-5'");
  assert.ok(count(db, "SELECT COUNT(*) AS n FROM events WHERE event_json LIKE '%\"contextEffect\":\"?\"%'") >= 1);
  const report = migrateToV14(db, { root });
  assert.equal(report.stopped, null, report.stopped?.reason);
  const found = runColumns(db, "session-cm-1").get("run-cm-5")!;
  assert.deepEqual([found.is_command, found.command_effect, found.settled_effect], [1, null, null], "a command with no readable effect: told from an ordinary Run by is_command, not by its effects");
  const ordinary = runColumns(db, "session-cm-1").get("run-cm-2")!;
  assert.deepEqual([ordinary.is_command, ordinary.command_effect, ordinary.settled_effect], [0, null, null]);
  const ids = relayFactsFromRows(db, sessionId("session-cm-1"), 129, { harnessId: "elsewhere", controlId: "elsewhere", nativeEpoch: 1 }).map(fact => fact.runId as string);
  assert.ok(!ids.includes("run-cm-5") && ids.includes("run-cm-2"));
});

test("a Run whose end the events placed has that seq; one a recovery ended has the recovery's; one nothing placed has the index row's, else the conversation's last event of the migration", t => {
  // The first of the `run.ended` and the `session.recovered` that names it.
  const recovered = loadV13Fixture("recovered-after-crash"), { root, db } = v13Root(t, [recovered]);
  assert.equal(migrateToV14(db, { root }).stopped, null);
  let named = 0;
  for (const row of recovered.sessions) {
    const columns = runColumns(db, row.id), placed = new Map<string, number>();
    for (const event of row.events) {
      if (event.type === "run.ended" && typeof event.data.runId === "string" && !placed.has(event.data.runId)) placed.set(event.data.runId, event.seq);
      if (event.type === "session.recovered") for (const id of [...(event.data.unknownRunIds as string[] | undefined ?? []), ...(event.data.cancelledRunIds as string[] | undefined ?? [])]) if (!placed.has(id)) { placed.set(id, event.seq); named++; }
    }
    for (const [run, found] of columns) assert.equal(found.ended_seq, placed.get(run) ?? null, row.id + " " + run);
  }
  assert.ok(named > 0, "the fixture has a Run that only a recovery ended");

  // A database from before v13: the events are the same as the index rows' seqs; with the events' types changed (so that they place nothing) the Runs get the index rows' seqs, and
  // with the index rows gone too a finished, dispatched Run gets the conversation's last seq of the moment of the migration: at or above where it really ended, so it is owed to
  // every binding the mark of which is below that, and not owed to one that has everything through the last event (right after a clear, or after its own Turn). The value is
  // fixed: it does not follow the conversation as it grows (which would put the fact above every later mark and carry it again each Turn, across every clear line).
  // A Run that is not finished and dispatched, or whose input is the last event, has none: NULL, which the relay reads as above any mark (never 0, never skipped).
  const d1 = loadV12Fixture("d1"), directory = temporary(t), plain = join(directory, "plain"), degraded = join(directory, "degraded"), bare = join(directory, "bare");
  for (const root of [plain, degraded, bare]) writeV12Root(root, [d1]);
  const ends = new Map<string, number>(), indexSeq = new Map<string, number>();
  for (const event of d1.sessions[0]!.events) if (event.type === "run.ended" && !ends.has(String(event.data.runId))) ends.set(String(event.data.runId), event.seq);
  {
    const db1 = connect(t, plain);
    assert.equal(migrateToV14(db1, { root: plain }).stopped, null);
    for (const [run, found] of runColumns(db1, "session-1")) assert.equal(found.ended_seq, ends.get(run), "from the events: " + run);
    for (const row of db1.prepare("SELECT run_id, index_json FROM relay_index").all()) indexSeq.set(String(row.run_id), (JSON.parse(String(row.index_json)) as { seq: number }).seq);
    assert.deepEqual([...indexSeq], [...ends], "the index rows say what the events say");
  }
  for (const [root, withIndex] of [[degraded, true], [bare, false]] as const) {
    const db2 = connect(t, root);
    upgradeSchema(db2, 12);
    db2.exec("UPDATE events SET event_json = replace(event_json, '\"type\":\"run.ended\"', '\"type\":\"run.over\"')");
    if (!withIndex) db2.exec("DELETE FROM relay_index");
    const report = migrateToV14(db2, { root });
    assert.equal(report.stopped, null, "the old ledger and the new reading agree whichever way the end is placed");
    const lastSeq = Number(db2.prepare("SELECT last_seq FROM sessions").get()!.last_seq);
    let placedAtLast = 0;
    for (const [run, found] of runColumns(db2, "session-1")) {
      const finished = found.dispatched === 1 && ["completed", "cancelled", "failed", "unknown"].includes(found.status);
      assert.equal(found.ended_seq, withIndex ? indexSeq.get(run) : finished && lastSeq > found.user_seq ? lastSeq : null, run);
      if (!withIndex) {
        if (found.ended_seq === lastSeq) placedAtLast++;
        const fact = relayFactsFromRows(db2, sessionId("session-1"), lastSeq, { harnessId: "elsewhere", controlId: "elsewhere", nativeEpoch: 1 }).find(item => item.runId === run);
        if (fact !== undefined) assert.equal(fact.seq, lastSeq, "a Run nothing placed is placed at the last event of the moment");
      }
    }
    if (!withIndex) {
      assert.ok(placedAtLast > 0, "the fixture has finished, dispatched Runs that nothing placed");
      // The value is fixed: the facts the Runtime's ledger gives from the rows, after the conversation has gone on by 50 events, are still where the migration put them.
      const loaded = loadConversation(db2, sessionId("session-1")), facts = new RelayLedger().facts({ runs: loaded.runs, lastSeq: loaded.lastSeq + 50 }, { harnessId: "elsewhere", controlId: "elsewhere", nativeEpoch: 1 });
      assert.ok(facts.length > 0);
      for (const fact of facts) assert.ok(fact.seq <= loaded.lastSeq, "a placed fact does not follow the conversation as it grows");
    }
  }
});

test("where a Run ran: its own relay facts for a Run made by v13, the index row for one made before it", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("from-v12-d1")]);
  const old = JSON.parse(String(db.prepare("SELECT snapshot FROM sessions").get()!.snapshot)) as SessionSnapshot;
  assert.ok(old.runs.every(run => run.relay === undefined), "a Run from a v12 database has no relay facts of its own");
  assert.equal(migrateToV14(db, { root }).stopped, null);
  const index = new Map(db.prepare("SELECT run_id, index_json FROM relay_index").all().map(row => [String(row.run_id), JSON.parse(String(row.index_json)) as { executedOn: { harnessId: string; controlId: string; nativeEpoch: number } }]));
  for (const [run, found] of runColumns(db, "session-1")) {
    const on = index.get(run)!.executedOn;
    assert.deepEqual([found.executed_harness_id, found.executed_control_id, found.executed_epoch], [on.harnessId, on.controlId, on.nativeEpoch], run);
  }
  // And the Run's own facts are still what they were: none (it is read back with no `relay`).
  assertReadsBack(db, "session-1", JSON.stringify(old), "from-v12-d1");
  const v13 = v13Root(t, [loadV13Fixture("switches")]);
  assert.equal(migrateToV14(v13.db, { root: v13.root }).stopped, null);
  for (const [run, found] of runColumns(v13.db, "session-sw-1")) assert.ok(found.executed_harness_id !== null && found.executed_control_id !== null && found.executed_epoch !== null, run);
});

test("an unknown Run is claimed by the first effective switch that names it as a source or as acknowledged, not by an ordinal at or below the switch's sources", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("unknown-recovered")]);
  assert.equal(migrateToV14(db, { root }).stopped, null);
  const claimed = (session: string, run: string): string | null => runColumns(db, session).get(run)!.acknowledged_by;
  assert.equal(claimed("session-ur-1", "run-ur-5"), "switch-ur-8");
  assert.equal(claimed("session-ur-15", "run-ur-19"), "switch-ur-28");
  assert.equal(claimed("session-ur-49", "run-ur-53"), "switch-ur-56");
  // S7: the first switch (failed) skipped the unknown Run and the second (effective) took it; a Run is not claimed by a switch that did not take effect.
  assert.equal(claimed("session-ur-71", "run-ur-78"), "switch-ur-85");
  // A blocked conversation's unknown Run is waiting for its switch.
  assert.equal(claimed("session-ur-60", "run-ur-64"), null);
  // Only unknown Runs are claimed.
  for (const found of runColumns(db, "session-ur-71").values()) if (found.acknowledged_by !== null) assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(found.run_id)!.status, "unknown");
  // The same by `acknowledgedUnknown`: the switch's sources stop short of the Run and the switch lists it.
  const other = v13Root(t, [loadV13Fixture("unknown-acknowledged")]);
  assert.equal(migrateToV14(other.db, { root: other.root }).stopped, null);
  assert.equal(runColumns(other.db, "session-ur-1").get("run-ur-5")!.acknowledged_by, "switch-ur-8");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Existing branches and imports
// ---------------------------------------------------------------------------------------------------------------------------------
for (const name of ["branch", "from-v12-branch", "import", "from-v12-import"] as const) {
  test(`${name}: the quoted history goes into origin_history as it was, its attachments are registered at the conversation, and the branch keeps its place in the source`, t => {
    const fixture = loadV13Fixture(name), { root, db } = v13Root(t, [fixture]);
    assert.equal(migrateToV14(db, { root }).stopped, null);
    let quoted = 0;
    for (const row of fixture.sessions) {
      const origin = (row.snapshot as unknown as SessionSnapshot).origin;
      const rows = db.prepare("SELECT idx, kind, message_json FROM origin_history WHERE session_id=? ORDER BY idx").all(row.id);
      if (origin === undefined) { assert.equal(rows.length, 0, row.id); continue; }
      assert.equal(rows.length, origin.history.length, row.id + ": as many as were quoted");
      origin.history.forEach((message, at) => {
        assert.equal(rows[at]!.idx, at);
        assert.equal(rows[at]!.kind, origin.kind === "fork" ? "fork" : "import", row.id);
        assert.deepStrictEqual(JSON.parse(String(rows[at]!.message_json)), message, row.id + ": message " + at + " verbatim");
        quoted++;
      });
      // The attachments of the quoted messages are held by the conversation itself (the source may be deleted), not by a Run.
      const wanted = new Set(origin.history.flatMap(message => (message.attachments ?? []).map(attachment => attachment.id)));
      const held = new Set(db.prepare("SELECT content_id FROM content_refs WHERE session_id=? AND role='origin_attachment' AND run_id IS NULL").all(row.id).map(entry => String(entry.content_id)));
      assert.deepEqual([...held].sort(), [...wanted].sort(), row.id + ": the quoted attachments are registered");
      const head = JSON.parse(String(db.prepare("SELECT head FROM sessions WHERE id=?").get(row.id)!.head)) as { origin?: Record<string, unknown> };
      assert.equal(head.origin?.kind, origin.kind, row.id);
      if (origin.kind === "fork") {
        assert.equal(head.origin?.quoted, true, row.id + ": it quotes its history, it does not refer to its source for it");
        const sourceRuns = fixture.sessions.find(other => other.id === origin.sessionId)?.snapshot.runs as { id: string }[] | undefined;
        assert.equal(head.origin?.throughOrdinal, sourceRuns === undefined ? -1 : sourceRuns.findIndex(run => run.id === origin.throughRunId), row.id + ": the place in the source");
      }
    }
    assert.ok(quoted > 0);
  });
}
test("a branch converted before its source (the order of the rows is not the order of the sources) is given the same place in it", t => {
  const fixture = loadV13Fixture("branch");
  const reference = v13Root(t, [fixture]);
  assert.equal(migrateToV14(reference.db, { root: reference.root }).stopped, null);
  const reversed = v13Root(t, [{ ...fixture, sessions: [...fixture.sessions].reverse() }]);
  const originals = snapshotsOf(reversed.db);
  assert.equal(migrateToV14(reversed.db, { root: reversed.root }).stopped, null);
  const heads = (db: DatabaseSync): Map<string, string> => new Map(db.prepare("SELECT id, head FROM sessions").all().map(row => [String(row.id), String(row.head)]));
  assert.deepEqual(heads(reversed.db), heads(reference.db), "the heads, origins and their places in the sources, whichever came first");
  for (const [id, text] of originals) assertReadsBack(reversed.db, id, text, id);
});

test("a branch whose source was deleted is converted as well: its quoted history is all it needs", t => {
  const fixture = loadV13Fixture("branch"), kept = fixture.sessions.filter(row => row.id === "session-br-11");
  assert.equal(kept.length, 1);
  const alone: V13Fixture = { ...fixture, sessions: kept, createKeys: fixture.createKeys.filter(row => row.sessionId === "session-br-11"), relay: { ...fixture.relay, bodies: [], packets: [], deliveries: [], index: [] } };
  const { root, db } = v13Root(t, [alone]);
  const original = snapshotsOf(db).get("session-br-11")!;
  const report = migrateToV14(db, { root });
  assert.equal(report.stopped, null);
  assertReadsBack(db, "session-br-11", original, "session-br-11");
  assert.equal((JSON.parse(String(db.prepare("SELECT head FROM sessions").get()!.head)) as { origin: { throughOrdinal: number } }).origin.throughOrdinal, -1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Text that SQLite would change
// ---------------------------------------------------------------------------------------------------------------------------------
test("ids with half a surrogate pair (a call's, an activity's, the call a call happened inside, a native session's reference) convert and read back exactly, though the columns can only hold them as U+FFFD", t => {
  const fixture = structuredClone(loadV13Fixture("tools")) as unknown as { sessions: { id: string; snapshot: { runs: { id: string; tools?: { id: string; parentId?: string }[]; activities?: unknown[] }[]; nativeBindings: { checkpoint: string; harnessId: string }[] } }[] };
  const snapshot = fixture.sessions[0]!.snapshot, run = snapshot.runs.find(item => (item.tools?.length ?? 0) >= 2)!;
  run.tools![0]!.id = "call-\ud83d"; run.tools![1]!.parentId = "call-\ud83d";
  run.activities = [...(run.activities ?? []), { id: "act-\ude00", kind: "task", title: "an activity", status: "completed" }];
  snapshot.nativeBindings[0]!.checkpoint = snapshot.nativeBindings[0]!.checkpoint + "\ud83d";
  const { root, db } = v13Root(t, [fixture as unknown as V13Fixture]);
  const original = snapshotsOf(db);
  const report = migrateToV14(db, { root, verify });
  assert.equal(report.stopped, null, report.stopped?.reason);
  for (const [id, text] of original) assertReadsBack(db, id, text, id);
  // What the columns hold is whole code points, and the facts say what the Harness gave.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM items WHERE item_id = 'tool:call-' || char(65533)"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM items WHERE item_id = 'activity:act-' || char(65533)"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM items WHERE parent_id = 'tool:call-' || char(65533)"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM bindings WHERE checkpoint LIKE '%' || char(65533)"), 1);
  for (const column of ["item_id", "parent_id"]) for (const found of db.prepare("SELECT " + column + " AS text FROM items WHERE " + column + " IS NOT NULL").all()) assert.equal(Buffer.from(String(found.text), "utf8").toString("utf8"), String(found.text));
});

test("text-extremes: half surrogate pairs are normalized by the conversion and kept as facts, so the last gate of the writer never fires, and they read back exactly", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("text-extremes")]);
  const original = snapshotsOf(db), text = (value: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
  let half = 0;
  (function walk(value: unknown): void {
    if (typeof value === "string") { if (text(value)) half++; } else if (Array.isArray(value)) value.forEach(walk); else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  })(JSON.parse([...original.values()][0]!));
  assert.ok(half >= 2, "the fixture has text with half a pair");
  const report = migrateToV14(db, { root });
  assert.equal(report.stopped, null, report.stopped?.reason);
  for (const row of db.prepare("SELECT text FROM item_text").all()) assert.ok(!text(String(row.text)) && Buffer.from(String(row.text), "utf8").toString("utf8") === String(row.text), "the stored text is whole code points");
  assert.ok(count(db, "SELECT COUNT(*) AS n FROM items WHERE item_json LIKE '%surrogates%'") >= 1, "the original units are kept as a fact of the item");
  assert.ok(count(db, "SELECT COUNT(*) AS n FROM item_text WHERE text LIKE '%' || char(65533) || '%'") >= 1, "the replacement is what is stored");
  for (const [id, snapshot] of original) assertReadsBack(db, id, snapshot, id);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The packet the relay writes from the conversation does not change
// ---------------------------------------------------------------------------------------------------------------------------------
for (const name of ["relay-states", "trial-2026-11-11", "switches", "tools", "commands", "branch", "import", "from-v12-d1"] as const) {
  test(`${name}: the handoff packet of every Turn is byte for byte the same from the converted rows as from the snapshot`, t => {
    const fixture = loadV13Fixture(name), { root, db } = v13Root(t, [fixture]);
    assert.equal(migrateToV14(db, { root }).stopped, null);
    let rendered = 0;
    for (const row of fixture.sessions) {
      const before = liveParse(row.snapshot), after = snapshotFromRows(db, sessionId(row.id));
      for (let at = 1; at < before.runs.length; at++) {
        const input = (state: SessionSnapshot) => ({ state, current: state.runs[at]!, sources: state.runs.slice(0, at), origin: state.origin !== undefined, firstLine: true, hubTools: at % 2 === 0 });
        const was = renderRelay(input(before)), now = renderRelay(input(after));
        assert.equal(now.text, was.text, `${row.id} Turn ${at}`);
        assert.deepStrictEqual(now.record, was.record, `${row.id} Turn ${at}`);
        rendered++;
      }
    }
    assert.ok(rendered > 0, "there were Turns to render");
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The checks are real: each is broken on purpose and the migration stops there
// ---------------------------------------------------------------------------------------------------------------------------------
/** The storage conversion with one thing wrong for the Run `target`, to show that the check meant to find it does. */
function faulty(target: string, fault: (converted: ConvertedRun, at: Parameters<StorageConversion["toItems"]>[2]) => ConvertedRun, change?: (at: Parameters<StorageConversion["toItems"]>[2]) => Parameters<StorageConversion["toItems"]>[2]): StorageConversion {
  return {
    fromItems: storageConversion.fromItems,
    toItems: (run, messages, at) => {
      if (run.id !== target) return storageConversion.toItems(run, messages, at);
      const used = change === undefined ? at : change(at);
      return fault(storageConversion.toItems(run, messages, used), used);
    },
  };
}
/** The state a stopped migration leaves: v14, the conversations before the stop converted, the one that stopped and the ones after it as they were, the reason on the one. */
function assertStoppedAt(db: DatabaseSync, id: string, report: ReturnType<typeof migrateToV14>, originals: ReadonlyMap<string, string>, order: readonly string[]): void {
  assert.equal(report.stopped?.sessionId, id);
  assert.ok(report.stopped!.reason.length > 0);
  assert.equal(userVersion(db), 14);
  const at = order.indexOf(id);
  order.forEach((other, index) => {
    const row = db.prepare("SELECT format, last_error, head FROM sessions WHERE id=?").get(other)!;
    if (index < at) { assert.equal(row.format, 14, other); assertReadsBack(db, other, originals.get(other)!, other); }
    else {
      assert.equal(row.format, 13, other);
      assert.equal(row.head, originals.get(other), other + " is the snapshot it was, byte for byte");
      for (const table of ["runs", "commands", "switches", "bindings", "origin_history", "content_refs"]) assert.equal(count(db, "SELECT COUNT(*) AS n FROM " + table + " WHERE session_id=?", other), 0, other + " has no " + table);
    }
    assert.equal(row.last_error, index === at ? report.stopped!.reason : null, other);
  });
  const state = migrationState(db);
  assert.equal(state.kind, "converting");
  if (state.kind === "converting") { assert.equal(state.remaining, order.length - at); assert.equal(state.stopped?.sessionId, id); assert.match(state.message, /not converted yet/u); }
  assert.equal(collectionGate(db).allowed, false);
  ok(db);
}
const BREAKS: readonly { readonly name: string; readonly fixture: V13FixtureName; readonly run: string; readonly session: string; readonly fault: (target: string) => StorageConversion; readonly says: RegExp }[] = [
  { name: "a text that reads back different", fixture: "commands", run: "run-cm-8", session: "session-cm-1",
    fault: target => faulty(target, converted => {
      const last = converted.items.map(item => item.text.length > 0).lastIndexOf(true);
      return { ...converted, items: converted.items.map((item, at) => at === last ? { ...item, text: [...item.text.slice(0, -1), item.text.at(-1)! + "!"] } : item) };
    }), says: /does not read back as it was: snapshot/u },
  { name: "a command that kept, marked as one that did not", fixture: "commands", run: "run-cm-23", session: "session-cm-1",
    fault: target => faulty(target, converted => converted, at => ({ ...at, settledEffect: "none" as const })), says: /the relay's facts for .* are not what the old reading gave: facts/u },
  { name: "a Run whose end was placed, left unplaced", fixture: "switches", run: "run-sw-5", session: "session-sw-1",
    fault: target => faulty(target, converted => converted, ({ endedSeq: _dropped, ...at }) => at), says: /the relay's facts for .* are not what the old reading gave: facts/u },
  { name: "a Run that ran somewhere else", fixture: "switches", run: "run-sw-9", session: "session-sw-1",
    fault: target => faulty(target, converted => ({ ...converted, row: { ...converted.row, executedOn: { harnessId: "alpha", controlId: "alpha-acp", nativeEpoch: 1 } } })), says: /does not read back as it was: snapshot|the relay's facts for/u },
  { name: "a content reference not registered", fixture: "tools", run: "run-tl-2", session: "session-tl-1",
    fault: target => faulty(target, converted => ({ ...converted, contentRefs: converted.contentRefs.slice(1) })), says: /content references written differ from the old ones \(1 not written/u },
  { name: "a content reference nobody had", fixture: "tools", run: "run-tl-6", session: "session-tl-1",
    fault: target => faulty(target, converted => ({ ...converted, contentRefs: [...converted.contentRefs, { ...converted.contentRefs[0]!, contentId: "content-" + "0".repeat(32) }] })), says: /content references written differ from the old ones \(0 not written, 1 not referenced/u },
  { name: "an unknown Run no switch acknowledged", fixture: "unknown-recovered", run: "run-ur-5", session: "session-ur-1",
    fault: target => faulty(target, converted => converted, ({ acknowledgedBy: _dropped, ...at }) => at), says: /unknown Run|does not read back|INVALID_TRANSITION|acknowledg/u },
];
for (const broken of BREAKS) {
  test(`validation catches ${broken.name}: the migration stops at that conversation, those before it are converted, it and those after it are as they were, and the reason says where and not what`, t => {
    const fixture = loadV13Fixture(broken.fixture), { root, db } = v13Root(t, [fixture]);
    const originals = snapshotsOf(db), order = fixture.sessions.map(row => row.id);
    const report = migrateToV14(db, { root, conversion: broken.fault(broken.run) });
    assertStoppedAt(db, broken.session, report, originals, order);
    assert.match(report.stopped!.reason, broken.says);
    // The words of the conversation do not reach the reason.
    const words = JSON.parse(originals.get(broken.session)!) as SessionSnapshot;
    for (const message of words.messages) if (message.text.length >= 12) assert.ok(!report.stopped!.reason.includes(message.text), "no message text in the reason");
    // A build without the fault goes on from there; the result is what a migration that never stopped gives.
    const resumed = migrateToV14(db, { root });
    assert.equal(resumed.stopped, null);
    assert.equal(resumed.backup, null, "the backup was taken once");
    assert.equal(resumed.alreadyConverted, order.indexOf(broken.session));
    assert.equal(resumed.converted, order.length - order.indexOf(broken.session));
    const whole = v13Root(t, [fixture]);
    assert.equal(migrateToV14(whole.db, { root: whole.root }).stopped, null);
    assert.deepEqual(dumpOf(db), dumpOf(whole.db), "stopped and resumed is the same database as never stopped");
  });
}

const ROW_BREAKS: readonly { readonly name: string; readonly fixture: V13FixtureName; readonly session: string; readonly sql: string; readonly says: RegExp }[] = [
  { name: "a binding's relay mark moved in its column", fixture: "switches", session: "session-sw-1", sql: "UPDATE bindings SET relay_mark = relay_mark + 1 WHERE session_id=?", says: /native binding \d+ holds its relay_mark in its column and in its JSON and the two differ/u },
  { name: "a binding's status changed in its column", fixture: "switches", session: "session-sw-1", sql: "UPDATE bindings SET status = 'archived' WHERE session_id=? AND ordinal=0", says: /native binding 0 holds its status in its column and in its JSON/u },
  { name: "a title that is not the conversation's", fixture: "switches", session: "session-sw-1", sql: "UPDATE sessions SET title = 'another title' WHERE id=?", says: /title, kept flag, deletion mark or error/u },
  { name: "a kept flag the snapshot does not have", fixture: "kept-process", session: "session-kp-1", sql: "UPDATE sessions SET kept = 1 - kept WHERE id=?", says: /title, kept flag, deletion mark or error/u },
  { name: "a run count that is not the Runs'", fixture: "switches", session: "session-sw-1", sql: "UPDATE sessions SET run_count = run_count + 1 WHERE id=?", says: /run count of the head/u },
  { name: "a content reference nobody had", fixture: "tools", session: "session-tl-1", sql: "INSERT INTO content_refs(content_id,session_id,run_id,item_seq,role) SELECT 'content-" + "e".repeat(32) + "', ?, NULL, NULL, 'origin_attachment'", says: /content references written differ/u },
  { name: "a content reference lost", fixture: "tools", session: "session-tl-1", sql: "DELETE FROM content_refs WHERE session_id=? AND ref_id=(SELECT MIN(ref_id) FROM content_refs)", says: /content references written differ/u },
  { name: "a quoted message gone", fixture: "branch", session: "session-br-11", sql: "DELETE FROM origin_history WHERE session_id=? AND idx=0", says: /quoted messages|does not read back|kept|purge/u },
];
for (const broken of ROW_BREAKS) {
  test(`a row broken inside the transaction of its conversation (${broken.name}) is found by the checks before the commit: nothing of that conversation is kept`, t => {
    const fixture = loadV13Fixture(broken.fixture), { root, db } = v13Root(t, [fixture]);
    const originals = snapshotsOf(db), order = fixture.sessions.map(row => row.id);
    let broke = 0;
    const report = migrateToV14(db, { root, step: (phase, detail) => { if (phase === "written" && detail === broken.session) { db.prepare(broken.sql).run(broken.session); broke++; } } });
    assert.equal(broke, 1);
    assertStoppedAt(db, broken.session, report, originals, order);
    assert.match(report.stopped!.reason, broken.says);
    const resumed = migrateToV14(db, { root });
    assert.equal(resumed.stopped, null, "without the broken row the same migration goes through");
  });
}

test("an error of SQLite itself is not a verdict on the conversation: it propagates, the conversation's transaction is rolled back, nothing is recorded against it, and a new start goes on", t => {
  const fixture = loadV13Fixture("switches"), { root, db } = v13Root(t, [fixture]);
  const originals = snapshotsOf(db), order = fixture.sessions.map(row => row.id);
  // The hook breaks a rule of the tables on its own connection, which SQLite refuses with an error that is not the migration's (a full disk is the same kind).
  assert.throws(() => migrateToV14(db, { root, step: (phase, detail) => { if (phase === "written" && detail === order[1]) db.exec("UPDATE commands SET fingerprint='x' WHERE session_id='" + order[1] + "' AND ordinal=1"); } }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "ERR_SQLITE_ERROR");
  assert.equal(db.isTransaction, false, "its transaction is gone");
  assert.equal(userVersion(db), 14);
  order.forEach((id, index) => {
    const row = db.prepare("SELECT format, head, last_error FROM sessions WHERE id=?").get(id)!;
    assert.equal(row.format, index === 0 ? 14 : 13, id);
    assert.equal(row.last_error, null, id + ": no reason is recorded for what is not the conversation's fault");
    if (index > 0) assert.equal(row.head, originals.get(id), id);
  });
  assert.equal(migrationState(db).kind, "converting");
  const resumed = migrateToV14(db, { root });
  assert.equal(resumed.stopped, null);
  assert.equal(resumed.converted, order.length - 1);
  const whole = v13Root(t, [fixture]);
  migrateToV14(whole.db, { root: whole.root });
  assert.deepEqual(dumpOf(db), dumpOf(whole.db));
});

test("a conversation that cannot be read stops the migration; the ones before it are converted and the ones after it untouched; repaired, it goes on and ends as an uninterrupted migration", t => {
  const fixture = loadV13Fixture("switches"), { root, db } = v13Root(t, [fixture]);
  const originals = snapshotsOf(db), order = [...originals.keys()], victim = order[1]!;
  assert.ok(order.length >= 3);
  // A status no version has ever had: the frozen parse refuses it.
  db.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.status','weird') WHERE id=?").run(victim);
  const report = migrateToV14(db, { root });
  assert.equal(report.converted, 1);
  const damaged = new Map(originals).set(victim, String(db.prepare("SELECT head FROM sessions WHERE id=?").get(victim)!.head));
  assertStoppedAt(db, victim, report, damaged, order);
  // The same migration, called again with the data still broken, stops at the same place with the same words, and converts nothing more.
  const again = migrateToV14(db, { root });
  assert.equal(again.stopped?.sessionId, victim);
  assert.equal(again.stopped?.reason, report.stopped?.reason);
  assert.equal(again.converted, 0);
  // Repaired (the snapshot as it was), it resumes.
  db.prepare("UPDATE sessions SET head=? WHERE id=?").run(originals.get(victim)!, victim);
  const resumed = migrateToV14(db, { root });
  assert.equal(resumed.stopped, null);
  assert.equal(resumed.converted, order.length - 1);
  const whole = v13Root(t, [fixture]);
  migrateToV14(whole.db, { root: whole.root });
  assert.deepEqual(dumpOf(db), dumpOf(whole.db));
  assert.equal(migrationState(db).kind, "done");
});

test("a conversation whose event log and cursor disagree stops the migration with that conversation's name", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("switches")]);
  const order = [...snapshotsOf(db).keys()], victim = order[0]!;
  db.prepare("DELETE FROM events WHERE session_id=? AND seq=(SELECT MAX(seq) FROM events WHERE session_id=?)").run(victim, victim);
  const report = migrateToV14(db, { root });
  assert.equal(report.stopped?.sessionId, victim);
  assert.match(report.stopped!.reason, /event log and its cursor disagree/u);
  assert.equal(report.converted, 0);
});

test("an error of the verifier is a stop too; a verifier that finds nothing changes nothing", t => {
  const fixture = loadV13Fixture("switches"), { root, db } = v13Root(t, [fixture]);
  const order = fixture.sessions.map(row => row.id);
  let calls = 0;
  const report = migrateToV14(db, { root, verify: conversation => { calls++; return conversation.id === order[1] ? [{ rule: "R-test", where: "runs[0]", detail: "secret detail" }] : []; } });
  assert.equal(report.stopped?.sessionId, order[1]);
  assert.match(report.stopped!.reason, /does not verify: R-test at runs\[0\]/u);
  assert.ok(!report.stopped!.reason.includes("secret detail"), "the detail may hold words of the conversation");
  assert.equal(calls, 2);
  const resumed = migrateToV14(db, { root, verify: () => [] });
  assert.equal(resumed.stopped, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The first transaction
// ---------------------------------------------------------------------------------------------------------------------------------
test("the first transaction is all or nothing: a claim that fails after the ladder, the rebuild and the new tables leaves the database as it was", t => {
  const directory = temporary(t), root = join(directory, "data");
  writeGenerationRoot(root, loadGeneration(1));
  const db = connect(t, root), before = dumpOf(db);
  assert.equal(userVersion(db), 1);
  assert.throws(() => migrateToV14(db, { root, claim: () => { throw new SessionError("OWNER_CLAIM_FAILED", "another owner"); } }), codeOf("OWNER_CLAIM_FAILED"));
  assert.deepEqual(dumpOf(db), before);
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1, "the keys are enforced again");
  // And it can be done after.
  assert.equal(migrateToV14(db, { root }).stopped, null);
  assert.equal(userVersion(db), 14);
});

test("the store's two hooks run inside the first transaction in the order of the ADR: the previous owner confirmed gone before anything changes, the generation claimed after the new schema is made", t => {
  const directory = temporary(t), root = join(directory, "data");
  writeGenerationRoot(root, loadGeneration(9));
  const db = connect(t, root), seen: string[] = [];
  const shape = (): string => `v${userVersion(db)} ${db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name='head'").all().length > 0 ? "head" : "snapshot"} ${db.isTransaction ? "in a transaction" : "outside"}`;
  assert.equal(migrateToV14(db, { root, confirmOwnerExited: () => { seen.push("confirm " + shape()); }, claim: () => { seen.push("claim " + shape()); } }).stopped, null);
  assert.deepEqual(seen, ["confirm v9 snapshot in a transaction", "claim v13 head in a transaction"], "the ladder has run when the claim is made (v13), and the version 14 is set after it");
  // A confirmation that fails changes nothing.
  const again = join(directory, "again");
  writeGenerationRoot(again, loadGeneration(9));
  const second = connect(t, again), before = dumpOf(second);
  assert.throws(() => migrateToV14(second, { root: again, confirmOwnerExited: () => { throw new SessionError("OWNER_ACTIVE", "another owner is running"); } }), codeOf("OWNER_ACTIVE"));
  assert.deepEqual(dumpOf(second), before);
});

test("a database of a version the migration does not know is refused and not touched", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("switches")]);
  db.exec("PRAGMA user_version=99");
  const before = dumpOf(db);
  assert.throws(() => migrateToV14(db, { root }), codeOf("INVALID_DATA"));
  assert.deepEqual(dumpOf(db), before);
  db.exec("PRAGMA user_version=0");
  assert.throws(() => migrateToV14(db, { root }), codeOf("INVALID_DATA"));
});

test("an upgrade an earlier build began (some conversation converted, nobody having said who gives up a native session two conversations hold) is finished with the converted one keeping its session", t => {
  // The two fixtures hold native-alpha-1 and native-bravo-2 both. The earlier build converted the switches conversation (the one that used them less recently) and stopped.
  const root = join(temporary(t), "data");
  writeV13Root(root, [loadV13Fixture("switches"), later(loadV13Fixture("tools"), 1)]);
  const db = connect(t, root);
  upgradeSchema(db, 13);
  db.exec("DROP TABLE migration_v14_moves");
  assert.equal(convertConversation(db, sessionId("session-sw-1")), true);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM bindings WHERE session_id='session-sw-1' AND status='ready'"), 2);
  const lines: string[] = [];
  const report = migrateToV14(db, { root, verify, log: line => lines.push(line) });
  assert.equal(report.stopped, null);
  assert.deepEqual(report.moved.map(move => ({ ...move })), [
    { sessionId: "session-tl-1", ordinal: 0, harnessId: "alpha", controlId: "alpha-acp", keptBy: "session-sw-1" },
    { sessionId: "session-tl-1", ordinal: 1, harnessId: "bravo", controlId: "bravo-acp", keptBy: "session-sw-1" }], "the converted conversation keeps what it holds, whatever the rule would have said");
  assert.equal(lines.length, 2);
  assert.deepEqual(db.prepare("SELECT session_id, status FROM bindings WHERE checkpoint IN ('native-alpha-1','native-bravo-2') ORDER BY session_id, ordinal").all().map(row => [row.session_id, row.status]),
    [["session-sw-1", "ready"], ["session-sw-1", "ready"], ["session-tl-1", "archived"], ["session-tl-1", "archived"]]);
  ok(db);
});

test("a database that nobody holds a native session twice in has no moves, and the bookkeeping of the upgrade says so", t => {
  const { root, db } = v13Root(t, sharable(["switches", "commands", "tools"]));
  const report = migrateToV14(db, { root, verify });
  assert.deepEqual(report.moved, []); assert.equal(count(db, "SELECT COUNT(*) AS n FROM migration_v14_moves"), 0);
});

test("migrating a database that is already migrated changes nothing and does not compare the references again", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("switches"), loadV13Fixture("tools")]);
  const first = migrateToV14(db, { root });
  assert.equal(first.stopped, null);
  const done = dumpOf(db);
  const again = migrateToV14(db, { root });
  assert.deepEqual([again.from, again.backup, again.converted, again.alreadyConverted, again.stopped, again.references], [14, null, 0, 3 + 1, null, null]);
  assert.deepEqual(dumpOf(db), done);
});

test("the readers of a database that is being converted see version 14 with rows of both kinds, and are told so", t => {
  const fixture = loadV13Fixture("switches"), { root, db } = v13Root(t, [fixture]);
  const reader = connect(t, root, true), seen: string[] = [];
  const report = migrateToV14(db, { root, step: (phase, detail) => {
    if (phase === "backup") assert.deepEqual(migrationState(reader), { kind: "not-started", version: 13 });
    if (phase === "upgraded") { const state = migrationState(reader); seen.push("upgraded:" + (state.kind === "converting" ? state.remaining : state.kind)); }
    if (phase === "written") {
      // The conversation in its transaction is invisible to the reader: it is still the snapshot it was, and the ones converted before it are v14.
      const state = migrationState(reader);
      seen.push(state.kind === "converting" ? `${detail}:${state.converted}/${state.remaining}` : state.kind);
      assert.equal(reader.prepare("SELECT format FROM sessions WHERE id=?").get(detail)!.format, 13);
      assert.equal(count(reader, "SELECT COUNT(*) AS n FROM runs WHERE session_id=?", detail), 0);
    }
  } });
  assert.equal(report.stopped, null);
  const order = fixture.sessions.map(row => row.id);
  assert.deepEqual(seen, ["upgraded:3", `${order[0]}:0/3`, `${order[1]}:1/2`, `${order[2]}:2/1`], "what the reader saw at each step");
  assert.deepEqual(migrationState(reader), { kind: "done" });
});

test("the notices a conversation showed before it was converted are marked as shown, so that a Harness started again after the upgrade does not show them twice", t => {
  const fixture = loadV13Fixture("tools"), { root, db } = v13Root(t, [fixture]);
  const expected = fixture.sessions.flatMap(row => {
    const notices = liveParse(row.snapshot).runs.flatMap(run => run.notices ?? []);
    return [...new Set(notices.map(notice => noticePrint(notice)))].map(print => row.id + " " + print);
  }).sort();
  assert.ok(expected.length >= 3, "the fixture has notices of every severity");
  assert.equal(migrateToV14(db, { root }).stopped, null);
  assert.deepEqual(db.prepare("SELECT session_id, print FROM notice_prints").all().map(row => row.session_id + " " + row.print).sort(), expected);
  // A conversation that showed none has none.
  const quiet = v13Root(t, [loadV13Fixture("switches")]);
  migrateToV14(quiet.db, { root: quiet.root });
  assert.equal(count(quiet.db, "SELECT COUNT(*) AS n FROM notice_prints"), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The backup and the space
// ---------------------------------------------------------------------------------------------------------------------------------
test("the backup is a copy of the v13 database as it was, private, outside the backups that are rotated", t => {
  const fixture = loadV13Fixture("relay-states"), { root, db } = v13Root(t, [fixture]);
  const before = dumpOf(db);
  const report = migrateToV14(db, { root });
  assert.equal(report.backup, join(root, "backups", BACKUP));
  const info = statSync(report.backup!);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "backups")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(root, "backups")), [BACKUP], "nothing else is left in the backups, no unfinished copy");
  const backup = new DatabaseSync(report.backup!, { readOnly: true });
  try { assert.deepEqual(dumpOf(backup), before, "the whole database as it was"); assert.equal(userVersion(backup), 13); } finally { backup.close(); }
});

test("the backup of an older version is named by that version and replaced by another try", t => {
  const directory = temporary(t), root = join(directory, "data");
  writeGenerationRoot(root, loadGeneration(4));
  const db = connect(t, root);
  const first = backupBeforeV14(db, 4, { root });
  assert.equal(first, join(root, "backups", "gateway-v4-before-v14.sqlite"));
  const stamp = statSync(first).mtimeMs;
  const second = backupBeforeV14(db, 4, { root });
  assert.equal(second, first);
  assert.ok(statSync(second).mtimeMs >= stamp);
  assert.deepEqual(readdirSync(join(root, "backups")), ["gateway-v4-before-v14.sqlite"]);
  assert.throws(() => backupBeforeV14(db, 14, { root }), codeOf("INVALID_INPUT"));
});

test("the store trims no backup: those of the migrations before stay, and this one is kept besides", t => {
  // The store of v13 trimmed the backups of its migrations to the newest two; the store of tables makes none of them, and so rotates none: they are their owner's.
  const directory = temporary(t), root = join(directory, "data");
  writeV12Root(root, [loadV12Fixture("d1")]);
  const folder = join(root, "backups");
  mkdirSync(folder, { mode: 0o700 });
  const old = ["20260101T000000Z-aaaaaaaa", "20260102T000000Z-bbbbbbbb", "20260103T000000Z-cccccccc"].map(stamp => join(folder, "gateway-v11-" + stamp + ".sqlite"));
  for (const path of old) { writeFileSync(path, "an old backup"); chmodSync(path, 0o600); }
  appStore(root, { now: () => new Date("2026-11-13T00:00:00.000Z") }).close();
  assert.ok(existsSync(join(folder, "gateway-v12-before-v14.sqlite")), "the backup of the v14 migration is there, at the version the database was");
  assert.deepEqual(old.map(path => existsSync(path)), [true, true, true], "the backups of the earlier migrations are as they were");
  assert.ok(statSync(join(folder, "gateway-v12-before-v14.sqlite")).size > "an old backup".length, "and the new one is a copy of the database");
});

test("a backup that cannot be made means no migration: the database is as it was, version and rows", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("switches")]);
  const before = dumpOf(db);
  // A file where the backups directory should be.
  writeFileSync(join(root, "backups"), "not a directory");
  assert.throws(() => migrateToV14(db, { root }), codeOf("STORAGE_BACKUP_FAILED"));
  assert.deepEqual(dumpOf(db), before);
  assert.equal(userVersion(db), 13);
  rmSync(join(root, "backups"));
  // A backups directory that is not private.
  mkdirSync(join(root, "backups"), { mode: 0o755 }); chmodSync(join(root, "backups"), 0o755);
  assert.throws(() => migrateToV14(db, { root }), (error: unknown) => error instanceof SessionError && error.code === "STORAGE_BACKUP_FAILED" && /nothing was migrated/u.test(error.message));
  assert.deepEqual(dumpOf(db), before);
  assert.deepEqual(readdirSync(join(root, "backups")), [], "nothing was written");
  // The failure is not a one-way door: with the directory right the migration goes through.
  chmodSync(join(root, "backups"), 0o700);
  assert.equal(migrateToV14(db, { root }).stopped, null);
});

test("with less than twice the database free the migration refuses before it writes anything, and says how much it needs", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("switches")]);
  const before = dumpOf(db), size = databaseBytes(root);
  assert.ok(size > 0);
  for (const free of [0, size, 2 * size - 1]) {
    assert.throws(() => migrateToV14(db, { root, freeBytes: () => free }), (error: unknown) => error instanceof SessionError && error.code === "INSUFFICIENT_SPACE" && error.message.includes(String(2 * size)) && error.message.includes("nothing was changed"));
    assert.deepEqual(dumpOf(db), before);
    assert.equal(existsSync(join(root, "backups")), false, "no backup directory was made");
  }
  assert.equal(migrateToV14(db, { root, freeBytes: () => 2 * size }).stopped, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The full-text index and the collector
// ---------------------------------------------------------------------------------------------------------------------------------
test("the migration writes no full-text index; one built afterwards, as a step of its own, finds what the conversations say", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("switches")]);
  assert.equal(migrateToV14(db, { root }).stopped, null);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM search_fts"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM derived"), 0);
  const items = rebuildSearchIndex(db, Date.now());
  assert.ok(items > 0);
  assert.deepEqual(indexStates(db), { search_fts: "ready", search_chars: "ready" });
  assert.ok(count(db, "SELECT COUNT(*) AS n FROM search_fts WHERE search_fts MATCH ?", '"reply from alpha"') > 0);
});

test("the collector is held back while a conversation is not converted, until the references are compared and equal, and on the first start only reports", t => {
  const fixture = loadV13Fixture("tools"), { root, db } = v13Root(t, [fixture, loadV13Fixture("switches")]);
  upgradeSchema(db, 13);
  assert.equal(collectionGate(db).allowed, false);
  assert.match(collectionGate(db).reason!, /not converted/u);
  assert.equal(migrateToV14(db, { root }).stopped, null);
  assert.deepEqual({ ...collectionGate(db) }, { allowed: false, reportOnly: true, reason: "the first start after the upgrade only reports what would be collected and deletes nothing" });
  acknowledgeFirstStart(db);
  assert.deepEqual(collectionGate(db), { allowed: true, reportOnly: false, reason: null });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'migration_v14%'").all().length, 0, "the bookkeeping is gone");
  // A database that never had a migration (made v14) is free to collect.
  const fresh = new DatabaseSync(":memory:");
  try { for (const sql of schemaV14Statements("fresh")) fresh.exec(sql); assert.deepEqual(collectionGate(fresh), { allowed: true, reportOnly: false, reason: null }); } finally { fresh.close(); }
});

test("a reference the conversion lost is found when the whole library is compared, said where, and the collector stays off", t => {
  const { root, db } = v13Root(t, [loadV13Fixture("tools"), loadV13Fixture("branch")]);
  // The migration itself is faultless here; the references written are damaged after, as a program mistake in a later step would.
  const report = migrateToV14(db, { root });
  assert.equal(report.references?.equal, true);
  const lost = String(db.prepare("SELECT content_id FROM content_refs ORDER BY ref_id LIMIT 1").get()!.content_id);
  db.prepare("DELETE FROM content_refs WHERE content_id=?").run(lost);
  db.prepare("INSERT INTO content_refs(content_id,session_id,run_id,item_seq,role) VALUES('content-" + "f".repeat(32) + "',(SELECT id FROM sessions LIMIT 1),NULL,NULL,'origin_attachment')").run();
  const compared = compareReferences(db);
  assert.equal(compared.equal, false);
  assert.deepEqual(compared.missing, [lost]);
  assert.deepEqual(compared.extra, ["content-" + "f".repeat(32)]);
  const gate = collectionGate(db);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reportOnly, false);
  assert.match(gate.reason!, /differs from what the old code referred to \(1 ids the old code kept are not kept, 1 ids are kept that it did not\)/u);
  assert.throws(() => acknowledgeFirstStart(db), codeOf("INVALID_TRANSITION"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Killed at any moment
// ---------------------------------------------------------------------------------------------------------------------------------
interface PeerResult { readonly signal: NodeJS.Signals | null; readonly code: number | null; readonly last: Record<string, unknown> | null }
/** Runs the migration in a process of its own; `killAfterMs` kills it that long after it says it is about to begin. */
async function peer(root: string, args: readonly string[] = [], killAfterMs?: number): Promise<PeerResult> {
  const child = spawn(process.execPath, [peerPath, root, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "", timer: NodeJS.Timeout | undefined;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; if (killAfterMs !== undefined && timer === undefined && output.includes("ready\n")) timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs); });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (timer !== undefined) clearTimeout(timer);
  const line = output.split("\n").filter(entry => entry.startsWith("{")).at(-1);
  return { code, signal, last: line === undefined ? null : JSON.parse(line) as Record<string, unknown> };
}
/** What a database stopped in the middle of the migration must be: untouched if the first transaction did not commit, else v14 with the conversations done reading back and the others as they were. */
function assertAfterKill(db: DatabaseSync, pristine: Dump, originals: ReadonlyMap<string, string>, label: string): void {
  ok(db);
  const version = userVersion(db);
  if (version === 13) { assert.deepEqual(dumpOf(db), pristine, label + ": the first transaction did not commit and nothing of it did"); return; }
  assert.equal(version, 14, label);
  for (const row of db.prepare("SELECT id, format, head, last_error FROM sessions").all()) {
    const id = String(row.id);
    if (row.format === 14) assertReadsBack(db, id, originals.get(id)!, label + " " + id);
    else { assert.equal(row.head, originals.get(id), label + " " + id + " is as it was"); assert.equal(count(db, "SELECT COUNT(*) AS n FROM runs WHERE session_id=?", id), 0, label + " " + id + ": no rows of an unfinished conversation"); }
    assert.equal(row.last_error, null, label + ": a kill is not a failure to explain");
  }
}
test("killed at every step, and at random moments, and run again, the migration leaves exactly the rows an uninterrupted one leaves", async t => {
  const directory = temporary(t), base = join(directory, "base"), fixtures = sharable(["switches", "commands", "tools", "branch", "relay-states", "import", "text-extremes", "unknown-acknowledged", "kept-process"]);
  writeV13Root(base, together(fixtures));
  const probe = connect(t, base);
  const originals = snapshotsOf(probe), pristine = dumpOf(probe);
  probe.close();
  const conversations = originals.size;
  assert.ok(conversations >= 18, "enough conversations to kill between and inside");

  // The uninterrupted run.
  const whole = join(directory, "whole");
  cpSync(base, whole, { recursive: true });
  const wholeDb = connect(t, whole);
  let steps = 0;
  assert.equal(migrateToV14(wholeDb, { root: whole, step: () => { steps++; } }).stopped, null);
  const expected = dumpOf(wholeDb);
  assert.equal(steps, 3 + 2 * conversations + 1);
  // How long it takes in this process, for the moments to kill it at.
  const timed = join(directory, "timed");
  cpSync(base, timed, { recursive: true });
  const timedDb = connect(t, timed), clock = performance.now();
  migrateToV14(timedDb, { root: timed });
  const wholeMs = performance.now() - clock;

  const finish = (root: string, label: string, signal: NodeJS.Signals | null): void => {
    const db = new DatabaseSync(join(root, "gateway.sqlite"));
    try {
      assertAfterKill(db, pristine, originals, label + (signal === null ? " (finished before the kill)" : ""));
      const resumed = migrateToV14(db, { root });
      assert.equal(resumed.stopped, null, label);
      assert.deepEqual(dumpOf(db), expected, label + ": the same rows as an uninterrupted migration");
      assert.equal(migrationState(db).kind, "done");
    } finally { db.close(); }
  };

  // Killed by itself at each step in turn: before the backup, after it, after the first transaction, inside a conversation's transaction (written, not committed), after its commit, at the end.
  for (let step = 1; step <= steps; step++) {
    const root = join(directory, "step-" + step);
    cpSync(base, root, { recursive: true });
    const result = await peer(root, ["--kill-at", String(step)]);
    assert.equal(result.signal, "SIGKILL", "step " + step + " killed the process");
    finish(root, "killed at step " + step, result.signal);
  }

  // Killed from outside at random moments after it begins, with and without a pause at each step to put the moments inside the work.
  let seed = 20261112;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  let killed = 0;
  const states = new Map<string, number>();
  for (let round = 0; round < 20; round++) {
    const root = join(directory, "random-" + round);
    cpSync(base, root, { recursive: true });
    const pause = round % 2 === 0 ? 5 : 0, window = 1.1 * (wholeMs + steps * pause);
    const result = await peer(root, pause === 0 ? [] : ["--pause", String(pause)], Math.floor(random() * window));
    if (result.signal === "SIGKILL") killed++;
    const left = new DatabaseSync(join(root, "gateway.sqlite"));
    try { const kind = userVersion(left) === 13 ? "before the first transaction ended" : `${count(left, "SELECT COUNT(*) AS n FROM sessions WHERE format=14")} of ${conversations} converted`; states.set(kind, (states.get(kind) ?? 0) + 1); } finally { left.close(); }
    finish(root, "random kill " + round, result.signal);
  }
  t.diagnostic(`${killed} of 20 random kills landed before the end, leaving: ${[...states].map(([kind, times]) => `${kind} x${times}`).join("; ")}`);
  assert.ok(killed >= 5, "a fair share of the random kills landed before the end (" + killed + " of 20)");
  assert.ok(states.size >= 3, "the kills left the database in different places");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------------------------------------------------------------
test("measure: 2,048 Turns in 8 conversations of 256 (the most the v13 runtime kept), converted one transaction at a time", async t => {
  const directory = temporary(t), root = join(directory, "data");
  writeV13Root(root, [syntheticFixture(8, { runs: 256, replyBytes: 24_000, thinkingBytes: 2_000, tools: 6 })]);
  const bytes = statSync(join(root, "gateway.sqlite")).size;
  const result = await peer(root);
  assert.equal(result.code, 0);
  const report = (result.last!.report as { stopped: unknown; converted: number; references: { equal: boolean } });
  assert.equal(report.stopped, null);
  assert.equal(report.converted, 8);
  assert.equal(report.references.equal, true);
  const seconds = Number(result.last!.seconds), rssMiB = Number(result.last!.maxRssKb) / 1024;
  t.diagnostic(`8 conversations x 256 Turns (${(bytes / 1048576).toFixed(1)} MiB database): converted in ${seconds.toFixed(2)} s, peak resident memory ${rssMiB.toFixed(0)} MiB`);
  const db = connect(t, root, true);
  assert.equal(count(db, "SELECT SUM(run_count) AS n FROM sessions"), 2048);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM runs"), 2048);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE format=14"), 8);
  ok(db);
  // Memory follows one conversation, not the library: a single conversation of the same size is not far below the eight.
  const one = join(directory, "one");
  writeV13Root(one, [syntheticFixture(1, { runs: 256, replyBytes: 24_000, thinkingBytes: 2_000, tools: 6 })]);
  const single = await peer(one), singleMiB = Number(single.last!.maxRssKb) / 1024;
  t.diagnostic(`one conversation of 256 Turns: converted in ${Number(single.last!.seconds).toFixed(2)} s, peak resident memory ${singleMiB.toFixed(0)} MiB`);
  assert.ok(rssMiB < 3 * singleMiB + 100, "memory does not grow with the number of conversations");
  assert.ok(rssMiB < 1024);
  assert.ok(seconds < 60);
});
