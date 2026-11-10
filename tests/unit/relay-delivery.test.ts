import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  EMPTY_CHAIN, SUSPECT_CAUSES, fingerprint, markOf, parseBindingRelayState, relayPacketId,
  type BindingRelayState, type BindingSync, type ContextEffect, type DeliveredMark, type DeliveryRecord, type DeliveryStatus, type Fingerprint, type MarkerResult,
  type RelayPacketId, type SourceRange, type SuspectCause, type VerifyResult,
} from "../../src/contracts/relay.js";
import { commandId, messageId, runId, sessionId, type NativeSessionBinding, type PublicRun, type RunId, type SessionSnapshot } from "../../src/contracts/session.js";
import { commandOutcome } from "../../src/contexts/session/domain/relay/advance.js";
import {
  RELAY_EVENT_LETTERS, chainAfter, commandTurnEvent, eventLetter, foreignTo, heldSince, mayReuseKept, owed, pendingResend, planReturnVerify, admitsWithoutChoice, retreatedPrior, settledOutcome, settledWithoutCheck, step,
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
const SUSPECT = relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null, rewound: false });
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
/** The same epoch base when the user chose to send the complete packet again (F13). */
const CHOSEN_BASE: DeliveredMark = { ...BASE_MARK, evidence: "choice" };
/** PENDING's packet as a suspect state keeps it (F8): the prior it was built on, the packet and its range. */
const CARRIED2 = { prior: { kind: "synced" as const, mark: MARK1 }, packetId: P2, range: RANGE2, attachOverride: false };
/** A native mark (restorable), and P2 carried on a prior standing on it. */
const NATIVE: DeliveredMark = { throughSeq: 8, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "native", basis: "native" };
const CARRIED_NATIVE = { prior: { kind: "synced" as const, mark: NATIVE }, packetId: P2, range: RANGE2, attachOverride: false };

const TABLE: Readonly<Record<StateName, Readonly<Record<RelayEventLetter, Cell>>>> = {
  fresh: {
    a: { event: carryEvent, expect: { kind: "applied", relay: { sync: { kind: "pending", prior: FRESH.sync as never, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 0, attachOverride: false } }, deliveries: [insertP3()] } },
    b: { event: { kind: "plain", foreign: true }, expect: { kind: "applied", relay: {} } },
    n: { event: { kind: "alone" }, expect: { kind: "applied", relay: {} } },
    c: { event: { kind: "command_kept" }, expect: { kind: "applied", relay: {} } },
    d: { event: { kind: "compaction", cursor: CURSOR, ran: false }, expect: { kind: "applied", relay: { compactionSeen: CURSOR } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(FRESH) } },
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: null, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false } } } },
    f: { event: { kind: "rewound", cause: "unknown_command" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: null, cause: "unknown_command", floorCandidate: null, carried: null, rewound: false } } } },
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
    d: { event: { kind: "compaction", cursor: CURSOR, ran: false }, expect: { kind: "applied", relay: { compactionSeen: CURSOR, reanchor: true } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(SYNCED) } },
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false } } } },
    f: { event: { kind: "rewound", cause: "rewind" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null, rewound: false } } } },
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
    d: { event: { kind: "compaction", cursor: CURSOR, ran: false }, expect: { kind: "applied", relay: { compactionSeen: CURSOR, reanchor: true } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(PENDING) } },
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: CARRIED2, rewound: false } } } },
    f: { event: { kind: "rewound", cause: "rewind" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: CARRIED2, rewound: false } } } },
    g: { event: settle("recorded"), expect: { kind: "applied", relay: { sync: { kind: "synced", mark: MARK2 }, packetsInEpoch: 2 }, deliveries: [settledRow("recorded")] } },
    h: { event: settle("not_recorded"), expect: { kind: "applied", relay: { sync: { kind: "synced", mark: MARK1 } }, deliveries: [settledRow("not_recorded")] } },
    i: { event: settle("unknown"), expect: { kind: "applied", relay: {}, deliveries: [settledRow("unknown")] } },
    j: { event: plainSettled, expect: { kind: "refused", refusal: notApplicable } },
    k: { event: verifiedEvent(PENDING, { [P2]: "present" }), expect: { kind: "applied", relay: { sync: { kind: "synced", mark: { ...MARK2, evidence: "E2" } }, packetsInEpoch: 2 },
      deliveries: [{ kind: "outcome", runId: R2, from: "unknown", outcome: { kind: "recorded", evidence: "E2", decidedSeq: AT.seq, decidedAt: AT.time, verifiedInRun: R3 } }], note: { verified: "recorded" } } },
    l: { event: resetOf(PENDING), expect: { kind: "replaced", relay: resetRelay } },
  },
  suspect: {
    a: { event: { ...carryEvent, retreat: { firstFromSeq: 3 } } as RelayEvent, expect: { kind: "applied", relay: { sync: { kind: "pending", prior: { kind: "suspect", mark: CHOSEN_BASE, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 0, attachOverride: false } }, deliveries: [insertP3()] } },
    b: { event: { kind: "plain", foreign: true }, expect: { kind: "refused", refusal: { code: "verify_first", cause: "rewind" } } },
    n: { event: { kind: "alone" }, expect: { kind: "applied", relay: {} } },
    c: { event: { kind: "command_kept" }, expect: { kind: "applied", relay: {} } },
    d: { event: { kind: "compaction", cursor: CURSOR, ran: false }, expect: { kind: "applied", relay: { compactionSeen: CURSOR, reanchor: true } } },
    e: { event: { kind: "cleared", seq: 15 }, expect: { kind: "applied", relay: cleared(SUSPECT) } },
    // An unconfirmed clear on an unchecked rewind keeps the mark and is marked rewound (see the rewound tests).
    "e′": { event: { kind: "clear_unconfirmed", seq: 15 }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: true } } } },
    f: { event: { kind: "rewound", cause: "unknown_command" }, expect: { kind: "applied", relay: { sync: { kind: "suspect", mark: MARK1, cause: "unknown_command", floorCandidate: null, carried: null, rewound: false } } } },
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
  const noFloor = relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: null, carried: null, rewound: false });
  refused(step(noFloor, { kind: "verified", plan: plan(noFloor), result: result({ [P1]: "absent" }, { historyEmpty: true }), inRunId: null, at: AT }), { code: "invalid" }, "an unconfirmed clear keeps its seq");
  // And what the same rules let through.
  assert.equal(step(exhausted, { ...carryEvent, resend: { by: "user", of: R2 } }).kind, "applied", "the user may send it again");
  assert.equal(step(SUSPECT, { kind: "plain", foreign: false }).kind, "applied", "a single-Harness conversation never checks");
  for (const cause of ["legacy", "marker_absent"] as const) {
    const outcome = step(relay({ kind: "suspect", mark: MARK1, cause, floorCandidate: null, carried: null, rewound: false }), { kind: "plain", foreign: true });
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
  assert.deepEqual(applied(step(SYNCED, verifiedEvent(SYNCED, { [P1]: "absent" }))).relay.sync, { kind: "suspect", mark: MARK1, cause: "marker_absent", floorCandidate: null, carried: null, rewound: false });
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
  const state = relay({ kind: "suspect", mark: MARK_B, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, { packetsInEpoch: 2 });
  const checked = plan(state, rows);
  assert.equal(checked.kind === "suspect" && checked.markers.map(marker => marker.packetId).join(), [P1, P2].join(), "only this epoch's recorded packets");
  const at = (markers: Readonly<Record<string, MarkerResult>>, extra: Partial<VerifyResult> = {}) => applied(step(state, { kind: "verified", plan: checked, result: result(markers, extra), inRunId: R3, at: AT }));
  assert.deepEqual(at({ [P1]: "present", [P2]: "present" }).relay.sync, { kind: "synced", mark: MARK_B });
  assert.deepEqual(at({ [P1]: "present", [P2]: "absent" }).relay.sync, { kind: "synced", mark: MARK1 }, "the mark goes back to the last marker still there");
  const none = at({ [P1]: "absent", [P2]: "absent" });
  assert.deepEqual(none.relay.sync, { kind: "synced", mark: BASE_MARK }, "max(first packet's fromSeq − 1, epochFloor)"); assert.equal(none.relay.reanchor, false);
  const compacted = at({ [P1]: "compacted", [P2]: "present" });
  assert.deepEqual(compacted.relay.sync, { kind: "synced", mark: MARK_B }); assert.equal(compacted.relay.reanchor, true);
  // F7: a compacted marker counts as still there — all compacted, or the newest compacted, keeps the mark (an anchor follows);
  // an older one compacted with the newer absent goes back to the older one.
  for (const markers of [{ [P1]: "compacted", [P2]: "compacted" }, { [P1]: "present", [P2]: "compacted" }] as const) {
    const kept = at(markers);
    assert.deepEqual(kept.relay.sync, { kind: "synced", mark: MARK_B }, JSON.stringify(markers)); assert.equal(kept.relay.reanchor, true);
  }
  const older = at({ [P1]: "compacted", [P2]: "absent" });
  assert.deepEqual(older.relay.sync, { kind: "synced", mark: MARK1 }); assert.equal(older.relay.reanchor, true);
  const undecided = at({ [P1]: "unavailable", [P2]: "outside_window" });
  assert.equal(undecided.relay.sync.kind, "suspect"); assert.equal(undecided.note.choice, "verify_required");
  // The floor bounds the retreat: with a floor above the first packet's fromSeq − 1, the mark stops at the floor.
  const floored = relay({ kind: "suspect", mark: MARK_B, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, { epochFloor: 5 });
  const back = applied(step(floored, { kind: "verified", plan: plan(floored, rows), result: result({ [P1]: "absent", [P2]: "absent" }), inRunId: null, at: AT }));
  assert.equal(back.relay.sync.kind === "synced" && back.relay.sync.mark.throughSeq, 5);
});

test("G068 k on an unconfirmed clear: an empty history or every marker gone confirms it; a marker still there restores the state before it", () => {
  const unconfirmed = relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false });
  const at = (markers: Readonly<Record<string, MarkerResult>>, extra: Partial<VerifyResult> = {}, rows: readonly BindingDelivery[] = [ROW1]) =>
    applied(step(unconfirmed, { kind: "verified", plan: plan(unconfirmed, rows), result: result(markers, extra), inRunId: null, at: AT }));
  const known: readonly BindingDelivery[] = [{ ...ROW1, record: record(R1, P1, "recorded", { compactionAtDelivery: { count: 0, digest: null } }) }];
  for (const confirmed of [at({ [P1]: "absent" }, { historyEmpty: true }), at({ [P1]: "absent" }, { compaction: { count: 0, digest: null } }, known)]) {
    assert.deepEqual(confirmed.relay.sync, { kind: "fresh", basis: "user_cleared" });
    assert.equal(confirmed.relay.epochFloor, 15); assert.equal(confirmed.relay.nativeEpoch, 3); assert.equal(confirmed.note.verified, "cleared");
  }
  assert.deepEqual(at({ [P1]: "present" }).relay.sync, { kind: "synced", mark: MARK1 }, "the clear did not happen");
  // No marker to look for and the history not empty: the clear did not happen, but only a mark that claims nothing comes back.
  assert.equal(at({}, { historyEmpty: false }, []).note.choice, "verify_required", "a packet mark without its marker stays suspect");
  const native: DeliveredMark = { throughSeq: 8, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "native", basis: "native" };
  const plain = relay({ kind: "suspect", mark: native, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false });
  assert.deepEqual(applied(step(plain, { kind: "verified", plan: plan(plain, []), result: result({}, { historyEmpty: false }), inRunId: null, at: AT })).relay.sync, { kind: "synced", mark: native }, "a native mark is restored");
  assert.equal(at({ [P1]: "absent" }, { compaction: CURSOR }, [{ ...ROW1, record: record(R1, P1, "recorded", { compactionAtDelivery: { count: 0, digest: null } }) }]).note.choice, "verify_required", "gone after a compaction proves no clear");
  assert.equal(at({ [P1]: "unavailable" }).note.choice, "verify_required");
  // Rule 4 needs a compaction ruled out: a row that kept no cursor (a Driver without compaction evidence) cannot tell.
  assert.equal(at({ [P1]: "absent" }).note.choice, "verify_required", "all absent with no cursor to rule a compaction out");
});

test("G068 D6: an unknown Turn continued is suspect{unknown_turn}; its entry found advances by its carried packet (E2), not found returns to the prior", () => {
  const carried = applied(step(PENDING, { kind: "unknown_turn_continued" })).relay;
  assert.deepEqual(carried.sync, { kind: "suspect", mark: MARK1, cause: "unknown_turn", floorCandidate: null, carried: CARRIED2, rewound: false });
  const at = (value: MarkerResult) => applied(step(carried, verifiedEvent(carried, { [P2]: value })));
  const present = at("present");
  assert.deepEqual(present.relay.sync, { kind: "synced", mark: { ...MARK2, evidence: "E2" } }); assert.equal(present.relay.packetsInEpoch, 2);
  assert.equal(present.deliveries[0]?.kind === "outcome" && present.deliveries[0].outcome.kind, "recorded");
  const absent = at("absent");
  assert.deepEqual(absent.relay.sync, { kind: "synced", mark: MARK1 });
  assert.equal(absent.deliveries[0]?.kind === "outcome" && absent.deliveries[0].outcome.kind === "unknown" && absent.deliveries[0].outcome.reason, "absent");
  // Not seen: the Turn deleted nothing before its packet, so the prior stands and the packet goes back to pending (2026-11-10).
  for (const value of ["unavailable", "outside_window"] as const) {
    const unseen = at(value);
    assert.deepEqual(unseen.relay.sync, { ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 }, value); assert.equal(unseen.note.verified, "restored");
    assert.equal(unseen.deliveries[0]?.kind === "outcome" && unseen.deliveries[0].outcome.kind === "unknown" && unseen.deliveries[0].outcome.reason, value === "unavailable" ? "verify_unavailable" : "outside_window");
  }
  // Without a packet: the Turn's own entry decides, the mark does not move.
  const plain = applied(step(SYNCED, { kind: "unknown_turn_continued" })).relay;
  assert.deepEqual(plan(plain), { kind: "unknown_turn", marker: null });
  const entry = (value: MarkerResult) => applied(step(plain, { kind: "verified", plan: plan(plain), result: result({}), turnEntry: value, inRunId: null, at: AT }));
  assert.deepEqual(entry("present").relay.sync, { kind: "synced", mark: MARK1 });
  assert.deepEqual(entry("absent").relay.sync, { kind: "synced", mark: MARK1 }, "carried=null and not there: the mark stands (approval, point 4)");
  assert.deepEqual(entry("compacted").relay.reanchor, true);
  // An entry the check cannot see changes nothing either (2026-11-10): the mark stands, undecided, with no choice to make.
  for (const value of ["unavailable", "outside_window"] as const) {
    const unseen = entry(value);
    assert.deepEqual(unseen.relay.sync, { kind: "synced", mark: MARK1 }, value); assert.equal(unseen.note.verified, "undecided"); assert.equal(unseen.note.choice, undefined, value);
  }
  assert.deepEqual(applied(step(plain, { kind: "verified", plan: plan(plain), result: result({}), inRunId: null, at: AT })).relay.sync, { kind: "synced", mark: MARK1 }, "no turnEntry reported is unavailable");
  // Already suspect: the stronger cause stays.
  assert.equal(applied(step(SUSPECT, { kind: "unknown_turn_continued" })).changed, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// After the review: F1, F2, F3, F5, F8, F9, rewound, the unchecked table, Z2 and Z4
// ---------------------------------------------------------------------------------------------------------------------

/** Delivery rows of epoch `epoch` whose recordings kept the cursor {0, null}: a Driver with compaction evidence. */
const UNMOVED = { count: 0, digest: null };
const rowOf = (run: RunId, packetId: RelayPacketId, outcome: DeliveryStatus, range: SourceRange, body: Fingerprint, mark: DeliveredMark | null, epoch = 2): BindingDelivery =>
  ({ record: record(run, packetId, outcome, { compactionAtDelivery: UNMOVED }), nativeEpoch: epoch, range, bodySha256: body, reanchor: false, mark });
const checked = (state: BindingRelayState, rows: readonly BindingDelivery[], markers: Readonly<Record<string, MarkerResult>>, extra: Partial<VerifyResult> = {}) =>
  step(state, { kind: "verified", plan: plan(state, rows), result: result(markers, { compaction: UNMOVED, ...extra }), inRunId: R3, at: AT });

test("G068 F1 an unconfirmed clear checks only the chain its mark stands on and the packet it carries; the floor rises only on an empty history or a chain all gone", () => {
  // The reviewer's scenario: synced on P1, P2 → /undo (f) → the open's check finds both absent → the epoch base → /clear that never
  // ran (e′) → the next open: the chain of the base mark is empty, the history is not → the base comes back, the floor stays.
  const facts = [3, 6, 7, 9].map(seq => ({ runId: runId("run-y" + seq), seq, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }));
  const MARK2 = { throughSeq: 9, chain: chainAfter(MARK1.chain, SHA2), lastPacketId: P2, evidence: "E3" as const, basis: "evidence" as const };
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1, 1), rowOf(R2, P2, "recorded", RANGE2, SHA2, MARK2, 1)];
  let state = relay({ kind: "synced", mark: MARK2 }, { nativeEpoch: 1, epochFloor: -1, packetsInEpoch: 2 });
  state = applied(step(state, { kind: "rewound", cause: "rewind" })).relay;
  state = applied(checked(state, rows, { [P1]: "absent", [P2]: "absent" }, { historyEmpty: false })).relay;
  assert.equal(markOf(state.sync)?.lastPacketId, null, "the epoch base");
  state = applied(step(state, { kind: "clear_unconfirmed", seq: 12 })).relay;
  assert.deepEqual(plan(state, rows), { kind: "clear", chain: [], carried: null, firstFromSeq: 3 });
  const restored = applied(checked(state, rows, { [P1]: "absent", [P2]: "absent" }, { historyEmpty: false }));
  assert.equal(restored.note.verified, "restored"); assert.equal(restored.relay.epochFloor, -1); assert.equal(restored.relay.nativeEpoch, 1);
  assert.deepEqual(owed(restored.relay, "xray", "xray-acp", facts, { originHistory: false }).facts.map(fact => fact.seq), [3, 6, 7, 9], "everything the undo removed is owed again");
  // The user undid P2 in the original program (the Hub never saw it) and then cleared through the Hub without effect: P1 is
  // still there, so the clear did not happen and the mark goes back to P1. Only P2 absent would have read as cleared.
  const both = relay({ kind: "suspect", mark: MARK2, cause: "clear_unconfirmed", floorCandidate: 12, carried: null, rewound: false }, { nativeEpoch: 1, epochFloor: -1 });
  const chain = plan(both, rows);
  assert.equal(chain.kind === "clear" && chain.chain.map(marker => marker.packetId).join(), [P1, P2].join());
  const undone = applied(checked(both, rows, { [P1]: "present", [P2]: "absent" }, { historyEmpty: false }));
  assert.deepEqual(undone.relay.sync, { kind: "synced", mark: MARK1 }); assert.equal(undone.note.verified, "restored");
  assert.equal(applied(checked(both, rows, { [P1]: "absent", [P2]: "absent" }, { historyEmpty: false })).note.verified, "cleared", "the whole chain gone, no compaction: cleared");
  assert.equal(applied(checked(both, rows, { [P1]: "present", [P2]: "present" }, { historyEmpty: true })).note.verified, "cleared", "an empty history decides");
  // A row a retreat left behind is on no chain: P3 was built on P1 after P2 was found missing.
  const MARK3 = { throughSeq: 12, chain: chainAfter(MARK1.chain, SHA3), lastPacketId: P3, evidence: "E3" as const, basis: "evidence" as const };
  const retreated = [...rows, rowOf(R3, P3, "recorded", RANGE3, SHA3, MARK3, 1)];
  const onP3 = relay({ kind: "suspect", mark: MARK3, cause: "clear_unconfirmed", floorCandidate: 14, carried: null, rewound: false }, { nativeEpoch: 1, epochFloor: -1 });
  const chain3 = plan(onP3, retreated);
  assert.equal(chain3.kind === "clear" && chain3.chain.map(marker => marker.packetId).join(), [P1, P3].join(), "P2 is not on P3's chain");
  // Rule 2: the carried packet there and the chain intact → the clear did not happen and the packet arrived; the carried packet
  // there while an older marker is missing unexplained (a late write after the clear) → the two disagree.
  const carrying = applied(step(PENDING, { kind: "clear_unconfirmed", seq: 15 })).relay;
  const withP2 = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "unknown", RANGE2, SHA2, null)];
  const carriedPlan = plan(carrying, withP2);
  assert.equal(carriedPlan.kind === "clear" && carriedPlan.carried?.packetId, P2);
  const arrived = applied(checked(carrying, withP2, { [P1]: "present", [P2]: "present" }, { historyEmpty: false }));
  assert.deepEqual(arrived.relay.sync, { kind: "synced", mark: { ...MARK2, evidence: "E2" } }); assert.equal(arrived.relay.packetsInEpoch, 2); assert.equal(arrived.note.verified, "restored");
  assert.deepEqual(arrived.deliveries, [{ kind: "outcome", runId: R2, from: "unknown", outcome: { kind: "recorded", evidence: "E2", decidedSeq: AT.seq, decidedAt: AT.time, verifiedInRun: R3 } }]);
  assert.equal(applied(checked(carrying, withP2, { [P1]: "absent", [P2]: "present" }, { historyEmpty: false })).note.choice, "verify_required", "a late write after the clear");
  const notThere = applied(checked(carrying, withP2, { [P1]: "present", [P2]: "absent" }, { historyEmpty: false }));
  assert.deepEqual(notThere.relay.sync, { kind: "synced", mark: MARK1 }, "no clear, the packet not there: back to its prior");
  assert.equal(notThere.deliveries[0]?.kind === "outcome" && notThere.deliveries[0].outcome.kind === "unknown" && notThere.deliveries[0].outcome.reason, "absent");
});

test("G068 F2 a rewind or an unknown command with nothing to check is settled at the open: a mark that claims nothing comes back, another waits for the user", () => {
  const skipK = (state: BindingRelayState, verify: "on_next_open" | "none" = "on_next_open") =>
    step(state, { kind: "verified", plan: planReturnVerify(state, { verify, moment: "open", deliveries: [] }), result: result({}), inRunId: null, at: AT });
  // The reviewer's (3): fresh{user_cleared} → /undo; (3b) synced{native} → an unknown command.
  const cleared = applied(step(relay({ kind: "fresh", basis: "user_cleared" }, { packetsInEpoch: 0, epochFloor: 10 }), { kind: "rewound", cause: "rewind" })).relay;
  assert.equal(admitsWithoutChoice(cleared, "on_next_open"), true); assert.equal(admitsWithoutChoice(cleared, "none"), true);
  const back = applied(skipK(cleared));
  assert.deepEqual(back.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(back.note.verified, "restored");
  assert.equal(step(back.relay, { kind: "plain", foreign: true }).kind, "applied", "the next input goes out as typed");
  const native: DeliveredMark = { throughSeq: 8, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "native", basis: "native" };
  const unknownCommand = applied(step(relay({ kind: "synced", mark: native }, { packetsInEpoch: 0 }), { kind: "rewound", cause: "unknown_command" })).relay;
  assert.deepEqual(applied(skipK(unknownCommand)).relay.sync, { kind: "synced", mark: native });
  assert.deepEqual(applied(skipK(unknownCommand, "none")).relay.sync, { kind: "synced", mark: native }, "a Driver that cannot check settles it at the open too");
  for (const mark of [{ ...native, basis: "origin" as const, evidence: "origin" as const, throughSeq: 0 }, BASE_MARK]) assert.deepEqual(applied(skipK(applied(step(relay({ kind: "synced", mark }), { kind: "rewound", cause: "rewind" })).relay)).relay.sync, { kind: "synced", mark });
  // A legacy mark and a packet mark without its row are not restorable: the user decides.
  const legacy: DeliveredMark = { throughSeq: 6, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "legacy", basis: "legacy" };
  const legacyRewound = applied(step(relay({ kind: "synced", mark: legacy }), { kind: "rewound", cause: "rewind" })).relay;
  assert.equal(admitsWithoutChoice(legacyRewound, "none"), false);
  assert.equal(applied(skipK(legacyRewound)).note.choice, "verify_required");
  assert.equal(applied(skipK(SUSPECT)).note.choice, "verify_required", "a packet mark with no row to check");
  assert.equal(admitsWithoutChoice(SUSPECT, "none"), false);
  // A plan skipped for its moment decides nothing; legacy and marker_absent are never settled without the user.
  assert.equal(applied(step(cleared, { kind: "verified", plan: { kind: "skip", reason: "not_now" }, result: result({}), inRunId: null, at: AT })).relay.sync.kind, "suspect");
  for (const cause of ["legacy", "marker_absent"] as const) assert.equal(admitsWithoutChoice(relay({ kind: "suspect", mark: null, cause, floorCandidate: null, carried: null, rewound: false }), "none"), false, cause);
});

test("G068 F3 a pending or carried packet absent after the cursor moved since its delivery is compacted: reanchor, unknown{compacted}", () => {
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "unknown", RANGE2, SHA2, null)];
  const pending = applied(checked(PENDING, rows, { [P2]: "absent" }, { compaction: CURSOR }));
  assert.equal(pending.relay.sync.kind, "pending"); assert.equal(pending.relay.reanchor, true);
  assert.deepEqual(pending.deliveries, [{ kind: "outcome", runId: R2, from: "unknown", outcome: { kind: "unknown", reason: "compacted", decidedSeq: AT.seq, decidedAt: AT.time } }]);
  const d6 = applied(step(PENDING, { kind: "unknown_turn_continued" })).relay;
  // Compacted, the carried packet was delivered and folded: back to pending re-anchored with its automatic resend spent, as a
  // pending packet found compacted stays pending (G068 fix batch R9c; it went back to the prior before, and was sent again).
  const back = applied(checked(d6, rows, { [P2]: "absent" }, { compaction: CURSOR }));
  assert.deepEqual(back.relay.sync, { ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 }); assert.equal(back.relay.reanchor, true);
  assert.equal(back.deliveries[0]?.kind === "outcome" && back.deliveries[0].outcome.kind === "unknown" && back.deliveries[0].outcome.reason, "compacted");
  assert.equal(applied(checked(PENDING, rows, { [P2]: "absent" })).relay.reanchor, false, "the cursor did not move: absent stays absent");
});

test("G068 F5 three markers: the newest present one decides, and a row a retreat left behind is still in a suspect plan", () => {
  const MARK2 = { throughSeq: 9, chain: chainAfter(MARK1.chain, SHA2), lastPacketId: P2, evidence: "E3" as const, basis: "evidence" as const };
  const MARK3 = { throughSeq: 12, chain: chainAfter(MARK2.chain, SHA3), lastPacketId: P3, evidence: "E3" as const, basis: "evidence" as const };
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "recorded", RANGE2, SHA2, MARK2), rowOf(R3, P3, "recorded", RANGE3, SHA3, MARK3)];
  const onP3 = relay({ kind: "suspect", mark: MARK3, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, { packetsInEpoch: 3 });
  assert.deepEqual(applied(checked(onP3, rows, { [P1]: "present", [P2]: "absent", [P3]: "present" })).relay.sync, { kind: "synced", mark: MARK3 }, "P3, the newest, is there");
  assert.deepEqual(applied(checked(onP3, rows, { [P1]: "present", [P2]: "absent", [P3]: "absent" })).relay.sync, { kind: "synced", mark: MARK1 });
  // P3 built on P1 after a retreat past P2: the suspect plan still checks P2 (the epoch's last recorded rows), unlike a clear's chain.
  const MARK3B = { throughSeq: 12, chain: chainAfter(MARK1.chain, SHA3), lastPacketId: P3, evidence: "E3" as const, basis: "evidence" as const };
  const afterRetreat = [rows[0]!, rows[1]!, rowOf(R3, P3, "recorded", RANGE3, SHA3, MARK3B)];
  const suspectPlan = plan(relay({ kind: "suspect", mark: MARK3B, cause: "rewind", floorCandidate: null, carried: null, rewound: false }), afterRetreat);
  assert.equal(suspectPlan.kind === "suspect" && suspectPlan.markers.map(marker => marker.packetId).join(), [P1, P2, P3].join());
});

test("G068 F8 a pending packet stays to be checked through e′ and f (carried); an unconfirmed clear is not replaced by f", () => {
  // The reviewer's (6): suspect{unknown_turn, carried} + f keeps the packet.
  const d6 = applied(step(PENDING, { kind: "unknown_turn_continued" })).relay;
  assert.deepEqual(applied(step(d6, { kind: "rewound", cause: "rewind" })).relay.sync, { kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: CARRIED2, rewound: false });
  // A pending packet under a rewind: found with nothing older missing → g on it; found while an older marker is missing → undecided;
  // not found → the older markers decide.
  const rewound = applied(step(PENDING, { kind: "rewound", cause: "rewind" })).relay;
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "unknown", RANGE2, SHA2, null)];
  const carriedPlan = plan(rewound, rows);
  assert.equal(carriedPlan.kind === "suspect" && carriedPlan.carried?.packetId + ":" + carriedPlan.markers.map(marker => marker.packetId).join(), P2 + ":" + P1);
  assert.deepEqual(applied(checked(rewound, rows, { [P1]: "present", [P2]: "present" })).relay.sync, { kind: "synced", mark: { throughSeq: 9, chain: chainAfter(MARK1.chain, SHA2), lastPacketId: P2, evidence: "E2", basis: "evidence" } });
  assert.equal(applied(checked(rewound, rows, { [P1]: "absent", [P2]: "present" })).note.choice, "verify_required");
  const gone = applied(checked(rewound, rows, { [P1]: "present", [P2]: "absent" }));
  assert.deepEqual(gone.relay.sync, { kind: "synced", mark: MARK1 }); assert.equal(gone.deliveries.length, 1, "the carried packet's row is refined");
  // A packet built on an unconfirmed clear (after the user's retreat) keeps the clear's cause under f and D6; f marks it
  // rewound, D6 keeps what the prior had.
  const onClear = relay({ kind: "pending", prior: { kind: "suspect", mark: BASE_MARK, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false }, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 0, attachOverride: false });
  for (const [event, rewound] of [[{ kind: "rewound", cause: "rewind" }, true], [{ kind: "unknown_turn_continued" }, false]] as const) {
    const next = applied(step(onClear, event)).relay.sync;
    assert.equal(next.kind === "suspect" && next.cause + ":" + next.floorCandidate + ":" + next.carried?.packetId + ":" + next.rewound, "clear_unconfirmed:15:" + P3 + ":" + rewound, event.kind);
  }
  // The contract: only CARRIED_CAUSES carry, and a pending sync's prior never does.
  for (const cause of ["rewind", "unknown_command", "clear_unconfirmed", "unknown_turn"] as const) assert.doesNotThrow(() => relay({ kind: "suspect", mark: MARK1, cause, floorCandidate: null, carried: CARRIED2, rewound: false }), cause);
  for (const cause of ["legacy", "marker_absent"] as const) assert.throws(() => relay({ kind: "suspect", mark: MARK1, cause, floorCandidate: null, carried: CARRIED2, rewound: false }), /carries no packet/u, cause);
  assert.throws(() => relay({ ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), prior: { kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: CARRIED2, rewound: false } }), /carries no packet/u);
});

/** Foreign facts at 3, 6 (P1's range) and 7, 9 (P2's), and what a binding owes of them. */
const FOREIGN = [3, 6, 7, 9].map(seq => ({ runId: runId("run-y" + seq), seq, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }));
const owedSeqs = (state: BindingRelayState, facts = FOREIGN) => owed(state, "xray", "xray-acp", facts, { originHistory: false }).facts.map(fact => fact.seq);
const MARK2_ON1: DeliveredMark = { throughSeq: 9, chain: chainAfter(MARK1.chain, SHA2), lastPacketId: P2, evidence: "E3", basis: "evidence" };

test("G068 rewound: an unchecked rewind and an unconfirmed clear, in either order, keep mark, seq and carried; rule 4 does not apply (2026-11-10)", () => {
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "recorded", RANGE2, SHA2, MARK2_ON1)];
  const synced = relay({ kind: "synced", mark: MARK2_ON1 }, { packetsInEpoch: 2 });
  for (const order of [["rewound", "clear_unconfirmed"], ["clear_unconfirmed", "rewound"]] as const) {
    let state = synced;
    for (const kind of order) state = applied(step(state, kind === "rewound" ? { kind, cause: "rewind" } : { kind, seq: 15 })).relay;
    const label = order.join(" then ");
    assert.deepEqual(state.sync, { kind: "suspect", mark: MARK2_ON1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: true }, label);
    // (a) The /undo removed only P2, the /clear never ran: P1 is there, so the mark goes back to P1 (rule 3) and only P2's facts
    // are owed again; the model still holds 3 and 6, nothing repeats.
    const shallow = applied(checked(state, rows, { [P1]: "present", [P2]: "absent" }, { historyEmpty: false }));
    assert.deepEqual(shallow.relay.sync, { kind: "synced", mark: MARK1 }, label); assert.equal(shallow.note.verified, "restored");
    assert.deepEqual(owedSeqs(shallow.relay), [7, 9], label);
    // (b) The /undo removed both, the /clear never ran; (c) the /clear ran and the Driver cannot tell an empty history: the
    // chain all gone may be either's doing, so the user decides (rule 5), the floor stays.
    for (const historyEmpty of [false, null]) {
      const deep = applied(checked(state, rows, { [P1]: "absent", [P2]: "absent" }, { historyEmpty }));
      assert.equal(deep.relay.sync.kind, "suspect"); assert.equal(deep.note.choice, "verify_required", label + ", historyEmpty " + historyEmpty);
      assert.equal(deep.relay.epochFloor, 1); assert.equal(deep.relay.nativeEpoch, 2);
    }
    // The user chooses the complete packet again: the epoch base, everything above it owed again; the prior keeps rewound.
    const resent = applied(step(state, { ...carryEvent, retreat: { firstFromSeq: 3 } }));
    assert.deepEqual(resent.relay.sync.kind === "pending" && resent.relay.sync.prior, { kind: "suspect", mark: CHOSEN_BASE, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: true }, label);
    assert.deepEqual(owedSeqs(resent.relay), [3, 6, 7, 9], label);
    // (d) An empty history confirms the clear (rule 1).
    assert.equal(applied(checked(state, rows, {}, { historyEmpty: true })).note.verified, "cleared", label);
  }
  // The other rewind-like causes meet a clear the same way; an unknown Turn is no rewind, its carried packet is kept.
  for (const cause of ["marker_absent", "unknown_command"] as const)
    assert.deepEqual(applied(step(relay({ kind: "suspect", mark: MARK2_ON1, cause, floorCandidate: null, carried: null, rewound: false }), { kind: "clear_unconfirmed", seq: 15 })).relay.sync,
      { kind: "suspect", mark: MARK2_ON1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: true }, cause);
  assert.deepEqual(applied(step(relay({ kind: "suspect", mark: MARK1, cause: "unknown_turn", floorCandidate: null, carried: CARRIED2, rewound: false }), { kind: "clear_unconfirmed", seq: 15 })).relay.sync,
    { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: CARRIED2, rewound: false });
  // f on an unconfirmed clear changes only the flag (its carried packet kept); a later clear takes the latest seq, flag kept.
  const carryingClear = relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: CARRIED2, rewound: false });
  assert.deepEqual(applied(step(carryingClear, { kind: "rewound", cause: "unknown_command" })).relay.sync, { ...(carryingClear.sync as Extract<BindingSync, { kind: "suspect" }>), rewound: true });
  const rewoundClear = relay({ kind: "suspect", mark: MARK2_ON1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: true });
  assert.deepEqual(applied(step(rewoundClear, { kind: "clear_unconfirmed", seq: 18 })).relay.sync, { kind: "suspect", mark: MARK2_ON1, cause: "clear_unconfirmed", floorCandidate: 18, carried: null, rewound: true });
  // e′ on a pending packet: rewound when its prior holds an unchecked rewind (its own cause, or a rewound clear kept by a retreat).
  const pendingOn = (prior: Extract<BindingSync, { kind: "suspect" }>) => relay({ kind: "pending", prior, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 0, attachOverride: false });
  for (const [prior, rewound] of [[{ kind: "suspect", mark: CHOSEN_BASE, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, true],
    [{ kind: "suspect", mark: CHOSEN_BASE, cause: "clear_unconfirmed", floorCandidate: 12, carried: null, rewound: true }, true],
    [{ kind: "suspect", mark: CHOSEN_BASE, cause: "clear_unconfirmed", floorCandidate: 12, carried: null, rewound: false }, false],
    [{ kind: "suspect", mark: CHOSEN_BASE, cause: "unknown_turn", floorCandidate: null, carried: null, rewound: false }, false]] as const) {
    const next = applied(step(pendingOn(prior), { kind: "clear_unconfirmed", seq: 18 })).relay.sync;
    assert.deepEqual(next, { kind: "suspect", mark: CHOSEN_BASE, cause: "clear_unconfirmed", floorCandidate: 18, carried: { prior, packetId: P3, range: RANGE3, attachOverride: false }, rewound }, prior.cause + " " + prior.rewound);
  }
  // The contract: only an unconfirmed clear is marked rewound, and the flag is required.
  assert.throws(() => relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null, rewound: true }), /only an unconfirmed clear is marked rewound/u);
  const { rewound: _dropped, ...unflagged } = rewoundClear.sync as Extract<BindingSync, { kind: "suspect" }>;
  assert.throws(() => relay(unflagged as never), /rewound/u);
});

test("G068 rewound (e): a late write after an unchecked rewind and a clear that never ran disagrees with the chain, so the user decides", () => {
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "unknown", RANGE2, SHA2, null)];
  let state = relay({ kind: "synced", mark: MARK1 });
  state = applied(step(state, { kind: "carry", runId: R2, packet: { id: P2, range: RANGE2 }, attachOverride: false, lateDelivery: true, resend: null })).relay;
  state = applied(step(state, { kind: "rewound", cause: "rewind" })).relay;
  state = applied(step(state, { kind: "clear_unconfirmed", seq: 15 })).relay;
  assert.deepEqual(state.sync, { kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: CARRIED2, rewound: true });
  // The /undo removed P1, the /clear never ran, then P2 landed late: the carried packet is there while P1 is gone with the cursor
  // unmoved (rule 2).
  const late = applied(checked(state, rows, { [P1]: "absent", [P2]: "present" }, { historyEmpty: false }));
  assert.equal(late.relay.sync.kind, "suspect"); assert.equal(late.note.choice, "verify_required"); assert.deepEqual(late.deliveries, []);
});

test("G068 the user's ［确认已清空］ is e at floorCandidate; a candidate at or below the floor is refused; a retreat drops the carried packet, its row untouched", () => {
  const unconfirmed = relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: CARRIED2, rewound: true });
  const confirmed = applied(step(unconfirmed, { kind: "cleared", seq: 15 }));
  assert.deepEqual(confirmed.relay, parseBindingRelayState({ ...unconfirmed, ...cleared(unconfirmed) })); assert.deepEqual(confirmed.deliveries, []);
  const low = relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 3, carried: null, rewound: false }, { epochFloor: 3 });
  for (const outcome of [step(low, { kind: "cleared", seq: 3 }), step(low, { kind: "verified", plan: plan(low, []), result: result({}, { historyEmpty: true }), inRunId: null, at: AT })])
    assert.equal(outcome.kind === "refused" && outcome.refusal.code, "invalid", JSON.stringify(outcome));
  // The user's complete packet again from a binding carrying P2: P2 is no longer checked, its row stays unknown, and the complete
  // packet covers its facts (7, 9) again, at the risk of a repeat the user chose.
  const carrying = relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: CARRIED2, rewound: false });
  assert.deepEqual(retreatedPrior(carrying, 3), { kind: "suspect", mark: CHOSEN_BASE, cause: "rewind", floorCandidate: null, carried: null, rewound: false });
  const resent = applied(step(carrying, { ...carryEvent, retreat: { firstFromSeq: 3 } }));
  assert.deepEqual(resent.deliveries, [insertP3()]); assert.deepEqual(owedSeqs(resent.relay), [3, 6, 7, 9]);
});

test("G068 a suspect binding with nothing to check is settled by the table of 2026-11-10, row by row", () => {
  const skipK = (state: BindingRelayState, reason: "no_marker" | "unavailable" | "not_now") => step(state, { kind: "verified", plan: { kind: "skip", reason }, result: result({}), inRunId: null, at: AT });
  const suspectOf = (cause: SuspectCause, mark: DeliveredMark | null, carried: typeof CARRIED2 | null = null, rewound = false) =>
    relay({ kind: "suspect", mark, cause, floorCandidate: cause === "clear_unconfirmed" ? 15 : null, carried, rewound });
  const stays = (state: BindingRelayState, reason: "no_marker" | "unavailable", label: string) => {
    const outcome = applied(skipK(state, reason));
    assert.equal(outcome.changed, false, label); assert.equal(outcome.note.choice, "verify_required", label);
  };
  for (const reason of ["no_marker", "unavailable"] as const) {
    for (const cause of ["rewind", "unknown_command"] as const) {
      const back = applied(skipK(suspectOf(cause, NATIVE), reason));
      assert.deepEqual(back.relay.sync, { kind: "synced", mark: NATIVE }, cause); assert.equal(back.note.verified, "restored");
      stays(suspectOf(cause, MARK1), reason, cause + " on a packet mark");
    }
    for (const cause of ["rewind", "unknown_command", "clear_unconfirmed", "unknown_turn"] as const) for (const rewound of cause === "clear_unconfirmed" ? [false, true] : [false]) {
      const label = cause + (rewound ? " rewound" : "") + " carrying, " + reason;
      const back = applied(skipK(suspectOf(cause, NATIVE, CARRIED_NATIVE, rewound), reason));
      assert.deepEqual(back.relay.sync, { kind: "pending", prior: CARRIED_NATIVE.prior, packetId: P2, range: RANGE2, autoResends: 1, manualResends: 0, attachOverride: false }, label);
      assert.equal(back.note.verified, "restored"); assert.deepEqual(back.deliveries, []); assert.equal(back.relay.epochFloor, 1);
      assert.equal(pendingResend(back.relay.sync, false), "choice", label + ": the next input asks (delivery_unconfirmed)");
      if (cause !== "unknown_turn") { stays(suspectOf(cause, MARK1, CARRIED2, rewound), reason, label + " on a packet prior"); continue; }
      // D6 has no threshold: a content Turn deletes nothing before its packet, so a prior on a packet holds as well.
      assert.deepEqual(applied(skipK(suspectOf(cause, MARK1, CARRIED2), reason)).relay.sync, { ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 }, label + " on a packet prior");
    }
    for (const rewound of [false, true]) {
      const back = applied(skipK(suspectOf("clear_unconfirmed", NATIVE, null, rewound), reason));
      assert.deepEqual(back.relay.sync, { kind: "synced", mark: NATIVE }); assert.equal(back.note.verified, "restored");
      assert.equal(back.relay.epochFloor, 1, "the floor does not rise"); assert.equal(back.relay.nativeEpoch, 2, "nor the epoch");
      stays(suspectOf("clear_unconfirmed", MARK1, null, rewound), reason, "clear on a packet mark");
    }
    for (const mark of [NATIVE, MARK1, null]) {
      const kept = applied(skipK(suspectOf("unknown_turn", mark), reason));
      assert.deepEqual(kept.relay.sync, mark === null ? { kind: "fresh", basis: "user_cleared" } : { kind: "synced", mark }); assert.equal(kept.note.verified, "undecided"); assert.equal(kept.note.choice, undefined);
    }
    for (const cause of ["legacy", "marker_absent"] as const) {
      const same = applied(skipK(suspectOf(cause, MARK1), reason));
      assert.equal(same.changed, false, cause); assert.equal(same.note.choice, undefined, cause);
    }
  }
  assert.equal(applied(skipK(suspectOf("clear_unconfirmed", NATIVE), "not_now")).changed, false, "a plan skipped for its moment decides nothing");
  // The approval's counterexample: the clear really ran, the Hub cannot tell (verify none). Floor 10, Y's facts 12 and 14 never
  // received: the floor stays 10 and the next input still owes 12 and 14 (shown on its handoff card); nothing lost, nothing repeated.
  const afterClear = relay({ kind: "fresh", basis: "user_cleared" }, { epochFloor: 10, packetsInEpoch: 0 });
  const unconfirmed = applied(step(afterClear, { kind: "clear_unconfirmed", seq: 16 })).relay;
  const back = applied(step(unconfirmed, { kind: "verified", plan: planReturnVerify(unconfirmed, { verify: "none", moment: "open", deliveries: [] }), result: result({}), inRunId: null, at: AT }));
  assert.deepEqual(back.relay.sync, { kind: "fresh", basis: "user_cleared" }); assert.equal(back.relay.epochFloor, 10);
  const facts = [12, 14].map(seq => ({ runId: runId("run-y" + seq), seq, executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }));
  assert.deepEqual(owedSeqs(back.relay, facts), [12, 14]);
  // admitsWithoutChoice: admission asks only where no check can change the outcome. Columns: none, on_next_open, after_turn.
  const admits: readonly [BindingRelayState, boolean, boolean, boolean][] = [
    [SYNCED, true, true, true], [PENDING, true, true, true], [FRESH, true, true, true],
    [suspectOf("rewind", NATIVE), true, true, true], [suspectOf("unknown_command", null), true, true, true],
    [suspectOf("rewind", MARK1), false, true, true], [suspectOf("rewind", { ...NATIVE, basis: "legacy", evidence: "legacy" }), false, false, false],
    [suspectOf("clear_unconfirmed", NATIVE, null, true), true, true, true], [suspectOf("clear_unconfirmed", MARK1), false, true, true],
    [suspectOf("unknown_turn", MARK1), true, true, true], [suspectOf("unknown_turn", null), true, true, true],
    [suspectOf("unknown_turn", NATIVE, CARRIED_NATIVE), true, true, true], [suspectOf("unknown_turn", MARK1, CARRIED2), true, true, true],
    [suspectOf("rewind", NATIVE, CARRIED_NATIVE), true, true, true], [suspectOf("rewind", MARK1, CARRIED2), false, true, true],
    [suspectOf("legacy", null), false, false, false], [suspectOf("marker_absent", MARK1), false, false, false]];
  for (const [state, none, open, afterTurn] of admits) {
    const label = JSON.stringify(state.sync);
    assert.equal(admitsWithoutChoice(state, "none"), none, "none " + label); assert.equal(admitsWithoutChoice(state, "on_next_open"), open, "on_next_open " + label);
    assert.equal(admitsWithoutChoice(state, "after_turn"), afterTurn, "after_turn " + label);
    // With none, what admission lets through the open's skip settles.
    if (state.sync.kind === "suspect" && none) assert.notEqual(applied(skipK(state, "unavailable")).relay.sync.kind, "suspect", label);
    if (state.sync.kind === "suspect" && !none) assert.equal(applied(skipK(state, "unavailable")).relay.sync.kind, "suspect", label);
  }
  // The parser refuses a reverted pending whose prior carries a packet.
  assert.throws(() => relay({ kind: "pending", prior: { kind: "suspect", mark: NATIVE, cause: "rewind", floorCandidate: null, carried: CARRIED_NATIVE, rewound: false }, packetId: P2, range: RANGE2, autoResends: 1, manualResends: 0, attachOverride: false }), /carries no packet/u);
});

test("G068 a carried packet the check cannot see goes back to pending when the markers leave the binding at its prior's level, else the user decides (2026-11-10)", () => {
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "unknown", RANGE2, SHA2, null)];
  const back = { ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 as const };
  const refined = (reason: "verify_unavailable" | "outside_window"): DeliveryChange => ({ kind: "outcome", runId: R2, from: "unknown", outcome: { kind: "unknown", reason, decidedSeq: AT.seq, decidedAt: AT.time } });
  // (a) pending P2 → /undo → P2 outside the window, the mark's P1 there: S = synced{P1} = the prior's level → pending on P2 again,
  // with the row refined in the same step. Had the undo removed P2, the resend brings it back; had it not, the resend's dedup line
  // tells the model it may have seen it.
  const rewound = applied(step(PENDING, { kind: "rewound", cause: "rewind" })).relay;
  for (const [value, reason] of [["outside_window", "outside_window"], ["unavailable", "verify_unavailable"]] as const) {
    const unseen = applied(checked(rewound, rows, { [P1]: "present", [P2]: value }));
    assert.deepEqual(unseen.relay.sync, back, value); assert.equal(unseen.note.verified, "restored"); assert.equal(unseen.note.choice, undefined);
    assert.deepEqual(unseen.deliveries, [refined(reason)], value);
    assert.equal(pendingResend(unseen.relay.sync, false), "choice", "the next input asks (delivery_unconfirmed)");
  }
  // (b) P1 gone too: S would be the epoch base, below the prior: a pending P2 would claim the facts between them delivered → ask.
  const below = applied(checked(rewound, rows, { [P1]: "absent", [P2]: "outside_window" }));
  assert.equal(below.relay.sync.kind, "suspect"); assert.equal(below.note.choice, "verify_required"); assert.deepEqual(below.deliveries, [refined("outside_window")]);
  // A carried packet whose row is missing is not seen either; P1 there → back to pending, no row to refine.
  const noRow = applied(checked(rewound, [rows[0]!], { [P1]: "present" }));
  assert.deepEqual(noRow.relay.sync, back); assert.deepEqual(noRow.deliveries, []);
  // (c) an unconfirmed clear carrying P2 that cannot be seen, P1 there: the clear did not happen → pending on P2. An empty history
  // still confirms the clear first (rule 1); the chain all gone and no compaction confirms it too (rule 4), rewound asks (rule 5).
  const clearing = applied(step(PENDING, { kind: "clear_unconfirmed", seq: 15 })).relay;
  const notCleared = applied(checked(clearing, rows, { [P1]: "present", [P2]: "unavailable" }, { historyEmpty: false }));
  assert.deepEqual(notCleared.relay.sync, back); assert.equal(notCleared.note.verified, "restored"); assert.deepEqual(notCleared.deliveries, [refined("verify_unavailable")]);
  assert.equal(applied(checked(clearing, rows, { [P1]: "present", [P2]: "unavailable" }, { historyEmpty: true })).note.verified, "cleared");
  const gone = applied(checked(clearing, rows, { [P1]: "absent", [P2]: "unavailable" }, { historyEmpty: false }));
  assert.equal(gone.note.verified, "cleared"); assert.deepEqual(gone.deliveries, [refined("verify_unavailable")]);
  const rewoundClear = relay({ ...(clearing.sync as Extract<BindingSync, { kind: "suspect" }>), rewound: true });
  assert.equal(applied(checked(rewoundClear, rows, { [P1]: "absent", [P2]: "unavailable" }, { historyEmpty: false })).note.choice, "verify_required");
  // (d) D6: P1 recorded, P2 unknown, the process group ended, P2's position unreadable → pending on P2: the Turn could not have
  // deleted P1. No threshold, so a prior standing on a packet (not restorable) goes back as well.
  const d6 = applied(step(PENDING, { kind: "unknown_turn_continued" })).relay;
  const continued = applied(checked(d6, rows, { [P2]: "unavailable" }));
  assert.deepEqual(continued.relay.sync, back); assert.equal(continued.note.verified, "restored"); assert.deepEqual(continued.deliveries, [refined("verify_unavailable")]);
  // The same level is the same seq on the same chain: two packets attached once after a clear both stand at the floor (10), so
  // going back from P2 to P1 keeps the seq but not the chain, and P3 built on P2 may not come back pending.
  const floored = relay({ kind: "fresh", basis: "user_cleared" }, { epochFloor: 10, packetsInEpoch: 0 });
  let chained = applied(step(floored, { kind: "carry", runId: R1, packet: { id: P1, range: RANGE1 }, attachOverride: true, lateDelivery: false, resend: null })).relay;
  chained = applied(step(chained, { kind: "carry_settled", runId: R1, packetId: P1, bodySha256: SHA1, reanchored: false, row: "in_flight", outcome: { kind: "recorded", evidence: "E3", decidedSeq: 12, decidedAt: 12, verifiedInRun: null } })).relay;
  const atP1 = markOf(chained.sync)!;
  chained = applied(step(chained, { kind: "carry", runId: R2, packet: { id: P2, range: RANGE2 }, attachOverride: true, lateDelivery: false, resend: null })).relay;
  chained = applied(step(chained, { kind: "carry_settled", runId: R2, packetId: P2, bodySha256: SHA2, reanchored: false, row: "in_flight", outcome: { kind: "recorded", evidence: "E3", decidedSeq: 13, decidedAt: 13, verifiedInRun: null } })).relay;
  const atP2 = markOf(chained.sync)!;
  assert.equal(atP1.throughSeq, 10); assert.equal(atP2.throughSeq, 10); assert.notEqual(atP1.chain, atP2.chain);
  chained = applied(step(chained, { kind: "carry", runId: R3, packet: { id: P3, range: { fromSeq: 11, throughSeq: 12, fromRun: 4, throughRun: 5 } }, attachOverride: false, lateDelivery: false, resend: null })).relay;
  chained = applied(step(chained, { kind: "rewound", cause: "rewind" })).relay;
  const chainRows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, atP1), rowOf(R2, P2, "recorded", RANGE2, SHA2, atP2), rowOf(R3, P3, "unknown", RANGE3, SHA3, null)];
  const sameSeq = applied(checked(chained, chainRows, { [P1]: "present", [P2]: "absent", [P3]: "unavailable" }));
  assert.equal(sameSeq.relay.sync.kind, "suspect"); assert.equal(sameSeq.note.choice, "verify_required");
  // An unconfirmed clear whose mark stands on a packet with no row to find (no chain, a mark that is not restorable): no S → ask.
  const noChain = applied(checked(clearing, [rows[1]!], { [P2]: "unavailable" }, { historyEmpty: false }));
  assert.equal(noChain.relay.sync.kind, "suspect"); assert.equal(noChain.note.choice, "verify_required"); assert.deepEqual(noChain.deliveries, [refined("verify_unavailable")]);
  // A carried packet seen absent still leaves the outcome to the markers (no pending), as before.
  assert.deepEqual(applied(checked(rewound, rows, { [P1]: "present", [P2]: "absent" })).relay.sync, { kind: "synced", mark: MARK1 });
});

test("G068 an after_turn Driver checks a suspect binding at the open too, and keeps no process for it; pending and synced are checked only at a settlement", () => {
  const at = (state: BindingRelayState, moment: "open" | "settled") => planReturnVerify(state, { verify: "after_turn", moment, deliveries: [ROW1, ROW2] });
  assert.equal(at(SUSPECT, "open").kind, "suspect");
  const d6 = applied(step(SYNCED, { kind: "unknown_turn_continued" })).relay;
  assert.deepEqual(at(d6, "open"), { kind: "unknown_turn", marker: null }, "D6 outside any Turn is checked at the next open");
  assert.deepEqual(at(PENDING, "open"), { kind: "skip", reason: "not_now" }); assert.deepEqual(at(SYNCED, "open"), { kind: "skip", reason: "not_now" });
  assert.equal(at(PENDING, "settled").kind, "pending"); assert.deepEqual(at(SYNCED, "settled"), { kind: "skip", reason: "decided" });
  assert.equal(mayReuseKept(SUSPECT, "after_turn"), false); assert.equal(mayReuseKept(PENDING, "after_turn"), true); assert.equal(mayReuseKept(SYNCED, "after_turn"), true);
  // The reviewer's dead corner: need = ∅, the open's check settles the unknown Turn, the input goes out as typed.
  const settled = applied(step(d6, { kind: "verified", plan: at(d6, "open"), result: result({}), turnEntry: "unavailable", inRunId: null, at: AT }));
  assert.deepEqual(settled.relay.sync, { kind: "synced", mark: MARK1 });
  assert.equal(step(settled.relay, { kind: "plain", foreign: true }).kind, "applied");
});

test("G068 a carried packet keeps its one-time attach: attached after a clear, carried through e′, f or D6, it goes back to pending still attached", () => {
  const afterClear = relay({ kind: "fresh", basis: "user_cleared" }, { epochFloor: 10, packetsInEpoch: 0 });
  const attached = applied(step(afterClear, { ...carryEvent, attachOverride: true })).relay;
  assert.equal(attached.sync.kind === "pending" && attached.sync.attachOverride, true);
  for (const event of [{ kind: "clear_unconfirmed", seq: 16 }, { kind: "rewound", cause: "rewind" }, { kind: "unknown_turn_continued" }] as const) {
    const carrying = applied(step(attached, event)).relay;
    assert.equal(carrying.sync.kind === "suspect" && carrying.sync.carried?.attachOverride, true, event.kind);
    const back = applied(step(carrying, { kind: "verified", plan: planReturnVerify(carrying, { verify: "none", moment: "open", deliveries: [] }), result: result({}), inRunId: null, at: AT })).relay;
    assert.deepEqual(back.sync, { ...(attached.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 }, event.kind + ": attachOverride true again");
    // "Attach once more" renders need with the floor ignored again, the history before the clear included (VF1-07).
    const resend = applied(step(back, { ...carryEvent, packet: { id: P0, range: RANGE3 }, runId: R0, resend: { by: "user", of: R3 } }));
    assert.equal(resend.relay.sync.kind === "pending" && resend.relay.sync.attachOverride, true, event.kind);
  }
  // The contract: the flag is required in carried.
  const { attachOverride: _dropped, ...withoutFlag } = CARRIED2;
  assert.throws(() => relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: withoutFlag as never, rewound: false }), /attach override/u);
  assert.throws(() => relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: { ...CARRIED2, attachOverride: "yes" } as never, rewound: false }), /attach override/u);
});

// ---------------------------------------------------------------------------------------------------------------------
// The fix batch after the review of db39cbd (R1, R5, R9a, R9c)
// ---------------------------------------------------------------------------------------------------------------------

test("G068 fix R9c a carried packet found compacted goes back to pending re-anchored with its automatic resend spent when the markers leave the binding at its prior's level; below it the markers decide, as for absent", () => {
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "unknown", RANGE2, SHA2, null)];
  const back = { ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 as const };
  // f on PENDING: suspect{rewind, mark P1, carried P2}; P1 still there, P2 folded into a summary.
  const rewound = applied(step(PENDING, { kind: "rewound", cause: "rewind" })).relay;
  const folded = applied(checked(rewound, rows, { [P1]: "present", [P2]: "compacted" }));
  assert.deepEqual(folded.relay.sync, back); assert.equal(folded.relay.reanchor, true); assert.equal(folded.note.verified, "restored");
  assert.equal(folded.deliveries[0]?.kind === "outcome" && folded.deliveries[0].outcome.kind === "unknown" && folded.deliveries[0].outcome.reason, "compacted");
  assert.equal(pendingResend(folded.relay.sync, false), "choice", "no automatic resend beyond the first send and one");
  // P1 gone as well: the markers retreat below the packet's prior, which no longer holds; the markers' outcome stands.
  const below = applied(checked(rewound, rows, { [P1]: "absent", [P2]: "compacted" }));
  assert.equal(below.relay.sync.kind, "synced"); assert.equal(markOf(below.relay.sync)?.lastPacketId, null, "the epoch base");
  // Absent still goes back to the prior: the packet is not there, its facts are owed again.
  assert.deepEqual(applied(checked(rewound, rows, { [P1]: "present", [P2]: "absent" })).relay.sync, { kind: "synced", mark: MARK1 });
  // An unconfirmed clear carrying it: the chain still there (no clear), the packet folded → pending on it, re-anchored.
  const clearing = applied(step(PENDING, { kind: "clear_unconfirmed", seq: 15 })).relay;
  const clearFolded = applied(checked(clearing, rows, { [P1]: "present", [P2]: "compacted" }, { historyEmpty: false }));
  assert.deepEqual(clearFolded.relay.sync, back); assert.equal(clearFolded.relay.reanchor, true); assert.equal(clearFolded.relay.nativeEpoch, PENDING.nativeEpoch, "the clear did not happen");
  // D6 (no level to meet: a content Turn deletes nothing before its packet).
  const d6 = applied(step(PENDING, { kind: "unknown_turn_continued" })).relay;
  assert.deepEqual(applied(checked(d6, rows, { [P2]: "compacted" })).relay.sync, back);
});

test("G068 fix R5 b with the user's complete packet (retreat) on a suspect binding whose retreated prior owes nothing: it stands on that prior, nothing_owed; refused off suspect, and for a mark that does not come back", () => {
  const chosen = applied(step(SUSPECT, { kind: "plain", foreign: true, retreat: { firstFromSeq: 3 } }));
  assert.deepEqual(chosen.relay.sync, { kind: "synced", mark: CHOSEN_BASE }); assert.equal(chosen.note.verified, "nothing_owed"); assert.equal(chosen.changed, true);
  for (const state of [FRESH, SYNCED]) assert.deepEqual(step(state, { kind: "plain", foreign: true, retreat: { firstFromSeq: 3 } }), { kind: "refused", refusal: { code: "invalid", why: "only a suspect binding moves its mark back on the user's choice of the complete packet" } });
  assert.equal(step(PENDING, { kind: "plain", foreign: true, retreat: { firstFromSeq: 3 } }).kind, "refused");
  const legacy = relay({ kind: "suspect", mark: { throughSeq: 1, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "legacy", basis: "legacy" }, cause: "legacy", floorCandidate: null, carried: null, rewound: false });
  assert.deepEqual(step(legacy, { kind: "plain", foreign: true, retreat: { firstFromSeq: 9 } }), { kind: "refused", refusal: { code: "verify_first", cause: "legacy" } }, "the legacy mark stays below the base and is not restorable");
});

test("G068 fix R9a settledWithoutCheck: what a suspect binding certainly becomes at the next open when no check can change it; admission reads a pending packet it lands on like any other", () => {
  const carriedOnFresh = relay({ kind: "suspect", mark: null, cause: "rewind", floorCandidate: null, carried: { prior: { kind: "fresh", basis: "reset" }, packetId: P2, range: RANGE2, attachOverride: false }, rewound: false }, { packetsInEpoch: 0 });
  const landed = settledWithoutCheck(carriedOnFresh, "none");
  assert.ok(landed?.sync.kind === "pending" && landed.sync.autoResends === 1 && landed.sync.packetId === P2, JSON.stringify(landed));
  assert.equal(pendingResend(landed.sync, false), "choice");
  assert.equal(admitsWithoutChoice(carriedOnFresh, "none"), true, "it leaves suspect, so admission does not ask verify_required");
  assert.equal(settledWithoutCheck(carriedOnFresh, "on_next_open"), null, "a check at the open decides");
  assert.deepEqual(settledWithoutCheck(relay({ kind: "suspect", mark: MARK1, cause: "unknown_turn", floorCandidate: null, carried: null, rewound: false }), "on_next_open")?.sync, { kind: "synced", mark: MARK1 }, "an unknown Turn without a packet keeps its mark");
  assert.equal(settledWithoutCheck(SUSPECT, "none"), null, "a packet mark nothing can check: the user's choice");
  for (const state of [FRESH, SYNCED, PENDING]) assert.equal(settledWithoutCheck(state, "none"), null);
});

test("G068 fix R1 heldSince and foreignTo: a clear raises the epoch in place, so a Turn run on the binding after the clear and before its confirmation (the previous epoch, above the floor) is not foreign; one of an archived native session, or below the floor, is", () => {
  const cleared = relay({ kind: "fresh", basis: "user_cleared" }, { nativeEpoch: 3, epochFloor: 12, packetsInEpoch: 0 });
  const fact = (seq: number, epoch: number, harnessId = "xray") => ({ runId: runId("run-f" + seq), seq, executedOn: { harnessId, controlId: harnessId + "-acp", nativeEpoch: epoch } });
  const archived = (epoch: number): NativeSessionBinding => ({ ...bindingOf(relay({ kind: "fresh", basis: "new" }, { nativeEpoch: epoch, packetsInEpoch: 0, epochFloor: -1 }), "archived") });
  assert.equal(heldSince(cleared, [], "xray", "xray-acp"), 1); assert.equal(heldSince(cleared, [archived(1)], "xray", "xray-acp"), 2); assert.equal(heldSince(cleared, [archived(2)], "xray", "xray-acp"), 3);
  assert.equal(heldSince(cleared, [{ ...archived(1), harnessId: "other" }], "xray", "xray-acp"), 1, "another Harness control's bindings do not count");
  assert.equal(foreignTo(fact(14, 2), "xray", "xray-acp", cleared, 1), false, "after the clear, on this native session");
  assert.equal(foreignTo(fact(14, 2), "xray", "xray-acp", cleared, 3), true, "epoch 2 was another native session's");
  assert.equal(foreignTo(fact(14, 2), "xray", "xray-acp", cleared), true, "without heldSince: conservative");
  assert.equal(foreignTo(fact(10, 2), "xray", "xray-acp", cleared, 1), true, "before the clear: what it removed");
  assert.equal(foreignTo(fact(14, 1), "xray", "xray-acp", cleared, 1), true, "two epochs back lies below the floor of the one in between");
  assert.equal(foreignTo(fact(14, 2, "yankee"), "xray", "xray-acp", cleared, 1), true, "another Harness");
  assert.equal(foreignTo(fact(14, 3), "xray", "xray-acp", cleared, 1), false, "its own epoch");
});

test("G068 Z2 a clear's chain starts at the row whose recording made the mark's own chain, not at the newest row of the same packet", () => {
  // P2 recorded on P1 (the mark), then the same packet recorded again on no packet (another chain).
  const again: DeliveredMark = { throughSeq: 9, chain: chainAfter(null, SHA2), lastPacketId: P2, evidence: "E3", basis: "evidence" };
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "recorded", RANGE2, SHA2, MARK2_ON1), rowOf(R3, P2, "recorded", RANGE2, SHA2, again)];
  const state = relay({ kind: "suspect", mark: MARK2_ON1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false }, { packetsInEpoch: 3 });
  const chain = plan(state, rows);
  assert.equal(chain.kind === "clear" && chain.chain.map(marker => marker.runId).join(), [R1, R2].join());
  // P1 still there: the clear did not happen. The newer row's chain alone (P2, all absent) would have confirmed it.
  assert.deepEqual(applied(checked(state, rows, { [P1]: "present", [P2]: "absent" }, { historyEmpty: false })).relay.sync, { kind: "synced", mark: MARK1 });
});

test("G068 Z4 a compact that ran re-anchors a suspect binding whose only packet of the epoch is the one it carries (F4)", () => {
  const carrying = relay({ kind: "suspect", mark: NATIVE, cause: "rewind", floorCandidate: null, carried: CARRIED_NATIVE, rewound: false }, { packetsInEpoch: 0 });
  assert.equal(applied(step(carrying, { kind: "compaction", cursor: null, ran: true })).relay.reanchor, true);
  const bare = relay({ kind: "suspect", mark: NATIVE, cause: "rewind", floorCandidate: null, carried: null, rewound: false }, { packetsInEpoch: 0 });
  assert.equal(applied(step(bare, { kind: "compaction", cursor: null, ran: true })).relay.reanchor, false, "nothing carried, no packet in the epoch");
});

test("G068 F9 a check that only moves the cursor reports a change", () => {
  const skipped = applied(step(SUSPECT, { kind: "verified", plan: { kind: "skip", reason: "not_now" }, result: result({}, { compaction: CURSOR }), inRunId: null, at: AT }));
  assert.equal(skipped.changed, true); assert.deepEqual(skipped.relay.compactionSeen, CURSOR);
  assert.equal(applied(step(FRESH, verifiedEvent(FRESH, {}, { compaction: CURSOR }))).changed, true);
  assert.equal(applied(step(FRESH, verifiedEvent(FRESH, {}))).changed, false);
});

test("G068 F4 a compact that ran re-anchors a binding with a packet in the epoch even without a cursor; a fresh binding without one never", () => {
  const ran = (state: BindingRelayState, cursor: typeof CURSOR | null = null) => applied(step(state, { kind: "compaction", cursor, ran: true }));
  // The reviewer's (2): synced with a packet in the epoch, the command ran, the Driver reports no cursor.
  const synced = ran(SYNCED);
  assert.equal(synced.relay.reanchor, true); assert.equal(synced.changed, true); assert.deepEqual(synced.relay.compactionSeen, SYNCED.compactionSeen, "no cursor reported: the binding's stays");
  assert.equal(ran(PENDING).relay.reanchor, true, "a pending packet may have been folded");
  assert.equal(ran(FRESH).relay.reanchor, false, "fresh with no packet in its epoch");
  assert.equal(applied(step(SYNCED, { kind: "compaction", cursor: SYNCED.compactionSeen, ran: false })).changed, false, "an automatic compaction reported with the same cursor is none");
  assert.deepEqual(commandTurnEvent("compact", "executed", { cleared: false, seq: 30, cursor: null }), { kind: "compaction", cursor: null, ran: true });
});

test("G068 point 2 a resend refused before insertion goes back to waiting for the packet it superseded, its counts kept", () => {
  const resent = applied(step(PENDING, { ...carryEvent, resend: { by: "auto", of: R2 } })).relay;
  const settled = (superseded?: { readonly packetId: RelayPacketId; readonly range: SourceRange }) => step(resent, { kind: "carry_settled", runId: R3, packetId: P3, bodySha256: SHA3, reanchored: false, row: "in_flight",
    outcome: { kind: "not_recorded", reason: "rejected_before_insert", decidedSeq: AT.seq, decidedAt: AT.time }, ...(superseded === undefined ? {} : { superseded }) });
  const back = applied(settled({ packetId: P2, range: RANGE2 }));
  assert.deepEqual(back.relay.sync, { ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 }, "pending on P2 again, the automatic resend spent");
  assert.equal(back.deliveries[0]?.kind === "outcome" && back.deliveries[0].runId + ":" + back.deliveries[0].outcome.kind, R3 + ":not_recorded");
  assert.equal(pendingResend(back.relay.sync, false), "choice", "the next input checks P2, then asks");
  const refused = settled();
  assert.equal(refused.kind === "refused" && refused.refusal.code, "invalid", "a refused resend must name what it superseded");
  // A first packet names nothing and goes back to its prior. One that does name a superseded packet with its counts at 0 is a packet
  // sent again for newer facts (grown, whose counts start again): it goes back to waiting for the packet it named, like any resend.
  const first = applied(step(PENDING, { kind: "carry_settled", runId: R2, packetId: P2, bodySha256: SHA2, reanchored: false, row: "in_flight", outcome: { kind: "not_recorded", reason: "rejected_before_insert", decidedSeq: AT.seq, decidedAt: AT.time } }));
  assert.deepEqual(first.relay.sync, (PENDING.sync as Extract<BindingSync, { kind: "pending" }>).prior, "a first packet refused goes back to the prior");
  const grownBack = applied(step(PENDING, { kind: "carry_settled", runId: R2, packetId: P2, bodySha256: SHA2, reanchored: false, row: "in_flight", outcome: { kind: "not_recorded", reason: "rejected_before_insert", decidedSeq: AT.seq, decidedAt: AT.time }, superseded: { packetId: P1, range: RANGE1 } }));
  assert.ok(grownBack.relay.sync.kind === "pending" && grownBack.relay.sync.packetId === P1 && grownBack.relay.sync.autoResends === 0, "a grown resend refused goes back to the packet it superseded");
  // Then the next open checks P2 itself.
  const rows = [rowOf(R1, P1, "recorded", RANGE1, SHA1, MARK1), rowOf(R2, P2, "unknown", RANGE2, SHA2, null), { ...rowOf(R3, P3, "not_recorded", RANGE3, SHA3, null), record: record(R3, P3, "not_recorded", { resendOf: R2, compactionAtDelivery: UNMOVED }) }];
  const again = plan(back.relay, rows);
  assert.equal(again.kind === "pending" && again.marker.packetId, P2);
});

test("G068 F10 a native reset finds its binding whatever key order the caller built the relay state in", () => {
  const reordered = JSON.parse(JSON.stringify({ sync: SYNCED.sync, nativeEpoch: SYNCED.nativeEpoch, originIncluded: false, reanchor: false, packetsInEpoch: 1, epochFloor: 1, compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved: null, cache: SYNCED.cache })) as BindingRelayState;
  const outcome = step(SYNCED, { kind: "reset", bindings: [{ harnessId: "xray", controlId: "xray-acp", checkpoint: "c", throughRunId: null, status: "ready", relay: reordered }], harnessId: "xray", controlId: "xray-acp" });
  assert.equal(outcome.kind, "replaced");
});

// ---------------------------------------------------------------------------------------------------------------------
// The check plan (§7.3) and the small rules
// ---------------------------------------------------------------------------------------------------------------------

test("G068 planReturnVerify checks at the open for on_next_open, at the settlement for after_turn, and never for none", () => {
  for (const [verify, moment, kind] of [["on_next_open", "open", "pending"], ["on_next_open", "settled", "skip"], ["after_turn", "settled", "pending"], ["after_turn", "open", "skip"], ["none", "open", "skip"]] as const)
    assert.equal(planReturnVerify(PENDING, { verify, moment, deliveries: [ROW1, ROW2] }).kind, kind, verify + " at " + moment);
  assert.deepEqual(planReturnVerify(PENDING, { verify: "none", moment: "open", deliveries: [] }), { kind: "skip", reason: "unavailable" });
  // F12: after_turn checks at a settlement only what is still undecided; a synced binding is decided.
  assert.deepEqual(planReturnVerify(SYNCED, { verify: "after_turn", moment: "settled", deliveries: [ROW1, ROW2] }), { kind: "skip", reason: "decided" });
  assert.equal(planReturnVerify(SUSPECT, { verify: "after_turn", moment: "settled", deliveries: [ROW1, ROW2] }).kind, "suspect");
  assert.deepEqual(plan(FRESH), { kind: "skip", reason: "fresh" });
  assert.equal(plan(SYNCED).kind, "synced"); assert.equal(plan(SUSPECT).kind, "suspect");
  assert.equal(plan(relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false })).kind, "clear");
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
  // A vector computed outside Node (printf '%s%s' "$(printf '' | shasum -a 256)" "$(printf 'packet one' | shasum -a 256)" | shasum -a 256):
  // the prior's chain first, then the packet text's digest (the reverse order gives b0628837…).
  assert.equal(chainAfter(null, fingerprint("2563192958eb20cd51510fc184bc436e218dade28f6e6d38a425348624622a82")), "2dd340ace394e80b686c71244c1eb87012c51996aa78b88b2a3b61fb84dd0614");
  assert.equal(pendingResend(PENDING.sync, false), "auto"); assert.equal(pendingResend(PENDING.sync, true), "choice");
  assert.equal(pendingResend({ ...(PENDING.sync as Extract<BindingSync, { kind: "pending" }>), autoResends: 1 }, false), "choice"); assert.equal(pendingResend(SYNCED.sync, false), null);
  assert.equal(mayReuseKept(PENDING, "on_next_open"), false); assert.equal(mayReuseKept(SUSPECT, "on_next_open"), false);
  assert.equal(mayReuseKept(SYNCED, "on_next_open"), true); assert.equal(mayReuseKept(PENDING, "after_turn"), true);
  assert.equal(mayReuseKept(relay({ kind: "suspect", mark: MARK1, cause: "clear_unconfirmed", floorCandidate: 15, carried: null, rewound: false }), "after_turn"), false);
  assert.equal(mayReuseKept(SUSPECT, "after_turn"), false, "an after_turn Driver checks a suspect binding at the open");
  assert.deepEqual(retreatedPrior(SUSPECT, 3), { kind: "suspect", mark: CHOSEN_BASE, cause: "rewind", floorCandidate: null, carried: null, rewound: false });
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

// ---------------------------------------------------------------------------------------------------------------------
// The permissive defaults (docs/proposals/relay/permissive-defaults.md §2.1)
// ---------------------------------------------------------------------------------------------------------------------

test("permissive §2.1 a packet sent again for newer facts (grown): it must reach past the pending one's through seq; the automatic count starts again, the user's resends are kept, the one-time attach is inherited, and the row names what it supersedes", () => {
  const spent = relay({ kind: "pending", prior: { kind: "synced", mark: MARK1 }, packetId: P2, range: RANGE2, autoResends: 1, manualResends: 2, attachOverride: true });
  const grown = (range: SourceRange, attachOverride = false, lateDelivery = false) => step(spent, { kind: "carry", runId: R3, packet: { id: P3, range }, attachOverride, lateDelivery, resend: { by: "grown", of: R2 } });
  const next = applied(grown(RANGE3));
  assert.deepEqual(next.relay.sync, { kind: "pending", prior: { kind: "synced", mark: MARK1 }, packetId: P3, range: RANGE3, autoResends: 0, manualResends: 2, attachOverride: true }, "count 0, manual kept, attach inherited");
  assert.deepEqual(next.deliveries, [{ kind: "insert", runId: R3, packetId: P3, attachOverride: true, resendOf: R2 }], "the row names the Run it supersedes");
  assert.equal(pendingResend(next.relay.sync, { lateDelivery: false, evidence: true }, "auto", false), "auto", "one automatic resend is available again");
  // A packet that reaches no further has nothing new to send: refused, however it was asked for.
  for (const throughSeq of [RANGE2.throughSeq, RANGE2.throughSeq - 1]) {
    const refused = grown({ ...RANGE3, fromSeq: 7, throughSeq });
    assert.equal(refused.kind === "refused" && refused.refusal.code, "invalid", "through " + throughSeq);
  }
  // lateDelivery is no reason to refuse it (only the automatic kind asks about that); the user's resend count is not touched by it.
  assert.equal(grown(RANGE3, false, true).kind, "applied");
  const auto = step(spent, { kind: "carry", runId: R3, packet: { id: P3, range: RANGE3 }, attachOverride: false, lateDelivery: false, resend: { by: "auto", of: R2 } });
  assert.equal(auto.kind === "refused" && auto.refusal.code, "RELAY_CHOICE_REQUIRED", "the automatic kind is spent");
  // Only a pending binding has a packet to send again.
  const onSynced = step(SYNCED, { kind: "carry", runId: R3, packet: { id: P3, range: RANGE3 }, attachOverride: false, lateDelivery: false, resend: { by: "grown", of: R2 } });
  assert.equal(onSynced.kind === "refused" && onSynced.refusal.code, "invalid");
});

test("permissive §0 the policy's send alone (n with by policy) is the user's: the binding exactly as it was, whichever state it is in, and no row; the policy's complete packet again is event a with retreat", () => {
  for (const state of [FRESH, SYNCED, PENDING, relay({ kind: "suspect", mark: MARK1, cause: "rewind", floorCandidate: null, carried: null, rewound: false })]) {
    for (const by of ["user", "policy", undefined] as const) {
      const outcome = applied(step(state, by === undefined ? { kind: "alone" } : { kind: "alone", by }));
      assert.equal(outcome.changed, false, state.sync.kind + "/" + by); assert.deepEqual(outcome.relay, state); assert.deepEqual(outcome.deliveries, []);
    }
  }
  const doubt = relay({ kind: "suspect", mark: MARK1, cause: "marker_absent", floorCandidate: null, carried: null, rewound: false });
  const again = applied(step(doubt, { ...carryEvent, retreat: { firstFromSeq: 3 } }));
  assert.ok(again.relay.sync.kind === "pending" && again.relay.sync.prior.kind === "suspect" && again.relay.sync.autoResends === 0, "pending on the retreated prior: the count starts at 0");
});
