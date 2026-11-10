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
  RELAY_LOG_ARCHIVE_ROWS, RELAY_LOG_ROWS, RELAY_PINS, RELAY_WINDOW_RETENTION_MS, RelayError, markOf, parseDeliveryRecord, parseRelayPacket, parseWorkspaceObservation, redactionTag,
  type BindingRelayState, type DeliveryRecord, type RecoverRelay, type RelayBehindIndex, type RelayPacket, type RelayRows,
} from "../../src/contracts/relay.js";
import { SessionError, commandId, messageId, runId, sessionId, type NativeSessionBinding, type PublicRun, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/migrate.js";
import { RELAY_DDL, RELAY_TABLES } from "../../src/infrastructure/session/relay-tables.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { V12_FIXTURES, loadV12Fixture, renamed, writeV12Root, type V12Fixture, type V12FixtureName } from "../fixtures/relay/v12/database.js";

// G066 (ADR-055 §14): the v13 relay tables, their writes and checks, and the v12 → v13 migration, through the real
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
  return parseRelayPacket({ id: packetIdOf(body), kind: "packet", tier: "standard", complete: true, reanchor: false,
    target: { harnessId: "alpha", controlId: "alpha-acp", model: null, vendor: "unknown:alpha", nativeEpoch: 1 },
    source: { kind: "other", names: [{ harnessId: "bravo", model: null, runs: [0, 1] }] }, range: { fromSeq: 0, throughSeq: 8, fromRun: 0, throughRun: 1 }, basePacketId: null, supersedes: null,
    policyVersion: "relay/1", language: "en", factsFingerprint: hex("f"), workspaceObservationSeq: null,
    inputs: { attachOverride: false, digestBehind: [], detailsMissing: [], noteIncluded: false, firstLineOmitted: null },
    redaction: { profile: "egress", count: 0, byClass: {}, overridden: 0, unscanned: 0 },
    body: { sha256: sha(body), bytes: Buffer.byteLength(body, "utf8"), estTokens: 12, estimator: "est/2", family: "o200k", untrustedTokens: 0, userTokens: 4 },
    budget: { capTokens: 8000, userCap: 2500, untrustedCap: 3000, window: 200_000, fixedPrefix: 0, windowSource: "assumed_cloud", clampedBy: [] },
    sections: [{ id: "words", author: "user", items: 1, estTokens: 4, dataClasses: ["user_text"] }],
    fold: fold.map(unit => typeof unit === "number" ? { kind: "unit", runIndex: unit, grade: "verbatim", why: "tail" } : unit), omissions: [], userEdits: [], ...extra });
}
function deliveryOf(run: string, packet: RelayPacket, extra: Readonly<Record<string, unknown>> = {}): DeliveryRecord {
  return parseDeliveryRecord({ runId: run, packetId: packet.id, channel: "single_text", position: { kind: "seq", before: 3 }, outcome: { kind: "in_flight" }, consentLogSeq: null, inputHmac: hex("c"),
    redaction: { rulesVersion: "egress/1", keyId: "key-1", setHmac: "0a1b2c3d" }, compactionAtDelivery: null, resendOf: null, attachOverride: false, verifyMs: null, realized: null, ...extra });
}
/** One transaction on `id` that changes nothing in its snapshot and writes `relay`. */
function write(store: SqliteSessionStore, id: SessionId, relay: RelayRows) {
  const current = store.get(id);
  return store.transact(id, current.version, state => ({ next: state, events: [{ type: "fixture.relay", data: {} }], relay }));
}
function outcomeOf(store: SqliteSessionStore, id: SessionId, run: string): DeliveryRecord["outcome"]["kind"] | undefined {
  return store.relayDeliveries(id).find(row => row.runId === run)?.outcome.kind;
}
const decided = (kind: "recorded" | "not_recorded" | "unknown", seq = 1) => kind === "recorded" ? { kind, evidence: "E3" as const, decidedSeq: seq, decidedAt: 30, verifiedInRun: null }
  : kind === "not_recorded" ? { kind, reason: "rejected_before_insert" as const, decidedSeq: seq, decidedAt: 30 } : { kind, reason: "no_evidence" as const, decidedSeq: seq, decidedAt: 30 };
function open(t: TestContext, options: ConstructorParameters<typeof SqliteSessionStore>[1] = {}): { readonly root: string; readonly workspace: string; readonly store: SqliteSessionStore } {
  const root = temporary(t), store = new SqliteSessionStore(join(root, "data"), options);
  t.after(() => { try { store.close(); } catch { /* a test that disabled the Store has asserted why */ } });
  return { root: join(root, "data"), workspace: root, store };
}

test("G066 a new business database is made at v13 with the 11 relay tables and 4 triggers of §14.1, verbatim", t => {
  const doc = readFileSync(join(repository, "docs/proposals/relay/relay-architecture.md"), "utf8");
  const block = doc.slice(doc.indexOf("### 14.1 v13 DDL")), written = block.slice(block.indexOf("```sql\n") + 7, block.indexOf("```", block.indexOf("```sql\n") + 7));
  // The permissive-defaults batch (2026-11-10) added two preference keys to relay_prefs' CHECK (relay.whenUnsure, relay.dataRootInWorkspace;
  // v13 is deployed to no data root, so the DDL itself changed). The design document is the main lead's to rewrite: until it lists them,
  // this one list is read as the batch changed it, and the rest of the DDL is still compared character for character.
  const four = "'relay.localModelsOffline')),", six = "'relay.localModelsOffline','relay.whenUnsure','relay.dataRootInWorkspace')),";
  const sql = written.includes("'relay.whenUnsure'") ? written : written.replace(four, six);
  assert.ok(sql.includes(six), "relay_prefs lists the six keys");
  assert.equal(RELAY_DDL.trim() + "\nPRAGMA user_version=13;", sql.trim(), "the DDL is the design's, character for character (relay_prefs' keys aside until the design lists the permissive-defaults batch's two)");
  const { root, store } = open(t); store.close();
  const db = raw(root);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 13);
    const names = (type: string) => db.prepare("SELECT name FROM sqlite_schema WHERE type=? AND name LIKE 'relay_%' ORDER BY name").all(type).map(row => String(row.name));
    assert.deepEqual(names("table"), [...RELAY_TABLES].sort()); assert.equal(names("trigger").length, 4);
    for (const table of RELAY_TABLES) assert.match(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)?.sql), /\)\s*STRICT$/u, table + " is STRICT");
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C01: the seven v12 fixtures
// ---------------------------------------------------------------------------------------------------------------------

/** Each fixture's bindings after the migration: Harness, status, epoch, floor, origin, and sync as kind:basis-or-cause@mark. */
const EXPECTED: Readonly<Record<V12FixtureName, readonly (readonly string[])[]>> = {
  "d1": [["alpha ready e1 f-1 suspect:legacy@14", "bravo ready e1 f-1 synced:legacy@39"]],
  "dispatch-failed": [["alpha ready e1 f-1 synced:legacy@14", "bravo ready e1 f-1 synced:legacy@39"]],
  "insert-rejected": [["alpha ready e1 f-1 suspect:legacy@14", "bravo ready e1 f-1 synced:legacy@39"]],
  "import": [["alpha ready e1 f-1 origin synced:origin@0"]],
  "branch": [["alpha ready e1 f-1 synced:legacy@14"], ["alpha ready e1 f-1 origin synced:origin@0"]],
  "clear": [["alpha ready e2 f35 fresh:user_cleared"]],
  "reset-d1": [["alpha archived e1 f-1 synced:legacy@25", "alpha ready e2 f-1 suspect:legacy@null"]],
};
function described(binding: NativeSessionBinding): string {
  const relay = binding.relay!, sync = relay.sync, mark = markOf(sync);
  const detail = sync.kind === "fresh" ? sync.basis : sync.kind === "suspect" ? sync.cause : sync.kind === "synced" ? sync.mark.basis : "pending";
  return [binding.harnessId, binding.status, "e" + relay.nativeEpoch, "f" + relay.epochFloor, ...(relay.originIncluded ? ["origin"] : []), sync.kind + ":" + detail + (sync.kind === "fresh" ? "" : "@" + (mark?.throughSeq ?? "null"))].join(" ");
}
/** The behind index rows of a Session, by Run. */
function indexes(db: DatabaseSync, id: string): ReadonlyMap<string, RelayBehindIndex & { readonly status: string }> {
  return new Map(db.prepare("SELECT run_id,status,policy_version,digest_json,index_json FROM relay_digests WHERE session_id=?").all(id).map(row => {
    assert.equal(row.status, "behind"); assert.equal(row.policy_version, "relay/0"); assert.equal(row.digest_json, "{}");
    return [String(row.run_id), JSON.parse(String(row.index_json)) as RelayBehindIndex & { readonly status: string }];
  }));
}
/**
 * What a migrated binding is owed, computed here independently of the migration from its index rows: finished
 * dispatched Turns that are no native commands and ran elsewhere than the binding's epoch, above max(mark, floor); and the
 * Session's starting history when the binding does not hold it and has no mark.
 */
function owed(state: SessionSnapshot, binding: NativeSessionBinding, rows: ReadonlyMap<string, RelayBehindIndex>, asOf = Number.MAX_SAFE_INTEGER): readonly string[] {
  const relay = binding.relay!, base = Math.max(markOf(relay.sync)?.throughSeq ?? -1, relay.epochFloor);
  const facts = [...rows.values()].filter(row => row.commandEffect === null && row.seq > base && row.seq <= asOf &&
    (row.executedOn === null || row.executedOn.harnessId !== binding.harnessId || row.executedOn.controlId !== binding.controlId || row.executedOn.nativeEpoch !== relay.nativeEpoch)).map(row => row.runId as string);
  return [...facts, ...(!relay.originIncluded && (state.origin?.history.length ?? 0) > 0 && base < 0 ? ["origin"] : [])];
}
function migrated(t: TestContext, fixtures: readonly V12Fixture[]): { readonly root: string; readonly store: SqliteSessionStore } {
  const root = join(temporary(t, "g066-v12-"), "data");
  writeV12Root(root, fixtures);
  const store = new SqliteSessionStore(root, { now: () => new Date("2026-11-09T12:00:00Z") });
  t.after(() => { try { store.close(); } catch { /* asserted by the test */ } });
  return { root, store };
}

for (const name of V12_FIXTURES) {
  test("G066-C01 the v12 fixture " + name + " migrates to v13: marks only go down, epochs grow along bindings, nothing owed is synced", t => {
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
          const relay = binding.relay!, mark = markOf(relay.sync), key = binding.harnessId + ":" + binding.controlId;
          // Epochs strictly grow along the bindings of one Harness control.
          assert.ok(relay.nativeEpoch > (lineage.get(key) ?? 0), "epoch of " + key); lineage.set(key, relay.nativeEpoch);
          // Only down: the mark never passes the v12 native position (its Run's fact seq), nor 0 without one.
          const position = binding.throughRunId === null ? 0 : rows.get(binding.throughRunId)!.seq;
          if (mark !== null) assert.ok(mark.throughSeq <= position, "mark " + mark.throughSeq + " ≤ v12 position " + position);
          // Nothing owed: synced, unless a confirmed clear left the binding fresh.
          const archivedAt = binding.status === "archived" ? row.events.find(event => event.type === "native.branch_requested")?.seq : undefined;
          if (owed(state, binding, rows, archivedAt).length === 0) assert.ok(relay.sync.kind === "synced" || relay.sync.kind === "fresh" && relay.sync.basis === "user_cleared", described(binding));
          else assert.notEqual(relay.sync.kind, "fresh", "an owing binding with history is synced or suspect");
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

test("G066-C01 epochs follow each Run where it ran: a clear and a native reset each start the next one", t => {
  const { root, store } = migrated(t, [loadV12Fixture("clear"), renamed(loadV12Fixture("reset-d1"), "reset")]);
  const db = raw(root);
  try {
    const epochs = (id: string) => [...indexes(db, id).values()].sort((a, b) => a.index - b.index).map(row => row.executedOn?.nativeEpoch + (row.commandEffect === null ? "" : ":" + row.commandEffect));
    assert.deepEqual(epochs("session-1"), ["1", "1", "1:clear", "2"]);
    assert.deepEqual(epochs("session-1-reset"), ["1", "1", "1", "2:compact"]);
    assert.equal(store.get(sessionId("session-1-reset")).nativeBindings?.[1]?.relay?.nativeEpoch, 2);
  } finally { db.close(); }
});

test("G066-C01 a failure in the middle of the migration rolls all of it back and keeps the backup", t => {
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

test("G066-C01 a migration killed with SIGKILL leaves a database at v12 or v13 with nothing half done, and the next start opens it", async t => {
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
      assert.equal(relayTables, version === 13 ? 11 : 0, "the relay tables exist exactly at v13");
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

test("G066-C03 a packet whose fold quotes an unfinished Turn or one accepted after the current input fails that Turn only", t => {
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
  assert.equal(committed.relay?.derived, "none"); assert.equal(outcomeOf(store, kept.id, kept.runs[2]!.id), "in_flight");
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C04: delivery transitions
// ---------------------------------------------------------------------------------------------------------------------

test("G066-C04 delivery rows move along §4's table: every allowed transition passes, every other one is refused before SQLite sees it", t => {
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
  const allowed: readonly (readonly ("recorded" | "not_recorded" | "unknown")[])[] = [["recorded"], ["not_recorded"], ["unknown"], ["unknown", "recorded"], ["unknown", "not_recorded"], ["unknown", "unknown"],
    ["not_recorded", "recorded"], ["recorded", "recorded"]];
  for (const [index, path] of allowed.entries()) { for (const kind of path) move(index, kind); assert.equal(outcomeOf(store, current.id, extra[index]!.id), path.at(-1), path.join(" → ")); }
  for (const [index, to] of [[0, "unknown"], [0, "not_recorded"], [1, "unknown"], [1, "not_recorded"], [6, "unknown"], [6, "not_recorded"]] as const)
    assert.throws(() => move(index, to), code("INVALID_TRANSITION"), "from " + outcomeOf(store, current.id, extra[index]!.id) + " to " + to);
  assert.throws(() => write(store, current.id, { deliveries: [{ kind: "outcome", runId: extra[8]!.id, outcome: { kind: "in_flight" } as never }] }), code("INVALID_TRANSITION"));
  store.assertOwner();
  // A same-value write leaves the outcome out of its statement: this guard, which refuses any change of outcome to itself, never fires.
  const db = raw(root);
  db.exec("CREATE TRIGGER fixture_same_outcome BEFORE UPDATE OF outcome ON relay_deliveries WHEN NEW.outcome=OLD.outcome BEGIN SELECT RAISE(ABORT,'same-value outcome in SET'); END");
  write(store, current.id, { deliveries: [{ kind: "outcome", runId: extra[5]!.id, outcome: { kind: "unknown", reason: "verify_timeout", decidedSeq: 2, decidedAt: 40 } }] });
  write(store, current.id, { deliveries: [{ kind: "outcome", runId: extra[3]!.id, outcome: { kind: "recorded", evidence: "E2", decidedSeq: 3, decidedAt: 41, verifiedInRun: extra[4]!.id } }] });
  assert.equal(store.relayDeliveries(current.id).find(row => row.runId === extra[5]!.id)?.outcome.kind, "unknown");
  db.exec("DROP TRIGGER fixture_same_outcome");
  // The trigger itself only asserts: it lets a same-value write through and refuses in_flight ← recorded.
  db.prepare("UPDATE relay_deliveries SET outcome='unknown' WHERE session_id=? AND run_id=?").run(current.id, extra[5]!.id);
  assert.throws(() => db.prepare("UPDATE relay_deliveries SET outcome='in_flight',evidence=NULL,reason=NULL,decided_seq=NULL WHERE session_id=? AND run_id=?").run(current.id, extra[0]!.id), /illegal delivery transition/u);
  assert.throws(() => db.prepare("UPDATE relay_deliveries SET outcome='unknown',evidence=NULL,reason='absent' WHERE session_id=? AND run_id=?").run(current.id, extra[0]!.id), /illegal delivery transition/u);
  db.close();
  store.assertOwner();
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C05: fault injection
// ---------------------------------------------------------------------------------------------------------------------

test("G066-C05 overlong pins, 20,000 files, a digest full of Chinese, identity clashes, a scanner error and same-value writes never disable the Store", t => {
  const { root, workspace, store } = open(t), target = seeded(store, workspace, "faults"), bystander = seeded(store, workspace, "bystander", { running: false });
  const three = target.runs[2]!;
  const bystanderStill = () => { const now = store.get(bystander.id); store.transact(bystander.id, now.version, state => ({ next: state, events: [{ type: "fixture.alive", data: {} }] })); };
  const message = target.messages.find(row => row.runId === target.runs[0]!.id && row.role === "user")!;
  const pin = (index: number, length = 4, offset = 0) => ({ kind: "add" as const, pin: { pinId: "pin-" + index, messageId: message.id, author: "user" as const, offset, length, quoteHmac: hex("d"), pinnedSeq: 2 } as never });
  // Pins: too long, too many, more bytes than all may hold, outside the message.
  assert.throws(() => write(store, target.id, { pins: [pin(1, 2049)] }), code("INVALID_DATA"));
  assert.throws(() => write(store, target.id, { pins: [pin(1, 8, 4)] }), code("INVALID_INPUT"));
  write(store, target.id, { pins: Array.from({ length: RELAY_PINS }, (_, index) => pin(index, 1)) });
  assert.throws(() => write(store, target.id, { pins: [pin(99, 1)] }), code("RELAY_PIN_LIMIT"));
  assert.throws(() => write(store, target.id, { pins: [pin(5, 1)] }), code("INVALID_INPUT"), "a pin identity taken");
  bystanderStill();
  // Derived rows that break their bounds, or whose producer throws (the scanner), roll back to their SAVEPOINT only.
  const files = Array.from({ length: 20_000 }, (_, index) => ({ path: "src/file-" + index + ".ts", change: "modified", added: 1, removed: 0, credentialPath: false, lfs: false }));
  const observation = { kind: "git", status: "complete", branch: "main", head: "a".repeat(40), fingerprint: hex("e"), durationMs: 75, files, counted: { total: 20_000, listed: 20_000 }, neutralized: [], attributesIncluded: false };
  const chinese = "这是一段被写满的中文摘要内容。".repeat(1600);
  const digest = (body: Readonly<Record<string, unknown>>, index: Readonly<Record<string, unknown>> = { runId: target.runs[0]!.id }) => ({ runId: target.runs[0]!.id, runIndex: 0, policyVersion: "relay/1" as const, status: "current" as const, secretSetHmac: "" as const, index, digest: body });
  for (const [label, derived] of [
    ["20,000 files", () => ({ workspace: [{ observedSeq: 2, runId: three.id, observation: observation as never }] })],
    ["a digest full of Chinese", () => ({ digests: [digest({ user: { head: chinese } })] })],
    ["an index full of Chinese", () => ({ digests: [digest({}, { line: chinese.slice(0, 800) })] })],
    ["a scanner error", () => { throw new Error("injected scanner failure"); }],
  ] as const) {
    const committed = write(store, target.id, { derived });
    assert.equal(committed.relay?.derived, "behind", label); assert.ok(committed.relay?.diagnostic, label);
  }
  // A statement of a derived row that SQLite refuses is contained the same way.
  const db = raw(root);
  db.exec("CREATE TRIGGER fixture_refuse_digest BEFORE INSERT ON relay_digests BEGIN SELECT RAISE(ABORT,'injected digest failure'); END");
  assert.equal(write(store, target.id, { derived: () => ({ digests: [digest({ ok: true })] }) }).relay?.derived, "behind");
  db.exec("DROP TRIGGER fixture_refuse_digest");
  assert.equal(write(store, target.id, { derived: () => ({ digests: [digest({ ok: true })] }) }).relay?.derived, "written");
  assert.equal(count(db, "relay_digests", "session_id='session-faults'"), 1); assert.equal(count(db, "relay_workspace"), 0);
  db.close();
  // Identity clashes: one packet identity with two texts, a second delivery for one Turn.
  const packet = packetOf("first text", [0]);
  write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
  const clash = parseRelayPacket({ ...packet, body: { ...packet.body, sha256: sha("other text"), bytes: Buffer.byteLength("other text") } });
  assert.throws(() => write(store, target.id, { packets: [{ runId: three.id, packet: clash, body: "other text" }] }), reason("render_mismatch"));
  assert.throws(() => write(store, target.id, { deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] }), reason("storage"));
  assert.throws(() => write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text but longer" }] }), reason("render"), "a text that is not its manifest's");
  // The same text sent again by the same packet identity is kept once (ON CONFLICT DO NOTHING).
  write(store, target.id, { packets: [{ runId: three.id, packet, body: "first text" }] });
  // Same-value writes.
  write(store, target.id, { deliveries: [{ kind: "outcome", runId: three.id, outcome: decided("unknown") }] });
  write(store, target.id, { deliveries: [{ kind: "outcome", runId: three.id, outcome: { kind: "unknown", reason: "late_delivery", decidedSeq: 9, decidedAt: 50 } }] });
  bystanderStill(); store.assertOwner();
  const check = raw(root);
  try { assert.equal(count(check, "relay_packets", "session_id='session-faults'"), 1); assert.equal(count(check, "relay_bodies", "session_id='session-faults'"), 1); assert.equal(count(check, "relay_pins", "session_id='session-faults'"), RELAY_PINS); }
  finally { check.close(); }
});

test("G066 a relay state that names a packet the conversation does not keep is refused with the transaction", t => {
  const { workspace, store } = open(t), state = seeded(store, workspace, "references");
  const binding = state.nativeBindings![0]!, missing = packetOf("never written", [0]);
  const pending: BindingRelayState = { ...binding.relay!, sync: { kind: "pending", prior: binding.relay!.sync as never, packetId: missing.id, range: { fromSeq: 0, throughSeq: 3, fromRun: 0, throughRun: 1 }, autoResends: 0, manualResends: 0, attachOverride: false } };
  const move = (relay?: RelayRows) => store.transact(state.id, store.get(state.id).version, now => ({ next: { ...now, nativeBindings: [{ ...binding, relay: pending }] }, events: [{ type: "fixture.pending", data: {} }], ...(relay === undefined ? {} : { relay }) }));
  assert.throws(() => move(), code("INVALID_DATA"));
  move({ packets: [{ runId: state.runs[2]!.id, packet: missing, body: "never written" }], deliveries: [{ kind: "insert", record: deliveryOf(state.runs[2]!.id, missing) }] });
  assert.equal(store.get(state.id).nativeBindings?.[0]?.relay?.sync.kind, "pending");
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C07: relayWrite
// ---------------------------------------------------------------------------------------------------------------------

test("G066-C07 relayWrite keeps derived rows without moving the version, never overwrites what a transaction wrote, and a failure only waits for next time", t => {
  const { root, workspace, store } = open(t), state = seeded(store, workspace, "background");
  const three = state.runs[2]!, packet = packetOf("background packet", [0]);
  write(store, state.id, { packets: [{ runId: three.id, packet, body: "background packet" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }] });
  const before = store.get(state.id);
  const rebuilt = (index: number, status: "current" | "behind", note: string) => ({ runId: before.runs[index]!.id, runIndex: index, policyVersion: "relay/1" as const, status, secretSetHmac: redactionTag("a1b2c3d4"), index: { note }, digest: { note } });
  assert.deepEqual(store.relayWrite(state.id, { digests: [rebuilt(0, "current", "lazy one")], realized: [{ runId: three.id, realized: { requests: 3, cacheHits: 2, closedBy: "idle" } }] }), { written: true });
  assert.equal(store.get(state.id).version, before.version, "no version moved");
  // A transaction prepared on the version before relayWrite still commits: nothing conflicted.
  const after = store.transact(state.id, before.version, now => ({ next: now, events: [{ type: "fixture.after", data: {} }], relay: { deliveries: [{ kind: "outcome", runId: three.id, outcome: decided("recorded", before.lastSeq + 1) }],
    derived: () => ({ digests: [rebuilt(1, "current", "from run.ended")] }) } }));
  assert.equal(after.session.version, before.version + 1); assert.equal(after.relay?.derived, "written");
  // relayWrite does not overwrite the transaction's current row, nor realized counts already settled, nor the outcome.
  assert.deepEqual(store.relayWrite(state.id, { digests: [rebuilt(1, "behind", "stale rebuild")], realized: [{ runId: three.id, realized: { requests: 9, cacheHits: 9, closedBy: "clear" } }] }), { written: true });
  const db = raw(root);
  try {
    const notes = db.prepare("SELECT run_id,status,index_json FROM relay_digests WHERE session_id=? ORDER BY run_index").all(state.id).map(row => [row.status, JSON.parse(String(row.index_json)).note]);
    assert.deepEqual(notes, [["current", "lazy one"], ["current", "from run.ended"]]);
    const delivery = store.relayDeliveries(state.id).find(row => row.runId === three.id)!;
    assert.equal(delivery.outcome.kind, "recorded"); assert.deepEqual(delivery.realized, { requests: 3, cacheHits: 2, closedBy: "idle" });
    // A newer policy's row replaces the Run's older ones in the same transaction.
    store.relayWrite(state.id, { digests: [{ ...rebuilt(0, "current", "policy two"), policyVersion: "relay/2" }] });
    assert.deepEqual(db.prepare("SELECT policy_version FROM relay_digests WHERE session_id=? AND run_id=?").all(state.id, before.runs[0]!.id).map(row => row.policy_version), ["relay/2"]);
    // A statement SQLite refuses is a diagnostic; the Store goes on and the next attempt writes.
    db.exec("CREATE TRIGGER fixture_refuse_rebuild BEFORE INSERT ON relay_digests BEGIN SELECT RAISE(ABORT,'injected rebuild failure'); END");
    const failed = store.relayWrite(state.id, { digests: [rebuilt(0, "current", "after the failure")] });
    assert.equal(failed.written, false); assert.match(store.relayDiagnostics().at(-1) ?? "", /constraint|abort|injected/iu);
    store.assertOwner(); store.transact(state.id, store.get(state.id).version, now => ({ next: now, events: [{ type: "fixture.still", data: {} }] }));
    db.exec("DROP TRIGGER fixture_refuse_rebuild");
    assert.deepEqual(store.relayWrite(state.id, { digests: [rebuilt(0, "current", "after the failure")] }), { written: true });
  } finally { db.close(); }
  // Invalid rows are the caller's bug and throw.
  assert.throws(() => store.relayWrite(state.id, { digests: [{ ...rebuilt(0, "current", "x"), runIndex: 7 }] }), code("INVALID_DATA"));
  assert.throws(() => store.relayWrite(state.id, { realized: [{ runId: state.runs[0]!.id, realized: { requests: 1, cacheHits: 0, closedBy: "idle" } }] }), code("INVALID_DATA"));
});

// ---------------------------------------------------------------------------------------------------------------------
// G066-C09: the consent log and preferences
// ---------------------------------------------------------------------------------------------------------------------

test("G066-C09 at 65,536 rows the consent log rotates in the appending transaction, and when it stays full the append is refused", t => {
  const { root, store } = open(t, { now: () => new Date("2026-11-09T12:00:00Z") });
  const consent = (commandId: string, vendor = "openai", sessionId = "session-a") => ({ commandId, vendor: vendor as never, scope: { kind: "session" as const, sessionId: sessionId as SessionId },
    decision: "acknowledged" as const, categories: ["user_text" as const], policyVersion: "relay/1" as const, authKind: null, decidedAt: 1 });
  const first = store.appendRelayLog(consent("consent-1"));
  assert.deepEqual(store.appendRelayLog(consent("consent-1")), first, "the same command returns its record");
  assert.throws(() => store.appendRelayLog({ ...consent("consent-1"), decision: "goal_only" }), code("IDEMPOTENCY_CONFLICT"));
  // Fill the log with rows of three keys, then append: rotation keeps the latest row of each key.
  const fill = (rows: number, key: (index: number) => readonly [string, string]) => {
    const db = raw(root); db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO relay_log(command_id,kind,vendor,scope,session_id,decision,categories_json,policy_version,auth_kind,decided_at) VALUES(?,'consent',?,'session',?,'acknowledged','[\"user_text\"]','relay/1',NULL,2)");
    for (let index = 0; index < rows; index++) { const [vendor, session] = key(index); insert.run("fill-" + index + "-" + Math.random().toString(36).slice(2, 8), vendor, session); }
    db.exec("COMMIT"); db.close();
  };
  fill(RELAY_LOG_ROWS - 1, index => [["openai", "anthropic", "deepseek"][index % 3]!, "session-a"]);
  const rotated = store.appendRelayLog(consent("consent-rotate", "google"));
  const db = raw(root);
  try {
    assert.equal(count(db, "relay_log"), 4, "the latest row of each of three keys, and the new one");
    assert.equal(count(db, "relay_log_archive"), RELAY_LOG_ROWS - 3); assert.equal(count(db, "relay_log_archive", "archived_at=" + Date.parse("2026-11-09T12:00:00Z")), RELAY_LOG_ROWS - 3);
    assert.ok(rotated.logSeq > RELAY_LOG_ROWS, "seqs keep growing past rotation");
    assert.deepEqual(store.relayConsents().map(row => row.vendor).sort(), ["anthropic", "deepseek", "google", "openai"]);
    assert.deepEqual(store.appendRelayLog(consent("consent-1")), first, "a command rotated into the archive still returns its record");
  } finally { db.close(); }
  // A log of distinct keys stays full after rotation: the append is refused and writes nothing.
  fill(RELAY_LOG_ROWS - 4, index => ["openai", "session-distinct-" + index]);
  assert.throws(() => store.appendRelayLog(consent("consent-full", "openai", "session-new")), (error: unknown) => error instanceof RelayError && error.code === "RELAY_UNAVAILABLE" && error.reason === "consent_log_full");
  const full = raw(root);
  try { assert.equal(count(full, "relay_log"), RELAY_LOG_ROWS); assert.equal(count(full, "relay_log", "command_id='consent-full'"), 0); } finally { full.close(); }
  store.assertOwner();
});

test("G066-C09 an archive at its bound refuses the rotation that would pass it, and the log keeps every row", t => {
  const { root, store } = open(t);
  const db = raw(root); db.exec("BEGIN");
  const archive = db.prepare("INSERT INTO relay_log_archive(seq,command_id,kind,vendor,scope,session_id,decision,categories_json,policy_version,auth_kind,decided_at,archived_at) VALUES(?,?,'consent','openai','global','','acknowledged','[]','relay/1',NULL,1,1)");
  for (let index = 1; index <= RELAY_LOG_ARCHIVE_ROWS - 2; index++) archive.run(index, "archived-" + index);
  const log = db.prepare("INSERT INTO relay_log(seq,command_id,kind,vendor,scope,session_id,decision,categories_json,policy_version,auth_kind,decided_at) VALUES(?,?,'consent','openai','global','','acknowledged','[]','relay/1',NULL,2)");
  for (let index = 0; index < RELAY_LOG_ROWS; index++) log.run(RELAY_LOG_ARCHIVE_ROWS + index, "logged-" + index);
  db.exec("COMMIT"); db.close();
  assert.throws(() => store.appendRelayLog({ commandId: "consent-late", vendor: "openai", scope: { kind: "global" }, decision: "revoked", categories: [], policyVersion: "relay/1", authKind: null, decidedAt: 3 }),
    (error: unknown) => error instanceof RelayError && error.reason === "consent_log_full");
  const after = raw(root);
  try { assert.equal(count(after, "relay_log"), RELAY_LOG_ROWS); assert.equal(count(after, "relay_log_archive"), RELAY_LOG_ARCHIVE_ROWS - 2); } finally { after.close(); }
});

test("G066-C09 relay_prefs takes the four keys with their values of at most 64 bytes, and the last writer wins", t => {
  const { root, store } = open(t);
  store.setPref("relay.crossVendor", "ask"); store.setPref("relay.crossVendor", "goal_only"); store.setPref("relay.returnPreference", "new_when_cold");
  store.setPref("relay.allowUnprobed", "true"); store.setPref("relay.localModelsOffline", "false");
  assert.deepEqual(store.relayPrefs(), { "relay.allowUnprobed": "true", "relay.crossVendor": "goal_only", "relay.localModelsOffline": "false", "relay.returnPreference": "new_when_cold" });
  for (const [key, value] of [["relay.elsewhere", "x"], ["relay.crossVendor", "always"], ["relay.allowUnprobed", "yes"], ["relay.returnPreference", "x".repeat(65)]] as const)
    assert.throws(() => store.setPref(key as never, value), code("INVALID_DATA"), key + "=" + value);
  const db = raw(root);
  try {
    assert.throws(() => db.prepare("INSERT INTO relay_prefs(key,value,updated_at) VALUES('relay.elsewhere','x',1)").run(), /CHECK constraint/u, "the table's own check is the assertion behind it");
    assert.throws(() => db.prepare("INSERT INTO relay_prefs(key,value,updated_at) VALUES('relay.allowUnprobed',?,1)").run("x".repeat(65)), /CHECK constraint/u);
  } finally { db.close(); }
  store.assertOwner();
});

// ---------------------------------------------------------------------------------------------------------------------
// Recovery, deletion, windows and the content references of relay rows
// ---------------------------------------------------------------------------------------------------------------------

test("G066 claimAndRecover runs the relay recovery of each Session in a SAVEPOINT of its own: one Session's failure marks only that Session", t => {
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
    assert.deepEqual(recovered(kept.id), { failed: false, deliveries: [{ runId: kept.runs[2]!.id, outcome: "unknown" }], bindings: [{ harnessId: "alpha", controlId: "alpha-acp", sync: "fresh" }] });
    assert.deepEqual(recovered(failing.id), { failed: true });
  } finally { store.close(); }
  // Without a relay recovery (G068 provides it) recovery is what it was: its event has no relay part.
  const again = join(temporary(t), "data"), plain = new SqliteSessionStore(again); seeded(plain, join(again, ".."), "plain"); plain.close();
  const reopened = new SqliteSessionStore(again);
  try { const state = reopened.get(sessionId("session-plain")); assert.equal(reopened.events(state.id, state.lastSeq - 1)[0]?.data.relay, undefined); assert.equal(state.relayRecoveryFailed, undefined); }
  finally { reopened.close(); }
});

test("G066 deleteSession removes a closed conversation with every relay row in one transaction, and leaves the others", t => {
  const { root, workspace, store } = open(t), gone = seeded(store, workspace, "gone"), other = seeded(store, workspace, "other");
  for (const state of [gone, other]) {
    const three = state.runs[2]!, packet = packetOf("rows of " + state.id, [0]);
    write(store, state.id, { packets: [{ runId: three.id, packet, body: "rows of " + state.id }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet) }],
      pins: [{ kind: "add", pin: { pinId: "pin-1", messageId: state.messages[0]!.id, author: "user", offset: 0, length: 2, quoteHmac: hex("d"), pinnedSeq: 2 } as never }],
      exclusions: [{ kind: "add", exclusion: { exclusionId: "exclusion-1", kind: "run", ref: state.runs[0]!.id, addedSeq: 2 } as never }],
      derived: () => ({ digests: [{ runId: state.runs[0]!.id, runIndex: 0, policyVersion: "relay/1", status: "current", secretSetHmac: "", index: {}, digest: {} }],
        workspace: [{ observedSeq: 2, runId: three.id, observation: { kind: "unavailable" as const, reason: "timeout" as const } }] }) });
  }
  assert.throws(() => store.deleteSession(gone.id), code("SESSION_BUSY"), "an open conversation stays");
  const now = store.get(gone.id);
  store.transact(gone.id, now.version, state => ({ next: { ...state, status: "closed", activeRunId: null, runs: state.runs.map(row => row.status === "running" ? { ...row, status: "failed" as const, cleanup: clean, backend: { status: "failed" as const, reason: "closed" } } : row),
    messages: state.messages.map(message => message.status === "running" ? { ...message, status: "failed" as const } : message) }, events: [{ type: "session.closed", data: {} }] }));
  store.deleteSession(gone.id);
  assert.throws(() => store.get(gone.id), code("SESSION_NOT_FOUND"));
  const db = raw(root);
  try {
    for (const table of ["relay_bodies", "relay_packets", "relay_deliveries", "relay_digests", "relay_workspace", "relay_pins", "relay_exclusions", "events"]) {
      assert.equal(count(db, table, "session_id='session-gone'"), 0, table); assert.ok(count(db, table, "session_id='session-other'") > 0, table + " of the other one");
    }
    assert.equal(count(db, "create_keys", "session_id='session-gone'"), 0); assert.equal(count(db, "sessions"), 1);
  } finally { db.close(); }
  assert.equal(store.get(other.id).id, other.id);
});

test("G066 observed windows are kept per Harness control and model, the last writer wins, and a start forgets those older than 30 days", t => {
  let now = Date.parse("2026-11-09T00:00:00Z");
  const root = join(temporary(t), "data"), store = new SqliteSessionStore(root, { now: () => new Date(now) });
  store.upsertWindow({ harnessId: "alpha", controlId: "alpha-acp", modelKey: "", size: 128_000, firstTurnUsed: null, observedAt: now });
  store.upsertWindow({ harnessId: "alpha", controlId: "alpha-acp", modelKey: "", size: 200_000, firstTurnUsed: 9000, observedAt: now });
  store.upsertWindow({ harnessId: "alpha", controlId: "alpha-acp", modelKey: "opus", size: 1_000_000, firstTurnUsed: null, observedAt: now - RELAY_WINDOW_RETENTION_MS - 1 });
  assert.throws(() => store.upsertWindow({ harnessId: "alpha", controlId: "alpha-acp", modelKey: "", size: 0, firstTurnUsed: null, observedAt: now }), code("INVALID_DATA"));
  store.close();
  now += 1;
  new SqliteSessionStore(root, { now: () => new Date(now) }).close();
  const db = raw(root);
  try { assert.deepEqual(db.prepare("SELECT model_key,size,first_turn_used FROM relay_windows").all().map(row => ({ ...row })), [{ model_key: "", size: 200_000, first_turn_used: 9000 }]); } finally { db.close(); }
});

test("G066 no relay row holds an object shaped like a ContentRef: relay rows keep positions, counts and fingerprints, never content references", t => {
  const { root, workspace, store } = open(t), state = seeded(store, workspace, "content");
  const three = state.runs[2]!, packet = packetOf("content-store.ts is named in the text, which is fine", [0, 1]);
  write(store, state.id, { packets: [{ runId: three.id, packet, body: "content-store.ts is named in the text, which is fine" }], deliveries: [{ kind: "insert", record: deliveryOf(three.id, packet, { position: { kind: "file_offset", path: "/fixtures/transcript.jsonl", bytes: 10 } }) }],
    pins: [{ kind: "add", pin: { pinId: "pin-1", messageId: state.messages[0]!.id, author: "user", offset: 0, length: 2, quoteHmac: hex("d"), pinnedSeq: 2 } as never }],
    derived: () => ({ digests: [{ runId: state.runs[0]!.id, runIndex: 0, policyVersion: "relay/1", status: "current", secretSetHmac: "", index: { runId: state.runs[0]!.id, files: 2 }, digest: { user: { attachments: [{ name: "a.png", mediaType: "image/png", bytes: 8 }] } } }],
      workspace: [{ observedSeq: 2, runId: three.id, observation: parseWorkspaceObservation({ kind: "tree", status: "complete", fingerprint: hex("e"), durationMs: 3, files: [{ path: "src/a.ts", size: 3, mtimeMs: 1 }], scanned: 1, counted: 1 }) }] }) });
  store.appendRelayLog({ commandId: "consent-content", vendor: "anthropic", scope: { kind: "global" }, decision: "acknowledged", categories: ["user_text"], policyVersion: "relay/1", authKind: "account", decidedAt: 1 });
  const db = raw(root);
  try {
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
    for (const [table, columns] of [["relay_packets", ["manifest_json"]], ["relay_deliveries", ["position_json"]], ["relay_digests", ["index_json", "digest_json"]], ["relay_workspace", ["files_json"]], ["relay_log", ["categories_json"]]] as const)
      for (const row of db.prepare("SELECT " + columns.join(",") + " FROM " + table).all()) for (const column of columns) visit(JSON.parse(String(row[column])), table + "." + column);
    assert.ok(objects >= 10, "the scan read the rows: " + objects + " objects");
  } finally { db.close(); }
});
