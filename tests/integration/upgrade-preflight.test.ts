import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SessionError } from "../../src/contracts/session.js";
import { application } from "../../src/cli/session-application.js";
import { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { checkUpgrade, describeCheck, type UpgradeCheck } from "../../src/infrastructure/session/upgrade-preflight.js";
import { V12_FIXTURES, loadV12Fixture, separate, writeV12Root } from "../fixtures/relay/v12/database.js";
import { GENERATIONS, loadGeneration, writeGenerationRoot } from "../fixtures/storage/generations/database.js";
import { V13_FIXTURES, later, loadV13Fixture, renamed as renamedV13, writeV13Root } from "../fixtures/storage/v13/database.js";
import { rawDatabase, temporary, treeDigest } from "../fixtures/store-helpers.js";

// `sessions check-upgrade` (src/infrastructure/session/upgrade-preflight.ts): the upgrade of a data directory found out without doing it. What it says must be what the upgrade does —
// a root it passes is a root the store upgrades, a root it does not pass is stopped at the conversations it names — and it must leave the data directory exactly as it was, whether
// or not a service holds it. All on data roots in temporary directories; nothing here opens a real one.

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const sessionsCli = join(repository, "dist/src/cli/sessions.js");
const servicePeer = join(repository, "tests/fixtures/service-peer.mjs");
const userVersion = (db: DatabaseSync): number => Number(db.prepare("PRAGMA user_version").get()?.user_version);

/** The conversations of the root, in the order of the rows. */
function idsOf(data: string): string[] {
  const db = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT id FROM sessions ORDER BY rowid").all().map(row => String(row.id)); } finally { db.close(); }
}
/** The real upgrade of a copy of the root, by the store: it stays open until the test ends. */
function upgraded(t: TestContext, data: string): { readonly store: SqliteConversationStore; readonly root: string } {
  const root = join(temporary(t), "data");
  cpSync(data, root, { recursive: true });
  const store = new SqliteConversationStore(root);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  return { store, root };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What it says is what the upgrade does
// ---------------------------------------------------------------------------------------------------------------------------------
/** The schema version a SQLite file says in its header (bytes 60 to 63), read without opening it as a database. */
function headerVersion(data: string): number { return readFileSync(join(data, "gateway.sqlite")).readUInt32BE(60); }
function agrees(t: TestContext, data: string, where: string): UpgradeCheck {
  const before = treeDigest(data), version = headerVersion(data);
  const check = checkUpgrade(data);
  assert.deepEqual(treeDigest(data), before, where + ": the data directory is the very bytes it was (files, sizes, times, contents)");
  assert.equal(headerVersion(data), version, where + ": and the library is the version it was");
  assert.equal(check.mode, "immutable", where + ": a library nobody holds is read as it is, which makes no file");
  assert.equal(check.ok, true, where + ": " + describeCheck(check).join(" | "));
  const { store } = upgraded(t, data);
  const report = store.migration!;
  assert.equal(report.stopped, null, where);
  assert.equal(check.counts.conversations, report.converted, where + ": as many conversations as the upgrade converted");
  assert.deepEqual(check.sharedSessions.moves.map(move => ({ ...move })), report.moved.map(move => ({ ...move })), where + ": the same native sessions given up, to the same conversations");
  assert.equal(check.sharedSessions.archived, report.moved.length);
  assert.equal(check.secondStage.checked, report.converted); assert.deepEqual(check.secondStage.failing, []); assert.deepEqual(check.firstStage.failing, []);
  return check;
}
for (const name of V12_FIXTURES) {
  test(`v12 ${name}: the check passes it, changes nothing, and the store upgrades it the way the check said`, t => {
    const data = join(temporary(t), "data");
    writeV12Root(data, [loadV12Fixture(name)]);
    const check = agrees(t, data, name);
    assert.equal(check.version, 12); assert.equal(check.firstStage.applies, true);
    assert.equal(check.firstStage.checked, check.counts.conversations);
  });
}
for (const name of V13_FIXTURES) {
  test(`v13 ${name}: the check passes it, changes nothing, and the store upgrades it the way the check said`, t => {
    const data = join(temporary(t), "data");
    writeV13Root(data, [loadV13Fixture(name)]);
    const check = agrees(t, data, name);
    assert.equal(check.version, 13); assert.equal(check.firstStage.applies, false);
  });
}
for (const version of GENERATIONS) {
  test(`v${version} (an older generation): the check passes it, changes nothing, and the store upgrades it the way the check said`, t => {
    const data = join(temporary(t), "data");
    writeGenerationRoot(data, loadGeneration(version));
    const check = agrees(t, data, "v" + version);
    assert.equal(check.version, version); assert.equal(check.firstStage.applies, true);
  });
}

test("two conversations that hold one native session: the check tells which gives it up, to whom, and how many, as the upgrade does", t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("switches"), later(loadV13Fixture("tools"), 1)]);
  const check = agrees(t, data, "shared");
  assert.deepEqual([check.sharedSessions.groups, check.sharedSessions.archived, check.sharedSessions.conversations], [2, 2, 1]);
  assert.deepEqual(check.sharedSessions.moves.map(move => [move.sessionId, move.harnessId, move.keptBy]), [["session-sw-1", "alpha", "session-tl-1"], ["session-sw-1", "bravo", "session-tl-1"]]);
  assert.equal(check.counts.taskListCalls, 3, "the task-list calls of the tools fixture");
  const lines = describeCheck(check).join("\n");
  assert.match(lines, /session-sw-1 gives up its alpha\/alpha-acp binding 0 to session-tl-1/u);
});

test("the counts the check gives are the library's: conversations, Turns, events, the longest conversation, branches and continued native sessions", t => {
  const data = join(temporary(t), "data");
  writeV12Root(data, [separate(loadV12Fixture("d1"), "one"), separate(loadV12Fixture("branch"), "two"), separate(loadV12Fixture("import"), "three")]);
  const check = checkUpgrade(data), db = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true });
  try {
    const turns = db.prepare("SELECT SUM(json_array_length(snapshot,'$.runs')) AS n, MAX(json_array_length(snapshot,'$.runs')) AS longest, COUNT(*) AS sessions FROM sessions").get()!;
    assert.deepEqual([check.counts.conversations, check.counts.turns, check.counts.longestConversationTurns], [Number(turns.sessions), Number(turns.n), Number(turns.longest)]);
    assert.equal(check.counts.events, Number(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n));
    assert.equal(check.counts.branches, 1); assert.equal(check.counts.imports, 1);
    assert.ok(check.database!.bytes > 0 && check.database!.needBytes === 2 * check.database!.bytes && check.database!.roomForBackup === true);
    assert.ok(check.estimate.seconds > 0 && check.estimate.peakMemoryBytes > 0);
  } finally { db.close(); }
});

test("a Run that nothing placed is counted as one the upgrade places at the conversation's last event, and the count is the upgrade's", t => {
  const data = join(temporary(t), "data");
  writeV12Root(data, [loadV12Fixture("d1")]);
  const db = rawDatabase(data);
  db.exec("UPDATE events SET event_json = replace(event_json, '\"type\":\"run.ended\"', '\"type\":\"run.over\"')"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const check = checkUpgrade(data);
  assert.equal(check.ok, true, describeCheck(check).join(" | "));
  assert.ok(check.endedSeqPlaced.runs > 0 && check.endedSeqPlaced.conversations === 1);
  const { root } = upgraded(t, data), placed = new DatabaseSync(join(root, "gateway.sqlite"), { readOnly: true });
  try {
    const rows = Number(placed.prepare("SELECT COUNT(*) AS n FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.ended_seq=s.last_seq AND r.dispatched=1").get()?.n);
    assert.ok(rows >= check.endedSeqPlaced.runs, "the rows hold at least the Runs the check counted (a Run that really ended at the last event is one too)");
  } finally { placed.close(); }
});

test("conversations with an id that holds half of a surrogate pair are told, and convert", t => {
  const fixture = structuredClone(loadV13Fixture("tools")) as unknown as { sessions: { id: string; snapshot: { runs: { tools?: { id: string }[] }[] } }[] };
  fixture.sessions[0]!.snapshot.runs.find(run => (run.tools?.length ?? 0) > 0)!.tools![0]!.id = "call-\ud83d";
  const data = join(temporary(t), "data");
  writeV13Root(data, [fixture as never]);
  const check = agrees(t, data, "half pair");
  assert.deepEqual(check.halfPairIds, ["session-tl-1"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A root that would not upgrade: the same conversations the upgrade stops at, and the same rules
// ---------------------------------------------------------------------------------------------------------------------------------
test("a v12 root the old ladder cannot take: the check names the conversations and the rules the upgrade names, and nothing is changed", t => {
  const data = join(temporary(t), "data"), secret = "the words of a private conversation";
  writeV12Root(data, [separate(loadV12Fixture("d1"), "one"), separate(loadV12Fixture("clear"), "two"), separate(loadV12Fixture("import"), "three")]);
  const probe = rawDatabase(data), ids = probe.prepare("SELECT id FROM sessions ORDER BY rowid").all().map(row => String(row.id));
  const seq = Number(probe.prepare("SELECT seq FROM events WHERE session_id=? AND json_extract(event_json,'$.type')='run.ended' ORDER BY seq LIMIT 1").get(ids[1]!)!.seq);
  probe.prepare("UPDATE events SET event_json=json_set(event_json,'$.seq',?) WHERE session_id=? AND seq=?").run(seq + 1000, ids[1]!, seq);
  probe.prepare("UPDATE sessions SET snapshot=json_set(json_set(json_set(snapshot,'$.runs[0].status','exploding'),'$.messages[0].text',?),'$.runs[0].input',?) WHERE id=?").run(secret, secret, ids[2]!);
  probe.exec("PRAGMA wal_checkpoint(TRUNCATE)"); probe.close();
  const before = treeDigest(data);
  const check = checkUpgrade(data);
  assert.deepEqual(treeDigest(data), before);
  assert.equal(check.ok, false);
  assert.deepEqual(check.firstStage.failing.map(fault => fault.sessionId), [ids[1], ids[2]]);
  assert.match(check.firstStage.failing[0]!.reason, /persistent event sequence is inconsistent/u); assert.match(check.firstStage.failing[1]!.reason, /unknown Run status/u);
  assert.equal(check.secondStage.skipped, 2); assert.equal(check.secondStage.checked, 1, "the one the first stage passes is tried in the second");
  // The upgrade is stopped at the same conversations by the same rules.
  const copy = join(temporary(t), "data"); cpSync(data, copy, { recursive: true });
  let failure: unknown;
  try { new SqliteConversationStore(copy); } catch (error) { failure = error; }
  assert.ok(failure instanceof SessionError && failure.code === "MIGRATION_REFUSED");
  for (const fault of check.firstStage.failing) assert.ok(failure.message.includes(fault.sessionId + " (" + fault.reason + ")"), fault.sessionId);
  // And the check never says what a conversation says.
  const text = describeCheck(check).join("\n") + JSON.stringify(check);
  assert.ok(!text.includes(secret) && !text.includes("exploding"), "no word of a conversation");
});

test("a v13 root with a conversation that does not convert: the check names it and the rule, the others pass, and the upgrade stops at the first of them", t => {
  const data = join(temporary(t), "data"), secret = "the words of a private conversation";
  writeV13Root(data, [loadV13Fixture("switches"), later(loadV13Fixture("tools"), 1), loadV13Fixture("commands")]);
  const probe = rawDatabase(data), ids = probe.prepare("SELECT id FROM sessions ORDER BY rowid").all().map(row => String(row.id));
  // Two conversations that hold no native session another holds (one that did could not be asked who used it last, which is a refusal of the first stage, below).
  const broken = ["session-sw-31", "session-cm-1"];
  assert.ok(broken.every(id => ids.includes(id)) && ids.indexOf(broken[0]!) < ids.indexOf(broken[1]!));
  for (const id of broken) {
    const snapshot = JSON.parse(String(probe.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id)!.snapshot)) as { runs: { userMessageId: string }[]; messages: { text: string }[] };
    snapshot.messages[0]!.text = secret; snapshot.runs[0]!.userMessageId = "message-nowhere";
    probe.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), id);
  }
  probe.exec("PRAGMA wal_checkpoint(TRUNCATE)"); probe.close();
  const before = treeDigest(data);
  const check = checkUpgrade(data);
  assert.deepEqual(treeDigest(data), before);
  assert.equal(check.ok, false);
  assert.deepEqual(check.secondStage.failing.map(fault => fault.sessionId), broken, "every conversation that would not convert, in the order of the rows");
  assert.equal(check.secondStage.checked - check.secondStage.failing.length, ids.length - 2);
  for (const fault of check.secondStage.failing) assert.ok(!fault.reason.includes(secret) && !fault.reason.includes("message-nowhere"), "a rule and a place, not a word");
  // The upgrade stops at the first of them, with the reason the check gave.
  const copy = join(temporary(t), "data"); cpSync(data, copy, { recursive: true });
  let failure: unknown;
  try { new SqliteConversationStore(copy); } catch (error) { failure = error; }
  assert.ok(failure instanceof SessionError && failure.code === "MIGRATION_STOPPED");
  assert.ok(failure.message.includes(broken[0]!) && failure.message.includes(check.secondStage.failing[0]!.reason), failure.message);
  const text = describeCheck(check).join("\n") + JSON.stringify(check);
  assert.ok(!text.includes(secret) && !text.includes("message-nowhere"));
});

test("a conversation that cannot be read and holds a native session another holds: the check names it in the first stage, as the upgrade refuses it before it changes anything", t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("switches"), later(loadV13Fixture("tools"), 1)]);
  const probe = rawDatabase(data);
  probe.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.runs[0].userMessageId','message-nowhere') WHERE id='session-tl-1'").run(); probe.exec("PRAGMA wal_checkpoint(TRUNCATE)"); probe.close();
  const before = treeDigest(data), check = checkUpgrade(data);
  assert.deepEqual(treeDigest(data), before);
  assert.equal(check.ok, false);
  assert.deepEqual(check.firstStage.failing.map(fault => fault.sessionId), ["session-tl-1"]);
  assert.equal(check.firstStage.applies, false, "(it is the first transaction's refusal, whatever the version)");
  assert.ok(!check.secondStage.failing.some(fault => fault.sessionId === "session-tl-1") && check.secondStage.skipped === 1);
  const copy = join(temporary(t), "data"); cpSync(data, copy, { recursive: true });
  assert.throws(() => new SqliteConversationStore(copy), (error: unknown) => error instanceof SessionError && error.code === "MIGRATION_REFUSED" && error.message.includes("session-tl-1 (" + check.firstStage.failing[0]!.reason + ")"));
  const left = new DatabaseSync(join(copy, "gateway.sqlite"), { readOnly: true });
  try { assert.equal(userVersion(left), 13, "and the library is still version 13"); } finally { left.close(); }
});

test("a Run id that two conversations hold cannot be held twice by the tables: the check names both conversations, and the upgrade refuses them before it changes anything", t => {
  const data = join(temporary(t), "data");
  // The same conversation twice under two names: every Run id is in both.
  writeV13Root(data, [renamedV13(loadV13Fixture("tools"), "a"), renamedV13(loadV13Fixture("tools"), "b"), loadV13Fixture("commands")]);
  const before = treeDigest(data), check = checkUpgrade(data);
  assert.deepEqual(treeDigest(data), before);
  assert.equal(check.ok, false);
  assert.deepEqual(check.firstStage.failing.map(fault => fault.sessionId), ["session-tl-1-a", "session-tl-1-b"]);
  assert.match(check.firstStage.failing[0]!.reason, /a Run id it holds is held by another conversation too/u);
  const copy = join(temporary(t), "data"); cpSync(data, copy, { recursive: true });
  const bytes = readFileSync(join(copy, "gateway.sqlite"));
  assert.throws(() => new SqliteConversationStore(copy), (error: unknown) => error instanceof SessionError && error.code === "MIGRATION_REFUSED" && error.message.includes("session-tl-1-a (") && error.message.includes("session-tl-1-b ("));
  assert.deepEqual(readFileSync(join(copy, "gateway.sqlite")), bytes, "the library file is the very bytes it was: the refusal came before the first transaction committed");
});

test("no room for the backup, a store this build does not open, a newer library: each is a reason the upgrade would not pass", t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("tools")]);
  const poor = checkUpgrade(data, { freeBytes: () => 10 });
  assert.equal(poor.ok, false); assert.equal(poor.database!.roomForBackup, false);
  assert.match(describeCheck(poor).join("\n"), /NOT ENOUGH/u); assert.equal(poor.firstStage.failing.length + poor.secondStage.failing.length, 0, "the conversations themselves are fine");
  // The provider library is a version this build does not know; the management library has no marker.
  const providers = join(data, "providers"), management = join(data, "management");
  mkdirSync(providers, { mode: 0o700 }); mkdirSync(management, { mode: 0o700 });
  writeFileSync(join(providers, ".harness-gateway-provider.json"), '{"application":"harness-gateway-provider","schemaVersion":1}\n', { mode: 0o600 }); writeFileSync(join(providers, "master.key"), "", { mode: 0o600 });
  const unknown = new DatabaseSync(join(providers, "providers.sqlite"));
  try { unknown.exec("PRAGMA journal_mode=DELETE; CREATE TABLE marker(x); PRAGMA user_version=7"); } finally { unknown.close(); }
  writeFileSync(join(management, "management.sqlite"), "", { mode: 0o600 });
  const stores = checkUpgrade(data);
  assert.equal(stores.ok, false);
  assert.deepEqual(stores.stores.map(found => [found.store, found.present, found.problem]), [["providers", true, "its schema version 7 is not one this build opens"], ["management", true, "it has no ownership marker"], ["content", false, null]]);
  assert.match(describeCheck(stores).join("\n"), /Store providers: WOULD FAIL, its schema version 7 is not one this build opens/u);
  // A library of a later build.
  const newer = join(temporary(t), "data"); writeV13Root(newer, [loadV13Fixture("tools")]);
  const db = rawDatabase(newer); db.exec("PRAGMA user_version=15"); db.close();
  assert.equal(checkUpgrade(newer).state, "newer"); assert.equal(checkUpgrade(newer).ok, false);
});

test("a library that is v14 already, whole or with an upgrade under way (stopped or not), is told as it is", t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("switches"), later(loadV13Fixture("tools"), 1), loadV13Fixture("commands")]);
  const probe = rawDatabase(data), ids = probe.prepare("SELECT id FROM sessions ORDER BY rowid").all().map(row => String(row.id)), victim = "session-sw-31", original = String(probe.prepare("SELECT snapshot FROM sessions WHERE id=?").get(victim)!.snapshot);
  probe.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.runs[0].userMessageId','message-nowhere') WHERE id=?").run(victim); probe.exec("PRAGMA wal_checkpoint(TRUNCATE)"); probe.close();
  assert.throws(() => new SqliteConversationStore(data), (error: unknown) => error instanceof SessionError && error.code === "MIGRATION_STOPPED");
  // Stopped: the library is v14 with conversations not converted, and the check says where.
  const reader = rawDatabase(data); reader.exec("PRAGMA wal_checkpoint(TRUNCATE)"); reader.close();
  const stopped = checkUpgrade(data);
  assert.equal(stopped.state, "under-way"); assert.equal(stopped.ok, false);
  assert.equal(stopped.underWay?.stoppedAt, victim); assert.ok((stopped.underWay?.remaining ?? 0) >= 1 && (stopped.underWay?.remaining ?? 0) < ids.length); assert.ok(!(stopped.underWay?.reason ?? "").includes("message-nowhere"));
  assert.match(describeCheck(stopped).join("\n"), new RegExp("It stopped at " + victim));
  // Repaired, it is still under way, and nothing stops it.
  const fixed = rawDatabase(data); fixed.prepare("UPDATE sessions SET head=?, last_error=NULL WHERE id=?").run(original, victim); fixed.exec("PRAGMA wal_checkpoint(TRUNCATE)"); fixed.close();
  const waiting = checkUpgrade(data);
  assert.equal(waiting.state, "under-way"); assert.equal(waiting.ok, true); assert.equal(waiting.underWay?.stoppedAt, null);
  // Finished by a start, it is whole.
  const store = new SqliteConversationStore(data); store.acknowledgeFirstStart(); store.close();
  const whole = checkUpgrade(data);
  assert.equal(whole.state, "current"); assert.equal(whole.ok, true); assert.equal(userVersion(rawDatabase(data, true)), 14);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Beside a service, and when the file changes under it
// ---------------------------------------------------------------------------------------------------------------------------------
test("beside a process that holds the root (its lock, an open write transaction, a log with a change in it): the check passes the same, takes no lock, changes no file but the log, and the holder can still commit", async t => {
  const data = join(temporary(t), "data");
  writeV12Root(data, [separate(loadV12Fixture("d1"), "one"), separate(loadV12Fixture("clear"), "two")]);
  const quiet = checkUpgrade(data);
  const peer = spawn(process.execPath, [servicePeer, data], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { if (peer.exitCode === null) peer.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => { peer.stdout.once("data", () => resolve()); peer.once("exit", () => reject(new Error("the holder ended before it was ready"))); });
  assert.ok(existsSync(join(data, "gateway.sqlite-wal")) && existsSync(join(data, "gateway.sqlite-shm")), "the holder has the log open");
  const mainBefore = treeDigest(data, ["gateway.sqlite-wal", "gateway.sqlite-shm"]);
  const held = checkUpgrade(data);
  assert.equal(held.mode, "snapshot", "read through the log, as one state");
  assert.equal(held.ok, true, describeCheck(held).join(" | "));
  const answer = (check: UpgradeCheck) => ({ ok: check.ok, version: check.version, counts: check.counts, firstStage: check.firstStage, secondStage: check.secondStage, sharedSessions: check.sharedSessions, endedSeqPlaced: check.endedSeqPlaced, halfPairIds: check.halfPairIds });
  assert.deepEqual(answer(held), answer(quiet), "the same answer as when nobody holds it");
  assert.deepEqual(treeDigest(data, ["gateway.sqlite-wal", "gateway.sqlite-shm"]), mainBefore, "no file but the log changed: the library, the owner lock file, the marker");
  peer.kill("SIGTERM");
  const [code] = await once(peer, "exit") as [number | null];
  assert.equal(code, 0, "the holder could still commit its transaction and let go: the check had taken no lock");
});

test("a library that changes while it is read is not answered for: the check says it changed", t => {
  const data = join(temporary(t), "data");
  writeV12Root(data, [separate(loadV12Fixture("d1"), "one"), separate(loadV12Fixture("clear"), "two")]);
  assert.throws(() => checkUpgrade(data, { progress: done => {
    if (done === 1) { const writer = new DatabaseSync(join(data, "gateway.sqlite")); try { writer.exec("PRAGMA journal_mode=DELETE; CREATE TABLE touched(x)"); } finally { writer.close(); } }
  } }), (error: unknown) => error instanceof SessionError && error.code === "DATABASE_CHANGED");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------------------------
test("the command: exit 0 and the lines for a root that passes, 1 for one that does not, 2 when there is nothing to check; --json is the same answer; nothing is written", t => {
  const directory = temporary(t), good = join(directory, "good"), bad = join(directory, "bad"), home = join(directory, "home");
  mkdirSync(home);
  writeV13Root(good, [loadV13Fixture("switches"), later(loadV13Fixture("tools"), 1)]);
  writeV13Root(bad, [loadV13Fixture("tools")]);
  const probe = rawDatabase(bad), snapshot = JSON.parse(String(probe.prepare("SELECT snapshot FROM sessions").get()!.snapshot)) as { runs: { userMessageId: string }[] };
  snapshot.runs[0]!.userMessageId = "message-nowhere"; probe.prepare("UPDATE sessions SET snapshot=?").run(JSON.stringify(snapshot)); probe.exec("PRAGMA wal_checkpoint(TRUNCATE)"); probe.close();
  // (The check starts no Harness and needs no workspace lease; the flag every start of this command carries is accepted and ignored.)
  const run = (...args: string[]) => spawnSync(process.execPath, [sessionsCli, "check-upgrade", "--workspace-lock-root", join(directory, "locks"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home } });
  const goodBefore = treeDigest(good), badBefore = treeDigest(bad);
  const ok = run("--data-dir", good);
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /Verdict: the upgrade would pass\./u); assert.match(ok.stdout, /Second stage \(version 13 to the tables\): 4 of 4 conversations pass/u);
  const json = JSON.parse(run("--data-dir", good, "--json").stdout) as UpgradeCheck;
  assert.equal(json.ok, true); assert.equal(json.counts.conversations, 4); assert.equal(json.sharedSessions.archived, 2);
  const failing = run("--data-dir", bad);
  assert.equal(failing.status, 1, failing.stderr); assert.match(failing.stdout, /Verdict: the upgrade would NOT pass\./u); assert.match(failing.stdout, /session-tl-1: /u);
  assert.equal((JSON.parse(run("--data-dir", bad, "--json").stdout) as UpgradeCheck).secondStage.failing[0]?.sessionId, "session-tl-1");
  assert.deepEqual(treeDigest(good), goodBefore); assert.deepEqual(treeDigest(bad), badBefore);
  const nothing = run("--data-dir", join(directory, "nowhere"));
  assert.equal(nothing.status, 2); assert.match(nothing.stderr, /there is no conversation library in this data directory/u); assert.ok(!existsSync(join(directory, "nowhere")), "and the missing directory was not made");
  assert.equal(run("--data-dir", good, "--session", "x").status, 2);
  assert.ok(!ok.stdout.includes(directory) && !ok.stderr.includes(directory) && !failing.stdout.includes(directory), "no path of the machine");
  assert.ok(!existsSync(join(directory, "locks")), "and no lock directory was made");
  assert.equal(ok.stderr, "", "and nothing on the error stream when it is not a terminal");
});

test("what the check prints holds no title, no text and no reference to a native session, however many conversations fail", t => {
  const directory = temporary(t), data = join(directory, "data"), words = "wholly distinctive words of the first question";
  const fixture = structuredClone(loadV13Fixture("tools")) as unknown as { sessions: { snapshot: { messages: { role: string; text: string }[]; runs: { input: string; userMessageId: string }[]; nativeBindings: { checkpoint: string }[] } }[] };
  const snapshot = fixture.sessions[0]!.snapshot, first = snapshot.messages.find(message => message.role === "user")!;
  first.text = words; snapshot.runs[0]!.input = words;
  writeV13Root(data, [fixture as never]);
  const probe = rawDatabase(data); probe.close();
  const check = checkUpgrade(data), text = describeCheck(check).join("\n") + "\n" + JSON.stringify(check);
  assert.ok(!text.includes(words) && !text.includes("native-alpha") && !text.includes("native-bravo") && !text.includes(directory), "counts, ids and rules only");
  const broken = rawDatabase(data); broken.prepare("UPDATE sessions SET snapshot=json_set(snapshot,'$.runs[0].userMessageId','message-nowhere')").run(); broken.exec("PRAGMA wal_checkpoint(TRUNCATE)"); broken.close();
  const failing = checkUpgrade(data), failed = describeCheck(failing).join("\n") + "\n" + JSON.stringify(failing);
  assert.equal(failing.ok, false);
  assert.ok(!failed.includes(words) && !failed.includes("message-nowhere") && !failed.includes("native-alpha") && !failed.includes(directory));
});

test("the other stores that a start opens are looked at as this build writes them: a data directory a start has made is fine", async t => {
  const directory = temporary(t), data = join(directory, "data");
  const app = application(data, () => {}, { installations: "any", workspaceLockRoot: join(directory, "locks"), management: { installationMode: "private-fixture" } });
  try { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); } finally { app.store.close(); }
  const check = checkUpgrade(data);
  assert.equal(check.state, "current"); assert.equal(check.ok, true);
  assert.deepEqual(check.stores.map(found => [found.store, found.present, found.problem]), [["providers", true, null], ["management", true, null], ["content", true, null]]);
  assert.deepEqual(check.stores.map(found => found.schema), [1, 6, 1]);
});
