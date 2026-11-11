import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { parseContentRef } from "../../src/contracts/content.js";
import type { CleanupEvidence } from "../../src/contracts/control.js";
import {
  RelayError, parseDeliveryRecord, parseRelayPacket,
  type BindingRelayState, type DeliveryRecord, type RecoverRelay, type RelayBehindIndex, type RelayPacket, type RelayRows,
} from "../../src/contracts/relay.js";
import { SessionError, commandId, messageId, runId, sessionId, type NativeSessionBinding, type PublicRun, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/delivery.js";
import { RELAY_DDL, RELAY_TABLES } from "../../src/infrastructure/session/relay-tables.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { V12_FIXTURES, loadV12Fixture, renamed, writeV12Root, type V12Fixture, type V12FixtureName } from "../fixtures/relay/v12/database.js";

// The v13 relay tables (ADR-055 §14, as slim.md left them), their writes and checks, and the v12 → v13 migration, through the real
// SqliteSessionStore on temporary data roots. Nothing here runs a Harness; v12 data comes from the frozen fixtures.

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const hex = (char: string) => char.repeat(64);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const alpha = { harnessId: "alpha", controlId: "alpha-acp" };
function temporary(t: TestContext, prefix = "g066-relay-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function code(expected: string): (error: unknown) => boolean { return error => error instanceof SessionError && error.code === expected; }
function reason(expected: string): (error: unknown) => boolean { return error => error instanceof RelayError && error.reason === expected; }
function raw(root: string): DatabaseSync { return new DatabaseSync(join(root, "gateway.sqlite"), { timeout: 1000 }); }
function count(db: DatabaseSync, table: string, where = "1"): number { return Number(db.prepare("SELECT count(*) AS count FROM " + table + " WHERE " + where).get()?.count); }

// ---------------------------------------------------------------------------------------------------------------------
// v13 conversations written straight through the Store
// ---------------------------------------------------------------------------------------------------------------------

type Status = PublicRun["status"];
/** A run of `name` on alpha; finished ones carry their settlement, a running one its preparation. */
function run(name: string, suffix: string, status: Status, seq: number): PublicRun {
  const settled = status === "completed" || status === "failed";
  return { id: runId("run-" + name + "-" + suffix), commandId: commandId("send-" + name + "-" + suffix), input: "input " + suffix, userMessageId: messageId("message-" + name + "-" + suffix + "-user"),
    assistantMessageId: messageId("message-" + name + "-" + suffix + "-reply"), selection: alpha, epoch: 1, status, cancelRequested: false, contextThroughSeq: status === "queued" ? 0 : seq - 1,
    sourceRunIds: [], backend: settled ? { status: "completed", reason: "fixture" } : null, cleanup: settled ? clean : null, error: null, stopRequested: false, awaitingSwitchId: null,
    timing: { acceptedAt: 10, ...(status === "queued" ? {} : { preparingAt: 11, contextReadyAt: 12, readyAt: 13 }), ...(settled ? { dispatchedAt: 14, endedAt: 20 } : status === "running" ? { dispatchedAt: 14 } : {}) } };
}
/**
 * A v13 conversation on alpha with Runs one and two finished and, unless `running` is false, Run three running on the
 * binding (its writer); queued Runs follow when asked for. Written as a Runtime would: Run two settles its native binding,
 * Run three then takes it.
 */
function seeded(store: SqliteSessionStore, workspace: string, name: string, options: { readonly running?: boolean; readonly queued?: number } = {}): SessionSnapshot {
  const id = sessionId("session-" + name), running = options.running ?? true;
  let state = store.create({ schemaVersion: 13, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
    configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true }, selection: alpha,
    activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: commandId("create-" + name), kind: "create", fingerprint: hex("a"), resultId: id }] },
    [{ type: "session.created", data: {} }]).session;
  const plan: [string, Status][] = [["one", "completed"], ["two", "running"], ...(running ? [["three", "queued"] as [string, Status]] : []),
    ...Array.from({ length: options.queued ?? 0 }, (_, index) => ["queued" + index, "queued"] as [string, Status])];
  const runs: PublicRun[] = [], messages: SessionSnapshot["messages"][number][] = [];
  for (const [suffix, status] of plan) {
    const row = run(name, suffix, status, 2 + messages.length); runs.push(row);
    messages.push({ id: row.userMessageId, runId: row.id, role: "user", text: row.input, seq: 2 + messages.length, status });
    if (status !== "queued") messages.push({ id: row.assistantMessageId, runId: row.id, role: "assistant", text: "reply " + suffix, seq: 2 + messages.length, status });
  }
  const binding: NativeSessionBinding = { ...alpha, checkpoint: "native-" + name, throughRunId: null, status: "unconfirmed", relay: initialBindingRelay([], "alpha", "alpha-acp", "new") };
  const step = (mutate: (current: SessionSnapshot) => SessionSnapshot, events: number) => { state = store.transact(id, state.version, current => ({ next: mutate(current), events: Array.from({ length: events }, (_, index) => ({ type: "fixture.seeded", data: { index } })) })).session; };
  step(current => ({ ...current, runs, messages, activeRunId: runs[1]!.id, nativeBindings: [binding], commands: [...current.commands, ...runs.map(row => ({ id: row.commandId, kind: "send" as const, fingerprint: hex("b"), resultId: row.id }))] }), messages.length);
  const settled = run(name, "two", "completed", runs[1]!.contextThroughSeq + 1), started = running ? run(name, "three", "running", runs[2]!.contextThroughSeq + 1) : null;
  step(current => ({ ...current, activeRunId: started?.id ?? null, nativeBindings: [{ ...current.nativeBindings![0]!, status: "ready", throughRunId: settled.id }],
    runs: current.runs.map(row => row.id === settled.id ? settled : row.id === started?.id ? started : row),
    messages: current.messages.map(message => message.runId === settled.id ? { ...message, status: "completed" as const } : message.runId === started?.id ? { ...message, status: "running" as const } : message) }), 1);
  if (running) step(current => ({ ...current, nativeBindings: [{ ...current.nativeBindings![0]!, status: "unconfirmed" }] }), 1);
  return state;
}
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function packetIdOf(seed: string): string { return "relay-" + Array.from(createHash("sha256").update(seed).digest().subarray(0, 20), byte => CROCKFORD[byte % 32]).join(""); }
/** A packet manifest for `body` as G070 will render one, quoting `fold` (Run indexes, or explicit fold entries). */
function packetOf(body: string, fold: readonly (number | Readonly<Record<string, unknown>>)[], extra: Readonly<Record<string, unknown>> = {}): RelayPacket {
  return parseRelayPacket({ id: packetIdOf(body), kind: "packet", tier: "full", complete: true,
    target: { harnessId: "alpha", controlId: "alpha-acp", model: null, nativeEpoch: 1 },
    source: { kind: "other", names: [{ harnessId: "bravo", model: null, runs: [0, 1] }] }, range: { fromSeq: 0, throughSeq: 8, fromRun: 0, throughRun: 1 }, basePacketId: null, supersedes: null,
    policyVersion: "relay/1", language: "en", factsFingerprint: hex("f"),
    inputs: { attachOverride: false, digestBehind: [], detailsMissing: [], noteIncluded: false, firstLineOmitted: null },
    redaction: { profile: "egress", count: 0, byClass: {}, overridden: 0, unscanned: 0 },
    body: { sha256: sha(body), bytes: Buffer.byteLength(body, "utf8"), estTokens: 12, estimator: "est/2", untrustedTokens: 0, userTokens: 4 },
    budget: { capTokens: 8000, userCap: 2500, untrustedCap: 3000, window: 200_000, fixedPrefix: 0, windowSource: "assumed", clampedBy: [] },
    sections: [{ id: "words", author: "user", items: 1, estTokens: 4, dataClasses: ["user_text"] }],
    fold: fold.map(unit => typeof unit === "number" ? { kind: "unit", runIndex: unit, grade: "verbatim", why: "tail" } : unit), omissions: [], userEdits: [], ...extra });
}
function deliveryOf(run: string, packet: RelayPacket, extra: Readonly<Record<string, unknown>> = {}): DeliveryRecord {
  return parseDeliveryRecord({ runId: run, packetId: packet.id, channel: "single_text", outcome: { kind: "in_flight" }, handoffLogSeq: null, inputHmac: hex("c"),
    redaction: { rulesVersion: "egress/1", keyId: "key-1", setHmac: "0a1b2c3d" }, autoResend: false, ...extra });
}
/** One transaction on `id` that changes nothing in its snapshot and writes `relay`. */
function write(store: SqliteSessionStore, id: SessionId, relay: RelayRows) {
  const current = store.get(id);
  return store.transact(id, current.version, state => ({ next: state, events: [{ type: "fixture.relay", data: {} }], relay }));
}
function outcomeOf(store: SqliteSessionStore, id: SessionId, run: string): DeliveryRecord["outcome"]["kind"] | undefined {
  return store.relayDeliveries(id).find(row => row.runId === run)?.outcome.kind;
}
const decided = (kind: "recorded" | "not_recorded" | "unknown", seq = 1) => kind === "recorded" ? { kind, evidence: "E3" as const, decidedSeq: seq, decidedAt: 30 }
  : kind === "not_recorded" ? { kind, reason: "rejected_before_insert" as const, decidedSeq: seq, decidedAt: 30 } : { kind, reason: "no_evidence" as const, decidedSeq: seq, decidedAt: 30 };
function open(t: TestContext, options: ConstructorParameters<typeof SqliteSessionStore>[1] = {}): { readonly root: string; readonly workspace: string; readonly store: SqliteSessionStore } {
  const root = temporary(t), store = new SqliteSessionStore(join(root, "data"), options);
  t.after(() => { try { store.close(); } catch { /* a test that disabled the Store has asserted why */ } });
  return { root: join(root, "data"), workspace: root, store };
}

test("a new business database is made at v13 with its relay tables and 4 triggers", t => {
  const { root, store } = open(t); store.close();
  const db = raw(root);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 13);
    const names = (type: string) => db.prepare("SELECT name FROM sqlite_schema WHERE type=? AND name LIKE 'relay_%' ORDER BY name").all(type).map(row => String(row.name));
    assert.deepEqual(names("table"), [...RELAY_TABLES].sort()); assert.equal(names("trigger").length, 4);
    for (const table of RELAY_TABLES) assert.match(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)?.sql), /\)\s*STRICT$/u, table + " is STRICT");
    assert.ok(RELAY_DDL.includes("PRAGMA") === false, "the DDL leaves the version to the migration");
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C01: the seven v12 fixtures
// ---------------------------------------------------------------------------------------------------------------------

/** Each fixture's bindings after the migration: Harness, status, epoch, floor, mark, and whether everything is sent again. */
const EXPECTED: Readonly<Record<V12FixtureName, readonly (readonly string[])[]>> = {
  "d1": [["alpha ready e1 f-1 m14 resendAll", "bravo ready e1 f-1 m39"]],
  "dispatch-failed": [["alpha ready e1 f-1 m14", "bravo ready e1 f-1 m39"]],
  "insert-rejected": [["alpha ready e1 f-1 m14 resendAll", "bravo ready e1 f-1 m39"]],
  "import": [["alpha ready e1 f-1 m0"]],
  "branch": [["alpha ready e1 f-1 m14"], ["alpha ready e1 f-1 m0"]],
  "clear": [["alpha ready e2 f35 m-1"]],
  "reset-d1": [["alpha archived e1 f-1 m25", "alpha ready e2 f-1 m-1 resendAll"]],
};
function described(binding: NativeSessionBinding): string {
  const relay = binding.relay!;
  return [binding.harnessId, binding.status, "e" + relay.epoch, "f" + relay.floor, "m" + relay.mark, ...(relay.resendAll ? ["resendAll"] : []), ...(relay.pending === null ? [] : ["pending"])].join(" ");
}
/** The index rows of a Session, by Run. */
function indexes(db: DatabaseSync, id: string): ReadonlyMap<string, RelayBehindIndex> {
  return new Map(db.prepare("SELECT run_id,index_json FROM relay_index WHERE session_id=?").all(id).map(row => [String(row.run_id), JSON.parse(String(row.index_json)) as RelayBehindIndex]));
}
/**
 * What a migrated binding is owed, computed here independently of the migration from its index rows: finished
 * dispatched Turns that are no native commands and ran elsewhere than the binding's epoch, above max(mark, floor); and the
 * Session's starting history when nothing at or above it is known.
 */
function owed(state: SessionSnapshot, binding: NativeSessionBinding, rows: ReadonlyMap<string, RelayBehindIndex>, asOf = Number.MAX_SAFE_INTEGER): readonly string[] {
  const relay = binding.relay!, base = Math.max(relay.mark, relay.floor);
  const facts = [...rows.values()].filter(row => row.commandEffect === null && row.seq > base && row.seq <= asOf &&
    (row.executedOn === null || row.executedOn.harnessId !== binding.harnessId || row.executedOn.controlId !== binding.controlId || row.executedOn.nativeEpoch !== relay.epoch)).map(row => row.runId as string);
  return [...facts, ...((state.origin?.history.length ?? 0) > 0 && base < 0 ? ["origin"] : [])];
}
function migrated(t: TestContext, fixtures: readonly V12Fixture[]): { readonly root: string; readonly store: SqliteSessionStore } {
  const root = join(temporary(t, "g066-v12-"), "data");
  writeV12Root(root, fixtures);
  const store = new SqliteSessionStore(root, { now: () => new Date("2026-11-09T12:00:00Z") });
  t.after(() => { try { store.close(); } catch { /* asserted by the test */ } });
  return { root, store };
}

for (const name of V12_FIXTURES) {
  test("the v12 fixture " + name + " migrates to v13: marks only go down, epochs grow along bindings, what is in doubt is sent again", t => {
    const fixture = loadV12Fixture(name), { root, store } = migrated(t, [fixture]);
    const db = raw(root);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 13);
      for (const [position, row] of fixture.sessions.entries()) {
        const id = sessionId(row.id), state = store.get(id), v12 = row.snapshot as unknown as SessionSnapshot, rows = indexes(db, row.id);
        assert.equal(state.schemaVersion, 13); assert.equal(state.version, row.version, "the migration moves no version"); assert.equal(state.lastSeq, row.lastSeq);
        assert.deepEqual({ ...state, schemaVersion: 12, nativeBindings: state.nativeBindings?.map(({ relay: _relay, ...binding }) => binding) }, JSON.parse(JSON.stringify(v12)), "only the version and the relay state change");
        // Events stay as they were.
        let after = 0; const events: unknown[] = [];
        for (let page = store.events(id, 0); page.length; page = store.events(id, after)) { events.push(...page); after = page.at(-1)!.seq; }
        assert.deepEqual(events, row.events);
        assert.deepEqual((state.nativeBindings ?? []).map(described), EXPECTED[name][position], name + " " + row.id);
        // One behind index row for each finished dispatched Run, with its fact seq (its run.ended's).
        const dispatched = v12.runs.filter(run => run.timing?.dispatchedAt !== undefined && ["completed", "failed", "cancelled", "unknown"].includes(run.status));
        assert.deepEqual([...rows.keys()].sort(), dispatched.map(run => run.id as string).sort());
        for (const run of dispatched) assert.equal(rows.get(run.id)!.seq, row.events.find(event => event.type === "run.ended" && event.data.runId === run.id)!.seq);
        const lineage = new Map<string, number>();
        for (const binding of state.nativeBindings ?? []) {
          const relay = binding.relay!, key = binding.harnessId + ":" + binding.controlId;
          // Epochs strictly grow along the bindings of one Harness control.
          assert.ok(relay.epoch > (lineage.get(key) ?? 0), "epoch of " + key); lineage.set(key, relay.epoch);
          // Only down: the mark never passes the v12 native position (its Run's fact seq), nor 0 without one.
          const position = binding.throughRunId === null ? 0 : rows.get(binding.throughRunId)!.seq;
          if (relay.mark >= 0) assert.ok(relay.mark <= position, "mark " + relay.mark + " ≤ v12 position " + position);
          assert.equal(relay.pending, null, "nothing was sent in v12 that waits for a confirmation");
          // Nothing owed: sent as usual; what is owed with a history in doubt is sent again, and what has none is not.
          const archivedAt = binding.status === "archived" ? row.events.find(event => event.type === "native.branch_requested")?.seq : undefined;
          if (owed(state, binding, rows, archivedAt).length === 0) assert.equal(relay.resendAll, false, described(binding));
          // executedOn names the binding's Harness control in an epoch it went through.
          for (const index of rows.values()) if (index.executedOn !== null && index.executedOn.harnessId === binding.harnessId) assert.ok(index.executedOn.nativeEpoch <= (lineage.get(key) ?? 0) + 1);
        }
      }
      // The migration kept a backup of the v12 database (ADR-049).
      const backups = readdirSync(join(root, "backups")).filter(entry => /^gateway-v12-20261109T120000Z-[0-9a-f]{8}\.sqlite$/u.test(entry));
      assert.equal(backups.length, 1);
      const backup = new DatabaseSync(join(root, "backups", backups[0]!), { readOnly: true });
      try {
        assert.equal(backup.prepare("PRAGMA user_version").get()?.user_version, 12);
        assert.equal(count(backup, "sessions"), fixture.sessions.length); assert.equal(count(backup, "events"), fixture.sessions.reduce((total, row) => total + row.events.length, 0));
        assert.equal(backup.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'relay_%'").get()?.count, 0);
      } finally { backup.close(); }
    } finally { db.close(); }
  });
}

test("epochs follow each Run where it ran: a clear and a native reset each start the next one", t => {
  const { root, store } = migrated(t, [loadV12Fixture("clear"), renamed(loadV12Fixture("reset-d1"), "reset")]);
  const db = raw(root);
  try {
    const epochs = (id: string) => [...indexes(db, id).values()].sort((a, b) => a.index - b.index).map(row => row.executedOn?.nativeEpoch + (row.commandEffect === null ? "" : ":" + row.commandEffect));
    assert.deepEqual(epochs("session-1"), ["1", "1", "1:clear", "2"]);
    assert.deepEqual(epochs("session-1-reset"), ["1", "1", "1", "2:compact"]);
    assert.equal(store.get(sessionId("session-1-reset")).nativeBindings?.[1]?.relay?.epoch, 2);
  } finally { db.close(); }
});

test("a failure in the middle of the migration rolls all of it back and keeps the backup", t => {
  const good = loadV12Fixture("d1"), bad = renamed(loadV12Fixture("branch"), "bad");
  // The second database Session names a native binding without its Harness: no v12 runtime writes that.
  const broken: V12Fixture = { ...bad, sessions: bad.sessions.map((row, index) => index === 1 ? { ...row, events: row.events.map(event => event.type === "native.binding_prepared" ? { ...event, data: { runId: event.data.runId, resumed: true } } : event) } : row) };
  const root = join(temporary(t, "g066-v12-"), "data");
  writeV12Root(root, [good, broken]);
  const before = raw(root), rows = before.prepare("SELECT id,snapshot FROM sessions ORDER BY rowid").all(); before.close();
  assert.throws(() => new SqliteSessionStore(root, { now: () => new Date("2026-11-09T12:00:00Z") }), code("INVALID_DATA"));
  const db = raw(root);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 12);
    assert.deepEqual(db.prepare("SELECT id,snapshot FROM sessions ORDER BY rowid").all(), rows, "every Session is as it was, the first one too");
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'relay_%'").get()?.count, 0, "the relay tables went with the transaction");
    assert.equal(db.prepare("SELECT owner_active FROM owner_metadata").get()?.owner_active, 0, "nothing claimed the database");
  } finally { db.close(); }
  assert.equal(readdirSync(join(root, "backups")).filter(entry => entry.startsWith("gateway-v12-")).length, 1, "the backup stays");
});

test("a migration killed with SIGKILL leaves a database at v12 or v13 with nothing half done, and the next start opens it", async t => {
  const fixtures = Array.from({ length: 1500 }, (_, index) => renamed(loadV12Fixture(V12_FIXTURES[index % V12_FIXTURES.length]!), "copy" + index));
  const seen: string[] = [];
  // Killed right after the backup was published (before or as the transaction begins), while the transaction writes its
  // WAL, and well after it (the child may have finished).
  for (const when of ["backup", "wal", "late"] as const) {
    const root = join(temporary(t, "g066-kill-"), "data");
    writeV12Root(root, fixtures);
    const child = join(root, "..", "open.mjs");
    writeFileSync(child, "import { SqliteSessionStore } from " + JSON.stringify(pathToFileURL(join(repository, "dist/src/infrastructure/session/sqlite-store.js")).href) + ";\n" +
      "const store = new SqliteSessionStore(process.argv[2]); store.close(); process.stdout.write('opened\\n');\n");
    const opening = spawn(process.execPath, [child, root], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => opening.once("exit", () => resolve()));
    const folder = join(root, "backups"), wal = join(root, "gateway.sqlite-wal");
    const ready = () => when === "wal" ? existsSync(wal) && statSync(wal).size >= 2 * 1024 * 1024 : existsSync(folder) && readdirSync(folder).some(entry => entry.endsWith(".sqlite"));
    for (let tries = 0; tries < 20_000 && opening.exitCode === null && !ready(); tries++) await new Promise(resolve => setTimeout(resolve, 1));
    if (when === "late") await new Promise(resolve => setTimeout(resolve, 2000));
    const alive = opening.exitCode === null;
    opening.kill("SIGKILL"); await exited;
    const db = raw(root);
    try {
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version); seen.push(when + (alive ? "" : " (finished)") + ": v" + version);
      assert.ok(version === 12 || version === 13, "version " + version);
      if (when === "wal") { assert.ok(alive, "the kill landed while the migration wrote"); assert.equal(version, 12, "an unfinished migration leaves nothing behind"); }
      assert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
      const relayTables = Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name LIKE 'relay_%'").get()?.count);
      assert.equal(relayTables, version === 13 ? RELAY_TABLES.length : 0, "the relay tables exist exactly at v13");
      const versions = new Set(db.prepare("SELECT json_extract(snapshot,'$.schemaVersion') AS version FROM sessions").all().map(row => Number(row.version)));
      assert.deepEqual([...versions], [version], "every Session is at the database's version");
      assert.equal(count(db, "sessions"), fixtures.reduce((total, fixture) => total + fixture.sessions.length, 0));
    } finally { db.close(); }
    const store = new SqliteSessionStore(root);
    try { assert.equal(store.list(10).length, 10); assert.equal(store.get(sessionId("session-1-copy0")).schemaVersion, 13); } finally { store.close(); }
  }
  t.diagnostic("after SIGKILL: " + seen.join("; "));
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C03: the fold check
// ---------------------------------------------------------------------------------------------------------------------

test("a packet whose fold quotes an unfinished Turn or one accepted after the current input fails that Turn only", t => {
  const { workspace, store } = open(t), refused = seeded(store, workspace, "refused", { queued: 1 }), kept = seeded(store, workspace, "kept");
  const three = refused.runs[2]!, one = refused.runs[0]!;
  const attempt = (packet: RelayPacket, current = three) => () => write(store, refused.id, { packets: [{ runId: current.id, packet, body: bodyOf(packet) }], deliveries: [{ kind: "insert", record: deliveryOf(current.id, packet) }] });
  const bodies = new Map<string, string>(), bodyOf = (packet: RelayPacket) => bodies.get(packet.id)!;
  const make = (text: string, fold: readonly (number | Readonly<Record<string, unknown>>)[]) => { const packet = packetOf(text, fold); bodies.set(packet.id, text); return packet; };
  // The current Turn itself, a queued Turn and a range reaching it have not finished.
  for (const fold of [[0, 2], [3], [{ kind: "range", fromRun: 0, throughRun: 2, units: 3 }], [{ kind: "excluded", runIndex: 3, by: "user" }]])
    assert.throws(attempt(make("unfinished " + JSON.stringify(fold), fold)), reason("render"));
  // Run two's input came after Run one's: one cannot quote it.
  assert.throws(attempt(make("later input", [1]), one), reason("render"));
  const db = raw(join(workspace, "data"));
  try { for (const table of ["relay_bodies", "relay_packets", "relay_deliveries"]) assert.equal(count(db, table, "session_id='session-refused'"), 0, table); } finally { db.close(); }
  // The Store goes on; the Turn ends failed with the relay's code, as the coordinator will record it.
  store.assertOwner();
  const current = store.get(refused.id);
  store.transact(refused.id, current.version, state => ({ next: { ...state, activeRunId: null,
    runs: state.runs.map(row => row.id === three.id ? { ...row, status: "failed" as const, cleanup: clean, error: { code: "RELAY_PREPARE_FAILED", message: "render" }, timing: { ...row.timing!, endedAt: 21 } } : row),
    messages: state.messages.map(message => message.runId === three.id ? { ...message, status: "failed" as const } : message) },
    events: [{ type: "run.ended", data: { runId: three.id, status: "failed", error: { code: "RELAY_PREPARE_FAILED", reason: "render" } } }] }));
  assert.equal(store.get(refused.id).runs[2]?.error?.code, "RELAY_PREPARE_FAILED");
  // Finished Turns accepted before the current input are quoted as they are.
  const good = packetOf("quotes finished Turns", [0, 1, { kind: "range", fromRun: 0, throughRun: 1, units: 2 }]);
  const committed = write(store, kept.id, { packets: [{ runId: kept.runs[2]!.id, packet: good, body: "quotes finished Turns" }], deliveries: [{ kind: "insert", record: deliveryOf(kept.runs[2]!.id, good) }] });
  assert.equal(committed.events.length, 1); assert.equal(outcomeOf(store, kept.id, kept.runs[2]!.id), "in_flight");
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C04: delivery transitions
// ---------------------------------------------------------------------------------------------------------------------

test("delivery rows move along the table: in flight to any decided outcome, a decided one only to itself", t => {
  const { root, workspace, store } = open(t);
  const state = seeded(store, workspace, "deliveries", { running: false });
  // Ten finished Turns, each with its own delivery of one packet.
  const extra = Array.from({ length: 10 }, (_, index) => run("deliveries", "d" + index, "completed", state.lastSeq + 1 + index * 2));
  const current = store.transact(state.id, state.version, now => ({ next: { ...now, runs: [...now.runs, ...extra],
    messages: [...now.messages, ...extra.flatMap((row, index) => [{ id: row.userMessageId, runId: row.id, role: "user" as const, text: row.input, seq: now.lastSeq + 1 + index * 2, status: row.status },
      { id: row.assistantMessageId, runId: row.id, role: "assistant" as const, text: "reply", seq: now.lastSeq + 2 + index * 2, status: row.status }])],
    commands: [...now.commands, ...extra.map(row => ({ id: row.commandId, kind: "send" as const, fingerprint: hex("b"), resultId: row.id }))] },
    events: Array.from({ length: 20 }, () => ({ type: "fixture.seeded", data: {} })) })).session;
  const packet = packetOf("one packet for every Turn", [0]);
  write(store, current.id, { packets: [{ runId: extra[0]!.id, packet, body: "one packet for every Turn" }], deliveries: extra.map(row => ({ kind: "insert" as const, record: deliveryOf(row.id, packet) })) });
  const move = (index: number, kind: "recorded" | "not_recorded" | "unknown") => write(store, current.id, { deliveries: [{ kind: "outcome", runId: extra[index]!.id, outcome: decided(kind) }] });
  const allowed: readonly (readonly ("recorded" | "not_recorded" | "unknown")[])[] = [["recorded"], ["not_recorded"], ["unknown"], ["unknown", "unknown"], ["not_recorded", "not_recorded"], ["recorded", "recorded"]];
  for (const [index, path] of allowed.entries()) { for (const kind of path) move(index, kind); assert.equal(outcomeOf(store, current.id, extra[index]!.id), path.at(-1), path.join(" → ")); }
  for (const [index, to] of [[0, "unknown"], [0, "not_recorded"], [1, "unknown"], [1, "recorded"], [2, "recorded"], [2, "not_recorded"]] as const)
    assert.throws(() => move(index, to), code("INVALID_TRANSITION"), "from " + outcomeOf(store, current.id, extra[index]!.id) + " to " + to);
  assert.throws(() => write(store, current.id, { deliveries: [{ kind: "outcome", runId: extra[8]!.id, outcome: { kind: "in_flight" } as never }] }), code("INVALID_TRANSITION"));
  store.assertOwner();
  // A same-value write leaves the outcome out of its statement: this guard, which refuses any change of outcome to itself, never fires.
  const db = raw(root);
  db.exec("CREATE TRIGGER fixture_same_outcome BEFORE UPDATE OF outcome ON relay_deliveries WHEN NEW.outcome=OLD.outcome BEGIN SELECT RAISE(ABORT,'same-value outcome in SET'); END");
  write(store, current.id, { deliveries: [{ kind: "outcome", runId: extra[3]!.id, outcome: { kind: "unknown", reason: "owner_ended", decidedSeq: 2, decidedAt: 40 } }] });
  assert.equal(store.relayDeliveries(current.id).find(row => row.runId === extra[3]!.id)?.outcome.kind, "unknown");
  db.exec("DROP TRIGGER fixture_same_outcome");
  // The trigger itself only asserts: it lets a same-value write through and refuses in_flight ← recorded.
  db.prepare("UPDATE relay_deliveries SET outcome='unknown' WHERE session_id=? AND run_id=?").run(current.id, extra[3]!.id);
  assert.throws(() => db.prepare("UPDATE relay_deliveries SET outcome='in_flight',evidence=NULL,reason=NULL,decided_seq=NULL WHERE session_id=? AND run_id=?").run(current.id, extra[0]!.id), /illegal delivery transition/u);
  assert.throws(() => db.prepare("UPDATE relay_deliveries SET outcome='unknown',evidence=NULL,reason='absent' WHERE session_id=? AND run_id=?").run(current.id, extra[0]!.id), /illegal delivery transition/u);
  db.close();
  store.assertOwner();
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C05: fault injection
// ---------------------------------------------------------------------------------------------------------------------

test("identity clashes and same-value writes never disable the Store, and a refused write leaves a bystander conversation working", t => {
  const { root, workspace, store } = open(t), target = seeded(store, workspace, "faults"), bystander = seeded(store, workspace, "bystander", { running: false });
  const three = target.runs[2]!;
  const bystanderStill = () => { const now = store.get(bystander.id); store.transact(bystander.id, now.version, state => ({ next: state, events: [{ type: "fixture.alive", data: {} }] })); };
  // Identity clashes: one packet identity with two texts, a second delivery for one Turn.
  const packet = packetOf("first text", [0]);
  write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
  const clash = parseRelayPacket({ ...packet, body: { ...packet.body, sha256: sha("other text"), bytes: Buffer.byteLength("other text") } });
  assert.throws(() => write(store, target.id, { packets: [{ runId: three.id, packet: clash, body: "other text" }] }), reason("render_mismatch"));
  assert.throws(() => write(store, target.id, { deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] }), reason("storage"));
  assert.throws(() => write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text but longer" }] }), reason("render"), "a text that is not its manifest's");
  bystanderStill();
  // The same text sent again by the same packet identity is kept once (ON CONFLICT DO NOTHING).
  write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text" }] });
  // Same-value writes.
  write(store, target.id, { deliveries: [{ kind: "outcome", runId: three.id, outcome: decided("unknown") }] });
  write(store, target.id, { deliveries: [{ kind: "outcome", runId: three.id, outcome: { kind: "unknown", reason: "owner_ended", decidedSeq: 9, decidedAt: 50 } }] });
  bystanderStill(); store.assertOwner();
  const check = raw(root);
  try { assert.equal(count(check, "relay_packets", "session_id='session-faults'"), 1); assert.equal(count(check, "relay_bodies", "session_id='session-faults'"), 1); }
  finally { check.close(); }
});

test("a relay state that names a packet the conversation does not keep is refused with the transaction", t => {
  const { workspace, store } = open(t), state = seeded(store, workspace, "references");
  const binding = state.nativeBindings![0]!, missing = packetOf("never written", [0]);
  const pending: BindingRelayState = { ...binding.relay!, pending: { packetId: missing.id, fromSeq: 0, throughSeq: 3, autoResends: 0 } };
  const move = (relay?: RelayRows) => store.transact(state.id, store.get(state.id).version, now => ({ next: { ...now, nativeBindings: [{ ...binding, relay: pending }] }, events: [{ type: "fixture.pending", data: {} }], ...(relay === undefined ? {} : { relay }) }));
  assert.throws(() => move(), code("INVALID_DATA"));
  move({ packets: [{ runId: state.runs[2]!.id, packet: missing, body: "never written" }], deliveries: [{ kind: "insert", record: deliveryOf(state.runs[2]!.id, missing) }] });
  assert.equal(store.get(state.id).nativeBindings?.[0]?.relay?.pending?.packetId, missing.id);
});

// ---------------------------------------------------------------------------------------------------------------------
// The handoff log and the preference
// ---------------------------------------------------------------------------------------------------------------------

test("the handoff log has one row for the first handoff to each Harness, and a delivery names it", t => {
  const { root, workspace, store } = open(t, { now: () => new Date("2026-11-11T12:00:00Z") });
  const first = store.logHandoff("codex");
  assert.deepEqual(first, { record: { logSeq: 1, harnessId: "codex", firstAt: Date.parse("2026-11-11T12:00:00Z") }, created: true });
  assert.deepEqual(store.logHandoff("codex"), { record: first.record, created: false }, "the same Harness again returns the first row");
  assert.equal(store.logHandoff("claude").record.logSeq, 2);
  assert.deepEqual(store.handoffs().map(row => row.harnessId), ["codex", "claude"]);
  assert.throws(() => store.logHandoff("Not A Harness"), code("INVALID_DATA"));
  assert.equal(store.handoffUsed(1), false, "no delivery names it yet");
  const state = seeded(store, workspace, "handoff"), three = state.runs[2]!, packet = packetOf("a handoff packet", [0]);
  write(store, state.id, { packets: [{ runId: three.id, packet, body: "a handoff packet" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet, { handoffLogSeq: 1 }) }] });
  assert.equal(store.handoffUsed(1), true); assert.equal(store.handoffUsed(2), false);
  const db = raw(root);
  try {
    assert.throws(() => db.prepare("UPDATE relay_log SET first_at=0 WHERE seq=1").run(), /append-only/u, "the log is append-only");
    assert.throws(() => db.prepare("INSERT INTO relay_log(harness_id,first_at) VALUES('codex',5)").run(), /UNIQUE/u, "one row per Harness");
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='relay_log_archive' OR name='relay_windows'").get()?.count, 0, "no archive and no observed windows");
  } finally { db.close(); }
  store.assertOwner();
});

test("relay_prefs takes the one key with its two values, and the last writer wins", t => {
  const { root, store } = open(t);
  assert.deepEqual(store.relayPrefs(), {});
  store.setPref("relay.attach", "off"); store.setPref("relay.attach", "auto"); store.setPref("relay.attach", "off");
  assert.deepEqual(store.relayPrefs(), { "relay.attach": "off" });
  for (const [key, value] of [["relay.elsewhere", "x"], ["relay.crossVendor", "allow"], ["relay.attach", "always"], ["relay.attach", "x".repeat(65)]] as const)
    assert.throws(() => store.setPref(key as never, value), code("INVALID_DATA"), key + "=" + value);
  const db = raw(root);
  try {
    assert.throws(() => db.prepare("INSERT INTO relay_prefs(key,value,updated_at) VALUES('relay.elsewhere','x',1)").run(), /CHECK constraint/u, "the table's own check is the assertion behind it");
    assert.throws(() => db.prepare("INSERT INTO relay_prefs(key,value,updated_at) VALUES('relay.attach',?,1)").run("x".repeat(65)), /CHECK constraint/u);
  } finally { db.close(); }
  store.assertOwner();
});

test("a preference table made with the old keys is rebuilt when the Store opens, keeping the rows the contract still lists", t => {
  const root = join(temporary(t), "data");
  new SqliteSessionStore(root).close();
  const db = raw(root);
  db.exec("DROP TABLE relay_prefs");
  db.exec("CREATE TABLE relay_prefs(key TEXT PRIMARY KEY CHECK(key IN('relay.crossVendor','relay.attach')), value TEXT NOT NULL CHECK(length(value)<=64), updated_at INTEGER NOT NULL) STRICT");
  db.prepare("INSERT INTO relay_prefs VALUES('relay.crossVendor','ask',1),('relay.attach','off',2)").run();
  db.close();
  const store = new SqliteSessionStore(root);
  try {
    assert.deepEqual(store.relayPrefs(), { "relay.attach": "off" });
    store.setPref("relay.attach", "auto"); assert.deepEqual(store.relayPrefs(), { "relay.attach": "auto" });
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Recovery, deletion, windows and the content references of relay rows
// ---------------------------------------------------------------------------------------------------------------------

test("claimAndRecover runs the relay recovery of each Session in a SAVEPOINT of its own: one Session's failure marks only that Session", t => {
  const root = join(temporary(t), "data"), workspace = join(root, "..");
  const first = new SqliteSessionStore(root);
  for (const name of ["kept", "failing"]) {
    const state = seeded(first, workspace, name), three = state.runs[2]!, packet = packetOf("packet of " + name, [0]);
    write(first, state.id, { packets: [{ runId: three.id, packet, body: "packet of " + name }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
  }
  first.close();
  const seen: string[] = [];
  const recoverRelay: RecoverRelay = (state, deliveries) => {
    seen.push(state.id + ":" + deliveries.map(row => row.outcome.kind).join(","));
    if (state.id === "session-failing") throw new Error("injected relay recovery failure");
    return { next: state, deliveries: deliveries.map(row => ({ runId: row.runId, outcome: { kind: "unknown" as const, reason: "owner_ended" as const, decidedSeq: state.lastSeq + 1, decidedAt: 99 } })) };
  };
  const store = new SqliteSessionStore(root, { recoverRelay });
  try {
    assert.deepEqual(seen.sort(), ["session-failing:in_flight", "session-kept:in_flight"]);
    const kept = store.get(sessionId("session-kept")), failing = store.get(sessionId("session-failing"));
    assert.equal(kept.status, "blocked"); assert.equal(failing.status, "blocked"); assert.equal(kept.runs[2]?.status, "unknown"); assert.equal(failing.runs[2]?.status, "unknown");
    assert.equal(outcomeOf(store, kept.id, kept.runs[2]!.id), "unknown"); assert.equal(outcomeOf(store, failing.id, failing.runs[2]!.id), "in_flight", "its relay rows rolled back");
    assert.equal(kept.relayRecoveryFailed, undefined); assert.equal(failing.relayRecoveryFailed, failing.lastSeq);
    const recovered = (id: SessionId) => store.events(id, store.get(id).lastSeq - 1).find(event => event.type === "session.recovered")!.data.relay;
    assert.deepEqual(recovered(kept.id), { failed: false, deliveries: [{ runId: kept.runs[2]!.id, outcome: "unknown" }], bindings: [{ harnessId: "alpha", controlId: "alpha-acp", epoch: 1, pending: false }] });
    assert.deepEqual(recovered(failing.id), { failed: true });
  } finally { store.close(); }
  // Without a relay recovery (G068 provides it) recovery is what it was: its event has no relay part.
  const again = join(temporary(t), "data"), plain = new SqliteSessionStore(again); seeded(plain, join(again, ".."), "plain"); plain.close();
  const reopened = new SqliteSessionStore(again);
  try { const state = reopened.get(sessionId("session-plain")); assert.equal(reopened.events(state.id, state.lastSeq - 1)[0]?.data.relay, undefined); assert.equal(state.relayRecoveryFailed, undefined); }
  finally { reopened.close(); }
});

test("deleteSession removes a closed conversation with every relay row in one transaction, and leaves the others", t => {
  const { root, workspace, store } = open(t), gone = seeded(store, workspace, "gone"), other = seeded(store, workspace, "other");
  for (const state of [gone, other]) {
    const three = state.runs[2]!, packet = packetOf("rows of " + state.id, [0]);
    write(store, state.id, { packets: [{ runId: three.id, packet, body: "rows of " + state.id }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
    // The index rows a migration writes for the Runs it indexed.
    const side = raw(root);
    try { side.prepare("INSERT INTO relay_index(session_id,run_id,run_index,index_json) VALUES(?,?,0,'{}')").run(state.id, state.runs[0]!.id); } finally { side.close(); }
  }
  assert.throws(() => store.deleteSession(gone.id), code("SESSION_BUSY"), "an open conversation stays");
  const now = store.get(gone.id);
  store.transact(gone.id, now.version, state => ({ next: { ...state, status: "closed", activeRunId: null, runs: state.runs.map(row => row.status === "running" ? { ...row, status: "failed" as const, cleanup: clean, backend: { status: "failed" as const, reason: "closed" } } : row),
    messages: state.messages.map(message => message.status === "running" ? { ...message, status: "failed" as const } : message) }, events: [{ type: "session.closed", data: {} }] }));
  store.deleteSession(gone.id);
  assert.throws(() => store.get(gone.id), code("SESSION_NOT_FOUND"));
  const db = raw(root);
  try {
    for (const table of ["relay_bodies", "relay_packets", "relay_deliveries", "relay_index", "events"]) {
      assert.equal(count(db, table, "session_id='session-gone'"), 0, table); assert.ok(count(db, table, "session_id='session-other'") > 0, table + " of the other one");
    }
    assert.equal(count(db, "create_keys", "session_id='session-gone'"), 0); assert.equal(count(db, "sessions"), 1);
  } finally { db.close(); }
  assert.equal(store.get(other.id).id, other.id);
});

test("no relay row holds an object shaped like a ContentRef: relay rows keep positions, counts and fingerprints, never content references", t => {
  const { root, workspace, store } = open(t), state = seeded(store, workspace, "content");
  const three = state.runs[2]!, packet = packetOf("content-store.ts is named in the text, which is fine", [0, 1]);
  write(store, state.id, { packets: [{ runId: three.id, packet, body: "content-store.ts is named in the text, which is fine" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
  store.logHandoff("anthropic");
  const db = raw(root);
  try {
    db.prepare("INSERT INTO relay_index(session_id,run_id,run_index,index_json) VALUES(?,?,0,?)").run(state.id, state.runs[0]!.id, JSON.stringify({ runId: state.runs[0]!.id, index: 0, seq: 3, executedOn: { harnessId: "alpha", controlId: "alpha-acp", nativeEpoch: 1 }, dispatched: true, status: "completed", input: "recorded", commandEffect: null }));
    let objects = 0;
    const visit = (value: unknown, where: string): void => {
      if (Array.isArray(value)) { value.forEach(item => visit(item, where)); return; }
      if (value === null || typeof value !== "object") return;
      objects++;
      const keys = Object.keys(value);
      assert.ok(!(keys.includes("id") && keys.includes("sha256") && keys.includes("mediaType")), where + " holds a ContentRef shape");
      assert.throws(() => parseContentRef(value), SessionError, where);
      for (const item of Object.values(value)) visit(item, where);
    };
    for (const [table, columns] of [["relay_packets", ["manifest_json"]], ["relay_index", ["index_json"]]] as const)
      for (const row of db.prepare("SELECT " + columns.join(",") + " FROM " + table).all()) for (const column of columns) visit(JSON.parse(String(row[column])), table + "." + column);
    assert.ok(objects >= 10, "the scan read the rows: " + objects + " objects");
  } finally { db.close(); }
});
