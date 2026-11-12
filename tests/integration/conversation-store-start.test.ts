import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SessionError, sessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { SqliteConversationStore, type SqliteConversationStoreOptions } from "../../src/infrastructure/session/conversation-store.js";
import { canonicalJson } from "../../src/infrastructure/session/rows.js";
import { snapshotFromRows } from "../../src/infrastructure/session/snapshot-adapter.js";
import { V12_FIXTURES, loadV12Fixture, writeV12Root } from "../fixtures/relay/v12/database.js";
import { GENERATIONS, loadGeneration, writeGenerationRoot } from "../fixtures/storage/generations/database.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root, type V13Fixture, type V13FixtureName } from "../fixtures/storage/v13/database.js";
import { code, count, rawDatabase, recoverUnfinished, temporary } from "../fixtures/store-helpers.js";

// Opening a data root with the store of conversations: a root a v13 build left (every frozen fixture), a root of an older generation, a root whose upgrade was stopped by a
// conversation that does not convert or by a process that was killed, a root that cannot be upgraded (no room, a backup that fails), and the recovery that follows. Only the
// Harness and the model are made up; the databases are SQLite files in temporary directories and nothing here opens a real data root.

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const migrationPeer = join(repository, "tests/fixtures/migration-peer.mjs");
const storePeer = join(repository, "tests/fixtures/conversation-store-peer.mjs");

function opened(t: TestContext, data: string, options: SqliteConversationStoreOptions = {}): SqliteConversationStore {
  const store = new SqliteConversationStore(data, options);
  t.after(() => { try { store.close(); } catch { /* closed by the test, or disabled and asserted */ } });
  return store;
}
const userVersion = (db: DatabaseSync): number => Number(db.prepare("PRAGMA user_version").get()?.user_version);
const ok = (db: DatabaseSync): void => {
  assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map(row => ({ ...row })), [{ integrity_check: "ok" }]);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
};
/** The rows of the tables a conversation is made of, as text and sorted, so that two databases can be compared where the owner's own bookkeeping does not matter. */
const V13_TABLES = ["sessions", "events", "create_keys", "relay_bodies", "relay_packets", "relay_deliveries", "relay_index", "relay_log", "relay_prefs"];
function v13Rows(db: DatabaseSync): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(V13_TABLES.map(table => [table, db.prepare('SELECT * FROM "' + table + '"').all().map(row => JSON.stringify(row)).sort()]));
}
const CONVERSATION_TABLES = ["sessions", "runs", "items", "item_text", "bindings", "commands", "switches", "origin_history", "content_refs", "notice_prints", "create_keys", "relay_bodies", "relay_packets", "relay_deliveries", "relay_index"];
function conversationRows(db: DatabaseSync): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(CONVERSATION_TABLES.map(table => [table, db.prepare('SELECT * FROM "' + table + '"').all().map(row => JSON.stringify(row)).sort()]));
}
function originalsOf(db: DatabaseSync): Map<string, string> {
  return new Map(db.prepare("SELECT id, snapshot FROM sessions ORDER BY rowid").all().map(row => [String(row.id), String(row.snapshot)]));
}
/** A conversation as the old snapshot said it, and as the new tables give it back: the same but for the version (one more) and an empty list of bindings where there were none. */
function assertReadsBack(snapshot: SessionSnapshot, original: string, where: string): void {
  const before = JSON.parse(original) as SessionSnapshot, expected = { ...before, version: before.version + 1, nativeBindings: before.nativeBindings ?? [] };
  assert.deepStrictEqual(JSON.parse(canonicalJson({ ...snapshot, nativeBindings: snapshot.nativeBindings ?? [] })), JSON.parse(canonicalJson(expected)), where);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Every frozen v13 fixture: the store opens it (the upgrade, then the recovery), and every conversation reads back
// ---------------------------------------------------------------------------------------------------------------------------------
for (const name of V13_FIXTURES) {
  test(`${name}: the store opens it, upgrades it, recovers what its owner left, and every conversation checks, reads back in the old shape as it was, and breaks no rule`, t => {
    const fixture = loadV13Fixture(name), data = join(temporary(t), "data");
    writeV13Root(data, [fixture]);
    const before = rawDatabase(data, true), originals = originalsOf(before); before.close();
    const store = opened(t, data, { recover: recoverUnfinished, now: () => new Date("2026-11-13T00:00:00.000Z") });
    const report = store.migration;
    assert.ok(report !== null && report.stopped === null && report.from === 13);
    assert.equal(report.converted, fixture.sessions.length); assert.equal(report.references?.equal, true);
    assert.equal(store.ownerGeneration, fixture.ownerGeneration + 1);
    assert.deepEqual(store.unfinished(), [], "nothing is left unfinished");
    const reader = rawDatabase(data, true);
    try {
      ok(reader);
      for (const row of fixture.sessions) {
        const id = sessionId(row.id), conversation = store.get(id);
        assert.deepEqual(verify(conversation, store), [], row.id + " breaks no rule");
        // What the store gives the readers that have not moved to items is what the one-shot adapter gives, from the rows.
        const snapshot = store.snapshot(id);
        assert.deepStrictEqual(snapshot, snapshotFromRows(reader, id), row.id + ": the snapshot is the adapter's");
        if (!fixture.unfinished) assertReadsBack(snapshot, originals.get(row.id)!, row.id);
        assert.equal(store.snapshot(id).runs.length, conversation.runs.length);
        assert.equal(store.head(id).runCount, conversation.runs.length);
      }
      // The content the conversations refer to is the set the v13 store that wrote the fixture worked out.
      assert.deepEqual([...store.contentReferences()].sort(), fixture.contentReferences);
      assert.equal(store.collectionGate().allowed, false, "the first start after an upgrade only reports what the collector would collect");
      assert.equal(store.collectionGate().reportOnly, true);
      assert.equal(userVersion(reader), 14);
    } finally { reader.close(); }
  });
}

test("a new root is a v14 database from the start: the tables and relay tables an upgraded root has, both full-text indexes ready, nothing to convert", t => {
  const root = temporary(t), fresh = join(root, "fresh"), upgraded = join(root, "upgraded");
  const store = opened(t, fresh);
  assert.equal(store.migration, null); assert.equal(store.ownerGeneration, 1);
  assert.deepEqual(store.collectionGate(), { allowed: true, reportOnly: false, reason: null }, "a root that was never upgraded has nothing to hold the collector back");
  writeV13Root(upgraded, [loadV13Fixture("switches")]);
  opened(t, upgraded).close();
  store.close();
  const left = rawDatabase(fresh, true), right = rawDatabase(upgraded, true);
  try {
    assert.equal(userVersion(left), 14); assert.equal(userVersion(right), 14);
    const shape = (db: DatabaseSync) => db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_%_%' AND name NOT LIKE 'migration_v14%' ORDER BY type, name").all().map(row => row.type + " " + row.name);
    assert.deepEqual(shape(left), shape(right), "the same tables, indexes and triggers");
    for (const table of shape(left).filter(entry => entry.startsWith("table ")).map(entry => entry.slice(6))) {
      const columns = (db: DatabaseSync) => db.prepare('PRAGMA table_info("' + table + '")').all().map(row => [row.name, row.type, row.notnull, row.pk].join(":")).sort();
      assert.deepEqual(columns(left), columns(right), table + " has the same columns");
    }
    const sql = (db: DatabaseSync, name: string) => String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql).replace(/\s+/gu, " ");
    for (const name of ["relay_packets", "relay_bodies", "relay_packets_immutable", "relay_bodies_immutable"]) assert.equal(sql(left, name), sql(right, name), name);
    assert.deepEqual(left.prepare("SELECT name, state FROM derived ORDER BY name").all().map(row => ({ ...row })), [{ name: "search_chars", state: "ready" }, { name: "search_fts", state: "ready" }]);
    assert.deepEqual(right.prepare("SELECT name, state FROM derived").all(), [], "an upgraded root has indexes to build, which is a command of its own");
    ok(left); ok(right);
  } finally { left.close(); right.close(); }
});

test("a conversation whose first words end in half a pair at the cut of the title converts: the title is cut before the character, not through it", t => {
  const fixture = loadV13Fixture("switches"), first = fixture.sessions[0]!, snapshot = first.snapshot as { messages: { role: string; text: string }[] };
  const original = snapshot.messages.find(message => message.role === "user")!.text, emoji = "x".repeat(79) + "😀 and the rest of the first question";
  const swap = (value: unknown): unknown => typeof value === "string" ? (value === original ? emoji : value) : Array.isArray(value) ? value.map(swap)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)])) : value;
  const data = join(temporary(t), "data");
  writeV13Root(data, [{ ...fixture, sessions: fixture.sessions.map((row, index) => index === 0 ? { ...row, snapshot: swap(row.snapshot) as Record<string, unknown>, events: swap(row.events) as typeof row.events } : row) }]);
  const store = opened(t, data);
  assert.equal(store.migration?.stopped, null);
  assert.equal(store.head(sessionId(first.id)).title, "x".repeat(79), "cut before the pair, so that the column holds what the title says");
  assert.equal(store.snapshot(sessionId(first.id)).messages.find(message => message.role === "user")!.text, emoji, "and the words themselves are whole");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Older generations and the backup
// ---------------------------------------------------------------------------------------------------------------------------------
for (const version of [1, 4, 11] as const) {
  test(`a root of store v${version} is backed up as it was, climbs the old ladder, and opens as v14`, t => {
    const data = join(temporary(t), "data");
    writeGenerationRoot(data, loadGeneration(version));
    const store = opened(t, data);
    assert.equal(store.migration?.from, version); assert.equal(store.migration?.stopped, null);
    const backup = join(data, "backups", "gateway-v" + version + "-before-v14.sqlite");
    assert.equal(realpathSync(store.migration!.backup!), realpathSync(backup)); assert.equal(statSync(backup).mode & 0o777, 0o600);
    const copy = new DatabaseSync(backup, { readOnly: true });
    try { assert.equal(userVersion(copy), version); assert.ok(count(copy, "sessions") >= 1); } finally { copy.close(); }
    for (const row of store.list().rows) assert.deepEqual(verify(store.get(sessionId(row.id)), store), []);
    assert.equal(store.list().rows.length, count(rawDatabase(data, true), "sessions"));
  });
}
test("a root of store v12 opens as v14, and the backup of a v13 root is not one of the rotated ones", t => {
  const data = join(temporary(t), "data");
  writeV12Root(data, [loadV12Fixture(V12_FIXTURES[0]!)]);
  const store = opened(t, data); assert.equal(store.migration?.from, 12); store.close();
  assert.ok(existsSync(join(data, "backups", "gateway-v12-before-v14.sqlite")));
  const other = join(temporary(t), "data");
  writeV13Root(other, [loadV13Fixture("tools")]);
  const second = opened(t, other, { now: () => new Date("2026-11-13T00:00:00.000Z") }); second.close();
  assert.deepEqual(readdirSync(join(other, "backups")), ["gateway-v13-before-v14.sqlite"]);
  assert.equal(GENERATIONS.length >= 11, true);
});

test("an upgrade that has no room, or whose backup cannot be made, changes nothing, claims nothing and lets the lock go", t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("tools")]);
  const pristine = rawDatabase(data, true), rows = v13Rows(pristine), owner = { ...pristine.prepare("SELECT * FROM owner_metadata").get() }; pristine.close();
  const unchanged = (label: string): void => {
    const db = rawDatabase(data, true);
    try {
      assert.equal(userVersion(db), 13, label); assert.deepEqual({ ...db.prepare("SELECT * FROM owner_metadata").get() }, owner, label); assert.deepEqual(v13Rows(db), rows, label);
    } finally { db.close(); }
    const lock = new DatabaseSync(join(data, "owner.sqlite"), { timeout: 0 });
    try { lock.exec("BEGIN EXCLUSIVE"); lock.exec("ROLLBACK"); } finally { lock.close(); }
  };
  assert.throws(() => new SqliteConversationStore(data, { freeBytes: () => 10 }), code("INSUFFICIENT_SPACE"));
  unchanged("no room"); assert.equal(existsSync(join(data, "backups")), false, "and nothing was written");
  // Something that is not a directory where the backups go: the backup cannot be made, so nothing is.
  writeFileSync(join(data, "backups"), "a file of the user's", { mode: 0o600 });
  assert.throws(() => new SqliteConversationStore(data), code("STORAGE_BACKUP_FAILED"));
  unchanged("a backup that cannot be made"); assert.equal(readFileSync(join(data, "backups"), "utf8"), "a file of the user's");
  rmSync(join(data, "backups"));
  const store = opened(t, data); assert.equal(store.migration?.stopped, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// An upgrade that stops
// ---------------------------------------------------------------------------------------------------------------------------------
/**
 * The fixtures made fit for one database, as migrate-v14.test.ts does it: each was made alone, and two hold the same native session (`native-alpha-1`), which one database never
 * does (the tables key on it). Those that share a conversation or a create key with an earlier one are left out; all but the first get their native sessions renamed.
 */
function sharedRoot(t: TestContext, names: readonly V13FixtureName[]): string {
  const taken = new Set<string>(), chosen: V13Fixture[] = [];
  for (const name of names) {
    const fixture = loadV13Fixture(name);
    if (fixture.sessions.some(row => taken.has(row.id)) || fixture.createKeys.some(row => taken.has("key:" + row.commandId))) continue;
    for (const row of fixture.sessions) taken.add(row.id);
    for (const row of fixture.createKeys) taken.add("key:" + row.commandId);
    chosen.push(fixture);
  }
  const together = chosen.map((fixture, index) => {
    if (index === 0) return fixture;
    const own = new Set(fixture.sessions.flatMap(row => ((row.snapshot.nativeBindings ?? []) as readonly { checkpoint: string }[]).map(binding => binding.checkpoint)));
    const swap = (value: unknown): unknown => typeof value === "string" ? (own.has(value) ? value + "-f" + index : value) : Array.isArray(value) ? value.map(swap)
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)])) : value;
    return { ...fixture, sessions: fixture.sessions.map(row => ({ ...row, snapshot: swap(row.snapshot) as Record<string, unknown>, events: swap(row.events) as typeof row.events })) };
  });
  const data = join(temporary(t), "data");
  writeV13Root(data, together);
  return data;
}

test("a conversation that does not convert stops the start: the error names the conversation and the kind of cause and not a word of it, the lock is let go, and the start goes on from there when the cause is fixed", t => {
  const data = sharedRoot(t, ["switches", "commands", "tools"]);
  const probe = rawDatabase(data), ids = probe.prepare("SELECT id FROM sessions ORDER BY rowid").all().map(row => String(row.id)), original = originalsOf(probe);
  assert.ok(ids.length >= 3);
  const broken = ids[1]!, snapshot = JSON.parse(original.get(broken)!) as { runs: { userMessageId: string }[]; messages: { text: string }[] };
  const secret = "the words of a private conversation";
  snapshot.messages[0]!.text = secret;
  snapshot.runs[0]!.userMessageId = "message-nowhere";
  probe.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), broken); probe.close();
  let failure: unknown;
  const lines: string[] = [];
  try { new SqliteConversationStore(data, { log: line => lines.push(line) }); } catch (error) { failure = error; }
  assert.ok(lines.length > 0 && lines.every(line => line.includes(broken) && !line.includes(secret)), "what is logged names the conversation and not its words: " + lines.join(" | "));
  assert.ok(failure instanceof SessionError && failure.code === "MIGRATION_STOPPED", String(failure));
  assert.ok(failure.message.includes(broken), "it names the conversation: " + failure.message);
  assert.ok(!failure.message.includes(secret) && !failure.message.includes("message-nowhere"), "and not what it said");
  const left = rawDatabase(data);
  try {
    assert.equal(userVersion(left), 14); ok(left);
    assert.equal(count(left, "sessions", "format=14"), 1, "the one before it was converted"); assert.equal(count(left, "sessions", "format<14"), ids.length - 1);
    assert.match(String(left.prepare("SELECT last_error FROM sessions WHERE id=?").get(broken)?.last_error), /./u, "and the reason is kept with it");
    assert.equal(count(left, "runs", "session_id=?".replace("?", "'" + broken + "'")), 0);
    assert.equal(Number(left.prepare("SELECT owner_active FROM owner_metadata").get()?.owner_active), 0, "the owner is marked as gone");
    assert.ok(existsSync(join(data, "backups", "gateway-v13-before-v14.sqlite")));
  } finally { left.close(); }
  // Not even in the same process is the next start told an owner may be alive.
  assert.throws(() => new SqliteConversationStore(data), code("MIGRATION_STOPPED"));
  const fixed = rawDatabase(data);
  fixed.prepare("UPDATE sessions SET head=? WHERE id=?").run(original.get(broken)!, broken); fixed.close();
  const store = opened(t, data);
  assert.equal(store.migration?.stopped, null); assert.equal(store.migration?.from, 14);
  assert.equal(store.migration?.alreadyConverted, 1); assert.equal(store.migration?.converted, ids.length - 1);
  const reader = rawDatabase(data, true);
  try {
    ok(reader);
    for (const id of ids) {
      assert.deepEqual(verify(store.get(sessionId(id)), store), [], id);
      assertReadsBack(store.snapshot(sessionId(id)), original.get(id)!, id);
    }
    assert.equal(count(reader, "sessions", "format<14"), 0); assert.equal(reader.prepare("SELECT last_error FROM sessions WHERE id=?").get(broken)?.last_error, null);
  } finally { reader.close(); }
});

test("a conversation the whole-conversation check finds wrong stops the start the same way, with the rule and where, and the checker is the store's by default", t => {
  const data = sharedRoot(t, ["switches", "commands"]);
  const calls: string[] = [];
  assert.throws(() => new SqliteConversationStore(data, { verify: conversation => { calls.push(conversation.id); return [{ rule: "fixture-rule", where: "run run-x", detail: "a fixture finding" }]; } }),
    error => error instanceof SessionError && error.code === "MIGRATION_STOPPED" && /fixture-rule at run run-x/u.test(error.message) && error.message.includes(calls[0]!));
  assert.equal(calls.length, 1, "the first finding ended it");
  const store = opened(t, data);
  assert.equal(store.migration?.stopped, null);
});

test("a start killed at each point of the upgrade, and at random moments, leaves a root the next start upgrades to the rows an uninterrupted start leaves", async t => {
  const base = sharedRoot(t, ["switches", "commands", "tools", "branch", "relay-states", "import", "text-extremes", "unknown-acknowledged", "kept-process"]);
  const probe = rawDatabase(base, true), conversations = count(probe, "sessions"); probe.close();
  assert.ok(conversations >= 18);
  const whole = join(temporary(t), "whole"); cpSync(base, whole, { recursive: true });
  let steps = 0;
  opened(t, whole, { migrationStep: () => { steps++; } }).close();
  const expectedDb = rawDatabase(whole, true), expected = conversationRows(expectedDb); expectedDb.close();
  assert.equal(steps, 3 + 2 * conversations + 1);
  const finish = (root: string, label: string): void => {
    const store = new SqliteConversationStore(root);
    try { assert.ok(store.migration === null || store.migration.stopped === null, label); } finally { store.close(); }
    const db = rawDatabase(root, true);
    try { ok(db); assert.deepEqual(conversationRows(db), expected, label + ": the same rows as an uninterrupted start"); assert.equal(count(db, "sessions", "format<14"), 0, label); } finally { db.close(); }
  };
  const run = async (root: string, args: readonly string[], killAfterMs?: number): Promise<NodeJS.Signals | null> => {
    const child = spawn(process.execPath, [storePeer, root, "open", ...args], { stdio: ["ignore", "ignore", "inherit"] });
    const timer = killAfterMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    const [, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    if (timer !== undefined) clearTimeout(timer);
    return signal;
  };
  for (let step = 1; step <= steps; step++) {
    const root = join(temporary(t), "step-" + step); cpSync(base, root, { recursive: true });
    assert.equal(await run(root, ["--kill-at", String(step)]), "SIGKILL", "step " + step + " killed the process");
    finish(root, "killed at step " + step);
  }
  let seed = 20261112, killed = 0;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const timing = join(temporary(t), "timing"); cpSync(base, timing, { recursive: true });
  const startedAt = performance.now(); new SqliteConversationStore(timing).close(); const wholeMs = performance.now() - startedAt;
  for (let round = 0; round < 12; round++) {
    const root = join(temporary(t), "random-" + round); cpSync(base, root, { recursive: true });
    const pause = round % 2 === 0 ? 5 : 0;
    const signal = await run(root, pause === 0 ? [] : ["--pause", String(pause)], Math.floor(random() * 1.2 * (wholeMs + steps * pause) + 80));
    if (signal === "SIGKILL") killed++;
    finish(root, "random kill " + round);
  }
  t.diagnostic(`${killed} of 12 random kills landed before the end`);
  assert.ok(killed >= 3);
});

test("an upgrade that the migration alone began and a process killed (the migration peer) is finished by the store, whatever step it stopped at", async t => {
  const base = sharedRoot(t, ["switches", "commands", "tools", "branch"]);
  const probe = rawDatabase(base, true), conversations = count(probe, "sessions"); probe.close();
  const whole = join(temporary(t), "whole"); cpSync(base, whole, { recursive: true });
  opened(t, whole).close();
  const expectedDb = rawDatabase(whole, true), expected = conversationRows(expectedDb); expectedDb.close();
  for (const step of [1, 2, 3, 4, 3 + conversations, 3 + 2 * conversations]) {
    const root = join(temporary(t), "step-" + step); cpSync(base, root, { recursive: true });
    const child = spawn(process.execPath, [migrationPeer, root, "--kill-at", String(step)], { stdio: ["ignore", "ignore", "inherit"] });
    const [, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(signal, "SIGKILL");
    const store = new SqliteConversationStore(root);
    try { assert.ok(store.migration === null || store.migration.stopped === null, "step " + step); } finally { store.close(); }
    const db = rawDatabase(root, true);
    try { ok(db); assert.deepEqual(conversationRows(db), expected, "killed in the migration at step " + step); } finally { db.close(); }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Recovery visits the unfinished and no more
// ---------------------------------------------------------------------------------------------------------------------------------
test("recovery asks only for the conversations with work not finished: the start loads none of the others, however many there are", t => {
  const data = sharedRoot(t, ["switches", "commands", "tools", "branch", "relay-states", "import", "running-crash", "waiting-crash", "kept-process"]);
  const probe = rawDatabase(data, true), total = count(probe, "sessions"); probe.close();
  const visited: string[] = [];
  const store = opened(t, data, { recover: current => { visited.push(current.id); return recoverUnfinished(current); } });
  assert.ok(total >= 10);
  assert.ok(visited.length >= 2 && visited.length < total, `${visited.length} of ${total} conversations were visited`);
  assert.equal(store.cacheStats().conversations.misses, visited.length, "and no other conversation was read for it");
  assert.deepEqual(store.unfinished(), []);
  for (const id of visited) assert.deepEqual(verify(store.get(sessionId(id)), store), [], id);
});

test("a recovery that fails ends the start with the conversations before it recovered and the one that failed untouched, and the next start recovers the rest", t => {
  const data = sharedRoot(t, ["running-crash", "waiting-crash"]);
  const probe = rawDatabase(data, true), ids = probe.prepare("SELECT id FROM sessions ORDER BY rowid").all().map(row => String(row.id)); probe.close();
  let calls = 0;
  assert.throws(() => new SqliteConversationStore(data, { recover: current => { calls++; if (calls === 2) throw new Error("injected recovery failure"); return recoverUnfinished(current); } }), /injected recovery failure/u);
  const left = rawDatabase(data);
  try {
    ok(left);
    assert.equal(Number(left.prepare("SELECT owner_active FROM owner_metadata").get()?.owner_active), 0);
    assert.equal(count(left, "runs", "status IN ('queued','preparing','running','settling')") > 0, true, "the second conversation was not recovered");
  } finally { left.close(); }
  const store = opened(t, data, { recover: recoverUnfinished });
  assert.deepEqual(store.unfinished(), []);
  for (const id of ids) assert.deepEqual(verify(store.get(sessionId(id)), store), [], id);
});

