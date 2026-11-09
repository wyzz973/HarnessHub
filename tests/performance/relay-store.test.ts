import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { CleanupEvidence } from "../../src/contracts/control.js";
import {
  EMPTY_CHAIN, MAX_BINDING_RELAY_BYTES, MAX_RUN_RELAY_BYTES, RELAY_MAX_SEQ, parseBindingRelayState, parseDeliveryRecord, parseRelayPacket, parseRunRelay, parseRunRelayRequest,
  type RelayPacket, type RelayRows,
} from "../../src/contracts/relay.js";
import { commandId, messageId, runId, sessionId, type NativeSessionBinding, type PublicRun, type SessionSnapshot } from "../../src/contracts/session.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/migrate.js";
import { MAX_EVENT_LOG_BYTES, MAX_SESSION_EVENTS } from "../../src/contexts/session/domain/state.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { V12_DDL, loadV12Fixture, renamed } from "../fixtures/relay/v12/database.js";

// G066 (ADR-055 §0, §11.1, §14.4): the snapshot bytes the relay adds (G066-C08, run by default), and the v12 → v13
// migration of a business database of at least 1 GiB of events, timed only when G066_MIGRATION_GIB is set (a reference
// measurement whose result goes into the verification record, like G075_SESSIONS). Synthetic data in os.tmpdir() only.

const hex = (char: string) => char.repeat(64);
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function packetFor(seed: string, harnessId: string, controlId: string): { readonly packet: RelayPacket; readonly body: string } {
  const body = "packet " + seed, id = "relay-" + Array.from(createHash("sha256").update(seed).digest().subarray(0, 20), byte => CROCKFORD[byte % 32]).join("");
  return { body, packet: parseRelayPacket({ id, kind: "packet", tier: "standard", complete: true, reanchor: false, target: { harnessId, controlId, model: null, vendor: "local", nativeEpoch: 1 },
    source: { kind: "other", names: [] }, range: { fromSeq: 0, throughSeq: 1, fromRun: 0, throughRun: 0 }, basePacketId: null, supersedes: null, policyVersion: "relay/1", language: "en",
    factsFingerprint: hex("f"), workspaceObservationSeq: null, inputs: { attachOverride: false, digestBehind: [], detailsMissing: [], noteIncluded: false, firstLineOmitted: null },
    redaction: { profile: "egress", count: 0, byClass: {}, overridden: 0, unscanned: 0 },
    body: { sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body), estTokens: 3, estimator: "est/2", family: "o200k", untrustedTokens: 0, userTokens: 0 },
    budget: { capTokens: 8000, userCap: 2500, untrustedCap: 3000, window: 128_000, fixedPrefix: 0, windowSource: "assumed_cloud", clampedBy: [] }, sections: [], fold: [], omissions: [], userEdits: [] }) };
}

test("G066-C08 the longest legal relay state of a binding and of a Run, committed through the Store, grows the snapshot by at most its bound", t => {
  const root = mkdtempSync(join(tmpdir(), "g066-bytes-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteSessionStore(join(root, "data"));
  try {
    // The longest catalog identities a selection takes (96 bytes), so a Run's executedOn is as long as it can be.
    const harnessId = "a" + "b".repeat(95), controlId = "c" + "d".repeat(95), selection = { harnessId, controlId }, id = sessionId("session-bytes");
    let state = store.create({ schemaVersion: 13, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
      configuration: { workspace: root, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true }, selection,
      activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: commandId("create"), kind: "create", fingerprint: hex("a"), resultId: id }] }, [{ type: "session.created", data: {} }]).session;
    const request = parseRunRelayRequest({ tier: "fidelity", attach: "full", native: "continue", resend: true, fingerprint: hex("9") });
    const make = (suffix: string, status: PublicRun["status"], extra: Partial<PublicRun> = {}): PublicRun => ({ id: runId("run-" + suffix), commandId: commandId("send-" + suffix), input: "input " + suffix,
      userMessageId: messageId("message-" + suffix + "-user"), assistantMessageId: messageId("message-" + suffix + "-reply"), selection, epoch: 1, status, cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [],
      backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null, timing: { acceptedAt: 10 }, ...extra });
    // Run one settles the binding; Run two is accepted with the longest relay request.
    const step = (mutate: (current: SessionSnapshot) => SessionSnapshot, relay?: RelayRows) => {
      state = store.transact(id, state.version, current => ({ next: mutate(current), events: [{ type: "fixture.step", data: {} }], ...(relay === undefined ? {} : { relay }) })).session;
    };
    const binding: NativeSessionBinding = { harnessId, controlId, checkpoint: "native-bytes", throughRunId: null, status: "unconfirmed", relay: initialBindingRelay([], harnessId, controlId, "new") };
    step(current => ({ ...current, activeRunId: runId("run-one"), nativeBindings: [binding], runs: [make("one", "running", { timing: { acceptedAt: 10, preparingAt: 11, readyAt: 12, dispatchedAt: 13 } })],
      messages: [{ id: messageId("message-one-user"), runId: runId("run-one"), role: "user", text: "input one", seq: 2, status: "running" }], commands: [...current.commands, { id: commandId("send-one"), kind: "send", fingerprint: hex("b"), resultId: runId("run-one") }] }));
    // The packets the longest sync state names, kept for the Session as the Store requires.
    const packets = ["a", "b", "c", "d"].map(char => packetFor(char, harnessId, controlId));
    step(current => current, { packets: packets.map(row => ({ runId: runId("run-one"), packet: row.packet, body: row.body })) });
    const mark = (index: number) => ({ throughSeq: RELAY_MAX_SEQ, chain: EMPTY_CHAIN, lastPacketId: packets[index]!.packet.id, evidence: "legacy", basis: "evidence" });
    const range = { fromSeq: RELAY_MAX_SEQ, throughSeq: RELAY_MAX_SEQ, fromRun: 255, throughRun: 255 };
    const longest = parseBindingRelayState({ nativeEpoch: RELAY_MAX_SEQ + 1, epochFloor: RELAY_MAX_SEQ, packetsInEpoch: 256, reanchor: false, originIncluded: false,
      // Since G068 the longest sync is a suspect state of the longest cause carrying a packet (a pending sync's prior carries none).
      sync: { kind: "suspect", mark: mark(2), cause: "clear_unconfirmed", floorCandidate: RELAY_MAX_SEQ,
        carried: { prior: { kind: "suspect", mark: mark(0), cause: "clear_unconfirmed", floorCandidate: RELAY_MAX_SEQ, carried: null, rewound: false }, packetId: packets[1]!.packet.id, range }, rewound: false },
      compactionSeen: { count: 2_147_483_647, digest: hex("e") }, consentKey: "gateway:" + "h".repeat(253),
      vendorObserved: { model: "m".repeat(96), modelKey: "k".repeat(96), authKind: "a".repeat(16), endpoint: { host: "h".repeat(253), layer: "harness_default" }, loopback: false },
      cache: { lastRequestStartedAt: 8.64e15, contextUsed: 2_147_483_647, contextSize: 2_147_483_647 } });
    const bytesOf = () => Number(new DatabaseSync(join(root, "data", "gateway.sqlite"), { readOnly: true }).prepare("SELECT octet_length(snapshot) AS bytes FROM sessions WHERE id=?").get(id)?.bytes);
    const before = bytesOf();
    step(current => ({ ...current, nativeBindings: [{ ...current.nativeBindings![0]!, relay: longest }] }));
    const bindingGrowth = bytesOf() - before, relayBytes = Buffer.byteLength(JSON.stringify(state.nativeBindings![0]!.relay));
    assert.equal(bindingGrowth, relayBytes - Buffer.byteLength(JSON.stringify(binding.relay)), "the snapshot grew by the relay state's own bytes");
    assert.ok(relayBytes <= MAX_BINDING_RELAY_BYTES, "binding relay " + relayBytes + " B");
    // Run one settles; Run two is accepted with the longest request and starts with the longest Run relay.
    step(current => ({ ...current, activeRunId: null, nativeBindings: [{ ...current.nativeBindings![0]!, status: "ready", throughRunId: runId("run-one") }],
      runs: current.runs.map(row => ({ ...row, status: "completed" as const, backend: { status: "completed" as const, reason: "fixture" }, cleanup: clean, timing: { ...row.timing!, endedAt: 20 } })),
      messages: current.messages.map(message => ({ ...message, status: "completed" as const })) }));
    const accepted = make("two", "queued", { relayRequest: request });
    step(current => ({ ...current, runs: [...current.runs, accepted], messages: [...current.messages, { id: accepted.userMessageId, runId: accepted.id, role: "user", text: accepted.input, seq: current.lastSeq + 1, status: "queued" }],
      commands: [...current.commands, { id: accepted.commandId, kind: "send", fingerprint: hex("b"), resultId: accepted.id }] }));
    const queued = bytesOf();
    const runRelay = parseRunRelay({ packetId: packets[3]!.packet.id, kind: "resend", continuity: { kind: "native_resume_delta", tier: "fidelity", runs: 256 }, executedOn: { harnessId, controlId, nativeEpoch: RELAY_MAX_SEQ + 1 } });
    step(current => ({ ...current, activeRunId: accepted.id, runs: current.runs.map(row => row.id === accepted.id ? { ...row, status: "running" as const, contextThroughSeq: current.lastSeq, relay: runRelay,
      timing: { acceptedAt: 10, preparingAt: 8.64e15 - 4, contextReadyAt: 8.64e15 - 3, readyAt: 8.64e15 - 2, dispatchedAt: 8.64e15 - 1, recordedAt: 8.64e15 } } : row),
      messages: current.messages.map(message => message.runId === accepted.id ? { ...message, status: "running" as const } : message) }));
    const runBytes = Buffer.byteLength(JSON.stringify({ relay: state.runs[1]!.relay, relayRequest: state.runs[1]!.relayRequest }));
    assert.ok(runBytes <= MAX_RUN_RELAY_BYTES, "Run relay " + runBytes + " B");
    const runGrowth = Buffer.byteLength(JSON.stringify(state.runs[1])) - Buffer.byteLength(JSON.stringify((({ relay: _relay, relayRequest: _request, ...rest }) => ({ ...rest, timing: { acceptedAt: rest.timing!.acceptedAt, preparingAt: rest.timing!.preparingAt, readyAt: rest.timing!.readyAt, dispatchedAt: rest.timing!.dispatchedAt } }))(state.runs[1]!)));
    t.diagnostic("binding relay " + relayBytes + " B (bound " + MAX_BINDING_RELAY_BYTES + ", design target 1,024); Run relay fields " + runBytes + " B (bound " + MAX_RUN_RELAY_BYTES + ", design target 320); " +
      "a Run's snapshot growth with contextReadyAt and recordedAt " + runGrowth + " B; snapshot " + queued + " → " + bytesOf() + " B");
    // The delivery the longest Run sends is kept with it (a pending sync's packet).
    step(current => current, { deliveries: [{ kind: "insert", record: parseDeliveryRecord({ runId: accepted.id, packetId: packets[3]!.packet.id, channel: "text_block", position: { kind: "none" }, outcome: { kind: "in_flight" },
      consentLogSeq: null, inputHmac: hex("8"), redaction: { rulesVersion: "egress/1", keyId: "key", setHmac: "01234567" }, compactionAtDelivery: null, resendOf: null, attachOverride: false, verifyMs: null, realized: null }) }] });
  } finally { store.close(); }
});

/** G066_MIGRATION_GIB: the GiB of events of the reference measurement (1–8); unset skips it. */
function gibibytes(): number | null {
  const raw = process.env.G066_MIGRATION_GIB;
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new Error("G066_MIGRATION_GIB must be a whole number of GiB from 1 to 8");
  return value;
}
function size(path: string): number { try { return statSync(path).size; } catch { return 0; } }

test("G066 reference: migrating a v12 business database of at least 1 GiB of events to v13 (G066_MIGRATION_GIB)", { skip: gibibytes() === null ? "set G066_MIGRATION_GIB=1 to run the reference measurement" : false }, t => {
  const target = gibibytes()! * 1024 ** 3, folder = mkdtempSync(join(tmpdir(), "g066-gib-")), data = join(folder, "data");
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // Each conversation: the D1 fixture (its bindings, carried and native Turns, a command), then streamed reply text up to
  // nearly its event and log budgets, the bulk of a long conversation's events, which the migration skips in SQLite.
  const base = loadV12Fixture("d1"), padding = "x".repeat(1800);
  const perEvent = Buffer.byteLength(JSON.stringify({ type: "run.output", data: { runId: "run-16", event: { type: "text", text: padding } }, sessionId: "session-1-gib-0000", seq: 16384, ownerGeneration: base.ownerGeneration, timestamp: "2026-11-09T00:00:00.000Z" }));
  const baseBytes = base.sessions[0]!.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)) + 32, 0);
  const extra = Math.min(MAX_SESSION_EVENTS - base.sessions[0]!.events.length, Math.floor((MAX_EVENT_LOG_BYTES - baseBytes - 64 * 1024) / perEvent));
  const sessions = Math.ceil(target / (baseBytes + extra * perEvent));
  const started = performance.now();
  {
    mkdirSync(data, { mode: 0o700 }); writeFileSync(join(data, ".harness-gateway.json"), JSON.stringify({ application: "harness-gateway", schemaVersion: 1 }) + "\n", { mode: 0o600 });
    const db = new DatabaseSync(join(data, "gateway.sqlite"));
    db.exec("PRAGMA journal_mode=WAL"); db.exec(V12_DDL); db.prepare("INSERT INTO owner_metadata VALUES(1,?,0,'',0)").run(base.ownerGeneration);
    const session = db.prepare("INSERT INTO sessions(id,version,last_seq,snapshot) VALUES(?,?,?,?)"), key = db.prepare("INSERT INTO create_keys(command_id,session_id,fingerprint) VALUES(?,?,?)");
    const event = db.prepare("INSERT INTO events(session_id,seq,owner_generation,event_json) VALUES(?,?,?,?)");
    for (let index = 0; index < sessions; index++) {
      const copy = renamed(base, "gib-" + String(index).padStart(4, "0")), row = copy.sessions[0]!, last = row.events.length + extra;
      db.exec("BEGIN");
      session.run(row.id, last, last, JSON.stringify({ ...row.snapshot, version: last, lastSeq: last }));
      for (const item of row.events) event.run(row.id, item.seq, item.ownerGeneration, JSON.stringify(item));
      for (let seq = row.events.length + 1; seq <= last; seq++)
        event.run(row.id, seq, base.ownerGeneration, JSON.stringify({ type: "run.output", data: { runId: "run-16", event: { type: "text", text: padding } }, sessionId: row.id, seq, ownerGeneration: base.ownerGeneration, timestamp: "2026-11-09T00:00:00.000Z" }));
      for (const item of copy.createKeys) key.run(item.commandId, item.sessionId, item.fingerprint);
      db.exec("COMMIT");
    }
    db.exec("PRAGMA user_version=12"); db.close();
  }
  const generated = performance.now() - started, bytes = size(join(data, "gateway.sqlite"));
  const events = Number(new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true }).prepare("SELECT count(*) AS count FROM events").get()?.count);
  assert.ok(bytes >= 1024 ** 3, "the database holds at least 1 GiB: " + bytes);
  const opened = Date.now(), before = performance.now();
  const store = new SqliteSessionStore(data);
  const total = performance.now() - before;
  const backups = readdirSync(join(data, "backups")).filter(name => name.endsWith(".sqlite")), backup = join(data, "backups", backups[0]!);
  const backupDone = statSync(backup).mtimeMs - opened;
  const wal = size(join(data, "gateway.sqlite-wal")), peak = size(join(data, "gateway.sqlite")) + wal + size(join(data, "gateway.sqlite-shm")) + size(backup);
  try { assert.equal(store.list(1).length, 1); assert.equal(store.get(sessionId("session-1-gib-0000")).schemaVersion, 13); } finally { store.close(); }
  t.diagnostic(JSON.stringify({ databaseBytes: bytes, sessions, events, generatedMs: Math.round(generated), openMs: Math.round(total), backupMs: Math.round(backupDone), migrationAndRecoveryMs: Math.round(total - backupDone),
    walBytes: wal, backupBytes: size(backup), diskPeakBytes: peak, diskPeakOverDatabase: Number((peak / bytes).toFixed(2)) }));
});
