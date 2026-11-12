import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { RELAY_DDL } from "../../src/infrastructure/session/relay-tables.js";
import { RELAY_V14_REBUILD, V14_INDEXES, V14_RUN_COLUMNS, V14_SEARCH_TABLES, V14_TABLES, V14_TRIGGERS, schemaV14Statements } from "../../src/infrastructure/session/schema-v14.js";

type Value = SQLInputValue;
type Row = Record<string, unknown>;

/** A real database file in a temporary directory, opened as the store opens its own (WAL, foreign keys on), removed after the test. */
function open(t: TestContext): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "harness-schema-v14-"));
  const db = new DatabaseSync(join(root, "gateway.sqlite"), { timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  return db;
}
function fresh(t: TestContext): DatabaseSync { const db = open(t); for (const sql of schemaV14Statements("fresh")) db.exec(sql); return db; }
const V13_SESSIONS = "CREATE TABLE sessions(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>=1),last_seq INTEGER NOT NULL CHECK(last_seq>=0),snapshot TEXT NOT NULL CHECK(json_valid(snapshot))) STRICT";
function rows(db: DatabaseSync, sql: string, ...args: Value[]): Row[] { return db.prepare(sql).all(...args).map(row => ({ ...row })); }
function insert(db: DatabaseSync, table: string, values: Record<string, Value>): void {
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(values));
}
function change(db: DatabaseSync, sql: string, ...args: Value[]): void { db.prepare(sql).run(...args); }

function conversation(db: DatabaseSync, id: string, values: Record<string, Value> = {}): void { insert(db, "sessions", { id, version: 1, last_seq: 1, head: "{}", format: 14, ...values }); }
function command(db: DatabaseSync, session: string, id: string, kind: string, result: string): void {
  db.prepare("INSERT INTO commands(session_id,ordinal,command_id,kind,fingerprint,result_id) VALUES(?,(SELECT COALESCE(MAX(ordinal)+1,0) FROM commands WHERE session_id=?),?,?,?,?)").run(session, session, id, kind, "f".repeat(64), result);
}
/** A Run and the send command it answers. */
function run(db: DatabaseSync, session: string, ordinal: number, status = "queued", extra: Record<string, Value> = {}): string {
  const runId = `run-${session}-${ordinal}`, commandId = `command-${runId}`;
  command(db, session, commandId, "send", runId);
  insert(db, "runs", { session_id: session, ordinal, run_id: runId, command_id: commandId, status, epoch: 1, harness_id: "harness", control_id: "control", user_seq: ordinal + 2, run_json: "{}", ...extra });
  return runId;
}
function item(db: DatabaseSync, runId: string, seq: number, itemId = `tool:${seq}`, status = "completed"): void { insert(db, "items", { run_id: runId, seq, item_id: itemId, type: "tool", status, item_json: "{}" }); }
function chunk(db: DatabaseSync, runId: string, itemSeq: number, n: number, text: string, byteOffset: number): void {
  insert(db, "item_text", { run_id: runId, item_seq: itemSeq, chunk: n, byte_offset: byteOffset, text, bytes: Buffer.byteLength(text) });
}
function binding(db: DatabaseSync, session: string, ordinal: number, values: Record<string, Value> = {}): void {
  insert(db, "bindings", { session_id: session, ordinal, harness_id: "harness", control_id: "control", checkpoint: `checkpoint-${session}-${ordinal}`, status: "ready", binding_json: "{}", ...values });
}
function switchRow(db: DatabaseSync, session: string, ordinal: number, status: string): string {
  const id = `switch-${session}-${ordinal}`;
  command(db, session, `command-${id}`, "switch", id);
  insert(db, "switches", { session_id: session, ordinal, switch_id: id, command_id: `command-${id}`, status, requested_seq: 2, through_seq: 0, switch_json: "{}" });
  return id;
}
const refuses = (message: RegExp) => (error: unknown): boolean => error instanceof Error && message.test(error.message);
const COMPLETED_NATIVE = '{"backend":{"status":"completed"},"cleanup":{"closed":true,"protocolFailure":null}}';

test("a v13 database's sessions becomes the new table: the columns of a new database, the rows as they were", t => {
  const created = fresh(t), old = open(t);
  old.exec(V13_SESSIONS);
  old.prepare("INSERT INTO sessions(id,version,last_seq,snapshot) VALUES(?,?,?,?)").run("session-old", 3, 7, '{"schemaVersion":13}');
  for (const sql of schemaV14Statements("v13")) old.exec(sql);
  const shape = (db: DatabaseSync) => rows(db, "PRAGMA table_info(sessions)").map(column => [column.name, column.type, column.notnull, column.dflt_value, column.pk].join(":")).sort();
  assert.deepEqual(shape(old), shape(created));
  const [row] = rows(old, "SELECT * FROM sessions");
  assert.equal(row?.head, '{"schemaVersion":13}'); assert.equal(row?.format, 13); assert.equal(row?.version, 3); assert.equal(row?.last_seq, 7);
  assert.throws(() => insert(old, "sessions", { id: "x", version: 1, last_seq: 0, head: "not json" }), refuses(/CHECK/u), "the JSON check followed the renamed column");
  assert.deepEqual(rows(old, "SELECT id FROM sessions WHERE format<14").map(r => r.id), ["session-old"], "an unconverted conversation is found by its format");
});

test("every table, index and trigger is there, and the terminal-Run trigger names every column of runs but the acknowledgement", t => {
  const db = fresh(t);
  const names = new Set(rows(db, "SELECT name FROM sqlite_master").map(r => String(r.name)));
  for (const name of [...V14_TABLES, ...V14_SEARCH_TABLES, ...V14_INDEXES, ...V14_TRIGGERS]) assert.ok(names.has(name), name + " exists");
  assert.deepEqual(rows(db, "PRAGMA table_info(runs)").map(r => r.name), [...V14_RUN_COLUMNS]);
  const sql = String(rows(db, "SELECT sql FROM sqlite_master WHERE name='runs_terminal_fixed'")[0]?.sql);
  const named = /BEFORE UPDATE OF ([^]*?) ON runs/u.exec(sql)![1]!.split(",").map(column => column.trim());
  assert.deepEqual(named, V14_RUN_COLUMNS.filter(column => column !== "acknowledged_by"));
  assert.equal(rows(db, "PRAGMA foreign_key_check").length, 0);
});

test("a conversation has one active Run: a second is refused, another conversation's is not, the next comes when the first has ended", t => {
  const db = fresh(t);
  conversation(db, "one"); conversation(db, "two");
  run(db, "one", 0, "running");
  assert.throws(() => run(db, "one", 1, "preparing"), refuses(/UNIQUE/u));
  assert.throws(() => run(db, "one", 2, "settling"), refuses(/UNIQUE/u));
  run(db, "two", 0, "running");
  run(db, "one", 3, "queued"); run(db, "one", 4, "queued");
  change(db, "UPDATE runs SET status='completed', ended_seq=9 WHERE run_id='run-one-0'");
  change(db, "UPDATE runs SET status='preparing' WHERE run_id='run-one-3'");
  assert.throws(() => change(db, "UPDATE runs SET status='running' WHERE run_id='run-one-4'"), refuses(/UNIQUE/u));
  assert.throws(() => run(db, "one", 5, "queued", { ordinal: 3 }), refuses(/UNIQUE|PRIMARY/u), "an ordinal is used once");
  command(db, "one", "command-again", "send", "run-one-0");
  assert.throws(() => insert(db, "runs", { session_id: "one", ordinal: 6, run_id: "run-one-0", command_id: "command-again", status: "queued", epoch: 1, harness_id: "h", control_id: "c", user_seq: 1, run_json: "{}" }), refuses(/UNIQUE/u), "a Run id is used once");
});

test("a Run answers a send command", t => {
  const db = fresh(t);
  conversation(db, "one");
  const row = { session_id: "one", ordinal: 0, run_id: "run-one-0", command_id: "command-one", status: "queued", epoch: 1, harness_id: "h", control_id: "c", user_seq: 2, run_json: "{}" };
  assert.throws(() => insert(db, "runs", row), refuses(/answers a send command/u));
  command(db, "one", "command-one", "switch", "run-one-0");
  assert.throws(() => insert(db, "runs", row), refuses(/answers a send command/u), "a command of another kind is no answer");
  command(db, "one", "command-two", "send", "run-one-0");
  assert.throws(() => insert(db, "runs", row), refuses(/answers a send command/u), "the command the Run names");
  insert(db, "runs", { ...row, command_id: "command-two" });
});

test("an item's id is unique within its Run and may repeat in another; its place is unique too", t => {
  const db = fresh(t);
  conversation(db, "one");
  const a = run(db, "one", 0, "running");
  item(db, a, 1, "tool:x");
  assert.throws(() => item(db, a, 2, "tool:x"), refuses(/UNIQUE/u));
  assert.throws(() => item(db, a, 1, "tool:y"), refuses(/UNIQUE/u));
  assert.throws(() => insert(db, "items", { run_id: "run-nowhere", seq: 1, item_id: "z", type: "tool", status: "running", item_json: "{}" }), refuses(/FOREIGN KEY/u));
  change(db, "UPDATE items SET type='command' WHERE run_id=? AND seq=1", a);
  assert.throws(() => change(db, "UPDATE items SET item_id='tool:other' WHERE run_id=? AND seq=1", a), refuses(/place and id never change/u));
  change(db, "UPDATE runs SET status='completed' WHERE run_id=?", a);
  const b = run(db, "one", 1, "running");
  item(db, b, 1, "tool:x");
});

test("text is appended chunk after chunk, each where the one before ended, and never changed or taken away; its item counts it", t => {
  const db = fresh(t);
  conversation(db, "one");
  const a = run(db, "one", 0, "running");
  item(db, a, 1, "text:1", "running");
  chunk(db, a, 1, 0, "你好", 0);
  chunk(db, a, 1, 1, " world", 6);
  assert.throws(() => chunk(db, a, 1, 3, "x", 12), refuses(/follows the one before/u), "a chunk number is not skipped");
  assert.throws(() => chunk(db, a, 1, 2, "x", 5), refuses(/follows the one before/u), "a chunk starts where the last ended");
  assert.throws(() => insert(db, "item_text", { run_id: a, item_seq: 1, chunk: 2, byte_offset: 12, text: "abc", bytes: 2 }), refuses(/CHECK/u), "the size is the text's");
  assert.throws(() => chunk(db, a, 9, 0, "x", 0), refuses(/FOREIGN KEY/u), "text belongs to an item");
  assert.throws(() => change(db, "UPDATE item_text SET text='changed' WHERE run_id=?", a), refuses(/only appended/u));
  assert.throws(() => change(db, "DELETE FROM item_text WHERE run_id=?", a), refuses(/text is kept/u));
  assert.deepEqual(rows(db, "SELECT text_bytes AS bytes, text_chunks AS chunks FROM items WHERE run_id=?", a), [{ bytes: 12, chunks: 2 }]);
  assert.equal(rows(db, "SELECT group_concat(text,'') AS text FROM (SELECT text FROM item_text WHERE run_id=? AND item_seq=1 ORDER BY chunk)", a)[0]?.text, "你好 world");
});

test("a finished Run is fixed with its items and text; a conversation being converted is written freely and fixed when it is set to 14", t => {
  const db = fresh(t);
  conversation(db, "one");
  const a = run(db, "one", 0, "running");
  item(db, a, 1, "text:1", "running"); chunk(db, a, 1, 0, "hello", 0);
  change(db, "UPDATE items SET status='completed' WHERE run_id=?", a);
  change(db, "UPDATE runs SET status='completed', ended_seq=5 WHERE run_id=?", a);
  assert.throws(() => change(db, "UPDATE runs SET stop_requested=1 WHERE run_id=?", a), refuses(/terminal Run never changes/u));
  assert.throws(() => change(db, "UPDATE runs SET run_json='{\"x\":1}' WHERE run_id=?", a), refuses(/terminal Run never changes/u));
  assert.throws(() => change(db, "UPDATE items SET status='failed' WHERE run_id=?", a), refuses(/finished Run never change/u));
  assert.throws(() => item(db, a, 2), refuses(/no item is added/u));
  assert.throws(() => chunk(db, a, 1, 1, "more", 5), refuses(/no text is added/u));
  assert.throws(() => change(db, "DELETE FROM items WHERE run_id=?", a), refuses(/item is kept/u));
  assert.throws(() => change(db, "DELETE FROM runs WHERE run_id=?", a), refuses(/Run is kept/u));

  conversation(db, "legacy", { format: 13 });
  const b = run(db, "legacy", 0, "completed", { ended_seq: 3 });
  item(db, b, 1, "text:1"); chunk(db, b, 1, 0, "old", 0); item(db, b, 2); change(db, "UPDATE items SET status='failed' WHERE run_id=? AND seq=2", b);
  change(db, "UPDATE sessions SET format=14 WHERE id='legacy'");
  assert.throws(() => change(db, "UPDATE items SET status='completed' WHERE run_id=? AND seq=2", b), refuses(/finished Run never change/u));
  assert.throws(() => change(db, "UPDATE sessions SET format=13 WHERE id='legacy'"), refuses(/never converted back/u));
});

test("an unknown Run is acknowledged once, and no other finished Run is", t => {
  const db = fresh(t);
  conversation(db, "one");
  const a = run(db, "one", 0, "running"), b = run(db, "one", 1, "queued");
  change(db, "UPDATE runs SET status='unknown' WHERE run_id=?", a);
  assert.throws(() => change(db, "UPDATE runs SET acknowledged_by='switch-1' WHERE run_id=?", b), refuses(/only an unknown Run is acknowledged/u));
  change(db, "UPDATE runs SET acknowledged_by='switch-1' WHERE run_id=?", a);
  assert.throws(() => change(db, "UPDATE runs SET acknowledged_by='switch-2' WHERE run_id=?", a), refuses(/only an unknown Run is acknowledged/u));
  assert.throws(() => change(db, "UPDATE runs SET status='completed' WHERE run_id=?", a), refuses(/terminal Run never changes/u));
});

test("a cancel or a stop is never withdrawn; backend, cleanup and the end's seq are written once; identity and what a dispatched Run was given are fixed", t => {
  const db = fresh(t);
  conversation(db, "one");
  const a = run(db, "one", 0, "running", { run_json: '{"userMessageId":"message-1","contextThroughSeq":4}' });
  change(db, "UPDATE runs SET cancel_requested=1, stop_requested=1 WHERE run_id=?", a);
  assert.throws(() => change(db, "UPDATE runs SET cancel_requested=0 WHERE run_id=?", a), refuses(/never withdrawn/u));
  assert.throws(() => change(db, "UPDATE runs SET stop_requested=0 WHERE run_id=?", a), refuses(/never withdrawn/u));
  change(db, 'UPDATE runs SET run_json=\'{"userMessageId":"message-1","contextThroughSeq":4,"backend":{"status":"completed"}}\' WHERE run_id=?', a);
  assert.throws(() => change(db, 'UPDATE runs SET run_json=\'{"userMessageId":"message-1","contextThroughSeq":4,"backend":{"status":"failed"}}\' WHERE run_id=?', a), refuses(/backend evidence is written once/u));
  change(db, 'UPDATE runs SET run_json=\'{"userMessageId":"message-1","contextThroughSeq":4,"backend":{"status":"completed"},"cleanup":{"closed":true}}\' WHERE run_id=?', a);
  assert.throws(() => change(db, 'UPDATE runs SET run_json=\'{"userMessageId":"message-1","contextThroughSeq":4,"backend":{"status":"completed"},"cleanup":null}\' WHERE run_id=?', a), refuses(/cleanup evidence is written once/u));
  assert.throws(() => change(db, 'UPDATE runs SET run_json=\'{"userMessageId":"message-2","contextThroughSeq":4,"backend":{"status":"completed"},"cleanup":{"closed":true}}\' WHERE run_id=?', a), refuses(/what a Run accepted never changes/u));
  assert.throws(() => change(db, 'UPDATE runs SET run_json=\'{"userMessageId":"message-1","contextThroughSeq":5,"backend":{"status":"completed"},"cleanup":{"closed":true}}\' WHERE run_id=?', a), refuses(/context a dispatched Run was given/u));
  assert.throws(() => change(db, "UPDATE runs SET harness_id='other' WHERE run_id=?", a), refuses(/selection of a dispatched Run/u));
  assert.throws(() => change(db, "UPDATE runs SET command_id='other' WHERE run_id=?", a), refuses(/identity never changes/u));
  assert.throws(() => change(db, "UPDATE runs SET ordinal=7 WHERE run_id=?", a), refuses(/identity never changes/u));
  change(db, "UPDATE runs SET ended_seq=8, status='completed' WHERE run_id=?", a);
  const b = run(db, "one", 1, "queued", { run_json: '{"contextThroughSeq":0}' });
  change(db, "UPDATE runs SET harness_id='other', run_json='{\"contextThroughSeq\":3}' WHERE run_id=?", b);
  change(db, "UPDATE runs SET status='preparing' WHERE run_id=?", b);
  change(db, "UPDATE runs SET ended_seq=9 WHERE run_id=?", b);
  assert.throws(() => change(db, "UPDATE runs SET ended_seq=10 WHERE run_id=?", b), refuses(/seq of a Run's end is written once/u));
});

test("one native session is held once, wherever; a conversation has one live binding per control; an archived one is frozen; the relay's state only goes forward", t => {
  const db = fresh(t);
  conversation(db, "one"); conversation(db, "two");
  binding(db, "one", 0, { checkpoint: "shared" });
  assert.throws(() => binding(db, "two", 0, { checkpoint: "shared" }), refuses(/UNIQUE/u), "held by two conversations");
  binding(db, "two", 0, { checkpoint: "shared", status: "fork-pending" });
  binding(db, "two", 1, { checkpoint: "shared", control_id: "other", opens_new: 1 });
  assert.throws(() => binding(db, "one", 1, { checkpoint: "second", relay_epoch: 2 }), refuses(/UNIQUE/u), "two live bindings of one control");
  change(db, "UPDATE bindings SET relay_mark=5 WHERE session_id='one' AND ordinal=0");
  assert.throws(() => change(db, "UPDATE bindings SET relay_mark=4 WHERE session_id='one' AND ordinal=0"), refuses(/only goes forward/u));
  assert.throws(() => change(db, "UPDATE bindings SET relay_floor=0, relay_epoch=0 WHERE session_id='one' AND ordinal=0"), refuses(/CHECK|only goes forward/u));
  change(db, "UPDATE bindings SET relay_epoch=2, relay_mark=0 WHERE session_id='one' AND ordinal=0");
  assert.throws(() => change(db, "UPDATE bindings SET relay_epoch=1 WHERE session_id='one' AND ordinal=0"), refuses(/only goes forward/u));
  assert.throws(() => change(db, "UPDATE bindings SET harness_id='other' WHERE session_id='one' AND ordinal=0"), refuses(/never taken over/u));
  change(db, "UPDATE bindings SET status='archived' WHERE session_id='one' AND ordinal=0");
  assert.throws(() => change(db, "UPDATE bindings SET relay_mark=9 WHERE session_id='one' AND ordinal=0"), refuses(/archived native binding is frozen/u));
  assert.throws(() => binding(db, "one", 1, { checkpoint: "second", relay_epoch: 2 }), refuses(/increase along its bindings/u), "epochs of one control increase");
  binding(db, "one", 1, { checkpoint: "second", relay_epoch: 3 });
  assert.throws(() => change(db, "DELETE FROM bindings WHERE session_id='one' AND ordinal=1"), refuses(/binding is kept/u));
});

test("a new binding starts with no mark and no clear floor: -1 (none) is stored as it is, and goes forward from there", t => {
  const db = fresh(t);
  conversation(db, "one");
  binding(db, "one", 0, { relay_mark: -1, relay_floor: -1 });
  assert.deepEqual(rows(db, "SELECT relay_mark AS mark, relay_floor AS floor FROM bindings"), [{ mark: -1, floor: -1 }]);
  change(db, "UPDATE bindings SET relay_mark=3 WHERE session_id='one' AND ordinal=0");
  assert.throws(() => change(db, "UPDATE bindings SET relay_mark=-1 WHERE session_id='one' AND ordinal=0"), refuses(/only goes forward/u));
  assert.throws(() => binding(db, "one", 1, { control_id: "other", checkpoint: "x", relay_mark: -2 }), refuses(/CHECK/u), "nothing is below none");
});

test("a binding's native position is a finished native Run of its own control, settled and closed", t => {
  const db = fresh(t);
  conversation(db, "one");
  const running = run(db, "one", 0, "running");
  assert.throws(() => binding(db, "one", 0, { through_run_id: running }), refuses(/native position is a finished native Run/u));
  change(db, `UPDATE runs SET status='completed', run_json='${COMPLETED_NATIVE}' WHERE run_id=?`, running);
  assert.throws(() => binding(db, "one", 0, { through_run_id: running, control_id: "other" }), refuses(/native position is a finished native Run/u), "another control's Run");
  assert.throws(() => binding(db, "one", 0, { through_run_id: "run-nowhere" }), refuses(/native position is a finished native Run/u));
  binding(db, "one", 0, { through_run_id: running });
  const unsettled = run(db, "one", 1, "running");
  change(db, "UPDATE runs SET status='failed' WHERE run_id=?", unsettled);
  assert.throws(() => change(db, "UPDATE bindings SET through_run_id=? WHERE session_id='one' AND ordinal=0", unsettled), refuses(/native position is a finished native Run/u), "no settlement evidence");
});

test("commands are written once; a conversation has one create command; a switch answers a switch command; one switch is pending; an ended switch is fixed", t => {
  const db = fresh(t);
  conversation(db, "one");
  command(db, "one", "create-1", "create", "one");
  assert.throws(() => command(db, "one", "create-2", "create", "one"), refuses(/UNIQUE/u));
  assert.throws(() => change(db, "UPDATE commands SET result_id='other' WHERE command_id='create-1'"), refuses(/never rewritten/u));
  assert.throws(() => change(db, "DELETE FROM commands WHERE command_id='create-1'"), refuses(/command is kept/u));
  assert.throws(() => insert(db, "switches", { session_id: "one", ordinal: 0, switch_id: "switch-x", command_id: "create-1", status: "requested", requested_seq: 2, through_seq: 0, switch_json: "{}" }), refuses(/answers a switch command/u));
  const first = switchRow(db, "one", 0, "requested");
  assert.throws(() => switchRow(db, "one", 1, "validated"), refuses(/UNIQUE/u), "two switches pending");
  assert.throws(() => change(db, "UPDATE switches SET requested_seq=9 WHERE switch_id=?", first), refuses(/request never changes/u));
  change(db, "UPDATE switches SET status='effective' WHERE switch_id=?", first);
  assert.throws(() => change(db, "UPDATE switches SET status='failed' WHERE switch_id=?", first), refuses(/ended switch is never rewritten/u));
  switchRow(db, "one", 2, "requested");
});

test("the head agrees with the rows: the active Run, the pending switch, closed means idle, open means nothing unknown and unacknowledged, the epoch follows the switches", t => {
  const db = fresh(t);
  conversation(db, "one", { head: '{"configuration":{"workspace":"/a"},"selection":{"harnessId":"h"}}' });
  const a = run(db, "one", 0, "running");
  assert.throws(() => change(db, "UPDATE sessions SET last_seq=2, active_run_id=NULL WHERE id='one'"), refuses(/not the active one/u));
  change(db, "UPDATE sessions SET last_seq=2, active_run_id=? WHERE id='one'", a);
  assert.throws(() => change(db, "UPDATE sessions SET status='closed' WHERE id='one'"), refuses(/still admits work/u));
  const pending = switchRow(db, "one", 0, "requested");
  assert.throws(() => change(db, "UPDATE sessions SET pending_switch_id='switch-wrong' WHERE id='one'"), refuses(/not the pending one/u));
  change(db, "UPDATE sessions SET pending_switch_id=? WHERE id='one'", pending);
  assert.throws(() => change(db, "UPDATE sessions SET epoch=2 WHERE id='one'"), refuses(/effective switches plus one/u));
  assert.throws(() => change(db, "UPDATE sessions SET epoch=3 WHERE id='one'"), refuses(/one effective switch|effective switches plus one/u));
  change(db, "UPDATE switches SET status='effective' WHERE switch_id=?", pending);
  change(db, "UPDATE sessions SET epoch=2, pending_switch_id=NULL WHERE id='one'");
  assert.throws(() => change(db, "UPDATE sessions SET epoch=1 WHERE id='one'"), refuses(/one effective switch|effective switches plus one/u));
  change(db, "UPDATE runs SET status='unknown' WHERE run_id=?", a);
  assert.throws(() => change(db, "UPDATE sessions SET active_run_id=NULL WHERE id='one'"), refuses(/nobody acknowledged/u), "open with a Run nobody acknowledged");
  change(db, "UPDATE sessions SET active_run_id=NULL, status='blocked' WHERE id='one'");
  assert.throws(() => change(db, "UPDATE sessions SET status='open' WHERE id='one'"), refuses(/nobody acknowledged/u));
  change(db, "UPDATE runs SET acknowledged_by=? WHERE run_id=?", pending, a);
  change(db, "UPDATE sessions SET status='open' WHERE id='one'");
  change(db, "UPDATE sessions SET status='closed' WHERE id='one'");
  assert.throws(() => change(db, "UPDATE sessions SET status='open' WHERE id='one'"), refuses(/cannot reopen/u));
  assert.throws(() => change(db, `UPDATE sessions SET head='{"configuration":{"workspace":"/b"},"selection":{"harnessId":"h"}}' WHERE id='one'`), refuses(/configuration never changes/u));
  assert.throws(() => change(db, `UPDATE sessions SET head='{"configuration":{"workspace":"/a"},"selection":{"harnessId":"h"},"origin":{"kind":"import"}}' WHERE id='one'`), refuses(/origin never changes/u));
});

test("a kept native process belongs to the Run that handed it over", t => {
  const db = fresh(t);
  conversation(db, "one", { head: '{"configuration":{"workspace":"/a"}}' });
  const a = run(db, "one", 0, "completed", { run_json: '{"retained":true}', ended_seq: 3 });
  const b = run(db, "one", 1, "completed", { ended_seq: 4 });
  assert.throws(() => change(db, `UPDATE sessions SET kept=1, head='{"configuration":{"workspace":"/a"},"retained":{"runId":"${b}"}}' WHERE id='one'`), refuses(/belongs to the Run that handed it over/u));
  change(db, `UPDATE sessions SET kept=1, head='{"configuration":{"workspace":"/a"},"retained":{"runId":"${a}"}}' WHERE id='one'`);
  assert.deepEqual(rows(db, "SELECT id FROM sessions WHERE kept=1").map(r => r.id), ["one"]);
});

test("deleting a conversation lets go of its native sessions; only a deleted conversation is purged, children first", t => {
  const db = fresh(t);
  conversation(db, "one"); conversation(db, "two");
  const a = run(db, "one", 0, "running");
  item(db, a, 1, "text:1"); chunk(db, a, 1, 0, "text", 0);
  change(db, "UPDATE runs SET status='completed' WHERE run_id=?", a);
  binding(db, "one", 0, { checkpoint: "held" });
  insert(db, "content_refs", { content_id: "content-1", session_id: "one", role: "attachment" });
  insert(db, "origin_history", { session_id: "one", idx: 0, kind: "fork", message_json: "{}" });
  insert(db, "notice_prints", { session_id: "one", print: "p" });
  assert.throws(() => binding(db, "two", 0, { checkpoint: "held" }), refuses(/UNIQUE/u));
  assert.throws(() => change(db, "DELETE FROM sessions WHERE id='one'"), refuses(/deleted before it is purged/u));
  change(db, "UPDATE sessions SET deleted_at=1 WHERE id='one'");
  assert.deepEqual(rows(db, "SELECT status, json_extract(binding_json,'$.status') AS json FROM bindings WHERE session_id='one'"), [{ status: "archived", json: "archived" }], "archived in its column and in its JSON");
  binding(db, "two", 0, { checkpoint: "held" });
  for (const table of ["item_text WHERE run_id", "items WHERE run_id", "runs WHERE run_id"]) change(db, "DELETE FROM " + table + "=?", a);
  for (const table of ["bindings", "commands", "switches", "content_refs", "origin_history", "notice_prints"]) change(db, `DELETE FROM ${table} WHERE session_id='one'`);
  change(db, "DELETE FROM sessions WHERE id='one'");
  assert.deepEqual(rows(db, "SELECT id FROM sessions").map(r => r.id), ["two"]);
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM runs")[0]?.n, 0);
});

test("a reference to content may belong to a conversation alone, and is written once", t => {
  const db = fresh(t);
  conversation(db, "one");
  insert(db, "content_refs", { content_id: "content-1", session_id: "one", role: "origin_attachment" });
  assert.throws(() => insert(db, "content_refs", { content_id: "content-1", session_id: "one", role: "origin_attachment" }), refuses(/UNIQUE/u));
  insert(db, "content_refs", { content_id: "content-1", session_id: "one", role: "tool_detail", run_id: "run-1", item_seq: 3 });
  assert.deepEqual(rows(db, "SELECT DISTINCT content_id FROM content_refs").map(r => r.content_id), ["content-1"]);
});

test("search: the trigram index finds three characters or more and nothing shorter; the per-character index finds one or two Chinese characters; both forget an item", t => {
  const db = fresh(t);
  const text = "迁移保真校验与接力水位 and the relay mark";
  // The per-character index takes the text with its Chinese characters put one to a word, and so does its query.
  const spread = (value: string): string => value.replace(/(\p{Script=Han})/gu, " $1 ").replace(/\s+/gu, " ").trim();
  db.prepare("INSERT INTO search_fts(rowid,text) VALUES(?,?)").run(7, text);
  db.prepare("INSERT INTO search_chars(rowid,text) VALUES(?,?)").run(7, spread(text));
  const trigram = (query: string) => rows(db, "SELECT rowid FROM search_fts WHERE search_fts MATCH ?", '"' + query + '"').map(r => r.rowid);
  const chars = (query: string) => rows(db, "SELECT rowid FROM search_chars WHERE search_chars MATCH ?", '"' + spread(query) + '"').map(r => r.rowid);
  assert.deepEqual(trigram("保真校验"), [7]); assert.deepEqual(trigram("relay"), [7]);
  assert.deepEqual(trigram("接力"), [], "two characters are no trigram");
  assert.deepEqual(chars("接力"), [7]); assert.deepEqual(chars("接"), [7]); assert.deepEqual(chars("力接"), [], "the characters in order");
  assert.deepEqual(chars("relay mark"), [7]);
  db.prepare("DELETE FROM search_fts WHERE rowid=?").run(7); db.prepare("DELETE FROM search_chars WHERE rowid=?").run(7);
  assert.deepEqual(trigram("保真校验"), []); assert.deepEqual(chars("接力"), []);
  insert(db, "derived", { name: "search_fts", state: "building", updated_at: 1 });
  assert.throws(() => insert(db, "derived", { name: "search_chars", state: "half", updated_at: 1 }), refuses(/CHECK/u));
});

test("the questions the store asks most use the indexes that were made for them", t => {
  const db = fresh(t);
  const plan = (sql: string, ...args: Value[]) => rows(db, "EXPLAIN QUERY PLAN " + sql, ...args).map(r => String(r.detail)).join(" | ");
  assert.match(plan("SELECT id FROM sessions WHERE format<14"), /sessions_unconverted/u);
  assert.match(plan("SELECT id FROM sessions WHERE kept=1"), /sessions_kept/u);
  assert.match(plan("SELECT session_id FROM runs WHERE status IN('queued','preparing','running','settling')"), /runs_open/u);
  assert.match(plan("SELECT run_id FROM runs WHERE session_id=? AND status IN('preparing','running','settling')", "one"), /runs_one_active|runs_open/u);
  assert.match(plan("SELECT run_id FROM runs WHERE session_id=? AND status='unknown' AND acknowledged_by IS NULL", "one"), /runs_unclaimed/u);
  assert.match(plan("SELECT ordinal FROM runs WHERE session_id=? ORDER BY ordinal DESC LIMIT 10", "one"), /SEARCH runs USING (?:COVERING )?INDEX sqlite_autoindex_runs/u);
  assert.match(plan("SELECT seq FROM items WHERE run_id=? ORDER BY seq", "run-1"), /SEARCH items USING (?:COVERING )?INDEX sqlite_autoindex_items/u);
  assert.match(plan("SELECT seq FROM items WHERE run_id=? AND status IN('pending','running','waiting')", "run-1"), /items_unfinished|sqlite_autoindex_items/u);
  assert.match(plan("SELECT text FROM item_text WHERE run_id=? AND item_seq=? ORDER BY chunk", "run-1", 1), /SEARCH item_text USING PRIMARY KEY/u);
  assert.match(plan("SELECT 1 FROM bindings WHERE harness_id=? AND control_id=? AND checkpoint=? AND status IN('ready','unconfirmed') AND opens_new=0", "h", "c", "p"), /bindings_held/u);
  assert.match(plan("SELECT DISTINCT content_id FROM content_refs"), /content_refs_content|SCAN content_refs/u);
  assert.match(plan("SELECT id FROM sessions WHERE deleted_at IS NULL AND format=14 ORDER BY updated_at DESC, id LIMIT 100"), /sessions_listing/u);
});

test("the relay tables, rebuilt inside a transaction, keep their rows and their keys, and a packet may lose its body or carry a large manifest", t => {
  const db = open(t);
  db.exec(V13_SESSIONS); db.exec(RELAY_DDL);
  insert(db, "sessions", { id: "one", version: 1, last_seq: 1, snapshot: "{}" });
  const sha = "a".repeat(64), packet = { session_id: "one", packet_id: "relay-aaaaaaaaaaaaaaaaaaaa", kind: "packet", tier: "full", target_harness: "h", target_control: "c", native_epoch: 1, from_seq: 1, through_seq: 2,
    policy_version: "relay/1", language: "en", body_sha256: sha, est_tokens: 10, manifest_json: "{}" };
  insert(db, "relay_bodies", { session_id: "one", sha256: sha, bytes: 4, body: "body" });
  insert(db, "relay_packets", packet);
  insert(db, "relay_deliveries", { session_id: "one", run_id: "run-1", packet_id: packet.packet_id, channel: "text_block", input_hmac: "h", auto_resend: 0, redaction_rules_version: "1", redaction_key_id: "k", redaction_set_hmac: "s", outcome: "in_flight" });
  assert.throws(() => insert(db, "relay_packets", { ...packet, packet_id: "relay-bbbbbbbbbbbbbbbbbbbb", body_sha256: null }), refuses(/NOT NULL/u), "before: a packet has its body");
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
  for (const sql of RELAY_V14_REBUILD) db.exec(sql);
  assert.equal(rows(db, "PRAGMA foreign_key_check").length, 0, "the keys hold again before the commit");
  db.exec("COMMIT"); db.exec("PRAGMA foreign_keys=ON");
  assert.equal(rows(db, "PRAGMA foreign_key_check").length, 0);
  assert.deepEqual(rows(db, "SELECT packet_id, body_sha256 FROM relay_packets"), [{ packet_id: packet.packet_id, body_sha256: sha }]);
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM relay_deliveries")[0]?.n, 1);
  insert(db, "relay_packets", { ...packet, packet_id: "relay-bbbbbbbbbbbbbbbbbbbb", body_sha256: null, manifest_json: JSON.stringify({ runs: "x".repeat(200_000) }) });
  insert(db, "relay_bodies", { session_id: "one", sha256: "b".repeat(64), bytes: 400_000, body: "x".repeat(400_000) });
  assert.throws(() => change(db, "UPDATE relay_packets SET tier='brief'"), refuses(/relay packet is immutable/u));
  assert.throws(() => change(db, "UPDATE relay_bodies SET body='y'"), refuses(/relay body is immutable/u));
  assert.throws(() => insert(db, "relay_deliveries", { session_id: "one", run_id: "run-2", packet_id: "relay-cccccccccccccccccccc", channel: "text_block", input_hmac: "h", auto_resend: 0, redaction_rules_version: "1", redaction_key_id: "k", redaction_set_hmac: "s", outcome: "in_flight" }), refuses(/FOREIGN KEY/u), "a delivery still names a packet");
  assert.throws(() => insert(db, "relay_packets", { ...packet, packet_id: "relay-dddddddddddddddddddd", body_sha256: "c".repeat(64) }), refuses(/FOREIGN KEY/u), "a body that is named is there");
  // The one change a packet row may get: it lets go of its body, and then the body row may go. Nothing else changes with it, and a body does not come back to the row.
  assert.throws(() => change(db, "UPDATE relay_packets SET body_sha256=NULL, tier='brief' WHERE packet_id=?", packet.packet_id), refuses(/relay packet is immutable/u));
  assert.throws(() => change(db, "DELETE FROM relay_bodies WHERE sha256=?", sha), refuses(/FOREIGN KEY/u), "a body a packet names stays");
  change(db, "UPDATE relay_packets SET body_sha256=NULL WHERE packet_id=?", packet.packet_id);
  change(db, "DELETE FROM relay_bodies WHERE sha256=?", sha);
  assert.deepEqual(rows(db, "SELECT packet_id, body_sha256, tier FROM relay_packets WHERE packet_id=?", packet.packet_id), [{ packet_id: packet.packet_id, body_sha256: null, tier: "full" }]);
  assert.throws(() => change(db, "UPDATE relay_packets SET body_sha256=? WHERE packet_id=?", "b".repeat(64), packet.packet_id), refuses(/relay packet is immutable/u));
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM relay_deliveries")[0]?.n, 1, "the evidence of its delivery stays");
});
