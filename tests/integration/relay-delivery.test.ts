import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { CleanupEvidence } from "../../src/contracts/control.js";
import {
  markOf, parseRelayPacket, relayPacketId,
  type BindingRelayState, type DeliveryRecord, type Fingerprint, type MarkerResult, type RelayDeliveryWrite, type RelayPacket, type RelayPacketId, type RelayRows, type SourceRange, type VerifyResult,
} from "../../src/contracts/relay.js";
import { SessionError, commandId, messageId, runId, sessionId, type NativeSessionBinding, type PublicRun, type RunId, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import {
  mayReuseKept, owed, pendingResend, planReturnVerify, retreatedPrior, step,
  type BindingDelivery, type Cursor, type DeliveryChange, type RelayEvent, type RelayFact, type RelayStep,
} from "../../src/contexts/session/domain/relay/delivery.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/migrate.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// G068 (ADR-055 §7, §9 S15): the delivery state machine with real storage and a real native-history reference model.
// G068-C08 and the crash points K7–K11 run the formal SqliteSessionStore with recoverRelay as its constructor option, on
// temporary data roots: Sessions are written as the Runtime will write them (the step's binding state and delivery row in one
// transaction), the Store is closed in the middle, and claimAndRecover recovers them. The other scenarios (G068-C01–C07,
// C09) are the domain and reference-model parts of their cases: the Runtime does not call the state machine yet (phase two).

const hex = (char: string) => char.repeat(64);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex") as Fingerprint;
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const alpha = { harnessId: "alpha", controlId: "alpha-acp" }, bravo = { harnessId: "bravo", controlId: "bravo-acp" };
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function packetIdOf(seed: string): RelayPacketId { return relayPacketId("relay-" + Array.from(createHash("sha256").update(seed).digest().subarray(0, 20), byte => CROCKFORD[byte % 32]).join("")); }
function temporary(t: TestContext): string { const root = mkdtempSync(join(tmpdir(), "g068-relay-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

// ---------------------------------------------------------------------------------------------------------------------
// Sessions written through the Store as the Runtime will write them
// ---------------------------------------------------------------------------------------------------------------------

type Status = PublicRun["status"];
function run(name: string, suffix: string, status: Status, contextThroughSeq: number, extra: Partial<PublicRun> = {}): PublicRun {
  return { id: runId("run-" + name + "-" + suffix), commandId: commandId("send-" + name + "-" + suffix), input: "input " + suffix, userMessageId: messageId("message-" + name + "-" + suffix + "-user"),
    assistantMessageId: messageId("message-" + name + "-" + suffix + "-reply"), selection: alpha, epoch: 1, status, cancelRequested: false, contextThroughSeq,
    sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null, timing: { acceptedAt: 10 }, ...extra };
}
function packetOf(body: string, range: SourceRange): RelayPacket {
  return parseRelayPacket({ id: packetIdOf(body), kind: "packet", tier: "standard", complete: true, reanchor: false,
    target: { harnessId: "alpha", controlId: "alpha-acp", model: null, vendor: "unknown:alpha", nativeEpoch: 1 },
    source: { kind: "other", names: [{ harnessId: "bravo", model: null, runs: [0, 0] }] }, range, basePacketId: null, supersedes: null,
    policyVersion: "relay/1", language: "en", factsFingerprint: hex("f"), workspaceObservationSeq: null,
    inputs: { attachOverride: false, digestBehind: [], detailsMissing: [], noteIncluded: false, firstLineOmitted: null },
    redaction: { profile: "egress", count: 0, byClass: {}, overridden: 0, unscanned: 0 },
    body: { sha256: sha(body), bytes: Buffer.byteLength(body, "utf8"), estTokens: 12, estimator: "est/2", family: "o200k", untrustedTokens: 0, userTokens: 4 },
    budget: { capTokens: 8000, userCap: 2500, untrustedCap: 3000, window: 200_000, fixedPrefix: 0, windowSource: "assumed_cloud", clampedBy: [] },
    sections: [{ id: "words", author: "user", items: 1, estTokens: 4, dataClasses: ["user_text"] }],
    fold: [{ kind: "unit", runIndex: 0, grade: "verbatim", why: "tail" }], omissions: [], userEdits: [] });
}
/** A step's delivery changes as the Store writes them; an insert takes the Runtime's fields of the row. */
function writes(changes: readonly DeliveryChange[], position: number, cursor: Cursor | null = null): RelayDeliveryWrite[] {
  return changes.map(change => change.kind === "outcome" ? { kind: "outcome", runId: change.runId, outcome: change.outcome } : { kind: "insert", record: {
    runId: change.runId, packetId: change.packetId, channel: "text_block", position: { kind: "seq", before: position }, outcome: { kind: "in_flight" }, consentLogSeq: null, inputHmac: hex("c") as DeliveryRecord["inputHmac"],
    redaction: { rulesVersion: "egress/1", keyId: "key-1", setHmac: "0a1b2c3d" as DeliveryRecord["redaction"]["setHmac"] }, compactionAtDelivery: cursor, resendOf: change.resendOf, attachOverride: change.attachOverride, verifyMs: null, realized: null } });
}
function applied(outcome: RelayStep): Extract<RelayStep, { kind: "applied" }> { assert.equal(outcome.kind, "applied", JSON.stringify(outcome)); return outcome as Extract<RelayStep, { kind: "applied" }>; }
const withRelay = (state: SessionSnapshot, relay: BindingRelayState, extra: Partial<NativeSessionBinding> = {}): readonly NativeSessionBinding[] =>
  state.nativeBindings!.map((binding, index) => index === state.nativeBindings!.length - 1 ? { ...binding, relay, ...extra } : binding);

type Stage = "prepared" | "authorized" | "dispatched" | "recorded";
interface Seeded { readonly state: SessionSnapshot; readonly packet: RelayPacket; readonly two: RunId }
/**
 * A conversation on alpha: Run one ran on bravo (a foreign fact), Run two carries a packet of it to alpha's new native
 * session and is stopped at `stage` — its packet prepared (run.context_prepared, K7), authorized (K8), dispatched (K9, and
 * K10 where E1 was seen but not committed), or recorded by E1 (K11). Each transaction writes the step's binding state and
 * delivery row together.
 */
function seed(store: SqliteSessionStore, workspace: string, name: string, stage: Stage): Seeded {
  const id = sessionId("session-" + name);
  let state = store.create({ schemaVersion: 13, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
    configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true }, selection: alpha,
    activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: commandId("create-" + name), kind: "create", fingerprint: hex("a"), resultId: id }] },
    [{ type: "session.created", data: {} }]).session;
  const tx = (mutate: (current: SessionSnapshot) => SessionSnapshot, type: string, relay?: RelayRows, count = 1) =>
    { state = store.transact(id, state.version, current => ({ next: mutate(current), events: Array.from({ length: count }, () => ({ type, data: {} })), ...(relay === undefined ? {} : { relay }) })).session; };
  const one = run(name, "one", "completed", 1, { selection: bravo, backend: { status: "completed", reason: "end_turn" }, cleanup: clean, timing: { acceptedAt: 10, preparingAt: 11, readyAt: 12, dispatchedAt: 13, endedAt: 14 } });
  const two = run(name, "two", "preparing", 4, { timing: { acceptedAt: 20, preparingAt: 21 } });
  // Run one finished on bravo; Run two takes alpha's new native session.
  const fresh = initialBindingRelay([], "alpha", "alpha-acp", "new");
  tx(current => ({ ...current, activeRunId: two.id, runs: [one, two],
    messages: [{ id: one.userMessageId, runId: one.id, role: "user", text: one.input, seq: 2, status: "completed" }, { id: one.assistantMessageId, runId: one.id, role: "assistant", text: "reply one", seq: 3, status: "completed" },
      { id: two.userMessageId, runId: two.id, role: "user", text: two.input, seq: 4, status: "preparing" }],
    nativeBindings: [{ ...alpha, checkpoint: "native-" + name, throughRunId: null, status: "unconfirmed", relay: fresh }],
    commands: [...current.commands, { id: one.commandId, kind: "send", fingerprint: hex("b"), resultId: one.id }, { id: two.commandId, kind: "send", fingerprint: hex("b"), resultId: two.id }] }), "fixture.accepted", undefined, 3);
  // a: the packet is prepared; the binding goes pending and the delivery row is inserted in flight, in one transaction.
  const body = "packet of " + name, packet = packetOf(body, { fromSeq: 3, throughSeq: 3, fromRun: 0, throughRun: 0 });
  const carry = applied(step(fresh, { kind: "carry", runId: two.id, packet: { id: packet.id, range: packet.range }, attachOverride: false, lateDelivery: false, resend: null }));
  tx(current => ({ ...current, nativeBindings: withRelay(current, carry.relay),
    runs: current.runs.map(row => row.id === two.id ? { ...row, relay: { packetId: packet.id, kind: "packet" as const, continuity: { kind: "rehydrate" as const, tier: "standard" as const, complete: true }, executedOn: { ...alpha, nativeEpoch: 1 } },
      timing: { acceptedAt: 20, preparingAt: 21, contextReadyAt: 22, ...(stage === "prepared" ? {} : { readyAt: 23 }) } } : row) }),
    "run.context_prepared", { packets: [{ runId: two.id, packet, body }], deliveries: writes(carry.deliveries, 7) });
  if (stage === "prepared" || stage === "authorized") return { state, packet, two: two.id };
  tx(current => ({ ...current, runs: current.runs.map(row => row.id === two.id ? { ...row, status: "running" as const, timing: { ...row.timing!, dispatchedAt: 24 } } : row),
    messages: current.messages.map(message => message.runId === two.id ? { ...message, status: "running" as const } : message) }), "run.dispatched");
  if (stage === "dispatched") return { state, packet, two: two.id };
  // E1: relay.input_recorded with the row recorded and the binding synced, in the same transaction (§14.2).
  const at = { seq: state.lastSeq + 1, time: 25 };
  const recorded = applied(step(carry.relay, { kind: "carry_settled", runId: two.id, packetId: packet.id, bodySha256: packet.body.sha256, reanchored: false, row: "in_flight", outcome: { kind: "recorded", evidence: "E1", decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: null } }));
  tx(current => ({ ...current, nativeBindings: withRelay(current, recorded.relay), runs: current.runs.map(row => row.id === two.id ? { ...row, timing: { ...row.timing!, recordedAt: 25 } } : row) }),
    "relay.input_recorded", { deliveries: writes(recorded.deliveries, 7) });
  return { state, packet, two: two.id };
}
/**
 * The delivery table and the binding agree: a pending binding's packet is unknown (or in flight only while its Run is
 * unfinished), a synced binding's last packet is recorded, and no finished Run leaves a delivery in flight unless the
 * Session is marked relayRecoveryFailed (K7–K11).
 */
function consistent(store: SqliteSessionStore, id: SessionId): void {
  const state = store.get(id), rows = store.relayDeliveries(id), binding = state.nativeBindings!.at(-1)!, sync = binding.relay!.sync;
  const latest = (packetId: string) => rows.findLast(row => row.packetId === packetId);
  if (sync.kind === "pending") assert.ok(["unknown", "in_flight"].includes(latest(sync.packetId)?.outcome.kind ?? ""), id + ": a pending binding's packet is undecided");
  if (sync.kind === "synced" && sync.mark.lastPacketId !== null) assert.equal(latest(sync.mark.lastPacketId)?.outcome.kind, "recorded", id + ": a synced binding's packet is recorded");
  for (const row of rows) {
    const owner = state.runs.find(item => item.id === row.runId)!;
    if (row.outcome.kind === "in_flight" && state.relayRecoveryFailed === undefined) assert.ok(!["completed", "cancelled", "failed", "unknown"].includes(owner.status), id + ": a finished Run left its delivery in flight");
    if (row.outcome.kind === "not_recorded") assert.notEqual(sync.kind === "pending" ? sync.packetId : null, row.packetId, id + ": a binding is not pending on a packet known not to be there");
  }
}

test("G068-C08 recoverRelay in claimAndRecover: never dispatched → not_recorded and back to prior, dispatched → unknown and still pending, recorded untouched, one Session's write failure isolated", t => {
  const root = join(temporary(t), "data"), workspace = join(root, "..");
  const first = new SqliteSessionStore(root, { recoverRelay });
  const seeded = { prepared: seed(first, workspace, "k7", "prepared"), authorized: seed(first, workspace, "k8", "authorized"), dispatched: seed(first, workspace, "k9", "dispatched"),
    recorded: seed(first, workspace, "k11", "recorded"), failing: seed(first, workspace, "failing", "dispatched") };
  const lastSeqs = Object.fromEntries(Object.entries(seeded).map(([key, value]) => [key, value.state.lastSeq])) as Record<keyof typeof seeded, number>;
  first.close();
  // The failing Session's relay rows cannot be written: SQLite refuses its delivery updates (an injected storage failure).
  const db = new DatabaseSync(join(root, "gateway.sqlite"));
  db.exec("CREATE TRIGGER g068_refuse_recovery BEFORE UPDATE ON relay_deliveries WHEN OLD.session_id='session-failing' BEGIN SELECT RAISE(ABORT,'injected relay recovery write failure'); END");
  db.close();
  const store = new SqliteSessionStore(root, { recoverRelay });
  try {
    const recovered = (id: SessionId) => store.events(id, store.get(id).lastSeq - 1).find(event => event.type === "session.recovered")!;
    for (const key of ["prepared", "authorized"] as const) {
      const { state, two } = seeded[key], now = store.get(state.id), event = recovered(state.id);
      assert.equal(now.status, "blocked"); assert.equal(now.runs[1]!.status, "unknown");
      assert.deepEqual(store.relayDeliveries(state.id)[0]!.outcome, { kind: "not_recorded", reason: "never_dispatched", decidedSeq: lastSeqs[key] + 1, decidedAt: key === "prepared" ? 22 : 23 }, key + ": the packet never left");
      assert.equal(event.seq, lastSeqs[key] + 1, "the decision seq is session.recovered's");
      assert.deepEqual(now.nativeBindings![0]!.relay!.sync, { kind: "fresh", basis: "new" }, key + ": the binding returned to its prior");
      assert.deepEqual(event.data.relay, { failed: false, deliveries: [{ runId: two, outcome: "not_recorded" }], bindings: [{ harnessId: "alpha", controlId: "alpha-acp", sync: "fresh" }] });
      consistent(store, state.id);
    }
    {
      const { state, two, packet } = seeded.dispatched, now = store.get(state.id);
      assert.deepEqual(store.relayDeliveries(state.id)[0]!.outcome, { kind: "unknown", reason: "owner_ended", decidedSeq: lastSeqs.dispatched + 1, decidedAt: 24 });
      assert.equal(now.nativeBindings![0]!.relay!.sync.kind === "pending" && now.nativeBindings![0]!.relay!.sync.packetId, packet.id, "a dispatched packet stays pending, checked at the next open");
      assert.deepEqual(recovered(state.id).data.relay, { failed: false, deliveries: [{ runId: two, outcome: "unknown" }], bindings: [{ harnessId: "alpha", controlId: "alpha-acp", sync: "pending" }] });
      consistent(store, state.id);
    }
    {
      const { state, packet } = seeded.recorded, now = store.get(state.id);
      assert.equal(store.relayDeliveries(state.id)[0]!.outcome.kind === "recorded" && (store.relayDeliveries(state.id)[0]!.outcome as { readonly evidence: string }).evidence, "E1", "E1 committed before the owner ended stays");
      assert.equal(markOf(now.nativeBindings![0]!.relay!.sync)?.lastPacketId, packet.id);
      assert.equal(recovered(state.id).data.relay, undefined, "nothing to recover: recoverRelay changed nothing");
      assert.equal(now.relayRecoveryFailed, undefined);
      consistent(store, state.id);
    }
    {
      const { state } = seeded.failing, now = store.get(state.id);
      assert.equal(now.relayRecoveryFailed, lastSeqs.failing + 1, "only this Session is marked");
      assert.equal(store.relayDeliveries(state.id)[0]!.outcome.kind, "in_flight", "its relay rows rolled back to the SAVEPOINT");
      assert.equal(now.nativeBindings![0]!.relay!.sync.kind, "pending");
      assert.equal(now.status, "blocked", "the Session itself is recovered");
      assert.deepEqual(recovered(state.id).data.relay, { failed: true });
      consistent(store, state.id);
    }
    for (const key of ["prepared", "authorized", "dispatched", "recorded"] as const) assert.equal(store.get(seeded[key].state.id).relayRecoveryFailed, undefined, key + " is unaffected by the failing Session");
  } finally { store.close(); }
});

test("G068 a Turn that ended unknown is checked at the next open: recorded (E2) with the binding synced in one transaction; nothing is written in between", t => {
  const root = join(temporary(t), "data"), workspace = join(root, "..");
  let store = new SqliteSessionStore(root, { recoverRelay });
  const { state: started, packet, two } = seed(store, workspace, "hermes", "dispatched");
  const id = started.id;
  // Run two ends unknown (Hermes unknown_execution): i — the row unknown, the binding still pending, both in run.ended's transaction.
  let state = store.get(id);
  const relay0 = state.nativeBindings![0]!.relay!, at = { seq: state.lastSeq + 1, time: 30 };
  const unknown = applied(step(relay0, { kind: "carry_settled", runId: two, packetId: packet.id, bodySha256: packet.body.sha256, reanchored: false, row: "in_flight", outcome: { kind: "unknown", reason: "no_evidence", decidedSeq: at.seq, decidedAt: at.time } }));
  state = store.transact(id, state.version, current => ({ next: { ...current, activeRunId: null, nativeBindings: withRelay(current, unknown.relay, { status: "ready", throughRunId: two }),
    runs: current.runs.map(row => row.id === two ? { ...row, status: "failed" as const, backend: { status: "failed" as const, reason: "unknown_execution" }, cleanup: clean, timing: { ...row.timing!, endedAt: 30 } } : row),
    messages: [...current.messages.map(message => message.runId === two ? { ...message, status: "failed" as const } : message), { id: messageId("message-hermes-two-reply"), runId: two, role: "assistant" as const, text: "", seq: current.lastSeq + 1, status: "failed" as const }] },
    events: [{ type: "run.ended", data: { runId: two } }], relay: { deliveries: writes(unknown.deliveries, 7) } })).session;
  const snapshot = (db: DatabaseSync) => String(db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id)!.snapshot);
  store.close();
  const raw = new DatabaseSync(join(root, "gateway.sqlite")), bytes = snapshot(raw); raw.close();
  // Restarting changes nothing: no Run is unfinished, so recovery has nothing to do, and nothing polls the native side.
  store = new SqliteSessionStore(root, { recoverRelay });
  t.after(() => { try { store.close(); } catch { /* closed below */ } });
  const again = new DatabaseSync(join(root, "gateway.sqlite")); assert.equal(snapshot(again), bytes, "the snapshot is byte for byte the same until the next open"); again.close();
  assert.equal(store.relayDeliveries(id)[0]!.outcome.kind, "unknown");
  // Run three: its open replays the history; the check of the pending packet finds it (E2, k), committed with Run three's preparation.
  state = store.get(id);
  const three = run("hermes", "three", "preparing", state.lastSeq + 1, { timing: { acceptedAt: 40, preparingAt: 41 } });
  state = store.transact(id, state.version, current => ({ next: { ...current, activeRunId: three.id, runs: [...current.runs, three],
    messages: [...current.messages, { id: three.userMessageId, runId: three.id, role: "user", text: three.input, seq: current.lastSeq + 1, status: "preparing" }],
    commands: [...current.commands, { id: three.commandId, kind: "send", fingerprint: hex("b"), resultId: three.id }], nativeBindings: withRelay(current, current.nativeBindings![0]!.relay!, { status: "unconfirmed" }) },
    events: [{ type: "message.accepted", data: { runId: three.id } }] })).session;
  const pending = state.nativeBindings![0]!.relay!;
  const rows: BindingDelivery[] = store.relayDeliveries(id).map(record => ({ record, nativeEpoch: 1, range: packet.range, bodySha256: packet.body.sha256, reanchor: false, mark: null }));
  const plan = planReturnVerify(pending, { verify: "on_next_open", moment: "open", deliveries: rows });
  assert.equal(plan.kind, "pending");
  const verified = applied(step(pending, { kind: "verified", plan, result: { markers: [{ packetId: packet.id, result: "present" }], historyEmpty: false, compaction: null, foreignAfterLast: 0, verifyMs: 4 }, inRunId: three.id, at: { seq: state.lastSeq + 1, time: 42 } }));
  // An illegal delivery change in the same transaction rolls the binding change back with it.
  assert.throws(() => store.transact(id, state.version, current => ({ next: { ...current, nativeBindings: withRelay(current, verified.relay) }, events: [{ type: "relay.verified", data: {} }],
    relay: { deliveries: [{ kind: "outcome", runId: two, outcome: { kind: "not_recorded", reason: "rejected_before_insert", decidedSeq: current.lastSeq + 1, decidedAt: 42 } }, { kind: "outcome", runId: two, outcome: { kind: "unknown", reason: "absent", decidedSeq: current.lastSeq + 1, decidedAt: 42 } }] } })),
    (error: unknown) => error instanceof SessionError && error.code === "INVALID_TRANSITION");
  assert.equal(store.get(id).nativeBindings![0]!.relay!.sync.kind, "pending", "nothing of the refused transaction was written");
  state = store.transact(id, state.version, current => ({ next: { ...current, nativeBindings: withRelay(current, verified.relay) }, events: [{ type: "relay.verified", data: { verifiedRunId: two, inRunId: three.id } }],
    relay: { deliveries: writes(verified.deliveries, 7) } })).session;
  const row = store.relayDeliveries(id)[0]!;
  assert.deepEqual(row.outcome, { kind: "recorded", evidence: "E2", decidedSeq: state.lastSeq, decidedAt: 42, verifiedInRun: three.id });
  assert.equal(state.nativeBindings![0]!.relay!.sync.kind === "synced" && state.nativeBindings![0]!.relay!.sync.mark.lastPacketId, packet.id);
  consistent(store, id);
});

// ---------------------------------------------------------------------------------------------------------------------
// The reference model and a scripted Hub
// ---------------------------------------------------------------------------------------------------------------------

const peerPath = fileURLToPath(new URL("../../../tests/fixtures/relay-harness-peer.mjs", import.meta.url));
class Peer {
  private readonly child: ChildProcess;
  private next = 1;
  private readonly waiting = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
  readonly ready: Promise<unknown>;
  constructor() {
    this.child = fork(peerPath, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    this.ready = new Promise((resolve, reject) => this.waiting.set(0, { resolve, reject }));
    this.child.on("message", (raw: unknown) => {
      const message = raw as { readonly id: number; readonly ok: boolean; readonly result?: unknown; readonly error?: string };
      const waiter = this.waiting.get(message.id); this.waiting.delete(message.id);
      if (message.ok) waiter?.resolve(message.result); else waiter?.reject(new Error(message.error));
    });
  }
  call<T>(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => { this.waiting.set(id, { resolve: value => resolve(value as T), reject }); this.child.send({ id, op, args }); });
  }
  async close(): Promise<void> { if (this.child.exitCode !== null) return; const exited = new Promise(resolve => this.child.once("exit", resolve)); this.child.disconnect(); await exited; }
}
async function startPeer(t: TestContext): Promise<Peer> { const peer = new Peer(); await peer.ready; t.after(() => peer.close()); return peer; }

interface Row { record: DeliveryRecord; readonly nativeEpoch: number; readonly range: SourceRange; readonly bodySha256: Fingerprint; readonly reanchor: boolean; mark: BindingDelivery["mark"]; readonly facts: readonly string[] }
type Fate = "recorded" | "unknown_inserted" | "unknown_lost" | "refused" | "late";
/**
 * A scripted Hub over one binding of a Harness (`self`) next to others: the same decisions the Runtime will take in phase
 * two, written out per scenario. `sent` keeps what each content input carried, so `dispatched === input` is checked on it.
 */
class Hub {
  seq = 1;
  relay: BindingRelayState;
  readonly facts: RelayFact[] = [];
  readonly rows: Row[] = [];
  readonly sent: { readonly runId: RunId; readonly input: string; readonly dispatched: string }[] = [];
  bindings: NativeSessionBinding[];
  session: string;
  private runs = 0;
  constructor(private readonly peer: Peer, readonly self: { readonly harnessId: string; readonly controlId: string }, readonly verify: "on_next_open" | "after_turn" | "none" = "on_next_open", readonly caps = { lateDelivery: false, compaction: true }) {
    this.relay = initialBindingRelay([], self.harnessId, self.controlId, "new");
    this.session = "native-" + self.harnessId + "-1";
    this.bindings = [{ ...self, checkpoint: this.session, throughRunId: null, status: "ready", relay: this.relay }];
  }
  private at() { this.seq += 1; return { seq: this.seq, time: this.seq * 10 }; }
  private apply(outcome: RelayStep): RelayStep {
    if (outcome.kind === "refused") return outcome;
    for (const change of outcome.deliveries) if (change.kind === "outcome") { const row = this.rows.find(item => item.record.runId === change.runId)!; assert.equal(row.record.outcome.kind, change.from); row.record = { ...row.record, outcome: change.outcome }; }
    if (outcome.kind === "replaced") { this.bindings = [...this.bindings.slice(0, -1), { ...this.bindings.at(-1)!, status: "archived", relay: outcome.archived }]; this.session = this.session.replace(/-\d+$/u, "-" + (this.bindings.length + 1)); this.bindings.push({ ...this.self, checkpoint: this.session, throughRunId: null, status: "ready", relay: outcome.relay }); }
    else this.bindings = [...this.bindings.slice(0, -1), { ...this.bindings.at(-1)!, relay: outcome.relay }];
    this.relay = outcome.relay;
    const sync = this.relay.sync;
    if (sync.kind === "synced" && sync.mark.lastPacketId !== null) { const row = this.rows.findLast(item => item.record.packetId === sync.mark.lastPacketId); if (row && row.record.outcome.kind === "recorded") row.mark = sync.mark; }
    return outcome;
  }
  need(attachOverride = false) { return owed(this.relay, this.self.harnessId, this.self.controlId, this.facts, { originHistory: false, attachOverride }); }
  /** A Turn of another Harness: a foreign fact. */
  other(harnessId: string): RunId { const at = this.at(), id = runId("run-" + harnessId + "-" + ++this.runs); this.facts.push({ runId: id, seq: at.seq, executedOn: { harnessId, controlId: harnessId + "-acp", nativeEpoch: 1 } }); return id; }
  /** The check of the Driver at the open, applied as k for every plan, a skipped one included; returns the plan's kind. */
  async open(readable = true): Promise<string> {
    const plan = planReturnVerify(this.relay, { verify: this.verify, moment: "open", deliveries: this.rows });
    const markers = plan.kind === "skip" ? [] : plan.kind === "pending" ? [plan.marker, ...plan.earlier] : plan.kind === "synced" ? [plan.marker] : plan.kind === "unknown_turn" ? (plan.marker === null ? [] : [plan.marker])
      : [...(plan.kind === "clear" ? plan.chain : plan.markers), ...(plan.carried === null ? [] : [plan.carried])];
    const result: VerifyResult = plan.kind === "skip" ? { markers: [], historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 0 }
      : await this.peer.call<VerifyResult>("verify", { session: this.session, markers: markers.map(marker => ({ packetId: marker.packetId, after: (marker.position as { readonly before: number }).before })), compaction: this.caps.compaction, readable });
    let turnEntry: MarkerResult | undefined;
    if (plan.kind === "unknown_turn" && plan.marker === null && this.lastUnknown !== null) turnEntry = (await this.peer.call<{ readonly result: MarkerResult }>("entry", { session: this.session, runId: this.lastUnknown.runId, after: this.lastUnknown.position, readable })).result;
    this.apply(step(this.relay, { kind: "verified", plan, result, ...(turnEntry === undefined ? {} : { turnEntry }), inRunId: null, at: this.at() }));
    return plan.kind;
  }
  lastUnknown: { readonly runId: RunId; readonly position: number } | null = null;
  /**
   * A content input as §7.2 decides it: b while nothing is owed, a with a packet of need, n when the user chose to send it alone;
   * on a pending binding a resend (automatic or the user's) or the 409 choice; returns how it went.
   */
  async send(fate: Fate = "recorded", choice: { readonly attach?: "full" | "none"; readonly resend?: boolean; readonly retreat?: boolean } = {}): Promise<{ readonly kind: string; readonly refusal?: string }> {
    await this.open();
    const id = runId("run-" + this.self.harnessId + "-" + ++this.runs), input = "input " + id, position = (await this.peer.call<{ readonly before: number }>("position", { session: this.session })).before;
    const sync = this.relay.sync, attach = choice.attach === "full" || sync.kind === "pending" && sync.attachOverride;
    let need = this.need(attach);
    if (sync.kind === "suspect" && choice.retreat === true) need = owed({ ...this.relay, sync: retreatedPrior(this.relay, this.rows.find(row => row.nativeEpoch === this.relay.nativeEpoch)?.range.fromSeq ?? null)! }, this.self.harnessId, this.self.controlId, this.facts, { originHistory: false });
    const alone = choice.attach === "none" || (need.facts.length === 0 && sync.kind !== "pending");
    if (alone) {
      const outcome = need.facts.length === 0 && choice.attach !== "none" ? step(this.relay, { kind: "plain", foreign: this.facts.some(fact => fact.executedOn?.harnessId !== this.self.harnessId) }) : step(this.relay, { kind: "alone" });
      if (outcome.kind === "refused") return { kind: "refused", refusal: outcome.refusal.code + ":" + ("cause" in outcome.refusal ? outcome.refusal.cause : "") };
      this.apply(outcome);
      await this.peer.call("send", { session: this.session, runId: id, insert: fate === "refused" || fate === "unknown_lost" ? "never" : "now" });
      const at = this.at();
      this.facts.push({ runId: id, seq: at.seq, executedOn: { ...this.self, nativeEpoch: this.relay.nativeEpoch } });
      this.sent.push({ runId: id, input, dispatched: input });
      if (outcome.kind === "applied" && choice.attach !== "none" && need.facts.length === 0)
        this.apply(step(this.relay, { kind: "plain_settled", input: fate === "recorded" ? "recorded" : fate === "refused" ? "not_recorded" : "unknown", agentOutput: fate === "recorded", contextThroughSeq: at.seq - 1 }));
      this.lastUnknown = fate === "unknown_inserted" || fate === "unknown_lost" ? { runId: id, position } : null;
      return { kind: choice.attach === "none" ? "n" : "b" };
    }
    let resend: { readonly by: "auto" | "user"; readonly of: RunId } | null = null;
    if (sync.kind === "pending") {
      const of = this.rows.findLast(row => row.record.packetId === sync.packetId)!.record.runId;
      if (choice.resend === true) resend = { by: "user", of };
      else if (pendingResend(sync, this.caps.lateDelivery) === "auto") resend = { by: "auto", of };
      else return { kind: "refused", refusal: "RELAY_CHOICE_REQUIRED:delivery_unconfirmed" };
    }
    const packetId = packetIdOf(this.self.harnessId + ":" + id), body = sha(packetId), facts = need.facts.map(fact => fact.runId as string);
    const range: SourceRange = { fromSeq: need.facts[0]!.seq, throughSeq: need.facts.at(-1)!.seq, fromRun: 0, throughRun: 0 };
    const cursor = (await this.peer.call<{ readonly cursor: Cursor }>("held", { session: this.session })).cursor;
    const firstFromSeq = this.rows.find(row => row.nativeEpoch === this.relay.nativeEpoch)?.range.fromSeq ?? null;
    const outcome = step(this.relay, { kind: "carry", runId: id, packet: { id: packetId, range }, attachOverride: attach, lateDelivery: this.caps.lateDelivery, resend, ...(choice.retreat === true ? { retreat: { firstFromSeq } } : {}) });
    if (outcome.kind === "refused") return { kind: "refused", refusal: outcome.refusal.code + ":" + ("cause" in outcome.refusal ? outcome.refusal.cause : "") };
    for (const change of outcome.deliveries) if (change.kind === "insert") this.rows.push({ record: (writes([change], position, this.caps.compaction ? cursor : null)[0] as Extract<RelayDeliveryWrite, { kind: "insert" }>).record, nativeEpoch: this.relay.nativeEpoch, range, bodySha256: body, reanchor: false, mark: null, facts });
    this.apply(outcome);
    await this.peer.call("send", { session: this.session, runId: id, packetId, facts, insert: fate === "recorded" || fate === "unknown_inserted" ? "now" : fate === "late" ? "late" : "never" });
    this.sent.push({ runId: id, input, dispatched: "packet " + packetId + "\n\n" + input });
    const at = this.at();
    const decided = fate === "recorded" ? { kind: "recorded" as const, evidence: "E3" as const, decidedSeq: at.seq, decidedAt: at.time, verifiedInRun: null }
      : fate === "refused" ? { kind: "not_recorded" as const, reason: "rejected_before_insert" as const, decidedSeq: at.seq, decidedAt: at.time }
      : { kind: "unknown" as const, reason: fate === "late" ? "late_delivery" as const : "no_evidence" as const, decidedSeq: at.seq, decidedAt: at.time };
    this.apply(step(this.relay, { kind: "carry_settled", runId: id, packetId, bodySha256: body, reanchored: false, row: "in_flight", outcome: decided }));
    this.facts.push({ runId: id, seq: at.seq, executedOn: { ...this.self, nativeEpoch: this.relay.nativeEpoch } });
    this.lastUnknown = decided.kind === "unknown" ? { runId: id, position } : null;
    return { kind: resend === null ? "a" : "resend:" + resend.by };
  }
  /** A command Turn: its native effect in the reference model and its settlement event. */
  async command(kind: "keep" | "export" | "compact" | "clear" | "clear_unconfirmed" | "undo"): Promise<void> {
    const at = this.at();
    if (kind === "compact") { const done = await this.peer.call<{ readonly cursor: Cursor }>("compact", { session: this.session, keep: 1 }); this.apply(step(this.relay, { kind: "compaction", cursor: this.caps.compaction ? done.cursor : null })); }
    else if (kind === "clear" || kind === "clear_unconfirmed") { await this.peer.call("clear", { session: this.session }); this.apply(step(this.relay, kind === "clear" ? { kind: "cleared", seq: at.seq } : { kind: "clear_unconfirmed", seq: at.seq })); }
    else if (kind === "undo") { await this.peer.call("rewind", { session: this.session, n: 1 }); this.apply(step(this.relay, { kind: "rewound", cause: "rewind" })); }
    else this.apply(step(this.relay, { kind: "command_kept" }));
    this.lastUnknown = null;
  }
  reset(): void { this.apply(step(this.relay, { kind: "reset", bindings: this.bindings, ...this.self })); }
  continueUnknown(): void { this.apply(step(this.relay, { kind: "unknown_turn_continued" })); }
  async held(): Promise<ReadonlySet<string>> { return new Set((await this.peer.call<{ readonly facts: readonly string[] }>("held", { session: this.session })).facts); }
  /** The last content input went out exactly as typed. */
  lastAsTyped(): boolean { const last = this.sent.at(-1)!; return last.dispatched === last.input; }
}
const ALPHA = { harnessId: "alpha", controlId: "alpha-acp" }, HERMES = { harnessId: "hermes", controlId: "hermes-acp" };

test("G068-C01 (domain part) 20 inputs to a single Harness with an undispatched Turn, a synthesized failure, /export, /clear, /undo, attach none and a WorkBuddy target in between: dispatched === input each time", async t => {
  const peer = await startPeer(t), hub = new Hub(peer, ALPHA);
  const fates: readonly Fate[] = ["recorded", "refused", "unknown_lost", "recorded", "unknown_inserted"];
  for (let index = 0; index < 20; index++) {
    if (index === 3) await hub.command("export");
    if (index === 6) await hub.command("clear");
    if (index === 9) await hub.command("undo");
    if (index === 12) hub.seq += 2;   // a Run accepted and cancelled before dispatch: no fact, no event on the binding
    const outcome = await hub.send(fates[index % fates.length]!, index === 15 ? { attach: "none" } : {});
    assert.ok(outcome.kind === "b" || outcome.kind === "n", "input " + index + " went out " + outcome.kind);
    assert.ok(hub.lastAsTyped(), "input " + index);
  }
  // A target the relay does not serve (WorkBuddy, RELAY_TARGET_UNVERIFIED): only "send this message alone" — n, as typed, no evidence.
  const workbuddy = new Hub(peer, { harnessId: "workbuddy", controlId: "workbuddy-acp" });
  for (let index = 0; index < 5; index++) {
    workbuddy.other("bravo");
    const before = workbuddy.relay;
    assert.equal((await workbuddy.send("recorded", { attach: "none" })).kind, "n");
    assert.ok(workbuddy.lastAsTyped()); assert.deepEqual(workbuddy.relay, before, "attach none changes no state and no mark");
  }
});

test("G068-C02 (domain part) a pending binding's next input: one automatic resend, then the user's choice; lateDelivery never resends by itself; attach none changes nothing", async t => {
  const peer = await startPeer(t);
  const hub = new Hub(peer, ALPHA);
  hub.other("bravo");
  assert.equal((await hub.send("unknown_lost")).kind, "a");
  assert.equal(hub.relay.sync.kind, "pending");
  assert.equal((await hub.send("unknown_lost")).kind, "resend:auto", "the first unknown is sent again once, automatically");
  assert.equal(hub.relay.sync.kind === "pending" && hub.relay.sync.autoResends, 1);
  const exhausted = await hub.send("recorded");
  assert.deepEqual(exhausted, { kind: "refused", refusal: "RELAY_CHOICE_REQUIRED:delivery_unconfirmed" }, "then admission asks the user (409)");
  const before = hub.relay;
  assert.equal((await hub.send("recorded", { attach: "none" })).kind, "n"); assert.deepEqual(hub.relay, before, "attach none: state and mark unchanged");
  assert.ok(hub.lastAsTyped());
  assert.equal((await hub.send("recorded", { resend: true })).kind, "resend:user");
  assert.equal(hub.relay.sync.kind, "synced", "the user's resend was recorded");
  // A Driver that declares lateDelivery never resends by itself; the late write shows up at the next open and is recorded (E2).
  const late = new Hub(peer, { harnessId: "opencode", controlId: "opencode-acp" }, "on_next_open", { lateDelivery: true, compaction: false });
  late.other("bravo");
  assert.equal((await late.send("late")).kind, "a");
  assert.deepEqual(await late.send("recorded"), { kind: "refused", refusal: "RELAY_CHOICE_REQUIRED:delivery_unconfirmed" });
  await peer.call("flushLate", { session: late.session });
  await late.open();
  assert.equal(late.relay.sync.kind, "synced", "the late write is found after its position");
  assert.equal(late.rows[0]!.record.outcome.kind === "recorded" && (late.rows[0]!.record.outcome as { readonly evidence: string }).evidence, "E2");
});

test("G068-C03 (domain part) Hermes /clear: the fixed receipt confirms it; without it the next replay decides — empty clears, markers still there restore", async t => {
  const peer = await startPeer(t);
  const confirmed = new Hub(peer, HERMES);
  confirmed.other("claude"); await confirmed.send("recorded");
  const floor = confirmed.seq + 1;
  await confirmed.command("clear");
  assert.deepEqual(confirmed.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(confirmed.relay.epochFloor, floor); assert.equal(confirmed.relay.nativeEpoch, 2);
  const empty = new Hub(peer, { harnessId: "hermes-b", controlId: "hermes-b-acp" });
  empty.other("claude"); await empty.send("recorded");
  await empty.command("clear_unconfirmed");
  assert.equal(empty.relay.sync.kind === "suspect" && empty.relay.sync.cause, "clear_unconfirmed"); assert.equal(empty.relay.nativeEpoch, 1, "no epoch until it is confirmed");
  assert.equal(await empty.open(), "clear");
  assert.deepEqual(empty.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(empty.relay.nativeEpoch, 2);
  const kept = new Hub(peer, { harnessId: "hermes-c", controlId: "hermes-c-acp" });
  kept.other("claude"); await kept.send("recorded");
  const before = markOf(kept.relay.sync);
  // The clear did not happen (an unknown outcome): nothing is cleared in the reference model, the replay shows the packet.
  kept.relay = applied(step(kept.relay, { kind: "clear_unconfirmed", seq: kept.seq + 1 })).relay; kept.seq += 1;
  assert.equal(await kept.open(), "clear");
  assert.deepEqual(kept.relay.sync, { kind: "synced", mark: before }, "back to the state before the clear");
});

test("G068-C04 (domain part) a compaction cursor that moves after a delivery sets reanchor once; one that does not move sets nothing", async t => {
  const peer = await startPeer(t), hub = new Hub(peer, ALPHA);
  hub.other("bravo"); await hub.send("recorded"); await hub.send("recorded");
  hub.relay = applied(step(hub.relay, { kind: "compaction", cursor: hub.relay.compactionSeen })).relay;
  assert.equal(hub.relay.reanchor, false, "the same cursor is no compaction");
  await hub.command("compact");
  assert.equal(hub.relay.reanchor, true, "a moved cursor after a delivery");
  const cursor = hub.relay.compactionSeen;
  assert.equal(applied(step(hub.relay, { kind: "compaction", cursor })).changed, false, "seen once: the same cursor again changes nothing");
  // A packet carrying the anchor clears the flag when it is recorded.
  hub.other("bravo");
  const pending = applied(step(hub.relay, { kind: "carry", runId: runId("run-anchor"), packet: { id: packetIdOf("anchor"), range: { fromSeq: hub.seq, throughSeq: hub.seq, fromRun: 0, throughRun: 0 } }, attachOverride: false, lateDelivery: false, resend: null })).relay;
  const settled = applied(step(pending, { kind: "carry_settled", runId: runId("run-anchor"), packetId: packetIdOf("anchor"), bodySha256: sha("anchor"), reanchored: true, row: "in_flight", outcome: { kind: "recorded", evidence: "E3", decidedSeq: hub.seq + 1, decidedAt: 1, verifiedInRun: null } }));
  assert.equal(settled.relay.reanchor, false);
  // A fresh binding (no packet in its epoch) never sets it.
  const fresh = initialBindingRelay([], "fresh", "fresh-acp", "new");
  assert.equal(applied(step(fresh, { kind: "compaction", cursor: { count: 3, digest: sha("moved") } })).relay.reanchor, false);
});

test("G068-C05 (domain part) after a clear 20 inputs go out as typed; attach once brings the earlier history for that input only; its resend inherits attachOverride", async t => {
  const peer = await startPeer(t), hub = new Hub(peer, HERMES);
  hub.other("claude"); hub.other("claude");
  await hub.send("recorded");
  await hub.command("clear");
  for (let index = 0; index < 20; index++) { assert.equal((await hub.send("recorded")).kind, "b", "input " + index); assert.ok(hub.lastAsTyped()); }
  // "附上交接单": one input with relay.attach:"full" ignores the floor — Claude's two Turns and Hermes' own pre-clear Turn.
  const fresh = new Hub(peer, { harnessId: "hermes-d", controlId: "hermes-d-acp" });
  const before = [fresh.other("claude"), fresh.other("claude")];
  await fresh.send("recorded"); await fresh.send("recorded");
  await fresh.command("clear");
  assert.deepEqual(fresh.need(true).facts.map(fact => fact.runId).slice(0, 2), before, "the one-time attach owes the history before the clear");
  assert.equal(fresh.need().facts.length, 0, "without it, nothing");
  assert.equal((await fresh.send("unknown_lost", { attach: "full" })).kind, "a");
  assert.equal(fresh.relay.sync.kind === "pending" && fresh.relay.sync.attachOverride, true);
  assert.equal((await fresh.send("recorded")).kind, "resend:auto");
  assert.equal(fresh.rows.at(-1)!.record.attachOverride, true, "the resend inherits the one-time attach (VF1-07)");
  assert.equal(fresh.relay.sync.kind, "synced");
});

test("G068-C06 (domain part) A clears, B works two Turns, back to A: only B's two; A clears then resets: the first input still owes nothing from before the clear", async t => {
  const peer = await startPeer(t), hub = new Hub(peer, ALPHA);
  hub.other("claude"); await hub.send("recorded"); await hub.send("recorded");
  await hub.command("clear");
  const two = [hub.other("bravo"), hub.other("bravo")];
  assert.deepEqual(hub.need().facts.map(fact => fact.runId), two, "only B's two Turns");
  assert.equal((await hub.send("recorded")).kind, "a");
  assert.deepEqual(hub.rows.at(-1)!.facts, two);
  const reset = new Hub(peer, { harnessId: "alpha-r", controlId: "alpha-r-acp" });
  reset.other("claude"); await reset.send("recorded"); await reset.send("recorded");
  await reset.command("clear");
  reset.reset();
  assert.equal(reset.relay.epochFloor > 0, true, "the floor is inherited along the lineage");
  assert.deepEqual(reset.need().facts, [], "the new native session owes nothing from before the clear");
  assert.equal((await reset.send("recorded")).kind, "b");
});

test("G068-C07 (domain part) a kept process is not reused after Hermes /undo: the open's replay check moves the mark back, never below the floor, and the same session is sent the rest", async t => {
  const peer = await startPeer(t), hub = new Hub(peer, HERMES);
  hub.other("claude"); await hub.command("clear");
  hub.other("claude"); await hub.send("recorded");
  hub.other("claude"); await hub.send("recorded");
  const marked = markOf(hub.relay.sync)!.throughSeq;
  await hub.command("undo");
  assert.equal(mayReuseKept(hub.relay, "on_next_open"), false, "suspect: close the kept process and open to replay");
  assert.equal(await hub.open(), "suspect");
  const back = markOf(hub.relay.sync)!;
  assert.ok(back.throughSeq < marked && back.throughSeq >= hub.relay.epochFloor, "the mark went back to the last marker still there, not below the floor");
  const held = await hub.held();
  assert.ok(hub.need().facts.every(fact => !held.has(fact.runId)) && hub.need().facts.length > 0, "the undone packet's facts are owed again in the same session");
  assert.equal((await hub.send("recorded")).kind, "a");
});

test("G068-C09 (domain part) D6: an unknown Turn continued in its native session is checked at its position: there → synced, not there → its prior; need=∅ goes out as typed", async t => {
  const peer = await startPeer(t);
  const found = new Hub(peer, ALPHA);
  found.other("bravo");
  assert.equal((await found.send("unknown_inserted")).kind, "a");
  found.continueUnknown();
  assert.equal(found.relay.sync.kind === "suspect" && found.relay.sync.cause, "unknown_turn");
  assert.equal(await found.open(), "unknown_turn");
  assert.equal(found.relay.sync.kind === "synced" && found.relay.sync.mark.evidence, "E2");
  assert.equal(found.rows[0]!.record.outcome.kind, "recorded");
  assert.equal((await found.send("recorded")).kind, "b", "need=∅ continues as typed"); assert.ok(found.lastAsTyped());
  const lost = new Hub(peer, { harnessId: "alpha-l", controlId: "alpha-l-acp" });
  lost.other("bravo");
  await lost.send("unknown_lost");
  lost.continueUnknown();
  await lost.open();
  assert.deepEqual(lost.relay.sync, { kind: "fresh", basis: "new" }, "back to the state before the packet");
  assert.equal(lost.rows[0]!.record.outcome.kind === "unknown" && (lost.rows[0]!.record.outcome as { readonly reason: string }).reason, "absent");
  assert.equal((await lost.send("recorded")).kind, "a", "the next input owes the facts again");
});
