import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SessionError } from "../../src/contracts/session.js";
import { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { SCHEMA_V14_FINGERPRINT, fingerprintOf } from "../../src/infrastructure/session/schema-fingerprint.js";
import { schemaV14Definition } from "../../src/infrastructure/session/schema-v14.js";
import { checkUpgrade, describeCheck } from "../../src/infrastructure/session/upgrade-preflight.js";
import { appStore } from "../fixtures/runtime-store.js";
import { Scenario, created, newConversation, temporary } from "../fixtures/store-helpers.js";
import { loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";

// The fingerprint of the table structure (src/infrastructure/session/schema-fingerprint.ts): written into a database when it is made or upgraded to v14, compared at every start, so that a database
// whose structure another build wrote is refused at once, with a code of its own, and left exactly as it was. Real data roots in temporary directories, real stores; nothing is made up.

/** What a database file holds, bytes and all, with its log: two reads of the same state are the same digest. */
function bytesOf(data: string): string {
  const hash = createHash("sha256");
  for (const name of ["gateway.sqlite", "gateway.sqlite-wal"]) if (existsSync(join(data, name))) hash.update(name).update(readFileSync(join(data, name)));
  return hash.digest("hex");
}
function raw<T>(data: string, use: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(data, "gateway.sqlite"));
  try { return use(db); } finally { db.close(); }
}
const stampOf = (data: string): string | null => raw(data, db => {
  if (db.prepare("SELECT 1 AS found FROM sqlite_master WHERE name='schema_stamp'").get() === undefined) return null;
  return String(db.prepare("SELECT fingerprint FROM schema_stamp").get()?.fingerprint ?? null);
});
/** A data root of a real store that holds one conversation with a finished Turn, closed. */
function root(t: TestContext): string {
  const data = join(temporary(t), "data"), store = appStore(data);
  try {
    const id = created(store, newConversation("/work", "kept")).conversation.id;
    new Scenario(store, id, "run-kept", false).turn("a question", "an answer");
  } finally { store.close(); }
  return data;
}
/** What an earlier build left: `derived` without the column the backfill reads. */
const OLD_DERIVED = (db: DatabaseSync): void => {
  db.exec("DROP TABLE derived");
  db.exec("CREATE TABLE derived(name TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN('empty','building','ready')), updated_at INTEGER NOT NULL) STRICT, WITHOUT ROWID");
  db.exec("INSERT INTO derived(name,state,updated_at) VALUES('search_fts','ready',1),('search_chars','ready',1)");
};
function refused(open: () => SqliteConversationStore): SessionError {
  try { open().close(); } catch (error) { assert.ok(error instanceof SessionError, String(error)); return error; }
  return assert.fail("the database was opened");
}

test("the fingerprint is the digest of the statements that define the structure, whatever their layout: the words change it and the whitespace does not", () => {
  const statements = schemaV14Definition();
  assert.equal(SCHEMA_V14_FINGERPRINT, fingerprintOf(statements));
  assert.match(SCHEMA_V14_FINGERPRINT, /^[0-9a-f]{64}$/u);
  assert.equal(fingerprintOf(statements.map(statement => statement.replace(/ /gu, "  \n\t"))), SCHEMA_V14_FINGERPRINT, "layout is no part of what a statement says");
  assert.notEqual(fingerprintOf(statements.map(statement => statement.replace("progress INTEGER NOT NULL DEFAULT 0", "progress INTEGER NOT NULL DEFAULT 1"))), SCHEMA_V14_FINGERPRINT);
  assert.notEqual(fingerprintOf(statements.slice(1)), SCHEMA_V14_FINGERPRINT);
  assert.notEqual(fingerprintOf([...statements].reverse()), SCHEMA_V14_FINGERPRINT, "nor is their order");
  assert.equal(statements.some(statement => /VIRTUAL TABLE/u.test(statement)), false, "the full-text tables are derived data and are no part of it");
});

test("a new database carries the fingerprint of this build, and opening it again keeps the very same", t => {
  const data = root(t);
  assert.equal(stampOf(data), SCHEMA_V14_FINGERPRINT);
  for (let round = 0; round < 2; round++) { appStore(data).close(); assert.equal(stampOf(data), SCHEMA_V14_FINGERPRINT, "after open number " + (round + 2)); }
  assert.equal(raw(data, db => db.prepare("SELECT COUNT(*) AS n FROM schema_stamp").get()?.n), 1, "one stamp, not one for each start");
});

test("a database upgraded from v13 carries it too", t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("commands")]);
  assert.equal(stampOf(data), null, "a v13 library has none");
  const store = appStore(data);
  try { assert.equal(store.migration?.stopped, null); } finally { store.close(); }
  assert.equal(stampOf(data), SCHEMA_V14_FINGERPRINT);
  // The structure the upgrade leaves (by ALTER and by the rebuild of the relay's tables) is the one this build writes new: a library upgraded before the stamp existed is whole, and is stamped.
  raw(data, db => { db.exec("DROP TABLE schema_stamp"); });
  appStore(data).close();
  assert.equal(stampOf(data), SCHEMA_V14_FINGERPRINT);
});

test("a database that carries another build's fingerprint is refused at its start, with a code of its own, and is left byte for byte as it was", t => {
  const data = root(t);
  raw(data, db => { db.prepare("UPDATE schema_stamp SET fingerprint=?").run("0123456789ab".repeat(5) + "0123"); });
  const before = bytesOf(data);
  const error = refused(() => appStore(data));
  assert.equal(error.code, "SCHEMA_MISMATCH");
  assert.match(error.message, /table structure is inconsistent with this build/u);
  assert.match(error.message, /0123456789ab/u, "it names the two fingerprints, which hold no content");
  assert.equal(error.message.includes("a question") || error.message.includes("an answer"), false);
  assert.equal(bytesOf(data), before, "the database is the very bytes it was");
  assert.equal(bytesOf(data), before, "and stays so when it is asked again");
});

test("a v14 database made before the stamp is stamped when its structure is whole, and refused, unchanged, when it is not", t => {
  const whole = root(t);
  raw(whole, db => { db.exec("DROP TABLE schema_stamp"); });
  const store = appStore(whole);
  try { assert.equal(store.get(store.list().rows[0]!.id).runs.length, 1, "it opens and reads"); } finally { store.close(); }
  assert.equal(stampOf(whole), SCHEMA_V14_FINGERPRINT, "and is stamped");

  const drifted = root(t);
  raw(drifted, db => { db.exec("DROP TABLE schema_stamp"); OLD_DERIVED(db); });
  const before = bytesOf(drifted);
  const error = refused(() => appStore(drifted));
  assert.equal(error.code, "SCHEMA_MISMATCH");
  assert.match(error.message, /derived/u, "it names the table that is not as this build writes it");
  assert.equal(bytesOf(drifted), before, "nothing was written, the stamp included");
  assert.equal(stampOf(drifted), null);
});

test("a trigger or an index that is missing, or written otherwise, is a structure that differs", t => {
  for (const change of ["DROP TRIGGER runs_terminal_fixed", "DROP INDEX runs_open", "DROP TRIGGER items_frozen_update; CREATE TRIGGER items_frozen_update BEFORE UPDATE ON items BEGIN SELECT 1; END"]) {
    const data = root(t);
    raw(data, db => { db.exec("DROP TABLE schema_stamp"); db.exec(change); });
    const error = refused(() => appStore(data));
    assert.equal(error.code, "SCHEMA_MISMATCH", change);
    assert.match(error.message, /runs_terminal_fixed|runs_open|items_frozen_update/u, change);
  }
});

test("the check that reads a library without changing it says so too: a library of another structure does not pass, one of this build's does", t => {
  const good = root(t), bad = root(t);
  raw(bad, db => { db.exec("DROP TABLE schema_stamp"); OLD_DERIVED(db); });
  const before = bytesOf(bad);
  const passed = checkUpgrade(good), failed = checkUpgrade(bad);
  assert.equal(passed.ok, true, describeCheck(passed).join(" | "));
  assert.equal(failed.ok, false);
  assert.ok(failed.problems.some(problem => /table structure is inconsistent with this build/u.test(problem)), JSON.stringify(failed.problems));
  assert.ok(describeCheck(failed).some(line => /table structure is inconsistent with this build/u.test(line)), describeCheck(failed).join("\n"));
  assert.equal(bytesOf(bad), before, "the check changed nothing");
});
