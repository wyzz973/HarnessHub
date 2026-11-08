import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SessionError, commandId, messageId, runId, sessionId, type EventDraft, type SessionEvent, type SessionSnapshot } from "../../src/contracts/session.js";
import { parseSession } from "../../src/contexts/session/domain/state.js";
import { SqliteSessionReader, SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const peerPath = join(repository, "tests/fixtures/session-store-peer.mjs");
function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "harness-session-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function draft(type = "session.created"): readonly EventDraft[] { return [{ type, data: {} }]; }
function initial(root: string, suffix = "one", key = "create-one", fingerprint = "a".repeat(64)): SessionSnapshot {
  const id = sessionId("session-" + suffix);
  return { schemaVersion: 12, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
    configuration: { workspace: root, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: false },
    selection: { harnessId: "fixture", controlId: "fixture-acp" }, activeRunId: null, pendingSwitchId: null,
    runs: [], messages: [], switches: [], commands: [{ id: commandId(key), kind: "create", fingerprint, resultId: id }] };
}
function code(expected: string): (error: unknown) => boolean { return error => error instanceof SessionError && error.code === expected; }
function database(root: string): DatabaseSync { return new DatabaseSync(join(root, "gateway.sqlite"), { timeout: 0 }); }
function completedHistory(store: SqliteSessionStore, root: string): SessionSnapshot {
  const created = store.create(initial(root), draft()), run = runId("run-history"), user = messageId("message-history-user"), assistant = messageId("message-history-assistant");
  return store.transact(created.session.id, created.session.version, current => ({ next: { ...current,
    runs: [{ id: run, commandId: commandId("send-history"), input: "recorded input", userMessageId: user, assistantMessageId: assistant,
      selection: current.selection, epoch: 1, status: "completed", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: { status: "completed", reason: "historical fixture" },
      cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null }, error: null, stopRequested: false, awaitingSwitchId: null }],
    messages: [{ id: user, runId: run, role: "user", text: "recorded input", seq: current.lastSeq + 1, status: "completed" },
      { id: assistant, runId: run, role: "assistant", text: "recorded answer", seq: current.lastSeq + 2, status: "completed" }],
    commands: [...current.commands, { id: commandId("send-history"), kind: "send", fingerprint: "b".repeat(64), resultId: run }],
  }, events: [{ type: "message.accepted", data: { runId: run } }, { type: "run.ended", data: { runId: run, status: "completed", fixtureOnly: true } }] })).session;
}
const BACKUP = /^gateway-v\d+-\d{8}T\d{6}Z-[0-9a-f]{8}\.sqlite$/u;
function clock(iso: string): { readonly now: () => Date } { return { now: () => new Date(iso) }; }
/** Puts the business database back at a legacy version, as a build of that version would have left it. */
function downgrade(root: string, state: SessionSnapshot, version: number): void {
  const db = database(root); db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...state, schemaVersion: version }), state.id);
  db.exec("PRAGMA user_version=" + version); db.close();
}
function legacyRoot(t: TestContext, version = 1): { readonly root: string; readonly state: SessionSnapshot } {
  const root = directory(t), original = new SqliteSessionStore(root), state = completedHistory(original, root); original.close();
  downgrade(root, state, version); return { root, state };
}
/** Every row of the four business tables, to compare a backup with the database it copied. */
function rows(db: DatabaseSync): unknown {
  return ["owner_metadata ORDER BY singleton", "sessions ORDER BY id", "create_keys ORDER BY command_id", "events ORDER BY session_id,seq"].map(table => db.prepare("SELECT * FROM " + table).all());
}
function backupFiles(root: string): string[] {
  return readdirSync(join(root, "backups"), { withFileTypes: true }).filter(entry => entry.isFile() && BACKUP.test(entry.name)).map(entry => entry.name);
}
/** Overwrites the header of a table's root page: reading that table fails while the file header and schema stay readable. */
function damage(root: string, table: string): () => void {
  const db = database(root), size = Number(db.prepare("PRAGMA page_size").get()?.page_size), page = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE name=?").get(table)?.rootpage); db.close();
  const path = join(root, "gateway.sqlite"), offset = (page - 1) * size, original = Buffer.alloc(8);
  const write = (bytes: Buffer): void => { const descriptor = openSync(path, "r+"); try { writeSync(descriptor, bytes, 0, bytes.length, offset); } finally { closeSync(descriptor); } };
  assert.ok(page > 1 && size >= 512 && !existsSync(path + "-wal"), "the page is in the database file itself");
  const descriptor = openSync(path, "r"); try { readSync(descriptor, original, 0, original.length, offset); } finally { closeSync(descriptor); }
  write(Buffer.alloc(original.length, 0xff)); return () => write(original);
}

test("numbered v1-to-v2-to-v3 migration preserves public identities, history, commands and event cursors", t => {
  const root = directory(t), original = new SqliteSessionStore(root);
  const state = completedHistory(original, root), events = original.events(state.id, 0); original.close();
  const legacy = { ...state, schemaVersion: 1 };
  const db = database(root); db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(legacy), state.id);
  db.exec("PRAGMA user_version=1"); db.close();
  const reader = new SqliteSessionReader(root); assert.equal(reader.get(state.id).schemaVersion, 1); reader.close();
  const upgraded = new SqliteSessionStore(root);
  try {
    assert.deepEqual(upgraded.get(state.id), { ...state, schemaVersion: 12 });
    assert.deepEqual(upgraded.events(state.id, 0), events);
    assert.equal(upgraded.findByCreateKey(commandId("create-one"))?.id, state.id);
    const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 12); verify.close();
  } finally { upgraded.close(); }
});

test("corruption in a later legacy Session rolls back every migrated row and the format version", t => {
  const root = directory(t), original = new SqliteSessionStore(root);
  const one = original.create(initial(root), draft()).session;
  const two = original.create(initial(root, "two", "create-two"), draft()).session; original.close();
  const db = database(root);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...one, schemaVersion: 1 }), one.id);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...two, schemaVersion: 1, unexpected: true }), two.id);
  db.exec("PRAGMA user_version=1"); db.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const verify = database(root);
  assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 1);
  assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(one.id)?.snapshot)).schemaVersion, 1);
  assert.equal(verify.prepare("SELECT COUNT(*) AS total FROM events").get()?.total, 2); verify.close();
  assert.equal(backupFiles(root).length, 1, "the backup taken before the migration stays after the migration fails");
});

test("G008-NC9 a v1 business database is copied to backups with VACUUM INTO before it is migrated to v12", t => {
  const { root, state } = legacyRoot(t), legacy = database(root), before = rows(legacy); legacy.close();
  const upgraded = new SqliteSessionStore(root, clock("2026-10-22T08:09:10.000Z"));
  let events: readonly SessionEvent[];
  try { assert.deepEqual(upgraded.get(state.id), state); events = upgraded.events(state.id, 0); } finally { upgraded.close(); }
  const folder = join(root, "backups"), [name, ...more] = readdirSync(folder);
  assert.deepEqual(more, []); assert.match(name ?? "", /^gateway-v1-20261022T080910Z-[0-9a-f]{8}\.sqlite$/u);
  const backup = join(folder, name ?? "");
  assert.equal(statSync(folder).mode & 0o777, 0o700); assert.equal(statSync(backup).mode & 0o777, 0o600);
  const copy = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(copy.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 1);
    assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, events.length);
    assert.deepEqual(rows(copy), before);
  } finally { copy.close(); }
  const live = database(root); assert.equal(live.prepare("PRAGMA user_version").get()?.user_version, 12); live.close();
  // The manual restore of the storage contract: with the store stopped, the backup replaces gateway.sqlite and its -wal/-shm go.
  copyFileSync(backup, join(root, "gateway.sqlite"));
  for (const suffix of ["-wal", "-shm"]) rmSync(join(root, "gateway.sqlite" + suffix), { force: true });
  const reader = new SqliteSessionReader(root);
  try { assert.deepEqual(reader.get(state.id), { ...state, schemaVersion: 1 }); assert.deepEqual(reader.events(state.id, 0), events); } finally { reader.close(); }
});

test("G008-NC9 only a migration writes a backup: not a new or current database, an unknown version or the read-only reader", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft()).session; store.close();
  new SqliteSessionStore(root).close();
  assert.equal(existsSync(join(root, "backups")), false, "v0 and v12");
  downgrade(root, created, 1);
  const reader = new SqliteSessionReader(root); assert.equal(reader.get(created.id).schemaVersion, 1); reader.close();
  assert.equal(existsSync(join(root, "backups")), false, "the reader of a v1 database");
  const unknown = database(root); unknown.exec("PRAGMA user_version=99"); unknown.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  assert.equal(existsSync(join(root, "backups")), false, "an unknown version");
});

test("G008-NC10 migration backups keep the newest two by the time in their names and leave every other file alone", t => {
  const { root, state } = legacyRoot(t), folder = join(root, "backups");
  mkdirSync(folder, { mode: 0o700 });
  // By name v9 sorts after v10; by the time in its name it is the oldest backup.
  const oldest = "gateway-v9-20261001T000000Z-0000000a.sqlite", older = "gateway-v10-20261002T000000Z-0000000b.sqlite";
  const others = ["notes.txt", "gateway-v1-latest.sqlite", "gateway-v1-20261003T000000Z-0000000C.sqlite", "gateway-v1-20261003T000000Z-0000000c.sqlite.bak"];
  for (const name of [oldest, older, ...others]) writeFileSync(join(folder, name), name, { mode: 0o600 });
  // Named like the oldest backups but not regular files: a directory and a link are not HarnessHub's to remove.
  const directoryNamed = "gateway-v1-20250101T000000Z-0000000d.sqlite", linkNamed = "gateway-v1-20250102T000000Z-0000000e.sqlite";
  mkdirSync(join(folder, directoryNamed)); symlinkSync(join(folder, "notes.txt"), join(folder, linkNamed));
  writeFileSync(join(folder, "gateway-v1-20261004T000000Z-0000000f.sqlite.partial"), "left by a backup that crashed", { mode: 0o600 });
  new SqliteSessionStore(root, clock("2026-10-22T08:00:00.000Z")).close();
  const first = backupFiles(root), made = first.filter(name => name !== older);
  assert.equal(first.length, 2); assert.ok(first.includes(older)); assert.match(made[0] ?? "", /^gateway-v1-20261022T080000Z-[0-9a-f]{8}\.sqlite$/u);
  assert.equal(readFileSync(join(folder, older), "utf8"), older);
  downgrade(root, state, 1);
  new SqliteSessionStore(root, clock("2026-10-22T09:00:00.000Z")).close();
  const second = backupFiles(root), latest = second.filter(name => name !== made[0]);
  assert.equal(second.length, 2); assert.ok(second.includes(made[0] ?? "")); assert.match(latest[0] ?? "", /^gateway-v1-20261022T090000Z-[0-9a-f]{8}\.sqlite$/u);
  assert.deepEqual(readdirSync(folder).sort(), [...others, directoryNamed, linkNamed, ...second].sort());
  for (const name of others) assert.equal(readFileSync(join(folder, name), "utf8"), name);
  assert.ok(statSync(join(folder, directoryNamed)).isDirectory()); assert.equal(readFileSync(join(folder, linkNamed), "utf8"), "notes.txt");
});

test("G008-NC11 a backup that cannot be made leaves the v1 database unmigrated and unclaimed until the cause is fixed", t => {
  const { root, state } = legacyRoot(t), folder = join(root, "backups"), outside = directory(t);
  // The message names the step and a reason without paths; the original error stays as the cause.
  const refused = (label: string, message: RegExp): void => {
    assert.throws(() => new SqliteSessionStore(root), error => error instanceof SessionError && error.code === "STORAGE_BACKUP_FAILED" && error.cause !== undefined &&
      message.test(error.message) && error.message.endsWith("; nothing was migrated") && !error.message.includes(root), label);
    const db = database(root);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1, label);
      assert.equal(JSON.parse(String(db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id)?.snapshot)).schemaVersion, 1, label);
      const owner = db.prepare("SELECT owner_generation,owner_active FROM owner_metadata").get();
      assert.deepEqual([owner?.owner_generation, owner?.owner_active], [1, 0], label);
    } finally { db.close(); }
  };
  const directoryRefused = /^could not prepare the backups directory before migrating the business database from v1 \(the backups directory must be a private directory owned by this user\)/u;
  writeFileSync(folder, "a file of the user's", { mode: 0o600 });
  refused("backups is a regular file", directoryRefused); assert.equal(readFileSync(folder, "utf8"), "a file of the user's"); rmSync(folder);
  symlinkSync(outside, folder);
  refused("backups is a link", directoryRefused); assert.deepEqual(readdirSync(outside), []); rmSync(folder);
  mkdirSync(folder, { mode: 0o700 }); chmodSync(folder, 0o750);
  refused("backups is open to the group", directoryRefused); assert.deepEqual(readdirSync(folder), []);
  chmodSync(folder, 0o500);
  refused("backups cannot be written", /^could not write the backup .* \(EACCES\)/u); assert.deepEqual(readdirSync(folder), []);
  chmodSync(folder, 0o700);
  // VACUUM INTO meets the damaged page after the partial file exists: that file goes, and the database is left as it was.
  const repair = damage(root, "create_keys");
  refused("the database has a damaged page", /^could not write the backup .* \(database disk image is malformed\)/u); assert.deepEqual(readdirSync(folder), []);
  repair();
  const store = new SqliteSessionStore(root);
  try { assert.deepEqual(store.get(state.id), state); assert.equal(store.ownerGeneration, 2); } finally { store.close(); }
  assert.equal(backupFiles(root).length, 1); assert.equal(readdirSync(folder).length, 1);
});
interface PeerMessage { readonly type: string; readonly code?: string; readonly generation?: number }
async function peer(t: TestContext, root: string, mode = "hold"): Promise<{ readonly child: ChildProcess; readonly message: PeerMessage }> {
  const child = spawn(process.execPath, [peerPath, root, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostics = "";
  child.stderr?.on("data", value => { diagnostics += String(value); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGCONT"); child.kill("SIGKILL"); await once(child, "exit"); }
  });
  const message = await new Promise<PeerMessage>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("peer did not publish readiness: " + diagnostics)); }, 5000);
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

test("Store persists Session and consecutive events atomically with automatic version/cursor", t => {
  const root = directory(t), store = new SqliteSessionStore(root, { now: () => new Date("2026-10-09T00:00:00.000Z") });
  const created = store.create(initial(root), [{ type: "session.created", data: { nested: ["中文", 1, true, null] } }, { type: "selection.selected", data: {} }]);
  assert.equal(created.session.version, 1); assert.equal(created.session.lastSeq, 2);
  assert.deepEqual(created.events.map(event => event.seq), [1, 2]);
  assert.ok(created.events.every(event => event.ownerGeneration === 1 && event.timestamp === "2026-10-09T00:00:00.000Z"));
  const committed = store.transact(created.session.id, 1, current => ({ next: { ...current, status: "blocked" }, events: [{ type: "session.updated", data: {} }] }));
  assert.equal(committed.session.version, 2); assert.equal(committed.session.lastSeq, 3);
  assert.deepEqual(store.events(created.session.id, 1).map(event => event.seq), [2, 3]);
  assert.deepEqual(store.events(created.session.id, 3), []);
  store.close();
  const reopened = new SqliteSessionStore(root);
  assert.equal(reopened.ownerGeneration, 2); assert.deepEqual(reopened.get(created.session.id), committed.session);
  assert.equal(reopened.events(created.session.id, 0)[0]?.ownerGeneration, 1); reopened.close();
});

test("global create key replay returns original identity while conflicting fingerprint is rejected", t => {
  const root = directory(t), store = new SqliteSessionStore(root);
  const created = store.create(initial(root), draft());
  const replayed = store.create(initial(root, "other"), draft());
  assert.equal(replayed.session.id, created.session.id); assert.equal(replayed.events.length, 0);
  assert.equal(store.list().length, 1);
  assert.equal(store.findByCreateKey(commandId("create-one"))?.id, created.session.id);
  assert.equal(store.findByCreateKey(commandId("missing")), null);
  assert.throws(() => store.create(initial(root, "other", "create-one", "b".repeat(64)), draft()), code("IDEMPOTENCY_CONFLICT"));
  assert.equal(store.events(created.session.id, 0).length, 1); store.close();
});

test("create without a durable event cannot commit a Session, create key or hidden initial version", t => {
  const root = directory(t), store = new SqliteSessionStore(root), state = initial(root);
  assert.throws(() => store.create(state, []), code("INVALID_DATA"));
  assert.equal(store.findByCreateKey(commandId("create-one")), null); assert.deepEqual(store.list(), []);
  assert.throws(() => store.get(state.id), code("SESSION_NOT_FOUND"));
  const outsider = database(root);
  assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
  assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM create_keys").get()?.count, 0);
  assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 0); outsider.close();
  const valid = store.create(state, draft()); assert.equal(valid.session.version, 1); assert.equal(valid.session.lastSeq, 1); store.close();
});

test("empty mutation events cannot change public status or silently advance a noop version", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  assert.throws(() => store.transact(created.session.id, created.session.version, current => ({ next: { ...current, status: "blocked" }, events: [] })), code("INVALID_DATA"));
  assert.throws(() => store.transact(created.session.id, created.session.version, current => ({ next: current, events: [] })), code("INVALID_DATA"));
  assert.deepEqual(store.get(created.session.id), created.session); assert.deepEqual(store.events(created.session.id, 0), created.events);
  const outsider = database(root), row = outsider.prepare("SELECT version,last_seq,snapshot FROM sessions WHERE id=?").get(created.session.id);
  assert.equal(row?.version, created.session.version); assert.equal(row?.last_seq, created.session.lastSeq); assert.equal(row?.snapshot, JSON.stringify(created.session));
  assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM create_keys").get()?.count, 1);
  assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1); outsider.close(); store.close();
});

test("CAS conflict and invalid aggregate leave snapshot, sequence and event log unchanged", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  assert.throws(() => store.transact(created.session.id, 2, current => ({ next: current, events: draft("bad.cas") })), code("VERSION_CONFLICT"));
  assert.throws(() => store.transact(created.session.id, 1, current => ({ next: { ...current, epoch: 0 }, events: draft("bad.domain") })), code("INVALID_DATA"));
  assert.deepEqual(store.get(created.session.id), created.session); assert.deepEqual(store.events(created.session.id, 0), created.events); store.close();
});

test("aggregate identity and original create command cannot be replaced", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  assert.throws(() => store.transact(created.session.id, 1, current => ({ next: { ...current, id: sessionId("session-other") }, events: draft("bad.identity") })), code("INVALID_DATA"));
  assert.throws(() => store.transact(created.session.id, 1, current => ({ next: { ...current, commands: [{ ...current.commands[0]!, fingerprint: "b".repeat(64) }] }, events: [] })), code("INVALID_DATA"));
  assert.equal(store.get(created.session.id).version, 1); store.close();
});

test("mutation callbacks cannot mutate the previous snapshot to bypass automatic CAS fields", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  assert.throws(() => store.transact(created.session.id, 1, current => {
    Object.assign(current, { version: 99 }); return { next: current, events: draft("bad.mutable-version") };
  }), TypeError);
  assert.deepEqual(store.get(created.session.id), created.session); store.close();
});

test("shape-valid deletion of all historical Runs, messages and send commands is rejected atomically", t => {
  const root = directory(t), store = new SqliteSessionStore(root), before = completedHistory(store, root), events = store.events(before.id, 0);
  assert.throws(() => store.transact(before.id, before.version, current => ({ next: { ...current, runs: [], messages: [], commands: current.commands.filter(entry => entry.kind === "create") }, events: draft("history.removed") })), code("INVALID_TRANSITION"));
  assert.deepEqual(store.get(before.id), before); assert.deepEqual(store.events(before.id, 0), events);
  const outsider = database(root); assert.equal(outsider.prepare("SELECT version,last_seq FROM sessions WHERE id=?").get(before.id)?.version, before.version);
  assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(before.id)?.count, events.length); outsider.close(); store.close();
});

test("shape-valid terminal assistant append and committed send fingerprint rewrite preserve old SQL facts", t => {
  const root = directory(t), store = new SqliteSessionStore(root), before = completedHistory(store, root), events = store.events(before.id, 0);
  assert.throws(() => store.transact(before.id, before.version, current => ({ next: { ...current,
    messages: current.messages.map(message => message.role === "assistant" ? { ...message, text: message.text + " appended after terminal result" } : message) },
  events: draft("terminal.output-rewritten") })), code("INVALID_TRANSITION"));
  assert.throws(() => store.transact(before.id, before.version, current => ({ next: { ...current,
    commands: current.commands.map(entry => entry.kind === "send" ? { ...entry, fingerprint: "c".repeat(64) } : entry) },
  events: draft("command.fingerprint-rewritten") })), code("INVALID_TRANSITION"));
  assert.deepEqual(store.get(before.id), before); assert.deepEqual(store.events(before.id, 0), events);
  const reader = new SqliteSessionReader(root); assert.deepEqual(reader.get(before.id), before); reader.close(); store.close();
});

test("read snapshots are deeply frozen and event data are independent copies", t => {
  const root = directory(t), store = new SqliteSessionStore(root);
  const originalData = { value: "original" };
  const created = store.create(initial(root), [{ type: "session.created", data: originalData }]);
  originalData.value = "changed";
  // Every reader of a version shares one validated snapshot (ADR-055 §11.2), so none of them can change it in place.
  assert.throws(() => Object.assign(created.session.selection, { harnessId: "modified" }), TypeError);
  const read = store.get(created.session.id);
  assert.throws(() => Object.assign(read.selection, { harnessId: "modified" }), TypeError);
  assert.throws(() => (read.commands as unknown[]).push({}), TypeError);
  Object.assign(created.events[0]?.data ?? {}, { value: "modified" });
  assert.equal(store.get(created.session.id).selection.harnessId, "fixture");
  assert.equal(store.events(created.session.id, 0)[0]?.data.value, "original"); store.close();
});

test("two Store objects in one process are rejected without losing the original OS lock", async t => {
  const root = directory(t), store = new SqliteSessionStore(root);
  assert.throws(() => new SqliteSessionStore(root), code("OWNER_BUSY")); store.assertOwner();
  const contender = await peer(t, root); assert.deepEqual(contender.message, { type: "rejected", code: "OWNER_BUSY" });
  store.create(initial(root), draft()); store.close();
});

test("another live or SIGSTOP-paused process cannot be replaced by a second owner", async t => {
  const root = directory(t), owner = await peer(t, root);
  assert.equal(owner.message.type, "ready");
  assert.throws(() => new SqliteSessionStore(root), code("OWNER_BUSY"));
  owner.child.kill("SIGSTOP");
  assert.throws(() => new SqliteSessionStore(root), code("OWNER_BUSY"));
  owner.child.kill("SIGCONT"); const stopped = once(owner.child, "exit"); owner.child.kill("SIGTERM"); await stopped;
  const acquired = new SqliteSessionStore(root); assert.equal(acquired.ownerGeneration, 2); acquired.close();
});

test("SIGKILL recovery marks active unknown, cancels queued and fails pending switch without replay", async t => {
  const root = directory(t), owner = await peer(t, root, "unfinished"); assert.equal(owner.message.type, "ready");
  const reader = new SqliteSessionReader(root);
  assert.equal(reader.get(sessionId("session-peer")).runs[0]?.status, "running"); reader.close();
  const died = once(owner.child, "exit"); owner.child.kill("SIGKILL"); await died;
  const recovered = new SqliteSessionStore(root), state = recovered.get(sessionId("session-peer"));
  assert.equal(recovered.ownerGeneration, 2); assert.equal(state.status, "blocked");
  assert.equal(state.activeRunId, null); assert.equal(state.pendingSwitchId, null);
  assert.deepEqual(state.runs.map(run => run.status), ["unknown", "cancelled"]);
  assert.deepEqual(state.messages.map(message => message.status), ["unknown", "cancelled"]);
  assert.equal(state.switches[0]?.status, "failed"); assert.equal(state.runs.length, 2);
  const event = recovered.events(state.id, 4)[0]; assert.equal(event?.type, "session.recovered"); assert.equal(event?.data.replayed, false);
  const before = state.lastSeq; recovered.close();
  const again = new SqliteSessionStore(root); assert.equal(again.get(state.id).lastSeq, before); assert.equal(again.get(state.id).runs.length, 2); again.close();
});

test("read-only management reads committed live history without claiming owner or recovering", async t => {
  const root = directory(t), owner = await peer(t, root, "unfinished"); assert.equal(owner.message.type, "ready");
  const reader = new SqliteSessionReader(root), state = reader.get(sessionId("session-peer"));
  assert.equal(state.status, "open"); assert.equal(state.runs[0]?.status, "running");
  assert.equal(reader.list()[0]?.id, state.id); assert.equal(reader.events(state.id, 0).length, 4);
  assert.throws(() => new SqliteSessionStore(root), code("OWNER_BUSY"));
  reader.close(); assert.throws(() => reader.get(state.id), code("STORE_CLOSED"));
});

test("read-only connection observes each new complete aggregate/event commit", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  const reader = new SqliteSessionReader(root); assert.equal(reader.get(created.session.id).version, 1);
  store.transact(created.session.id, 1, current => ({ next: { ...current, status: "blocked" }, events: draft("session.changed") }));
  assert.equal(reader.get(created.session.id).version, 2); assert.equal(reader.events(created.session.id, 1)[0]?.seq, 2);
  assert.equal(store.ownerGeneration, 1); reader.close(); store.close();
});

test("owner file replacement fails old owner closed and alive predecessor prevents takeover", t => {
  const root = directory(t), store = new SqliteSessionStore(root);
  renameSync(join(root, "owner.sqlite"), join(root, "owner.old.sqlite"));
  const replacement = new DatabaseSync(join(root, "owner.sqlite")); replacement.close();
  assert.throws(() => store.assertOwner(), code("OWNER_LOST"));
  assert.throws(() => new SqliteSessionStore(root), code("OWNER_BUSY"));
  assert.throws(() => store.close(), code("OWNER_LOST"));
  assert.throws(() => new SqliteSessionStore(root), code("OWNER_UNCONFIRMED"));
});

test("owner generation tampering blocks all reads and writes", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  const outsider = database(root); outsider.exec("UPDATE owner_metadata SET owner_generation=owner_generation+1"); outsider.close();
  assert.throws(() => store.get(created.session.id), code("OWNER_LOST"));
  assert.throws(() => store.list(), code("OWNER_LOST"));
  assert.throws(() => store.events(created.session.id, 0), code("OWNER_LOST"));
  assert.throws(() => store.close(), code("OWNER_LOST"));
});

test("unknown live schema version loses owner and read-only access", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft()), reader = new SqliteSessionReader(root);
  const outsider = database(root); outsider.exec("PRAGMA user_version=99"); outsider.close();
  assert.throws(() => store.get(created.session.id), code("OWNER_LOST"));
  assert.throws(() => reader.get(created.session.id), code("INVALID_DATA"));
  reader.close(); assert.throws(() => store.close(), code("OWNER_LOST"));
});

test("path replacement during mutation is rejected before commit", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  assert.throws(() => store.transact(created.session.id, 1, current => {
    renameSync(join(root, ".harness-gateway.json"), join(root, "old-marker.json"));
    writeFileSync(join(root, ".harness-gateway.json"), JSON.stringify({ application: "harness-gateway", schemaVersion: 1 }));
    return { next: { ...current, status: "blocked" }, events: draft("not.committed") };
  }), code("OWNER_LOST"));
  assert.throws(() => store.close(), code("OWNER_LOST"));
  const outsider = database(root), row = outsider.prepare("SELECT version,last_seq FROM sessions WHERE id=?").get(created.session.id);
  assert.equal(row?.version, 1); assert.equal(row?.last_seq, 1); assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1); outsider.close();
});

test("SQLite event write failure rolls back snapshot and disables new operations", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  const outsider = database(root); outsider.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected event failure'); END");
  assert.throws(() => store.transact(created.session.id, 1, current => ({ next: { ...current, status: "blocked" }, events: draft("session.failed-write") })), code("STORAGE_UNAVAILABLE"));
  assert.equal(outsider.prepare("SELECT version,last_seq FROM sessions WHERE id=?").get(created.session.id)?.version, 1);
  assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1);
  assert.throws(() => store.get(created.session.id), code("STORAGE_UNAVAILABLE"));
  assert.throws(() => store.close(), code("STORAGE_UNAVAILABLE")); outsider.close();
});

test("corrupt persisted aggregate and unknown migration version never become empty Sessions", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft()); store.close();
  const outsider = database(root);
  outsider.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...created.session, schemaVersion: 13 }), created.session.id); outsider.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const badVersion = database(root); badVersion.exec("PRAGMA user_version=99"); badVersion.close();
  assert.throws(() => new SqliteSessionReader(root), code("INVALID_DATA"));
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
});

test("Reader rejects missing root and storage identity changes without creating files", t => {
  const parent = directory(t), missing = join(parent, "missing");
  assert.throws(() => new SqliteSessionReader(missing)); assert.deepEqual(readdirSync(parent), []);
  const store = new SqliteSessionStore(parent), created = store.create(initial(parent), draft()), reader = new SqliteSessionReader(parent);
  renameSync(join(parent, "gateway.sqlite"), join(parent, "gateway.old.sqlite"));
  const replacement = new DatabaseSync(join(parent, "gateway.sqlite")); replacement.close();
  assert.throws(() => reader.get(created.session.id), code("STORAGE_CHANGED")); reader.close();
  assert.throws(() => store.close(), code("OWNER_LOST"));
});

test("new root and DB modes are private; nonempty unmarked user directory is preserved", t => {
  const parent = directory(t), root = join(parent, "new"), store = new SqliteSessionStore(root);
  assert.equal(statSync(root).mode & 0o777, 0o700); assert.equal(statSync(join(root, "gateway.sqlite")).mode & 0o777, 0o600); store.close();
  const file = join(parent, "user-data.txt"); writeFileSync(file, "preserve me", { mode: 0o640 });
  const before = statSync(parent).mode;
  assert.throws(() => new SqliteSessionStore(parent), code("INVALID_STORAGE"));
  assert.equal(readFileSync(file, "utf8"), "preserve me"); assert.equal(statSync(parent).mode, before);
  assert.equal(readdirSync(parent).includes(".harness-gateway.json"), false);
});

test("symlink databases and root aliases are explicitly rejected", t => {
  const root = directory(t), store = new SqliteSessionStore(root); store.close();
  renameSync(join(root, "owner.sqlite"), join(root, "owner.original.sqlite")); symlinkSync(join(root, "owner.original.sqlite"), join(root, "owner.sqlite"));
  assert.throws(() => new SqliteSessionStore(root), error => error instanceof SessionError);
  const alias = join(root, "alias"); symlinkSync(root, alias); assert.throws(() => new SqliteSessionStore(alias), code("INVALID_STORAGE"));
});

test("limits, unknown identities, nonzero initial cursor and unsafe event values reject without mutation", t => {
  const root = directory(t), store = new SqliteSessionStore(root), state = initial(root), created = store.create(state, draft());
  for (const limit of [0, -1, 101, 1.5, Number.POSITIVE_INFINITY]) assert.throws(() => store.list(limit), code("INVALID_INPUT"));
  assert.throws(() => store.events(state.id, -1), code("INVALID_INPUT"));
  assert.throws(() => store.events(state.id, 2), code("INVALID_CURSOR"));
  assert.throws(() => store.get(sessionId("session-missing")), code("SESSION_NOT_FOUND"));
  assert.throws(() => store.create({ ...initial(root, "two", "create-two"), version: 1 }, draft()), code("INVALID_INPUT"));
  assert.throws(() => store.transact(state.id, 1, current => ({ next: current, events: [{ type: "bad.event", data: { fn: () => 0 } }] })), code("INVALID_DATA"));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.throws(() => store.transact(state.id, 1, current => ({ next: current, events: [{ type: "bad.event", data: circular }] })), code("INVALID_DATA"));
  assert.deepEqual(store.get(state.id), created.session); store.close(); store.close();
  assert.throws(() => store.get(state.id), code("STORE_CLOSED"));
});

test("per-event and total Session log byte budgets reject and roll back real SQL writes", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft());
  assert.throws(() => store.transact(created.session.id, 1, current => ({ next: current, events: [{ type: "too.large", data: { text: "x".repeat(2 * 1024 * 1024 + 4096) } }] })), code("EVENT_LIMIT"));
  const event = { type: "large.valid-event", data: { text: "x".repeat(2_000_000) } };
  store.transact(created.session.id, 1, current => ({ next: current, events: Array.from({ length: 16 }, () => event) }));
  const before = store.get(created.session.id);
  assert.throws(() => store.transact(created.session.id, before.version, current => ({ next: { ...current, status: "blocked" }, events: [event] })), code("EVENT_LIMIT"));
  assert.deepEqual(store.get(created.session.id), before);
  assert.throws(() => store.events(created.session.id, 1, 10), code("READ_LIMIT"));
  assert.equal(store.events(created.session.id, 1, 1)[0]?.seq, 2);
  const outsider = database(root); assert.equal(outsider.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 17); outsider.close(); store.close();
});

test("lost owner SQLite transaction invalidates ownership and never marks a normal release", t => {
  const root = directory(t), store = new SqliteSessionStore(root);
  const owner: unknown = Reflect.get(store, "owner"); assert.ok(owner instanceof DatabaseSync); owner.exec("ROLLBACK");
  assert.throws(() => store.assertOwner(), code("OWNER_LOST")); assert.throws(() => store.close(), code("OWNER_LOST"));
  assert.throws(() => new SqliteSessionStore(root), code("OWNER_UNCONFIRMED"));
});

test("missing persisted event cannot be accepted as valid history or recovered", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft()), outsider = database(root);
  outsider.exec("DELETE FROM events");
  assert.throws(() => store.get(created.session.id), code("INVALID_DATA"));
  const reader = new SqliteSessionReader(root); assert.throws(() => reader.get(created.session.id), code("INVALID_DATA")); reader.close();
  outsider.close(); store.close(); assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
});

test("SQL byte preflight rejects oversized persisted snapshot before decoding it", t => {
  const root = directory(t), store = new SqliteSessionStore(root), created = store.create(initial(root), draft()), outsider = database(root);
  outsider.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ text: "x".repeat(8 * 1024 * 1024 + 1) }), created.session.id);
  assert.throws(() => store.get(created.session.id), code("INVALID_DATA"));
  const reader = new SqliteSessionReader(root); assert.throws(() => reader.get(created.session.id), code("INVALID_DATA")); reader.close(); outsider.close(); store.close();
});

test("v2-to-v3 migration preserves blocked history and does not implicitly reopen a falsely blocked conversation", t => {
  const root = directory(t), original = new SqliteSessionStore(root), prior = completedHistory(original, root);
  const blocked = original.transact(prior.id, prior.version, current => ({ next: { ...current, status: "blocked" }, events: [{ type: "session.blocked", data: { reason: "legacy state remains explicit" } }] })).session;
  const events = original.events(prior.id, 0); original.close();
  const db = database(root); db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...blocked, schemaVersion: 2 }), blocked.id); db.exec("PRAGMA user_version=2"); db.close();
  const read = new SqliteSessionReader(root); assert.equal(read.get(blocked.id).schemaVersion, 2); read.close();
  const upgraded = new SqliteSessionStore(root);
  try { assert.deepEqual(upgraded.get(blocked.id), blocked); assert.deepEqual(upgraded.events(blocked.id, 0), events); assert.equal(upgraded.get(blocked.id).status, "blocked"); }
  finally { upgraded.close(); }
});

test("invalid v2 history rolls back the entire v3 migration rather than repairing or dropping it", t => {
  const root = directory(t), original = new SqliteSessionStore(root);
  const one = original.create(initial(root), draft()).session, two = original.create(initial(root, "two", "create-two"), draft()).session; original.close();
  const db = database(root);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...one, schemaVersion: 2 }), one.id);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...two, schemaVersion: 2, unexpected: true }), two.id); db.exec("PRAGMA user_version=2"); db.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(one.id)?.snapshot)).schemaVersion, 2);
  assert.equal(verify.prepare("SELECT COUNT(*) AS total FROM events").get()?.total, 2); verify.close();
});

test("v3-to-v5 upgrade preserves existing messages, commands, selection and events without choosing a model", t => {
  const root = directory(t), original = new SqliteSessionStore(root), current = completedHistory(original, root), events = original.events(current.id, 0); original.close();
  const legacy = database(root); legacy.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...current, schemaVersion: 3 }), current.id); legacy.exec("PRAGMA user_version=3"); legacy.close();
  const upgraded = new SqliteSessionStore(root);
  try { assert.deepEqual(upgraded.get(current.id), current); assert.deepEqual(upgraded.events(current.id, 0), events); assert.equal(upgraded.get(current.id).selection.nativeModel, undefined); }
  finally { upgraded.close(); }
});

test("v4-to-v5 preserves history and events, while malformed native options roll back every row",t=>{
  const root=directory(t), original=new SqliteSessionStore(root), current=completedHistory(original,root), events=original.events(current.id,0);original.close();
  const legacy=database(root);legacy.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({...current,schemaVersion:4}),current.id);legacy.exec("PRAGMA user_version=4");legacy.close();
  const upgraded=new SqliteSessionStore(root);assert.deepEqual(upgraded.get(current.id),current);assert.deepEqual(upgraded.events(current.id,0),events);upgraded.close();
  const broken=database(root);broken.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({...current,schemaVersion:4,selection:{...current.selection,nativeOptions:{effort:"high"}}}),current.id);broken.exec("PRAGMA user_version=4");broken.close();
  assert.throws(()=>new SqliteSessionStore(root),code("INVALID_DATA"));const verify=database(root);assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version,4);assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(current.id)?.snapshot)).schemaVersion,4);verify.close();
});

test("v5 to v6 migrates every old fact and rejects illegal recovery fields atomically", t => {
  const root = directory(t), original = new SqliteSessionStore(root), state = completedHistory(original, root), oldEvents = original.events(state.id, 0); original.close();
  const legacy = { ...state, schemaVersion: 5 }, db = database(root);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(legacy), state.id); db.exec("PRAGMA user_version=5"); db.close();
  const reader = new SqliteSessionReader(root); assert.equal(reader.get(state.id).schemaVersion, 5); reader.close();
  const upgraded = new SqliteSessionStore(root);
  assert.deepEqual(upgraded.get(state.id), state); assert.deepEqual(upgraded.events(state.id, 0), oldEvents); upgraded.close();
  const invalid = database(root); invalid.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...legacy, nativeBindings: [] }), state.id); invalid.exec("PRAGMA user_version=5"); invalid.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 5); assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id)?.snapshot)).schemaVersion, 5); verify.close();
});

test("v6 to v9 keeps every fact and rejects v7-only native activity in v6 data atomically", t => {
  const root = directory(t), original = new SqliteSessionStore(root), state = completedHistory(original, root), oldEvents = original.events(state.id, 0); original.close();
  const legacy = { ...state, schemaVersion: 6 }, db = database(root);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(legacy), state.id); db.exec("PRAGMA user_version=6"); db.close();
  const reader = new SqliteSessionReader(root); assert.equal(reader.get(state.id).schemaVersion, 6); reader.close();
  const upgraded = new SqliteSessionStore(root);
  assert.deepEqual(upgraded.get(state.id), state); assert.deepEqual(upgraded.events(state.id, 0), oldEvents); upgraded.close();
  const withPlan = { ...legacy, runs: legacy.runs.map((run, index) => index === 0 ? { ...run, plan: { entries: [{ content: "v7 only", status: "pending" }] } } : run) };
  const invalid = database(root); invalid.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(withPlan), state.id); invalid.exec("PRAGMA user_version=6"); invalid.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 6); assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id)?.snapshot)).schemaVersion, 6); verify.close();
});

test("v7 to v9 keeps every fact and rejects a branch origin in v7 data atomically", t => {
  const root = directory(t), original = new SqliteSessionStore(root), state = completedHistory(original, root), oldEvents = original.events(state.id, 0); original.close();
  const legacy = { ...state, schemaVersion: 7 }, db = database(root);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(legacy), state.id); db.exec("PRAGMA user_version=7"); db.close();
  const upgraded = new SqliteSessionStore(root);
  assert.deepEqual(upgraded.get(state.id), state); assert.deepEqual(upgraded.events(state.id, 0), oldEvents); upgraded.close();
  const branched = { ...legacy, origin: { kind: "fork", sessionId: "session-elsewhere", throughRunId: "run-elsewhere", history: [] } };
  const invalid = database(root); invalid.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(branched), state.id); invalid.exec("PRAGMA user_version=7"); invalid.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 7); assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id)?.snapshot)).schemaVersion, 7); verify.close();
});

test("v8 to v9 keeps every fact and rejects an observed native configuration in v8 data atomically", t => {
  const root = directory(t), original = new SqliteSessionStore(root), state = completedHistory(original, root), oldEvents = original.events(state.id, 0); original.close();
  const legacy = { ...state, schemaVersion: 8 }, db = database(root);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(legacy), state.id); db.exec("PRAGMA user_version=8"); db.close();
  const reader = new SqliteSessionReader(root); assert.equal(reader.get(state.id).schemaVersion, 8); reader.close();
  const upgraded = new SqliteSessionStore(root);
  assert.deepEqual(upgraded.get(state.id), state); assert.deepEqual(upgraded.events(state.id, 0), oldEvents); upgraded.close();
  const observed = { ...legacy, nativeBindings: [{ harnessId: state.selection.harnessId, controlId: state.selection.controlId, checkpoint: "native-old", throughRunId: null, status: "archived", observed: { model: null, options: {} } }] };
  const invalid = database(root); invalid.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(observed), state.id); invalid.exec("PRAGMA user_version=8"); invalid.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 8); assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id)?.snapshot)).schemaVersion, 8); verify.close();
});

test("v9 to v10 keeps every fact and rejects Run timing in v9 data atomically", t => {
  const root = directory(t), original = new SqliteSessionStore(root), state = completedHistory(original, root), oldEvents = original.events(state.id, 0); original.close();
  const legacy = { ...state, schemaVersion: 9 }, db = database(root);
  db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(legacy), state.id); db.exec("PRAGMA user_version=9"); db.close();
  const reader = new SqliteSessionReader(root); assert.equal(reader.get(state.id).schemaVersion, 9); reader.close();
  const upgraded = new SqliteSessionStore(root);
  assert.deepEqual(upgraded.get(state.id), state); assert.deepEqual(upgraded.events(state.id, 0), oldEvents); upgraded.close();
  // A v9 Session never carries Run timing; finding it means corrupted data, and nothing is migrated.
  const timed = { ...legacy, runs: legacy.runs.map(run => ({ ...run, timing: { acceptedAt: 1 } })) };
  const invalid = database(root); invalid.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(timed), state.id); invalid.exec("PRAGMA user_version=9"); invalid.close();
  assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"));
  const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, 9); assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id)?.snapshot)).schemaVersion, 9); verify.close();
});

test("v10 and v11 to v12 keep every fact and reject fields of a later version atomically", t => {
  const root = directory(t), original = new SqliteSessionStore(root), state = completedHistory(original, root), oldEvents = original.events(state.id, 0); original.close();
  // A v11 conversation that keeps its process is valid as it is; only the v12 group identity is out of place in it.
  const kept = { harnessId: state.selection.harnessId, controlId: state.selection.controlId, runId: state.runs.at(-1)!.id, since: 5 };
  const holding = { retainNative: true, runs: state.runs.map(run => ({ ...run, cleanup: null, retained: true })), retained: kept };
  assert.equal(parseSession({ ...state, ...holding, schemaVersion: 11 }).retained?.runId, kept.runId);
  for (const [version, later] of [[10, { retainNative: true }], [11, { ...holding, retained: { ...kept, process: { group: 4242, startedAt: "1791741701" } } }]] as const) {
    const legacy = { ...state, schemaVersion: version }, db = database(root);
    db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(legacy), state.id); db.exec("PRAGMA user_version=" + version); db.close();
    const reader = new SqliteSessionReader(root); assert.equal(reader.get(state.id).schemaVersion, version); reader.close();
    const upgraded = new SqliteSessionStore(root);
    assert.deepEqual(upgraded.get(state.id), state, "v" + version); assert.deepEqual(upgraded.events(state.id, 0), oldEvents); upgraded.close();
    // A field of a later version in older data means corrupted data, and nothing is migrated.
    const invalid = database(root); invalid.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...legacy, ...later }), state.id); invalid.exec("PRAGMA user_version=" + version); invalid.close();
    assert.throws(() => new SqliteSessionStore(root), code("INVALID_DATA"), "v" + version);
    const verify = database(root); assert.equal(verify.prepare("PRAGMA user_version").get()?.user_version, version);
    assert.equal(JSON.parse(String(verify.prepare("SELECT snapshot FROM sessions WHERE id=?").get(state.id)?.snapshot)).schemaVersion, version);
    verify.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(state), state.id); verify.exec("PRAGMA user_version=12"); verify.close();
  }
});

test("native owners name the Session holding each ready or unconfirmed native reference, never a pending branch or an archived one", t => {
  const root = directory(t), store = new SqliteSessionStore(root);
  try {
    const binding = (checkpoint: string, status: "ready" | "unconfirmed" | "archived" | "fork-pending", harnessId = "fixture", controlId = "fixture-acp") => ({ harnessId, controlId, checkpoint, throughRunId: null, status });
    const imported = { ...initial(root, "imported", "create-imported"), origin: { kind: "import" as const, harnessId: "fixture", title: "Earlier", omitted: 0, complete: true, historyRead: true,
      history: [{ role: "user" as const, text: "q", status: "completed" as const }] }, nativeBindings: [binding("native-1", "ready")] };
    const second = { ...initial(root, "second", "create-second"), nativeBindings: [binding("native-2", "archived"), binding("native-3", "unconfirmed"), binding("native-9", "ready", "other", "other-acp")] };
    const branch = { ...initial(root, "branch", "create-branch"), origin: { kind: "fork" as const, sessionId: sessionId("session-imported"), throughRunId: runId("run-elsewhere"), history: [] }, nativeBindings: [binding("native-1", "fork-pending")] };
    for (const state of [imported, second, branch]) store.create(state, draft());
    assert.deepEqual([...store.nativeOwners("fixture", "fixture-acp")], [["native-1", sessionId("session-imported")], ["native-3", sessionId("session-second")]]);
    assert.deepEqual([...store.nativeOwners("other", "other-acp")], [["native-9", sessionId("session-second")]]);
    assert.equal(store.get(sessionId("session-imported")).origin?.kind, "import");
  } finally { store.close(); }
});
