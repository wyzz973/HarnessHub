import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  EMPTY_CHAIN, SUSPECT_CAUSES, fingerprint, parseBindingRelayState, relayPacketId,
  type BindingRelayState, type BindingSync, type ContextEffect, type DeliveredMark, type DeliveryRecord, type DeliveryStatus, type Fingerprint, type MarkerResult,
  type RelayPacketId, type SourceRange, type SuspectCause, type VerifyResult,
} from "../../src/contracts/relay.js";
import { commandId, messageId, runId, sessionId, type NativeSessionBinding, type PublicRun, type RunId, type SessionSnapshot } from "../../src/contracts/session.js";
import { commandOutcome } from "../../src/contexts/session/domain/relay/advance.js";
import {
  RELAY_EVENT_LETTERS, chainAfter, commandTurnEvent, eventLetter, mayReuseKept, owed, pendingResend, planReturnVerify, retreatedPrior, settledOutcome, step,
  type BindingDelivery, type DeliveryChange, type RelayEvent, type RelayEventLetter, type RelayStep, type VerifyPlan,
} from "../../src/contexts/session/domain/relay/delivery.js";
import { migrateSession } from "../../src/contexts/session/domain/relay/migrate.js";
import { assertSessionTransition, carriedNativeConfiguration, parseSession } from "../../src/contexts/session/domain/state.js";
import { loadV12Fixture } from "../fixtures/relay/v12/database.js";

// G068 (ADR-055 §7.2, §7.3): the delivery state machine as a pure function. The table below is written out by hand, one
// expectation per (state, event) cell of §7.2 — 4 states × 14 events — and compared with what `step` returns; it is not
// computed from the implementation. Further tests cover each rule's invalid sample, the k cells result by result, the check
// plan of §7.3, the E3 and command rules of §7.1 / §7.4 over R8 §2.8 / §2.9, and Claude's synthesized clear (G068-C10).

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex") as Fingerprint;
const packet = (digit: string): RelayPacketId => relayPacketId("relay-" + digit.repeat(20));
const P1 = packet("1"), P2 = packet("2"), P3 = packet("3"), P0 = packet("0");
const SHA1 = sha("packet one"), SHA2 = sha("packet two"), SHA3 = sha("packet three");
const R0 = runId("run-zero"), R1 = runId("run-one"), R2 = runId("run-two"), R3 = runId("run-three");
const RANGE1: SourceRange = { fromSeq: 3, throughSeq: 6, fromRun: 0, throughRun: 1 }, RANGE2: SourceRange = { fromSeq: 7, throughSeq: 9, fromRun: 2, throughRun: 3 };
const RANGE3: SourceRange = { fromSeq: 10, throughSeq: 12, fromRun: 4, throughRun: 5 };
const MARK1: DeliveredMark = { throughSeq: 6, chain: chainAfter(null, SHA1), lastPacketId: P1, evidence: "E3", basis: "evidence" };
const CURSOR = { count: 1, digest: sha("cursor one") };
const AT = { seq: 20, time: 1000 };
const NO_CACHE = { lastRequestStartedAt: null, contextUsed: null, contextSize: null };
/** A relay state of epoch 2 with clear floor 1 (an earlier binding of the same Harness control was cleared at seq 1). */
function relay(sync: BindingSync, extra: Partial<BindingRelayState> = {}): BindingRelayState {
  return parseBindingRelayState({ nativeEpoch: 2, sync, originIncluded: false, reanchor: false, packetsInEpoch: 1, epochFloor: 1, compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved: null, cache: NO_CACHE, ...extra });
}
const FRESH = relay({ kind: "fresh", basis: "reset" }, { packetsInEpoch: 0 });
const SYNCED = relay({ kind: "synced", mark: MARK1 });
const PENDING = relay({ kind: "pending", prior: { kind: "synced", mark: MARK1 }, packetId: P2, range: RANGE2, autoResends: 0, manualResends: 0, attachOverride: false });
const SUSPECT = relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null });
const STATES = { fresh: FRESH, synced: SYNCED, pending: PENDING, suspect: SUSPECT } as const;
type StateName = keyof typeof STATES;

function record(run: RunId, packetId: RelayPacketId, outcome: DeliveryStatus, extra: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const decided = outcome === "in_flight" ? { kind: "in_flight" as const } : outcome === "recorded" ? { kind: "recorded" as const, evidence: "E3" as const, decidedSeq: 5, decidedAt: 5, verifiedInRun: null }
    : outcome === "unknown" ? { kind: "unknown" as const, reason: "no_evidence" as const, decidedSeq: 5, decidedAt: 5 } : { kind: "not_recorded" as const, reason: "rejected_before_insert" as const, decidedSeq: 5, decidedAt: 5 };
  return { runId: run, packetId, channel: "text_block", position: { kind: "seq", before: 4 }, outcome: decided, consentLogSeq: null, inputHmac: "c".repeat(64) as DeliveryRecord["inputHmac"],
    redaction: { rulesVersion: "egress/1", keyId: "key-1", setHmac: "0a1b2c3d" as DeliveryRecord["redaction"]["setHmac"] }, compactionAtDelivery: null, resendOf: null, attachOverride: false, verifyMs: null, realized: null, ...extra };
}
const ROW1: BindingDelivery = { record: record(R1, P1, "recorded"), nativeEpoch: 2, range: RANGE1, bodySha256: SHA1, reanchor: false, mark: MARK1 };
const ROW2: BindingDelivery = { record: record(R2, P2, "unknown"), nativeEpoch: 2, range: RANGE2, bodySha256: SHA2, reanchor: false, mark: null };
function plan(state: BindingRelayState, rows: readonly BindingDelivery[] = [ROW1, ROW2]): VerifyPlan { return planReturnVerify(state, { verify: "on_next_open", moment: "open", deliveries: rows }); }
function result(markers: Readonly<Record<string, MarkerResult>>, extra: Partial<VerifyResult> = {}): VerifyResult {
  return { markers: Object.entries(markers).map(([packetId, value]) => ({ packetId: packetId as RelayPacketId, result: value })), historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 3, ...extra };
}
const verifiedEvent = (state: BindingRelayState, markers: Readonly<Record<string, MarkerResult>>, extra: Partial<VerifyResult> = {}, rows?: readonly BindingDelivery[]): RelayEvent =>
  ({ kind: "verified", plan: plan(state, rows), result: result(markers, extra), inRunId: R3, at: AT });
const bindingOf = (state: BindingRelayState, status: NativeSessionBinding["status"] = "ready"): NativeSessionBinding => ({ harnessId: "xray", controlId: "xray-acp", checkpoint: "native-x", throughRunId: null, status, relay: state });
const ARCHIVED = bindingOf(relay({ kind: "fresh", basis: "user_cleared" }, { nativeEpoch: 1, packetsInEpoch: 0 }), "archived");
const resetOf = (state: BindingRelayState): RelayEvent => ({ kind: "reset", bindings: [ARCHIVED, bindingOf(state)], harnessId: "xray", controlId: "xray-acp" });

// ---------------------------------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------------------------------

/** What one cell expects: the step's kind and, for applied/replaced, the fields of the next state that differ from the input. */
type Cell = { readonly event: RelayEvent; readonly expect:
  | { readonly kind: "applied" | "replaced"; readonly relay: Partial<BindingRelayState>; readonly deliveries?: readonly DeliveryChange[]; readonly note?: Readonly<Record<string, string>> }
  | { readonly kind: "refused"; readonly refusal: Readonly<Record<string, string>> } };
const carryEvent: RelayEvent = { kind: "carry", runId: R3, packet: { id: P3, range: RANGE3 }, attachOverride: false, lateDelivery: false, resend: null };
const insertP3 = (resendOf: RunId | null = null, attachOverride = false): DeliveryChange => ({ kind: "insert", runId: R3, packetId: P3, attachOverride, resendOf });
const settle = (kind: "recorded" | "not_recorded" | "unknown"): RelayEvent => ({ kind: "carry_settled", runId: R2, packetId: P2, bodySha256: SHA2, reanchored: false, row: "in_flight",
  outcome: kind === "recorded" ? { kind, evidence: "E3", decidedSeq: AT.seq, decidedAt: AT.time, verifiedInRun: null } : kind === "not_recorded" ? { kind, reason: "rejected_before_insert", decidedSeq: AT.seq, decidedAt: AT.time } : { kind, reason: "no_evidence", decidedSeq: AT.seq, decidedAt: AT.time } });
const settledRow = (kind: "recorded" | "not_recorded" | "unknown"): DeliveryChange => ({ kind: "outcome", runId: R2, from: "in_flight", outcome: (settle(kind) as Extract<RelayEvent, { kind: "carry_settled" }>).outcome });
const plainSettled: RelayEvent = { kind: "plain_settled", input: "recorded", agentOutput: true, contextThroughSeq: 8 };
const cleared = (state: BindingRelayState): Partial<BindingRelayState> => ({ nativeEpoch: state.nativeEpoch + 1, sync: { kind: "fresh", basis: "user_cleared" }, epochFloor: 15, reanchor: false, packetsInEpoch: 0, originIncluded: false, consentKey: null });
const resetRelay: Partial<BindingRelayState> = { nativeEpoch: 3, sync: { kind: "fresh", basis: "reset" }, epochFloor: 1, originIncluded: false, reanchor: false, packetsInEpoch: 0, compactionSeen: { count: 0, digest: null } };
const notApplicable = { code: "not_applicable" };
const MARK2: DeliveredMark = { throughSeq: 9, chain: chainAfter(MARK1.chain, SHA2), lastPacketId: P2, evidence: "E3", basis: "evidence" };
const BASE_MARK: DeliveredMark = { throughSeq: 2, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "E2", basis: "evidence" };

const TABLE: Readonly<Record<StateName, Readonly<Record<RelayEventLetter, Cell>>>> = {
  fresh: {
    a: { event: carryEvent, expect: { kind: "applied", relay: { sync: { kind: "pending", prior: FRESH.sync as never, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 0, attachOverride: false } }, deliveries: [insertP3()] } },
    b: { event: { kind: "plain", foreign: true }, expect: { kind: "applied", relay: {} } },
    n: { event: { kind: "alone" }, expect: { kind: "applied", relay: {} } },
    c: { event: { kind: "command_kept" }, expect: { kind: "applied", relay: {} } },
    d: { event: { kind: "compaction", cursor: CURSOR }, expect: { kind: "applied", relay: { compactionSeen: CURSOR } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(FRESH) } },
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: null, cause: "clear_unconfirmed", floorCandidate: 15, carried: null } } } },
    f: { event: { kind: "rewound", cause: "unknown_command" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: null, cause: "unknown_command", floorCandidate: null, carried: null } } } },
    g: { event: settle("recorded"), expect: { kind: "refused", refusal: notApplicable } },
    h: { event: settle("not_recorded"), expect: { kind: "refused", refusal: notApplicable } },
    i: { event: settle("unknown"), expect: { kind: "refused", refusal: notApplicable } },
    j: { event: plainSettled, expect: { kind: "applied", relay: { sync: { kind: "synced", mark: { throughSeq: 8, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "native", basis: "native" } } } } },
    k: { event: verifiedEvent(FRESH, {}), expect: { kind: "applied", relay: {}, note: { verified: "skipped" } } },
    l: { event: resetOf(FRESH), expect: { kind: "replaced", relay: resetRelay } },
  },
  synced: {
    a: { event: carryEvent, expect: { kind: "applied", relay: { sync: { kind: "pending", prior: SYNCED.sync as never, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 0, attachOverride: false } }, deliveries: [insertP3()] } },
    b: { event: { kind: "plain", foreign: true }, expect: { kind: "applied", relay: {} } },
    n: { event: { kind: "alone" }, expect: { kind: "applied", relay: {} } },
    c: { event: { kind: "command_kept" }, expect: { kind: "applied", relay: {} } },
    d: { event: { kind: "compaction", cursor: CURSOR }, expect: { kind: "applied", relay: { compactionSeen: CURSOR, reanchor: true } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(SYNCED) } },
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null } } } },
    f: { event: { kind: "rewound", cause: "rewind" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null } } } },
    g: { event: settle("recorded"), expect: { kind: "refused", refusal: notApplicable } },
    h: { event: settle("not_recorded"), expect: { kind: "refused", refusal: notApplicable } },
    i: { event: settle("unknown"), expect: { kind: "refused", refusal: notApplicable } },
    j: { event: plainSettled, expect: { kind: "applied", relay: {} } },
    k: { event: verifiedEvent(SYNCED, { [P1]: "present" }), expect: { kind: "applied", relay: {}, note: { verified: "kept" } } },
    l: { event: resetOf(SYNCED), expect: { kind: "replaced", relay: resetRelay } },
  },
  pending: {
    a: { event: { ...carryEvent, resend: { by: "auto", of: R2 } } as RelayEvent, expect: { kind: "applied", relay: { sync: { ...PENDING.sync, packetId: P3, range: RANGE3, autoResends: 1 } as BindingSync }, deliveries: [insertP3(R2)] } },
    b: { event: { kind: "plain", foreign: true }, expect: { kind: "refused", refusal: notApplicable } },
    n: { event: { kind: "alone" }, expect: { kind: "applied", relay: {} } },
    c: { event: { kind: "command_kept" }, expect: { kind: "applied", relay: {} } },
    d: { event: { kind: "compaction", cursor: CURSOR }, expect: { kind: "applied", relay: { compactionSeen: CURSOR } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(PENDING) } },
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null } } } },
    f: { event: { kind: "rewound", cause: "rewind" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null } } } },
    g: { event: settle("recorded"), expect: { kind: "applied", relay: { sync: { kind: "synced", mark: MARK2 }, packetsInEpoch: 2 }, deliveries: [settledRow("recorded")] } },
    h: { event: settle("not_recorded"), expect: { kind: "applied", relay: { sync: { kind: "synced", mark: MARK1 } }, deliveries: [settledRow("not_recorded")] } },
    i: { event: settle("unknown"), expect: { kind: "applied", relay: {}, deliveries: [settledRow("unknown")] } },
    j: { event: plainSettled, expect: { kind: "refused", refusal: notApplicable } },
    k: { event: verifiedEvent(PENDING, { [P2]: "present" }), expect: { kind: "applied", relay: { sync: { kind: "synced", mark: { ...MARK2, evidence: "E2" } }, packetsInEpoch: 2 },
      deliveries: [{ kind: "outcome", runId: R2, from: "unknown", outcome: { kind: "recorded", evidence: "E2", decidedSeq: AT.seq, decidedAt: AT.time, verifiedInRun: R3 } }], note: { verified: "recorded" } } },
    l: { event: resetOf(PENDING), expect: { kind: "replaced", relay: resetRelay } },
  },
  suspect: {
    a: { event: { ...carryEvent, retreat: { firstFromSeq: 3 } } as RelayEvent, expect: { kind: "applied", relay: { sync: { kind: "pending", prior: { kind: "suspect", mark: BASE_MARK, cause: "rewind", floorCandidate: null, carried: null }, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 0, attachOverride: false } }, deliveries: [insertP3()] } },
    b: { event: { kind: "plain", foreign: true }, expect: { kind: "refused", refusal: { code: "verify_first", cause: "rewind" } } },
    n: { event: { kind: "alone" }, expect: { kind: "applied", relay: {} } },
    c: { event: { kind: "command_kept" }, expect: { kind: "applied", relay: {} } },
    d: { event: { kind: "compaction", cursor: CURSOR }, expect: { kind: "applied", relay: { compactionSeen: CURSOR } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(SUSPECT) } },
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null } } } },
    f: { event: { kind: "rewound", cause: "unknown_command" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "unknown_command", floorCandidate: null, carried: null } } } },
    g: { event: settle("recorded"), expect: { kind: "refused", refusal: notApplicable } },
    h: { event: settle("not_recorded"), expect: { kind: "refused", refusal: notApplicable } },
    i: { event: settle("unknown"), expect: { kind: "refused", refusal: notApplicable } },
    j: { event: plainSettled, expect: { kind: "applied", relay: {} } },
    k: { event: verifiedEvent(SUSPECT, { [P1]: "absent" }), expect: { kind: "applied", relay: { sync: { kind: "synced", mark: BASE_MARK } }, note: { verified: "retreated" } } },
    l: { event: resetOf(SUSPECT), expect: { kind: "replaced", relay: resetRelay } },
  },
};

/** Compares a step with its cell: the fields the cell names take its values, every other field of the state is unchanged. */
function check(name: string, state: BindingRelayState, cell: Cell, actual: RelayStep): void {
  assert.equal(actual.kind, cell.expect.kind, name + ": " + JSON.stringify(actual));
  if (cell.expect.kind === "refused" || actual.kind === "refused") {
    if (actual.kind === "refused" && cell.expect.kind === "refused") for (const [key, value] of Object.entries(cell.expect.refusal)) assert.equal((actual.refusal as Readonly<Record<string, unknown>>)[key], value, name);
    return;
  }
  const base = actual.kind === "replaced" ? parseBindingRelayState({ ...state, compactionSeen: { count: 0, digest: null }, vendorObserved: null, cache: NO_CACHE }) : state;
  assert.deepEqual(actual.relay, parseBindingRelayState({ ...base, ...cell.expect.relay }), name);
  assert.deepEqual(actual.deliveries, cell.expect.deliveries ?? [], name);
  for (const [key, value] of Object.entries(cell.expect.note ?? {})) assert.equal((actual.note as Readonly<Record<string, unknown>>)[key], value, name);
  if (actual.kind === "replaced") assert.deepEqual(actual.archived, state, name + ": the archived binding keeps its relay state");
}

test("G068-P01 every cell of §7.2's table — 4 states × 14 events — is defined, and gives what the table says", () => {
  const names = Object.keys(TABLE) as StateName[];
  assert.deepEqual(names, ["fresh", "synced", "pending", "suspect"]);
  let cells = 0;
  for (const name of names) {
    assert.deepEqual(Object.keys(TABLE[name]).sort(), [...RELAY_EVENT_LETTERS].sort(), name + " has a cell for each of the 14 events");
    for (const letter of RELAY_EVENT_LETTERS) {
      const cell = TABLE[name][letter];
      assert.equal(eventLetter(cell.event), letter, name + " × " + letter + " is that event");
      check(name + " × " + letter, STATES[name], cell, step(STATES[name], cell.event));
      cells++;
    }
  }
  assert.equal(cells, 56);
});

test("G068-P01 each SuspectCause is produced by some transition: f, e′, k, D6 here and m in the migration", () => {
  const produced = new Set<SuspectCause>();
  const collect = (outcome: RelayStep) => { if (outcome.kind !== "refused" && outcome.relay.sync.kind === "suspect") produced.add(outcome.relay.sync.cause); };
  for (const name of Object.keys(TABLE) as StateName[]) for (const letter of RELAY_EVENT_LETTERS) collect(step(STATES[name], TABLE[name][letter].event));
  collect(step(SYNCED, { kind: "rewound", cause: "rewind" }));
  // k on a synced binding whose last marker is absent while the cursor did not move: marker_absent.
  collect(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "absent" })));
  // D6: a process Driver's unknown Turn continued in its native session.
  collect(step(PENDING, { kind: "unknown_turn_continued" }));
  // m: the v12 migration of the D1 shape (a command between facts owed), from G066's frozen fixture.
  const fixture = loadV12Fixture("d1"), session = fixture.sessions[0]!;
  const migrated = migrateSession(parseSession(session.snapshot), session.events.map(event => ({ seq: event.seq, type: event.type, data: event.data })));
  for (const state of migrated.bindings) if (state.sync.kind === "suspect") produced.add(state.sync.cause);
  assert.deepEqual([...produced].sort(), [...SUSPECT_CAUSES].sort());
});

// ---------------------------------------------------------------------------------------------------------------------
// One invalid sample per rule
// ---------------------------------------------------------------------------------------------------------------------

test("G068 every rule refuses its invalid sample instead of passing it silently", () => {
  const refused = (outcome: RelayStep, expected: Readonly<Record<string, string>>, label: string) => {
    assert.equal(outcome.kind, "refused", label + ": " + JSON.stringify(outcome));
    if (outcome.kind === "refused") for (const [key, value] of Object.entries(expected)) assert.equal((outcome.refusal as Readonly<Record<string, unknown>>)[key], value, label);
  };
  const exhausted = relay({ ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 });
  refused(step(PENDING, carryEvent), notApplicable, "a on pending only as a resend");
  refused(step(exhausted, { ...carryEvent, resend: { by: "auto", of: R2 } }), { code: "RELAY_CHOICE_REQUIRED", cause: "delivery_unconfirmed" }, "at most one automatic resend");
  refused(step(PENDING, { ...carryEvent, lateDelivery: true, resend: { by: "auto", of: R2 } }), { code: "RELAY_CHOICE_REQUIRED", cause: "delivery_unconfirmed" }, "no automatic resend with lateDelivery");
  refused(step(relay({ ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), manualResends: 256 }), { ...carryEvent, resend: { by: "user", of: R2 } }), { code: "invalid" }, "manual resends are bounded");
  refused(step(SUSPECT, carryEvent), { code: "verify_first", cause: "rewind" }, "a on suspect only after the user's retreat choice");
  refused(step(SYNCED, { ...carryEvent, retreat: { firstFromSeq: 3 } }), { code: "invalid" }, "only a suspect binding retreats");
  refused(step(SYNCED, { ...carryEvent, resend: { by: "user", of: R2 } }), { code: "invalid" }, "only a pending binding resends");
  refused(step(PENDING, { kind: "plain", foreign: false }), notApplicable, "b does not happen on pending");
  refused(step(SUSPECT, { kind: "plain", foreign: true }), { code: "verify_first" }, "b on suspect{rewind} with foreign facts checks first");
  refused(step(relay({ ...(SUSPECT.sync as Extract<BindingSync, { kind: "suspect" }>), cause: "unknown_turn" }), { kind: "plain", foreign: true }), { code: "verify_first", cause: "unknown_turn" }, "b on suspect{unknown_turn} with foreign facts checks first");
  refused(step(SYNCED, settle("recorded")), notApplicable, "g without a pending packet");
  refused(step(PENDING, { ...(settle("recorded") as Extract<RelayEvent, { kind: "carry_settled" }>), packetId: P3 }), { code: "invalid" }, "g of another packet");
  refused(step(PENDING, { ...(settle("unknown") as Extract<RelayEvent, { kind: "carry_settled" }>), row: "recorded" }), { code: "invalid" }, "a recorded row with a pending binding");
  refused(step(PENDING, plainSettled), notApplicable, "j does not happen on pending");
  refused(step(SYNCED, { kind: "cleared", seq: 1 }), { code: "invalid" }, "a clear at or below the floor");
  refused(step(SYNCED, { kind: "clear_unconfirmed", seq: 0 }), { code: "invalid" }, "an unconfirmed clear at or below the floor");
  refused(step(PENDING, { kind: "verified", plan: plan(SYNCED), result: result({ [P1]: "present" }), inRunId: null, at: AT }), { code: "invalid" }, "a pending binding checks only its own packet");
  refused(step(SYNCED, { kind: "verified", plan: plan(SUSPECT), result: result({ [P1]: "present" }), inRunId: null, at: AT }), { code: "invalid" }, "a synced binding checks its last packet");
  refused(step(PENDING, verifiedEvent(PENDING, { [P2]: "absent" }, {}, [ROW1, { ...ROW2, record: record(R2, P2, "recorded") }])), { code: "invalid" }, "a recorded row never goes back to unknown");
  refused(step(SYNCED, { kind: "reset", bindings: [ARCHIVED], harnessId: "xray", controlId: "xray-acp" }), { code: "invalid" }, "a reset names its own binding");
  refused(step(relay(SYNCED.sync, { nativeEpoch: 16_385 }), { kind: "cleared", seq: 15 }), { code: "invalid" }, "an epoch beyond its bound");
  const noFloor = relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: null, carried: null });
  refused(step(noFloor, { kind: "verified", plan: plan(noFloor), result: result({ [P1]: "absent" }, { historyEmpty: true }), inRunId: null, at: AT }), { code: "invalid" }, "an unconfirmed clear keeps its seq");
  // And what the same rules let through.
  assert.equal(step(exhausted, { ...carryEvent, resend: { by: "user", of: R2 } }).kind, "applied", "the user may send it again");
  assert.equal(step(SUSPECT, { kind: "plain", foreign: false }).kind, "applied", "a single-Harness conversation never checks");
  for (const cause of ["legacy", "marker_absent"] as const) {
    const outcome = step(relay({ kind: "suspect", mark: MARK1, cause, floorCandidate: null, carried: null }), { kind: "plain", foreign: true });
    assert.equal(outcome.kind === "applied" && outcome.note.verified, "nothing_owed", cause + " passes with nothing owed");
  }
  assert.equal(step(SYNCED, { ...(settle("recorded") as Extract<RelayEvent, { kind: "carry_settled" }>), packetId: P1, row: "recorded" }).kind, "applied", "E1 decided it before the settlement");
});

// ---------------------------------------------------------------------------------------------------------------------
// k, result by result
// ---------------------------------------------------------------------------------------------------------------------

function applied(outcome: RelayStep): Extract<RelayStep, { kind: "applied" }> { assert.equal(outcome.kind, "applied", JSON.stringify(outcome)); return outcome as Extract<RelayStep, { kind: "applied" }>; }

test("G068 k on a pending binding checks only its own packet: an old packet present never moves it, its row is corrected (VF1-01, VF1-13)", () => {
  for (const [value, reason] of [["absent", "absent"], ["compacted", "compacted"], ["outside_window", "outside_window"], ["unavailable", "verify_unavailable"]] as const) {
    const outcome = applied(step(PENDING, verifiedEvent(PENDING, { [P2]: value, [P1]: "present" })));
    assert.equal(outcome.relay.sync.kind, "pending", value);
    assert.equal(outcome.relay.reanchor, value === "compacted", value + " sets reanchor only when compacted");
    assert.deepEqual(outcome.deliveries, [{ kind: "outcome", runId: R2, from: "unknown", outcome: { kind: "unknown", reason, decidedSeq: AT.seq, decidedAt: AT.time } }]);
  }
  // A resend P3 superseded P2: P2 found after its position (a late write) corrects P2's row, and P3 stays pending.
  const resent = relay({ kind: "pending", prior: { kind: "synced", mark: MARK1 }, packetId: P3, range: RANGE3, autoResends: 1, manualResends: 0, attachOverride: false });
  const rows: readonly BindingDelivery[] = [ROW1, ROW2, { record: record(R3, P3, "unknown", { resendOf: R2 }), nativeEpoch: 2, range: RANGE3, bodySha256: SHA3, reanchor: false, mark: null }];
  const checked = plan(resent, rows);
  assert.equal(checked.kind === "pending" && checked.earlier.map(marker => marker.packetId).join(), P2);
  const late = applied(step(resent, { kind: "verified", plan: checked, result: result({ [P3]: "absent", [P2]: "present" }), inRunId: R3, at: AT }));
  assert.equal(late.relay.sync.kind === "pending" && late.relay.sync.packetId, P3);
  assert.deepEqual(late.deliveries.map(change => change.runId + ":" + (change.kind === "outcome" ? change.outcome.kind : "insert")), [R2 + ":recorded", R3 + ":unknown"]);
  // The first packet of an epoch (prior without a mark) is checked too.
  const first = relay({ kind: "pending", prior: { kind: "fresh", basis: "new" }, packetId: P2, range: RANGE2, autoResends: 0, manualResends: 0, attachOverride: false }, { nativeEpoch: 1, epochFloor: -1, packetsInEpoch: 0 });
  const found = applied(step(first, verifiedEvent(first, { [P2]: "present" }, {}, [{ ...ROW2, nativeEpoch: 1 }])));
  assert.deepEqual(found.relay.sync, { kind: "synced", mark: { throughSeq: 9, chain: chainAfter(null, SHA2), lastPacketId: P2, evidence: "E2", basis: "evidence" } });
});

test("G068 k on a synced binding: present keeps it, outside the window or unavailable only records the check, absent is marker_absent, compaction re-anchors", () => {
  assert.equal(applied(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "outside_window" }))).note.verified, "undecided");
  assert.equal(applied(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "unavailable" }))).changed, false);
  assert.deepEqual(applied(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "absent" }))).relay.sync, { kind: "suspect", mark: MARK1, cause: "marker_absent", floorCandidate: null, carried: null });
  assert.equal(applied(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "compacted" }))).relay.reanchor, true);
  // Absent after the cursor moved since delivery is a compaction, not a missing marker (VF1-08).
  const delivered = [{ ...ROW1, record: record(R1, P1, "recorded", { compactionAtDelivery: { count: 0, digest: null } }) }];
  const moved = applied(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "absent" }, { compaction: CURSOR }, delivered)));
  assert.equal(moved.relay.sync.kind, "synced"); assert.equal(moved.relay.reanchor, true); assert.deepEqual(moved.relay.compactionSeen, CURSOR);
  const still = applied(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "absent" }, { compaction: { count: 0, digest: null } }, delivered)));
  assert.equal(still.relay.sync.kind, "suspect"); assert.equal(still.relay.reanchor, false);
  // A mark without a packet (native, origin, legacy) has nothing to check (RT1-M11).
  assert.deepEqual(plan(relay({ kind: "synced", mark: { ...MARK1, lastPacketId: null, chain: EMPTY_CHAIN, evidence: "native", basis: "native" } })), { kind: "skip", reason: "no_marker" });
});

test("G068 k on a suspect binding: all present, the newest present, none present (the epoch base), compaction, and undecided answers", () => {
  const MARK0: DeliveredMark = { throughSeq: 2, chain: chainAfter(null, SHA3), lastPacketId: P0, evidence: "E1", basis: "evidence" };
  const MARK_B: DeliveredMark = { throughSeq: 9, chain: chainAfter(MARK1.chain, SHA2), lastPacketId: P2, evidence: "E3", basis: "evidence" };
  const rows: readonly BindingDelivery[] = [
    { record: record(R0, P0, "recorded"), nativeEpoch: 1, range: { fromSeq: 1, throughSeq: 2, fromRun: 0, throughRun: 0 }, bodySha256: SHA3, reanchor: false, mark: MARK0 },
    ROW1, { ...ROW2, record: record(R2, P2, "recorded"), mark: MARK_B }];
  const state = relay({ kind: "suspect", mark: MARK_B, cause: "rewind", floorCandidate: null, carried: null }, { packetsInEpoch: 2 });
  const checked = plan(state, rows);
  assert.equal(checked.kind === "suspect" && checked.markers.map(marker => marker.packetId).join(), [P1, P2].join(), "only this epoch's recorded packets");
  const at = (markers: Readonly<Record<string, MarkerResult>>, extra: Partial<VerifyResult> = {}) => applied(step(state, { kind: "verified", plan: checked, result: result(markers, extra), inRunId: R3, at: AT }));
  assert.deepEqual(at({ [P1]: "present", [P2]: "present" }).relay.sync, { kind: "synced", mark: MARK_B });
  assert.deepEqual(at({ [P1]: "present", [P2]: "absent" }).relay.sync, { kind: "synced", mark: MARK1 }, "the mark goes back to the last marker still there");
  const none = at({ [P1]: "absent", [P2]: "absent" });
  assert.deepEqual(none.relay.sync, { kind: "synced", mark: BASE_MARK }, "max(first packet's fromSeq − 1, epochFloor)"); assert.equal(none.relay.reanchor, false);
  const compacted = at({ [P1]: "compacted", [P2]: "present" });
  assert.deepEqual(compacted.relay.sync, { kind: "synced", mark: MARK_B }); assert.equal(compacted.relay.reanchor, true);
  const undecided = at({ [P1]: "unavailable", [P2]: "outside_window" });
  assert.equal(undecided.relay.sync.kind, "suspect"); assert.equal(undecided.note.choice, "verify_required");
  // The floor bounds the retreat: with a floor above the first packet's fromSeq − 1, the mark stops at the floor.
  const floored = relay({ kind: "suspect", mark: MARK_B, cause: "rewind", floorCandidate: null, carried: null }, { epochFloor: 5 });
  const back = applied(step(floored, { kind: "verified", plan: plan(floored, rows), result: result({ [P1]: "absent", [P2]: "absent" }), inRunId: null, at: AT }));
  assert.equal(back.relay.sync.kind === "synced" && back.relay.sync.mark.throughSeq, 5);
});

test("G068 k on an unconfirmed clear: an empty history or every marker gone confirms it; a marker still there restores the state before it", () => {
  const unconfirmed = relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null });
  const at = (markers: Readonly<Record<string, MarkerResult>>, extra: Partial<VerifyResult> = {}, rows: readonly BindingDelivery[] = [ROW1]) =>
    applied(step(unconfirmed, { kind: "verified", plan: plan(unconfirmed, rows), result: result(markers, extra), inRunId: null, at: AT }));
  for (const confirmed of [at({ [P1]: "absent" }, { historyEmpty: true }), at({ [P1]: "absent" })]) {
    assert.deepEqual(confirmed.relay.sync, { kind: "fresh", basis: "user_cleared" });
    assert.equal(confirmed.relay.epochFloor, 15); assert.equal(confirmed.relay.nativeEpoch, 3); assert.equal(confirmed.note.verified, "cleared");
  }
  assert.deepEqual(at({ [P1]: "present" }).relay.sync, { kind: "synced", mark: MARK1 }, "the clear did not happen");
  // No marker to look for and the history not empty: the clear did not happen, but only a mark that claims nothing comes back.
  assert.equal(at({}, { historyEmpty: false }, []).note.choice, "verify_required", "a packet mark without its marker stays suspect");
  const native: DeliveredMark = { throughSeq: 8, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "native", basis: "native" };
  const plain = relay({ kind: "suspect", mark: native, cause: "clear_unconfirmed", floorCandidate: 15, carried: null });
  assert.deepEqual(applied(step(plain, { kind: "verified", plan: plan(plain, []), result: result({}, { historyEmpty: false }), inRunId: null, at: AT })).relay.sync, { kind: "synced", mark: native }, "a native mark is restored");
  assert.equal(at({ [P1]: "absent" }, { compaction: CURSOR }, [{ ...ROW1, record: record(R1, P1, "recorded", { compactionAtDelivery: { count: 0, digest: null } }) }]).note.choice, "verify_required", "gone after a compaction proves no clear");
  assert.equal(at({ [P1]: "unavailable" }).note.choice, "verify_required");
});

test("G068 D6: an unknown Turn continued is suspect{unknown_turn}; its entry found advances by its carried packet (E2), not found returns to the prior", () => {
  const carried = applied(step(PENDING, { kind: "unknown_turn_continued" })).relay;
  assert.deepEqual(carried.sync, { kind: "suspect", mark: MARK1, cause: "unknown_turn", floorCandidate: null, carried: { prior: { kind: "synced", mark: MARK1 }, packetId: P2, range: RANGE2 } });
  const at = (value: MarkerResult) => applied(step(carried, verifiedEvent(carried, { [P2]: value })));
  const present = at("present");
  assert.deepEqual(present.relay.sync, { kind: "synced", mark: { ...MARK2, evidence: "E2" } }); assert.equal(present.relay.packetsInEpoch, 2);
  assert.equal(present.deliveries[0]?.kind === "outcome" && present.deliveries[0].outcome.kind, "recorded");
  const absent = at("absent");
  assert.deepEqual(absent.relay.sync, { kind: "synced", mark: MARK1 });
  assert.equal(absent.deliveries[0]?.kind === "outcome" && absent.deliveries[0].outcome.kind === "unknown" && absent.deliveries[0].outcome.reason, "absent");
  assert.equal(at("unavailable").note.choice, "verify_required"); assert.equal(at("outside_window").relay.sync.kind, "suspect");
  // Without a packet: the Turn's own entry decides, the mark does not move.
  const plain = applied(step(SYNCED, { kind: "unknown_turn_continued" })).relay;
  assert.deepEqual(plan(plain), { kind: "unknown_turn", marker: null });
  const entry = (value: MarkerResult) => applied(step(plain, { kind: "verified", plan: plan(plain), result: result({}), turnEntry: value, inRunId: null, at: AT }));
  assert.deepEqual(entry("present").relay.sync, { kind: "synced", mark: MARK1 });
  assert.equal(entry("absent").relay.sync.kind, "suspect", "carried=null and not there: unchanged (§7.2)");
  // Already suspect: the stronger cause stays.
  assert.equal(applied(step(SUSPECT, { kind: "unknown_turn_continued" })).changed, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// The check plan (§7.3) and the small rules
// ---------------------------------------------------------------------------------------------------------------------

test("G068 planReturnVerify checks at the open for on_next_open, at the settlement for after_turn, and never for none", () => {
  for (const [verify, moment, kind] of [["on_next_open", "open", "pending"], ["on_next_open", "settled", "skip"], ["after_turn", "settled", "pending"], ["after_turn", "open", "skip"], ["none", "open", "skip"]] as const)
    assert.equal(planReturnVerify(PENDING, { verify, moment, deliveries: [ROW1, ROW2] }).kind, kind, verify + " at " + moment);
  assert.deepEqual(planReturnVerify(PENDING, { verify: "none", moment: "open", deliveries: [] }), { kind: "skip", reason: "unavailable" });
  assert.deepEqual(plan(FRESH), { kind: "skip", reason: "fresh" });
  assert.equal(plan(SYNCED).kind, "synced"); assert.equal(plan(SUSPECT).kind, "suspect");
  assert.equal(plan(relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null })).kind, "clear");
  const pending = plan(PENDING);
  assert.equal(pending.kind === "pending" && pending.marker.packetId, P2, "the pending packet itself, not the prior's last packet (VF1-01)");
  const many: BindingDelivery[] = Array.from({ length: 6 }, (_, index) => ({ ...ROW1, record: record(runId("run-m" + index), packet(String(index + 4)), "recorded"), mark: { ...MARK1, lastPacketId: packet(String(index + 4)) } }));
  const checked = planReturnVerify(SUSPECT, { verify: "on_next_open", moment: "open", deliveries: many });
  assert.equal(checked.kind === "suspect" && checked.markers.length, 4, "at most 4 recorded markers");
});

test("G068 settledOutcome over R8 §2.8: evidence alone decides, and no Driver report claims recorded when the input never arrived", () => {
  // The declarations of §8.1 that settlement reads.
  const drivers = { claude: { successProvesRecorded: true, lateDelivery: false }, codex: { successProvesRecorded: false, lateDelivery: false }, opencode: { successProvesRecorded: true, lateDelivery: true },
    dsh: { successProvesRecorded: false, lateDelivery: false }, hermes: { successProvesRecorded: true, lateDelivery: false }, openclaw: { successProvesRecorded: false, lateDelivery: true } } as const;
  type Report = { readonly inserted: boolean; readonly status: "completed" | "cancelled" | "failed"; readonly input?: "recorded" | "not_recorded"; readonly e1?: true; readonly expect: "recorded" | "not_recorded" | "unknown"; readonly reason?: string };
  const rows: Readonly<Record<string, Readonly<Record<keyof typeof drivers, Report>>>> = {
    "正常完成": { claude: { inserted: true, status: "completed", input: "recorded", expect: "recorded" }, codex: { inserted: true, status: "completed", e1: true, expect: "recorded" }, opencode: { inserted: true, status: "completed", input: "recorded", expect: "recorded" },
      dsh: { inserted: true, status: "completed", e1: true, expect: "recorded" }, hermes: { inserted: true, status: "completed", input: "recorded", expect: "recorded" }, openclaw: { inserted: true, status: "completed", expect: "unknown", reason: "no_evidence" } },
    "模型已开始后取消": { claude: { inserted: true, status: "cancelled", expect: "unknown", reason: "no_evidence" }, codex: { inserted: true, status: "cancelled", e1: true, expect: "recorded" }, opencode: { inserted: true, status: "cancelled", expect: "unknown", reason: "late_delivery" },
      dsh: { inserted: true, status: "cancelled", e1: true, expect: "recorded" }, hermes: { inserted: true, status: "cancelled", expect: "unknown", reason: "no_evidence" }, openclaw: { inserted: true, status: "cancelled", expect: "unknown", reason: "late_delivery" } },
    "插入前取消": { claude: { inserted: false, status: "cancelled", expect: "unknown", reason: "no_evidence" }, codex: { inserted: false, status: "cancelled", input: "not_recorded", expect: "not_recorded", reason: "cancelled_before_insert" }, opencode: { inserted: false, status: "cancelled", expect: "unknown", reason: "late_delivery" },
      dsh: { inserted: false, status: "cancelled", expect: "unknown", reason: "no_evidence" }, hermes: { inserted: false, status: "cancelled", expect: "unknown", reason: "no_evidence" }, openclaw: { inserted: false, status: "cancelled", expect: "unknown", reason: "late_delivery" } },
    "Provider 拒绝": { claude: { inserted: true, status: "failed", input: "recorded", expect: "recorded" }, codex: { inserted: true, status: "failed", e1: true, expect: "recorded" }, opencode: { inserted: true, status: "failed", input: "recorded", expect: "recorded" },
      dsh: { inserted: true, status: "failed", expect: "unknown", reason: "no_evidence" }, hermes: { inserted: true, status: "failed", expect: "unknown", reason: "no_evidence" }, openclaw: { inserted: true, status: "failed", expect: "unknown", reason: "no_evidence" } },
    "接口或适配器校验失败": Object.fromEntries((Object.keys(drivers) as (keyof typeof drivers)[]).map(name => [name, { inserted: false, status: "failed", input: "not_recorded", expect: "not_recorded", reason: "rejected_before_insert" }])) as never,
    "Hub 驱动合成“未发送”": Object.fromEntries((Object.keys(drivers) as (keyof typeof drivers)[]).map(name => [name, { inserted: false, status: "failed", input: "not_recorded", expect: "not_recorded", reason: "driver_synthesized" }])) as never,
    "原生成功报告但输入被丢": Object.fromEntries((Object.keys(drivers) as (keyof typeof drivers)[]).map(name => [name, drivers[name].successProvesRecorded
      ? { inserted: true, status: "completed", input: "recorded", expect: "recorded" } : { inserted: false, status: "completed", expect: "unknown", reason: "no_evidence" }])) as never,
    "进程在回合中被杀": Object.fromEntries((Object.keys(drivers) as (keyof typeof drivers)[]).map(name => [name, { inserted: true, status: "failed", expect: "unknown", reason: "no_evidence" }])) as never,
  };
  for (const [situation, harnesses] of Object.entries(rows)) for (const [name, report] of Object.entries(harnesses) as [keyof typeof drivers, Report][]) {
    const declared = drivers[name], label = situation + " · " + name;
    const outcome = report.e1 ? { kind: "recorded" as const } : settledOutcome({ dispatched: true, status: report.status, input: report.input,
      ...(report.reason === "cancelled_before_insert" || report.reason === "driver_synthesized" ? { notRecorded: report.reason } : {}), ...declared }, AT);
    assert.equal(outcome.kind, report.expect, label);
    if ("reason" in outcome) assert.equal(outcome.reason, report.reason, label);
    if (outcome.kind === "recorded") assert.equal(report.inserted, true, label + ": recorded only when the input is in the native history");
    if (outcome.kind === "not_recorded") assert.equal(report.inserted, false, label + ": not recorded only when it is not");
  }
  assert.deepEqual(settledOutcome({ dispatched: false, status: null, input: undefined, successProvesRecorded: true, lateDelivery: false }, AT), { kind: "not_recorded", reason: "never_dispatched", decidedSeq: 20, decidedAt: 1000 });
});

test("G068 commandTurnEvent over R8 §2.9: a command's effect is its declared effect only when it ran", () => {
  const cases: readonly [string, ContextEffect, Parameters<typeof commandOutcome>, boolean, RelayEventLetter][] = [
    ["Claude skill", "keep", [true, "completed", "recorded"], false, "c"], ["Claude /compact", "compact", [true, "completed", "recorded"], false, "d"],
    ["Claude /clear (synthesized new session)", "clear", [true, "completed", "recorded"], true, "e"], ["Claude /model", "none", [true, "completed", "recorded"], false, "c"],
    ["Claude /remote-control (hidden none)", "none", [true, "failed", "not_recorded"], false, "c"],
    ["Codex /skill:", "keep", [true, "completed", "recorded"], false, "c"], ["Codex /compact", "compact", [true, "completed", "recorded"], false, "d"],
    ["Codex /compact without turnId", "compact", [true, "failed", "not_recorded"], false, "c"], ["Codex /export", "none", [true, "completed", "not_recorded"], false, "c"],
    ["OpenCode config command", "keep", [true, "completed", "recorded"], false, "c"], ["OpenCode COMPACT_IGNORED", "compact", [true, "failed", "not_recorded"], false, "c"],
    ["Hermes /steer", "keep", [true, "completed", "recorded"], false, "c"], ["Hermes /compress", "compact", [true, "completed", "recorded"], false, "d"],
    ["Hermes /clear with its fixed receipt", "clear", [true, "completed", "recorded"], true, "e"], ["Hermes /clear without it", "clear", [true, "completed", "recorded"], false, "e′"],
    ["Hermes /clear ended unknown", "clear", [true, "failed", "unknown"], false, "e′"], ["Hermes /undo", "rewind", [true, "completed", "recorded"], false, "f"],
    ["Hermes /undo ended unknown", "rewind", [true, "cancelled", "unknown"], false, "f"], ["Hermes slash.exec", "unknown", [true, "completed", "recorded"], false, "f"],
    ["OpenClaw settings", "none", [true, "completed", "recorded"], false, "c"], ["OpenClaw /new seen new", "clear", [true, "completed", "recorded"], true, "e"],
    ["OpenClaw /reset soft (byArgs compact)", "compact", [true, "completed", "recorded"], false, "d"], ["OpenClaw /bash", "unknown", [true, "completed", "recorded"], false, "f"],
    ["a command never dispatched", "clear", [false, null, "not_recorded"], false, "c"],
  ];
  for (const [label, declared, outcome, cleared, letter] of cases) {
    const event = commandTurnEvent(declared, commandOutcome(...outcome), { cleared, seq: 30, cursor: CURSOR });
    assert.equal(eventLetter(event), letter, label);
  }
  assert.equal((commandTurnEvent("compact", "noop", { cleared: false, seq: 30, cursor: CURSOR })).kind, "command_kept", "Hermes /compress answering noop");
  assert.deepEqual(commandTurnEvent("rewind", "unknown", { cleared: false, seq: 30, cursor: null }), { kind: "rewound", cause: "unknown_command" });
});

test("G068 need: foreign facts above max(mark, floor); the one-time attach ignores the floor; a pending binding owes its packet", () => {
  const facts = [
    { runId: runId("run-a"), seq: 2, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } },
    { runId: runId("run-b"), seq: 5, executedOn: { harnessId: "xray", controlId: "xray-acp", nativeEpoch: 1 } },
    { runId: runId("run-c"), seq: 8, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } },
    { runId: runId("run-d"), seq: 9, executedOn: { harnessId: "xray", controlId: "xray-acp", nativeEpoch: 2 } },
    { runId: runId("run-e"), seq: 11, executedOn: null },
  ];
  const ids = (state: BindingRelayState, attachOverride = false) => owed(state, "xray", "xray-acp", facts, { originHistory: true, attachOverride }).facts.map(fact => fact.runId).join();
  const cleared = relay({ kind: "fresh", basis: "user_cleared" }, { epochFloor: 6, packetsInEpoch: 0 });
  assert.equal(ids(cleared), "run-c,run-e", "the floor hides the facts before the clear, the binding's own epoch-1 Turn included");
  assert.equal(ids(cleared, true), "run-a,run-b,run-c,run-e", "the one-time attach brings them back, the earlier epoch's own Turn as a foreign fact");
  assert.equal(owed(cleared, "xray", "xray-acp", facts, { originHistory: true, attachOverride: true }).origin, true);
  assert.equal(owed(cleared, "xray", "xray-acp", facts, { originHistory: true }).origin, false);
  assert.equal(ids(SYNCED), "run-c,run-e", "above the mark 6");
  assert.equal(ids(PENDING), "run-c,run-e", "a pending binding owes from its prior's mark");
});

test("G068 chain, the next input of a pending binding, and kept processes (§7.2, §7.4, VF1-09)", () => {
  assert.equal(chainAfter(null, SHA1), sha(EMPTY_CHAIN + SHA1)); assert.equal(chainAfter(MARK1.chain, SHA2), sha(MARK1.chain + SHA2));
  assert.equal(pendingResend(PENDING.sync, false), "auto"); assert.equal(pendingResend(PENDING.sync, true), "choice");
  assert.equal(pendingResend({ ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 }, false), "choice"); assert.equal(pendingResend(SYNCED.sync, false), null);
  assert.equal(mayReuseKept(PENDING, "on_next_open"), false); assert.equal(mayReuseKept(SUSPECT, "on_next_open"), false);
  assert.equal(mayReuseKept(SYNCED, "on_next_open"), true); assert.equal(mayReuseKept(PENDING, "after_turn"), true);
  assert.equal(mayReuseKept(relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null }), "after_turn"), false);
  assert.deepEqual(retreatedPrior(SUSPECT, 3), { kind: "suspect", mark: BASE_MARK, cause: "rewind", floorCandidate: null, carried: null });
  assert.equal(retreatedPrior(SYNCED, 3), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// G068-C10: Claude's synthesized clear
// ---------------------------------------------------------------------------------------------------------------------

test("G068-C10 Claude's synthesized clear archives the binding, the new one is fresh{user_cleared} with its observed model, and the model carries over", () => {
  const selection = { harnessId: "claude", controlId: "claude-acp", nativeModel: "default" };
  const clean = { closed: true as const, exitCode: 0, signal: null, protocolFailure: null };
  const turn = (name: string, status: PublicRun["status"], extra: Partial<PublicRun> = {}): PublicRun => ({ id: runId("run-" + name), commandId: commandId("send-" + name), input: "/" + name,
    userMessageId: messageId("message-" + name + "-user"), assistantMessageId: messageId("message-" + name + "-reply"), selection, epoch: 1, status, cancelRequested: false, contextThroughSeq: 1,
    sourceRunIds: [], backend: status === "completed" ? { status: "completed", reason: "end_turn" } : null, cleanup: status === "completed" ? clean : null, error: null, stopRequested: false, awaitingSwitchId: null,
    timing: { acceptedAt: 1, preparingAt: 2, readyAt: 3, dispatchedAt: 4, ...(status === "completed" ? { endedAt: 5 } : {}) }, ...extra });
  const old = parseBindingRelayState({ ...SYNCED, nativeEpoch: 1, epochFloor: -1 });
  const model: NativeSessionBinding = { harnessId: "claude", controlId: "claude-acp", checkpoint: "native-old", throughRunId: runId("run-model"), status: "unconfirmed", observed: { model: "opus-x", options: {} }, relay: old };
  const before = parseSession({ schemaVersion: 13, id: sessionId("session-c10"), version: 3, lastSeq: 6, epoch: 1, status: "open",
    configuration: { workspace: "/tmp/c10", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true }, selection,
    activeRunId: runId("run-clear"), pendingSwitchId: null, runs: [turn("model", "completed"), turn("clear", "running")],
    messages: [{ id: messageId("message-model-user"), runId: runId("run-model"), role: "user", text: "/model", seq: 2, status: "completed" }, { id: messageId("message-clear-user"), runId: runId("run-clear"), role: "user", text: "/clear", seq: 4, status: "running" }],
    switches: [], commands: [{ id: commandId("create-c10"), kind: "create", fingerprint: "a".repeat(64), resultId: "session-c10" }, { id: commandId("send-model"), kind: "send", fingerprint: "b".repeat(64), resultId: "run-model" },
      { id: commandId("send-clear"), kind: "send", fingerprint: "b".repeat(64), resultId: "run-clear" }], nativeBindings: [model] } satisfies SessionSnapshot);
  const endedSeq = before.lastSeq + 1, outcome = step(old, { kind: "cleared", seq: endedSeq, replaced: true });
  assert.equal(outcome.kind, "replaced");
  if (outcome.kind !== "replaced") return;
  assert.deepEqual(outcome.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(outcome.relay.epochFloor, endedSeq); assert.equal(outcome.relay.nativeEpoch, 2);
  const after = parseSession({ ...before, version: before.version + 1, lastSeq: endedSeq, activeRunId: null,
    runs: [before.runs[0]!, turn("clear", "completed")], messages: before.messages.map(message => ({ ...message, status: "completed" as const })),
    nativeBindings: [{ ...model, status: "archived", relay: outcome.archived }, { harnessId: "claude", controlId: "claude-acp", checkpoint: "native-new", throughRunId: runId("run-clear"), status: "ready", observed: model.observed!, relay: outcome.relay }] });
  // assertSessionTransition lets the writer's run.ended with native.cleared archive and replace its binding (G066).
  assert.doesNotThrow(() => assertSessionTransition(before, after, [{ type: "run.ended", data: { runId: "run-clear", native: { cleared: true, replaced: { checkpoint: "native-new" } } } }]));
  assert.throws(() => assertSessionTransition(before, after, [{ type: "run.ended", data: { runId: "run-clear" } }]), /archived only by/);
  // The next Turn applies the model the native session had (`/model opus-x` before `/clear`), not the selection's.
  assert.deepEqual(carriedNativeConfiguration(after, selection, 1), { model: "opus-x" });
});
