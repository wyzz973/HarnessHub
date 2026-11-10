import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { listedCommand, nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl, type NativeCommand, type TurnText, type VerifyRequest } from "../../src/contracts/control.js";
import { contentId, type ContentPort } from "../../src/contracts/content.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { measureBy } from "../../src/adapters/control/relay-turn.js";
import { SessionRuntime, type RelayChoice } from "../../src/contexts/session/application/runtime.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import {
  RelayError, markOf, parseRelayPacket, relayPacketId,
  type BindingRelayState, type DeliveredMark, type DeliveryPosition, type DeliveryRecord, type Fingerprint, type MarkerResult, type RelayCapabilities, type RelayDeliveryWrite, type RelayPacket, type RelayPacketId, type RelayRows, type SourceRange, type VendorKey, type VerifyResult,
} from "../../src/contracts/relay.js";
import { SessionError, commandId, messageId, runId, sessionId, type HarnessSelection, type NativeSessionBinding, type PreparedSessionBinding, type PublicRun, type RunId, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionRuntimeOptions, type SessionSnapshot } from "../../src/contracts/session.js";
import {
  mayReuseKept, owed, pendingResend, planReturnVerify, retreatedPrior, step,
  type BindingDelivery, type Cursor, type DeliveryChange, type RelayEvent, type RelayFact, type RelayStep,
} from "../../src/contexts/session/domain/relay/delivery.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/migrate.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { RedactedHarnessControl } from "../../src/infrastructure/session/redacted-control.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { askWhenUnsure } from "../fixtures/relay-settings.js";

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
    const supersededRow = resend === null ? undefined : this.rows.find(row => row.record.runId === resend!.of);
    this.apply(step(this.relay, { kind: "carry_settled", runId: id, packetId, bodySha256: body, reanchored: false, row: "in_flight", outcome: decided,
      ...(supersededRow === undefined ? {} : { superseded: { packetId: supersededRow.record.packetId, range: supersededRow.range } }) }));
    this.facts.push({ runId: id, seq: at.seq, executedOn: { ...this.self, nativeEpoch: this.relay.nativeEpoch } });
    this.lastUnknown = decided.kind === "unknown" ? { runId: id, position } : null;
    return { kind: resend === null ? "a" : "resend:" + resend.by };
  }
  /** A command Turn: its native effect in the reference model and its settlement event. */
  async command(kind: "keep" | "export" | "compact" | "clear" | "clear_unconfirmed" | "undo"): Promise<void> {
    const at = this.at();
    if (kind === "compact") { const done = await this.peer.call<{ readonly cursor: Cursor }>("compact", { session: this.session, keep: 1 }); this.apply(step(this.relay, { kind: "compaction", cursor: this.caps.compaction ? done.cursor : null, ran: true })); }
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
  hub.relay = applied(step(hub.relay, { kind: "compaction", cursor: hub.relay.compactionSeen, ran: false })).relay;
  assert.equal(hub.relay.reanchor, false, "the same cursor is no compaction");
  await hub.command("compact");
  assert.equal(hub.relay.reanchor, true, "a moved cursor after a delivery");
  const cursor = hub.relay.compactionSeen;
  assert.equal(applied(step(hub.relay, { kind: "compaction", cursor, ran: false })).changed, false, "seen once: the same cursor again changes nothing");
  // A packet carrying the anchor clears the flag when it is recorded.
  hub.other("bravo");
  const pending = applied(step(hub.relay, { kind: "carry", runId: runId("run-anchor"), packet: { id: packetIdOf("anchor"), range: { fromSeq: hub.seq, throughSeq: hub.seq, fromRun: 0, throughRun: 0 } }, attachOverride: false, lateDelivery: false, resend: null })).relay;
  const settled = applied(step(pending, { kind: "carry_settled", runId: runId("run-anchor"), packetId: packetIdOf("anchor"), bodySha256: sha("anchor"), reanchored: true, row: "in_flight", outcome: { kind: "recorded", evidence: "E3", decidedSeq: hub.seq + 1, decidedAt: 1, verifiedInRun: null } }));
  assert.equal(settled.relay.reanchor, false);
  // A fresh binding (no packet in its epoch) never sets it.
  const fresh = initialBindingRelay([], "fresh", "fresh-acp", "new");
  assert.equal(applied(step(fresh, { kind: "compaction", cursor: { count: 3, digest: sha("moved") }, ran: true })).relay.reanchor, false);
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

// ---------------------------------------------------------------------------------------------------------------------
// Phase two: the state machine wired into the formal Runtime (relay-coordinator.ts)
// ---------------------------------------------------------------------------------------------------------------------
//
// The cases below run through the formal SessionRuntime and a real SqliteSessionStore (with recoverRelay, as the composition
// root builds it) on temporary data roots. The Harness is an in-process fake control whose native history is the reference
// model of relay-harness-peer.mjs, reached over its real IPC channel: every input it is handed becomes a user entry there (or
// not, or late), and the Driver's check (verifyDelivered) and position (deliveryPosition) are the model's answers. What the
// Hub concludes is read back from the Store; what the native session holds is read from the model.

/** The fakes' relay declaration: the generic ACP Driver's, with one text per prompt and the shared reading of slash words. */
// The declaration's reading reads the catalog it is given (the shared reading over relay entries), as a Driver's must: since
// G072 the Runtime reads an input by the declaration (C7), so a reading that ignored its catalog would read every command as
// a possible one.
const BASE_RELAY: RelayCapabilities = { ...dshRelayCapabilities, placement: { ...dshRelayCapabilities.placement, parts: "single", measure: measureBy("single", "chars", ["file"]) },
  commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: sharedClassify } };
function declared(overrides: { readonly verify?: RelayCapabilities["delivery"]["verify"]; readonly live?: RelayCapabilities["delivery"]["live"]; readonly lateDelivery?: boolean;
    readonly successProvesRecorded?: boolean; readonly execution?: RelayCapabilities["execution"]; readonly probed?: boolean; readonly compactionEvidence?: RelayCapabilities["compactionEvidence"] } = {}): RelayCapabilities {
  return { ...BASE_RELAY, probed: overrides.probed ?? false, execution: overrides.execution ?? "process", compactionEvidence: overrides.compactionEvidence ?? "event",
    delivery: { live: overrides.live ?? "none", verify: overrides.verify ?? "none", successProvesRecorded: overrides.successProvesRecorded ?? false, lateDelivery: overrides.lateDelivery ?? false } };
}
const NATIVE_COMMANDS: readonly NativeCommand[] = [{ name: "compact", description: "compact", contextEffect: "compact" }, { name: "clear", description: "clear", contextEffect: "clear" },
  { name: "undo", description: "undo", contextEffect: "rewind" }, { name: "review", description: "review", contextEffect: "keep" }];
const RECORDED: BackendResult = { status: "completed", reason: "fake", input: "recorded" };
const NO_EVIDENCE: BackendResult = { status: "completed", reason: "fake" };
/**
 * How one prompt goes: whether the native side writes its entry (now, late, never), how the Turn ends, and E1; `outputs`
 * replaces the reply text with these events (G068 fix batch: a Turn that shows only a plan or usage).
 */
interface Script { readonly insert?: "now" | "late" | "never"; readonly result?: BackendResult | "hold" | "lost"; readonly e1?: RelayPacketId | "own" | null; readonly native?: BackendResult["native"]; readonly outputs?: readonly ControlEvent[];
  /** false: a command does nothing to the native history (a /clear that did not run, G068 fix batch 2, M-1). */
  readonly effect?: false }
/**
 * How a check answers (G068 fix batch R2, R7): the reference model's answer; a rejection; `die`, a request that fails the
 * connection (healthy() false, its close reports the failure, as a Driver that aborts it at a timeout); `hang`, one that never
 * answers; `hang-die`, one that answers nothing and fails the connection after `ms`; or a raw value the Driver returns.
 */
type CheckFault = "model" | "throw" | "die" | "hang" | { readonly dieAfterMs: number } | { readonly raw: (request: VerifyRequest) => unknown };
/**
 * In-process fake controls over the reference model: a native session per open without a checkpoint, resumed by its
 * checkpoint; commands act on the model (/compact folds, /clear empties, /undo removes the last user entry). `script` says
 * how each input goes. With `admission` the factory also answers the static declarations (the 409 at send); `readable`
 * false makes every check answer unavailable.
 */
class ModelHarnesses implements SessionBindingFactory {
  readonly prompts: { readonly harnessId: string; readonly text: string; readonly turn: TurnText; readonly session: string }[] = [];
  readonly holds: { readonly resolve: (result: BackendResult) => void; readonly reject: (error: Error) => void }[] = [];
  readable = true;
  attachmentsHeld: Promise<void> | null = null;
  script: (harnessId: string, input: string) => Script = () => ({});
  /** How each check answers (CheckFault); calls of the relay's reads are counted. */
  check: (harnessId: string) => CheckFault = () => "model";
  verifies = 0;
  positions = 0;
  /** Native sessions whose resume (an open with their checkpoint) fails, as an abandoned session never prompted (R4). */
  readonly unresumable = new Set<string>();
  /** The checkpoints each open was given, in order (undefined: a new native session). */
  readonly opens: (string | undefined)[] = [];
  private opened = 0;
  /**
   * G068 fix batch 2. `missing`: native sessions the Harness no longer has; their resume is refused as NATIVE_SESSION_NOT_FOUND
   * and, as the ACP Driver does, the refused open fails the connection (C5). `strictResume`: a native session never prompted
   * cannot be resumed by another process (claude-agent-acp), a plain control failure (I-1). `position`: how each position read
   * answers. `onDispatch`: runs once a Turn is dispatched, before its outputs. `breakAtAttachments`: the connection fails while
   * the attachments are checked, after the authorization (M-2). `catalogFails`: the catalog cannot be read. `closeFails`: the
   * program's close rejects (M-8). `prepared`: how many programs were started.
   */
  readonly missing = new Set<string>();
  strictResume = false;
  private readonly prompted = new Set<string>();
  position: (harnessId: string) => "model" | "die" = () => "model";
  onDispatch: ((harnessId: string, input: string) => void) | null = null;
  breakAtAttachments = false;
  catalogFails = false;
  closeFails = false;
  prepared = 0;
  constructor(private readonly peer: Peer, readonly declarations: Readonly<Record<string, RelayCapabilities>>, private readonly admission = false) {}
  relayCapabilities?(selection: HarnessSelection): RelayCapabilities | null;
  enableAdmission(): void { this.relayCapabilities = selection => this.declarations[selection.harnessId] ?? null; }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (this.declarations[request.harnessId] === undefined) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId, peer = this.peer;
    this.prepared += 1;
    let session: string | null = null, dead: SessionError | null = null;
    const held: { readonly resolve: (result: BackendResult) => void; readonly reject: (error: Error) => void }[] = [];
    const die = () => { dead ??= new SessionError("REQUEST_TIMEOUT", "the check exceeded its deadline and the connection was aborted"); return dead; };
    const control: HarnessControl = {
      relayCapabilities: this.declarations[harnessId]!,
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "model", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => {
        this.opens.push(checkpoint);
        if (checkpoint !== undefined && this.missing.has(checkpoint)) { dead ??= new SessionError("NATIVE_SESSION_NOT_FOUND", "the Harness has no session with this identity"); throw dead; }
        if (checkpoint !== undefined && (this.unresumable.has(checkpoint) || this.strictResume && !this.prompted.has(checkpoint))) throw new SessionError("CONTROL_FAILED", "Resource not found: session " + checkpoint);
        session = checkpoint ?? "native-" + harnessId + "-" + ++this.opened; return nativeConversationId(session);
      },
      checkpoint: async () => session,
      healthy: () => dead === null,
      models: async () => {
        if (this.catalogFails) throw new SessionError("CONTROL_FAILED", "the catalog could not be read");
        return { models: [{ id: "model-a", name: "A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: NATIVE_COMMANDS };
      },
      classify: (text, catalog) => listedCommand(text, catalog),
      checkAttachments: async () => { if (this.breakAtAttachments) die(); if (this.attachmentsHeld !== null) await this.attachmentsHeld; },
      deliveryPosition: async () => {
        this.positions += 1;
        if (this.position(harnessId) === "die") throw die();
        return peer.call<DeliveryPosition>("position", { session });
      },
      verifyDelivered: async (_id, request) => {
        this.verifies += 1;
        const how = this.check(harnessId);
        if (how === "throw") throw new Error("the check was refused");
        if (how === "die") throw die();
        if (how === "hang") return new Promise<VerifyResult>(() => {});
        if (typeof how === "object" && "dieAfterMs" in how) return new Promise<VerifyResult>((_resolve, reject) => { setTimeout(() => reject(die()), how.dieAfterMs); });
        if (typeof how === "object") return how.raw(request) as VerifyResult;
        return peer.call<VerifyResult>("verify", { session, readable: this.readable,
          markers: request.markers.map(marker => ({ packetId: marker.packetId, after: marker.position.kind === "seq" ? marker.position.before : 0 })) });
      },
      startText: async (_id, turn, output) => {
        if (dead !== null) throw dead;
        const text = singleText(turn), input = typeof turn === "string" ? turn : turn.user, packetId = typeof turn === "string" ? null : turn.relay.packetId;
        this.prompts.push({ harnessId, text, turn, session: session! }); this.prompted.add(session!);
        const plan = this.script(harnessId, input), name = /^\/(\S+)/u.exec(input)?.[1];
        if (plan.effect === false) { /* a command that did nothing to the native history */ }
        else if (name === "compact") await peer.call("compact", { session, keep: 1 });
        else if (name === "clear") await peer.call("clear", { session });
        else if (name === "undo") await peer.call("rewind", { session, n: 1 });
        else await peer.call("send", { session, runId: "entry-" + this.prompts.length, packetId, facts: [], insert: plan.insert ?? "now" });
        this.onDispatch?.(harnessId, input);
        if (plan.e1 !== undefined && plan.e1 !== null) output({ type: "input_recorded", ...(plan.e1 === "own" ? (packetId === null ? {} : { packetId }) : { packetId: plan.e1 }) });
        if (plan.outputs !== undefined) for (const value of plan.outputs) output(value);
        else if (plan.result !== "lost") output({ type: "text", text: "reply from " + harnessId });
        const ending = plan.result ?? RECORDED;
        const result = ending === "hold" ? new Promise<BackendResult>((resolve, reject) => { const hold = { resolve, reject }; held.push(hold); this.holds.push(hold); })
          : ending === "lost" ? new Promise<BackendResult>((_resolve, reject) => { setImmediate(() => reject(new SessionError("CONTROL_FAILED", "the connection ended without a result"))); })
          : Promise.resolve({ ...ending, ...(plan.native === undefined ? {} : { native: plan.native }) });
        return { result, requestStop: async () => { for (const hold of held.splice(0)) hold.resolve({ status: "cancelled", reason: "stopped" }); return { requested: true }; } };
      },
      close: async () => {
        for (const hold of held.splice(0)) hold.reject(new SessionError("CLOSED", "the program was ended"));
        if (this.closeFails) throw new SessionError("CLOSE_REFUSED", "the program could not be ended");
        return dead === null ? clean : { closed: true, exitCode: null, signal: "SIGTERM", protocolFailure: { code: dead.code, message: dead.message } };
      },
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  /** What reached `harnessId`, flattened as the Driver sent it. */
  to(harnessId: string): readonly string[] { return this.prompts.filter(row => row.harnessId === harnessId).map(row => row.text); }
  last(harnessId: string): { readonly text: string; readonly turn: TurnText; readonly session: string } { return this.prompts.filter(row => row.harnessId === harnessId).at(-1)!; }
}
interface RuntimeWorld { readonly data: string; store: SqliteSessionStore; readonly configuration: SessionConfiguration; readonly peer: Peer; runtime(factory: SessionBindingFactory, options?: Partial<SessionRuntimeOptions>): SessionRuntime }
async function runtimeWorld(t: TestContext): Promise<RuntimeWorld> {
  const root = temporary(t), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  const peer = await startPeer(t), runtimes: SessionRuntime[] = [];
  const world: RuntimeWorld = { data, store: new SqliteSessionStore(data, { recoverRelay }), peer,
    configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    runtime(factory, options = {}) {
      let next = 0;
      const app = new SessionRuntime(world.store, factory, { id: () => "g068-" + ++next + "-" + runtimes.length, now: () => new Date(Date.UTC(2026, 10, 10, 12)), publish: () => {},
        fingerprint: value => createHash("sha256").update(value).digest("hex"), ...options });
      runtimes.push(app); return app;
    } };
  // These cases are about delivery, and the delivery cases of the strict design ask the user where the policy would settle it
  // (RELAY_CHOICE_REQUIRED, the Run failed before dispatch): the question is on, the gates keep their permissive defaults.
  askWhenUnsure(world.store);
  t.after(async () => {
    for (const app of runtimes) { try { await app.close(); } catch { /* a runtime whose store was closed under it (a crash) ends failed */ } }
    try { world.store.close(); } catch { /* closed by the test */ }
  });
  return world;
}
function allEvents(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
/** The latest event of `type` of a Run: its own (`runId`), or for relay.verified the check made in it (`inRunId`). */
function eventOf(store: SqliteSessionStore, id: SessionId, type: string, run: string): SessionEvent | undefined {
  return allEvents(store, id).findLast(row => row.type === type && (type === "relay.verified" ? row.data.inRunId : row.data.runId) === run);
}
async function turn(app: SessionRuntime, id: SessionId, text: string, key: string, relay?: RelayChoice): Promise<PublicRun> {
  const receipt = app.send(id, text, key, [], relay);
  await app.wait(id).catch((error: unknown) => { if (!(error instanceof SessionError && error.code === "SESSION_BLOCKED")) throw error; });
  return app.read(id).runs.find(row => row.id === receipt.runId)!;
}
async function to(app: SessionRuntime, id: SessionId, harnessId: string, key: string): Promise<void> { app.switch(id, { harnessId }, key); await app.wait(id); assert.equal(app.read(id).selection.harnessId, harnessId); }
function bindingRelay(state: SessionSnapshot, harnessId: string): BindingRelayState { return state.nativeBindings!.find(row => row.harnessId === harnessId && row.status !== "archived")!.relay!; }
function rowOf(store: SqliteSessionStore, id: SessionId, run: string): DeliveryRecord | undefined { return store.relayDeliveries(id).find(row => row.runId === run); }
function packetIdIn(turn: TurnText): RelayPacketId | null { return typeof turn === "string" ? null : turn.relay.packetId; }
const relayError = (code: string, reason?: string) => (error: unknown) => error instanceof RelayError && error.code === code && (reason === undefined || error.reason === reason);

test("G068-C06 (Runtime) A→B→A through the formal Runtime and the reference model: bravo gets a packet recorded by E1; back on alpha only bravo's Turns go, unconfirmed and then found at the next open (E2); every other input goes as typed", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared({ live: "recorded_event", verify: "after_turn" }) });
  fake.script = (harnessId, input) => harnessId === "bravo" ? { e1: "own" } : input === "a3 carries bravo's turns" ? { result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "alpha" }, "create"), id = session.id;
  const a1 = await turn(app, id, "a1 on alpha", "a1"), a2 = await turn(app, id, "a2 on alpha", "a2");
  assert.deepEqual(fake.to("alpha"), ["a1 on alpha", "a2 on alpha"], "a single Harness is never injected");
  await to(app, id, "bravo", "to-b");
  const b1 = await turn(app, id, "b1 on bravo", "b1"), b2 = await turn(app, id, "b2 on bravo", "b2");
  const toBravo = fake.prompts.find(row => row.harnessId === "bravo")!;
  assert.equal(typeof toBravo.turn, "object", "the Driver is handed the packet and the words apart (TurnText)");
  assert.deepEqual(readRelayPrompt(toBravo.text).history.map(row => row.user.text), [a1.input, a2.input]); assert.equal(readRelayPrompt(toBravo.text).currentInput.text, b1.input);
  assert.equal(fake.to("bravo")[1], b2.input, "once recorded, nothing is owed");
  // E1: the delivery recorded by the live event, committed before the Turn's end, the binding synced on the packet.
  const p1 = packetIdIn(toBravo.turn)!, e1 = eventOf(w.store, id, "relay.input_recorded", b1.id)!, ended = eventOf(w.store, id, "run.ended", b1.id)!;
  assert.equal(rowOf(w.store, id, b1.id)?.outcome.kind === "recorded" && (rowOf(w.store, id, b1.id)!.outcome as { readonly evidence: string }).evidence, "E1");
  assert.ok(e1.seq < ended.seq, "E1 before the settlement"); assert.equal((e1.data.mark as DeliveredMark).lastPacketId, p1);
  assert.deepEqual(ended.data.delivery, { packetId: p1, outcome: "recorded", evidence: "E1", mark: null }, "the settlement found it recorded already");
  assert.equal(markOf(bindingRelay(app.read(id), "bravo").sync)?.lastPacketId, p1);
  assert.ok((await w.peer.call<{ readonly packets: readonly string[] }>("held", { session: toBravo.session })).packets.includes(p1), "the reference model holds it");
  // Back on alpha: only bravo's two Turns (alpha's own are no foreign facts to it), as a delta; no evidence → pending.
  await to(app, id, "alpha", "to-a");
  const a3 = await turn(app, id, "a3 carries bravo's turns", "a3"), toAlpha = fake.last("alpha");
  assert.deepEqual(a3.sourceRunIds, [b1.id, b2.id]); assert.equal(readRelayPrompt(toAlpha.text).kind, "delta");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending"); assert.equal(rowOf(w.store, id, a3.id)?.outcome.kind, "unknown");
  assert.equal(rowOf(w.store, id, a3.id)?.position.kind, "seq", "the position read before dispatch is kept with the row");
  // The next open checks the pending packet's own title line: found (E2), committed with the preparation; the input goes as typed.
  const a4 = await turn(app, id, "a4 as typed", "a4");
  assert.equal(fake.to("alpha").at(-1), a4.input);
  const p2 = packetIdIn(toAlpha.turn)!, verified = eventOf(w.store, id, "relay.verified", a4.id)!, row = rowOf(w.store, id, a3.id)!;
  assert.deepEqual(row.outcome, { kind: "recorded", evidence: "E2", decidedSeq: verified.seq, decidedAt: row.outcome.kind === "recorded" ? row.outcome.decidedAt : 0, verifiedInRun: a4.id });
  assert.equal(verified.data.result, "recorded"); assert.equal(verified.data.plan, "pending");
  assert.ok(verified.seq < eventOf(w.store, id, "run.context_prepared", a4.id)!.seq, "the check is committed with the preparation, before the authorization");
  assert.equal(markOf(bindingRelay(app.read(id), "alpha").sync)?.lastPacketId, p2);
  // The read path finds that mark again from its event: the next open checks the synced binding's last packet and keeps it.
  const a5 = await turn(app, id, "a5 as typed", "a5");
  assert.equal(fake.to("alpha").at(-1), a5.input); assert.equal(eventOf(w.store, id, "relay.verified", a5.id)?.data.result, "kept");
  assert.deepEqual(app.read(id).runs.find(row2 => row2.id === a5.id)?.relay?.executedOn, { harnessId: "alpha", controlId: "alpha-acp", nativeEpoch: 1 });
});

test("G068-C02 (Runtime) a pending packet: one automatic resend, then admission's synchronous 409 (no Run made); attach none goes alone and keeps it pending; the user's resend is recorded; lateDelivery never resends by itself", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none" }), bravo: declared(), late: declared({ verify: "none", lateDelivery: true }) });
  fake.enableAdmission();
  fake.script = (_harnessId, input) => input.startsWith("lost") ? { insert: "never", result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1");
  await to(app, id, "alpha", "to-a");
  const a1 = await turn(app, id, "lost first packet", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending");
  const a2 = await turn(app, id, "lost resend", "a2");
  assert.equal(rowOf(w.store, id, a2.id)?.resendOf, a1.id, "sent again once, automatically");
  const sync = bindingRelay(app.read(id), "alpha").sync;
  assert.equal(sync.kind === "pending" && sync.autoResends, 1);
  const runs = app.read(id).runs.length;
  assert.throws(() => app.send(id, "needs a choice", "a3"), relayError("RELAY_CHOICE_REQUIRED", "delivery_unconfirmed"), "admission asks the user (409)");
  assert.equal(app.read(id).runs.length, runs, "no Run was made");
  const before = JSON.stringify(bindingRelay(app.read(id), "alpha"));
  const alone = await turn(app, id, "only this", "a4", { attach: "none" });
  assert.equal(fake.to("alpha").at(-1), alone.input, "alone: exactly as typed"); assert.equal(JSON.stringify(bindingRelay(app.read(id), "alpha")), before, "n changes nothing");
  assert.equal(rowOf(w.store, id, alone.id), undefined, "no delivery row");
  const again = await turn(app, id, "send it again", "a5", { resend: true });
  assert.equal(again.status, "completed"); assert.equal(rowOf(w.store, id, again.id)?.resendOf, a2.id);
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced");
  // lateDelivery: the first unknown is never resent by itself.
  await to(app, id, "late", "to-late");
  await turn(app, id, "lost on late", "l1");
  assert.equal(bindingRelay(app.read(id), "late").sync.kind, "pending");
  assert.throws(() => app.send(id, "next on late", "l2"), relayError("RELAY_CHOICE_REQUIRED", "delivery_unconfirmed"));
});

test("G068 (Runtime) a Driver that checks at the open is let through admission; a pending packet its check cannot see, already resent once, fails that Run before dispatch with RELAY_CHOICE_REQUIRED, and the native session is kept", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { hermes: declared({ verify: "on_next_open" }), bravo: declared() });
  fake.enableAdmission();
  fake.script = (_harnessId, input) => input.startsWith("lost") ? { insert: "never", result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "hermes", "to-h");
  await turn(app, id, "lost first", "h1"); await turn(app, id, "lost resend", "h2");
  fake.readable = false;
  const sent = fake.prompts.length, asked = await turn(app, id, "check cannot see it", "h3");
  assert.equal(asked.status, "failed"); assert.equal(asked.error?.code, "RELAY_CHOICE_REQUIRED");
  assert.deepEqual(eventOf(w.store, id, "run.ended", asked.id)?.data.relay, { reason: "delivery_unconfirmed" });
  assert.deepEqual(asked.relay?.continuity, { kind: "blocked", code: "RELAY_CHOICE_REQUIRED" });
  assert.equal(fake.prompts.length, sent, "not dispatched");
  assert.equal(eventOf(w.store, id, "relay.verified", asked.id)?.data.result, "unconfirmed", "the open's check is a fact, committed with the Run's end");
  assert.equal(app.read(id).nativeBindings!.find(row => row.harnessId === "hermes")!.status, "ready", "the native session stays for the next Turn");
});

test("G068 (Runtime) the three causes: verify_required at admission for a suspect binding no check can settle, marker_absent found at the open; the complete packet on the user's choice (attach full) moves the mark back and sends what is owed", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none", successProvesRecorded: true }), hermes: declared({ verify: "on_next_open", successProvesRecorded: true }), bravo: declared() });
  fake.enableAdmission();
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  const b1 = await turn(app, id, "b1 a fact", "b1");
  // verify_required: alpha (no check) synced on a packet, then /undo (rewind): suspect with a mark on a packet nothing can check.
  await to(app, id, "alpha", "to-a");
  await turn(app, id, "a1 carries b1", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced");
  await turn(app, id, "/undo", "undo");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "suspect");
  await to(app, id, "bravo", "to-b"); const b2 = await turn(app, id, "b2 another fact", "b2"); await to(app, id, "alpha", "to-a2");
  assert.throws(() => app.send(id, "carry on", "a2"), relayError("RELAY_CHOICE_REQUIRED", "verify_required"));
  const full = await turn(app, id, "carry on", "a3", { attach: "full" });
  assert.equal(full.status, "completed"); assert.deepEqual(full.sourceRunIds, [b1.id, b2.id], "the complete packet again, from the epoch's base");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced");
  assert.equal(eventOf(w.store, id, "run.context_prepared", full.id)?.data.retreat, true);
  // marker_absent: hermes synced on its packet, which the user then removes in the original program; the open's check finds it absent.
  await to(app, id, "hermes", "to-h");
  await turn(app, id, "h1 carries", "h1");
  const hermesSession = fake.last("hermes").session;
  assert.equal(bindingRelay(app.read(id), "hermes").sync.kind, "synced");
  await w.peer.call("rewind", { session: hermesSession, n: 1 });
  await to(app, id, "bravo", "to-b2"); await turn(app, id, "b3 a third fact", "b3"); await to(app, id, "hermes", "to-h2");
  const absent = await turn(app, id, "what now", "h2");
  assert.equal(absent.error?.code, "RELAY_CHOICE_REQUIRED"); assert.deepEqual(eventOf(w.store, id, "run.ended", absent.id)?.data.relay, { reason: "marker_absent" });
  assert.equal(bindingRelay(app.read(id), "hermes").sync.kind === "suspect" && (bindingRelay(app.read(id), "hermes").sync as { readonly cause: string }).cause, "marker_absent");
  assert.throws(() => app.send(id, "what now", "h3"), relayError("RELAY_CHOICE_REQUIRED", "marker_absent"), "now admission knows it");
  const resent = await turn(app, id, "what now", "h4", { attach: "full" });
  assert.equal(resent.status, "completed"); assert.ok(isPacketText(fake.last("hermes").text));
});
function isPacketText(text: string): boolean { return readRelayPrompt(text).packet; }

test("G068-C03/C05 (Runtime) a clear: confirmed by the Driver (native.cleared) starts a new epoch and the next inputs go as typed, attach full once brings the history back; unconfirmed, the next open's replay decides; a check that cannot decide is settled by the user's ［确认已清空］", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open", successProvesRecorded: true }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "/clear" && confirming ? { native: { cleared: true, replaced: null } } : {};
  let confirming = true;
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  const b1 = await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  const a1 = await turn(app, id, "a1 carries b1", "a1");
  const clear = await turn(app, id, "/clear", "clear");
  const cleared = bindingRelay(app.read(id), "alpha");
  assert.deepEqual(cleared.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(cleared.nativeEpoch, 2); assert.equal(cleared.epochFloor, eventOf(w.store, id, "run.ended", clear.id)!.seq);
  // "附上交接单" right after the clear: the one-time attach ignores the floor (alpha's own epoch-1 Turn is foreign to epoch 2 now).
  const attached = await turn(app, id, "bring the history", "attach", { attach: "full" });
  assert.deepEqual(attached.sourceRunIds, [b1.id, a1.id]); assert.equal(rowOf(w.store, id, attached.id)?.attachOverride, true);
  for (let index = 0; index < 20; index++) { const input = await turn(app, id, "after clear " + index, "c" + index); assert.equal(fake.to("alpha").at(-1), input.input, "as typed"); }
  // Unconfirmed: suspect{clear_unconfirmed}; the next open replays an empty history and confirms it.
  confirming = false;
  await to(app, id, "bravo", "to-b"); await turn(app, id, "b2", "b2"); await to(app, id, "alpha", "to-a2");
  await turn(app, id, "carry b2", "carry");
  const unconfirmed = await turn(app, id, "/clear", "clear2");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "suspect");
  const replayed = await turn(app, id, "after the second clear", "after2");
  assert.equal(eventOf(w.store, id, "relay.verified", replayed.id)?.data.result, "cleared");
  assert.equal(bindingRelay(app.read(id), "alpha").epochFloor, eventOf(w.store, id, "run.ended", unconfirmed.id)!.seq); assert.equal(fake.to("alpha").at(-1), replayed.input);
  // A check that cannot decide (unavailable): the user confirms the clear; e at its floor candidate, as typed.
  await to(app, id, "bravo", "to-b3"); await turn(app, id, "b3", "b3"); await to(app, id, "alpha", "to-a3");
  await turn(app, id, "carry b3", "carry3");
  const third = await turn(app, id, "/clear", "clear3");
  fake.readable = false;
  await to(app, id, "bravo", "to-b4"); const b4 = await turn(app, id, "b4", "b4"); await to(app, id, "alpha", "to-a4");
  const stuck = await turn(app, id, "after the third clear", "after3");
  assert.equal(stuck.error?.code, "RELAY_CHOICE_REQUIRED", "the check cannot see the chain: the user decides");
  const confirmed = await turn(app, id, "after the third clear", "after3-confirmed", { clearConfirmed: true });
  assert.equal(confirmed.status, "completed");
  assert.ok(eventOf(w.store, id, "relay.clear_confirmed", confirmed.id), "the user's confirmation is recorded");
  assert.equal(bindingRelay(app.read(id), "alpha").epochFloor, eventOf(w.store, id, "run.ended", third.id)!.seq);
  assert.deepEqual(confirmed.sourceRunIds, [b4.id], "a confirmed clear owes nothing before it: only what came after it");
});

test("G068 (Runtime) command Turns: /compact on a binding with a packet in its epoch re-anchors it; Claude's synthesized clear archives the binding with its relay state and opens the next epoch in a new binding with the replacement session", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "after_turn", successProvesRecorded: true }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "/clear" ? { native: { cleared: true, replaced: { checkpoint: "native-alpha-replacement" } } } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").reanchor, false);
  const compact = await turn(app, id, "/compact", "compact");
  assert.equal(eventOf(w.store, id, "run.ended", compact.id)?.data.contextEffect, "compact");
  assert.equal(bindingRelay(app.read(id), "alpha").reanchor, true, "a compaction that ran re-anchors a binding with a packet in its epoch (F4)");
  const before = bindingRelay(app.read(id), "alpha");
  const clear = await turn(app, id, "/clear", "clear");
  const bindings = app.read(id).nativeBindings!.filter(row => row.harnessId === "alpha");
  assert.equal(bindings.length, 2); assert.equal(bindings[0]!.status, "archived"); assert.deepEqual(bindings[0]!.relay, before, "archiving freezes the relay state");
  assert.equal(bindings[1]!.checkpoint, "native-alpha-replacement"); assert.deepEqual(bindings[1]!.relay!.sync, { kind: "fresh", basis: "user_cleared" });
  assert.equal(bindings[1]!.relay!.nativeEpoch, before.nativeEpoch + 1); assert.equal(bindings[1]!.relay!.epochFloor, eventOf(w.store, id, "run.ended", clear.id)!.seq);
  const after = await turn(app, id, "after the clear", "after");
  assert.equal(fake.last("alpha").session, "native-alpha-replacement", "the next Turn opens the replacement session"); assert.equal(fake.to("alpha").at(-1), after.input);
});

test("G068-C09 (Runtime) D6: a probed process Driver's Turn that ended unknown after its program was seen to end continues the original session: the binding is ready and suspect{unknown_turn}, and the next open's check moves it (there → E2, not there → the prior); an unprobed one stays unconfirmed", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open", probed: true }), gateway: declared({ verify: "on_next_open", execution: "gateway" }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "lost but written" ? { insert: "now", result: "lost" } : input === "lost unwritten" ? { insert: "never", result: "lost" } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a");
  const lost = await turn(app, id, "lost but written", "a1");
  assert.equal(lost.status, "unknown"); assert.equal(app.read(id).status, "blocked");
  const binding = app.read(id).nativeBindings!.find(row => row.harnessId === "alpha")!;
  assert.equal(binding.status, "ready", "the Hub saw the program end: the original session may be continued");
  assert.equal(binding.relay!.sync.kind === "suspect" && binding.relay!.sync.cause, "unknown_turn");
  assert.equal(binding.relay!.sync.kind === "suspect" && binding.relay!.sync.carried?.packetId, packetIdIn(fake.last("alpha").turn));
  assert.equal(eventOf(w.store, id, "run.ended", lost.id)?.data.continued, true);
  assert.equal(rowOf(w.store, id, lost.id)?.outcome.kind, "unknown");
  app.resume(id, { harnessId: "alpha" }, "recover", true); await app.wait(id);
  const next = await turn(app, id, "continue the original", "a2");
  assert.equal(next.status, "completed"); assert.equal(fake.last("alpha").session, fake.prompts.find(row => row.harnessId === "alpha")!.session, "the original native session, resumed");
  assert.equal(rowOf(w.store, id, lost.id)?.outcome.kind === "recorded" && (rowOf(w.store, id, lost.id)!.outcome as { readonly evidence: string }).evidence, "E2");
  assert.equal(fake.to("alpha").at(-1), next.input, "its packet was there: nothing is owed, never re-run");
  // Not written: back to the prior, and the next input owes the facts again.
  await to(app, id, "bravo", "to-b2"); await turn(app, id, "b2", "b2"); await to(app, id, "alpha", "to-a2");
  await turn(app, id, "lost unwritten", "a3");
  app.resume(id, { harnessId: "alpha" }, "recover2", true); await app.wait(id);
  const owedAgain = await turn(app, id, "after the lost one", "a4");
  assert.equal(eventOf(w.store, id, "relay.verified", owedAgain.id)?.data.result, "retreated");
  assert.ok(isPacketText(fake.last("alpha").text), "the facts go again");
  // A gateway Driver's viewer leaving is no evidence of an end (INV-12): the binding stays unconfirmed.
  await to(app, id, "gateway", "to-g");
  fake.script = () => ({ insert: "now", result: "lost" });
  await turn(app, id, "lost on the gateway", "g1");
  assert.equal(app.read(id).nativeBindings!.find(row => row.harnessId === "gateway")!.status, "unconfirmed");
});

test("G068-C08 (Runtime) crash injection with the composition root's recoverRelay: dispatched and held → unknown{owner_ended}, still pending; E1 committed before the crash stays recorded", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open", live: "recorded_event" }), bravo: declared() });
  // Two conversations in two workspaces, so both Turns run at once (one workspace takes one Turn at a time, ADR-036).
  const other = join(w.configuration.workspace, "..", "workspace-2"); mkdirSync(other);
  const app = w.runtime(fake), first = await app.create(w.configuration, { harnessId: "bravo" }, "first"), second = await app.create({ ...w.configuration, workspace: other }, { harnessId: "bravo" }, "second");
  for (const [session, key] of [[first, "k9"], [second, "k11"]] as const) { await turn(app, session.id, "b1 " + key, key + "-b1"); await to(app, session.id, "alpha", key + "-to-a"); }
  fake.script = (_harnessId, input) => input === "held k9" ? { result: "hold" } : input === "held k11" ? { result: "hold", e1: "own" } : {};
  for (const [session, key] of [[first, "k9"], [second, "k11"]] as const) {
    app.send(session.id, "held " + key, key + "-held");
    for (const deadline = Date.now() + 5000; fake.holds.length < (key === "k9" ? 1 : 2);) { assert.ok(Date.now() < deadline, "dispatched"); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  for (const deadline = Date.now() + 5000; !allEvents(w.store, second.id).some(row => row.type === "relay.input_recorded");) { assert.ok(Date.now() < deadline, "E1 committed"); await new Promise(resolve => setTimeout(resolve, 5)); }
  // The owner ends without settling anything: its Store goes away under the Runtime, and the next owner recovers.
  w.store.close();
  w.store = new SqliteSessionStore(w.data, { recoverRelay });
  const k9 = w.store.get(first.id), k9run = k9.runs.at(-1)!;
  assert.equal(k9run.status, "unknown");
  assert.equal(w.store.relayDeliveries(first.id).find(row => row.runId === k9run.id)?.outcome.kind === "unknown" && (w.store.relayDeliveries(first.id).find(row => row.runId === k9run.id)!.outcome as { readonly reason: string }).reason, "owner_ended");
  assert.equal(bindingRelay(k9, "alpha").sync.kind, "pending", "checked at the next open, never re-run");
  const k11 = w.store.get(second.id), k11run = k11.runs.at(-1)!;
  assert.equal(w.store.relayDeliveries(second.id).find(row => row.runId === k11run.id)?.outcome.kind, "recorded", "E1 committed before the owner ended stays");
  assert.equal(bindingRelay(k11, "alpha").sync.kind, "synced");
  for (const hold of fake.holds) hold.reject(new SessionError("CLOSED", "owner gone"));
});

test("G068 (Runtime) a delivery row that is gone (damaged data): the open's check marks it rowMissing in relay.verified, and the resend names the Run whose relay carried the packet", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "lost" ? { insert: "never", result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a");
  const lost = await turn(app, id, "lost", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending");
  const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
  try { db.prepare("DELETE FROM relay_deliveries WHERE run_id=?").run(lost.id); } finally { db.close(); }
  const next = await turn(app, id, "next", "a2");
  const verified = eventOf(w.store, id, "relay.verified", next.id)!;
  assert.equal(verified.data.rowMissing, true); assert.equal(verified.data.plan, "skip:no_marker");
  assert.equal(rowOf(w.store, id, next.id)?.resendOf, lost.id, "resend.of from the Run whose relay names the packet");
});

test("G068 (Runtime) E1 and E3: a live event for another packet decides nothing and the settlement's E3 does; E1 for its own packet is committed before the end and the settlement then changes nothing", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ live: "recorded_event", verify: "none" }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "foreign e1" ? { e1: relayPacketId("relay-" + "a".repeat(20)) } : input === "own e1" ? { e1: "own", result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a");
  const foreign = await turn(app, id, "foreign e1", "a1");
  assert.equal(eventOf(w.store, id, "relay.input_recorded", foreign.id), undefined);
  assert.equal((rowOf(w.store, id, foreign.id)!.outcome as { readonly evidence: string }).evidence, "E3");
  await to(app, id, "bravo", "to-b"); await turn(app, id, "b2", "b2"); await to(app, id, "alpha", "to-a2");
  const own = await turn(app, id, "own e1", "a2");
  const e1 = eventOf(w.store, id, "relay.input_recorded", own.id)!, ended = eventOf(w.store, id, "run.ended", own.id)!;
  assert.ok(e1.seq < ended.seq); assert.equal((rowOf(w.store, id, own.id)!.outcome as { readonly evidence: string }).evidence, "E1");
  assert.ok(own.timing?.recordedAt !== undefined && own.timing.recordedAt >= own.timing.dispatchedAt!, "recordedAt between dispatch and end");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced", "an end without evidence does not undo E1");
});

test("G068 (Runtime) cancel and late delivery: a Turn stopped after dispatch on a lateDelivery Driver is unknown{late_delivery} and never resent by itself; its late write is found at the next open (E2); a Turn stopped before dispatch leaves its packet not recorded and the binding as it was", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { late: declared({ verify: "on_next_open", lateDelivery: true }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "stopped late" ? { insert: "late", result: "hold" } : {};
  const content: ContentPort = { storeOutput: async () => { throw new Error("no outputs"); }, materialize: async refs => refs.map(ref => ({ ...ref, path: "/dev/null" })),
    resolve: ids => ids.map(item => ({ id: contentId(item), name: "note.txt", mediaType: "text/plain", kind: "file" as const, bytes: 4, sha256: "0".repeat(64) })) };
  const app = w.runtime(fake, { content }), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1", "b1"); await to(app, id, "late", "to-late");
  const stopped = app.send(id, "stopped late", "l1");
  for (const deadline = Date.now() + 5000; fake.holds.length < 1;) { assert.ok(Date.now() < deadline, "dispatched"); await new Promise(resolve => setTimeout(resolve, 5)); }
  app.cancel(id, "stop", stopped.runId); await app.wait(id);
  const run = app.read(id).runs.find(row => row.id === stopped.runId)!;
  assert.equal(run.status, "cancelled"); assert.equal((rowOf(w.store, id, run.id)!.outcome as { readonly reason: string }).reason, "late_delivery");
  await w.peer.call("flushLate", { session: fake.last("late").session });
  const found = await turn(app, id, "after the late write", "l2");
  assert.equal((rowOf(w.store, id, run.id)!.outcome as { readonly evidence: string }).evidence, "E2", "found after its position");
  assert.equal(fake.to("late").at(-1), found.input);
  // Stopped before dispatch (its attachments still being checked): the packet never left.
  await to(app, id, "bravo", "to-b"); await turn(app, id, "b2", "b2"); await to(app, id, "late", "to-late2");
  let release: () => void = () => {};
  fake.attachmentsHeld = new Promise<void>(resolve => { release = resolve; });
  const before = JSON.stringify(bindingRelay(app.read(id), "late"));
  const held = app.send(id, "with a file", "l3", ["content-note"]);
  for (const deadline = Date.now() + 5000; rowOf(w.store, id, held.runId) === undefined;) { assert.ok(Date.now() < deadline, "authorized"); await new Promise(resolve => setTimeout(resolve, 5)); }
  app.cancel(id, "stop-before", held.runId); release(); await app.wait(id);
  assert.equal((rowOf(w.store, id, held.runId)!.outcome as { readonly reason: string }).reason, "never_dispatched");
  assert.equal(JSON.stringify(bindingRelay(app.read(id), "late")), before, "back to the state before the packet");
});

test("G068-C07 (Runtime) a kept process is not reused while a Driver that checks at the open has its binding pending: it is closed (relay_check), the next Turn opens again, and the open's check finds the packet", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "carried, no evidence" ? { result: NO_EVIDENCE } : {};
  let prepared = 0;
  const prepare = fake.prepare.bind(fake);
  fake.prepare = async (...args) => { prepared += 1; return prepare(...args); };
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  app.setRetention(id, true, "keep");
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a");
  const plain = await turn(app, id, "carried, no evidence", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending"); assert.equal(app.keptProcess(id)?.harnessId, "alpha", "the process was kept");
  const before = prepared;
  const next = await turn(app, id, "next on alpha", "a2");
  assert.equal(prepared, before + 1, "the kept process was not reused: the program started again and opened the session");
  assert.ok(allEvents(w.store, id).some(row => row.type === "native.process_closed" && row.data.reason === "relay_check"));
  assert.equal(next.reused, undefined);
  assert.equal(rowOf(w.store, id, plain.id)?.outcome.kind, "recorded", "the open's check found it (E2)");
  assert.equal(fake.to("alpha").at(-1), next.input);
  // Synced again, the next Turn reuses the kept process (nothing to check at an open).
  const third = await turn(app, id, "and again", "a3");
  assert.equal(third.reused, true);
});

test("G068 (Runtime) a relay recovery that could not be written (the Session marked relayRecoveryFailed): an input that would carry relay content is refused synchronously with RELAY_UNAVAILABLE{recovery_failed}, an input that owes nothing or goes alone is not; a native reset clears it", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none" }), bravo: declared() });
  fake.enableAdmission();
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1", "a1"); await to(app, id, "bravo", "to-b");
  await app.close(); w.store.close();
  // The mark claimRecovery leaves when a Session's relay rows could not be written (ADR-055 §9 S15), set on an open Session:
  // in this Runtime a failed relay recovery leaves its conversation blocked on an unknown Turn without cleanup evidence
  // (RECOVERY_UNSAFE), so the admission check is reached only once such a conversation is open again (data repair).
  const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
  try {
    const stored = JSON.parse(String(db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id)!.snapshot)) as SessionSnapshot;
    db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...stored, relayRecoveryFailed: stored.lastSeq }), id);
  } finally { db.close(); }
  w.store = new SqliteSessionStore(w.data, { recoverRelay });
  const next = w.runtime(fake);
  assert.equal(next.read(id).relayRecoveryFailed !== undefined, true);
  assert.throws(() => next.send(id, "to bravo", "b2"), relayError("RELAY_UNAVAILABLE", "recovery_failed"), "bravo is owed alpha's Turn: carrying is refused");
  const alone = await turn(next, id, "to bravo, alone", "b3", { attach: "none" });
  assert.equal(alone.status, "completed", "an input sent alone is never stopped by the relay");
  next.resetNative(id, "reset", next.read(id).epoch);
  assert.equal(next.read(id).relayRecoveryFailed, undefined, "a native reset clears it");
  const after = await turn(next, id, "to bravo after the reset", "b4");
  assert.equal(after.status, "completed"); assert.ok(isPacketText(fake.last("bravo").text));
});

test("G068 the redacting wrapper passes the relay's optional members through as the inner Driver has them, and hands the TurnText on unchanged", async () => {
  const seen: TurnText[] = [];
  const inner: HarnessControl = { relayCapabilities: BASE_RELAY,
    initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "inner", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
    open: async () => nativeConversationId("inner"), close: async () => clean,
    deliveryPosition: async () => ({ kind: "seq", before: 7 }),
    verifyDelivered: async (_id, request) => ({ markers: request.markers.map(marker => ({ packetId: marker.packetId, result: "present" as const })), historyEmpty: false, compaction: null, foreignAfterLast: 0, verifyMs: 1 }),
    startText: async (_id, turn) => { seen.push(turn); return { result: Promise.resolve(RECORDED), requestStop: async () => ({ requested: true }) }; } };
  const wrapped = new RedactedHarnessControl(inner, text => text.replaceAll("secret", "[redacted]"), () => ({ push: text => text, flush: () => "" }));
  assert.equal(wrapped.relayCapabilities, BASE_RELAY, "the same declaration object");
  assert.deepEqual(await wrapped.deliveryPosition!(nativeConversationId("inner")), { kind: "seq", before: 7 });
  const packetId = relayPacketId("relay-" + "b".repeat(20));
  assert.deepEqual((await wrapped.verifyDelivered!(nativeConversationId("inner"), { markers: [{ packetId, position: { kind: "seq", before: 7 } }], historyEmpty: false })).markers, [{ packetId, result: "present" }]);
  assert.equal(wrapped.relayVendor, undefined, "absent stays absent"); assert.equal(wrapped.setTitle, undefined); assert.equal(wrapped.userTextOf, undefined);
  const turn: TurnText = { user: "the words", relay: { packetId, body: "〔packet〕", firstLine: true } };
  await (await wrapped.startText(nativeConversationId("inner"), turn, () => {})).result;
  assert.equal(seen[0], turn, "the TurnText object is handed on as it is");
});

// ---------------------------------------------------------------------------------------------------------------------
// The fix batch after the independent review of db39cbd (G068 phase two, R1–R10)
// ---------------------------------------------------------------------------------------------------------------------

/** Waits for `ready` (a few ms at a time), failing after `ms`. */
async function until(ready: () => boolean, what: string, ms = 5000): Promise<void> {
  for (const deadline = Date.now() + ms; !ready();) { assert.ok(Date.now() < deadline, what); await new Promise(resolve => setTimeout(resolve, 5)); }
}
/** A Turn bounded in time: a Turn that never ends fails the test instead of the suite's timeout. */
async function bounded(app: SessionRuntime, id: SessionId, text: string, key: string, ms: number, relay?: RelayChoice): Promise<PublicRun> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("the Turn did not end within " + ms + " ms")), ms); });
  try { return await Promise.race([turn(app, id, text, key, relay), late]); } finally { clearTimeout(timer); }
}
/**
 * alpha's fact a1, bravo synced on a packet of it (E3), then a /clear on bravo its Driver does not confirm: suspect
 * {clear_unconfirmed}. `unreadable` makes bravo's checks answer unavailable until the caller says otherwise. `ran` false: the
 * clear did nothing to bravo's native history. `replaced`: a later `/clear again` is Claude's synthesized clear, replacing the
 * native session by this one (null: none opened ahead). `admission`: the factory answers the static declarations.
 */
async function clearUnconfirmed(t: TestContext, verify: RelayCapabilities["delivery"]["verify"], unreadable = false, options: { readonly ran?: boolean; readonly replaced?: string | null; readonly admission?: boolean } = {}) {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared(), bravo: declared({ verify, successProvesRecorded: true }) });
  if (options.admission === true) fake.enableAdmission();
  fake.script = (_harnessId, input) => input === "/clear" && options.ran === false ? { effect: false }
    : input === "/clear again" && options.replaced !== undefined ? { native: { cleared: true, replaced: { checkpoint: options.replaced } } } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "alpha" }, "create"), id = session.id;
  const a1 = await turn(app, id, "a1 a fact on alpha", "a1"); await to(app, id, "bravo", "to-b");
  const b1 = await turn(app, id, "b1 carries a1", "b1");
  assert.deepEqual(b1.sourceRunIds, [a1.id]); assert.equal(bindingRelay(app.read(id), "bravo").sync.kind, "synced");
  fake.readable = !unreadable;
  const clear = await turn(app, id, "/clear", "clear");
  const sync = bindingRelay(app.read(id), "bravo").sync;
  assert.ok(sync.kind === "suspect" && sync.cause === "clear_unconfirmed", JSON.stringify(sync));
  return { w, fake, app, id, a1, b1, clear };
}
/** After the clear was confirmed after the fact: bravo's epoch rose, and `b2`, run on bravo between the clear and its confirmation, is not sent again. */
async function noRepeat(s: Awaited<ReturnType<typeof clearUnconfirmed>>, b2: PublicRun, next: PublicRun): Promise<void> {
  const { app, id, fake, w, clear } = s, relay = bindingRelay(app.read(id), "bravo");
  assert.equal(relay.nativeEpoch, 2, "the clear was confirmed: a new epoch"); assert.equal(relay.epochFloor, eventOf(w.store, id, "run.ended", clear.id)!.seq);
  assert.equal(b2.relay?.executedOn?.nativeEpoch, 1, "b2 ran on bravo before the confirmation, in the epoch the clear ended");
  assert.equal(next.status, "completed"); assert.deepEqual(next.sourceRunIds, [], "nothing is owed: b2 is in the history the clear left, a1 is below the floor");
  assert.equal(fake.to("bravo").at(-1), next.input, "as typed, no packet");
  const after = await turn(app, id, "b4 and on", "b4");
  assert.equal(fake.to("bravo").at(-1), after.input); assert.deepEqual(after.sourceRunIds, []);
}

test("G068 fix R1 (Runtime) a clear confirmed after the fact by the user's ［确认已清空］ (verify none): the Turn sent alone in between is not sent again", async t => {
  const s = await clearUnconfirmed(t, "none");
  const b2 = await turn(s.app, s.id, "b2 only this message", "b2", { attach: "none" });
  assert.equal(b2.status, "completed"); assert.equal(bindingRelay(s.app.read(s.id), "bravo").sync.kind, "suspect");
  const b3 = await turn(s.app, s.id, "b3 after confirming", "b3", { clearConfirmed: true });
  assert.ok(eventOf(s.w.store, s.id, "relay.clear_confirmed", b3.id));
  await noRepeat(s, b2, b3);
});

test("G068 fix R1 (Runtime) a clear confirmed after the fact by the next open's check (on_next_open, rule 4): the Turn sent alone in between is not sent again", async t => {
  const s = await clearUnconfirmed(t, "on_next_open");
  s.fake.readable = false;
  const b2 = await turn(s.app, s.id, "b2 only this message", "b2", { attach: "none" });
  assert.equal(bindingRelay(s.app.read(s.id), "bravo").sync.kind, "suspect", "the check could not see the chain");
  s.fake.readable = true;
  const b3 = await turn(s.app, s.id, "b3 next message", "b3");
  assert.equal(eventOf(s.w.store, s.id, "relay.verified", b3.id)?.data.result, "cleared");
  await noRepeat(s, b2, b3);
});

test("G068 fix R1 (Runtime) a clear confirmed after the fact by after_turn's check at a later Turn's own settlement: that Turn is not sent again", async t => {
  const s = await clearUnconfirmed(t, "after_turn", true);
  // b2 goes alone: its open asks the Driver nothing (G068 fix batch 2, M-3: a read there could only stop it), so its open's check
  // is answered unavailable without asking; the one at its settlement can see.
  s.fake.readable = true;
  let calls = 0;
  s.fake.check = () => { calls++; return "model"; };
  const b2 = await turn(s.app, s.id, "b2 only this message", "b2", { attach: "none" });
  assert.equal(calls, 1, "asked only at the settlement");
  assert.equal(allEvents(s.w.store, s.id).find(row => row.type === "relay.verified" && row.data.inRunId === b2.id && row.data.moment === "open")?.data.unasked, "alone", "the open's check names why it asked nothing");
  assert.equal(eventOf(s.w.store, s.id, "relay.verified", b2.id)?.data.result, "cleared", "b2's settlement check confirmed the clear");
  assert.equal(eventOf(s.w.store, s.id, "relay.verified", b2.id)?.data.moment, "settled");
  const b3 = await turn(s.app, s.id, "b3 next message", "b3");
  await noRepeat(s, b2, b3);
});

test("G068 fix R2 (Runtime) a check at the open that breaks the connection: the Turn is not dispatched (target_start), its packet not recorded, the binding ready, the conversation open; the next Turn goes", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  const a1 = await turn(app, id, "a1 carries b1, no evidence", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending");
  fake.check = () => "die";
  const sent = fake.prompts.length, a2 = await turn(app, id, "a2 meets a check that breaks the connection", "a2");
  assert.equal(a2.status, "failed"); assert.equal(a2.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(a2.timing?.dispatchedAt, undefined, "never dispatched");
  const ended = eventOf(w.store, id, "run.ended", a2.id)!;
  assert.equal((ended.data.relay as { readonly reason: string }).reason, "target_start");
  assert.equal((ended.data.relay as { readonly checkFailure?: { readonly code: string } }).checkFailure?.code, "REQUEST_TIMEOUT", "the connection's failure is recorded as the check's");
  assert.equal(a2.cleanup?.protocolFailure, null, "and not as the Turn's");
  assert.equal(fake.prompts.length, sent, "nothing reached the Harness");
  assert.equal(app.read(id).status, "open"); assert.equal(app.read(id).nativeBindings!.find(row => row.harnessId === "alpha")!.status, "ready", "the binding stays as it was");
  assert.equal(rowOf(w.store, id, a2.id), undefined, "no packet was authorized");
  fake.check = () => "model";
  // G068 fix batch 2, M-3: in this process the binding is not asked again (its check broke the connection once); the next Turn
  // goes with its check answered unavailable, and a1's packet is resent by itself.
  const verifies = fake.verifies, a3 = await turn(app, id, "a3 after it", "a3");
  assert.equal(a3.status, "completed"); assert.equal(fake.verifies, verifies, "not asked again in this process");
  assert.equal(eventOf(w.store, id, "relay.verified", a3.id)?.data.unasked, "connection"); assert.equal(rowOf(w.store, id, a3.id)?.resendOf, a1.id);
  // A new owner asks again.
  await app.close(); w.store.close();
  w.store = new SqliteSessionStore(w.data, { recoverRelay });
  const next = w.runtime(fake), a4 = await turn(next, id, "a4 under a new owner", "a4");
  assert.equal(a4.status, "completed"); assert.ok(fake.verifies > verifies, "the new owner's open asked the Driver");
  assert.equal(eventOf(w.store, id, "relay.verified", a4.id)?.data.unasked, undefined);
});

test("G068 fix R2 (Runtime) a check at the open that never answers is bounded: the Turn is not dispatched while it is outstanding, and ends within the bounds", { timeout: 30000 }, async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1, no evidence", "a1");
  fake.check = () => "hang";
  const sent = fake.prompts.length, started = Date.now(), a2 = await bounded(app, id, "a2 meets a check that never answers", "a2", 15000);
  assert.ok(Date.now() - started < 8000, "two bounds of 2 s, not forever: " + (Date.now() - started) + " ms");
  assert.equal(a2.status, "failed"); assert.equal(a2.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(fake.prompts.length, sent, "never dispatched while the check was outstanding");
  assert.equal(app.read(id).status, "open"); assert.equal(app.read(id).nativeBindings!.find(row => row.harnessId === "alpha")!.status, "ready");
});

test("G068 fix R2 (Runtime) after_turn's check that breaks the connection after the Turn's result: the Turn keeps its result, its binding is ready, the failure is the check's", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "after_turn" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  fake.check = () => "die";
  const a1 = await turn(app, id, "a1 carries b1, no evidence", "a1");
  assert.equal(a1.status, "completed", "the check did not change the settled Turn"); assert.equal(a1.error, null); assert.equal(a1.cleanup?.protocolFailure, null);
  assert.equal((eventOf(w.store, id, "run.ended", a1.id)!.data.relay as { readonly checkFailure?: { readonly code: string } }).checkFailure?.code, "REQUEST_TIMEOUT");
  assert.equal(app.read(id).status, "open"); assert.equal(app.read(id).nativeBindings!.find(row => row.harnessId === "alpha")!.status, "ready");
  const row = rowOf(w.store, id, a1.id)!;
  assert.equal(row.outcome.kind === "unknown" && row.outcome.reason, "verify_unavailable"); assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending");
  fake.check = () => "model";
  const a2 = await turn(app, id, "a2 alone", "a2", { attach: "none" });
  assert.equal(a2.status, "completed", "the next Turn starts again");
});

test("G068 fix R2 (Runtime) after_turn's check given up on at its bound leaves the connection to be closed, never kept for the next Turn", { timeout: 30000 }, async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "after_turn" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  app.setRetention(id, true, "keep");
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  // The old Driver's behaviour: the request answers nothing and aborts the connection a little after the Runtime gave up on it.
  fake.check = () => ({ dieAfterMs: 2600 });
  const a1 = await bounded(app, id, "a1 carries b1, no evidence", "a1", 15000);
  assert.equal(a1.status, "completed"); assert.equal(app.keptProcess(id), null, "the connection with a check still outstanding is not kept");
  fake.check = () => "model";
  await new Promise(resolve => setTimeout(resolve, 800));
  const a2 = await turn(app, id, "a2 next", "a2");
  assert.equal(a2.status, "completed", "the abandoned check never broke into the next Turn"); assert.equal(a2.reused, undefined);
});

test("G068 fix R3 (Runtime) a Driver whose live evidence is the agent's output (dsh): a carrying Turn's first text is E1, before that output; a plan or usage alone is not", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ live: "agent_output", verify: "none" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("plan only") ? { result: NO_EVIDENCE, outputs: [{ type: "plan", entries: [{ content: "think", status: "pending" }] }, { type: "usage", usage: { turn: { input: 3, output: 1 } } }] }
    : { result: NO_EVIDENCE };
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  const a1 = await turn(app, id, "a1 carries b1, the agent answers", "a1");
  const e1 = eventOf(w.store, id, "relay.input_recorded", a1.id)!, reply = allEvents(w.store, id).find(row => row.type === "run.output" && row.data.runId === a1.id)!;
  assert.equal(e1.data.live, "agent_output"); assert.ok(e1.seq < reply.seq, "E1 before the output that proves it");
  assert.equal((rowOf(w.store, id, a1.id)!.outcome as { readonly evidence: string }).evidence, "E1"); assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced");
  await to(app, id, "bravo", "to-b"); await turn(app, id, "b2 another fact", "b2"); await to(app, id, "alpha", "to-a2");
  const a2 = await turn(app, id, "plan only carries b2", "a2");
  assert.equal(eventOf(w.store, id, "relay.input_recorded", a2.id), undefined, "a plan and usage prove nothing");
  assert.equal(rowOf(w.store, id, a2.id)?.outcome.kind, "unknown"); assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending");
});

test("G068 fix R4 (Runtime) Claude's synthesized clear without a session opened ahead (replaced.checkpoint null): the binding is archived, the process not kept, the next Turn opens a new native session, the abandoned one is never resumed", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "after_turn", successProvesRecorded: true }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "/clear" ? { native: { cleared: true, replaced: { checkpoint: null } } } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1", "a1");
  app.setRetention(id, true, "keep");
  const abandoned = fake.last("alpha").session, before = bindingRelay(app.read(id), "alpha");
  const clear = await turn(app, id, "/clear", "clear");
  // The Driver ended the native session it cleared and opened none: a resume of it fails, a new one opens.
  fake.unresumable.add(abandoned);
  assert.equal(clear.status, "completed"); assert.equal(app.keptProcess(id), null, "the process of a replaced session is not kept");
  assert.equal(eventOf(w.store, id, "run.ended", clear.id)?.data.contextEffect, "clear");
  const bindings = app.read(id).nativeBindings!.filter(row => row.harnessId === "alpha");
  assert.equal(bindings.length, 2); assert.equal(bindings[0]!.status, "archived"); assert.deepEqual(bindings[0]!.relay, before, "archiving freezes the relay state");
  assert.equal(bindings[1]!.opensNew, true); assert.equal(bindings[1]!.status, "ready"); assert.equal(bindings[1]!.throughRunId, null);
  assert.deepEqual(bindings[1]!.relay!.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(bindings[1]!.relay!.nativeEpoch, before.nativeEpoch + 1);
  assert.equal(bindings[1]!.relay!.epochFloor, eventOf(w.store, id, "run.ended", clear.id)!.seq);
  // G068 fix batch 2, M-4: the checkpoint the binding names is the abandoned session's, which this conversation no longer holds.
  assert.equal(bindings[1]!.checkpoint, abandoned); assert.equal(w.store.nativeOwners("alpha", "alpha-acp").get(abandoned), undefined, "the abandoned session is not held");
  const opens = fake.opens.length, after = await turn(app, id, "after the clear", "after");
  assert.equal(w.store.nativeOwners("alpha", "alpha-acp").get(fake.last("alpha").session), id, "the new one is");
  assert.equal(after.status, "completed", JSON.stringify(after.error)); assert.equal(fake.opens[opens], undefined, "a new native session, not the abandoned one");
  assert.notEqual(fake.last("alpha").session, abandoned); assert.equal(fake.to("alpha").at(-1), after.input, "nothing owed after the clear: as typed");
  const now = app.read(id).nativeBindings!.find(row => row.harnessId === "alpha" && row.status !== "archived")!;
  assert.equal(now.opensNew, undefined); assert.equal(now.checkpoint, fake.last("alpha").session); assert.equal(now.relay!.nativeEpoch, before.nativeEpoch + 1);
});

test("G068 fix R5 (Runtime) a suspect binding whose retreated prior owes nothing: the user's complete packet (attach full, or resend) goes as typed, the binding stands on that prior, and the next input goes too", async t => {
  for (const choice of [{ attach: "full" as const }, { resend: true as const }]) {
    const w = await runtimeWorld(t);
    const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none", successProvesRecorded: true }) });
    fake.enableAdmission();
    fake.script = (_harnessId, input) => input === "/clear" ? { native: { cleared: true, replaced: null } } : {};
    const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "alpha" }, "create"), id = session.id;
    const a1 = await turn(app, id, "a1 before the clear", "a1");
    await turn(app, id, "/clear", "clear");
    const a2 = await turn(app, id, "a2 brings a1 back", "a2", { attach: "full" });
    assert.deepEqual(a2.sourceRunIds, [a1.id]); assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced");
    await turn(app, id, "/undo", "undo");
    assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "suspect");
    assert.throws(() => app.send(id, "a3 plain", "a3"), relayError("RELAY_CHOICE_REQUIRED", "verify_required"), "nothing can check it: the user decides");
    const a4 = await turn(app, id, "a4 the complete packet again", "a4", choice);
    assert.equal(a4.status, "completed", JSON.stringify(choice) + ": " + JSON.stringify(a4.error)); assert.equal(fake.to("alpha").at(-1), a4.input, "nothing to carry on the retreated prior: as typed");
    const prepared = eventOf(w.store, id, "run.context_prepared", a4.id)!;
    assert.equal(prepared.data.nothingToAttach, true); assert.equal(prepared.data.retreat, true);
    const verified = eventOf(w.store, id, "relay.verified", a4.id)!;
    assert.equal(verified.data.result, "nothing_owed"); assert.equal(verified.data.plan, "choice");
    const relay = bindingRelay(app.read(id), "alpha");
    assert.ok(relay.sync.kind === "synced" && relay.sync.mark.lastPacketId === null && relay.sync.mark.evidence === "choice", JSON.stringify(relay.sync));
    const a5 = await turn(app, id, "a5 plain again", "a5");
    assert.equal(a5.status, "completed"); assert.equal(fake.to("alpha").at(-1), a5.input);
  }
});

test("G068 fix R6 (Runtime) the Store refuses the relay part of a Turn's end (its delivery row is gone): the end is committed without it, the conversation is marked relayRecoveryFailed, and the Runtime goes on", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none" }), bravo: declared() });
  fake.enableAdmission();
  fake.script = (_harnessId, input) => input.startsWith("held") ? { result: "hold" } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  const receipt = app.send(id, "held carries b1", "a1");
  await until(() => fake.holds.length === 1 && rowOf(w.store, id, receipt.runId) !== undefined, "dispatched with its delivery row");
  // Injected Store fault: the row the settlement decides is gone, so the Store refuses the end's relay rows (INVALID_DATA).
  const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
  try { db.prepare("DELETE FROM relay_deliveries WHERE run_id=?").run(receipt.runId); } finally { db.close(); }
  fake.holds[0]!.resolve(NO_EVIDENCE);
  await app.wait(id);
  const state = app.read(id), a1 = state.runs.find(row => row.id === receipt.runId)!, ended = eventOf(w.store, id, "run.ended", a1.id)!;
  assert.equal(a1.status, "completed", "the public facts of the end are committed"); assert.equal(state.status, "open");
  assert.deepEqual(ended.data.relay, { failed: true }); assert.equal(ended.data.delivery, undefined); assert.equal(state.relayRecoveryFailed, ended.seq);
  assert.equal(bindingRelay(state, "alpha").sync.kind, "pending", "the binding's relay state is as the authorization left it");
  assert.equal(state.nativeBindings!.find(row => row.harnessId === "alpha")!.status, "ready");
  assert.throws(() => app.send(id, "a2 would carry", "a2"), relayError("RELAY_UNAVAILABLE", "recovery_failed"));
  const alone = await turn(app, id, "a3 alone", "a3", { attach: "none" });
  assert.equal(alone.status, "completed", "the Runtime goes on");
});

/** One world per fault: alpha checks after its Turns, its Turn carries b1 and ends without evidence; the check answers as `fault`. */
async function settledFault(t: TestContext, fault: CheckFault, insert: "now" | "never" = "now") {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "after_turn" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE, insert } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  fake.check = () => fault;
  const verifies = fake.verifies, a1 = await bounded(app, id, "a1 carries b1, no evidence", "a1", 15000);
  assert.equal(fake.verifies, verifies + 1, "checked once, at the settlement");
  return { w, fake, app, id, a1 };
}

test("G068 fix R7 (Runtime) after_turn's check at the settlement: a packet found is recorded (E2) by that Turn's own end; one not found stays pending, unknown{absent}", async t => {
  const found = await settledFault(t, "model");
  const row = rowOf(found.w.store, found.id, found.a1.id)!, ended = eventOf(found.w.store, found.id, "run.ended", found.a1.id)!, verified = eventOf(found.w.store, found.id, "relay.verified", found.a1.id)!;
  assert.deepEqual(row.outcome, { kind: "recorded", evidence: "E2", decidedSeq: verified.seq, decidedAt: row.outcome.kind === "recorded" ? row.outcome.decidedAt : 0, verifiedInRun: found.a1.id });
  assert.equal(verified.data.moment, "settled"); assert.equal(verified.data.result, "recorded"); assert.ok(ended.seq < verified.seq, "committed with run.ended, right after it");
  assert.equal(markOf(bindingRelay(found.app.read(found.id), "alpha").sync)?.lastPacketId, packetIdIn(found.fake.last("alpha").turn));
  const lost = await settledFault(t, "model", "never");
  const lostRow = rowOf(lost.w.store, lost.id, lost.a1.id)!;
  assert.equal(lostRow.outcome.kind === "unknown" && lostRow.outcome.reason, "absent"); assert.equal(bindingRelay(lost.app.read(lost.id), "alpha").sync.kind, "pending");
  assert.equal(eventOf(lost.w.store, lost.id, "relay.verified", lost.a1.id)?.data.result, "unconfirmed");
});

test("G068 fix R7 (Runtime) a check that throws, answers null, answers garbage or an unknown marker value, or never answers is unavailable: the Turn keeps its result, the packet stays pending, nothing is taken for present", { timeout: 60000 }, async t => {
  const faults: readonly [string, CheckFault][] = [["throws", "throw"], ["null", { raw: () => null }], ["garbage", { raw: () => ({ markers: "garbage", historyEmpty: "yes", compaction: { count: -1 } }) }],
    ["unknown marker value", { raw: request => ({ markers: request.markers.map(marker => ({ packetId: marker.packetId, result: "yes" })), historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 1 }) }],
    ["hangs", "hang"]];
  for (const [label, fault] of faults) {
    const s = await settledFault(t, fault);
    assert.equal(s.a1.status, "completed", label); assert.equal(s.app.read(s.id).status, "open", label);
    const row = rowOf(s.w.store, s.id, s.a1.id)!;
    assert.equal(row.outcome.kind === "unknown" && row.outcome.reason, "verify_unavailable", label + ": " + JSON.stringify(row.outcome));
    assert.equal(bindingRelay(s.app.read(s.id), "alpha").sync.kind, "pending", label); assert.equal(s.app.read(s.id).relayRecoveryFailed, undefined, label);
    assert.deepEqual(eventOf(s.w.store, s.id, "relay.verified", s.a1.id)?.data.markers, [{ packetId: packetIdIn(s.fake.last("alpha").turn), result: "unavailable" }], label);
  }
});

test("G068 fix R9a/R9b (Runtime) a carried packet the table sends back to pending with its resend spent is asked about at admission, no Run made; attach full on a pending packet is the user's resend", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none" }), bravo: declared() });
  fake.enableAdmission();
  fake.script = (_harnessId, input) => input.startsWith("a1") || input.startsWith("lost") ? { insert: "never", result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  const a1 = await turn(app, id, "a1 carries b1, no evidence", "a1");
  await turn(app, id, "/undo", "undo");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind === "suspect" && (bindingRelay(app.read(id), "alpha").sync as { readonly carried: unknown }).carried !== null, true);
  const runs = app.read(id).runs.length;
  assert.throws(() => app.send(id, "a2 plain", "a2"), relayError("RELAY_CHOICE_REQUIRED", "delivery_unconfirmed"), "the open would send it back to pending with its resend spent");
  assert.equal(app.read(id).runs.length, runs, "no Run was made");
  const full = await turn(app, id, "a3 again in full", "a3", { attach: "full" });
  assert.equal(full.status, "completed", JSON.stringify(full.error)); assert.equal(rowOf(w.store, id, full.id)?.resendOf, a1.id, "the user's resend of the carried packet");
  // A pending packet whose automatic resend is spent: attach full is accepted at admission as the user's resend.
  await to(app, id, "bravo", "to-b"); await turn(app, id, "b2 another fact", "b2"); await to(app, id, "alpha", "to-a2");
  const x1 = await turn(app, id, "lost first", "x1"), x2 = await turn(app, id, "lost resend", "x2");
  assert.equal(rowOf(w.store, id, x2.id)?.resendOf, x1.id);
  const x3 = await turn(app, id, "x3 again in full", "x3", { attach: "full" });
  assert.equal(x3.status, "completed"); assert.equal(rowOf(w.store, id, x3.id)?.resendOf, x2.id);
});

/** A single Harness alpha (no check, success proves recorded) whose `content clears…` and `/clear` its Driver reports cleared. */
async function singleClearing(t: TestContext) {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none", successProvesRecorded: true }) });
  fake.script = (_harnessId, input) => input.startsWith("content clears") ? { native: { cleared: true, replaced: null } }
    : input === "/clear" ? { native: { cleared: true, replaced: null }, result: { status: "failed", reason: "fake", error: { code: "NATIVE_FAILED", message: "after the clear" } } } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "alpha" }, "create"), id = session.id;
  await turn(app, id, "a1", "a1");
  return { w, fake, app, id };
}

test("G068 fix R10c (Runtime) A9: attach full with nothing to attach goes as typed and run.context_prepared says so (nothingToAttach); an ordinary Turn says nothing", async t => {
  const { w, fake, app, id } = await singleClearing(t);
  const asked = await turn(app, id, "a2 with nothing to attach", "a2", { attach: "full" });
  assert.equal(asked.status, "completed"); assert.equal(fake.to("alpha").at(-1), asked.input);
  assert.equal(eventOf(w.store, id, "run.context_prepared", asked.id)?.data.nothingToAttach, true, "A9: requested, nothing attached");
  assert.equal(eventOf(w.store, id, "run.context_prepared", (await turn(app, id, "a3 ordinary", "a3")).id)?.data.nothingToAttach, undefined);
});

test("G068 fix R10d (Runtime) A18: a content Turn its Driver reports cleared is e: a new epoch, fresh{user_cleared}, the floor at its end", async t => {
  const { w, app, id } = await singleClearing(t);
  const epoch = bindingRelay(app.read(id), "alpha").nativeEpoch;
  const content = await turn(app, id, "content clears the history", "a4");
  assert.deepEqual(bindingRelay(app.read(id), "alpha").sync, { kind: "fresh", basis: "user_cleared" }, "a Driver-confirmed clear is e whatever the Turn");
  assert.equal(bindingRelay(app.read(id), "alpha").nativeEpoch, epoch + 1); assert.equal(bindingRelay(app.read(id), "alpha").epochFloor, eventOf(w.store, id, "run.ended", content.id)!.seq);
});

test("G068 fix R9e (Runtime) a clear its Driver confirmed, in a command Turn that then failed, is contextEffect clear, as the binding took it", async t => {
  const { w, app, id } = await singleClearing(t);
  const epoch = bindingRelay(app.read(id), "alpha").nativeEpoch;
  const failed = await turn(app, id, "/clear", "clear");
  assert.equal(failed.status, "failed");
  assert.equal(eventOf(w.store, id, "run.ended", failed.id)?.data.contextEffect, "clear", "the binding took the clear, and so does the end");
  assert.equal(bindingRelay(app.read(id), "alpha").nativeEpoch, epoch + 1);
});

test("G068 fix R10e (Runtime) A2: a mark without a packet still sends a delta to a native session that holds the rest", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared(), bravo: declared({ successProvesRecorded: true }) });
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 on bravo", "b1"); await turn(app, id, "b2 on bravo", "b2");
  const native = markOf(bindingRelay(app.read(id), "bravo").sync);
  assert.ok(native !== null && native.lastPacketId === null && native.basis === "native", "bravo's own Turns made a native mark");
  await to(app, id, "alpha", "to-a"); const a1 = await turn(app, id, "a1 on alpha", "a1"); await to(app, id, "bravo", "to-b");
  const b3 = await turn(app, id, "b3 gets a1", "b3");
  assert.deepEqual(b3.sourceRunIds, [a1.id]); assert.equal(readRelayPrompt(fake.last("bravo").text).kind, "delta", "the mark stands although no packet made it");
});

test("G068 fix R9g (Store) a resend never dispatched when its owner ended goes back to waiting for the packet it superseded, its counts kept; recovery reads the packets' manifests", t => {
  const root = join(temporary(t), "data"), workspace = join(root, "..");
  let store = new SqliteSessionStore(root, { recoverRelay });
  const { packet, two } = seed(store, workspace, "resend", "dispatched");
  const id = sessionId("session-resend");
  let state = store.get(id);
  // Run two ends unknown (i): its row unknown, the binding still pending on its packet.
  const relay0 = state.nativeBindings![0]!.relay!;
  const unknown = applied(step(relay0, { kind: "carry_settled", runId: two, packetId: packet.id, bodySha256: packet.body.sha256, reanchored: false, row: "in_flight",
    outcome: { kind: "unknown", reason: "no_evidence", decidedSeq: state.lastSeq + 1, decidedAt: 30 } }));
  state = store.transact(id, state.version, current => ({ next: { ...current, activeRunId: null, nativeBindings: withRelay(current, unknown.relay, { status: "ready", throughRunId: two }),
    runs: current.runs.map(row => row.id === two ? { ...row, status: "completed" as const, backend: { status: "completed" as const, reason: "fake" }, cleanup: clean, timing: { ...row.timing!, endedAt: 30 } } : row),
    messages: [...current.messages.map(message => message.runId === two ? { ...message, status: "completed" as const } : message), { id: messageId("message-resend-two-reply"), runId: two, role: "assistant" as const, text: "", seq: current.lastSeq + 1, status: "completed" as const }] },
    events: [{ type: "run.ended", data: { runId: two } }], relay: { deliveries: writes(unknown.deliveries, 7) } })).session;
  // Run three resends it automatically (P′, a different text) and is authorized, then the owner ends before dispatch.
  const three = run("resend", "three", "preparing", state.lastSeq + 1, { timing: { acceptedAt: 40, preparingAt: 41 } });
  const body = "resend of packet of resend", resend = packetOf(body, packet.range);
  const carried = applied(step(unknown.relay, { kind: "carry", runId: three.id, packet: { id: resend.id, range: resend.range }, attachOverride: false, lateDelivery: false, resend: { by: "auto", of: two } }));
  state = store.transact(id, state.version, current => ({ next: { ...current, activeRunId: three.id, runs: [...current.runs, { ...three, relay: { packetId: resend.id, kind: "packet" as const, continuity: { kind: "rehydrate" as const, tier: "standard" as const, complete: true }, executedOn: { ...alpha, nativeEpoch: 1 } }, timing: { acceptedAt: 40, preparingAt: 41, contextReadyAt: 42 } }],
    messages: [...current.messages, { id: three.userMessageId, runId: three.id, role: "user", text: three.input, seq: current.lastSeq + 1, status: "preparing" }],
    commands: [...current.commands, { id: three.commandId, kind: "send", fingerprint: hex("b"), resultId: three.id }], nativeBindings: withRelay(current, carried.relay, { status: "unconfirmed" }) },
    events: [{ type: "message.accepted", data: { runId: three.id } }, { type: "run.context_prepared", data: { runId: three.id } }], relay: { packets: [{ runId: three.id, packet: resend, body }], deliveries: writes(carried.deliveries, 9) } })).session;
  const pending = state.nativeBindings![0]!.relay!.sync;
  assert.ok(pending.kind === "pending" && pending.packetId === resend.id && pending.autoResends === 1);
  store.close();
  store = new SqliteSessionStore(root, { recoverRelay });
  try {
    const now = store.get(id), sync = now.nativeBindings![0]!.relay!.sync;
    assert.equal(store.relayDeliveries(id).find(row => row.runId === three.id)?.outcome.kind, "not_recorded", "the resend never left");
    assert.deepEqual(sync, { ...pending, packetId: packet.id, range: packet.range }, "back to waiting for the packet it superseded, with its counts (h)");
    consistent(store, id);
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// G068 fix batch 2 (the second review of stage two): the cases each finding was reproduced with, written before its fix.
// ---------------------------------------------------------------------------------------------------------------------

/** The Harness control's binding in use (the one not archived). */
function current(app: SessionRuntime, id: SessionId, harnessId: string): NativeSessionBinding { return app.read(id).nativeBindings!.find(row => row.harnessId === harnessId && row.status !== "archived")!; }
/** Content storage for a Turn with an attachment (the file is never read). */
const NOTE_CONTENT: ContentPort = { storeOutput: async () => { throw new Error("no outputs"); }, materialize: async refs => refs.map(ref => ({ ...ref, path: "/dev/null" })),
  resolve: ids => ids.map(item => ({ id: contentId(item), name: "note.txt", mediaType: "text/plain", kind: "file" as const, bytes: 4, sha256: "0".repeat(64) })) };
/** An input with attachments, to its end. */
async function withFile(app: SessionRuntime, id: SessionId, text: string, key: string): Promise<PublicRun> {
  const receipt = app.send(id, text, key, ["content-note"]);
  await app.wait(id).catch((error: unknown) => { if (!(error instanceof SessionError && error.code === "SESSION_BLOCKED")) throw error; });
  return app.read(id).runs.find(row => row.id === receipt.runId)!;
}
/**
 * bravo's fact b1; alpha (Claude-like: it checks after its Turns, success proves the input recorded) carries it, then its
 * Driver's synthesized /clear replaces the native session by `replaced` (null: none opened ahead, opensNew).
 */
async function claudeCleared(t: TestContext, replaced: string | null) {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "after_turn", successProvesRecorded: true }), bravo: declared() });
  fake.script = (_harnessId, input) => input === "/clear" ? { native: { cleared: true, replaced: { checkpoint: replaced } } } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  const b1 = await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a"); const a1 = await turn(app, id, "a1 carries b1", "a1");
  const abandoned = fake.last("alpha").session, clear = await turn(app, id, "/clear", "clear");
  assert.equal(clear.status, "completed"); assert.equal(app.read(id).nativeBindings!.filter(row => row.harnessId === "alpha").length, 2, "the cleared session's binding is archived");
  return { w, fake, app, id, b1, a1, abandoned, clear };
}

test("G068 fix2 I-1a (Runtime) after Claude's synthesized clear opened no session (opensNew), a Turn that fails before dispatch keeps opensNew and the abandoned checkpoint: the next Turn opens a new native session and goes", async t => {
  const s = await claudeCleared(t, null);
  // A session never prompted cannot be resumed by another process; neither can the abandoned one.
  s.fake.strictResume = true; s.fake.unresumable.add(s.abandoned);
  const before = current(s.app, s.id, "alpha");
  assert.equal(before.opensNew, true); assert.equal(before.checkpoint, s.abandoned);
  // The next Turn fails before dispatch: a slash word is settled against the catalog, which cannot be read.
  s.fake.catalogFails = true;
  const opens = s.fake.opens.length, failed = await turn(s.app, s.id, "/foo", "foo");
  assert.equal(failed.status, "failed"); assert.equal(failed.timing?.dispatchedAt, undefined, "never dispatched");
  assert.equal(s.fake.opens.length, opens + 1); assert.equal(s.fake.opens[opens], undefined, "it opened a new native session");
  const kept = current(s.app, s.id, "alpha");
  assert.equal(kept.status, "ready"); assert.equal(kept.opensNew, true, "the next Turn opens a new native session again");
  assert.equal(kept.checkpoint, s.abandoned, "the binding still names the abandoned session"); assert.equal(kept.throughRunId, null); assert.deepEqual(kept.relay, before.relay);
  assert.equal(s.w.store.nativeOwners("alpha", "alpha-acp").size, 0, "neither the abandoned session nor the one never prompted is held (M-4)");
  s.fake.catalogFails = false;
  const next = await turn(s.app, s.id, "after the failure", "next");
  assert.equal(next.status, "completed", JSON.stringify(next.error)); assert.equal(s.fake.opens[opens + 1], undefined, "a new native session, not the one never prompted");
  const now = current(s.app, s.id, "alpha");
  assert.equal(now.opensNew, undefined); assert.equal(now.checkpoint, s.fake.last("alpha").session); assert.equal(now.throughRunId, next.id);
  assert.equal((await turn(s.app, s.id, "and on", "on")).status, "completed", "its session is resumed from then on");
});

test("G068 fix2 I-1a (Runtime) a new binding whose first carrying Turn fails before dispatch (its position read breaks the connection) keeps no session that was never prompted: the next Turn opens a new one and carries what is owed", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  fake.strictResume = true;
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  const b1 = await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  fake.position = harnessId => harnessId === "alpha" ? "die" : "model";
  const sent = fake.prompts.length, a1 = await turn(app, id, "a1 carries b1", "a1");
  assert.equal(a1.status, "failed"); assert.equal(a1.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(fake.prompts.length, sent, "nothing reached the Harness");
  const binding = current(app, id, "alpha");
  assert.equal(binding.status, "ready"); assert.equal(binding.opensNew, true, "the session opened for it was never prompted"); assert.equal(binding.throughRunId, null);
  fake.position = () => "model";
  const opens = fake.opens.length, a2 = await turn(app, id, "a2 carries b1", "a2");
  assert.equal(a2.status, "completed", JSON.stringify(a2.error)); assert.equal(fake.opens[opens], undefined, "a new native session");
  assert.deepEqual(a2.sourceRunIds, [b1.id]); assert.equal(current(app, id, "alpha").opensNew, undefined);
});

test("G068 fix2 I-1b (Runtime) C5: a fresh binding whose native session holds nothing, whose open its Driver refuses as a session it does not have, opens a new native session in its place on a new connection: relay state and floor unchanged, native.binding_replaced recorded, the Turn goes", async t => {
  const s = await claudeCleared(t, "native-alpha-ahead");
  const before = current(s.app, s.id, "alpha");
  assert.equal(before.checkpoint, "native-alpha-ahead"); assert.equal(before.opensNew, undefined); assert.deepEqual(before.relay!.sync, { kind: "fresh", basis: "user_cleared" });
  s.fake.missing.add("native-alpha-ahead");
  const opens = s.fake.opens.length, prepared = s.fake.prepared, a2 = await turn(s.app, s.id, "a2 after the clear", "a2");
  assert.equal(a2.status, "completed", JSON.stringify(a2.error));
  assert.deepEqual(s.fake.opens.slice(opens), ["native-alpha-ahead", undefined], "refused, then a new native session");
  assert.equal(s.fake.prepared, prepared + 2, "the refused connection was closed and a new program started");
  const replaced = eventOf(s.w.store, s.id, "native.binding_replaced", a2.id)!;
  assert.equal(replaced.data.reason, "empty_session_unresumable"); assert.equal(replaced.data.nativeEpoch, before.relay!.nativeEpoch);
  assert.ok(replaced.seq < eventOf(s.w.store, s.id, "run.dispatched", a2.id)!.seq, "recorded before the input went");
  const now = current(s.app, s.id, "alpha");
  assert.equal(now.checkpoint, s.fake.last("alpha").session); assert.notEqual(now.checkpoint, "native-alpha-ahead");
  assert.equal(now.relay!.nativeEpoch, before.relay!.nativeEpoch); assert.equal(now.relay!.epochFloor, before.relay!.epochFloor);
  assert.equal(s.app.read(s.id).nativeBindings!.filter(row => row.harnessId === "alpha").length, 2, "replaced in place: no binding added");
  assert.equal(s.fake.to("alpha").at(-1), a2.input, "nothing owed after the clear: as typed");
});

test("G068 fix2 I-1b (Runtime) a binding with a mark (synced) whose open its Driver refuses as a session it does not have is never replaced: the Turn fails, the checkpoint stays", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "after_turn", successProvesRecorded: true }), bravo: declared() });
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced");
  const lost = fake.last("alpha").session; fake.missing.add(lost);
  const opens = fake.opens.length, a2 = await turn(app, id, "a2 next", "a2");
  assert.equal(a2.status, "failed"); assert.equal(a2.error?.code, "NATIVE_SESSION_NOT_FOUND");
  assert.deepEqual(fake.opens.slice(opens), [lost], "asked once, never replaced");
  assert.equal(eventOf(w.store, id, "native.binding_replaced", a2.id), undefined);
  assert.equal(current(app, id, "alpha").checkpoint, lost); assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "synced");
});

test("G068 fix2 M-1a (Runtime) ［确认已清空］ on an unconfirmed clear the open would send back to pending with its resend spent (verify none, a carried packet): admission answers that landing's 409, no Run is made", async t => {
  {
    // No check (verify none): the unconfirmed clear carries a packet whose prior comes back, so the open would send it back to
    // pending with its automatic resend spent: admission asks for that choice now, and no Run is made.
    const w = await runtimeWorld(t);
    const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none" }), bravo: declared() });
    fake.enableAdmission();
    fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE } : {};
    const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
    await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1, no evidence", "a1"); await turn(app, id, "/clear", "clear");
    const sync = bindingRelay(app.read(id), "alpha").sync;
    assert.ok(sync.kind === "suspect" && sync.cause === "clear_unconfirmed" && sync.carried !== null, JSON.stringify(sync));
    const runs = app.read(id).runs.length;
    assert.throws(() => app.send(id, "a2 it was cleared", "a2", [], { clearConfirmed: true }), relayError("RELAY_CHOICE_REQUIRED", "delivery_unconfirmed"));
    assert.equal(app.read(id).runs.length, runs, "no Run was made");
  }
});

test("G068 fix2 M-1b (Runtime) ［确认已清空］ on an unconfirmed clear the open restores by itself (a single Harness, verify none) is not offered: refused at admission, never dropped silently", async t => {
  {
    // A single Harness whose mark comes back by itself (verify none): the open restores it, so the confirmation is not offered;
    // it is refused at admission instead of the Turn going on with no new epoch and no relay.clear_confirmed.
    const w = await runtimeWorld(t);
    const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none", successProvesRecorded: true }) });
    fake.enableAdmission();
    const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "alpha" }, "create"), id = session.id;
    await turn(app, id, "a1", "a1"); await turn(app, id, "/clear", "clear");
    const sync = bindingRelay(app.read(id), "alpha").sync;
    assert.ok(sync.kind === "suspect" && sync.cause === "clear_unconfirmed", JSON.stringify(sync));
    const runs = app.read(id).runs.length;
    assert.throws(() => app.send(id, "a2 it was cleared", "a2", [], { clearConfirmed: true }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
    assert.equal(app.read(id).runs.length, runs, "no Run was made");
    assert.equal((await turn(app, id, "a2 without it", "a2b")).status, "completed");
  }
});

test("G068 fix2 M-1c (Runtime) ［确认已清空］ whose open's check settles the clear by itself (it did not run: the chain is there): the Run fails before dispatch, saying so; nothing is sent", async t => {
  {
    // A check at the open that settles it by itself (the clear did not run: the chain is still there): the Run the confirmation
    // came with fails before dispatch, saying so, and the binding is what the check found.
    const s = await clearUnconfirmed(t, "on_next_open", false, { ran: false });
    const sent = s.fake.prompts.length, b2 = await turn(s.app, s.id, "b2 it was cleared", "b2", { clearConfirmed: true });
    assert.equal(b2.status, "failed"); assert.equal(b2.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(s.fake.prompts.length, sent, "nothing was sent");
    assert.equal(eventOf(s.w.store, s.id, "relay.clear_confirmed", b2.id), undefined);
    assert.equal(bindingRelay(s.app.read(s.id), "bravo").nativeEpoch, 1, "no clear was confirmed"); assert.equal(bindingRelay(s.app.read(s.id), "bravo").sync.kind, "synced", "the check found the history");
    assert.equal((await turn(s.app, s.id, "b3 without it", "b3")).status, "completed");
  }
});

test("G068 fix2 M-2 (Runtime) a connection the relay read on that fails after the authorization, before dispatch: the Turn ends as never dispatched, and its close's protocol failure leaves the binding ready, so the next Turn goes", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  const app = w.runtime(fake, { content: NOTE_CONTENT }), session = await app.create(w.configuration, { harnessId: "alpha" }, "create"), id = session.id;
  await turn(app, id, "a0 on alpha", "a0"); await to(app, id, "bravo", "to-b");
  const b1 = await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  fake.breakAtAttachments = true;
  const sent = fake.prompts.length, a1 = await withFile(app, id, "a1 carries b1 with a file", "a1");
  assert.equal(a1.status, "failed"); assert.equal(a1.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(a1.timing?.dispatchedAt, undefined); assert.equal(fake.prompts.length, sent);
  assert.equal(rowOf(w.store, id, a1.id)?.outcome.kind, "not_recorded", "the packet never left");
  assert.equal(current(app, id, "alpha").status, "ready", "the close's protocol failure is the relay's, not the binding's");
  assert.equal(a1.cleanup?.protocolFailure, null); assert.equal((eventOf(w.store, id, "run.ended", a1.id)!.data.relay as { readonly checkFailure?: { readonly code: string } }).checkFailure?.code, "REQUEST_TIMEOUT");
  fake.breakAtAttachments = false;
  const a2 = await turn(app, id, "a2 carries b1", "a2");
  assert.equal(a2.status, "completed", JSON.stringify(a2.error)); assert.deepEqual(a2.sourceRunIds, [b1.id]);
});

/** alpha checks at the open and waits for a1's packet; then every check breaks the connection. */
async function pendingAlpha(t: TestContext) {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1, no evidence", "a1");
  assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending");
  fake.check = () => "die";
  return { w, fake, app, id };
}

test("G068 fix2 M-3a (Runtime) a binding whose check broke the connection is not asked again in this process: its next Turn goes, its checks answered unavailable without asking", async t => {
  {
    const { w, fake, app, id } = await pendingAlpha(t);
    const a2 = await turn(app, id, "a2 meets a check that breaks the connection", "a2");
    assert.equal(a2.status, "failed"); assert.equal(a2.error?.code, "RELAY_PREPARE_FAILED");
    const verifies = fake.verifies, positions = fake.positions, a3 = await turn(app, id, "a3 the check would break it again", "a3");
    assert.equal(a3.status, "completed", JSON.stringify(a3.error)); assert.equal(fake.verifies, verifies, "not asked again"); assert.equal(fake.positions, positions, "nor for the position");
    const verified = eventOf(w.store, id, "relay.verified", a3.id)!;
    assert.equal(verified.data.unasked, "connection"); assert.deepEqual((verified.data.markers as readonly { readonly result: string }[]).map(marker => marker.result), ["unavailable"]);
    assert.equal(rowOf(w.store, id, a3.id)?.resendOf, app.read(id).runs.find(row => row.input.startsWith("a1"))!.id, "its packet still went (the automatic resend of a1's)");
  }
});

test("G068 fix2 M-3b (Runtime) an input sent alone asks the Driver nothing at its open, so a check that would break the connection never stops it", async t => {
  {
    const { fake, app, id } = await pendingAlpha(t);
    const verifies = fake.verifies, alone = await turn(app, id, "a2 only this message", "a2", { attach: "none" });
    assert.equal(alone.status, "completed", JSON.stringify(alone.error)); assert.equal(fake.verifies, verifies, "an input sent alone asks nothing at its open");
    assert.equal(fake.to("alpha").at(-1), alone.input); assert.equal(bindingRelay(app.read(id), "alpha").sync.kind, "pending", "what is owed stays owed");
  }
});

test("G068 fix2 M-5a (Runtime) a relay recovery failure no Run names is not cleared by another Harness's first native session, nor by a replacement: only the user's native reset clears it", async t => {
  {
    const w = await runtimeWorld(t);
    const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none", successProvesRecorded: true }), bravo: declared(), gamma: declared() });
    fake.enableAdmission();
    fake.script = (_harnessId, input) => input === "/clear" ? { native: { cleared: true, replaced: { checkpoint: null } } } : {};
    const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
    await turn(app, id, "b1", "b1"); await to(app, id, "alpha", "to-a"); await turn(app, id, "a1 carries b1", "a1"); await to(app, id, "bravo", "to-b");
    await app.close(); w.store.close();
    // The mark a recovery leaves (§9 S15), set by data repair as in the case above: it names no Run.
    const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
    try {
      const stored = JSON.parse(String(db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id)!.snapshot)) as SessionSnapshot;
      db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify({ ...stored, relayRecoveryFailed: stored.lastSeq }), id);
    } finally { db.close(); }
    w.store = new SqliteSessionStore(w.data, { recoverRelay });
    const next = w.runtime(fake);
    await to(next, id, "gamma", "to-g");
    assert.equal((await turn(next, id, "g1 alone on a new Harness", "g1", { attach: "none" })).status, "completed");
    assert.notEqual(next.read(id).relayRecoveryFailed, undefined, "another Harness's first native session does not clear it");
    await to(next, id, "alpha", "to-a2");
    assert.equal((await turn(next, id, "/clear", "clear")).status, "completed");
    assert.equal(next.read(id).nativeBindings!.filter(row => row.harnessId === "alpha").length, 2, "alpha's session was replaced");
    assert.notEqual(next.read(id).relayRecoveryFailed, undefined, "a replacement does not clear a failure it is not named by");
    assert.throws(() => next.send(id, "a2 would carry", "a2", [], { attach: "full" }), relayError("RELAY_UNAVAILABLE", "recovery_failed"));
    next.resetNative(id, "reset", next.read(id).epoch);
    assert.equal(next.read(id).relayRecoveryFailed, undefined, "the user's native reset clears it");
  }
});

test("G068 fix2 M-5b (Runtime) a relay recovery failure its own Harness's end left (R6) is cleared when that Harness's Driver replaces the native session", async t => {
  {
    // R6: alpha's own end was committed without its relay part; alpha's Driver then replaces its native session.
    const w = await runtimeWorld(t);
    const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "none", successProvesRecorded: true }), bravo: declared() });
    fake.enableAdmission();
    fake.script = (_harnessId, input) => input.startsWith("held") ? { result: "hold" } : input === "/clear" ? { native: { cleared: true, replaced: { checkpoint: null } } } : {};
    const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
    await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
    const receipt = app.send(id, "held carries b1", "a1");
    await until(() => fake.holds.length === 1 && rowOf(w.store, id, receipt.runId) !== undefined, "dispatched with its delivery row");
    const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
    try { db.prepare("DELETE FROM relay_deliveries WHERE run_id=?").run(receipt.runId); } finally { db.close(); }
    fake.holds[0]!.resolve(NO_EVIDENCE); await app.wait(id);
    assert.notEqual(app.read(id).relayRecoveryFailed, undefined);
    assert.equal((await turn(app, id, "/clear", "clear")).status, "completed");
    assert.equal(app.read(id).relayRecoveryFailed, undefined, "the binding its Run's end named was replaced");
  }
});

test("G068 fix2 M-6 (Runtime) after a clear confirmed after the fact, a native reset's new session holds none of the Turns run since the clear: they are owed to it (heldSince's since)", async t => {
  const s = await clearUnconfirmed(t, "none");
  const b2 = await turn(s.app, s.id, "b2 only this message", "b2", { attach: "none" });
  const b3 = await turn(s.app, s.id, "b3 after confirming", "b3", { clearConfirmed: true });
  assert.ok(eventOf(s.w.store, s.id, "relay.clear_confirmed", b3.id)); assert.deepEqual(b3.sourceRunIds, []);
  assert.equal(b2.relay?.executedOn?.nativeEpoch, 1); assert.equal(b3.relay?.executedOn?.nativeEpoch, 2, "b3 ran in the epoch the confirmation opened");
  const old = s.fake.last("bravo").session;
  s.app.resetNative(s.id, "reset", s.app.read(s.id).epoch);
  const b4 = await turn(s.app, s.id, "b4 in a new native session", "b4");
  assert.notEqual(s.fake.last("bravo").session, old);
  assert.deepEqual(b4.sourceRunIds, [b2.id, b3.id], "the Turns since the clear, which only the old native session held, are owed to the new one; a1 and b1 lie below the floor");
});

test("G068 fix2 M-6 (Runtime) after a clear confirmed after the fact, Claude's replacement (a session opened ahead, or none: a new native session) starts above its own floor; attach full brings every earlier Turn back, the ones since the confirmed clear included, as foreign to the new session", async t => {
  for (const replaced of ["native-bravo-ahead", null]) {
    const s = await clearUnconfirmed(t, "none", false, { replaced });
    const b2 = await turn(s.app, s.id, "b2 only this message", "b2", { attach: "none" });
    const b3 = await turn(s.app, s.id, "b3 after confirming", "b3", { clearConfirmed: true });
    const old = s.fake.last("bravo").session, again = await turn(s.app, s.id, "/clear again", "clear-again");
    assert.equal(again.status, "completed"); assert.equal(s.app.read(s.id).nativeBindings!.filter(row => row.harnessId === "bravo").length, 2, String(replaced) + ": replaced");
    const b4 = await turn(s.app, s.id, "b4 brings it all back", "b4", { attach: "full" });
    assert.equal(b4.status, "completed", JSON.stringify(b4.error)); assert.notEqual(s.fake.last("bravo").session, old);
    if (replaced !== null) assert.equal(s.fake.last("bravo").session, replaced);
    assert.deepEqual(b4.sourceRunIds, [s.a1.id, s.b1.id, b2.id, b3.id], String(replaced) + ": none of them is in the new native session");
    const b5 = await turn(s.app, s.id, "b5 plain", "b5");
    assert.deepEqual(b5.sourceRunIds, []); assert.equal(s.fake.to("bravo").at(-1), b5.input);
  }
});

test("G068 fix2 M-6/I-1b (Runtime) after a clear confirmed after the fact, a native session that holds the Turns run since the clear is never replaced in place when its open is refused (they would be lost): the Turn fails; after the user's reset they are owed to the new session", async t => {
  const s = await clearUnconfirmed(t, "after_turn", true);
  s.fake.readable = true;
  const b2 = await turn(s.app, s.id, "b2 only this message", "b2", { attach: "none" });
  const relay = bindingRelay(s.app.read(s.id), "bravo");
  assert.equal(relay.nativeEpoch, 2, "b2's settlement check confirmed the clear"); assert.deepEqual(relay.sync, { kind: "fresh", basis: "user_cleared" });
  s.fake.missing.add(s.fake.last("bravo").session);
  const b3 = await turn(s.app, s.id, "b3 the session is gone", "b3");
  assert.equal(b3.status, "failed"); assert.equal(b3.error?.code, "NATIVE_SESSION_NOT_FOUND"); assert.equal(eventOf(s.w.store, s.id, "native.binding_replaced", b3.id), undefined);
  s.app.resetNative(s.id, "reset", s.app.read(s.id).epoch);
  const b4 = await turn(s.app, s.id, "b4 in a new native session", "b4");
  assert.equal(b4.status, "completed", JSON.stringify(b4.error)); assert.deepEqual(b4.sourceRunIds, [b2.id], "b2, which only the lost session held, is owed to the new one");
});

test("G068 fix2 M-8 (Runtime) a close that throws after the Turn already failed keeps the Turn's own failure: the Turn is unknown (its cleanup is unconfirmed) and says what it failed with", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ verify: "on_next_open" }), bravo: declared() });
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  fake.position = harnessId => harnessId === "alpha" ? "die" : "model"; fake.closeFails = true;
  const a1 = await turn(app, id, "a1 carries b1", "a1");
  fake.closeFails = false;
  assert.equal(a1.status, "unknown", "its program's end is not confirmed"); assert.equal(app.read(id).status, "blocked");
  assert.equal(a1.error?.code, "RELAY_PREPARE_FAILED", "the failure it ended with, not the close's");
});

test("G068 fix2 M-9 (Runtime) a dsh-like Driver's E1 the Store refuses (its delivery row is gone) is tried once in the Turn, not once per output; the Turn ends as without it (R6)", async t => {
  const w = await runtimeWorld(t);
  const fake = new ModelHarnesses(w.peer, { alpha: declared({ live: "agent_output", verify: "none" }), bravo: declared() });
  fake.script = (_harnessId, input) => input.startsWith("a1") ? { result: NO_EVIDENCE, outputs: [{ type: "text", text: "one " }, { type: "thinking", text: "so" }, { type: "text", text: "two" },
    { type: "tool", id: "tool-1", title: "read", status: "completed" }] } : {};
  const app = w.runtime(fake), session = await app.create(w.configuration, { harnessId: "bravo" }, "create"), id = session.id;
  await turn(app, id, "b1 a fact", "b1"); await to(app, id, "alpha", "to-a");
  let tries = 0;
  const transact = w.store.transact.bind(w.store);
  w.store.transact = ((target, version, mutate) => transact(target, version, state => {
    const mutation = mutate(state);
    if (mutation.events.some(row => row.type === "relay.input_recorded")) tries++;
    return mutation;
  })) as typeof w.store.transact;
  // Injected Store fault: once dispatched, the Turn's delivery row is gone, so the Store refuses E1's write.
  fake.onDispatch = (harnessId, input) => {
    if (harnessId !== "alpha" || !input.startsWith("a1")) return;
    const db = new DatabaseSync(join(w.data, "gateway.sqlite"));
    try { db.prepare("DELETE FROM relay_deliveries WHERE run_id=?").run(app.read(id).activeRunId); } finally { db.close(); }
  };
  const a1 = await turn(app, id, "a1 carries b1, the agent answers", "a1");
  assert.equal(tries, 1, "E1 was tried once");
  assert.equal(eventOf(w.store, id, "relay.input_recorded", a1.id), undefined, "and not recorded");
  assert.equal(a1.status, "completed"); assert.equal(app.read(id).messages.find(row => row.id === a1.assistantMessageId)?.text, "one two", "every output was kept");
  assert.equal(app.read(id).relayRecoveryFailed, eventOf(w.store, id, "run.ended", a1.id)!.seq, "its end's relay part was refused too (R6)");
});
